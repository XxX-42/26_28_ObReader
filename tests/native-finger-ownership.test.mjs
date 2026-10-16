import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";

const root = path.resolve(import.meta.dirname, "..");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const vendorWeb = path.join(vendorRoot, "web");
const browserPath = resolveBrowserPath();
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"], [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"], [".svg", "image/svg+xml"], [".wasm", "application/wasm"],
]);

function viewerHtml(source) {
  return source.replace(
    '<script src="viewer.mjs" type="module"></script>',
    `<link rel="stylesheet" href="/bridge.css" />
     <script src="/bridge.js" data-channel="pdf-web-reader" data-token="native-finger-test"
       data-renderer-generation="native-finger-renderer" data-ios-input-policy="true"></script>
     <script src="viewer.mjs" type="module"></script>`,
  );
}

function hostHtml() {
  return `<!doctype html><meta charset="utf-8"><iframe id="pdf-reader" name="pdf-reader"
    style="display:block;width:100vw;height:100vh;border:0"></iframe>
    ${browserSidecarHarnessScript({ channel: "pdf-web-reader", token: "native-finger-test" })}<script>
    const frame=document.getElementById("pdf-reader"), channel="pdf-web-reader", token="native-finger-test";
    let request=0; window.__host={opened:[],errors:[]};
    window.__open=async()=>{const data=await fetch("/fixture.pdf").then(r=>r.arrayBuffer());
      const openRequest=++request; frame.contentWindow.postMessage({channel,token,type:"open",data,
        documentId:"native-finger-"+openRequest,openRequest,filename:"fixture.pdf",autoSave:false},"*",[data]);};
    addEventListener("message",e=>{if(e.source!==frame.contentWindow)return;const m=e.data;
      if(!m||m.channel!==channel||m.token!==token)return;
      if(m.type==="ready"&&!request)void __open();
      else if(m.type==="opened")window.__host.opened.push(m.documentId);
      else if(m.type==="error")window.__host.errors.push(m.message||m.code||"viewer error");});
    frame.src="/viewer/viewer.html";</script>`;
}

function targetFor(pathname) {
  if (pathname === "/fixture.pdf") return path.join(root, "tests", "fixtures", "tracemonkey.pdf");
  if (pathname === "/bridge.css") return path.join(root, "viewer-adapter", "bridge.css");
  if (pathname === "/bridge.js") return path.join(root, "viewer-adapter", "obsidian-bridge.js");
  if (!/^\/(viewer|build|cmaps|standard_fonts|wasm|images|locale)\//.test(pathname)) return null;
  const isBuild = pathname.startsWith("/build/");
  const base = isBuild ? vendorRoot : vendorWeb;
  const rel = isBuild ? pathname.slice(1) : pathname.slice("/viewer/".length);
  const full = path.resolve(base, rel);
  return full.startsWith(`${base}${path.sep}`) ? full : null;
}

async function wait(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("native touch ownership keeps page scrolling browser-owned and suppresses finger annotation", {
  timeout: 60_000,
  skip: browserPath ? false : "Chrome or Edge is required for trusted touch input",
}, async (t) => {
  // Native WebKit scrolling replaces the old manual iOS finger-inertia contract.
  // The large legacy iPad test remains historical evidence for the old manual path.
  const vendorSource = await readFile(path.join(vendorWeb, "viewer.html"), "utf8");
  const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
  const bridgeSource = await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8");
  const instrumentedBridgeSource = bridgeSource.replace(
    "  if (iosInputPolicy) {",
    "  window.__nativeFingerBridgeState = state;\n  if (iosInputPolicy) {",
  );
  assert.notEqual(instrumentedBridgeSource, bridgeSource,
    "The test harness must expose pointer ownership only inside this disposable Reader");
  const assetHtml = viewerHtml(vendorSource);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/favicon.ico") return response.writeHead(204).end();
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(hostHtml());
      return;
    }
    if (url.pathname === "/viewer/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(assetHtml);
      return;
    }
    if (url.pathname === "/bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" })
        .end(instrumentedBridgeSource);
      return;
    }
    const target = targetFor(url.pathname);
    if (!target) return response.writeHead(404).end("not found");
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
  let cdp;
  let primaryError;
  let cleanupReport;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "native-finger-ownership" });
    page = await browser.newPage();
    await page.setViewport({ width: 1050, height: 800, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => {
      window.__nativeTouchProbe = { prevented: [], captures: [], pointers: [] };
      const pointerTypes = new Map();
      const preventDefault = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function (...args) {
        if (this.type === "touchstart" || this.type === "touchmove") {
          window.__nativeTouchProbe.prevented.push({
            type: this.type, target: this.target?.nodeName || "", trusted: this.isTrusted,
          });
        }
        return preventDefault.apply(this, args);
      };
      const setPointerCapture = Element.prototype.setPointerCapture;
      Element.prototype.setPointerCapture = function (pointerId) {
        if (pointerTypes.get(pointerId) === "touch") {
          window.__nativeTouchProbe.captures.push(pointerId);
        }
        return setPointerCapture.call(this, pointerId);
      };
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
        addEventListener(type, (event) => {
          if (event.pointerType === "touch") pointerTypes.set(event.pointerId, "touch");
          window.__nativeTouchProbe.pointers.push({
            type, pointerType: event.pointerType, trusted: event.isTrusted,
            prevented: event.defaultPrevented,
          });
        }, true);
      }
    });
    const pageErrors = [];
    page.on("pageerror", (error) => { pageErrors.push(error.message); t.diagnostic(`page error: ${error.message}`); });
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__host?.opened?.length === 1, { timeout: 25_000 });
    const viewer = page.frames().find((frame) => frame.name() === "pdf-reader");
    assert.ok(viewer, "PDF viewer iframe loads");
    await viewer.waitForFunction(() => !!PDFViewerApplication?.pdfDocument &&
      !!document.querySelector('.page[data-page-number="1"] .textLayer span'), { timeout: 20_000 });
    cdp = await page.target().createCDPSession();

    const pointInViewer = async (selector, ratios = [0.5, 0.5]) => {
      const [frameElement, local] = await Promise.all([
        viewer.frameElement(),
        viewer.evaluate((targetSelector, ratios) => {
          const element = document.querySelector(targetSelector);
          if (!element) throw new Error(`Touch target missing: ${targetSelector}`);
          const rect = element.getBoundingClientRect();
          const view = document.getElementById("viewerContainer").getBoundingClientRect();
          const left = Math.max(rect.left + 8, view.left + 8, 8);
          const right = Math.min(rect.right - 8, view.right - 8, innerWidth - 8);
          const top = Math.max(rect.top + 8, view.top + 8, 8);
          const bottom = Math.min(rect.bottom - 8, view.bottom - 8, innerHeight - 8);
          if (right <= left || bottom <= top) throw new Error(`Target is outside viewer viewport: ${targetSelector}`);
          const point = { x: left + (right - left) * ratios[0], y: top + (bottom - top) * ratios[1] };
          const hit = document.elementFromPoint(point.x, point.y);
          if (!(hit && (element === hit || element.contains(hit) || hit.closest(targetSelector)))) {
            throw new Error(`Hit test missed ${targetSelector}: ${hit?.className || hit?.tagName || "none"}`);
          }
          return point;
        }, selector, ratios),
      ]);
      const bounds = await frameElement.boundingBox();
      return { x: bounds.x + local.x, y: bounds.y + local.y };
    };
    const touchDrag = async (point, id) => {
      const send = (type, location) => cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: location ? [{ x: location.x, y: location.y, id, radiusX: 2, radiusY: 2, force: 1 }] : [],
      });
      await send("touchStart", point);
      for (let step = 1; step <= 4; step += 1) {
        await wait(18);
        await send("touchMove", { x: point.x, y: point.y - step * 35 });
      }
      await send("touchEnd", null);
    };
    const containerState = () => viewer.evaluate(() => {
      const container = document.getElementById("viewerContainer");
      return { top: container.scrollTop, max: container.scrollHeight - container.clientHeight };
    });

    const initial = await containerState();
    assert.ok(initial.max > 100, "PDF viewer has a native scroll range");
    const pageTarget = await pointInViewer('.page[data-page-number="1"] .textLayer span');
    await touchDrag(pageTarget, 1);
    await viewer.waitForFunction((start) =>
      document.getElementById("viewerContainer").scrollTop > start + 20,
    { timeout: 3_000 }, initial.top);
    const afterReadTouch = await containerState();

    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      source: window, mode: 15, isFromKeyboard: true, createNewEditor: false,
    }));
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 15, { timeout: 5_000 });
    await viewer.evaluate(() => { document.getElementById("viewerContainer").scrollTop = 0; });
    const inkPolicy = await viewer.evaluate(() => {
      const layer = document.querySelector('.page[data-page-number="1"] .annotationEditorLayer');
      return {
        viewer: getComputedStyle(document.getElementById("viewerContainer")).touchAction,
        activeLayer: layer.className,
        activeLayerTouchAction: getComputedStyle(layer).touchAction,
        editors: document.querySelectorAll('.page[data-page-number="1"] .annotationEditorLayer .inkEditor').length,
      };
    });
    assert.match(inkPolicy.viewer, /pan/);
    assert.match(inkPolicy.activeLayer, /inkEditing/);
    const activeBefore = await containerState();
    const inkTarget = await pointInViewer('.page[data-page-number="1"] .annotationEditorLayer');
    await touchDrag(inkTarget, 2);
    await viewer.waitForFunction((start) =>
      document.getElementById("viewerContainer").scrollTop > start + 20,
    { timeout: 3_000 }, activeBefore.top);
    const activeAfter = await containerState();
    const editorCountAfterTouch = await viewer.evaluate(() => document.querySelectorAll(
      '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
    ).length);
    assert.equal(editorCountAfterTouch, inkPolicy.editors,
      "Finger input over the active Ink layer scrolls without creating an annotation");
    const bridgeCss = await readFile(path.join(root, "viewer-adapter", "bridge.css"), "utf8");
    assert.match(bridgeCss, /#viewerContainer \.textLayer\.highlighting,[\s\S]{0,260}touch-action:\s*pan-x pan-y/s,
      "PDF.js's touch-action:none highlight selection layer is overridden");
    assert.match(bridgeCss, /#viewerContainer \.annotationEditorLayer \.inkEditorCanvas,[\s\S]{0,260}touch-action:\s*pan-x pan-y/s,
      "PDF.js's touch-action:none Ink canvas is overridden when present");
    assert.match(bridgeCss, /#viewerContainer \.annotationEditorLayer \.freeTextEditor[\s\S]{0,260}touch-action:\s*pan-x pan-y/s,
      "Inactive FreeText editors do not block native page scrolling");
    assert.match(bridgeCss, /\.freeTextEditor \.internal\[contenteditable="true"\]:focus\s*\{\s*touch-action:\s*none/s,
      "Only a focused FreeText editing surface retains its direct-manipulation policy");

    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      source: window, mode: 0, isFromKeyboard: true, createNewEditor: false,
    }));
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 0, { timeout: 5_000 });
    const readModeStylusGuard = await viewer.evaluate(() => {
      const target = document.querySelector('.page[data-page-number="1"] .annotationEditorLayer');
      const stylus = new Touch({ identifier: 99, target, clientX: 20, clientY: 20 });
      Object.defineProperty(stylus, "touchType", { value: "stylus" });
      const touchList = { 0: stylus, length: 1, item(index) { return this[index] || null; } };
      const readModeStylus = new Event("touchstart", { bubbles: true, cancelable: true });
      Object.defineProperties(readModeStylus, {
        touches: { value: touchList }, changedTouches: { value: touchList },
      });
      target.dispatchEvent(readModeStylus);
      const readModePointer = new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, pointerId: 999, pointerType: "pen",
        button: 0, buttons: 1, clientX: 20, clientY: 20,
      });
      target.dispatchEvent(readModePointer);
      const bridge = window.__nativeFingerBridgeState;
      const trackedOnDown = {
        nativePen: bridge.nativePenPanPointers.has(999),
        manual: bridge.manualPointers.has(999),
        editor: bridge.activePointers.has(999),
      };
      target.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, pointerId: 999, pointerType: "pen",
        button: 0, buttons: 0, clientX: 20, clientY: 20,
      }));
      return {
        readModeTouchPrevented: readModeStylus.defaultPrevented,
        readModePointerPrevented: readModePointer.defaultPrevented,
        penGuardClassAfterReadPointer: document.documentElement.classList.contains("pdfReaderPenGestureActive"),
        ownershipOnPointerDown: trackedOnDown,
      };
    });
    // Read-mode Pencil ownership intentionally survives synchronously through
    // the browser's compatibility-click boundary. Give its zero-delay cleanup
    // task a real event-loop turn before asserting that the pointer is gone.
    await viewer.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    const readModePenOwnershipAfterPointerEnd = await viewer.evaluate(() => {
      const bridge = window.__nativeFingerBridgeState;
      return {
        nativePen: bridge.nativePenPanPointers.has(999),
        manual: bridge.manualPointers.has(999),
        editor: bridge.activePointers.has(999),
      };
    });
    await viewer.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      source: window, mode: 15, isFromKeyboard: true, createNewEditor: false,
    }));
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 15, { timeout: 5_000 });
    const activeToolTouchPrevented = await viewer.evaluate(() => {
      const target = document.querySelector('.page[data-page-number="1"] .annotationEditorLayer');
      const stylus = new Touch({ identifier: 100, target, clientX: 20, clientY: 20 });
      Object.defineProperty(stylus, "touchType", { value: "stylus" });
      const touchList = { 0: stylus, length: 1, item(index) { return this[index] || null; } };
      const activeToolStylus = new Event("touchstart", { bubbles: true, cancelable: true });
      Object.defineProperties(activeToolStylus, {
        touches: { value: touchList }, changedTouches: { value: touchList },
      });
      target.dispatchEvent(activeToolStylus);
      return activeToolStylus.defaultPrevented;
    });
    const stylusGuard = {
      ...readModeStylusGuard,
      ownershipAfterPointerUp: readModePenOwnershipAfterPointerEnd,
      activeToolTouchPrevented,
    };
    assert.deepEqual(stylusGuard, {
      readModeTouchPrevented: false,
      readModePointerPrevented: false,
      activeToolTouchPrevented: true,
      penGuardClassAfterReadPointer: false,
      ownershipOnPointerDown: { nativePen: true, manual: false, editor: false },
      ownershipAfterPointerUp: { nativePen: false, manual: false, editor: false },
    }, "Read-mode Pencil stays browser-owned while active-tool stylus input retains the legacy guard");

    const telemetry = await viewer.evaluate(() => window.__nativeTouchProbe);
    assert.ok(telemetry.pointers.some((event) => event.type === "pointerdown" && event.trusted),
      "The regression uses trusted browser touch input");
    assert.ok(telemetry.pointers.some((event) => event.pointerType === "touch"),
      "The browser delivers a touch pointer sequence");
    assert.deepEqual(telemetry.prevented.filter((event) => event.trusted), [], "Ordinary finger native touch events are never canceled");
    assert.deepEqual(telemetry.captures, [], "The bridge never captures finger pointers");

    assert.deepEqual(pageErrors, [], "Native ownership regression has no uncaught page errors");
    t.diagnostic(JSON.stringify({
      trustedTouchPointers: telemetry.pointers.length,
      preventedTrustedTouchEvents: telemetry.prevented.filter((event) => event.trusted).length,
      capturedTouchPointers: telemetry.captures.length,
      scrollDeltaReadMode: afterReadTouch.top - initial.top,
      scrollDeltaInkMode: activeAfter.top - activeBefore.top,
      inkPolicy,
      stylusGuard,
    }));
  } catch (error) {
    primaryError = error;
    t.diagnostic(error.stack || error.message);
  } finally {
    try {
      await cdp?.detach().catch(() => {});
      cleanupReport = await cleanupBrowserTestResources({
        browser, ownedPages: [page].filter(Boolean), server,
      });
    } catch (error) {
      cleanupReport = { errors: [{ message: error.message }] };
    }
    attachCleanupErrors(primaryError, cleanupReport);
  }
  if (primaryError) throw primaryError;
  assert.deepEqual(cleanupReport?.errors, [], "Browser and local server clean up cleanly");
});
