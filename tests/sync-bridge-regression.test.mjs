import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef } from "pdf-lib";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";
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
const artifactsPath = resolveTestArtifactRoot(root);
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

function pdfStringValue(value) {
  return typeof value?.decodeText === "function" ? value.decodeText() : null;
}

async function readPageAnnotations(bytes, pageIndex) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = doc.getPages()[pageIndex];
  const rawAnnots = page?.node.get(PDFName.of("Annots"));
  const annots = rawAnnots instanceof PDFArray
    ? rawAnnots
    : rawAnnots ? doc.context.lookup(rawAnnots, PDFArray) : null;
  if (!annots) return [];
  return annots.asArray().map((reference, index) => {
    const dict = reference instanceof PDFRef
      ? doc.context.lookup(reference, PDFDict)
      : reference;
    assert.ok(dict instanceof PDFDict, `Page ${pageIndex + 1} /Annots[${index}] must be a dictionary`);
    const subtype = dict.lookup(PDFName.of("Subtype"), PDFName).decodeText();
    const intent = dict.get(PDFName.of("IT"));
    return {
      ref: reference instanceof PDFRef ? reference.toString() : null,
      subtype,
      intent: intent instanceof PDFName ? intent.decodeText() : null,
      nm: pdfStringValue(dict.get(PDFName.of("NM"))),
      contents: pdfStringValue(dict.get(PDFName.of("Contents"))),
      parentRef: dict.get(PDFName.of("Parent"))?.toString() || null,
      popupRef: dict.get(PDFName.of("Popup"))?.toString() || null,
      rect: dict.lookup(PDFName.of("Rect"), PDFArray)?.asArray().map(value => value.asNumber()) || null,
      writerKind: subtype === "Ink" && intent?.decodeText?.() === "InkHighlight"
        ? "highlight"
        : subtype.toLowerCase(),
    };
  });
}

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
  popup.set(PDFName.of("Contents"), PDFHexString.fromText("Existing square popup"));
  const popupRef = doc.context.register(popup);
  square.set(PDFName.of("Popup"), popupRef);
  annots.push(popupRef);

  // Keep a PDF.js-renderable but Sidecar-untracked Line and linked Popup in
  // the original /Annots array. Export must preserve these exact references
  // and their order when the editor writer appends new annotations.
  const line = PDFDict.withContext(doc.context);
  line.set(PDFName.of("Type"), PDFName.of("Annot"));
  line.set(PDFName.of("Subtype"), PDFName.of("Line"));
  const lineRect = PDFArray.withContext(doc.context);
  for (const value of [240, 160, 360, 250]) lineRect.push(PDFNumber.of(value));
  line.set(PDFName.of("Rect"), lineRect);
  line.set(PDFName.of("L"), doc.context.obj([240, 160, 360, 250]));
  line.set(PDFName.of("NM"), PDFHexString.fromText("page-ten-untracked-line"));
  line.set(PDFName.of("Contents"), PDFHexString.fromText("Untracked line must survive export"));
  line.set(PDFName.of("P"), page.ref);
  const lineRef = doc.context.register(line);
  annots.push(lineRef);

  const linePopup = PDFDict.withContext(doc.context);
  linePopup.set(PDFName.of("Type"), PDFName.of("Annot"));
  linePopup.set(PDFName.of("Subtype"), PDFName.of("Popup"));
  const linePopupRect = PDFArray.withContext(doc.context);
  for (const value of [370, 160, 500, 270]) linePopupRect.push(PDFNumber.of(value));
  linePopup.set(PDFName.of("Rect"), linePopupRect);
  linePopup.set(PDFName.of("Parent"), lineRef);
  linePopup.set(PDFName.of("P"), page.ref);
  linePopup.set(PDFName.of("Contents"), PDFHexString.fromText("Untracked line popup"));
  const linePopupRef = doc.context.register(linePopup);
  line.set(PDFName.of("Popup"), linePopupRef);
  annots.push(linePopupRef);

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
  const basePageTenAnnotations = await readPageAnnotations(bytes, 9);
  for (const kind of ["square", "ink", "highlight", "underline"]) {
    assert.equal(baseInspection.identities.filter(row => row.pageIndex === 9 && row.kind === kind).length, 1);
  }
  assert.deepEqual(basePageTenAnnotations.map(row => row.writerKind), [
    "square", "popup", "line", "popup", "ink", "highlight", "underline",
  ], "The page-ten fixture must contain tracked, untracked, popup, and underline refs in a known source order");
  const baseSquare = basePageTenAnnotations.find(row => row.nm === "page-ten-existing-square");
  const baseSquarePopup = basePageTenAnnotations.find(row => row.contents === "Existing square popup");
  const baseLine = basePageTenAnnotations.find(row => row.nm === "page-ten-untracked-line");
  const baseLinePopup = basePageTenAnnotations.find(row => row.contents === "Untracked line popup");
  assert.equal(baseSquare?.popupRef, baseSquarePopup?.ref);
  assert.equal(baseSquarePopup?.parentRef, baseSquare?.ref);
  assert.equal(baseLine?.popupRef, baseLinePopup?.ref);
  assert.equal(baseLinePopup?.parentRef, baseLine?.ref);
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
      <script>
      (() => {
        const identity=${JSON.stringify({channel,token})};
        const frame=document.querySelector('iframe');
        window.addEventListener('message',event=>{
          const message=event.data,host=window.__syncHost;
          if(event.source!==frame?.contentWindow||message?.channel!==identity.channel||message?.token!==identity.token||
              !host||host.failNextWriteType!==message.type||!['save','recover'].includes(message.type))return;
          event.stopImmediatePropagation();
          host.failNextWriteType=null;
          const failed={...identity,type:message.type==='recover'?'recovery-error':'error',
            documentId:message.documentId,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,
            requestId:message.requestId,revision:message.revision,ok:false,code:'TEST_PERSISTENCE_FAILED',
            message:'Injected Sidecar write failure for '+message.type};
          host.failedWrites.push({type:message.type,documentId:message.documentId,openRequest:message.openRequest,
            requestId:message.requestId,revision:message.revision,code:failed.code,message:failed.message});
          host.errors.push(failed.message);
          frame.contentWindow.postMessage(failed,'*');
        });
      })();
      </script>
      ${browserSidecarHarnessScript({channel,token,sourceHash})}
      <script>
      const config=${JSON.stringify({channel,token,rendererGeneration,documentId})};
      const frame=document.querySelector('iframe');
      const host=window.__syncHost={opened:[],messages:[],acks:[],failedWrites:[],errors:[],
        holdAck:false,pendingAck:null,failNextWriteType:null,openRequest:0};
      host.send=message=>frame.contentWindow.postMessage({...config,openRequest:host.openRequest,...message},'*');
      host.open=async()=>{const data=await fetch('/source.pdf').then(r=>r.arrayBuffer());host.openRequest++;host.send({type:'open',filename:'writer.pdf',autoSave:false,readOnly:false,data,sourceHash:${JSON.stringify(sourceHash)}});};
      host.ack=message=>{
        host.acks.push({type:message.type,documentId:message.documentId,openRequest:message.openRequest,
          rendererGeneration:message.rendererGeneration,requestId:message.requestId,revision:message.revision,
          operationUuids:(message.operations||[]).map(operation=>operation.uuid)});
        host.send({type:message.type==='recover'?'recovered':'saved',documentId:message.documentId,
          openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,
          requestId:message.requestId,revision:message.revision,ok:true,external:true,
          batchId:'durable-'+message.requestId,operationCount:message.operations.length});
      };
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
      // PDF.js starts each mode update asynchronously. Sending NONE and the
      // active mode in one turn lets updateMode(active) observe the old UI
      // manager mode and return early; the queued NONE update can then disable
      // layers after the viewer has announced the active mode. Await each
      // transition before requesting the next one.
      const modeCompletionTrace=await viewer.evaluate(({mode,pageNumber})=>new Promise((resolve,reject)=>{
        const bus=PDFViewerApplication.eventBus;
        const app=PDFViewerApplication,view=app.pdfViewer,manager=view._layerProperties.annotationEditorUIManager;
        const trace=[];
        const box=element=>{
          const rect=element?.getBoundingClientRect();
          return rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height,top:rect.top,right:rect.right,bottom:rect.bottom,left:rect.left}:null;
        };
        const initial={viewerMode:view.annotationEditorMode,managerMode:manager.getMode()};
        if(initial.viewerMode!==initial.managerMode){
          reject(new Error('PDF.js viewer and UI manager modes already disagree before draw: '+JSON.stringify(initial)));
          return;
        }
        const stages=initial.viewerMode===0?[mode]:[0,mode];
        let stageIndex=0;
        let timer;
        const snapshot=eventMode=>{
          const pageView=view.getPageView(pageNumber-1);
          const layer=pageView?.annotationEditorLayer?.div;
          return {
            eventMode,
            currentMode:view.annotationEditorMode,
            managerMode:manager.getMode(),
            currentPage:view.currentPageNumber,
            targetPage:pageNumber,
            targetRenderingState:pageView?.renderingState,
            targetLayer:layer?{connected:layer.isConnected,classes:layer.className,rect:box(layer)}:null,
            currentLayerPageIndex:manager.currentLayer?.pageIndex??null,
          };
        };
        const finish=error=>{
          clearTimeout(timer);bus._off('annotationeditormodechanged',completed);
          if(error)reject(error);else resolve(trace);
        };
        const requestNext=()=>{
          if(stageIndex>=stages.length){finish();return;}
          const requestedMode=stages[stageIndex];
          try {
            if(view.annotationEditorMode===requestedMode&&manager.getMode()===requestedMode){stageIndex++;requestNext();return;}
            bus.dispatch('switchannotationeditormode',{mode:requestedMode,isFromKeyboard:true,createNewEditor:false});
          } catch(error){finish(error);}
        };
        const completed=event=>{
          trace.push(snapshot(event.mode));
          if(event.mode!==stages[stageIndex])return;
          if(view.annotationEditorMode!==event.mode||manager.getMode()!==event.mode)return;
          stageIndex++;queueMicrotask(requestNext);
        };
        timer=setTimeout(()=>{
          finish(new Error('PDF.js tool mode did not finish within the existing 15s fixture boundary: '+JSON.stringify({mode,pageNumber,currentMode:view.annotationEditorMode,managerMode:manager.getMode(),currentPage:view.currentPageNumber,trace})));
        },15_000);
        bus._on('annotationeditormodechanged',completed);
        try {requestNext();} catch(error){finish(error);}
      }),{mode,pageNumber});
      await viewer.evaluate(pageNumber=>{const app=PDFViewerApplication;app.pdfViewer.currentPageNumber=pageNumber;document.querySelector('.page[data-page-number="'+pageNumber+'"]').scrollIntoView({block:'start'});},pageNumber);
      try {
        await viewer.waitForFunction(({n,mode})=>{
          const view=PDFViewerApplication.pdfViewer,manager=view._layerProperties.annotationEditorUIManager,layer=view.getPageView(n-1)?.annotationEditorLayer?.div;
          const rect=layer?.getBoundingClientRect(),viewport=document.getElementById('viewerContainer').getBoundingClientRect();
          return layer?.isConnected&&view.getPageView(n-1).renderingState===3&&view.currentPageNumber===n&&
            view.annotationEditorMode===mode&&manager.getMode()===mode&&rect?.bottom>viewport.top&&rect.top<viewport.bottom&&
            layer.classList.contains('creationPriority')&&
            (mode!==9||document.querySelector('.page[data-page-number="'+n+'"] .textLayer span'));
        },{timeout:15_000},{n:pageNumber,mode});
      } catch(error) {
        const readiness=await viewer.evaluate(({n,mode,offset,modeCompletionTrace})=>{
          const app=PDFViewerApplication,view=app.pdfViewer,manager=view._layerProperties.annotationEditorUIManager,pageView=view.getPageView(n-1);
          const page=document.querySelector('.page[data-page-number="'+n+'"]');
          const layer=pageView?.annotationEditorLayer?.div;
          const managedLayer=manager.getLayer(n-1);
          const textLayer=page?.querySelector('.textLayer');
          const rect=element=>{
            const r=element?.getBoundingClientRect();
            return r?{x:r.x,y:r.y,width:r.width,height:r.height,top:r.top,right:r.right,bottom:r.bottom,left:r.left}:null;
          };
          const pageRect=rect(page),layerRect=rect(layer),viewportRect=rect(document.getElementById('viewerContainer'));
          const start=pageRect?{x:pageRect.x+pageRect.width*(.3+offset*.12),y:Math.max(160,pageRect.y+pageRect.height*.32)}:null;
          const hit=start?document.elementFromPoint(start.x,start.y):null;
          const intersects=Boolean(layerRect&&viewportRect&&layerRect.bottom>viewportRect.top&&layerRect.top<viewportRect.bottom);
          const textSpanCount=textLayer?.querySelectorAll('span').length??0;
          return {
            requested:{mode:mode,pageNumber:n,offset},
            actual:{mode:view.annotationEditorMode,managerMode:manager.getMode(),managerIsEditing:manager.isEditingMode(),currentPage:view.currentPageNumber,currentLayerPageIndex:manager.currentLayer?.pageIndex??null,scrollX:scrollX,scrollY:scrollY,visibilityState:document.visibilityState,hasFocus:document.hasFocus()},
            targetPage:{exists:Boolean(page),rect:pageRect,renderingState:pageView?.renderingState??null},
            targetLayer:layer?{connected:layer.isConnected,classes:layer.className,disabled:layer.classList.contains('disabled'),creationPriority:layer.classList.contains('creationPriority'),rect:layerRect,display:getComputedStyle(layer).display,visibility:getComputedStyle(layer).visibility,pointerEvents:getComputedStyle(layer).pointerEvents,managerTracksSameLayer:managedLayer===pageView?.annotationEditorLayer?.annotationEditorLayer,managerLayerClasses:managedLayer?.div?.className??null}:null,
            textLayer:{exists:Boolean(textLayer),classes:textLayer?.className??null,spanCount:textSpanCount,rect:rect(textLayer)},
            viewerContainer:{rect:viewportRect,clientWidth:document.getElementById('viewerContainer')?.clientWidth??null,clientHeight:document.getElementById('viewerContainer')?.clientHeight??null},
            readiness:{connected:Boolean(layer?.isConnected),rendered:pageView?.renderingState===3,currentPageMatches:view.currentPageNumber===n,modeMatches:view.annotationEditorMode===mode,layerIntersectsViewport:intersects,creationPriority:Boolean(layer?.classList.contains('creationPriority')),textSpanReady:mode!==9||textSpanCount>0},
            hit:start?{point:start,tag:hit?.tagName??null,id:hit?.id??null,classes:hit?.className??null,page:Number(hit?.closest('.page')?.dataset.pageNumber)||null,textLayer:Boolean(hit?.closest('.textLayer')),editorLayer:Boolean(hit?.closest('.annotationEditorLayer'))}:null,
            modeCompletionTrace,
          };
        },{n:pageNumber,mode,offset,modeCompletionTrace});
        throw new Error('Target draw layer readiness timed out at the unchanged 15s boundary: '+JSON.stringify(readiness),{cause:error});
      }
      const before=await viewer.evaluate(pageNumber=>{
        const manager=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        return {
          storageSize:PDFViewerApplication.pdfDocument.annotationStorage.size,
          editorIds:[...manager.getEditors(pageNumber-1)].map(editor=>String(editor.id)),
        };
      },pageNumber);
      const rect=await viewer.$eval(`.page[data-page-number="${pageNumber}"]`,el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
      const start={x:rect.x+rect.width*(.3+offset*.12),y:Math.max(160,rect.y+rect.height*.32)};
      const hit=await viewer.evaluate(({x,y})=>{const e=document.elementFromPoint(x,y);return {tag:e?.tagName,id:e?.id,classes:e?.className,page:Number(e?.closest('.page')?.dataset.pageNumber),textLayer:Boolean(e?.closest('.textLayer')),editorLayer:Boolean(e?.closest('.annotationEditorLayer')),layer:PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.currentLayer?.pageIndex,viewport:{x:innerWidth,y:innerHeight},layerClasses:document.querySelector('.page[data-page-number="'+PDFViewerApplication.pdfViewer.currentPageNumber+'"] .annotationEditorLayer')?.className};},start);
      assert.equal(hit.page,pageNumber,'Trusted drawing coordinates must hit the requested visible PDF page');
      assert.equal(mode===9?hit.textLayer:hit.editorLayer,true,
        'Trusted drawing must hit the active tool input layer after mode completion: '+JSON.stringify(hit));
      await page.mouse.move(start.x,start.y);await page.mouse.down();await page.mouse.move(start.x+65,start.y+45,{steps:8});await page.mouse.up();
      if(mode===9||mode===15)await viewer.evaluate(()=>PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.currentLayer?.commitOrRemove());
      try { await viewer.waitForFunction(state=>PDFViewerApplication.pdfDocument.annotationStorage.size>state.storageSize,{timeout:15_000},before); } catch(error) { throw new Error('draw failed '+JSON.stringify({mode,pageNumber,start,before,hit,state:await viewer.evaluate(()=>({size:PDFViewerApplication.pdfDocument.annotationStorage.size,mode:PDFViewerApplication.pdfViewer.annotationEditorMode,readOnly:window.__syncBridgeState.readOnly,page:PDFViewerApplication.pdfViewer.currentPageNumber}))})+' '+error.message); }
      const created=await viewer.evaluate(({pageNumber,before})=>{
        const manager=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor=[...manager.getEditors(pageNumber-1)].find(candidate=>!before.editorIds.includes(String(candidate.id)));
        if(!editor)return null;
        return {runtimeId:String(editor.id),editorType:editor.constructor._editorType,pageIndex:editor.pageIndex,serialized:editor.serialize(true)};
      },{pageNumber,before});
      assert.ok(created,`A real PDF.js editor must be created for mode ${mode} on page ${pageNumber}`);
      return created;
    };
    await draw(5,1);
    const first=await checkpoint('dirty-first');
    assert.equal(first.dirty,true);assert.equal(first.operations.length,1);
    const op=first.operations[0],uuid=op.uuid;
    assert.equal(op.kind,'Square');assert.equal(op.deleted,false);assert.equal(op.pageIndex,0);
    assert.ok(op.payload.editor.rect.length===4);assert.ok(op.clock.opId);assert.ok(Number.isSafeInteger(op.clock.logical));
    assert.deepEqual((await checkpoint('dirty-repeat')).operations,first.operations,'Checkpoint retries retain operation identity');
    const failedSaveResult=await page.evaluate(()=>{window.__syncHost.failNextWriteType='save';return true;})
      .then(()=>viewer.evaluate(()=>PDFViewerApplication.save()));
    const failedSaveState=await viewer.evaluate(()=>({
      dirty:window.__syncBridgeState.dirty,
      revision:window.__syncBridgeState.revision,
      confirmedRevision:window.__syncBridgeState.confirmedRevision,
      pendingSave:window.__syncBridgeState.pendingSave,
      autoSavePaused:window.__syncBridgeState.autoSavePaused,
    }));
    assert.equal(failedSaveResult,false,'A failed Sidecar save must report failure to PDF.js');
    assert.equal(failedSaveState.dirty,true,'A failed save must retain dirty annotation state');
    assert.ok(failedSaveState.confirmedRevision<failedSaveState.revision,
      'A failed save must not advance the durable revision');
    assert.equal(failedSaveState.pendingSave,null,'The failed save request must settle without clearing the edit');
    assert.equal(failedSaveState.autoSavePaused,true,'A host persistence error pauses automatic retries');
    const failedSaveHost=await page.evaluate(()=>({
      failure:window.__syncHost.failedWrites.at(-1),
      error:window.__syncHost.errors.at(-1),
      durableWrites:window.__browserSidecarHost.durableWrites.length,
      operationCount:window.__browserSidecarHost.operationsFor('sync-operation-document').length,
    }));
    assert.equal(failedSaveHost.failure?.type,'save');
    assert.equal(failedSaveHost.failure?.code,'TEST_PERSISTENCE_FAILED');
    assert.match(failedSaveHost.error,/Injected Sidecar write failure for save/);
    assert.equal(failedSaveHost.durableWrites,0,'The fault injector must fail before the sidecar transaction commits');
    assert.equal(failedSaveHost.operationCount,0,'A failed save must not publish the attempted operation batch');
    await page.evaluate(()=>window.__syncHost.holdAck=true);
    const saving=viewer.evaluate(()=>PDFViewerApplication.save());
    await page.waitForFunction(()=>window.__syncHost.pendingAck);
    await page.evaluate(()=>{const h=window.__syncHost;h.send({type:'saved',...h.pendingAck, type:'saved',rendererGeneration:'stale',external:true,operationCount:h.pendingAck.operations.length,batchId:'stale',ok:true});});
    await viewer.waitForFunction(()=>window.__syncBridgeState.pendingSave!==null);
    assert.equal(await viewer.evaluate(()=>window.__syncBridgeState.confirmedRevision < window.__syncBridgeState.revision),true,'Stale renderer ACK cannot settle edits');
    await page.evaluate(()=>{const h=window.__syncHost;h.ack(h.pendingAck);h.holdAck=false;});await saving;
    const clean=await checkpoint('clean');assert.equal(clean.dirty,false);assert.deepEqual(clean.operations,[]);
    const firstSquareSave=await page.evaluate(uuid=>({
      write:window.__browserSidecarHost.durableWrites[0],
      operation:window.__browserSidecarHost.operationsFor('sync-operation-document').find(row=>row.uuid===uuid),
      ack:window.__syncHost.acks.find(row=>row.type==='save'&&row.operationUuids.includes(uuid)),
    }),uuid);
    assert.equal(firstSquareSave.write?.sourceBytes,0);
    assert.equal(firstSquareSave.operation?.uuid,uuid,'The successful save keeps the original Square UUID');
    assert.deepEqual(firstSquareSave.ack?.operationUuids,[uuid],
      'The durable ACK must confirm the exact UUID operation that was saved');
    // Same UUID edits retain identity and increase logical operation clocks.
    await viewer.evaluate(uuid=>{
      const state=window.__syncBridgeState,app=PDFViewerApplication,manager=app.pdfViewer._layerProperties.annotationEditorUIManager;
      const runtime=[...state.annotationUuidByRuntimeId].find(([,id])=>id===uuid)?.[0];const editor=manager.getEditor(runtime);
      manager.setSelected(editor);app.eventBus.dispatch('switchannotationeditorparams',{source:window,type:62,value:4});
    },uuid);
    const styled=(await checkpoint('styled')).operations.find(row=>row.uuid===uuid);
    assert.equal(styled.payload.editor.thickness,4);assert.notEqual(styled.clock.opId,op.clock.opId);
    assert.equal(await viewer.evaluate(()=>PDFViewerApplication.save()),true);
    assert.equal((await checkpoint('styled-clean')).dirty,false);
    const styledPersisted=await page.evaluate(uuid=>({
      operation:window.__browserSidecarHost.operationsFor('sync-operation-document').find(row=>row.uuid===uuid),
      ack:window.__syncHost.acks.find(row=>row.type==='save'&&row.operationUuids.includes(uuid)&&row.revision>1),
    }),uuid);
    assert.equal(styledPersisted.operation?.uuid,uuid,'Style updates retain the saved Square UUID');
    assert.equal(styledPersisted.operation?.payload?.editor?.thickness,4);
    assert.deepEqual(styledPersisted.ack?.operationUuids,[uuid],
      'The styled Square revision is acknowledged under its original UUID');
    assert.deepEqual(styledPersisted.operation?.payload?.editor?.rect,styled.payload.editor.rect,
      'The durable Square keeps its exact PDF-space rectangle');
    await page.evaluate(()=>window.__syncHost.open());
    await page.waitForFunction(()=>window.__syncHost.opened.length===2,{timeout:30_000});
    await ready();
    await viewer.evaluate(()=>{
      window.__reopenedDoc=PDFViewerApplication.pdfDocument;
      const save=window.__reopenedDoc.saveDocument.bind(window.__reopenedDoc);
      window.__reopenedDoc.saveDocument=(...args)=>{window.__binarySaves++;return save(...args);};
    });
    await viewer.waitForFunction(uuid=>{
      const state=window.__syncBridgeState,manager=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const runtime=[...state.annotationUuidByRuntimeId].find(([,id])=>id===uuid)?.[0];
      const editor=runtime===undefined?null:manager.getEditor(runtime);
      const bounds=editor?.div?.getBoundingClientRect();
      return state.externalAnnotationRows.get(uuid)?.editor?.thickness===4 &&
        editor?.div?.isConnected && bounds?.width>0 && bounds?.height>0;
    },{timeout:30_000},uuid);
    const reopenedSquare=await viewer.evaluate(uuid=>{
      const state=window.__syncBridgeState,manager=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const mapping=[...state.annotationUuidByRuntimeId].find(([,id])=>id===uuid);
      const editor=mapping?manager.getEditor(mapping[0]):null;
      const rect=editor?.serialize?.(true)?.rect||null;
      const bounds=editor?.div?.getBoundingClientRect();
      return {
        uuid:state.annotationUuidByRuntimeId.get(String(editor?.id)),
        row:state.externalAnnotationRows.get(uuid),
        serialized:editor?.serialize?.(true)||null,
        domRect:bounds?{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height}:null,
        rect,
        openRequest:state.activeOpenRequest,
      };
    },uuid);
    assert.equal(reopenedSquare.uuid,uuid,'Reopen must hydrate the same saved Square UUID');
    assert.equal(reopenedSquare.row?.editor?.thickness,4);
    assert.equal(reopenedSquare.serialized?.annotationType,5);
    assert.ok(reopenedSquare.domRect?.width>0&&reopenedSquare.domRect?.height>0,
      'The rehydrated Square must have real visible editor geometry');
    assert.ok(Array.isArray(reopenedSquare.rect)&&reopenedSquare.rect.length===4);
    assert.ok(Math.max(...reopenedSquare.rect.map((value,index)=>Math.abs(value-styled.payload.editor.rect[index])))<0.05,
      'The rehydrated Square must retain its saved PDF-space geometry');
    const recoveryEdit=await viewer.evaluate(uuid=>{
      const state=window.__syncBridgeState,manager=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const runtime=[...state.annotationUuidByRuntimeId].find(([,id])=>id===uuid)?.[0];
      const editor=runtime===undefined?null:manager.getEditor(runtime);
      if(!editor)throw new Error('The acknowledged Square must exist before recovery failure coverage.');
      manager.setSelected(editor);
      PDFViewerApplication.eventBus.dispatch('switchannotationeditorparams',{source:window,type:62,value:5});
      return {runtimeId:String(runtime),serialized:editor.serialize(true)};
    },uuid);
    assert.equal(recoveryEdit.serialized.thickness,5);
    const recoveryDirty=(await checkpoint('recovery-dirty')).operations.find(row=>row.uuid===uuid);
    assert.equal(recoveryDirty?.payload?.editor?.thickness,5);
    await page.evaluate(()=>{window.__syncHost.failNextWriteType='recover';});
    await send({type:'flush',id:'failed-sidecar-recovery'});
    const failedRecovery=await response('flushed','failed-sidecar-recovery');
    assert.equal(failedRecovery.ok,false,'A failed Sidecar recovery must be reported as a failed flush');
    assert.equal(failedRecovery.dirty,true,'A failed recovery must retain the dirty Square revision');
    assert.notEqual(failedRecovery.recovered,true);
    const failedRecoveryState=await viewer.evaluate(()=>({
      dirty:window.__syncBridgeState.dirty,
      revision:window.__syncBridgeState.revision,
      confirmedRevision:window.__syncBridgeState.confirmedRevision,
      pendingRecovery:window.__syncBridgeState.pendingRecovery,
    }));
    assert.equal(failedRecoveryState.dirty,true);
    assert.ok(failedRecoveryState.confirmedRevision<failedRecoveryState.revision);
    assert.equal(failedRecoveryState.pendingRecovery,null);
    const failedRecoveryHost=await page.evaluate(()=>({
      failure:window.__syncHost.failedWrites.at(-1),
      error:window.__syncHost.errors.at(-1),
      recoveryWrites:window.__browserSidecarHost.durableWrites.filter(row=>row.type==='recover').length,
    }));
    assert.equal(failedRecoveryHost.failure?.type,'recover');
    assert.equal(failedRecoveryHost.failure?.code,'TEST_PERSISTENCE_FAILED');
    assert.match(failedRecoveryHost.error,/Injected Sidecar write failure for recover/);
    assert.equal(failedRecoveryHost.recoveryWrites,0,
      'The injected recovery failure must happen before the sidecar transaction commits');
    await send({type:'flush',id:'retry-sidecar-recovery'});
    const recoveredSquare=await response('flushed','retry-sidecar-recovery');
    assert.equal(recoveredSquare.ok,true,'Retrying the same dirty Sidecar recovery should succeed');
    assert.equal(recoveredSquare.dirty,false);
    assert.equal(recoveredSquare.recovered,true);
    const recoveryAck=await page.evaluate(uuid=>({
      operation:window.__browserSidecarHost.operationsFor('sync-operation-document').find(row=>row.uuid===uuid),
      ack:window.__syncHost.acks.find(row=>row.type==='recover'&&row.operationUuids.includes(uuid)),
      write:window.__browserSidecarHost.durableWrites.find(row=>row.type==='recover'),
    }),uuid);
    assert.equal(recoveryAck.operation?.uuid,uuid,'Recovery retry retains the same Square identity');
    assert.equal(recoveryAck.operation?.payload?.editor?.thickness,5);
    assert.deepEqual(recoveryAck.ack?.operationUuids,[uuid]);
    assert.equal(recoveryAck.write?.sourceBytes,0);
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
    const beforeBinaryRejection=await viewer.evaluate(()=>{
      window.__beforeBinaryRejectionDoc=PDFViewerApplication.pdfDocument;
      return {binary:window.__binarySaves,close:window.__closes};
    });
    await send({type:'sync-apply-prepare',id:'binary-prepare'});
    const rejected=await response('sync-apply-rejected','binary-prepare');assert.equal(rejected.ok,false);assert.equal(rejected.reason,'immutable-source-annotations-only');
    await send({type:'sync-apply',id:'binary-apply',data:[1,2,3]});
    assert.equal((await response('sync-apply-rejected','binary-apply')).reason,'immutable-source-annotations-only');
    assert.deepEqual(await viewer.evaluate(()=>({binary:window.__binarySaves,close:window.__closes,same:PDFViewerApplication.pdfDocument===window.__beforeBinaryRejectionDoc})),{...beforeBinaryRejection,same:true},
      'Rejecting obsolete binary apply cannot serialize, close, or replace the current source document');
    await page.evaluate(()=>window.__syncHost.open());await page.waitForFunction(()=>window.__syncHost.opened.length===3);await ready();
    await viewer.evaluate(()=>{window.__reopenedDoc=PDFViewerApplication.pdfDocument;const save=window.__reopenedDoc.saveDocument.bind(window.__reopenedDoc);window.__reopenedDoc.saveDocument=(...args)=>{window.__binarySaves++;return save(...args);};});
    assert.equal((await checkpoint('reopened')).dirty,false);
    assert.equal(await viewer.evaluate(uuid=>window.__syncBridgeState.externalAnnotationRows.get(uuid)?.deleted===true,uuid),true,'Reopening original bytes preserves the deleted UUID');
    // A late snapshot from the previous open must not resurrect the tombstone.
    await page.evaluate(({uuid,op})=>window.__syncHost.send({type:'external-annotations-update',openRequest:2,sourceMatch:'MATCH',externalAnnotations:{...window.__browserSidecarHost.snapshotFor('sync-operation-document'),annotations:[op],tombstones:[]}}),{uuid,op:recoveryAck.operation});
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
    // Explicit export retains mixed-page writer order and all original source
    // refs, including Sidecar-untracked annotations and their linked popups.
    const exportSteps=[
      {mode:15,pageNumber:2,offset:0,writerKind:'ink'},
      {mode:9,pageNumber:10,offset:1,writerKind:'highlight'},
      {mode:9,pageNumber:2,offset:1,writerKind:'highlight'},
      {mode:15,pageNumber:10,offset:2,writerKind:'ink'},
      {mode:5,pageNumber:10,offset:3,writerKind:'square'},
      {mode:5,pageNumber:2,offset:2,writerKind:'square'},
    ];
    const expectedWriterKindsByPage=new Map([[1,[]],[9,[]]]);
    for(const step of exportSteps){
      const created=await draw(step.mode,step.pageNumber,step.offset);
      assert.equal(created.pageIndex,step.pageNumber-1,
        `The exported editor must remain associated with page ${step.pageNumber}`);
      assert.equal(created.editorType,step.mode,
        'The real editor class must match the PDF.js tool selected by this fixture (Ink=15, Highlight=9)');
      expectedWriterKindsByPage.get(step.pageNumber-1).push(step.writerKind);
    }
    await send({type:'export-copy',requestId:'explicit-export'});
    await response('export-ready','explicit-export');
    const output=await page.evaluate(()=>{
      const data=window.__syncHost.messages.find(m=>m.type==='export-ready').data;
      return Array.from(new Uint8Array(data));
    });
    assert.equal(await viewer.evaluate(()=>window.__binarySaves),1,'Only explicit export serializes the full PDF');
    const outputBytes=Uint8Array.from(output);
    const exported=await inspect({bytes:outputBytes});
    for(const pageIndex of expectedWriterKindsByPage.keys()) for(const kind of ['square','ink','highlight']) {
      assert.ok(exported.identities.some(row=>row.pageIndex===pageIndex&&row.kind===kind),
        `Explicit export includes ${kind} on page ${pageIndex+1}`);
    }
    const exportedPageTwo=await readPageAnnotations(outputBytes,1);
    const exportedPageTen=await readPageAnnotations(outputBytes,9);
    assert.deepEqual(exportedPageTwo.map(row=>row.writerKind),expectedWriterKindsByPage.get(1),
      'New page-two /Annots refs must follow the actual mixed editor writer order');
    const originalPageTenRefs=basePageTenAnnotations.map(row=>row.ref);
    const preservedPageTen=exportedPageTen.filter(row=>originalPageTenRefs.includes(row.ref));
    assert.deepEqual(preservedPageTen.map(row=>row.ref),originalPageTenRefs,
      'Export must retain every original page-ten annotation ref in its source order');
    for(const baseRow of basePageTenAnnotations){
      const exportedRow=preservedPageTen.find(row=>row.ref===baseRow.ref);
      assert.ok(exportedRow,`Export retains original page-ten ${baseRow.writerKind} ref ${baseRow.ref}`);
      assert.deepEqual(exportedRow,{...baseRow},
        `Export preserves original page-ten ${baseRow.writerKind} metadata, geometry, and relationships`);
    }
    const originalPageTenRefSet=new Set(originalPageTenRefs);
    const addedPageTen=exportedPageTen.filter(row=>!originalPageTenRefSet.has(row.ref));
    assert.deepEqual(addedPageTen.map(row=>row.writerKind),expectedWriterKindsByPage.get(9),
      'New page-ten /Annots refs must follow the mixed editor writer order after all original refs');
    for(const kind of ['highlight','underline','popup','line']){
      assert.ok(exportedPageTen.some(row=>row.writerKind===kind),
        `Explicit export preserves page-ten ${kind} source annotations`);
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
