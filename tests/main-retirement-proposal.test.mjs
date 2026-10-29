import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { makeMainSnapshotCandidate } = require("../plugin/storage/main-snapshot-candidate.cjs");
const { makeRetirementProposal } = require("../plugin/storage/main-retirement-proposal.cjs");
const { RETIRE_AFTER_MS } = require("../plugin/storage/main-snapshot-device-observation.cjs");
const hash = (value) => `sha256-v1:${createHash("sha256").update(value).digest("hex")}`;
const document = { docKey: "123456abcdef", documentId: "book-id", source: { sourceHash: hash("source") } };
const operation = { type: "ANNOTATION_SET", uuid: "a", kind: "Highlight", pageIndex: 0, payload: { text: "a" },
  seq: 5, opId: "ipad-B:123456abcdef:5", version: { rev: 2, deviceId: "ipad-B", seq: 5 } };
async function fixture() {
  const checkpoint = await makeMainSnapshotCandidate({ document, operations: [operation], hash,
    segments: [{ deviceId: "ipad-B", firstSeq: 1, lastSeq: 9, digest: hash("archive") }] });
  const now = 100 + RETIRE_AFTER_MS, presenceDigest = hash("presence");
  return { document, checkpoint, deviceId: "ipad-B", observerId: "windows-A", now, presenceDigest,
    observation: { digest: presenceDigest, firstObservedAt: 100, lastObservedAt: now, clockUncertain: false },
    deviceIds: ["ipad-B", "windows-A"], acknowledgements: [{ deviceId: "windows-A", snapshotId: checkpoint.snapshotId, verified: true }], hash };
}
test("a retirement proposal is bound to a verified checkpoint, fresh observation and every remaining device ACK", async () => {
  const args = await fixture();
  const proposal = await makeRetirementProposal(args);
  assert.equal(proposal.deviceId, "ipad-B");
  assert.equal(proposal.throughSeq, 9);
  assert.equal(proposal.checkpointId, args.checkpoint.snapshotId);
  assert.deepEqual(proposal.deviceIds, ["ipad-B", "windows-A"]);
});
test("a retirement proposal fails closed for stale activity, missing ACK or tampered checkpoint", async () => {
  const args = await fixture();
  await assert.rejects(makeRetirementProposal({ ...args, now: args.now + 1 }), { code: "MAIN_RETIREMENT_PENDING" });
  await assert.rejects(makeRetirementProposal({ ...args, presenceDigest: hash("new activity") }), { code: "MAIN_RETIREMENT_PENDING" });
  await assert.rejects(makeRetirementProposal({ ...args, acknowledgements: [] }), { code: "MAIN_RETIREMENT_PENDING" });
  await assert.rejects(makeRetirementProposal({ ...args, deviceIds: ["ipad-B", "windows-A", "mac-C"] }), { code: "MAIN_RETIREMENT_PENDING" });
  const damaged = structuredClone(args.checkpoint); damaged.value.operations[0].payload.text = "tampered";
  await assert.rejects(makeRetirementProposal({ ...args, checkpoint: damaged }), { code: "MAIN_SNAPSHOT_INVALID" });
});
