import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluationConstants,
  evaluateFsrsReplay,
  loadFsrsPackage,
  mapActionToFsrsRating,
  readEvaluationFixture,
} from "../scripts/learning-fsrs-evaluation.mjs";

const packageUnderTest = loadFsrsPackage();
const checkedFixture = readEvaluationFixture(
  evaluationConstants.DEFAULT_FIXTURE_PATH,
  evaluationConstants.DEFAULT_FIXTURE_SHA256,
);

test("the committed synthetic replay fixture has a pinned integrity hash", () => {
  const bytes = readFileSync(evaluationConstants.DEFAULT_FIXTURE_PATH);
  assert.equal(checkedFixture.sha256, "1fbb9ae4a7064923069d6d1c3a61fbd68a1836f7988f055401ba862880583824");
  assert.equal(bytes.byteLength > 0, true);
  assert.equal(packageUnderTest.version, "5.4.2");
});

test("complete current-branch rating history replays through the real FSRS 5.4.2 API", () => {
  const sourceBefore = JSON.stringify(checkedFixture.fixture);
  const report = evaluateFsrsReplay(checkedFixture.fixture, packageUnderTest);

  assert.equal(report.status, "COMPLETE");
  assert.deepEqual(report.package, { name: "ts-fsrs", version: "5.4.2" });
  assert.equal(report.replay.completeHistoryEvents, 5);
  assert.equal(report.replay.branchesIgnored, 1);
  assert.deepEqual(report.replay.events.map((event) => event.fsrsRating), ["Good", "Good", "Again", "Good", "Good"]);
  assert.deepEqual(report.comparison.leitner.state, checkedFixture.fixture.storedLeitnerState);
  assert.equal(report.comparison.fsrs.dueAtUTC, "2026-10-24T09:00:00.000Z");
  assert.equal(report.comparison.dueDeltaDays, 2);
  assert.equal(report.reversibleMigrationSimulation.authoritativeWrites, 0);
  assert.equal(report.reversibleMigrationSimulation.proposedSchedulerVersion, "ts-fsrs@5.4.2");
  assert.equal(report.reversibleMigrationSimulation.proposalContainsUndoSnapshot, true);
  assert.equal(report.reversibleMigrationSimulation.sourceStateBytesUnchanged, true);
  assert.equal(report.reversibleMigrationSimulation.undoRestoresOriginalBytes, true);
  assert.equal(report.reversibleMigrationSimulation.fullSourceBytesUnchanged, true);
  assert.equal(JSON.stringify(checkedFixture.fixture), sourceBefore);
});

test("known and skip are not mapped to an FSRS rating", () => {
  assert.equal(mapActionToFsrsRating("remember", packageUnderTest.api.Rating), packageUnderTest.api.Rating.Good);
  assert.equal(mapActionToFsrsRating("forget", packageUnderTest.api.Rating), packageUnderTest.api.Rating.Again);
  for (const nonRatingAction of ["known", "skip"]) {
    assert.throws(
      () => mapActionToFsrsRating(nonRatingAction, packageUnderTest.api.Rating),
      (error) => error.code === "FSRS_EVAL_NON_RATING_ACTION",
    );

    const source = structuredClone(checkedFixture.fixture);
    source.reviewHistory[0].rating = nonRatingAction;
    assert.throws(
      () => evaluateFsrsReplay(source, packageUnderTest),
      (error) => error.code === "FSRS_EVAL_NON_RATING_ACTION",
    );
  }
});

test("aggregate-only old Vocabulary state fails closed without inventing review ratings", () => {
  const source = {
    sourceKind: "legacy-vocabulary-aggregate",
    historyCompleteness: "complete",
    reviewHistory: [],
    familyKey: "en-family:v1:word:[\"sample\"]",
    storedLeitnerState: { box: 4, dueAt: "2026-10-22T09:00:00.000Z", reviewCount: 8 },
  };
  const api = new Proxy({}, { get() { throw new Error("FSRS must not be called for missing history."); } });
  assert.deepEqual(evaluateFsrsReplay(source, { version: "5.4.2", api }), {
    status: "INSUFFICIENT_HISTORY",
    reason: "Legacy Vocabulary aggregates do not contain a complete ordered rating history.",
    sourceKind: "legacy-vocabulary-aggregate",
    migrationMode: "simulation-only",
    authoritativeWrites: 0,
  });
});

test("non-UTC review evidence and broken branch chains are rejected", () => {
  const nonUtc = structuredClone(checkedFixture.fixture);
  nonUtc.reviewHistory.find((event) => event.onCurrentBranch).reviewedAtUTC = "2026-10-01T09:00:00.000+00:00";
  assert.throws(() => evaluateFsrsReplay(nonUtc, packageUnderTest), (error) => error.code === "FSRS_EVAL_UTC_INVALID");

  const brokenChain = structuredClone(checkedFixture.fixture);
  brokenChain.reviewHistory.find((event) => event.eventId === "learning-event:eval-3-current-branch").previousEventId = "unknown-event";
  assert.throws(() => evaluateFsrsReplay(brokenChain, packageUnderTest), (error) => error.code === "FSRS_EVAL_HISTORY_CHAIN_INVALID");
});

test("replay is local and does not invoke network-backed providers", () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = () => {
    networkCalls += 1;
    throw new Error("Unexpected network access during local FSRS replay.");
  };
  try {
    const first = evaluateFsrsReplay(checkedFixture.fixture, packageUnderTest);
    const second = evaluateFsrsReplay(checkedFixture.fixture, packageUnderTest);
    assert.deepEqual(first, second);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
