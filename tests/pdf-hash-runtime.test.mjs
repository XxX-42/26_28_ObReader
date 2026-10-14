import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPdfHashRuntime } = require("../plugin/pdf-hash-runtime.cjs");
const { createPdfJournal } = require("../plugin/pdf-journal.cjs");
const { writeDeltaRecovery, readDeltaRecovery } = require("../plugin/pdf-recovery.cjs");

function recoveryAdapter() {
  const files = new Map();
  return {
    files,
    async exists(path) { return files.has(path); },
    async writeBinary(path, data) { files.set(path, new Uint8Array(data).slice()); },
    async readBinary(path) { if (!files.has(path)) throw new Error("missing"); return files.get(path).slice().buffer; },
    async write(path, data) { files.set(path, data); },
    async read(path) { if (!files.has(path)) throw new Error("missing"); return files.get(path); },
    async remove(path) { files.delete(path); },
  };
}

function journalHarness(runtime, stored) {
  const adapter = {
    async exists(path) { return stored.has(path); },
    async mkdir(path) { stored.set(path, true); },
    async read(path) { if (!stored.has(path)) throw new Error("missing"); return stored.get(path); },
    async write(path, value) { stored.set(path, value); },
    async readBinary(path) { if (!stored.has(path)) throw new Error("missing"); return stored.get(path).slice().buffer; },
    async writeBinary(path, value) { stored.set(path, new Uint8Array(value).slice()); },
    async list(path) { return { files: [...stored.keys()].filter((name) => name.startsWith(`${path}/`)), folders: [] }; },
  };
  let token = 0;
  const journal = createPdfJournal({
    adapter,
    root: ".obsidian/plugins/pdf/.sync-checkpoints",
    normalizePath: (value) => value,
    fingerprint: (value) => runtime.fingerprint(value),
    fingerprintMatches: (value, expected) => runtime.matches(value, expected),
    isSupportedHash: (value) => runtime.isSupportedHash(value),
    hashFileKey: (value) => runtime.hashFileKey(value),
    pathKey: (value) => createHash("sha256").update(value).digest("hex"),
    fingerprintChunks: (chunks) => runtime.fingerprintChunks(chunks),
    createFingerprintAccumulator: (expected) => runtime.createAccumulator(expected),
    bytesEqual: (left, right) => left.length === right.length && left.every((byte, index) => byte === right[index]),
    ensureDirectory: async (target, path) => target.mkdir(path),
    makeToken: () => `hash-test-${++token}`,
  });
  return { adapter, journal };
}

test("XXH64 runtime handles empty input, size and tail fast rejection", async () => {
  const runtime = await createPdfHashRuntime();
  assert.equal(runtime.algorithm, "xxh64-v1");
  assert.equal(runtime.fingerprint(new Uint8Array()), "xxh64-v1:ef46db3751d8e999");
  assert.equal(runtime.compare(new Uint8Array([1]), new Uint8Array([1, 0])), false);

  const left = new Uint8Array(80 * 1024);
  const right = left.slice();
  right[right.length - 1] = 1;
  assert.equal(runtime.compare(left, right), false);
});

test("equal-size middle changes fall through the tail check to full XXH64", async () => {
  const runtime = await createPdfHashRuntime();
  const left = new Uint8Array(80 * 1024);
  const right = left.slice();
  right[3] = 1;
  assert.deepEqual(left.slice(-64 * 1024), right.slice(-64 * 1024));
  assert.equal(runtime.compare(left, right), false);
  assert.equal(runtime.compare(left, left.slice()), true);
});

test("streaming chunks and offset views hash only their visible bytes", async () => {
  const runtime = await createPdfHashRuntime();
  const backing = Uint8Array.from([90, 1, 2, 3, 91]);
  const view = new Uint8Array(backing.buffer, 1, 3);
  const expected = runtime.fingerprint(Uint8Array.from([1, 2, 3]));
  assert.equal(runtime.fingerprint(view), expected);
  assert.equal(runtime.fingerprintChunks([view.subarray(0, 1), view.subarray(1)]), expected);

  const accumulator = runtime.createAccumulator();
  accumulator.update(view.subarray(0, 2));
  accumulator.update(view.subarray(2));
  assert.equal(accumulator.digest(), expected);
});

test("legacy SHA-256 records remain readable and new hashes are tagged", async () => {
  const runtime = await createPdfHashRuntime();
  const bytes = new TextEncoder().encode("legacy checkpoint");
  const legacy = runtime.createAccumulator("0".repeat(64));
  legacy.update(bytes);
  const legacyDigest = legacy.digest();
  assert.match(legacyDigest, /^[a-f0-9]{64}$/);
  assert.equal(runtime.matches(bytes, legacyDigest), true);
  assert.equal(runtime.matches(bytes, `sha256-v1:${legacyDigest}`), true);
  assert.equal(runtime.matches(bytes, `SHA256-V1:${legacyDigest.toUpperCase()}`), true);
  assert.equal(runtime.isSupportedHash(legacyDigest), true);
  assert.equal(runtime.isSupportedHash(`xxh64-v1:${runtime.fingerprint(bytes).slice(-16)}`), true);

  const current = runtime.fingerprint(bytes);
  assert.match(current, /^xxh64-v1:[a-f0-9]{16}$/);
  assert.equal(runtime.matches(bytes, current), true);
  assert.equal(runtime.hashFileKey(current), current.replace(":", "-"));
  assert.equal(runtime.matches(Uint8Array.from([0]), current), false);
});

test("WASM fallback writes tagged SHA and can read legacy SHA records", async () => {
  const runtime = await createPdfHashRuntime({ forceSha256: true });
  const bytes = new TextEncoder().encode("fallback");
  assert.equal(runtime.algorithm, "sha256-v1");
  const current = runtime.fingerprint(bytes);
  assert.match(current, /^sha256-v1:[a-f0-9]{64}$/);
  assert.equal(runtime.matches(bytes, current), true);
  assert.equal(runtime.matches(bytes, current.slice("sha256-v1:".length)), true);
  assert.equal(runtime.compare(bytes, bytes.slice()), true);
});

test("XXH64 journal reads legacy SHA checkpoints and writes tagged XXH64 records", async () => {
  const runtime = await createPdfHashRuntime();
  const stored = new Map();
  const { journal } = journalHarness(runtime, stored);
  const path = "books/example.pdf";
  const paths = journal.pathsFor(path);
  const legacyPdf = Uint8Array.from([1, 2, 3, 4]);
  const legacyBase = Uint8Array.from([1, 2, 3]);
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  stored.set(paths.schema1Pdf, legacyPdf);
  stored.set(paths.schema1Base, legacyBase);
  stored.set(paths.manifest, JSON.stringify({
    schema: 1,
    status: "pending",
    path,
    hash: sha(legacyPdf),
    baseHash: sha(legacyBase),
    updatedAt: "2026-10-15T00:00:00.000Z",
  }));

  const loaded = await journal.load(path);
  assert.deepEqual([...loaded.checkpointBytes], [...legacyPdf]);

  const nextPdf = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const written = await journal.beginFull({ path, baseBytes: legacyBase, checkpointBytes: nextPdf });
  assert.match(written.base.hash, /^xxh64-v1:[a-f0-9]{16}$/);
  assert.match(written.checkpoint.hash, /^xxh64-v1:[a-f0-9]{16}$/);
  const reread = await journal.load(path);
  assert.deepEqual([...reread.checkpointBytes], [...nextPdf]);
});

test("recovery reads legacy SHA files and writes new XXH64 files without rewriting history", async () => {
  const xxhRuntime = await createPdfHashRuntime();
  const shaRuntime = await createPdfHashRuntime({ forceSha256: true });
  const adapter = recoveryAdapter();
  const root = ".obsidian/plugins/pdf/.recovery";
  const base = Uint8Array.from([1, 2, 3, 4]);
  const output = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const ensureDirectory = async () => {};
  const legacy = await writeDeltaRecovery({ adapter, root, data: output, bases: [base],
    metadata: { candidateId: "legacy", revision: 1 }, ensureDirectory, hashRuntime: shaRuntime });
  assert.match(legacy.metadata.outputHash, /^sha256-v1:[a-f0-9]{64}$/);
  // Simulate the previous bare SHA-256 schema without touching the stored bytes.
  const legacyText = await adapter.read(legacy.metadataPath);
  const legacyRecord = JSON.parse(legacyText);
  legacyRecord.recoveryBase.hash = legacyRecord.recoveryBase.hash.slice("sha256-v1:".length);
  legacyRecord.deltaHash = legacyRecord.deltaHash.slice("sha256-v1:".length);
  legacyRecord.outputHash = legacyRecord.outputHash.slice("sha256-v1:".length);
  await adapter.write(legacy.metadataPath, JSON.stringify(legacyRecord, null, 2) + "\n");
  assert.deepEqual([...new Uint8Array(await readDeltaRecovery(adapter, root,
    { ...legacy, metadata: legacyRecord }, xxhRuntime))], [...output]);

  const latest = await writeDeltaRecovery({ adapter, root, data: output, bases: [base],
    metadata: { candidateId: "latest", revision: 2 }, ensureDirectory, hashRuntime: xxhRuntime });
  assert.match(latest.metadata.recoveryBase.hash, /^xxh64-v1:[a-f0-9]{16}$/);
  assert.match(latest.metadata.deltaHash, /^xxh64-v1:[a-f0-9]{16}$/);
  assert.match(latest.metadata.outputHash, /^xxh64-v1:[a-f0-9]{16}$/);
  assert.deepEqual([...new Uint8Array(await readDeltaRecovery(adapter, root, latest, xxhRuntime))], [...output]);
});
