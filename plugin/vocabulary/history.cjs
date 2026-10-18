"use strict";

const { canonicalHash, canonicalStringify, hashText } = require("./canonical.cjs");
const { VOCABULARY_DATA_ROOT, normalizePath } = require("./transactions.cjs");

const HISTORY_KIND = "vocabulary-history-batch";
const HISTORY_SCHEMA_VERSION = 3;
const SUPPORTED_HISTORY_SCHEMA_VERSIONS = new Set([1, 2, HISTORY_SCHEMA_VERSION]);
const HISTORY_CHANGE_KINDS = new Set(["field", "record", "entityCreate", "entityDelete"]);
const HISTORY_ENTITY_KINDS = new Set(["record", "entityCreate", "entityDelete"]);
const RESERVED_FIELDS = new Set([
  "schema", "schemaVersion", "revision", "kind", "storeId", "storeKind",
  "id", "key", "familyKey", "entityId", "recordId", "identity",
  "__proto__", "prototype", "constructor",
]);

function codedError(code, message, details) {
  const error = new Error(message);
  error.name = "VocabularyHistoryError";
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function assertText(value, name, max = 512) {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw codedError("VOCAB_HISTORY_FIELD_INVALID", `A valid ${name} is required.`);
  }
  return value;
}

function hashSegment(text) {
  return hashText(text).slice("sha256-v1:".length);
}

function cloneJson(value) {
  return JSON.parse(canonicalStringify(value));
}

function deeplyEqual(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function normalizeUserPath(path, root = VOCABULARY_DATA_ROOT) {
  const normalized = normalizePath(path, root);
  const relative = normalized.slice(`${root}/`.length);
  if (!relative || relative.startsWith("transactions/") || relative.startsWith("history/") || relative.startsWith(".")) {
    throw codedError("VOCAB_HISTORY_PATH_INVALID", "History may reference only canonical vocabulary store files.");
  }
  return normalized;
}

function validateFieldPath(path, entityId, changeKind, schemaVersion) {
  if (!Array.isArray(path) || path.length < 2 || path.length > 32) {
    throw codedError("VOCAB_HISTORY_FIELD_PATH_INVALID", "History records must identify an individual field, not a whole store or entity.");
  }
  for (const [index, segment] of path.entries()) {
    const valid = typeof segment === "string" ? segment.length > 0 && segment.length <= 512 && !/[\u0000-\u001f\u007f]/.test(segment)
      : Number.isSafeInteger(segment) && segment >= 0;
    if (!valid) throw codedError("VOCAB_HISTORY_FIELD_PATH_INVALID", "A history field path contains an invalid segment.");
    const lifecycleField = changeKind === "entityCreate" || changeKind === "entityDelete";
    if (typeof segment === "string" && RESERVED_FIELDS.has(segment) && segment !== entityId && !lifecycleField) {
      throw codedError("VOCAB_HISTORY_IDENTITY_PROTECTED", `History cannot change protected field ${segment}.`);
    }
    if (index === path.length - 1 && typeof segment === "number") {
      throw codedError("VOCAB_HISTORY_FIELD_PATH_INVALID", "History cannot target an individual array index.");
    }
  }
  if (path.length === 2 && (schemaVersion < 2 || (changeKind !== "entityCreate" && changeKind !== "entityDelete") ||
      path[0] !== "records" || path[1] !== entityId)) {
    throw codedError("VOCAB_HISTORY_FIELD_PATH_INVALID", "A record-root history path is allowed only for a complete v2 entity lifecycle change.");
  }
  return path.slice();
}

function stateAt(root, path) {
  let value = root;
  for (const segment of path) {
    if (value === null || typeof value !== "object") return { exists: false };
    if (Array.isArray(value)) {
      if (!Number.isSafeInteger(segment) || segment < 0 || segment >= value.length || !Object.hasOwn(value, segment)) return { exists: false };
    } else if (typeof segment !== "string" || !Object.hasOwn(value, segment)) {
      return { exists: false };
    }
    value = value[segment];
  }
  return { exists: true, value };
}

function defaultResolveField(snapshot, change) {
  if (!snapshot?.exists) return { exists: false, entityExists: false };
  const path = change.fieldPath;
  if (path[0] === "records" && path[1] === change.entityId && Array.isArray(snapshot.value?.records)) {
    const record = snapshot.value.records.find((candidate) => candidate && candidate.key === change.entityId);
    if (!record) return { exists: false, entityExists: false };
    return { ...stateAt(record, path.slice(2)), entityExists: true };
  }
  return { ...stateAt(snapshot.value, path), entityExists: true };
}

function equalsState(actual, exists, value) {
  if (actual.exists !== exists) return false;
  return !exists || deeplyEqual(actual.value, value);
}

function classify(actual, change) {
  if (change.kind === "entityCreate") {
    if (actual.entityExists === false) return "already-restored";
    return equalsState(actual, change.afterExists, change.after) ? "clean" : "conflict";
  }
  if (equalsState(actual, change.afterExists, change.after)) return "clean";
  if (equalsState(actual, change.beforeExists, change.before)) return "already-restored";
  return "conflict";
}

function normalizeSummary(summary, root, schemaVersion = HISTORY_SCHEMA_VERSION) {
  if (!SUPPORTED_HISTORY_SCHEMA_VERSIONS.has(schemaVersion)) {
    throw codedError("VOCAB_HISTORY_SCHEMA_UNKNOWN", `History schema ${schemaVersion} is unsupported.`);
  }
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) throw new TypeError("A vocabulary history summary is required.");
  const batchId = assertText(summary.batchId, "history batch ID");
  const sessionId = assertText(summary.sessionId, "history session ID");
  const deviceId = assertText(summary.deviceId, "device ID", 128);
  const transactionId = assertText(summary.transactionId, "transaction ID");
  const actionKind = assertText(summary.kind || "edit", "history batch kind", 128);
  const rawEntities = summary.entities === undefined ? [] : summary.entities;
  const stores = summary.stores === undefined ? [] : summary.stores;
  const changes = summary.changes === undefined ? [] : summary.changes;
  if (!Array.isArray(rawEntities) || !Array.isArray(stores) || !Array.isArray(changes)) {
    throw codedError("VOCAB_HISTORY_SUMMARY_INVALID", "History entities, stores, and field changes must be arrays.");
  }
  const storeByPair = new Map();
  const normalizedStores = stores.map((store) => {
    const storeId = assertText(store?.storeId, "store ID", 128);
    const path = normalizeUserPath(store.path, root);
    if (!Number.isSafeInteger(store.baseRevision) || store.baseRevision < 0 ||
        !Number.isSafeInteger(store.resultRevision) || store.resultRevision <= store.baseRevision) {
      throw codedError("VOCAB_HISTORY_REVISION_INVALID", `History revisions are invalid for ${storeId} at ${path}.`);
    }
    const baseHash = store.baseHash;
    const resultHash = store.resultHash;
    if ((baseHash !== null && !/^sha256-v1:[a-f0-9]{64}$/.test(baseHash || "")) ||
        (store.baseRevision > 0 && baseHash === null) ||
        !/^sha256-v1:[a-f0-9]{64}$/.test(resultHash || "")) {
      throw codedError("VOCAB_HISTORY_HASH_INVALID", `History hashes are invalid for ${storeId} at ${path}.`);
    }
    const pair = `${storeId}\u0000${path}`;
    if (storeByPair.has(pair)) throw codedError("VOCAB_HISTORY_STORE_DUPLICATE", `History contains duplicate store path ${path}.`);
    const entry = { storeId, path, baseRevision: store.baseRevision, resultRevision: store.resultRevision, baseHash, resultHash };
    storeByPair.set(pair, entry);
    return entry;
  });

  const uniqueFields = new Set();
  const normalizedChanges = changes.map((change) => {
    const storeId = assertText(change?.storeId, "change store ID", 128);
    const path = normalizeUserPath(change.path, root);
    const entityId = assertText(change?.entityId, "history entity ID");
    const changeKind = change.kind || "field";
    if (!HISTORY_CHANGE_KINDS.has(changeKind)) {
      throw codedError("VOCAB_HISTORY_CHANGE_KIND_INVALID", `History change kind ${changeKind} is unsupported.`);
    }
    const fieldPath = validateFieldPath(change.fieldPath, entityId, changeKind, schemaVersion);
    if (!storeByPair.has(`${storeId}\u0000${path}`)) {
      throw codedError("VOCAB_HISTORY_STORE_MISSING", `History change ${entityId} does not match a declared store path.`);
    }
    if (typeof change.beforeExists !== "boolean" || typeof change.afterExists !== "boolean") {
      throw codedError("VOCAB_HISTORY_PRESENCE_INVALID", "History changes must record beforeExists and afterExists explicitly.");
    }
    if (change.beforeExists && !Object.hasOwn(change, "before")) throw codedError("VOCAB_HISTORY_VALUE_MISSING", "A present before value is required.");
    if (change.afterExists && !Object.hasOwn(change, "after")) throw codedError("VOCAB_HISTORY_VALUE_MISSING", "A present after value is required.");
    if (change.beforeExists) canonicalStringify(change.before);
    if (change.afterExists) canonicalStringify(change.after);
    const identity = canonicalStringify({ storeId, path, entityId, fieldPath });
    if (uniqueFields.has(identity)) throw codedError("VOCAB_HISTORY_CHANGE_DUPLICATE", "A history batch can contain only one final change per field.");
    uniqueFields.add(identity);
    const normalized = { storeId, path, entityId, fieldPath, kind: changeKind,
      beforeExists: change.beforeExists, afterExists: change.afterExists };
    if (change.beforeExists) normalized.before = cloneJson(change.before);
    if (change.afterExists) normalized.after = cloneJson(change.after);
    if (change.field !== undefined) normalized.field = assertText(change.field, "field name", 128);
    return normalized;
  });
  const entities = rawEntities.map((entity) => {
    const storeId = assertText(entity?.storeId, "entity store ID", 128);
    const entityId = assertText(entity?.entityId, "entity ID");
    const kind = entity.kind || "record";
    if (!HISTORY_ENTITY_KINDS.has(kind)) {
      throw codedError("VOCAB_HISTORY_ENTITY_KIND_INVALID", `History entity kind ${kind} is unsupported.`);
    }
    const normalized = { ...cloneJson(entity), storeId, entityId, kind };
    return normalized;
  });
  // Lifecycle validation must scale with the supplied diff size. Building the
  // index once avoids filtering every field change for every created entity
  // during large, but bounded, vocabulary bundle imports.
  const entityPair = (storeId, entityId) => `${storeId}\u0000${entityId}`;
  const lifecycleChangesByEntity = new Map();
  for (const change of normalizedChanges) {
    const key = entityPair(change.storeId, change.entityId);
    const group = lifecycleChangesByEntity.get(key) || [];
    group.push(change);
    lifecycleChangesByEntity.set(key, group);
  }
  const entityLifecycleKinds = new Map();
  for (const entity of entities) {
    if (entity.kind === "entityCreate" || entity.kind === "entityDelete") {
      const key = entityPair(entity.storeId, entity.entityId);
      let kinds = entityLifecycleKinds.get(key);
      if (!kinds) entityLifecycleKinds.set(key, kinds = new Set());
      kinds.add(entity.kind);
    }
  }
  const lifecyclePathLengths = new Map();
  const entityChangeCounts = new Map();
  for (const change of normalizedChanges) {
    const entityKey = entityPair(change.storeId, change.entityId);
    entityChangeCounts.set(entityKey, (entityChangeCounts.get(entityKey) || 0) + 1);
    if (change.kind !== "entityCreate" && change.kind !== "entityDelete") continue;
    const lengths = lifecyclePathLengths.get(entityKey) || new Set();
    lengths.add(change.fieldPath.length);
    lifecyclePathLengths.set(entityKey, lengths);
  }
  for (const [entityKey, lengths] of lifecyclePathLengths) {
    if (lengths.has(2) && (lengths.size !== 1 || entityChangeCounts.get(entityKey) !== 1)) {
      throw codedError("VOCAB_HISTORY_ENTITY_LIFECYCLE_INVALID", "A record-root lifecycle change cannot be mixed with field-level lifecycle changes for the same entity.");
    }
  }
  for (const entity of entities) {
    if (entity.kind !== "entityCreate" && entity.kind !== "entityDelete") continue;
    const lifecycleChanges = lifecycleChangesByEntity.get(entityPair(entity.storeId, entity.entityId)) || [];
    if (!lifecycleChanges.length || lifecycleChanges.some((change) => change.kind !== entity.kind ||
        (entity.kind === "entityCreate" && (change.beforeExists || !change.afterExists)) ||
        (entity.kind === "entityDelete" && (!change.beforeExists || change.afterExists)))) {
      throw codedError("VOCAB_HISTORY_ENTITY_LIFECYCLE_INVALID", `Entity lifecycle ${entity.kind} must be recorded as a complete set of field changes for ${entity.entityId}.`);
    }
  }
  for (const change of normalizedChanges) {
    if (change.kind !== "entityCreate" && change.kind !== "entityDelete") continue;
    if (!entityLifecycleKinds.get(entityPair(change.storeId, change.entityId))?.has(change.kind)) {
      throw codedError("VOCAB_HISTORY_ENTITY_LIFECYCLE_INVALID", `Lifecycle field ${change.entityId} requires matching entity metadata.`);
    }
  }
  if (!normalizedChanges.length) throw codedError("VOCAB_HISTORY_EMPTY", "A no-op transaction does not create a permanent history batch.");
  return { schemaVersion, batchId, sessionId, deviceId, transactionId, kind: actionKind, entities: cloneJson(entities), stores: normalizedStores, changes: normalizedChanges };
}

function changeIdFor(batchId, change) {
  return hashSegment(canonicalStringify({ batchId, storeId: change.storeId, path: change.path, entityId: change.entityId, fieldPath: change.fieldPath }));
}

function changeFieldIdentity(change) {
  return canonicalStringify({ storeId: change.storeId, entityId: change.entityId, fieldPath: change.fieldPath });
}

function batchSummaryComparable(value) {
  const { transactionId, ...rest } = value;
  return rest;
}

class VocabularyHistory {
  constructor({ coordinator, root = VOCABULARY_DATA_ROOT, makeId = null, handlers = {} } = {}) {
    if (!coordinator || typeof coordinator.readSnapshot !== "function" || typeof coordinator.commit !== "function") {
      throw new TypeError("VocabularyHistory requires a transaction coordinator.");
    }
    if (root !== VOCABULARY_DATA_ROOT) throw codedError("VOCAB_HISTORY_ROOT_INVALID", `History must be rooted at ${VOCABULARY_DATA_ROOT}.`);
    this.coordinator = coordinator;
    this.root = root;
    this.makeId = makeId || coordinator.makeId;
    if (typeof this.makeId !== "function") throw new TypeError("Vocabulary history requires a stable ID factory.");
    this.handlers = new Map();
    for (const [storeId, handler] of handlers instanceof Map ? handlers : Object.entries(handlers || {})) {
      this.registerStoreHandler(storeId, handler);
    }
    coordinator.attachHistory(this);
  }

  registerStoreHandler(storeId, handler) {
    const id = assertText(storeId, "store ID", 128);
    if (!handler || typeof handler.planRestore !== "function") {
      throw new TypeError("A history store handler must expose planRestore().");
    }
    this.handlers.set(id, handler);
    return this;
  }

  async _resolveField(snapshot, change, batch) {
    const handler = this.handlers.get(change.storeId);
    const resolved = typeof handler?.resolveField === "function"
      ? await handler.resolveField({ snapshot, change, batch })
      : defaultResolveField(snapshot, change);
    if (!resolved || typeof resolved !== "object" || typeof resolved.exists !== "boolean" ||
        (resolved.exists && !Object.hasOwn(resolved, "value"))) {
      throw codedError("VOCAB_HISTORY_FIELD_RESOLVER_INVALID", `Store ${change.storeId} returned an invalid field resolution for ${change.entityId}.`);
    }
    if ((change.kind === "entityCreate" || change.kind === "entityDelete") && typeof resolved.entityExists !== "boolean") {
      throw codedError("VOCAB_HISTORY_FIELD_RESOLVER_INVALID", `Lifecycle field resolution must report whether entity ${change.entityId} exists.`);
    }
    if (resolved.exists) canonicalStringify(resolved.value);
    return { exists: resolved.exists, ...(resolved.exists ? { value: cloneJson(resolved.value) } : {}),
      ...(typeof resolved.entityExists === "boolean" ? { entityExists: resolved.entityExists } : {}) };
  }

  pathFor(batchId, deviceId = this.coordinator.deviceId) {
    const safeDeviceId = assertText(deviceId, "device ID", 128);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(safeDeviceId)) {
      throw codedError("VOCAB_HISTORY_DEVICE_INVALID", "A path-safe device ID is required for history access.");
    }
    return `${this.root}/history/${safeDeviceId}/${hashSegment(assertText(batchId, "history batch ID"))}.json`;
  }

  _batchValue(summary) {
    return {
      schemaVersion: summary.schemaVersion || HISTORY_SCHEMA_VERSION,
      kind: HISTORY_KIND,
      revision: 1,
      batchId: summary.batchId,
      sessionId: summary.sessionId,
      deviceId: summary.deviceId,
      transactionId: summary.transactionId,
      actionKind: summary.kind,
      entities: summary.entities,
      stores: summary.stores,
      changes: summary.changes.map((change) => ({ ...change, changeId: changeIdFor(summary.batchId, change) })),
    };
  }

  _encodeBatch(summary) {
    const batch = this._batchValue(summary);
    if (batch.schemaVersion !== 3 || !batch.changes.length || batch.changes.some((change) =>
      !["entityCreate", "entityDelete"].includes(change.kind) || change.field !== undefined ||
      change.fieldPath.length !== 2 || change.fieldPath[0] !== "records" ||
      change.fieldPath[1] !== change.entityId ||
      (change.kind === "entityCreate" && (change.beforeExists || !change.afterExists)) ||
      (change.kind === "entityDelete" && (!change.beforeExists || change.afterExists)) ||
      !change[change.kind === "entityCreate" ? "after" : "before"] ||
      typeof change[change.kind === "entityCreate" ? "after" : "before"] !== "object" ||
      Array.isArray(change[change.kind === "entityCreate" ? "after" : "before"]))) {
      return batch;
    }

    // Lifecycle imports carry one full record per entity. Store the shared
    // store/path/kind once, then only the entity identity and payload; readers
    // inflate this back into the established reversible change API. The
    // transaction coordinator's pending/staging protocol is unchanged.
    const groupsByKey = new Map();
    for (const change of batch.changes) {
      const groupKey = canonicalStringify({ storeId: change.storeId, path: change.path, kind: change.kind });
      let group = groupsByKey.get(groupKey);
      if (!group) {
        group = { storeId: change.storeId, path: change.path, kind: change.kind, records: [] };
        groupsByKey.set(groupKey, group);
      }
      group.records.push([change.entityId, change.kind === "entityCreate" ? change.after : change.before]);
    }
    return {
      schemaVersion: 3,
      kind: HISTORY_KIND,
      revision: 1,
      batchId: batch.batchId,
      sessionId: batch.sessionId,
      deviceId: batch.deviceId,
      transactionId: batch.transactionId,
      actionKind: batch.actionKind,
      stores: batch.stores,
      changes: { encoding: "record-root-lifecycle-v1", groups: [...groupsByKey.values()] },
    };
  }

  async prepareRecordBatch(summary, snapshot) {
    const normalized = normalizeSummary(summary, this.root);
    if (normalized.deviceId !== this.coordinator.deviceId) {
      throw codedError("VOCAB_HISTORY_DEVICE_MISMATCH", "History can only be recorded under the current local device identity.");
    }
    if (snapshot.exists) {
      const existing = this._decodeBatch(snapshot, normalized.batchId);
      if (!deeplyEqual(batchSummaryComparable(existing), batchSummaryComparable(this._batchValue(normalized)))) {
        throw codedError("VOCAB_HISTORY_BATCH_ID_COLLISION", `History batch ID ${normalized.batchId} already has different contents.`);
      }
      return null;
    }
    return {
      path: this.pathFor(normalized.batchId),
      storeId: "vocabulary-history",
      expectedRevision: 0,
      expectedHash: null,
      text: canonicalStringify(this._encodeBatch(normalized)),
    };
  }

  _decodeBatch(snapshot, expectedBatchId) {
    const raw = snapshot?.value;
    if (!snapshot?.exists || !snapshot.value || canonicalStringify(snapshot.value) !== snapshot.text ||
        !SUPPORTED_HISTORY_SCHEMA_VERSIONS.has(raw.schemaVersion) || raw.kind !== HISTORY_KIND ||
        raw.revision !== 1 || raw.batchId !== expectedBatchId || !Array.isArray(raw.stores)) {
      throw codedError("VOCAB_HISTORY_BATCH_INVALID", `History batch ${expectedBatchId} failed verification.`);
    }
    let changes = raw.changes;
    let entities = raw.entities;
    const compact = raw.schemaVersion === 3 && raw.changes && !Array.isArray(raw.changes) &&
      raw.changes.encoding === "record-root-lifecycle-v1";
    if (compact) {
      if (Object.keys(raw.changes).some((key) => !["encoding", "groups"].includes(key)) ||
          !Array.isArray(raw.changes.groups) || Object.hasOwn(raw, "entities")) {
        throw codedError("VOCAB_HISTORY_BATCH_INVALID", `History batch ${expectedBatchId} has an invalid compact encoding.`);
      }
      changes = [];
      entities = [];
      for (const group of raw.changes.groups) {
        if (!group || Object.keys(group).some((key) => !["storeId", "path", "kind", "records"].includes(key)) ||
            !["entityCreate", "entityDelete"].includes(group.kind) || !Array.isArray(group.records) ||
            group.records.length === 0) {
          throw codedError("VOCAB_HISTORY_BATCH_INVALID", `History batch ${expectedBatchId} has an invalid compact lifecycle group.`);
        }
        for (const row of group.records) {
          if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !row[1] ||
              typeof row[1] !== "object" || Array.isArray(row[1])) {
            throw codedError("VOCAB_HISTORY_BATCH_INVALID", `History batch ${expectedBatchId} has an invalid compact lifecycle row.`);
          }
          const [entityId, value] = row;
          const change = { storeId: group.storeId, path: group.path, entityId,
            fieldPath: ["records", entityId], kind: group.kind,
            beforeExists: group.kind === "entityDelete", afterExists: group.kind === "entityCreate" };
          if (change.beforeExists) change.before = value;
          if (change.afterExists) change.after = value;
          changes.push(change);
          entities.push({ storeId: group.storeId, entityId, kind: group.kind });
        }
      }
    } else if (!Array.isArray(changes) || !Array.isArray(entities)) {
      throw codedError("VOCAB_HISTORY_BATCH_INVALID", `History batch ${expectedBatchId} has invalid changes or entity metadata.`);
    }
    const summary = normalizeSummary({
      batchId: raw.batchId,
      sessionId: raw.sessionId,
      deviceId: raw.deviceId,
      transactionId: raw.transactionId,
      kind: raw.actionKind,
      entities,
      stores: raw.stores,
      changes: changes.map(({ changeId, ...change }) => change),
    }, this.root, raw.schemaVersion);
    const expected = this._encodeBatch(summary);
    if (!deeplyEqual(expected, raw)) {
      throw codedError("VOCAB_HISTORY_BATCH_INVALID", `History batch ${expectedBatchId} contains unsupported fields.`);
    }
    return raw.schemaVersion === 3 ? this._batchValue(summary) : raw;
  }

  async readBatch(batchId, { deviceId = this.coordinator.deviceId } = {}) {
    const path = this.pathFor(batchId, deviceId);
    const snapshot = await this.coordinator.readSnapshot(path);
    if (!snapshot.exists) return null;
    const batch = this._decodeBatch(snapshot, batchId);
    if (batch.deviceId !== deviceId) {
      throw codedError("VOCAB_HISTORY_DEVICE_MISMATCH", `History batch ${batchId} is stored beneath the wrong device identity.`);
    }
    return batch;
  }

  async listBatches({ deviceIds } = {}) {
    const historyRoot = `${this.root}/history`;
    if (!(await this.coordinator.adapter.exists(historyRoot))) return [];
    if (typeof this.coordinator.adapter.list !== "function") {
      throw new TypeError("Vault DataAdapter must implement list(path) to enumerate vocabulary history.");
    }
    if (deviceIds !== undefined && (!Array.isArray(deviceIds) || deviceIds.some((id) => typeof id !== "string"))) {
      throw codedError("VOCAB_HISTORY_DEVICE_SELECTION_INVALID", "History device selection must be an array of device IDs.");
    }
    const selectedDevices = deviceIds === undefined ? null : new Set(deviceIds);
    const rootListing = await this.coordinator.adapter.list(historyRoot);
    const deviceFolders = Array.isArray(rootListing?.folders) ? rootListing.folders : [];
    const batches = [];
    for (const folder of deviceFolders) {
      if (typeof folder !== "string" || !folder.startsWith(`${historyRoot}/`)) continue;
      const deviceId = folder.slice(historyRoot.length + 1);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId) || (selectedDevices && !selectedDevices.has(deviceId))) continue;
      const listing = await this.coordinator.adapter.list(folder);
      for (const path of Array.isArray(listing?.files) ? listing.files : []) {
        if (typeof path !== "string" || !path.startsWith(`${folder}/`) || !/^[a-f0-9]{64}\.json$/.test(path.slice(folder.length + 1))) continue;
        const snapshot = await this.coordinator.readSnapshot(path);
        if (!snapshot.exists) throw codedError("VOCAB_HISTORY_BATCH_MISSING", `History file disappeared during enumeration at ${path}.`);
        const batchId = assertText(snapshot.value?.batchId, "history batch ID");
        const batch = this._decodeBatch(snapshot, batchId);
        if (batch.deviceId !== deviceId || this.pathFor(batch.batchId, deviceId) !== path) {
          throw codedError("VOCAB_HISTORY_DEVICE_MISMATCH", `Final history batch identity does not match its stored device path at ${path}.`);
        }
        batches.push(batch);
      }
    }
    return batches.sort((left, right) => left.deviceId.localeCompare(right.deviceId) || left.batchId.localeCompare(right.batchId));
  }

  async previewRestore(batchId, { deviceId = this.coordinator.deviceId } = {}) {
    const batch = await this.readBatch(batchId, { deviceId });
    if (!batch) return { status: "missing", batchId, items: [] };
    const snapshots = new Map();
    for (const store of batch.stores) {
      if (!snapshots.has(store.path)) snapshots.set(store.path, await this.coordinator.readSnapshot(store.path));
    }
    const items = await Promise.all(batch.changes.map(async (change) => {
      const snapshot = snapshots.get(change.path);
      const current = await this._resolveField(snapshot, change, batch);
      return {
        ...change,
        status: classify(current, change),
        currentExists: current.exists,
        ...(current.exists ? { current: cloneJson(current.value) } : {}),
        ...(typeof current.entityExists === "boolean" ? { entityExists: current.entityExists } : {}),
        currentRevision: snapshot.revision,
        currentHash: snapshot.hash,
      };
    }));
    return { status: items.some((item) => item.status === "conflict") ? "conflict" : "ready", batchId, batch, items };
  }

  async restore(batchId, { selected, overwriteConflictIds = [], actionId, deviceId = this.coordinator.deviceId } = {}) {
    if (!Array.isArray(overwriteConflictIds) || overwriteConflictIds.some((id) => typeof id !== "string")) {
      throw codedError("VOCAB_HISTORY_SELECTION_INVALID", "Conflicting fields require an explicit array of change IDs to overwrite.");
    }
    if (new Set(overwriteConflictIds).size !== overwriteConflictIds.length) {
      throw codedError("VOCAB_HISTORY_SELECTION_INVALID", "Conflict overwrite selection contains duplicates.");
    }
    if (selected !== undefined && (!Array.isArray(selected) || selected.some((id) => typeof id !== "string"))) {
      throw codedError("VOCAB_HISTORY_SELECTION_INVALID", "Restore selection must be an array of change IDs.");
    }
    const preview = await this.previewRestore(batchId, { deviceId });
    if (preview.status === "missing") return { status: "missing", batchId, preview };
    const allIds = new Set(preview.items.map((item) => item.changeId));
    const selectedIds = selected === undefined ? null : new Set(selected);
    if (selectedIds && selectedIds.size !== selected.length) {
      throw codedError("VOCAB_HISTORY_SELECTION_INVALID", "Restore selection contains duplicate change IDs.");
    }
    for (const id of [...(selectedIds || []), ...overwriteConflictIds]) {
      if (!allIds.has(id)) throw codedError("VOCAB_HISTORY_SELECTION_INVALID", "Restore selection includes a field outside this history batch.");
    }
    if (selectedIds && overwriteConflictIds.some((id) => !selectedIds.has(id))) {
      throw codedError("VOCAB_HISTORY_SELECTION_INVALID", "Conflict overwrite IDs must also appear in the explicit restore selection.");
    }
    const overwrite = new Set(overwriteConflictIds);
    const chosenIds = new Set(preview.items.filter((item) => {
      if (selectedIds) return selectedIds.has(item.changeId);
      return item.status === "clean" || overwrite.has(item.changeId);
    }).map((item) => item.changeId));
    const lifecycleGroups = new Map();
    for (const item of preview.items.filter((change) => change.kind === "entityCreate" || change.kind === "entityDelete")) {
      const key = `${item.storeId}\u0000${item.entityId}`;
      if (!lifecycleGroups.has(key)) lifecycleGroups.set(key, []);
      lifecycleGroups.get(key).push(item);
    }
    for (const group of lifecycleGroups.values()) {
      const selectedCount = group.filter((item) => chosenIds.has(item.changeId)).length;
      if (selectedIds && selectedCount !== 0 && selectedCount !== group.length) {
        throw codedError("VOCAB_HISTORY_LIFECYCLE_SELECTION", "Entity creation/deletion fields must be restored as one complete lifecycle group.");
      }
      if (!selectedIds && selectedCount !== group.length) {
        for (const item of group) chosenIds.delete(item.changeId);
      }
    }
    const chosen = preview.items.filter((item) => chosenIds.has(item.changeId));

    // Re-read each relevant file before handing it to the domain planner. The
    // transaction then checks these exact hashes again while installing writes.
    const snapshots = new Map();
    for (const store of preview.batch.stores) {
      if (!snapshots.has(store.path)) snapshots.set(store.path, await this.coordinator.readSnapshot(store.path));
    }
    const fresh = await Promise.all(chosen.map(async (item) => {
      const snapshot = snapshots.get(item.path);
      const current = await this._resolveField(snapshot, item, preview.batch);
      return { ...item, status: classify(current, item), currentExists: current.exists,
        ...(current.exists ? { current: cloneJson(current.value) } : {}),
        ...(typeof current.entityExists === "boolean" ? { entityExists: current.entityExists } : {}),
        currentRevision: snapshot.revision, currentHash: snapshot.hash };
    }));
    const eligibleIds = new Set(fresh.filter((item) => item.status === "clean" || (item.status === "conflict" && overwrite.has(item.changeId)))
      .map((item) => item.changeId));
    const skippedIds = new Set(fresh.filter((item) => item.status === "already-restored" ||
      (item.status === "conflict" && !overwrite.has(item.changeId))).map((item) => item.changeId));
    for (const group of lifecycleGroups.values()) {
      const freshGroup = fresh.filter((item) => group.some((entry) => entry.changeId === item.changeId));
      if (!freshGroup.length) continue;
      const eligibleCount = freshGroup.filter((item) => eligibleIds.has(item.changeId)).length;
      if (eligibleCount !== freshGroup.length) {
        for (const item of freshGroup) {
          eligibleIds.delete(item.changeId);
          skippedIds.add(item.changeId);
        }
      }
    }
    const selectedChanges = fresh.filter((item) => eligibleIds.has(item.changeId));
    const skipped = [...skippedIds];
    if (!selectedChanges.length) return { status: "unchanged", preview, restored: [], skipped };

    const byStore = new Map();
    for (const item of selectedChanges) {
      if (!byStore.has(item.storeId)) byStore.set(item.storeId, []);
      byStore.get(item.storeId).push(item);
    }
    const plans = [];
    for (const [storeId, changes] of byStore) {
      const handler = this.handlers.get(storeId);
      if (!handler) throw codedError("VOCAB_HISTORY_RESTORE_HANDLER_MISSING", `No validated restore planner is registered for vocabulary store ${storeId}.`);
      const overwriteIds = new Set(changes.filter((item) => item.status === "conflict" && overwrite.has(item.changeId)).map((item) => item.changeId));
      const plan = await handler.planRestore({ batch: preview.batch, selectedChanges: changes, snapshots, overwriteConflictIds: overwriteIds });
      if (!plan || !Array.isArray(plan.writes) || !plan.writes.length) {
        throw codedError("VOCAB_HISTORY_RESTORE_PLAN_INVALID", `Store ${storeId} did not provide a verified restore write plan.`);
      }
      plans.push({ storeId, changes, plan });
    }
    const restorePreconditions = new Map();
    for (const { storeId, plan } of plans) {
      if (plan.preconditions === undefined) continue;
      if (!Array.isArray(plan.preconditions)) {
        throw codedError("VOCAB_HISTORY_RESTORE_PRECONDITION_INVALID", `Store ${storeId} returned invalid restore preconditions.`);
      }
      for (const condition of plan.preconditions) {
        const path = normalizeUserPath(condition?.path, this.root);
        if (typeof condition?.storeId !== "string" || !condition.storeId || condition.storeId.length > 128 ||
            !Number.isSafeInteger(condition.expectedRevision) || condition.expectedRevision < 0 ||
            (condition.expectedRevision === 0 && condition.expectedHash === null ? false :
              typeof condition.expectedHash !== "string" || !/^sha256-v1:[a-f0-9]{64}$/.test(condition.expectedHash))) {
          throw codedError("VOCAB_HISTORY_RESTORE_PRECONDITION_INVALID", `Store ${storeId} returned an invalid snapshot identity for ${path}.`);
        }
        const normalized = { storeId: condition.storeId, path, expectedRevision: condition.expectedRevision, expectedHash: condition.expectedHash };
        const existing = restorePreconditions.get(path);
        if (existing && (existing.storeId !== normalized.storeId || existing.expectedRevision !== normalized.expectedRevision ||
            existing.expectedHash !== normalized.expectedHash)) {
          return { status: "conflict", preview, restored: [], skipped,
            conflicts: [{ path, phase: "restore-precondition-identity-conflict", expected: existing, actual: normalized }] };
        }
        restorePreconditions.set(path, normalized);
      }
    }
    const writes = [];
    const historyStores = [];
    const inverseChanges = [];
    const entities = new Map();
    const seenPaths = new Set();
    for (const { storeId, changes, plan } of plans) {
      const writePaths = new Set();
      for (const write of plan.writes) {
        const path = normalizeUserPath(write.path, this.root);
        if (write.storeId !== storeId || seenPaths.has(path)) {
          throw codedError("VOCAB_HISTORY_RESTORE_PLAN_INVALID", `Restore planner returned a duplicate or cross-store path ${path}.`);
        }
        seenPaths.add(path);
        writePaths.add(path);
        if (typeof write.text !== "string") throw codedError("VOCAB_HISTORY_RESTORE_PLAN_INVALID", `Restore planner omitted canonical text for ${path}.`);
        const value = JSON.parse(write.text);
        if (canonicalStringify(value) !== write.text || value.revision !== write.expectedRevision + 1) {
          throw codedError("VOCAB_HISTORY_RESTORE_PLAN_INVALID", `Restore planner returned an invalid revision or noncanonical payload for ${path}.`);
        }
        const resultHash = hashText(write.text);
        writes.push(write);
        historyStores.push({ storeId, path, baseRevision: write.expectedRevision, resultRevision: value.revision,
          baseHash: write.expectedHash, resultHash });
      }
      const plannedChanges = new Map();
      if (plan.changes !== undefined) {
        if (!Array.isArray(plan.changes) || plan.changes.length !== changes.length) {
          throw codedError("VOCAB_HISTORY_RESTORE_PLAN_INVALID", `Store ${storeId} returned a field change plan that does not match the selected fields.`);
        }
        for (const planned of plan.changes) {
          const key = changeFieldIdentity(planned);
          const path = normalizeUserPath(planned?.path, this.root);
          if (planned?.storeId !== storeId || !writePaths.has(path) || plannedChanges.has(key)) {
            throw codedError("VOCAB_HISTORY_RESTORE_PLAN_INVALID", `Store ${storeId} returned a field change outside its verified writes.`);
          }
          plannedChanges.set(key, { ...planned, path });
        }
        for (const item of changes) {
          const planned = plannedChanges.get(changeFieldIdentity(item));
          const inverseKind = item.kind === "entityCreate" ? "entityDelete" :
            item.kind === "entityDelete" ? "entityCreate" : item.kind;
          if (!planned || planned.kind !== inverseKind ||
              planned.beforeExists !== item.currentExists || planned.afterExists !== item.beforeExists ||
              (planned.beforeExists && !deeplyEqual(planned.before, item.current)) ||
              (planned.afterExists && !deeplyEqual(planned.after, item.before))) {
            throw codedError("VOCAB_HISTORY_RESTORE_PLAN_INVALID", `Store ${storeId} returned an inverse field plan that does not match the verified preview.`);
          }
        }
      }
      for (const item of changes) {
        const inverseKind = item.kind === "entityCreate" ? "entityDelete" :
          item.kind === "entityDelete" ? "entityCreate" : item.kind;
        const planned = plannedChanges.get(changeFieldIdentity(item));
        inverseChanges.push({
          storeId: item.storeId,
          path: planned?.path || item.path,
          entityId: item.entityId,
          fieldPath: item.fieldPath,
          kind: inverseKind,
          beforeExists: item.currentExists,
          afterExists: item.beforeExists,
          ...(item.currentExists ? { before: cloneJson(item.current) } : {}),
          ...(item.beforeExists ? { after: cloneJson(item.before) } : {}),
          ...(item.field ? { field: item.field } : {}),
        });
        const existingEntity = entities.get(`${item.storeId}\u0000${item.entityId}`);
        entities.set(`${item.storeId}\u0000${item.entityId}`, {
          storeId: item.storeId,
          entityId: item.entityId,
          kind: inverseKind === "entityCreate" || inverseKind === "entityDelete" ? inverseKind : (existingEntity?.kind || "record"),
        });
      }
    }
    if (!writes.length || !inverseChanges.length) return { status: "unchanged", preview, restored: [], skipped };

    const writePaths = new Set(writes.map((write) => normalizeUserPath(write.path, this.root)));
    for (const path of restorePreconditions.keys()) {
      if (writePaths.has(path)) {
        throw codedError("VOCAB_HISTORY_RESTORE_PRECONDITION_OVERLAP", `Restore precondition ${path} is also a planned write; its write base already provides the required identity check.`);
      }
    }

    const restoreBatchId = `restore-${this.makeId()}`;
    const summary = {
      batchId: restoreBatchId,
      sessionId: this.coordinator.sessionId,
      kind: "restore",
      entities: [...entities.values()],
      stores: historyStores,
      changes: inverseChanges,
    };
    const result = await this.coordinator.commit({
      actionId: actionId || `history-restore-${hashSegment(restoreBatchId)}`,
      writes,
      deletes: [],
      preconditions: [...restorePreconditions.values()],
      historySummary: summary,
      entities: summary.entities,
    });
    return { ...result, preview, restored: inverseChanges.map((change) => changeIdFor(restoreBatchId, change)), skipped, restoreBatchId };
  }
}

module.exports = { VocabularyHistory, HISTORY_KIND, HISTORY_SCHEMA_VERSION };
