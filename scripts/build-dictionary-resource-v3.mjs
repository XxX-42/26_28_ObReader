#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeDictionaryKey, validateManifest, manifestIndexPayload } =
  require("../plugin/vocabulary/dictionary-resource.cjs");

const KIND = "pdf-reader-dictionary-resource";
const DICTIONARY_ID = "ECDICT";
const NORMALIZATION = "nfc-lower-space-v1";
const TARGET_BLOCK_BYTES = 256 * 1024;
const MIN_COMPRESSED_BYTES = 128 * 1024;
const MAX_COMPRESSED_BYTES = 512 * 1024;
const DEFAULT_RAW_TARGET_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--input", "--output", "--raw-target-bytes"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--raw-target-bytes") {
        const size = Number(value);
        if (!Number.isSafeInteger(size) || size < 1) throw new Error("--raw-target-bytes must be a positive integer.");
        result.rawTargetBytes = size;
      } else result[arg.slice(2)] = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function canonicalGzip(bytes) {
  const compressed = gzipSync(bytes, { level: 9, mtime: 0 });
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  return compressed;
}

async function assertOwnedManifest(manifestPath) {
  let existing;
  try { existing = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (existing.kind !== KIND || existing.dictionaryId !== DICTIONARY_ID || existing.schemaVersion !== 3) {
    throw new Error(`Refusing to replace unrelated output manifest at ${manifestPath}`);
  }
}

async function installContentAddressed(filePath, bytes, digest) {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const existing = await readFile(filePath);
    if (sha256(existing) !== digest) throw new Error(`Existing content-addressed block has the wrong hash: ${filePath}`);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    try { await link(temporaryPath, filePath); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(filePath);
      if (sha256(existing) !== digest) throw new Error(`Existing content-addressed block has the wrong hash: ${filePath}`);
    }
  } finally {
    await unlink(temporaryPath).catch(error => { if (error?.code !== "ENOENT") throw error; });
  }
}

async function atomicReplace(filePath, bytes) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(error => { if (error?.code !== "ENOENT") throw error; });
  }
}

async function readVerifiedV2(inputRoot) {
  const manifestPath = path.join(path.resolve(inputRoot), "manifest.json");
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  assert.equal(manifest.schemaVersion, 1, "The v3 converter accepts a verified resource-v2 manifest.");
  const compressed = await readFile(path.join(path.resolve(inputRoot), manifest.resourceFile));
  assert.equal(compressed.length, manifest.compressedBytes, "resource-v2 compressed byte count matches its manifest");
  assert.equal(sha256(compressed), manifest.sha256, "resource-v2 SHA-256 matches its manifest");
  const uncompressed = gunzipSync(compressed);
  assert.equal(uncompressed.length, manifest.uncompressedBytes, "resource-v2 decompressed byte count matches its manifest");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(uncompressed); }
  catch (error) { throw new Error("resource-v2 is not valid UTF-8.", { cause: error }); }
  assert.deepEqual(Buffer.from(text, "utf8"), uncompressed, "resource-v2 round-trips as canonical UTF-8");
  assert.ok(text.endsWith("\n"), "resource-v2 uses canonical newline terminated JSONL");
  const lines = text.slice(0, -1).split("\n");
  assert.equal(lines.length, manifest.entryCount, "resource-v2 row count matches its manifest");
  const entries = [];
  let lastKey = "";
  for (const [index, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); }
    catch (error) { throw new Error(`Invalid resource-v2 JSONL at row ${index + 1}.`, { cause: error }); }
    assert.ok(entry && typeof entry.key === "string" && entry.key && entry.key > lastKey,
      `resource-v2 keys are unique and sorted at row ${index + 1}`);
    assert.equal(normalizeDictionaryKey(entry.key), entry.key, `resource-v2 key is normalized at row ${index + 1}`);
    assert.equal(typeof entry.translation, "string", `resource-v2 translation is text at row ${index + 1}`);
    assert.equal(typeof entry.phonetic, "string", `resource-v2 phonetic is text at row ${index + 1}`);
    assert.deepEqual(Object.keys(entry).sort(), ["key", "phonetic", "translation"],
      `resource-v2 row ${index + 1} has only canonical fields`);
    assert.equal(JSON.stringify(entry), line, `resource-v2 row ${index + 1} uses canonical JSON`);
    entries.push(entry);
    lastKey = entry.key;
  }
  return { manifest, entries };
}

function encodeEntries(entries) {
  return Buffer.from(`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function compressedBlock(entries) {
  const uncompressed = encodeEntries(entries);
  const compressed = canonicalGzip(uncompressed);
  return { entries, uncompressed, compressed, digest: sha256(compressed) };
}

function splitOversized(block, result) {
  if (block.compressed.length <= MAX_COMPRESSED_BYTES || block.entries.length < 2) {
    result.push(block);
    return;
  }
  const midpoint = Math.floor(block.entries.length / 2);
  splitOversized(compressedBlock(block.entries.slice(0, midpoint)), result);
  splitOversized(compressedBlock(block.entries.slice(midpoint)), result);
}

function initialGroups(entries, rawTargetBytes) {
  const groups = [];
  let current = [], bytes = 0;
  for (const entry of entries) {
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (current.length && bytes + size > rawTargetBytes) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

function mergeSmallRanges(blocks) {
  const result = [];
  let index = 0;
  while (index < blocks.length) {
    let block = blocks[index];
    while (block.compressed.length < MIN_COMPRESSED_BYTES && index + 1 < blocks.length) {
      const next = blocks[index + 1];
      const merged = compressedBlock([...block.entries, ...next.entries]);
      if (merged.compressed.length > MAX_COMPRESSED_BYTES) break;
      block = merged;
      index += 1;
    }
    result.push(block);
    index += 1;
  }
  return result;
}

async function build({ input, output, rawTargetBytes = DEFAULT_RAW_TARGET_BYTES }) {
  if (!input || !output) throw new Error("Usage: node scripts/build-dictionary-resource-v3.mjs --input <resource-v2 directory> --output <resource-v3 directory>");
  const source = await readVerifiedV2(input);
  const outputRoot = path.resolve(output);
  const manifestPath = path.join(outputRoot, "manifest.json");
  await assertOwnedManifest(manifestPath);

  const blocks = [];
  for (const entries of initialGroups(source.entries, rawTargetBytes)) {
    splitOversized(compressedBlock(entries), blocks);
  }
  const merged = mergeSmallRanges(blocks);
  await mkdir(path.join(outputRoot, "blocks"), { recursive: true });
  const descriptors = [];
  for (const block of merged) {
    const resourceFile = `blocks/block.${block.digest}.jsonl.gz`;
    await installContentAddressed(path.join(outputRoot, resourceFile), block.compressed, block.digest);
    descriptors.push({
      firstKey: block.entries[0].key,
      lastKey: block.entries.at(-1).key,
      entryCount: block.entries.length,
      compressedBytes: block.compressed.length,
      uncompressedBytes: block.uncompressed.length,
      sha256: block.digest,
      resourceFile,
    });
  }
  const manifest = {
    schemaVersion: 3,
    kind: KIND,
    dictionaryId: DICTIONARY_ID,
    normalization: NORMALIZATION,
    entryCount: source.entries.length,
    compressedBytes: descriptors.reduce((sum, block) => sum + block.compressedBytes, 0),
    uncompressedBytes: descriptors.reduce((sum, block) => sum + block.uncompressedBytes, 0),
    sha256: sha256(Buffer.from(manifestIndexPayload(descriptors), "utf8")),
    blockCount: descriptors.length,
    targetBlockBytes: TARGET_BLOCK_BYTES,
    blocks: descriptors,
    source: {
      format: "resource-v2",
      sha256: source.manifest.sha256,
      entryCount: source.manifest.entryCount,
      compressedBytes: source.manifest.compressedBytes,
      uncompressedBytes: source.manifest.uncompressedBytes,
      source: source.manifest.source,
    },
  };
  validateManifest(manifest);
  await atomicReplace(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log("Usage: node scripts/build-dictionary-resource-v3.mjs --input <resource-v2 directory> --output <resource-v3 directory> [--raw-target-bytes <size>]");
    } else {
      const manifest = await build(args);
      const sizes = manifest.blocks.map(block => block.compressedBytes).sort((a, b) => a - b);
      console.log(JSON.stringify({ output: path.resolve(args.output), entryCount: manifest.entryCount,
        blockCount: manifest.blockCount, compressedBytes: manifest.compressedBytes,
        minBlockBytes: sizes[0], medianBlockBytes: sizes[Math.floor(sizes.length / 2)],
        maxBlockBytes: sizes.at(-1), sha256: manifest.sha256 }, null, 2));
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

export { build, readVerifiedV2, initialGroups, mergeSmallRanges, MIN_COMPRESSED_BYTES, MAX_COMPRESSED_BYTES, TARGET_BLOCK_BYTES };
