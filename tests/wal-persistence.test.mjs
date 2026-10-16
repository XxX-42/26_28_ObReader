import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";
import xxhash from "xxhash-wasm";

const require = createRequire(import.meta.url);
const { createSidecarStore } = require("../plugin/storage/sidecar-store.cjs");
const { createWalStore } = require("../plugin/storage/wal-store.cjs");
const { createWalWriterCoordinator } = require("../plugin/storage/wal-writer-coordinator.cjs");
const { h64Raw } = await xxhash();

function hash(value) {
  return `sha256-v1:${createHash("sha256").update(value).digest("hex")}`;
}

function xxhHash(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(value);
  return `xxh64-v1:${h64Raw(bytes).toString(16).padStart(16, "0")}`;
}

function verifyEitherHash(bytes, expected) {
  return expected.startsWith("sha256-v1:") ? hash(bytes) === expected : xxhHash(bytes) === expected;
}

function makeAdapter() {
  const files = new Map();
  const folders = new Set();
  const control = { beforeWrite: null, beforeRename: null };
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) {
      if (!files.has(path)) throw Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
      return files.get(path);
    },
    async write(path, value) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent && !folders.has(parent)) throw new Error(`parent directory missing: ${parent}`);
      if (control.beforeWrite) await control.beforeWrite(path, value);
      files.set(path, value);
    },
    async rename(from, to) {
      if (control.beforeRename) await control.beforeRename(from, to);
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
        if (remainder.includes("/")) directFolders.add(`${path}/${remainder.split("/")[0]}`);
        else directFiles.push(file);
      }
      for (const folder of folders) {
        if (!folder.startsWith(prefix)) continue;
        const remainder = folder.slice(prefix.length);
        if (remainder && !remainder.includes("/")) directFolders.add(folder);
      }
      return { files: directFiles, folders: [...directFolders] };
    },
  };
  return { adapter, files, folders, control };
}

function documentIdentity() {
  const fullSourceHash = hash(new TextEncoder().encode("source PDF"));
  return {
    documentId: "doc-identity-1",
    docKey: "0123456789ab",
    initialPath: "Books/Example.pdf",
    fullSourceHash,
    source: { fullHash: fullSourceHash, size: 2048, pageIdentities: ["page-a"] },
    sourcePath: "Books/Example.pdf",
    legacyIdentities: [],
    legacyIdentityScanComplete: true,
  };
}

function operation({ type = "ANNOTATION_SET", uuid = "ink-1", deviceId, seq, label, rev = 1 }) {
  return {
    type,
    uuid,
    kind: "Ink",
    pageIndex: 0,
    seq,
    opId: `${deviceId}-${seq}-${label}`,
    version: { rev, deviceId, seq },
    ...(type === "ANNOTATION_SET" ? { payload: { uuid, kind: "Ink", pageIndex: 0, label } } : {}),
  };
}

function stores(world, doc, deviceId) {
  const sidecarStore = createSidecarStore({ adapter: world.adapter, root: "data", hash });
  const walStore = createWalStore({ adapter: world.adapter, root: "data", hash, deviceId, sidecarStore });
  return { sidecarStore, walStore };
}

function wal(document, deviceId, { anchor = [], throughSeq = 0, tail = [], nextSeq = 1 } = {}) {
  return {
    schemaVersion: 1,
    kind: "pdf-reader-device-wal",
    documentId: document.documentId,
    docKey: document.docKey,
    deviceId,
    document,
    anchor: { throughSeq, operations: anchor },
    tail,
    nextSeq,
  };
}

function sidecar(document, operations) {
  return {
    schemaVersion: 1,
    kind: "pdf-reader-materialized-sidecar",
    document,
    operations,
    watermark: {},
  };
}

test("sidecar write failure restores the last valid file", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const { sidecarStore } = stores(world, document, "device-a");
  const first = operation({ deviceId: "device-a", seq: 1, label: "first" });
  const second = operation({ deviceId: "device-a", seq: 2, label: "second" });
  const path = sidecarStore.pathFor(document);
  await sidecarStore.writeSidecar(document, sidecar(document, [first]));
  const original = world.files.get(path);

  let failOnce = true;
  world.control.beforeWrite = async (writePath) => {
    if (writePath !== path || !failOnce) return;
    failOnce = false;
    world.files.set(path, "{partial JSON");
    throw new Error("simulated replacement failure");
  };
  await assert.rejects(sidecarStore.writeSidecar(document, sidecar(document, [second])));
  world.control.beforeWrite = null;

  assert.equal(world.files.get(path), original, "the previous complete sidecar is restored after replacement failure");
  const restored = await sidecarStore.loadSidecar(document);
  assert.deepEqual(restored.operations.map(({ opId }) => opId), [first.opId]);
  assert.equal([...world.files.keys()].some((file) => file.endsWith(".previous")), false);
});

test("a partial canonical JSON file recovers from the verified pending write", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const { sidecarStore } = stores(world, document, "device-a");
  const saved = operation({ deviceId: "device-a", seq: 1, label: "recover-me" });
  const path = sidecarStore.pathFor(document);
  await sidecarStore.writeSidecar(document, sidecar(document, [saved]));
  world.files.set(`${path}.pending`, world.files.get(path));
  world.files.set(path, "{\"schemaVersion\":1,");

  const recovered = await sidecarStore.loadSidecar(document);
  assert.deepEqual(recovered.operations.map(({ opId }) => opId), [saved.opId]);
});

test("a failed staging write leaves the prior sidecar intact across a crash boundary", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const { sidecarStore } = stores(world, document, "device-a");
  const first = operation({ deviceId: "device-a", seq: 1, label: "first" });
  const second = operation({ deviceId: "device-a", seq: 2, label: "second" });
  const path = sidecarStore.pathFor(document);
  await sidecarStore.writeSidecar(document, sidecar(document, [first]));
  const original = world.files.get(path);

  let failOnce = true;
  world.control.beforeWrite = async (writePath) => {
    if (writePath !== `${path}.pending` || !failOnce) return;
    failOnce = false;
    world.files.set(writePath, "{truncated");
    throw new Error("simulated process interruption during staging");
  };
  await assert.rejects(sidecarStore.writeSidecar(document, sidecar(document, [second])));
  world.control.beforeWrite = null;

  assert.equal(world.files.get(path), original);
  assert.deepEqual((await sidecarStore.loadSidecar(document)).operations.map(({ opId }) => opId), [first.opId]);
});

test("writing a subset preserves unrelated winners and tombstones from the existing sidecar", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const { sidecarStore } = stores(world, document, "device-a");
  const preserved = operation({ uuid: "kept-annotation", deviceId: "device-a", seq: 1, label: "keep" });
  const tombstone = operation({ type: "ANNOTATION_DELETE", uuid: "kept-tombstone", deviceId: "device-a", seq: 2, label: "delete" });
  const incoming = operation({ uuid: "new-annotation", deviceId: "device-a", seq: 3, label: "add" });
  await sidecarStore.writeSidecar(document, sidecar(document, [preserved, tombstone]));
  await sidecarStore.writeSidecar(document, sidecar(document, [incoming]));

  const loaded = await sidecarStore.loadSidecar(document);
  assert.equal(loaded.annotations[preserved.uuid].opId, preserved.opId);
  assert.equal(loaded.tombstones[tombstone.uuid].opId, tombstone.opId);
  assert.equal(loaded.annotations[incoming.uuid].opId, incoming.opId);
  assert.equal(loaded.watermark["device-a"], 3);
});

test("the current hash runtime verifies sidecars sealed by the previous algorithm", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const path = `data/sidecars/${document.docKey}.annot.json`;
  const legacyOp = operation({ deviceId: "device-a", seq: 1, label: "sha-sealed" });
  const shaStore = createSidecarStore({ adapter: world.adapter, root: "data", hash });
  await shaStore.writeSidecar(document, sidecar(document, [legacyOp]));

  const migratedStore = createSidecarStore({
    adapter: world.adapter,
    root: "data",
    hash: xxhHash,
    verifyHash: verifyEitherHash,
  });
  assert.deepEqual((await migratedStore.loadSidecar(document)).operations.map(({ opId }) => opId), [legacyOp.opId]);
  const nextOp = operation({ uuid: "ink-2", deviceId: "device-a", seq: 2, label: "xxh-sealed" });
  await migratedStore.writeSidecar(document, sidecar(document, [nextOp]));

  assert.match(JSON.parse(world.files.get(path)).integrity, /^xxh64-v1:[a-f0-9]{16}$/);
  assert.deepEqual((await migratedStore.loadSidecar(document)).operations.map(({ opId }) => opId), [legacyOp.opId, nextOp.opId]);
});

test("WAL writes enforce owner identity and persist the agreed device-WAL schema", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const { walStore } = stores(world, document, "device-a");
  const foreign = operation({ deviceId: "device-b", seq: 1, label: "foreign" });
  await assert.rejects(walStore.writeWal(document, wal(document, "device-b", {
    anchor: [foreign], throughSeq: 1, nextSeq: 2,
  })), { code: "WAL_OWNER_MISMATCH" });
  await assert.rejects(walStore.writeWal(document, wal(document, "device-a", {
    tail: [foreign], nextSeq: 2,
  })), { code: "WAL_OWNER_MISMATCH" });

  const baselineDocument = { ...document, docKey: "legacy-baseline" };
  const baseline = operation({ deviceId: "legacy-import", seq: 0, rev: 1, label: "imported" });
  await walStore.writeWal(baselineDocument, wal(baselineDocument, "device-a", {
    anchor: [baseline], throughSeq: 0, nextSeq: 1,
  }));
  assert.equal((await walStore.readWal(baselineDocument)).anchor.operations[0].opId, baseline.opId,
    "the importer baseline is the only foreign actor accepted in an anchor");

  const own = operation({ deviceId: "device-a", seq: 1, label: "own" });
  await walStore.writeWal(document, wal(document, "device-a", { tail: [own], nextSeq: 2 }));
  const disk = JSON.parse(world.files.get(walStore.pathFor(document)));
  assert.equal(disk.schemaVersion, 1);
  assert.equal(disk.kind, "pdf-reader-device-wal");
  assert.deepEqual(Object.keys(disk.anchor).sort(), ["annotations", "routing", "throughSeq", "tombstones"]);
  assert.equal("operations" in disk.anchor, false);
  assert.deepEqual((await walStore.readWal(document)).tail.map(({ opId }) => opId), [own.opId]);
});

test("a device WAL rejects reusing one owner sequence for different anchored annotations", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const { walStore } = stores(world, document, "device-a");
  const first = operation({ uuid: "first-uuid", deviceId: "device-a", seq: 1, label: "first" });
  const second = operation({ uuid: "second-uuid", deviceId: "device-a", seq: 1, label: "second" });

  await assert.rejects(walStore.writeWal(document, wal(document, "device-a", {
    anchor: [first, second], throughSeq: 1, nextSeq: 2,
  })), { code: "WAL_SEQUENCE_COLLISION" });
});

test("a sidecar rejects reusing one device sequence for different annotation map entries", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const { sidecarStore } = stores(world, document, "device-a");
  const first = operation({ uuid: "first-uuid", deviceId: "device-a", seq: 1, label: "first" });
  const second = operation({ uuid: "second-uuid", deviceId: "device-a", seq: 1, label: "second" });

  await assert.rejects(sidecarStore.writeSidecar(document, sidecar(document, [first, second])), {
    code: "WAL_SEQUENCE_COLLISION",
  });
});

test("a valid sidecar for another documentId at the same docKey raises DOC_KEY_COLLISION", async () => {
  const world = makeAdapter();
  const firstIdentity = documentIdentity();
  const otherIdentity = { ...firstIdentity, documentId: "doc-identity-2" };
  const sidecars = createSidecarStore({ adapter: world.adapter, root: "data", hash });
  await sidecars.writeSidecar(otherIdentity, sidecar(otherIdentity, []));

  await assert.rejects(sidecars.loadSidecar(firstIdentity), { code: "DOC_KEY_COLLISION" });
  await assert.rejects(sidecars.writeSidecar(firstIdentity, sidecar(firstIdentity, [])), { code: "DOC_KEY_COLLISION" });
});

test("a valid WAL for another documentId at the same docKey and owner raises DOC_KEY_COLLISION", async () => {
  const world = makeAdapter();
  const firstIdentity = documentIdentity();
  const otherIdentity = { ...firstIdentity, documentId: "doc-identity-2" };
  const walStore = createWalStore({ adapter: world.adapter, root: "data", hash, deviceId: "device-a" });
  await walStore.writeWal(otherIdentity, wal(otherIdentity, "device-a"));

  await assert.rejects(walStore.readWal(firstIdentity), { code: "DOC_KEY_COLLISION" });
});

test("a valid Sync rollback is rejected after higher WAL sequence progress was observed", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const firstStore = stores(world, document, "device-a").walStore;
  const initialRows = [
    operation({ deviceId: "device-a", seq: 1, label: "one" }),
    operation({ deviceId: "device-a", seq: 2, label: "two" }),
  ];
  await firstStore.writeWal(document, wal(document, "device-a", { tail: initialRows, nextSeq: 3 }));
  const oldVerifiedBytes = world.files.get(firstStore.pathFor(document));
  const anchored = operation({ deviceId: "device-a", seq: 4, label: "anchor-four" });
  const advanced = operation({ deviceId: "device-a", seq: 5, label: "tail-five" });
  await firstStore.writeWal(document, wal(document, "device-a", {
    anchor: [anchored],
    throughSeq: 4,
    tail: [advanced],
    nextSeq: 6,
  }), { allowPrune: true });

  world.files.set(firstStore.pathFor(document), oldVerifiedBytes);
  const secondStore = stores(world, document, "device-a").walStore;
  await assert.rejects(secondStore.readWal(document), { code: "WAL_SEQ_REGRESSION" });
});

test("writer coordinators serialize instances sharing one adapter and document", async () => {
  const adapter = {};
  const first = createWalWriterCoordinator();
  const second = createWalWriterCoordinator();
  const events = [];
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const writeA = first.run(adapter, "device-a", "doc-a", async () => {
    events.push("first-start");
    entered();
    await gate;
    events.push("first-end");
  });
  const writeB = second.run(adapter, "device-a", "doc-a", async () => events.push("second"));
  await started;
  assert.deepEqual(events, ["first-start"]);
  release();
  await Promise.all([writeA, writeB]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("compaction keeps a sidecar-only witness, then evicts a zombie when another WAL durably witnesses its winner", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const local = stores(world, document, "a-local");
  const remote = stores(world, document, "z-remote");
  const oldSet = operation({ deviceId: "a-local", seq: 1, label: "old-local" });
  const remoteDelete = operation({ type: "ANNOTATION_DELETE", deviceId: "z-remote", seq: 1, label: "remote-delete" });

  await local.walStore.writeWal(document, wal(document, "a-local", {
    anchor: [oldSet], throughSeq: 1, nextSeq: 2,
  }));
  await local.sidecarStore.writeSidecar(document, sidecar(document, [remoteDelete]));
  await local.walStore.compact(document);
  let localWal = await local.walStore.readWal(document);
  assert.deepEqual(localWal.anchor.operations.map(({ opId }) => opId), [oldSet.opId],
    "the sidecar alone cannot authorize dropping the only WAL witness of an older local operation");

  await remote.walStore.writeWal(document, wal(document, "z-remote", {
    anchor: [remoteDelete], throughSeq: 1, nextSeq: 2,
  }));
  await local.walStore.compact(document);
  localWal = await local.walStore.readWal(document);
  assert.deepEqual(localWal.anchor.operations, [],
    "a durable winning tombstone in another valid WAL allows the dominated local anchor row to be evicted");
  assert.deepEqual(Object.keys(JSON.parse(world.files.get(local.walStore.pathFor(document))).anchor.annotations), []);
  assert.equal((await local.sidecarStore.loadSidecar(document)).tombstones["ink-1"].opId, remoteDelete.opId);
});

test("compaction keeps only the local winner for repeated edits to one annotation", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const local = stores(world, document, "device-a");
  const edits = Array.from({ length: 10 }, (_, index) => {
    const seq = index + 1;
    return operation({ deviceId: "device-a", seq, rev: seq, label: `edit-${seq}` });
  });
  await local.walStore.writeWal(document, wal(document, "device-a", {
    tail: edits,
    nextSeq: edits.length + 1,
  }));

  await local.walStore.compact(document);

  const compacted = await local.walStore.readWal(document);
  assert.equal(compacted.anchor.operations.length, 1,
    "the compacted anchor needs only the local winner for this annotation");
  assert.equal(compacted.anchor.operations[0].opId, edits.at(-1).opId);
  assert.equal(compacted.anchor.operations[0].payload.label, "edit-10");
  assert.deepEqual(compacted.tail, []);
});

test("a remote tombstone WAL witness lets compaction discard all dominated local payloads", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const local = stores(world, document, "device-a");
  const remote = stores(world, document, "device-z");
  const edits = Array.from({ length: 4 }, (_, index) => {
    const seq = index + 1;
    return operation({ deviceId: "device-a", seq, rev: seq, label: `private-old-${seq}` });
  });
  const tombstone = operation({ type: "ANNOTATION_DELETE", deviceId: "device-z", seq: 1, rev: 100, label: "deleted" });
  await local.walStore.writeWal(document, wal(document, "device-a", {
    tail: edits,
    nextSeq: edits.length + 1,
  }));
  await remote.walStore.writeWal(document, wal(document, "device-z", {
    anchor: [tombstone], throughSeq: 1, nextSeq: 2,
  }));

  await local.walStore.compact(document);

  const compacted = await local.walStore.readWal(document);
  assert.deepEqual(compacted.anchor.operations, [],
    "the other valid WAL is durable proof of the winning tombstone");
  assert.deepEqual(compacted.tail, []);
});

test("devices materializing the same observed state write identical canonical sidecars", async () => {
  const world = makeAdapter();
  const document = documentIdentity();
  const deviceA = stores(world, document, "device-a");
  const deviceB = stores(world, document, "device-b");
  const first = operation({ deviceId: "device-a", seq: 1, label: "from-a" });
  const second = operation({ deviceId: "device-b", seq: 1, label: "from-b", uuid: "ink-2" });
  await deviceA.walStore.writeWal(document, wal(document, "device-a", { tail: [first], nextSeq: 2 }));
  await deviceB.walStore.writeWal(document, wal(document, "device-b", { tail: [second], nextSeq: 2 }));

  await deviceA.walStore.compact(document);
  const sidecarPath = deviceA.sidecarStore.pathFor(document);
  const fromA = world.files.get(sidecarPath);
  await deviceB.walStore.compact(document);
  const fromB = world.files.get(sidecarPath);

  assert.equal(fromB, fromA,
    "equal state and watermarks must produce byte-identical canonical sidecar envelopes");
});

test("compaction rejects verified contributors with conflicting immutable source metadata before writing", async () => {
  const world = makeAdapter();
  const fullSourceHash = hash(new TextEncoder().encode("source PDF"));
  const document = {
    ...documentIdentity(),
    source: {
      sourceHash: fullSourceHash,
      size: 2048,
      pageCount: 1,
      orderedPageIdentities: ["page-a"],
    },
  };
  const local = stores(world, document, "device-a");
  const originalWal = wal(document, "device-a");
  await local.walStore.writeWal(document, originalWal);
  const mismatchedDocument = {
    ...document,
    source: { ...document.source, pageCount: 2 },
  };
  await local.sidecarStore.writeSidecar(document, {
    ...sidecar(document, []),
    document: mismatchedDocument,
  });
  const walPath = local.walStore.pathFor(document);
  const sidecarPath = local.sidecarStore.pathFor(document);
  const walBefore = world.files.get(walPath);
  const sidecarBefore = world.files.get(sidecarPath);

  await assert.rejects(local.walStore.compact(document), { code: "SOURCE_MISMATCH" });

  assert.equal(world.files.get(walPath), walBefore);
  assert.equal(world.files.get(sidecarPath), sidecarBefore);
});

test("compaction rejects a winning route whose source metadata changes immutable PDF identity", async () => {
  const world = makeAdapter();
  const fullSourceHash = hash(new TextEncoder().encode("source PDF"));
  const document = {
    ...documentIdentity(),
    source: {
      sourceHash: fullSourceHash,
      size: 2048,
      pageCount: 1,
      orderedPageIdentities: ["page-a"],
    },
  };
  const local = stores(world, document, "device-a");
  const route = {
    type: "ROUTE_SET",
    seq: 1,
    opId: "device-a-route-1",
    version: { rev: 1, deviceId: "device-a", seq: 1 },
    payload: {
      sourcePath: "Books/Renamed.pdf",
      source: { ...document.source, orderedPageIdentities: ["different-page"] },
    },
  };
  await local.walStore.writeWal(document, wal(document, "device-a", { tail: [route], nextSeq: 2 }));
  const walPath = local.walStore.pathFor(document);
  const walBefore = world.files.get(walPath);

  await assert.rejects(local.walStore.compact(document), { code: "SOURCE_MISMATCH" });

  assert.equal(world.files.has(local.sidecarStore.pathFor(document)), false,
    "source identity rejection must happen before sidecar materialization");
  assert.equal(world.files.get(walPath), walBefore);
});
