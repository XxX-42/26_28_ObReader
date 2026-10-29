/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// Plans only: selection neither authorizes deletion nor asserts that a
// snapshot covers the chosen archives. The caller must independently verify
// coverage, device acknowledgements and a recoverable checkpoint pair.
function planMainSnapshotMaintenance({ snapshots, archives, maxFiles = 3 } = {}) {
  if (!Array.isArray(snapshots) || !Array.isArray(archives) || !Number.isSafeInteger(maxFiles) || maxFiles < 3) {
    throw new TypeError("Snapshots and archives must be arrays and the file limit must be at least three.");
  }
  const paths = new Set();
  for (const item of [...snapshots, ...archives]) {
    if (!item || typeof item.path !== "string" || !item.path || paths.has(item.path)) {
      throw new TypeError("Every file must have a distinct path.");
    }
    paths.add(item.path);
  }
  const fileCount = snapshots.length + archives.length;
  if (fileCount <= maxFiles) return { fileCount, needed: false, mergeArchives: [] };
  const eligible = archives.filter((item) => item.sealed === true && item.verified === true);
  for (const item of eligible) {
    if (typeof item.deviceId !== "string" || !item.deviceId || !Number.isSafeInteger(item.firstSeq) ||
        !Number.isSafeInteger(item.lastSeq) || item.firstSeq < 0 || item.lastSeq < item.firstSeq ||
        !Number.isSafeInteger(item.firstObservedAt) || item.firstObservedAt < 0) {
      throw new TypeError("Verified sealed archives need a device, sequence range and observed time.");
    }
  }
  // Observation time is only a maintenance preference, never a conflict or
  // version order; filenames give a deterministic tie break across clients.
  eligible.sort((a, b) => a.firstObservedAt - b.firstObservedAt ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // Keep the latest archive as well as current and recovery snapshots when
  // possible. Unsafe/unverified inputs remain untouched regardless of count.
  const mergeArchives = eligible.slice(0, Math.max(0, eligible.length - 1));
  return { fileCount, needed: true, mergeArchives: mergeArchives.map((item) => item.path) };
}

// This predicate checks supplied evidence; it must not be used against an
// unverified roster or snapshots and does not itself perform deletion.
function coveredByCheckpointPair({ current, previous, archive, activeDeviceIds, acknowledgements } = {}) {
  if (!current || !previous || current.snapshotId === previous.snapshotId || !archive ||
      !Array.isArray(activeDeviceIds) || !Array.isArray(acknowledgements) || !activeDeviceIds.length) return false;
  if (archive.sealed !== true || archive.verified !== true || !/^sha256-v1:[a-f0-9]{64}$/.test(archive.digest || "")) return false;
  const covers = (snapshot) => Array.isArray(snapshot.value?.segments) && snapshot.value.segments.some((segment) =>
    segment.deviceId === archive.deviceId && segment.firstSeq === archive.firstSeq &&
    segment.lastSeq === archive.lastSeq && segment.digest === archive.digest);
  if (!covers(current) || !covers(previous)) return false;
  const roster = new Set(activeDeviceIds);
  if (roster.size !== activeDeviceIds.length || [...roster].some((id) => typeof id !== "string" || !id)) return false;
  return [...roster].every((deviceId) => acknowledgements.some((ack) =>
    ack.deviceId === deviceId && ack.snapshotId === current.snapshotId && ack.verified === true));
}

// This is an advisory plan, never an authorization to remove a file. A
// caller must revalidate ancestry, device acknowledgements and bytes at the
// deletion boundary. Unverified or unacknowledged branches are retained.
function planSnapshotRetention({ snapshots, maxSnapshots = 10 } = {}) {
  if (!Array.isArray(snapshots) || !Number.isSafeInteger(maxSnapshots) || maxSnapshots < 2) {
    throw new TypeError("Snapshot retention requires an array and at least two slots.");
  }
  const paths = new Set();
  for (const item of snapshots) {
    if (!item || typeof item.path !== "string" || !item.path || paths.has(item.path)) {
      throw new TypeError("Every snapshot must have a distinct path.");
    }
    paths.add(item.path);
  }
  const excess = Math.max(0, snapshots.length - maxSnapshots);
  const eligible = snapshots.filter((item) => item.verified === true && item.acknowledged === true &&
    item.coveredByRecoveryPair === true && item.protected !== true &&
    Number.isSafeInteger(item.firstObservedAt) && item.firstObservedAt >= 0)
    .sort((a, b) => a.firstObservedAt - b.firstObservedAt || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const removable = eligible.slice(0, Math.min(excess, Math.max(0, snapshots.length - 2)));
  return { snapshotCount: snapshots.length, maxSnapshots,
    candidates: removable.map((item) => item.path), deferred: excess - removable.length };
}

module.exports = { planMainSnapshotMaintenance, coveredByCheckpointPair, planSnapshotRetention };
