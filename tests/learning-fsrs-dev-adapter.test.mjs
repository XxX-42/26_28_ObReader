import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createFsrsDevEvaluationSource,
  evaluateFsrsDevCohort,
  evaluateLearningServiceFsrsCohort,
  fsrsDevAdapterConstants,
} from "../scripts/learning-fsrs-dev-adapter.mjs";
import { loadFsrsPackage } from "../scripts/learning-fsrs-evaluation.mjs";

const fsrsPackage = loadFsrsPackage();
const require = createRequire(import.meta.url);
const { LeitnerScheduler } = require("../plugin/learning/scheduler.cjs");
const fixture = JSON.parse(readFileSync(new URL("./fixtures/learning-fsrs-evaluation-v1.json", import.meta.url), "utf8"));
const asOfUTC = "2026-10-23T12:00:00.000Z";

function historyBatch(event, stateAfter, stateBefore, eventBefore) {
  const immutableEvent = structuredClone(event);
  delete immutableEvent.onCurrentBranch;
  return {
    schemaVersion: 2,
    kind: "vocabulary-history-batch",
    revision: 1,
    batchId: `learning-rating-${createHash("sha256").update(event.actionId).digest("hex")}`,
    deviceId: "synthetic-device",
    actionKind: "learning-rating",
    entities: [{ storeId: "learning-items-v1", entityId: event.itemId, kind: "record" }],
    changes: [
      {
        storeId: "learning-items-v1",
        entityId: event.itemId,
        kind: "field",
        field: "reviewState",
        fieldPath: ["records", event.itemId, "reviewState"],
        beforeExists: true,
        before: structuredClone(stateBefore),
        afterExists: true,
        after: structuredClone(stateAfter),
        path: "/private/vault/00_Archive/21_VocabularyData/learning/items/shard.json",
      },
      {
        storeId: "learning-items-v1",
        entityId: event.itemId,
        kind: "field",
        field: "lastReviewEvent",
        fieldPath: ["records", event.itemId, "lastReviewEvent"],
        beforeExists: true,
        before: structuredClone(eventBefore),
        afterExists: true,
        after: immutableEvent,
        path: "/private/vault/00_Archive/21_VocabularyData/learning/items/shard.json",
      },
    ],
  };
}

function makeSnapshot(sourceFixture = fixture, { shiftDays = 0, itemSuffix = "one" } = {}) {
  const shift = (value) => value == null ? value : new Date(Date.parse(value) + shiftDays * 24 * 60 * 60 * 1000).toISOString();
  const source = structuredClone(sourceFixture);
  source.itemId = `learning:v1:mock-${itemSuffix}`;
  source.externalId = `obreader-learning:v1:mock-${itemSuffix}`;
  source.createdAtUTC = shift(source.createdAtUTC);
  source.storedLeitnerState.dueAt = shift(source.storedLeitnerState.dueAt);
  source.storedLeitnerState.lastReviewedAt = shift(source.storedLeitnerState.lastReviewedAt);
  source.lastReviewEvent = source.lastReviewEvent && { ...source.lastReviewEvent, itemId: source.itemId,
    eventId: `learning-event:${itemSuffix}:${source.lastReviewEvent.eventId}`, actionId: `learning-action:${itemSuffix}:${source.lastReviewEvent.actionId}`,
    previousEventId: source.lastReviewEvent.previousEventId ? `learning-event:${itemSuffix}:${source.lastReviewEvent.previousEventId}` : null,
    reviewedAtUTC: shift(source.lastReviewEvent.reviewedAtUTC) };
  source.reviewHistory = source.reviewHistory.map((event) => ({
    ...event,
    itemId: source.itemId,
    eventId: `learning-event:${itemSuffix}:${event.eventId}`,
    actionId: `learning-action:${itemSuffix}:${event.actionId}`,
    previousEventId: event.previousEventId ? `learning-event:${itemSuffix}:${event.previousEventId}` : null,
    reviewedAtUTC: shift(event.reviewedAtUTC),
  }));

  const scheduler = new LeitnerScheduler();
  const stateAfterByEventId = new Map();
  const orderedEvents = source.reviewHistory.slice().sort((left, right) => left.sequence - right.sequence ||
    left.reviewedAtUTC.localeCompare(right.reviewedAtUTC));
  for (const event of orderedEvents) {
    const priorState = event.previousEventId === null
      ? scheduler.initialState(source.createdAtUTC)
      : stateAfterByEventId.get(event.previousEventId);
    stateAfterByEventId.set(event.eventId, scheduler.rate(priorState, event.rating, event.reviewedAtUTC).state);
  }
  const historyBatches = source.reviewHistory.map((event) => {
    const previous = source.reviewHistory.find((candidate) => candidate.eventId === event.previousEventId);
    const eventBefore = previous ? { ...previous } : null;
    if (eventBefore) delete eventBefore.onCurrentBranch;
    return historyBatch(event, stateAfterByEventId.get(event.eventId),
      previous ? stateAfterByEventId.get(previous.eventId) : scheduler.initialState(source.createdAtUTC), eventBefore);
  });
  const item = {
    itemId: source.itemId,
    externalId: source.externalId,
    createdAt: source.createdAtUTC,
    reviewState: structuredClone(source.storedLeitnerState),
    lastReviewEvent: structuredClone(source.lastReviewEvent),
    prompt: "private prompt that must not escape",
    answer: "private answer that must not escape",
    targetText: "private target text that must not escape",
    source: { sourcePath: "/private/vault/Notes/source.md", targetText: "private source text" },
  };
  return { item, historyBatches, source };
}

test("the read-only adapter joins getItem fields to immutable rating batches and marks the active branch", () => {
  const snapshot = makeSnapshot();
  const adapted = createFsrsDevEvaluationSource(snapshot.item, snapshot.historyBatches);

  assert.equal(adapted.status, "READY", JSON.stringify(adapted));
  assert.equal(adapted.source.createdAtUTC, fixture.createdAtUTC);
  assert.deepEqual(adapted.source.storedLeitnerState, fixture.storedLeitnerState);
  assert.equal(adapted.source.reviewHistory.length, 6);
  assert.equal(adapted.source.reviewHistory.filter((event) => event.onCurrentBranch).length, 5);
  assert.equal(adapted.source.reviewHistory.find((event) => event.eventId.endsWith("eval-3-undone-branch")).onCurrentBranch, false);
  const replay = evaluateFsrsDevCohort([{ status: "READY", ...adapted }], { asOfUTC, fsrsPackage });
  assert.equal(replay.cohort.eligibleItems, 1);
  assert.equal(replay.cohort.insufficientHistoryItems, 0);
  assert.equal(replay.authoritativeWrites, 0);

  const olderHistorySchema = structuredClone(snapshot.historyBatches);
  olderHistorySchema[0].schemaVersion = 1;
  assert.equal(createFsrsDevEvaluationSource(snapshot.item, olderHistorySchema).status, "READY");
});

test("multi-cohort fixed-date queue estimates include due buckets and scheduler deltas only", () => {
  const records = [
    makeSnapshot(fixture, { shiftDays: -3, itemSuffix: "early" }),
    makeSnapshot(fixture, { itemSuffix: "current" }),
    makeSnapshot(fixture, { shiftDays: 6, itemSuffix: "later" }),
  ];
  const report = evaluateFsrsDevCohort(records, { asOfUTC, fsrsPackage });

  assert.deepEqual(report.cohort, {
    inputItems: 3,
    eligibleItems: 3,
    insufficientHistoryItems: 0,
    insufficientByReason: {},
  });
  assert.deepEqual(report.nextDueQueueEstimates.leitner, {
    dueCount: 2,
    buckets: { overdue: 2, dueWithin1Day: 0, dueIn1To7Days: 1, dueAfter7Days: 0 },
  });
  assert.deepEqual(report.nextDueQueueEstimates.fsrs, {
    dueCount: 1,
    buckets: { overdue: 1, dueWithin1Day: 1, dueIn1To7Days: 1, dueAfter7Days: 0 },
  });
  assert.deepEqual(report.nextDueQueueEstimates.fsrsMinusLeitnerDueDelta, {
    earlierItems: 0,
    sameDueItems: 0,
    laterItems: 3,
    meanDays: 2,
    medianDays: 2,
    minDays: 2,
    maxDays: 2,
  });
  assert.match(report.interpretation, /not retention outcomes or counterfactual total review-load estimates/);
  assert.equal(report.authoritativeWrites, 0);
  const serialized = JSON.stringify(report);
  for (const sensitiveValue of ["mock-early", "private prompt", "private answer", "private target", "/private/vault", "sourcePath"]) {
    assert.equal(serialized.includes(sensitiveValue), false);
  }
});

test("ambiguous and incomplete graph evidence is counted as insufficient instead of guessed", () => {
  const valid = makeSnapshot(fixture, { itemSuffix: "valid" });
  const missingSequence = makeSnapshot(fixture, { itemSuffix: "gap" });
  missingSequence.historyBatches.find((batch) => batch.changes.some((change) => change.after?.sequence === 4))
    .changes.find((change) => change.field === "lastReviewEvent").after.sequence = 8;
  const duplicateEvent = makeSnapshot(fixture, { itemSuffix: "duplicate" });
  duplicateEvent.historyBatches.push(structuredClone(duplicateEvent.historyBatches[0]));
  const unorderedUtc = makeSnapshot(fixture, { itemSuffix: "utc" });
  unorderedUtc.historyBatches[0].changes.find((change) => change.field === "lastReviewEvent").after.reviewedAtUTC = "2026-10-01T10:00:00.000+00:00";
  const outOfOrder = makeSnapshot(fixture, { itemSuffix: "order" });
  outOfOrder.historyBatches.find((batch) => batch.changes.some((change) => change.after?.eventId?.endsWith("eval-5")))
    .changes.find((change) => change.field === "lastReviewEvent").after.reviewedAtUTC = "2026-10-11T08:59:00.000Z";
  outOfOrder.item.lastReviewEvent.reviewedAtUTC = "2026-10-11T08:59:00.000Z";
  const identityMismatch = makeSnapshot(fixture, { itemSuffix: "identity" });
  identityMismatch.historyBatches[0].changes.find((change) => change.field === "lastReviewEvent").after.itemId = "learning:v1:other";
  const stateMismatch = makeSnapshot(fixture, { itemSuffix: "state" });
  stateMismatch.item.reviewState.box += 1;
  const branchStateMismatch = makeSnapshot(fixture, { itemSuffix: "branch-state" });
  const undoneBatch = branchStateMismatch.historyBatches.find((batch) =>
    batch.changes.some((change) => change.after?.eventId?.endsWith("eval-3-undone-branch")));
  undoneBatch.changes.find((change) => change.field === "reviewState").after.box += 1;
  const branchAmbiguity = makeSnapshot(fixture, { itemSuffix: "branch" });
  branchAmbiguity.historyBatches.find((batch) => batch.changes.some((change) => change.after?.eventId?.endsWith("eval-5")))
    .changes.find((change) => change.field === "lastReviewEvent").after.previousEventId = "missing-parent";
  const missingHistoryItem = structuredClone(valid.item);
  missingHistoryItem.itemId = "learning:v1:mock-no-history";
  missingHistoryItem.externalId = "obreader-learning:v1:mock-no-history";

  const report = evaluateFsrsDevCohort([
    valid,
    missingSequence,
    duplicateEvent,
    unorderedUtc,
    outOfOrder,
    identityMismatch,
    stateMismatch,
    branchAmbiguity,
    branchStateMismatch,
    { item: missingHistoryItem, historyBatches: null },
    { sourceKind: "legacy-vocabulary-aggregate", aggregate: { box: 5, reviewCount: 12, dueAt: fixture.storedLeitnerState.dueAt } },
  ], { asOfUTC, fsrsPackage });

  assert.equal(report.cohort.inputItems, 11);
  assert.equal(report.cohort.eligibleItems, 1, JSON.stringify(report));
  assert.equal(report.cohort.insufficientHistoryItems, 10);
  assert.deepEqual(report.cohort.insufficientByReason, {
    HISTORY_CHAIN_INVALID: 2,
    HISTORY_GRAPH_INVALID: 1,
    IDENTITY_INVALID: 1,
    LEGACY_AGGREGATE: 1,
    MISSING_HISTORY: 1,
    STATE_PARITY_MISMATCH: 2,
    UTC_OR_ORDER_INVALID: 2,
  });
});

test("service adapter reads only getItem and History listBatches and returns no card or path fields", async () => {
  const snapshot = makeSnapshot(fixture, { itemSuffix: "service" });
  let batchReads = 0;
  let itemReads = 0;
  const report = await evaluateLearningServiceFsrsCohort({
    service: {
      async getItem(itemId) {
        itemReads += 1;
        assert.equal(itemId, snapshot.item.itemId);
        return structuredClone(snapshot.item);
      },
    },
    history: {
      async listBatches() {
        batchReads += 1;
        return structuredClone(snapshot.historyBatches);
      },
    },
    itemIds: [snapshot.item.itemId],
    asOfUTC,
    fsrsPackage,
  });

  assert.equal(batchReads, 1);
  assert.equal(itemReads, 1);
  assert.equal(report.cohort.eligibleItems, 1, JSON.stringify(report));
  assert.equal(report.authoritativeWrites, 0);
  assert.equal(JSON.stringify(report).includes(snapshot.item.itemId), false);
  assert.equal(JSON.stringify(report).includes("private"), false);
  assert.equal(fsrsDevAdapterConstants.LEARNING_STORE_ID, "learning-items-v1");
});

test("duplicate cohort identities fail closed and evaluation rejects an invalid fixed date or package", () => {
  const snapshot = makeSnapshot(fixture, { itemSuffix: "duplicate-cohort" });
  const duplicateIdentityReport = evaluateFsrsDevCohort([
    snapshot,
    structuredClone(snapshot),
  ], { asOfUTC, fsrsPackage });
  assert.equal(duplicateIdentityReport.cohort.eligibleItems, 0);
  assert.equal(duplicateIdentityReport.cohort.insufficientHistoryItems, 2);
  assert.deepEqual(duplicateIdentityReport.cohort.insufficientByReason, { IDENTITY_INVALID: 2 });
  assert.throws(() => evaluateFsrsDevCohort([], { asOfUTC: "2026-10-23T12:00:00+00:00", fsrsPackage }),
    (error) => error.code === "FSRS_DEV_AS_OF_INVALID");
  assert.throws(() => evaluateFsrsDevCohort([], { asOfUTC, fsrsPackage: { version: "5.4.1", api: {} } }),
    (error) => error.code === "FSRS_EVAL_VERSION_MISMATCH");
});

test("a current item with no reviews can still replay its initial state when retained events are undone", () => {
  const source = makeSnapshot(fixture, { itemSuffix: "undone" });
  const initial = {
    ...source.item,
    reviewState: {
      box: 1,
      dueAt: source.item.createdAt,
      lastReviewedAt: null,
      reviewCount: 0,
      lapseCount: 0,
    },
    lastReviewEvent: null,
  };
  // With a null head, every immutable event is retained as an undone branch.
  const adapted = createFsrsDevEvaluationSource(initial, source.historyBatches);
  assert.equal(adapted.status, "READY");
  const report = evaluateFsrsDevCohort([{ status: "READY", ...adapted }], { asOfUTC, fsrsPackage });
  assert.equal(report.cohort.eligibleItems, 1, JSON.stringify(report));
  assert.equal(report.cohort.insufficientHistoryItems, 0);
});


test("shadow replay requires matching batch pre-state and predecessor evidence without mutating input", () => {
  const valid = makeSnapshot(fixture, { itemSuffix: "before-evidence" });
  const before = JSON.stringify(valid);
  // Deliberately scramble physical batch order: the explicit predecessor chain determines replay order.
  valid.historyBatches.reverse();
  const shuffledBefore = JSON.stringify(valid);
  assert.equal(evaluateFsrsDevCohort([valid], { asOfUTC, fsrsPackage }).cohort.eligibleItems, 1);
  assert.equal(JSON.stringify(valid), shuffledBefore);
  valid.historyBatches.reverse();
  assert.equal(JSON.stringify(valid), before);

  for (const field of ["reviewState", "lastReviewEvent"]) {
    const malformed = structuredClone(valid);
    const batch = malformed.historyBatches.find((candidate) => candidate.changes.some((change) => change.after?.sequence === 2));
    const change = batch.changes.find((candidate) => candidate.field === field);
    change.before = field === "reviewState" ? { ...change.before, reviewCount: 99 } : null;
    const inputBefore = JSON.stringify(malformed);
    const report = evaluateFsrsDevCohort([malformed], { asOfUTC, fsrsPackage });
    assert.equal(report.cohort.eligibleItems, 0);
    assert.equal(report.cohort.insufficientHistoryItems, 1);
    assert.deepEqual(report.cohort.insufficientByReason,
      { [field === "reviewState" ? "STATE_PARITY_MISMATCH" : "HISTORY_CHAIN_INVALID"]: 1 });
    assert.equal(report.authoritativeWrites, 0);
    assert.equal(JSON.stringify(malformed), inputBefore);
  }
});


test("unsupported scheduler evidence on an undone branch is insufficient history", () => {
  const snapshot = makeSnapshot(fixture, { itemSuffix: "unsupported-branch" });
  const undone = snapshot.historyBatches.find((batch) => batch.changes.some((change) =>
    change.after?.eventId?.endsWith("eval-3-undone-branch")));
  undone.changes.find((change) => change.field === "lastReviewEvent").after.schedulerVersion = "unknown-v1";
  const report = evaluateFsrsDevCohort([snapshot], { asOfUTC, fsrsPackage });
  assert.equal(report.cohort.eligibleItems, 0);
  assert.deepEqual(report.cohort.insufficientByReason, { HISTORY_GRAPH_INVALID: 1 });
});
