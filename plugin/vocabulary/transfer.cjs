"use strict";

const { canonicalHash, canonicalStringify, hashText } = require("./canonical.cjs");
const {
  normalizeTermKey,
  validateVocabularySnapshotV2,
  serializeVocabularySnapshotV2,
  vocabularyFamilyKeyForKey,
} = require("./service.cjs");
const { validateContext, CONTEXT_ROOT, CONTEXT_STORE_ID } = require("./context-service.cjs");
const { REVIEW_ROOT, REVIEW_STORE_ID, REVIEW_KIND } = require("./review-service.cjs");
const { VOCABULARY_DATA_ROOT, createShardedStore, prepareShardedReplacement } = require("./sharded-store.cjs");

const BUNDLE_KIND = "pdf-reader-vocabulary-bundle";
const BUNDLE_SCHEMA_VERSION = 1;
const CORE_SCHEMA = "pdf-web-reader-vocabulary";
const CORE_SCHEMA_VERSION = 2;
const CONTEXT_KIND = "context";
const REVIEW_STATE_FIELDS = Object.freeze([
  "schemaVersion", "familyKey", "enrolled", "box", "dueAt", "enrolledAt", "lastReviewedAt",
  "reviewCount", "lapseCount", "updatedAt", "lastActionSessionId", "lastActionSequence", "lastActionId",
]);
const CORE_HISTORY_FIELDS = new Set(["status", "surface", "source", "updatedAt", "translation", "note", "phonetic"]);
const CONTEXT_HISTORY_IDENTITY_FIELDS = new Set(["schemaVersion", "contextId", "familyKey", "identity"]);
const REVIEW_HISTORY_FIELDS = new Set([
  "enrolled", "box", "dueAt", "enrolledAt", "lastReviewedAt", "reviewCount", "lapseCount", "updatedAt",
]);
const CONTEXT_FIELDS = new Set([
  "schemaVersion", "contextId", "familyKey", "surface", "documentId", "docKey", "anchorId",
  "pageIdentity", "pageNumberHint", "sourceFingerprint", "identity", "sentence", "anchor", "createdAt",
]);
const CONTEXT_IDENTITY_FIELDS = new Set(["familyKey", "documentId", "anchorId", "sourceIdentity"]);
const ANCHOR_FIELDS = new Set([
  "schemaVersion", "kind", "anchorId", "docKey", "documentId", "sourceHash", "pageIdentity",
  "pageIndexHint", "textPosition", "exactQuote", "prefix", "suffix", "orderedPageIdentityDigest",
  "pageCount", "geometry", "integrity",
]);
const ANCHOR_TUPLE_FIELDS = new Set([
  "anchorId", "docKey", "documentId", "sourceHash", "pageIdentity", "pageIndexHint", "textPosition",
  "exactQuote", "prefix", "suffix", "orderedPageIdentityDigest", "pageCount", "geometry",
]);
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_SHARDED_RECORDS = 100_000;
const HASH = /^sha256-v1:[a-f0-9]{64}$/;
const TAGGED_HASH = /^(?:xxh64-v1:[a-f0-9]{16}|sha256-v1:[a-f0-9]{64})$/i;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function codedError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "VocabularyTransferError";
  error.code = code;
  return error;
}

function exactKeys(value, fields, code, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError(code, `${description} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) throw codedError(code, `${description} contains an unknown field: ${key}.`);
  }
}

function isUtc(value) {
  return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function utf8Length(text) {
  if (typeof TextEncoder !== "function") throw codedError("VOCAB_BUNDLE_ENCODER_UNAVAILABLE", "TextEncoder is required for vocabulary bundle validation.");
  return new TextEncoder().encode(text).byteLength;
}

function snapshotIdentity(snapshot) {
  return { exists: snapshot.exists === true, revision: snapshot.exists ? snapshot.revision : 0, hash: snapshot.exists ? snapshot.hash : null };
}

function identityMatches(left, right) {
  return left.exists === right.exists && left.revision === right.revision && left.hash === right.hash;
}

function identityMapObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function addIdentity(identities, path, storeId, snapshot) {
  const prior = identities.get(path);
  const next = { storeId, ...snapshotIdentity(snapshot) };
  if (prior && (prior.storeId !== next.storeId || !identityMatches(prior, next))) {
    throw codedError("VOCAB_BUNDLE_STORE_CHANGED", `A vocabulary store changed while it was being read: ${path}.`);
  }
  identities.set(path, next);
}

function identityPrecondition(path, identity) {
  return {
    storeId: identity.storeId,
    path,
    expectedRevision: identity.revision,
    expectedHash: identity.hash,
  };
}

function validateReviewRecord(record) {
  exactKeys(record, new Set(REVIEW_STATE_FIELDS), "VOCAB_BUNDLE_REVIEW_SCHEMA", "Review record");
  const familyKey = record.familyKey;
  if (record.schemaVersion !== 1 || typeof familyKey !== "string" || !familyKey.startsWith("en-family:v1:") ||
      familyKey.length > 4096 || typeof record.enrolled !== "boolean" || !Number.isInteger(record.box) ||
      record.box < 1 || record.box > 5 || !Number.isSafeInteger(record.reviewCount) || record.reviewCount < 0 ||
      !Number.isSafeInteger(record.lapseCount) || record.lapseCount < 0 ||
      typeof record.lastActionSessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.lastActionSessionId) ||
      !Number.isSafeInteger(record.lastActionSequence) || record.lastActionSequence < 1 ||
      typeof record.lastActionId !== "string" || !record.lastActionId || record.lastActionId.length > 256 ||
      /[\\/\u0000-\u001f\u007f]/.test(record.lastActionId) ||
      !isUtc(record.dueAt) || !isUtc(record.updatedAt) ||
      (record.enrolledAt !== null && !isUtc(record.enrolledAt)) ||
      (record.lastReviewedAt !== null && !isUtc(record.lastReviewedAt))) {
    throw codedError("VOCAB_BUNDLE_REVIEW_INVALID", `Review record ${String(familyKey)} is malformed.`);
  }
  return record;
}

function validateContextRecord(record) {
  exactKeys(record, CONTEXT_FIELDS, "VOCAB_BUNDLE_CONTEXT_SCHEMA", "Context record");
  exactKeys(record.identity, CONTEXT_IDENTITY_FIELDS, "VOCAB_BUNDLE_CONTEXT_SCHEMA", "Context identity");
  exactKeys(record.anchor, ANCHOR_FIELDS, "VOCAB_BUNDLE_CONTEXT_SCHEMA", "Context anchor");
  exactKeys(record.anchor.textPosition, new Set(["start", "end"]), "VOCAB_BUNDLE_CONTEXT_SCHEMA", "Anchor text position");
  if (record.anchor.geometry !== undefined && record.anchor.geometry !== null) {
    exactKeys(record.anchor.geometry, new Set(["x", "y", "width", "height"]), "VOCAB_BUNDLE_CONTEXT_SCHEMA", "Anchor geometry");
  }
  exactKeys(record.identity.sourceIdentity, ANCHOR_TUPLE_FIELDS, "VOCAB_BUNDLE_CONTEXT_SCHEMA", "Context source identity");
  if (record.identity.sourceIdentity.geometry !== undefined && record.identity.sourceIdentity.geometry !== null) {
    exactKeys(record.identity.sourceIdentity.geometry, new Set(["x", "y", "width", "height"]), "VOCAB_BUNDLE_CONTEXT_SCHEMA", "Context identity geometry");
  }
  if (record.anchor.integrity !== undefined && (typeof record.anchor.integrity !== "string" || !TAGGED_HASH.test(record.anchor.integrity))) {
    throw codedError("VOCAB_BUNDLE_CONTEXT_INVALID", "Context anchor integrity metadata is malformed.");
  }
  try { validateContext(record); }
  catch (error) { throw codedError("VOCAB_BUNDLE_CONTEXT_INVALID", "A Context record or its saved Selection Anchor is invalid.", error); }
  return record;
}

function validateReferences(core, contexts, review) {
  const familyKeys = new Set(core.records.map((record) => record.familyKey));
  for (const record of contexts) {
    const surfaceKey = normalizeTermKey(record.surface);
    const surfaceFamilyKey = surfaceKey ? vocabularyFamilyKeyForKey(surfaceKey) : null;
    if (!familyKeys.has(record.familyKey) || surfaceFamilyKey !== record.familyKey) {
      throw codedError("VOCAB_BUNDLE_CONTEXT_FAMILY_MISSING", `Context ${record.contextId} does not reference a family in the bundle core snapshot.`);
    }
  }
  for (const record of review) {
    if (!familyKeys.has(record.familyKey)) {
      throw codedError("VOCAB_BUNDLE_REVIEW_FAMILY_MISSING", `Review state ${record.familyKey} does not reference a family in the bundle core snapshot.`);
    }
  }
}

function domainStoreHash(revision, records) {
  return canonicalHash({ schemaVersion: 1, revision, records });
}

function parseBundle(input) {
  let parsed = input;
  if (typeof input === "string") {
    if (utf8Length(input) > MAX_BUNDLE_BYTES) throw codedError("VOCAB_BUNDLE_SIZE_LIMIT", "Vocabulary bundle exceeds the supported size.");
    try { parsed = JSON.parse(input); }
    catch (error) { throw codedError("VOCAB_BUNDLE_INVALID_JSON", "Vocabulary bundle is not valid JSON.", error); }
  }
  let serialized;
  try { serialized = canonicalStringify(parsed); }
  catch (error) { throw codedError("VOCAB_BUNDLE_INVALID_VALUE", "Vocabulary bundle contains unsupported data.", error); }
  if (utf8Length(serialized) > MAX_BUNDLE_BYTES) throw codedError("VOCAB_BUNDLE_SIZE_LIMIT", "Vocabulary bundle exceeds the supported size.");
  // Imports accept object payloads from the host as well as serialized files.
  // Snapshot the fully canonical value before the first await so a caller
  // cannot mutate Context/Review records after integrity validation.
  parsed = JSON.parse(serialized);

  exactKeys(parsed, new Set(["kind", "schemaVersion", "exportedAt", "stores", "integrity"]),
    "VOCAB_BUNDLE_SCHEMA_UNKNOWN", "Vocabulary bundle");
  if (parsed.kind !== BUNDLE_KIND || parsed.schemaVersion !== BUNDLE_SCHEMA_VERSION || !isUtc(parsed.exportedAt)) {
    throw codedError("VOCAB_BUNDLE_SCHEMA_UNKNOWN", "Vocabulary bundle kind, version, or export timestamp is unsupported.");
  }
  exactKeys(parsed.stores, new Set(["core", "contexts", "review"]), "VOCAB_BUNDLE_SCHEMA_UNKNOWN", "Bundle stores");
  exactKeys(parsed.integrity, new Set(["algorithm", "hash"]), "VOCAB_BUNDLE_SCHEMA_UNKNOWN", "Bundle integrity");
  if (parsed.integrity.algorithm !== "sha256-v1" || !HASH.test(parsed.integrity.hash || "")) {
    throw codedError("VOCAB_BUNDLE_INTEGRITY_INVALID", "Vocabulary bundle integrity metadata is invalid.");
  }

  let core;
  try { core = validateVocabularySnapshotV2(parsed.stores.core); }
  catch (error) { throw codedError("VOCAB_BUNDLE_CORE_INVALID", "Bundle core snapshot is not a valid closed schema-v2 snapshot.", error); }
  const contextStore = parsed.stores.contexts;
  const reviewStore = parsed.stores.review;
  for (const [name, store] of [["Context", contextStore], ["Review", reviewStore]]) {
    exactKeys(store, new Set(["schemaVersion", "revision", "records", "contentHash"]),
      "VOCAB_BUNDLE_SCHEMA_UNKNOWN", `${name} store`);
    if (store.schemaVersion !== 1 || !Number.isSafeInteger(store.revision) || store.revision < 0 ||
        !Array.isArray(store.records) || store.records.length > MAX_SHARDED_RECORDS || !HASH.test(store.contentHash || "")) {
      throw codedError("VOCAB_BUNDLE_STORE_INVALID", `${name} bundle store metadata is invalid.`);
    }
    if (store.records.length > 0 && store.revision < 1) {
      throw codedError("VOCAB_BUNDLE_STORE_INVALID", `${name} records require a persisted store revision.`);
    }
    const ids = new Set();
    for (const record of store.records) {
      if (name === "Context") validateContextRecord(record);
      else validateReviewRecord(record);
      const id = name === "Context" ? record.contextId : record.familyKey;
      if (ids.has(id)) throw codedError("VOCAB_BUNDLE_STORE_DUPLICATE_ID", `${name} store repeats ${id}.`);
      ids.add(id);
    }
    const ordered = store.records.map((record) => name === "Context" ? record.contextId : record.familyKey);
    if (ordered.some((id, index) => index > 0 && ordered[index - 1] >= id)) {
      throw codedError("VOCAB_BUNDLE_STORE_ORDER_INVALID", `${name} records must be sorted by stable ID.`);
    }
    if (store.contentHash !== domainStoreHash(store.revision, store.records)) {
      throw codedError("VOCAB_BUNDLE_CONTENT_HASH_MISMATCH", `${name} store content hash does not match its records.`);
    }
  }
  if (core.revision === 0 && core.records.length) {
    throw codedError("VOCAB_BUNDLE_CORE_INVALID", "A non-empty core snapshot requires a persisted revision.");
  }
  validateReferences(core, contextStore.records, reviewStore.records);

  const payload = {
    kind: parsed.kind,
    schemaVersion: parsed.schemaVersion,
    exportedAt: parsed.exportedAt,
    stores: parsed.stores,
  };
  if (parsed.integrity.hash !== canonicalHash(payload)) {
    throw codedError("VOCAB_BUNDLE_INTEGRITY_MISMATCH", "Vocabulary bundle integrity hash does not match its contents.");
  }
  return { ...payload, integrity: parsed.integrity, core, contexts: contextStore, review: reviewStore };
}

function payloadForIntegrity(bundle) {
  return {
    kind: bundle.kind,
    schemaVersion: bundle.schemaVersion,
    exportedAt: bundle.exportedAt,
    stores: bundle.stores,
  };
}

function coreRecordsEqual(left, right) {
  const a = [...left].sort((x, y) => x.key.localeCompare(y.key));
  const b = [...right].sort((x, y) => x.key.localeCompare(y.key));
  return canonicalStringify(a) === canonicalStringify(b);
}

function mergeIdRecords(current, incoming, idOf, { overwriteExisting = false, preserveFields = null } = {}) {
  const next = new Map(current.map((record) => [idOf(record), JSON.parse(canonicalStringify(record))]));
  const counts = { imported: 0, updated: 0, skippedExisting: 0 };
  let changed = false;
  for (const record of incoming) {
    const id = idOf(record);
    const prior = next.get(id);
    if (!prior) {
      next.set(id, JSON.parse(canonicalStringify(record)));
      counts.imported += 1;
      changed = true;
    } else if (!overwriteExisting || canonicalStringify(prior) === canonicalStringify(record)) {
      counts.skippedExisting += 1;
    } else {
      const replacement = JSON.parse(canonicalStringify(record));
      for (const field of preserveFields || []) {
        if (Object.hasOwn(prior, field)) replacement[field] = JSON.parse(canonicalStringify(prior[field]));
        else delete replacement[field];
      }
      if (canonicalStringify(prior) === canonicalStringify(replacement)) {
        counts.skippedExisting += 1;
      } else {
        next.set(id, replacement);
        counts.updated += 1;
        changed = true;
      }
    }
  }
  return { records: [...next.values()], counts, changed };
}

function mergeCoreRecords(current, incoming, policy) {
  const next = new Map(current.map((record) => [record.key, JSON.parse(canonicalStringify(record))]));
  const counts = { imported: 0, updated: 0, skippedExisting: 0, skippedKnown: 0 };
  let changed = false;
  const groups = new Map();
  const existingByFamily = new Map();
  for (const record of current) {
    const family = existingByFamily.get(record.familyKey) || [];
    family.push(record);
    existingByFamily.set(record.familyKey, family);
  }
  for (const record of incoming) {
    const group = groups.get(record.familyKey) || [];
    group.push(record);
    groups.set(record.familyKey, group);
  }

  for (const [familyKey, records] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const existingFamily = existingByFamily.get(familyKey) || [];
    const existingStatus = existingFamily.length ? Math.max(...existingFamily.map((record) => record.status)) : null;
    const destinationKnown = existingStatus === 5;
    if (destinationKnown && !policy.overwriteKnown) {
      counts.skippedKnown += records.length;
      continue;
    }
    const mayReplace = policy.overwriteExisting || (destinationKnown && policy.overwriteKnown);
    const importStatus = records.reduce((value, record) => Math.max(value, record.status), 0);
    const targetStatus = existingStatus === null || mayReplace ? importStatus : existingStatus;

    if (mayReplace && existingStatus !== null && existingStatus !== targetStatus) {
      for (const record of existingFamily) {
        if (record.familyKey !== familyKey || record.status === targetStatus) continue;
        next.set(record.key, { ...record, status: targetStatus });
        counts.updated += 1;
        changed = true;
      }
    }
    for (const incomingRecord of records) {
      const record = { ...incomingRecord, status: targetStatus };
      const prior = next.get(record.key);
      if (!prior) {
        next.set(record.key, record);
        counts.imported += 1;
        changed = true;
      } else if (!mayReplace || canonicalStringify(prior) === canonicalStringify(record)) {
        counts.skippedExisting += 1;
      } else {
        if (prior.type !== record.type || prior.familyKey !== record.familyKey) {
          throw codedError("VOCAB_BUNDLE_CORE_IDENTITY_CHANGE", `Import cannot replace the identity of vocabulary record ${record.key}.`);
        }
        // Match ordinary JSON import semantics: createdAt is local entity
        // identity, while source/updateable fields may be explicitly replaced.
        next.set(record.key, { ...record, createdAt: prior.createdAt });
        counts.updated += 1;
        changed = true;
      }
    }
  }
  return { records: [...next.values()], counts, changed };
}

function absentIdentity(storeId) {
  return { storeId, exists: false, revision: 0, hash: null };
}

function makeId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return `bundle-${globalThis.crypto.randomUUID()}`;
  return `bundle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function recordHistoryDiff({ before, after, storeId, pathForRecord, allowedUpdateFields = null, createFields = null, compactEntityCreates = false }) {
  const beforeById = before instanceof Map ? before : new Map(before.map((record) => [record.id, record]));
  const afterById = after instanceof Map ? after : new Map(after.map((record) => [record.id, record]));
  const entities = [];
  const changes = [];
  for (const entityId of [...afterById.keys()].sort((left, right) => left.localeCompare(right))) {
    const afterRecord = afterById.get(entityId);
    const beforeRecord = beforeById.get(entityId);
    const path = pathForRecord(entityId);
    if (typeof path !== "string" || !path) {
      throw codedError("VOCAB_BUNDLE_HISTORY_PATH_MISSING", `No canonical result shard was found for imported record ${entityId}.`);
    }
    if (!beforeRecord) {
      entities.push({ storeId, entityId, kind: "entityCreate" });
      if (compactEntityCreates) {
        changes.push({ storeId, path, entityId, fieldPath: ["records", entityId],
          beforeExists: false, afterExists: true, after: { ...afterRecord }, kind: "entityCreate" });
        continue;
      }
      const fields = createFields ? [...createFields].filter((field) => Object.hasOwn(afterRecord, field)) : Object.keys(afterRecord);
      for (const field of fields.sort((left, right) => left.localeCompare(right))) {
        changes.push({ storeId, path, entityId, field, fieldPath: ["records", entityId, field],
          beforeExists: false, afterExists: true, after: afterRecord[field], kind: "entityCreate" });
      }
      continue;
    }
    let entityChanged = false;
    for (const field of [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort((left, right) => left.localeCompare(right))) {
      const beforeExists = Object.hasOwn(beforeRecord, field);
      const afterExists = Object.hasOwn(afterRecord, field);
      if (beforeExists === afterExists && (!beforeExists || canonicalStringify(beforeRecord[field]) === canonicalStringify(afterRecord[field]))) continue;
      if (allowedUpdateFields && !allowedUpdateFields.has(field)) {
        throw codedError("VOCAB_BUNDLE_HISTORY_FIELD_UNSUPPORTED", `Import cannot reversibly change protected ${storeId} field ${field}.`);
      }
      changes.push({ storeId, path, entityId, field, fieldPath: ["records", entityId, field],
        beforeExists, afterExists,
        ...(beforeExists ? { before: beforeRecord[field] } : {}),
        ...(afterExists ? { after: afterRecord[field] } : {}),
        kind: "field" });
      entityChanged = true;
    }
    if (entityChanged) entities.push({ storeId, entityId, kind: "record" });
  }
  return { entities, changes };
}

function historyStoresForWrites(writes) {
  return writes.map((write) => {
    let value;
    try { value = JSON.parse(write.text); }
    catch (error) { throw codedError("VOCAB_BUNDLE_HISTORY_WRITE_INVALID", `Import produced invalid canonical data at ${write.path}.`, error); }
    if (canonicalStringify(value) !== write.text || !Number.isSafeInteger(value.revision) ||
        value.revision !== write.expectedRevision + 1 ||
        (write.expectedHash !== null && !HASH.test(write.expectedHash || ""))) {
      throw codedError("VOCAB_BUNDLE_HISTORY_WRITE_INVALID", `Import produced an unverified revision at ${write.path}.`);
    }
    return {
      storeId: write.storeId,
      path: write.path,
      baseRevision: write.expectedRevision,
      resultRevision: value.revision,
      baseHash: write.expectedHash,
      resultHash: hashText(write.text),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function shardedRecordPath(plan, id) {
  const digest = hashText(id).slice("sha256-v1:".length);
  const entry = plan.manifest?.shards?.find((shard) => digest.startsWith(shard.prefix));
  return entry?.path || null;
}

function createVocabularyTransfer({ runtime } = {}) {
  if (!runtime?.coordinator?.readSnapshot || !runtime?.personalService?.exportJson ||
      !runtime?.contexts?.load || !runtime?.review?.getStatus) {
    throw new TypeError("Vocabulary transfer requires an initialized Vocabulary runtime.");
  }
  const coordinator = runtime.coordinator;
  const personalService = runtime.personalService;
  const adapter = coordinator.adapter;
  const contextStore = createShardedStore({
    transaction: coordinator, storeId: CONTEXT_STORE_ID, root: CONTEXT_ROOT,
    kind: CONTEXT_KIND, idOf: (record) => record?.contextId,
  });
  const reviewStore = createShardedStore({
    transaction: coordinator, storeId: REVIEW_STORE_ID, root: REVIEW_ROOT,
    kind: REVIEW_KIND, idOf: (record) => record?.familyKey,
  });

  async function scanShardIdentities(loaded, storeId, root) {
    const identities = new Map();
    const manifestPath = `${root}/manifest.json`;
    const diskManifest = await coordinator.readSnapshot(manifestPath);
    if (!identityMatches(snapshotIdentity(diskManifest), snapshotIdentity(loaded.manifestSnapshot))) {
      throw codedError("VOCAB_BUNDLE_STORE_CHANGED", `A sharded store manifest changed while it was being read: ${manifestPath}.`);
    }
    addIdentity(identities, manifestPath, storeId, diskManifest);
    if (typeof adapter.list !== "function") throw codedError("VOCAB_BUNDLE_LIST_UNAVAILABLE", "The DataAdapter must support list() for complete workspace transfer.");
    if (await adapter.exists(root)) {
      const listing = await adapter.list(root);
      if (!Array.isArray(listing?.files)) throw codedError("VOCAB_BUNDLE_LIST_INVALID", `The DataAdapter returned an invalid shard listing for ${root}.`);
      const prefix = `${root}/`;
      for (const path of listing.files) {
        if (typeof path !== "string" || !path.startsWith(prefix)) continue;
        const leaf = path.slice(prefix.length);
        if (!/^[a-f0-9]{1,64}\.json$/.test(leaf)) continue;
        const snapshot = await coordinator.readSnapshot(path);
        addIdentity(identities, path, storeId, snapshot);
      }
    }
    for (const entry of loaded.manifest?.shards || []) {
      const read = await coordinator.readSnapshot(entry.path);
      const loadedSnapshot = loaded.shardSnapshots.get(entry.prefix);
      if (!loadedSnapshot || !identityMatches(snapshotIdentity(read), snapshotIdentity(loadedSnapshot))) {
        throw codedError("VOCAB_BUNDLE_STORE_CHANGED", `An active shard changed while it was being read: ${entry.path}.`);
      }
      addIdentity(identities, entry.path, storeId, read);
    }
    return identities;
  }

  async function captureOnce() {
    const coreText = await personalService.exportJson();
    const core = validateVocabularySnapshotV2(coreText);
    const coreIdentity = await personalService.getSnapshotIdentity();
    if (!coreIdentity || coreIdentity.storeId !== "vocabulary-core" || typeof coreIdentity.path !== "string" ||
        !coreIdentity.path.startsWith(`${VOCABULARY_DATA_ROOT}/`) ||
        coreIdentity.exists !== (coreIdentity.hash !== null) || !Number.isSafeInteger(coreIdentity.revision) || coreIdentity.revision < 0 ||
        (coreIdentity.exists ? !HASH.test(coreIdentity.hash) : (coreIdentity.revision !== 0 || coreIdentity.hash !== null)) ||
        core.revision !== coreIdentity.revision) {
      throw codedError("VOCAB_BUNDLE_CORE_IDENTITY_INVALID", "The loaded vocabulary snapshot does not have a verified canonical identity.");
    }
    const coreDisk = await coordinator.readSnapshot(coreIdentity.path);
    if (!identityMatches(snapshotIdentity(coreDisk), {
      exists: coreIdentity.exists, revision: coreIdentity.revision, hash: coreIdentity.hash,
    })) {
      throw codedError("VOCAB_BUNDLE_STORE_CHANGED", "Vocabulary core changed outside the loaded service while exporting.");
    }
    const coreIdentities = new Map([[coreIdentity.path, { storeId: coreIdentity.storeId, ...snapshotIdentity(coreDisk) }]]);

    const contexts = await runtime.contexts.load();
    const review = await reviewStore.load();
    if (contexts.records.length > MAX_SHARDED_RECORDS || review.records.length > MAX_SHARDED_RECORDS) {
      throw codedError("VOCAB_BUNDLE_RECORD_LIMIT", "A sharded vocabulary store exceeds the bundle record limit.");
    }
    for (const record of contexts.records) validateContextRecord(record);
    for (const record of review.records) validateReviewRecord(record);
    validateReferences(core, contexts.records, review.records);
    for (const record of review.records) {
      const family = await personalService.getFamilyByKey(record.familyKey, { includeRecords: false });
      if (!family) throw codedError("VOCAB_BUNDLE_REVIEW_FAMILY_MISSING", `Review state ${record.familyKey} references a missing vocabulary family.`);
    }

    const contextIdentities = await scanShardIdentities(contexts, CONTEXT_STORE_ID, CONTEXT_ROOT);
    const reviewIdentities = await scanShardIdentities(review, REVIEW_STORE_ID, REVIEW_ROOT);
    const identities = new Map([...coreIdentities, ...contextIdentities, ...reviewIdentities]);
    const contextRevision = contexts.manifestSnapshot.exists ? contexts.manifestSnapshot.revision : 0;
    const reviewRevision = review.manifestSnapshot.exists ? review.manifestSnapshot.revision : 0;
    const contextRecords = contexts.records.map((record) => JSON.parse(canonicalStringify(record)))
      .sort((left, right) => left.contextId.localeCompare(right.contextId));
    const reviewRecords = review.records.map((record) => JSON.parse(canonicalStringify(record)))
      .sort((left, right) => left.familyKey.localeCompare(right.familyKey));
    const bundleCore = JSON.parse(serializeVocabularySnapshotV2(core));
    return {
      core: bundleCore,
      contexts: { schemaVersion: 1, revision: contextRevision, records: contextRecords,
        contentHash: domainStoreHash(contextRevision, contextRecords) },
      review: { schemaVersion: 1, revision: reviewRevision, records: reviewRecords,
        contentHash: domainStoreHash(reviewRevision, reviewRecords) },
      coreIdentityPath: coreIdentity.path,
      contextLoaded: contexts,
      reviewLoaded: review,
      identities,
    };
  }

  function captureContentHash(capture) {
    return canonicalHash({ core: capture.core, contexts: capture.contexts, review: capture.review });
  }

  async function captureStable() {
    await runtime.ready?.();
    const first = await captureOnce();
    const second = await captureOnce();
    if (canonicalStringify(identityMapObject(first.identities)) !== canonicalStringify(identityMapObject(second.identities)) ||
        captureContentHash(first) !== captureContentHash(second)) {
      throw codedError("VOCAB_BUNDLE_STORE_CHANGED", "A vocabulary store changed between the transfer read barriers; no complete bundle was produced.");
    }
    return second;
  }

  async function exportBundle() {
    const status = runtime.review.getStatus();
    if (status?.lastError) throw codedError("VOCAB_BUNDLE_REVIEW_FLUSH_FAILED", "Review has an unacknowledged flush error; no complete bundle was produced.");
    if (status && !status.closed && status.actionCount > status.flushedThroughSequence) {
      throw codedError("VOCAB_BUNDLE_REVIEW_UNFLUSHED", "Review has acknowledged journal actions that are not yet present in canonical state; flush the session before exporting.");
    }
    const snapshot = await captureStable();
    const bundle = {
      kind: BUNDLE_KIND,
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      stores: {
        core: snapshot.core,
        contexts: snapshot.contexts,
        review: snapshot.review,
      },
    };
    bundle.integrity = { algorithm: "sha256-v1", hash: canonicalHash(payloadForIntegrity(bundle)) };
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    if (utf8Length(text) > MAX_BUNDLE_BYTES) throw codedError("VOCAB_BUNDLE_SIZE_LIMIT", "Vocabulary bundle exceeds the supported size.");
    return text;
  }

  function parsePolicy(policy = {}) {
    if (policy == null) policy = {};
    exactKeys(policy, new Set(["defaultStatus", "overwriteExisting", "overwriteKnown"]),
      "VOCAB_BUNDLE_POLICY_INVALID", "Vocabulary bundle import policy");
    if (policy.defaultStatus != null) {
      const defaultStatus = Number(policy.defaultStatus);
      if (!Number.isInteger(defaultStatus) || defaultStatus < 1 || defaultStatus > 5) {
        throw codedError("VOCAB_BUNDLE_POLICY_INVALID", "defaultStatus must be an integer from 1 to 5.");
      }
    }
    for (const key of ["overwriteExisting", "overwriteKnown"]) {
      if (policy[key] !== undefined && typeof policy[key] !== "boolean") {
        throw codedError("VOCAB_BUNDLE_POLICY_INVALID", `${key} must be a boolean.`);
      }
    }
    // Bundle snapshots carry an explicit validated status on every record.
    // defaultStatus is accepted for API compatibility with ordinary JSON/CSV
    // imports, but never substitutes for a missing bundle field.
    return { overwriteExisting: policy.overwriteExisting === true, overwriteKnown: policy.overwriteKnown === true };
  }

  async function preconditionsForCapture(capture, mutatedPaths) {
    const preconditions = [];
    for (const [path, identity] of capture.identities) {
      if (mutatedPaths.has(path)) continue;
      preconditions.push(identityPrecondition(path, identity));
    }
    return preconditions.sort((left, right) => left.path.localeCompare(right.path));
  }

  function assertPlanBase(write, capture) {
    const actual = capture.identities.get(write.path) || absentIdentity(write.storeId);
    if (actual.storeId !== write.storeId || actual.revision !== write.expectedRevision || actual.hash !== write.expectedHash) {
      throw codedError("VOCAB_BUNDLE_STORE_CHANGED", `A vocabulary store changed while the import plan was being built: ${write.path}.`);
    }
  }

  async function makeImportPlan(input, policyInput = {}) {
    const bundle = parseBundle(input);
    const policy = parsePolicy(policyInput);
    const target = await captureStable();
    const status = runtime.review.getStatus();
    if (status && !status.closed) {
      throw codedError("VOCAB_BUNDLE_REVIEW_SESSION_ACTIVE", "Close the active Review session before importing a vocabulary bundle.");
    }

    const coreMerge = mergeCoreRecords(target.core.records, bundle.core.records, policy);
    const coreValidated = validateVocabularySnapshotV2({
      schema: CORE_SCHEMA, schemaVersion: CORE_SCHEMA_VERSION, language: "en",
      revision: Math.max(1, target.core.revision + 1), records: coreMerge.records,
    });
    const candidateFamilies = new Set(coreValidated.records.map((record) => record.familyKey));
    for (const record of target.contexts.records) {
      if (!candidateFamilies.has(record.familyKey)) throw codedError("VOCAB_BUNDLE_CONTEXT_FAMILY_MISSING", `Existing Context ${record.contextId} would be left without its vocabulary family.`);
    }
    for (const record of target.review.records) {
      if (!candidateFamilies.has(record.familyKey)) throw codedError("VOCAB_BUNDLE_REVIEW_FAMILY_MISSING", `Existing Review state ${record.familyKey} would be left without its vocabulary family.`);
    }

    const contextMerge = mergeIdRecords(target.contexts.records, bundle.contexts.records,
      (record) => record.contextId, policy);
    const reviewMerge = mergeIdRecords(target.review.records, bundle.review.records,
      (record) => record.familyKey, { ...policy,
        preserveFields: ["schemaVersion", "familyKey", "lastActionSessionId", "lastActionSequence", "lastActionId"] });
    validateReferences(coreValidated, contextMerge.records, reviewMerge.records);

    const writes = [];
    let coreText = null;
    const coreChanged = !coreRecordsEqual(target.core.records, coreMerge.records);
    if (coreChanged) {
      coreValidated.revision = target.core.revision + 1;
      coreText = serializeVocabularySnapshotV2(coreValidated);
      const identity = target.identities.get(target.coreIdentityPath);
      if (!identity) throw codedError("VOCAB_BUNDLE_CORE_IDENTITY_INVALID", "The core snapshot identity was not captured.");
      writes.push({ path: target.coreIdentityPath, storeId: "vocabulary-core",
        expectedRevision: identity.revision, expectedHash: identity.hash, text: coreText });
    }

    const contextPlan = await prepareShardedReplacement({
      readSnapshot: (path) => coordinator.readSnapshot(path),
      loaded: target.contextLoaded,
      records: contextMerge.records,
      storeId: CONTEXT_STORE_ID,
      root: CONTEXT_ROOT,
      kind: CONTEXT_KIND,
      idOf: (record) => record?.contextId,
    });
    const reviewPlan = await prepareShardedReplacement({
      readSnapshot: (path) => coordinator.readSnapshot(path),
      loaded: target.reviewLoaded,
      records: reviewMerge.records,
      storeId: REVIEW_STORE_ID,
      root: REVIEW_ROOT,
      kind: REVIEW_KIND,
      idOf: (record) => record?.familyKey,
    });
    for (const write of [...contextPlan.writes, ...reviewPlan.writes]) assertPlanBase(write, target);
    writes.push(...contextPlan.writes, ...reviewPlan.writes);
    for (const write of writes) assertPlanBase(write, target);

    const history = {
      stores: historyStoresForWrites(writes),
      entities: [],
      changes: [],
    };
    const coreHistory = recordHistoryDiff({
      before: new Map(target.core.records.map((record) => [record.key, record])),
      after: new Map(coreMerge.records.map((record) => [record.key, record])),
      storeId: "vocabulary-core",
      pathForRecord: () => target.coreIdentityPath,
      allowedUpdateFields: CORE_HISTORY_FIELDS,
      compactEntityCreates: true,
    });
    const contextHistory = recordHistoryDiff({
      before: new Map(target.contexts.records.map((record) => [record.contextId, record])),
      after: new Map(contextMerge.records.map((record) => [record.contextId, record])),
      storeId: CONTEXT_STORE_ID,
      pathForRecord: (id) => shardedRecordPath(contextPlan, id),
      allowedUpdateFields: new Set([...CONTEXT_FIELDS].filter((field) => !CONTEXT_HISTORY_IDENTITY_FIELDS.has(field))),
    });
    const reviewHistory = recordHistoryDiff({
      before: new Map(target.review.records.map((record) => [record.familyKey, record])),
      after: new Map(reviewMerge.records.map((record) => [record.familyKey, record])),
      storeId: REVIEW_STORE_ID,
      pathForRecord: (id) => shardedRecordPath(reviewPlan, id),
      allowedUpdateFields: REVIEW_HISTORY_FIELDS,
      createFields: REVIEW_HISTORY_FIELDS,
    });
    for (const diff of [coreHistory, contextHistory, reviewHistory]) {
      // A 25k import has hundreds of thousands of field changes. Iteration
      // keeps those data entries out of the engine's function-argument stack.
      for (const entity of diff.entities) history.entities.push(entity);
      for (const change of diff.changes) history.changes.push(change);
    }
    history.entities.sort((left, right) => left.storeId.localeCompare(right.storeId) || left.entityId.localeCompare(right.entityId));
    history.changes.sort((left, right) => left.storeId.localeCompare(right.storeId) || left.path.localeCompare(right.path) ||
      left.entityId.localeCompare(right.entityId) || left.field.localeCompare(right.field));
    if (writes.length > 0 && history.changes.length === 0) {
      throw codedError("VOCAB_BUNDLE_HISTORY_DIFF_MISSING", "The import would change canonical stores without a reversible field-level History diff.");
    }
    if (history.changes.length > 0 && writes.length === 0) {
      throw codedError("VOCAB_BUNDLE_HISTORY_WRITE_MISSING", "A bundle History diff has no canonical transaction writes.");
    }

    const mutatedPaths = new Set(writes.map((write) => write.path));
    const preconditions = await preconditionsForCapture(target, mutatedPaths);
    const coreStats = { ...coreMerge.counts };
    const counts = {
      total: bundle.core.records.length,
      imported: coreStats.imported,
      updated: coreStats.updated,
      skippedExisting: coreStats.skippedExisting,
      skippedKnown: coreStats.skippedKnown,
      skipped: coreStats.skippedExisting + coreStats.skippedKnown,
      invalid: 0,
      stores: {
        core: coreStats,
        contexts: { ...contextMerge.counts },
        review: { ...reviewMerge.counts },
      },
    };
    return {
      bundle,
      target,
      writes,
      preconditions,
      counts,
      changed: writes.length > 0,
      history,
      plans: { context: contextPlan, review: reviewPlan },
    };
  }

  async function previewImportBundle(input, policy = {}) {
    const plan = await makeImportPlan(input, policy);
    return {
      status: plan.changed ? "ready" : "unchanged",
      ...plan.counts,
      writeCount: plan.writes.length,
      preconditionCount: plan.preconditions.length,
      stores: plan.counts.stores,
    };
  }

  async function importBundle(input, policy = {}) {
    const plan = await makeImportPlan(input, policy);
    if (!plan.changed) return { status: "unchanged", ...plan.counts, commit: { status: "noop" } };
    const actionId = makeId();
    const historySummary = {
      batchId: `bundle-import-${actionId}`,
      sessionId: coordinator.sessionId,
      kind: "bundle-import",
      entities: plan.history.entities,
      stores: plan.history.stores,
      changes: plan.history.changes,
    };
    const result = await coordinator.commit({
      actionId,
      writes: plan.writes,
      preconditions: plan.preconditions,
      historySummary,
      entities: plan.history.entities,
    });
    if (result.status === "conflict") return { status: "conflict", ...plan.counts, commit: result };
    if (result.status !== "committed" && result.status !== "noop") {
      throw codedError("VOCAB_BUNDLE_IMPORT_FAILED", "The multi-store vocabulary import did not commit.", result);
    }
    let reloadError = null;
    try { await personalService.reload(); }
    catch (error) { reloadError = { code: error.code || "vocabulary-reload-failed", message: error.message }; }
    return {
      status: result.status,
      ...plan.counts,
      commit: result,
      ...(reloadError ? { reloadError } : {}),
    };
  }

  return Object.freeze({ exportBundle, previewImportBundle, importBundle });
}

module.exports = {
  BUNDLE_KIND,
  BUNDLE_SCHEMA_VERSION,
  createVocabularyTransfer,
};
