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
const token = `sidecar-freetext-${Date.now()}-${process.pid}`;
const documentId = "sidecar-freetext-hydration-fixture";
const rendererGeneration = `sidecar-freetext-renderer-${Date.now()}`;
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

test("FreeText sidecar capture keeps geometry and self-echo hydration adopts the live editor", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 60_000,
}, async () => {
  const fixtureBytes = await readFile(fixture);
  const bridgeSource = await readFile(bridgePath, "utf8");
  const instrumentedBridgeSource = bridgeSource.replace(
    "  if (iosInputPolicy) {",
    "  window.__sidecarFreeTextBridgeState = state;\n  if (iosInputPolicy) {",
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
  let geometryBeforeSave = null;

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
          const host=window.__sidecarFreeTextHost={opened:null,saves:[],errors:[]};
          window.addEventListener('message',event=>{
            if(event.source!==iframe.contentWindow)return;
            const message=event.data;
            if(!message||message.channel!==channel||message.token!==token)return;
            if(message.type==='ready'){
              fetch('/tests/fixtures/tracemonkey.pdf').then(response=>response.arrayBuffer()).then(data=>{
                iframe.contentWindow.postMessage({
                  channel,type:'open',token,documentId,rendererGeneration,
                  documentPath:'tests/fixtures/tracemonkey.pdf',filename:'tracemonkey.pdf',
                  autoSave:false,openRequest:1,data,
                },'*',[data]);
              }).catch(error=>host.errors.push(String(error?.message||error)));
            }else if(message.type==='opened'){
              host.opened={documentId:message.documentId,openRequest:message.openRequest,revision:message.revision};
            }else if(message.type==='save'){
              const save={documentId:message.documentId,requestId:message.requestId,
                openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,
                revision:message.revision,byteLength:message.data?.byteLength||0,
                operations:message.operations};
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
      const relative = decodeURIComponent(url.pathname.slice(1));
      target = path.resolve(root, "vendor", "pdfjs-generic-legacy", relative);
      const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
      if (!target.startsWith(`${vendorRoot}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
    } else if (url.pathname.startsWith("/viewer/")) {
      const relative = decodeURIComponent(url.pathname.slice("/viewer/".length));
      target = path.resolve(root, "vendor", "pdfjs-generic-legacy", relative);
      const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
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
    }, { testName: "sidecar-freetext-hydration", artifactsDir: artifactsPath });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`, {
      waitUntil: "domcontentloaded",
    });
    const viewer = page.frames().find((frame) => frame.url().includes("/viewer/web/viewer.html"));
    assert.ok(viewer, "The PDF.js Reader iframe should load");
    await page.waitForFunction(() => window.__sidecarFreeTextHost?.opened?.openRequest === 1, {
      timeout: 20_000,
    });
    await viewer.waitForFunction(() => {
      const bridge = window.__sidecarFreeTextBridgeState;
      const app = window.PDFViewerApplication;
      const button = document.getElementById("editorFreeTextButton");
      return Boolean(app?.pdfDocument && bridge?.externalSourceConfirmed && button && !button.disabled);
    }, { timeout: 20_000 });
    await viewer.evaluate(async () => {
      PDFViewerApplication.pdfViewer.currentScaleValue = "page-fit";
      await new Promise(requestAnimationFrame);
      document.getElementById("editorFreeTextButton").click();
    });
    await viewer.waitForFunction(() => {
      const pageView = PDFViewerApplication.pdfViewer.getPageView(0);
      const layer = document.querySelector(
        '.page[data-page-number="1"] .annotationEditorLayer',
      );
      const rect = layer?.getBoundingClientRect();
      return Boolean(pageView?.pdfPage && layer?.isConnected && rect?.width > 0 && rect?.height > 0);
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
    const selector = '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal';
    await viewer.waitForSelector(selector, { timeout: 5_000 });
    await viewer.type(selector, "Durable geometry survives sidecar hydration");
    await viewer.waitForFunction(() => {
      const internal = document.querySelector(
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
      );
      const editor = internal?.closest(".freeTextEditor");
      const rect = editor?.getBoundingClientRect();
      return Boolean(
        internal?.textContent?.includes("Durable geometry survives sidecar hydration") &&
        rect?.width > 0 && rect?.height > 0,
      );
    }, { timeout: 5_000 });
    geometryBeforeSave = await viewer.evaluate(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const editor = [...manager.getEditors(0)].find((candidate) =>
        candidate.deleted !== true &&
        (candidate.constructor?._editorType === 3 || candidate.editorType === "freetext"),
      );
      const rawId = String(editor.id);
      const storageMap = PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map;
      const storageEntry = storageMap instanceof Map
        ? [...storageMap.entries()].find(([id]) => String(id) === rawId)?.[1]
        : null;
      return {
        runtimeId: rawId,
        liveRect: Array.from(editor.serialize?.(true)?.rect || []),
        storageRect: Array.from(storageEntry?.rect || []),
        value: editor.serialize?.(true)?.value ?? null,
      };
    });
    await viewer.evaluate(() => PDFViewerApplication.save());
    await page.waitForFunction(() => window.__sidecarFreeTextHost.saves.some((save) =>
      save.operations?.some((operation) => operation.kind === "FreeText" && operation.deleted !== true),
    ), { timeout: 10_000 });
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), {
      timeout: 10_000,
    });

    const persisted = await page.evaluate((currentDocumentId) =>
      window.__browserSidecarHost.operationsFor(currentDocumentId)
        .find((operation) => operation.kind === "FreeText" && operation.deleted !== true),
    documentId);
    assert.ok(persisted, "The host must persist the live FreeText sidecar operation");
    assert.equal(persisted.payload?.editor?.value,
      "Durable geometry survives sidecar hydration");
    const rect = persisted.payload?.editor?.rect;
    assert.ok(Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite),
      `The durable FreeText operation must carry four finite source-space bounds; got ${JSON.stringify(rect)}`);
    assert.ok(rect[2] > rect[0] && rect[3] > rect[1],
      `The durable FreeText bounds must have positive area; got ${JSON.stringify(rect)}`);

    const beforeEcho = await viewer.evaluate(() => {
      const bridge = window.__sidecarFreeTextBridgeState;
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const editors = [...manager.getEditors(0)].filter((editor) =>
        editor.deleted !== true &&
          (editor.constructor?._editorType === 3 || editor.editorType === "freetext"),
      );
      return {
        editors: editors.map((editor) => ({
          id: String(editor.id),
          uuid: bridge.annotationUuidByRuntimeId.get(String(editor.id)) || null,
          rect: Array.from(editor.serialize?.(true)?.rect || []),
        })),
        operation: bridge.annotationOperations.find(({ operation }) =>
          operation.uuid === bridge.annotationUuidByRuntimeId.get(String(editors[0]?.id)),
        )?.operation || null,
      };
    });
    assert.equal(beforeEcho.editors.length, 1,
      "The saved FreeText operation should still be represented by one live editor before replay");
    assert.equal(beforeEcho.editors[0].uuid, persisted.uuid,
      "The live editor UUID must equal the acknowledged sidecar UUID");
    assert.ok(await page.evaluate(({ currentDocumentId, openRequest }) =>
      window.__browserSidecarHost.broadcastSnapshot(currentDocumentId, openRequest),
    { currentDocumentId: documentId, openRequest: 1 }),
    "The host should replay its durable sidecar snapshot to the originating Reader");
    await viewer.waitForFunction((uuid) =>
      window.__sidecarFreeTextBridgeState.externalAnnotationHydration.has(uuid),
    { timeout: 5_000 }, persisted.uuid);
    const afterEcho = await viewer.evaluate((uuid) => {
      const bridge = window.__sidecarFreeTextBridgeState;
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const editors = [...manager.getEditors(0)].filter((editor) =>
        editor.deleted !== true &&
          (editor.constructor?._editorType === 3 || editor.editorType === "freetext"),
      );
      const editor = editors.find((candidate) =>
        bridge.annotationUuidByRuntimeId.get(String(candidate.id)) === uuid,
      );
      const rect = editor?.div?.getBoundingClientRect();
      return {
        editorCount: editors.length,
        ids: editors.map((candidate) => String(candidate.id)),
        bindingRuntimeId: bridge.externalAnnotationHydration.get(uuid)?.runtimeId || null,
        editorId: editor ? String(editor.id) : null,
        text: editor?.serialize?.(true)?.value ?? null,
        connected: Boolean(editor?.div?.isConnected),
        rect: rect ? [rect.left, rect.top, rect.right, rect.bottom] : null,
      };
    }, persisted.uuid);
    assert.equal(afterEcho.editorCount, 1,
      "Self-echo hydration must not create a duplicate FreeText editor");
    assert.deepEqual(afterEcho.ids, [beforeEcho.editors[0].id],
      "Self-echo hydration must adopt the original PDF.js runtime editor");
    assert.equal(afterEcho.bindingRuntimeId, beforeEcho.editors[0].id);
    assert.equal(afterEcho.editorId, beforeEcho.editors[0].id);
    assert.equal(afterEcho.text, "Durable geometry survives sidecar hydration");
    assert.equal(afterEcho.connected, true,
      "The adopted FreeText editor must remain connected and visible");
    assert.ok(afterEcho.rect && afterEcho.rect[2] > afterEcho.rect[0] && afterEcho.rect[3] > afterEcho.rect[1],
      `The hydrated FreeText editor must have a visible rectangle; got ${JSON.stringify(afterEcho.rect)}`);
    assert.deepEqual(await page.evaluate(() => window.__sidecarFreeTextHost.errors), []);
  } catch (error) {
    primaryError = error;
    try {
      const state = page && !page.isClosed() ? await page.evaluate(() => ({
        host: window.__sidecarFreeTextHost,
        sidecarWrites: window.__browserSidecarHost?.durableWrites,
        sidecarOperations: window.__browserSidecarHost?.operationsFor("sidecar-freetext-hydration-fixture"),
        bridge: (() => {
          const bridge = document.querySelector("iframe")?.contentWindow?.__sidecarFreeTextBridgeState;
          if (!bridge) return null;
          const manager = bridge.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
          return {
            revision: bridge.revision,
            confirmedRevision: bridge.confirmedRevision,
            dirty: bridge.dirty,
            sourceConfirmed: bridge.externalSourceConfirmed,
            externalAnnotationHydration: [...bridge.externalAnnotationHydration.entries()].map(([uuid, binding]) => ({
              uuid, runtimeId: binding.runtimeId, pageIndex: binding.pageIndex,
            })),
            editors: manager ? [...manager.getEditors(0)].map((editor) => ({
              id: String(editor.id),
              type: editor.constructor?._editorType || editor.editorType,
              rect: Array.from(editor.serialize?.(true)?.rect || []),
              value: editor.serialize?.(true)?.value ?? null,
            })) : [],
          };
        })(),
      })) : null;
      const artifact = path.join(artifactsPath, `sidecar-freetext-hydration-failure-${Date.now()}.json`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(artifact, `${JSON.stringify({
        error: error.stack || String(error),
        bridgeSha256: (await import("node:crypto")).createHash("sha256").update(bridgeSource).digest("hex"),
        fixtureSha256: (await import("node:crypto")).createHash("sha256").update(fixtureBytes).digest("hex"),
        geometryBeforeSave: typeof geometryBeforeSave === "undefined" ? null : geometryBeforeSave,
        state,
      }, null, 2)}\n`);
      console.error(`FreeText sidecar regression evidence: ${artifact}`);
    } catch (diagnosticError) {
      console.error("Could not capture FreeText sidecar diagnostic metadata:", diagnosticError.message);
    }
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
  }
  const finalError = attachCleanupErrors(primaryError, cleanupReport);
  if (finalError) throw finalError;
});
