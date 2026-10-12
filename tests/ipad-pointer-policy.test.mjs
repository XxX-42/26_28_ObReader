import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";

const browserPath = resolveBrowserPath();
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const vendorWeb = path.join(vendorRoot, "web");
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgeCssPath = path.join(root, "viewer-adapter", "bridge.css");
const bridgeJsPath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
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

function hostHtml() {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>iPad pointer policy regression</title>
    <iframe id="pdf-reader" name="pdf-reader"
      style="display:block;width:100vw;height:100vh;border:0"></iframe>
    <script>
      const channel = "pdf-web-reader";
      const token = "ipad-pointer-policy-test";
      const frame = document.getElementById("pdf-reader");
      let sequence = 0;
      let initialOpenSent = false;
      window.__host = { opened: [], errors: [] };
      window.__openPdf = async () => {
        const data = await fetch("/fixtures/tracemonkey.pdf").then((response) => {
          if (!response.ok) throw new Error("Could not fetch PDF fixture");
          return response.arrayBuffer();
        });
        const openRequest = ++sequence;
        frame.contentWindow.postMessage({
          channel, token, type: "open", data,
          documentId: "ipad-pointer-policy-" + openRequest,
          openRequest, filename: "tracemonkey.pdf", autoSave: false,
        }, "*", [data]);
      };
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (!message || message.channel !== channel || message.token !== token) return;
        if (message.type === "ready" && !initialOpenSent) {
          initialOpenSent = true;
          void window.__openPdf();
        } else if (message.type === "opened") {
          window.__host.opened.push({
            documentId: message.documentId,
            openRequest: message.openRequest,
          });
        } else if (message.type === "error") {
          window.__host.errors.push(message.message || message.code || "viewer error");
        }
      });
      frame.src = "/viewer/viewer.html";
    </script>`;
}

function viewerHtml(source) {
  const viewerScript = '<script src="viewer.mjs" type="module"></script>';
  assert.ok(source.includes(viewerScript), "Vendor viewer script marker must exist");
  const bridgeAssets = `
    <link rel="stylesheet" href="/bridge.css" />
    <script src="/bridge.js" data-channel="pdf-web-reader" data-token="ipad-pointer-policy-test"
      data-renderer-generation="ipad-pointer-policy-renderer" data-ios-input-policy="true"></script>`;
  return source.replace(viewerScript, `${bridgeAssets}\n  ${viewerScript}`);
}

function getTarget(pathname) {
  if (pathname === "/favicon.ico") return null;
  if (pathname === "/fixtures/tracemonkey.pdf") return fixturePath;
  if (pathname === "/bridge.css") return bridgeCssPath;
  if (pathname === "/bridge.js") return bridgeJsPath;
  if (
    pathname.startsWith("/viewer/") ||
    pathname.startsWith("/build/") ||
    pathname.startsWith("/cmaps/") ||
    pathname.startsWith("/standard_fonts/") ||
    pathname.startsWith("/wasm/") ||
    pathname.startsWith("/images/") ||
    pathname.startsWith("/locale/")
  ) {
    const buildResource = pathname.startsWith("/build/");
    const resourceRoot = buildResource ? vendorRoot : vendorWeb;
    const relativePath = buildResource
      ? pathname.slice(1)
      : pathname.startsWith("/viewer/")
        ? pathname.slice("/viewer/".length)
        : pathname.slice(1);
    const target = path.resolve(resourceRoot, relativePath);
    return target.startsWith(`${resourceRoot}${path.sep}`) ? target : null;
  }
  return null;
}

async function localPointInHost(viewer, page, selector, fraction = [0.5, 0.5]) {
  const [frameElement, local] = await Promise.all([
    viewer.frameElement(),
    viewer.evaluate((selector, ratios) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Input target is missing: ${selector}`);
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width * ratios[0],
        y: rect.top + rect.height * ratios[1],
      };
    }, selector, fraction),
  ]);
  const frameBounds = await frameElement.boundingBox();
  assert.ok(frameBounds, "Viewer iframe must be visible to input dispatch");
  return { x: frameBounds.x + local.x, y: frameBounds.y + local.y };
}

async function dispatchTouch(cdp, type, point = null, id = 1) {
  const touchPoints = point
    ? [{ x: point.x, y: point.y, id, radiusX: 1, radiusY: 1, force: 1 }]
    : [];
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
}

async function dispatchSimulatedPen(cdp, type, point, buttons) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons,
    pointerType: "pen",
    force: buttons ? 0.5 : 0,
    clickCount: type === "mousePressed" ? 1 : 0,
  });
}

async function tapSimulatedPen(cdp, point) {
  await dispatchSimulatedPen(cdp, "mousePressed", point, 1);
  await dispatchSimulatedPen(cdp, "mouseReleased", point, 0);
}

test(
  "iPad policy routes finger scrolling separately from PDF.js editor and mouse input",
  {
    timeout: 120_000,
    skip: browserPath ? false : "Chrome or Edge is required for trusted pointer input",
  },
  async (t) => {
    const vendorSource = await readFile(path.join(vendorWeb, "viewer.html"), "utf8");
    const html = viewerHtml(vendorSource);
    const missingRequests = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(hostHtml());
        return;
      }
      if (url.pathname === "/viewer/viewer.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      const target = getTarget(url.pathname);
      if (!target) {
        missingRequests.push(url.pathname);
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

    let browser;
    let page;
    let viewer;
    let penPage;
    let penViewer;
    let primaryError;
    let cleanupReport;
    const report = {
      schema: 1,
      policySource: "bridge script data-ios-input-policy flag",
      penSimulation: "CDP Input.dispatchMouseEvent pointerType=pen; not hardware Pencil",
      trustedTouch: null,
      mouseAfterTouch: null,
      pageErrors: [],
    };
    const artifactPath = path.join(
      root,
      "tests",
      "artifacts",
      `ipad-pointer-policy-${Date.now()}-${process.pid}.json`,
    );
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      browser = await launchTestBrowser(puppeteer, {
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }, { testName: "ipad-pointer-policy" });
      page = await browser.newPage();
      await page.setViewport({
        width: 1180,
        height: 920,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      });
      await page.evaluateOnNewDocument(() => {
        window.__ipadPointerEvents = [];
        for (const type of [
          "pointerdown", "pointermove", "pointerup", "pointercancel",
          "mousedown", "mouseup", "click", "dblclick",
        ]) {
          window.addEventListener(type, (event) => {
            const target = event.target instanceof Element ? event.target : null;
            window.__ipadPointerEvents.push({
              type,
              pointerType: event.pointerType || null,
              trusted: event.isTrusted === true,
              targetInViewer: !!target?.closest?.("#viewerContainer"),
              targetPage: target?.closest?.(".page")?.dataset.pageNumber || null,
            });
            if (window.__ipadPointerEvents.length > 256) {
              window.__ipadPointerEvents.shift();
            }
          }, true);
        }
      });
      page.on("pageerror", (error) => report.pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(() => window.__host?.opened?.length === 1, {
        timeout: 35_000,
      });
      viewer = page.frames().find((frame) => frame.name() === "pdf-reader");
      assert.ok(viewer, "Expected the PDF.js viewer iframe");
      await viewer.waitForFunction(() =>
        !!window.PDFViewerApplication?.pdfDocument &&
        !!document.querySelector('.page[data-page-number="1"] .textLayer span') &&
        document.querySelector('.page[data-page-number="1"]')
          ?.getBoundingClientRect().width > 0,
      { timeout: 25_000 });
      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
        document.addEventListener("click", (event) => {
          if (event.target instanceof Element && event.target.closest(".page")) {
            window.__ipadPageClicksReachedDocument.push({
              pointerType: event.pointerType || null,
              detail: event.detail,
            });
          }
        }, true);
      });

      const initialPolicy = await viewer.evaluate(() => ({
        flag: document.documentElement.dataset.pdfReaderIosInputPolicy || null,
        touchAction: getComputedStyle(document.getElementById("viewerContainer")).touchAction,
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
      }));
      assert.deepEqual(initialPolicy, {
        flag: "true",
        touchAction: "none",
        mode: 0,
      });
      const cdp = await page.target().createCDPSession();
      const penNavigationStart = await viewer.evaluate(() =>
        PDFViewerApplication.pdfViewer.currentPageNumber,
      );
      const nextPagePoint = await localPointInHost(viewer, page, "#next");
      await tapSimulatedPen(cdp, nextPagePoint);
      await viewer.waitForFunction(
        (pageNumber) => PDFViewerApplication.pdfViewer.currentPageNumber > pageNumber,
        { timeout: 8_000 },
        penNavigationStart,
      );
      const penNavigationAfterNext = await viewer.evaluate(() =>
        PDFViewerApplication.pdfViewer.currentPageNumber,
      );
      const previousPagePoint = await localPointInHost(viewer, page, "#previous");
      await tapSimulatedPen(cdp, previousPagePoint);
      await viewer.waitForFunction(
        (pageNumber) => PDFViewerApplication.pdfViewer.currentPageNumber < pageNumber,
        { timeout: 8_000 },
        penNavigationAfterNext,
      );
      report.simulatedPenNavigation = {
        simulationOnly: true,
        pageBefore: penNavigationStart,
        pageAfterNext: penNavigationAfterNext,
        pageAfterPrevious: await viewer.evaluate(() =>
          PDFViewerApplication.pdfViewer.currentPageNumber,
        ),
      };
      const inputSnapshot = async (frame = viewer) => frame.evaluate(() => {
        const app = window.PDFViewerApplication;
        const storage = app.pdfDocument.annotationStorage;
        const modified = storage.modifiedIds?.ids;
        return {
          scrollTop: document.getElementById("viewerContainer").scrollTop,
          storageSize: storage.size ?? null,
          serializedSize: storage.serializable?.map?.size ?? null,
          modifiedIds: modified && typeof modified[Symbol.iterator] === "function"
            ? [...modified].sort()
            : [],
          editorElements: document.querySelectorAll(
            ".annotationEditorLayer .inkEditor",
          ).length,
        };
      });

      // CDP emits a trusted Chromium pen-typed pointer sequence. This is a
      // routing simulation and is explicitly not evidence from an Apple Pencil.
      const penStart = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"] .textLayer span',
        [0.5, 0.5],
      );
      report.penStart = penStart;
      report.geometry = await viewer.evaluate(() => ({
        viewport: {
          width: innerWidth,
          height: innerHeight,
        },
        viewer: (() => {
          const rect = document.getElementById("viewerContainer").getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        })(),
        page: (() => {
          const rect = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        })(),
      }));
      await viewer.evaluate(() => window.getSelection()?.removeAllRanges());
      const beforePenPan = await inputSnapshot();
      const penPanEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await dispatchSimulatedPen(cdp, "mousePressed", penStart, 1);
      await dispatchSimulatedPen(cdp, "mouseMoved", {
        x: penStart.x,
        y: penStart.y - 130,
      }, 1);
      await dispatchSimulatedPen(cdp, "mouseReleased", {
        x: penStart.x,
        y: penStart.y - 130,
      }, 0);
      await viewer.waitForFunction(
        (start) => document.getElementById("viewerContainer").scrollTop > start + 40,
        { timeout: 5_000 },
        beforePenPan.scrollTop,
      );
      const afterPenPan = await inputSnapshot();
      assert.equal(afterPenPan.storageSize, beforePenPan.storageSize);
      assert.equal(afterPenPan.serializedSize, beforePenPan.serializedSize);
      assert.deepEqual(afterPenPan.modifiedIds, beforePenPan.modifiedIds);
      const penPanEvents = await viewer.evaluate((offset) => ({
        events: window.__ipadPointerEvents?.slice(offset) || [],
        selection: window.getSelection()?.toString() || "",
        pageClicks: window.__ipadPageClicksReachedDocument || [],
      }), penPanEventOffset);
      assert.equal(penPanEvents.selection, "",
        "A mode-NONE pen pan must not select PDF text");
      assert.ok(
        penPanEvents.events.every((event) =>
          !(event.targetInViewer && ["mousedown", "mousemove", "mouseup"].includes(event.type)),
        ),
        `A mode-NONE pen pan must suppress compatibility mouse events: ${JSON.stringify(penPanEvents.events)}`,
      );
      assert.deepEqual(penPanEvents.pageClicks, [],
        "A completed pen pan must not trigger a PDF page click");
      const penObservation = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.filter((event) => event.pointerType === "pen") || [],
      );
      assert.ok(penObservation.some((event) => event.type === "pointerdown"),
        "Chromium should deliver the explicitly simulated pen pointerType");

      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
      });
      const penTapPoint = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"] .textLayer span',
        [0.5, 0.5],
      );
      await tapSimulatedPen(cdp, penTapPoint);
      await viewer.waitForFunction(() =>
        window.__ipadPageClicksReachedDocument?.length === 1,
        { timeout: 3_000 },
      );
      report.simulatedPenModeNoneTapReachedDocument = true;
      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
      });

      await viewer.click("#editorInkButton");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 8_000 },
      );
      const beforeFingerPan = await inputSnapshot();
      const touchEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      const fingerStart = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"]',
        [0.52, 0.62],
      );
      await dispatchTouch(cdp, "touchStart", fingerStart, 11);
      await dispatchTouch(cdp, "touchMove", {
        x: fingerStart.x,
        y: fingerStart.y - 220,
      }, 11);
      await dispatchTouch(cdp, "touchEnd");
      await viewer.waitForFunction(
        (start) => document.getElementById("viewerContainer").scrollTop > start + 70,
        { timeout: 5_000 },
        beforeFingerPan.scrollTop,
      );
      const afterFingerPan = await inputSnapshot();
      assert.equal(afterFingerPan.storageSize, beforeFingerPan.storageSize,
        "A finger drag must not create an editor while Ink is selected");
      assert.equal(afterFingerPan.serializedSize, beforeFingerPan.serializedSize);
      assert.deepEqual(afterFingerPan.modifiedIds, beforeFingerPan.modifiedIds);
      assert.equal(afterFingerPan.editorElements, beforeFingerPan.editorElements);
      const touchObservation = await viewer.evaluate((offset) => ({
        events: window.__ipadPointerEvents?.slice(offset) || [],
        pointers: window.__ipadPointerEvents?.slice(offset).filter((event) =>
          event.pointerType === "touch" && event.targetInViewer,
        ) || [],
        deliveredPageClicks: window.__ipadPageClicksReachedDocument || [],
      }), touchEventOffset);
      assert.ok(touchObservation.pointers.some((event) =>
        event.type === "pointerdown" && event.trusted,
      ), "Touch pan must use trusted browser pointer events");
      assert.deepEqual(touchObservation.deliveredPageClicks, [],
        "Touch compatibility click events must not reach PDF.js page handlers");
      assert.ok(
        touchObservation.events.every((event) =>
          !(event.targetInViewer && ["mousedown", "mouseup"].includes(event.type)),
        ),
        `Touch must not generate compatibility mouse events in the page: ${JSON.stringify(touchObservation.events)}`,
      );

      const squareTool = await localPointInHost(viewer, page, "#editorSquareButton");
      await dispatchTouch(cdp, "touchStart", squareTool, 12);
      await dispatchTouch(cdp, "touchEnd");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 8_000 },
      );
      const beforeMouseDraw = await inputSnapshot();
      const mouseStart = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"] .annotationEditorLayer',
        [0.38, 0.52],
      );
      await page.mouse.move(mouseStart.x, mouseStart.y);
      await page.mouse.down();
      await page.mouse.move(mouseStart.x + 88, mouseStart.y + 64, { steps: 6 });
      await page.mouse.up();
      await viewer.waitForFunction(
        (previous) => document.querySelectorAll(
          '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
        ).length > previous,
        { timeout: 8_000 },
        beforeMouseDraw.editorElements,
      );
      const afterMouseDraw = await inputSnapshot();
      assert.ok(afterMouseDraw.serializedSize > beforeMouseDraw.serializedSize,
        "Mouse drawing must still reach PDF.js under the iOS policy flag");
      const mouseObservation = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.filter((event) =>
          event.pointerType === "mouse" && event.targetInViewer,
        ) || [],
      );
      assert.ok(mouseObservation.some((event) => event.type === "pointerdown" && event.trusted));

      penPage = await browser.newPage();
      await penPage.setViewport({
        width: 1180,
        height: 920,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      });
      await penPage.evaluateOnNewDocument(() => {
        window.__ipadPointerEvents = [];
        for (const type of [
          "pointerdown", "pointermove", "pointerup", "pointercancel",
          "mousedown", "mouseup", "click", "dblclick",
        ]) {
          window.addEventListener(type, (event) => {
            const target = event.target instanceof Element ? event.target : null;
            window.__ipadPointerEvents.push({
              type,
              pointerType: event.pointerType || null,
              trusted: event.isTrusted === true,
              targetInViewer: !!target?.closest?.("#viewerContainer"),
              targetPage: target?.closest?.(".page")?.dataset.pageNumber || null,
            });
            if (window.__ipadPointerEvents.length > 256) {
              window.__ipadPointerEvents.shift();
            }
          }, true);
        }
      });
      penPage.on("pageerror", (error) => report.pageErrors.push(error.message));
      await penPage.goto(`http://127.0.0.1:${server.address().port}/`, {
        waitUntil: "domcontentloaded",
      });
      await penPage.waitForFunction(() => window.__host?.opened?.length === 1, {
        timeout: 35_000,
      });
      penViewer = penPage.frames().find((frame) => frame.name() === "pdf-reader");
      assert.ok(penViewer, "Expected the second PDF.js viewer iframe");
      await penViewer.waitForFunction(() => {
        const page = document.querySelector('.page[data-page-number="1"]');
        return PDFViewerApplication.pdfDocument && page?.dataset.loaded === "true" &&
          !!page.querySelector(".textLayer span") &&
          page.getBoundingClientRect().width > 0;
      }, { timeout: 12_000 });
      await penViewer.waitForFunction(() => {
        const button = document.getElementById("editorSquareButton");
        return button?.isConnected && !button.disabled;
      }, { timeout: 8_000 });
      const penCdp = await penPage.target().createCDPSession();
      const penSquareTool = await localPointInHost(
        penViewer,
        penPage,
        "#editorSquareButton",
      );
      await penViewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
        { timeout: 8_000 },
      );
      await dispatchTouch(penCdp, "touchStart", penSquareTool, 14);
      await dispatchTouch(penCdp, "touchEnd");
      await penViewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 8_000 },
      );
      const beforePenDraw = await inputSnapshot(penViewer);
      const penDrawStart = await localPointInHost(
        penViewer,
        penPage,
        '.page[data-page-number="1"] .annotationEditorLayer',
        [0.64, 0.48],
      );
      const penEventOffset = await penViewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await dispatchSimulatedPen(penCdp, "mousePressed", penDrawStart, 1);
      await dispatchSimulatedPen(penCdp, "mouseMoved", {
        x: penDrawStart.x + 22,
        y: penDrawStart.y + 18,
      }, 1);
      const duringPenDraw = await inputSnapshot(penViewer);
      const fingerDuringPen = await localPointInHost(
        penViewer,
        penPage,
        '.page[data-page-number="1"]',
        [0.18, 0.25],
      );
      await dispatchTouch(penCdp, "touchStart", fingerDuringPen, 13);
      await dispatchTouch(penCdp, "touchMove", {
        x: fingerDuringPen.x,
        y: fingerDuringPen.y - 180,
      }, 13);
      await dispatchTouch(penCdp, "touchEnd");
      const afterFingerDuringPen = await inputSnapshot(penViewer);
      assert.equal(afterFingerDuringPen.scrollTop, duringPenDraw.scrollTop,
        "A finger arriving during a pen edit must not pan the PDF");
      assert.equal(afterFingerDuringPen.editorElements, duringPenDraw.editorElements,
        "A finger arriving during a pen edit must not create or change editor count");
      await dispatchSimulatedPen(penCdp, "mouseMoved", {
        x: penDrawStart.x + 72,
        y: penDrawStart.y + 54,
      }, 1);
      await dispatchSimulatedPen(penCdp, "mouseReleased", {
        x: penDrawStart.x + 72,
        y: penDrawStart.y + 54,
      }, 0);
      await penViewer.waitForFunction(
        (previous) => document.querySelectorAll(
          '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
        ).length > previous,
        { timeout: 8_000 },
        beforePenDraw.editorElements,
      );
      const afterPenDraw = await inputSnapshot(penViewer);
      assert.ok(afterPenDraw.serializedSize > beforePenDraw.serializedSize,
        "A pen-typed pointer should reach the active PDF.js editor tool");
      const penDrawObservation = await penViewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset).filter((event) =>
          event.pointerType === "pen" && event.targetInViewer,
        ) || [], penEventOffset,
      );
      assert.ok(penDrawObservation.some((event) => event.type === "pointerdown" && event.trusted));

      report.trustedTouch = {
        pointerEvents: touchObservation.pointers,
        before: beforeFingerPan,
        after: afterFingerPan,
        touchUiSelectedSquare: true,
      };
      report.mouseAfterTouch = {
        before: beforeMouseDraw,
        after: afterMouseDraw,
        observedPointerEvents: mouseObservation,
      };
      report.simulatedPenActiveToolDraw = {
        simulationOnly: true,
        before: beforePenDraw,
        duringPen: duringPenDraw,
        afterFinger: afterFingerDuringPen,
        after: afterPenDraw,
        observedPointerEvents: penDrawObservation,
      };
      report.simulatedPenModeNonePan = {
        simulationOnly: true,
        before: beforePenPan,
        after: afterPenPan,
        selection: penPanEvents.selection,
        compatibilityMouseEvents: penPanEvents.events.filter((event) =>
          event.targetInViewer && ["mousedown", "mousemove", "mouseup"].includes(event.type),
        ),
        observedPointerEvents: penObservation,
      };
      assert.deepEqual(report.pageErrors, []);
      assert.deepEqual(missingRequests, []);
    } catch (error) {
      primaryError = error;
      if (viewer) {
        report.failureState = await viewer.evaluate(() => ({
          mode: window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
          scrollTop: document.getElementById("viewerContainer")?.scrollTop ?? null,
          pointerEvents: window.__ipadPointerEvents?.slice(-64) || [],
          storageSize: window.PDFViewerApplication?.pdfDocument?.annotationStorage?.size ?? null,
          serializedSize: window.PDFViewerApplication?.pdfDocument?.annotationStorage?.serializable?.map?.size ?? null,
        })).catch((inspectionError) => ({ inspectionError: inspectionError.message }));
      }
    } finally {
      cleanupReport = await cleanupBrowserTestResources({
        browser,
        ownedPages: [page, penPage].filter(Boolean),
        server,
      });
      report.cleanup = cleanupReport;
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, {
        flag: "wx",
      });
      t.diagnostic(`Pointer policy evidence: ${artifactPath}`);
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) throw finalError;
  },
);
