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
  assert.equal(index.documents["FolderA/same.pdf"].documentId, a.documentId);
  assert.equal(index.documents["FolderB/same.pdf"].documentId, b.documentId);
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
  assert.equal(snapshot.annotations[0].deleted, true);

  await annotationsA.appendOperations({ document, batchId: "newer-edit", operations: [live("ann", "Ink", "A", 31, { points: [1, 2] })] });
  snapshot = await annotationsA.readDocument(document);
  assert.equal(snapshot.annotations[0].deleted, false, "newer edit deterministically supersedes the tombstone");
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

test("snapshot is replay-derived cache: stale contents are rebuilt from immutable operation batches", async () => {
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
  files.set(path, JSON.stringify({ schemaVersion: 1, annotations: [], batchFiles: first.batchFiles }));
  const rebuilt = await annotations.readDocument(document);
  assert.equal(rebuilt.annotations[0].uuid, "u1");
  assert.equal(JSON.parse(files.get(path)).annotations[0].uuid, "u1");
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
  assert.equal(JSON.parse(files.get("00_Archive/20_PDFData/_index.json")).documents["B/Renamed.pdf"].documentId,
    original.documentId, "the recovered index is rewritten after event replay");

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
