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

async function waitMs(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function beginFastTouchDrag(cdp, point, distance, id) {
  await dispatchTouch(cdp, "touchStart", point, id);
  for (let step = 1; step <= 4; step += 1) {
    await waitMs(16);
    await dispatchTouch(cdp, "touchMove", {
      x: point.x,
      y: point.y - distance * step / 4,
    }, id);
  }
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
          "mousedown", "mouseup", "click", "dblclick", "wheel",
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
        const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
        const modifiedIds = Array.from(
          { length: app.pdfDocument.numPages },
          (_, pageIndex) => [...manager.getEditors(pageIndex)],
        ).flat().filter((editor) => editor.serialize())
          .map((editor) => String(editor.id)).sort();
        return {
          scrollTop: document.getElementById("viewerContainer").scrollTop,
          scrollLeft: document.getElementById("viewerContainer").scrollLeft,
          maxScrollTop: document.getElementById("viewerContainer").scrollHeight -
            document.getElementById("viewerContainer").clientHeight,
          storageSize: storage.size ?? null,
          serializedSize: storage.serializable?.map?.size ?? null,
          modifiedIds,
          editorElements: document.querySelectorAll(
            ".annotationEditorLayer .inkEditor",
          ).length,
          highlightElements: document.querySelectorAll(
            ".annotationEditorLayer .highlightEditor",
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

      await viewer.click("#editorHighlightButton");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 9,
        { timeout: 8_000 },
      );
      const highlightTarget = await viewer.evaluate(() => {
        const viewerRect = document.getElementById("viewerContainer").getBoundingClientRect();
        const spans = [...document.querySelectorAll(
          '.page[data-page-number="1"] .textLayer span',
        )].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent || "",
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        }).filter((span) => span.text.trim() && span.right - span.left > 4 &&
          span.bottom - span.top > 4 && span.top >= viewerRect.top &&
          span.bottom <= viewerRect.bottom);
        spans.sort((left, right) => left.top - right.top || left.left - right.left);
        const lines = [];
        for (const span of spans) {
          let line = lines.find((candidate) => Math.abs(candidate.top - span.top) < 2);
          if (!line) {
            line = { top: span.top, spans: [] };
            lines.push(line);
          }
          line.spans.push(span);
        }
        const line = lines.find((candidate) => candidate.spans.length >= 2 &&
          candidate.spans.at(-1).right - candidate.spans[0].left >= 70);
        if (!line) {
          throw new Error("Could not find a visible OCR text line for pen selection");
        }
        const first = line.spans[0];
        const last = line.spans.at(-1);
        const y = (first.top + first.bottom) / 2;
        return {
          start: { x: first.left + Math.min(2, (first.right - first.left) / 4), y },
          end: { x: last.right - Math.min(2, (last.right - last.left) / 4), y },
          expectedLineText: line.spans.map((span) => span.text).join(""),
        };
      });
      const highlightFrameBounds = await page.$eval("#pdf-reader", (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      const highlightPenStart = {
        x: highlightFrameBounds.x + highlightTarget.start.x,
        y: highlightFrameBounds.y + highlightTarget.start.y,
      };
      const highlightPenEnd = {
        x: highlightFrameBounds.x + highlightTarget.end.x,
        y: highlightFrameBounds.y + highlightTarget.end.y,
      };
      await viewer.evaluate(() => window.getSelection()?.removeAllRanges());
      const beforePenTextHighlight = await inputSnapshot();
      await viewer.evaluate(() => {
        window.__penTextSelectionTrace = [];
        window.__penTextHighlightCalls = [];
        window.__penCompatibilityMouseEvents = [];
        document.addEventListener("selectionchange", () => {
          const selection = document.getSelection();
          if (selection && !selection.isCollapsed && selection.toString()) {
            const textLayer = document.querySelector(
              '.page[data-page-number="1"] .textLayer',
            );
            window.__penTextSelectionTrace.push({
              text: selection.toString(),
              anchorOffset: selection.anchorOffset,
              focusOffset: selection.focusOffset,
              anchorInTextLayer: !!textLayer?.contains(selection.anchorNode),
              focusInTextLayer: !!textLayer?.contains(selection.focusNode),
            });
          }
        }, true);
        for (const type of ["mousedown", "mousemove", "mouseup"]) {
          document.addEventListener(type, () => {
            window.__penCompatibilityMouseEvents.push(type);
          });
        }
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        const highlightSelection = manager.highlightSelection.bind(manager);
        manager.highlightSelection = (method) => {
          const selection = document.getSelection();
          const call = {
            method,
            collapsed: selection?.isCollapsed ?? true,
            text: selection?.toString() || "",
            rangeCount: selection?.rangeCount || 0,
            stack: new Error().stack || "",
          };
          window.__penTextHighlightCalls.push(call);
          // Leave the actual Range intact when PDF.js's normal selection
          // handler asks for a highlight. The bridge's pointerup fallback
          // should then consume that same Range through the native editor API.
          if (!call.stack.includes("finishPenHighlightFallback")) return;
          return highlightSelection(method);
        };
      });
      await dispatchSimulatedPen(cdp, "mousePressed", highlightPenStart, 1);
      for (let step = 1; step <= 5; step += 1) {
        await dispatchSimulatedPen(cdp, "mouseMoved", {
          x: highlightPenStart.x +
            (highlightPenEnd.x - highlightPenStart.x) * step / 5,
          y: highlightPenStart.y +
            (highlightPenEnd.y - highlightPenStart.y) * step / 5,
        }, 1);
      }
      await dispatchSimulatedPen(cdp, "mouseReleased", highlightPenEnd, 0);
      await viewer.waitForFunction((previousCount) =>
        document.querySelectorAll(
          ".annotationEditorLayer .highlightEditor",
        ).length > previousCount,
      { timeout: 6_000 }, beforePenTextHighlight.highlightElements);
      const afterPenTextHighlight = await inputSnapshot();
      const penTextHighlightEvidence = await viewer.evaluate(() => {
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        const editors = [...manager.getEditors(0)].filter((editor) =>
          editor.div?.classList.contains("highlightEditor"),
        );
        const serialized = editors.map((editor) => editor.serialize()).filter(Boolean);
        return {
          selectionTrace: window.__penTextSelectionTrace || [],
          highlightCalls: window.__penTextHighlightCalls || [],
          compatibilityMouseEvents: window.__penCompatibilityMouseEvents || [],
          editors: editors.length,
          quadPointCounts: serialized.map((editor) => editor.quadPoints?.length || 0),
          selectionCollapsedAfter: document.getSelection()?.isCollapsed ?? true,
        };
      });
      const actualSelectionTrace = penTextHighlightEvidence.selectionTrace;
      assert.ok(actualSelectionTrace.some((entry) => entry.text.length > 0),
        "Trusted pen drag must create a live browser text selection");
      assert.ok(actualSelectionTrace.some((entry) =>
        Number.isInteger(entry.anchorOffset) && Number.isInteger(entry.focusOffset) &&
        entry.anchorInTextLayer && entry.focusInTextLayer,
      ), "Pen endpoints must come from caret hit tests inside the captured text layer");
      assert.deepEqual(penTextHighlightEvidence.compatibilityMouseEvents, [],
        "The owned text-selection gesture must suppress duplicate compatibility mouse events");
      assert.ok(penTextHighlightEvidence.highlightCalls.some((call) =>
        call.method === "main_toolbar" && !call.collapsed && call.text.length > 0 &&
        call.rangeCount > 0,
      ), `Native text highlight must consume the live selection: ${JSON.stringify(penTextHighlightEvidence.highlightCalls)}`);
      assert.ok(penTextHighlightEvidence.highlightCalls.some((call) =>
        call.stack.includes("finishPenHighlightFallback"),
      ), `The bridge fallback must consume the range when PDF.js selectionchange handling is suppressed: ${JSON.stringify(penTextHighlightEvidence.highlightCalls)}`);
      assert.ok(penTextHighlightEvidence.editors > 0,
        "Pen text selection must create a native PDF.js HighlightEditor");
      assert.ok(penTextHighlightEvidence.quadPointCounts.some((count) => count >= 8),
        `Native text highlight must serialize PDF QuadPoints: ${JSON.stringify(penTextHighlightEvidence.quadPointCounts)}`);
      assert.equal(penTextHighlightEvidence.selectionCollapsedAfter, true,
        "Native text highlight should consume and clear the browser selection");
      assert.ok(afterPenTextHighlight.serializedSize > beforePenTextHighlight.serializedSize,
        "Native text highlight must update PDF annotation storage");
      assert.ok(afterPenTextHighlight.storageSize > beforePenTextHighlight.storageSize,
        "Native text highlight must add an annotation to PDF storage");
      report.penTextHighlightSelection = {
        input: "trusted Chromium pen-typed CDP drag over OCR text",
        simulationOnly: true,
        expectedLineText: highlightTarget.expectedLineText,
        selectedText: actualSelectionTrace.at(-1)?.text || "",
        caretEndpoints: actualSelectionTrace.map((entry) => ({
          anchorOffset: entry.anchorOffset,
          focusOffset: entry.focusOffset,
          anchorInTextLayer: entry.anchorInTextLayer,
          focusInTextLayer: entry.focusInTextLayer,
        })),
        compatibilityMouseEvents: penTextHighlightEvidence.compatibilityMouseEvents,
        nativeHighlightCalls: penTextHighlightEvidence.highlightCalls,
        nativeHighlightEditors: penTextHighlightEvidence.editors,
        quadPointCounts: penTextHighlightEvidence.quadPointCounts,
        annotationStorageSize: afterPenTextHighlight.serializedSize,
      };
      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
      });

      await viewer.click("#editorInkButton");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 8_000 },
      );
      const beforeFingerPan = await inputSnapshot();
      const inkParamsState = () => viewer.evaluate(() => ({
        hidden: document.getElementById("editorInkParamsToolbar").classList.contains("hidden"),
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        selected: document.getElementById("editorInkButton").classList.contains("toggled"),
        expanded: document.getElementById("editorInkButton").getAttribute("aria-expanded"),
      }));
      assert.equal((await inkParamsState()).hidden, false);
      await viewer.click("#pageNumber");
      assert.deepEqual(await inkParamsState(), {
        hidden: true, mode: 15, selected: true, expanded: "false",
      }, "Mouse outside the parameter popup closes it without deselecting Ink");
      await viewer.click("#editorInkButton");
      await viewer.click("#editorInkButton");
      const popupPoint = await localPointInHost(viewer, page, "#editorInkParamsToolbar", [0.03, 0.04]);
      await dispatchTouch(cdp, "touchStart", popupPoint, 101);
      await dispatchTouch(cdp, "touchEnd");
      assert.equal((await inkParamsState()).hidden, false,
        "A finger contact inside tool parameters must leave them available");
      const outsidePopupPoint = await localPointInHost(viewer, page, "#viewerContainer", [0.9, 0.45]);
      await dispatchTouch(cdp, "touchStart", outsidePopupPoint, 102);
      await dispatchTouch(cdp, "touchEnd");
      assert.deepEqual(await inkParamsState(), {
        hidden: true, mode: 15, selected: true, expanded: "false",
      }, "Finger contact on the PDF closes parameters while retaining the selected tool");
      report.parameterPopupOutsideMouseAndFinger = true;
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

      await waitMs(1_000);
      const beforeFastFlick = await inputSnapshot();
      const fastFlickPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.52, 0.55],
      );
      const fastFlickEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await beginFastTouchDrag(cdp, fastFlickPoint, 260, 21);
      const fastFlickAtRelease = await inputSnapshot();
      await dispatchTouch(cdp, "touchEnd");
      const fastFlickImmediatelyAfterRelease = await inputSnapshot();
      await waitMs(120);
      const fastFlickAfterFirstInterval = await inputSnapshot();
      await waitMs(120);
      const fastFlickAfterSecondInterval = await inputSnapshot();
      await waitMs(760);
      const fastFlickSettled = await inputSnapshot();
      assert.ok(
        fastFlickAtRelease.scrollTop > beforeFastFlick.scrollTop + 180,
        "The trusted fast finger drag must pan the PDF before release",
      );
      const firstInertiaDistance = fastFlickAfterFirstInterval.scrollTop -
        fastFlickImmediatelyAfterRelease.scrollTop;
      const secondInertiaDistance = fastFlickAfterSecondInterval.scrollTop -
        fastFlickAfterFirstInterval.scrollTop;
      assert.ok(firstInertiaDistance > 20,
        "A recent fast finger release must continue scrolling");
      assert.ok(secondInertiaDistance > 5,
        "Finger inertia must continue smoothly across animation frames");
      assert.ok(secondInertiaDistance < firstInertiaDistance,
        "Finger inertia must decay over equal time intervals");
      assert.equal(fastFlickSettled.storageSize, beforeFastFlick.storageSize);
      assert.equal(fastFlickSettled.serializedSize, beforeFastFlick.serializedSize);
      assert.deepEqual(fastFlickSettled.modifiedIds, beforeFastFlick.modifiedIds,
        "Finger inertia must not modify PDF annotations");
      const fastFlickEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], fastFlickEventOffset,
      );
      assert.ok(fastFlickEvents.some((event) =>
        event.type === "pointerdown" && event.pointerType === "touch" && event.trusted,
      ), "The fast flick must use trusted touch pointer input");

      const pausePoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await dispatchTouch(cdp, "touchStart", pausePoint, 22);
      await dispatchTouch(cdp, "touchMove", {
        x: pausePoint.x,
        y: pausePoint.y - 100,
      }, 22);
      await waitMs(180);
      await dispatchTouch(cdp, "touchEnd");
      const pausedRelease = await inputSnapshot();
      await waitMs(300);
      const afterPausedRelease = await inputSnapshot();
      assert.ok(
        Math.abs(afterPausedRelease.scrollTop - pausedRelease.scrollTop) <= 1,
        "A finger that pauses before release must not start inertia",
      );

      const cancelPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.52],
      );
      await dispatchTouch(cdp, "touchStart", cancelPoint, 23);
      await dispatchTouch(cdp, "touchMove", {
        x: cancelPoint.x,
        y: cancelPoint.y - 130,
      }, 23);
      const cancelEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      const beforeTouchCancel = await inputSnapshot();
      await dispatchTouch(cdp, "touchCancel");
      const afterTouchCancel = await inputSnapshot();
      await waitMs(300);
      const afterTouchCancelWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterTouchCancelWait.scrollTop - afterTouchCancel.scrollTop) <= 1,
        "A cancelled touch must not start inertia",
      );
      assert.ok(beforeTouchCancel.scrollTop > pausedRelease.scrollTop + 50,
        "The cancelled contact must have panned before it was cancelled");
      const touchCancelEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], cancelEventOffset,
      );
      assert.ok(touchCancelEvents.some((event) =>
        event.type === "pointercancel" && event.pointerType === "touch" && event.trusted,
      ), "The cancellation case must deliver a trusted touch pointercancel");

      const boundaryStart = await viewer.evaluate(() => {
        const container = document.getElementById("viewerContainer");
        const maxScrollTop = container.scrollHeight - container.clientHeight;
        container.scrollTop = Math.max(0, maxScrollTop - 60);
        return container.scrollTop;
      });
      const boundaryPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await beginFastTouchDrag(cdp, boundaryPoint, 220, 24);
      await inputSnapshot();
      await dispatchTouch(cdp, "touchEnd");
      await waitMs(350);
      const boundaryAfterInertia = await inputSnapshot();
      assert.ok(boundaryAfterInertia.scrollTop >= boundaryStart,
        "A finger flick near the lower boundary must not reverse scroll direction");
      assert.ok(
        Math.abs(boundaryAfterInertia.scrollTop - boundaryAfterInertia.maxScrollTop) <= 1,
        "Finger inertia must stop at the PDF scroll boundary",
      );

      const middleScroll = await viewer.evaluate(() => {
        const container = document.getElementById("viewerContainer");
        container.scrollTop = Math.min(
          500,
          Math.max(0, (container.scrollHeight - container.clientHeight) / 2),
        );
        return container.scrollTop;
      });
      const toolbarTouchPoint = await localPointInHost(
        viewer,
        page,
        "#editorInkButton",
      );
      const toolbarTouchOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      const newContactPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await beginFastTouchDrag(cdp, newContactPoint, 180, 25);
      const newContactAtRelease = await inputSnapshot();
      await dispatchTouch(cdp, "touchEnd");
      await waitMs(80);
      const beforeToolbarTouch = await inputSnapshot();
      assert.ok(beforeToolbarTouch.scrollTop > newContactAtRelease.scrollTop + 5,
        "The finger flick must have active inertia before the new contact");
      await dispatchTouch(cdp, "touchStart", toolbarTouchPoint, 26);
      await dispatchTouch(cdp, "touchEnd");
      const afterToolbarTouch = await inputSnapshot();
      await waitMs(300);
      const afterToolbarTouchWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterToolbarTouchWait.scrollTop - afterToolbarTouch.scrollTop) <= 1,
        "A new finger contact on the toolbar must stop PDF inertia",
      );
      const toolbarTouchEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], toolbarTouchOffset,
      );
      assert.ok(toolbarTouchEvents.some((event) =>
        event.type === "pointerdown" && event.pointerType === "touch" &&
        event.trusted && !event.targetInViewer,
      ), "The momentum-stopping contact must land on a toolbar control");

      const penMomentumPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await beginFastTouchDrag(cdp, penMomentumPoint, 180, 27);
      const penFlickAtRelease = await inputSnapshot();
      await dispatchTouch(cdp, "touchEnd");
      await waitMs(70);
      const beforePenStop = await inputSnapshot();
      assert.ok(beforePenStop.scrollTop > penFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the Pencil contact");
      await tapSimulatedPen(cdp, toolbarTouchPoint);
      const afterPenStop = await inputSnapshot();
      await waitMs(300);
      const afterPenStopWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterPenStopWait.scrollTop - afterPenStop.scrollTop) <= 1,
        "A Pencil contact must stop PDF inertia",
      );

      const mouseMomentumPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await beginFastTouchDrag(cdp, mouseMomentumPoint, 180, 28);
      const mouseFlickAtRelease = await inputSnapshot();
      await dispatchTouch(cdp, "touchEnd");
      await waitMs(70);
      const beforeMouseStop = await inputSnapshot();
      assert.ok(beforeMouseStop.scrollTop > mouseFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the mouse contact");
      await page.mouse.click(toolbarTouchPoint.x, toolbarTouchPoint.y);
      const afterMouseStop = await inputSnapshot();
      await waitMs(300);
      const afterMouseStopWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterMouseStopWait.scrollTop - afterMouseStop.scrollTop) <= 1,
        "A mouse contact must stop PDF inertia",
      );

      const wheelMomentumPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      const wheelEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await beginFastTouchDrag(cdp, wheelMomentumPoint, 180, 29);
      const wheelFlickAtRelease = await inputSnapshot();
      await dispatchTouch(cdp, "touchEnd");
      await waitMs(70);
      const beforeWheelStop = await inputSnapshot();
      assert.ok(beforeWheelStop.scrollTop > wheelFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the wheel event");
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: wheelMomentumPoint.x,
        y: wheelMomentumPoint.y,
        deltaX: 0,
        deltaY: 0,
      });
      const afterWheelStop = await inputSnapshot();
      await waitMs(300);
      const afterWheelStopWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterWheelStopWait.scrollTop - afterWheelStop.scrollTop) <= 1,
        "A wheel event must stop PDF inertia",
      );
      const wheelEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], wheelEventOffset,
      );
      assert.ok(wheelEvents.some((event) => event.type === "wheel" && event.trusted),
        "The wheel cancellation case must deliver a trusted wheel event");

      const toolChangePoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await beginFastTouchDrag(cdp, toolChangePoint, 180, 30);
      const toolChangeFlickAtRelease = await inputSnapshot();
      await dispatchTouch(cdp, "touchEnd");
      await waitMs(70);
      const beforeToolChange = await inputSnapshot();
      assert.ok(beforeToolChange.scrollTop > toolChangeFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the tool change");
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 5,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 3_000 },
      );
      const afterToolChange = await inputSnapshot();
      await waitMs(300);
      const afterToolChangeWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterToolChangeWait.scrollTop - afterToolChange.scrollTop) <= 1,
        "Changing annotation tools must stop PDF inertia",
      );
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 15,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 3_000 },
      );

      report.fingerInertia = {
        policy: "trusted CDP touch sequence; Chromium routing evidence only",
        fastFlick: {
          before: beforeFastFlick,
          atRelease: fastFlickAtRelease,
          immediatelyAfterRelease: fastFlickImmediatelyAfterRelease,
          afterFirstInterval: fastFlickAfterFirstInterval,
          afterSecondInterval: fastFlickAfterSecondInterval,
          settled: fastFlickSettled,
          firstIntervalDistance: firstInertiaDistance,
          secondIntervalDistance: secondInertiaDistance,
          observedPointerEvents: fastFlickEvents,
        },
        pause: { release: pausedRelease, after: afterPausedRelease },
        cancel: {
          before: beforeTouchCancel,
          after: afterTouchCancel,
          afterWait: afterTouchCancelWait,
          observedPointerEvents: touchCancelEvents,
        },
        boundary: { start: boundaryStart, after: boundaryAfterInertia },
        toolbarContact: {
          atRelease: newContactAtRelease,
          beforeTouch: beforeToolbarTouch,
          afterTouch: afterToolbarTouchWait,
        },
        penStop: { before: beforePenStop, after: afterPenStopWait },
        mouseStop: { before: beforeMouseStop, after: afterMouseStopWait },
        wheelStop: { before: beforeWheelStop, after: afterWheelStopWait },
        wheelEvents,
        toolChangeStop: { before: beforeToolChange, after: afterToolChangeWait },
        middleScroll,
      };

      const squareTool = await localPointInHost(viewer, page, "#editorSquareButton");
      await dispatchTouch(cdp, "touchStart", squareTool, 12);
      await dispatchTouch(cdp, "touchEnd");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 8_000 },
      );
      await viewer.evaluate(() => {
        document.getElementById("viewerContainer").scrollTop = 0;
      });
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
      assert.equal(await penViewer.evaluate(() =>
        document.getElementById("editorSquareParamsToolbar").classList.contains("hidden") &&
        PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
      ), true, "Pencil drawing closes its tool parameters without deselecting Square");
      report.parameterPopupOutsideSimulatedPen = true;
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
