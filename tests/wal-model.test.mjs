import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { canonicalJson, seal, verify } = require("../plugin/storage/canonical.cjs");
const { compareVersion, validateVersion } = require("../plugin/storage/version.cjs");
const { joinOperations, validateOperation } = require("../plugin/storage/merge-engine.cjs");
const { deriveDocumentIdentity, normalizeInitialPath, validateFullSourceHash } = require("../plugin/storage/document-identity.cjs");
const { buildEffectiveState, effectiveStatesEqual } = require("../plugin/storage/effective-state.cjs");

const sha256 = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;

function operation(type, {
  uuid = "ann-a",
  rev = 1,
  deviceId = "device-a",
  seq = 0,
  opId = `${deviceId}-${rev}-${seq}`,
  payload,
  kind = "highlight",
  pageIndex = 0,
  ...extra
} = {}) {
  return {
    type,
    ...(uuid === undefined ? {} : { uuid }),
    seq,
    opId,
    version: { rev, deviceId, seq },
    ...(payload === undefined ? {} : { payload }),
    ...(kind === undefined ? {} : { kind }),
    ...(pageIndex === undefined ? {} : { pageIndex }),
    ...extra,
  };
}

function setOp(uuid, rev, value, extras = {}) {
  return operation("ANNOTATION_SET", {
    uuid,
    rev,
    payload: {
      uuid,
      type: "Highlight",
      rect: { encoding: "float32le-base64-v1", data: value },
    },
    ...extras,
  });
}

function deleteOp(uuid, rev, extras = {}) {
  return operation("ANNOTATION_DELETE", { uuid, rev, ...extras });
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((tail) => [value, ...tail]));
}

test("canonical JSON sorts nested keys and preserves Float32LE encoded payload objects", () => {
  const source = {
    z: 3,
    a: { z: ["a", { q: true, b: 2 }], encoding: "float32le-base64-v1" },
  };
  assert.equal(
    canonicalJson(source),
    '{"a":{"encoding":"float32le-base64-v1","z":["a",{"b":2,"q":true}]},"z":3}',
  );
  assert.throws(() => canonicalJson({ n: Number.NaN }), { code: "WAL_CANONICAL_INVALID_VALUE" });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), { code: "WAL_CANONICAL_CYCLE" });
});

test("seal and verify use the canonical unsigned envelope and reject changed contents", async () => {
  const unsigned = {
    schema: 1,
    kind: "annotation-sidecar",
    annotations: { b: { rev: 2 }, a: { rev: 1 } },
  };
  const signed = await seal(unsigned, sha256);
  assert.match(signed.integrity, /^sha256-v1:[a-f0-9]{64}$/);
  assert.deepEqual(await verify(signed, sha256), unsigned);
  const changed = { ...signed, annotations: { ...signed.annotations, a: { rev: 3 } } };
  await assert.rejects(verify(changed, sha256), { code: "WAL_INTEGRITY_MISMATCH" });
  await assert.rejects(verify({ ...signed, integrity: "sha256-v1:abc" }, sha256), { code: "WAL_INTEGRITY_INVALID" });
});

test("version tuples compare by rev, then lexical deviceId, then seq", () => {
  assert.deepEqual(validateVersion({ rev: 1, deviceId: "a", seq: 0 }), { rev: 1, deviceId: "a", seq: 0 });
  assert.equal(compareVersion({ rev: 2, deviceId: "z", seq: 99 }, { rev: 1, deviceId: "a", seq: 0 }), 1);
  assert.equal(compareVersion({ rev: 3, deviceId: "a", seq: 99 }, { rev: 3, deviceId: "b", seq: 0 }), -1);
  assert.equal(compareVersion({ rev: 3, deviceId: "a", seq: 1 }, { rev: 3, deviceId: "a", seq: 2 }), -1);
  assert.throws(() => validateVersion({ rev: 0, deviceId: "a", seq: 0 }), { code: "WAL_VERSION_INVALID" });
  assert.throws(() => validateVersion({ rev: 1, deviceId: "bad\nactor", seq: 0 }), { code: "WAL_VERSION_INVALID" });
});

test("operation validation rejects malformed tuples and invalid annotation payload metadata", () => {
  assert.throws(() => validateOperation({ type: "OTHER" }), { code: "WAL_OPERATION_INVALID" });
  const mismatchedSeq = setOp("ann", 1, "v");
  mismatchedSeq.seq = 4;
  assert.throws(() => validateOperation(mismatchedSeq), { code: "WAL_OPERATION_INVALID" });
  assert.throws(() => validateOperation(operation("ANNOTATION_SET", {
    uuid: "ann", payload: "not-an-object", kind: "highlight", pageIndex: 0,
  })), { code: "WAL_OPERATION_INVALID" });
  assert.throws(() => validateOperation(operation("ANNOTATION_DELETE", {
    uuid: "ann", kind: "unknown", pageIndex: 0,
  })), { code: "WAL_OPERATION_INVALID" });
  assert.throws(() => validateOperation(operation("ROUTE_SET", {
    uuid: undefined, payload: { sourcePath: "../outside.pdf" }, kind: undefined, pageIndex: undefined,
  })), { code: "WAL_OPERATION_INVALID" });
});

test("join is idempotent and commutative across operation permutations", () => {
  const operations = [
    setOp("ann-a", 1, "old"),
    deleteOp("ann-a", 2, { deviceId: "device-b", opId: "delete-a" }),
    setOp("ann-a", 3, "new", { seq: 1, opId: "edit-a-3" }),
    setOp("ann-b", 1, "independent", { seq: 0, opId: "same-counter-other-uuid" }),
  ];
  const expected = joinOperations(operations);
  assert.deepEqual(joinOperations(operations, operations), expected);
  assert.deepEqual(joinOperations([]), { annotations: {}, tombstones: {}, routing: null });
  for (const ordering of permutations(operations)) {
    assert.deepEqual(joinOperations(ordering), expected);
  }
});

test("same logical object and version cannot identify different op IDs or content", () => {
  const original = setOp("ann-a", 1, "first");
  const differentId = { ...original, opId: "different-op" };
  const differentContent = { ...original, payload: { ...original.payload, note: "changed" } };
  assert.throws(() => joinOperations([original, differentId]), { code: "VERSION_COLLISION" });
  assert.throws(() => joinOperations([original, differentContent]), { code: "VERSION_COLLISION" });
  // Equal tuples across different annotation UUIDs are separate logical keys.
  assert.equal(Object.keys(joinOperations([original, setOp("ann-b", 1, "other")]).annotations).length, 2);
});

test("a tombstone wins by version and a later set clears it", () => {
  const olderSet = setOp("ann-a", 7, "set");
  const newerDelete = deleteOp("ann-a", 8, { deviceId: "device-z", opId: "delete" });
  const tombstoned = joinOperations([olderSet, newerDelete]);
  assert.deepEqual(Object.keys(tombstoned.annotations), []);
  assert.equal(tombstoned.tombstones["ann-a"].opId, "delete");

  const restored = joinOperations([olderSet, newerDelete, setOp("ann-a", 9, "restore")]);
  assert.equal(restored.annotations["ann-a"].payload.rect.data, "restore");
  assert.deepEqual(Object.keys(restored.tombstones), []);
});

test("effective state joins a verified sidecar, anchor records, and WAL tails", () => {
  const sidecar = { kind: "annotation-sidecar", operations: [setOp("ann-a", 1, "sidecar")] };
  const anchors = [{ kind: "annotation-anchor", operations: [setOp("ann-b", 1, "anchor")] }];
  const tails = [{ kind: "annotation-wal", operations: [deleteOp("ann-a", 2)] }];
  const effective = buildEffectiveState({ sidecar, anchors, tails });
  assert.deepEqual(Object.keys(effective.annotations), ["ann-b"]);
  assert.deepEqual(Object.keys(effective.tombstones), ["ann-a"]);
  assert.equal(effective.routing, null);
  assert.equal(effectiveStatesEqual(effective, joinOperations([setOp("ann-b", 1, "anchor"), deleteOp("ann-a", 2)])), true);
});

test("routing keeps the highest version and carries source and legacy metadata", () => {
  const oldRoute = operation("ROUTE_SET", {
    uuid: undefined,
    rev: 1,
    payload: { sourcePath: "Books/old.pdf", legacyIdentities: ["legacy-a"] },
    kind: undefined,
    pageIndex: undefined,
  });
  const newRoute = operation("ROUTE_SET", {
    uuid: undefined,
    rev: 2,
    payload: { sourcePath: "Books/new.pdf", legacyIdentityScanComplete: true },
    kind: undefined,
    pageIndex: undefined,
  });
  assert.deepEqual(joinOperations([newRoute, oldRoute]).routing.payload, newRoute.payload);
});

test("document identity uses normalized initial path and the complete tagged source hash", async () => {
  const sourceHash = `sha256-v1:${"a".repeat(64)}`;
  assert.equal(normalizeInitialPath("./Books\\./Novel.pdf"), "Books/Novel.pdf");
  assert.equal(validateFullSourceHash(sourceHash), sourceHash);
  await assert.rejects(
    Promise.resolve().then(() => validateFullSourceHash("xxh64-v1:deadbeef")),
    { code: "WAL_SOURCE_HASH_INVALID" },
  );

  const identity = await deriveDocumentIdentity({ initialPath: "./Books\\Novel.pdf", fullSourceHash: sourceHash, stableHash: sha256 });
  const normalized = await deriveDocumentIdentity({ initialPath: "Books/Novel.pdf", fullSourceHash: sourceHash, stableHash: sha256 });
  const changedSource = await deriveDocumentIdentity({
    initialPath: "Books/Novel.pdf", fullSourceHash: `sha256-v1:${"b".repeat(64)}`, stableHash: sha256,
  });
  assert.equal(identity.identity, normalized.identity);
  assert.equal(identity.documentId, identity.identity);
  assert.equal(identity.docKey.length, 12);
  assert.notEqual(identity.identity, changedSource.identity);

  const rawSha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const rawIdentity = await deriveDocumentIdentity({ initialPath: "Books/Novel.pdf", fullSourceHash: sourceHash, stableHash: rawSha });
  assert.equal(rawIdentity.identity, identity.identity);
});
