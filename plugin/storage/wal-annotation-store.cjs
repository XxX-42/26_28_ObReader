/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { createPdfAnnotationStore } = require("../pdf-annotation-store.cjs");
const { canonicalJson, verify } = require("./canonical.cjs");
const { deriveDocumentIdentity, normalizeInitialPath, validateFullSourceHash } = require("./document-identity.cjs");
const { buildEffectiveState } = require("./effective-state.cjs");
const { createSidecarStore } = require("./sidecar-store.cjs");
const { createWalStore } = require("./wal-store.cjs");
const { createWalWriterCoordinator } = require("./wal-writer-coordinator.cjs");
const { createRegistryCache } = require("./registry-cache.cjs");
const { createFormat3Importer } = require("./format3-importer.cjs");

const PROTOCOL = "wal-sidecar-v3.1";
const KINDS = new Set(["Highlight", "Underline", "Square", "Ink", "InkHighlight", "FreeText"]);

function createWalAnnotationStore({ adapter, coordinationAdapter = adapter, root = "00_Archive/20_PDFData",
  hash, verifyHash, identityHash = hash, deviceId, uuid, onTiming = () => {}, sourceExists = (path) => adapter.exists(path),
  maintenance = { tailOperations: 256, walBytes: 512 * 1024 }, ...legacyOptions }) {
  const stableHash = async (bytes) => {
    const result = await identityHash(bytes);
    return /^[0-9a-f]{64}$/i.test(result) ? `sha256-v1:${result}` : result;
  };
  const sidecars = createSidecarStore({ adapter, root, hash, verifyHash, token: uuid });
  const wals = createWalStore({ adapter, root, hash, verifyHash, deviceId, token: uuid, sidecarStore: sidecars });
  const coordinator = createWalWriterCoordinator();
  const legacy = createPdfAnnotationStore({ adapter, root, hash, identityHash, deviceId, uuid, ...legacyOptions });
  const importer = createFormat3Importer({ legacyStore: legacy, sidecarStore: sidecars, stableHash });
  const registry = createRegistryCache({ adapter, root, ensureDirectory });
  const documents = new Map();
  const receipts = new Map();
  let routingGeneration = 0;
  let verifiedRoutingGeneration = -1;
  const queued = (key, work) => coordinator.run(coordinationAdapter, deviceId, `host:${key}`, work);

  async function ensureDirectory(path) {
    let current = "";
    for (const segment of path.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await adapter.exists(current))) {
        try { await adapter.mkdir(current); } catch (error) { if (!(await adapter.exists(current))) throw error; }
      }
    }
  }
  function identityOnly(document) { return { documentId: document.documentId, docKey: document.docKey }; }
  function opsFor(state) { return [...Object.values(state.annotations), ...Object.values(state.tombstones), ...(state.routing ? [state.routing] : [])]; }
  async function list(path) {
    if (!(await adapter.exists(path))) return { files: [], folders: [] };
    const result = await adapter.list(path);
    const absolute = (entry) => entry.startsWith(`${path}/`) ? entry : `${path}/${entry}`;
    return { files: result.files.map(absolute), folders: result.folders.map(absolute) };
  }
  async function discover() {
    const scanGeneration = routingGeneration;
    const keys = new Map();
    const paths = (await list(`${root}/sidecars`)).files.filter((path) => /\.annot\.json(?:\.pending)?$/.test(path));
    for (const directory of (await list(`${root}/wal`)).folders) {
      paths.push(...(await list(directory)).files.filter((path) => /\.json(?:\.pending)?$/.test(path)));
    }
    for (const path of paths) {
      // Headers are discovery hints only; readEffective verifies all envelopes.
      try {
        const value = JSON.parse(await adapter.read(path));
        const header = value.document || value;
        if (!/^[a-f0-9]{12}$/.test(header.docKey || "") || typeof header.documentId !== "string") continue;
        let verified;
        if (verifyHash) {
          const { integrity, ...unsigned } = value;
          if (typeof integrity !== "string" || !await verifyHash(new TextEncoder().encode(canonicalJson(unsigned)), integrity)) continue;
          verified = unsigned;
        } else verified = await verify(value, hash);
        if (path.startsWith(`${root}/sidecars/`)) sidecars.validateSidecar(verified, header);
        else wals.validateWal(verified, header, path.slice(`${root}/wal/`.length).split("/")[0]);
        keys.set(`${header.docKey}:${header.documentId}`, identityOnly(header));
      } catch { /* Unverified headers are discovery hints, never authority. */ }
    }
    const result = [];
    const verifiedKeys = new Map();
    for (const candidate of keys.values()) {
      let loaded;
      try { loaded = await readEffective(candidate); }
      catch (error) { if (["VERSION_COLLISION", "DOC_KEY_COLLISION"].includes(error.code)) throw error; continue; }
      if (loaded.document) {
        const prior = verifiedKeys.get(candidate.docKey);
        if (prior && prior !== candidate.documentId) throw failure("DOC_KEY_COLLISION", "Verified records assign this docKey to different full identities.");
        verifiedKeys.set(candidate.docKey, candidate.documentId);
        documents.set(loaded.document.documentId, loaded.document);
        result.push(loaded.document);
      }
    }
    // Best effort cache writes cannot turn a durable WAL commit into failure.
    try { await registry.replace(result); } catch (error) {
      if (error.code === "IDENTITY_ROUTE_CONFLICT") throw error;
      onTiming({ phase: "registry-cache", code: error.code || "CACHE_WRITE_FAILED" });
    }
    if (routingGeneration === scanGeneration) verifiedRoutingGeneration = scanGeneration;
    return result;
  }

  async function readEffective(document) {
    const start = monotonic();
    let sidecar = null;
    let sidecarError = null;
    try { sidecar = await sidecars.loadSidecar(document); } catch (error) { sidecarError = error; }
    if (sidecarError?.code === "DOC_KEY_COLLISION") throw sidecarError;
    const loadedWals = await wals.loadWals(document);
    const valid = loadedWals.valid.map((entry) => entry.wal || entry);
    const errors = loadedWals.errors;
    if (errors.some((error) => error.code === "DOC_KEY_COLLISION")) throw failure("DOC_KEY_COLLISION", "Verified WAL records assign this key to another full document identity.");
    if (!sidecar && !valid.length) {
      if (sidecarError) throw sidecarError;
      return { document: null, state: buildEffectiveState(), sidecar: null, valid, errors };
    }
    const metadata = sidecar?.document || valid.find((wal) => wal.document)?.document;
    if (!metadata || metadata.documentId !== document.documentId || metadata.docKey !== document.docKey) {
      throw failure("WAL_DOCUMENT_METADATA_MISSING", "Verified recovery metadata is unavailable.");
    }
    for (const wal of valid) {
      const other = wal.document;
      if (!other || sourceIdentityDisagrees(metadata.source, other.source) ||
          (metadata.initialPath && other.initialPath && metadata.initialPath !== other.initialPath)) {
        throw failure("SOURCE_MISMATCH", "Verified WAL contributors disagree about this PDF's immutable source identity.");
      }
    }
    const state = buildEffectiveState({ sidecar, anchors: valid.map((wal) => wal.anchor), tails: valid.map((wal) => wal.tail) });
    const routing = state.routing?.payload || {};
    if (sourceIdentityDisagrees(metadata.source, routing.source)) throw failure("SOURCE_MISMATCH", "A routing update cannot replace the PDF source identity.");
    const source = { ...(metadata.source || metadata), ...(routing.source || {}) };
    const resolved = { ...metadata, ...identityOnly(document), source,
      sourcePath: normalizeInitialPath(routing.sourcePath || metadata.sourcePath || metadata.initialPath),
      legacyIdentities: routing.legacyIdentities || metadata.legacyIdentities || [],
      legacyIdentityScanComplete: routing.legacyIdentityScanComplete ?? metadata.legacyIdentityScanComplete ?? false };
    validateFullSourceHash(source.sourceHash);
    const result = { document: resolved, state, sidecar, valid, errors, sidecarError };
    onTiming({ phase: "wal-effective-state", docKey: document.docKey, elapsedMs: monotonic() - start,
      validShards: valid.length, invalidShards: errors.length, sidecarRecovered: Boolean(sidecarError) });
    return result;
  }

  async function documentForPath(sourcePath) {
    const path = normalizeInitialPath(sourcePath);
    const hint = verifiedRoutingGeneration === routingGeneration ? await registry.lookup(path) : null;
    if (hint) {
      try {
        const verified = await readEffective(hint);
        if (verified.document?.sourcePath === path) return verified.document;
      } catch (error) { if (error.code === "VERSION_COLLISION") throw error; }
    }
    const matches = (await discover()).filter((doc) => doc.sourcePath === path);
    if (matches.length > 1) throw failure("IDENTITY_ROUTE_CONFLICT", "Multiple documents route to this PDF.");
    return matches[0] || null;
  }

  async function registerDocument({ sourcePath, source = {}, newInstance = false }) {
    const path = normalizeInitialPath(sourcePath);
    const fullSourceHash = validateFullSourceHash(source.sourceHash || source.fastHash);
    const found = await documentForPath(path);
    if (found && !newInstance) return withSourceMatch(found, source);
    if (found && newInstance) throw failure("IDENTITY_ROUTE_CONFLICT", "Move the existing routed document before establishing a different copy at this path.");
    const identity = await deriveDocumentIdentity({ initialPath: path, fullSourceHash, stableHash,
      ...(newInstance ? { documentId: `pdf-instance:${uuid()}` } : {}) });
    return queued(identity.docKey, async () => {
      const all = await discover();
      if (!newInstance) {
        for (const known of all) {
          if (known.sourcePath !== path && known.source.sourceHash === fullSourceHash &&
              !(await sourceExists(known.sourcePath))) {
            throw failure("IDENTITY_ROUTING_UNCONFIRMED", "The PDF may have moved before its route arrived; wait for routing sync or explicitly establish a new copy.");
          }
        }
      }
      const occupied = all.find((doc) => doc.docKey === identity.docKey);
      if (occupied) {
        if (occupied.documentId !== identity.documentId) throw failure("DOC_KEY_COLLISION", "A document key is already occupied.");
        if (occupied.sourcePath !== path && await sourceExists(occupied.sourcePath)) {
          throw failure("IDENTITY_AMBIGUOUS_COPY", "This identity is routed to another existing PDF; establish a new copy explicitly.");
        }
        // A route may be absent while a rename operation is still syncing.
        if (occupied.sourcePath !== path) throw failure("IDENTITY_ROUTING_UNCONFIRMED", "Wait for the PDF route to synchronize.");
        return withSourceMatch(occupied, source);
      }
      const candidateState = await readEffective(identity);
      if (candidateState.errors.length) throw failure("WAL_SYNC_PENDING", "An existing document shard is invalid; refusing to initialize empty state.");
      if (candidateState.document) {
        if (candidateState.document.sourcePath !== path) throw failure("IDENTITY_AMBIGUOUS_COPY", "A recovered identity belongs to another route.");
        return withSourceMatch(candidateState.document, source);
      }
      let document = { ...identity, sourcePath: path, source: persistedSource(source), legacyIdentities: [], legacyIdentityScanComplete: false };
      let baseline = null;
      if (!newInstance) {
        let exported;
        try { exported = await legacy.exportForMigration(path); }
        catch (error) { if (error.code !== "PDF_ANNOTATION_IDENTITY_MISSING") throw error; }
        if (exported) {
          if (!sourceMatches(exported.document.source, source)) throw failure("SOURCE_MISMATCH", "Legacy annotations belong to another source PDF.");
          const prepared = await importer.prepareImport(exported);
          baseline = prepared.sidecar;
          document = { ...document, ...(baseline.document || {}), ...identity,
            sourcePath: path, source: persistedSource({ ...exported.document.source, ...source }) };
        }
      }
      const routing = baseline?.operations?.find((op) => op.type === "ROUTE_SET") || {
        type: "ROUTE_SET", seq: 0, opId: `legacy-import:${identity.docKey}:route`,
        version: { rev: 1, deviceId: "legacy-import", seq: 0 },
        payload: { sourcePath: path, source: document.source, legacyIdentities: document.legacyIdentities,
          legacyIdentityScanComplete: document.legacyIdentityScanComplete },
      };
      const initialOperations = baseline?.operations || [routing];
      // Write the recovery contribution BEFORE the materialized snapshot.
      // A crash before/after either step leaves a complete recoverable state.
      const existingWal = await wals.readWal(document);
      if (!existingWal) await wals.writeWal(document, newWal(document, initialOperations));
      await sidecars.writeSidecar(document, {
        schemaVersion: 1, kind: "pdf-reader-materialized-sidecar", document,
        operations: initialOperations, watermark: {},
      });
      documents.set(document.documentId, document);
      try { await registry.replace([...all, document]); } catch { /* Verified WAL remains the authority. */ }
      return withSourceMatch(document, source);
    });
  }

  function newWal(document, initialOperations = []) {
    return { schemaVersion: 1, kind: "pdf-reader-device-wal", deviceId,
      ...identityOnly(document), document: clean(document), nextSeq: 1,
      anchor: { throughSeq: 0, operations: initialOperations }, tail: [] };
  }
  function withSourceMatch(document, source) {
    const match = sourceMatches(document.source, source);
    return { ...document, sourceMatch: match ? "MATCH" : "MISMATCH", sourceMismatch: !match };
  }
  async function loadForWrite(document) {
    const effective = await readEffective(document);
    if (!effective.document) throw failure("WAL_DOCUMENT_MISSING", "The document recovery state has not arrived.");
    if (effective.errors.length) throw failure("WAL_SYNC_PENDING", "A WAL shard is incomplete or invalid; editing is paused.");
    const own = await wals.readWal(document) || newWal(effective.document);
    if (effective.sidecar?.watermark?.[deviceId] >= own.nextSeq) {
      throw failure("WAL_SEQ_REGRESSION", "This device WAL regressed behind its observed watermark.");
    }
    return { effective, own };
  }

  async function commit(document, inputs) {
    return queued(document.docKey, async () => {
      const { effective, own } = await loadForWrite(document);
      const routed = await documentForPath(effective.document.sourcePath);
      if (!routed || routed.documentId !== document.documentId) throw failure("IDENTITY_ROUTE_CONFLICT", "The PDF routing changed before this edit was written.");
      let state = effective.state;
      const appended = [];
      let acknowledgedOpId = null;
      const durableInputs = effective.valid.flatMap((wal) => [...wal.anchor.operations, ...wal.tail]);
      for (const input of inputs) {
        const receiptKey = input.originOpId ? `${document.docKey}:${input.uuid}:${input.originOpId}` : null;
        const receipt = receiptKey && receipts.get(receiptKey);
        if (receipt) {
          const inputHash = await hash(new TextEncoder().encode(canonicalJson(input)));
          if (inputHash !== receipt.inputHash) throw failure("WAL_OPERATION_COLLISION", "An acknowledged input ID names different content.");
          acknowledgedOpId = receipt.opId;
          continue;
        }
        const repeated = receiptKey && [...durableInputs, ...appended].find((op) =>
          op.version.deviceId === deviceId && op.uuid === input.uuid && op.originOpId === input.originOpId);
        if (repeated) {
          const { seq: _seq, version: _version, opId: _opId, ...original } = repeated;
          if (canonicalJson(original) !== canonicalJson(input)) throw failure("WAL_OPERATION_COLLISION", "An input operation ID names different annotation content.");
          acknowledgedOpId = repeated.opId;
          continue;
        }
        const prior = input.type === "ROUTE_SET" ? state.routing : state.annotations[input.uuid] || state.tombstones[input.uuid];
        const seq = own.nextSeq++;
        const operation = { ...input, seq, opId: `${deviceId}:${document.docKey}:${seq}`,
          version: { rev: (prior?.version.rev || 0) + 1, deviceId, seq } };
        own.tail.push(operation);
        appended.push(operation);
        acknowledgedOpId = operation.opId;
        state = buildEffectiveState({ sidecar: { operations: opsFor(state) }, tails: [operation] });
      }
      if (appended.length) await wals.writeWal(document, own);
      for (const op of appended) {
        if (op.originOpId) {
          const { seq: _seq, version: _version, opId, ...input } = op;
          receipts.set(`${document.docKey}:${op.uuid}:${op.originOpId}`, {
            opId, inputHash: await hash(new TextEncoder().encode(canonicalJson(input))),
          });
        }
      }
      while (receipts.size > 10000) receipts.delete(receipts.keys().next().value);
      return { operationCount: appended.length, batchId: acknowledgedOpId,
        acknowledged: true, snapshotPending: true, state };
    });
  }

  async function appendOperations({ document, operations, sourceHash, quarantined = false }) {
    if ((!quarantined && document.sourceMismatch) || (sourceHash && sourceHash !== document.source.sourceHash)) throw failure("SOURCE_MISMATCH", "Annotation operations belong to another PDF source.");
    const inputs = operations.map((row) => {
      if (!row || !KINDS.has(row.kind) || !Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0 ||
          typeof row.uuid !== "string" || !row.uuid || (!row.deleted && !row.payload)) throw failure("WAL_OPERATION_INVALID", "Incomplete annotation payload.");
      return clean({ type: row.deleted ? "ANNOTATION_DELETE" : "ANNOTATION_SET", uuid: row.uuid,
        kind: row.kind, pageIndex: row.pageIndex, embeddedRef: row.embeddedRef ?? null,
        ...(row.clock?.opId ? { originOpId: row.clock.opId } : {}),
        ...(row.deleted ? {} : { payload: row.payload }) });
    });
    // A validated recovery stays bound to the ORIGINAL immutable source
    // identity. The host checks its original hash/page identities and never
    // hydrates this contribution onto the externally replaced PDF.
    const result = await commit(document, inputs);
    return { ...result, quarantined };
  }
  async function updateMetadata(document, delta) {
    const effective = await readEffective(document);
    const current = effective.document;
    if (!current) throw failure("WAL_DOCUMENT_MISSING", "Document metadata is unavailable.");
    const payload = { sourcePath: current.sourcePath, source: current.source,
      legacyIdentities: current.legacyIdentities, legacyIdentityScanComplete: current.legacyIdentityScanComplete, ...delta };
    if (canonicalJson(effective.state.routing?.payload) !== canonicalJson(payload)) await commit(document, [{ type: "ROUTE_SET", payload }]);
    const loaded = await readEffective(document);
    return loaded.document;
  }
  async function updateSourceIdentity({ document, ...source }) {
    const loaded = await readEffective(document);
    if (!sourceMatches(loaded.document.source, source)) return { document: loaded.document, sourceMatch: "MISMATCH", sourceMismatch: true };
    const updated = await updateMetadata(document, { source: { ...loaded.document.source, ...clean(source) } });
    return { document: updated, sourceMatch: "MATCH", sourceMismatch: false };
  }
  async function updateLegacyIdentities({ document, identities }) {
    const refs = new Set(), uuids = new Set();
    for (const row of identities) {
      const key = `${row.pageIndex}:${row.ref}`;
      if (!row.uuid || !row.ref || refs.has(key) || uuids.has(row.uuid)) throw failure("PDF_ANNOTATION_LEGACY_IDENTITY_AMBIGUOUS", "Legacy PDF identities are ambiguous.");
      refs.add(key); uuids.add(row.uuid);
    }
    return updateMetadata(document, { legacyIdentities: clean(identities), legacyIdentityScanComplete: true });
  }
  async function renameDocument({ documentId, fromPath, toPath }) {
    const prior = await documentForPath(fromPath);
    if (!prior || prior.documentId !== documentId) throw failure("WAL_IDENTITY_MISSING", "Rename source identity is unavailable.");
    const target = await documentForPath(toPath);
    if (target && target.documentId !== documentId) throw failure("IDENTITY_ROUTE_CONFLICT", "Rename destination already has another identity.");
    return updateMetadata(prior, { sourcePath: normalizeInitialPath(toPath) });
  }
  async function readDocument(document) {
    if (document.sourceMismatch) throw failure("SOURCE_MISMATCH", "Cannot hydrate annotations onto a changed source PDF.");
    const loaded = await readEffective(document);
    if (!loaded.document) throw failure("WAL_DOCUMENT_MISSING", "The document recovery state is unavailable.");
    const routed = await documentForPath(loaded.document.sourcePath);
    if (!routed || routed.documentId !== document.documentId) throw failure("IDENTITY_ROUTE_CONFLICT", "The PDF path has conflicting document identities.");
    const rows = (map, deleted) => Object.values(map).map((op) => ({ uuid: op.uuid, kind: op.kind,
      pageIndex: op.pageIndex, embeddedRef: op.embeddedRef ?? null, ...(deleted ? {} : { deleted: false }),
      ...(deleted ? {} : { payload: op.payload }), version: op.version,
      // Compatibility envelope for the existing hydration adapter only.
      // Conflict resolution has already happened in the canonical join.
      clock: { timestamp: op.version.rev, logical: op.version.seq,
        deviceId: op.version.deviceId, opId: op.opId } }));
    return { schemaVersion: 2, kind: "pdf-annotation-snapshot", storageProtocol: PROTOCOL,
      ...identityOnly(loaded.document), source: { ...loaded.document.source, sourcePath: loaded.document.sourcePath },
      legacyIdentities: loaded.document.legacyIdentities, legacyIdentityScanComplete: loaded.document.legacyIdentityScanComplete,
      compactInkEncoding: true, revision: loaded.valid.reduce((sum, wal) => sum + wal.nextSeq - 1, 0),
      annotations: rows(loaded.state.annotations, false), tombstones: rows(loaded.state.tombstones, true),
      ...(loaded.errors.length ? { syncPending: true } : {}) };
  }
  async function materializeSnapshot(document) {
    return queued(document.docKey, async () => {
      const loaded = await readEffective(document);
      if (loaded.errors.length) return readDocument(document);
      const own = await wals.readWal(document);
      const shouldMaintain = !loaded.sidecar || !own || own.tail.length >= maintenance.tailOperations ||
        canonicalJson(own).length >= maintenance.walBytes;
      // Materialization is maintenance, never an acknowledgement dependency.
      if (shouldMaintain) await wals.compact(document);
      return readDocument(document);
    });
  }
  function pathsFor(document) {
    return { root, snapshot: `${root}/sidecars/${document.docKey}.annot.json`,
      walRoot: `${root}/wal`, registry: registry.path, docKey: document.docKey };
  }
  function affectsPath(document, path) {
    return path === registry.path || path === pathsFor(document).snapshot ||
      (path.startsWith(`${root}/wal/`) && path.endsWith(`/${document.docKey}.json`));
  }
  async function inspectDevices(document) {
    const loaded = await readEffective(document);
    return { protocol: PROTOCOL, devices: loaded.valid.map((wal) => ({ deviceId: wal.deviceId,
      nextSeq: wal.nextSeq, tailCount: wal.tail.length, anchorCount: wal.anchor.operations.length,
      isCurrent: wal.deviceId === deviceId })), errors: loaded.errors };
  }
  return { registerDocument, documentForPath, appendOperations, readDocument, materializeSnapshot,
    updateSourceIdentity, updateLegacyIdentities, renameDocument, pathsFor, affectsPath,
    readEffective, inspectDevices, sourceProtocol: PROTOCOL,
    invalidateRegistry: () => { routingGeneration += 1; },
    establishNewCopy: (input) => registerDocument({ ...input, newInstance: true }) };
}
function clean(value) { return JSON.parse(JSON.stringify(value)); }
function persistedSource(source) { const value = clean(source); delete value.mtime; return value; }
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function monotonic() { return globalThis.performance?.now?.() ?? Date.now(); }
function sourceMatches(stored = {}, incoming = {}) {
  return !sourceIdentityDisagrees(stored, incoming) && Boolean(stored.sourceHash && incoming.sourceHash && stored.sourceHash === incoming.sourceHash);
}
function sourceIdentityDisagrees(stored = {}, incoming = {}) {
  if (!stored || !incoming) return false;
  for (const key of ["sourceHash", "size", "pageCount", "orderedPageIdentities"]) {
    if (stored[key] !== undefined && incoming[key] !== undefined && canonicalJson(stored[key]) !== canonicalJson(incoming[key])) return true;
  }
  return false;
}
module.exports = { createWalAnnotationStore, PROTOCOL };
