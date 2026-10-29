/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { createPdfAnnotationStore } = require("../pdf-annotation-store.cjs");
const { canonicalJson, verify } = require("./canonical.cjs");
const { deriveDocumentIdentity, normalizeInitialPath, validateFullSourceHash } = require("./document-identity.cjs");
const { buildEffectiveState } = require("./effective-state.cjs");
const { joinOperations } = require("./merge-engine.cjs");
const { createSidecarStore } = require("./sidecar-store.cjs");
const { createWalStore } = require("./wal-store.cjs");
const { createWalWriterCoordinator } = require("./wal-writer-coordinator.cjs");
const { createRegistryCache } = require("./registry-cache.cjs");
const { createFormat3Importer } = require("./format3-importer.cjs");
const { createObsidianStorageBridge } = require("./obsidian-storage-bridge.cjs");
const { createJsonlCheckpointStore } = require("./jsonl-checkpoint.cjs");
const { createDeletionRetention } = require("./deletion-retention.cjs");
const { activateJsonlProtocol } = require("./protocol-barrier.cjs");
const { makeMainSnapshotCandidate, containsReceipts } = require("./main-snapshot-candidate.cjs");
const { createMainSnapshotStore } = require("./main-snapshot-store.cjs");
const { createStorageIo } = require("./io.cjs");
const { createMainRecoveryStore } = require("./main-snapshot-recovery.cjs");
const { createMainDeviceObservationStore } = require("./main-device-observation-store.cjs");
const { createMainRouteClaimStore } = require("./main-route-claim-store.cjs");
const { makeRetirementProposal } = require("./main-retirement-proposal.cjs");
const { createRetirementProposalStore } = require("./main-retirement-proposal-store.cjs");

const PROTOCOL = "wal-sidecar-v3.1";
const KINDS = new Set(["Highlight", "Underline", "Square", "Ink", "InkHighlight", "FreeText"]);
const EMPTY_JSONL_HEADER = Symbol("empty-jsonl-header");
const jsonlGenerationsByAdapter = new WeakMap();
const DISCOVERY_IO_CONCURRENCY = 4;
const DISCOVERY_VERIFY_CONCURRENCY = 8;

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  const errors = new Map();
  let next = 0;
  async function worker() {
    for (;;) {
      if (errors.size) return;
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { errors.set(index, error); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.size) throw errors.get(Math.min(...errors.keys()));
  return results;
}

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
  const mainSnapshots = jsonlMode ? createMainSnapshotStore({ adapter, root, hash: stableHash, token: uuid }) : null;
  const retirementProposals = jsonlMode ? createRetirementProposalStore({ adapter, root, hash: stableHash, token: uuid, snapshots: mainSnapshots }) : null;
  const mainSnapshotIo = jsonlMode ? createStorageIo({ adapter, hash, verifyHash, token: uuid }) : null;
  const mainRecovery = jsonlMode ? createMainRecoveryStore({ adapter, root, hash: stableHash, token: uuid, snapshots: mainSnapshots }) : null;
  const mainDeviceObservations = jsonlMode ? createMainDeviceObservationStore({ adapter, root, hash, identityHash: stableHash,
    verifyHash, deviceId, token: uuid, clock }) : null;
  const mainRouteClaims = jsonlMode ? createMainRouteClaimStore({ adapter, root, hash: stableHash, token: uuid, deviceId }) : null;
  const coordinator = createWalWriterCoordinator();
  const legacy = createPdfAnnotationStore({ adapter, root, hash, identityHash, deviceId, uuid, clock, ...legacyOptions });
  const importer = createFormat3Importer({ legacyStore: legacy, sidecarStore: sidecars, stableHash });
  const registry = createRegistryCache({ adapter, root, ensureDirectory });
  const documents = new Map();
  const receipts = new Map();
  const hotDocuments = new Map();
  let pendingSaveActivity = false;
  let saveActivityTask = null;
  let lastSaveActivityAt = null;
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

  function scheduleSaveActivity() {
    const observedAt = clock();
    if (!saveActivityTask && lastSaveActivityAt !== null && Number.isSafeInteger(observedAt) &&
        observedAt >= lastSaveActivityAt && observedAt - lastSaveActivityAt < 60_000) return;
    pendingSaveActivity = true;
    if (saveActivityTask) return;
    saveActivityTask = (async () => {
      let followupUsed = false;
      while (pendingSaveActivity) {
        pendingSaveActivity = false;
        try {
          await signalMainDeviceActivity();
          const publishedAt = clock();
          lastSaveActivityAt = Number.isSafeInteger(publishedAt) && publishedAt >= 0 ? publishedAt : null;
        }
        catch (error) {
          try { onTiming({ phase: "device-presence-error", code: error?.code || "UNKNOWN" }); } catch { /* Diagnostics cannot revoke a save. */ }
        }
        if (pendingSaveActivity && followupUsed) pendingSaveActivity = false;
        else if (pendingSaveActivity) followupUsed = true;
      }
    })().finally(() => {
      saveActivityTask = null;
      if (pendingSaveActivity) scheduleSaveActivity();
    });
  }

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
  function recoveredSequences(document, snapshots) {
    return snapshots.flatMap((entry) => [
      ...entry.value.segments.filter((segment) => segment.deviceId === deviceId).map((segment) => segment.lastSeq),
      ...entry.value.operations.filter((operation) => operation.version.deviceId === deviceId).map((operation) => operation.seq),
      ...(entry.value.receipts || []).filter((receipt) => receipt.deviceId === deviceId).map((receipt) => {
        const prefix = `${deviceId}:${document.docKey}:`;
        const suffix = receipt.opId.startsWith(prefix) ? receipt.opId.slice(prefix.length) : "";
        const seq = /^\d+$/.test(suffix) ? Number(suffix) : NaN;
        if (!Number.isSafeInteger(seq) || seq < 1) throw failure("MAIN_SNAPSHOT_INVALID", "Invalid recovery receipt sequence.");
        return seq;
      }),
    ]);
  }
  function localizeSeedOperations(document, operations, sequenceFloor = 0, removeOriginalRequest = false) {
    return operations.slice()
      .sort((left, right) => {
        const leftKey = left.type === "ROUTE_SET" ? "\uffffroute" : left.uuid;
        const rightKey = right.type === "ROUTE_SET" ? "\uffffroute" : right.uuid;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((operation, index) => {
        const seq = sequenceFloor + index + 1;
        if (!Number.isSafeInteger(seq)) throw failure("WAL_SEQ_REGRESSION", "Device sequence space exhausted.");
        // A recovery seed is a new synthetic operation, not a second receipt
        // for the original user request. The immutable snapshot retains that
        // request's original idempotency receipt.
        const { originOpId: _originalRequest, ...withoutRequest } = operation;
        const seed = removeOriginalRequest ? withoutRequest : operation;
        return { ...seed, seq, opId: `${deviceId}:${document.docKey}:${seq}`,
          version: { rev: operation.version?.rev || 1, deviceId, seq } };
      });
  }
  async function collectDurableReceipts(loaded) {
    const receipts = [...(loaded.recovery?.records || []).map((item) => item.current), ...(loaded.mainSnapshotCandidates || [])]
      .flatMap((entry) => entry.value.receipts || []);
    for (const operation of [
      ...loaded.valid.flatMap((wal) => [...wal.anchor.operations, ...wal.tail]),
      ...loaded.jsonlAnchors.flatMap((entry) => entry.anchor.operations),
      ...loaded.jsonlArchives.flatMap((entry) => entry.archive.operations),
      ...loaded.jsonlRows.flatMap((entry) => entry.operations),
    ]) {
      if (!operation.originOpId || !operation.uuid) continue;
      const { seq: _seq, version: _version, opId: _opId, deletedAt: _deletedAt, ...input } = operation;
      receipts.push({ deviceId: operation.version.deviceId, uuid: operation.uuid, originOpId: operation.originOpId,
        opId: operation.opId, inputHash: await stableHash(new TextEncoder().encode(canonicalJson(input))), version: operation.version,
        ...(operation.deletedAt === undefined ? {} : { deletedAt: operation.deletedAt }) });
    }
    return receipts;
  }
  async function ensureOwnJsonlBaseline(document) {
    const loaded = await readEffective(document);
    if (!loaded.document) throw failure("WAL_DOCUMENT_MISSING", "The document baseline is unavailable for JSONL migration.");
    if (loaded.errors.length || loaded.sidecarError) throw failure("WAL_SYNC_PENDING", "An incomplete document shard blocks JSONL baseline migration.");
    const hasOwnContribution =
      (loaded.jsonlAnchors || []).some((entry) => entry.deviceId === deviceId) ||
      (loaded.jsonlArchives || []).some((entry) => entry.deviceId === deviceId) ||
      (loaded.jsonlRows || []).some((entry) => entry.deviceId === deviceId && entry.operations.length > 0);
    if (hasOwnContribution) return loaded.document;
    const sequenceFloor = Math.max(0, ...recoveredSequences(loaded.document,
      [...(loaded.recovery?.records || []).map((entry) => entry.current), ...(loaded.mainSnapshotCandidates || [])]));
    const hasCheckpointReceipts = Boolean(loaded.recovery?.records?.length || loaded.mainSnapshotCandidates?.length);
    const seeded = localizeSeedOperations(loaded.document, opsFor(loaded.state), sequenceFloor, hasCheckpointReceipts);
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
    // A verified immutable main checkpoint already provides the baseline.
    // Concurrent devices must not race over the shared derived cache's fixed
    // .pending path while establishing their separate owner anchors.
    if (!hasCheckpointReceipts) await jsonlCheckpoints.writeSnapshot(loaded.document, loaded.state, watermarks);
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
  async function readJsonlHeader(path, reader = adapter) {
    const text = await reader.read(path);
    if (path.endsWith(".jsonl")) {
      if (text === "") return EMPTY_JSONL_HEADER;
      const newline = text.indexOf("\n");
      if (newline < 0) return null;
      return JSON.parse(text.slice(0, newline));
    }
    return JSON.parse(text);
  }
  async function discover({ allowPartial = false, protectedPath = null, protectedIdentity = null } = {}) {
    const scanGeneration = routingGeneration;
    const keys = new Map();
    let unknownCheckpointHeader = false;
    // Reuse reads only inside this read-only discovery. No cache survives a
    // scan or an external sync event, and no cached value authorizes a write.
    const cached = { read: new Map(), exists: new Map(), list: new Map() };
    const listedChildren = new Map();
    const scanAdapter = new Proxy(adapter, { get(target, key) {
      const value = target[key];
      if (typeof value !== "function") return value;
      if (!Object.hasOwn(cached, key)) return value.bind(target);
      return (path) => {
        if (key === "exists") {
          const separator = path.lastIndexOf("/");
          const parent = separator < 0 ? "" : path.slice(0, separator);
          const children = listedChildren.get(parent);
          if (children) return Promise.resolve(children.has(path));
        }
        if (!cached[key].has(path)) cached[key].set(path, Promise.resolve().then(() => value.call(target, path)).then((result) => {
          if (key === "list" && Array.isArray(result?.files) && Array.isArray(result?.folders)) {
            const absolute = (entry) => entry.startsWith(`${path}/`) ? entry : `${path}/${entry}`;
            listedChildren.set(path, new Set([...result.files, ...result.folders].map(absolute)));
          }
          return result;
        }));
        return cached[key].get(path);
      };
    } });
    const scanList = async (path) => {
      if (!(await scanAdapter.exists(path))) return { files: [], folders: [] };
      const rows = await scanAdapter.list(path);
      const absolute = (entry) => entry.startsWith(`${path}/`) ? entry : `${path}/${entry}`;
      return { files: rows.files.map(absolute), folders: rows.folders.map(absolute) };
    };
    const scanSidecars = createSidecarStore({ adapter: scanAdapter, root, hash, verifyHash, token: uuid });
    const scanWals = createWalStore({ adapter: scanAdapter, root, hash, verifyHash, deviceId, token: uuid, sidecarStore: scanSidecars });
    const scanJsonl = jsonlMode ? createObsidianStorageBridge({ adapter: scanAdapter, root, hash, verifyHash }) : null;
    const scanCheckpoints = jsonlMode ? createJsonlCheckpointStore({ adapter: scanAdapter, root, hash, verifyHash, token: uuid }) : null;
    const scanIo = jsonlMode ? createStorageIo({ adapter: scanAdapter, hash, verifyHash, token: uuid }) : null;
    const scanMainSnapshots = jsonlMode ? createMainSnapshotStore({ adapter: scanAdapter, root, hash: stableHash, token: uuid }) : null;
    const scanRecovery = jsonlMode ? createMainRecoveryStore({ adapter: scanAdapter, root, hash: stableHash, token: uuid, snapshots: scanMainSnapshots }) : null;
    const scan = { adapter: scanAdapter, list: scanList, sidecars: scanSidecars, wals: scanWals,
      jsonl: scanJsonl, checkpoints: scanCheckpoints, recovery: scanRecovery, mainSnapshots: scanMainSnapshots };
    if (scanMainSnapshots) {
      const directories = (await scanList(`${root}/main-snapshots`)).folders.sort();
      const entries = await mapLimit(directories, DISCOVERY_IO_CONCURRENCY, async (directory) => {
        const docKey = directory.slice(directory.lastIndexOf("/") + 1);
        if (!/^[a-f0-9]{12}$/.test(docKey)) return [];
        return (await scanList(directory)).files.sort().filter((path) => /\/[a-f0-9]{64}\.json(?:\.gc-[A-Za-z0-9_-]+|\.pending(?:-[A-Za-z0-9_-]+)?)?$/.test(path))
          .map((path) => ({ path, docKey }));
      });
      const hints = await mapLimit(entries.flat(), DISCOVERY_IO_CONCURRENCY, async ({ path, docKey }) => {
        const pending = /\/([a-f0-9]{64})\.json\.pending-[A-Za-z0-9_-]+$/.exec(path);
        if (/\.json\.(?:gc-|pending)/.test(path) && !pending) return null;
        try {
          const raw = await scanAdapter.read(path);
          const row = JSON.parse(raw)?.value;
          if (pending) {
            const finalPath = path.slice(0, path.lastIndexOf(".pending-"));
            if (raw !== await scanAdapter.read(finalPath) || row?.docKey !== docKey || !row?.documentId || !row?.sourceHash ||
              !await scanMainSnapshots.read({ ...identityOnly(row), source: { sourceHash: row.sourceHash } }, `sha256-v1:${pending[1]}`)) return null;
          }
          if (row?.docKey === docKey && typeof row.documentId === "string" && row.documentId) return identityOnly(row);
        } catch { /* Unverified snapshot headers are discovery hints only. */ }
        return null;
      });
      unknownCheckpointHeader ||= hints.some((row) => !row);
      for (const row of hints) {
        if (row) keys.set(`${row.docKey}:${row.documentId}`, row);
      }
    }
    // Recovery certificates survive intentional archive cleanup and are also
    // discovery hints when the rebuildable registry or owner logs are lost.
    if (mainRecovery) {
      const directories = (await scanList(`${root}/main-recovery`)).folders.sort();
      const entries = await mapLimit(directories, DISCOVERY_IO_CONCURRENCY, async (directory) =>
        (await scanList(directory)).files.sort().filter((path) => /\/[a-f0-9]{64}\.json(?:\.gc-[A-Za-z0-9_-]+|\.pending(?:-[A-Za-z0-9_-]+)?)?$/.test(path)));
      const hints = await mapLimit(entries.flat(), DISCOVERY_IO_CONCURRENCY, async (path) => {
        if (/\.json\.(?:gc-|pending)/.test(path) && !(await scanIo.verifiedDuplicateStage(path))) return null;
        try {
          const row = JSON.parse(await scanAdapter.read(path));
          if (/^[a-f0-9]{12}$/.test(row.docKey || "") && typeof row.documentId === "string") return identityOnly(row);
        } catch { /* Only readEffective can authorize a discovered identity. */ }
        return null;
      });
      unknownCheckpointHeader ||= hints.some((row) => !row);
      for (const row of hints) {
        if (row) keys.set(`${row.docKey}:${row.documentId}`, row);
      }
    }
    const [sidecarListing, walListing] = await mapLimit([
      `${root}/sidecars`, `${root}/wal`,
    ], 2, (directory) => scanList(directory));
    const paths = sidecarListing.files
      .filter((candidate) => /\.annot\.json(?:\.pending(?:-[A-Za-z0-9_-]+)?)?$/.test(candidate)).sort();
    const directoryResults = await mapLimit(walListing.folders.slice().sort(), DISCOVERY_IO_CONCURRENCY,
      async (directory) => {
        const files = (await scanList(directory)).files.slice().sort();
        const jsonlCandidates = jsonl ? files.filter((candidate) =>
          /\/[a-f0-9]{12}\.jsonl(?:\.anchor\.json(?:\.pending)?|\.archive\.\d+-\d+\.json)?$/.test(candidate)) : [];
        // Only v3.1 WALs have this exact basename. JSONL archive, anchor and
        // retention files have their own readers and are not legacy WALs.
        return { paths: files.filter((candidate) => /\/[a-f0-9]{12}\.json(?:\.pending)?$/i.test(candidate)),
          jsonlCandidates, pendingArchives: files.filter((candidate) =>
            /\/[a-f0-9]{12}\.jsonl\.archive\.\d+-\d+\.json\.pending(?:-[A-Za-z0-9_-]+)?$/.test(candidate)),
          pendingWals: files.filter((candidate) => /\/[a-f0-9]{12}\.jsonl\.pending$/.test(candidate)) };
      });
    const pendingWalStates = await mapLimit(directoryResults.flatMap((directory) => directory.pendingWals),
      DISCOVERY_IO_CONCURRENCY, async (path) => {
        try { return (await scanAdapter.read(path)).length > 0; }
        catch { return true; }
      });
    const jsonlCandidates = directoryResults.flatMap((directory) => directory.jsonlCandidates);
    const headers = await mapLimit(jsonlCandidates, DISCOVERY_IO_CONCURRENCY, async (candidate) => {
      try { return await readJsonlHeader(candidate, scanAdapter); }
      catch { return null; } // A JSONL header is only a hint; readEffective validates the record.
    });
    const unknownJsonlHeader = headers.some((header) => header !== EMPTY_JSONL_HEADER &&
      (!header || !/^[a-f0-9]{12}$/.test(header.docKey || "") || typeof header.documentId !== "string" || !header.documentId));
    for (const directory of directoryResults) {
      paths.push(...directory.paths);
    }
    for (const header of headers) {
      if (/^[a-f0-9]{12}$/.test(header?.docKey || "") && typeof header.documentId === "string") {
        keys.set(`${header.docKey}:${header.documentId}`, identityOnly(header));
      }
    }
    paths.sort();
    const verifiedPaths = await mapLimit(paths, DISCOVERY_VERIFY_CONCURRENCY, async (path) => {
      // Headers are discovery hints only; readEffective verifies all envelopes.
      try {
        const value = JSON.parse(await scanAdapter.read(path));
        const header = value.document || value;
        if (!/^[a-f0-9]{12}$/.test(header.docKey || "") || typeof header.documentId !== "string") return null;
        let verified;
        if (verifyHash) {
          const { integrity, ...unsigned } = value;
          if (typeof integrity !== "string" || !await verifyHash(new TextEncoder().encode(canonicalJson(unsigned)), integrity)) return null;
          verified = unsigned;
        } else verified = await verify(value, hash);
        if (path.startsWith(`${root}/sidecars/`)) sidecars.validateSidecar(verified, header);
        else wals.validateWal(verified, header, path.slice(`${root}/wal/`.length).split("/")[0]);
        return identityOnly(header);
      } catch { return null; /* Unverified headers are discovery hints, never authority. */ }
    });
    for (const identity of verifiedPaths) {
      if (identity) keys.set(`${identity.docKey}:${identity.documentId}`, identity);
    }
    const result = [];
    const verifiedKeys = new Map();
    const candidates = [...keys.values()];
    // Discovery is read-only: tail repair belongs to the subsequent document
    // read, so candidate verification can overlap without concurrent repairs.
    const states = await mapLimit(candidates, DISCOVERY_IO_CONCURRENCY, async (candidate) => {
      try { return await readEffective(candidate, { readOnly: true, scan }); }
      catch (error) { if (["VERSION_COLLISION", "DOC_KEY_COLLISION"].includes(error.code)) throw error; return null; }
    });
    // A partial document may have a route that has not arrived yet. Publishing
    // a replacement index from incomplete evidence can erase that route or
    // allow registration of a second identity for the same source path.
    // An unreadable canonical sidecar may be the only remaining evidence for
    // another document. Its identity cannot be safely inferred from a broken
    // header, so it must prevent publication of a supposedly complete index.
    const unknownCanonicalSidecar = paths.some((path, index) =>
      /\.annot\.json(?:\.pending-[A-Za-z0-9_-]+)?$/.test(path) && !verifiedPaths[index]);
    const archiveStageChecks = await mapLimit(directoryResults.flatMap((directory) => directory.pendingArchives),
      DISCOVERY_IO_CONCURRENCY, async (path) => {
        if (await scanIo.verifiedDuplicateStage(path)) return true;
        for (const state of states) {
          if (await coveredArchiveStage(path, scanAdapter, state?.recovery)) return true;
        }
        return false;
      });
    const incomplete = unknownCheckpointHeader || unknownJsonlHeader || unknownCanonicalSidecar || pendingWalStates.some(Boolean) ||
      archiveStageChecks.some((valid) => !valid) ||
      states.some((loaded) => !loaded?.document || loaded.sidecarError || loaded.errors?.length);
    if (incomplete && !allowPartial) throw failure("WAL_SYNC_PENDING", "Incomplete document data prevents a verified registry rebuild.");
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const loaded = states[index];
      if (loaded?.document) {
        const prior = verifiedKeys.get(candidate.docKey);
        if (prior && prior !== candidate.documentId) throw failure("DOC_KEY_COLLISION", "Verified records assign this docKey to different full identities.");
        verifiedKeys.set(candidate.docKey, candidate.documentId);
        documents.set(loaded.document.documentId, loaded.document);
        result.push(loaded.document);
      }
    }
    // Never publish or return a route scan if a sync event arrived while the
    // scan was reading its per-call cache; that view may already be stale.
    if (routingGeneration !== scanGeneration) throw failure("WAL_SYNC_PENDING", "Routing changed during discovery; retry after synchronization.");
    if (protectedPath && !result.some((document) => document.sourcePath === protectedPath ||
        (protectedIdentity && document.docKey === protectedIdentity.docKey && document.documentId === protectedIdentity.documentId))) {
      throw failure("WAL_SYNC_PENDING", "An indexed route has no verified backing state; wait for synchronization.");
    }
    if (incomplete) {
      Object.defineProperty(result, "incomplete", { value: true });
      return result;
    }
    // Best effort cache writes cannot turn a durable WAL commit into failure.
    try { await registry.replace(result); } catch (error) {
      if (error.code === "IDENTITY_ROUTE_CONFLICT") throw error;
      onTiming({ phase: "registry-cache", code: error.code || "CACHE_WRITE_FAILED" });
    }
    if (routingGeneration !== scanGeneration) throw failure("WAL_SYNC_PENDING", "Routing changed while publishing discovery; retry after synchronization.");
    verifiedRoutingGeneration = scanGeneration;
    return result;
  }

  async function coveredArchiveStage(path, reader, recovery) {
    const marker = path.lastIndexOf(".pending-");
    if (marker < 0 || recovery?.errors?.length) return false;
    const original = path.slice(0, marker);
    const evidence = (recovery?.records || []).flatMap((entry) => entry.record.archives)
      .filter((archive) => archive.path === original);
    if (!evidence.length) return false;
    try {
      const digest = await stableHash(new TextEncoder().encode(await reader.read(path)));
      return evidence.some((archive) => archive.digest === digest);
    } catch { return false; }
  }

  async function readEffective(document, { readOnly = false, scan = null } = {}) {
    const start = monotonic();
    const reader = scan?.adapter || adapter;
    const readList = scan?.list || list;
    const readSidecars = scan?.sidecars || sidecars;
    const readWals = scan?.wals || wals;
    const readJsonl = scan?.jsonl || jsonl;
    const readCheckpoints = scan?.checkpoints || jsonlCheckpoints;
    const readRecovery = scan?.recovery || mainRecovery;
    const readMainSnapshots = scan?.mainSnapshots || mainSnapshots;
    const recovery = readRecovery ? await readRecovery.read(document) : { records: [], errors: [] };
    const recoveryOperations = recovery.records.flatMap((entry) => entry.current.value.operations);
    const recoveredArchives = new Set(recovery.records.flatMap((entry) => entry.record.archives.map((archive) => archive.path)));
    let sidecar = null;
    let sidecarError = null;
    try { sidecar = await readSidecars.loadSidecar(document); } catch (error) { sidecarError = error; }
    if (sidecarError?.code === "DOC_KEY_COLLISION") throw sidecarError;
    const loadedWals = await readWals.loadWals(document);
    const valid = loadedWals.valid.map((entry) => entry.wal || entry);
    const errors = [...loadedWals.errors, ...recovery.errors];
    if (errors.some((error) => error.code === "DOC_KEY_COLLISION")) throw failure("DOC_KEY_COLLISION", "Verified WAL records assign this key to another full document identity.");
    const jsonlRows = [];
    const jsonlAnchors = [];
    const jsonlArchives = [];
    const gcStages = [];
    const jsonlSources = new Set();
    if (jsonl) {
      for (const directory of (await readList(`${root}/wal`)).folders) {
        const owner = directory.slice(`${root}/wal/`.length);
        if (!owner || owner.includes("/") || owner.includes("\\")) continue;
        const path = readJsonl.pathsFor(document.docKey, owner).wal;
        const anchorPath = readCheckpoints.anchorPath(document, owner);
        const directoryFiles = (await readList(directory)).files;
        if (directoryFiles.includes(`${path}.pending`)) {
          let unsettled = true;
          try { unsettled = (await reader.read(`${path}.pending`)).length > 0; } catch { /* Preserve unreadable pending data. */ }
          if (unsettled) errors.push({ deviceId: owner, path: `${path}.pending`, code: "WAL_SYNC_PENDING",
            message: "An unpublished WAL replacement requires recovery." });
        }
        if (directoryFiles.includes(anchorPath) && directoryFiles.includes(`${anchorPath}.pending`)) {
          errors.push({ deviceId: owner, path: `${anchorPath}.pending`, code: "WAL_SYNC_PENDING",
            message: "An unpublished anchor update requires recovery." });
        }
        const pendingArchive = new RegExp(`/${document.docKey}\\.jsonl\\.archive\\.\\d+-\\d+\\.json\\.pending(?:-[A-Za-z0-9_-]+)?$`);
        for (const candidate of directoryFiles.filter((item) => pendingArchive.test(item))) {
          const readerIo = scan ? createStorageIo({ adapter: reader, hash, verifyHash, token: uuid }) : mainSnapshotIo;
          if (await readerIo.verifiedDuplicateStage(candidate) || await coveredArchiveStage(candidate, reader, recovery)) continue;
          errors.push({ deviceId: owner, path: candidate, code: "WAL_SYNC_PENDING",
            message: "An unpublished archive requires recovery." });
        }
        const gcStage = new RegExp(`/${document.docKey}\\.jsonl\\.archive\\.\\d+-\\d+\\.json\\.gc-[A-Za-z0-9_-]+$`);
        for (const candidate of directoryFiles.filter((item) => gcStage.test(item))) {
          gcStages.push(candidate);
          const originalPath = candidate.slice(0, candidate.lastIndexOf(".gc-"));
          const evidence = recovery.records.flatMap((entry) => entry.record.archives).find((item) => item.path === originalPath);
          let matches = false;
          try { matches = Boolean(evidence && await stableHash(new TextEncoder().encode(await reader.read(candidate))) === evidence.digest); }
          catch { /* An unreadable staged file cannot be treated as safely covered. */ }
          if (!matches) errors.push({ deviceId: owner, path: candidate, code: "MAIN_RECOVERY_PENDING",
            message: "An interrupted or conflicting archive cleanup requires recovery." });
        }
        const files = directoryFiles.filter((candidate) =>
          candidate.endsWith(`/${document.docKey}.jsonl`) ||
          candidate.endsWith(`/${document.docKey}.jsonl.anchor.json`) ||
          new RegExp(`/${document.docKey}\\.jsonl\\.archive\\.\\d+-\\d+\\.json$`).test(candidate));
        const sourceHashes = new Set();
        for (const candidatePath of files) {
          try {
            const header = await readJsonlHeader(candidatePath, reader);
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
          for (const archived of await readCheckpoints.loadArchives(jsonlDocument, owner)) {
            jsonlArchives.push({ deviceId: owner, ...archived });
          }
        } catch (error) {
          errors.push({ deviceId: owner, path: directory, code: error?.code || "WAL_JSONL_ARCHIVE_INVALID",
            message: String(error?.message || error) });
        }
        if (await reader.exists(anchorPath) || await reader.exists(`${anchorPath}.pending`)) {
          try {
            const anchor = await readCheckpoints.readAnchor(jsonlDocument, owner);
            if (anchor) {
              jsonlAnchors.push({ deviceId: owner, path: anchorPath, anchor });
              for (const reference of anchor.archives) {
                if (!jsonlArchives.some((entry) => entry.path === reference.path) && !recoveredArchives.has(reference.path)) {
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
        if (!(await reader.exists(path))) continue;
        try {
          const rows = await readJsonl.readOperationRows(jsonlDocument, owner,
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
    const priorState = buildEffectiveState({ sidecar,
      anchors: [recoveryOperations, ...valid.map((wal) => wal.anchor), ...jsonlAnchors.map((entry) => entry.anchor.operations),
        ...jsonlArchives.map((entry) => entry.archive.operations)],
      tails: [...valid.map((wal) => wal.tail), ...jsonlRows.map((entry) => entry.operations)] });
    const mainSnapshotCandidates = [];
    if (readMainSnapshots) {
      for (const path of (await readList(`${root}/main-snapshots/${document.docKey}`)).files.sort()) {
        const pendingMatch = /\/([a-f0-9]{64})\.json\.pending-[A-Za-z0-9_-]+$/.exec(path);
        if (pendingMatch) {
          // A verified final snapshot makes an identical retained stage a
          // redundant copy. Different, missing or unreadable bytes stay pending.
          try {
            const finalPath = path.slice(0, path.lastIndexOf(".pending-"));
            const stageBytes = await reader.read(path);
            const finalBytes = await reader.read(finalPath);
            const header = JSON.parse(finalBytes)?.value;
            const sourceHash = validateFullSourceHash(header?.sourceHash);
            if (document.source?.sourceHash && document.source.sourceHash !== sourceHash) throw failure("SOURCE_MISMATCH", "Checkpoint belongs to another PDF source.");
            const candidateDocument = { ...document, source: { ...(document.source || {}), sourceHash } };
            if (stageBytes === finalBytes && await readMainSnapshots.read(candidateDocument, `sha256-v1:${pendingMatch[1]}`)) continue;
          } catch { /* Fail closed below. */ }
          errors.push({ path, code: "MAIN_RECOVERY_PENDING", message: "Checkpoint staging is not covered by a verified final snapshot." });
          continue;
        }
        if (/\/[a-f0-9]{64}\.json\.(?:gc-[A-Za-z0-9_-]+|pending)$/.test(path)) {
          errors.push({ path, code: "MAIN_RECOVERY_PENDING", message: "Interrupted checkpoint operation requires recovery." });
          continue;
        }
        const match = /\/([a-f0-9]{64})\.json$/.exec(path);
        if (!match) continue;
        try {
          const header = JSON.parse(await reader.read(path))?.value;
          if (header?.docKey !== document.docKey || header?.documentId !== document.documentId) {
            throw failure("DOC_KEY_COLLISION", "Checkpoint belongs to another document identity.");
          }
          const sourceHash = validateFullSourceHash(header.sourceHash);
          if (document.source?.sourceHash && document.source.sourceHash !== sourceHash) {
            throw failure("SOURCE_MISMATCH", "Checkpoint belongs to another PDF source.");
          }
          const candidate = await readMainSnapshots.read({ ...document, source: { ...(document.source || {}), sourceHash } }, `sha256-v1:${match[1]}`);
          if (!candidate) throw failure("MAIN_SNAPSHOT_MISSING", "Checkpoint disappeared while loading.");
          jsonlSources.add(sourceHash);
          mainSnapshotCandidates.push(candidate);
        } catch (error) {
          if (error.code === "DOC_KEY_COLLISION") throw error;
          errors.push({ path, code: error.code || "MAIN_SNAPSHOT_CORRUPT", message: String(error.message || error) });
        }
      }
    }
    const hasOtherState = Boolean(sidecar || valid.length || jsonlRows.length || jsonlAnchors.length || jsonlArchives.length || recovery.records.length);
    // A synthetic recovery seed intentionally omits originOpId: the original
    // request is retained separately in checkpoint receipts. It is not a
    // semantic annotation change and must not make a different device's seed
    // appear to omit an otherwise identical checkpoint branch.
    const semanticWinners = (value) => opsFor(value).map(({ seq, opId, originOpId, version, deletedAt, ...operation }) => operation)
      .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    const coveredCandidates = hasOtherState ? mainSnapshotCandidates.filter((candidate) =>
      canonicalJson(semanticWinners(joinOperations(opsFor(priorState), candidate.value.operations))) ===
      canonicalJson(semanticWinners(priorState))) : mainSnapshotCandidates;
    if (coveredCandidates.length !== mainSnapshotCandidates.length) {
      errors.push({ path: `${root}/main-snapshots/${document.docKey}`, code: "MAIN_SNAPSHOT_SYNC_PENDING",
        message: "Checkpoint contains a branch not yet present in verified logs." });
    }
    const state = buildEffectiveState({ sidecar,
      anchors: [recoveryOperations, ...coveredCandidates.map((entry) => entry.value.operations),
        ...valid.map((wal) => wal.anchor), ...jsonlAnchors.map((entry) => entry.anchor.operations),
        ...jsonlArchives.map((entry) => entry.archive.operations)],
      tails: [...valid.map((wal) => wal.tail), ...jsonlRows.map((entry) => entry.operations)] });
    if (jsonlSources.size > 1) errors.push({ path: `${root}/main-snapshots/${document.docKey}`, code: "SOURCE_MISMATCH",
      message: "Checkpoint and log sources differ." });
    const routing = state.routing?.payload || {};
    const metadata = sidecar?.document || valid.find((wal) => wal.document)?.document ||
      (routing.sourcePath ? { ...identityOnly(document), initialPath: routing.initialPath || routing.sourcePath,
        sourcePath: routing.sourcePath, source: routing.source || { sourceHash: routing.sourceHash },
        legacyIdentities: routing.legacyIdentities || [],
        legacyIdentityScanComplete: routing.legacyIdentityScanComplete === true } : null);
    if (!hasOtherState && !mainSnapshotCandidates.length) {
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
    const result = { document: resolved, state, sidecar, valid, jsonlRows, jsonlAnchors, jsonlArchives, gcStages, recovery, mainSnapshotCandidates,
      errors, sidecarError };
    onTiming({ phase: "wal-effective-state", docKey: document.docKey, elapsedMs: monotonic() - start,
      validShards: valid.length, invalidShards: errors.length, sidecarRecovered: Boolean(sidecarError) });
    return result;
  }

  async function documentForPath(sourcePath) {
    const path = normalizeInitialPath(sourcePath);
    const lookupGeneration = routingGeneration;
    // Read the lightweight registry first. A cold or invalidated process must
    // still establish route completeness before this hint can be authoritative.
    const indexed = await registry.lookup(path);
    let claimsPending = false;
    const claimedRoutes = new Map();
    if (mainRouteClaims) {
      try {
        const evidence = await mainRouteClaims.query(path);
        claimsPending = evidence.errors.length > 0;
        for (const row of evidence.claims) {
          const key = canonicalJson([row.docKey, row.documentId]);
          if (!claimedRoutes.has(key)) claimedRoutes.set(key, []);
          claimedRoutes.get(key).push(row.route);
        }
      } catch { claimsPending = true; }
    }
    const activeClaims = [...claimedRoutes.entries()].filter(([, operations]) =>
      joinOperations(operations).routing?.payload?.sourcePath === path).map(([key]) => key);
    const indexedKey = indexed && canonicalJson([indexed.docKey, indexed.documentId]);
    const conflictingClaims = activeClaims.some((key) => key !== indexedKey);
    const hint = !claimsPending && !conflictingClaims && verifiedRoutingGeneration === lookupGeneration && lookupGeneration === routingGeneration ? indexed : null;
    if (hint) {
      try {
        const verified = await readEffective(hint);
        if (lookupGeneration === routingGeneration && verified.document?.sourcePath === path &&
            !verified.errors?.length && !verified.sidecarError) return verified.document;
      } catch (error) { if (error.code === "VERSION_COLLISION") throw error; }
    }
    const discovered = await discover({ allowPartial: true, protectedPath: indexed ? path : null, protectedIdentity: indexed });
    const matches = discovered.filter((doc) => doc.sourcePath === path);
    if (lookupGeneration !== routingGeneration) throw failure("WAL_SYNC_PENDING", "Routing changed while the path was being checked.");
    if (discovered.incomplete && !matches.length) throw failure("WAL_SYNC_PENDING", "Incomplete routing data cannot establish a new identity.");
    if (matches.length > 1) throw failure("IDENTITY_ROUTE_CONFLICT", "Multiple documents route to this PDF.");
    const matchedKey = matches[0] && canonicalJson([matches[0].docKey, matches[0].documentId]);
    if (claimsPending || activeClaims.some((key) => key !== matchedKey)) {
      throw failure("WAL_SYNC_PENDING", "A path claim is incomplete or conflicts with the verified route.");
    }
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
    if (effective.errors.length || effective.sidecarError) throw failure("WAL_SYNC_PENDING", "A WAL shard or sidecar is incomplete or invalid; editing is paused.");
    const own = await wals.readWal(document) || newWal(effective.document);
    const ownJsonl = effective.jsonlRows?.find((entry) => entry.deviceId === deviceId);
    const ownAnchor = effective.jsonlAnchors?.find((entry) => entry.deviceId === deviceId);
    const ownArchives = effective.jsonlArchives?.filter((entry) => entry.deviceId === deviceId) || [];
    const recoverySequences = recoveredSequences(document, [...(effective.recovery?.records || []).map((entry) => entry.current),
      ...(effective.mainSnapshotCandidates || [])]);
    own.nextSeq = Math.max(own.nextSeq, (ownJsonl?.operations.at(-1)?.seq || 0) + 1,
      (ownAnchor?.anchor.throughSeq || 0) + 1,
      ...ownArchives.map((entry) => entry.archive.lastSeq + 1),
      ...recoverySequences.map((seq) => seq + 1));
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
      const durableReceipts = new Map();
      for (const entry of [...(effective.recovery?.records || []).map((item) => item.current), ...(effective.mainSnapshotCandidates || [])]) {
        for (const receipt of entry.value.receipts || []) {
          const key = canonicalJson([receipt.deviceId, receipt.uuid, receipt.originOpId]);
          const prior = durableReceipts.get(key);
          if (prior && !containsReceipts({ receipts: [prior] }, { receipts: [receipt] }) &&
              !containsReceipts({ receipts: [receipt] }, { receipts: [prior] })) {
            throw failure("WAL_OPERATION_COLLISION", "Recovery records contain conflicting input receipts.");
          }
          if (!prior || containsReceipts({ receipts: [receipt] }, { receipts: [prior] })) durableReceipts.set(key, receipt);
        }
      }
      const appendedByOrigin = new Map();
      if (!useCache) {
        for (const operation of [
          ...(effective.recovery?.records || []).flatMap((entry) => entry.current.value.operations),
          ...(effective.mainSnapshotCandidates || []).flatMap((entry) => entry.value.operations),
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
        const recoveredReceipt = input.originOpId && input.uuid &&
          durableReceipts.get(canonicalJson([deviceId, input.uuid, input.originOpId]));
        if (recoveredReceipt) {
          const inputHash = await stableHash(new TextEncoder().encode(canonicalJson(input)));
          if (inputHash !== recoveredReceipt.inputHash) {
            throw failure("WAL_OPERATION_COLLISION", "An acknowledged input ID names different content.");
          }
          acknowledgedOpId = recoveredReceipt.opId;
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
    if (jsonl && result.operationCount > 0) {
      // Activity publication is secondary evidence. Never delay or undo a
      // durable annotation ACK if this independent background write fails.
      scheduleSaveActivity();
    }
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
    const updated = await updateMetadata(prior, { sourcePath: normalizeInitialPath(toPath) });
    if (mainRouteClaims) {
      try {
        const state = await readEffective(updated, { readOnly: true });
        if (!state.errors.length && state.state.routing) {
          for (const indexedPath of [normalizeInitialPath(fromPath), updated.sourcePath]) {
            await mainRouteClaims.publish({ indexedPath, document: updated, route: state.state.routing });
          }
        }
      } catch (error) {
        // Route claims are rebuildable hints. A durable rename must not be
        // reported as failed merely because the secondary index failed.
        onTiming({ phase: "main-route-claim", code: error.code || "CLAIM_WRITE_FAILED" });
      }
    }
    return updated;
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
      { readOnly: readOnly || loaded.errors.length > 0 || Boolean(loaded.sidecarError) }) : { tombstones: loaded.state.tombstones, deletionGuards: [] };
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
        for (const entry of loaded.recovery?.records || []) {
          for (const segment of entry.current.value.segments) maximum.set(segment.deviceId,
            Math.max(maximum.get(segment.deviceId) || 0, segment.lastSeq));
          for (const op of entry.current.value.operations) maximum.set(op.version.deviceId,
            Math.max(maximum.get(op.version.deviceId) || 0, op.seq));
        }
        for (const entry of loaded.mainSnapshotCandidates || []) {
          for (const segment of entry.value.segments) maximum.set(segment.deviceId,
            Math.max(maximum.get(segment.deviceId) || 0, segment.lastSeq));
          for (const op of entry.value.operations) maximum.set(op.version.deviceId,
            Math.max(maximum.get(op.version.deviceId) || 0, op.seq));
        }
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
      ...(loaded.errors.length || loaded.sidecarError ? { syncPending: true } : {}) };
  }
  // Explicit candidate publication only. It is not yet used for hydration or
  // garbage collection; all existing WAL and archive recovery remains in force.
  async function createMainCheckpoint(document, { forceRecovery = false } = {}) {
    if (!mainSnapshots) throw failure("MAIN_SNAPSHOT_UNAVAILABLE", "JSONL storage is required.");
    if (document.sourceMismatch) throw failure("SOURCE_MISMATCH", "A changed PDF cannot be checkpointed.");
    return queued(document.docKey, async () => {
      const loaded = await readEffective(document, { readOnly: true });
      if (!loaded.document) throw failure("WAL_DOCUMENT_MISSING", "Document recovery state is unavailable.");
      if (loaded.errors.length || loaded.sidecarError) {
        if (loaded.errors.some((entry) => entry.code === "MAIN_SNAPSHOT_SYNC_PENDING")) {
          throw failure("MAIN_SNAPSHOT_SYNC_PENDING", "A checkpoint branch has not arrived in verified logs.");
        }
        throw failure("WAL_SYNC_PENDING", "All referenced records must verify before publishing a candidate.");
      }
      const segments = [];
      const seenSegments = new Map();
      for (const entry of [...(loaded.recovery?.records || []).map((item) => item.current), ...(loaded.mainSnapshotCandidates || [])]) {
        for (const segment of entry.value.segments) {
          const key = `${segment.deviceId}:${segment.firstSeq}:${segment.lastSeq}`;
          const prior = seenSegments.get(key);
          if (prior && prior.digest !== segment.digest) throw failure("MAIN_RECOVERY_INVALID", "Recovered segment conflict.");
          if (!prior) { seenSegments.set(key, segment); segments.push(segment); }
        }
      }
      for (const entry of loaded.jsonlArchives || []) {
        const raw = await adapter.read(entry.path);
        let reread;
        try { reread = JSON.parse(raw); } catch { throw failure("WAL_SYNC_PENDING", "Archive changed while checkpointing."); }
        const { integrity, ...unsigned } = reread;
        if (typeof integrity !== "string" || canonicalJson(unsigned) !== canonicalJson(entry.archive)) {
          throw failure("WAL_SYNC_PENDING", "Archive changed while checkpointing.");
        }
        const valid = verifyHash
          ? await verifyHash(new TextEncoder().encode(canonicalJson(unsigned)), integrity)
          : Boolean(await verify(reread, hash));
        if (!valid) throw failure("WAL_SYNC_PENDING", "Archive integrity changed while checkpointing.");
        const bytes = new TextEncoder().encode(raw);
        const digest = await stableHash(bytes);
        if (!/^sha256-v1:[a-f0-9]{64}$/.test(digest)) throw failure("MAIN_SNAPSHOT_HASH_UNAVAILABLE", "SHA-256 is required.");
        const segment = { deviceId: entry.deviceId, firstSeq: entry.archive.firstSeq, lastSeq: entry.archive.lastSeq, digest };
        const key = `${segment.deviceId}:${segment.firstSeq}:${segment.lastSeq}`;
        const prior = seenSegments.get(key);
        if (prior && prior.digest !== digest) throw failure("MAIN_RECOVERY_INVALID", "Restored archive conflict.");
        if (!prior) { seenSegments.set(key, segment); segments.push(segment); }
      }
      // Preserve idempotency even when an older acknowledged operation is no
      // longer the winning annotation and its archive has been compacted.
      const receipts = await collectDurableReceipts(loaded);
      const provisional = await makeMainSnapshotCandidate({ document: loaded.document,
        operations: opsFor(loaded.state), parents: [], segments, receipts, hash: stableHash });
      const directory = `${root}/main-snapshots/${document.docKey}`;
      const parents = [];
      let equivalent = null;
      const segmentSignature = (rows) => canonicalJson(rows.map((row) => canonicalJson(row)).sort());
      for (const path of (await list(directory)).files.sort()) {
        const match = /\/([a-f0-9]{64})\.json$/.exec(path);
        if (!match) continue;
        const snapshotId = `sha256-v1:${match[1]}`;
        const parent = await mainSnapshots.read(loaded.document, snapshotId);
        // A snapshot can arrive from Sync before its source WAL. Treating it
        // as a parent while omitting its state would falsely claim a merge.
        // Wait for the source records rather than silently losing its branch.
        const joined = joinOperations(parent.value.operations, opsFor(loaded.state));
        if (canonicalJson(joined) !== canonicalJson(loaded.state)) {
          throw failure("MAIN_SNAPSHOT_SYNC_PENDING", "A checkpoint branch contains operations not yet present in verified logs.");
        }
        if (canonicalJson(joinOperations(parent.value.operations)) === canonicalJson(loaded.state) &&
            segmentSignature(parent.value.segments) === segmentSignature(segments) &&
            canonicalJson(parent.value.receipts) === canonicalJson(provisional.value.receipts) &&
            (!equivalent || parent.value.parents.length > equivalent.value.parents.length)) equivalent = parent;
        parents.push(snapshotId);
      }
      if (equivalent && !forceRecovery) return equivalent;
      if (parents.length >= 10) throw failure("MAIN_SNAPSHOT_RETENTION_PENDING", "Ten checkpoints are retained; safe retention must complete before publishing another.");
      const candidate = await makeMainSnapshotCandidate({ document: loaded.document,
        operations: opsFor(loaded.state), parents, segments, receipts, hash: stableHash });
      return mainSnapshots.publish(loaded.document, candidate);
    });
  }
  // This durable observation does not constitute a verified device roster or
  // authorize garbage collection. Both remain explicit prerequisites.
  async function ackMainCheckpoint(document, snapshotId) {
    if (!mainSnapshots || !/^[A-Za-z0-9_-]{1,256}$/.test(deviceId || "")) {
      throw failure("MAIN_SNAPSHOT_UNAVAILABLE", "JSONL storage and a safe device identity are required.");
    }
    return queued(document.docKey, async () => {
      const snapshot = await mainSnapshots.read(document, snapshotId);
      if (!snapshot) throw failure("MAIN_SNAPSHOT_MISSING", "The checkpoint is unavailable for acknowledgement.");
      const effective = await readEffective(document, { readOnly: true });
      if (!effective.document || effective.errors.length || effective.sidecarError ||
          (effective.jsonlRows || []).some((row) => row.operations.length)) {
        throw failure("MAIN_SNAPSHOT_STALE", "Live or incomplete records must be settled before acknowledgement.");
      }
      const checkpointState = joinOperations(snapshot.value.operations);
      const mergedState = joinOperations(snapshot.value.operations, opsFor(effective.state));
      if (canonicalJson(checkpointState) !== canonicalJson(mergedState)) {
        throw failure("MAIN_SNAPSHOT_STALE", "The checkpoint does not include the latest verified state.");
      }
      if (!containsReceipts(snapshot.value, { receipts: await collectDurableReceipts(effective) })) {
        throw failure("MAIN_SNAPSHOT_STALE", "The checkpoint omits durable operation receipts.");
      }
      for (const entry of effective.jsonlArchives || []) {
        const digest = await stableHash(new TextEncoder().encode(await adapter.read(entry.path)));
        if (!snapshot.value.segments.some((segment) => segment.deviceId === entry.deviceId &&
            segment.firstSeq === entry.archive.firstSeq && segment.lastSeq === entry.archive.lastSeq && segment.digest === digest)) {
          throw failure("MAIN_SNAPSHOT_STALE", "A verified archive is not covered by the checkpoint.");
        }
      }
      const path = `${root}/main-acks/${document.docKey}/${snapshotId.slice("sha256-v1:".length)}/${deviceId}.json`;
      const value = { schemaVersion: 1, kind: "pdf-reader-main-snapshot-ack", docKey: document.docKey,
        documentId: document.documentId, sourceHash: document.source.sourceHash, snapshotId, deviceId };
      const validate = (row) => {
        if (canonicalJson(row) !== canonicalJson(value)) throw failure("MAIN_SNAPSHOT_ACK_INVALID", "Acknowledgement identity differs.");
      };
      const existing = await mainSnapshotIo.readJson(path, { validate });
      if (existing) return existing;
      return mainSnapshotIo.writeJsonAtomic(path, value, { validate, createOnly: true });
    });
  }
  // Prepare evidence only. It cannot authorize deletion or retirement until a
  // persistent cross-device fencing protocol is implemented and verified.
  async function prepareMainRetirement({ document, deviceId: target, snapshotId } = {}) {
    if (!mainSnapshots || !mainDeviceObservations || !document || document.sourceMismatch) {
      throw failure("MAIN_RETIREMENT_PENDING", "A verified document and JSONL storage are required.");
    }
    return queued(document.docKey, async () => {
      const observeTarget = async () => {
        try { return await queued("main-device-observation", () => mainDeviceObservations.observe({ deviceId: target })); }
        catch (error) {
          if (error?.code === "MAIN_DEVICE_PRESENCE_PENDING") throw failure("MAIN_RETIREMENT_PENDING", "A device presence update is incomplete.");
          throw error;
        }
      };
      const observed = await observeTarget();
      if (!observed.retirementCandidate) throw failure("MAIN_RETIREMENT_PENDING", "The device is not a current inactivity candidate.");
      const loaded = await readEffective(document, { readOnly: true });
      if (!loaded.document || loaded.errors.length || loaded.sidecarError || loaded.valid.length ||
          loaded.jsonlRows.some((row) => row.operations.length)) {
        throw failure("MAIN_RETIREMENT_PENDING", "Unsettled document data prevents retirement planning.");
      }
      const checkpoint = await mainSnapshots.read(document, snapshotId);
      if (!checkpoint || canonicalJson(joinOperations(checkpoint.value.operations, opsFor(loaded.state))) !==
          canonicalJson(joinOperations(checkpoint.value.operations)) ||
          !containsReceipts(checkpoint.value, { receipts: await collectDurableReceipts(loaded) })) {
        throw failure("MAIN_RETIREMENT_PENDING", "The checkpoint does not cover the verified state.");
      }
      for (const entry of loaded.jsonlArchives) {
        const digest = await stableHash(new TextEncoder().encode(await adapter.read(entry.path)));
        if (!checkpoint.value.segments.some((segment) => segment.deviceId === entry.deviceId &&
            segment.firstSeq === entry.archive.firstSeq && segment.lastSeq === entry.archive.lastSeq && segment.digest === digest)) {
          throw failure("MAIN_RETIREMENT_PENDING", "The checkpoint does not cover an archive.");
        }
      }
      const devices = [...new Set([deviceId, ...(await mainDeviceObservations.knownDevices()),
        ...(loaded.recovery?.records || []).flatMap((row) => row.record.devices),
        ...loaded.jsonlAnchors.map((row) => row.deviceId), ...loaded.jsonlRows.map((row) => row.deviceId),
        ...loaded.jsonlArchives.map((row) => row.deviceId), ...checkpoint.value.segments.map((row) => row.deviceId)])].sort();
      const acknowledgements = [];
      async function requireAck(owner) {
        const path = `${root}/main-acks/${document.docKey}/${snapshotId.slice(10)}/${owner}.json`;
        if (await adapter.exists(`${path}.pending`)) throw failure("MAIN_RETIREMENT_PENDING", "A device ACK update is incomplete.");
        const ack = await mainSnapshotIo.readJson(path);
        if (!ack || ack.kind !== "pdf-reader-main-snapshot-ack" || ack.schemaVersion !== 1 || ack.docKey !== document.docKey ||
            ack.documentId !== document.documentId || ack.sourceHash !== document.source.sourceHash ||
            ack.snapshotId !== snapshotId || ack.deviceId !== owner) throw failure("MAIN_RETIREMENT_PENDING", "A device ACK is missing or invalid.");
        if (await adapter.exists(`${path}.pending`)) throw failure("MAIN_RETIREMENT_PENDING", "A device ACK update is incomplete.");
      }
      for (const owner of devices.filter((id) => id !== target)) {
        await requireAck(owner);
        acknowledgements.push({ deviceId: owner, snapshotId, verified: true });
      }
      const latestDevices = await mainDeviceObservations.knownDevices();
      if (latestDevices.some((id) => !devices.includes(id))) {
        throw failure("MAIN_RETIREMENT_PENDING", "The observed device set changed while checking acknowledgements.");
      }
      const latest = await observeTarget();
      if (!latest.retirementCandidate || latest.observation.digest !== observed.observation.digest ||
          latest.observation.firstObservedAt !== observed.observation.firstObservedAt) {
        throw failure("MAIN_RETIREMENT_PENDING", "The target device became active while checking acknowledgements.");
      }
      const finalState = await readEffective(document, { readOnly: true });
      if (!finalState.document || finalState.errors.length || finalState.sidecarError || finalState.valid.length ||
          finalState.jsonlRows.some((row) => row.operations.length) ||
          canonicalJson(joinOperations(checkpoint.value.operations, opsFor(finalState.state))) !==
            canonicalJson(joinOperations(checkpoint.value.operations)) ||
          !containsReceipts(checkpoint.value, { receipts: await collectDurableReceipts(finalState) })) {
        throw failure("MAIN_RETIREMENT_PENDING", "Document state changed while checking retirement evidence.");
      }
      for (const entry of finalState.jsonlArchives) {
        const digest = await stableHash(new TextEncoder().encode(await adapter.read(entry.path)));
        if (!checkpoint.value.segments.some((segment) => segment.deviceId === entry.deviceId &&
            segment.firstSeq === entry.archive.firstSeq && segment.lastSeq === entry.archive.lastSeq && segment.digest === digest)) {
          throw failure("MAIN_RETIREMENT_PENDING", "A newly published archive is not covered by the checkpoint.");
        }
      }
      for (const owner of devices.filter((id) => id !== target)) await requireAck(owner);
      const finalDevices = await mainDeviceObservations.knownDevices();
      if (finalDevices.some((id) => !devices.includes(id))) {
        throw failure("MAIN_RETIREMENT_PENDING", "The observed device set changed during final verification.");
      }
      const finalObservation = await observeTarget();
      if (!finalObservation.retirementCandidate || finalObservation.observation.digest !== observed.observation.digest ||
          finalObservation.observation.firstObservedAt !== observed.observation.firstObservedAt) {
        throw failure("MAIN_RETIREMENT_PENDING", "The target device became active during final verification.");
      }
      return makeRetirementProposal({ document, checkpoint, deviceId: target, observerId: deviceId,
        observation: finalObservation.observation, now: finalObservation.observation.lastObservedAt, presenceDigest: finalObservation.observation.digest,
        deviceIds: devices, acknowledgements, hash: stableHash });
    });
  }
  // Diagnostic/explicit recovery of one verified candidate only. It is not a
  // route lookup, a proof of device acknowledgement, or authority to GC.
  async function readMainCheckpoint(document, snapshotId) {
    if (!mainSnapshots) throw failure("MAIN_SNAPSHOT_UNAVAILABLE", "JSONL storage is required.");
    if (document.sourceMismatch) throw failure("SOURCE_MISMATCH", "Cannot recover onto a changed source PDF.");
    const candidate = await mainSnapshots.read(document, snapshotId);
    if (!candidate) throw failure("MAIN_SNAPSHOT_MISSING", "The requested checkpoint is unavailable.");
    return { snapshotId: candidate.snapshotId, documentId: document.documentId, docKey: document.docKey,
      state: joinOperations(candidate.value.operations), segments: candidate.value.segments };
  }
  async function publishMainRetirementProposal(input) {
    if (!retirementProposals) throw failure("MAIN_RETIREMENT_PENDING", "JSONL storage is required.");
    const proposal = await prepareMainRetirement(input);
    return retirementProposals.publish(input.document, proposal);
  }
  async function revalidateMainRetirementProposal(document, id) {
    if (!retirementProposals) throw failure("MAIN_RETIREMENT_PENDING", "JSONL storage is required.");
    const stored = await retirementProposals.read(document, id);
    if (!stored || stored.value.observerId !== deviceId) {
      throw failure("MAIN_RETIREMENT_PENDING", "The observer's retirement evidence is unavailable.");
    }
    const current = await prepareMainRetirement({ document, deviceId: stored.value.deviceId, snapshotId: stored.value.checkpointId });
    const { observedAt: _pastTime, ...previous } = stored.value;
    const { observedAt: _currentTime, ...latest } = current;
    if (canonicalJson(previous) !== canonicalJson(latest)) {
      throw failure("MAIN_RETIREMENT_PENDING", "Retirement evidence has changed since the proposal was published.");
    }
    return stored;
  }
  async function pruneCoveredArchives({ document, current, previous, paths }) {
    if (!mainRecovery || !Array.isArray(paths) || !paths.length || new Set(paths).size !== paths.length) {
      throw failure("MAIN_RECOVERY_INVALID", "A nonempty distinct archive list is required.");
    }
    if (document.sourceMismatch) throw failure("SOURCE_MISMATCH", "A changed PDF cannot be compacted.");
    return queued(document.docKey, async () => {
      const loaded = await readEffective(document, { readOnly: true });
      const failedRecoverySnapshot = loaded.errors.find((entry) =>
        [current, previous].some((id) => typeof id === "string" && entry.path?.endsWith(`/${id.slice(10)}.json`)));
      if (failedRecoverySnapshot) throw failure("MAIN_SNAPSHOT_CORRUPT", "A recovery checkpoint failed verification.");
      if (!loaded.document || loaded.errors.length || loaded.sidecarError || loaded.valid.length ||
          (loaded.jsonlRows || []).some((row) => row.operations.length)) {
        throw failure("MAIN_RECOVERY_PENDING", "Legacy, incomplete or live records prevent archive cleanup.");
      }
      const checkpoint = await mainSnapshots.read(document, current);
      const backup = await mainSnapshots.read(document, previous);
      if (!checkpoint || !backup || current === previous ||
          canonicalJson(joinOperations(checkpoint.value.operations, opsFor(loaded.state))) !==
          canonicalJson(joinOperations(checkpoint.value.operations))) {
        throw failure("MAIN_RECOVERY_PENDING", "The recovery pair does not cover the latest state.");
      }
      if (!containsReceipts(checkpoint.value, { receipts: await collectDurableReceipts(loaded) })) {
        throw failure("MAIN_RECOVERY_PENDING", "The current checkpoint omits durable operation receipts.");
      }
      const knownDevices = await mainDeviceObservations.knownDevices();
      const devices = [...new Set([deviceId, ...knownDevices, ...(loaded.recovery?.records || []).flatMap((row) => row.record.devices),
        ...loaded.jsonlAnchors.map((row) => row.deviceId),
        ...loaded.jsonlRows.map((row) => row.deviceId), ...loaded.jsonlArchives.map((row) => row.deviceId),
        ...checkpoint.value.segments.map((row) => row.deviceId)])].sort();
      async function checkKnownDevices() {
        const latestDevices = await mainDeviceObservations.knownDevices();
        if (latestDevices.some((id) => !devices.includes(id))) {
          throw failure("MAIN_RECOVERY_ACK_PENDING", "A newly observed device has not acknowledged this checkpoint.");
        }
      }
      const acknowledgements = [];
      for (const owner of devices) {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(owner)) throw failure("MAIN_RECOVERY_INVALID", "Invalid device identity.");
        const ack = await mainSnapshotIo.readJson(`${root}/main-acks/${document.docKey}/${current.slice(10)}/${owner}.json`);
        if (!ack || ack.kind !== "pdf-reader-main-snapshot-ack" || ack.schemaVersion !== 1 ||
            ack.documentId !== document.documentId || ack.docKey !== document.docKey ||
            ack.sourceHash !== document.source.sourceHash || ack.deviceId !== owner || ack.snapshotId !== current) {
          throw failure("MAIN_RECOVERY_ACK_PENDING", "An active device has not acknowledged this exact checkpoint.");
        }
        acknowledgements.push({ deviceId: owner, snapshotId: current, verified: true });
      }
      const archives = [];
      for (const entry of loaded.recovery?.records || []) {
        if (!containsReceipts(checkpoint.value, entry.current.value) || !containsReceipts(backup.value, entry.current.value)) {
          throw failure("MAIN_RECOVERY_PENDING", "The recovery pair omits previously confirmed operation receipts.");
        }
        for (const archive of entry.record.archives) {
          const prior = archives.find((row) => row.path === archive.path);
          if (prior && canonicalJson(prior) !== canonicalJson(archive)) {
            throw failure("MAIN_RECOVERY_INVALID", "Archived recovery evidence conflicts.");
          }
          if (!prior) archives.push(archive);
        }
      }
      for (const path of paths) {
        const entry = loaded.jsonlArchives.find((row) => row.path === path);
        if (!entry) throw failure("MAIN_RECOVERY_INVALID", "Only verified sealed archives can be deleted.");
        const archivedReceipts = await collectDurableReceipts({ valid: [], jsonlAnchors: [], jsonlRows: [], jsonlArchives: [entry] });
        if (![checkpoint, backup].every((item) => containsReceipts(item.value, { receipts: archivedReceipts }))) {
          throw failure("MAIN_RECOVERY_PENDING", "Both recovery checkpoints must retain archived request receipts.");
        }
        const digest = await stableHash(new TextEncoder().encode(await adapter.read(path)));
        const archive = { path, deviceId: entry.deviceId, firstSeq: entry.archive.firstSeq,
          lastSeq: entry.archive.lastSeq, digest, sealed: true, verified: true };
        const prior = archives.find((row) => row.path === path);
        if (prior && canonicalJson(prior) !== canonicalJson(archive)) throw failure("MAIN_RECOVERY_INVALID", "Archived recovery evidence conflicts.");
        if (!prior) archives.push(archive);
      }
      const supersedes = [...new Set((loaded.recovery?.records || []).flatMap((row) => [row.id, ...(row.record.supersedes || [])]))].sort();
      const published = await mainRecovery.publish(document, { schemaVersion: 1, kind: "pdf-reader-main-recovery",
        documentId: document.documentId, docKey: document.docKey, sourceHash: document.source.sourceHash,
        current, previous, devices, acknowledgements, archives, supersedes });
      let removedCount = 0;
      for (const archive of archives.filter((item) => paths.includes(item.path))) {
        await checkKnownDevices();
        // Never remove a different file that Sync placed at the same name.
        const raw = await adapter.read(archive.path);
        if (await stableHash(new TextEncoder().encode(raw)) !== archive.digest) {
          throw failure("MAIN_RECOVERY_PENDING", "An archive changed before deletion.");
        }
        const pair = await mainRecovery.read(document);
        if (pair.errors.length) throw failure("MAIN_RECOVERY_PENDING", "Recovery evidence changed before deletion.");
        // Move the exact directory entry to a unique staging path first. If
        // Sync replaced the source between the prior read and rename, the new
        // bytes remain in staging and are never silently discarded.
        const token = String(uuid());
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) throw failure("MAIN_RECOVERY_INVALID", "Invalid cleanup token.");
        const staged = `${archive.path}.gc-${token}`;
        if (await adapter.exists(staged)) throw failure("MAIN_RECOVERY_PENDING", "A cleanup staging path already exists.");
        await adapter.rename(archive.path, staged);
        const stagedRaw = await adapter.read(staged);
        if (await stableHash(new TextEncoder().encode(stagedRaw)) !== archive.digest) {
          throw failure("MAIN_RECOVERY_PENDING", "An archive changed at the cleanup boundary; bytes are retained in staging.");
        }
        await checkKnownDevices();
        await adapter.remove(staged);
        removedCount++;
      }
      // Retire only locally present certificates superseded by the new,
      // fully validated cumulative record. Keep transitive ids in that record
      // so stale copies that reappear from Sync cannot reactivate old pairs.
      async function removeVerifiedEntry(path, expectedRaw) {
        const token = String(uuid());
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) throw failure("MAIN_RECOVERY_INVALID", "Invalid cleanup token.");
        const staged = `${path}.gc-${token}`;
        if (await adapter.exists(staged)) throw failure("MAIN_RECOVERY_PENDING", "A cleanup staging path already exists.");
        await adapter.rename(path, staged);
        if (await adapter.read(staged) !== expectedRaw) {
          throw failure("MAIN_RECOVERY_PENDING", "Cleanup target changed; bytes are retained in staging.");
        }
        await checkKnownDevices();
        await adapter.remove(staged);
      }
      for (const old of loaded.recovery?.records || []) {
        await checkKnownDevices();
        const currentRecovery = await mainRecovery.read(document);
        if (currentRecovery.errors.length || !currentRecovery.records.some((row) => row.id === published.id)) {
          throw failure("MAIN_RECOVERY_PENDING", "Cumulative recovery evidence is unavailable.");
        }
        const rawText = await adapter.read(old.path);
        const raw = JSON.parse(rawText);
        const { integrity, ...unsigned } = raw;
        if (await stableHash(new TextEncoder().encode(canonicalJson(unsigned))) !== old.id) {
          throw failure("MAIN_RECOVERY_PENDING", "Prior recovery evidence changed before cleanup.");
        }
        await removeVerifiedEntry(old.path, rawText);
      }
      // Only covered, non-frontier checkpoints may be deleted; both retained
      // snapshots must dominate their state and carry identical segment hashes.
      const directory = `${root}/main-snapshots/${document.docKey}`;
      const snapshotRows = [];
      for (const path of (await list(directory)).files.sort()) {
        const match = /\/([a-f0-9]{64})\.json$/.exec(path);
        if (match) snapshotRows.push({ path, value: await mainSnapshots.read(document, `sha256-v1:${match[1]}`) });
      }
      const referenced = new Set(snapshotRows.flatMap((row) => row.value.value.parents));
      const frontier = new Set(snapshotRows.filter((row) => !referenced.has(row.value.snapshotId)).map((row) => row.value.snapshotId));
      let excess = Math.max(0, snapshotRows.length - 9);
      for (const row of snapshotRows.sort((a, b) => a.value.value.parents.length - b.value.value.parents.length)) {
        if (!excess || row.value.snapshotId === current || row.value.snapshotId === previous || frontier.has(row.value.snapshotId)) continue;
        await checkKnownDevices();
        const old = row.value.value;
        const dominated = [checkpoint, backup].every((newer) =>
          canonicalJson(joinOperations(newer.value.operations, old.operations)) === canonicalJson(joinOperations(newer.value.operations)) &&
          containsReceipts(newer.value, old) &&
          old.segments.every((segment) => newer.value.segments.some((candidate) => canonicalJson(candidate) === canonicalJson(segment))));
        if (!dominated) continue;
        const recovery = await mainRecovery.read(document);
        if (recovery.errors.length || !recovery.records.some((entry) => entry.id === published.id)) {
          throw failure("MAIN_RECOVERY_PENDING", "Checkpoint recovery evidence changed during cleanup.");
        }
        await mainSnapshots.read(document, row.value.snapshotId);
        const rawText = await adapter.read(row.path);
        if (rawText !== canonicalJson(row.value)) throw failure("MAIN_RECOVERY_PENDING", "Checkpoint changed before cleanup.");
        await removeVerifiedEntry(row.path, rawText);
        excess--;
      }
      hotDocuments.delete(document.docKey);
      advanceJsonlGeneration(coordinationAdapter, document.docKey);
      return { removedCount };
    });
  }
  async function resumeMainArchiveCleanup(document) {
    if (!mainRecovery || !document || document.sourceMismatch) throw failure("MAIN_RECOVERY_PENDING", "A verified JSONL document is required.");
    return queued(document.docKey, async () => {
      const loaded = await readEffective(document, { readOnly: true });
      if (!loaded.document || loaded.errors.length || loaded.sidecarError || loaded.valid.length ||
          loaded.jsonlRows.some((row) => row.operations.length)) {
        throw failure("MAIN_RECOVERY_PENDING", "Unsettled data prevents resuming archive cleanup.");
      }
      const observed = [...new Set([deviceId, ...(await mainDeviceObservations.knownDevices()),
        ...loaded.jsonlAnchors.map((row) => row.deviceId), ...loaded.jsonlRows.map((row) => row.deviceId),
        ...loaded.jsonlArchives.map((row) => row.deviceId)])];
      const pattern = new RegExp(`/${document.docKey}\\.jsonl\\.archive\\.\\d+-\\d+\\.json\\.gc-[A-Za-z0-9_-]+$`);
      const stages = [];
      for (const directory of (await list(`${root}/wal`)).folders) {
        stages.push(...(await list(directory)).files.filter((path) => pattern.test(path)));
      }
      let removedCount = 0;
      for (const staged of stages.sort()) {
        const original = staged.slice(0, staged.lastIndexOf(".gc-"));
        const record = loaded.recovery.records.find((entry) => entry.record.archives.some((item) => item.path === original));
        const archive = record?.record.archives.find((item) => item.path === original);
        if (!record || observed.some((id) => !record.record.devices.includes(id))) {
          throw failure("MAIN_RECOVERY_PENDING", "Recovery evidence or device acknowledgement is incomplete.");
        }
        for (const owner of record.record.devices) {
          const ack = await mainSnapshotIo.readJson(`${root}/main-acks/${document.docKey}/${record.record.current.slice(10)}/${owner}.json`);
          if (!ack || ack.kind !== "pdf-reader-main-snapshot-ack" || ack.schemaVersion !== 1 || ack.docKey !== document.docKey ||
              ack.documentId !== document.documentId || ack.sourceHash !== document.source.sourceHash ||
              ack.snapshotId !== record.record.current || ack.deviceId !== owner) {
            throw failure("MAIN_RECOVERY_PENDING", "A recovery checkpoint acknowledgement is missing or invalid.");
          }
        }
        if (await stableHash(new TextEncoder().encode(await adapter.read(staged))) !== archive.digest) {
          throw failure("MAIN_RECOVERY_PENDING", "A staged archive differs from the recovery certificate.");
        }
        const token = String(uuid());
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(token)) throw failure("MAIN_RECOVERY_INVALID", "Invalid cleanup token.");
        const isolated = `${original}.gc-${token}`;
        if (await adapter.exists(isolated)) throw failure("MAIN_RECOVERY_PENDING", "A cleanup staging path already exists.");
        await adapter.rename(staged, isolated);
        if (await stableHash(new TextEncoder().encode(await adapter.read(isolated))) !== archive.digest ||
            (await mainDeviceObservations.knownDevices()).some((id) => !record.record.devices.includes(id))) {
          throw failure("MAIN_RECOVERY_PENDING", "Staged content or the device set changed; bytes are retained.");
        }
        await adapter.remove(isolated);
        removedCount++;
      }
      return { removedCount };
    });
  }
  async function maintainMainSnapshots(document) {
    if (!mainSnapshots) return { status: "not-applicable" };
    // Separate orchestration key: individual publication/ACK/GC steps retain
    // their existing per-document queues and must not recursively acquire it.
    return queued(`main-maintenance:${document.docKey}`, async () => {
      const loaded = await readEffective(document, { readOnly: true });
      if (!loaded.document || loaded.errors.length || loaded.sidecarError ||
          loaded.jsonlRows.some((row) => row.operations.length)) return { status: "sync-pending" };
      if (loaded.gcStages?.length) {
        // A separate Sync client can replace staged bytes between validation
        // and removal. Never resume destructive cleanup automatically until
        // that cross-client race has a proven solution.
        return { status: "deferred", reason: "MAIN_DISTRIBUTED_GC_UNVERIFIED" };
      }
      if (loaded.state.routing) await mainRouteClaims.publish({ indexedPath: loaded.document.sourcePath,
        document: loaded.document, route: loaded.state.routing });
      await signalMainDeviceActivity();
      const existing = [];
      for (const path of (await list(`${root}/main-snapshots/${document.docKey}`)).files.sort()) {
        const match = /\/([a-f0-9]{64})\.json$/.exec(path);
        if (match) existing.push(await mainSnapshots.read(loaded.document, `sha256-v1:${match[1]}`));
      }
      const derived = await adapter.exists(jsonlCheckpoints.snapshotPath(document)) ? 1 : 0;
      const fileCount = existing.length + loaded.jsonlArchives.length + derived;
      if (fileCount <= 3) return { status: "below-threshold", fileCount };
      try {
        let current = await createMainCheckpoint(loaded.document);
        let previous = existing.filter((row) => row.snapshotId !== current.snapshotId &&
          current.value.parents.includes(row.snapshotId)).sort((a, b) =>
          b.value.parents.length - a.value.parents.length)[0];
        if (!previous) {
          previous = current;
          current = await createMainCheckpoint(loaded.document, { forceRecovery: true });
        }
        await ackMainCheckpoint(loaded.document, current.snapshotId);
        // Preserve each device's newest sealed segment. Active JSONL files
        // never enter this list and are not part of this maintenance count.
        const newest = new Map();
        for (const entry of loaded.jsonlArchives) {
          const prior = newest.get(entry.deviceId);
          if (!prior || prior.archive.lastSeq < entry.archive.lastSeq) newest.set(entry.deviceId, entry);
        }
        const paths = loaded.jsonlArchives.filter((entry) => newest.get(entry.deviceId) !== entry &&
          previous.value.segments.some((segment) => segment.deviceId === entry.deviceId &&
            segment.firstSeq === entry.archive.firstSeq && segment.lastSeq === entry.archive.lastSeq)).map((entry) => entry.path);
        if (!paths.length) return { status: "checkpointed", fileCount, snapshotId: current.snapshotId, removedCount: 0 };
        // Preserve existing archives while distributed removal is unproven.
        // Snapshot publication and acknowledgement remain active.
        return { status: "deferred", fileCount, snapshotId: current.snapshotId,
          reason: "MAIN_DISTRIBUTED_GC_UNVERIFIED", removedCount: 0 };
      } catch (error) {
        if (["MAIN_RECOVERY_ACK_PENDING", "MAIN_RECOVERY_PENDING", "MAIN_SNAPSHOT_STALE", "MAIN_SNAPSHOT_SYNC_PENDING",
          "MAIN_SNAPSHOT_RETENTION_PENDING"].includes(error.code)) return { status: "deferred", fileCount, reason: error.code };
        throw error;
      }
    });
  }
  async function materializeSnapshot(document) {
    return queued(document.docKey, async () => {
      const loaded = await readEffective(document);
      if (loaded.errors.length || loaded.sidecarError) return readDocument(document, { readOnly: true });
      await activateEpoch();
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
      if (["main-snapshots", "main-recovery", "main-acks"].some((directory) =>
        path.startsWith(`${root}/${directory}/${document.docKey}/`))) return true;
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
  function signalMainDeviceActivity() {
    return mainDeviceObservations ? queued("main-device-presence", () => mainDeviceObservations.publishPresence()) : Promise.resolve();
  }
  function observeKnownMainDevices() {
    if (!mainDeviceObservations) return Promise.resolve([]);
    return queued("main-device-observation", async () => {
      const known = await mainDeviceObservations.knownDevices();
      const observations = [];
      for (const other of known) {
        if (other === deviceId) continue;
        observations.push({ deviceId: other, ...(await mainDeviceObservations.observe({ deviceId: other })) });
      }
      return observations;
    });
  }
  return { registerDocument, documentForPath, documentForIdentity, appendOperations, readDocument, materializeSnapshot, createMainCheckpoint, ackMainCheckpoint, prepareMainRetirement, publishMainRetirementProposal, revalidateMainRetirementProposal, readMainRetirementProposal: (document, id) => retirementProposals?.read(document, id), readMainCheckpoint, pruneCoveredArchives, resumeMainArchiveCleanup, maintainMainSnapshots, signalMainDeviceActivity, observeKnownMainDevices,
    lookupMainRouteClaims: (path) => mainRouteClaims ? mainRouteClaims.query(path) : Promise.resolve({ claims: [], errors: [] }),
    observeMainDevice: (otherDeviceId) => queued("main-device-observation", () => mainDeviceObservations.observe({ deviceId: otherDeviceId })),
    updateSourceIdentity, updateLegacyIdentities, renameDocument, pathsFor, affectsPath,
    readEffective, inspectDevices, sourceProtocol: jsonl ? "wal-sidecar-v3.2-jsonl" : PROTOCOL,
    invalidateRegistry: () => { routingGeneration += 1; },
    invalidateExternal: (path) => {
      if (!jsonl || typeof path !== "string") return;
      const globalRouteChange = path === registry.path || path.startsWith(`${root}/main-routes/`);
      for (const [docKey, cached] of hotDocuments) {
        if (globalRouteChange || (cached.effective?.document && affectsPath(cached.effective.document, path))) {
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
