#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const require = createRequire(import.meta.url);
const EXPECTED_FSRS_VERSION = "5.4.2";
const EXPECTED_LEITNER_VERSION = "leitner-utc-v1";
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const DEFAULT_FIXTURE_PATH = fileURLToPath(new URL("../tests/fixtures/learning-fsrs-evaluation-v1.json", import.meta.url));
// Updated only alongside the immutable synthetic fixture and its integrity test.
const DEFAULT_FIXTURE_SHA256 = "1fbb9ae4a7064923069d6d1c3a61fbd68a1836f7988f055401ba862880583824";
const ACTION_TO_FSRS_RATING = Object.freeze({ remember: "Good", forget: "Again" });

const { LEITNER_SCHEDULER_VERSION, LeitnerScheduler } = require("../plugin/learning/scheduler.cjs");

function evaluationError(code, message) {
  const error = new Error(message);
  error.name = "LearningFsrsEvaluationError";
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseUtc(value, field) {
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw evaluationError("FSRS_EVAL_UTC_INVALID", `${field} must be a canonical UTC ISO timestamp ending in Z.`);
  }
  return new Date(value);
}

function packageRootFor(entryPath) {
  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const metadata = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (metadata.name === "ts-fsrs") return { root: current, metadata };
      } catch {
        // Continue walking; the resolved package entry remains authoritative.
      }
    }
    current = path.dirname(current);
  }
  throw evaluationError("FSRS_EVAL_PACKAGE_UNRESOLVED", "Could not identify the resolved ts-fsrs package metadata.");
}

export function loadFsrsPackage() {
  const configuredPath = process.env.LEARNING_FSRS_PACKAGE_PATH;
  const entryPath = configuredPath
    ? require.resolve(path.resolve(configuredPath))
    : require.resolve("ts-fsrs");
  const { root, metadata } = packageRootFor(entryPath);
  if (metadata.version !== EXPECTED_FSRS_VERSION) {
    throw evaluationError("FSRS_EVAL_VERSION_MISMATCH", `Expected ts-fsrs ${EXPECTED_FSRS_VERSION}, found ${metadata.version || "unknown"}.`);
  }
  const api = require(entryPath);
  for (const key of ["fsrs", "createEmptyCard", "Rating", "State"]) {
    if (!api || typeof api[key] !== (key === "Rating" || key === "State" ? "object" : "function")) {
      throw evaluationError("FSRS_EVAL_API_MISMATCH", `ts-fsrs ${EXPECTED_FSRS_VERSION} does not export the required ${key} API.`);
    }
  }
  return Object.freeze({ api, version: metadata.version, packageRoot: root });
}

export function mapActionToFsrsRating(action, fsrsRating) {
  const ratingName = ACTION_TO_FSRS_RATING[action];
  if (!ratingName) {
    throw evaluationError("FSRS_EVAL_NON_RATING_ACTION", `${String(action)} is not a review rating and cannot be mapped to FSRS.`);
  }
  const grade = fsrsRating?.[ratingName];
  if (!Number.isInteger(grade) || grade <= 0) {
    throw evaluationError("FSRS_EVAL_API_MISMATCH", `ts-fsrs did not expose Rating.${ratingName}.`);
  }
  return grade;
}

function validateCompleteHistory(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw evaluationError("FSRS_EVAL_SOURCE_INVALID", "A fixture source object is required.");
  }
  if (source.sourceKind === "legacy-vocabulary-aggregate") {
    return { status: "INSUFFICIENT_HISTORY", reason: "Legacy Vocabulary aggregates do not contain a complete ordered rating history." };
  }
  if (source.historyCompleteness !== "complete" || !Array.isArray(source.reviewHistory)) {
    return { status: "INSUFFICIENT_HISTORY", reason: "No explicitly complete rating history is available." };
  }
  if (typeof source.itemId !== "string" || !source.itemId || typeof source.externalId !== "string" || !source.externalId) {
    throw evaluationError("FSRS_EVAL_IDENTITY_INVALID", "A stable itemId and externalId are required for this evaluation fixture.");
  }
  const createdAt = parseUtc(source.createdAtUTC, "createdAtUTC");
  const branchEvents = source.reviewHistory.filter((event) => event?.onCurrentBranch === true);
  if (source.reviewHistory.some((event) => typeof event?.onCurrentBranch !== "boolean")) {
    throw evaluationError("FSRS_EVAL_BRANCH_EVIDENCE_MISSING", "Every history event must explicitly identify whether it is on the current branch.");
  }
  const sorted = branchEvents.slice().sort((left, right) =>
    (left.sequence || 0) - (right.sequence || 0) ||
    String(left.reviewedAtUTC || "").localeCompare(String(right.reviewedAtUTC || "")) ||
    String(left.eventId || "").localeCompare(String(right.eventId || "")));
  const eventIds = new Set();
  const actionIds = new Set();
  let prior = null;
  let previousTime = createdAt.getTime() - 1;
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index];
    if (!event || typeof event !== "object" || event.schemaVersion !== 1 || event.itemId !== source.itemId ||
        typeof event.eventId !== "string" || !event.eventId || typeof event.actionId !== "string" || !event.actionId ||
        !Number.isSafeInteger(event.sequence) || event.sequence !== index + 1 ||
        !(event.previousEventId === null || typeof event.previousEventId === "string") ||
        event.schedulerVersion !== EXPECTED_LEITNER_VERSION || !Object.hasOwn(ACTION_TO_FSRS_RATING, event.rating)) {
      if (event && (event.rating === "skip" || event.rating === "known")) {
        throw evaluationError("FSRS_EVAL_NON_RATING_ACTION", `${event.rating} is not a review rating and cannot be replayed as FSRS.`);
      }
      throw evaluationError("FSRS_EVAL_HISTORY_INVALID", `Current-branch rating event ${index + 1} is malformed or unsupported.`);
    }
    const reviewedAt = parseUtc(event.reviewedAtUTC, `reviewHistory[${index}].reviewedAtUTC`);
    if (reviewedAt.getTime() <= previousTime || event.previousEventId !== (prior?.eventId || null) ||
        eventIds.has(event.eventId) || actionIds.has(event.actionId)) {
      throw evaluationError("FSRS_EVAL_HISTORY_CHAIN_INVALID", "Current-branch events must have unique IDs, increasing UTC times, and a complete predecessor chain.");
    }
    previousTime = reviewedAt.getTime();
    eventIds.add(event.eventId);
    actionIds.add(event.actionId);
    prior = event;
  }
  const storedHeadEventId = source.lastReviewEvent == null ? null : source.lastReviewEvent.eventId;
  if (storedHeadEventId !== (prior?.eventId || null)) {
    throw evaluationError("FSRS_EVAL_HISTORY_HEAD_MISMATCH", "The rating history does not reach the stored event head.");
  }
  if (prior && source.lastReviewEvent?.itemId !== source.itemId) {
    throw evaluationError("FSRS_EVAL_HISTORY_HEAD_MISMATCH", "The last review event belongs to another learning item.");
  }
  if (prior) {
    const headCandidate = { ...prior };
    delete headCandidate.onCurrentBranch;
    if (!isDeepStrictEqual(source.lastReviewEvent, headCandidate)) {
      throw evaluationError("FSRS_EVAL_HISTORY_HEAD_MISMATCH", "The stored review event head differs from its current-branch history record.");
    }
  }
  if (!source.storedLeitnerState || typeof source.storedLeitnerState !== "object" || Array.isArray(source.storedLeitnerState)) {
    throw evaluationError("FSRS_EVAL_LEITNER_SNAPSHOT_MISSING", "A stored Leitner state snapshot is required for reversible comparison.");
  }
  return { status: "COMPLETE", createdAt, events: sorted };
}

function serializeCard(card, State) {
  if (!(card?.due instanceof Date) || !Number.isFinite(card.due.getTime())) {
    throw evaluationError("FSRS_EVAL_CARD_INVALID", "ts-fsrs returned a card without a valid due Date.");
  }
  return {
    state: State[card.state],
    dueAtUTC: card.due.toISOString(),
    lastReviewedAtUTC: card.last_review instanceof Date ? card.last_review.toISOString() : null,
    stability: card.stability,
    difficulty: card.difficulty,
    scheduledDays: card.scheduled_days,
    reps: card.reps,
    lapses: card.lapses,
  };
}

export function evaluateFsrsReplay(source, fsrsPackage) {
  if (fsrsPackage?.version !== EXPECTED_FSRS_VERSION || !fsrsPackage.api) {
    throw evaluationError("FSRS_EVAL_VERSION_MISMATCH", `The evaluation requires the real ts-fsrs ${EXPECTED_FSRS_VERSION} package.`);
  }
  const validated = validateCompleteHistory(source);
  if (validated.status !== "COMPLETE") {
    return {
      status: validated.status,
      reason: validated.reason,
      sourceKind: source?.sourceKind || "unknown",
      migrationMode: "simulation-only",
      authoritativeWrites: 0,
    };
  }
  if (LEITNER_SCHEDULER_VERSION !== EXPECTED_LEITNER_VERSION) {
    throw evaluationError("FSRS_EVAL_LEITNER_VERSION_MISMATCH", "The existing Leitner comparator version changed; review this experiment before continuing.");
  }

  const { api, version } = fsrsPackage;
  const storedStateBytesBefore = JSON.stringify(source.storedLeitnerState);
  const sourceBytesBefore = JSON.stringify(source);
  const leitner = new LeitnerScheduler();
  let leitnerState = leitner.initialState(source.createdAtUTC);
  let card = api.createEmptyCard(validated.createdAt);
  const scheduler = api.fsrs({ enable_fuzz: false, enable_short_term: false, learning_steps: [], relearning_steps: [] });
  const replayedEvents = [];

  for (const event of validated.events) {
    const at = parseUtc(event.reviewedAtUTC, "reviewedAtUTC");
    const fsrsGrade = mapActionToFsrsRating(event.rating, api.Rating);
    leitnerState = leitner.schedule(leitnerState, event.rating, event.reviewedAtUTC).state;
    const transition = scheduler.next(card, at, fsrsGrade);
    card = transition.card;
    replayedEvents.push({
      eventId: event.eventId,
      sequence: event.sequence,
      reviewedAtUTC: event.reviewedAtUTC,
      sourceRating: event.rating,
      fsrsRating: api.Rating[fsrsGrade],
      fsrsDueAtUTC: transition.card.due.toISOString(),
    });
  }

  if (!isDeepStrictEqual(leitnerState, source.storedLeitnerState)) {
    throw evaluationError("FSRS_EVAL_LEITNER_REPLAY_MISMATCH", "The complete history does not reproduce the stored Leitner state exactly.");
  }
  const fsrsState = serializeCard(card, api.State);
  const storedStateBytesAfter = JSON.stringify(source.storedLeitnerState);
  const migrationProposal = {
    schedulerVersion: `ts-fsrs@${version}`,
    itemId: source.itemId,
    card: fsrsState,
    previousStateSnapshot: JSON.parse(storedStateBytesBefore),
  };
  const undoState = JSON.parse(JSON.stringify(migrationProposal.previousStateSnapshot));
  const undoStateBytes = JSON.stringify(undoState);
  const sourceBytesAfter = JSON.stringify(source);

  return {
    status: "COMPLETE",
    sourceKind: source.sourceKind || "learning-item-synthetic",
    itemId: source.itemId,
    externalId: source.externalId,
    package: { name: "ts-fsrs", version },
    configuration: { enableFuzz: false, enableShortTerm: false, learningSteps: [], relearningSteps: [] },
    ratingMapping: { remember: "Good", forget: "Again", known: "excluded-non-rating", skip: "excluded-session-action" },
    replay: { completeHistoryEvents: validated.events.length, branchesIgnored: source.reviewHistory.length - validated.events.length, events: replayedEvents },
    comparison: {
      leitner: { schedulerVersion: leitner.version, state: leitnerState },
      fsrs: fsrsState,
      dueDeltaMilliseconds: Date.parse(fsrsState.dueAtUTC) - Date.parse(leitnerState.dueAt),
      dueDeltaDays: (Date.parse(fsrsState.dueAtUTC) - Date.parse(leitnerState.dueAt)) / DAY_MS,
    },
    reversibleMigrationSimulation: {
      mode: "simulation-only",
      authoritativeWrites: 0,
      proposedSchedulerVersion: migrationProposal.schedulerVersion,
      proposedStateSha256: sha256(JSON.stringify(migrationProposal.card)),
      proposalContainsUndoSnapshot: true,
      storedLeitnerStateSha256: sha256(storedStateBytesBefore),
      sourceStateBytesUnchanged: storedStateBytesBefore === storedStateBytesAfter,
      undoRestoresOriginalBytes: storedStateBytesBefore === undoStateBytes,
      fullSourceBytesUnchanged: sourceBytesBefore === sourceBytesAfter,
    },
  };
}

export function readEvaluationFixture(fixturePath = DEFAULT_FIXTURE_PATH, expectedSha256 = null) {
  const raw = readFileSync(fixturePath);
  const actualSha256 = sha256(raw);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw evaluationError("FSRS_EVAL_FIXTURE_HASH_MISMATCH", `Fixture SHA-256 mismatch: expected ${expectedSha256}, received ${actualSha256}.`);
  }
  let fixture;
  try {
    fixture = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw evaluationError("FSRS_EVAL_FIXTURE_INVALID", `Could not parse evaluation fixture: ${error.message}`);
  }
  return { fixture, sha256: actualSha256, path: path.resolve(fixturePath) };
}

async function main() {
  const args = process.argv.slice(2);
  const fixtureArgIndex = args.indexOf("--fixture");
  if (fixtureArgIndex >= 0 && !args[fixtureArgIndex + 1]) {
    throw evaluationError("FSRS_EVAL_ARGUMENT_INVALID", "--fixture requires a JSON path.");
  }
  const fixturePath = fixtureArgIndex >= 0 ? path.resolve(args[fixtureArgIndex + 1]) : DEFAULT_FIXTURE_PATH;
  const checkedFixture = readEvaluationFixture(fixturePath, fixturePath === DEFAULT_FIXTURE_PATH ? DEFAULT_FIXTURE_SHA256 : null);
  const result = evaluateFsrsReplay(checkedFixture.fixture, loadFsrsPackage());
  process.stdout.write(`${JSON.stringify({ fixtureSha256: checkedFixture.sha256, result }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code || "FSRS_EVAL_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

export const evaluationConstants = Object.freeze({
  EXPECTED_FSRS_VERSION,
  EXPECTED_LEITNER_VERSION,
  DEFAULT_FIXTURE_PATH,
  DEFAULT_FIXTURE_SHA256,
});
