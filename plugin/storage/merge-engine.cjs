/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { canonicalJson } = require("./canonical.cjs");
const { normalizeInitialPath } = require("./document-identity.cjs");
const { compareVersion, isSafeString, validateVersion } = require("./version.cjs");

const OPERATION_TYPES = new Set(["ANNOTATION_SET", "ANNOTATION_DELETE", "ROUTE_SET"]);
const ANNOTATION_KINDS = new Set(["freetext", "square", "underline", "highlight", "ink", "inkhighlight"]);

function codedError(code, message, details) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
    throw codedError("WAL_OPERATION_INVALID", "An operation must be an object.");
  }

  // Round-tripping through the canonical form rejects non-JSON data and gives
  // the caller an immutable snapshot while preserving every supported field.
  let normalized;
  try {
    normalized = JSON.parse(canonicalJson(operation));
  } catch (error) {
    if (error?.code) throw error;
    throw codedError("WAL_OPERATION_INVALID", "An operation is not valid canonical JSON.");
  }

  if (!OPERATION_TYPES.has(normalized.type)) {
    throw codedError("WAL_OPERATION_INVALID", "Operation type must be ANNOTATION_SET, ANNOTATION_DELETE, or ROUTE_SET.");
  }
  if (!Number.isSafeInteger(normalized.seq) || normalized.seq < 0 ||
      !isSafeString(normalized.opId, 512)) {
    throw codedError("WAL_OPERATION_INVALID", "An operation needs a non-negative safe seq and a safe opId.");
  }
  const version = validateVersion(normalized.version);
  if (normalized.seq !== version.seq) {
    throw codedError("WAL_OPERATION_INVALID", "Operation seq must match version.seq.");
  }

  if (normalized.type === "ANNOTATION_SET" || normalized.type === "ANNOTATION_DELETE") {
    if (!isSafeString(normalized.uuid, 512)) {
      throw codedError("WAL_OPERATION_INVALID", "Annotation operations need a safe UUID.");
    }
    if (!isSafeString(normalized.kind, 128) || !ANNOTATION_KINDS.has(normalized.kind.toLowerCase())) {
      throw codedError("WAL_OPERATION_INVALID", "Annotation operations need a known annotation kind.");
    }
    if (!Number.isSafeInteger(normalized.pageIndex) || normalized.pageIndex < 0) {
      throw codedError("WAL_OPERATION_INVALID", "Annotation operations need a non-negative safe pageIndex.");
    }
  } else if (normalized.uuid !== undefined && !isSafeString(normalized.uuid, 512)) {
    throw codedError("WAL_OPERATION_INVALID", "A route UUID, when present, must be a safe string.");
  }

  if (normalized.type === "ANNOTATION_SET" &&
      (!hasOwn(normalized, "payload") || !normalized.payload || typeof normalized.payload !== "object" || Array.isArray(normalized.payload))) {
    throw codedError("WAL_OPERATION_INVALID", "ANNOTATION_SET needs an object payload.");
  }
  if (normalized.type === "ROUTE_SET") {
    if (!normalized.payload || typeof normalized.payload !== "object" || Array.isArray(normalized.payload)) {
      throw codedError("WAL_OPERATION_INVALID", "ROUTE_SET needs an object payload.");
    }
    try {
      normalizeInitialPath(normalized.payload.sourcePath);
    } catch {
      throw codedError("WAL_OPERATION_INVALID", "ROUTE_SET payload needs a valid relative sourcePath.");
    }
  }
  if (normalized.kind !== undefined && !isSafeString(normalized.kind, 128)) {
    throw codedError("WAL_OPERATION_INVALID", "Operation kind must be a safe string when present.");
  }
  if (normalized.pageIndex !== undefined &&
      (!Number.isSafeInteger(normalized.pageIndex) || normalized.pageIndex < 0)) {
    throw codedError("WAL_OPERATION_INVALID", "Operation pageIndex must be a non-negative safe integer when present.");
  }

  // Preserve the exact operation JSON. Version validation above only inspects
  // the required tuple; supplemental fields remain part of collision identity.
  return normalized;
}

function appendSource(source, operations) {
  if (source === undefined || source === null) return;
  if (Array.isArray(source)) {
    for (const operation of source) operations.push(validateOperation(operation));
    return;
  }
  if (typeof source === "object" && Array.isArray(source.operations)) {
    for (const operation of source.operations) operations.push(validateOperation(operation));
    return;
  }
  throw codedError("WAL_OPERATION_SOURCE_INVALID", "Operation sources must be arrays or records with an operations array.");
}

function defineMapValue(map, key, value) {
  Object.defineProperty(map, key, {
    value, enumerable: true, writable: true, configurable: true,
  });
}

function joinOperations(...sources) {
  const all = [];
  for (const source of sources) appendSource(source, all);

  const byVersion = new Map();
  const unique = [];
  for (const operation of all) {
    const version = validateVersion(operation.version);
    const logicalKey = operation.type === "ROUTE_SET" ? ["route"] : ["annotation", operation.uuid];
    const versionKey = JSON.stringify([...logicalKey, version.rev, version.deviceId, version.seq]);
    const operationJson = canonicalJson(operation);
    const prior = byVersion.get(versionKey);
    if (prior) {
      if (prior.operationJson !== operationJson) {
        throw codedError(
          "VERSION_COLLISION",
          "The same version tuple identifies different operation content.",
          { version },
        );
      }
      continue;
    }
    byVersion.set(versionKey, { operationJson, operation });
    unique.push(operation);
  }

  const annotationWinners = new Map();
  let routing = null;
  for (const operation of unique) {
    if (operation.type === "ROUTE_SET") {
      if (!routing || compareVersion(operation.version, routing.version) > 0) routing = operation;
      continue;
    }
    const prior = annotationWinners.get(operation.uuid);
    if (!prior || compareVersion(operation.version, prior.version) > 0) {
      annotationWinners.set(operation.uuid, operation);
    }
  }

  const annotations = {};
  const tombstones = {};
  const uuids = [...annotationWinners.keys()].sort();
  for (const uuid of uuids) {
    const winner = annotationWinners.get(uuid);
    if (winner.type === "ANNOTATION_DELETE") defineMapValue(tombstones, uuid, winner);
    else defineMapValue(annotations, uuid, winner);
  }
  return { annotations, tombstones, routing };
}

module.exports = {
  OPERATION_TYPES: Object.freeze([...OPERATION_TYPES]),
  validateOperation,
  joinOperations,
};
