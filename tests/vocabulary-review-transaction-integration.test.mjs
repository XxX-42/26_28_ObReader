import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { MemoryDataAdapter } from "./vocabulary-transaction-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { VocabularyTransactionCoordinator } = require("../plugin/vocabulary/transactions.cjs");
const { VocabularyHistory } = require("../plugin/vocabulary/history.cjs");
const {
  REVIEW_ROOT,
  REVIEW_STORE_ID,
  createReviewHistoryRestoreHandler,
  createVocabularyReviewService,
} = require("../plugin/vocabulary/review-service.cjs");
const { readShardedStore } = require("../plugin/vocabulary/sharded-store.cjs");

const DEVICE_ID = "review-integration-device";
const SESSION_ID = "review-integration-session";
const FAMILY_KEY = 'en-family:v1:word:["integration"]';

function createFixture(adapter = new MemoryDataAdapter()) {
  let id = 0;
  const transaction = new VocabularyTransactionCoordinator({
    adapter,
    deviceId: DEVICE_ID,
    sessionId: SESSION_ID,
    makeId: () => `review-integration-tx-${++id}`,
  });
  const vocabularyService = {
    async getFamilyByKey(familyKey, options) {
      assert.deepEqual(options, { includeRecords: false });
      return familyKey === FAMILY_KEY ? { familyKey, type: "word", status: 1 } : undefined;
    },
  };
  const history = new VocabularyHistory({
    coordinator: transaction,
    makeId: () => `review-restore-${++id}`,
    handlers: {
      [REVIEW_STORE_ID]: createReviewHistoryRestoreHandler({ transaction, vocabularyService }),
    },
  });
  const createReview = () => createVocabularyReviewService({
    transaction,
    vocabularyService,
    now: () => new Date("2026-10-18T10:00:00.000Z"),
    makeId: () => `review-action-${++id}`,
    setTimeout: () => ++id,
    clearTimeout: () => {},
  });
  return { adapter, transaction, history, createReview };
}

test("Review checkpoint survives service restart and final History ACK gates journal cleanup", async () => {
  const fixture = createFixture();
  const firstService = fixture.createReview();
  await firstService.openSession({ sessionId: SESSION_ID });
  const action = await firstService.enroll(FAMILY_KEY, { actionId: "review-enroll-1" });
  assert.equal(action.status, "committed");
  assert.equal(action.sequence, 1);

  const checkpoint = await firstService.flush();
  assert.equal(checkpoint.status, "committed");
  assert.equal(checkpoint.flushedThroughSequence, 1);
  const savedSummary = await fixture.transaction.readSessionSummary(SESSION_ID);
  assert.equal(savedSummary.exists, true);
  assert.equal(savedSummary.summary.flushedThroughSequence, 1);
  assert.equal((await fixture.transaction.readJournalActions(SESSION_ID)).actions.length, 1);

  // A second service instance represents a restart after the canonical checkpoint.
  const restartedService = fixture.createReview();
  const reopened = await restartedService.openSession({ sessionId: SESSION_ID });
  assert.equal(reopened.status, "open");
  assert.equal(reopened.replayedActions, 0);
  assert.equal((await restartedService.getState(FAMILY_KEY)).enrolled, true);

  let injected = false;
  fixture.adapter.renameHook = async (_from, to) => {
    if (!injected && to.startsWith(`${REVIEW_ROOT.replace(/review\/states$/, "history")}/`)) {
      injected = true;
      throw new Error("injected crash before final History install");
    }
  };
  await assert.rejects(restartedService.close(), /injected crash before final History install/);
  assert.equal(injected, true);

  const journalBeforeRecovery = await fixture.transaction.readJournalActions(SESSION_ID);
  assert.equal(journalBeforeRecovery.actions.length, 1, "the acknowledged Review action remains recoverable until History installs");
  assert.equal((await fixture.transaction.readSessionSummary(SESSION_ID)).exists, true);
  assert.ok(fixture.adapter.filePaths(`${REVIEW_ROOT.replace(/review\/states$/, "transactions")}/${DEVICE_ID}/${SESSION_ID}`)
    .some((path) => path.endsWith(".pending.json")), "the finalization intent remains available for recovery");

  fixture.adapter.renameHook = null;
  const recovered = await fixture.transaction.recoverLocal();
  assert.equal(recovered.status, "recovered", JSON.stringify(recovered, null, 2));
  assert.equal((await fixture.transaction.readJournalActions(SESSION_ID)).actions.length, 0);
  assert.equal((await fixture.transaction.readSessionSummary(SESSION_ID)).exists, false);

  const batches = await fixture.history.listBatches();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].actionKind, "review-final");
  assert.equal(batches[0].deviceId, DEVICE_ID);
  assert.equal(batches[0].entities[0].kind, "entityCreate");
  assert.equal(batches[0].changes.length, 8);
  assert.ok(batches[0].changes.every((change) => change.kind === "entityCreate"));
  const state = await readShardedStore({
    readSnapshot: (path) => fixture.transaction.readSnapshot(path),
    storeId: REVIEW_STORE_ID,
    root: REVIEW_ROOT,
    kind: "review-state",
    idOf: (record) => record?.familyKey,
  });
  assert.equal(state.records.find((record) => record.familyKey === FAMILY_KEY).enrolled, true);
});

test("same-session concurrent Review services ACK one stale transition and restart recovers it", async () => {
  const fixture = createFixture();
  const first = fixture.createReview();
  const second = fixture.createReview();
  await first.openSession({ sessionId: "review-concurrent-session" });
  await second.openSession({ sessionId: "review-concurrent-session" });

  const outcomes = await Promise.allSettled([
    first.enroll(FAMILY_KEY, { actionId: "concurrent-enroll-a" }),
    second.enroll(FAMILY_KEY, { actionId: "concurrent-enroll-b" }),
  ]);
  const acknowledgements = outcomes.filter((result) => result.status === "fulfilled");
  const conflicts = outcomes.filter((result) => result.status === "rejected");
  assert.equal(acknowledgements.length, 1, JSON.stringify(outcomes, null, 2));
  assert.equal(acknowledgements[0].value.status, "committed");
  assert.equal(acknowledgements[0].value.sequence, 1);
  assert.equal(conflicts.length, 1, JSON.stringify(outcomes, null, 2));
  assert.equal(conflicts[0].reason.code, "VOCAB_REVIEW_JOURNAL_CONFLICT");

  const journal = await fixture.transaction.readJournalActions("review-concurrent-session");
  assert.equal(journal.actions.length, 1, "the losing stale transition must not be persisted");
  assert.equal(journal.actions[0].sequence, 1);
  assert.equal(journal.actions[0].actionId, acknowledgements[0].value.actionId);

  const restarted = fixture.createReview();
  const opened = await restarted.openSession({ sessionId: "review-concurrent-session" });
  assert.equal(opened.replayedActions, 1);
  const recovered = await restarted.getState(FAMILY_KEY);
  assert.equal(recovered.enrolled, true);
  assert.equal(recovered.lastActionId, acknowledgements[0].value.actionId);
  assert.equal(recovered.lastActionSequence, 1);
});
