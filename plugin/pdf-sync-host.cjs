/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// Browser-only host coordination. The frozen Viewer remains the annotation
// writer; the lazy merge Worker adds identities and reconciles branches.
function createPdfSyncHost(plugin, api) {
  const { createPdfMergeClient, sha256Bytes, normalizePath, isPdfFile,
    bytesEqual, toArrayBuffer, makeToken, ensureAdapterDirectory, Notice } = api;
  const channel = "pdf-web-reader";
  const states = new WeakMap();
  const timers = new Map();
  const running = new Map();
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
  const copy = (value) => new Uint8Array(toArrayBuffer(value)).slice();
  const buffer = (value) => copy(value).buffer;
  const fingerprint = (value) => sha256Bytes(copy(value));
  const currentFile = (view) => view.documentFile || view.file;
  const fileViews = (file) => [...plugin.views].filter((view) =>
    currentFile(view) === file && view.ready && !view.teardownStarted);
  const getState = (file) => {
    let state = states.get(file);
    if (!state) {
      state = { checkpoint: null, confirmedCheckpoint: null, base: null, version: 0, paused: false, loaded: false, ownHash: null };
      states.set(file, state);
    }
    return state;
  };
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
  const checkpointPaths = (file) => {
    const root = normalizePath(`${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/.sync-checkpoints`);
    const id = sha256Bytes(new TextEncoder().encode(normalizePath(file.path)));
    return { root, pdf: `${root}/${id}.pdf`, base: `${root}/${id}.base.pdf`, json: `${root}/${id}.json` };
  };
  async function loadCheckpoint(file, state) {
    if (state.loadPromise) return state.loadPromise;
    if (state.loaded) return;
    const pending = (async () => {
    const paths = checkpointPaths(file);
    const adapter = plugin.app.vault.adapter;
    try {
      if (!(await adapter.exists(paths.json))) return;
      const metadata = JSON.parse(await adapter.read(paths.json));
      if (metadata.schema !== 1 || metadata.path !== normalizePath(file.path)) return;
      const [pdf, base] = await Promise.all([adapter.readBinary(paths.pdf), adapter.readBinary(paths.base)]);
      if (fingerprint(pdf) !== metadata.hash || fingerprint(base) !== metadata.baseHash) throw new Error("Checkpoint verification failed");
      state.checkpoint = copy(pdf);
      state.base = copy(base);
      if (metadata.status === "confirmed") state.confirmedCheckpoint = copy(pdf);
      else { state.paused = true; state.failure = "上次同步检查点尚未确认写回，已保留本地版本"; }
    } catch (error) {
      state.paused = true;
      state.failure = `本地同步检查点校验失败：${error.message}`;
    }
    })().finally(() => { state.loaded = true; state.loadPromise = null; });
    state.loadPromise = pending;
    return pending;
  }
  async function persistCheckpoint(file, state, bytes, base) {
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载；本地恢复副本已保留");
    const paths = checkpointPaths(file);
    const adapter = plugin.app.vault.adapter;
    await ensureAdapterDirectory(adapter, paths.root);
    // The manifest is the completion record. Partial writes cannot be reused.
    await adapter.writeBinary(paths.base, buffer(base));
    await adapter.writeBinary(paths.pdf, buffer(bytes));
    const [savedBase, savedPdf] = await Promise.all([adapter.readBinary(paths.base), adapter.readBinary(paths.pdf)]);
    if (!bytesEqual(copy(base), copy(savedBase)) || !bytesEqual(copy(bytes), copy(savedPdf))) throw new Error("同步检查点写后校验失败");
    await adapter.write(paths.json, JSON.stringify({ schema: 1, status: "pending", path: normalizePath(file.path), hash: fingerprint(bytes), baseHash: fingerprint(base) }));
    state.checkpoint = copy(bytes);
    state.base = copy(base);
    state.version += 1;
  }
  async function confirmCheckpoint(file, state, bytes) {
    const paths = checkpointPaths(file);
    await plugin.app.vault.adapter.write(paths.json, JSON.stringify({ schema: 1, status: "confirmed", path: normalizePath(file.path), hash: fingerprint(bytes), baseHash: fingerprint(state.base) }));
    state.confirmedCheckpoint = copy(bytes);
  }
  function post(view, message, transfer = []) {
    return view.postToViewer({ channel, token: view.token, rendererGeneration: view.rendererGeneration, ...message }, transfer);
  }
  function request(view, type, fields, replies, timeoutMs = 20000) {
    if (disposed || view.teardownStarted || !view.ready) return Promise.reject(new Error("Reader is unavailable"));
    const id = fields.id || makeToken();
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => finish(null, new Error(`${type} timed out`)), timeoutMs);
      const finish = (message, error) => {
        globalThis.clearTimeout(timer);
        view.syncRequests.delete(id);
        if (error) reject(error); else resolve(message);
      };
      view.syncRequests.set(id, { finish, replies, documentId: view.documentId,
        openRequest: view.openRequest, rendererGeneration: view.rendererGeneration, type });
      if (!post(view, { type, id, documentId: view.documentId, openRequest: view.openRequest, ...fields })) finish(null, new Error("无法发送同步请求"));
    });
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
    await loadCheckpoint(file, state);
    if (!state.base) state.base = copy(bytes);
    if (state.paused) failure(view, state.failure);
    // Host unit fixtures deliberately omit Worker. Loading the plugin itself
    // never requires a Worker; actual editing will report capability errors.
    if (typeof globalThis.Worker !== "function") return { version: 1, actorId, identities: [] };
    try {
      const result = await getClient().inspect({ bytes: copy(bytes), baseBytes: state.base });
      view.syncDisabledReason = null;
      return stateFor(result);
    } catch (error) {
      view.syncDisabledReason = error.message;
      return { version: 1, actorId, identities: [], disabledReason: error.message };
    }
  }
  async function prepare(view, message, captured = null) {
    if (view.syncDisabledReason) throw new Error(view.syncDisabledReason);
    return getClient().prepareLocal({
      baseBytes: copy(captured?.loadedBaseBytes || captured?.originalBytes || view.loadedBaseBytes || view.originalBytes),
      draftBytes: copy(message.data), operations: message.operations || [],
      newAnnotations: message.newAnnotations || [], actorId,
      checkpointBytes: getState(captured?.file || currentFile(view)).confirmedCheckpoint || captured?.originalBytes || view.originalBytes,
    });
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
    const before = copy(await plugin.app.vault.readBinary(file));
    if (!bytesEqual(before, observed)) return false;
    if (plugin.app.vault.getAbstractFileByPath(normalizePath(file.path)) !== file) throw new Error("PDF 在磁盘检查期间被替换");
    if (!stillCurrent()) throw new Error("Reader 已切换；未覆盖原 PDF");
    // Public DataAdapter has no atomic compare-and-swap. A sync process may
    // still race between this comparison and modifyBinary; readback catches
    // observed mismatches, but cannot eliminate that remaining race window.
    state.ownHash = fingerprint(bytes);
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    await plugin.app.vault.modifyBinary(file, buffer(bytes));
    if (plugin.app.vault.getAbstractFileByPath(normalizePath(file.path)) !== file) throw new Error("PDF 在写入期间被替换；已保留恢复副本");
    const after = copy(await plugin.app.vault.readBinary(file));
    if (!bytesEqual(after, bytes)) throw new Error("PDF 写后内容发生变化，已保留检查点");
    plugin.setDocumentBaseline(file.path, bytes);
    return true;
  }
  async function save(view, captured, message) {
    const file = captured.file;
    let record;
    await plugin.enqueueSave(async () => {
      record = await recovery(view, message.data, message.revision, "before-save", "pending", captured);
      try {
        if (disposed || plugin.isUnloading) throw new Error("插件已卸载；恢复副本已保留");
        if (!view.isCurrentSaveRequest(captured)) throw new Error("保存对应的文档已切换");
        const state = getState(file);
        if (state.paused) throw new Error(state.failure || "此文档自动合并已暂停");
        const local = await prepare(view, message, captured);
        let bytes = copy(local.bytes);
        if (state.checkpoint && !bytesEqual(state.checkpoint, captured.originalBytes)) {
          bytes = copy((await getClient().merge({ baseBytes: state.base, localBytes: state.checkpoint, remoteBytes: bytes, actorId })).bytes);
        }
        let result;
        let observed;
        for (let attempt = 0; attempt < 3; attempt++) {
          observed = copy(await plugin.app.vault.readBinary(file));
          result = bytesEqual(observed, captured.originalBytes)
            ? { bytes, changed: true, conflicts: [] }
            : await getClient().merge({ baseBytes: state.base, localBytes: bytes, remoteBytes: observed, actorId });
          bytes = copy(result.bytes);
          // Keep the unmerged local branch when a timestamp winner replaces it.
          if (result.conflicts?.length) await plugin.markRecoveryCandidate(record, { status: "draft", reason: "superseded-local-version" });
          await persistCheckpoint(file, state, bytes, state.base);
          if (await verifiedWrite(file, bytes, observed, state, () => view.isCurrentSaveRequest(captured))) {
            await confirmCheckpoint(file, state, bytes);
            break;
          }
          if (attempt === 2) throw new Error("同步持续更改磁盘文件，自动写回暂停");
        }
        const inspected = await getClient().inspect({ bytes, baseBytes: state.base });
        if (!view.isCurrentSaveRequest(captured)) throw new Error("保存完成时 Reader 已切换；保留原文档恢复副本");
        const syncState = stateFor(inspected);
        // Runtime editor IDs belong only to this Viewer session. Reattach them
        // by UUID after inspecting the merged output, never by coordinates.
        const runtime = new Map((local.identities || []).map((entry) => [entry.uuid, entry.runtimeId]));
        syncState.identities = syncState.identities.map((entry) => ({ ...entry, runtimeId: runtime.get(entry.uuid) || entry.runtimeId }));
        view.originalBytes = copy(bytes);
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
        if (!bytesEqual(bytes, local.bytes)) view.syncNeedsRefresh = true;
        schedule(file, "saved");
      } catch (error) {
        const state = getState(file);
        state.paused = true;
        state.failure = error.message;
        if (record) { try { await plugin.markRecoveryCandidate(record, { status: "conflict", error: error.message }); } catch { /* Keep binary and original error. */ } }
        error.code = "conflict";
        failure(view, error.message);
        throw error;
      }
    });
  }
  async function reconcile(view, file) {
    const state = getState(file);
    if (state.paused || view.syncDisabledReason) return;
    const version = state.version;
    const mergeBase = copy(state.base || view.loadedBaseBytes || view.originalBytes);
    const checkpoint = state.checkpoint ? copy(state.checkpoint) : null;
    const captured = view.captureSaveRequest();
    if (captured.file !== file) return;
    const observed = copy(await plugin.app.vault.readBinary(file));
    // Exact content checks include own writes. No event suppression window.
    if (bytesEqual(observed, view.originalBytes) && !view.syncNeedsRefresh &&
        (!state.checkpoint || bytesEqual(observed, state.checkpoint))) return;
    if (!view.isCurrentSaveRequest(captured)) return;
    const snapshot = await request(view, "sync-checkpoint", {}, ["sync-checkpoint-ready", "sync-checkpoint-rejected"], 120000);
    if (snapshot.type === "sync-checkpoint-rejected" && snapshot.reason === "save-in-progress") {
      // A Vault modify event can arrive after our write but before the Viewer
      // acknowledges its save. Wait for the serialized host queue, then retry
      // this reconciliation without turning the transient busy response into
      // a permanent per-file pause.
      const saveQueue = plugin.saveQueue;
      if (saveQueue && typeof saveQueue.then === "function") await saveQueue;
      if (disposed || plugin.isUnloading || view.teardownStarted ||
          currentFile(view) !== file || !view.isCurrentSaveRequest(captured)) return;
      schedule(file, "save-settled");
      return;
    }
    if (snapshot.type !== "sync-checkpoint-ready" || snapshot.ok === false || !snapshot.data) throw new Error(snapshot.reason || "无法捕获安全编辑检查点");
    let record = await recovery(view, snapshot.data, snapshot.revision, "before-auto-merge", "draft", captured);
    if (!view.isCurrentSaveRequest(captured)) return;
    const cleanWithoutCheckpoint = !checkpoint && !snapshot.operations?.length && !snapshot.newAnnotations?.length && snapshot.dirty !== true;
    const local = cleanWithoutCheckpoint ? { bytes: captured.originalBytes } : await prepare(view, snapshot, captured);
    let localBytes = copy(local.bytes);
    if (checkpoint) localBytes = copy((await getClient().merge({ baseBytes: mergeBase, localBytes: checkpoint, remoteBytes: localBytes, actorId })).bytes);
    const merged = cleanWithoutCheckpoint ? { bytes: observed, changed: false, conflicts: [] }
      : await getClient().merge({ baseBytes: mergeBase, localBytes, remoteBytes: observed, actorId });
    const bytes = copy(merged.bytes);
    const inspected = await getClient().inspect({ bytes, ...(cleanWithoutCheckpoint ? {} : { baseBytes: mergeBase }) });
    const prepared = await request(view, "sync-apply-prepare", { expectedRevision: snapshot.revision }, ["sync-apply-prepared", "sync-apply-rejected"], 120000);
    if (prepared.ok !== true || prepared.prepared !== true) { schedule(file, "new-revision"); return; }
    try {
      await plugin.enqueueSave(async () => {
        if (disposed || plugin.isUnloading || view.teardownStarted) throw new Error("Reader 已关闭；同步检查点已保留");
        if (!view.isCurrentSaveRequest(captured) || state.version !== version) { schedule(file, "queue-changed"); return; }
        const latest = copy(await plugin.app.vault.readBinary(file));
        if (!bytesEqual(latest, observed)) { schedule(file, "disk-changed"); return; }
        if (!cleanWithoutCheckpoint) await persistCheckpoint(file, state, bytes, mergeBase);
        else { state.base = copy(bytes); state.version += 1; }
        if (!bytesEqual(bytes, observed) && !(await verifiedWrite(file, bytes, observed, state, () => view.isCurrentSaveRequest(captured)))) { schedule(file, "disk-changed"); return; }
        if (!cleanWithoutCheckpoint) await confirmCheckpoint(file, state, bytes);
        plugin.setDocumentBaseline(file.path, bytes);
        const previousOpenRequest = view.openRequest;
        const newOpenRequest = previousOpenRequest + 1;
        const data = buffer(bytes);
        const apply = request(view, "sync-apply", {
          id: prepared.id,
          previousOpenRequest, newOpenRequest, expectedRevision: snapshot.revision,
          data, syncState: stateFor(inspected), viewState: snapshot.viewState,
        }, ["sync-applied", "sync-apply-rejected"]);
        // The Viewer realm remains unchanged; only its PDF open request moves
        // forward. Match that next request within the captured renderer realm.
        view.openRequest = newOpenRequest;
        const applied = await apply;
        if (applied.ok !== true || applied.type !== "sync-applied") throw new Error(applied.reason || "合并后 Viewer 刷新失败");
        if (currentFile(view) !== file || view.documentId !== captured.documentId || view.openRequest !== newOpenRequest || (captured.rendererGeneration && view.rendererGeneration !== captured.rendererGeneration) || view.teardownStarted) throw new Error("刷新完成时 Reader 已切换；保留原文档恢复副本");
        view.originalBytes = copy(bytes);
        view.loadedBaseBytes = copy(bytes);
        view.annotationSyncState = stateFor(inspected);
        view.currentRevision = Number.isSafeInteger(applied.revision) ? applied.revision : 0;
        view.confirmedRevision = view.currentRevision;
        view.lastOpenSentRequest = newOpenRequest;
        view.syncNeedsRefresh = false;
        view.syncFailureShown = false;
        view.setStatus(`已同步并刷新：${file.path}`, { recoveryAction: false });
        if (!merged.conflicts?.length) await plugin.removeRecoveryCandidate(record);
      });
    } catch (error) {
      await plugin.markRecoveryCandidate(record, { status: "conflict", error: error.message });
      throw error;
    } finally {
      post(view, { type: "sync-apply-cancel", id: prepared.id, documentId: captured.documentId, openRequest: captured.openRequest });
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
            if (view.teardownStarted || disposed || currentFile(view) !== file || error.code === "SYNC_SESSION_CHANGED") continue;
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
    actorId, initializeView, save, schedule, prepareRecovery: prepare, showFailure: failure,
    checkOpenViews(reason) { for (const view of plugin.views) schedule(currentFile(view), reason); },
    handleMessage(view, message) {
      if (!message.type?.startsWith("sync-")) return false;
      const pending = view.syncRequests.get(message.id);
      if (!pending || !pending.replies.includes(message.type) || pending.documentId !== message.documentId || pending.rendererGeneration !== message.rendererGeneration || pending.rendererGeneration !== view.rendererGeneration) return true;
      const expected = pending.type === "sync-apply" ? pending.openRequest + 1 : pending.openRequest;
      if (message.openRequest !== expected && !(message.type === "sync-apply-rejected" && message.openRequest === pending.openRequest)) return true;
      pending.finish(message);
      return true;
    },
    renamed(file, oldPath) {
      const state = states.get(file);
      if (!state?.checkpoint) return;
      void plugin.enqueueSave(async () => {
        await persistCheckpoint(file, state, state.checkpoint, state.base);
        if (state.confirmedCheckpoint && bytesEqual(state.confirmedCheckpoint, state.checkpoint)) await confirmCheckpoint(file, state, state.checkpoint);
        // Preserve the old path checkpoint as a fallback after abrupt rename.
      }).catch((error) => { state.paused = true; state.failure = error.message; });
    },
    closeView(view, reason = "Reader closed") {
      const error = new Error(reason);
      error.code = "SYNC_SESSION_CHANGED";
      for (const pending of [...view.syncRequests.values()]) pending.finish(null, error);
    },
    dispose() {
      disposed = true;
      for (const timer of timers.values()) globalThis.clearTimeout(timer);
      timers.clear();
      for (const view of plugin.views) this.closeView(view);
      client?.dispose?.();
    },
  };
}

module.exports = { createPdfSyncHost };
