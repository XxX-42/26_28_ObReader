import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import canonical from "../plugin/storage/canonical.cjs";
import { readNativeWalEvidence } from "./native-wal-evidence.mjs";

const virtualRoot = "00_Archive/20_PDFData";
const isolatedRoot = ".obsidian/plugins/pdf-web-reader/.native-test-output/test-run/sidecar";
const docKey = "abcdef123456";
const deviceId = "device-a";
const documentId = `sha256-v1:${"a".repeat(64)}`;
const sourceHash = `xxh64-v1:${"b".repeat(16)}`;
const hash = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
const bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
const setOperation = {
  type: "ANNOTATION_SET",
  opId: `${deviceId}:${docKey}:2`,
  seq: 2,
  version: { rev: 1, deviceId, seq: 2 },
  uuid: "freetext-1",
  kind: "FreeText",
  pageIndex: 0,
  payload: { editor: { annotationType: 3, value: "native readback", rect: [10, 20, 110, 50] } },
};
const deleteOperation = {
  type: "ANNOTATION_DELETE",
  opId: `${deviceId}:${docKey}:3`,
  seq: 3,
  version: { rev: 2, deviceId, seq: 3 },
  uuid: "square-deleted",
  kind: "Square",
  pageIndex: 0,
};
const routeOperation = {
  type: "ROUTE_SET",
  opId: `${deviceId}:${docKey}:1`,
  seq: 1,
  version: { rev: 1, deviceId, seq: 1 },
  payload: { sourcePath: "PDF迁移测试/immutable-source.pdf", source: { sourceHash } },
};

async function signed(value) {
  return canonical.seal(value, hash);
}

async function makeFixture({ snapshot = true, archive = true, jsonl = false } = {}) {
  const files = new Map();
  const operations = [routeOperation, setOperation, deleteOperation];
  if (archive) {
    const archiveVirtualPath = `${virtualRoot}/wal/${deviceId}/${docKey}.jsonl.archive.2-3.json`;
    const archived = await signed({
      schemaVersion: 1,
      kind: "pdf-reader-jsonl-immutable-archive",
      documentId,
      docKey,
      deviceId,
      sourceHash,
      firstSeq: 2,
      lastSeq: 3,
      operations: [setOperation, deleteOperation],
    });
    files.set(`${isolatedRoot}/wal/${deviceId}/${docKey}.jsonl.archive.2-3.json`, bytes(archived));
    const anchor = await signed({
      schemaVersion: 1,
      kind: "pdf-reader-jsonl-device-anchor",
      documentId,
      docKey,
      deviceId,
      sourceHash,
      throughSeq: 3,
      operations,
      archives: [{ firstSeq: 2, lastSeq: 3, path: archiveVirtualPath }],
    });
    files.set(`${isolatedRoot}/wal/${deviceId}/${docKey}.jsonl.anchor.json`, bytes(anchor));
  }
  if (jsonl) {
    const entries = operations.map((payload) => {
      const unsigned = {
        lsn: payload.seq,
        op: payload.type === "ROUTE_SET" ? "ROUTE" : payload.type === "ANNOTATION_DELETE" ? "DELETE" : "CREATE",
        id: payload.uuid || "$route",
        payload,
        ts: 1_800_000_000_000,
        docKey,
        documentId,
        sourceHash,
      };
      return { ...unsigned, integrity: hash(Buffer.from(canonical.canonicalJson(unsigned), "utf8")) };
    });
    files.set(`${isolatedRoot}/wal/${deviceId}/${docKey}.jsonl`, Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`));
  }
  if (snapshot) {
    const derived = await signed({
      schemaVersion: 1,
      kind: "pdf-reader-jsonl-derived-snapshot",
      documentId,
      docKey,
      sourceHash,
      watermarks: { [deviceId]: 3 },
      annotations: [setOperation],
      tombstones: [deleteOperation],
      routing: routeOperation,
    });
    files.set(`${isolatedRoot}/sidecars/${docKey}.annotations.json`, bytes(derived));
  }
  return files;
}

async function read(files) {
  return readNativeWalEvidence({
    files,
    isolatedRoot,
    virtualRoot,
    docKey,
    documentId,
    sourceHash,
    viewerRevision: 9,
    confirmedViewerRevision: 9,
    hash,
  });
}

test("Native WAL evidence verifies the derived snapshot against independent operation replay", async () => {
  const evidence = await read(await makeFixture());
  assert.equal(evidence.protocol, "wal-sidecar-v3.2-jsonl");
  assert.equal(evidence.durableWal.status, "replayed");
  assert.equal(evidence.snapshot.status, "verified-consistent");
  assert.equal(evidence.snapshot.matchesReplay, true);
  assert.equal(evidence.snapshot.tombstonesMatchReplay, true);
  assert.deepEqual(evidence.annotations.map(({ uuid, kind }) => ({ uuid, kind })), [{ uuid: "freetext-1", kind: "FreeText" }]);
  assert.deepEqual(evidence.tombstones.map(({ uuid, kind }) => ({ uuid, kind })), [{ uuid: "square-deleted", kind: "Square" }]);
  assert.equal(evidence.annotations[0].payload.editor.value, "native readback");
  assert.deepEqual(evidence.annotations[0].payload.editor.rect, [10, 20, 110, 50]);
  assert.deepEqual(evidence.viewer, { revision: 9, confirmedRevision: 9 });
  assert.equal(evidence.walWatermarkTotal, 3);
  assert.notEqual(evidence.walWatermarkTotal, evidence.viewer.revision);
});

test("Native WAL remains authoritative when its derived snapshot has not materialized", async () => {
  const evidence = await read(await makeFixture({ snapshot: false }));
  assert.equal(evidence.snapshot.status, "missing");
  assert.equal(evidence.durableWal.status, "replayed");
  assert.deepEqual(evidence.annotations.map((row) => row.uuid), ["freetext-1"]);
  assert.deepEqual(evidence.tombstones.map((row) => row.uuid), ["square-deleted"]);
});

test("Native WAL evidence can independently replay a complete active JSONL tail", async () => {
  const evidence = await read(await makeFixture({ snapshot: false, archive: false, jsonl: true }));
  assert.equal(evidence.snapshot.status, "missing");
  assert.equal(evidence.durableWal.status, "replayed");
  assert.equal(evidence.durableWal.jsonlComplete, true);
  assert.equal(evidence.durableWal.operationCount, 3);
  assert.equal(evidence.annotations[0].payload.editor.value, "native readback");
});

test("Native WAL evidence does not call an incomplete JSONL append durable", async () => {
  const files = await makeFixture({ snapshot: false, archive: false, jsonl: true });
  const path = `${isolatedRoot}/wal/${deviceId}/${docKey}.jsonl`;
  files.set(path, Buffer.from(files.get(path).toString("utf8").trimEnd(), "utf8"));
  const evidence = await read(files);
  assert.equal(evidence.durableWal.status, "incomplete");
  assert.equal(evidence.durableWal.jsonlComplete, false);
});

test("Native WAL evidence rejects a changed snapshot integrity envelope", async () => {
  const files = await makeFixture();
  const path = `${isolatedRoot}/sidecars/${docKey}.annotations.json`;
  const snapshot = JSON.parse(files.get(path).toString("utf8"));
  snapshot.annotations[0].payload.editor.value = "tampered";
  files.set(path, bytes(snapshot));
  await assert.rejects(read(files), /integrity.*(?:mismatch|does not match)/i);
});
