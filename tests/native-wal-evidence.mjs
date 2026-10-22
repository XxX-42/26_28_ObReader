import canonical from "../plugin/storage/canonical.cjs";
import merge from "../plugin/storage/merge-engine.cjs";

const json = (bytes) => JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
const asSorted = (rows) => [...rows].sort((left, right) => String(left.uuid).localeCompare(String(right.uuid)));
const equalJson = (left, right) => canonical.canonicalJson(asSorted(left)) === canonical.canonicalJson(asSorted(right));

function pathForVirtualPath(virtualRoot, isolatedRoot, value) {
  const prefix = `${virtualRoot.replace(/\/+$/, "")}/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) return null;
  return `${isolatedRoot.replace(/\/+$/, "")}/${value.slice(prefix.length)}`;
}

async function verifiedEnvelope(value, hash) {
  return canonical.verify(value, hash);
}

function assertIdentity(value, { docKey, documentId, sourceHash }, label) {
  if (value.docKey !== docKey || value.documentId !== documentId || value.sourceHash !== sourceHash) {
    throw new Error(`${label} identity/source mismatch`);
  }
}

function validateOperationForDocument(input, { docKey, documentId, sourceHash }, deviceId = null) {
  const operation = merge.validateOperation(input);
  if (deviceId && operation.version.deviceId !== deviceId) {
    throw new Error("WAL operation device does not match its anchor/archive owner");
  }
  if (operation.seq !== operation.version.seq) throw new Error("WAL operation sequence mismatch");
  if (operation.payload?.sourceHash && operation.payload.sourceHash !== sourceHash) {
    throw new Error("WAL operation source hash mismatch");
  }
  // Operation records do not repeat document identity; their containing
  // integrity-verified anchor/archive/JSONL envelope establishes it.
  return operation;
}

function parseJsonl(text, identity, deviceId, hash) {
  if (!text) return { operations: [], complete: true };
  const lastNewline = text.lastIndexOf("\n");
  const completeText = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
  const operations = [];
  let previous = 0;
  for (const line of completeText.slice(0, -1).split("\n")) {
    if (!line) throw new Error("WAL JSONL contains an empty middle line");
    const entry = JSON.parse(line);
    assertIdentity(entry, identity, "WAL JSONL");
    if (typeof entry.integrity !== "string") throw new Error("WAL JSONL integrity is missing");
    const { integrity, ...unsigned } = entry;
    const actual = hash(Buffer.from(canonical.canonicalJson(unsigned), "utf8"));
    if (actual && typeof actual.then === "function") {
      throw new TypeError("The Native evidence hash adapter must be synchronous for JSONL verification");
    }
    if (actual !== integrity) throw new Error("WAL JSONL integrity mismatch");
    if (!Number.isSafeInteger(entry.lsn) || entry.lsn <= previous || entry.lsn !== entry.payload?.seq ||
        entry.payload?.version?.deviceId !== deviceId) {
      throw new Error("WAL JSONL sequence/owner mismatch");
    }
    if ((entry.payload.uuid || "$route") !== entry.id) throw new Error("WAL JSONL operation id mismatch");
    operations.push(validateOperationForDocument(entry.payload, identity, deviceId));
    previous = entry.lsn;
  }
  return { operations, complete: completeText.length === text.length };
}

/**
 * Reads only the per-run isolated Native sidecar files and independently
 * replays their durable operations in memory. The JSONL-derived snapshot is
 * verified and compared when present, but is explicitly not treated as the
 * source of WAL durability.
 */
export async function readNativeWalEvidence({
  files,
  isolatedRoot,
  virtualRoot,
  docKey,
  documentId,
  sourceHash,
  viewerRevision,
  confirmedViewerRevision,
  hash,
}) {
  const identity = { docKey, documentId, sourceHash };
  const root = isolatedRoot.replace(/\/+$/, "");
  const snapshotPath = `${root}/sidecars/${docKey}.annotations.json`;
  const legacyCheckpointPath = `${root}/checkpoints/${docKey}.json`;
  const snapshotBytes = files.get(snapshotPath);
  const snapshotPendingBytes = files.get(`${snapshotPath}.pending`);

  if (!snapshotBytes && !snapshotPendingBytes) {
    const legacyBytes = files.get(legacyCheckpointPath);
    if (legacyBytes) {
      const legacy = json(legacyBytes);
      if (legacy.integrity) await verifiedEnvelope(legacy, hash);
      if (legacy.docKey && legacy.docKey !== docKey) throw new Error("Legacy checkpoint docKey mismatch");
      if (!Array.isArray(legacy.annotations) || !Array.isArray(legacy.tombstones) ||
          !Number.isSafeInteger(legacy.revision)) {
        throw new Error("Legacy checkpoint shape is invalid");
      }
      return {
        protocol: "legacy-checkpoint",
        snapshot: { status: "legacy-checkpoint", path: legacyCheckpointPath, bytes: legacyBytes.byteLength },
        durableWal: { status: "not-present-in-legacy-format", operationCount: 0, throughSeqByDevice: {} },
        viewer: { revision: viewerRevision, confirmedRevision: confirmedViewerRevision },
        walWatermarkTotal: null,
        revisionMeaning: "legacy checkpoint revision; not a Viewer revision",
        integrity: legacy.integrity || null,
        annotations: legacy.annotations,
        tombstones: legacy.tombstones,
        operationFiles: [...files.keys()].filter((path) => path.startsWith(`${root}/ops/${docKey}/`)),
        checkpointBytes: legacyBytes.byteLength,
      };
    }
  }

  const snapshotSource = snapshotBytes || snapshotPendingBytes;
  const snapshot = snapshotSource ? json(snapshotSource) : null;
  let snapshotStatus = snapshotBytes ? "verified" : snapshotPendingBytes ? "pending-only" : "missing";
  if (snapshot) {
    await verifiedEnvelope(snapshot, hash);
    if (snapshot.kind !== "pdf-reader-jsonl-derived-snapshot" || snapshot.schemaVersion !== 1 ||
        !Array.isArray(snapshot.annotations) || !Array.isArray(snapshot.tombstones) ||
        !snapshot.watermarks || typeof snapshot.watermarks !== "object") {
      throw new Error("WAL v3.2 derived snapshot shape is invalid");
    }
    assertIdentity(snapshot, identity, "WAL v3.2 snapshot");
  }

  const anchors = [];
  const archives = [];
  const activeRows = [];
  const operationFiles = [];
  const walPrefix = `${root}/wal/`;
  const relatedPaths = [...files.keys()].filter((path) => path.startsWith(walPrefix));
  const anchorPaths = relatedPaths.filter((path) => path.endsWith(`/${docKey}.jsonl.anchor.json`));
  const archivePaths = relatedPaths.filter((path) => new RegExp(`/${docKey}\\.jsonl\\.archive\\.\\d+-\\d+\\.json$`).test(path));
  const jsonlPaths = relatedPaths.filter((path) => path.endsWith(`/${docKey}.jsonl`));

  for (const path of anchorPaths) {
    const anchor = json(files.get(path));
    const verified = await verifiedEnvelope(anchor, hash);
    assertIdentity(anchor, identity, "WAL v3.2 anchor");
    const deviceId = path.slice(walPrefix.length).split("/")[0];
    if (anchor.kind !== "pdf-reader-jsonl-device-anchor" || anchor.schemaVersion !== 1 ||
        anchor.deviceId !== deviceId || !Number.isSafeInteger(anchor.throughSeq) ||
        !Array.isArray(anchor.operations) || !Array.isArray(anchor.archives)) {
      throw new Error("WAL v3.2 anchor shape/owner is invalid");
    }
    const operations = anchor.operations.map((operation) => validateOperationForDocument(operation, identity, deviceId));
    if (operations.some((operation) => operation.seq > anchor.throughSeq)) {
      throw new Error("WAL v3.2 anchor operation exceeds throughSeq");
    }
    anchors.push({ path, value: anchor, deviceId, operations, verified });
    operationFiles.push(path);
  }

  const archiveByPath = new Map();
  for (const path of archivePaths) {
    const archive = json(files.get(path));
    const verified = await verifiedEnvelope(archive, hash);
    assertIdentity(archive, identity, "WAL v3.2 archive");
    const deviceId = path.slice(walPrefix.length).split("/")[0];
    if (archive.kind !== "pdf-reader-jsonl-immutable-archive" || archive.schemaVersion !== 1 ||
        archive.deviceId !== deviceId || !Number.isSafeInteger(archive.firstSeq) ||
        !Number.isSafeInteger(archive.lastSeq) || archive.lastSeq < archive.firstSeq ||
        !Array.isArray(archive.operations) || !archive.operations.length) {
      throw new Error("WAL v3.2 archive shape/owner is invalid");
    }
    const operations = archive.operations.map((operation) => validateOperationForDocument(operation, identity, deviceId));
    if (operations[0]?.seq !== archive.firstSeq || operations.at(-1)?.seq !== archive.lastSeq) {
      throw new Error("WAL v3.2 archive range does not match its operations");
    }
    const archivePath = path.slice(root.length + 1);
    const virtualPath = `${virtualRoot.replace(/\/+$/, "")}/${archivePath}`;
    archiveByPath.set(virtualPath, { path, value: archive, deviceId, operations, verified });
    archives.push({ path, virtualPath, value: archive, deviceId, operations, verified });
    operationFiles.push(path);
  }

  let referencesComplete = true;
  const missingArchives = [];
  for (const anchor of anchors) {
    for (const reference of anchor.value.archives) {
      if (reference.deviceId && reference.deviceId !== anchor.deviceId) {
        throw new Error("WAL v3.2 anchor archive owner mismatch");
      }
      const physicalPath = pathForVirtualPath(virtualRoot, root, reference.path);
      const archive = physicalPath && archiveByPath.get(reference.path);
      if (!archive || archive.path !== physicalPath || archive.value.firstSeq !== reference.firstSeq ||
          archive.value.lastSeq !== reference.lastSeq || archive.deviceId !== anchor.deviceId) {
        referencesComplete = false;
        missingArchives.push(reference.path);
      }
    }
  }

  let jsonlComplete = true;
  for (const path of jsonlPaths) {
    const deviceId = path.slice(walPrefix.length).split("/")[0];
    const parsed = parseJsonl(Buffer.isBuffer(files.get(path)) ? files.get(path).toString("utf8") : String(files.get(path)), identity, deviceId, hash);
    jsonlComplete &&= parsed.complete;
    activeRows.push(...parsed.operations);
    operationFiles.push(path);
  }

  const allOperations = [
    ...anchors.flatMap((anchor) => anchor.operations),
    ...archives.flatMap((archive) => archive.operations),
    ...activeRows,
  ];
  const replay = merge.joinOperations(allOperations);
  const throughSeqByDevice = {};
  for (const anchor of anchors) throughSeqByDevice[anchor.deviceId] = Math.max(
    throughSeqByDevice[anchor.deviceId] || 0, anchor.value.throughSeq);
  for (const archive of archives) throughSeqByDevice[archive.deviceId] = Math.max(
    throughSeqByDevice[archive.deviceId] || 0, archive.value.lastSeq);
  for (const operation of activeRows) throughSeqByDevice[operation.version.deviceId] = Math.max(
    throughSeqByDevice[operation.version.deviceId] || 0, operation.seq);

  const annotations = Object.values(replay.annotations);
  const tombstones = Object.values(replay.tombstones);
  const snapshotMatchesReplay = snapshot ? equalJson(snapshot.annotations, annotations) : null;
  const snapshotTombstonesMatchReplay = snapshot ? equalJson(snapshot.tombstones, tombstones) : null;
  const snapshotWatermarksMatchReplay = snapshot ? Object.entries(throughSeqByDevice).every(
    ([deviceId, seq]) => snapshot.watermarks[deviceId] === seq) : null;
  if (snapshot) {
    snapshotStatus = snapshotMatchesReplay && snapshotTombstonesMatchReplay && snapshotWatermarksMatchReplay
      ? "verified-consistent"
      : "verified-stale-or-different-from-wal-replay";
  }

  const complete = (anchors.length + archives.length + activeRows.length) > 0 && referencesComplete && jsonlComplete;
  const walWatermarkTotal = Object.values(throughSeqByDevice).reduce((sum, value) => sum + value, 0);
  return {
    protocol: "wal-sidecar-v3.2-jsonl",
    snapshot: {
      status: snapshotStatus,
      path: snapshot ? (snapshotBytes ? snapshotPath : `${snapshotPath}.pending`) : snapshotPath,
      bytes: snapshotSource?.byteLength ?? 0,
      integrity: snapshot?.integrity || null,
      watermarks: snapshot?.watermarks || null,
      matchesReplay: snapshotMatchesReplay,
      tombstonesMatchReplay: snapshotTombstonesMatchReplay,
      watermarksMatchReplay: snapshotWatermarksMatchReplay,
    },
    durableWal: {
      status: complete ? "replayed" : "incomplete",
      operationCount: allOperations.length,
      uniqueOperationCount: new Set(allOperations.map((operation) => operation.opId)).size,
      liveAnnotationCount: annotations.length,
      tombstoneCount: tombstones.length,
      throughSeqByDevice,
      missingArchives,
      jsonlComplete,
      referencesComplete,
    },
    viewer: { revision: viewerRevision, confirmedRevision: confirmedViewerRevision },
    walWatermarkTotal,
    revisionMeaning: "WAL through-sequence total; distinct from Viewer revision",
    annotations,
    tombstones,
    operationFiles,
    checkpointBytes: snapshotSource?.byteLength ?? 0,
    replayRouting: replay.routing,
    verifiedEnvelopes: [
      ...(snapshot ? [snapshotPath] : []),
      ...anchors.map((anchor) => anchor.path),
      ...archives.map((archive) => archive.path),
    ],
  };
}
