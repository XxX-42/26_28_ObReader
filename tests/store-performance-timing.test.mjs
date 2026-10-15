import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
const { createPdfAnnotationHost } = require("../plugin/pdf-annotation-host.cjs");

function hash(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeAdapter(shared = { files: new Map(), folders: new Set() }) {
  const { files, folders } = shared;
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) {
      if (!files.has(path)) throw new Error(`missing: ${path}`);
      return files.get(path);
    },
    async write(path, value) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !folders.has(parent)) throw new Error(`parent directory missing: ${parent}`);
      files.set(path, value);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`rename target exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(path) { files.delete(path); },
    async list(path) {
      const prefix = `${path}/`;
      const listedFiles = [];
      const listedFolders = new Set();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        if (!remainder.includes("/")) listedFiles.push(file);
        else listedFolders.add(`${path}/${remainder.slice(0, remainder.indexOf("/"))}`);
      }
      for (const folder of folders) {
        if (!folder.startsWith(prefix)) continue;
        const remainder = folder.slice(prefix.length);
        if (remainder && !remainder.includes("/")) listedFolders.add(folder);
      }
      return { files: listedFiles, folders: [...listedFolders] };
    },
  };
  return { adapter, files, folders, shared };
}

function createStore({ adapter, deviceId = "timing-device", onTiming = () => {}, timingNow } = {}) {
  let sequence = 0;
  return createPdfAnnotationStore({
    adapter,
    root: "00_Archive/20_PDFData",
    deviceId,
    uuid: () => `${deviceId}-uuid-${++sequence}`,
    hash,
    onTiming,
    ...(timingNow ? { timingNow } : {}),
  });
}

function operation(uuid = "annotation-1", payload = { text: "timing fixture payload" }) {
  return {
    uuid,
    kind: "Ink",
    pageIndex: 0,
    deleted: false,
    payload,
    clock: { timestamp: 10, logical: 0, deviceId: "timing-device", opId: `op-${uuid}` },
  };
}

test("GC timing reports successful covered batch removal without annotation payload", async () => {
  const { adapter } = makeAdapter();
  const events = [];
  const monotonicTimes = [20, 21, 22, 25, 32];
  const store = createStore({ adapter, onTiming: (event) => events.push(event), timingNow: () => monotonicTimes.shift() });
  const document = await store.registerDocument({ sourcePath: "gc-success.pdf" });
  await store.appendOperations({ document, batchId: "covered-batch", operations: [
    operation("annotation-1", { secret: "private annotation payload" }),
  ] });
  const batchPath = `${store.pathsFor(document).deviceOperations}/covered-batch.json`;

  const snapshot = await store.readDocument(document);

  assert.equal(snapshot.annotations[0].uuid, "annotation-1");
  assert.equal(await adapter.exists(batchPath), false);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.phase, "gc");
  assert.equal(event.documentId, document.documentId);
  assert.equal(event.docKey, document.docKey);
  assert.equal(event.revision, snapshot.revision);
  assert.equal(event.checkpointHash, snapshot.checkpointHash);
  assert.equal(event.startedAtMonotonicMs, 25);
  assert.equal(event.materializationQueueWaitMs, 1);
  assert.equal(event.queueWaitMs, 3);
  assert.equal(event.durationMs, 7);
  assert.equal(event.eligible, true);
  assert.equal(event.blocked, false);
  assert.equal(event.status, "success");
  assert.equal(event.candidateBatchCount, 1);
  assert.ok(event.candidateBatchBytes > 0);
  assert.equal(event.removedBatchCount, 1);
  assert.equal(event.removedBatchBytes, event.candidateBatchBytes);
  assert.equal(JSON.stringify(event).includes("private annotation payload"), false);
});

test("GC without a safe remove operation is reported as blocked", async () => {
  const { adapter } = makeAdapter();
  const events = [];
  const store = createStore({ adapter, onTiming: (event) => events.push(event) });
  const document = await store.registerDocument({ sourcePath: "gc-blocked.pdf" });
  await store.appendOperations({ document, batchId: "no-remove", operations: [operation("annotation-2")] });
  const batchPath = `${store.pathsFor(document).deviceOperations}/no-remove.json`;
  delete adapter.remove;

  await store.readDocument(document);

  assert.equal(await adapter.exists(batchPath), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "gc");
  assert.equal(events[0].eligible, false);
  assert.equal(events[0].blocked, true);
  assert.equal(events[0].status, "blocked");
  assert.equal(events[0].candidateBatchCount, 0);
  assert.equal(events[0].removedBatchCount, 0);
});

test("a device without the current checkpoint ACK never has its batch removed", async () => {
  const { adapter } = makeAdapter();
  const events = [];
  const a = createStore({ adapter, deviceId: "device-A", onTiming: (event) => events.push(event) });
  const b = createStore({ adapter, deviceId: "device-B" });
  const documentA = await a.registerDocument({ sourcePath: "gc-unacknowledged.pdf" });
  const documentB = await b.registerDocument({ sourcePath: "gc-unacknowledged.pdf" });
  await b.readDocument(documentB);
  await a.appendOperations({ document: documentA, batchId: "pending-ack", operations: [
    { ...operation("annotation-3"), clock: { timestamp: 11, logical: 0, deviceId: "device-A", opId: "op-annotation-3" } },
  ] });
  const batchPath = `${a.pathsFor(documentA).deviceOperations}/pending-ack.json`;

  await a.readDocument(documentA);

  assert.equal(await adapter.exists(batchPath), true,
    "the caller's compact-format ACK barrier must retain batches until every device confirms the checkpoint");
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "gc");
  assert.equal(events[0].eligible, false);
  assert.equal(events[0].blocked, true);
  assert.equal(events[0].status, "blocked");
  assert.equal(events[0].removedBatchCount, 0);
});

test("a legacy device's prior checkpoint ACK is blocked after its hash becomes stale", async () => {
  const { adapter, files } = makeAdapter();
  const events = [];
  const a = createStore({ adapter, deviceId: "device-A", onTiming: (event) => events.push(event) });
  const b = createStore({ adapter, deviceId: "device-B" });
  const documentA = await a.registerDocument({ sourcePath: "gc-legacy-ack.pdf" });
  const documentB = await b.registerDocument({ sourcePath: "gc-legacy-ack.pdf" });
  await b.readDocument(documentB);

  const paths = a.pathsFor(documentA);
  const priorCheckpointHash = JSON.parse(files.get(paths.checkpoint)).integrity;
  const beforeUpgrade = await b.inspectDevices(documentB);
  assert.equal(beforeUpgrade.devices.find(({ deviceId }) => deviceId === "device-B").acknowledged, true,
    "the old device did acknowledge its then-current checkpoint");
  const legacyAckPath = `${paths.deviceStates}/device-B.json`;
  const legacyAck = JSON.parse(files.get(legacyAckPath));
  legacyAck.pluginVersion = "0.6.9";
  files.set(legacyAckPath, JSON.stringify(legacyAck));

  await a.appendOperations({ document: documentA, batchId: "newer-checkpoint", operations: [
    { ...operation("annotation-legacy-ack"), clock: {
      timestamp: 13, logical: 0, deviceId: "device-A", opId: "legacy-ack-new-op",
    } },
  ] });
  const batchPath = `${paths.deviceOperations}/newer-checkpoint.json`;
  const batchTextBeforeRead = files.get(batchPath);
  const metadataPath = paths.metadata;
  const metadataBeforeRead = files.get(metadataPath);
  const legacyAckBeforeRead = files.get(legacyAckPath);

  await a.readDocument(documentA);

  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "gc");
  assert.equal(events[0].status, "blocked");
  assert.equal(events[0].eligible, false);
  assert.equal(events[0].blocked, true);
  assert.notEqual(events[0].checkpointHash, priorCheckpointHash);
  assert.equal(files.get(batchPath), batchTextBeforeRead,
    "a legacy device's previous ACK cannot authorize removal of a batch covered by a newer checkpoint");
  assert.equal(files.get(metadataPath), metadataBeforeRead,
    "the non-eligible GC timing path must not rewrite document metadata");
  assert.equal(files.get(legacyAckPath), legacyAckBeforeRead,
    "the current device read must not rewrite another device's ACK record");
});

test("GC timing records backup-verification errors while preserving covered batches", async () => {
  const { adapter, files } = makeAdapter();
  const events = [];
  const store = createStore({ adapter, onTiming: (event) => events.push(event) });
  const document = await store.registerDocument({ sourcePath: "gc-error.pdf" });
  await store.appendOperations({ document, batchId: "keep-on-error", operations: [operation("annotation-3")] });
  const batchPath = `${store.pathsFor(document).deviceOperations}/keep-on-error.json`;
  const backupPath = store.pathsFor(document).checkpointBackup;
  const originalWrite = adapter.write.bind(adapter);
  let backupWrites = 0;
  adapter.write = async (path, value) => {
    if (path === backupPath && ++backupWrites === 3) {
      await originalWrite(path, "truncated checkpoint backup");
      return;
    }
    await originalWrite(path, value);
  };

  await assert.rejects(store.readDocument(document), { code: "PDF_ANNOTATION_CHECKPOINT_BACKUP_UNCONFIRMED" });

  assert.equal(await adapter.exists(batchPath), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, "gc");
  assert.equal(events[0].eligible, true);
  assert.equal(events[0].blocked, false);
  assert.equal(events[0].status, "error");
  assert.equal(events[0].errorCode, "PDF_ANNOTATION_CHECKPOINT_BACKUP_UNCONFIRMED");
  assert.equal(events[0].candidateBatchCount, 0);
  assert.equal(events[0].removedBatchCount, 0);
});

test("throwing timing observers and clocks cannot change GC outcomes", async () => {
  const { adapter } = makeAdapter();
  const store = createStore({
    adapter,
    onTiming() { throw new Error("diagnostic observer failure"); },
    timingNow() { throw new Error("diagnostic clock failure"); },
  });
  const document = await store.registerDocument({ sourcePath: "gc-observer-throw.pdf" });
  await store.appendOperations({ document, batchId: "still-collect", operations: [operation("annotation-4")] });
  const batchPath = `${store.pathsFor(document).deviceOperations}/still-collect.json`;

  const snapshot = await store.readDocument(document);

  assert.equal(snapshot.annotations[0].uuid, "annotation-4");
  assert.equal(await adapter.exists(batchPath), false);
});

test("the annotation host forwards store GC timings through its existing logger", async () => {
  const { adapter } = makeAdapter();
  const events = [];
  let sequence = 0;
  const host = createPdfAnnotationHost({
    app: { vault: { adapter } },
    hashRuntime: { fingerprint: hash },
    makeToken: () => `host-token-${++sequence}`,
    deviceId: "host-timing-device",
    log: (event, details) => events.push({ event, details }),
  });
  const document = await host.store.registerDocument({ sourcePath: "host-gc.pdf" });
  await host.store.appendOperations({
    document,
    batchId: "host-covered",
    operations: [{ ...operation("host-annotation"), clock: {
      timestamp: 12, logical: 0, deviceId: "host-timing-device", opId: "host-op",
    } }],
  });

  await host.store.readDocument(document);

  const record = events.find(({ event }) => event === "annotation-performance");
  assert.ok(record);
  assert.equal(record.details.phase, "gc");
  assert.equal(record.details.docKey, document.docKey);
  assert.equal(typeof record.details.queueWaitMs, "number");
  assert.equal(typeof record.details.materializationQueueWaitMs, "number");
  assert.equal(typeof record.details.durationMs, "number");
  assert.equal(record.details.status, "success");
  host.dispose();
});
