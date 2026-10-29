import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const { canonicalJson } = require("../plugin/storage/canonical.cjs");
const { makeMainSnapshotCandidate } = require("../plugin/storage/main-snapshot-candidate.cjs");
const { classifyRetiredOperations } = require("../plugin/storage/main-retirement-classifier.cjs");
const hash = (value) => `sha256-v1:${createHash("sha256").update(value).digest("hex")}`;
const document = { docKey: "123456abcdef", documentId: "book-id", source: { sourceHash: hash("source") } };
const op = (uuid, seq, deviceId = "ipad-B") => ({ type: "ANNOTATION_SET", uuid, kind: "Highlight", pageIndex: 0,
  payload: { text: uuid }, originOpId: `viewer-${uuid}`, seq, opId: `${deviceId}:${document.docKey}:${seq}`,
  version: { deviceId, seq, rev: 1 } });
async function receipt(operation) {
  const { seq, version, opId, deletedAt, ...input } = operation;
  return { deviceId: version.deviceId, uuid: input.uuid, originOpId: input.originOpId, opId,
    inputHash: hash(new TextEncoder().encode(canonicalJson(input))) };
}

test("retirement classifier retains exact checkpointed operations and quarantines unseen or altered late data", async () => {
  const known = op("known", 1), superseded = op("older", 2), late = op("late", 3);
  const checkpoint = await makeMainSnapshotCandidate({ document, operations: [known], receipts: [await receipt(superseded)], hash });
  const changed = { ...superseded, payload: { text: "different" } };
  const changedVersion = { ...known, version: { ...known.version, rev: 2 } };
  const otherDevice = op("other", 1, "windows-A");
  const original = structuredClone([known, superseded, changed, changedVersion, late, otherDevice]);
  const classified = await classifyRetiredOperations({ document, checkpoint, deviceId: "ipad-B", throughSeq: 2,
    operations: original, hash });
  assert.deepEqual(classified.covered, [known]);
  assert.deepEqual(classified.quarantined, [superseded, changed, changedVersion, late],
    "a receipt without the original full version is insufficient proof to discard an old row");
  assert.deepEqual(classified.active, [otherDevice]);
  assert.deepEqual(original, [known, superseded, changed, changedVersion, late, otherDevice], "classification never changes input data");
});

test("retirement classifier rejects unverifiable checkpoints and quarantines ambiguous old rows", async () => {
  const known = op("known", 1);
  const checkpoint = await makeMainSnapshotCandidate({ document, operations: [known], hash });
  const ambiguous = op("missing", 1);
  const result = await classifyRetiredOperations({ document, checkpoint, deviceId: "ipad-B", throughSeq: 1,
    operations: [ambiguous], hash });
  assert.deepEqual(result.quarantined, [ambiguous]);
  const damaged = structuredClone(checkpoint); damaged.value.operations[0].payload.text = "damaged";
  await assert.rejects(classifyRetiredOperations({ document, checkpoint: damaged, deviceId: "ipad-B", throughSeq: 1,
    operations: [known], hash }), { code: "MAIN_SNAPSHOT_INVALID" });
});

test("a full-version receipt proves a superseded set, but not altered versions or deletion timestamps", async () => {
  const old = op("older", 1);
  const fullReceipt = { ...(await receipt(old)), version: old.version };
  const checkpoint = await makeMainSnapshotCandidate({ document, operations: [op("new", 2)], receipts: [fullReceipt], hash });
  const changedVersion = { ...old, version: { ...old.version, rev: 2 } };
  const fakeDeletedAt = { ...old, deletedAt: 123 };
  const result = await classifyRetiredOperations({ document, checkpoint, deviceId: "ipad-B", throughSeq: 2,
    operations: [old, changedVersion, fakeDeletedAt], hash });
  assert.deepEqual(result.covered, [old]);
  assert.deepEqual(result.quarantined, [changedVersion, fakeDeletedAt]);
});

test("a versioned deletion receipt also binds deletion time before classifying a superseded tombstone", async () => {
  const { payload, ...base } = op("deleted", 1);
  const old = { ...base, type: "ANNOTATION_DELETE", deletedAt: 1234 };
  const exactReceipt = { ...(await receipt(old)), version: old.version, deletedAt: old.deletedAt };
  const checkpoint = await makeMainSnapshotCandidate({ document, operations: [op("other", 2)], receipts: [exactReceipt], hash });
  const changedTime = { ...old, deletedAt: 5678 };
  const result = await classifyRetiredOperations({ document, checkpoint, deviceId: "ipad-B", throughSeq: 2,
    operations: [old, changedTime], hash });
  assert.deepEqual(result.covered, [old]);
  assert.deepEqual(result.quarantined, [changedTime]);
});
