import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfSyncHost } = require("../plugin/pdf-sync-host.cjs");
const bytes = (value) => new Uint8Array(value instanceof ArrayBuffer ? value : value).slice();
const eq = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const hash = (a) => createHash("sha256").update(a).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() > deadline) throw new Error("host condition timed out"); await sleep(15); }
}

function harness({ local = [1], dirty = false, operations = [], mergeResult = [3], failWrite = false } = {}) {
  let disk = bytes([1]);
  let nextId = 0;
  const stored = new Map();
  const records = [];
  const posted = [];
  const calls = { merge: [], writes: 0, prepare: 0 };
  const file = { path: "only-test-vault.pdf", basename: "only-test-vault", extension: "pdf" };
  const adapter = {
    async exists(path) { return stored.has(path); }, async mkdir(path) { stored.set(path, true); },
    async read(path) { return stored.get(path); }, async write(path, value) { stored.set(path, value); },
    async readBinary(path) { if (!stored.has(path)) throw new Error("missing"); return bytes(stored.get(path)).buffer; },
    async writeBinary(path, value) { stored.set(path, bytes(value)); },
  };
  const client = {
    async prepareLocal(input) { calls.prepare += 1; return { bytes: bytes(input.draftBytes), identities: [], ledger: {} }; },
    async merge(input) { calls.merge.push(input); return { bytes: bytes(mergeResult), conflicts: [] }; },
    async inspect() { return { identities: [], ledger: {} }; }, dispose() {},
  };
  const plugin = {
    manifest: { id: "pdf-web-reader" }, views: new Set(), saveQueue: Promise.resolve(),
    app: { vault: { configDir: ".obsidian", adapter,
      getAbstractFileByPath(path) { return path === file.path ? file : null; },
      async readBinary() { return disk.slice().buffer; },
      async modifyBinary(target, value) { assert.equal(target, file); calls.writes += 1; if (failWrite) throw new Error("injected disk failure"); disk = bytes(value); },
    } },
    enqueueSave(operation) { const promise = this.saveQueue.then(operation, operation); this.saveQueue = promise.catch(() => {}); return promise; },
    setDocumentBaseline() {},
    async writeRecoveryCandidate(input) { const record = { ...input, metadata: { status: input.status }, retained: true }; records.push(record); return record; },
    async markRecoveryCandidate(record, value) { Object.assign(record.metadata, value); },
    async removeRecoveryCandidate(record) { record.retained = false; }, restoreLatestRecovery() {},
  };
  const host = createPdfSyncHost(plugin, {
    createPdfMergeClient: () => client, sha256Bytes: hash, normalizePath: (v) => v,
    isPdfFile: (f) => f?.extension === "pdf", bytesEqual: eq,
    toArrayBuffer: (v) => bytes(v).buffer, makeToken: () => `test-actor-${++nextId}`,
    ensureAdapterDirectory: async () => {}, Notice: class {},
  });
  const view = Object.assign(Object.create({
    syncState() { return { sdkViewState: true }; },
  }), {
    documentFile: file, file, ready: true, documentId: "stable-document", openRequest: 1, rendererGeneration: "renderer-a",
    originalBytes: bytes([1]), loadedBaseBytes: bytes([1]), currentRevision: dirty ? 2 : 0,
    confirmedRevision: 0, syncRequests: new Map(), status: "", rejectPrepare: false,
    syncCheckpointRejections: 0,
    captureSaveRequest() { return { file, documentId: this.documentId, openRequest: this.openRequest, originalBytes: this.originalBytes.slice(), filename: file.basename }; },
    isCurrentSaveRequest(captured) { return captured.documentId === this.documentId && captured.openRequest === this.openRequest; },
    setStatus(value) { this.status = value; },
    postToViewer(message) {
      posted.push(message);
      queueMicrotask(() => {
        let reply;
        const common = { id: message.id, documentId: message.documentId, openRequest: message.openRequest, rendererGeneration: message.rendererGeneration, revision: this.currentRevision, ok: true };
        if (message.type === "sync-checkpoint") {
          if (this.syncCheckpointRejections > 0) {
            this.syncCheckpointRejections -= 1;
            reply = { ...common, type: "sync-checkpoint-rejected", ok: false, reason: "save-in-progress" };
          } else {
            reply = { ...common, type: "sync-checkpoint-ready", data: bytes(local).buffer, dirty, operations, newAnnotations: [], actorId: "actor-a", viewState: { page: 2, scale: "page-width", rotation: 90, scrollLeft: 4, scrollTop: 180 } };
          }
        }
        if (message.type === "sync-apply-prepare") reply = { ...common, type: this.rejectPrepare ? "sync-apply-rejected" : "sync-apply-prepared", prepared: !this.rejectPrepare, ok: !this.rejectPrepare };
        if (message.type === "sync-apply") reply = { ...common, type: "sync-applied", openRequest: message.newOpenRequest, revision: 0 };
        if (reply) host.handleMessage(this, reply);
      });
      return true;
    },
  });
  plugin.views.add(view);
  return { host, plugin, view, file, stored, records, posted, calls,
    setDisk(value) { disk = bytes(value); }, get disk() { return disk; } };
}

test("clean external modification refreshes the same Viewer without migrating or writing the PDF", async () => {
  const h = harness();
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.host.schedule(h.file, "own-event");
    await sleep(190);
    assert.equal(h.posted.length, 0);
    h.setDisk([2]); h.host.schedule(h.file, "modify"); h.host.schedule(h.file, "duplicate-modify");
    await until(() => h.view.status.startsWith("已同步"));
    assert.equal(h.calls.prepare, 0);
    assert.equal(h.calls.merge.length, 0);
    assert.equal(h.calls.writes, 0);
    assert.equal(h.view.documentId, "stable-document");
    assert.equal(h.view.openRequest, 2);
    assert.deepEqual([...h.view.loadedBaseBytes], [2]);
    const apply = h.posted.find((m) => m.type === "sync-apply");
    assert.equal(apply.id, h.posted.find((m) => m.type === "sync-apply-prepare").id);
    assert.deepEqual(apply.viewState, { page: 2, scale: "page-width", rotation: 90, scrollLeft: 4, scrollTop: 180 });
    assert.equal([...h.stored.keys()].filter((p) => p.includes(".sync-checkpoints")).length, 0);
    assert.ok(h.records.every((r) => !r.retained));
  } finally { h.host.dispose(); }
});

test("a save-in-progress checkpoint rejection waits for the host save queue and retries without pausing", async () => {
  const h = harness();
  let releaseSaveQueue;
  h.plugin.saveQueue = new Promise((resolve) => { releaseSaveQueue = resolve; });
  h.view.syncCheckpointRejections = 1;
  h.setDisk([2]);
  h.host.schedule(h.file, "modify-during-save");
  try {
    await until(() => h.posted.some((message) => message.type === "sync-checkpoint"));
    await sleep(30);
    assert.equal(h.view.status.startsWith("同步暂停"), false);
    assert.equal(h.posted.filter((message) => message.type === "sync-checkpoint").length, 1,
      "the rejected checkpoint is deferred until the active save queue settles");

    releaseSaveQueue();
    await until(() => h.view.status.startsWith("已同步并刷新"));
    assert.equal(h.view.openRequest, 2);
    assert.equal(h.view.status.startsWith("同步暂停"), false);
    assert.equal(h.calls.writes, 0);
    assert.equal(h.posted.filter((message) => message.type === "sync-checkpoint").length, 2);
  } finally {
    releaseSaveQueue();
    h.host.dispose();
  }
});

test("an already confirmed local checkpoint participates when an older peer version replaces disk", async () => {
  const h = harness({ local: [4], operations: [{ uuid: "annotation-a" }], mergeResult: [8] });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), { data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-a" }], revision: 1, requestId: "save-a" });
    assert.deepEqual([...h.disk], [4]);
    assert.equal(Object.hasOwn(h.view, "syncState"), false);
    assert.equal(typeof h.view.syncState, "function");
    assert.deepEqual(h.view.syncState(), { sdkViewState: true });
    h.calls.merge.length = 0;
    h.setDisk([5]); h.host.schedule(h.file, "peer-after-save");
    await until(() => h.view.status.startsWith("已同步"));
    assert.ok(h.calls.merge.some((call) => eq(call.localBytes, bytes([4]))), "confirmed local branch must remain in merge input");
    assert.deepEqual([...h.disk], [8]);
    assert.equal(h.view.confirmedRevision, 0);
    assert.ok([...h.stored.keys()].some((key) => key.endsWith(".base.pdf")));
  } finally { h.host.dispose(); }
});

test("a revision changed during merge rejects application and leaves disk and Viewer intact", async () => {
  const h = harness({ local: [4], dirty: true, operations: [{ uuid: "annotation-a" }] });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.view.rejectPrepare = true;
    h.setDisk([5]); h.host.schedule(h.file, "modify");
    await until(() => h.posted.some((m) => m.type === "sync-apply-prepare"));
    await sleep(20); h.host.dispose();
    assert.deepEqual([...h.disk], [5]);
    assert.deepEqual([...h.view.originalBytes], [1]);
    assert.equal(h.calls.writes, 0);
    assert.equal(h.posted.filter((m) => m.type === "sync-apply").length, 0);
  } finally { h.host.dispose(); }
});

test("write failure retains the pending branch and prevents subsequent automatic overwrites", async () => {
  const h = harness({ local: [4], dirty: true, operations: [{ uuid: "annotation-a" }], failWrite: true });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([5]); h.host.schedule(h.file, "modify");
    await until(() => h.view.status.startsWith("同步暂停"));
    assert.deepEqual([...h.disk], [5]);
    assert.ok(h.records.some((r) => r.retained && r.metadata.status === "conflict"));
    assert.ok([...h.stored.keys()].some((key) => key.endsWith(".pdf")));
    const writes = h.calls.writes;
    h.host.schedule(h.file, "repeat"); await sleep(190);
    assert.equal(h.calls.writes, writes);
    assert.equal(h.posted.filter((m) => m.type === "sync-apply").length, 0);
  } finally { h.host.dispose(); }
});

test("a queued save keeps captured recovery identity when its Reader selects another PDF", async () => {
  const h = harness({ operations: [{ uuid: "annotation-a" }] });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  h.plugin.saveQueue = blocked;
  const captured = h.view.captureSaveRequest();
  const save = h.host.save(h.view, captured, { data: bytes([4]).buffer, actorId: "actor-a", revision: 1 });
  h.view.documentId = "different-document";
  h.view.documentFile = { path: "different.pdf", extension: "pdf" };
  h.view.originalBytes = bytes([9]);
  try {
    release();
    await assert.rejects(save, /切换/);
    assert.equal(h.calls.writes, 0);
    assert.deepEqual([...h.view.originalBytes], [9]);
    const record = h.records[0];
    assert.equal(record.documentId, "stable-document");
    assert.equal(record.documentPath, h.file.path);
    assert.deepEqual([...record.originalBytes], [1]);
    assert.ok(record.retained);
  } finally { release(); h.host.dispose(); }
});

test("unload aborts a queued original-file write and leaves its recovery branch intact", async () => {
  const h = harness();
  let release;
  h.plugin.saveQueue = new Promise((resolve) => { release = resolve; });
  const save = h.host.save(h.view, h.view.captureSaveRequest(), { data: bytes([4]).buffer, actorId: "actor-a", revision: 1 });
  h.plugin.isUnloading = true;
  h.host.dispose(); release();
  await assert.rejects(save, /卸载/);
  assert.equal(h.calls.writes, 0);
  assert.ok(h.records.some((record) => record.retained));
});
