// Cross-version cold/warm ECDICT comparison. This is deliberately opt-in:
// invoke with --run and explicit read-only resource roots after a benchmark lease.
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
import { withDictionaryBenchmarkBrowser } from "./dictionary-resource-benchmark-support.mjs";
import {
  createECDICTComparisonPlan, createECDICTComparisonQueries, ECDICT_COMPARISON_PROTOCOL_TIMEOUT_MS,
  ECDICT_COMPARISON_REPETITIONS, ECDICT_COMPARISON_VARIANTS, instrumentBlockWorker,
  instrumentDictionaryRuntime, selectPassingCacheLimit,
} from "./dictionary-v3-comparison-benchmark-support.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[2] !== "--run") {
  throw new Error("Refusing to launch Chromium without explicit `--run <resource-v2> <resource-v3> <output-dir>` arguments.");
}
const rawPaths = process.argv.slice(3, 6);
if (rawPaths.length !== 3 || rawPaths.some(value => !value)) throw new Error("Expected explicit resource-v2, resource-v3, and output paths.");
const [v2Root, v3Root, reportDirectory] = rawPaths.map(value => path.resolve(value));
const extraArgs = process.argv.slice(6);
let nativeStartupBlockingMs = null;
let nativeStartupEvidence = null;
for (let index = 0; index < extraArgs.length; index += 2) {
  const flag = extraArgs[index], value = extraArgs[index + 1];
  if (!value) throw new Error(`Missing value for ${flag}`);
  if (flag === "--native-startup-blocking-ms") {
    nativeStartupBlockingMs = Number(value);
    if (!Number.isFinite(nativeStartupBlockingMs) || nativeStartupBlockingMs < 0) throw new Error("Native startup-blocking measurement must be a finite non-negative number.");
  } else if (flag === "--native-startup-evidence") nativeStartupEvidence = value;
  else throw new Error(`Unsupported argument: ${flag}`);
}
if ((nativeStartupBlockingMs === null) !== (nativeStartupEvidence === null)) {
  throw new Error("Pass both --native-startup-blocking-ms and --native-startup-evidence, or pass neither.");
}
const outputRelative = path.relative(repositoryRoot, reportDirectory);
if (!outputRelative || (outputRelative !== ".." && !outputRelative.startsWith(`..${path.sep}`))) {
  throw new Error("Raw benchmark output must be outside the Git worktree.");
}

const frozenV2 = { entryCount: 770611, compressedBytes: 16734703, uncompressedBytes: 69667588,
  sha256: "b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126" };
const manifestV2 = JSON.parse(await readFile(path.join(v2Root, "manifest.json"), "utf8"));
const manifestV3 = JSON.parse(await readFile(path.join(v3Root, "manifest.json"), "utf8"));
for (const [key, value] of Object.entries(frozenV2)) assert.equal(manifestV2[key], value, `frozen v2 ${key} mismatch`);
assert.equal(manifestV3.schemaVersion, 3);
assert.equal(manifestV3.entryCount, frozenV2.entryCount);
assert.equal(manifestV3.source?.sha256, frozenV2.sha256);
assert.equal(manifestV3.source?.entryCount, frozenV2.entryCount);

const runSetId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
const queries = createECDICTComparisonQueries(manifestV3, runSetId);
const plan = createECDICTComparisonPlan(runSetId);
const variants = new Map(ECDICT_COMPARISON_VARIANTS.map(variant => [variant.id, variant]));
const resultsPath = path.join(reportDirectory, "run-results.jsonl");
const planPath = path.join(reportDirectory, "run-plan.json");
const summaryPath = path.join(reportDirectory, "summary.json");
const predeclaredPlan = {
  protocolVersion: 1,
  runSetId,
  declaredAt: new Date().toISOString(),
  status: "PREDECLARED; no trial has started",
  resources: { resourceV2: frozenV2, resourceV3: {
    schemaVersion: manifestV3.schemaVersion, entryCount: manifestV3.entryCount,
    compressedBytes: manifestV3.compressedBytes, uncompressedBytes: manifestV3.uncompressedBytes,
    blockCount: manifestV3.blockCount, sha256: manifestV3.sha256,
    source: manifestV3.source,
  } },
  repetitionsPerVariant: ECDICT_COMPARISON_REPETITIONS,
  variantOrder: ECDICT_COMPARISON_VARIANTS,
  firstRareQuery: queries.firstRareQuery,
  warmQueries: queries.warmQueries,
  protocolTimeoutMs: ECDICT_COMPARISON_PROTOCOL_TIMEOUT_MS,
  nativeStartupMeasurement: nativeStartupBlockingMs === null ? null : {
    applicationStartupBlockingMs: nativeStartupBlockingMs, evidence: nativeStartupEvidence,
    suppliedBy: "separately measured Native acceptance run; not derived from browser timings",
  },
  runs: plan,
  invariants: [
    "Each run launches a fresh ordinary persistent-profile Chrome process with a unique on-disk userDataDir and unique IndexedDB name; off-record contexts are prohibited.",
    "Chromium HTTP cache is disabled and every server response is Cache-Control: no-store. The OS filesystem cache is not flushed.",
    "resource-v2 explicitly awaits ensureReady() before its first rare lookup, reproducing the full-import wait from the legacy lookup path; this wait is reported separately and included in end-to-end first-query latency.",
    "resource-v3 performs the first rare lookup directly. It does not call ensureReady() or start a v2 cache build.",
    "Each run executes the same 20 predeclared warm samples. No retry, skip, timeout extension, or outcome-based selection is permitted; failures and NOT_RUN rows remain in the output.",
    "The local HTTP server only serves files from the two explicit resource roots. It never writes to a Vault. The output directory must be outside this Git worktree.",
    "The v3 LRU variants hold the byte cap fixed at 8 MiB and vary the decoded-block count cap at 8, 16, and 32; cache statistics report both actual limits and estimated bytes.",
    "Chromium automation does not measure Native Obsidian/WKWebView startup. The separately measured Native startup-blocking value and evidence reference must be supplied before selecting the smallest passing cache limit.",
  ],
  metricDefinitions: {
    firstQueryMs: "v2 full ensureReady() plus its first rare lookup; v3 direct first rare lookup.",
    legacyFullImportWaitMs: "v2 ensureReady() wall time before user-query work; null for v3.",
    warmLookupPercentiles: "Individual timings from the 20 fixed common, rare, missing, range-boundary, and Unicode queries.",
    readBinary: "Vault-like adapter readBinary wall time and returned compressed bytes, reported per file.",
    worker: "v2 worker full prepare wall time; v3 block worker decode wall time, compressed transfer bytes, and estimated decoded bytes where the browser Worker path is available.",
    lru: "Runtime block count and estimated decoded bytes after the warm sequence; not a browser heap measurement.",
    mainThreadHeap: "Chromium performance.memory samples where exposed; worker heap is unavailable.",
    mainThreadLongTask: "PerformanceObserver longtask entries during the run where Chromium exposes the entry type.",
    persistentProfile: "Filesystem byte totals before/after the run and IndexedDB file inventory; IndexedDB API does not expose physical read/write bytes.",
  },
};
await mkdir(reportDirectory, { recursive: true });
await writeFile(planPath, `${JSON.stringify(predeclaredPlan, null, 2)}\n`, { flag: "wx" });
await writeFile(resultsPath, "", { flag: "wx" });

const worker = await build({
  entryPoints: [path.join(repositoryRoot, "plugin/vocabulary/dictionary-worker.cjs")],
  bundle: true, write: false, platform: "browser", format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "ecdict-v3-comparison-worker-metrics", setup(buildApi) {
    buildApi.onLoad({ filter: /dictionary-worker\.cjs$/ }, async ({ path: filename }) => ({
      contents: instrumentBlockWorker(await readFile(filename, "utf8")), loader: "js",
    }));
  } }],
});
const runtime = await build({
  entryPoints: [path.join(repositoryRoot, "plugin/vocabulary/dictionary.cjs")],
  bundle: true, write: false, platform: "browser", format: "iife", globalName: "DictionaryRuntime",
  define: { "process.env.NODE_ENV": '"production"', __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
  plugins: [{ name: "ecdict-v3-comparison-runtime-metrics", setup(buildApi) {
    buildApi.onLoad({ filter: /dictionary\.cjs$/ }, async ({ path: filename }) => ({
      contents: instrumentDictionaryRuntime(await readFile(filename, "utf8")), loader: "js",
    }));
  } }],
});
const runtimeSource = runtime.outputFiles[0].text;

const variantsRoots = new Map([
  ["v2-explicit-full-import", { root: v2Root, manifest: manifestV2 }],
  ["v3-lru-8", { root: v3Root, manifest: manifestV3 }],
  ["v3-lru-16", { root: v3Root, manifest: manifestV3 }],
  ["v3-lru-32", { root: v3Root, manifest: manifestV3 }],
]);
const allowedFiles = new Map([...variantsRoots].map(([id, value]) => [id,
  new Set(["manifest.json", value.manifest.resourceFile, ...(value.manifest.blocks || []).map(block => block.resourceFile)])]));
const html = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ECDICT v2/v3 first-query and warm lookup comparison</title>
<script src="/runtime.js"></script><script>
  const longTaskEntries = [];
  window.__ecdictLongTaskEntries = longTaskEntries;
  const longTaskAvailable = typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("longtask");
  if (longTaskAvailable) new PerformanceObserver(list => longTaskEntries.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, durationMs: entry.duration }))))
    .observe({ type: "longtask", buffered: true });
  const heapUsed = () => performance.memory?.usedJSHeapSize ?? null;
  const deleteCache = name => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error || new Error("IndexedDB cleanup failed"));
    request.onblocked = () => reject(new Error("Cache deletion blocked"));
  });
  const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] || 0;
  function createDictionary({ cacheName, variant, reads, statusEvents }) {
    const root = "fixture/dictionaries/ECDICT/resource-" + variant.resource;
    const adapter = {
      async read(resourcePath) {
        const started = performance.now();
        const relative = resourcePath.slice(root.length + 1);
        const response = await fetch("/data?variant=" + encodeURIComponent(variant.id) + "&file=" + encodeURIComponent(relative));
        if (!response.ok) throw new Error("resource read failed: " + response.status + " " + relative);
        const text = await response.text();
        reads.push({ kind: "manifest", file: relative, durationMs: performance.now() - started, bytes: new TextEncoder().encode(text).byteLength });
        return text;
      },
      async readBinary(resourcePath) {
        const started = performance.now();
        const relative = resourcePath.slice(root.length + 1);
        const response = await fetch("/data?variant=" + encodeURIComponent(variant.id) + "&file=" + encodeURIComponent(relative));
        if (!response.ok) throw new Error("resource read failed: " + response.status + " " + relative);
        const bytes = await response.arrayBuffer();
        reads.push({ kind: "binary", file: relative, durationMs: performance.now() - started, bytes: bytes.byteLength });
        return bytes;
      },
    };
    const dictionary = new DictionaryRuntime.VocabularyDictionary({
      adapter, root, legacyRoot: "fixture/dictionaries/ECDICT/resource-v2", cacheName,
      blockCacheMaxBlocks: variant.blockCacheMaxBlocks,
      blockCacheMaxBytes: variant.blockCacheMaxBytes,
      onStatus: status => statusEvents.push({ ...status, at: performance.now() }),
    });
    return dictionary;
  }
  window.runECDICTTrial = async ({ cacheName, variant, firstRareQuery, warmQueries }) => {
    const runStarted = performance.now();
    const longTaskStart = longTaskEntries.length;
    const heapBefore = heapUsed();
    const statusEvents = [];
    const reads = [];
    window.__ecdictStatusEvents = statusEvents;
    const constructorStarted = performance.now();
    const dictionary = createDictionary({ cacheName, variant, reads, statusEvents });
    window.__ecdictOpenTrial = { dictionary, reopenedDictionary: null, cacheName };
    const constructorMs = performance.now() - constructorStarted;
    let legacyFullImportWaitMs = null;
    const firstStarted = performance.now();
    if (variant.resource === "v2") {
      const readyStarted = performance.now();
      await dictionary.ensureReady();
      legacyFullImportWaitMs = performance.now() - readyStarted;
    }
    const firstLookupStarted = performance.now();
    const firstRare = await dictionary.lookup(firstRareQuery.key);
    const firstLookupMs = performance.now() - firstLookupStarted;
    const firstQueryMs = performance.now() - firstStarted;
    if (!firstRare?.translation || firstRare.key !== firstRareQuery.key) throw new Error("first rare correctness sample was missing");
    const heapAfterFirst = heapUsed();
    const warmLatencies = [];
    const warmResults = [];
    for (const query of warmQueries) {
      const started = performance.now();
      const entry = await dictionary.lookup(query.key);
      const durationMs = performance.now() - started;
      const found = entry !== null;
      if (query.expected === "found" && (!found || entry.key !== query.key)) throw new Error("expected dictionary key missing: " + query.category + " " + query.key);
      if (query.expected === "missing" && found) throw new Error("not-found sample unexpectedly exists: " + query.key);
      warmLatencies.push(durationMs);
      warmResults.push({ ordinal: query.ordinal, category: query.category, key: query.key, found, durationMs });
    }
    const sortedWarm = [...warmLatencies].sort((left, right) => left - right);
    const reopenedReadsStart = reads.length;
    const reopenedStarted = performance.now();
    const warmReopenFirst = await dictionary.lookup(firstRareQuery.key);
    const reopenedFirstLookupMs = performance.now() - reopenedStarted;
    if (warmReopenFirst?.key !== firstRareQuery.key) throw new Error("same-instance reopen lookup failed");
    const reopenedDictionary = createDictionary({ cacheName, variant, reads, statusEvents });
    const readerReopenStarted = performance.now();
    const readerReopen = await reopenedDictionary.lookup(firstRareQuery.key);
    const readerReopenMs = performance.now() - readerReopenStarted;
    if (readerReopen?.key !== firstRareQuery.key) throw new Error("new Reader instance lookup failed");
    const ended = performance.now();
    const longTasks = longTaskEntries.slice(longTaskStart).filter(entry => entry.startTime >= runStarted && entry.startTime <= ended);
    const binaryReads = reads.filter(item => item.kind === "binary");
    const runResult = {
      constructorMs, legacyFullImportWaitMs, firstLookupMs, firstQueryMs,
      firstRareQuery, firstRare: { key: firstRare.key, translation: firstRare.translation, phonetic: firstRare.phonetic },
      warm: { count: warmResults.length, p50Ms: percentile(sortedWarm, 0.5), p95Ms: percentile(sortedWarm, 0.95), maxMs: sortedWarm.at(-1), queries: warmResults },
      sameInstanceWarmReopenMs: reopenedFirstLookupMs,
      newReaderInstanceReopen: { lookupMs: readerReopenMs, reads: reads.slice(reopenedReadsStart) },
      readBinary: binaryReads,
      bytesReadBinary: binaryReads.reduce((sum, item) => sum + item.bytes, 0),
      blockCache: dictionary.getBlockCacheStats(),
      worker: { v2Prepare: dictionary.benchmarkPrepareMetrics || null, v3BlockDecode: dictionary.benchmarkBlockWorkerMetrics || null },
      mainThreadHeapBytes: { before: heapBefore, afterFirst: heapAfterFirst, afterWarm: heapUsed() },
      mainThreadLongTask: { available: longTaskAvailable, count: longTasks.length, totalMs: longTasks.reduce((sum, item) => sum + item.durationMs, 0),
        maxMs: Math.max(0, ...longTasks.map(item => item.durationMs)), entries: longTasks },
      statusEvents, reads, elapsedMs: ended - runStarted,
    };
    window.__ecdictOpenTrial = { dictionary, reopenedDictionary, cacheName };
    return runResult;
  };
  window.finishECDICTTrial = async () => {
    const open = window.__ecdictOpenTrial;
    if (!open) return false;
    open.dictionary.dispose();
    open.reopenedDictionary?.dispose();
    const deleted = await deleteCache(open.cacheName);
    window.__ecdictOpenTrial = null;
    return deleted;
  };
</script>`;

const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/runtime.js") {
    response.setHeader("Content-Type", "text/javascript");
    return response.end(runtimeSource);
  }
  if (url.pathname === "/data") {
    const variant = variantsRoots.get(url.searchParams.get("variant"));
    const relative = url.searchParams.get("file");
    if (!variant || !allowedFiles.get(url.searchParams.get("variant"))?.has(relative)) {
      response.statusCode = 404;
      return response.end("resource not in prevalidated manifest");
    }
    const filename = path.resolve(variant.root, relative);
    const rootPrefix = `${path.resolve(variant.root)}${path.sep}`;
    if (filename !== path.resolve(variant.root, "manifest.json") && !filename.startsWith(rootPrefix)) {
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
  let total = 0, files = [];
  async function visit(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        const bytes = (await stat(filename)).size;
        total += bytes;
        files.push({ path: path.relative(directory, filename), bytes });
      }
    }
  }
  await visit(directory);
  return { totalBytes: total, files };
}

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const outcomes = [];
let failures = 0;
try {
  for (const planned of plan) {
    const variant = variants.get(planned.variant);
    const cacheName = `obreader-ecdict-${runSetId}-${String(planned.sequence).padStart(2, "0")}`;
    const run = { ...planned, cacheName, status: "started", startedAt: new Date().toISOString() };
    await appendFile(resultsPath, `${JSON.stringify(run)}\n`);
    console.log(JSON.stringify({ event: "run-start", ...planned }));
    const userDataDir = await mkdtemp(path.join(tmpdir(), "pdf-reader-ecdict-comparison-"));
    const observations = [];
    let browserPage;
    let timer;
    try {
      await withDictionaryBenchmarkBrowser(() => launchTestBrowser(puppeteer, {
        executablePath: resolveBrowserPath(), headless: true, userDataDir,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        protocolTimeout: ECDICT_COMPARISON_PROTOCOL_TIMEOUT_MS,
      }, { testName: `ecdict-v3-comparison-${planned.sequence}` }), async page => {
        browserPage = page;
        const profileBefore = await directoryBytes(userDataDir);
        const indexedDbDirectory = path.join(userDataDir, "Default", "IndexedDB");
        const indexedDbBefore = await directoryBytes(indexedDbDirectory);
        const observe = async () => {
          const observation = { at: new Date().toISOString() };
          try { observation.page = await page.evaluate(() => ({
            latestStatus: window.__ecdictStatusEvents?.at(-1) || window.__ecdictOpenTrial?.dictionary.getStatus?.() || null,
            longTaskCount: window.__ecdictLongTaskEntries?.length ?? null,
          })); }
          catch (error) { observation.pageError = String(error); }
          try { observation.indexedDbFiles = await directoryBytes(path.join(userDataDir, "Default", "IndexedDB")); }
          catch (error) { observation.profileError = String(error); }
          observations.push(observation);
        };
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
        timer = setInterval(() => { void observe(); }, 30_000);
        const result = await page.evaluate(args => window.runECDICTTrial(args), {
          cacheName, variant, ...queries,
        });
        await observe();
        const profileAfter = await directoryBytes(userDataDir);
        const indexedDbAfter = await directoryBytes(indexedDbDirectory);
        const completed = { ...run, status: "passed", completedAt: new Date().toISOString(), observations,
          profile: { beforeBytes: profileBefore.totalBytes, afterBytes: profileAfter.totalBytes,
            growthBytes: profileAfter.totalBytes - profileBefore.totalBytes,
            indexedDbBeforeBytes: indexedDbBefore.totalBytes, indexedDbAfterBytes: indexedDbAfter.totalBytes,
            indexedDbGrowthBytes: indexedDbAfter.totalBytes - indexedDbBefore.totalBytes,
            indexedDbFiles: indexedDbAfter.files }, result };
        outcomes.push(completed);
        await appendFile(resultsPath, `${JSON.stringify(completed)}\n`);
        console.log(JSON.stringify({ event: "run-result", sequence: planned.sequence, variant: planned.variant,
          status: "passed", firstQueryMs: result.firstQueryMs, legacyFullImportWaitMs: result.legacyFullImportWaitMs,
          warmP95Ms: result.warm.p95Ms, bytesReadBinary: result.bytesReadBinary }));
      });
    } catch (error) {
      failures += 1;
      let partial = null;
      if (browserPage) {
        try { partial = await browserPage.evaluate(() => ({ statuses: window.__ecdictStatusEvents || [],
          latestStatus: window.__ecdictOpenTrial?.dictionary.getStatus?.() || null })); } catch {}
      }
      const failed = { ...run, status: "failed", completedAt: new Date().toISOString(), observations, partial,
        error: { name: error?.name || "Error", message: String(error?.message || error), stack: error?.stack || null } };
      outcomes.push(failed);
      await appendFile(resultsPath, `${JSON.stringify(failed)}\n`);
      console.error(JSON.stringify({ event: "run-result", sequence: planned.sequence, variant: planned.variant,
        status: "failed", error: failed.error }));
    } finally {
      if (timer) clearInterval(timer);
      if (browserPage) {
        try { await browserPage.evaluate(() => window.finishECDICTTrial?.()); } catch {}
      }
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
const perVariant = ECDICT_COMPARISON_VARIANTS.map(variant => {
  const runs = outcomes.filter(outcome => outcome.variant === variant.id);
  const passed = runs.filter(outcome => outcome.status === "passed");
  const sorted = values => values.sort((left, right) => left - right);
  const first = sorted(passed.filter(run => variant.resource === "v3").map(run => run.result.firstQueryMs));
  const warm = sorted(passed.flatMap(run => run.result.warm.queries.map(query => query.durationMs)));
  const startupWaits = passed.filter(run => variant.resource === "v2").map(run => run.result.legacyFullImportWaitMs);
  const longestTask = Math.max(0, ...passed.map(run => run.result.mainThreadLongTask.maxMs));
  return { variant, planned: runs.length, passed: passed.length,
  firstRareP50Ms: first.length ? first[Math.ceil(first.length * 0.5) - 1] : null,
    firstRareP95Ms: first.length ? first[Math.ceil(first.length * 0.95) - 1] : null,
    warmP95Ms: warm.length ? warm[Math.ceil(warm.length * 0.95) - 1] : null,
    dictionaryReadyWaitP50Ms: startupWaits.length ? sorted(startupWaits)[Math.ceil(startupWaits.length * 0.5) - 1] : null,
    maxMainThreadLongTaskMs: longestTask,
    applicationStartupBlockingMs: nativeStartupBlockingMs,
    note: runs.length !== ECDICT_COMPARISON_REPETITIONS || passed.length !== ECDICT_COMPARISON_REPETITIONS
      ? "Incomplete five-run evidence; no variant-selection claim."
      : nativeStartupBlockingMs === null
        ? "Application startup is outside this browser harness; supply the separate Native measurement before selecting a variant."
        : `Native startup-blocking measurement supplied from ${nativeStartupEvidence}.` };
});
const chosen = selectPassingCacheLimit(perVariant.map(item => ({ ...item,
  startupBlockingMs: item.applicationStartupBlockingMs,
})))?.variant?.id || null;
const summary = { runSetId, plannedRuns: plan.length, passedRuns: outcomes.filter(run => run.status === "passed").length,
  failedRuns: failures, notRun: outcomes.filter(run => run.status === "NOT_RUN").length,
  status: failures || outcomes.some(run => run.status === "NOT_RUN") ? "INCOMPLETE_OR_FAILED" : "COMPLETE_TRIALS_NATIVE_STARTUP_UNMEASURED",
  chosenSmallestPassingV3Limit: chosen,
  thresholds: { firstRareP50Ms: 300, firstRareP95Ms: 1000, warmP95Ms: 10, applicationStartupBlockingMs: 50 },
  applicationStartupBlockingMeasured: nativeStartupBlockingMs !== null,
  nativeStartupEvidence, perVariant, plan: planPath, results: resultsPath };
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify(summary));
if (failures) process.exitCode = 1;
