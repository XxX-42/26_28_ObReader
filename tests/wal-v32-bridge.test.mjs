import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createObsidianStorageBridge } = require("../plugin/storage/obsidian-storage-bridge.cjs");
const hash = (bytes) => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;

function adapterFixture() {
  const files = new Map();
  const folders = new Set();
  const calls = { append: 0, read: 0, write: 0 };
  const adapter = {
    async exists(path) { return files.has(path) || folders.has(path); },
    async mkdir(path) { folders.add(path); },
    async read(path) { calls.read++; if (!files.has(path)) throw new Error(`Missing ${path}`); return files.get(path); },
    async write(path, text) { calls.write++; files.set(path, text); },
    async append(path, text) { calls.append++; files.set(path, `${files.get(path) || ""}${text}`); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
  };
  return { adapter, files, calls };
}

test("Obsidian bridge emits one append for a multiline operation batch", async () => {
  const { adapter, files, calls } = adapterFixture();
  const bridge = createObsidianStorageBridge({ adapter, hash });
  const { wal } = bridge.pathsFor("abc123", "ipad-B");
  const rows = '{"lsn":1}\n{"lsn":2}\n{"lsn":3}\n';
  await bridge.append(wal, rows);
  assert.equal(files.get(wal), rows);
  assert.equal(calls.append, 1);
  assert.equal(calls.read, 0);
  const readsBefore = calls.read;
  await bridge.append(wal, '{"lsn":4}\n');
  assert.equal(calls.append, 2);
  assert.equal(calls.read, readsBefore, "hot-path append must not read the previous WAL");
  assert.equal(files.get(wal), `${rows}{"lsn":4}\n`);
});

test("device-scoped WAL paths are distinct and snapshot identity is stable", () => {
  const { adapter } = adapterFixture();
  const bridge = createObsidianStorageBridge({ adapter, hash });
  const ipad = bridge.pathsFor("abc123", "ipad-B");
  const windows = bridge.pathsFor("abc123", "windows-A");
  assert.notEqual(ipad.wal, windows.wal);
  assert.equal(ipad.snapshot, windows.snapshot);
  assert.throws(() => bridge.pathsFor("../other", "ipad-B"));
});

function operation(seq, uuid, type = "ANNOTATION_SET") {
  return { type, seq, opId: `ipad-B:abc123:${seq}`,
    version: { rev: 1, deviceId: "ipad-B", seq },
    uuid, kind: "Square", pageIndex: 0,
    ...(type === "ANNOTATION_SET" ? { payload: { editor: { annotationType: 5 } } } : {}) };
}
const doc = { docKey: "abc123", documentId: "pdf-instance:abc123", source: { sourceHash: "sha256-v1:abc123" } };

test("appendOperations batch makes exactly one DataAdapter.append call", async () => {
  const { adapter, calls } = adapterFixture();
  const bridge = createObsidianStorageBridge({ adapter, hash });
  const result = await bridge.appendOperationBatch(doc, "ipad-B", [
    operation(1, "first"), operation(2, "second"), operation(3, "first", "ANNOTATION_DELETE"),
  ], () => "CREATE");
  assert.equal(calls.append, 1);
  assert.equal(calls.read, 0);
  assert.equal(result.entries.length, 3);
  assert.deepEqual((await bridge.readOperationRows(doc, "ipad-B")).map((op) => op.uuid),
    ["first", "second", "first"]);
});

test("portable recovery removes only an incomplete final JSONL row", async () => {
  const { adapter, files } = adapterFixture();
  const bridge = createObsidianStorageBridge({ adapter, hash });
  const { wal } = bridge.pathsFor(doc.docKey, "ipad-B");
  await bridge.appendOperationBatch(doc, "ipad-B", [operation(1, "first")]);
  files.set(wal, `${files.get(wal)}{"lsn":2,"op":"CRE`);
  await assert.rejects(bridge.readOperationRows(doc, "ipad-B"), /WAL_JSONL_SYNC_PENDING/);
  const rows = await bridge.readOperationRows(doc, "ipad-B", { repairOwnTail: true });
  assert.equal(rows.length, 1);
  assert.ok(files.get(wal).endsWith("\n"));
  assert.ok(!files.get(wal).includes('"op":"CRE'));
});

test("a torn first row after checkpoint rotation is recoverable as an empty active WAL", async () => {
  const { adapter, files } = adapterFixture();
  const bridge = createObsidianStorageBridge({ adapter, hash });
  const { wal } = bridge.pathsFor(doc.docKey, "ipad-B");
  files.set(wal, '{"lsn":501,"op":"CRE');
  await assert.rejects(bridge.readOperationRows(doc, "ipad-B"), /WAL_JSONL_SYNC_PENDING/);
  assert.deepEqual(await bridge.readOperationRows(doc, "ipad-B", { repairOwnTail: true }), []);
  assert.equal(files.get(wal), "");
});

test("cold JSONL replacement works when a mobile adapter rejects rename-over-existing", async () => {
  const { adapter, files } = adapterFixture();
  const originalRename = adapter.rename;
  adapter.rename = async (from, to) => {
    if (files.has(to)) throw new Error("destination exists");
    return originalRename(from, to);
  };
  const bridge = createObsidianStorageBridge({ adapter, hash });
  const { wal } = bridge.pathsFor(doc.docKey, "ipad-B");
  await bridge.appendOperationBatch(doc, "ipad-B", [operation(1, "first")]);
  await bridge.atomicReplace(wal, "");
  assert.equal(files.get(wal), "");
  assert.equal(files.get(`${wal}.pending`), "", "verified pending copy is retained for recovery");
});
