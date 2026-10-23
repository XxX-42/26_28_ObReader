import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const ECDICT_COMPARISON_REPETITIONS = 5;
export const ECDICT_COMPARISON_WARM_QUERY_COUNT = 20;
export const ECDICT_COMPARISON_PROTOCOL_TIMEOUT_MS = 180_000;
export const ECDICT_COMPARISON_VARIANTS = Object.freeze([
  Object.freeze({ id: "v2-explicit-full-import", resource: "v2", blockCacheMaxBlocks: 0, blockCacheMaxBytes: 0 }),
  Object.freeze({ id: "v3-lru-8", resource: "v3", blockCacheMaxBlocks: 8, blockCacheMaxBytes: 8 * 1024 * 1024 }),
  Object.freeze({ id: "v3-lru-16", resource: "v3", blockCacheMaxBlocks: 16, blockCacheMaxBytes: 8 * 1024 * 1024 }),
  Object.freeze({ id: "v3-lru-32", resource: "v3", blockCacheMaxBlocks: 32, blockCacheMaxBytes: 8 * 1024 * 1024 }),
]);

export function createECDICTComparisonInstrumentationPlugin() {
  return {
    name: "ecdict-v3-comparison-instrumentation",
    setup(build) {
      build.onLoad({ filter: /dictionary-worker\.cjs$/ }, async ({ path }) => ({
        contents: instrumentBlockWorker(await readFile(path, "utf8")), loader: "js",
      }));
      build.onLoad({ filter: /dictionary\.cjs$/ }, async ({ path }) => ({
        contents: instrumentDictionaryRuntime(await readFile(path, "utf8")), loader: "js",
      }));
    },
  };
}

export function createECDICTComparisonQueries(v3Manifest, runSetId) {
  assert.ok(Array.isArray(v3Manifest?.blocks) && v3Manifest.blocks.length > 0,
    "resource-v3 manifest must contain a range index");
  const middle = v3Manifest.blocks[Math.floor(v3Manifest.blocks.length / 2)];
  const final = v3Manifest.blocks.at(-1);
  const fixed = [
    { category: "common", key: "on", expected: "found" },
    { category: "common", key: "about", expected: "found" },
    { category: "common", key: "mostly", expected: "found" },
    { category: "rare", key: "zyzzyva", expected: "found" },
    { category: "rare", key: "subscription", expected: "found" },
    { category: "unicode", key: "alligatoring厄", expected: "found" },
    { category: "range-first", key: v3Manifest.blocks[0].firstKey, expected: "found" },
    { category: "range-last", key: v3Manifest.blocks[0].lastKey, expected: "found" },
    { category: "range-first", key: middle.firstKey, expected: "found" },
    { category: "range-last", key: middle.lastKey, expected: "found" },
    { category: "range-first", key: final.firstKey, expected: "found" },
    { category: "range-last", key: final.lastKey, expected: "found" },
    { category: "not-found", key: `codex-benchmark-not-found-${runSetId}`, expected: "missing" },
  ];
  const warmQueries = Array.from({ length: ECDICT_COMPARISON_WARM_QUERY_COUNT }, (_, index) => ({
    ...fixed[index < fixed.length ? index : 1 + ((index - fixed.length) % 5)],
    ordinal: index + 1,
  }));
  return { firstRareQuery: { category: "rare", key: "zyzzyva", expected: "found" }, warmQueries };
}

/** Five fixed rounds keep every variant represented throughout the run set. */
export function createECDICTComparisonPlan(runSetId) {
  return Array.from({ length: ECDICT_COMPARISON_REPETITIONS }, (_, round) =>
    ECDICT_COMPARISON_VARIANTS.map((variant, variantIndex) => ({
      sequence: round * ECDICT_COMPARISON_VARIANTS.length + variantIndex + 1,
      round: round + 1,
      variant: variant.id,
      repetition: round + 1,
      runSetId,
    }))).flat();
}

export function replaceBenchmarkSeam(source, search, replacement, label) {
  const count = source.split(search).length - 1;
  assert.equal(count, 1, `Expected one ${label} instrumentation seam, found ${count}`);
  return source.replace(search, replacement);
}

export function instrumentBlockWorker(source) {
  source = replaceBenchmarkSeam(source,
    "const { decodeBlockResource } = require(\"./dictionary-resource.cjs\");",
    "const { decodeBlockResource } = require(\"./dictionary-resource.cjs\");\n" +
      "globalThis.__ecdictBenchmarkWorker = { blockDecodeCalls: 0, blockDecodeMs: 0, blockCompressedBytes: 0, blockEstimatedBytes: 0, prepareMs: 0 };",
    "worker metrics initialization");
  source = replaceBenchmarkSeam(source,
    "      const decoded = await decodeBlockResource(data.block, data.bytes, { batchSize: 512 });\n" +
      "      self.postMessage({ type: \"block-ready\", id: data.id, decoded });",
    "      const __blockStarted = performance.now();\n" +
      "      const decoded = await decodeBlockResource(data.block, data.bytes, { batchSize: 512 });\n" +
      "      const __blockElapsed = performance.now() - __blockStarted;\n" +
      "      globalThis.__ecdictBenchmarkWorker.blockDecodeCalls += 1;\n" +
      "      globalThis.__ecdictBenchmarkWorker.blockDecodeMs += __blockElapsed;\n" +
      "      globalThis.__ecdictBenchmarkWorker.blockCompressedBytes += data.bytes.byteLength;\n" +
      "      globalThis.__ecdictBenchmarkWorker.blockEstimatedBytes += decoded.estimatedBytes;\n" +
      "      decoded.benchmarkWorkerDecodeMs = __blockElapsed;\n" +
      "      decoded.benchmarkWorkerCompressedBytes = data.bytes.byteLength;\n" +
      "      self.postMessage({ type: \"block-ready\", id: data.id, decoded });",
    "block worker decode metrics");
  source = replaceBenchmarkSeam(source,
    "  try {\n    // The worker can use a larger bounded batch without blocking Reader input.",
    "  try {\n    const __prepareStarted = performance.now();\n    // The worker can use a larger bounded batch without blocking Reader input.",
    "v2 worker prepare timer start");
  return replaceBenchmarkSeam(source,
    "    self.postMessage({ type: \"ready\", ready });",
    "    globalThis.__ecdictBenchmarkWorker.prepareMs = performance.now() - __prepareStarted;\n" +
      "    self.postMessage({ type: \"ready\", ready, benchmarkMetrics: globalThis.__ecdictBenchmarkWorker });",
    "v2 worker prepare timer result");
}

export function instrumentDictionaryRuntime(source) {
  source = replaceBenchmarkSeam(source,
    "          else if (data?.type === \"ready\") finish(resolve, data.ready);",
    "          else if (data?.type === \"ready\") { this.benchmarkPrepareMetrics = data.benchmarkMetrics || null; finish(resolve, data.ready); }",
    "v2 worker metrics capture");
  return replaceBenchmarkSeam(source,
    "          if (data.type === \"block-ready\") request.resolve(data.decoded);",
    "          if (data.type === \"block-ready\") {\n" +
      "            const metrics = this.benchmarkBlockWorkerMetrics || (this.benchmarkBlockWorkerMetrics = { calls: 0, decodeMs: 0, compressedBytes: 0, estimatedBytes: 0 });\n" +
      "            metrics.calls += 1; metrics.decodeMs += data.decoded.benchmarkWorkerDecodeMs || 0;\n" +
      "            metrics.compressedBytes += data.decoded.benchmarkWorkerCompressedBytes || 0;\n" +
      "            metrics.estimatedBytes += data.decoded.estimatedBytes || 0;\n" +
      "            request.resolve(data.decoded);\n" +
      "          }",
    "v3 worker metrics capture");
}

export function selectPassingCacheLimit(summaries, thresholds = {}) {
  const limits = { firstRareP50Ms: 300, firstRareP95Ms: 1000, warmP95Ms: 10, startupBlockingMs: 50, ...thresholds };
  const passing = summaries.filter(item => item.variant?.resource === "v3" && item.passed === ECDICT_COMPARISON_REPETITIONS &&
    Number.isFinite(item.startupBlockingMs) &&
    item.firstRareP50Ms < limits.firstRareP50Ms && item.firstRareP95Ms < limits.firstRareP95Ms &&
    item.warmP95Ms < limits.warmP95Ms && item.startupBlockingMs < limits.startupBlockingMs)
    .sort((left, right) => left.variant.blockCacheMaxBlocks - right.variant.blockCacheMaxBlocks ||
      left.variant.blockCacheMaxBytes - right.variant.blockCacheMaxBytes);
  return passing[0] || null;
}
