import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");

function hash(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeAdapter(shared = { files: new Map(), folders: new Set() }) {
  const { files, folders } = shared;
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) {
      if (!files.has(path)) throw new Error(`missing: ${path}`);
      return files.get(path);
    },
    async write(path, value) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !folders.has(parent)) throw new Error(`parent directory missing: ${parent}`);
      files.set(path, value);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`rename target exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(path) { files.delete(path); },
    async list(path) {
      const prefix = `${path}/`;
      const directFiles = [];
      const directFolders = new Set();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        if (!remainder.includes("/")) directFiles.push(file);
        else directFolders.add(`${path}/${remainder.slice(0, remainder.indexOf("/"))}`);
      }
      for (const folder of folders) {
        if (!folder.startsWith(prefix)) continue;
        const remainder = folder.slice(prefix.length);
        if (remainder && !remainder.includes("/")) directFolders.add(folder);
      }
      return { files: directFiles, folders: [...directFolders] };
    },
  };
  return { adapter, files, folders, shared };
}

function store({ adapter, deviceId = "device-A", clock = () => 1_000, uuidSeed = deviceId,
  contentHash = hash, identityHash = hash } = {}) {
  let sequence = 0;
  return createPdfAnnotationStore({
    adapter,
    root: "00_Archive/20_PDFData",
    deviceId,
    clock,
    uuid: () => `${uuidSeed}-uuid-${++sequence}`,
    hash: contentHash,
    identityHash,
  });
}

function live(uuid, kind, deviceId, timestamp, payload = { value: kind }, extra = {}) {
  return {
    uuid,
    kind,
    pageIndex: 16,
    deleted: false,
    payload,
    clock: { timestamp, logical: 0, deviceId, opId: `${deviceId}-${timestamp}-${uuid}` },
    ...extra,
  };
}

function tombstone(uuid, kind, deviceId, timestamp, logical = 0) {
  return {
    uuid,
    kind,
    pageIndex: 16,
    deleted: true,
    clock: { timestamp, logical, deviceId, opId: `${deviceId}-${timestamp}-${uuid}-delete` },
  };
}

test("concurrent first opens derive the same path identity, while copied paths get a new identity", async () => {
  const vaultA = makeAdapter();
  const vaultB = makeAdapter();
  const storeA = store({ adapter: vaultA.adapter, deviceId: "A" });
  const storeB = store({ adapter: vaultB.adapter, deviceId: "B" });
  const [firstA, firstB] = await Promise.all([
    storeA.registerDocument({ sourcePath: "Books/Principles.pdf" }),
    storeB.registerDocument({ sourcePath: "Books/Principles.pdf" }),
  ]);
  assert.equal(firstA.documentId, firstB.documentId);
  assert.equal(firstA.docKey, firstB.docKey);

  const copied = await storeA.registerDocument({ sourcePath: "Archive/Principles.pdf" });
  assert.notEqual(copied.documentId, firstA.documentId);

  const otherDirectory = await storeA.registerDocument({ sourcePath: "Other/Principles.pdf" });
  assert.notEqual(otherDirectory.documentId, copied.documentId);
  assert.notEqual(storeA.pathsFor(copied).snapshot, storeA.pathsFor(otherDirectory).snapshot,
    "equal basenames have distinct docKey suffixes");
});

test("document identity and docKey do not change with the PDF content hash algorithm", async () => {
  const shaStore = store({ adapter: makeAdapter().adapter, deviceId: "sha" });
  const xxhStore = store({
    adapter: makeAdapter().adapter,
    deviceId: "xxh",
    contentHash: () => "xxh64-v1:0123456789abcdef",
    identityHash: hash,
  });
  const [shaDocument, xxhDocument] = await Promise.all([
    shaStore.registerDocument({ sourcePath: "Books/Principles.pdf" }),
    xxhStore.registerDocument({ sourcePath: "Books/Principles.pdf" }),
  ]);
  assert.equal(shaDocument.documentId, xxhDocument.documentId);
  assert.equal(shaDocument.docKey, xxhDocument.docKey);
});

test("overlapping path-index writes merge unrelated documents without making the index authoritative", async () => {
  const shared = makeAdapter();
  const storeA = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "A" });
  const storeB = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "B" });
  const [a, b] = await Promise.all([
    storeA.registerDocument({ sourcePath: "FolderA/same.pdf" }),
    storeB.registerDocument({ sourcePath: "FolderB/same.pdf" }),
  ]);
  const index = JSON.parse(shared.files.get("00_Archive/20_PDFData/_index.json"));
  assert.equal(index.schemaVersion, 1,
    "the legacy-readable index remains active until each registered device confirms a compact checkpoint");
  assert.equal(index.documents["FolderA/same.pdf"].docKey, a.docKey);
  assert.equal(index.documents["FolderB/same.pdf"].docKey, b.docKey);
  assert.notEqual(a.docKey, b.docKey);
});

test("two devices append concurrently and deterministic LWW retains both distinct annotations", async () => {
  const shared = makeAdapter();
  const storeA = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "device-A", clock: () => 100 });
  const storeB = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "device-B", clock: () => 101 });
  const docA = await storeA.registerDocument({ sourcePath: "Books/a.pdf" });
  const docB = await storeB.registerDocument({ sourcePath: "Books/a.pdf" });
  assert.equal(docA.documentId, docB.documentId);

  const [ackA, ackB] = await Promise.all([
    storeA.appendOperations({ document: docA, batchId: "batch-a", operations: [live("ann-a", "Highlight", "device-A", 100)] }),
    storeB.appendOperations({ document: docB, batchId: "batch-b", operations: [live("ann-b", "Ink", "device-B", 101,
      { strokes: [1, 2] }, { embeddedRef: "8 0 R" })] }),
  ]);
  assert.equal(ackA.acknowledged, true);
  assert.equal(ackB.acknowledged, true);
  assert.equal(ackA.snapshotPending, true, "append acknowledgement does not synchronously replay or rewrite the snapshot");
  assert.equal(shared.files.has(storeA.pathsFor(docA).snapshot), false);

  const snapshot = await storeA.readDocument(docA);
  assert.deepEqual(snapshot.annotations.map((annotation) => annotation.uuid), ["ann-a", "ann-b"]);
  assert.equal(snapshot.annotations[1].embeddedRef, "8 0 R", "winning rows preserve exact embedded reference metadata");
  assert.deepEqual(new Set((await storeA.listOperationBatches(docA)).map((path) => path.split("/").at(-2))),
    new Set(["device-A", "device-B"]));
});

test("out-of-order and duplicate operations are idempotent; same actor/opId conflicts fail closed", async () => {
  const { adapter } = makeAdapter();
  const annotations = store({ adapter, deviceId: "A", clock: () => 500 });
  const document = await annotations.registerDocument({ sourcePath: "book.pdf", source: { sourceHash: hash("pdf bytes") } });
  const newer = live("one", "Underline", "A", 20, { text: "new" });
  newer.clock.opId = "same-op";
  const older = live("one", "Underline", "A", 10, { text: "old" });
  await annotations.appendOperations({ document, batchId: "newer", operations: [newer] });
  await annotations.appendOperations({ document, batchId: "older", operations: [older] });
  await annotations.appendOperations({ document, batchId: "duplicate", operations: [newer] });
  const retry = await annotations.appendOperations({ document, batchId: "newer", operations: [newer] });
  assert.equal(retry.duplicate, true, "retrying the same immutable batch ID acknowledges the original batch");

  const snapshot = await annotations.readDocument(document);
  assert.equal(snapshot.annotations.length, 1);
  assert.deepEqual(snapshot.annotations[0].payload, { text: "new" });
  assert.equal(snapshot.revision, 2, "duplicate device/opId does not increment the logical revision");

  const conflicting = { ...newer, payload: { text: "forged" } };
  await annotations.appendOperations({ document, batchId: "collision", operations: [conflicting] });
  await assert.rejects(annotations.readDocument(document), { code: "PDF_ANNOTATION_OPERATION_COLLISION" });
});

test("delete tombstones win over older updates regardless of arrival order and remain in snapshots", async () => {
  const shared = makeAdapter();
  const annotationsA = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "A" });
  const annotationsB = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "B" });
  const document = await annotationsA.registerDocument({ sourcePath: "book.pdf" });
  const documentB = await annotationsB.registerDocument({ sourcePath: "book.pdf" });
  await annotationsB.appendOperations({ document: documentB, batchId: "delete", operations: [tombstone("ann", "Ink", "B", 30)] });
  await annotationsA.appendOperations({ document, batchId: "late-old-edit", operations: [live("ann", "Ink", "A", 25)] });
  let snapshot = await annotationsA.readDocument(document);
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.annotations.length, 0);
  assert.deepEqual(snapshot.tombstones.map((row) => row.uuid), ["ann"]);
  assert.equal(Object.hasOwn(snapshot.tombstones[0], "deleted"), false);

  await annotationsA.appendOperations({ document, batchId: "newer-edit", operations: [live("ann", "Ink", "A", 31, { points: [1, 2] })] });
  snapshot = await annotationsA.readDocument(document);
  assert.equal(snapshot.tombstones.length, 0, "a newer edit deterministically supersedes the tombstone");
  assert.equal(snapshot.annotations[0].deleted, false);
  assert.deepEqual(snapshot.annotations[0].payload, { points: [1, 2] });
});

test("quarantined recovery operations do not replay against a different PDF source revision", async () => {
  const { adapter } = makeAdapter();
  const annotations = store({ adapter, deviceId: "A" });
  const sourceHash = hash("original PDF");
  const changedHash = hash("externally changed PDF");
  const document = await annotations.registerDocument({
    sourcePath: "book.pdf",
    source: { sourceHash, pageCount: 1, orderedPageIdentities: ["4 0 R"] },
  });
  await annotations.appendOperations({
    document,
    batchId: "quarantined-old-session",
    sourceHash: changedHash,
    quarantined: true,
    operations: [live("old-session", "Ink", "A", 30)],
  });
  const snapshot = await annotations.readDocument(document);
  assert.equal(snapshot.annotations.length, 0);
  assert.equal((await annotations.listOperationBatches(document)).length, 1,
    "quarantined recovery data remains durable for later source restoration");
});

test("normal operation batches from another source revision remain archived but never project onto this PDF", async () => {
  const { adapter } = makeAdapter();
  const annotations = store({ adapter, deviceId: "source-bound" });
  const originalHash = hash("original PDF bytes");
  const changedHash = hash("changed PDF bytes");
  const document = await annotations.registerDocument({ sourcePath: "bound.pdf", source: { sourceHash: originalHash } });
  await annotations.appendOperations({ document, batchId: "wrong-source", sourceHash: changedHash,
    operations: [live("foreign-annotation", "Highlight", "source-bound", 10)] });
  const snapshot = await annotations.readDocument(document);
  assert.equal(snapshot.annotations.length, 0);
  assert.equal((await annotations.listOperationBatches(document)).length, 1,
    "the mismatched batch remains on disk for later recovery or forensic review");
});

test("LWW tie breaks deterministically by logical counter, deviceId, then opId", async () => {
  const shared = makeAdapter();
  const a = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "A" });
  const b = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "B" });
  const docA = await a.registerDocument({ sourcePath: "tie.pdf" });
  const docB = await b.registerDocument({ sourcePath: "tie.pdf" });
  const make = (actor, logical, opId, text) => ({
    uuid: "same-annotation", kind: "FreeText", pageIndex: 0, deleted: false,
    payload: { text }, embeddedRef: null,
    clock: { timestamp: 50, logical, deviceId: actor, opId },
  });
  await a.appendOperations({ document: docA, batchId: "logical-low", operations: [make("A", 0, "y", "logical-low")] });
  await b.appendOperations({ document: docB, batchId: "device-tie", operations: [make("B", 0, "a", "device-wins")] });
  await a.appendOperations({ document: docA, batchId: "logical-high", operations: [make("A", 1, "a", "logical-wins")] });
  await a.appendOperations({ document: docA, batchId: "opid-tie-low", operations: [make("A", 1, "a", "logical-wins")] });
  await a.appendOperations({ document: docA, batchId: "opid-tie-high", operations: [make("A", 1, "z", "opid-wins")] });
  const snapshot = await a.readDocument(docA);
  assert.equal(snapshot.annotations[0].payload.text, "opid-wins");
});

test("verified checkpoint is a replay base and snapshot stores live annotations separately from tombstones", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "A", clock: () => 100 });
  const document = await annotations.registerDocument({ sourcePath: "book.pdf", source: { sourceHash: hash("pdf bytes") } });
  await annotations.appendOperations({ document, batchId: "batch", operations: [live("u1", "FreeText", "A", 100)] });
  const path = annotations.pathsFor(document).snapshot;
  assert.equal(files.has(path), false, "durable append does not wait for snapshot materialization");

  const first = await annotations.materializeSnapshot(document);
  assert.equal(first.annotations[0].uuid, "u1");
  assert.equal(first.source.sourcePath, "book.pdf");
  assert.equal(first.source.sourceHash, hash("pdf bytes"), "full source hashes keep their exact algorithm prefix");
  const storedSnapshot = JSON.parse(files.get(path));
  assert.equal(storedSnapshot.schemaVersion, 2);
  assert.equal(storedSnapshot.kind, "pdf-annotation-snapshot-pointer");
  assert.equal(storedSnapshot.checkpointPath, annotations.pathsFor(document).checkpoint);
  assert.equal(Object.hasOwn(storedSnapshot, "annotations"), false,
    "the basename cache points at the checkpoint without duplicating document payloads");
  const checkpoint = JSON.parse(files.get(annotations.pathsFor(document).checkpoint));
  assert.ok(checkpoint.integrity);
  assert.equal(checkpoint.annotations[0].deleted, false);
  assert.deepEqual(checkpoint.tombstones, []);
  assert.equal(checkpoint.annotations.some((row) => row.deleted === true), false);
  files.set(path, JSON.stringify({ schemaVersion: 1, annotations: [], batchFiles: first.batchFiles }));
  const rebuilt = await annotations.readDocument(document);
  assert.equal(rebuilt.annotations[0].uuid, "u1");
  assert.equal(JSON.parse(files.get(path)).kind, "pdf-annotation-snapshot-pointer");
  assert.equal(JSON.parse(files.get(annotations.pathsFor(document).checkpoint)).annotations[0].uuid, "u1");
  assert.equal((await annotations.listOperationBatches(document)).length, 0,
    "after checkpoint acknowledgement, covered batches can be physically compacted");
});

test("checkpoint backup restores compacted state and late covered batches cannot resurrect annotations", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "solo-device" });
  const document = await annotations.registerDocument({ sourcePath: "checkpoint.pdf" });
  await annotations.appendOperations({ document, batchId: "live", operations: [live("ann", "Ink", "solo-device", 10)] });
  await annotations.appendOperations({ document, batchId: "delete", operations: [tombstone("ann", "Ink", "solo-device", 20)] });
  const operationPath = `${annotations.pathsFor(document).deviceOperations}/delete.json`;
  const deletedBatch = files.get(operationPath);
  const before = await annotations.readDocument(document);
  assert.deepEqual(before.tombstones.map((row) => row.uuid), ["ann"]);
  files.set(operationPath, deletedBatch);
  const primary = annotations.pathsFor(document).checkpoint;
  files.set(primary, "corrupt checkpoint");
  const recovered = await annotations.readDocument(document);
  assert.deepEqual(recovered.tombstones.map((row) => row.uuid), ["ann"],
    "the verified backup is a sufficient replay base after the primary is damaged");
  assert.equal(files.get(primary).includes('"kind":"pdf-annotation-checkpoint"'), true);
  assert.equal((await annotations.listOperationBatches(document)).length, 0,
    "an exact covered batch that reappears after sync is ignored and compacted again");
});

test("an unverified checkpoint backup prevents covered-batch garbage collection", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "backup-failure-device" });
  const document = await annotations.registerDocument({ sourcePath: "backup-failure.pdf" });
  await annotations.appendOperations({ document, batchId: "keep-until-backup", operations: [
    live("backup-safe", "Ink", "backup-failure-device", 10),
  ] });
  const batchPath = `${annotations.pathsFor(document).deviceOperations}/keep-until-backup.json`;
  const originalWrite = adapter.write.bind(adapter);
  let backupWrites = 0;
  adapter.write = async (path, value) => {
    if (path === annotations.pathsFor(document).checkpointBackup && ++backupWrites === 3) {
      await originalWrite(path, "truncated checkpoint backup");
      return;
    }
    await originalWrite(path, value);
  };

  await assert.rejects(annotations.readDocument(document), {
    code: "PDF_ANNOTATION_CHECKPOINT_BACKUP_UNCONFIRMED",
  });
  assert.equal(files.has(batchPath), true,
    "a backup that fails exact readback must leave every covered operation batch intact");

  const recovered = await annotations.readDocument(document);
  assert.equal(recovered.annotations[0].uuid, "backup-safe");
  assert.equal(files.has(batchPath), false,
    "a later verified primary/backup pair allows the already-checkpointed batch to be collected");
});

test("legacy Float32 wrappers are losslessly compacted only after the checkpoint upgrade barrier", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "upgrade-device" });
  const document = await annotations.registerDocument({ sourcePath: "legacy-ink.pdf" });
  const oldEditor = {
    annotationType: "Ink",
    pageIndex: 0,
    paths: {
      lines: { $type: "Float32Array", values: [0.125, 1.5, { $type: "NonFiniteNumber", value: "NaN" }, -0] },
      points: { $type: "Float32Array", values: [0.125, 1.5, { $type: "NonFiniteNumber", value: "NaN" }, -0] },
    },
  };
  await annotations.appendOperations({ document, batchId: "old-ink", operations: [live(
    "ink", "Ink", "upgrade-device", 20, { editor: oldEditor },
  )] });
  const legacyBatchPath = `${annotations.pathsFor(document).deviceOperations}/old-ink.json`;
  const serializedLegacyBatch = files.get(legacyBatchPath);
  const withPersistedNegativeZero = serializedLegacyBatch.replaceAll(
    '"values":[0.125,1.5,{"$type":"NonFiniteNumber","value":"NaN"},0]',
    '"values":[0.125,1.5,{"$type":"NonFiniteNumber","value":"NaN"},-0]',
  );
  assert.notEqual(withPersistedNegativeZero, serializedLegacyBatch,
    "the fixture includes a legacy JSON number spelling that preserves negative zero");
  files.set(legacyBatchPath, withPersistedNegativeZero);

  const upgraded = await annotations.readDocument(document);
  assert.equal(upgraded.compactInkEncoding, true);
  assert.equal(upgraded.annotations[0].payload.editor.paths.lines.$type, "Float32ArrayLE");
  assert.equal(upgraded.annotations[0].payload.editor.paths.points.$type, "Float32ArrayLE");
  const checkpoint = JSON.parse(files.get(annotations.pathsFor(document).checkpoint));
  assert.equal(checkpoint.payloadEncoding, "float32le-base64-v1");
  assert.equal(JSON.stringify(checkpoint).includes('"$type":"Float32Array"'), false);
  assert.equal(checkpoint.annotations[0].payload.editor.paths.lines.length, 4);
  const compactLines = checkpoint.annotations[0].payload.editor.paths.lines;
  const compactBytes = Buffer.from(compactLines.base64, "base64");
  assert.equal(compactBytes.byteLength, compactLines.length * Float32Array.BYTES_PER_ELEMENT);
  assert.deepEqual([...compactBytes.subarray(0, 8)], [0, 0, 0, 62, 0, 0, 192, 63],
    "finite values use their exact Float32 little-endian representation");
  const compactView = new DataView(compactBytes.buffer, compactBytes.byteOffset, compactBytes.byteLength);
  assert.equal(Number.isNaN(compactView.getFloat32(8, true)), true,
    "the NaN slot remains a Float32 NaN after compact encode/decode");
  assert.equal(Object.is(compactView.getFloat32(12, true), -0), true,
    "negative zero survives when it is present in the legacy persisted JSON");
});

test("every registered device must acknowledge the same checkpoint before GC; retirement rejects late writes", async () => {
  const shared = makeAdapter();
  const adapterA = makeAdapter(shared.shared).adapter;
  const adapterB = makeAdapter(shared.shared).adapter;
  const a = store({ adapter: adapterA, deviceId: "device-A" });
  const b = store({ adapter: adapterB, deviceId: "device-B" });
  const documentA = await a.registerDocument({ sourcePath: "shared.pdf" });
  const documentB = await b.registerDocument({ sourcePath: "shared.pdf" });
  await a.appendOperations({ document: documentA, batchId: "a", operations: [live("a1", "Ink", "device-A", 10)] });
  await b.appendOperations({ document: documentB, batchId: "b", operations: [live("b1", "Ink", "device-B", 11)] });
  const legacySnapshotPath = a.pathsFor(documentA).snapshot;
  const legacySnapshotText = JSON.stringify({ schemaVersion: 1, kind: "pdf-annotation-snapshot", annotations: [] });
  shared.files.set(legacySnapshotPath, legacySnapshotText);
  const first = await a.readDocument(documentA);
  assert.equal(shared.files.get(legacySnapshotPath), legacySnapshotText,
    "a pre-upgrade device can still read its legacy snapshot until all devices confirm the compact checkpoint");
  assert.equal((await a.listOperationBatches(documentA)).length, 2,
    "the unacknowledged second device prevents garbage collection");
  const firstStatus = await a.inspectDevices(documentA);
  assert.equal(firstStatus.devices.find((row) => row.deviceId === "device-B").acknowledged, false);
  const second = await b.readDocument(documentB);
  assert.notEqual(second.checkpointHash, first.checkpointHash,
    "the last legacy-format acknowledgement starts a separate compact-checkpoint phase");
  assert.equal((await b.listOperationBatches(documentB)).length, 2,
    "the old checkpoint acknowledgement is not enough to collect batches");
  const acksAfterConversion = await b.inspectDevices(documentB);
  assert.equal(acksAfterConversion.devices.find((row) => row.deviceId === "device-A").acknowledged, false);
  const final = await a.readDocument(documentA);
  assert.equal(final.checkpointHash, second.checkpointHash,
    "the upgraded device must read and confirm the exact compact checkpoint");
  assert.equal(final.compactInkEncoding, true);
  assert.equal((await a.listOperationBatches(documentA)).length, 0,
    "covered batches are removed only after every current checkpoint acknowledgement");
  assert.equal(JSON.parse(shared.files.get(legacySnapshotPath)).kind, "pdf-annotation-snapshot-pointer",
    "the compact pointer replaces the legacy snapshot only after the final acknowledgement");
  const oldBatch = {
    schemaVersion: 1, formatVersion: 2, pluginVersion: "0.7.0",
    kind: "annotation-operation-batch", documentId: documentA.documentId, docKey: documentA.docKey,
    deviceId: "device-B", batchId: "late-retired", createdAt: 50,
    operations: [live("revive", "Ink", "device-B", 50)],
  };
  const oldPath = `${a.pathsFor(documentA).operations}/device-B/late-retired.json`;
  shared.files.set(oldPath, JSON.stringify(oldBatch));
  await a.retireDevice({ document: documentA, targetDeviceId: "device-B", confirmedCheckpointHash: final.checkpointHash });
  await assert.rejects(b.appendOperations({ document: documentB, batchId: "after-retire",
    operations: [live("blocked", "Ink", "device-B", 60)] }), { code: "PDF_ANNOTATION_DEVICE_RETIRED" });
  const afterRetirement = await a.readDocument(documentA);
  assert.equal(afterRetirement.annotations.some((row) => row.uuid === "revive"), false,
    "a late batch from a retired device cannot alter the checkpoint projection");

  const syncedAfterRetirement = {
    ...oldBatch,
    batchId: "late-after-retirement",
    operations: [live("revive-after-gc", "Ink", "device-B", 51)],
  };
  const syncedAfterRetirementPath = `${a.pathsFor(documentA).operations}/device-B/late-after-retirement.json`;
  shared.files.set(syncedAfterRetirementPath, JSON.stringify(syncedAfterRetirement));
  const afterLateSync = await a.readDocument(documentA);
  assert.equal(afterLateSync.annotations.some((row) => row.uuid === "revive-after-gc"), false,
    "a newly synced batch from a retired device stays outside the projection after prior GC");
  assert.equal(shared.files.has(syncedAfterRetirementPath), false,
    "the ignored late batch is recorded in a new checkpoint and can then be collected");
});

test("rename preserves identity and updates source mapping; a later path copy gets a new identity", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "A" });
  const original = await annotations.registerDocument({
    sourcePath: "A/Book.pdf",
    source: { sourceHash: hash("pdf bytes"), size: 9, pageCount: 1, orderedPageIdentities: ["p1"] },
  });
  await annotations.appendOperations({ document: original, batchId: "batch", operations: [live("u1", "Square", "A", 1)] });
  const renamed = await annotations.renameDocument({ documentId: original.documentId,
    fromPath: "A/Book.pdf", toPath: "B/Renamed.pdf" });
  assert.equal(renamed.documentId, original.documentId);
  assert.equal(renamed.docKey, original.docKey);
  const lookedUp = await annotations.registerDocument({ sourcePath: "B/Renamed.pdf" });
  assert.equal(lookedUp.documentId, original.documentId);
  assert.equal(annotations.pathsFor(renamed).snapshot, `00_Archive/20_PDFData/Renamed--${original.docKey}.pdfdata.json`);
  assert.equal((await annotations.readDocument(renamed)).source.sourcePath, "B/Renamed.pdf");

  // The mutable path index is disposable. Rebuild it from the immutable
  // create/source/rename event stream and preserve the document identity.
  files.delete("00_Archive/20_PDFData/_index.json");
  const rebuilt = await annotations.registerDocument({ sourcePath: "B/Renamed.pdf" });
  assert.equal(rebuilt.documentId, original.documentId);
  assert.equal(rebuilt.source.pageCount, 1);
  assert.equal(rebuilt.source.orderedPageIdentities[0], "p1");
  assert.equal(await annotations.documentForPath("A/Book.pdf"), null);

  files.set("00_Archive/20_PDFData/_index.json", "{truncated");
  const repaired = await annotations.documentForPath("B/Renamed.pdf");
  assert.equal(repaired.documentId, original.documentId,
    "a malformed disposable index is reconstructed from immutable identity events");
  const metadata = JSON.parse(files.get(annotations.pathsFor(repaired).metadata));
  assert.equal(metadata.documentId, original.documentId);
  assert.deepEqual(metadata.source.orderedPageIdentities, ["p1"]);

  const copy = await annotations.registerDocument({ sourcePath: "B/Copy.pdf" });
  assert.notEqual(copy.documentId, original.documentId);
  await assert.rejects(annotations.renameDocument({ documentId: original.documentId,
    fromPath: "A/Book.pdf", toPath: "B/Renamed.pdf" }), { code: "PDF_ANNOTATION_IDENTITY_MISSING" });
});

test("identity event replay follows causal parents when device clocks are skewed", async () => {
  const shared = makeAdapter();
  const writer = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "clock-a", clock: () => 9_000_000 });
  const renamer = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "clock-b", clock: () => 1 });
  const created = await writer.registerDocument({ sourcePath: "Books/Clock.pdf" });
  const openedByRenamer = await renamer.registerDocument({ sourcePath: "Books/Clock.pdf" });
  const moved = await renamer.renameDocument({ documentId: openedByRenamer.documentId,
    fromPath: "Books/Clock.pdf", toPath: "Archive/Clock.pdf" });
  assert.equal(moved.documentId, created.documentId);

  shared.files.delete("00_Archive/20_PDFData/_index.json");
  const recovered = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "clock-c" });
  const lookedUp = await recovered.documentForPath("Archive/Clock.pdf");
  assert.equal(lookedUp.documentId, created.documentId,
    "wall-clock skew does not replay rename before document creation");
  assert.equal(await recovered.documentForPath("Books/Clock.pdf"), null);
});

test("a synced index may temporarily lead a partially synced identity event stream", async () => {
  const shared = makeAdapter();
  const writer = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "partial-sync" });
  const created = await writer.registerDocument({ sourcePath: "Books/Before.pdf" });
  const renamed = await writer.renameDocument({ documentId: created.documentId,
    fromPath: "Books/Before.pdf", toPath: "Books/After.pdf" });
  const renameEvent = [...shared.files.entries()].find(([path, value]) =>
    path.includes("identity-events/") && JSON.parse(value).kind === "document-rename");
  assert.ok(renameEvent);
  shared.files.delete(renameEvent[0]); // Simulate sync delivering _index.json first.

  const reader = store({ adapter: makeAdapter(shared.shared).adapter, deviceId: "partial-reader" });
  const recoveredFromAheadCache = await reader.documentForPath("Books/After.pdf");
  assert.equal(recoveredFromAheadCache.documentId, created.documentId);
  assert.equal(recoveredFromAheadCache.identityEventHeads.includes(renamed.identityEventHeads.at(-1)), true);
});

test("source identity requires a full prefixed hash and preserves prior identity on mismatch", async () => {
  const { adapter } = makeAdapter();
  const annotations = store({ adapter, deviceId: "A" });
  const initialHash = hash("original");
  const document = await annotations.registerDocument({ sourcePath: "book.pdf",
    source: { sourceHash: initialHash, tailHash64k: "xxh64-v1:0123456789abcdef", size: 8, pageCount: 2 } });
  assert.equal(document.sourceMatch, "BASELINE_ESTABLISHED");
  assert.equal((await annotations.registerDocument({ sourcePath: "book.pdf" })).sourceMatch, "UNKNOWN",
    "a stored hash is not a match when the caller has no current full hash");

  const matching = await annotations.updateSourceIdentity({ document, sourceHash: initialHash,
    size: 8, pageCount: 2, orderedPageIdentities: ["p1", "p2"] });
  assert.equal(matching.sourceMatch, "MATCH");
  const changedPages = await annotations.updateSourceIdentity({ document, sourceHash: initialHash,
    size: 8, pageCount: 2, orderedPageIdentities: ["p2", "p1"] });
  assert.equal(changedPages.sourceMismatch, true, "ordered page identity change is fail-closed");

  const mismatch = await annotations.updateSourceIdentity({ document, sourceHash: hash("changed"),
    size: 8, pageCount: 2, orderedPageIdentities: ["p1", "p2"] });
  assert.equal(mismatch.sourceMatch, "MISMATCH");
  const reloaded = await annotations.registerDocument({ sourcePath: "book.pdf", source: { sourceHash: hash("changed") } });
  assert.equal(reloaded.sourceMismatch, true);
  assert.equal(reloaded.source.sourceHash, initialHash, "mismatch does not overwrite the last trusted source identity");

  const legacy = await annotations.registerDocument({ sourcePath: "legacy.pdf", source: { fastHash: "a".repeat(64) } });
  assert.equal(legacy.source.sourceHash, `sha256-v1:${"a".repeat(64)}`);
  const sampledOnly = await annotations.registerDocument({ sourcePath: "sampled.pdf", source: { tailHash64k: "xxh64-v1:0123456789abcdef" } });
  assert.equal(sampledOnly.sourceMatch, "UNKNOWN", "a matching tail sample is not proof of full source identity");
  assert.equal((await annotations.updateSourceIdentity({ document: sampledOnly,
    pageCount: 1, orderedPageIdentities: ["p1"], tailHash64k: "xxh64-v1:0123456789abcdef" })).sourceMatch, "UNKNOWN");
  assert.throws(() => annotations.pathsFor({ ...legacy, source: { sourceHash: "xxh64:abcd" } }), /Unsupported hash format/);
});

test("legacy UUID/ref mappings survive index loss and are tied to the source identity", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "legacy-map" });
  const sourceHash = hash("legacy PDF source");
  const document = await annotations.registerDocument({
    sourcePath: "Books/legacy.pdf",
    source: { sourceHash, pageCount: 1, orderedPageIdentities: ["page-ref-1"] },
  });
  const rows = [{
    uuid: "legacy-annotation-uuid", ref: "77 0 R", pageIndex: 0, kind: "highlight",
    deleted: false, timestamp: 20, logical: 1, actorId: "legacy", operationId: "legacy-op",
  }];
  const updated = await annotations.updateLegacyIdentities({ document, identities: rows });
  assert.equal(updated.legacyIdentityScanComplete, true);
  assert.deepEqual(updated.legacyIdentities, rows);

  files.delete("00_Archive/20_PDFData/_index.json");
  const rebuilt = await annotations.documentForPath("Books/legacy.pdf");
  assert.equal(rebuilt.documentId, document.documentId);
  assert.deepEqual(rebuilt.legacyIdentities, rows);
  assert.equal(rebuilt.legacyIdentityScanComplete, true);

  await assert.rejects(annotations.updateLegacyIdentities({
    document: rebuilt,
    identities: [rows[0], { ...rows[0], ref: "78 0 R" }],
  }), { code: "PDF_ANNOTATION_LEGACY_IDENTITY_AMBIGUOUS" });
});

test("0.7 migrates page and legacy identity payloads out of the root index and emits incremental identity events", async () => {
  const { adapter, files } = makeAdapter();
  const originalStore = store({ adapter, deviceId: "migration-writer" });
  const source = {
    sourceHash: hash("migration PDF"),
    size: 500_000,
    pageCount: 357,
    orderedPageIdentities: Array.from({ length: 357 }, (_, index) => `ref:${index + 1}R`),
  };
  const document = await originalStore.registerDocument({ sourcePath: "Books/Large.pdf", source });
  const legacyIdentities = Array.from({ length: 53 }, (_, index) => ({
    uuid: `legacy-${String(index).padStart(3, "0")}`,
    ref: `${index + 1} 0 R`,
    pageIndex: index,
    kind: "Ink",
    deleted: false,
    timestamp: 1,
    logical: 0,
    actorId: "legacy",
    operationId: `legacy-${index}`,
  }));
  const oldRecord = { ...document, legacyIdentities, legacyIdentityScanComplete: true };
  files.set("00_Archive/20_PDFData/_index.json", JSON.stringify({
    schemaVersion: 1,
    documents: { "Books/Large.pdf": oldRecord },
  }));
  files.delete(originalStore.pathsFor(document).metadata);

  const upgraded = store({ adapter, deviceId: "migration-reader" });
  const migrated = await upgraded.documentForPath("Books/Large.pdf");
  assert.equal(migrated.documentId, document.documentId);
  assert.equal(migrated.source.orderedPageIdentities.length, 357);
  assert.equal(migrated.legacyIdentities.length, 53);
  const compatibilityIndex = JSON.parse(files.get("00_Archive/20_PDFData/_index.json"));
  assert.equal(compatibilityIndex.schemaVersion, 1,
    "the legacy index stays readable while a device has not confirmed the checkpoint");
  assert.equal(compatibilityIndex.documents["Books/Large.pdf"].docKey, document.docKey);
  const metadata = JSON.parse(files.get(upgraded.pathsFor(migrated).metadata));
  assert.equal(metadata.source.orderedPageIdentities.length, 357);
  assert.equal(metadata.legacyIdentities.length, 53);

  await upgraded.readDocument(migrated);
  const indexText = files.get("00_Archive/20_PDFData/_index.json");
  const index = JSON.parse(indexText);
  assert.deepEqual(index.documents, { "Books/Large.pdf": document.docKey });
  assert.doesNotMatch(indexText, /orderedPageIdentities|legacyIdentities/);

  const eventRoot = upgraded.pathsFor(migrated).identityEvents;
  const eventFiles = (await adapter.list(eventRoot)).files;
  const createEvent = JSON.parse(files.get(eventFiles[0]));
  assert.equal(Object.hasOwn(createEvent.source, "orderedPageIdentities"), false);
  assert.equal(Object.hasOwn(createEvent, "legacyIdentities"), false);

  const nextIdentities = [...legacyIdentities, {
    uuid: "legacy-new",
    ref: "900 0 R",
    pageIndex: 356,
    kind: "Square",
    deleted: false,
    timestamp: 2,
    logical: 0,
    actorId: "legacy",
    operationId: "legacy-new",
  }];
  await upgraded.updateLegacyIdentities({ document: migrated, identities: nextIdentities });
  const latestEvents = (await upgraded.listOperationBatches(migrated));
  assert.equal(latestEvents.length, 0, "identity changes do not create annotation operation batches");
  const eventPaths = await (async () => {
    const listing = await adapter.list(eventRoot);
    return listing.files;
  })();
  const deltaEvent = eventPaths.map((path) => JSON.parse(files.get(path)))
    .find((row) => row.kind === "document-legacy-identities" && row.legacyDeltas?.upsert?.length === 1);
  assert.ok(deltaEvent, "subsequent identity updates append only the changed identity");
  assert.equal(Object.hasOwn(deltaEvent, "legacyIdentities"), false);
});

test("idle registered devices block compact-format and root-index cutover until they acknowledge", async () => {
  const shared = makeAdapter();
  const adapterA = makeAdapter(shared.shared).adapter;
  const adapterB = makeAdapter(shared.shared).adapter;
  const a = store({ adapter: adapterA, deviceId: "idle-device-A" });
  const b = store({ adapter: adapterB, deviceId: "idle-device-B" });
  const documentA = await a.registerDocument({ sourcePath: "Books/Idle.pdf",
    source: { pageCount: 1, orderedPageIdentities: ["page-1"] } });
  const deviceDirectory = a.pathsFor(documentA).deviceStates;
  shared.folders.add("00_Archive");
  shared.folders.add("00_Archive/20_PDFData");
  shared.folders.add("00_Archive/20_PDFData/checkpoints");
  shared.folders.add(deviceDirectory);
  shared.files.set(`${deviceDirectory}/idle-device-B.json`, JSON.stringify({
    schemaVersion: 1,
    deviceId: "idle-device-B",
    pluginVersion: "0.6.0",
    checkpointHash: "sha256-v1:" + "0".repeat(64),
    retired: false,
    updatedAt: 1,
  }));

  const initial = await a.readDocument(documentA);
  assert.equal(initial.compactInkEncoding, false);
  const firstCheckpoint = JSON.parse(shared.files.get(a.pathsFor(documentA).checkpoint));
  assert.deepEqual(firstCheckpoint.knownDevices, ["idle-device-A", "idle-device-B"]);
  const oldIndex = JSON.parse(shared.files.get("00_Archive/20_PDFData/_index.json"));
  assert.equal(oldIndex.schemaVersion, 1,
    "route-only index migration remains gated while any registered device is old");

  const documentB = await b.registerDocument({ sourcePath: "Books/Idle.pdf" });
  const compactPending = await b.readDocument(documentB);
  assert.equal(compactPending.compactInkEncoding, false,
    "one device acknowledging the compact checkpoint is not enough");
  assert.equal((await b.inspectDevices(documentB)).devices.find((row) => row.deviceId === "idle-device-A").acknowledged, false);
  const final = await a.readDocument(documentA);
  assert.equal(final.compactInkEncoding, true);
  const routeIndex = JSON.parse(shared.files.get("00_Archive/20_PDFData/_index.json"));
  assert.equal(routeIndex.schemaVersion, 2);
  assert.deepEqual(routeIndex.documents, { "Books/Idle.pdf": documentA.docKey });
});

test("a cold root-index document blocks route-only cutover after another document is compact and acknowledged", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "root-barrier-device" });
  const documentA = await annotations.registerDocument({
    sourcePath: "Books/A-Large.pdf",
    source: {
      sourceHash: hash("large source PDF"),
      size: 16_850_000,
      pageCount: 357,
      orderedPageIdentities: Array.from({ length: 357 }, (_, index) => `ref:${index + 1}R`),
    },
  });
  const documentB = await annotations.registerDocument({
    sourcePath: "Books/B-Cold.pdf",
    source: {
      sourceHash: hash("cold source PDF"),
      pageCount: 3,
      orderedPageIdentities: ["cold-page-1", "cold-page-2", "cold-page-3"],
    },
  });

  const before = JSON.parse(files.get("00_Archive/20_PDFData/_index.json"));
  assert.equal(before.schemaVersion, 1);
  assert.equal(Object.keys(before.documents).length, 2);

  const snapshotA = await annotations.readDocument(documentA);
  const checkpointA = JSON.parse(files.get(annotations.pathsFor(documentA).checkpoint));
  const metadataA = JSON.parse(files.get(annotations.pathsFor(documentA).metadata));
  const metadataB = JSON.parse(files.get(annotations.pathsFor(documentB).metadata));
  const devicesA = await annotations.inspectDevices(documentA);
  const after = JSON.parse(files.get("00_Archive/20_PDFData/_index.json"));

  assert.equal(snapshotA.compactInkEncoding, true);
  assert.equal(checkpointA.payloadEncoding, "float32le-base64-v1");
  assert.match(checkpointA.metadataHash, /^sha256-v1:[a-f0-9]{64}$/);
  assert.equal(metadataA.source.orderedPageIdentities.length, 357);
  assert.equal(metadataB.source.orderedPageIdentities.length, 3);
  assert.equal(files.has(annotations.pathsFor(documentB).checkpoint), false,
    "document B remains cold: it has no checkpoint");
  assert.deepEqual(devicesA.devices.map(({ deviceId, pluginVersion, checkpointHash, acknowledged }) => ({
    deviceId, pluginVersion, checkpointHash, acknowledged,
  })), [{
    deviceId: "root-barrier-device",
    pluginVersion: "0.7.0",
    checkpointHash: checkpointA.integrity,
    acknowledged: true,
  }]);
  assert.equal(after.schemaVersion, 1,
    "materializing A is globally blocked because route readiness also requires a compact checkpoint for cold B");
  assert.equal(after.documents["Books/A-Large.pdf"].source.orderedPageIdentities.length, 357);
  assert.equal(after.documents["Books/B-Cold.pdf"].source.orderedPageIdentities.length, 3);
});

test("a missing per-document metadata file behind a route index fails closed", async () => {
  const { adapter, files } = makeAdapter();
  const annotations = store({ adapter, deviceId: "metadata-reader" });
  const document = await annotations.registerDocument({ sourcePath: "Books/Metadata.pdf",
    source: { pageCount: 1, orderedPageIdentities: ["page-ref"] } });
  const metadataPath = annotations.pathsFor(document).metadata;
  files.delete(metadataPath);
  files.set("00_Archive/20_PDFData/_index.json", JSON.stringify({
    schemaVersion: 2,
    documents: { "Books/Metadata.pdf": document.docKey },
  }));

  await assert.rejects(annotations.documentForPath("Books/Metadata.pdf"), {
    code: "PDF_ANNOTATION_METADATA_PENDING",
  });
  assert.equal(files.has(metadataPath), false,
    "identity events cannot silently replace missing page and legacy metadata");
});

test("a stale legacy index cannot overwrite newer per-document identity metadata", async () => {
  const { adapter, files } = makeAdapter();
  const writer = store({ adapter, deviceId: "metadata-writer" });
  const initial = await writer.registerDocument({ sourcePath: "Books/MetadataRace.pdf",
    source: { sourceHash: hash("stable PDF"), pageCount: 1, orderedPageIdentities: ["page-ref"] } });
  const legacy = {
    uuid: "legacy-current",
    ref: "42 0 R",
    pageIndex: 0,
    kind: "Ink",
    deleted: false,
    timestamp: 1,
    logical: 0,
    actorId: "legacy",
    operationId: "legacy-current",
  };
  const current = await writer.updateLegacyIdentities({ document: initial, identities: [legacy] });
  const metadataPath = writer.pathsFor(current).metadata;
  const metadataBefore = files.get(metadataPath);
  files.set("00_Archive/20_PDFData/_index.json", JSON.stringify({
    schemaVersion: 1,
    documents: { "Books/MetadataRace.pdf": initial },
  }));

  const reader = store({ adapter, deviceId: "metadata-reader" });
  const recovered = await reader.documentForPath("Books/MetadataRace.pdf");
  assert.deepEqual(recovered.legacyIdentities.map((row) => row.uuid), ["legacy-current"]);
  assert.equal(files.get(metadataPath), metadataBefore,
    "reading an old-format route cache must not replace newer document metadata");
});
