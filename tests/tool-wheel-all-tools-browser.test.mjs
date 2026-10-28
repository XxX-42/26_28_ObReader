import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources, attachCleanupErrors } from "./browser-test-cleanup.mjs";
import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const browserPath = resolveBrowserPath();
const channel = "pdf-web-reader";
const token = "tool-wheel-lingq-browser-regression";
const documentId = "tool-wheel-lingq-document";
const rendererGeneration = "tool-wheel-lingq-renderer";
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

test("wheel color selection applies after host confirmation", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 90_000,
}, async () => {
  const [bridgeSource, bridgeCss, viewerHtml] = await Promise.all([
    readBridgeRuntimeSource(),
    readFile(path.join(root, "viewer-adapter", "bridge.css"), "utf8"),
    readFile(path.join(vendorRoot, "web", "viewer.html"), "utf8"),
  ]);
  const viewerWithBridge = viewerHtml.replace(
    /<head\b[^>]*>/i,
    (head) => `${head}<link rel="stylesheet" href="/viewer-adapter/bridge.css"><script src="/viewer-adapter/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}" data-base-url="/vendor/pdfjs-generic-legacy/web/"></script>`,
  );
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><title>Tool wheel regression</title>
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
        ${browserSidecarHarnessScript({ channel, token })}
        <script>
          (() => {
            const channel=${JSON.stringify(channel)}, token=${JSON.stringify(token)};
            const iframe=document.querySelector('iframe');
            const host=window.__host={opened:0,openRequest:0,vocabularyEnabled:false,toggleRequests:[],colorRequests:[]};
            const sendOpen=data=>{
              const openRequest=++host.openRequest;
              iframe.contentWindow.postMessage({channel,token,type:'open',documentId:${JSON.stringify(documentId)},filename:'tracemonkey.pdf',openRequest,data,readOnly:false,autoSave:false,vocabularyEnabled:host.vocabularyEnabled},'*',[data]);
            };
            host.fixturePromise=fetch('/tests/fixtures/tracemonkey.pdf').then(response=>response.arrayBuffer());
            window.addEventListener('message',event=>{
              if(event.source!==iframe.contentWindow||!event.data||event.data.channel!==channel||event.data.token!==token)return;
              const message=event.data;
              if(message.type==='ready'){
                host.rendererGeneration=message.rendererGeneration;
                host.fixturePromise.then(bytes=>sendOpen(bytes.slice(0)));
              } else if(message.type==='opened') host.opened++;
              else if(message.type==='annotation-tool-color-preference-request') {
                host.colorRequests.push(message);
                iframe.contentWindow.postMessage({channel,token,type:'annotation-tool-color-preference-update',rendererGeneration:host.rendererGeneration,documentId:message.documentId,openRequest:message.openRequest,colors:{[message.mode]:message.color}},'*');
              }
              else if(message.type==='vocab-toggle-request'){
                host.vocabularyEnabled=message.enabled===true;
                host.toggleRequests.push(host.vocabularyEnabled);
                iframe.contentWindow.postMessage({channel,token,type:'vocab-set-enabled',rendererGeneration:host.rendererGeneration,documentId:message.documentId,openRequest:message.openRequest,enabled:host.vocabularyEnabled},'*');
              }
            });
          })();
        </script>`);
      return;
    }
    let target;
    if (url.pathname === "/viewer-adapter/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (url.pathname === "/viewer-adapter/bridge.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(bridgeCss);
      return;
    }
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(viewerWithBridge);
      return;
    }
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") target = fixture;
    else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
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
    }, { testName: "tool-wheel-lingq-browser" });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__host?.opened === 1, { timeout: 45_000 });
    const viewer = page.frames().find((frame) => frame.url().includes("/web/viewer.html"));
    assert.ok(viewer, "The PDF.js frame should be available after the host handshake.");
    await viewer.waitForFunction(() => {
      const app=window.PDFViewerApplication;
      return app?.pdfDocument && app?.pdfViewer?.getPageView(0)?.renderingState === 3;
    }, { timeout: 30_000 });
    const offset = await page.$eval("iframe", (frame) => {
      const rect=frame.getBoundingClientRect(); return {x:rect.x,y:rect.y};
    });
    const center = await viewer.evaluate(() => {
      const rect=document.getElementById("viewerContainer").getBoundingClientRect();
      return {x:rect.left+rect.width*0.72,y:rect.top+rect.height*0.55};
    });
    const cases = [
      { index: 2, mode: 15, type: 21, color: '#1971C2', control: 'editorInkColor' },
      { index: 3, mode: 9, type: 31, color: '#53FFBC' },
      { index: 4, mode: 5, type: 61, color: '#E03131', control: 'editorSquareColor' },
      { index: 5, mode: 10, type: 51, color: '#2F9E44', control: 'editorUnderlineColor' },
    ];
    await viewer.evaluate(() => {
      window.__colorEvents = [];
      PDFViewerApplication.eventBus._on('switchannotationeditorparams', event => window.__colorEvents.push({type:event.type,value:event.value}));
    });
    for (const [iteration, spec] of cases.entries()) {
      await page.mouse.move(offset.x+center.x, offset.y+center.y);
      await page.mouse.down({button:'middle'});
      await viewer.waitForSelector('.pdfToolWheel');
      const angle = (270 + spec.index * 60) * Math.PI / 180;
      await page.mouse.move(offset.x+center.x+70*Math.cos(angle), offset.y+center.y+70*Math.sin(angle), {steps:3});
      await viewer.waitForSelector(`.pdfToolWheelColors [data-color="${spec.color}"]`, {timeout:5000});
      const swatch = await viewer.$eval(`.pdfToolWheelColors [data-color="${spec.color}"]`, node => {
        const r = node.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
      });
      await page.mouse.move(offset.x+swatch.x, offset.y+swatch.y, {steps:3});
      await page.mouse.up({button:'middle'});
      await page.waitForFunction(n => window.__host.colorRequests.length === n, {timeout:5000}, iteration+1);
      const request = await page.evaluate(n => window.__host.colorRequests[n], iteration);
      assert.equal(request.mode, spec.mode); assert.equal(request.color, spec.color);
      await viewer.waitForFunction(spec => window.__colorEvents.some(event => event.type === spec.type && event.value === spec.color), {timeout:5000}, spec);
      assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), spec.mode);
      if (spec.control) await viewer.waitForFunction(spec => document.getElementById(spec.control).value.toUpperCase() === spec.color, {timeout:5000}, spec);

    }
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
  }
  const finalError = attachCleanupErrors(primaryError, cleanupReport);
  if (finalError) throw finalError;
});
