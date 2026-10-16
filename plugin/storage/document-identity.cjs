/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { isSafeString } = require("./version.cjs");

const HASH_PATTERNS = Object.freeze({
  "xxh64-v1": /^xxh64-v1:[a-f0-9]{16}$/i,
  "sha256-v1": /^sha256-v1:[a-f0-9]{64}$/i,
});

function codedError(code, message) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  return error;
}

function normalizeInitialPath(value) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw codedError("WAL_IDENTITY_PATH_INVALID", "Initial path must be a non-empty safe relative path.");
  }
  const slashed = (value.normalize ? value.normalize("NFC") : value).replace(/\\/g, "/");
  if (slashed.startsWith("/")) {
    throw codedError("WAL_IDENTITY_PATH_INVALID", "Initial path must be relative to the vault.");
  }
  const segments = [];
  for (const segment of slashed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      throw codedError("WAL_IDENTITY_PATH_INVALID", "Initial path cannot escape the vault root.");
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw codedError("WAL_IDENTITY_PATH_INVALID", "Initial path must name a file or folder within the vault.");
  }
  return segments.join("/");
}

function validateFullSourceHash(value) {
  if (typeof value !== "string") {
    throw codedError("WAL_SOURCE_HASH_INVALID", "A full algorithm-prefixed source hash is required.");
  }
  const normalized = value.toLowerCase();
  if (!Object.values(HASH_PATTERNS).some((pattern) => pattern.test(normalized))) {
    throw codedError("WAL_SOURCE_HASH_INVALID", "Source hash must be a complete xxh64-v1 or sha256-v1 digest.");
  }
  return normalized;
}

function utf8(text) {
  if (typeof TextEncoder !== "function") {
    throw codedError("WAL_IDENTITY_UNAVAILABLE", "TextEncoder is required to derive a document identity in this runtime.");
  }
  return new TextEncoder().encode(text);
}

function parseTaggedHash(value) {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  if (HASH_PATTERNS["xxh64-v1"].test(normalized)) return normalized.slice("xxh64-v1:".length);
  if (HASH_PATTERNS["sha256-v1"].test(normalized)) return normalized.slice("sha256-v1:".length);
  if (/^[a-f0-9]{64}$/.test(normalized)) return normalized;
  return null;
}

function normalizeStableHash(value) {
  const normalized = String(value).toLowerCase();
  if (HASH_PATTERNS["xxh64-v1"].test(normalized) || HASH_PATTERNS["sha256-v1"].test(normalized)) return normalized;
  if (/^[a-f0-9]{64}$/.test(normalized)) return `sha256-v1:${normalized}`;
  return null;
}

async function deriveDocumentIdentity({ initialPath, fullSourceHash, documentId, stableHash } = {}) {
  const path = normalizeInitialPath(initialPath);
  const sourceHash = validateFullSourceHash(fullSourceHash);
  if (typeof stableHash !== "function") {
    throw codedError("WAL_IDENTITY_UNAVAILABLE", "An injected stable hash function is required.");
  }

  const identity = normalizeStableHash(await stableHash(utf8(`pdf-reader-wal-v1:${path}:${sourceHash}`)));
  if (!identity) {
    throw codedError("WAL_IDENTITY_HASH_INVALID", "The stable hash function returned an unsupported or incomplete hash.");
  }
  const id = documentId === undefined ? identity : documentId;
  if (!isSafeString(id, 512)) {
    throw codedError("WAL_IDENTITY_DOCUMENT_ID_INVALID", "documentId must be a safe non-empty string.");
  }
  const keyHash = normalizeStableHash(await stableHash(utf8(id)));
  const keyDigest = keyHash && parseTaggedHash(keyHash);
  if (!keyDigest) {
    throw codedError("WAL_IDENTITY_HASH_INVALID", "The stable hash function returned an unsupported or incomplete document key hash.");
  }

  return {
    documentId: id,
    docKey: keyDigest.slice(0, 12),
    identity,
    initialPath: path,
    fullSourceHash: sourceHash,
  };
}

module.exports = {
  normalizeInitialPath,
  validateFullSourceHash,
  deriveDocumentIdentity,
};
