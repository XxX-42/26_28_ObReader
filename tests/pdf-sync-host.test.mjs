import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
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

function harness({ local = [1], dirty = false, operations = [], mergeResult = [3], failWrite = false, acquireHeavyLease = null, prepareIdentities = [], mergeIdentities = [], checkpointReadGate = null, autoApply = true } = {}) {
  let disk = bytes([1]);
  let nextId = 0;
  const stored = new Map();
  const records = [];
  const posted = [];
  const calls = { merge: [], writes: 0, prepare: 0, inspect: 0, inspectInputs: [], checkpointReads: 0, leases: [], leaseReleases: 0, baselines: [] };
  const file = { path: "only-test-vault.pdf", basename: "only-test-vault", extension: "pdf" };
  const adapter = {
    async exists(path) { if (path.endsWith(".json")) calls.checkpointReads += 1; if (checkpointReadGate) await checkpointReadGate(); return stored.has(path); }, async mkdir(path) { stored.set(path, true); },
    async read(path) { return stored.get(path); }, async write(path, value) { stored.set(path, value); },
    async readBinary(path) { if (!stored.has(path)) throw new Error("missing"); return bytes(stored.get(path)).buffer; },
    async writeBinary(path, value) { stored.set(path, bytes(value)); },
  };
  const client = {
    async prepareLocal(input) { calls.prepare += 1; return { bytes: bytes(input.draftBytes), identities: prepareIdentities, ledger: {} }; },
    async merge(input) { calls.merge.push(input); return { bytes: bytes(mergeResult), conflicts: [], identities: mergeIdentities, ledger: {} }; },
    async inspect(input) { calls.inspect += 1; calls.inspectInputs.push(input); return { identities: [], ledger: {} }; }, dispose() {},
  };
  const plugin = {
    manifest: { id: "pdf-web-reader" }, views: new Set(), saveQueue: Promise.resolve(),
    app: { vault: { configDir: ".obsidian", adapter,
      getAbstractFileByPath(path) { return path === file.path ? file : null; },
      async readBinary() { return disk.slice().buffer; },
      async modifyBinary(target, value) { assert.equal(target, file); calls.writes += 1; if (failWrite) throw new Error("injected disk failure"); disk = bytes(value); },
    } },
    enqueueSave(operation) { const promise = this.saveQueue.then(operation, operation); this.saveQueue = promise.catch(() => {}); return promise; },
    async acquireHeavyLease(view, target, reason, leaseId) {
      calls.leases.push({ view, target, reason, leaseId });
      if (acquireHeavyLease) return acquireHeavyLease(view, target, reason, leaseId);
      return { id: leaseId || `test-lease-${calls.leases.length}`, release() { calls.leaseReleases += 1; } };
    },
    setDocumentBaseline(_path, snapshot) { calls.baselines.push(snapshot); },
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
  const makeView = (documentId = "stable-document") => Object.assign(Object.create({
    syncState() { return { sdkViewState: true }; },
  }), {
    documentFile: file, file, ready: true, documentId, openRequest: 1, rendererGeneration: "renderer-a",
    originalBytes: bytes([1]), loadedBaseBytes: bytes([1]), currentRevision: dirty ? 2 : 0,
    confirmedRevision: 0, syncRequests: new Map(), status: "", rejectPrepare: false,
    syncCheckpointRejections: 0,
    captureSaveRequest() { return { file, documentId: this.documentId, openRequest: this.openRequest, originalBytes: this.originalBytes.slice(), filename: file.basename }; },
    isCurrentSaveRequest(captured) { return captured.documentId === this.documentId && captured.openRequest === this.openRequest; },
    setStatus(value) { this.status = value; },
    postToViewer(message, transfer = []) {
      const transferFields = transfer.map((buffer) =>
        Object.entries(message).find(([, value]) => value === buffer)?.[0] || null);
      const delivered = transfer.length ? structuredClone(message, { transfer }) : message;
      if (transferFields.length) delivered.transferFields = transferFields;
      posted.push(delivered);
      queueMicrotask(() => {
        let reply;
        const common = { id: delivered.id, documentId: delivered.documentId, openRequest: delivered.openRequest, rendererGeneration: delivered.rendererGeneration, revision: this.currentRevision, ok: true };
        if (delivered.type === "sync-checkpoint") {
          if (this.syncCheckpointRejections > 0) {
            this.syncCheckpointRejections -= 1;
            reply = { ...common, type: "sync-checkpoint-rejected", ok: false, reason: "save-in-progress" };
          } else {
            reply = { ...common, type: "sync-checkpoint-ready", data: bytes(local).buffer, dirty, operations, newAnnotations: [], actorId: "actor-a", viewState: { page: 2, scale: "page-width", rotation: 90, scrollLeft: 4, scrollTop: 180 } };
          }
        }
        if (delivered.type === "sync-apply-prepare") reply = { ...common, type: this.rejectPrepare ? "sync-apply-rejected" : "sync-apply-prepared", prepared: !this.rejectPrepare, ok: !this.rejectPrepare };
        if (delivered.type === "sync-apply" && autoApply) reply = { ...common, type: "sync-applied", openRequest: delivered.newOpenRequest, revision: 0 };
        if (reply) host.handleMessage(this, reply);
      });
      return true;
    },
  });
  const view = makeView();
  plugin.views.add(view);
  return { host, plugin, view, file, stored, records, posted, calls, makeView,
    setDisk(value) { disk = bytes(value); }, get disk() { return disk; } };
}

function captureApplyTimeout() {
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let captured;
  let timer;
  globalThis.setTimeout = (handler, delay, ...args) => {
    if (delay === 20000 && !captured) {
      captured = () => handler(...args);
      timer = nativeSetTimeout(() => {}, 60000);
      return timer;
    }
    return nativeSetTimeout(handler, delay, ...args);
  };
  return {
    fire() {
      assert.equal(typeof captured, "function", "the sync-apply timer was captured");
      nativeClearTimeout(timer);
      captured();
    },
    restore() { globalThis.setTimeout = nativeSetTimeout; },
  };
}

test("opening a Reader waits for the shared budget before reading PDF-sized checkpoints", async () => {
  let grant;
  const admitted = new Promise(resolve => { grant = resolve; });
  let released = 0;
  const h = harness({ acquireHeavyLease: () => admitted });
  const opening = h.host.initializeView(h.view, bytes([1]));
  await sleep(0);
  assert.equal(h.calls.checkpointReads, 0);
  grant({ id: "initialize", release() { released += 1; } });
  await opening;
  assert.equal(h.calls.checkpointReads, 1);
  assert.equal(released, 1);
  h.host.dispose();
});

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
    assert.deepEqual(Object.keys(h.calls.inspectInputs.at(-1)), ["bytes"],
      "inspect does not receive an unused second full-PDF snapshot");
    assert.equal(h.view.documentId, "stable-document");
    assert.equal(h.view.openRequest, 2);
    assert.deepEqual([...h.view.loadedBaseBytes], [2]);
    assert.equal(h.view.loadedBaseBytes, h.view.originalBytes,
      "a refreshed Viewer shares one immutable byte snapshot for both baselines");
    assert.equal(h.view.originalBytes, h.calls.baselines.at(-1));
    const apply = h.posted.find((m) => m.type === "sync-apply");
    assert.equal(apply.id, h.posted.find((m) => m.type === "sync-apply-prepare").id);
    assert.deepEqual(apply.transferFields, ["data"],
      "sync-apply transfers only its fresh byte buffer, leaving state snapshots attached");
    assert.deepEqual([...new Uint8Array(apply.data)], [2]);
    assert.deepEqual([...h.view.originalBytes], [2]);
    assert.deepEqual(apply.viewState, { page: 2, scale: "page-width", rotation: 90, scrollLeft: 4, scrollTop: 180 });
    assert.equal([...h.stored.keys()].filter((p) => p.includes(".sync-checkpoints")).length, 0);
    assert.ok(h.records.every((r) => !r.retained));
  } finally { h.host.dispose(); }
});

test("sync-apply timeout cancels Viewer work and keeps its lease until cancellation is acknowledged", async () => {
  const h = harness({ autoApply: false });
  let timer;
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    const releasesBefore = h.calls.leaseReleases;
    h.setDisk([2]);
    timer = captureApplyTimeout();
    h.host.schedule(h.file, "slow-sync-apply");
    await until(() => h.posted.some((message) => message.type === "sync-apply"));
    timer.restore();
    const apply = h.posted.find((message) => message.type === "sync-apply");
    const pending = h.view.syncRequests.get(apply.id);
    assert.ok(pending, "the apply request remains pending while Viewer parses");

    timer.fire();
    await until(() => h.posted.some((message) => message.type === "sync-apply-cancel"));
    const cancel = h.posted.find((message) => message.type === "sync-apply-cancel");
    assert.equal(cancel.id, apply.id);
    assert.equal(cancel.documentId, apply.documentId);
    assert.equal(cancel.openRequest, apply.openRequest, "cancellation targets the captured old open request");
    assert.equal(cancel.rendererGeneration, apply.rendererGeneration);
    assert.equal(h.view.syncRequests.has(apply.id), true);
    assert.equal(h.calls.leaseReleases, releasesBefore, "timeout does not release the heavy lease early");

    let closed = false;
    const closing = h.host.closeView(h.view).then(() => { closed = true; });
    await sleep(25);
    assert.equal(closed, false, "normal close also waits for Viewer cancellation to settle");
    h.host.handleMessage(h.view, {
      type: "sync-apply-cancelled", id: apply.id, documentId: apply.documentId,
      openRequest: apply.openRequest, rendererGeneration: apply.rendererGeneration, ok: true,
    });
    await closing;
    await until(() => h.calls.leaseReleases === releasesBefore + 1);
    assert.equal(h.view.syncRequests.has(apply.id), false);
    assert.deepEqual([...h.view.originalBytes], [1], "cancelled apply cannot advance the Viewer baseline");
  } finally {
    timer?.restore();
    h.host.dispose();
  }
});

test("sync-applied arriving after the timeout cancel wins as the terminal apply result", async () => {
  const h = harness({ autoApply: false });
  let timer;
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    const releasesBefore = h.calls.leaseReleases;
    h.setDisk([2]);
    timer = captureApplyTimeout();
    h.host.schedule(h.file, "late-sync-applied");
    await until(() => h.posted.some((message) => message.type === "sync-apply"));
    timer.restore();
    const apply = h.posted.find((message) => message.type === "sync-apply");

    timer.fire();
    await until(() => h.posted.some((message) => message.type === "sync-apply-cancel"));
    h.host.handleMessage(h.view, {
      type: "sync-applied", id: apply.id, documentId: apply.documentId,
      openRequest: apply.newOpenRequest, rendererGeneration: apply.rendererGeneration,
      revision: 3, ok: true,
    });
    await until(() => h.view.status.startsWith("已同步并刷新"));
    await until(() => h.calls.leaseReleases === releasesBefore + 1);
    assert.deepEqual([...h.view.originalBytes], [2]);
    assert.equal(h.view.openRequest, apply.newOpenRequest);
    assert.equal(h.view.currentRevision, 3);
    assert.equal(h.view.syncRequests.has(apply.id), false);
  } finally {
    timer?.restore();
    h.host.dispose();
  }
});

test("failed sync-apply cancellation keeps the lease until frame teardown forces settlement", async () => {
  const h = harness({ autoApply: false });
  let timer;
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    const releasesBefore = h.calls.leaseReleases;
    h.setDisk([2]);
    timer = captureApplyTimeout();
    h.host.schedule(h.file, "failed-sync-apply-cancel");
    await until(() => h.posted.some((message) => message.type === "sync-apply"));
    timer.restore();
    const apply = h.posted.find((message) => message.type === "sync-apply");
    timer.fire();
    await until(() => h.posted.some((message) => message.type === "sync-apply-cancel"));

    h.host.handleMessage(h.view, {
      type: "sync-apply-cancel-failed", id: apply.id, documentId: apply.documentId,
      openRequest: apply.openRequest, rendererGeneration: apply.rendererGeneration,
      reason: "PDF.js could not close the active loading task",
    });
    const pending = h.view.syncRequests.get(apply.id);
    assert.ok(pending, "a failed cancellation is a nonterminal response");
    assert.equal(h.calls.leaseReleases, releasesBefore);
    await assert.rejects(h.host.closeView(h.view), (error) =>
      error.code === "SYNC_APPLY_CANCEL_FAILED" && /could not close/.test(error.message));
    assert.equal(h.view.syncRequests.has(apply.id), true,
      "close reports failed cancellation without releasing the still-active apply");
    assert.equal(h.calls.leaseReleases, releasesBefore);

    // The explicit-close caller destroys the iframe before taking this force path.
    h.view.teardownStarted = true;
    await h.host.closeView(h.view, "Reader frame destroyed", { force: true });
    await until(() => h.calls.leaseReleases === releasesBefore + 1);
    assert.equal(h.view.syncRequests.has(apply.id), false);
    assert.deepEqual([...h.view.originalBytes], [1], "failed cancellation never advances the old baseline");
  } finally {
    timer?.restore();
    h.host.dispose();
  }
});

test("a save-in-progress checkpoint rejection releases and retries without waiting under the host save queue", async () => {
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
      "the rejected checkpoint is coalesced after the current reconciliation exits");

    await until(() => h.posted.filter((message) => message.type === "sync-checkpoint").length === 2);
    assert.equal(h.view.status.startsWith("同步暂停"), false,
      "reconciliation does not wait for a save queue while holding the heavy lease");
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
    assert.equal(h.view.originalBytes, h.calls.baselines.at(-1),
      "the Viewer and host baseline reuse the immutable confirmed checkpoint");
    assert.equal(h.calls.inspect, 0, "prepareLocal metadata is reused when no external merge is needed");
    assert.equal(Object.hasOwn(h.view, "syncState"), false);
    assert.equal(typeof h.view.syncState, "function");
    assert.deepEqual(h.view.syncState(), { sdkViewState: true });
    h.calls.merge.length = 0;
    h.setDisk([5]); h.host.schedule(h.file, "peer-after-save");
    await until(() => h.view.status.startsWith("已同步"));
    assert.ok(h.calls.merge.some((call) => eq(call.localBytes, bytes([4]))), "confirmed local branch must remain in merge input");
    assert.equal(h.calls.inspect, 0, "metadata returned by merge is reused for the refreshed Viewer");
    assert.deepEqual([...h.disk], [8]);
    assert.equal(h.view.confirmedRevision, 0);
    assert.ok([...h.stored.keys()].some((key) => key.endsWith(".base.pdf")));
  } finally { h.host.dispose(); }
});

test("save restores runtime annotation IDs by UUID after merge metadata is returned", async () => {
  const h = harness({
    local: [4], mergeResult: [6],
    prepareIdentities: [{ uuid: "annotation-uuid", runtimeId: "viewer-runtime-id" }],
    mergeIdentities: [{ uuid: "annotation-uuid" }],
  });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([5]);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-uuid" }],
      revision: 1, requestId: "save-runtime-id",
    });
    assert.equal(h.view.annotationSyncState.identities[0].runtimeId, "viewer-runtime-id");
    assert.deepEqual([...h.disk], [6]);
  } finally { h.host.dispose(); }
});

test("sync host reads cross-realm byte buffers without taking ownership", async () => {
  const h = harness();
  const foreign = runInNewContext("new Uint8Array([4])");
  const foreignBuffer = foreign.buffer;
  try {
    await h.host.initializeView(h.view, foreign);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: foreignBuffer, actorId: "actor-a", operations: [], revision: 1, requestId: "save-cross-realm",
    });
    assert.deepEqual([...new Uint8Array(foreignBuffer)], [4]);
    assert.deepEqual([...h.disk], [4]);
  } finally { h.host.dispose(); }
});

test("last-reader release clears cached bytes, preserves checkpoint files, and forces verification on reload", async () => {
  const h = harness();
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1, requestId: "save-release",
    });
    h.view.ready = false;
    const checkpointFiles = [...h.stored.keys()].filter((key) => key.includes(".sync-checkpoints"));
    const manifestPath = checkpointFiles.find((key) => key.endsWith(".json"));
    assert.ok(manifestPath);
    const readsBeforePeer = h.calls.checkpointReads;

    const peer = h.makeView("peer-document");
    peer.ready = false;
    peer.originalBytes = bytes([4]);
    peer.loadedBaseBytes = bytes([4]);
    h.plugin.views.add(peer);
    h.plugin.views.delete(h.view);
    h.host.releaseView(h.view, h.file);
    await h.host.initializeView(peer, peer.originalBytes);
    assert.equal(h.calls.checkpointReads, readsBeforePeer,
      "closing one Reader leaves the shared file state while another Reader remains");

    h.plugin.views.delete(peer);
    h.host.releaseView(peer, h.file);
    assert.ok(checkpointFiles.every((key) => h.stored.has(key)),
      "release only clears memory and leaves persisted recovery state intact");

    const manifest = JSON.parse(h.stored.get(manifestPath));
    manifest.hash = "invalid-after-close";
    h.stored.set(manifestPath, JSON.stringify(manifest));
    const reopened = h.makeView("reopened-document");
    reopened.ready = false;
    h.plugin.views.add(reopened);
    await h.host.initializeView(reopened, reopened.originalBytes);
    assert.equal(h.calls.checkpointReads, readsBeforePeer + 1,
      "a later open rereads and verifies the on-disk checkpoint");
    assert.match(reopened.status, /^同步暂停/);
    assert.ok(checkpointFiles.every((key) => h.stored.has(key)));
  } finally { h.host.dispose(); }
});

test("a Reader reopened on the same file survives settlement of its prior released session", async () => {
  let unblockCheckpointRead;
  const checkpointReadGate = new Promise((resolve) => { unblockCheckpointRead = resolve; });
  const h = harness({ checkpointReadGate: () => checkpointReadGate });
  try {
    const firstInitialization = h.host.initializeView(h.view, h.view.originalBytes);
    await until(() => h.calls.checkpointReads === 1);

    h.plugin.views.delete(h.view);
    h.view.documentFile = { path: "temporary-other.pdf", extension: "pdf" };
    h.host.releaseView(h.view, h.file);
    h.view.documentFile = h.file;
    h.plugin.views.add(h.view);
    const reopenedInitialization = h.host.initializeView(h.view, h.view.originalBytes);
    assert.equal(h.calls.checkpointReads, 1, "the reopened session joins the existing pending load");

    unblockCheckpointRead();
    await Promise.all([firstInitialization, reopenedInitialization]);
    await h.host.initializeView(h.view, h.view.originalBytes);
    assert.equal(h.calls.checkpointReads, 1,
      "the old session's settle does not discard the new session's loaded state");
  } finally {
    unblockCheckpointRead();
    h.host.dispose();
  }
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
