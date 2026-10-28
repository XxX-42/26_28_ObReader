import test from "node:test";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPdfAnnotationHost: createHost } = require("../plugin/pdf-annotation-host.cjs");
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
// Keep the Format 3 golden tests intact; wal-host.test.mjs exercises the new default.
const createPdfAnnotationHost = (options) => createHost({ ...options, storeFactory: createPdfAnnotationStore });

function makeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return withAtomicProcess({
    files,
    async exists(path) { return files.has(path) || dirs.has(path); },
    async mkdir(path) { dirs.add(path); },
    async read(path) { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path); },
    async write(path, value) { files.set(path, value); },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`rename target exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async list(path) {
      const prefix = `${path}/`;
      const children = new Set();
      const childFiles = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) childFiles.push(rest);
        else children.add(rest.split("/")[0]);
      }
      for (const key of dirs) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest && rest.includes("/")) children.add(rest.split("/")[0]);
        else if (rest) children.add(rest);
      }
      return { files: childFiles, folders: [...children] };
    },
  }, files);
}

function hash(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let result = 0xcbf29ce484222325n;
  for (const byte of bytes) result = BigInt.asUintN(64, (result ^ BigInt(byte)) * 0x100000001b3n);
  return `xxh64-v1:${result.toString(16).padStart(16, "0")}`;
}

function makeView(app, path = "Books/a.pdf", sourceBytes = new TextEncoder().encode("immutable source PDF bytes").buffer) {
  const bytes = sourceBytes instanceof ArrayBuffer ? sourceBytes : sourceBytes.buffer.slice(
    sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
  const file = { path, basename: path.split("/").at(-1), stat: { size: bytes.byteLength, mtime: 1 } };
  app.vault.file = file;
  app.vault.bytes = bytes.slice(0);
  const messages = [];
  return {
    documentId: "pending-open-id",
    openRequest: 1,
    requestedPath: path,
    documentFile: file,
    file,
    token: "token",
    iframe: {},
    postToViewer(message) { messages.push(message); return true; },
    setStatus(message) { this.lastStatus = message; },
    messages,
    get sourceBytes() { return bytes; },
  };
}

function makeApp(adapter) {
  return {
    vault: {
      adapter,
      file: null,
      bytes: null,
      getAbstractFileByPath(path) { return this.file?.path === path ? this.file : null; },
      async readBinary() { return this.bytes.slice(0); },
    },
  };
}

async function confirmPageIdentity(host, view) {
  await host.handleMessage(view, {
    type: "annotation-source-identity",
    documentId: view.documentId,
    openRequest: view.openRequest,
    pageCount: 1,
    orderedPageIdentities: ["4 0 R"],
  });
}

test("daily save persists only immutable annotation operations and leaves the PDF source untouched", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const sourceHash = hash(new TextEncoder().encode("immutable source PDF bytes"));
  const original = new TextEncoder().encode("immutable source PDF bytes");
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  assert.equal(snapshot.source.sourceHash, sourceHash);
  assert.deepEqual(snapshot.annotations, []);
  await confirmPageIdentity(host, view);

  await host.handleMessage(view, {
    type: "save",
    documentId: view.documentId,
    openRequest: 1,
    requestId: "save-1",
    revision: 1,
    batchId: "batch-1",
    operations: [{
      uuid: "annotation-1",
      kind: "Highlight",
      pageIndex: 3,
      deleted: false,
      clock: { timestamp: 100, logical: 1, deviceId: "viewer-device", opId: "operation-1" },
      payload: { editor: { type: "highlight", color: [1, 1, 0] } },
    }],
  });

  const saved = view.messages.find((message) => message.type === "saved");
  assert.equal(saved?.external, true);
  assert.equal(saved?.operationCount, 1);
  assert.deepEqual(new Uint8Array(app.vault.bytes), original);
  assert.equal([...adapter.files.keys()].some((path) => path.endsWith(".pdf")), false);
  const operationPath = [...adapter.files.keys()].find((path) => path.endsWith(".json") && path.includes("/ops/"));
  assert.ok(operationPath);
  assert.ok(operationPath.includes("test-device-unique"));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok([...adapter.files.keys()].some((path) => path.endsWith(".pdfdata.json")));
  host.dispose();
});

test("legacy annotation UUIDs are imported only from exact PDF object identity metadata", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  let inspectCalls = 0;
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    inspectLegacy: async (bytes) => {
      inspectCalls += 1;
      assert.match(new TextDecoder().decode(bytes), /ObReaderMerge/);
      return { identities: [
        { uuid: "8de8c0a4-8dc1-4d70-a520-b157cc719928", ref: "42 0 R", pageIndex: 0, kind: "highlight", deleted: false },
        { uuid: "8de8c0a4-8dc1-4d70-a520-b157cc719929", ref: "43 0 R", pageIndex: 0, kind: "ink", deleted: true },
        { uuid: "session-should-not-import", ref: "44 0 R", pageIndex: 0, kind: "square", deleted: false },
      ] };
    },
    makeToken: (() => { let n = 0; return () => `migration-token-${++n}`; })(),
    deviceId: "migration-device",
  });
  const bytes = new TextEncoder().encode("%PDF-1.7 /ObReaderMerge");
  const view = makeView(app, "Books/legacy.pdf", bytes);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  assert.equal(inspectCalls, 1);
  assert.deepEqual(snapshot.annotations, []);
  assert.equal(snapshot.legacyIdentityScanComplete, true);
  assert.deepEqual(snapshot.legacyIdentities, [
    { uuid: "8de8c0a4-8dc1-4d70-a520-b157cc719928", ref: "42 0 R", pageIndex: 0, kind: "highlight", deleted: false,
      timestamp: 0, logical: 0, actorId: "legacy", operationId: "legacy" },
  ]);
  host.dispose();
});

test("legacy delete tombstones migrate to the immutable operation log without guessing a live payload", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  let token = 0;
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    inspectLegacy: async () => ({ identities: [
      { uuid: "a0000000-0000-4000-8000-000000000001", ref: "10 0 R", pageIndex: 0, kind: "highlight", deleted: false },
      { uuid: "a0000000-0000-4000-8000-000000000002", ref: null, pageIndex: 0, kind: "underline", deleted: true, timestamp: 7, logical: 1 },
    ] }),
    makeToken: () => `legacy-token-${++token}`,
    deviceId: "legacy-import-device",
  });
  const view = makeView(app, "Books/legacy.pdf", new TextEncoder().encode("%PDF /ObReaderMerge"));
  const snapshot = await host.initializeView(view, view.sourceBytes);
  assert.equal(snapshot.annotations.length, 0, "unconfirmed page identity keeps the returned Viewer snapshot empty");
  const importedSnapshot = view.annotationSnapshot;
  const tombstone = importedSnapshot.tombstones.find((entry) => entry.uuid === "a0000000-0000-4000-8000-000000000002");
  assert.ok(tombstone);
  assert.equal(Object.hasOwn(tombstone, "deleted"), false,
    "the compact tombstone ledger does not store deleted:true annotation rows");
  assert.equal(importedSnapshot.legacyIdentities.some((entry) => entry.uuid === "a0000000-0000-4000-8000-000000000001"), true);
  assert.equal(importedSnapshot.legacyIdentities.some((entry) => entry.uuid === "a0000000-0000-4000-8000-000000000002"), false,
    "deleted rows are represented as LWW tombstones, not sent to PDF.js for ref binding");
  assert.equal((await host.store.listOperationBatches(view.annotationDocument)).length, 1);
  host.dispose();
});

test("a legacy-marker PDF opens read-only when exact identity inspection is unavailable", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const host = createPdfAnnotationHost({ app, hashRuntime: { fingerprint: hash },
    makeToken: () => "legacy-inspector-missing", deviceId: "migration-device" });
  const view = makeView(app, "Books/legacy.pdf", new TextEncoder().encode("%PDF-1.7 /ObReaderId"));
  const snapshot = await host.initializeView(view, view.sourceBytes);
  assert.equal(view.annotationLegacyIdentityUncertain, true);
  assert.equal(view.lastStatus, "检测到旧版 PDF 批注，但无法验证其身份；已进入只读模式，原 PDF 未修改。");
  assert.deepEqual(snapshot.annotations, []);
  assert.equal([...adapter.files.keys()].some((path) => path.endsWith(".pdf")), false);
  host.dispose();
});

test("legacy marker byte search respects exact matches, end boundaries, and Uint8Array subarray bounds", async () => {
  const cases = [
    { name: "marker at byte zero", bytes: new TextEncoder().encode("/ObReaderMerge"), expected: true },
    { name: "marker at final legal offset", bytes: new TextEncoder().encode("%PDF /ObReaderId"), expected: true },
    { name: "near match ending before marker completion", bytes: new TextEncoder().encode("%PDF /ObReaderI"), expected: false },
    { name: "first-byte collisions without a full marker", bytes: new TextEncoder().encode("/x /ObReaderMergX /ObReaderI!"), expected: false },
  ];

  for (const { name, bytes, expected } of cases) {
    const adapter = makeAdapter();
    const app = makeApp(adapter);
    let inspectCalls = 0;
    const host = createPdfAnnotationHost({
      app,
      hashRuntime: { fingerprint: hash },
      inspectLegacy: async () => { inspectCalls += 1; return { identities: [] }; },
      makeToken: () => `marker-${name.replaceAll(" ", "-")}`,
      deviceId: "marker-byte-test",
    });
    const view = makeView(app, `Books/${name}.pdf`, bytes);
    await host.initializeView(view, bytes);
    assert.equal(inspectCalls, expected ? 1 : 0, name);
    host.dispose();
  }

  const backing = new TextEncoder().encode("/ObReaderMerge%PDF-no-marker-in-view");
  const subarray = backing.subarray("/ObReaderMerge".length);
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  let inspectCalls = 0;
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    inspectLegacy: async () => { inspectCalls += 1; return { identities: [] }; },
    makeToken: () => "marker-subarray",
    deviceId: "marker-byte-test",
  });
  const view = makeView(app, "Books/subarray.pdf", subarray);
  await host.initializeView(view, subarray);
  assert.equal(inspectCalls, 0, "marker bytes outside a Uint8Array view must not be inspected");
  host.dispose();
});

test("legacy delete history sharing a ref with a live annotation migrates without suppressing the live mark", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const events = [];
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    inspectLegacy: async () => ({ identities: [
      { uuid: "old-deleted-uuid", ref: "42 0 R", pageIndex: 0, kind: "ink", deleted: true,
        timestamp: 10, logical: 0, actorId: "old-device", operationId: "old-delete" },
      { uuid: "current-live-uuid", ref: "42 0 R", pageIndex: 0, kind: "ink", deleted: false },
    ] }),
    makeToken: (() => { let n = 0; return () => `ambiguous-legacy-document-${++n}`; })(),
    deviceId: "migration-device",
    log: (event, data) => events.push({ event, data }),
  });
  const originalBytes = new TextEncoder().encode("%PDF-1.7 /ObReaderMerge");
  const view = makeView(app, "Books/reused-legacy-ref.pdf", originalBytes);

  const snapshot = await host.initializeView(view, view.sourceBytes);

  assert.equal(view.annotationLegacyIdentityUncertain, false, JSON.stringify(events));
  assert.equal(view.annotationHydrationAllowed, false,
    "page identity still needs the normal PDF.js confirmation handshake");
  assert.deepEqual(snapshot.annotations, []);
  assert.equal(view.annotationDocument.legacyIdentityScanComplete, true);
  assert.deepEqual(view.annotationDocument.legacyIdentities.map((row) => row.uuid), ["current-live-uuid"]);
  const batches = await host.store.listOperationBatches(view.annotationDocument);
  assert.equal(batches.length, 1, "the deleted historical UUID is preserved as a tombstone operation");
  const stored = await host.store.readDocument(view.annotationDocument);
  const deleted = stored.tombstones.find((row) => row.uuid === "old-deleted-uuid");
  assert.ok(deleted);
  assert.equal(Object.hasOwn(deleted, "deleted"), false);
  assert.equal(deleted.embeddedRef, null,
    "a tombstone must not suppress the live annotation that reused its PDF object reference");
  assert.deepEqual(new Uint8Array(app.vault.bytes), originalBytes,
    "legacy migration must leave the immutable source PDF byte-for-byte unchanged");
  assert.equal(events.some(({ event }) => event === "legacy-annotation-identity-migration-failed"), false);
  host.dispose();
});

test("ambiguous live legacy identities leave the PDF readable in read-only mode", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const events = [];
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    inspectLegacy: async () => ({ identities: [
      { uuid: "live-a", ref: "42 0 R", pageIndex: 0, kind: "ink", deleted: false },
      { uuid: "live-b", ref: "42 0 R", pageIndex: 0, kind: "ink", deleted: false },
    ] }),
    makeToken: () => "ambiguous-live-document",
    deviceId: "migration-device",
    log: (event, data) => events.push({ event, data }),
  });
  const originalBytes = new TextEncoder().encode("%PDF-1.7 /ObReaderMerge");
  const view = makeView(app, "Books/ambiguous-live.pdf", originalBytes);

  const snapshot = await host.initializeView(view, view.sourceBytes);

  assert.equal(view.annotationLegacyIdentityUncertain, true);
  assert.equal(view.annotationHydrationAllowed, false);
  assert.equal(view.lastStatus, "检测到旧版 PDF 批注，但无法验证其身份；已进入只读模式，原 PDF 未修改。");
  assert.deepEqual(snapshot.annotations, []);
  assert.equal(view.annotationDocument.legacyIdentityScanComplete, false,
    "an ambiguous scan must remain retryable and must not be recorded as complete");
  assert.equal((await host.store.listOperationBatches(view.annotationDocument)).length, 0,
    "ambiguous live mappings must not be guessed into the external operation log");
  assert.deepEqual(new Uint8Array(app.vault.bytes), originalBytes,
    "migration refusal must leave the immutable source PDF byte-for-byte unchanged");
  assert.ok(events.some(({ event, data }) => event === "legacy-annotation-identity-migration-failed" &&
    data.code === "PDF_ANNOTATION_LEGACY_IDENTITY_AMBIGUOUS"));
  host.dispose();
});

test("source size or mtime changes stop the append path without modifying the source", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  await confirmPageIdentity(host, view);
  app.vault.file.stat.mtime = 2;
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 1,
    requestId: "save-2", revision: 1,
    operations: [{ uuid: "annotation-2", kind: "Ink", pageIndex: 0, deleted: false, payload: { editor: { paths: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");
  assert.equal([...adapter.files.keys()].some((path) => path.includes("/ops/")), false);
  host.dispose();
});

test("changed source identity blocks hydration and normal save", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const makeHost = () => createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const firstHost = makeHost();
  const originalView = makeView(app);
  const originalSnapshot = await firstHost.initializeView(originalView, originalView.sourceBytes);
  originalView.documentId = originalSnapshot.documentId;
  await confirmPageIdentity(firstHost, originalView);
  firstHost.dispose();

  const host = makeHost();
  const changedBytes = new TextEncoder().encode("different PDF source").buffer;
  const view = makeView(app, "Books/a.pdf", changedBytes);
  app.vault.file.stat = { size: changedBytes.byteLength, mtime: 2 };
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  assert.equal(view.annotationSourceMismatch, true);
  assert.deepEqual(snapshot.annotations, [], "unconfirmed external annotations are not returned to a changed source");
  await host.handleMessage(view, {
    type: "annotation-source-identity",
    documentId: view.documentId,
    openRequest: 1,
    pageCount: 1,
    orderedPageIdentities: ["different-ref"],
  });
  assert.equal(view.annotationSourceMismatch, true);
  assert.equal(view.messages.at(-1)?.type, "annotation-source-mismatch");
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 1,
    requestId: "blocked", revision: 1,
    operations: [{ uuid: "unsafe", kind: "Ink", pageIndex: 0, deleted: false,
      payload: { editor: { paths: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");
  host.dispose();
});

test("unknown ordered page identity blocks hydration and external saves", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  let token = 0;
  const host = createPdfAnnotationHost({ app, hashRuntime: { fingerprint: hash },
    makeToken: () => `unknown-page-id-${++token}`, deviceId: "unknown-page-device" });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  await host.handleMessage(view, {
    type: "annotation-source-identity", documentId: view.documentId, openRequest: 1,
    pageCount: 1, orderedPageIdentities: [null], identityStatus: "UNKNOWN",
  });
  assert.equal(view.annotationHydrationAllowed, false);
  assert.equal(view.messages.at(-1)?.reason, "PAGE_IDENTITY_UNAVAILABLE");
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 1,
    requestId: "unknown-page-save", revision: 1,
    operations: [{ uuid: "unsafe-page", kind: "Ink", pageIndex: 0, deleted: false,
      payload: { editor: { points: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");
  assert.equal([...adapter.files.keys()].some((path) => path.includes("/ops/")), false);
  host.dispose();
});

test("close recovery on a changed source is quarantined under its confirmed old identity", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  await confirmPageIdentity(host, view);
  const oldHash = view.annotationSourceHash;
  app.vault.bytes = new TextEncoder().encode("different PDF source").buffer;
  app.vault.file.stat = { size: app.vault.bytes.byteLength, mtime: 2 };
  await host.handleSourceModify(app.vault.file);
  await host.handleMessage(view, {
    type: "recover", documentId: view.documentId, openRequest: 1,
    requestId: "recover-old", revision: 1, sourceHash: oldHash,
    pageCount: 1, orderedPageIdentities: ["4 0 R"],
    operations: [{ uuid: "old-session", kind: "Ink", pageIndex: 0, deleted: false,
      clock: { timestamp: 100, logical: 1, deviceId: "viewer", opId: "old-op" },
      payload: { editor: { paths: [1, 2] } } }],
  });
  const recovered = view.messages.find((message) => message.type === "recovered");
  assert.equal(recovered?.ok, true);
  assert.equal(recovered?.quarantined, true);
  assert.equal([...adapter.files.keys()].some((path) => path.endsWith(".pdf")), false);
  host.dispose();
});

test("checkpoint arrival retries a pending v3 sync and restores editing in the open Reader", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `sidecar-token-${++n}`; })(),
    deviceId: "sidecar-local",
  });
  const view = makeView(app);
  const preRegistered = await host.store.registerDocument({ sourcePath: view.file.path });
  const locations = host.store.pathsFor(preRegistered);
  adapter.files.set(`${locations.deviceStates}/sidecar-peer.json`, JSON.stringify({
    schemaVersion: 1, deviceId: "sidecar-peer", pluginVersion: "0.7.1", storageFormatVersion: 2,
    checkpointHash: null, retired: false, updatedAt: Date.now(),
  }));

  const initial = await host.initializeView(view, view.sourceBytes);
  view.documentId = initial.documentId;
  await confirmPageIdentity(host, view);
  const document = view.annotationDocument;
  const checkpointPath = locations.checkpoint;
  const checkpoint2 = JSON.parse(adapter.files.get(checkpointPath));
  assert.equal(checkpoint2.formatVersion, 2);

  const delayed = {
    schemaVersion: 1, formatVersion: 3, pluginVersion: "0.8.0",
    kind: "annotation-operation-batch", documentId: document.documentId, docKey: document.docKey,
    deviceId: "sidecar-peer", batchId: "delayed-v3", createdAt: Date.now(),
    baseCheckpointHash: checkpoint2.integrity, parents: checkpoint2.batchHeads,
    operations: [{ uuid: "delayed-v3", kind: "Highlight", pageIndex: 0, deleted: false,
      payload: { color: [1, 1, 0] },
      clock: { timestamp: Date.now(), logical: 0, deviceId: "sidecar-peer", opId: "delayed-v3-op" } }],
  };
  const delayedPath = `${locations.operations}/sidecar-peer/delayed-v3.json`;
  await adapter.mkdir(locations.operations);
  await adapter.mkdir(`${locations.operations}/sidecar-peer`);
  adapter.files.set(delayedPath, JSON.stringify(delayed));
  await host.handleSidecarChange({ path: delayedPath });
  assert.equal(view.annotationSyncPending, true);
  assert.equal(view.messages.filter((message) => message.type === "external-annotations-update").at(-1)?.readOnly, true);
  assert.equal(adapter.files.get(checkpointPath), JSON.stringify(checkpoint2));

  // Model the missing format-3 checkpoint arriving after an upgraded peer ACK.
  adapter.files.delete(delayedPath);
  const peerAckTime = Date.now();
  adapter.files.set(`${locations.deviceStates}/sidecar-peer.json`, JSON.stringify({
    schemaVersion: 1, deviceId: "sidecar-peer", pluginVersion: "0.8.1", storageFormatVersion: 3,
    checkpointHash: checkpoint2.integrity, retired: false, acknowledgedAt: peerAckTime, updatedAt: peerAckTime,
  }));
  await host.store.readDocument(document);
  const checkpoint3 = JSON.parse(adapter.files.get(checkpointPath));
  assert.equal(checkpoint3.formatVersion, 3);
  adapter.files.set(delayedPath, JSON.stringify(delayed));

  await host.handleSidecarChange({ path: delayedPath });
  assert.equal(view.annotationSyncPending, false);
  assert.equal(view.lastStatus, "批注同步已完成，已恢复编辑。");
  const update = view.messages.filter((message) => message.type === "external-annotations-update").at(-1);
  assert.equal(update?.readOnly, false);
  assert.ok(update?.externalAnnotations.annotations.some((row) => row.uuid === "delayed-v3"));
  host.dispose();
});

test("self-originated sidecar notifications do not re-enter checkpoint materialization", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  let materializations = 0;
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `self-echo-${++n}`; })(),
    deviceId: "self-echo-device",
    log(event, details) {
      if (event === "annotation-performance" && details?.phase === "materialization") materializations += 1;
    },
  });
  const view = makeView(app);
  const initial = await host.initializeView(view, view.sourceBytes);
  view.documentId = initial.documentId;
  const document = view.annotationDocument;
  const paths = host.store.pathsFor(document);
  const devicePath = `${paths.deviceStates}/self-echo-device.json`;
  assert.ok(adapter.files.has(paths.checkpoint));
  assert.ok(adapter.files.has(devicePath));
  await host.store.appendOperations({
    document,
    batchId: "self-echo-published-batch",
    sourceHash: document.source.sourceHash,
    operations: [{
      uuid: "self-echo-annotation",
      kind: "Highlight",
      pageIndex: 0,
      deleted: false,
      clock: { timestamp: 1, logical: 0, deviceId: "self-echo-device", opId: "self-echo-op" },
      payload: { editor: { type: "highlight", color: [1, 1, 0] } },
    }],
  });
  const batchPath = `${paths.operations}/self-echo-device/self-echo-published-batch.json`;
  assert.ok(adapter.files.has(batchPath));

  const afterOpen = materializations;

  await host.handleSidecarChange({ path: paths.checkpoint });
  await host.handleSidecarChange({ path: devicePath });
  await host.handleSidecarChange({ path: batchPath });
  assert.equal(materializations, afterOpen,
    "the host already knows its own checkpoint/ACK/published operation bytes and must not turn their Vault events into another materialization");

  adapter.files.set(paths.checkpoint, `${adapter.files.get(paths.checkpoint)} `);
  await host.handleSidecarChange({ path: paths.checkpoint });
  assert.equal(materializations, afterOpen + 1,
    "an external rewrite with different bytes must not be mistaken for a self echo");

  await host.handleSidecarChange({ path: `${paths.operations}/peer/external-batch.json` });
  assert.equal(materializations, afterOpen + 2,
    "an unmatched external operation event must still refresh open Readers");
  host.dispose();
});

test("legacy tombstones from a concurrent Reader initialization reach already-open Readers", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const bytes = new TextEncoder().encode("%PDF-1.7 /ObReaderMerge");
  let host;
  let inspectCalls = 0;
  let alreadyOpenView;
  let token = 0;
  host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    inspectLegacy: async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) {
        alreadyOpenView = makeView(app, "Books/legacy-concurrent.pdf", bytes);
        const concurrentSnapshot = await host.initializeView(alreadyOpenView, alreadyOpenView.sourceBytes);
        alreadyOpenView.documentId = concurrentSnapshot.documentId;
        return { identities: [
          { uuid: "a0000000-0000-4000-8000-000000000003", ref: null, pageIndex: 0, kind: "underline", deleted: true },
        ] };
      }
      return { identities: [] };
    },
    makeToken: () => `legacy-concurrent-${++token}`,
    deviceId: "legacy-concurrent-device",
  });

  const openingView = makeView(app, "Books/legacy-concurrent.pdf", bytes);
  await host.initializeView(openingView, openingView.sourceBytes);
  const update = alreadyOpenView.messages.find(message => message.type === "external-annotations-update");
  assert.ok(update, "the existing Reader receives the newly materialized tombstone state");
  assert.ok(update.externalAnnotations.tombstones?.some(entry => entry.uuid === "a0000000-0000-4000-8000-000000000003"),
    JSON.stringify({ keys: Object.keys(update.externalAnnotations), annotations: update.externalAnnotations.annotations }));
  host.dispose();
});
