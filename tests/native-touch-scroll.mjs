import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { nativeConfig, assertNativeVaultIdentity } from './native-config.mjs';
const { vault, configDir, cdpUrl } = nativeConfig;
assert.equal(vault, '/Users/jiajia/Documents/ObReader-Apple-Test');
assert.ok(cdpUrl);
const version = '0.5.6', runId = `general-${version}-scroll-native-${Date.now()}`;
const folder = `PDF迁移测试/${runId}`, file = `${folder}/scroll.pdf`;
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const driver = await fs.readFile(import.meta.filename);
await fs.writeFile(`tests/artifacts/${runId}.driver.mjs`, driver, { flag: 'wx' });
const report = { runId, version, vault, driverSha256: hash(driver), physicalIpadValidated: false, primaryVaultTouched: false, status: 'running', checks: {} };
const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
const page = (await browser.pages()).find(p => p.url() === 'app://obsidian.md/index.html');
assert.ok(page);
const session = await page.createCDPSession();
let original, failure;
const pause = ms => new Promise(r => setTimeout(r, ms));
async function identity() {
  const s = await page.evaluate(() => ({ vault: app.vault.adapter.basePath, configDir: app.vault.configDir, version: app.plugins.plugins['pdf-web-reader']?.manifest.version }));
  assertNativeVaultIdentity(s); assert.equal(s.version, version); return s;
}
async function root(fn, arg) {
  await identity();
  return page.evaluate(async ({ source, arg, vault }) => {
    if (app.vault.adapter.basePath !== vault) throw Error('Wrong test Vault');
    return (0, eval)(`(${source})`)(arg);
  }, { source: fn.toString(), arg, vault });
}
async function doc(fn, arg) {
  return root(({ file, source, arg }) => {
    const v = [...app.plugins.plugins['pdf-web-reader'].views].find(v => v.requestedPath === file);
    if (!v?.iframe) throw Error('Owned Reader missing');
    const w = v.iframe.contentWindow;
    return (0, eval)(`(${source})`)({ v, w, d: w.document, a: w.PDFViewerApplication, arg });
  }, { file, source: fn.toString(), arg });
}
async function wait(label, fn, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await pause(100); }
  throw Error(`${label}: ${JSON.stringify(last)}`);
}
async function mode(mobile) {
  await root(() => { if (app.plugins.plugins['pdf-web-reader'].views.size) throw Error('Existing Readers'); });
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await root(mobile => { setTimeout(() => app.emulateMobile(mobile), 0); }, mobile);
  await navigation;
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForFunction(() => app?.workspace?.layoutReady && app.plugins.plugins['pdf-web-reader']?.settings, { timeout: 30000 });
  await identity();
}
async function touch(type, point) {
  await identity();
  await session.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ x: point.x, y: point.y, id: 31, radiusX: 4, radiusY: 4, force: 1 }] : [] });
}
async function snapshot() {
  return doc(({ v, d, a }) => ({ scroll: d.getElementById('viewerContainer').scrollTop, revision: v.currentRevision, storage: a.pdfDocument.annotationStorage.size, mode: a.pdfViewer.annotationEditorMode }));
}
try {
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  report.checks.identity = await identity();
  original = await root(() => { const p = app.plugins.plugins['pdf-web-reader']; if (p.views.size) throw Error('Existing Readers'); return { mobile: !!app.isMobile, autoSave: p.settings.autoSave }; });
  assert.equal(original.mobile, false);
  report.productHashes = {};
  for (const n of ['main.js', 'manifest.json', 'styles.css']) { const actual = await fs.readFile(path.join(vault, configDir, 'plugins/pdf-web-reader', n)); assert.deepEqual(await fs.readFile(`dist/pdf-web-reader/${n}`), actual); report.productHashes[n] = hash(actual); }
  await mode(true);
  const bytes = await fs.readFile('tests/fixtures/tracemonkey.pdf');
  await root(async ({ folder, file, bytes }) => { if (!folder.startsWith('PDF迁移测试/general-0.5.6-scroll-native-') || app.vault.getAbstractFileByPath(folder) || app.vault.getAbstractFileByPath(file)) throw Error('Unsafe or existing fixture'); await app.vault.createFolder(folder); await app.vault.createBinary(file, new Uint8Array(bytes).buffer); }, { folder, file, bytes: [...bytes] });
  await root(async file => app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(file)), file);
  await wait('PDF rendered', () => doc(({ v, a }) => v.ready && a.pdfViewer.getPageView(0)?.renderingState === 3));
  const tool = await doc(({ v, d }) => { const r = d.getElementById('editorInkButton').getBoundingClientRect(), f = v.iframe.getBoundingClientRect(); return { x: f.x + r.x + r.width / 2, y: f.y + r.y + r.height / 2 }; });
  await page.mouse.click(tool.x, tool.y);
  await wait('Ink selected', async () => (await snapshot()).mode === 15);
  const before = await snapshot();
  const point = await doc(({ v, d }) => { const r = d.getElementById('viewerContainer').getBoundingClientRect(), f = v.iframe.getBoundingClientRect(); return { x: f.x + r.x + r.width * .5, y: f.y + r.y + r.height * .7, distance: Math.min(240, r.height * .5) }; });
  await touch('touchStart', point);
  for (let n = 1; n <= 4; n++) { await pause(12); await touch('touchMove', { x: point.x, y: point.y - point.distance * n / 4 }); }
  const atRelease = await snapshot(); await touch('touchEnd');
  const released = await snapshot(); await pause(120); const first = await snapshot(); await pause(120); const second = await snapshot();
  assert.ok(atRelease.scroll > before.scroll + point.distance * .7);
  assert.ok(first.scroll > released.scroll + 10);
  assert.ok(second.scroll > first.scroll + 3);
  assert.ok(second.scroll - first.scroll < first.scroll - released.scroll);
  const stationary = await doc(({ v, d }) => { const r = d.getElementById('viewerContainer').getBoundingClientRect(), f = v.iframe.getBoundingClientRect(); return { x: f.x + r.x + r.width * .8, y: f.y + r.y + r.height * .7 }; });
  await touch('touchStart', stationary); const stopped = await snapshot(); await pause(150); await touch('touchEnd'); await pause(160); const stoppedLater = await snapshot();
  assert.ok(Math.abs(stoppedLater.scroll - stopped.scroll) <= 1);
  for (const s of [atRelease, released, first, second, stoppedLater]) { assert.equal(s.revision, before.revision); assert.equal(s.storage, before.storage); }
  assert.equal(hash(await fs.readFile(path.join(vault, file))), hash(bytes));
  report.checks.trustedCdpTouch = { before, atRelease, released, first, second, stopped, stoppedLater, fixtureUnchanged: true, touchWithInkDoesNotEdit: true, newContactStopsMomentum: true };
  report.status = 'passed';
} catch (e) { failure = e; report.status = 'failed'; report.error = { message: e.message, stack: e.stack }; }
finally {
  try {
    await identity(); await root(async prefix => { for (const v of [...app.plugins.plugins['pdf-web-reader'].views]) if (v.requestedPath?.startsWith(prefix + '/')) await v.leaf.detach(); await app.workspace.saveLayout(); }, folder);
  } catch (e) { failure ||= e; report.status = 'failed'; report.readerCleanupError = e.message; }
  // Restore the emulator independently even if layout cleanup failed after detach.
  try {
    await identity();
    if (original && await root(() => !!app.isMobile) !== original.mobile) await mode(original.mobile);
  } catch (e) { failure ||= e; report.status = 'failed'; report.modeRestoreError = e.message; }
  try {
    report.cleanup = await root(() => ({ mobile: !!app.isMobile, readers: app.workspace.getLeavesOfType('pdf-web-reader-view').length, views: app.plugins.plugins['pdf-web-reader'].views.size, autoSave: app.plugins.plugins['pdf-web-reader'].settings.autoSave }));
    assert.equal(report.cleanup.mobile, original?.mobile ?? false); assert.equal(report.cleanup.readers, 0); assert.equal(report.cleanup.views, 0); if (original) assert.equal(report.cleanup.autoSave, original.autoSave);
  } catch (e) { failure ||= e; report.status = 'failed'; report.cleanupVerificationError = e.message; }
  try { await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }); await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }); } catch {}
  await browser.disconnect(); report.finishedAt = new Date().toISOString(); const output = `tests/artifacts/${runId}.json`; await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); console.log(output, report.status);
}
if (failure) throw failure;
