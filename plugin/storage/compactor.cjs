/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { canonicalJson } = require("./canonical.cjs");
const { buildEffectiveState } = require("./effective-state.cjs");
const { createSidecarStore } = require("./sidecar-store.cjs");
const { runQueuedWalWrite } = require("./wal-writer-coordinator.cjs");

function codedError(code, message, cause) {
  const error = new Error(message);
  error.name = "WalSidecarError";
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

function uniqueOperations(operations) {
  const byText = new Map();
  for (const operation of operations) byText.set(canonicalJson(operation), operation);
  return [...byText.values()].sort((left, right) => {
    const a = `${left.type}\u0000${left.uuid || ""}\u0000${left.version.rev}\u0000${left.version.deviceId}\u0000${left.version.seq}`;
    const b = `${right.type}\u0000${right.uuid || ""}\u0000${right.version.rev}\u0000${right.version.deviceId}\u0000${right.version.seq}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function operationsFromState(state) {
  return uniqueOperations([
    ...Object.values(state.annotations || {}),
    ...Object.values(state.tombstones || {}),
    ...(state.routing ? [state.routing] : []),
  ]);
}

function entityKey(operation) {
  return operation.type === "ROUTE_SET" ? "route" : `annotation:${operation.uuid}`;
}

function sameOperation(left, right) {
  return Boolean(left && right) && canonicalJson(left) === canonicalJson(right);
}

const IMMUTABLE_SOURCE_FIELDS = Object.freeze([
  "sourceHash",
  "size",
  "pageCount",
  "orderedPageIdentities",
]);

function sourceIdentityDisagrees(left, right) {
  if (!left || !right) return false;
  if (left.initialPath !== undefined && right.initialPath !== undefined && left.initialPath !== right.initialPath) {
    return true;
  }
  if (left.fullSourceHash !== undefined && right.fullSourceHash !== undefined &&
      left.fullSourceHash !== right.fullSourceHash) return true;
  const leftSource = left.source && typeof left.source === "object" && !Array.isArray(left.source) ? left.source : {};
  const rightSource = right.source && typeof right.source === "object" && !Array.isArray(right.source) ? right.source : {};
  for (const key of IMMUTABLE_SOURCE_FIELDS) {
    if (leftSource[key] !== undefined && rightSource[key] !== undefined &&
        canonicalJson(leftSource[key]) !== canonicalJson(rightSource[key])) return true;
  }
  return false;
}

function validateDocumentSources(sidecar, validWals) {
  const documents = [sidecar?.document, ...validWals.map(({ wal }) => wal.document)]
    .filter((document) => document && typeof document === "object");
  for (let left = 0; left < documents.length; left += 1) {
    for (let right = left + 1; right < documents.length; right += 1) {
      if (sourceIdentityDisagrees(documents[left], documents[right])) {
        throw codedError("SOURCE_MISMATCH", "Verified sidecar and WAL contributors disagree about immutable PDF source identity.");
      }
    }
  }
}

function validateRouteSource(source, documents) {
  if (source === undefined) return;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw codedError("SOURCE_MISMATCH", "A routing update cannot replace immutable PDF source metadata.");
  }
  for (const document of documents) {
    if (sourceIdentityDisagrees(document, { source })) {
      throw codedError("SOURCE_MISMATCH", "A routing update cannot replace immutable PDF source identity fields.");
    }
  }
}

function operationRows(wal) {
  if (!wal) return [];
  return [
    ...(wal.anchor?.operations || []),
    ...(wal.tail || []),
  ];
}

function mergeWatermarks(existing, validWals, operations) {
  const watermarks = {};
  const add = (owner, sequence) => {
    if (typeof owner !== "string" || !Number.isSafeInteger(sequence) || sequence < 0) return;
    watermarks[owner] = Math.max(watermarks[owner] || 0, sequence);
  };
  for (const [owner, sequence] of Object.entries(existing || {})) add(owner, sequence);
  for (const { wal } of validWals) for (const operation of operationRows(wal)) {
    add(operation.version.deviceId, operation.seq);
  }
  for (const operation of operations) add(operation.version.deviceId, operation.seq);
  return Object.fromEntries(Object.entries(watermarks).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));
}

function normalizeThresholds(thresholds = {}) {
  const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return Object.freeze({
    maxTailOperations: positive(thresholds.maxTailOperations, 128),
    maxAnchorOperations: positive(thresholds.maxAnchorOperations, 1024),
    maxEstimatedBytes: positive(thresholds.maxEstimatedBytes, 1024 * 1024),
  });
}

function createWalCompactor({
  adapter,
  root,
  hash,
  verifyHash,
  deviceId,
  token = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  thresholds,
  sidecarStore,
  loadWals,
  readWal,
  writeWalUnlocked,
} = {}) {
  if (!adapter || typeof adapter !== "object") throw new TypeError("A DataAdapter is required for compaction.");
  if (typeof deviceId !== "string" || !deviceId) throw new TypeError("A stable deviceId is required for compaction.");
  if (typeof hash !== "function") throw new TypeError("An injected hash function is required for compaction.");
  if (typeof loadWals !== "function" || typeof readWal !== "function" || typeof writeWalUnlocked !== "function") {
    throw new TypeError("Compaction requires WAL load/read/write functions.");
  }
  const sidecars = sidecarStore || createSidecarStore({ adapter, root, hash, verifyHash, token });
  const compactThresholds = normalizeThresholds(thresholds);

  async function loadSidecarOrNull(document) {
    try { return await sidecars.loadSidecar(document); }
    catch (error) {
      if (error?.code === "WAL_FILE_INVALID") return null;
      throw error;
    }
  }

  async function compact(document) {
    const docKey = document?.docKey;
    if (typeof docKey !== "string" || !docKey) throw new TypeError("A document docKey is required for compaction.");
    return runQueuedWalWrite(adapter, deviceId, docKey, async () => {
      const [sidecar, loaded] = await Promise.all([
        loadSidecarOrNull(document),
        loadWals(document),
      ]);
      if ((loaded.errors || []).length) {
        const error = codedError("WAL_COMPACTION_INCOMPLETE", "Compaction stopped because one or more WALs could not be verified.");
        error.details = loaded.errors;
        throw error;
      }
      const validWals = loaded.valid || [];
      validateDocumentSources(sidecar, validWals);
      const ownEntry = validWals.find((entry) => entry.deviceId === deviceId) || null;
      const ownWal = ownEntry?.wal || await readWal(document, deviceId).catch((error) => {
        if (error?.code === "WAL_FILE_INVALID") return null;
        throw error;
      });
      const ownWatermark = sidecar?.watermark?.[deviceId] || 0;
      if (ownWatermark > 0 && (!ownWal || ownWal.nextSeq <= ownWatermark)) {
        throw codedError(
          "WAL_SEQ_REGRESSION",
          "Compaction cannot publish a missing or stale device WAL below the sidecar watermark.",
        );
      }

      const anchors = validWals.map(({ wal }) => wal.anchor || { operations: [] });
      const tails = validWals.map(({ wal }) => ({ operations: wal.tail || [] }));
      let state;
      try { state = buildEffectiveState({ sidecar, anchors, tails }); }
      catch (error) { throw codedError(error?.code || "WAL_EFFECTIVE_STATE_INVALID", "Cannot compact conflicting WAL state.", error); }
      const contributorDocuments = [sidecar?.document, ...validWals.map(({ wal }) => wal.document)]
        .filter((metadata) => metadata && typeof metadata === "object");
      validateRouteSource(state.routing?.payload?.source, contributorDocuments);
      const winners = operationsFromState(state);
      const winnerByEntity = new Map(winners.map((operation) => [entityKey(operation), operation]));

      const otherWalWitnesses = new Map();
      for (const entry of validWals) {
        if (entry.deviceId === deviceId) continue;
        for (const operation of operationRows(entry.wal)) {
          const key = canonicalJson(operation);
          if (!otherWalWitnesses.has(key)) otherWalWitnesses.set(key, new Set());
          otherWalWitnesses.get(key).add(entry.deviceId);
        }
      }

      const retained = [];
      const oldOwnRows = operationRows(ownWal);
      for (const operation of oldOwnRows) {
        const winner = winnerByEntity.get(entityKey(operation));
        if (sameOperation(operation, winner)) {
          retained.push(operation);
          continue;
        }
        if (winner?.version.deviceId === deviceId) {
          // The newest local operation is copied into the new anchor below,
          // so it durably supersedes older local rows for this object.
          continue;
        }
        const witness = winner && otherWalWitnesses.get(canonicalJson(winner));
        // The sidecar is a rebuild cache, not proof that another device has a
        // durable copy. Keep a dominated contribution unless another valid
        // device WAL contains the exact winning operation.
        if (!witness || witness.size === 0) retained.push(operation);
      }

      for (const operation of winners) {
        if (operation.version.deviceId === deviceId) retained.push(operation);
      }
      const anchorOperations = uniqueOperations(retained);

      const observedOwnSequences = [
        ...operationRows(ownWal),
        ...validWals.flatMap(({ wal }) => operationRows(wal)),
        ...(sidecar?.operations || []),
      ].filter((operation) => operation.version.deviceId === deviceId)
        .map((operation) => operation.seq);
      const previousNextSeq = ownWal?.nextSeq || 1;
      const previousThroughSeq = ownWal?.anchor?.throughSeq || 0;
      const observedMaxSeq = observedOwnSequences.length ? Math.max(...observedOwnSequences) : 0;
      const tailRows = ownWal?.tail || [];
      const throughSeq = Math.max(previousThroughSeq, observedMaxSeq);
      const nextSeq = Math.max(previousNextSeq, throughSeq + 1, 1);

      const metadata = ownWal?.document || sidecar?.document || {
        documentId: document.documentId,
        docKey: document.docKey,
        ...(document.initialPath ? { initialPath: document.initialPath } : {}),
        ...(document.fullSourceHash ? { fullSourceHash: document.fullSourceHash } : {}),
        ...(document.source !== undefined ? { source: document.source } : {}),
        ...(document.legacyIdentities !== undefined ? { legacyIdentities: document.legacyIdentities } : {}),
        ...(document.legacyIdentityScanComplete !== undefined
          ? { legacyIdentityScanComplete: document.legacyIdentityScanComplete } : {}),
      };
      const sidecarDocument = { ...(sidecar?.document || metadata) };
      const anchor = {
        throughSeq,
        operations: anchorOperations,
      };

      const sourceEnvelope = {
        schemaVersion: 1,
        kind: "pdf-reader-materialized-sidecar",
        document: sidecarDocument,
        operations: winners,
        watermark: mergeWatermarks(sidecar?.watermark, validWals, winners),
      };
      if (state.routing?.payload && typeof state.routing.payload === "object") {
        const route = state.routing.payload;
        for (const key of ["sourcePath", "source", "legacyIdentities", "legacyIdentityScanComplete"]) {
          if (Object.prototype.hasOwnProperty.call(route, key)) sourceEnvelope.document[key] = route[key];
        }
      }

      // Publish the complete merged snapshot before pruning any WAL rows. A
      // failed sidecar write leaves all old WAL evidence in place.
      const writtenSidecar = await sidecars.writeSidecar(document, sourceEnvelope);

      const walInput = {
        schemaVersion: 1,
        kind: "pdf-reader-device-wal",
        documentId: document.documentId,
        docKey: document.docKey,
        deviceId,
        document: metadata,
        nextSeq,
        anchor,
        tail: [],
      };
      const writtenWal = await writeWalUnlocked(document, walInput, { allowPrune: true });

      const serializedBytes = canonicalJson({ sidecar: writtenSidecar, wal: writtenWal }).length;
      const thresholdState = Object.freeze({
        tailOperations: tailRows.length,
        anchorOperations: ownWal?.anchor?.operations?.length || 0,
        estimatedBytes: serializedBytes,
        eligible: tailRows.length >= compactThresholds.maxTailOperations ||
          anchorOperations.length >= compactThresholds.maxAnchorOperations ||
          serializedBytes >= compactThresholds.maxEstimatedBytes,
      });

      return {
        documentId: document.documentId,
        docKey,
        state,
        sidecar: writtenSidecar,
        wal: writtenWal,
        errors: loaded.errors || [],
        retainedOperationCount: anchorOperations.length,
        evictedOperationCount: Math.max(0, oldOwnRows.length - anchorOperations.length),
        thresholds: thresholdState,
      };
    });
  }

  return Object.freeze({ compact, thresholds: compactThresholds });
}

module.exports = { createWalCompactor, normalizeThresholds };
