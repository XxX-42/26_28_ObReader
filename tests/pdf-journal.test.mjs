import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfJournal } = require("../plugin/pdf-journal.cjs");
const bytes = (value) => new Uint8Array(value).slice();
const hash = (value) => createHash("sha256").update(value).digest("hex");

function harness() {
  const stored = new Map();
  const adapter = {
    async exists(path) { return stored.has(path); },
    async mkdir(path) { stored.set(path, true); },
    async read(path) { if (!stored.has(path)) throw new Error("missing"); return stored.get(path); },
    async write(path, value) { stored.set(path, value); },
    async readBinary(path) { if (!stored.has(path)) throw new Error("missing"); return bytes(stored.get(path)).buffer; },
    async writeBinary(path, value) { stored.set(path, bytes(value)); },
    async list(path) {
      const files = [...stored.keys()].filter((entry) => entry.startsWith(`${path}/`) && !entry.endsWith("/"));
      return { files, folders: [] };
    },
  };
  let token = 0;
  const journal = createPdfJournal({
    adapter, root: ".obsidian/plugins/pdf/.sync-checkpoints",
    normalizePath: (value) => value, fingerprint: hash,
    fingerprintChunks(chunks) { const digest = createHash("sha256"); for (const chunk of chunks) digest.update(chunk); return digest.digest("hex"); },
    createFingerprintAccumulator() {
      const digest = createHash("sha256");
      return { update(chunk) { digest.update(chunk); }, digest() { return digest.copy().digest("hex"); } };
    },
    bytesEqual: (left, right) => left.length === right.length && left.every((value, i) => value === right[i]),
    ensureDirectory: async (target, path) => target.mkdir(path), makeToken: () => `token-${++token}`,
  });
  return { journal, stored, adapter };
}

test("schema 2 stores an append suffix and reconstructs a confirmed PDF from its shared baseline", async () => {
  const { journal, stored } = harness();
  const base = bytes([1, 2, 3]);
  const suffix = bytes([4, 5]);
  const output = bytes([1, 2, 3, 4, 5]);
  const record = await journal.beginAppend({ path: "notes/book.pdf", baseBytes: base,
    parentBytes: base, suffix, outputFingerprint: hash(output), outputLength: output.length,
    metadata: { actorId: "actor-a", revision: 7, operations: [{ uuid: "u1", kind: "upsert" }], newAnnotations: [] } });

  assert.equal(record.schema, 2);
  assert.equal(record.status, "pending");
  assert.equal(record.checkpoint.kind, "append");
  const appendRecord = JSON.parse(stored.get(record.checkpoint.head));
  assert.equal(appendRecord.anchor.kind, "base");
  assert.ok(stored.has(record.base.file));
  assert.ok(stored.has(appendRecord.suffix.file));
  assert.deepEqual(appendRecord.metadata.operations,
    [{ uuid: "u1", kind: "upsert" }], "each suffix retains its replayable stable operation envelope");
  assert.equal([...stored.keys()].some((path) => /checkpoint-.*\.pdf$/.test(path)), false,
    "the append checkpoint does not write a second full PDF");
  assert.deepEqual([...await journal.readRecovery({ path: "notes/book.pdf" })], [...output]);

  await journal.confirm("notes/book.pdf", hash(output), output.length);
  const loaded = await journal.load("notes/book.pdf");
  assert.equal(loaded.status, "confirmed");
  assert.deepEqual([...loaded.checkpointBytes], [...output]);
  assert.deepEqual(loaded.metadata.metadata.operations, [{ uuid: "u1", kind: "upsert" }]);
});

test("successive append records continue only from the exact prior checkpoint", async () => {
  const { journal, stored } = harness();
  const base = bytes([1]);
  const first = bytes([1, 2]);
  const second = bytes([1, 2, 3]);
  const initial = await journal.beginAppend({ path: "notes/book.pdf", baseBytes: base, parentBytes: base,
    suffix: bytes([2]), outputFingerprint: hash(first), outputLength: first.length,
    metadata: { revision: 7, operations: [{ uuid: "created", action: "upsert", timestamp: 7, logical: 0,
      actorId: "actor-a", operationId: "actor-a:7:0:1" }] } });
  await journal.confirm("notes/book.pdf", hash(first), first.length);
  const next = await journal.beginAppend({ path: "notes/book.pdf", baseBytes: base,
    parentBytes: first, suffix: bytes([3]), outputFingerprint: hash(second), outputLength: second.length,
    metadata: { actorId: "actor-b", revision: 8, operations: [{ uuid: "deleted", action: "delete", deleted: true }] } });
  const initialRecord = JSON.parse(stored.get(initial.checkpoint.head));
  const nextRecord = JSON.parse(stored.get(next.checkpoint.head));
  assert.equal(nextRecord.parentRecord, initial.checkpoint.head,
    "the new suffix points to the prior immutable record instead of copying its chain into the manifest");
  assert.equal(nextRecord.metadata.revision, 8,
    "the first append metadata survives when the checkpoint chain advances");
  assert.equal(initialRecord.metadata.revision, 7);
  assert.equal(nextRecord.metadata.operations[0].action, "delete",
    "tombstone envelopes survive as part of the durable append record");
  assert.deepEqual([...await journal.readRecovery({ path: "notes/book.pdf" })], [...second]);
});

test("a checkpoint matching the shared base reuses that file as its journal anchor", async () => {
  const { journal, stored } = harness();
  const base = bytes([1, 2]);
  const prior = await journal.beginFull({ path: "notes/base-anchor.pdf", baseBytes: base, checkpointBytes: base });
  const paths = journal.pathsFor("notes/base-anchor.pdf");
  const duplicate = `${paths.root}/duplicate-full.pdf`;
  stored.set(duplicate, base);
  stored.set(paths.manifest, JSON.stringify({ ...prior,
    checkpoint: { kind: "full", file: duplicate, hash: hash(base), length: base.length } }));

  const output = bytes([1, 2, 3]);
  const next = await journal.beginAppend({ path: "notes/base-anchor.pdf", baseBytes: base,
    parentBytes: base, suffix: bytes([3]), outputFingerprint: hash(output), outputLength: output.length });
  const linked = JSON.parse(stored.get(next.checkpoint.head));
  assert.equal(linked.anchor.kind, "base");
  assert.equal(linked.anchor.file, next.base.file);
  assert.equal([...stored.keys()].some((path) => path.includes(".anchor-")), false,
    "the first append does not duplicate the baseline into an anchor file");
});

test("a full-write fallback is recoverable and a failed write remains pending", async () => {
  const { journal } = harness();
  const base = bytes([1, 2]);
  const output = bytes([8, 9, 10]);
  const pending = await journal.beginFull({ path: "notes/fallback.pdf", baseBytes: base,
    checkpointBytes: output, metadata: { revision: 8, operations: [{ uuid: "deleted", kind: "delete" }] } });
  assert.equal(pending.status, "pending");
  assert.equal(pending.checkpoint.kind, "full");
  assert.deepEqual([...await journal.readRecovery({ path: "notes/fallback.pdf" })], [...output]);
  const reopened = await journal.load("notes/fallback.pdf");
  assert.equal(reopened.status, "pending");
  assert.deepEqual([...reopened.checkpointBytes], [...output]);
});

test("schema 1 full checkpoints remain readable", async () => {
  const { journal, stored } = harness();
  const paths = journal.pathsFor("notes/legacy.pdf");
  const base = bytes([1, 2, 3]);
  const pdf = bytes([1, 2, 3, 4]);
  stored.set(paths.schema1Pdf, pdf);
  stored.set(paths.schema1Base, base);
  stored.set(paths.manifest, JSON.stringify({ schema: 1, status: "confirmed", path: "notes/legacy.pdf",
    hash: hash(pdf), baseHash: hash(base) }));

  const loaded = await journal.load("notes/legacy.pdf");
  assert.equal(loaded.schema, 1);
  assert.equal(loaded.status, "confirmed");
  assert.deepEqual([...loaded.checkpointBytes], [...pdf]);
  assert.deepEqual([...loaded.baseBytes], [...base]);
});

test("a corrupt newest checkpoint falls back to the prior complete manifest", async () => {
  const { journal, stored } = harness();
  const base = bytes([1]);
  const first = bytes([1, 2]);
  const second = bytes([1, 2, 3]);
  const initial = await journal.beginFull({ path: "notes/backup.pdf", baseBytes: base, checkpointBytes: first });
  await journal.confirm("notes/backup.pdf", hash(first), first.length);
  const newer = await journal.beginFull({ path: "notes/backup.pdf", baseBytes: base, checkpointBytes: second });
  stored.set(newer.checkpoint.file, bytes([0]));

  const loaded = await journal.load("notes/backup.pdf");
  assert.equal(loaded.status, "confirmed");
  assert.equal(loaded.metadata.checkpoint.file, initial.checkpoint.file);
  assert.deepEqual([...loaded.checkpointBytes], [...first]);
});

test("a later write preserves the prior complete manifest when current segments are damaged", async () => {
  const { journal, stored } = harness();
  const base = bytes([1]);
  const first = await journal.beginFull({ path: "notes/repair.pdf", baseBytes: base, checkpointBytes: bytes([1, 2]) });
  await journal.confirm("notes/repair.pdf", hash(bytes([1, 2])), 2);
  const second = await journal.beginFull({ path: "notes/repair.pdf", baseBytes: base, checkpointBytes: bytes([1, 3]) });
  stored.set(second.checkpoint.file, bytes([0]));

  const third = await journal.beginFull({ path: "notes/repair.pdf", baseBytes: base, checkpointBytes: bytes([1, 4]) });
  const previous = JSON.parse(stored.get(`${journal.pathsFor("notes/repair.pdf").manifest}.previous`));
  assert.equal(previous.checkpoint.file, first.checkpoint.file,
    "a valid prior manifest is kept instead of backing up a syntactically valid but damaged current one");
  assert.equal((await journal.load("notes/repair.pdf")).metadata.checkpoint.file, third.checkpoint.file);
  stored.set(journal.pathsFor("notes/repair.pdf").manifest, "torn");
  const recovered = await journal.load("notes/repair.pdf");
  assert.equal(recovered.metadata.checkpoint.file, first.checkpoint.file);
  assert.deepEqual([...recovered.checkpointBytes], [1, 2]);
});

test("the recovery list exposes only checkpoints whose complete payload verifies", async () => {
  const { journal, stored } = harness();
  const base = bytes([1]);
  const output = bytes([2, 3]);
  const record = await journal.beginFull({ path: "notes/listed.pdf", baseBytes: base, checkpointBytes: output });
  assert.equal((await journal.listRecoveries()).length, 1);
  stored.set(record.checkpoint.file, bytes([0]));
  assert.deepEqual(await journal.listRecoveries(), []);
});

test("the recovery list falls back to a verified prior pending manifest", async () => {
  const { journal, stored } = harness();
  const base = bytes([1]);
  const first = await journal.beginFull({ path: "notes/pending-backup.pdf", baseBytes: base,
    checkpointBytes: bytes([1, 2]) });
  const newer = await journal.beginFull({ path: "notes/pending-backup.pdf", baseBytes: base,
    checkpointBytes: bytes([1, 3]) });
  stored.set(newer.checkpoint.file, bytes([0]));

  const [candidate] = await journal.listRecoveries();
  assert.equal(candidate.hash, first.checkpoint.hash);
  assert.equal(candidate.status, "pending");
  assert.deepEqual([...await journal.readRecovery(candidate)], [1, 2]);
});

test("a failed previous-manifest backup leaves the current manifest untouched", async () => {
  const { journal, stored, adapter } = harness();
  const base = bytes([1]);
  const initial = await journal.beginFull({ path: "notes/backup-failure.pdf", baseBytes: base,
    checkpointBytes: bytes([1, 2]) });
  const manifestPath = journal.pathsFor("notes/backup-failure.pdf").manifest;
  const previous = stored.get(manifestPath);
  const write = adapter.write.bind(adapter);
  adapter.write = async (path, value) => {
    if (path === `${manifestPath}.previous`) {
      stored.set(path, `${value} `);
      return;
    }
    await write(path, value);
  };

  await assert.rejects(journal.beginFull({ path: "notes/backup-failure.pdf", baseBytes: base,
    checkpointBytes: bytes([1, 3]) }), /backup manifest write verification failed/);
  assert.equal(stored.get(manifestPath), previous,
    "the valid current manifest is not overwritten until its backup reads back exactly");
  assert.equal((await journal.load("notes/backup-failure.pdf")).metadata.checkpoint.file, initial.checkpoint.file);
});
