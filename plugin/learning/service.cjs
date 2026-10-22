"use strict";

const { canonicalStringify, hashText } = require("../vocabulary/canonical.cjs");
const {
  createShardedStore,
  prepareShardedReplacement,
  manifestPathFor,
  readShardedStore,
  hasShardFilesFromAdapter,
} = require("../vocabulary/sharded-store.cjs");
const { encodeReaderLinkFragment } = require("../reader-anchor-store.cjs");
const { LeitnerScheduler, LEITNER_SCHEDULER_VERSION } = require("./scheduler.cjs");

const LEARNING_STORE_ID = "learning-items-v1";
const LEARNING_ROOT = "00_Archive/21_VocabularyData/learning/items";
const LEARNING_KIND = "learning-item";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const REVIEW_HISTORY_FIELDS = new Set(["reviewState", "lastReviewEvent"]);
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function codedError(code, message, details, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "LearningServiceError";
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function same(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function readUtcNow(now) {
  let value;
  try { value = now(); }
  catch (error) { throw codedError("LEARNING_CLOCK_FAILED", "Could not read the current UTC time.", undefined, error); }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw codedError("LEARNING_CLOCK_INVALID", "The current UTC time is invalid.");
  return date.toISOString();
}

function validateUtc(value, name) {
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw codedError("LEARNING_TIME_INVALID", `${name} must be a valid UTC ISO timestamp.`);
  }
  return value;
}

function validateActionId(actionId) {
  if (typeof actionId !== "string" || !actionId || actionId.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(actionId)) {
    throw codedError("LEARNING_ACTION_ID_INVALID", "A stable path-safe learning action ID is required.");
  }
  return actionId;
}

function validateItemId(itemId) {
  if (typeof itemId !== "string" || !itemId.startsWith("learning:v1:") || itemId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(itemId)) {
    throw codedError("LEARNING_ITEM_ID_INVALID", "A valid learning item ID is required.");
  }
  return itemId;
}

function validateSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw codedError("LEARNING_SOURCE_INVALID", "A SemanticAnchor provenance object is required.");
  }
  try { canonicalStringify(source); }
  catch (error) { throw codedError("LEARNING_SOURCE_INVALID", "Source provenance must be JSON data.", undefined, error); }
  const target = source.target;
  if (!target || typeof target !== "object" || Array.isArray(target) ||
      typeof target.kind !== "string" || !target.kind || typeof target.id !== "string" || !target.id ||
      typeof source.sourcePath !== "string" || !source.sourcePath || typeof source.targetText !== "string") {
    throw codedError("LEARNING_SOURCE_INVALID", "SemanticAnchor must include a stable target, source path, and targetText snapshot.");
  }
  const markdownEvidence = target.kind === "markdown" || source.evidenceKind === "markdown";
  const noteEvidence = markdownEvidence || source.evidenceKind === "backlink";
  if (!noteEvidence && (typeof source.documentId !== "string" || !source.documentId ||
      typeof source.docKey !== "string" || !source.docKey ||
      typeof source.sourceHash !== "string" || !source.sourceHash ||
      typeof source.pageIdentity !== "string" || !source.pageIdentity ||
      !Number.isSafeInteger(source.pageIndex) || source.pageIndex < 0)) {
    throw codedError("LEARNING_SOURCE_INVALID", "PDF SemanticAnchor must include stable document, source, page, and targetText evidence.");
  }
  if (source.targetTextSource !== undefined && !["captured", "stored", "recovered", "unavailable"].includes(source.targetTextSource)) {
    throw codedError("LEARNING_SOURCE_INVALID", "SemanticAnchor targetTextSource is unsupported.");
  }
  if (source.sourceRange !== undefined && source.sourceRange !== null) {
    const range = source.sourceRange;
    if (!range || typeof range !== "object" || Array.isArray(range) ||
        (range.startOffset !== null && range.startOffset !== undefined &&
          (!Number.isSafeInteger(range.startOffset) || range.startOffset < 0)) ||
        (range.endOffset !== null && range.endOffset !== undefined &&
          (!Number.isSafeInteger(range.endOffset) || range.endOffset < 0)) ||
        (range.line !== null && range.line !== undefined && (!Number.isSafeInteger(range.line) || range.line < 0)) ||
        (range.text !== null && range.text !== undefined && typeof range.text !== "string") ||
        (Number.isSafeInteger(range.startOffset) && Number.isSafeInteger(range.endOffset) && range.endOffset < range.startOffset)) {
      throw codedError("LEARNING_SOURCE_INVALID", "SemanticAnchor sourceRange is malformed.");
    }
  }
  if (markdownEvidence) {
    const range = source.sourceRange;
    if (!range || !Number.isSafeInteger(range.startOffset) || range.startOffset < 0 ||
        !Number.isSafeInteger(range.endOffset) || range.endOffset <= range.startOffset ||
        typeof range.text !== "string" || range.text !== source.targetText) {
      throw codedError("LEARNING_SOURCE_INVALID", "Markdown SemanticAnchor requires exact sourceRange text matching targetText.");
    }
  }
  if (source.evidenceKind !== undefined && source.evidenceKind !== null &&
      !["annotation", "reader-anchor", "context", "backlink", "markdown"].includes(source.evidenceKind)) {
    throw codedError("LEARNING_SOURCE_INVALID", "SemanticAnchor evidenceKind is unsupported.");
  }
  return clone(source);
}

function validateText(value, name, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > 100_000) {
    throw codedError("LEARNING_TEXT_INVALID", `${name} must be non-empty text of at most 100,000 characters.`);
  }
  return value;
}

function validateReviewState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      !Number.isInteger(state.box) || state.box < 1 || state.box > 5 ||
      !Number.isSafeInteger(state.reviewCount) || state.reviewCount < 0 ||
      !Number.isSafeInteger(state.lapseCount) || state.lapseCount < 0 ||
      !(state.lastReviewedAt === null || typeof state.lastReviewedAt === "string")) {
    throw codedError("LEARNING_ITEM_INVALID", "Learning item review state is malformed.");
  }
  validateUtc(state.dueAt, "reviewState.dueAt");
  if (state.lastReviewedAt !== null) validateUtc(state.lastReviewedAt, "reviewState.lastReviewedAt");
}

function validateItem(item, expectedId = item?.itemId) {
  if (!item || typeof item !== "object" || Array.isArray(item) || item.schemaVersion !== 1 ||
      item.itemId !== expectedId || typeof item.externalId !== "string" || !item.externalId ||
      typeof item.createActionId !== "string" || !item.createActionId ||
      typeof item.prompt !== "string" || !item.prompt.trim() ||
      typeof item.answer !== "string" || !item.answer.trim() ||
      typeof item.targetText !== "string" || !item.source ||
      !item.reviewState || !(item.lastReviewEvent === null || typeof item.lastReviewEvent === "object")) {
    throw codedError("LEARNING_ITEM_INVALID", `Learning item ${expectedId} is malformed.`);
  }
  validateItemId(item.itemId);
  validateSource(item.source);
  validateUtc(item.createdAt, "createdAt");
  validateReviewState(item.reviewState);
  if (item.lastReviewEvent !== null) validateEvent(item.lastReviewEvent, item.itemId);
  canonicalStringify(item);
  return item;
}

function validateEvent(event, itemId) {
  if (!event || typeof event !== "object" || Array.isArray(event) || event.schemaVersion !== 1 ||
      event.itemId !== itemId || typeof event.eventId !== "string" || !event.eventId ||
      typeof event.actionId !== "string" || !event.actionId || !["remember", "forget"].includes(event.rating) ||
      !Number.isSafeInteger(event.sequence) || event.sequence < 1 ||
      !(event.previousEventId === null || typeof event.previousEventId === "string") ||
      event.schedulerVersion !== LEITNER_SCHEDULER_VERSION) {
    throw codedError("LEARNING_REVIEW_EVENT_INVALID", "The learning review event is malformed.");
  }
  validateUtc(event.reviewedAtUTC, "reviewedAtUTC");
  return event;
}

function normalizePageSize(value) {
  const limit = value == null ? DEFAULT_PAGE_SIZE : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw codedError("LEARNING_PAGE_SIZE_INVALID", `Learning page size must be from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return limit;
}

function encodeCursor(item) {
  const text = canonicalStringify({ dueAt: item.reviewState.dueAt, itemId: item.itemId });
  const binary = [...new TextEncoder().encode(text)].map((byte) => String.fromCharCode(byte)).join("");
  return "learning-due-v1." + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function decodeCursor(cursor) {
  if (cursor == null || cursor === "") return null;
  if (typeof cursor !== "string" || !cursor.startsWith("learning-due-v1.")) {
    throw codedError("LEARNING_CURSOR_INVALID", "The learning due cursor is invalid.");
  }
  try {
    const binary = atob(cursor.slice("learning-due-v1.".length).replaceAll("-", "+").replaceAll("_", "/"));
    const text = new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
    const value = JSON.parse(text);
    if (!value || typeof value.itemId !== "string" || !value.itemId || typeof value.dueAt !== "string") throw new Error("invalid cursor value");
    validateUtc(value.dueAt, "cursor dueAt");
    return value;
  } catch (error) {
    if (error?.code === "LEARNING_CURSOR_INVALID") throw error;
    throw codedError("LEARNING_CURSOR_INVALID", "The learning due cursor is malformed.", undefined, error);
  }
}

function actionBatchId(prefix, actionId) {
  return `${prefix}-${hashText(actionId).slice("sha256-v1:".length)}`;
}

function pathForItem(manifest, itemId) {
  const digest = hashText(itemId).slice("sha256-v1:".length);
  const shard = manifest?.shards?.find((entry) => digest.startsWith(entry.prefix));
  return shard?.path || manifestPathFor(LEARNING_ROOT);
}

function makeHistoryStores(plan) {
  return plan.writes.map((write) => {
    const value = JSON.parse(write.text);
    return {
      storeId: LEARNING_STORE_ID,
      path: write.path,
      baseRevision: write.expectedRevision,
      resultRevision: value.revision,
      baseHash: write.expectedHash,
      resultHash: hashText(write.text),
    };
  });
}

function makeIdentityChange({ path, itemId, kind, beforeExists, before, afterExists, after, field }) {
  const fieldPath = kind === "entityCreate" || kind === "entityDelete"
    ? ["records", itemId]
    : ["records", itemId, field];
  return {
    storeId: LEARNING_STORE_ID, path, entityId: itemId, kind, fieldPath,
    beforeExists, ...(beforeExists ? { before: clone(before) } : {}),
    afterExists, ...(afterExists ? { after: clone(after) } : {}),
    ...(field ? { field } : {}),
  };
}

function sourceLinkFor(item) {
  const source = item.source;
  const sourcePath = safeVaultPath(source.sourcePath);
  if (!sourcePath) return "";
  if (source.evidenceKind === "markdown" || source.evidenceKind === "backlink" || source.target?.kind === "markdown") {
    const line = source.sourceRange?.line;
    return Number.isSafeInteger(line) && line >= 0 ? `${sourcePath} (line ${line})` : sourcePath;
  }
  const fragment = encodeReaderLinkFragment({
    pageNumber: Number.isSafeInteger(source.pageIndex) && source.pageIndex >= 0 ? source.pageIndex + 1 : undefined,
    docKey: source.docKey,
    documentId: source.documentId,
    target: source.target,
  });
  return fragment ? `${sourcePath}#${fragment}` : sourcePath;
}

function safeVaultPath(value) {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f#?]/.test(value) ||
      value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
      value.split(/[\\/]/).some((segment) => !segment || segment === "." || segment === "..")) return "";
  return value.replaceAll("\\", "/");
}

function validateVaultPath(value, name) {
  if (typeof value !== "string") {
    throw codedError("LEARNING_SOURCE_PATH_INVALID", `${name} must be a safe vault-relative path.`);
  }
  const normalized = safeVaultPath(value);
  if (!normalized) {
    throw codedError("LEARNING_SOURCE_PATH_INVALID", `${name} must be a safe vault-relative path.`);
  }
  return normalized;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function tsvCell(value) {
  return String(value ?? "").replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function markdownCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\r\n", "<br>").replaceAll("\n", "<br>").replaceAll("\r", "<br>");
}

function createLearningService({ runtime, verifySource, now = () => new Date(), makeId = defaultMakeId,
  maxRecords, maxBytes } = {}) {
  const coordinator = runtime?.coordinator;
  const history = runtime?.history;
  if (!coordinator || typeof coordinator.readSnapshot !== "function" || typeof coordinator.commit !== "function" ||
      !history || typeof history.registerStoreHandler !== "function" || typeof history.readBatch !== "function" ||
      typeof history.listBatches !== "function") {
    throw new TypeError("Learning requires the existing runtime coordinator and History.");
  }
  if (typeof runtime.exclusive !== "function") throw new TypeError("Learning requires runtime.exclusive().");
  if (typeof verifySource !== "function" || typeof now !== "function" || typeof makeId !== "function") {
    throw new TypeError("Learning requires verifySource, clock, and ID factory functions.");
  }
  const scheduler = new LeitnerScheduler();
  const store = createShardedStore({
    transaction: coordinator,
    storeId: LEARNING_STORE_ID,
    root: LEARNING_ROOT,
    kind: LEARNING_KIND,
    idOf: (item) => item?.itemId,
    ...(maxRecords == null ? {} : { maxRecords }),
    ...(maxBytes == null ? {} : { maxBytes }),
  });
  const drafts = new Map();
  const skippedForSession = new Set();
  let serial = Promise.resolve();
  let localDraftSequence = 0;

  function enqueue(task) {
    const result = serial.then(() => runtime.exclusive(task));
    serial = result.catch(() => undefined);
    return result;
  }

  async function load() {
    const loaded = await store.load();
    for (const item of loaded.records) validateItem(item, item.itemId);
    return loaded;
  }

  async function verifyExactSource(source) {
    let result;
    try { result = await verifySource(clone(source)); }
    catch (error) {
      throw codedError("LEARNING_SOURCE_STALE", "The selected source is no longer verified; the draft remains available.",
        { source }, error);
    }
    const returned = result?.anchor ?? result?.source ?? result?.semanticAnchor;
    if (result?.status !== "verified" || result.sourceCurrent !== true || result.pageCurrent !== true ||
        !returned || !same(returned, source)) {
      throw codedError("LEARNING_SOURCE_STALE", "The selected source is no longer verified; the draft remains available.",
        { status: result?.status || "unverified", source });
    }
    return result;
  }

  function makeDraftItem(draft, actionId, createdAt) {
    return {
      schemaVersion: 1,
      itemId: draft.itemId,
      externalId: draft.externalId,
      createActionId: actionId,
      prompt: draft.prompt,
      answer: draft.answer,
      targetText: draft.targetText,
      source: clone(draft.source),
      createdAt,
      reviewState: scheduler.initialState(createdAt),
      lastReviewEvent: null,
    };
  }

  function findCreateChange(batch) {
    return batch?.changes?.find((change) => change.storeId === LEARNING_STORE_ID &&
      change.kind === "entityCreate" && change.fieldPath?.length === 2 && change.fieldPath[0] === "records");
  }

  async function duplicateCreateFor(actionId, draft) {
    const batchId = actionBatchId("learning-confirm", actionId);
    const batch = await history.readBatch(batchId);
    if (!batch) return null;
    const change = findCreateChange(batch);
    const prior = change?.after;
    if (batch.actionKind !== "learning-confirm" || !prior || prior.createActionId !== actionId ||
        prior.prompt !== draft.prompt || prior.answer !== draft.answer || prior.targetText !== draft.targetText ||
        !same(prior.source, draft.source)) {
      throw codedError("LEARNING_ACTION_ID_REUSE", "A confirmation action ID cannot be reused for another draft.");
    }
    const loaded = await load();
    const current = loaded.records.find((item) => item.itemId === prior.itemId);
    return { status: current ? "duplicate" : "already-undone", actionId, item: clone(current || prior), writes: 0 };
  }

  function createDraft({ source, prompt = "", answer } = {}) {
    const savedSource = validateSource(source);
    const targetText = savedSource.targetText;
    const draftId = `learning-draft:${++localDraftSequence}:${makeId()}`;
    const entropy = makeId();
    const itemId = `learning:v1:${entropy}`;
    const draft = {
      draftId,
      itemId,
      externalId: `obreader-learning:v1:${entropy}`,
      source: savedSource,
      prompt: validateText(prompt, "prompt", { allowEmpty: true }),
      answer: validateText(answer === undefined ? targetText : answer, "answer", { allowEmpty: true }),
      targetText,
    };
    drafts.set(draftId, draft);
    return clone(draft);
  }

  function updateDraft(draftId, changes = {}) {
    const current = drafts.get(draftId);
    if (!current) throw codedError("LEARNING_DRAFT_MISSING", "The learning draft is no longer available.");
    const next = {
      ...current,
      ...(Object.hasOwn(changes, "prompt") ? { prompt: validateText(changes.prompt, "prompt", { allowEmpty: true }) } : {}),
      ...(Object.hasOwn(changes, "answer") ? { answer: validateText(changes.answer, "answer", { allowEmpty: true }) } : {}),
    };
    drafts.set(draftId, next);
    return clone(next);
  }

  function cancelDraft(draftId) {
    return { status: drafts.delete(draftId) ? "cancelled" : "missing", writes: 0 };
  }

  async function confirmDraft(draftId, { actionId } = {}) {
    const selectedActionId = validateActionId(actionId);
    return enqueue(async () => {
      const draft = drafts.get(draftId);
      if (!draft) throw codedError("LEARNING_DRAFT_MISSING", "The learning draft is no longer available.");
      const prompt = validateText(draft.prompt, "prompt");
      const answer = validateText(draft.answer, "answer");
      const normalizedDraft = { ...draft, prompt, answer };
      const duplicate = await duplicateCreateFor(selectedActionId, normalizedDraft);
      if (duplicate) {
        drafts.delete(draftId);
        return duplicate;
      }
      await verifyExactSource(draft.source);
      const loaded = await load();
      const existing = loaded.records.find((item) => item.createActionId === selectedActionId);
      if (existing) {
        if (existing.prompt !== prompt || existing.answer !== answer || existing.targetText !== draft.targetText ||
            !same(existing.source, draft.source)) {
          throw codedError("LEARNING_ACTION_ID_REUSE", "A confirmation action ID cannot be reused for another draft.");
        }
        drafts.delete(draftId);
        return { status: "duplicate", actionId: selectedActionId, item: clone(existing), writes: 0 };
      }
      const createdAt = readUtcNow(now);
      const item = makeDraftItem(normalizedDraft, selectedActionId, createdAt);
      validateItem(item);
      const plan = await prepareShardedReplacement({
        readSnapshot: (path) => coordinator.readSnapshot(path),
        loaded,
        records: [...loaded.records, item],
        storeId: LEARNING_STORE_ID,
        root: LEARNING_ROOT,
        kind: LEARNING_KIND,
        idOf: (candidate) => candidate?.itemId,
        ...(maxRecords == null ? {} : { maxRecords }),
        ...(maxBytes == null ? {} : { maxBytes }),
      });
      const batchId = actionBatchId("learning-confirm", selectedActionId);
      const path = pathForItem(plan.manifest, item.itemId);
      const change = makeIdentityChange({
        path, itemId: item.itemId, kind: "entityCreate", beforeExists: false,
        afterExists: true, after: item,
      });
      const historySummary = {
        batchId, sessionId: coordinator.sessionId, kind: "learning-confirm",
        entities: [{ storeId: LEARNING_STORE_ID, entityId: item.itemId, kind: "entityCreate" }],
        stores: makeHistoryStores(plan), changes: [change],
      };
      const result = await coordinator.commit({
        actionId: selectedActionId,
        writes: plan.writes,
        deletes: plan.deletes,
        historySummary,
        entities: historySummary.entities,
      });
      if (result.status === "conflict") {
        const recovered = await duplicateCreateFor(selectedActionId, normalizedDraft);
        if (recovered) {
          drafts.delete(draftId);
          return recovered;
        }
        throw codedError("LEARNING_TX_CONFLICT", "Learning item confirmation conflicted with another writer; the draft remains available.", result);
      }
      if (result.status !== "committed") throw codedError("LEARNING_TX_FAILED", "Learning item confirmation did not commit.", result);
      drafts.delete(draftId);
      return { ...result, status: "committed", actionId: selectedActionId, item: clone(item), writes: plan.writes.length };
    });
  }

  async function getItem(itemId) {
    validateItemId(itemId);
    return runtime.exclusive(async () => {
      const loaded = await load();
      const item = loaded.records.find((candidate) => candidate.itemId === itemId);
      return item ? clone(item) : undefined;
    });
  }

  async function listDue(options = {}) {
    const limit = normalizePageSize(options.limit);
    const cursor = decodeCursor(options.cursor);
    return runtime.exclusive(async () => {
      const loaded = await load();
      const atUTC = readUtcNow(now);
      const due = loaded.records.filter((item) => item.reviewState.dueAt <= atUTC && !skippedForSession.has(item.itemId))
        .sort((left, right) => left.reviewState.dueAt.localeCompare(right.reviewState.dueAt) || left.itemId.localeCompare(right.itemId));
      const after = due.filter((item) => !cursor || item.reviewState.dueAt > cursor.dueAt ||
        (item.reviewState.dueAt === cursor.dueAt && item.itemId > cursor.itemId));
      const page = after.slice(0, limit);
      return {
        items: page.map((item) => ({
          itemId: item.itemId, externalId: item.externalId, dueAt: item.reviewState.dueAt,
          prompt: item.prompt, answer: item.answer, targetText: item.targetText,
          source: clone(item.source), state: clone(item.reviewState), item: clone(item),
        })),
        nextCursor: after.length > limit ? encodeCursor(page.at(-1)) : null,
        total: due.length,
      };
    });
  }

  function findRatingChange(batch, field = "lastReviewEvent") {
    return batch?.changes?.find((change) => change.storeId === LEARNING_STORE_ID && change.field === field &&
      change.fieldPath?.[0] === "records" && change.fieldPath?.[2] === field);
  }

  async function duplicateRatingFor(actionId, itemId, rating) {
    const batch = await history.readBatch(actionBatchId("learning-rating", actionId));
    if (!batch) return null;
    const change = findRatingChange(batch);
    const event = change?.after;
    if (batch.actionKind !== "learning-rating" || event?.actionId !== actionId || event?.itemId !== itemId || event?.rating !== rating) {
      throw codedError("LEARNING_ACTION_ID_REUSE", "A review action ID cannot be reused for another item or rating.");
    }
    return { status: "duplicate", actionId, itemId, event: clone(event), writes: 0 };
  }

  async function rate(itemId, rating, { actionId } = {}) {
    validateItemId(itemId);
    if (!["remember", "forget", "skip"].includes(rating)) {
      throw codedError("LEARNING_RATING_INVALID", "Rating must be remember, forget, or skip.");
    }
    if (rating === "skip") {
      return runtime.exclusive(async () => {
        skippedForSession.add(itemId);
        return { status: "skipped", itemId, writes: 0 };
      });
    }
    const selectedActionId = validateActionId(actionId);
    return enqueue(async () => {
      const duplicate = await duplicateRatingFor(selectedActionId, itemId, rating);
      if (duplicate) return duplicate;
      const loaded = await load();
      const current = loaded.records.find((candidate) => candidate.itemId === itemId);
      if (!current) throw codedError("LEARNING_ITEM_MISSING", "The learning item no longer exists.");
      const reviewedAtUTC = readUtcNow(now);
      const transition = scheduler.rate(current.reviewState, rating, reviewedAtUTC);
      const previous = current.lastReviewEvent;
      const event = {
        schemaVersion: 1,
        eventId: `learning-event:v1:${hashText(`${itemId}\u0000${selectedActionId}`).slice("sha256-v1:".length)}`,
        itemId,
        actionId: selectedActionId,
        rating,
        reviewedAtUTC,
        sequence: (previous?.sequence || 0) + 1,
        previousEventId: previous?.eventId || null,
        schedulerVersion: LEITNER_SCHEDULER_VERSION,
      };
      const updated = { ...clone(current), reviewState: transition.state, lastReviewEvent: event };
      validateItem(updated);
      const records = loaded.records.map((candidate) => candidate.itemId === itemId ? updated : candidate);
      const plan = await prepareShardedReplacement({
        readSnapshot: (path) => coordinator.readSnapshot(path),
        loaded,
        records,
        storeId: LEARNING_STORE_ID,
        root: LEARNING_ROOT,
        kind: LEARNING_KIND,
        idOf: (candidate) => candidate?.itemId,
        ...(maxRecords == null ? {} : { maxRecords }),
        ...(maxBytes == null ? {} : { maxBytes }),
      });
      const batchId = actionBatchId("learning-rating", selectedActionId);
      const path = pathForItem(plan.manifest, itemId);
      const historySummary = {
        batchId, sessionId: coordinator.sessionId, kind: "learning-rating",
        entities: [{ storeId: LEARNING_STORE_ID, entityId: itemId, kind: "record" }],
        stores: makeHistoryStores(plan),
        changes: ["reviewState", "lastReviewEvent"].map((field) => makeIdentityChange({
          path, itemId, kind: "field", field,
          beforeExists: true, before: current[field], afterExists: true, after: updated[field],
        })),
      };
      const result = await coordinator.commit({
        actionId: selectedActionId,
        writes: plan.writes,
        deletes: plan.deletes,
        historySummary,
        entities: historySummary.entities,
      });
      if (result.status === "conflict") {
        const recovered = await duplicateRatingFor(selectedActionId, itemId, rating);
        if (recovered) return recovered;
        throw codedError("LEARNING_TX_CONFLICT", "Learning rating conflicted with another writer; no stale state was applied.", result);
      }
      if (result.status !== "committed") throw codedError("LEARNING_TX_FAILED", "Learning rating did not commit.", result);
      skippedForSession.delete(itemId);
      return { ...result, status: "committed", actionId: selectedActionId, itemId, state: clone(updated.reviewState), event: clone(event), writes: plan.writes.length };
    });
  }

  async function renameMarkdownSource(fromPath, toPath, { actionId } = {}) {
    const from = validateVaultPath(fromPath, "fromPath");
    const to = validateVaultPath(toPath, "toPath");
    if (from === to) return { status: "unchanged", movedItems: 0, writes: 0 };
    const selectedActionId = validateActionId(actionId ||
      `learning-source-rename:${hashText(`${from}\u0000${to}\u0000${makeId()}`).slice("sha256-v1:".length)}`);
    return enqueue(async () => {
      const batchId = actionBatchId("learning-source-rename", selectedActionId);
      const prior = await history.readBatch(batchId);
      const loaded = await load();
      if (prior) {
        const priorChanges = prior.changes?.filter((change) => change.storeId === LEARNING_STORE_ID && change.field === "source") || [];
        if (prior.actionKind !== "learning-source-rename" || !priorChanges.length || priorChanges.some((change) => {
          const before = change.before?.sourcePath;
          const after = change.after?.sourcePath;
          return typeof before !== "string" || typeof after !== "string" ||
            !(before === from || before.startsWith(`${from}/`)) ||
            after !== `${to}${before.slice(from.length)}`;
        })) {
          throw codedError("LEARNING_ACTION_ID_REUSE", "A source-rename action ID cannot be reused for another move.");
        }
        const currentById = new Map(loaded.records.map((item) => [item.itemId, item]));
        const isAt = (change, sourcePath) => currentById.get(change.entityId)?.source?.sourcePath === sourcePath;
        if (priorChanges.every((change) => isAt(change, change.after.sourcePath))) {
          return { status: "duplicate", actionId: selectedActionId,
            itemIds: priorChanges.map((change) => change.entityId), movedItems: priorChanges.length, writes: 0 };
        }
        if (priorChanges.every((change) => isAt(change, change.before.sourcePath))) {
          return { status: "already-undone", actionId: selectedActionId,
            itemIds: priorChanges.map((change) => change.entityId), movedItems: 0, writes: 0 };
        }
        throw codedError("LEARNING_ACTION_ID_REUSE", "The learning source no longer matches the original rename action.");
      }

      const moved = [];
      const prefix = `${from}/`;
      for (const item of loaded.records) {
        const source = item.source;
        if (!source || !["markdown", "backlink"].includes(source.evidenceKind)) continue;
        const oldSourcePath = source.sourcePath;
        if (oldSourcePath !== from && !oldSourcePath.startsWith(prefix)) continue;
        const nextPath = validateVaultPath(`${to}${oldSourcePath.slice(from.length)}`, "renamed sourcePath");
        const updated = { ...clone(item), source: { ...clone(source), sourcePath: nextPath } };
        validateItem(updated);
        moved.push({ before: item, after: updated });
      }
      if (!moved.length) return { status: "unchanged", actionId: selectedActionId, movedItems: 0, writes: 0 };

      const updatedById = new Map(moved.map(({ after }) => [after.itemId, after]));
      const records = loaded.records.map((item) => updatedById.get(item.itemId) || item);
      const plan = await prepareShardedReplacement({
        readSnapshot: (path) => coordinator.readSnapshot(path), loaded, records,
        storeId: LEARNING_STORE_ID, root: LEARNING_ROOT, kind: LEARNING_KIND,
        idOf: (item) => item?.itemId,
        ...(maxRecords == null ? {} : { maxRecords }),
        ...(maxBytes == null ? {} : { maxBytes }),
      });
      const changes = moved.map(({ before, after }) => makeIdentityChange({
        path: pathForItem(plan.manifest, before.itemId), itemId: before.itemId, kind: "field", field: "source",
        beforeExists: true, before: before.source, afterExists: true, after: after.source,
      }));
      const entities = moved.map(({ before }) => ({ storeId: LEARNING_STORE_ID, entityId: before.itemId, kind: "record" }));
      const historySummary = {
        batchId, sessionId: coordinator.sessionId, kind: "learning-source-rename",
        entities, stores: makeHistoryStores(plan), changes,
      };
      const result = await coordinator.commit({
        actionId: selectedActionId, writes: plan.writes, deletes: plan.deletes,
        historySummary, entities,
      });
      if (result.status === "conflict") {
        throw codedError("LEARNING_TX_CONFLICT", "Learning source rename conflicted with another writer; no stale path was applied.", result);
      }
      if (result.status !== "committed") throw codedError("LEARNING_TX_FAILED", "Learning source rename did not commit.", result);
      return { ...result, status: "committed", actionId: selectedActionId,
        itemIds: moved.map(({ before }) => before.itemId), movedItems: moved.length, writes: plan.writes.length };
    });
  }

  async function loadFromSnapshots(snapshots = new Map()) {
    const manifestPath = manifestPathFor(LEARNING_ROOT);
    const loaded = await readShardedStore({
      readSnapshot: async (path) => snapshots.get(path) || coordinator.readSnapshot(path),
      hasShardFiles: (root) => hasShardFilesFromAdapter(coordinator.adapter, root),
      storeId: LEARNING_STORE_ID, root: LEARNING_ROOT, kind: LEARNING_KIND,
      idOf: (item) => item?.itemId,
      ...(maxRecords == null ? {} : { maxRecords }),
      ...(maxBytes == null ? {} : { maxBytes }),
    });
    const latestManifest = await coordinator.readSnapshot(manifestPath);
    if (latestManifest.revision !== loaded.manifestSnapshot.revision || latestManifest.hash !== loaded.manifestSnapshot.hash) {
      throw codedError("LEARNING_RESTORE_SNAPSHOT_MISMATCH", "The learning manifest changed while resolving History state.");
    }
    for (const item of loaded.records) validateItem(item, item.itemId);
    return loaded;
  }

  function createHistoryRestoreHandler() {
    return Object.freeze({
      async resolveField({ change } = {}) {
        if (!change || change.storeId !== LEARNING_STORE_ID || typeof change.entityId !== "string" ||
            !Array.isArray(change.fieldPath) || change.fieldPath[0] !== "records" ||
            change.fieldPath[1] !== change.entityId || typeof change.path !== "string" ||
            !change.path.startsWith(`${LEARNING_ROOT}/`)) {
          throw codedError("LEARNING_RESTORE_FIELD_INVALID", "Learning History refers to an unsupported identity or path.");
        }
        const loaded = await loadFromSnapshots();
        const item = loaded.records.find((candidate) => candidate.itemId === change.entityId) || null;
        if (change.kind === "entityCreate" || change.kind === "entityDelete") {
          if (change.fieldPath.length !== 2) throw codedError("LEARNING_RESTORE_FIELD_INVALID", "Learning lifecycle History must target one complete item.");
          return { exists: Boolean(item), ...(item ? { value: clone(item) } : {}), entityExists: Boolean(item) };
        }
        const field = change.fieldPath[2];
        if (!item || change.fieldPath.length !== 3 || !(REVIEW_HISTORY_FIELDS.has(field) || field === "source") || change.field !== field) {
          throw codedError("LEARNING_RESTORE_FIELD_INVALID", "Learning History may restore review state, event head, or soft source provenance fields.");
        }
        return { exists: true, value: clone(item[field]), entityExists: true };
      },

      async planRestore({ batch, selectedChanges, snapshots, overwriteConflictIds = [] } = {}) {
        if (!batch || batch.kind !== "vocabulary-history-batch" ||
            !["learning-confirm", "learning-rating", "learning-source-rename", "restore"].includes(batch.actionKind) ||
            !Array.isArray(selectedChanges) || !(snapshots instanceof Map)) {
          throw codedError("LEARNING_RESTORE_BATCH_INVALID", "A learning History batch and its verified snapshots are required.");
        }
        const overwrite = new Set(overwriteConflictIds);
        const loaded = await loadFromSnapshots(snapshots);
        const byId = new Map(loaded.records.map((item) => [item.itemId, clone(item)]));
        const groups = new Map();
        for (const change of selectedChanges) {
          if (change.storeId !== LEARNING_STORE_ID || !validateItemId(change.entityId) ||
              !Array.isArray(change.fieldPath) || change.fieldPath[0] !== "records" || change.fieldPath[1] !== change.entityId ||
              typeof change.path !== "string" || !change.path.startsWith(`${LEARNING_ROOT}/`) ||
              !["field", "entityCreate", "entityDelete"].includes(change.kind) ||
              typeof change.beforeExists !== "boolean" || typeof change.afterExists !== "boolean" ||
              (change.status !== "clean" && !(change.status === "conflict" && overwrite.has(change.changeId)))) {
            throw codedError("LEARNING_RESTORE_CHANGE_INVALID", "Learning History selected an unsupported or unapproved change.");
          }
          const lifecycle = change.kind === "entityCreate" || change.kind === "entityDelete";
          if ((lifecycle && change.fieldPath.length !== 2) || (!lifecycle &&
              (change.fieldPath.length !== 3 || !(REVIEW_HISTORY_FIELDS.has(change.fieldPath[2]) || change.fieldPath[2] === "source") ||
               change.field !== change.fieldPath[2]))) {
            throw codedError("LEARNING_RESTORE_FIELD_INVALID", "Learning History may restore a full item lifecycle, paired review fields, or soft source provenance.");
          }
          const group = groups.get(change.entityId) || [];
          group.push(change);
          groups.set(change.entityId, group);
        }

        const changes = [];
        for (const [itemId, group] of groups) {
          const kinds = new Set(group.map((change) => change.kind));
          if (kinds.size !== 1) throw codedError("LEARNING_RESTORE_CHANGE_INVALID", "One learning item cannot mix lifecycle and field restore changes.");
          const kind = group[0].kind;
          let item = byId.get(itemId) || null;
          if (kind === "entityCreate") {
            if (group.length !== 1 || group[0].beforeExists || !group[0].afterExists || !item) {
              throw codedError("LEARNING_RESTORE_LIFECYCLE_INVALID", "Learning item creation undo requires the complete item lifecycle change.");
            }
            if (group[0].status === "clean" && !same(item, group[0].after)) {
              throw codedError("LEARNING_RESTORE_SNAPSHOT_MISMATCH", "The learning item no longer matches its creation History snapshot.");
            }
            changes.push(makeIdentityChange({ path: group[0].path, itemId, kind: "entityDelete",
              beforeExists: true, before: item, afterExists: false }));
            byId.delete(itemId);
            continue;
          }
          if (kind === "entityDelete") {
            if (group.length !== 1 || !group[0].beforeExists || group[0].afterExists || item) {
              throw codedError("LEARNING_RESTORE_LIFECYCLE_INVALID", "Learning item creation redo requires an absent item and complete snapshot.");
            }
            item = validateItem(clone(group[0].before), itemId);
            changes.push(makeIdentityChange({ path: group[0].path, itemId, kind: "entityCreate",
              beforeExists: false, afterExists: true, after: item }));
            byId.set(itemId, item);
            continue;
          }
          if (!item) throw codedError("LEARNING_RESTORE_ITEM_MISSING", "A learning review restore requires the current item.");
          const fieldNames = group.map((change) => change.field);
          const hasReviewField = fieldNames.some((field) => REVIEW_HISTORY_FIELDS.has(field));
          if (new Set(fieldNames).size !== fieldNames.length ||
              (hasReviewField && (fieldNames.includes("reviewState") !== fieldNames.includes("lastReviewEvent"))) ||
              (fieldNames.includes("source") && fieldNames.length !== 1)) {
            throw codedError("LEARNING_RESTORE_REVIEW_PAIR_REQUIRED", "Review state and event head must be restored together.");
          }
          for (const change of group) {
            const field = change.field;
            const current = item[field];
            if (change.status === "clean" && !same(current, change.after)) {
              throw codedError("LEARNING_RESTORE_SNAPSHOT_MISMATCH", `Learning ${field} no longer matches its History snapshot.`);
            }
            const afterValue = clone(change.before);
            const inverseKind = "field";
            changes.push(makeIdentityChange({ path: change.path, itemId, kind: inverseKind, field,
              beforeExists: true, before: current, afterExists: change.beforeExists, after: afterValue }));
            if (change.beforeExists) item[field] = afterValue;
            else delete item[field];
          }
          validateItem(item, itemId);
          byId.set(itemId, item);
        }

        const records = [...byId.values()];
        const plan = await prepareShardedReplacement({
          readSnapshot: (path) => snapshots.get(path) || coordinator.readSnapshot(path),
          loaded, records, storeId: LEARNING_STORE_ID, root: LEARNING_ROOT, kind: LEARNING_KIND,
          idOf: (item) => item?.itemId,
          ...(maxRecords == null ? {} : { maxRecords }),
          ...(maxBytes == null ? {} : { maxBytes }),
        });
        for (const change of changes) change.path = pathForItem(plan.manifest, change.entityId) || manifestPathFor(LEARNING_ROOT);
        const entities = [...groups.keys()].sort().map((entityId) => ({
          storeId: LEARNING_STORE_ID, entityId,
          kind: groupKindInverse(groups.get(entityId)[0].kind),
        }));
        return { writes: plan.writes, changes, entities };
      },
    });
  }

  function groupKindInverse(kind) {
    return kind === "entityCreate" ? "entityDelete" : kind === "entityDelete" ? "entityCreate" : "record";
  }

  history.registerStoreHandler(LEARNING_STORE_ID, createHistoryRestoreHandler());

  async function exportItems(format = "json") {
    const supported = new Set(["json", "markdown", "csv", "anki-tsv"]);
    if (!supported.has(format)) throw codedError("LEARNING_EXPORT_FORMAT_INVALID", "Export format must be json, markdown, csv, or anki-tsv.");
    return runtime.exclusive(async () => {
      const loaded = await load();
      const batches = await history.listBatches({ deviceIds: [coordinator.deviceId] });
      const allEvents = [];
      const eventById = new Map();
      for (const batch of batches) {
        if (batch.actionKind !== "learning-rating") continue;
        const change = findRatingChange(batch);
        const event = change?.after;
        if (!event || typeof event.eventId !== "string") continue;
        validateEvent(event, event.itemId);
        if (!eventById.has(event.eventId)) eventById.set(event.eventId, clone(event));
      }
      allEvents.push(...eventById.values());
      const items = loaded.records.slice().sort((left, right) => left.externalId.localeCompare(right.externalId)).map((item) => {
        const history = allEvents.filter((event) => event.itemId === item.itemId)
          .sort((left, right) => left.sequence - right.sequence || left.reviewedAtUTC.localeCompare(right.reviewedAtUTC) || left.eventId.localeCompare(right.eventId));
        const activeEventIds = new Set();
        let head = item.lastReviewEvent;
        while (head && !activeEventIds.has(head.eventId)) {
          activeEventIds.add(head.eventId);
          head = eventById.get(head.previousEventId) || null;
        }
        return {
          externalId: item.externalId,
          itemId: item.itemId,
          prompt: item.prompt,
          answer: item.answer,
          targetText: item.targetText,
          sourceLink: sourceLinkFor(item),
          source: clone(item.source),
          reviewState: clone(item.reviewState),
          lastReviewEvent: clone(item.lastReviewEvent),
          reviewHistory: history.map((event) => ({ ...clone(event), onCurrentBranch: activeEventIds.has(event.eventId) })),
        };
      });
      let content;
      if (format === "json") {
        content = JSON.stringify({ schemaVersion: 1, kind: "learning-items-export", schedulerVersion: scheduler.version, items }, null, 2);
      } else if (format === "markdown") {
        content = ["# Learning items", "", ...items.flatMap((item) => [
          `## ${markdownCell(item.prompt)}`, "", `- ExternalID: ${markdownCell(item.externalId)}`,
          `- Answer: ${markdownCell(item.answer)}`, `- Target text: ${markdownCell(item.targetText)}`,
          `- Source: ${markdownCell(item.sourceLink)}`, `- Due: ${markdownCell(item.reviewState.dueAt)}`, "",
        ])].join("\n");
      } else if (format === "csv") {
        const headers = ["ExternalID", "Prompt", "Answer", "TargetText", "SourceLink", "Box", "DueAt", "ReviewHistory"];
        content = [headers.join(","), ...items.map((item) => [item.externalId, item.prompt, item.answer, item.targetText,
          item.sourceLink, item.reviewState.box, item.reviewState.dueAt,
          JSON.stringify(item.reviewHistory)].map(csvCell).join(","))].join("\r\n");
      } else {
        const headers = ["ExternalID", "Prompt", "Answer", "TargetText", "SourceLink"];
        content = [headers.join("\t"), ...items.map((item) => [item.externalId, item.prompt, item.answer,
          item.targetText, item.sourceLink].map(tsvCell).join("\t"))].join("\n");
      }
      return { format, content, itemCount: items.length };
    });
  }

  return Object.freeze({
    root: LEARNING_ROOT,
    storeId: LEARNING_STORE_ID,
    scheduler,
    createDraft,
    updateDraft,
    cancelDraft,
    confirmDraft,
    getItem,
    listDue,
    rate,
    renameMarkdownSource,
    exportItems,
    getDraft: (draftId) => drafts.has(draftId) ? clone(drafts.get(draftId)) : undefined,
  });
}

function defaultMakeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

module.exports = {
  LEARNING_STORE_ID,
  LEARNING_ROOT,
  LEARNING_KIND,
  createLearningService,
  validateSource,
  validateItem,
};
