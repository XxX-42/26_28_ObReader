import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { createMainSnapshotStore } = require("../plugin/storage/main-snapshot-store.cjs");
const { makeMainSnapshotCandidate } = require("../plugin/storage/main-snapshot-candidate.cjs");
const sha = (x) => `sha256-v1:${createHash("sha256").update(x).digest("hex")}`;
const doc = { docKey: "123456abcdef", documentId: "doc-A", source: { sourceHash: sha("pdf") } };
const op = (uuid, dev, seq) => ({ type: "ANNOTATION_SET", uuid, kind: "Highlight", pageIndex: 0,
  seq, opId: `${dev}-${seq}`, version: { deviceId: dev, rev: seq, seq }, payload: { text: uuid } });
function backing() {
  const files = new Map(), folders = new Set();
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) { if (!files.has(path)) throw new Error("missing"); return files.get(path); },
    async write(path, text) { files.set(path, text); },
    async rename(from, to) { if (!files.has(from)) throw new Error("missing pending"); files.set(to, files.get(from)); files.delete(from); },
    async copy(from, to) {
      if (!files.has(from)) throw new Error("missing pending");
      if (files.has(to) || folders.has(to)) throw new Error("target exists");
      files.set(to, files.get(from));
    },
    async remove(path) { files.delete(path); },
  };
  return { files, adapter };
}

test("independent devices publish separate content-addressed snapshots and a fresh store reads them", async () => {
  const { files, adapter } = backing();
  const left = createMainSnapshotStore({ adapter, root: "data", hash: sha, token: () => "windows" });
  const right = createMainSnapshotStore({ adapter, root: "data", hash: sha, token: () => "ipad" });
  const a = await makeMainSnapshotCandidate({ document: doc, operations: [op("a", "windows", 1)], hash: sha });
  const b = await makeMainSnapshotCandidate({ document: doc, operations: [op("b", "ipad", 1)], hash: sha });
  await Promise.all([left.publish(doc, a), right.publish(doc, b)]);
  assert.equal([...files.keys()].filter((key) => key.endsWith(".json")).length, 2);
  const fresh = createMainSnapshotStore({ adapter, root: "data", hash: sha, token: () => "fresh" });
  assert.deepEqual(await fresh.read(doc, a.snapshotId), a);
  assert.deepEqual(await fresh.read(doc, b.snapshotId), b);
});

test("snapshot publication preserves different bytes arriving before publication", async () => {
  const { files, adapter } = backing();
  const store = createMainSnapshotStore({ adapter, root: "data", hash: sha, token: () => "writer" });
  const candidate = await makeMainSnapshotCandidate({ document: doc, operations: [op("a", "windows", 1)], hash: sha });
  const target = store.pathFor(doc, candidate.snapshotId);
  const originalRename = adapter.rename, originalCopy = adapter.copy;
  adapter.rename = async (from, to) => { if (to === target) files.set(to, "unverified incoming bytes"); return originalRename(from, to); };
  adapter.copy = async (from, to) => { if (to === target) files.set(to, "unverified incoming bytes"); return originalCopy(from, to); };
  await assert.rejects(store.publish(doc, candidate));
  assert.equal(files.get(target), "unverified incoming bytes");
  assert.ok(files.has(`${target}.pending-writer`));
});

test("snapshot publication does not discard a changed temporary file during cleanup", async () => {
  const { files, adapter } = backing();
  const store = createMainSnapshotStore({ adapter, root: "data", hash: sha, token: () => "writer" });
  const candidate = await makeMainSnapshotCandidate({ document: doc, operations: [op("a", "windows", 1)], hash: sha });
  const pending = `${store.pathFor(doc, candidate.snapshotId)}.pending-writer`;
  const originalCopy = adapter.copy;
  adapter.copy = async (from, to) => {
    await originalCopy(from, to);
    files.set(from, "concurrent pending bytes");
  };
  adapter.remove = async () => { throw new Error("unsafe staging cleanup attempted"); };
  try { await store.publish(doc, candidate); } catch { /* Refusing cleanup is allowed. */ }
  assert.equal(files.get(pending), "concurrent pending bytes");
});

test("a broken publication and corrupted snapshot are not accepted as a verified checkpoint", async () => {
  const { files, adapter } = backing();
  const store = createMainSnapshotStore({ adapter, root: "data", hash: sha, token: () => "writer" });
  const candidate = await makeMainSnapshotCandidate({ document: doc, operations: [op("a", "windows", 1)], hash: sha });
  const originalCopy = adapter.copy;
  adapter.copy = async () => { throw new Error("simulated crash"); };
  await assert.rejects(store.publish(doc, candidate), /simulated crash/);
  assert.equal(await store.read(doc, candidate.snapshotId), null);
  adapter.copy = originalCopy;
  const recovery = createMainSnapshotStore({ adapter, root: "data", hash: sha, token: () => "recovery" });
  await recovery.publish(doc, candidate);
  files.set(recovery.pathFor(doc, candidate.snapshotId), "{broken");
  await assert.rejects(recovery.read(doc, candidate.snapshotId), { code: "MAIN_SNAPSHOT_CORRUPT" });
});
