/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { createWalAnnotationStore } = require("./storage/wal-annotation-store.cjs");

const ANNOTATION_ROOT = "00_Archive/20_PDFData";
const TAIL_SAMPLE_BYTES = 64 * 1024;

function createPdfAnnotationHost({
  app,
  normalizePath = defaultNormalizePath,
  hashRuntime,
  identityHash,
  inspectLegacy = null,
  makeToken,
  deviceId,
  Notice = null,
  log = () => {},
  storeFactory = createWalAnnotationStore,
}) {
  if (!app?.vault?.adapter || !hashRuntime || typeof hashRuntime.fingerprint !== "function") {
    throw new TypeError("PDF annotation host requires a Vault adapter and hash runtime.");
  }
  const backingAdapter = app.vault.adapter;
  const selfSidecarWrites = new Map();
  const MAX_TRACKED_SELF_SIDECAR_WRITES = 4096;
  const isSidecarPath = (path) => {
    const normalized = normalizePath(path);
    return normalized === ANNOTATION_ROOT || normalized.startsWith(`${ANNOTATION_ROOT}/`);
  };
  const fingerprintSidecarValue = (value) => {
    let bytes;
    if (typeof value === "string") bytes = utf8(value);
    else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) bytes = bytesView(value);
    else return null;
    return { byteLength: bytes.byteLength, digest: hashRuntime.fingerprint(bytes) };
  };
  const rememberSelfSidecarFingerprint = (path, fingerprint) => {
    if (!isSidecarPath(path) || !fingerprint) return null;
    const normalized = normalizePath(path);
    const record = { ...fingerprint, generation: makeToken() };
    selfSidecarWrites.delete(normalized);
    selfSidecarWrites.set(normalized, record);
    while (selfSidecarWrites.size > MAX_TRACKED_SELF_SIDECAR_WRITES) {
      selfSidecarWrites.delete(selfSidecarWrites.keys().next().value);
    }
    return { path: normalized, record };
  };
  const rememberSelfSidecarWrite = (path, value) =>
    rememberSelfSidecarFingerprint(path, fingerprintSidecarValue(value));
  const forgetSelfSidecarWrite = (tracked) => {
    if (tracked && selfSidecarWrites.get(tracked.path) === tracked.record) {
      selfSidecarWrites.delete(tracked.path);
    }
  };
  const adapter = new Proxy(backingAdapter, {
    get(target, property) {
      if (property === "write") {
        return async (path, value) => {
          const tracked = rememberSelfSidecarWrite(path, value);
          try {
            return await target.write.call(target, path, value);
          } catch (error) {
            forgetSelfSidecarWrite(tracked);
            throw error;
          }
        };
      }
      if (property === "append") {
        if (typeof target.append !== "function") return undefined;
        return async (path, value) => {
          let previous = "";
          try { previous = await target.read.call(target, path); } catch { /* New append target. */ }
          const tracked = rememberSelfSidecarWrite(path, `${previous}${value}`);
          try {
            return await target.append.call(target, path, value);
          } catch (error) {
            forgetSelfSidecarWrite(tracked);
            throw error;
          }
        };
      }
      if (property === "rename") {
        return async (fromPath, toPath) => {
          let expected = selfSidecarWrites.get(normalizePath(fromPath)) || null;
          if (!expected && isSidecarPath(fromPath) && isSidecarPath(toPath)) {
            try { expected = fingerprintSidecarValue(await target.read.call(target, fromPath)); }
            catch { /* If the source is unreadable, do not suppress its arrival event. */ }
          }
          const tracked = expected ? rememberSelfSidecarFingerprint(toPath, expected) : null;
          try {
            const result = await target.rename.call(target, fromPath, toPath);
            selfSidecarWrites.delete(normalizePath(fromPath));
            return result;
          } catch (error) {
            forgetSelfSidecarWrite(tracked);
            throw error;
          }
        };
      }
      if (property === "remove") {
        if (typeof target.remove !== "function") return undefined;
        return async (path) => {
          const result = await target.remove.call(target, path);
          const normalized = normalizePath(path);
          for (const trackedPath of selfSidecarWrites.keys()) {
            if (trackedPath === normalized || trackedPath.startsWith(`${normalized}/`)) {
              selfSidecarWrites.delete(trackedPath);
            }
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const store = storeFactory({
    adapter,
    coordinationAdapter: backingAdapter,
    sourceExists: (path) => Boolean(app.vault.getAbstractFileByPath(path)),
    root: ANNOTATION_ROOT,
    normalizePath,
    uuid: makeToken,
    hash: hashRuntime.fingerprint,
    identityHash: identityHash || hashRuntime.fingerprint,
    verifyHash: typeof hashRuntime.matches === "function" ? hashRuntime.matches : undefined,
    deviceId,
    onTiming: (details) => log("annotation-performance", details),
  });
  const queues = new Map();
  const documentViews = new Map();
  const sourceStates = new Map();
  const snapshotReads = new Map();
  const maintenanceRequests = new Map();
  const maintenanceTimers = new Set();
  const maintenanceByDocument = new Map();
  let disposed = false;
  let logicalClock = 0;

  async function initializeView(view, value) {
    assertLive();
    const bytes = bytesView(value);
    const file = view.documentFile || view.file;
    if (!file || typeof file.path !== "string") throw codedError("PDF_ANNOTATION_SOURCE_MISSING", "The source PDF is no longer available.");
    const sourcePath = normalizePath(file.path);
    const source = sourceMetadata(bytes, file, hashRuntime, sourcePath);
    const prior = await store.documentForPath(sourcePath);
    let sourceHashCompatMatch = false;
    if (prior?.source?.sourceHash && prior.source.sourceHash !== source.sourceHash &&
        typeof hashRuntime.matches === "function" && hashRuntime.matches(bytes, prior.source.sourceHash)) {
      // A previous build may have recorded SHA-256 while this runtime now
      // prefers XXH64. Verify the old algorithm against the actual bytes and
      // retain that trusted revision so the format transition cannot look
      // like a false external modification.
      source.sourceHash = prior.source.sourceHash;
      source.fastHash = prior.source.sourceHash;
      sourceHashCompatMatch = true;
    }
    const registered = await store.registerDocument({ sourcePath, source });
    let currentDocument = registered;
    let legacyIdentityScanUncertain = registered.sourceMismatch === true;
    let inspectedLegacyTombstones = [];
    let appendedLegacyTombstones = false;
    if (!registered.sourceMismatch && !registered.legacyIdentityScanComplete) {
      const legacyMarkerFound = containsAscii(bytes, "/ObReaderMerge") || containsAscii(bytes, "/ObReaderId");
      let identities = [];
      if (legacyMarkerFound) {
        if (typeof inspectLegacy !== "function") {
          legacyIdentityScanUncertain = true;
        } else {
          try {
            const inspected = await inspectLegacy(bytes);
            if (!Array.isArray(inspected?.identities)) {
              throw codedError("PDF_ANNOTATION_LEGACY_INSPECT_INVALID", "The legacy annotation identity inspector returned an invalid result.");
            }
            const eligible = inspected.identities.filter((entry) =>
              entry && typeof entry.uuid === "string" &&
              !entry.uuid.startsWith("legacy-") && !entry.uuid.startsWith("session-") &&
              (entry.deleted === true || (typeof entry.ref === "string" && entry.ref.trim())) &&
              Number.isSafeInteger(entry.pageIndex) &&
              ["freetext", "square", "underline", "highlight", "ink"].includes(String(entry.kind).toLowerCase())
            );
            // A deleted annotation can share a PDF object reference with a
            // later live editor after PDF.js rewrites the page. Tombstones are
            // UUID operations, not object-to-editor mappings, so only live
            // rows participate in the unique legacy reference map.
            identities = eligible.filter((entry) => entry.deleted !== true);
            inspectedLegacyTombstones = eligible.filter((entry) => entry.deleted === true);
          } catch (error) {
            legacyIdentityScanUncertain = true;
            log("legacy-annotation-identity-scan-failed", {
              path: sourcePath,
              code: error.code || "unknown",
            });
          }
        }
      }
      if (!legacyIdentityScanUncertain) {
        try {
          currentDocument = await store.updateLegacyIdentities({ document: registered, identities });
        } catch (error) {
          // Ambiguous legacy identities make migration unsafe, but they do not
          // make the source PDF unreadable. Keep the scan incomplete, leave the
          // embedded PDF annotations untouched, and open this document in the
          // existing read-only mode instead of aborting Reader initialization.
          legacyIdentityScanUncertain = true;
          log("legacy-annotation-identity-migration-failed", {
            documentId: registered.documentId,
            path: sourcePath,
            code: error.code || "unknown",
          });
        }
      }
      log("legacy-annotation-identity-scan", {
        documentId: registered.documentId,
        markerFound: legacyMarkerFound,
        importedIdentityCount: identities.length,
        tombstoneCount: inspectedLegacyTombstones.length,
        complete: !legacyIdentityScanUncertain,
        payloadMigration: "LAZY_ON_EDIT_EXACT_REF",
      });
    }
    if (!registered.sourceMismatch && !legacyIdentityScanUncertain) {
      const tombstoneRows = [
        ...(currentDocument.legacyIdentities || []).filter((entry) => entry.deleted === true),
        ...inspectedLegacyTombstones,
      ];
      const uniqueTombstones = new Map();
      for (const entry of tombstoneRows) {
        const key = `${entry.uuid}\0${entry.timestamp || 0}\0${entry.logical || 0}\0${entry.actorId || "legacy"}`;
        uniqueTombstones.set(key, entry);
      }
      const activeReferenceKeys = new Set((currentDocument.legacyIdentities || [])
        .filter((entry) => entry.deleted !== true && entry.ref)
        .map((entry) => `${entry.pageIndex}\0${canonicalRef(entry.ref)}`));
      const legacyTombstones = [...uniqueTombstones.values()].map((entry) => ({
          uuid: entry.uuid,
          kind: legacyOperationKind(entry.kind),
          pageIndex: entry.pageIndex,
          deleted: true,
          // Do not suppress a live editor when a historical tombstone reused
          // the same page/object reference. Otherwise retain the exact ref so
          // a still-present deleted editor can be hidden without guessing.
          embeddedRef: entry.ref && activeReferenceKeys.has(`${entry.pageIndex}\0${canonicalRef(entry.ref)}`)
            ? null : entry.ref || null,
          clock: {
            timestamp: entry.timestamp || 0,
            logical: entry.logical || 0,
            deviceId,
            opId: entry.operationId || `legacy-delete-${hashRuntime.fingerprint(utf8(
              `${entry.uuid}\n${entry.timestamp || 0}\n${entry.logical || 0}\n${entry.actorId || "legacy"}`,
            )).split(":").at(-1)}`,
          },
        }));
      if (legacyTombstones.length) {
        const digest = hashRuntime.fingerprint(utf8(legacyTombstones
          .map((entry) => `${entry.uuid}:${entry.clock.timestamp}:${entry.clock.logical}:${entry.clock.opId}`)
          .sort().join("\n"))).split(":").at(-1);
        const result = await store.appendOperations({
          document: currentDocument,
          batchId: `legacy-tombstones-${digest}`,
          operations: legacyTombstones,
        });
        appendedLegacyTombstones = result.operationCount > 0 && result.duplicate !== true;
      }
    }
    // Source mismatch is a hard read-only boundary. readDocument() may replay,
    // materialize checkpoints, update ACKs and run GC; do not let an untrusted
    // source revision alter recovery state that belongs to the prior PDF.
    const snapshot = registered.sourceMismatch
      ? emptySnapshot(currentDocument, source)
      : await readSnapshot(currentDocument);
    const hasStoredPageIdentity = Number.isSafeInteger(registered.source.pageCount) &&
      Array.isArray(registered.source.orderedPageIdentities) &&
      registered.source.orderedPageIdentities.length === registered.source.pageCount;
    const hydrationAllowed = ["MATCH", "BASELINE_ESTABLISHED"].includes(registered.sourceMatch) &&
      !registered.sourceMismatch && hasStoredPageIdentity;
    view.annotationDocument = currentDocument;
    view.annotationLegacyIdentityUncertain = legacyIdentityScanUncertain;
    view.annotationSourceHash = source.sourceHash;
    view.annotationSourceMismatch = registered.sourceMismatch === true;
    view.annotationHydrationAllowed = hydrationAllowed;
    view.annotationSnapshot = snapshot;
    updateSyncStatus(view, snapshot);
    if (appendedLegacyTombstones) broadcastSnapshot(currentDocument, snapshot, view);
    if (legacyIdentityScanUncertain) {
      view.setStatus?.(registered.sourceMismatch
        ? "PDF 来源已变化；外置批注已暂停，Reader 以只读模式打开。"
        : "检测到旧版 PDF 批注，但无法验证其身份；已进入只读模式，原 PDF 未修改。", true);
    }
    const state = { document: currentDocument, source, file, path: sourcePath };
    sourceStates.set(currentDocument.documentId, state);
    addView(currentDocument.documentId, view);
    log("annotation-open", {
      storageProtocol: store.sourceProtocol || "format3",
      documentId: currentDocument.documentId,
      docKey: currentDocument.docKey,
      path: sourcePath,
      sourceMatch: registered.sourceMatch,
      sourceHashCompatMatch,
      hydrationAllowed,
      annotationCount: Object.keys(snapshot.annotations || {}).length,
      operationCount: snapshot.revision,
    });
    if (hydrationAllowed) return snapshot;
    const provisional = emptySnapshot(currentDocument, source);
    if (registered.sourceMismatch) provisional.legacyIdentities = [];
    return provisional;
  }

  async function handleMessage(view, message) {
    if (disposed || !message || typeof message !== "object") return false;
    if (message.type === "annotation-maintenance-state") {
      const pending = maintenanceRequests.get(message.probeId);
      if (!pending || message.documentId !== view.documentId || message.openRequest !== view.openRequest ||
          !pending.views.delete(view)) return true;
      if (message.idle !== true) pending.cancelled = true;
      if (!pending.views.size) {
        maintenanceRequests.delete(message.probeId);
        if (!pending.cancelled) await materializeIdleDocument(pending.document);
      }
      return true;
    }
    if (message.type === "annotation-source-identity") {
      await confirmPageIdentity(view, message);
      return true;
    }
    if (message.type === "save") {
      await persist(view, message, false);
      return true;
    }
    if (message.type === "recover") {
      await persist(view, message, true);
      return true;
    }
    return false;
  }

  async function confirmPageIdentity(view, message) {
    const doc = view.annotationDocument;
    if (!doc || message.documentId !== view.documentId || message.openRequest !== view.openRequest) return;
    const pageCount = Number.isSafeInteger(message.pageCount) && message.pageCount >= 0 ? message.pageCount : null;
    const identities = Array.isArray(message.orderedPageIdentities) &&
      message.orderedPageIdentities.length === pageCount &&
      message.orderedPageIdentities.every((item) => typeof item === "string" && item.length <= 512)
      ? message.orderedPageIdentities : null;
    if (!identities || message.identityStatus === "UNKNOWN") {
      view.annotationSourceMismatch = true;
      view.annotationHydrationAllowed = false;
      view.annotationLegacyIdentityUncertain = true;
      post(view, {
        type: "annotation-source-mismatch",
        documentId: doc.documentId,
        openRequest: view.openRequest,
        reason: "PAGE_IDENTITY_UNAVAILABLE",
      });
      view.setStatus?.("无法确认 PDF 的有序页面身份；外置批注已暂停并以只读模式打开。", true);
      log("annotation-page-identity-unavailable", { documentId: doc.documentId, pageCount });
      return;
    }
    const identityInput = {
      document: doc,
      sourceHash: view.annotationSourceHash,
      size: sourceStates.get(doc.documentId)?.source?.size,
      tailHash64k: sourceStates.get(doc.documentId)?.source?.tailHash64k,
    };
    if (pageCount !== null) identityInput.pageCount = pageCount;
    if (identities) identityInput.orderedPageIdentities = identities;
    const result = await store.updateSourceIdentity(identityInput);
    if (result.sourceMismatch || !["MATCH", "BASELINE_ESTABLISHED"].includes(result.sourceMatch)) {
      view.annotationSourceMismatch = true;
      view.annotationHydrationAllowed = false;
      view.annotationPageIdentity = { pageCount, orderedPageIdentities: identities };
      post(view, {
        type: "annotation-source-mismatch",
        documentId: doc.documentId,
        openRequest: view.openRequest,
        reason: "SOURCE_REVISION_MISMATCH",
      });
      view.setStatus?.("PDF 来源已变化；外置批注已暂停加载和保存，原 PDF 未修改。请核对恢复记录。", true);
      log("annotation-source-mismatch", { documentId: doc.documentId, pageCount });
      return;
    }

    view.annotationDocument = result.document;
    view.annotationHydrationAllowed = true;
    view.annotationSourceMismatch = false;
    view.annotationPageIdentity = { pageCount, orderedPageIdentities: identities };
    const snapshot = await readSnapshot(result.document);
    view.annotationSnapshot = snapshot;
    updateSyncStatus(view, snapshot);
    const states = sourceStates.get(doc.documentId);
    if (states) states.document = result.document;
    post(view, {
      type: "external-annotations-update",
      documentId: doc.documentId,
      openRequest: view.openRequest,
      externalAnnotations: snapshot,
      sourceMatch: result.sourceMatch,
      identityConfirmed: true,
      readOnly: view.annotationLegacyIdentityUncertain === true || view.annotationSyncPending === true,
    });
    log("annotation-source-identity", {
      documentId: doc.documentId,
      pageCount,
      identityCount: identities?.length ?? 0,
      sourceMatch: result.sourceMatch,
      hydrationAllowed: true,
    });
  }

  async function persist(view, message, recovery) {
    const captured = {
      document: view.annotationDocument,
      documentId: view.documentId,
      openRequest: view.openRequest,
      file: view.documentFile || view.file,
      iframe: view.iframe,
      revision: message.revision,
      requestId: message.requestId,
    };
    const startedAt = now();
    const requestedType = recovery ? "recovered" : "saved";
    try {
      validatePersistRequest(view, message, captured);
      if (view.annotationSourceMismatch && !recovery) {
        throw codedError("PDF_ANNOTATION_SOURCE_CHANGED", "The PDF source changed; external annotations are paused to prevent misapplication.");
      }
      if (view.annotationHydrationAllowed === false && !view.annotationSourceMismatch) {
        throw codedError("PDF_ANNOTATION_PAGE_IDENTITY_UNCONFIRMED", "The PDF page identity has not been confirmed yet.");
      }
      const operations = normalizeOperations(message.operations, deviceId, () => nextClock(message));
      if (operations.length === 0 && message.revision > (view.confirmedRevision || 0)) {
        throw codedError("PDF_ANNOTATION_OPERATIONS_MISSING", "The Reader reported an unconfirmed edit revision without its annotation operations.");
      }
      const enqueueKey = captured.document.documentId;
      const previous = queues.get(enqueueKey) || Promise.resolve();
      const task = previous.catch(() => {}).then(async () => {
        validatePersistRequest(view, message, captured);
        const statChanged = await validateSourceStat(captured.document.documentId, captured.file, { allowChanged: recovery });
        const quarantined = Boolean(recovery && (view.annotationSourceMismatch || statChanged));
        if (statChanged) {
          view.annotationSourceMismatch = true;
          view.annotationHydrationAllowed = false;
        }
        if (quarantined) validateQuarantinedRecovery(message, captured.document);
        if (!operations.length) {
          return { acknowledged: true, operationCount: 0, batchId: null, snapshotPending: false, quarantined };
        }
        const batchId = typeof message.batchId === "string" && message.batchId.length <= 128
          ? message.batchId : makeToken();
        const result = await store.appendOperations({
          document: captured.document,
          operations,
          batchId,
          sourceHash: captured.document.source.sourceHash,
          quarantined,
        });
        // Snapshot materialization is a rebuildable cache; never hold the
        // save/close acknowledgement for this larger replay/write.
        void scheduleSnapshotMaterialization(captured.document);
        void broadcastDocument(captured.document, view);
        return result;
      });
      const queued = task.finally(() => {
        if (queues.get(enqueueKey) === queued) queues.delete(enqueueKey);
      });
      queues.set(enqueueKey, queued);
      const result = await queued;
      validatePersistRequest(view, message, captured);
      const acknowledgedRevision = Number.isSafeInteger(message.revision) && message.revision >= 0
        ? message.revision : 0;
      view.confirmedRevision = Math.max(view.confirmedRevision || 0, acknowledgedRevision);
      view.currentRevision = Math.max(view.currentRevision || 0, acknowledgedRevision);
      post(view, {
        type: requestedType,
        ok: true,
        documentId: captured.documentId,
        openRequest: captured.openRequest,
        requestId: captured.requestId,
        revision: acknowledgedRevision,
        confirmedRevision: view.confirmedRevision,
        batchId: result.batchId,
        operationCount: store.sourceProtocol === "wal-sidecar-v3.1" ? operations.length : result.operationCount,
        external: true,
        quarantined: result.quarantined === true,
      });
      view.setStatus?.(result.quarantined ? "PDF 来源已变化；批注操作已隔离保存，未应用到当前 PDF" :
        recovery ? "恢复操作已安全写入外置记录" : "批注已保存到外置记录", true);
      log(recovery ? "annotation-recovered" : "annotation-saved", {
        storageProtocol: store.sourceProtocol || "format3",
        documentId: captured.documentId,
        requestId: captured.requestId,
        revision: acknowledgedRevision,
        batchId: result.batchId,
        operationCount: result.operationCount,
        elapsedMs: now() - startedAt,
        external: true,
        quarantined: result.quarantined === true,
      });
      view.failureNoticeShown = false;
    } catch (error) {
      post(view, {
        type: "error",
        code: error.code || (recovery ? "recovery-failed" : "save-failed"),
        message: error.message || "Unable to persist external annotation operations.",
        documentId: captured.documentId,
        openRequest: captured.openRequest,
        requestId: captured.requestId,
        revision: captured.revision,
      });
      view.setStatus?.(error.message, true);
      log("annotation-persist-failed", {
        documentId: captured.documentId,
        requestId: captured.requestId,
        revision: captured.revision,
        recovery,
        elapsedMs: now() - startedAt,
        code: error.code || "unknown",
      });
      if (!view.failureNoticeShown) {
        view.failureNoticeShown = true;
        if (typeof Notice === "function") new Notice(`PDF 批注记录失败：${error.message}。操作仍保留在当前阅读器中。`, 8000);
      }
    }
  }

  async function validateSourceStat(documentId, file, { allowChanged = false } = {}) {
    const state = sourceStates.get(documentId);
    if (!state || !file) throw codedError("PDF_ANNOTATION_SOURCE_MISSING", "The PDF source identity is unavailable.");
    const currentPath = normalizePath(file.path);
    if (currentPath !== state.path) {
      throw codedError("PDF_ANNOTATION_PATH_CHANGED", "The PDF moved during save; retry after the rename has been indexed.");
    }
    const current = app.vault.getAbstractFileByPath(currentPath);
    if (current !== file) throw codedError("PDF_ANNOTATION_SOURCE_REPLACED", "The PDF source was replaced; annotation persistence is paused.");
    const currentSize = Number(file.stat?.size);
    const currentMtime = Number(file.stat?.mtime);
    const sizeChanged = Number.isFinite(currentSize) && currentSize !== state.source.size;
    const mtimeChanged = Number.isFinite(currentMtime) && Number.isFinite(state.source.mtime) && currentMtime !== state.source.mtime;
    if (!allowChanged && sizeChanged) {
      throw codedError("PDF_ANNOTATION_SOURCE_CHANGED", "The PDF size changed outside the Reader; annotation persistence is paused.");
    }
    if (!allowChanged && mtimeChanged) {
      throw codedError("PDF_ANNOTATION_SOURCE_CHANGED", "The PDF changed outside the Reader; annotation persistence is paused.");
    }
    return sizeChanged || mtimeChanged;
  }

  async function scheduleSnapshotMaterialization(document) {
    if (store.sourceProtocol === "wal-sidecar-v3.1") {
      const previous = maintenanceByDocument.get(document.documentId);
      if (previous) { globalThis.clearTimeout(previous); maintenanceTimers.delete(previous); }
      const timer = globalThis.setTimeout(() => {
        maintenanceTimers.delete(timer);
        maintenanceByDocument.delete(document.documentId);
        if (disposed) return;
        const views = new Set([...(documentViews.get(document.documentId) || [])].filter((view) => !view.teardownStarted));
        if (!views.size) { void materializeIdleDocument(document); return; }
        const probeId = makeToken();
        maintenanceRequests.set(probeId, { document, views, cancelled: false });
        for (const view of views) post(view, { type: "annotation-maintenance-probe", probeId,
          documentId: view.documentId, openRequest: view.openRequest });
        const expiry = globalThis.setTimeout(() => {
          maintenanceTimers.delete(expiry);
          maintenanceRequests.delete(probeId);
        }, 2000);
        maintenanceTimers.add(expiry);
      }, app.isMobile ? 3000 : 1000);
      maintenanceTimers.add(timer);
      maintenanceByDocument.set(document.documentId, timer);
      return;
    }
    return materializeIdleDocument(document);
  }

  async function materializeIdleDocument(document) {
    if (disposed) return;
    try {
      await nextTask();
      const snapshot = await store.materializeSnapshot(document);
      if (snapshot.syncPending) {
        log("annotation-snapshot-sync-pending", { documentId: document.documentId });
        return;
      }
      log("annotation-snapshot-materialized", { documentId: document.documentId });
    } catch (error) {
      // The immutable operation batch is already durable and authoritative.
      log("annotation-snapshot-materialize-failed", { documentId: document.documentId, code: error.code || "unknown" });
    }
  }

  async function broadcastDocument(document, excludedView = null) {
    try {
      const snapshot = await readSnapshot(document);
      broadcastSnapshot(document, snapshot, excludedView);
    } catch (error) {
      log("annotation-broadcast-failed", { documentId: document.documentId, code: error.code || "unknown" });
    }
  }

  function readSnapshot(document) {
    const previous = snapshotReads.get(document.documentId) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => store.readDocument(document));
    snapshotReads.set(document.documentId, task);
    void task.finally(() => {
      if (snapshotReads.get(document.documentId) === task) snapshotReads.delete(document.documentId);
    }).catch(() => {});
    return task;
  }

  function broadcastSnapshot(document, snapshot, excludedView = null) {
    for (const view of documentViews.get(document.documentId) || []) {
      if (view === excludedView || view.teardownStarted || view.documentId !== document.documentId) continue;
      updateSyncStatus(view, snapshot);
      post(view, {
        type: "external-annotations-update",
        documentId: document.documentId,
        openRequest: view.openRequest,
        externalAnnotations: snapshot,
        sourceMatch: "MATCH",
        readOnly: view.annotationLegacyIdentityUncertain === true || view.annotationSyncPending === true,
      });
    }
  }

  async function handleSidecarChange(file) {
    if (disposed || !file?.path) return false;
    const changedPath = normalizePath(file.path);
    if (!changedPath.startsWith(`${ANNOTATION_ROOT}/`)) return false;
    store.invalidateRegistry?.();
    const affectedDocuments = [];
    for (const [documentId, state] of sourceStates) {
      const paths = store.pathsFor(state.document);
      const isGlobalIndex = changedPath === `${ANNOTATION_ROOT}/_index.json`;
      const matches = typeof store.affectsPath === "function" ? store.affectsPath(state.document, changedPath) : isGlobalIndex || [
        paths.snapshot,
        paths.metadata,
        paths.checkpoint,
        paths.checkpointBackup,
      ].includes(changedPath) || [
        paths.operations,
        paths.deviceStates,
        paths.identityEvents,
      ].some((directory) => changedPath.startsWith(`${directory}/`));
      if (matches) affectedDocuments.push({ documentId, document: state.document });
    }
    if (!affectedDocuments.length) return true;
    // A Sync provider may deliver a directory entry, immutable operation, ACK,
    // and checkpoint in separate steps. Re-read after the short write window;
    // a still-missing referenced object stays read-only until its own event.
    await nextTask(40);
    // DataAdapter writes trigger the same Vault events as Sync writes. Suppress
    // only a path whose current bytes still match an exact payload written by
    // this host; a changed hash falls through to normal external replay.
    const expectedSelfWrite = selfSidecarWrites.get(changedPath);
    if (expectedSelfWrite) {
      try {
        const current = await backingAdapter.read(changedPath);
        const currentFingerprint = fingerprintSidecarValue(current);
        if (currentFingerprint && currentFingerprint.byteLength === expectedSelfWrite.byteLength &&
            currentFingerprint.digest === expectedSelfWrite.digest) {
          return true;
        }
      } catch { /* A missing or unreadable path is not an acknowledged self-write. */ }
      if (selfSidecarWrites.get(changedPath) === expectedSelfWrite) selfSidecarWrites.delete(changedPath);
    }
    for (const { documentId, document } of affectedDocuments) {
      await broadcastDocument(document);
      log("annotation-sidecar-changed", { documentId, path: changedPath });
    }
    return true;
  }

  async function handleSourceModify(file) {
    if (disposed || !file?.path) return false;
    const path = normalizePath(file.path);
    for (const [documentId, state] of sourceStates) {
      if (state.path !== path) continue;
      const bytes = new Uint8Array(await app.vault.readBinary(file));
      const currentHash = hashRuntime.fingerprint(bytes);
      const unchanged = typeof hashRuntime.matches === "function"
        ? hashRuntime.matches(bytes, state.source.sourceHash)
        : currentHash === state.source.sourceHash;
      if (!unchanged) {
        for (const view of documentViews.get(documentId) || []) {
          view.annotationSourceMismatch = true;
          view.annotationHydrationAllowed = false;
          post(view, { type: "annotation-source-mismatch", documentId, openRequest: view.openRequest, reason: "SOURCE_MODIFIED_EXTERNALLY" });
          view.setStatus?.("检测到原始 PDF 已被外部修改；外置批注已暂停，原文件未写入。", true);
        }
        log("annotation-source-modified", { documentId, path });
      } else {
        state.source = { ...state.source, size: bytes.byteLength,
          tailHash64k: hashRuntime.fingerprint(bytes.subarray(Math.max(0, bytes.byteLength - TAIL_SAMPLE_BYTES))),
          mtime: Number.isFinite(file.stat?.mtime) ? file.stat.mtime : state.source.mtime };
      }
      return true;
    }
    return false;
  }

  async function renamed(file, oldPath) {
    if (!file || !oldPath) return false;
    const fromPath = normalizePath(oldPath);
    const toPath = normalizePath(file.path);
    const views = [...documentViews.values()].flatMap((set) => [...set]);
    const view = views.find((candidate) => candidate.annotationDocument?.sourcePath === fromPath || candidate.requestedPath === fromPath);
    const previousDocument = view?.annotationDocument || await store.documentForPath(fromPath);
    if (!previousDocument) return false;
    const document = await store.renameDocument({
      documentId: previousDocument.documentId,
      fromPath,
      toPath,
      source: { path: toPath, size: file.stat?.size },
    });
    const state = sourceStates.get(document.documentId);
    if (state) { state.document = document; state.path = toPath; state.file = file; }
    for (const candidate of documentViews.get(document.documentId) || []) {
      candidate.annotationDocument = document;
      candidate.requestedPath = toPath;
      if (view && candidate.documentFile === view.documentFile) candidate.documentFile = file;
      if (view && candidate.file === view.file) candidate.file = file;
      post(candidate, { type: "annotation-path-updated", documentId: document.documentId, openRequest: candidate.openRequest, sourcePath: toPath });
    }
    log("annotation-document-renamed", { documentId: document.documentId, fromPath, toPath });
    return true;
  }

  function releaseView(view) {
    const id = view?.annotationDocument?.documentId;
    if (!id) return;
    const set = documentViews.get(id);
    set?.delete(view);
    if (set?.size === 0) documentViews.delete(id);
    if (set?.size === 0 && !disposed && store.sourceProtocol === "wal-sidecar-v3.1") {
      void scheduleSnapshotMaterialization(view.annotationDocument);
    }
  }

  async function establishNewCopy(view) {
    const file = view?.documentFile || view?.file;
    if (!file || typeof store.establishNewCopy !== "function") throw codedError("WAL_COPY_SOURCE_MISSING", "Open the copied PDF first.");
    const bytes = new Uint8Array(await app.vault.readBinary(file));
    return store.establishNewCopy({ sourcePath: file.path,
      source: sourceMetadata(bytes, file, hashRuntime, normalizePath(file.path)) });
  }

  function addView(id, view) {
    let set = documentViews.get(id);
    if (!set) documentViews.set(id, (set = new Set()));
    set.add(view);
  }

  function post(view, payload) {
    view.postToViewer?.({ channel: "pdf-web-reader", token: view.token, ...payload });
  }

  function validatePersistRequest(view, message, captured) {
    if (disposed) throw codedError("PDF_ANNOTATION_HOST_DISPOSED", "The annotation host has been disposed.");
    if (!captured.document || !captured.file || message.documentId !== captured.documentId ||
        captured.documentId !== captured.document.documentId ||
        captured.openRequest !== view.openRequest || view.documentId !== captured.documentId ||
        message.openRequest !== captured.openRequest ||
        (view.documentFile || view.file) !== captured.file ||
        normalizePath(captured.file.path) !== normalizePath(captured.document.sourcePath)) {
      throw codedError("PDF_ANNOTATION_SESSION_CHANGED", "The PDF Reader session changed before the operation batch was confirmed.");
    }
    if (!Array.isArray(message.operations)) throw codedError("PDF_ANNOTATION_OPERATIONS_INVALID", "The Reader did not provide a structured annotation operation list.");
    if (!Number.isSafeInteger(message.revision) || message.revision < 0) throw codedError("PDF_ANNOTATION_REVISION_INVALID", "The annotation revision is invalid.");
    if (view.annotationSyncPending === true) {
      throw codedError("PDF_ANNOTATION_SYNC_PENDING", "Annotation history is still syncing; editing is paused until its referenced batches arrive.");
    }
  }

  function normalizeOperations(input, actorId, createClock) {
    if (input.length > 10000) throw codedError("PDF_ANNOTATION_OPERATIONS_LIMIT", "Too many annotation operations were submitted in one batch.");
    return input.map((item) => {
      if (!item || typeof item !== "object") throw codedError("PDF_ANNOTATION_OPERATIONS_INVALID", "An annotation operation is invalid.");
      const operation = { ...item };
      operation.kind = operation.kind || operation.type;
      delete operation.type;
      operation.clock = { ...(operation.clock || {}) };
      let fallback = null;
      if (!Number.isFinite(operation.clock.timestamp) || !Number.isSafeInteger(operation.clock.logical) || operation.clock.logical < 0) {
        fallback = createClock();
      }
      if (!Number.isFinite(operation.clock.timestamp)) operation.clock.timestamp = fallback.timestamp;
      if (!Number.isSafeInteger(operation.clock.logical) || operation.clock.logical < 0) operation.clock.logical = fallback.logical;
      operation.clock.deviceId = actorId;
      if (typeof operation.clock.opId !== "string" || !operation.clock.opId) operation.clock.opId = makeToken();
      return operation;
    });
  }

  function nextClock(message) {
    const timestamp = Number.isFinite(message?.editedAt) ? message.editedAt : Date.now();
    logicalClock += 1;
    return { timestamp, logical: logicalClock, deviceId, opId: makeToken() };
  }

  function sourceMetadata(bytes, file, runtime, sourcePath) {
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - TAIL_SAMPLE_BYTES));
    const fullHash = runtime.fingerprint(bytes);
    return {
      sourcePath,
      path: sourcePath,
      size: bytes.byteLength,
      mtime: Number.isFinite(file.stat?.mtime) ? file.stat.mtime : null,
      sourceHash: fullHash,
      fastHash: fullHash,
      tailHash64k: runtime.fingerprint(tail),
    };
  }

  function emptySnapshot(document, source) {
    return {
      schemaVersion: 1,
      kind: "pdf-annotation-snapshot",
      documentId: document.documentId,
      docKey: document.docKey,
      source: { ...source, sourcePath: document.sourcePath },
      revision: 0,
      legacyIdentities: (document.legacyIdentities || []).filter((identity) => identity.deleted !== true && identity.ref),
      legacyIdentityScanComplete: document.legacyIdentityScanComplete === true,
      annotations: [],
    };
  }

  function bytesView(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Invalid PDF source bytes.");
  }

  function assertLive() { if (disposed) throw codedError("PDF_ANNOTATION_HOST_DISPOSED", "The annotation host has been disposed."); }
  function dispose() {
    disposed = true;
    for (const timer of maintenanceTimers) globalThis.clearTimeout(timer);
    maintenanceTimers.clear(); maintenanceRequests.clear(); maintenanceByDocument.clear();
    queues.clear(); snapshotReads.clear(); selfSidecarWrites.clear();
    for (const set of documentViews.values()) set.clear();
    documentViews.clear(); sourceStates.clear();
  }

  return {
    store,
    initializeView,
    handleMessage,
    handleSidecarChange,
    handleSourceModify,
    renamed,
    releaseView,
    establishNewCopy,
    broadcastDocument,
    dispose,
  };
}

function containsAscii(bytes, needle) {
  if (!needle || bytes.byteLength < needle.length) return false;
  const encoded = new Uint8Array(needle.length);
  for (let index = 0; index < needle.length; index += 1) encoded[index] = needle.charCodeAt(index);
  outer: for (let offset = 0; offset <= bytes.byteLength - encoded.length; offset += 1) {
    for (let index = 0; index < encoded.length; index += 1) {
      if (bytes[offset + index] !== encoded[index]) continue outer;
    }
    return true;
  }
  return false;
}

function validateQuarantinedRecovery(message, document) {
  const source = document.source || {};
  const recoverySource = message.source && typeof message.source === "object" ? message.source : message;
  if (!source.sourceHash || recoverySource.sourceHash !== source.sourceHash ||
      !Number.isSafeInteger(source.pageCount) || !Array.isArray(source.orderedPageIdentities) ||
      recoverySource.pageCount !== source.pageCount || !Array.isArray(recoverySource.orderedPageIdentities) ||
      recoverySource.orderedPageIdentities.length !== source.orderedPageIdentities.length ||
      recoverySource.orderedPageIdentities.some((identity, index) => identity !== source.orderedPageIdentities[index])) {
    throw codedError("PDF_ANNOTATION_RECOVERY_IDENTITY_UNKNOWN", "Local operations cannot be quarantined safely because their original PDF page identity is unknown.");
  }
}

function nextTask(delay = 0) { return new Promise((resolve) => globalThis.setTimeout(resolve, delay)); }
function now() { return globalThis.performance?.now?.() ?? Date.now(); }
function updateSyncStatus(view, snapshot) {
  const wasPending = view.annotationSyncPending === true;
  view.annotationSyncPending = snapshot.syncPending === true;
  if (view.annotationSyncPending) {
    view.setStatus?.("批注同步尚未完整到达；当前显示最后一个已验证检查点并暂时只读，收到同步文件后会自动重试。", true);
  } else if (snapshot.retiredDeviceWrites?.length) {
    view.setStatus?.(`发现 ${snapshot.retiredDeviceWrites.length} 个已退役设备的迟到批注批次；已隔离保留，未应用。请升级设备或导出恢复。`, true);
  } else if (wasPending) {
    view.setStatus?.("批注同步已完成，已恢复编辑。", false);
  }
}
function utf8(value) { return new TextEncoder().encode(String(value)); }
function canonicalRef(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}
function legacyOperationKind(value) {
  const kind = String(value || "").toLowerCase();
  if (kind === "freetext" || kind === "free-text") return "FreeText";
  if (kind === "square" || kind === "rectangle") return "Square";
  if (kind === "underline") return "Underline";
  if (kind === "highlight") return "Highlight";
  if (kind === "ink" || kind === "inkhighlight") return kind === "inkhighlight" ? "InkHighlight" : "Ink";
  throw codedError("PDF_ANNOTATION_LEGACY_KIND_INVALID", "A legacy annotation kind cannot be migrated safely.");
}
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
function defaultNormalizePath(value) { return String(value).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, ""); }

module.exports = { createPdfAnnotationHost, ANNOTATION_ROOT };
