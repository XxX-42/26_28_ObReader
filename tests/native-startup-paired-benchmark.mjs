// Phase collector: never deploys, enables, disables or reloads a plugin.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentStartupOnload, STARTUP_PROBE_KEY, summarizeStartupPairs } from './native-startup-paired-support.mjs';
import { startStartupDiagnostics, stopStartupDiagnostics, summarizeRendererTrace } from './native-startup-trace-support.mjs';
const [mode, ...args] = process.argv.slice(2);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outside = (target, root) => { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === '..' || relative.startsWith(`..${path.sep}`); };
const hash = text => createHash('sha256').update(text).digest('hex');
if (mode === '--prepare') {
  const [input, output] = args;
  assert.ok(input && output && outside(output, repo) && outside(output, '/Users/jiajia/Documents/ObReader-Apple-Test') && (!process.env.OBSIDIAN_VAULT_PATH || outside(output, process.env.OBSIDIAN_VAULT_PATH)), 'Use an explicit own built main.js and outside-worktree output');
  // Caller supplies an outside-Vault staging directory, never a live plugin path.
  assert.ok(!path.resolve(output).split(path.sep).some(part => /^\.obsidian/u.test(part)), 'Refuse Obsidian configuration paths');
  const source = await readFile(input, 'utf8');
  const instrumented = instrumentStartupOnload(source);
  await writeFile(output, instrumented, { flag: 'wx' });
  await writeFile(`${output}.provenance.json`, JSON.stringify({ originalSha256: hash(source), instrumentedSha256: hash(instrumented), input: path.resolve(input), status: 'PREPARED_NOT_DEPLOYED' }, null, 2), { flag: 'wx' });
} else if (mode === '--summarize') {
  const [output, ...inputs] = args;
  assert.ok(output && inputs.length, 'Provide output and phase JSON files, including failures');
  const rows = await Promise.all(inputs.map(async input => JSON.parse(await readFile(input, 'utf8'))));
  await writeFile(output, JSON.stringify(summarizeStartupPairs(rows), null, 2), { flag: 'wx' });
} else if (mode === '--observe') {
  const [phase, pairText, packageSha256, output] = args;
  assert.ok(['v2-baseline', 'v3-candidate'].includes(phase));
  const pair = Number(pairText);
  assert.ok(Number.isInteger(pair) && pair >= 1 && pair <= 5);
  assert.match(packageSha256 || '', /^[a-f0-9]{64}$/u, 'Supply instrumented package provenance SHA-256');
  assert.equal(process.env.OBREADER_NATIVE_STARTUP_LEASE, 'exclusive-after-native-gates');
  const { nativeConfig, assertNativeVaultIdentity } = await import('./native-config.mjs');
  assert.ok(output && outside(output, repo) && outside(output, nativeConfig.vault));
  await writeFile(output, '', { flag: 'wx' });
  const report = { phase, pair, packageSha256, runId: randomUUID(), status: 'NOT_RUN', record: null, mainThreadCPU: 'NOT_MEASURED', fullStartupAddedBlocking: 'NOT_MEASURED' };
  const collectTrace = process.env.OBREADER_NATIVE_STARTUP_TRACE === '1';
  if (collectTrace) for (const suffix of ['trace.json', 'cpuprofile.json']) await writeFile(`${output}.${suffix}`, '', { flag: 'wx' });
  let browser, page, session, diagnosticsState, armed = false;
  try {
    const { default: puppeteer } = await import('puppeteer-core');
    browser = await puppeteer.connect({ browserURL: nativeConfig.cdpUrl, defaultViewport: null });
    const matches = [];
    for (const candidate of await browser.pages()) if (candidate.url() === 'app://obsidian.md/index.html' && await candidate.evaluate(vault => globalThis.app?.vault?.adapter?.basePath === vault, nativeConfig.vault)) matches.push(candidate);
    assert.equal(matches.length, 1);
    page = matches[0];
    const identity = await page.evaluate(() => ({ vault: app.vault.adapter.basePath, configDir: app.vault.configDir }));
    assertNativeVaultIdentity(identity); report.identity = identity;
    if (collectTrace) { session = await page.createCDPSession(); diagnosticsState = await startStartupDiagnostics(session); }
    await page.evaluate(({ key, runId }) => {
      if (app.plugins.plugins['pdf-web-reader'] || app.plugins.enabledPlugins.has('pdf-web-reader')) throw Error('Coordinator must disable plugin before arming');
      if (app.workspace.getLeavesOfType('pdf-web-reader-view').length) throw Error('Readers must be closed');
      const symbol = Symbol.for(key);
      if (globalThis[symbol]) throw Error('Probe already armed');
      const probe = { runId, mark: suffix => performance.mark(`obreader-startup:${runId}:${suffix}`), record: null, manifests: [], longTasks: [], longTaskSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
      const adapter = app.vault.adapter, original = adapter.read;
      const ownDescriptor = Object.getOwnPropertyDescriptor(adapter, 'read');
      const wrapped = function(resourcePath, ...rest) {
        if (!String(resourcePath).endsWith('/manifest.json')) return original.call(this, resourcePath, ...rest);
        const start = performance.now();
        const returned = original.call(this, resourcePath, ...rest);
        const row = { path: resourcePath, startedAt: start, syncInvocationMs: performance.now() - start };
        probe.manifests.push(row);
        return Promise.resolve(returned).then(value => { row.endedAt = performance.now(); row.asyncElapsedMs = performance.now() - start; return value; }, error => { row.endedAt = performance.now(); row.asyncElapsedMs = performance.now() - start; row.error = String(error); throw error; });
      };
      adapter.read = wrapped;
      let observer;
      if (probe.longTaskSupported) try { observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) probe.longTasks.push({ startTime: entry.startTime, duration: entry.duration }); }); observer.observe({ type: 'longtask' }); } catch (error) { observer?.disconnect(); probe.longTaskSupported = false; probe.longTaskError = String(error); }
      probe.restore = () => { observer?.disconnect(); if (adapter.read !== wrapped) throw Error('Adapter read changed while armed; refuse overwrite'); if (ownDescriptor) Object.defineProperty(adapter, 'read', ownDescriptor); else delete adapter.read; for (const suffix of ['armed', 'onload-start', 'sync-return', 'onload-settled', 'onload-failed', 'quiet-end']) performance.clearMarks(`obreader-startup:${runId}:${suffix}`); delete globalThis[symbol]; };
      globalThis[symbol] = probe; probe.mark('armed');
    }, { key: STARTUP_PROBE_KEY, runId: report.runId });
    armed = true;
    console.log('ARMED: coordinator may now enable the already-staged instrumented package once; no deployment or toggle is performed by collector.');
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const snapshot = await page.evaluate(({ key, vault, runId }) => {
        if (app.vault.adapter.basePath !== vault) throw Error('Vault changed');
        const probe = globalThis[Symbol.for(key)];
        if (probe?.runId !== runId) throw Error('Probe ownership changed');
        const now = performance.now();
        const latestWork = Math.max(probe.record?.settledAt || now, ...probe.manifests.map(row => row.endedAt || now));
        const quiet = probe.record?.status === 'settled' && probe.manifests.every(row => Number.isFinite(row.endedAt)) && now - latestWork >= 250;
        if (quiet && !probe.quietEnd) { probe.quietEnd = now; probe.mark('quiet-end'); }
        return { quietEnd: probe.quietEnd || null, quietPolicy: 'onload settled + all observed manifest reads settled + 250ms without new observed manifest activity', record: probe.record, manifests: probe.manifests, longTasks: probe.longTasks, longTaskSupported: probe.longTaskSupported };
      }, { key: STARTUP_PROBE_KEY, vault: nativeConfig.vault, runId: report.runId });
      Object.assign(report, snapshot);
      if (snapshot.record?.status === 'failed' || snapshot.quietEnd) { report.status = snapshot.record.status === 'settled' ? 'MEASURED' : 'FAILED'; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (report.status === 'NOT_RUN') throw Error('Timed out waiting for actual instrumented onload; no retries');
  } catch (error) { report.status = 'FAILED'; report.error = String(error.stack || error); process.exitCode = 1; }
  finally {
    if (diagnosticsState) try {
      const diagnostics = await stopStartupDiagnostics(session, diagnosticsState);
      if (diagnostics.traceRaw !== undefined) { await writeFile(`${output}.trace.json`, diagnostics.traceRaw); try { diagnostics.rendererTrace = summarizeRendererTrace(JSON.parse(diagnostics.traceRaw), report.runId); } catch (error) { diagnostics.traceParseError = String(error); } delete diagnostics.traceRaw; }
      if (diagnostics.cpuProfile) { await writeFile(`${output}.cpuprofile.json`, JSON.stringify(diagnostics.cpuProfile)); delete diagnostics.cpuProfile; diagnostics.cpuProfilePath = `${output}.cpuprofile.json`; }
      diagnostics.tracePath = `${output}.trace.json`;
      report.diagnostics = diagnostics;
    } catch (error) { report.diagnosticsError = String(error); }
    if (armed) try { await page.evaluate(({ key, runId }) => { const probe = globalThis[Symbol.for(key)]; if (probe?.runId !== runId) throw Error('Probe ownership changed'); probe.restore(); }, { key: STARTUP_PROBE_KEY, runId: report.runId }); } catch (error) { report.cleanupError = String(error); report.status = 'FAILED'; process.exitCode = 1; }
    await browser?.disconnect();
    await writeFile(output, JSON.stringify(report, null, 2));
  }
} else throw Error('Use --prepare <own-main.js> <outside-staging-main.js>, --observe <phase> <pair1..5> <instrumented-sha256> <outside-report>, or --summarize <output> <phase-reports...>');
