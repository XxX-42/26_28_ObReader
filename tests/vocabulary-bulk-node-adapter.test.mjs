import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTemporaryVocabularyAdapter, BULK_HISTORY_ENCODING_PREFIXES } from "./vocabulary-bulk-node-data-adapter.mjs";
import { VocabularyMemoryAdapter } from "./vocabulary-v2-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { VocabularyService } = require("../plugin/vocabulary/service.cjs");
const { createVocabularyRuntime } = require("../plugin/vocabulary/runtime.cjs");
const { createVocabularyTransfer } = require("../plugin/vocabulary/transfer.cjs");
const { canonicalStringify } = require("../plugin/vocabulary/canonical.cjs");

const DEVICE = "bulk-disk-test-device";
const SESSION = "bulk-disk-test-session";
const FIXED_NOW = 1_800_000_000_000;

function makeRuntime(adapter, sequence = { value: 0 }) {
  const personalService = new VocabularyService({ adapter, now: () => FIXED_NOW });
  const runtime = createVocabularyRuntime({
    adapter,
    personalService,
    deviceId: DEVICE,
    sessionId: SESSION,
    now: () => FIXED_NOW,
    makeId: () => `bulk-disk-${++sequence.value}`,
    verifySource: async ({ anchor }) => ({ status: "verified", sourceCurrent: true, pageCurrent: true, anchor }),
  });
  return { adapter, personalService, runtime, sequence };
}

async function makeBundle(count) {
  const source = makeRuntime(new VocabularyMemoryAdapter(), { value: 0 });
  const imported = await source.personalService.importJson(Array.from({ length: count }, (_, index) => ({
    surface: `diskterm${String(index).padStart(4, "0")}`,
    type: "word",
    status: 2,
    translation: "相同的共享翻译",
    note: "same metadata repeated for the disk adapter experiment",
  })));
  assert.equal(imported.imported, count);
  await source.runtime.ready();
  const bundle = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  await source.runtime.close();
  return bundle;
}

function logicalHistoryText(batch) {
  return canonicalStringify(batch);
}

function transactionIndependentHistory(batch) {
  const changes = batch.changes.map(({ changeId, ...change }) => change);
  return canonicalStringify({ ...batch, batchId: "<batch-id>", transactionId: "<transaction-id>", changes });
}

test("default disk restore selects clean entities and preserves the unselected conflict payload bytes", async (t) => {
  for (const count of [5, 10]) {
    const bundle = await makeBundle(count);
    for (const mode of ["plain", "gzip-history", "shared-history"]) {
      const adapter = await createTemporaryVocabularyAdapter({ mode });
      t.after(() => adapter.dispose());
      const target = makeRuntime(adapter);
      t.after(() => target.runtime.close());
      await target.runtime.ready();
      await createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundle);
      const batch = (await target.runtime.history.listBatches()).find((item) => item.actionKind === "bundle-import");
      await target.runtime.mutatePersonal((service) => service.upsertTerm("diskterm0000", { note: "local conflict survives" }));
      const preview = await target.runtime.history.previewRestore(batch.batchId);
      const conflicts = preview.items.filter((item) => item.status === "conflict");
      assert.equal(conflicts.length, 1);
      assert.equal(preview.items.filter((item) => item.status === "clean").length, count - 1);
      const corePath = conflicts[0].path;
      const before = JSON.parse(await adapter.read(corePath));
      const conflictRecord = before.records.find((record) => record.surface === "diskterm0000");
      assert.equal(conflictRecord.note, "local conflict survives");
      const payloadBytes = Buffer.from(canonicalStringify(conflictRecord));
      const undo = await target.runtime.restore(batch.batchId);
      assert.equal(undo.status, "committed");
      assert.equal(undo.restored.length, count - 1);
      assert.deepEqual(undo.skipped, [], "default selection excludes conflicts before skipped is calculated");
      const diskText = await readFile(path.join(adapter.root, ...corePath.split("/")), "utf8");
      const after = JSON.parse(diskText);
      assert.equal(after.records.length, 1, "all selected clean entities were removed from the real file");
      assert.deepEqual(Buffer.from(canonicalStringify(after.records[0])), payloadBytes,
        "persisted conflict entity bytes retain the full local payload");
      const undoRecords = await target.personalService.queryLearningTerms({ limit: count + 1 });
      assert.equal(undoRecords.length, 1);
      assert.equal(undoRecords[0].note, "local conflict survives");
      const redo = await target.runtime.restore(undo.restoreBatchId);
      assert.equal(redo.status, "committed");
      assert.equal(redo.restored.length, count - 1);
      const redone = JSON.parse(await adapter.read(corePath));
      assert.equal(redone.records.length, count);
      assert.deepEqual(Buffer.from(canonicalStringify(redone.records.find((record) => record.key === conflictRecord.key))), payloadBytes);
      await target.runtime.close();
    }
  }
});

test("the real-disk DataAdapter is confined to its OS temporary root", async (t) => {
  const adapter = await createTemporaryVocabularyAdapter();
  t.after(() => adapter.dispose());
  assert.match(path.basename(adapter.root), /^obreader-bulk-/);
  await assert.rejects(adapter.write("../../outside.json", "must not be written"), { code: "NODE_ADAPTER_PATH_INVALID" });
  await assert.rejects(adapter.write("/tmp/outside.json", "must not be written"), { code: "NODE_ADAPTER_PATH_INVALID" });
  assert.deepEqual(await adapter.diskUsage(), { files: 0, directories: 0, bytes: 0 });
});

test("plain, gzip, and shared-lifecycle disk encodings expose the same logical History and support undo/redo", async (t) => {
  const bundle = await makeBundle(12);
  const logicalBatches = [];
  for (const mode of ["plain", "gzip-history", "shared-history"]) {
    const adapter = await createTemporaryVocabularyAdapter({ mode });
    t.after(() => adapter.dispose());
    const target = makeRuntime(adapter, { value: 0 });
    await target.runtime.ready();
    const result = await createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundle);
    assert.equal(result.status, "committed", `${mode} import commits`);
    assert.equal(result.imported, 12);
    const importBatch = (await target.runtime.history.listBatches()).find((batch) => batch.actionKind === "bundle-import");
    assert.ok(importBatch, `${mode} import writes History`);
    const historyPath = target.runtime.history.pathFor(importBatch.batchId);
    const historyText = await adapter.read(historyPath);
    assert.equal(historyText, logicalHistoryText(importBatch), `${mode} returns canonical expanded History text`);
    logicalBatches.push(transactionIndependentHistory(importBatch));
    assert.deepEqual(Object.keys(importBatch).sort(), [
      "actionKind", "batchId", "changes", "deviceId", "entities", "kind", "revision", "schemaVersion", "sessionId", "stores", "transactionId",
    ]);
    assert.equal(importBatch.changes.length, 12);
    assert.ok(importBatch.changes.every((change) => /^[a-f0-9]{64}$/.test(change.changeId)));
    const diskBytes = await readFile(path.join(adapter.root, ...historyPath.split("/")));
    if (mode === "gzip-history") assert.deepEqual([...diskBytes.subarray(0, 2)], [0x1f, 0x8b]);
    else if (mode === "shared-history") assert.ok(diskBytes.toString("utf8").startsWith(BULK_HISTORY_ENCODING_PREFIXES.sharedHistory));
    else assert.equal(diskBytes.toString("utf8"), historyText);

    assert.equal((await target.personalService.queryLearningTerms({ limit: 50 })).length, 12);
    const undo = await target.runtime.restore(importBatch.batchId);
    assert.equal(undo.status, "committed");
    assert.equal((await target.personalService.queryLearningTerms({ limit: 50 })).length, 0);
    const redo = await target.runtime.restore(undo.restoreBatchId);
    assert.equal(redo.status, "committed");
    assert.equal((await target.personalService.queryLearningTerms({ limit: 50 })).length, 12);
    await target.runtime.close();
  }
  assert.equal(new Set(logicalBatches).size, 1, "all encodings preserve the same logical changes apart from transaction-derived IDs");
});

test("disk-backed plain, gzip, and shared encodings recover crashes during import and History restore", async (t) => {
  const bundle = await makeBundle(4);
  for (const mode of ["plain", "gzip-history", "shared-history"]) {
    let crashAt = "import";
    const adapter = await createTemporaryVocabularyAdapter({ mode, hook: async ({ phase, operation, path: logicalPath, text }) => {
      if (phase !== "after" || operation !== "write" || !logicalPath.includes("/history/") ||
          !logicalPath.includes(".vocab-stage-") || !text) return;
      const actionKind = JSON.parse(text).actionKind;
      if (actionKind === "bundle-import" && crashAt === "import") {
        crashAt = "none";
        throw new Error("injected process crash after physical History stage write");
      }
      if (actionKind === "restore" && crashAt === "restore") {
        crashAt = "none";
        throw new Error("injected process crash after physical restore History stage write");
      }
    } });
    t.after(() => adapter.dispose());
    const sequence = { value: 0 };
    let target = makeRuntime(adapter, sequence);
    await target.runtime.ready();
    await assert.rejects(createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundle), /injected process crash/);

    const sessionDirectory = `00_Archive/21_VocabularyData/transactions/${DEVICE}/${SESSION}`;
    const pendingFiles = await adapter.list(sessionDirectory);
    const pendingPath = pendingFiles.files.find((logicalPath) => logicalPath.endsWith(".pending.json"));
    assert.ok(pendingPath, `${mode} keeps a pending intent across the injected crash`);
    const pendingPhysical = await readFile(path.join(adapter.root, ...pendingPath.split("/")));
    const historyDirectory = `00_Archive/21_VocabularyData/history/${DEVICE}`;
    const historyFiles = await adapter.list(historyDirectory);
    const stagedHistoryPath = historyFiles.files.find((logicalPath) => logicalPath.includes(".vocab-stage-"));
    assert.ok(stagedHistoryPath, `${mode} leaves the staged History write for recovery`);
    const stagedHistoryPhysical = await readFile(path.join(adapter.root, ...stagedHistoryPath.split("/")));
    if (mode === "gzip-history") assert.deepEqual([...stagedHistoryPhysical.subarray(0, 2)], [0x1f, 0x8b]);
    if (mode === "shared-history") {
      assert.ok(stagedHistoryPhysical.toString("utf8").startsWith(BULK_HISTORY_ENCODING_PREFIXES.sharedHistory));
      assert.ok(pendingPhysical.toString("utf8").startsWith(BULK_HISTORY_ENCODING_PREFIXES.sharedPending));
    }

    target = makeRuntime(adapter, sequence);
    const recoveredImport = await target.runtime.ready();
    assert.equal(recoveredImport.recovery.status, "recovered", `${mode} import transaction recovers after restart`);
    assert.equal((await target.personalService.queryLearningTerms({ limit: 50 })).length, 4);
    const importBatch = (await target.runtime.history.listBatches()).find((batch) => batch.actionKind === "bundle-import");
    assert.ok(importBatch, `${mode} recovered import has a decodable History record`);

    crashAt = "restore";
    await assert.rejects(target.runtime.restore(importBatch.batchId), /injected process crash/);
    target = makeRuntime(adapter, sequence);
    const recoveredRestore = await target.runtime.ready();
    assert.equal(recoveredRestore.recovery.status, "recovered", `${mode} restore transaction recovers after restart`);
    assert.equal((await target.personalService.queryLearningTerms({ limit: 50 })).length, 0);
    const restoreBatch = (await target.runtime.history.listBatches()).find((batch) => batch.actionKind === "restore");
    assert.ok(restoreBatch, `${mode} recovered restore has a decodable inverse History record`);
    const redo = await target.runtime.restore(restoreBatch.batchId);
    assert.equal(redo.status, "committed");
    assert.equal((await target.personalService.queryLearningTerms({ limit: 50 })).length, 4);
    await target.runtime.close();
  }
});
