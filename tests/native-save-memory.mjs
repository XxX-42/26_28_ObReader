import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { PDFDocument } from 'pdf-lib';
import { nativeConfig, assertNativeVaultIdentity } from './native-config.mjs';

const { vault, configDir, cdpUrl } = nativeConfig;
assert.equal(vault, '/Users/jiajia/Documents/ObReader-Apple-Test');
assert.ok(cdpUrl, 'Use the owned isolated CDP endpoint');
const version = '0.5.5', runId = `general-${version}-save-memory-native-${Date.now()}`;
const folder = `PDF迁移测试/${runId}`, file = `${folder}/edit.pdf`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { runId, vault, version, startedAt: new Date().toISOString(), physicalIpadValidated: false, primaryVaultTouched: false, checks: {}, status: 'running' };
const browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
const page = (await browser.pages()).find(p => p.url() === 'app://obsidian.md/index.html');
assert.ok(page);
const session = await page.createCDPSession();
let original, failure;
async function identity() {
  const value = await page.evaluate(() => ({ vault: app.vault.adapter.basePath, configDir: app.vault.configDir, version: app.plugins.plugins['pdf-web-reader']?.manifest.version }));
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
    if (!v?.iframe) throw Error('Owned Reader not found');
    const w = v.iframe.contentWindow;
    return (0, eval)(`(${source})`)({ v, w, a: w.PDFViewerApplication, d: w.document, arg });
  }, { file, source: fn.toString(), arg });
}
async function wait(label, fn, ok = Boolean, timeout = 30000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { last = await fn(); if (ok(last)) return last; await new Promise(r => setTimeout(r, 100)); }
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
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}
async function click(selector) {
  const q = await wait(`click ${selector}`, () => doc(({ v, d, arg }) => {
    const e = d.querySelector(arg); if (!e || e.disabled) return false;
    const r = e.getBoundingClientRect(), f = v.iframe.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = r.x + r.width / 2, y = r.y + r.height / 2, hit = d.elementFromPoint(x, y);
    return hit === e || e.contains(hit) ? { x: f.x + x, y: f.y + y } : false;
  }, selector));
  await page.mouse.click(q.x, q.y);
}
async function state() {
  return doc(({ v, a }) => ({ ready: v.ready, revision: v.currentRevision, confirmed: v.confirmedRevision, pending: v.pendingSaves, dirty: !!a._hasChanges?.(), annotations: [...(a.pdfDocument.annotationStorage.serializable.map || new Map()).values()].filter(e => !e.deleted).length }));
}
async function draw(index) {
  const q = await doc(({ v, d, arg }) => { const r = d.querySelector('.page[data-page-number="1"]').getBoundingClientRect(), f = v.iframe.getBoundingClientRect(); return { x: f.x + r.x + r.width * .23 + arg * 16, y: f.y + r.y + r.height * .35 + arg * 25 }; }, index);
  await page.mouse.move(q.x, q.y); await page.mouse.down(); await page.mouse.move(q.x + 70, q.y + 35, { steps: 6 }); await page.mouse.up();
}
async function open() {
  await root(async file => app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(file)), file);
  await wait('rendered PDF', () => doc(({ v, a }) => v.ready && a.pdfDocument?.numPages === 2 && a.pdfViewer.getPageView(0)?.renderingState === 3));
}
async function close() {
  await root(async prefix => { for (const v of [...app.plugins.plugins['pdf-web-reader'].views]) if (v.requestedPath?.startsWith(prefix + '/')) await v.leaf.detach(); await app.workspace.saveLayout(); }, folder);
}
async function trace() { return root(() => window.__readerSaveMemoryTrace.writes); }
try {
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  report.checks.identity = await identity();
  original = await root(() => { const p = app.plugins.plugins['pdf-web-reader']; if (p.views.size) throw Error('Existing Readers'); return { mobile: !!app.isMobile, autoSave: p.settings.autoSave, showStatusBar: p.settings.showStatusBar }; });
  assert.equal(original.mobile, false);
  for (const name of ['main.js', 'manifest.json', 'styles.css']) assert.deepEqual(await fs.readFile(`dist/pdf-web-reader/${name}`), await fs.readFile(path.join(vault, configDir, 'plugins/pdf-web-reader', name)));
  await mode(true);
  await root(async () => app.plugins.plugins['pdf-web-reader'].setAutoSaveEnabled(true));
  const pdf = await PDFDocument.create();
  for (let n = 1; n <= 2; n++) { const p = pdf.addPage([420, 540]); p.drawText(`Continuous save fixture ${n}`, { x: 30, y: 480, size: 16 }); }
  const bytes = await pdf.save({ useObjectStreams: false });
  await root(async ({ folder, file, bytes }) => { if (!folder.startsWith('PDF迁移测试/general-0.5.5-save-memory-native-')) throw Error('Unsafe fixture'); await app.vault.createFolder(folder); await app.vault.createBinary(file, new Uint8Array(bytes).buffer); }, { folder, file, bytes: [...bytes] });
  await root(file => {
    const vault = app.vault, adapter = vault.adapter;
    const originalWrite = vault.modifyBinary, originalRead = adapter.read;
    const t = window.__readerSaveMemoryTrace = { writes: [], checkpointReads: [], originalWrite, originalRead };
    vault.modifyBinary = async function(f, bytes) { const started = Date.now(); const result = await originalWrite.call(this, f, bytes); if (f.path === file) t.writes.push({ started, completed: Date.now(), bytes: bytes.byteLength }); return result; };
    adapter.read = async function(p) { if (p.includes('/.sync-checkpoints/')) t.checkpointReads.push(p); return originalRead.call(this, p); };
  }, file);
  await open(); await click('#editorSquareButton');
  await draw(0); await new Promise(r => setTimeout(r, 1200)); await draw(1);
  await new Promise(r => setTimeout(r, 1200)); assert.equal((await trace()).length, 0, 'Must not save between closely spaced edits');
  await wait('first idle save confirmed', async () => { const t = await trace(), s = await state(); return t.length === 1 && !s.dirty && s.revision === s.confirmed; });
  report.checks.coalescedIdle = { state: await state(), writes: await trace() };
  assert.equal((await state()).annotations, 2);
  await draw(2); await new Promise(r => setTimeout(r, 3800));
  assert.equal((await trace()).length, 1, 'Ten-second cooldown must block a second automatic write');
  await draw(3);
  await click('#secondaryToolbarToggleButton'); await click('#secondaryDownload');
  await wait('manual toolbar save bypasses cooldown', async () => { const t = await trace(), s = await state(); return t.length === 2 && !s.dirty && s.revision === s.confirmed; });
  report.checks.manualDuringCooldown = { state: await state(), writes: await trace() };
  assert.equal((await state()).annotations, 4);
  await click('#secondaryToolbarToggleButton');
  await draw(4); await close();
  report.checks.controlledClose = { writes: await trace(), views: await root(() => app.plugins.plugins['pdf-web-reader'].views.size) };
  assert.equal(report.checks.controlledClose.writes.length, 3);
  assert.equal(report.checks.controlledClose.views, 0);
  const checkpointReadsBefore = await root(() => window.__readerSaveMemoryTrace.checkpointReads.length);
  await open();
  const annotations = await doc(async ({ a }) => (await (await a.pdfDocument.getPage(1)).getAnnotations()).filter(e => e.subtype === 'Square').length);
  assert.equal(annotations, 5);
  const readsAfter = await root(() => window.__readerSaveMemoryTrace.checkpointReads.length);
  assert.ok(readsAfter > checkpointReadsBefore, 'Reopen must reload the released sync state from its preserved checkpoint');
  report.checks.reopen = { savedSquares: annotations, checkpointMetadataReads: readsAfter - checkpointReadsBefore, state: await state(), sha256: hash(await fs.readFile(path.join(vault, file))) };
  await close();
  report.status = 'passed';
} catch (error) {
  failure = error; report.status = 'failed'; report.error = { message: error.message, stack: error.stack };
  try { report.failedState = await state(); } catch {}
} finally {
  try {
    await identity(); await close();
    await root(() => { const t = window.__readerSaveMemoryTrace; if (t) { app.vault.modifyBinary = t.originalWrite; app.vault.adapter.read = t.originalRead; delete window.__readerSaveMemoryTrace; } });
    if (original && await root(() => !!app.isMobile) !== original.mobile) await mode(original.mobile);
    if (original) await root(async original => { const p = app.plugins.plugins['pdf-web-reader']; await p.setAutoSaveEnabled(original.autoSave); await p.setStatusBarEnabled(original.showStatusBar); }, original);
    report.cleanup = await root(() => ({ mobile: !!app.isMobile, readers: app.plugins.plugins['pdf-web-reader'].views.size }));
    assert.deepEqual(report.cleanup, { mobile: false, readers: 0 });
  } catch (error) { failure ||= error; report.status = 'failed'; report.cleanupError = error.message; }
  try { await session.send('Emulation.setFocusEmulationEnabled', { enabled: false }); } catch {}
  await browser.disconnect(); report.finishedAt = new Date().toISOString();
  await fs.mkdir('tests/artifacts', { recursive: true });
  const driver = await fs.readFile(import.meta.filename); report.driverSha256 = hash(driver);
  await fs.writeFile(`tests/artifacts/${runId}.driver.mjs`, driver, { flag: 'wx' });
  await fs.writeFile(`tests/artifacts/${runId}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(runId, report.status);
}
if (failure) throw failure;
