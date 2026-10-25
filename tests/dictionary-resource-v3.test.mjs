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
    if (value === undefined) throw Object.assign(new Error(`missing: ${file}`), { code: "ENOENT" });
    return Buffer.isBuffer(value) ? value.toString("utf8") : value;
  }
  async readBinary(file) {
    this.readBinaryCount.set(file, (this.readBinaryCount.get(file) || 0) + 1);
    const value = this.files.get(file);
    if (value === undefined) throw Object.assign(new Error(`missing: ${file}`), { code: "ENOENT" });
    if (this.beforeReadBinary) await this.beforeReadBinary(file);
    return value;
  }
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function makeV3Files(rows = ROWS, groupSize = 2, source) {
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
    source: source || { format: "resource-v2", sha256: "a".repeat(64), entryCount: rows.length,
      compressedBytes: 500, uncompressedBytes: 1000, source: { sha256: "b".repeat(64), rows: rows.length } },
  };
  validateManifest(manifest);
  files.set(`${ROOT}/manifest.json`, JSON.stringify(manifest));
  return { files, manifest };
}

function makeV2Files(rows = ROWS) {
  rows = [...rows].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  const raw = Buffer.from(`${rows.map(entry => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  const compressed = gzipSync(raw, { level: 9, mtime: 0 });
  const sha256 = digest(compressed);
  const manifest = { schemaVersion: 1, kind: "pdf-reader-dictionary-resource", dictionaryId: "ECDICT",
    normalization: "nfc-lower-space-v1", entryCount: rows.length, compressedBytes: compressed.length,
    uncompressedBytes: raw.length, sha256, resourceFile: `entries.${sha256}.jsonl.gz`,
    source: { sha256: "c".repeat(64), rows: rows.length } };
  return { manifest, compressed, files: new Map([[`${LEGACY_ROOT}/manifest.json`, JSON.stringify(manifest)],
    [`${LEGACY_ROOT}/${manifest.resourceFile}`, compressed]]) };
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

test("startup availability and no-term warmup never import either resource format", async (t) => {
  for (const legacy of [false, true]) {
    const fixture = legacy ? makeV2Files() : makeV3Files();
    const adapter = new MemoryAdapter(fixture.files);
    const dictionary = dictionaryFor(t, adapter, { root: legacy ? LEGACY_ROOT : ROOT });
    let imports = 0;
    dictionary.cache.prepare = async () => { imports++; throw new Error("full import was not authorized"); };
    if (legacy) {
      await assert.rejects(dictionary.checkAvailability(), error => error.code === "DICTIONARY_CACHE_NOT_READY");
      await assert.rejects(dictionary.warmup(), error => error.code === "DICTIONARY_CACHE_NOT_READY");
    } else {
      assert.equal((await dictionary.checkAvailability()).status, "resource-available");
      assert.equal((await dictionary.warmup()).status, "resource-available");
    }
    assert.equal(imports, 0);
    assert.equal(adapter.readBinaryCount.size, 0);
  }
});

test("v3 availability starts the block Worker in the background without waiting for it", async (t) => {
  const fixture = makeV3Files();
  let worker;
  class DeferredWorker {
    constructor() { worker = this; this.onmessage = null; }
    postMessage() {}
    terminate() {}
  }
  const adapter = new MemoryAdapter(fixture.files);
  const dictionary = dictionaryFor(t, adapter, { workerSource: "worker", WorkerClass: DeferredWorker });
  const pending = dictionary.checkAvailability();
  let settled = false;
  pending.then(() => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.ok(worker, "availability should kick off Worker creation");
    assert.equal(settled, true, "availability must not wait for the Worker ready handshake");
    assert.equal(adapter.readBinaryCount.size, 0, "Worker prewarm must not read dictionary blocks");
  } finally {
    worker?.onmessage?.({ data: { type: "started" } });
  }
  assert.equal((await pending).status, "resource-available");
  await dictionary.blockWorkerReady;
});

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

test("ensureReady reports a verified v3 resource without requiring a full cache build", async (t) => {
  const fixture = makeV3Files();
  const adapter = new MemoryAdapter(fixture.files);
  const statuses = [];
  const dictionary = dictionaryFor(t, adapter, { onStatus: status => statuses.push(status) });

  const result = await dictionary.ensureReady();

  assert.deepEqual(result, { status: "resource-available", count: ROWS.length, warmed: false, result: null });
  assert.deepEqual(dictionary.getStatus(), {
    phase: "resource-available", count: 0, total: 0,
    code: "DICTIONARY_RESOURCE_AVAILABLE", entryCount: ROWS.length,
  });
  assert.deepEqual(statuses.map(status => status.phase), ["resource-available"]);
  assert.equal(adapter.readBinaryCount.size, 0, "availability checks only read the small manifest");
});

test("valid not-found stays ready, block failures are unavailable, and recovery restores ready", async (t) => {
  const fixture = makeV3Files();
  const adapter = new MemoryAdapter(fixture.files);
  const statuses = [];
  const dictionary = dictionaryFor(t, adapter, { onStatus: status => statuses.push(status) });

  assert.equal(await dictionary.lookup("aardvark"), null);
  assert.equal(dictionary.getStatus().phase, "ready", "a valid range miss is not a resource failure");
  assert.equal(dictionary.getStatus().code, "DICTIONARY_RESOURCE_V3_READY");

  const firstBlock = fixture.manifest.blocks[0];
  const blockPath = `${ROOT}/${firstBlock.resourceFile}`;
  const originalBlock = adapter.files.get(blockPath);
  adapter.files.delete(blockPath);
  await assert.rejects(dictionary.lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_MISSING");
  assert.equal(dictionary.getStatus().phase, "unavailable");
  assert.equal(dictionary.getStatus().code, "DICTIONARY_RESOURCE_MISSING");

  adapter.files.set(blockPath, originalBlock);
  assert.deepEqual(await dictionary.lookup("alpha"), expected(ROWS[0]));
  assert.equal(dictionary.getStatus().phase, "ready");
  assert.equal(dictionary.getStatus().code, "DICTIONARY_RESOURCE_V3_READY");
  assert.ok(statuses.some(status => status.phase === "unavailable" && status.code === "DICTIONARY_RESOURCE_MISSING"));
  assert.deepEqual(statuses.slice(-2).map(status => status.phase), ["resource-available", "ready"]);

  dictionary.invalidate();
  assert.equal(dictionary.getStatus().phase, "idle", "resource changes clear stale status as well as cached blocks");
});

test("a verified same-source v2 cache serves a v3 block while that block is syncing", async (t) => {
  const v2 = makeV2Files();
  const source = { format: "resource-v2", sha256: v2.manifest.sha256,
    entryCount: v2.manifest.entryCount, compressedBytes: v2.manifest.compressedBytes,
    uncompressedBytes: v2.manifest.uncompressedBytes, source: v2.manifest.source };
  const v3 = makeV3Files(ROWS, 2, source);
  const files = new Map([...v2.files, ...v3.files]);
  const missingBlock = v3.manifest.blocks[0];
  files.delete(`${ROOT}/${missingBlock.resourceFile}`);
  const adapter = new MemoryAdapter(files);
  const cache = makeCache();
  await cache.prepare(v2.manifest, async () => v2.compressed);
  const statuses = [];
  const dictionary = dictionaryFor(t, adapter, { cache, onStatus: status => statuses.push(status) });

  assert.deepEqual(await dictionary.lookup("alpha"), expected(ROWS[0]));
  assert.equal(dictionary.getStatus().phase, "degraded");
  assert.equal(dictionary.getStatus().code, "DICTIONARY_RESOURCE_V2_FALLBACK");
  assert.equal(dictionary.getStatus().resourceStatusCode, "DICTIONARY_RESOURCE_MISSING");
  assert.equal(adapter.readBinaryCount.get(`${LEGACY_ROOT}/${v2.manifest.resourceFile}`) || 0, 0,
    "fallback reads only the already-verified Dexie generation, never rebuilds it");
  assert.ok(statuses.some(status => status.phase === "degraded"));

  files.set(`${ROOT}/${missingBlock.resourceFile}`, v3.files.get(`${ROOT}/${missingBlock.resourceFile}`));
  assert.deepEqual(await dictionary.lookup("beta"), expected(ROWS[1]));
  assert.equal(dictionary.getStatus().phase, "ready", "a successful v3 block read restores the healthy status");
  assert.equal(dictionary.getStatus().code, "DICTIONARY_RESOURCE_V3_READY");
});

test("a mismatched or unready v2 cache never hides a missing v3 block as not-found", async (t) => {
  const v2 = makeV2Files();
  const mismatchedV3 = makeV3Files(ROWS, 2, { format: "resource-v2", sha256: "d".repeat(64),
    entryCount: v2.manifest.entryCount, compressedBytes: v2.manifest.compressedBytes,
    uncompressedBytes: v2.manifest.uncompressedBytes, source: v2.manifest.source });
  const files = new Map([...v2.files, ...mismatchedV3.files]);
  const block = mismatchedV3.manifest.blocks[0];
  files.delete(`${ROOT}/${block.resourceFile}`);
  const adapter = new MemoryAdapter(files);
  const cache = makeCache();
  await cache.prepare(v2.manifest, async () => v2.compressed);
  const dictionary = dictionaryFor(t, adapter, { cache });

  await assert.rejects(dictionary.lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_MISSING");
  assert.equal(dictionary.getStatus().phase, "unavailable");
  assert.equal(dictionary.getStatus().code, "DICTIONARY_RESOURCE_MISSING");
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

test("clearCache drops v3 LRU blocks and rebuildCache reports availability without a full import", async (t) => {
  const fixture = makeV3Files();
  const adapter = new MemoryAdapter(fixture.files);
  const dictionary = dictionaryFor(t, adapter, { blockCacheMaxBlocks: 2, blockCacheMaxBytes: 2048 });
  assert.deepEqual(await dictionary.lookup("alpha"), expected(ROWS[0]));
  const alphaBlock = fixture.manifest.blocks.find(block => block.firstKey <= "alpha" && "alpha" <= block.lastKey);
  const resourcePath = `${ROOT}/${alphaBlock.resourceFile}`;
  assert.equal(adapter.readBinaryCount.get(resourcePath), 1);
  assert.equal(dictionary.getBlockCacheStats().blocks, 1);

  dictionary.clearCache();
  assert.deepEqual(dictionary.getBlockCacheStats(), { blocks: 0, estimatedBytes: 0, maxBlocks: 2, maxBytes: 2048 });
  assert.deepEqual(await dictionary.lookup("alpha"), expected(ROWS[0]));
  assert.equal(adapter.readBinaryCount.get(resourcePath), 2, "a cleared LRU block is read on the next lookup");

  const available = await dictionary.rebuildCache();
  assert.deepEqual(available, { status: "resource-available", count: ROWS.length, warmed: false, result: null });
  assert.equal(dictionary.getStatus().phase, "resource-available");
  assert.equal(dictionary.getBlockCacheStats().blocks, 0);
  assert.equal(adapter.readBinaryCount.get(resourcePath), 2, "v3 rebuild does not read the full resource or any block");

  const warmed = await dictionary.rebuildCache({ warmTerm: "beta" });
  assert.deepEqual(warmed, { status: "resource-available", count: ROWS.length, warmed: true, result: expected(ROWS[1]) });
  assert.equal(dictionary.getBlockCacheStats().blocks, 1);
  assert.equal(adapter.readBinaryCount.get(resourcePath), 3, "optional warmTerm lazily reads only its matching block");
  assert.equal(await dictionary.cache.active("ECDICT"), null, "resource-v3 warmup never builds a v2 Dexie generation");
});

test("resource invalidation clears stale block generations before the next lookup", async (t) => {
  const oldFixture = makeV3Files([{ key: "alpha", translation: "old", phonetic: "" }], 1);
  const adapter = new MemoryAdapter(oldFixture.files);
  const dictionary = dictionaryFor(t, adapter);
  assert.deepEqual(await dictionary.lookup("alpha"), { key: "alpha", translation: "old", phonetic: "", source: "ECDICT" });
  assert.equal(dictionary.getBlockCacheStats().blocks, 1);

  const newFixture = makeV3Files([{ key: "alpha", translation: "updated", phonetic: "" }], 1);
  adapter.files = newFixture.files;
  dictionary.invalidate();
  assert.deepEqual(dictionary.getBlockCacheStats(), { blocks: 0, estimatedBytes: 0, maxBlocks: 16, maxBytes: 8 * 1024 * 1024 });
  assert.deepEqual(await dictionary.lookup("alpha"), { key: "alpha", translation: "updated", phonetic: "", source: "ECDICT" });
  assert.equal(dictionary.getBlockCacheStats().blocks, 1);
});

test("missing, partial, and corrupt blocks remain distinct from a dictionary miss", async (t) => {
  const fixture = makeV3Files();
  const block = fixture.manifest.blocks[0];

  const missing = new Map(fixture.files);
  missing.delete(`${ROOT}/${block.resourceFile}`);
  const missingStatuses = [];
  const missingDictionary = dictionaryFor(t, new MemoryAdapter(missing), { onStatus: status => missingStatuses.push(status) });
  await assert.rejects(missingDictionary.lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_MISSING");
  assert.equal(missingDictionary.getStatus().phase, "unavailable");
  assert.equal(missingDictionary.getStatus().code, "DICTIONARY_RESOURCE_MISSING");

  const partial = new Map(fixture.files);
  partial.set(`${ROOT}/${block.resourceFile}`, Buffer.from(fixture.files.get(`${ROOT}/${block.resourceFile}`).subarray(0, -2)));
  const partialDictionary = dictionaryFor(t, new MemoryAdapter(partial));
  await assert.rejects(partialDictionary.lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_CORRUPT");
  assert.equal(partialDictionary.getStatus().phase, "unavailable");
  assert.equal(partialDictionary.getStatus().code, "DICTIONARY_RESOURCE_CORRUPT");

  const corrupt = new Map(fixture.files);
  const damaged = Buffer.from(corrupt.get(`${ROOT}/${block.resourceFile}`));
  damaged[damaged.length - 1] ^= 0xff;
  corrupt.set(`${ROOT}/${block.resourceFile}`, damaged);
  const corruptDictionary = dictionaryFor(t, new MemoryAdapter(corrupt));
  await assert.rejects(corruptDictionary.lookup("alpha"), error => error.code === "DICTIONARY_RESOURCE_CORRUPT");
  assert.equal(corruptDictionary.getStatus().phase, "unavailable");
  assert.equal(corruptDictionary.getStatus().code, "DICTIONARY_RESOURCE_CORRUPT");
  assert.equal(missingStatuses.at(-1).phase, "unavailable");
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


test("unknown active cache is rejected when both manifests are missing", async (t) => {
  const legacy = makeV2Files();
  const cache = makeCache();
  await cache.prepare(legacy.manifest, async () => legacy.files.get(`${LEGACY_ROOT}/${legacy.manifest.resourceFile}`));
  const dictionary = dictionaryFor(t, new MemoryAdapter(), { cache });
  await assert.rejects(dictionary.lookup("alpha"), error => error.code === "DICTIONARY_INDEX_MISSING");
  assert.equal(dictionary.getStatus().phase, "unavailable");
});

test("a different active v2 generation cannot satisfy the synchronized v2 manifest", async (t) => {
  const legacy = makeV2Files();
  const other = makeV2Files([{ key: "alpha", translation: "OTHER RESOURCE", phonetic: "" }]);
  const cache = makeCache();
  await cache.prepare(other.manifest, async () => other.files.get(`${LEGACY_ROOT}/${other.manifest.resourceFile}`));
  const dictionary = dictionaryFor(t, new MemoryAdapter(legacy.files), { cache });
  await assert.rejects(dictionary.lookup("alpha"), error => error.code === "DICTIONARY_CACHE_NOT_READY");
});

test("a stale rejected manifest read retries without publishing unavailable", async (t) => {
  const fixture = makeV3Files();
  const adapter = new MemoryAdapter(fixture.files);
  const read = adapter.read.bind(adapter);
  let rejectOld, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  adapter.read = file => {
    if (first) {
      first = false;
      entered();
      return new Promise((resolve, reject) => { rejectOld = reject; });
    }
    return read(file);
  };
  const statuses = [];
  const dictionary = dictionaryFor(t, adapter, { legacyRoot: ROOT, onStatus: status => statuses.push(status) });
  const pending = dictionary.lookup("alpha");
  await started;
  dictionary.invalidate();
  await dictionary.lookup("alpha");
  rejectOld(new Error("old missing manifest"));
  assert.equal((await pending).translation, ROWS[0].translation);
  assert.equal(dictionary.getStatus().phase, "ready");
  assert.equal(statuses.some(status => status.phase === "unavailable"), false);
});


test("invalidation fences an awaited ready v2 cache lookup", async (t) => {
  const legacy = makeV2Files();
  const cache = makeCache();
  await cache.prepare(legacy.manifest, async () => legacy.files.get(`${LEGACY_ROOT}/${legacy.manifest.resourceFile}`));
  const adapter = new MemoryAdapter(legacy.files);
  const lookup = cache.lookup.bind(cache);
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  cache.lookup = async (...args) => {
    const result = await lookup(...args);
    if (first) {
      first = false;
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return result;
  };
  const dictionary = dictionaryFor(t, adapter, { cache });
  const pending = dictionary.lookup("alpha");
  await started;
  adapter.files = makeV3Files([{ key: "alpha", translation: "new", phonetic: "" }]).files;
  dictionary.invalidate();
  release();
  assert.equal((await pending).translation, "new");
  assert.equal(dictionary.getStatus().code, "DICTIONARY_RESOURCE_V3_READY");
});

for (const failure of [
  () => Object.assign(new Error("permission denied"), { code: "EACCES" }),
  () => Object.assign(new Error("I/O failure"), { code: "EIO" }),
  () => new Error("adapter unavailable"),
  () => new DOMException("permission denied", "NotAllowedError"),
]) {
  for (const stage of ["manifest", "block"]) {
    test(`${stage} ${failure().code || failure().name}: read failures never invoke legacy fallback`, async t => {
      const v2 = makeV2Files();
      const v3 = makeV3Files(ROWS, 2, { format: "resource-v2", sha256: v2.manifest.sha256,
        entryCount: v2.manifest.entryCount, compressedBytes: v2.manifest.compressedBytes,
        uncompressedBytes: v2.manifest.uncompressedBytes, source: v2.manifest.source });
      const adapter = new MemoryAdapter(new Map([...v2.files, ...v3.files]));
      const cache = makeCache();
      await cache.prepare(v2.manifest, async () => v2.compressed);
      const originalRead = adapter.read.bind(adapter);
      const originalBinary = adapter.readBinary.bind(adapter);
      const cause = failure();
      let legacyReads = 0;
      adapter.read = async path => {
        if (path.startsWith(LEGACY_ROOT)) legacyReads++;
        if (stage === "manifest" && path === `${ROOT}/manifest.json`) throw cause;
        return originalRead(path);
      };
      adapter.readBinary = async path => {
        if (stage === "block" && path.startsWith(`${ROOT}/blocks/`)) throw cause;
        return originalBinary(path);
      };
      const dictionary = dictionaryFor(t, adapter, { cache });
      const code = stage === "manifest" ? "DICTIONARY_INDEX_READ_FAILED" : "DICTIONARY_RESOURCE_READ_FAILED";
      await assert.rejects(dictionary.lookup("alpha"), error => error.code === code && error.cause === cause);
      assert.equal(legacyReads, 0);
      assert.equal(dictionary.getStatus().code, code);
      if (stage === "manifest") {
        await assert.rejects(dictionary.checkAvailability(), error => error.code === code);
        assert.equal(legacyReads, 0);
      }
      // Transient failures are retryable without losing the available resource.
      adapter.read = originalRead;
      adapter.readBinary = originalBinary;
      assert.deepEqual(await dictionary.lookup("alpha"), expected(ROWS[0]));
    });
  }
}

test("DOM NotFoundError preserves missing-manifest compatibility fallback", async t => {
  const v2 = makeV2Files();
  const adapter = new MemoryAdapter(v2.files);
  const read = adapter.read.bind(adapter);
  adapter.read = path => path === `${ROOT}/manifest.json`
    ? Promise.reject(new DOMException("not found", "NotFoundError")) : read(path);
  const cache = makeCache();
  await cache.prepare(v2.manifest, async () => v2.compressed);
  const dictionary = dictionaryFor(t, adapter, { cache });
  assert.deepEqual(await dictionary.lookup("alpha"), expected(ROWS[0]));
});

test("an unavailable block Worker falls back to verified cooperative decoding", async t => {
  const fixture = makeV3Files();
  for (const failure of ["startup", "message"]) {
    class UnavailableWorker {
      constructor() {
        queueMicrotask(() => {
          if (failure === "startup") this.onerror?.({ message: "fixture CSP failure" });
          else this.onmessage?.({ data: { type: "started" } });
        });
      }
      postMessage() { throw new Error("fixture transfer failure"); }
      terminate() {}
    }
    const dictionary = dictionaryFor(t, new MemoryAdapter(fixture.files), {
      workerSource: "worker", WorkerClass: UnavailableWorker,
    });
    assert.deepEqual(await dictionary.lookup("beta"), expected(ROWS[1]), failure);
  }
});

test("unload fences an in-flight block read without publishing ready", async t => {
  const fixture = makeV3Files();
  const adapter = new MemoryAdapter(fixture.files);
  let unblock, entered;
  const reading = new Promise(resolve => { entered = resolve; });
  adapter.beforeReadBinary = async () => { entered(); await new Promise(resolve => { unblock = resolve; }); };
  const dictionary = dictionaryFor(t, adapter);
  const pending = dictionary.lookup("beta");
  await reading;
  dictionary.dispose();
  unblock();
  await assert.rejects(pending, error => error.code === "DICTIONARY_CACHE_CANCELLED");
  assert.notEqual(dictionary.getStatus().phase, "ready");
  assert.equal(dictionary.getBlockCacheStats().blocks, 0);
});
