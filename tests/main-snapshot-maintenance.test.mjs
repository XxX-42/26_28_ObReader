import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { planMainSnapshotMaintenance, coveredByCheckpointPair, planSnapshotRetention } = require("../plugin/storage/main-snapshot-maintenance.cjs");
const archive = (n, extra = {}) => ({ path: `archive-${n}`, deviceId: "device", firstSeq: n,
  lastSeq: n, firstObservedAt: n, sealed: true, verified: true, ...extra });

test("the threshold counts snapshots and archives together", () => {
  assert.deepEqual(planMainSnapshotMaintenance({ snapshots: [{ path: "main" }], archives: [archive(1), archive(2)] }),
    { fileCount: 3, needed: false, mergeArchives: [] });
  assert.deepEqual(planMainSnapshotMaintenance({ snapshots: [{ path: "main" }], archives: [archive(3), archive(1), archive(2)] }),
    { fileCount: 4, needed: true, mergeArchives: ["archive-1", "archive-2"] });
});

test("the plan never selects unsealed or unverified files and does not count active logs", () => {
  const result = planMainSnapshotMaintenance({ snapshots: [{ path: "main" }, { path: "previous" }],
    archives: [archive(1), archive(2, { sealed: false }), archive(3, { verified: false }), archive(4)] });
  assert.equal(result.fileCount, 6);
  assert.deepEqual(result.mergeArchives, ["archive-1"]);
});

test("duplicate file identities cannot inflate or corrupt the decision", () => {
  assert.throws(() => planMainSnapshotMaintenance({ snapshots: [{ path: "same" }], archives: [archive(1, { path: "same" })] }), TypeError);
});

test("archive eligibility requires exact coverage in two distinct checkpoints and every device acknowledgement", () => {
  const digest = `sha256-v1:${"a".repeat(64)}`;
  const item = archive(1, { digest });
  const segment = { deviceId: item.deviceId, firstSeq: item.firstSeq, lastSeq: item.lastSeq, digest };
  const current = { snapshotId: "current", value: { segments: [segment] } };
  const previous = { snapshotId: "previous", value: { segments: [segment] } };
  const acknowledgements = ["windows", "ipad"].map((deviceId) => ({ deviceId, snapshotId: "current", verified: true }));
  const evidence = { current, previous, archive: item, activeDeviceIds: ["windows", "ipad"], acknowledgements };
  assert.equal(coveredByCheckpointPair(evidence), true);
  assert.equal(coveredByCheckpointPair({ ...evidence, previous: current }), false);
  assert.equal(coveredByCheckpointPair({ ...evidence, previous: { ...previous, value: { segments: [] } } }), false);
  assert.equal(coveredByCheckpointPair({ ...evidence, archive: { ...item, digest: `sha256-v1:${"b".repeat(64)}` } }), false);
  assert.equal(coveredByCheckpointPair({ ...evidence, acknowledgements: acknowledgements.slice(0, 1) }), false);
  assert.equal(coveredByCheckpointPair({ ...evidence, archive: { ...item, sealed: false } }), false);
});

test("ten-snapshot limit selects only verified, acknowledged, covered and unprotected old snapshots", () => {
  const snapshots = Array.from({ length: 12 }, (_, n) => ({ path: `s${n}`, firstObservedAt: n,
    verified: true, acknowledged: true, coveredByRecoveryPair: true }));
  snapshots[0].protected = true;
  snapshots[1].acknowledged = false;
  assert.deepEqual(planSnapshotRetention({ snapshots }),
    { snapshotCount: 12, maxSnapshots: 10, candidates: ["s2", "s3"], deferred: 0 });
  for (const row of snapshots) row.protected = true;
  assert.deepEqual(planSnapshotRetention({ snapshots }),
    { snapshotCount: 12, maxSnapshots: 10, candidates: [], deferred: 2 });
  assert.deepEqual(planSnapshotRetention({ snapshots: snapshots.slice(0, 10) }).candidates, []);
});
