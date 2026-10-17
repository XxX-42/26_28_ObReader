import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-launch.mjs';
import { cleanupBrowserTestResources } from './browser-test-cleanup.mjs';
import { resolveBrowserPath } from './browser-path.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const esbuild = require('esbuild');
const puppeteer = require('puppeteer-core');
const css = await readFile(path.join(root, 'plugin/styles.css'), 'utf8');
const bundle = await esbuild.build({ entryPoints: [path.join(root, 'plugin/vocabulary/workbench.cjs')], bundle: true, platform: 'browser', format: 'iife', globalName: 'WorkbenchBundle', write: false });
const executablePath = resolveBrowserPath();
if (!executablePath) throw Error('A supported browser is required; this gate cannot skip.');
const out = path.join(root, 'tests/artifacts/vocabulary-workbench', `run-${Date.now()}-${process.pid}`);
test('Workbench desktop/mobile theme matrix uses bounded DOM and accessible touch controls', { timeout: 90000 }, async () => {
await mkdir(out, { recursive: true });
const browser = await launchTestBrowser(puppeteer, { executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 900 } }, { testName: 'vocabulary-workbench-visual-matrix', artifactsDir: path.join(out, 'launches'), crashpadRoot: path.join(out, 'crashpad') });
let page = null;
let primaryError = null;
let cleanupReport = null;
try {
  page = await browser.newPage();
  const html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;padding:24px;background:var(--background-primary);color:var(--text-normal);font:14px system-ui}.modal{width:min(100%,1000px);margin:auto;padding:20px;background:var(--background-secondary);border:1px solid var(--background-modifier-border);border-radius:14px}button,input,select,textarea{font:inherit;padding:8px;border-radius:6px;border:1px solid var(--background-modifier-border)}button{background:var(--background-secondary);color:var(--text-normal)}body[data-theme="dark"]{--background-primary:#17191d;--background-secondary:#22262c;--text-normal:#e5e7eb;--text-muted:#a8afb9;--text-error:#ff8181;--interactive-accent:#6ba8ff;--text-on-accent:#101418;--background-modifier-border:#454b55;--background-modifier-error:#472a2d;--radius-s:5px;--radius-m:10px;--font-ui-small:12px;--font-ui-smaller:11px}body[data-theme="light"]{--background-primary:#f7f8fa;--background-secondary:#fff;--text-normal:#20242a;--text-muted:#646d79;--text-error:#a02d35;--interactive-accent:#2767bd;--text-on-accent:#fff;--background-modifier-border:#d5d9df;--background-modifier-error:#fae9e9;--radius-s:5px;--radius-m:10px;--font-ui-small:12px;--font-ui-smaller:11px}@media(max-width:700px){body{padding:0}}</style><style>${css.replaceAll('</style>', '<\\/style>')}</style></head><body data-theme="light"><div class="modal"><div id="content"></div></div><script>${bundle.outputFiles[0].text.replaceAll('</script>', '<\\/script>')}</script></body></html>`;
  await page.setContent(html);
  await page.evaluate(() => {
    HTMLElement.prototype.empty = function() { this.replaceChildren(); };
    HTMLElement.prototype.createEl = function(tag, options = {}) { const el = document.createElement(tag); if (options.text) el.textContent = options.text; if (options.cls) el.className = options.cls; for (const [key, value] of Object.entries(options.attr || {})) el.setAttribute(key, value); this.append(el); return el; };
    HTMLElement.prototype.createDiv = function(options = {}) { return this.createEl('div', options); };
    HTMLElement.prototype.addClass = function(name) { this.classList.add(name); };
    HTMLElement.prototype.removeClass = function(name) { this.classList.remove(name); };
    class Modal { constructor() { this.modalEl = document.querySelector('.modal'); this.contentEl = document.querySelector('#content'); } }
    const families = Array.from({length:100},(_,i)=>({familyKey:`en-family:v1:word:["word${i+1}"]`,type:'word',status:i%5+1,records:[{surface:`word${i+1}`,status:i%5+1,translation:i%3===0?'词义翻译':''}]}));
    const api = { async listFamilies(){ return {families,total:100,nextCursor:null}; }, async getFamilyDetails(key){ return {family:families.find(f=>f.familyKey===key),dictionary:{translation:'Dictionary reference',phonetic:'/wɜːd/'}}; }, async updateFamily(){return families[0];}, async setReviewEnrollment(keys){return{results:keys.map(familyKey=>({familyKey,status:'committed'}))};}, async listContexts(){return{contexts:[],total:0};}, async listDueReview(){return{items:[],total:0};}, async listHistory(){return{batches:[]};}, async previewHistory(){return{items:[]};}, async restoreHistory(){return{status:'committed'};}, async exportJson(){return'{}';}, async importJson(){return{};}, async exportCsv(){return'term,status';}, async importCsv(){return{};}, async close(){} };
    const Workbench = WorkbenchBundle.createVocabularyWorkbench({Modal,Notice:class{}});
    window.workbench = new Workbench({},api);
    window.workbench.onOpen();
  });
  await page.waitForSelector('[data-action^="details-"]');
  const matrix = [];
  for (const [name,width,height,theme] of [['desktop1280',1280,900,'light'],['desktop1280',1280,900,'dark'],['ipad768',768,1024,'light'],['ipad768',768,1024,'dark'],['compact390',390,844,'light'],['compact390',390,844,'dark']]) {
    await page.setViewport({width,height,deviceScaleFactor:1});
    await page.evaluate(value=>{document.body.dataset.theme=value;},theme);
    await new Promise(resolve=>setTimeout(resolve,100));
    const file=path.join(out,`${name}-${theme}.png`);
    await page.screenshot({path:file,fullPage:false});
    const metrics=await page.evaluate(({name,theme,file})=>({name,theme,file,viewport:document.documentElement.clientWidth,modal:Math.round(document.querySelector('.modal').getBoundingClientRect().width),panel:Math.round(document.querySelector('.vocabulary-workbench__panel').getBoundingClientRect().height),rows:document.querySelectorAll('[data-action^="details-"]').length,undersizedButtons:[...document.querySelectorAll('.vocabulary-workbench button')].filter(button=>button.getBoundingClientRect().height<44).length}),{name,theme,file});
    assert.equal(metrics.rows, 100);
    assert.equal(metrics.undersizedButtons, 0);
    assert.ok(metrics.modal <= width);
    matrix.push(metrics);
    await page.locator('[data-action="tab-review"]').click();
    await page.waitForFunction(() => document.querySelector('[data-action="tab-review"]')?.getAttribute('aria-selected') === 'true');
    await page.locator('[data-action="tab-vocabulary"]').click();
    await page.waitForSelector('[data-action^="details-"]');
  }
  await writeFile(path.join(out,'matrix.json'),`${JSON.stringify({executablePath,matrix},null,2)}\n`);
  console.log(JSON.stringify({executablePath,matrix},null,2));
} catch (error) {
  primaryError = error;
} finally {
  cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: page ? [page] : [] });
  await writeFile(path.join(out, 'cleanup.json'), `${JSON.stringify(cleanupReport, null, 2)}\n`);
}
if (primaryError) throw primaryError;
if (cleanupReport?.status !== 'normal') throw new Error(`Browser cleanup was not normal: ${JSON.stringify(cleanupReport)}`);

});
