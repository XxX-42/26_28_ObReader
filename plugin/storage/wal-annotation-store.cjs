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
const { createObsidianStorageBridge } = require("./obsidian-storage-bridge.cjs");
const { createJsonlCheckpointStore } = require("./jsonl-checkpoint.cjs");
const { createDeletionRetention } = require("./deletion-retention.cjs");
const { activateJsonlProtocol } = require("./protocol-barrier.cjs");

const PROTOCOL = "wal-sidecar-v3.1";
const KINDS = new Set(["Highlight", "Underline", "Square", "Ink", "InkHighlight", "FreeText"]);
const EMPTY_JSONL_HEADER = Symbol("empty-jsonl-header");
const jsonlGenerationsByAdapter = new WeakMap();

function jsonlGeneration(adapter, docKey) {
  return jsonlGenerationsByAdapter.get(adapter)?.get(docKey) || 0;
}
function advanceJsonlGeneration(adapter, docKey) {
  let generations = jsonlGenerationsByAdapter.get(adapter);
  if (!generations) { generations = new Map(); jsonlGenerationsByAdapter.set(adapter, generations); }
  generations.set(docKey, (generations.get(docKey) || 0) + 1);
  return generations.get(docKey);
}

function createWalAnnotationStore({ adapter, coordinationAdapter = adapter, root = "00_Archive/20_PDFData",
  hash, verifyHash, identityHash = hash, deviceId, uuid, onTiming = () => {}, sourceExists = (path) => adapter.exists(path),
  maintenance = { tailOperations: 256, walBytes: 512 * 1024 }, jsonlMode = false, clock = Date.now, ...legacyOptions }) {
  const stableHash = async (bytes) => {
    const result = await identityHash(bytes);
    return /^[0-9a-f]{64}$/i.test(result) ? `sha256-v1:${result}` : result;
  };
  const sidecars = createSidecarStore({ adapter, root, hash, verifyHash, token: uuid });
  const wals = createWalStore({ adapter, root, hash, verifyHash, deviceId, token: uuid, sidecarStore: sidecars });
  const jsonl = jsonlMode ? createObsidianStorageBridge({ adapter, root, hash, verifyHash }) : null;
  const jsonlCheckpoints = jsonlMode ? createJsonlCheckpointStore({ adapter, root, hash, verifyHash, token: uuid }) : null;
  const deletionRetention = jsonlMode ? createDeletionRetention({ adapter, root, deviceId, hash, verifyHash, token: uuid, clock }) : null;
  const coordinator = createWalWriterCoordinator();
  const legacy = createPdfAnnotationStore({ adapter, root, hash, identityHash, deviceId, uuid, clock, ...legacyOptions });
  const importer = createFormat3Importer({ legacyStore: legacy, sidecarStore: sidecars, stableHash });
  const registry = createRegistryCache({ adapter, root, ensureDirectory });
  const documents = new Map();
  const receipts = new Map();
  const hotDocuments = new Map();
  let routingGeneration = 0;
  let verifiedRoutingGeneration = -1;
  let epochActivation = null;
  async function activateEpoch() {
    if (!jsonlMode) return;
    if (!epochActivation) epochActivation = (async () => {
      await ensureDirectory(root);
      await activateJsonlProtocol(adapter, root);
    })().catch((error) => { epochActivation = null; throw error; });
    await epochActivation;
  }
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
  function localizeSeedOperations(document, operations) {
    return operations.slice()
      .sort((left, right) => {
        const leftKey = left.type === "ROUTE_SET" ? "\uffffroute" : left.uuid;
        const rightKey = right.type === "ROUTE_SET" ? "\uffffroute" : right.uuid;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((operation, index) => {
        const seq = index + 1;
        return { ...operation, seq, opId: `${deviceId}:${document.docKey}:${seq}`,
          version: { rev: operation.version?.rev || 1, deviceId, seq } };
      });
  }
  async function ensureOwnJsonlBaseline(document) {
    const loaded = await readEffective(document);
    if (!loaded.document) throw failure("WAL_DOCUMENT_MISSING", "The document baseline is unavailable for JSONL migration.");
    if (loaded.errors.length) throw failure("WAL_SYNC_PENDING", "An incomplete document shard blocks JSONL baseline migration.");
    const hasOwnContribution =
      (loaded.jsonlAnchors || []).some((entry) => entry.deviceId === deviceId) ||
      (loaded.jsonlArchives || []).some((entry) => entry.deviceId === deviceId) ||
      (loaded.jsonlRows || []).some((entry) => entry.deviceId === deviceId && entry.operations.length > 0);
    if (hasOwnContribution) return loaded.document;
    const seeded = localizeSeedOperations(loaded.document, opsFor(loaded.state));
    if (!seeded.length) throw failure("WAL_DOCUMENT_METADATA_MISSING", "The effective legacy state has no route or annotation baseline.");
    await jsonlCheckpoints.writeAnchor(loaded.document, deviceId, seeded, null);
    const watermarks = {};
    for (const wal of loaded.valid) watermarks[wal.deviceId] = Math.max(watermarks[wal.deviceId] || 0, wal.nextSeq - 1);
    for (const entry of loaded.jsonlAnchors || []) watermarks[entry.deviceId] = Math.max(
      watermarks[entry.deviceId] || 0, entry.anchor.throughSeq);
    for (const entry of loaded.jsonlArchives || []) watermarks[entry.deviceId] = Math.max(
      watermarks[entry.deviceId] || 0, entry.archive.lastSeq);
    for (const entry of loaded.jsonlRows || []) watermarks[entry.deviceId] = Math.max(
      watermarks[entry.deviceId] || 0, entry.operations.at(-1)?.seq || 0);
    watermarks[deviceId] = Math.max(watermarks[deviceId] || 0, seeded.at(-1)?.seq || 0);
    await jsonlCheckpoints.writeSnapshot(loaded.document, loaded.state, watermarks);
    hotDocuments.delete(document.docKey);
    advanceJsonlGeneration(coordinationAdapter, document.docKey);
    documents.set(loaded.document.documentId, loaded.document);
    return loaded.document;
  }
  async function list(path) {
    if (!(await adapter.exists(path))) return { files: [], folders: [] };
    const result = await adapter.list(path);
    const absolute = (entry) => entry.startsWith(`${path}/`) ? entry : `${path}/${entry}`;
    return { files: result.files.map(absolute), folders: result.folders.map(absolute) };
  }
  async function readJsonlHeader(path) {
    const text = await adapter.read(path);
    if (path.endsWith(".jsonl")) {
      if (text === "") return EMPTY_JSONL_HEADER;
      const newline = text.indexOf("\n");
      if (newline < 0) return null;
      return JSON.parse(text.slice(0, newline));
    }
    return JSON.parse(text);
  }
  async function discover() {
    const scanGeneration = routingGeneration;
    const keys = new Map();
    const paths = (await list(`${root}/sidecars`)).files.filter((path) => /\.annot\.json(?:\.pending)?$/.test(path));
    const walDirectories = (await list(`${root}/wal`)).folders;
    for (const directory of walDirectories) {
      const files = (await list(directory)).files;
      paths.push(...files.filter((path) => /\.json(?:\.pending)?$/.test(path)));
      if (jsonl) {
        for (const path of files.filter((candidate) => /\.jsonl(?:\.anchor\.json|\.archive\.\d+-\d+\.json)?$/.test(candidate))) {
          try {
            const header = await readJsonlHeader(path);
            if (/^[a-f0-9]{12}$/.test(header?.docKey || "") && typeof header.documentId === "string") {
              keys.set(`${header.docKey}:${header.documentId}`, identityOnly(header));
            }
          } catch { /* A JSONL header is only a hint; readEffective validates the record. */ }
        }
      }
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

  async function readEffective(document, { readOnly = false } = {}) {
    const start = monotonic();
    let sidecar = null;
    let sidecarError = null;
    try { sidecar = await sidecars.loadSidecar(document); } catch (error) { sidecarError = error; }
    if (sidecarError?.code === "DOC_KEY_COLLISION") throw sidecarError;
    const loadedWals = await wals.loadWals(document);
    const valid = loadedWals.valid.map((entry) => entry.wal || entry);
    const errors = [...loadedWals.errors];
    if (errors.some((error) => error.code === "DOC_KEY_COLLISION")) throw failure("DOC_KEY_COLLISION", "Verified WAL records assign this key to another full document identity.");
    const jsonlRows = [];
    const jsonlAnchors = [];
    const jsonlArchives = [];
    const jsonlSources = new Set();
    if (jsonl) {
      for (const directory of (await list(`${root}/wal`)).folders) {
        const owner = directory.slice(`${root}/wal/`.length);
        if (!owner || owner.includes("/") || owner.includes("\\")) continue;
        const path = jsonl.pathsFor(document.docKey, owner).wal;
        const anchorPath = jsonlCheckpoints.anchorPath(document, owner);
        const files = (await list(directory)).files.filter((candidate) =>
          candidate.endsWith(`/${document.docKey}.jsonl`) ||
          candidate.endsWith(`/${document.docKey}.jsonl.anchor.json`) ||
          new RegExp(`/${document.docKey}\\.jsonl\\.archive\\.\\d+-\\d+\\.json$`).test(candidate));
        const sourceHashes = new Set();
        for (const candidatePath of files) {
          try {
            const header = await readJsonlHeader(candidatePath);
            if (header === EMPTY_JSONL_HEADER) continue;
            if (!header || typeof header !== "object") {
              errors.push({ deviceId: owner, path: candidatePath, code: "WAL_JSONL_HEADER_INVALID",
                message: "A JSONL record has no complete identity header." });
              continue;
            }
            if (header.docKey !== document.docKey || header.documentId !== document.documentId) {
              errors.push({ deviceId: owner, path: candidatePath, code: "DOC_KEY_COLLISION",
                message: "A JSONL path is occupied by a different full document identity." });
              continue;
            }
            const sourceHash = validateFullSourceHash(header.sourceHash || header.payload?.source?.sourceHash);
            sourceHashes.add(sourceHash);
          } catch (error) {
            errors.push({ deviceId: owner, path: candidatePath,
              code: error?.code || "WAL_JSONL_HEADER_INVALID", message: String(error?.message || error) });
          }
        }
        if (sourceHashes.size > 1) {
          errors.push({ deviceId: owner, path: directory, code: "SOURCE_MISMATCH",
            message: "JSONL records for one device disagree about the immutable source hash." });
          continue;
        }
        const sourceHash = sourceHashes.values().next().value || document.source?.sourceHash || document.fullSourceHash;
        if (!sourceHash || !files.length) continue;
        jsonlSources.add(sourceHash);
        const jsonlDocument = { ...document, sourceHash,
          source: { ...(document.source || {}), sourceHash } };
        try {
          for (const archived of await jsonlCheckpoints.loadArchives(jsonlDocument, owner)) {
            jsonlArchives.push({ deviceId: owner, ...archived });
          }
        } catch (error) {
          errors.push({ deviceId: owner, path: directory, code: error?.code || "WAL_JSONL_ARCHIVE_INVALID",
            message: String(error?.message || error) });
        }
        if (await adapter.exists(anchorPath) || await adapter.exists(`${anchorPath}.pending`)) {
          try {
            const anchor = await jsonlCheckpoints.readAnchor(jsonlDocument, owner);
            if (anchor) {
              jsonlAnchors.push({ deviceId: owner, path: anchorPath, anchor });
              for (const reference of anchor.archives) {
                if (!jsonlArchives.some((entry) => entry.path === reference.path)) {
                  errors.push({ deviceId: owner, path: reference.path, code: "WAL_JSONL_ARCHIVE_MISSING",
                    message: "An acknowledged device anchor references a missing immutable archive." });
                }
              }
            }
          } catch (error) {
            errors.push({ deviceId: owner, path: anchorPath, code: error?.code || "WAL_JSONL_ANCHOR_INVALID",
              message: String(error?.message || error) });
          }
        }
        if (!(await adapter.exists(path))) continue;
        try {
          const rows = await jsonl.readOperationRows(jsonlDocument, owner,
            { repairOwnTail: !readOnly && owner === deviceId });
          jsonlRows.push({ deviceId: owner, path, operations: rows });
        } catch (error) {
          errors.push({ deviceId: owner, path, code: error?.message || error?.code || "WAL_JSONL_INVALID",
            message: String(error?.message || error) });
        }
      }
    }
    if (jsonlSources.size > 1) errors.push({ path: `${root}/wal`, code: "SOURCE_MISMATCH",
      message: "JSONL contributors disagree about the immutable source hash." });
    const state = buildEffectiveState({ sidecar,
      anchors: [...valid.map((wal) => wal.anchor), ...jsonlAnchors.map((entry) => entry.anchor.operations),
        ...jsonlArchives.map((entry) => entry.archive.operations)],
      tails: [...valid.map((wal) => wal.tail), ...jsonlRows.map((entry) => entry.operations)] });
    const routing = state.routing?.payload || {};
    const metadata = sidecar?.document || valid.find((wal) => wal.document)?.document ||
      (routing.sourcePath ? { ...identityOnly(document), initialPath: routing.initialPath || routing.sourcePath,
        sourcePath: routing.sourcePath, source: routing.source || { sourceHash: routing.sourceHash },
        legacyIdentities: routing.legacyIdentities || [],
        legacyIdentityScanComplete: routing.legacyIdentityScanComplete === true } : null);
    if (!sidecar && !valid.length && !jsonlRows.length && !jsonlAnchors.length && !jsonlArchives.length) {
      if (sidecarError) throw sidecarError;
      return { document: null, state: buildEffectiveState(), sidecar: null, valid, errors };
    }
    if (!metadata || metadata.documentId !== document.documentId || metadata.docKey !== document.docKey) {
      throw failure("WAL_DOCUMENT_METADATA_MISSING", "Verified recovery metadata is unavailable.");
    }
    if ([...jsonlSources].some((sourceHash) => metadata.source?.sourceHash && sourceHash !== metadata.source.sourceHash)) {
      throw failure("SOURCE_MISMATCH", "JSONL contributors disagree with the verified document source identity.");
    }
    for (const wal of valid) {
      const other = wal.document;
      if (!other || sourceIdentityDisagrees(metadata.source, other.source) ||
          (metadata.initialPath && other.initialPath && metadata.initialPath !== other.initialPath)) {
        throw failure("SOURCE_MISMATCH", "Verified WAL contributors disagree about this PDF's immutable source identity.");
      }
    }
    if (sourceIdentityDisagrees(metadata.source, routing.source)) throw failure("SOURCE_MISMATCH", "A routing update cannot replace the PDF source identity.");
    const source = { ...(metadata.source || metadata), ...(routing.source || {}) };
    const resolved = { ...metadata, ...identityOnly(document), source,
      sourcePath: normalizeInitialPath(routing.sourcePath || metadata.sourcePath || metadata.initialPath),
      legacyIdentities: routing.legacyIdentities || metadata.legacyIdentities || [],
      legacyIdentityScanComplete: routing.legacyIdentityScanComplete ?? metadata.legacyIdentityScanComplete ?? false };
    validateFullSourceHash(source.sourceHash);
    const result = { document: resolved, state, sidecar, valid, jsonlRows, jsonlAnchors, jsonlArchives,
      errors, sidecarError };
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

  async function documentForIdentity({ docKey, documentId } = {}) {
    if (typeof docKey !== "string" || !/^[a-f0-9]{12}$/i.test(docKey) ||
        typeof documentId !== "string" || !documentId || documentId.length > 512) {
      throw failure("WAL_IDENTITY_INVALID", "A complete document identity is required.");
    }
    const identity = { docKey: docKey.toLowerCase(), documentId };
    const loaded = await readEffective(identity, { readOnly: true });
    if (!loaded.document || loaded.document.docKey !== identity.docKey || loaded.document.documentId !== documentId) {
      throw failure("WAL_IDENTITY_MISSING", "No verified route matches the requested document identity.");
    }
    return loaded.document;
  }

  async function registerDocument({ sourcePath, source = {}, newInstance = false }) {
    await activateEpoch();
    const path = normalizeInitialPath(sourcePath);
    const fullSourceHash = validateFullSourceHash(source.sourceHash || source.fastHash);
    const found = await documentForPath(path);
    if (found && !newInstance) {
      if (!sourceMatches(found.source, source)) return withSourceMatch(found, source);
      const existing = jsonl ? await queued(found.docKey, () => ensureOwnJsonlBaseline(found)) : found;
      return withSourceMatch(existing, source);
    }
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
      if (jsonl) {
        // Seed the new owner WAL directly from the verified legacy effective
        // state. v3.1 files remain read-only migration input in JSONL mode.
        // Each importing device gets its own ordered contribution; identical
        // initial states therefore converge under the shared version order.
        const seeded = localizeSeedOperations(document, initialOperations);
        await jsonlCheckpoints.writeAnchor(document, deviceId, seeded, null);
        const seededState = buildEffectiveState({ tails: [seeded] });
        await jsonlCheckpoints.writeSnapshot(document, seededState, { [deviceId]: seeded.length });
      } else {
        // Write the recovery contribution BEFORE the materialized snapshot.
        // A crash before/after either step leaves a complete recoverable state.
        const existingWal = await wals.readWal(document);
        if (!existingWal) await wals.writeWal(document, newWal(document, initialOperations));
        await sidecars.writeSidecar(document, {
          schemaVersion: 1, kind: "pdf-reader-materialized-sidecar", document,
          operations: initialOperations, watermark: {},
        });
      }
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
    const ownJsonl = effective.jsonlRows?.find((entry) => entry.deviceId === deviceId);
    const ownAnchor = effective.jsonlAnchors?.find((entry) => entry.deviceId === deviceId);
    const ownArchives = effective.jsonlArchives?.filter((entry) => entry.deviceId === deviceId) || [];
    own.nextSeq = Math.max(own.nextSeq, (ownJsonl?.operations.at(-1)?.seq || 0) + 1,
      (ownAnchor?.anchor.throughSeq || 0) + 1,
      ...ownArchives.map((entry) => entry.archive.lastSeq + 1));
    if (!jsonlMode && effective.sidecar?.watermark?.[deviceId] >= own.nextSeq) {
      throw failure("WAL_SEQ_REGRESSION", "This device WAL regressed behind its observed watermark.");
    }
    return { effective, own };
  }

  async function commit(document, inputs) {
    await activateEpoch();
    const queuedAt = monotonic();
    return queued(document.docKey, async () => {
      const workStarted = monotonic();
      const queueWaitMs = workStarted - queuedAt;
      let appendTiming = { encodeMs: 0, appendMs: 0 };
      const generation = jsonlGeneration(coordinationAdapter, document.docKey);
      const cached = jsonl && hotDocuments.get(document.docKey);
      const useCache = cached && cached.documentId === document.documentId && cached.generation === generation;
      const { effective, own: loadedOwn } = useCache ? cached : await loadForWrite(document);
      if (!useCache) {
        const routed = await documentForPath(effective.document.sourcePath);
        if (!routed || routed.documentId !== document.documentId) throw failure("IDENTITY_ROUTE_CONFLICT", "The PDF routing changed before this edit was written.");
      }
      const own = jsonl ? { ...loadedOwn } : loadedOwn;
      let state = effective.state;
      const appended = [];
      let acknowledgedOpId = null;
      const durableByOrigin = useCache ? cached.durableByOrigin : new Map();
      const appendedByOrigin = new Map();
      if (!useCache) {
        for (const operation of [
          ...effective.valid.flatMap((wal) => [...wal.anchor.operations, ...wal.tail]),
          ...(effective.jsonlAnchors || []).flatMap((entry) => entry.anchor.operations),
          ...(effective.jsonlArchives || []).flatMap((entry) => entry.archive.operations),
          ...(effective.jsonlRows || []).flatMap((entry) => entry.operations),
        ]) {
          if (operation.originOpId) durableByOrigin.set(`${operation.version.deviceId}:${operation.uuid}:${operation.originOpId}`, operation);
        }
      }
      const operationKinds = new Map();
      const pendingWinners = new Map();
      for (const input of inputs) {
        const receiptKey = input.originOpId ? `${document.docKey}:${input.uuid}:${input.originOpId}` : null;
        const receipt = receiptKey && receipts.get(receiptKey);
        if (receipt) {
          const inputHash = await hash(new TextEncoder().encode(canonicalJson(input)));
          if (inputHash !== receipt.inputHash) throw failure("WAL_OPERATION_COLLISION", "An acknowledged input ID names different content.");
          acknowledgedOpId = receipt.opId;
          continue;
        }
        const originKey = receiptKey && `${deviceId}:${input.uuid}:${input.originOpId}`;
        const repeated = originKey && (durableByOrigin.get(originKey) || appendedByOrigin.get(originKey));
        if (repeated) {
          const { seq: _seq, version: _version, opId: _opId, deletedAt: _deletedAt, ...original } = repeated;
          if (canonicalJson(original) !== canonicalJson(input)) throw failure("WAL_OPERATION_COLLISION", "An input operation ID names different annotation content.");
          acknowledgedOpId = repeated.opId;
          continue;
        }
        const key = input.type === "ROUTE_SET" ? "route" : `annotation:${input.uuid}`;
        const prior = pendingWinners.get(key) || (input.type === "ROUTE_SET" ? state.routing :
          state.annotations[input.uuid] || state.tombstones[input.uuid]);
        const seq = own.nextSeq++;
        const operation = { ...input, seq, opId: `${deviceId}:${document.docKey}:${seq}`,
          ...(jsonl && input.type === "ANNOTATION_DELETE" ? { deletedAt: clock() } : {}),
          version: { rev: (prior?.version.rev || 0) + 1, deviceId, seq } };
        operationKinds.set(operation.opId, input.type === "ANNOTATION_DELETE" ? "DELETE" :
          (pendingWinners.get(key) || state.annotations[input.uuid]) ? "UPDATE" : "CREATE");
      if (!jsonl) own.tail.push(operation);
        appended.push(operation);
        if (originKey) appendedByOrigin.set(originKey, operation);
        pendingWinners.set(key, operation);
        acknowledgedOpId = operation.opId;
        if (!jsonl) state = buildEffectiveState({ sidecar: { operations: opsFor(state) }, tails: [operation] });
      }
      if (appended.length) {
        if (jsonl) {
          appendTiming = await jsonl.appendOperationBatch(effective.document, deviceId, appended,
          (operation) => operationKinds.get(operation.opId));
        } else {
          await wals.writeWal(document, own);
        }
      }
      if (jsonl) {
        if (appended.length) {
          own.tail.push(...appended);
        }
        for (const operation of appended) {
          if (operation.type === "ROUTE_SET") state.routing = operation;
          else if (operation.type === "ANNOTATION_DELETE") {
            delete state.annotations[operation.uuid];
            state.tombstones[operation.uuid] = operation;
          } else {
            delete state.tombstones[operation.uuid];
            state.annotations[operation.uuid] = operation;
          }
          if (operation.originOpId) durableByOrigin.set(`${deviceId}:${operation.uuid}:${operation.originOpId}`, operation);
        }
        const nextGeneration = appended.length ? advanceJsonlGeneration(coordinationAdapter, document.docKey) : generation;
        const nextRows = effective.jsonlRows || [];
        const ownRows = nextRows.find((entry) => entry.deviceId === deviceId);
        if (appended.length && ownRows) ownRows.operations.push(...appended);
        else if (appended.length) nextRows.push({ deviceId, path: jsonl.pathsFor(document.docKey, deviceId).wal, operations: [...appended] });
        hotDocuments.set(document.docKey, { documentId: document.documentId, generation: nextGeneration,
          effective: { ...effective, state, jsonlRows: nextRows }, own, durableByOrigin });
      }
      for (const op of appended) {
        if (op.originOpId) {
          const { seq: _seq, version: _version, opId, deletedAt: _deletedAt, ...input } = op;
          receipts.set(`${document.docKey}:${op.uuid}:${op.originOpId}`, {
            opId, inputHash: await hash(new TextEncoder().encode(canonicalJson(input))),
          });
        }
      }
      while (receipts.size > 10000) receipts.delete(receipts.keys().next().value);
      return { operationCount: appended.length, batchId: acknowledgedOpId,
        acknowledged: true, snapshotPending: true,
        timings: { queueWaitMs, encodeMs: appendTiming.encodeMs, appendMs: appendTiming.appendMs,
          processingMs: Math.max(0, monotonic() - workStarted - appendTiming.appendMs), cacheHit: Boolean(useCache) },
        pendingSinceCheckpoint: jsonl ? (effective.jsonlRows?.find((entry) => entry.deviceId === deviceId)?.operations.length || 0) : null,
        state };
    });
  }

  async function appendOperations({ document, operations, sourceHash, quarantined = false }) {
    const captureStarted = monotonic();
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
    const captureMs = monotonic() - captureStarted;
    const result = await commit(document, inputs);
    return { ...result, quarantined, timings: { ...result.timings, captureMs } };
  }
  async function updateMetadata(document, delta) {
    hotDocuments.delete(document.docKey);
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
    hotDocuments.delete(prior.docKey);
    return updateMetadata(prior, { sourcePath: normalizeInitialPath(toPath) });
  }
  async function readDocument(document, { readOnly = false } = {}) {
    if (document.sourceMismatch) throw failure("SOURCE_MISMATCH", "Cannot hydrate annotations onto a changed source PDF.");
    const loaded = await readEffective(document, { readOnly });
    if (!loaded.document) throw failure("WAL_DOCUMENT_MISSING", "The document recovery state is unavailable.");
    if (loaded.document.docKey !== document.docKey || loaded.document.documentId !== document.documentId) {
      throw failure("IDENTITY_ROUTE_CONFLICT", "The requested document identity does not match the verified WAL state.");
    }
    // Link resolution and other read-only callers must not rebuild the registry
    // cache as a side effect. The effective state above is already assembled
    // from integrity-verified Sidecar/WAL records. Normal hydration retains the
    // route check, which may safely refresh the rebuildable path cache.
    if (!readOnly) {
      const routed = await documentForPath(loaded.document.sourcePath);
      if (!routed || routed.documentId !== document.documentId) {
        throw failure("IDENTITY_ROUTE_CONFLICT", "The PDF path has conflicting document identities.");
      }
    }
    const projection = deletionRetention ? await deletionRetention.project(loaded.document, loaded.state,
      { readOnly: readOnly || loaded.errors.length > 0 }) : { tombstones: loaded.state.tombstones, deletionGuards: [] };
    const rows = (map, deleted) => Object.values(map).map((op) => ({ uuid: op.uuid, kind: op.kind,
      pageIndex: op.pageIndex, embeddedRef: op.embeddedRef ?? null, ...(deleted ? {} : { deleted: false }),
      ...(deleted ? {} : { payload: op.payload }), version: op.version,
      // Compatibility envelope for the existing hydration adapter only.
      // Conflict resolution has already happened in the canonical join.
      clock: { timestamp: op.version.rev, logical: op.version.seq,
        deviceId: op.version.deviceId, opId: op.opId } }));
    return { schemaVersion: 2, kind: "pdf-annotation-snapshot", storageProtocol: jsonl ? "wal-sidecar-v3.2-jsonl" : PROTOCOL,
      ...identityOnly(loaded.document), source: { ...loaded.document.source, sourcePath: loaded.document.sourcePath },
      legacyIdentities: loaded.document.legacyIdentities, legacyIdentityScanComplete: loaded.document.legacyIdentityScanComplete,
      compactInkEncoding: true, revision: (() => {
        const maximum = new Map();
        for (const wal of loaded.valid) maximum.set(wal.deviceId, Math.max(maximum.get(wal.deviceId) || 0, wal.nextSeq - 1));
        for (const entry of loaded.jsonlAnchors || []) maximum.set(entry.deviceId,
          Math.max(maximum.get(entry.deviceId) || 0, entry.anchor.throughSeq));
        for (const entry of loaded.jsonlArchives || []) maximum.set(entry.deviceId,
          Math.max(maximum.get(entry.deviceId) || 0, entry.archive.lastSeq));
        for (const entry of loaded.jsonlRows || []) maximum.set(entry.deviceId,
          Math.max(maximum.get(entry.deviceId) || 0, entry.operations.at(-1)?.seq || 0));
        return [...maximum.values()].reduce((sum, value) => sum + value, 0);
      })(),
      annotations: rows(loaded.state.annotations, false), tombstones: rows(projection.tombstones, true),
      ...(projection.deletionGuards.length ? { deletionGuards: projection.deletionGuards } : {}),
      ...(loaded.errors.length ? { syncPending: true } : {}) };
  }
  async function materializeSnapshot(document) {
    await activateEpoch();
    return queued(document.docKey, async () => {
      const loaded = await readEffective(document);
      if (loaded.errors.length) return readDocument(document);
      const own = await wals.readWal(document);
      if (jsonl) {
        const ownRows = loaded.jsonlRows.find((entry) => entry.deviceId === deviceId)?.operations || [];
        let archived = false;
        if (ownRows.length) {
          const archive = await jsonlCheckpoints.writeArchive(loaded.document, deviceId, ownRows);
          await jsonlCheckpoints.writeAnchor(loaded.document, deviceId, ownRows, archive);
          archived = true;
        }
        const projection = await deletionRetention.project(loaded.document, loaded.state);
        if (archived || projection.deletionGuards.length || !(await adapter.exists(jsonlCheckpoints.snapshotPath(loaded.document)))) {
          const watermarks = {};
          for (const wal of loaded.valid) watermarks[wal.deviceId] = Math.max(watermarks[wal.deviceId] || 0, wal.nextSeq - 1);
          for (const entry of loaded.jsonlAnchors) watermarks[entry.deviceId] = Math.max(
            watermarks[entry.deviceId] || 0, entry.anchor.throughSeq);
          for (const entry of loaded.jsonlArchives) watermarks[entry.deviceId] = Math.max(
            watermarks[entry.deviceId] || 0, entry.archive.lastSeq);
          for (const entry of loaded.jsonlRows) watermarks[entry.deviceId] = Math.max(
            watermarks[entry.deviceId] || 0, entry.operations.at(-1)?.seq || 0);
          await jsonlCheckpoints.writeSnapshot(loaded.document, { ...loaded.state, tombstones: projection.tombstones,
            deletionGuards: projection.deletionGuards }, watermarks);
        }
        if (ownRows.length) {
          // The active JSONL is rotated only after an immutable device archive,
          // a verified device anchor, and the derived snapshot exist. Archives
          // are never GC'd without a separate multi-device acknowledgement gate.
          await jsonl.atomicReplace(jsonl.pathsFor(document.docKey, deviceId).wal, "");
          hotDocuments.delete(document.docKey);
          advanceJsonlGeneration(coordinationAdapter, document.docKey);
        }
        return readDocument(document);
      }
      const shouldMaintain = !loaded.sidecar || !own || own.tail.length >= maintenance.tailOperations ||
        canonicalJson(own).length >= maintenance.walBytes;
      // Materialization is maintenance, never an acknowledgement dependency.
      if (shouldMaintain) await wals.compact(document);
      return readDocument(document);
    });
  }
  function pathsFor(document) {
    return { root, snapshot: `${root}/sidecars/${document.docKey}.annot.json`,
      walRoot: `${root}/wal`, jsonlWal: jsonl?.pathsFor(document.docKey, deviceId).wal,
      registry: registry.path, docKey: document.docKey };
  }
  function affectsPath(document, path) {
    if (path === registry.path || path === pathsFor(document).snapshot) return true;
    if (jsonl) {
      if (path === jsonlCheckpoints.snapshotPath(document)) return true;
      if (path.startsWith(`${root}/wal/`)) {
        const leaf = path.slice(path.lastIndexOf("/") + 1);
        return leaf === `${document.docKey}.json` ||
          leaf === `${document.docKey}.jsonl` ||
          leaf.startsWith(`${document.docKey}.jsonl.`);
      }
      return false;
    }
    return path.startsWith(`${root}/wal/`) &&
      path.endsWith(`/${document.docKey}.json`);
  }
  async function inspectDevices(document) {
    const loaded = await readEffective(document);
    return { protocol: jsonl ? "wal-sidecar-v3.2-jsonl" : PROTOCOL, devices: loaded.valid.map((wal) => ({ deviceId: wal.deviceId,
      nextSeq: wal.nextSeq, tailCount: wal.tail.length, anchorCount: wal.anchor.operations.length,
      isCurrent: wal.deviceId === deviceId })), errors: loaded.errors };
  }
  return { registerDocument, documentForPath, documentForIdentity, appendOperations, readDocument, materializeSnapshot,
    updateSourceIdentity, updateLegacyIdentities, renameDocument, pathsFor, affectsPath,
    readEffective, inspectDevices, sourceProtocol: jsonl ? "wal-sidecar-v3.2-jsonl" : PROTOCOL,
    invalidateRegistry: () => { routingGeneration += 1; },
    invalidateExternal: (path) => {
      if (!jsonl || typeof path !== "string") return;
      for (const [docKey] of hotDocuments) {
        if (path.includes(`/${docKey}.`)) {
          hotDocuments.delete(docKey);
          advanceJsonlGeneration(coordinationAdapter, docKey);
        }
      }
    },
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
