/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// Candidate construction only. This module does not publish, authorize a
// checkpoint, discard any WAL, or replace the current recovery protocol.
const { canonicalJson } = require("./canonical.cjs");
const { joinOperations } = require("./merge-engine.cjs");
const { validateVersion } = require("./version.cjs");

function receiptCovers(current, previous) {
  if (!current || !previous) return false;
  const { version: currentVersion, deletedAt: currentDeletedAt, ...currentBase } = current;
  const { version: previousVersion, deletedAt: previousDeletedAt, ...previousBase } = previous;
  return canonicalJson(currentBase) === canonicalJson(previousBase) &&
    (previousVersion === undefined || (currentVersion !== undefined && canonicalJson(currentVersion) === canonicalJson(previousVersion))) &&
    (previousDeletedAt === undefined || currentDeletedAt === previousDeletedAt);
}

function fail(message) {
  return Object.assign(new Error(message), { code: "MAIN_SNAPSHOT_INVALID" });
}

function identity(document) {
  if (!document || !/^[a-f0-9]{12}$/.test(document.docKey || "") ||
      typeof document.documentId !== "string" || !document.documentId ||
      typeof document.source?.sourceHash !== "string" || !document.source.sourceHash) {
    throw fail("A complete verified document identity is required.");
  }
  return { docKey: document.docKey, documentId: document.documentId,
    sourceHash: document.source.sourceHash };
}

function winnerOperations(state) {
  return [...Object.values(state.annotations), ...Object.values(state.tombstones),
    ...(state.routing ? [state.routing] : [])].sort((a, b) => {
    const keyA = a.type === "ROUTE_SET" ? "\uffffroute" : a.uuid;
    const keyB = b.type === "ROUTE_SET" ? "\uffffroute" : b.uuid;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}

async function makeMainSnapshotCandidate({ document, operations, parents = [], segments = [], receipts = [], hash }) {
  const id = identity(document);
  if (!Array.isArray(operations) || !Array.isArray(parents) || !Array.isArray(segments) || !Array.isArray(receipts) || typeof hash !== "function") {
    throw fail("Operations, parents, segments and a SHA-256 implementation are required.");
  }
  const parentIds = [...new Set(parents)].sort();
  if (parentIds.some((value) => typeof value !== "string" || !/^sha256-v1:[a-f0-9]{64}$/.test(value))) {
    throw fail("Snapshot parents must use full SHA-256 identities.");
  }
  const segmentRows = segments.map((segment) => {
    if (!segment || typeof segment.deviceId !== "string" || !segment.deviceId ||
        !Number.isSafeInteger(segment.firstSeq) || segment.firstSeq < 0 ||
        !Number.isSafeInteger(segment.lastSeq) || segment.lastSeq < segment.firstSeq ||
        !/^sha256-v1:[a-f0-9]{64}$/.test(segment.digest || "")) {
      throw fail("A segment needs a device, sequence range and full SHA-256 digest.");
    }
    return { deviceId: segment.deviceId, firstSeq: segment.firstSeq,
      lastSeq: segment.lastSeq, digest: segment.digest };
  }).sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0) ||
    a.firstSeq - b.firstSeq || a.lastSeq - b.lastSeq ||
    (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  for (let i = 1; i < segmentRows.length; i++) {
    const a = segmentRows[i - 1], b = segmentRows[i];
    if (a.deviceId === b.deviceId && b.firstSeq <= a.lastSeq) throw fail("Segment ranges overlap.");
  }
  const receiptMap = new Map();
  for (const entry of receipts) {
    if (!entry || typeof entry.deviceId !== "string" || !entry.deviceId || typeof entry.uuid !== "string" || !entry.uuid ||
        typeof entry.originOpId !== "string" || !entry.originOpId || typeof entry.opId !== "string" || !entry.opId ||
        !/^sha256-v1:[a-f0-9]{64}$/.test(entry.inputHash || "")) throw fail("Invalid durable operation receipt.");
    const row = { deviceId: entry.deviceId, uuid: entry.uuid, originOpId: entry.originOpId,
      opId: entry.opId, inputHash: entry.inputHash,
      ...(entry.version === undefined ? {} : { version: validateVersion(entry.version) }),
      ...(entry.deletedAt === undefined ? {} : { deletedAt: entry.deletedAt }) };
    if (row.version && row.version.deviceId !== row.deviceId) throw fail("Receipt version owner differs.");
    if (row.deletedAt !== undefined && (!Number.isSafeInteger(row.deletedAt) || row.deletedAt < 0)) throw fail("Receipt deletion time is invalid.");
    const key = canonicalJson([row.deviceId, row.uuid, row.originOpId]);
    const prior = receiptMap.get(key);
    if (prior && !receiptCovers(prior, row) && !receiptCovers(row, prior)) throw fail("Durable operation receipt collision.");
    receiptMap.set(key, prior && receiptCovers(prior, row) ? prior : row);
  }
  const receiptRows = [...receiptMap.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
  const value = { schemaVersion: 1, kind: "pdf-reader-main-snapshot-candidate", ...id,
    parents: parentIds, segments: segmentRows, receipts: receiptRows, operations: winnerOperations(joinOperations(operations)) };
  const snapshotId = await hash(new TextEncoder().encode(canonicalJson(value)));
  if (!/^sha256-v1:[a-f0-9]{64}$/.test(snapshotId || "")) throw fail("Snapshot hashing must use SHA-256.");
  return { snapshotId, value };
}

async function verifyMainSnapshotCandidate({ document, snapshotId, value, hash }) {
  if (!value || value.kind !== "pdf-reader-main-snapshot-candidate" || value.schemaVersion !== 1 ||
      value.docKey !== document?.docKey || value.documentId !== document?.documentId ||
      value.sourceHash !== document?.source?.sourceHash) throw fail("Snapshot identity or source differs.");
  const rebuilt = await makeMainSnapshotCandidate({ document, operations: value.operations,
    parents: value.parents, segments: value.segments, receipts: value.receipts, hash });
  if (rebuilt.snapshotId !== snapshotId || canonicalJson(rebuilt.value) !== canonicalJson(value)) {
    throw fail("Snapshot bytes or identity failed validation.");
  }
  return rebuilt.value;
}

async function mergeMainSnapshotOperations(document, snapshots, extraOperations = [], hash) {
  identity(document);
  if (!Array.isArray(snapshots) || !Array.isArray(extraOperations)) throw fail("Invalid snapshot branches.");
  const sources = [];
  for (const snapshot of snapshots) {
    const verified = await verifyMainSnapshotCandidate({ document, snapshotId: snapshot?.snapshotId,
      value: snapshot?.value, hash });
    sources.push(verified.operations);
  }
  return joinOperations(...sources, extraOperations);
}

function containsReceipts(current, previous) {
  const records = new Map((current.receipts || []).map((row) => [canonicalJson([row.deviceId, row.uuid, row.originOpId]), row]));
  return (previous.receipts || []).every((row) =>
    receiptCovers(records.get(canonicalJson([row.deviceId, row.uuid, row.originOpId])), row));
}

module.exports = { makeMainSnapshotCandidate, verifyMainSnapshotCandidate, mergeMainSnapshotOperations, containsReceipts };
