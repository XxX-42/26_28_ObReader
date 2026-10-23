// Separately declared cache-residency probe. The first pass deliberately fills
// blocks; only repeat lookups proven to hit an already resident block count as
// warm-cache samples. Invoke only after an exclusive benchmark lease.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { withDictionaryBenchmarkBrowser } from "./dictionary-resource-benchmark-support.mjs";
import {
  createECDICTCacheWarmProbePlan, createECDICTComparisonQueries,
  ECDICT_CACHE_WARM_PROBE_REPETITIONS, ECDICT_CACHE_WARM_PROBE_VARIANTS,
  ECDICT_COMPARISON_PROTOCOL_TIMEOUT_MS, instrumentBlockWorker, instrumentDictionaryRuntime,
  summarizeCachedRepeat,
} from "./dictionary-v3-comparison-benchmark-support.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[2] !== "--run") {
  throw new Error("Refusing to launch Chromium without explicit `--run <resource-v3> <output-dir>` arguments.");
}
const rawPaths = process.argv.slice(3, 5);
if (rawPaths.length !== 2 || rawPaths.some(value => !value)) throw new Error("Expected explicit resource-v3 and output paths.");
const [v3Root, reportDirectory] = rawPaths.map(value => path.resolve(value));
const outputRelative = path.relative(repositoryRoot, reportDirectory);
if (!outputRelative || (outputRelative !== ".." && !outputRelative.startsWith(`..${path.sep}`))) {
  throw new Error("Raw benchmark output must be outside the Git worktree.");
}

const manifest = JSON.parse(await readFile(path.join(v3Root, "manifest.json"), "utf8"));
assert.equal(manifest.schemaVersion, 3);
assert.ok(Array.isArray(manifest.blocks) && manifest.blocks.length > 0);
const runSetId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
const comparisonQueries = createECDICTComparisonQueries(manifest, runSetId);
const mixedQueries = comparisonQueries.mixedQueries;
const plan = createECDICTCacheWarmProbePlan(runSetId);
const variants = new Map(ECDICT_CACHE_WARM_PROBE_VARIANTS.map(variant => [variant.id, variant]));
const midBlock = manifest.blocks[Math.floor(manifest.blocks.length / 2)];
const midBytes = await readFile(path.join(v3Root, midBlock.resourceFile));
assert.equal(midBytes.byteLength, midBlock.compressedBytes, "control block compressed size mismatch");
assert.equal(createHash("sha256").update(midBytes).digest("hex"), midBlock.sha256, "control block SHA-256 mismatch");
const midJsonl = gunzipSync(midBytes).toString("utf8");
assert.equal(Buffer.byteLength(midJsonl), midBlock.uncompressedBytes, "control block uncompressed size mismatch");
const midEntries = midJsonl.trimEnd().split("\n").map(line => JSON.parse(line));
assert.equal(midEntries.length, midBlock.entryCount, "control block entry count mismatch");
assert.equal(midEntries[0].key, midBlock.firstKey);
assert.equal(midEntries.at(-1).key, midBlock.lastKey);
const oneBlockQueries = Array.from({ length: 20 }, (_, index) => {
  const entry = midEntries[Math.floor(index * (midEntries.length - 1) / 19)];
  return { ordinal: index + 1, category: "same-block-resident-control", key: entry.key, expected: "found" };
});
assert.equal(new Set(oneBlockQueries.map(query => query.key)).size, 20, "control block must provide 20 distinct keys");

const planPath = path.join(reportDirectory, "run-plan.json");
const resultsPath = path.join(reportDirectory, "run-results.jsonl");
const summaryPath = path.join(reportDirectory, "summary.json");
const predeclaredPlan = {
  protocolVersion: 1,
  runSetId,
  declaredAt: new Date().toISOString(),
  status: "PREDECLARED; no trial has started",
  resourceV3: { schemaVersion: manifest.schemaVersion, entryCount: manifest.entryCount,
    compressedBytes: manifest.compressedBytes, uncompressedBytes: manifest.uncompressedBytes,
    blockCount: manifest.blockCount, sha256: manifest.sha256, source: manifest.source },
  repetitionsPerVariant: ECDICT_CACHE_WARM_PROBE_REPETITIONS,
  variantOrder: ECDICT_CACHE_WARM_PROBE_VARIANTS,
  variants: plan,
  firstRareQuery: comparisonQueries.firstRareQuery,
  mixedQueries: mixedQueries.map(({ ordinal, category, key, expected }) => ({ ordinal, category, key, expected })),
  sameBlockResidentControl: { block: { firstKey: midBlock.firstKey, lastKey: midBlock.lastKey,
    entryCount: midBlock.entryCount, compressedBytes: midBlock.compressedBytes,
    uncompressedBytes: midBlock.uncompressedBytes, sha256: midBlock.sha256 }, queries: oneBlockQueries },
  protocolTimeoutMs: ECDICT_COMPARISON_PROTOCOL_TIMEOUT_MS,
  invariants: [
    "Each trial uses a fresh ordinary persistent-profile Chrome process, unique userDataDir, and unique IndexedDB name; off-record contexts are prohibited.",
    "Chromium HTTP cache is disabled and every local server response is Cache-Control: no-store. The operating-system file cache is not flushed.",
    "Each variant receives five predeclared fresh-process trials in round-robin order. No trial is retried or omitted; failures and NOT_RUN rows are retained.",
    "The 20 mixed keys are looked up once to fill the bounded LRU, then the exact same keys are repeated in the same order. Repeat latency is classified per lookup from cache-hit/miss deltas and binary-read deltas.",
    "A separate 20-distinct-key control uses one SHA-verified manifest block. It is preloaded and repeated without touching other blocks; only measured cache hits with zero binary reads count as resident-hit samples.",
    "The HTTP server serves only manifest-listed files from the explicit resource-v3 root. It never writes to a Vault; output is outside Git.",
    "This is browser-process cache-residency evidence, not Native Obsidian startup evidence and not a claim that all worksets fit in each LRU size.",
  ],
  metricDefinitions: {
    mixedRepeat: "Second-pass exact-repeat timings over the 20 mixed keys. Includes cache misses and out-of-range not-found lookups; it is not the warm-only acceptance metric.",
    residentHit: "A repeat lookup with exactly one instrumented resident-block cache hit, no miss, and zero new binary reads.",
    sameBlockResidentControl: "Second pass over 20 distinct keys from one verified block; reports hit count, miss count, binary reads, cache size, and hit-only percentiles.",
    estimatedBytes: "Runtime's bounded-LRU estimated decoded-entry bytes, not Chromium's total JS heap.",
  },
};
await mkdir(reportDirectory, { recursive: true });
await writeFile(planPath, `${JSON.stringify(predeclaredPlan, null, 2)}\n`, { flag: "wx" });
await writeFile(resultsPath, "", { flag: "wx" });

const worker = await build({
  entryPoints: [path.join(repositoryRoot, "plugin/vocabulary/dictionary-worker.cjs")],
  bundle: true, write: false, platform: "browser", format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "ecdict-v3-warm-probe-worker-metrics", setup(buildApi) {
    buildApi.onLoad({ filter: /dictionary-worker\.cjs$/ }, async ({ path: filename }) => ({
      contents: instrumentBlockWorker(await readFile(filename, "utf8")), loader: "js",
    }));
  } }],
});
const runtime = await build({
  entryPoints: [path.join(repositoryRoot, "plugin/vocabulary/dictionary.cjs")],
  bundle: true, write: false, platform: "browser", format: "iife", globalName: "DictionaryRuntime",
  define: { "process.env.NODE_ENV": '"production"', __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
  plugins: [{ name: "ecdict-v3-warm-probe-runtime-metrics", setup(buildApi) {
    buildApi.onLoad({ filter: /dictionary\.cjs$/ }, async ({ path: filename }) => ({
      contents: instrumentDictionaryRuntime(await readFile(filename, "utf8")), loader: "js",
    }));
  } }],
});
const runtimeSource = runtime.outputFiles[0].text;
const allowedFiles = new Set(["manifest.json", ...manifest.blocks.map(block => block.resourceFile)]);
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ECDICT resource-v3 cache residency probe</title><script src="/runtime.js"></script><script>
  const deleteCache = name => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error || new Error("IndexedDB cleanup failed"));
    request.onblocked = () => reject(new Error("Cache deletion blocked"));
  });
  function createDictionary({ cacheName, variant, reads }) {
    const root = "fixture/dictionaries/ECDICT/resource-v3";
    const adapter = {
      async read(resourcePath) {
        const relative = resourcePath.slice(root.length + 1);
        const response = await fetch("/data?file=" + encodeURIComponent(relative));
        if (!response.ok) throw new Error("manifest read failed: " + response.status + " " + relative);
        return response.text();
      },
      async readBinary(resourcePath) {
        const started = performance.now();
        const relative = resourcePath.slice(root.length + 1);
        const response = await fetch("/data?file=" + encodeURIComponent(relative));
        if (!response.ok) throw new Error("block read failed: " + response.status + " " + relative);
        const bytes = await response.arrayBuffer();
        reads.push({ file: relative, bytes: bytes.byteLength, durationMs: performance.now() - started });
        return bytes;
      },
    };
    return new DictionaryRuntime.VocabularyDictionary({ adapter, root,
      legacyRoot: "fixture/dictionaries/ECDICT/resource-v2", cacheName,
      blockCacheMaxBlocks: variant.blockCacheMaxBlocks,
      blockCacheMaxBytes: variant.blockCacheMaxBytes });
  }
  const counterSnapshot = dictionary => ({ ...(dictionary.benchmarkBlockCacheProbes || { lookups: 0, hits: 0, misses: 0 }) });
  const measureSequence = async (dictionary, queries, reads) => {
    const samples = [];
    for (const query of queries) {
      const before = counterSnapshot(dictionary);
      const readCountBefore = reads.length;
      const bytesBefore = reads.reduce((sum, read) => sum + read.bytes, 0);
      const started = performance.now();
      const entry = await dictionary.lookup(query.key);
      const durationMs = performance.now() - started;
      const after = counterSnapshot(dictionary);
      const binaryReads = reads.length - readCountBefore;
      const bytesReadBinary = reads.slice(readCountBefore).reduce((sum, read) => sum + read.bytes, 0);
      const cacheHits = after.hits - before.hits;
      const cacheMisses = after.misses - before.misses;
      if (query.expected === "found" && (!entry || entry.key !== query.key)) throw new Error("expected key missing: " + query.key);
      if (query.expected === "missing" && entry) throw new Error("expected missing key found: " + query.key);
      samples.push({ ordinal: query.ordinal, category: query.category, key: query.key,
        found: entry !== null, durationMs, cacheHits, cacheMisses,
        cacheHit: cacheHits === 1 && cacheMisses === 0,
        cacheMiss: cacheMisses > 0, binaryReads, bytesReadBinary,
        bytesBefore, bytesAfter: reads.reduce((sum, read) => sum + read.bytes, 0) });
    }
    return samples;
  };
  window.runECDICTCacheWarmProbe = async ({ cacheName, variant, firstRareQuery, mixedQueries, oneBlockQueries }) => {
    const reads = [];
    const dictionary = createDictionary({ cacheName, variant, reads });
    window.__ecdictWarmProbe = { dictionary, cacheName };
    const firstStarted = performance.now();
    const firstRare = await dictionary.lookup(firstRareQuery.key);
    const firstRareMs = performance.now() - firstStarted;
    if (!firstRare || firstRare.key !== firstRareQuery.key) throw new Error("first rare query failed");
    const mixedPrime = await measureSequence(dictionary, mixedQueries, reads);
    const mixedPrimeCache = dictionary.getBlockCacheStats();
    const mixedRepeat = await measureSequence(dictionary, mixedQueries, reads);
    const mixedRepeatCache = dictionary.getBlockCacheStats();
    const oneBlockPrime = await measureSequence(dictionary, oneBlockQueries, reads);
    const oneBlockPrimeCache = dictionary.getBlockCacheStats();
    const oneBlockRepeat = await measureSequence(dictionary, oneBlockQueries, reads);
    const oneBlockRepeatCache = dictionary.getBlockCacheStats();
    return {
      firstRareMs,
      mixed: { prime: mixedPrime, primeCache: mixedPrimeCache, repeat: mixedRepeat,
        repeatCache: mixedRepeatCache },
      sameBlockControl: { prime: oneBlockPrime, primeCache: oneBlockPrimeCache,
        repeat: oneBlockRepeat, repeatCache: oneBlockRepeatCache },
      totalBinaryReads: reads.length,
      totalBinaryReadBytes: reads.reduce((sum, read) => sum + read.bytes, 0),
      binaryReads: reads,
      blockWorker: dictionary.benchmarkBlockWorkerMetrics || null,
    };
  };
  window.finishECDICTCacheWarmProbe = async () => {
    const open = window.__ecdictWarmProbe;
    if (!open) return false;
    open.dictionary.dispose();
    const deleted = await deleteCache(open.cacheName);
    window.__ecdictWarmProbe = null;
    return deleted;
  };
</script>`;

const v3Variant = { root: v3Root };
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/runtime.js") {
    response.setHeader("Content-Type", "text/javascript");
    return response.end(runtimeSource);
  }
  if (url.pathname === "/data") {
    const relative = url.searchParams.get("file");
    if (!allowedFiles.has(relative)) {
      response.statusCode = 404;
      return response.end("resource not in prevalidated manifest");
    }
    const filename = path.resolve(v3Variant.root, relative);
    const rootPrefix = `${path.resolve(v3Variant.root)}${path.sep}`;
    if (filename !== path.resolve(v3Variant.root, "manifest.json") && !filename.startsWith(rootPrefix)) {
      response.statusCode = 403;
      return response.end("invalid resource path");
    }
    response.setHeader("Content-Type", relative.endsWith(".json") ? "application/json" : "application/gzip");
    return createReadStream(filename).on("error", () => { if (!response.headersSent) response.statusCode = 404; response.end(); }).pipe(response);
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html);
});

async function directoryBytes(directory) {
  let total = 0;
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) total += (await stat(filename)).size;
    }
  }
  await visit(directory);
  return total;
}

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const outcomes = [];
let failures = 0;
try {
  for (const planned of plan) {
    const variant = variants.get(planned.variant);
    const cacheName = `obreader-ecdict-warm-probe-${runSetId}-${String(planned.sequence).padStart(2, "0")}`;
    const run = { ...planned, cacheName, status: "started", startedAt: new Date().toISOString() };
    await appendFile(resultsPath, `${JSON.stringify(run)}\n`);
    console.log(JSON.stringify({ event: "run-start", ...planned }));
    const userDataDir = await mkdtemp(path.join(tmpdir(), "pdf-reader-ecdict-warm-probe-"));
    let browserPage;
    try {
      await withDictionaryBenchmarkBrowser(() => launchTestBrowser(puppeteer, {
        executablePath: resolveBrowserPath(), headless: true, userDataDir,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        protocolTimeout: ECDICT_COMPARISON_PROTOCOL_TIMEOUT_MS,
      }, { testName: `ecdict-v3-cache-warm-probe-${planned.sequence}` }), async page => {
        browserPage = page;
        const profileBefore = await directoryBytes(userDataDir);
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
        const result = await page.evaluate(args => window.runECDICTCacheWarmProbe(args), {
          cacheName, variant, firstRareQuery: comparisonQueries.firstRareQuery,
          mixedQueries, oneBlockQueries,
        });
        const profileAfter = await directoryBytes(userDataDir);
        const completed = { ...run, status: "passed", completedAt: new Date().toISOString(),
          profile: { beforeBytes: profileBefore, afterBytes: profileAfter, growthBytes: profileAfter - profileBefore },
          result };
        outcomes.push(completed);
        await appendFile(resultsPath, `${JSON.stringify(completed)}\n`);
        const mixed = summarizeCachedRepeat(result.mixed.repeat);
        const control = summarizeCachedRepeat(result.sameBlockControl.repeat);
        console.log(JSON.stringify({ event: "run-result", sequence: planned.sequence, variant: planned.variant,
          status: "passed", firstRareMs: result.firstRareMs,
          mixedRepeatP95Ms: mixed.repeatP95Ms, mixedHitP95Ms: mixed.residentHitP95Ms,
          mixedHits: mixed.cacheHitQueries, mixedMisses: mixed.cacheMissQueries, mixedReads: mixed.binaryReadQueries,
          controlHitP95Ms: control.residentHitP95Ms, controlHits: control.cacheHitQueries,
          controlMisses: control.cacheMissQueries, controlReads: control.binaryReadQueries,
          controlCache: result.sameBlockControl.repeatCache }));
      });
    } catch (error) {
      failures += 1;
      let partial = null;
      if (browserPage) {
        try { partial = await browserPage.evaluate(() => ({
          cache: window.__ecdictWarmProbe?.dictionary.getBlockCacheStats?.() || null,
          reads: window.__ecdictWarmProbe?.dictionary.benchmarkBlockWorkerMetrics || null,
        })); } catch {}
      }
      const failed = { ...run, status: "failed", completedAt: new Date().toISOString(), partial,
        error: { name: error?.name || "Error", message: String(error?.message || error), stack: error?.stack || null } };
      outcomes.push(failed);
      await appendFile(resultsPath, `${JSON.stringify(failed)}\n`);
      console.error(JSON.stringify({ event: "run-result", sequence: planned.sequence, variant: planned.variant,
        status: "failed", error: failed.error }));
    } finally {
      if (browserPage) {
        try { await browserPage.evaluate(() => window.finishECDICTCacheWarmProbe?.()); } catch {}
      }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
} catch (error) {
  failures += 1;
  const record = { event: "harness-failed", at: new Date().toISOString(),
    error: { name: error?.name || "Error", message: String(error?.message || error), stack: error?.stack || null } };
  await appendFile(resultsPath, `${JSON.stringify(record)}\n`);
  console.error(JSON.stringify(record));
} finally {
  await new Promise(resolve => server.close(resolve));
}

for (const planned of plan.filter(row => !outcomes.some(done => done.sequence === row.sequence))) {
  const notRun = { ...planned, status: "NOT_RUN", reason: "Harness infrastructure ended before this declared run." };
  outcomes.push(notRun);
  await appendFile(resultsPath, `${JSON.stringify(notRun)}\n`);
}
const perVariant = ECDICT_CACHE_WARM_PROBE_VARIANTS.map(variant => {
  const runs = outcomes.filter(outcome => outcome.variant === variant.id);
  const passed = runs.filter(outcome => outcome.status === "passed");
  const mixedSamples = passed.flatMap(run => run.result.mixed.repeat);
  const controlSamples = passed.flatMap(run => run.result.sameBlockControl.repeat);
  return {
    variant, planned: runs.length, passed: passed.length,
    mixedRepeat: summarizeCachedRepeat(mixedSamples),
    mixedPerTrial: passed.map(run => summarizeCachedRepeat(run.result.mixed.repeat)),
    sameBlockResidentControl: summarizeCachedRepeat(controlSamples),
    sameBlockPerTrial: passed.map(run => summarizeCachedRepeat(run.result.sameBlockControl.repeat)),
    allSameBlockTrialsAllResident: passed.length === ECDICT_CACHE_WARM_PROBE_REPETITIONS &&
      passed.every(run => summarizeCachedRepeat(run.result.sameBlockControl.repeat).everyRangedQueryHitResidentBlock),
    maxEstimatedCacheBytes: Math.max(0, ...passed.flatMap(run => [run.result.mixed.repeatCache.estimatedBytes,
      run.result.sameBlockControl.repeatCache.estimatedBytes])),
  };
});
const summary = { runSetId, plannedRuns: plan.length, passedRuns: outcomes.filter(run => run.status === "passed").length,
  failedRuns: failures, notRun: outcomes.filter(run => run.status === "NOT_RUN").length,
  status: failures || outcomes.some(run => run.status === "NOT_RUN") ? "INCOMPLETE_OR_FAILED" : "COMPLETE_CACHE_RESIDENCY_PROBE",
  warmAcceptanceThresholdMs: 10, perVariant, plan: planPath, results: resultsPath };
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(summary));
if (failures) process.exitCode = 1;
