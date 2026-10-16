import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfAnnotationHost } = require("../plugin/pdf-annotation-host.cjs");

const ROOT = "00_Archive/20_PDFData";

function makeAdapter(shared = {
  files: new Map(), folders: new Set(), writes: [], renames: [], removes: [],
}) {
  const { files, folders, writes, renames, removes } = shared;
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) {
      if (!files.has(path)) throw new Error(`missing ${path}`);
      return files.get(path);
    },
    async write(path, value) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !folders.has(parent)) throw new Error(`parent directory missing: ${parent}`);
      files.set(path, value);
      writes.push(path);
    },
    async append(path, value) {
      if (!files.has(path)) throw new Error(`missing append target: ${path}`);
      files.set(path, `${files.get(path)}${value}`);
      writes.push(path);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`rename target exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
      renames.push([from, to]);
    },
    async remove(path) {
      files.delete(path);
      removes.push(path);
    },
    async list(path) {
      const prefix = `${path}/`;
      const directFiles = [];
      const directFolders = new Set();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        if (!remainder.includes("/")) directFiles.push(remainder);
        else directFolders.add(remainder.slice(0, remainder.indexOf("/")));
      }
      for (const folder of folders) {
        if (!folder.startsWith(prefix)) continue;
        const remainder = folder.slice(prefix.length);
        if (remainder && !remainder.includes("/")) directFolders.add(remainder);
      }
      return { files: directFiles, folders: [...directFolders] };
    },
  };
  return { adapter, shared };
}

function hash(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeApp(adapter) {
  const filesByPath = new Map();
  const bytesByPath = new Map();
  return {
    vault: {
      adapter,
      filesByPath,
      bytesByPath,
      getAbstractFileByPath(path) { return filesByPath.get(path) || null; },
      async readBinary(file) {
        const bytes = bytesByPath.get(file.path);
        if (!bytes) throw new Error(`missing PDF source bytes for ${file.path}`);
        return bytes.slice(0);
      },
    },
  };
}

function makeView(app, path = "Books/a.pdf", sourceBytes = new TextEncoder().encode("unchanged source PDF bytes"), fileOverride = null) {
  const bytes = sourceBytes instanceof Uint8Array ? sourceBytes.slice(0) : new Uint8Array(sourceBytes);
  const file = fileOverride || { path, basename: path.split("/").at(-1), stat: { size: bytes.byteLength, mtime: 1 } };
  app.vault.filesByPath.set(path, file);
  app.vault.bytesByPath.set(path, bytes.slice(0));
  const messages = [];
  return {
    documentId: "pending-open-id",
    openRequest: 1,
    requestedPath: path,
    documentFile: file,
    file,
    token: `token-${path}`,
    iframe: {},
    postToViewer(message) { messages.push(message); return true; },
    setStatus(message) { this.lastStatus = message; },
    messages,
    get sourceBytes() { return app.vault.bytesByPath.get(file.path).slice(0); },
  };
}

function makeHost(app, deviceId = "wal-host-device", enableJsonl = false) {
  let token = 0;
  return createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash,
      createAccumulator() {
        const hasher = createHash("sha256");
        return { update(bytes) { hasher.update(bytes); },
          digest() { return `sha256-v1:${hasher.copy().digest("hex")}`; } };
      } },
    makeToken: () => `${deviceId}-token-${++token}`,
    deviceId,
    enableJsonl,
  });
}

async function initializeAndConfirm(host, view, orderedPageIdentities = ["4 0 R", "8 0 R"]) {
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  await host.handleMessage(view, {
    type: "annotation-source-identity",
    documentId: view.documentId,
    openRequest: view.openRequest,
    pageCount: orderedPageIdentities.length,
    orderedPageIdentities,
  });
  return snapshot;
}

const initialOperations = [
  { uuid: "kind-highlight", kind: "Highlight", pageIndex: 0, deleted: false,
    payload: { editor: { type: "highlight", color: [1, 1, 0], quads: [[1, 2, 3, 4]] } } },
  { uuid: "kind-underline", kind: "Underline", pageIndex: 0, deleted: false,
    payload: { editor: { type: "underline", color: [0, 0, 1], quads: [[5, 6, 7, 8]] } } },
  { uuid: "kind-square", kind: "Square", pageIndex: 1, deleted: false,
    payload: { editor: { type: "square", color: [1, 0, 0], rect: [10, 20, 30, 40] } } },
  { uuid: "kind-ink", kind: "Ink", pageIndex: 1, deleted: false,
    payload: { editor: { type: "ink", color: [0, 0, 0], paths: [{ points: [1, 2, 3] }] } } },
  { uuid: "kind-ink-highlight", kind: "InkHighlight", pageIndex: 1, deleted: false,
    payload: { editor: { type: "inkhighlight", color: [1, 0.8, 0], paths: [{ points: [4, 5, 6] }] } } },
  { uuid: "kind-freetext", kind: "FreeText", pageIndex: 0, deleted: false,
    payload: { editor: { type: "freetext", value: "note", fontSize: 12, color: [0, 0, 0] } } },
  { uuid: "kind-deleted", kind: "Ink", pageIndex: 1, deleted: true },
];

test("default WAL host saves and recovers all annotation kinds, reopens them, and follows a rename route", async () => {
  const { adapter, shared } = makeAdapter();
  const app = makeApp(adapter);
  const sourceBytes = new TextEncoder().encode("unchanged source PDF bytes");
  const originalPdfBytes = sourceBytes.slice(0);
  const firstHost = makeHost(app, "wal-device-one");
  const firstView = makeView(app, "Books/a.pdf", sourceBytes);
  const firstSnapshot = await initializeAndConfirm(firstHost, firstView);
  assert.equal(firstView.annotationHydrationAllowed, true);
  assert.deepEqual(firstSnapshot.annotations, []);

  const saveOperations = initialOperations.map((operation, index) => ({
    ...operation,
    clock: { timestamp: 100 + index, logical: index, deviceId: "viewer-device", opId: `viewer-save-${index}` },
  }));
  await firstHost.handleMessage(firstView, {
    type: "save",
    documentId: firstView.documentId,
    openRequest: firstView.openRequest,
    requestId: "save-six-kinds",
    revision: 1,
    operations: saveOperations,
  });
  assert.equal(firstView.messages.at(-1)?.type, "saved");
  assert.equal(firstView.messages.at(-1)?.external, true);
  assert.equal(firstView.messages.at(-1)?.operationCount, 7);

  await firstHost.handleMessage(firstView, {
    type: "recover",
    documentId: firstView.documentId,
    openRequest: firstView.openRequest,
    requestId: "recover-unchanged-source",
    revision: 2,
    sourceHash: firstView.annotationSourceHash,
    pageCount: 2,
    orderedPageIdentities: ["4 0 R", "8 0 R"],
    operations: [{
      uuid: "recovered-uuid",
      kind: "FreeText",
      pageIndex: 1,
      deleted: false,
      clock: { timestamp: 200, logical: 0, deviceId: "recovery-viewer", opId: "recover-op" },
      payload: { editor: { type: "freetext", value: "recovered", fontSize: 10 } },
    }],
  });
  assert.equal(firstView.messages.at(-1)?.type, "recovered");
  assert.equal(firstView.messages.at(-1)?.ok, true);
  assert.equal(firstView.messages.at(-1)?.quarantined, false);
  assert.equal(firstView.annotationSourceMismatch, false);
  assert.deepEqual(app.vault.bytesByPath.get("Books/a.pdf"), originalPdfBytes);
  assert.equal([...shared.files.keys()].some((path) => path.endsWith(".pdf")), false);

  const saved = await firstHost.store.readDocument(firstView.annotationDocument);
  assert.equal(saved.storageProtocol, "wal-sidecar-v3.1");
  assert.deepEqual(new Set(saved.annotations.map((row) => row.kind)), new Set([
    "Highlight", "Underline", "Square", "Ink", "InkHighlight", "FreeText",
  ]));
  for (const operation of initialOperations.filter((row) => !row.deleted)) {
    const recoveredRow = saved.annotations.find((row) => row.uuid === operation.uuid);
    assert.deepEqual(recoveredRow.payload, operation.payload, `${operation.kind} payload roundtrips exactly`);
    assert.equal(recoveredRow.pageIndex, operation.pageIndex);
  }
  assert.deepEqual(saved.tombstones.map((row) => row.uuid), ["kind-deleted"]);
  assert.equal(Object.hasOwn(saved.tombstones[0], "deleted"), false,
    "deleted operations remain in the separate compact tombstone list");
  assert.ok(saved.annotations.some((row) => row.uuid === "recovered-uuid"));

  firstHost.dispose();
  const reopenedHost = makeHost(app, "wal-device-one");
  const reopenedView = makeView(app, "Books/a.pdf", sourceBytes);
  const reopenedSnapshot = await reopenedHost.initializeView(reopenedView, reopenedView.sourceBytes);
  reopenedView.documentId = reopenedSnapshot.documentId;
  assert.equal(reopenedSnapshot.documentId, firstView.documentId);
  assert.equal(reopenedView.annotationHydrationAllowed, true);
  assert.ok(reopenedSnapshot.annotations.some((row) => row.uuid === "kind-freetext"));
  assert.deepEqual(reopenedSnapshot.tombstones.map((row) => row.uuid), ["kind-deleted"]);

  const oldPath = "Books/a.pdf";
  const newPath = "Archive/renamed-a.pdf";
  const movedFile = { path: newPath, basename: "renamed-a.pdf", stat: { ...reopenedView.file.stat } };
  app.vault.filesByPath.delete(oldPath);
  app.vault.bytesByPath.delete(oldPath);
  app.vault.filesByPath.set(newPath, movedFile);
  app.vault.bytesByPath.set(newPath, originalPdfBytes.slice(0));
  assert.equal(await reopenedHost.renamed(movedFile, oldPath), true);
  assert.equal(reopenedView.annotationDocument.sourcePath, newPath);
  assert.equal(reopenedView.messages.at(-1)?.type, "annotation-path-updated");
  assert.equal(reopenedView.messages.at(-1)?.sourcePath, newPath);
  assert.equal(await reopenedHost.store.documentForPath(oldPath), null);
  assert.equal((await reopenedHost.store.documentForPath(newPath)).documentId, firstView.documentId);
  assert.deepEqual(app.vault.bytesByPath.get(newPath), originalPdfBytes);
  reopenedHost.dispose();
});

test("v3.2 host saves a batch with one portable append and leaves the source PDF untouched", async () => {
  const { adapter, shared } = makeAdapter();
  const app = makeApp(adapter);
  const host = makeHost(app, "jsonl-host-device", true);
  try {
    const view = makeView(app, "Books/jsonl-fixture.pdf");
    const before = hash(view.sourceBytes);
    await initializeAndConfirm(host, view);
    await host.handleMessage(view, {
      type: "save", documentId: view.documentId, openRequest: view.openRequest,
      requestId: "jsonl-batch", revision: 1,
      operations: initialOperations.slice(0, 3).map((operation, index) => ({ ...operation,
        clock: { timestamp: 100 + index, logical: index, deviceId: "viewer", opId: `jsonl-${index}` },
      })),
    });
    assert.equal(view.messages.at(-1)?.type, "saved");
    assert.equal(view.messages.at(-1)?.operationCount, 3);
    const wal = `${ROOT}/wal/jsonl-host-device/${view.annotationDocument.docKey}.jsonl`;
    assert.equal(shared.writes.filter((path) => path === wal).length, 2,
      "initial empty-file creation and one batched append are the only WAL writes");
    const rows = shared.files.get(wal).trimEnd().split("\n");
    assert.equal(rows.length, 3);
    assert.equal(hash(view.sourceBytes), before);
    assert.equal([...shared.files.keys()].some((path) => path.endsWith(".pdf")), false);
    const snapshot = await host.store.readDocument(view.annotationDocument);
    assert.equal(snapshot.storageProtocol, "wal-sidecar-v3.2-jsonl");
    assert.deepEqual(snapshot.annotations.map((row) => row.uuid).sort(),
      ["kind-highlight", "kind-square", "kind-underline"]);
  } finally {
    host.dispose();
  }
});

test("v3.2 host checks a burst of self WAL events once and still detects changed external bytes", async () => {
  const { adapter, shared } = makeAdapter();
  const app = makeApp(adapter);
  const host = makeHost(app, "jsonl-event-device", true);
  try {
    const view = makeView(app, "Books/jsonl-event-fixture.pdf");
    await initializeAndConfirm(host, view);
    await host.handleMessage(view, {
      type: "save", documentId: view.documentId, openRequest: view.openRequest,
      requestId: "event-save", revision: 1,
      operations: [{ ...initialOperations[2],
        clock: { timestamp: 100, logical: 1, deviceId: "viewer", opId: "event-1" } }],
    });
    const wal = `${ROOT}/wal/jsonl-event-device/${view.annotationDocument.docKey}.jsonl`;
    // The save broadcasts asynchronously; finish that independent read before
    // measuring only the Vault-event burst below.
    await new Promise((resolve) => setTimeout(resolve, 100));
    let walReads = 0;
    const originalRead = adapter.read;
    adapter.read = async (path) => {
      if (path === wal) walReads++;
      return originalRead(path);
    };
    const before = walReads;
    await Promise.all(Array.from({ length: 50 }, () => host.handleSidecarChange({ path: wal })));
    assert.equal(walReads - before, 1, "one exact hash check covers a burst of self events");
    // A torn final row is repairable and should not force syncPending. Use a
    // complete invalid external row to prove a changed fingerprint is replayed.
    shared.files.set(wal, `${shared.files.get(wal)}{"lsn":2,"op":"CREATE"}\n`);
    await host.handleSidecarChange({ path: wal });
    const update = view.messages.filter((message) => message.type === "external-annotations-update").at(-1);
    assert.equal(update?.externalAnnotations?.syncPending, true,
      "a changed external WAL must not be hidden by the previous self-write fingerprint");
  } finally {
    host.dispose();
  }
});

test("continuous self WAL events defer full verification until the event generation settles", async () => {
  const { adapter } = makeAdapter();
  const app = makeApp(adapter);
  const host = makeHost(app, "jsonl-continuous-device", true);
  try {
    const view = makeView(app, "Books/jsonl-continuous-fixture.pdf");
    await initializeAndConfirm(host, view);
    await host.handleMessage(view, { type: "save", documentId: view.documentId,
      openRequest: view.openRequest, requestId: "continuous-save", revision: 1,
      operations: [{ ...initialOperations[2], clock: { timestamp: 100, logical: 1,
        deviceId: "viewer", opId: "continuous-1" } }] });
    const wal = `${ROOT}/wal/jsonl-continuous-device/${view.annotationDocument.docKey}.jsonl`;
    await new Promise((resolve) => setTimeout(resolve, 100));
    let reads = 0;
    const originalRead = adapter.read;
    adapter.read = async (path) => { if (path === wal) reads++; return originalRead(path); };
    const pending = [];
    for (let index = 0; index < 8; index++) {
      pending.push(host.handleSidecarChange({ path: wal }));
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await Promise.all(pending);
    assert.equal(reads, 1, "a sustained write burst must not repeatedly reread its growing WAL");
  } finally { host.dispose(); }
});

test("a save from one Reader view broadcasts the committed state to another view", async () => {
  const { adapter } = makeAdapter();
  const app = makeApp(adapter);
  const host = makeHost(app, "multi-view-device");
  const first = makeView(app);
  await initializeAndConfirm(host, first);
  const second = makeView(app, "Books/a.pdf", first.sourceBytes, first.file);
  const secondSnapshot = await host.initializeView(second, second.sourceBytes);
  second.documentId = secondSnapshot.documentId;
  assert.equal(second.documentId, first.documentId);
  assert.equal(second.annotationHydrationAllowed, true);

  await host.handleMessage(first, {
    type: "save", documentId: first.documentId, openRequest: first.openRequest,
    requestId: "multi-view-save", revision: 1,
    operations: [{
      uuid: "shared-update",
      kind: "Highlight",
      pageIndex: 0,
      deleted: false,
      clock: { timestamp: 300, logical: 0, deviceId: "viewer", opId: "shared-operation" },
      payload: { editor: { type: "highlight", value: "visible in both views" } },
    }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const update = second.messages.findLast((message) => message.type === "external-annotations-update");
  assert.ok(update);
  assert.ok(update.externalAnnotations.annotations.some((row) => row.uuid === "shared-update"));
  assert.deepEqual(update.externalAnnotations.annotations.find((row) => row.uuid === "shared-update").payload,
    { editor: { type: "highlight", value: "visible in both views" } });
  host.dispose();
});

test("an invalid remote WAL shard marks the view pending and blocks edits", async () => {
  const { adapter, shared } = makeAdapter();
  const app = makeApp(adapter);
  const host = makeHost(app, "wal-pending-device");
  const view = makeView(app);
  await initializeAndConfirm(host, view);
  const paths = host.store.pathsFor(view.annotationDocument);
  const remoteOwner = "remote-device";
  const remoteDirectory = `${paths.walRoot}/${remoteOwner}`;
  shared.folders.add(paths.walRoot);
  shared.folders.add(remoteDirectory);
  const remotePath = `${remoteDirectory}/${view.annotationDocument.docKey}.json`;
  shared.files.set(remotePath, "{truncated remote WAL");

  await host.handleSidecarChange({ path: remotePath });
  assert.equal(view.annotationSyncPending, true);
  const writesBeforeSave = shared.writes.length;
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: view.openRequest,
    requestId: "blocked-pending-save", revision: 1,
    operations: [{ uuid: "must-wait", kind: "Ink", pageIndex: 0, deleted: false,
      payload: { editor: { type: "ink", paths: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.type, "error");
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SYNC_PENDING");
  assert.equal(shared.writes.length, writesBeforeSave, "a pending remote shard prevents a new local WAL write");
  host.dispose();
});

test("a changed source PDF stays byte-identical and blocks annotation hydration and saves", async () => {
  const { adapter, shared } = makeAdapter();
  const app = makeApp(adapter);
  const originalBytes = new TextEncoder().encode("original PDF bytes");
  const firstHost = makeHost(app, "source-check-device");
  const originalView = makeView(app, "Books/Changed.pdf", originalBytes);
  await initializeAndConfirm(firstHost, originalView, ["4 0 R"]);
  await firstHost.handleMessage(originalView, {
    type: "save", documentId: originalView.documentId, openRequest: originalView.openRequest,
    requestId: "before-change", revision: 1,
    operations: [{ uuid: "before-change", kind: "Square", pageIndex: 0, deleted: false,
      payload: { editor: { type: "square", rect: [1, 2, 3, 4] } } }],
  });
  firstHost.dispose();
  const writesBeforeChangedOpen = shared.writes.length;

  const replacementBytes = new TextEncoder().encode("replacement PDF bytes");
  const replacementFile = { path: "Books/Changed.pdf", basename: "Changed.pdf",
    stat: { size: replacementBytes.byteLength, mtime: 2 } };
  app.vault.filesByPath.set(replacementFile.path, replacementFile);
  app.vault.bytesByPath.set(replacementFile.path, replacementBytes.slice(0));
  const host = makeHost(app, "source-check-device");
  const view = makeView(app, replacementFile.path, replacementBytes, replacementFile);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  assert.equal(view.annotationSourceMismatch, true);
  assert.equal(view.annotationHydrationAllowed, false);
  assert.deepEqual(snapshot.annotations, []);
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: view.openRequest,
    requestId: "blocked-changed-source", revision: 1,
    operations: [{ uuid: "unsafe-change", kind: "Ink", pageIndex: 0, deleted: false,
      payload: { editor: { type: "ink", paths: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.type, "error");
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");
  assert.deepEqual(app.vault.bytesByPath.get(replacementFile.path), replacementBytes,
    "the replacement PDF remains byte-for-byte unchanged");
  assert.equal([...shared.files.keys()].some((path) => path.endsWith(".pdf")), false);
  assert.equal(shared.writes.slice(writesBeforeChangedOpen).some((path) => path.endsWith(".pdf")), false);
  host.dispose();
});

test("retrying a save with the same origin operation ID acknowledges once without advancing the WAL", async () => {
  const { adapter } = makeAdapter();
  const app = makeApp(adapter);
  app.isMobile = true; // Keep idle snapshot maintenance outside this short retry assertion.
  const host = makeHost(app, "retry-device");
  const view = makeView(app, "Books/Retry.pdf");
  await initializeAndConfirm(host, view, ["4 0 R"]);
  const operation = {
    uuid: "retry-stable-uuid",
    kind: "Highlight",
    pageIndex: 0,
    deleted: false,
    clock: { timestamp: 500, logical: 3, deviceId: "viewer", opId: "retry-origin-op" },
    payload: { editor: { type: "highlight", value: "one logical edit" } },
  };
  const request = {
    type: "save", documentId: view.documentId, openRequest: view.openRequest,
    requestId: "same-save-request", revision: 1, operations: [operation],
  };

  await host.handleMessage(view, request);
  const firstAck = view.messages.at(-1);
  assert.equal(firstAck?.type, "saved");
  assert.equal(firstAck?.operationCount, 1);
  assert.ok(firstAck?.batchId);
  const beforeRetry = await host.store.readEffective(view.annotationDocument);
  const ownedBefore = beforeRetry.valid.find((entry) => entry.deviceId === "retry-device");
  const beforeSequence = ownedBefore.nextSeq;
  const beforeTailCount = ownedBefore.tail.length;

  await host.handleMessage(view, request);
  const retryAck = view.messages.at(-1);
  assert.equal(retryAck?.type, "saved");
  assert.equal(retryAck?.requestId, "same-save-request");
  assert.equal(retryAck?.revision, 1);
  assert.equal(retryAck?.operationCount, 1, "the logical edit remains acknowledged on retry");
  assert.equal(retryAck?.batchId, firstAck.batchId, "retry points to the original durable operation");

  const afterRetry = await host.store.readEffective(view.annotationDocument);
  const ownedAfter = afterRetry.valid.find((entry) => entry.deviceId === "retry-device");
  assert.equal(ownedAfter.nextSeq, beforeSequence, "a repeated operation ID does not advance sequence");
  assert.equal(ownedAfter.tail.length, beforeTailCount, "a repeated operation ID adds no WAL row");
  const matching = [...ownedAfter.anchor.operations, ...ownedAfter.tail]
    .filter((row) => row.originOpId === "retry-origin-op");
  assert.equal(matching.length, 1);
  assert.deepEqual(matching[0].payload, operation.payload);
  assert.equal(matching[0].seq + 1, beforeSequence);
  const snapshot = await host.store.readDocument(view.annotationDocument);
  assert.deepEqual(snapshot.annotations.filter((row) => row.uuid === operation.uuid).map((row) => row.payload), [operation.payload]);
  host.dispose();
});

test("disposed and stale host sessions cannot persist a queued Reader save", async () => {
  const { adapter, shared } = makeAdapter();
  const app = makeApp(adapter);
  const host = makeHost(app, "stale-session-device");
  const view = makeView(app, "Books/Stale.pdf");
  await initializeAndConfirm(host, view, ["4 0 R"]);
  const writesBefore = shared.writes.length;
  const filesBefore = new Map(shared.files);

  view.openRequest = 2;
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 1,
    requestId: "stale-open-request", revision: 1,
    operations: [{ uuid: "stale-operation", kind: "Square", pageIndex: 0, deleted: false,
      payload: { editor: { type: "square", rect: [1, 1, 2, 2] } } }],
  });
  assert.equal(view.messages.at(-1)?.type, "error");
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SESSION_CHANGED");
  assert.equal(shared.writes.length, writesBefore);
  assert.deepEqual(shared.files, filesBefore);

  host.dispose();
  const messagesAfterDispose = view.messages.length;
  const result = await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 2,
    requestId: "disposed-host-save", revision: 1, operations: [],
  });
  assert.equal(result, false);
  assert.equal(view.messages.length, messagesAfterDispose);
  assert.equal(shared.writes.length, writesBefore);
  assert.deepEqual(shared.files, filesBefore);
});

test("recovery for a replaced source is quarantined under the original PDF identity", async () => {
  const { adapter, shared } = makeAdapter();
  const app = makeApp(adapter);
  const forbiddenSourceWrites = [];
  app.vault.modifyBinary = async () => { forbiddenSourceWrites.push("modifyBinary"); throw new Error("PDF write forbidden"); };
  app.vault.appendBinary = async () => { forbiddenSourceWrites.push("appendBinary"); throw new Error("PDF append forbidden"); };
  const originalBytes = new TextEncoder().encode("original PDF bytes with confirmed pages");
  const changedBytes = new TextEncoder().encode("externally replaced PDF bytes");
  const host = makeHost(app, "quarantine-device");
  const originalView = makeView(app, "Books/Quarantine.pdf", originalBytes);
  await initializeAndConfirm(host, originalView, ["4 0 R", "8 0 R"]);
  const originalDocumentId = originalView.documentId;
  const originalHash = originalView.annotationSourceHash;
  await host.handleMessage(originalView, {
    type: "save", documentId: originalView.documentId, openRequest: originalView.openRequest,
    requestId: "save-before-replacement", revision: 1,
    operations: [{ uuid: "original-annotation", kind: "Square", pageIndex: 0, deleted: false,
      clock: { timestamp: 600, logical: 0, deviceId: "viewer", opId: "original-operation" },
      payload: { editor: { type: "square", rect: [5, 6, 7, 8] } } }],
  });
  assert.equal(originalView.messages.at(-1)?.type, "saved");

  // Replace the actual bytes and stat at the existing route while the Reader
  // still holds its original document identity.
  app.vault.bytesByPath.set(originalView.file.path, changedBytes.slice(0));
  originalView.file.stat = { size: changedBytes.byteLength, mtime: 2 };
  await host.handleMessage(originalView, {
    type: "save", documentId: originalDocumentId, openRequest: originalView.openRequest,
    requestId: "save-after-replacement", revision: 2,
    operations: [{ uuid: "must-not-join", kind: "Ink", pageIndex: 1, deleted: false,
      payload: { editor: { type: "ink", paths: [] } } }],
  });
  assert.equal(originalView.messages.at(-1)?.type, "error");
  assert.equal(originalView.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");

  const changedView = makeView(app, "Books/Quarantine.pdf", changedBytes, originalView.file);
  changedView.pdfDocument = {
    async saveDocument() { forbiddenSourceWrites.push("saveDocument"); throw new Error("PDF serialization forbidden"); },
  };
  const changedSnapshot = await host.initializeView(changedView, changedView.sourceBytes);
  changedView.documentId = changedSnapshot.documentId;
  assert.equal(changedView.documentId, originalDocumentId);
  assert.equal(changedView.annotationSourceMismatch, true);
  assert.equal(changedView.annotationHydrationAllowed, false);
  assert.deepEqual(changedSnapshot.annotations, []);

  const baseline = await host.store.readEffective(originalView.annotationDocument);
  const localBefore = baseline.valid.find((entry) => entry.deviceId === "quarantine-device");
  const priorRows = [...localBefore.anchor.operations, ...localBefore.tail];
  assert.ok(priorRows.some((row) => row.originOpId === "original-operation"));
  assert.equal(priorRows.some((row) => row.uuid === "must-not-join"), false);
  const writesBeforeRecovery = shared.writes.length;

  const recoveryOperation = {
    uuid: "quarantined-recovery-annotation", kind: "Highlight", pageIndex: 1, deleted: false,
    clock: { timestamp: 700, logical: 0, deviceId: "recovery-viewer", opId: "quarantined-recovery-op" },
    payload: { editor: { type: "highlight", value: "kept for the original PDF only" } },
  };
  await host.handleMessage(changedView, {
    type: "recover", documentId: changedView.documentId, openRequest: changedView.openRequest,
    requestId: "invalid-original-identity", revision: 1,
    sourceHash: "sha256-v1:0000000000000000000000000000000000000000000000000000000000000000",
    pageCount: 2, orderedPageIdentities: ["4 0 R", "8 0 R"],
    operations: [recoveryOperation],
  });
  assert.equal(changedView.messages.at(-1)?.type, "error");
  assert.equal(changedView.messages.at(-1)?.code, "PDF_ANNOTATION_RECOVERY_IDENTITY_UNKNOWN");
  assert.equal(shared.writes.length, writesBeforeRecovery, "invalid recovery identity cannot append a WAL contribution");

  await host.handleMessage(changedView, {
    type: "recover", documentId: changedView.documentId, openRequest: changedView.openRequest,
    requestId: "valid-original-identity", revision: 1,
    sourceHash: originalHash,
    pageCount: 2,
    orderedPageIdentities: ["4 0 R", "8 0 R"],
    operations: [recoveryOperation],
  });
  const recovered = changedView.messages.at(-1);
  assert.equal(recovered?.type, "recovered");
  assert.equal(recovered?.ok, true);
  assert.equal(recovered?.quarantined, true);
  assert.equal(recovered?.operationCount, 1);
  assert.ok(recovered?.batchId);

  const persisted = await host.store.readEffective(originalView.annotationDocument);
  assert.equal(persisted.document.documentId, originalDocumentId);
  assert.equal(persisted.document.source.sourceHash, originalHash,
    "recovery remains bound to the immutable original source hash");
  const persistedRows = persisted.valid.flatMap((entry) => [...entry.anchor.operations, ...entry.tail]);
  const quarantinedRows = persistedRows.filter((row) => row.originOpId === "quarantined-recovery-op");
  assert.equal(quarantinedRows.length, 1);
  assert.equal(quarantinedRows[0].uuid, recoveryOperation.uuid);
  assert.deepEqual(quarantinedRows[0].payload, recoveryOperation.payload);
  assert.ok(persistedRows.some((row) => row.originOpId === "original-operation"));
  assert.equal(persistedRows.some((row) => row.uuid === "must-not-join"), false);
  assert.equal(changedView.annotationSourceMismatch, true);
  assert.equal(changedView.annotationHydrationAllowed, false);
  assert.deepEqual(app.vault.bytesByPath.get(changedView.file.path), changedBytes,
    "quarantined recovery never modifies the externally replaced PDF");
  assert.deepEqual(forbiddenSourceWrites, [], "recovery never invokes a PDF source write or serialization API");
  assert.equal([...shared.files.keys()].some((path) => path.endsWith(".pdf")), false);
  host.dispose();
});

test("idle maintenance compacts only after a safe matching probe and clears pending timers", async () => {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  const pendingHostTimers = new Set();
  const clearedHostTimers = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    let timer;
    timer = nativeSetTimeout(() => {
      pendingHostTimers.delete(timer);
      callback(...args);
    }, delay);
    if (delay === 1000 || delay === 2000) pendingHostTimers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (pendingHostTimers.delete(timer)) clearedHostTimers.push(timer);
    return nativeClearTimeout(timer);
  };

  let host;
  try {
    const { adapter } = makeAdapter();
    const app = makeApp(adapter);
    host = makeHost(app, "maintenance-device");
    const view = makeView(app, "Books/Maintenance.pdf");
    await initializeAndConfirm(host, view, ["4 0 R"]);

    const materializations = [];
    const originalMaterialize = host.store.materializeSnapshot.bind(host.store);
    host.store.materializeSnapshot = async (document) => {
      materializations.push(document.documentId);
      return originalMaterialize(document);
    };
    const operations = Array.from({ length: 256 }, (_, index) => ({
      uuid: `maintenance-${String(index).padStart(3, "0")}`,
      kind: "Square",
      pageIndex: 0,
      deleted: false,
      clock: { timestamp: 800 + index, logical: 0, deviceId: "maintenance-viewer", opId: `maintenance-op-${index}` },
      payload: { editor: { type: "square", rect: [index, 2, index + 10, 12] } },
    }));
    const save = {
      type: "save", documentId: view.documentId, openRequest: view.openRequest,
      requestId: "maintenance-busy-save", revision: 1, operations,
    };
    const waitForProbe = async (expectedProbeCount) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const probes = view.messages.filter((message) => message.type === "annotation-maintenance-probe");
        if (probes.length >= expectedProbeCount) return probes[expectedProbeCount - 1];
        await new Promise((resolve) => nativeSetTimeout(resolve, 10));
      }
      assert.fail(`timed out waiting for maintenance probe ${expectedProbeCount}`);
    };

    await host.handleMessage(view, save);
    const busyProbe = await waitForProbe(1);
    await host.handleMessage(view, {
      type: "annotation-maintenance-state", probeId: busyProbe.probeId,
      documentId: view.documentId, openRequest: view.openRequest, idle: false,
    });
    assert.deepEqual(materializations, [], "a busy Reader rejects idle maintenance");

    await host.handleMessage(view, { ...save, requestId: "maintenance-safe-save" });
    const safeProbe = await waitForProbe(2);
    await host.handleMessage(view, {
      type: "annotation-maintenance-state", probeId: safeProbe.probeId,
      documentId: view.documentId, openRequest: view.openRequest, idle: true,
    });
    assert.deepEqual(materializations, [view.documentId], "a matching idle reply permits materialization");
    const afterCompaction = await host.store.readEffective(view.annotationDocument);
    assert.equal(afterCompaction.valid.find((wal) => wal.deviceId === "maintenance-device").tail.length, 0,
      "the safe reply crosses the real tail-count compaction threshold");

    await host.handleMessage(view, { ...save, requestId: "maintenance-stale-probe-save" });
    const staleProbe = await waitForProbe(3);
    await host.handleMessage(view, {
      type: "annotation-maintenance-state", probeId: staleProbe.probeId,
      documentId: view.documentId, openRequest: view.openRequest + 1, idle: true,
    });
    assert.deepEqual(materializations, [view.documentId], "a reply for an obsolete view session is ignored");

    host.dispose();
    assert.ok(clearedHostTimers.length > 0, "dispose clears the outstanding maintenance expiry timer");
    assert.equal(pendingHostTimers.size, 0, "no tracked idle or expiry timer remains after dispose");
    const messageCount = view.messages.length;
    await new Promise((resolve) => nativeSetTimeout(resolve, 20));
    assert.equal(view.messages.length, messageCount, "disposed maintenance cannot post a late probe");

    const bridge = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
    const branchStart = bridge.indexOf('if (message.type === "annotation-maintenance-probe")');
    const branchEnd = bridge.indexOf('if (message.type === "external-annotations-update")', branchStart);
    assert.ok(branchStart >= 0 && branchEnd > branchStart, "the bridge has a bounded maintenance-probe branch");
    const branch = bridge.slice(branchStart, branchEnd);
    assert.match(branch, /document\.visibilityState\s*!==\s*"hidden"/,
      "background Reader views do not authorize maintenance");
    assert.match(branch, /!isEditBoundaryBusy\(\)/,
      "active input/edit-boundary work does not authorize maintenance");
    assert.match(branch, /!isDirty\(\)/,
      "unpersisted annotation edits do not authorize maintenance");
    assert.doesNotMatch(branch, /addEventListener\s*\(/,
      "the request/reply handshake adds no input listener");
  } finally {
    host?.dispose();
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});
