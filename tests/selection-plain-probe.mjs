import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";

const root = path.resolve(import.meta.dirname, "..");
const vendor = path.join(root, "vendor", "pdfjs-generic-legacy");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifacts = path.join(root, "tests", "artifacts");
const diagnosticText = "handle all possible type combinations at runtime. We present an al-";
const sources = [fixture, "web/viewer.html", "web/viewer.mjs", "web/viewer.css", "build/pdf.mjs", "build/pdf.worker.mjs"];
const mime = new Map([[".css", "text/css"], [".ftl", "text/plain"], [".html", "text/html"], [".js", "text/javascript"], [".json", "application/json"], [".mjs", "text/javascript"], [".pdf", "application/pdf"], [".svg", "image/svg+xml"], [".wasm", "application/wasm"]]);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function sourceHashes() { return Object.fromEntries(await Promise.all(sources.map(async name => [name, sha(await readFile(name === fixture ? fixture : path.join(vendor, name)))]))); }
const browserPath = resolveBrowserPath();
assert.ok(browserPath, "Set PDF_READER_CHROME to Chrome or Edge");
await mkdir(artifacts, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const reportPath = path.join(artifacts, `selection-plain-probe-${stamp}.json`);
const logPath = path.join(artifacts, `selection-plain-probe-${stamp}.log`);
const report = { startedAt: new Date().toISOString(), viewport: { width: 424, height: 763, deviceScaleFactor: 1 }, browserPath, sourceHashesBefore: await sourceHashes(), stages: [], console: [], errors: [] };
let browser, page, server, serverListening = false, failure = null, cleanup;
const ownedPages = [];
try {
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/plain.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset="utf-8"><p id="target" style="font:20px Arial,sans-serif">${diagnosticText}</p>`); return; }
    const target = url.pathname === "/fixture.pdf" ? fixture : url.pathname.startsWith("/vendor/") ? path.resolve(vendor, decodeURIComponent(url.pathname.slice(8))) : null;
    if (!target || (target !== fixture && !target.startsWith(`${vendor}${path.sep}`))) { res.writeHead(404).end("not found"); return; }
    try { await access(target); const info = await stat(target); if (!info.isFile()) throw new Error("not a file"); res.writeHead(200, { "content-type": mime.get(path.extname(target)) || "application/octet-stream", "content-length": info.size, "x-content-type-options": "nosniff" }); createReadStream(target).pipe(res); }
    catch { res.writeHead(404).end("not found"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  serverListening = true;
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await launchTestBrowser(puppeteer, { executablePath: browserPath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }, { testName: "selection-plain-probe", artifactsDir: artifacts });
  page = await browser.newPage();
  ownedPages.push(page);
  await page.setViewport(report.viewport);
  page.on("console", msg => report.console.push({ type: msg.type(), text: msg.text().slice(0, 300) }));
  page.on("pageerror", error => report.errors.push({ type: "pageerror", message: error.message }));
  report.diagnostics = { plainHtml: null, pdfScales: [] };
  await page.goto(`${base}/plain.html`, { waitUntil: "domcontentloaded" });
  const plainGeometry = await page.evaluate(() => {
    const e=document.getElementById("target"), range=document.createRange(); range.selectNodeContents(e);
    const rects=[...range.getClientRects()].map(r=>({x:r.x,y:r.y,width:r.width,height:r.height})), first=rects[0], last=rects.at(-1);
    return { text:e.textContent, font:getComputedStyle(e).font, rects,
      from:{x:first.x+1,y:first.y+first.height/2}, to:{x:last.x+last.width-1,y:last.y+last.height/2} };
  });
  await page.mouse.click(plainGeometry.from.x, plainGeometry.from.y);
  const readSelection = async () => page.evaluate(() => { const s=document.getSelection(),r=s?.rangeCount?s.getRangeAt(0):null; return {collapsed:s?.isCollapsed??null,text:s?.toString?.()??"",anchorOffset:s?.anchorOffset??null,focusOffset:s?.focusOffset??null,rects:r?[...r.getClientRects()].slice(0,12).map(x=>({x:x.x,y:x.y,width:x.width,height:x.height})):[]}; });
  const plainCaret = await readSelection(), plainSamples = [];
  await page.mouse.move(plainGeometry.from.x, plainGeometry.from.y); await page.mouse.down({ button: "left" });
  for (let i=1;i<=8;i++) { await page.mouse.move(plainGeometry.from.x+(plainGeometry.to.x-plainGeometry.from.x)*i/8,plainGeometry.from.y+(plainGeometry.to.y-plainGeometry.from.y)*i/8); plainSamples.push(await readSelection()); }
  await page.mouse.up({ button: "left" });
  const plainAfter = await readSelection();
  report.diagnostics.plainHtml = { url:`${base}/plain.html`, geometry:plainGeometry, caret:plainCaret, samples:plainSamples, after:plainAfter, hasListeners:false };
  if (!plainAfter.collapsed && plainAfter.text.length > 0) {
  const url = `${base}/vendor/web/viewer.html?file=${encodeURIComponent(`${base}/fixture.pdf`)}#page=1&zoom=page-fit`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.PDFViewerApplication?.pdfDocument), { timeout: 45_000 });
  await page.waitForSelector('.page[data-page-number="1"] .textLayer span', { timeout: 45_000 });
  await page.evaluate(() => document.fonts?.ready.then(() => true));
  const target = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(e => e.textContent.trim().length > 35 && e.getBoundingClientRect().width > 100);
    const e = spans[5]; if (!e) throw new Error("Native-equivalent filtered span index 5 missing");
    const r = e.getBoundingClientRect(), s = getComputedStyle(e), layer = e.closest(".textLayer"), end = layer.querySelector(".endOfContent"), er = end.getBoundingClientRect();
    return { index: 5, text: e.textContent.slice(0, 180), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, fontSize: s.fontSize, userSelect: s.userSelect, layerUserSelect: getComputedStyle(layer).userSelect, scale: PDFViewerApplication.pdfViewer.currentScaleValue, devicePixelRatio, endOfContent: { rect: { x: er.x, y: er.y, width: er.width, height: er.height }, top: getComputedStyle(end).top, zIndex: getComputedStyle(end).zIndex }, from: { x: r.x + 2, y: r.y + r.height / 2 }, to: { x: r.right - 2, y: r.y + r.height / 2 } };
  });
  report.target = target;
  const installTrace = async targetPage => targetPage.evaluate(() => {
    const trace = window.__plainSelectionProbe = { events: [], selectionChanges: [], consumers: [] }, d = document, app = PDFViewerApplication;
    const snap = () => { const s = d.getSelection(), r = s?.rangeCount ? s.getRangeAt(0) : null; return { collapsed: s?.isCollapsed ?? null, text: s?.toString?.().slice(0, 240) ?? "", anchorTag: s?.anchorNode?.parentElement?.tagName ?? s?.anchorNode?.nodeName ?? null, anchorOffset: s?.anchorOffset ?? null, focusTag: s?.focusNode?.parentElement?.tagName ?? s?.focusNode?.nodeName ?? null, focusOffset: s?.focusOffset ?? null, rects: r ? [...r.getClientRects()].slice(0, 12).map(x => ({ x:x.x,y:x.y,width:x.width,height:x.height })) : [] }; };
    for (const type of ["pointerdown","pointermove","pointerup","mousedown","mousemove","mouseup","selectstart"]) for (const capture of [true,false]) d.addEventListener(type, e => { if (trace.events.length < 500) trace.events.push({ type, capture, trusted:e.isTrusted, button:e.button, buttons:e.buttons, target:e.target?.tagName, className:typeof e.target?.className === "string" ? e.target.className.slice(0,80) : "", defaultPrevented:e.defaultPrevented, selection:snap() }); }, capture);
    d.addEventListener("selectionchange", () => { if (trace.selectionChanges.length < 200) trace.selectionChanges.push({ at:performance.now(), mode:app.pdfViewer.annotationEditorMode, selection:snap() }); }, true);
    const manager = app.pdfViewer._layerProperties.annotationEditorUIManager, original = manager.highlightSelection;
    manager.highlightSelection = function (...args) { trace.consumers.push({ method:"highlightSelection", mode:app.pdfViewer.annotationEditorMode, args, selection:snap() }); return original.apply(this,args); };
  });
  await installTrace(page);
  const snapshot = async name => { await page.waitForFunction(() => true); await new Promise(resolve => setTimeout(resolve, 80)); report.stages.push(await page.evaluate(stage => { const s=document.getSelection(),r=s?.rangeCount?s.getRangeAt(0):null,trace=window.__plainSelectionProbe; return { stage, mode:PDFViewerApplication.pdfViewer.annotationEditorMode, currentScale:PDFViewerApplication.pdfViewer.currentScaleValue, selection:{collapsed:s?.isCollapsed??null,text:s?.toString?.().slice(0,240)??"",anchorOffset:s?.anchorOffset??null,focusOffset:s?.focusOffset??null,rangeRects:r?[...r.getClientRects()].slice(0,12).map(x=>({x:x.x,y:x.y,width:x.width,height:x.height})):[]}, editors:document.querySelectorAll(".annotationEditorLayer > div[id]").length, eventCount:trace.events.length, selectionChangeCount:trace.selectionChanges.length, consumerCount:trace.consumers.length }; }, name)); };
  await page.mouse.click(target.from.x, target.from.y); await snapshot("caret-mode0");
  const drag = async () => { await page.mouse.move(target.from.x, target.from.y); await page.mouse.down({ button: "left" }); for (let i=1;i<=8;i++) await page.mouse.move(target.from.x+(target.to.x-target.from.x)*i/8,target.from.y+(target.to.y-target.from.y)*i/8); await page.mouse.up({ button: "left" }); };
  await drag(); await snapshot("drag-mode0");
  await page.waitForFunction(() => { const b=document.getElementById("editorUnderlineButton"); return b && !b.disabled; });
  await page.click("#editorUnderlineButton");
  await page.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 10);
  await snapshot("underline-mode10-before-drag");
  await drag(); await snapshot("drag-mode10");
  for (const scale of [1, 1.5]) {
    const scalePage = await browser.newPage(); ownedPages.push(scalePage); await scalePage.setViewport(report.viewport);
    scalePage.on("console",msg=>report.console.push({type:msg.type(),text:msg.text().slice(0,300)}));
    scalePage.on("pageerror",error=>report.errors.push({type:"pageerror",message:error.message}));
    await scalePage.goto(url,{waitUntil:"domcontentloaded"});
    await scalePage.waitForFunction(()=>Boolean(window.PDFViewerApplication?.pdfDocument),{timeout:45_000});
    await scalePage.waitForSelector('.page[data-page-number="1"] .textLayer span',{timeout:45_000});
    await scalePage.evaluate(()=>document.fonts?.ready.then(()=>true));
    await scalePage.evaluate(value=>{PDFViewerApplication.pdfViewer.currentScaleValue=String(value);},scale);
    await scalePage.waitForFunction(value=>Math.abs(PDFViewerApplication.pdfViewer.currentScale-value)<0.01,{},scale);
    await scalePage.evaluate(()=>new Promise(resolve=>setTimeout(resolve,300)));
    await scalePage.waitForFunction(()=>{const b=document.getElementById("editorUnderlineButton");return b&&!b.disabled;});
    await scalePage.click("#editorUnderlineButton");
    await scalePage.waitForFunction(()=>PDFViewerApplication.pdfViewer.annotationEditorMode===10);
    await installTrace(scalePage);
    const scaledTarget = await scalePage.evaluate(() => {
      const spans=[...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(e=>e.textContent.trim().length>35&&e.getBoundingClientRect().width>100),e=spans[5];
      if(!e) return null;
      const r=e.getBoundingClientRect(),v=document.getElementById("viewerContainer"),before=v.scrollLeft,topBefore=v.scrollTop;
      if(r.x>24&&v.scrollWidth>v.clientWidth) v.scrollLeft+=r.x-24;
      let q=e.getBoundingClientRect();
      if(q.y>innerHeight-80) v.scrollTop+=q.y-(innerHeight-80); else if(q.y<80) v.scrollTop=Math.max(0,v.scrollTop-(80-q.y));
      q=e.getBoundingClientRect();
      const left=Math.max(2,q.x+2),right=Math.min(innerWidth-2,q.right-2),y=q.y+q.height/2;
      return {text:e.textContent.slice(0,180),rect:{x:q.x,y:q.y,width:q.width,height:q.height},fontSize:getComputedStyle(e).fontSize,scale:PDFViewerApplication.pdfViewer.currentScale,viewport:{width:innerWidth,height:innerHeight},scrollLeftBefore:before,scrollLeftAfter:v.scrollLeft,scrollTopBefore:topBefore,scrollTopAfter:v.scrollTop,from:{x:left,y},to:{x:right,y},visibleFraction:Math.max(0,right-left)/q.width};
    });
    if (!scaledTarget || scaledTarget.to.x<=scaledTarget.from.x+8 || scaledTarget.from.y<0 || scaledTarget.from.y>=report.viewport.height) { report.diagnostics.pdfScales.push({scale,skipped:true,target:scaledTarget,reason:"same span has insufficient visible extent"}); continue; }
    await scalePage.mouse.move(scaledTarget.from.x,scaledTarget.from.y); await scalePage.mouse.down({button:"left"}); const samples=[];
    for(let i=1;i<=8;i++){await scalePage.mouse.move(scaledTarget.from.x+(scaledTarget.to.x-scaledTarget.from.x)*i/8,scaledTarget.from.y);samples.push(await scalePage.evaluate(()=>{const s=document.getSelection();return{collapsed:s?.isCollapsed??null,text:s?.toString?.()??"",anchorOffset:s?.anchorOffset??null,focusOffset:s?.focusOffset??null};}));}
    await scalePage.mouse.up({button:"left"}); await scalePage.evaluate(()=>new Promise(resolve=>setTimeout(resolve,80)));
    const after=await scalePage.evaluate(()=>{const s=document.getSelection();return{collapsed:s?.isCollapsed??null,text:s?.toString?.()??"",anchorOffset:s?.anchorOffset??null,focusOffset:s?.focusOffset??null,editors:document.querySelectorAll(".annotationEditorLayer > div[id]").length};});
    report.diagnostics.pdfScales.push({scale,target:scaledTarget,samples,after,trace:await scalePage.evaluate(()=>window.__plainSelectionProbe)});
  }
  report.trace = await page.evaluate(() => window.__plainSelectionProbe);
  }
} catch (error) { failure = error; report.failure = { name:error?.name || "Error", message:error?.message || String(error), stack:error?.stack || null }; }
finally {
  cleanup = await cleanupBrowserTestResources({ browser, ownedPages, server: serverListening ? server : undefined });
  report.cleanup = cleanup;
  report.sourceHashesAfter = await sourceHashes().catch(error => ({ error:error.message }));
  await writeFile(reportPath, `${JSON.stringify(report,null,2)}\n`, "utf8");
  await writeFile(logPath, `${JSON.stringify({ diagnostics:report.diagnostics, stages:report.stages, target:report.target, trace:report.trace, console:report.console, errors:report.errors, failure:report.failure, cleanup:report.cleanup },null,2)}\n`, "utf8");
}
console.log(JSON.stringify({ reportPath, logPath, plain:report.diagnostics?.plainHtml?.after, pdfScales:report.diagnostics?.pdfScales?.map(({scale,skipped,after})=>({scale,skipped,collapsed:after?.collapsed,text:after?.text})), stages:report.stages.map(({stage,mode,selection,consumerCount})=>({stage,mode,collapsed:selection?.collapsed,text:selection?.text,consumerCount})), cleanup:report.cleanup?.status, failure:report.failure || null }));
if (failure || cleanup?.status !== "normal") process.exitCode = 1;
