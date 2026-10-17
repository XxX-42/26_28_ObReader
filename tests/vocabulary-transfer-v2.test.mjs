import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { VocabularyService, VOCABULARY_PATH, serializeVocabularySnapshotV2 } = require("../plugin/vocabulary/service.cjs");
const { createVocabularyRuntime } = require("../plugin/vocabulary/runtime.cjs");
const { createVocabularyTransfer, BUNDLE_KIND } = require("../plugin/vocabulary/transfer.cjs");
const { canonicalHash } = require("../plugin/vocabulary/canonical.cjs");
const { CONTEXT_ROOT } = require("../plugin/vocabulary/context-service.cjs");
const { REVIEW_ROOT } = require("../plugin/vocabulary/review-service.cjs");
const { createShardedStore } = require("../plugin/vocabulary/sharded-store.cjs");

function fixture(adapter = new VocabularyMemoryAdapter(), prefix = "transfer") {
  let sequence = 0;
  let verifySourceCalls = 0;
  const personalService = new VocabularyService({ adapter, now: () => 1_800_000_000_000 });
  const timers = new Map();
  const runtime = createVocabularyRuntime({
    adapter,
    personalService,
    deviceId: "bundle-test-device",
    sessionId: `${prefix}-plugin-session`,
    now: () => 1_800_000_000_000,
    makeId: () => `${prefix}-id-${++sequence}`,
    verifySource: async ({ anchor }) => {
      verifySourceCalls += 1;
      return { status: "verified", sourceCurrent: true, pageCurrent: true, anchor };
    },
    setTimeout: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  return { adapter, personalService, runtime, timers, get verifySourceCalls() { return verifySourceCalls; } };
}

function selectionAnchor() {
  const hash = `sha256-v1:${"a".repeat(64)}`;
  return {
    schemaVersion: 1,
    kind: "obreader-selection-anchor",
    anchorId: "bundle-anchor-0001",
    docKey: "0123456789ab",
    documentId: "vault://stories/example.pdf",
    sourceHash: hash,
    pageIdentity: "page-identity-1",
    pageIndexHint: 0,
    textPosition: { start: 3, end: 7 },
    exactQuote: "walk",
    prefix: "We ",
    suffix: " home.",
    orderedPageIdentityDigest: hash,
    pageCount: 1,
    geometry: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
  };
}

async function populatedFixture(prefix = "source") {
  const value = fixture(new VocabularyMemoryAdapter(), prefix);
  await value.runtime.mutatePersonal((service) => service.upsertTerm("walk", {
    status: 2, translation: "步行", note: "preserve provenance",
  }));
  const family = await value.personalService.getFamily("walking");
  await value.runtime.saveContext({ familyKey: family.familyKey, surface: "walk", sentence: "We walk home.", anchor: selectionAnchor() });
  const review = await value.runtime.ensureReviewSession();
  await review.enroll(family.familyKey, { actionId: `${prefix}-enroll` });
  await review.remember(family.familyKey, { actionId: `${prefix}-remember` });
  await review.close();
  return { ...value, familyKey: family.familyKey };
}

function resignBundle(bundle) {
  bundle.integrity = { algorithm: "sha256-v1", hash: canonicalHash({
    kind: bundle.kind,
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    stores: bundle.stores,
  }) };
  return bundle;
}

function reviewStore(runtime) {
  return createShardedStore({
    transaction: runtime.coordinator,
    storeId: "vocabulary-review-v1",
    root: REVIEW_ROOT,
    kind: "review-state",
    idOf: (record) => record?.familyKey,
  });
}

test("logical bundle exports and restores exact core, Context provenance, and canonical Review state", async () => {
  const source = await populatedFixture();
  const sourceContext = (await source.runtime.contexts.load()).records[0];
  const bundleText = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  const bundle = JSON.parse(bundleText);

  assert.equal(bundle.kind, BUNDLE_KIND);
  assert.deepEqual(Object.keys(bundle).sort(), ["exportedAt", "integrity", "kind", "schemaVersion", "stores"]);
  assert.deepEqual(Object.keys(bundle.stores).sort(), ["contexts", "core", "review"]);
  assert.equal(bundle.stores.core.records[0].createdAt, JSON.parse(await source.personalService.exportJson()).records[0].createdAt);
  assert.equal(bundle.stores.contexts.records[0].contextId, sourceContext.contextId);
  assert.deepEqual(bundle.stores.contexts.records[0].identity, sourceContext.identity);
  assert.deepEqual(bundle.stores.contexts.records[0].anchor, sourceContext.anchor);
  assert.equal(bundle.stores.review.records[0].familyKey, source.familyKey);
  assert.equal(Object.hasOwn(bundle, "history"), false);
  assert.equal(Object.hasOwn(bundle, "journal"), false);

  const target = fixture(new VocabularyMemoryAdapter(), "target");
  const transfer = createVocabularyTransfer({ runtime: target.runtime });
  const uiPolicy = { defaultStatus: 1, overwriteExisting: false, overwriteKnown: false };
  const preview = await transfer.previewImportBundle(bundleText, uiPolicy);
  assert.equal(preview.status, "ready");
  assert.equal(preview.imported, 1);
  assert.equal(preview.stores.contexts.imported, 1);
  assert.equal(preview.stores.review.imported, 1);
  assert.equal(target.adapter.files.size, 0, "preview is read-only");

  const result = await transfer.importBundle(bundleText, uiPolicy);
  assert.equal(result.status, "committed");
  assert.equal(result.imported, 1);
  assert.equal((await target.personalService.getTerm("walk")).translation, "步行");
  const restoredContext = (await target.runtime.contexts.load()).records[0];
  assert.deepEqual(restoredContext.anchor, sourceContext.anchor, "import preserves saved anchor geometry and source evidence");
  assert.deepEqual(restoredContext.identity, sourceContext.identity, "import preserves the original verified identity tuple");
  assert.equal(target.verifySourceCalls, 0, "import does not query the current PDF or guess a new anchor");
  const review = await reviewStore(target.runtime).load();
  assert.equal(review.records.length, 1);
  assert.equal(review.records[0].familyKey, source.familyKey);
  const importedBatches = await target.runtime.history.listBatches();
  assert.equal(importedBatches.length, 1, "the whole import is one local History batch; source History is not imported");
  const batch = importedBatches[0];
  assert.equal(batch.actionKind, "bundle-import");
  assert.deepEqual(new Set(batch.entities.map((entity) => entity.storeId)),
    new Set(["vocabulary-core", "vocabulary-contexts-v1", "vocabulary-review-v1"]));
  const assertEntityCreateDiff = (storeId, entityId, record, fieldNames = Object.keys(record)) => {
    const entity = batch.entities.find((item) => item.storeId === storeId && item.entityId === entityId);
    assert.deepEqual(entity, { storeId, entityId, kind: "entityCreate" });
    const changes = batch.changes.filter((change) => change.storeId === storeId && change.entityId === entityId);
    if (storeId === "vocabulary-core") {
      assert.equal(changes.length, 1, "a new core record is one complete, reversible lifecycle change");
      assert.equal(changes[0].kind, "entityCreate");
      assert.equal(changes[0].beforeExists, false);
      assert.equal(changes[0].afterExists, true);
      assert.deepEqual(changes[0].after, record);
      assert.deepEqual(changes[0].fieldPath, ["records", entityId]);
      assert.ok(batch.stores.some((store) => store.storeId === storeId && store.path === changes[0].path));
      return;
    }
    assert.deepEqual(new Set(changes.map((change) => change.field)), new Set(fieldNames));
    for (const change of changes) {
      assert.equal(change.kind, "entityCreate");
      assert.equal(change.beforeExists, false);
      assert.equal(change.afterExists, true);
      assert.deepEqual(change.after, record[change.field]);
      assert.deepEqual(change.fieldPath, ["records", entityId, change.field]);
      assert.ok(batch.stores.some((store) => store.storeId === storeId && store.path === change.path));
    }
  };
  assertEntityCreateDiff("vocabulary-core", bundle.stores.core.records[0].key, bundle.stores.core.records[0]);
  assertEntityCreateDiff("vocabulary-contexts-v1", sourceContext.contextId, bundle.stores.contexts.records[0]);
  assertEntityCreateDiff("vocabulary-review-v1", source.familyKey, bundle.stores.review.records[0], [
    "enrolled", "box", "dueAt", "enrolledAt", "lastReviewedAt", "reviewCount", "lapseCount", "updatedAt",
  ]);
  for (const path of [`${CONTEXT_ROOT}/manifest.json`, `${REVIEW_ROOT}/manifest.json`]) {
    assert.ok(batch.stores.some((store) => store.path === path), `History includes the transaction's canonical manifest write at ${path}`);
  }
  for (const store of batch.stores) {
    const snapshot = await target.runtime.coordinator.readSnapshot(store.path);
    assert.equal(snapshot.revision, store.resultRevision);
    assert.equal(snapshot.hash, store.resultHash);
    assert.ok(store.resultRevision > store.baseRevision);
    assert.equal(store.baseRevision === 0, store.baseHash === null);
  }
  const previewRestore = await target.runtime.history.previewRestore(batch.batchId);
  assert.ok(previewRestore.items.length > 0);
  assert.ok(previewRestore.items.every((item) => item.status === "clean"));

  const repeated = await transfer.importBundle(bundleText, uiPolicy);
  assert.equal(repeated.status, "unchanged");
  assert.equal((await target.runtime.history.listBatches()).length, 1,
    "a no-op repeat does not create a second permanent History batch");

  await source.runtime.close();
  await target.runtime.close();
});

test("bundle parser rejects unknown fields, invalid nested stores, and modified integrity", async () => {
  const source = await populatedFixture("strict");
  const transfer = createVocabularyTransfer({ runtime: fixture().runtime });
  const original = JSON.parse(await createVocabularyTransfer({ runtime: source.runtime }).exportBundle());

  const extraEnvelope = structuredClone(original);
  extraEnvelope.unlistedStore = {};
  resignBundle(extraEnvelope);
  await assert.rejects(transfer.previewImportBundle(extraEnvelope), (error) => error.code === "VOCAB_BUNDLE_SCHEMA_UNKNOWN");

  const extraContextField = structuredClone(original);
  extraContextField.stores.contexts.records[0].guessedPageText = "must not be accepted";
  extraContextField.stores.contexts.contentHash = canonicalHash({
    schemaVersion: 1,
    revision: extraContextField.stores.contexts.revision,
    records: extraContextField.stores.contexts.records,
  });
  resignBundle(extraContextField);
  await assert.rejects(transfer.previewImportBundle(extraContextField), (error) => error.code === "VOCAB_BUNDLE_CONTEXT_SCHEMA");

  const changed = structuredClone(original);
  changed.stores.core.records[0].note = "tampered";
  await assert.rejects(transfer.previewImportBundle(changed), (error) => error.code === "VOCAB_BUNDLE_INTEGRITY_MISMATCH");
  await source.runtime.close();
});

test("object bundle imports use the integrity-checked snapshot even if the caller mutates its input", async () => {
  const source = await populatedFixture("object-race-source");
  const target = fixture(new VocabularyMemoryAdapter(), "object-race-target");
  const bundle = JSON.parse(await createVocabularyTransfer({ runtime: source.runtime }).exportBundle());
  const expectedSentence = bundle.stores.contexts.records[0].sentence;
  const transfer = createVocabularyTransfer({ runtime: target.runtime });
  const pending = transfer.importBundle(bundle);
  bundle.stores.contexts.records[0].sentence = "mutated after validation";
  bundle.stores.review.records[0].box = 5;
  const result = await pending;

  assert.equal(result.status, "committed");
  assert.equal((await target.runtime.contexts.load()).records[0].sentence, expectedSentence);
  const review = await reviewStore(target.runtime).load();
  assert.equal(review.records[0].box, 2, "the post-validation caller mutation is not installed");
  await source.runtime.close();
  await target.runtime.close();
});

test("export refuses to claim a complete bundle when store identity changes between reads", async () => {
  const source = await populatedFixture("racing-export");
  const transfer = createVocabularyTransfer({ runtime: source.runtime });
  const readSnapshot = source.runtime.coordinator.readSnapshot.bind(source.runtime.coordinator);
  let replaced = false;
  source.runtime.coordinator.readSnapshot = async (path) => {
    const snapshot = await readSnapshot(path);
    if (!replaced && path === `${CONTEXT_ROOT}/manifest.json`) {
      replaced = true;
      const current = JSON.parse(source.adapter.files.get(VOCABULARY_PATH));
      current.revision += 1;
      current.records[0].note = "external replacement";
      source.adapter.files.set(VOCABULARY_PATH, serializeVocabularySnapshotV2(current));
    }
    return snapshot;
  };
  await assert.rejects(transfer.exportBundle(), (error) => error.code === "VOCAB_BUNDLE_STORE_CHANGED");
  assert.equal(replaced, true);
  await source.runtime.close().catch(() => undefined);
});

test("export rejects acknowledged Review actions until their canonical checkpoint is flushed", async () => {
  const source = fixture(new VocabularyMemoryAdapter(), "unflushed-export");
  await source.runtime.mutatePersonal((service) => service.upsertTerm("walk", { status: 2 }));
  const family = await source.personalService.getFamily("walk");
  const review = await source.runtime.ensureReviewSession();
  await review.enroll(family.familyKey, { actionId: "unflushed-enroll" });
  const transfer = createVocabularyTransfer({ runtime: source.runtime });

  await assert.rejects(transfer.exportBundle(), (error) => error.code === "VOCAB_BUNDLE_REVIEW_UNFLUSHED");
  await review.flush();
  const bundle = JSON.parse(await transfer.exportBundle());
  assert.equal(bundle.stores.review.records.length, 1);
  assert.equal(bundle.stores.review.records[0].familyKey, family.familyKey);

  await source.runtime.close();
});

test("multi-store import conflicts before installing any Context or Review files", async () => {
  const source = await populatedFixture("conflict-source");
  const bundleText = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  const target = fixture(new VocabularyMemoryAdapter(), "conflict-target");
  await target.runtime.ready();
  const commit = target.runtime.coordinator.commit.bind(target.runtime.coordinator);
  let raced = false;
  target.runtime.coordinator.commit = async (input) => {
    if (!raced) {
      raced = true;
      target.adapter.files.set(VOCABULARY_PATH, serializeVocabularySnapshotV2({
        schema: "pdf-web-reader-vocabulary", schemaVersion: 2, language: "en", revision: 1, records: [],
      }));
    }
    return commit(input);
  };

  const result = await createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundleText);
  assert.equal(raced, true);
  assert.equal(result.status, "conflict");
  assert.equal(result.commit.status, "conflict");
  assert.equal(target.adapter.files.has(`${CONTEXT_ROOT}/manifest.json`), false);
  assert.equal(target.adapter.files.has(`${REVIEW_ROOT}/manifest.json`), false);
  assert.equal(JSON.parse(target.adapter.files.get(VOCABULARY_PATH)).records.length, 0,
    "the concurrent external core replacement remains untouched");

  await source.runtime.close();
  await target.runtime.close();
});

test("bundle merge preserves existing data and Known families unless the caller explicitly overrides them", async () => {
  const source = await populatedFixture("known-source");
  const bundleText = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  const target = fixture(new VocabularyMemoryAdapter(), "known-target");
  await target.runtime.mutatePersonal((service) => service.upsertTerm("walk", { status: 5, note: "local Known note" }));
  const transfer = createVocabularyTransfer({ runtime: target.runtime });

  const preserved = await transfer.importBundle(bundleText);
  assert.equal(preserved.status, "committed");
  assert.equal(preserved.skippedKnown, 1);
  assert.equal((await target.personalService.getTerm("walk")).status, 5);
  assert.equal((await target.personalService.getTerm("walk")).note, "local Known note");
  assert.equal((await target.runtime.contexts.load()).records.length, 1);
  assert.equal((await reviewStore(target.runtime).load()).records.length, 1);

  const explicitlyOverwritten = await transfer.importBundle(bundleText, { overwriteKnown: true });
  assert.equal(explicitlyOverwritten.status, "committed");
  assert.equal((await target.personalService.getTerm("walk")).status, 2);
  assert.equal((await target.personalService.getTerm("walk")).note, "preserve provenance");

  await source.runtime.close();
  await target.runtime.close();
});

test("bundle overwrite records field-level before/after diffs for core, Context, and Review", async () => {
  const source = await populatedFixture("history-update-source");
  const sourceContext = (await source.runtime.contexts.load()).records[0];
  const bundleText = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  const target = fixture(new VocabularyMemoryAdapter(), "history-update-target");
  await target.runtime.mutatePersonal((service) => service.upsertTerm("walk", {
    status: 3, translation: "本地释义", note: "local note",
  }));
  const targetFamily = await target.personalService.getFamily("walk");
  const targetContext = await target.runtime.saveContext({
    familyKey: targetFamily.familyKey, surface: "walk", sentence: "I walk alone.", anchor: selectionAnchor(),
  });
  const targetReview = await target.runtime.ensureReviewSession();
  await targetReview.enroll(targetFamily.familyKey, { actionId: "target-enroll" });
  await targetReview.close();
  const beforeCore = JSON.parse(await target.personalService.exportJson()).records[0];
  const beforeReview = (await reviewStore(target.runtime).load()).records[0];

  const result = await createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundleText, { overwriteExisting: true });
  assert.equal(result.status, "committed");
  assert.equal((await target.runtime.contexts.getContext(targetContext.context.contextId)).sentence, sourceContext.sentence);
  assert.equal((await reviewStore(target.runtime).load()).records[0].box, 2);

  const batches = await target.runtime.history.listBatches();
  const batch = batches.find((item) => item.actionKind === "bundle-import");
  assert.ok(batch);
  assert.deepEqual(new Set(batch.entities.map((entity) => entity.storeId)),
    new Set(["vocabulary-core", "vocabulary-contexts-v1", "vocabulary-review-v1"]));
  const changesFor = (storeId, entityId) => batch.changes.filter((change) => change.storeId === storeId && change.entityId === entityId);
  const coreChanges = changesFor("vocabulary-core", "walk");
  assert.ok(coreChanges.some((change) => change.field === "note" && change.before === beforeCore.note && change.after === "preserve provenance"));
  assert.ok(coreChanges.every((change) => change.kind === "field" && change.beforeExists && change.afterExists));
  const contextChanges = changesFor("vocabulary-contexts-v1", targetContext.context.contextId);
  assert.deepEqual(contextChanges.map((change) => change.field), ["sentence"]);
  assert.equal(contextChanges[0].before, "I walk alone.");
  assert.equal(contextChanges[0].after, sourceContext.sentence);
  const reviewChanges = changesFor("vocabulary-review-v1", source.familyKey);
  assert.ok(reviewChanges.some((change) => change.field === "box" && change.before === beforeReview.box && change.after === 2));
  assert.ok(reviewChanges.every((change) => change.kind === "field" && change.beforeExists && change.afterExists));
  assert.ok(batch.stores.some((store) => store.path === contextChanges[0].path && store.storeId === contextChanges[0].storeId));
  assert.ok(batch.stores.some((store) => store.path === reviewChanges[0].path && store.storeId === reviewChanges[0].storeId));
  const preview = await target.runtime.history.previewRestore(batch.batchId);
  assert.ok(preview.items.every((item) => item.status === "clean"));

  await source.runtime.close();
  await target.runtime.close();
});

test("bundle import accepts the shared defaultStatus policy but rejects broad unknown overwrite policies", async () => {
  const source = await populatedFixture("policy-source");
  const bundleText = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  const target = fixture(new VocabularyMemoryAdapter(), "policy-target");
  const transfer = createVocabularyTransfer({ runtime: target.runtime });

  const preview = await transfer.previewImportBundle(bundleText, { defaultStatus: 1 });
  assert.equal(preview.status, "ready");
  assert.equal(preview.imported, 1);
  await assert.rejects(
    transfer.importBundle(bundleText, { overwriteAll: true }),
    (error) => error.code === "VOCAB_BUNDLE_POLICY_INVALID",
  );
  assert.equal(target.adapter.files.size, 0, "an unsupported broad overwrite policy cannot mutate any store");

  await source.runtime.close();
  await target.runtime.close();
});
