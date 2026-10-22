// Explicit 20-run resource-v2 benchmark. It uses isolated IndexedDB names and
// never opens a real Vault or modifies the copied source resource.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { DICTIONARY_BENCHMARK_REPETITIONS, DICTIONARY_BENCHMARK_VARIANTS,
  createDictionaryBenchmarkPlan, createDictionaryBenchmarkPlugin, withDictionaryBenchmarkBrowser } from "./dictionary-resource-benchmark-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourceRoot = path.resolve(process.argv[2] || path.join(root, "tests/artifacts/resource-v2"));
const manifest = JSON.parse(await readFile(path.join(resourceRoot, "manifest.json"), "utf8"));
assert.equal(manifest.entryCount, 770611, "the frozen resource-v2 entry count must match the implementation contract");
assert.equal(manifest.compressedBytes, 16734703);
assert.equal(manifest.uncompressedBytes, 69667588);
assert.equal(manifest.sha256, "b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126");

const runSetId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
const reportDirectory = path.join(root, "tests/output/dictionary-resource-benchmark-20261022", runSetId);
const planPath = path.join(reportDirectory, "run-plan.json");
const resultsPath = path.join(reportDirectory, "run-results.jsonl");
const summaryPath = path.join(reportDirectory, "summary.json");
const plan = createDictionaryBenchmarkPlan();
const predeclaredPlan = {
  protocolVersion: 3,
  runSetId,
  status: "PREDECLARED; no benchmark run has started",
  resource: { entryCount: manifest.entryCount, compressedBytes: manifest.compressedBytes,
    uncompressedBytes: manifest.uncompressedBytes, sha256: manifest.sha256 },
  repetitionsPerVariant: DICTIONARY_BENCHMARK_REPETITIONS,
  variantOrder: DICTIONARY_BENCHMARK_VARIANTS.map(({ id, batchSize, membershipTail }) => ({ id, batchSize, membershipTail })),
  runs: plan,
  invariants: [
    "One fresh owned ordinary on-disk Chrome profile and browser per cold run; browser closes in finally on success or failure. No off-record context.",
    "Chromium HTTP cache is disabled and benchmark responses use Cache-Control: no-store; OS filesystem cache is not flushed.",
    "No run retry, skip, timeout extension, or selection by outcome.",
    "The same worker path and instrumentation run for all variants; only batch size and the declared membership-tail variant differ.",
    "resource-v2 still completes its full build before the first query; firstQueryMs is not lazy lookup latency.",
    "The viewport is Chromium automation only and is not physical iPad WKWebView evidence.",
  ],
  metricDefinitions: {
    readBinary: "Main-thread adapter fetch duration and compressed bytes returned.",
    sha256: "Worker Web Crypto duration and compressed bytes hashed.",
    gzip: "Cumulative DecompressionStream reader.read duration, compressed input bytes, and uncompressed output bytes.",
    jsonlParse: "Time inside JSON.parse only; record bytes exclude line-feed separators.",
    bulkPut: "Dexie bulkPut call time, imported rows, compact source JSON bytes, and explicit import transactions.",
    membership: "Timed IndexedDB membership get/put calls; bytes are UTF-8 key payload bytes, excluding IndexedDB object and array overhead.",
    finalVerify: "Final entry-count query and ready transaction duration; bytes report the four-byte count result, not physical IndexedDB scan I/O.",
    memory: "Chromium main-thread performance.memory only; worker heap is unavailable unless the runtime exposes it.",
    mainThreadLongTask: "PerformanceObserver longtask entries during the cold run; unavailable where Chromium does not expose the entry type.",
  },
};
await mkdir(reportDirectory, { recursive: true });
await writeFile(planPath, `${JSON.stringify(predeclaredPlan, null, 2)}\n`, { flag: "wx" });
await writeFile(resultsPath, "", { flag: "wx" });

const runtimeByVariant = new Map();
for (const variant of DICTIONARY_BENCHMARK_VARIANTS) {
  const plugin = createDictionaryBenchmarkPlugin(variant);
  const worker = await build({
    entryPoints: [path.join(root, "plugin/vocabulary/dictionary-worker.cjs")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [plugin],
  });
  const runtime = await build({
    entryPoints: [path.join(root, "plugin/vocabulary/dictionary.cjs")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "DictionaryRuntime",
    define: {
      "process.env.NODE_ENV": '"production"',
      __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text),
    },
    plugins: [plugin],
  });
  runtimeByVariant.set(variant.id, runtime.outputFiles[0].text);
}

const html = (variant) => `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ECDICT resource-v2 benchmark</title>
  <script src="/runtime.js?variant=${encodeURIComponent(variant.id)}"></script>
  <script>
    const manifestUrl = "/manifest.json";
    const statusEvents = [];
    const longTaskEntries = [];
    const longTaskAvailable = typeof PerformanceObserver === "function" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask");
    if (longTaskAvailable) {
      new PerformanceObserver(list => longTaskEntries.push(...list.getEntries().map(entry => ({
        startTime: entry.startTime, duration: entry.duration,
      })))).observe({ type: "longtask", buffered: true });
    }
    const sampleTerms = ["on", "mostly", "subscription", "details", "about"];
    const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0;
    const heapUsed = () => performance.memory?.usedJSHeapSize ?? null;
    const deleteCache = name => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error || new Error("IndexedDB cleanup failed"));
      request.onblocked = () => reject(new Error("Fresh benchmark cache cleanup was blocked"));
    });
    function createDictionary(cacheName) {
      const binaryReads = [];
      const manifestReads = [];
      const progress = [];
      let fullReadyAt = null;
      const adapter = {
        async read() {
          const started = performance.now();
          const response = await fetch(manifestUrl);
          const text = await response.text();
          manifestReads.push({ durationMs: performance.now() - started, bytes: new TextEncoder().encode(text).byteLength });
          return text;
        },
        async readBinary(resourcePath) {
          const started = performance.now();
          const response = await fetch("/" + resourcePath.split("/").at(-1));
          const bytes = await response.arrayBuffer();
          binaryReads.push({ durationMs: performance.now() - started, bytes: bytes.byteLength });
          return bytes;
        },
      };
      const dictionary = new DictionaryRuntime.VocabularyDictionary({ cacheName, adapter, onStatus(status) {
        progress.push({ ...status, at: performance.now(), mainThreadHeapBytes: heapUsed() });
        if (status.phase === "ready" && fullReadyAt === null) fullReadyAt = performance.now();
      } });
      return { dictionary, binaryReads, manifestReads, progress, get fullReadyAt() { return fullReadyAt; } };
    }
    window.runDictionaryBenchmark = async ({ cacheName }) => {
      const runStarted = performance.now();
      const coldHeapBefore = heapUsed();
      const coldLongTaskStart = longTaskEntries.length;
      let cold = createDictionary(cacheName);
      const firstQueryStarted = performance.now();
      const first = await cold.dictionary.lookup("on");
      const firstQueryMs = performance.now() - firstQueryStarted;
      const fullReadyMs = cold.fullReadyAt === null ? null : cold.fullReadyAt - runStarted;
      const coldHeapAfterReady = heapUsed();
      const coldLatencies = [];
      for (let index = 0; index < 100; index += 1) {
        const started = performance.now();
        const entry = await cold.dictionary.lookup(sampleTerms[index % sampleTerms.length]);
        if (!entry?.translation) throw new Error("missing definition for " + sampleTerms[index % sampleTerms.length]);
        coldLatencies.push(performance.now() - started);
      }
      coldLatencies.sort((a, b) => a - b);
      const coldEnded = performance.now();
      const workerMetrics = cold.dictionary.benchmarkMetrics;
      const coldProgress = cold.progress;
      const coldReadBinary = cold.binaryReads;
      const coldManifestReads = cold.manifestReads;
      const coldTaskEntries = longTaskEntries.slice(coldLongTaskStart).filter(entry =>
        entry.startTime >= runStarted && entry.startTime <= coldEnded);
      const coldHeapAfterQueries = heapUsed();
      await cold.dictionary.dispose();
      if (!workerMetrics) throw new Error("worker stage metrics were not returned");

      const warm = createDictionary(cacheName);
      const warmStarted = performance.now();
      const warmFirst = await warm.dictionary.lookup("on");
      const warmFirstLookupMs = performance.now() - warmStarted;
      const warmReadyMs = warm.fullReadyAt === null ? null : warm.fullReadyAt - warmStarted;
      const warmLatencies = [];
      for (let index = 0; index < 100; index += 1) {
        const started = performance.now();
        const entry = await warm.dictionary.lookup(sampleTerms[index % sampleTerms.length]);
        if (!entry?.translation) throw new Error("missing warm definition for " + sampleTerms[index % sampleTerms.length]);
        warmLatencies.push(performance.now() - started);
      }
      warmLatencies.sort((a, b) => a - b);
      const warmEnded = performance.now();
      const warmReadBinary = warm.binaryReads;
      const warmManifestReads = warm.manifestReads;
      await warm.dictionary.dispose();
      const cacheDeleted = await deleteCache(cacheName);

      if (!first?.translation?.includes("之上")) throw new Error("the ECDICT 'on' correctness sample changed");
      if (JSON.stringify(first) !== JSON.stringify(warmFirst)) throw new Error("warm result differed from cold result");
      if (coldReadBinary.length !== 1) throw new Error("cold run must read exactly one compressed resource");
      if (warmReadBinary.length !== 0) throw new Error("reopened warm cache must not read the compressed resource");
      if (workerMetrics.jsonlParsedRecords !== 770611) throw new Error("worker did not parse the complete frozen resource");
      if (workerMetrics.gzipOutputBytes !== 69667588) throw new Error("worker decompressed byte count did not match the manifest");
      if (workerMetrics.stages.finalVerify.rows !== 770611) throw new Error("final verification count did not match the manifest");

      const longTaskTotalMs = coldTaskEntries.reduce((total, entry) => total + entry.duration, 0);
      return {
        cacheName,
        resource: { entryCount: 770611, compressedBytes: 16734703, uncompressedBytes: 69667588,
          sha256: "b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126" },
        firstQueryMs,
        fullReadyMs,
        cold: { readBinary: coldReadBinary, manifestRead: coldManifestReads, warmLookupP50Ms: percentile(coldLatencies, 0.50),
          warmLookupP95Ms: percentile(coldLatencies, 0.95), warmLookupMaxMs: coldLatencies.at(-1),
          mainThreadHeapBytes: { before: coldHeapBefore, afterReady: coldHeapAfterReady, afterQueries: coldHeapAfterQueries },
          mainThreadHeapSamples: coldProgress.map(({ at, phase, count, total, mainThreadHeapBytes }) =>
            ({ at, phase, count, total, bytes: mainThreadHeapBytes })),
          mainThreadLongTask: { available: longTaskAvailable, count: coldTaskEntries.length,
            totalMs: longTaskTotalMs, maxMs: Math.max(0, ...coldTaskEntries.map(entry => entry.duration)), entries: coldTaskEntries },
          progress: coldProgress, worker: workerMetrics },
        reopenedWarm: { firstLookupMs: warmFirstLookupMs, readyMs: warmReadyMs, readBinary: warmReadBinary,
          manifestRead: warmManifestReads, lookupP50Ms: percentile(warmLatencies, 0.50),
          lookupP95Ms: percentile(warmLatencies, 0.95), lookupMaxMs: warmLatencies.at(-1) },
        correctness: { first, warmFirst, parsedRecords: workerMetrics.jsonlParsedRecords,
          finalVerifiedEntries: workerMetrics.stages.finalVerify.rows, cacheDeleted },
        elapsedMs: warmEnded - runStarted,
      };
    };
  </script>`;

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/runtime.js") {
    const runtime = runtimeByVariant.get(url.searchParams.get("variant"));
    if (!runtime) { response.statusCode = 404; return response.end("unknown benchmark variant"); }
    response.setHeader("Content-Type", "text/javascript");
    return response.end(runtime);
  }
  if (url.pathname === "/manifest.json" || url.pathname === `/${manifest.resourceFile}`) {
    const filename = path.join(resourceRoot, path.basename(url.pathname));
    response.setHeader("Content-Type", url.pathname.endsWith(".json") ? "application/json" : "application/gzip");
    return createReadStream(filename).pipe(response);
  }
  const variant = DICTIONARY_BENCHMARK_VARIANTS.find(({ id }) => id === url.searchParams.get("variant"));
  if (!variant) { response.statusCode = 404; return response.end("unknown benchmark variant"); }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html(variant));
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let failedRuns = 0;
const finishedRuns = [];
try {
  for (const planned of plan) {
    const variant = DICTIONARY_BENCHMARK_VARIANTS.find(({ id }) => id === planned.variant);
    const cacheName = `obreader-f-${runSetId}-${String(planned.sequence).padStart(2, "0")}`;
    const run = { ...planned, runSetId, cacheName, status: "started", startedAt: new Date().toISOString() };
    await appendFile(resultsPath, `${JSON.stringify(run)}\n`);
    console.log(JSON.stringify({ event: "run-start", ...planned }));
    const userDataDir = await mkdtemp(path.join(tmpdir(), "pdf-reader-dictionary-profile-"));
    run.userDataDir = userDataDir;
    await withDictionaryBenchmarkBrowser(() => launchTestBrowser(puppeteer, {
      executablePath: resolveBrowserPath(), headless: true, userDataDir,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: `dictionary-resource-benchmark-${planned.sequence}` }), async page => {
    const observations = [];
    let observing = false;
    const observe = async () => {
      if (observing) return;
      observing = true;
      try {
        const workers = [];
        for (const worker of page.workers()) {
          workers.push(await worker.evaluate(() => {
            const metrics = globalThis.__dictionaryBenchMetrics;
            if (!metrics) return null;
            const { membershipBucketUtf8Bytes, ...stages } = metrics;
            return stages;
          }));
        }
        const directory = path.join(userDataDir, "Default", "IndexedDB");
        const diskFiles = [];
        try {
          for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const filename = path.join(entry.parentPath, entry.name);
            diskFiles.push({ path: path.relative(userDataDir, filename), bytes: (await stat(filename)).size });
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        observations.push({ at: new Date().toISOString(), workerCount: page.workers().length, workers,
          storageBacking: "ordinary-profile-on-disk", indexedDbDirectory: directory, diskFiles });
      } catch (error) {
        observations.push({ at: new Date().toISOString(), error: String(error) });
      } finally { observing = false; }
    };
    const observationTimer = setInterval(() => { void observe(); }, 30000);
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/?variant=${encodeURIComponent(variant.id)}`);
      const result = await page.evaluate((args) => window.runDictionaryBenchmark(args), { cacheName });
      const completed = { ...run, status: "passed", completedAt: new Date().toISOString(), observations, result };
      finishedRuns.push(completed);
      await appendFile(resultsPath, `${JSON.stringify(completed)}\n`);
      console.log(JSON.stringify({ event: "run-result", sequence: planned.sequence,
        variant: planned.variant, status: completed.status, firstQueryMs: result.firstQueryMs,
        fullReadyMs: result.fullReadyMs, warmLookupP95Ms: result.reopenedWarm.lookupP95Ms,
        elapsedMs: result.elapsedMs }));
    } catch (error) {
      await observe();
      failedRuns += 1;
      const failed = { ...run, status: "failed", completedAt: new Date().toISOString(),
        observations,
        error: { name: error?.name || "Error", message: String(error?.message || error), stack: error?.stack || null } };
      finishedRuns.push(failed);
      await appendFile(resultsPath, `${JSON.stringify(failed)}\n`);
      console.error(JSON.stringify({ event: "run-result", sequence: planned.sequence,
        variant: planned.variant, status: failed.status, error: failed.error }));
    } finally {
      clearInterval(observationTimer);
    }
    });
  }
} catch (error) {
  const record = { event: "harness-failed", at: new Date().toISOString(),
    error: { name: error?.name || "Error", message: String(error?.message || error), stack: error?.stack || null } };
  await appendFile(resultsPath, `${JSON.stringify(record)}\n`);
  failedRuns += 1;
  for (const planned of plan.filter(row => !finishedRuns.some(done => done.sequence === row.sequence))) {
    const unrun = { ...planned, runSetId, status: "NOT_RUN", reason: "Harness infrastructure aborted the declared plan",
      error: record.error };
    finishedRuns.push(unrun);
    await appendFile(resultsPath, `${JSON.stringify(unrun)}\n`);
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}

const summary = { runSetId, plannedRuns: plan.length,
  completedRuns: finishedRuns.filter(run => run.status !== "NOT_RUN").length,
  notRun: finishedRuns.filter(run => run.status === "NOT_RUN").length,
  passedRuns: finishedRuns.filter(run => run.status === "passed").length,
  failedRuns, status: failedRuns ? "FAILED" : "COMPLETE",
  runPlan: planPath, runResults: resultsPath, variantOrder: predeclaredPlan.variantOrder };
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(summary));
if (failedRuns) process.exitCode = 1;
