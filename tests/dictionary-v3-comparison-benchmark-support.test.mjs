import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  createECDICTCacheWarmProbePlan,
  createECDICTComparisonInstrumentationPlugin, createECDICTComparisonPlan,
  createECDICTComparisonQueries, ECDICT_COMPARISON_REPETITIONS,
  ECDICT_CACHE_WARM_PROBE_REPETITIONS, ECDICT_CACHE_WARM_PROBE_VARIANTS,
  ECDICT_COMPARISON_VARIANTS, ECDICT_COMPARISON_MIXED_QUERY_COUNT,
  summarizeCachedRepeat,
  selectPassingCacheLimit,
} from "./dictionary-v3-comparison-benchmark-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the 20 cold-run plan predeclares five fixed round-robin trials per variant", () => {
  const plan = createECDICTComparisonPlan("run-fixture");
  assert.equal(plan.length, ECDICT_COMPARISON_REPETITIONS * ECDICT_COMPARISON_VARIANTS.length);
  assert.deepEqual(plan.map(({ sequence }) => sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  for (let round = 0; round < ECDICT_COMPARISON_REPETITIONS; round += 1) {
    assert.deepEqual(plan.slice(round * 4, round * 4 + 4).map(item => item.variant),
      ECDICT_COMPARISON_VARIANTS.map(variant => variant.id));
    assert.ok(plan.slice(round * 4, round * 4 + 4).every(item => item.repetition === round + 1));
  }
});

test("the fixed 20-query mixed workload covers common, rare, missing, boundary, and Unicode cases", () => {
  const manifest = { blocks: Array.from({ length: 3 }, (_, index) => ({
    firstKey: `block${index}-first`, lastKey: `block${index}-last`,
  })) };
  const queries = createECDICTComparisonQueries(manifest, "fixture-run");
  assert.deepEqual(queries.firstRareQuery, { category: "rare", key: "zyzzyva", expected: "found" });
  assert.equal(queries.mixedQueries.length, ECDICT_COMPARISON_MIXED_QUERY_COUNT);
  assert.deepEqual(new Set(queries.mixedQueries.map(query => query.category)),
    new Set(["common", "rare", "unicode", "range-first", "range-last", "not-found"]));
  assert.ok(queries.mixedQueries.some(query => query.key === "alligatoring厄"));
  assert.ok(queries.mixedQueries.some(query => query.key === "block1-first"));
  assert.ok(queries.mixedQueries.some(query => query.key === "block2-last"));
  assert.ok(queries.mixedQueries.every((query, index) => query.ordinal === index + 1));
});

test("cache residency probe predeclares 15 fresh-process trials and separates resident hits", () => {
  const plan = createECDICTCacheWarmProbePlan("warm-fixture");
  assert.equal(plan.length, ECDICT_CACHE_WARM_PROBE_REPETITIONS * ECDICT_CACHE_WARM_PROBE_VARIANTS.length);
  assert.deepEqual(plan.slice(0, 3).map(item => item.variant), ECDICT_CACHE_WARM_PROBE_VARIANTS.map(item => item.id));
  assert.deepEqual(plan.map(item => item.sequence), Array.from({ length: 15 }, (_, index) => index + 1));
  const summary = summarizeCachedRepeat([
    { durationMs: 2, cacheHit: true, cacheMiss: false, binaryReads: 0, bytesReadBinary: 0 },
    { durationMs: 3, cacheHit: true, cacheMiss: false, binaryReads: 0, bytesReadBinary: 0 },
    { durationMs: 30, cacheHit: false, cacheMiss: true, binaryReads: 1, bytesReadBinary: 100 },
    { durationMs: 1, cacheHit: false, cacheMiss: false, binaryReads: 0, bytesReadBinary: 0 },
  ]);
  assert.equal(summary.cacheHitQueries, 2);
  assert.equal(summary.cacheMissQueries, 1);
  assert.equal(summary.noBlockQueries, 1);
  assert.equal(summary.binaryReadQueries, 1);
  assert.equal(summary.bytesReadBinary, 100);
  assert.equal(summary.residentHitP95Ms, 3);
  assert.equal(summary.everyRangedQueryHitResidentBlock, false);
});

test("worker and runtime benchmark instrumentation builds without changing production sources", async () => {
  const plugin = createECDICTComparisonInstrumentationPlugin();
  const worker = await build({
    entryPoints: [path.join(root, "plugin/vocabulary/dictionary-worker.cjs")],
    bundle: true, write: false, platform: "browser", format: "iife",
    define: { "process.env.NODE_ENV": '"production"' }, plugins: [plugin],
  });
  assert.match(worker.outputFiles[0].text, /benchmarkWorkerDecodeMs/u);
  assert.match(worker.outputFiles[0].text, /prepareMs/u);
  const runtime = await build({
    entryPoints: [path.join(root, "plugin/vocabulary/dictionary.cjs")],
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "DictionaryRuntime",
    define: { "process.env.NODE_ENV": '"production"', __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
    plugins: [plugin],
  });
  assert.match(runtime.outputFiles[0].text, /benchmarkBlockWorkerMetrics/u);
  assert.match(runtime.outputFiles[0].text, /benchmarkPrepareMetrics/u);
  assert.match(runtime.outputFiles[0].text, /benchmarkBlockCacheProbes/u);
});

test("no cache limit is selected with incomplete runs or unmeasured startup blocking", () => {
  const summary = (blocks, startupBlockingMs, passed = 5) => ({
    variant: { resource: "v3", blockCacheMaxBlocks: blocks, blockCacheMaxBytes: blocks * 1024 }, passed,
    firstRareP50Ms: 100, firstRareP95Ms: 500, mixed20P95Ms: 24, residentHitP95Ms: 4, startupBlockingMs,
  });
  assert.equal(selectPassingCacheLimit([summary(8, null), summary(16, null)]), null);
  assert.equal(selectPassingCacheLimit([summary(8, 10, 4), summary(16, 10)]).variant.blockCacheMaxBlocks, 16);
  assert.equal(selectPassingCacheLimit([summary(8, 10), summary(16, 10)]).variant.blockCacheMaxBlocks, 8);
  const noResidentMeasurement = summary(8, 10);
  delete noResidentMeasurement.residentHitP95Ms;
  assert.equal(selectPassingCacheLimit([noResidentMeasurement]), null);
  assert.equal(selectPassingCacheLimit([summary(8, 300)]), null);
});
