"use strict";

const { canonicalHash, canonicalStringify, hashText } = require("./canonical.cjs");
const {
  createShardedStore,
  prepareShardedReplacement,
  manifestPathFor,
  readShardedStore,
  hasShardFilesFromAdapter,
} = require("./sharded-store.cjs");

const REVIEW_STORE_ID = "vocabulary-review-v1";
const REVIEW_ROOT = "00_Archive/21_VocabularyData/review/states";
const REVIEW_KIND = "review-state";
const REVIEW_INTERVAL_DAYS = Object.freeze([1, 3, 7, 14, 30]);
const REVIEW_STATE_FIELDS = Object.freeze([
  "enrolled", "box", "dueAt", "enrolledAt", "lastReviewedAt", "reviewCount", "lapseCount", "updatedAt",
]);
const HISTORY_MUTABLE_FIELDS = new Set(REVIEW_STATE_FIELDS);
const DEFAULT_FLUSH_ACTIONS = 20;
const DEFAULT_IDLE_FLUSH_MS = 5000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "VocabularyReviewError";
  error.code = code;
  return error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function parseUtc(value, name = "UTC time") {
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw codedError("VOCAB_REVIEW_TIME_INVALID", name + " must be a valid UTC ISO timestamp.");
  }
  return Date.parse(value);
}

function readUtcNow(now) {
  let value;
  try { value = now(); }
  catch (error) { throw codedError("VOCAB_REVIEW_CLOCK_FAILED", "Could not read the current UTC time.", error); }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw codedError("VOCAB_REVIEW_CLOCK_INVALID", "The current UTC time is invalid.");
  return date.toISOString();
}

function addDays(iso, days) {
  return new Date(parseUtc(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

function validateFamilyKey(familyKey) {
  if (typeof familyKey !== "string" || !familyKey.startsWith("en-family:v1:") || familyKey.length > 4096) {
    throw codedError("VOCAB_REVIEW_FAMILY_INVALID", "A versioned vocabulary family key is required.");
  }
  return familyKey;
}

function validateActionId(actionId) {
  if (typeof actionId !== "string" || !actionId || actionId.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(actionId)) {
    throw codedError("VOCAB_REVIEW_ACTION_ID_INVALID", "A stable review action ID is required.");
  }
  return actionId;
}

function validateState(record, familyKey) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.schemaVersion !== 1 ||
      record.familyKey !== familyKey || typeof record.enrolled !== "boolean" ||
      !Number.isInteger(record.box) || record.box < 1 || record.box > 5 ||
      !Number.isSafeInteger(record.reviewCount) || record.reviewCount < 0 ||
      !Number.isSafeInteger(record.lapseCount) || record.lapseCount < 0 ||
      typeof record.lastActionSessionId !== "string" || !record.lastActionSessionId ||
      !Number.isSafeInteger(record.lastActionSequence) || record.lastActionSequence < 1 ||
      typeof record.lastActionId !== "string" || !record.lastActionId) {
    throw codedError("VOCAB_REVIEW_STATE_INVALID", "Review state for " + familyKey + " is malformed.");
  }
  parseUtc(record.dueAt, "dueAt");
  parseUtc(record.updatedAt, "updatedAt");
  if (record.enrolledAt !== null) parseUtc(record.enrolledAt, "enrolledAt");
  if (record.lastReviewedAt !== null) parseUtc(record.lastReviewedAt, "lastReviewedAt");
  return record;
}

function emptySummary(sessionId) {
  return { schemaVersion: 1, sessionId, flushedThroughSequence: 0, entities: [], stores: [] };
}

function validateSummary(summary, sessionId) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary) || summary.schemaVersion !== 1 ||
      summary.sessionId !== sessionId || !Number.isSafeInteger(summary.flushedThroughSequence) ||
      summary.flushedThroughSequence < 0 || !Array.isArray(summary.entities) || !Array.isArray(summary.stores)) {
    throw codedError("VOCAB_REVIEW_SUMMARY_INVALID", "The pending Review session summary is malformed.");
  }
  const entities = new Map();
  for (const entry of summary.entities) {
    const familyKey = validateFamilyKey(entry?.familyKey);
    if (entities.has(familyKey) || typeof entry.beforeExists !== "boolean" || typeof entry.afterExists !== "boolean") {
      throw codedError("VOCAB_REVIEW_SUMMARY_INVALID", "The pending Review summary has an invalid entity baseline.");
    }
    if (entry.beforeExists) validateState(entry.beforeState, familyKey);
    else if (entry.beforeState !== null) throw codedError("VOCAB_REVIEW_SUMMARY_INVALID", "An absent baseline must not carry a Review record.");
    if (entry.afterExists) validateState(entry.afterState, familyKey);
    else if (entry.afterState !== null) throw codedError("VOCAB_REVIEW_SUMMARY_INVALID", "An absent result must not carry a Review record.");
    entities.set(familyKey, clone(entry));
  }
  const stores = new Map();
  for (const entry of summary.stores) {
    if (!entry || entry.storeId !== REVIEW_STORE_ID || typeof entry.path !== "string" ||
        !entry.path.startsWith(REVIEW_ROOT + "/") || stores.has(entry.path) ||
        !Number.isSafeInteger(entry.baseRevision) || entry.baseRevision < 0 ||
        !Number.isSafeInteger(entry.resultRevision) || entry.resultRevision < 1 ||
        (entry.baseRevision === 0 ? entry.baseHash !== null : typeof entry.baseHash !== "string") ||
        typeof entry.resultHash !== "string") {
      throw codedError("VOCAB_REVIEW_SUMMARY_INVALID", "The pending Review summary has invalid store metadata.");
    }
    stores.set(entry.path, clone(entry));
  }
  return { entities, stores };
}

function summarizeEntities(aggregate) {
  return [...aggregate.values()].map((entry) => ({
    familyKey: entry.familyKey,
    beforeExists: entry.beforeExists,
    beforeState: entry.beforeExists ? clone(entry.beforeState) : null,
    afterExists: entry.afterExists,
    afterState: entry.afterExists ? clone(entry.afterState) : null,
    ...(entry.path ? { path: entry.path } : {}),
  })).sort((left, right) => left.familyKey.localeCompare(right.familyKey));
}

function summarizeStores(stores) {
  return [...stores.values()].map(clone).sort((left, right) => left.path.localeCompare(right.path));
}

function historyChanges({ batchId, aggregate }) {
  const changes = [];
  for (const entry of [...aggregate.values()].sort((left, right) => left.familyKey.localeCompare(right.familyKey))) {
    const entityKind = !entry.beforeExists && entry.afterExists ? "entityCreate" :
      (entry.beforeExists && !entry.afterExists ? "entityDelete" : "record");
    for (const field of REVIEW_STATE_FIELDS) {
      const beforeExists = entry.beforeExists && Object.hasOwn(entry.beforeState, field);
      const afterExists = entry.afterExists && Object.hasOwn(entry.afterState, field);
      const before = beforeExists ? entry.beforeState[field] : null;
      const after = afterExists ? entry.afterState[field] : null;
      if (beforeExists === afterExists && (!beforeExists || same(before, after))) continue;
      const seed = { batchId, familyKey: entry.familyKey, field, beforeExists, before, afterExists, after };
      changes.push({
        changeId: canonicalHash(seed).slice("sha256-v1:".length),
        storeId: REVIEW_STORE_ID,
        path: entry.path,
        entityId: entry.familyKey,
        kind: entityKind === "record" ? "field" : entityKind,
        ...(entityKind === "record" ? {} : { entityExists: entry.afterExists }),
        field,
        fieldPath: ["records", entry.familyKey, field],
        beforeExists,
        before,
        afterExists,
        after,
      });
    }
  }
  return changes;
}

function encodeCursor(item) {
  const text = canonicalStringify({ dueAt: item.dueAt, familyKey: item.familyKey });
  const binary = [...new TextEncoder().encode(text)].map((byte) => String.fromCharCode(byte)).join("");
  return "review-v1." + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeCursor(cursor) {
  if (cursor == null || cursor === "") return null;
  if (typeof cursor !== "string" || !cursor.startsWith("review-v1.")) {
    throw codedError("VOCAB_REVIEW_CURSOR_INVALID", "The Review queue cursor is invalid.");
  }
  try {
    const encoded = cursor.slice("review-v1.".length);
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const result = JSON.parse(new TextDecoder().decode(bytes));
    validateFamilyKey(result?.familyKey);
    parseUtc(result?.dueAt, "cursor dueAt");
    return result;
  } catch (error) {
    if (error?.code === "VOCAB_REVIEW_CURSOR_INVALID") throw error;
    throw codedError("VOCAB_REVIEW_CURSOR_INVALID", "The Review queue cursor is invalid.", error);
  }
}

function createVocabularyReviewService({
  transaction,
  vocabularyService,
  now = () => new Date(),
  makeId = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2),
  setTimeout: schedule = globalThis.setTimeout?.bind(globalThis),
  clearTimeout: cancel = globalThis.clearTimeout?.bind(globalThis),
  flushEvery = DEFAULT_FLUSH_ACTIONS,
  idleMs = DEFAULT_IDLE_FLUSH_MS,
  maxRecords,
  maxBytes,
} = {}) {
  for (const method of ["readSnapshot", "recoverLocal", "appendJournalAction", "readJournalActions", "readSessionSummary", "flushReviewSession"]) {
    if (typeof transaction?.[method] !== "function") throw new TypeError("Vocabulary Review requires transaction." + method + "().");
  }
  if (!vocabularyService || typeof vocabularyService.getFamilyByKey !== "function") {
    throw new TypeError("Vocabulary Review requires vocabularyService.getFamilyByKey().");
  }
  if (typeof now !== "function" || typeof makeId !== "function" || typeof schedule !== "function" || typeof cancel !== "function") {
    throw new TypeError("Vocabulary Review requires a clock, ID factory, and timer functions.");
  }
  if (!Number.isInteger(flushEvery) || flushEvery < 1 || !Number.isFinite(idleMs) || idleMs < 1) {
    throw new TypeError("Review flush thresholds must be positive.");
  }

  const store = createShardedStore({
    transaction, storeId: REVIEW_STORE_ID, root: REVIEW_ROOT, kind: REVIEW_KIND,
    idOf: (record) => record?.familyKey,
    ...(maxRecords == null ? {} : { maxRecords }),
    ...(maxBytes == null ? {} : { maxBytes }),
  });
  let session = null;
  let serial = Promise.resolve();

  function enqueue(task) {
    const result = serial.then(task);
    serial = result.catch(() => undefined);
    return result;
  }

  function requireOpen({ allowClosing = false } = {}) {
    if (!session || (!allowClosing && session.closing) || session.closed) {
      throw codedError("VOCAB_REVIEW_SESSION_CLOSED", "Open a Review session before using this operation.");
    }
    return session;
  }

  async function familyFor(familyKey) {
    validateFamilyKey(familyKey);
    let family;
    try { family = await vocabularyService.getFamilyByKey(familyKey, { includeRecords: false }); }
    catch (error) { throw codedError("VOCAB_REVIEW_FAMILY_INVALID", "The vocabulary family could not be resolved.", error); }
    if (!family) throw codedError("VOCAB_REVIEW_FAMILY_MISSING", "The vocabulary family no longer exists.");
    return family;
  }

  async function loadRecords() {
    const loaded = await store.load();
    const records = new Map();
    for (const record of loaded.records) {
      validateState(record, record.familyKey);
      records.set(record.familyKey, clone(record));
    }
    await Promise.all([...records.keys()].map((familyKey) => familyFor(familyKey)));
    return { loaded, records };
  }

  async function openSession({ sessionId } = {}) {
    return enqueue(async () => {
      if (session && !session.closed) {
        if (session.sessionId === sessionId) return { status: "open", sessionId, replayedActions: session.journal.actions.length };
        throw codedError("VOCAB_REVIEW_SESSION_ALREADY_OPEN", "Close the current Review session before opening another.");
      }
      if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
        throw codedError("VOCAB_REVIEW_SESSION_ID_INVALID", "A path-safe stable Review session ID is required.");
      }
      const recovery = await transaction.recoverLocal();
      const localSessionPrefix = "00_Archive/21_VocabularyData/transactions/" +
        String(transaction.deviceId || "") + "/" + sessionId + "/";
      const relevant = (recovery.conflicts || []).filter((item) =>
        item.storeId === REVIEW_STORE_ID || item.storeId === "review-journal" || item.storeId === "review-summary" ||
        item.path?.startsWith(REVIEW_ROOT + "/") || item.path?.startsWith(localSessionPrefix));
      if (relevant.length) throw codedError("VOCAB_REVIEW_RECOVERY_CONFLICT", "Local Review recovery found an unresolved conflict.", relevant);

      const [loaded, journal, summarySnapshot] = await Promise.all([
        loadRecords(), transaction.readJournalActions(sessionId), transaction.readSessionSummary(sessionId),
      ]);
      const summary = summarySnapshot.exists ? summarySnapshot.summary : emptySummary(sessionId);
      const aggregate = validateSummary(summary, sessionId);
      if (summary.flushedThroughSequence > journal.actions.length || (summarySnapshot.exists && journal.actions.length === 0)) {
        throw codedError("VOCAB_REVIEW_RECOVERY_GAP", "The Review journal does not cover its pending session checkpoint.");
      }
      const currentRecords = loaded.records;
      for (const [familyKey, item] of aggregate.entities) {
        const current = currentRecords.get(familyKey) || null;
        if (item.afterExists !== Boolean(current) || (item.afterExists && !same(item.afterState, current))) {
          throw codedError("VOCAB_REVIEW_CHECKPOINT_MISMATCH", "Canonical Review state does not match its pending checkpoint for " + familyKey + ".");
        }
      }
      const workingRecords = new Map([...currentRecords].map(([key, value]) => [key, clone(value)]));
      const pendingActions = journal.actions.filter((item) => item.sequence > summary.flushedThroughSequence);
      const entities = new Map([...aggregate.entities].map(([key, value]) => [key, clone(value)]));
      for (const action of pendingActions) {
        const payload = action.payload;
        if (!payload || payload.schemaVersion !== 1 || !["enroll", "unenroll", "remember", "forget"].includes(payload.kind)) {
          throw codedError("VOCAB_REVIEW_JOURNAL_INVALID", "Review action " + action.actionId + " has an unsupported payload.");
        }
        const familyKey = validateFamilyKey(payload.familyKey);
        await familyFor(familyKey);
        const current = workingRecords.get(familyKey) || null;
        if (Boolean(current) !== payload.beforeExists || (current && !same(current, payload.beforeState))) {
          throw codedError("VOCAB_REVIEW_REPLAY_CONFLICT", "Review action " + action.actionId + " does not continue the canonical state chain.");
        }
        const after = {
          ...clone(payload.afterState),
          lastActionSessionId: sessionId,
          lastActionSequence: action.sequence,
          lastActionId: action.actionId,
        };
        validateState(after, familyKey);
        workingRecords.set(familyKey, after);
        const previous = entities.get(familyKey);
        if (previous) {
          if (!previous.afterExists || !same(previous.afterState, current)) {
            throw codedError("VOCAB_REVIEW_REPLAY_CONFLICT", "Review action " + action.actionId + " does not continue the session summary.");
          }
          previous.afterExists = true;
          previous.afterState = clone(after);
        } else {
          entities.set(familyKey, {
            familyKey, beforeExists: payload.beforeExists,
            beforeState: payload.beforeExists ? clone(payload.beforeState) : null,
            afterExists: true, afterState: clone(after), path: null,
          });
        }
      }
      session = {
        sessionId, closing: false, closed: false, timer: null, lastError: null,
        journal, summarySnapshot, summary: clone(summary), aggregate: entities,
        loaded: loaded.loaded, canonicalRecords: currentRecords, workingRecords,
      };
      if (pendingActions.length) scheduleIdleFlush();
      return { status: "open", sessionId, replayedActions: pendingActions.length };
    });
  }

  function cancelIdleFlush() {
    if (session?.timer != null) cancel(session.timer);
    if (session) session.timer = null;
  }

  function scheduleIdleFlush() {
    if (!session || session.closing || session.closed) return;
    cancelIdleFlush();
    session.timer = schedule(() => {
      if (!session || session.closed || session.closing) return;
      session.timer = null;
      void flush().catch((error) => { if (session) session.lastError = error; });
    }, idleMs);
  }

  async function ensureNoExternalReviewChange(records, familyKeys) {
    const live = new Map(records);
    for (const familyKey of familyKeys) {
      const expected = session.canonicalRecords.get(familyKey) || null;
      const actual = live.get(familyKey) || null;
      if (Boolean(expected) !== Boolean(actual) || (expected && !same(expected, actual))) {
        throw codedError("VOCAB_REVIEW_STORE_CONFLICT", "Review state changed outside this session for " + familyKey + ".");
      }
    }
  }

  async function flushUnlocked() {
    const active = requireOpen({ allowClosing: true });
    const priorSequence = active.summary.flushedThroughSequence || 0;
    const pending = active.journal.actions.filter((item) => item.sequence > priorSequence);
    if (!pending.length) return { status: "unchanged", flushedThroughSequence: priorSequence };

    const fresh = await loadRecords();
    const touched = new Set(active.aggregate.keys());
    await ensureNoExternalReviewChange(fresh.records, touched);
    const recordsById = new Map(fresh.records);
    for (const familyKey of touched) {
      const current = active.workingRecords.get(familyKey);
      if (current) recordsById.set(familyKey, clone(current));
      else recordsById.delete(familyKey);
    }
    const plan = await prepareShardedReplacement({
      readSnapshot: (path) => transaction.readSnapshot(path),
      loaded: fresh.loaded,
      records: [...recordsById.values()],
      storeId: REVIEW_STORE_ID,
      root: REVIEW_ROOT,
      kind: REVIEW_KIND,
      idOf: (record) => record?.familyKey,
      ...(maxRecords == null ? {} : { maxRecords }),
      ...(maxBytes == null ? {} : { maxBytes }),
    });

    const stores = new Map(active.summary.stores.map((entry) => [entry.path, clone(entry)]));
    for (const write of plan.writes) {
      const resultValue = JSON.parse(write.text);
      const prior = stores.get(write.path);
      stores.set(write.path, {
        storeId: REVIEW_STORE_ID,
        path: write.path,
        baseRevision: prior?.baseRevision ?? write.expectedRevision,
        baseHash: prior ? prior.baseHash : write.expectedHash,
        resultRevision: resultValue.revision,
        resultHash: hashText(write.text),
      });
    }
    const aggregate = new Map([...active.aggregate].map(([key, value]) => [key, clone(value)]));
    for (const familyKey of touched) {
      const entity = aggregate.get(familyKey);
      if (!entity) continue;
      const record = recordsById.get(familyKey) || null;
      entity.afterExists = Boolean(record);
      entity.afterState = record ? clone(record) : null;
      if (record) {
        const prefix = hashText(familyKey).slice("sha256-v1:".length);
        const reference = plan.manifest?.shards.find((item) => prefix.startsWith(item.prefix));
        entity.path = reference?.path || null;
      }
    }
    const sequence = active.journal.actions.at(-1)?.sequence || priorSequence;
    const summary = {
      schemaVersion: 1,
      sessionId: active.sessionId,
      flushedThroughSequence: sequence,
      entities: summarizeEntities(aggregate),
      stores: summarizeStores(stores),
    };
    const result = await transaction.flushReviewSession({
      sessionId: active.sessionId,
      actionId: "review-flush:" + active.sessionId + ":" + sequence,
      writes: plan.writes,
      updatedSummary: summary,
      expectedJournalHash: active.journal.hash,
      expectedSummaryHash: active.summarySnapshot.hash,
    });
    if (result.status === "conflict") {
      throw codedError("VOCAB_REVIEW_FLUSH_CONFLICT", "Review state conflicted during checkpoint; the journal remains available for recovery.", result);
    }
    if (result.status !== "committed" && result.status !== "noop") {
      throw codedError("VOCAB_REVIEW_FLUSH_FAILED", "Review state checkpoint did not commit.", result);
    }
    active.loaded = await store.load();
    active.canonicalRecords = new Map(recordsById);
    active.workingRecords = new Map([...recordsById].map(([key, value]) => [key, clone(value)]));
    active.summary = summary;
    active.aggregate = aggregate;
    active.summarySnapshot = await transaction.readSessionSummary(active.sessionId);
    active.journal = await transaction.readJournalActions(active.sessionId);
    active.lastError = null;
    return { status: "committed", flushedThroughSequence: sequence, writes: plan.writes.length };
  }

  async function flush() {
    return enqueue(async () => {
      cancelIdleFlush();
      return flushUnlocked();
    });
  }

  function createActionState(kind, current, time) {
    if (kind === "enroll") {
      if (!current) {
        return {
          schemaVersion: 1, familyKey: null, enrolled: true, box: 1, dueAt: time,
          enrolledAt: time, lastReviewedAt: null, reviewCount: 0, lapseCount: 0, updatedAt: time,
        };
      }
      return { ...clone(current), enrolled: true, updatedAt: time };
    }
    if (!current) return null;
    if (kind === "unenroll") return { ...clone(current), enrolled: false, updatedAt: time };
    if (!current.enrolled) throw codedError("VOCAB_REVIEW_NOT_ENROLLED", "Enroll this family before rating it.");
    if (kind === "remember") {
      const box = Math.min(5, current.box + 1);
      return { ...clone(current), box, dueAt: addDays(time, REVIEW_INTERVAL_DAYS[box - 1]),
        lastReviewedAt: time, reviewCount: current.reviewCount + 1, updatedAt: time };
    }
    if (kind === "forget") {
      return { ...clone(current), box: 1, dueAt: addDays(time, REVIEW_INTERVAL_DAYS[0]),
        lastReviewedAt: time, reviewCount: current.reviewCount + 1, lapseCount: current.lapseCount + 1, updatedAt: time };
    }
    throw codedError("VOCAB_REVIEW_ACTION_INVALID", "Unsupported Review action.");
  }

  async function applyAction(kind, familyKey, options = {}) {
    return enqueue(async () => {
      const active = requireOpen();
      validateFamilyKey(familyKey);
      if (kind === "skip") return { status: "skipped", writes: 0, journalActions: active.journal.actions.length };
      if (!["enroll", "unenroll", "remember", "forget"].includes(kind)) {
        throw codedError("VOCAB_REVIEW_ACTION_INVALID", "Unsupported Review action.");
      }
      const actionId = validateActionId(options.actionId || "review-action-" + makeId());
      const existing = active.journal.actions.find((item) => item.actionId === actionId);
      if (existing) {
        if (existing.payload?.kind !== kind || existing.payload?.familyKey !== familyKey) {
          throw codedError("VOCAB_REVIEW_ACTION_ID_REUSE", "A Review action ID cannot be reused for another action.");
        }
        const after = { ...clone(existing.payload.afterState), lastActionSessionId: active.sessionId,
          lastActionSequence: existing.sequence, lastActionId: existing.actionId };
        return { status: "duplicate", actionId, sequence: existing.sequence, state: clone(after), writes: 0 };
      }
      const family = await familyFor(familyKey);
      if (family.status === 5 && kind !== "unenroll") {
        return { status: "known-filtered", actionId, familyKey, writes: 0 };
      }
      const current = active.workingRecords.get(familyKey) || null;
      const time = readUtcNow(now);
      const proposed = createActionState(kind, current, time);
      if (proposed === null) return { status: "unchanged", actionId, familyKey, writes: 0 };
      proposed.familyKey = familyKey;
      if (current && kind === "enroll" && current.enrolled) {
        return { status: "unchanged", actionId, familyKey, state: clone(current), writes: 0 };
      }
      if (current && kind === "unenroll" && !current.enrolled) {
        return { status: "unchanged", actionId, familyKey, state: clone(current), writes: 0 };
      }
      const expectedSequence = active.journal.actions.length + 1;
      const next = { ...clone(proposed), lastActionSessionId: active.sessionId,
        lastActionSequence: expectedSequence, lastActionId: actionId };
      // Reject an invalid transition before its durable journal append. A failed
      // validation must never leave an unacknowledged row that blocks replay.
      validateState(next, familyKey);
      const payload = {
        schemaVersion: 1, kind, familyKey, beforeExists: Boolean(current),
        beforeState: current ? clone(current) : null, afterState: clone(proposed), at: time,
      };
      const appended = await transaction.appendJournalAction({
        sessionId: active.sessionId, actionId, payload, expectedSequence,
      });
      if (appended.status === "conflict") {
        throw codedError("VOCAB_REVIEW_JOURNAL_CONFLICT", "Review action could not be appended without reusing an ID or sequence.", appended);
      }
      const sequence = appended.revision;
      if (sequence !== expectedSequence) {
        throw codedError("VOCAB_REVIEW_JOURNAL_SEQUENCE_CONFLICT", "Another writer changed the Review session sequence.");
      }
      active.journal = await transaction.readJournalActions(active.sessionId);
      if (active.journal.actions.at(-1)?.actionId !== actionId || active.journal.actions.at(-1)?.sequence !== sequence) {
        throw codedError("VOCAB_REVIEW_JOURNAL_SEQUENCE_CONFLICT", "Review journal readback did not match the appended action.");
      }
      active.workingRecords.set(familyKey, next);
      const aggregate = active.aggregate.get(familyKey);
      if (aggregate) {
        if (!aggregate.afterExists || !same(aggregate.afterState, current)) {
          throw codedError("VOCAB_REVIEW_SESSION_CHAIN_INVALID", "Review action does not continue its session history.");
        }
        aggregate.afterExists = true;
        aggregate.afterState = clone(next);
      } else {
        active.aggregate.set(familyKey, {
          familyKey, beforeExists: Boolean(current), beforeState: current ? clone(current) : null,
          afterExists: true, afterState: clone(next), path: null,
        });
      }
      active.lastError = null;
      scheduleIdleFlush();
      const pendingCount = active.journal.actions.length - (active.summary.flushedThroughSequence || 0);
      if (pendingCount >= flushEvery) {
        cancelIdleFlush();
        void flush().catch((error) => { if (session) session.lastError = error; });
      }
      return { status: "committed", actionId, sequence, state: clone(next), writes: 1,
        flushScheduled: pendingCount >= flushEvery };
    });
  }

  async function getState(familyKey) {
    const active = requireOpen();
    await familyFor(familyKey);
    const state = active.workingRecords.get(familyKey);
    return state ? clone(state) : undefined;
  }

  async function listDue(options = {}) {
    const active = requireOpen();
    const limit = options.limit == null ? DEFAULT_PAGE_SIZE : options.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw codedError("VOCAB_REVIEW_PAGE_SIZE_INVALID", "Review page size must be from 1 to " + MAX_PAGE_SIZE + ".");
    }
    const cursor = decodeCursor(options.cursor);
    const time = readUtcNow(now);
    const candidates = [...active.workingRecords.values()].filter((record) => record.enrolled && record.dueAt <= time)
      .sort((left, right) => left.dueAt.localeCompare(right.dueAt) || left.familyKey.localeCompare(right.familyKey));
    const eligible = [];
    for (const state of candidates) {
      const family = await familyFor(state.familyKey);
      if (family.status !== 5) eligible.push({ familyKey: state.familyKey, dueAt: state.dueAt, state: clone(state), family });
    }
    const after = cursor ? eligible.filter((item) => item.dueAt > cursor.dueAt ||
      (item.dueAt === cursor.dueAt && item.familyKey > cursor.familyKey)) : eligible;
    const items = after.slice(0, limit);
    return { items, total: eligible.length, nextCursor: after.length > limit ? encodeCursor(items.at(-1)) : null };
  }

  async function currentPreconditions(storeEntries) {
    const preconditions = [];
    for (const entry of storeEntries) {
      const snapshot = await transaction.readSnapshot(entry.path);
      if (snapshot.revision !== entry.resultRevision || snapshot.hash !== entry.resultHash) {
        throw codedError("VOCAB_REVIEW_FINAL_CONFLICT", "Review state changed before session finalization at " + entry.path + ".");
      }
      preconditions.push({ storeId: REVIEW_STORE_ID, path: entry.path,
        expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
    }
    return preconditions;
  }

  async function closeUnlocked() {
    const active = requireOpen({ allowClosing: true });
    active.closing = true;
    cancelIdleFlush();
    try {
      const checkpoint = await flushUnlocked();
      const journal = await transaction.readJournalActions(active.sessionId);
      const summarySnapshot = await transaction.readSessionSummary(active.sessionId);
      const summary = summarySnapshot.exists ? summarySnapshot.summary : emptySummary(active.sessionId);
      const { entities, stores } = validateSummary(summary, active.sessionId);
      const batchId = "review-final:" + active.sessionId;
      const changes = historyChanges({ batchId, aggregate: entities });
      const storeEntries = summarizeStores(stores);
      const preconditions = await currentPreconditions(storeEntries);
      let result;
      if (changes.length) {
        const latestStores = [];
        for (const item of storeEntries) {
          const snapshot = await transaction.readSnapshot(item.path);
          latestStores.push({
            storeId: REVIEW_STORE_ID, path: item.path,
            baseRevision: item.baseRevision, resultRevision: snapshot.revision,
            baseHash: item.baseHash, resultHash: snapshot.hash,
          });
        }
        result = await transaction.flushReviewSession({
          sessionId: active.sessionId,
          actionId: "review-final:" + active.sessionId,
          expectedJournalHash: journal.hash,
          expectedSummaryHash: summarySnapshot.hash,
          historySummary: {
            batchId, sessionId: active.sessionId, kind: "review-final",
          entities: [...entities.values()].sort((left, right) => left.familyKey.localeCompare(right.familyKey)).map((entry) => ({
            storeId: REVIEW_STORE_ID,
            entityId: entry.familyKey,
            kind: !entry.beforeExists && entry.afterExists ? "entityCreate" :
              (entry.beforeExists && !entry.afterExists ? "entityDelete" : "record"),
          })),
            stores: latestStores, changes,
          },
          preconditions,
          finalize: true,
        });
      } else if (journal.actions.length || summarySnapshot.exists) {
        result = await transaction.flushReviewSession({
          sessionId: active.sessionId,
          actionId: "review-final:" + active.sessionId,
          expectedJournalHash: journal.hash,
          expectedSummaryHash: summarySnapshot.hash,
          preconditions, finalize: true,
        });
      } else result = { status: "noop" };

      if (result.status === "conflict") {
        throw codedError("VOCAB_REVIEW_FINALIZE_CONFLICT", "Review session finalization conflicted; its journal is retained.", result);
      }
      if (!["committed", "noop", "unchanged"].includes(result.status)) {
        throw codedError("VOCAB_REVIEW_FINALIZE_FAILED", "Review session did not finalize.", result);
      }
      active.closed = true;
      return { status: "closed", sessionId: active.sessionId, actions: journal.actions.length,
        historyBatchId: changes.length ? batchId : null, checkpoint };
    } catch (error) {
      active.closing = false;
      throw error;
    }
  }

  async function close() {
    return enqueue(closeUnlocked);
  }

  return Object.freeze({
    root: REVIEW_ROOT,
    storeId: REVIEW_STORE_ID,
    openSession,
    getState,
    listDue,
    enroll: (familyKey, options) => applyAction("enroll", familyKey, options),
    unenroll: (familyKey, options) => applyAction("unenroll", familyKey, options),
    remember: (familyKey, options) => applyAction("remember", familyKey, options),
    forget: (familyKey, options) => applyAction("forget", familyKey, options),
    skip: (familyKey, options) => applyAction("skip", familyKey, options),
    flush,
    close,
    getStatus: () => session ? {
      sessionId: session.sessionId, closed: session.closed, closing: session.closing,
      actionCount: session.journal.actions.length,
      flushedThroughSequence: session.summary.flushedThroughSequence || 0,
      lastError: session.lastError ? { code: session.lastError.code, message: session.lastError.message } : null,
    } : null,
  });
}

function absentSnapshot() {
  return { exists: false, text: null, value: null, revision: 0, hash: null };
}

async function readCurrentReviewState(transaction, suppliedSnapshots = new Map(), { maxRecords, maxBytes } = {}) {
  const manifestPath = manifestPathFor(REVIEW_ROOT);
  const snapshotReader = async (path) => suppliedSnapshots.get(path) || transaction.readSnapshot(path);
  const loaded = await readShardedStore({
    readSnapshot: snapshotReader,
    hasShardFiles: (root) => hasShardFilesFromAdapter(transaction.adapter, root),
    storeId: REVIEW_STORE_ID,
    root: REVIEW_ROOT,
    kind: REVIEW_KIND,
    idOf: (record) => record?.familyKey,
    ...(maxRecords == null ? {} : { maxRecords }),
    ...(maxBytes == null ? {} : { maxBytes }),
  });
  const { manifestSnapshot, shardSnapshots } = loaded;

  // Ensure the manifest still names the same generation after its shards have
  // been read. A concurrent writer must fail closed instead of producing a
  // field resolution assembled from two different shard generations.
  const latestManifest = await transaction.readSnapshot(manifestPath);
  if (latestManifest.revision !== manifestSnapshot.revision || latestManifest.hash !== manifestSnapshot.hash) {
    throw codedError("VOCAB_REVIEW_RESTORE_SNAPSHOT_MISMATCH", "The Review manifest changed while resolving History state.");
  }
  for (const record of loaded.records) validateState(record, record.familyKey);
  return { loaded, manifestSnapshot, shardSnapshots };
}

/**
 * Review-only inverse planner. History supplies verified snapshots for every
 * active shard and manifest; incomplete state is rejected before any write.
 */
function createReviewHistoryRestoreHandler({ transaction, vocabularyService, maxRecords, maxBytes } = {}) {
  if (!transaction || typeof transaction.readSnapshot !== "function") {
    throw new TypeError("Review History restore requires transaction.readSnapshot().");
  }
  if (!vocabularyService || typeof vocabularyService.getFamilyByKey !== "function") {
    throw new TypeError("Review History restore requires vocabularyService.getFamilyByKey().");
  }
  return Object.freeze({
    async resolveField({ change } = {}) {
      if (!change || change.storeId !== REVIEW_STORE_ID || !HISTORY_MUTABLE_FIELDS.has(change.field) ||
          !Array.isArray(change.fieldPath) || change.fieldPath.length !== 3 ||
          change.fieldPath[0] !== "records" || change.fieldPath[1] !== change.entityId ||
          change.fieldPath[2] !== change.field || typeof change.path !== "string" ||
          !change.path.startsWith(REVIEW_ROOT + "/")) {
        throw codedError("VOCAB_REVIEW_RESTORE_FIELD_INVALID", "Review History refers to an unsupported field or path.");
      }
      const familyKey = validateFamilyKey(change.entityId);
      const { loaded } = await readCurrentReviewState(transaction, new Map(), { maxRecords, maxBytes });
      const record = loaded.records.find((candidate) => candidate.familyKey === familyKey) || null;
      const exists = Boolean(record) && Object.hasOwn(record, change.field);
      return {
        exists,
        ...(exists ? { value: clone(record[change.field]) } : {}),
        entityExists: Boolean(record),
      };
    },
    async planRestore({ batch, selectedChanges, snapshots, overwriteConflictIds = [] } = {}) {
      if (!batch || batch.kind !== "vocabulary-history-batch" ||
          !["review-final", "restore", "bundle-import"].includes(batch.actionKind) ||
          !Array.isArray(selectedChanges) || !(snapshots instanceof Map)) {
        throw codedError("VOCAB_REVIEW_RESTORE_BATCH_INVALID", "A Review History batch and its verified snapshots are required.");
      }
      const overwrite = new Set(overwriteConflictIds);
      const manifestPath = manifestPathFor(REVIEW_ROOT);
      const { loaded } = await readCurrentReviewState(transaction, snapshots, { maxRecords, maxBytes });
      const records = new Map(loaded.records.map((record) => [record.familyKey, clone(record)]));
      const inverseChanges = [];
      const selectedByEntity = new Map();
      for (const change of selectedChanges) {
        if (change.storeId !== REVIEW_STORE_ID || !HISTORY_MUTABLE_FIELDS.has(change.field) ||
            !["field", "entityCreate", "entityDelete"].includes(change.kind) ||
            !Array.isArray(change.fieldPath) || change.fieldPath.length !== 3 ||
            change.fieldPath[0] !== "records" || change.fieldPath[2] !== change.field ||
            change.entityId !== change.fieldPath[1] ||
            typeof change.changeId !== "string" || !/^[a-f0-9]{64}$/.test(change.changeId) ||
            typeof change.path !== "string" || !change.path.startsWith(REVIEW_ROOT + "/") ||
            typeof change.beforeExists !== "boolean" || typeof change.afterExists !== "boolean") {
          throw codedError("VOCAB_REVIEW_RESTORE_FIELD_INVALID", "Review History selected an unsupported identity or field path.");
        }
        const familyKey = validateFamilyKey(change.entityId);
        const family = await vocabularyService.getFamilyByKey(familyKey, { includeRecords: false });
        if (!family) throw codedError("VOCAB_REVIEW_RESTORE_FAMILY_MISSING", "The Review vocabulary family no longer exists.");
        if (change.status !== "clean" && !(change.status === "conflict" && overwrite.has(change.changeId))) {
          throw codedError("VOCAB_REVIEW_RESTORE_CONFLICT_NOT_SELECTED", "A conflicting Review change must be explicitly selected for overwrite.");
        }
        const currentRecord = records.get(familyKey) || null;
        if (change.kind !== "field" && typeof change.entityExists !== "boolean") {
          throw codedError("VOCAB_REVIEW_RESTORE_ENTITY_STATE_REQUIRED", "Lifecycle History changes must include the verified entityExists state.");
        }
        if (change.status === "clean" && change.kind !== "field" && change.entityExists !== Boolean(currentRecord)) {
          throw codedError("VOCAB_REVIEW_RESTORE_SNAPSHOT_MISMATCH", "Review History lifecycle state does not match its supplied snapshots.");
        }
        const currentExists = Boolean(currentRecord) && Object.hasOwn(currentRecord, change.field);
        const currentValue = currentExists ? currentRecord[change.field] : null;
        if (change.currentExists !== undefined && (change.currentExists !== currentExists ||
            (currentExists && !same(change.current, currentValue)))) {
          throw codedError("VOCAB_REVIEW_RESTORE_SNAPSHOT_MISMATCH", "Review History preview values do not match its supplied snapshots.");
        }
        if (change.status === "clean" &&
            (currentExists !== change.afterExists || (currentExists && !same(currentValue, change.after)))) {
          throw codedError("VOCAB_REVIEW_RESTORE_SNAPSHOT_MISMATCH", "A clean Review History field no longer matches its recorded result.");
        }
        if (!selectedByEntity.has(familyKey)) selectedByEntity.set(familyKey, []);
        selectedByEntity.get(familyKey).push(change);
      }

      for (const [familyKey, changes] of selectedByEntity) {
        let record = records.get(familyKey) || null;
        const kinds = new Set(changes.map((change) => change.kind));
        if (kinds.size !== 1) throw codedError("VOCAB_REVIEW_RESTORE_LIFECYCLE_MIXED", "One Review record cannot mix lifecycle and field changes.");
        const lifecycle = changes[0].kind;
        const selectedFields = new Set(changes.map((change) => change.field));
        const completeLifecycle = changes.length === REVIEW_STATE_FIELDS.length &&
          REVIEW_STATE_FIELDS.every((field) => selectedFields.has(field));
        const creationUndo = lifecycle === "entityCreate" && completeLifecycle &&
          changes.every((change) => change.beforeExists === false && change.afterExists === true);
        const deletionRedo = lifecycle === "entityDelete" && completeLifecycle &&
          changes.every((change) => change.beforeExists === true && change.afterExists === false);
        if (lifecycle !== "field" && !completeLifecycle) {
          throw codedError("VOCAB_REVIEW_RESTORE_PARTIAL_CREATE", "Review lifecycle restore requires selecting the complete record change group.");
        }
        if (lifecycle === "field" && changes.some((change) => change.beforeExists === false || change.afterExists === false)) {
          throw codedError("VOCAB_REVIEW_RESTORE_FIELD_LIFECYCLE_INVALID", "A Review record lifecycle must use an entityCreate or entityDelete batch.");
        }
        if (lifecycle === "entityCreate" && !creationUndo) {
          throw codedError("VOCAB_REVIEW_RESTORE_LIFECYCLE_INVALID", "Review entityCreate fields do not describe one complete new record.");
        }
        if (lifecycle === "entityDelete" && !deletionRedo) {
          throw codedError("VOCAB_REVIEW_RESTORE_LIFECYCLE_INVALID", "Review entityDelete fields do not describe one complete removed record.");
        }
        if (deletionRedo && !record) {
          record = {
            schemaVersion: 1,
            familyKey,
            lastActionSessionId: "history-restore",
            lastActionSequence: 1,
            lastActionId: "restore:" + String(batch.batchId || "review"),
          };
        }
        for (const change of changes) {
          const previousExists = Boolean(record) && Object.hasOwn(record, change.field);
          const previous = previousExists ? record[change.field] : null;
          if (!record && change.beforeExists && !creationUndo) {
            throw codedError("VOCAB_REVIEW_RESTORE_RECORD_MISSING", "A Review record required by History is missing.");
          }
          if (record && !creationUndo) {
            if (change.beforeExists) record[change.field] = clone(change.before);
            else delete record[change.field];
          }
          inverseChanges.push({
            changeId: canonicalHash({ batchId: batch.batchId, originalChangeId: change.changeId, restore: true }).slice("sha256-v1:".length),
            storeId: REVIEW_STORE_ID, path: change.path, entityId: familyKey,
            kind: lifecycle === "entityCreate" ? "entityDelete" :
              (lifecycle === "entityDelete" ? "entityCreate" : "field"),
            ...(lifecycle === "field" ? {} : { entityExists: lifecycle === "entityDelete" }),
            field: change.field, fieldPath: [...change.fieldPath],
            beforeExists: previousExists, before: previous,
            afterExists: Boolean(change.beforeExists), after: change.beforeExists ? clone(change.before) : null,
          });
        }
        if (creationUndo) {
          records.delete(familyKey);
        } else if (record) {
          if (!REVIEW_STATE_FIELDS.every((field) => Object.hasOwn(record, field))) {
            throw codedError("VOCAB_REVIEW_RESTORE_STATE_INVALID", "The selected Review changes would leave an incomplete state record.");
          }
          validateState(record, familyKey);
          records.set(familyKey, record);
        } else if (changes.some((change) => change.beforeExists)) {
          throw codedError("VOCAB_REVIEW_RESTORE_STATE_INVALID", "A Review restore would produce a missing baseline record.");
        }
      }
      const plan = await prepareShardedReplacement({
        readSnapshot: async (path) => {
          return snapshots.get(path) || transaction.readSnapshot(path);
        },
        loaded,
        records: [...records.values()],
        storeId: REVIEW_STORE_ID, root: REVIEW_ROOT, kind: REVIEW_KIND,
        idOf: (record) => record?.familyKey,
        ...(maxRecords == null ? {} : { maxRecords }),
        ...(maxBytes == null ? {} : { maxBytes }),
      });
      const stores = plan.writes.map((write) => {
        const value = JSON.parse(write.text);
        return { storeId: REVIEW_STORE_ID, path: write.path, baseRevision: write.expectedRevision,
          resultRevision: value.revision, baseHash: write.expectedHash, resultHash: hashText(write.text) };
      });
      for (const change of inverseChanges) {
        const prefix = hashText(change.entityId).slice("sha256-v1:".length);
        const resultingRef = plan.manifest?.shards.find((item) => prefix.startsWith(item.prefix));
        change.path = resultingRef?.path || manifestPath;
      }
      const entities = [...selectedByEntity.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([entityId, changes]) => {
        const lifecycle = changes[0].kind;
        return {
          storeId: REVIEW_STORE_ID,
          entityId,
          kind: lifecycle === "entityCreate" ? "entityDelete" :
            (lifecycle === "entityDelete" ? "entityCreate" : "record"),
        };
      });
      return {
        writes: plan.writes,
        changes: inverseChanges,
        stores,
        entities,
      };
    },
  });
}

module.exports = {
  REVIEW_STORE_ID,
  REVIEW_ROOT,
  REVIEW_KIND,
  REVIEW_INTERVAL_DAYS,
  REVIEW_STATE_FIELDS,
  createVocabularyReviewService,
  createReviewHistoryRestoreHandler,
};
