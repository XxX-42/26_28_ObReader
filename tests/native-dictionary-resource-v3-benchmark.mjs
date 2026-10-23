// Opt-in, attach-only Native harness. Never deploys resources or enables plugins.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import { createECDICTComparisonInstrumentationPlugin, summarizeCachedRepeat } from './dictionary-v3-comparison-benchmark-support.mjs';

assert.equal(process.argv[2], '--run', 'Explicit --run required; no automatic Native launch');
const [cdpUrl, exactVault, output] = process.argv.slice(3);
assert.ok(cdpUrl && exactVault && output, 'Usage: --run <CDP URL> <exact Vault basePath> <outside-Vault report.json>');
assert.equal(process.env.OBREADER_NATIVE_DICTIONARY_LEASE, 'exclusive-after-native-gates', 'Coordinator must grant exclusive benchmark lease');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outside = root => { const relative = path.relative(path.resolve(root), path.resolve(output)); return relative === '..' || relative.startsWith(`..${path.sep}`); };
assert.ok(outside(exactVault) && outside(repo), 'Evidence must be outside Vault and worktree');
await writeFile(output, '', { flag: 'wx' }); // Reserve evidence path before touching Native.
const plugin = createECDICTComparisonInstrumentationPlugin();
const worker = await build({ entryPoints: [path.join(repo, 'plugin/vocabulary/dictionary-worker.cjs')], bundle: true, write: false, platform: 'browser', format: 'iife', plugins: [plugin] });
const runtime = await build({ entryPoints: [path.join(repo, 'plugin/vocabulary/dictionary.cjs')], bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'NativeDictionaryBenchmarkRuntime', plugins: [plugin], define: { __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) } });
const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
const report = { status: 'NOT_RUN', runId: randomUUID(), startupAddedBlocking: { status: 'NOT_MEASURED', reason: 'Attaching after startup cannot attribute startup CPU or blocking; manifest elapsed I/O is not blocking.' }, trials: [] };
let runtimeHandle;
try {
  const matches = [];
  for (const page of await browser.pages()) if (page.url() === 'app://obsidian.md/index.html' && await page.evaluate(vault => globalThis.app?.vault?.adapter?.basePath === vault, exactVault)) matches.push(page);
  assert.equal(matches.length, 1, 'Exactly one app-origin exact-Vault target required');
  const page = matches[0];
  await page.evaluate(() => {
    if (app.plugins.plugins['pdf-web-reader'] || app.plugins.enabledPlugins?.has('pdf-web-reader')) throw Error('pdf-web-reader must already be disabled');
    if (app.workspace.getLeavesOfType('pdf-web-reader-view').length !== 0) throw Error('Reader leaves must be closed');
  });
  // Lexical IIFE scope avoids overwriting or leaving any renderer global.
  runtimeHandle = await page.evaluateHandle(`(() => { ${runtime.outputFiles[0].text}\n return NativeDictionaryBenchmarkRuntime; })()`);
  for (let trial = 1; trial <= 5; trial++) {
    const result = await page.evaluate(async ({ exactVault, trial, runId }, dictionaryRuntime) => {
      const app = globalThis.app;
      if (location.href !== 'app://obsidian.md/index.html' || app.vault.adapter.basePath !== exactVault) throw Error('Native identity changed');
      const active = app.plugins.plugins['pdf-web-reader'];
      if ((active?.views?.size || 0) !== 0 || app.workspace.getLeavesOfType('pdf-web-reader-view').length !== 0) throw Error('Readers must be closed');
      if (active || app.plugins.enabledPlugins?.has('pdf-web-reader')) throw Error('pdf-web-reader must already be disabled');
      const actual = app.vault.adapter;
      const operations = [], decodeWall = [], manifestCalls = [];
      // Only these real DataAdapter operations are exposed: writes are impossible.
      const adapter = Object.fromEntries(['read', 'readBinary'].map(method => [method, async resourcePath => {
        const start = performance.now();
        const value = await actual[method](resourcePath);
        operations.push({ method, path: resourcePath, elapsedMs: performance.now() - start,
          bytes: method === 'readBinary' ? value.byteLength : new TextEncoder().encode(value).byteLength });
        return value;
      }]));
      const cacheName = `obreader-native-dictionary-benchmark-${runId}-${trial}`;
      const dictionary = new dictionaryRuntime.VocabularyDictionary({ adapter, cacheName });
      const originalDecode = dictionary.decodeBlock.bind(dictionary);
      dictionary.decodeBlock = async (...args) => { const start = performance.now(); try { return await originalDecode(...args); } finally { decodeWall.push({ elapsedMs: performance.now() - start, workerPresent: !!dictionary.blockWorker }); } };
      const originalManifest = dictionary.readManifestAt.bind(dictionary);
      dictionary.readManifestAt = (...args) => { const start = performance.now(); const promise = originalManifest(...args); const synchronousCallMs = performance.now() - start;
        return promise.finally(() => manifestCalls.push({ synchronousCallMs, totalAsyncElapsedMs: performance.now() - start, cpuBlockingMs: 'NOT_MEASURED' })); };
      const samples = [];
      try {
        for (let index = 0; index < 21; index++) {
          const readsBefore = operations.length;
          const before = { hits: 0, misses: 0, ...dictionary.benchmarkBlockCacheProbes };
          const start = performance.now();
          const entry = await dictionary.lookup('zyzzyva');
          const durationMs = performance.now() - start;
          if (entry?.key !== 'zyzzyva' || dictionary.getStatus().code !== 'DICTIONARY_RESOURCE_V3_READY') throw Error('Real v3 lookup failed or fell back');
          const after = dictionary.benchmarkBlockCacheProbes;
          const reads = operations.slice(readsBefore).filter(row => row.method === 'readBinary');
          const cacheHits = after.hits - before.hits, cacheMisses = after.misses - before.misses;
          samples.push({ ordinal: index, durationMs, cacheHits, cacheMisses,
            cacheHit: cacheHits === 1 && cacheMisses === 0 && reads.length === 0, cacheMiss: cacheMisses > 0,
            binaryReads: reads.length, bytesReadBinary: reads.reduce((sum, row) => sum + row.bytes, 0) });
        }
        return { trial, origin: location.origin, href: location.href, vault: actual.basePath,
          adapterClass: actual.constructor.name, coldScope: 'new dictionary instance/Worker; existing Native process/origin and OS cache retained',
          cold: samples[0], warm: samples.slice(1), operations, binaryWrites: 0, decodeWall,
          workerMetrics: dictionary.benchmarkBlockWorkerMetrics || null, manifestCalls,
          oldGenerationIsolation: 'unique disposable IndexedDB namespace; existing generation untouched; not a stale-generation migration test' };
      } finally {
        dictionary.dispose();
        await new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(cacheName); request.onsuccess = resolve; request.onerror = () => reject(request.error); request.onblocked = () => reject(Error('Benchmark cache cleanup blocked')); });
      }
    }, { exactVault, trial, runId: report.runId }, runtimeHandle);
    result.warmSummary = summarizeCachedRepeat(result.warm);
    report.trials.push(result);
  }
  report.status = 'COMPLETE_INSTANCE_COLD_NATIVE_LOOKUP_ONLY';
} catch (error) { report.status = 'FAILED'; report.error = String(error.stack || error); process.exitCode = 1; }
finally {
  try { await runtimeHandle?.dispose(); } catch (error) { report.runtimeHandleCleanupError = String(error); report.status = 'FAILED'; process.exitCode = 1; }
  await browser.disconnect();
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
}
