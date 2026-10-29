/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { createWalAnnotationStore } = require("./storage/wal-annotation-store.cjs");
const { createSingleJsonlAnnotationStore } = require("./storage/single-jsonl-annotation-store.cjs");
const { createSingleJsonlMigrationRunner } = require("./storage/single-jsonl-migration-runner.cjs");
const { createSingleJsonlVaultMigration } = require("./storage/single-jsonl-vault-migration.cjs");
const { appendPairUpdate } = require("./pdf-pair-id.cjs");
const { createSourceVersions } = require("./pdf-source-versions.cjs");
const { prepareNativeErase, prepareNativeRestore, getNativeAnnotationIndex } = require("./pdf-native-erase.cjs");
const { digestMigrationBytes } = require("./storage/single-jsonl-migration.cjs");

const ANNOTATION_ROOT = "00_Archive/20_PDFData";
const TAIL_SAMPLE_BYTES = 64 * 1024;

function encodeBase64(bytes) {
  if (typeof Uint8Array.prototype.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, Math.min(bytes.length, start + 0x8000)));
  }
  return globalThis.btoa(binary);
}

function decodeBase64(value) {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(value);
  const binary = globalThis.atob(value), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

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
  enableJsonl = false,
  enableSingleJsonl = false,
  pairDocument = null,
  verifyOutlineUpdate = null,
  reopenVerifiedView = null,
}) {
  if (!app?.vault?.adapter || !hashRuntime || typeof hashRuntime.fingerprint !== "function") {
    throw new TypeError("PDF annotation host requires a Vault adapter and hash runtime.");
  }
  const backingAdapter = app.vault.adapter;
  const selfSidecarWrites = new Map();
  const appendAccumulators = new Map();
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
  const trackAppendContent = (path, value) => {
    const normalized = normalizePath(path);
    if (!normalized.endsWith(".jsonl") || !isSidecarPath(normalized) || typeof value !== "string") return;
    const accumulator = hashRuntime.createAccumulator();
    const bytes = utf8(value);
    accumulator.update(bytes);
    appendAccumulators.set(normalized, { accumulator, byteLength: bytes.byteLength });
  };
  const forgetSelfSidecarWrite = (tracked) => {
    if (tracked && selfSidecarWrites.get(tracked.path) === tracked.record) {
      selfSidecarWrites.delete(tracked.path);
    }
  };
  const adapter = new Proxy(backingAdapter, {
    get(target, property) {
      if (property === "process") {
        if (typeof target.process !== "function") return undefined;
        return async (path, modify) => {
          let tracked = null;
          let replacement;
          try {
            const result = await target.process.call(target, path, (current) => {
              const next = modify(current);
              if (typeof next !== "string") throw new TypeError("Adapter callback must synchronously return text.");
              if (next !== current) {
                replacement = next;
                tracked = rememberSelfSidecarWrite(path, next);
              }
              return next;
            });
            if (tracked) trackAppendContent(path, replacement);
            return result;
          } catch (error) {
            forgetSelfSidecarWrite(tracked);
            throw error;
          }
        };
      }
      if (property === "write") {
        return async (path, value) => {
          const tracked = rememberSelfSidecarWrite(path, value);
          try {
            const result = await target.write.call(target, path, value);
            trackAppendContent(path, value);
            return result;
          } catch (error) {
            appendAccumulators.delete(normalizePath(path));
            forgetSelfSidecarWrite(tracked);
            throw error;
          }
        };
      }
      if (property === "read") {
        return async (path) => {
          const value = await target.read.call(target, path);
          trackAppendContent(path, value);
          return value;
        };
      }
      if (property === "append") {
        if (typeof target.append !== "function") return undefined;
        return async (path, value) => {
          const normalized = normalizePath(path);
          let tracked;
          if (normalized.endsWith(".jsonl") && isSidecarPath(normalized)) {
            let known = appendAccumulators.get(normalized);
            if (!known) {
              let previous = "";
              try { previous = await target.read.call(target, path); } catch { /* New append target. */ }
              trackAppendContent(path, previous);
              known = appendAccumulators.get(normalized);
            }
            const bytes = utf8(value);
            known.accumulator.update(bytes);
            known.byteLength += bytes.byteLength;
            tracked = rememberSelfSidecarFingerprint(path, {
              byteLength: known.byteLength,
              digest: known.accumulator.digest(),
            });
          } else {
            let previous = "";
            try { previous = await target.read.call(target, path); } catch { /* New append target. */ }
            tracked = rememberSelfSidecarWrite(path, `${previous}${value}`);
          }
          try {
            return await target.append.call(target, path, value);
          } catch (error) {
            appendAccumulators.delete(normalized);
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
            appendAccumulators.delete(normalizePath(fromPath));
            appendAccumulators.delete(normalizePath(toPath));
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
          appendAccumulators.delete(normalized);
          return result;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const chosenStoreFactory = enableSingleJsonl && storeFactory === createWalAnnotationStore
    ? createSingleJsonlAnnotationStore : storeFactory;
  const store = chosenStoreFactory({
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
    jsonlMode: enableJsonl,
    pairDocument: enableSingleJsonl ? (pairDocument || pairNewDocument) : pairDocument,
    onTiming: (details) => log("annotation-performance", details),
  });
  const queues = new Map();
  const documentViews = new Map();
  const sourceStates = new Map();
  const nativeEraseHistory = new Map();
  const pairingWrites = new Map();
  const sourceVersions = createSourceVersions({ adapter: backingAdapter, makeToken });
  const outlineJobs = new Map();
  const snapshotReads = new Map();
  const maintenanceRequests = new Map();
  const maintenanceTimers = new Set();
  const maintenanceByDocument = new Map();
  const pendingSidecarChecks = new Map();
  let disposed = false;
  let migrationRunning = false;
  let logicalClock = 0;

  async function pairNewDocument(document) {
    const state = sourceStates.get(document.documentId);
    const file = state?.file;
    if (!state || !file || normalizePath(file.path) !== state.path || app.vault.getAbstractFileByPath(state.path) !== file) {
      throw codedError("PDF_ANNOTATION_SOURCE_MISSING", "The PDF is no longer available for pairing.");
    }
    const runner = createSingleJsonlMigrationRunner({
      adapter: backingAdapter, store: store.core,
      journalRoot: `${app.vault.configDir || ".obsidian"}/plugins/pdf-web-reader/.v15-migration`,
      verifySource: (bytes, expected) => typeof hashRuntime.matches === "function"
        ? hashRuntime.matches(bytes, expected) : hashRuntime.fingerprint(bytes) === expected,
      readPdf: async () => app.vault.readBinary(file),
      writePdf: async (_path, value) => {
        const expected = hashRuntime.fingerprint(value);
        const pending = { expectedHash: expected, bytes: value, originalSize: state.physicalSource.size };
        pairingWrites.set(state.path, pending);
        try {
          await appendPairUpdate(app.vault, file, value);
          state.physicalSource = sourceMetadata(value, file, hashRuntime, state.path);
        } catch (error) {
          // A partially written increment is recoverable only when every byte
          // still matches the prepared PDF and the original prefix is intact.
          try {
            const partial = new Uint8Array(await app.vault.readBinary(file));
            if (pairingPrefixMatches(partial, pending)) state.physicalSource = sourceMetadata(partial, file, hashRuntime, state.path);
            else pairingWrites.delete(state.path);
          } catch { pairingWrites.delete(state.path); }
          throw error;
        }
      },
    });
    const result = await runner.migrate({ document, snapshot: { annotations: [], tombstones: [], deletionGuards: [] } });
    state.document = result.document;
    for (const view of documentViews.get(document.documentId) || []) view.annotationDocument = result.document;
    return result;
  }

  async function initializeView(view, value) {
    if (migrationRunning) throw codedError("V15_MIGRATION_IN_PROGRESS", "Wait for annotation migration to finish before opening a PDF.");
    assertLive();
    let bytes = bytesView(value);
    const file = view.documentFile || view.file;
    if (!file || typeof file.path !== "string") throw codedError("PDF_ANNOTATION_SOURCE_MISSING", "The source PDF is no longer available.");
    const sourcePath = normalizePath(file.path);
    let source = sourceMetadata(bytes, file, hashRuntime, sourcePath);
    const physicalSource = { ...source };
    const openRequest = view.openRequest;
    const assertOpenCurrent = () => {
      if (disposed || view.openRequest !== openRequest || view.teardownStarted ||
          (view.documentFile || view.file) !== file || normalizePath(file.path) !== sourcePath)
        throw codedError("PDF_ANNOTATION_SESSION_CHANGED", "The PDF Reader session changed while opening.");
    };
    let prior;
    let registered;
    let sourceHashCompatMatch = false;
    try {
      prior = await store.documentForPath(sourcePath);
      const recovered = await recoverNativeEraseJournal(sourcePath, file, prior, bytes);
      if (recovered) { bytes = recovered.bytes; source = sourceMetadata(bytes, file, hashRuntime, sourcePath); Object.assign(physicalSource, source); }
      if (store.sourceProtocol === "obreader-current-v15" && prior?.pairing?.pairedSha256 &&
          typeof hashRuntime.matches === "function" && (typeof hashRuntime.matchesAsync === "function"
            ? await hashRuntime.matchesAsync(bytes, prior.pairing.pairedSha256)
            : hashRuntime.matches(bytes, prior.pairing.pairedSha256))) {
        // Pairing appends PDF metadata once. Preserve the pre-pairing logical
        // source used by existing annotations and links only after the paired
        // physical PDF bytes have been verified against the migration receipt.
        Object.assign(source, prior.source);
        sourceHashCompatMatch = true;
      }
      assertOpenCurrent();
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
      if (prior?.source?.sourceHash && prior.source.sourceHash !== source.sourceHash && !sourceHashCompatMatch) {
        const version = await verifyOutlineVersion(file, bytes, prior, {
          isCurrent: () => !disposed && view.openRequest === openRequest && !view.teardownStarted,
        });
        if (version) Object.assign(source, version.logicalSource);
      }
      // A paired PDF may be edited by another reader. Keep its existing
      // external annotations associated with the same pair on the next open.
      if (store.sourceProtocol === "obreader-current-v15" && prior?.pairId &&
          prior.source?.sourceHash !== source.sourceHash &&
          await require("./pdf-pair-id.cjs").readPairId(bytes) === prior.pairId) {
        assertOpenCurrent();
        const updated = await store.updateSourceIdentity({ document: prior, pairId: prior.pairId,
          allowVerifiedSourceTransition: true, ...source,
          pageCount: prior.source.pageCount, orderedPageIdentities: prior.source.orderedPageIdentities,
          pairing: { pairedSha256: null } });
        if (updated.sourceMismatch) throw codedError("SOURCE_MISMATCH", "The paired PDF source could not be updated.");
        prior = updated.document;
      }
      registered = await store.registerDocument({ sourcePath, source });
      assertOpenCurrent();
    } catch (error) {
      if (error?.code === "PDF_ANNOTATION_SESSION_CHANGED") throw error;
      // Identity collisions, incomplete Sync shards, and corrupt metadata are
      // annotation-store failures, not PDF decode failures. Give this open
      // attempt an ephemeral non-persistent identity so the immutable source
      // remains readable. It is deliberately unusable for annotation writes.
      const fallbackDocument = prior || {
        documentId: `unverified:${makeToken()}`,
        docKey: `unverified-${makeToken()}`,
        sourcePath,
        initialPath: sourcePath,
        source,
        legacyIdentities: [],
        legacyIdentityScanComplete: false,
      };
      const snapshot = emptySnapshot(fallbackDocument, source);
      snapshot.legacyIdentities = [];
      snapshot.syncPending = true;
      view.annotationDocument = fallbackDocument;
      view.annotationLegacyIdentityUncertain = false;
      view.annotationSourceHash = source.sourceHash;
      view.annotationSourceMismatch = false;
      view.annotationHydrationAllowed = false;
      view.annotationSyncPending = true;
      view.annotationSnapshot = snapshot;
      view.annotationStorageUnavailable = true;
      view.setStatus?.("外置批注数据无法验证；PDF 已只读打开，批注数据保留且未应用。修复同步数据后重新打开。", true);
      log("annotation-storage-unavailable", {
        path: sourcePath,
        code: error?.code || "ANNOTATION_STORAGE_UNAVAILABLE",
        reason: String(error?.message || error).slice(0, 512),
      });
      return snapshot;
    }
    let currentDocument = registered;
    let legacyIdentityScanUncertain = registered.sourceMismatch === true;
    let inspectedLegacyTombstones = [];
    let appendedLegacyTombstones = false;
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
      if (legacyTombstones.length && store.sourceProtocol !== "obreader-current-v15") {
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
    let snapshotReadError = null;
    let snapshot;
    if (registered.sourceMismatch) {
      snapshot = emptySnapshot(currentDocument, source);
    } else {
      try {
        snapshot = await readSnapshot(currentDocument);
      } catch (error) {
        // A broken or partially migrated annotation ledger must not make the
        // immutable PDF unreadable. Keep every source record untouched, show
        // no unverified annotations, and leave this view read-only until the
        // ledger can be verified again.
        snapshotReadError = error;
        snapshot = emptySnapshot(currentDocument, source);
        snapshot.legacyIdentities = [];
        snapshot.syncPending = true;
        log("annotation-snapshot-unavailable", {
          documentId: currentDocument.documentId,
          path: sourcePath,
          code: error?.code || "ANNOTATION_SNAPSHOT_UNAVAILABLE",
        });
      }
    }
    assertOpenCurrent();
    const hasStoredPageIdentity = Number.isSafeInteger(registered.source.pageCount) &&
      Array.isArray(registered.source.orderedPageIdentities) &&
      registered.source.orderedPageIdentities.length === registered.source.pageCount;
    const hydrationAllowed = ["MATCH", "BASELINE_ESTABLISHED"].includes(registered.sourceMatch) &&
      !registered.sourceMismatch && !snapshotReadError && hasStoredPageIdentity && snapshot.requiresPairValidation !== true;
    view.annotationDocument = currentDocument;
    view.annotationLegacyIdentityUncertain = legacyIdentityScanUncertain;
    view.annotationSourceHash = source.sourceHash;
    view.annotationSourceMismatch = registered.sourceMismatch === true;
    view.annotationHydrationAllowed = hydrationAllowed;
    view.annotationSnapshot = snapshot;
    updateSyncStatus(view, snapshot);
    if (snapshotReadError) {
      view.annotationStorageUnavailable = true;
      view.setStatus?.("外置批注数据无法验证；PDF 已只读打开，批注数据保留且未应用。修复同步数据后重新打开。", true);
    }
    if (appendedLegacyTombstones) broadcastSnapshot(currentDocument, snapshot, view);
    if (legacyIdentityScanUncertain) {
      view.setStatus?.(registered.sourceMismatch
        ? "PDF 来源已变化；外置批注已暂停，Reader 以只读模式打开。"
        : "检测到旧版 PDF 批注，但无法验证其身份；已进入只读模式，原 PDF 未修改。", true);
    }
    const state = { document: currentDocument, source, physicalSource, file, path: sourcePath };
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
    if (snapshot.requiresPairValidation === true && !snapshotReadError && !registered.sourceMismatch) {
      // Deletion masking remains available before first paint; editors remain
      // absent until the Viewer confirms the pair ID and ordered pages.
      return { ...snapshot, annotations: [], requiresPairValidation: true };
    }
    if (registered.sourceMismatch || snapshotReadError) provisional.legacyIdentities = [];
    if (snapshotReadError) provisional.syncPending = true;
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
        if (pending.resolve) pending.resolve(!pending.cancelled);
        else if (!pending.cancelled) await materializeIdleDocument(pending.document);
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
    if (view.annotationSyncPending === true) {
      // Do not mutate source metadata or enable editing while the annotation
      // records themselves are unverified. A later reopen can retry the full
      // identity handshake after Sync has delivered a complete ledger.
      view.annotationPageIdentity = { pageCount, orderedPageIdentities: identities };
      return;
    }
    const identityInput = {
      document: doc,
      ...(store.sourceProtocol === "obreader-current-v15" ? { pairId: message.pairId ?? null } : {}),
      sourceHash: view.annotationSourceHash,
      size: sourceStates.get(doc.documentId)?.source?.size,
      tailHash64k: sourceStates.get(doc.documentId)?.source?.tailHash64k,
    };
    if (pageCount !== null) identityInput.pageCount = pageCount;
    if (identities) identityInput.orderedPageIdentities = identities;
    let result;
    try {
      result = await store.updateSourceIdentity(identityInput);
    } catch (error) {
      view.annotationSyncPending = true;
      view.annotationHydrationAllowed = false;
      view.annotationStorageUnavailable = true;
      view.annotationPageIdentity = { pageCount, orderedPageIdentities: identities };
      view.setStatus?.("外置批注数据无法验证；PDF 保持只读，批注数据未修改。修复同步数据后重新打开。", true);
      log("annotation-source-identity-confirm-failed", {
        documentId: doc.documentId,
        code: error?.code || "ANNOTATION_SNAPSHOT_UNAVAILABLE",
      });
      return;
    }
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
    let snapshot;
    try {
      snapshot = await readSnapshot(result.document);
    } catch (error) {
      view.annotationSyncPending = true;
      view.annotationHydrationAllowed = false;
      view.annotationStorageUnavailable = true;
      view.annotationPageIdentity = { pageCount, orderedPageIdentities: identities };
      view.setStatus?.("外置批注数据无法验证；PDF 保持只读，批注数据未修改。修复同步数据后重新打开。", true);
      log("annotation-source-identity-confirm-failed", {
        documentId: doc.documentId,
        code: error?.code || "ANNOTATION_SNAPSHOT_UNAVAILABLE",
      });
      return;
    }
    view.annotationSnapshot = snapshot;
    view.annotationStorageUnavailable = false;
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
    const nativeJournalPaths = [];
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
        const nativeDeletes = operations.filter((operation) => operation.deleted === true && operation.provenance === "embedded");
        const nativeRestores = operations.filter((operation) => operation.provenance === "embedded" && operation.deleted !== true);
        const nativeOperations = [...nativeDeletes, ...nativeRestores];
        if (nativeDeletes.length && nativeRestores.length)
          throw codedError("PDF_NATIVE_ERASE_MIXED_ACTIONS", "A single save cannot combine native erase and restore actions.");
        if (nativeOperations.length && (recovery || quarantined || view.annotationSourceMismatch))
          throw codedError("PDF_NATIVE_ERASE_SOURCE_CHANGED", "Embedded annotation changes are paused while PDF source recovery is quarantined.");
        const externalOperations = operations.filter((operation) => !nativeOperations.includes(operation));
        if (nativeDeletes.length) {
          const erased = await eraseEmbeddedAnnotations(captured.document, nativeDeletes);
          if (erased?.journalPath) nativeJournalPaths.push(erased.journalPath);
          captured.document = view.annotationDocument || captured.document;
        }
        if (nativeRestores.length) {
          const restored = await restoreEmbeddedAnnotations(captured.document, nativeRestores);
          if (restored?.journalPath) nativeJournalPaths.push(restored.journalPath);
          captured.document = view.annotationDocument || captured.document;
        }
        if (!externalOperations.length) {
          return { acknowledged: true, operationCount: nativeOperations.length,
          batchId: nativeOperations.map(operation => operation.operationId || operation.clock?.opId).filter(Boolean).join("+") || null,
          nativeJournalPaths,
            snapshotPending: false, quarantined };
        }
        if (!operations.length) {
          return { acknowledged: true, operationCount: 0, batchId: null, snapshotPending: false, quarantined };
        }
        const batchId = typeof message.batchId === "string" && message.batchId.length <= 128
          ? message.batchId : makeToken();
        const result = await store.appendOperations({
          document: captured.document,
          operations: externalOperations,
          batchId,
          sourceHash: captured.document.source.sourceHash,
          quarantined,
        });
        // Snapshot materialization is a rebuildable cache; never hold the
        // save/close acknowledgement for this larger replay/write.
        void scheduleSnapshotMaterialization(captured.document, {
          immediate: result.pendingSinceCheckpoint >= 100,
        });
        void broadcastDocument(captured.document, view);
        return nativeOperations.length ? { ...result, operationCount: result.operationCount + nativeOperations.length,
          batchId: [...nativeOperations.map(operation => operation.operationId || operation.clock?.opId).filter(Boolean), result.batchId].filter(Boolean).join("+"),
          nativeJournalPaths } : result;
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
        operationCount: store.sourceProtocol?.startsWith("wal-sidecar-v3.") ? operations.length : result.operationCount,
        ...(result.nativeJournalPaths?.length ? { nativeSourceHash: captured.document.source.sourceHash } : {}),
        external: true,
        quarantined: result.quarantined === true,
      });
      view.setStatus?.(result.quarantined ? "PDF 来源已变化；批注操作已隔离保存，未应用到当前 PDF" :
        recovery ? "恢复操作已安全写入外置记录" : "批注已保存到外置记录", true);
      for (const path of result.nativeJournalPaths || []) await backingAdapter.remove?.(path);
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
    const physical = state.physicalSource || state.source;
    const sizeChanged = Number.isFinite(currentSize) && currentSize !== physical.size;
    const mtimeChanged = Number.isFinite(currentMtime) && Number.isFinite(physical.mtime) && currentMtime !== physical.mtime;
    if (!allowChanged && sizeChanged) {
      throw codedError("PDF_ANNOTATION_SOURCE_CHANGED", "The PDF size changed outside the Reader; annotation persistence is paused.");
    }
    if (!allowChanged && mtimeChanged) {
      throw codedError("PDF_ANNOTATION_SOURCE_CHANGED", "The PDF changed outside the Reader; annotation persistence is paused.");
    }
    return sizeChanged || mtimeChanged;
  }

  async function eraseEmbeddedAnnotations(document, operations) {
    const state = sourceStates.get(document.documentId);
    const missing = [];
    if (!state) missing.push("当前文档的来源状态");
    else if (!state.file) missing.push("当前 PDF 文件");
    if (!Array.isArray(operations) || !operations.length) missing.push("要擦除的批注列表");
    else operations.forEach((operation, index) => {
      if (!operation.ref && operation.embeddedRef) operation.ref = operation.embeddedRef;
      if (!operation.ref) missing.push(`第 ${index + 1} 条批注的 PDF 内部引用编号`);
      if (!Number.isSafeInteger(operation.pageIndex) || operation.pageIndex < 0) missing.push(`第 ${index + 1} 条批注的有效页码`);
      if (!operation.kind) missing.push(`第 ${index + 1} 条批注的类型`);
    });
    if (missing.length) throw codedError("PDF_NATIVE_ERASE_IDENTITY_INVALID", `无法擦除 PDF 内嵌批注：缺少或无效的信息：${missing.join("、")}。原 PDF 未修改。`);
    let bytes = bytesView(await app.vault.readBinary(state.file));
    if (hashRuntime.fingerprint(bytes) !== state.physicalSource.sourceHash) {
      throw codedError("PDF_NATIVE_ERASE_SOURCE_CHANGED", "The PDF changed before the embedded annotation could be erased.");
    }
    let activeDocument = document;
    if (!activeDocument.pairId) {
      // Validate the complete batch against the current unpaired bytes before
      // invoking the existing journaled first-pair migration.
      let previewBytes = bytes;
      for (const operation of operations) {
        const preview = await prepareNativeErase({ sourceBytes: previewBytes, pairId: null, allowUnpairedPreview: true,
          pageIndex: operation.pageIndex, ref: operation.ref, kind: operation.kind });
        previewBytes = preview.bytes;
      }
      await store.appendOperations({ document: activeDocument, operations: [], sourceHash: activeDocument.source?.sourceHash });
      activeDocument = state.document;
      if (!activeDocument?.pairId) throw codedError("PDF_NATIVE_ERASE_PAIRING_REQUIRED", "The PDF could not be paired before native erasure.");
      bytes = bytesView(await app.vault.readBinary(state.file));
      if (hashRuntime.fingerprint(bytes) !== state.physicalSource.sourceHash)
        throw codedError("PDF_NATIVE_ERASE_SOURCE_CHANGED", "The PDF changed during first-pair migration.");
    }
    const originalTargets = await Promise.all(operations.map(operation => getNativeAnnotationIndex({sourceBytes:bytes,
      pairId:activeDocument.pairId,pageIndex:operation.pageIndex,ref:operation.ref,kind:operation.kind})));
    let preparedBytes = bytes;
    const preparedTargets = [];
    for (let i=0;i<operations.length;i++) {
      const operation=operations[i];
      const prepared = await prepareNativeErase({ sourceBytes: preparedBytes, pairId: activeDocument.pairId,
        pageIndex: operation.pageIndex, ref: operation.ref, kind: operation.kind });
      preparedBytes = prepared.bytes;
      preparedTargets.push({ pageIndex: operation.pageIndex, ref: prepared.ref, kind: prepared.kind,
        uuid: operation.uuid, index: originalTargets[i].index,
        operationId: operation.operationId || operation.clock?.opId || null });
    }
    const journalRoot = `${app.vault.configDir || ".obsidian"}/plugins/pdf-web-reader/.v15-native-erase`;
    const journalPath = `${journalRoot}/${activeDocument.docKey}.json`;
    if (await backingAdapter.exists(journalPath)) {
      throw codedError("PDF_NATIVE_ERASE_RECOVERY_REQUIRED", "An earlier embedded annotation erase needs recovery before another erase.");
    }
    if (!await backingAdapter.exists(journalRoot)) await backingAdapter.mkdir(journalRoot);
    const nextSource = sourceMetadata(preparedBytes, state.file, hashRuntime, state.path);
    const journal = { schemaVersion: 1, phase: "prepared", documentId: activeDocument.documentId, docKey: activeDocument.docKey,
      pairId: activeDocument.pairId, path: state.path, targets: preparedTargets,
      oldLength: bytes.length, newLength: preparedBytes.length, oldHash: hashRuntime.fingerprint(bytes), newHash: hashRuntime.fingerprint(preparedBytes),
      suffix: encodeBase64(preparedBytes.subarray(bytes.length)),
      source: state.source, nextSource, pairing: { ...(activeDocument.pairing || {}), pairedSha256: await digestMigrationBytes(preparedBytes), pairedSize: nextSource.size } };
    await backingAdapter.write(journalPath, JSON.stringify(journal));
    if (await backingAdapter.read(journalPath) !== JSON.stringify(journal)) throw codedError("PDF_NATIVE_ERASE_JOURNAL_UNVERIFIED", "The embedded erase recovery record could not be verified.");
    try {
      const pendingWrite = { expectedHash: journal.newHash, bytes: preparedBytes, originalSize: bytes.length };
      pairingWrites.set(state.path, pendingWrite);
      await appendPairUpdate(app.vault, state.file, preparedBytes);
      const confirmed = bytesView(await app.vault.readBinary(state.file));
      if (hashRuntime.fingerprint(confirmed) !== journal.newHash) throw codedError("PDF_NATIVE_ERASE_PDF_UNVERIFIED", "The PDF erase append could not be verified.");
      if (pairingWrites.get(state.path) === pendingWrite) pairingWrites.delete(state.path);
      nextSource.mtime = Number.isFinite(state.file.stat?.mtime) ? state.file.stat.mtime : nextSource.mtime;
      const identity = await store.updateSourceIdentity({ document: activeDocument, pairId: activeDocument.pairId, allowVerifiedSourceTransition: true,
        sourceHash: nextSource.sourceHash, size: nextSource.size, tailHash64k: nextSource.tailHash64k,
        pageCount: document.source.pageCount, orderedPageIdentities: document.source.orderedPageIdentities,
        pairing: journal.pairing });
      if (identity.sourceMismatch || !["MATCH", "BASELINE_ESTABLISHED"].includes(identity.sourceMatch))
        throw codedError("PDF_NATIVE_ERASE_JSONL_UNVERIFIED", "The annotation source identity did not advance with the PDF.");
      state.source = nextSource; state.physicalSource = nextSource; state.document = identity.document;
      for (const view of documentViews.get(activeDocument.documentId) || []) {
        view.annotationDocument = identity.document; view.annotationSourceHash = nextSource.sourceHash;
      }
      for (const target of preparedTargets) nativeEraseHistory.set(`${activeDocument.documentId}\0${target.uuid}`,
        { ...target, pairId: activeDocument.pairId, status: "deleted", sourceHash: nextSource.sourceHash });
      // Keep the receipt through the Viewer ACK. If the process stops after
      // the PDF/JSONL commit, open-time recovery verifies and clears it.
    } catch (error) {
      log("annotation-native-erase-recovery-required", { documentId: activeDocument.documentId, docKey: activeDocument.docKey, code: error.code || "unknown" });
      throw error;
    }
    return { journalPath };
  }

  async function recoverNativeEraseJournal(path, file, prior, initialBytes) {
    const root = `${app.vault.configDir || ".obsidian"}/plugins/pdf-web-reader/.v15-native-erase`;
    const journalPath = `${root}/${prior?.docKey || "unknown"}.json`;
    if (!await backingAdapter.exists(journalPath)) return null;
    let journal;
    try { journal = JSON.parse(await backingAdapter.read(journalPath)); }
    catch { throw codedError("PDF_NATIVE_ERASE_JOURNAL_INVALID", "The embedded erase recovery record is unreadable."); }
    if (journal.schemaVersion !== 1 || journal.path !== path || journal.documentId !== prior?.documentId ||
        journal.docKey !== prior?.docKey || journal.pairId !== prior?.pairId ||
        !Number.isSafeInteger(journal.oldLength) || !Number.isSafeInteger(journal.newLength) || journal.newLength <= journal.oldLength)
      throw codedError("PDF_NATIVE_ERASE_JOURNAL_IDENTITY_MISMATCH", "The embedded erase recovery record does not match this PDF.");
    const suffix = decodeBase64(journal.suffix);
    if (suffix.length !== journal.newLength - journal.oldLength) throw codedError("PDF_NATIVE_ERASE_JOURNAL_INVALID", "The embedded erase recovery bytes are incomplete.");
    let current = bytesView(await app.vault.readBinary(file));
    if (current.length < journal.oldLength || hashRuntime.fingerprint(current.subarray(0, journal.oldLength)) !== journal.oldHash || current.length > journal.newLength)
      throw codedError("PDF_NATIVE_ERASE_RECOVERY_CONFLICT", "The PDF differs from both recorded erase states; recovery stopped without overwriting it.");
    for (let i = journal.oldLength; i < current.length; i++) if (current[i] !== suffix[i - journal.oldLength])
      throw codedError("PDF_NATIVE_ERASE_RECOVERY_CONFLICT", "The partial PDF append differs from the prepared erase; recovery stopped.");
    if (current.length < journal.newLength) {
      const rest = suffix.subarray(current.length - journal.oldLength);
      await app.vault.appendBinary(file, rest.buffer.slice(rest.byteOffset, rest.byteOffset + rest.byteLength));
      current = bytesView(await app.vault.readBinary(file));
    }
    if (current.length !== journal.newLength || hashRuntime.fingerprint(current) !== journal.newHash || await require("./pdf-pair-id.cjs").readPairId(current) !== journal.pairId)
      throw codedError("PDF_NATIVE_ERASE_RECOVERY_CONFLICT", "The recovered PDF did not match the prepared erase.");
    if (prior.source?.sourceHash !== journal.nextSource.sourceHash) {
      const result = await store.updateSourceIdentity({ document: prior, pairId: prior.pairId, allowVerifiedSourceTransition: true,
        sourceHash: journal.nextSource.sourceHash, size: journal.nextSource.size, tailHash64k: journal.nextSource.tailHash64k,
        pageCount: prior.source.pageCount, orderedPageIdentities: prior.source.orderedPageIdentities, pairing: journal.pairing });
      if (result.sourceMismatch || result.document.source?.sourceHash !== journal.nextSource.sourceHash)
        throw codedError("PDF_NATIVE_ERASE_RECOVERY_CONFLICT", "The paired annotation identity could not be recovered.");
    }
    await backingAdapter.remove?.(journalPath);
    return { bytes: current };
  }

  async function scheduleSnapshotMaterialization(document, { immediate = false } = {}) {
    if (store.sourceProtocol?.startsWith("wal-sidecar-v3.")) {
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
      }, immediate ? 0 : app.isMobile ? 3000 : 1000);
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

  async function watchDeletionRetention() {
    if (disposed || store.sourceProtocol !== "wal-sidecar-v3.2-jsonl") return;
    for (const [id, state] of sourceStates) {
      const views = [...(documentViews.get(id) || [])].filter(view => !view.teardownStarted);
      if (!views.length || views.some(view => view.annotationSourceMismatch || view.annotationSyncPending ||
          view.annotationStorageUnavailable)) continue;
      await broadcastDocument(state.document);
      await scheduleSnapshotMaterialization(state.document);
    }
  }

  function readSnapshot(document) {
    const previous = snapshotReads.get(document.documentId) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const snapshot = await store.readDocument(document);
      if (store.sourceProtocol !== "obreader-current-v15") return snapshot;
      // Old embedded deletion identities may predate the sidecar ledger. Keep
      // them as a read-only mask, without manufacturing a new save on open.
      const seen = new Set([...(snapshot.annotations || []), ...(snapshot.tombstones || []),
        ...(snapshot.deletionGuards || [])].map(row => row.uuid));
      const identities = document.legacyIdentities || [];
      const activeRefs = new Set(identities.filter(row => row.deleted !== true && row.ref)
        .map(row => `${row.pageIndex}\0${canonicalRef(row.ref)}`));
      const projected = [];
      for (const row of identities) {
        if (row.deleted !== true || !row.uuid || seen.has(row.uuid)) continue;
        seen.add(row.uuid);
        const timestamp = Number.isSafeInteger(row.timestamp) && row.timestamp >= 0 ? row.timestamp : 0;
        const logical = Number.isSafeInteger(row.logical) && row.logical >= 0 ? row.logical : 0;
        const embeddedRef = row.ref && !activeRefs.has(`${row.pageIndex}\0${canonicalRef(row.ref)}`) ? row.ref : null;
        projected.push({ uuid: row.uuid, kind: legacyOperationKind(row.kind), pageIndex: row.pageIndex,
          embeddedRef, clock: { timestamp, logical, deviceId: row.actorId || "legacy", opId: row.operationId || `legacy-mask:${row.uuid}` } });
      }
      return projected.length ? { ...snapshot, tombstones: [...(snapshot.tombstones || []), ...projected] } : snapshot;
    });
    snapshotReads.set(document.documentId, task);
    void task.finally(() => {
      if (snapshotReads.get(document.documentId) === task) snapshotReads.delete(document.documentId);
    }).catch(() => {});
    return task;
  }

  function broadcastSnapshot(document, snapshot, excludedView = null) {
    for (const view of documentViews.get(document.documentId) || []) {
      if (view.teardownStarted || view.documentId !== document.documentId) continue;
      // Keep the host-side snapshot in sync even for the writer view, which
      // deliberately does not receive its own external-update message. Reader
      // backlinks and annotation UUID links consult this snapshot directly.
      view.annotationSnapshot = snapshot;
      if (view === excludedView) {
        void view.plugin?.refreshReaderBacklinksForView?.(view);
        continue;
      }
      updateSyncStatus(view, snapshot);
      post(view, {
        type: "external-annotations-update",
        documentId: document.documentId,
        openRequest: view.openRequest,
        externalAnnotations: snapshot,
        sourceMatch: "MATCH",
        readOnly: view.annotationLegacyIdentityUncertain === true ||
          view.annotationSyncPending === true || view.annotationStorageUnavailable === true,
      });
      void view.plugin?.refreshReaderBacklinksForView?.(view);
    }
  }

  async function handleSidecarChange(file) {
    if (disposed || !file?.path) return false;
    const changedPath = normalizePath(file.path);
    if (!changedPath.startsWith(`${ANNOTATION_ROOT}/`)) return false;
    const current = pendingSidecarChecks.get(changedPath);
    if (current) {
      current.generation += 1;
      return current.promise;
    }
    const pending = { generation: 1, checkedGeneration: 0, failed: false, promise: null };
    pendingSidecarChecks.set(changedPath, pending);
    pending.promise = (async () => {
      do {
        // Multiple Vault events for the same WAL are checked against one
        // exact final fingerprint. They are not ignored by a time window:
        // a changed external payload still flows through replay below.
        const scheduledGeneration = pending.generation;
        await nextTask(40);
        if (disposed) return true;
        // A newer event arrived while this check waited. Keep the request
        // pending and verify the settled generation once, rather than reading
        // an ever-growing own WAL on every timer tick. No event is discarded;
        // the final bytes still undergo the exact fingerprint check below.
        if (pending.generation !== scheduledGeneration && selfSidecarWrites.has(changedPath)) continue;
        const generation = pending.generation;
        await inspectSidecarChange(changedPath, pending, generation);
        pending.checkedGeneration = generation;
      } while (!disposed && pending.generation !== pending.checkedGeneration);
      return true;
    })().catch((error) => {
      pending.failed = true;
      throw error;
    }).finally(() => {
      if (pendingSidecarChecks.get(changedPath) === pending) pendingSidecarChecks.delete(changedPath);
      if (!disposed && !pending.failed && pending.generation !== pending.checkedGeneration) {
        void Promise.resolve(handleSidecarChange({ path: changedPath })).catch((error) =>
          log("annotation-sidecar-check-failed", { path: changedPath, code: error.code || "unknown" }));
      }
    });
    return pending.promise;
  }

  async function inspectSidecarChange(changedPath, pending, generation) {
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
    if (!affectedDocuments.length) return;
    // A Sync provider may deliver a directory entry, immutable operation, ACK,
    // and checkpoint in separate steps. Re-read after the short write window;
    // a still-missing referenced object stays read-only until its own event.
    // DataAdapter writes trigger the same Vault events as Sync writes. Suppress
    // only a path whose current bytes still match an exact payload written by
    // this host; a changed hash falls through to normal external replay.
    const expectedSelfWrite = selfSidecarWrites.get(changedPath);
    if (expectedSelfWrite) {
      try {
        const current = await backingAdapter.read(changedPath);
        const currentFingerprint = fingerprintSidecarValue(current);
        if (pending.generation !== generation || selfSidecarWrites.get(changedPath) !== expectedSelfWrite) return;
        if (currentFingerprint && currentFingerprint.byteLength === expectedSelfWrite.byteLength &&
            currentFingerprint.digest === expectedSelfWrite.digest) {
          return;
        }
      } catch { /* A missing or unreadable path is not an acknowledged self-write. */ }
      if (selfSidecarWrites.get(changedPath) === expectedSelfWrite) selfSidecarWrites.delete(changedPath);
    }
    if (pending.generation !== generation) return;
    store.invalidateExternal?.(changedPath);
    for (const { documentId, document } of affectedDocuments) {
      await broadcastDocument(document);
      log("annotation-sidecar-changed", { documentId, path: changedPath });
    }
  }

  async function verifyOutlineVersion(file, bytes, document, { expectedBeforeHash, expectedAfterHash, isCurrent = () => !disposed } = {}) {
    if (typeof verifyOutlineUpdate !== "function" || !document?.source || document.sourcePath !== normalizePath(file.path)) return null;
    if (expectedBeforeHash && (typeof hashRuntime.matches !== "function" ||
        !Number.isSafeInteger(document.source.size) || document.source.size > bytes.length ||
        !hashRuntime.matches(bytes.subarray(0, document.source.size), expectedBeforeHash))) {
      throw codedError("PDF_OUTLINE_BASE_MISMATCH", "The requested original source differs from this document.");
    }
    const capturedPath = normalizePath(file.path);
    const jobKey = `${document.documentId}:${hashRuntime.fingerprint(bytes)}`;
    let job = outlineJobs.get(jobKey);
    if (!job) {
      job = verifyOutlineUpdate({ bytes, source: document.source, expectedAfterHash }).finally(() => outlineJobs.delete(jobKey));
      outlineJobs.set(jobKey, job);
    }
    let proof;
    try { proof = await job; }
    catch (error) {
      log("annotation-outline-rejected", { documentId: document.documentId, path: capturedPath, code: error?.code || "PDF_OUTLINE_UPDATE_UNVERIFIED", reason: String(error?.message || error).slice(0, 512) });
      return null;
    }
    assertLive();
    if (!isCurrent() || file.path !== capturedPath || app.vault.getAbstractFileByPath(capturedPath) !== file) throw codedError("PDF_OUTLINE_SESSION_CHANGED", "The source moved or the Reader changed during verification.");
    // The Worker must never detach the Reader's bytes; re-read the live file
    // after asynchronous validation to rule out a replacement during the job.
    const current = bytesView(await app.vault.readBinary(file));
    const verifiedStat = { size: file.stat?.size, mtime: file.stat?.mtime };
    if (proof?.status !== "VERIFIED" || typeof hashRuntime.matches !== "function" ||
        !hashRuntime.matches(current, proof.afterHash) || current.byteLength !== proof.afterSize ||
        (expectedAfterHash && !hashRuntime.matches(current, expectedAfterHash)) || !isCurrent() ||
        app.vault.getAbstractFileByPath(capturedPath) !== file || file.path !== capturedPath) {
      throw codedError("PDF_OUTLINE_SOURCE_RACED", "The PDF changed while its directory update was being verified.");
    }
    const association = await sourceVersions.record(document, proof);
    if (!isCurrent() || app.vault.getAbstractFileByPath(capturedPath) !== file || file.path !== capturedPath ||
        file.stat?.size !== verifiedStat.size || file.stat?.mtime !== verifiedStat.mtime) throw codedError("PDF_OUTLINE_SESSION_CHANGED", "Source changed before association activation.");
    log("annotation-outline-verified", { documentId: document.documentId, docKey: document.docKey, beforeHash: proof.beforeHash, afterHash: proof.afterHash, recordPath: association.path, elapsedMs: proof.elapsedMs });
    return { proof, recordPath: association.path, logicalSource: { ...document.source, sourcePath: capturedPath, path: capturedPath, mtime: Number.isFinite(file.stat?.mtime) ? file.stat.mtime : null },
      physicalSource: sourceMetadata(current, file, hashRuntime, capturedPath) };
  }

  async function probeIdle(view) {
    if (!view?.ready || !view.iframe || view.teardownStarted || view.pendingSaves > 0 || view.currentRevision > view.confirmedRevision) return false;
    const documentId = view.documentId, openRequest = view.openRequest, probeId = makeToken();
    const idle = await new Promise(resolve => {
      const timer = globalThis.setTimeout(() => { maintenanceTimers.delete(timer); maintenanceRequests.delete(probeId); resolve(false); }, 2000);
      maintenanceTimers.add(timer);
      maintenanceRequests.set(probeId, { views: new Set([view]), resolve: value => { globalThis.clearTimeout(timer); maintenanceTimers.delete(timer); resolve(value); } });
      post(view, { type: "annotation-maintenance-probe", probeId, documentId, openRequest });
    });
    return idle && !disposed && !view.teardownStarted && view.documentId === documentId && view.openRequest === openRequest;
  }

  async function reopenCleanViews(document, file) {
    if (typeof reopenVerifiedView !== "function") return;
    for (const view of [...(documentViews.get(document.documentId) || [])]) {
      if (await probeIdle(view)) {
        await reopenVerifiedView(view, file);
      } else view.setStatus?.("目录更新已验证；请在当前更改已保存或恢复后重新打开 PDF。", true);
    }
  }

  async function acceptOutlineUpdate({ sourcePath, expectedBeforeHash, expectedAfterHash } = {}) {
    assertLive();
    const path = normalizePath(sourcePath || "");
    const file = path && app.vault.getAbstractFileByPath(path);
    const document = file && await store.documentForPath(path);
    if (!document || !file) throw codedError("PDF_OUTLINE_DOCUMENT_MISSING", "No verified document route matches this PDF.");
    const bytes = bytesView(await app.vault.readBinary(file));
    const version = await verifyOutlineVersion(file, bytes, document, { expectedBeforeHash, expectedAfterHash });
    if (!version) return { status: "TARGET_UNRESOLVED", documentId: document.documentId, docKey: document.docKey };
    // Keep old loaded pages paused until the authenticated clean-view probe
    // confirms that replacing this rendering cannot discard a current edit.
    for (const view of documentViews.get(document.documentId) || []) {
      view.annotationSourceMismatch = true; view.annotationHydrationAllowed = false;
      post(view, { type: "annotation-source-mismatch", documentId: view.documentId, openRequest: view.openRequest, reason: "OUTLINE_VERSION_VERIFIED_REOPEN_REQUIRED" });
    }
    await reopenCleanViews(document, file);
    return { status: "VERIFIED", documentId: document.documentId, docKey: document.docKey, beforeHash: version.proof.beforeHash, afterHash: version.proof.afterHash, recordPath: version.recordPath };
  }

  async function handleSourceModify(file) {
    if (disposed || !file?.path) return false;
    const path = normalizePath(file.path);
    for (const [documentId, state] of sourceStates) {
      if (state.path !== path) continue;
      const bytes = new Uint8Array(await app.vault.readBinary(file));
      const currentHash = hashRuntime.fingerprint(bytes);
      const ownPair = pairingWrites.get(path);
      if (ownPair && pairingPrefixMatches(bytes, ownPair)) {
        if (currentHash === ownPair.expectedHash) pairingWrites.delete(path);
        state.physicalSource = sourceMetadata(bytes, file, hashRuntime, path);
        return true;
      }
      const physical = state.physicalSource || state.source;
      const unchanged = typeof hashRuntime.matches === "function"
        ? hashRuntime.matches(bytes, physical.sourceHash)
        : currentHash === physical.sourceHash;
      if (!unchanged) {
        for (const view of documentViews.get(documentId) || []) {
          view.annotationSourceMismatch = true;
          view.annotationHydrationAllowed = false;
          post(view, { type: "annotation-source-mismatch", documentId, openRequest: view.openRequest, reason: "SOURCE_MODIFIED_EXTERNALLY" });
          view.setStatus?.("检测到原始 PDF 已被外部修改；外置批注已暂停，原文件未写入。", true);
        }
        log("annotation-source-modified", { documentId, path });
        try {
          const version = await verifyOutlineVersion(file, bytes, state.document);
          if (version) await reopenCleanViews(state.document, file);
        } catch (error) { log("annotation-outline-update-failed", { documentId, code: error?.code || "PDF_OUTLINE_UPDATE_UNVERIFIED" }); }
      } else {
        state.physicalSource = { ...physical, size: bytes.byteLength,
          tailHash64k: hashRuntime.fingerprint(bytes.subarray(Math.max(0, bytes.byteLength - TAIL_SAMPLE_BYTES))),
          mtime: Number.isFinite(file.stat?.mtime) ? file.stat.mtime : state.source.mtime };
      }
      return true;
    }
    return false;
  }

  function pairingPrefixMatches(bytes, pending) {
    if (!pending || bytes.length < pending.originalSize || bytes.length > pending.bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] !== pending.bytes[i]) return false;
    return true;
  }

  async function renamed(file, oldPath) {
    if (!file || !oldPath) return false;
    const fromPath = normalizePath(oldPath);
    const toPath = normalizePath(file.path);
    const views = [...documentViews.values()].flatMap((set) => [...set]);
    const view = views.find((candidate) => candidate.annotationDocument?.sourcePath === fromPath || candidate.requestedPath === fromPath);
    let previousDocument = view?.annotationDocument || await store.documentForPath(fromPath);
    if (!previousDocument && store.sourceProtocol === "obreader-current-v15" &&
        typeof store.documentForInterruptedRename === "function") {
      previousDocument = await store.documentForInterruptedRename({ fromPath, toPath });
    }
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
    if (set?.size === 0 && !disposed && store.sourceProtocol?.startsWith("wal-sidecar-v3.")) {
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
    if (view.annotationStorageUnavailable === true) {
      throw codedError("PDF_ANNOTATION_STORAGE_UNAVAILABLE", "Annotation storage is not verified for this Reader session; reopen after Sync completes before editing.");
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
  async function migrateLegacyVault() {
    assertLive();
    if (!enableSingleJsonl) throw codedError("V15_NOT_ENABLED", "The v15 store is not enabled.");
    if (migrationRunning || documentViews.size || queues.size || maintenanceRequests.size || snapshotReads.size)
      throw codedError("V15_READERS_OPEN", "Close all PDF Readers and wait for pending work before migration.");
    migrationRunning = true;
    try { return await createSingleJsonlVaultMigration({app,hashRuntime,identityHash,deviceId,uuid:makeToken,verifyOutlineUpdate}).migrate(); }
    finally { migrationRunning = false; }
  }
  async function recoverPairing(sourcePath) {
    assertLive();
    if (!enableSingleJsonl) throw codedError("V15_NOT_ENABLED", "The v15 store is not enabled.");
    if (migrationRunning || documentViews.size || queues.size || maintenanceRequests.size || snapshotReads.size)
      throw codedError("V15_READERS_OPEN", "Close all PDF Readers and wait for pending work before recovery.");
    migrationRunning = true;
    try { return await createSingleJsonlVaultMigration({app,hashRuntime,identityHash,deviceId,uuid:makeToken}).recoverPairing(sourcePath); }
    finally { migrationRunning = false; }
  }
  function dispose() {
    disposed = true;
    for (const pending of maintenanceRequests.values()) pending.resolve?.(false);
    for (const timer of maintenanceTimers) globalThis.clearTimeout(timer);
    maintenanceTimers.clear(); maintenanceRequests.clear(); maintenanceByDocument.clear();
    queues.clear(); snapshotReads.clear(); selfSidecarWrites.clear(); appendAccumulators.clear(); pendingSidecarChecks.clear();
    for (const set of documentViews.values()) set.clear();
    documentViews.clear(); sourceStates.clear();
    outlineJobs.clear();
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
    acceptOutlineUpdate,
    broadcastDocument,
    watchDeletionRetention,
    migrateLegacyVault,
    recoverPairing,
    dispose,
  };
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
  if (view.annotationStorageUnavailable === true) {
    view.setStatus?.("外置批注数据无法验证；PDF 已只读打开，批注数据保留且未应用。修复同步数据后重新打开。", true);
    return;
  }
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
