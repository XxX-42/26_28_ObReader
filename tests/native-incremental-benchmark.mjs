import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { PDFDocument, PDFName } from 'pdf-lib';
import { nativeConfig, assertNativeVaultIdentity } from './native-config.mjs';

const { vault, configDir, cdpUrl } = nativeConfig;
assert.equal(vault, '/Users/jiajia/Documents/ObReader-Apple-Test');
assert.equal(cdpUrl, 'http://127.0.0.1:9230');
const version = process.env.BENCH_VERSION || '0.5.17';
const label = process.env.BENCH_LABEL || 'candidate';
const editCount = Number(process.env.BENCH_EDITS || 10);
assert.ok(Number.isInteger(editCount) && editCount >= 1 && editCount <= 10);
const targetMobile = process.env.BENCH_MOBILE !== '0';
const run = `general-0.5.17-${targetMobile ? 'mobile' : 'desktop'}-benchmark-${label}-${Date.now()}`;
const folder = `PDF迁移测试/${run}`, file = `${folder}/large.pdf`;
const report = { run, version, vault, status: 'running', physicalIpadValidated: false,
  writeMode: process.env.BENCH_FORCE_FULL === '1' ? 'controlled same-version fallback: append capability disabled in test only' : 'normal capability-selected production path',
  memoryScope: 'CDP renderer plus discoverable isolated-app Worker JS heaps and backing storage; excludes native/canvas/GPU memory and physical iPad footprint',
  checks: [], heapSamples: [] };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
await fs.mkdir('tests/artifacts', { recursive: true });
const fixture = 'tests/artifacts/general-0.5.17-large-synthetic.pdf';
let bytes;
try { bytes = await fs.readFile(fixture); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 120; i++) {
    const page = pdf.addPage([420, 540]);
    page.drawText(`Large benchmark page ${i + 1}`, { x: 25, y: 470, size: 15 });
  }
  await pdf.attach(crypto.randomBytes(16 * 1024 * 1024), 'synthetic-random-data.bin');
  bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  await fs.writeFile(fixture, bytes, { flag: 'wx' });
}
report.fixture = { bytes: bytes.length, sha256: hash(bytes), pages: 120,
  description: 'Synthetic text PDF with 16MiB incompressible attachment; isolates save workload, not scanned-page rendering' };
await fs.writeFile(`tests/artifacts/${run}.driver.mjs`, await fs.readFile(import.meta.filename), { flag: 'wx' });
const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
const page = (await browser.pages()).find(p => p.url() === 'app://obsidian.md/index.html');
assert.ok(page); const session = await page.createCDPSession();
let original, failure, sampling = false, phase = 0, samplingPromise = null;
async function identity() {
  const value = await page.evaluate(() => ({ vault: app.vault.adapter.basePath, configDir: app.vault.configDir,
    version: app.plugins.plugins['pdf-web-reader']?.manifest.version, mobile: !!app.isMobile,
    views: app.plugins.plugins['pdf-web-reader']?.views.size }));
  assertNativeVaultIdentity(value); assert.equal(value.version, version); return value;
}
async function root(fn, arg) {
  await identity();
  return page.evaluate(async ({ source, arg, vault }) => {
    if (app.vault.adapter.basePath !== vault) throw Error('Wrong Vault');
    return (0, eval)(`(${source})`)(arg);
  }, { source: fn.toString(), arg, vault });
}
async function doc(fn, arg) {
  return root(({ file, source, arg }) => {
    const v = [...app.plugins.plugins['pdf-web-reader'].views].find(v => v.requestedPath === file);
    if (!v?.iframe) throw Error('Own Reader missing');
    const w = v.iframe.contentWindow;
    return (0, eval)(`(${source})`)({ v, w, a: w.PDFViewerApplication, d: w.document, arg });
  }, { file, source: fn.toString(), arg });
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, fn, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await pause(100); }
  throw Error(`Timed out: ${label}`);
}
async function mode(mobile) {
  assert.equal((await identity()).views, 0);
  await root(async () => app.workspace.saveLayout());
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await root(m => { setTimeout(() => app.emulateMobile(m), 0); }, mobile); await nav;
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForFunction(m => app?.workspace?.layoutReady &&
    app.plugins.plugins['pdf-web-reader']?.settings && !!app.isMobile === m,
  { polling: 100, timeout: 30000 }, mobile); await identity();
}
async function closeOwn() {
  await root(async folder => {
    for (const v of [...app.plugins.plugins['pdf-web-reader'].views]) {
      if (v.requestedPath?.startsWith(folder + '/')) await v.leaf.detach();
    }
    await app.workspace.saveLayout();
  }, folder);
}
const sample = async () => {
  await session.send('Performance.enable');
  while (sampling) {
    const { metrics } = await session.send('Performance.getMetrics');
    const renderer = await session.send('Runtime.getHeapUsage');
    const workers = [];
    for (const t of browser.targets().filter(t => ['worker', 'other'].includes(t.type()))) {
      try { const workerSession = await t.createCDPSession();
        workers.push({ type: t.type(), usage: await workerSession.send('Runtime.getHeapUsage') });
        await workerSession.detach();
      } catch { /* Some Obsidian utility targets expose no JavaScript runtime. */ }
    }
    report.heapSamples.push({ at: performance.now(), phase, used: metrics.find(m => m.name === 'JSHeapUsedSize')?.value,
      total: metrics.find(m => m.name === 'JSHeapTotalSize')?.value, renderer, workers,
      measuredJsAndBackingBytes: renderer.usedSize + (renderer.backingStorageSize || 0) +
        workers.reduce((sum, w) => sum + w.usage.usedSize + (w.usage.backingStorageSize || 0), 0) });
    await pause(100);
  }
};
async function collectSaveTimings() {
  const currentLog = await root(async () => {
    await app.plugins.plugins['pdf-web-reader'].sessionLog.flush();
    const logPath = app.plugins.plugins['pdf-web-reader'].sessionLog.path;
    const directory = logPath.slice(0, logPath.lastIndexOf('/'));
    const basename = logPath.slice(logPath.lastIndexOf('/') + 1);
    const session = basename.replace(/-\d{3}\.log$/, '');
    const listing = await app.vault.adapter.list(directory);
    const logPaths = (listing.files || []).filter(file => {
      const name = file.slice(file.lastIndexOf('/') + 1);
      return name.startsWith(`${session}-`) && /-\d{3}\.log$/.test(name);
    }).sort((left, right) => {
      const part = file => Number(/-(\d{3})\.log$/.exec(file)?.[1] || 0);
      return part(left) - part(right);
    });
    const text = (await Promise.all(logPaths.map(file => app.vault.adapter.read(file)))).join('');
    return { logPath, logPaths, text };
  });
  const messages = report.saveInputs || await root(() => window.__incrementalBench?.messages || []);
  const transactionIds = new Set(messages
    .filter(message => message.type === 'save' && typeof message.saveTransactionId === 'string')
    .map(message => message.saveTransactionId));
  report.saveTimings = currentLog.text.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(row => row?.kind === 'performance' && row.fn === 'PdfSyncHost.save' && transactionIds.has(row.saveTransactionId));
  const durations = report.saveTimings.map(row => row.saveTotalMs).filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = p => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * p) - 1)] : null;
  report.saveTimingSummary = { n: durations.length,
    meanMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    medianMs: percentile(0.5), p90Ms: percentile(0.9), maxMs: durations.at(-1) ?? null };
  report.logPath = currentLog.logPath;
  report.logPaths = currentLog.logPaths;
}
try {
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  original = await identity(); assert.equal(original.mobile, false); assert.equal(original.views, 0);
  await mode(targetMobile);
  for (const name of ['main.js', 'manifest.json', 'styles.css']) report[name] =
    hash(await fs.readFile(path.join(vault, configDir, 'plugins/pdf-web-reader', name)));
  // Streaming through Obsidian's adapter avoids transferring a large array over CDP.
  await fs.mkdir(path.join(vault, folder)); await fs.writeFile(path.join(vault, file), bytes);
  await wait('fixture indexed', () => root(file => !!app.vault.getAbstractFileByPath(file), file));
  await root(({ file, folder, capture, forceFull }) => {
    const v = app.vault, a = v.adapter, t = window.__incrementalBench = { writes: [], originals: [] };
    t.messages = [];
    t.onMessage = e => {
      if (!e.data || e.data.documentPath !== file || !['save', 'recover', 'sync-checkpoint'].includes(e.data.type)) return;
      t.messages.push({ type: e.data.type, revision: e.data.revision, saveTransactionId: e.data.saveTransactionId,
        actorId: e.data.actorId, dirtyState: e.data.dirtyState,
        newAnnotations: e.data.newAnnotations, operations: e.data.operations, bytes: e.data.data?.byteLength });
    };
    window.addEventListener('message', t.onMessage, true);
    if (forceFull) { t.originals.push({ owner: v, name: 'appendBinary', original: v.appendBinary }); v.appendBinary = undefined; }
    if (capture) {
      const sync = app.plugins.plugins['pdf-web-reader'].pdfSync, original = sync.save;
      t.originals.push({ owner: sync, name: 'save', original });
      sync.save = async function(view, captured, message) {
        if (captured.documentPath === file) {
          const stem = `${folder}/capture-${message.revision}-${Date.now()}`;
          const toBuffer = value => { const a = new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength); return a.slice().buffer; };
          await a.writeBinary(`${stem}-base.pdf`, toBuffer(captured.loadedBaseBytes || captured.originalBytes));
          await a.writeBinary(`${stem}-original.pdf`, toBuffer(captured.originalBytes));
          await a.writeBinary(`${stem}-draft.pdf`, toBuffer(message.data));
          await a.write(`${stem}.json`, JSON.stringify({ operations: message.operations, newAnnotations: message.newAnnotations,
            actorId: message.actorId, openRequest: captured.openRequest, revision: message.revision }));
        }
        return original.call(this, view, captured, message);
      };
      t.captureWrites = [];
      const originalPost = Worker.prototype.postMessage;
      t.originals.push({ owner: Worker.prototype, name: 'postMessage', original: originalPost });
      Worker.prototype.postMessage = function(message, ...rest) {
        if (message?.method === 'prepareLocal') {
          const payload = message.payload, stem = `${folder}/worker-${message.id}-${Date.now()}`;
          const work = (async () => {
            const sources = {};
            for (const name of ['baseBytes', 'draftBytes', 'checkpointBytes']) {
              const value = payload[name];
              if (value) sources[name] = new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength).slice().buffer;
            }
            const details = { operations: payload.operations, newAnnotations: payload.newAnnotations, actorId: payload.actorId };
            for (const [name, value] of Object.entries(sources)) await a.writeBinary(`${stem}-${name}.pdf`, value);
            await a.write(`${stem}.json`, JSON.stringify(details));
          })(); t.captureWrites.push(work);
        }
        return originalPost.call(this, message, ...rest);
      };
    }
    for (const [owner, name, scope] of [[v, 'modifyBinary', 'vault'], [v, 'appendBinary', 'vault'],
      [a, 'writeBinary', 'adapter'], [a, 'appendBinary', 'adapter']]) {
      if (typeof owner[name] !== 'function') continue;
      const original = owner[name]; t.originals.push({ owner, name, original });
      owner[name] = async function(target, data, ...rest) {
        const started = performance.now(), targetPath = typeof target === 'string' ? target : target.path;
        const row = { scope, method: name, path: targetPath, bytes: data.byteLength, started, ownPdf: targetPath === file };
        t.writes.push(row);
        try { const result = await original.call(this, target, data, ...rest); row.finished = performance.now(); return result; }
        catch (error) { row.error = error.message; throw error; }
      };
    }
  }, { file, folder, capture: process.env.BENCH_CAPTURE === '1', forceFull: process.env.BENCH_FORCE_FULL === '1' });
  await root(file => app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(file)), file);
  await wait('PDF rendered', () => doc(({ v, a }) => v.ready && a.pdfDocument?.numPages === 120 && a.pdfViewer.getPageView(0)?.renderingState === 3));
  await doc(({ a, d }) => { a.pdfViewer.currentPageNumber = 1; a.pdfViewer.currentScaleValue = 'page-fit'; d.getElementById('viewerContainer').scrollTop = 0; });
  await wait('visible page', () => doc(({ d }) => {
    const r = d.querySelector('.page[data-page-number="1"]').getBoundingClientRect(), v = d.getElementById('viewerContainer').getBoundingClientRect();
    return Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top) > 140;
  }));
  const tool = await doc(({ v, d }) => { const r = d.getElementById('editorSquareButton').getBoundingClientRect(), f = v.iframe.getBoundingClientRect(); return { x: f.x + r.x + r.width / 2, y: f.y + r.y + r.height / 2 }; });
  await page.mouse.click(tool.x, tool.y);
  await doc(({ w, d }) => {
    w.__benchInput = [];
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) d.addEventListener(type, e => {
      w.__benchInput.push({ type, pointerType: e.pointerType, button: e.button, x: e.clientX, y: e.clientY,
        target: e.target?.className, prevented: e.defaultPrevented });
    });
  });
  sampling = true; samplingPromise = sample();
  for (let i = 0; i < editCount; i++) {
    phase = i + 1;
    // Clear the selected annotation's floating edit toolbar before the next
    // real drawing gesture; otherwise it can cover that gesture's start point.
    await page.keyboard.press('Escape');
    if (await doc(({ a }) => a.pdfViewer.annotationEditorMode !== 5)) {
      const t = await doc(({ v, d }) => { const r = d.getElementById('editorSquareButton').getBoundingClientRect(), f = v.iframe.getBoundingClientRect(); return { x: f.x + r.x + r.width / 2, y: f.y + r.y + r.height / 2 }; });
      await page.mouse.click(t.x, t.y);
    }
    await wait('Square tool active', () => doc(({ a }) => a.pdfViewer.annotationEditorMode === 5));
    await doc(({ a, d }) => { a.pdfViewer.currentPageNumber = 1; a.pdfViewer.currentScaleValue = 'page-fit'; d.getElementById('viewerContainer').scrollTop = 0; });
    const revisionBefore = await doc(({ v }) => v.currentRevision);
    const q = await doc(({ v, d, arg }) => {
      const r = d.querySelector('.page[data-page-number="1"]').getBoundingClientRect(), view = d.getElementById('viewerContainer').getBoundingClientRect(), f = v.iframe.getBoundingClientRect();
      const left = Math.max(r.left, view.left), right = Math.min(r.right, view.right);
      const top = Math.max(r.top, view.top), bottom = Math.min(r.bottom, view.bottom);
      const width = right - left, height = bottom - top;
      if (width < 100 || height < 100) throw Error(`Visible page intersection is too small: ${width}x${height}`);
      const x = left + width * (0.2 + (arg % 6) * 0.09);
      const y = top + height * (0.25 + (arg % 5) * 0.07);
      if (!d.elementFromPoint(x, y)?.closest('.page[data-page-number="1"]')) throw Error('Drawing point not on page');
      return { x: f.x + x, y: f.y + y };
    }, i);
    await page.mouse.move(q.x, q.y); await page.mouse.down(); await page.mouse.move(q.x + 60, q.y + 24, { steps: 5 }); await page.mouse.up();
    await wait('edited revision', () => doc(({ v, arg }) => v.currentRevision > arg, revisionBefore), 10000);
    const capturedRevision = await doc(({ v }) => v.currentRevision), started = performance.now();
    // Cmd+S follows the production manual save path; no direct mock writer.
    await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
    await wait('confirmed revision', () => doc(({ v, arg }) => {
      if (v.failureNoticeShown) throw Error('Production save reported failure; inspect preserved recovery metadata');
      return v.confirmedRevision >= arg && !v.saving;
    }, capturedRevision));
    const saveInput = await root(({ file, revision }) => window.__incrementalBench.messages.findLast(
      message => message.type === 'save' && message.revision === revision,
    ) || null, { file, revision: capturedRevision });
    report.checks.push({ edit: i + 1, revision: capturedRevision,
      saveTransactionId: saveInput?.saveTransactionId || null,
      dirtyPageCount: saveInput?.dirtyState?.dirtyPageIndices?.length ?? null,
      confirmedMs: performance.now() - started,
      diskBytes: (await fs.stat(path.join(vault, file))).size });
    await wait('post-save Viewer settled', () => doc(({ v, a }) => !v.syncNeedsRefresh && v.ready &&
      a.pdfDocument?.numPages === 120 && a.pdfViewer.getPageView(0)?.renderingState === 3));
    report.checks.at(-1).viewerSettledMs = performance.now() - started;
  }
  sampling = false; await samplingPromise;
  report.writes = await root(() => window.__incrementalBench.writes);
  report.heapPeakBytes = Math.max(...report.heapSamples.map(x => x.used || 0));
  report.measuredJsAndBackingPeakBytes = Math.max(...report.heapSamples.map(x => x.measuredJsAndBackingBytes || 0));
  await closeOwn();
  const finalBytes = await fs.readFile(path.join(vault, file));
  const parsed = await PDFDocument.load(finalBytes);
  const squares = (parsed.getPage(0).node.Annots()?.asArray() || []).filter(ref =>
    parsed.context.lookup(ref)?.get(PDFName.of('Subtype'))?.toString() === '/Square').length;
  assert.equal(squares, editCount); report.savedSquares = squares; report.finalSha256 = hash(finalBytes);
  // Reopen through the installed plugin and verify visible PDF annotations.
  await root(file => app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(file)), file);
  await wait('reopened', () => doc(({ v, a }) => v.ready && a.pdfDocument?.numPages === 120));
  report.reopenedSquares = await doc(async ({ a }) => (await (await a.pdfDocument.getPage(1)).getAnnotations()).filter(x => x.subtype === 'Square').length);
  assert.equal(report.reopenedSquares, editCount); await closeOwn(); report.status = 'passed';
} catch (error) { failure = error; report.status = 'failed'; report.error = error.stack;
  try { report.failedEditorState = await doc(({ v, w, a, d }) => ({ revision: v.currentRevision, confirmed: v.confirmedRevision,
    mode: a.pdfViewer.annotationEditorMode, input: w.__benchInput, page: d.querySelector('.page')?.getBoundingClientRect().toJSON(),
    editorLayerClass: d.querySelector('.annotationEditorLayer')?.className,
    squareClasses: [...d.querySelectorAll('.squareEditor')].map(e => e.className),
    editorManagerKeys: Object.keys(a.pdfViewer?._layerProperties?.annotationEditorUIManager || {}) })); } catch {}
}
finally {
  sampling = false;
  if (samplingPromise) await samplingPromise.catch(() => {});
  try {
    await closeOwn(); await root(() => {
      const t = window.__incrementalBench;
      if (t) { for (const row of t.originals) row.owner[row.name] = row.original; window.removeEventListener('message', t.onMessage, true); }
    });
    await root(async () => { await Promise.all(window.__incrementalBench?.captureWrites || []); });
    report.saveInputs = await root(() => window.__incrementalBench?.messages);
    await collectSaveTimings();
    await root(() => { delete window.__incrementalBench; });
    if (original && (await identity()).mobile !== original.mobile) await mode(original.mobile);
    await closeOwn(); report.cleanup = await identity(); assert.equal(report.cleanup.mobile, false); assert.equal(report.cleanup.views, 0);
    if (report.status === 'passed') {
      await root(async ({ file }) => {
        const generated = app.vault.getAbstractFileByPath(file);
        if (generated) await app.vault.adapter.remove(file);
      }, { file });
      await fs.rmdir(path.join(vault, folder));
      report.testPdfCleanup = { removed: true, path: file };
    } else {
      report.testPdfCleanup = { removed: false, preservedFailureEvidence: true, path: file };
    }
  } catch (error) { failure ||= error; report.status = 'failed'; report.cleanupError = error.message; }
  report.heapPeakBytes = Math.max(0, ...report.heapSamples.map(x => x.used || 0));
  report.measuredJsAndBackingPeakBytes = Math.max(0, ...report.heapSamples.map(x => x.measuredJsAndBackingBytes || 0));
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
  browser.disconnect(); await fs.writeFile(`tests/artifacts/${run}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(run, report.status, report.checks.map(x => Math.round(x.confirmedMs)));
}
if (failure) throw failure;
