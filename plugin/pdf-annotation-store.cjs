/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// External, append-only annotation operation storage. This module deliberately
// depends only on injected browser/Vault facilities; it has no Node/Electron
// runtime imports. Operation batches are authoritative. The JSON snapshot is
// an expendable materialized cache and is always checked against replayed ops.
//
// Minimal API:
//   registerDocument({ sourcePath, source }) -> stable document + sourceMatch
//   updateSourceIdentity({ document, sourceHash, pageCount, orderedPageIdentities, ... })
//   appendOperations({ document, operations, batchId }) -> durable write acknowledgement
//   readDocument(document) -> replayed annotation snapshot; repairs stale cache
//   materializeSnapshot(document) -> optional background cache write
//   renameDocument({ documentId, fromPath, toPath }) -> updated path association
// `source.sourceHash` is the full hash (`xxh64-v1:` or `sha256-v1:`); a tail
// sample alone never authorizes reuse/hydration. Snapshot writes are not part
// of append/close acknowledgement and can be deferred to background work.

const STORE_SCHEMA = 1;
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

  function pathsFor(document) {
    const normalized = normalizeDocument(document);
    return {
      root: baseRoot,
      snapshot: `${baseRoot}/${safeBasename(normalized.sourcePath)}--${normalized.docKey}.pdfdata.json`,
      operations: `${operationsRoot}/${normalized.docKey}`,
      deviceOperations: `${operationsRoot}/${normalized.docKey}/${deviceSegment}`,
      identityEvents: `${identityEventsRoot}/${normalized.docKey}`,
    };
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
    const identityEvent = await appendIdentityEvent({ kind: "create", document, path: normalizedPath });
    document = normalizeDocument({ ...document, identityEventHeads: [identityEvent.eventId] });
    index.documents[normalizedPath] = document;
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
    const identityEvent = await appendIdentityEvent({ kind: "rename", document: updated, fromPath: from, path: to });
    const renamed = normalizeDocument({ ...updated, identityEventHeads: [...updated.identityEventHeads, identityEvent.eventId] });
    index.documents[to] = renamed;
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

  async function appendOperations({ document, operations, batchId, sourceHash, quarantined = false } = {}) {
    const normalizedDocument = await resolveDocument(document);
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
    const batch = {
      schemaVersion: STORE_SCHEMA,
      kind: "annotation-operation-batch",
      documentId: normalizedDocument.documentId,
      docKey: normalizedDocument.docKey,
      deviceId,
      batchId: id,
      createdAt,
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
    const state = await replay(normalizedDocument);
    const snapshotText = await readTextIfExists(pathsFor(normalizedDocument).snapshot);
    const expected = makeSnapshot(normalizedDocument, state);
    const expectedText = canonicalJson(expected);
    if (snapshotText !== expectedText) await writeSnapshot(normalizedDocument, state);
    return expected;
  }

  // Call off the save/close hot path. The operation files remain authoritative;
  // interruption here merely leaves a stale cache that readDocument repairs.
  async function materializeSnapshot(document) {
    const normalizedDocument = await resolveDocument(document);
    const state = await replay(normalizedDocument);
    await writeSnapshot(normalizedDocument, state);
    return makeSnapshot(normalizedDocument, state);
  }

  // Called after PDF.js parses the source. A changed full hash, page count,
  // or ordered page identity is reported without replacing the prior trusted
  // identity; callers must resolve the mismatch before hydrating annotations.
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
        path: updated.sourcePath,
      });
      updated.identityEventHeads = [...updated.identityEventHeads, identityEvent.eventId];
    }
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
    const identityEvent = await appendIdentityEvent({ kind: "legacy-identities", document: updated, path: updated.sourcePath });
    updated.identityEventHeads = [...updated.identityEventHeads, identityEvent.eventId];
    index.documents[updated.sourcePath] = updated;
    await writeIndex(index);
    return updated;
  }

  async function listOperationBatches(document) {
    const normalizedDocument = await resolveDocument(document);
    const locations = pathsFor(normalizedDocument);
    if (!(await adapter.exists(locations.operations))) return [];
    const files = await listFilesRecursive(locations.operations);
    return files.filter((path) => path.endsWith(".json")).sort();
  }

  async function replay(document) {
    const normalizedDocument = await resolveDocument(document);
    const batchFiles = await listOperationBatches(normalizedDocument);
    const operationsById = new Map();
    for (const batchPath of batchFiles) {
      let batch;
      try { batch = JSON.parse(await adapter.read(batchPath)); }
      catch { throw codedError("PDF_ANNOTATION_BATCH_INVALID", `Malformed operation batch: ${batchPath}`); }
      validateBatch(batch, normalizedDocument);
      if (batch.sourceHash && normalizedDocument.source.sourceHash &&
          canonicalHash(batch.sourceHash) !== canonicalHash(normalizedDocument.source.sourceHash)) {
        // Operation data belongs to the exact immutable PDF revision it was
        // created against. Keep mismatched batches on disk for recovery, but
        // never project them onto a different source revision.
        continue;
      }
      for (const operation of batch.operations) {
        const normalized = normalizeOperation(operation);
        if (normalized.clock.deviceId !== batch.deviceId) {
          throw codedError("PDF_ANNOTATION_BATCH_INVALID", "Operation actor does not match its immutable batch device.");
        }
        const opKey = `${normalized.clock.deviceId}\0${normalized.clock.opId}`;
        const prior = operationsById.get(opKey);
        const encoded = canonicalJson(normalized);
        if (prior && prior.encoded !== encoded) {
          throw codedError("PDF_ANNOTATION_OPERATION_COLLISION", "The same device/opId identifies different operation content.");
        }
        if (!prior) operationsById.set(opKey, { operation: normalized, encoded });
      }
    }

    const latest = new Map();
    for (const { operation } of operationsById.values()) {
      const prior = latest.get(operation.uuid);
      if (!prior || compareClock(operation.clock, prior.clock) > 0) latest.set(operation.uuid, operation);
    }
    const annotations = {};
    for (const uuidKey of [...latest.keys()].sort()) {
      annotations[uuidKey] = latest.get(uuidKey);
    }
    return {
      batchFiles,
      annotations,
      revision: operationsById.size,
      operationCount: operationsById.size,
      updatedAt: [...operationsById.values()].reduce((latestAt, entry) =>
        Math.max(latestAt, entry.operation.clock.timestamp), 0),
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

  async function resolveDocument(document) {
    if (typeof document === "string") {
      const index = await readIndex();
      const sourcePath = normalizeSourcePath(document);
      const found = index.documents[sourcePath];
      if (!found) return registerDocument({ sourcePath });
      return normalizeDocument(found);
    }
    if (document && document.sourcePath && !document.documentId) {
      return registerDocument({ sourcePath: document.sourcePath, source: document.source || {} });
    }
    if (document && document.sourcePath && document.documentId) {
      const index = await readIndex();
      const found = index.documents[normalizeSourcePath(document.sourcePath)];
      if (found?.documentId === document.documentId) return normalizeDocument(found);
    }
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

  async function readIndex() {
    const raw = await readTextIfExists(registryPath);
    let index = { schemaVersion: STORE_SCHEMA, documents: {} };
    let invalidCache = false;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.schemaVersion === STORE_SCHEMA && parsed.documents && typeof parsed.documents === "object") {
          index = { schemaVersion: STORE_SCHEMA, documents: { ...parsed.documents } };
        } else invalidCache = true;
        // `_index.json` is a disposable cache; invalid data is reconstructed
        // from immutable identity events below.
      } catch { invalidCache = true; /* Rebuild the disposable index from identity events. */ }
    }
    const rebuilt = await rebuildIndexFromIdentityEvents();
    const eventDocuments = rebuilt.documents;
    const eventDocumentIds = new Set(Object.values(eventDocuments).map((record) => record.documentId));
    const merged = { ...eventDocuments };
    // A valid index may contain a newer cache-only timestamp/metadata field;
    // identity/path transitions are always recovered from immutable events.
    for (const [path, cachedValue] of Object.entries(index.documents)) {
      let cached;
      try { cached = normalizeDocument(cachedValue); }
      catch { continue; }
      if (eventDocumentIds.has(cached.documentId)) {
        // File sync can deliver the mutable index before one of its immutable
        // event parents. Keep a cache head that is not yet represented by the
        // locally available causal stream; replay will converge when files
        // finish syncing.
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
    const result = { schemaVersion: STORE_SCHEMA, documents: merged };
    if (invalidCache && rebuilt.appliedEventIds.size) await writeIndex(result);
    return result;
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
        legacyIdentities: event.legacyIdentities ?? previous.legacyIdentities,
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

  async function writeIndex(index) {
    await ensureDirectory(baseRoot);
    // `_index.json` is a mutable lookup cache. Immutable identity events are
    // persisted before this write. Merge-on-retry reduces concurrent lost
    // entries; it is not a cross-device lock or transaction.
    let desired = { schemaVersion: STORE_SCHEMA, documents: { ...index.documents } };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const existingText = await readTextIfExists(registryPath);
      if (existingText) {
        try {
          const existing = JSON.parse(existingText);
          if (existing?.schemaVersion === STORE_SCHEMA && existing.documents) {
            const merged = { ...existing.documents };
            for (const [path, record] of Object.entries(desired.documents)) {
              for (const [oldPath, oldRecord] of Object.entries(merged)) {
                if (oldPath !== path && oldRecord.documentId === record.documentId) delete merged[oldPath];
              }
              merged[path] = record;
            }
            desired = { schemaVersion: STORE_SCHEMA, documents: merged };
          }
        } catch { /* Identity event files remain the recoverable record. */ }
      }
      const text = canonicalJson(desired);
      await adapter.write(registryPath, text);
      if (await adapter.read(registryPath) === text) return;
    }
    throw codedError("PDF_ANNOTATION_INDEX_UNCONFIRMED", "Document index cache could not be merged and verified.");
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
      source: document.source,
      legacyIdentities: document.legacyIdentities.filter((identity) => identity.deleted !== true && identity.ref),
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

  async function writeSnapshot(document, state) {
    const location = pathsFor(document).snapshot;
    await ensureDirectory(baseRoot);
    const text = canonicalJson(makeSnapshot(document, state));
    const current = await readTextIfExists(location);
    if (current === text) return;
    if (current) {
      try {
        const prior = JSON.parse(current);
        if (prior.documentId && prior.documentId !== document.documentId) {
          throw codedError("PDF_ANNOTATION_SNAPSHOT_COLLISION", "A different document identity already occupies this snapshot path.");
        }
      } catch (error) {
        if (error.code === "PDF_ANNOTATION_SNAPSHOT_COLLISION") throw error;
        // Malformed snapshots are disposable cache and can be reconstructed.
      }
    }
    await adapter.write(location, text);
    if (await adapter.read(location) !== text) {
      throw codedError("PDF_ANNOTATION_SNAPSHOT_UNCONFIRMED", "Materialized annotation snapshot write could not be verified.");
    }
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

  return Object.freeze({
    registerDocument,
    renameDocument,
    documentForPath,
    appendOperations,
    readDocument,
    listOperationBatches,
    materializeSnapshot,
    updateSourceIdentity,
    updateLegacyIdentities,
    pathsFor,
  });

  function makeSnapshot(document, state) {
    return {
      schemaVersion: STORE_SCHEMA,
      kind: "pdf-annotation-snapshot",
      documentId: document.documentId,
      docKey: document.docKey,
      pluginVersion: "0.6.0",
      source: { ...document.source, sourcePath: document.sourcePath },
      legacyIdentities: document.legacyIdentities,
      legacyIdentityScanComplete: document.legacyIdentityScanComplete,
      revision: state.revision,
      updatedAt: state.updatedAt,
      batchFiles: state.batchFiles,
      annotations: Object.values(state.annotations),
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
