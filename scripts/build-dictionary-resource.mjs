#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { normalizeDictionaryKey } = require("../plugin/vocabulary/dictionary-resource.cjs");

const KIND = "pdf-reader-dictionary-resource";
const DICTIONARY_ID = "ECDICT";
const NORMALIZATION = "nfc-lower-space-v1";

function* parseCsvRows(csvText) {
  let row = [];
  let field = "";
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    if (quoted) {
      if (char === "\"") {
        if (csvText[index + 1] === "\"") {
          field += "\"";
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
    if (char === "\"" && field.length === 0 && !afterQuote) {
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalGzip(bytes) {
  const compressed = gzipSync(bytes, { level: 9, mtime: 0 });
  // Normalize fields that zlib may otherwise populate from the host runtime.
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  return compressed;
}

async function assertOwnedManifest(manifestPath) {
  let existing;
  try {
    existing = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (existing.kind !== KIND || existing.dictionaryId !== DICTIONARY_ID) {
    throw new Error(`Refusing to replace unrelated output manifest at ${manifestPath}`);
  }
}

async function installContentAddressed(filePath, bytes, digest) {
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    const existing = await readFile(filePath);
    if (sha256(existing) !== digest) {
      throw new Error(`Existing content-addressed resource has the wrong hash: ${filePath}`);
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    try {
      // Linking publishes a complete file atomically and never replaces an
      // existing resource. The temporary name is in the same directory.
      await link(temporaryPath, filePath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(filePath);
      if (sha256(existing) !== digest) {
        throw new Error(`Existing content-addressed resource has the wrong hash: ${filePath}`);
      }
    }
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function atomicReplace(filePath, bytes) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    // A same-directory rename makes manifest.json the final atomic commit.
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function build({ input, output }) {
  if (!input || !output) {
    throw new Error("Usage: node scripts/build-dictionary-resource.mjs --input <ecdict.csv.gz> --output <ECDICT/resource-v2 directory>");
  }

  const inputPath = path.resolve(input);
  const outputRoot = path.resolve(output);
  const inputStat = await stat(inputPath);
  assert.ok(inputStat.isFile(), "ECDICT input must be a file");
  const compressedSource = await readFile(inputPath);
  const manifestPath = path.join(outputRoot, "manifest.json");
  await assertOwnedManifest(manifestPath);
  let csvText;
  try {
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
  const entriesByKey = new Map();
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
    entriesByKey.set(key, betterEntry(entriesByKey.get(key), entry));
  }

  const entries = [...entriesByKey.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const uncompressed = Buffer.from(entries.map((entry) => JSON.stringify({
    key: entry.key,
    translation: entry.translation,
    phonetic: entry.phonetic,
  })).join("\n") + (entries.length ? "\n" : ""), "utf8");
  const compressed = canonicalGzip(uncompressed);
  const resourceSha256 = sha256(compressed);
  const resourceFile = `entries.${resourceSha256}.jsonl.gz`;

  await mkdir(outputRoot, { recursive: true });
  await installContentAddressed(path.join(outputRoot, resourceFile), compressed, resourceSha256);

  const manifest = {
    schemaVersion: 1,
    kind: KIND,
    dictionaryId: DICTIONARY_ID,
    normalization: NORMALIZATION,
    entryCount: entries.length,
    compressedBytes: compressed.length,
    uncompressedBytes: uncompressed.length,
    sha256: resourceSha256,
    resourceFile,
    source: {
      sha256: sha256(compressedSource),
      rows: sourceRows,
    },
  };
  await atomicReplace(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  return {
    output: outputRoot,
    resourceFile,
    entryCount: manifest.entryCount,
    compressedBytes: manifest.compressedBytes,
    uncompressedBytes: manifest.uncompressedBytes,
    sha256: manifest.sha256,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/build-dictionary-resource.mjs --input <ecdict.csv.gz> --output <ECDICT/resource-v2 directory>");
  } else {
    const result = await build(args);
    console.log(JSON.stringify(result));
  }
}

export { build };
