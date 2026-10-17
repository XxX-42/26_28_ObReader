import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  canonicalHash,
  canonicalStringify,
} = require("../plugin/vocabulary/canonical.cjs");
const {
  MAX_SHARD_BYTES,
  MAX_SHARD_RECORDS,
  createManifest,
  createShardedStore,
  manifestPathFor,
  partitionRecords,
  prepareShardedReplacement,
  readShardedStore,
  shardPathFor,
  validateManifestAndShards,
} = require("../plugin/vocabulary/sharded-store.cjs");

const ROOT = "00_Archive/21_VocabularyData/contexts";
const STORE_ID = "vocabulary-contexts-v1";
const kind = "context";
const idOf = (record) => record.id;
const absent = { exists: false, text: null, value: null, revision: 0, hash: null };

function snapshot(value) {
  const text = canonicalStringify(value);
  return { exists: true, text, value: JSON.parse(text), revision: value.revision, hash: canonicalHash(value) };
}

function put(files, path, value) {
  files.set(path, snapshot(value));
}

class ShardDirectoryAdapter {
  constructor() {
    this.files = new Map();
    this.directories = new Set([""]);
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path) || [...this.files.keys()].some((item) => item.startsWith(`${path}/`));
  }

  async mkdir(path) {
    this.directories.add(path);
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (parent && !this.directories.has(parent)) {
      this.directories.add(parent);
      parent = parent.slice(0, parent.lastIndexOf("/"));
    }
  }

  async list(path) {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/")).sort(),
      folders: [...this.directories].filter((item) => item.startsWith(prefix) && item !== path && !item.slice(prefix.length).includes("/")).sort(),
    };
  }

  putSnapshot(path, value) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    this.directories.add(parent);
    let ancestor = parent.slice(0, parent.lastIndexOf("/"));
    while (ancestor && !this.directories.has(ancestor)) {
      this.directories.add(ancestor);
      ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"));
    }
    this.files.set(path, typeof value === "string" ? {
      exists: true, text: value, value: null, revision: 1, hash: "sha256-v1:" + "0".repeat(64),
    } : snapshot(value));
  }
}

function makeStore(adapter = new ShardDirectoryAdapter()) {
  const transaction = {
    adapter,
    async readSnapshot(path) { return adapter.files.get(path) || absent; },
  };
  return {
    adapter,
    transaction,
    store: createShardedStore({ transaction, storeId: STORE_ID, root: ROOT, kind, idOf }),
  };
}

test("adaptive SHA-256 prefix partitioning is deterministic, sorted, and respects the global shard caps", () => {
  const records = Array.from({ length: 48 }, (_, index) => ({
    id: `context-${String(index).padStart(3, "0")}`,
    sentence: `sentence ${index}`,
  }));
  const first = partitionRecords({
    records,
    storeId: STORE_ID,
    root: ROOT,
    kind,
    idOf,
    maxRecords: 3,
    maxBytes: 2048,
  });
  const reversed = partitionRecords({
    records: records.slice().reverse(),
    storeId: STORE_ID,
    root: ROOT,
    kind,
    idOf,
    maxRecords: 3,
    maxBytes: 2048,
  });

  assert.deepEqual(first.map(({ prefix, text }) => ({ prefix, text })),
    reversed.map(({ prefix, text }) => ({ prefix, text })));
  assert.ok(first.length > 1, "a small test cap should force adaptive splitting");
  assert.ok(first.every((shard) => shard.recordCount <= 3));
  assert.ok(first.every((shard) => shard.recordCount <= MAX_SHARD_RECORDS));
  assert.ok(first.every((shard) => shard.byteLength <= 2048 && shard.byteLength <= MAX_SHARD_BYTES));
  assert.deepEqual(first.map((shard) => shard.prefix), first.map((shard) => shard.prefix).slice().sort());
  assert.ok(first.every((shard) => shard.path === shardPathFor(ROOT, shard.prefix)));
});

test("a single oversized record fails closed instead of being truncated or split", () => {
  assert.throws(() => partitionRecords({
    records: [{ id: "large-context", sentence: "x".repeat(4096) }],
    storeId: STORE_ID,
    root: ROOT,
    kind,
    idOf,
    maxBytes: 512,
  }), { code: "VOCAB_SHARD_RECORD_TOO_LARGE" });
});

test("manifest validation checks every reference, complete shard contents, and exact loaded-set membership", () => {
  const records = [
    { id: "context-a", sentence: "first" },
    { id: "context-b", sentence: "second" },
  ];
  const shards = partitionRecords({ records, storeId: STORE_ID, root: ROOT, kind, idOf, maxRecords: 1 });
  const manifest = createManifest({ storeId: STORE_ID, kind, revision: 1, shards });
  const manifestSnapshot = snapshot(manifest);
  const shardSnapshots = new Map(shards.map((part) => [part.prefix, snapshot(part.value)]));

  const loaded = validateManifestAndShards({ manifestSnapshot, shardSnapshots, storeId: STORE_ID, root: ROOT, kind, idOf });
  assert.deepEqual(loaded.records.map((record) => record.id), ["context-a", "context-b"]);
  assert.throws(() => validateManifestAndShards({
    manifestSnapshot,
    shardSnapshots: new Map(),
    storeId: STORE_ID,
    root: ROOT,
    kind,
    idOf,
  }), { code: "VOCAB_SHARD_MISSING" });

  const withExtra = new Map(shardSnapshots);
  withExtra.set("f", snapshot({ schemaVersion: 1, kind: "vocabulary-shard", storeId: STORE_ID,
    storeKind: kind, prefix: "f", revision: 1, records: { unrelated: { id: "unrelated" } } }));
  assert.throws(() => validateManifestAndShards({
    manifestSnapshot,
    shardSnapshots: withExtra,
    storeId: STORE_ID,
    root: ROOT,
    kind,
    idOf,
  }), { code: "VOCAB_SHARD_UNREFERENCED" });

  const corrupted = { ...manifest, shards: manifest.shards.map((entry, index) =>
    index === 0 ? { ...entry, hash: "sha256-v1:" + "0".repeat(64) } : entry) };
  assert.throws(() => validateManifestAndShards({
    manifestSnapshot: snapshot(corrupted),
    shardSnapshots,
    storeId: STORE_ID,
    root: ROOT,
    kind,
    idOf,
  }), { code: "VOCAB_SHARD_REFERENCE_MISMATCH" });
});

test("a partial sync with a manifest reference but no shard is incomplete, never an empty store", async () => {
  const records = [{ id: "context-partial", sentence: "anchored sentence" }];
  const shards = partitionRecords({ records, storeId: STORE_ID, root: ROOT, kind, idOf });
  const manifest = createManifest({ storeId: STORE_ID, kind, revision: 1, shards });
  const files = new Map([[manifestPathFor(ROOT), snapshot(manifest)]]);
  const readSnapshot = async (path) => files.get(path) || { exists: false, text: null, value: null, revision: 0, hash: null };

  await assert.rejects(readShardedStore({ readSnapshot, storeId: STORE_ID, root: ROOT, kind, idOf }),
    { code: "VOCAB_SHARD_MISSING" });
});

test("a shard arriving before its manifest is incomplete until the manifest arrives", async () => {
  const { adapter, store } = makeStore();
  const record = { id: "remote-first", sentence: "already synced shard" };
  const [part] = partitionRecords({ records: [record], storeId: STORE_ID, root: ROOT, kind, idOf });
  adapter.putSnapshot(part.path, part.value);

  await assert.rejects(store.load(), { code: "VOCAB_SHARD_MANIFEST_MISSING" });
  await assert.rejects(store.prepare([record]), { code: "VOCAB_SHARD_MANIFEST_MISSING" },
    "a save cannot replace a remote shard that arrived before its manifest");

  adapter.putSnapshot(manifestPathFor(ROOT), createManifest({ storeId: STORE_ID, kind, revision: 1, shards: [part] }));
  assert.deepEqual((await store.load()).records, [record]);
});

test("deleting a populated store manifest is incomplete and blocks replacement", async () => {
  const { adapter, store } = makeStore();
  const records = [{ id: "manifest-was-deleted", sentence: "preserve this record" }];
  const parts = partitionRecords({ records, storeId: STORE_ID, root: ROOT, kind, idOf });
  for (const part of parts) adapter.putSnapshot(part.path, part.value);
  adapter.putSnapshot(manifestPathFor(ROOT), createManifest({ storeId: STORE_ID, kind, revision: 1, shards: parts }));
  assert.equal((await store.load()).records.length, 1);

  adapter.files.delete(manifestPathFor(ROOT));
  await assert.rejects(store.load(), { code: "VOCAB_SHARD_MANIFEST_MISSING" });
  await assert.rejects(store.prepare([{ id: "would-overwrite", sentence: "must not replace" }]),
    { code: "VOCAB_SHARD_MANIFEST_MISSING" });
});

test("a missing manifest is empty only when there are no shard files, whether the directory is absent or empty", async () => {
  const { adapter, store } = makeStore();
  assert.deepEqual((await store.load()).records, [], "an absent root directory has no remote shard data");
  await adapter.mkdir(ROOT);
  assert.deepEqual((await store.load()).records, [], "an existing empty shard directory is an empty store");
});

test("partial JSON in a shard is never returned as an empty store", async () => {
  const { adapter, store } = makeStore();
  const record = { id: "partial-json", sentence: "do not erase" };
  const [part] = partitionRecords({ records: [record], storeId: STORE_ID, root: ROOT, kind, idOf });
  adapter.putSnapshot(manifestPathFor(ROOT), createManifest({ storeId: STORE_ID, kind, revision: 1, shards: [part] }));
  adapter.putSnapshot(part.path, "{\"schemaVersion\":1,");
  await assert.rejects(store.load(), { code: "VOCAB_SHARD_JSON_INVALID" });

  adapter.files.delete(manifestPathFor(ROOT));
  await assert.rejects(store.load(), { code: "VOCAB_SHARD_MANIFEST_MISSING" },
    "a partial shard without a manifest is still evidence of an incomplete store");
});

test("replacement writes only changed shard files plus the changed manifest, and no-ops are zero-write", async () => {
  const records = Array.from({ length: 16 }, (_, index) => ({ id: `item-${index}`, body: `value-${index}` }));
  const initialShards = partitionRecords({ records, storeId: STORE_ID, root: ROOT, kind, idOf, maxRecords: 1 });
  const initialManifest = createManifest({ storeId: STORE_ID, kind, revision: 1, shards: initialShards });
  const files = new Map([[manifestPathFor(ROOT), snapshot(initialManifest)]]);
  for (const shard of initialShards) files.set(shard.path, snapshot(shard.value));
  const readSnapshot = async (path) => files.get(path) || { exists: false, text: null, value: null, revision: 0, hash: null };
  const loaded = await readShardedStore({ readSnapshot, storeId: STORE_ID, root: ROOT, kind, idOf, maxRecords: 1 });

  const noOp = await prepareShardedReplacement({ readSnapshot, loaded, records, storeId: STORE_ID, root: ROOT, kind, idOf, maxRecords: 1 });
  assert.equal(noOp.noOp, true);
  assert.deepEqual(noOp.writes, []);

  const changedRecords = records.map((record) => record.id === "item-0" ? { ...record, body: "updated" } : record);
  const plan = await prepareShardedReplacement({
    readSnapshot,
    loaded,
    records: changedRecords,
    storeId: STORE_ID,
    root: ROOT,
    kind,
    idOf,
    maxRecords: 1,
  });
  const shardWrites = plan.writes.filter((write) => write.path !== manifestPathFor(ROOT));
  const manifestWrites = plan.writes.filter((write) => write.path === manifestPathFor(ROOT));
  assert.equal(shardWrites.length, 1);
  assert.equal(manifestWrites.length, 1);
  assert.equal(plan.writes.length, 2);
  assert.ok(plan.writes.every((write) => write.expectedHash));
  assert.ok(plan.writes.every((write) => JSON.parse(write.text).revision > write.expectedRevision));
});
