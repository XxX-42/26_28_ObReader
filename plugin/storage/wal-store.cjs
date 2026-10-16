/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { canonicalJson } = require("./canonical.cjs");
const { validateOperation, joinOperations } = require("./merge-engine.cjs");
const { isSafeString } = require("./version.cjs");
const { createStorageIo } = require("./io.cjs");
const { runQueuedWalWrite } = require("./wal-writer-coordinator.cjs");
const { createWalCompactor } = require("./compactor.cjs");

const observedWalProgressByAdapter = new WeakMap();

function codedError(code, message) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  return error;
}

function normalizeRoot(root) {
  if (typeof root !== "string" || !root.trim()) throw new TypeError("A relative storage root is required.");
  const normalized = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "." || !part)) {
    throw new TypeError("The storage root must be a safe relative path.");
  }
  return normalized;
}

function normalizeIdentity(document) {
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      !isSafeString(document.docKey, 256) || !isSafeString(document.documentId, 512)) {
    throw codedError("WAL_DOCUMENT_IDENTITY_INVALID", "Document metadata needs safe documentId and docKey values.");
  }
  if (document.docKey.includes("/") || document.docKey.includes("\\") || document.docKey === "..") {
    throw codedError("WAL_DOCUMENT_IDENTITY_INVALID", "docKey must be a single safe path segment.");
  }
  return document;
}

function normalizeOwner(value) {
  if (!isSafeString(value, 256) || value.includes("/") || value.includes("\\") || value === "." || value === "..") {
    throw codedError("WAL_DEVICE_ID_INVALID", "deviceId must be a safe single path segment.");
  }
  return value;
}

function normalizeListedPath(path, root) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function operationRows(wal) {
  return [...(wal?.anchor?.operations || []), ...(wal?.tail || [])];
}

function observationKey(document, owner) {
  return `${document.documentId.length}:${document.documentId}${document.docKey.length}:${document.docKey}${owner.length}:${owner}`;
}

function checkWalProgress(adapter, document, owner, wal, { record = false } = {}) {
  let observed = observedWalProgressByAdapter.get(adapter);
  const key = observationKey(document, owner);
  const previous = observed?.get(key);
  if (previous && (wal.nextSeq < previous.nextSeq || wal.anchor.throughSeq < previous.throughSeq)) {
    throw codedError("WAL_SEQ_REGRESSION", "A verified WAL regressed below sequence progress already observed in this runtime.");
  }
  if (record) {
    if (!observed) {
      observed = new Map();
      observedWalProgressByAdapter.set(adapter, observed);
    }
    observed.set(key, {
      nextSeq: Math.max(previous?.nextSeq || 1, wal.nextSeq),
      throughSeq: Math.max(previous?.throughSeq || 0, wal.anchor.throughSeq),
    });
  }
}

function setOwn(map, key, value) {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

function operationsFromAnchor(anchor) {
  if (Array.isArray(anchor?.operations)) return anchor.operations.map(validateOperation);
  if (!anchor || typeof anchor !== "object" || !anchor.annotations || typeof anchor.annotations !== "object" ||
      !anchor.tombstones || typeof anchor.tombstones !== "object") return [];
  const operations = [];
  for (const [uuid, operation] of Object.entries(anchor.annotations)) {
    const normalized = validateOperation(operation);
    if (normalized.type !== "ANNOTATION_SET" || normalized.uuid !== uuid) {
      throw codedError("WAL_ANCHOR_INVALID", "Anchor annotation map keys must match ANNOTATION_SET UUIDs.");
    }
    operations.push(normalized);
  }
  for (const [uuid, operation] of Object.entries(anchor.tombstones)) {
    const normalized = validateOperation(operation);
    if (normalized.type !== "ANNOTATION_DELETE" || normalized.uuid !== uuid) {
      throw codedError("WAL_ANCHOR_INVALID", "Anchor tombstone map keys must match ANNOTATION_DELETE UUIDs.");
    }
    operations.push(normalized);
  }
  if (anchor.routing !== null && anchor.routing !== undefined) {
    const routing = validateOperation(anchor.routing);
    if (routing.type !== "ROUTE_SET") throw codedError("WAL_ANCHOR_INVALID", "Anchor routing must be a ROUTE_SET operation.");
    operations.push(routing);
  }
  return operations;
}

function mapsFromOperations(operations) {
  const state = joinOperations(operations);
  const annotations = {};
  const tombstones = {};
  for (const [uuid, operation] of Object.entries(state.annotations)) setOwn(annotations, uuid, operation);
  for (const [uuid, operation] of Object.entries(state.tombstones)) setOwn(tombstones, uuid, operation);
  return { annotations, tombstones, routing: state.routing || null };
}

function normalizeWal(value) {
  const normalized = { ...value, anchor: { ...value.anchor } };
  Object.defineProperty(normalized.anchor, "operations", {
    value: operationsFromAnchor(value.anchor), enumerable: false, configurable: false,
  });
  return normalized;
}

function createWalStore({
  adapter,
  root = "00_Archive/20_PDFData",
  hash,
  verifyHash,
  deviceId,
  token,
  thresholds,
  sidecarStore,
} = {}) {
  const baseRoot = normalizeRoot(root);
  const ownerId = normalizeOwner(deviceId);
  const io = createStorageIo({ adapter, hash, verifyHash, token });
  const walRoot = `${baseRoot}/wal`;

  function pathFor(document, owner = ownerId) {
    const normalized = normalizeIdentity(document);
    return `${walRoot}/${normalizeOwner(owner)}/${normalized.docKey}.json`;
  }

  function validateDocumentMetadata(metadata, document) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        metadata.documentId !== document.documentId || metadata.docKey !== document.docKey) {
      throw codedError("WAL_DOCUMENT_METADATA_INVALID", "WAL.document must match the documentId and docKey.");
    }
    for (const key of ["initialPath", "fullSourceHash", "sourcePath"]) {
      if (metadata[key] !== undefined && (typeof metadata[key] !== "string" || !metadata[key])) {
        throw codedError("WAL_DOCUMENT_METADATA_INVALID", `WAL.document.${key} is invalid.`);
      }
    }
    if (metadata.source !== undefined && metadata.source !== null &&
        (typeof metadata.source !== "object" || Array.isArray(metadata.source))) {
      throw codedError("WAL_DOCUMENT_METADATA_INVALID", "WAL.document.source must be an object when present.");
    }
    if (metadata.legacyIdentityScanComplete !== undefined && typeof metadata.legacyIdentityScanComplete !== "boolean") {
      throw codedError("WAL_DOCUMENT_METADATA_INVALID", "WAL.document.legacyIdentityScanComplete must be boolean.");
    }
  }

  function defaultDocumentMetadata(document) {
    return {
      documentId: document.documentId,
      docKey: document.docKey,
      ...(document.initialPath ? { initialPath: document.initialPath } : {}),
      ...(document.fullSourceHash ? { fullSourceHash: document.fullSourceHash } : {}),
      ...(document.sourcePath ? { sourcePath: document.sourcePath } : {}),
      ...(document.source !== undefined ? { source: document.source } : {}),
      ...(document.legacyIdentities !== undefined ? { legacyIdentities: document.legacyIdentities } : {}),
      ...(document.legacyIdentityScanComplete !== undefined
        ? { legacyIdentityScanComplete: document.legacyIdentityScanComplete } : {}),
    };
  }

  function validateWal(value, document, expectedOwner) {
    const normalized = normalizeIdentity(document);
    const owner = normalizeOwner(expectedOwner);
    const allowedKeys = new Set(["schemaVersion", "kind", "docKey", "documentId", "deviceId", "document", "nextSeq", "anchor", "tail"]);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !allowedKeys.has(key)) ||
        value.schemaVersion !== 1 || value.kind !== "pdf-reader-device-wal" ||
        value.docKey !== normalized.docKey || value.documentId !== normalized.documentId ||
        value.deviceId !== owner || !Number.isSafeInteger(value.nextSeq) || value.nextSeq < 1 ||
        !value.anchor || typeof value.anchor !== "object" || Array.isArray(value.anchor) ||
        Object.keys(value.anchor).some((key) => !["throughSeq", "annotations", "tombstones", "routing"].includes(key)) ||
        !Number.isSafeInteger(value.anchor.throughSeq) || value.anchor.throughSeq < 0 ||
        !value.anchor.annotations || typeof value.anchor.annotations !== "object" || Array.isArray(value.anchor.annotations) ||
        !value.anchor.tombstones || typeof value.anchor.tombstones !== "object" || Array.isArray(value.anchor.tombstones) ||
        !Object.prototype.hasOwnProperty.call(value.anchor, "routing") ||
        (value.anchor.routing !== null &&
          (typeof value.anchor.routing !== "object" || Array.isArray(value.anchor.routing))) ||
        !Array.isArray(value.tail)) {
      throw codedError("WAL_ENVELOPE_INVALID", "Device WAL schema, identity, anchor, or sequence is invalid.");
    }
    validateDocumentMetadata(value.document, normalized);

    let maxOwnedSequence = 0;
    const anchorOperations = operationsFromAnchor(value.anchor);
    for (const operation of anchorOperations) {
      const normalizedOperation = validateOperation(operation);
      if (normalizedOperation.version.deviceId !== owner &&
          !(normalizedOperation.version.deviceId === "legacy-import" &&
            normalizedOperation.version.rev === 1 && normalizedOperation.seq === 0)) {
        throw codedError("WAL_OWNER_MISMATCH", "A WAL anchor may contain only its owner's operations or the deterministic legacy-import baseline.");
      }
      if (normalizedOperation.version.deviceId === owner) {
        maxOwnedSequence = Math.max(maxOwnedSequence, normalizedOperation.seq);
        if (normalizedOperation.seq > value.anchor.throughSeq) {
          throw codedError("WAL_ANCHOR_SEQUENCE_INVALID", "Anchor throughSeq must cover every owned anchor operation.");
        }
      }
    }
    let previousSeq = value.anchor.throughSeq;
    for (const operation of value.tail) {
      const normalizedOperation = validateOperation(operation);
      if (normalizedOperation.version.deviceId !== owner) {
        throw codedError("WAL_OWNER_MISMATCH", "A WAL tail contains an operation owned by another device.");
      }
      if (normalizedOperation.seq <= previousSeq) {
        throw codedError("WAL_SEQUENCE_INVALID", "WAL tail sequences must strictly increase after anchor.throughSeq.");
      }
      previousSeq = normalizedOperation.seq;
      maxOwnedSequence = Math.max(maxOwnedSequence, normalizedOperation.seq);
    }
    if (value.nextSeq <= Math.max(value.anchor.throughSeq, maxOwnedSequence)) {
      throw codedError("WAL_SEQUENCE_INVALID", "nextSeq must exceed every owned anchor and tail sequence.");
    }
    joinOperations(anchorOperations, value.tail);
    return value;
  }

  async function readWal(document, owner = ownerId) {
    const normalized = normalizeIdentity(document);
    const device = normalizeOwner(owner);
    const wal = await io.readJsonWithDocumentIdentity(pathFor(normalized, device), {
      expectedIdentity: normalized,
      validate: (value) => validateWal(value, normalized, device),
      getIdentity: (value) => value?.document,
      validateCandidate: (value, candidateIdentity) => validateWal(value, candidateIdentity, device),
    });
    if (!wal) return null;
    checkWalProgress(adapter, normalized, device, wal, { record: true });
    return normalizeWal(wal);
  }

  async function loadWals(document) {
    const normalized = normalizeIdentity(document);
    const valid = [];
    const errors = [];
    let listing;
    try {
      if (!(await adapter.exists(walRoot))) return { valid, errors };
      listing = await io.list(walRoot);
    } catch (error) {
      return { valid, errors: [{ path: walRoot, code: error?.code || "WAL_LIST_FAILED", message: String(error?.message || error) }] };
    }
    for (const listed of listing.folders) {
      const owner = normalizeListedPath(listed, walRoot);
      if (!owner || owner.includes("/") || owner.includes("\\") || owner === "." || owner === "..") continue;
      const walPath = pathFor(normalized, owner);
      try {
        if (!(await adapter.exists(walPath)) && !(await adapter.exists(`${walPath}.pending`))) continue;
        const wal = await readWal(normalized, owner);
        if (wal) valid.push({ deviceId: owner, wal, path: walPath });
      } catch (error) {
        errors.push({ deviceId: owner, path: walPath, code: error?.code || "WAL_INVALID", message: String(error?.message || error) });
      }
    }
    valid.sort((left, right) => left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0);
    return { valid, errors };
  }

  async function writeWalUnlocked(document, input, { allowPrune = false } = {}) {
    const normalized = normalizeIdentity(document);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw codedError("WAL_ENVELOPE_INVALID", "writeWal requires a device WAL object.");
    }
    const owner = normalizeOwner(input.deviceId || ownerId);
    if (owner !== ownerId) throw codedError("WAL_OWNER_MISMATCH", "A store may write only its own device WAL.");
    let existing = await readWal(normalized, owner);
    const metadata = input.document || existing?.document || defaultDocumentMetadata(normalized);
    validateDocumentMetadata(metadata, normalized);
    if (existing && canonicalJson(existing.document) !== canonicalJson(metadata)) {
      throw codedError("WAL_DOCUMENT_METADATA_IMMUTABLE", "WAL.document metadata cannot change after first persistence.");
    }

    const anchor = {
      throughSeq: input.anchor?.throughSeq,
      operations: operationsFromAnchor(input.anchor),
    };
    const tail = Array.isArray(input.tail) ? input.tail.map(validateOperation) : [];
    const nextSeq = input.nextSeq;
    const previousNextSeq = existing?.nextSeq || 1;
    const previousThroughSeq = existing?.anchor?.throughSeq || 0;
    if (!Number.isSafeInteger(anchor.throughSeq) || anchor.throughSeq < previousThroughSeq ||
        !Number.isSafeInteger(nextSeq) || nextSeq < previousNextSeq ||
        nextSeq <= Math.max(anchor.throughSeq, tail.at(-1)?.seq || 0)) {
      throw codedError("WAL_WATERMARK_REGRESSION", "WAL anchor and nextSeq watermarks must remain monotonic.");
    }

    if (existing) {
      const newRows = [...anchor.operations, ...tail];
      const newTexts = new Set(newRows.map((operation) => canonicalJson(operation)));
      if (!allowPrune) {
        for (const oldOperation of operationRows(existing)) {
          if (!newTexts.has(canonicalJson(oldOperation))) {
            throw codedError("WAL_HISTORY_PRUNED", "A WAL write cannot remove an operation outside verified compaction.");
          }
        }
      }
      const oldTailTexts = new Set(existing.tail.map((operation) => canonicalJson(operation)));
      for (const operation of tail) {
        if (oldTailTexts.has(canonicalJson(operation))) continue;
        if (operation.version.deviceId !== owner || operation.seq < previousNextSeq ||
            operation.seq <= anchor.throughSeq) {
          throw codedError("WAL_SEQUENCE_REGRESSION", "New WAL tail operations must belong to this device and follow nextSeq/anchor.throughSeq.");
        }
      }
    }

    const internalValue = {
      schemaVersion: 1,
      kind: "pdf-reader-device-wal",
      documentId: normalized.documentId,
      docKey: normalized.docKey,
      deviceId: owner,
      document: metadata,
      anchor,
      tail,
      nextSeq,
    };
    validateWal({ ...internalValue, anchor: { throughSeq: anchor.throughSeq, ...mapsFromOperations(anchor.operations) } }, normalized, owner);
    const diskValue = {
      ...internalValue,
      anchor: { throughSeq: anchor.throughSeq, ...mapsFromOperations(anchor.operations) },
    };
    checkWalProgress(adapter, normalized, owner, diskValue);
    const written = await io.writeJsonAtomic(pathFor(normalized, owner), diskValue, {
      validate: (candidate) => validateWal(candidate, normalized, owner),
    });
    checkWalProgress(adapter, normalized, owner, written, { record: true });
    return normalizeWal(written);
  }

  async function writeWal(document, wal, options = {}) {
    const normalized = normalizeIdentity(document);
    return runQueuedWalWrite(adapter, ownerId, normalized.docKey,
      () => writeWalUnlocked(normalized, wal, options));
  }

  const compactor = createWalCompactor({
    adapter,
    root: baseRoot,
    hash,
    verifyHash,
    deviceId: ownerId,
    token,
    thresholds,
    sidecarStore,
    loadWals,
    readWal,
    writeWalUnlocked,
  });

  return Object.freeze({
    pathFor,
    loadWals,
    readWal,
    writeWal,
    writeWalUnlocked,
    compact: compactor.compact,
    validateWal,
    deviceId: ownerId,
    root: baseRoot,
  });
}

module.exports = { createWalStore };
