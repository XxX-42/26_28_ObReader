"use strict";

const { canonicalHash, canonicalStringify, hashText } = require("./canonical.cjs");

const VOCABULARY_DATA_ROOT = "00_Archive/21_VocabularyData";
const JOURNAL_KIND = "vocabulary-review-journal-segment";
const JOURNAL_SCHEMA_VERSION = 1;
const JOURNAL_LINE_KIND = "vocabulary-review-journal-action";
const JOURNAL_LINE_SCHEMA_VERSION = 2;
const JOURNAL_SEGMENT_LIMIT = 64 * 1024;
const SUMMARY_SEGMENT_LIMIT = 64 * 1024;
const SUMMARY_CHUNK_BYTES = 48 * 1024;
const SUMMARY_MAX_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_ACTIONS = 10000;
const ADAPTER_LOCKS = new WeakMap();

function codedError(code, message, details) {
  const error = new Error(message);
  error.name = "VocabularyTransactionError";
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function assertAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("A Vault DataAdapter is required.");
  for (const method of ["exists", "read", "write", "rename", "remove", "mkdir"]) {
    if (typeof adapter[method] !== "function") {
      throw new TypeError(`Vault DataAdapter must implement ${method}().`);
    }
  }
}

function assertSafeSegment(segment) {
  if (!segment || segment === "." || segment === ".." || /[\\\u0000-\u001f\u007f]/.test(segment)) {
    throw codedError("VOCAB_TX_PATH_INVALID", "Vocabulary transaction paths cannot escape the vocabulary data root.");
  }
}

function normalizePath(path, root = VOCABULARY_DATA_ROOT) {
  if (root !== VOCABULARY_DATA_ROOT) {
    throw codedError("VOCAB_TX_ROOT_INVALID", `Vocabulary data must be rooted at ${VOCABULARY_DATA_ROOT}.`);
  }
  if (typeof path !== "string" || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw codedError("VOCAB_TX_PATH_INVALID", "Vocabulary transaction paths must be relative Vault paths.");
  }
  const parts = path.split("/");
  for (const part of parts) assertSafeSegment(part);
  if (parts.length <= 2 || parts[0] !== "00_Archive" || parts[1] !== "21_VocabularyData") {
    throw codedError("VOCAB_TX_PATH_INVALID", `Vocabulary transaction paths must be below ${VOCABULARY_DATA_ROOT}/.`);
  }
  return parts.join("/");
}

function isInternalPath(path) {
  const first = path.slice(VOCABULARY_DATA_ROOT.length + 1).split("/")[0];
  return first.startsWith(".") || first === "transactions" || first === "history";
}

function safeIdentity(value, name) {
  if (typeof value !== "string" || !value || value.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(value)) {
    throw codedError("VOCAB_TX_ID_INVALID", `A stable ${name} is required.`);
  }
  return value;
}

function safePathIdentity(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw codedError("VOCAB_TX_ID_INVALID", `A path-safe ${name} is required.`);
  }
  return value;
}

function safeTransactionId(value) {
  const id = safePathIdentity(value, "transaction ID");
  if (id === "summary") throw codedError("VOCAB_TX_ID_INVALID", "The transaction ID 'summary' is reserved for the review summary manifest.");
  return id;
}

function hashPathSegment(value) {
  return hashText(value).slice("sha256-v1:".length, "sha256-v1:".length + 32);
}

function journalSegmentName(index) {
  return `review-${String(index).padStart(6, "0")}.segment.json`;
}

function journalLineName(index) {
  return `review-${String(index).padStart(6, "0")}.jsonl`;
}

function defaultMakeId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  defaultMakeId.counter += 1;
  return `${Date.now().toString(36)}-${defaultMakeId.counter.toString(36)}-${Math.random().toString(36).slice(2)}`;
}
defaultMakeId.counter = 0;

function deepEqual(left, right) {
  return canonicalStringify(left) === canonicalStringify(right);
}

function utf8Length(text) {
  if (typeof TextEncoder !== "function") throw codedError("VOCAB_TX_ENCODER_UNAVAILABLE", "TextEncoder is required for bounded vocabulary segments.");
  return new TextEncoder().encode(text).byteLength;
}

function splitUtf8Text(text, maxBytes) {
  if (typeof TextEncoder !== "function") throw codedError("VOCAB_TX_ENCODER_UNAVAILABLE", "TextEncoder is required for bounded vocabulary segments.");
  const encoder = new TextEncoder();
  const chunks = [];
  let chunk = "";
  let size = 0;
  for (const codePoint of text) {
    const bytes = encoder.encode(codePoint).byteLength;
    if (chunk && size + bytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += codePoint;
    size += bytes;
  }
  if (chunk || !chunks.length) chunks.push(chunk);
  return chunks;
}

function snapshotIdentity(snapshot) {
  return {
    exists: snapshot.exists,
    revision: snapshot.revision,
    hash: snapshot.hash,
  };
}

function sameIdentity(left, right) {
  return left.exists === right.exists && left.revision === right.revision && left.hash === right.hash;
}

function isResultState(snapshot, mutation) {
  if (mutation.operation === "delete") {
    return !snapshot.exists;
  }
  return snapshot.exists && snapshot.revision === mutation.result.revision && snapshot.hash === mutation.result.hash;
}

function isBaseState(snapshot, mutation) {
  return sameIdentity(snapshotIdentity(snapshot), mutation.base);
}

function normalizeExpected(input, path) {
  const revision = input.expectedRevision;
  const hash = input.expectedHash;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw codedError("VOCAB_TX_EXPECTED_REVISION_INVALID", `A non-negative expected revision is required for ${path}.`);
  }
  if (revision === 0 && hash === null) {
    return { exists: false, revision, hash };
  }
  if (typeof hash !== "string" || !/^sha256-v1:[a-f0-9]{64}$/.test(hash)) {
    throw codedError("VOCAB_TX_EXPECTED_HASH_INVALID", `A verified expected hash is required for ${path}.`);
  }
  return { exists: true, revision, hash };
}

function normalizePrecondition(input, root) {
  if (!input || typeof input !== "object") throw new TypeError("Vocabulary transaction preconditions must be objects.");
  const path = normalizePath(input.path, root);
  if (typeof input.storeId !== "string" || !input.storeId || input.storeId.length > 128) {
    throw codedError("VOCAB_TX_STORE_ID_INVALID", `A stable store ID is required for ${path}.`);
  }
  return { path, storeId: input.storeId, base: normalizeExpected(input, path) };
}

function normalizeResultCondition(input, root) {
  if (input?.result && typeof input.result === "object") {
    const path = normalizePath(input.path, root);
    if (typeof input.storeId !== "string" || !input.storeId || input.storeId.length > 128) {
      throw codedError("VOCAB_TX_STORE_ID_INVALID", `A stable store ID is required for ${path}.`);
    }
    const revision = input.result.revision;
    const hash = input.result.hash;
    if (!Number.isSafeInteger(revision) || revision < 0 ||
      (revision === 0 && hash === null ? false : typeof hash !== "string" || !/^sha256-v1:[a-f0-9]{64}$/.test(hash))) {
      throw codedError("VOCAB_TX_EXPECTED_HASH_INVALID", `A verified result state is required for ${path}.`);
    }
    return { path, storeId: input.storeId, result: { exists: revision !== 0 || hash !== null, revision, hash } };
  }
  const condition = normalizePrecondition(input, root);
  return { path: condition.path, storeId: condition.storeId, result: condition.base };
}

function normalizeWrite(input, root, { allowInternal = false } = {}) {
  if (!input || typeof input !== "object") throw new TypeError("Vocabulary writes must be objects.");
  const path = normalizePath(input.path, root);
  if (!allowInternal && isInternalPath(path)) {
    throw codedError("VOCAB_TX_RESERVED_PATH", "Vocabulary services cannot write coordinator-owned files.");
  }
  if (typeof input.storeId !== "string" || !input.storeId || input.storeId.length > 128) {
    throw codedError("VOCAB_TX_STORE_ID_INVALID", `A stable store ID is required for ${path}.`);
  }
  if (typeof input.text !== "string") throw codedError("VOCAB_TX_TEXT_INVALID", `A complete JSON payload is required for ${path}.`);
  let value;
  try { value = JSON.parse(input.text); }
  catch { throw codedError("VOCAB_TX_JSON_INVALID", `The transaction payload for ${path} is not valid JSON.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("VOCAB_TX_JSON_INVALID", `The transaction payload for ${path} must be a JSON object.`);
  }
  if (canonicalStringify(value) !== input.text) {
    throw codedError("VOCAB_TX_NONCANONICAL", `The transaction payload for ${path} must use canonical JSON.`);
  }
  const base = normalizeExpected(input, path);
  if (value.revision !== base.revision + 1) {
    throw codedError("VOCAB_TX_RESULT_REVISION_INVALID", `The result revision for ${path} must be exactly one greater than its expected revision.`);
  }
  const entities = input.entities === undefined ? [] : input.entities;
  if (!Array.isArray(entities)) throw codedError("VOCAB_TX_ENTITIES_INVALID", `Entity metadata for ${path} must be an array.`);
  canonicalStringify(entities);
  return {
    operation: "write",
    path,
    storeId: input.storeId,
    base,
    result: { exists: true, revision: value.revision, hash: hashText(input.text) },
    text: input.text,
    entities,
  };
}

function normalizeDelete(input, root, { allowInternal = false } = {}) {
  if (!input || typeof input !== "object") throw new TypeError("Vocabulary deletes must be objects.");
  const path = normalizePath(input.path, root);
  const internalSessionFile = path.startsWith(`${root}/transactions/`) &&
    (/\/review-[a-f0-9]{32}\.json$/.test(path) ||
      /\/review-\d{6}\.segment\.json(?:\.backup)?$/.test(path) ||
      /\/review-\d{6}\.jsonl$/.test(path) ||
      /\/summary-\d+-\d+\.segment\.json$/.test(path) || /\/summary\.pending\.json$/.test(path));
  if (!allowInternal || !internalSessionFile) {
    throw codedError("VOCAB_TX_DELETE_RESERVED", "Only coordinator-owned review and summary files can be deleted by a vocabulary transaction.");
  }
  if (typeof input.storeId !== "string" || !input.storeId || input.storeId.length > 128) {
    throw codedError("VOCAB_TX_STORE_ID_INVALID", `A stable store ID is required for ${path}.`);
  }
  const base = normalizeExpected(input, path);
  if (!base.exists) {
    // Deleting an absent file is idempotent and has no transaction payload.
    return { operation: "delete", path, storeId: input.storeId, base, result: { exists: false, revision: 0, hash: null } };
  }
  return { operation: "delete", path, storeId: input.storeId, base, result: { exists: false, revision: 0, hash: null } };
}

class VocabularyTransactionCoordinator {
  constructor({ adapter, root = VOCABULARY_DATA_ROOT, deviceId, sessionId, now = () => Date.now(), makeId = defaultMakeId } = {}) {
    assertAdapter(adapter);
    if (root !== VOCABULARY_DATA_ROOT) throw codedError("VOCAB_TX_ROOT_INVALID", `Vocabulary data must be rooted at ${VOCABULARY_DATA_ROOT}.`);
    this.adapter = adapter;
    this.root = root;
    this.deviceId = safePathIdentity(deviceId, "device ID");
    this.sessionId = safePathIdentity(sessionId, "session ID");
    if (typeof now !== "function" || typeof makeId !== "function") throw new TypeError("Transaction clock and ID factory must be functions.");
    this.now = now;
    this.makeId = makeId;
    this.history = null;
    let sharedLocks = ADAPTER_LOCKS.get(adapter);
    if (!sharedLocks) {
      sharedLocks = new Map();
      ADAPTER_LOCKS.set(adapter, sharedLocks);
    }
    this.pathLocks = sharedLocks;
    this.lastLockOrder = [];
  }

  attachHistory(history) {
    if (!history || typeof history.pathFor !== "function" || typeof history.prepareRecordBatch !== "function") {
      throw new TypeError("Vocabulary history must expose pathFor() and prepareRecordBatch().");
    }
    this.history = history;
    return history;
  }

  async readSnapshot(path) {
    const normalized = normalizePath(path, this.root);
    const exists = Boolean(await this.adapter.exists(normalized));
    if (!exists) return { exists: false, text: null, value: null, revision: 0, hash: null };
    const text = await this.adapter.read(normalized);
    if (typeof text !== "string") throw codedError("VOCAB_TX_READ_INVALID", `The DataAdapter returned non-text data for ${normalized}.`);
    if (new RegExp(`^${this.root}/transactions/${this.deviceId}/[A-Za-z0-9_-]{1,128}/review-\\d{6}\\.jsonl$`).test(normalized)) {
      // JSONL journal files are opaque coordinator-owned blobs. Their verified
      // content hash, rather than a JSON document revision, is the delete CAS.
      return { exists: true, text, value: null, revision: 0, hash: hashText(text) };
    }
    let value;
    try { value = JSON.parse(text); }
    catch { throw codedError("VOCAB_TX_JSON_INVALID", `Vocabulary data is malformed at ${normalized}.`); }
    if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw codedError("VOCAB_TX_REVISION_INVALID", `Vocabulary data at ${normalized} must have a non-negative integer revision.`);
    }
    return { exists: true, text, value, revision: value.revision, hash: hashText(text) };
  }

  _pendingRoot() {
    return `${this.root}/transactions/${this.deviceId}`;
  }

  _pendingPath(txId, sessionId = this.sessionId) {
    return `${this._sessionRoot(safePathIdentity(sessionId, "session ID"))}/${safeTransactionId(txId)}.pending.json`;
  }

  _sessionRoot(sessionId) {
    return `${this._pendingRoot()}/${safePathIdentity(sessionId, "session ID")}`;
  }

  _sessionLockPath(sessionId) {
    return `${this._sessionRoot(sessionId)}/.session-lock`;
  }

  _journalPath(sessionId, index) {
    return `${this._sessionRoot(sessionId)}/${journalSegmentName(index)}`;
  }

  _journalLinePath(sessionId, index) {
    return `${this._sessionRoot(sessionId)}/${journalLineName(index)}`;
  }

  _journalBackupPath(sessionId, index) {
    return `${this._journalPath(sessionId, index)}.backup`;
  }

  _summaryManifestPath(sessionId) {
    return `${this._sessionRoot(sessionId)}/summary.pending.json`;
  }

  async _ensureDirectory(path) {
    const normalized = normalizePath(`${path}/_directory_marker`, this.root);
    const directory = normalized.slice(0, normalized.lastIndexOf("/"));
    const segments = directory.split("/");
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.adapter.exists(current))) await this.adapter.mkdir(current);
    }
  }

  async _ensureParent(path) {
    const normalized = normalizePath(path, this.root);
    await this._ensureDirectory(normalized.slice(0, normalized.lastIndexOf("/")));
  }

  async _removeIfExists(path) {
    if (await this.adapter.exists(path)) await this.adapter.remove(path);
  }

  async _writeVerified(path, text) {
    await this._ensureParent(path);
    await this.adapter.write(path, text);
    const actual = await this.adapter.read(path);
    if (actual !== text) throw codedError("VOCAB_TX_WRITE_VERIFY", `The persisted transaction file did not verify at ${path}.`);
  }

  async _acquirePathLocks(paths) {
    const ordered = [...new Set(paths)].sort();
    this.lastLockOrder = ordered.slice();
    const acquired = [];
    try {
      for (const path of ordered) {
        const previous = this.pathLocks.get(path) || Promise.resolve();
        let releaseCurrent;
        const current = new Promise((resolve) => { releaseCurrent = resolve; });
        this.pathLocks.set(path, current);
        await previous;
        acquired.push({ path, current, releaseCurrent });
      }
    } catch (error) {
      for (const lock of acquired.reverse()) {
        if (this.pathLocks.get(lock.path) === lock.current) this.pathLocks.delete(lock.path);
        lock.releaseCurrent();
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const lock of acquired.reverse()) {
        if (this.pathLocks.get(lock.path) === lock.current) this.pathLocks.delete(lock.path);
        lock.releaseCurrent();
      }
    };
  }

  _intentEnvelope(payload) {
    return canonicalStringify({ payload, payloadHash: canonicalHash(payload) });
  }

  _decodeIntent(text, filePath) {
    let envelope;
    try { envelope = JSON.parse(text); }
    catch { throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction is malformed at ${filePath}.`); }
    if (!envelope || typeof envelope !== "object" || !envelope.payload ||
        envelope.payloadHash !== canonicalHash(envelope.payload) || canonicalStringify(envelope) !== text) {
      throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction failed its integrity check at ${filePath}.`);
    }
    const payload = envelope.payload;
    if (payload.schemaVersion !== 1 || payload.kind !== "vocabulary-transaction" ||
        payload.deviceId !== this.deviceId || typeof payload.sessionId !== "string" ||
        typeof payload.txId !== "string" || !Array.isArray(payload.mutations)) {
      throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction has an unsupported identity at ${filePath}.`);
    }
    for (const mutation of payload.mutations) {
      let normalized;
      if (mutation?.operation === "write") {
        normalized = normalizeWrite({
          path: mutation.path,
          storeId: mutation.storeId,
          expectedRevision: mutation.base?.revision,
          expectedHash: mutation.base?.hash,
          text: mutation.text,
          entities: mutation.entities,
        }, this.root, { allowInternal: true });
      } else if (mutation?.operation === "delete") {
        normalized = normalizeDelete({
          path: mutation.path,
          storeId: mutation.storeId,
          expectedRevision: mutation.base?.revision,
          expectedHash: mutation.base?.hash,
        }, this.root, { allowInternal: true });
      } else {
        throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction contains an unsupported mutation at ${filePath}.`);
      }
      if (!deepEqual(normalized, mutation)) {
        throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction mutation failed validation at ${filePath}.`);
      }
    }
    if (payload.preconditions !== undefined && !Array.isArray(payload.preconditions)) {
      throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction has invalid preconditions at ${filePath}.`);
    }
    for (const precondition of payload.preconditions || []) {
      const normalized = normalizePrecondition({
        path: precondition?.path,
        storeId: precondition?.storeId,
        expectedRevision: precondition?.base?.revision,
        expectedHash: precondition?.base?.hash,
      }, this.root);
      if (!deepEqual(normalized, precondition)) {
        throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction precondition failed validation at ${filePath}.`);
      }
    }
    if (payload.resultConditions !== undefined && !Array.isArray(payload.resultConditions)) {
      throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction has invalid result conditions at ${filePath}.`);
    }
    for (const condition of payload.resultConditions || []) {
      if (!deepEqual(normalizeResultCondition(condition, this.root), condition)) {
        throw codedError("VOCAB_TX_INTENT_INVALID", `A pending transaction result condition failed validation at ${filePath}.`);
      }
    }
    return payload;
  }

  async _snapshotForMutation(mutation) {
    return this.readSnapshot(mutation.path);
  }

  _classify(snapshot, mutation, backupSnapshot = null) {
    if (isResultState(snapshot, mutation)) return "result";
    if (isBaseState(snapshot, mutation)) return "base";
    if (!snapshot.exists && mutation.base.exists && backupSnapshot && isBaseState(backupSnapshot, mutation)) {
      return mutation.operation === "delete" ? "result" : "base";
    }
    return "third";
  }

  async _backupSnapshot(mutation, txId) {
    const backupPath = `${mutation.path}.vocab-backup-${hashPathSegment(txId)}`;
    if (!(await this.adapter.exists(backupPath))) return { path: backupPath, snapshot: null };
    const text = await this.adapter.read(backupPath);
    let value;
    try { value = JSON.parse(text); }
    catch { return { path: backupPath, snapshot: { exists: true, text, value: null, revision: -1, hash: hashText(text) } }; }
    const revision = Number.isSafeInteger(value?.revision) ? value.revision : -1;
    return { path: backupPath, snapshot: { exists: true, text, value, revision, hash: hashText(text) } };
  }

  async _mutationConflict(mutation, txId, phase) {
    const actual = await this._snapshotForMutation(mutation).catch((error) => ({
      exists: true, revision: -1, hash: null, readError: String(error?.message || error),
    }));
    return {
      storeId: mutation.storeId,
      path: mutation.path,
      phase,
      expected: mutation.base,
      result: mutation.result,
      actual: snapshotIdentity(actual),
      txId,
    };
  }

  async _installMutation(mutation, txId, { recovery = false } = {}) {
    const tempPath = `${mutation.path}.vocab-stage-${hashPathSegment(txId)}`;
    const backup = await this._backupSnapshot(mutation, txId);
    let current = await this._snapshotForMutation(mutation);
    let state = this._classify(current, mutation, backup.snapshot);
    if (state === "result") return { status: "result" };
    if (state === "third") return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, recovery ? "recovery-preflight" : "preflight") };

    if (mutation.operation === "write") {
      if (await this.adapter.exists(tempPath)) {
        const staged = await this.adapter.read(tempPath);
        if (staged !== mutation.text) {
          return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "stage-third-state") };
        }
      } else {
        await this._writeVerified(tempPath, mutation.text);
      }
    }

    current = await this._snapshotForMutation(mutation);
    const refreshedBackup = await this._backupSnapshot(mutation, txId);
    state = this._classify(current, mutation, refreshedBackup.snapshot);
    if (state === "result") return { status: "result" };
    if (state === "third") return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "pre-install-change") };

    if (current.exists) {
      if (refreshedBackup.snapshot) {
        if (!isBaseState(refreshedBackup.snapshot, mutation)) {
          return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "backup-third-state") };
        }
        await this._removeIfExists(refreshedBackup.path);
      }
      // DataAdapter offers no compare-and-swap. Re-read immediately before
      // moving the canonical file, then verify the bytes moved before install.
      const beforeRename = await this._snapshotForMutation(mutation);
      if (!isBaseState(beforeRename, mutation)) {
        if (isResultState(beforeRename, mutation)) return { status: "result" };
        return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "before-backup-rename") };
      }
      await this.adapter.rename(mutation.path, backup.path);
      const movedText = await this.adapter.read(backup.path);
      const movedHash = hashText(movedText);
      if (movedHash !== mutation.base.hash) {
        if (!(await this.adapter.exists(mutation.path))) await this.adapter.rename(backup.path, mutation.path);
        return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "backup-mismatch") };
      }
      if (await this.adapter.exists(mutation.path)) {
        // Preserve an external replacement which appeared during the rename window.
        return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "external-recreated-path") };
      }
    } else if (refreshedBackup.snapshot && mutation.operation === "write") {
      // A previous attempt moved the verified base aside and stopped before
      // the staged write was installed; use that backup without touching it.
      if (!isBaseState(refreshedBackup.snapshot, mutation)) {
        return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "missing-primary-backup-mismatch") };
      }
    }

    if (mutation.operation === "write") {
      if (await this.adapter.exists(mutation.path)) {
        const appeared = await this._snapshotForMutation(mutation);
        if (isResultState(appeared, mutation)) return { status: "result" };
        return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "external-before-install") };
      }
      await this.adapter.rename(tempPath, mutation.path);
      const installed = await this._snapshotForMutation(mutation);
      if (!isResultState(installed, mutation)) {
        return { status: "conflict", conflict: await this._mutationConflict(mutation, txId, "result-verification") };
      }
    }
    return { status: "result" };
  }

  async _finishIntent(payload, pendingPath, { recovery = false, locked = false } = {}) {
    const lockPaths = [...payload.mutations.map((mutation) => mutation.path),
      ...(payload.preconditions || []).map((item) => item.path),
      ...(payload.resultConditions || []).map((item) => item.path)];
    const release = locked ? () => undefined : await this._acquirePathLocks(lockPaths);
    try {
      // Preflight every participating store before installing any. A third
      // state leaves the complete intent and all existing data untouched.
      const conflicts = [];
      for (const precondition of payload.preconditions || []) {
        const current = await this.readSnapshot(precondition.path);
        if (!sameIdentity(snapshotIdentity(current), precondition.base)) {
          conflicts.push({ storeId: precondition.storeId, path: precondition.path,
            phase: recovery ? "recovery-precondition" : "commit-precondition",
            expected: precondition.base, actual: snapshotIdentity(current), txId: payload.txId });
        }
      }
      for (const condition of payload.resultConditions || []) {
        const current = await this.readSnapshot(condition.path);
        if (!sameIdentity(snapshotIdentity(current), condition.result)) {
          conflicts.push({ storeId: condition.storeId, path: condition.path,
            phase: recovery ? "recovery-result-condition" : "commit-result-condition",
            expected: condition.result, actual: snapshotIdentity(current), txId: payload.txId });
        }
      }
      for (const mutation of payload.mutations) {
        const current = await this._snapshotForMutation(mutation);
        const backup = await this._backupSnapshot(mutation, payload.txId);
        if (this._classify(current, mutation, backup.snapshot) === "third") {
          conflicts.push(await this._mutationConflict(mutation, payload.txId, recovery ? "recovery-preflight" : "commit-preflight"));
        }
      }
      if (conflicts.length) return { status: "conflict", conflicts, txId: payload.txId };

      const writes = payload.mutations.filter((mutation) => mutation.operation === "write");
      const deletes = payload.mutations.filter((mutation) => mutation.operation === "delete");
      for (const mutation of writes) {
        const result = await this._installMutation(mutation, payload.txId, { recovery });
        if (result.status === "conflict") {
          return { status: "conflict", conflicts: [result.conflict], txId: payload.txId };
        }
      }

      // Journal and summary segments remain recoverable until every canonical
      // store write and the final history batch have been re-read successfully.
      const writeVerification = [];
      for (const precondition of payload.preconditions || []) {
        const current = await this.readSnapshot(precondition.path);
        if (!sameIdentity(snapshotIdentity(current), precondition.base)) {
          writeVerification.push({ storeId: precondition.storeId, path: precondition.path,
            phase: "pre-delete-precondition", expected: precondition.base,
            actual: snapshotIdentity(current), txId: payload.txId });
        }
      }
      for (const condition of payload.resultConditions || []) {
        const current = await this.readSnapshot(condition.path);
        if (!sameIdentity(snapshotIdentity(current), condition.result)) {
          writeVerification.push({ storeId: condition.storeId, path: condition.path,
            phase: "pre-delete-result-condition", expected: condition.result,
            actual: snapshotIdentity(current), txId: payload.txId });
        }
      }
      for (const mutation of writes) {
        const current = await this._snapshotForMutation(mutation);
        if (!isResultState(current, mutation)) {
          writeVerification.push(await this._mutationConflict(mutation, payload.txId, "pre-delete-verification"));
        }
      }
      if (writeVerification.length) return { status: "conflict", conflicts: writeVerification, txId: payload.txId };

      for (const mutation of deletes) {
        const result = await this._installMutation(mutation, payload.txId, { recovery });
        if (result.status === "conflict") {
          return { status: "conflict", conflicts: [result.conflict], txId: payload.txId };
        }
      }

      const unverified = [];
      for (const condition of payload.resultConditions || []) {
        const current = await this.readSnapshot(condition.path);
        if (!sameIdentity(snapshotIdentity(current), condition.result)) {
          unverified.push({ storeId: condition.storeId, path: condition.path,
            phase: "final-result-condition", expected: condition.result,
            actual: snapshotIdentity(current), txId: payload.txId });
        }
      }
      for (const mutation of payload.mutations) {
        const current = await this._snapshotForMutation(mutation);
        if (!isResultState(current, mutation)) {
          unverified.push(await this._mutationConflict(mutation, payload.txId, "final-verification"));
        }
      }
      if (unverified.length) return { status: "conflict", conflicts: unverified, txId: payload.txId };

      // All result payloads are verified. Only tx-owned staging/backups and the
      // local intent are eligible for cleanup; user/shard files are never GC'd.
      let cleanupFailed = false;
      for (const mutation of payload.mutations) {
        for (const suffix of ["stage", "backup"]) {
          const temporaryPath = `${mutation.path}.vocab-${suffix}-${hashPathSegment(payload.txId)}`;
          try {
            await this._removeIfExists(temporaryPath);
          } catch {
            // Keep the verified local intent while any transaction-owned
            // temporary file still needs cleanup. Startup recovery can retry
            // cleanup without replaying or changing the verified result.
            cleanupFailed = true;
          }
        }
      }
      if (!cleanupFailed) {
        try { await this._removeIfExists(pendingPath); } catch { /* recovery retries from the retained intent */ }
      }
      return { status: "committed", txId: payload.txId, actionId: payload.actionId, cleanupPending: Boolean(await this.adapter.exists(pendingPath)) };
    } finally {
      release();
    }
  }

  async _listLocalPending() {
    if (typeof this.adapter.list !== "function") {
      throw new TypeError("Vault DataAdapter must implement list(path) for local transaction recovery.");
    }
    const directory = this._pendingRoot();
    if (!(await this.adapter.exists(directory))) return [];
    const found = new Set();
    const visited = new Set();
    const visit = async (folder) => {
      if (visited.has(folder) || !(await this.adapter.exists(folder))) return;
      visited.add(folder);
      const listing = await this.adapter.list(folder);
      for (const path of Array.isArray(listing?.files) ? listing.files : []) {
        if (typeof path === "string" && path.startsWith(`${directory}/`) &&
            path.slice(path.lastIndexOf("/") + 1) !== "summary.pending.json" &&
            /^[A-Za-z0-9_-]{1,128}\.pending\.json$/.test(path.slice(path.lastIndexOf("/") + 1))) found.add(path);
      }
      for (const child of Array.isArray(listing?.folders) ? listing.folders : []) {
        if (typeof child === "string" && child.startsWith(`${directory}/`)) await visit(child);
      }
    };
    await visit(directory);
    return [...found].sort();
  }

  async recoverLocal() {
    const files = await this._listLocalPending();
    const recovered = [];
    const conflicts = [];
    for (const path of files) {
      let payload;
      try {
        const text = await this.adapter.read(path);
        payload = this._decodeIntent(text, path);
        if (path !== this._pendingPath(payload.txId, payload.sessionId)) {
          throw codedError("VOCAB_TX_INTENT_PATH_MISMATCH", `Pending transaction path did not match its local identity: ${path}`);
        }
      } catch (error) {
        const scopes = await this._extractSafeIntentScopes(path).catch(() => []);
        if (scopes.length) conflicts.push(...scopes.map((scope) => ({ ...scope, phase: "intent-validation", code: error.code || "VOCAB_TX_INTENT_INVALID", message: error.message })));
        else conflicts.push({ storeId: null, path, phase: "intent-validation", diagnosticOnly: true, code: error.code || "VOCAB_TX_INTENT_INVALID", message: error.message });
        continue;
      }
      const result = await this._finishIntent(payload, path, { recovery: true });
      if (result.status === "committed") recovered.push({ txId: payload.txId, actionId: payload.actionId });
      else conflicts.push(...result.conflicts);
    }
    return { status: conflicts.length ? "conflict" : (recovered.length ? "recovered" : "clean"), recovered, conflicts };
  }

  async _extractSafeIntentScopes(path) {
    const text = await this.adapter.read(path);
    let envelope;
    try { envelope = JSON.parse(text); } catch { return []; }
    const mutations = envelope?.payload?.mutations;
    if (!Array.isArray(mutations)) return [];
    const scopes = [];
    for (const mutation of mutations) {
      try {
        const safePath = normalizePath(mutation.path, this.root);
        if (typeof mutation.storeId !== "string" || !mutation.storeId || mutation.storeId.length > 128) continue;
        if (mutation.operation !== "write" && mutation.operation !== "delete") continue;
        scopes.push({ storeId: mutation.storeId, path: safePath });
      } catch {
        // Untrusted intent metadata is diagnostic only; it is never replayed.
      }
    }
    return scopes;
  }

  async _preflight(mutations, txId) {
    const conflicts = [];
    const states = [];
    for (const mutation of mutations) {
      const current = await this._snapshotForMutation(mutation);
      if (isBaseState(current, mutation)) states.push({ mutation, state: "base" });
      else if (isResultState(current, mutation)) states.push({ mutation, state: "result" });
      else conflicts.push(await this._mutationConflict(mutation, txId, "commit-preflight"));
    }
    return { conflicts, states };
  }

  async _commit(input, { allowInternal = false, extraLockPaths = [], alreadyLockedPaths = [] } = {}) {
    if (!input || typeof input !== "object") throw new TypeError("A vocabulary transaction payload is required.");
    const actionId = safeIdentity(input.actionId, "transaction action ID");
    const transactionSessionId = safePathIdentity(input.sessionId || this.sessionId, "transaction session ID");
    if (!Array.isArray(input.writes || [])) throw new TypeError("Vocabulary transaction writes must be an array.");
    if (!Array.isArray(input.deletes || [])) throw new TypeError("Vocabulary transaction deletes must be an array.");
    const writes = (input.writes || []).map((write) => normalizeWrite(write, this.root, { allowInternal }));
    const deletes = (input.deletes || []).map((item) => normalizeDelete(item, this.root, { allowInternal }));
    if (!Array.isArray(input.preconditions || [])) throw new TypeError("Vocabulary transaction preconditions must be an array.");
    const preconditions = (input.preconditions || []).map((item) => normalizePrecondition(item, this.root));
    const seen = new Set();
    for (const mutation of [...writes, ...deletes]) {
      if (seen.has(mutation.path)) throw codedError("VOCAB_TX_DUPLICATE_PATH", `A transaction cannot mutate ${mutation.path} more than once.`);
      seen.add(mutation.path);
    }

    for (const condition of preconditions) {
      if (seen.has(condition.path)) {
        throw codedError("VOCAB_TX_PRECONDITION_OVERLAP", `A transaction cannot require an unchanged precondition for mutated path ${condition.path}.`);
      }
    }
    const txId = safeTransactionId(this.makeId());
    let historySummary = input.historySummary || null;
    if (historySummary !== null) {
      if (!this.history) throw codedError("VOCAB_TX_HISTORY_UNAVAILABLE", "A history summary requires an attached VocabularyHistory instance.");
      if (historySummary.deviceId !== undefined && historySummary.deviceId !== this.deviceId) {
        throw codedError("VOCAB_TX_HISTORY_DEVICE_MISMATCH", "A history batch cannot be written under another device identity.");
      }
      historySummary = {
        ...historySummary,
        batchId: historySummary.batchId || `history-${actionId}`,
        sessionId: historySummary.sessionId || transactionSessionId,
        deviceId: this.deviceId,
        transactionId: txId,
      };
      canonicalStringify(historySummary);
      if (!Array.isArray(historySummary.stores) || !historySummary.stores.length) {
        throw codedError("VOCAB_TX_HISTORY_STORES_REQUIRED", "A history batch must identify every canonical store path it verifies.");
      }
    }

    // Recover only this device's pending work. An unrelated store conflict does
    // not block this transaction; an overlapping store conflict does.
    const recovery = await this.recoverLocal();
    const intendedStores = new Set([...writes, ...deletes].map((item) => item.storeId));
    if (historySummary?.stores) for (const item of historySummary.stores) intendedStores.add(item.storeId);
    for (const item of preconditions) intendedStores.add(item.storeId);
    const intendedPaths = new Set([...writes, ...deletes].map((item) => item.path));
    for (const item of preconditions) intendedPaths.add(item.path);
    const relevantRecoveryConflicts = recovery.conflicts.filter((item) =>
      !item.diagnosticOnly && (intendedStores.has(item.storeId) || intendedPaths.has(item.path)));
    if (relevantRecoveryConflicts.length) return { status: "conflict", conflicts: relevantRecoveryConflicts, txId };

    const historyPath = historySummary ? this.history.pathFor(historySummary.batchId) : null;
    const alreadyLocked = new Set(alreadyLockedPaths);
    const historyStoreEntries = [];
    const resultConditions = [];
    if (historySummary) {
      const storePairs = new Set();
      for (const store of historySummary.stores) {
        const path = normalizePath(store?.path, this.root);
        if (typeof store?.storeId !== "string" || !store.storeId || store.storeId.length > 128) {
          throw codedError("VOCAB_TX_STORE_ID_INVALID", `A history store ID is required for ${path}.`);
        }
        const pair = `${store.storeId}\u0000${path}`;
        if (storePairs.has(pair)) throw codedError("VOCAB_TX_HISTORY_STORE_DUPLICATE", `History repeats store path ${path}.`);
        storePairs.add(pair);
        historyStoreEntries.push({ ...store, path });
      }
      for (const mutation of [...writes, ...deletes]) {
        if (isInternalPath(mutation.path)) continue;
        if (!storePairs.has(`${mutation.storeId}\u0000${mutation.path}`)) {
          throw codedError("VOCAB_TX_HISTORY_STORE_MISSING", `History does not cover canonical mutation ${mutation.path}.`);
        }
      }
    }
    const lockPaths = [
      ...seen,
      ...preconditions.map((item) => item.path),
      ...historyStoreEntries.map((item) => item.path),
      ...(historyPath ? [historyPath] : []),
      ...extraLockPaths,
    ].filter((path) => !alreadyLocked.has(path));
    if (!lockPaths.length && !preconditions.length && !historyStoreEntries.length) return { status: "noop", txId, actionId };
    const release = lockPaths.length ? await this._acquirePathLocks(lockPaths) : () => undefined;
    try {
      const mutations = [...writes, ...deletes];
      const mutationsByPath = new Map(mutations.map((mutation) => [mutation.path, mutation]));
      for (const store of historyStoreEntries) {
        const baseRevision = store.baseRevision;
        const resultRevision = store.resultRevision;
        const baseHash = store.baseHash;
        const resultHash = store.resultHash;
        if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || !Number.isSafeInteger(resultRevision) || resultRevision <= baseRevision ||
            (baseHash !== null && !/^sha256-v1:[a-f0-9]{64}$/.test(baseHash || "")) ||
            (baseRevision > 0 && baseHash === null) ||
            !/^sha256-v1:[a-f0-9]{64}$/.test(resultHash || "")) {
          throw codedError("VOCAB_TX_HISTORY_STORE_STATE_INVALID", `History base/result state is invalid for ${store.path}.`);
        }
        const mutation = mutationsByPath.get(store.path);
        if (mutation) {
          if (mutation.operation !== "write" || mutation.storeId !== store.storeId ||
              mutation.result.revision !== resultRevision || mutation.result.hash !== resultHash || baseRevision > mutation.base.revision ||
              (baseRevision === mutation.base.revision && baseHash !== mutation.base.hash)) {
            throw codedError("VOCAB_TX_HISTORY_STORE_STATE_MISMATCH", `History base/result state does not match the transaction for ${store.path}.`);
          }
        } else {
          const current = await this.readSnapshot(store.path);
          const expected = { exists: true, revision: resultRevision, hash: resultHash };
          if (!sameIdentity(snapshotIdentity(current), expected)) {
            return { status: "conflict", txId, conflicts: [{ storeId: store.storeId, path: store.path,
              phase: "history-result-state", expected, actual: snapshotIdentity(current) }] };
          }
          resultConditions.push({ path: store.path, storeId: store.storeId,
            result: { exists: true, revision: resultRevision, hash: resultHash } });
        }
      }
      if (historySummary) {
        const historySnapshot = await this.readSnapshot(historyPath);
        const historyMutation = await this.history.prepareRecordBatch(historySummary, historySnapshot);
        if (historyMutation) {
          const normalizedHistory = normalizeWrite(historyMutation, this.root, { allowInternal: true });
          if (seen.has(normalizedHistory.path)) throw codedError("VOCAB_TX_DUPLICATE_PATH", "The transaction cannot directly mutate its history batch file.");
          mutations.push(normalizedHistory);
          seen.add(normalizedHistory.path);
        }
      }
      if (!mutations.length) {
        const conflicts = [];
        for (const precondition of preconditions) {
          const current = await this.readSnapshot(precondition.path);
          if (!sameIdentity(snapshotIdentity(current), precondition.base)) {
            conflicts.push({ storeId: precondition.storeId, path: precondition.path, phase: "commit-precondition",
              expected: precondition.base, actual: snapshotIdentity(current), txId });
          }
        }
        for (const condition of resultConditions) {
          const current = await this.readSnapshot(condition.path);
          const expected = condition.result;
          if (!sameIdentity(snapshotIdentity(current), expected)) {
            conflicts.push({ storeId: condition.storeId, path: condition.path, phase: "history-result-state",
              expected, actual: snapshotIdentity(current), txId });
          }
        }
        return conflicts.length ? { status: "conflict", conflicts, txId } : { status: "noop", txId, actionId };
      }
      const preflight = await this._preflight(mutations, txId);
      if (preflight.conflicts.length) return { status: "conflict", conflicts: preflight.conflicts, txId };
      const preconditionConflicts = [];
      for (const precondition of preconditions) {
        const current = await this.readSnapshot(precondition.path);
        if (!sameIdentity(snapshotIdentity(current), precondition.base)) {
          preconditionConflicts.push({ storeId: precondition.storeId, path: precondition.path,
            phase: "commit-precondition", expected: precondition.base,
            actual: snapshotIdentity(current), txId });
        }
      }
      for (const condition of resultConditions) {
        const current = await this.readSnapshot(condition.path);
        if (!sameIdentity(snapshotIdentity(current), condition.result)) {
          preconditionConflicts.push({ storeId: condition.storeId, path: condition.path,
            phase: "history-result-state", expected: condition.result,
            actual: snapshotIdentity(current), txId });
        }
      }
      if (preconditionConflicts.length) return { status: "conflict", conflicts: preconditionConflicts, txId };
      if (preflight.states.every(({ state }) => state === "result")) {
        return { status: "committed", txId, actionId, idempotent: true, cleanupPending: false };
      }

      const createdAt = this.now();
      const payload = {
        schemaVersion: 1,
        kind: "vocabulary-transaction",
        deviceId: this.deviceId,
        sessionId: transactionSessionId,
        txId,
        actionId,
        createdAt: Number.isFinite(createdAt) ? createdAt : String(createdAt),
        entities: input.entities || [],
        historySummary,
        preconditions,
        resultConditions,
        mutations,
      };
      canonicalStringify(payload);
      const pendingPath = this._pendingPath(txId, transactionSessionId);
      await this._writeVerified(pendingPath, this._intentEnvelope(payload));
      // The intent now contains every verified result payload. No ACK is
      // returned until every store has been re-read and matched to its result.
      const result = await this._finishIntent(payload, pendingPath, { locked: true });
      if (result.status === "conflict") return result;
      return result;
    } finally {
      release();
    }
  }

  commit(input) {
    return this._commit(input, { allowInternal: false });
  }

  async commitOrThrow(input) {
    const result = await this.commit(input);
    if (result.status === "conflict") {
      throw codedError("VOCAB_TX_CONFLICT", "Vocabulary data changed outside this transaction; no conflicting store was overwritten.", result);
    }
    return result;
  }

  _journalSegmentText(sessionId, index, actions) {
    const revision = actions.at(-1)?.sequence || 0;
    const payload = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      kind: JOURNAL_KIND,
      deviceId: this.deviceId,
      sessionId,
      index,
      revision,
      actions,
    };
    return canonicalStringify({ revision, payload, payloadHash: canonicalHash(payload) });
  }

  _journalLineText(sessionId, index, action) {
    const payload = {
      schemaVersion: JOURNAL_LINE_SCHEMA_VERSION,
      kind: JOURNAL_LINE_KIND,
      deviceId: this.deviceId,
      sessionId,
      index,
      sequence: action.sequence,
      actionId: action.actionId,
      payload: action.payload,
    };
    return `${canonicalStringify({ payload, payloadHash: canonicalHash(payload) })}\n`;
  }

  _decodeJournalLines(text, path, sessionId, index) {
    const byteLength = utf8Length(text);
    if (byteLength > JOURNAL_SEGMENT_LIMIT) {
      throw codedError("VOCAB_JOURNAL_SEGMENT_LIMIT", `Review action segment exceeds 64 KiB at ${path}.`);
    }
    const actions = [];
    let validBytes = 0;
    let damaged = false;
    const lines = text.split("\n");
    const hasTerminalNewline = text.endsWith("\n");
    const completeLineCount = text.length === 0 ? 0 : lines.length - 1;
    for (let lineIndex = 0; lineIndex < completeLineCount; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line) throw codedError("VOCAB_JOURNAL_INVALID", `Review action line is empty at ${path}:${lineIndex + 1}.`);
      let envelope;
      try { envelope = JSON.parse(line); }
      catch { throw codedError("VOCAB_JOURNAL_INVALID", `Review action line is malformed at ${path}:${lineIndex + 1}.`); }
      const item = envelope?.payload;
      if (!item || canonicalStringify(envelope) !== line || envelope.payloadHash !== canonicalHash(item) ||
          item.schemaVersion !== JOURNAL_LINE_SCHEMA_VERSION || item.kind !== JOURNAL_LINE_KIND ||
          item.deviceId !== this.deviceId || item.sessionId !== sessionId || item.index !== index ||
          !Number.isSafeInteger(item.sequence) || item.sequence < 1 || typeof item.actionId !== "string" || !item.actionId ||
          !Object.hasOwn(item, "payload") ||
          (actions.length > 0 && item.sequence !== actions.at(-1).sequence + 1)) {
        throw codedError("VOCAB_JOURNAL_INVALID", `Review action line failed integrity or metadata verification at ${path}:${lineIndex + 1}.`);
      }
      try { canonicalStringify(item.payload); }
      catch { throw codedError("VOCAB_JOURNAL_INVALID", `Review action payload is not canonical data at ${path}:${lineIndex + 1}.`); }
      actions.push({ sequence: item.sequence, actionId: item.actionId, payload: item.payload });
      validBytes += utf8Length(line) + 1;
    }
    // Only the final non-newline-terminated bytes can be an interrupted,
    // unacknowledged append. Complete rows are either verified above or fail closed.
    if (!hasTerminalNewline && text.length > 0) damaged = true;
    return {
      format: "jsonl-v2",
      index,
      path,
      revision: actions.at(-1)?.sequence || 0,
      actions,
      text,
      byteLength,
      damaged,
      validBytes,
    };
  }

  _decodeJournalSegment(text, path, sessionId, index) {
    if (utf8Length(text) > JOURNAL_SEGMENT_LIMIT) {
      throw codedError("VOCAB_JOURNAL_SEGMENT_LIMIT", `Review action segment exceeds 64 KiB at ${path}.`);
    }
    let envelope;
    try { envelope = JSON.parse(text); }
    catch { throw codedError("VOCAB_JOURNAL_INVALID", `Review action segment is malformed at ${path}.`); }
    const payload = envelope?.payload;
    if (!payload || canonicalStringify(envelope) !== text || envelope.payloadHash !== canonicalHash(payload) ||
        envelope.revision !== payload.revision || payload.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
        payload.kind !== JOURNAL_KIND || payload.deviceId !== this.deviceId || payload.sessionId !== sessionId ||
        payload.index !== index || !Array.isArray(payload.actions) || payload.actions.length === 0 ||
        (path !== this._journalPath(sessionId, index) && path !== this._journalBackupPath(sessionId, index))) {
      throw codedError("VOCAB_JOURNAL_INVALID", `Review action segment failed verification at ${path}.`);
    }
    const actions = [];
    for (const item of payload.actions) {
      if (!item || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || typeof item.actionId !== "string" || !item.actionId ||
          !Object.hasOwn(item, "payload")) {
        throw codedError("VOCAB_JOURNAL_INVALID", `Review action metadata failed verification at ${path}.`);
      }
      canonicalStringify(item.payload);
      if (actions.length && item.sequence !== actions.at(-1).sequence + 1) {
        throw codedError("VOCAB_JOURNAL_SEQUENCE_INVALID", `Review action sequence is incomplete at ${path}.`);
      }
      actions.push({ sequence: item.sequence, actionId: item.actionId, payload: item.payload });
    }
    if (payload.revision !== actions.at(-1).sequence) {
      throw codedError("VOCAB_JOURNAL_INVALID", `Review segment revision did not match its verified action prefix at ${path}.`);
    }
    return { format: "packed-json-v1", index, path, revision: payload.revision, actions, text, byteLength: utf8Length(text), damaged: false };
  }

  async readJournalActions(sessionId = this.sessionId) {
    const safeSession = safePathIdentity(sessionId, "review session ID");
    const directory = this._sessionRoot(safeSession);
    if (!(await this.adapter.exists(directory))) return { actions: [], hash: null, revision: 0, paths: [], cleanupPaths: [], segments: [], highestIndex: -1, recoveryEvidence: [], directory };
    if (typeof this.adapter.list !== "function") throw new TypeError("Vault DataAdapter must implement list(path) for review journal reads.");
    const listing = await this.adapter.list(directory);
    const indices = new Map();
    for (const path of Array.isArray(listing?.files) ? listing.files : []) {
      if (typeof path !== "string" || !path.startsWith(`${directory}/`)) continue;
      const leaf = path.slice(directory.length + 1);
      const legacyMatch = /^review-(\d{6})\.segment\.json(?:\.backup)?$/.exec(leaf);
      const lineMatch = /^review-(\d{6})\.jsonl$/.exec(leaf);
      const match = legacyMatch || lineMatch;
      if (match) {
        const index = Number(match[1]);
        const entry = indices.get(index) || { legacy: false, jsonl: false };
        if (legacyMatch) entry.legacy = true;
        if (lineMatch) entry.jsonl = true;
        indices.set(index, entry);
      }
    }
    const segments = [];
    const cleanupPaths = [];
    const recoveryEvidence = [];
    for (const index of [...indices.keys()].sort((a, b) => a - b)) {
      const formats = indices.get(index);
      if (formats.legacy && formats.jsonl) {
        throw codedError("VOCAB_JOURNAL_FORMAT_COLLISION", `Review journal index ${index} has both packed and JSONL files.`);
      }
      if (formats.jsonl) {
        const path = this._journalLinePath(safeSession, index);
        const decoded = this._decodeJournalLines(await this.adapter.read(path), path, safeSession, index);
        segments.push(decoded);
        if (decoded.damaged) recoveryEvidence.push(path);
        else cleanupPaths.push(path);
        continue;
      }
      const activePath = this._journalPath(safeSession, index);
      const backupPath = this._journalBackupPath(safeSession, index);
      const activeExists = await this.adapter.exists(activePath);
      const backupExists = await this.adapter.exists(backupPath);
      let active = null;
      let backup = null;
      let activeError = null;
      if (activeExists) {
        try { active = this._decodeJournalSegment(await this.adapter.read(activePath), activePath, safeSession, index); }
        catch (error) { activeError = error; }
      }
      if (backupExists) {
        try { backup = this._decodeJournalSegment(await this.adapter.read(backupPath), backupPath, safeSession, index); }
        catch { recoveryEvidence.push(backupPath); }
      }
      if (active) {
        segments.push(active);
        cleanupPaths.push(activePath);
        if (backup) cleanupPaths.push(backupPath);
        else if (backupExists) recoveryEvidence.push(backupPath);
      } else if (backup) {
        segments.push(backup);
        cleanupPaths.push(backupPath);
        recoveryEvidence.push(activePath);
      } else if (activeError) {
        throw activeError;
      }
    }
    segments.sort((left, right) => left.index - right.index);
    const actions = [];
    let nextSequence = 1;
    for (const segment of segments) {
      if (segment.actions.length === 0) continue;
      if (segment.actions[0].sequence !== nextSequence) {
        throw codedError("VOCAB_JOURNAL_SEQUENCE_INVALID", `Review action sequence is incomplete in ${directory}.`);
      }
      for (const action of segment.actions) {
        if (action.sequence !== nextSequence) throw codedError("VOCAB_JOURNAL_SEQUENCE_INVALID", `Review action sequence is incomplete in ${directory}.`);
        actions.push(action);
        nextSequence += 1;
      }
    }
    const actionIds = new Set();
    for (const action of actions) {
      if (actionIds.has(action.actionId)) throw codedError("VOCAB_JOURNAL_ACTION_DUPLICATE", `Review action ID ${action.actionId} appears in more than one durable sequence.`);
      actionIds.add(action.actionId);
    }
    return {
      actions,
      hash: actions.length ? hashText(canonicalStringify(actions)) : null,
      revision: actions.length,
      paths: segments.map(({ path }) => path),
      cleanupPaths: [...new Set(cleanupPaths)],
      segments,
      highestIndex: indices.size ? Math.max(...indices.keys()) : -1,
      recoveryEvidence: [...new Set(recoveryEvidence)],
      directory,
    };
  }

  async _appendJournalLine(sessionId, journal, action) {
    if (typeof this.adapter.append !== "function") {
      throw codedError("VOCAB_JOURNAL_APPEND_UNAVAILABLE", "The native journal append path is unavailable for this adapter.");
    }
    const last = journal.segments.at(-1);
    let index = journal.highestIndex < 0 ? 0 : journal.highestIndex + 1;
    let path;
    let text = "";
    if (last?.format === "jsonl-v2" && !last.damaged) {
      const candidate = this._journalLineText(sessionId, last.index, action);
      if (last.byteLength + utf8Length(candidate) <= JOURNAL_SEGMENT_LIMIT) {
        index = last.index;
        path = last.path;
        text = candidate;
      }
    }
    if (!path) {
      path = this._journalLinePath(sessionId, index);
      text = this._journalLineText(sessionId, index, action);
    }
    if (utf8Length(text) > JOURNAL_SEGMENT_LIMIT) {
      throw codedError("VOCAB_JOURNAL_SEGMENT_LIMIT", "A review action must fit within a 64 KiB journal segment.");
    }
    await this._ensureParent(path);
    if (!(await this.adapter.exists(path))) await this.adapter.write(path, "");
    await this.adapter.append(path, text);
    const updated = await this.readJournalActions(sessionId);
    const persisted = updated.actions.find((item) => item.actionId === action.actionId);
    if (!persisted || persisted.sequence !== action.sequence || !deepEqual(persisted.payload, action.payload)) {
      throw codedError("VOCAB_JOURNAL_APPEND_UNVERIFIED", `The appended review action was not verified at ${path}.`);
    }
    return { status: "committed", actionId: action.actionId, revision: action.sequence, hash: updated.hash, paths: updated.paths, cleanupPaths: updated.cleanupPaths };
  }

  async _repairJournalSegment(sessionId, segment) {
    const activePath = this._journalPath(sessionId, segment.index);
    const backupPath = this._journalBackupPath(sessionId, segment.index);
    if (segment.path === activePath) return;
    if (await this.adapter.exists(activePath)) {
      const damagedText = await this.adapter.read(activePath);
      const evidencePath = `${activePath}.corrupt-${hashPathSegment(damagedText)}`;
      if (await this.adapter.exists(evidencePath)) {
        throw codedError("VOCAB_JOURNAL_RECOVERY_REQUIRED", `Damaged journal evidence already exists at ${evidencePath}.`);
      }
      await this.adapter.rename(activePath, evidencePath);
    }
    if (!(await this.adapter.exists(backupPath))) {
      throw codedError("VOCAB_JOURNAL_RECOVERY_REQUIRED", `Verified journal backup disappeared at ${backupPath}.`);
    }
    await this.adapter.rename(backupPath, activePath);
    this._decodeJournalSegment(await this.adapter.read(activePath), activePath, sessionId, segment.index);
  }

  async _preserveDamagedJournalLineSegment(segment) {
    if (segment?.format !== "jsonl-v2" || !segment.damaged || typeof segment.text !== "string") {
      throw codedError("VOCAB_JOURNAL_RECOVERY_REQUIRED", "Only a verified JSONL segment with an unacknowledged trailing fragment can be archived as evidence.");
    }
    const evidencePath = `${segment.path}.evidence-${hashPathSegment(segment.text)}`;
    if (await this.adapter.exists(evidencePath)) {
      if (await this.adapter.read(evidencePath) !== segment.text) {
        throw codedError("VOCAB_JOURNAL_RECOVERY_REQUIRED", `Preserved journal evidence does not match its damaged source at ${evidencePath}.`);
      }
    } else {
      await this._writeVerified(evidencePath, segment.text);
    }
    return evidencePath;
  }

  async appendJournalAction({ sessionId = this.sessionId, actionId, payload, expectedSequence } = {}) {
    const safeSession = safePathIdentity(sessionId, "review session ID");
    const safeAction = safeIdentity(actionId, "review action ID");
    if (expectedSequence !== undefined && (!Number.isSafeInteger(expectedSequence) || expectedSequence < 1)) {
      throw codedError("VOCAB_JOURNAL_SEQUENCE_EXPECTED_INVALID", "An expected review journal sequence must be a positive safe integer.");
    }
    canonicalStringify(payload);
    const sessionLock = this._sessionLockPath(safeSession);
    const release = await this._acquirePathLocks([sessionLock]);
    try {
      let journal = await this.readJournalActions(safeSession);
      const existing = journal.actions.find((item) => item.actionId === safeAction);
      if (existing) {
        if (deepEqual(existing.payload, payload)) return { status: "unchanged", actionId: safeAction, revision: existing.sequence, hash: journal.hash, paths: journal.paths };
        return { status: "conflict", conflicts: [{ storeId: "review-journal", path: journal.directory, phase: "action-id-reuse", actionId: safeAction }] };
      }
      if (expectedSequence !== undefined && expectedSequence !== journal.actions.length + 1) {
        return { status: "conflict", conflicts: [{ storeId: "review-journal", path: journal.directory,
          phase: "action-sequence-mismatch", expectedSequence, actualSequence: journal.actions.length + 1 }] };
      }
      if (journal.actions.length >= MAX_JOURNAL_ACTIONS) {
        throw codedError("VOCAB_JOURNAL_LIMIT", "The review session has exceeded its durable action limit.");
      }
      for (const segment of journal.segments) {
        if (segment.format === "packed-json-v1" && segment.path !== this._journalPath(safeSession, segment.index)) {
          await this._repairJournalSegment(safeSession, segment);
        }
      }
      journal = await this.readJournalActions(safeSession);
      const rereadExisting = journal.actions.find((item) => item.actionId === safeAction);
      if (rereadExisting) {
        if (deepEqual(rereadExisting.payload, payload)) {
          return { status: "unchanged", actionId: safeAction, revision: rereadExisting.sequence, hash: journal.hash, paths: journal.paths };
        }
        return { status: "conflict", conflicts: [{ storeId: "review-journal", path: journal.directory,
          phase: "action-id-reuse", actionId: safeAction }] };
      }
      if (expectedSequence !== undefined && expectedSequence !== journal.actions.length + 1) {
        return { status: "conflict", conflicts: [{ storeId: "review-journal", path: journal.directory,
          phase: "action-sequence-mismatch", expectedSequence, actualSequence: journal.actions.length + 1 }] };
      }
      const sequence = journal.actions.length + 1;
      const action = { sequence, actionId: safeAction, payload };
      if (typeof this.adapter.append === "function") {
        return await this._appendJournalLine(safeSession, journal, action);
      }
      if (journal.segments.some((segment) => segment.format === "jsonl-v2")) {
        throw codedError("VOCAB_JOURNAL_APPEND_UNAVAILABLE", "This adapter cannot continue a journal previously written through native append.");
      }
      const last = journal.segments.at(-1);
      let index = last?.index ?? 0;
      let segmentActions = last ? [...last.actions, action] : [action];
      let text = this._journalSegmentText(safeSession, index, segmentActions);
      if (last && utf8Length(text) > JOURNAL_SEGMENT_LIMIT) {
        index += 1;
        segmentActions = [action];
        text = this._journalSegmentText(safeSession, index, segmentActions);
      }
      if (utf8Length(text) > JOURNAL_SEGMENT_LIMIT) {
        throw codedError("VOCAB_JOURNAL_SEGMENT_LIMIT", "A review action must fit within a 64 KiB journal segment.");
      }
      const path = this._journalPath(safeSession, index);
      const backupPath = this._journalBackupPath(safeSession, index);
      const stagePath = `${path}.stage`;
      if (await this.adapter.exists(backupPath)) {
        // An active segment was already verified above; a prior verified backup
        // is no longer needed once the active copy is present and readable.
        if (!(await this.adapter.exists(path))) {
          const backup = this._decodeJournalSegment(await this.adapter.read(backupPath), backupPath, safeSession, index);
          await this._repairJournalSegment(safeSession, backup);
        } else {
          this._decodeJournalSegment(await this.adapter.read(path), path, safeSession, index);
          await this._removeIfExists(backupPath);
        }
      }
      if (await this.adapter.exists(stagePath)) {
        if (await this.adapter.read(stagePath) !== text) {
          return { status: "conflict", conflicts: [{ storeId: "review-journal", path: stagePath, phase: "interrupted-stage-evidence" }] };
        }
      } else {
        await this._writeVerified(stagePath, text);
      }
      if (await this.adapter.exists(path)) {
        if (await this.adapter.exists(backupPath)) {
          return { status: "conflict", conflicts: [{ storeId: "review-journal", path: backupPath, phase: "backup-collision" }] };
        }
        this._decodeJournalSegment(await this.adapter.read(path), path, safeSession, index);
        await this.adapter.rename(path, backupPath);
      }
      if (await this.adapter.exists(path)) {
        return { status: "conflict", conflicts: [{ storeId: "review-journal", path, phase: "active-path-recreated" }] };
      }
      await this.adapter.rename(stagePath, path);
      const persisted = await this.adapter.read(path);
      const verified = this._decodeJournalSegment(persisted, path, safeSession, index);
      if (persisted !== text || verified.actions.at(-1).actionId !== safeAction) {
        return { status: "conflict", conflicts: [{ storeId: "review-journal", path, phase: "append-verification" }] };
      }
      await this._removeIfExists(backupPath);
      const updated = await this.readJournalActions(safeSession);
      return { status: "committed", actionId: safeAction, revision: sequence, hash: updated.hash, paths: updated.paths, cleanupPaths: updated.cleanupPaths };
    } finally {
      release();
    }
  }

  async _readSessionSummary(sessionId) {
    const safeSession = safePathIdentity(sessionId, "review session ID");
    const manifestPath = this._summaryManifestPath(safeSession);
    const snapshot = await this.readSnapshot(manifestPath);
    if (!snapshot.exists) return { exists: false, summary: null, hash: null, revision: 0, paths: [], manifestPath };
    const manifest = snapshot.value;
    if (canonicalStringify(manifest) !== snapshot.text || manifest.schemaVersion !== 1 ||
        manifest.kind !== "vocabulary-review-summary" || manifest.deviceId !== this.deviceId ||
        manifest.sessionId !== safeSession || !Number.isSafeInteger(manifest.revision) || manifest.revision !== snapshot.revision ||
        !Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0 || manifest.byteLength > SUMMARY_MAX_BYTES ||
        !/^sha256-v1:[a-f0-9]{64}$/.test(manifest.summaryHash || "") || !Array.isArray(manifest.segments)) {
      throw codedError("VOCAB_SUMMARY_INVALID", `Review summary manifest failed verification at ${manifestPath}.`);
    }
    const expectedCount = Math.ceil(manifest.byteLength / (SUMMARY_CHUNK_BYTES + 4)) || 1;
    if (manifest.segments.length < 1 || manifest.segments.length > expectedCount + 1) {
      throw codedError("VOCAB_SUMMARY_SEGMENT_COUNT", `Review summary segment count is invalid at ${manifestPath}.`);
    }
    const pieces = [];
    const paths = [manifestPath];
    for (let index = 0; index < manifest.segments.length; index += 1) {
      const entry = manifest.segments[index];
      const expectedPath = `${this._sessionRoot(safeSession)}/summary-${manifest.revision}-${index}.segment.json`;
      if (!entry || entry.index !== index || entry.path !== expectedPath ||
          !/^sha256-v1:[a-f0-9]{64}$/.test(entry.hash || "") || !Number.isSafeInteger(entry.byteLength) ||
          entry.byteLength < 1 || entry.byteLength > SUMMARY_SEGMENT_LIMIT || !(await this.adapter.exists(entry.path))) {
        throw codedError("VOCAB_SUMMARY_SEGMENT_INVALID", `Review summary segment reference is invalid at ${manifestPath}.`);
      }
      const text = await this.adapter.read(entry.path);
      if (utf8Length(text) !== entry.byteLength || hashText(text) !== entry.hash || utf8Length(text) > SUMMARY_SEGMENT_LIMIT) {
        throw codedError("VOCAB_SUMMARY_SEGMENT_INVALID", `Review summary segment failed integrity verification at ${entry.path}.`);
      }
      let segment;
      try { segment = JSON.parse(text); }
      catch { throw codedError("VOCAB_SUMMARY_SEGMENT_INVALID", `Review summary segment is malformed at ${entry.path}.`); }
      if (canonicalStringify(segment) !== text || segment.schemaVersion !== 1 ||
          segment.kind !== "vocabulary-review-summary-segment" || segment.deviceId !== this.deviceId ||
          segment.sessionId !== safeSession || segment.revision !== 1 || segment.generation !== manifest.revision ||
          segment.index !== index || segment.count !== manifest.segments.length || typeof segment.data !== "string") {
        throw codedError("VOCAB_SUMMARY_SEGMENT_INVALID", `Review summary segment metadata is invalid at ${entry.path}.`);
      }
      pieces.push(segment.data);
      paths.push(entry.path);
    }
    const text = pieces.join("");
    if (utf8Length(text) !== manifest.byteLength || hashText(text) !== manifest.summaryHash) {
      throw codedError("VOCAB_SUMMARY_HASH_MISMATCH", `Review summary content hash did not verify at ${manifestPath}.`);
    }
    let summary;
    try { summary = JSON.parse(text); }
    catch { throw codedError("VOCAB_SUMMARY_INVALID", `Review summary JSON is malformed at ${manifestPath}.`); }
    if (canonicalStringify(summary) !== text || summary.sessionId !== safeSession) {
      throw codedError("VOCAB_SUMMARY_INVALID", `Review summary identity or canonical content did not verify at ${manifestPath}.`);
    }
    return { exists: true, summary, hash: snapshot.hash, revision: snapshot.revision, paths, manifestPath };
  }

  async readSessionSummary(sessionId = this.sessionId) {
    const safeSession = safePathIdentity(sessionId, "review session ID");
    const release = await this._acquirePathLocks([this._sessionLockPath(safeSession)]);
    try { return await this._readSessionSummary(safeSession); }
    finally { release(); }
  }

  async _summaryMutations(sessionId, summary, prior, { allowSequenceAdvance = false } = {}) {
    if (!summary || typeof summary !== "object" || Array.isArray(summary) || summary.sessionId !== sessionId) {
      throw codedError("VOCAB_SUMMARY_INVALID", "A review summary must identify its session.");
    }
    canonicalStringify(summary);
    const priorSequence = prior.summary?.flushedThroughSequence ?? 0;
    const nextSequence = summary.flushedThroughSequence ?? 0;
    if (!Number.isSafeInteger(nextSequence) || nextSequence < 0 || nextSequence < priorSequence ||
        (!allowSequenceAdvance && nextSequence !== priorSequence)) {
      throw codedError("VOCAB_SUMMARY_SEQUENCE_INVALID", "Only a canonical flush may advance flushedThroughSequence.");
    }
    const content = canonicalStringify(summary);
    const byteLength = utf8Length(content);
    if (byteLength > SUMMARY_MAX_BYTES) throw codedError("VOCAB_SUMMARY_LIMIT", "The pending review summary exceeds 16 MiB.");
    const dataChunks = splitUtf8Text(content, SUMMARY_CHUNK_BYTES);
    const revision = prior.revision + 1;
    const segmentWrites = dataChunks.map((data, index) => {
      const path = `${this._sessionRoot(sessionId)}/summary-${revision}-${index}.segment.json`;
      const segmentText = canonicalStringify({
        schemaVersion: 1,
        kind: "vocabulary-review-summary-segment",
        deviceId: this.deviceId,
        sessionId,
        revision: 1,
        generation: revision,
        index,
        count: dataChunks.length,
        data,
      });
      const segmentBytes = utf8Length(segmentText);
      if (segmentBytes > SUMMARY_SEGMENT_LIMIT) {
        throw codedError("VOCAB_SUMMARY_SEGMENT_LIMIT", `Review summary segment ${index} exceeds 64 KiB.`);
      }
      return {
        path,
        storeId: "review-summary",
        expectedRevision: 0,
        expectedHash: null,
        text: segmentText,
      };
    });
    const segments = segmentWrites.map((write, index) => ({
      index,
      path: write.path,
      hash: hashText(write.text),
      byteLength: utf8Length(write.text),
    }));
    const manifestPath = this._summaryManifestPath(sessionId);
    const manifest = {
      schemaVersion: 1,
      kind: "vocabulary-review-summary",
      deviceId: this.deviceId,
      sessionId,
      revision,
      flushedThroughSequence: nextSequence,
      summaryHash: hashText(content),
      byteLength,
      segments,
    };
    const manifestWrite = {
      path: manifestPath,
      storeId: "review-summary",
      expectedRevision: prior.revision,
      expectedHash: prior.hash,
      text: canonicalStringify(manifest),
    };
    const oldSegmentPaths = prior.paths.filter((path) => path !== manifestPath);
    const deleteMutations = [];
    for (const path of oldSegmentPaths) {
      const snapshot = await this.readSnapshot(path);
      if (!snapshot.exists) continue;
      deleteMutations.push({ path, storeId: "review-summary", expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
    }
    return { writes: [...segmentWrites, manifestWrite], deletes: deleteMutations, revision, hash: hashText(canonicalStringify(manifest)), paths: [manifestPath, ...segments.map((segment) => segment.path)] };
  }

  async writeSessionSummary({ sessionId = this.sessionId, actionId, summary, expectedHash } = {}) {
    const safeSession = safePathIdentity(sessionId, "review session ID");
    const safeAction = safeIdentity(actionId, "summary update action ID");
    const sessionLock = this._sessionLockPath(safeSession);
    const release = await this._acquirePathLocks([sessionLock]);
    try {
      const prior = await this._readSessionSummary(safeSession);
      if (expectedHash !== prior.hash) {
        return { status: "conflict", conflicts: [{ storeId: "review-summary", path: prior.manifestPath, phase: "summary-hash-mismatch", expectedHash: expectedHash ?? null, actualHash: prior.hash }] };
      }
      const mutationSet = await this._summaryMutations(safeSession, summary, prior, { allowSequenceAdvance: false });
      const result = await this._commit({
        actionId: safeAction,
        sessionId: safeSession,
        writes: mutationSet.writes,
        deletes: mutationSet.deletes,
        historySummary: null,
      }, { allowInternal: true, alreadyLockedPaths: [sessionLock] });
      return { ...result, hash: mutationSet.hash, revision: mutationSet.revision, paths: mutationSet.paths };
    } finally {
      release();
    }
  }

  async flushReviewSession({
    sessionId = this.sessionId,
    actionId,
    writes = [],
    historySummary = null,
    updatedSummary,
    expectedJournalHash,
    expectedSummaryHash,
    finalize = false,
    preconditions = [],
  } = {}) {
    const safeSession = safePathIdentity(sessionId, "review session ID");
    const safeAction = safeIdentity(actionId, "review flush action ID");
    const sessionLock = this._sessionLockPath(safeSession);
    const release = await this._acquirePathLocks([sessionLock]);
    try {
      const journal = await this.readJournalActions(safeSession);
      const priorSummary = await this._readSessionSummary(safeSession);
      if (expectedJournalHash !== journal.hash) {
        return { status: "conflict", conflicts: [{ storeId: "review-journal", path: journal.directory, phase: "journal-hash-mismatch", expectedHash: expectedJournalHash ?? null, actualHash: journal.hash }] };
      }
      if (expectedSummaryHash !== priorSummary.hash) {
        return { status: "conflict", conflicts: [{ storeId: "review-summary", path: priorSummary.manifestPath, phase: "summary-hash-mismatch", expectedHash: expectedSummaryHash ?? null, actualHash: priorSummary.hash }] };
      }
      if (historySummary && updatedSummary !== undefined) {
        throw codedError("VOCAB_SUMMARY_FINAL_AND_UPDATE", "A final history batch cannot be combined with a new pending summary checkpoint.");
      }
      const summaryDeletes = [];
      if (updatedSummary !== undefined && !historySummary && !finalize) {
        const priorSequence = priorSummary.summary?.flushedThroughSequence ?? 0;
        const nextSequence = updatedSummary?.flushedThroughSequence ?? 0;
        if (!Number.isSafeInteger(nextSequence) || nextSequence > journal.revision) {
          throw codedError("VOCAB_SUMMARY_SEQUENCE_INVALID", "A review checkpoint cannot advance beyond the verified journal sequence.");
        }
        const canonicalWriteCount = writes.filter((write) => !isInternalPath(normalizePath(write.path, this.root))).length;
        if (nextSequence > priorSequence && canonicalWriteCount === 0) {
          throw codedError("VOCAB_SUMMARY_CHECKPOINT_WITHOUT_CANONICAL_WRITES", "Review progress can advance only in the transaction that verifies its canonical store writes.");
        }
        const summaryMutations = await this._summaryMutations(safeSession, updatedSummary, priorSummary, { allowSequenceAdvance: true });
        writes = [...writes, ...summaryMutations.writes];
        summaryDeletes.push(...summaryMutations.deletes);
      }
      if (finalize && !historySummary && preconditions.length === 0 && writes.length === 0) {
        throw codedError("VOCAB_FINALIZE_PRECONDITION_REQUIRED", "A no-history finalization must verify canonical store snapshots.");
      }
      const deletes = summaryDeletes;
      if (finalize || historySummary) {
        const journalPathsToDelete = new Set(journal.cleanupPaths);
        for (const segment of journal.segments) {
          if (segment.format === "jsonl-v2" && segment.damaged) {
            // Keep a byte-identical non-active copy before placing the active
            // journal path in the transaction's post-verification cleanup.
            await this._preserveDamagedJournalLineSegment(segment);
            journalPathsToDelete.add(segment.path);
          }
        }
        for (const path of journalPathsToDelete) {
          const snapshot = await this.readSnapshot(path);
          if (snapshot.exists) {
            deletes.push({ path, storeId: "review-journal", expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
          }
        }
        for (const path of priorSummary.paths) {
          const snapshot = await this.readSnapshot(path);
          if (snapshot.exists) deletes.push({ path, storeId: "review-summary", expectedRevision: snapshot.revision, expectedHash: snapshot.hash });
        }
      }
      const effectiveHistory = historySummary ? {
        ...historySummary,
        batchId: historySummary.batchId || `review-final-${safeSession}`,
        sessionId: historySummary.sessionId || safeSession,
        kind: historySummary.kind || "review-final",
      } : null;
      const result = await this._commit({
        actionId: safeAction,
        sessionId: safeSession,
        writes,
        deletes,
        historySummary: effectiveHistory,
        entities: effectiveHistory?.entities || [],
        preconditions,
      }, { allowInternal: true, alreadyLockedPaths: [sessionLock] });
      return result;
    } finally {
      release();
    }
  }
}

module.exports = {
  VOCABULARY_DATA_ROOT,
  VocabularyTransactionCoordinator,
  normalizePath,
};
