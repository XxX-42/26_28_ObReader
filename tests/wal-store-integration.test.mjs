import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";

const require = createRequire(import.meta.url);
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
const { createWalAnnotationStore } = require("../plugin/storage/wal-annotation-store.cjs");
const { createSidecarStore } = require("../plugin/storage/sidecar-store.cjs");
const { createWalStore } = require("../plugin/storage/wal-store.cjs");

const ROOT = "00_Archive/20_PDFData";

function hash(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeAdapter(shared = {
  files: new Map(), folders: new Set(), writes: [], renames: [], removes: [], mkdirs: [],
}) {
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

function makeWalStore(adapter, deviceId = "wal-device", overrides = {}) {
  let id = 0;
  return createWalAnnotationStore({
    adapter,
    root: ROOT,
    deviceId,
    uuid: () => `${deviceId}-id-${++id}`,
    hash,
    identityHash: hash,
    clock: () => 10_000 + id,
    ...overrides,
  });
}

function annotation(uuid, value = "yellow") {
  return {
    uuid,
    kind: "Highlight",
    pageIndex: 0,
    deleted: false,
    payload: { uuid, color: value, rect: [1, 2, 30, 40] },
    clock: { timestamp: 1, logical: 0, deviceId: "reader", opId: `reader-${uuid}` },
  };
}

function tombstone(uuid) {
  return {
    uuid,
    kind: "Ink",
    pageIndex: 1,
    deleted: true,
    clock: { timestamp: 2, logical: 0, deviceId: "reader", opId: `reader-delete-${uuid}` },
  };
}

function legacyAnnotation(uuid, value = "yellow") {
  return { ...annotation(uuid, value),
    clock: { timestamp: 1, logical: 0, deviceId: "old-format3-device", opId: `old-format3-${uuid}` } };
}

function legacyTombstone(uuid) {
  return { ...tombstone(uuid),
    clock: { timestamp: 2, logical: 0, deviceId: "old-format3-device", opId: `old-format3-delete-${uuid}` } };
}

function makeLegacyStore(adapter) {
  let id = 0;
  return createPdfAnnotationStore({
    adapter,
    root: ROOT,
    deviceId: "old-format3-device",
    uuid: () => `old-id-${++id}`,
    hash,
    identityHash: hash,
    clock: () => 10_000 + id,
  });
}

async function makeFormat3Fixture(adapter, path = "Books/Imported.pdf") {
  const legacy = makeLegacyStore(adapter);
  const source = {
    sourceHash: hash(`complete PDF bytes at ${path}`),
    size: 8_192,
    pageCount: 2,
    orderedPageIdentities: ["17 0 R", "29 0 R"],
  };
  const document = await legacy.registerDocument({ sourcePath: path, source });
  await legacy.appendOperations({
    document,
    batchId: "format3-live-and-delete",
    operations: [legacyAnnotation("legacy-live"), legacyAnnotation("legacy-removed", "blue")],
  });
  await legacy.readDocument(document);
  await legacy.readDocument(document);
  await legacy.appendOperations({
    document,
    batchId: "format3-tombstone",
    operations: [legacyTombstone("legacy-removed")],
  });
  const exported = await legacy.exportForMigration(path);
  assert.equal(exported.formatVersion, 3, "fixture is a real persisted Format 3 export");
  assert.equal(exported.snapshot.annotations.length, 1);
  assert.equal(exported.snapshot.tombstones.length, 1);
  return { legacy, document, source, exported };
}

test("Format 3 migration preserves effective live rows and tombstones through WAL recovery", async () => {
  const { adapter } = makeAdapter();
  const fixture = await makeFormat3Fixture(adapter);
  const store = makeWalStore(adapter);
  const migrated = await store.registerDocument({ sourcePath: fixture.document.sourcePath, source: fixture.source });
  const snapshot = await store.readDocument(migrated);

  assert.equal(snapshot.storageProtocol, "wal-sidecar-v3.1");
  assert.equal(snapshot.annotations.length, 1);
  assert.equal(snapshot.annotations[0].uuid, "legacy-live");
  assert.equal(snapshot.annotations[0].payload.color, "yellow");
  assert.deepEqual(snapshot.tombstones.map((row) => row.uuid), ["legacy-removed"]);
});

test("registry deletion is repaired from verified sidecar and WAL records", async () => {
  const { adapter, shared } = makeAdapter();
  const store = makeWalStore(adapter);
  const path = "Books/Registry-rebuild.pdf";
  const source = { sourceHash: hash("registry rebuild PDF") };
  const document = await store.registerDocument({ sourcePath: path, source });
  const snapshotPath = store.pathsFor(document).registry;
  assert.equal(shared.files.has(snapshotPath), true);

  shared.files.delete(snapshotPath);
  const reopened = makeWalStore(adapter);
  const found = await reopened.documentForPath(path);
  assert.equal(found.documentId, document.documentId);
  assert.equal(shared.files.has(snapshotPath), true, "the derived registry cache is rebuilt");
});

test("an unverified pending header cannot impersonate a verified docKey", async () => {
  const { adapter, shared } = makeAdapter();
  const store = makeWalStore(adapter);
  const path = "Books/Pending-header.pdf";
  const document = await store.registerDocument({ path, sourcePath: path, source: { sourceHash: hash("pending-header PDF") } });
  const forgedPath = `${ROOT}/sidecars/${document.docKey}.annot.json.pending`;
  shared.files.set(forgedPath, JSON.stringify({
    document: { docKey: document.docKey, documentId: "forged-different-identity" },
  }));

  const reopened = makeWalStore(adapter);
  const found = await reopened.documentForPath(path);
  assert.equal(found.documentId, document.documentId);
});

test("a stale registry documentId is ignored and rebuilt from verified records", async () => {
  const { adapter, shared } = makeAdapter();
  const store = makeWalStore(adapter);
  const path = "Books/Wrong-registry-id.pdf";
  const document = await store.registerDocument({ sourcePath: path, source: { sourceHash: hash("wrong-registry-id PDF") } });
  const registryPath = store.pathsFor(document).registry;
  shared.files.set(registryPath, JSON.stringify({
    schemaVersion: 1,
    kind: "pdf-reader-registry-cache",
    entries: { [path]: { documentId: "stale-wrong-id", docKey: document.docKey } },
  }));

  const reopened = makeWalStore(adapter);
  const found = await reopened.documentForPath(path);
  assert.equal(found.documentId, document.documentId);
  const rebuilt = JSON.parse(shared.files.get(registryPath));
  assert.equal(rebuilt.entries[path].documentId, document.documentId);
});

test("two integrity-validated identities sharing one docKey fail closed", async () => {
  const { adapter, shared } = makeAdapter();
  const sourcePath = "Books/Colliding-docKey.pdf";
  const source = { sourceHash: hash("colliding docKey source") };
  const docKey = "abcdef012345";
  for (const deviceId of ["collision-device-a", "collision-device-b"]) {
    const documentId = deviceId === "collision-device-a" ? "identity-a" : "identity-b";
    const document = { documentId, docKey, sourcePath, initialPath: sourcePath,
      fullSourceHash: source.sourceHash, source };
    const walStore = createWalStore({ adapter, root: ROOT, hash, deviceId });
    await walStore.writeWal(document, {
      schemaVersion: 1,
      kind: "pdf-reader-device-wal",
      documentId,
      docKey,
      deviceId,
      document,
      nextSeq: 1,
      anchor: { throughSeq: 0, operations: [{
        type: "ROUTE_SET",
        seq: 0,
        opId: `${deviceId}:route`,
        version: { rev: 1, deviceId, seq: 0 },
        payload: { sourcePath, source },
      }] },
      tail: [],
    });
  }

  // A valid cache hint must not let the fast path mask the other verified
  // identity which shares this docKey.
  shared.files.set(`${ROOT}/_registry.json`, JSON.stringify({
    schemaVersion: 1,
    kind: "pdf-reader-registry-cache",
    entries: { [sourcePath]: { documentId: "identity-a", docKey } },
  }));
  const store = makeWalStore(adapter);
  await assert.rejects(store.documentForPath(sourcePath), { code: "DOC_KEY_COLLISION" });
});

test("distinct verified identities routing to one path fail closed after discovery and cache invalidation", async () => {
  const sourcePath = "Books/Distinct-identities-same-route.pdf";
  const source = { sourceHash: hash("same routed PDF bytes") };

  async function writeIdentity(adapter, { documentId, docKey, deviceId }) {
    const document = { documentId, docKey, sourcePath, initialPath: sourcePath,
      fullSourceHash: source.sourceHash, source };
    const walStore = createWalStore({ adapter, root: ROOT, hash, deviceId });
    await walStore.writeWal(document, {
      schemaVersion: 1,
      kind: "pdf-reader-device-wal",
      documentId,
      docKey,
      deviceId,
      document,
      nextSeq: 1,
      anchor: { throughSeq: 0, operations: [{
        type: "ROUTE_SET",
        seq: 0,
        opId: `${deviceId}:route`,
        version: { rev: 1, deviceId, seq: 0 },
        payload: { sourcePath, source },
      }] },
      tail: [],
    });
  }

  // A fresh process must detect both identities in its first verified scan.
  const fresh = makeAdapter();
  await writeIdentity(fresh.adapter, { documentId: "route-identity-a", docKey: "123456abcdef", deviceId: "route-device-a" });
  await writeIdentity(fresh.adapter, { documentId: "route-identity-b", docKey: "fedcba654321", deviceId: "route-device-b" });
  const freshStore = makeWalStore(fresh.adapter);
  await assert.rejects(freshStore.documentForPath(sourcePath), { code: "IDENTITY_ROUTE_CONFLICT" });

  // A previously valid registry entry must stop being authoritative after a
  // root Vault event invalidates this process's verified-routing generation.
  const cached = makeAdapter();
  const identityA = { documentId: "cached-route-identity-a", docKey: "a123456789bc", deviceId: "cached-route-device-a" };
  const identityB = { documentId: "cached-route-identity-b", docKey: "b123456789ac", deviceId: "cached-route-device-b" };
  await writeIdentity(cached.adapter, identityA);
  const cachedStore = makeWalStore(cached.adapter);
  assert.equal((await cachedStore.documentForPath(sourcePath)).documentId, identityA.documentId);
  await writeIdentity(cached.adapter, identityB);
  cachedStore.invalidateRegistry();
  await assert.rejects(cachedStore.documentForPath(sourcePath), { code: "IDENTITY_ROUTE_CONFLICT" });
});

test("a verified pending sidecar is discoverable after a staged-write crash and WAL loss", async () => {
  const { adapter, shared } = makeAdapter();
  const store = makeWalStore(adapter);
  const path = "Books/Sidecar-rollback.pdf";
  const source = { sourceHash: hash("sidecar rollback PDF") };
  const document = await store.registerDocument({ sourcePath: path, source });
  const sidecars = createSidecarStore({ adapter, root: ROOT, hash });
  const stagedValue = await sidecars.loadSidecar(document);
  const sidecarPath = sidecars.pathFor(document);
  // Model a crash after the pending file is completely written and verified,
  // but before the atomic rename installs it at the canonical path.
  shared.files.set(`${sidecarPath}.pending`, shared.files.get(sidecarPath));
  shared.files.delete(sidecarPath);
  for (const walPath of [...shared.files.keys()]) {
    if (walPath.startsWith(`${ROOT}/wal/`)) shared.files.delete(walPath);
  }
  const reopened = makeWalStore(adapter);
  const found = await reopened.documentForPath(path);
  assert.equal(found.documentId, document.documentId,
    "a verified .pending sidecar is a discovery source when no WAL shard remains");
  const recovered = await reopened.readEffective(found);
  assert.equal(recovered.sidecar.integrity, stagedValue.integrity);
});

test("failed sidecar replacement rolls back to the last verified primary", async () => {
  const { adapter, shared } = makeAdapter();
  const store = makeWalStore(adapter);
  const path = "Books/Sidecar-write-rollback.pdf";
  const source = { sourceHash: hash("sidecar write rollback PDF") };
  const document = await store.registerDocument({ sourcePath: path, source });
  const sidecars = createSidecarStore({ adapter, root: ROOT, hash });
  const before = await sidecars.loadSidecar(document);
  const sidecarPath = sidecars.pathFor(document);
  const originalWrite = adapter.write;
  adapter.write = async (target, value) => {
    if (target === sidecarPath) throw new Error("injected primary replacement failure");
    return originalWrite(target, value);
  };

  await assert.rejects(sidecars.writeSidecar(document, {
    ...before,
    operations: [...before.operations, {
      type: "ROUTE_SET", seq: 1, opId: "rollback-route", version: { rev: 2, deviceId: "rollback-device", seq: 1 },
      payload: { sourcePath: path, source, legacyIdentities: [], legacyIdentityScanComplete: false },
    }],
  }));
  adapter.write = originalWrite;

  const after = await sidecars.loadSidecar(document);
  assert.equal(after.integrity, before.integrity);
  assert.deepEqual(after.operations, before.operations);
  assert.equal(shared.files.has(`${sidecarPath}.pending`), true,
    "failed staged replacement remains available for diagnosis/retry while valid primary stays authoritative");
});

test("same-path source replacement cannot hydrate or append against the prior PDF identity", async () => {
  const { adapter } = makeAdapter();
  const path = "Books/Replacement.pdf";
  const oldSource = { sourceHash: hash("old PDF at a stable path") };
  const store = makeWalStore(adapter);
  const oldDocument = await store.registerDocument({ sourcePath: path, source: oldSource });
  await store.appendOperations({ document: oldDocument, batchId: "old-edit", operations: [annotation("old-uuid")] });

  const replacement = await store.registerDocument({
    sourcePath: path,
    source: { sourceHash: hash("different replacement PDF at same path") },
  });
  assert.equal(replacement.documentId, oldDocument.documentId);
  assert.equal(replacement.sourceMismatch, true);
  await assert.rejects(store.readDocument(replacement), { code: "SOURCE_MISMATCH" });
  await assert.rejects(store.appendOperations({
    document: replacement,
    sourceHash: replacement.source.sourceHash,
    batchId: "wrong-source-edit",
    operations: [annotation("replacement-edit")],
  }), { code: "SOURCE_MISMATCH" });
});

test("copying a renamed PDF back to its original path is reported as identity ambiguity", async () => {
  const { adapter, shared } = makeAdapter();
  const originalPath = "Books/Original.pdf";
  const movedPath = "Books/Moved.pdf";
  shared.files.set(originalPath, "PDF bytes");
  const source = { sourceHash: hash("PDF bytes") };
  const store = makeWalStore(adapter);
  const original = await store.registerDocument({ sourcePath: originalPath, source });
  shared.files.delete(originalPath);
  shared.files.set(movedPath, "PDF bytes");

  await store.renameDocument({ documentId: original.documentId, fromPath: originalPath, toPath: movedPath });
  shared.files.set(originalPath, "copied PDF bytes");
  await assert.rejects(
    store.registerDocument({ sourcePath: originalPath, source }),
    { code: "IDENTITY_AMBIGUOUS_COPY" },
  );
});

test("a renamed PDF waits for its route operation instead of creating an empty identity", async () => {
  const { adapter, shared } = makeAdapter();
  const originalPath = "Books/Sync-before-route.pdf";
  const movedPath = "Books/Sync-after-route.pdf";
  shared.files.set(originalPath, "same PDF bytes");
  const source = { sourceHash: hash("same PDF bytes") };
  const store = makeWalStore(adapter, "rename-device");
  const original = await store.registerDocument({ sourcePath: originalPath, source });
  await store.appendOperations({ document: original, batchId: "before-rename", operations: [annotation("keep-this-uuid")] });

  // Model another device observing the PDF move before its ROUTE_SET syncs.
  shared.files.delete(originalPath);
  shared.files.set(movedPath, "same PDF bytes");
  await assert.rejects(
    store.registerDocument({ sourcePath: movedPath, source }),
    { code: "IDENTITY_ROUTING_UNCONFIRMED" },
  );

  const moved = await store.renameDocument({ documentId: original.documentId, fromPath: originalPath, toPath: movedPath });
  const reopened = await store.registerDocument({ sourcePath: movedPath, source });
  const snapshot = await store.readDocument(reopened);
  assert.equal(moved.documentId, original.documentId);
  assert.equal(reopened.documentId, original.documentId);
  assert.equal(snapshot.annotations[0].uuid, "keep-this-uuid");
});

test("duplicate save retries are idempotent across concurrent store instances", async () => {
  const { adapter } = makeAdapter();
  const first = makeWalStore(adapter, "shared-device");
  const second = makeWalStore(adapter, "shared-device");
  const path = "Books/Repeated-save.pdf";
  const source = { sourceHash: hash("repeated save PDF") };
  const document = await first.registerDocument({ sourcePath: path, source });
  const otherViewDocument = await second.registerDocument({ sourcePath: path, source });
  const save = {
    document,
    batchId: "same-reader-batch",
    operations: [annotation("same-uuid", "green")],
  };
  const [left, right] = await Promise.all([
    first.appendOperations(save),
    second.appendOperations({ ...save, document: otherViewDocument }),
  ]);
  const snapshot = await first.readDocument(document);

  assert.equal(left.acknowledged, true);
  assert.equal(right.acknowledged, true);
  assert.equal(left.operationCount + right.operationCount, 1,
    "only one of the two views appends the stable reader opId");
  assert.equal(snapshot.annotations.length, 1);
  assert.equal(snapshot.revision, 1, "a retry from a second view does not create another logical operation");
});

test("duplicate stable opIds in one save batch append only once", async () => {
  const { adapter } = makeAdapter();
  const store = makeWalStore(adapter, "batch-device");
  const path = "Books/Duplicate-in-batch.pdf";
  const source = { sourceHash: hash("duplicate in batch PDF") };
  const document = await store.registerDocument({ sourcePath: path, source });
  const row = annotation("same-batch-uuid", "teal");
  const result = await store.appendOperations({
    document,
    batchId: "duplicate-rows",
    operations: [row, { ...row, payload: { ...row.payload } }],
  });

  assert.equal(result.operationCount, 1);
  const snapshot = await store.readDocument(document);
  assert.equal(snapshot.annotations.length, 1);
  assert.equal(snapshot.revision, 1);
});

test("compaction safely replays the same assigned operation from sidecar and WAL anchor", async () => {
  const { adapter, shared } = makeAdapter();
  const path = "Books/Compacted-operation-replay.pdf";
  const source = { sourceHash: hash("compacted operation replay PDF") };
  const first = makeWalStore(adapter, "writer-a", { maintenance: { tailOperations: 1, walBytes: 512 * 1024 } });
  const document = await first.registerDocument({ sourcePath: path, source });
  await first.appendOperations({ document, batchId: "writer-a-1", operations: [annotation("stable-uuid", "green")] });
  await first.materializeSnapshot(document);

  const walPath = `${first.pathsFor(document).walRoot}/writer-a/${document.docKey}.json`;
  const wal = JSON.parse(shared.files.get(walPath));
  const assigned = wal.anchor.annotations["stable-uuid"];
  const sidecar = JSON.parse(shared.files.get(first.pathsFor(document).snapshot));
  assert.deepEqual(sidecar.annotations["stable-uuid"], assigned,
    "the compacted sidecar and anchor retain the exact same assigned WAL operation");

  const effective = await first.readEffective(document);
  assert.equal(Object.keys(effective.state.annotations).length, 1);
  assert.deepEqual(effective.state.annotations["stable-uuid"], assigned,
    "replaying an already assigned operation is idempotent across the compacted records");
  const restarted = makeWalStore(adapter, "writer-a");
  const reopened = await restarted.registerDocument({ sourcePath: path, source });
  const snapshot = await restarted.readDocument(reopened);
  assert.equal(snapshot.annotations.length, 1);
  assert.equal(snapshot.annotations[0].payload.color, "green");
});

test("materialization never seeds a missing WAL below its sidecar watermark", async () => {
  const { adapter, shared } = makeAdapter();
  const path = "Books/Missing-shard-watermark.pdf";
  const source = { sourceHash: hash("missing shard watermark PDF") };
  const first = makeWalStore(adapter, "writer-a", { maintenance: { tailOperations: 1, walBytes: 512 * 1024 } });
  const second = makeWalStore(adapter, "writer-b");
  const documentA = await first.registerDocument({ sourcePath: path, source });
  const documentB = await second.registerDocument({ sourcePath: path, source });
  const firstEdit = annotation("watermarked-uuid", "old-a1");
  firstEdit.clock.opId = "watermark-origin-1";
  const secondEdit = annotation("watermarked-uuid", "old-a2");
  secondEdit.clock.opId = "watermark-origin-2";
  await first.appendOperations({ document: documentA, batchId: "writer-a-1", operations: [firstEdit] });
  await first.appendOperations({ document: documentA, batchId: "writer-a-2", operations: [secondEdit] });
  await second.appendOperations({ document: documentB, batchId: "writer-b-1", operations: [annotation("watermarked-uuid", "winner-b")] });
  await first.materializeSnapshot(documentA);

  const sidecarPath = first.pathsFor(documentA).snapshot;
  const sidecar = JSON.parse(shared.files.get(sidecarPath));
  assert.equal(sidecar.watermark["writer-a"], 2);
  const walPath = `${first.pathsFor(documentA).walRoot}/writer-a/${documentA.docKey}.json`;
  shared.files.delete(walPath);

  await assert.rejects(first.materializeSnapshot(documentA), { code: "WAL_SEQ_REGRESSION" });
  assert.equal(shared.files.has(walPath), false,
    "a sidecar watermark prevents a fresh low-sequence WAL from being published while the shard is missing");
});
