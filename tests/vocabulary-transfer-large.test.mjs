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

function compareCompactHistoryEnvelope(batch) {
  const sharedRows = [];
  const sharedIds = new Map();
  const changes = batch.changes.map((change) => {
    const { storeId, kind, fieldPath, ...payload } = change;
    const shared = { storeId, kind, fieldPath };
    const signature = JSON.stringify(shared);
    let sharedId = sharedIds.get(signature);
    if (sharedId === undefined) {
      sharedId = sharedRows.length;
      sharedIds.set(signature, sharedId);
      sharedRows.push(shared);
    }
    return { sharedId, payload };
  });
  const envelope = Object.fromEntries(Object.entries(batch).filter(([key]) => key !== "changes"));
  const compactPrototype = { envelope, sharedRows, changes };
  const reconstructed = {
    ...compactPrototype.envelope,
    changes: compactPrototype.changes.map(({ sharedId, payload }) => ({
      ...compactPrototype.sharedRows[sharedId], ...payload,
    })),
  };
  assert.deepEqual(reconstructed, batch, "the read-only compact prototype must preserve every History field");
  const encoder = new TextEncoder();
  const originalBytes = encoder.encode(JSON.stringify(batch)).byteLength;
  const compactBytes = encoder.encode(JSON.stringify(compactPrototype)).byteLength;
  return { originalJsonBytes: originalBytes, prototypeJsonBytes: compactBytes,
    bytesSaved: originalBytes - compactBytes, sharedTemplateCount: sharedRows.length,
    changeCount: changes.length, fieldsPreserved: true };
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
  target.adapter.resetMetrics();
  stageStartedAt = performance.now();
  const importedBundle = await createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundle);
  const importMs = performance.now() - stageStartedAt;
  const targetImportMetrics = target.adapter.measured();
  assert.equal(importedBundle.imported, 25000);
  assert.equal(importedBundle.status, "committed");
  target.adapter.resetMetrics();
  stageStartedAt = performance.now();
  assert.equal((await target.personalService.queryLearningTerms({ limit: 30000 })).length, 25000);
  assert.equal(JSON.parse(await target.personalService.exportJson()).records.length, 25000);
  const verifyMs = performance.now() - stageStartedAt;
  const historyEntry = [...target.adapter.files].find(([path]) => path.includes("/history/"));
  assert.ok(historyEntry, "the transactional bundle import persists a History batch");
  const batch = JSON.parse(historyEntry[1]);
  const coreChanges = batch.changes.filter((change) => change.storeId === "vocabulary-core");
  assert.equal(coreChanges.length, 25000, "History stores one complete reversible lifecycle change per imported core record");
  assert.ok(coreChanges.every((change) => change.fieldPath.length === 2 && change.kind === "entityCreate"));
  const historyBytes = [...target.adapter.files]
    .filter(([path]) => path.includes("/history/"))
    .reduce((total, [, text]) => total + new TextEncoder().encode(text).byteLength, 0);
  assert.ok(historyBytes < bundleBytes * 2,
    "a 25k-create History batch should remain near record payload size instead of repeating every field envelope");
  const historyPrototype = compareCompactHistoryEnvelope(batch);
  target.adapter.resetMetrics();
  stageStartedAt = performance.now();
  const historyPreview = await target.runtime.history.previewRestore(batch.batchId);
  const historyPreviewMs = performance.now() - stageStartedAt;
  const historyPreviewMetrics = target.adapter.measured();
  assert.equal(historyPreview.items.length, 25000);
  assert.ok(historyPreview.items.every((item) => item.status === "clean"));
  console.log(JSON.stringify({ scale: "25000", sourceImportMs, exportMs, previewMs, importMs, verifyMs,
    targetImportIo: targetImportMetrics, historyPreviewIo: historyPreviewMetrics,
    targetFilesTouched: targetImportMetrics.filesTouched.length, targetReadBytes: targetImportMetrics.readBytes,
    targetWrittenBytes: targetImportMetrics.writtenBytes, targetReads: targetImportMetrics.reads,
    targetWrites: targetImportMetrics.writes, targetAppends: targetImportMetrics.appends,
    targetDirectoryCount: targetImportMetrics.directoryCount, historyBytes, historyChangeCount: coreChanges.length,
    historyPrototype, bundleBytes, historyPreviewMs, totalMs: performance.now() - startedAt }));
  await source.runtime.close();
  await target.runtime.close();
});
