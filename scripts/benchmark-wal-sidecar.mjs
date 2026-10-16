#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// This is a Node process benchmark over an in-memory DataAdapter-compatible
// implementation. Platform names below are compatibility labels only; no
// native Windows, macOS, or iPadOS device is measured by this script.
const require = createRequire(import.meta.url);
const { createWalAnnotationStore } = require("../plugin/storage/wal-annotation-store.cjs");
const { canonicalJson } = require("../plugin/storage/canonical.cjs");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../tests/fixtures/tracemonkey.pdf");
const STORAGE_ROOT = "00_Archive/20_PDFData";
const DEVICE_ID = "benchmark-device";
const EDIT_COUNT = 10;
const BASE64_BYTES = 100 * 1024;
const FLOAT32_BYTES = BASE64_BYTES / 4 * 3;
const PLATFORM_LABELS = ["Windows", "macOS", "iPadOS"];

function taggedSha256(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function utf8ByteLength(value) {
  if (typeof value === "string") return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  throw new TypeError("The benchmark adapter received a non-string, non-byte write.");
}

function createMemoryDataAdapter() {
  const files = new Map();
  const folders = new Set();
  let writeCalls = 0;
  let utf8WriteBytes = 0;
  const adapter = {
    async exists(entry) { return files.has(entry) || folders.has(entry); },
    async mkdir(entry) { folders.add(entry); },
    async read(entry) {
      if (!files.has(entry)) throw new Error(`Missing DataAdapter entry: ${entry}`);
      return files.get(entry);
    },
    async write(entry, value) {
      if (typeof value !== "string") throw new TypeError("Expected UTF-8 text from the WAL storage runtime.");
      const parent = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "";
      if (parent && !folders.has(parent)) throw new Error(`Parent directory missing: ${parent}`);
      files.set(entry, value);
      writeCalls += 1;
      utf8WriteBytes += utf8ByteLength(value);
    },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`Missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`Rename target exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async remove(entry) { files.delete(entry); },
    async list(directory) {
      const prefix = `${directory}/`;
      const childFiles = [];
      const childFolders = new Set();
      for (const entry of [...files.keys(), ...folders]) {
        if (!entry.startsWith(prefix)) continue;
        const rest = entry.slice(prefix.length);
        if (rest.includes("/")) childFolders.add(rest.slice(0, rest.indexOf("/")));
        else if (files.has(entry)) childFiles.push(rest);
        else if (rest) childFolders.add(rest);
      }
      return { files: childFiles, folders: [...childFolders] };
    },
  };
  return {
    adapter,
    files,
    folders,
    stats: () => ({ writeCalls, utf8WriteBytes }),
  };
}

function createInkPayload(iteration) {
  // 76,800 raw Float32LE bytes encode to exactly 102,400 Base64 characters
  // (100 KiB). They represent 9,600 x/y points in one Ink path.
  const raw = Buffer.alloc(FLOAT32_BYTES);
  for (let offset = 0; offset < raw.byteLength; offset += 4) {
    const point = offset / 8;
    const coordinate = (offset / 4) % 2;
    const value = coordinate === 0
      ? Math.sin(point / 41) * 720 + iteration * 0.05
      : Math.cos(point / 37) * 960 + iteration * 0.05;
    raw.writeFloatLE(value, offset);
  }
  const data = raw.toString("base64");
  assert.equal(data.length, BASE64_BYTES, "the benchmark Ink path must encode to exactly 100 KiB of Base64");
  return {
    editor: {
      type: "ink",
      color: [0.12, 0.3, 0.72],
      thickness: 2.25,
      paths: [{ encoding: "float32le-base64-v1", data, pointCount: FLOAT32_BYTES / 8 }],
    },
  };
}

function logicalPageIdentities() {
  return Array.from({ length: 120 }, (_, index) => `logical-page-${String(index).padStart(3, "0")}`);
}

function memorySnapshot(label) {
  const usage = process.memoryUsage();
  return {
    label,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const sum = samples.reduce((total, value) => total + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const percentileIndex = Math.max(0, Math.ceil(0.9 * sorted.length) - 1);
  const round = (number) => Number(number.toFixed(3));
  return {
    N: samples.length,
    meanMs: round(sum / samples.length),
    medianMs: round(median),
    p90Ms: round(sorted[percentileIndex]),
    maxMs: round(sorted.at(-1)),
  };
}

function timeMs(startedAt) {
  return performance.now() - startedAt;
}

async function runVariant(platformLabel, fixtureBytes, sourceHash) {
  const storeAdapter = createMemoryDataAdapter();
  let id = 0;
  // Use the same storage core, deterministic identity, fixture, and memory
  // adapter contract for every platform compatibility label.
  const store = createWalAnnotationStore({
    adapter: storeAdapter.adapter,
    root: STORAGE_ROOT,
    deviceId: DEVICE_ID,
    uuid: () => `benchmark-uuid-${++id}`,
    hash: taggedSha256,
    identityHash: taggedSha256,
    clock: () => 1_800_000_000_000 + id,
  });
  const source = {
    sourceHash,
    fastHash: sourceHash,
    size: fixtureBytes.byteLength,
    pageCount: 120,
    orderedPageIdentities: logicalPageIdentities(),
  };
  const document = await store.registerDocument({ sourcePath: "Benchmarks/tracemonkey-120-page-model.pdf", source });
  const payloads = Array.from({ length: EDIT_COUNT }, (_, index) => createInkPayload(index + 1));
  const memory = [memorySnapshot("before-edits")];
  const saveSamples = [];
  const readSamples = [];
  let lastSnapshot = null;

  for (let index = 0; index < EDIT_COUNT; index += 1) {
    const saveStart = performance.now();
    const saved = await store.appendOperations({
      document,
      sourceHash,
      batchId: `benchmark-edit-${String(index + 1).padStart(2, "0")}`,
      operations: [{
        uuid: "benchmark-large-ink",
        kind: "Ink",
        pageIndex: 60,
        deleted: false,
        clock: {
          timestamp: 1_800_000_000_000 + index,
          logical: index,
          deviceId: "benchmark-viewer",
          opId: `benchmark-origin-${String(index + 1).padStart(2, "0")}`,
        },
        payload: payloads[index],
      }],
    });
    saveSamples.push(timeMs(saveStart));
    assert.equal(saved.acknowledged, true);
    assert.equal(saved.operationCount, 1, "each benchmark save contributes one dirty annotation operation");

    const readStart = performance.now();
    lastSnapshot = await store.readDocument(document);
    readSamples.push(timeMs(readStart));
    assert.equal(lastSnapshot.annotations.length, 1);
    assert.equal(lastSnapshot.annotations[0].uuid, "benchmark-large-ink");
    assert.equal(lastSnapshot.annotations[0].payload.editor.paths[0].data.length, BASE64_BYTES);
  }
  memory.push(memorySnapshot("after-10-save-read-cycles"));

  const beforeCompact = await store.readEffective(document);
  const beforeWal = beforeCompact.valid.find((wal) => wal.deviceId === DEVICE_ID);
  assert.ok(beforeWal, "the local device WAL must exist before compaction");
  assert.equal(beforeWal.tail.length, EDIT_COUNT, "the benchmark should accumulate ten successive WAL edits");
  const walPath = `${STORAGE_ROOT}/wal/${DEVICE_ID}/${document.docKey}.json`;
  const preCompactWalText = storeAdapter.files.get(walPath);
  assert.equal(typeof preCompactWalText, "string", "the active WAL must be stored by the adapter");
  const preCompactWalBytes = new TextEncoder().encode(preCompactWalText).byteLength;

  const compactStart = performance.now();
  await store.materializeSnapshot(document);
  const compactMs = timeMs(compactStart);
  const afterCompact = await store.readEffective(document);
  const compactedWal = afterCompact.valid.find((wal) => wal.deviceId === DEVICE_ID);
  assert.ok(afterCompact.sidecar, "compaction publishes the verified sidecar snapshot");
  assert.ok(compactedWal);
  assert.equal(compactedWal.tail.length, 0, "the large WAL is compacted into its verified anchor and sidecar");

  lastSnapshot = await store.readDocument(document);
  assert.equal(lastSnapshot.annotations.length, 1);
  assert.deepEqual(lastSnapshot.annotations[0].payload, payloads.at(-1));
  memory.push(memorySnapshot("after-compaction"));

  const sidecarPath = store.pathsFor(document).snapshot;
  const walText = storeAdapter.files.get(walPath);
  const sidecarText = storeAdapter.files.get(sidecarPath);
  assert.equal(typeof walText, "string");
  assert.equal(typeof sidecarText, "string");
  const finalState = {
    documentId: document.documentId,
    docKey: document.docKey,
    sourceHash,
    annotations: lastSnapshot.annotations.map(({ uuid, kind, pageIndex, payload }) => ({ uuid, kind, pageIndex, payload })),
    tombstones: lastSnapshot.tombstones.map(({ uuid, kind, pageIndex }) => ({ uuid, kind, pageIndex })),
    orderedPageIdentities: source.orderedPageIdentities,
  };
  const semanticDigest = taggedSha256(new TextEncoder().encode(canonicalJson(finalState)));
  const adapterStats = storeAdapter.stats();

  return {
    platformLabel,
    evidenceClass: "Node memory adapter only; compatibility label, not native platform evidence",
    storageCore: "createWalAnnotationStore (same implementation for all labels)",
    adapter: "in-memory DataAdapter-compatible harness",
    fixture: "tests/fixtures/tracemonkey.pdf",
    fixtureBytes: fixtureBytes.byteLength,
    sourceHash,
    pageIdentityMode: "120 deterministic logical page identities for storage cardinality; not a claim about fixture page count",
    pageCount: source.pageCount,
    inkPayload: {
      kind: "Ink",
      rawFloat32leBytes: FLOAT32_BYTES,
      base64Characters: payloads.at(-1).editor.paths[0].data.length,
      points: FLOAT32_BYTES / 8,
      dirtyOperations: EDIT_COUNT,
    },
    timings: {
      save: summarize(saveSamples),
      read: summarize(readSamples),
      compact: summarize([compactMs]),
    },
    adapterWrites: {
      calls: adapterStats.writeCalls,
      actualUtf8Bytes: adapterStats.utf8WriteBytes,
    },
    storage: {
      fileCount: storeAdapter.files.size,
      folderCount: storeAdapter.folders.size,
      preCompactionWalBytes: preCompactWalBytes,
      walSizeBytes: new TextEncoder().encode(walText).byteLength,
      sidecarSizeBytes: new TextEncoder().encode(sidecarText).byteLength,
      tailOperationsAfterCompaction: compactedWal.tail.length,
      anchorOperationsAfterCompaction: compactedWal.anchor.operations.length,
    },
    memorySnapshots: memory,
    semanticDigest,
  };
}

async function main() {
  const outputArgument = process.argv[2];
  if (!outputArgument) throw new Error("Usage: node scripts/benchmark-wal-sidecar.mjs <output.json>");
  const fixtureBefore = new Uint8Array(await readFile(FIXTURE));
  const sourceHashBefore = taggedSha256(fixtureBefore);
  const processMemoryBefore = memorySnapshot("process-before-benchmarks");
  const variants = [];
  for (const platformLabel of PLATFORM_LABELS) {
    variants.push(await runVariant(platformLabel, fixtureBefore, sourceHashBefore));
  }
  const fixtureAfter = new Uint8Array(await readFile(FIXTURE));
  const sourceHashAfter = taggedSha256(fixtureAfter);
  assert.equal(sourceHashAfter, sourceHashBefore, "the real source fixture must remain unchanged");
  assert.deepEqual(fixtureAfter, fixtureBefore, "the benchmark must not modify the source PDF fixture");
  const semanticDigests = [...new Set(variants.map((variant) => variant.semanticDigest))];
  assert.equal(semanticDigests.length, 1, "the shared WAL core produces the same semantic state for each adapter label");

  const report = {
    schemaVersion: 1,
    benchmark: "wal-sidecar-v3.1-storage-adapter",
    generatedAt: new Date().toISOString(),
    evidenceScope: "Node process and in-memory DataAdapter-compatible implementation only; not iPad, native Obsidian, Windows, macOS, or iPadOS device performance evidence.",
    scenario: {
      editsPerVariant: EDIT_COUNT,
      operationPerEdit: "one dirty Ink annotation update",
      logicalPageIdentityCount: 120,
      base64PayloadCharacters: BASE64_BYTES,
      rawFloat32leBytes: FLOAT32_BYTES,
      sourceFixture: "tests/fixtures/tracemonkey.pdf",
      sourceFixtureBytes: fixtureBefore.byteLength,
      sourceHashBefore,
      sourceHashAfter,
      sourceFixtureUnchanged: sourceHashBefore === sourceHashAfter,
    },
    parityCheck: {
      passed: semanticDigests.length === 1,
      semanticDigest: semanticDigests[0],
      note: "Windows/macOS/iPadOS are labels over identical Node memory-adapter behavior and the same WAL core.",
    },
    processMemoryBefore: processMemoryBefore,
    processMemoryAfter: memorySnapshot("process-after-benchmarks"),
    variants,
  };
  const outputPath = path.resolve(process.cwd(), outputArgument);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, variants: variants.map(({ platformLabel, timings, storage }) => ({ platformLabel, timings, storage })) }, null, 2)}\n`);
}

await main();
