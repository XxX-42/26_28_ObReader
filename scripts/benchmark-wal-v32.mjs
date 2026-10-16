import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WalAnnotationStore } from "../src/storage/wal/WalAnnotationStore.ts";

const source = process.argv[2];
if (!source) throw new Error("Pass an existing fixture PDF path; never benchmark against an in-place user PDF.");
const root = await mkdtemp(path.join(os.tmpdir(), "pdf-reader-wal-v32-benchmark-"));
const pdfCopy = path.join(root, "fixture.pdf");
await copyFile(source, pdfCopy);
const pdfBefore = await readFile(pdfCopy);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaBefore = hash(pdfBefore);
const beforeStat = await stat(pdfCopy);
const store = new WalAnnotationStore(path.join(root, "fixture"));
await store.init();
const latencies = [];
const slowOperations = [];
const live = [];
const started = performance.now();
for (let index = 0; index < 1000; index++) {
  const phase = index % 10;
  let op;
  let id;
  if (phase < 8 || live.length === 0) {
    op = "CREATE";
    id = `stress-${index}`;
    live.push(id);
  } else if (phase === 8) {
    op = "UPDATE";
    id = live.at(-1);
  } else {
    op = "DELETE";
    id = live.pop();
  }
  const record = op === "DELETE" ? undefined : {
    id, kind: index % 2 ? "Underline" : "Square", pageIndex: (index * 37) % 357,
    payload: { color: [0, 0, 0], rect: [100, 100, 200, 200], testIndex: index },
  };
  const start = performance.now();
  await store.applyOperation(op, id, record);
  const elapsed = performance.now() - start;
  latencies.push(elapsed);
  if (elapsed > 5) slowOperations.push({ index: index + 1, elapsedMs: elapsed });
}
const durationMs = performance.now() - started;
await store.close();
const reopened = new WalAnnotationStore(path.join(root, "fixture"));
await reopened.init();
assert.equal(reopened.revision, 1000);
assert.equal(reopened.list().length, 700);
await reopened.close();
latencies.sort((a, b) => a - b);
const at = (q) => latencies[Math.ceil(q * latencies.length) - 1];
const afterStat = await stat(pdfCopy);
const shaAfter = hash(await readFile(pdfCopy));
assert.equal(shaAfter, shaBefore);
assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
console.log(JSON.stringify({
  scenario: "standalone Node JSONL engine; not Obsidian host ACK or mobile evidence",
  fixture: { source, copy: pdfCopy, bytes: pdfBefore.length, shaBefore, shaAfter, mtimeUnchanged: afterStat.mtimeMs === beforeStat.mtimeMs },
  operations: 1000, activeAnnotations: reopened.list().length,
  durationMs, p50Ms: at(0.5), p99Ms: at(0.99), maxMs: latencies.at(-1),
  over5ms: slowOperations.length, slowOperations: slowOperations.slice(0, 30),
  root,
}, null, 2));
