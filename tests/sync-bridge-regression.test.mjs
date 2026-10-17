import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from "pdf-lib";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";
import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const require = createRequire(import.meta.url);
const { inspect } = require("../plugin/pdf-merge-core.cjs");
const browserPath = resolveBrowserPath();
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const viewerHtmlPath = path.join(
  root,
  "vendor",
  "pdfjs-generic-legacy",
  "web",
  "viewer.html",
);
const artifactsPath = path.join(root, "tests", "artifacts");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

async function makeWriterOrderFixture() {
  const doc = await PDFDocument.create();
  const pages = [];
  for (let index = 0; index < 12; index += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`PDF.js annotation writer fixture page ${index + 1}`, {
      x: 36,
      y: 744,
      size: 14,
    });
    pages.push(page);
  }

  // Page 10 deliberately starts with a supported annotation and its popup.
  // The writer must preserve these refs while adding new annotations after
  // them; this reproduces the real document shape involved in the iPad report.
  const page = pages[9];
  const annots = PDFArray.withContext(doc.context);
  page.node.set(PDFName.of("Annots"), annots);
  const square = PDFDict.withContext(doc.context);
  square.set(PDFName.of("Type"), PDFName.of("Annot"));
  square.set(PDFName.of("Subtype"), PDFName.of("Square"));
  const rect = PDFArray.withContext(doc.context);
  for (const value of [72, 160, 190, 250]) rect.push(PDFNumber.of(value));
  square.set(PDFName.of("Rect"), rect);
  square.set(PDFName.of("NM"), PDFHexString.fromText("page-ten-existing-square"));
  square.set(PDFName.of("Contents"), PDFHexString.fromText("Existing page 10 annotation"));
  square.set(PDFName.of("P"), page.ref);
  const squareRef = doc.context.register(square);
  annots.push(squareRef);

  const popup = PDFDict.withContext(doc.context);
  popup.set(PDFName.of("Type"), PDFName.of("Annot"));
  popup.set(PDFName.of("Subtype"), PDFName.of("Popup"));
  const popupRect = PDFArray.withContext(doc.context);
  for (const value of [200, 160, 330, 280]) popupRect.push(PDFNumber.of(value));
  popup.set(PDFName.of("Rect"), popupRect);
  popup.set(PDFName.of("Parent"), squareRef);
  popup.set(PDFName.of("P"), page.ref);
  const popupRef = doc.context.register(popup);
  square.set(PDFName.of("Popup"), popupRef);
  annots.push(popupRef);

  const addBaseInk = (nm, contents, { freehandHighlight = false } = {}) => {
    const ink = PDFDict.withContext(doc.context);
    ink.set(PDFName.of("Type"), PDFName.of("Annot"));
    ink.set(PDFName.of("Subtype"), PDFName.of("Ink"));
    const inkRect = PDFArray.withContext(doc.context);
    for (const value of [220, 320, 360, 400]) inkRect.push(PDFNumber.of(value));
    ink.set(PDFName.of("Rect"), inkRect);
    ink.set(PDFName.of("NM"), PDFHexString.fromText(nm));
    ink.set(PDFName.of("Contents"), PDFHexString.fromText(contents));
    ink.set(PDFName.of("P"), page.ref);
    if (freehandHighlight) ink.set(PDFName.of("IT"), PDFName.of("InkHighlight"));
    const inkList = PDFArray.withContext(doc.context);
    const path = PDFArray.withContext(doc.context);
    for (const value of [220, 325, 255, 350, 295, 375, 350, 395]) path.push(PDFNumber.of(value));
    inkList.push(path);
    ink.set(PDFName.of("InkList"), inkList);
    annots.push(doc.context.register(ink));
  };
  addBaseInk("page-ten-existing-ink", "Existing page 10 Ink");
  addBaseInk("page-ten-existing-freehand-highlight", "Existing page 10 freehand Highlight", {
    freehandHighlight: true,
  });

  const underline = PDFDict.withContext(doc.context);
  underline.set(PDFName.of("Type"), PDFName.of("Annot"));
  underline.set(PDFName.of("Subtype"), PDFName.of("Underline"));
  const underlineRect = PDFArray.withContext(doc.context);
  for (const value of [72, 420, 200, 444]) underlineRect.push(PDFNumber.of(value));
  underline.set(PDFName.of("Rect"), underlineRect);
  underline.set(PDFName.of("NM"), PDFHexString.fromText("page-ten-existing-underline"));
  underline.set(PDFName.of("Contents"), PDFHexString.fromText("Existing page 10 Underline"));
  underline.set(PDFName.of("P"), page.ref);
  const quadPoints = PDFArray.withContext(doc.context);
  for (const value of [72, 444, 200, 444, 72, 420, 200, 420]) quadPoints.push(PDFNumber.of(value));
  underline.set(PDFName.of("QuadPoints"), quadPoints);
  annots.push(doc.context.register(underline));

  // Native editors require a visible stroke color; absent /C means an
  // invisible PDF annotation and is not a drawable-editor fixture.
  for (const ref of annots.asArray()) {
    const annotation = doc.context.lookup(ref, PDFDict);
    if (annotation.get(PDFName.of("Subtype"))?.toString() === "/Popup") continue;
    annotation.set(PDFName.of("C"), doc.context.obj([0, 0, 0]));
  }
  return doc.save({ useObjectStreams: false });
}

// Ordinary sync checkpoints are annotation operations, never PDF rewrites.
// Binary writer validation below is reachable only through explicit export-copy.
test("sync bridge durably acknowledges UUID operations, rejects binary apply, and reopens tombstones", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 120_000,
}, async () => {
  const channel = "pdf-web-reader", token = `sync-${Date.now()}`;
  const rendererGeneration = "sync-operation-renderer", documentId = "sync-operation-document";
  const bytes = await makeWriterOrderFixture();
  const sourceHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const baseInspection = await inspect({bytes});
  for (const kind of ["square", "ink", "highlight", "underline"]) {
    assert.equal(baseInspection.identities.filter(row => row.pageIndex === 9 && row.kind === kind).length, 1);
  }
  const rawBridge = await readBridgeRuntimeSource(bridgePath);
  const bridge = rawBridge.replace("  if (iosInputPolicy) {", "  window.__syncBridgeState = state;\n  if (iosInputPolicy) {");
  assert.notEqual(bridge, rawBridge);
  const css = await readFile(path.join(root,"viewer-adapter/bridge.css"),"utf8");
  const html = (await readFile(viewerHtmlPath,"utf8")).replace(/<head\b[^>]*>/i,
    head => `${head}<link rel="stylesheet" href="/bridge.css"><script src="/bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}"></script>`);
  const server = createServer(async (request,response) => {
    for (const [key,value] of Object.entries(withTestNetworkFirewall())) response.setHeader(key,value);
    const url = new URL(request.url,"http://127.0.0.1");
    const send = (type,value) => {response.writeHead(200,{"content-type":type});response.end(value);};
    if(url.pathname === "/") return send("text/html", `<!doctype html><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden}</style>
      <iframe src="/viewer/web/viewer.html"></iframe>
      ${browserSidecarHarnessScript({channel,token,sourceHash})}
      <script>
      const config=${JSON.stringify({channel,token,rendererGeneration,documentId})};
      const frame=document.querySelector('iframe');
      const host=window.__syncHost={opened:[],messages:[],holdAck:false,pendingAck:null,openRequest:0};
      host.send=message=>frame.contentWindow.postMessage({...config,openRequest:host.openRequest,...message},'*');
      host.open=async()=>{const data=await fetch('/source.pdf').then(r=>r.arrayBuffer());host.openRequest++;host.send({type:'open',filename:'writer.pdf',autoSave:false,readOnly:false,data,sourceHash:${JSON.stringify(sourceHash)}});};
      host.ack=message=>host.send({type:message.type==='recover'?'recovered':'saved',requestId:message.requestId,revision:message.revision,ok:true,external:true,batchId:'durable-'+message.requestId,operationCount:message.operations.length});
      window.addEventListener('message',event=>{
        const m=event.data;
        if(event.source!==frame.contentWindow||m?.channel!==config.channel||m?.token!==config.token)return;
        host.messages.push(m);
        if(m.type==='ready')host.open();
        if(m.type==='opened')host.opened.push(m);
        if(m.type==='save'||m.type==='recover'){
          if(host.holdAck)host.pendingAck=m;else host.ack(m);
        }
      });
      </script>`);
    if(url.pathname === "/bridge.js") return send("text/javascript",bridge);
    if(url.pathname === "/bridge.css") return send("text/css",css);
    if(url.pathname === "/source.pdf") return send("application/pdf",bytes);
    if(url.pathname === "/viewer/web/viewer.html") return send("text/html",html);
    let target;
    if(url.pathname.startsWith("/viewer/")) target=path.resolve(root,"vendor/pdfjs-generic-legacy",url.pathname.slice(8));
    else if(url.pathname.startsWith("/build/")) target=path.resolve(root,"vendor/pdfjs-generic-legacy",url.pathname.slice(1));
    if(!target?.startsWith(path.join(root,"vendor/pdfjs-generic-legacy")+path.sep))return response.writeHead(404).end();
    try {const info=await stat(target);response.writeHead(200,{"content-type":mimeTypes.get(path.extname(target))||"application/octet-stream","content-length":info.size});createReadStream(target).pipe(response);}
    catch {response.writeHead(404).end();}
  });
  let browser,page,primaryError,cleanupReport; const browserErrors=[];
  try {
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    browser=await launchTestBrowser(puppeteer,{executablePath:browserPath,headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]},{testName:"sync-bridge-regression",artifactsDir:artifactsPath});
    page=await browser.newPage();page.on('pageerror',error=>browserErrors.push(error.stack));await page.setViewport({width:1280,height:900});
    await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:"domcontentloaded"});
    await page.waitForFunction(()=>window.__syncHost.opened.length===1,{timeout:30_000});
    const viewer=page.frames().find(f=>f.url().includes('/viewer/web/viewer.html'));
    const ready=async()=>viewer.waitForFunction(()=>window.__syncBridgeState?.externalSourceConfirmed && !document.getElementById('editorSquareButton').disabled,{timeout:30_000});
    await ready();
    await viewer.evaluate(()=>{
      const app=PDFViewerApplication;window.__originalDoc=app.pdfDocument;window.__binarySaves=0;window.__closes=0;
      const save=app.pdfDocument.saveDocument.bind(app.pdfDocument);app.pdfDocument.saveDocument=(...args)=>{window.__binarySaves++;return save(...args);};
      const close=app.close.bind(app);app.close=(...args)=>{window.__closes++;return close(...args);};
    });
    const send=async message=>page.evaluate(m=>window.__syncHost.send(m),message);
    const response=async(type,id)=>{
      await page.waitForFunction((type,id)=>window.__syncHost.messages.some(m=>m.type===type&&(m.id===id||m.requestId===id)),{timeout:30_000},type,id);
      return page.evaluate((type,id)=>window.__syncHost.messages.find(m=>m.type===type&&(m.id===id||m.requestId===id)),type,id);
    };
    const checkpoint=async id=>{await send({type:'sync-checkpoint',id});const result=await response('sync-checkpoint-ready',id);assert.equal(result.ok,true);assert.equal(result.data,undefined);assert.equal(result.newAnnotations,undefined);return result;};
    const draw=async(mode,pageNumber,offset=0)=>{
      await viewer.evaluate(()=>PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode:0,isFromKeyboard:true,createNewEditor:false}));
      await viewer.evaluate(pageNumber=>{const app=PDFViewerApplication;app.pdfViewer.currentPageNumber=pageNumber;document.querySelector('.page[data-page-number="'+pageNumber+'"]').scrollIntoView({block:'start'});},pageNumber);
      await viewer.waitForFunction(n=>PDFViewerApplication.pdfViewer.getPageView(n-1)?.annotationEditorLayer?.div?.isConnected&&PDFViewerApplication.pdfViewer.getPageView(n-1).renderingState===3&&PDFViewerApplication.pdfViewer.currentPageNumber===n,{timeout:15_000},pageNumber);
      await viewer.evaluate(mode=>PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode,isFromKeyboard:true,createNewEditor:false}),mode);
      await viewer.waitForFunction(n=>document.querySelector('.page[data-page-number="'+n+'"] .annotationEditorLayer')?.classList.contains('creationPriority'),{timeout:15_000},pageNumber);
      const before=await viewer.evaluate(()=>PDFViewerApplication.pdfDocument.annotationStorage.size);
      const rect=await viewer.$eval(`.page[data-page-number="${pageNumber}"]`,el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
      const start={x:rect.x+rect.width*(.3+offset*.12),y:Math.max(160,rect.y+rect.height*.32)};
      const hit=await viewer.evaluate(({x,y})=>{const e=document.elementFromPoint(x,y);return {tag:e?.tagName,id:e?.id,classes:e?.className,layer:PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.currentLayer?.pageIndex,viewport:{x:innerWidth,y:innerHeight},layerClasses:document.querySelector('.page[data-page-number="'+PDFViewerApplication.pdfViewer.currentPageNumber+'"] .annotationEditorLayer')?.className};},start);
      await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+65,start.y+45,{steps:8});await page.mouse.up();
      if(mode===15)await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.currentLayer?.commitOrRemove());
      try { await viewer.waitForFunction(n=>PDFViewerApplication.pdfDocument.annotationStorage.size>n,{timeout:15_000},before); } catch(error) { throw new Error('draw failed '+JSON.stringify({mode,pageNumber,start,before,hit,state:await viewer.evaluate(()=>({size:PDFViewerApplication.pdfDocument.annotationStorage.size,mode:PDFViewerApplication.pdfViewer.annotationEditorMode,readOnly:window.__syncBridgeState.readOnly,page:PDFViewerApplication.pdfViewer.currentPageNumber}))})+' '+error.message); }
    };
    await draw(5,1);
    const first=await checkpoint('dirty-first');
    assert.equal(first.dirty,true);assert.equal(first.operations.length,1);
    const op=first.operations[0],uuid=op.uuid;
    assert.equal(op.kind,'Square');assert.equal(op.deleted,false);assert.equal(op.pageIndex,0);
    assert.ok(op.payload.editor.rect.length===4);assert.ok(op.clock.opId);assert.ok(Number.isSafeInteger(op.clock.logical));
    assert.deepEqual((await checkpoint('dirty-repeat')).operations,first.operations,'Checkpoint retries retain operation identity');
    await page.evaluate(()=>window.__syncHost.holdAck=true);
    const saving=viewer.evaluate(()=>PDFViewerApplication.save());
    await page.waitForFunction(()=>window.__syncHost.pendingAck);
    await page.evaluate(()=>{const h=window.__syncHost;h.send({type:'saved',...h.pendingAck, type:'saved',rendererGeneration:'stale',external:true,operationCount:h.pendingAck.operations.length,batchId:'stale',ok:true});});
    await viewer.waitForFunction(()=>window.__syncBridgeState.pendingSave!==null);
    assert.equal(await viewer.evaluate(()=>window.__syncBridgeState.confirmedRevision < window.__syncBridgeState.revision),true,'Stale renderer ACK cannot settle edits');
    await page.evaluate(()=>{const h=window.__syncHost;h.ack(h.pendingAck);h.holdAck=false;});await saving;
    const clean=await checkpoint('clean');assert.equal(clean.dirty,false);assert.deepEqual(clean.operations,[]);
    assert.equal(await page.evaluate(()=>window.__browserSidecarHost.durableWrites[0].sourceBytes),0);
    // Same UUID edits retain identity and increase logical operation clocks.
    await viewer.evaluate(uuid=>{
      const state=window.__syncBridgeState,app=PDFViewerApplication,manager=app.pdfViewer._layerProperties.annotationEditorUIManager;
      const runtime=[...state.annotationUuidByRuntimeId].find(([,id])=>id===uuid)?.[0];const editor=manager.getEditor(runtime);
      manager.setSelected(editor);app.eventBus.dispatch('switchannotationeditorparams',{source:window,type:62,value:4});
    },uuid);
    const styled=(await checkpoint('styled')).operations.find(row=>row.uuid===uuid);
    assert.equal(styled.payload.editor.thickness,4);assert.notEqual(styled.clock.opId,op.clock.opId);
    await viewer.evaluate(()=>PDFViewerApplication.save());assert.equal((await checkpoint('styled-clean')).dirty,false);
    await viewer.evaluate(uuid=>{
      const state=window.__syncBridgeState,manager=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const runtime=[...state.annotationUuidByRuntimeId].find(([,id])=>id===uuid)?.[0];manager.deleteEditor(manager.getEditor(runtime));
    },uuid);
    const deleted=(await checkpoint('deleted')).operations.find(row=>row.uuid===uuid);assert.equal(deleted.deleted,true);
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo());
    const undone=(await checkpoint('undo')).operations.find(row=>row.uuid===uuid);assert.equal(undone.deleted,false);assert.notEqual(undone.clock.opId,deleted.clock.opId);
    await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.redo());
    assert.equal((await checkpoint('redo')).operations.find(row=>row.uuid===uuid).deleted,true);
    await viewer.evaluate(()=>PDFViewerApplication.save());assert.equal((await checkpoint('delete-clean')).dirty,false);
    await send({type:'sync-checkpoint',id:'stale-open',openRequest:0});
    assert.equal((await response('sync-checkpoint-rejected','stale-open')).ok,false,'A stale document open request cannot capture the current edits');
    assert.equal(await page.evaluate(uuid=>window.__browserSidecarHost.operationsFor('sync-operation-document').find(row=>row.uuid===uuid).deleted,uuid),true);
    // Rejected obsolete binary sync cannot reopen the document or erase pending state.
    await send({type:'sync-apply-prepare',id:'binary-prepare'});
    const rejected=await response('sync-apply-rejected','binary-prepare');assert.equal(rejected.ok,false);assert.equal(rejected.reason,'immutable-source-annotations-only');
    await send({type:'sync-apply',id:'binary-apply',data:[1,2,3]});
    assert.equal((await response('sync-apply-rejected','binary-apply')).reason,'immutable-source-annotations-only');
    assert.deepEqual(await viewer.evaluate(()=>({binary:window.__binarySaves,close:window.__closes,same:PDFViewerApplication.pdfDocument===window.__originalDoc})),{binary:0,close:0,same:true});
    await page.evaluate(()=>window.__syncHost.open());await page.waitForFunction(()=>window.__syncHost.opened.length===2);await ready();
    await viewer.evaluate(()=>{window.__reopenedDoc=PDFViewerApplication.pdfDocument;const save=window.__reopenedDoc.saveDocument.bind(window.__reopenedDoc);window.__reopenedDoc.saveDocument=(...args)=>{window.__binarySaves++;return save(...args);};});
    assert.equal((await checkpoint('reopened')).dirty,false);
    assert.equal(await viewer.evaluate(uuid=>window.__syncBridgeState.externalAnnotationRows.get(uuid)?.deleted===true,uuid),true,'Reopening original bytes preserves the deleted UUID');
    // A late snapshot from the previous open must not resurrect the tombstone.
    await page.evaluate(({uuid,op})=>window.__syncHost.send({type:'external-annotations-update',openRequest:1,sourceMatch:'MATCH',externalAnnotations:{...window.__browserSidecarHost.snapshotFor('sync-operation-document'),annotations:[op],tombstones:[]}}),{uuid,op});
    await checkpoint('after-stale-snapshot');
    assert.equal(await viewer.evaluate(uuid=>window.__syncBridgeState.externalAnnotationRows.get(uuid)?.deleted===true,uuid),true);
    // A remote Sidecar operation hydrates into the current document without binary reload.
    const remoteUuid='00000000-0000-4000-8000-000000000042';
    await page.evaluate(({op,remoteUuid})=>{
      const h=window.__browserSidecarHost,d=h.documents.get('sync-operation-document');
      d.operations.set(remoteUuid,{...op,uuid:remoteUuid,clock:{...op.clock,timestamp:op.clock.timestamp+10000,deviceId:'remote-device',opId:'remote-created'},payload:{editor:{...op.payload.editor,thickness:7}}});
      d.revision++;h.broadcastSnapshot('sync-operation-document',window.__syncHost.openRequest);
    },{op,remoteUuid});
    await viewer.waitForFunction(uuid=>window.__syncBridgeState.externalAnnotationRows.get(uuid)?.editor?.thickness===7,{},remoteUuid);
    assert.equal((await checkpoint('remote-clean')).dirty,false,'Remote hydration does not emit another local edit');
    assert.deepEqual(await viewer.evaluate(()=>({binary:window.__binarySaves,same:PDFViewerApplication.pdfDocument===window.__reopenedDoc})),{binary:0,same:true},'Remote operation hydration keeps the current source document');
    // Explicit export retains mixed-page writer ordering, without making save binary again.
    await draw(5,2);await draw(15,2,1);await draw(5,10);await draw(15,10,1);
    await send({type:'export-copy',requestId:'explicit-export'});
    await response('export-ready','explicit-export');
    const output=await page.evaluate(()=>{
      const data=window.__syncHost.messages.find(m=>m.type==='export-ready').data;
      return Array.from(new Uint8Array(data));
    });
    assert.equal(await viewer.evaluate(()=>window.__binarySaves),1,'Only explicit export serializes the full PDF');
    const exported=await inspect({bytes:Uint8Array.from(output)});
    for(const pageIndex of [1,9]) for(const kind of ['square','ink']) {
      assert.ok(exported.identities.some(row=>row.pageIndex===pageIndex&&row.kind===kind),`Explicit export includes ${kind} on page ${pageIndex+1}`);
    }
    const original=await viewer.evaluate(async()=>Array.from(await PDFViewerApplication.pdfDocument.getData()));
    assert.equal(createHash('sha256').update(Uint8Array.from(original)).digest('hex'),sourceHash.slice(7),'The live Reader retains byte-identical source PDF after editing and export');
    await send({type:'flush',id:'close-recovery'});const flushed=await response('flushed','close-recovery');assert.equal(flushed.ok,true);assert.equal(flushed.dirty,false);
    assert.ok(await page.evaluate(()=>window.__browserSidecarHost.durableWrites.some(row=>row.type==='recover'&&row.sourceBytes===0)),'Close flush durably stores annotation operations without PDF bytes');
    assert.equal(await page.evaluate(()=>window.__browserSidecarHost.errors.length),0);
  } catch(error) {
    primaryError=new Error(error.message+' browserErrors='+JSON.stringify(browserErrors),{cause:error});
    if(page) {
      await mkdir(artifactsPath,{recursive:true});
      await writeFile(path.join(artifactsPath,`sync-operations-failure-${Date.now()}.json`),JSON.stringify(await page.evaluate(()=>({messages:window.__syncHost?.messages.map(({data,...m})=>m),errors:window.__browserSidecarHost?.errors})),null,2));
    }
  } finally {cleanupReport=await cleanupBrowserTestResources({browser,ownedPages:[page].filter(Boolean),server});}
  const error=attachCleanupErrors(primaryError,cleanupReport);if(error)throw error;
});
