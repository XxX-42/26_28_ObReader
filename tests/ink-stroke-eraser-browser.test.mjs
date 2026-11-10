import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources } from "./browser-test-cleanup.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const root = path.resolve(import.meta.dirname, "..");

function isWithinDirectory(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

test("stroke eraser preserves unhit Ink paths, UUID, undo and JSONL update", { timeout: 90_000 }, async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 400]);
  const ctx = pdf.context;
  const inkRef=ctx.register(ctx.obj({Type:"Annot",Subtype:"Ink",Rect:[18,348,102,372],InkList:[[20,350,100,350],[20,370,100,370]],C:[0,0,1],BS:{W:2}}));
  page.node.addAnnot(inkRef);
  const bytes = Buffer.from(await pdf.save());
  const originalHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const documentId = "native-erase-routing-browser";
  const seedRows = [{uuid:"external-ink",kind:"Ink",pageIndex:0,embeddedRef:null,deleted:false,provenance:"external",clock:{timestamp:11,logical:1,deviceId:"test",opId:"ink"},payload:{editor:{annotationType:15,pageIndex:0,rect:[60,80,240,320],rotation:0,color:[0,0,0],opacity:1,thickness:2,paths:{lines:[[null,null,null,null,60,320,null,null,null,null,240,320],[null,null,null,null,60,200,100,280,200,280,240,200],[null,null,null,null,60,80,null,null,null,null,240,80]],points:[[60,320,240,320],[60,200,150,260,240,200],[60,80,240,80]]}}}}];
  const bridge = await readBridgeRuntimeSource();
  const vendor = path.join(root, "vendor/pdfjs-generic-legacy");
  const viewerHtml = (await readFile(path.join(vendor, "web/viewer.html"), "utf8")).replace(
    '<script src="viewer.mjs" type="module"></script>',
    '<link rel="stylesheet" href="/bridge.css"><script src="/bridge.js" data-channel="pdf-web-reader" data-token="native-erase-routing"></script><script src="viewer.mjs" type="module"></script>',
  );
  const hostHtml = `<!doctype html><style>body{margin:0}iframe{width:900px;height:740px;border:0}</style><iframe id="reader" src="/pdfjs/web/viewer.html?file="></iframe><script>
    const frame=document.getElementById('reader');const rows=new Map(${JSON.stringify(seedRows)}.map(row=>[row.uuid,row]));let identity=null;let sequence=0;
    window.host={rows,errors:[],saves:[],opened:0,sourceWrites:0};
    const snapshot=()=>({schemaVersion:1,kind:'pdf-annotation-snapshot',documentId:${JSON.stringify(documentId)},revision:0,legacyIdentities:[{uuid:"native-ink",kind:"Ink",pageIndex:0,ref:${JSON.stringify(`${inkRef.objectNumber}R`)}}],source:identity&&{sourceHash:'xxh64-v1:native-erase-test',pageCount:identity.pageCount,orderedPageIdentities:identity.orderedPageIdentities},annotations:[...rows.values()],tombstones:[]});
    const send=data=>frame.contentWindow.postMessage({channel:'pdf-web-reader',token:'native-erase-routing',documentId:${JSON.stringify(documentId)},openRequest:sequence,...data},'*');
    window.reopen=async()=>{sequence++;send({type:'open',data:await fetch('/source.pdf').then(r=>r.arrayBuffer()),filename:'native-erase-routing.pdf',autoSave:true,sourceHashConfirmed:!!identity,externalAnnotations:identity?snapshot():null});};
    addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const m=event.data;if(m?.token!=='native-erase-routing')return;
      if(m.type==='ready'&&!sequence)void reopen();
      if(m.type==='opened')host.opened++;
      if(m.type==='annotation-source-identity'){identity=m;send({type:'external-annotations-update',identityConfirmed:true,sourceMatch:'MATCH',externalAnnotations:snapshot()});}
      if(m.type==='save'){for(const o of m.operations||[]){rows.set(o.uuid,{...o,payload:o.payload||{editor:o.serialized},clock:{timestamp:o.timestamp||0,logical:o.logical||0,deviceId:o.deviceId||o.actorId||'test',opId:o.operationId||'test'}});}host.saves.push({revision:m.revision,operations:m.operations||[]});send({type:'saved',external:true,requestId:m.requestId,revision:m.revision,operationCount:(m.operations||[]).length,batchId:'routing-test'});}
      if(m.type==='error')host.errors.push({message:m.message,code:m.code});
    });
  </script>`;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (pathname === "/") { res.setHeader("Content-Type", "text/html"); return res.end(hostHtml); }
      if (pathname === "/source.pdf") { res.setHeader("Content-Type", "application/pdf"); return res.end(bytes); }
      if (pathname === "/pdfjs/web/viewer.html") { res.setHeader("Content-Type", "text/html"); return res.end(viewerHtml); }
      if (pathname === "/bridge.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(bridge); }
      if (pathname === "/bridge.css") { res.setHeader("Content-Type", "text/css"); return res.end(await readFile(path.join(root, "viewer-adapter/bridge.css"))); }
      const relative = pathname.startsWith("/pdfjs/") ? pathname.slice(7) : pathname.startsWith("/build/") ? pathname.slice(1) : `web${pathname}`;
      const target = path.resolve(vendor, relative);
      if (!isWithinDirectory(vendor, target)) throw new Error("path");
      const ext = path.extname(target);
      res.setHeader("Content-Type", ({ ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".ftl": "text/plain", ".svg": "image/svg+xml" })[ext] || "application/octet-stream");
      res.end(await readFile(target));
    } catch { res.statusCode = 404; res.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    browser = await launchTestBrowser(puppeteer, { executablePath: resolveBrowserPath(), headless: true, args: ["--no-sandbox"] }, { testName: "native-erase-routing" });
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: 1 });
    const pageErrors=[];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => { if (message.type() === "error") console.log("CONSOLE_ERROR", message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => host.opened === 1);
    const viewer = page.frames().find(frame => frame.url().includes("/pdfjs/web/viewer.html"));
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.getPageView(0)?.renderingState === 3 &&
      !document.documentElement.hasAttribute("data-pdf-reader-readonly"));
    await new Promise(resolve => setTimeout(resolve, 600));
    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {source:window, mode:17}));
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.annotationEditorMode===17);
    await viewer.waitForFunction(() => [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].some(e => e.editorType === "ink"));
    const inspect = () => viewer.evaluate(() => {
      const es=[...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].filter(e=>e.editorType==="ink"&&!e.annotationElementId);
      return es.map(e=>({id:e.id, paths:e.serialize()?.paths, deleted:e.deleted}));
    });
    const clickPdf = async (x,y,button="left") => {
      const p=await viewer.evaluate(([x,y])=>{const pv=PDFViewerApplication.pdfViewer.getPageView(0);const p=pv.viewport.convertToViewportPoint(x,y); const r=pv.div.getBoundingClientRect();return {x:r.x+p[0],y:r.y+p[1]};},[x,y]);
      await page.mouse.click(p.x,p.y,{button});
    };
    const initial=await inspect(); assert.equal(initial[0].paths.points.length,3);
    const curve = await viewer.evaluate(()=>{const e=[...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].find(e=>e.editorType==="ink"&&!e.annotationElementId); const l=e.serializeDraw(false).lines[1];return {x:(l[4]+3*l[6]+3*l[8]+l[10])/8,y:(l[5]+3*l[7]+3*l[9]+l[11])/8};});
    await clickPdf(curve.x,curve.y-40); // inside editor bounds, away from the actual curve
    assert.equal((await inspect())[0]?.paths.points.length,3,"empty curve interior must not erase an InkEditor");
    await clickPdf(curve.x,curve.y);
    const reduced=await inspect();
    assert.equal(reduced.length,1); assert.equal(reduced[0].id,initial[0].id);
    assert.equal(reduced[0].paths.points.length,2,"only the hit curved stroke is erased");
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo());
    assert.equal((await inspect())[0].paths.points.length,3);
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.redo());
    assert.equal((await inspect())[0].paths.points.length,2);
    await page.waitForFunction(()=>host.saves.flatMap(s=>s.operations).some(o=>o.uuid==="external-ink"));
    const ops=await page.evaluate(()=>host.saves.flatMap(s=>s.operations));
    assert.ok(ops.filter(o=>o.uuid==="external-ink").every(o=>!o.deleted));
    // The same pointer gesture can remove another stroke from the same
    // object, and its one undo restores both strokes, including last-stroke removal.
    const endpoints = await viewer.evaluate(()=>{const e=[...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].find(e=>e.editorType==="ink"&&!e.annotationElementId);const pv=PDFViewerApplication.pdfViewer.getPageView(0);const r=pv.div.getBoundingClientRect();return e.serializeDraw(false).points.map(p=>{const v=pv.viewport.convertToViewportPoint((p[0]+p[2])/2,(p[1]+p[3])/2);return {x:r.x+v[0],y:r.y+v[1]};});});
    await page.mouse.move(endpoints[0].x,endpoints[0].y);await page.mouse.down();
    await page.mouse.move(endpoints[1].x,endpoints[1].y,{steps:10});await page.mouse.up();
    assert.equal((await inspect()).length,0,"last stroke uses normal editor removal");
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo());
    assert.equal((await inspect())[0].paths.points.length,2,"one undo restores all strokes erased from this object in a gesture");
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.redo());
    assert.equal((await inspect()).length,0);
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo());
    await page.waitForFunction(()=>host.saves.length>=2);
    await new Promise(r=>setTimeout(r,900));
    const saveCount=await page.evaluate(()=>host.saves.length);
    await page.evaluate(()=>reopen());await page.waitForFunction(()=>host.opened>=2);
    await new Promise(r=>setTimeout(r,600));
    assert.equal((await inspect())[0].paths.points.length,2,"reopen must not resurrect the removed curved stroke");
    assert.equal(await page.evaluate(()=>host.saves.length),saveCount,"hydrating saved Ink must not generate a new operation");
    assert.ok(await page.evaluate(()=>host.saves.flatMap(s=>s.operations).some(o=>o.uuid==="external-ink"&&!o.deleted&&o.payload?.editor)),"normal same-UUID payload update is durable");
    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {source:window, mode:17}));
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.annotationEditorMode===17);
    const nativeBefore = await viewer.evaluate(()=>{const e=[...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].find(e=>e.editorType==="ink"&&e.annotationElementId);return {id:e.id,ref:e.annotationElementId,unchanged:e.serialize()===null};});
    assert.equal(nativeBefore.unchanged,true);
    await clickPdf(60,370);
    const nativeAfter=await viewer.evaluate(id=>{const e=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditor(id);const s=e.serialize();return {ref:e.annotationElementId,count:s?.paths?.points.length};},nativeBefore.id);
    assert.equal(nativeAfter.ref,nativeBefore.ref);assert.equal(nativeAfter.count,1,"native Ink path edits must serialize even without color/position changes");
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo());
    assert.equal(await viewer.evaluate(id=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditor(id).serialize()?.paths?.points.length,nativeBefore.id),2,"undo must serialize the original paths explicitly for external persistence");
    await page.evaluate(()=>send({type:"flush",requestId:"native-original-undo-save"}));
    await page.waitForFunction(()=>host.rows.get("native-ink")?.payload?.editor?.paths?.points?.length===2);
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.redo());
    await page.evaluate(()=>send({type:"flush",requestId:"native-stroke-save"}));
    await page.waitForFunction(()=>host.saves.flatMap(s=>s.operations).some(o=>o.uuid==="native-ink"&&o.kind==="Ink"&&o.provenance==="embedded"&&!o.deleted));
    // Right-drag uses the same stroke eraser and restores the previous tool.
    await viewer.evaluate(()=>PDFViewerApplication.eventBus.dispatch("switchannotationeditormode",{source:window,mode:0}));
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.annotationEditorMode===0);
    await clickPdf(60,350,"right"); // a click remains a context menu, not erasing
    assert.equal(await viewer.evaluate(id=>!!PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditor(id),nativeBefore.id),true);
    await page.keyboard.press("Escape");
    const rp=await viewer.evaluate(()=>{const p=PDFViewerApplication.pdfViewer.getPageView(0);const v=p.viewport.convertToViewportPoint(60,350);const r=p.div.getBoundingClientRect();return {x:r.x+v[0],y:r.y+v[1]};});
    await page.mouse.move(rp.x-8,rp.y);await page.mouse.down({button:"right"});await page.mouse.move(rp.x+8,rp.y,{steps:4});await page.mouse.up({button:"right"});
    await viewer.waitForFunction(id=>!PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditor(id),{},nativeBefore.id);
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.annotationEditorMode===0);
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo());
    assert.equal(await viewer.evaluate(id=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditor(id).serializeDraw(false).points.length,nativeBefore.id),1);
    await page.evaluate(()=>send({type:"flush",requestId:"native-undo-save"}));
    await page.waitForFunction(()=>host.rows.get("native-ink")?.deleted===false && host.rows.get("native-ink")?.payload?.editor?.paths?.points?.length===1);
    await viewer.waitForFunction(()=>!PDFViewerApplication._hasChanges());
    await page.evaluate(()=>reopen());await page.waitForFunction(()=>host.opened>=3);
    await new Promise(r=>setTimeout(r,600));
    await viewer.evaluate(()=>PDFViewerApplication.eventBus.dispatch("switchannotationeditormode",{source:window,mode:17}));
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.annotationEditorMode===17);
    const twins=await viewer.evaluate(()=>{const m=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;return [...m.getEditors(0)].filter(e=>e.editorType==="ink"&&e.annotationElementId).map(e=>({hidden:e.div.hidden,raw:e.serializeDraw(false).points.length,effective:m.resolveInkEraserEditor(e)?.serializeDraw(false).points.length,shared:m.resolveInkEraserEditor(e)===e}));});
    assert.ok(twins.length>0,"tool switching recreates a source Ink editor beside the external replacement");
    assert.ok(twins.every(t=>t.hidden && t.raw===2 && t.effective===1 && !t.shared),"stale source paths must be hidden and erasing must resolve the current durable replacement");
    // Editing the hydrated replacement must retain the native-source binding.
    await clickPdf(60,350);
    await page.evaluate(()=>send({type:"flush",requestId:"erase-effective-last"}));
    await page.waitForFunction(()=>host.rows.get("native-ink")?.deleted===true);
    assert.equal(await page.evaluate(()=>host.rows.get("native-ink").embeddedRef), `${inkRef.objectNumber}R`);

    assert.equal(await page.evaluate(()=>host.rows.get("native-ink").provenance),"embedded","last-stroke tombstone must keep native-source provenance");
    await viewer.waitForFunction(()=>!PDFViewerApplication._hasChanges());
    await page.evaluate(()=>reopen());await page.waitForFunction(()=>host.opened>=4);
    await new Promise(r=>setTimeout(r,600));
    await viewer.evaluate(()=>PDFViewerApplication.eventBus.dispatch("switchannotationeditormode",{source:window,mode:17}));
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.annotationEditorMode===17);
    assert.equal(await viewer.evaluate(()=>[...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].filter(e=>e.editorType==="ink"&&e.annotationElementId&&!e.div.hidden).length),0,"last-stroke deletion must mask the original source Ink after reopen");
    assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),originalHash);
    assert.deepEqual(await page.evaluate(()=>host.errors),[]);
    assert.deepEqual(pageErrors,[],"editor cleanup and native Ink layer updates must not throw");
  } finally {
    await cleanupBrowserTestResources({ browser, ownedPages: browser ? await browser.pages() : [], server });
  }
});
