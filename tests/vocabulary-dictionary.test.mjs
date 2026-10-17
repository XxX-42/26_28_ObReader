import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { build as buildDictionaryIndex } from "../scripts/build-ecdict-index.mjs";

const require = createRequire(import.meta.url);
const {
  DEFAULT_DICTIONARY_ROOT,
  VocabularyDictionary,
  VocabularyDictionaryError,
  normalizeDictionaryKey,
  dictionaryShardIdForTerm,
} = require("../plugin/vocabulary/dictionary.cjs");

class MemoryAdapter {
  constructor(files = new Map()) {
    this.files = files;
    this.readBinaryCount = new Map();
  }
  async exists(file) { return this.files.has(file); }
  async read(file) {
    const value = this.files.get(file);
    if (value === undefined) throw new Error(`missing: ${file}`);
    return Buffer.isBuffer(value) ? value.toString("utf8") : value;
  }
  async readBinary(file) {
    this.readBinaryCount.set(file, (this.readBinaryCount.get(file) || 0) + 1);
    const value = this.files.get(file);
    if (value === undefined) throw new Error(`missing: ${file}`);
    return value;
  }
}

const CSV = [
  "word,phonetic,definition,translation",
  '"on","ɒn","","prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开"',
  '"On","ɒn","","prep. 在...之上"',
  '"mostly","\'mәustli","","adv. 大概, 大部分, 主要\n[经] 大部份"',
  '"with newline","","an English definition","释义第一行\n释义第二行"',
  '"blank-translation","","fallback definition",""',
  '"sparse","","",""',
].join("\r\n") + "\r\n";

async function makeDictionaryFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "obreader-ecdict-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "ecdict.csv.gz");
  const output = path.join(directory, "index-v1");
  await writeFile(input, gzipSync(Buffer.from(CSV, "utf8"), { mtime: 0 }));
  const generated = await buildDictionaryIndex({ input, output });
  const files = new Map();
  const manifestText = await readFile(path.join(output, "manifest.json"), "utf8");
  files.set(`${DEFAULT_DICTIONARY_ROOT}/manifest.json`, manifestText);
  for (const name of await readdir(path.join(output, "shards"))) {
    files.set(`${DEFAULT_DICTIONARY_ROOT}/shards/${name}`,
      await readFile(path.join(output, "shards", name)));
  }
  return { directory, output, generated, files, manifest: JSON.parse(manifestText) };
}

function readErrorCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof VocabularyDictionaryError);
    assert.equal(error.code, code);
    return true;
  });
}

test("dictionary lookup returns ECDICT translation and phonetic independently of personal learning state", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  const adapter = new MemoryAdapter(fixture.files);
  const dictionary = new VocabularyDictionary({ adapter });
  assert.deepEqual(await dictionary.lookup(" ON "), {
    key: "on",
    translation: "prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开",
    phonetic: "ɒn",
    source: "ECDICT",
  });
  assert.deepEqual(await dictionary.lookup("mostly"), {
    key: "mostly",
    translation: "adv. 大概, 大部分, 主要\n[经] 大部份",
    phonetic: "'mәustli",
    source: "ECDICT",
  });
  assert.equal(await dictionary.lookup("not-in-ecdict"), null);
  assert.equal(await dictionary.lookup(""), null);
  assert.equal(fixture.generated.entryCount, 5, "case-insensitive duplicate ECDICT rows collapse to one stable key");
});

test("generator parses quoted multiline CSV fields and uses definition when translation is empty", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  const dictionary = new VocabularyDictionary({ adapter: new MemoryAdapter(fixture.files) });
  assert.deepEqual(await dictionary.lookup("with newline"), {
    key: "with newline",
    translation: "释义第一行\n释义第二行",
    phonetic: "",
    source: "ECDICT",
  });
  assert.equal((await dictionary.lookup("blank-translation")).translation, "fallback definition");
  assert.equal((await dictionary.lookup("sparse")).translation, "");
});

test("missing index, missing shard and damaged shard have distinct stable errors", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  const missingIndex = new MemoryAdapter();
  await readErrorCode(new VocabularyDictionary({ adapter: missingIndex }).lookup("on"), "DICTIONARY_INDEX_MISSING");

  const shardId = dictionaryShardIdForTerm("on");
  const shardPath = `${DEFAULT_DICTIONARY_ROOT}/shards/${shardId}.json.gz`;
  const missingShardFiles = new Map(fixture.files);
  missingShardFiles.delete(shardPath);
  await readErrorCode(new VocabularyDictionary({ adapter: new MemoryAdapter(missingShardFiles) }).lookup("on"),
    "DICTIONARY_SHARD_MISSING");

  const damagedFiles = new Map(fixture.files);
  const damaged = Buffer.from(damagedFiles.get(shardPath));
  damaged[damaged.length - 1] ^= 0xff;
  damagedFiles.set(shardPath, damaged);
  await readErrorCode(new VocabularyDictionary({ adapter: new MemoryAdapter(damagedFiles) }).lookup("on"),
    "DICTIONARY_SHARD_CORRUPT");
});

test("shard cache is LRU bounded and concurrent reads share one decompression/read", async (t) => {
  const fixture = await makeDictionaryFixture(t);
  const adapter = new MemoryAdapter(fixture.files);
  const dictionary = new VocabularyDictionary({ adapter, maxCachedShards: 1 });
  const [onA, onB] = await Promise.all([dictionary.lookup("on"), dictionary.lookup("ON")]);
  assert.deepEqual(onA, onB);
  const onPath = `${DEFAULT_DICTIONARY_ROOT}/shards/${dictionaryShardIdForTerm("on")}.json.gz`;
  const mostlyPath = `${DEFAULT_DICTIONARY_ROOT}/shards/${dictionaryShardIdForTerm("mostly")}.json.gz`;
  assert.equal(adapter.readBinaryCount.get(onPath), 1, "parallel lookups share the pending shard load");
  await dictionary.lookup("mostly");
  await dictionary.lookup("on");
  assert.equal(adapter.readBinaryCount.get(mostlyPath), 1);
  assert.equal(adapter.readBinaryCount.get(onPath), 2, "the least recently used shard is evicted at capacity");
});

test("gzip decoding uses the standard Web DecompressionStream API available to WebViews and Node", async (t) => {
  if (typeof globalThis.DecompressionStream !== "function" || typeof globalThis.Blob !== "function" ||
      typeof globalThis.Response !== "function" || !globalThis.crypto?.subtle) {
    t.skip("Runtime lacks standard gzip/Web Crypto APIs needed by the dictionary module.");
    return;
  }
  const fixture = await makeDictionaryFixture(t);
  const dictionary = new VocabularyDictionary({ adapter: new MemoryAdapter(fixture.files) });
  assert.equal((await dictionary.lookup("on")).translation.includes("在...之上"), true);
});

test("dictionary key and prefix normalization is deterministic and safe for Unicode filenames", () => {
  assert.equal(normalizeDictionaryKey("  On\tLINE  "), "on line");
  assert.equal(dictionaryShardIdForTerm("on"), "u00006f-u00006e");
  assert.match(dictionaryShardIdForTerm("éclair"), /^u[0-9a-f]{6}-u[0-9a-f]{6}$/u);
  assert.equal(createHash("sha256").update("smoke").digest("hex").length, 64);
});
