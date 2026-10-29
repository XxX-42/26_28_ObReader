import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { makeMainSnapshotCandidate, verifyMainSnapshotCandidate, mergeMainSnapshotOperations, containsReceipts } = require("../plugin/storage/main-snapshot-candidate.cjs");
const sha = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
const document = { docKey: "123456abcdef", documentId: "document-a", source: { sourceHash: sha("pdf") } };
const op = (uuid, deviceId, rev, deleted = false) => ({ type: deleted ? "ANNOTATION_DELETE" : "ANNOTATION_SET",
  uuid, kind: "Highlight", pageIndex: 0, seq: rev, opId: `${deviceId}-${rev}`,
  version: { rev, deviceId, seq: rev }, ...(deleted ? {} : { payload: { text: uuid } }) });

test("a full-version receipt upgrades a legacy receipt without weakening its coverage", async () => {
  const legacy = { deviceId: "windows", uuid: "a", originOpId: "request", opId: "windows-1", inputHash: sha("input") };
  const extended = { ...legacy, version: { rev: 1, deviceId: "windows", seq: 1 } };
  const snapshot = await makeMainSnapshotCandidate({ document, operations: [], receipts: [legacy, extended], hash: sha });
  assert.deepEqual(snapshot.value.receipts, [extended]);
  assert.equal(containsReceipts(snapshot.value, { receipts: [legacy] }), true);
  assert.equal(containsReceipts({ receipts: [legacy] }, snapshot.value), false);
  const conflict = { ...extended, version: { ...extended.version, rev: 2 } };
  await assert.rejects(makeMainSnapshotCandidate({ document, operations: [], receipts: [extended, conflict], hash: sha }),
    { code: "MAIN_SNAPSHOT_INVALID" });
  const withDeletionTime = { ...extended, deletedAt: 1234 };
  const upgraded = await makeMainSnapshotCandidate({ document, operations: [], receipts: [withDeletionTime, extended], hash: sha });
  assert.deepEqual(upgraded.value.receipts, [withDeletionTime]);
  assert.equal(containsReceipts(upgraded.value, { receipts: [extended] }), true);
  assert.equal(containsReceipts({ receipts: [extended] }, upgraded.value), false);
  await assert.rejects(makeMainSnapshotCandidate({ document, operations: [],
    receipts: [withDeletionTime, { ...withDeletionTime, deletedAt: 5678 }], hash: sha }), { code: "MAIN_SNAPSHOT_INVALID" });
});

test("candidate snapshots are deterministic across input order and preserve winner versions", async () => {
  const operations = [op("a", "windows", 1), op("b", "ipad", 1), op("a", "windows", 2, true)];
  const first = await makeMainSnapshotCandidate({ document, operations, hash: sha });
  const second = await makeMainSnapshotCandidate({ document, operations: operations.reverse(), hash: sha });
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(first.value.operations.find((entry) => entry.uuid === "a").type, "ANNOTATION_DELETE");
  assert.equal(first.value.operations.find((entry) => entry.uuid === "b").payload.text, "b");
});

test("independent snapshot branches join without reviving a newer deletion", async () => {
  const left = await makeMainSnapshotCandidate({ document, operations: [op("a", "windows", 2, true), op("b", "windows", 1)], hash: sha });
  const right = await makeMainSnapshotCandidate({ document, operations: [op("a", "ipad", 1), op("c", "ipad", 1)], hash: sha });
  const state = await mergeMainSnapshotOperations(document, [left, right], [], sha);
  assert.deepEqual(Object.keys(state.annotations).sort(), ["b", "c"]);
  assert.deepEqual(Object.keys(state.tombstones), ["a"]);
  await assert.rejects(mergeMainSnapshotOperations({ ...document, documentId: "other" }, [left], [], sha),
    { code: "MAIN_SNAPSHOT_INVALID" });
});

test("candidate rejects unsupported hashes and overlapping claimed coverage", async () => {
  const digest = sha("segment");
  await assert.rejects(makeMainSnapshotCandidate({ document, operations: [], hash: sha,
    segments: [{ deviceId: "a", firstSeq: 1, lastSeq: 3, digest },
      { deviceId: "a", firstSeq: 3, lastSeq: 4, digest }] }), { code: "MAIN_SNAPSHOT_INVALID" });
  await assert.rejects(makeMainSnapshotCandidate({ document, operations: [], hash: () => "xxh64-v1:0123456789abcdef" }),
    { code: "MAIN_SNAPSHOT_INVALID" });
});

test("candidate verification rejects changed payload, wrong digest, and source replacement", async () => {
  const candidate = await makeMainSnapshotCandidate({ document, operations: [op("a", "windows", 1)], hash: sha });
  assert.deepEqual(await verifyMainSnapshotCandidate({ document, ...candidate, hash: sha }), candidate.value);
  const changed = structuredClone(candidate.value);
  changed.operations[0].payload.text = "tampered";
  await assert.rejects(verifyMainSnapshotCandidate({ document, snapshotId: candidate.snapshotId, value: changed, hash: sha }),
    { code: "MAIN_SNAPSHOT_INVALID" });
  await assert.rejects(verifyMainSnapshotCandidate({ document, ...candidate, snapshotId: sha("wrong"), hash: sha }),
    { code: "MAIN_SNAPSHOT_INVALID" });
  await assert.rejects(verifyMainSnapshotCandidate({ document: { ...document, source: { sourceHash: sha("other") } },
    ...candidate, hash: sha }), { code: "MAIN_SNAPSHOT_INVALID" });
});
