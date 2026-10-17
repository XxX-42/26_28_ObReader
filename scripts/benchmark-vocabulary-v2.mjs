import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { VocabularyMemoryAdapter } from "../tests/vocabulary-v2-memory-adapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const candidate = require("../plugin/vocabulary/service.cjs");
const baseline = require("../tests/fixtures/legacy-vocabulary-v1-reader.cjs");
const output = process.argv.find((arg) => arg.startsWith("--out="))?.slice(6) ||
  path.join(root, "tests/artifacts/vocabulary-v2/performance/core-baseline-comparison.json");

async function fingerprint() {
  const hash = createHash("sha256");
  for (const file of ["plugin/vocabulary/service.cjs", "plugin/vocabulary/family.cjs", "tests/fixtures/legacy-vocabulary-v1-reader.cjs"]) {
    hash.update(file).update(await readFile(path.join(root, file)));
  }
  return hash.digest("hex");
}

function fixture(recordCount) {
  const records = Array.from({ length: recordCount - 2 }, (_, index) => ({
    surface: `word${String(index).padStart(5, "0")}`, type: "word", status: 1 + index % 5,
  }));
  records.push({ surface: "as a matter of fact in the middle of the old town", type: "phrase", status: 2 });
  records.push({ surface: "walk", type: "word", status: 3 });
  const tokens = Array.from({ length: 6000 }, (_, index) => records[index % (recordCount - 2)].surface);
  tokens.splice(100, 12, ...records.at(-2).surface.split(" "));
  tokens[200] = "walking";
  return { records, tokens };
}

async function sample(implementation, recordCount) {
  const adapter = new VocabularyMemoryAdapter();
  const service = new implementation.VocabularyService({ adapter, now: () => 1000 });
  const { records, tokens } = fixture(recordCount);
  let start = performance.now();
  const imported = await service.importJson(records);
  const importMs = performance.now() - start;
  assert.equal(imported.imported, recordCount);
  const importIO = adapter.measured();
  const samples = [];
  for (const kind of ["cold", "warm", "reenter", "next-page"]) {
    adapter.resetMetrics();
    start = performance.now();
    const result = await service.matchPageTokens(kind === "next-page" ? [...tokens.slice(1), tokens[0]] : tokens);
    const ms = performance.now() - start;
    assert.equal(result.metrics.vocabularyFullScanCount, 0);
    assert.equal(result.metrics.perTokenVocabularyNormalizeCount, 0);
    samples.push({ kind, totalMs: ms, metrics: result.metrics, io: adapter.measured(),
      hitCount: result.wordMatches.length + result.phraseMatches.length });
  }
  await assert.rejects(service.matchPageTokens([...tokens, "overflow"]), RangeError);
  return { recordCount, tokenCount: tokens.length, importMs, importIO, samples };
}

const before = await fingerprint();
const report = { baselineSha: "f877e16cf0d00ee9984dfa76d4f2ecfe086f8b09", platform: "macOS Node DataAdapter simulation",
  scope: "Personal snapshot import and lexical matching only; not PDF opening, geometry, zoom or real iPad acceptance.",
  sourceBefore: before, measurements: [] };
try {
  for (const recordCount of [5340, 25000]) {
    report.measurements.push({ recordCount, baseline: await sample(baseline, recordCount), candidate: await sample(candidate, recordCount) });
  }
  report.sourceAfter = await fingerprint();
  report.stableSource = before === report.sourceAfter;
  report.passed = report.stableSource;
  if (!report.stableSource) process.exitCode = 1;
} catch (error) {
  report.passed = false;
  report.error = { name: error.name, message: error.message, code: error.code || null };
  process.exitCode = 1;
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, passed: report.passed, sizes: report.measurements.map((row) => row.recordCount) }));
