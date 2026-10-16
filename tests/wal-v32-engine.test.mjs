import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WalAnnotationStore } from "../src/storage/wal/WalAnnotationStore.ts";

function record(id, label = id) {
  return { id, kind: "Square", pageIndex: 0, payload: { label } };
}

async function base() {
  return path.join(await mkdtemp(path.join(os.tmpdir(), "pdf-reader-v32-engine-")), "document");
}

test("JSONL create, update, delete and restart retain monotonic LSN", async () => {
  const target = await base();
  const store = new WalAnnotationStore(target);
  await store.init();
  assert.equal((await store.applyOperation("CREATE", "a", record("a"))).lsn, 1);
  assert.equal((await store.applyOperation("UPDATE", "a", record("a", "edited"))).lsn, 2);
  await store.applyOperation("CREATE", "b", record("b"));
  await store.applyOperation("DELETE", "b");
  await store.close();
  const reopened = new WalAnnotationStore(target);
  await reopened.init();
  assert.equal(reopened.revision, 4);
  assert.deepEqual(reopened.list(), [record("a", "edited")]);
  await reopened.close();
});

test("only an unterminated tail is truncated; corrupt committed lines fail closed", async () => {
  const target = await base();
  const store = new WalAnnotationStore(target);
  await store.init();
  await store.applyOperation("CREATE", "a", record("a"));
  const wal = store.walPath;
  await store.close();
  // Simulate the bytes left by a killed writer after the first checkpoint.
  const row = (lsn, id) => `${JSON.stringify({ lsn, op: "CREATE", id, payload: record(id), ts: 1 })}\n`;
  await writeFile(wal, `${row(2, "b")}${row(3, "c")}`, { flag: "a" });
  const committed = (await stat(wal)).size;
  const handle = await open(wal, "a");
  await handle.write("{\"lsn\":5,\"op\":\"CREATE\",\"id\":");
  await handle.close();
  // Simulated abrupt process exit: a second instance reads without close().
  const recovered = new WalAnnotationStore(target);
  await recovered.init();
  assert.equal((await stat(wal)).size, committed);
  assert.ok(committed > 0);
  assert.equal(recovered.revision, 3);
  assert.deepEqual(recovered.list().map((item) => item.id), ["a", "b", "c"]);
  await recovered.close();

  const corruptTarget = await base();
  await writeFile(`${corruptTarget}.annotations.wal`, '{"lsn":1,\n{"lsn":2}\n');
  await assert.rejects(new WalAnnotationStore(corruptTarget).init(), /WAL_MIDDLE_LINE_INVALID/);
  assert.equal(await readFile(`${corruptTarget}.annotations.wal`, "utf8"), '{"lsn":1,\n{"lsn":2}\n');
});

test("snapshot replacement before WAL compaction replays idempotently", async () => {
  const target = await base();
  const store = new WalAnnotationStore(target);
  await store.init();
  await store.applyOperation("CREATE", "a", record("a"));
  await store.applyOperation("CREATE", "b", record("b"));
  const oldWal = await readFile(store.walPath, "utf8");
  await store.checkpoint();
  // Emulate a crash after snapshot rename but before WAL compaction.
  await writeFile(store.walPath, oldWal);
  const recovered = new WalAnnotationStore(target);
  await recovered.init();
  assert.equal(recovered.revision, 2);
  assert.deepEqual(recovered.list().map((item) => item.id), ["a", "b"]);
  await recovered.close();
  await store.close();
});

test("non-JSON input is rejected before a WAL ACK", async () => {
  const target = await base();
  const store = new WalAnnotationStore(target);
  await store.init();
  await assert.rejects(store.applyOperation("CREATE", "bad", {
    id: "bad", kind: "Ink", pageIndex: 0, payload: { path: new Float32Array([1, 2]) },
  }), /WAL_ENTRY_INVALID/);
  assert.equal(store.revision, 0);
  await store.close();
});
