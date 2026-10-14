import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfSyncHost } = require("../plugin/pdf-sync-host.cjs");
const { createHeavyWorkCoordinator } = require("../plugin/heavy-work.cjs");
const { writeDeltaRecovery, readDeltaRecovery } = require("../plugin/pdf-recovery.cjs");
const bytes = (value) => new Uint8Array(value instanceof ArrayBuffer ? value : value).slice();
const eq = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const hash = (a) => createHash("sha256").update(a).digest("hex");
const journalManifestPath = (filePath) =>
  `.obsidian/plugins/pdf-web-reader/.sync-checkpoints/${hash(new TextEncoder().encode(filePath))}.json`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 2500;
  while (!check()) { if (Date.now() > deadline) throw new Error("host condition timed out"); await sleep(15); }
}

function harness({ local = [1], dirty = false, operations = [], mergeResult = [3], failWrite = false,
  appendPatch = null, appendFailure = null, acquireHeavyLease = null, prepareIdentities = [],
  mergeIdentities = [], prepareLedger = {}, mergeLedger = {}, mergePatch = null, prepareFailure = null,
  checkpointReadGate = null, autoApply = true, replaceFileOnRead = null,
  removeFileOnRead = null, modifyGate = null, appendGate = null,
  mutateDiskOnRead = null, mutateDiskValue = null, acquireCloseWritebackLease = null } = {}) {
  let disk = bytes([1]);
  let nextId = 0;
  let activeFile = null;
  let diskReadCount = 0;
  const stored = new Map();
  const documentBaselines = new Map();
  const records = [];
  const posted = [];
  const calls = { merge: [], writes: 0, appends: 0, prepare: 0, prepareInputs: [], inspect: 0, inspectInputs: [], checkpointReads: 0, leases: [], leaseReleases: 0, closeLeases: [], closeLeaseReleases: 0, events: [], baselines: [], performance: [] };
  const file = { path: "only-test-vault.pdf", basename: "only-test-vault", extension: "pdf" };
  activeFile = file;
  const adapter = {
    async exists(path) { if (path.endsWith(".json")) calls.checkpointReads += 1; if (checkpointReadGate) await checkpointReadGate(); return stored.has(path); }, async mkdir(path) { stored.set(path, true); },
    async read(path) { return stored.get(path); }, async write(path, value) {
      stored.set(path, value);
      const record = records.find((item) => item.metadataPath === path);
      if (record && typeof value === "string") record.metadata = JSON.parse(value);
    },
    async readBinary(path) { if (!stored.has(path)) throw new Error("missing"); return bytes(stored.get(path)).buffer; },
    async writeBinary(path, value) { stored.set(path, bytes(value)); },
    async remove(path) { stored.delete(path); },
    async list(path) { return { files: [...stored.keys()].filter((entry) => entry.startsWith(`${path}/`)), folders: [] }; },
  };
  const client = {
    async prepareLocal(input) {
      calls.prepare += 1;
      calls.prepareInputs.push(input);
      if (prepareFailure) throw prepareFailure;
      const prepared = typeof appendPatch === "function"
        ? appendPatch(input, calls.prepare)
        : appendPatch;
      return { bytes: bytes(prepared?.bytes || input.draftBytes), patch: prepared?.patch || null, identities: prepareIdentities, ledger: prepareLedger };
    },
    async merge(input) {
      calls.merge.push(input);
      const configured = typeof mergeResult === "function"
        ? await mergeResult(input, calls.merge.length)
        : mergeResult;
      if (configured && typeof configured === "object" && !Array.isArray(configured) && !ArrayBuffer.isView(configured)) {
        return { conflicts: [], identities: mergeIdentities, ledger: mergeLedger, ...configured };
      }
      const result = { conflicts: [], identities: mergeIdentities, ledger: mergeLedger };
      if (!mergePatch?.omitBytes) result.bytes = bytes(mergePatch?.bytes || configured);
      if (mergePatch?.patch) result.patch = mergePatch.patch;
      return result;
    },
    async inspect(input) { calls.inspect += 1; calls.inspectInputs.push(input); return { identities: [], ledger: {} }; }, dispose() {},
  };
  const plugin = {
    manifest: { id: "pdf-web-reader" }, views: new Set(), saveQueue: Promise.resolve(),
    sessionLog: { record(type, value) { if (type === "performance") calls.performance.push(value); } },
    recoveryDirectory: ".obsidian/plugins/pdf-web-reader/.recovery",
    closeWritebackJobs: new Map(),
    app: { vault: { configDir: ".obsidian", adapter,
      getAbstractFileByPath(path) { return path === file.path ? activeFile : null; },
      async readBinary() {
        diskReadCount += 1;
        if (diskReadCount === replaceFileOnRead) activeFile = { ...file };
        if (diskReadCount === removeFileOnRead) activeFile = null;
        if (diskReadCount === mutateDiskOnRead && mutateDiskValue) disk = bytes(mutateDiskValue);
        return disk.slice().buffer;
      },
      async modifyBinary(target, value) { assert.equal(target, activeFile); calls.writes += 1; if (modifyGate) await modifyGate(); if (failWrite) throw new Error("injected disk failure"); disk = bytes(value); },
      async appendBinary(target, value) {
        assert.equal(target, activeFile);
        calls.appends += 1;
        if (appendGate) await appendGate();
        const suffix = bytes(value);
        const failure = typeof appendFailure === "function"
          ? appendFailure(calls.appends)
          : appendFailure;
        if (failure === "partial") {
          disk = Uint8Array.from([...disk, ...suffix.slice(0, 1)]);
          throw new Error("injected interrupted append");
        }
        if (failure === "before") throw new Error("injected append failure");
        disk = Uint8Array.from([...disk, ...suffix]);
      },
    } },
    enqueueSave(operation) { calls.events.push("enqueue-save"); const promise = this.saveQueue.then(operation, operation); this.saveQueue = promise.catch(() => {}); return promise; },
    async acquireHeavyLease(view, target, reason, leaseId) {
      calls.leases.push({ view, target, reason, leaseId });
      if (acquireHeavyLease) return acquireHeavyLease(view, target, reason, leaseId);
      return { id: leaseId || `test-lease-${calls.leases.length}`, release() { calls.leaseReleases += 1; } };
    },
    async acquireCloseWritebackLease(owner, target, intent, targetPath) {
      calls.events.push("close-heavy-lease");
      calls.closeLeases.push({ owner, target, intent, targetPath });
      if (acquireCloseWritebackLease) return acquireCloseWritebackLease(owner, target, intent, targetPath);
      return { id: `close-lease-${calls.closeLeases.length}`, release() { calls.closeLeaseReleases += 1; } };
    },
    setDocumentBaseline(path, snapshot) {
      calls.baselines.push(snapshot);
      documentBaselines.set(path, bytes(snapshot));
    },
    releaseDocumentBaseline(path, leavingView) {
      const stillOpen = [...this.views].some((view) =>
        view !== leavingView && !view.teardownStarted && view.openAcknowledged !== false &&
        (view.requestedPath || (view.documentFile || view.file)?.path) === path);
      if (!stillOpen) documentBaselines.delete(path);
    },
    async writeRecoveryCandidate(input) {
      const source = bytes(input.data);
      const createdAt = new Date().toISOString();
      const id = `test-recovery-${records.length + 1}`;
      const record = { ...input, data: source, candidatePath: `${id}.pdf`, metadataPath: `${id}.json`,
        metadata: { schema: 1, candidateId: id, candidateFile: `${id}.pdf`, documentId: input.documentId,
          originalPath: input.documentPath, filename: input.filename, requestId: input.requestId,
          openRequest: input.openRequest, revision: input.revision, origin: input.origin, reason: input.reason,
          baseFingerprint: hash(bytes(input.originalBytes)), createdAt, updatedAt: createdAt,
          status: input.status, completed: true, outputHash: hash(source), outputLength: source.byteLength },
        retained: true };
      records.push(record);
      stored.set(record.metadataPath, `${JSON.stringify(record.metadata, null, 2)}\n`);
      stored.set(record.candidatePath, source.slice());
      return record;
    },
    async markRecoveryCandidate(record, value) {
      const durable = records.find((item) => item.metadata.candidateId === record?.metadata?.candidateId) || record;
      Object.assign(durable.metadata, value, { updatedAt: new Date().toISOString() });
      record.metadata = durable.metadata;
      stored.set(durable.metadataPath, `${JSON.stringify(durable.metadata, null, 2)}\n`);
    },
    async removeRecoveryCandidate(record) {
      const durable = records.find((item) => item.metadata.candidateId === record?.metadata?.candidateId) || record;
      durable.retained = false;
      record.retained = false;
    }, restoreLatestRecovery() {},
    async listRecoveryCandidates() {
      return records.filter((record) => record.retained).map((record) => {
        const metadata = JSON.parse(stored.get(record.metadataPath) || JSON.stringify(record.metadata));
        record.metadata = metadata;
        return { candidatePath: record.candidatePath, metadataPath: record.metadataPath, metadata };
      });
    },
    async readRecoveryBytes(candidate) {
      const record = records.find((item) => item.metadata.candidateId === candidate?.metadata?.candidateId);
      if (!record) throw new Error("missing recovery candidate");
      return record.data.slice().buffer;
    },
    updateCloseWritebackStatus(job) {
      this.closeWritebackJobs.set(job.jobId, { ...job });
    },
  };
  const createHost = () => createPdfSyncHost(plugin, {
    createPdfMergeClient: () => client, sha256Bytes: hash, normalizePath: (v) => v,
    isPdfFile: (f) => f?.extension === "pdf", bytesEqual: eq,
    toArrayBuffer: (v) => bytes(v).buffer, makeToken: () => `test-actor-${++nextId}`,
    ensureAdapterDirectory: async (target, path) => target.mkdir(path), Notice: class {},
  });
  let host = createHost();
  const makeView = (documentId = "stable-document", targetFile = file) => Object.assign(Object.create({
    syncState() { return { sdkViewState: true }; },
  }), {
    documentFile: targetFile, file: targetFile, ready: true, documentId, openRequest: 1, rendererGeneration: "renderer-a",
    originalBytes: bytes([1]), loadedBaseBytes: bytes([1]), currentRevision: dirty ? 2 : 0,
    confirmedRevision: 0, syncRequests: new Map(), status: "", rejectPrepare: false,
    syncCheckpointRejections: 0, syncNeedsRefresh: false,
    captureSaveRequest() { return { file: targetFile, documentId: this.documentId, openRequest: this.openRequest, rendererGeneration: this.rendererGeneration, originalBytes: this.originalBytes.slice(), filename: targetFile.basename }; },
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
  return { get host() { return host; }, plugin, adapter, view, file, stored, records, posted, calls, documentBaselines, makeView,
    setDisk(value) { disk = bytes(value); }, get disk() { return disk; },
    get activeFile() { return activeFile; },
    restartHost() { host.dispose(); host = createHost(); return host; } };
}

async function createCloseRecovery(h, {
  draft = [1, 2], base = [1], documentId = "close-session-a", openRequest = 1,
  revision = 1, requestId = `close-request-${revision}`, originalPath = h.file.path,
  reason = "close-writeback", attachIntent = true, createdAt = new Date().toISOString(),
  operations = [], newAnnotations = [],
} = {}) {
  const baseBytes = bytes(base);
  const data = bytes(draft);
  const record = await h.plugin.writeRecoveryCandidate({
    view: h.view, documentId, filename: "only-test-vault.pdf", data,
    originalBytes: baseBytes, documentPath: originalPath, openRequest, revision,
    origin: "recovery", requestId, reason, status: "draft",
  });
  record.metadata.createdAt = createdAt;
  record.metadata.updatedAt = createdAt;
  if (attachIntent) {
    const baseHash = hash(baseBytes);
    const baseFile = `.bases/${baseHash}.pdf`;
    h.stored.set(`${h.plugin.recoveryDirectory}/${baseFile}`, baseBytes.slice());
    record.metadata.closeWriteback = {
      schema: 1,
      jobId: record.metadata.candidateId,
      documentId,
      originalPath,
      filename: "only-test-vault.pdf",
      openRequest,
      revision,
      requestId,
      actorId: "actor-close-123",
      base: { file: baseFile, hash: baseHash, length: baseBytes.byteLength },
      draft: { hash: record.metadata.outputHash, length: record.metadata.outputLength },
      operations,
      newAnnotations,
      phase: "queued",
      status: "queued",
      createdAt,
      updatedAt: createdAt,
    };
  }
  h.stored.set(record.metadataPath, `${JSON.stringify(record.metadata, null, 2)}\n`);
  return record;
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
      "external refresh inspection receives one owned PDF snapshot");
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

test("a clean close intent does not allocate a duplicate full-PDF checkpoint", async () => {
  const h = harness();
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    const checkpointReads = h.calls.checkpointReads;
    const postedBefore = h.posted.length;
    assert.equal(await h.host.prepareClose(h.view), true);
    assert.equal(h.posted.length, postedBefore,
      "closing a clean Viewer should not serialize or copy another PDF");
    assert.equal(h.calls.checkpointReads, checkpointReads);
    assert.equal(h.view.syncRequests.size, 0);
  } finally {
    h.host.dispose();
  }
});

test("close intent cancels a queued reconcile lease without releasing accepted work", async () => {
  const h = harness();
  const coordinator = createHeavyWorkCoordinator({ enabled: () => true, makeId: (() => { let id = 0; return () => `lease-${++id}`; })() });
  assert.equal(typeof coordinator.cancelQueued, "function",
    "the shared work coordinator exposes a safe queued-only cancellation path");
  const blockerOwner = {};
  let reconcileQueued;
  const queued = new Promise((resolve) => { reconcileQueued = resolve; });
  let cancelledReason = null;
  const cancelQueued = coordinator.cancelQueued?.bind(coordinator);
  if (cancelQueued) {
    coordinator.cancelQueued = (owner, options) => {
      if (owner === h.view) cancelledReason = options?.reason;
      return cancelQueued(owner, options);
    };
  }
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.plugin.heavyWork = coordinator;
    h.plugin.acquireHeavyLease = (view, target, reason, leaseId = null, requestId = null) => {
      const context = {
        file: target,
        reason,
        documentId: view.documentId,
        openRequest: view.openRequest,
        rendererGeneration: view.rendererGeneration,
      };
      if (leaseId) return Promise.resolve(coordinator.borrow(view, context, leaseId));
      if (reason === "sync-reconcile") reconcileQueued();
      return coordinator.acquire(view, context, {
        requestId,
        valid: () => view.documentId === context.documentId &&
          view.openRequest === context.openRequest && view.rendererGeneration === context.rendererGeneration,
      });
    };
    const blocker = await coordinator.acquire(blockerOwner, {
      file: {}, reason: "blocker", documentId: "blocker", openRequest: 1, rendererGeneration: "blocker",
    });
    h.setDisk([2]);
    h.host.schedule(h.file, "queue-close-reconcile");
    await queued;

    assert.equal(await h.host.prepareClose(h.view), true,
      "the close waits only until its queued reconciliation is canceled");
    assert.equal(cancelledReason, "sync-reconcile");
    assert.equal(h.posted.some((message) => message.type === "sync-checkpoint"), false,
      "a queued reconcile never starts Viewer serialization after close intent");
    assert.equal(h.view.status, "", "expected close cancellation does not pause sync");

    blocker.release();
    assert.equal(h.host.resumeClose(h.view), true);
    await until(() => h.posted.some((message) => message.type === "sync-apply"));
    await until(() => h.view.status.startsWith("已同步并刷新"));
    assert.deepEqual([...h.view.originalBytes], [2],
      "after an uncommitted close the queued sync can acquire the slot and refresh normally");
  } finally {
    coordinator.dispose();
    h.host.dispose();
  }
});

test("close intent waits for one active PDF checkpoint and prevents a follow-up apply", async () => {
  const h = harness();
  let heldCheckpoint = null;
  const originalPost = h.view.postToViewer;
  h.view.postToViewer = function (message, transfer = []) {
    if (message.type === "sync-checkpoint") {
      h.posted.push(message);
      heldCheckpoint = message;
      return true;
    }
    return originalPost.call(this, message, transfer);
  };
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([2]);
    h.host.schedule(h.file, "close-during-checkpoint");
    await until(() => heldCheckpoint !== null);

    let closed = false;
    const closing = h.host.prepareClose(h.view).then((result) => {
      closed = true;
      return result;
    });
    await sleep(25);
    assert.equal(closed, false, "the close waits for PDF.js serialization to settle safely");
    assert.equal(h.posted.filter((message) => message.type === "sync-checkpoint").length, 1,
      "the close must not start a second checkpoint");

    h.host.handleMessage(h.view, {
      type: "sync-checkpoint-ready",
      id: heldCheckpoint.id,
      documentId: heldCheckpoint.documentId,
      openRequest: heldCheckpoint.openRequest,
      rendererGeneration: heldCheckpoint.rendererGeneration,
      revision: 0,
      ok: true,
      dirty: false,
      data: bytes([1]).buffer,
      operations: [],
      newAnnotations: [],
      viewState: {},
    });
    assert.equal(await closing, true);
    assert.equal(h.posted.some((message) => message.type === "sync-apply-prepare"), false,
      "close intent stops reconciliation after the already-running checkpoint");
    assert.equal(h.calls.leaseReleases, 2,
      "the reconciliation lease is released before the close boundary proceeds");
  } finally {
    h.host.dispose();
  }
});

test("close intent cancels an already prepared apply and retains the recovery draft", async () => {
  const h = harness({ local: [3], dirty: true, autoApply: false, mergeResult: [3] });
  let heldPrepare = null;
  const originalPost = h.view.postToViewer;
  h.view.postToViewer = function (message, transfer = []) {
    if (message.type === "sync-apply-prepare") {
      h.posted.push(message);
      heldPrepare = message;
      return true;
    }
    return originalPost.call(this, message, transfer);
  };
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([2]);
    h.host.schedule(h.file, "close-during-prepared-apply");
    await until(() => heldPrepare !== null);
    const prepare = heldPrepare;

    let closed = false;
    const closing = h.host.prepareClose(h.view).then((result) => {
      closed = true;
      return result;
    });
    await until(() => h.posted.some((message) =>
      message.type === "sync-apply-cancel" && message.id === prepare.id));
    assert.equal(closed, false);
    h.host.handleMessage(h.view, {
      type: "sync-apply-cancelled",
      id: prepare.id,
      documentId: prepare.documentId,
      openRequest: prepare.openRequest,
      rendererGeneration: prepare.rendererGeneration,
      ok: true,
    });

    assert.equal(await closing, true);
    assert.equal(h.posted.some((message) => message.type === "sync-apply"), false,
      "close intent must stop before the merged bytes replace the Viewer");
    assert.ok(h.records.some((record) => record.retained),
      "the local recovery draft remains available when apply is canceled for close");
    assert.equal(h.view.syncRequests.size, 0);
  } finally {
    h.host.dispose();
  }
});

test("close intent waits for an active apply cancellation and keeps its recovery draft", async () => {
  const h = harness({ local: [3], dirty: true, autoApply: false, mergeResult: [3] });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([2]);
    h.host.schedule(h.file, "close-during-active-apply");
    await until(() => h.posted.some((message) => message.type === "sync-apply"));
    const apply = h.posted.find((message) => message.type === "sync-apply");
    const releasesBeforeClose = h.calls.leaseReleases;

    let closed = false;
    const closing = h.host.prepareClose(h.view).then((result) => {
      closed = true;
      return result;
    });
    await until(() => h.posted.some((message) =>
      message.type === "sync-apply-cancel" && message.id === apply.id));
    await sleep(25);
    assert.equal(closed, false, "the close awaits confirmed PDF.js cancellation");
    assert.equal(h.calls.leaseReleases, releasesBeforeClose);

    h.host.handleMessage(h.view, {
      type: "sync-apply-cancelled",
      id: apply.id,
      documentId: apply.documentId,
      openRequest: apply.openRequest,
      rendererGeneration: apply.rendererGeneration,
      ok: true,
    });
    assert.equal(await closing, true);
    await until(() => h.calls.leaseReleases === releasesBeforeClose + 1);
    assert.ok(h.records.some((record) => record.retained),
      "canceling the refresh keeps the durable local recovery copy");
    assert.deepEqual([...h.view.originalBytes], [1],
      "canceled refresh does not advance the live Reader baseline");
    assert.equal(h.view.openRequest, apply.previousOpenRequest,
      "the Viewer remains on its pre-apply request after confirmed cancellation");
    assert.equal(h.view.syncNeedsRefresh, true,
      "the durable disk change remains pending for a later refresh");
    assert.ok(h.records.every((record) => record.metadata.status !== "conflict"),
      "an expected close cancellation is not recorded as a merge conflict");
    assert.equal(h.view.syncRequests.has(apply.id), false);

    h.host.resumeClose(h.view);
    await until(() => h.posted.filter((message) => message.type === "sync-apply").length === 2);
    const retry = h.posted.filter((message) => message.type === "sync-apply").at(-1);
    h.host.handleMessage(h.view, {
      type: "sync-applied", id: retry.id, documentId: retry.documentId,
      openRequest: retry.newOpenRequest, rendererGeneration: retry.rendererGeneration,
      revision: 4, ok: true,
    });
    await until(() => h.view.status.startsWith("已同步并刷新"));
    assert.deepEqual([...h.view.originalBytes], [3],
      "resuming a canceled close can apply the still-durable merge instead of remaining paused");
    assert.equal(h.view.openRequest, retry.newOpenRequest);
    assert.equal(h.view.syncNeedsRefresh, false);
  } finally {
    h.host.dispose();
  }
});

test("close intent refuses to proceed when active apply cancellation fails", async () => {
  const h = harness({ local: [3], dirty: true, autoApply: false, mergeResult: [3] });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([2]);
    h.host.schedule(h.file, "close-during-active-apply");
    await until(() => h.posted.some((message) => message.type === "sync-apply"));
    const apply = h.posted.find((message) => message.type === "sync-apply");
    const releasesBeforeClose = h.calls.leaseReleases;

    const closing = h.host.prepareClose(h.view);
    await until(() => h.posted.some((message) =>
      message.type === "sync-apply-cancel" && message.id === apply.id));
    h.host.handleMessage(h.view, {
      type: "sync-apply-cancel-failed",
      id: apply.id,
      documentId: apply.documentId,
      openRequest: apply.openRequest,
      rendererGeneration: apply.rendererGeneration,
      reason: "injected close failure",
    });
    await assert.rejects(closing, (error) =>
      error.code === "SYNC_APPLY_CANCEL_FAILED" && /injected close failure/.test(error.message));
    assert.equal(h.view.syncRequests.has(apply.id), true,
      "a failed stop remains nonterminal and blocks a successful close ACK");
    assert.equal(h.calls.leaseReleases, releasesBeforeClose,
      "the active apply keeps its heavy lease until explicit frame teardown");
    assert.ok(h.records.some((record) => record.retained));

    h.view.teardownStarted = true;
    await h.host.closeView(h.view, "test frame destroyed", { force: true });
    await until(() => h.calls.leaseReleases === releasesBeforeClose + 1);
    assert.equal(h.view.syncRequests.has(apply.id), false);
  } finally {
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

test("save transaction carries dirty state and forces fingerprint fallback when source bytes changed", async () => {
  const h = harness({ local: [4], mergeResult: [8] });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([9]);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer,
      actorId: "actor-a",
      operations: [{ uuid: "annotation-a", ref: "5R", pageIndex: 2, kind: "ink", action: "upsert" }],
      dirtyState: { dirtyAnnotationIds: ["annotation-a"], dirtyPageIndices: [2], newAnnotationIds: [], deletedAnnotationIds: [] },
      saveTransactionId: "save-transaction-external-change",
      revision: 1,
      requestId: "save-external-change",
    });
    const prepared = h.calls.prepareInputs[0];
    assert.equal(prepared.saveTransactionId, "save-transaction-external-change");
    assert.equal(prepared.documentRevisionMatch, false);
    assert.equal(prepared.forceFullFingerprints, true);
    assert.deepEqual(prepared.dirtyState.dirtyPageIndices, [2]);
    const log = h.calls.performance.find((entry) => entry.fn === "PdfSyncHost.save");
    assert.equal(log.saveTransactionId, "save-transaction-external-change");
    assert.equal(log.documentRevisionMatch, false);
    assert.equal(log.fallbackReason, "SOURCE_REVISION_MISMATCH");
    assert.ok(Number.isFinite(log.saveTotalMs));
    assert.equal(log.hostStageTimingSchema, 1);
    assert.ok(Number.isFinite(log.hostStagesMs.prepareLocalWallMs));
    assert.ok(Number.isFinite(log.hostStagesMs.saveDiskReadMs));
    assert.ok(Number.isFinite(log.hostStagesMs.journaledWriteWallMs));
    assert.ok(Number.isFinite(log.hostStagesMs.sourceWriteMs));
    assert.ok(Number.isFinite(log.hostStagesMs.sourceReadbackMs));
    assert.ok(Number.isFinite(log.hostStagesMs.checkpointConfirmMs));
  } finally { h.host.dispose(); }
});

test("save telemetry separates source mutation latency from readback and checkpoint phases", async () => {
  const h = harness({ local: [4], modifyGate: () => sleep(25) });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1, requestId: "save-stage-timing",
    });
    const log = h.calls.performance.find((entry) => entry.fn === "PdfSyncHost.save");
    assert.equal(log.saveTransactionId, "save-stage-timing");
    assert.ok(log.hostStagesMs.sourceWriteMs >= 20, "the injected adapter delay belongs to the source write stage");
    assert.ok(log.hostStagesMs.sourceReadbackMs >= 0);
    assert.ok(log.hostStagesMs.checkpointPersistMs >= 0);
    assert.ok(log.hostStagesMs.checkpointConfirmMs >= 0);
    assert.ok(log.hostStagesMs.recoveryCleanupMs >= 0);
    assert.ok(log.hostStagesMs.journaledWriteWallMs >= log.hostStagesMs.sourceWriteMs);
    assert.equal(log.hostStageCounts.sourceWriteMs, 1);
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
    if (manifest.schema === 2) manifest.checkpoint.hash = "invalid-after-close";
    else manifest.hash = "invalid-after-close";
    h.stored.set(manifestPath, JSON.stringify(manifest));
    const reopened = h.makeView("reopened-document");
    reopened.ready = false;
    h.plugin.views.add(reopened);
    await h.host.initializeView(reopened, reopened.originalBytes);
    assert.ok(h.calls.checkpointReads > readsBeforePeer,
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

test("prepareLocal binding failure pauses sync only after preserving the raw Viewer checkpoint", async () => {
  const rawViewerBytes = bytes([37, 80, 68, 70, 45, 49, 46, 55, 10, 105, 110, 107, 45, 101, 100, 105, 116]);
  const operations = [{ uuid: "native-ink-11", pageIndex: 9, kind: "Ink", action: "upsert",
    deleted: false, timestamp: 1791892800000, logical: 1, actorId: "native-ipad-device",
    operationId: "native-ipad-device:1791892800000:0:1",
    serialized: { subtype: "Ink", inkList: [[64, 80, 108, 117, 146, 99]] } }];
  const h = harness({ local: rawViewerBytes, dirty: true, operations,
    prepareFailure: new Error("annotation object binding failed for InkEditor11 on page 10") });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: rawViewerBytes.buffer, actorId: "native-ipad-device", operations, revision: 11,
    }), /binding failed/);

    assert.equal(h.calls.prepare, 1);
    assert.equal(h.calls.writes, 0);
    assert.equal(h.calls.appends, 0);
    assert.deepEqual([...h.disk], [1], "a mapping failure never writes an unverified merge result to the source");
    const record = h.records[0];
    assert.equal(record.reason, "before-save");
    assert.equal(record.revision, 11);
    assert.deepEqual([...bytes(record.data)], [...rawViewerBytes],
      "the raw PDF.js serialization was made durable before annotation mapping began");
    assert.equal(record.metadata.status, "conflict");
    assert.ok(record.retained, "the recovery entry remains available after the host pauses sync");
    assert.match(h.view.status, /同步暂停/);
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

test("an exact incremental patch is journaled then appended once and verified", async () => {
  const original = bytes([1]);
  const suffix = bytes([2, 3]);
  const output = bytes([1, 2, 3]);
  const h = harness({ appendPatch: { bytes: output, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix,
    outputLength: output.length, outputFingerprint: hash(output),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-a", kind: "upsert" }],
      revision: 1, requestId: "save-append",
    });
    assert.equal(h.calls.appends, 1);
    assert.equal(h.calls.writes, 0, "an exact patch uses Vault.appendBinary");
    assert.deepEqual([...h.disk], [...output]);
    assert.deepEqual(await h.host.listRecoveryCandidates(), [],
      "a confirmed checkpoint remains internal merge state, not an unsaved recovery branch");
    assert.deepEqual([...await h.host.readRecoveryCandidate({ path: h.file.path })], [...output],
      "confirmed bytes remain available to the host after their source PDF changes");
  } finally { h.host.dispose(); }
});

test("a prepared PDF.js prefix tail skips the full three-way merge", async () => {
  const output = bytes([1, 4, 5]);
  const h = harness({ appendPatch: { bytes: output } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1,
    });
    assert.equal(h.calls.merge.length, 0,
      "the byte-verified PDF.js tail composes with prepare metadata without reparsing three PDFs");
    assert.equal(h.calls.appends, 1);
    assert.equal(h.calls.writes, 0);
    assert.deepEqual([...h.disk], [...output]);
    assert.deepEqual([...await h.host.readRecoveryCandidate({ path: h.file.path })], [...output]);
  } finally { h.host.dispose(); }
});

test("a partially interrupted append stays pending and is never retried blindly", async () => {
  const original = bytes([1]);
  const suffix = bytes([2, 3]);
  const output = bytes([1, 2, 3]);
  const h = harness({ appendFailure: "partial", appendPatch: { bytes: output, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix,
    outputLength: output.length, outputFingerprint: hash(output),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-a", kind: "upsert" }],
      revision: 1, requestId: "save-interrupted-append",
    }), /injected interrupted append/);
    assert.equal(h.calls.appends, 1);
    assert.equal(h.calls.writes, 0, "a partial append never falls back to a second full rewrite");
    assert.deepEqual([...h.disk], [1, 2]);
    const [candidate] = await h.host.listRecoveryCandidates();
    assert.equal(candidate.metadata.status, "pending");
    assert.equal(candidate.metadata.storage, "sync-journal");
    assert.equal(candidate.metadata.outputLength, output.length);
    assert.equal(candidate.metadata.outputHash, hash(output));
    assert.deepEqual([...await h.host.readRecoveryCandidate(candidate)], [...output],
      "the pending journal reconstructs the full intended PDF after an interrupted append");
    h.host.schedule(h.file, "no-blind-retry");
    await sleep(190);
    assert.equal(h.calls.appends, 1);
    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-after-partial-append");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.match(reopenedView.status, /同步暂停/,
      "a partial source append remains ambiguous after restart");
    assert.equal(h.calls.appends, 1, "startup never retries an ambiguous append");
    assert.deepEqual([...h.disk], [1, 2]);
  } finally { h.host.dispose(); }
});

test("a preflight TFile refresh rebinds the exact path and appends only after byte verification", async () => {
  const original = bytes([1]);
  const suffix = bytes([2, 3]);
  const output = bytes([1, 2, 3]);
  const h = harness({ replaceFileOnRead: 2, appendPatch: { bytes: output, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix,
    outputLength: output.length, outputFingerprint: hash(output),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-a", kind: "upsert" }],
      revision: 1, requestId: "save-refreshed-file-object",
    });
    assert.notEqual(h.activeFile, h.file,
      "the test replaces the in-memory file object during the preflight read");
    assert.equal(h.calls.appends, 1);
    assert.equal(h.calls.writes, 0);
    assert.deepEqual([...h.disk], [...output]);
    assert.equal(JSON.parse(h.stored.get(journalManifestPath(h.file.path))).status, "confirmed");

    const checkpointRequests = h.posted.filter((message) => message.type === "sync-checkpoint").length;
    h.setDisk([9]);
    h.host.schedule({ ...h.activeFile }, "fresh-tfile-event-after-append");
    await until(() => h.posted.filter((message) => message.type === "sync-checkpoint").length > checkpointRequests);
    assert.equal(h.calls.appends, 1,
      "a fresh same-path TFile event is routed to the view's existing bound identity");
  } finally { h.host.dispose(); }
});

test("a pre-append removal rolls back only its pending manifest and keeps its raw recovery copy", async () => {
  const original = bytes([1]);
  const suffix = bytes([2]);
  const output = bytes([1, 2]);
  const h = harness({ removeFileOnRead: 2, appendPatch: { bytes: output, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix,
    outputLength: output.length, outputFingerprint: hash(output),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-a", kind: "upsert" }],
      revision: 1, requestId: "save-removed-before-append",
    }), /PDF 已被替换或移除/);
    assert.equal(h.calls.appends, 0, "no Vault append starts after the path disappears");
    assert.equal(h.calls.writes, 0);
    assert.equal(h.stored.has(journalManifestPath(h.file.path)), false,
      "the exact unstarted pending manifest is removed when there was no prior checkpoint");
    assert.equal(h.records[0].retained, true);
    assert.equal(h.records[0].metadata.status, "conflict");
    assert.match(h.view.status, /保存未完成/);

    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-after-preflight-abort");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.equal(reopenedView.status.startsWith("同步暂停"), false,
      "a known pre-append abort does not poison later sessions with a pending journal");
  } finally { h.host.dispose(); }
});

test("pre-append rollback restores the prior confirmed manifest without removing its backup", async () => {
  const nextOutput = bytes([1, 2, 3]);
  const suffix = bytes([3]);
  const h = harness({ removeFileOnRead: 5, appendPatch: (_input, count) =>
    count === 1
      ? { bytes: [1, 2], patch: null }
      : { bytes: nextOutput, patch: { baseLength: 2,
        baseFingerprint: hash(bytes([1, 2])), suffix,
        outputLength: nextOutput.length, outputFingerprint: hash(nextOutput) } },
  });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [],
      revision: 1, requestId: "save-prior-confirmed-checkpoint",
    });
    const manifestPath = journalManifestPath(h.file.path);
    const confirmed = JSON.parse(h.stored.get(manifestPath));
    assert.equal(confirmed.status, "confirmed");
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([5]).buffer, actorId: "actor-a", operations: [],
      revision: 2, requestId: "save-rollback-prior-checkpoint",
    }), /PDF 已被替换或移除/);
    assert.equal(h.calls.appends, 1,
      "only the first confirmed append runs; the second path disappears before appendBinary");
    assert.equal(h.stored.has(`${manifestPath}.previous`), true,
      "rollback preserves the previous manifest file");
    const restored = JSON.parse(h.stored.get(manifestPath));
    assert.equal(restored.status, "confirmed");
    assert.equal(restored.sequence, confirmed.sequence,
      "rollback restores the exact prior checkpoint instead of deleting or replacing it");
    assert.equal(h.records.at(-1).retained, true);
    assert.match(h.view.status, /保存未完成/);
  } finally { h.host.dispose(); }
});

test("pre-append rollback preserves a newer manifest installed during prior-checkpoint validation", async () => {
  const output = bytes([1, 2, 3]);
  const h = harness({ removeFileOnRead: 5, appendPatch: (_input, count) =>
    count === 1
      ? { bytes: [1, 2], patch: null }
      : { bytes: output, patch: { baseLength: 2,
        baseFingerprint: hash(bytes([1, 2])), suffix: bytes([3]),
        outputLength: output.length, outputFingerprint: hash(output) } },
  });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [],
      revision: 1, requestId: "save-before-rollback-validation-race",
    });
    const manifestPath = journalManifestPath(h.file.path);
    const confirmed = JSON.parse(h.stored.get(manifestPath));
    const adapter = h.plugin.app.vault.adapter;
    const originalRead = adapter.read.bind(adapter);
    const originalWrite = adapter.write.bind(adapter);
    let pendingAttemptText = null;
    let restoringText = null;
    let restoredReadCount = 0;
    let raceInjected = false;
    adapter.write = async (path, value) => {
      if (path === manifestPath && typeof value === "string") {
        const candidate = JSON.parse(value);
        if (candidate.status === "pending" && candidate.sequence > confirmed.sequence) {
          pendingAttemptText = value;
        }
        if (candidate.status === "confirmed" && candidate.sequence === confirmed.sequence && pendingAttemptText) {
          restoringText = value;
        }
      }
      return originalWrite(path, value);
    };
    adapter.read = async (path) => {
      if (path === manifestPath && restoringText && h.stored.get(path) === restoringText) {
        restoredReadCount += 1;
        if (restoredReadCount === 2) {
          raceInjected = true;
          const prior = JSON.parse(restoringText);
          h.stored.set(manifestPath, pendingAttemptText);
          h.stored.set(prior.base.file, bytes([99]));
          return restoringText;
        }
      }
      return originalRead(path);
    };

    let failure;
    try {
      await h.host.save(h.view, h.view.captureSaveRequest(), {
        data: bytes([5]).buffer, actorId: "actor-a", operations: [],
        revision: 2, requestId: "save-during-rollback-validation",
      });
    } catch (error) { failure = error; }
    assert.ok(failure, "the source path disappears before appendBinary");
    assert.equal(raceInjected, true,
      "a newer manifest is installed after the prior manifest is restored but during its validation");
    assert.equal(h.stored.get(manifestPath), pendingAttemptText,
      "rollback preserves the newer primary manifest instead of restoring a stale pending record");
    assert.match(failure.unstartedAppendRollbackError?.message || "", /newer state was preserved/);
  } finally { h.host.dispose(); }
});

test("pre-append rollback leaves a newer concurrent manifest untouched", async () => {
  const nextOutput = bytes([1, 2, 3]);
  const suffix = bytes([3]);
  const h = harness({ removeFileOnRead: 5, appendPatch: (_input, count) =>
    count === 1
      ? { bytes: [1, 2], patch: null }
      : { bytes: nextOutput, patch: { baseLength: 2,
        baseFingerprint: hash(bytes([1, 2])), suffix,
        outputLength: nextOutput.length, outputFingerprint: hash(nextOutput) } },
  });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [],
      revision: 1, requestId: "save-before-concurrent-manifest",
    });
    const manifestPath = journalManifestPath(h.file.path);
    const originalRead = h.plugin.app.vault.adapter.read.bind(h.plugin.app.vault.adapter);
    let raceInjected = false;
    h.plugin.app.vault.adapter.read = async (path) => {
      const currentText = h.stored.get(manifestPath);
      const currentStatus = typeof currentText === "string" ? JSON.parse(currentText).status : null;
      if (!raceInjected && currentStatus === "pending" && path === `${manifestPath}.previous`) {
        raceInjected = true;
        const newer = JSON.parse(currentText);
        newer.metadata = { ...newer.metadata,
          appendAttemptId: "newer-concurrent-attempt", appendPhase: "append-invoked" };
        h.stored.set(manifestPath, JSON.stringify(newer));
      }
      return originalRead(path);
    };
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([5]).buffer, actorId: "actor-a", operations: [],
      revision: 2, requestId: "save-concurrent-manifest-race",
    }), /PDF 已被替换或移除/);
    assert.equal(raceInjected, true, "a newer manifest lands during rollback preflight");
    const preserved = JSON.parse(h.stored.get(manifestPath));
    assert.equal(preserved.status, "pending");
    assert.equal(preserved.metadata.appendAttemptId, "newer-concurrent-attempt",
      "rollback does not overwrite a manifest that changed after its initial read");
    assert.equal(preserved.metadata.appendPhase, "append-invoked");
    assert.equal(h.stored.has(`${manifestPath}.previous`), true,
      "the existing previous manifest remains in place");
  } finally { h.host.dispose(); }
});

test("startup confirms an exact pending output without writing the source again", async () => {
  const original = bytes([1]);
  const suffix = bytes([2, 3]);
  const output = bytes([1, 2, 3]);
  const h = harness({ appendFailure: "before", appendPatch: { bytes: output, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix,
    outputLength: output.length, outputFingerprint: hash(output),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-a", kind: "upsert" }],
      revision: 1, requestId: "save-before-restart-confirm",
    }), /injected append failure/);
    h.setDisk(output);
    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-after-completed-append");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.equal(reopenedView.status.startsWith("同步暂停"), false);
    assert.equal(JSON.parse(h.stored.get(journalManifestPath(h.file.path))).status, "confirmed");
    assert.equal(h.calls.appends, 1, "startup only confirms the verified readback");
    assert.equal(h.calls.writes, 0, "startup does not rewrite a PDF that already matches the checkpoint");
    assert.equal(h.records[0].retained, true, "the original failed-save recovery evidence remains available");
  } finally { h.host.dispose(); }
});

test("a pending branch on the exact base is merged before the next coordinated save", async () => {
  const original = bytes([1]);
  const priorBranch = bytes([1, 2]);
  const suffix = bytes([2]);
  const h = harness({ appendFailure: (count) => count === 1 ? "before" : null,
    mergeResult: [1, 2, 3], appendPatch: (_input, count) =>
    count === 1
      ? { bytes: priorBranch, patch: { baseLength: 1, baseFingerprint: hash(original), suffix,
        outputLength: priorBranch.length, outputFingerprint: hash(priorBranch) } }
      : { bytes: [4], patch: null },
  });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-prior", kind: "upsert" }],
      revision: 1, requestId: "save-pending-branch",
    }), /injected append failure/);
    assert.deepEqual([...h.disk], [...original]);

    const manifestPath = journalManifestPath(h.file.path);
    const pending = JSON.parse(h.stored.get(manifestPath));
    assert.equal(pending.metadata.writePhase, "invoked",
      "the failed source call leaves a durable conservative marker");
    pending.metadata.writePhase = "preflight";
    pending.metadata.appendPhase = "preflight";
    h.stored.set(manifestPath, JSON.stringify(pending));

    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-with-pending-branch");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.equal(reopenedView.status.startsWith("同步暂停"), false,
      "exact base bytes prove the prior append did not alter the PDF");
    await restartedHost.save(reopenedView, reopenedView.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [{ uuid: "annotation-new", kind: "upsert" }],
      revision: 2, requestId: "save-merge-pending-branch",
    });
    assert.equal(h.calls.merge.length, 1);
    assert.deepEqual([...bytes(h.calls.merge[0].localBytes)], [...priorBranch],
      "the entire verified pending checkpoint is an explicit merge input");
    assert.deepEqual([...bytes(h.calls.merge[0].remoteBytes)], [4],
      "the current Viewer branch is merged with the pending local checkpoint");
    assert.deepEqual([...h.disk], [1, 2, 3]);
    assert.equal(h.records[0].retained, true,
      "the failed save's raw PDF recovery record remains retained after the later save");
  } finally { h.host.dispose(); }
});

test("an invoked append on its exact parent remains paused after restart", async () => {
  const original = bytes([1]);
  const intended = bytes([1, 2]);
  const h = harness({ appendFailure: "before", appendPatch: { bytes: intended, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix: bytes([2]),
    outputLength: intended.length, outputFingerprint: hash(intended),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1,
      requestId: "save-append-was-invoked",
    }), /injected append failure/);
    const pending = JSON.parse(h.stored.get(journalManifestPath(h.file.path)));
    assert.equal(pending.metadata.writePhase, "invoked");
    assert.equal(pending.metadata.appendPhase, "append-invoked");
    assert.deepEqual([...h.disk], [...original], "the injected failure left the exact parent bytes");

    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-after-invoked-append");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.match(reopenedView.status, /同步暂停/,
      "disk equality alone cannot prove an issued append did not partially mutate the file");
    assert.equal(h.calls.appends, 1, "restart does not retry an invoked append");
  } finally { h.host.dispose(); }
});

test("a legacy append with unique verified prefix-delta recovery evidence may merge", async () => {
  const original = bytes([1]);
  const branch = bytes([1, 2]);
  const h = harness({ appendFailure: (count) => count === 1 ? "before" : null, appendPatch: { bytes: branch, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix: bytes([2]),
    outputLength: branch.length, outputFingerprint: hash(branch),
  } }, mergeResult: [1, 2, 3] });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1,
      requestId: "legacy-append-request",
    }), /injected append failure/);
    const manifestPath = journalManifestPath(h.file.path);
    const pending = JSON.parse(h.stored.get(manifestPath));
    delete pending.metadata.writePhase;
    delete pending.metadata.writeParentHash;
    delete pending.metadata.writeParentLength;
    delete pending.metadata.appendAttemptId;
    delete pending.metadata.appendPhase;
    h.stored.set(manifestPath, JSON.stringify(pending));
    Object.assign(h.records[0].metadata, {
      status: "conflict",
      error: "PDF 已被替换或移除",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    });
    h.stored.set(h.records[0].metadataPath, `${JSON.stringify(h.records[0].metadata, null, 2)}\n`);
    const recoveryRoot = ".obsidian/plugins/pdf-web-reader/.recovery";
    const delta = await writeDeltaRecovery({
      adapter: h.adapter,
      root: recoveryRoot,
      data: branch,
      bases: [original],
      metadata: { ...h.records[0].metadata },
      ensureDirectory: async (adapter, path) => adapter.mkdir(path),
    });
    assert.ok(delta, "the actual compact recovery writer recognizes this incremental PDF branch");
    h.records[0].retained = false;
    h.records.push({ ...delta, retained: true });
    const recoveryReads = [];
    h.plugin.readRecoveryBytes = (candidate) => {
      recoveryReads.push(candidate);
      return readDeltaRecovery(h.adapter, recoveryRoot, candidate);
    };

    const validCandidateId = delta.metadata.candidateId;
    delta.metadata.candidateId = `${validCandidateId}!`;
    h.stored.set(delta.metadataPath, `${JSON.stringify(delta.metadata, null, 2)}\n`);
    const malformedHost = h.restartHost();
    const malformedView = h.makeView("reopened-with-malformed-delta-id");
    await malformedHost.initializeView(malformedView, malformedView.originalBytes);
    assert.match(malformedView.status, /同步暂停/,
      "an invalid candidate ID is never normalized into trusted recovery evidence");
    assert.equal(recoveryReads.length, 0, "malformed metadata is rejected before reading candidate bytes");
    delta.metadata.candidateId = validCandidateId;
    h.stored.set(delta.metadataPath, `${JSON.stringify(delta.metadata, null, 2)}\n`);

    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-with-legacy-proof");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.equal(reopenedView.status.startsWith("同步暂停"), false,
      "the exact legacy guard failure plus verified raw output proves append was not issued");
    assert.equal(recoveryReads.length, 1, "only the uniquely correlated, well-formed candidate is reconstructed");
    await restartedHost.save(reopenedView, reopenedView.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 2,
      requestId: "save-after-legacy-proof",
    });
    assert.deepEqual([...bytes(h.calls.merge.at(-1).localBytes)], [...branch],
      "the pending legacy branch remains an explicit merge input");
    assert.deepEqual([...h.disk], [1, 2, 3]);
  } finally { h.host.dispose(); }
});

test("an uncorrelated legacy pending append remains paused on its parent bytes", async () => {
  const original = bytes([1]);
  const intended = bytes([1, 2]);
  const h = harness({ appendFailure: "before", appendPatch: { bytes: intended, patch: {
    baseLength: original.length, baseFingerprint: hash(original), suffix: bytes([2]),
    outputLength: intended.length, outputFingerprint: hash(intended),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1,
      requestId: "legacy-append-without-proof",
    }), /injected append failure/);
    const manifestPath = journalManifestPath(h.file.path);
    const pending = JSON.parse(h.stored.get(manifestPath));
    delete pending.metadata.writePhase;
    delete pending.metadata.writeParentHash;
    delete pending.metadata.writeParentLength;
    delete pending.metadata.appendAttemptId;
    delete pending.metadata.appendPhase;
    h.stored.set(manifestPath, JSON.stringify(pending));
    h.records[0].retained = false;

    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-with-unproven-legacy-journal");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.match(reopenedView.status, /同步暂停/,
      "unknown legacy journal phases stay blocked even when disk equals the apparent parent");
    assert.equal(h.calls.appends, 1);
  } finally { h.host.dispose(); }
});

test("an invoked full write remains blocked even when disk still equals its recorded parent", async () => {
  const h = harness({ local: [4], dirty: true, failWrite: true });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([5]); h.host.schedule(h.file, "full-write-failure");
    await until(() => h.view.status.startsWith("同步暂停"));
    const manifestPath = journalManifestPath(h.file.path);
    const pending = JSON.parse(h.stored.get(manifestPath));
    assert.equal(pending.metadata.writePhase, "invoked");
    assert.equal(pending.metadata.writeParentHash, hash(bytes([5])));
    assert.equal(pending.metadata.writeParentLength, 1);

    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-after-invoked-full-write");
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.match(reopenedView.status, /同步暂停/,
      "the invoked marker prevents assuming an unchanged readback proves no write was issued");
    assert.equal(h.calls.writes, 1, "startup never replays the full write");
  } finally { h.host.dispose(); }
});

test("a pending append preflight is checked against the immediate linked parent, not the common base", async () => {
  const original = bytes([1]);
  const first = bytes([1, 2]);
  const second = bytes([1, 2, 3]);
  const h = harness({ appendFailure: (count) => count === 2 ? "before" : null,
    appendPatch: (_input, count) => count === 1
      ? { bytes: first, patch: { baseLength: 1, baseFingerprint: hash(original), suffix: bytes([2]),
        outputLength: first.length, outputFingerprint: hash(first) } }
      : { bytes: second, patch: { baseLength: 2, baseFingerprint: hash(first), suffix: bytes([3]),
        outputLength: second.length, outputFingerprint: hash(second) } },
  });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1,
      requestId: "first-confirmed-append",
    });
    assert.deepEqual([...h.disk], [...first]);
    await assert.rejects(h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([5]).buffer, actorId: "actor-a", operations: [], revision: 2,
      requestId: "second-pending-append",
    }), /injected append failure/);
    const manifestPath = journalManifestPath(h.file.path);
    const pending = JSON.parse(h.stored.get(manifestPath));
    assert.equal(pending.base.hash, hash(original), "the common merge base predates the first append");
    assert.equal(pending.metadata.writeParentHash, hash(first));
    assert.equal(pending.metadata.writeParentLength, first.length);
    pending.metadata.writePhase = "preflight";
    pending.metadata.appendPhase = "preflight";
    h.stored.set(manifestPath, JSON.stringify(pending));

    const restartedHost = h.restartHost();
    const reopenedView = h.makeView("reopened-after-second-append-preflight");
    reopenedView.originalBytes = first.slice();
    reopenedView.loadedBaseBytes = original.slice();
    await restartedHost.initializeView(reopenedView, reopenedView.originalBytes);
    assert.equal(reopenedView.status.startsWith("同步暂停"), false,
      "a safe preflight append is reconciled against the exact previous confirmed PDF");
  } finally { h.host.dispose(); }
});

test("an incremental patch whose base differs from disk is never appended to that disk", async () => {
  const h = harness({ mergeResult: [7, 7], appendPatch: { bytes: [7, 7], patch: {
    baseLength: 2, baseFingerprint: hash(bytes([8, 8])), suffix: bytes([9]),
    outputLength: 3, outputFingerprint: hash(bytes([8, 8, 9])),
  } } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1,
    });
    assert.equal(h.calls.appends, 0);
    assert.equal(h.calls.writes, 1, "unsafe patch falls back to the verified full-write path");
    assert.deepEqual([...h.disk], [7, 7]);
  } finally { h.host.dispose(); }
});

test("rebase serialization alone does not request a Viewer refresh when annotation state is unchanged", async () => {
  const identity = { uuid: "annotation-a", pageIndex: 0, kind: "square", deleted: false,
    timestamp: 10, logical: 2, actorId: "actor-a", operationId: "operation-a" };
  const localLedger = { documentId: "stable-document", pageFingerprints: ["page-a"], entries: [
    { ...identity, ref: "12R", order: 0, hash: "annotation-hash" },
  ] };
  const rebasedLedger = { documentId: "stable-document", pageFingerprints: ["page-a"], entries: [
    { ...identity, ref: "98R", order: 4, hash: "annotation-hash" },
  ] };
  const h = harness({ local: [4], mergeResult: [9, 9], prepareIdentities: [identity],
    mergeIdentities: [identity], prepareLedger: localLedger, mergeLedger: rebasedLedger });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([2]);
    await h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([4]).buffer, actorId: "actor-a", operations: [], revision: 1,
    });
    assert.equal(h.calls.merge.length, 1, "the local draft is rebased over the changed disk PDF");
    assert.deepEqual([...h.disk], [9, 9]);
    assert.equal(h.view.syncNeedsRefresh, false,
      "new PDF serialization refs/order alone do not trigger a reload of the live Viewer");
  } finally { h.host.dispose(); }
});

test("background sync rebases append a verified suffix and materialize only the Viewer reload bytes", async () => {
  const output = bytes([2, 3]);
  const suffix = bytes([3]);
  const h = harness({ local: [1], dirty: true, mergePatch: { omitBytes: true, patch: {
    baseLength: 1, baseFingerprint: hash(bytes([2])), suffix,
    outputLength: output.length, outputFingerprint: hash(output),
  } }, mergeResult: output, mergeLedger: { documentId: "stable-document", pageFingerprints: [], entries: [] } });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    h.setDisk([2]);
    h.host.schedule(h.file, "external-change");
    await until(() => h.view.status.startsWith("已同步并刷新"));
    assert.equal(h.calls.merge.at(-1).patchOnly, true);
    assert.equal(h.calls.appends, 1);
    assert.equal(h.calls.writes, 0, "background reconciliation uses Vault.appendBinary too");
    assert.deepEqual([...h.disk], [...output]);
    const apply = h.posted.find((message) => message.type === "sync-apply");
    assert.deepEqual([...new Uint8Array(apply.data)], [...output],
      "the verified readback is the complete buffer sent to PDF.js for its required reload");
    assert.deepEqual(await h.host.listRecoveryCandidates(), [], "confirmed sync state is not exposed as an unsaved recovery branch");
  } finally { h.host.dispose(); }
});

test("detached close writeback remerges when a remote branch arrives between observation and journal", async () => {
  const h = harness({
    mutateDiskOnRead: 2,
    mutateDiskValue: [1, 9],
    mergeResult: (input) => ({
      bytes: Uint8Array.from([
        ...bytes(input.remoteBytes),
        ...bytes(input.localBytes).filter((value) => !bytes(input.remoteBytes).includes(value)),
      ]),
    }),
  });
  try {
    const candidate = await createCloseRecovery(h, { draft: [1, 2] });
    const task = h.host.scheduleCloseWriteback(candidate);
    assert.ok(task);
    await task;
    assert.deepEqual([...h.disk], [1, 9, 2],
      `the final parent reread is merged before journaled append; job=${JSON.stringify(h.plugin.closeWritebackJobs.get(candidate.metadata.candidateId))}`);
    assert.equal(h.calls.merge.length, 1);
    assert.deepEqual([...bytes(h.calls.merge[0].remoteBytes)], [1, 9]);
    assert.equal(h.calls.appends, 1);
    assert.equal(candidate.retained, false);
    assert.equal(h.plugin.closeWritebackJobs.get(candidate.metadata.candidateId).status, "completed");
  } finally { h.host.dispose(); }
});

test("close writeback binding failure keeps the exact raw recovery bytes and leaves source untouched", async () => {
  const raw = bytes([1, 2, 3, 4]);
  const h = harness({ prepareFailure: new Error("unbound annotation UUID") });
  try {
    const candidate = await createCloseRecovery(h, { draft: raw });
    const task = h.host.scheduleCloseWriteback(candidate);
    assert.ok(task);
    await task;
    assert.deepEqual([...h.disk], [1]);
    assert.deepEqual([...bytes(await h.plugin.readRecoveryBytes(candidate))], [...raw]);
    assert.equal(candidate.retained, true);
    assert.equal(candidate.metadata.closeWriteback.phase, "paused");
    assert.equal(h.calls.writes, 0);
    assert.equal(h.calls.appends, 0);
    assert.equal(h.plugin.closeWritebackJobs.get(candidate.metadata.candidateId).status, "paused");
  } finally { h.host.dispose(); }
});

test("a newer raw recovery in the same Reader session suppresses older queued close jobs", async () => {
  const h = harness();
  try {
    const older = await createCloseRecovery(h, {
      draft: [1, 2], documentId: "same-session", openRequest: 4, revision: 40,
      createdAt: "2026-10-14T01:00:00.000Z",
    });
    const newer = await createCloseRecovery(h, {
      draft: [1, 2, 3], documentId: "same-session", openRequest: 4, revision: 41,
      reason: "auto-save-disabled", attachIntent: false,
      createdAt: "2026-10-14T01:00:01.000Z",
    });
    const tasks = await h.host.resumeCloseWritebacks();
    await Promise.all(tasks);
    assert.equal(h.calls.writes + h.calls.appends, 0);
    assert.equal(h.disk.length, 1);
    assert.equal(older.retained, true);
    assert.equal(older.metadata.closeWriteback.phase, "superseded");
    assert.equal(newer.retained, true, "the newer recovery-only candidate remains available");
    assert.equal(h.plugin.closeWritebackJobs.get(newer.metadata.candidateId).status, "paused");
  } finally { h.host.dispose(); }
});

test("same-millisecond independent Reader recoveries are serialized and merged instead of dropped", async () => {
  const h = harness({
    mergeResult: (input) => Uint8Array.from(new Set([
      ...bytes(input.remoteBytes), ...bytes(input.localBytes),
    ])),
  });
  try {
    const createdAt = "2026-10-14T01:00:00.000Z";
    const first = await createCloseRecovery(h, {
      draft: [1, 2], documentId: "session-first", revision: 18, createdAt,
    });
    const second = await createCloseRecovery(h, {
      draft: [1, 2, 3], documentId: "session-second", revision: 1, createdAt,
    });
    const tasks = await h.host.resumeCloseWritebacks();
    await Promise.all(tasks);
    assert.deepEqual([...h.disk], [1, 2, 3],
      "both independent local branches are merged against the preceding verified output");
    assert.equal(h.calls.writes + h.calls.appends, 2,
      "each distinct close branch reaches one verified source mutation");
    assert.equal(first.retained, false);
    assert.equal(second.retained, false);
    assert.ok(h.calls.merge.length >= 1,
      "the second session sees the first session's source output as its remote branch");
  } finally { h.host.dispose(); }
});

test("close writeback waits for an already admitted PDF open before acquiring a writer", async () => {
  const h = harness();
  try {
    const open = await h.host.beginCloseWritebackOpen(h.file.path);
    const candidate = await createCloseRecovery(h, { draft: [1, 2] });
    const task = h.host.scheduleCloseWriteback(candidate);
    assert.ok(task);
    assert.ok(h.host.closeWritebackGeneration(h.file.path) > open.generation,
      "the open snapshot can detect a close job admitted after it started");
    await sleep(30);
    assert.equal(h.calls.writes + h.calls.appends, 0,
      "the detached writer waits for PDF.js initialization to release its open admission");
    open.release();
    await task;
    assert.deepEqual([...h.disk], [1, 2]);
    assert.equal(candidate.retained, false);
  } finally { h.host.dispose(); }
});

test("sync reconciliation waits until an admitted same-path PDF open has parsed", async () => {
  const h = harness();
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    const opening = await h.host.beginCloseWritebackOpen(h.file.path);
    h.host.schedule(h.file, "activation-during-open");
    await sleep(250);
    assert.equal(h.posted.some((message) => message.type === "sync-checkpoint"), false,
      "the host does not ask PDF.js for a checkpoint before the admitted open ACK");
    assert.equal(h.view.status.startsWith("同步暂停"), false,
      "a missing pdfDocument during open cannot poison shared sync state");
    opening.release();
    h.view.openAcknowledged = false;
    h.host.schedule(h.file, "failed-open-ack");
    await sleep(250);
    assert.equal(h.posted.some((message) => message.type === "sync-checkpoint"), false,
      "a failed parse remains ineligible for reconciliation after its admission is released");
    assert.equal(h.view.status.startsWith("同步暂停"), false,
      "a failed open cannot poison the shared sync state after admission release");
    h.view.openAcknowledged = true;
    h.setDisk([1, 9]);
    h.host.schedule(h.file, "opened-ack");
    await until(() => h.posted.some((message) => message.type === "sync-checkpoint"));
  } finally { h.host.dispose(); }
});

test("detached close work acquires a Reader-free heavy lease before entering the save queue", async () => {
  const h = harness();
  try {
    const otherView = h.makeView("another-open-reader");
    otherView.openAcknowledged = true;
    h.plugin.views.add(otherView);
    const candidate = await createCloseRecovery(h, { draft: [1, 2] });
    const task = h.host.scheduleCloseWriteback(candidate);
    assert.ok(task);
    await task;
    assert.deepEqual(h.calls.events.slice(0, 2), ["close-heavy-lease", "enqueue-save"]);
    assert.equal(h.calls.closeLeases.length, 1);
    assert.equal(h.calls.closeLeases[0].owner.jobId, candidate.metadata.candidateId);
    assert.equal(Object.hasOwn(h.calls.closeLeases[0].owner, "view"), false);
    assert.equal(h.calls.closeLeaseReleases, 1);
    assert.ok(h.documentBaselines.has(h.file.path),
      "a still-open Reader keeps the verified source baseline cached");
  } finally { h.host.dispose(); }
});

test("a closed detached job releases baseline and sync bytes while the journal remains reloadable", async () => {
  for (const failWrite of [false, true]) {
    const h = harness({ failWrite });
    try {
      await h.host.initializeView(h.view, h.view.originalBytes);
      h.plugin.setDocumentBaseline(h.file.path, h.view.originalBytes);
      h.host.releaseView(h.view, h.file);
      h.view.teardownStarted = true;
      h.plugin.views.delete(h.view);
      h.plugin.releaseDocumentBaseline(h.file.path, h.view);
      if (failWrite) h.setDisk([9]);

      const candidate = await createCloseRecovery(h, { draft: [1, 2] });
      const task = h.host.scheduleCloseWriteback(candidate);
      assert.ok(task);
      await task;
      assert.equal(h.documentBaselines.has(h.file.path), false,
        "a completed or failed closed-view job must not retain a full PDF baseline");
      assert.equal(failWrite ? candidate.retained : !candidate.retained, true,
        "successful recovery may be cleaned up, while a failed write retains its raw recovery");
      if (failWrite) assert.deepEqual([...h.disk], [9], "a failed source write leaves disk untouched");

      const readsBeforeReopen = h.calls.checkpointReads;
      const reopened = h.makeView("reopened-after-closed-closejob");
      h.plugin.views.add(reopened);
      await h.host.initializeView(reopened, h.disk);
      assert.ok(h.calls.checkpointReads > readsBeforeReopen,
        "reopening creates fresh in-memory state from the durable journal");
      if (failWrite) assert.match(reopened.status, /^同步暂停/,
        "the uncertain write journal remains available after closed-job cleanup");
    } finally { h.host.dispose(); }
  }
});

test("equivalent duplicate close recoveries select one winner and supersede the replay", async () => {
  const h = harness();
  try {
    const createdAt = "2026-10-14T01:00:00.000Z";
    const first = await createCloseRecovery(h, {
      draft: [1, 2], documentId: "same-session", openRequest: 7,
      revision: 3, requestId: "same-close", createdAt,
      operations: [{ uuid: "square-a", op: "add" }],
    });
    const second = await createCloseRecovery(h, {
      draft: [1, 2], documentId: "same-session", openRequest: 7,
      revision: 3, requestId: "same-close", createdAt,
      operations: [{ uuid: "square-a", op: "add" }],
    });
    const winner = first.metadata.candidateId < second.metadata.candidateId ? first : second;
    const replay = winner === first ? second : first;
    const tasks = await h.host.resumeCloseWritebacks();
    await Promise.all(tasks);

    assert.equal(h.calls.appends + h.calls.writes, 1,
      "equivalent duplicate intents produce one source mutation");
    assert.deepEqual([...h.disk], [1, 2]);
    assert.equal(winner.retained, false, "the deterministic winner is removed after verified writeback");
    assert.equal(replay.retained, true, "the duplicate remains available as a superseded recovery");
    assert.equal(replay.metadata.closeWriteback.phase, "superseded");
    assert.equal(h.plugin.closeWritebackJobs.get(replay.metadata.candidateId).status, "superseded");
  } finally { h.host.dispose(); }
});

test("startup path discovery is a barrier before opening a PDF with a persisted close job", async () => {
  const h = harness();
  let releaseList;
  const listing = new Promise((resolve) => { releaseList = resolve; });
  const originalList = h.plugin.listRecoveryCandidates.bind(h.plugin);
  h.plugin.listRecoveryCandidates = async () => {
    await listing;
    return originalList();
  };
  try {
    const candidate = await createCloseRecovery(h, { draft: [1, 2] });
    const discovery = h.host.resumeCloseWritebacks();
    let opened = false;
    const opening = h.host.waitForCloseWriteback(h.file.path).then(() => { opened = true; });
    await sleep(30);
    assert.equal(opened, false, "open waits until recovery discovery registers the path job");
    releaseList();
    await discovery;
    await opening;
    assert.deepEqual([...h.disk], [1, 2]);
    assert.equal(candidate.retained, false);
  } finally { releaseList?.(); h.host.dispose(); }
});

test("in-flight source save settles after close without poisoning the latest detached recovery", async () => {
  let releaseAppend;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  const h = harness({
    appendGate: () => appendGate,
    mergeResult: (input) => ({
      bytes: Uint8Array.from([...new Set([...bytes(input.remoteBytes), ...bytes(input.localBytes)])]),
    }),
  });
  try {
    await h.host.initializeView(h.view, h.view.originalBytes);
    const oldSave = h.host.save(h.view, h.view.captureSaveRequest(), {
      data: bytes([1, 2]).buffer,
      actorId: "actor-a",
      operations: [{ uuid: "square-one" }],
      revision: 1,
      requestId: "blocked-old-save",
    });
    await until(() => h.calls.appends === 1);
    assert.deepEqual([...h.disk], [1], "the accepted source append is still behind the test gate");
    assert.equal(await h.host.prepareClose(h.view), true);
    const latest = await createCloseRecovery(h, {
      draft: [1, 2, 3], revision: 2, requestId: "latest-close-save",
      operations: [{ uuid: "square-one" }, { uuid: "square-two" }],
    });
    h.host.noteCloseRecoveryCandidate(latest);
    const detachedJob = h.host.scheduleCloseWriteback(latest);
    assert.ok(detachedJob);
    assert.equal(h.plugin.closeWritebackJobs.get(latest.metadata.candidateId).status, "queued");
    const jobSnapshot = h.plugin.closeWritebackJobs.get(latest.metadata.candidateId);
    assert.equal(Object.hasOwn(jobSnapshot, "view"), false);
    assert.equal(Object.hasOwn(jobSnapshot, "iframe"), false);
    assert.equal(Object.hasOwn(jobSnapshot, "window"), false);

    releaseAppend();
    await oldSave;
    await detachedJob;
    await h.plugin.saveQueue;
    assert.deepEqual([...h.disk], [1, 2, 3],
      "the latest two-square recovery writes after the already-invoked older save settles");
    assert.equal(h.plugin.closeWritebackJobs.get(latest.metadata.candidateId).status, "completed");
    assert.equal(latest.retained, false);
  } finally { releaseAppend?.(); h.host.dispose(); }
});
