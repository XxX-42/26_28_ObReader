import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";

const require = createRequire(import.meta.url);
const { createWalAnnotationStore } = require("../plugin/storage/wal-annotation-store.cjs");
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
const { makeMainSnapshotCandidate } = require("../plugin/storage/main-snapshot-candidate.cjs");
const { createMainSnapshotStore } = require("../plugin/storage/main-snapshot-store.cjs");
const { createMainRouteClaimStore } = require("../plugin/storage/main-route-claim-store.cjs");
const { createObsidianStorageBridge } = require("../plugin/storage/obsidian-storage-bridge.cjs");
const { createStorageIo } = require("../plugin/storage/io.cjs");
const { seal } = require("../plugin/storage/canonical.cjs");
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
    async copy(from, to) { if (files.has(to) || folders.has(to)) throw new Error("target exists"); files.set(to, files.get(from)); },
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
  const store = (deviceId, jsonlMode, options = {}) => createWalAnnotationStore({ adapter, root: ROOT, deviceId,
    uuid: (() => { let id = 0; return () => `${deviceId}-${++id}`; })(), hash, identityHash: hash,
    jsonlMode, ...options });
  return { files, folders, calls, adapter, store };
}

function annotation(uuid, index, { deleted = false, origin = "viewer" } = {}) {
  return { uuid, kind: "Square", pageIndex: index % 357, deleted,
    ...(!deleted ? { payload: { editor: { annotationType: 5, rect: [1, 2, 100, 120], index } } } : {}),
    clock: { timestamp: index + 1, logical: index, deviceId: origin, opId: `${origin}-${uuid}-${index}` } };
}

test("48-day retention projects expired deletes into guards without rewriting WAL history", async () => {
  const w = world();
  const start = Date.UTC(2026, 9, 22);
  let now = start;
  const options = { clock: () => now };
  let store = w.store("windows-retention", true, options);
  const document = await store.registerDocument({ sourcePath: "Fixtures/retention.pdf",
    source: { sourceHash: hash("retention immutable source"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] } });
  const deleted = { ...annotation("retained-delete", 0, { deleted: true }), embeddedRef: "7R" };
  await store.appendOperations({ document, operations: [deleted] });
  const original = await store.readDocument(document);
  assert.equal(original.tombstones.length, 1);
  await store.materializeSnapshot(document);
  const history = new Map([...w.files].filter(([p]) => /\.(?:archive\..*\.json|anchor\.json|jsonl)$/.test(p)));
  now += 48 * 24 * 60 * 60 * 1000 - 1;
  store = w.store("windows-retention", true, options);
  assert.equal((await store.readDocument(document)).tombstones.length, 1);
  now++;
  const expired = await store.readDocument(document);
  assert.equal(expired.tombstones.length, 0, "expired full tombstones leave the active snapshot");
  assert.deepEqual(expired.deletionGuards, [{ uuid: deleted.uuid, version: original.tombstones[0].version,
    pageIndex: 0, embeddedRef: "7R" }]);
  await store.materializeSnapshot(document);
  const disk = JSON.parse(w.files.get(`${ROOT}/sidecars/${document.docKey}.annotations.json`));
  assert.equal(disk.tombstones.length, 0);
  assert.deepEqual(disk.deletionGuards, expired.deletionGuards);
  for (const [p, bytes] of history) assert.equal(w.files.get(p), bytes, `history retained: ${p}`);
  const cold = w.store("windows-retention", true, options);
  assert.deepEqual((await cold.readDocument(document)).deletionGuards, expired.deletionGuards);
  await cold.appendOperations({ document, operations: [annotation(deleted.uuid, 2)] });
  const restored = await cold.readDocument(document);
  assert.equal(restored.annotations.length, 1, "a newer intentional restore wins");
  assert.deepEqual(restored.deletionGuards || [], []);
  await cold.appendOperations({ document, operations: [{ ...deleted, clock: { ...deleted.clock, opId: "delete-again" } }] });
  assert.equal((await cold.readDocument(document)).tombstones.length, 1, "a new delete starts its own retention period");
});

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
  assert.ok([...w.files.keys()].some((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json")),
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
    if (path.startsWith(`${snapshotPending}-`) && !held) {
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

test("published snapshot staging is safe only while its bytes match the verified final snapshot", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("snapshot stage safety"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/stage-safety.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("first", 1)] });
  await writer.materializeSnapshot(document);
  const snapshot = await writer.createMainCheckpoint(document);
  const finalPath = `${ROOT}/main-snapshots/${document.docKey}/${snapshot.snapshotId.slice(10)}.json`;
  const stage = [...w.files.keys()].find((path) => path.startsWith(`${finalPath}.pending-`));
  assert.ok(stage);
  assert.equal(w.files.get(stage), w.files.get(finalPath));
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("second", 2)] });
  assert.deepEqual((await w.store("fresh-C", true).readDocument(document, { readOnly: true })).annotations.map((row) => row.uuid).sort(), ["first", "second"]);
  w.files.set(stage, "unverified concurrent data");
  writer.invalidateExternal(stage);
  const unsafe = await w.store("fresh-D", true).readDocument(document, { readOnly: true });
  assert.equal(unsafe.syncPending, true);
  await assert.rejects(writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("third", 3)] }), { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(stage), "unverified concurrent data");
});

test("snapshot staging cannot establish a trusted route when the final snapshot is absent or both copies are corrupt", async () => {
  for (const failureMode of ["missing-final", "identically-corrupt"]) {
    const w = world(), writer = w.store("windows-A", true);
    const source = { sourceHash: hash(`stage ${failureMode}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const document = await writer.registerDocument({ sourcePath: `Fixtures/${failureMode}.pdf`, source });
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("first", 1)] });
    await writer.materializeSnapshot(document);
    const snapshot = await writer.createMainCheckpoint(document);
    const finalPath = `${ROOT}/main-snapshots/${document.docKey}/${snapshot.snapshotId.slice(10)}.json`;
    const stage = [...w.files.keys()].find((path) => path.startsWith(`${finalPath}.pending-`));
    assert.ok(stage);
    if (failureMode === "missing-final") w.files.delete(finalPath);
    else { w.files.set(finalPath, "{bad"); w.files.set(stage, "{bad"); }
    const registryPath = `${ROOT}/_registry.json`, registryBefore = w.files.get(registryPath);
    const fresh = w.store("fresh-C", true);
    await assert.rejects(fresh.registerDocument({ sourcePath: `Fixtures/new-${failureMode}.pdf`, source }), { code: "WAL_SYNC_PENDING" });
    assert.equal(w.files.get(registryPath), registryBefore, "an incomplete scan must preserve the existing registry");
    assert.ok(w.files.has(stage), "unverified bytes remain recoverable");
  }
});

test("main checkpoint candidates publish without changing existing archive bytes", async () => {
  const w = world();
  const sourcePath = "Fixtures/main-candidate.pdf";
  const source = { sourceHash: hash("main candidate source"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const first = w.store("windows-A", true);
  const document = await first.registerDocument({ sourcePath, source });
  await first.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("kept", 1)] });
  await first.materializeSnapshot(document);
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  assert.ok(paths.length > 0);
  const before = paths.map((path) => w.files.get(path));
  const candidate = await first.createMainCheckpoint(document);
  const same = await first.createMainCheckpoint(document);
  assert.equal(same.snapshotId, candidate.snapshotId, "unchanged maintenance must not create another snapshot");
  assert.ok(candidate.value.operations.some((entry) => entry.uuid === "kept"));
  assert.equal(candidate.value.segments.length, paths.length);
  const ack = await first.ackMainCheckpoint(document, candidate.snapshotId);
  assert.equal(ack.deviceId, "windows-A");
  assert.equal(ack.snapshotId, candidate.snapshotId);
  assert.deepEqual(await first.ackMainCheckpoint(document, candidate.snapshotId), ack);
  await assert.rejects(first.ackMainCheckpoint(document, hash("missing snapshot")), { code: "MAIN_SNAPSHOT_MISSING" });
  assert.deepEqual(paths.map((path) => w.files.get(path)), before);
  const reopened = w.store("fresh-C", true);
  assert.deepEqual((await reopened.readDocument(document, { readOnly: true })).annotations.map((row) => row.uuid), ["kept"]);
  await first.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("newer", 2)] });
  await assert.rejects(first.ackMainCheckpoint(document, candidate.snapshotId), { code: "MAIN_SNAPSHOT_STALE" });
});

test("checkpoint acknowledgement refuses missing durable input receipts even when visible state matches", async () => {
  const w = world();
  const source = { sourceHash: hash("missing checkpoint receipts"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const writer = w.store("windows-A", true);
  const document = await writer.registerDocument({ sourcePath: "Fixtures/missing-receipts.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("same", 1)] });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("same", 2)] });
  await writer.materializeSnapshot(document);
  const complete = await writer.createMainCheckpoint(document);
  assert.ok(complete.value.receipts.length >= 2);
  const stripped = await makeMainSnapshotCandidate({ document, operations: complete.value.operations,
    parents: [complete.snapshotId], segments: complete.value.segments, receipts: [], hash });
  const publisher = createMainSnapshotStore({ adapter: w.adapter, root: ROOT, hash, token: () => "receipt-gap" });
  await publisher.publish(document, stripped);
  await assert.rejects(writer.ackMainCheckpoint(document, stripped.snapshotId), { code: "MAIN_SNAPSHOT_STALE" });
  const ackPath = `${ROOT}/main-acks/${document.docKey}/${stripped.snapshotId.slice(10)}/windows-A.json`;
  assert.equal(w.files.has(ackPath), false);
  const forgedAck = await seal({ schemaVersion: 1, kind: "pdf-reader-main-snapshot-ack", docKey: document.docKey,
    documentId: document.documentId, sourceHash: source.sourceHash, snapshotId: stripped.snapshotId, deviceId: "windows-A" }, hash);
  w.files.set(ackPath, JSON.stringify(forgedAck));
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  await assert.rejects(writer.pruneCoveredArchives({ document, current: stripped.snapshotId, previous: complete.snapshotId, paths }),
    { code: "MAIN_RECOVERY_PENDING" });
  assert.ok(paths.every((path) => w.files.has(path)), "an invalid legacy ACK cannot authorize deletion");
});

test("a verified main checkpoint recovers annotations after covered archives are removed", async () => {
  const w = world();
  const sourcePath = "Fixtures/checkpoint-archive-recovery.pdf";
  const source = { sourceHash: hash("checkpoint archive recovery"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const first = w.store("windows-A", true);
  const document = await first.registerDocument({ sourcePath, source });
  await first.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("kept-one", 1), annotation("kept-two", 2)] });
  await first.materializeSnapshot(document);
  const previous = await first.createMainCheckpoint(document);
  const archives = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  await first.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("kept-three", 3)] });
  await first.materializeSnapshot(document);
  const current = await first.createMainCheckpoint(document);
  assert.ok(archives.length > 0, "the test must remove a real archived batch");
  await first.ackMainCheckpoint(document, current.snapshotId);
  const result = await first.pruneCoveredArchives({ document, current: current.snapshotId,
    previous: previous.snapshotId, paths: archives });
  assert.equal(result.removedCount, archives.length, "the validated GC must remove covered archives");
  for (const path of archives) assert.equal(w.files.has(path), false);
  const reopened = w.store("fresh-C", true);
  const snapshot = await reopened.readDocument(document, { readOnly: true });
  assert.equal(snapshot.syncPending, undefined, "a verified checkpoint must replace covered archive dependencies");
  assert.deepEqual(snapshot.annotations.map((row) => row.uuid).sort(), ["kept-one", "kept-two", "kept-three"].sort());
  for (const path of [...w.files.keys()]) {
    if (path.startsWith(`${ROOT}/wal/`) || path.startsWith(`${ROOT}/sidecars/`)) w.files.delete(path);
  }
  const checkpointOnly = await w.store("fresh-D", true).readDocument(document, { readOnly: true });
  assert.deepEqual(checkpointOnly.annotations.map((row) => row.uuid).sort(), snapshot.annotations.map((row) => row.uuid).sort());
  assert.equal(checkpointOnly.syncPending, undefined);
  assert.ok(checkpointOnly.revision >= 3);
  w.files.delete(`${ROOT}/_registry.json`);
  const rediscovered = await w.store("fresh-E", true).documentForPath(sourcePath);
  assert.equal(rediscovered.documentId, document.documentId, "recovery evidence must rebuild a missing route cache");
});

test("same device resumes above recovered sequence after all owner files disappear", async () => {
  const w = world();
  const source = { sourceHash: hash("sequence floor from checkpoint"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const writer = w.store("windows-A", true);
  const document = await writer.registerDocument({ sourcePath: "Fixtures/recovery-sequence.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("kept-one", 1)] });
  await writer.materializeSnapshot(document);
  const previous = await writer.createMainCheckpoint(document);
  const oldArchives = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("kept-two", 2)] });
  await writer.materializeSnapshot(document);
  const current = await writer.createMainCheckpoint(document);
  await writer.ackMainCheckpoint(document, current.snapshotId);
  await writer.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths: oldArchives });
  const maxSequence = Math.max(...current.value.operations.filter((op) => op.version.deviceId === "windows-A").map((op) => op.seq),
    ...current.value.segments.filter((segment) => segment.deviceId === "windows-A").map((segment) => segment.lastSeq));
  for (const path of [...w.files.keys()]) if (path.startsWith(`${ROOT}/wal/windows-A/`)) w.files.delete(path);
  const restarted = w.store("windows-A", true);
  const reopened = await restarted.registerDocument({ sourcePath: "Fixtures/recovery-sequence.pdf", source });
  await restarted.appendOperations({ document: reopened, sourceHash: source.sourceHash, operations: [annotation("after-recovery", 3)] });
  const rows = w.files.get(`${ROOT}/wal/windows-A/${document.docKey}.jsonl`).trim().split("\n").map(JSON.parse);
  assert.ok(rows.every((row) => row.lsn > maxSequence), `reused sequence: ${rows.map((row) => row.lsn)}`);
  const state = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(state.annotations.map((row) => row.uuid).sort(), ["after-recovery", "kept-one", "kept-two"]);
  assert.equal(state.syncPending, undefined);
});

test("replayed old save after compaction cannot replace a newer annotation", async () => {
  const w = world();
  const source = { sourceHash: hash("old save retry recovery"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const writer = w.store("windows-A", true);
  const document = await writer.registerDocument({ sourcePath: "Fixtures/recovery-old-retry.pdf", source });
  const old = annotation("same", 1);
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [old] });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("same", 2)] });
  await writer.materializeSnapshot(document);
  const previous = await writer.createMainCheckpoint(document);
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("other", 3)] });
  await writer.materializeSnapshot(document);
  const current = await writer.createMainCheckpoint(document);
  await writer.ackMainCheckpoint(document, current.snapshotId);
  await writer.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths });
  w.files.delete(`${ROOT}/wal/windows-A/${document.docKey}.jsonl.anchor.json`);
  const reopened = w.store("windows-A", true);
  await reopened.appendOperations({ document, sourceHash: source.sourceHash, operations: [old] });
  const state = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(state.annotations.find((row) => row.uuid === "same").payload.editor.index, 2,
    "retrying the already acknowledged old input must not undo the newer edit");
  const conflicting = structuredClone(old);
  conflicting.payload.editor.index = 999;
  await assert.rejects(reopened.appendOperations({ document, sourceHash: source.sourceHash, operations: [conflicting] }),
    { code: "WAL_OPERATION_COLLISION" });
});

test("archive GC waits for a known reader-only device even if it has no document WAL", async () => {
  const w = world();
  const source = { sourceHash: hash("reader-only device GC"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true), b = w.store("ipad-B", true);
  const document = await a.registerDocument({ sourcePath: "Fixtures/reader-device-gc.pdf", source });
  await b.signalMainDeviceActivity();
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 1)] });
  await a.materializeSnapshot(document);
  const previous = await a.createMainCheckpoint(document);
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  assert.ok(paths.length > 0);
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 2)] });
  await a.materializeSnapshot(document);
  const current = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, current.snapshotId);
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "MAIN_RECOVERY_ACK_PENDING" });
  assert.ok(paths.every((path) => w.files.has(path)), "unacknowledged reader must prevent all deletion");
  const presencePath = `${ROOT}/main-device-presence/ipad-B.json`;
  const savedPresence = w.files.get(presencePath);
  w.files.set(presencePath, "{broken");
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "WAL_FILE_INVALID" });
  assert.ok(paths.every((path) => w.files.has(path)), "corrupt device identity must fail closed");
  w.files.set(presencePath, savedPresence);
  await b.ackMainCheckpoint(document, current.snapshotId);
  const late = w.store("mac-C", true);
  const originalWrite = w.adapter.write;
  let injected = false;
  w.adapter.write = async (path, contents) => {
    const result = await originalWrite(path, contents);
    if (!injected && path.startsWith(`${ROOT}/main-recovery/`)) {
      injected = true;
      await late.signalMainDeviceActivity();
    }
    return result;
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "MAIN_RECOVERY_ACK_PENDING" });
  w.adapter.write = originalWrite;
  assert.ok(injected, "a new device must arrive while the recovery certificate is published");
  assert.ok(paths.every((path) => w.files.has(path)), "a newly visible device must stop deletion");
});

test("create-only publication preserves staging bytes replaced before cleanup", async () => {
  const w = world(), target = `${ROOT}/immutable/stage-race.json`;
  const io = createStorageIo({ adapter: w.adapter, hash, token: () => "test-token" });
  const pending = `${target}.pending-test-token`, originalCopy = w.adapter.copy;
  w.adapter.copy = async (from, to) => {
    await originalCopy(from, to);
    if (from === pending) w.files.set(from, "newly synchronized data");
  };
  w.adapter.remove = async () => { throw new Error("unsafe staging cleanup attempted"); };
  await io.writeJsonAtomic(target, { kind: "original" }, { createOnly: true });
  assert.equal(w.files.get(pending), "newly synchronized data", "new data must survive cleanup");
});

test("a create-only publication cannot overwrite a file appearing before rename", async () => {
  const w = world(), target = `${ROOT}/immutable/example.json`;
  const io = createStorageIo({ adapter: w.adapter, hash, token: () => "new-token" });
  const originalCopy = w.adapter.copy;
  w.adapter.copy = async (from, to) => {
    if (to === target) { w.files.set(target, "concurrent existing bytes"); throw new Error("target exists"); }
    return originalCopy(from, to);
  };
  await assert.rejects(io.writeJsonAtomic(target, { kind: "new" }, { createOnly: true }));
  assert.equal(w.files.get(target), "concurrent existing bytes");
});

test("a create-only publication cannot overwrite when rename permits replacement", async () => {
  const w = world(), target = `${ROOT}/immutable/rename-replaces.json`;
  const io = createStorageIo({ adapter: w.adapter, hash, token: () => "new-token" });
  const originalCopy = w.adapter.copy;
  w.adapter.copy = async (from, to) => {
    if (to === target) w.files.set(target, "concurrent existing bytes");
    return originalCopy(from, to);
  };
  await assert.rejects(io.writeJsonAtomic(target, { kind: "new" }, { createOnly: true }));
  assert.equal(w.files.get(target), "concurrent existing bytes");
});

test("create-only publication refuses an adapter without a no-replace copy", async () => {
  const w = world(), target = `${ROOT}/immutable/no-copy.json`;
  delete w.adapter.copy;
  const io = createStorageIo({ adapter: w.adapter, hash, token: () => "new-token" });
  await assert.rejects(io.writeJsonAtomic(target, { kind: "new" }, { createOnly: true }),
    { code: "WAL_CREATE_ONLY_UNAVAILABLE" });
  assert.equal(w.files.has(target), false);
  assert.ok(w.files.has(`${target}.pending-new-token`), "the staged bytes remain available for diagnosis");
});

test("concurrent create-only writers retain the losing writer's unique staged bytes", async () => {
  const w = world(), target = `${ROOT}/immutable/concurrent.json`;
  const a = createStorageIo({ adapter: w.adapter, hash, token: () => "device-a" });
  const b = createStorageIo({ adapter: w.adapter, hash, token: () => "device-b" });
  const results = await Promise.allSettled([
    a.writeJsonAtomic(target, { kind: "device-a" }, { createOnly: true }),
    b.writeJsonAtomic(target, { kind: "device-b" }, { createOnly: true }),
  ]);
  assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(results.filter((entry) => entry.status === "rejected").length, 1);
  const winner = JSON.parse(w.files.get(target)).kind;
  const loser = winner === "device-a" ? "device-b" : "device-a";
  assert.equal(JSON.parse(w.files.get(`${target}.pending-${loser}`)).kind, loser);
});

test("archive GC preserves replacement bytes that arrive at the deletion boundary", async () => {
  const w = world();
  const source = { sourceHash: hash("GC boundary replacement"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true);
  const document = await a.registerDocument({ sourcePath: "Fixtures/gc-boundary.pdf", source });
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 0)] });
  await a.materializeSnapshot(document);
  const previous = await a.createMainCheckpoint(document);
  const path = [...w.files.keys()].find((item) => item.includes(`${document.docKey}.jsonl.archive.`) && item.endsWith(".json"));
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 1)] });
  await a.materializeSnapshot(document);
  const current = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, current.snapshotId);
  const replacement = "new bytes delivered by a concurrent sync";
  const originalRemove = w.adapter.remove, originalRename = w.adapter.rename;
  let injected = false;
  w.adapter.remove = async (candidate) => {
    if (!injected && candidate === path) { injected = true; w.files.set(path, replacement); }
    return originalRemove(candidate);
  };
  w.adapter.rename = async (from, to) => {
    if (!injected && from === path && to.startsWith(`${path}.gc-`)) { injected = true; w.files.set(path, replacement); }
    return originalRename(from, to);
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths: [path] }));
  w.adapter.remove = originalRemove; w.adapter.rename = originalRename;
  assert.equal(injected, true);
  assert.ok([...w.files].some(([name, value]) => (name === path || name.startsWith(`${path}.gc-`)) && value === replacement),
    "replacement bytes must survive even if the file changes after the last check");
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(recovered.syncPending, true, "an unverified quarantined archive must be reported as pending");
  await assert.rejects(a.resumeMainArchiveCleanup(document), { code: "MAIN_RECOVERY_PENDING" });
  assert.ok([...w.files].some(([name, value]) => name.startsWith(`${path}.gc-`) && value === replacement),
    "retrying cleanup must retain unverified replacement bytes");
});

test("archive GC requires both devices and survives an interrupted delete with fresh disk replay", async () => {
  const w = world();
  const source = { sourceHash: hash("multi-device cleanup"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true), b = w.store("ipad-B", true);
  const document = await a.registerDocument({ sourcePath: "Fixtures/multi-gc.pdf", source });
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 1)] });
  await a.materializeSnapshot(document);
  await b.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 2)] });
  await b.materializeSnapshot(document);
  const previous = await a.createMainCheckpoint(document);
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("C", 3)] });
  await a.materializeSnapshot(document);
  const current = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, current.snapshotId);
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "MAIN_RECOVERY_ACK_PENDING" });
  for (const path of paths) assert.ok(w.files.has(path));
  await b.ackMainCheckpoint(document, current.snapshotId);
  const originalRemove = w.adapter.remove;
  let count = 0;
  w.adapter.remove = async (path) => {
    if (paths.some((original) => path.startsWith(`${original}.gc-`)) && ++count === 2) throw new Error("crash during archive cleanup");
    return originalRemove(path);
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }), /crash during/);
  w.adapter.remove = originalRemove;
  assert.equal(w.files.has(paths[0]), false, "GC must actually have removed an archive before interruption");
  const staged = [...w.files.keys()].find((name) => paths.some((original) => name.startsWith(`${original}.gc-`)));
  assert.ok(staged, "the interrupted cleanup must retain its staged archive for recovery");
  const stagedBytes = w.files.get(staged);
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(recovered.syncPending, undefined);
  assert.deepEqual(recovered.annotations.map((row) => row.uuid).sort(), ["A", "B", "C"]);
  assert.ok(w.files.has(staged), "read-only recovery must not delete the staged archive");
  const ackPath = `${ROOT}/main-acks/${document.docKey}/${current.snapshotId.slice(10)}/ipad-B.json`;
  const ack = w.files.get(ackPath);
  w.files.delete(ackPath);
  await assert.rejects(a.resumeMainArchiveCleanup(document), { code: "MAIN_RECOVERY_PENDING" });
  assert.ok(w.files.has(staged), "resumption must preserve the stage if a device ACK is missing");
  w.files.set(ackPath, ack);
  const resumed = await a.resumeMainArchiveCleanup(document);
  assert.equal(resumed.removedCount, 1);
  assert.equal(w.files.has(staged), false, "a matching staged archive is removed only after revalidation");
  const afterResume = await w.store("fresh-D", true).readDocument(document, { readOnly: true });
  assert.deepEqual(afterResume.annotations.map((row) => row.uuid).sort(), ["A", "B", "C"]);
  w.files.set(staged, stagedBytes);
  await a.maintainMainSnapshots(document);
  assert.equal(w.files.has(staged), false, "the next maintenance event resumes a verified interrupted cleanup");
});

test("archive GC stops after a device arrives between two physical removals", async () => {
  const w = world();
  const source = { sourceHash: hash("late presence during removal"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true), late = w.store("ipad-B", true);
  const document = await a.registerDocument({ sourcePath: "Fixtures/late-device-gc.pdf", source });
  for (let i = 0; i < 2; i++) {
    await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`A-${i}`, i)] });
    await a.materializeSnapshot(document);
  }
  const previous = await a.createMainCheckpoint(document);
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  assert.equal(paths.length, 2);
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("new", 3)] });
  await a.materializeSnapshot(document);
  const current = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, current.snapshotId);
  const originalRemove = w.adapter.remove;
  let removed = 0;
  w.adapter.remove = async (path) => {
    const result = await originalRemove(path);
    if (paths.some((original) => path.startsWith(`${original}.gc-`)) && ++removed === 1) await late.signalMainDeviceActivity();
    return result;
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "MAIN_RECOVERY_ACK_PENDING" });
  w.adapter.remove = originalRemove;
  assert.equal(removed, 1);
  assert.ok(paths.some((path) => w.files.has(path)), "later archives must remain available");
  const fresh = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(fresh.annotations.map((row) => row.uuid).sort(), ["A-0", "A-1", "new"]);
});

test("snapshot retention stops if a device arrives after archive removal", async () => {
  const w = world();
  const source = { sourceHash: hash("late presence during snapshot retention"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true), late = w.store("ipad-B", true);
  const document = await a.registerDocument({ sourcePath: "Fixtures/late-device-snapshots.pdf", source });
  const snapshots = [];
  for (let i = 0; i < 10; i++) {
    await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`mark-${i}`, i)] });
    await a.materializeSnapshot(document);
    snapshots.push(await a.createMainCheckpoint(document));
  }
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json")).slice(0, 1);
  assert.equal(paths.length, 1);
  const previous = snapshots.at(-2), current = snapshots.at(-1);
  await a.ackMainCheckpoint(document, current.snapshotId);
  const before = [...w.files.keys()].filter((path) => path.startsWith(`${ROOT}/main-snapshots/${document.docKey}/`) && path.endsWith(".json"));
  assert.equal(before.length, 10);
  const originalRemove = w.adapter.remove;
  let injected = false;
  w.adapter.remove = async (path) => {
    const result = await originalRemove(path);
    if (!injected && paths.some((original) => path.startsWith(`${original}.gc-`))) {
      injected = true;
      await late.signalMainDeviceActivity();
    }
    return result;
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "MAIN_RECOVERY_ACK_PENDING" });
  w.adapter.remove = originalRemove;
  assert.equal(injected, true);
  assert.ok(before.every((path) => w.files.has(path)), "no checkpoints may be deleted after a new device appears");
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(recovered.annotations.length, 10);
});

test("snapshot cleanup preserves replacement bytes delivered at the deletion boundary", async () => {
  const w = world(), a = w.store("windows-A", true);
  const source = { sourceHash: hash("snapshot GC boundary"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/snapshot-gc-boundary.pdf", source });
  const snapshots = [];
  for (let i = 0; i < 10; i++) {
    await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`mark-${i}`, i)] });
    await a.materializeSnapshot(document);
    snapshots.push(await a.createMainCheckpoint(document));
  }
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json")).slice(0, 1);
  const previous = snapshots.at(-2), current = snapshots.at(-1);
  await a.ackMainCheckpoint(document, current.snapshotId);
  const replacement = "concurrently replaced snapshot bytes";
  const originalRemove = w.adapter.remove, originalRename = w.adapter.rename;
  let injectedPath = null;
  w.adapter.remove = async (path) => {
    if (!injectedPath && path.startsWith(`${ROOT}/main-snapshots/${document.docKey}/`) && path.endsWith(".json")) {
      injectedPath = path; w.files.set(path, replacement);
    }
    return originalRemove(path);
  };
  w.adapter.rename = async (from, to) => {
    if (!injectedPath && from.startsWith(`${ROOT}/main-snapshots/${document.docKey}/`) && to.startsWith(`${from}.gc-`)) {
      injectedPath = from; w.files.set(from, replacement);
    }
    return originalRename(from, to);
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }));
  w.adapter.remove = originalRemove; w.adapter.rename = originalRename;
  assert.ok(injectedPath, "the test must reach actual old snapshot cleanup");
  assert.ok([...w.files].some(([name, value]) => (name === injectedPath || name.startsWith(`${injectedPath}.gc-`)) && value === replacement));
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(recovered.syncPending, true);
});

test("archive GC must not discard a changed staging file at the final remove boundary", async () => {
  const w = world(), a = w.store("windows-A", true);
  const source = { sourceHash: hash("staged archive remove boundary"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/staged-remove-boundary.pdf", source });
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 1)] });
  await a.materializeSnapshot(document);
  const previous = await a.createMainCheckpoint(document);
  const path = [...w.files.keys()].find((name) => name.includes(`${document.docKey}.jsonl.archive.`) && name.endsWith(".json"));
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 2)] });
  await a.materializeSnapshot(document);
  const current = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, current.snapshotId);
  const originalRemove = w.adapter.remove, replacement = "new bytes delivered at staged removal";
  let staged = null;
  w.adapter.remove = async (candidate) => {
    if (!staged && candidate.startsWith(`${path}.gc-`)) {
      staged = candidate;
      w.files.set(candidate, replacement);
    }
    return originalRemove(candidate);
  };
  try {
    await a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths: [path] });
  } catch { /* A safe implementation may reject the interrupted cleanup. */ }
  finally { w.adapter.remove = originalRemove; }
  assert.ok(staged, "the test must reach physical removal of a staged archive");
  assert.ok([...w.files].some(([, value]) => value === replacement), "changed bytes must not be deleted");
});

test("snapshot cleanup retains staged bytes if a new device appears after rename", async () => {
  const w = world(), a = w.store("windows-A", true), late = w.store("ipad-B", true);
  const source = { sourceHash: hash("snapshot device arrival"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/snapshot-device-arrival.pdf", source });
  const snapshots = [];
  for (let i = 0; i < 10; i++) {
    await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`mark-${i}`, i)] });
    await a.materializeSnapshot(document);
    snapshots.push(await a.createMainCheckpoint(document));
  }
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json")).slice(0, 1);
  const previous = snapshots.at(-2), current = snapshots.at(-1);
  await a.ackMainCheckpoint(document, current.snapshotId);
  const originalRename = w.adapter.rename;
  let staged = null, stagedBytes = null;
  w.adapter.rename = async (from, to) => {
    const result = await originalRename(from, to);
    if (!staged && from.startsWith(`${ROOT}/main-snapshots/${document.docKey}/`) && to.startsWith(`${from}.gc-`)) {
      staged = to; stagedBytes = w.files.get(to);
      await late.signalMainDeviceActivity();
    }
    return result;
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "MAIN_RECOVERY_ACK_PENDING" });
  w.adapter.rename = originalRename;
  assert.ok(staged, "test must reach the staged snapshot boundary");
  assert.equal(w.files.get(staged), stagedBytes);
  assert.equal((await w.store("fresh-C", true).readDocument(document, { readOnly: true })).syncPending, true);
});

test("recovery certificate cleanup retains concurrently replaced bytes", async () => {
  const w = world(), a = w.store("windows-A", true);
  const source = { sourceHash: hash("certificate cleanup boundary"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/certificate-gc-boundary.pdf", source });
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 1)] });
  await a.materializeSnapshot(document);
  const first = await a.createMainCheckpoint(document);
  const firstArchive = [...w.files.keys()].find((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 2)] });
  await a.materializeSnapshot(document);
  const second = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, second.snapshotId);
  await a.pruneCoveredArchives({ document, current: second.snapshotId, previous: first.snapshotId, paths: [firstArchive] });
  const remainingArchive = [...w.files.keys()].find((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  assert.ok(remainingArchive);
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("C", 3)] });
  await a.materializeSnapshot(document);
  const third = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, third.snapshotId);
  const originalRename = w.adapter.rename, replacement = "concurrent recovery certificate", prefix = `${ROOT}/main-recovery/${document.docKey}/`;
  let replaced = null;
  w.adapter.rename = async (from, to) => {
    if (!replaced && from.startsWith(prefix) && to.startsWith(`${from}.gc-`)) {
      replaced = from; w.files.set(from, replacement);
    }
    return originalRename(from, to);
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: third.snapshotId, previous: second.snapshotId, paths: [remainingArchive] }));
  w.adapter.rename = originalRename;
  assert.ok(replaced);
  assert.ok([...w.files].some(([path, value]) => path.startsWith(`${replaced}.gc-`) && value === replacement));
  assert.equal((await w.store("fresh-C", true).readDocument(document, { readOnly: true })).syncPending, true);
});

test("corrupt recovery backup and failed certificate publication never remove an archive", async () => {
  const w = world();
  const source = { sourceHash: hash("GC fail closed"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true);
  const document = await a.registerDocument({ sourcePath: "Fixtures/gc-fail-closed.pdf", source });
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 1)] });
  await a.materializeSnapshot(document);
  const previous = await a.createMainCheckpoint(document);
  const paths = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 2)] });
  await a.materializeSnapshot(document);
  const current = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, current.snapshotId);
  const backupPath = `${ROOT}/main-snapshots/${document.docKey}/${previous.snapshotId.slice(10)}.json`;
  const savedBackup = w.files.get(backupPath);
  w.files.set(backupPath, "{broken");
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }),
    { code: "MAIN_SNAPSHOT_CORRUPT" });
  for (const path of paths) assert.ok(w.files.has(path));
  w.files.set(backupPath, savedBackup);
  const originalWrite = w.adapter.write;
  w.adapter.write = async (path, text) => {
    if (path.startsWith(`${ROOT}/main-recovery/`)) throw new Error("certificate write failed");
    return originalWrite(path, text);
  };
  await assert.rejects(a.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths }), /certificate write failed/);
  w.adapter.write = originalWrite;
  for (const path of paths) assert.ok(w.files.has(path));
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(recovered.annotations.map((row) => row.uuid), ["A", "B"]);
});

test("late offline device data remains recoverable after another device runs maintenance", async () => {
  const winWorld = world(), ipadWorld = world();
  const windows = winWorld.store("windows-A", true);
  const source = { sourceHash: hash("offline late device"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await windows.registerDocument({ sourcePath: "Fixtures/offline-device.pdf", source });
  // The iPad receives the initial shared state, then disconnects. Its later
  // device identity and annotation are absent from Windows during maintenance.
  for (const [path, value] of winWorld.files) ipadWorld.files.set(path, value);
  for (const folder of winWorld.folders) ipadWorld.folders.add(folder);
  const ipad = ipadWorld.store("ipad-B", true);
  const ipadDocument = await ipad.registerDocument({ sourcePath: document.sourcePath, source });
  await ipad.appendOperations({ document: ipadDocument, sourceHash: source.sourceHash, operations: [annotation("ipad-offline", 8)] });
  await ipad.materializeSnapshot(ipadDocument);
  for (let index = 0; index < 3; index++) {
    await windows.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`windows-${index}`, index)] });
    await windows.materializeSnapshot(document);
  }
  const archives = [...winWorld.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  const maintenance = await windows.maintainMainSnapshots(document);
  assert.equal(maintenance.reason, "MAIN_DISTRIBUTED_GC_UNVERIFIED");
  assert.ok(archives.every((path) => winWorld.files.has(path)));
  // Model transport of independent device-owned files, not a shared JS lock.
  for (const [path, value] of ipadWorld.files) {
    if (path.startsWith(`${ROOT}/wal/ipad-B/`) || path.startsWith(`${ROOT}/main-device-presence/ipad-B`)) {
      winWorld.files.set(path, value);
    }
  }
  for (const folder of ipadWorld.folders) winWorld.folders.add(folder);
  const recovered = await winWorld.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(recovered.annotations.map((row) => row.uuid).sort(), ["ipad-offline", "windows-0", "windows-1", "windows-2"].sort());
});

test("automatic maintenance retains archives until distributed deletion is safe", async () => {
  const w = world(), a = w.store("windows-A", true);
  const source = { sourceHash: hash("automatic GC safety gate"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/automatic-gc-safety.pdf", source });
  for (let index = 0; index < 3; index++) {
    await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`item-${index}`, index)] });
    await a.materializeSnapshot(document);
  }
  const before = [...w.files.keys()].filter((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  assert.ok(before.length >= 3);
  const result = await a.maintainMainSnapshots(document);
  assert.equal(result.status, "deferred");
  assert.equal(result.reason, "MAIN_DISTRIBUTED_GC_UNVERIFIED");
  assert.ok(before.every((path) => w.files.has(path)), "automatic maintenance must preserve every archive");
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(recovered.annotations.map((row) => row.uuid), ["item-0", "item-1", "item-2"]);
});

test("maintenance combines archive and snapshot counts and remains stable without new edits", async () => {
  const w = world();
  const source = { sourceHash: hash("threshold automatic maintenance"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const a = w.store("windows-A", true);
  const document = await a.registerDocument({ sourcePath: "Fixtures/main-threshold.pdf", source });
  assert.equal((await a.maintainMainSnapshots(document)).status, "below-threshold");
  for (let index = 0; index < 3; index++) {
    await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`kept-${index}`, index)] });
    await a.materializeSnapshot(document);
  }
  const result = await a.maintainMainSnapshots(document);
  assert.equal(result.status, "compacted");
  assert.equal(result.removedCount, 2);
  const snapshotPaths = () => [...w.files.keys()].filter((path) => path.startsWith(`${ROOT}/main-snapshots/`) && path.endsWith(".json"));
  const count = snapshotPaths().length;
  assert.equal(count, 2);
  await a.maintainMainSnapshots(document);
  assert.equal(snapshotPaths().length, count, "an unchanged maintenance event must not create another snapshot");
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(recovered.annotations.map((row) => row.uuid), ["kept-0", "kept-1", "kept-2"]);
  assert.equal(recovered.syncPending, undefined);
});

test("saving a new annotation publishes device activity without changing the WAL ACK", async () => {
  const w = world(), store = w.store("windows-A", true);
  const source = { sourceHash: hash("save publishes device activity"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await store.registerDocument({ sourcePath: "Fixtures/save-presence.pdf", source });
  const ack = await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("saved", 0)] });
  assert.equal(ack.operationCount, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(w.files.has(`${ROOT}/main-device-presence/windows-A.json`), "an actual save should mark the device active");
});

test("presence publication failure cannot revoke a durable annotation save", async () => {
  const w = world(), timings = [], store = w.store("windows-A", true, { onTiming: (entry) => timings.push(entry) });
  const source = { sourceHash: hash("save despite presence failure"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await store.registerDocument({ sourcePath: "Fixtures/save-presence-failure.pdf", source });
  const originalWrite = w.adapter.write;
  w.adapter.write = async (path, text) => {
    if (path.startsWith(`${ROOT}/main-device-presence/`)) throw new Error("presence write failed");
    return originalWrite(path, text);
  };
  const ack = await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("saved", 0)] });
  assert.equal(ack.operationCount, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(timings.some((entry) => entry.phase === "device-presence-error"));
  w.adapter.write = originalWrite;
  const restored = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(restored.annotations.map((row) => row.uuid), ["saved"]);
});

test("a save burst coalesces device presence while keeping each WAL operation durable", async () => {
  const w = world(), store = w.store("windows-A", true);
  const source = { sourceHash: hash("save burst presence"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await store.registerDocument({ sourcePath: "Fixtures/save-presence-burst.pdf", source });
  const originalWrite = w.adapter.write;
  let releaseFirst, announceFirst, announceSecond;
  const firstStarted = new Promise((resolve) => { announceFirst = resolve; });
  const secondStarted = new Promise((resolve) => { announceSecond = resolve; });
  const hold = new Promise((resolve) => { releaseFirst = resolve; });
  let writes = 0;
  w.adapter.write = async (path, text) => {
    if (path.startsWith(`${ROOT}/main-device-presence/`) && path.endsWith(".pending")) {
      writes++;
      if (writes === 1) { announceFirst(); await hold; }
      if (writes === 2) announceSecond();
    }
    return originalWrite(path, text);
  };
  const first = await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("burst-0", 0)] });
  assert.equal(first.operationCount, 1);
  await firstStarted;
  try {
    for (let index = 1; index < 20; index++) {
      assert.equal((await store.appendOperations({ document, sourceHash: source.sourceHash,
        operations: [annotation(`burst-${index}`, index)] })).operationCount, 1);
    }
  } finally { releaseFirst(); }
  await secondStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 2, "one running and one pending activity publish cover the burst");
  w.adapter.write = originalWrite;
  const restored = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(restored.annotations.length, 20);
});

test("save activity is refreshed on later edits and after a clock rollback", async () => {
  const w = world(); let now = 0;
  const store = w.store("windows-A", true, { clock: () => now });
  const source = { sourceHash: hash("save activity interval"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await store.registerDocument({ sourcePath: "Fixtures/save-activity-interval.pdf", source });
  const presence = `${ROOT}/main-device-presence/windows-A.json`;
  async function save(index) {
    await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`interval-${index}`, index)] });
    await new Promise((resolve) => setImmediate(resolve));
    return w.files.get(presence);
  }
  const first = await save(0);
  now = 59_999;
  assert.equal(await save(1), first);
  now = 60_000;
  const later = await save(2);
  assert.notEqual(later, first);
  now = 1_000;
  assert.notEqual(await save(3), later, "a backwards clock must not suppress a new activity signal");
});

test("device presence tracks activity across different documents and survives observer restart", async () => {
  const w = world();
  let now = 1_000;
  const options = { clock: () => now };
  const windows = w.store("windows-A", true, options), ipad = w.store("ipad-B", true, options);
  const sourceA = { sourceHash: hash("device book A"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const sourceB = { sourceHash: hash("device book B"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const bookA = await windows.registerDocument({ sourcePath: "Fixtures/device-A.pdf", source: sourceA });
  const bookB = await ipad.registerDocument({ sourcePath: "Fixtures/device-B.pdf", source: sourceB });
  await windows.maintainMainSnapshots(bookA);
  await ipad.maintainMainSnapshots(bookB);
  assert.deepEqual((await windows.observeKnownMainDevices()).map((row) => [row.deviceId, row.retirementCandidate]), [["ipad-B", false]]);
  now += 7 * 24 * 60 * 60 * 1000;
  const restarted = w.store("windows-A", true, options);
  assert.deepEqual((await restarted.observeKnownMainDevices()).map((row) => [row.deviceId, row.retirementCandidate]), [["ipad-B", true]]);
  await ipad.signalMainDeviceActivity();
  assert.equal((await restarted.observeMainDevice("ipad-B")).retirementCandidate, false,
    "opening a different PDF without editing renews the vault-wide presence record");
});

test("retirement proposal reads real device observations and exact ACKs without mutating annotation files", async () => {
  const w = world(); let now = 100;
  const options = { clock: () => now }, a = w.store("windows-A", true, options), b = w.store("ipad-B", true, options);
  const source = { sourceHash: hash("retirement evidence"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/retirement-evidence.pdf", source });
  await a.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 0)] });
  await a.materializeSnapshot(document);
  await b.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 1)] });
  await b.materializeSnapshot(document);
  await b.signalMainDeviceActivity();
  await a.observeMainDevice("ipad-B");
  const checkpoint = await a.createMainCheckpoint(document);
  await assert.rejects(a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId }),
    { code: "MAIN_RETIREMENT_PENDING" });
  now += 7 * 24 * 60 * 60 * 1000;
  await assert.rejects(a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId }),
    { code: "MAIN_RETIREMENT_PENDING" });
  await a.ackMainCheckpoint(document, checkpoint.snapshotId);
  const before = new Map([...w.files].filter(([path]) => path.startsWith(`${ROOT}/wal/`) || path.startsWith(`${ROOT}/main-snapshots/`)));
  const proposal = await a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId });
  assert.equal(proposal.deviceId, "ipad-B");
  assert.equal(proposal.checkpointId, checkpoint.snapshotId);
  assert.ok(proposal.throughSeq >= 1);
  const published = await a.publishMainRetirementProposal({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId });
  assert.match(published.id, /^sha256-v1:[a-f0-9]{64}$/);
  assert.equal((await a.publishMainRetirementProposal({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId })).id,
    published.id, "repeating a proposal must not create a second record");
  const reloaded = await w.store("fresh-C", true, options).readMainRetirementProposal(document, published.id);
  assert.deepEqual(reloaded.value, proposal);
  const restartedObserver = w.store("windows-A", true, options);
  assert.equal((await restartedObserver.revalidateMainRetirementProposal(document, published.id)).id, published.id);
  await assert.rejects(a.readMainRetirementProposal({ ...document, documentId: "different" }, published.id),
    { code: "MAIN_RETIREMENT_INVALID" });
  const savedProposal = w.files.get(published.path);
  w.files.set(published.path, "{corrupt");
  await assert.rejects(a.readMainRetirementProposal(document, published.id));
  const tampered = await seal({ ...published.value, throughSeq: published.value.throughSeq + 1 }, hash);
  w.files.set(published.path, JSON.stringify(tampered));
  await assert.rejects(a.readMainRetirementProposal(document, published.id));
  w.files.set(published.path, savedProposal);
  const ackPath = `${ROOT}/main-acks/${document.docKey}/${checkpoint.snapshotId.slice(10)}/windows-A.json`;
  const savedAck = w.files.get(ackPath);
  w.files.set(ackPath, "{incomplete");
  await assert.rejects(restartedObserver.revalidateMainRetirementProposal(document, published.id));
  w.files.set(ackPath, savedAck);
  assert.deepEqual(new Map([...w.files].filter(([path]) => path.startsWith(`${ROOT}/wal/`) || path.startsWith(`${ROOT}/main-snapshots/`))), before);
  const mac = w.store("mac-C", true, options);
  await mac.signalMainDeviceActivity();
  await assert.rejects(a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId }),
    { code: "MAIN_RETIREMENT_PENDING" }, "a newly observed third device must also confirm");
  await mac.ackMainCheckpoint(document, checkpoint.snapshotId);
  assert.equal((await a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId })).deviceId, "ipad-B");
  await assert.rejects(restartedObserver.revalidateMainRetirementProposal(document, published.id),
    { code: "MAIN_RETIREMENT_PENDING" }, "an old proposal cannot omit a newly observed device even after that device ACKs");
  const originalRead = w.adapter.read;
  let injected = false;
  w.adapter.read = async (path) => {
    const result = await originalRead(path);
    if (!injected && path.endsWith(`/windows-A.json`) && path.includes(`/main-acks/`)) {
      injected = true;
      await b.signalMainDeviceActivity();
    }
    return result;
  };
  await assert.rejects(a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId }),
    { code: "MAIN_RETIREMENT_PENDING" });
  w.adapter.read = originalRead;
  assert.equal(injected, true, "device activity must occur while ACK evidence is being checked");
});

test("retirement proposal rejects a device that returns during final ACK verification", async () => {
  const w = world(); let now = 100;
  const options = { clock: () => now }, a = w.store("windows-A", true, options), b = w.store("ipad-B", true, options);
  const source = { sourceHash: hash("retirement final ACK activity"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/retirement-final-ack.pdf", source });
  await b.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("old-B", 0)] });
  await b.materializeSnapshot(document);
  await b.signalMainDeviceActivity();
  await a.observeMainDevice("ipad-B");
  const checkpoint = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, checkpoint.snapshotId);
  now += 7 * 24 * 60 * 60 * 1000;
  const ackPath = `${ROOT}/main-acks/${document.docKey}/${checkpoint.snapshotId.slice(10)}/windows-A.json`;
  const originalRead = w.adapter.read;
  let reads = 0, injected = false;
  w.adapter.read = async (path) => {
    const result = await originalRead(path);
    if (path === ackPath && ++reads === 2) { injected = true; await b.signalMainDeviceActivity(); }
    return result;
  };
  try {
    await assert.rejects(a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId }),
      { code: "MAIN_RETIREMENT_PENDING" });
  } finally { w.adapter.read = originalRead; }
  assert.equal(injected, true);
});

test("retirement proposal rejects an ACK removed during evidence collection", async () => {
  const w = world(); let now = 100;
  const options = { clock: () => now }, a = w.store("windows-A", true, options), b = w.store("ipad-B", true, options);
  const source = { sourceHash: hash("retirement changing ack"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/retirement-changing-ack.pdf", source });
  await b.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("old-B", 0)] });
  await b.materializeSnapshot(document);
  await b.signalMainDeviceActivity();
  await a.observeMainDevice("ipad-B");
  const checkpoint = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, checkpoint.snapshotId);
  now += 7 * 24 * 60 * 60 * 1000;
  const ackPath = `${ROOT}/main-acks/${document.docKey}/${checkpoint.snapshotId.slice(10)}/windows-A.json`;
  const originalRead = w.adapter.read;
  let injected = false;
  w.adapter.read = async (path) => {
    const result = await originalRead(path);
    if (!injected && path === ackPath) { injected = true; w.files.delete(path); }
    return result;
  };
  try {
    await assert.rejects(a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId }),
      { code: "MAIN_RETIREMENT_PENDING" });
  } finally { w.adapter.read = originalRead; }
  assert.equal(injected, true);
});

test("retirement proposal cannot ignore an operation published while ACK evidence is read", async () => {
  const w = world(); let now = 100;
  const options = { clock: () => now }, a = w.store("windows-A", true, options), b = w.store("ipad-B", true, options);
  const source = { sourceHash: hash("retirement late save"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await a.registerDocument({ sourcePath: "Fixtures/retirement-late-save.pdf", source });
  await b.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("old-B", 0)] });
  await b.materializeSnapshot(document);
  await b.signalMainDeviceActivity();
  await a.observeMainDevice("ipad-B");
  const checkpoint = await a.createMainCheckpoint(document);
  await a.ackMainCheckpoint(document, checkpoint.snapshotId);
  now += 7 * 24 * 60 * 60 * 1000;
  const originalRead = w.adapter.read;
  let injected = false;
  w.adapter.read = async (path) => {
    const result = await originalRead(path);
    if (!injected && path.endsWith("/windows-A.json") && path.includes("/main-acks/")) {
      injected = true;
      await b.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("late-B", 1)] });
    }
    return result;
  };
  await assert.rejects(a.prepareMainRetirement({ document, deviceId: "ipad-B", snapshotId: checkpoint.snapshotId }),
    { code: "MAIN_RETIREMENT_PENDING" });
  w.adapter.read = originalRead;
  assert.equal(injected, true);
  const final = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.deepEqual(final.annotations.map((row) => row.uuid).sort(), ["late-B", "old-B"]);
});

test("retirement observation refuses a device that becomes active during observation publication", async () => {
  const w = world();
  let now = 100;
  const options = { clock: () => now };
  const observer = w.store("windows-A", true, options), target = w.store("ipad-B", true, options);
  await target.signalMainDeviceActivity();
  assert.equal((await observer.observeMainDevice("ipad-B")).retirementCandidate, false);
  now += 7 * 24 * 60 * 60 * 1000;
  const originalRename = w.adapter.rename;
  let injected = false;
  w.adapter.rename = async (from, to) => {
    const result = await originalRename(from, to);
    if (!injected && to === `${ROOT}/main-device-observations/windows-A.json`) {
      injected = true;
      await target.signalMainDeviceActivity();
    }
    return result;
  };
  const observed = await observer.observeMainDevice("ipad-B");
  w.adapter.rename = originalRename;
  assert.equal(injected, true);
  assert.equal(observed.retirementCandidate, false, "a newly active device cannot remain a retirement candidate");
  assert.equal((await observer.observeMainDevice("ipad-B")).retirementCandidate, false);
});

test("background route claims expose a durable rename under both paths without changing WAL data", async () => {
  const w = world();
  const source = { sourceHash: hash("route claims fixture"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const store = w.store("windows-A", true);
  const oldPath = "Fixtures/claims-old.pdf", newPath = "Fixtures/claims-new.pdf";
  const document = await store.registerDocument({ sourcePath: oldPath, source });
  await store.maintainMainSnapshots(document);
  assert.equal((await store.lookupMainRouteClaims(oldPath)).claims.length, 1);
  await store.renameDocument({ documentId: document.documentId, fromPath: oldPath, toPath: newPath });
  const old = await store.lookupMainRouteClaims(oldPath);
  const renamed = await store.lookupMainRouteClaims(newPath);
  assert.deepEqual(old.errors, []);
  assert.ok(old.claims.some((row) => row.route.payload.sourcePath === newPath), "old-path lookup must notice the route moved");
  assert.equal(renamed.claims.length, 1);
  assert.equal(renamed.claims[0].documentId, document.documentId);
  assert.equal(renamed.claims[0].route.payload.sourcePath, newPath);
});

test("repeated edits keep at most ten checkpoints while preserving every annotation", async () => {
  const w = world();
  const source = { sourceHash: hash("main retention cycles"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const store = w.store("windows-A", true);
  const document = await store.registerDocument({ sourcePath: "Fixtures/main-retention.pdf", source });
  let staleReceipt;
  for (let index = 0; index < 13; index++) {
    await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`mark-${index}`, index)] });
    await store.materializeSnapshot(document);
    const result = await store.maintainMainSnapshots(document);
    assert.notEqual(result.status, "deferred", `maintenance must continue at edit ${index}: ${result.reason}`);
    const checkpoints = [...w.files.keys()].filter((path) => path.startsWith(`${ROOT}/main-snapshots/${document.docKey}/`) && path.endsWith(".json"));
    assert.ok(checkpoints.length <= 10, "the verified checkpoint limit must hold");
    if (!staleReceipt) {
      const receiptPath = [...w.files.keys()].find((path) => path.startsWith(`${ROOT}/main-recovery/${document.docKey}/`) && path.endsWith(".json"));
      if (receiptPath) staleReceipt = { path: receiptPath, bytes: w.files.get(receiptPath) };
    }
  }
  assert.ok(staleReceipt, "a durable earlier receipt must exist for the stale-sync case");
  assert.equal(w.files.has(staleReceipt.path), false, "the old receipt must have been superseded and collected");
  w.files.set(staleReceipt.path, staleReceipt.bytes);
  const recovered = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(recovered.syncPending, undefined);
  assert.equal(recovered.annotations.length, 13);
});

test("checkpoint creation refuses to claim an arriving branch whose WAL has not arrived", async () => {
  const w = world();
  const sourcePath = "Fixtures/snapshot-before-wal.pdf";
  const source = { sourceHash: hash("snapshot before wal"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const first = w.store("windows-A", true);
  const document = await first.registerDocument({ sourcePath, source });
  await first.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("from-A", 1)] });
  await first.materializeSnapshot(document);
  const a = await first.createMainCheckpoint(document);
  const foreign = { type: "ANNOTATION_SET", uuid: "from-B", kind: "Highlight", pageIndex: 0,
    seq: 1, opId: "ipad-B:1", version: { rev: 1, deviceId: "ipad-B", seq: 1 }, payload: { text: "B" } };
  const b = await makeMainSnapshotCandidate({ document, operations: [...a.value.operations, foreign],
    parents: [a.snapshotId], segments: a.value.segments, hash });
  const publisher = createMainSnapshotStore({ adapter: w.adapter, root: ROOT, hash, token: () => "ipad-B" });
  await publisher.publish(document, b);
  const pending = await first.readDocument(document, { readOnly: true });
  assert.equal(pending.syncPending, true);
  assert.deepEqual(pending.annotations.map((row) => row.uuid), ["from-A"],
    "an arriving checkpoint without its WAL must not alter the displayed baseline");
  await assert.rejects(first.createMainCheckpoint(document), { code: "MAIN_SNAPSHOT_SYNC_PENDING" });
  assert.ok(w.files.has(publisher.pathFor(document, b.snapshotId)), "the foreign branch must remain available");
  const bridge = createObsidianStorageBridge({ adapter: w.adapter, root: ROOT, hash });
  await bridge.appendOperationBatch(document, "ipad-B", [foreign]);
  const converged = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(converged.syncPending, undefined);
  assert.deepEqual(converged.annotations.map((row) => row.uuid).sort(), ["from-A", "from-B"]);
});

test("explicit main checkpoint recovery reads its validated state without any WAL or archives", async () => {
  const w = world();
  const sourcePath = "Fixtures/standalone-main.pdf";
  const source = { sourceHash: hash("standalone main"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const first = w.store("windows-A", true);
  const document = await first.registerDocument({ sourcePath, source });
  await first.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("kept", 1), annotation("deleted", 2, { deleted: true })] });
  await first.materializeSnapshot(document);
  const checkpoint = await first.createMainCheckpoint(document);
  for (const path of [...w.files.keys()]) {
    if (!path.startsWith(`${ROOT}/main-snapshots/`)) w.files.delete(path);
  }
  const fresh = w.store("fresh-C", true);
  const recovered = await fresh.readMainCheckpoint(document, checkpoint.snapshotId);
  assert.deepEqual(Object.keys(recovered.state.annotations), ["kept"]);
  assert.deepEqual(Object.keys(recovered.state.tombstones), ["deleted"]);
  assert.equal(recovered.state.annotations.kept.payload.editor.rect[2], 100);
  const route = await fresh.documentForPath(sourcePath);
  assert.equal(route?.documentId, document.documentId, "cold discovery must find the independently verifiable checkpoint");
  const normal = await fresh.readDocument(route, { readOnly: true });
  assert.deepEqual(normal.annotations.map((row) => row.uuid), ["kept"]);
  assert.deepEqual(normal.tombstones.map((row) => row.uuid), ["deleted"]);
  await assert.rejects(fresh.readMainCheckpoint({ ...document, sourceMismatch: true }, checkpoint.snapshotId),
    { code: "SOURCE_MISMATCH" });
  const restarted = w.store("windows-A", true);
  const reopened = await restarted.registerDocument({ sourcePath, source });
  const floor = Math.max(...checkpoint.value.segments.filter((row) => row.deviceId === "windows-A").map((row) => row.lastSeq),
    ...checkpoint.value.operations.filter((row) => row.version.deviceId === "windows-A").map((row) => row.seq));
  const seededAnchor = JSON.parse(w.files.get(`${ROOT}/wal/windows-A/${document.docKey}.jsonl.anchor.json`));
  assert.ok(seededAnchor.operations.every((row) => row.seq > floor), "recovery baseline must not reuse old operation identities");
  const retried = await restarted.appendOperations({ document: reopened, sourceHash: source.sourceHash, operations: [annotation("kept", 1)] });
  assert.equal(retried.operationCount, 0, "a save already acknowledged before snapshot-only recovery stays idempotent");
  await restarted.appendOperations({ document: reopened, sourceHash: source.sourceHash, operations: [annotation("new", 3)] });
  const rows = w.files.get(`${ROOT}/wal/windows-A/${document.docKey}.jsonl`).trim().split("\n").map(JSON.parse);
  assert.ok(rows.every((row) => row.lsn > floor), "new writes must not reuse checkpointed sequence numbers");
  const final = await w.store("fresh-D", true).readDocument(reopened, { readOnly: true });
  assert.deepEqual(final.annotations.map((row) => row.uuid).sort(), ["kept", "new"]);
  assert.deepEqual(final.tombstones.map((row) => row.uuid), ["deleted"]);
  assert.equal(final.syncPending, undefined);
  await restarted.materializeSnapshot(reopened);
  const next = await restarted.createMainCheckpoint(reopened);
  for (const receipt of checkpoint.value.receipts) {
    assert.ok(next.value.receipts.some((row) => JSON.stringify(row) === JSON.stringify(receipt)),
      "subsequent checkpoints must preserve original acknowledged request identities");
  }
  await restarted.ackMainCheckpoint(reopened, next.snapshotId);
});

test("a damaged legacy sidecar keeps checkpoint recovery read-only and preserves its bytes", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("damaged sidecar checkpoint"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/damaged-sidecar-main.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("survives", 0)] });
  await writer.materializeSnapshot(document);
  await writer.createMainCheckpoint(document);
  for (const path of [...w.files.keys()]) if (!path.startsWith(`${ROOT}/main-snapshots/`)) w.files.delete(path);
  const badPath = `${ROOT}/sidecars/${document.docKey}.annot.json`;
  await w.adapter.mkdir(`${ROOT}/sidecars`);
  w.files.set(badPath, "{broken legacy sidecar");
  const reader = w.store("fresh-C", true);
  const recovered = await reader.readDocument(document, { readOnly: true });
  assert.deepEqual(recovered.annotations.map((row) => row.uuid), ["survives"]);
  assert.equal(recovered.syncPending, true, "unverified legacy data cannot be silently ignored");
  assert.equal(w.files.get(badPath), "{broken legacy sidecar");
  const before = new Map(w.files);
  assert.equal((await reader.materializeSnapshot(document)).syncPending, true);
  assert.deepEqual(w.files, before, "maintenance must not rewrite data while legacy state is unverified");
  await assert.rejects(reader.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("new", 1)] }),
    { code: "WAL_SYNC_PENDING" });
});

test("independent devices can resume from one standalone checkpoint without losing state", async () => {
  const w = world();
  const sourcePath = "Fixtures/standalone-multidevice.pdf";
  const source = { sourceHash: hash("standalone multidevice"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const original = w.store("windows-A", true);
  const document = await original.registerDocument({ sourcePath, source });
  await original.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("old", 0), annotation("deleted", 1, { deleted: true })] });
  await original.materializeSnapshot(document);
  await original.createMainCheckpoint(document);
  for (const path of [...w.files.keys()]) if (!path.startsWith(`${ROOT}/main-snapshots/`)) w.files.delete(path);
  const a = w.store("windows-A", true), b = w.store("ipad-B", true);
  const [docA, docB] = await Promise.all([a.registerDocument({ sourcePath, source }), b.registerDocument({ sourcePath, source })]);
  await Promise.all([
    a.appendOperations({ document: docA, sourceHash: source.sourceHash, operations: [annotation("new-A", 2)] }),
    b.appendOperations({ document: docB, sourceHash: source.sourceHash, operations: [annotation("new-B", 3)] }),
  ]);
  await Promise.all([a.materializeSnapshot(docA), b.materializeSnapshot(docB)]);
  const result = await w.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(result.syncPending, undefined);
  assert.deepEqual(result.annotations.map((row) => row.uuid).sort(), ["new-A", "new-B", "old"]);
  assert.deepEqual(result.tombstones.map((row) => row.uuid), ["deleted"]);
});

test("separate offline stores resume from one checkpoint and merge late device logs", async () => {
  const aWorld = world(), bWorld = world();
  const sourcePath = "Fixtures/standalone-separate-devices.pdf";
  const source = { sourceHash: hash("standalone separate devices"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const original = aWorld.store("windows-A", true);
  const document = await original.registerDocument({ sourcePath, source });
  await original.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("old", 0), annotation("deleted", 1, { deleted: true })] });
  await original.materializeSnapshot(document);
  await original.createMainCheckpoint(document);
  for (const path of [...aWorld.files.keys()]) if (!path.startsWith(`${ROOT}/main-snapshots/`)) aWorld.files.delete(path);
  for (const [path, value] of aWorld.files) bWorld.files.set(path, value);
  for (const folder of aWorld.folders) bWorld.folders.add(folder);
  const a = aWorld.store("windows-A", true), b = bWorld.store("ipad-B", true);
  const docA = await a.registerDocument({ sourcePath, source });
  const docB = await b.registerDocument({ sourcePath, source });
  const ipadBaseline = await b.readEffective(docB, { readOnly: true });
  assert.deepEqual(ipadBaseline.errors, [], JSON.stringify(ipadBaseline.errors));
  const separateRequest = await b.appendOperations({ document: docB, sourceHash: source.sourceHash, operations: [annotation("old", 0)] });
  assert.equal(separateRequest.operationCount, 1, "an equal input on a different device is not automatically the same request");
  await a.appendOperations({ document: docA, sourceHash: source.sourceHash, operations: [annotation("new-A", 2)] })
    .catch((error) => { error.message = `windows: ${error.message}`; throw error; });
  await b.appendOperations({ document: docB, sourceHash: source.sourceHash, operations: [annotation("new-B", 3)] })
    .catch((error) => { error.message = `ipad: ${error.message}`; throw error; });
  await a.materializeSnapshot(docA);
  await b.materializeSnapshot(docB);
  const restartedB = bWorld.store("ipad-B", true);
  const retry = await restartedB.appendOperations({ document: docB, sourceHash: source.sourceHash, operations: [annotation("new-B", 3)] });
  assert.equal(retry.operationCount, 0, "a device's saved request must stay idempotent after reopening");
  // Transfer only the independent iPad-owned WAL files; do not copy its
  // mutable derived sidecar, registry, or in-memory synchronization state.
  for (const [path, value] of bWorld.files) if (path.startsWith(`${ROOT}/wal/ipad-B/`)) aWorld.files.set(path, value);
  for (const folder of bWorld.folders) aWorld.folders.add(folder);
  const result = await aWorld.store("fresh-C", true).readDocument(document, { readOnly: true });
  assert.equal(result.syncPending, undefined);
  assert.deepEqual(result.annotations.map((row) => row.uuid).sort(), ["new-A", "new-B", "old"]);
  assert.deepEqual(result.tombstones.map((row) => row.uuid), ["deleted"]);
});

test("standalone checkpoints with different source hashes fail closed", async () => {
  const w = world();
  const sourcePath = "Fixtures/source-conflict-main.pdf";
  const source = { sourceHash: hash("source A"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const writer = w.store("windows-A", true);
  const document = await writer.registerDocument({ sourcePath, source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("only-A", 1)] });
  await writer.materializeSnapshot(document);
  const a = await writer.createMainCheckpoint(document);
  const other = { ...document, source: { ...source, sourceHash: hash("source B") } };
  const otherOperations = a.value.operations.map((operation) => operation.type === "ROUTE_SET"
    ? { ...operation, opId: "ipad-B:route:1", version: { rev: operation.version.rev + 1, deviceId: "ipad-B", seq: 1 },
      seq: 1, payload: { ...operation.payload, source: other.source } } : operation);
  const b = await makeMainSnapshotCandidate({ document: other, operations: otherOperations, hash });
  const publisher = createMainSnapshotStore({ adapter: w.adapter, root: ROOT, hash, token: () => "other-source" });
  await publisher.publish(other, b);
  for (const path of [...w.files.keys()]) if (!path.startsWith(`${ROOT}/main-snapshots/`)) w.files.delete(path);
  const fresh = w.store("fresh-C", true);
  await assert.rejects(fresh.readEffective({ docKey: document.docKey, documentId: document.documentId }, { readOnly: true }),
    { code: "SOURCE_MISMATCH" });
  assert.ok(w.files.has(publisher.pathFor(document, a.snapshotId)));
  assert.ok(w.files.has(publisher.pathFor(other, b.snapshotId)));
});

test("a corrupt standalone main checkpoint cannot create a blank replacement document", async () => {
  const w = world();
  const sourcePath = "Fixtures/corrupt-standalone-main.pdf";
  const source = { sourceHash: hash("corrupt standalone main"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const writer = w.store("windows-A", true);
  const document = await writer.registerDocument({ sourcePath, source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("must-survive", 1)] });
  await writer.materializeSnapshot(document);
  const snapshot = await writer.createMainCheckpoint(document);
  const path = `${ROOT}/main-snapshots/${document.docKey}/${snapshot.snapshotId.slice(10)}.json`;
  for (const key of [...w.files.keys()]) if (key !== path) w.files.delete(key);
  w.files.set(path, "{incomplete");
  await assert.rejects(w.store("windows-A", true).registerDocument({ sourcePath, source }), { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(path), "{incomplete", "the corrupt source must remain untouched for recovery");
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
  const archive = [...w.files.keys()].find((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
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

test("cold route discovery never repairs a torn WAL before the selected document is read", async () => {
  const w = world();
  const sourcePath = "Fixtures/read-only-discovery.pdf";
  const source = { sourceHash: hash("read only discovery"), size: 1024, pageCount: 1,
    orderedPageIdentities: ["page-0"] };
  const writer = w.store("windows-A", true);
  const document = await writer.registerDocument({ sourcePath, source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("durable", 1)] });
  const path = `${ROOT}/wal/windows-A/${document.docKey}.jsonl`;
  const complete = w.files.get(path);
  w.files.set(path, `${complete}{"incomplete":`);
  const reopened = w.store("windows-A", true);
  const resolved = await reopened.documentForPath(sourcePath);
  assert.equal(resolved.documentId, document.documentId);
  assert.equal(w.files.get(path), `${complete}{"incomplete":`, "route discovery must not alter the WAL");
  const loaded = await reopened.readDocument(resolved);
  assert.equal(w.files.get(path), complete, "the selected document can safely repair its own torn tail");
  assert.ok(loaded.annotations.some((row) => row.uuid === "durable"));
});

test("a registry route with missing backing state is not replaced with a new identity", async () => {
  const w = world(), store = w.store("windows-A", true);
  const sourcePath = "Fixtures/missing-backing.pdf";
  const registry = `${ROOT}/_registry.json`;
  const prior = JSON.stringify({ schemaVersion: 1, kind: "pdf-reader-registry-cache", entries: {
    [sourcePath]: { docKey: "123456789abc", documentId: "waiting-for-sync" },
  } });
  w.files.set(registry, prior);
  const source = { sourceHash: hash("missing backing"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  await assert.rejects(store.registerDocument({ sourcePath, source }), { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(registry), prior);
  assert.equal([...w.files.keys()].some((path) => path.startsWith(`${ROOT}/wal/windows-A/`)), false);
});

test("a nonempty pending JSONL blocks edits without treating an empty remnant as data", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("pending WAL"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/pending-wal.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("existing", 0)] });
  const pending = `${ROOT}/wal/windows-A/${document.docKey}.jsonl.pending`;
  w.files.set(pending, "{unfinished WAL replacement");
  const reader = w.store("fresh-C", true);
  assert.equal((await reader.readDocument(document, { readOnly: true })).syncPending, true);
  await assert.rejects(reader.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("new", 1)] }),
    { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(pending), "{unfinished WAL replacement");
  w.files.set(pending, "");
  assert.equal((await w.store("fresh-D", true).readDocument(document, { readOnly: true })).syncPending, undefined);
  w.files.set(pending, "{unfinished WAL replacement");
  for (const path of [...w.files.keys()]) if (path !== pending) w.files.delete(path);
  await assert.rejects(w.store("fresh-E", true).documentForPath(document.sourcePath), { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(pending), "{unfinished WAL replacement");
});

test("a pending anchor alongside a primary blocks edits and retains both files", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("pending anchor alongside primary"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/pending-anchor-conflict.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("existing", 0)] });
  await writer.materializeSnapshot(document);
  const anchor = `${ROOT}/wal/windows-A/${document.docKey}.jsonl.anchor.json`;
  const primary = w.files.get(anchor);
  assert.ok(primary);
  w.files.set(`${anchor}.pending`, "{new anchor still synchronizing");
  const reader = w.store("fresh-C", true);
  const snapshot = await reader.readDocument(document, { readOnly: true });
  assert.equal(snapshot.syncPending, true);
  assert.deepEqual(snapshot.annotations.map((row) => row.uuid), ["existing"]);
  await assert.rejects(reader.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("new", 1)] }),
    { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(anchor), primary);
  assert.equal(w.files.get(`${anchor}.pending`), "{new anchor still synchronizing");
});

test("an unpublished archive blocks edits and is preserved for recovery", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("unpublished archive"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/unpublished-archive.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("existing", 0)] });
  await writer.materializeSnapshot(document);
  const archive = [...w.files.keys()].find((path) => path.includes(`${document.docKey}.jsonl.archive.`) && path.endsWith(".json"));
  assert.ok(archive);
  const pending = `${archive}.pending`;
  w.files.set(pending, "{archive still being synchronized");
  const reader = w.store("fresh-C", true);
  const snapshot = await reader.readDocument(document, { readOnly: true });
  assert.equal(snapshot.syncPending, true);
  assert.deepEqual(snapshot.annotations.map((row) => row.uuid), ["existing"]);
  await assert.rejects(reader.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("new", 1)] }),
    { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(pending), "{archive still being synchronized");
  w.files.delete(pending);
  const uniquePending = `${archive}.pending-unique-token`;
  w.files.set(uniquePending, "{unique staging still synchronizing");
  assert.equal((await w.store("fresh-unique", true).readDocument(document, { readOnly: true })).syncPending, true);
  assert.equal(w.files.get(uniquePending), "{unique staging still synchronizing");
  w.files.delete(uniquePending);
  w.files.set(pending, "{archive still being synchronized");
  for (const path of [...w.files.keys()]) if (path !== pending) w.files.delete(path);
  await assert.rejects(w.store("fresh-D", true).documentForPath(document.sourcePath), { code: "WAL_SYNC_PENDING" },
    "a lone unpublished archive cannot be interpreted as a new document");
  assert.equal(w.files.get(pending), "{archive still being synchronized");
});

test("a pending JSONL anchor and its referenced archives can recover the document", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("pending anchor only"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const sourcePath = "Fixtures/pending-anchor-only.pdf";
  const document = await writer.registerDocument({ sourcePath, source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("pending-mark", 0)] });
  await writer.materializeSnapshot(document);
  const path = `${ROOT}/wal/windows-A/${document.docKey}.jsonl.anchor.json`;
  const anchor = w.files.get(path);
  assert.ok(anchor);
  const archives = JSON.parse(anchor).archives.map((entry) => [entry.path, w.files.get(entry.path)]);
  assert.ok(archives.length && archives.every(([, bytes]) => typeof bytes === "string"));
  for (const key of [...w.files.keys()]) w.files.delete(key);
  w.files.set(`${path}.pending`, anchor);
  for (const [archivePath, bytes] of archives) w.files.set(archivePath, bytes);
  const reader = w.store("fresh-C", true);
  const resolved = await reader.documentForPath(sourcePath);
  assert.equal(resolved.documentId, document.documentId);
  assert.deepEqual((await reader.readDocument(resolved, { readOnly: true })).annotations.map((row) => row.uuid), ["pending-mark"]);
  assert.equal(w.files.get(`${path}.pending`), anchor, "read-only discovery must preserve the pending file");
  for (const [archivePath] of archives) w.files.delete(archivePath);
  await assert.rejects(w.store("fresh-D", true).registerDocument({ sourcePath, source }), { code: "WAL_SYNC_PENDING" },
    "missing referenced archives must not be replaced by a new identity");
  assert.equal(w.files.get(`${path}.pending`), anchor);
});

test("a partially synchronized JSONL header does not disappear from rebuilt registry", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("unknown partial WAL"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/known-wal.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("known", 0)] });
  await writer.materializeSnapshot(document);
  const registry = `${ROOT}/_registry.json`;
  const value = JSON.parse(w.files.get(registry));
  value.entries["Fixtures/awaiting.pdf"] = { docKey: "123456789abc", documentId: "awaiting-sync" };
  const before = JSON.stringify(value);
  w.files.set(registry, before);
  await w.adapter.mkdir(`${ROOT}/wal/ipad-B`);
  const path = `${ROOT}/wal/ipad-B/123456789abc.jsonl`;
  w.files.set(path, "{partial first record");
  await w.store("fresh-C", true).documentForPath(document.sourcePath);
  assert.equal(w.files.get(registry), before);
  w.files.set(path, "");
  await w.store("fresh-D", true).documentForPath(document.sourcePath);
  assert.notEqual(w.files.get(registry), before, "a legitimate empty WAL has no incomplete header");
});

test("unreadable checkpoint or recovery header cannot disappear from a rebuilt registry", async () => {
  for (const [folder, suffix] of [["main-snapshots", ""], ["main-recovery", ""],
    ["main-snapshots", ".gc-other"], ["main-recovery", ".gc-other"],
    ["main-snapshots", ".pending-other"], ["main-recovery", ".pending"]]) {
    const w = world(), writer = w.store("windows-A", true);
    const source = { sourceHash: hash(`unknown ${folder}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const document = await writer.registerDocument({ sourcePath: `Fixtures/known-${folder}.pdf`, source });
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("known", 0)] });
    await writer.materializeSnapshot(document);
    const registry = `${ROOT}/_registry.json`;
    const value = JSON.parse(w.files.get(registry));
    value.entries["Fixtures/awaiting.pdf"] = { docKey: "123456789abc", documentId: "awaiting-sync" };
    const before = JSON.stringify(value);
    w.files.set(registry, before);
    await w.adapter.mkdir(`${ROOT}/${folder}`);
    await w.adapter.mkdir(`${ROOT}/${folder}/123456789abc`);
    w.files.set(`${ROOT}/${folder}/123456789abc/${"a".repeat(64)}.json${suffix}`, "{incomplete");
    await w.store("fresh-C", true).documentForPath(document.sourcePath);
    assert.equal(w.files.get(registry), before, `an unreadable ${folder} file must prevent replacing the registry`);
  }
});

test("unreadable sidecar cannot disappear from a rebuilt registry", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("unknown corrupt sidecar"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/known.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("known", 0)] });
  await writer.materializeSnapshot(document);
  const registry = `${ROOT}/_registry.json`;
  const value = JSON.parse(w.files.get(registry));
  value.entries["Fixtures/awaiting.pdf"] = { docKey: "123456789abc", documentId: "awaiting-sync" };
  const before = JSON.stringify(value);
  w.files.set(registry, before);
  w.files.set(`${ROOT}/sidecars/123456789abc.annot.json`, "{incomplete");
  await w.store("fresh-C", true).documentForPath(document.sourcePath);
  assert.equal(w.files.get(registry), before, "an unknown broken file must prevent replacing the registry");
});

test("discovery never replaces registry while another document has incomplete sync data", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const docs = [];
  for (const name of ["good", "pending"]) {
    const source = { sourceHash: hash(`partial registry ${name}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const document = await writer.registerDocument({ sourcePath: `Fixtures/partial-${name}.pdf`, source });
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(name, 0)] });
    await writer.materializeSnapshot(document);
    docs.push(document);
  }
  const registry = `${ROOT}/_registry.json`;
  const original = JSON.parse(w.files.get(registry));
  original.entries["Fixtures/unresolved.pdf"] = { docKey: "000000000001", documentId: "awaiting-sync" };
  const before = JSON.stringify(original);
  w.files.set(registry, before);
  const archive = [...w.files.keys()].find((path) => path.includes(`${docs[1].docKey}.jsonl.archive.`));
  assert.ok(archive);
  w.files.set(archive, "{partial");
  const reader = w.store("fresh-C", true);
  try { await reader.documentForPath(docs[0].sourcePath); } catch { /* A conservative pending result is allowed. */ }
  assert.equal(w.files.get(registry), before, "an incomplete scan must not discard unresolved registry routes");
  await assert.rejects(reader.registerDocument({ sourcePath: "Fixtures/unresolved.pdf", source: {
    sourceHash: hash("unresolved source"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"],
  } }), { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(registry), before, "an incomplete scan must not mint a replacement identity");
});

test("cold lookup repairs damaged or misleading registry entries without losing annotations", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const docs = [];
  for (const name of ["first", "second"]) {
    const source = { sourceHash: hash(`registry repair ${name}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const document = await writer.registerDocument({ sourcePath: `Fixtures/registry-${name}.pdf`, source });
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`mark-${name}`, 0)] });
    await writer.materializeSnapshot(document);
    docs.push(document);
  }
  const registry = `${ROOT}/_registry.json`;
  const candidates = [
    "{broken json",
    JSON.stringify({ schemaVersion: 1, kind: "pdf-reader-registry-cache", entries: {
      [docs[0].sourcePath]: { docKey: docs[1].docKey, documentId: docs[1].documentId },
    } }),
    JSON.stringify({ schemaVersion: 1, kind: "pdf-reader-registry-cache", entries: {
      [docs[0].sourcePath]: { docKey: "000000000000", documentId: "missing" },
    } }),
  ];
  for (const [index, value] of candidates.entries()) {
    w.files.set(registry, value);
    const reader = w.store(`reader-${index}`, true);
    const resolved = await reader.documentForPath(docs[0].sourcePath);
    assert.equal(resolved.documentId, docs[0].documentId);
    assert.deepEqual((await reader.readDocument(resolved, { readOnly: true })).annotations.map((row) => row.uuid), ["mark-first"]);
    const repaired = JSON.parse(w.files.get(registry));
    assert.equal(repaired.entries[docs[0].sourcePath].documentId, docs[0].documentId);
    assert.equal(repaired.entries[docs[1].sourcePath].documentId, docs[1].documentId);
  }
});

test("retained archive stage requires exact verified recovery coverage after its published archive disappears", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("covered archive stage"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/covered-stage.pdf", source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("A", 1)] });
  await writer.materializeSnapshot(document);
  const previous = await writer.createMainCheckpoint(document);
  const archive = [...w.files.keys()].find((item) => item.includes(`${document.docKey}.jsonl.archive.`) && item.endsWith(".json") && item.endsWith(".json"));
  const stage = [...w.files.keys()].find((item) => item.startsWith(`${archive}.pending-`));
  assert.ok(archive && stage);
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("B", 2)] });
  await writer.materializeSnapshot(document);
  const current = await writer.createMainCheckpoint(document);
  await writer.ackMainCheckpoint(document, current.snapshotId);
  await writer.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths: [archive] });
  assert.equal(w.files.has(archive), false);
  assert.equal(w.files.has(stage), true);
  const fresh = w.store("fresh-C", true);
  assert.deepEqual((await fresh.readDocument(document, { readOnly: true })).annotations.map((row) => row.uuid).sort(), ["A", "B"]);
  w.files.set(stage, "different late data");
  const delayed = w.store("fresh-D", true);
  const blocked = await delayed.readDocument(document, { readOnly: true });
  assert.equal(blocked.syncPending, true);
  await assert.rejects(delayed.appendOperations({ document, sourceHash: source.sourceHash,
    operations: [annotation("C", 3)] }), { code: "WAL_SYNC_PENDING" });
  const registryPath = `${ROOT}/_registry.json`, originalRegistry = w.files.get(registryPath);
  await assert.rejects(w.store("fresh-E", true).registerDocument({ sourcePath: "Fixtures/unrelated-new.pdf",
    source: { ...source, sourceHash: hash("new unrelated source") } }), { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(registryPath), originalRegistry, "incomplete discovery must not replace the registry");
  assert.equal(w.files.get(stage), "different late data");
});

test("cold discovery overlaps independent recovery certificate reads with bounded concurrency", async () => {
  const w = world(), writer = w.store("windows-A", true);
  let firstDocument;
  for (const name of ["first", "second"]) {
    const source = { sourceHash: hash(`recovery discovery ${name}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const document = await writer.registerDocument({ sourcePath: `Fixtures/recovery-${name}.pdf`, source });
    firstDocument ||= document;
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`${name}-A`, 1)] });
    await writer.materializeSnapshot(document);
    const previous = await writer.createMainCheckpoint(document);
    const path = [...w.files.keys()].find((item) => item.includes(`${document.docKey}.jsonl.archive.`) && item.endsWith(".json") && item.endsWith(".json"));
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`${name}-B`, 2)] });
    await writer.materializeSnapshot(document);
    const current = await writer.createMainCheckpoint(document);
    await writer.ackMainCheckpoint(document, current.snapshotId);
    await writer.pruneCoveredArchives({ document, current: current.snapshotId, previous: previous.snapshotId, paths: [path] });
  }
  let active = 0, peak = 0;
  const originalRead = w.adapter.read;
  w.adapter.read = async (path) => {
    if (!path.startsWith(`${ROOT}/main-recovery/`) || !path.endsWith(".json")) return originalRead(path);
    active++; peak = Math.max(peak, active);
    try { await new Promise((resolve) => setImmediate(resolve)); return await originalRead(path); }
    finally { active--; }
  };
  const resolved = await w.store("fresh-C", true).documentForPath(firstDocument.sourcePath);
  assert.equal(resolved.documentId, firstDocument.documentId);
  assert.ok(peak > 1 && peak <= 4, `recovery read concurrency ${peak} must be bounded and overlap`);
});

test("cold discovery overlaps independent snapshot header reads with bounded concurrency", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const source = { sourceHash: hash("parallel snapshot discovery"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await writer.registerDocument({ sourcePath: "Fixtures/parallel-snapshots.pdf", source });
  for (let index = 0; index < 4; index++) {
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(`snapshot-${index}`, index)] });
    await writer.materializeSnapshot(document);
    await writer.createMainCheckpoint(document);
  }
  let active = 0, peak = 0;
  const originalRead = w.adapter.read;
  w.adapter.read = async (path) => {
    if (!path.startsWith(`${ROOT}/main-snapshots/`) || !path.endsWith(".json")) return originalRead(path);
    active++; peak = Math.max(peak, active);
    try { await new Promise((resolve) => setImmediate(resolve)); return await originalRead(path); }
    finally { active--; }
  };
  const resolved = await w.store("fresh-C", true).documentForPath(document.sourcePath);
  assert.equal(resolved.documentId, document.documentId);
  assert.ok(peak > 1 && peak <= 4, `snapshot read concurrency ${peak} must be bounded and overlap`);
});

test("cold discovery reads each WAL file once per scan and never reuses it across scans", async () => {
  const w = world();
  const writer = w.store("windows-A", true);
  for (const name of ["first", "second"]) {
    const source = { sourceHash: hash(`discovery cache ${name}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const document = await writer.registerDocument({ sourcePath: `Fixtures/${name}.pdf`, source });
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(name, 0)] });
    await writer.materializeSnapshot(document);
  }
  const anchorPath = [...w.files.keys()].find((path) => path.endsWith(".jsonl.anchor.json"));
  const retentionPath = anchorPath.replace(/\.anchor\.json$/, ".retention.json");
  w.files.set(retentionPath, "{this is not a legacy device WAL}");
  const reads = new Map();
  const originalRead = w.adapter.read;
  const checked = [];
  const originalExists = w.adapter.exists;
  w.adapter.exists = async (path) => { checked.push(path); return originalExists(path); };
  w.adapter.read = async (path) => { reads.set(path, (reads.get(path) || 0) + 1); return originalRead(path); };
  const reopened = w.store("fresh-C", true);
  assert.ok(await reopened.documentForPath("Fixtures/first.pdf"));
  assert.equal(reads.has(retentionPath), false, "unrelated retention metadata must not be parsed as legacy WAL");
  assert.equal(checked.includes(anchorPath), false, "a listed archive directory supplies anchor presence without an extra stat");
  const walReads = [...reads].filter(([path]) => path.includes("/wal/") && (path.includes(".archive.") || path.endsWith(".anchor.json")));
  assert.ok(walReads.length >= 4, "the scan must exercise real anchors and archives");
  assert.ok(walReads.every(([, count]) => count === 1), JSON.stringify(walReads));
  reads.clear();
  const next = w.store("fresh-D", true);
  assert.ok(await next.documentForPath("Fixtures/first.pdf"));
  assert.ok([...reads.keys()].some((path) => path.includes("/wal/") && path.endsWith(".anchor.json")),
    "a new discovery must re-read durable files");
});

test("a cached route with a damaged document shard falls back to full discovery", async () => {
  const w = world(), writer = w.store("windows-A", true);
  const documents = [];
  for (const name of ["first", "second"]) {
    const source = { sourceHash: hash(`corrupt route ${name}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const document = await writer.registerDocument({ sourcePath: `Fixtures/corrupt-${name}.pdf`, source });
    await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation(name, 0)] });
    await writer.materializeSnapshot(document);
    documents.push(document);
  }
  await writer.maintainMainSnapshots(documents[0]);
  const reader = w.store("fresh-C", true);
  await reader.documentForPath("Fixtures/corrupt-first.pdf");
  const reads = [], originalRead = w.adapter.read;
  w.adapter.read = async (path) => { reads.push(path); return originalRead(path); };
  await reader.documentForPath("Fixtures/corrupt-first.pdf");
  assert.equal(reads.includes(`${ROOT}/wal/windows-A/${documents[1].docKey}.jsonl.anchor.json`), false,
    "the healthy warmed route must avoid a full discovery");
  reads.length = 0;
  const claim = [...w.files.keys()].find((path) => path.startsWith(`${ROOT}/main-routes/`) && path.endsWith(".json"));
  assert.ok(claim);
  w.files.set(`${claim}.pending`, "{partial");
  await assert.rejects(reader.documentForPath("Fixtures/corrupt-first.pdf"), { code: "WAL_SYNC_PENDING" });
  assert.ok(reads.includes(`${ROOT}/wal/windows-A/${documents[1].docKey}.jsonl.anchor.json`),
    "an incomplete route claim must prevent a direct cached return");
  w.files.delete(`${claim}.pending`);
  reads.length = 0;
  const reporter = createMainRouteClaimStore({ adapter: w.adapter, root: ROOT, hash, token: () => "other-route", deviceId: "ipad-B" });
  const otherRoute = (await writer.readEffective(documents[1], { readOnly: true })).state.routing;
  const competing = { ...otherRoute, seq: 11, opId: "ipad-B-route-11", version: { rev: 11, seq: 11, deviceId: "ipad-B" },
    payload: { ...otherRoute.payload, sourcePath: "Fixtures/corrupt-first.pdf" } };
  await reporter.publish({ indexedPath: "Fixtures/corrupt-first.pdf", document: documents[1], route: competing });
  await assert.rejects(reader.documentForPath("Fixtures/corrupt-first.pdf"), { code: "WAL_SYNC_PENDING" },
    "an unverified conflicting path claim must not be ignored");
  const moved = { ...competing, seq: 12, opId: "ipad-B-route-12", version: { rev: 12, seq: 12, deviceId: "ipad-B" },
    payload: { ...competing.payload, sourcePath: "Fixtures/corrupt-second.pdf" } };
  await reporter.publish({ indexedPath: "Fixtures/corrupt-first.pdf", document: documents[1], route: moved });
  assert.equal((await reader.documentForPath("Fixtures/corrupt-first.pdf")).documentId, documents[0].documentId,
    "a newer verified claim moving the competitor away clears that path conflict");
  reads.length = 0;
  w.files.set(`${ROOT}/wal/windows-A/${documents[0].docKey}.jsonl.anchor.json`, "{corrupt");
  await assert.rejects(reader.documentForPath("Fixtures/corrupt-first.pdf"), { code: "WAL_SYNC_PENDING" });
  assert.ok(reads.includes(`${ROOT}/wal/windows-A/${documents[1].docKey}.jsonl.anchor.json`),
    "a corrupt cached route must trigger a new discovery instead of returning directly");
});

test("a sync event during a warmed registry lookup prevents the stale fast return", async () => {
  const w = world(), writer = w.store("windows-A", true), documents = [];
  for (const name of ["first", "second"]) {
    const source = { sourceHash: hash(`warm-event-${name}`), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
    const doc = await writer.registerDocument({ sourcePath: `Fixtures/warm-event-${name}.pdf`, source });
    await writer.appendOperations({ document: doc, sourceHash: source.sourceHash, operations: [annotation(name, 0)] });
    await writer.materializeSnapshot(doc);
    documents.push(doc);
  }
  const reader = w.store("fresh-C", true), sourcePath = "Fixtures/warm-event-first.pdf";
  await reader.documentForPath(sourcePath);
  const originalRead = w.adapter.read, reads = [];
  let release, signal, held = false;
  const started = new Promise((resolve) => { signal = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  w.adapter.read = async (path) => {
    reads.push(path);
    const result = await originalRead(path);
    if (!held && path.endsWith(`${documents[0].docKey}.jsonl.anchor.json`)) {
      held = true; signal(); await resume;
    }
    return result;
  };
  const pending = reader.documentForPath(sourcePath);
  await started;
  reader.invalidateRegistry();
  release();
  await assert.rejects(pending, { code: "WAL_SYNC_PENDING" });
  assert.ok(reads.includes(`${ROOT}/wal/windows-A/${documents[1].docKey}.jsonl.anchor.json`),
    "a route invalidated mid-read must be rediscovered instead of returning the stale cached result");
});

test("a sync event during discovery rejects the stale scan and preserves the registry", async () => {
  const w = world();
  const sourcePath = "Fixtures/routing-invalidation.pdf";
  const source = { sourceHash: hash("routing invalidation"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const writer = w.store("windows-A", true);
  const document = await writer.registerDocument({ sourcePath, source });
  await writer.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("saved", 1)] });
  await writer.materializeSnapshot(document);
  const registry = `${ROOT}/_registry.json`;
  const before = w.files.get(registry);
  const originalRead = w.adapter.read;
  let release, signal, held = false;
  const started = new Promise((resolve) => { signal = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  w.adapter.read = async (path) => {
    if (!held && path.endsWith(`${document.docKey}.jsonl.anchor.json`)) {
      held = true; signal(); await resume;
    }
    return originalRead(path);
  };
  const reader = w.store("fresh-C", true);
  const pending = reader.documentForPath(sourcePath);
  await started;
  reader.invalidateRegistry();
  release();
  await assert.rejects(pending, { code: "WAL_SYNC_PENDING" });
  assert.equal(w.files.get(registry), before, "a stale scan must not publish a new registry");
});

test("main snapshot and route events invalidate a warmed document save cache", async () => {
  const w = world(), store = w.store("windows-A", true);
  const source = { sourceHash: hash("hot cache invalidation"), size: 1024, pageCount: 1, orderedPageIdentities: ["page-0"] };
  const document = await store.registerDocument({ sourcePath: "Fixtures/hot-invalidation.pdf", source });
  await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("warm", 0)] });
  let before = w.calls.read;
  store.invalidateExternal(`${ROOT}/main-snapshots/${document.docKey}/${"a".repeat(64)}.json`);
  await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("after-snapshot", 1)] });
  assert.ok(w.calls.read > before, "snapshot events must force durable state re-read before a save");
  before = w.calls.read;
  store.invalidateExternal(`${ROOT}/main-routes/remote-claim.json`);
  await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("after-route", 2)] });
  assert.ok(w.calls.read > before, "route events must force durable state re-read before a save");
});

test("1,000 sequential host appendOperations calls use one append each and no repeated WAL reads", async () => {
  const w = world();
  const sourcePath = "Fixtures/throughput-copy.pdf";
  const source = { sourceHash: hash("throughput immutable fixture"), size: 11_919_545, pageCount: 357,
    orderedPageIdentities: Array.from({ length: 357 }, (_, index) => `page-${index}`) };
  const readPaths = [];
  const originalRead = w.adapter.read;
  w.adapter.read = async (path) => { readPaths.push(path); return originalRead(path); };
  const store = w.store("windows-A", true);
  const document = await store.registerDocument({ sourcePath, source });
  await store.appendOperations({ document, sourceHash: source.sourceHash, operations: [annotation("item-0", 0)] });
  const walReads = () => readPaths.filter((path) => path.startsWith(`${ROOT}/wal/`)).length;
  const readsAfterWarmup = walReads();
  const appendsAfterWarmup = w.calls.append;
  for (let index = 1; index < 1000; index++) {
    await store.appendOperations({ document, sourceHash: source.sourceHash,
      operations: [annotation(`item-${index}`, index)] });
  }
  assert.equal(w.calls.append - appendsAfterWarmup, 999);
  assert.equal(walReads(), readsAfterWarmup, "hot calls must not re-read growing WAL files");
  const presenceReads = readPaths.filter((path) => path.startsWith(`${ROOT}/main-device-presence/`)).length;
  assert.ok(presenceReads <= 8, `save activity must not create per-operation presence read amplification: ${presenceReads}`);
  const reopened = w.store("windows-A", true);
  const snapshot = await reopened.readDocument(await reopened.documentForPath(sourcePath));
  assert.equal(snapshot.annotations.length, 1000);
});
