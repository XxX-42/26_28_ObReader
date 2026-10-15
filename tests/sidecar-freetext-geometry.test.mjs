import assert from "node:assert/strict";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";

const browserPath = resolveBrowserPath();
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const viewerHtmlPath = path.join(
  root,
  "vendor",
  "pdfjs-generic-legacy",
  "web",
  "viewer.html",
);
const artifactsPath = path.join(root, "tests", "artifacts");
const channel = "pdf-web-reader";
const token = `sidecar-freetext-geometry-${Date.now()}-${process.pid}`;
const documentId = `sidecar-freetext-geometry-${Date.now()}`;
const rendererGeneration = `sidecar-freetext-geometry-${Date.now()}`;
const expectedText = "Hydrated FreeText geometry remains stable";
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

function rectMaxDelta(left, right) {
  assert.equal(left?.length, 4, "The durable FreeText rect must have four values");
  assert.equal(right?.length, 4, "The hydrated FreeText rect must have four values");
  return Math.max(...left.map((value, index) => Math.abs(value - right[index])));
}

test("real FreeText sidecar hydration preserves geometry at every rotation and scale", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 120_000,
}, async () => {
  const bridgeSource = await readFile(bridgePath, "utf8");
  const instrumentedBridgeSource = bridgeSource.replace(
    "  if (iosInputPolicy) {",
    "  window.__sidecarFreeTextGeometryBridgeState = state;\n  if (iosInputPolicy) {",
  );
  assert.notEqual(instrumentedBridgeSource, bridgeSource,
    "The browser harness should expose bridge state only for regression diagnostics");
  const viewerHtml = await readFile(viewerHtmlPath, "utf8");
  const viewerWithBridge = viewerHtml.replace(
    /<head\b[^>]*>/i,
    (head) => `${head}<script src="/viewer/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}"></script>`,
  );
  const sidecarHarnessScript = browserSidecarHarnessScript({ channel, token });
  let browser;
  let page;
  let server;
  let primaryError = null;
  let cleanupReport = null;

  server = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(withTestNetworkFirewall())) {
      response.setHeader(name, value);
    }
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="PDF Reader" src="/viewer/web/viewer.html"></iframe>
        ${sidecarHarnessScript}
        <script>
          const channel=${JSON.stringify(channel)};
          const token=${JSON.stringify(token)};
          const documentId=${JSON.stringify(documentId)};
          const rendererGeneration=${JSON.stringify(rendererGeneration)};
          const iframe=document.querySelector('iframe');
          const host=window.__sidecarFreeTextGeometryHost={opened:null,saves:[],errors:[]};
          let sourceBytes=null;
          let nextOpenRequest=0;
          const sendOpen=openRequest=>{
            if(!(sourceBytes instanceof ArrayBuffer))throw new Error('PDF source bytes are not ready');
            const data=sourceBytes.slice(0);
            iframe.contentWindow.postMessage({
              channel,type:'open',token,documentId,rendererGeneration,
              documentPath:'tests/fixtures/tracemonkey.pdf',filename:'tracemonkey.pdf',
              autoSave:false,openRequest,data,
            },'*',[data]);
          };
          host.reopen=()=>{
            nextOpenRequest+=1;
            sendOpen(nextOpenRequest);
            return nextOpenRequest;
          };
          host.advanceOperation=(uuid,sequence)=>{
            const document=window.__browserSidecarHost.documents.get(documentId);
            const previous=document?.operations.get(uuid);
            if(!previous?.clock)throw new Error('No durable FreeText operation to advance');
            const operation=structuredClone(previous);
            operation.clock={...operation.clock,
              timestamp:Math.max(Date.now(),Number(operation.clock.timestamp)||0)+sequence,
              logical:0,opId:'geometry-hydrate-'+sequence};
            document.operations.set(uuid,operation);
            document.revision+=1;
            return {timestamp:operation.clock.timestamp,revision:document.revision};
          };
          window.addEventListener('message',event=>{
            if(event.source!==iframe.contentWindow)return;
            const message=event.data;
            if(!message||message.channel!==channel||message.token!==token)return;
            if(message.type==='ready'){
              fetch('/tests/fixtures/tracemonkey.pdf').then(response=>response.arrayBuffer()).then(data=>{
                sourceBytes=data;
                nextOpenRequest=1;
                sendOpen(nextOpenRequest);
              }).catch(error=>host.errors.push(String(error?.message||error)));
            }else if(message.type==='opened'){
              host.opened={documentId:message.documentId,openRequest:message.openRequest,revision:message.revision};
            }else if(message.type==='save'){
              const save={documentId:message.documentId,requestId:message.requestId,
                openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,
                revision:message.revision,operations:message.operations};
              host.saves.push(save);
              setTimeout(()=>iframe.contentWindow.postMessage({
                channel,type:'saved',token,documentId:message.documentId,
                openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,
                requestId:message.requestId,revision:message.revision,
              },'*'),10);
            }else if(message.type==='error'){
              host.errors.push(message.message||message.code||'viewer error');
            }
          });
        </script>`);
      return;
    }
    if (url.pathname === "/viewer/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(viewerWithBridge);
      return;
    }
    if (url.pathname === "/viewer/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(instrumentedBridgeSource);
      return;
    }

    let target;
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") {
      target = fixture;
    } else if (url.pathname.startsWith("/build/")) {
      target = path.resolve(root, "vendor", "pdfjs-generic-legacy", decodeURIComponent(url.pathname.slice(1)));
    } else if (url.pathname.startsWith("/viewer/")) {
      target = path.resolve(root, "vendor", "pdfjs-generic-legacy", decodeURIComponent(url.pathname.slice("/viewer/".length)));
    } else {
      response.writeHead(404).end("not found");
      return;
    }
    const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
    const relativeTarget = path.relative(vendorRoot, target);
    if (target !== fixture && (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget))) {
      response.writeHead(403).end("forbidden");
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

  try {
    await mkdir(artifactsPath, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "sidecar-freetext-geometry", artifactsDir: artifactsPath });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`, {
      waitUntil: "domcontentloaded",
    });
    const viewer = page.frames().find((frame) => frame.url().includes("/viewer/web/viewer.html"));
    assert.ok(viewer, "The PDF.js Reader iframe should load");
    await page.waitForFunction(() =>
      window.__sidecarFreeTextGeometryHost?.opened?.openRequest === 1,
    { timeout: 20_000 });
    await viewer.waitForFunction(() => {
      const bridge = window.__sidecarFreeTextGeometryBridgeState;
      const button = document.getElementById("editorFreeTextButton");
      return Boolean(PDFViewerApplication?.pdfDocument && bridge?.externalSourceConfirmed &&
        button && !button.disabled);
    }, { timeout: 20_000 });

    await viewer.evaluate(async () => {
      const pdfViewer = PDFViewerApplication.pdfViewer;
      pdfViewer.pagesRotation = 90;
      pdfViewer.currentScaleValue = "page-fit";
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await viewer.waitForFunction(() =>
      PDFViewerApplication.pdfViewer.getPageView(0)?.rotation === 90,
    { timeout: 10_000 });
    await viewer.evaluate(() => {
      document.getElementById("editorFreeTextButton").click();
    });
    await viewer.waitForFunction(() => {
      const layer = document.querySelector('.page[data-page-number="1"] .annotationEditorLayer');
      const rect = layer?.getBoundingClientRect();
      return Boolean(rect?.width > 0 && rect?.height > 0);
    }, { timeout: 10_000 });
    await viewer.waitForFunction(() =>
      PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
    { timeout: 5_000 });
    const point = await viewer.evaluate(() => {
      const rect = document.querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 300, y: rect.top + 350 };
    });
    const iframeOffset = await page.$eval("iframe", (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    await page.mouse.click(iframeOffset.x + point.x, iframeOffset.y + point.y);
    const editorSelector = '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal';
    await viewer.waitForSelector(editorSelector, { timeout: 5_000 });
    await page.keyboard.type(expectedText);
    await page.keyboard.down("Control");
    try {
      await page.keyboard.press("Enter");
    } finally {
      await page.keyboard.up("Control");
    }
    await viewer.waitForFunction((value) => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const editor = [...manager.getEditors(0)].find((candidate) =>
        candidate.deleted !== true &&
        (candidate.constructor?._editorType === 3 || candidate.editorType === "freetext"),
      );
      const serialized = editor?.serialize?.(true);
      const rect = editor?.div?.getBoundingClientRect();
      return Boolean(serialized?.value === value && Array.isArray(serialized.rect) &&
        serialized.rect[2] > serialized.rect[0] && serialized.rect[3] > serialized.rect[1] &&
        editor.div.querySelector(".internal")?.textContent === value &&
        rect?.width > 0 && rect?.height > 0);
    }, { timeout: 10_000 }, expectedText);

    await viewer.evaluate(() => PDFViewerApplication.save());
    await page.waitForFunction(() => window.__sidecarFreeTextGeometryHost.saves.some((save) =>
      save.operations?.some((operation) => operation.kind === "FreeText" && operation.deleted !== true),
    ), { timeout: 15_000 });
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 10_000 });
    const persisted = await page.evaluate((currentDocumentId) =>
      window.__browserSidecarHost.operationsFor(currentDocumentId)
        .find((operation) => operation.kind === "FreeText" && operation.deleted !== true),
    documentId);
    assert.ok(persisted, "The host must durably retain the real FreeText operation");
    assert.equal(persisted.payload?.editor?.value, expectedText);
    const expectedRect = persisted.payload?.editor?.rect;
    assert.equal(persisted.payload?.editor?.rotation, 90,
      "The real user-created FreeText payload should retain its annotation rotation separately from view rotation");
    assert.ok(Array.isArray(expectedRect) && expectedRect.length === 4 && expectedRect.every(Number.isFinite),
      `The durable operation must contain a finite source-space rect; got ${JSON.stringify(expectedRect)}`);
    assert.ok(expectedRect[2] > expectedRect[0] && expectedRect[3] > expectedRect[1],
      `The durable operation rect must have positive area; got ${JSON.stringify(expectedRect)}`);

    const reopenRequest = await page.evaluate(() => window.__sidecarFreeTextGeometryHost.reopen());
    assert.equal(reopenRequest, 2);
    await page.waitForFunction((openRequest) =>
      window.__sidecarFreeTextGeometryHost.opened?.openRequest === openRequest,
    { timeout: 20_000 }, reopenRequest);
    await viewer.waitForFunction((openRequest) => {
      const bridge = window.__sidecarFreeTextGeometryBridgeState;
      return bridge?.activeOpenRequest === openRequest && bridge.externalSourceConfirmed &&
        PDFViewerApplication.pdfDocument;
    }, { timeout: 20_000 }, reopenRequest);
    await viewer.waitForFunction((uuid) => {
      const bridge = window.__sidecarFreeTextGeometryBridgeState;
      const binding = bridge?.externalAnnotationHydration.get(uuid);
      const editor = binding && PDFViewerApplication.pdfViewer._layerProperties
        .annotationEditorUIManager.getEditor(binding.runtimeId);
      const rect = editor?.serialize?.(true)?.rect;
      const visible = editor?.div?.getBoundingClientRect();
      return Boolean(binding && editor?.div?.querySelector(".internal")?.textContent &&
        rect?.length === 4 && visible?.width > 0 && visible?.height > 0);
    }, { timeout: 20_000 }, persisted.uuid);

    const transforms = [
      { rotation: 0, scale: 0.75 }, { rotation: 0, scale: 1.5 },
      { rotation: 90, scale: 0.75 }, { rotation: 90, scale: 1.5 },
      { rotation: 180, scale: 0.75 }, { rotation: 180, scale: 1.5 },
      { rotation: 270, scale: 0.75 }, { rotation: 270, scale: 1.5 },
    ];
    for (const [index, transform] of transforms.entries()) {
      await viewer.evaluate(async ({ rotation, scale }) => {
        const pdfViewer = PDFViewerApplication.pdfViewer;
        pdfViewer.pagesRotation = rotation;
        pdfViewer.currentScaleValue = String(scale);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, transform);
      await viewer.waitForFunction(({ rotation, scale }) => {
        const pdfViewer = PDFViewerApplication.pdfViewer;
        const pageView = pdfViewer.getPageView(0);
        return pageView?.rotation === rotation && Math.abs(pdfViewer.currentScale - scale) < 0.02;
      }, { timeout: 10_000 }, transform);

      const advanced = await page.evaluate(({ uuid, sequence }) =>
        window.__sidecarFreeTextGeometryHost.advanceOperation(uuid, sequence),
      { uuid: persisted.uuid, sequence: index + 1 });
      assert.ok(await page.evaluate(({ currentDocumentId, openRequest }) =>
        window.__browserSidecarHost.broadcastSnapshot(currentDocumentId, openRequest),
      { currentDocumentId: documentId, openRequest: reopenRequest }),
      `The host must broadcast the replay at ${transform.rotation}°/${transform.scale}x`);
      await viewer.waitForFunction(({ uuid, timestamp }) =>
        window.__sidecarFreeTextGeometryBridgeState.externalAnnotationHydration
          .get(uuid)?.row?.clock?.timestamp === timestamp,
      { timeout: 10_000 }, { uuid: persisted.uuid, timestamp: advanced.timestamp });

      const hydrated = await viewer.evaluate((uuid) => {
        const bridge = window.__sidecarFreeTextGeometryBridgeState;
        const binding = bridge.externalAnnotationHydration.get(uuid);
        const editor = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager.getEditor(binding.runtimeId);
        const rect = editor?.serialize?.(true)?.rect || [];
        const visible = editor?.div?.getBoundingClientRect();
        return {
          rect: Array.from(rect),
          text: (editor?.div?.querySelector(".internal")?.textContent || "")
            .replaceAll("\u00a0", " "),
          visible: Boolean(visible?.width > 0 && visible?.height > 0),
          ownInitialTranslation: Object.prototype.hasOwnProperty.call(editor, "getInitialTranslation"),
        };
      }, persisted.uuid);
      assert.equal(hydrated.text, expectedText,
        `The editor text must survive ${transform.rotation}°/${transform.scale}x hydration`);
      assert.equal(hydrated.visible, true,
        `The editor must remain visible at ${transform.rotation}°/${transform.scale}x`);
      assert.equal(hydrated.ownInitialTranslation, false,
        "The inherited PDF.js translation method must be restored after each layer.add");
      const maxDelta = rectMaxDelta(expectedRect, hydrated.rect);
      assert.ok(maxDelta < 0.05,
        `Hydration changed the source rect at ${transform.rotation}°/${transform.scale}x by ${maxDelta} PDF points: expected ${JSON.stringify(expectedRect)}, got ${JSON.stringify(hydrated.rect)}`);
      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 5_000 });
    }
    assert.deepEqual(await page.evaluate(() => window.__sidecarFreeTextGeometryHost.errors), []);
  } catch (error) {
    primaryError = error;
    try {
      const state = page && !page.isClosed() ? await page.evaluate((currentDocumentId) => {
        const bridge = document.querySelector("iframe")?.contentWindow
          ?.__sidecarFreeTextGeometryBridgeState;
        const manager = bridge?.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
        return {
          host: window.__sidecarFreeTextGeometryHost,
          durableOperations: window.__browserSidecarHost?.operationsFor(currentDocumentId),
          bridge: bridge ? {
            activeOpenRequest: bridge.activeOpenRequest,
            revision: bridge.revision,
            dirty: bridge.dirty,
            sourceConfirmed: bridge.externalSourceConfirmed,
            hydration: [...bridge.externalAnnotationHydration.entries()].map(([uuid, binding]) => ({
              uuid, runtimeId: binding.runtimeId, pageIndex: binding.pageIndex,
              clock: binding.row?.clock,
            })),
            editors: manager ? [...manager.getEditors(0)].map((editor) => ({
              id: String(editor.id),
              rect: Array.from(editor.serialize?.(true)?.rect || []),
              text: editor.serialize?.(true)?.value ?? null,
            })) : [],
          } : null,
        };
      }, documentId) : null;
      const artifact = path.join(artifactsPath, `sidecar-freetext-geometry-failure-${Date.now()}.json`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(artifact, `${JSON.stringify({
        error: error.stack || String(error),
        state,
      }, null, 2)}\n`);
      console.error(`FreeText geometry regression evidence: ${artifact}`);
    } catch (diagnosticError) {
      console.error("Could not capture FreeText geometry diagnostics:", diagnosticError.message);
    }
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
  }
  const finalError = attachCleanupErrors(primaryError, cleanupReport);
  if (finalError) throw finalError;
});
