#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeDictionaryKey, dictionaryShardIdForTerm } = require("../plugin/vocabulary/dictionary.cjs");
const KIND = "pdf-reader-ecdict-index";
const SHARD_KIND = "pdf-reader-ecdict-shard";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input" || arg === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path.`);
      result[arg.slice(2)] = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function* parseCsvRows(csvText) {
  let row = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    if (quoted) {
      if (char === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (afterQuote && char !== "," && char !== "\n" && char !== "\r" && char !== " " && char !== "\t") {
      throw new Error(`Invalid CSV character after a closing quote near byte offset ${index}.`);
    }
    if (char === '"' && field.length === 0 && !afterQuote) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      afterQuote = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && csvText[index + 1] === "\n") index += 1;
      row.push(field);
      yield row;
      row = [];
      field = "";
      afterQuote = false;
    } else if (afterQuote && (char === " " || char === "\t")) {
      // RFC-compatible whitespace between a quoted field and its delimiter.
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("ECDICT CSV ended inside a quoted field.");
  if (field.length || row.length) {
    row.push(field);
    yield row;
  }
}

function score(entry) {
  const hanCount = (entry.translation.match(/[\p{Script=Han}]/gu) || []).length;
  return (entry.translation ? 100 : 0) + Math.min(hanCount, 100) * 2 +
    Math.min(entry.translation.length, 500) / 100 + (entry.phonetic ? 1 : 0);
}

function betterEntry(current, candidate) {
  if (!current) return candidate;
  const left = score(current);
  const right = score(candidate);
  if (right !== left) return right > left ? candidate : current;
  const leftTie = `${current.translation}\u0000${current.phonetic}`;
  const rightTie = `${candidate.translation}\u0000${candidate.phonetic}`;
  return rightTie < leftTie ? candidate : current;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function atomicWrite(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(tempPath, bytes);
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    // Windows does not replace an existing destination with rename(). The
    // caller has already constrained output to this generated index directory.
    if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
    await rm(filePath, { force: true });
    await rename(tempPath, filePath);
  }
}

async function build({ input, output }) {
  if (!input || !output) throw new Error("Usage: node scripts/build-ecdict-index.mjs --input <ECDICT.csv.gz> --output <index-v1 directory>");
  const inputStat = await stat(input);
  assert.ok(inputStat.isFile(), "ECDICT input must be a file");
  const compressedSource = await readFile(input);
  let csvText;
  try {
    const { gunzipSync } = await import("node:zlib");
    csvText = gunzipSync(compressedSource).toString("utf8");
  } catch (error) {
    throw new Error(`Could not decompress ECDICT CSV gzip: ${error.message}`, { cause: error });
  }

  const rows = parseCsvRows(csvText);
  const header = rows.next();
  if (header.done) throw new Error("ECDICT CSV is empty.");
  const columns = new Map(header.value.map((name, index) => [name.replace(/^\uFEFF/u, "").trim(), index]));
  for (const required of ["word", "translation", "phonetic"]) {
    if (!columns.has(required)) throw new Error(`ECDICT CSV is missing required column: ${required}`);
  }
  const shards = new Map();
  let sourceRows = 0;
  for (const fields of rows) {
    sourceRows += 1;
    const rawWord = fields[columns.get("word")] || "";
    const key = normalizeDictionaryKey(rawWord);
    if (!key) continue;
    const translationRaw = fields[columns.get("translation")] || "";
    const definitionRaw = fields[columns.get("definition")] || "";
    const translation = (translationRaw || definitionRaw).replace(/\r\n?/gu, "\n").trim();
    const phonetic = (fields[columns.get("phonetic")] || "").trim();
    const entry = { key, translation, phonetic };
    const shardId = dictionaryShardIdForTerm(key);
    let shard = shards.get(shardId);
    if (!shard) shards.set(shardId, shard = new Map());
    shard.set(key, betterEntry(shard.get(key), entry));
  }

  const outputRoot = path.resolve(output);
  const existingManifestPath = path.join(outputRoot, "manifest.json");
  try {
    const existing = JSON.parse(await readFile(existingManifestPath, "utf8"));
    if (existing.kind !== KIND) throw new Error(`Refusing to replace unrelated output manifest at ${existingManifestPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const shardDirectory = path.join(outputRoot, "shards");
  await mkdir(shardDirectory, { recursive: true });
  const manifestShards = {};
  let entryCount = 0;
  for (const shardId of [...shards.keys()].sort()) {
    const map = shards.get(shardId);
    const entries = [...map.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const payload = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      kind: SHARD_KIND,
      shardId,
      entries,
    }));
    const compressed = gzipSync(payload, { level: 9, mtime: 0 });
    compressed.writeUInt32LE(0, 4);
    compressed[9] = 255;
    const file = `shards/${shardId}.json.gz`;
    await atomicWrite(path.join(outputRoot, file), compressed);
    manifestShards[shardId] = { file, entryCount: entries.length, sha256: sha256(compressed) };
    entryCount += entries.length;
  }

  for (const name of await readdir(shardDirectory)) {
    if (/^u[0-9a-f]{6}(?:-u[0-9a-f]{6})?\.json\.gz$/u.test(name) &&
        !Object.values(manifestShards).some((descriptor) => descriptor.file === `shards/${name}`)) {
      await rm(path.join(shardDirectory, name), { force: true });
    }
  }
  const manifest = {
    schemaVersion: 1,
    kind: KIND,
    language: "en-zh",
    source: {
      name: "ECDICT",
      file: path.basename(input),
      compressedSha256: sha256(compressedSource),
    },
    keyNormalization: "NFC + trim + whitespace-collapse + lowercase",
    shardScheme: "first-two-codepoints-hex",
    sourceRows,
    entryCount,
    shardCount: Object.keys(manifestShards).length,
    shards: manifestShards,
  };
  await atomicWrite(existingManifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { output: outputRoot, sourceRows, entryCount, shardCount: manifest.shardCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/build-ecdict-index.mjs --input <ECDICT.csv.gz> --output <index-v1 directory>");
  } else {
    const result = await build(args);
    console.log(JSON.stringify(result));
  }
}

export { build, parseCsvRows };
