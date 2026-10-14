/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { sha256 } = require("@noble/hashes/sha2");
const { createPdfJournal } = require("./pdf-journal.cjs");

// Browser-only host coordination. The frozen Viewer remains the annotation
// writer; the lazy merge Worker adds identities and reconciles branches.
function createPdfSyncHost(plugin, api) {
  const { createPdfMergeClient, sha256Bytes, hashRuntime, normalizePath, isPdfFile,
    bytesEqual, makeToken, ensureAdapterDirectory, Notice } = api;
  const channel = "pdf-web-reader";
  const states = new WeakMap();
  const workerTimings = new Map();
  const timingNow = () => globalThis.performance?.now?.() ?? Date.now();
  const recordStage = (onStage, name, startedAt) => {
    if (typeof onStage !== "function") return;
    try { onStage(name, +(timingNow() - startedAt).toFixed(3)); } catch { /* Diagnostics never affect persistence. */ }
  };
  const measureStage = async (onStage, name, operation) => {
    const startedAt = timingNow();
    try { return await operation(); }
    finally { recordStage(onStage, name, startedAt); }
  };
  const measureSyncStage = (onStage, name, operation) => {
    const startedAt = timingNow();
    try { return operation(); }
    finally { recordStage(onStage, name, startedAt); }
  };
  const timers = new Map();
  const running = new Map();
  const closeWritebackTails = new Map();
  const closeWritebackGenerations = new Map();
  const closeWritebackSessionGenerations = new Map();
  const closeWritebackOpenAdmissions = new Map();
  const closeWritebackById = new Map();
  let closeWritebackDiscovery = null;
  let closeWritebackDiscoveryError = null;
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
  const fingerprint = (value) => hashRuntime
    ? hashRuntime.fingerprint(bytesView(value))
    : sha256Bytes(bytesView(value));
  const fingerprintMatches = (value, expected) => {
    if (hashRuntime) return hashRuntime.matches(bytesView(value), expected);
    const digest = sha256Bytes(bytesView(value));
    return expected === digest || String(expected || "").toLowerCase() === `sha256-v1:${digest}`.toLowerCase();
  };
  const hashFileKey = (value) => hashRuntime?.hashFileKey(value) ||
    String(value).replace(/^xxh64-v1:/i, "xxh64-v1-").replace(/^sha256-v1:/i, "sha256-v1-");
  const isSupportedHash = (value) => hashRuntime?.isSupportedHash(value) ??
    (typeof value === "string" && (/^[a-f0-9]{64}$/i.test(value) ||
      /^sha256-v1:[a-f0-9]{64}$/i.test(value) || /^xxh64-v1:[a-f0-9]{16}$/i.test(value)));
  const fingerprintChunks = (chunks) => {
    if (hashRuntime) return hashRuntime.fingerprintChunks(chunks);
    const hash = sha256.create();
    for (const chunk of chunks) hash.update(bytesView(chunk));
    return Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const createFingerprintAccumulator = (expectedHash = null) => {
    if (hashRuntime) return hashRuntime.createAccumulator(expectedHash);
    const hash = sha256.create();
    return {
      update(value) { hash.update(bytesView(value)); },
      digest() { return Array.from(hash.clone().digest(), (byte) => byte.toString(16).padStart(2, "0")).join(""); },
    };
  };
  const equal = (left, right) => bytesEqual(bytesView(left), bytesView(right));
  const patchMatches = (patch, value) => !!patch && Number.isSafeInteger(patch.baseLength) &&
    patch.baseLength === bytesView(value).byteLength && fingerprintMatches(value, patch.baseFingerprint);
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
    fingerprintMatches,
    hashFileKey,
    isSupportedHash,
    pathKey: (path) => sha256Bytes(new TextEncoder().encode(normalizePath(path))),
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
    currentFile(view) === file && view.ready && view.openAcknowledged !== false &&
    !view.teardownStarted && !closingViews.has(view));
  const closeRequested = (view) => closingViews.has(view) || view.teardownStarted;
  const hasLiveView = (file, state) => [...plugin.views].some((view) =>
    !state?.releasedViews?.has(view) && currentFile(view) === file &&
    view.openAcknowledged !== false && !view.teardownStarted);
  const updateBaselineForLiveViews = (file, state, value, targetPath = file.path) => {
    state ||= states.get(file);
    if (hasLiveView(file, state)) {
      plugin.setDocumentBaseline(targetPath, state ? matchingSnapshot(state, value) : value);
    } else {
      plugin.releaseDocumentBaseline?.(targetPath);
    }
  };
  const getState = (file) => {
    let state = states.get(file);
    if (!state) {
      state = { checkpoint: null, confirmedCheckpoint: null, base: null, baselineState: null, confirmedRevisionToken: null, inspectionState: null, inspectionSnapshot: null, version: 0, paused: false, loaded: false, ownHash: null, inFlight: 0, releasePending: false, releasedViews: new WeakSet() };
      states.set(file, state);
    }
    return state;
  };
  const clearState = (file, state) => {
    if (state.inFlight || hasLiveView(file, state)) return false;
    state.checkpoint = null;
    state.confirmedCheckpoint = null;
    state.base = null;
    state.baselineState = null;
    state.confirmedRevisionToken = null;
    state.inspectionState = null;
    state.inspectionSnapshot = null;
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
      onTaskTiming: (timing) => {
        if (!new Set(["prepareLocal", "merge"]).has(timing?.method)) return;
        if (typeof timing.saveTransactionId === "string" && timing.saveTransactionId) {
          const requests = workerTimings.get(timing.saveTransactionId) || [];
          requests.push(timing);
          workerTimings.set(timing.saveTransactionId, requests);
          return;
        }
        plugin.sessionLog?.record("performance", {
          fn: `PdfMergeClient.${timing.method}`,
          ...timing,
        });
      },
    });
    return client;
  };
  const stateFor = (result) => ({
    version: 1, actorId, identities: result.identities || result.annotations || [],
    ledger: result.ledger, stateDigest: result.stateDigest,
  });
  async function readStablePdf(file, targetPath = file.path, strictTarget = false) {
    const path = normalizePath(targetPath);
    const vault = plugin.app.vault;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (strictTarget && normalizePath(file.path) !== path) return null;
      const target = vault.getAbstractFileByPath(path);
      if (!target || (strictTarget && target !== file) || normalizePath(target.path) !== path || !isPdfFile(target)) return null;
      const value = bytesView(await vault.readBinary(target));
      const latest = vault.getAbstractFileByPath(path);
      if ((strictTarget && normalizePath(file.path) !== path) || !latest ||
          (strictTarget && latest !== file) || normalizePath(latest.path) !== path || !isPdfFile(latest)) return null;
      if (latest !== target) continue;
      return value;
    }
    return null;
  }
  async function loadedManifestIsCurrent(file, loaded) {
    const paths = journal.pathsFor(file.path);
    const adapter = plugin.app.vault.adapter;
    if (!(await adapter.exists(paths.manifest))) return false;
    let current;
    try { current = JSON.parse(await adapter.read(paths.manifest)); }
    catch { return false; }
    if (JSON.stringify(current) !== JSON.stringify(loaded.metadata)) return false;
    if (current?.schema !== loaded.metadata?.schema ||
        current.path !== normalizePath(file.path) ||
        current.status !== loaded.status) return false;
    if (current.schema === 1) {
      return current.hash === loaded.hash && current.length === loaded.length &&
        current.baseHash === loaded.baseHash && current.baseLength === loaded.baseLength;
    }
    return current.sequence === loaded.sequence &&
      current.checkpoint?.hash === loaded.hash &&
      current.checkpoint?.length === loaded.length &&
      current.base?.hash === loaded.baseHash &&
      current.base?.length === loaded.baseLength;
  }
  function validHash(value) { return isSupportedHash(value); }
  async function pendingWriteParent(file, loaded) {
    const manifest = loaded.metadata;
    const metadata = manifest?.metadata || {};
    if (manifest?.schema === 2 && manifest.checkpoint?.kind === "append") {
      let record;
      try {
        if (typeof manifest.checkpoint.head === "string") {
          record = JSON.parse(await plugin.app.vault.adapter.read(manifest.checkpoint.head));
        } else if (Array.isArray(manifest.checkpoint.records)) {
          record = manifest.checkpoint.records.at(-1);
        }
      } catch { return null; }
      const suffixLength = record?.suffix?.length ?? record?.suffixLength;
      const parentLength = record?.parentLength;
      const checkpoint = bytesView(loaded.checkpointBytes);
      if (record?.schema !== 1 || record.path !== normalizePath(file.path) ||
          record.sequence !== loaded.sequence || record.hash !== loaded.hash ||
          record.length !== loaded.length || !validHash(record.parentHash) ||
          !Number.isSafeInteger(parentLength) || parentLength < 1 || parentLength >= checkpoint.byteLength ||
          !Number.isSafeInteger(suffixLength) || suffixLength < 1 ||
          parentLength + suffixLength !== checkpoint.byteLength) return null;
      const parent = checkpoint.subarray(0, parentLength);
      if (!fingerprintMatches(parent, record.parentHash)) return null;
      return { hash: record.parentHash, length: parentLength };
    }
    if (metadata.writePhase === "preflight" &&
        validHash(metadata.writeParentHash) &&
        Number.isSafeInteger(metadata.writeParentLength) && metadata.writeParentLength > 0) {
      return { hash: metadata.writeParentHash, length: metadata.writeParentLength };
    }
    return null;
  }
  async function hasLegacyPrewriteFailure(file, loaded, disk) {
    const manifest = loaded.metadata;
    const metadata = manifest?.metadata || {};
    // Only old journals with no durable phase can use this narrow proof.
    if (manifest?.schema !== 2 || manifest.checkpoint?.kind !== "append" ||
        metadata.writePhase !== undefined || typeof metadata.documentId !== "string" ||
        !metadata.documentId || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 ||
        typeof plugin.listRecoveryCandidates !== "function" ||
        typeof plugin.readRecoveryBytes !== "function") return false;
    const allowlistedErrors = new Set(["PDF 已被替换或移除", "PDF 在磁盘检查期间被替换"]);
    const journalTime = Date.parse(manifest.updatedAt || "");
    if (!Number.isFinite(journalTime)) return false;
    const allCandidates = await plugin.listRecoveryCandidates();
    const isMatch = (candidate) => {
      const recovery = candidate?.metadata;
      const safeCandidateId = typeof recovery?.candidateId === "string"
        ? recovery.candidateId.replace(/[^a-zA-Z0-9_-]/g, "") : "";
      const validCandidateId = Boolean(safeCandidateId && recovery.candidateId === safeCandidateId);
      const supportedStorage = recovery?.schema === 1
        ? validCandidateId && (recovery.storage === undefined || recovery.storage === null) &&
          recovery.candidateFile === `${safeCandidateId}.pdf`
        : recovery?.schema === 2 && recovery.storage === "pdf-prefix-delta" &&
          validCandidateId && recovery.candidateFile === `${safeCandidateId}.delta`;
      if (!recovery || !supportedStorage || recovery.completed !== true || recovery.origin !== "sync" ||
          recovery.reason !== "before-save" || recovery.status !== "conflict" ||
          !allowlistedErrors.has(recovery.error) ||
          normalizePath(recovery.originalPath || "") !== normalizePath(file.path) ||
          recovery.documentId !== metadata.documentId || recovery.revision !== metadata.revision ||
          !fingerprintMatches(disk, recovery.baseFingerprint) || !validHash(recovery.outputHash) ||
          !Number.isSafeInteger(recovery.outputLength) || recovery.outputLength < 1) return false;
      if (metadata.requestId !== undefined && metadata.requestId !== null) {
        if (recovery.requestId !== metadata.requestId) return false;
      } else if (recovery.requestId !== undefined && recovery.requestId !== null) return false;
      const createdAt = Date.parse(recovery.createdAt || "");
      const updatedAt = Date.parse(recovery.updatedAt || "");
      return Number.isFinite(createdAt) && Number.isFinite(updatedAt) &&
        createdAt <= journalTime && journalTime <= updatedAt;
    };
    const matches = allCandidates.filter(isMatch);
    if (matches.length !== 1) return false;
    const candidate = matches[0];
    const bytes = bytesView(await plugin.readRecoveryBytes(candidate));
    const originalMetadata = candidate.metadata;
    if (bytes.byteLength !== originalMetadata.outputLength ||
        !fingerprintMatches(bytes, originalMetadata.outputHash)) return false;
    const fresh = await plugin.listRecoveryCandidates();
    const identity = originalMetadata.candidateId || candidate.candidatePath || candidate.metadataPath;
    if (typeof identity !== "string" || !identity) return false;
    const sameIdentity = fresh.filter((entry) =>
      (entry?.metadata?.candidateId || entry?.candidatePath || entry?.metadataPath) === identity);
    if (sameIdentity.length !== 1) return false;
    const current = sameIdentity[0].metadata;
    return current.completed === true && current.origin === originalMetadata.origin &&
      current.schema === originalMetadata.schema && current.storage === originalMetadata.storage &&
      current.candidateFile === originalMetadata.candidateFile &&
      current.reason === originalMetadata.reason && current.status === originalMetadata.status &&
      current.error === originalMetadata.error && current.originalPath === originalMetadata.originalPath &&
      current.documentId === originalMetadata.documentId && current.revision === originalMetadata.revision &&
      current.requestId === originalMetadata.requestId &&
      current.baseFingerprint === originalMetadata.baseFingerprint &&
      current.createdAt === originalMetadata.createdAt && current.updatedAt === originalMetadata.updatedAt &&
      current.outputHash === originalMetadata.outputHash && current.outputLength === originalMetadata.outputLength;
  }
  async function markPendingWriteInvoked(file, pendingRecord, { append = false, targetPath = file.path } = {}) {
    const expectedPath = normalizePath(targetPath);
    const paths = journal.pathsFor(expectedPath);
    const adapter = plugin.app.vault.adapter;
    if (!(await adapter.exists(paths.manifest))) throw new Error("Pending checkpoint is missing before write");
    const currentText = await adapter.read(paths.manifest);
    if (currentText !== JSON.stringify(pendingRecord) ||
        pendingRecord?.status !== "pending" || pendingRecord.path !== expectedPath ||
        pendingRecord.metadata?.writePhase !== "preflight") {
      throw new Error("Pending checkpoint changed before source write");
    }
    const invokedRecord = { ...pendingRecord,
      metadata: { ...pendingRecord.metadata, writePhase: "invoked",
        ...(append ? { appendPhase: "append-invoked" } : {}) },
      updatedAt: new Date().toISOString() };
    const invokedText = JSON.stringify(invokedRecord);
    await adapter.write(paths.manifest, invokedText);
    if (await adapter.read(paths.manifest) !== invokedText) {
      throw new Error("Pending checkpoint write phase verification failed");
    }
    return invokedRecord;
  }
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
      else if (loaded.status === "pending") {
        // A pending journal is ambiguous only if the source contains neither
        // its exact verified parent nor its exact intended output. These two
        // byte matches distinguish a write that never started from one that
        // completed before confirmation without ever retrying an append.
        const primaryIsVerified = await loadedManifestIsCurrent(file, loaded);
        const disk = primaryIsVerified ? await readStablePdf(file) : null;
        const primaryStillVerified = disk && await loadedManifestIsCurrent(file, loaded);
        if (!primaryIsVerified || !primaryStillVerified) {
          state.paused = true;
          state.failure = "本地同步检查点校验失败：最新检查点清单未通过验证";
        } else if (disk && equal(disk, checkpoint)) {
          await confirmCheckpoint(file, state, checkpoint);
        } else if (!disk) {
          state.paused = true;
          state.failure = "上次同步检查点尚未确认写回，已保留本地版本";
        } else {
          const parent = await pendingWriteParent(file, loaded);
          const metadata = loaded.metadata?.metadata || {};
          const isAppend = loaded.metadata?.schema === 2 && loaded.metadata.checkpoint?.kind === "append";
          const appendPreflight = !isAppend ||
            (typeof metadata.appendAttemptId === "string" && metadata.appendPhase === "preflight");
          const recordedParentMatches = parent && metadata.writeParentHash === parent.hash &&
            metadata.writeParentLength === parent.length;
          const safePreflight = metadata.writePhase === "preflight" && appendPreflight && recordedParentMatches &&
            parent.length === disk.byteLength && fingerprintMatches(disk, parent.hash);
          const legacyProof = !loaded.metadata?.metadata?.writePhase &&
            await hasLegacyPrewriteFailure(file, loaded, disk);
          if (!safePreflight && !legacyProof) {
            state.paused = true;
            state.failure = "上次同步检查点尚未确认写回，已保留本地版本";
          }
        }
        // If disk still equals the verified write parent, retain the complete
        // checkpoint as a local branch. The next coordinated merge/save includes it.
      } else {
        state.paused = true;
        state.failure = "上次同步检查点尚未确认写回，已保留本地版本";
      }
    } catch (error) {
      state.paused = true;
      state.failure = `本地同步检查点校验失败：${error.message}`;
    }
    })().finally(() => { state.loaded = true; state.loadPromise = null; });
    state.loadPromise = pending;
    return pending;
  }
  async function persistCheckpoint(file, state, bytes, base, metadata = {}, writeParentBytes = base, targetPath = file.path) {
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载；本地恢复副本已保留");
    const parent = bytesView(writeParentBytes);
    const pendingRecord = await journal.beginFull({ path: normalizePath(targetPath), checkpointBytes: bytes, baseBytes: base,
      metadata: { ...metadata, writePhase: "preflight",
        writeParentHash: fingerprint(parent), writeParentLength: parent.byteLength } });
    const checkpoint = state.checkpoint && equal(state.checkpoint, bytes)
      ? state.checkpoint
      : bytesView(bytes);
    const baseSnapshot = state.base && equal(state.base, base)
      ? state.base
      : equal(checkpoint, base) ? checkpoint : copy(base);
    state.checkpoint = checkpoint;
    state.base = baseSnapshot;
    state.version += 1;
    return pendingRecord;
  }
  async function confirmCheckpoint(file, state, bytes, targetPath = file.path) {
    await journal.confirm(normalizePath(targetPath), fingerprint(bytes), bytesView(bytes).byteLength);
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
  function reportUnstartedAppendFailure(view, message) {
    view.setStatus(`保存未完成：${message}。已保留可恢复本地副本。`, { recoveryAction: true });
    if (!view.syncFailureShown) {
      view.syncFailureShown = true;
      new Notice(`PDF 保存未完成：${message}。使用“恢复最近的 PDF 自动保存副本”取回本地版本。`, 8000);
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
      if (state.inspectionSnapshot && equal(state.inspectionSnapshot, bytes) &&
          state.baselineState && state.inspectionState) {
        view.pdfSyncBaselineState = state.baselineState;
        view.pdfSyncConfirmedRevisionToken = state.confirmedRevisionToken || state.baselineState.revisionToken || null;
        return state.inspectionState;
      }
      // Host unit fixtures deliberately omit Worker. Loading the plugin itself
      // never requires a Worker; actual editing will report capability errors.
      if (typeof globalThis.Worker !== "function") return { version: 1, actorId, identities: [] };
      try {
        const result = await getClient().inspect({
          bytes: workerSnapshot(bytes), fastOpen: true,
          sourceMtimeMs: Number.isFinite(file?.stat?.mtime) ? file.stat.mtime : null,
        });
        state.baselineState = result.baselineState || null;
        state.confirmedRevisionToken = result.revisionToken || result.baselineState?.revisionToken || null;
        view.pdfSyncBaselineState = state.baselineState;
        view.pdfSyncConfirmedRevisionToken = state.confirmedRevisionToken;
        view.syncDisabledReason = null;
        state.inspectionState = stateFor(result);
        state.inspectionSnapshot = matchingSnapshot(state, bytes);
        return state.inspectionState;
      } catch (error) {
        view.syncDisabledReason = error.message;
        return { version: 1, actorId, identities: [], disabledReason: error.message };
      }
    } finally { lease?.release(); settle(); }
  }
  async function prepare(view, message, captured = null, options = {}) {
    if (view.syncDisabledReason) throw new Error(view.syncDisabledReason);
    const file = captured?.file || currentFile(view);
    const sourceBaselineState = options.sourceBaselineState || view.pdfSyncBaselineState || getState(file).baselineState;
    return getClient().prepareLocal({
      baseBytes: workerSnapshot(captured?.loadedBaseBytes || captured?.originalBytes || view.loadedBaseBytes || view.originalBytes),
      draftBytes: workerSnapshot(message.data), operations: message.operations || [],
      newAnnotations: message.newAnnotations || [], actorId,
      checkpointBytes: workerSnapshot(getState(captured?.file || currentFile(view)).confirmedCheckpoint || captured?.originalBytes || view.originalBytes),
      saveTransactionId: options.saveTransactionId || message.saveTransactionId || null,
      dirtyState: message.dirtyState || null,
      documentRevisionMatch: options.documentRevisionMatch ?? null,
      forceFullFingerprints: options.forceFullFingerprints === true,
      baselineState: options.documentRevisionMatch === false ? null : sourceBaselineState,
      sourceMtimeMs: Number.isFinite(sourceBaselineState?.revisionToken?.sourceMtimeMs)
        ? sourceBaselineState.revisionToken.sourceMtimeMs
        : Number.isFinite(file?.stat?.mtime) ? file.stat.mtime : null,
    });
  }
  async function prepareRecovery(view, message, captured = null) {
    const file = captured?.file || currentFile(view);
    const state = getState(file);
    const settle = beginState(file, state);
    let lease;
    try {
      lease = await acquireHeavyLease(view, file, "sync-recovery", message?.heavyLeaseId || null);
      return await prepare(view, message, captured, {
        documentRevisionMatch: false,
        forceFullFingerprints: true,
      });
    } finally {
      lease?.release();
      settle();
    }
  }
  async function recovery(view, bytes, revision, reason, status = "pending",
    captured = view.captureSaveRequest(), requestId = null) {
    return plugin.writeRecoveryCandidate({ view, data: buffer(bytes),
      originalBytes: captured.originalBytes, documentPath: captured.documentPath || captured.file?.path,
      documentId: captured.documentId, filename: captured.filename || captured.file?.basename,
      openRequest: captured.openRequest, revision, requestId, origin: "sync", reason, status });
  }
  async function verifiedWrite(file, bytes, observed, state, stillCurrent = () => true,
    onWriteInvoked = async () => {}, onWriteIssued = () => {}, targetPath = file.path,
    onStage = null) {
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    const requestedPath = normalizePath(targetPath);
    const targetIsCurrent = () => normalizePath(file.path) === requestedPath &&
      plugin.app.vault.getAbstractFileByPath(requestedPath) === file;
    const latest = plugin.app.vault.getAbstractFileByPath(requestedPath);
    if (latest !== file) throw new Error("PDF 已被替换或移除");
    // Persist the intent before the final source read. The byte/path/request
    // checks after it contain no further asynchronous work before modifyBinary.
    state.ownHash = fingerprint(bytes);
    await measureStage(onStage, "writeIntentJournalMs", onWriteInvoked);
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    const before = await measureStage(onStage, "sourcePreflightReadMs", () => plugin.app.vault.readBinary(file));
    if (!targetIsCurrent()) throw new Error("PDF 在磁盘检查期间已移动或被替换");
    if (!measureSyncStage(onStage, "sourcePreflightCompareMs", () => equal(before, observed))) return false;
    if (!targetIsCurrent()) throw new Error("PDF 在磁盘检查期间被替换");
    if (!stillCurrent()) throw new Error("Reader 已切换；未覆盖原 PDF");
    // Public DataAdapter has no atomic compare-and-swap. A sync process may
    // still race between this comparison and modifyBinary; readback catches
    // observed mismatches, but cannot eliminate that remaining race window.
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    const writePayload = measureSyncStage(onStage, "writePayloadCopyMs", () => buffer(bytes));
    onWriteIssued();
    await measureStage(onStage, "sourceWriteMs", () => plugin.app.vault.modifyBinary(file, writePayload));
    if (!targetIsCurrent()) throw new Error("PDF 在写入期间被替换；已保留恢复副本");
    const after = await measureStage(onStage, "sourceReadbackMs", () => plugin.app.vault.readBinary(file));
    if (!targetIsCurrent()) throw new Error("PDF 在写后校验期间已移动或被替换；已保留恢复副本");
    const afterBytes = bytesView(after);
    if (!measureSyncStage(onStage, "sourceReadbackVerifyMs", () =>
      equal(afterBytes, bytes))) {
      throw new Error("PDF 写后内容发生变化，已保留检查点");
    }
    if (state.checkpoint && equal(state.checkpoint, afterBytes)) state.checkpoint = afterBytes;
    if (state.confirmedCheckpoint && equal(state.confirmedCheckpoint, afterBytes)) state.confirmedCheckpoint = afterBytes;
    if (state.base && equal(state.base, afterBytes)) state.base = afterBytes;
    updateBaselineForLiveViews(file, state, afterBytes, targetPath);
    return afterBytes;
  }
  async function verifiedAppend(file, observed, patch, stillCurrent = () => true,
    onWriteInvoked = async () => {}, onAppendIssued = () => {}, targetPath = file.path,
    strictTarget = false, onStage = null) {
    const vault = plugin.app.vault;
    if (typeof vault.appendBinary !== "function") return null;
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    const requestedPath = normalizePath(targetPath);
    const currentPdf = () => {
      const latest = vault.getAbstractFileByPath(requestedPath);
      return (!strictTarget || (normalizePath(file.path) === requestedPath && latest === file)) &&
        latest && normalizePath(latest.path) === requestedPath && isPdfFile(latest)
        ? latest
        : null;
    };
    if (!currentPdf()) {
      const error = new Error("PDF 已被替换或移除");
      error.appendNotStarted = true;
      throw error;
    }
    await measureStage(onStage, "writeIntentJournalMs", onWriteInvoked);
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    let target = null;
    let before = null;
    // Vault can refresh a TFile object while readBinary is pending. Re-resolve
    // the same path and verify its bytes before deciding that the document was
    // replaced; the byte comparison still prevents appending onto changed data.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      target = currentPdf();
      if (!target) {
        const error = new Error("PDF 已被替换或移除");
        error.appendNotStarted = true;
        throw error;
      }
      try {
        before = bytesView(await measureStage(onStage, "sourcePreflightReadMs", () => vault.readBinary(target)));
      } catch (error) {
        error.appendNotStarted = true;
        throw error;
      }
      if (strictTarget && normalizePath(file.path) !== requestedPath) {
        const error = new Error("PDF 在磁盘检查期间已移动或被替换");
        error.appendNotStarted = true;
        throw error;
      }
      const latest = currentPdf();
      if (!latest) {
        const error = new Error("PDF 已被替换或移除");
        error.appendNotStarted = true;
        throw error;
      }
      if (latest !== target) continue;
      break;
    }
    if (!target || currentPdf() !== target) {
      const error = new Error("PDF 在磁盘检查期间被替换");
      error.appendNotStarted = true;
      throw error;
    }
    if (!measureSyncStage(onStage, "sourcePreflightCompareMs", () =>
      equal(before, observed) && patchMatches(patch, before))) return null;
    if (!stillCurrent()) {
      const error = new Error("Reader 已切换；未覆盖原 PDF");
      error.appendNotStarted = true;
      throw error;
    }
    if (disposed || plugin.isUnloading) {
      const error = new Error("插件已卸载，未覆盖原 PDF");
      error.appendNotStarted = true;
      throw error;
    }
    // appendBinary is deliberately issued once. If it rejects or readback is
    // incomplete, the pending journal is the recovery source; a blind retry
    // could duplicate a partially appended PDF revision.
    const state = states.get(file);
    if (state) state.ownHash = patch.outputFingerprint;
    if (!stillCurrent()) throw new Error("Reader 已切换；未覆盖原 PDF");
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载，未覆盖原 PDF");
    if (currentPdf() !== target) throw new Error("PDF 已被替换或移除");
    const appendPayload = measureSyncStage(onStage, "writePayloadCopyMs", () => buffer(patch.suffix));
    onAppendIssued();
    await measureStage(onStage, "sourceWriteMs", () => vault.appendBinary(target, appendPayload));
    const after = await measureStage(onStage, "sourceReadbackMs", () => readStablePdf(file, requestedPath, strictTarget));
    if (!after) throw new Error("PDF 在追加期间被替换；已保留恢复副本");
    if (!measureSyncStage(onStage, "sourceReadbackVerifyMs", () =>
      after.byteLength === patch.outputLength && fingerprintMatches(after, patch.outputFingerprint))) {
      throw new Error("PDF 追加后的内容未通过校验；已保留检查点，未自动重试");
    }
    updateBaselineForLiveViews(file, states.get(file), after, requestedPath);
    return after;
  }
  async function rollbackUnstartedWrite(file, pendingRecord, appendAttemptId = null, targetPath = file.path) {
    const paths = journal.pathsFor(normalizePath(targetPath));
    const adapter = plugin.app.vault.adapter;
    if (!(await adapter.exists(paths.manifest))) return false;
    const currentText = await adapter.read(paths.manifest);
    let current;
    try { current = JSON.parse(currentText); }
    catch { return false; }
    if (currentText !== JSON.stringify(pendingRecord) ||
        current?.schema !== 2 || current.status !== "pending" ||
        current.path !== normalizePath(targetPath) ||
        current.sequence !== pendingRecord?.sequence ||
        current.checkpoint?.hash !== pendingRecord?.checkpoint?.hash ||
        current.checkpoint?.length !== pendingRecord?.checkpoint?.length ||
        current.metadata?.writePhase !== pendingRecord?.metadata?.writePhase ||
        !["preflight", "invoked"].includes(current.metadata?.writePhase) ||
        (appendAttemptId !== null && (current.metadata?.appendAttemptId !== appendAttemptId ||
          current.metadata?.appendPhase !== pendingRecord?.metadata?.appendPhase))) {
      return false;
    }

    if (await adapter.exists(paths.previousManifest)) {
      const previousText = await adapter.read(paths.previousManifest);
      let previous;
      try { previous = JSON.parse(previousText); }
      catch { return false; }
      if (![1, 2].includes(previous?.schema) ||
          previous.path !== normalizePath(targetPath)) return false;
      if (!(await adapter.exists(paths.manifest)) ||
          await adapter.read(paths.manifest) !== currentText) return false;
      await adapter.write(paths.manifest, previousText);
      if (await adapter.read(paths.manifest) !== previousText) {
        throw new Error("Checkpoint manifest rollback verification failed");
      }
      try {
        const restored = await journal.load(file.path);
        if (!restored || restored.status !== previous.status ||
            restored.hash !== (previous.schema === 1 ? previous.hash : previous.checkpoint?.hash) ||
            restored.length !== (previous.schema === 1 ? previous.length : previous.checkpoint?.length)) {
          throw new Error("Prior checkpoint manifest did not verify after rollback");
        }
      } catch (error) {
        const stillPrevious = await adapter.exists(paths.manifest) &&
          await adapter.read(paths.manifest) === previousText;
        if (!stillPrevious) {
          const race = new Error("Checkpoint manifest changed during rollback verification; newer state was preserved");
          race.cause = error;
          throw race;
        }
        await adapter.write(paths.manifest, currentText);
        if (await adapter.read(paths.manifest) !== currentText) {
          throw new Error("Checkpoint manifest rollback could not restore the pending record");
        }
        throw error;
      }
      return true;
    }

    if (!(await adapter.exists(paths.manifest)) ||
        await adapter.read(paths.manifest) !== currentText) return false;
    await adapter.remove(paths.manifest);
    if (await adapter.exists(paths.manifest)) {
      throw new Error("Checkpoint manifest removal verification failed");
    }
    return true;
  }
  async function journaledWrite({ file, state, bytes, baseBytes, parentBytes, metadata,
    stillCurrent = () => true, targetPath = file.path, onWriteInvoked = async () => {}, onStage = null }) {
    const expectedPath = normalizePath(targetPath);
    const pendingRecord = await measureStage(onStage, "checkpointPersistMs",
      () => persistCheckpoint(file, state, bytes, baseBytes, metadata, parentBytes, expectedPath));
    let invokedRecord = null;
    let writeIssued = false;
    try {
      const written = await verifiedWrite(file, bytes, parentBytes, state, stillCurrent,
        async () => {
          await onWriteInvoked();
          invokedRecord = await markPendingWriteInvoked(file, pendingRecord, { targetPath: expectedPath });
        },
        () => { writeIssued = true; }, expectedPath, onStage);
      if (!writeIssued && !written &&
          !(await rollbackUnstartedWrite(file, invokedRecord || pendingRecord, null, expectedPath))) {
        throw new Error("Pending checkpoint changed before full write; recovery copy remains available");
      }
      return written;
    } catch (error) {
      if (!writeIssued) {
        try {
          error.unstartedWriteRolledBack = await rollbackUnstartedWrite(
            file, invokedRecord || pendingRecord, null, expectedPath,
          );
        } catch (rollbackError) {
          error.unstartedWriteRollbackError = rollbackError;
        }
      }
      throw error;
    }
  }
  async function journaledAppend({ file, baseBytes, parentBytes, patch, metadata,
    stillCurrent = () => true, targetPath = file.path, onWriteInvoked = async () => {},
    strictTarget = false, onStage = null }) {
    const expectedPath = normalizePath(targetPath);
    const appendAttemptId = makeToken();
    const parent = bytesView(parentBytes);
    const attemptMetadata = { ...metadata, writePhase: "preflight",
      writeParentHash: fingerprint(parent), writeParentLength: parent.byteLength,
      appendAttemptId, appendPhase: "preflight" };
    const pendingRecord = await measureStage(onStage, "checkpointPersistMs", () => journal.beginAppend({ path: expectedPath,
      baseBytes, parentBytes, suffix: patch.suffix,
      outputFingerprint: patch.outputFingerprint, outputLength: patch.outputLength,
      metadata: attemptMetadata }));
    let invokedRecord = null;
    let appendIssued = false;
    try {
      const wrote = await verifiedAppend(file, parentBytes, patch, stillCurrent,
        async () => {
          await onWriteInvoked();
          invokedRecord = await markPendingWriteInvoked(file, pendingRecord, { append: true, targetPath: expectedPath });
        },
        () => { appendIssued = true; }, expectedPath, strictTarget, onStage);
      if (!appendIssued && !wrote &&
          !(await rollbackUnstartedWrite(file, invokedRecord || pendingRecord, appendAttemptId, expectedPath))) {
        throw new Error("Pending checkpoint changed before append; recovery copy remains available");
      }
      return wrote;
    } catch (error) {
      if (!appendIssued) {
        try {
          error.unstartedAppendRolledBack = await rollbackUnstartedWrite(
            file, invokedRecord || pendingRecord, appendAttemptId, expectedPath,
          );
        } catch (rollbackError) {
          error.unstartedAppendRollbackError = rollbackError;
        }
      }
      throw error;
    }
  }
  async function save(view, captured, message) {
    const file = captured.file;
    const state = getState(file);
    const settle = beginState(file, state);
    const saveStartedAt = timingNow();
    const saveTransactionId = typeof message?.saveTransactionId === "string" && message.saveTransactionId
      ? message.saveTransactionId : (message?.requestId || makeToken());
    const hostStagesMs = Object.create(null);
    const hostStageCounts = Object.create(null);
    const recordHostStage = (name, durationMs) => {
      hostStagesMs[name] = +((hostStagesMs[name] || 0) + durationMs).toFixed(3);
      hostStageCounts[name] = (hostStageCounts[name] || 0) + 1;
    };
    const timed = (name, operation) => measureStage(recordHostStage, name, operation);
    let documentRevisionMatch = null;
    let revisionPreflightMs = null;
    let saveOutcome = "failed";
    let saveError = null;
    const recordSaveSummary = () => {
      const requests = workerTimings.get(saveTransactionId) || [];
      const workerTimingsForSave = requests.map((timing) => ({ ...timing, coreStages: timing.coreStages || {} }));
      const prepareTiming = workerTimingsForSave.filter((timing) => timing.method === "prepareLocal").at(-1) || null;
      const cores = workerTimingsForSave.map((timing) => timing.coreStages);
      const sum = (key) => {
        const values = cores.map((core) => Number(core[key])).filter(Number.isFinite);
        return values.length ? +values.reduce((total, value) => total + value, 0).toFixed(3) : null;
      };
      const mergeTotalMs = workerTimingsForSave.filter((timing) => timing.method === "merge")
        .map((timing) => Number(timing.coreStages.coreTotalMs)).filter(Number.isFinite)
        .reduce((total, value) => total + value, 0);
      const fingerprints = cores.map((core) => core.fingerprint).filter(Boolean);
      const modes = fingerprints.map((item) => item.mode);
      const mode = modes.includes("FULL") ? "FULL" : modes.includes("PARTIAL") ? "PARTIAL" : modes[0] || "UNKNOWN";
      const fallbackReason = documentRevisionMatch === false ? "SOURCE_REVISION_MISMATCH"
        : cores.find((core) => core.fallbackReason)?.fallbackReason || null;
      const core = prepareTiming?.coreStages || {};
      try { plugin.sessionLog?.record("performance", {
        fn: "PdfSyncHost.save",
        saveTransactionId,
        status: saveOutcome,
        documentRevisionMatch,
        baselineCacheHit: core.baselineCacheHit ?? null,
        baselineFingerprintPages: sum("baselineFingerprintPages"),
        baselineFingerprintMs: sum("baselineFingerprintMs"),
        draftFingerprintPages: sum("draftFingerprintPages"),
        draftFingerprintMs: sum("draftFingerprintMs"),
        remoteFingerprintPages: sum("remoteFingerprintPages"),
        outputFingerprintPages: sum("outputFingerprintPages"),
        checkpointFingerprintPages: core.checkpointFingerprintPages ?? null,
        checkpointFingerprintMs: core.checkpointFingerprintMs ?? null,
        dirtyPageCount: core.dirtyPageCount ?? message?.dirtyState?.dirtyPageIndices?.length ?? null,
        dirtyAnnotationCount: core.dirtyAnnotationCount ?? message?.dirtyState?.dirtyAnnotationIds?.length ?? null,
        revisionTokenMs: sum("revisionTokenMs"),
        pdfParseMs: sum("pdfParseWallMs"),
        annotationScanMs: sum("annotationScanTotalMs"),
        annotationReconciliationMs: sum("annotationReconciliationMs"),
        incrementalOutputMs: sum("incrementalOutputMs"),
        prepareLocalTotalMs: prepareTiming?.coreStages?.coreTotalMs ?? null,
        mergeTotalMs: mergeTotalMs ? +mergeTotalMs.toFixed(3) : null,
        workerRoundTripMs: requests.length ? +requests.reduce((total, timing) => total + (timing.workerRoundTripMs || 0), 0).toFixed(3) : null,
        workerRequestCount: requests.length,
        revisionPreflightMs,
        hostStageTimingSchema: 1,
        hostStagesMs: { ...hostStagesMs },
        hostStageCounts: { ...hostStageCounts },
        saveTotalMs: +(timingNow() - saveStartedAt).toFixed(3),
        fallbackTriggered: Boolean(cores.some((item) => item.fallbackTriggered) || documentRevisionMatch === false),
        fallbackReason,
        fingerprint: { mode, reason: fallbackReason || fingerprints.at(-1)?.reason || "WORKER_TIMING_UNAVAILABLE" },
        ...(saveError ? { errorCode: saveError.code || null, errorName: saveError.name || "Error" } : {}),
      }); } catch { /* Diagnostics must never hold up a confirmed or failed save. */ }
      workerTimings.delete(saveTransactionId);
    };
    let record;
    let lease;
    let sourceWriteConfirmed = false;
    try {
      lease = await timed("heavyLeaseWaitMs", () => acquireHeavyLease(view, file, "sync-save", message?.heavyLeaseId || null));
      const queueEnqueuedAt = timingNow();
      await plugin.enqueueSave(async () => {
        recordHostStage("saveQueueWaitMs", timingNow() - queueEnqueuedAt);
        record = await timed("recoveryCandidateWriteMs",
          () => recovery(view, message.data, message.revision, "before-save", "pending", captured, message.requestId));
        try {
          if (disposed || plugin.isUnloading) throw new Error("插件已卸载；恢复副本已保留");
          if (!view.isCurrentSaveRequest(captured)) throw new Error("保存对应的文档已切换");
          if (state.paused) throw new Error(state.failure || "此文档自动合并已暂停");
          const revisionStartedAt = timingNow();
          // The source PDF opened by PDF.js is immutable for this Viewer
          // lifetime. After a confirmed save the Vault now contains a newer
          // checkpoint, so validate the disk against that checkpoint token,
          // while the page-fingerprint cache remains bound to the Viewer source.
          const token = state.confirmedRevisionToken || state.baselineState?.revisionToken;
          const stat = file?.stat;
          if (token && Number.isFinite(token.byteLength) && Number.isFinite(stat?.size) && Number.isFinite(stat?.mtime) && Number.isFinite(token.sourceMtimeMs)) {
            documentRevisionMatch = measureSyncStage(recordHostStage, "revisionTokenCompareMs",
              () => token.byteLength === stat.size && token.sourceMtimeMs === stat.mtime);
          } else if (!token) {
            // An untrusted/restarted state has no revision token yet. Establish
            // the first baseline exactly; future saves can use size + mtime and
            // still keep the later authoritative exact-byte write check.
            const preflightBytes = bytesView(await timed("revisionSourceReadMs", () => plugin.app.vault.readBinary(file)));
            documentRevisionMatch = measureSyncStage(recordHostStage, "revisionSourceCompareMs",
              () => equal(preflightBytes, captured.originalBytes));
          }
          revisionPreflightMs = +(timingNow() - revisionStartedAt).toFixed(3);
          if (!documentRevisionMatch) {
            state.baselineState = null;
            state.confirmedRevisionToken = null;
            state.inspectionState = null;
            state.inspectionSnapshot = null;
          }
          const dirtyState = message.dirtyState || {
            dirtyAnnotationIds: (message.operations || []).map((entry) => entry?.uuid).filter((entry) => typeof entry === "string"),
            dirtyPageIndices: [...new Set([...(message.operations || []), ...(message.newAnnotations || [])]
              .map((entry) => entry?.pageIndex).filter(Number.isSafeInteger))],
            newAnnotationIds: (message.newAnnotations || []).map((entry) => entry?.uuid).filter((entry) => typeof entry === "string"),
            deletedAnnotationIds: (message.operations || []).filter((entry) => entry?.action === "delete" || entry?.deleted).map((entry) => entry?.uuid).filter((entry) => typeof entry === "string"),
          };
          const local = await timed("prepareLocalWallMs", () => prepare(view, { ...message, saveTransactionId, dirtyState }, captured, {
            saveTransactionId,
            documentRevisionMatch,
            sourceBaselineState: view.pdfSyncBaselineState || state.baselineState,
            // The exact byte comparison is authoritative. If another writer
            // changed the source, keep the old merge path and require full
            // lineage verification before attempting a reconciliation.
            forceFullFingerprints: documentRevisionMatch === false,
          }));
          let bytes = local.bytes;
          let metadata = local;
          if (state.checkpoint && !equal(state.checkpoint, captured.originalBytes)) {
            const checkpointMerge = await timed("checkpointMergeWallMs", () => getClient().merge({
              baseBytes: workerSnapshot(state.base), localBytes: workerSnapshot(state.checkpoint),
              remoteBytes: workerSnapshot(bytes), actorId, saveTransactionId,
              baselineState: documentRevisionMatch === true ? view.pdfSyncBaselineState || null : null,
              forceFullFingerprints: documentRevisionMatch === false,
            }));
            bytes = checkpointMerge.bytes;
            metadata = checkpointMerge;
          }
          let result;
          let observed;
          for (let attempt = 0; attempt < 3; attempt++) {
            observed = bytesView(await timed("saveDiskReadMs", () => plugin.app.vault.readBinary(file)));
            const diskMatchesBase = measureSyncStage(recordHostStage, "saveDiskBaseCompareMs",
              () => equal(observed, captured.originalBytes));
            if (!diskMatchesBase) {
              documentRevisionMatch = false;
              state.baselineState = null;
              state.confirmedRevisionToken = null;
              state.inspectionState = null;
              state.inspectionSnapshot = null;
            }
            const localPatchApplies = measureSyncStage(recordHostStage, "savePatchCompareMs",
              () => patchMatches(local.patch, observed));
            // PDF.js may already have appended the draft's object changes to
            // the exact source PDF. If the prepared output is a strict byte
            // prefix extension of the observed source, its tail is itself a
            // safe patch; this avoids parsing/re-serializing all three PDFs.
            const preparedPrefixPatch = diskMatchesBase
              ? measureSyncStage(recordHostStage, "preparedPrefixCompareMs", () => prefixPatch(bytes, observed)) : null;
            result = diskMatchesBase && (preparedPrefixPatch || !local.patch || localPatchApplies)
              ? { bytes, patch: preparedPrefixPatch || local.patch, changed: true, conflicts: [] }
              : await timed("fallbackMergeWallMs", () => getClient().merge({
                baseBytes: workerSnapshot(state.base), localBytes: workerSnapshot(bytes),
                remoteBytes: workerSnapshot(observed), actorId, patchOnly: true, saveTransactionId,
                baselineState: diskMatchesBase && documentRevisionMatch === true ? view.pdfSyncBaselineState || null : null,
                forceFullFingerprints: !diskMatchesBase || documentRevisionMatch === false,
              }));
            const patch = patchMatches(result.patch, observed) ? result.patch : null;
            if (result.bytes !== undefined) bytes = result.bytes;
            else if (!patch) throw new Error("增量保存结果与磁盘基线不匹配；恢复副本已保留");
            if ((result.identities || result.annotations) && result.ledger) metadata = result;
            else if (!diskMatchesBase) metadata = null;
            // Keep the unmerged local branch when a timestamp winner replaces it.
            if (result.conflicts?.length) await plugin.markRecoveryCandidate(record, { status: "draft", reason: "superseded-local-version" });
            const journalMetadata = {
              actorId: message.actorId || actorId,
              saveTransactionId,
              requestId: message.requestId,
              revision: message.revision,
              operations: message.operations || [],
              newAnnotations: message.newAnnotations || [],
              documentId: captured.documentId,
            };
            let wrote;
            if (patch && typeof plugin.app.vault.appendBinary === "function") {
              wrote = await timed("journaledAppendWallMs", () => journaledAppend({ file, baseBytes: state.base,
                parentBytes: observed, patch, metadata: journalMetadata,
                stillCurrent: () => view.isCurrentSaveRequest(captured), onStage: recordHostStage }));
              if (wrote) {
                bytes = wrote;
                state.checkpoint = bytes;
                state.version += 1;
                await timed("checkpointConfirmMs", () => confirmCheckpoint(file, state, bytes));
                sourceWriteConfirmed = true;
              }
            } else {
              if (!bytes) {
                bytes = joinBytes(observed, patch.suffix);
                if (bytes.byteLength !== patch.outputLength || !fingerprintMatches(bytes, patch.outputFingerprint)) {
                  throw new Error("无法重建完整 PDF 检查点；恢复副本已保留");
                }
              }
              wrote = await timed("journaledWriteWallMs", () => journaledWrite({ file, state, bytes, baseBytes: state.base,
                parentBytes: observed, metadata: journalMetadata,
                stillCurrent: () => view.isCurrentSaveRequest(captured), onStage: recordHostStage }));
              if (wrote) {
                bytes = wrote;
                state.checkpoint = bytes;
                await timed("checkpointConfirmMs", () => confirmCheckpoint(file, state, bytes));
                sourceWriteConfirmed = true;
              }
            }
            if (wrote) {
              break;
            }
            if (attempt === 2) throw new Error("同步持续更改磁盘文件，自动写回暂停");
          }
          if (!((metadata?.identities || metadata?.annotations) && metadata?.ledger)) {
            metadata = await timed("postSaveInspectWallMs", () => getClient().inspect({ bytes: workerSnapshot(bytes) }));
          }
          if (!metadata?.baselineState && metadata !== local) {
            const outputInspection = await timed("postSaveBaselineInspectWallMs", () => getClient().inspect({
              bytes: workerSnapshot(bytes),
              fastOpen: true,
              sourceMtimeMs: Number.isFinite(file?.stat?.mtime) ? file.stat.mtime : null,
            }));
            metadata = { ...metadata, baselineState: outputInspection.baselineState || null };
          }
          if (!view.isCurrentSaveRequest(captured) || closeRequested(view)) {
            // Close may have already durably recovered a newer revision while
            // this accepted source write was blocked. Its exact checkpoint is
            // now confirmed; settle without poisoning shared file state or
            // sending callbacks into a detaching Viewer.
            if (!result.conflicts?.length) {
              try { await timed("recoveryCleanupMs", () => plugin.removeRecoveryCandidate(record)); } catch { /* Exact source bytes are already verified. */ }
            }
            scheduleForFile(file, "save-completed-after-close");
            return;
          }
          const syncState = stateFor(metadata);
          // Runtime editor IDs belong only to this Viewer session. Reattach them
          // by UUID after inspecting the merged output, never by coordinates.
          const runtime = new Map((local.identities || []).map((entry) => [entry.uuid, entry.runtimeId]));
          syncState.identities = syncState.identities.map((entry) => ({ ...entry, runtimeId: runtime.get(entry.uuid) || entry.runtimeId }));
          view.originalBytes = matchingSnapshot(state, bytes);
          // Keep loadedBaseBytes bound to the PDF.js document currently open.
          // PDF.js continues to serialize against this immutable source until
          // a sync refresh actually replaces that document.
          view.pdfSyncBaselineState = local.sourceBaselineState || view.pdfSyncBaselineState || null;
          view.pdfSyncConfirmedRevisionToken = metadata?.baselineState?.revisionToken ||
            local.baselineState?.revisionToken || null;
          state.baselineState = metadata?.baselineState || local.baselineState || null;
          if (state.baselineState?.revisionToken && Number.isFinite(file?.stat?.mtime)) {
            state.baselineState.revisionToken.sourceMtimeMs = file.stat.mtime;
          }
          state.confirmedRevisionToken = state.baselineState?.revisionToken || null;
          view.pdfSyncConfirmedRevisionToken = state.confirmedRevisionToken;
          view.annotationSyncState = syncState;
          state.inspectionState = syncState;
          state.inspectionSnapshot = view.originalBytes;
          if (Number.isSafeInteger(message.revision)) {
            view.currentRevision = Math.max(view.currentRevision, message.revision);
            view.confirmedRevision = Math.max(view.confirmedRevision, message.revision);
          }
          await timed("savedResponseMs", async () => post(view, { type: "saved", documentId: captured.documentId,
            rendererGeneration: captured.rendererGeneration,
            requestId: message.requestId, revision: message.revision, syncState }, []));
          if (!result.conflicts?.length) await timed("recoveryCleanupMs", () => plugin.removeRecoveryCandidate(record));
          const draft = view.latestRecoveryDraft;
          if (draft?.documentId === captured.documentId && message.revision >= draft.revision) {
            await timed("supersededDraftCleanupMs", () => plugin.removeRecoveryCandidate(draft.record));
            view.latestRecoveryDraft = null;
          }
          view.failureNoticeShown = false;
          view.setStatus(`已保存：${file.path}`, { recoveryAction: false });
          saveOutcome = "saved";
          if (message.origin === "manual") new Notice(`已保存 ${captured.filename}`);
          const localSemanticState = semanticLedger(local);
          const mergedSemanticState = semanticLedger(metadata);
          const sameAnnotationState = localSemanticState !== null && localSemanticState === mergedSemanticState;
          if (!equal(bytes, local.bytes) && !sameAnnotationState) view.syncNeedsRefresh = true;
          scheduleForFile(file, "saved");
        } catch (error) {
          saveError = error;
          if (sourceWriteConfirmed &&
              (!view.isCurrentSaveRequest(captured) || closeRequested(view))) {
            if (!result?.conflicts?.length && record) {
              try { await plugin.removeRecoveryCandidate(record); } catch { /* Verified source checkpoint is authoritative. */ }
            }
            scheduleForFile(file, "save-settled-after-close");
            return;
          }
          if (error?.unstartedAppendRolledBack || error?.unstartedWriteRolledBack) {
            // No original-file mutation was issued. Keep this session eligible
            // for a later save while retaining the raw recovery copy.
            state.paused = false;
            state.failure = null;
          } else {
            state.paused = true;
            state.failure = error.message;
          }
          if (record) { try { await timed("failedRecoveryMarkMs", () => plugin.markRecoveryCandidate(record, { status: "conflict", error: error.message })); } catch { /* Keep binary and original error. */ } }
          error.code = "conflict";
          if (error?.unstartedAppendRolledBack || error?.unstartedWriteRolledBack) {
            reportUnstartedAppendFailure(view, error.message);
          } else {
            failure(view, error.message);
          }
          throw error;
        }
      });
    } finally {
      recordSaveSummary();
      lease?.release();
      settle();
    }
  }

  function closeJobSnapshot(intent, status = intent.status, reason = null) {
    return {
      jobId: intent.jobId,
      documentId: intent.documentId,
      originalPath: intent.originalPath,
      revision: intent.revision,
      requestId: intent.requestId,
      status,
      phase: intent.phase,
      reason: reason || intent.reason || null,
    };
  }
  function publishCloseJob(intent, status = intent.status, reason = null) {
    plugin.updateCloseWritebackStatus?.(closeJobSnapshot(intent, status, reason));
  }
  function boundedJsonValue(value) {
    let visited = 0;
    const active = new Set();
    const validate = (entry, depth = 0) => {
      visited += 1;
      if (visited > 100000 || depth > 64) return false;
      if (entry === null || typeof entry === "string" || typeof entry === "boolean") return true;
      if (typeof entry === "number") return Number.isFinite(entry);
      if (typeof entry !== "object" || active.has(entry)) return false;
      const prototype = Object.getPrototypeOf(entry);
      if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null) return false;
      if (Object.getOwnPropertySymbols(entry).length) return false;
      active.add(entry);
      let valid = true;
      if (Array.isArray(entry)) {
        if (Object.keys(entry).length !== entry.length) valid = false;
        for (let index = 0; valid && index < entry.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          valid = Boolean(descriptor && Object.hasOwn(descriptor, "value") && validate(descriptor.value, depth + 1));
        }
      } else {
        for (const key of Object.keys(entry)) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, key);
          if (!descriptor || !Object.hasOwn(descriptor, "value") || !validate(descriptor.value, depth + 1)) {
            valid = false;
            break;
          }
        }
      }
      active.delete(entry);
      return valid;
    };
    try {
      if (!validate(value)) return false;
      const encoded = JSON.stringify(value);
      return typeof encoded === "string" && encoded.length <= 2_000_000;
    } catch { return false; }
  }
  function validCloseIntent(candidate) {
    const metadata = candidate?.metadata;
    const intent = metadata?.closeWriteback;
    return Boolean(
      metadata?.completed === true &&
      metadata.origin === "recovery" &&
      metadata.reason === "close-writeback" &&
      ["draft", "pending", "conflict", "failed"].includes(metadata.status) &&
      typeof metadata.candidateId === "string" &&
      intent?.schema === 1 &&
      intent.jobId === metadata.candidateId &&
      intent.documentId === metadata.documentId &&
      intent.originalPath === normalizePath(metadata.originalPath || "") &&
      Number.isSafeInteger(metadata.openRequest) && metadata.openRequest === intent.openRequest &&
      Number.isSafeInteger(metadata.revision) && metadata.revision === intent.revision &&
      typeof metadata.requestId === "string" && metadata.requestId === intent.requestId &&
      Number.isSafeInteger(intent.openRequest) && intent.openRequest >= 0 &&
      Number.isSafeInteger(intent.revision) && intent.revision >= 0 &&
      typeof intent.requestId === "string" && intent.requestId.length > 0 &&
      /^[a-zA-Z0-9_-]{8,128}$/.test(intent.actorId || "") &&
      intent.draft?.hash === metadata.outputHash &&
      intent.draft?.length === metadata.outputLength &&
      /^\.bases\/(?:[a-f0-9]{64}|xxh64-v1-[a-f0-9]{16}|sha256-v1-[a-f0-9]{64})\.pdf$/i.test(intent.base?.file || "") &&
      validHash(intent.base?.hash) &&
      Number.isSafeInteger(intent.base?.length) && intent.base.length > 0 &&
      Array.isArray(intent.operations) && Array.isArray(intent.newAnnotations) &&
      boundedJsonValue([intent.operations, intent.newAnnotations]) &&
      ["queued", "preparing", "merging", "ready", "write-invoked", "paused", "conflict", "completed", "completed-with-conflicts", "superseded"].includes(intent.phase)
    );
  }
  async function persistCloseIntent(candidate, intent, changes, { candidateStatus } = {}) {
    if (disposed || plugin.isUnloading) throw new Error("插件已卸载；后台写回意图仍保留");
    const adapter = plugin.app.vault.adapter;
    const expectedText = `${JSON.stringify(candidate.metadata, null, 2)}\n`;
    const before = await adapter.read(candidate.metadataPath);
    if (before !== expectedText) throw new Error("恢复副本元数据已变化；后台写回已暂停");
    const nextIntent = { ...intent, ...changes, updatedAt: new Date().toISOString() };
    const nextMetadata = {
      ...candidate.metadata,
      ...(candidateStatus ? { status: candidateStatus } : {}),
      updatedAt: new Date().toISOString(),
      closeWriteback: nextIntent,
    };
    const nextText = `${JSON.stringify(nextMetadata, null, 2)}\n`;
    await adapter.write(candidate.metadataPath, nextText);
    if (await adapter.read(candidate.metadataPath) !== nextText) {
      throw new Error("后台写回意图未通过写后验证");
    }
    candidate.metadata = nextMetadata;
    Object.assign(intent, nextIntent);
    return intent;
  }
  async function closeWritebackTransition(candidate, intent, status, phase = status, changes = {}, candidateStatus = null) {
    await persistCloseIntent(candidate, intent, { ...changes, status, phase }, { candidateStatus });
    publishCloseJob(intent, status, changes.reason || null);
  }
  async function revalidateCloseCandidate(candidate, intent) {
    const candidates = await plugin.listRecoveryCandidates();
    const matches = candidates.filter((item) => item?.metadata?.candidateId === intent.jobId);
    if (matches.length !== 1) throw new Error("关闭恢复副本不存在或身份不唯一");
    const fresh = matches[0];
    if (!validCloseIntent(fresh) || fresh.metadata.outputHash !== intent.draft.hash ||
        fresh.metadata.outputLength !== intent.draft.length ||
        fresh.metadata.documentId !== intent.documentId ||
        normalizePath(fresh.metadata.originalPath || "") !== intent.originalPath ||
        fresh.metadata.closeWriteback.requestId !== intent.requestId ||
        fresh.metadata.closeWriteback.revision !== intent.revision) {
      throw new Error("关闭恢复副本完整性或身份验证失败");
    }
    const raw = bytesView(await plugin.readRecoveryBytes(fresh));
    if (raw.byteLength !== intent.draft.length || !fingerprintMatches(raw, intent.draft.hash)) {
      throw new Error("关闭恢复 PDF 与持久意图不匹配");
    }
    // Use fresh storage paths while retaining an isolated serializable intent.
    candidate.candidatePath = fresh.candidatePath;
    candidate.metadataPath = fresh.metadataPath;
    return { candidate: fresh, draftBytes: copy(raw) };
  }
  function closeCandidateEquivalent(left, right) {
    const a = left?.metadata || {};
    const b = right?.metadata || {};
    if (a.candidateId === b.candidateId) return true;
    if (a.documentId !== b.documentId || a.openRequest !== b.openRequest ||
        a.revision !== b.revision || a.requestId !== b.requestId ||
        a.originalPath !== b.originalPath || a.outputHash !== b.outputHash ||
        a.outputLength !== b.outputLength) return false;
    const ai = a.closeWriteback;
    const bi = b.closeWriteback;
    if (!ai && !bi) return true;
    if (!ai || !bi || ai.actorId !== bi.actorId) return false;
    try {
      return JSON.stringify([ai.operations, ai.newAnnotations]) ===
        JSON.stringify([bi.operations, bi.newAnnotations]);
    } catch { return false; }
  }
  function closeLineageKey(path, metadata) {
    if (typeof metadata?.documentId !== "string" || !metadata.documentId ||
        !Number.isSafeInteger(metadata.openRequest) || metadata.openRequest < 0) return null;
    return JSON.stringify([path, metadata.documentId, metadata.openRequest]);
  }
  function sameCloseLineage(path, left, right) {
    const leftKey = closeLineageKey(path, left?.metadata);
    return leftKey !== null && leftKey === closeLineageKey(path, right?.metadata);
  }
  function bumpCloseGeneration(path, metadata = null) {
    closeWritebackGenerations.set(path, (closeWritebackGenerations.get(path) || 0) + 1);
    return bumpCloseSessionGeneration(path, metadata);
  }
  function bumpCloseSessionGeneration(path, metadata = null) {
    const lineage = closeLineageKey(path, metadata);
    if (lineage) {
      closeWritebackSessionGenerations.set(lineage,
        (closeWritebackSessionGenerations.get(lineage) || 0) + 1);
    }
    return lineage ? closeWritebackSessionGenerations.get(lineage) : null;
  }
  function getCloseGeneration(path) {
    return closeWritebackGenerations.get(normalizePath(path)) || 0;
  }
  function getOpenAdmission(path) {
    let admission = closeWritebackOpenAdmissions.get(path);
    if (!admission) {
      admission = { count: 0, waiters: [] };
      closeWritebackOpenAdmissions.set(path, admission);
    }
    return admission;
  }
  async function waitForCloseWritebackOpenAdmission(path) {
    const admission = closeWritebackOpenAdmissions.get(path);
    if (!admission?.count || disposed || plugin.isUnloading) return;
    await new Promise((resolve) => admission.waiters.push(resolve));
  }
  function hasCloseWritebackOpenAdmission(path) {
    return (closeWritebackOpenAdmissions.get(normalizePath(path))?.count || 0) > 0;
  }
  async function beginCloseWritebackOpen(path) {
    const targetPath = normalizePath(path);
    while (!disposed && !plugin.isUnloading) {
      await waitForCloseWriteback(targetPath);
      // Recheck after the await and register in the same turn. A job admitted
      // after this point sees the open lease and waits for its PDF.js parse.
      if (closeWritebackDiscovery || closeWritebackTails.has(targetPath)) continue;
      const admission = getOpenAdmission(targetPath);
      admission.count += 1;
      let released = false;
      return {
        generation: getCloseGeneration(targetPath),
        release() {
          if (released) return;
          released = true;
          admission.count = Math.max(0, admission.count - 1);
          if (admission.count) return;
          for (const resolve of admission.waiters.splice(0)) resolve();
          if (!admission.waiters.length && closeWritebackOpenAdmissions.get(targetPath) === admission) {
            closeWritebackOpenAdmissions.delete(targetPath);
          }
        },
      };
    }
    throw new Error("PDF 后台恢复协调器已关闭");
  }
  // Returns -1 when left is older, 1 when newer, and 0 when the evidence is
  // tied. Runtime revisions are comparable only inside one Viewer session;
  // cross-session ordering uses the durable candidate creation timestamp.
  function compareCloseRecovery(left, right) {
    const a = left?.metadata || {};
    const b = right?.metadata || {};
    if (typeof a.documentId === "string" && a.documentId &&
        a.documentId === b.documentId &&
        Number.isSafeInteger(a.openRequest) && a.openRequest === b.openRequest &&
        Number.isSafeInteger(a.revision) && Number.isSafeInteger(b.revision)) {
      if (a.revision !== b.revision) return a.revision < b.revision ? -1 : 1;
      // Creation time cannot establish which payload is authoritative inside
      // one Viewer revision. Equal-revision, non-equivalent drafts are paused.
      return 0;
    }
    const aTime = Date.parse(a.createdAt || "");
    const bTime = Date.parse(b.createdAt || "");
    if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
      return aTime < bTime ? -1 : 1;
    }
    return 0;
  }
  function chooseLatestCloseRecovery(candidates) {
    let latest = null;
    let ambiguous = false;
    for (const candidate of candidates) {
      if (!latest) {
        latest = candidate;
        continue;
      }
      const order = compareCloseRecovery(candidate, latest);
      if (order > 0) {
        latest = candidate;
        ambiguous = false;
      } else if (order === 0) {
        if (!closeCandidateEquivalent(candidate, latest)) {
          ambiguous = true;
        } else {
          // Equivalent candidates contain the same branch and provenance.
          // Choose one stable winner so a duplicate close ACK cannot be
          // replayed after the winner is completed and removed.
          const candidateId = String(candidate?.metadata?.candidateId || "");
          const latestId = String(latest?.metadata?.candidateId || "");
          if (candidateId && latestId && candidateId < latestId) {
            latest = candidate;
          }
        }
      }
    }
    return { latest, ambiguous };
  }
  function isEquivalentOlderCloseRecovery(candidate, latest) {
    return compareCloseRecovery(candidate, latest) === 0 &&
      closeCandidateEquivalent(candidate, latest) &&
      String(candidate?.metadata?.candidateId || "") !==
        String(latest?.metadata?.candidateId || "");
  }
  async function markCloseRecoverySuperseded(candidate, reason = "较新的恢复副本已取代此写回任务；旧恢复分支仍保留") {
    const old = candidate?.metadata?.closeWriteback;
    if (!validCloseIntent(candidate) ||
        !["queued", "preparing", "merging", "ready"].includes(old.phase)) return;
    try {
      await persistCloseIntent(candidate, { ...old }, {
        status: "superseded", phase: "superseded", reason,
      }, { candidateStatus: "conflict" });
      publishCloseJob(candidate.metadata.closeWriteback, "superseded", reason);
    } catch {
      // Keep every raw branch; the next discovery pass will compare it again.
    }
  }
  async function supersedeOlderCloseWritebacks(path, newestCandidate, newestIntent) {
    if (disposed || plugin.isUnloading) return false;
    const candidates = await plugin.listRecoveryCandidates();
    if (disposed || plugin.isUnloading) return false;
    const samePath = candidates.filter((candidate) =>
      candidate?.metadata?.origin === "recovery" &&
      normalizePath(candidate.metadata.originalPath || "") === path);
    const lineage = samePath.filter((candidate) => sameCloseLineage(path, candidate, newestCandidate));
    const { latest, ambiguous } = chooseLatestCloseRecovery(lineage);
    if (ambiguous || !latest || latest.metadata.candidateId !== newestIntent.jobId) {
      const reason = ambiguous
        ? "同一阅读会话的恢复副本顺序无法确认；后台写回已暂停并保留所有分支"
        : "同一阅读会话存在较新的恢复副本；此旧写回任务已暂停并保留原始副本";
      await closeWritebackTransition(newestCandidate, newestIntent,
        ambiguous ? "conflict" : "superseded", ambiguous ? "paused" : "superseded",
        { reason }, "conflict");
      for (const candidate of lineage) {
        if (candidate === latest) continue;
        if (compareCloseRecovery(candidate, latest) < 0 ||
            isEquivalentOlderCloseRecovery(candidate, latest)) {
          await markCloseRecoverySuperseded(candidate);
        }
      }
      return false;
    }
    for (const candidate of lineage) {
      if (candidate.metadata.candidateId === newestIntent.jobId) continue;
      if (compareCloseRecovery(candidate, newestCandidate) < 0 ||
          isEquivalentOlderCloseRecovery(candidate, newestCandidate)) {
        await markCloseRecoverySuperseded(candidate);
      }
    }
    return true;
  }
  function exactCloseTarget(file, targetPath) {
    return Boolean(file && normalizePath(file.path) === targetPath &&
      plugin.app.vault.getAbstractFileByPath(targetPath) === file && isPdfFile(file));
  }
  async function readCloseBase(intent) {
    const path = `${plugin.recoveryDirectory}/${intent.base.file}`;
    const bytes = bytesView(await plugin.app.vault.adapter.readBinary(path));
    if (bytes.byteLength !== intent.base.length || !fingerprintMatches(bytes, intent.base.hash)) {
      throw new Error("关闭恢复基线校验失败");
    }
    return copy(bytes);
  }
  function materializeCloseMerge(result, observed) {
    if (result?.bytes !== undefined) return copy(result.bytes);
    if (patchMatches(result?.patch, observed)) {
      const output = joinBytes(observed, result.patch.suffix);
      if (output.byteLength === result.patch.outputLength &&
          fingerprintMatches(output, result.patch.outputFingerprint)) return output;
    }
    throw new Error("本地与磁盘分支合并结果未通过完整性验证");
  }
  async function recoverInvokedCloseWrite(candidate, intent, file, targetPath, state) {
    const disk = await readStablePdf(file, targetPath, true);
    if (!disk) throw new Error("PDF 已移动或被替换；原恢复副本仍保留");
    if (intent.writeHash && disk.byteLength === intent.writeLength && fingerprintMatches(disk, intent.writeHash)) {
      await loadCheckpoint(file, state);
      if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 写回后已移动或被替换");
      if (state.paused) throw new Error(state.failure || "同步检查点未能确认后台写回");
      await closeWritebackTransition(candidate, intent, "completed", "completed", {
        verifiedOutputHash: intent.writeHash,
        verifiedOutputLength: intent.writeLength,
      }, intent.conflicts ? "conflict" : "saved");
      if (!intent.conflicts) await plugin.removeRecoveryCandidate(candidate);
      scheduleForFile(file, "close-writeback-complete");
      return true;
    }
    throw new Error("上次源 PDF 写入结果不确定；未自动重试，恢复副本仍保留");
  }
  async function runCloseWriteback(candidate, intent, lineage, generation) {
    const targetPath = normalizePath(intent.originalPath);
    if (disposed || plugin.isUnloading) return;
    if (closeWritebackSessionGenerations.get(lineage) !== generation) {
      await closeWritebackTransition(candidate, intent, "superseded", "superseded", {
        reason: "此阅读会话中的恢复副本已被较新的关闭修订取代；旧分支仍可恢复",
      }, "conflict");
      return;
    }
    const file = plugin.app.vault.getAbstractFileByPath(targetPath);
    if (!exactCloseTarget(file, targetPath)) throw new Error("原 PDF 已移动、被替换或不再存在");
    const state = getState(file);
    const settle = beginState(file, state);
    try {
      if (!await supersedeOlderCloseWritebacks(targetPath, candidate, intent)) return;
      if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 在整理关闭任务期间已移动或被替换");
      if (intent.phase === "write-invoked") {
        await recoverInvokedCloseWrite(candidate, intent, file, targetPath, state);
        return;
      }
      await closeWritebackTransition(candidate, intent, "preparing", "preparing", { reason: null });
      const { candidate: freshCandidate, draftBytes } = await revalidateCloseCandidate(candidate, intent);
      candidate.metadata = freshCandidate.metadata;
      await loadCheckpoint(file, state);
      if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 在恢复检查期间已移动或被替换");
      if (state.paused) throw new Error(state.failure || "文档同步已暂停；恢复副本仍保留");
      const baseBytes = await readCloseBase(intent);
      if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 在读取恢复基线期间已移动或被替换");
      const draft = copy(draftBytes);
      let local = await getClient().prepareLocal({
        baseBytes: workerSnapshot(baseBytes),
        draftBytes: workerSnapshot(draft),
        operations: intent.operations,
        newAnnotations: intent.newAnnotations,
        actorId: intent.actorId,
        checkpointBytes: workerSnapshot(state.confirmedCheckpoint || baseBytes),
      });
      if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 在注释准备期间已移动或被替换");
      let localBytes = copy(local.bytes);
      if (!localBytes.byteLength) throw new Error("PDF 合并 Worker 返回了空文档");
      let metadata = local;
      if (state.checkpoint && !equal(state.checkpoint, baseBytes)) {
        const checkpointMerge = await getClient().merge({
          baseBytes: workerSnapshot(state.base || baseBytes),
          localBytes: workerSnapshot(state.checkpoint),
          remoteBytes: workerSnapshot(localBytes),
          actorId: intent.actorId,
        });
        if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 在合并同步检查点期间已移动或被替换");
        localBytes = materializeCloseMerge(checkpointMerge, localBytes);
        metadata = checkpointMerge;
      }

      await closeWritebackTransition(candidate, intent, "merging", "merging");
      let observed = await readStablePdf(file, targetPath, true);
      if (!observed) throw new Error("原 PDF 在读取期间已移动或被替换");
      let mergeParent = copy(observed);
      const mergeAgainstDisk = async (remoteBytes) => {
        if (equal(remoteBytes, baseBytes)) return { bytes: copy(localBytes), conflicts: [] };
        const result = await getClient().merge({
          baseBytes: workerSnapshot(baseBytes),
          localBytes: workerSnapshot(localBytes),
          remoteBytes: workerSnapshot(remoteBytes),
          actorId: intent.actorId,
          patchOnly: true,
        });
        if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 在跨设备合并期间已移动或被替换");
        return result;
      };
      let merged = await mergeAgainstDisk(observed);
      let output = materializeCloseMerge(merged, observed);
      let conflicts = Array.isArray(merged.conflicts) ? merged.conflicts : [];
      if (state.checkpoint && !equal(state.checkpoint, baseBytes) &&
          !((metadata?.identities || metadata?.annotations) && metadata?.ledger)) {
        metadata = await getClient().inspect({ bytes: workerSnapshot(output) });
        if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 在验证注释映射期间已移动或被替换");
      }
      const syncMetadata = {
        actorId: intent.actorId,
        requestId: intent.requestId,
        revision: intent.revision,
        operations: intent.operations,
        newAnnotations: intent.newAnnotations,
        documentId: intent.documentId,
      };

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (disposed || plugin.isUnloading) return;
        if (closeWritebackSessionGenerations.get(lineage) !== generation) {
          await closeWritebackTransition(candidate, intent, "superseded", "superseded", {
            reason: "后台写回被同一阅读会话中的较新关闭修订取代；恢复副本仍保留",
          }, "conflict");
          return;
        }
        if (!exactCloseTarget(file, targetPath)) throw new Error("原 PDF 在写入前已移动或被替换");
        const latestObserved = await readStablePdf(file, targetPath, true);
        if (!latestObserved) throw new Error("原 PDF 在最终比较期间已移动或被替换");
        if (!equal(latestObserved, mergeParent)) {
          observed = latestObserved;
          merged = await mergeAgainstDisk(observed);
          mergeParent = copy(observed);
          output = materializeCloseMerge(merged, observed);
          conflicts = Array.isArray(merged.conflicts) ? merged.conflicts : [];
        } else observed = latestObserved;
        const patch = patchMatches(merged?.patch, observed)
          ? merged.patch
          : prefixPatch(output, observed);
        await closeWritebackTransition(candidate, intent, "merging", "ready", {
          writeHash: fingerprint(output),
          writeLength: output.byteLength,
          conflicts: conflicts.length > 0,
        });
        try {
          let written;
          if (patch && typeof plugin.app.vault.appendBinary === "function") {
            written = await journaledAppend({
              file, targetPath, baseBytes: state.base || baseBytes,
              parentBytes: observed, patch, metadata: syncMetadata,
              stillCurrent: () => !disposed && !plugin.isUnloading &&
                closeWritebackSessionGenerations.get(lineage) === generation &&
                exactCloseTarget(file, targetPath),
              onWriteInvoked: async () => closeWritebackTransition(
                candidate, intent, "write-invoked", "write-invoked",
              ),
              strictTarget: true,
            });
          } else {
            written = await journaledWrite({
              file, targetPath, state, bytes: output,
              baseBytes: state.base || baseBytes, parentBytes: observed,
              metadata: syncMetadata,
              stillCurrent: () => !disposed && !plugin.isUnloading &&
                closeWritebackSessionGenerations.get(lineage) === generation &&
                exactCloseTarget(file, targetPath),
              onWriteInvoked: async () => closeWritebackTransition(
                candidate, intent, "write-invoked", "write-invoked",
              ),
            });
          }
          if (!written) {
            if (attempt < 2) {
              await closeWritebackTransition(candidate, intent, "merging", "merging", {
                writeHash: null,
                writeLength: null,
              });
              continue;
            }
            throw new Error("磁盘在最终比较期间持续变化；恢复副本仍保留");
          }
          output = copy(written);
          state.checkpoint = output;
          state.base = copy(state.base || baseBytes);
          state.version += 1;
          await confirmCheckpoint(file, state, output, targetPath);
          if (!exactCloseTarget(file, targetPath)) throw new Error("PDF 写回后已移动或被替换；同步检查点已保留");
          const hasConflicts = conflicts.length > 0;
          await closeWritebackTransition(
            candidate,
            intent,
            hasConflicts ? "completed-with-conflicts" : "completed",
            hasConflicts ? "completed-with-conflicts" : "completed",
            {
              writeHash: fingerprint(output),
              writeLength: output.byteLength,
              verifiedOutputHash: fingerprint(output),
              verifiedOutputLength: output.byteLength,
              conflicts: hasConflicts,
              reason: hasConflicts ? "跨设备合并已写回，冲突分支仍保留在恢复副本" : null,
            },
            hasConflicts ? "conflict" : "saved",
          );
          if (!hasConflicts) await plugin.removeRecoveryCandidate(candidate);
          updateBaselineForLiveViews(file, state, output, targetPath);
          scheduleForFile(file, "close-writeback-complete");
          return;
        } catch (error) {
          if (disposed || plugin.isUnloading) return;
          if (error?.unstartedAppendRolledBack || error?.unstartedWriteRolledBack) {
            // The journal verified that source mutation never began. A fresh
            // exact-parent comparison and merge may safely be attempted.
            if (attempt < 2) {
              await closeWritebackTransition(candidate, intent, "merging", "merging", {
                writeHash: null,
                writeLength: null,
              });
              continue;
            }
          }
          throw error;
        }
      }
    } catch (error) {
      if (!disposed && !plugin.isUnloading) {
        const uncertain = intent.phase === "write-invoked";
        const status = error?.code === "PDF_CONFLICT" ? "conflict" : "paused";
        const reason = `${uncertain ? "源 PDF 写入结果不确定；未自动重试。" : ""}${error?.message || "后台写回失败"}`;
        try {
          await closeWritebackTransition(candidate, intent, status, "paused", { reason }, "conflict");
        } catch {
          publishCloseJob(intent, status, reason);
        }
      }
    } finally {
      if (!hasLiveView(file, state)) {
        state.releasePending = true;
        plugin.releaseDocumentBaseline?.(targetPath);
      }
      settle();
    }
  }
  function scheduleCloseWriteback(candidate, suppliedIntent = candidate?.metadata?.closeWriteback) {
    if (disposed || plugin.isUnloading || !validCloseIntent(candidate) ||
        !suppliedIntent || suppliedIntent.jobId !== candidate.metadata.candidateId) return null;
    const canonical = candidate.metadata.closeWriteback;
    if (JSON.stringify(suppliedIntent) !== JSON.stringify(canonical)) return null;
    const targetPath = normalizePath(canonical.originalPath);
    const existingTask = closeWritebackById.get(canonical.jobId);
    if (existingTask) return existingTask;
    const immutableMetadata = JSON.parse(JSON.stringify(candidate.metadata));
    const jobCandidate = {
      candidatePath: candidate.candidatePath,
      metadataPath: candidate.metadataPath,
      metadata: immutableMetadata,
    };
    const intent = { ...immutableMetadata.closeWriteback };
    const lineage = closeLineageKey(targetPath, immutableMetadata);
    if (!lineage) return null;
    const generation = bumpCloseGeneration(targetPath, immutableMetadata);
    const previous = closeWritebackTails.get(targetPath) || Promise.resolve();
    // The token is plugin-owned and serializable. The detached closure keeps
    // immutable candidate metadata and file identity only; it never captures
    // the Reader, iframe, owner window, or Viewer callbacks.
    const jobToken = Object.freeze({ jobId: intent.jobId, originalPath: targetPath });
    publishCloseJob(intent, "queued");
    const task = (async () => {
      await previous.catch(() => undefined);
      if (disposed || plugin.isUnloading) return;
      publishCloseJob(intent, "waiting-for-writer");
      await waitForCloseWritebackOpenAdmission(targetPath);
      if (disposed || plugin.isUnloading) return;
      const file = plugin.app.vault.getAbstractFileByPath(targetPath);
      if (!exactCloseTarget(file, targetPath)) {
        throw new Error("原 PDF 已移动、被替换或不再存在");
      }
      let lease;
      try {
        if (typeof plugin.acquireCloseWritebackLease === "function") {
          lease = await plugin.acquireCloseWritebackLease(jobToken, file, intent, targetPath);
        } else {
          lease = { release() {} };
        }
        if (disposed || plugin.isUnloading) return;
        if (closeWritebackSessionGenerations.get(lineage) !== generation) {
          await closeWritebackTransition(jobCandidate, intent, "superseded", "superseded", {
            reason: "同一阅读会话中的恢复副本已被较新修订取代；旧分支仍保留",
          }, "conflict");
          return;
        }
        // Acquire mobile heavy-work admission before entering the global Vault
        // save queue. A live save may itself hold the lease while waiting for
        // that queue, so reversing these two steps can deadlock.
        await plugin.enqueueSave(() => {
          if (disposed || plugin.isUnloading) return;
          return runCloseWriteback(jobCandidate, intent, lineage, generation);
        });
      } finally {
        lease?.release?.();
      }
    })().catch(async (error) => {
      if (!disposed && !plugin.isUnloading) {
        const reason = error?.message || "后台写回无法安全启动";
        const status = error?.code === "PDF_CONFLICT" ? "conflict" : "paused";
        try {
          await closeWritebackTransition(jobCandidate, intent, status, "paused", { reason }, "conflict");
        } catch { publishCloseJob(intent, status, reason); }
      }
    });
    closeWritebackById.set(intent.jobId, task);
    const settled = task.then(() => undefined, () => undefined);
    closeWritebackTails.set(targetPath, settled);
    settled.finally(() => {
      if (closeWritebackTails.get(targetPath) === settled) closeWritebackTails.delete(targetPath);
      if (closeWritebackById.get(intent.jobId) === task) closeWritebackById.delete(intent.jobId);
    });
    return task;
  }
  function noteCloseRecoveryCandidate(candidate) {
    if (disposed || plugin.isUnloading || candidate?.metadata?.origin !== "recovery" ||
        typeof candidate.metadata.originalPath !== "string") return null;
    const path = normalizePath(candidate.metadata.originalPath);
    if (!path) return null;
    // Invalidate only an older job from this exact Viewer session. The path
    // generation is bumped when a validated job is registered, so a recovery
    // intent that later fails setup cannot make an unrelated open retry-loop.
    return bumpCloseSessionGeneration(path, candidate.metadata);
  }
  async function discoverCloseWritebacks() {
    if (disposed || plugin.isUnloading || typeof plugin.listRecoveryCandidates !== "function") return [];
    const candidates = await plugin.listRecoveryCandidates();
    if (disposed || plugin.isUnloading) return [];
    const byPath = new Map();
    for (const candidate of candidates) {
      const metadata = candidate?.metadata;
      // Any later raw recovery branch suppresses an older automatic writeback,
      // including autosave-disabled closes and intent-setup failures.
      if (metadata?.origin !== "recovery" || typeof metadata.originalPath !== "string") continue;
      const path = normalizePath(metadata.originalPath);
      if (!path) continue;
      const pathCandidates = byPath.get(path) || [];
      pathCandidates.push(candidate);
      byPath.set(path, pathCandidates);
    }
    const tasks = [];
    for (const [path, pathCandidates] of byPath) {
      const byLineage = new Map();
      for (const item of pathCandidates) {
        const lineage = closeLineageKey(path, item.metadata) ||
          `unbound:${item.metadata.candidateId || byLineage.size}`;
        const group = byLineage.get(lineage) || [];
        group.push(item);
        byLineage.set(lineage, group);
      }
      const groups = [...byLineage.entries()].map(([lineage, candidates]) => {
        const { latest, ambiguous } = chooseLatestCloseRecovery(candidates);
        const createdAt = Date.parse(latest?.metadata?.createdAt || "");
        return { lineage, candidates, latest, ambiguous, createdAt };
      }).sort((left, right) => {
        const a = Number.isFinite(left.createdAt) ? left.createdAt : Number.MAX_SAFE_INTEGER;
        const b = Number.isFinite(right.createdAt) ? right.createdAt : Number.MAX_SAFE_INTEGER;
        if (a !== b) return a - b;
        return String(left.latest?.metadata?.candidateId || left.lineage)
          .localeCompare(String(right.latest?.metadata?.candidateId || right.lineage));
      });
      // Different Viewer sessions may contain independent annotations. Order
      // them deterministically, then merge each against the previous verified
      // disk output; timestamps never authorize dropping a cross-session branch.
      for (const group of groups) {
        const { latest: candidate, ambiguous } = group;
        if (!candidate) continue;
        if (ambiguous) {
          const reason = "同一阅读会话的恢复副本顺序无法确认；后台写回已暂停并保留所有分支";
          for (const item of group.candidates) {
            const intent = item?.metadata?.closeWriteback;
            if (validCloseIntent(item) && intent.phase !== "write-invoked" &&
                !["completed", "completed-with-conflicts", "superseded"].includes(intent.phase)) {
              try {
                await closeWritebackTransition(item, intent, "conflict", "paused", { reason }, "conflict");
              } catch { publishCloseJob(intent, "conflict", reason); }
            } else {
              plugin.updateCloseWritebackStatus?.({
                jobId: item.metadata.candidateId || `ambiguous-${path}`,
                documentId: item.metadata.documentId,
                originalPath: path,
                revision: item.metadata.revision,
                status: "conflict",
                reason,
              });
            }
          }
          continue;
        }
        for (const older of group.candidates) {
          if (older === candidate || (compareCloseRecovery(older, candidate) >= 0 &&
              !isEquivalentOlderCloseRecovery(older, candidate))) continue;
          await markCloseRecoverySuperseded(older);
        }
        if (!validCloseIntent(candidate)) {
          plugin.updateCloseWritebackStatus?.({
            jobId: candidate.metadata.candidateId || `invalid-${path}`,
            documentId: candidate.metadata.documentId,
            originalPath: path,
            revision: candidate.metadata.revision,
            status: "paused",
            reason: "关闭恢复副本没有有效写回意图；原始恢复副本已保留",
          });
          continue;
        }
        const intent = candidate.metadata.closeWriteback;
        if (["completed", "completed-with-conflicts", "paused", "conflict", "superseded"].includes(intent.phase)) {
          publishCloseJob(intent, intent.status, intent.reason);
          continue;
        }
        const task = scheduleCloseWriteback(candidate, intent);
        if (task) tasks.push(task);
      }
    }
    return tasks;
  }
  function resumeCloseWritebacks() {
    if (closeWritebackDiscovery) return closeWritebackDiscovery;
    if (disposed || plugin.isUnloading || typeof plugin.listRecoveryCandidates !== "function") {
      return Promise.resolve([]);
    }
    const discovery = discoverCloseWritebacks().then((result) => {
      closeWritebackDiscoveryError = null;
      return result;
    }, (error) => {
      closeWritebackDiscoveryError = error;
      throw error;
    });
    closeWritebackDiscovery = discovery.finally(() => {
      if (closeWritebackDiscovery === wrapped) closeWritebackDiscovery = null;
    });
    const wrapped = closeWritebackDiscovery;
    return wrapped;
  }
  async function waitForCloseWriteback(path) {
    const targetPath = normalizePath(path);
    while (true) {
      const discovery = closeWritebackDiscovery;
      if (discovery) await discovery;
      else if (closeWritebackDiscoveryError) await resumeCloseWritebacks();
      const pending = closeWritebackTails.get(targetPath);
      if (pending) await pending;
      if (!closeWritebackDiscovery && !closeWritebackTails.has(targetPath)) return;
    }
  }
  async function reconcile(view, file) {
    if (closeRequested(view) || hasCloseWritebackOpenAdmission(file.path)) return;
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
      if (state.version !== version) { scheduleForFile(file, "state-changed"); return; }

      // These immutable snapshots survive asynchronous Viewer and Worker calls.
      const observed = copy(observedRead);
      const mergeBase = copy(state.base || view.loadedBaseBytes || view.originalBytes);
      const checkpoint = state.checkpoint ? workerSnapshot(state.checkpoint) : null;
      const snapshot = await request(view, "sync-checkpoint", { heavyLeaseId: lease.id }, ["sync-checkpoint-ready", "sync-checkpoint-rejected"], 120000);
      if (closeRequested(view)) return;
      if (snapshot.type === "sync-checkpoint-rejected" && snapshot.reason === "save-in-progress") {
        // The save queue may be waiting for this heavy lease. Release and retry
        // after this reconciliation exits instead of waiting while holding it.
        scheduleForFile(file, "save-settled");
        return;
      }
      if (snapshot.type !== "sync-checkpoint-ready" || snapshot.ok === false || !snapshot.data) throw new Error(snapshot.reason || "无法捕获安全编辑检查点");
      let record = await recovery(view, snapshot.data, snapshot.revision, "before-auto-merge", "draft", captured, snapshot.requestId);
      if (closeRequested(view) || !view.isCurrentSaveRequest(captured)) return;
      const cleanWithoutCheckpoint = !checkpoint && !snapshot.operations?.length && !snapshot.newAnnotations?.length && snapshot.dirty !== true;
      const local = cleanWithoutCheckpoint ? { bytes: captured.originalBytes } : await prepare(view, snapshot, captured, {
        documentRevisionMatch: false,
        forceFullFingerprints: true,
      });
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
          if (bytes.byteLength !== patch.outputLength || !fingerprintMatches(bytes, patch.outputFingerprint)) {
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
      if (prepared.ok !== true || prepared.prepared !== true) { scheduleForFile(file, "new-revision"); return; }
      try {
        await plugin.enqueueSave(async () => {
          if (disposed || plugin.isUnloading || closeRequested(view)) {
            const error = new Error("Reader closing; sync checkpoint is preserved.");
            error.code = "SYNC_SESSION_CHANGED";
            throw error;
          }
          if (!view.isCurrentSaveRequest(captured) || state.version !== version) { scheduleForFile(file, "queue-changed"); return; }
          const latest = await plugin.app.vault.readBinary(file);
          if (closeRequested(view)) {
            const error = new Error("Reader closing; sync checkpoint is preserved.");
            error.code = "SYNC_SESSION_CHANGED";
            throw error;
          }
          if (!equal(latest, observed)) { scheduleForFile(file, "disk-changed"); return; }
          const journalMetadata = {
            actorId: snapshot.actorId || actorId,
            requestId: snapshot.requestId,
            revision: snapshot.revision,
            operations: snapshot.operations || [],
            newAnnotations: snapshot.newAnnotations || [],
            documentId: captured.documentId,
          };
          let wrote = false;
          if (!cleanWithoutCheckpoint && patch && typeof plugin.app.vault.appendBinary === "function") {
            const appended = await journaledAppend({ file, baseBytes: mergeBase,
              parentBytes: observed, patch, metadata: journalMetadata,
              stillCurrent: () => view.isCurrentSaveRequest(captured) });
            if (!appended) { scheduleForFile(file, "disk-changed"); return; }
            bytes = appended;
            state.checkpoint = bytes;
            state.version += 1;
            await confirmCheckpoint(file, state, bytes);
            wrote = true;
          } else if (!cleanWithoutCheckpoint) {
            materializePatch();
            const written = await journaledWrite({ file, state, bytes, baseBytes: mergeBase,
              parentBytes: observed, metadata: journalMetadata,
              stillCurrent: () => view.isCurrentSaveRequest(captured) });
            if (!written) { scheduleForFile(file, "disk-changed"); return; }
            bytes = written;
            await confirmCheckpoint(file, state, bytes);
            wrote = true;
          } else { state.base = copy(bytes); state.version += 1; }
          if (closeRequested(view)) {
            const error = new Error("Reader closing; sync checkpoint is preserved.");
            error.code = "SYNC_SESSION_CHANGED";
            throw error;
          }
          if (!wrote && !equal(bytes, observed)) { scheduleForFile(file, "disk-changed"); return; }
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
          state.baselineState = metadata.baselineState || null;
          state.confirmedRevisionToken = metadata.baselineState?.revisionToken || null;
          view.pdfSyncBaselineState = metadata.baselineState || null;
          view.pdfSyncConfirmedRevisionToken = state.confirmedRevisionToken;
          state.inspectionState = view.annotationSyncState;
          state.inspectionSnapshot = baseline;
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
    if (disposed || plugin.isUnloading || !isPdfFile(file)) return;
    const path = normalizePath(file.path);
    const targets = new Set([...plugin.views]
      .map(currentFile)
      .filter((target) => target && isPdfFile(target) && normalizePath(target.path) === path));
    if (!targets.size) targets.add(file);
    for (const target of targets) scheduleForFile(target, reason);
  }
  function scheduleForFile(file, reason) {
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
            if (error?.unstartedAppendRolledBack || error?.unstartedWriteRolledBack) {
              state.paused = false;
              state.failure = null;
              reportUnstartedAppendFailure(view, error.message);
            } else {
              state.paused = true;
              state.failure = error.message;
              failure(view, error.message);
            }
          }
        }
      })().finally(() => {
        running.delete(file);
        if (job.again) scheduleForFile(file, "coalesced");
      });
    }, 150));
  }
  return {
    actorId, initializeView, save, schedule, prepareRecovery, showFailure: failure,
    scheduleCloseWriteback,
    noteCloseRecoveryCandidate,
    resumeCloseWritebacks,
    waitForCloseWriteback,
    beginCloseWritebackOpen,
    closeWritebackGeneration: getCloseGeneration,
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
      if (file && view.ready) scheduleForFile(currentFile(view), "close-cancelled");
      return true;
    },
    checkOpenViews(reason) { for (const view of plugin.views) scheduleForFile(currentFile(view), reason); },
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
      const oldKey = normalizePath(oldPath || "");
      const newKey = normalizePath(file?.path || "");
      if (oldKey && oldKey !== newKey) {
        for (const job of plugin.closeWritebackJobs?.values?.() || []) {
          if (normalizePath(job.originalPath || "") === oldKey &&
              !["completed", "completed-with-conflicts"].includes(job.status)) {
            plugin.updateCloseWritebackStatus?.({
              ...job,
              status: "paused",
              reason: "PDF 已移动或改名；关闭恢复副本已保留",
            });
          }
        }
      }
      const state = states.get(file);
      if (state) {
        state.baselineState = null;
        state.inspectionState = null;
        state.inspectionSnapshot = null;
      }
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
      view.pdfSyncBaselineState = null;
      view.pdfSyncConfirmedRevisionToken = null;
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
      for (const admission of closeWritebackOpenAdmissions.values()) {
        for (const resolve of admission.waiters.splice(0)) resolve();
      }
      for (const timer of timers.values()) globalThis.clearTimeout(timer);
      timers.clear();
      for (const view of plugin.views) void this.closeView(view, "Plugin unloaded", { force: true });
      client?.dispose?.();
    },
  };
}

module.exports = { createPdfSyncHost };
