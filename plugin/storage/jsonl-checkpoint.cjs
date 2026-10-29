/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { createStorageIo } = require("./io.cjs");
const { validateOperation } = require("./merge-engine.cjs");
const { canonicalJson } = require("./canonical.cjs");

function codedError(code, message) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  return error;
}

function createJsonlCheckpointStore({ adapter, root, hash, verifyHash, token } = {}) {
  const io = createStorageIo({ adapter, hash, verifyHash, token });
  const anchorPath = (document, deviceId) => `${root}/wal/${deviceId}/${document.docKey}.jsonl.anchor.json`;
  const archivePath = (document, deviceId, firstSeq, lastSeq) =>
    `${root}/wal/${deviceId}/${document.docKey}.jsonl.archive.${firstSeq}-${lastSeq}.json`;
  const snapshotPath = (document) => `${root}/sidecars/${document.docKey}.annotations.json`;

  function validateAnchor(value, document, deviceId) {
    if (!value || value.schemaVersion !== 1 || value.kind !== "pdf-reader-jsonl-device-anchor" ||
        value.docKey !== document.docKey || value.documentId !== document.documentId ||
        value.deviceId !== deviceId || value.sourceHash !== (document.source?.sourceHash || document.sourceHash) ||
        !Number.isSafeInteger(value.throughSeq) || value.throughSeq < 0 ||
        !Array.isArray(value.operations) || !Array.isArray(value.archives)) {
      throw codedError("WAL_JSONL_ANCHOR_INVALID", "Device anchor identity, source, or sequence is invalid.");
    }
    let previous = 0;
    for (const input of value.operations) {
      const operation = validateOperation(input);
      if (operation.version.deviceId !== deviceId || operation.seq <= previous ||
          operation.seq > value.throughSeq) {
        throw codedError("WAL_JSONL_ANCHOR_INVALID", "Device anchor operation order is invalid.");
      }
      previous = operation.seq;
    }
    for (const archive of value.archives) {
      if (!archive || !Number.isSafeInteger(archive.firstSeq) || archive.firstSeq <= 0 ||
          !Number.isSafeInteger(archive.lastSeq) || archive.lastSeq < archive.firstSeq ||
          archive.path !== archivePath(document, deviceId, archive.firstSeq, archive.lastSeq)) {
        throw codedError("WAL_JSONL_ANCHOR_INVALID", "A device anchor archive reference is invalid.");
      }
    }
    return value;
  }

  function validateArchive(value, document, deviceId, firstSeq, lastSeq) {
    if (!value || value.schemaVersion !== 1 || value.kind !== "pdf-reader-jsonl-immutable-archive" ||
        value.documentId !== document.documentId || value.docKey !== document.docKey ||
        value.deviceId !== deviceId || value.sourceHash !== (document.source?.sourceHash || document.sourceHash) ||
        value.firstSeq !== firstSeq || value.lastSeq !== lastSeq || !Array.isArray(value.operations) ||
        value.operations.length === 0) {
      throw codedError("WAL_JSONL_ARCHIVE_INVALID", "Immutable archive identity or range is invalid.");
    }
    let previous = firstSeq - 1;
    for (const input of value.operations) {
      const operation = validateOperation(input);
      if (operation.version.deviceId !== deviceId || operation.seq <= previous) {
        throw codedError("WAL_JSONL_ARCHIVE_INVALID", "Immutable archive has non-monotonic rows or a foreign owner.");
      }
      previous = operation.seq;
    }
    if (previous !== lastSeq) throw codedError("WAL_JSONL_ARCHIVE_INVALID", "Archive range does not match its rows.");
    return value;
  }

  async function readArchive(document, deviceId, firstSeq, lastSeq) {
    return io.readJsonWithDocumentIdentity(archivePath(document, deviceId, firstSeq, lastSeq), {
      expectedIdentity: document,
      validate: (value) => validateArchive(value, document, deviceId, firstSeq, lastSeq),
      getIdentity: (value) => value,
      validateCandidate: (value, candidate) => validateArchive(value, candidate, deviceId, firstSeq, lastSeq),
    });
  }

  async function writeArchive(document, deviceId, operations) {
    if (!Array.isArray(operations) || !operations.length) throw new TypeError("Archive needs a nonempty operation range.");
    const firstSeq = operations[0].seq;
    const lastSeq = operations.at(-1).seq;
    const path = archivePath(document, deviceId, firstSeq, lastSeq);
    const value = { schemaVersion: 1, kind: "pdf-reader-jsonl-immutable-archive",
      documentId: document.documentId, docKey: document.docKey, deviceId,
      sourceHash: document.source.sourceHash, firstSeq, lastSeq, operations };
    validateArchive(value, document, deviceId, firstSeq, lastSeq);
    const existing = await readArchive(document, deviceId, firstSeq, lastSeq);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(value)) {
        throw codedError("WAL_JSONL_ARCHIVE_COLLISION", "Immutable archive range has conflicting content.");
      }
      return { path, firstSeq, lastSeq };
    }
    await io.writeJsonAtomic(path, value, {
      createOnly: true,
      validate: (candidate) => validateArchive(candidate, document, deviceId, firstSeq, lastSeq),
    });
    return { path, firstSeq, lastSeq };
  }

  async function loadArchives(document, deviceId) {
    const directory = `${root}/wal/${deviceId}`;
    if (!(await adapter.exists(directory))) return [];
    const listing = await adapter.list(directory);
    const escaped = document.docKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^${escaped}\\.jsonl\\.archive\\.(\\d+)-(\\d+)\\.json$`);
    const rows = [];
    for (const listed of listing.files || []) {
      const file = listed.slice(listed.lastIndexOf("/") + 1);
      const match = pattern.exec(file);
      if (!match) continue;
      const firstSeq = Number(match[1]);
      const lastSeq = Number(match[2]);
      const archive = await readArchive(document, deviceId, firstSeq, lastSeq);
      if (!archive) throw codedError("WAL_JSONL_ARCHIVE_MISSING", "A listed immutable archive is missing.");
      rows.push({ path: archivePath(document, deviceId, firstSeq, lastSeq), archive });
    }
    rows.sort((left, right) => left.archive.firstSeq - right.archive.firstSeq);
    return rows;
  }

  async function readAnchor(document, deviceId) {
    return io.readJsonWithDocumentIdentity(anchorPath(document, deviceId), {
      expectedIdentity: document,
      validate: (value) => validateAnchor(value, document, deviceId),
      getIdentity: (value) => value,
      validateCandidate: (value, candidate) => validateAnchor(value, candidate, deviceId),
    });
  }

  async function writeAnchor(document, deviceId, operations, archiveReference) {
    const previous = await readAnchor(document, deviceId);
    const bySequence = new Map();
    for (const input of [...(previous?.operations || []), ...operations]) {
      const operation = validateOperation(input);
      if (operation.version.deviceId !== deviceId) throw codedError("WAL_JSONL_ANCHOR_OWNER", "Foreign operations cannot enter a device anchor.");
      const prior = bySequence.get(operation.seq);
      if (prior && canonicalJson(prior) !== canonicalJson(operation)) {
        throw codedError("WAL_SEQUENCE_COLLISION", "A device sequence identifies conflicting operations.");
      }
      bySequence.set(operation.seq, operation);
    }
    const retained = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
    const throughSeq = Math.max(previous?.throughSeq || 0, retained.at(-1)?.seq || 0);
    const archives = [...(previous?.archives || [])];
    if (archiveReference && !archives.some((item) => item.path === archiveReference.path)) {
      archives.push(archiveReference);
    }
    const value = { schemaVersion: 1, kind: "pdf-reader-jsonl-device-anchor",
      documentId: document.documentId, docKey: document.docKey, deviceId,
      sourceHash: document.source.sourceHash, throughSeq, operations: retained, archives };
    validateAnchor(value, document, deviceId);
    return io.writeJsonAtomic(anchorPath(document, deviceId), value, {
      validate: (candidate) => validateAnchor(candidate, document, deviceId),
    });
  }

  async function writeSnapshot(document, state, watermarks) {
    const value = { schemaVersion: 1, kind: "pdf-reader-jsonl-derived-snapshot",
      documentId: document.documentId, docKey: document.docKey,
      sourceHash: document.source.sourceHash, watermarks,
      annotations: Object.values(state.annotations || {}),
      tombstones: Object.values(state.tombstones || {}),
      ...(state.deletionGuards?.length ? { deletionGuards: state.deletionGuards } : {}),
      routing: state.routing || null };
    return io.writeJsonAtomic(snapshotPath(document), value, {
      // This file is a rebuildable cache. Separate temporary paths prevent
      // different devices from trampling each other's staging writes. A
      // different verified cache winning the final rename is also acceptable.
      uniquePending: true,
      acceptConcurrent: true,
      validate: (candidate) => {
        if (candidate?.documentId !== document.documentId || candidate?.docKey !== document.docKey ||
            candidate?.sourceHash !== document.source.sourceHash || !Array.isArray(candidate.annotations) ||
            !Array.isArray(candidate.tombstones)) {
          throw codedError("WAL_JSONL_SNAPSHOT_INVALID", "Derived snapshot identity or content is invalid.");
        }
      },
    });
  }

  return Object.freeze({ anchorPath, archivePath, snapshotPath, readAnchor, readArchive,
    writeArchive, loadArchives, writeAnchor, writeSnapshot });
}

module.exports = { createJsonlCheckpointStore };
