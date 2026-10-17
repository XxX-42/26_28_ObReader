import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const {
  VocabularyService,
  VOCABULARY_PATH,
  VOCABULARY_SCHEMA_VERSION,
  vocabularyFamilyKeyForKey,
  validateVocabularySnapshotV2,
  serializeVocabularySnapshotV2,
  prepareVocabularyRestoreFields,
  createVocabularyHistoryHandler,
} = require("../plugin/vocabulary/service.cjs");
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");
const { VocabularyMemoryAdapter } = await import("./vocabulary-v2-memory-adapter.mjs");
const { hashText } = require("../plugin/vocabulary/canonical.cjs");
const legacyReader = require("./fixtures/legacy-vocabulary-v1-reader.cjs");

class MemoryAdapter {
  constructor() {
    this.files = new Map();
    this.directories = new Set([""]);
    this.writeCount = 0;
    this.failInstall = false;
  }
  async exists(path) { return this.files.has(path) || this.directories.has(path); }
  async mkdir(path) { this.directories.add(path); }
  async read(path) {
    if (!this.files.has(path)) throw new Error(`missing file: ${path}`);
    return this.files.get(path);
  }
  async write(path, text) { this.writeCount += 1; this.files.set(path, text); }
  async rename(from, to) {
    if (this.failInstall && from.includes(".tmp-") && to === VOCABULARY_PATH) {
      throw new Error("simulated migration install failure");
    }
    if (!this.files.has(from)) throw new Error(`missing source: ${from}`);
    if (this.files.has(to)) throw new Error(`target exists: ${to}`);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }
  async remove(path) { this.files.delete(path); this.directories.delete(path); }
}

function makeService(adapter, extra = {}) {
  let counter = 0;
  return new VocabularyService({
    adapter,
    makeId: () => `family-test-${++counter}`,
    now: () => 1000 + counter,
    ...extra,
  });
}

function legacySnapshot(records, revision = 7) {
  return JSON.stringify({
    schema: "pdf-web-reader-vocabulary",
    schemaVersion: 1,
    language: "en",
    revision,
    records,
  }, null, 2);
}

function legacyRecord(key, overrides = {}) {
  return {
    key,
    type: key.includes(" ") ? "phrase" : "word",
    surface: key,
    status: 2,
    createdAt: 10,
    updatedAt: 11,
    source: "user",
    ...overrides,
  };
}

test("ready and migrate do not write an empty snapshot when the store is absent", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  assert.deepEqual(await service.ready(), { schemaVersion: 2, revision: 0, needsMigration: false });
  assert.deepEqual(await service.migrate(), { migrated: false, schemaVersion: 2, revision: 0 });
  assert.equal(adapter.writeCount, 0);
  assert.equal(await adapter.exists(VOCABULARY_PATH), false);
  assert.equal(await service.getTerm("walk"), undefined);
});

test("family evidence pairs the family with the loaded canonical snapshot identity without rereading disk", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.ready();
  let readCount = 0;
  const read = adapter.read.bind(adapter);
  adapter.read = async (path) => { readCount += 1; return read(path); };

  const absent = await service.getSnapshotIdentity();
  assert.deepEqual(absent, {
    storeId: "vocabulary-core", path: VOCABULARY_PATH, exists: false, revision: 0, hash: null,
  });
  assert.equal(readCount, 0, "identity reads after ready use the already-loaded bytes");

  await service.upsertTerm("walk", { status: 2 });
  readCount = 0;
  const evidence = await service.getFamilyEvidence("walking");
  assert.equal(evidence.family.familyKey, vocabularyFamilyKeyForKey("walk"));
  assert.equal(evidence.family.status, 2);
  assert.deepEqual(evidence.identity, {
    storeId: "vocabulary-core", path: VOCABULARY_PATH, exists: true,
    revision: service.getRevision(), hash: hashText(adapter.files.get(VOCABULARY_PATH)),
  });
  assert.equal(Object.isFrozen(evidence.identity), true);
  assert.equal(readCount, 0, "family and matching snapshot identity come from one serialized in-memory read");
});

test("v1 migration is atomic, family-stable, status-max preserving, and idempotent", async () => {
  const adapter = new MemoryAdapter();
  const original = legacySnapshot([
    legacyRecord("walk", { status: 2, translation: "步行", note: "base note", phonetic: "/wɔːk/" }),
    legacyRecord("walked", { status: 5, translation: "走过", note: "past note", source: "import" }),
    legacyRecord("lie", { status: 3, translation: "躺" }),
    legacyRecord("lay", { status: 4, translation: "放置" }),
    legacyRecord("laid", { status: 2, translation: "放置过去式" }),
    legacyRecord("low", { status: 2 }),
    legacyRecord("lowest", { status: 4 }),
    legacyRecord("walk the dog", { type: "phrase", status: 1, note: "phrase base" }),
    legacyRecord("walked the dog", { type: "phrase", status: 3, note: "phrase past" }),
  ]);
  adapter.files.set(VOCABULARY_PATH, original);
  const service = makeService(adapter);

  assert.deepEqual(await service.ready(), { schemaVersion: 1, revision: 7, needsMigration: true });
  const before = await service.getFamily("walking");
  assert.equal(before.status, 5);
  assert.deepEqual(before.records.map((record) => record.key).sort(), ["walk", "walked"]);
  assert.equal((await service.getTerm("walking")).key, "walk",
    "before migration the richer base entry remains the selected record");
  await assert.rejects(service.setStatus("walk", 3), (error) => error.code === "vocabulary-migration-required");
  assert.equal(adapter.files.get(VOCABULARY_PATH), original, "reads and rejected writes leave the exact v1 bytes untouched");

  const migrated = await service.migrate();
  assert.deepEqual(migrated, { migrated: true, schemaVersion: 2, revision: 8 });
  const persisted = JSON.parse(adapter.files.get(VOCABULARY_PATH));
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.revision, 8);
  assert.deepEqual(Object.keys(persisted).sort(), ["language", "records", "revision", "schema", "schemaVersion"]);
  const byKey = new Map(persisted.records.map((record) => [record.key, record]));
  assert.equal(byKey.get("walk").familyKey, vocabularyFamilyKeyForKey("walk"));
  assert.equal(byKey.get("walked").familyKey, byKey.get("walk").familyKey);
  assert.equal(byKey.get("walk").status, 5);
  assert.equal(byKey.get("walked").status, 5, "migration applies the effective maximum to every family member");
  assert.equal((await service.getTerm("walking")).key, "walk",
    "after migration normalized family statuses use the stable lexical tie-break");
  assert.equal(byKey.get("walk").translation, "步行");
  assert.equal(byKey.get("walk").note, "base note");
  assert.equal(byKey.get("walk").phonetic, "/wɔːk/");
  assert.equal(byKey.get("walked").translation, "走过", "personal text is not merged across siblings");
  assert.equal(byKey.get("walked").note, "past note");
  assert.equal(byKey.get("walked").source, "import");
  assert.notEqual(byKey.get("lay").familyKey, byKey.get("lie").familyKey);
  assert.equal(byKey.get("lay").familyKey, byKey.get("laid").familyKey);
  assert.equal(byKey.get("lie").status, 3);
  assert.equal(byKey.get("lay").status, 4);
  assert.equal(byKey.get("laid").status, 4);
  assert.equal(byKey.get("low").familyKey, byKey.get("lowest").familyKey);
  assert.equal(byKey.get("low").status, 4);
  assert.equal(byKey.get("walk the dog").familyKey, byKey.get("walked the dog").familyKey);
  assert.equal(byKey.get("walk the dog").status, 3);
  assert.equal((await service.getFamily("lying")).status, 3);
  assert.equal((await service.getFamily("laying")).status, 4);

  const writeCount = adapter.writeCount;
  assert.deepEqual(await service.migrate(), { migrated: false, schemaVersion: 2, revision: 8 });
  assert.equal(adapter.writeCount, writeCount, "a repeated migration is a no-op");
});

test("failed migration keeps the validated v1 snapshot readable and blocks writes until retry", async () => {
  const adapter = new MemoryAdapter();
  const original = legacySnapshot([
    legacyRecord("walk", { status: 2, note: "keep" }),
    legacyRecord("walking", { status: 4, translation: "走" }),
  ]);
  adapter.files.set(VOCABULARY_PATH, original);
  adapter.failInstall = true;
  const service = makeService(adapter);
  await service.ready();

  await assert.rejects(service.migrate(), /simulated migration install failure/);
  assert.equal(adapter.files.get(VOCABULARY_PATH), original, "rollback preserves all old bytes");
  assert.equal(adapter.files.has(`${VOCABULARY_PATH}.previous`), false);
  assert.equal((await service.getTerm("walking")).status, 4, "validated v1 state remains readable");
  assert.equal((await service.getFamily("walk")).records.length, 2);
  await assert.rejects(service.setStatus("walk", 3), (error) => error.code === "vocabulary-migration-failed");

  adapter.failInstall = false;
  assert.equal((await service.migrate()).migrated, true, "explicit retry can complete the migration");
  assert.equal((await service.setStatus("walk", 3)).status, 3);
});

test("reload validates external snapshots, preserves the last read on corruption, and recovers from a verified backup", async () => {
  const adapter = new MemoryAdapter();
  const writer = makeService(adapter);
  await writer.upsertTerm("walk", { status: 3, translation: "走" });
  const reader = makeService(adapter);
  await reader.ready();
  const events = [];
  reader.subscribe((event) => events.push(event));

  await writer.setNote("walk", "external writer");
  await assert.rejects(reader.setNote("walk", "stale local edit"),
    (error) => error.code === "vocabulary-external-change");
  await assert.rejects(reader.getTerm("walk"), (error) => error.code === "vocabulary-external-change");
  await reader.reload();
  assert.equal((await reader.getTerm("walk")).note, "external writer",
    "reload clears the stale-writer poison only after validating the current snapshot");

  const changed = JSON.parse(adapter.files.get(VOCABULARY_PATH));
  changed.revision += 1;
  changed.records[0].note = "external sync";
  const changedBytes = JSON.stringify(changed);
  adapter.files.set(VOCABULARY_PATH, changedBytes);
  assert.deepEqual(await reader.reload(), { reloaded: true, schemaVersion: 2, revision: changed.revision });
  assert.equal((await reader.getTerm("walking")).note, "external sync");
  assert.equal(events.at(-1).invalidateAll, true, "any external reload invalidates all page vocabulary state");

  const corrupt = JSON.stringify({ schema: "pdf-web-reader-vocabulary", schemaVersion: 99 });
  adapter.files.set(VOCABULARY_PATH, corrupt);
  await assert.rejects(reader.reload(), (error) => error.code === "vocabulary-corrupt-schema");
  assert.equal((await reader.getTerm("walk")).note, "external sync", "a bad replacement does not discard the previous validated map");
  await assert.rejects(reader.setNote("walk", "must wait"), (error) => error.code === "vocabulary-corrupt-schema");
  assert.equal(adapter.files.get(VOCABULARY_PATH), corrupt, "reload never overwrites corrupt external bytes");

  adapter.files.set(VOCABULARY_PATH, changedBytes);
  assert.deepEqual(await reader.reload(), { reloaded: false, schemaVersion: 2, revision: changed.revision },
    "restoring the exact last validated bytes clears the read-only fallback without reloading state");
  assert.equal((await reader.setNote("walk", "after recovery")).note, "after recovery");

  const verifiedBytes = adapter.files.get(VOCABULARY_PATH);
  adapter.files.set(`${VOCABULARY_PATH}.previous`, verifiedBytes);
  adapter.files.delete(VOCABULARY_PATH);
  assert.deepEqual(await reader.reload(), {
    reloaded: true,
    schemaVersion: 2,
    revision: JSON.parse(verifiedBytes).revision,
  });
  assert.equal((await reader.getTerm("walk")).note, "after recovery",
    "a missing canonical file restores the validated backup in memory instead of treating the store as empty");

  adapter.files.delete(`${VOCABULARY_PATH}.previous`);
  const writesBeforeMissingStore = adapter.writeCount;
  await assert.rejects(reader.reload(), (error) => error.code === "vocabulary-missing-store");
  assert.equal((await reader.getTerm("walk")).note, "after recovery",
    "a missing canonical and backup preserve the last validated read view");
  await assert.rejects(reader.setNote("walk", "must not recreate silently"),
    (error) => error.code === "vocabulary-missing-store");
  assert.equal(adapter.writeCount, writesBeforeMissingStore);
  assert.equal(adapter.files.has(VOCABULARY_PATH), false);
});

test("unknown and newer schemas fail closed without changing the original file", async () => {
  for (const schemaVersion of [0, 3, 99]) {
    const adapter = new MemoryAdapter();
    const original = JSON.stringify({
      schema: "pdf-web-reader-vocabulary", schemaVersion, language: "en", revision: 1, records: [],
    });
    adapter.files.set(VOCABULARY_PATH, original);
    const service = makeService(adapter);
    await assert.rejects(service.ready(), (error) => error.code === "vocabulary-corrupt-schema");
    await assert.rejects(service.migrate());
    assert.equal(adapter.files.get(VOCABULARY_PATH), original);
    assert.equal(adapter.writeCount, 0);
  }
});

test("v2 rejects undeclared envelope and record fields while v1 keeps its legacy cleanup behavior", async () => {
  for (const location of ["envelope", "record"]) {
    const adapter = new MemoryAdapter();
    await makeService(adapter).upsertTerm("walk", { status: 2, phonetic: "/wɔːk/" });
    const current = JSON.parse(adapter.files.get(VOCABULARY_PATH));
    if (location === "envelope") current.reviewIndex = { revision: 1 };
    else current.records[0].contextState = { note: "not part of core v2" };
    const invalidV2Bytes = JSON.stringify(current);
    adapter.files.set(VOCABULARY_PATH, invalidV2Bytes);
    const writesBeforeRead = adapter.writeCount;
    const reader = makeService(adapter);
    const expectedCode = location === "envelope" ? "vocabulary-corrupt-schema" : "vocabulary-corrupt-record";
    await assert.rejects(reader.ready(), (error) => error.code === expectedCode);
    await assert.rejects(reader.upsertTerm("walk", { status: 3 }), (error) => error.code === expectedCode);
    assert.equal(adapter.files.get(VOCABULARY_PATH), invalidV2Bytes);
    assert.equal(adapter.writeCount, writesBeforeRead, "unknown v2 data is never silently discarded by a write");
  }

  const adapter = new MemoryAdapter();
  const legacy = JSON.parse(legacySnapshot([
    legacyRecord("walk", { ipa: "/wɔːk/", reviewState: { note: "v1 ignored unknown" } }),
  ]));
  legacy.reviewIndex = { note: "v1 envelope cleanup remains compatible" };
  adapter.files.set(VOCABULARY_PATH, JSON.stringify(legacy));
  const service = makeService(adapter);
  assert.deepEqual(await service.ready(), { schemaVersion: 1, revision: 7, needsMigration: true });
  const record = await service.getTerm("walk");
  assert.equal(record.phonetic, "/wɔːk/", "the historical v1 pronunciation alias remains accepted");
  assert.equal("reviewState" in record, false);
  await service.migrate();
  const upgraded = JSON.parse(adapter.files.get(VOCABULARY_PATH));
  assert.deepEqual(Object.keys(upgraded).sort(), ["language", "records", "revision", "schema", "schemaVersion"]);
  assert.deepEqual(Object.keys(upgraded.records[0]).sort(), [
    "createdAt", "familyKey", "key", "phonetic", "source", "status", "surface", "type", "updatedAt",
  ]);
});

test("family descriptors reuse existing word and phrase matching without splitting lay/lie", async () => {
  assert.equal(vocabularyFamilyKeyForKey("walk"), vocabularyFamilyKeyForKey("walking"));
  assert.equal(vocabularyFamilyKeyForKey("walking"), vocabularyFamilyKeyForKey("walked"));
  assert.equal(vocabularyFamilyKeyForKey("low"), vocabularyFamilyKeyForKey("lowest"));
  assert.equal(vocabularyFamilyKeyForKey("walk the dog"), vocabularyFamilyKeyForKey("walking the dogs"));
  assert.equal(vocabularyFamilyKeyForKey("walked home"), vocabularyFamilyKeyForKey("walking homes"));
  assert.notEqual(vocabularyFamilyKeyForKey("forest"), vocabularyFamilyKeyForKey("for"));
  assert.notEqual(vocabularyFamilyKeyForKey("lay"), vocabularyFamilyKeyForKey("lie"));
  assert.equal(vocabularyFamilyKeyForKey("lay"), vocabularyFamilyKeyForKey("laid"));
  assert.equal(vocabularyFamilyKeyForKey("laying"), vocabularyFamilyKeyForKey("lays"));
  assert.equal(vocabularyFamilyKeyForKey("lie"), vocabularyFamilyKeyForKey("lying"));

  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.importJson([
    { key: "walk", surface: "walk", status: 2, translation: "走" },
    { key: "walking", surface: "walking", status: 4, note: "progress" },
  ]);
  const family = await service.getFamilyByKey(vocabularyFamilyKeyForKey("walk"));
  assert.equal(family.status, 4);
  assert.deepEqual(family.records.map((record) => record.key).sort(), ["walk", "walking"]);
  assert.ok(family.records.every((record) => record.status === 4));
  assert.equal(family.records.find((record) => record.key === "walk").translation, "走");
  assert.equal(family.records.find((record) => record.key === "walking").note, "progress");
});

test("lay phrase aliases stay scoped to the matching physical phrase family", async () => {
  const service = makeService(new MemoryAdapter());
  await service.importJson([
    { key: "lay down", surface: "lay down", type: "phrase", status: 3, note: "put something down" },
    { key: "lay off", surface: "lay off", type: "phrase", status: 2,
      translation: "停止", phonetic: "/leɪ ɔːf/" },
    { key: "lie down", surface: "lie down", type: "phrase", status: 4, note: "recline" },
  ]);

  const layingDown = await service.getFamily("laid down");
  const layingOff = await service.getFamily("laid off");
  const reclining = await service.getFamily("lie down");
  assert.deepEqual(layingDown.records.map((record) => record.key), ["lay down"]);
  assert.deepEqual(layingOff.records.map((record) => record.key), ["lay off"]);
  assert.deepEqual(reclining.records.map((record) => record.key), ["lie down"]);

  await service.setStatus("laid down", 5);
  assert.equal((await service.getTerm("lay down")).status, 5);
  assert.equal((await service.getTerm("lay off")).status, 2,
    "a different phrase containing bare lay is not pulled into the laid-down status write");
  assert.equal((await service.getTerm("lie down")).status, 4);
});

test("KNOWN protection follows the whole imported inflection family without merging metadata", async () => {
  const service = makeService(new MemoryAdapter());
  await service.importJson([
    { key: "walk", surface: "walk", status: 2, translation: "走" },
    { key: "walked", surface: "walked", status: 3, note: "past note" },
  ]);
  await service.setStatus("walking", 5);
  const skipped = await service.importJson(
    [{ key: "walked", surface: "walked", status: 1, note: "overwrite attempt" }],
    { overwriteExisting: true },
  );
  assert.equal(skipped.skippedKnown, 1);
  const family = await service.getFamily("walk");
  assert.equal(family.status, 5);
  assert.equal(family.records.find((record) => record.key === "walk").translation, "走");
  assert.equal(family.records.find((record) => record.key === "walked").note, "past note");
});

test("versioned family identity is independent of which member becomes the selected storage record", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.importJson([
    { key: "walk", surface: "walk", status: 2, translation: "" },
    { key: "walked", surface: "walked", status: 4, translation: "past form" },
  ]);
  const familyKey = vocabularyFamilyKeyForKey("walk");
  assert.equal(familyKey, 'en-family:v1:word:["walk"]');
  assert.equal((await service.getTerm("walking")).key, "walked");
  assert.equal((await service.getFamily("walking")).familyKey, familyKey);

  await service.setTranslation("walked", "");
  assert.equal((await service.getTerm("walking")).key, "walk",
    "the selected member can change when its personal metadata changes");
  const persisted = JSON.parse(adapter.files.get(VOCABULARY_PATH));
  assert.ok(persisted.records.every((record) => record.familyKey === familyKey));
  const reloaded = makeService(adapter);
  await reloaded.ready();
  assert.equal((await reloaded.getFamily("walking")).familyKey, familyKey,
    "validated family identity remains stable across persistence and reload");
});

test("listFamilies supports stable cursors and type/status/query filters", async () => {
  const service = makeService(new MemoryAdapter());
  await service.upsertTerm("walk", { status: 4 });
  await service.upsertTerm("walking", { status: 2 });
  await service.upsertTerm("take care of", { type: "phrase", status: 3 });
  await service.upsertTerm("low", { status: 5 });

  const first = await service.listFamilies({ limit: 2 });
  assert.equal(first.families.length, 2);
  assert.equal(first.total, 3, "inflection members appear as one family");
  assert.ok(first.nextCursor);
  const second = await service.listFamilies({ limit: 2, cursor: first.nextCursor });
  assert.equal(second.families.length, 1);
  assert.equal(second.nextCursor, null);
  assert.notEqual(first.families[0].familyKey, second.families[0].familyKey);

  const phrase = await service.listFamilies({ type: "phrase", status: 3, query: "care", limit: 10 });
  assert.equal(phrase.total, 1);
  assert.equal(phrase.families[0].records[0].key, "take care of");
  assert.equal((await service.listFamilies({ status: 5 })).families[0].records[0].key, "low");
  await assert.rejects(service.listFamilies({ limit: 101 }), /page size/);
  await assert.rejects(service.getFamilyByKey("en-family:v2:word:[\"walk\"]"), /family key is invalid/);
});

test("subscriber invalidation expands family surfaces and falls back above 64 keys", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.importJson([
    { key: "walk", surface: "walk", status: 2 },
    { key: "walking", surface: "walking", status: 2 },
  ]);
  const events = [];
  service.subscribe((event) => events.push(event));
  await service.setNote("walk", "family change");
  assert.deepEqual(events[0].changedKeys.sort(), ["walk", "walking"]);
  assert.equal(events[0].changedFamilyKeys.length, 1);
  assert.equal(events[0].invalidateAll, undefined);

  const bulk = Array.from({ length: 65 }, (_, index) => ({ key: `book${index}`, surface: `book${index}`, status: 1 }));
  await service.importJson(bulk);
  assert.equal(events.at(-1).invalidateAll, true);
  assert.equal("changedKeys" in events.at(-1), false, "large invalidations carry no oversized key arrays");
  assert.equal("changedFamilyKeys" in events.at(-1), false);
});

test("strict v2 snapshot and field restore resolve records by canonical key, never array position", async () => {
  const service = makeService(new MemoryAdapter());
  await service.importJson([
    { key: "walk", surface: "walk", status: 2, translation: "走" },
    { key: "walked", surface: "walked", status: 2, note: "past" },
  ]);
  const after = JSON.parse(await service.exportJson());
  after.records.reverse();
  for (const record of after.records) record.status = 4;
  const validated = validateVocabularySnapshotV2(after);
  assert.equal(validated.records.length, 2);
  assert.equal(JSON.parse(serializeVocabularySnapshotV2(validated)).records[0].key, "walk");

  const changes = ["walk", "walked"].map((entityId) => ({
    entityId,
    field: "status",
    fieldPath: ["records", entityId, "status"],
    beforeExists: true,
    before: 2,
    afterExists: true,
    after: 4,
  }));
  const restored = prepareVocabularyRestoreFields(after, changes);
  assert.deepEqual(new Map(restored.snapshot.records.map((record) => [record.key, record.status])), new Map([
    ["walk", 2], ["walked", 2],
  ]));
  assert.equal(restored.revision, after.revision + 1);
  assert.deepEqual(restored.removedFamilyKeys, []);

  assert.throws(() => prepareVocabularyRestoreFields(after, [{
    ...changes[0], fieldPath: ["records", 0, "status"],
  }]), /canonical record key/);
  assert.throws(() => prepareVocabularyRestoreFields(after, [{
    ...changes[0], field: "key", fieldPath: ["records", "walk", "key"], before: "walk",
  }]), /protected field/);
  assert.throws(() => prepareVocabularyRestoreFields(after, [changes[0]]), /inconsistent family statuses/,
    "a partial status restore cannot split one family");

  const unknown = structuredClone(after);
  unknown.records[0].contextState = { note: "must not be dropped" };
  assert.throws(() => validateVocabularySnapshotV2(unknown), (error) => error.code === "vocabulary-corrupt-record");
});

test("entityCreate restore is complete, reports removed families, and requires reference validation", async () => {
  const service = makeService(new MemoryAdapter());
  await service.upsertTerm("harbor", { status: 3, note: "port" });
  const snapshot = JSON.parse(await service.exportJson());
  const record = snapshot.records[0];
  const changes = Object.entries(record).map(([field, after]) => ({
    storeId: "vocabulary-core",
    path: VOCABULARY_PATH,
    entityId: record.key,
    field,
    fieldPath: ["records", record.key, field],
    beforeExists: false,
    afterExists: true,
    after,
    kind: "entityCreate",
  }));
  const batch = { entities: [{ storeId: "vocabulary-core", entityId: record.key, kind: "entityCreate" }] };
  const prepared = prepareVocabularyRestoreFields(snapshot, changes, { entities: batch.entities });
  assert.equal(prepared.snapshot.records.length, 0);
  assert.deepEqual(prepared.removedFamilyKeys, [record.familyKey]);

  const current = { exists: true, value: snapshot, revision: snapshot.revision, hash: hashText(await service.exportJson()) };
  const snapshots = new Map([[VOCABULARY_PATH, current]]);
  const seen = [];
  const referencePreconditions = [
    { storeId: "vocabulary-contexts-v1", path: "00_Archive/21_VocabularyData/contexts/manifest.json", expectedRevision: 0, expectedHash: null },
    { storeId: "vocabulary-contexts-v1", path: "00_Archive/21_VocabularyData/contexts/ab12.json", expectedRevision: 3, expectedHash: `sha256-v1:${"a".repeat(64)}` },
    { storeId: "vocabulary-review-v1", path: "00_Archive/21_VocabularyData/review/states/manifest.json", expectedRevision: 0, expectedHash: null },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const handler = createVocabularyHistoryHandler({
    path: VOCABULARY_PATH,
    storeId: "vocabulary-core",
    validateReferences: async (candidate, { removedFamilyKeys }) => {
      seen.push({ candidate, removedFamilyKeys });
      return { ok: true, preconditions: referencePreconditions };
    },
  });
  const plan = await handler.planRestore({ batch, selectedChanges: changes, snapshots });
  assert.deepEqual(seen[0].removedFamilyKeys, [record.familyKey]);
  assert.equal(JSON.parse(plan.writes[0].text).records.length, 0);
  assert.deepEqual(plan.removedFamilyKeys, [record.familyKey]);
  assert.deepEqual(plan.preconditions, referencePreconditions,
    "Context and Review snapshots checked by the validator travel with the core deletion plan");

  const missingValidator = createVocabularyHistoryHandler({ path: VOCABULARY_PATH, storeId: "vocabulary-core" });
  await assert.rejects(missingValidator.planRestore({ batch, selectedChanges: changes, snapshots }),
    (error) => error.code === "vocabulary-history-reference-validator-required");
  const blocked = createVocabularyHistoryHandler({
    path: VOCABULARY_PATH,
    storeId: "vocabulary-core",
    validateReferences: async () => { throw new Error("family is referenced"); },
  });
  await assert.rejects(blocked.planRestore({ batch, selectedChanges: changes, snapshots }), /family is referenced/);
  const missingEvidence = createVocabularyHistoryHandler({
    path: VOCABULARY_PATH,
    storeId: "vocabulary-core",
    validateReferences: async () => ({ ok: true, preconditions: [] }),
  });
  await assert.rejects(missingEvidence.planRestore({ batch, selectedChanges: changes, snapshots }),
    (error) => error.code === "vocabulary-history-reference-evidence-invalid");
  const legacyApproved = createVocabularyHistoryHandler({
    path: VOCABULARY_PATH,
    storeId: "vocabulary-core",
    validateReferences: async () => true,
  });
  const legacyPlan = await legacyApproved.planRestore({ batch, selectedChanges: changes, snapshots });
  assert.deepEqual(legacyPlan.preconditions, [], "legacy boolean approval remains compatible");
  await assert.rejects(handler.planRestore({ batch, selectedChanges: changes.slice(0, -1), snapshots }),
    (error) => error.code === "vocabulary-history-entity-group");
});

test("optional transaction injection writes canonical v2 and durable field/entity history", async () => {
  const adapter = new VocabularyMemoryAdapter();
  let id = 0;
  const coordinator = new VocabularyTransactionCoordinator({
    adapter,
    deviceId: "device-test",
    sessionId: "session-test",
    makeId: () => `tx-${++id}`,
    now: () => 5000,
  });
  const history = new VocabularyHistory({ coordinator, makeId: () => `history-${++id}` });
  const removedFamilies = [];
  const service = makeService(adapter, {
    coordinator,
    validateReferences: async (_candidate, { removedFamilyKeys }) => {
      removedFamilies.push(...removedFamilyKeys);
      return true;
    },
  });
  assert.ok(history);
  await service.upsertTerm("walk", { status: 2, note: "first" });
  await service.setNote("walk", "edited");

  const canonicalText = adapter.files.get(VOCABULARY_PATH);
  assert.equal(canonicalText, serializeVocabularySnapshotV2(JSON.parse(canonicalText)));
  const historyPaths = [...adapter.files.keys()].filter((path) => path.startsWith(`${coordinator.root}/history/${coordinator.deviceId}/`));
  assert.equal(historyPaths.length, 2, "entity creation and its later field edit each have one durable history batch");
  const batches = historyPaths.map((path) => JSON.parse(adapter.files.get(path)));
  const creation = batches.find((batch) => batch.entities.some((entity) => entity.kind === "entityCreate"));
  assert.ok(creation);
  assert.equal(creation.schemaVersion, 2);
  assert.equal(creation.changes.length, 1, "a new core record is stored as one compact lifecycle diff");
  assert.equal(creation.changes[0].kind, "entityCreate");
  assert.deepEqual(creation.changes[0].fieldPath, ["records", "walk"]);
  assert.equal(creation.changes[0].after.key, "walk");
  assert.equal(creation.changes[0].after.note, "first");
  const noteEdit = batches.find((batch) => batch.changes.some((change) => change.field === "note" && change.after === "edited"));
  assert.ok(noteEdit);
  assert.ok(noteEdit.changes.some((change) => change.fieldPath.join("/") === "records/walk/note"));
  assert.equal(JSON.parse(canonicalText).records[0].note, "edited");

  await history.restore(noteEdit.batchId);
  await service.reload();
  assert.equal((await service.getTerm("walk")).note, "first");
  await history.restore(creation.batchId);
  await service.reload();
  assert.equal(await service.getTerm("walk"), undefined);
  assert.deepEqual(removedFamilies, [vocabularyFamilyKeyForKey("walk")],
    "last-family deletion is validated against Context/Review references before writing");

  const inverseLifecycle = (await history.listBatches()).find((batch) =>
    batch.entities.some((entity) => entity.entityId === "walk" && entity.kind === "entityDelete"));
  assert.ok(inverseLifecycle, "restoring a create records an explicit inverse delete lifecycle");
  await history.restore(inverseLifecycle.batchId);
  await service.reload();
  assert.equal((await service.getTerm("walk")).note, "first", "the lifecycle inverse can recreate the complete record");
});

test("an existing service can attach one coordinator once, while v1 migration stays on its verified writer", async () => {
  const adapter = new VocabularyMemoryAdapter();
  let id = 0;
  const service = makeService(adapter);
  await service.upsertTerm("walk", { note: "before lazy runtime" });
  const coordinator = new VocabularyTransactionCoordinator({
    adapter,
    deviceId: "device-lazy",
    sessionId: "session-lazy",
    makeId: () => `lazy-${++id}`,
  });
  new VocabularyHistory({ coordinator, makeId: () => `lazy-history-${++id}` });
  assert.equal(await service.attachCoordinator(coordinator), service);
  assert.equal(await service.attachCoordinator(coordinator), service, "same coordinator attachment is idempotent");
  const replacement = new VocabularyTransactionCoordinator({
    adapter,
    deviceId: "device-lazy",
    sessionId: "replacement",
    makeId: () => `replacement-${++id}`,
  });
  await assert.rejects(service.attachCoordinator(replacement),
    (error) => error.code === "vocabulary-coordinator-already-attached");
  await service.setNote("walk", "after lazy runtime");
  assert.equal(JSON.parse(adapter.files.get(VOCABULARY_PATH)).records[0].note, "after lazy runtime");

  const legacyAdapter = new MemoryAdapter();
  legacyAdapter.files.set(VOCABULARY_PATH, legacySnapshot([legacyRecord("walk")], 4));
  let coordinatorWrites = 0;
  const migrationCoordinator = {
    adapter: legacyAdapter,
    root: "00_Archive/21_VocabularyData",
    async readSnapshot() { throw new Error("v1 migration must not enter the transaction writer"); },
    async commit() { coordinatorWrites += 1; throw new Error("unexpected coordinator write"); },
  };
  const migrating = makeService(legacyAdapter, { coordinator: migrationCoordinator });
  assert.equal((await migrating.migrate()).revision, 5);
  assert.equal(coordinatorWrites, 0);
});

test("dispose marks a service closed even when flush rejects", async () => {
  const adapter = new MemoryAdapter();
  adapter.files.set(VOCABULARY_PATH, legacySnapshot([legacyRecord("walk")], 4));
  const service = makeService(adapter);
  await service.ready();
  await assert.rejects(service.dispose(), (error) => error.code === "vocabulary-migration-required");
  await assert.rejects(service.getTerm("walk"), (error) => error.code === "vocabulary-disposed");
});

test("the historical v1 VocabularyService refuses a v2 file before attempting any write", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  await service.upsertTerm("walk", { status: 3 });
  const v2Bytes = adapter.files.get(VOCABULARY_PATH);
  const writesBefore = adapter.writeCount;

  const historicalService = new legacyReader.VocabularyService({ adapter, path: VOCABULARY_PATH });
  await assert.rejects(historicalService.load(),
    (error) => error.code === "vocabulary-corrupt-schema");
  await assert.rejects(historicalService.upsertTerm("walk", { status: 4 }),
    (error) => error.code === "vocabulary-corrupt-schema");
  assert.equal(adapter.files.get(VOCABULARY_PATH), v2Bytes);
  assert.equal(adapter.writeCount, writesBefore, "the historical service fails before its write path");
  assert.equal(VOCABULARY_SCHEMA_VERSION, 2);
});

test("JSON import validates known versioned snapshots and rejects unknown newer envelopes", async () => {
  const adapter = new MemoryAdapter();
  const source = makeService(adapter);
  await source.upsertTerm("walk", { status: 2, note: "known v2 snapshot" });
  const validV2 = JSON.parse(await source.exportJson());

  const target = makeService(new MemoryAdapter());
  const imported = await target.importJson(validV2);
  assert.equal(imported.imported, 1);
  assert.equal((await target.getTerm("walk")).note, "known v2 snapshot");

  const invalidEnvelope = structuredClone(validV2);
  invalidEnvelope.reviewIndex = { revision: 1 };
  await assert.rejects(target.importJson(invalidEnvelope), (error) => error.code === "vocabulary-corrupt-schema");

  const invalidRecord = structuredClone(validV2);
  invalidRecord.records[0].contextState = { anchor: "undeclared" };
  await assert.rejects(target.importJson(invalidRecord), (error) => error.code === "vocabulary-corrupt-record");

  const unknownNewer = { ...structuredClone(validV2), schemaVersion: 3, records: validV2.records };
  await assert.rejects(target.importJson(unknownNewer), (error) => error.code === "vocabulary-corrupt-schema");
  assert.equal((await target.getTerm("walk")).note, "known v2 snapshot", "rejected imports leave the valid target unchanged");
});

test("JSON import retains raw-array and known historical v1 snapshot compatibility", async () => {
  const service = makeService(new MemoryAdapter());
  const raw = await service.importJson([{ surface: "walk", type: "word", status: 2 }]);
  assert.equal(raw.imported, 1);

  const historical = {
    schema: "pdf-web-reader-vocabulary",
    schemaVersion: 1,
    language: "en",
    revision: 7,
    reviewIndex: { legacy: true },
    records: [legacyRecord("run", { ipa: "/rʌn/", reviewState: { ignored: true } })],
  };
  const imported = await service.importJson(historical);
  assert.equal(imported.imported, 1);
  const record = await service.getTerm("run");
  assert.equal(record.phonetic, "/rʌn/");
  assert.equal("reviewState" in record, false);
});

test("a vocabulary import that would exceed store capacity fails atomically without truncating rows", async () => {
  const adapter = new MemoryAdapter();
  const service = makeService(adapter);
  const base = Array.from({ length: 24999 }, (_, index) => ({
    surface: `term${String(index).padStart(5, "0")}`,
    type: "word",
    status: 2,
    translation: "existing",
  }));
  const seeded = await service.importJson(base);
  assert.equal(seeded.imported, 24999);

  const filesBefore = new Map(adapter.files);
  const writesBefore = adapter.writeCount;
  await assert.rejects(service.importJson([
    { surface: "new-capacity-one", type: "word", status: 2 },
    { surface: "new-capacity-two", type: "word", status: 2 },
  ]), /would exceed the supported record limit/);
  assert.deepEqual([...adapter.files], [...filesBefore], "the failed import leaves every canonical file byte-identical");
  assert.equal(adapter.writeCount, writesBefore);
  assert.equal((await service.queryLearningTerms({ limit: 30000 })).length, 24999);
  assert.equal(await service.getTerm("new-capacity-one"), undefined);

  const fits = await service.importJson([{ surface: "new-capacity-one", type: "word", status: 2 }]);
  assert.equal(fits.imported, 1, "exactly the remaining capacity is accepted");
  assert.equal((await service.queryLearningTerms({ limit: 30000 })).length, 25000);
  const fullFiles = new Map(adapter.files);
  const fullWrites = adapter.writeCount;
  await assert.rejects(service.importJson([
    { surface: "new-capacity-two", type: "word", status: 2 },
    { surface: "new-capacity-three", type: "word", status: 2 },
  ]), /would exceed the supported record limit/);
  assert.deepEqual([...adapter.files], [...fullFiles]);
  assert.equal(adapter.writeCount, fullWrites);
});
