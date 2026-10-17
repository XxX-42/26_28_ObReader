import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { MemoryDataAdapter } from "./vocabulary-transaction-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { canonicalStringify, hashText } = require("../plugin/vocabulary/canonical.cjs");
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");

const ROOT = "00_Archive/21_VocabularyData";
const DEVICE = "device-local-01";
const SESSION = "history-session-01";

function setup(adapter = new MemoryDataAdapter(), deviceId = DEVICE) {
  let id = 0;
  const transaction = new VocabularyTransactionCoordinator({
    adapter,
    deviceId,
    sessionId: SESSION,
    makeId: () => `history-tx-${++id}`,
  });
  const history = new VocabularyHistory({ coordinator: transaction, makeId: () => `restore-${++id}` });
  return { adapter, transaction, history };
}

function text(value) { return canonicalStringify(value); }
function summary({ batchId, sessionId = SESSION, storeId, path, before, after, entityId = "record-key" }) {
  return {
    batchId,
    sessionId,
    kind: "edit",
    entities: [{ storeId, entityId, kind: "record" }],
    stores: [{
      storeId,
      path,
      baseRevision: before.revision,
      resultRevision: after.revision,
      baseHash: before.hash,
      resultHash: hashText(after.text),
    }],
    changes: [{
      storeId,
      path,
      entityId,
      field: "note",
      fieldPath: ["records", entityId, "note"],
      beforeExists: true,
      before: "before",
      afterExists: true,
      after: "after",
    }],
  };
}

function recordHandler() {
  return {
    resolveField({ snapshot, change }) {
      if (!snapshot?.exists) return { exists: false, entityExists: false };
      const record = snapshot.value.records.find((item) => item.key === change.entityId);
      if (!record) return { exists: false, entityExists: false };
      const field = change.fieldPath.at(-1);
      return Object.hasOwn(record, field)
        ? { exists: true, value: record[field], entityExists: true }
        : { exists: false, entityExists: true };
    },
    planRestore({ selectedChanges, snapshots }) {
      assert.ok(selectedChanges.length > 0);
      const first = selectedChanges[0];
      const snapshot = snapshots.get(first.path);
      const result = structuredClone(snapshot.value);
      const record = result.records.find((item) => item.key === first.entityId);
      for (const change of selectedChanges) {
        const field = change.fieldPath.at(-1);
        if (change.beforeExists) record[field] = structuredClone(change.before);
        else delete record[field];
      }
      result.revision += 1;
      return { writes: [{
        path: first.path,
        storeId: first.storeId,
        expectedRevision: snapshot.revision,
        expectedHash: snapshot.hash,
        text: text(result),
      }] };
    },
  };
}

test("history commit, key-based preview, clean-only restore, inverse batch and redo use verified snapshots", async () => {
  const { adapter, transaction, history } = setup();
  const path = `${ROOT}/core-v2.json`;
  const beforeValue = { revision: 1, records: [
    { key: "other-record", note: "other" },
    { key: "record-key", note: "before", familyKey: "family-a" },
  ] };
  const beforeText = text(beforeValue);
  await adapter.write(path, beforeText);
  const before = await transaction.readSnapshot(path);
  const afterText = text({ revision: 2, records: [
    { key: "other-record", note: "other" },
    { key: "record-key", note: "after", familyKey: "family-a" },
  ] });
  const historySummary = summary({ batchId: "edit-batch-1", storeId: "core-v2", path, before,
    after: { revision: 2, text: afterText } });
  history.registerStoreHandler("core-v2", recordHandler());

  const committed = await transaction.commit({ actionId: "edit-action", writes: [{
    path, storeId: "core-v2", expectedRevision: before.revision, expectedHash: before.hash, text: afterText,
  }], historySummary });
  assert.equal(committed.status, "committed");
  const batch = await history.readBatch("edit-batch-1");
  assert.equal(batch.deviceId, DEVICE);
  assert.equal(batch.transactionId, committed.txId);
  assert.equal(batch.stores[0].baseHash, before.hash);
  assert.equal(batch.stores[0].resultHash, hashText(afterText));
  const preview = await history.previewRestore("edit-batch-1");
  assert.equal(preview.items[0].status, "clean");
  assert.equal(preview.items[0].current, "after");

  const restored = await history.restore("edit-batch-1");
  assert.equal(restored.status, "committed");
  assert.equal((await transaction.readSnapshot(path)).value.records[1].note, "before");
  const alreadyRestored = await history.previewRestore("edit-batch-1");
  assert.equal(alreadyRestored.items[0].status, "already-restored");
  const inverse = await history.readBatch(restored.restoreBatchId);
  assert.equal(inverse.changes[0].before, "after");
  assert.equal(inverse.changes[0].after, "before");
  const redo = await history.restore(restored.restoreBatchId);
  assert.equal(redo.status, "committed");
  assert.equal((await transaction.readSnapshot(path)).value.records[1].note, "after");
  assert.equal((await history.listBatches()).length, 3);
});

test("history conflict preview never overwrites implicitly; explicit change IDs and a registered planner are required", async () => {
  const { adapter, transaction, history } = setup();
  const path = `${ROOT}/core-conflict.json`;
  const beforeText = text({ revision: 1, records: [{ key: "record-key", note: "before" }] });
  await adapter.write(path, beforeText);
  const before = await transaction.readSnapshot(path);
  const afterText = text({ revision: 2, records: [{ key: "record-key", note: "after" }] });
  const historySummary = summary({ batchId: "edit-conflict", storeId: "core-v2", path, before,
    after: { revision: 2, text: afterText } });
  const result = await transaction.commit({ actionId: "conflicting-edit", writes: [{
    path, storeId: "core-v2", expectedRevision: 1, expectedHash: before.hash, text: afterText,
  }], historySummary });
  assert.equal(result.status, "committed");
  const externalText = text({ revision: 3, records: [{ key: "record-key", note: "external" }] });
  await adapter.write(path, externalText);

  const preview = await history.previewRestore("edit-conflict");
  assert.equal(preview.items[0].status, "conflict");
  await assert.rejects(history.restore("edit-conflict", { overwriteConflictIds: [preview.items[0].changeId] }),
    { code: "VOCAB_HISTORY_RESTORE_HANDLER_MISSING" });
  assert.equal((await transaction.readSnapshot(path)).text, externalText);

  history.registerStoreHandler("core-v2", recordHandler());
  const skipped = await history.restore("edit-conflict");
  assert.equal(skipped.status, "unchanged");
  assert.equal((await transaction.readSnapshot(path)).text, externalText);
  const overwritten = await history.restore("edit-conflict", { overwriteConflictIds: [preview.items[0].changeId] });
  assert.equal(overwritten.status, "committed");
  assert.equal((await transaction.readSnapshot(path)).value.records[0].note, "before");
});

test("History restore carries cross-store planner preconditions into the coordinator before writing", async () => {
  const { adapter, transaction, history } = setup();
  const path = `${ROOT}/core-precondition.json`;
  const dependencyPath = `${ROOT}/context-family-index.json`;
  await adapter.write(path, text({ revision: 1, records: [{ key: "record-key", note: "before" }] }));
  await adapter.write(dependencyPath, text({ revision: 1, families: ["family-a"] }));
  const before = await transaction.readSnapshot(path);
  const afterText = text({ revision: 2, records: [{ key: "record-key", note: "after" }] });
  const dependencyBefore = await transaction.readSnapshot(dependencyPath);
  await transaction.commit({ actionId: "precondition-source-edit", writes: [{
    path, storeId: "core-v2", expectedRevision: before.revision, expectedHash: before.hash, text: afterText,
  }], historySummary: summary({ batchId: "precondition-source-batch", storeId: "core-v2", path, before,
    after: { revision: 2, text: afterText } }) });

  const baseHandler = recordHandler();
  history.registerStoreHandler("core-v2", {
    resolveField: baseHandler.resolveField,
    async planRestore(args) {
      const plan = baseHandler.planRestore(args);
      // This replacement occurs after planning read the dependency identity but before coordinator commit.
      await adapter.write(dependencyPath, text({ revision: 2, families: [] }));
      return {
        ...plan,
        preconditions: [{ storeId: "context-v2", path: dependencyPath,
          expectedRevision: dependencyBefore.revision, expectedHash: dependencyBefore.hash }],
      };
    },
  });

  const result = await history.restore("precondition-source-batch");
  assert.equal(result.status, "conflict");
  assert.ok(result.conflicts.some((conflict) => conflict.path === dependencyPath));
  const unchanged = await transaction.readSnapshot(path);
  assert.equal(unchanged.value.records[0].note, "after", "a changed reference store prevents the planned core write");
  assert.equal(unchanged.revision, 2);
});

test("History restore rejects conflicting planner identities for the same path instead of choosing one", async () => {
  const { adapter, transaction, history } = setup();
  const path = `${ROOT}/core-precondition-overlap.json`;
  const dependencyPath = `${ROOT}/shared-reference-index.json`;
  await adapter.write(path, text({ revision: 1, records: [{ key: "record-key", note: "before" }] }));
  await adapter.write(dependencyPath, text({ revision: 1, references: ["a"] }));
  const before = await transaction.readSnapshot(path);
  const afterText = text({ revision: 2, records: [{ key: "record-key", note: "after" }] });
  const dependency = await transaction.readSnapshot(dependencyPath);
  await transaction.commit({ actionId: "overlap-source-edit", writes: [{
    path, storeId: "core-v2", expectedRevision: before.revision, expectedHash: before.hash, text: afterText,
  }], historySummary: summary({ batchId: "overlap-source-batch", storeId: "core-v2", path, before,
    after: { revision: 2, text: afterText } }) });
  const handler = recordHandler();
  history.registerStoreHandler("core-v2", {
    ...handler,
    planRestore(args) {
      return {
        ...handler.planRestore(args),
        preconditions: [
          { storeId: "reference-store", path: dependencyPath, expectedRevision: dependency.revision, expectedHash: dependency.hash },
          { storeId: "reference-store", path: dependencyPath, expectedRevision: dependency.revision + 1,
            expectedHash: hashText(text({ revision: 2, references: ["b"] })) },
        ],
      };
    },
  });
  const result = await history.restore("overlap-source-batch");
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts[0].phase, "restore-precondition-identity-conflict");
  assert.equal((await transaction.readSnapshot(path)).value.records[0].note, "after");
});

test("entityCreate History is grouped atomically, permits identity fields only for lifecycle, and redo recreates the complete record", async () => {
  const { adapter, transaction, history } = setup();
  const path = `${ROOT}/core-created.json`;
  const created = {
    revision: 1,
    records: [{ key: "created-key", familyKey: "en-family:v1:word:[\"walk\"]", type: "word", note: "gloss" }],
  };
  const afterText = text(created);
  const createdFields = ["key", "familyKey", "type", "note"].map((field) => ({
    storeId: "core-v2", path, entityId: "created-key", field,
    fieldPath: ["records", "created-key", field], kind: "entityCreate",
    beforeExists: false, afterExists: true, after: created.records[0][field],
  }));
  history.registerStoreHandler("core-v2", {
    resolveField({ snapshot, change }) {
      const record = snapshot?.exists ? snapshot.value.records.find((entry) => entry.key === change.entityId) : null;
      return record
        ? { exists: Object.hasOwn(record, change.fieldPath[2]), ...(Object.hasOwn(record, change.fieldPath[2]) ? { value: record[change.fieldPath[2]] } : {}), entityExists: true }
        : { exists: false, entityExists: false };
    },
    planRestore({ selectedChanges, snapshots }) {
      assert.equal(selectedChanges.length, createdFields.length, "the lifecycle planner receives the complete field group");
      const snapshot = snapshots.get(path);
      const next = structuredClone(snapshot.value);
      if (selectedChanges[0].kind === "entityCreate") next.records = next.records.filter((record) => record.key !== "created-key");
      else next.records.push({ key: "created-key", familyKey: created.records[0].familyKey, type: "word", note: "gloss" });
      next.revision += 1;
      return { writes: [{ path, storeId: "core-v2", expectedRevision: snapshot.revision,
        expectedHash: snapshot.hash, text: text(next) }] };
    },
  });
  const committed = await transaction.commit({ actionId: "import-create", writes: [{
    path, storeId: "core-v2", expectedRevision: 0, expectedHash: null, text: afterText,
  }], historySummary: {
    batchId: "create-batch", sessionId: SESSION, kind: "import",
    entities: [{ storeId: "core-v2", entityId: "created-key", kind: "entityCreate" }],
    stores: [{ storeId: "core-v2", path, baseRevision: 0, resultRevision: 1, baseHash: null, resultHash: hashText(afterText) }],
    changes: createdFields,
  } });
  assert.equal(committed.status, "committed");
  const preview = await history.previewRestore("create-batch");
  assert.ok(preview.items.every((item) => item.status === "clean"));
  const partial = [preview.items[0].changeId];
  await assert.rejects(history.restore("create-batch", { selected: partial }), { code: "VOCAB_HISTORY_LIFECYCLE_SELECTION" });
  const undo = await history.restore("create-batch");
  assert.equal(undo.status, "committed");
  assert.deepEqual((await transaction.readSnapshot(path)).value.records, []);
  const inverse = await history.readBatch(undo.restoreBatchId);
  assert.equal(inverse.entities[0].kind, "entityDelete");
  assert.ok(inverse.changes.every((change) => change.kind === "entityDelete"));
  const redo = await history.restore(undo.restoreBatchId);
  assert.equal(redo.status, "committed");
  assert.deepEqual((await transaction.readSnapshot(path)).value.records, created.records);
});

test("history rejects identity edits outside lifecycle and scans finalized batches by verified device directory", async () => {
  const { adapter, transaction, history } = setup();
  const path = `${ROOT}/protected.json`;
  const before = await transaction.readSnapshot(path);
  const invalid = {
    batchId: "bad-identity", sessionId: SESSION, deviceId: DEVICE, transactionId: "tx",
    stores: [{ storeId: "core-v2", path, baseRevision: 0, resultRevision: 1,
      baseHash: null, resultHash: hashText(text({ revision: 1, records: [] })) }],
    changes: [{ storeId: "core-v2", path, entityId: "record-key", fieldPath: ["records", "record-key", "familyKey"],
      beforeExists: false, afterExists: true, after: "family" }],
  };
  await assert.rejects(history.prepareRecordBatch(invalid, before), { code: "VOCAB_HISTORY_IDENTITY_PROTECTED" });

  const userPath = `${ROOT}/remote-history.json`;
  const baseText = text({ revision: 1, records: [{ key: "record-key", note: "before" }] });
  await adapter.write(userPath, baseText);
  const current = await transaction.readSnapshot(userPath);
  const afterText = text({ revision: 2, records: [{ key: "record-key", note: "after" }] });
  const localSummary = summary({ batchId: "local-final", storeId: "core-v2", path: userPath, before: current,
    after: { revision: 2, text: afterText } });
  await transaction.commit({ actionId: "local-final-action", writes: [{ path: userPath, storeId: "core-v2",
    expectedRevision: 1, expectedHash: current.hash, text: afterText }], historySummary: localSummary });

  const remote = setup(adapter, "device-remote-02");
  const remotePath = `${ROOT}/remote-state.json`;
  const remoteBaseText = text({ revision: 1, records: [{ key: "record-key", note: "remote-before" }] });
  await adapter.write(remotePath, remoteBaseText);
  const remoteBase = await remote.transaction.readSnapshot(remotePath);
  const remoteAfter = text({ revision: 2, records: [{ key: "record-key", note: "remote-after" }] });
  await remote.transaction.commit({ actionId: "remote-final-action", writes: [{ path: remotePath, storeId: "core-v2",
    expectedRevision: 1, expectedHash: remoteBase.hash, text: remoteAfter }], historySummary: summary({ batchId: "remote-final",
      storeId: "core-v2", path: remotePath, before: remoteBase, after: { revision: 2, text: remoteAfter } }) });

  const batches = await history.listBatches();
  assert.deepEqual(batches.map((batch) => batch.deviceId), [DEVICE, "device-remote-02"]);
  assert.equal(await history.readBatch("remote-final"), null);
  assert.equal((await history.readBatch("remote-final", { deviceId: "device-remote-02" })).deviceId, "device-remote-02");
});

test("existing canonical revision zero is distinguished from an absent file by its verified hash", async () => {
  const adapter = new MemoryDataAdapter();
  const { transaction } = setup(adapter);
  const existingZeroPath = `${ROOT}/existing-zero.json`;
  const absentPath = `${ROOT}/absent-zero.json`;
  const zeroText = text({ revision: 0, records: [] });
  await adapter.write(existingZeroPath, zeroText);
  const existing = await transaction.readSnapshot(existingZeroPath);
  assert.equal(existing.exists, true);
  assert.equal(existing.revision, 0);
  assert.equal(existing.hash, hashText(zeroText));
  const committed = await transaction.commit({ actionId: "rev-zero-first-write", writes: [
    { path: existingZeroPath, storeId: "core-existing", expectedRevision: 0, expectedHash: existing.hash,
      text: text({ revision: 1, records: [{ key: "a" }] }) },
    { path: absentPath, storeId: "core-absent", expectedRevision: 0, expectedHash: null,
      text: text({ revision: 1, records: [{ key: "b" }] }) },
  ] });
  assert.equal(committed.status, "committed");
  assert.equal((await transaction.readSnapshot(existingZeroPath)).value.records[0].key, "a");
  assert.equal((await transaction.readSnapshot(absentPath)).value.records[0].key, "b");
});
