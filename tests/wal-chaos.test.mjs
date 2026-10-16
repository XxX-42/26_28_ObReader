import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { buildEffectiveState } = require("../plugin/storage/effective-state.cjs");
const { canonicalJson } = require("../plugin/storage/canonical.cjs");
const { createSidecarStore } = require("../plugin/storage/sidecar-store.cjs");
const { createWalStore } = require("../plugin/storage/wal-store.cjs");
const { createWalAnnotationStore } = require("../plugin/storage/wal-annotation-store.cjs");

const ROOT = "00_Archive/20_PDFData";
const DEVICE_IDS = ["iPad", "Mac", "Windows"];

function hash(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function makeWorld() {
  const files = new Map();
  const folders = new Set();
  const control = { failWritePath: null, failWriteOnce: false };
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
      if (control.failWriteOnce && path === control.failWritePath) {
        control.failWriteOnce = false;
        throw new Error("simulated sidecar replacement failure");
      }
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
      const listedFiles = [];
      const listedFolders = new Set();
      for (const entry of [...files.keys(), ...folders]) {
        if (!entry.startsWith(prefix)) continue;
        const rest = entry.slice(prefix.length);
        if (!rest.includes("/")) {
          if (files.has(entry)) listedFiles.push(entry);
          else listedFolders.add(entry);
        } else {
          listedFolders.add(`${path}/${rest.split("/")[0]}`);
        }
      }
      return { files: listedFiles, folders: [...listedFolders] };
    },
  };
  return { adapter, files, folders, control };
}

function makeDocument() {
  const sourceHash = hash("chaos-test full PDF source");
  return {
    documentId: "chaos-test-document",
    docKey: "c0ffee123456",
    initialPath: "Books/Chaos.pdf",
    fullSourceHash: sourceHash,
    sourcePath: "Books/Chaos.pdf",
    source: { sourceHash, size: 4096, pageCount: 1, orderedPageIdentities: ["ref:2 0 R"] },
    legacyIdentities: [],
    legacyIdentityScanComplete: true,
  };
}

function annotationOperation({ deviceId, seq, uuid, rev, label, deleted = false }) {
  const type = deleted ? "ANNOTATION_DELETE" : "ANNOTATION_SET";
  return {
    type,
    uuid,
    kind: "Ink",
    pageIndex: 0,
    seq,
    opId: `${deviceId}:${uuid}:${seq}:${rev}`,
    version: { rev, deviceId, seq },
    ...(!deleted ? { payload: { editor: { uuid, pageIndex: 0, label } } } : {}),
  };
}

function contributionSnapshots() {
  return new Map([
    ["iPad", [
      annotationOperation({ deviceId: "iPad", seq: 1, uuid: "live-note", rev: 1, label: "ipad-old" }),
      annotationOperation({ deviceId: "iPad", seq: 2, uuid: "grave-note", rev: 1, label: "old-live" }),
    ]],
    ["Mac", [
      annotationOperation({ deviceId: "Mac", seq: 1, uuid: "live-note", rev: 3, label: "mac-winner" }),
      annotationOperation({ deviceId: "Mac", seq: 2, uuid: "grave-note", rev: 2, label: "newer-live" }),
    ]],
    ["Windows", [
      annotationOperation({ deviceId: "Windows", seq: 1, uuid: "live-note", rev: 2, label: "windows-middle" }),
      annotationOperation({ deviceId: "Windows", seq: 2, uuid: "grave-note", rev: 3, deleted: true }),
      annotationOperation({ deviceId: "Windows", seq: 3, uuid: "windows-only", rev: 1, label: "independent" }),
    ]],
  ]);
}

function makeWal(document, deviceId, operations) {
  return {
    schemaVersion: 1,
    kind: "pdf-reader-device-wal",
    documentId: document.documentId,
    docKey: document.docKey,
    deviceId,
    document,
    nextSeq: operations.length + 1,
    anchor: { throughSeq: 0, operations: [] },
    tail: operations,
  };
}

function makeStores(world, document) {
  return new Map(DEVICE_IDS.map((deviceId) => {
    const sidecars = createSidecarStore({ adapter: world.adapter, root: ROOT, hash });
    const walStore = createWalStore({
      adapter: world.adapter,
      root: ROOT,
      hash,
      deviceId,
      sidecarStore: sidecars,
    });
    return [deviceId, { sidecars, walStore }];
  }));
}

function rngFor(seed) {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x100000000;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function expectedState(operations, base) {
  return buildEffectiveState({ sidecar: { operations: [base] }, tails: [...operations.values()] });
}

function assertFinalWinners(state) {
  assert.equal(state.annotations["live-note"].opId, "Mac:live-note:1:3");
  assert.equal(state.annotations["live-note"].payload.editor.label, "mac-winner");
  assert.equal(state.tombstones["grave-note"].opId, "Windows:grave-note:2:3");
  assert.equal(Object.hasOwn(state.annotations, "grave-note"), false, "no arrival order may resurrect a tombstoned UUID");
  assert.equal(state.annotations["windows-only"].payload.editor.label, "independent");
  assert.equal(state.annotations["base-note"].payload.editor.label, "imported-baseline");
}

test("50 seeded device-WAL arrival permutations converge through duplicates, rollback, and compaction", async () => {
  const document = makeDocument();
  const snapshots = contributionSnapshots();
  const base = annotationOperation({ deviceId: "legacy-import", seq: 0, uuid: "base-note", rev: 1, label: "imported-baseline" });
  const expected = expectedState(snapshots, base);
  assertFinalWinners(expected);
  const expectedCanonical = canonicalJson(expected);
  let firstCompactedSidecar = null;

  for (let permutation = 0; permutation < 50; permutation += 1) {
    const world = makeWorld();
    const stores = makeStores(world, document);
    const sidecar = stores.get("iPad").sidecars;
    await sidecar.writeSidecar(document, {
      schemaVersion: 1,
      kind: "pdf-reader-materialized-sidecar",
      document,
      operations: [base],
      watermark: {},
    });

    const random = rngFor(0x4c4f4741 + permutation * 7919);
    const deliveries = shuffled(DEVICE_IDS, random);
    for (const deviceId of deliveries) {
      const store = stores.get(deviceId).walStore;
      const snapshot = makeWal(document, deviceId, snapshots.get(deviceId));
      await store.writeWal(document, snapshot);
      // These are already-assigned WAL operations being redelivered byte-for-byte.
      if (random() < 0.7) await store.writeWal(document, snapshot);
    }

    const loadedBeforeCompaction = await stores.get("iPad").walStore.loadWals(document);
    assert.deepEqual(loadedBeforeCompaction.errors, []);
    const beforeState = buildEffectiveState({
      sidecar: await sidecar.loadSidecar(document),
      anchors: loadedBeforeCompaction.valid.map(({ wal }) => wal.anchor),
      tails: loadedBeforeCompaction.valid.map(({ wal }) => wal.tail),
    });
    assert.equal(canonicalJson(beforeState), expectedCanonical, `arrival permutation ${permutation} diverged`);
    assertFinalWinners(beforeState);

    const sidecarPath = sidecar.pathFor(document);
    const originalSidecar = world.files.get(sidecarPath);
    const originalWalFiles = new Map(DEVICE_IDS.map((deviceId) => [
      deviceId,
      world.files.get(stores.get(deviceId).walStore.pathFor(document)),
    ]));
    world.control.failWritePath = sidecarPath;
    world.control.failWriteOnce = true;
    await assert.rejects(stores.get(deliveries[0]).walStore.compact(document));
    assert.equal(world.files.get(sidecarPath), originalSidecar, "a failed sidecar replacement restores the last valid snapshot");
    for (const deviceId of DEVICE_IDS) {
      assert.equal(world.files.get(stores.get(deviceId).walStore.pathFor(document)), originalWalFiles.get(deviceId),
        "WAL evidence remains untouched when sidecar publication fails");
    }

    for (const deviceId of shuffled(DEVICE_IDS, random)) {
      await stores.get(deviceId).walStore.compact(document);
    }
    const loadedAfterCompaction = await stores.get("iPad").walStore.loadWals(document);
    assert.deepEqual(loadedAfterCompaction.errors, []);
    const afterState = buildEffectiveState({
      sidecar: await sidecar.loadSidecar(document),
      anchors: loadedAfterCompaction.valid.map(({ wal }) => wal.anchor),
      tails: loadedAfterCompaction.valid.map(({ wal }) => wal.tail),
    });
    assert.equal(canonicalJson(afterState), expectedCanonical, `compaction changed state in permutation ${permutation}`);
    assertFinalWinners(afterState);

    const compactedSidecar = world.files.get(sidecarPath);
    if (firstCompactedSidecar === null) firstCompactedSidecar = compactedSidecar;
    else assert.equal(compactedSidecar, firstCompactedSidecar, "equal observed state produces byte-identical sidecars");
  }
});

test("a partial arriving WAL stays pending and blocks writes until its valid shard arrives", async () => {
  const world = makeWorld();
  const document = makeDocument();
  const snapshots = contributionSnapshots();
  const stores = makeStores(world, document);
  const validWindows = makeWal(document, "Windows", snapshots.get("Windows"));
  await stores.get("Windows").walStore.writeWal(document, validWindows);
  const windowsPath = stores.get("Windows").walStore.pathFor(document);
  const validRaw = world.files.get(windowsPath);

  await stores.get("iPad").walStore.writeWal(document, makeWal(document, "iPad", snapshots.get("iPad")));
  await stores.get("Mac").walStore.writeWal(document, makeWal(document, "Mac", snapshots.get("Mac")));
  world.files.set(windowsPath, "{partial arriving WAL");

  const facade = createWalAnnotationStore({
    adapter: world.adapter,
    root: ROOT,
    hash,
    identityHash: hash,
    deviceId: "iPad",
    uuid: (() => { let id = 0; return () => `chaos-id-${++id}`; })(),
  });
  const pendingDocument = await facade.documentForPath(document.sourcePath);
  const pendingSnapshot = await facade.readDocument(pendingDocument);
  assert.equal(pendingSnapshot.syncPending, true);
  assert.deepEqual(pendingSnapshot.tombstones, [], "the missing tombstone shard is not treated as a complete state");
  await assert.rejects(facade.appendOperations({
    document: pendingDocument,
    sourceHash: document.source.sourceHash,
    operations: [{ uuid: "other", kind: "Ink", pageIndex: 0, payload: { editor: { pageIndex: 0 } },
      clock: { opId: "pending-write", deviceId: "iPad" } }],
  }), { code: "WAL_SYNC_PENDING" });

  world.files.set(windowsPath, validRaw);
  const recovered = await facade.readDocument(pendingDocument);
  assert.equal(recovered.syncPending, undefined);
  assert.deepEqual(recovered.tombstones.map(({ uuid }) => uuid), ["grave-note"]);
  assert.equal(recovered.annotations.find(({ uuid }) => uuid === "live-note").payload.editor.label, "mac-winner");
});
