import assert from "node:assert/strict";
import test from "node:test";
import { createReadStream } from "node:fs";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources, attachCleanupErrors } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = resolveBrowserPath();
const token = "observer-lifecycle-regression";

test("unresolved tombstones cannot poison Ink cleanup, block tools, or acknowledge a save", {
  skip: !browserPath && "Chrome or Edge is required", timeout: 90_000,
}, async () => {
  const runtime = await readBridgeRuntimeSource(process.env.PDF_READER_BRIDGE_SOURCE || undefined);
  const css = await readFile(path.join(root, "viewer-adapter/bridge.css"));
  const html = (await readFile(path.join(root, "vendor/pdfjs-generic-legacy/web/viewer.html"), "utf8"))
    .replace(/<head\b[^>]*>/i, head => `${head}<link rel="stylesheet" href="/bridge.css"><script src="/bridge.js" data-channel="pdf-web-reader" data-token="${token}" data-renderer-generation="observer-renderer" data-ios-input-policy="true" data-base-url="/vendor/pdfjs-generic-legacy/web/"></script>`);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style><iframe src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe><script>
        const frame=document.querySelector('iframe');
        window.messages=[];
        window.postToReader=message=>frame.contentWindow.postMessage({channel:'pdf-web-reader',token:'${token}',rendererGeneration:'observer-renderer',...message},'*');
        window.addEventListener('message',async event=>{
          if(event.source!==frame.contentWindow||event.data?.token!=='${token}')return;
          const message=event.data;messages.push(message);
          if(message.type==='ready')postToReader({type:'open',documentId:'observer-document',openRequest:1,filename:'fixture.pdf',readOnly:false,autoSave:false,vocabularyEnabled:false,data:await(await fetch('/tests/fixtures/tracemonkey.pdf')).arrayBuffer()});
          if(message.type==='annotation-source-identity')postToReader({type:'external-annotations-update',documentId:message.documentId,openRequest:message.openRequest,sourceMatch:'BASELINE_ESTABLISHED',identityConfirmed:true,externalAnnotations:{schemaVersion:1,kind:'pdf-annotation-snapshot',documentId:message.documentId,docKey:'observer-test',revision:0,legacyIdentities:[],source:{sourcePath:message.documentId,sourceHash:'xxh64-v1:observer-fixture',pageCount:message.pageCount,orderedPageIdentities:message.orderedPageIdentities},annotations:[]}});
        });</script>`);
      return;
    }
    if (url.pathname === "/bridge.js") { response.setHeader("content-type", "text/javascript"); response.end(runtime); return; }
    if (url.pathname === "/bridge.css") { response.setHeader("content-type", "text/css"); response.end(css); return; }
    if (url.pathname.endsWith("/web/viewer.html")) { response.setHeader("content-type", "text/html"); response.end(html); return; }
    const target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(`${root}${path.sep}`)) { response.writeHead(403).end(); return; }
    try {
      if (!(await stat(target)).isFile()) throw new Error("not a file");
      const mime = { ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".pdf": "application/pdf", ".svg": "image/svg+xml", ".wasm": "application/wasm", ".ftl": "text/plain" }[path.extname(target)];
      if (mime) response.setHeader("content-type", mime);
      createReadStream(target).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser, page, primaryError, cleanup;
  try {
    browser = await launchTestBrowser(puppeteer, { executablePath: browserPath, headless: true,
      args: ["--no-sandbox"] }, { testName: "annotation-observer-lifecycle" });
    page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 768, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => messages.some(message => message.type === "opened"));
    const frame = page.frames().find(item => item.url().includes("/web/viewer.html"));
    assert.ok(frame);
    await frame.waitForFunction(() => !document.documentElement.classList.contains("pdfReaderNativeAnnotationLayersPending"));
    await frame.evaluate(() => {
      window.observerErrors = [];
      window.observerPointerEvents = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        window.addEventListener(type, event => observerPointerEvents.push({type, trusted:event.isTrusted,
          pointerType:event.pointerType,x:event.clientX,y:event.clientY,
          target:event.target?.outerHTML?.slice(0,300)}), true);
      }
      window.addEventListener("error", event => observerErrors.push(event.message));
      window.addEventListener("unhandledrejection", event => observerErrors.push(String(event.reason?.message || event.reason)));
      PDFViewerApplication.pdfViewer.currentScale = 1;
      PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { source: window, mode: 15, createNewEditor: false });
    });
    await frame.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 15 &&
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getMode() === 15 &&
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getLayer(0)?.div.classList.contains('inkEditing') &&
      !document.documentElement.hasAttribute('data-pdf-reader-readonly'));
    await frame.evaluate(() => PDFViewerApplication.pdfDocument.annotationStorage
      .setValue("pdfjs_internal_editor_unbound_test", { deleted: true }));
    const cdp = await page.createCDPSession();
    const strokes = [];
    const stroke = async (offset) => {
      const before = await frame.evaluate(()=>({readOnly:document.documentElement.hasAttribute('data-pdf-reader-readonly'),
        managerMode:PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getMode()}));
      const point = await frame.evaluate(offset => {
        const bounds = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getLayer(0).div.getBoundingClientRect();
        return { x: Math.max(40, bounds.left + 120), y: Math.max(90, bounds.top + 160 + offset) };
      }, offset);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, button: "none", buttons: 0, pointerType: "pen" });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 1, pointerType: "pen" });
      for (let n = 1; n <= 6; n++) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x + n * 8, y: point.y + n * 6, button: "left", buttons: 1, pointerType: "pen" });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x + 48, y: point.y + 36, button: "left", buttons: 0, clickCount: 1, pointerType: "pen" });
      await frame.evaluate(() => PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getLayer(0).endDrawingSession(false));
      const expectedInkCount = strokes.length + 1;
      try {
        await frame.waitForFunction(expected => [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)]
          .filter(editor => editor.editorType === "ink").length === expected, { timeout: 5_000 }, expectedInkCount);
      } catch (error) {
        const failure = await frame.evaluate(point => {
          const viewer = PDFViewerApplication.pdfViewer;
          const manager = viewer._layerProperties.annotationEditorUIManager;
          const layer = manager.getLayer(0)?.div;
          const rect = layer?.getBoundingClientRect();
          return { point, mode: viewer.annotationEditorMode, managerMode: manager.getMode(),
            readOnly: document.documentElement.hasAttribute('data-pdf-reader-readonly'),
            scrollTop: document.getElementById('viewerContainer')?.scrollTop,
            layerClass: layer?.className, layerBounds: rect?.toJSON(),
            viewport: {width:innerWidth,height:innerHeight,scale:visualViewport?.scale},
            renderingState: viewer.getPageView(0)?.renderingState,
            pointerEvents: observerPointerEvents,
            hit: document.elementFromPoint(point.x, point.y)?.outerHTML?.slice(0, 500),
            editors: [...manager.getEditors(0)].map(editor => ({ id: editor.id, type: editor.editorType })),
            errors: observerErrors };
        }, point);
        const artifacts = resolveTestArtifactRoot(root);
        await mkdir(artifacts, { recursive: true });
        await writeFile(path.join(artifacts, 'annotation-observer-failure.json'), JSON.stringify({
          expectedInkCount, before, failure, strokes,
        }, null, 2));
        await page.screenshot({ path: path.join(artifacts, 'annotation-observer-failure.png') });
        throw error;
      }
      strokes.push(await frame.evaluate(point => ({ point, mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        editors: [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].map(editor => ({ id: editor.id, type: editor.editorType })),
        errors: observerErrors, hit: document.elementFromPoint(point.x, point.y)?.outerHTML?.slice(0, 300),
      }), point));
      strokes.at(-1).before = before;
    };
    await stroke(0);
    await stroke(90);
    const inkCount = await frame.evaluate(() => [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].filter(editor => editor.editorType === "ink").length);
    if (inkCount !== 2) {
      await mkdir(path.join(root, "tests/artifacts"), { recursive: true });
      await writeFile(path.join(root, "tests/artifacts/annotation-observer-failure.json"), JSON.stringify(strokes, null, 2));
    }
    assert.equal(inkCount, 2, "both strokes must become live editors after the original capture fault");
    for (const mode of [3, 9, 10, 5, 15, 0]) {
      await frame.evaluate(value => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
        source: window, mode: value, createNewEditor: false,
      }), mode);
      await frame.waitForFunction(value => PDFViewerApplication.pdfViewer.annotationEditorMode === value &&
        PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getMode() === value, {}, mode);
    }
    const saved = await frame.evaluate(() => PDFViewerApplication.save());
    assert.equal(saved, false, "the unbound deletion must still reject durable save");
    await page.waitForFunction(() => messages.some(message => message.type === "error" && /Deletion placeholder/.test(message.message)));
    assert.equal(await page.evaluate(() => messages.filter(message => message.type === "save").length), 0);
    await page.evaluate(() => postToReader({ type: "get-input-diagnostics", requestId: "observer-input" }));
    await page.waitForFunction(() => messages.some(message => message.type === "input-diagnostics"));
    const input = await page.evaluate(() => messages.findLast(message => message.type === "input-diagnostics"));
    assert.equal(input.activePointers, 0);
    assert.ok(input.annotationTrackingFailure);
    assert.deepEqual(await frame.evaluate(() => observerErrors), [], "neither guard failures nor Ink cleanup may escape to window error/unhandledrejection");
    await page.evaluate(() => postToReader({ type: "export-copy", requestId: "observer-export", documentId: "observer-document", openRequest: 1 }));
    await page.waitForFunction(() => messages.some(message => message.type === "export-error"));
    assert.equal(await page.evaluate(() => messages.filter(message => message.type === "export-ready").length), 0);
    await mkdir(path.join(root, "tests/artifacts"), { recursive: true });
    await writeFile(path.join(root, "tests/artifacts/annotation-observer-lifecycle.json"), JSON.stringify({
      platform: "Chromium mobile simulation", inkCount, input, strokes, tools: [3, 9, 10, 5, 15, 0], saved,
      errors: await frame.evaluate(() => observerErrors),
    }, null, 2));
  } catch (error) { primaryError = error; }
  finally { cleanup = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server }); }
  const error = attachCleanupErrors(primaryError, cleanup);
  if (error) throw error;
});
