/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// External annotation storage with immutable operation suffixes and verified,
// replayable per-document checkpoints. This module deliberately depends only on
// injected Vault facilities; it has no Node/Electron runtime imports. Covered
// batches are removed only after device acknowledgements and a verified backup.
//
// Minimal API:
//   registerDocument({ sourcePath, source }) -> stable document + sourceMatch
//   updateSourceIdentity({ document, sourceHash, pageCount, orderedPageIdentities, ... })
//   appendOperations({ document, operations, batchId }) -> durable write acknowledgement
//   readDocument(document) -> checkpoint-backed Viewer snapshot
//   materializeSnapshot(document) -> verified checkpoint/pointer write
//   renameDocument({ documentId, fromPath, toPath }) -> updated path association
// `source.sourceHash` is the full hash (`xxh64-v1:` or `sha256-v1:`); a tail
// sample alone never authorizes reuse/hydration. Checkpoints are outside the
// PDF save/close acknowledgement path and can be materialized in background.

const STORE_SCHEMA = 1;
const INDEX_SCHEMA = 2;
const CHECKPOINT_SCHEMA = 2;
const CURRENT_PLUGIN_VERSION = "0.8.0";
const LEGACY_OPERATION_FORMAT = 2;
const CURRENT_OPERATION_FORMAT = 3;
const CHECKPOINT_FORMAT = 3;
const GC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMPACT_PAYLOAD_ENCODING = "float32le-base64-v1";
const VALID_TYPES = new Set(["Highlight", "Underline", "Square", "Ink", "InkHighlight", "FreeText"]);
const HASH_PREFIX = /^(xxh64-v1|sha256-v1):([a-f0-9]+)$/i;

function createPdfAnnotationStore({
  adapter,
  root = "00_Archive/20_PDFData",
  normalizePath = defaultNormalizePath,
  clock = () => Date.now(),
  uuid,
  hash,
  identityHash = hash,
  deviceId,
  onTiming = () => {},
  timingNow = defaultTimingNow,
}) {
  if (!adapter || typeof adapter.read !== "function" || typeof adapter.write !== "function" ||
      typeof adapter.exists !== "function" || typeof adapter.mkdir !== "function" ||
      typeof adapter.list !== "function" || typeof adapter.rename !== "function") {
    throw new TypeError("An Obsidian-compatible DataAdapter is required.");
  }
  if (typeof uuid !== "function" || typeof hash !== "function" || typeof identityHash !== "function") {
    throw new TypeError("Injected uuid, content hash, and stable identity hash functions are required.");
  }
  if (typeof deviceId !== "string" || !deviceId.trim()) throw new TypeError("A stable deviceId is required.");

  const baseRoot = normalizePath(root);
  if (!baseRoot || baseRoot.split("/").includes("..")) throw new TypeError("Invalid annotation store root.");
  const registryPath = `${baseRoot}/_index.json`;
  const operationsRoot = `${baseRoot}/ops`;
  const identityEventsRoot = `${baseRoot}/identity-events`;
  const deviceSegment = pathSegment(deviceId);
  const materializationQueues = new Map();
  const garbageCollectionQueues = new Map();

  function pathsFor(document) {
    const normalized = normalizeDocument(document);
    return {
      root: baseRoot,
      snapshot: `${baseRoot}/${safeBasename(normalized.sourcePath)}--${normalized.docKey}.pdfdata.json`,
      metadata: `${baseRoot}/documents/${normalized.docKey}.json`,
      checkpoint: `${baseRoot}/checkpoints/${normalized.docKey}.json`,
      checkpointBackup: `${baseRoot}/checkpoints/${normalized.docKey}.previous.json`,
      deviceStates: `${baseRoot}/checkpoints/${normalized.docKey}.devices`,
      operations: `${operationsRoot}/${normalized.docKey}`,
      deviceOperations: `${operationsRoot}/${normalized.docKey}/${deviceSegment}`,
      identityEvents: `${identityEventsRoot}/${normalized.docKey}`,
    };
  }

  function batchReference(batchDeviceId, batchId) {
    return `${pathSegment(batchDeviceId)}/${pathSegment(batchId)}`;
  }

  function safeTimingNow() {
    try {
      const value = timingNow();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  function emitTiming(details) {
    if (typeof onTiming !== "function") return;
    try {
      const result = onTiming(details);
      if (result && typeof result.then === "function") void Promise.resolve(result).catch(() => {});
    } catch {
      // Diagnostics must never change checkpoint or garbage-collection safety.
    }
  }

  async function registerDocument({ sourcePath, source = {}, documentId } = {}) {
    const normalizedPath = normalizeSourcePath(sourcePath);
    const index = await readIndex();
    const prior = index.documents[normalizedPath];
    if (prior) {
      const stored = normalizeDocument({ ...prior, sourcePath: normalizedPath });
      const sourceMatch = compareSourceRevision(stored.source, source);
      const document = sourceMatch === "MISMATCH"
        ? stored
        : normalizeDocument({ ...stored, source: mergeSource(stored.source, source) });
      if (canonicalJson(document.source) !== canonicalJson(stored.source)) {
        index.documents[normalizedPath] = document;
        await writeDocumentMetadata(document);
        await writeIndex(index);
      }
      const incomingHasHash = Boolean(source && (source.sourceHash || source.fastHash));
      const storedHadHash = Boolean(stored.source.sourceHash);
      const resultMatch = sourceMatch === "UNKNOWN" && incomingHasHash && !storedHadHash
        ? "BASELINE_ESTABLISHED" : sourceMatch;
      return { ...document, sourceMatch: resultMatch, sourceMismatch: sourceMatch === "MISMATCH" };
    }

    // Deriving first-open identity from the normalized Vault path means two
    // devices opening an unsynced file concurrently still converge. Rename
    // events preserve this id in the path index; a new path is a new document.
    const id = documentId || await makeDocumentId(normalizedPath);
    if (typeof id !== "string" || !id.trim()) throw new TypeError("documentId must be a non-empty string.");
    const docKey = await makeDocKey(id);
    let document = normalizeDocument({ documentId: id, docKey, sourcePath: normalizedPath, source });
    for (const [registeredPath, entry] of Object.entries(index.documents)) {
      if (entry.docKey === document.docKey &&
          (entry.documentId !== document.documentId || registeredPath !== normalizedPath)) {
        throw codedError("PDF_ANNOTATION_KEY_COLLISION", "Two document identities share the same 12-character docKey.");
      }
    }
    index.documents[normalizedPath] = document;
    await writeDocumentMetadata(document);
    const identityEvent = await appendIdentityEvent({ kind: "create", document, path: normalizedPath });
    document = normalizeDocument({ ...document, identityEventHeads: [identityEvent.eventId] });
    index.documents[normalizedPath] = document;
    await writeDocumentMetadata(document);
    await writeIndex(index);
    return { ...document, sourceMatch: document.source.sourceHash ? "BASELINE_ESTABLISHED" : "UNKNOWN", sourceMismatch: false };
  }

  async function renameDocument({ documentId, fromPath, toPath, source } = {}) {
    const from = normalizeSourcePath(fromPath);
    const to = normalizeSourcePath(toPath);
    if (from === to) return registerDocument({ sourcePath: from, source });
    const index = await readIndex();
    const existing = index.documents[from];
    if (!existing || existing.documentId !== documentId) {
      throw codedError("PDF_ANNOTATION_IDENTITY_MISSING", "No matching document identity is registered at the old path.");
    }
    const target = index.documents[to];
    if (target && target.documentId !== documentId) {
      throw codedError("PDF_ANNOTATION_PATH_CONFLICT", "The destination path is already associated with another PDF identity.");
    }
    const updated = normalizeDocument({ ...existing, sourcePath: to,
      source: mergeSource(existing.source, source, { path: to }) });
    delete index.documents[from];
    index.documents[to] = updated;
    const identityEvent = await appendIdentityEvent({ kind: "rename", document: updated, previous: existing,
      fromPath: from, path: to });
    const renamed = normalizeDocument({ ...updated, identityEventHeads: [...updated.identityEventHeads, identityEvent.eventId] });
    index.documents[to] = renamed;
    await writeDocumentMetadata(renamed);
    await writeIndex(index);

    // A snapshot is only a cache, so write the renamed cache at its new path.
    // The old snapshot is left in place rather than deleting user-visible data;
    // replaying operation batches will repair either path on next read.
    await materializeSnapshot(renamed);
    return renamed;
  }

  async function documentForPath(sourcePath) {
    const normalizedPath = normalizeSourcePath(sourcePath);
    const index = await readIndex();
    const document = index.documents[normalizedPath];
    return document ? normalizeDocument({ ...document, sourcePath: normalizedPath }) : null;
  }

  // Export the effective Format 3 state for a one-shot store migration. Unlike
  // readDocument(), this path is strictly read-only: index repair is disabled,
  // unresolved paths are errors, and no checkpoint, ACK, snapshot, or GC work
  // is scheduled. Replay remains authoritative, so a missing or partial batch
  // fails closed instead of exporting a partial view.
  async function exportForMigration(sourcePathOrDocument) {
    const document = await resolveDocument(sourcePathOrDocument, { readOnly: true });
    const state = await replay(document, { readOnly: true });
    const rows = Object.values(state.annotations)
      .map((row) => normalizeOperation(row))
      .sort((left, right) => compareString(left.uuid, right.uuid));
    const metadata = {
      documentId: document.documentId,
      docKey: document.docKey,
      sourcePath: document.sourcePath,
      source: { ...document.source },
      legacyIdentities: document.legacyIdentities.map((identity) => ({ ...identity })),
      legacyIdentityScanComplete: document.legacyIdentityScanComplete,
      identityEventHeads: [...document.identityEventHeads],
    };
    const annotations = rows.filter((row) => row.deleted !== true);
    const tombstones = rows.filter((row) => row.deleted === true);
    const snapshot = { annotations, tombstones };
    return {
      schemaVersion: 1,
      kind: "pdf-annotation-format3-migration-export",
      formatVersion: state.formatVersion,
      document: metadata,
      metadata,
      routing: { sourcePath: document.sourcePath, documentId: document.documentId, docKey: document.docKey },
      source: { ...document.source, sourcePath: document.sourcePath },
      legacyIdentities: metadata.legacyIdentities,
      legacyIdentityScanComplete: document.legacyIdentityScanComplete,
      annotations,
      tombstones,
      snapshot,
      rows,
      state: {
        revision: state.revision,
        updatedAt: state.updatedAt,
        formatVersion: state.formatVersion,
      },
    };
  }

  async function appendOperations({ document, operations, batchId, sourceHash, quarantined = false } = {}) {
    const normalizedDocument = await resolveDocument(document);
    if ((await readDeviceState(normalizedDocument, deviceId))?.retired === true) {
      throw codedError("PDF_ANNOTATION_DEVICE_RETIRED", "This device has been retired from the PDF annotation history and cannot append changes.");
    }
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new TypeError("appendOperations requires at least one annotation operation.");
    }
    const id = batchId || await uuid();
    if (typeof id !== "string" || !id.trim()) throw new TypeError("batchId must be a non-empty string.");
    const normalizedSourceHash = sourceHash || normalizedDocument.source.sourceHash;
    const canonicalSourceHash = normalizedSourceHash ? canonicalHash(normalizedSourceHash) : null;
    const isQuarantined = quarantined === true;
    const locations = pathsFor(normalizedDocument);
    await ensureDirectory(locations.deviceOperations);
    const batchPath = `${locations.deviceOperations}/${pathSegment(id)}.json`;
    if (await adapter.exists(batchPath)) {
      const current = await adapter.read(batchPath);
      let prior;
      try { prior = JSON.parse(current); }
      catch { throw codedError("PDF_ANNOTATION_BATCH_INVALID", "An existing operation batch is malformed."); }
      validateBatch(prior, normalizedDocument);
      if (prior.deviceId !== deviceId || prior.batchId !== id ||
          (prior.sourceHash ? canonicalHash(prior.sourceHash) : null) !== canonicalSourceHash ||
          (prior.quarantined === true) !== isQuarantined ||
          canonicalJson(prior.operations.map(operationIntent)) !== canonicalJson(operations.map(operationIntent))) {
        throw codedError("PDF_ANNOTATION_BATCH_COLLISION", "An immutable operation batch already exists with different content.");
      }
      if (await adapter.read(batchPath) !== current) {
        throw codedError("PDF_ANNOTATION_BATCH_UNCONFIRMED", "Existing operation batch changed while it was being verified.");
      }
      return { document: normalizedDocument, batchPath, batchId: id,
        operationCount: prior.operations.length, acknowledged: true, duplicate: true,
        snapshotPending: true, snapshotPath: locations.snapshot,
        quarantined: prior.quarantined === true };
    }

    const prepared = await prepareOperations(operations);
    const createdAt = finiteNumber(await clock(), "clock()");
    const checkpoint = await readCheckpoint(normalizedDocument);
    const operationFormat = await isFormat3Enabled(normalizedDocument, checkpoint)
      ? CURRENT_OPERATION_FORMAT : LEGACY_OPERATION_FORMAT;
    let causal = {};
    if (operationFormat === CURRENT_OPERATION_FORMAT) {
      const state = await replay(normalizedDocument);
      causal = {
        baseCheckpointHash: checkpoint?.integrity || null,
        parents: [...(state.batchHeads || [])].sort(compareString),
      };
    }
    const batch = {
      schemaVersion: STORE_SCHEMA,
      formatVersion: operationFormat,
      kind: "annotation-operation-batch",
      pluginVersion: CURRENT_PLUGIN_VERSION,
      documentId: normalizedDocument.documentId,
      docKey: normalizedDocument.docKey,
      deviceId,
      batchId: id,
      createdAt,
      ...causal,
      ...(canonicalSourceHash ? { sourceHash: canonicalSourceHash } : {}),
      ...(isQuarantined ? { quarantined: true } : {}),
      operations: prepared,
    };
    const serialized = canonicalJson(batch);
    const temporaryPath = `${batchPath}.${pathSegment(await uuid())}.pending`;
    await adapter.write(temporaryPath, serialized);
    const temporaryConfirmation = await adapter.read(temporaryPath);
    if (temporaryConfirmation !== serialized) {
      throw codedError("PDF_ANNOTATION_BATCH_UNCONFIRMED", "Temporary operation batch write could not be verified.");
    }
    if (await adapter.exists(batchPath)) {
      throw codedError("PDF_ANNOTATION_BATCH_COLLISION", "An operation batch appeared while this device was writing it.");
    }
    await adapter.rename(temporaryPath, batchPath);
    const confirmed = await adapter.read(batchPath);
    if (confirmed !== serialized) {
      throw codedError("PDF_ANNOTATION_BATCH_UNCONFIRMED", "Operation batch write could not be verified.");
    }

    return {
      document: normalizedDocument,
      batchPath,
      batchId: id,
      operationCount: prepared.length,
      acknowledged: true,
      snapshotPending: true,
      snapshotPath: locations.snapshot,
      quarantined: isQuarantined,
    };
  }

  async function readDocument(document) {
    const normalizedDocument = await resolveDocument(document);
    return enqueueDocumentMaterialization(normalizedDocument, (queueWaitMs) =>
      materializeDocument(normalizedDocument, queueWaitMs));
  }

  // Serialize replay/checkpoint/ACK/GC only within this store instance and
  // document. This is not a cross-device lock; Format 3 remains the durable
  // protocol shared by independent instances.
  function enqueueDocumentMaterialization(document, work) {
    const queuedAtMonotonicMs = safeTimingNow();
    const previous = materializationQueues.get(document.docKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const startedAtMonotonicMs = safeTimingNow();
      const queueWaitMs = queuedAtMonotonicMs === null || startedAtMonotonicMs === null
        ? null : Math.max(0, startedAtMonotonicMs - queuedAtMonotonicMs);
      return work(queueWaitMs);
    });
    const tracked = task.finally(() => {
      if (materializationQueues.get(document.docKey) === tracked) {
        materializationQueues.delete(document.docKey);
      }
    });
    materializationQueues.set(document.docKey, tracked);
    return tracked;
  }

  async function materializeDocument(normalizedDocument, queueWaitMs) {
    const startedAtMonotonicMs = safeTimingNow();
    const startedAtEpochMs = safeEpochNow();
    let state;
    let snapshot;
    let status = "error";
    let errorCode;
    try {
      try {
        state = await replay(normalizedDocument);
      } catch (error) {
        if (error.code !== "PDF_ANNOTATION_SYNC_PENDING") throw error;
        const checkpoint = await readCheckpoint(normalizedDocument);
        if (!checkpoint) throw error;
        const annotations = {};
        for (const row of checkpoint.annotations) annotations[row.uuid] = normalizeOperation(row);
        for (const row of checkpoint.tombstones) annotations[row.uuid] = normalizeOperation({ ...row, deleted: true });
        const safeState = {
          annotations,
          revision: checkpoint.revision,
          updatedAt: checkpoint.updatedAt,
          payloadEncoding: checkpoint.payloadEncoding,
          formatVersion: checkpoint.formatVersion || LEGACY_OPERATION_FORMAT,
          coveredBatches: cloneBatchManifest(checkpoint.coveredBatches),
          batchHeads: [...(checkpoint.batchHeads || [])],
          operationDigests: { ...checkpoint.operationDigests },
          knownDevices: [...checkpoint.knownDevices],
        };
        snapshot = makeSnapshot(normalizedDocument, safeState, checkpoint, false, true);
        status = "sync-pending-read-only";
        return snapshot;
      }
      let checkpoint = await writeCheckpoint(normalizedDocument, state);
      let currentDeviceState = await acknowledgeDevice(normalizedDocument, checkpoint.integrity);
      let deviceStates = await listDeviceStatus(normalizedDocument, checkpoint);
      const allDevicesConfirmed = () => deviceStates.every((entry) => entry.retired || entry.acknowledged);
      if (allDevicesConfirmed() && checkpoint.payloadEncoding !== COMPACT_PAYLOAD_ENCODING) {
        compactStatePayloads(state);
        state.payloadEncoding = COMPACT_PAYLOAD_ENCODING;
        checkpoint = await writeCheckpoint(normalizedDocument, state);
        currentDeviceState = await acknowledgeDevice(normalizedDocument, checkpoint.integrity);
        deviceStates = await listDeviceStatus(normalizedDocument, checkpoint);
      }
      const compactInkEncoding = deviceStates.every((entry) => entry.retired || entry.acknowledged);
      snapshot = makeSnapshot(normalizedDocument, state, checkpoint, compactInkEncoding);
      if (currentDeviceState.retired !== true && compactInkEncoding) {
        // Keep the legacy materialized snapshot intact until every registered
        // device has upgraded and confirmed the exact compact checkpoint.
        await writeSnapshotPointer(normalizedDocument, checkpoint);
        await garbageCollectCoveredBatches(normalizedDocument, checkpoint, deviceStates, {
          materializationQueueWaitMs: queueWaitMs,
        });
        await maybeCompactRootIndex();
      }
      status = "success";
      return snapshot;
    } catch (error) {
      errorCode = typeof error?.code === "string" ? error.code : "unknown";
      throw error;
    } finally {
      const endedAtMonotonicMs = safeTimingNow();
      emitTiming({
        phase: "materialization",
        documentId: normalizedDocument.documentId,
        docKey: normalizedDocument.docKey,
        revision: snapshot?.revision ?? state?.revision ?? null,
        startedAtEpochMs,
        startedAtMonotonicMs,
        queueWaitMs,
        durationMs: startedAtMonotonicMs === null || endedAtMonotonicMs === null
          ? null : Math.max(0, endedAtMonotonicMs - startedAtMonotonicMs),
        status,
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }

  /*
   * Call off the save/close hot path. The operation files remain authoritative;
   * interruption here merely leaves a stale cache that readDocument repairs.
   */
  async function materializeSnapshot(document) {
    return readDocument(document);
  }

  async function updateSourceIdentity({ document, sourceHash, pageCount, orderedPageIdentities, size, tailHash64k } = {}) {
    const normalizedDocument = await resolveDocument(document);
    const currentSource = normalizeSource({ sourceHash, pageCount, orderedPageIdentities, size, tailHash64k });
    if (!currentSource.sourceHash) {
      return { document: normalizedDocument, sourceMatch: "UNKNOWN", sourceMismatch: false,
        reason: "FULL_SOURCE_HASH_REQUIRED" };
    }
    const priorSource = normalizedDocument.source;
    const sourceMatch = compareSourceRevision(priorSource, currentSource);
    if (sourceMatch === "MISMATCH") {
      return { document: normalizedDocument, sourceMatch, sourceMismatch: true,
        previousSource: priorSource, currentSource };
    }

    const index = await readIndex();
    const stored = index.documents[normalizedDocument.sourcePath];
    if (!stored || stored.documentId !== normalizedDocument.documentId) {
      throw codedError("PDF_ANNOTATION_IDENTITY_MISSING", "The source identity is no longer registered at this path.");
    }
    const updated = normalizeDocument({ ...stored, source: mergeSource(stored.source, currentSource) });
    index.documents[updated.sourcePath] = updated;
    // The mutable path index is only a cache. Persist any newly learned
    // source/page identity in the immutable identity stream before updating
    // the cache, so a sync race or damaged index cannot make the document
    // acquire a different identity on the next device.
    if (canonicalJson(updated.source) !== canonicalJson(stored.source)) {
      const identityEvent = await appendIdentityEvent({
        kind: sourceMatch === "UNKNOWN" ? "source-baseline" : "source-update",
        document: updated,
        previous: stored,
        path: updated.sourcePath,
      });
      updated.identityEventHeads = [...updated.identityEventHeads, identityEvent.eventId];
    }
    await writeDocumentMetadata(updated);
    await writeIndex(index);
    return { document: updated, sourceMatch: sourceMatch === "UNKNOWN" ? "BASELINE_ESTABLISHED" : sourceMatch,
      sourceMismatch: false };
  }

  async function updateLegacyIdentities({ document, identities = [] } = {}) {
    const normalizedDocument = await resolveDocument(document);
    const normalizedIdentities = normalizeLegacyIdentities(identities);
    const updated = normalizeDocument({
      ...normalizedDocument,
      legacyIdentities: normalizedIdentities,
      legacyIdentityScanComplete: true,
    });
    const index = await readIndex();
    const stored = index.documents[normalizedDocument.sourcePath];
    if (!stored || stored.documentId !== normalizedDocument.documentId) {
      throw codedError("PDF_ANNOTATION_IDENTITY_MISSING", "No matching document identity is registered for legacy annotation migration.");
    }
    if (stored.source.sourceHash !== normalizedDocument.source.sourceHash) {
      throw codedError("PDF_ANNOTATION_SOURCE_CHANGED", "Legacy annotation identities cannot be attached to a different PDF source revision.");
    }
    if (stored.legacyIdentityScanComplete &&
        canonicalJson(stored.legacyIdentities || []) === canonicalJson(normalizedIdentities)) return stored;
    const identityEvent = await appendIdentityEvent({ kind: "legacy-identities", document: updated,
      previous: stored, path: updated.sourcePath });
    updated.identityEventHeads = [...updated.identityEventHeads, identityEvent.eventId];
    index.documents[updated.sourcePath] = updated;
    await writeDocumentMetadata(updated);
    await writeIndex(index);
    return updated;
  }

  async function listOperationBatches(document, { readOnly = false } = {}) {
    const normalizedDocument = await resolveDocument(document, { readOnly });
    const locations = pathsFor(normalizedDocument);
    if (!(await adapter.exists(locations.operations))) return [];
    const files = await listFilesRecursive(locations.operations);
    return files.filter((path) => path.endsWith(".json")).sort();
  }

  async function replay(document, { readOnly = false } = {}) {
    const normalizedDocument = await resolveDocument(document, { readOnly });
    const batchFiles = await listOperationBatches(normalizedDocument, { readOnly });
    const checkpoint = await readCheckpoint(normalizedDocument);
    const latest = new Map();
    const operationDigests = new Map();
    const coveredBatches = checkpoint ? cloneBatchManifest(checkpoint.coveredBatches) : {};
    const knownDevices = new Set([
      ...(checkpoint?.knownDevices || []),
      deviceId,
      ...await listRegisteredDeviceIds(normalizedDocument),
    ]);
    let revision = checkpoint?.revision || 0;
    let updatedAt = checkpoint?.updatedAt || 0;
    const knownBatchRefs = new Set();
    const batchHeads = new Set(Array.isArray(checkpoint?.batchHeads) ? checkpoint.batchHeads : []);
    const pendingBatches = [];
    const retiredDeviceBatches = [];
    if (checkpoint) {
      for (const row of checkpoint.annotations) latest.set(row.uuid, normalizeOperation(row));
      for (const row of checkpoint.tombstones) latest.set(row.uuid, normalizeOperation({ ...row, deleted: true }));
      for (const [key, digest] of Object.entries(checkpoint.operationDigests)) operationDigests.set(key, digest);
      for (const [batchDeviceId, batches] of Object.entries(coveredBatches)) {
        for (const batchId of Object.keys(batches)) knownBatchRefs.add(batchReference(batchDeviceId, batchId));
      }
      if (!Array.isArray(checkpoint.batchHeads)) {
        // Pre-0.8 checkpoints did not record the DAG frontier.
        for (const ref of knownBatchRefs) batchHeads.add(ref);
      }
    }
    for (const batchPath of batchFiles) {
      let batch;
      try { batch = JSON.parse(await adapter.read(batchPath)); }
      catch {
        throw codedError("PDF_ANNOTATION_SYNC_PENDING",
          `Operation batch is incomplete or not yet readable during sync: ${batchPath}`);
      }
      validateBatch(batch, normalizedDocument);
      if (batch.formatVersion === CURRENT_OPERATION_FORMAT &&
          (checkpoint?.formatVersion ?? LEGACY_OPERATION_FORMAT) < CHECKPOINT_FORMAT) {
        // A v3 batch can only be emitted after the shared format cutover. If
        // Sync delivers that batch before its v3 checkpoint, wait for the
        // referenced object instead of promoting a partially synced format.
        throw codedError("PDF_ANNOTATION_SYNC_PENDING",
          `Waiting for the format 3 checkpoint referenced by ${batchPath}.`);
      }
      knownDevices.add(batch.deviceId);
      const batchDigest = await digestText(canonicalJson(batch));
      const ref = batchReference(batch.deviceId, batch.batchId);
      const coveredDigest = coveredBatches[batch.deviceId]?.[batch.batchId];
      if (coveredDigest) {
        if (coveredDigest !== batchDigest) {
          throw codedError("PDF_ANNOTATION_BATCH_COLLISION", "A batch covered by a verified checkpoint changed content.");
        }
        knownBatchRefs.add(ref);
        continue;
      }
      const deviceState = await readDeviceState(normalizedDocument, batch.deviceId);
      if (deviceState?.retired === true) {
        // Keep late writes on disk for manual recovery, but exclude them from
        // the active graph and from checkpoint coverage/garbage collection.
        retiredDeviceBatches.push({ deviceId: batch.deviceId, batchId: batch.batchId });
        continue;
      }
      if (batch.sourceHash && normalizedDocument.source.sourceHash &&
          canonicalHash(batch.sourceHash) !== canonicalHash(normalizedDocument.source.sourceHash)) {
        // Operation data belongs to the exact immutable PDF revision it was
        // created against. Keep mismatched batches on disk for recovery, but
        // never project them onto a different source revision.
        continue;
      }
      pendingBatches.push({ batch, batchPath, batchDigest, ref });
    }

    const knownCheckpointHashes = await getKnownCheckpointHashes(normalizedDocument, checkpoint);
    while (pendingBatches.length) {
      const ready = pendingBatches.filter(({ batch }) => batch.formatVersion !== CURRENT_OPERATION_FORMAT ||
        (knownCheckpointHashes.has(batch.baseCheckpointHash) &&
          batch.parents.every((parent) => knownBatchRefs.has(parent))));
      if (!ready.length) {
        const first = pendingBatches[0];
        throw codedError("PDF_ANNOTATION_SYNC_PENDING",
          `Waiting for the checkpoint or parent operation batch referenced by ${first.batchPath}.`);
      }
      ready.sort((left, right) => compareString(left.batchPath, right.batchPath));
      for (const item of ready) {
        const { batch, batchDigest, ref } = item;
        for (const operation of batch.operations) {
        const normalized = normalizeOperation(operation);
        if (normalized.clock.deviceId !== batch.deviceId) {
          throw codedError("PDF_ANNOTATION_BATCH_INVALID", "Operation actor does not match its immutable batch device.");
        }
        const opKey = `${normalized.clock.deviceId}\0${normalized.clock.opId}`;
        const encoded = canonicalJson(normalized);
        const digest = await digestText(encoded);
        const priorDigest = operationDigests.get(opKey);
        if (priorDigest && priorDigest !== digest) {
          throw codedError("PDF_ANNOTATION_OPERATION_COLLISION", "The same device/opId identifies different operation content.");
        }
        if (!priorDigest) {
          operationDigests.set(opKey, digest);
          revision += 1;
          updatedAt = Math.max(updatedAt, normalized.clock.timestamp);
          const prior = latest.get(normalized.uuid);
          if (!prior || compareClock(normalized.clock, prior.clock) > 0) latest.set(normalized.uuid, normalized);
        }
        }
        for (const parent of batch.parents || []) batchHeads.delete(parent);
        batchHeads.add(ref);
        knownBatchRefs.add(ref);
        if (!coveredBatches[batch.deviceId]) coveredBatches[batch.deviceId] = {};
        coveredBatches[batch.deviceId][batch.batchId] = batchDigest;
        pendingBatches.splice(pendingBatches.indexOf(item), 1);
      }
    }
    const annotations = {};
    for (const uuidKey of [...latest.keys()].sort()) {
      annotations[uuidKey] = latest.get(uuidKey);
    }
    return {
      batchFiles,
      annotations,
      revision,
      operationCount: revision,
      updatedAt,
      formatVersion: checkpoint?.formatVersion || LEGACY_OPERATION_FORMAT,
      payloadEncoding: checkpoint?.payloadEncoding || "json-legacy",
      coveredBatches,
      batchHeads: [...batchHeads].sort(compareString),
      retiredDeviceBatches,
      operationDigests: Object.fromEntries([...operationDigests.entries()].sort(([left], [right]) => compareString(left, right))),
      knownDevices: [...knownDevices].sort(compareString),
    };
  }

  async function prepareOperations(operations) {
    const result = [];
    let logical = 0;
    for (const value of operations) {
      if (!value || typeof value !== "object") throw new TypeError("Invalid annotation operation.");
      const operation = { ...value };
      if (!operation.clock) {
        operation.clock = {
          timestamp: finiteNumber(await clock(), "clock()"),
          logical: logical++,
          deviceId,
          opId: await uuid(),
        };
      } else {
        operation.clock = { ...operation.clock };
        if (!operation.clock.deviceId) operation.clock.deviceId = deviceId;
        if (!operation.clock.opId) operation.clock.opId = await uuid();
      }
      const normalized = normalizeOperation(operation);
      if (normalized.clock.deviceId !== deviceId) {
        throw new TypeError("Each operation clock.deviceId must match the device writing its immutable batch.");
      }
      result.push(normalized);
    }
    return result;
  }

  async function resolveDocument(document, { readOnly = false } = {}) {
    if (typeof document === "string") {
      const index = await readIndex({ readOnly });
      const sourcePath = normalizeSourcePath(document);
      const found = index.documents[sourcePath];
      if (!found) {
        if (readOnly) throw codedError("PDF_ANNOTATION_IDENTITY_MISSING",
          "No registered Format 3 document exists at the migration source path.");
        return registerDocument({ sourcePath });
      }
      return normalizeDocument(found);
    }
    if (document && document.sourcePath && !document.documentId) {
      if (readOnly) {
        const index = await readIndex({ readOnly: true });
        const found = index.documents[normalizeSourcePath(document.sourcePath)];
        if (!found) throw codedError("PDF_ANNOTATION_IDENTITY_MISSING",
          "No registered Format 3 document exists at the migration source path.");
        return normalizeDocument(found);
      }
      return registerDocument({ sourcePath: document.sourcePath, source: document.source || {} });
    }
    if (document && document.sourcePath && document.documentId) {
      const index = await readIndex({ readOnly });
      const found = index.documents[normalizeSourcePath(document.sourcePath)];
      if (found?.documentId === document.documentId) return normalizeDocument(found);
      if (readOnly) throw codedError("PDF_ANNOTATION_IDENTITY_MISSING",
        "The supplied document does not match a registered Format 3 identity.");
    }
    if (readOnly) throw codedError("PDF_ANNOTATION_IDENTITY_MISSING",
      "A registered Format 3 document path or identity is required for migration export.");
    return normalizeDocument(document);
  }

  async function makeDocKey(documentId) {
    const raw = await identityHash(utf8(`pdf-annotation-document-v1\0${documentId}`));
    const parsed = parseHash(raw);
    return parsed.digest.slice(0, 12).toLowerCase();
  }

  async function makeDocumentId(sourcePath) {
    const seed = `pdf-annotation-document-v1\0${baseRoot}\0${sourcePath}`;
    // Two independently keyed hashes form a UUID-shaped 128-bit namespace id.
    // This is an identifier only, not a privacy boundary or integrity proof.
    const first = parseHash(await identityHash(utf8(`${seed}\0a`))).digest;
    const second = parseHash(await identityHash(utf8(`${seed}\0b`))).digest;
    const raw = `${first}${second}`.slice(0, 32).split("");
    raw[12] = "5";
    raw[16] = ((parseInt(raw[16], 16) & 0x3) | 0x8).toString(16);
    const value = raw.join("");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }

  async function readIndex({ readOnly = false } = {}) {
    const raw = await readTextIfExists(registryPath);
    const cachedDocuments = {};
    const pendingRoutes = new Map();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.documents && typeof parsed.documents === "object" &&
            parsed.schemaVersion === INDEX_SCHEMA) {
          for (const [pathValue, route] of Object.entries(parsed.documents)) {
            if (typeof route !== "string" || !/^[a-f0-9]{12}$/i.test(route)) continue;
            const sourcePath = normalizeSourcePath(pathValue);
            const metadata = await readDocumentMetadata(route, sourcePath);
            if (metadata) cachedDocuments[sourcePath] = metadata;
            else pendingRoutes.set(sourcePath, route.toLowerCase());
          }
        } else if (parsed?.schemaVersion === STORE_SCHEMA && parsed.documents && typeof parsed.documents === "object") {
          for (const [pathValue, value] of Object.entries(parsed.documents)) {
            try {
              const document = normalizeDocument({ ...value, sourcePath: pathValue });
              cachedDocuments[document.sourcePath] = document;
            } catch { /* The event stream can reconstruct a damaged legacy route. */ }
          }
        }
      } catch { /* Rebuild from the immutable identity events below. */ }
    }
    const rebuilt = await rebuildIndexFromIdentityEvents();
    const merged = { ...rebuilt.documents };
    const eventDocumentIds = new Set(Object.values(merged).map((record) => record.documentId));
    // Full page references and legacy ids are loaded only from the per-document
    // metadata file, never copied into the root route index.
    for (const [path, eventDocument] of Object.entries(merged)) {
      const storedMetadata = await readDocumentMetadata(eventDocument.docKey, path);
      const rootRecord = Object.values(cachedDocuments)
        .find((record) => record.documentId === eventDocument.documentId);
      const metadata = storedMetadata?.documentId === eventDocument.documentId
        ? storedMetadata : rootRecord;
      if (metadata?.documentId === eventDocument.documentId) {
        const eventHeads = new Set(eventDocument.identityEventHeads);
        const metadataHeads = new Set(metadata.identityEventHeads);
        const metadataHasEvents = [...eventHeads].every((head) => metadataHeads.has(head));
        const eventsHaveMetadata = [...metadataHeads].every((head) => eventHeads.has(head));
        if (!metadataHasEvents && !eventsHaveMetadata) {
          throw codedError("PDF_ANNOTATION_METADATA_PENDING",
            `Concurrent identity branches for ${path} have not converged; refusing to overwrite the saved document metadata.`);
        }
        if (metadataHasEvents) {
          merged[path] = normalizeDocument({
            ...eventDocument,
            ...metadata,
            sourcePath: path,
            source: { ...eventDocument.source, ...metadata.source },
          });
        } else {
          const eventPageIds = eventDocument.source.orderedPageIdentities;
          const metadataPageIds = metadata.source.orderedPageIdentities;
          const pageCount = eventDocument.source.pageCount ?? metadata.source.pageCount;
          const sourceHashChanged = eventDocument.source.sourceHash && metadata.source.sourceHash &&
            eventDocument.source.sourceHash !== metadata.source.sourceHash;
          if (!Array.isArray(eventPageIds) &&
              (sourceHashChanged || eventDocument.source.pageCount !== undefined &&
                metadata.source.pageCount !== eventDocument.source.pageCount ||
                !Array.isArray(metadataPageIds) || Number.isSafeInteger(pageCount) &&
                  metadataPageIds.length !== pageCount)) {
            throw codedError("PDF_ANNOTATION_METADATA_PENDING",
              `Updated page identity metadata for ${path} has not synced; refusing to combine different PDF revisions.`);
          }
          const source = { ...metadata.source, ...eventDocument.source };
          if (!Array.isArray(eventPageIds) && Array.isArray(metadataPageIds)) {
            source.orderedPageIdentities = metadataPageIds;
          }
          if (Number.isSafeInteger(pageCount) &&
              (!Array.isArray(source.orderedPageIdentities) || source.orderedPageIdentities.length !== pageCount)) {
            throw codedError("PDF_ANNOTATION_METADATA_PENDING",
              `Complete ordered page identities for ${path} have not synced.`);
          }
          merged[path] = normalizeDocument({
            ...metadata,
            ...eventDocument,
            sourcePath: path,
            source,
          });
        }
      } else if (Number.isSafeInteger(eventDocument.source.pageCount) &&
          (!Array.isArray(eventDocument.source.orderedPageIdentities) ||
            eventDocument.source.orderedPageIdentities.length !== eventDocument.source.pageCount)) {
        throw codedError("PDF_ANNOTATION_METADATA_PENDING",
          `The per-document page identity metadata for ${path} has not synced; refusing to use an incomplete identity.`);
      }
    }
    // A valid route cache may lead an identity event that has not synced yet.
    for (const [path, cached] of Object.entries(cachedDocuments)) {
      if (eventDocumentIds.has(cached.documentId)) {
        const cacheAhead = cached.identityEventHeads.some((head) => !rebuilt.appliedEventIds.has(head));
        if (!cacheAhead) continue;
        for (const [oldPath, oldRecord] of Object.entries(merged)) {
          if (oldRecord.documentId === cached.documentId) delete merged[oldPath];
        }
      }
      if (!merged[path] || merged[path].documentId === cached.documentId) {
        merged[path] = { ...merged[path], ...cached,
          source: { ...(merged[path]?.source || {}), ...(cached.source || {}) } };
      }
    }
    for (const [path, docKey] of pendingRoutes) {
      const recovered = merged[path];
      if (!recovered || recovered.docKey !== docKey) {
        throw codedError("PDF_ANNOTATION_METADATA_PENDING",
          `The per-document identity metadata for ${path} has not synced; refusing to create a replacement identity.`);
      }
      throw codedError("PDF_ANNOTATION_METADATA_PENDING",
        `The per-document identity metadata for ${path} is missing; event data cannot safely replace its page and legacy identity payloads.`);
    }
    for (const [path, document] of Object.entries(merged)) {
      const metadata = await readDocumentMetadata(document.docKey, path);
      if (!metadata) {
        if (Number.isSafeInteger(document.source.pageCount) &&
            (!Array.isArray(document.source.orderedPageIdentities) ||
              document.source.orderedPageIdentities.length !== document.source.pageCount)) {
          throw codedError("PDF_ANNOTATION_METADATA_PENDING",
            `The per-document page identity metadata for ${path} has not synced.`);
        }
        if (!readOnly) await writeDocumentMetadata(document);
        continue;
      }
      const metadataHeads = new Set(metadata.identityEventHeads);
      const documentHeads = new Set(document.identityEventHeads);
      const metadataIsOlder = [...metadataHeads].every((head) => documentHeads.has(head));
      const documentIsOlder = [...documentHeads].every((head) => metadataHeads.has(head));
      if (!metadataIsOlder && !documentIsOlder) {
        throw codedError("PDF_ANNOTATION_METADATA_PENDING",
          `Identity metadata for ${path} has conflicting heads; waiting for sync convergence.`);
      }
      if (!readOnly && metadataIsOlder && !documentIsOlder) await writeDocumentMetadata(document);
    }
    const result = { schemaVersion: STORE_SCHEMA, documents: merged };
    return result;
  }

  async function readDocumentMetadata(docKey, sourcePath) {
    const path = `${baseRoot}/documents/${String(docKey).toLowerCase()}.json`;
    const text = await readTextIfExists(path);
    if (text === null) return null;
    try {
      const metadata = JSON.parse(text);
      if (metadata?.schemaVersion !== 1 || metadata.docKey !== String(docKey).toLowerCase()) return null;
      return normalizeDocument({ ...metadata, sourcePath: sourcePath || metadata.sourcePath });
    } catch { return null; }
  }

  function documentMetadataValue(document) {
    const normalized = normalizeDocument(document);
    return {
      schemaVersion: 1,
      documentId: normalized.documentId,
      docKey: normalized.docKey,
      sourcePath: normalized.sourcePath,
      source: normalized.source,
      legacyIdentities: normalized.legacyIdentities,
      legacyIdentityScanComplete: normalized.legacyIdentityScanComplete,
      identityEventHeads: normalized.identityEventHeads,
    };
  }

  async function writeDocumentMetadata(document) {
    const normalized = normalizeDocument(document);
    const path = pathsFor(normalized).metadata;
    await ensureDirectory(`${baseRoot}/documents`);
    const value = documentMetadataValue(normalized);
    const text = canonicalJson(value);
    const current = await readTextIfExists(path);
    if (current) {
      try {
        const existing = JSON.parse(current);
        if (existing.documentId && existing.documentId !== normalized.documentId) {
          throw codedError("PDF_ANNOTATION_METADATA_COLLISION", "A different document identity already occupies this metadata key.");
        }
      } catch (error) {
        if (error.code === "PDF_ANNOTATION_METADATA_COLLISION") throw error;
      }
    }
    if (current !== text) {
      await adapter.write(path, text);
      if (await adapter.read(path) !== text) {
        throw codedError("PDF_ANNOTATION_METADATA_UNCONFIRMED", "Per-document metadata write could not be verified.");
      }
    }
  }

  async function rebuildIndexFromIdentityEvents() {
    if (!(await adapter.exists(identityEventsRoot))) return { documents: {}, appliedEventIds: new Set() };
    const files = (await listFilesRecursive(identityEventsRoot))
      .filter((path) => path.endsWith(".json"))
      .sort();
    const events = [];
    for (const path of files) {
      let event;
      try { event = JSON.parse(await adapter.read(path)); }
      catch { throw codedError("PDF_ANNOTATION_IDENTITY_EVENT_INVALID", `Malformed document identity event: ${path}`); }
      if (!event || event.schemaVersion !== STORE_SCHEMA ||
          !["document-create", "document-rename", "document-source-baseline", "document-source-update", "document-legacy-identities"].includes(event.kind) ||
          typeof event.eventId !== "string" || !event.eventId ||
          typeof event.documentId !== "string" || !event.documentId ||
          !/^[a-f0-9]{12}$/i.test(event.docKey || "") ||
          !Number.isSafeInteger(event.createdAt) || event.createdAt < 0 ||
          (event.parentEventIds !== undefined && (!Array.isArray(event.parentEventIds) ||
            event.parentEventIds.some((parentId) => typeof parentId !== "string" || !parentId) ||
            new Set(event.parentEventIds).size !== event.parentEventIds.length))) {
        throw codedError("PDF_ANNOTATION_IDENTITY_EVENT_INVALID", `Invalid document identity event: ${path}`);
      }
      events.push(event);
    }
    // Identity transitions are replayed by causal event parents, not device
    // wall time. Clocks can be skewed across devices and must never reorder a
    // create/rename/source transition.
    events.sort((left, right) => compareString(left.eventId, right.eventId));
    const pending = [...events];
    const ordered = [];
    const appliedIds = new Set();
    while (pending.length) {
      const ready = pending.filter((event) => {
        const parents = Array.isArray(event.parentEventIds) ? event.parentEventIds : [];
        return parents.every((parentId) => appliedIds.has(parentId));
      });
      if (!ready.length) break; // partial sync or cycle: keep children unapplied
      ready.sort((left, right) => compareString(left.eventId, right.eventId));
      for (const event of ready) {
        pending.splice(pending.indexOf(event), 1);
        ordered.push(event);
        appliedIds.add(event.eventId);
      }
    }
    const documents = {};
    const recordsById = new Map();
    for (const event of ordered) {
      const sourcePath = normalizeSourcePath(event.sourcePath);
      const source = normalizeSource(event.source || {});
      if (event.kind === "document-create") {
        const current = recordsById.get(event.documentId);
        if (current && current.docKey === event.docKey) {
          const merged = normalizeDocument({
            ...current,
            source: mergeSource(current.source, source),
            identityEventHeads: [...new Set([...current.identityEventHeads, event.eventId])],
          });
          recordsById.set(event.documentId, merged);
          documents[sourcePath] = merged;
          continue;
        }
        const record = normalizeDocument({
          documentId: event.documentId,
          docKey: event.docKey,
          sourcePath,
          source,
          legacyIdentities: event.legacyIdentities || [],
          legacyIdentityScanComplete: event.legacyIdentityScanComplete === true,
          identityEventHeads: [event.eventId],
        });
        recordsById.set(event.documentId, record);
        if (!documents[sourcePath] || documents[sourcePath].documentId === event.documentId) {
          documents[sourcePath] = record;
        }
        continue;
      }
      const previous = recordsById.get(event.documentId) ||
        Object.values(documents).find((record) => record.documentId === event.documentId);
      if (!previous || previous.docKey !== event.docKey) continue;
      if (event.kind === "document-rename") {
        if (typeof event.fromPath !== "string") {
          throw codedError("PDF_ANNOTATION_IDENTITY_EVENT_INVALID", `Rename event has no prior path: ${event.eventId}`);
        }
        const fromPath = normalizeSourcePath(event.fromPath);
        const currentPath = Object.entries(documents).find(([, record]) => record.documentId === event.documentId)?.[0];
        // Concurrent renames from the same parent are resolved consistently
        // by event id order; stale branches cannot move a later path.
        if (currentPath && currentPath !== fromPath) continue;
        if (documents[fromPath]?.documentId === event.documentId) delete documents[fromPath];
        for (const [registeredPath, record] of Object.entries(documents)) {
          if (record.documentId === event.documentId) delete documents[registeredPath];
        }
      }
      const record = normalizeDocument({
        ...previous,
        documentId: event.documentId,
        docKey: event.docKey,
        sourcePath,
        source: { ...previous.source, ...source, ...(event.kind === "document-rename" ? { path: sourcePath } : {}) },
        legacyIdentities: event.legacyDeltas && typeof event.legacyDeltas === "object"
          ? applyLegacyIdentityDeltas(previous.legacyIdentities, event.legacyDeltas)
          : event.legacyIdentities ?? previous.legacyIdentities,
        legacyIdentityScanComplete: event.legacyIdentityScanComplete ?? previous.legacyIdentityScanComplete,
        identityEventHeads: [
          ...previous.identityEventHeads.filter((head) => !(event.parentEventIds || []).includes(head)),
          event.eventId,
        ],
      });
      recordsById.set(event.documentId, record);
      documents[sourcePath] = record;
    }
    return { documents, appliedEventIds: appliedIds };
  }

  async function writeIndex(index, { compactRoutes = false } = {}) {
    await ensureDirectory(baseRoot);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existingText = await readTextIfExists(registryPath);
      let existing = null;
      try { existing = existingText ? JSON.parse(existingText) : null; } catch { /* Rebuild from identity events. */ }
      const existingIsRouteOnly = existing?.schemaVersion === INDEX_SCHEMA && existing.documents;
      const legacyDocuments = {};
      const routes = {};
      if (existing?.documents && typeof existing.documents === "object") {
        for (const [pathValue, value] of Object.entries(existing.documents)) {
          const sourcePath = normalizeSourcePath(pathValue);
          if (typeof value === "string" && /^[a-f0-9]{12}$/i.test(value)) {
            routes[sourcePath] = value.toLowerCase();
          } else if (value && typeof value === "object") {
            try { legacyDocuments[sourcePath] = normalizeDocument({ ...value, sourcePath }); }
            catch { /* Immutable identity events remain the recoverable record. */ }
          }
        }
      }
      for (const [pathValue, record] of Object.entries(index.documents)) {
        const sourcePath = normalizeSourcePath(pathValue);
        for (const [oldPath, oldRecord] of Object.entries(legacyDocuments)) {
          if (oldPath !== sourcePath && oldRecord.documentId === record.documentId) delete legacyDocuments[oldPath];
        }
        for (const [oldPath, oldDocKey] of Object.entries(routes)) {
          if (oldPath !== sourcePath && oldDocKey === record.docKey) delete routes[oldPath];
        }
        legacyDocuments[sourcePath] = normalizeDocument({ ...record, sourcePath });
        routes[sourcePath] = record.docKey;
      }

      const routeOnly = existingIsRouteOnly || compactRoutes;
      if (routeOnly && !(await areDocumentRoutesReady(legacyDocuments))) {
        // Keep writing the old, readable index until every known per-document
        // device has confirmed the compact checkpoint. This lets older plugin
        // versions continue to resolve their existing paths during rollout.
        const desired = { schemaVersion: STORE_SCHEMA, documents: legacyDocuments };
        const text = canonicalJson(desired);
        await adapter.write(registryPath, text);
        if (await adapter.read(registryPath) === text) return;
        continue;
      }

      const desired = routeOnly
        ? { schemaVersion: INDEX_SCHEMA, documents: routes }
        : { schemaVersion: STORE_SCHEMA, documents: legacyDocuments };
      const text = canonicalJson(desired);
      await adapter.write(registryPath, text);
      if (await adapter.read(registryPath) === text) return;
    }
    throw codedError("PDF_ANNOTATION_INDEX_UNCONFIRMED", "Document index cache could not be merged and verified.");
  }

  async function maybeCompactRootIndex() {
    const index = await readIndex();
    await writeIndex(index, { compactRoutes: true });
  }

  async function areDocumentRoutesReady(documents) {
    for (const document of Object.values(documents)) {
      const checkpoint = await readCheckpoint(document);
      if (!checkpoint || checkpoint.payloadEncoding !== COMPACT_PAYLOAD_ENCODING) return false;
      const metadataHash = await digestText(canonicalJson(documentMetadataValue(document)));
      if (checkpoint.metadataHash !== metadataHash) return false;
      const states = await collectDeviceStatus(document, checkpoint);
      if (!states.every((entry) => entry.retired || entry.acknowledged)) return false;
    }
    return Object.keys(documents).length > 0;
  }

  async function appendIdentityEvent(event) {
    const document = event.document;
    const locations = pathsFor(document);
    await ensureDirectory(locations.identityEvents);
    const id = await uuid();
    const payload = {
      schemaVersion: STORE_SCHEMA,
      kind: `document-${event.kind}`,
      eventId: id,
      documentId: document.documentId,
      docKey: document.docKey,
      sourcePath: event.path,
      ...(event.fromPath ? { fromPath: event.fromPath } : {}),
      source: sourceEventDelta(event.previous?.source || {}, document.source, event.kind),
      ...(event.kind === "legacy-identities"
        ? { legacyDeltas: legacyIdentityDeltas(event.previous?.legacyIdentities || [], document.legacyIdentities) }
        : {}),
      legacyIdentityScanComplete: document.legacyIdentityScanComplete,
      parentEventIds: document.identityEventHeads,
      createdAt: finiteNumber(await clock(), "clock()"),
    };
    const path = `${locations.identityEvents}/${pathSegment(id)}.json`;
    const text = canonicalJson(payload);
    const temporaryPath = `${path}.${pathSegment(await uuid())}.pending`;
    await adapter.write(temporaryPath, text);
    if (await adapter.read(temporaryPath) !== text) {
      throw codedError("PDF_ANNOTATION_IDENTITY_UNCONFIRMED", "Temporary document identity event write could not be verified.");
    }
    if (await adapter.exists(path)) {
      throw codedError("PDF_ANNOTATION_IDENTITY_COLLISION", "A document identity event appeared while this device was writing it.");
    }
    await adapter.rename(temporaryPath, path);
    if (await adapter.read(path) !== text) {
      throw codedError("PDF_ANNOTATION_IDENTITY_UNCONFIRMED", "Document identity event write could not be verified.");
    }
    return { eventId: id };
  }

  function sourceEventDelta(previous, current, kind) {
    const delta = {};
    for (const [key, value] of Object.entries(current || {})) {
      if (key === "orderedPageIdentities") continue;
      if (canonicalJson(previous?.[key]) !== canonicalJson(value)) delta[key] = value;
    }
    if (kind === "create" && !Object.keys(delta).length) return {};
    return delta;
  }

  function legacyIdentityDeltas(previous, current) {
    const before = new Map(normalizeLegacyIdentities(previous).filter((row) => !row.deleted && row.ref)
      .map((row) => [row.uuid, row]));
    const after = new Map(normalizeLegacyIdentities(current).filter((row) => !row.deleted && row.ref)
      .map((row) => [row.uuid, row]));
    const upsert = [];
    const remove = [];
    for (const [id, row] of after) {
      if (canonicalJson(before.get(id)) !== canonicalJson(row)) upsert.push(row);
    }
    for (const id of before.keys()) if (!after.has(id)) remove.push(id);
    return { upsert, remove: remove.sort(compareString), scanComplete: true };
  }

  function applyLegacyIdentityDeltas(previous, delta) {
    if (!delta || !Array.isArray(delta.upsert) || !Array.isArray(delta.remove)) {
      throw codedError("PDF_ANNOTATION_IDENTITY_EVENT_INVALID", "Legacy identity delta event is malformed.");
    }
    const rows = new Map(normalizeLegacyIdentities(previous || []).map((row) => [row.uuid, row]));
    for (const id of delta.remove) rows.delete(id);
    for (const row of delta.upsert) rows.set(row.uuid, row);
    return [...rows.values()];
  }

  async function ensureDirectory(path) {
    const normalized = normalizePath(path);
    const parts = normalized.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) await adapter.mkdir(current);
    }
  }

  async function listFilesRecursive(path) {
    const listing = await adapter.list(path);
    const files = (listing.files || []).map((entry) => listedPath(path, entry));
    for (const folder of listing.folders || []) {
      const child = listedPath(path, folder);
      files.push(...await listFilesRecursive(child));
    }
    return files;
  }

  async function readTextIfExists(path) {
    if (!(await adapter.exists(path))) return null;
    const value = await adapter.read(path);
    if (typeof value !== "string") throw codedError("PDF_ANNOTATION_TEXT_INVALID", `Expected UTF-8 JSON text at ${path}.`);
    return value;
  }

  async function digestText(text) {
    return canonicalHash(await hash(utf8(text)));
  }

  async function readCheckpoint(document) {
    const locations = pathsFor(document);
    let primaryError = null;
    for (const path of [locations.checkpoint, locations.checkpointBackup]) {
      const text = await readTextIfExists(path);
      if (text === null) continue;
      try {
        const checkpoint = JSON.parse(text);
        if (path === locations.checkpoint && checkpoint?.kind === "pdf-annotation-snapshot" &&
            checkpoint.schemaVersion === STORE_SCHEMA) {
          // The pre-0.7 file was only a replay cache; immutable batches remain
          // the migration source. It is replaced only after a new checkpoint
          // has been verified and backed up.
          continue;
        }
        await validateCheckpoint(checkpoint, document);
        return checkpoint;
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }
    if (primaryError) {
      throw codedError("PDF_ANNOTATION_CHECKPOINT_INVALID",
        `No verified annotation checkpoint is available: ${primaryError.message}`);
    }
    return null;
  }

  async function isFormat3Enabled(document, checkpoint = null) {
    if (checkpoint?.formatVersion >= CHECKPOINT_FORMAT) return true;
    if (!checkpoint) return false;
    const states = await collectDeviceStatus(document, checkpoint);
    const activeDevices = states.filter((entry) => !entry.retired);
    return activeDevices.length > 0 && activeDevices.every((entry) => entry.acknowledged);
  }

  async function getKnownCheckpointHashes(document, checkpoint) {
    const hashes = new Set();
    if (checkpoint?.integrity) hashes.add(checkpoint.integrity);
    const backupPath = pathsFor(document).checkpointBackup;
    const backupText = await readTextIfExists(backupPath);
    if (backupText) {
      try {
        const backup = JSON.parse(backupText);
        await validateCheckpoint(backup, document);
        hashes.add(backup.integrity);
      } catch { /* A damaged previous checkpoint cannot authorize a batch. */ }
    }
    // A device acknowledgement is a reference, not the checkpoint object. It
    // cannot stand in for a checkpoint that has not synchronized locally.
    // Causal batches wait until their base checkpoint is actually present and
    // verified as primary or previous.
    return hashes;
  }

  async function readValidCheckpointAt(path, document) {
    const text = await readTextIfExists(path);
    if (text === null) return null;
    try {
      const checkpoint = JSON.parse(text);
      await validateCheckpoint(checkpoint, document);
      return { text, checkpoint };
    } catch { return null; }
  }

  async function validateCheckpoint(checkpoint, document) {
    if (!checkpoint || checkpoint.schemaVersion !== CHECKPOINT_SCHEMA ||
        checkpoint.kind !== "pdf-annotation-checkpoint" ||
        checkpoint.documentId !== document.documentId || checkpoint.docKey !== document.docKey ||
        typeof checkpoint.integrity !== "string" || !Array.isArray(checkpoint.annotations) ||
        !Array.isArray(checkpoint.tombstones) || !Array.isArray(checkpoint.knownDevices) ||
        !["json-legacy", COMPACT_PAYLOAD_ENCODING].includes(checkpoint.payloadEncoding) ||
        !Number.isSafeInteger(checkpoint.revision) || checkpoint.revision < 0 ||
        !Number.isSafeInteger(checkpoint.updatedAt) || checkpoint.updatedAt < 0 ||
        !checkpoint.coveredBatches || typeof checkpoint.coveredBatches !== "object" ||
        !checkpoint.operationDigests || typeof checkpoint.operationDigests !== "object" ||
        typeof checkpoint.metadataHash !== "string") {
      throw new TypeError("Checkpoint metadata is incomplete.");
    }
    if (checkpoint.formatVersion !== undefined && ![2, CHECKPOINT_FORMAT].includes(checkpoint.formatVersion)) {
      throw new TypeError("Checkpoint format version is unsupported.");
    }
    if (checkpoint.batchHeads !== undefined && (!Array.isArray(checkpoint.batchHeads) ||
        checkpoint.batchHeads.some((ref) => typeof ref !== "string" || !ref) ||
        new Set(checkpoint.batchHeads).size !== checkpoint.batchHeads.length)) {
      throw new TypeError("Checkpoint operation heads are invalid.");
    }
    const annotationIds = new Set();
    for (const row of checkpoint.annotations) {
      if (!row || typeof row !== "object" || row.deleted === true) {
        throw new TypeError("Checkpoint annotations may contain only live operations.");
      }
      const normalized = normalizeOperation({ ...row, deleted: false });
      if (!normalized.payload) throw new TypeError("Checkpoint live annotation payload is missing.");
      if (annotationIds.has(normalized.uuid)) throw new TypeError("Checkpoint annotation UUID is duplicated.");
      annotationIds.add(normalized.uuid);
    }
    for (const row of checkpoint.tombstones) {
      if (!row || typeof row !== "object" || Object.hasOwn(row, "deleted") || row.payload !== undefined) {
        throw new TypeError("Checkpoint tombstones must be compact ledger entries without deleted rows.");
      }
      const normalized = normalizeOperation({ ...row, deleted: true });
      if (annotationIds.has(normalized.uuid)) throw new TypeError("Checkpoint annotation UUID is duplicated.");
      annotationIds.add(normalized.uuid);
    }
    if (checkpoint.payloadEncoding === COMPACT_PAYLOAD_ENCODING &&
        checkpoint.annotations.some((row) => containsLegacyFloat32(row.payload))) {
      throw new TypeError("Compact checkpoint still contains a legacy Float32Array wrapper.");
    }
    if (checkpoint.knownDevices.some((id) => typeof id !== "string" || !id.trim()) ||
        new Set(checkpoint.knownDevices).size !== checkpoint.knownDevices.length) {
      throw new TypeError("Checkpoint device registry is invalid.");
    }
    for (const [device, batches] of Object.entries(checkpoint.coveredBatches)) {
      if (!device || !batches || typeof batches !== "object" || Array.isArray(batches)) {
        throw new TypeError("Checkpoint covered-batch manifest is invalid.");
      }
      for (const [batchId, digest] of Object.entries(batches)) {
        if (!batchId || typeof digest !== "string") throw new TypeError("Checkpoint batch digest is invalid.");
        canonicalHash(digest);
      }
    }
    if (checkpoint.formatVersion >= CHECKPOINT_FORMAT) {
      if (!Array.isArray(checkpoint.batchHeads)) {
        throw new TypeError("Format 3 checkpoints must include the operation DAG frontier.");
      }
      const coveredRefs = new Set();
      for (const [coveredDevice, batches] of Object.entries(checkpoint.coveredBatches)) {
        for (const batchId of Object.keys(batches)) coveredRefs.add(batchReference(coveredDevice, batchId));
      }
      if (checkpoint.batchHeads.some((ref) => !coveredRefs.has(ref))) {
        throw new TypeError("Checkpoint operation heads must reference covered immutable batches.");
      }
    }
    for (const digest of Object.values(checkpoint.operationDigests)) canonicalHash(digest);
    canonicalHash(checkpoint.metadataHash);
    const unsigned = { ...checkpoint };
    delete unsigned.integrity;
    if (await digestText(canonicalJson(unsigned)) !== checkpoint.integrity) {
      throw new TypeError("Checkpoint integrity hash does not match its contents.");
    }
  }

  async function writeCheckpoint(document, state) {
    const locations = pathsFor(document);
    const currentRow = await readValidCheckpointAt(locations.checkpoint, document);
    const backupRow = await readValidCheckpointAt(locations.checkpointBackup, document);
    const knownCheckpoint = currentRow?.checkpoint || backupRow?.checkpoint || null;
    const format3Enabled = await isFormat3Enabled(document, knownCheckpoint);
    const formatVersion = format3Enabled || state.formatVersion >= CHECKPOINT_FORMAT
      ? CHECKPOINT_FORMAT : LEGACY_OPERATION_FORMAT;
    const checkpoint = await makeCheckpoint(document, state, formatVersion);
    await ensureDirectory(locations.checkpoint.slice(0, locations.checkpoint.lastIndexOf("/")));
    await ensureDirectory(locations.checkpointBackup.slice(0, locations.checkpointBackup.lastIndexOf("/")));
    const text = canonicalJson(checkpoint);
    if (currentRow?.checkpoint.integrity === checkpoint.integrity) {
      if (backupRow?.checkpoint.integrity === currentRow.checkpoint.integrity && typeof adapter.remove === "function") {
        await adapter.remove(locations.checkpointBackup);
      }
      return currentRow.checkpoint;
    }

    // `.previous` is the prior distinct verified checkpoint. Preserve the
    // current primary before replacing it; never manufacture a second copy of
    // the new state. If the primary is damaged, keep the verified backup.
    if (currentRow && currentRow.checkpoint.integrity !== checkpoint.integrity &&
        backupRow?.checkpoint.integrity !== currentRow.checkpoint.integrity) {
      await adapter.write(locations.checkpointBackup, currentRow.text);
      if (await adapter.read(locations.checkpointBackup) !== currentRow.text) {
        throw codedError("PDF_ANNOTATION_CHECKPOINT_BACKUP_UNCONFIRMED",
          "The previous distinct checkpoint could not be verified; current checkpoint was left unchanged.");
      }
    }
    await adapter.write(locations.checkpoint, text);
    if (await adapter.read(locations.checkpoint) !== text) {
      throw codedError("PDF_ANNOTATION_CHECKPOINT_UNCONFIRMED", "Verified annotation checkpoint write could not be confirmed.");
    }
    if (backupRow?.checkpoint.integrity === checkpoint.integrity && typeof adapter.remove === "function") {
      await adapter.remove(locations.checkpointBackup);
    }
    return checkpoint;
  }

  async function writeSnapshotPointer(document, checkpoint) {
    const location = pathsFor(document).snapshot;
    const pointer = {
      schemaVersion: 2,
      kind: "pdf-annotation-snapshot-pointer",
      documentId: document.documentId,
      docKey: document.docKey,
      pluginVersion: CURRENT_PLUGIN_VERSION,
      checkpointPath: pathsFor(document).checkpoint,
      checkpointHash: checkpoint.integrity,
      revision: checkpoint.revision,
      updatedAt: checkpoint.updatedAt,
    };
    const text = canonicalJson(pointer);
    if (await readTextIfExists(location) === text) return;
    const existing = await readTextIfExists(location);
    if (existing) {
      try {
        const prior = JSON.parse(existing);
        if (prior.documentId && prior.documentId !== document.documentId) {
          throw codedError("PDF_ANNOTATION_SNAPSHOT_COLLISION", "A different document identity already occupies this snapshot path.");
        }
      } catch (error) {
        if (error.code === "PDF_ANNOTATION_SNAPSHOT_COLLISION") throw error;
      }
    }
    await adapter.write(location, text);
    if (await adapter.read(location) !== text) {
      throw codedError("PDF_ANNOTATION_SNAPSHOT_UNCONFIRMED", "Annotation snapshot pointer write could not be verified.");
    }
  }

  async function makeCheckpoint(document, state, formatVersion = LEGACY_OPERATION_FORMAT) {
    const all = Object.values(state.annotations).sort((left, right) => compareString(left.uuid, right.uuid));
    const annotations = all.filter((row) => row.deleted !== true).map((row) => ({
      ...row,
      ...(row.payload ? {
        payload: state.payloadEncoding === COMPACT_PAYLOAD_ENCODING
          ? compactExternalValue(row.payload) : row.payload,
      } : {}),
      deleted: false,
    }));
    const tombstones = all.filter((row) => row.deleted === true).map((row) => ({
      uuid: row.uuid,
      kind: row.kind,
      pageIndex: row.pageIndex,
      embeddedRef: row.embeddedRef ?? null,
      clock: { ...row.clock },
    }));
    const unsigned = {
      schemaVersion: CHECKPOINT_SCHEMA,
      kind: "pdf-annotation-checkpoint",
      formatVersion,
      documentId: document.documentId,
      docKey: document.docKey,
      pluginVersion: CURRENT_PLUGIN_VERSION,
      sourceHash: document.source.sourceHash || null,
      metadataHash: await digestText(canonicalJson(documentMetadataValue(document))),
      payloadEncoding: state.payloadEncoding || "json-legacy",
      // Keep the checkpoint hash stable across readers that have replayed the
      // same immutable batches. Wall-clock time would prevent cross-device ACK.
      createdAt: state.updatedAt,
      revision: state.revision,
      updatedAt: state.updatedAt,
      annotations,
      tombstones,
      coveredBatches: cloneBatchManifest(state.coveredBatches),
      batchHeads: [...new Set(state.batchHeads || [])].sort(compareString),
      operationDigests: { ...state.operationDigests },
      knownDevices: [...new Set(state.knownDevices)].sort(compareString),
    };
    return { ...unsigned, integrity: await digestText(canonicalJson(unsigned)) };
  }

  async function acknowledgeDevice(document, checkpointHash) {
    const location = pathsFor(document).deviceStates;
    await ensureDirectory(location);
    const path = `${location}/${pathSegment(deviceId)}.json`;
    const previous = await readDeviceState(document, deviceId);
    if (previous?.retired === true) return previous;
    const now = finiteNumber(await clock(), "clock()");
    const acknowledgedAt = previous?.checkpointHash === checkpointHash &&
      previous?.storageFormatVersion >= CHECKPOINT_FORMAT && Number.isSafeInteger(previous?.acknowledgedAt)
      ? previous.acknowledgedAt : now;
    const record = {
      schemaVersion: 1,
      deviceId,
      pluginVersion: CURRENT_PLUGIN_VERSION,
      storageFormatVersion: CHECKPOINT_FORMAT,
      checkpointHash,
      retired: false,
      acknowledgedAt,
      updatedAt: now,
    };
    const text = canonicalJson(record);
    if (await readTextIfExists(path) !== text) {
      await adapter.write(path, text);
      if (await adapter.read(path) !== text) {
        throw codedError("PDF_ANNOTATION_DEVICE_ACK_UNCONFIRMED", "Device checkpoint acknowledgement could not be verified.");
      }
    }
    return record;
  }

  async function readDeviceState(document, targetDeviceId) {
    const path = `${pathsFor(document).deviceStates}/${pathSegment(targetDeviceId)}.json`;
    const text = await readTextIfExists(path);
    if (text === null) return null;
    let state;
    try { state = JSON.parse(text); }
    catch { throw codedError("PDF_ANNOTATION_DEVICE_STATE_INVALID", "A device checkpoint acknowledgement is malformed."); }
    if (state?.schemaVersion !== 1 || state.deviceId !== targetDeviceId ||
        (state.retired !== true && state.retired !== false) ||
        (state.pluginVersion !== undefined && typeof state.pluginVersion !== "string") ||
        (state.checkpointHash !== undefined && state.checkpointHash !== null &&
          (typeof state.checkpointHash !== "string" || !state.checkpointHash)) ||
        (state.storageFormatVersion !== undefined &&
          (!Number.isSafeInteger(state.storageFormatVersion) || state.storageFormatVersion < 1)) ||
        (state.acknowledgedAt !== undefined &&
          (!Number.isSafeInteger(state.acknowledgedAt) || state.acknowledgedAt < 0)) ||
        (state.updatedAt !== undefined && (!Number.isSafeInteger(state.updatedAt) || state.updatedAt < 0)) ||
        (state.retiredAt !== undefined && (!Number.isSafeInteger(state.retiredAt) || state.retiredAt < 0))) {
      throw codedError("PDF_ANNOTATION_DEVICE_STATE_INVALID", "A device checkpoint acknowledgement is invalid.");
    }
    return state;
  }

  async function listDeviceStatus(document, checkpoint = null) {
    const normalized = await resolveDocument(document);
    return collectDeviceStatus(normalized, checkpoint);
  }

  async function collectDeviceStatus(normalized, checkpoint = null) {
    const ids = new Set([
      ...(checkpoint?.knownDevices || []),
      deviceId,
      ...await listRegisteredDeviceIds(normalized),
    ]);
    for (const path of await listOperationBatches(normalized)) {
      try {
        const batch = JSON.parse(await adapter.read(path));
        if (typeof batch.deviceId === "string" && batch.deviceId) ids.add(batch.deviceId);
      } catch { /* replay reports malformed batches with the actionable path */ }
    }
    const now = finiteNumber(await clock(), "clock()");
    const result = [];
    for (const id of [...ids].sort(compareString)) {
      const state = await readDeviceState(normalized, id);
      const acknowledged = Boolean(checkpoint && state?.retired === false &&
        state?.checkpointHash === checkpoint.integrity &&
        state?.storageFormatVersion >= CHECKPOINT_FORMAT &&
        Number.isSafeInteger(state?.acknowledgedAt) && state.acknowledgedAt <= now);
      result.push({
        deviceId: id,
        isCurrent: id === deviceId,
        pluginVersion: state?.pluginVersion || null,
        storageFormatVersion: Number.isSafeInteger(state?.storageFormatVersion) ? state.storageFormatVersion : 0,
        checkpointHash: state?.checkpointHash || null,
        acknowledgedAt: acknowledged ? state.acknowledgedAt : null,
        retired: state?.retired === true,
        acknowledged,
      });
    }
    return result;
  }

  async function listRegisteredDeviceIds(document) {
    const directory = pathsFor(document).deviceStates;
    if (!(await adapter.exists(directory))) return [];
    const ids = new Set();
    for (const path of (await listFilesRecursive(directory)).filter((entry) => entry.endsWith(".json"))) {
      let parsed;
      try { parsed = JSON.parse(await adapter.read(path)); }
      catch {
        throw codedError("PDF_ANNOTATION_DEVICE_STATE_INVALID", "A registered device acknowledgement is malformed.");
      }
      if (typeof parsed?.deviceId !== "string" || !parsed.deviceId.trim() ||
          path !== `${directory}/${pathSegment(parsed.deviceId)}.json`) {
        throw codedError("PDF_ANNOTATION_DEVICE_STATE_INVALID", "A registered device acknowledgement has an invalid identity.");
      }
      await readDeviceState(document, parsed.deviceId);
      ids.add(parsed.deviceId);
    }
    return [...ids].sort(compareString);
  }

  async function inspectDevices(document) {
    const normalized = await resolveDocument(document);
    const checkpoint = await readCheckpoint(normalized);
    return {
      checkpointHash: checkpoint?.integrity || null,
      devices: await listDeviceStatus(normalized, checkpoint),
    };
  }

  async function garbageCollectCoveredBatches(document, checkpoint, deviceStates, {
    materializationQueueWaitMs = null,
  } = {}) {
    const normalized = normalizeDocument(document);
    const queuedAtMonotonicMs = safeTimingNow();
    const previous = garbageCollectionQueues.get(normalized.docKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => {
      const startedAtMonotonicMs = safeTimingNow();
      const queueWaitMs = queuedAtMonotonicMs === null || startedAtMonotonicMs === null
        ? null : Math.max(0, startedAtMonotonicMs - queuedAtMonotonicMs);
      return performGarbageCollection(normalized, checkpoint, deviceStates, {
        startedAtMonotonicMs,
        queueWaitMs,
        materializationQueueWaitMs,
      });
    });
    const tracked = task.finally(() => {
      if (garbageCollectionQueues.get(normalized.docKey) === tracked) {
        garbageCollectionQueues.delete(normalized.docKey);
      }
    });
    garbageCollectionQueues.set(normalized.docKey, tracked);
    return tracked;
  }

  async function performGarbageCollection(document, checkpoint, deviceStates, {
    startedAtMonotonicMs,
    queueWaitMs,
    materializationQueueWaitMs,
  }) {
    const paths = pathsFor(document);
    const startedAtEpochMs = safeEpochNow();
    let eligible = false;
    let blocked = false;
    let status = "error";
    let candidateBatchCount = 0;
    let candidateBatchBytes = 0;
    let removed = 0;
    let removedBatchBytes = 0;
    let errorCode;
    try {
      if (typeof adapter.remove !== "function" ||
          !deviceStates.every((entry) => entry.retired || entry.acknowledged)) {
        blocked = true;
        status = "blocked";
        return 0;
      }
      const currentRow = await readValidCheckpointAt(paths.checkpoint, document);
      const previousRow = await readValidCheckpointAt(paths.checkpointBackup, document);
      if (!currentRow || currentRow.checkpoint.integrity !== checkpoint.integrity || !previousRow ||
          previousRow.checkpoint.integrity === currentRow.checkpoint.integrity) {
        blocked = true;
        status = "blocked";
        return 0;
      }
      const activeAcks = deviceStates.filter((entry) => !entry.retired).map((entry) => entry.acknowledgedAt);
      if (!activeAcks.length || activeAcks.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        blocked = true;
        status = "blocked";
        return 0;
      }
      const latestAcknowledgement = Math.max(...activeAcks);
      const now = finiteNumber(await clock(), "clock()");
      if (latestAcknowledgement > now || now - latestAcknowledgement < GC_RETENTION_MS) {
        blocked = true;
        status = "blocked";
        return 0;
      }
      eligible = true;
      for (const batchPath of await listOperationBatches(document)) {
        let batch;
        let batchText;
        try {
          batchText = await adapter.read(batchPath);
          batch = JSON.parse(batchText);
        } catch {
          throw codedError("PDF_ANNOTATION_SYNC_PENDING",
            `Operation batch is incomplete during safe collection: ${batchPath}`);
        }
        validateBatch(batch, document);
        const currentExpected = currentRow.checkpoint.coveredBatches[batch.deviceId]?.[batch.batchId];
        const previousExpected = previousRow.checkpoint.coveredBatches[batch.deviceId]?.[batch.batchId];
        const actualDigest = await digestText(canonicalJson(batch));
        // Retain the delta after the previous checkpoint so that the verified
        // previous state can still replay forward if the primary is damaged.
        if (!currentExpected || currentExpected !== actualDigest || previousExpected !== actualDigest) continue;
        candidateBatchCount += 1;
        candidateBatchBytes += storedTextByteLength(batchText);
        await adapter.remove(batchPath);
        if (await adapter.exists(batchPath)) {
          throw codedError("PDF_ANNOTATION_GC_UNCONFIRMED", "An operation batch remained after checkpoint cleanup.");
        }
        removed += 1;
        removedBatchBytes += storedTextByteLength(batchText);
      }
      status = "success";
      return removed;
    } catch (error) {
      status = "error";
      errorCode = typeof error?.code === "string" ? error.code : "unknown";
      throw error;
    } finally {
      const endedAtMonotonicMs = safeTimingNow();
      emitTiming({
        phase: "gc",
        documentId: document.documentId,
        docKey: document.docKey,
        revision: checkpoint.revision,
        checkpointHash: checkpoint.integrity,
        startedAtEpochMs,
        startedAtMonotonicMs,
        queueWaitMs,
        materializationQueueWaitMs,
        durationMs: startedAtMonotonicMs === null || endedAtMonotonicMs === null
          ? null : Math.max(0, endedAtMonotonicMs - startedAtMonotonicMs),
        eligible,
        blocked,
        status,
        candidateBatchCount,
        candidateBatchBytes,
        removedBatchCount: removed,
        removedBatchBytes,
        ...(errorCode ? { errorCode } : {}),
      });
    }
  }

  async function retireDevice({ document, targetDeviceId, confirmedCheckpointHash } = {}) {
    const normalized = await resolveDocument(document);
    if (typeof targetDeviceId !== "string" || !targetDeviceId.trim() || targetDeviceId === deviceId) {
      throw codedError("PDF_ANNOTATION_DEVICE_RETIRE_INVALID", "Choose another registered device to retire.");
    }
    const checkpoint = await readCheckpoint(normalized);
    if (!checkpoint || confirmedCheckpointHash !== checkpoint.integrity) {
      throw codedError("PDF_ANNOTATION_DEVICE_RETIRE_STALE", "The document checkpoint changed; review the device list again before retirement.");
    }
    const statuses = await listDeviceStatus(normalized, checkpoint);
    if (!statuses.some((entry) => entry.deviceId === targetDeviceId)) {
      throw codedError("PDF_ANNOTATION_DEVICE_RETIRE_UNKNOWN", "The selected device is not registered for this PDF.");
    }
    const folder = pathsFor(normalized).deviceStates;
    await ensureDirectory(folder);
    const path = `${folder}/${pathSegment(targetDeviceId)}.json`;
    const record = {
      schemaVersion: 1,
      deviceId: targetDeviceId,
      pluginVersion: CURRENT_PLUGIN_VERSION,
      storageFormatVersion: CHECKPOINT_FORMAT,
      checkpointHash: checkpoint.integrity,
      retired: true,
      retiredAt: finiteNumber(await clock(), "clock()"),
    };
    const text = canonicalJson(record);
    await adapter.write(path, text);
    if (await adapter.read(path) !== text) {
      throw codedError("PDF_ANNOTATION_DEVICE_RETIRE_UNCONFIRMED", "Device retirement could not be verified.");
    }
    return { deviceId: targetDeviceId, checkpointHash: checkpoint.integrity, retired: true };
  }

  function compactStatePayloads(state) {
    for (const [id, operation] of Object.entries(state.annotations)) {
      if (operation.deleted === true || !operation.payload) continue;
      state.annotations[id] = {
        ...operation,
        payload: compactExternalValue(operation.payload),
      };
    }
  }

  return Object.freeze({
    registerDocument,
    renameDocument,
    documentForPath,
    appendOperations,
    readDocument,
    listOperationBatches,
    exportForMigration,
    materializeSnapshot,
    updateSourceIdentity,
    updateLegacyIdentities,
    listDeviceStatus,
    inspectDevices,
    retireDevice,
    pathsFor,
  });

  function makeSnapshot(document, state, checkpoint, compactInkEncoding, syncPending = false) {
    const rows = Object.values(state.annotations).sort((left, right) => compareString(left.uuid, right.uuid));
    return {
      schemaVersion: 2,
      kind: "pdf-annotation-snapshot",
      documentId: document.documentId,
      docKey: document.docKey,
      pluginVersion: CURRENT_PLUGIN_VERSION,
      source: { ...document.source, sourcePath: document.sourcePath },
      legacyIdentities: document.legacyIdentities.filter((identity) => identity.deleted !== true && identity.ref),
      legacyIdentityScanComplete: document.legacyIdentityScanComplete,
      revision: state.revision,
      updatedAt: state.updatedAt,
      checkpointHash: checkpoint.integrity,
      compactInkEncoding,
      ...(state.retiredDeviceBatches?.length
        ? { retiredDeviceWrites: state.retiredDeviceBatches.map(({ deviceId: retiredId, batchId }) => ({
          deviceId: retiredId, batchId,
        })) }
        : {}),
      ...(syncPending ? { syncPending: true } : {}),
      annotations: rows.filter((row) => row.deleted !== true),
      tombstones: rows.filter((row) => row.deleted === true).map((row) => ({
        uuid: row.uuid,
        kind: row.kind,
        pageIndex: row.pageIndex,
        embeddedRef: row.embeddedRef ?? null,
        clock: { ...row.clock },
      })),
    };
  }

  function validateBatch(batch, document) {
    if (!batch || batch.schemaVersion !== STORE_SCHEMA || batch.kind !== "annotation-operation-batch" ||
        batch.documentId !== document.documentId || batch.docKey !== document.docKey ||
        typeof batch.deviceId !== "string" || !batch.deviceId || !Array.isArray(batch.operations)) {
      throw codedError("PDF_ANNOTATION_BATCH_INVALID", "Operation batch metadata does not match its document.");
    }
    if (batch.sourceHash !== undefined) canonicalHash(batch.sourceHash);
    if (batch.quarantined !== undefined && typeof batch.quarantined !== "boolean") {
      throw codedError("PDF_ANNOTATION_BATCH_INVALID", "Operation batch quarantine marker is invalid.");
    }
    if (batch.formatVersion !== undefined && ![LEGACY_OPERATION_FORMAT, CURRENT_OPERATION_FORMAT].includes(batch.formatVersion)) {
      throw codedError("PDF_ANNOTATION_BATCH_INVALID", "The operation batch uses an unsupported format version.");
    }
    if (batch.formatVersion === CURRENT_OPERATION_FORMAT) {
      if (typeof batch.baseCheckpointHash !== "string" || !batch.baseCheckpointHash ||
          !Array.isArray(batch.parents) ||
          batch.parents.some((parent) => typeof parent !== "string" || !parent) ||
          new Set(batch.parents).size !== batch.parents.length ||
          batch.parents.includes(batchReference(batch.deviceId, batch.batchId))) {
        throw codedError("PDF_ANNOTATION_BATCH_INVALID", "Causal operation batch metadata is incomplete or cyclic.");
      }
      canonicalHash(batch.baseCheckpointHash);
    }
    if (batch.pluginVersion !== undefined && typeof batch.pluginVersion !== "string") {
      throw codedError("PDF_ANNOTATION_BATCH_INVALID", "The operation batch plugin version is invalid.");
    }
  }

  function normalizeSourcePath(value) {
    if (typeof value !== "string" || !value.trim()) throw new TypeError("sourcePath must be a non-empty Vault path.");
    const path = normalizePath(value);
    if (!path || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) {
      throw new TypeError("sourcePath must be a normalized relative Vault path.");
    }
    return path;
  }

  function normalizeDocument(value) {
    if (!value || typeof value !== "object") throw new TypeError("A registered document is required.");
    const documentId = value.documentId;
    const sourcePath = normalizeSourcePath(value.sourcePath);
    if (typeof documentId !== "string" || !documentId.trim()) throw new TypeError("documentId must be a non-empty string.");
    const docKey = value.docKey;
    if (typeof docKey !== "string" || !/^[a-f0-9]{12}$/i.test(docKey)) {
      throw new TypeError("docKey must contain exactly 12 hexadecimal characters.");
    }
    return {
      documentId,
      docKey: docKey.toLowerCase(),
      sourcePath,
      source: normalizeSource(value.source || {}),
      legacyIdentities: normalizeLegacyIdentities(value.legacyIdentities || []),
      legacyIdentityScanComplete: value.legacyIdentityScanComplete === true,
      identityEventHeads: Array.isArray(value.identityEventHeads)
        ? [...new Set(value.identityEventHeads.filter((head) => typeof head === "string" && head))].sort()
        : [],
    };
  }

  function normalizeLegacyIdentities(value) {
    if (!Array.isArray(value)) throw new TypeError("legacyIdentities must be an array.");
    if (value.length > 100000) throw codedError("PDF_ANNOTATION_LEGACY_IDENTITY_LIMIT", "Too many legacy annotation identities were found.");
    const seenUuids = new Set();
    const seenRefs = new Set();
    const rows = [];
    for (const raw of value) {
      if (!raw || typeof raw !== "object" || typeof raw.uuid !== "string" || !raw.uuid.trim() ||
          (raw.deleted !== true && (typeof raw.ref !== "string" || !raw.ref.trim())) || !Number.isSafeInteger(raw.pageIndex) ||
          raw.pageIndex < 0 || typeof raw.kind !== "string" || !raw.kind.trim()) {
        throw codedError("PDF_ANNOTATION_LEGACY_IDENTITY_INVALID", "A legacy annotation identity is incomplete.");
      }
      const ref = typeof raw.ref === "string" && raw.ref.trim()
        ? String(raw.ref).replace(/\s+/g, " ").trim()
        : null;
      if (seenUuids.has(raw.uuid) || (ref && seenRefs.has(`${raw.pageIndex}\0${ref}`))) {
        throw codedError("PDF_ANNOTATION_LEGACY_IDENTITY_AMBIGUOUS", "Legacy annotation UUID or PDF object reference is ambiguous.");
      }
      seenUuids.add(raw.uuid);
      if (ref) seenRefs.add(`${raw.pageIndex}\0${ref}`);
      rows.push({
        uuid: raw.uuid,
        ref,
        pageIndex: raw.pageIndex,
        kind: raw.kind,
        deleted: raw.deleted === true,
        timestamp: nonNegativeInteger(raw.timestamp ?? 0, "legacyIdentity.timestamp"),
        logical: nonNegativeInteger(raw.logical ?? 0, "legacyIdentity.logical"),
        actorId: typeof raw.actorId === "string" ? raw.actorId : "legacy",
        operationId: typeof raw.operationId === "string" ? raw.operationId : "legacy",
      });
    }
    rows.sort((left, right) => left.pageIndex - right.pageIndex || String(left.ref || "").localeCompare(String(right.ref || "")));
    return rows;
  }

  function normalizeSource(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) throw new TypeError("source metadata must be an object.");
    const result = { ...source };
    // sourceHash is the full-source hash used to authorize hydration. A tail
    // sample can reject quickly but can never establish source equality.
    const fullHash = result.sourceHash ?? result.fastHash;
    if (fullHash !== undefined) result.sourceHash = canonicalHash(fullHash);
    if (result.fastHash !== undefined) {
      result.fastHash = canonicalHash(result.fastHash);
      if (result.sourceHash !== result.fastHash) throw new TypeError("sourceHash and fastHash cannot disagree.");
    }
    if (result.tailHash64k !== undefined) result.tailHash64k = canonicalHash(result.tailHash64k);
    if (result.size !== undefined) result.size = nonNegativeInteger(result.size, "source.size");
    if (result.pageCount !== undefined) result.pageCount = nonNegativeInteger(result.pageCount, "source.pageCount");
    if (result.orderedPageIdentities !== undefined && !Array.isArray(result.orderedPageIdentities)) {
      throw new TypeError("source.orderedPageIdentities must be an array.");
    }
    return result;
  }

  function normalizeOperation(operation) {
    const value = { ...operation };
    const uuidKey = value.uuid;
    if (typeof uuidKey !== "string" || !uuidKey.trim()) throw new TypeError("Annotation operation uuid is required.");
    const kind = value.kind ?? value.type;
    if (!VALID_TYPES.has(kind)) throw new TypeError(`Unsupported annotation kind: ${kind}`);
    value.kind = kind;
    delete value.type;
    value.pageIndex = nonNegativeInteger(value.pageIndex, "operation.pageIndex");
    if (typeof value.deleted !== "boolean") throw new TypeError("operation.deleted must be boolean (tombstones are retained).");
    if (!value.deleted && (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload))) {
      throw new TypeError("A live annotation operation requires a payload object.");
    }
    const clockValue = value.clock;
    if (!clockValue || typeof clockValue !== "object") throw new TypeError("operation.clock is required.");
    const timestamp = nonNegativeInteger(clockValue.timestamp, "operation.clock.timestamp");
    const logical = nonNegativeInteger(clockValue.logical, "operation.clock.logical");
    const actor = clockValue.deviceId;
    const opId = clockValue.opId;
    if (typeof actor !== "string" || !actor.trim() || typeof opId !== "string" || !opId.trim()) {
      throw new TypeError("operation.clock.deviceId and opId are required.");
    }
    value.clock = { timestamp, logical, deviceId: actor, opId };
    if (value.embeddedRef === undefined) value.embeddedRef = null;
    return value;
  }

  function compareClock(left, right) {
    return (left.timestamp - right.timestamp) || (left.logical - right.logical) ||
      compareString(left.deviceId, right.deviceId) || compareString(left.opId, right.opId);
  }

  function mergeSource(previous = {}, incoming = {}, forced = {}) {
    return normalizeSource({ ...previous, ...incoming, ...forced });
  }

  function compareSourceRevision(previous, incoming) {
    const priorHash = previous && (previous.sourceHash || previous.fastHash);
    const currentHash = incoming && (incoming.sourceHash || incoming.fastHash);
    if (!priorHash || !currentHash) return "UNKNOWN";
    if (canonicalHash(priorHash) !== canonicalHash(currentHash)) return "MISMATCH";
    if (previous.size !== undefined && incoming.size !== undefined && previous.size !== incoming.size) return "MISMATCH";
    if (previous.pageCount !== undefined && incoming.pageCount !== undefined && previous.pageCount !== incoming.pageCount) return "MISMATCH";
    if (previous.orderedPageIdentities !== undefined && incoming.orderedPageIdentities !== undefined &&
        canonicalJson(previous.orderedPageIdentities) !== canonicalJson(incoming.orderedPageIdentities)) return "MISMATCH";
    return "MATCH";
  }

  function operationIntent(operation) {
    if (!operation || typeof operation !== "object") return operation;
    const value = { ...operation };
    if (value.kind === undefined && value.type !== undefined) value.kind = value.type;
    delete value.type;
    delete value.clock;
    if (value.embeddedRef === undefined) value.embeddedRef = null;
    return value;
  }
}

function defaultNormalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function safeBasename(sourcePath) {
  const leaf = String(sourcePath).split("/").at(-1) || "document";
  const withoutExtension = leaf.replace(/\.pdf$/i, "") || "document";
  const safe = withoutExtension.normalize?.("NFKC") || withoutExtension;
  return safe.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "document";
}

function pathSegment(value) {
  const encoded = encodeURIComponent(String(value)).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return encoded === "." || encoded === ".." ? `_${encoded}` : encoded;
}

function cloneBatchManifest(value = {}) {
  const result = {};
  for (const device of Object.keys(value || {}).sort(compareString)) {
    const batches = value[device];
    if (!batches || typeof batches !== "object" || Array.isArray(batches)) continue;
    result[device] = {};
    for (const batchId of Object.keys(batches).sort(compareString)) {
      const digest = batches[batchId];
      if (typeof digest === "string") result[device][batchId] = digest;
    }
  }
  return result;
}

function compactExternalValue(value) {
  if (Array.isArray(value)) return value.map(compactExternalValue);
  if (!value || typeof value !== "object") return value;
  if (value.$type === "Float32ArrayLE") return value;
  if (value.$type === "Float32Array" && Array.isArray(value.values)) {
    const values = value.values.map((item) => {
      if (item?.$type === "NonFiniteNumber") {
        if (item.value === "NaN") return Number.NaN;
        if (item.value === "+Infinity") return Number.POSITIVE_INFINITY;
        if (item.value === "-Infinity") return Number.NEGATIVE_INFINITY;
      }
      return Number(item);
    });
    const floatValues = Float32Array.from(values);
    const bytes = new Uint8Array(floatValues.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < floatValues.length; index += 1) {
      view.setFloat32(index * 4, floatValues[index], true);
    }
    return {
      $type: "Float32ArrayLE",
      length: floatValues.length,
      base64: encodeBase64(bytes),
    };
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) result[key] = compactExternalValue(item);
  return result;
}

function containsLegacyFloat32(value) {
  if (Array.isArray(value)) return value.some(containsLegacyFloat32);
  if (!value || typeof value !== "object") return false;
  if (value.$type === "Float32Array") return true;
  return Object.values(value).some(containsLegacyFloat32);
}

function encodeBase64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const hasSecond = offset + 1 < bytes.length;
    const hasThird = offset + 2 < bytes.length;
    const second = hasSecond ? bytes[offset + 1] : 0;
    const third = hasThird ? bytes[offset + 2] : 0;
    result += alphabet[first >> 2];
    result += alphabet[((first & 0x03) << 4) | (second >> 4)];
    result += hasSecond ? alphabet[((second & 0x0f) << 2) | (third >> 6)] : "=";
    result += hasThird ? alphabet[third & 0x3f] : "=";
  }
  return result;
}

function canonicalHash(value) {
  if (typeof value !== "string") throw new TypeError("Hash value must be a string.");
  const match = HASH_PREFIX.exec(value);
  if (match) {
    const algorithm = match[1].toLowerCase();
    const digest = match[2].toLowerCase();
    if ((algorithm === "xxh64-v1" && digest.length !== 16) ||
        (algorithm === "sha256-v1" && digest.length !== 64)) {
      throw new TypeError("Hash digest length does not match its algorithm prefix.");
    }
    return `${algorithm}:${digest}`;
  }
  if (/^[a-f0-9]{64}$/i.test(value)) return `sha256-v1:${value.toLowerCase()}`;
  throw new TypeError("Unsupported hash format; expected xxh64-v1:, sha256-v1:, or legacy SHA-256 hex.");
}

function parseHash(value) {
  const canonical = canonicalHash(value);
  const match = HASH_PREFIX.exec(canonical);
  if (!match) throw new TypeError("Hash is missing an algorithm prefix.");
  return { algorithm: match[1].toLowerCase(), digest: match[2].toLowerCase() };
}

function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = sortObject(value[key]);
  return result;
}

function listedPath(parent, entry) {
  const value = String(entry);
  return value.startsWith(`${parent}/`) ? value : `${parent}/${value}`;
}

function utf8(value) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value);
  // TextEncoder is available in supported Obsidian browser runtimes. This
  // fallback uses only standard browser string encoding primitives.
  const escaped = unescape(encodeURIComponent(value));
  const bytes = new Uint8Array(escaped.length);
  for (let index = 0; index < escaped.length; index += 1) bytes[index] = escaped.charCodeAt(index);
  return bytes;
}

function defaultTimingNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function safeEpochNow() {
  try {
    const value = Date.now();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storedTextByteLength(value) {
  try {
    return utf8(typeof value === "string" ? value : String(value)).byteLength;
  } catch {
    return 0;
  }
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be a finite number.`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
  return value;
}

function compareString(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

module.exports = { createPdfAnnotationStore };
