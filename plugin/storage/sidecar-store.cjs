/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { validateOperation, joinOperations } = require("./merge-engine.cjs");
const { canonicalJson } = require("./canonical.cjs");
const { isSafeString } = require("./version.cjs");
const { createStorageIo } = require("./io.cjs");
const { runQueuedWalWrite } = require("./wal-writer-coordinator.cjs");

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

function operationsFromState(state) {
  return [
    ...Object.values(state.annotations || {}),
    ...Object.values(state.tombstones || {}),
    ...(state.routing ? [state.routing] : []),
  ].sort((left, right) => {
    const a = `${left.type}\u0000${left.uuid || ""}\u0000${left.version.rev}\u0000${left.version.deviceId}\u0000${left.version.seq}`;
    const b = `${right.type}\u0000${right.uuid || ""}\u0000${right.version.rev}\u0000${right.version.deviceId}\u0000${right.version.seq}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function validateUniqueDeviceSequences(operations) {
  const seen = new Map();
  for (const operation of operations) {
    const { deviceId, rev, seq } = operation.version;
    // The deterministic importer deliberately assigns all baseline objects
    // the same version, so it is the one reserved exception to owner seq IDs.
    if (deviceId === "legacy-import" && rev === 1 && seq === 0) continue;
    const key = `${deviceId.length}:${deviceId}:${seq}`;
    const text = canonicalJson(operation);
    const previous = seen.get(key);
    if (previous !== undefined && previous !== text) {
      throw codedError("WAL_SEQUENCE_COLLISION", "A device sequence may identify only one operation across its sidecar.");
    }
    seen.set(key, text);
  }
}

function setOwn(map, key, value) {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
}

function operationsFromSidecar(value) {
  if (Array.isArray(value?.operations)) return value.operations.map(validateOperation);
  if (!value || typeof value !== "object" || !value.annotations || typeof value.annotations !== "object" ||
      !value.tombstones || typeof value.tombstones !== "object") return [];
  const operations = [];
  for (const [uuid, operation] of Object.entries(value.annotations)) {
    const normalized = validateOperation(operation);
    if (normalized.type !== "ANNOTATION_SET" || normalized.uuid !== uuid) {
      throw codedError("WAL_SIDECAR_INVALID", "Sidecar annotation map keys must match ANNOTATION_SET UUIDs.");
    }
    operations.push(normalized);
  }
  for (const [uuid, operation] of Object.entries(value.tombstones)) {
    const normalized = validateOperation(operation);
    if (normalized.type !== "ANNOTATION_DELETE" || normalized.uuid !== uuid) {
      throw codedError("WAL_SIDECAR_INVALID", "Sidecar tombstone map keys must match ANNOTATION_DELETE UUIDs.");
    }
    operations.push(normalized);
  }
  if (value.routing !== null && value.routing !== undefined) {
    const routing = validateOperation(value.routing);
    if (routing.type !== "ROUTE_SET") throw codedError("WAL_SIDECAR_INVALID", "Sidecar routing must be a ROUTE_SET operation.");
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

function createSidecarStore({ adapter, root = "00_Archive/20_PDFData", hash, verifyHash, token } = {}) {
  const baseRoot = normalizeRoot(root);
  const io = createStorageIo({ adapter, hash, verifyHash, token });

  function pathFor(document) {
    const normalized = normalizeIdentity(document);
    return `${baseRoot}/sidecars/${normalized.docKey}.annot.json`;
  }

  function validateDocumentMetadata(metadata, document) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
        metadata.documentId !== document.documentId || metadata.docKey !== document.docKey) {
      throw codedError("WAL_DOCUMENT_METADATA_INVALID", "Sidecar document metadata does not match its path identity.");
    }
    for (const key of ["initialPath", "fullSourceHash", "sourcePath"]) {
      if (metadata[key] !== undefined && (typeof metadata[key] !== "string" || !metadata[key])) {
        throw codedError("WAL_DOCUMENT_METADATA_INVALID", `Sidecar document.${key} is invalid.`);
      }
    }
    if (metadata.source !== undefined && metadata.source !== null &&
        (typeof metadata.source !== "object" || Array.isArray(metadata.source))) {
      throw codedError("WAL_DOCUMENT_METADATA_INVALID", "Sidecar document.source must be an object when present.");
    }
    if (metadata.legacyIdentities !== undefined && !Array.isArray(metadata.legacyIdentities) &&
        (typeof metadata.legacyIdentities !== "object" || metadata.legacyIdentities === null)) {
      throw codedError("WAL_DOCUMENT_METADATA_INVALID", "Sidecar legacy identities must be an array or object.");
    }
    if (metadata.legacyIdentityScanComplete !== undefined && typeof metadata.legacyIdentityScanComplete !== "boolean") {
      throw codedError("WAL_DOCUMENT_METADATA_INVALID", "Sidecar legacy identity scan state must be boolean.");
    }
  }

  function validateSidecar(value, document) {
    const normalized = normalizeIdentity(document);
    const allowedKeys = new Set(["schemaVersion", "kind", "document", "annotations", "tombstones", "routing", "watermark"]);
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some((key) => !allowedKeys.has(key)) ||
        value.schemaVersion !== 1 || value.kind !== "pdf-reader-materialized-sidecar" ||
        !value.annotations || typeof value.annotations !== "object" || Array.isArray(value.annotations) ||
        !value.tombstones || typeof value.tombstones !== "object" || Array.isArray(value.tombstones) ||
        !Object.prototype.hasOwnProperty.call(value, "routing") ||
        (value.routing !== null && (typeof value.routing !== "object" || Array.isArray(value.routing))) ||
        !value.watermark || typeof value.watermark !== "object" ||
        Array.isArray(value.watermark)) {
      throw codedError("WAL_SIDECAR_INVALID", "Sidecar schema, operations, or watermark is invalid.");
    }
    validateDocumentMetadata(value.document, normalized);
    const maxByDevice = new Map();
    const operations = operationsFromSidecar(value);
    validateUniqueDeviceSequences(operations);
    for (const operation of operations) {
      const normalizedOperation = validateOperation(operation);
      maxByDevice.set(normalizedOperation.version.deviceId,
        Math.max(maxByDevice.get(normalizedOperation.version.deviceId) || 0, normalizedOperation.seq));
    }
    joinOperations(operations);
    for (const [owner, sequence] of Object.entries(value.watermark)) {
      if (!isSafeString(owner, 256) || !Number.isSafeInteger(sequence) || sequence < 0 ||
          sequence < (maxByDevice.get(owner) || 0)) {
        throw codedError("WAL_WATERMARK_INVALID", "Sidecar watermarks must cover every persisted operation for their device.");
      }
    }
    for (const [owner, sequence] of maxByDevice) {
      if (!Object.prototype.hasOwnProperty.call(value.watermark, owner) || value.watermark[owner] < sequence) {
        throw codedError("WAL_WATERMARK_INVALID", "Sidecar watermark is missing an observed device sequence.");
      }
    }
  }

  function mergeDocumentMetadata(existing, incoming, normalized) {
    const prior = existing?.document || {};
    const next = incoming?.document || incoming || {};
    const merged = { ...prior, ...next, documentId: normalized.documentId, docKey: normalized.docKey };
    for (const key of ["initialPath", "fullSourceHash"]) {
      if (prior[key] !== undefined && next[key] !== undefined && prior[key] !== next[key]) {
        throw codedError("WAL_DOCUMENT_METADATA_IMMUTABLE", `Sidecar document.${key} cannot change after persistence.`);
      }
      if (prior[key] !== undefined && next[key] === undefined) merged[key] = prior[key];
    }
    return merged;
  }

  function mergeWatermark(existing, incoming, operations) {
    const watermark = {};
    for (const source of [existing?.watermark, incoming]) {
      if (!source || typeof source !== "object" || Array.isArray(source)) continue;
      for (const [owner, sequence] of Object.entries(source)) {
        if (!isSafeString(owner, 256) || !Number.isSafeInteger(sequence) || sequence < 0) continue;
        watermark[owner] = Math.max(watermark[owner] || 0, sequence);
      }
    }
    for (const operation of operations) {
      const owner = operation.version.deviceId;
      watermark[owner] = Math.max(watermark[owner] || 0, operation.seq);
    }
    return Object.fromEntries(Object.entries(watermark).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0));
  }

  async function readSidecar(normalized) {
    const sidecar = await io.readJsonWithDocumentIdentity(pathFor(normalized), {
      expectedIdentity: normalized,
      validate: (value) => validateSidecar(value, normalized),
      getIdentity: (value) => value?.document,
      validateCandidate: (value, candidateIdentity) => validateSidecar(value, candidateIdentity),
    });
    if (!sidecar) return null;
    Object.defineProperty(sidecar, "operations", {
      value: operationsFromSidecar(sidecar), enumerable: false, configurable: false,
    });
    return sidecar;
  }

  async function loadSidecar(document) {
    return readSidecar(normalizeIdentity(document));
  }

  async function writeSidecar(document, input, { createOnly = false } = {}) {
    const normalized = normalizeIdentity(document);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw codedError("WAL_SIDECAR_INVALID", "writeSidecar requires a sidecar envelope.");
    }
    return runQueuedWalWrite(adapter, "@sidecar", normalized.docKey, async () => {
      const sidecarPath = pathFor(normalized);
      let existing = null;
      try { existing = await readSidecar(normalized); }
      catch (error) {
        if (error?.code !== "WAL_FILE_INVALID") throw error;
      }
      if (createOnly && existing) {
        throw codedError("WAL_SIDECAR_EXISTS", `A valid sidecar already exists at ${sidecarPath}.`);
      }

      const incomingOperations = operationsFromSidecar(input);
      const joined = joinOperations(existing ? operationsFromSidecar(existing) : [], incomingOperations);
      const operations = operationsFromState(joined);
      const maps = mapsFromOperations(operations);
      const envelope = {
        schemaVersion: 1,
        kind: "pdf-reader-materialized-sidecar",
        document: mergeDocumentMetadata(existing, input, normalized),
        ...maps,
        watermark: mergeWatermark(existing, input.watermark, operations),
      };
      validateSidecar(envelope, normalized);
      const written = await io.writeJsonAtomic(sidecarPath, envelope, {
        validate: (value) => validateSidecar(value, normalized),
        createOnly,
      });
      Object.defineProperty(written, "operations", {
        value: operationsFromSidecar(written), enumerable: false, configurable: false,
      });
      return written;
    });
  }

  return Object.freeze({ pathFor, loadSidecar, writeSidecar, validateSidecar });
}

module.exports = { createSidecarStore };
