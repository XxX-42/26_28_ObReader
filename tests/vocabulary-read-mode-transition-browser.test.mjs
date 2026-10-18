import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources, attachCleanupErrors } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const browserPath = resolveBrowserPath();
const channel = "pdf-web-reader";
const token = "vocabulary-read-mode-transition-browser";
const documentId = "lingq-read-mode-document";
const rendererGeneration = "lingq-read-mode-renderer";
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

test("enabling LingQ after Ink returns to READ and opens a real text-layer lookup", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 90_000,
}, async () => {
  const [runtimeSource, bridgeCss, viewerHtml] = await Promise.all([
    readBridgeRuntimeSource(),
    readFile(path.join(root, "viewer-adapter", "bridge.css")),
    readFile(path.join(vendorRoot, "web", "viewer.html"), "utf8"),
  ]);
  const injectedViewer = viewerHtml.replace(
    /<head\b[^>]*>/i,
    (head) => `${head}<link rel="stylesheet" href="/viewer-adapter/bridge.css"><script src="/bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}" data-ios-input-policy="true" data-base-url="/vendor/pdfjs-generic-legacy/web/"></script>`,
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
        <script>
          (() => {
            const channel=${JSON.stringify(channel)}, token=${JSON.stringify(token)}, documentId=${JSON.stringify(documentId)};
            const iframe=document.querySelector('iframe');
            const host=window.__lingqReadModeHost={opened:0,rendererGeneration:null,toggleRequests:[],pageQueries:[],lookups:[],saves:[],errors:[]};
            const post=message=>iframe.contentWindow.postMessage({channel,token,rendererGeneration:host.rendererGeneration,...message},'*');
            window.addEventListener('message',event=>{
              if(event.source!==iframe.contentWindow||event.data?.channel!==channel||event.data?.token!==token)return;
              const message=event.data;
              if(message.type==='ready'){
                host.rendererGeneration=message.rendererGeneration;
                fetch('/tests/fixtures/tracemonkey.pdf').then(response=>response.arrayBuffer()).then(data=>
                  iframe.contentWindow.postMessage({channel,token,type:'open',documentId,filename:'tracemonkey.pdf',openRequest:1,
                    data,readOnly:false,autoSave:false,vocabularyEnabled:false},'*',[data]));
              }else if(message.type==='opened') host.opened++;
              else if(message.type==='annotation-source-identity'){
                post({type:'external-annotations-update',documentId:message.documentId,openRequest:message.openRequest,
                  sourceMatch:'BASELINE_ESTABLISHED',identityConfirmed:true,
                  externalAnnotations:{schemaVersion:1,kind:'pdf-annotation-snapshot',documentId:message.documentId,
                    docKey:'lingq-read-mode-test',revision:0,legacyIdentities:[],
                    source:{sourcePath:message.documentId,sourceHash:'xxh64-v1:lingq-read-mode-test',
                      pageCount:message.pageCount,orderedPageIdentities:message.orderedPageIdentities},annotations:[]}});
              }else if(message.type==='vocab-toggle-request'){
                host.toggleRequests.push(message.enabled===true);
                post({type:'vocab-set-enabled',documentId:message.documentId,openRequest:message.openRequest,enabled:message.enabled===true});
              }else if(message.type==='vocab-page-query'){
                host.pageQueries.push(message);
                post({type:'vocab-page-results',documentId:message.documentId,openRequest:message.openRequest,
                  requestId:message.requestId,queryId:message.queryId,partIndex:message.partIndex,
                  pageNumber:message.pageNumber,records:[],wordMatches:[],phraseMatches:[],metrics:{browserTest:true}});
              }else if(message.type==='vocab-token-tap'){
                host.lookups.push(message);
                post({type:'vocab-entry-result',documentId:message.documentId,openRequest:message.openRequest,
                  requestId:message.requestId,key:message.key,pageNumber:message.pageNumber,
                  record:{key:message.key,storageKey:message.key,type:message.entryType,status:null,
                    hasPersonalRecord:false,dictionaryLookupState:'found',translation:'browser test lookup'}});
              }else if(message.type==='save'){
                host.saves.push({revision:message.revision,operationCount:message.operations?.length||0});
                post({type:'saved',documentId:message.documentId,openRequest:message.openRequest,
                  requestId:message.requestId,revision:message.revision,external:true,
                  operationCount:message.operations?.length||0,batchId:'lingq-transition-save'});
              }else if(message.type==='error') host.errors.push(message.message||message.code||'viewer error');
            });
          })();
        </script>`);
      return;
    }
    if (url.pathname === "/bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(runtimeSource);
      return;
    }
    if (url.pathname === "/viewer-adapter/bridge.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(bridgeCss);
      return;
    }
    let target;
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") target = fixture;
    else if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(injectedViewer);
      return;
    } else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
      const relative = decodeURIComponent(url.pathname.slice("/vendor/pdfjs-generic-legacy/".length));
      target = path.resolve(vendorRoot, relative);
      if (!target.startsWith(`${vendorRoot}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
    } else {
      response.writeHead(404).end("not found");
      return;
    }
    try {
      const info = await stat(target);
      response.writeHead(200, {
        "content-type": mimeTypes.get(path.extname(target)) || "application/octet-stream",
        "content-length": info.size,
        "x-content-type-options": "nosniff",
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  let browser;
  let page;
  let primaryError;
  let cleanupReport;
  try {
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "vocabulary-read-mode-transition-browser" });
    page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 820 });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__lingqReadModeHost?.opened === 1, { timeout: 45_000 });
    const viewer = page.frames().find((frame) => frame.url().includes("/web/viewer.html"));
    assert.ok(viewer, "The PDF.js frame should be available after opening the fixture.");
    await viewer.waitForFunction(() => {
      const app=window.PDFViewerApplication;
      return app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.getLayer(0) &&
        app.pdfViewer.getPageView(0)?.renderingState === 3;
    }, { timeout: 30_000 });

    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      source: window, mode: 15, isFromKeyboard: false, createNewEditor: false,
    }));
    await viewer.waitForFunction(() => {
      const viewer=PDFViewerApplication.pdfViewer;
      return viewer.annotationEditorMode === 15 &&
        viewer._layerProperties.annotationEditorUIManager.getMode() === 15;
    }, { timeout: 10_000 });
    await viewer.evaluate(() => {
      const app=PDFViewerApplication;
      const manager=app.pdfViewer._layerProperties.annotationEditorUIManager;
      const original=manager.updateMode.bind(manager);
      window.__lingqModeTransition={readUpdateStarted:false,modeEvents:[],resumeReadUpdate:null};
      app.eventBus._on("annotationeditormodechanged", event => window.__lingqModeTransition.modeEvents.push({
        mode:event.mode,isFromKeyboard:event.isFromKeyboard===true,
      }));
      manager.updateMode=async function(mode,...args) {
        if(mode===0&&!window.__lingqModeTransition.readUpdateStarted) {
          window.__lingqModeTransition.readUpdateStarted=true;
          await new Promise(resolve=>{window.__lingqModeTransition.resumeReadUpdate=resolve;});
        }
        return original(mode,...args);
      };
    });

    const layerPoint=await viewer.evaluate(() => {
      const layer=PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getLayer(0).div;
      const rect=layer.getBoundingClientRect();
      return {x:Math.max(40,rect.left+120),y:Math.max(90,rect.top+160)};
    });
    const cdp=await page.createCDPSession();
    await cdp.send("Input.dispatchMouseEvent", { type:"mousePressed",...layerPoint,button:"left",buttons:1,clickCount:1,pointerType:"pen" });
    for(let n=1;n<=4;n++) {
      await cdp.send("Input.dispatchMouseEvent", { type:"mouseMoved",x:layerPoint.x+n*8,y:layerPoint.y+n*6,button:"left",buttons:1,pointerType:"pen" });
    }
    await viewer.evaluate(() => {
      document.getElementById("secondaryToolbarToggleButton")?.click();
      document.getElementById("pdfReaderVocabularyToggleButton")?.click();
    });
    await page.waitForFunction(() => window.__lingqReadModeHost.toggleRequests.length === 1, { timeout: 5_000 });
    await viewer.waitForFunction(() => document.documentElement.dataset.vocabularyEnabled === "true", { timeout: 5_000 });
    assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), 15,
      "LingQ must wait until the active Ink pointer ends before requesting READ.");

    // Model a late, non-keyboard Ink event from the mode that was active when
    // LingQ was enabled. It must not cancel the deferred READ request.
    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("annotationeditormodechanged", {
      source: window, mode: 15, isFromKeyboard: false,
    }));
    await cdp.send("Input.dispatchMouseEvent", {
      type:"mouseReleased",x:layerPoint.x+32,y:layerPoint.y+24,button:"left",buttons:0,clickCount:1,pointerType:"pen",
    });
    await viewer.waitForFunction(() => window.__lingqModeTransition.readUpdateStarted, { timeout: 10_000 });
    const duringAsyncUpdate=await viewer.evaluate(() => ({
      viewerMode:PDFViewerApplication.pdfViewer.annotationEditorMode,
      managerMode:PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getMode(),
    }));
    assert.equal(duringAsyncUpdate.viewerMode, 0, "PDFViewer should accept the READ request synchronously.");
    assert.equal(duringAsyncUpdate.managerMode, 15, "the real PDF.js editor manager update is still asynchronous here.");

    const saveResult=await viewer.evaluate(() => PDFViewerApplication.save());
    assert.equal(saveResult, true, "save preparation must retain and durably send the just-finished Ink stroke while mode update is pending.");
    assert.equal(await page.evaluate(() => window.__lingqReadModeHost.saves.length), 1);

    const target=await viewer.evaluate(() => {
      const span=[...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
        .find(item=>item.textContent.trim()&&item.getBoundingClientRect().width>0&&item.getBoundingClientRect().height>0);
      if(!span)throw new Error("No rendered page text is available for a LingQ tap.");
      const rect=span.getBoundingClientRect();
      return {x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2};
    });
    const iframeOffset=await page.$eval("iframe", frame => {
      const rect=frame.getBoundingClientRect();return {x:rect.x,y:rect.y};
    });
    await page.mouse.click(iframeOffset.x+target.x,iframeOffset.y+target.y);
    assert.equal(await page.evaluate(() => window.__lingqReadModeHost.lookups.length), 0,
      "a stale Ink mode callback must keep clicks guarded until PDF.js finishes updateMode(READ).");
    await viewer.evaluate(() => {
      window.__lingqModeTransition.resumeReadUpdate?.();
      window.__lingqModeTransition.resumeReadUpdate=null;
    });

    await viewer.waitForFunction(() => {
      const app=PDFViewerApplication,manager=app.pdfViewer._layerProperties.annotationEditorUIManager;
      return app.pdfViewer.annotationEditorMode===0&&manager.getMode()===0&&
        window.__lingqModeTransition.modeEvents.some(event=>event.mode===0);
    }, { timeout: 10_000 });
    const inkEditors=await viewer.evaluate(() => [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)]
      .filter(editor=>editor.editorType==="ink").length);
    assert.equal(inkEditors, 1, "leaving Ink for LingQ READ must commit the completed stroke.");
    await page.waitForFunction(() => window.__lingqReadModeHost.pageQueries.length>0, { timeout: 10_000 });
    await page.mouse.click(iframeOffset.x+target.x,iframeOffset.y+target.y);
    await page.waitForFunction(() => window.__lingqReadModeHost.lookups.length===1, { timeout: 8_000 });
    const lookup=await page.evaluate(() => window.__lingqReadModeHost.lookups[0]);
    assert.ok(lookup.key && lookup.rawSurface, "A real text-layer click should reach the host vocabulary lookup.");
    assert.deepEqual(await page.evaluate(() => window.__lingqReadModeHost.toggleRequests), [true]);
    assert.deepEqual(await viewer.evaluate(() => window.__lingqModeTransition.modeEvents.map(event=>event.mode)), [15,0]);
    assert.deepEqual(await page.evaluate(() => window.__lingqReadModeHost.errors), []);
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
  }
  const finalError=attachCleanupErrors(primaryError,cleanupReport);
  if(finalError)throw finalError;
});
