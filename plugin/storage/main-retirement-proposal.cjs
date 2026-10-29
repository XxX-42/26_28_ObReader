/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { isRetirementCandidate } = require("./main-snapshot-device-observation.cjs");
const { verifyMainSnapshotCandidate } = require("./main-snapshot-candidate.cjs");
const pending = (message) => Object.assign(new Error(message), { code: "MAIN_RETIREMENT_PENDING" });
const safeId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id);

// Evidence validation only. A local roster and readback do not prove that
// every offline client or every Sync file has arrived. This proposal does not
// publish a retirement, change device identity or authorize deletion.
async function makeRetirementProposal({ document, checkpoint, deviceId, observerId, now, presenceDigest,
  observation, deviceIds, acknowledgements, hash } = {}) {
  if (!safeId(deviceId) || !safeId(observerId) || deviceId === observerId || !Array.isArray(deviceIds) ||
      !Array.isArray(acknowledgements) || !deviceIds.length || deviceIds.some((id) => !safeId(id)) ||
      new Set(deviceIds).size !== deviceIds.length || !deviceIds.includes(deviceId) || !deviceIds.includes(observerId)) {
    throw pending("A complete observed device set and a different observer are required.");
  }
  if (!/^sha256-v1:[a-f0-9]{64}$/.test(presenceDigest || "") || observation?.digest !== presenceDigest ||
      !isRetirementCandidate(observation, now)) throw pending("The device inactivity observation is stale or incomplete.");
  const snapshot = await verifyMainSnapshotCandidate({ document, snapshotId: checkpoint?.snapshotId, value: checkpoint?.value, hash });
  for (const id of deviceIds.filter((candidate) => candidate !== deviceId)) {
    if (!acknowledgements.some((ack) => ack?.deviceId === id && ack.snapshotId === checkpoint.snapshotId && ack.verified === true)) {
      throw pending("Every other observed device must confirm the exact checkpoint.");
    }
  }
  const seqs = [0,
    ...snapshot.segments.filter((row) => row.deviceId === deviceId).map((row) => row.lastSeq),
    ...snapshot.operations.filter((row) => row.version.deviceId === deviceId).map((row) => row.seq),
    ...snapshot.receipts.filter((row) => row.deviceId === deviceId && row.version).map((row) => row.version.seq),
  ];
  return { schemaVersion: 1, kind: "pdf-reader-retirement-proposal", documentId: document.documentId,
    docKey: document.docKey, sourceHash: document.source.sourceHash, checkpointId: checkpoint.snapshotId,
    deviceId, observerId, deviceIds: [...deviceIds].sort(), presenceDigest,
    observedSince: observation.firstObservedAt, observedAt: now, throughSeq: Math.max(...seqs) };
}
module.exports = { makeRetirementProposal };
