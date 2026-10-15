import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");

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
      if (!files.has(path)) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
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
    async remove(path) {
      if (!files.has(path)) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      files.delete(path);
    },
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
  return { adapter, files, folders };
}

function createStore({ adapter, deviceId, onTiming = () => {} }) {
  let sequence = 0;
  return createPdfAnnotationStore({
    adapter,
    root: "00_Archive/20_PDFData",
    deviceId,
    uuid: () => `${deviceId}-uuid-${++sequence}`,
    hash,
    onTiming,
  });
}

test("concurrent readDocument GC must not remove the same covered batch twice", async () => {
  const { adapter, files } = makeAdapter();
  const timings = [];
  const a = createStore({ adapter, deviceId: "device-A", onTiming: (event) => timings.push(event) });
  const b = createStore({ adapter, deviceId: "device-B" });
  const documentA = await a.registerDocument({ sourcePath: "concurrent-gc.pdf" });
  const documentB = await b.registerDocument({ sourcePath: "concurrent-gc.pdf" });

  // Register both devices on a common compact checkpoint before adding a batch.
  await b.readDocument(documentB);
  await a.readDocument(documentA);
  await b.readDocument(documentB);
  await a.appendOperations({ document: documentA, batchId: "covered-once", operations: [{
    uuid: "concurrent-annotation",
    kind: "Ink",
    pageIndex: 0,
    deleted: false,
    payload: { value: "safe payload" },
    clock: { timestamp: 10, logical: 0, deviceId: "device-A", opId: "concurrent-op" },
  }] });
  await a.readDocument(documentA); // A ACKs the new checkpoint; B remains behind.

  const paths = a.pathsFor(documentA);
  const batchPath = `${paths.deviceOperations}/covered-once.json`;
  const checkpointPath = paths.checkpoint;
  const backupPath = paths.checkpointBackup;
  assert.equal(files.has(batchPath), true);
  const remove = adapter.remove.bind(adapter);
  adapter.remove = undefined;
  await b.readDocument(documentB); // B catches up; no remove function keeps the batch for the race.
  adapter.remove = remove;
  assert.equal(files.has(batchPath), true);

  timings.length = 0;
  let removeCalls = 0;
  let releaseRemovers;
  const bothRemoversEntered = new Promise((resolve) => { releaseRemovers = resolve; });
  let fallbackReleased = false;
  const fallback = setTimeout(() => {
    fallbackReleased = true;
    releaseRemovers();
  }, 250);
  adapter.remove = async (path) => {
    if (path !== batchPath) return remove(path);
    removeCalls += 1;
    if (removeCalls === 2) releaseRemovers();
    await bothRemoversEntered;
    if (!files.has(path)) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
    files.delete(path);
  };

  const results = await Promise.allSettled([
    a.readDocument(documentA),
    a.readDocument(documentA),
  ]);
  clearTimeout(fallback);

  assert.equal(removeCalls, 1,
    "only the first serialized GC should remove the batch; the next GC should observe it is gone");
  assert.deepEqual(results.map(({ status }) => status), ["fulfilled", "fulfilled"],
    `concurrent readers should serialize idempotent collection, got ${results.map(({ reason }) => reason?.code).join(",")}`);
  assert.equal(files.has(batchPath), false);
  assert.equal(files.has(checkpointPath), true);
  assert.equal(files.get(backupPath), files.get(checkpointPath),
    "the current verified backup must remain available after concurrent collection");
  const gcTimings = timings.filter(({ phase }) => phase === "gc");
  assert.equal(gcTimings.length, 2);
  assert.ok(gcTimings.every(({ status }) => status === "success"));
  assert.ok(fallbackReleased, "the second same-document GC should wait instead of entering remove");
  assert.ok(gcTimings[1].materializationQueueWaitMs > 200,
    "the second full materialization waits outside the GC execution interval");
  assert.ok(gcTimings[1].queueWaitMs < gcTimings[1].materializationQueueWaitMs,
    "GC queue wait remains separate from the outer per-document materialization wait");
});

test("GC queues are independent across document keys", async () => {
  const { adapter, files } = makeAdapter();
  const store = createStore({ adapter, deviceId: "independent-device" });
  const documents = [];
  for (const sourcePath of ["gc-doc-one.pdf", "gc-doc-two.pdf"]) {
    const document = await store.registerDocument({ sourcePath });
    documents.push(document);
    await store.appendOperations({ document, batchId: `batch-${documents.length}`, operations: [{
      uuid: `annotation-${documents.length}`,
      kind: "Ink",
      pageIndex: 0,
      deleted: false,
      payload: { value: "independent payload" },
      clock: { timestamp: documents.length, logical: 0, deviceId: "independent-device", opId: `op-${documents.length}` },
    }] });
    const remove = adapter.remove;
    adapter.remove = undefined;
    await store.readDocument(document); // Preserve each covered batch until both GCs run together.
    adapter.remove = remove;
  }
  const batchPaths = new Set(documents.map((document, index) =>
    `${store.pathsFor(document).deviceOperations}/batch-${index + 1}.json`));
  assert.ok([...batchPaths].every((path) => files.has(path)));

  let removeCalls = 0;
  let fallbackReleased = false;
  let releaseRemovers;
  const bothRemoversEntered = new Promise((resolve) => { releaseRemovers = resolve; });
  const fallback = setTimeout(() => {
    fallbackReleased = true;
    releaseRemovers();
  }, 1500);
  const remove = adapter.remove.bind(adapter);
  adapter.remove = async (path) => {
    if (!batchPaths.has(path)) return remove(path);
    removeCalls += 1;
    if (removeCalls === 2) releaseRemovers();
    await bothRemoversEntered;
    if (!files.has(path)) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
    files.delete(path);
  };

  const results = await Promise.allSettled(documents.map((document) => store.readDocument(document)));
  clearTimeout(fallback);

  assert.equal(fallbackReleased, false, "one document's GC queue must not hold the other document");
  assert.equal(removeCalls, 2);
  assert.deepEqual(results.map(({ status }) => status), ["fulfilled", "fulfilled"]);
  assert.ok([...batchPaths].every((path) => !files.has(path)));
});

test("a rejected GC does not poison the next GC for that document", async () => {
  const { adapter, files } = makeAdapter();
  const timings = [];
  const store = createStore({ adapter, deviceId: "recover-after-gc-error", onTiming: (event) => timings.push(event) });
  const document = await store.registerDocument({ sourcePath: "gc-retry.pdf" });
  await store.appendOperations({ document, batchId: "retry-after-failure", operations: [{
    uuid: "retry-annotation",
    kind: "Ink",
    pageIndex: 0,
    deleted: false,
    payload: { value: "retry payload" },
    clock: { timestamp: 30, logical: 0, deviceId: "recover-after-gc-error", opId: "retry-op" },
  }] });
  const paths = store.pathsFor(document);
  const batchPath = `${paths.deviceOperations}/retry-after-failure.json`;
  const originalWrite = adapter.write.bind(adapter);
  let backupWrites = 0;
  adapter.write = async (path, value) => {
    if (path === paths.checkpointBackup && ++backupWrites === 3) {
      await originalWrite(path, "truncated backup during first GC");
      return;
    }
    await originalWrite(path, value);
  };

  await assert.rejects(store.readDocument(document), { code: "PDF_ANNOTATION_CHECKPOINT_BACKUP_UNCONFIRMED" });
  assert.equal(files.has(batchPath), true);
  adapter.write = originalWrite;

  const snapshot = await store.readDocument(document);

  assert.equal(snapshot.annotations[0].uuid, "retry-annotation");
  assert.equal(files.has(batchPath), false);
  assert.deepEqual(timings.map(({ status }) => status), ["error", "success"]);
});
