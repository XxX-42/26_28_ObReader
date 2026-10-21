import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createDeletionRetention, DELETION_RETENTION_MS } = require("../plugin/storage/deletion-retention.cjs");
const root = "00_Archive/20_PDFData";
const document = { docKey: "0123456789ab", documentId: "retention-doc", source: { sourceHash: "sha256-v1:fixture" } };
const deleted = (rev = 1) => ({ type: "ANNOTATION_DELETE", uuid: "gone", version: { rev, deviceId: "A", seq: rev },
  pageIndex: 1, embeddedRef: "7R", kind: "Ink", opId: `A:fixture:${rev}`, seq: rev });
const state = (row = deleted()) => ({ annotations: {}, tombstones: { [row.uuid]: row } });

function world() {
  const files = new Map();
  const writes = [];
  let now = Date.UTC(2026, 9, 22);
  let serial = 0;
  const adapter = {
    async exists(p) { return files.has(p); },
    async read(p) { if (!files.has(p)) throw new Error("missing"); return files.get(p); },
    async write(p, value) { writes.push(p); files.set(p, value); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async remove(p) { files.delete(p); },
    async mkdir() {},
  };
  const hash = bytes => `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
  const create = () => createDeletionRetention({ adapter, root, deviceId: "A", hash,
    token: () => `test-${++serial}`, clock: () => now });
  return { files, writes, adapter, create, advance: value => { now += value; }, now: () => now };
}

test("legacy delete starts at first observation and expires exactly at 48 days across restarts", async () => {
  const w = world();
  const first = w.create();
  assert.equal(Object.keys((await first.project(document, state())).tombstones).length, 1);
  const bytes = w.files.get(first.pathFor(document));
  w.advance(DELETION_RETENTION_MS - 1);
  assert.equal((await w.create().project(document, state())).deletionGuards.length, 0);
  assert.equal(w.files.get(first.pathFor(document)), bytes, "reading does not refresh the timestamp");
  w.advance(1);
  const result = await w.create().project(document, state());
  assert.deepEqual(Object.keys(result.tombstones), []);
  assert.deepEqual(result.deletionGuards, [{ uuid: "gone", version: deleted().version, pageIndex: 1, embeddedRef: "7R" }]);
  assert.equal(w.files.get(first.pathFor(document)), bytes, "guard projection does not rewrite operation records");
});

test("new deletion uses its durable timestamp; read-only access cannot establish expiry metadata", async () => {
  const w = world();
  const row = { ...deleted(), deletedAt: w.now() };
  w.advance(1000);
  const ledger = w.create();
  assert.equal((await ledger.project(document, state(row), { readOnly: true })).deletionGuards.length, 0);
  assert.equal(w.files.size, 0);
  await ledger.project(document, state(row));
  const saved = JSON.parse(w.files.get(ledger.pathFor(document)));
  assert.equal(saved.entries.gone.firstObservedAt, row.deletedAt);
  w.advance(DELETION_RETENTION_MS - 1000);
  assert.equal((await ledger.project(document, state(row))).deletionGuards.length, 1);
});

test("failed metadata write keeps the full tombstone; a later request is not poisoned", async () => {
  const w = world();
  const write = w.adapter.write;
  w.adapter.write = async () => { throw new Error("disk full"); };
  const ledger = w.create();
  assert.equal((await ledger.project(document, state())).deletionGuards.length, 0);
  assert.equal(w.files.size, 0);
  w.advance(DELETION_RETENTION_MS);
  w.adapter.write = write;
  assert.equal((await ledger.project(document, state())).deletionGuards.length, 0,
    "unconfirmed observation never expires a legacy delete");
  w.advance(DELETION_RETENTION_MS);
  assert.equal((await ledger.project(document, state())).deletionGuards.length, 1);
});

test("missing or corrupt retention metadata restores full tombstones without touching history", async () => {
  const w = world();
  const ledger = w.create();
  const row = { ...deleted(), deletedAt: w.now() };
  await ledger.project(document, state(row));
  w.advance(DELETION_RETENTION_MS);
  assert.equal((await ledger.project(document, state(row))).deletionGuards.length, 1);
  w.files.set(ledger.pathFor(document), "{broken");
  assert.equal((await w.create().project(document, state(row))).deletionGuards.length, 0);
  w.files.delete(ledger.pathFor(document));
  assert.equal((await w.create().project(document, state(row))).deletionGuards.length, 0);
});

test("newer restore and delete reset retention, same-version sync never resets it", async () => {
  const w = world();
  const ledger = w.create();
  await ledger.project(document, state());
  w.advance(DELETION_RETENTION_MS);
  assert.equal((await ledger.project(document, state())).deletionGuards.length, 1);
  assert.deepEqual((await ledger.project(document, { annotations: { gone: {} }, tombstones: {} })).deletionGuards, []);
  assert.equal((await ledger.project(document, state(deleted(3)))).deletionGuards.length, 0);
  w.advance(DELETION_RETENTION_MS);
  assert.equal((await ledger.project(document, state(deleted(3)))).deletionGuards.length, 1);
});

test("source mismatch and read-only lookup do not change retention bytes", async () => {
  const w = world();
  const ledger = w.create();
  await ledger.project(document, state());
  const before = new Map(w.files);
  w.advance(DELETION_RETENTION_MS);
  const result = await ledger.project({ ...document, sourceMismatch: true }, state());
  assert.equal(result.deletionGuards.length, 0);
  assert.deepEqual(w.files, before);
  assert.equal((await ledger.project(document, state(), { readOnly: true })).deletionGuards.length, 1);
  assert.deepEqual(w.files, before);
});
