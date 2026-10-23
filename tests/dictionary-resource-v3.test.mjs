import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

const require = createRequire(import.meta.url);
const { DictionaryQueryCache } = require("../plugin/vocabulary/dictionary-cache.cjs");
const { VocabularyDictionary } = require("../plugin/vocabulary/dictionary.cjs");
const { manifestIndexPayload, validateManifest, decodeBlockResource } = require("../plugin/vocabulary/dictionary-resource.cjs");
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const ROOT = "fixture/dictionaries/ECDICT/resource-v3";
const LEGACY_ROOT = "fixture/dictionaries/ECDICT/resource-v2";
const ROWS = [
  { key: "alpha", translation: "第一释义", phonetic: "æ" },
  { key: "beta", translation: "第二释义", phonetic: "ˈbeɪtə" },
  { key: "café", translation: "法语释义", phonetic: "" },
  { key: "delta", translation: "第四释义", phonetic: "d" },
  { key: "omega", translation: "最后一条", phonetic: "oʊ" },
  { key: "éclair", translation: "泡芙", phonetic: "e" },
];

class MemoryAdapter {
  constructor(files = new Map()) { this.files = files; this.readBinaryCount = new Map(); this.beforeReadBinary = null; }
  async read(file) {
    const value = this.files.get(file);
    if (value === undefined) throw new Error(`missing: ${file}`);
    return Buffer.isBuffer(value) ? value.toString("utf8") : value;
  }
  async readBinary(file) {
    this.readBinaryCount.set(file, (this.readBinaryCount.get(file) || 0) + 1);
    const value = this.files.get(file);
    if (value === undefined) throw new Error(`missing: ${file}`);
    if (this.beforeReadBinary) await this.beforeReadBinary(file);
    return value;
  }
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function makeV3Files(rows = ROWS, groupSize = 2) {
  rows = [...rows].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const blocks = [];
  const files = new Map();
  for (let offset = 0; offset < rows.length; offset += groupSize) {
    const entries = rows.slice(offset, offset + groupSize);
    const raw = Buffer.from(`${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    const compressed = gzipSync(raw, { level: 9, mtime: 0 });
    const sha256 = digest(compressed);
    const resourceFile = `blocks/block.${sha256}.jsonl.gz`;
    const block = { firstKey: entries[0].key, lastKey: entries.at(-1).key, entryCount: entries.length,
      compressedBytes: compressed.length, uncompressedBytes: raw.length, sha256, resourceFile };
    blocks.push(block);
    files.set(`${ROOT}/${resourceFile}`, compressed);
  }
  const manifest = {
    schemaVersion: 3,
    kind: "pdf-reader-dictionary-resource",
    dictionaryId: "ECDICT",
    normalization: "nfc-lower-space-v1",
    entryCount: rows.length,
    compressedBytes: blocks.reduce((sum, block) => sum + block.compressedBytes, 0),
    uncompressedBytes: blocks.reduce((sum, block) => sum + block.uncompressedBytes, 0),
    sha256: digest(Buffer.from(manifestIndexPayload(blocks), "utf8")),
    blockCount: blocks.length,
    targetBlockBytes: 262144,
    blocks,
    source: { format: "resource-v2", sha256: "a".repeat(64), entryCount: rows.length,
      compressedBytes: 500, uncompressedBytes: 1000, source: { sha256: "b".repeat(64), rows: rows.length } },
  };
  validateManifest(manifest);
  files.set(`${ROOT}/manifest.json`, JSON.stringify(manifest));
  return { files, manifest };
}

function makeCache() {
  return new DictionaryQueryCache({ name: `vocabulary-dictionary-v3-${randomUUID()}`, indexedDB, IDBKeyRange });
}

function dictionaryFor(t, adapter, options = {}) {
  const dictionary = new VocabularyDictionary({ adapter, root: ROOT, ...options, cache: options.cache || makeCache() });
  t.after(() => dictionary.dispose());
  return dictionary;
}

function expected(row) { return { ...row, source: "ECDICT" }; }

test("v3 lookup agrees with every row and resolves range boundaries and Unicode keys", async (t) => {
  const fixture = makeV3Files();
  const adapter = new MemoryAdapter(fixture.files);
  const dictionary = dictionaryFor(t, adapter);
  for (const row of ROWS) assert.deepEqual(await dictionary.lookup(row.key), expected(row));
  assert.deepEqual(await dictionary.lookup("  BETA\t"), expected(ROWS[1]));
  assert.deepEqual(await dictionary.lookup("E\u0301CLAIR"), expected(ROWS.find(row => row.key === "éclair")));
  assert.equal(await dictionary.lookup("alpha-beta"), null, "a gap inside a block range is a real miss");
  assert.equal(await dictionary.lookup("aardvark"), null, "a term before the first range is a real miss");
  assert.equal(await dictionary.lookup("zulu"), null, "a term after the final range is a real miss");
});

test("one cold block read is coalesced across concurrent lookups and warm hits stay in the bounded LRU", async (t) => {
  const fixture = makeV3Files();
  const adapter = new MemoryAdapter(fixture.files);
  let release;
  adapter.beforeReadBinary = () => new Promise(resolve => { release = resolve; });
  const dictionary = dictionaryFor(t, adapter, { blockCacheMaxBlocks: 2, blockCacheMaxBytes: 2048 });
  const alpha = dictionary.lookup("alpha");
  const beta = dictionary.lookup("beta");
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  release();
  assert.deepEqual(await alpha, expected(ROWS[0]));
  assert.deepEqual(await beta, expected(ROWS[1]));
  const first = fixture.manifest.blocks[0];
  assert.equal(adapter.readBinaryCount.get(`${ROOT}/${first.resourceFile}`), 1);
  adapter.beforeReadBinary = null;

  await dictionary.lookup("café");
  await dictionary.lookup("alpha"); // refresh the first range's LRU position
  await dictionary.lookup("éclair"); // evicts the middle range
  assert.ok(dictionary.getBlockCacheStats().blocks <= 2);
  assert.ok(dictionary.getBlockCacheStats().estimatedBytes <= 2048);
  const middle = fixture.manifest.blocks[1];
  const beforeReload = adapter.readBinaryCount.get(`${ROOT}/${middle.resourceFile}`);
  await dictionary.lookup("delta");
  assert.equal(adapter.readBinaryCount.get(`${ROOT}/${middle.resourceFile}`), beforeReload + 1,
    "an evicted block is fetched and decoded again");
});

test("missing, partial, and corrupt blocks remain distinct from a dictionary miss", async (t) => {
  const fixture = makeV3Files();
  const block = fixture.manifest.blocks[0];

  const missing = new Map(fixture.files);
  missing.delete(`${ROOT}/${block.resourceFile}`);
  await assert.rejects(dictionaryFor(t, new MemoryAdapter(missing)).lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_MISSING");

  const partial = new Map(fixture.files);
  partial.set(`${ROOT}/${block.resourceFile}`, Buffer.from(fixture.files.get(`${ROOT}/${block.resourceFile}`).subarray(0, -2)));
  await assert.rejects(dictionaryFor(t, new MemoryAdapter(partial)).lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_CORRUPT");

  const corrupt = new Map(fixture.files);
  const damaged = Buffer.from(corrupt.get(`${ROOT}/${block.resourceFile}`));
  damaged[damaged.length - 1] ^= 0xff;
  corrupt.set(`${ROOT}/${block.resourceFile}`, damaged);
  await assert.rejects(dictionaryFor(t, new MemoryAdapter(corrupt)).lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_CORRUPT");
});

test("v3 manifest index is checked and a missing v3 resource does not trigger v2 full import", async (t) => {
  const fixture = makeV3Files();
  const damagedIndex = new Map(fixture.files);
  const manifest = JSON.parse(damagedIndex.get(`${ROOT}/manifest.json`));
  manifest.blocks[0].lastKey = "z-corrupt-index";
  damagedIndex.set(`${ROOT}/manifest.json`, JSON.stringify(manifest));
  await assert.rejects(dictionaryFor(t, new MemoryAdapter(damagedIndex)).lookup("alpha"),
    error => error.code === "DICTIONARY_MANIFEST_CORRUPT");

  const files = new Map();
  files.set(`${LEGACY_ROOT}/manifest.json`, JSON.stringify({ schemaVersion: 1,
    kind: "pdf-reader-dictionary-resource", dictionaryId: "ECDICT", normalization: "nfc-lower-space-v1",
    entryCount: 1, compressedBytes: 1, uncompressedBytes: 1, sha256: "c".repeat(64),
    resourceFile: `entries.${"c".repeat(64)}.jsonl.gz` }));
  const adapter = new MemoryAdapter(files);
  const dictionary = dictionaryFor(t, adapter);
  await assert.rejects(dictionary.lookup("on"), error => error.code === "DICTIONARY_CACHE_NOT_READY");
  assert.equal([...adapter.readBinaryCount.values()].reduce((sum, count) => sum + count, 0), 0,
    "legacy v2 resource bytes are not read by a cold lookup");
});

test("a ready v2 cache remains a compatibility fallback when v3 has not synchronized", async (t) => {
  const raw = Buffer.from('{"key":"legacy","translation":"旧释义","phonetic":""}\n');
  const compressed = gzipSync(raw, { mtime: 0 });
  const hash = digest(compressed);
  const manifest = { schemaVersion: 1, kind: "pdf-reader-dictionary-resource", dictionaryId: "ECDICT",
    normalization: "nfc-lower-space-v1", entryCount: 1, compressedBytes: compressed.length,
    uncompressedBytes: raw.length, sha256: hash, resourceFile: `entries.${hash}.jsonl.gz` };
  const files = new Map([[`${LEGACY_ROOT}/manifest.json`, JSON.stringify(manifest)],
    [`${LEGACY_ROOT}/${manifest.resourceFile}`, compressed]]);
  const adapter = new MemoryAdapter(files);
  const cache = makeCache();
  const prepared = await cache.prepare(manifest, async () => compressed);
  assert.equal(prepared.count, 1);
  files.delete(`${LEGACY_ROOT}/manifest.json`); // the ready local generation still survives a missing Vault manifest
  const dictionary = dictionaryFor(t, adapter, { cache });
  assert.deepEqual(await dictionary.lookup("legacy"), { key: "legacy", translation: "旧释义", phonetic: "", source: "ECDICT" });
});

test("invalidation prevents a stale block generation from escaping an in-flight lookup", async (t) => {
  const oldFixture = makeV3Files([{ key: "alpha", translation: "old", phonetic: "" }], 1);
  const adapter = new MemoryAdapter(oldFixture.files);
  let release;
  adapter.beforeReadBinary = () => new Promise(resolve => { release = resolve; });
  const dictionary = dictionaryFor(t, adapter);
  const pending = dictionary.lookup("alpha");
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const newFixture = makeV3Files([{ key: "alpha", translation: "new", phonetic: "" }], 1);
  adapter.files = newFixture.files;
  dictionary.invalidate();
  adapter.beforeReadBinary = null;
  release();
  assert.deepEqual(await pending, { key: "alpha", translation: "new", phonetic: "", source: "ECDICT" });
});

test("the block Worker receives a transferable binary buffer and returns verified rows", async (t) => {
  const fixture = makeV3Files();
  let transferred = false;
  class FakeWorker {
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "started" } })); }
    postMessage(data, transfer) {
      if (data.type !== "decode-block") return;
      transferred = data.bytes instanceof ArrayBuffer && transfer[0] === data.bytes;
      void decodeBlockResource(data.block, data.bytes).then(decoded => {
        this.onmessage?.({ data: { type: "block-ready", id: data.id, decoded } });
      });
    }
    terminate() {}
  }
  const dictionary = dictionaryFor(t, new MemoryAdapter(fixture.files), { workerSource: "worker", WorkerClass: FakeWorker });
  assert.deepEqual(await dictionary.lookup("beta"), expected(ROWS[1]));
  assert.equal(transferred, true);
});
