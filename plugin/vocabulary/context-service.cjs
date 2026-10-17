"use strict";

const { canonicalHash, canonicalStringify } = require("./canonical.cjs");
const { validateSelectionAnchor } = require("../reader-anchor-store.cjs");
const { VOCABULARY_DATA_ROOT, createShardedStore, prepareShardedReplacement } = require("./sharded-store.cjs");

const CONTEXT_STORE_ID = "vocabulary-contexts-v1";
const CONTEXT_ROOT = "00_Archive/21_VocabularyData/contexts";
const CONTEXT_KIND = "context";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "VocabularyContextError";
  error.code = code;
  return error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonicalAnchorTuple(anchor) {
  validateSelectionAnchor(anchor);
  const tuple = {
    anchorId: anchor.anchorId,
    docKey: anchor.docKey.toLowerCase(),
    documentId: anchor.documentId,
    sourceHash: anchor.sourceHash,
    pageIdentity: anchor.pageIdentity,
    pageIndexHint: anchor.pageIndexHint,
    textPosition: { start: anchor.textPosition.start, end: anchor.textPosition.end },
    exactQuote: anchor.exactQuote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    orderedPageIdentityDigest: anchor.orderedPageIdentityDigest,
    pageCount: anchor.pageCount,
  };
  if (anchor.geometry !== undefined) tuple.geometry = clone(anchor.geometry);
  return tuple;
}

function contextIdentity(familyKey, anchor) {
  return {
    familyKey,
    documentId: anchor.documentId,
    anchorId: anchor.anchorId,
    sourceIdentity: canonicalAnchorTuple(anchor),
  };
}

function contextIdFor(identity) {
  const stableTuple = {
    familyKey: identity.familyKey,
    documentId: identity.documentId,
    anchorId: identity.anchorId,
  };
  return `context:v1:${canonicalHash(stableTuple).slice("sha256-v1:".length)}`;
}

function decodeCursor(cursor) {
  if (cursor == null || cursor === "") return null;
  if (typeof cursor !== "string" || !cursor.startsWith("ctx1.")) {
    throw codedError("VOCAB_CONTEXT_CURSOR_INVALID", "The Context page cursor is invalid.");
  }
  const encoded = cursor.slice(5);
  try {
    const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) ||
        typeof parsed.contextId !== "string" || !parsed.contextId.startsWith("context:v1:")) throw new Error("invalid cursor fields");
    return parsed;
  } catch (error) {
    if (error?.code === "VOCAB_CONTEXT_CURSOR_INVALID") throw error;
    throw codedError("VOCAB_CONTEXT_CURSOR_INVALID", "The Context page cursor is invalid.", error);
  }
}

function encodeCursor(context) {
  const bytes = new TextEncoder().encode(canonicalStringify({ createdAt: context.createdAt, contextId: context.contextId }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `ctx1.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "")}`;
}

function compareContextOrder(left, right) {
  if (left.createdAt !== right.createdAt) return left.createdAt > right.createdAt ? -1 : 1;
  return left.contextId < right.contextId ? -1 : left.contextId > right.contextId ? 1 : 0;
}

function isAfterCursor(context, cursor) {
  return context.createdAt < cursor.createdAt ||
    (context.createdAt === cursor.createdAt && context.contextId > cursor.contextId);
}

function utcNow(now) {
  let value;
  try { value = now(); }
  catch (error) { throw codedError("VOCAB_CONTEXT_CLOCK_FAILED", "Could not read the current UTC time.", error); }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw codedError("VOCAB_CONTEXT_CLOCK_INVALID", "The current UTC time is invalid.");
  return date.toISOString();
}

function snapshotIdentity(anchor) {
  return canonicalStringify(canonicalAnchorTuple(anchor));
}

function tokenizeContextSurface(value) {
  if (typeof value !== "string") return [];
  const joined = value.normalize("NFC")
    // PDF text selection may preserve a visual line-end hyphen even when it
    // represents one printed word. Rejoin only the explicit line-break form;
    // ordinary compound hyphens remain part of the token.
    .replace(/([\p{L}\p{M}])[-\u2010]\s*\r?\n\s*([\p{L}\p{M}])/gu, "$1$2");
  const matches = joined.match(/[\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+(?:['’][\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+)*(?:[./…-][\p{Script=Latin}\p{Script_Extensions=Latin}\p{M}0-9]+)*/gu) || [];
  return matches.map((token) => normalizeContextToken(token)).filter(Boolean);
}

function normalizeContextToken(token) {
  // Keep token identity aligned with the existing vocabulary key normalizer,
  // while stripping sentence punctuation around a token.
  const normalized = String(token).normalize("NFC").replace(/^[^\p{L}\p{M}0-9]+|[^\p{L}\p{M}0-9]+$/gu, "");
  return normalized ? normalized.toLowerCase().replace(/[\u2018\u2019\u02BC\uFF07]/gu, "'") : "";
}

function sentenceContainsFamilySurface(sentence, surface, family) {
  const sentenceTokens = tokenizeContextSurface(sentence);
  if (!sentenceTokens.length) return false;
  const candidates = new Set([surface, ...(family?.records || []).flatMap((record) => [record.surface, record.key])]
    .filter((value) => typeof value === "string")
    .map((value) => tokenizeContextSurface(value))
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => tokens.join("\u001f")));
  for (const candidate of candidates) {
    const tokens = candidate.split("\u001f");
    for (let start = 0; start + tokens.length <= sentenceTokens.length; start += 1) {
      if (tokens.every((token, offset) => token === sentenceTokens[start + offset])) return true;
    }
  }
  return false;
}

function requireCoreSnapshotIdentity(identity) {
  if (!identity || identity.exists !== true || typeof identity.storeId !== "string" || !identity.storeId ||
      typeof identity.path !== "string" || !identity.path.startsWith(`${VOCABULARY_DATA_ROOT}/`) ||
      !Number.isSafeInteger(identity.revision) || identity.revision < 1 ||
      typeof identity.hash !== "string" || !/^sha256-v1:[a-f0-9]{64}$/.test(identity.hash)) {
    throw codedError("VOCAB_CONTEXT_CORE_SNAPSHOT_MISSING", "The family must resolve from an existing, verified vocabulary snapshot before saving Context.");
  }
  return identity;
}

function validateContext(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) || record.schemaVersion !== 1 ||
      typeof record.contextId !== "string" || !/^context:v1:[a-f0-9]{64}$/.test(record.contextId) ||
      typeof record.familyKey !== "string" || !record.familyKey.startsWith("en-family:v1:") ||
      typeof record.surface !== "string" || !record.surface || record.surface !== record.surface.normalize("NFC").trim() ||
      typeof record.sentence !== "string" || !record.sentence.trim() || record.sentence !== record.sentence.normalize("NFC").trim() ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
      new Date(record.createdAt).toISOString() !== record.createdAt) {
    throw codedError("VOCAB_CONTEXT_RECORD_INVALID", "A stored Context record is malformed.");
  }
  let sourceIdentity;
  try { sourceIdentity = canonicalAnchorTuple(record.anchor); }
  catch (error) { throw codedError("VOCAB_CONTEXT_RECORD_INVALID", "A stored Context Anchor is malformed.", error); }
  const expectedIdentity = contextIdentity(record.familyKey, record.anchor);
  if (!record.identity || typeof record.identity !== "object" || Array.isArray(record.identity) ||
      canonicalStringify(record.identity) !== canonicalStringify(expectedIdentity) ||
      record.documentId !== record.anchor.documentId ||
      record.docKey !== record.anchor.docKey.toLowerCase() ||
      record.anchorId !== record.anchor.anchorId ||
      record.pageIdentity !== record.anchor.pageIdentity ||
      record.pageNumberHint !== record.anchor.pageIndexHint + 1 ||
      record.sourceFingerprint !== record.anchor.sourceHash ||
      canonicalStringify(record.identity.sourceIdentity) !== canonicalStringify(sourceIdentity) ||
      record.contextId !== contextIdFor(expectedIdentity)) {
    throw codedError("VOCAB_CONTEXT_IDENTITY_MISMATCH", "A stored Context does not match its complete stable identity tuple.");
  }
  return record;
}

function createVocabularyContextService({
  transaction,
  vocabularyService,
  verifySource,
  anchorStore,
  now = () => new Date(),
  maxRecords,
  maxBytes,
} = {}) {
  if (!transaction || typeof transaction.readSnapshot !== "function" || typeof transaction.commit !== "function") {
    throw new TypeError("Vocabulary Context requires a transaction coordinator.");
  }
  if (!vocabularyService || typeof vocabularyService.getFamilyByKey !== "function" ||
      typeof vocabularyService.getFamilyEvidence !== "function") {
    throw new TypeError("Vocabulary Context requires vocabulary family lookup and snapshot evidence APIs.");
  }
  let sourceVerifier = verifySource;
  if (typeof sourceVerifier !== "function" && anchorStore && typeof anchorStore.get === "function") {
    sourceVerifier = async ({ anchor }) => {
      const saved = await anchorStore.get(anchor.docKey, anchor.anchorId, anchor.documentId);
      return saved ? { status: "anchor-only", anchor: saved } : { status: "missing", code: "VOCAB_CONTEXT_SOURCE_MISSING" };
    };
  }
  if (typeof sourceVerifier !== "function") {
    throw new TypeError("Vocabulary Context requires an injected existing-source verifier.");
  }
  if (typeof now !== "function") throw new TypeError("Vocabulary Context requires a UTC clock.");

  const store = createShardedStore({
    transaction,
    storeId: CONTEXT_STORE_ID,
    root: CONTEXT_ROOT,
    kind: CONTEXT_KIND,
    idOf: (context) => context?.contextId,
    ...(maxRecords == null ? {} : { maxRecords }),
    ...(maxBytes == null ? {} : { maxBytes }),
  });

  async function getFamily(familyKey) {
    if (typeof familyKey !== "string" || !familyKey.startsWith("en-family:v1:")) {
      throw codedError("VOCAB_CONTEXT_FAMILY_INVALID", "A versioned vocabulary family key is required.");
    }
    let family;
    try { family = await vocabularyService.getFamilyByKey(familyKey, { includeRecords: false }); }
    catch (error) { throw codedError("VOCAB_CONTEXT_FAMILY_INVALID", "The Context family key is invalid.", error); }
    if (!family) throw codedError("VOCAB_CONTEXT_FAMILY_MISSING", "The vocabulary family no longer exists.");
    return family;
  }

  async function verifyAnchor(anchor, surface) {
    const supplied = canonicalAnchorTuple(anchor);
    let result;
    try { result = await sourceVerifier({ surface, anchor: clone(anchor), identity: clone(supplied) }); }
    catch (error) { throw codedError("VOCAB_CONTEXT_SOURCE_VERIFY_FAILED", "The source Anchor could not be verified.", error); }
    if (!result || result.status !== "verified" || result.sourceCurrent !== true || result.pageCurrent !== true) {
      const code = result?.code || (result?.status === "missing"
        ? "VOCAB_CONTEXT_SOURCE_MISSING"
        : result?.status === "expired"
          ? "VOCAB_CONTEXT_SOURCE_EXPIRED"
          : result?.status === "renamed"
            ? "VOCAB_CONTEXT_SOURCE_RENAMED"
            : "VOCAB_CONTEXT_SOURCE_UNVERIFIED");
      throw codedError(code, "The current source route and page evidence do not verify this Anchor.");
    }
    const actual = result.anchor;
    if (!actual) throw codedError("VOCAB_CONTEXT_SOURCE_INVALID", "The verified source did not return its Anchor.");
    let verified;
    try { verified = canonicalAnchorTuple(actual); }
    catch (error) { throw codedError("VOCAB_CONTEXT_SOURCE_INVALID", "The source Anchor is invalid.", error); }
    if (canonicalStringify(verified) !== canonicalStringify(supplied)) {
      throw codedError("VOCAB_CONTEXT_SOURCE_MISMATCH", "The source Anchor identity changed; the Context was not saved.");
    }
    return clone(actual);
  }

  async function validateSentence(input = {}) {
    const surface = typeof input.surface === "string" ? input.surface.normalize("NFC").trim() : "";
    const sentence = typeof input.sentence === "string" ? input.sentence.normalize("NFC").trim() : "";
    if (!surface || !sentence) throw codedError("VOCAB_CONTEXT_SENTENCE_INVALID", "A vocabulary surface and non-empty sentence are required.");
    const evidence = await vocabularyService.getFamilyEvidence(surface);
    const family = evidence?.family;
    if (!family || family.familyKey !== input.familyKey) {
      throw codedError("VOCAB_CONTEXT_SURFACE_FAMILY_MISMATCH", "The vocabulary surface does not belong to the selected family.");
    }
    if (!sentenceContainsFamilySurface(sentence, surface, family)) {
      throw codedError("VOCAB_CONTEXT_SURFACE_NOT_IN_SENTENCE", "The selected sentence does not contain the selected vocabulary surface or a saved family variant.");
    }
    return { surface, sentence, familyKey: family.familyKey };
  }

  async function validateFamilyReferences(records) {
    const pairs = new Map();
    for (const record of records) {
      const pairKey = `${record.familyKey}\u0000${record.surface}`;
      if (!pairs.has(pairKey)) pairs.set(pairKey, { familyKey: record.familyKey, surface: record.surface });
    }
    await Promise.all([...pairs.values()].map(async ({ familyKey, surface }) => {
      await getFamily(familyKey);
      let surfaceFamily;
      try { surfaceFamily = await vocabularyService.getFamily(surface); }
      catch (error) { throw codedError("VOCAB_CONTEXT_SURFACE_INVALID", "A stored Context surface could not be resolved.", error); }
      if (!surfaceFamily || surfaceFamily.familyKey !== familyKey) {
        throw codedError("VOCAB_CONTEXT_SURFACE_FAMILY_MISMATCH", "A stored Context surface no longer belongs to its family.");
      }
    }));
  }

  async function load() {
    const loaded = await store.load();
    for (const record of loaded.records) validateContext(record);
    await validateFamilyReferences(loaded.records);
    return loaded;
  }

  async function saveContext(input = {}) {
    if (typeof input.surface !== "string" || !input.surface.trim()) {
      throw codedError("VOCAB_CONTEXT_SURFACE_INVALID", "The vocabulary surface is required.");
    }
    const surface = input.surface.normalize("NFC").trim();
    let evidence;
    try { evidence = await vocabularyService.getFamilyEvidence(surface); }
    catch (error) { throw codedError("VOCAB_CONTEXT_SURFACE_INVALID", "The vocabulary surface could not be resolved.", error); }
    const surfaceFamily = evidence?.family;
    if (!surfaceFamily) throw codedError("VOCAB_CONTEXT_FAMILY_MISSING", "The vocabulary family no longer exists.");
    if (typeof input.familyKey !== "string" || surfaceFamily.familyKey !== input.familyKey) {
      throw codedError("VOCAB_CONTEXT_SURFACE_FAMILY_MISMATCH", "The vocabulary surface does not belong to the selected family.");
    }
    const family = surfaceFamily;
    const coreIdentity = requireCoreSnapshotIdentity(evidence?.identity);
    if (typeof input.sentence !== "string" || !input.sentence.trim()) {
      throw codedError("VOCAB_CONTEXT_SENTENCE_INVALID", "A non-empty sentence is required.");
    }
    const sentence = input.sentence.normalize("NFC").trim();
    if (!sentenceContainsFamilySurface(sentence, surface, family)) {
      throw codedError("VOCAB_CONTEXT_SURFACE_NOT_IN_SENTENCE", "The selected sentence does not contain the selected vocabulary surface or a saved family variant.");
    }
    if (!input.anchor || typeof input.anchor !== "object") {
      throw codedError("VOCAB_CONTEXT_ANCHOR_REQUIRED", "An existing verified Selection Anchor is required.");
    }
    const anchor = await verifyAnchor(input.anchor, surface);
    const identity = contextIdentity(family.familyKey, anchor);
    const contextId = contextIdFor(identity);
    const loaded = await load();
    const existing = loaded.records.find((context) => context.contextId === contextId);
    if (existing) {
      if (canonicalStringify(existing.identity) !== canonicalStringify(identity) ||
          snapshotIdentity(existing.anchor) !== canonicalStringify(identity.sourceIdentity)) {
        throw codedError("VOCAB_CONTEXT_ID_COLLISION", "A stable Context ID is already occupied by different source identity.");
      }
      return {
        status: "existing",
        context: clone(existing),
        sentenceMatches: existing.sentence === sentence,
        requiresUserEdit: existing.sentence !== sentence,
        writes: 0,
      };
    }
    const context = {
      schemaVersion: 1,
      contextId,
      familyKey: family.familyKey,
      surface,
      documentId: anchor.documentId,
      docKey: anchor.docKey.toLowerCase(),
      anchorId: anchor.anchorId,
      pageIdentity: anchor.pageIdentity,
      pageNumberHint: anchor.pageIndexHint + 1,
      sourceFingerprint: anchor.sourceHash,
      identity,
      sentence,
      anchor,
      createdAt: utcNow(now),
    };
    const plan = await prepareShardedReplacement({
      readSnapshot: (path) => transaction.readSnapshot(path),
      loaded,
      records: [...loaded.records, context],
      storeId: CONTEXT_STORE_ID,
      root: CONTEXT_ROOT,
      kind: CONTEXT_KIND,
      idOf: (record) => record?.contextId,
      ...(maxRecords == null ? {} : { maxRecords }),
      ...(maxBytes == null ? {} : { maxBytes }),
    });
    if (plan.noOp) return { status: "unchanged", context: clone(context), writes: 0 };
    const result = await transaction.commit({
      actionId: `context-save:${contextId}`,
      writes: plan.writes,
      deletes: plan.deletes,
      entities: [{ storeId: CONTEXT_STORE_ID, entityId: contextId }],
      preconditions: [{
        storeId: coreIdentity.storeId,
        path: coreIdentity.path,
        expectedRevision: coreIdentity.revision,
        expectedHash: coreIdentity.hash,
      }],
    });
    if (result?.status === "conflict") {
      return { ...result, contextId };
    }
    return { ...result, context: clone(context), writes: plan.writes.length };
  }

  async function getContext(contextId) {
    if (typeof contextId !== "string" || !contextId.startsWith("context:v1:")) {
      throw codedError("VOCAB_CONTEXT_ID_INVALID", "A valid Context ID is required.");
    }
    const loaded = await load();
    const context = loaded.records.find((record) => record.contextId === contextId);
    return context ? clone(context) : undefined;
  }

  async function listFamily(familyKey, options = {}) {
    await getFamily(familyKey);
    const limit = options.limit == null ? DEFAULT_PAGE_SIZE : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw codedError("VOCAB_CONTEXT_PAGE_SIZE_INVALID", `Context page size must be from 1 to ${MAX_PAGE_SIZE}.`);
    }
    const cursor = decodeCursor(options.cursor);
    const loaded = await load();
    const matching = loaded.records.filter((context) => context.familyKey === familyKey).sort(compareContextOrder);
    const afterCursor = cursor ? matching.filter((context) => isAfterCursor(context, cursor)) : matching;
    const page = afterCursor.slice(0, limit);
    return {
      contexts: page.map(clone),
      nextCursor: afterCursor.length > limit ? encodeCursor(page.at(-1)) : null,
      total: matching.length,
    };
  }

  async function verifyContextSource(contextId) {
    const context = await getContext(contextId);
    if (!context) return { status: "missing", valid: false, contextId };
    try {
      await getFamily(context.familyKey);
      const family = await vocabularyService.getFamily(context.surface);
      if (!family || family.familyKey !== context.familyKey) {
        return { status: "mismatch", valid: false, contextId, code: "VOCAB_CONTEXT_SURFACE_FAMILY_MISMATCH" };
      }
      if (context.documentId !== context.anchor.documentId || context.docKey !== context.anchor.docKey.toLowerCase() ||
          context.anchorId !== context.anchor.anchorId || context.pageIdentity !== context.anchor.pageIdentity ||
          context.pageNumberHint !== context.anchor.pageIndexHint + 1 || context.sourceFingerprint !== context.anchor.sourceHash) {
        return { status: "mismatch", valid: false, contextId, code: "VOCAB_CONTEXT_IDENTITY_MISMATCH" };
      }
      await verifyAnchor(context.anchor, context.surface);
      if (canonicalStringify(context.identity) !== canonicalStringify(contextIdentity(
        context.familyKey, context.anchor))) {
        return { status: "mismatch", valid: false, contextId };
      }
      return { status: "verified", valid: true, contextId };
    } catch (error) {
      return { status: "invalid", valid: false, contextId, code: error.code || "VOCAB_CONTEXT_SOURCE_INVALID" };
    }
  }

  return Object.freeze({
    root: CONTEXT_ROOT,
    storeId: CONTEXT_STORE_ID,
    load,
    saveContext,
    validateSentence,
    getContext,
    listFamily,
    verifySource: verifyContextSource,
  });
}

module.exports = {
  CONTEXT_STORE_ID,
  CONTEXT_ROOT,
  validateContext,
  createVocabularyContextService,
};
