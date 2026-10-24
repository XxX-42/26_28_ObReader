import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import {
  evaluateFsrsReplay,
  loadFsrsPackage,
  evaluationConstants,
} from "./learning-fsrs-evaluation.mjs";

const LEARNING_STORE_ID = "learning-items-v1";
const HISTORY_KIND = "vocabulary-history-batch";
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const REASON = Object.freeze({
  LEGACY_AGGREGATE: "LEGACY_AGGREGATE",
  MISSING_ITEM: "MISSING_ITEM",
  MISSING_HISTORY: "MISSING_HISTORY",
  HISTORY_GRAPH_INVALID: "HISTORY_GRAPH_INVALID",
  HISTORY_CHAIN_INVALID: "HISTORY_CHAIN_INVALID",
  UTC_OR_ORDER_INVALID: "UTC_OR_ORDER_INVALID",
  IDENTITY_INVALID: "IDENTITY_INVALID",
  STATE_PARITY_MISMATCH: "STATE_PARITY_MISMATCH",
});
const require = createRequire(import.meta.url);
const { LeitnerScheduler } = require("../plugin/learning/scheduler.cjs");

function insufficient(reasonCode) {
  return { status: "INSUFFICIENT_HISTORY", reasonCode };
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function validUtc(value) {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function ratingBatchEvent(batch, itemId) {
  if (!batch || batch.actionKind !== "learning-rating") return null;
  const entityMatches = Array.isArray(batch.entities) ? batch.entities.filter((entity) =>
    entity?.storeId === LEARNING_STORE_ID && entity?.entityId === itemId) : [];
  const targetChanges = Array.isArray(batch.changes) ? batch.changes.filter((change) =>
    change?.storeId === LEARNING_STORE_ID && change?.entityId === itemId) : [];
  if (!entityMatches?.length && !targetChanges.length) return null;

  if (![1, 2].includes(batch.schemaVersion) || batch.kind !== HISTORY_KIND || batch.revision !== 1 ||
      typeof batch.batchId !== "string" || typeof batch.deviceId !== "string" ||
      entityMatches.length !== 1 || entityMatches[0].kind !== "record" || targetChanges.length !== 2) {
    return { invalid: REASON.HISTORY_GRAPH_INVALID };
  }

  const eventChanges = targetChanges.filter((change) => change.field === "lastReviewEvent" &&
    change.fieldPath?.length === 3 && change.fieldPath[0] === "records" &&
    change.fieldPath[1] === itemId && change.fieldPath[2] === "lastReviewEvent");
  const stateChanges = targetChanges.filter((change) => change.field === "reviewState" &&
    change.fieldPath?.length === 3 && change.fieldPath[0] === "records" &&
    change.fieldPath[1] === itemId && change.fieldPath[2] === "reviewState");
  if (eventChanges.length !== 1 || stateChanges.length !== 1) {
    return { invalid: REASON.HISTORY_GRAPH_INVALID };
  }
  const eventChange = eventChanges[0];
  const stateChange = stateChanges[0];
  if (eventChange.kind !== "field" || stateChange.kind !== "field" ||
      !eventChange.beforeExists || !eventChange.afterExists || !stateChange.beforeExists || !stateChange.afterExists ||
      !eventChange.after || !stateChange.after || typeof eventChange.after !== "object" || typeof stateChange.after !== "object") {
    return { invalid: REASON.HISTORY_GRAPH_INVALID };
  }
  const event = eventChange.after;
  if (event.itemId !== itemId || typeof event.actionId !== "string" || !event.actionId ||
      batch.batchId !== `learning-rating-${sha256(event.actionId)}`) {
    return { invalid: REASON.IDENTITY_INVALID };
  }
  return { event, eventBefore: eventChange.before, stateBefore: stateChange.before, stateAfter: stateChange.after };
}

function reasonForEvaluationError(error) {
  const reasons = {
    FSRS_EVAL_LEITNER_REPLAY_MISMATCH: REASON.STATE_PARITY_MISMATCH,
    FSRS_EVAL_UTC_INVALID: REASON.UTC_OR_ORDER_INVALID,
    FSRS_EVAL_HISTORY_CHAIN_INVALID: REASON.HISTORY_CHAIN_INVALID,
    FSRS_EVAL_HISTORY_INVALID: REASON.HISTORY_GRAPH_INVALID,
    FSRS_EVAL_HISTORY_HEAD_MISMATCH: REASON.HISTORY_CHAIN_INVALID,
    FSRS_EVAL_BRANCH_EVIDENCE_MISSING: REASON.HISTORY_CHAIN_INVALID,
    FSRS_EVAL_IDENTITY_INVALID: REASON.IDENTITY_INVALID,
    FSRS_EVAL_SOURCE_INVALID: REASON.HISTORY_GRAPH_INVALID,
    FSRS_EVAL_LEITNER_SNAPSHOT_MISSING: REASON.STATE_PARITY_MISMATCH,
    FSRS_EVAL_NON_RATING_ACTION: REASON.HISTORY_GRAPH_INVALID,
  };
  return reasons[error?.code] || null;
}

/**
 * Join the current Learning item snapshot with immutable History rating batches.
 * Only scheduling fields and rating events are retained; source paths, prompts,
 * answers, source text, and export metadata are intentionally discarded.
 */
export function createFsrsDevEvaluationSource(item, historyBatches) {
  if (item?.sourceKind === "legacy-vocabulary-aggregate") {
    return insufficient(REASON.LEGACY_AGGREGATE);
  }
  if (!item || typeof item !== "object" || Array.isArray(item) || !item.itemId) {
    return insufficient(REASON.MISSING_ITEM);
  }
  if (!Array.isArray(historyBatches)) return insufficient(REASON.MISSING_HISTORY);
  if (typeof item.itemId !== "string" || !item.itemId || typeof item.externalId !== "string" || !item.externalId ||
      !validUtc(item.createdAt) || !item.reviewState || typeof item.reviewState !== "object" ||
      !(item.lastReviewEvent === null || (item.lastReviewEvent && typeof item.lastReviewEvent === "object"))) {
    return insufficient(REASON.IDENTITY_INVALID);
  }

  const rows = [];
  for (const batch of historyBatches) {
    const extracted = ratingBatchEvent(batch, item.itemId);
    if (!extracted) continue;
    if (extracted.invalid) return insufficient(extracted.invalid);
    rows.push(extracted);
  }

  const eventsById = new Map();
  const actionIds = new Set();
  for (const row of rows) {
    const event = row.event;
    if (event.schemaVersion !== 1 || event.schedulerVersion !== evaluationConstants.EXPECTED_LEITNER_VERSION) {
      return insufficient(REASON.HISTORY_GRAPH_INVALID);
    }
    if (typeof event.eventId !== "string" || !event.eventId || eventsById.has(event.eventId) || actionIds.has(event.actionId)) {
      return insufficient(REASON.HISTORY_GRAPH_INVALID);
    }
    if (!validUtc(event.reviewedAtUTC)) return insufficient(REASON.UTC_OR_ORDER_INVALID);
    if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
        !(event.previousEventId === null || (typeof event.previousEventId === "string" && event.previousEventId))) {
      return insufficient(REASON.HISTORY_CHAIN_INVALID);
    }
    eventsById.set(event.eventId, row);
    actionIds.add(event.actionId);
  }

  const graphEvents = [...eventsById.values()].map(({ event }) => event);
  const createdAtMs = Date.parse(item.createdAt);
  for (const event of graphEvents) {
    const reviewedAtMs = Date.parse(event.reviewedAtUTC);
    if (reviewedAtMs <= createdAtMs) return insufficient(REASON.UTC_OR_ORDER_INVALID);
    if (event.previousEventId === null) {
      if (event.sequence !== 1) return insufficient(REASON.HISTORY_CHAIN_INVALID);
      continue;
    }
    const previous = eventsById.get(event.previousEventId)?.event;
    if (!previous) return insufficient(REASON.HISTORY_CHAIN_INVALID);
    if (event.sequence !== previous.sequence + 1) return insufficient(REASON.HISTORY_CHAIN_INVALID);
    if (reviewedAtMs <= Date.parse(previous.reviewedAtUTC)) return insufficient(REASON.UTC_OR_ORDER_INVALID);
  }

  const roots = graphEvents.filter((event) => event.previousEventId === null);
  if (graphEvents.length && roots.length !== 1) return insufficient(REASON.HISTORY_CHAIN_INVALID);

  const currentEventIds = new Set();
  let head = item.lastReviewEvent;
  if (head !== null) {
    const storedHead = eventsById.get(head.eventId)?.event;
    if (!storedHead || !isDeepStrictEqual(storedHead, head)) return insufficient(REASON.HISTORY_CHAIN_INVALID);
    const seen = new Set();
    while (head) {
      if (seen.has(head.eventId)) return insufficient(REASON.HISTORY_CHAIN_INVALID);
      seen.add(head.eventId);
      currentEventIds.add(head.eventId);
      const previousEventId = head.previousEventId;
      head = previousEventId === null ? null : eventsById.get(previousEventId)?.event;
      if (previousEventId !== null && !head) return insufficient(REASON.HISTORY_CHAIN_INVALID);
    }
  }

  const scheduler = new LeitnerScheduler();
  const statesByEventId = new Map();
  const orderedEvents = graphEvents.slice().sort((left, right) => left.sequence - right.sequence ||
    left.reviewedAtUTC.localeCompare(right.reviewedAtUTC) || left.eventId.localeCompare(right.eventId));
  for (const event of orderedEvents) {
    if (event.rating !== "remember" && event.rating !== "forget") return insufficient(REASON.HISTORY_GRAPH_INVALID);
    const priorState = event.previousEventId === null
      ? scheduler.initialState(item.createdAt)
      : statesByEventId.get(event.previousEventId);
    if (!priorState) return insufficient(REASON.HISTORY_CHAIN_INVALID);
    const row = eventsById.get(event.eventId);
    const expectedPreviousEvent = event.previousEventId === null
      ? null : eventsById.get(event.previousEventId).event;
    if (!isDeepStrictEqual(row.eventBefore, expectedPreviousEvent)) {
      return insufficient(REASON.HISTORY_CHAIN_INVALID);
    }
    if (!isDeepStrictEqual(row.stateBefore, priorState)) {
      return insufficient(REASON.STATE_PARITY_MISMATCH);
    }
    const expectedState = scheduler.rate(priorState, event.rating, event.reviewedAtUTC).state;
    if (!isDeepStrictEqual(eventsById.get(event.eventId).stateAfter, expectedState)) {
      return insufficient(REASON.STATE_PARITY_MISMATCH);
    }
    statesByEventId.set(event.eventId, expectedState);
  }
  const expectedCurrentState = item.lastReviewEvent
    ? statesByEventId.get(item.lastReviewEvent.eventId)
    : scheduler.initialState(item.createdAt);
  if (!expectedCurrentState || !isDeepStrictEqual(expectedCurrentState, item.reviewState)) {
    return insufficient(REASON.STATE_PARITY_MISMATCH);
  }

  return {
    status: "READY",
    source: {
      sourceKind: "learning-item-history-graph",
      historyCompleteness: "complete",
      itemId: item.itemId,
      externalId: item.externalId,
      createdAtUTC: item.createdAt,
      storedLeitnerState: item.reviewState,
      lastReviewEvent: item.lastReviewEvent,
      reviewHistory: graphEvents.map((event) => ({ ...event, onCurrentBranch: currentEventIds.has(event.eventId) })),
    },
  };
}

function validateAsOfUTC(asOfUTC) {
  if (!validUtc(asOfUTC)) {
    const error = new TypeError("asOfUTC must be a canonical UTC ISO timestamp.");
    error.code = "FSRS_DEV_AS_OF_INVALID";
    throw error;
  }
}

function emptyBuckets() {
  return {
    overdue: 0,
    dueWithin1Day: 0,
    dueIn1To7Days: 0,
    dueAfter7Days: 0,
  };
}

function addDueToBuckets(buckets, dueAtUTC, asOfMs) {
  const dueMs = Date.parse(dueAtUTC);
  if (dueMs < asOfMs) buckets.overdue += 1;
  else if (dueMs < asOfMs + DAY_MS) buckets.dueWithin1Day += 1;
  else if (dueMs < asOfMs + 7 * DAY_MS) buckets.dueIn1To7Days += 1;
  else buckets.dueAfter7Days += 1;
}

function median(numbers) {
  if (!numbers.length) return null;
  const sorted = numbers.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Evaluate a fixed-date cohort. The result is aggregate-only: no item IDs,
 * source fields, individual event rows, or vault paths are returned.
 */
export function evaluateFsrsDevCohort(records, { asOfUTC, fsrsPackage = loadFsrsPackage() } = {}) {
  validateAsOfUTC(asOfUTC);
  if (!Array.isArray(records)) throw new TypeError("A cohort array is required.");
  if (fsrsPackage?.version !== evaluationConstants.EXPECTED_FSRS_VERSION || !fsrsPackage.api) {
    const error = new TypeError(`The development cohort requires ts-fsrs ${evaluationConstants.EXPECTED_FSRS_VERSION}.`);
    error.code = "FSRS_EVAL_VERSION_MISMATCH";
    throw error;
  }
  const identityCounts = new Map();
  for (const record of records) {
    const itemId = record?.status === "READY" ? record.source?.itemId : record?.item?.itemId;
    if (typeof itemId === "string" && itemId) identityCounts.set(itemId, (identityCounts.get(itemId) || 0) + 1);
  }
  const resultRows = [];
  const insufficientByReason = {};
  for (const record of records) {
    const itemId = record?.status === "READY" ? record.source?.itemId : record?.item?.itemId;
    if (typeof itemId === "string" && identityCounts.get(itemId) > 1) {
      insufficientByReason[REASON.IDENTITY_INVALID] = (insufficientByReason[REASON.IDENTITY_INVALID] || 0) + 1;
      continue;
    }
    let sourceResult;
    if (record?.status === "READY") sourceResult = record;
    else if (record?.status === "INSUFFICIENT_HISTORY") sourceResult = record;
    else if (record?.sourceKind === "legacy-vocabulary-aggregate") sourceResult = insufficient(REASON.LEGACY_AGGREGATE);
    else sourceResult = createFsrsDevEvaluationSource(record?.item, record?.historyBatches);
    if (sourceResult.status !== "READY") {
      const reasonCode = sourceResult.reasonCode || REASON.MISSING_HISTORY;
      insufficientByReason[reasonCode] = (insufficientByReason[reasonCode] || 0) + 1;
      continue;
    }
    try {
      const replay = evaluateFsrsReplay(sourceResult.source, fsrsPackage);
      if (replay.status !== "COMPLETE") {
        const reasonCode = sourceResult.source.sourceKind === "legacy-vocabulary-aggregate"
          ? REASON.LEGACY_AGGREGATE : REASON.MISSING_HISTORY;
        insufficientByReason[reasonCode] = (insufficientByReason[reasonCode] || 0) + 1;
        continue;
      }
      resultRows.push({
        fsrsDueAtUTC: replay.comparison.fsrs.dueAtUTC,
        leitnerDueAtUTC: replay.comparison.leitner.state.dueAt,
        dueDeltaDays: replay.comparison.dueDeltaDays,
      });
    } catch (error) {
      const reasonCode = reasonForEvaluationError(error);
      if (!reasonCode) throw error;
      insufficientByReason[reasonCode] = (insufficientByReason[reasonCode] || 0) + 1;
    }
  }

  const asOfMs = Date.parse(asOfUTC);
  const fsrsBuckets = emptyBuckets();
  const leitnerBuckets = emptyBuckets();
  let fsrsDueCount = 0;
  let leitnerDueCount = 0;
  const dueDeltas = [];
  let earlier = 0;
  let same = 0;
  let later = 0;
  let minDays = null;
  let maxDays = null;
  for (const row of resultRows) {
    const fsrsDueMs = Date.parse(row.fsrsDueAtUTC);
    const leitnerDueMs = Date.parse(row.leitnerDueAtUTC);
    if (fsrsDueMs <= asOfMs) fsrsDueCount += 1;
    if (leitnerDueMs <= asOfMs) leitnerDueCount += 1;
    addDueToBuckets(fsrsBuckets, row.fsrsDueAtUTC, asOfMs);
    addDueToBuckets(leitnerBuckets, row.leitnerDueAtUTC, asOfMs);
    dueDeltas.push(row.dueDeltaDays);
    minDays = minDays === null ? row.dueDeltaDays : Math.min(minDays, row.dueDeltaDays);
    maxDays = maxDays === null ? row.dueDeltaDays : Math.max(maxDays, row.dueDeltaDays);
    if (row.dueDeltaDays < 0) earlier += 1;
    else if (row.dueDeltaDays > 0) later += 1;
    else same += 1;
  }
  const dueDeltaMeanDays = dueDeltas.length
    ? dueDeltas.reduce((total, value) => total + value, 0) / dueDeltas.length
    : null;

  return {
    status: "COMPLETE",
    interpretation: "Fixed-date queue estimates only; these are not retention outcomes or counterfactual total review-load estimates.",
    asOfUTC,
    schedulerVersions: {
      fsrs: `ts-fsrs@${fsrsPackage.version}`,
      leitner: evaluationConstants.EXPECTED_LEITNER_VERSION,
    },
    cohort: {
      inputItems: records.length,
      eligibleItems: resultRows.length,
      insufficientHistoryItems: records.length - resultRows.length,
      insufficientByReason: Object.fromEntries(Object.entries(insufficientByReason).sort(([left], [right]) => left.localeCompare(right))),
    },
    nextDueQueueEstimates: {
      fsrs: { dueCount: fsrsDueCount, buckets: fsrsBuckets },
      leitner: { dueCount: leitnerDueCount, buckets: leitnerBuckets },
      fsrsMinusLeitnerDueDelta: {
        earlierItems: earlier,
        sameDueItems: same,
        laterItems: later,
        meanDays: dueDeltaMeanDays,
        medianDays: median(dueDeltas),
        minDays,
        maxDays,
      },
    },
    authoritativeWrites: 0,
  };
}

/**
 * Read-only integration adapter for the existing Learning service and History.
 * getItem supplies createdAt/current state/head; listBatches supplies the
 * immutable rating graph. The temporary item snapshots never leave memory.
 */
export async function evaluateLearningServiceFsrsCohort({ service, history, itemIds, asOfUTC, fsrsPackage } = {}) {
  if (!service || typeof service.getItem !== "function" || !history || typeof history.listBatches !== "function") {
    throw new TypeError("The read-only FSRS adapter requires Learning getItem and History listBatches APIs.");
  }
  if (!Array.isArray(itemIds) || itemIds.some((itemId) => typeof itemId !== "string" || !itemId)) {
    throw new TypeError("The read-only FSRS adapter requires an array of item IDs.");
  }
  const batches = await history.listBatches();
  const records = [];
  for (const itemId of itemIds) {
    const item = await service.getItem(itemId);
    records.push({ item, historyBatches: batches });
  }
  return evaluateFsrsDevCohort(records, { asOfUTC, ...(fsrsPackage ? { fsrsPackage } : {}) });
}

export const fsrsDevAdapterConstants = Object.freeze({
  LEARNING_STORE_ID,
  HISTORY_KIND,
  insufficientReasons: REASON,
});
