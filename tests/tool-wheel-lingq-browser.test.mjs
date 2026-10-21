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

test("middle-button LingQ toggle stays visible through hover and toggles on release", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 90_000,
}, async () => {
  const [bridgeSource, bridgeCss, viewerHtml] = await Promise.all([
    readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8"),
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
            const host=window.__host={opened:0,openRequest:0,vocabularyEnabled:false,toggleRequests:[]};
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
    const toggleOnRelease = async (expected) => {
      const countBefore = await page.evaluate(() => window.__host.toggleRequests.length);
      await page.mouse.move(offset.x+center.x, offset.y+center.y);
      await page.mouse.down({button:"middle"});
      await viewer.waitForSelector(".pdfToolWheel", {timeout:5_000});
      await page.mouse.move(offset.x+center.x, offset.y+center.y-70, {steps:3});
      assert.ok(await viewer.$(".pdfToolWheel"), "LingQ hover preview must leave the wheel open.");
      assert.equal(await page.evaluate(() => window.__host.toggleRequests.length), countBefore,
        "Hovering must not issue a toggle before the middle-button release.");
      await page.mouse.up({button:"middle"});
      await page.waitForFunction((value) => window.__host.vocabularyEnabled === value,
        {timeout:5_000}, expected);
      await viewer.waitForFunction(() => !document.querySelector(".pdfToolWheel"), {timeout:5_000});
      assert.equal(await page.evaluate(() => window.__host.toggleRequests.length), countBefore+1,
        "Releasing on the LingQ sector should issue exactly one toggle request.");
    };
    const readLingQWheelAppearance = async (expectedEnabled) => {
      const countBefore = await page.evaluate(() => window.__host.toggleRequests.length);
      await page.mouse.move(offset.x+center.x, offset.y+center.y);
      await page.mouse.down({button:"middle"});
      await viewer.waitForSelector(".pdfToolWheel", {timeout:5_000});
      const appearance = await viewer.evaluate(() => {
        const sector = document.querySelector(".pdfToolWheel svg > path:first-of-type");
        const label = document.querySelector('.pdfToolWheel button[data-sector="0"]');
        return {
          enabled: document.documentElement.dataset.vocabularyEnabled === "true",
          fill: sector && getComputedStyle(sector).fill,
          labelColor: label && getComputedStyle(label).color,
          fontWeight: label && getComputedStyle(label).fontWeight,
        };
      });
      assert.equal(appearance.enabled, expectedEnabled,
        "The wheel appearance must reflect the bridge's acknowledged vocabulary state.");
      assert.equal(appearance.fill, expectedEnabled ? "rgb(105, 87, 213)" : "rgba(48, 52, 59, 0.933)",
        "The LingQ wedge should be visibly selected only while LingQ is enabled.");
      assert.equal(appearance.labelColor, "rgb(255, 255, 255)",
        "The deployed wheel keeps the LingQ caption readable on its accent wedge.");
      assert.equal(await page.evaluate(() => window.__host.toggleRequests.length), countBefore,
        "Opening and closing the wheel must not change the persisted LingQ state.");
      await page.mouse.up({button:"middle"});
      await viewer.waitForFunction(() => !document.querySelector(".pdfToolWheel"), {timeout:5_000});
    };
    await toggleOnRelease(true);
    await readLingQWheelAppearance(true);
    await toggleOnRelease(false);
    await readLingQWheelAppearance(false);
    assert.deepEqual(await page.evaluate(() => window.__host.toggleRequests), [true, false]);

    const readOnlyCenter = await viewer.evaluate(() => {
      const rect = document.getElementById("viewerContainer").getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await viewer.evaluate(() => {
      const pdfViewer = PDFViewerApplication.pdfViewer;
      window.__toolWheelPermissionOverride = {
        pdfViewer,
        descriptor: Object.getOwnPropertyDescriptor(pdfViewer, "annotationEditorMode"),
      };
      Object.defineProperty(pdfViewer, "annotationEditorMode", {
        configurable: true,
        get: () => -1,
      });
    });
    let permissionProbePointerHeld = false;
    const sectorPoint = (index) => {
      const angle = ((index * 60 - 90) * Math.PI) / 180;
      return {
        x: offset.x + readOnlyCenter.x + 80 * Math.cos(angle),
        y: offset.y + readOnlyCenter.y + 80 * Math.sin(angle),
      };
    };
    try {
      await page.mouse.move(offset.x + readOnlyCenter.x, offset.y + readOnlyCenter.y);
      await page.mouse.down({ button: "middle" });
      permissionProbePointerHeld = true;
      await viewer.waitForSelector(".pdfToolWheel", { timeout: 5_000 });
      const permissionAppearance = await viewer.evaluate(() => ({
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        sectors: [...document.querySelectorAll(".pdfToolWheel button")].map((button) => ({
          disabled: button.disabled,
          ariaDisabled: button.getAttribute("aria-disabled"),
        })),
      }));
      assert.equal(permissionAppearance.mode, -1,
        "The permission probe must model PDF.js DISABLE mode.");
      assert.equal(permissionAppearance.sectors.length, 6,
        "Read-only PDFs must still expose LingQ and the six-sector wheel.");
      assert.equal(permissionAppearance.sectors[0].disabled, false,
        "The read-only wheel keeps its non-annotation LingQ action available.");
      assert.deepEqual(permissionAppearance.sectors.slice(1).map((sector) => sector.disabled),
        [true, true, true, true, true],
        "Every annotation sector must be visibly disabled when PDF editing is forbidden.");
      assert.deepEqual(permissionAppearance.sectors.slice(1).map((sector) => sector.ariaDisabled),
        ["true", "true", "true", "true", "true"]);

      const disabledTool = sectorPoint(5);
      await page.mouse.move(disabledTool.x, disabledTool.y);
      await page.mouse.up({ button: "middle" });
      permissionProbePointerHeld = false;
      assert.ok(await viewer.$(".pdfToolWheel"),
        "Trying a disabled annotation tool must not dismiss the wheel or enable editing.");
      assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), -1,
        "Read-only PDF permissions must remain enforced after a disabled-sector selection.");

      await viewer.click('.pdfToolWheel button[data-sector="0"]');
      await page.waitForFunction(() => window.__host.vocabularyEnabled === true,
        { timeout: 5_000 });
      assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), -1,
        "The LingQ action must not change the PDF annotation permission mode.");

      await page.mouse.move(offset.x + readOnlyCenter.x, offset.y + readOnlyCenter.y);
      await page.mouse.down({ button: "middle" });
      permissionProbePointerHeld = true;
      await viewer.waitForSelector(".pdfToolWheel", { timeout: 5_000 });
      const lingqPoint = sectorPoint(0);
      await page.mouse.move(lingqPoint.x, lingqPoint.y);
      await page.mouse.up({ button: "middle" });
      permissionProbePointerHeld = false;
      await page.waitForFunction(() => window.__host.vocabularyEnabled === false,
        { timeout: 5_000 });
      assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), -1);
    } finally {
      if (permissionProbePointerHeld) await page.mouse.up({ button: "middle" }).catch(() => {});
      await viewer.evaluate(() => {
        const saved = window.__toolWheelPermissionOverride;
        if (!saved) return;
        if (saved.descriptor) {
          Object.defineProperty(saved.pdfViewer, "annotationEditorMode", saved.descriptor);
        } else {
          delete saved.pdfViewer.annotationEditorMode;
        }
        delete window.__toolWheelPermissionOverride;
      });
    }
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupReport = await cleanupBrowserTestResources({
      browser,
      ownedPages: [page].filter(Boolean),
      server,
    });
  }
  const finalError = attachCleanupErrors(primaryError, cleanupReport);
  if (finalError) throw finalError;
});
