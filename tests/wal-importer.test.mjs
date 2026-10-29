import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";

const require = createRequire(import.meta.url);
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
const { createFormat3Importer } = require("../plugin/storage/format3-importer.cjs");
const { createSidecarStore } = require("../plugin/storage/sidecar-store.cjs");
const { joinOperations } = require("../plugin/storage/merge-engine.cjs");

function hash(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeAdapter(shared = { files: new Map(), folders: new Set(), writes: [], renames: [], removes: [], mkdirs: [] }) {
  const { files, folders, writes, renames, removes, mkdirs } = shared;
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); mkdirs.push(path); },
    async read(path) {
      if (!files.has(path)) throw new Error(`missing: ${path}`);
      return files.get(path);
    },
    async write(path, value) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !folders.has(parent)) throw new Error(`parent directory missing: ${parent}`);
      files.set(path, value);
      writes.push(path);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`rename target exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
      renames.push([from, to]);
    },
    async copy(from, to) {
      if (!files.has(from)) throw new Error(`missing copy source: ${from}`);
      if (files.has(to) || folders.has(to)) throw new Error(`copy target exists: ${to}`);
      files.set(to, files.get(from));
    },
    async remove(path) {
      files.delete(path);
      removes.push(path);
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
  return { adapter: withAtomicProcess(adapter, shared), shared };
}

function makeLegacyStore(adapter) {
  let id = 0;
  return createPdfAnnotationStore({
    adapter,
    root: "00_Archive/20_PDFData",
    deviceId: "legacy-device",
    uuid: () => `legacy-generated-${++id}`,
    hash,
    identityHash: hash,
    clock: () => 10_000 + id,
  });
}

function row(uuid, kind, timestamp, payload, extra = {}) {
  return {
    uuid,
    kind,
    pageIndex: 1,
    deleted: false,
    payload,
    clock: { timestamp, logical: 0, deviceId: "legacy-device", opId: `old-op-${uuid}` },
    ...extra,
  };
}

test("Format 3 export is read-only and interrupted/repeated imports preserve current state", async () => {
  const { adapter, shared } = makeAdapter();
  const legacy = makeLegacyStore(adapter);
  const sourceHash = hash("a real legacy PDF fixture with two pages");
  const document = await legacy.registerDocument({
    sourcePath: "Books/Imported.pdf",
    source: {
      sourceHash,
      size: 45_001,
      pageCount: 2,
      orderedPageIdentities: ["17 0 R", "29 0 R"],
    },
  });
  await legacy.appendOperations({
    document,
    batchId: "first-current-state",
    operations: [
      row("live-uuid", "Highlight", 1_010, { color: "yellow", quads: [1, 2, 3, 4] }, { embeddedRef: "71 0 R" }),
      row("deleted-uuid", "Ink", 1_011, { strokes: [[1, 2]] }),
    ],
  });
  await legacy.readDocument(document);
  await legacy.readDocument(document); // Upgrade the fixture checkpoint to Format 3.
  await legacy.appendOperations({
    document,
    batchId: "current-tombstone",
    operations: [{
      uuid: "deleted-uuid",
      kind: "Ink",
      pageIndex: 1,
      deleted: true,
      clock: { timestamp: 1_012, logical: 0, deviceId: "legacy-device", opId: "old-delete" },
    }],
  });
  await legacy.updateLegacyIdentities({
    document,
    identities: [{
      uuid: "live-uuid",
      ref: "71 0 R",
      pageIndex: 1,
      kind: "Highlight",
      deleted: false,
      timestamp: 1_010,
      logical: 0,
      actorId: "legacy-device",
      operationId: "old-op-live-uuid",
    }],
  });

  const before = {
    files: new Map(shared.files),
    writes: shared.writes.length,
    renames: shared.renames.length,
    removes: shared.removes.length,
    mkdirs: shared.mkdirs.length,
  };
  const exported = await legacy.exportForMigration("Books/Imported.pdf");
  assert.equal(exported.formatVersion, 3);
  assert.equal(exported.document.documentId, document.documentId);
  assert.deepEqual(exported.document.source.orderedPageIdentities, ["17 0 R", "29 0 R"]);
  assert.equal(exported.annotations.length, 1);
  assert.equal(exported.annotations[0].uuid, "live-uuid");
  assert.deepEqual(exported.annotations[0].payload, { color: "yellow", quads: [1, 2, 3, 4] });
  assert.equal(exported.annotations[0].embeddedRef, "71 0 R");
  assert.deepEqual(exported.tombstones.map((value) => value.uuid), ["deleted-uuid"]);
  assert.equal(exported.legacyIdentities[0].ref, "71 0 R");
  assert.deepEqual([...shared.files], [...before.files]);
  assert.equal(shared.writes.length, before.writes);
  assert.equal(shared.renames.length, before.renames);
  assert.equal(shared.removes.length, before.removes);
  assert.equal(shared.mkdirs.length, before.mkdirs);
  assert.deepEqual(await legacy.exportForMigration(document), exported,
    "the registered document object and source path both work as read-only export inputs");
  await assert.rejects(legacy.exportForMigration("Books/Unregistered.pdf"), {
    code: "PDF_ANNOTATION_IDENTITY_MISSING",
  });
  assert.equal(shared.writes.length, before.writes);
  assert.equal(shared.renames.length, before.renames);
  assert.equal(shared.removes.length, before.removes);
  assert.equal(shared.mkdirs.length, before.mkdirs);

  const sidecars = createSidecarStore({ adapter, root: "00_Archive/20_PDFData", hash });
  const baselineWrites = [];
  let interruptOnce = true;
  const importer = createFormat3Importer({
    legacyStore: legacy,
    sidecarStore: sidecars,
    stableHash: hash,
    persistBaseline: async (identity, sidecar) => {
      baselineWrites.push({ identity, sidecar });
      if (interruptOnce) {
        interruptOnce = false;
        throw new Error("simulated stop after durable sidecar write");
      }
    },
  });
  await assert.rejects(importer.importDocument("Books/Imported.pdf"), /simulated stop/);

  const prepared = await importer.prepareImport(exported);
  assert.equal(prepared.identity.initialPath, "Books/Imported.pdf");
  assert.equal(prepared.identity.fullSourceHash, sourceHash);
  assert.notEqual(prepared.identity.documentId, document.documentId,
    "the migrated identity is freshly derived from path and full source hash");
  const sidecarPath = sidecars.pathFor(prepared.identity);
  const interruptedSidecarText = shared.files.get(sidecarPath);
  assert.ok(interruptedSidecarText, "the one-shot sidecar remains durable after interruption");
  const persisted = await sidecars.loadSidecar(prepared.identity);
  assert.deepEqual(joinOperations(persisted.operations), prepared.expectedState);
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.kind, "pdf-reader-materialized-sidecar");
  assert.equal(persisted.document.initialPath, "Books/Imported.pdf");
  assert.deepEqual(persisted.document.source.orderedPageIdentities, ["17 0 R", "29 0 R"]);
  assert.equal(persisted.document.legacyIdentities[0].uuid, "live-uuid");
  const migratedLive = persisted.operations.find((operation) => operation.uuid === "live-uuid");
  assert.equal(migratedLive.kind, "Highlight");
  assert.equal(migratedLive.pageIndex, 1);
  assert.equal(migratedLive.embeddedRef, "71 0 R");
  assert.deepEqual(migratedLive.payload, { color: "yellow", quads: [1, 2, 3, 4] });
  assert.equal(joinOperations(persisted.operations).routing.payload.sourcePath, "Books/Imported.pdf");
  assert.ok(persisted.operations.every((operation) =>
    operation.version.rev === 1 && operation.version.deviceId === "legacy-import" && operation.seq === 0));
  assert.equal(persisted.operations.some((operation) => "parents" in operation || "batchId" in operation), false,
    "the import does not retain the old causal history");

  const recovered = await importer.importDocument("Books/Imported.pdf");
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.imported, false);
  assert.equal(baselineWrites.length, 2, "the retry seeds the WAL anchor after verifying the existing sidecar");
  assert.deepEqual(joinOperations(baselineWrites.at(-1).sidecar.operations), prepared.expectedState);
  assert.equal(shared.files.get(sidecarPath), interruptedSidecarText,
    "a repeated import leaves the valid sidecar byte-for-byte unchanged");

  const writesBeforeRepeat = shared.writes.length;
  const repeated = await importer.importDocument("Books/Imported.pdf");
  assert.equal(repeated.duplicate, true);
  assert.equal(shared.writes.length, writesBeforeRepeat, "a matching import does not rewrite the new sidecar");

  const changedLegacy = await legacy.appendOperations({
    document,
    batchId: "later-live-change",
    operations: [row("new-uuid", "Square", 1_020, { rect: [0, 0, 10, 10] })],
  });
  assert.ok(changedLegacy.acknowledged);
  const unchangedSidecarText = shared.files.get(sidecarPath);
  await assert.rejects(importer.importDocument("Books/Imported.pdf"), { code: "PDF_FORMAT3_IMPORT_CONFLICT" });
  assert.equal(shared.files.get(sidecarPath), unchangedSidecarText,
    "changed legacy state fails closed instead of overwriting the imported sidecar");
});

test("Format 3 export fails closed on an incomplete operation and never repairs it", async () => {
  const { adapter, shared } = makeAdapter();
  const legacy = makeLegacyStore(adapter);
  const document = await legacy.registerDocument({ sourcePath: "Books/Partial.pdf", source: { sourceHash: hash("partial PDF") } });
  const appended = await legacy.appendOperations({
    document,
    batchId: "partial-batch",
    operations: [row("partial", "Underline", 1_100, { quads: [0, 1, 2, 3] })],
  });
  shared.files.set(appended.batchPath, "{partial");
  const beforeWrites = shared.writes.length;
  const beforeRenames = shared.renames.length;
  const beforeRemoves = shared.removes.length;
  const beforeMkdirs = shared.mkdirs.length;
  await assert.rejects(legacy.exportForMigration("Books/Partial.pdf"), { code: "PDF_ANNOTATION_SYNC_PENDING" });
  assert.equal(shared.writes.length, beforeWrites);
  assert.equal(shared.renames.length, beforeRenames);
  assert.equal(shared.removes.length, beforeRemoves);
  assert.equal(shared.mkdirs.length, beforeMkdirs);
});

test("one-shot sidecar bytes ignore device-local source modification times", async () => {
  const { adapter } = makeAdapter();
  const legacy = makeLegacyStore(adapter);
  const sourceHash = hash("same full source bytes on both devices");
  const document = await legacy.registerDocument({
    sourcePath: "Books/Deterministic-import.pdf",
    source: {
      sourceHash,
      fastHash: sourceHash,
      size: 52_001,
      pageCount: 2,
      orderedPageIdentities: ["21 0 R", "34 0 R"],
      mtime: 1_728_000_000_000,
    },
  });
  await legacy.appendOperations({
    document,
    batchId: "deterministic-current-state",
    operations: [row("same-live-uuid", "Underline", 1_301, { quads: [[1, 2, 3, 4]] })],
  });
  await legacy.readDocument(document);
  await legacy.readDocument(document);
  const exported = await legacy.exportForMigration(document);
  const otherDeviceExport = structuredClone(exported);
  otherDeviceExport.document.source.mtime = 1_760_000_000_000;

  const firstAdapter = makeAdapter();
  const secondAdapter = makeAdapter();
  const persistedA = createSidecarStore({ adapter: firstAdapter.adapter, root: "00_Archive/20_PDFData", hash });
  const persistedB = createSidecarStore({ adapter: secondAdapter.adapter, root: "00_Archive/20_PDFData", hash });
  const importerA = createFormat3Importer({ sidecarStore: persistedA, stableHash: hash });
  const importerB = createFormat3Importer({ sidecarStore: persistedB, stableHash: hash });
  const preparedA = await importerA.prepareImport(exported);
  const preparedB = await importerB.prepareImport(otherDeviceExport);

  for (const prepared of [preparedA, preparedB]) {
    assert.equal(Object.hasOwn(prepared.sidecar.document.source, "mtime"), false);
    assert.equal(Object.hasOwn(prepared.sidecar.operations.find((operation) => operation.type === "ROUTE_SET").payload.source, "mtime"), false);
    assert.equal(prepared.sidecar.document.source.sourceHash, sourceHash);
    assert.equal(prepared.sidecar.document.source.size, 52_001);
    assert.equal(prepared.sidecar.document.source.pageCount, 2);
    assert.deepEqual(prepared.sidecar.document.source.orderedPageIdentities, ["21 0 R", "34 0 R"]);
  }
  assert.equal(preparedA.identity.documentId, preparedB.identity.documentId);
  assert.deepEqual(preparedA.sidecar.operations, preparedB.sidecar.operations);

  await Promise.all([
    persistedA.writeSidecar(preparedA.identity, preparedA.sidecar),
    persistedB.writeSidecar(preparedB.identity, preparedB.sidecar),
  ]);
  const sidecarPath = persistedA.pathFor(preparedA.identity);
  const bytesA = firstAdapter.shared.files.get(sidecarPath);
  const bytesB = secondAdapter.shared.files.get(sidecarPath);
  assert.equal(bytesA, bytesB, "sealed sidecar serialization is byte-identical across device-local mtimes");
});
