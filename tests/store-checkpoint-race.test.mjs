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

function makeAdapter() {
  const files = new Map();
  const folders = new Set();
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
  return { adapter, files };
}

function createStore(adapter, onTiming = () => {}) {
  let sequence = 0;
  return createPdfAnnotationStore({
    adapter,
    root: "00_Archive/20_PDFData",
    deviceId: "checkpoint-race-device",
    uuid: () => `checkpoint-race-${++sequence}`,
    hash,
    onTiming,
  });
}

function operation(uuid, timestamp) {
  return {
    uuid,
    kind: "Ink",
    pageIndex: 0,
    deleted: false,
    payload: { value: uuid },
    clock: { timestamp, logical: 0, deviceId: "checkpoint-race-device", opId: `op-${uuid}` },
  };
}

test("a stale readDocument must not overwrite a newer checkpoint after its batch was collected", async () => {
  const { adapter, files } = makeAdapter();
  let newerBatchPath;
  let olderGcNewerBatchStillExists = false;
  const store = createStore(adapter, (event) => {
    if (event.phase === "gc" && event.revision === 1 && newerBatchPath) {
      olderGcNewerBatchStillExists = files.has(newerBatchPath);
    }
  });
  const document = await store.registerDocument({ sourcePath: "checkpoint-race.pdf" });
  await store.appendOperations({ document, batchId: "baseline", operations: [operation("annotation-old", 10)] });
  await store.readDocument(document);
  const paths = store.pathsFor(document);
  const startingCheckpoint = JSON.parse(files.get(paths.checkpoint));
  assert.equal(startingCheckpoint.revision, 1);
  assert.deepEqual(startingCheckpoint.annotations.map(({ uuid }) => uuid), ["annotation-old"]);

  let signalOldPaused;
  const oldPaused = new Promise((resolve) => { signalOldPaused = resolve; });
  let releaseOld;
  const holdOld = new Promise((resolve) => { releaseOld = resolve; });
  const originalRead = adapter.read.bind(adapter);
  let heldOldWriteCheckpoint = false;
  let observeNewResolve = false;
  let signalNewResolve;
  const newerResolveStarted = new Promise((resolve) => { signalNewResolve = resolve; });
  const registryPath = `${paths.root}/_index.json`;
  adapter.read = async (path) => {
    if (path === paths.checkpointBackup && !heldOldWriteCheckpoint) {
      heldOldWriteCheckpoint = true;
      signalOldPaused();
      await holdOld;
    }
    if (path === registryPath && observeNewResolve) {
      observeNewResolve = false;
      signalNewResolve();
    }
    return originalRead(path);
  };
  const oldRead = store.readDocument(document).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );

  let timeout;
  await Promise.race([
    oldPaused,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("old read did not reach checkpoint write gate")), 1500); }),
  ]);
  clearTimeout(timeout);

  let newerRead;
  try {
    // The old replay is complete and paused before writeCheckpoint checks the
    // backup. Only now publish the revision N+1 operation batch.
    await store.appendOperations({ document, batchId: "newer", operations: [operation("annotation-new", 20)] });
    newerBatchPath = `${paths.deviceOperations}/newer.json`;
    observeNewResolve = true;
    newerRead = store.readDocument(document);
    await newerResolveStarted;
    // Let resolveDocument return and enqueue the newer transaction while the
    // stale replay still owns the per-document materialization slot.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    releaseOld();
    adapter.read = originalRead;
  }

  const [oldOutcome, newerOutcome] = await Promise.all([oldRead, newerRead.then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  )]);
  assert.equal(oldOutcome.status, "fulfilled");
  assert.equal(newerOutcome.status, "fulfilled");
  assert.equal(newerOutcome.value.revision, 2);
  assert.deepEqual(newerOutcome.value.annotations.map(({ uuid }) => uuid).sort(), ["annotation-new", "annotation-old"]);
  assert.equal(olderGcNewerBatchStillExists, true,
    "the first materialization must not collect a batch it did not replay");
  const finalPrimary = JSON.parse(files.get(paths.checkpoint));
  const finalBackup = JSON.parse(files.get(paths.checkpointBackup));
  assert.deepEqual({
    oldReadRevision: oldOutcome.value.revision,
    primaryRevision: finalPrimary.revision,
    primaryAnnotationIds: finalPrimary.annotations.map(({ uuid }) => uuid).sort(),
    backupRevision: finalBackup.revision,
    backupAnnotationIds: finalBackup.annotations.map(({ uuid }) => uuid).sort(),
    newerBatchStillExists: files.has(`${paths.deviceOperations}/newer.json`),
  }, {
    oldReadRevision: 1,
    primaryRevision: 2,
    primaryAnnotationIds: ["annotation-new", "annotation-old"],
    backupRevision: 2,
    backupAnnotationIds: ["annotation-new", "annotation-old"],
    newerBatchStillExists: false,
  }, "the stale materialization must not erase a newer annotation after its batch was GC'd");
});
