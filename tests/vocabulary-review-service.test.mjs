import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { canonicalHash, canonicalStringify, hashText } = require("../plugin/vocabulary/canonical.cjs");
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");
const {
  REVIEW_ROOT,
  REVIEW_STATE_FIELDS,
  REVIEW_STORE_ID,
  createReviewHistoryRestoreHandler,
  createVocabularyReviewService,
} = require("../plugin/vocabulary/review-service.cjs");
const { createManifest, manifestPathFor, partitionRecords } = require("../plugin/vocabulary/sharded-store.cjs");

const WALK = 'en-family:v1:word:["walk"]';
const RUN = 'en-family:v1:word:["run"]';

class FakeReviewTransactions {
  constructor() {
    this.deviceId = "device-1";
    this.files = new Map();
    this.directories = new Set([""]);
    this.adapter = this;
    this.journal = new Map();
    this.summaries = new Map();
    this.commits = [];
    this.history = [];
    this.writeCount = 0;
    this.journalAppendCount = 0;
  }

  async readSnapshot(path) {
    return this.files.get(path) || { exists: false, text: null, value: null, revision: 0, hash: null };
  }

  async exists(path) {
    return this.files.has(path) || this.directories.has(path) || [...this.files.keys()].some((item) => item.startsWith(`${path}/`));
  }

  async list(path) {
    const prefix = `${path}/`;
    const files = [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    const folders = [...this.directories].filter((item) => item.startsWith(prefix) && item !== path && !item.slice(prefix.length).includes("/"));
    return { files, folders };
  }

  async recoverLocal() {
    return { status: "clean", recovered: [], conflicts: [] };
  }

  async commit({ actionId, writes = [], deletes = [] } = {}) {
    for (const write of writes) {
      const current = await this.readSnapshot(write.path);
      assert.equal(current.revision, write.expectedRevision, "write revision precondition");
      assert.equal(current.hash, write.expectedHash, "write hash precondition");
    }
    for (const write of writes) {
      const value = JSON.parse(write.text);
      const snapshot = { exists: true, text: write.text, value, revision: value.revision, hash: hashText(write.text) };
      this.files.set(write.path, snapshot);
      this.writeCount += 1;
    }
    for (const remove of deletes) this.files.delete(remove.path);
    this.commits.push({ actionId, writes: writes.map((write) => write.path) });
    return { status: "committed", actionId };
  }

  async readJournalActions(sessionId) {
    const actions = this.journal.get(sessionId) || [];
    return {
      actions: structuredClone(actions),
      hash: actions.length ? hashText(canonicalStringify(actions)) : null,
      revision: actions.length,
      paths: actions.map((item) => "journal/" + item.actionId),
      directory: "journal/" + sessionId,
    };
  }

  async appendJournalAction({ sessionId, actionId, payload, expectedSequence }) {
    this.journalAppendCount += 1;
    const actions = this.journal.get(sessionId) || [];
    const existing = actions.find((item) => item.actionId === actionId);
    if (existing) {
      if (canonicalStringify(existing.payload) !== canonicalStringify(payload)) return { status: "conflict" };
      return { status: "unchanged", actionId, revision: existing.sequence, hash: hashText(canonicalStringify(actions)) };
    }
    if (expectedSequence !== undefined && expectedSequence !== actions.length + 1) {
      return { status: "conflict", conflicts: [{ phase: "action-sequence-mismatch", expectedSequence, actualSequence: actions.length + 1 }] };
    }
    const sequence = actions.length + 1;
    actions.push({ actionId, sequence, payload: structuredClone(payload) });
    this.journal.set(sessionId, actions);
    return { status: "committed", actionId, revision: sequence, hash: hashText(canonicalStringify(actions)) };
  }

  async readSessionSummary(sessionId) {
    const saved = this.summaries.get(sessionId);
    if (!saved) return { exists: false, summary: null, hash: null, revision: 0, paths: [] };
    return { exists: true, summary: structuredClone(saved.summary), hash: saved.hash, revision: saved.revision, paths: ["summary"] };
  }

  async flushReviewSession({
    sessionId, actionId, writes = [], historySummary = null, updatedSummary,
    expectedJournalHash, expectedSummaryHash, finalize = false, preconditions = [],
  } = {}) {
    const journal = await this.readJournalActions(sessionId);
    const priorSummary = await this.readSessionSummary(sessionId);
    if (expectedJournalHash !== journal.hash || expectedSummaryHash !== priorSummary.hash) return { status: "conflict" };
    for (const condition of preconditions) {
      const current = await this.readSnapshot(condition.path);
      if (current.revision !== condition.expectedRevision || current.hash !== condition.expectedHash) return { status: "conflict" };
    }
    await this.commit({ actionId, writes });
    if (updatedSummary) {
      const revision = priorSummary.revision + 1;
      const hash = hashText(canonicalStringify({ revision, summary: updatedSummary }));
      this.summaries.set(sessionId, { revision, hash, summary: structuredClone(updatedSummary) });
    }
    if (historySummary) this.history.push(structuredClone(historySummary));
    if (finalize || historySummary) {
      this.journal.delete(sessionId);
      this.summaries.delete(sessionId);
    }
    return { status: "committed", actionId };
  }
}

class MemoryDataAdapter {
  constructor() {
    this.files = new Map();
    this.directories = new Set([""]);
  }

  async exists(path) { return this.files.has(path) || this.directories.has(path); }
  async mkdir(path) {
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent && !this.directories.has(parent)) throw new Error("missing parent: " + parent);
    this.directories.add(path);
  }
  async read(path) {
    if (!this.files.has(path)) throw new Error("missing file: " + path);
    return this.files.get(path);
  }
  async write(path, text) { this.files.set(path, text); }
  async rename(from, to) {
    if (!this.files.has(from)) throw new Error("missing source: " + from);
    if (this.files.has(to)) throw new Error("target exists: " + to);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }
  async remove(path) { this.files.delete(path); this.directories.delete(path); }
  async list(path) {
    const prefix = path ? path + "/" : "";
    const files = [...this.files.keys()].filter((item) => item.startsWith(prefix) && !item.slice(prefix.length).includes("/"));
    const folders = [...this.directories].filter((item) => item.startsWith(prefix) && item !== path &&
      !item.slice(prefix.length).includes("/"));
    return { files, folders };
  }
}

function mockVocabularyService() {
  const statuses = new Map([[WALK, 2], [RUN, 1]]);
  return {
    statuses,
    async getFamilyByKey(familyKey, options) {
      assert.deepEqual(options, { includeRecords: false });
      return statuses.has(familyKey) ? { familyKey, type: "word", status: statuses.get(familyKey) } : undefined;
    },
  };
}

function makeService(transaction = new FakeReviewTransactions(), extra = {}) {
  let time = Date.parse("2026-10-18T10:00:00.000Z");
  const clock = () => new Date(time);
  const timers = new Map();
  let timerId = 0;
  const service = createVocabularyReviewService({
    transaction,
    vocabularyService: extra.vocabularyService || mockVocabularyService(),
    now: clock,
    makeId: () => "generated-id",
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    ...(extra.flushEvery == null ? {} : { flushEvery: extra.flushEvery }),
    ...(extra.idleMs == null ? {} : { idleMs: extra.idleMs }),
  });
  return { service, transaction, timers, setTime: (value) => { time = typeof value === "number" ? value : Date.parse(value); } };
}

test("Review uses exact UTC Leitner transitions, filters Known without writes, and skip writes nothing", async () => {
  const transaction = new FakeReviewTransactions();
  const vocabularyService = mockVocabularyService();
  const { service, setTime } = makeService(transaction, { vocabularyService });
  await service.openSession({ sessionId: "review-transitions" });
  const skippedBefore = transaction.writeCount;
  const skipped = await service.skip(WALK, { actionId: "skip-1" });
  assert.equal(skipped.status, "skipped");
  assert.equal(transaction.writeCount, skippedBefore);
  assert.equal((await transaction.readJournalActions("review-transitions")).actions.length, 0);

  const enrolled = await service.enroll(WALK, { actionId: "enroll-1" });
  assert.equal(enrolled.status, "committed");
  assert.equal(enrolled.state.box, 1);
  assert.equal(enrolled.state.dueAt, "2026-10-18T10:00:00.000Z");
  assert.equal(enrolled.state.enrolledAt, "2026-10-18T10:00:00.000Z");

  const remembered = await service.remember(WALK, { actionId: "remember-1" });
  assert.equal(remembered.state.box, 2);
  assert.equal(remembered.state.dueAt, "2026-10-21T10:00:00.000Z");
  assert.equal(remembered.state.reviewCount, 1);

  setTime("2026-10-22T10:00:00.000Z");
  vocabularyService.statuses.set(WALK, 5);
  const beforeKnownList = transaction.writeCount;
  const knownQueue = await service.listDue();
  assert.equal(knownQueue.total, 0);
  assert.equal(transaction.writeCount, beforeKnownList);
  assert.equal((await service.getState(WALK)).box, 2);
  assert.equal((await service.remember(WALK, { actionId: "known-rating" })).status, "known-filtered");
  assert.equal(transaction.writeCount, beforeKnownList);

  vocabularyService.statuses.set(WALK, 2);
  const due = await service.listDue();
  assert.equal(due.total, 1);
  const forgotten = await service.forget(WALK, { actionId: "forget-1" });
  assert.equal(forgotten.state.box, 1);
  assert.equal(forgotten.state.dueAt, "2026-10-23T10:00:00.000Z");
  assert.equal(forgotten.state.reviewCount, 2);
  assert.equal(forgotten.state.lapseCount, 1);

  const before = transaction.writeCount;
  await service.unenroll(WALK, { actionId: "unenroll-1" });
  assert.equal((await service.getState(WALK)).enrolled, false);
  assert.equal((await service.getState(WALK)).box, 1);
  assert.equal(transaction.writeCount, before, "rating acknowledgements only append to the session journal before a checkpoint");
  await service.close();
});

test("Review rejects invalid computed state before appending a durable journal action", async (t) => {
  const cases = [
    {
      name: "reviewCount overflow",
      kind: "remember",
      expectedCode: "VOCAB_REVIEW_STATE_INVALID",
      seed(record) { record.reviewCount = Number.MAX_SAFE_INTEGER; },
    },
    {
      name: "lapseCount overflow",
      kind: "forget",
      expectedCode: "VOCAB_REVIEW_STATE_INVALID",
      seed(record) { record.lapseCount = Number.MAX_SAFE_INTEGER; },
    },
    {
      name: "out-of-range UTC clock",
      kind: "enroll",
      expectedCode: "VOCAB_REVIEW_TIME_INVALID",
      setClock(service) { service.setTime(8.64e15); },
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const transaction = new FakeReviewTransactions();
      if (scenario.seed) {
        const record = stateRecord(WALK);
        scenario.seed(record);
        const parts = partitionRecords({
          records: [record], storeId: REVIEW_STORE_ID, root: REVIEW_ROOT, kind: "review-state",
          idOf: (item) => item.familyKey,
        });
        transaction.files.set(manifestPathFor(REVIEW_ROOT), snapshot(createManifest({
          storeId: REVIEW_STORE_ID, kind: "review-state", revision: 1, shards: parts,
        })));
        for (const part of parts) transaction.files.set(part.path, snapshot(part.value));
      }
      const created = makeService(transaction);
      await created.service.openSession({ sessionId: "review-invalid-next" });
      scenario.setClock?.(created);

      await assert.rejects(created.service[scenario.kind](WALK, { actionId: "invalid-next" }), {
        code: scenario.expectedCode,
      });
      assert.equal(transaction.journalAppendCount, 0, "invalid state is rejected before journal append");
      assert.equal((await transaction.readJournalActions("review-invalid-next")).actions.length, 0);
      assert.equal(transaction.writeCount, 0);
    });
  }
});

test("Review stable action IDs are idempotent and flush checkpoints preserve one final History summary", async () => {
  const vocabularyService = mockVocabularyService();
  const { service, transaction } = makeService(undefined, { vocabularyService, flushEvery: 100 });
  await service.openSession({ sessionId: "review-history" });
  const first = await service.enroll(WALK, { actionId: "same-id" });
  const duplicate = await service.enroll(WALK, { actionId: "same-id" });
  assert.equal(first.sequence, duplicate.sequence);
  assert.equal(duplicate.status, "duplicate");
  await service.flush();
  await service.remember(WALK, { actionId: "remember-2" });
  await service.flush();
  const closed = await service.close();
  assert.equal(closed.status, "closed");
  assert.equal(closed.historyBatchId, "review-final:review-history");
  assert.equal(transaction.history.length, 1);
  const history = transaction.history[0];
  assert.equal(history.changes.length, REVIEW_STATE_FIELDS.length);
  assert.equal(history.changes.every((change) => change.storeId === REVIEW_STORE_ID), true);
  assert.equal(history.changes.every((change) => change.fieldPath[0] === "records" && change.fieldPath[1] === WALK), true);
  assert.equal(history.changes.find((change) => change.field === "box").beforeExists, false);
  assert.equal(history.changes.find((change) => change.field === "box").after, 2);
  assert.equal((await transaction.readJournalActions("review-history")).actions.length, 0);
  assert.equal((await transaction.readSessionSummary("review-history")).exists, false);
});

test("Review applies every Leitner interval and lapse counter in UTC", async () => {
  const vocabularyService = mockVocabularyService();
  const { service, setTime } = makeService(undefined, { vocabularyService });
  await service.openSession({ sessionId: "review-intervals" });
  await service.enroll(WALK, { actionId: "interval-enroll" });

  const transitions = [
    ["2026-10-18T10:00:00.000Z", 2, "2026-10-21T10:00:00.000Z"],
    ["2026-10-21T10:00:00.000Z", 3, "2026-10-28T10:00:00.000Z"],
    ["2026-10-28T10:00:00.000Z", 4, "2026-11-11T10:00:00.000Z"],
    ["2026-11-11T10:00:00.000Z", 5, "2026-12-11T10:00:00.000Z"],
    ["2026-12-11T10:00:00.000Z", 5, "2027-01-10T10:00:00.000Z"],
  ];
  for (const [time, box, dueAt] of transitions) {
    setTime(time);
    const result = await service.remember(WALK, { actionId: "interval-remember-" + box + "-" + time.slice(5, 10) });
    assert.equal(result.state.box, box);
    assert.equal(result.state.dueAt, dueAt);
  }
  setTime("2027-01-10T10:00:00.000Z");
  const lapse = await service.forget(WALK, { actionId: "interval-forget" });
  assert.equal(lapse.state.box, 1);
  assert.equal(lapse.state.dueAt, "2027-01-11T10:00:00.000Z");
  assert.equal(lapse.state.reviewCount, 6);
  assert.equal(lapse.state.lapseCount, 1);
});

test("Review replays unflushed local journal actions after a restart and filters cursor pages stably", async () => {
  const transaction = new FakeReviewTransactions();
  const vocabularyService = mockVocabularyService();
  const first = makeService(transaction, { vocabularyService });
  await first.service.openSession({ sessionId: "review-replay" });
  await first.service.enroll(WALK, { actionId: "replay-enroll" });
  await first.service.flush();

  const second = makeService(transaction, { vocabularyService });
  await second.service.openSession({ sessionId: "review-replay" });
  assert.equal((await second.service.getState(WALK)).box, 1);
  await second.service.remember(WALK, { actionId: "replay-remember" });

  const third = makeService(transaction, { vocabularyService });
  const opened = await third.service.openSession({ sessionId: "review-replay" });
  assert.equal(opened.replayedActions, 1);
  assert.equal((await third.service.getState(WALK)).box, 2);
  await third.service.enroll(RUN, { actionId: "replay-run" });
  third.setTime("2026-10-22T10:00:00.000Z");
  const page = await third.service.listDue({ limit: 1 });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const next = await third.service.listDue({ limit: 1, cursor: page.nextCursor });
  assert.equal(next.items.length, 1);
});

test("Review checkpoint and restart replay work through the real WAL coordinator", async () => {
  const adapter = new MemoryDataAdapter();
  let txId = 0;
  const transaction = new VocabularyTransactionCoordinator({
    adapter,
    deviceId: "review-real-device",
    sessionId: "review-real-coordinator",
    makeId: () => "review-tx-" + (++txId),
  });
  const vocabularyService = mockVocabularyService();
  const first = makeService(transaction, { vocabularyService });
  await first.service.openSession({ sessionId: "review-real-session" });
  await first.service.enroll(WALK, { actionId: "real-enroll" });
  const firstFlush = await first.service.flush();
  assert.equal(firstFlush.status, "committed");
  const checkpoint1 = await transaction.readSessionSummary("review-real-session");
  assert.equal(checkpoint1.exists, true);
  assert.equal(checkpoint1.summary.flushedThroughSequence, 1);
  const journal1 = await transaction.readJournalActions("review-real-session");
  assert.equal(journal1.actions.length, 1);

  const second = makeService(transaction, { vocabularyService });
  await second.service.openSession({ sessionId: "review-real-session" });
  assert.equal((await second.service.getState(WALK)).box, 1);
  await second.service.remember(WALK, { actionId: "real-remember" });

  const restarted = makeService(transaction, { vocabularyService });
  const recovered = await restarted.service.openSession({ sessionId: "review-real-session" });
  assert.equal(recovered.replayedActions, 1);
  assert.equal((await restarted.service.getState(WALK)).box, 2);
  const secondFlush = await restarted.service.flush();
  assert.equal(secondFlush.flushedThroughSequence, 2);
  const checkpoint2 = await transaction.readSessionSummary("review-real-session");
  assert.equal(checkpoint2.summary.flushedThroughSequence, 2);
  assert.equal((await transaction.readJournalActions("review-real-session")).actions.length, 2);
});

test("Review enrollment History preview, undo, reopen, and redo operate on the complete sharded entity", async () => {
  const adapter = new MemoryDataAdapter();
  let transactionId = 0;
  let historyId = 0;
  const transaction = new VocabularyTransactionCoordinator({
    adapter,
    deviceId: "review-history-device",
    sessionId: "review-history-coordinator",
    makeId: () => "review-history-tx-" + (++transactionId),
  });
  const vocabularyService = mockVocabularyService();
  const handler = createReviewHistoryRestoreHandler({ transaction, vocabularyService });
  const history = new VocabularyHistory({
    coordinator: transaction,
    makeId: () => "review-restore-" + (++historyId),
    handlers: { [REVIEW_STORE_ID]: handler },
  });

  const first = makeService(transaction, { vocabularyService });
  await first.service.openSession({ sessionId: "review-enroll-history" });
  await first.service.enroll(WALK, { actionId: "history-enroll" });
  const closed = await first.service.close();
  assert.equal(closed.historyBatchId, "review-final:review-enroll-history");

  const initialBatch = await history.readBatch(closed.historyBatchId);
  assert.equal(initialBatch.actionKind, "review-final");
  assert.deepEqual(initialBatch.entities, [{ storeId: REVIEW_STORE_ID, entityId: WALK, kind: "entityCreate" }]);
  assert.equal(initialBatch.changes.length, REVIEW_STATE_FIELDS.length);
  assert.equal(initialBatch.changes.every((change) => change.kind === "entityCreate"), true);
  const preview = await history.previewRestore(closed.historyBatchId);
  assert.equal(preview.status, "ready");
  assert.equal(preview.items.every((item) => item.status === "clean" && item.entityExists), true);

  const undone = await history.restore(closed.historyBatchId);
  assert.equal(undone.status, "committed");
  const afterUndo = await history.previewRestore(undone.restoreBatchId);
  assert.equal(afterUndo.status, "ready");
  assert.equal(afterUndo.items.every((item) => item.status === "clean" && item.entityExists === false), true);

  const afterUndoReview = makeService(transaction, { vocabularyService });
  await afterUndoReview.service.openSession({ sessionId: "review-after-undo" });
  assert.equal(await afterUndoReview.service.getState(WALK), undefined);
  await afterUndoReview.service.close();

  const redone = await history.restore(undone.restoreBatchId);
  assert.equal(redone.status, "committed");
  const afterRedoReview = makeService(transaction, { vocabularyService });
  await afterRedoReview.service.openSession({ sessionId: "review-after-redo" });
  const restoredState = await afterRedoReview.service.getState(WALK);
  assert.ok(restoredState);
  assert.equal(restoredState.familyKey, WALK);
  assert.equal(restoredState.box, 1);
  await afterRedoReview.service.close();
});

function stateRecord(familyKey) {
  return {
    schemaVersion: 1, familyKey, enrolled: true, box: 2,
    dueAt: "2026-10-21T10:00:00.000Z", enrolledAt: "2026-10-18T10:00:00.000Z",
    lastReviewedAt: "2026-10-18T10:00:00.000Z", reviewCount: 1, lapseCount: 0, updatedAt: "2026-10-18T10:00:00.000Z",
    lastActionSessionId: "seed-session", lastActionSequence: 1, lastActionId: "seed-action",
  };
}

function snapshot(value) {
  const text = canonicalStringify(value);
  return { exists: true, text, value: JSON.parse(text), revision: value.revision, hash: hashText(text) };
}

test("Review History restore validates and replans its own shard, including complete removal of a newly enrolled record", async () => {
  const record = stateRecord(WALK);
  const parts = partitionRecords({
    records: [record], storeId: REVIEW_STORE_ID, root: REVIEW_ROOT, kind: "review-state",
    idOf: (item) => item.familyKey,
  });
  const manifest = {
    schemaVersion: 1, kind: "vocabulary-shard-manifest", storeId: REVIEW_STORE_ID,
    storeKind: "review-state", revision: 1,
    shards: parts.map((part) => ({
      prefix: part.prefix, path: part.path, revision: part.value.revision, hash: part.hash,
      recordCount: part.recordCount, byteLength: part.byteLength,
    })),
  };
  const snapshots = new Map([[manifestPathFor(REVIEW_ROOT), snapshot(manifest)]]);
  for (const part of parts) snapshots.set(part.path, snapshot(part.value));
  const family = { async getFamilyByKey(key) { return key === WALK ? { familyKey: key, status: 2 } : undefined; } };
  let currentSnapshots = snapshots;
  const handler = createReviewHistoryRestoreHandler({
    transaction: { async readSnapshot(path) { return currentSnapshots.get(path) || { exists: false, text: null, value: null, revision: 0, hash: null }; } },
    vocabularyService: family,
  });
  const shardPath = parts[0].path;
  const changes = REVIEW_STATE_FIELDS.map((field, index) => ({
    changeId: String(index).padStart(64, "0"),
    storeId: REVIEW_STORE_ID, path: shardPath, entityId: WALK, kind: "entityCreate", entityExists: true, field,
    fieldPath: ["records", WALK, field], status: "clean",
    beforeExists: false, before: null, afterExists: true, after: record[field],
    currentExists: true, current: record[field],
  }));
  const planned = await handler.planRestore({
    batch: { kind: "vocabulary-history-batch", actionKind: "review-final", batchId: "review-final:seed" },
    selectedChanges: changes,
    snapshots,
  });
  assert.equal(planned.writes.length, 1);
  assert.equal(planned.writes[0].path, manifestPathFor(REVIEW_ROOT));
  assert.equal(planned.changes.length, REVIEW_STATE_FIELDS.length);
  assert.equal(planned.entities[0].kind, "entityDelete");
  const nextManifest = JSON.parse(planned.writes[0].text);
  assert.equal(nextManifest.shards.length, 0);
  assert.equal(planned.stores[0].path, manifestPathFor(REVIEW_ROOT));

  const snapshotsAfterUndo = new Map(snapshots);
  snapshotsAfterUndo.set(manifestPathFor(REVIEW_ROOT), snapshot(nextManifest));
  currentSnapshots = snapshotsAfterUndo;
  const redone = await handler.planRestore({
    batch: { kind: "vocabulary-history-batch", actionKind: "restore", batchId: "history-restore:review-final:seed" },
    selectedChanges: planned.changes.map((change) => ({
      ...change, status: "clean", entityExists: false, currentExists: false, current: null,
    })),
    snapshots: snapshotsAfterUndo,
  });
  assert.equal(redone.entities[0].kind, "entityCreate");
  assert.equal(redone.writes.length, 2, "redo writes the fixed shard and its manifest reference");
  const redoneManifest = JSON.parse(redone.writes.find((write) => write.path === manifestPathFor(REVIEW_ROOT)).text);
  assert.equal(redoneManifest.shards.length, 1);
  currentSnapshots = snapshots;
  await assert.rejects(handler.planRestore({
    batch: { kind: "vocabulary-history-batch", actionKind: "review-final", batchId: "review-final:seed" },
    selectedChanges: changes.slice(0, 1), snapshots,
  }), { code: "VOCAB_REVIEW_RESTORE_PARTIAL_CREATE" });
});

test("Review refuses a hash-valid persisted record whose vocabulary family reference is missing", async () => {
  const transaction = new FakeReviewTransactions();
  const record = stateRecord(WALK);
  const parts = partitionRecords({
    records: [record], storeId: REVIEW_STORE_ID, root: REVIEW_ROOT, kind: "review-state",
    idOf: (item) => item.familyKey,
  });
  const manifest = createManifest({ storeId: REVIEW_STORE_ID, kind: "review-state", revision: 1, shards: parts });
  transaction.files.set(manifestPathFor(REVIEW_ROOT), snapshot(manifest));
  for (const part of parts) transaction.files.set(part.path, snapshot(part.value));
  const vocabularyService = mockVocabularyService();
  vocabularyService.statuses.delete(WALK);
  const { service } = makeService(transaction, { vocabularyService });
  await assert.rejects(service.openSession({ sessionId: "review-missing-family" }), {
    code: "VOCAB_REVIEW_FAMILY_MISSING",
  });
});

test("Review refuses to treat a shard without its manifest as empty", async () => {
  const transaction = new FakeReviewTransactions();
  const record = { familyKey: WALK };
  const [part] = partitionRecords({
    records: [record], storeId: REVIEW_STORE_ID, root: REVIEW_ROOT, kind: "review-state",
    idOf: (item) => item.familyKey,
  });
  transaction.files.set(part.path, snapshot(part.value));
  const { service } = makeService(transaction);

  await assert.rejects(service.openSession({ sessionId: "review-orphan-shard" }), {
    code: "VOCAB_SHARD_MANIFEST_MISSING",
  });
  assert.equal(transaction.files.has(`${REVIEW_ROOT}/manifest.json`), false);
  assert.equal(transaction.writeCount, 0);
});

test("Review History resolver refuses an orphan shard when its manifest is missing", async () => {
  const transaction = new FakeReviewTransactions();
  const [part] = partitionRecords({
    records: [{ familyKey: WALK }], storeId: REVIEW_STORE_ID, root: REVIEW_ROOT,
    kind: "review-state", idOf: (item) => item.familyKey,
  });
  transaction.files.set(part.path, snapshot(part.value));
  const handler = createReviewHistoryRestoreHandler({ transaction, vocabularyService: mockVocabularyService() });

  await assert.rejects(handler.resolveField({ change: {
    storeId: REVIEW_STORE_ID,
    path: part.path,
    entityId: WALK,
    field: "box",
    fieldPath: ["records", WALK, "box"],
  } }), { code: "VOCAB_SHARD_MANIFEST_MISSING" });
});
