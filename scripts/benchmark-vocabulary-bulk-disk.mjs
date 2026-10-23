#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTemporaryVocabularyAdapter } from "../tests/vocabulary-bulk-node-data-adapter.mjs";
import { VocabularyMemoryAdapter } from "../tests/vocabulary-v2-memory-adapter.mjs";

const require = createRequire(import.meta.url);
const { VocabularyService } = require("../plugin/vocabulary/service.cjs");
const { createVocabularyRuntime } = require("../plugin/vocabulary/runtime.cjs");
const { createVocabularyTransfer } = require("../plugin/vocabulary/transfer.cjs");
const { canonicalHash, canonicalStringify } = require("../plugin/vocabulary/canonical.cjs");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COUNT = 25_000;
const ROUNDS = 5;
const DEVICE = "bulk-disk-benchmark-device";
const SESSION = "bulk-disk-benchmark-session";
const FIXED_NOW = 1_800_000_000_000;
const MODES = Object.freeze([
  { name: "baseline", adapterMode: "plain" },
  { name: "A-history-gzip", adapterMode: "gzip-history" },
  { name: "B-shared-lifecycle", adapterMode: "shared-history" },
]);

if (!process.argv.includes("--run-25k")) {
  console.error("This disk benchmark performs 15 real-filesystem 25k imports and restore round trips. Run with --run-25k after obtaining the benchmark lease.");
  process.exitCode = 2;
} else {
  await main();
}

function cpuMicrosSince(start) {
  const delta = process.cpuUsage(start);
  return delta.user + delta.system;
}

function makeRuntime(adapter, sequence = { value: 0 }, { sessionId = SESSION } = {}) {
  const personalService = new VocabularyService({ adapter, now: () => FIXED_NOW });
  const runtime = createVocabularyRuntime({
    adapter,
    personalService,
    deviceId: DEVICE,
    sessionId,
    now: () => FIXED_NOW,
    makeId: () => `bulk-disk-${++sequence.value}`,
    verifySource: async ({ anchor }) => ({ status: "verified", sourceCurrent: true, pageCurrent: true, anchor }),
  });
  return { adapter, personalService, runtime, sequence };
}

async function makeCanonicalBundle() {
  const source = makeRuntime(new VocabularyMemoryAdapter(), { value: 0 }, { sessionId: "bulk-disk-source" });
  const imported = await source.personalService.importJson(Array.from({ length: COUNT }, (_, index) => ({
    surface: `term${String(index).padStart(5, "0")}`,
    type: "word",
    status: 2,
    translation: "保留全部记录",
  })));
  assert.equal(imported.imported, COUNT);
  await source.runtime.ready();
  const bundle = await createVocabularyTransfer({ runtime: source.runtime }).exportBundle();
  const parsed = JSON.parse(bundle);
  assert.equal(parsed.stores.core.records.length, COUNT);
  assert.equal(parsed.stores.contexts.records.length, 0);
  assert.equal(parsed.stores.review.records.length, 0);
  await source.runtime.close();
  return { bundle, bundleHash: canonicalHash(parsed), bundleBytes: Buffer.byteLength(bundle) };
}

function totalWriteMetrics(metrics) {
  const byType = metrics.byType;
  return {
    calls: metrics.writes + metrics.appends,
    physicalBytes: metrics.writtenPhysicalBytes + metrics.appendedPhysicalBytes,
    logicalBytes: metrics.writtenLogicalBytes + metrics.appendedLogicalBytes,
    physicalByType: Object.fromEntries(Object.entries(byType).map(([type, value]) => [type,
      value.writtenPhysicalBytes + (value.appendedPhysicalBytes || 0)])),
    logicalByType: Object.fromEntries(Object.entries(byType).map(([type, value]) => [type,
      value.writtenLogicalBytes + (value.appendedLogicalBytes || 0)])),
  };
}

async function runVariant({ mode, round, bundle, bundleHash }) {
  const adapter = await createTemporaryVocabularyAdapter({ mode: mode.adapterMode });
  const target = makeRuntime(adapter, { value: 0 });
  try {
    await target.runtime.ready();
    adapter.resetMetrics();
    const importCpuStart = process.cpuUsage();
    const importStartedAt = performance.now();
    const imported = await createVocabularyTransfer({ runtime: target.runtime }).importBundle(bundle);
    const importMs = performance.now() - importStartedAt;
    const importCpuMicros = cpuMicrosSince(importCpuStart);
    assert.equal(imported.status, "committed");
    assert.equal(imported.imported, COUNT);
    const importMetrics = adapter.measured();
    const importWrites = totalWriteMetrics(importMetrics);

    const batches = await target.runtime.history.listBatches();
    const importBatch = batches.find((batch) => batch.actionKind === "bundle-import");
    assert.ok(importBatch, "the transaction created one complete bundle-import History batch");
    assert.equal(importBatch.schemaVersion, 2);
    assert.equal(importBatch.changes.length, COUNT);
    assert.ok(importBatch.changes.every((change) => change.kind === "entityCreate" && change.fieldPath.length === 2));
    const historyText = await adapter.read(target.runtime.history.pathFor(importBatch.batchId));
    assert.equal(historyText, canonicalStringify(importBatch), "the adapter expands its physical form before coordinator verification");
    const historyChecksum = canonicalHash(importBatch);
    const transactionIndependentHistory = {
      ...importBatch,
      batchId: "<batch-id>",
      transactionId: "<transaction-id>",
      changes: importBatch.changes.map(({ changeId, ...change }) => change),
    };
    const historySemanticHash = canonicalHash(transactionIndependentHistory);

    await target.runtime.mutatePersonal((service) => service.upsertTerm("term00000", {
      note: "local edit preserved by default conflict handling",
    }));
    const previewStartedAt = performance.now();
    const preview = await target.runtime.history.previewRestore(importBatch.batchId);
    const previewMs = performance.now() - previewStartedAt;
    const conflicts = preview.items.filter((item) => item.status === "conflict").length;
    const clean = preview.items.filter((item) => item.status === "clean").length;
    assert.equal(conflicts, 1);
    assert.equal(clean, COUNT - 1);

    const undoStartedAt = performance.now();
    const undo = await target.runtime.restore(importBatch.batchId);
    const undoMs = performance.now() - undoStartedAt;
    assert.equal(undo.status, "committed");
    assert.equal(undo.restored.length, COUNT - 1);
    assert.equal(undo.skipped.length, 1, "default restore leaves the single local conflict untouched");
    assert.equal((await target.personalService.queryLearningTerms({ limit: COUNT + 10 })).length, 1);

    const redoStartedAt = performance.now();
    const redo = await target.runtime.restore(undo.restoreBatchId);
    const redoMs = performance.now() - redoStartedAt;
    assert.equal(redo.status, "committed");
    assert.equal(redo.restored.length, COUNT - 1);
    const recordsAfterRedo = await target.personalService.queryLearningTerms({ limit: COUNT + 10 });
    assert.equal(recordsAfterRedo.length, COUNT);
    assert.equal(recordsAfterRedo.find((record) => record.surface === "term00000")?.note,
      "local edit preserved by default conflict handling");
    const finalDisk = await adapter.diskUsage();

    return {
      round,
      mode: mode.name,
      adapterMode: mode.adapterMode,
      root: adapter.root,
      importMs,
      importCpuMicros,
      adapterEncodeMs: importMetrics.encodeMs,
      adapterDecodeMs: importMetrics.decodeMs,
      adapterEncodeCpuMicros: importMetrics.encodeCpuMicros,
      adapterDecodeCpuMicros: importMetrics.decodeCpuMicros,
      importWrites,
      importIo: {
        reads: importMetrics.reads,
        readLogicalBytes: importMetrics.readLogicalBytes,
        readPhysicalBytes: importMetrics.readPhysicalBytes,
        writeOperations: importMetrics.writes,
        renameOperations: importMetrics.renames,
        touchedFiles: importMetrics.filesTouched.length,
      },
      history: {
        batchId: importBatch.batchId,
        schemaVersion: importBatch.schemaVersion,
        records: importBatch.changes.length,
        logicalBytes: Buffer.byteLength(historyText),
        checksum: historyChecksum,
        semanticHash: historySemanticHash,
      },
      restoreValidation: { conflicts, clean, previewMs, undoMs, redoMs, totalUndoRedoMs: undoMs + redoMs,
        undone: undo.restored.length, redone: redo.restored.length },
      finalDisk,
      finalHistoryBatches: (await target.runtime.history.listBatches()).length,
      bundleHash,
      passed: true,
    };
  } finally {
    await target.runtime.close().catch(() => undefined);
    await adapter.dispose();
  }
}

function mean(rows, read) {
  return rows.reduce((total, row) => total + read(row), 0) / rows.length;
}

function reductionPercent(baseline, candidate) {
  return baseline === 0 ? null : (1 - candidate / baseline) * 100;
}

function increasePercent(baseline, candidate) {
  return baseline === 0 ? null : (candidate / baseline - 1) * 100;
}

function summarize(results, crashChecks) {
  const byRound = new Map();
  const runOrder = new Map();
  for (const row of results) {
    if (!byRound.has(row.round)) byRound.set(row.round, {});
    byRound.get(row.round)[row.mode] = row;
    if (!runOrder.has(row.round)) runOrder.set(row.round, []);
    runOrder.get(row.round).push(row.mode);
  }
  const conditions = {};
  for (const mode of MODES) {
    const rows = results.filter((row) => row.mode === mode.name);
    conditions[mode.name] = {
      runs: rows.length,
      meanImportMs: mean(rows, (row) => row.importMs),
      meanImportCpuMicros: mean(rows, (row) => row.importCpuMicros),
      meanImportPhysicalWriteBytes: mean(rows, (row) => row.importWrites.physicalBytes),
      meanImportLogicalWriteBytes: mean(rows, (row) => row.importWrites.logicalBytes),
      meanHistoryPhysicalWriteBytes: mean(rows, (row) => row.importWrites.physicalByType.history),
      meanHistoryLogicalWriteBytes: mean(rows, (row) => row.importWrites.logicalByType.history),
      meanPendingPhysicalWriteBytes: mean(rows, (row) => row.importWrites.physicalByType.pendingIntent),
      meanPendingLogicalWriteBytes: mean(rows, (row) => row.importWrites.logicalByType.pendingIntent),
      meanAdapterEncodeMs: mean(rows, (row) => row.adapterEncodeMs),
      meanAdapterDecodeMs: mean(rows, (row) => row.adapterDecodeMs),
      meanAdapterEncodeCpuMicros: mean(rows, (row) => row.adapterEncodeCpuMicros),
      meanAdapterDecodeCpuMicros: mean(rows, (row) => row.adapterDecodeCpuMicros),
      meanUndoMs: mean(rows, (row) => row.restoreValidation.undoMs),
      meanRedoMs: mean(rows, (row) => row.restoreValidation.redoMs),
      meanUndoRedoMs: mean(rows, (row) => row.restoreValidation.totalUndoRedoMs),
      meanFinalDiskBytes: mean(rows, (row) => row.finalDisk.bytes),
      meanFinalFileCount: mean(rows, (row) => row.finalDisk.files),
      historyChecksums: [...new Set(rows.map((row) => row.history.checksum))],
    };
  }
  const candidates = {};
  for (const mode of MODES.slice(1)) {
    const paired = [...byRound.values()].map((round) => ({ baseline: round.baseline, candidate: round[mode.name] }));
    const totalWriteReductions = paired.map(({ baseline: base, candidate: next }) =>
      reductionPercent(base.importWrites.physicalBytes, next.importWrites.physicalBytes));
    const historyReductions = paired.map(({ baseline: base, candidate: next }) =>
      reductionPercent(base.importWrites.physicalByType.history, next.importWrites.physicalByType.history));
    const cpuIncreases = paired.map(({ baseline: base, candidate: next }) =>
      increasePercent(base.importCpuMicros, next.importCpuMicros));
    const restoreIncreases = paired.map(({ baseline: base, candidate: next }) =>
      increasePercent(base.restoreValidation.totalUndoRedoMs, next.restoreValidation.totalUndoRedoMs));
    const meanTotalWriteReductionPercent = mean(totalWriteReductions, (value) => value);
    const meanHistoryReductionPercent = mean(historyReductions, (value) => value);
    const meanCpuIncreasePercent = mean(cpuIncreases, (value) => value);
    const meanRestoreIncreasePercent = mean(restoreIncreases, (value) => value);
    const maxCpuIncreasePercent = Math.max(...cpuIncreases);
    const maxRestoreIncreasePercent = Math.max(...restoreIncreases);
    const criteria = {
      totalWriteReductionAtLeast40Percent: meanTotalWriteReductionPercent >= 40,
      historyReductionAtLeast30Percent: meanHistoryReductionPercent >= 30,
      cpuIncreaseAtMost20Percent: maxCpuIncreasePercent <= 20,
      restoreIncreaseAtMost20Percent: maxRestoreIncreasePercent <= 20,
      allCrashRecoveryChecksPassed: crashChecks.passed,
      allSemanticChecksPassed: paired.every(({ baseline: base, candidate: row }) => row.passed &&
        row.restoreValidation.conflicts === 1 && row.restoreValidation.clean === COUNT - 1 &&
        row.history.schemaVersion === 2 && row.history.records === COUNT &&
        row.history.semanticHash === base.history.semanticHash && row.bundleHash === base.bundleHash),
    };
    candidates[mode.name] = {
      pairedRuns: paired.length,
      meanTotalWriteReductionPercent,
      meanHistoryReductionPercent,
      meanCpuIncreasePercent,
      meanRestoreIncreasePercent,
      maxCpuIncreasePercent,
      maxRestoreIncreasePercent,
      comparisons: { totalWriteReductions, historyReductions, cpuIncreases, restoreIncreases },
      criteria,
      qualifiesForD: Object.values(criteria).every(Boolean),
    };
  }
  const qualifies = Object.values(candidates).some((candidate) => candidate.qualifiesForD);
  return {
    pairedRunOrder: [...runOrder.entries()].map(([round, order]) => ({ round, order })),
    conditions,
    candidates,
    decision: qualifies ? "candidate thresholds met; retain experimental encoding for review" : "D keep unchanged",
    crashChecks,
    physicalScope: "Actual bytes written by the Node DataAdapter into isolated OS temporary files, including pending intents, History and other paths; final file sizes are also recorded. This is filesystem evidence, not APFS sector writes or Obsidian/Vault traffic.",
  };
}

function runCrashChecks() {
  const command = ["--test", "tests/vocabulary-bulk-node-adapter.test.mjs"];
  const child = spawnSync(process.execPath, command, { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const output = `${child.stdout || ""}${child.stderr || ""}`;
  return {
    command: `node ${command.join(" ")}`,
    exitCode: child.status,
    passed: child.status === 0,
    outputTail: output.trim().split("\n").slice(-8),
  };
}

async function main() {
  const { bundle, bundleHash, bundleBytes } = await makeCanonicalBundle();
  const results = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const shift = (round - 1) % MODES.length;
    const order = [...MODES.slice(shift), ...MODES.slice(0, shift)];
    for (const mode of order) {
      const result = await runVariant({ mode, round, bundle, bundleHash });
      results.push(result);
      console.log(JSON.stringify({ event: "completed", round, mode: mode.name,
        importMs: result.importMs, importPhysicalWriteBytes: result.importWrites.physicalBytes,
        historyPhysicalWriteBytes: result.importWrites.physicalByType.history,
        restoreRoundTripMs: result.restoreValidation.totalUndoRedoMs, finalDisk: result.finalDisk }));
    }
  }
  assert.equal(results.length, ROUNDS * MODES.length);
  const crashChecks = runCrashChecks();
  assert.equal(crashChecks.passed, true, `disk compression crash and semantic checks failed:\n${crashChecks.outputTail.join("\n")}`);
  const summary = summarize(results, crashChecks);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}/${process.arch} Node ${process.version} real-filesystem temporary DataAdapter`,
    scale: COUNT,
    pairedRunsPerMode: ROUNDS,
    bundle: { bytes: bundleBytes, canonicalHash: bundleHash, records: COUNT },
    historyLogicalBytesBaseline: summary.conditions.baseline.meanHistoryLogicalWriteBytes,
    adapterOperationCounts: { byMode: Object.fromEntries(MODES.map((mode) => [mode.name,
      summary.conditions[mode.name].runs ? results.filter((row) => row.mode === mode.name).map((row) => row.importWrites.calls) : []])) },
    summary,
    runs: results,
    limitations: [
      "The Node adapter uses OS temporary files and reports DataAdapter writes and file sizes; it does not measure physical storage sectors or Obsidian/Vault sync traffic.",
      "All benchmark transforms exist only in the harness adapter; production History schema and transaction coordinator are unchanged.",
    ],
  };
  const output = path.join(ROOT, "evidence", "vocabulary-bulk-disk", "25k-node-filesystem.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ event: "report", output: path.relative(ROOT, output), decision: summary.decision,
    candidates: summary.candidates }));
}
