import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
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
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const bridgeCssPath = path.join(root, "viewer-adapter", "bridge.css");
const viewerHtmlPath = path.join(
  root,
  "vendor",
  "pdfjs-generic-legacy",
  "web",
  "viewer.html",
);
const channel = "pdf-web-reader";
const token = "mouse-input-browser-regression";
const documentId = "mouse-regression-document";
const rendererGeneration = "mouse-regression-renderer";
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
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

test(
  "trusted browser mouse input keeps PDF.js wheel, annotation, and click controls consistent",
  {
    skip: !browserPath && "Chrome or Edge is required for this browser regression",
    timeout: 180_000,
  },
  async (t) => {
    const [bridgeSource, bridgeCss, viewerHtml] = await Promise.all([
      readFile(bridgePath, "utf8"),
      readFile(bridgeCssPath, "utf8"),
      readFile(viewerHtmlPath, "utf8"),
    ]);
    const viewerWithBridge = viewerHtml.replace(
      /<head\b[^>]*>/i,
      (head) =>
        `${head}<link rel="stylesheet" href="/viewer-adapter/bridge.css"><script src="/viewer-adapter/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}" data-base-url="/vendor/pdfjs-generic-legacy/web/"></script>`,
    );
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(`<!doctype html>
          <meta charset="utf-8">
          <title>PDF mouse input regression</title>
          <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
          <iframe name="pdf-reader" title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
          <script>
            const channel = ${JSON.stringify(channel)};
            const token = ${JSON.stringify(token)};
            const documentId = ${JSON.stringify(documentId)};
            const rendererGeneration = ${JSON.stringify(rendererGeneration)};
            const iframe = document.querySelector('iframe');
            const host = window.__host = { opened:0, openRequest:0, saves:[], savedData:null, errors:[], inputDiagnostics:null, rendererLifecycle:[] };
            const hashBytes = buffer => {
              let hash = 2166136261;
              for (const byte of new Uint8Array(buffer)) hash = Math.imul(hash ^ byte, 16777619);
              return (hash >>> 0).toString(16);
            };
            host.fixturePromise = fetch('/tests/fixtures/tracemonkey.pdf').then(response => {
              if (!response.ok) throw new Error('fixture fetch failed');
              return response.arrayBuffer();
            });
            const sendOpen = data => {
              const openRequest = ++host.openRequest;
              iframe.contentWindow.postMessage({
                channel, type:'open', token, documentId, filename:'tracemonkey.pdf',
                autoSave:false, readOnly:false, openRequest, data,
              }, '*', [data]);
            };
            window.addEventListener('message', event => {
              if (event.source !== iframe.contentWindow) return;
              const message = event.data;
              if (!message || message.channel !== channel || message.token !== token) return;
              if (message.type === 'ready') {
                host.rendererGeneration = message.rendererGeneration;
                host.fixturePromise.then(bytes => {
                  host.initialHash = hashBytes(bytes);
                  sendOpen(bytes.slice(0));
                }).catch(error => host.errors.push(error.message));
              } else if (message.type === 'opened') {
                host.opened += 1;
              } else if (message.type === 'save') {
                const data = message.data.slice(0);
                host.savedData = data;
                host.saves.push({
                  documentId:message.documentId,
                  requestId:message.requestId,
                  revision:message.revision,
                  byteLength:data.byteLength,
                  hash:hashBytes(data),
                });
                iframe.contentWindow.postMessage({
                  channel, type:'saved', token,
                  documentId:message.documentId,
                  requestId:message.requestId,
                  revision:message.revision,
                }, '*');
              } else if (message.type === 'error') {
                host.errors.push(message.code || message.message || 'viewer error');
              } else if (message.type === 'input-diagnostics') {
                host.inputDiagnostics = message;
              } else if (message.type === 'renderer-unloaded' || message.type === 'worker-terminated') {
                host.rendererLifecycle.push({ type:message.type, rendererGeneration:message.rendererGeneration });
              }
            });
            host.reopenSaved = () => {
              if (!host.savedData) throw new Error('No saved bytes are available');
              sendOpen(host.savedData.slice(0));
            };
          </script>`);
        return;
      }
      if (url.pathname === "/viewer-adapter/obsidian-bridge.js") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(bridgeSource);
        return;
      }
      if (url.pathname === "/viewer-adapter/bridge.css") {
        response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
        response.end(bridgeCss);
        return;
      }

      let target;
      if (url.pathname === "/tests/fixtures/tracemonkey.pdf") {
        target = fixture;
      } else if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(viewerWithBridge);
        return;
      } else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
        const relative = decodeURIComponent(
          url.pathname.slice("/vendor/pdfjs-generic-legacy/".length),
        );
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
          "content-type":
            mimeTypes.get(path.extname(target)) || "application/octet-stream",
          "content-length": info.size,
          "x-content-type-options": "nosniff",
        });
        createReadStream(target).pipe(response);
      } catch {
        response.writeHead(404).end("not found");
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let browser;
    let page;
    let viewer;
    let primaryError;
    let cleanupReport;
    try {

    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__host?.opened === 1, {
      timeout: 45_000,
    });
    viewer = page
      .frames()
      .find((frame) => frame.url().includes("/vendor/pdfjs-generic-legacy/web/viewer.html"));
    assert.ok(viewer, "Expected the PDF.js iframe");
    await viewer.waitForSelector(
      '.page[data-page-number="1"] .textLayer span',
      { timeout: 30_000 },
    );
    await viewer.waitForFunction(() => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(0);
      return Boolean(
        app?.pdfDocument &&
        pageView?.renderingState === 3 &&
        pageView?.annotationEditorLayer?.div?.isConnected,
      );
    });
    await viewer.evaluate(() => {
      window.__trustedMouseEvents = [];
      window.__keyboardFocusEvents = [];
      window.__pdfEditorMoveCalls = [];
      window.__pdfEditorMoveEvents = [];
      window.__mouseTestMilestones = {};
      window.__contextMenuEvents = [];
      window.__trustedDoubleClicks = [];
      const isEditableHit = target => {
        const element = target instanceof Element ? target : target?.parentElement;
        return !!element?.closest(
          "input,textarea,select,[contenteditable]:not([contenteditable=false])",
        );
      };
      const summarizeTarget = target => {
        const element = target instanceof Element ? target : target?.parentElement;
        return {
          tag:element?.tagName || "",
          id:element?.id || "",
          className:typeof element?.className === "string" ? element.className : "",
          editable:isEditableHit(element),
        };
      };
      for (const type of ["focusin", "focusout", "keydown", "keyup", "beforeinput", "input"]) {
        window.addEventListener(type, event => {
          const sample = {
            type:event.type,
            time:Math.round(event.timeStamp),
            trusted:event.isTrusted,
            target:summarizeTarget(event.target),
            active:summarizeTarget(document.activeElement),
            rotation:window.PDFViewerApplication?.pdfViewer?.pagesRotation ?? null,
            targetConnected:Boolean(event.target?.isConnected),
            relatedTarget:summarizeTarget(event.relatedTarget),
            documentHasFocus:document.hasFocus(),
          };
          if (event.type === "focusout") {
            sample.stack = new Error().stack?.split("\n").slice(1, 12) || [];
          }
          if (event.type === "keydown" || event.type === "keyup") {
            sample.keyCode = event.keyCode || 0;
            sample.altKey = event.altKey;
            sample.ctrlKey = event.ctrlKey;
            sample.metaKey = event.metaKey;
            sample.shiftKey = event.shiftKey;
          }
          if (event.type === "beforeinput" || event.type === "input") {
            sample.inputType = event.inputType || "";
            sample.dataLength = typeof event.data === "string" ? event.data.length : null;
            sample.composing = event.isComposing;
          }
          window.__keyboardFocusEvents.push(sample);
          if (window.__keyboardFocusEvents.length > 128) {
            window.__keyboardFocusEvents.shift();
          }
        }, true);
      }
      window.__getSquareEditors = () => {
        const storage = window.PDFViewerApplication?.pdfDocument?.annotationStorage;
        return [...document.querySelectorAll(".annotationEditorLayer .inkEditor")]
          .filter((editor) =>
            storage?.getRawValue(editor.id)?.constructor?._editorType === 5,
          );
      };
      window.PDFViewerApplication?.eventBus?._on?.(
        "editormovedindom",
        ({ source }) => {
          window.__pdfEditorMoveEvents.push({
            time:Math.round(performance.now()),
            editorId:source?.id || null,
            internalId:source?.editorDiv?.id || null,
            internalConnected:Boolean(source?.editorDiv?.isConnected),
            internalEditable:Boolean(source?.editorDiv?.isContentEditable),
            active:summarizeTarget(document.activeElement),
            rotation:window.PDFViewerApplication?.pdfViewer?.pagesRotation ?? null,
          });
          if (window.__pdfEditorMoveEvents.length > 64) {
            window.__pdfEditorMoveEvents.shift();
          }
        },
      );
      window.__installPdfEditorMoveTrace = () => {
        const editorLayer = window.PDFViewerApplication?.pdfViewer?._layerProperties
          ?.annotationEditorUIManager?.currentLayer;
        const originalMoveEditorInDOM = editorLayer?.moveEditorInDOM;
        if (typeof originalMoveEditorInDOM !== "function") return false;
        if (originalMoveEditorInDOM.__mouseTestTraced) return true;
        const tracedMoveEditorInDOM = function (editor, ...args) {
          const internal = editor?.editorDiv || null;
          const sample = {
            time:Math.round(performance.now()),
            phase:"before",
            editorId:editor?.id || null,
            internalId:internal?.id || null,
            internalConnected:Boolean(internal?.isConnected),
            internalEditable:Boolean(internal?.isContentEditable),
            activeId:document.activeElement?.id || "",
            stack:new Error().stack?.split("\n").slice(1, 8) || [],
          };
          window.__pdfEditorMoveCalls.push(sample);
          if (window.__pdfEditorMoveCalls.length > 64) {
            window.__pdfEditorMoveCalls.shift();
          }
          try {
            return originalMoveEditorInDOM.call(this, editor, ...args);
          } finally {
            sample.phase = "after";
            sample.activeIdAfter = document.activeElement?.id || "";
            sample.internalConnectedAfter = Boolean(internal?.isConnected);
            sample.internalEditableAfter = Boolean(internal?.isContentEditable);
          }
        };
        Object.defineProperty(tracedMoveEditorInDOM, "__mouseTestTraced", {
          value:true,
        });
        editorLayer.moveEditorInDOM = tracedMoveEditorInDOM;
        return true;
      };
      window.__mouseTestMilestones.editorMoveTracingInstalled =
        window.__installPdfEditorMoveTrace();
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
        window.addEventListener(type, event => {
          window.__trustedMouseEvents.push({
            type:event.type,
            pointerType:event.pointerType || "unknown",
            button:event.button,
            buttons:event.buttons,
            pointerId:event.pointerId,
            trusted:event.isTrusted,
            targetTag:event.target?.tagName || "",
            targetClass:typeof event.target?.className === "string"
              ? event.target.className
              : "",
            editable:isEditableHit(event.target),
          });
        }, true);
      }
      window.addEventListener("contextmenu", event => {
        const sample = {
          trusted:event.isTrusted,
          defaultPrevented:event.defaultPrevented,
          editable:isEditableHit(event.target),
          targetTag:event.target?.tagName || "",
          targetClass:typeof event.target?.className === "string"
            ? event.target.className
            : "",
        };
        queueMicrotask(() => {
          sample.defaultPrevented = event.defaultPrevented;
          window.__contextMenuEvents.push(sample);
        });
      }, true);
      window.addEventListener("dblclick", event => {
        window.__trustedDoubleClicks.push({
          trusted:event.isTrusted,
          inFreeText:!!event.target.closest?.(".freeTextEditor"),
          editable:!!event.target.closest?.("[contenteditable]:not([contenteditable=false])"),
        });
      }, true);
    });

    const iframeOffset = async () =>
      page.$eval("iframe", (frame) => {
        const rect = frame.getBoundingClientRect();
        return { x:rect.x, y:rect.y };
      });
    const mousePoint = async (selector, index = null) => {
      const local = await viewer.evaluate(
        ({ selector:query, index:buttonIndex }) => {
          const element = buttonIndex === null
            ? document.querySelector(query)
            : document.querySelectorAll(query)[buttonIndex];
          if (!element) throw new Error(`Missing mouse target: ${query}`);
          const rect = element.getBoundingClientRect();
          return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
        },
        { selector, index },
      );
      const offset = await iframeOffset();
      return { x:offset.x + local.x, y:offset.y + local.y };
    };
    const click = async (selector, index = null, options = {}) => {
      const point = await mousePoint(selector, index);
      await page.mouse.click(point.x, point.y, options);
      return point;
    };
    const drag = async (start, end, button = "left") => {
      const offset = await iframeOffset();
      await page.mouse.move(offset.x + start.x, offset.y + start.y, { steps:2 });
      await page.mouse.down({ button });
      await page.mouse.move(offset.x + end.x, offset.y + end.y, { steps:8 });
      await page.mouse.up({ button });
    };
    const openActionMenu = async () => {
      await click('.pdfReaderBridgeControlButton[aria-label="撤销、重做、删除和保存"]');
      await viewer.waitForFunction(
        () => !document.querySelector(".pdfReaderBridgeActionMenu")?.hidden,
      );
    };
    const clickAction = async (action) => {
      await openActionMenu();
      await click(`.pdfReaderBridgeActionMenu [data-action="${action}"]`);
    };
    const squareBounds = async ({ includeHandle = false } = {}) =>
      viewer.evaluate((includeResizeHandle) => {
        const editor = window.__getSquareEditors()[0];
        if (!editor) throw new Error("No editable Square editor is present");
        const rect = editor.getBoundingClientRect();
        const bounds = { x:rect.x, y:rect.y, width:rect.width, height:rect.height };
        if (includeResizeHandle) {
          const handle = editor.querySelector(
            '.resizer[data-resizer-name="bottomRight"]',
          );
          if (!handle) throw new Error("Square resize handle is missing");
          const handleRect = handle.getBoundingClientRect();
          bounds.handle = {
            x:handleRect.x + handleRect.width / 2,
            y:handleRect.y + handleRect.height / 2,
          };
        }
        return bounds;
      }, includeHandle);
    const setSquareMode = async (mode) => {
      const currentMode = await viewer.evaluate(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode,
      );
      if (currentMode === mode) return;
      if (![0, 5].includes(currentMode) || ![0, 5].includes(mode)) {
        throw new Error(`Unexpected annotation editor mode transition ${currentMode} → ${mode}`);
      }
      await click("#editorSquareButton");
      await viewer.waitForFunction(
        (expectedMode) =>
          PDFViewerApplication.pdfViewer.annotationEditorMode === expectedMode,
        { timeout: 8_000 },
        mode,
      );
    };
    const layerBounds = () =>
      viewer.evaluate(() => {
        const rect = document
          .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
          .getBoundingClientRect();
        return { x:rect.x, y:rect.y, width:rect.width, height:rect.height };
      });

    // The bridge entry is a click alternative to the middle-button wheel. It
    // must retain the exact frozen vendor map and activate PDF.js's own mode.
    await click('.pdfReaderBridgeControlButton[aria-label^="批注工具圆盘"]');
    await viewer.waitForSelector(".pdfReaderBridgeClickWheel:not([hidden])");
    assert.deepEqual(
      await viewer.$$eval(".pdfReaderBridgeClickWheel button", (buttons) =>
        buttons.map((button) => button.getAttribute("aria-label")),
      ),
      ["退出", "5 文字框", "4 自由画笔", "3 荧光笔", "2 矩形框", "1 下划线"],
    );
    await page.setViewport({ width:900, height:500 });
    await viewer.waitForFunction(() => {
      const wheel = document.querySelector(".pdfReaderBridgeClickWheel");
      const rect = wheel?.getBoundingClientRect();
      return window.innerWidth === 900 && window.innerHeight === 500 && rect &&
        Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) <= 1 &&
        Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2) <= 1;
    }, { timeout:5_000 });
    const resizedWheelBounds = await viewer.evaluate(() => {
      const wheel = document.querySelector(".pdfReaderBridgeClickWheel");
      const rect = wheel.getBoundingClientRect();
      return {
        left:rect.left,
        top:rect.top,
        right:rect.right,
        bottom:rect.bottom,
        centerX:rect.left + rect.width / 2,
        centerY:rect.top + rect.height / 2,
        width:window.innerWidth,
        height:window.innerHeight,
      };
    });
    assert.ok(
      resizedWheelBounds.left >= 0 &&
        resizedWheelBounds.top >= 0 &&
        resizedWheelBounds.right <= resizedWheelBounds.width &&
        resizedWheelBounds.bottom <= resizedWheelBounds.height &&
        Math.abs(resizedWheelBounds.centerX - resizedWheelBounds.width / 2) <= 1 &&
        Math.abs(resizedWheelBounds.centerY - resizedWheelBounds.height / 2) <= 1,
      `The visible click wheel should recenter and stay within a resized viewer: ${JSON.stringify(resizedWheelBounds)}`,
    );
    const assertCompactToolbarFits = async (width) => {
      await page.setViewport({ width, height:500 });
      await viewer.waitForFunction(
        (expectedWidth) => window.innerWidth === expectedWidth &&
          document.querySelectorAll(".pdfReaderBridgeControls .pdfReaderBridgeControlButton").length === 2,
        { timeout:5_000 },
        width,
      );
      const layout = await viewer.evaluate(() => {
        const toolbar = document.getElementById("toolbarContainer");
        const right = document.getElementById("toolbarViewerRight");
        const containerRect = toolbar.getBoundingClientRect();
        const mustReach = [
          ...document.querySelectorAll(".pdfReaderBridgeControls .pdfReaderBridgeControlButton"),
          document.getElementById("secondaryToolbarToggleButton"),
        ];
        const box = (element) => {
          if (!element) return null;
          const rect = element.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return {
            label:element.getAttribute("aria-label") || element.id,
            left:rect.left,
            right:rect.right,
            top:rect.top,
            bottom:rect.bottom,
            width:rect.width,
            height:rect.height,
            hitTarget:hit === element || element.contains(hit),
            whiteSpace:getComputedStyle(element).whiteSpace,
            scrollWidth:element.scrollWidth,
            clientWidth:element.clientWidth,
          };
        };
        const visibleRightButtons = [...right.querySelectorAll("button")]
          .filter((button) => button.getClientRects().length > 0)
          .map(box);
        return {
          viewportWidth:window.innerWidth,
          toolbar:{ left:containerRect.left, right:containerRect.right, scrollWidth:toolbar.scrollWidth, clientWidth:toolbar.clientWidth },
          right:{ left:right.getBoundingClientRect().left, right:right.getBoundingClientRect().right, scrollWidth:right.scrollWidth, clientWidth:right.clientWidth },
          controls:mustReach.map(box),
          visibleRightButtons,
        };
      });
      const withinToolbar = (button) => button && button.width > 0 && button.height > 0 &&
        button.left >= layout.toolbar.left && button.right <= layout.toolbar.right + 1 &&
        button.top >= 0 && button.bottom <= 64 && button.hitTarget;
      assert.ok(
        layout.right.left >= layout.toolbar.left && layout.right.right <= layout.toolbar.right + 1 &&
          layout.right.scrollWidth <= layout.right.clientWidth + 1 &&
          layout.visibleRightButtons.every(withinToolbar) &&
          layout.controls.every(withinToolbar),
        `All visible toolbar and bridge controls should remain clickable inside a ${width}px pane: ${JSON.stringify(layout)}`,
      );
      assert.ok(
        layout.controls.filter((button) => button.label !== "secondaryToolbarToggleButton")
          .every((button) => button.whiteSpace === "nowrap" && button.scrollWidth <= button.clientWidth + 1),
        `The bridge tool and edit labels should not wrap vertically at ${width}px: ${JSON.stringify(layout.controls)}`,
      );
    };
    // The native app's 800px split pane previously pushed the PDF.js Tools
    // toggle off-screen and wrapped the two new Chinese labels vertically.
    // Check both sides of the 880px layout breakpoint so it doesn't create a
    // narrow overflow band immediately above the compact two-row toolbar.
    await assertCompactToolbarFits(881);
    await assertCompactToolbarFits(880);
    await assertCompactToolbarFits(800);
    await assertCompactToolbarFits(600);
    await page.setViewport({ width:1400, height:1000 });
    await viewer.waitForFunction(() => {
      const wheel = document.querySelector(".pdfReaderBridgeClickWheel");
      const rect = wheel?.getBoundingClientRect();
      return rect && Math.abs(rect.left + rect.width / 2 - window.innerWidth / 2) <= 1;
    });
    await click('.pdfReaderBridgeClickWheel [data-sector="4"]');
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
    );
    assert.ok(
      await viewer.evaluate(
        () => document.getElementById("editorSquareParamsToolbar").classList.contains("hidden"),
      ),
      "The click wheel should match PDF.js's native wheel behavior and leave tool parameters closed",
    );

    // Real mouse events create a Square. The browser event log below checks
    // isTrusted and pointerType; this is trusted Puppeteer input.
    const layer = await layerBounds();
    const squareStart = { x:layer.x + 120, y:layer.y + 150 };
    await drag(squareStart, { x:squareStart.x + 100, y:squareStart.y + 74 });
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 1,
      { timeout: 10_000 },
    );
    await viewer.waitForFunction(
      () => !document.querySelector('.pdfReaderBridgeActionMenu [data-action="undo"]')?.disabled,
    );
    await clickAction("undo");
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 0,
      { timeout: 8_000 },
    );
    await clickAction("redo");
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 1,
      { timeout: 8_000 },
    );
    const savesBeforeSquare = await page.evaluate(() => window.__host.saves.length);
    await clickAction("save");
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 20_000 },
      savesBeforeSquare,
    );
    const squareSave = await page.evaluate(() => ({
      ...window.__host.saves.at(-1),
      initialHash:window.__host.initialHash,
    }));
    assert.ok(squareSave.byteLength > 0, "The clicked Save control should produce PDF bytes");
    assert.notEqual(
      squareSave.hash,
      squareSave.initialHash,
      "The serialized PDF bytes should include the mouse-drawn annotation",
    );
    const openedBeforeSquareReopen = await page.evaluate(() => window.__host.opened);
    await page.evaluate(() => window.__host.reopenSaved());
    await page.waitForFunction(
      (count) => window.__host.opened === count + 1,
      { timeout: 20_000 },
      openedBeforeSquareReopen,
    );
    await viewer.waitForSelector(
      '.page[data-page-number="1"] .textLayer span',
      { timeout: 20_000 },
    );
    assert.equal(
      await viewer.evaluate(async () => {
        const annotations = await PDFViewerApplication.pdfDocument
          .getPage(1)
          .then((pdfPage) => pdfPage.getAnnotations());
        return annotations.filter((annotation) => annotation.subtype === "Square").length;
      }),
      1,
      "Saved bytes should reopen with the mouse-created Square intact",
    );

    // Reopened PDF annotations start as existing page annotations. A trusted
    // double-click enters PDF.js explicit edit mode; then a real mouse drag
    // moves the existing Square instead of issuing a second create gesture.
    await setSquareMode(5);
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5 &&
        window.__getSquareEditors().length === 1,
      { timeout: 12_000 },
    );
    const squareBeforeEdit = await viewer.evaluate(() => {
      const editor = window.__getSquareEditors()[0];
      const raw = PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(editor.id);
      const rect = editor.getBoundingClientRect();
      return {
        uid:raw.uid,
        x:rect.x,
        y:rect.y,
        width:rect.width,
        height:rect.height,
      };
    });
    await setSquareMode(0);
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
    );
    const squareHit = {
      x:squareBeforeEdit.x + squareBeforeEdit.width / 2,
      y:squareBeforeEdit.y + squareBeforeEdit.height / 2,
      uid:squareBeforeEdit.uid,
    };
    await viewer.waitForFunction(
      ({ x, y, uid }) => {
        const annotation = [
          ...document.querySelectorAll(
            '.page[data-page-number="1"] .annotationLayer .squareAnnotation',
          ),
        ].find((element) => element.id.endsWith(uid));
        const hit = document.elementFromPoint(x, y);
        return !!annotation && hit?.closest(".squareAnnotation") === annotation;
      },
      { timeout:8_000 },
      squareHit,
    );
    const offset = await iframeOffset();
    await page.mouse.click(
      offset.x + squareHit.x,
      offset.y + squareHit.y,
      { clickCount:2, delay:80 },
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5 &&
        Boolean(document.querySelector(".annotationEditorLayer .explicitlyEditing")),
      { timeout: 8_000 },
    );

    const requestInputDiagnostics = async (requestId) => {
      await page.evaluate((id) => {
        window.__host.inputDiagnostics = null;
        document.querySelector("iframe").contentWindow.postMessage({
          channel:"pdf-web-reader",
          type:"get-input-diagnostics",
          token:"mouse-input-browser-regression",
          requestId:id,
        }, "*");
      }, requestId);
      await page.waitForFunction(
        (id) => window.__host.inputDiagnostics?.requestId === id,
        { timeout:5_000 },
        requestId,
      );
      return page.evaluate(() => window.__host.inputDiagnostics);
    };
    const cancelTrustedLeftDrag = async (start, end, requestId) => {
      const frameOffset = await iframeOffset();
      await page.mouse.move(frameOffset.x + start.x, frameOffset.y + start.y, { steps:2 });
      await page.mouse.down({ button:"left" });
      await page.mouse.move(frameOffset.x + end.x, frameOffset.y + end.y, { steps:5 });
      const pointerId = await viewer.evaluate(() => window.__trustedMouseEvents.findLast(
        (event) => event.type === "pointerdown" && event.button === 0 && event.trusted,
      )?.pointerId);
      assert.ok(Number.isInteger(pointerId), "Expected a trusted left mouse pointer session");
      await viewer.evaluate((id) => {
        const event = new PointerEvent("pointercancel", {
          bubbles:true,
          cancelable:true,
          pointerId:id,
          pointerType:"mouse",
          button:0,
          buttons:0,
        });
        window.__syntheticCancelProbe = { type:"pointercancel", trusted:event.isTrusted, pointerId:id };
        window.dispatchEvent(event);
      }, pointerId);
      await viewer.waitForFunction(
        (id) => window.__syntheticCancelProbe?.trusted === false &&
          window.__trustedMouseEvents.some((event) =>
            event.type === "pointerup" && event.pointerId === id && !event.trusted,
          ),
        { timeout:5_000 },
        pointerId,
      );
      await page.mouse.up({ button:"left" });
      const diagnostics = await requestInputDiagnostics(requestId);
      assert.equal(diagnostics.activePointers, 0, "Cancellation should release the bridge pointer boundary");
      assert.ok(
        diagnostics.pointers.some((event) =>
          event.type === "pointerup" && event.pointerType === "mouse" &&
          event.button === 0 && event.trusted === false,
        ),
        "The internal pointerup cleanup must remain explicitly untrusted",
      );
      return pointerId;
    };

    // Reopened annotations need a trusted double-click before a mouse drag
    // moves or resizes them. Probe each PDF.js private session with an
    // explicitly untrusted pointercancel, then prove the next trusted gesture
    // still completes. This tests browser cleanup, not iPad hardware delivery.
    const beforeCancelledMove = await squareBounds();
    const cancelledMoveStart = {
      x:beforeCancelledMove.x + beforeCancelledMove.width * 0.45,
      y:beforeCancelledMove.y + beforeCancelledMove.height / 2,
    };
    await cancelTrustedLeftDrag(
      cancelledMoveStart,
      { x:cancelledMoveStart.x + 24, y:cancelledMoveStart.y + 18 },
      "mouse-move-cancel",
    );
    await viewer.waitForFunction(
      ({ x, y }) => {
        const rect = window.__getSquareEditors()[0]?.getBoundingClientRect();
        return rect && (Math.abs(rect.x - x) > 5 || Math.abs(rect.y - y) > 5);
      },
      { timeout: 8_000 },
      { x:beforeCancelledMove.x, y:beforeCancelledMove.y },
    );
    let beforeMove = await squareBounds();
    let moveStart = {
      x:beforeMove.x + beforeMove.width * 0.45,
      y:beforeMove.y + beforeMove.height / 2,
    };
    await drag(moveStart, { x:moveStart.x + 30, y:moveStart.y + 24 });
    await viewer.waitForFunction(
      ({ x, y }) => {
        const rect = window.__getSquareEditors()[0]?.getBoundingClientRect();
        return rect && (Math.abs(rect.x - x) > 5 || Math.abs(rect.y - y) > 5);
      },
      { timeout:8_000 },
      { x:beforeMove.x, y:beforeMove.y },
    );

    const beforeCancelledResize = await squareBounds({ includeHandle:true });
    await cancelTrustedLeftDrag(
      beforeCancelledResize.handle,
      { x:beforeCancelledResize.handle.x + 24, y:beforeCancelledResize.handle.y + 18 },
      "mouse-resize-cancel",
    );
    await viewer.waitForFunction(
      ({ width, height }) => {
        const rect = window.__getSquareEditors()[0]?.getBoundingClientRect();
        return rect && (rect.width > width + 10 || rect.height > height + 10);
      },
      { timeout:8_000 },
      { width:beforeCancelledResize.width, height:beforeCancelledResize.height },
    );
    const beforeResize = await squareBounds({ includeHandle:true });
    await drag(beforeResize.handle, {
      x:beforeResize.handle.x + 24,
      y:beforeResize.handle.y + 18,
    });
    const resizedBounds = await squareBounds();
    await viewer.waitForFunction(
      ({ width, height }) => {
        const rect = window.__getSquareEditors()[0]?.getBoundingClientRect();
        return rect && (rect.width > width + 10 || rect.height > height + 10);
      },
      { timeout: 8_000 },
      { width:beforeResize.width, height:beforeResize.height },
    );

    // Clicked undo/redo, delete, and save controls must affect PDF.js state and
    // serialized bytes through the real host save path.
    await viewer.waitForFunction(
      () => !document.querySelector('.pdfReaderBridgeActionMenu [data-action="undo"]')?.disabled,
    );
    await clickAction("undo");
    await viewer.waitForFunction(
      ({ width, height }) => {
        const rect = window.__getSquareEditors()[0]?.getBoundingClientRect();
        return rect && Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 1;
      },
      { timeout: 8_000 },
      { width:beforeResize.width, height:beforeResize.height },
    );
    await clickAction("redo");
    await viewer.waitForFunction(
      ({ width, height }) => {
        const rect = window.__getSquareEditors()[0]?.getBoundingClientRect();
        return rect && Math.abs(rect.width - width) < 1 && Math.abs(rect.height - height) < 1;
      },
      { timeout: 8_000 },
      { width:resizedBounds.width, height:resizedBounds.height },
    );
    await viewer.waitForFunction(
      () => !document.querySelector('.pdfReaderBridgeActionMenu [data-action="delete"]')?.disabled,
    );
    await clickAction("delete");
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 0,
      { timeout: 8_000 },
    );
    await clickAction("undo");
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 1,
      { timeout: 8_000 },
    );
    const savesBeforeEdit = await page.evaluate(() => window.__host.saves.length);
    await clickAction("save");
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 20_000 },
      savesBeforeEdit,
    );
    const editedSquareSave = await page.evaluate(() => ({
      ...window.__host.saves.at(-1),
      initialHash:window.__host.initialHash,
    }));
    assert.notEqual(
      editedSquareSave.hash,
      editedSquareSave.initialHash,
      "Saving the moved/resized Square should change serialized PDF bytes",
    );
    const openedBeforeEditedSquareReopen = await page.evaluate(
      () => window.__host.opened,
    );
    await page.evaluate(() => window.__host.reopenSaved());
    await page.waitForFunction(
      (count) => window.__host.opened === count + 1,
      { timeout: 20_000 },
      openedBeforeEditedSquareReopen,
    );
    await viewer.waitForSelector(
      '.page[data-page-number="1"] .textLayer span',
      { timeout: 20_000 },
    );
    assert.equal(
      await viewer.evaluate(async () => {
        const annotations = await PDFViewerApplication.pdfDocument
          .getPage(1)
          .then((pdfPage) => pdfPage.getAnnotations());
        return annotations.filter((annotation) => annotation.subtype === "Square").length;
      }),
      1,
      "The resized Square should remain after the second save and reopen",
    );
    await setSquareMode(5);
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 1,
      { timeout: 12_000 },
    );

    // Right-button drag temporarily switches to the native eraser and restores
    // the active tool. The bridge doesn't capture this pointer; PDF.js owns its
    // internal viewerContainer capture and cancelTemporaryStroke release path.
    const reopenedSquare = await squareBounds();
    const originalMode = await viewer.evaluate(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode,
    );
    await drag(
      { x:reopenedSquare.x - 45, y:reopenedSquare.y + reopenedSquare.height / 2 },
      { x:reopenedSquare.x + reopenedSquare.width / 2, y:reopenedSquare.y + reopenedSquare.height / 2 },
      "right",
    );
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 0,
      { timeout: 8_000 },
    );
    await viewer.waitForFunction(
      (mode) =>
        PDFViewerApplication.pdfViewer.annotationEditorMode === mode &&
        !document.body.classList.contains("editorEraserMode"),
      { timeout: 8_000 },
      originalMode,
    );
    await clickAction("undo");
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 1,
      { timeout: 8_000 },
    );

    // Exercise PDF.js's trusted browser middle-button wheel and center-release
    // state: release at the center leaves the wheel open for a subsequent
    // real click on a sector. The wheel remains vendor-owned.
    const viewerCenter = await viewer.evaluate(() => {
      const rect = document.getElementById("viewerContainer").getBoundingClientRect();
      return { x:rect.left + rect.width * 0.72, y:rect.top + rect.height * 0.55 };
    });
    await page.mouse.move(offset.x + viewerCenter.x, offset.y + viewerCenter.y);
    await page.mouse.down({ button:"middle" });
    await viewer.waitForSelector(
      ".pdfToolWheel:not(.pdfReaderBridgeClickWheel)",
    );
    await page.mouse.up({ button:"middle" });
    await viewer.waitForFunction(
      () => Boolean(document.querySelector(
        ".pdfToolWheel:not(.pdfReaderBridgeClickWheel)",
      )),
      { timeout: 5_000 },
    );
    await click('.pdfToolWheel:not(.pdfReaderBridgeClickWheel) button[aria-label="2 矩形框"]');
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
      { timeout: 5_000 },
    );

    // Wheel input on a native parameter input remains isolated from the
    // middle-button tool wheel and does not change the active PDF.js tool.
    await click("#editorSquareButton");
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
    );
    await click("#editorSquareButton");
    await viewer.waitForFunction(
      () =>
        PDFViewerApplication.pdfViewer.annotationEditorMode === 5 &&
        !document.getElementById("editorSquareParamsToolbar").classList.contains("hidden"),
    );
    const parameterInput = await mousePoint("#editorSquareThickness");
    await page.mouse.move(parameterInput.x, parameterInput.y);
    await page.mouse.down({ button:"middle" });
    await page.mouse.up({ button:"middle" });
    assert.equal(
      await viewer.evaluate(() => Boolean(document.querySelector(
        ".pdfToolWheel:not(.pdfReaderBridgeClickWheel)",
      ))),
      false,
      "Middle-clicking a native parameter input must not open the tool wheel",
    );
    assert.equal(
      await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode),
      5,
      "Native parameter controls must not change the selected editor mode",
    );

    // A narrow synthetic pointercancel probes cancellation-only cleanup. It is
    // explicitly not a simulation or claim about a physical iPad event.
    await page.mouse.move(offset.x + viewerCenter.x, offset.y + viewerCenter.y);
    await page.mouse.down({ button:"middle" });
    await viewer.waitForSelector(
      ".pdfToolWheel:not(.pdfReaderBridgeClickWheel)",
    );
    const middlePointerId = await viewer.evaluate(() =>
      window.__trustedMouseEvents.findLast(
        (event) => event.type === "pointerdown" && event.button === 1 && event.trusted,
      )?.pointerId,
    );
    assert.ok(Number.isInteger(middlePointerId), "Expected an actual mouse pointer id");
    await viewer.evaluate((pointerId) => {
      window.__syntheticCancelProbe = { isTrusted:false, pointerId };
      window.dispatchEvent(new PointerEvent("pointercancel", {
        bubbles:true,
        pointerId,
        pointerType:"mouse",
        button:1,
        buttons:0,
      }));
    }, middlePointerId);
    await viewer.waitForFunction(
      () => !document.querySelector(
        ".pdfToolWheel:not(.pdfReaderBridgeClickWheel)",
      ) &&
        window.__syntheticCancelProbe?.isTrusted === false,
      { timeout: 5_000 },
    );
    await page.mouse.up({ button:"middle" });

    // Ordinary wheel scroll moves the viewer without changing scale. Ctrl-wheel
    // at the document uses PDF.js zoom; this checks the wheel route stays
    // separate from the bridge's middle-button radial menu.
    const beforeWheel = await viewer.evaluate(() => ({
      scale:PDFViewerApplication.pdfViewer.currentScale,
      scrollTop:document.getElementById("viewerContainer").scrollTop,
    }));
    const scrollPoint = await viewer.evaluate(() => {
      const rect = document.getElementById("viewerContainer").getBoundingClientRect();
      return { x:rect.left + rect.width * 0.85, y:rect.top + rect.height * 0.8 };
    });
    await page.mouse.move(offset.x + scrollPoint.x, offset.y + scrollPoint.y);
    await page.mouse.wheel({ deltaY:120 });
    await viewer.waitForFunction(
      (scrollTop) => document.getElementById("viewerContainer").scrollTop > scrollTop,
      { timeout: 5_000 },
      beforeWheel.scrollTop,
    );
    assert.equal(
      await viewer.evaluate(() => PDFViewerApplication.pdfViewer.currentScale),
      beforeWheel.scale,
      "An unmodified mouse wheel should scroll rather than zoom the PDF",
    );
    await page.keyboard.down("Control");
    await page.mouse.wheel({ deltaY:-120 });
    await page.keyboard.up("Control");
    await viewer.waitForFunction(
      (scale) => PDFViewerApplication.pdfViewer.currentScale !== scale,
      { timeout: 5_000 },
      beforeWheel.scale,
    );
    await viewer.evaluate(() => {
      window.__mouseTestMilestones.rotationBeforeFreeTextCreation =
        PDFViewerApplication.pdfViewer.pagesRotation;
      window.__mouseTestMilestones.pageBeforeFreeTextCreation =
        PDFViewerApplication.pdfViewer.currentPageNumber;
    });

    // A text editor saved and reopened from real mouse input remains editable
    // through the native double-click path. Right-click inside its contenteditable
    // keeps the browser's native context menu available.
    await click('.pdfReaderBridgeControlButton[aria-label^="批注工具圆盘"]');
    await viewer.waitForSelector(".pdfReaderBridgeClickWheel:not([hidden])");
    await click('.pdfReaderBridgeClickWheel [data-sector="1"]');
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
      { timeout: 5_000 },
    );
    await viewer.evaluate(() => {
      window.__mouseTestMilestones.editorMoveTracingInstalled =
        window.__installPdfEditorMoveTrace();
      window.__pdfEditorMoveCalls.length = 0;
      window.__pdfEditorMoveEvents.length = 0;
    });
    const freeTextPoint = await viewer.evaluate(() => {
      const layer = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      const viewport = document.getElementById("viewerContainer").getBoundingClientRect();
      const left = Math.max(layer.left, viewport.left);
      const top = Math.max(layer.top, viewport.top);
      const right = Math.min(layer.right, viewport.right);
      const bottom = Math.min(layer.bottom, viewport.bottom);
      if (right <= left || bottom <= top) {
        throw new Error("The visible annotation editor area does not intersect the viewer");
      }
      return {
        x:left + Math.min(260, (right - left) / 2),
        y:top + Math.min(160, (bottom - top) / 2),
      };
    });
    const offsetForText = await iframeOffset();
    await page.mouse.click(
      offsetForText.x + freeTextPoint.x,
      offsetForText.y + freeTextPoint.y,
    );
    await viewer.waitForSelector(
      ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      { timeout: 8_000 },
    );
    const initialFreeTextFocus = await viewer.evaluate(() => {
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editor = internal?.closest(".freeTextEditor.selectedEditor");
      const rect = internal?.getBoundingClientRect();
      const editorRect = editor?.getBoundingClientRect();
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const focus = selection?.focusNode;
      return {
        id:internal?.id || null,
        contentEditable:internal?.getAttribute("contenteditable"),
        active:document.activeElement === internal,
        connected:Boolean(internal?.isConnected),
        selected:Boolean(editor),
        frameHasFocus:document.hasFocus(),
        topHasFocus:window.top.document.hasFocus(),
        topOwnsFrameFocus:window.top.document.activeElement === window.frameElement,
        selectionCollapsed:Boolean(selection?.isCollapsed),
        selectionWithinInternal:Boolean(
          internal && selection?.rangeCount === 1 && anchor && focus &&
          (anchor === internal || internal.contains(anchor)) &&
          (focus === internal || internal.contains(focus)),
        ),
        internalRect:rect ? { x:rect.x, y:rect.y, width:rect.width, height:rect.height } : null,
        editorRect:editorRect
          ? { x:editorRect.x, y:editorRect.y, width:editorRect.width, height:editorRect.height }
          : null,
      };
    });
    if (!(
      initialFreeTextFocus.contentEditable === "true" &&
      initialFreeTextFocus.active &&
      initialFreeTextFocus.connected &&
      initialFreeTextFocus.selected &&
      initialFreeTextFocus.frameHasFocus &&
      initialFreeTextFocus.topHasFocus &&
      initialFreeTextFocus.topOwnsFrameFocus &&
      initialFreeTextFocus.selectionCollapsed &&
      initialFreeTextFocus.selectionWithinInternal &&
      initialFreeTextFocus.editorRect?.width > 0 &&
      initialFreeTextFocus.editorRect?.height > 0
    )) {
      const editorClickPoint = await viewer.evaluate(() => {
        const internal = document.querySelector(
          ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
        );
        const editor = internal?.closest(".freeTextEditor.selectedEditor");
        editor?.scrollIntoView({ block:"center", inline:"center", behavior:"auto" });
        const internalRect = internal?.getBoundingClientRect();
        const editorRect = editor?.getBoundingClientRect();
        if (!internal || !editor || !editorRect ||
          editorRect.width <= 0 || editorRect.height <= 0) return null;
        if (!internalRect || internalRect.width <= 0 || internalRect.height <= 0) return null;
        const targetRect = internalRect;
        const x = targetRect.x + targetRect.width / 2;
        const y = targetRect.y + targetRect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          x,
          y,
          visible:x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight,
          hitInsideInternal:Boolean(hit && (hit === internal || internal.contains(hit))),
          hitInsideEditor:Boolean(hit && (hit === editor || editor.contains(hit))),
          editorRect:{ x:editorRect.x, y:editorRect.y, width:editorRect.width, height:editorRect.height },
        };
      });
      assert.ok(
        editorClickPoint?.visible && editorClickPoint.hitInsideInternal,
        `A real focus click must hit the visible selected FreeText contenteditable: ${JSON.stringify(editorClickPoint)}`,
      );
      await page.mouse.click(
        offsetForText.x + editorClickPoint.x,
        offsetForText.y + editorClickPoint.y,
        { button:"left" },
      );
    }
    await viewer.waitForFunction(async () => {
      const snapshot = () => {
        const internal = document.querySelector(
          ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
        );
        const editor = internal?.closest(".freeTextEditor.selectedEditor");
        const internalRect = internal?.getBoundingClientRect();
        const editorRect = editor?.getBoundingClientRect();
        const selection = window.getSelection();
        const anchor = selection?.anchorNode;
        const focus = selection?.focusNode;
        return {
          id:internal?.id || null,
          ready:Boolean(
            internal?.isContentEditable && document.activeElement === internal &&
            internal.isConnected && editor && document.hasFocus() &&
            window.top.document.hasFocus() &&
            window.top.document.activeElement === window.frameElement &&
            selection?.rangeCount === 1 && selection.isCollapsed && anchor && focus &&
            (anchor === internal || internal.contains(anchor)) &&
            (focus === internal || internal.contains(focus)) &&
            internalRect?.height > 0 &&
            editorRect?.width > 0 && editorRect?.height > 0
          ),
          internalWidth:internalRect?.width ?? 0,
          internalHeight:internalRect?.height ?? 0,
          editorWidth:editorRect?.width ?? 0,
          editorHeight:editorRect?.height ?? 0,
        };
      };
      const first = snapshot();
      if (!first.ready) return false;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const second = snapshot();
      if (!second.ready) return false;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const third = snapshot();
      return third.ready && [second, third].every((state) =>
        state.id === first.id &&
        state.internalWidth === first.internalWidth &&
        state.internalHeight === first.internalHeight &&
        state.editorWidth === first.editorWidth &&
        state.editorHeight === first.editorHeight,
      );
    }, { timeout:8_000 });
    const focusBeforeTyping = await viewer.evaluate(() => {
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editor = internal?.closest(".freeTextEditor.selectedEditor");
      const rect = internal?.getBoundingClientRect();
      const editorRect = editor?.getBoundingClientRect();
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const focus = selection?.focusNode;
      const summary = element => ({
        tag:element?.nodeType === Node.ELEMENT_NODE
          ? element.tagName
          : element?.parentElement?.tagName || "",
        id:element?.parentElement?.id || element?.id || "",
      });
      const selectionOffsetFor = internal => {
        if (!internal || !selection?.rangeCount || !selection.isCollapsed) return null;
        const range = selection.getRangeAt(0);
        if (range.startContainer !== internal && !internal.contains(range.startContainer)) {
          return null;
        }
        const prefix = document.createRange();
        prefix.selectNodeContents(internal);
        prefix.setEnd(range.startContainer, range.startOffset);
        return prefix.toString().replace(/\u200b/g, "").length;
      };
      return {
        id:internal?.id || null,
        contentEditable:internal?.getAttribute("contenteditable"),
        active:document.activeElement === internal,
        connected:Boolean(internal?.isConnected),
        selected:Boolean(editor),
        frameHasFocus:document.hasFocus(),
        topHasFocus:window.top.document.hasFocus(),
        topOwnsFrameFocus:window.top.document.activeElement === window.frameElement,
        internalRect:rect ? { width:rect.width, height:rect.height } : null,
        editorRect:editorRect ? { width:editorRect.width, height:editorRect.height } : null,
        selectionCollapsed:!!selection?.isCollapsed,
        selectionWithinInternal:Boolean(
          internal && selection?.rangeCount === 1 &&
          anchor && focus &&
          (anchor === internal || internal.contains(anchor)) &&
          (focus === internal || internal.contains(focus)),
        ),
        selectionAnchor:summary(anchor),
        selectionFocus:summary(focus),
        pagesRotation:window.PDFViewerApplication?.pdfViewer?.pagesRotation ?? null,
        freeTextEditors:[...document.querySelectorAll(
          ".annotationEditorLayer .freeTextEditor",
        )].map(candidate => {
          const candidateInternal = candidate.querySelector(".internal");
          return {
            id:candidate.id,
            className:candidate.className,
            text:candidateInternal?.innerText ?? "",
            active:document.activeElement === candidateInternal,
            contentEditable:Boolean(candidateInternal?.isContentEditable),
            caretOffset:selectionOffsetFor(candidateInternal),
          };
        }),
      };
    });
    assert.equal(focusBeforeTyping.contentEditable, "true");
    assert.equal(focusBeforeTyping.active, true);
    assert.equal(focusBeforeTyping.connected, true);
    assert.equal(focusBeforeTyping.selected, true);
    assert.equal(focusBeforeTyping.frameHasFocus, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.topHasFocus, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.topOwnsFrameFocus, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.selectionCollapsed, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.selectionWithinInternal, true, JSON.stringify(focusBeforeTyping));
    assert.ok(
      focusBeforeTyping.internalRect?.height > 0 &&
        focusBeforeTyping.editorRect?.width > 0 && focusBeforeTyping.editorRect?.height > 0,
      `The selected FreeText editor must have stable positive geometry before typing: ${JSON.stringify(focusBeforeTyping)}`,
    );
    await viewer.evaluate((snapshot) => {
      window.__mouseTestMilestones.focusBeforeTyping = snapshot;
      window.__mouseTestMilestones.keyboardEventsBeforeTyping =
        window.__keyboardFocusEvents.length;
      window.__keyboardFocusEvents.length = 0;
    }, focusBeforeTyping);
    // This is a test-only call into PDF.js's real layer method (not a trusted
    // input event) to hold its accessibility reorder at the exact point that
    // previously blurred the contenteditable between trusted keystrokes.
    // The composition lifecycle below is an explicitly synthetic state probe;
    // it does not simulate an IME device or claim iPad hardware coverage.
    const deferredMoveProbe = await viewer.evaluate(async () => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(0);
      const accessibilityManager = pageView?._accessibilityManager;
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editorElement = internal?.closest(".freeTextEditor");
      const editorLayer = app?.pdfViewer?._layerProperties
        ?.annotationEditorUIManager?.currentLayer;
      const editor = editorElement && editorLayer?.getEditorByUID?.(editorElement.id);
      if (!internal || !editor || !accessibilityManager ||
        typeof editor.parent?.moveEditorInDOM !== "function") {
        throw new Error("The focused FreeText editor is missing its PDF.js accessibility move path");
      }
      const originalAddPointer = accessibilityManager.addPointerInTextLayer;
      if (typeof originalAddPointer !== "function") {
        throw new Error("The PDF.js text accessibility association method is unavailable");
      }
      window.__mouseAccessibilityAssociationCalls = 0;
      const instrumentedAddPointer = function (...args) {
        window.__mouseAccessibilityAssociationCalls += 1;
        return originalAddPointer.apply(this, args);
      };
      accessibilityManager.addPointerInTextLayer = instrumentedAddPointer;
      try {
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        const focusNode = selection?.focusNode;
        const anchorOffset = selection?.anchorOffset;
        const focusOffset = selection?.focusOffset;
        const previousSibling = editor.div.previousSibling;
        const nextSibling = editor.div.nextSibling;
        const start = new CompositionEvent("compositionstart", { bubbles:true });
        const startTrusted = start.isTrusted;
        internal.dispatchEvent(start);
        const originalSetTimeout = window.setTimeout;
        let zeroDelayTimersAfterMove = 0;
        window.setTimeout = function (callback, delay, ...rest) {
          if (Number(delay) === 0) zeroDelayTimersAfterMove += 1;
          return originalSetTimeout.call(this, callback, delay, ...rest);
        };
        try {
          editor.parent.moveEditorInDOM(editor);
        } finally {
          window.setTimeout = originalSetTimeout;
        }
        const immediatelyAfterMove = {
          active:document.activeElement === internal,
          connected:internal.isConnected,
          editable:internal.isContentEditable,
          sameAnchor:selection?.anchorNode === anchorNode,
          sameFocus:selection?.focusNode === focusNode,
          sameOffsets:selection?.anchorOffset === anchorOffset &&
            selection?.focusOffset === focusOffset,
          sameDOMPosition:editor.div.previousSibling === previousSibling &&
            editor.div.nextSibling === nextSibling,
          accessibilityAssociations:window.__mouseAccessibilityAssociationCalls,
          zeroDelayTimersAfterMove,
        };
        const end = new CompositionEvent("compositionend", { bubbles:true });
        const endTrusted = end.isTrusted;
        internal.dispatchEvent(end);
        await new Promise((resolve) => setTimeout(resolve, 40));
        const afterCompositionEndWhileStillEditing = {
          active:document.activeElement === internal,
          connected:internal.isConnected,
          editable:internal.isContentEditable,
          sameAnchor:selection?.anchorNode === anchorNode,
          sameFocus:selection?.focusNode === focusNode,
          sameOffsets:selection?.anchorOffset === anchorOffset &&
            selection?.focusOffset === focusOffset,
          sameDOMPosition:editor.div.previousSibling === previousSibling &&
            editor.div.nextSibling === nextSibling,
          accessibilityAssociations:window.__mouseAccessibilityAssociationCalls,
        };
        return {
          startTrusted,
          endTrusted,
          parentLayerMatchesCurrent:editor.parent === editorLayer,
          immediatelyAfterMove,
          afterCompositionEndWhileStillEditing,
        };
      } finally {
        if (accessibilityManager.addPointerInTextLayer === instrumentedAddPointer) {
          accessibilityManager.addPointerInTextLayer = originalAddPointer;
        }
      }
    });
    await viewer.evaluate((probe) => {
      window.__mouseTestMilestones.deferredMoveProbe = probe;
    }, deferredMoveProbe);
    assert.equal(deferredMoveProbe.startTrusted, false);
    assert.equal(deferredMoveProbe.endTrusted, false);
    assert.equal(deferredMoveProbe.parentLayerMatchesCurrent, true);
    for (const state of [
      deferredMoveProbe.immediatelyAfterMove,
      deferredMoveProbe.afterCompositionEndWhileStillEditing,
    ]) {
      assert.equal(state.active, true, JSON.stringify(deferredMoveProbe));
      assert.equal(state.connected, true, JSON.stringify(deferredMoveProbe));
      assert.equal(state.editable, true, JSON.stringify(deferredMoveProbe));
      assert.equal(state.sameAnchor, true, JSON.stringify(deferredMoveProbe));
      assert.equal(state.sameFocus, true, JSON.stringify(deferredMoveProbe));
      assert.equal(state.sameOffsets, true, JSON.stringify(deferredMoveProbe));
      assert.equal(state.sameDOMPosition, true, JSON.stringify(deferredMoveProbe));
    }
    assert.equal(
      deferredMoveProbe.immediatelyAfterMove.zeroDelayTimersAfterMove,
      0,
      "An active editor move must bypass PDF.js's obsolete focus-restoration timer while its DOM reorder is deferred",
    );
    assert.equal(
      deferredMoveProbe.immediatelyAfterMove.accessibilityAssociations,
      1,
      JSON.stringify(deferredMoveProbe),
    );
    assert.equal(
      deferredMoveProbe.afterCompositionEndWhileStillEditing.accessibilityAssociations,
      1,
      "Ending composition while the same editor remains focused must not flush its DOM reorder",
    );
    await page.keyboard.type("Mouse toolbar round trip");
    const typingEvents = await viewer.evaluate(() => window.__keyboardFocusEvents.slice());
    if (process.env.PDF_MOUSE_MOVE_TRACE === "1") {
      const moveTrace = await viewer.evaluate(() => ({
        calls:window.__pdfEditorMoveCalls?.slice(-32) || [],
        events:window.__pdfEditorMoveEvents?.slice(-32) || [],
        focus:window.__keyboardFocusEvents
          .filter(event => event.type === "focusout" || event.type === "focusin")
          .slice(-24),
      }));
      console.log(`PDF.js FreeText move/focus trace: ${JSON.stringify(moveTrace)}`);
    }
    const wrongInputTargets = typingEvents.filter((event) =>
      ["keydown", "beforeinput", "input", "keyup"].includes(event.type) &&
      (!event.trusted || event.target?.id !== focusBeforeTyping.id ||
        event.active?.id !== focusBeforeTyping.id || !event.target?.editable ||
        !event.active?.editable),
    );
    assert.deepEqual(
      wrongInputTargets,
      [],
      `Trusted keyboard input must remain on the focused FreeText editor: ${JSON.stringify(typingEvents)}`,
    );
    await viewer.waitForFunction((expectedText) => {
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor .internal",
      );
      const text = internal?.textContent?.replace(/\u200b/g, "").trim();
      const selection = window.getSelection();
      if (text !== expectedText || !internal?.isContentEditable ||
        document.activeElement !== internal || !selection?.isCollapsed ||
        selection.rangeCount !== 1) return false;
      const caret = selection.getRangeAt(0);
      if (caret.startContainer !== internal && !internal.contains(caret.startContainer)) {
        return false;
      }
      const prefix = document.createRange();
      prefix.selectNodeContents(internal);
      prefix.setEnd(caret.startContainer, caret.startOffset);
      return prefix.toString().replace(/\u200b/g, "").length === expectedText.length;
    }, { timeout:8_000 }, "Mouse toolbar round trip");
    const typedFreeText = await viewer.evaluate(() => {
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor .internal",
      );
      const selection = window.getSelection();
      const caret = selection?.rangeCount === 1 ? selection.getRangeAt(0) : null;
      const text = internal?.textContent?.replace(/\u200b/g, "").trim() ?? null;
      let caretTextOffset = null;
      if (internal && caret &&
        (caret.startContainer === internal || internal.contains(caret.startContainer))) {
        const prefix = document.createRange();
        prefix.selectNodeContents(internal);
        prefix.setEnd(caret.startContainer, caret.startOffset);
        caretTextOffset = prefix.toString().replace(/\u200b/g, "").length;
      }
      return {
        text,
        active:document.activeElement === internal,
        contentEditable:Boolean(internal?.isContentEditable),
        caretCollapsed:Boolean(caret?.collapsed),
        caretAtEnd:Boolean(
          selection?.isCollapsed && caret?.collapsed &&
          text !== null && caretTextOffset === text.length
        ),
        caretTextOffset,
      };
    });
    assert.equal(typedFreeText.text, "Mouse toolbar round trip", JSON.stringify(typedFreeText));
    assert.equal(typedFreeText.active, true, JSON.stringify(typedFreeText));
    assert.equal(typedFreeText.contentEditable, true, JSON.stringify(typedFreeText));
    assert.equal(typedFreeText.caretAtEnd, true, JSON.stringify(typedFreeText));
    const savesBeforeText = await page.evaluate(() => window.__host.saves.length);
    await openActionMenu();
    await viewer.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const afterRealEditorBlur = await viewer.evaluate(() => ({
      activeIsBridgeActionButton:
        document.activeElement === document.querySelector(
          '.pdfReaderBridgeControlButton[aria-label="撤销、重做、删除和保存"]',
        ),
      editorStillActive:Boolean(document.activeElement?.closest?.(
        ".freeTextEditor .internal[contenteditable='true']",
      )),
    }));
    assert.equal(afterRealEditorBlur.activeIsBridgeActionButton, true, JSON.stringify(afterRealEditorBlur));
    assert.equal(afterRealEditorBlur.editorStillActive, false, JSON.stringify(afterRealEditorBlur));
    await click('.pdfReaderBridgeActionMenu [data-action="save"]');
    // Save commits the focused FreeText before the bridge returns serialized
    // bytes. Reopen those bytes so the following probe exercises PDF.js's
    // trusted double-click edit path for an existing FreeText annotation.
    await page.waitForFunction(
      (count) => window.__host.saves.length > count,
      { timeout:20_000 },
      savesBeforeText,
    );
    const opensBeforeTextReopen = await page.evaluate(() => window.__host.opened);
    await page.evaluate(() => window.__host.reopenSaved());
    await page.waitForFunction(
      (count) => window.__host.opened === count + 1,
      { timeout:20_000 },
      opensBeforeTextReopen,
    );
    await viewer.waitForSelector(
      '.page[data-page-number="1"] .textLayer span',
      { timeout:20_000 },
    );
    const savedFreeText = await viewer.evaluate(async () => {
      const page = await PDFViewerApplication.pdfDocument.getPage(1);
      const annotation = (await page.getAnnotations()).find(
        (entry) => entry.subtype === "FreeText",
      );
      return annotation ? { id:annotation.id } : null;
    });
    assert.ok(savedFreeText?.id, "The saved FreeText should reopen as a PDF annotation");
    const freeTextModeAfterReopen = await viewer.evaluate(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode,
    );
    if (freeTextModeAfterReopen === 3) {
      // Match the native annotation edit path: leave creation mode active only
      // after PDF.js receives a real double-click on the existing annotation.
      await click("#editorFreeTextButton");
    } else if (freeTextModeAfterReopen !== 0) {
      throw new Error(`Unexpected FreeText editor mode after reopen: ${freeTextModeAfterReopen}`);
    }
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
      { timeout:8_000 },
    );
    await viewer.waitForFunction(
      (annotationId) => {
        const app = PDFViewerApplication;
        const pageView = app.pdfViewer.getPageView(0);
        const page = document.querySelector('.page[data-page-number="1"]');
        const layer = page?.querySelector(".annotationLayer");
        const target = [...(layer?.querySelectorAll(".freeTextAnnotation") ?? [])].find(
          (element) => element.getAttribute("data-annotation-id") === annotationId,
        );
        return pageView?.renderingState === 3 && page?.dataset.loaded === "true" &&
          layer?.isConnected && target;
      },
      { timeout:30_000 },
      savedFreeText.id,
    );
    // Reopening restores the PDF's initial scroll position. Bring the exact
    // persisted annotation back into view with normal DOM scrolling before
    // checking that a real browser pointer can hit it.
    await viewer.evaluate((annotationId) => {
      const target = [...document.querySelectorAll(
        '.page[data-page-number="1"] .annotationLayer .freeTextAnnotation',
      )].find((element) => element.getAttribute("data-annotation-id") === annotationId);
      target?.scrollIntoView({ block:"center", inline:"center", behavior:"auto" });
    }, savedFreeText.id);
    const reopenedAnnotationPoint = await viewer.waitForFunction(
      (annotationId) => {
        const target = [...document.querySelectorAll(
          ".page[data-page-number='1'] .annotationLayer .freeTextAnnotation",
        )].find((element) => element.getAttribute("data-annotation-id") === annotationId);
        if (!target) return false;
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const viewerRect = document.getElementById("viewerContainer")?.getBoundingClientRect();
        const hit = document.elementFromPoint(x, y);
        if (!(rect.width > 0 && rect.height > 0 && viewerRect &&
          x >= Math.max(0, viewerRect.left) && x < Math.min(window.innerWidth, viewerRect.right) &&
          y >= Math.max(0, viewerRect.top) && y < Math.min(window.innerHeight, viewerRect.bottom) &&
          hit?.closest(".freeTextAnnotation") === target)) {
          return false;
        }
        return {
          x,
          y,
          width:window.innerWidth,
          height:window.innerHeight,
          viewer:{ left:viewerRect.left, top:viewerRect.top, right:viewerRect.right, bottom:viewerRect.bottom },
        };
      },
      { timeout:30_000 },
      savedFreeText.id,
    );
    const reopenedPoint = await reopenedAnnotationPoint.jsonValue();
    assert.ok(
      reopenedPoint.x >= 0 && reopenedPoint.x < reopenedPoint.width &&
        reopenedPoint.y >= 0 && reopenedPoint.y < reopenedPoint.height,
      `The saved FreeText hit should be inside the visible iframe viewport: ${JSON.stringify(reopenedPoint)}`,
    );
    const textFrameOffset = await iframeOffset();
    const reopenedTextPoint = {
      x:textFrameOffset.x + reopenedPoint.x,
      y:textFrameOffset.y + reopenedPoint.y,
    };
    const outerTextHit = await page.evaluate(({ x, y }) => {
      const frame = document.querySelector("iframe");
      const rect = frame.getBoundingClientRect();
      const hit = document.elementFromPoint(x, y);
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      return {
        x,
        y,
        frame:{ left:rect.left, top:rect.top, right:rect.right, bottom:rect.bottom },
        viewport:{ width:window.innerWidth, height:window.innerHeight },
        insideVisibleFrame:x >= left && x < right && y >= top && y < bottom,
        tag:hit?.tagName || null,
        isFrame:hit === frame,
      };
    }, reopenedTextPoint);
    assert.ok(
      outerTextHit.isFrame && outerTextHit.insideVisibleFrame,
      `The saved FreeText double-click should remain inside the visible PDF iframe: ${JSON.stringify(outerTextHit)}`,
    );
    await page.mouse.click(reopenedTextPoint.x, reopenedTextPoint.y, {
      clickCount:2,
      delay:80,
    });
    await viewer.waitForFunction((annotationId) => {
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editor = internal?.closest(".freeTextEditor.selectedEditor");
      return PDFViewerApplication.pdfViewer.annotationEditorMode === 3 &&
        internal?.isContentEditable && document.activeElement === internal &&
        editor?.classList.contains("explicitlyEditing") &&
        editor.getAttribute("annotation-id") === annotationId &&
        (() => {
          const rect = internal.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit?.closest("[contenteditable]:not([contenteditable=false])") === internal;
        })();
    }, { timeout:10_000 }, savedFreeText.id);
    const localTextPoint = await viewer.evaluate(() => {
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const rect = internal?.getBoundingClientRect();
      if (!internal?.isContentEditable || document.activeElement !== internal ||
        !rect || rect.width <= 0 || rect.height <= 0) {
        throw new Error("The reopened FreeText contenteditable lost its trusted double-click focus");
      }
      return {
        x:rect.left + rect.width / 2,
        y:rect.top + rect.height / 2,
        width:window.innerWidth,
        height:window.innerHeight,
      };
    });
    assert.ok(
      localTextPoint.x >= 0 && localTextPoint.x < localTextPoint.width &&
        localTextPoint.y >= 0 && localTextPoint.y < localTextPoint.height,
      `The right-click point must be inside the visible iframe viewport: ${JSON.stringify(localTextPoint)}`,
    );
    const activeTextPoint = await iframeOffset().then((offset) => ({
      x:offset.x + localTextPoint.x,
      y:offset.y + localTextPoint.y,
    }));
    const activeTextHit = await viewer.evaluate(({ x, y }) => {
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const hit = document.elementFromPoint(x, y);
      const target = hit instanceof Element ? hit : hit?.parentElement;
      return {
        contentEditable:!!internal?.isContentEditable,
        active:document.activeElement === internal,
        inFreeText:!!target?.closest(".freeTextEditor"),
        inContenteditable:!!target?.closest("[contenteditable]:not([contenteditable=false])"),
        targetTag:target?.tagName || "",
        hitClass:typeof hit?.className === "string" ? hit.className : "",
      };
    }, localTextPoint);
    assert.ok(
      activeTextHit.inFreeText,
      `The right-click point should hit the active FreeText editor: ${JSON.stringify(activeTextHit)}`,
    );
    assert.ok(
      activeTextHit.contentEditable && activeTextHit.inContenteditable,
      `The right-click point should hit the active contenteditable area: ${JSON.stringify(activeTextHit)}`,
    );
    // PDF.js intentionally suppresses native context menus for 500 ms after
    // an activated right-drag eraser stroke. Let that gesture boundary expire
    // so this probe tests a plain right-click on the reopened, explicitly
    // editing contenteditable.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const contextMenuCountBefore = await viewer.evaluate(
      () => window.__contextMenuEvents.length,
    );
    const mouseEventCountBefore = await viewer.evaluate(
      () => window.__trustedMouseEvents.length,
    );
    await page.mouse.move(activeTextPoint.x, activeTextPoint.y);
    await page.mouse.down({ button:"right" });
    await page.mouse.up({ button:"right" });
    const rightPointerDown = await viewer.waitForFunction(
      (count) => window.__trustedMouseEvents.slice(count).find(
        (event) => event.type === "pointerdown" && event.button === 2 && event.trusted,
      ),
      { timeout:5_000 },
      mouseEventCountBefore,
    );
    const rightPointerSample = await rightPointerDown.jsonValue();
    assert.equal(
      rightPointerSample.editable,
      true,
      `The trusted right pointerdown must target the contenteditable hit area: ${JSON.stringify(rightPointerSample)}`,
    );
    await viewer.waitForFunction(
      (count) => window.__contextMenuEvents.length > count,
      { timeout:5_000 },
      contextMenuCountBefore,
    );
    const nativeContextMenu = await viewer.evaluate(
      () => window.__contextMenuEvents.at(-1),
    );
    assert.equal(nativeContextMenu.trusted, true);
    assert.equal(nativeContextMenu.editable, true, JSON.stringify(nativeContextMenu));
    assert.equal(
      nativeContextMenu.defaultPrevented,
      false,
      "The bridge should leave the browser's native right-click menu available in an active contenteditable editor",
    );
    const savesAfterTextRightClick = await page.evaluate(() => window.__host.saves.length);
    await clickAction("save");
    await page.waitForFunction(
      (count) => window.__host.saves.length > count,
      { timeout: 20_000 },
      savesAfterTextRightClick,
    );

    // Final host diagnostics prove real pointer types/buttons were captured in
    // a bounded, content-free ring. The only synthetic sample above is marked
    // untrusted and its cancellation-only scope is explicit.
    await page.evaluate(() => {
      const frame = document.querySelector("iframe");
      frame.contentWindow.postMessage({
        channel:"pdf-web-reader",
        type:"get-input-diagnostics",
        token:"mouse-input-browser-regression",
        requestId:"mouse-input-diagnostics",
      }, "*");
    });
    await page.waitForFunction(
      () => window.__host.inputDiagnostics?.requestId === "mouse-input-diagnostics",
      { timeout: 5_000 },
    );
    const diagnostics = await page.evaluate(() => window.__host.inputDiagnostics);
    assert.equal(diagnostics.rendererGeneration, rendererGeneration);
    assert.ok(diagnostics.pointers.length <= 32);
    assert.equal(diagnostics.activePointers, 0);
    assert.ok(
      diagnostics.pointers.some(
        (event) => event.pointerType === "mouse" && event.button === 0 && event.trusted,
      ),
      "Pointer diagnostics should identify actual trusted mouse input",
    );
    assert.ok(
      diagnostics.pointers.some(
        (event) => event.pointerType === "mouse" && event.button === 2,
      ),
      "Pointer diagnostics should preserve the actual right-button number",
    );
    assert.ok(
      diagnostics.pointers.every((event) =>
        [
          "type",
          "pointerType",
          "button",
          "buttons",
          "activePointers",
          "editorMode",
          "trusted",
        ].every((key) => key in event),
      ),
    );
    assert.ok(
      diagnostics.pointers.every((event) =>
        !("x" in event) && !("y" in event) && !("text" in event) && !("documentPath" in event),
      ),
      "Pointer diagnostics must not include coordinates, PDF text, or paths",
    );

      assert.deepEqual(pageErrors, [], "The viewer should not throw during mouse input");
    } catch (error) {
      primaryError = error;
      try {
        const captureId = Date.now();
        let inputDiagnostics = null;
        if (page && viewer) {
          await page.evaluate(() => {
            const frame = document.querySelector("iframe");
            frame?.contentWindow?.postMessage({
              channel: "pdf-web-reader",
              type: "get-input-diagnostics",
              token: "mouse-input-browser-regression",
              requestId: "mouse-failure-diagnostics",
            }, "*");
          });
          await page.waitForFunction(
            () => window.__host?.inputDiagnostics?.requestId === "mouse-failure-diagnostics",
            { timeout: 1_500 },
          ).catch(() => {});
          inputDiagnostics = await viewer.evaluate(() => {
            const app = window.PDFViewerApplication;
            const editorLayer = document.querySelector(
              '.page[data-page-number="1"] .annotationEditorLayer',
            );
            const pageView = app?.pdfViewer?.getPageView(0);
            return {
              mode: app?.pdfViewer?.annotationEditorMode ?? null,
              layerConnected: !!editorLayer?.isConnected,
              layerBounds: editorLayer
                ? (() => {
                    const { x, y, width, height } = editorLayer.getBoundingClientRect();
                    return { x, y, width, height };
                  })()
                : null,
              layerPointerEvents: editorLayer
                ? getComputedStyle(editorLayer).pointerEvents
                : null,
              editorLayerCount: document.querySelectorAll(".annotationEditorLayer").length,
              editorChildren: [...(editorLayer?.children || [])].map((editor) => ({
                className: editor.className,
                id: editor.id,
              })),
              squareCount: window.__getSquareEditors?.().length ?? null,
              pageRenderingState: pageView?.renderingState ?? null,
              squareParamsHidden: document
                .getElementById("editorSquareParamsToolbar")
                ?.classList.contains("hidden") ?? null,
              pointerEvents: window.__trustedMouseEvents?.slice(-20) || [],
              keyboardFocusEvents:window.__keyboardFocusEvents?.slice(-80) || [],
              pdfEditorMoveCalls:window.__pdfEditorMoveCalls?.slice(-24) || [],
              pdfEditorMoveEvents:window.__pdfEditorMoveEvents?.slice(-24) || [],
              milestones:window.__mouseTestMilestones || {},
              viewerFocusState:(() => {
                const app = window.PDFViewerApplication;
                const activeSummary = element => {
                  const node = element instanceof Element ? element : null;
                  return {
                    tag:node?.tagName || "",
                    id:node?.id || "",
                    className:typeof node?.className === "string" ? node.className : "",
                    editable:!!node?.closest?.("[contenteditable='true']"),
                  };
                };
                const selection = window.getSelection();
                const activeFreeTextId = document.activeElement?.id || null;
                return {
                  pagesRotation:app?.pdfViewer?.pagesRotation ?? null,
                  pageNumber:app?.pdfViewer?.currentPageNumber ?? null,
                  scale:app?.pdfViewer?.currentScale ?? null,
                  frameHasFocus:document.hasFocus(),
                  frameActive:activeSummary(document.activeElement),
                  topHasFocus:window.top.document.hasFocus(),
                  topActive:activeSummary(window.top.document.activeElement),
                  selection:selection?.rangeCount ? {
                    collapsed:selection.isCollapsed,
                    anchorNodeId:selection.anchorNode?.parentElement?.id || selection.anchorNode?.id || "",
                    anchorOffset:selection.anchorOffset,
                    focusNodeId:selection.focusNode?.parentElement?.id || selection.focusNode?.id || "",
                    focusOffset:selection.focusOffset,
                  } : null,
                  freeTextEditors:[...document.querySelectorAll(
                    ".annotationEditorLayer .freeTextEditor",
                  )].map(editor => {
                    const internal = editor.querySelector(".internal");
                    const rect = internal?.getBoundingClientRect();
                    const end = internal ? document.createRange() : null;
                    if (end && internal) {
                      end.selectNodeContents(internal);
                      end.collapse(false);
                    }
                    const range = selection?.rangeCount === 1
                      ? selection.getRangeAt(0)
                      : null;
                    let caretOffset = null;
                    if (internal && range &&
                      (range.startContainer === internal || internal.contains(range.startContainer))) {
                      const prefix = document.createRange();
                      prefix.selectNodeContents(internal);
                      prefix.setEnd(range.startContainer, range.startOffset);
                      caretOffset = prefix.toString().replace(/\u200b/g, "").length;
                    }
                    return {
                      id:editor.id,
                      className:editor.className,
                      text:internal?.innerText ?? "",
                      active:document.activeElement === internal,
                      focusedIdMatches:activeFreeTextId === internal?.id,
                      contentEditable:!!internal?.isContentEditable,
                      internalBounds:rect
                        ? { x:rect.x, y:rect.y, width:rect.width, height:rect.height }
                        : null,
                      caretCollapsed:!!range?.collapsed,
                      caretOffset,
                    };
                  }),
                };
              })(),
            };
          });
        }
        const bridgeDiagnostics = await page?.evaluate(
          () => window.__host?.inputDiagnostics || null,
        );
        const screenshotPath = `/tmp/pdf-reader-mouse-failure-${captureId}.png`;
        await page?.screenshot({ path: screenshotPath, fullPage: false });
        const diagnosticPath = `/tmp/pdf-reader-mouse-failure-${captureId}.json`;
        await writeFile(diagnosticPath, JSON.stringify({
          error: { name: error?.name, message: error?.message, stack: error?.stack },
          inputDiagnostics,
          bridgeDiagnostics,
          screenshotPath,
        }, null, 2));
        console.error(`Mouse regression failure evidence: ${diagnosticPath}`);
      } catch (captureError) {
        console.error("Could not capture mouse failure evidence:", captureError);
      }
    } finally {
      cleanupReport = await cleanupBrowserTestResources({ browser, server });
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) {
      throw finalError;
    }
  },
);
