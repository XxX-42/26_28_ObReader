import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";

const require = createRequire(import.meta.url);
const { createWalAnnotationStore } = require("../plugin/storage/wal-annotation-store.cjs");
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
const ROOT = "00_Archive/20_PDFData";
const hash = (value) => `sha256-v1:${createHash("sha256").update(value).digest("hex")}`;

function world() {
  const files = new Map();
  const folders = new Set();
  const calls = { append: 0, read: 0, write: 0 };
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) { calls.read++; if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path); },
    async write(path, text) { calls.write++; files.set(path, text); },
    async append(path, text) { calls.append++; files.set(path, `${files.get(path) || ""}${text}`); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async remove(path) { files.delete(path); },
    async list(path) {
      const prefix = `${path}/`;
      const directFiles = [];
      const directFolders = new Set();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        if (remainder.includes("/")) directFolders.add(`${path}/${remainder.split("/")[0]}`);
        else directFiles.push(file);
      }
      for (const folder of folders) {
        if (folder.startsWith(prefix) && !folder.slice(prefix.length).includes("/")) directFolders.add(folder);
      }
      return { files: directFiles, folders: [...directFolders] };
    },
  };
  const store = (deviceId, jsonlMode) => createWalAnnotationStore({ adapter, root: ROOT, deviceId,
    uuid: (() => { let id = 0; return () => `${deviceId}-${++id}`; })(), hash, identityHash: hash,
    jsonlMode });
  return { files, folders, calls, adapter, store };
}

function annotation(uuid, index, { deleted = false, origin = "viewer" } = {}) {
  return { uuid, kind: "Square", pageIndex: index % 357, deleted,
    ...(!deleted ? { payload: { editor: { annotationType: 5, rect: [1, 2, 100, 120], index } } } : {}),
    clock: { timestamp: index + 1, logical: index, deviceId: origin, opId: `${origin}-${uuid}-${index}` } };
}

test("activated JSONL epoch rejects a pre-existing Format 3 writer but permits read-only migration", async () => {
  const w = world();
  withAtomicProcess(w.adapter, w.files);
  let sequence = 0;
  const legacy = createPdfAnnotationStore({ adapter: w.adapter, root: ROOT, deviceId: "legacy",
    uuid: () => `legacy-${++sequence}`, hash, identityHash: hash });
  const sourcePath = "Fixtures/epoch-isolation.pdf";
  const source = { sourceHash: hash("immutable epoch fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const registered = await legacy.registerDocument({ sourcePath, source });
  const document = registered.document || registered;
  await legacy.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("legacy-row", 0, { origin: "legacy" })] });
  const current = w.store("windows-A", true);
  const upgraded = await current.registerDocument({ sourcePath, source });
  await current.appendOperations({ document: upgraded, sourceHash: source.sourceHash,
    operations: [annotation("current-row", 1)] });
  await current.materializeSnapshot(upgraded);
  const before = new Map(w.files);
  for (const write of [() => legacy.materializeSnapshot(document),
    () => legacy.appendOperations({ document, sourceHash: source.sourceHash,
      operations: [annotation("ghost-row", 2, { origin: "legacy" })] })]) {
    await assert.rejects(write, { code: "PDF_ANNOTATION_PROTOCOL_READ_ONLY" });
    assert.deepEqual(w.files, before, "rejected legacy writes must not alter any durable byte");
  }
  const migration = await legacy.exportForMigration(sourcePath);
  assert.ok(migration, "read-only legacy import remains supported");
  assert.deepEqual(w.files, before);
  const recovered = await w.store("windows-A", true).readDocument(upgraded);
  assert.deepEqual(recovered.annotations.map((row) => row.uuid).sort(), ["current-row", "legacy-row"]);
});

test("v3.1 WAL and sidecar remain intact while v3.2 device JSONL reopens with new rows", async () => {
  const w = world();
  const sourcePath = "Fixtures/Principles-copy.pdf";
  const source = { sourceHash: hash("immutable fixture"), size: 11_919_545, pageCount: 357,
    orderedPageIdentities: Array.from({ length: 357 }, (_, index) => `page-${index}`) };
  const old = w.store("windows-A", false);
  const document = await old.registerDocument({ sourcePath, source });
  await old.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("old-ink", 1)] });
  const oldWalPath = `${ROOT}/wal/windows-A/${document.docKey}.json`;
  const oldWalBytes = w.files.get(oldWalPath);
  const v32 = w.store("windows-A", true);
  const openDocument = await v32.documentForPath(sourcePath);
  assert.equal(openDocument.documentId, document.documentId);
  const priorAppends = w.calls.append;
  const result = await v32.appendOperations({ document: openDocument, sourceHash: source.sourceHash,
    operations: [annotation("new-square", 2), annotation("new-underline", 3)] });
  assert.equal(result.operationCount, 2);
  for (const stage of ["captureMs", "queueWaitMs", "encodeMs", "appendMs", "processingMs"]) {
    assert.ok(Number.isFinite(result.timings[stage]) && result.timings[stage] >= 0, `${stage} must be measured`);
  }
  assert.equal(w.calls.append - priorAppends, 1, "a batch must use one adapter.append");
  assert.equal(w.files.get(oldWalPath), oldWalBytes, "migration must not rewrite the old device WAL");
  const first = await v32.readDocument(openDocument);
  assert.deepEqual(first.annotations.map((row) => row.uuid).sort(), ["new-square", "new-underline", "old-ink"]);
  await v32.materializeSnapshot(openDocument);
  assert.ok(w.files.has(`${ROOT}/wal/windows-A/${document.docKey}.jsonl.anchor.json`));
  assert.ok(w.files.has(`${ROOT}/sidecars/${document.docKey}.annotations.json`));
  for (const remotePath of [
    `${ROOT}/sidecars/${document.docKey}.annotations.json`,
    `${ROOT}/wal/ipad-B/${document.docKey}.jsonl`,
    `${ROOT}/wal/ipad-B/${document.docKey}.jsonl.anchor.json`,
    `${ROOT}/wal/ipad-B/${document.docKey}.jsonl.archive.1-2.json`,
    `${ROOT}/wal/windows-A/${document.docKey}.json`,
  ]) {
    assert.equal(v32.affectsPath(openDocument, remotePath), true,
      `a synced annotation record must refresh its open Reader: ${remotePath}`);
  }
  assert.equal(v32.affectsPath(openDocument, `${ROOT}/sidecars/another-doc.annotations.json`), false);
  assert.equal(w.files.get(oldWalPath), oldWalBytes, "checkpoint must retain old v3.1 WAL bytes");
  assert.equal(w.files.get(`${ROOT}/wal/windows-A/${document.docKey}.jsonl`), "",
    "active JSONL may rotate only after an immutable archive is verified");
  assert.ok([...w.files.keys()].some((path) => path.includes(`${document.docKey}.jsonl.archive.`)),
    "immutable archived WAL rows must remain available to every device");
  const reopened = w.store("windows-A", true);
  const recovered = await reopened.documentForPath(sourcePath);
  const second = await reopened.readDocument(recovered);
  assert.deepEqual(second.annotations.map((row) => row.uuid).sort(), ["new-square", "new-underline", "old-ink"]);
  assert.equal(second.storageProtocol, "wal-sidecar-v3.2-jsonl");
  assert.ok(w.files.has(`${ROOT}/wal/windows-A/${document.docKey}.jsonl`));
});

test("JSONL-only initialization, rename, reopen, and discovery never write v3.1 files", async () => {
  const w = world();
  const sourcePath = "Fixtures/jsonl-only.pdf";
  const source = { sourceHash: hash("jsonl-only immutable fixture"), size: 2048, pageCount: 2,
    orderedPageIdentities: ["page-a", "page-b"] };
  const store = w.store("ipad-A", true);
  const document = await store.registerDocument({ sourcePath, source });
  assert.ok(w.files.has(`${ROOT}/wal/ipad-A/${document.docKey}.jsonl.anchor.json`));
  assert.ok(w.files.has(`${ROOT}/sidecars/${document.docKey}.annotations.json`));
  assert.equal(w.files.has(`${ROOT}/sidecars/${document.docKey}.annot.json`), false);
  assert.equal(w.files.has(`${ROOT}/wal/ipad-A/${document.docKey}.json`), false);

  await store.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("jsonl-only-annotation", 0)] });
  await store.renameDocument({ documentId: document.documentId, fromPath: sourcePath,
    toPath: "Archive/jsonl-only.pdf" });
  const reopened = w.store("ipad-A", true);
  const recovered = await reopened.documentForPath("Archive/jsonl-only.pdf");
  assert.equal(recovered.documentId, document.documentId);
  assert.equal(recovered.docKey, document.docKey);
  assert.equal(recovered.sourcePath, "Archive/jsonl-only.pdf");
  const snapshot = await reopened.readDocument(recovered);
  assert.deepEqual(snapshot.annotations.map((row) => row.uuid), ["jsonl-only-annotation"]);
  assert.equal(w.files.has(`${ROOT}/sidecars/${document.docKey}.annot.json`), false);
  assert.equal(w.files.has(`${ROOT}/wal/ipad-A/${document.docKey}.json`), false);
});

test("an incomplete first JSONL row keeps an otherwise initialized document pending", async () => {
  const w = world();
  const sourcePath = "Fixtures/incomplete-first-row.pdf";
  const source = { sourceHash: hash("incomplete first row fixture"), size: 128, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const store = w.store("ipad-A", true);
  const document = await store.registerDocument({ sourcePath, source });
  await store.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("preserved-anchor-row", 0)] });
  const wal = `${ROOT}/wal/ipad-A/${document.docKey}.jsonl`;
  w.files.set(wal, "{\"lsn\":");
  const reopened = w.store("ipad-A", true);
  const result = await reopened.readDocument(document);
  assert.equal(result.syncPending, true);
  assert.deepEqual(result.annotations.map((row) => row.uuid), [],
    "invalid active rows are not treated as committed state");
  assert.equal(w.files.get(wal), "", "only the owning device repairs its incomplete first row");
});

test("opening a v3.1-only document materializes a v3.2 cache without changing old WAL bytes", async () => {
  const w = world();
  const sourcePath = "Fixtures/old-only.pdf";
  const source = { sourceHash: hash("old only immutable fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const old = w.store("windows-A", false);
  const document = await old.registerDocument({ sourcePath, source });
  await old.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("legacy-annotation", 1)] });
  const oldPath = `${ROOT}/wal/windows-A/${document.docKey}.json`;
  const oldBytes = w.files.get(oldPath);
  const upgraded = w.store("windows-A", true);
  const opened = await upgraded.documentForPath(sourcePath);
  await upgraded.materializeSnapshot(opened);
  assert.equal(w.files.get(oldPath), oldBytes);
  assert.ok(w.files.has(`${ROOT}/sidecars/${document.docKey}.annotations.json`));
  const reopened = w.store("windows-A", true);
  const result = await reopened.readDocument(await reopened.documentForPath(sourcePath));
  assert.deepEqual(result.annotations.map((row) => row.uuid), ["legacy-annotation"]);
});

test("first JSONL registration seeds an existing v3.1 state into the owner anchor without rewriting it", async () => {
  const w = world();
  const sourcePath = "Fixtures/legacy-registration-migration.pdf";
  const source = { sourceHash: hash("legacy registration fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const old = w.store("ipad-A", false);
  const legacyDocument = await old.registerDocument({ sourcePath, source });
  await old.appendOperations({ document: legacyDocument, sourceHash: source.sourceHash,
    operations: [annotation("legacy-kept", 0)] });
  const oldSidecar = `${ROOT}/sidecars/${legacyDocument.docKey}.annot.json`;
  const oldWal = `${ROOT}/wal/ipad-A/${legacyDocument.docKey}.json`;
  const sidecarBytes = w.files.get(oldSidecar);
  const walBytes = w.files.get(oldWal);

  const current = w.store("ipad-A", true);
  const migrated = await current.registerDocument({ sourcePath, source });
  const anchorPath = `${ROOT}/wal/ipad-A/${legacyDocument.docKey}.jsonl.anchor.json`;
  const anchor = JSON.parse(w.files.get(anchorPath));
  assert.ok(anchor.operations.some((operation) => operation.uuid === "legacy-kept"));
  assert.equal(w.files.get(oldSidecar), sidecarBytes);
  assert.equal(w.files.get(oldWal), walBytes);
  assert.equal(w.files.has(`${ROOT}/wal/ipad-A/${legacyDocument.docKey}.jsonl`), false);
  const reopened = await current.readDocument(migrated);
  assert.deepEqual(reopened.annotations.map((row) => row.uuid), ["legacy-kept"]);
});

test("two device-scoped JSONLs merge without overwriting one another", async () => {
  const w = world();
  const sourcePath = "Fixtures/two-device.pdf";
  const source = { sourceHash: hash("two-device immutable fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true);
  const document = await a.registerDocument({ sourcePath, source });
  const b = w.store("ipad-B", true);
  const docB = await b.documentForPath(sourcePath);
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("from-A", 1)] });
  await b.appendOperations({ document: docB, sourceHash: source.sourceHash, operations: [annotation("from-B", 2)] });
  const c = w.store("windows-A", true);
  const snapshot = await c.readDocument(await c.documentForPath(sourcePath));
  assert.deepEqual(snapshot.annotations.map((row) => row.uuid).sort(), ["from-A", "from-B"]);
  assert.ok(w.files.has(`${ROOT}/wal/windows-A/${document.docKey}.jsonl`));
  assert.ok(w.files.has(`${ROOT}/wal/ipad-B/${document.docKey}.jsonl`));
});

test("a stale derived snapshot cannot erase another device's archived operation", async () => {
  const w = world();
  const sourcePath = "Fixtures/stale-derived-cache.pdf";
  const source = { sourceHash: hash("stale snapshot fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true);
  const document = await a.registerDocument({ sourcePath, source });
  const b = w.store("ipad-B", true);
  const docB = await b.documentForPath(sourcePath);
  await a.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("from-A", 1)] });
  const snapshotPending = `${ROOT}/sidecars/${document.docKey}.annotations.json.pending`;
  const originalWrite = w.adapter.write;
  let releaseA;
  let signalPaused;
  const paused = new Promise((resolve) => { signalPaused = resolve; });
  const resume = new Promise((resolve) => { releaseA = resolve; });
  let held = false;
  w.adapter.write = async (path, text) => {
    if (path === snapshotPending && !held) {
      held = true;
      signalPaused();
      await resume;
    }
    return originalWrite(path, text);
  };
  try {
    const staleMaterialization = a.materializeSnapshot(document);
    await paused;
    await b.appendOperations({ document: docB, sourceHash: source.sourceHash,
      operations: [annotation("from-B", 2)] });
    await b.materializeSnapshot(docB);
    releaseA();
    await staleMaterialization;
  } finally {
    releaseA?.();
    w.adapter.write = originalWrite;
  }
  const c = w.store("fresh-C", true);
  const snapshot = await c.readDocument(await c.documentForPath(sourcePath));
  assert.equal(snapshot.syncPending, undefined);
  assert.deepEqual(snapshot.annotations.map((row) => row.uuid).sort(), ["from-A", "from-B"]);
});

test("immutable device archive recovers annotations when the derived snapshot is damaged", async () => {
  const w = world();
  const sourcePath = "Fixtures/archive-recovery.pdf";
  const source = { sourceHash: hash("archive recovery fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const first = w.store("windows-A", true);
  const document = await first.registerDocument({ sourcePath, source });
  await first.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("durable-A", 1)] });
  await first.materializeSnapshot(document);
  const derived = `${ROOT}/sidecars/${document.docKey}.annotations.json`;
  w.files.set(derived, "{broken derived cache");
  const reopened = w.store("windows-A", true);
  const loaded = await reopened.readDocument(await reopened.documentForPath(sourcePath));
  assert.deepEqual(loaded.annotations.map((row) => row.uuid), ["durable-A"]);
  assert.equal(loaded.syncPending, undefined);
});

test("a referenced immutable archive missing after sync fails closed", async () => {
  const w = world();
  const sourcePath = "Fixtures/archive-gap.pdf";
  const source = { sourceHash: hash("archive gap fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const first = w.store("windows-A", true);
  const document = await first.registerDocument({ sourcePath, source });
  await first.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("durable-A", 1)] });
  await first.materializeSnapshot(document);
  const archive = [...w.files.keys()].find((path) => path.includes(`${document.docKey}.jsonl.archive.`));
  assert.ok(archive);
  w.files.delete(archive);
  const reopened = w.store("windows-A", true);
  const loaded = await reopened.readDocument(await reopened.documentForPath(sourcePath));
  assert.equal(loaded.syncPending, true);
  assert.deepEqual(loaded.annotations.map((row) => row.uuid), ["durable-A"],
    "device anchor remains a read-only recovery witness");
});

test("own device torn tail repairs on reopen and preserves 500 committed rows", async () => {
  const w = world();
  const sourcePath = "Fixtures/torn-tail.pdf";
  const source = { sourceHash: hash("torn tail fixture"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const first = w.store("windows-A", true);
  const document = await first.registerDocument({ sourcePath, source });
  for (let index = 0; index < 500; index++) {
    await first.appendOperations({ document, sourceHash: source.sourceHash,
      operations: [annotation(`committed-${index}`, index)] });
  }
  const wal = `${ROOT}/wal/windows-A/${document.docKey}.jsonl`;
  w.files.set(wal, `${w.files.get(wal)}{"lsn":502,"op":"CRE`);
  const reopened = w.store("windows-A", true);
  const recovered = await reopened.readDocument(await reopened.documentForPath(sourcePath));
  assert.equal(recovered.annotations.length, 500);
  assert.equal(recovered.syncPending, undefined);
  assert.ok(w.files.get(wal).endsWith("\n"));
  assert.ok(!w.files.get(wal).includes('{"lsn":502,"op":"CRE'));
});

test("1,000 sequential host appendOperations calls use one append each and no repeated WAL reads", async () => {
  const w = world();
  const sourcePath = "Fixtures/throughput-copy.pdf";
  const source = { sourceHash: hash("throughput immutable fixture"), size: 11_919_545, pageCount: 357,
    orderedPageIdentities: Array.from({ length: 357 }, (_, index) => `page-${index}`) };
  const store = w.store("windows-A", true);
  const document = await store.registerDocument({ sourcePath, source });
  await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("item-0", 0)] });
  const readsAfterWarmup = w.calls.read;
  const appendsAfterWarmup = w.calls.append;
  for (let index = 1; index < 1000; index++) {
    await store.appendOperations({ document, sourceHash: source.sourceHash,
      operations: [annotation(`item-${index}`, index)] });
  }
  assert.equal(w.calls.append - appendsAfterWarmup, 999);
  assert.equal(w.calls.read, readsAfterWarmup, "hot calls must not re-read growing WAL files");
  const reopened = w.store("windows-A", true);
  const snapshot = await reopened.readDocument(await reopened.documentForPath(sourcePath));
  assert.equal(snapshot.annotations.length, 1000);
});
