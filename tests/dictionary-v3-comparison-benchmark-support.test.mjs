import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  createECDICTComparisonInstrumentationPlugin, createECDICTComparisonPlan,
  createECDICTComparisonQueries, ECDICT_COMPARISON_REPETITIONS,
  ECDICT_COMPARISON_VARIANTS, ECDICT_COMPARISON_WARM_QUERY_COUNT,
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

test("the 20 fixed warm queries cover common, rare, missing, boundary, and Unicode cases", () => {
  const manifest = { blocks: Array.from({ length: 3 }, (_, index) => ({
    firstKey: `block${index}-first`, lastKey: `block${index}-last`,
  })) };
  const queries = createECDICTComparisonQueries(manifest, "fixture-run");
  assert.deepEqual(queries.firstRareQuery, { category: "rare", key: "zyzzyva", expected: "found" });
  assert.equal(queries.warmQueries.length, ECDICT_COMPARISON_WARM_QUERY_COUNT);
  assert.deepEqual(new Set(queries.warmQueries.map(query => query.category)),
    new Set(["common", "rare", "unicode", "range-first", "range-last", "not-found"]));
  assert.ok(queries.warmQueries.some(query => query.key === "alligatoring厄"));
  assert.ok(queries.warmQueries.some(query => query.key === "block1-first"));
  assert.ok(queries.warmQueries.some(query => query.key === "block2-last"));
  assert.ok(queries.warmQueries.every((query, index) => query.ordinal === index + 1));
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
});

test("no cache limit is selected with incomplete runs or unmeasured startup blocking", () => {
  const summary = (blocks, startupBlockingMs, passed = 5) => ({
    variant: { resource: "v3", blockCacheMaxBlocks: blocks, blockCacheMaxBytes: blocks * 1024 }, passed,
    firstRareP50Ms: 100, firstRareP95Ms: 500, warmP95Ms: 4, startupBlockingMs,
  });
  assert.equal(selectPassingCacheLimit([summary(8, null), summary(16, null)]), null);
  assert.equal(selectPassingCacheLimit([summary(8, 10, 4), summary(16, 10)]).variant.blockCacheMaxBlocks, 16);
  assert.equal(selectPassingCacheLimit([summary(8, 10), summary(16, 10)]).variant.blockCacheMaxBlocks, 8);
  assert.equal(selectPassingCacheLimit([summary(8, 300)]), null);
});
