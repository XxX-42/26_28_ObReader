/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { sha256 } = require("@noble/hashes/sha2");
const { createPdfJournal } = require("./pdf-journal.cjs");

// Browser-only host coordination. The frozen Viewer remains the annotation
// writer; the lazy merge Worker adds identities and reconciles branches.
function createPdfSyncHost(plugin, api) {
  const { createPdfMergeClient, sha256Bytes, normalizePath, isPdfFile,
    bytesEqual, makeToken, ensureAdapterDirectory, Notice } = api;
  const channel = "pdf-web-reader";
  const states = new WeakMap();
  const timers = new Map();
  const running = new Map();
  const closingViews = new WeakSet();
  const viewWork = new WeakMap();
  let disposed = false;
  let client;
  let actorId;
  try {
    const key = `${plugin.manifest.id}:local-device-id:v1`;
    actorId = globalThis.localStorage?.getItem(key);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(actorId || "")) {
      actorId = makeToken();
      globalThis.localStorage?.setItem(key, actorId);
    }
  } catch { actorId = makeToken(); }
  actorId ||= makeToken();
  const bytesView = (value) => {
    const tag = Object.prototype.toString.call(value);
    if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Invalid PDF byte data.");
  };
  const copy = (value) => Uint8Array.from(bytesView(value));
  const buffer = (value) => copy(value).buffer;
  const fingerprint = (value) => sha256Bytes(bytesView(value));
  const fingerprintChunks = (chunks) => {
    const hash = sha256.create();
    for (const chunk of chunks) hash.update(bytesView(chunk));
    return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const createFingerprintAccumulator = () => {
    const hash = sha256.create();
    return {
      update(value) { hash.update(bytesView(value)); },
      digest() { return Array.from(hash.clone().digest(), (byte) => byte.toString(16).padStart(2, "0")).join(""); },
    };
  };
  const equal = (left, right) => bytesEqual(bytesView(left), bytesView(right));
  const patchMatches = (patch, value) => !!patch && Number.isSafeInteger(patch.baseLength) &&
    patch.baseLength === bytesView(value).byteLength && patch.baseFingerprint === fingerprint(value);
  const prefixPatch = (output, base) => {
    const outputBytes = bytesView(output);
    const baseBytes = bytesView(base);
    if (outputBytes.byteLength <= baseBytes.byteLength) return null;
    for (let index = 0; index < baseBytes.byteLength; index += 1) {
      if (outputBytes[index] !== baseBytes[index]) return null;
    }
    const suffix = outputBytes.subarray(baseBytes.byteLength);
    return {
      baseLength: baseBytes.byteLength,
      baseFingerprint: fingerprint(baseBytes),
      suffix,
      outputLength: outputBytes.byteLength,
      outputFingerprint: fingerprint(outputBytes),
    };
  };
  const checkpointRoot = normalizePath(`${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/.sync-checkpoints`);
  const journal = createPdfJournal({
    adapter: plugin.app.vault.adapter,
    root: checkpointRoot,
    normalizePath,
    fingerprint,
    fingerprintChunks,
    createFingerprintAccumulator,
    bytesEqual,
    ensureDirectory: ensureAdapterDirectory,
    makeToken,
  });
  const joinBytes = (left, right) => {
    const a = bytesView(left), b = bytesView(right);
    const output = new Uint8Array(a.byteLength + b.byteLength);
    output.set(a, 0);
    output.set(b, a.byteLength);
    return output;
  };
  const semanticLedger = (result) => {
    const ledger = result?.ledger;
    const entries = ledger?.entries;
    const identities = result?.identities || result?.annotations;
    if (!Array.isArray(entries) || !Array.isArray(identities) ||
        typeof ledger.documentId !== "string" || !Array.isArray(ledger.pageFingerprints)) return null;
    const byUuid = (left, right) => String(left.uuid).localeCompare(String(right.uuid));
    const semanticEntry = (entry) => ({
      uuid: entry.uuid,
      pageIndex: entry.pageIndex,
      kind: entry.kind,
      deleted: Boolean(entry.deleted),
      hash: entry.hash ?? null,
      timestamp: entry.timestamp || 0,
      logical: entry.logical || 0,
      actorId: entry.actorId || "legacy",
      operationId: entry.operationId || "legacy",
    });
    const identityByUuid = new Map();
    for (const identity of identities) {
      if (typeof identity?.uuid !== "string" || identityByUuid.has(identity.uuid)) return null;
      identityByUuid.set(identity.uuid, identity);
    }
    const semanticEntries = entries.map((entry) => {
      if (typeof entry?.uuid !== "string") return null;
      const identity = identityByUuid.get(entry.uuid);
      if (!identity) return null;
      const normalized = semanticEntry(entry);
      const identityState = semanticEntry(identity);
      delete identityState.hash;
      delete normalized.hash;
      if (JSON.stringify(identityState) !== JSON.stringify(normalized)) return null;
      normalized.hash = entry.hash ?? null;
      return normalized;
    });
    if (semanticEntries.some((entry) => entry === null)) return null;
    return JSON.stringify({
      documentId: ledger.documentId,
      pageFingerprints: ledger.pageFingerprints,
      entries: semanticEntries.sort(byUuid),
    });
  };
  const matchingSnapshot = (state, value) => [state.checkpoint, state.confirmedCheckpoint, state.base]
    .find((snapshot) => snapshot && equal(snapshot, value)) || value;
  const workerSnapshot = (value) => {
    const mergeClient = getClient();
    return typeof mergeClient.snapshotBytes === "function" ? mergeClient.snapshotBytes(value) : copy(value);
  };
  const currentFile = (view) => view.documentFile || view.file;
  const fileViews = (file) => [...plugin.views].filter((view) =>
    currentFile(view) === file && view.ready && !view.teardownStarted && !closingViews.has(view));
  const closeRequested = (view) => closingViews.has(view) || view.teardownStarted;
  const hasLiveView = (file, state) => [...plugin.views].some((view) =>
    !state?.releasedViews?.has(view) && currentFile(view) === file && !view.teardownStarted);
  const getState = (file) => {
    let state = states.get(file);
    if (!state) {
      state = { checkpoint: null, confirmedCheckpoint: null, base: null, version: 0, paused: false, loaded: false, ownHash: null, inFlight: 0, releasePending: false, releasedViews: new WeakSet() };
      states.set(file, state);
    }
    return state;
  };
  const clearState = (file, state) => {
    if (state.inFlight || hasLiveView(file, state)) return false;
    state.checkpoint = null;
    state.confirmedCheckpoint = null;
    state.base = null;
    state.ownHash = null;
    state.version = 0;
    state.paused = false;
    state.failure = null;
    state.loaded = false;
    state.releasePending = false;
    states.delete(file);
    return true;
  };
  const settleState = (file, state) => {
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (state.releasePending) clearState(file, state);
  };
  const beginState = (file, state) => {
    state.inFlight += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      settleState(file, state);
    };
  };
  async function acquireHeavyLease(view, file, reason, leaseId = null) {
    if (typeof plugin.acquireHeavyLease !== "function") return { id: leaseId, release() {} };
    const lease = await plugin.acquireHeavyLease(view, file, reason, leaseId);
    return lease && typeof lease.release === "function" ? lease : { id: lease?.id ?? leaseId, release() {} };
  }
  const getClient = () => {
    if (!client) client = createPdfMergeClient({
      loadWorkerSource: async () => {
        const assets = await plugin.ensureViewerAssets();
        const bytes = await plugin.readVerifiedAsset("web/pdf-merge-worker.js");
        return { bytes, sha256: sha256Bytes(bytes), url: plugin.app.vault.adapter.getResourcePath(`${assets.rootPath}/web/pdf-merge-worker.js`) };
      },
      WorkerClass: globalThis.Worker,
      URLApi: globalThis.URL,
      BlobClass: globalThis.Blob,
    });
    return client;
  };
  const stateFor = (result) => ({
    version: 1, actorId, identities: result.identities || result.annotations || [],
    ledger: result.ledger, stateDigest: result.stateDigest,
  });
  async function loadCheckpoint(file, state) {
    if (state.loadPromise) return state.loadPromise;
    if (state.loaded) return;
    const pending = (async () => {
    try {
      const loaded = await journal.load(file.path);
      if (!loaded) return;
      const checkpoint = bytesView(loaded.checkpointBytes);
      const base = bytesView(loaded.baseBytes);
      state.checkpoint = equal(checkpoint, base) ? base : checkpoint;
      state.base = base;
      if (loaded.status === "confirmed") state.confirmedCheckpoint = state.checkpoint;
      else { state.paused = true; state.failure = "上次同步检查点尚未确认写回，已保留本地版本"; }
    } catch (error) {
      state.paused = true;
      state.failure = `本地同步检查点校验失败：${error.message}`;
    }
    })().finally(() => { state.loaded = true; state.loadPromise = null; });
    state.loadPromise = pending;
    return pending;
  }
  async function persistCheckpoint(file, state, bytes, base, metadata = {}) {
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载；本地恢复副本已保留");
    await journal.beginFull({ path: file.path, checkpointBytes: bytes, baseBytes: base, metadata });
    const checkpoint = state.checkpoint && equal(state.checkpoint, bytes)
      ? state.checkpoint
      : bytesView(bytes);
    const baseSnapshot = state.base && equal(state.base, base)
      ? state.base
      : equal(checkpoint, base) ? checkpoint : copy(base);
    state.checkpoint = checkpoint;
    state.base = baseSnapshot;
    state.version += 1;
  }
  async function confirmCheckpoint(file, state, bytes) {
    await journal.confirm(file.path, fingerprint(bytes), bytesView(bytes).byteLength);
    state.confirmedCheckpoint = state.checkpoint && equal(state.checkpoint, bytes)
      ? state.checkpoint
      : copy(bytes);
  }
  function post(view, message, transfer = []) {
    return view.postToViewer({ channel, token: view.token, rendererGeneration: view.rendererGeneration, ...message }, transfer);
  }
  function request(view, type, fields, replies, timeoutMs = 20000, transfer = []) {
    if (disposed || closeRequested(view) || !view.ready) {
      const error = new Error("Reader is unavailable");
      error.code = "SYNC_SESSION_CHANGED";
      return Promise.reject(error);
    }
    const id = fields.id || makeToken();
    const documentId = view.documentId;
    const openRequest = view.openRequest;
    const rendererGeneration = view.rendererGeneration;
    let requestPromise;
    requestPromise = new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      let cancelSent = false;
      let cancelFailure = null;
      let rejectCancelFailure;
      let cancelFailurePromise;
      const finish = (message, error) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        view.syncRequests.delete(id);
        if (error) reject(error); else resolve(message);
      };
      const failCancellation = (message) => {
        if (type !== "sync-apply" || settled) return;
        if (!cancelFailure) {
          cancelFailure = new Error(message?.reason || "Viewer 未能确认停止 PDF 刷新");
          cancelFailure.code = "SYNC_APPLY_CANCEL_FAILED";
          if (rejectCancelFailure) rejectCancelFailure(cancelFailure);
        }
      };
      const cancel = () => {
        if (type !== "sync-apply" || settled) return requestPromise.then(() => undefined, () => undefined);
        if (cancelFailure) return Promise.reject(cancelFailure);
        if (!cancelSent) {
          cancelSent = true;
          cancelFailurePromise = new Promise((_, rejectCancel) => { rejectCancelFailure = rejectCancel; });
          cancelFailurePromise.catch(() => {});
          globalThis.clearTimeout(timer);
          const cancelFields = {
            type: "sync-apply-cancel", id,
            documentId, openRequest, rendererGeneration,
          };
          if (fields.heavyLeaseId) cancelFields.heavyLeaseId = fields.heavyLeaseId;
          if (!post(view, cancelFields)) failCancellation({ reason: "无法发送 PDF 刷新取消请求" });
        }
        return Promise.race([
          requestPromise.then(() => undefined, () => undefined),
          cancelFailurePromise || Promise.resolve(),
        ]);
      };
      timer = globalThis.setTimeout(() => {
        if (type === "sync-apply") { void cancel().catch(() => {}); return; }
        finish(null, new Error(`${type} timed out`));
      }, timeoutMs);
      const wait = () => requestPromise.then(() => undefined, () => undefined);
      view.syncRequests.set(id, { finish, cancel, cancelFailed: failCancellation, wait, replies, documentId,
        openRequest, rendererGeneration, type, fields });
      if (!post(view, { type, id, documentId, openRequest, ...fields, rendererGeneration }, transfer)) finish(null, new Error("无法发送同步请求"));
    });
    return requestPromise;
  }
  async function quiesceView(view, { force = false } = {}) {
    closingViews.add(view);
    // A reconcile may be waiting for the mobile slot before it has sent a
    // Viewer request. Cancel only that queued host job; accepted work keeps
    // its lease until its own finally block settles.
    plugin.heavyWork?.cancelQueued?.(view, { reason: "sync-reconcile" });
    const unavailable = new Error("Reader is closing; the sync checkpoint is preserved.");
    unavailable.code = "SYNC_SESSION_CHANGED";
    const waits = [];
    for (const [id, pending] of [...view.syncRequests.entries()]) {
      if (force) {
        pending.finish(null, unavailable);
      } else if (pending.type === "sync-apply") {
        waits.push(pending.cancel());
      } else if (pending.type === "sync-checkpoint") {
        // PDF.js saveDocument cannot be interrupted safely. Wait for that one
        // serialization to finish; never start a second checkpoint for close.
        waits.push(pending.wait());
      } else if (pending.type === "sync-apply-prepare") {
        // The bridge can freeze an apply before the host posts sync-apply.
        // Cancel that prepared control so the close save can safely proceed.
        const sent = post(view, {
          type: "sync-apply-cancel",
          id,
          documentId: pending.documentId,
          openRequest: pending.openRequest,
        });
        if (!sent) {
          const error = new Error("Could not cancel the prepared PDF sync refresh.");
          error.code = "SYNC_APPLY_CANCEL_FAILED";
          throw error;
        }
        waits.push(pending.wait());
      } else {
        pending.finish(null, unavailable);
      }
    }
    await Promise.all(waits);
    const activeWork = viewWork.get(view);
    if (activeWork) await activeWork;
  }

  function failure(view, message) {
    view.setStatus(`同步暂停：${message}。可恢复本地副本。`, { recoveryAction: true });
    if (!view.syncFailureShown) {
      view.syncFailureShown = true;
      new Notice(`PDF 自动合并暂停：${message}。使用“恢复最近的 PDF 自动保存副本”取回本地版本。`, 8000);
    }
  }
  async function initializeView(view, bytes) {
    const file = currentFile(view);
    const state = getState(file);
    state.releasedViews.delete(view);
    const settle = beginState(file, state);
    let lease;
    try {
      lease = await acquireHeavyLease(view, file, "sync-initialize");
      await loadCheckpoint(file, state);
      if (!state.base) state.base = copy(bytes);
      if (state.paused) failure(view, state.failure);
      // Host unit fixtures deliberately omit Worker. Loading the plugin itself
      // never requires a Worker; actual editing will report capability errors.
      if (typeof globalThis.Worker !== "function") return { version: 1, actorId, identities: [] };
      try {
        const result = await getClient().inspect({ bytes: workerSnapshot(bytes) });
        view.syncDisabledReason = null;
        return stateFor(result);
      } catch (error) {
        view.syncDisabledReason = error.message;
        return { version: 1, actorId, identities: [], disabledReason: error.message };
      }
    } finally { lease?.release(); settle(); }
  }
  async function prepare(view, message, captured = null) {
    if (view.syncDisabledReason) throw new Error(view.syncDisabledReason);
    return getClient().prepareLocal({
      baseBytes: workerSnapshot(captured?.loadedBaseBytes || captured?.originalBytes || view.loadedBaseBytes || view.originalBytes),
      draftBytes: workerSnapshot(message.data), operations: message.operations || [],
      newAnnotations: message.newAnnotations || [], actorId,
      checkpointBytes: workerSnapshot(getState(captured?.file || currentFile(view)).confirmedCheckpoint || captured?.originalBytes || view.originalBytes),
    });
  }
  async function prepareRecovery(view, message, captured = null) {
    const file = captured?.file || currentFile(view);
    const state = getState(file);
    const settle = beginState(file, state);
    let lease;
    try {
      lease = await acquireHeavyLease(view, file, "sync-recovery", message?.heavyLeaseId || null);
      return await prepare(view, message, captured);
    } finally {
      lease?.release();
      settle();
    }
  }
  async function recovery(view, bytes, revision, reason, status = "pending", captured = view.captureSaveRequest()) {
    return plugin.writeRecoveryCandidate({ view, data: buffer(bytes),
      originalBytes: captured.originalBytes, documentPath: captured.documentPath || captured.file?.path,
      documentId: captured.documentId, filename: captured.filename || captured.file?.basename,
      openRequest: captured.openRequest, revision, origin: "sync", reason, status });
  }
  async function verifiedWrite(file, bytes, observed, state, stillCurrent = () => true) {
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    const latest = plugin.app.vault.getAbstractFileByPath(normalizePath(file.path));
    if (latest !== file) throw new Error("PDF 已被替换或移除");
    const before = await plugin.app.vault.readBinary(file);
    if (!equal(before, observed)) return false;
    if (plugin.app.vault.getAbstractFileByPath(normalizePath(file.path)) !== file) throw new Error("PDF 在磁盘检查期间被替换");
    if (!stillCurrent()) throw new Error("Reader 已切换；未覆盖原 PDF");
    // Public DataAdapter has no atomic compare-and-swap. A sync process may
    // still race between this comparison and modifyBinary; readback catches
    // observed mismatches, but cannot eliminate that remaining race window.
    state.ownHash = fingerprint(bytes);
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    await plugin.app.vault.modifyBinary(file, buffer(bytes));
    if (plugin.app.vault.getAbstractFileByPath(normalizePath(file.path)) !== file) throw new Error("PDF 在写入期间被替换；已保留恢复副本");
    const after = await plugin.app.vault.readBinary(file);
    const afterBytes = bytesView(after);
    if (afterBytes.byteLength !== bytesView(bytes).byteLength || fingerprint(afterBytes) !== fingerprint(bytes)) {
      throw new Error("PDF 写后内容发生变化，已保留检查点");
    }
    if (state.checkpoint && equal(state.checkpoint, afterBytes)) state.checkpoint = afterBytes;
    if (state.confirmedCheckpoint && equal(state.confirmedCheckpoint, afterBytes)) state.confirmedCheckpoint = afterBytes;
    if (state.base && equal(state.base, afterBytes)) state.base = afterBytes;
    plugin.setDocumentBaseline(file.path, matchingSnapshot(state, afterBytes));
    return afterBytes;
  }
  async function verifiedAppend(file, observed, patch, stillCurrent = () => true) {
    const vault = plugin.app.vault;
    if (typeof vault.appendBinary !== "function") return null;
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    if (vault.getAbstractFileByPath(normalizePath(file.path)) !== file) throw new Error("PDF 已被替换或移除");
    const before = bytesView(await vault.readBinary(file));
    if (!equal(before, observed) || !patchMatches(patch, before)) return null;
    if (vault.getAbstractFileByPath(normalizePath(file.path)) !== file) throw new Error("PDF 在磁盘检查期间被替换");
    if (!stillCurrent()) throw new Error("Reader 已切换；未覆盖原 PDF");
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    // appendBinary is deliberately issued once. If it rejects or readback is
    // incomplete, the pending journal is the recovery source; a blind retry
    // could duplicate a partially appended PDF revision.
    const state = states.get(file);
    if (state) state.ownHash = patch.outputFingerprint;
    await vault.appendBinary(file, buffer(patch.suffix));
    if (vault.getAbstractFileByPath(normalizePath(file.path)) !== file) throw new Error("PDF 在追加期间被替换；已保留恢复副本");
    const after = bytesView(await vault.readBinary(file));
    if (after.byteLength !== patch.outputLength || fingerprint(after) !== patch.outputFingerprint) {
      throw new Error("PDF 追加后的内容未通过校验；已保留检查点，未自动重试");
    }
    plugin.setDocumentBaseline(file.path, after);
    return after;
  }
  async function save(view, captured, message) {
    const file = captured.file;
    const state = getState(file);
    const settle = beginState(file, state);
    let record;
    let lease;
    try {
      lease = await acquireHeavyLease(view, file, "sync-save", message?.heavyLeaseId || null);
      await plugin.enqueueSave(async () => {
        record = await recovery(view, message.data, message.revision, "before-save", "pending", captured);
        try {
          if (disposed || plugin.isUnloading) throw new Error("插件已卸载；恢复副本已保留");
          if (!view.isCurrentSaveRequest(captured)) throw new Error("保存对应的文档已切换");
          if (state.paused) throw new Error(state.failure || "此文档自动合并已暂停");
          const local = await prepare(view, message, captured);
          let bytes = local.bytes;
          let metadata = local;
          if (state.checkpoint && !equal(state.checkpoint, captured.originalBytes)) {
            const checkpointMerge = await getClient().merge({
              baseBytes: workerSnapshot(state.base), localBytes: workerSnapshot(state.checkpoint),
              remoteBytes: workerSnapshot(bytes), actorId,
            });
            bytes = checkpointMerge.bytes;
            metadata = checkpointMerge;
          }
          let result;
          let observed;
          for (let attempt = 0; attempt < 3; attempt++) {
            observed = bytesView(await plugin.app.vault.readBinary(file));
            const diskMatchesBase = equal(observed, captured.originalBytes);
            const localPatchApplies = patchMatches(local.patch, observed);
            // PDF.js may already have appended the draft's object changes to
            // the exact source PDF. If the prepared output is a strict byte
            // prefix extension of the observed source, its tail is itself a
            // safe patch; this avoids parsing/re-serializing all three PDFs.
            const preparedPrefixPatch = diskMatchesBase ? prefixPatch(bytes, observed) : null;
            result = diskMatchesBase && (preparedPrefixPatch || !local.patch || localPatchApplies)
              ? { bytes, patch: preparedPrefixPatch || local.patch, changed: true, conflicts: [] }
              : await getClient().merge({
                baseBytes: workerSnapshot(state.base), localBytes: workerSnapshot(bytes),
                remoteBytes: workerSnapshot(observed), actorId, patchOnly: true,
              });
            const patch = patchMatches(result.patch, observed) ? result.patch : null;
            if (result.bytes !== undefined) bytes = result.bytes;
            else if (!patch) throw new Error("增量保存结果与磁盘基线不匹配；恢复副本已保留");
            if ((result.identities || result.annotations) && result.ledger) metadata = result;
            else if (!diskMatchesBase) metadata = null;
            // Keep the unmerged local branch when a timestamp winner replaces it.
            if (result.conflicts?.length) await plugin.markRecoveryCandidate(record, { status: "draft", reason: "superseded-local-version" });
            const journalMetadata = {
              actorId: message.actorId || actorId,
              revision: message.revision,
              operations: message.operations || [],
              newAnnotations: message.newAnnotations || [],
              documentId: captured.documentId,
            };
            let wrote;
            if (patch && typeof plugin.app.vault.appendBinary === "function") {
              await journal.beginAppend({ path: file.path, baseBytes: state.base, parentBytes: observed,
                suffix: patch.suffix, outputFingerprint: patch.outputFingerprint,
                outputLength: patch.outputLength, metadata: journalMetadata });
              wrote = await verifiedAppend(file, observed, patch, () => view.isCurrentSaveRequest(captured));
              if (wrote) {
                bytes = wrote;
                state.checkpoint = bytes;
                state.version += 1;
                await confirmCheckpoint(file, state, bytes);
              }
            } else {
              if (!bytes) {
                bytes = joinBytes(observed, patch.suffix);
                if (bytes.byteLength !== patch.outputLength || fingerprint(bytes) !== patch.outputFingerprint) {
                  throw new Error("无法重建完整 PDF 检查点；恢复副本已保留");
                }
              }
              await persistCheckpoint(file, state, bytes, state.base, journalMetadata);
              wrote = await verifiedWrite(file, bytes, observed, state, () => view.isCurrentSaveRequest(captured));
              if (wrote) {
                bytes = wrote;
                state.checkpoint = bytes;
                await confirmCheckpoint(file, state, bytes);
              }
            }
            if (wrote) {
              break;
            }
            if (attempt === 2) throw new Error("同步持续更改磁盘文件，自动写回暂停");
          }
          if (!((metadata?.identities || metadata?.annotations) && metadata?.ledger)) {
            metadata = await getClient().inspect({ bytes: workerSnapshot(bytes) });
          }
          if (!view.isCurrentSaveRequest(captured)) throw new Error("保存完成时 Reader 已切换；保留原文档恢复副本");
          const syncState = stateFor(metadata);
          // Runtime editor IDs belong only to this Viewer session. Reattach them
          // by UUID after inspecting the merged output, never by coordinates.
          const runtime = new Map((local.identities || []).map((entry) => [entry.uuid, entry.runtimeId]));
          syncState.identities = syncState.identities.map((entry) => ({ ...entry, runtimeId: runtime.get(entry.uuid) || entry.runtimeId }));
          view.originalBytes = matchingSnapshot(state, bytes);
          view.annotationSyncState = syncState;
          if (Number.isSafeInteger(message.revision)) {
            view.currentRevision = Math.max(view.currentRevision, message.revision);
            view.confirmedRevision = Math.max(view.confirmedRevision, message.revision);
          }
          post(view, { type: "saved", documentId: captured.documentId,
            rendererGeneration: captured.rendererGeneration,
            requestId: message.requestId, revision: message.revision, syncState }, []);
          if (!result.conflicts?.length) await plugin.removeRecoveryCandidate(record);
          const draft = view.latestRecoveryDraft;
          if (draft?.documentId === captured.documentId && message.revision >= draft.revision) {
            await plugin.removeRecoveryCandidate(draft.record);
            view.latestRecoveryDraft = null;
          }
          view.failureNoticeShown = false;
          view.setStatus(`已保存：${file.path}`, { recoveryAction: false });
          if (message.origin === "manual") new Notice(`已保存 ${captured.filename}`);
          const localSemanticState = semanticLedger(local);
          const mergedSemanticState = semanticLedger(metadata);
          const sameAnnotationState = localSemanticState !== null && localSemanticState === mergedSemanticState;
          if (!equal(bytes, local.bytes) && !sameAnnotationState) view.syncNeedsRefresh = true;
          schedule(file, "saved");
        } catch (error) {
          state.paused = true;
          state.failure = error.message;
          if (record) { try { await plugin.markRecoveryCandidate(record, { status: "conflict", error: error.message }); } catch { /* Keep binary and original error. */ } }
          error.code = "conflict";
          failure(view, error.message);
          throw error;
        }
      });
    } finally {
      lease?.release();
      settle();
    }
  }
  async function reconcile(view, file) {
    if (closeRequested(view)) return;
    let finishViewWork;
    const activeWork = new Promise((resolve) => { finishViewWork = resolve; });
    viewWork.set(view, activeWork);
    const state = getState(file);
    const settle = beginState(file, state);
    let lease;
    try {
      if (closeRequested(view) || state.paused || view.syncDisabledReason) return;
      const version = state.version;
      const captured = view.captureSaveRequest();
      if (captured.file !== file) return;
      const observedRead = await plugin.app.vault.readBinary(file);
      if (closeRequested(view) || !view.isCurrentSaveRequest(captured)) return;
      // Test a possible self-write before allocating base/checkpoint snapshots.
      if (equal(observedRead, captured.originalBytes) && !view.syncNeedsRefresh &&
          (!state.checkpoint || equal(observedRead, state.checkpoint))) return;

      try {
        lease = await acquireHeavyLease(view, file, "sync-reconcile");
      } catch (error) {
        if (closeRequested(view)) {
          const cancelled = new Error("Reader closed while its sync reconcile was waiting for the shared work slot.");
          cancelled.code = "SYNC_SESSION_CHANGED";
          throw cancelled;
        }
        throw error;
      }
      if (disposed || plugin.isUnloading || closeRequested(view) || currentFile(view) !== file ||
          !view.isCurrentSaveRequest(captured)) return;
      if (state.version !== version) { schedule(file, "state-changed"); return; }

      // These immutable snapshots survive asynchronous Viewer and Worker calls.
      const observed = copy(observedRead);
      const mergeBase = copy(state.base || view.loadedBaseBytes || view.originalBytes);
      const checkpoint = state.checkpoint ? workerSnapshot(state.checkpoint) : null;
      const snapshot = await request(view, "sync-checkpoint", { heavyLeaseId: lease.id }, ["sync-checkpoint-ready", "sync-checkpoint-rejected"], 120000);
      if (closeRequested(view)) return;
      if (snapshot.type === "sync-checkpoint-rejected" && snapshot.reason === "save-in-progress") {
        // The save queue may be waiting for this heavy lease. Release and retry
        // after this reconciliation exits instead of waiting while holding it.
        schedule(file, "save-settled");
        return;
      }
      if (snapshot.type !== "sync-checkpoint-ready" || snapshot.ok === false || !snapshot.data) throw new Error(snapshot.reason || "无法捕获安全编辑检查点");
      let record = await recovery(view, snapshot.data, snapshot.revision, "before-auto-merge", "draft", captured);
      if (closeRequested(view) || !view.isCurrentSaveRequest(captured)) return;
      const cleanWithoutCheckpoint = !checkpoint && !snapshot.operations?.length && !snapshot.newAnnotations?.length && snapshot.dirty !== true;
      const local = cleanWithoutCheckpoint ? { bytes: captured.originalBytes } : await prepare(view, snapshot, captured);
      let localBytes = local.bytes;
      let metadata = local;
      if (checkpoint) {
        const checkpointMerge = await getClient().merge({
          baseBytes: workerSnapshot(mergeBase), localBytes: checkpoint,
          remoteBytes: workerSnapshot(localBytes), actorId,
        });
        localBytes = checkpointMerge.bytes;
        metadata = checkpointMerge;
      }
      const merged = cleanWithoutCheckpoint ? { bytes: observed, changed: false, conflicts: [] }
        : await getClient().merge({
          baseBytes: workerSnapshot(mergeBase), localBytes: workerSnapshot(localBytes),
          remoteBytes: workerSnapshot(observed), actorId, patchOnly: true,
        });
      let bytes = merged.bytes;
      const patch = patchMatches(merged.patch, observed) ? merged.patch : null;
      if (bytes === undefined && !patch) throw new Error("同步合并结果与磁盘基线不匹配；恢复副本已保留");
      const materializePatch = () => {
        if (bytes === undefined) {
          bytes = joinBytes(observed, patch.suffix);
          if (bytes.byteLength !== patch.outputLength || fingerprint(bytes) !== patch.outputFingerprint) {
            throw new Error("无法重建完整 PDF 检查点；恢复副本已保留");
          }
        }
        return bytes;
      };
      if ((merged.identities || merged.annotations) && merged.ledger) metadata = merged;
      else if (!cleanWithoutCheckpoint) metadata = null;
      if (cleanWithoutCheckpoint || (!patch && !((metadata?.identities || metadata?.annotations) && metadata?.ledger))) {
        metadata = await getClient().inspect({ bytes: workerSnapshot(bytes) });
      } else if (!((metadata?.identities || metadata?.annotations) && metadata?.ledger)) {
        metadata = await getClient().inspect({ bytes: workerSnapshot(materializePatch()) });
      }
      if (closeRequested(view)) return;
      const prepared = await request(view, "sync-apply-prepare", {
        expectedRevision: snapshot.revision, heavyLeaseId: lease.id,
      }, ["sync-apply-prepared", "sync-apply-rejected", "sync-apply-cancelled"], 120000);
      if (closeRequested(view)) {
        if (prepared.prepared === true) {
          post(view, {
            type: "sync-apply-cancel",
            id: prepared.id,
            documentId: captured.documentId,
            openRequest: captured.openRequest,
            heavyLeaseId: lease.id,
          });
        }
        return;
      }
      if (prepared.ok !== true || prepared.prepared !== true) { schedule(file, "new-revision"); return; }
      try {
        await plugin.enqueueSave(async () => {
          if (disposed || plugin.isUnloading || closeRequested(view)) {
            const error = new Error("Reader closing; sync checkpoint is preserved.");
            error.code = "SYNC_SESSION_CHANGED";
            throw error;
          }
          if (!view.isCurrentSaveRequest(captured) || state.version !== version) { schedule(file, "queue-changed"); return; }
          const latest = await plugin.app.vault.readBinary(file);
          if (closeRequested(view)) {
            const error = new Error("Reader closing; sync checkpoint is preserved.");
            error.code = "SYNC_SESSION_CHANGED";
            throw error;
          }
          if (!equal(latest, observed)) { schedule(file, "disk-changed"); return; }
          const journalMetadata = {
            actorId: snapshot.actorId || actorId,
            revision: snapshot.revision,
            operations: snapshot.operations || [],
            newAnnotations: snapshot.newAnnotations || [],
            documentId: captured.documentId,
          };
          let wrote = false;
          if (!cleanWithoutCheckpoint && patch && typeof plugin.app.vault.appendBinary === "function") {
            await journal.beginAppend({ path: file.path, baseBytes: mergeBase, parentBytes: observed,
              suffix: patch.suffix, outputFingerprint: patch.outputFingerprint,
              outputLength: patch.outputLength, metadata: journalMetadata });
            const appended = await verifiedAppend(file, observed, patch, () => view.isCurrentSaveRequest(captured));
            if (!appended) { schedule(file, "disk-changed"); return; }
            bytes = appended;
            state.checkpoint = bytes;
            state.version += 1;
            await confirmCheckpoint(file, state, bytes);
            wrote = true;
          } else if (!cleanWithoutCheckpoint) {
            materializePatch();
            await persistCheckpoint(file, state, bytes, mergeBase, journalMetadata);
            const written = await verifiedWrite(file, bytes, observed, state, () => view.isCurrentSaveRequest(captured));
            if (!written) { schedule(file, "disk-changed"); return; }
            bytes = written;
            await confirmCheckpoint(file, state, bytes);
            wrote = true;
          } else { state.base = copy(bytes); state.version += 1; }
          if (closeRequested(view)) {
            const error = new Error("Reader closing; sync checkpoint is preserved.");
            error.code = "SYNC_SESSION_CHANGED";
            throw error;
          }
          if (!wrote && !equal(bytes, observed)) { schedule(file, "disk-changed"); return; }
          plugin.setDocumentBaseline(file.path, matchingSnapshot(state, bytes));
          const previousOpenRequest = view.openRequest;
          const newOpenRequest = previousOpenRequest + 1;
          const data = buffer(bytes);
          const apply = request(view, "sync-apply", {
            id: prepared.id, heavyLeaseId: lease.id,
            previousOpenRequest, newOpenRequest, expectedRevision: snapshot.revision,
            data, syncState: stateFor(metadata), viewState: snapshot.viewState,
          }, ["sync-applied", "sync-apply-rejected", "sync-apply-cancelled", "sync-apply-cancel-failed"], 20000, [data]);
          // The Viewer realm remains unchanged; only its PDF open request moves
          // forward. Match that next request within the captured renderer realm.
          view.openRequest = newOpenRequest;
          const applied = await apply;
          if (applied.type === "sync-apply-cancelled" && closeRequested(view)) {
            // The host advances openRequest before awaiting the Viewer apply so
            // an eventual sync-applied can be matched to its new session. A
            // confirmed close cancellation leaves the old Viewer document
            // live, so restore that request before the close flush is sent.
            if (view.documentId === captured.documentId &&
                view.openRequest === newOpenRequest &&
                view.rendererGeneration === captured.rendererGeneration &&
                currentFile(view) === file && !view.teardownStarted) {
              view.openRequest = previousOpenRequest;
              view.syncNeedsRefresh = true;
            }
            const error = new Error("Reader close canceled the pending sync refresh; its recovery checkpoint is preserved.");
            error.code = "SYNC_SESSION_CHANGED";
            throw error;
          }
          if (applied.ok !== true || applied.type !== "sync-applied") throw new Error(applied.reason || "合并后 Viewer 刷新失败");
          if (currentFile(view) !== file || view.documentId !== captured.documentId || view.openRequest !== newOpenRequest || (captured.rendererGeneration && view.rendererGeneration !== captured.rendererGeneration) || view.teardownStarted) throw new Error("刷新完成时 Reader 已切换；保留原文档恢复副本");
          const baseline = matchingSnapshot(state, bytes);
          view.originalBytes = baseline;
          view.loadedBaseBytes = baseline;
          view.annotationSyncState = stateFor(metadata);
          view.currentRevision = Number.isSafeInteger(applied.revision) ? applied.revision : 0;
          view.confirmedRevision = view.currentRevision;
          view.lastOpenSentRequest = newOpenRequest;
          view.syncNeedsRefresh = false;
          view.syncFailureShown = false;
          view.setStatus(`已同步并刷新：${file.path}`, { recoveryAction: false });
          if (!merged.conflicts?.length) await plugin.removeRecoveryCandidate(record);
        });
      } catch (error) {
        if (error.code !== "SYNC_SESSION_CHANGED") {
          await plugin.markRecoveryCandidate(record, { status: "conflict", error: error.message });
        }
        throw error;
      } finally {
        post(view, { type: "sync-apply-cancel", id: prepared.id, documentId: captured.documentId, openRequest: captured.openRequest, heavyLeaseId: lease.id });
      }
    } finally {
      lease?.release();
      settle();
      if (viewWork.get(view) === activeWork) viewWork.delete(view);
      finishViewWork();
    }
  }
  function schedule(file, reason) {
    if (disposed || plugin.isUnloading || !isPdfFile(file) || !fileViews(file).length) return;
    if (running.has(file)) { running.get(file).again = true; return; }
    if (timers.has(file)) globalThis.clearTimeout(timers.get(file));
    timers.set(file, globalThis.setTimeout(() => {
      timers.delete(file);
      const job = { again: false, reason };
      running.set(file, job);
      void (async () => {
        for (const view of fileViews(file)) {
          try { await reconcile(view, file); }
          catch (error) {
            if (closeRequested(view) || disposed || currentFile(view) !== file || error.code === "SYNC_SESSION_CHANGED") continue;
            const state = getState(file);
            state.paused = true;
            state.failure = error.message;
            failure(view, error.message);
          }
        }
      })().finally(() => {
        running.delete(file);
        if (job.again) schedule(file, "coalesced");
      });
    }, 150));
  }
  return {
    actorId, initializeView, save, schedule, prepareRecovery, showFailure: failure,
    async listRecoveryCandidates() {
      const candidates = await journal.listRecoveries();
      return candidates.filter((candidate) => candidate.status === "pending").map((candidate) => ({
        path: candidate.path,
        metadata: {
          schema: candidate.schema,
          storage: "sync-journal",
          originalPath: candidate.path,
          filename: candidate.path.split("/").at(-1),
          status: candidate.status,
          createdAt: candidate.updatedAt,
          updatedAt: candidate.updatedAt,
          outputHash: candidate.hash,
          outputLength: candidate.length,
          sequence: candidate.sequence,
        },
      }));
    },
    readRecoveryCandidate: (candidate) => journal.readRecovery(candidate),
    prepareClose(view) {
      closingViews.add(view);
      if (!view.syncRequests.size && !viewWork.has(view)) {
        return Promise.resolve(true);
      }
      return quiesceView(view).then(() => true);
    },
    resumeClose(view) {
      if (view.teardownStarted || !closingViews.has(view)) return false;
      closingViews.delete(view);
      const file = currentFile(view);
      if (file && view.ready) schedule(file, "close-cancelled");
      return true;
    },
    checkOpenViews(reason) { for (const view of plugin.views) schedule(currentFile(view), reason); },
    handleMessage(view, message) {
      if (!message.type?.startsWith("sync-")) return false;
      const pending = view.syncRequests.get(message.id);
      if (!pending || !pending.replies.includes(message.type) || pending.documentId !== message.documentId || pending.rendererGeneration !== message.rendererGeneration || pending.rendererGeneration !== view.rendererGeneration) return true;
      const expected = pending.type === "sync-apply" ? pending.openRequest + 1 : pending.openRequest;
      if (message.openRequest !== expected &&
          !(pending.type === "sync-apply" && ["sync-apply-rejected", "sync-apply-cancelled", "sync-apply-cancel-failed"].includes(message.type) && message.openRequest === pending.openRequest)) return true;
      if (pending.type === "sync-apply" && message.type === "sync-apply-cancel-failed") {
        pending.cancelFailed(message);
        return true;
      }
      if (pending.type === "sync-apply" && message.type === "sync-apply-cancelled" && message.ok !== true) {
        pending.cancelFailed(message);
        return true;
      }
      pending.finish(message);
      return true;
    },
    renamed(file, oldPath) {
      const state = states.get(file);
      if (!state?.checkpoint) return;
      const view = [...plugin.views].find((candidate) => currentFile(candidate) === file && !candidate.teardownStarted) || null;
      const settle = beginState(file, state);
      void (async () => {
        let lease;
        try {
          lease = view ? await acquireHeavyLease(view, file, "sync-rename") : { release() {} };
          await plugin.enqueueSave(async () => {
            await persistCheckpoint(file, state, state.checkpoint, state.base);
            if (state.confirmedCheckpoint && equal(state.confirmedCheckpoint, state.checkpoint)) await confirmCheckpoint(file, state, state.checkpoint);
            // Preserve the old path checkpoint as a fallback after abrupt rename.
          });
        } catch (error) { state.paused = true; state.failure = error.message; }
        finally { lease?.release(); settle(); }
      })();
    },
    async closeView(view, reason = "Reader closed", { force = false } = {}) {
      force = force || reason === "renderer-replaced";
      await quiesceView(view, { force });
    },
    releaseView(view, file = currentFile(view)) {
      if (!file) return false;
      const state = states.get(file);
      if (!state) return false;
      state.releasedViews.add(view);
      if (hasLiveView(file, state)) return false;
      state.releasePending = true;
      if (!state.inFlight) return clearState(file, state);
      return false;
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) globalThis.clearTimeout(timer);
      timers.clear();
      for (const view of plugin.views) void this.closeView(view, "Plugin unloaded", { force: true });
      client?.dispose?.();
    },
  };
}

module.exports = { createPdfSyncHost };
