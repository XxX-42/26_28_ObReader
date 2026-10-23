import assert from "node:assert/strict";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import test from "node:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";

const require = createRequire(import.meta.url);
const { DictionaryQueryCache } = require("../plugin/vocabulary/dictionary-cache.cjs");
const { VocabularyDictionary } = require("../plugin/vocabulary/dictionary.cjs");
const DexieModule = require("dexie");
const Dexie = DexieModule.default || DexieModule;
if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

function makeResource(entries) {
  const uncompressed = Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  const compressed = gzipSync(uncompressed, { level: 9, mtime: 0 });
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  return {
    manifest: {
      schemaVersion: 1,
      kind: "pdf-reader-dictionary-resource",
      dictionaryId: "ECDICT",
      normalization: "nfc-lower-space-v1",
      entryCount: entries.length,
      compressedBytes: compressed.length,
      uncompressedBytes: uncompressed.length,
      sha256,
      resourceFile: `entries.${sha256}.jsonl.gz`,
      source: { sha256: "0".repeat(64), rows: entries.length },
    },
    compressed,
    uncompressed,
  };
}

function makeEntries(count = 6, prefix = "word") {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}${String(index + 1).padStart(3, "0")}`,
    translation: `释义 ${index + 1}`,
    phonetic: `p${index + 1}`,
  }));
}

function createCache(name = `dictionary-cache-${randomUUID()}`, options = {}) {
  return new DictionaryQueryCache({
    name,
    indexedDB,
    IDBKeyRange,
    batchSize: 2,
    ...options,
  });
}

class MemoryAdapter {
  constructor(resource) {
    this.resource = resource;
    this.readBinaryCount = 0;
    this.manifestReadCount = 0;
  }
  async read() {
    this.manifestReadCount += 1;
    return JSON.stringify(this.resource.manifest);
  }
  async readBinary() {
    this.readBinaryCount += 1;
    return this.resource.compressed;
  }
}

test("explicit v2 preparation imports once; warm lookups and reopened caches avoid readBinary", async (t) => {
  const name = `dictionary-cache-reopen-${randomUUID()}`;
  const resource = makeResource(makeEntries());
  const adapter = new MemoryAdapter(resource);
  const firstCache = createCache(name);
  const first = new VocabularyDictionary({ adapter, cache: firstCache });
  t.after(() => first.dispose());

  await first.ensureReady(); // v2 imports remain an explicit compatibility maintenance action.
  assert.deepEqual(await first.lookup(" WORD001 "), {
    key: "word001", translation: "释义 1", phonetic: "p1", source: "ECDICT",
  });
  assert.equal(adapter.readBinaryCount, 1, "cold lookup reads the resource once");
  assert.deepEqual(await first.lookup("word001"), {
    key: "word001", translation: "释义 1", phonetic: "p1", source: "ECDICT",
  });
  assert.equal(adapter.readBinaryCount, 1, "warm lookup reads from IndexedDB");

  first.dispose();
  const reopenedCache = createCache(name);
  const warmAdapter = new MemoryAdapter(resource);
  const reopened = new VocabularyDictionary({ adapter: warmAdapter, cache: reopenedCache });
  t.after(() => reopened.dispose());
  assert.deepEqual(await reopened.lookup("word002"), {
    key: "word002", translation: "释义 2", phonetic: "p2", source: "ECDICT",
  });
  assert.equal(warmAdapter.readBinaryCount, 0, "reopening a ready generation makes zero binary reads");

  reopened.dispose();
  const database = new Dexie(name, { indexedDB, IDBKeyRange });
  database.version(1).stores({ entries: "[generation+key]", generations: "&id", active: "&dictionaryId" });
  await database.delete();

  const rebuildAdapter = new MemoryAdapter(resource);
  const rebuilt = new VocabularyDictionary({ adapter: rebuildAdapter, cache: createCache(name) });
  t.after(() => rebuilt.dispose());
  await rebuilt.ensureReady();
  assert.deepEqual(await rebuilt.lookup("word003"), {
    key: "word003", translation: "释义 3", phonetic: "p3", source: "ECDICT",
  });
  assert.equal(rebuildAdapter.readBinaryCount, 1, "clearing the database causes one fresh import");
});

test("two cache instances sharing one database coordinate a single import", async (t) => {
  const name = `dictionary-cache-shared-${randomUUID()}`;
  const resource = makeResource(makeEntries());
  const first = createCache(name, { ownerId: "cache-owner-a" });
  const second = createCache(name, { ownerId: "cache-owner-b" });
  t.after(() => { first.close(); second.close(); });

  let releaseLoad;
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  let enteredLoad;
  const loadEntered = new Promise((resolve) => { enteredLoad = resolve; });
  let waitingNotice;
  const waiting = new Promise((resolve) => { waitingNotice = resolve; });
  let readCount = 0;
  const firstPrepare = first.prepare(resource.manifest, async () => {
    readCount += 1;
    enteredLoad();
    await loadGate;
    return resource.compressed;
  });
  await loadEntered;
  const secondPrepare = second.prepare(resource.manifest, async () => {
    readCount += 1;
    return resource.compressed;
  }, { onProgress: (progress) => { if (progress.phase === "waiting") waitingNotice(); } });
  await waiting;
  releaseLoad();

  const [firstReady, secondReady] = await Promise.all([firstPrepare, secondPrepare]);
  assert.equal(firstReady.id, secondReady.id);
  assert.equal(firstReady.status, "ready");
  assert.equal(secondReady.status, "ready");
  assert.equal(readCount, 1, "the second cache waits for the fenced import to finish");
  assert.equal((await second.active())?.id, firstReady.id);
});

test("lease expiry fences the old importer and preserves the takeover generation", async (t) => {
  const name = `dictionary-cache-fencing-${randomUUID()}`;
  const resource = makeResource(makeEntries(4));
  let oldClock = 1_000;
  let newClock = 1_101;
  const oldOwner = createCache(name, { ownerId: "expired-owner", now: () => oldClock, leaseMs: 100 });
  const newOwner = createCache(name, { ownerId: "takeover-owner", now: () => newClock, leaseMs: 100 });
  t.after(() => { oldOwner.close(); newOwner.close(); });

  let releaseOldLoad;
  const oldLoadGate = new Promise((resolve) => { releaseOldLoad = resolve; });
  let oldLoadStarted;
  const oldStarted = new Promise((resolve) => { oldLoadStarted = resolve; });
  const expiredPrepare = oldOwner.prepare(resource.manifest, async () => {
    oldLoadStarted();
    await oldLoadGate;
    return resource.compressed;
  });
  await oldStarted;

  newClock = oldClock + 101;
  const takeover = await newOwner.prepare(resource.manifest, async () => resource.compressed);
  assert.equal(takeover.status, "ready");
  releaseOldLoad();
  await assert.rejects(expiredPrepare, (error) => error.code === "DICTIONARY_CACHE_LEASE_LOST");
  assert.equal((await newOwner.active())?.id, takeover.id);
  assert.equal((await newOwner.ready(resource.manifest))?.owner, null,
    "the suspended importer cannot clear or invalidate the takeover's ready row");
});

test("interrupted imports resume; forced replacements stay quarantined until ready", async (t) => {
  const name = `dictionary-cache-resume-${randomUUID()}`;
  const resource = makeResource(makeEntries(8));
  const cache = createCache(name, { batchSize: 2 });
  const queryDictionary = new VocabularyDictionary({ adapter: new MemoryAdapter(resource), cache });
  t.after(() => queryDictionary.dispose());
  const controller = new AbortController();
  const initialProgress = [];
  await assert.rejects(cache.prepare(resource.manifest, async () => resource.compressed, {
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.phase === "building") {
        initialProgress.push(progress.count);
        if (progress.count === 2) controller.abort();
      }
    },
  }), (error) => error.code === "DICTIONARY_CACHE_CANCELLED");

  const generationId = `${resource.manifest.dictionaryId}:${resource.manifest.normalization}:${resource.manifest.sha256}`;
  let generation = await cache.db.generations.get(generationId);
  assert.equal(generation.status, "building");
  assert.equal(generation.count, 2);
  assert.equal(generation.owner, null, "an interrupted owner releases its lease");
  assert.equal(await cache.active(), null, "partial entries are not visible as an active dictionary");
  assert.equal(await cache.ready(resource.manifest), null);

  const resumedProgress = [];
  const resumed = await cache.prepare(resource.manifest, async () => resource.compressed, {
    onProgress: (progress) => { if (progress.phase === "building") resumedProgress.push(progress.count); },
  });
  assert.equal(resumed.status, "ready");
  assert.deepEqual(resumedProgress, [4, 6, 8], "resume continues after the last committed key");

  const forceController = new AbortController();
  const forcedProgress = [];
  await assert.rejects(cache.prepare(resource.manifest, async () => resource.compressed, {
    force: true,
    signal: forceController.signal,
    onProgress: (progress) => {
      if (progress.phase === "building") {
        forcedProgress.push(progress.count);
        if (progress.count === 2) forceController.abort();
      }
    },
  }), (error) => error.code === "DICTIONARY_CACHE_CANCELLED");
  assert.deepEqual(forcedProgress, [2], "force starts at the first batch after clearing old rows");
  generation = await cache.db.generations.get(`${generationId}:rebuild`);
  assert.equal(generation.id, `${generationId}:rebuild`);
  assert.equal(generation.status, "building");
  assert.equal(generation.count, 2);
  const previous = await cache.active();
  assert.equal(previous.id, generationId);
  assert.equal(previous.status, "ready");
  assert.equal(previous.count, resource.manifest.entryCount,
    "the previous complete generation remains active while the replacement is partial");
  assert.deepEqual(await queryDictionary.lookup("word007"), {
    key: "word007", translation: "释义 7", phonetic: "p7", source: "ECDICT",
  }, "lookups keep using the prior complete generation during rebuild");

  const rebuilt = await cache.prepare(resource.manifest, async () => resource.compressed, { force: true });
  assert.equal(rebuilt.status, "ready");
  assert.equal(rebuilt.id, `${generationId}:rebuild`);
  assert.equal(rebuilt.count, resource.manifest.entryCount);
  assert.equal((await cache.active())?.id, rebuilt.id);
});

test("missing or corrupt source bytes during force rebuild retain the prior ready slot", async (t) => {
  const resource = makeResource(makeEntries(4));
  for (const failureKind of ["missing", "corrupt"]) {
    await t.test(failureKind, async (subtest) => {
      const cache = createCache(`dictionary-cache-force-failure-${failureKind}-${randomUUID()}`);
      const adapter = new MemoryAdapter(resource);
      const dictionary = new VocabularyDictionary({ adapter, cache });
      subtest.after(() => dictionary.dispose());
      await dictionary.ensureReady();
      const original = await cache.active();
      const rebuildId = `${original.id}:rebuild`;
      const readBinary = adapter.readBinary.bind(adapter);
      adapter.readBinary = async () => {
        adapter.readBinaryCount += 1;
        if (failureKind === "missing") throw new Error("fixture resource is not synchronized");
        const damaged = Buffer.from(resource.compressed);
        damaged[damaged.length - 1] ^= 0xff;
        return damaged;
      };
      const expectedCode = failureKind === "missing" ? "DICTIONARY_RESOURCE_MISSING" : "DICTIONARY_RESOURCE_CORRUPT";
      await assert.rejects(cache.prepare(resource.manifest, () => dictionary.loadBytes(resource.manifest), { force: true }),
        (error) => error.code === expectedCode);
      adapter.readBinary = readBinary;

      const stillReady = await cache.active();
      assert.equal(stillReady?.id, original.id);
      assert.equal(stillReady?.status, "ready");
      assert.equal((await cache.db.generations.get(rebuildId))?.status,
        failureKind === "missing" ? "building" : "invalid");
      assert.deepEqual(await dictionary.lookup("word003"), {
        key: "word003", translation: "释义 3", phonetic: "p3", source: "ECDICT",
      });
      assert.equal(adapter.readBinaryCount, 2, "querying the retained ready slot does not retry the failed resource");
    });
  }
});

test("repeated true-negative lookups use the membership index without counting all entries", async (t) => {
  const resource = makeResource(makeEntries(5));
  const adapter = new MemoryAdapter(resource);
  const cache = createCache(`dictionary-cache-negative-${randomUUID()}`);
  const dictionary = new VocabularyDictionary({ adapter, cache });
  t.after(() => dictionary.dispose());
  await dictionary.ensureReady();

  const entryCount = cache.entryCount.bind(cache);
  let entryCountCalls = 0;
  cache.entryCount = (...args) => {
    entryCountCalls += 1;
    return entryCount(...args);
  };
  for (let index = 0; index < 8; index += 1) {
    assert.equal(await dictionary.lookup("word999"), null);
  }
  assert.equal(entryCountCalls, 0, "membership answers repeated absent-key queries without a full count");
});

test("a missing payload and its expected membership bucket force a rebuild", async (t) => {
  const resource = makeResource(makeEntries(5));
  const adapter = new MemoryAdapter(resource);
  const cache = createCache(`dictionary-cache-missing-membership-${randomUUID()}`);
  const dictionary = new VocabularyDictionary({ adapter, cache });
  t.after(() => dictionary.dispose());
  await dictionary.ensureReady();

  const generation = await cache.active();
  assert.ok(generation.prefixes.includes("wo"));
  assert.ok(await cache.db.membership.get([generation.id, "wo"]));
  await cache.db.entries.delete([generation.id, "word004"]);
  await cache.db.membership.delete([generation.id, "wo"]);

  await assert.rejects(dictionary.lookup("word004"), (error) => error.code === "DICTIONARY_CACHE_INCOMPLETE");
  await dictionary.rebuildCache();
  assert.deepEqual(await dictionary.lookup("word004"), {
    key: "word004", translation: "释义 4", phonetic: "p4", source: "ECDICT",
  });
  assert.equal(adapter.readBinaryCount, 2, "inventory gaps cannot turn a damaged cached lookup into a false miss");
});

test("a second window's partial forced rebuild leaves old complete lookups available", async (t) => {
  const resource = makeResource(makeEntries(8));
  const name = `dictionary-cache-multiwindow-force-${randomUUID()}`;
  const firstCache = createCache(name, { ownerId: "first-window" });
  const adapter = new MemoryAdapter(resource);
  const firstDictionary = new VocabularyDictionary({ adapter, cache: firstCache });
  const secondCache = createCache(name, { ownerId: "second-window", batchSize: 2 });
  t.after(() => { firstDictionary.dispose(); secondCache.close(); });

  await firstDictionary.ensureReady();
  const original = await firstCache.active();
  const rebuildId = `${original.id}:rebuild`;
  const controller = new AbortController();
  await assert.rejects(secondCache.prepare(resource.manifest, async () => resource.compressed, {
    force: true,
    signal: controller.signal,
    onProgress: (progress) => {
      if (progress.phase === "building" && progress.count === 2) controller.abort();
    },
  }), (error) => error.code === "DICTIONARY_CACHE_CANCELLED");

  const staged = await secondCache.db.generations.get(rebuildId);
  assert.equal(staged?.status, "building");
  assert.equal(staged?.count, 2);
  assert.equal((await firstCache.active())?.id, original.id);
  assert.deepEqual(await firstDictionary.lookup("word007"), {
    key: "word007", translation: "释义 7", phonetic: "p7", source: "ECDICT",
  });
  assert.equal(adapter.readBinaryCount, 1, "the old window keeps answering from its complete slot");
});

test("malformed gzip, checksum mismatch, unsorted keys, and duplicate keys fail closed", async (t) => {
  const good = makeResource(makeEntries(3));
  const malformedGzip = {
    ...good,
    compressed: Buffer.from("not a gzip stream"),
    manifest: { ...good.manifest, compressedBytes: Buffer.byteLength("not a gzip stream"), sha256: createHash("sha256").update("not a gzip stream").digest("hex") },
  };
  malformedGzip.manifest.resourceFile = `entries.${malformedGzip.manifest.sha256}.jsonl.gz`;
  const checksumMismatch = {
    ...good,
    manifest: { ...good.manifest, sha256: "f".repeat(64), resourceFile: `entries.${"f".repeat(64)}.jsonl.gz` },
  };
  const unsorted = makeResource([
    { key: "beta", translation: "乙", phonetic: "" },
    { key: "alpha", translation: "甲", phonetic: "" },
  ]);
  const duplicate = makeResource([
    { key: "alpha", translation: "甲", phonetic: "" },
    { key: "alpha", translation: "另一释义", phonetic: "" },
  ]);

  for (const [label, resource] of [
    ["malformed gzip", malformedGzip],
    ["checksum mismatch", checksumMismatch],
    ["unsorted keys", unsorted],
    ["duplicate keys", duplicate],
  ]) {
    await t.test(label, async (subtest) => {
      const cache = createCache(`dictionary-cache-corrupt-${randomUUID()}`);
      subtest.after(() => cache.close());
      let failure;
      try {
        await cache.prepare(resource.manifest, async () => resource.compressed);
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, "invalid resource data is rejected");
      assert.equal(await cache.ready(resource.manifest), null);
      assert.equal(await cache.active(), null, "invalid generations are never activated");
      assert.equal(failure.code, "DICTIONARY_RESOURCE_CORRUPT");
    });
  }
});

test("failed source upgrade keeps the previous verified generation available", async (t) => {
  const oldResource = makeResource(makeEntries(3, "old"));
  const adapter = new MemoryAdapter(oldResource);
  const cache = createCache(`dictionary-cache-upgrade-${randomUUID()}`);
  const dictionary = new VocabularyDictionary({ adapter, cache });
  t.after(() => dictionary.dispose());

  await dictionary.ensureReady();
  const previous = await cache.active();
  assert.ok(previous?.status === "ready");

  const brokenBytes = Buffer.from("bad gzip");
  const brokenHash = createHash("sha256").update(brokenBytes).digest("hex");
  adapter.resource = {
    compressed: brokenBytes,
    manifest: {
      ...oldResource.manifest,
      entryCount: 1,
      compressedBytes: brokenBytes.length,
      uncompressedBytes: 100,
      sha256: brokenHash,
      resourceFile: `entries.${brokenHash}.jsonl.gz`,
    },
  };
  dictionary.invalidate();
  let upgradeFailure;
  try {
    await dictionary.ensureReady();
  } catch (error) {
    upgradeFailure = error;
  }
  assert.ok(upgradeFailure, "the malformed new source is rejected");
  assert.equal((await cache.active()).id, previous.id);
  assert.deepEqual(await dictionary.lookup("old001"), {
    key: "old001", translation: "释义 1", phonetic: "p1", source: "ECDICT",
  }, "lookup serves the prior verified generation after an upgrade failure");
  assert.equal(upgradeFailure.code, "DICTIONARY_RESOURCE_CORRUPT");
});

test("ensureReady waits for an invalidated pending import, then builds the new manifest", async (t) => {
  const oldResource = makeResource([
    { key: "alpha", translation: "旧释义", phonetic: "old" },
    { key: "beta", translation: "旧乙", phonetic: "b" },
  ]);
  const newResource = makeResource([
    { key: "alpha", translation: "新释义", phonetic: "new" },
    { key: "beta", translation: "新乙", phonetic: "b" },
  ]);
  let releaseOldRead;
  const oldReadGate = new Promise((resolve) => { releaseOldRead = resolve; });
  let signalOldRead;
  const oldReadStarted = new Promise((resolve) => { signalOldRead = resolve; });
  const adapter = {
    resource: oldResource,
    manifestReadCount: 0,
    binaryReads: [],
    async read() {
      this.manifestReadCount += 1;
      return JSON.stringify(this.resource.manifest);
    },
    async readBinary() {
      const captured = this.resource;
      this.binaryReads.push(captured.manifest.sha256);
      if (this.binaryReads.length === 1) {
        signalOldRead();
        await oldReadGate;
      }
      return captured.compressed;
    },
  };
  const cache = createCache(`dictionary-cache-invalidate-pending-${randomUUID()}`);
  const dictionary = new VocabularyDictionary({ adapter, cache });
  t.after(() => dictionary.dispose());

  const oldPreparation = dictionary.ensureReady();
  await oldReadStarted;
  adapter.resource = newResource;
  dictionary.invalidate();
  const newPreparation = dictionary.ensureReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(adapter.manifestReadCount, 1, "the new call waits for the old pending call to settle");

  releaseOldRead();
  const [oldReady, newReady] = await Promise.all([oldPreparation, newPreparation]);
  assert.equal(oldReady.id, `ECDICT:nfc-lower-space-v1:${oldResource.manifest.sha256}`);
  assert.equal(newReady.id, `ECDICT:nfc-lower-space-v1:${newResource.manifest.sha256}`);
  assert.notEqual(newReady.id, oldReady.id);
  assert.deepEqual(adapter.binaryReads, [oldResource.manifest.sha256, newResource.manifest.sha256]);
  assert.equal(adapter.manifestReadCount, 2);
  assert.equal((await cache.active())?.id, newReady.id);
  assert.deepEqual(await dictionary.lookup("alpha"), {
    key: "alpha", translation: "新释义", phonetic: "new", source: "ECDICT",
  });
});

test("a missing cached entry invalidates the ready marker and rebuilds before returning", async (t) => {
  const resource = makeResource(makeEntries(4));
  const adapter = new MemoryAdapter(resource);
  const cache = createCache(`dictionary-cache-missing-row-${randomUUID()}`);
  const dictionary = new VocabularyDictionary({ adapter, cache });
  t.after(() => dictionary.dispose());

  await dictionary.ensureReady();
  const original = await cache.active();
  assert.ok(original);
  await cache.db.entries.delete([original.id, "word001"]);
  assert.equal(await cache.entryCount(original.id), resource.manifest.entryCount - 1);

  await assert.rejects(dictionary.lookup("word001"), (error) => error.code === "DICTIONARY_CACHE_INCOMPLETE");
  await dictionary.rebuildCache();
  assert.deepEqual(await dictionary.lookup("word001"), {
    key: "word001", translation: "释义 1", phonetic: "p1", source: "ECDICT",
  });
  assert.equal(adapter.readBinaryCount, 2, "an incomplete ready generation is rebuilt from the source resource");
  assert.equal((await cache.ready(resource.manifest))?.status, "ready");
  assert.equal(await cache.entryCount(original.id), resource.manifest.entryCount);
});

test("corrupted cached display fields are rejected and rebuilt", async (t) => {
  const resource = makeResource(makeEntries(4));
  const adapter = new MemoryAdapter(resource);
  const cache = createCache(`dictionary-cache-corrupt-row-${randomUUID()}`);
  const dictionary = new VocabularyDictionary({ adapter, cache });
  t.after(() => dictionary.dispose());

  await dictionary.ensureReady();
  const generation = await cache.active();
  const row = await cache.db.entries.get([generation.id, "word002"]);
  await cache.db.entries.put({ ...row, translation: 17, phonetic: null });

  await assert.rejects(dictionary.lookup("word002"), (error) => error.code === "DICTIONARY_CACHE_INCOMPLETE");
  await dictionary.rebuildCache();
  assert.deepEqual(await dictionary.lookup("word002"), {
    key: "word002", translation: "释义 2", phonetic: "p2", source: "ECDICT",
  });
  assert.equal(adapter.readBinaryCount, 2, "corrupt cache fields trigger a clean source rebuild");
});

test("IndexedDB unavailable reports a stable cache error", async (t) => {
  const resource = makeResource(makeEntries(1));
  const cache = new DictionaryQueryCache({
    name: `dictionary-cache-no-idb-${randomUUID()}`,
    indexedDB: null,
    IDBKeyRange: null,
  });
  t.after(() => cache.close());
  await assert.rejects(cache.prepare(resource.manifest, async () => resource.compressed),
    (error) => error.code === "DICTIONARY_CACHE_UNAVAILABLE");
});
