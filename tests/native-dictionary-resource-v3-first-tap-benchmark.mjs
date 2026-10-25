// Opt-in, read-only Native Obsidian benchmark for a tap immediately after the
// Resource-v3 availability check has started asynchronous Worker prewarm.
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { createECDICTComparisonInstrumentationPlugin, summarizeCachedRepeat } from './dictionary-v3-comparison-benchmark-support.mjs';

assert.equal(process.argv[2], '--run', 'Explicit --run required; no automatic Native launch');
const [cdpUrl, exactVault, output] = process.argv.slice(3);
assert.ok(cdpUrl && exactVault && output,
  'Usage: --run <CDP URL> <exact Vault basePath> <outside-Vault report.json>');
assert.equal(process.env.OBREADER_NATIVE_DICTIONARY_LEASE, 'exclusive-after-native-gates',
  'Coordinator must grant the exclusive Native benchmark lease');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outside = root => {
  const relative = path.relative(path.resolve(root), path.resolve(output));
  return relative === '..' || relative.startsWith(`..${path.sep}`);
};
assert.ok(outside(exactVault) && outside(repo), 'Evidence must be outside the Vault and worktree');
await writeFile(output, '', { flag: 'wx' });

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const instrumentation = createECDICTComparisonInstrumentationPlugin();
const worker = await build({
  entryPoints: [path.join(repo, 'plugin/vocabulary/dictionary-worker.cjs')],
  bundle: true, write: false, platform: 'browser', format: 'iife', plugins: [instrumentation],
});
const runtime = await build({
  entryPoints: [path.join(repo, 'plugin/vocabulary/dictionary.cjs')],
  bundle: true, write: false, platform: 'browser', format: 'iife',
  globalName: 'NativeFirstTapDictionaryRuntime', plugins: [instrumentation],
  define: { __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
});
const report = {
  schemaVersion: 1,
  kind: 'obsidian-native-resource-v3-first-tap-benchmark',
  status: 'NOT_RUN',
  runId: randomUUID(),
  runtimeUnderTest: 'current VocabularyDictionary injected into exact Obsidian renderer; real Vault DataAdapter read/readBinary only; excludes plugin Host/Reader UI wiring',
  candidate: {
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: repo, encoding: 'utf8' }).trim(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    mainBundleSha256: hash(await readFile(path.join(repo, 'dist/pdf-web-reader/main.js'))),
    dictionarySourceSha256: hash(await readFile(path.join(repo, 'plugin/vocabulary/dictionary.cjs'))),
    workerSourceSha256: hash(await readFile(path.join(repo, 'plugin/vocabulary/dictionary-worker.cjs'))),
  },
  startupAddedBlocking: {
    status: 'NOT_MEASURED',
    reason: 'Attach-after-startup cannot attribute cold process startup blocking or the incremental startup cost of enabling this plugin.',
  },
  tapTiming: 'For each fresh Dictionary/Worker, await checkAvailability() (which starts prewarm without awaiting it), then immediately invoke lookup() without waiting for Worker readiness.',
  matrix: ['common-on', 'rare-zyzzyva', 'not-found'],
  trials: [],
};

const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
let runtimeHandle;
try {
  const matches = [];
  for (const page of await browser.pages()) {
    if (page.url() === 'app://obsidian.md/index.html' &&
        await page.evaluate(vault => globalThis.app?.vault?.adapter?.basePath === vault, exactVault)) matches.push(page);
  }
  assert.equal(matches.length, 1, 'Exactly one app-origin target for the exact Vault is required');
  const page = matches[0];
  await page.evaluate(() => {
    if (app.plugins.plugins['pdf-web-reader'] || app.plugins.enabledPlugins?.has('pdf-web-reader')) {
      throw Error('pdf-web-reader must already be disabled');
    }
    if (app.workspace.getLeavesOfType('pdf-web-reader-view').length !== 0) {
      throw Error('Reader leaves must be closed');
    }
  });
  runtimeHandle = await page.evaluateHandle(`(() => { ${runtime.outputFiles[0].text}\n return NativeFirstTapDictionaryRuntime; })()`);

  const cases = [
    { id: 'common-on', key: 'on', expected: 'found' },
    { id: 'rare-zyzzyva', key: 'zyzzyva', expected: 'found' },
    { id: 'not-found', key: `codex-first-tap-not-found-${report.runId}`, expected: 'missing' },
  ];
  const order = [
    [cases[0], cases[1], cases[2]],
    [cases[1], cases[2], cases[0]],
    [cases[2], cases[0], cases[1]],
    [cases[0], cases[2], cases[1]],
    [cases[1], cases[0], cases[2]],
  ];
  for (let trial = 1; trial <= 5; trial++) {
    for (const testCase of order[trial - 1]) {
      const outcome = await page.evaluate(async ({ exactVault, trial, runId, testCase }, dictionaryRuntime) => {
        const app = globalThis.app;
        if (location.href !== 'app://obsidian.md/index.html' || app.vault.adapter.basePath !== exactVault) {
          throw Error('Native app/Vault identity changed');
        }
        if (app.plugins.plugins['pdf-web-reader'] || app.plugins.enabledPlugins?.has('pdf-web-reader') ||
            app.workspace.getLeavesOfType('pdf-web-reader-view').length !== 0) {
          throw Error('Plugin must remain disabled and Reader leaves closed');
        }
        const actual = app.vault.adapter;
        const operations = [];
        const adapter = Object.fromEntries(['read', 'readBinary'].map(method => [method, async resourcePath => {
          const start = performance.now();
          const value = await actual[method](resourcePath);
          operations.push({ method, path: resourcePath, elapsedMs: performance.now() - start,
            bytes: method === 'readBinary' ? value.byteLength : new TextEncoder().encode(value).byteLength });
          return value;
        }]));
        const cacheName = `obreader-native-first-tap-${runId}-${trial}-${testCase.id}`;
        const dictionary = new dictionaryRuntime.VocabularyDictionary({ adapter, cacheName });
        const availabilityStart = performance.now();
        const availability = await dictionary.checkAvailability();
        const availabilityMs = performance.now() - availabilityStart;
        const workerStartedAt = performance.now();
        const ready = dictionary.blockWorkerReady;
        const workerReadyPromise = ready
          ? ready.then(worker => ({ ready: Boolean(worker), elapsedMs: performance.now() - workerStartedAt }))
          : Promise.resolve({ ready: false, elapsedMs: null });
        const queryStart = performance.now();
        const queryPromise = dictionary.lookup(testCase.key).then(entry => ({ entry, elapsedMs: performance.now() - queryStart }));
        const [query, workerReady] = await Promise.all([queryPromise, workerReadyPromise]);
        const { entry, elapsedMs: firstTapMs } = query;
        const warm = [];
        for (let index = 0; index < 20; index++) {
          const readsBefore = operations.length;
          const probesBefore = { hits: 0, misses: 0, ...dictionary.benchmarkBlockCacheProbes };
          const start = performance.now();
          const repeated = await dictionary.lookup(testCase.key);
          const durationMs = performance.now() - start;
          const reads = operations.slice(readsBefore).filter(operation => operation.method === 'readBinary');
          const probesAfter = dictionary.benchmarkBlockCacheProbes;
          const cacheHits = probesAfter.hits - probesBefore.hits;
          const cacheMisses = probesAfter.misses - probesBefore.misses;
          warm.push({ durationMs, sameResult: repeated?.key === entry?.key,
            cacheHits, cacheMisses, binaryReads: reads.length,
            bytesReadBinary: reads.reduce((sum, operation) => sum + operation.bytes, 0),
            cacheHit: cacheHits === 1 && cacheMisses === 0 && reads.length === 0 });
        }
        const status = dictionary.getStatus();
        const expected = testCase.expected === 'found' ? entry?.key === testCase.key : entry === null;
        const binaryReads = operations.filter(operation => operation.method === 'readBinary');
        const metrics = dictionary.benchmarkBlockWorkerMetrics || null;
        const probes = dictionary.benchmarkBlockCacheProbes;
        const result = {
          trial, id: testCase.id, key: testCase.key, expected: testCase.expected,
          correctness: expected && status.code === 'DICTIONARY_RESOURCE_V3_READY',
          availability: { elapsedMs: availabilityMs, status: availability.status },
          firstTapMs,
          workerReadyMsAfterAvailability: workerReady.elapsedMs,
          workerReadyBeforeTapCompletion: workerReady.ready === true && workerReady.elapsedMs <= firstTapMs,
          coldRead: { binaryReads: binaryReads.length, bytes: binaryReads.reduce((sum, operation) => sum + operation.bytes, 0) },
          warm,
          workerMetrics: metrics,
          cacheProbes: probes,
          operations,
          binaryWrites: 0,
          adapterClass: actual.constructor.name,
          vault: actual.basePath,
          userAgent: navigator.userAgent,
        };
        dictionary.dispose();
        await new Promise((resolve, reject) => {
          const request = indexedDB.deleteDatabase(cacheName);
          request.onsuccess = resolve;
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(Error('Disposable benchmark IndexedDB cleanup was blocked'));
        });
        if (!result.correctness || binaryReads.length !== 1 || result.coldRead.bytes <= 0 ||
            warm.some(sample => !sample.sameResult || !sample.cacheHit)) throw Error(`Native first-tap trial failed: ${JSON.stringify(result)}`);
        return result;
      }, { exactVault, trial, runId: report.runId, testCase }, runtimeHandle);
      outcome.warmSummary = summarizeCachedRepeat(outcome.warm.map(sample => ({
        durationMs: sample.durationMs, cacheHit: sample.cacheHit,
        cacheMiss: sample.cacheMisses > 0, binaryReads: sample.binaryReads,
        bytesReadBinary: sample.bytesReadBinary,
      })));
      report.trials.push(outcome);
    }
  }
  report.status = 'COMPLETE_NATIVE_FIRST_TAP_AFTER_ASYNC_PREWARM';
} catch (error) {
  report.status = 'FAILED';
  report.error = String(error.stack || error);
  process.exitCode = 1;
} finally {
  try { await runtimeHandle?.dispose(); } catch (error) {
    report.runtimeHandleCleanupError = String(error);
    report.status = 'FAILED';
    process.exitCode = 1;
  }
  await browser.disconnect();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
}
