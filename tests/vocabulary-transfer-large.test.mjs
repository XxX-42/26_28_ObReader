import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";
const require = createRequire(import.meta.url);
const { VocabularyService } = require("../plugin/vocabulary/service.cjs");
const { createVocabularyRuntime } = require("../plugin/vocabulary/runtime.cjs");
const { createVocabularyTransfer } = require("../plugin/vocabulary/transfer.cjs");

function fixture(prefix) {
  const adapter = new VocabularyMemoryAdapter();
  const personalService = new VocabularyService({ adapter, now: () => 1800000000000 });
  let counter = 0;
  const runtime = createVocabularyRuntime({ adapter, personalService, deviceId: "large-transfer-device",
    sessionId: `${prefix}-session`, makeId: () => `${prefix}-${++counter}` });
  return { adapter, personalService, runtime };
}

test("25,000-record bundle export, preview, and transactional import preserve every record", async () => {
  const startedAt = performance.now();
  const source = fixture("source"), target = fixture("target");
  let stageStartedAt = performance.now();
  const imported = await source.personalService.importJson(Array.from({ length: 25000 }, (_, index) => ({
    surface: `term${String(index).padStart(5, "0")}`, type: "word", status: 2, translation: "保留全部记录",
  })));
  const sourceImportMs = performance.now() - stageStartedAt;
  assert.equal(imported.imported, 25000);
  await source.runtime.ready();
  await target.runtime.ready();
  stageStartedAt = performance.now();
  const bundle = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  const exportMs = performance.now() - stageStartedAt;
  stageStartedAt = performance.now();
  const preview = await createVocabularyTransfer({ runtime: target.runtime }).previewImportBundle(bundle);
  const previewMs = performance.now() - stageStartedAt;
  assert.equal(preview.imported, 25000);
  assert.equal(preview.invalid, 0);
  assert.equal(target.adapter.files.size, 0, "preview is read-only despite its large field diff");
  assert.equal(JSON.parse(bundle).stores.core.records.length, 25000);
  const bundleBytes = new TextEncoder().encode(bundle).byteLength;
  stageStartedAt = performance.now();
  const importedBundle = await createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundle);
  const importMs = performance.now() - stageStartedAt;
  assert.equal(importedBundle.imported, 25000);
  assert.equal(importedBundle.status, "committed");
  stageStartedAt = performance.now();
  assert.equal((await target.personalService.queryLearningTerms({ limit: 30000 })).length, 25000);
  assert.equal(JSON.parse(await target.personalService.exportJson()).records.length, 25000);
  const verifyMs = performance.now() - stageStartedAt;
  const historyEntry = [...target.adapter.files].find(([path]) => path.includes("/history/"));
  assert.ok(historyEntry, "the transactional bundle import persists a History batch");
  const batch = JSON.parse(historyEntry[1]);
  assert.equal(batch.schemaVersion, 3, "new History records use the compact-capable schema");
  assert.equal(batch.changes.encoding, "record-root-lifecycle-v1",
    "large entity lifecycle batches use compact on-disk encoding");
  const coreGroup = batch.changes.groups.find((group) => group.storeId === "vocabulary-core");
  assert.ok(coreGroup, "compact History retains the core vocabulary lifecycle group");
  assert.equal(coreGroup.kind, "entityCreate");
  assert.equal(coreGroup.records.length, 25000,
    "compact History retains one reversible creation payload per imported record");
  const expandedBatch = await target.runtime.history.readBatch(batch.batchId);
  const coreChanges = expandedBatch.changes.filter((change) => change.storeId === "vocabulary-core");
  assert.equal(coreChanges.length, 25000, "History stores one complete reversible lifecycle change per imported core record");
  assert.ok(coreChanges.every((change) => change.fieldPath.length === 2 && change.kind === "entityCreate"));
  const targetMetrics = target.adapter.measured();
  const historyBytes = [...target.adapter.files]
    .filter(([path]) => path.includes("/history/"))
    .reduce((total, [, text]) => total + new TextEncoder().encode(text).byteLength, 0);
  assert.ok(historyBytes < bundleBytes,
    "compact 25k-create History should be smaller than the complete transfer bundle");
  stageStartedAt = performance.now();
  const historyPreview = await target.runtime.history.previewRestore(batch.batchId);
  const historyPreviewMs = performance.now() - stageStartedAt;
  assert.equal(historyPreview.items.length, 25000);
  assert.ok(historyPreview.items.every((item) => item.status === "clean"));
  const undo = await target.runtime.restore(batch.batchId);
  assert.equal(undo.status, "committed", "compact create History remains fully reversible");
  assert.equal((await target.personalService.queryLearningTerms({ limit: 30000 })).length, 0);
  const inverseEntry = [...target.adapter.files].map(([path, value]) => [path, JSON.parse(value)])
    .find(([, value]) => value.batchId === undo.restoreBatchId);
  assert.ok(inverseEntry);
  assert.equal(inverseEntry[1].changes.encoding, "record-root-lifecycle-v1",
    "the inverse bulk delete also uses compact History encoding");
  assert.equal(inverseEntry[1].changes.groups.find((group) => group.storeId === "vocabulary-core").records.length, 25000);
  const redo = await target.runtime.restore(undo.restoreBatchId);
  assert.equal(redo.status, "committed", "compact inverse History can be restored in the forward direction");
  assert.equal((await target.personalService.queryLearningTerms({ limit: 30000 })).length, 25000);
  console.log(JSON.stringify({ scale: "25000", sourceImportMs, exportMs, previewMs, importMs, verifyMs,
    targetFilesTouched: targetMetrics.filesTouched.length, targetReadBytes: targetMetrics.readBytes,
    targetWrittenBytes: targetMetrics.writtenBytes, targetReads: targetMetrics.reads,
    targetWrites: targetMetrics.writes, targetAppends: targetMetrics.appends,
    targetDirectoryCount: targetMetrics.directoryCount, historyBytes, historyChangeCount: coreChanges.length,
    bundleBytes, historyPreviewMs, historyUndoRedo: true, totalMs: performance.now() - startedAt }));
  await source.runtime.close();
  await target.runtime.close();
});
