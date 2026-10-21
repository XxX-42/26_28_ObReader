/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { createStorageIo } = require("./io.cjs");
const { canonicalJson } = require("./canonical.cjs");
const { validateVersion } = require("./version.cjs");

const DELETION_RETENTION_MS = 48 * 24 * 60 * 60 * 1000;

// This is a projection of verified history, never a replacement for WAL
// evidence. A missing/corrupt ledger expands guards back into full tombstones.
function createDeletionRetention({ adapter, root, deviceId, hash, verifyHash, token, clock = Date.now }) {
  const io = createStorageIo({ adapter, hash, verifyHash, token });
  const queues = new Map();
  const pathFor = (document) => `${root}/wal/${deviceId}/${document.docKey}.jsonl.retention.json`;
  const full = (state) => ({ tombstones: state.tombstones, deletionGuards: [] });

  function validate(value, document) {
    if (!value || value.schemaVersion !== 1 || value.kind !== "pdf-reader-deletion-retention" ||
        value.docKey !== document.docKey || value.documentId !== document.documentId ||
        value.sourceHash !== (document.source?.sourceHash || document.sourceHash) || value.deviceId !== deviceId ||
        !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
      throw new Error("WAL_DELETION_RETENTION_INVALID");
    }
    for (const entry of Object.values(value.entries)) {
      validateVersion(entry.version);
      if (!Number.isSafeInteger(entry.firstObservedAt) || entry.firstObservedAt < 0) {
        throw new Error("WAL_DELETION_RETENTION_INVALID");
      }
    }
    return value;
  }

  async function projectNow(document, state, { readOnly = false } = {}) {
    if (document.sourceMismatch) return full(state);
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) return full(state);
    let previous = null;
    let damaged = false;
    try {
      previous = await io.readJsonWithDocumentIdentity(pathFor(document), {
        expectedIdentity: document, getIdentity: value => value,
        validate: value => validate(value, document),
        validateCandidate: (value, identity) => validate(value, identity),
      });
    } catch (error) {
      if (error.code === "DOC_KEY_COLLISION") return full(state);
      damaged = true;
    }
    const entries = Object.create(null);
    for (const [uuid, operation] of Object.entries(state.tombstones)) {
      const prior = previous?.entries?.[uuid];
      const same = prior && canonicalJson(prior.version) === canonicalJson(operation.version);
      const timestamp = operation.deletedAt;
      entries[uuid] = {
        version: operation.version,
        firstObservedAt: same ? prior.firstObservedAt :
          !damaged && Number.isSafeInteger(timestamp) && timestamp >= 0 && timestamp <= now &&
            now - timestamp < DELETION_RETENTION_MS ? timestamp : now,
      };
    }
    const changed = canonicalJson(entries) !== canonicalJson(previous?.entries || {});
    if (changed) {
      if (readOnly) return full(state);
      try {
        // The owner WAL directory already exists. Publish timing metadata
        // before permitting a full tombstone to leave an active snapshot.
        await io.writeJsonAtomic(pathFor(document), {
          schemaVersion: 1, kind: "pdf-reader-deletion-retention",
          docKey: document.docKey, documentId: document.documentId,
          sourceHash: document.source.sourceHash, deviceId, entries,
        }, { validate: (value) => validate(value, document) });
      } catch { return full(state); }
    }
    const tombstones = Object.create(null);
    const deletionGuards = [];
    for (const [uuid, operation] of Object.entries(state.tombstones)) {
      const firstObservedAt = entries[uuid].firstObservedAt;
      if (now >= firstObservedAt && now - firstObservedAt >= DELETION_RETENTION_MS) {
        deletionGuards.push({ uuid, version: operation.version, pageIndex: operation.pageIndex,
          embeddedRef: operation.embeddedRef ?? null });
      } else tombstones[uuid] = operation;
    }
    return { tombstones, deletionGuards };
  }

  function project(document, state, options) {
    const previous = queues.get(document.docKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => projectNow(document, state, options));
    const tracked = task.finally(() => {
      if (queues.get(document.docKey) === tracked) queues.delete(document.docKey);
    });
    queues.set(document.docKey, tracked);
    return tracked;
  }
  return { project, pathFor };
}

module.exports = { createDeletionRetention, DELETION_RETENTION_MS };
