import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
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
  observeBrowserTestChildStderr,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const browserPath = resolveBrowserPath();
const artifactsPath = resolveTestArtifactRoot(root);
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgePath = process.env.PDF_MOUSE_BRIDGE_SOURCE
  ? path.resolve(process.env.PDF_MOUSE_BRIDGE_SOURCE)
  : path.join(root, "viewer-adapter", "obsidian-bridge.js");
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
      readBridgeRuntimeSource(bridgePath),
      readFile(bridgeCssPath, "utf8"),
      readFile(viewerHtmlPath, "utf8"),
    ]);
    const bridgeProbeMarker = "  if (iosInputPolicy) {";
    assert.ok(bridgeSource.includes(bridgeProbeMarker),
      "The test-only bridge probe insertion point must remain explicit");
    const instrumentedBridgeSource = bridgeSource.replace(
      bridgeProbeMarker,
      `  window.__mouseBridgeState = state;\n${bridgeProbeMarker}`,
    );
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
          ${browserSidecarHarnessScript({ channel, token })}
          <script>
            const channel = ${JSON.stringify(channel)};
            const token = ${JSON.stringify(token)};
            const documentId = ${JSON.stringify(documentId)};
            const rendererGeneration = ${JSON.stringify(rendererGeneration)};
            const iframe = document.querySelector('iframe');
            const host = window.__host = { opened:0, openRequest:0, saves:[], errors:[], inputDiagnostics:null, rendererLifecycle:[] };
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
                const operations = Array.isArray(message.operations) ? message.operations : [];
                host.saves.push({
                  documentId:message.documentId,
                  openRequest:message.openRequest,
                  requestId:message.requestId,
                  revision:message.revision,
                  operationCount:operations.length,
                  operationUuids:operations.map(operation => operation.uuid),
                  sourceHash:host.initialHash,
                });
                iframe.contentWindow.postMessage({
                  channel, type:'saved', token,
                  documentId:message.documentId,
                  openRequest:message.openRequest,
                  requestId:message.requestId,
                  revision:message.revision,
                  external:true,
                  operationCount:operations.length,
                  ...(operations.length ? { batchId:'mouse-test-batch-' + host.saves.length } : {}),
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
              if (!host.saves.length) throw new Error('No durable sidecar save is available');
              host.fixturePromise.then(bytes => sendOpen(bytes.slice(0)));
            };
          </script>`);
        return;
      }
      if (url.pathname === "/viewer-adapter/obsidian-bridge.js") {
        response.writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
        });
        response.end(instrumentedBridgeSource);
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
    let browserStderrObserver;
    const artifactId = `${Date.now()}-${process.pid}`;
    try {

    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "mouse-input-regression", artifactsDir: artifactsPath });
    browserStderrObserver = observeBrowserTestChildStderr(browser.process?.());
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
      window.__mouseAnnotationModeEvents = [];
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
            const previousStackTraceLimit = Error.stackTraceLimit;
            Error.stackTraceLimit = 40;
            try {
              sample.stack = (new Error().stack?.split("\n").slice(1, 41) || []).filter(
                (line, index) => index < 2 ||
                  /pdf\.mjs|viewer\.mjs|obsidian-bridge\.js/.test(line),
              );
            } finally {
              Error.stackTraceLimit = previousStackTraceLimit;
            }
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
      window.__getSidecarFreeTextEditor = (uuid) => {
        const app = window.PDFViewerApplication;
        const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const storage = app?.pdfDocument?.annotationStorage;
        return manager?.getEditors?.(0)?.find((editor) =>
          window.__mouseBridgeState?.annotationUuidByRuntimeId?.get(String(editor.id)) === uuid &&
          storage?.getRawValue(editor.id)?.constructor?._editorType === 3,
        )?.div || null;
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
      window.PDFViewerApplication?.eventBus?.on?.(
        "annotationeditormodechanged",
        ({ mode, source, isFromKeyboard, isTemporary }) => {
          const time = Math.round(performance.now());
          const pending = window.__mousePendingAnnotationMode;
          if (pending?.requestedMode === mode) {
            pending.completed = true;
            pending.completedAt = time;
            pending.getterModeAtCompletion =
              window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null;
          }
          window.__mouseAnnotationModeEvents.push({
            time,
            mode,
            source:source?.constructor?.name || null,
            isFromKeyboard:Boolean(isFromKeyboard),
            isTemporary:Boolean(isTemporary),
            pendingRequestId:pending?.requestedMode === mode ? pending.id : null,
          });
          if (window.__mouseAnnotationModeEvents.length > 64) {
            window.__mouseAnnotationModeEvents.shift();
          }
        },
      );
      window.__installPdfEditorMoveTrace = () => {
        const pageView = window.PDFViewerApplication?.pdfViewer?.getPageView(0);
        const editorLayer = pageView?.annotationEditorLayer?.annotationEditorLayer;
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
      window.__mouseFreeTextTapProbe = [];
      window.addEventListener("pointerdown", event => {
        const target = event.target instanceof Element ? event.target : null;
        const editorElement = target?.closest(".freeTextEditor");
        const record = {
          time:Math.round(event.timeStamp),
          trusted:event.isTrusted,
          pointerType:event.pointerType,
          button:event.button,
          x:event.clientX,
          y:event.clientY,
          targetClass:typeof target?.className === "string" ? target.className : "",
          editorId:editorElement?.id ?? null,
          editorClass:editorElement?.className ?? null,
          editorUuid:editorElement
            ? window.__mouseBridgeState?.annotationUuidByRuntimeId?.get(editorElement.id) ?? null
            : null,
          pendingBefore:window.__mouseBridgeState?.pendingSidecarFreeTextClick ?? null,
        };
        queueMicrotask(() => {
          record.pendingAfter = window.__mouseBridgeState?.pendingSidecarFreeTextClick ?? null;
          record.modeAfter = window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null;
          window.__mouseFreeTextTapProbe.push(record);
          if (window.__mouseFreeTextTapProbe.length > 24) window.__mouseFreeTextTapProbe.shift();
        });
      }, true);
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
    const openSecondaryToolbar = async () => {
      const isOpen = await viewer.evaluate(() =>
        !document.getElementById("secondaryToolbar")?.classList.contains("hidden"),
      );
      if (isOpen) return;
      await click("#secondaryToolbarToggleButton");
      await viewer.waitForFunction(
        () => !document.getElementById("secondaryToolbar")?.classList.contains("hidden"),
      );
    };
    const clickAction = async (action) => {
      const selectors = {
        undo: "#pdfReaderBridgeUndoButton",
        redo: "#pdfReaderBridgeRedoButton",
        delete: "#pdfReaderBridgeDeleteButton",
        save: "#secondaryDownload",
      };
      const selector = selectors[action];
      if (!selector) throw new Error(`Unsupported toolbar action: ${action}`);
      if (action === "delete" || action === "save") {
        await openSecondaryToolbar();
      }
      await click(selector);
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
      let state = await viewer.evaluate(() => ({
        currentMode:PDFViewerApplication.pdfViewer.annotationEditorMode,
        pending:window.__mousePendingAnnotationMode || null,
      }));
      if (state.pending && !state.pending.completed) {
        await waitForAnnotationModeChange(
          state.pending.requestedMode,
          state.pending,
          8_000,
        );
        state = await viewer.evaluate(() => ({
          currentMode:PDFViewerApplication.pdfViewer.annotationEditorMode,
          pending:window.__mousePendingAnnotationMode || null,
        }));
      }
      if (state.currentMode === mode) return;
      const currentMode = state.currentMode;
      if (![0, 5].includes(currentMode) || ![0, 5].includes(mode)) {
        throw new Error(`Unexpected annotation editor mode transition ${currentMode} → ${mode}`);
      }
      const request = await beginAnnotationModeChange(mode);
      await click("#editorSquareButton");
      await noteAnnotationModeClickReturned(request.id);
      await waitForAnnotationModeChange(mode, request, 8_000);
    };
    const beginAnnotationModeChange = async (mode) => viewer.evaluate((requestedMode) => {
      const request = {
        id:(window.__mouseAnnotationModeRequestId || 0) + 1,
        requestedMode,
        startedAt:Math.round(performance.now()),
        startMode:window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
        eventCount:window.__mouseAnnotationModeEvents.length,
        completed:false,
      };
      window.__mouseAnnotationModeRequestId = request.id;
      window.__mousePendingAnnotationMode = request;
      return { ...request };
    }, mode);
    const noteAnnotationModeClickReturned = async (requestId) => viewer.evaluate((id) => {
      const request = window.__mousePendingAnnotationMode;
      if (request?.id !== id) return;
      request.clickReturnedAt = Math.round(performance.now());
      request.getterModeAtClickReturn =
        window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null;
      request.completedAtClickReturn = request.completed;
    }, requestId);
    const waitForAnnotationModeChange = async (mode, request, timeout = 8_000) => {
      await viewer.waitForFunction(
        ({ expectedMode, requestId, priorEventCount }) => {
          const pending = window.__mousePendingAnnotationMode;
          return PDFViewerApplication.pdfViewer.annotationEditorMode === expectedMode &&
            pending?.id === requestId && pending.completed === true &&
            window.__mouseAnnotationModeEvents
              .slice(priorEventCount)
              .some((event) => event.mode === expectedMode &&
                event.pendingRequestId === requestId);
        },
        { timeout },
        {
          expectedMode:mode,
          requestId:request.id,
          priorEventCount:request.eventCount,
        },
      );
    };
    const layerBounds = () =>
      viewer.evaluate(() => {
        const rect = document
          .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
          .getBoundingClientRect();
        return { x:rect.x, y:rect.y, width:rect.width, height:rect.height };
      });

    const assertCompactToolbarFits = async (width) => {
      await page.setViewport({ width, height:500 });
      await viewer.waitForFunction(
        (expectedWidth) => {
          const toolbarViewer = document.getElementById("toolbarViewer");
          const groups = [
            document.getElementById("toolbarViewerLeft"),
            document.getElementById("toolbarViewerMiddle"),
            document.getElementById("editorModeButtons"),
            document.querySelector(".pdfReaderBridgeControls"),
            document.getElementById("secondaryToolbarToggle"),
          ];
          const requiredWidth = groups.reduce((sum, element) =>
            sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width),
          20);
          return window.innerWidth === expectedWidth &&
            document.querySelectorAll(".pdfReaderBridgeControls .pdfReaderBridgeControlButton").length === 2 &&
            document.documentElement.classList.contains("pdfReaderBridgeTwoRow") ===
              (requiredWidth > toolbarViewer.clientWidth + 1);
        },
        { timeout:5_000 },
        width,
      );
      const layout = await viewer.evaluate(() => {
        const toolbar = document.getElementById("toolbarContainer");
        const toolbarViewer = document.getElementById("toolbarViewer");
        const right = document.getElementById("toolbarViewerRight");
        const containerRect = toolbar.getBoundingClientRect();
        const groupWidths = [
          document.getElementById("toolbarViewerLeft"),
          document.getElementById("toolbarViewerMiddle"),
          document.getElementById("editorModeButtons"),
          document.querySelector(".pdfReaderBridgeControls"),
          document.getElementById("secondaryToolbarToggle"),
        ];
        const requiredSingleRowWidth = groupWidths.reduce((sum, element) => {
          return sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width);
        }, 20);
        const mustReach = [
          ...document.querySelectorAll(".pdfReaderBridgeControls .pdfReaderBridgeControlButton"),
          ...[
            "editorUnderlineButton",
            "editorSquareButton",
            "editorHighlightButton",
            "editorInkButton",
            "editorFreeTextButton",
          ].map((id) => document.getElementById(id)),
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
            disabled:element.disabled === true,
            hitTarget:hit === element || element.contains(hit),
            whiteSpace:getComputedStyle(element).whiteSpace,
            scrollWidth:element.scrollWidth,
            clientWidth:element.clientWidth,
            hitTargetDescription:hit ? {
              tag:hit.tagName,
              id:hit.id || null,
              className:typeof hit.className === "string" ? hit.className : null,
              pointerEvents:getComputedStyle(hit).pointerEvents,
            } : null,
          };
        };
        const visibleRightButtons = [...right.querySelectorAll("button")]
          .filter((button) => button.getClientRects().length > 0)
          .map(box);
        return {
          viewportWidth:window.innerWidth,
          toolbar:{
            left:containerRect.left,
            right:containerRect.right,
            bottom:containerRect.bottom,
            height:containerRect.height,
            scrollWidth:toolbar.scrollWidth,
            clientWidth:toolbar.clientWidth,
            twoRows:document.documentElement.classList.contains("pdfReaderBridgeTwoRow"),
            requiredSingleRowWidth,
            availableSingleRowWidth:toolbarViewer.clientWidth,
          },
          right:{ left:right.getBoundingClientRect().left, right:right.getBoundingClientRect().right, scrollWidth:right.scrollWidth, clientWidth:right.clientWidth },
          controls:mustReach.map(box),
          visibleRightButtons,
        };
      });
      const withinToolbar = (button) => button && button.width > 0 && button.height > 0 &&
        button.left >= layout.toolbar.left && button.right <= layout.toolbar.right + 1 &&
        button.top >= 0 && button.bottom <= 64 && (button.hitTarget || button.disabled);
      assert.ok(
        layout.right.left >= layout.toolbar.left && layout.right.right <= layout.toolbar.right + 1 &&
          layout.right.scrollWidth <= layout.right.clientWidth + 1 &&
          layout.visibleRightButtons.every(withinToolbar) &&
          layout.controls.every(withinToolbar),
        `All visible toolbar and bridge controls should remain clickable inside a ${width}px pane: ${JSON.stringify(layout)}`,
      );
      const expectedTwoRows =
        layout.toolbar.requiredSingleRowWidth > layout.toolbar.availableSingleRowWidth + 1;
      assert.equal(layout.toolbar.twoRows, expectedTwoRows,
        `Responsive layout follows measured control widths at ${width}px`);
      assert.equal(layout.toolbar.height, expectedTwoRows ? 64 : 32,
        `Toolbar height matches its row count at ${width}px`);
      const historyControls = layout.controls.filter((button) =>
        button.label === "撤销" || button.label === "重做",
      );
      const nativeToolControls = layout.controls.filter((button) =>
        button.label.startsWith("editor"),
      );
      assert.deepEqual(historyControls.map((button) => [button.label, button.width, button.height]), [
        ["撤销", 32, 28],
        ["重做", 32, 28],
      ], `Direct history controls keep their compact hit boxes at ${width}px`);
      assert.equal(nativeToolControls.length, 5);
      assert.ok(
        nativeToolControls.every((button) => button.scrollWidth <= button.clientWidth + 1),
        `Native tool buttons should fit at ${width}px: ${JSON.stringify(nativeToolControls)}`,
      );
    };
    // Check panes around the previous breakpoint, including the screenshot
    // width, and verify the row count follows actual measured control widths.
    await assertCompactToolbarFits(881);
    await assertCompactToolbarFits(880);
    await assertCompactToolbarFits(800);
    await assertCompactToolbarFits(780);
    await assertCompactToolbarFits(720);
    await assertCompactToolbarFits(640);
    await assertCompactToolbarFits(432);
    await assertCompactToolbarFits(320);
    await assertCompactToolbarFits(600);
    await page.setViewport({ width:1400, height:1000 });
    const toolbarControls = await viewer.evaluate(() => ({
      nativeTools: [
        "editorUnderlineButton",
        "editorSquareButton",
        "editorHighlightButton",
        "editorInkButton",
        "editorFreeTextButton",
      ].filter((id) => document.getElementById(id)?.getClientRects().length > 0),
      bridgeControls: [...document.querySelectorAll(
        ".pdfReaderBridgeControls .pdfReaderBridgeControlButton",
      )].map((button) => button.textContent.trim()),
      floatingEditMenuPresent: !!document.querySelector(".pdfReaderBridgeActionMenu"),
      bridgeClickWheel: !!document.querySelector(".pdfReaderBridgeClickWheel"),
    }));
    assert.deepEqual(toolbarControls.nativeTools, [
      "editorUnderlineButton",
      "editorSquareButton",
      "editorHighlightButton",
      "editorInkButton",
      "editorFreeTextButton",
    ]);
    assert.deepEqual(toolbarControls.bridgeControls, ["↶", "↷"]);
    assert.equal(toolbarControls.floatingEditMenuPresent, false);
    assert.equal(toolbarControls.bridgeClickWheel, false);
    const initialSquareModeRequest = await beginAnnotationModeChange(5);
    await click("#editorSquareButton");
    await noteAnnotationModeClickReturned(initialSquareModeRequest.id);
    await waitForAnnotationModeChange(5, initialSquareModeRequest);
    assert.ok(
      await viewer.evaluate(() =>
        !document.getElementById("editorSquareParamsToolbar").classList.contains("hidden"),
      ),
      "Selecting Square from PDF.js's native tool bar should expose its parameter controls",
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
      () => !document.getElementById("pdfReaderBridgeUndoButton")?.disabled,
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
    assert.ok(squareSave.operationCount > 0, "The save control must durably publish sidecar operations");
    assert.equal(squareSave.operationUuids.length, 1,
      "The mouse-created Square must be represented by one durable sidecar UUID");
    const squareUid = squareSave.operationUuids[0];
    assert.equal(squareSave.sourceHash, squareSave.initialHash,
      "An ordinary annotation save must keep the immutable source PDF unchanged");
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
    await viewer.waitForFunction(() => window.__getSquareEditors().length === 1, {
      timeout:20_000,
    });
    const reopenedSquareState = await viewer.evaluate(() => {
      const editor = window.__getSquareEditors()[0];
      const raw = PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(editor.id);
      const rect = editor.getBoundingClientRect();
      return {
        runtimeId:editor.id,
        editorType:raw?.constructor?._editorType ?? null,
        width:rect.width,
        height:rect.height,
      };
    });
    assert.equal(reopenedSquareState.editorType, 5);
    assert.ok(reopenedSquareState.width > 0 && reopenedSquareState.height > 0,
      `The sidecar Square must hydrate with positive geometry: ${JSON.stringify(reopenedSquareState)}`);
    assert.equal(await page.evaluate(() =>
      window.__browserSidecarHost.operationsFor("mouse-regression-document")
        .filter((operation) => operation.deleted !== true).length,
    ), 1, "Reopening the immutable PDF must hydrate the one durable Square sidecar row");

    // A trusted click selects the reopened sidecar editor in NONE mode. Then
    // PDF.js's explicit editId route enters edit mode without relying on the
    // obsolete native-PDF-annotation double-click path.
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
        runtimeId:editor.id,
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
    };
    const offset = await iframeOffset();
    await page.mouse.click(offset.x + squareHit.x, offset.y + squareHit.y);
    await viewer.waitForFunction(
      (runtimeId) => {
        const editor = window.__getSquareEditors().find((candidate) => candidate.id === runtimeId);
        return editor && editor.classList.contains("selectedEditor") &&
          PDFViewerApplication.pdfViewer.annotationEditorMode === 5;
      },
      { timeout: 8_000 },
      reopenedSquareState.runtimeId,
    );
    await viewer.evaluate((editId) => {
      PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
        mode:5, editId, mustEnterInEditMode:true,
      });
    }, reopenedSquareState.runtimeId);
    await viewer.waitForFunction((runtimeId) => {
      const editor = document.querySelector(".annotationEditorLayer .explicitlyEditing");
      return editor?.id === runtimeId;
    }, { timeout:8_000 }, reopenedSquareState.runtimeId);

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
      () => !document.getElementById("pdfReaderBridgeUndoButton")?.disabled,
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
      () => !document.getElementById("pdfReaderBridgeDeleteButton")?.disabled,
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
    assert.ok(editedSquareSave.operationCount > 0,
      "Saving the moved/resized Square must publish its sidecar operation");
    assert.ok(editedSquareSave.operationUuids.includes(squareUid),
      "The moved/resized sidecar operation must retain the Square UUID");
    assert.equal(editedSquareSave.sourceHash, editedSquareSave.initialHash,
      "Moving or resizing an annotation must not rewrite the source PDF");
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
    await viewer.waitForFunction(() => window.__getSquareEditors().length === 1, {
      timeout:20_000,
    });
    assert.equal(await page.evaluate(() =>
      window.__browserSidecarHost.operationsFor("mouse-regression-document")
        .filter((operation) => operation.deleted !== true).length,
    ), 1, "A second source-PDF reopen must hydrate exactly one active Square sidecar row");
    await setSquareMode(5);
    await viewer.waitForFunction(
      () => window.__getSquareEditors().length === 1,
      { timeout: 12_000 },
    );

    // The second mouse press may be a pointermove, not a pointerdown.
    for (const chordMode of [5, 15]) {
      if (chordMode === 15) {
        await click("#editorInkButton");
        await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 15);
      }
      for (const first of ["left", "right"]) {
        const second = first === "left" ? "right" : "left";
        const beforeChord = await viewer.evaluate(() => {
          const app = PDFViewerApplication;
          const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
          return { rows:manager.getEditors(0).map(editor => editor.serialize()),
            mode:app.pdfViewer.annotationEditorMode,
            scroll:document.getElementById("viewerContainer").scrollTop };
        });
        const bounds = await squareBounds();
        const frameOffset = await iframeOffset();
        const x = frameOffset.x + bounds.x - 40;
        const y = frameOffset.y + bounds.y + bounds.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down({button:first});
        // Start a real left drawing; right stays below its eraser threshold.
        await page.mouse.move(x + (first === "left" ? 10 : 2), y);
        await page.mouse.down({button:second});
        assert.equal(await viewer.evaluate(() =>
          getComputedStyle(document.getElementById("viewerContainer")).cursor), "grabbing");
        await page.mouse.move(x + 65, y - 50, {steps:8});
        await page.mouse.up({button:first});
        await page.mouse.move(x + 70, y - 55);
        await page.mouse.up({button:second});
        const afterChord = await viewer.evaluate(async () => {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const app = PDFViewerApplication;
          const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
          return { rows:manager.getEditors(0).map(editor => editor.serialize()),
            mode:app.pdfViewer.annotationEditorMode,
            scroll:document.getElementById("viewerContainer").scrollTop,
            erasing:document.body.classList.contains("editorEraserMode"),
            grabbing:document.documentElement.classList.contains("pdf-reader-chord-pan") };
        });
        assert.deepEqual(afterChord.rows, beforeChord.rows, `${first}-first chord must not draw or erase`);
        assert.equal(afterChord.mode, beforeChord.mode);
        assert.equal(afterChord.erasing, false);
        assert.equal(afterChord.grabbing, false);
        assert.ok(afterChord.scroll > beforeChord.scroll, "Chord must actually pan the PDF");
        await viewer.evaluate(top => { document.getElementById("viewerContainer").scrollTop = top; }, beforeChord.scroll);
      }

    }
    await click("#editorSquareButton");
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 5);

    const priorMenuScale = await viewer.evaluate(() => PDFViewerApplication.pdfViewer.currentScaleValue);
    const menuBounds = await squareBounds();
    const menuOffset = await iframeOffset();
    await page.mouse.click(menuOffset.x + menuBounds.x - 50, menuOffset.y + menuBounds.y, {button:"right"});
    await viewer.waitForFunction(() => !document.querySelector(".pdfReaderPageContextMenu")?.hidden);
    assert.equal(await viewer.evaluate(() => [...document.querySelectorAll(".pdfReaderPageContextRow")].every(row => {
      const buttons = [...row.querySelectorAll("button")];
      return buttons.length >= 3 && buttons.every(button => button.getBoundingClientRect().top === buttons[0].getBoundingClientRect().top);
    })), true);
    assert.equal(await viewer.evaluate(() => [...document.querySelectorAll(".pdfReaderPageContextIcon")].every(button => getComputedStyle(button, "::before").maskImage !== "none")), true);
    await viewer.evaluate(() => [...document.querySelectorAll(".pdfReaderPageContextMenu button")].find(b => b.dataset.layoutAction === "page-width").click());
    assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.currentScaleValue), "page-width");
    assert.equal(await viewer.evaluate(() => document.querySelector(".pdfReaderPageContextMenu").hidden), true);

    await viewer.evaluate(scale => { PDFViewerApplication.pdfViewer.currentScaleValue = scale; }, priorMenuScale);
    await viewer.waitForFunction(() => window.__getSquareEditors().length === 1);

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

    // Releasing in the center X or outside the wheel closes it. A sector is
    // selected by releasing the held middle-button gesture on that sector.
    // Start in None mode so selecting Square is a real mode transition.
    await setSquareMode(0);
    const viewerCenter = await viewer.evaluate(() => {
      const rect = document.getElementById("viewerContainer").getBoundingClientRect();
      return { x:rect.left + rect.width * 0.72, y:rect.top + rect.height * 0.55 };
    });
    await page.mouse.move(offset.x + viewerCenter.x, offset.y + viewerCenter.y);
    await page.mouse.down({ button:"middle" });
    await viewer.waitForSelector(".pdfToolWheel");
    await page.mouse.up({ button:"middle" });
    await viewer.waitForFunction(
      () => !document.querySelector(".pdfToolWheel"),
      { timeout: 5_000 },
    );
    assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), 0,
      "Center X closes only the radial menu and leaves PDF.js in None mode.");
    await page.mouse.move(offset.x + viewerCenter.x, offset.y + viewerCenter.y);
    await page.mouse.down({ button:"middle" });
    await viewer.waitForSelector(".pdfToolWheel");
    await page.mouse.move(offset.x + viewerCenter.x + 70, offset.y + viewerCenter.y + 70);
    await page.mouse.up({ button:"middle" });
    await viewer.waitForFunction(
      () => !document.querySelector(".pdfToolWheel"),
      { timeout:5_000 },
    );
    assert.equal(await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), 0,
      "Releasing beyond the radial wheel closes it without changing the active tool.");

    await page.mouse.move(offset.x + viewerCenter.x, offset.y + viewerCenter.y);
    await page.mouse.down({ button:"middle" });
    await viewer.waitForSelector(".pdfToolWheel");
    const middleWheelModeRequest = await beginAnnotationModeChange(5);
    const squareSectorAngle = (4 * 60 - 90) * Math.PI / 180;
    await page.mouse.move(
      offset.x + viewerCenter.x + 80 * Math.cos(squareSectorAngle),
      offset.y + viewerCenter.y + 80 * Math.sin(squareSectorAngle),
    );
    await page.mouse.up({ button:"middle" });
    await noteAnnotationModeClickReturned(middleWheelModeRequest.id);
    await waitForAnnotationModeChange(5, middleWheelModeRequest, 5_000);

    // Wheel input on a native parameter input remains isolated from the
    // middle-button tool wheel and does not change the active PDF.js tool.
    await setSquareMode(0);
    await setSquareMode(5);
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
      await viewer.evaluate(() => Boolean(document.querySelector(".pdfToolWheel"))),
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
    await viewer.waitForSelector(".pdfToolWheel");
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
      () => !document.querySelector(".pdfToolWheel") &&
        window.__syntheticCancelProbe?.isTrusted === false,
      { timeout: 5_000 },
    );
    await page.mouse.up({ button:"middle" });

    // Ordinary wheel scroll moves the viewer without changing scale. Ctrl-wheel
    // at the document uses PDF.js zoom; both routes stay separate from PDF.js's
    // middle-button tool wheel.
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

    const pdfEditorLifecycleTraceState = await viewer.evaluate(() => {
      const app = window.PDFViewerApplication;
      const pdfViewer = app?.pdfViewer;
      const pageView = pdfViewer?.getPageView(0);
      const builder = pageView?.annotationEditorLayer;
      const pageLayer = builder?.annotationEditorLayer;
      const manager = pdfViewer?._layerProperties?.annotationEditorUIManager;
      if (!pageView || !builder || !pageLayer || !manager) {
        throw new Error("The page 1 annotation editor lifecycle is unavailable before FreeText creation");
      }

      const trace = window.__mousePdfEditorLifecycleTrace = [];
      const instrumentedEditors = new WeakSet();
      const tracedMethodsByTarget = new WeakMap();
      const restores = [];
      const traceContexts = new WeakMap();
      const objectIdentities = new WeakMap();
      let nextObjectIdentity = 1;
      const objectIdentity = (object) => {
        if (!object || (typeof object !== "object" && typeof object !== "function")) return null;
        let identity = objectIdentities.get(object);
        if (!identity) {
          identity = nextObjectIdentity++;
          objectIdentities.set(object, identity);
        }
        return identity;
      };
      window.__mouseObjectIdentity = objectIdentity;
      const initialTraceContext = { app, pdfViewer, pageView, builder, pageLayer, manager };
      traceContexts.set(pageView, initialTraceContext);
      traceContexts.set(builder, initialTraceContext);
      traceContexts.set(pageLayer, initialTraceContext);
      window.__mousePdfEditorLifecycleTraceEnabled = true;
      const viewportSummary = (viewport) => viewport ? {
        rotation:viewport.rotation ?? null,
        scale:viewport.scale ?? null,
        width:viewport.width ?? null,
        height:viewport.height ?? null,
        offsetX:viewport.offsetX ?? null,
        offsetY:viewport.offsetY ?? null,
        viewBox:viewport.viewBox ? Array.from(viewport.viewBox) : null,
        transform:viewport.transform ? Array.from(viewport.transform) : null,
      } : null;
      const boolMethod = (editor, method) => {
        try {
          return typeof editor?.[method] === "function"
            ? Boolean(editor[method]())
            : null;
        } catch {
          return null;
        }
      };
      const captureStack = () => {
        const previousLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 40;
        try {
          return (new Error().stack?.split("\n").slice(1, 41) || []).filter(
            (line, index) => index < 2 ||
              /pdf\.mjs|viewer\.mjs|obsidian-bridge\.js/.test(line),
          );
        } finally {
          Error.stackTraceLimit = previousLimit;
        }
      };
      const elementSummary = (element) => {
        if (!(element instanceof Element)) return null;
        const style = getComputedStyle(element);
        return {
          tag:element.tagName || "",
          id:element.id || "",
          className:typeof element.className === "string" ? element.className : "",
          hidden:Boolean(element.hidden),
          connected:Boolean(element.isConnected),
          display:style.display,
          visibility:style.visibility,
          opacity:style.opacity,
          pointerEvents:style.pointerEvents,
        };
      };
      const record = (method, receiver, args, contextOverride = null) => {
        if (!window.__mousePdfEditorLifecycleTraceEnabled) return;
        const context = contextOverride || traceContexts.get(receiver) || initialTraceContext;
        const {
          app:traceApp,
          pdfViewer:tracePdfViewer,
          pageView:tracePageView,
          builder:traceBuilder,
          pageLayer:tracePageLayer,
          manager:traceManager,
        } = context;
        const active = document.activeElement;
        const activeEditorElement = active instanceof Element
          ? active.closest(".freeTextEditor")
          : null;
        const activeEditor = activeEditorElement &&
          traceManager.getEditor?.(activeEditorElement.id);
        const targetEditor = receiver?.editorType
          ? receiver
          : args.find?.((argument) => argument?.editorType) || null;
        const targetElement = targetEditor?.div;
        const parameters = args[0];
        trace.push({
          time:Math.round(performance.now()),
          method,
          callArgs:method.startsWith("pageView.update")
            ? {
                scale:parameters?.scale ?? null,
                rotation:parameters?.rotation ?? null,
                drawingDelay:parameters?.drawingDelay ?? null,
              }
            : method.startsWith("pageView.reset")
              ? { options:parameters || {} }
              : method.startsWith("layer.pause")
                ? { paused:Boolean(parameters) }
              : null,
          documentIdentity:objectIdentity(traceApp.pdfDocument),
          pageViewIdentity:objectIdentity(tracePageView),
          builderIdentity:objectIdentity(traceBuilder),
          pageLayerIdentity:objectIdentity(tracePageLayer),
          receiverIdentity:objectIdentity(receiver),
          pageIndex:tracePageView.id - 1,
          builderPageIndex:traceBuilder.pageIndex,
          pageViewRenderingState:tracePageView.renderingState,
          pageLayerConnected:Boolean(tracePageLayer.div?.isConnected),
          pdfViewerScale:tracePdfViewer.currentScale ?? null,
          pdfViewerRotation:tracePdfViewer.pagesRotation ?? null,
          pageViewPresentation:viewportSummary(tracePageView.viewport),
          pageViewElement:elementSummary(tracePageView.div),
          builderElement:elementSummary(traceBuilder.div),
          editorLayerElement:elementSummary(tracePageLayer.div),
          documentVisibility:document.visibilityState,
          documentHasFocus:document.hasFocus(),
          managerCurrentPageIndex:traceManager.currentPageIndex ?? null,
          managerCurrentLayerPageIndex:traceManager.currentLayer?.pageIndex ?? null,
          managerCurrentLayerMatchesPage:Boolean(traceManager.currentLayer === tracePageLayer),
          activeElement:active ? {
            tag:active.tagName || "",
            id:active.id || "",
            className:typeof active.className === "string" ? active.className : "",
            editable:Boolean(active.isContentEditable),
          } : null,
          activeEditor:activeEditor ? {
            id:activeEditor.id,
            pageIndex:activeEditor.pageIndex,
            parentPageIndex:activeEditor.parent?.pageIndex ?? null,
            parentMatchesPageLayer:activeEditor.parent === tracePageLayer,
            attached:Boolean(activeEditor.isAttachedToDOM),
            selected:Boolean(activeEditor.div?.classList.contains("selectedEditor")),
            editing:boolMethod(activeEditor, "isInEditMode"),
            empty:boolMethod(activeEditor, "isEmpty"),
          } : null,
          pageEditors:Array.from(traceManager.getEditors?.(tracePageView.id - 1) || []).map(editor => ({
            id:editor.id,
            pageIndex:editor.pageIndex,
            parentPageIndex:editor.parent?.pageIndex ?? null,
            parentMatchesPageLayer:editor.parent === tracePageLayer,
            attached:Boolean(editor.isAttachedToDOM),
            selected:Boolean(editor.div?.classList.contains('selectedEditor')),
            editing:boolMethod(editor, 'isInEditMode'),
            empty:boolMethod(editor, 'isEmpty'),
            text:editor.div?.querySelector('.internal')?.textContent?.replace(/\u200b/g, '') ?? null,
          })),
          targetEditor:targetEditor ? {
            id:targetEditor.id,
            pageIndex:targetEditor.pageIndex,
            parentPageIndex:targetEditor.parent?.pageIndex ?? null,
            parentMatchesPageLayer:targetEditor.parent === tracePageLayer,
            attached:Boolean(targetEditor.isAttachedToDOM),
            selected:Boolean(targetElement?.classList.contains("selectedEditor")),
            editing:boolMethod(targetEditor, "isInEditMode"),
            empty:boolMethod(targetEditor, "isEmpty"),
          } : null,
          layerViewport:viewportSummary(
            receiver?.viewport || receiver?.annotationEditorLayer?.viewport,
          ),
          pageViewport:viewportSummary(tracePageView.viewport),
          requestedViewport:viewportSummary(parameters?.viewport),
          requestedMode:typeof parameters === "number"
            ? parameters
            : parameters?.mode ?? null,
          stack:captureStack(),
        });
        if (trace.length > 352) trace.splice(0, trace.length - 352);
      };
      const wrap = (
        target,
        method,
        label,
        beforeCall = null,
        captureAfter = false,
        contextForCall = null,
      ) => {
        const original = target?.[method];
        if (!target || typeof original !== "function") return;
        let tracedMethods = tracedMethodsByTarget.get(target);
        if (!tracedMethods) {
          tracedMethods = new Set();
          tracedMethodsByTarget.set(target, tracedMethods);
        }
        if (tracedMethods.has(method)) return;
        tracedMethods.add(method);
        if (original.__mouseLifecycleTrace) return;
        const traced = function (...args) {
          beforeCall?.call(this, args);
          const context = contextForCall?.(this, args) || null;
          if (context?.pageLayer) traceContexts.set(context.pageLayer, context);
          record(`${label}.begin`, this, args, context);
          const result = original.apply(this, args);
          if (captureAfter) record(`${label}.return`, this, args, context);
          return result;
        };
        Object.defineProperty(traced, "__mouseLifecycleTrace", { value:true });
        Object.defineProperty(traced, "__mouseLifecycleTraceTargetIdentity", {
          value:objectIdentity(target),
        });
        target[method] = traced;
        restores.push(() => {
          if (target[method] === traced) target[method] = original;
        });
      };
      const instrumentEditor = (editor) => {
        if (!editor || instrumentedEditors.has(editor)) return;
        instrumentedEditors.add(editor);
        for (const method of [
          "commitOrRemove",
          "remove",
          "focusout",
          "moveInDOM",
          "enterInEditMode",
          "disableEditMode",
        ]) {
          wrap(editor, method, `editor.${method}`);
        }
      };

      const instrumentedLayerUpdates = new WeakSet();
      const instrumentedBuilderRenders = new WeakSet();
      const instrumentedBuilderRenderPrototypes = new WeakSet();
      const pageContextFor = (pageView) => {
        const currentApp = window.PDFViewerApplication;
        const currentPdfViewer = currentApp?.pdfViewer;
        const currentBuilder = pageView?.annotationEditorLayer;
        return {
          app:currentApp,
          pdfViewer:currentPdfViewer,
          pageView,
          builder:currentBuilder,
          pageLayer:currentBuilder?.annotationEditorLayer ?? null,
          manager:currentPdfViewer?._layerProperties?.annotationEditorUIManager,
        };
      };
      const findPageViewForLayer = (receiver) => {
        const pages = window.PDFViewerApplication?.pdfViewer?._pages || [];
        return pages.find((candidate) =>
          candidate?.annotationEditorLayer?.annotationEditorLayer === receiver,
        ) || null;
      };
      const sameViewportPresentation = (left, right) => {
        if (!left || !right) return false;
        for (const key of [
          "rotation", "scale", "width", "height", "offsetX", "offsetY",
        ]) {
          if (!Object.is(left[key], right[key])) return false;
        }
        for (const key of ["viewBox", "transform"]) {
          const before = left[key];
          const after = right[key];
          if (!before && !after) continue;
          if (!before || !after || before.length !== after.length ||
            Array.from(before).some((value, index) => !Object.is(value, after[index]))) {
            return false;
          }
        }
        return true;
      };
      const recordAllLayerUpdate = (phase, receiver, args, commitCountBefore = null) => {
        if (!window.__mousePdfEditorLifecycleTraceEnabled) return;
        const actualPageView = findPageViewForLayer(receiver);
        const currentApp = window.PDFViewerApplication;
        const currentPdfViewer = currentApp?.pdfViewer;
        const context = actualPageView ? pageContextFor(actualPageView) : {
          app:currentApp,
          pdfViewer:currentPdfViewer,
          pageView:null,
          builder:null,
          pageLayer:receiver,
          manager:currentPdfViewer?._layerProperties?.annotationEditorUIManager,
        };
        const active = document.activeElement;
        const activeElement = active instanceof Element
          ? active.closest(".freeTextEditor")
          : null;
        const activeEditor = activeElement &&
          context.manager?.getEditor?.(activeElement.id);
        const requestedViewport = args[0]?.viewport ?? null;
        trace.push({
          time:Math.round(performance.now()),
          method:`allLayerUpdate.${phase}`,
          receiverIdentity:objectIdentity(receiver),
          receiverPageIndex:receiver?.pageIndex ?? null,
          appIdentity:objectIdentity(context.app),
          documentIdentity:objectIdentity(context.app?.pdfDocument),
          pdfViewerIdentity:objectIdentity(context.pdfViewer),
          pageViewIdentity:objectIdentity(actualPageView),
          builderIdentity:objectIdentity(context.builder),
          managerIdentity:objectIdentity(context.manager),
          managerCurrentPageIndex:context.manager?.currentPageIndex ?? null,
          managerCurrentLayerIdentity:objectIdentity(context.manager?.currentLayer),
          managerCurrentLayerPageIndex:context.manager?.currentLayer?.pageIndex ?? null,
          managerCurrentLayerMatchesReceiver:context.manager?.currentLayer === receiver,
          receiverIsCurrentPageLayer:Boolean(
            actualPageView && context.builder?.annotationEditorLayer === receiver,
          ),
          receiverConnected:Boolean(receiver?.div?.isConnected),
          activeElementId:active?.id || "",
          activeEditor:activeEditor ? {
            id:activeEditor.id,
            pageIndex:activeEditor.pageIndex,
            parentLayerIdentity:objectIdentity(activeEditor.parent),
            parentPageIndex:activeEditor.parent?.pageIndex ?? null,
            parentMatchesReceiver:activeEditor.parent === receiver,
            managerOwnsEditor:context.manager?.getEditor?.(activeEditor.id) === activeEditor,
            attached:Boolean(activeEditor.isAttachedToDOM),
            connected:Boolean(activeEditor.div?.isConnected),
            editing:Boolean(activeEditor.isInEditMode?.()),
            empty:Boolean(activeEditor.isEmpty?.()),
          } : null,
          layerViewport:viewportSummary(receiver?.viewport),
          requestedViewport:viewportSummary(requestedViewport),
          samePresentation:sameViewportPresentation(receiver?.viewport, requestedViewport),
          managerCommitCountBefore:phase === "begin" ? commitCountBefore : null,
          managerCommitCountAfter:phase === "return"
            ? trace.filter((entry) => entry.method === "manager.commitOrRemove.begin").length
            : null,
          stack:captureStack(),
        });
        if (trace.length > 352) trace.splice(0, trace.length - 352);
      };
      const instrumentLayerUpdate = (layer) => {
        if (!layer || instrumentedLayerUpdates.has(layer) ||
          typeof layer.update !== "function") return;
        instrumentedLayerUpdates.add(layer);
        const originalUpdate = layer.update;
        const observedUpdate = function (...args) {
          const commitCountBefore = trace.filter(
            (entry) => entry.method === "manager.commitOrRemove.begin",
          ).length;
          recordAllLayerUpdate("begin", this, args, commitCountBefore);
          const result = originalUpdate.apply(this, args);
          recordAllLayerUpdate("return", this, args, commitCountBefore);
          return result;
        };
        Object.defineProperty(observedUpdate, "__mouseAllLayerUpdateTrace", { value:true });
        Object.defineProperty(observedUpdate, "__mouseOriginalUpdate", {
          value:originalUpdate,
        });
        layer.update = observedUpdate;
        restores.push(() => {
          if (layer.update === observedUpdate) layer.update = originalUpdate;
        });
      };
      const hasBridgeUpdateWrapper = (method) => {
        const seen = new Set();
        while (typeof method === "function" && !seen.has(method)) {
          if (method.name === "wrapped") return true;
          seen.add(method);
          method = method.__mouseOriginalUpdate;
        }
        return false;
      };
      window.__mouseHasBridgeUpdateWrapper = hasBridgeUpdateWrapper;
      const instrumentBuilderRender = (target, property = "render") => {
        if (!target || instrumentedBuilderRenders.has(target) ||
          typeof target[property] !== "function") return;
        instrumentedBuilderRenders.add(target);
        const originalRender = target[property];
        const observedRender = function (...args) {
          instrumentLayerUpdate(this.annotationEditorLayer);
          const result = originalRender.apply(this, args);
          instrumentLayerUpdate(this.annotationEditorLayer);
          return result;
        };
        target[property] = observedRender;
        restores.push(() => {
          if (target[property] === observedRender) target[property] = originalRender;
        });
      };
      const instrumentBuilderRenderPrototype = (prototype) => {
        if (!prototype || instrumentedBuilderRenderPrototypes.has(prototype) ||
          typeof prototype.render !== "function") return;
        instrumentedBuilderRenderPrototypes.add(prototype);
        const originalRender = prototype.render;
        const observedRender = function (...args) {
          instrumentLayerUpdate(this.annotationEditorLayer);
          const result = originalRender.apply(this, args);
          instrumentLayerUpdate(this.annotationEditorLayer);
          return result;
        };
        prototype.render = observedRender;
        restores.push(() => {
          if (prototype.render === observedRender) prototype.render = originalRender;
        });
      };

      for (const candidatePageView of pdfViewer._pages || [pageView]) {
        const context = pageContextFor(candidatePageView);
        if (!context.builder) continue;
        traceContexts.set(candidatePageView, context);
        traceContexts.set(context.builder, context);
        if (context.pageLayer) {
          traceContexts.set(context.pageLayer, context);
          instrumentLayerUpdate(context.pageLayer);
        }
        instrumentBuilderRender(context.builder);
        instrumentBuilderRenderPrototype(Object.getPrototypeOf(context.builder));
      }

      window.__mousePdfEditorLifecycleTraceState = {
        pageIndex:pageView.id - 1,
        managerCurrentPageIndex:manager.currentPageIndex ?? null,
        managerCurrentLayerPageIndex:manager.currentLayer?.pageIndex ?? null,
        managerCurrentLayerMatchesPage:Boolean(manager.currentLayer === pageLayer),
        bridgeMoveWrapperInstalled:pageLayer.moveEditorInDOM?.name === "wrapped",
        bridgeUpdateWrapperInstalled:hasBridgeUpdateWrapper(pageLayer.update),
        bridgePageLayerMatchesBuilder:Boolean(builder.annotationEditorLayer === pageLayer),
        pageRenderingState:pageView.renderingState,
      };
      window.__mouseManualPauseResumeCalls = [];

      for (const [target, method, label] of [
        [pageView, "reset", "pageView.reset"],
        [pageView, "update", "pageView.update"],
        [pageView, "cssTransform", "pageView.cssTransform"],
        [builder, "hide", "builder.hide"],
        [builder, "show", "builder.show"],
        [pageLayer, "pause", "layer.pause"],
        [builder, "render", "builder.render"],
        [pageLayer, "render", "layer.render"],
        [pageLayer, "update", "layer.update"],
        [pageLayer, "updateMode", "layer.updateMode"],
        [pageLayer, "destroy", "layer.destroy"],
        [manager, "updateMode", "manager.updateMode"],
        [manager, "findClonesForPage", "manager.findClonesForPage"],
        [manager, "commitOrRemove", "manager.commitOrRemove"],
        [manager, "removeEditor", "manager.removeEditor"],
      ]) {
        wrap(target, method, label, null, true);
      }
      window.__mouseInstrumentPageLayer = (currentPageView, currentBuilder, currentPageLayer) => {
        const currentApp = window.PDFViewerApplication;
        const currentPdfViewer = currentApp?.pdfViewer;
        const currentManager = currentPdfViewer?._layerProperties?.annotationEditorUIManager;
        if (!currentApp || !currentPdfViewer || !currentPageView ||
          !currentBuilder || !currentPageLayer || !currentManager) {
          throw new Error("The current page annotation layer is unavailable for lifecycle tracing");
        }
        const context = {
          app:currentApp,
          pdfViewer:currentPdfViewer,
          pageView:currentPageView,
          builder:currentBuilder,
          pageLayer:currentPageLayer,
          manager:currentManager,
        };
        traceContexts.set(currentPageLayer, context);
        wrap(currentPageLayer, "pause", "layer.pause", null, true, () => context);
        return {
          appIdentity:objectIdentity(currentApp),
          pdfViewerIdentity:objectIdentity(currentPdfViewer),
          documentIdentity:objectIdentity(currentApp.pdfDocument),
          pageViewIdentity:objectIdentity(currentPageView),
          builderIdentity:objectIdentity(currentBuilder),
          pageLayerIdentity:objectIdentity(currentPageLayer),
          managerIdentity:objectIdentity(currentManager),
          pageIndex:currentPageView.id - 1,
          builderPageIndex:currentBuilder.pageIndex,
          layerConnected:Boolean(currentPageLayer.div?.isConnected),
          currentLayerMatches:Boolean(currentManager.currentLayer === currentPageLayer),
        };
      };
      wrap(pageLayer, "add", "layer.add", ([editor]) => instrumentEditor(editor));
      const originalFocus = HTMLElement.prototype.focus;
      if (typeof originalFocus === "function") {
        const tracedFocus = function (...args) {
          const relevant = this.closest?.(".freeTextEditor, .annotationEditorLayer") ||
            this.matches?.(".pdfReaderBridgeControlButton");
          if (relevant) record("element.focus.begin", this, args);
          const result = originalFocus.apply(this, args);
          if (relevant) record("element.focus.return", this, args);
          return result;
        };
        Object.defineProperty(tracedFocus, "__mouseLifecycleTrace", { value:true });
        HTMLElement.prototype.focus = tracedFocus;
        restores.push(() => {
          if (HTMLElement.prototype.focus === tracedFocus) {
            HTMLElement.prototype.focus = originalFocus;
          }
        });
      }
      const lifecycleMutationObserver = new MutationObserver((mutations) => {
        if (!window.__mousePdfEditorLifecycleTraceEnabled) return;
        for (const mutation of mutations) {
          trace.push({
            time:Math.round(performance.now()),
            method:"lifecycle.attributeMutation",
            attributeName:mutation.attributeName,
            oldValue:mutation.oldValue,
            target:elementSummary(mutation.target),
            pageViewRenderingState:pageView.renderingState,
            pageViewPresentation:viewportSummary(pageView.viewport),
            layerViewport:viewportSummary(pageLayer.viewport),
            activeElement:elementSummary(document.activeElement),
          });
        }
      });
      for (const element of [pageView.div, builder.div]) {
        if (element) {
          lifecycleMutationObserver.observe(element, {
            attributes:true,
            attributeOldValue:true,
            attributeFilter:["class", "hidden", "style"],
          });
        }
      }
      restores.push(() => lifecycleMutationObserver.disconnect());
      window.__stopMousePdfEditorLifecycleTrace = () => {
        window.__mousePdfEditorLifecycleTraceEnabled = false;
        for (const restore of restores.reverse()) restore();
        // Keep the read-only identity and bridge-wrapper inspectors available
        // for the later saved-document/reopen probes. All method wrappers and
        // observers above have already been restored here.
      };
      window.__mouseTestMilestones.pdfEditorLifecycleTraceState =
        window.__mousePdfEditorLifecycleTraceState;
      return window.__mousePdfEditorLifecycleTraceState;
    });
    assert.equal(
      pdfEditorLifecycleTraceState.bridgeMoveWrapperInstalled,
      true,
      `The active page's PDF.js accessibility move guard must be installed before focus: ${JSON.stringify(pdfEditorLifecycleTraceState)}`,
    );
    assert.equal(
      pdfEditorLifecycleTraceState.bridgeUpdateWrapperInstalled,
      true,
      `The active page's annotation update guard must be installed before focus: ${JSON.stringify(pdfEditorLifecycleTraceState)}`,
    );

    const modeActivationTraceState = await viewer.evaluate(() => {
      const app = window.PDFViewerApplication;
      const pdfViewer = app?.pdfViewer;
      const pageView = pdfViewer?.getPageView(0);
      const pageLayer = pageView?.annotationEditorLayer?.annotationEditorLayer;
      const manager = pdfViewer?._layerProperties?.annotationEditorUIManager;
      if (!app || !pdfViewer || !pageView || !pageLayer || !manager) {
        throw new Error("PDF.js mode-transition diagnostics require the active page editor layer");
      }
      const trace = window.__mouseModeActivationTrace = [];
      const restores = [];
      window.__mouseModeActivationTraceEnabled = true;
      const captureStack = () => {
        const previousLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 40;
        try {
          return (new Error().stack?.split("\n").slice(1, 41) || []).filter(
            (line, index) => index < 2 ||
              /pdf\.mjs|viewer\.mjs|obsidian-bridge\.js/.test(line),
          );
        } finally {
          Error.stackTraceLimit = previousLimit;
        }
      };
      const activeEditorSummary = () => {
        const active = document.activeElement;
        const element = active instanceof Element
          ? active.closest(".freeTextEditor")
          : null;
        const editor = element && manager.getEditor?.(element.id);
        return editor ? {
          id:editor.id,
          pageIndex:editor.pageIndex,
          parentPageIndex:editor.parent?.pageIndex ?? null,
          parentMatchesPage:Boolean(editor.parent === pageLayer),
          attached:Boolean(editor.isAttachedToDOM),
          selected:Boolean(editor.div?.classList.contains("selectedEditor")),
          editing:Boolean(editor.isInEditMode?.()),
          empty:Boolean(editor.isEmpty?.()),
          focused:Boolean(element.contains(active)),
        } : null;
      };
      const record = (method, phase, args = [], error = null) => {
        if (!window.__mouseModeActivationTraceEnabled) return;
        trace.push({
          time:Math.round(performance.now()),
          method,
          phase,
          requestedMode:typeof args[0] === "number" ? args[0] : args[0]?.mode ?? null,
          viewerMode:pdfViewer.annotationEditorMode,
          managerMode:manager.getMode?.() ?? null,
          pendingModeUpdates:window.__mouseModeUpdatesPending ?? 0,
          activeEditor:activeEditorSummary(),
          pageEditors:Array.from(manager.getEditors?.(0) || []).slice(0, 12).map((editor) => ({
            id:editor.id,
            pageIndex:editor.pageIndex,
            attached:Boolean(editor.isAttachedToDOM),
            selected:Boolean(editor.div?.classList.contains("selectedEditor")),
            editing:Boolean(editor.isInEditMode?.()),
            empty:Boolean(editor.isEmpty?.()),
          })),
          error:error?.message || null,
          stack:phase === "begin" || phase === "throw" ? captureStack() : [],
        });
        if (trace.length > 96) trace.splice(0, trace.length - 96);
      };
      const wrap = (target, method, label, { trackPending = false } = {}) => {
        const original = target?.[method];
        if (typeof original !== "function") return false;
        const wrapped = function (...args) {
          if (trackPending) window.__mouseModeUpdatesPending =
            (window.__mouseModeUpdatesPending || 0) + 1;
          record(label, "begin", args);
          let result;
          try {
            result = original.apply(this, args);
          } catch (error) {
            record(label, "throw", args, error);
            if (trackPending) window.__mouseModeUpdatesPending -= 1;
            throw error;
          }
          if (!result || typeof result.then !== "function") {
            record(label, "return", args);
            if (trackPending) window.__mouseModeUpdatesPending -= 1;
            return result;
          }
          return Promise.resolve(result).then(
            (value) => {
              record(label, "resolved", args);
              if (trackPending) window.__mouseModeUpdatesPending -= 1;
              return value;
            },
            (error) => {
              record(label, "rejected", args, error);
              if (trackPending) window.__mouseModeUpdatesPending -= 1;
              throw error;
            },
          );
        };
        target[method] = wrapped;
        restores.push(() => {
          if (target[method] === wrapped) target[method] = original;
        });
        return true;
      };
      const wrappedMethods = {
        managerUpdateMode:wrap(manager, "updateMode", "manager.updateMode", {
          trackPending:true,
        }),
        managerUnselectAll:wrap(manager, "unselectAll", "manager.unselectAll"),
        pageLayerEnable:wrap(pageLayer, "enable", "pageLayer.enable"),
        pageLayerUpdateMode:wrap(pageLayer, "updateMode", "pageLayer.updateMode"),
        pageLayerUpdate:wrap(pageLayer, "update", "pageLayer.update"),
      };
      const onModeChanged = ({ mode } = {}) => {
        record("event.annotationeditormodechanged", "complete", [{ mode }]);
      };
      app.eventBus?._on?.("annotationeditormodechanged", onModeChanged);
      window.__mouseModeActivationTraceState = {
        pageIndex:pageView.id - 1,
        managerMode:manager.getMode?.() ?? null,
        viewerMode:pdfViewer.annotationEditorMode,
        wrappedMethods,
      };
      window.__stopMouseModeActivationTrace = () => {
        window.__mouseModeActivationTraceEnabled = false;
        for (const restore of restores.reverse()) restore();
        app.eventBus?._off?.("annotationeditormodechanged", onModeChanged);
      };
      return window.__mouseModeActivationTraceState;
    });
    await viewer.evaluate((snapshot) => {
      window.__mouseTestMilestones.modeActivationTraceState = snapshot;
    }, modeActivationTraceState);

    // A text editor saved and reopened from real mouse input remains editable
    // through the native double-click path. Right-click inside its contenteditable
    // keeps the browser's native context menu available.
    await viewer.evaluate(() => {
      window.__mouseModeActivationTrace?.push({
        time:Math.round(performance.now()),
        method:"test.beforeNativeFreeTextModeClick",
        phase:"mark",
      });
    });
    const freeTextModeRequest = await beginAnnotationModeChange(3);
    await click("#editorFreeTextButton");
    await noteAnnotationModeClickReturned(freeTextModeRequest.id);
    await waitForAnnotationModeChange(3, freeTextModeRequest, 5_000);
    await viewer.evaluate(() => {
      window.__mouseModeActivationTrace?.push({
        time:Math.round(performance.now()),
        method:"test.modePropertyVisible",
        phase:"mark",
        viewerMode:PDFViewerApplication.pdfViewer.annotationEditorMode,
        pendingModeUpdates:window.__mouseModeUpdatesPending ?? 0,
      });
      window.__mouseTestMilestones.modePropertyVisible = Math.round(performance.now());
    });
    await viewer.evaluate(() => {
      window.__mouseTestMilestones.editorMoveTracingInstalled =
        window.__installPdfEditorMoveTrace();
      window.__pdfEditorMoveCalls.length = 0;
      window.__pdfEditorMoveEvents.length = 0;
    });
    const inactivePagePrepared = await viewer.evaluate(async () => {
      const app = window.PDFViewerApplication;
      const pdfViewer = app?.pdfViewer;
      const pageView = pdfViewer?.getPageView(1);
      if (!app?.pdfDocument || !pageView) {
        throw new Error("The second PDF page is unavailable for the cross-page editor lifecycle probe");
      }
      if (!pageView.pdfPage) {
        pageView.setPdfPage(await app.pdfDocument.getPage(2));
      }
      let editorLayer = pageView.annotationEditorLayer?.annotationEditorLayer;
      if (!editorLayer || !window.__mouseHasBridgeUpdateWrapper?.(editorLayer.update)) {
        if (pageView.renderingState !== 0) pageView.reset();
        await pageView.draw();
        editorLayer = pageView.annotationEditorLayer?.annotationEditorLayer;
      }
      const state = {
        documentIdentity:window.__mouseObjectIdentity?.(app.pdfDocument) ?? null,
        pageViewIdentity:window.__mouseObjectIdentity?.(pageView) ?? null,
        pageIndex:pageView.id - 1,
        pageNumber:pageView.pdfPage?.pageNumber ?? null,
        renderingState:pageView.renderingState,
        documentMatchesViewer:app.pdfDocument === pdfViewer.pdfDocument,
        builderPresent:Boolean(pageView.annotationEditorLayer),
        builderIdentity:window.__mouseObjectIdentity?.(pageView.annotationEditorLayer) ?? null,
        layerPresent:Boolean(editorLayer),
        layerIdentity:window.__mouseObjectIdentity?.(editorLayer) ?? null,
        layerConnected:Boolean(editorLayer?.div?.isConnected),
        bridgeUpdateWrapperInstalled:Boolean(
          editorLayer && window.__mouseHasBridgeUpdateWrapper?.(editorLayer.update),
        ),
        viewport:editorLayer?.viewport ? {
          rotation:editorLayer.viewport.rotation,
          scale:editorLayer.viewport.scale,
          width:editorLayer.viewport.width,
          height:editorLayer.viewport.height,
        } : null,
      };
      window.__mouseTestMilestones.inactivePagePrepared = state;
      return state;
    });
    assert.equal(inactivePagePrepared.pageIndex, 1, JSON.stringify(inactivePagePrepared));
    assert.equal(inactivePagePrepared.pageNumber, 2, JSON.stringify(inactivePagePrepared));
    assert.equal(inactivePagePrepared.documentMatchesViewer, true, JSON.stringify(inactivePagePrepared));
    assert.equal(inactivePagePrepared.builderPresent, true, JSON.stringify(inactivePagePrepared));
    assert.equal(inactivePagePrepared.layerPresent, true, JSON.stringify(inactivePagePrepared));
    assert.equal(inactivePagePrepared.layerConnected, true, JSON.stringify(inactivePagePrepared));
    assert.equal(inactivePagePrepared.bridgeUpdateWrapperInstalled, true, JSON.stringify(inactivePagePrepared));
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
    await viewer.evaluate(() => {
      window.__mouseModeActivationTrace?.push({
        time:Math.round(performance.now()),
        method:"test.beforeFirstFreeTextClick",
        phase:"mark",
        viewerMode:PDFViewerApplication.pdfViewer.annotationEditorMode,
        pendingModeUpdates:window.__mouseModeUpdatesPending ?? 0,
      });
      window.__mouseTestMilestones.beforeFirstFreeTextClick = Math.round(performance.now());
    });
    const offsetForText = await iframeOffset();
    await page.mouse.click(
      offsetForText.x + freeTextPoint.x,
      offsetForText.y + freeTextPoint.y,
    );
    await viewer.evaluate(() => {
      window.__mouseModeActivationTrace?.push({
        time:Math.round(performance.now()),
        method:"test.afterFirstFreeTextClick",
        phase:"mark",
        viewerMode:PDFViewerApplication.pdfViewer.annotationEditorMode,
        pendingModeUpdates:window.__mouseModeUpdatesPending ?? 0,
        activeEditor:(() => {
          const manager = PDFViewerApplication.pdfViewer._layerProperties
            ?.annotationEditorUIManager;
          const element = document.activeElement?.closest?.(".freeTextEditor");
          const editor = element && manager?.getEditor?.(element.id);
          return editor ? {
            id:editor.id,
            pageIndex:editor.pageIndex,
            parentPageIndex:editor.parent?.pageIndex ?? null,
            attached:Boolean(editor.isAttachedToDOM),
            selected:Boolean(editor.div?.classList.contains("selectedEditor")),
            editing:Boolean(editor.isInEditMode?.()),
            empty:Boolean(editor.isEmpty?.()),
          } : null;
        })(),
      });
    });
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
        const app = window.PDFViewerApplication;
        const pageView = app?.pdfViewer?.getPageView(0);
        const manager = app?.pdfViewer?._layerProperties
          ?.annotationEditorUIManager;
        const pageLayer = pageView?.annotationEditorLayer
          ?.annotationEditorLayer;
        const internal = document.querySelector(
          ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
        );
        const editor = internal?.closest(".freeTextEditor.selectedEditor");
        const runtimeEditor = editor && manager?.getEditor?.(editor.id);
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
            runtimeEditor?.div === editor &&
            runtimeEditor.parent === pageLayer &&
            runtimeEditor.pageIndex === 0 &&
            runtimeEditor.isAttachedToDOM &&
            runtimeEditor.isInEditMode() &&
            editor.classList.contains("selectedEditor") &&
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
          runtimeEditorId:runtimeEditor?.id ?? null,
          managerOwnsEditor:Boolean(
            runtimeEditor && manager?.getEditor?.(editor?.id) === runtimeEditor,
          ),
          editorParentMatchesPageLayer:runtimeEditor?.parent === pageLayer,
          editorPageIndex:runtimeEditor?.pageIndex ?? null,
          editorAttached:runtimeEditor?.isAttachedToDOM ?? false,
          editorSelected:Boolean(editor?.classList.contains("selectedEditor")),
          editorEditing:Boolean(runtimeEditor?.isInEditMode?.()),
          editorEmpty:Boolean(runtimeEditor?.isEmpty?.()),
          managerCurrentPageIndex:manager?.currentPageIndex ?? null,
          currentLayerMatchesPageLayer:manager?.currentLayer === pageLayer,
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
    const modeActivationBeforeTyping = await viewer.evaluate(() => {
      const snapshot = {
        viewerMode:PDFViewerApplication.pdfViewer.annotationEditorMode,
        pendingModeUpdates:window.__mouseModeUpdatesPending ?? 0,
        trace:window.__mouseModeActivationTrace?.slice(-96) || [],
      };
      window.__mouseTestMilestones.modeActivationBeforeTyping = snapshot;
      window.__stopMouseModeActivationTrace?.();
      return snapshot;
    });
    if (process.env.PDF_MOUSE_MODE_TRACE === "1") {
      console.log(`Mouse mode activation trace: ${JSON.stringify(modeActivationBeforeTyping)}`);
    }
    const focusBeforeTyping = await viewer.evaluate(() => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(0);
      const manager = app?.pdfViewer?._layerProperties
        ?.annotationEditorUIManager;
      const pageLayer = pageView?.annotationEditorLayer
        ?.annotationEditorLayer;
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editor = internal?.closest(".freeTextEditor.selectedEditor");
      const runtimeEditor = editor && manager?.getEditor?.(editor.id);
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
        managerEditorFound:Boolean(runtimeEditor),
        managerOwnsEditor:manager?.getEditor?.(editor?.id) === runtimeEditor,
        editorParentMatchesPageLayer:runtimeEditor?.parent === pageLayer,
        editorPageIndex:runtimeEditor?.pageIndex ?? null,
        editorAttached:runtimeEditor?.isAttachedToDOM ?? false,
        editorSelected:Boolean(editor?.classList.contains("selectedEditor")),
        editorEditing:Boolean(runtimeEditor?.isInEditMode?.()),
        editorEmpty:Boolean(runtimeEditor?.isEmpty?.()),
        managerCurrentPageIndex:manager?.currentPageIndex ?? null,
        currentLayerMatchesPageLayer:manager?.currentLayer === pageLayer,
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
    assert.equal(focusBeforeTyping.managerEditorFound, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.managerOwnsEditor, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.editorParentMatchesPageLayer, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.editorPageIndex, 0, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.editorAttached, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.editorSelected, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.editorEditing, true, JSON.stringify(focusBeforeTyping));
    assert.equal(focusBeforeTyping.editorEmpty, true, JSON.stringify(focusBeforeTyping));
    assert.equal(modeActivationBeforeTyping.pendingModeUpdates, 0, JSON.stringify(modeActivationBeforeTyping));
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
      const pdfViewer = app?.pdfViewer;
      const pageView = pdfViewer?.getPageView(0);
      const manager = pdfViewer?._layerProperties?.annotationEditorUIManager;
      const accessibilityManager = pageView?._accessibilityManager;
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editorElement = internal?.closest(".freeTextEditor");
      const editorLayer = pageView?.annotationEditorLayer
        ?.annotationEditorLayer;
      const editor = editorElement && manager?.getEditor?.(editorElement.id);
      if (!internal || !editor || !accessibilityManager ||
        editor.div !== editorElement ||
        editor.parent !== editorLayer ||
        editor.pageIndex !== pageView.id - 1 ||
        typeof editorLayer?.moveEditorInDOM !== "function") {
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
          editorLayer.moveEditorInDOM(editor);
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
          managerOwnsEditor:manager.getEditor?.(editor.id) === editor,
          parentLayerMatchesPage:editor.parent === editorLayer,
          currentLayerMatchesPage:manager.currentLayer === editorLayer,
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
    assert.equal(deferredMoveProbe.managerOwnsEditor, true);
    assert.equal(deferredMoveProbe.parentLayerMatchesPage, true);
    assert.equal(deferredMoveProbe.currentLayerMatchesPage, true);
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
    const verifySameViewportUpdate = async (expectedText, expectedOffset, key) => {
      const snapshot = await viewer.evaluate(async () => {
        const app = window.PDFViewerApplication;
        const pageView = app?.pdfViewer?.getPageView(0);
        const layerBuilder = pageView?.annotationEditorLayer;
        const editorLayer = layerBuilder?.annotationEditorLayer;
        const internal = document.querySelector(
          ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
        );
        const editorElement = internal?.closest(".freeTextEditor");
        const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const editor = editorElement && manager?.getEditor?.(editorElement.id);
        if (!pageView || !layerBuilder || !editorLayer || !internal || !editor) {
          throw new Error("The focused FreeText editor disappeared before its page update");
        }
        const viewport = pageView.viewport;
        const viewportBefore = {
          rotation:viewport.rotation,
          scale:viewport.scale,
          width:viewport.width,
          height:viewport.height,
          offsetX:viewport.offsetX,
          offsetY:viewport.offsetY,
        };
        const selection = window.getSelection();
        const anchorNode = selection?.anchorNode;
        const focusNode = selection?.focusNode;
        const anchorOffset = selection?.anchorOffset;
        const focusOffset = selection?.focusOffset;
        await layerBuilder.render({ viewport });
        const updatedViewport = pageView.viewport;
        const sameViewport = ["rotation", "scale", "width", "height", "offsetX", "offsetY"]
          .every((field) => Object.is(viewportBefore[field], updatedViewport[field]));
        return {
          sameViewport,
          layerConnected:editorLayer.div.isConnected,
          active:document.activeElement === internal,
          contentEditable:internal.isContentEditable,
          selected:editorElement.classList.contains("selectedEditor"),
          text:internal.textContent.replace(/\u200b/g, ""),
          sameAnchor:selection?.anchorNode === anchorNode,
          sameFocus:selection?.focusNode === focusNode,
          sameOffsets:selection?.anchorOffset === anchorOffset &&
            selection?.focusOffset === focusOffset,
          caretOffset:selection?.rangeCount === 1
            ? (() => {
                const range = selection.getRangeAt(0);
                if (range.startContainer !== internal && !internal.contains(range.startContainer)) {
                  return null;
                }
                const prefix = document.createRange();
                prefix.selectNodeContents(internal);
                prefix.setEnd(range.startContainer, range.startOffset);
                return prefix.toString().replace(/\u200b/g, "").length;
              })()
            : null,
        };
      });
      await viewer.evaluate(({ snapshot:state, key:name }) => {
        window.__mouseTestMilestones[name] = state;
      }, { snapshot, key });
      for (const field of [
        "sameViewport",
        "layerConnected",
        "active",
        "contentEditable",
        "selected",
        "sameAnchor",
        "sameFocus",
        "sameOffsets",
      ]) {
        assert.equal(snapshot[field], true, `${key}: ${JSON.stringify(snapshot)}`);
      }
      assert.equal(snapshot.text, expectedText, `${key}: ${JSON.stringify(snapshot)}`);
      assert.equal(snapshot.caretOffset, expectedOffset, `${key}: ${JSON.stringify(snapshot)}`);
      return snapshot;
    };
    await verifySameViewportUpdate("", 0, "sameViewportUpdateBeforeTyping");
    const inactivePageUpdate = await viewer.evaluate(() => {
      const app = window.PDFViewerApplication;
      const pdfViewer = app?.pdfViewer;
      const manager = pdfViewer?._layerProperties?.annotationEditorUIManager;
      const activeInternal = document.activeElement;
      const activeElement = activeInternal instanceof Element
        ? activeInternal.closest(".freeTextEditor")
        : null;
      const editor = activeElement && manager?.getEditor?.(activeElement.id);
      const pageView = pdfViewer?.getPageView(1);
      const layer = pageView?.annotationEditorLayer?.annotationEditorLayer;
      if (!manager || !editor || !pageView || !layer ||
        !activeInternal?.isContentEditable ||
        !window.__mouseHasBridgeUpdateWrapper?.(layer.update)) {
        throw new Error("The focused empty editor and current-document page 2 layer are required for the cross-page update probe");
      }
      const viewport = layer.viewport;
      const before = {
        editorId:editor.id,
        identity:window.__mouseObjectIdentity?.(editor) ?? null,
        editorPageIndex:editor.pageIndex,
        parentPageIndex:editor.parent?.pageIndex ?? null,
        parentIdentity:window.__mouseObjectIdentity?.(editor.parent) ?? null,
        parentMatchesCurrentLayer:editor.parent === manager.currentLayer,
        managerOwnsEditor:manager.getEditor(editor.id) === editor,
        attached:Boolean(editor.isAttachedToDOM),
        editing:Boolean(editor.isInEditMode?.()),
        empty:Boolean(editor.isEmpty?.()),
        focused:document.activeElement === editor.div?.querySelector(".internal"),
        connected:Boolean(editor.div?.isConnected),
        text:editor.div?.querySelector(".internal")?.textContent?.replace(/\u200b/g, "") ?? null,
        bounds:editor.div?.getBoundingClientRect().toJSON?.() ?? null,
      };
      const sameViewport = layer.viewport === viewport &&
        viewport.scale === pageView.viewport.scale &&
        viewport.rotation === pageView.viewport.rotation &&
        viewport.width === pageView.viewport.width &&
        viewport.height === pageView.viewport.height;
      // Re-run PDF.js's real layer.update with the exact current viewport from
      // page 2 while page 1 owns an empty, focused FreeText editor. PDF.js
      // update() commits through the shared UI manager even on a non-current
      // layer, so this covers the cross-page render path without changing the
      // active page, viewport, or edit mode.
      layer.update({ viewport });
      const currentEditor = manager.getEditor(before.editorId);
      const currentInternal = currentEditor?.div?.querySelector(".internal");
      const after = {
        editorId:currentEditor?.id ?? null,
        identity:window.__mouseObjectIdentity?.(currentEditor) ?? null,
        editorPageIndex:currentEditor?.pageIndex ?? null,
        parentPageIndex:currentEditor?.parent?.pageIndex ?? null,
        parentIdentity:window.__mouseObjectIdentity?.(currentEditor?.parent) ?? null,
        parentMatchesCurrentLayer:currentEditor?.parent === manager.currentLayer,
        managerOwnsEditor:Boolean(
          currentEditor && manager.getEditor(before.editorId) === currentEditor,
        ),
        attached:Boolean(currentEditor?.isAttachedToDOM),
        editing:Boolean(currentEditor?.isInEditMode?.()),
        empty:Boolean(currentEditor?.isEmpty?.()),
        focused:document.activeElement === currentInternal,
        connected:Boolean(currentEditor?.div?.isConnected),
        text:currentInternal?.textContent?.replace(/\u200b/g, "") ?? null,
        bounds:currentEditor?.div?.getBoundingClientRect().toJSON?.() ?? null,
      };
      const probe = {
        documentIdentity:window.__mouseObjectIdentity?.(app.pdfDocument) ?? null,
        activePageViewIdentity:window.__mouseObjectIdentity?.(pdfViewer.getPageView(0)) ?? null,
        activePageLayerIdentity:window.__mouseObjectIdentity?.(manager.currentLayer) ?? null,
        receiverPageViewIdentity:window.__mouseObjectIdentity?.(pageView) ?? null,
        receiverBuilderIdentity:window.__mouseObjectIdentity?.(pageView.annotationEditorLayer) ?? null,
        receiverLayerIdentity:window.__mouseObjectIdentity?.(layer) ?? null,
        managerIdentity:window.__mouseObjectIdentity?.(manager) ?? null,
        editorIdentity:window.__mouseObjectIdentity?.(editor) ?? null,
        editorParentIdentity:window.__mouseObjectIdentity?.(editor.parent) ?? null,
        receiverPageIndex:pageView.id - 1,
        receiverLayerPageIndex:layer.pageIndex,
        receiverIsCurrentLayer:manager.currentLayer === layer,
        managerCurrentPageIndex:manager.currentPageIndex,
        managerCurrentLayerPageIndex:manager.currentLayer?.pageIndex ?? null,
        sameViewport,
        bridgeUpdateWrapperInstalled:window.__mouseHasBridgeUpdateWrapper(layer.update),
        before,
        after,
      };
      window.__mouseTestMilestones.inactivePageUpdate = probe;
      return probe;
    });
    assert.equal(inactivePageUpdate.receiverPageIndex, 1, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.receiverLayerPageIndex, 1, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.receiverIsCurrentLayer, false, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.managerCurrentPageIndex, 0, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.managerCurrentLayerPageIndex, 0, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.sameViewport, true, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.bridgeUpdateWrapperInstalled, true, JSON.stringify(inactivePageUpdate));
    assert.ok(inactivePageUpdate.documentIdentity !== null, JSON.stringify(inactivePageUpdate));
    assert.ok(inactivePageUpdate.activePageViewIdentity !== null, JSON.stringify(inactivePageUpdate));
    assert.ok(inactivePageUpdate.receiverPageViewIdentity !== null, JSON.stringify(inactivePageUpdate));
    assert.ok(inactivePageUpdate.managerIdentity !== null, JSON.stringify(inactivePageUpdate));
    assert.notEqual(
      inactivePageUpdate.receiverLayerIdentity,
      inactivePageUpdate.activePageLayerIdentity,
      JSON.stringify(inactivePageUpdate),
    );
    assert.equal(
      inactivePageUpdate.editorParentIdentity,
      inactivePageUpdate.activePageLayerIdentity,
      JSON.stringify(inactivePageUpdate),
    );
    for (const field of [
      "managerOwnsEditor",
      "attached",
      "editing",
      "empty",
      "focused",
      "connected",
    ]) {
      assert.equal(inactivePageUpdate.before[field], true, `precondition ${field}: ${JSON.stringify(inactivePageUpdate)}`);
      assert.equal(inactivePageUpdate.after[field], true, `cross-page update must preserve ${field}: ${JSON.stringify(inactivePageUpdate)}`);
    }
    assert.equal(inactivePageUpdate.before.editorPageIndex, 0, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.before.parentPageIndex, 0, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.before.parentMatchesCurrentLayer, true, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.before.text, "", JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.after.editorId, inactivePageUpdate.before.editorId, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.after.identity, inactivePageUpdate.before.identity, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.after.parentIdentity, inactivePageUpdate.before.parentIdentity, JSON.stringify(inactivePageUpdate));
    assert.equal(inactivePageUpdate.after.text, "", JSON.stringify(inactivePageUpdate));
    assert.ok(inactivePageUpdate.after.bounds?.width > 0 && inactivePageUpdate.after.bounds?.height > 0, JSON.stringify(inactivePageUpdate));
    await page.keyboard.type("Mou");
    await verifySameViewportUpdate("Mou", 3, "sameViewportUpdateDuringTyping");
    await page.keyboard.type("se toolbar round trip");
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

    // PDFPageView.reset hides a retained annotation editor layer before
    // redrawing it. When the page presentation is unchanged, that hide must
    // not blur and commit a live FreeText editor from transient zero geometry.
    const pausedFreeText = await viewer.evaluate(() => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(0);
      const builder = pageView?.annotationEditorLayer;
      const pageLayer = builder?.annotationEditorLayer;
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editorElement = internal?.closest(".freeTextEditor");
      const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      const editor = editorElement && manager?.getEditor?.(editorElement.id);
      const button = document.querySelector(
        "#secondaryToolbarToggleButton",
      );
      if (!pageView || !builder || !pageLayer || !editor ||
        document.activeElement !== internal || !internal.isContentEditable || !button) {
        throw new Error("The focused FreeText must be editable before the same-presentation hide regression");
      }
      const state = {
        editorId:editor.id,
        pageIndex:editor.pageIndex,
        text:internal.textContent.replace(/\u200b/g, ""),
        scale:pageView.viewport?.scale ?? null,
        pauseCountBeforeHide:window.__mousePdfEditorLifecycleTrace
          ?.filter((entry) => entry.method === "layer.pause.begin").length ?? 0,
        resetCountBefore:window.__mousePdfEditorLifecycleTrace
          ?.filter((entry) => entry.method === "pageView.reset.begin").length ?? 0,
        hideCountBefore:window.__mousePdfEditorLifecycleTrace
          ?.filter((entry) => entry.method === "builder.hide.begin").length ?? 0,
        renderCountBeforeRedraw:window.__mousePdfEditorLifecycleTrace
          ?.filter((entry) => entry.method === "builder.render.return").length ?? 0,
      };
      // Schedule both PDF.js resume callbacks in the trusted pointerdown task,
      // before the browser's normal button focus action and before timers run.
      button.addEventListener("pointerdown", () => {
        // A queued PDF.js render can call show() and pause(false) after the
        // earlier readiness sample but before this trusted click. Start the
        // toolbar assertion window at the input boundary, not at that older
        // async render boundary.
        const pauseEntries = window.__mousePdfEditorLifecycleTrace
          .filter((entry) => entry.method === "layer.pause.begin");
        window.__mouseToolbarPauseTraceStart = pauseEntries.length;
        window.__mouseToolbarPreClickPauseEvents = pauseEntries
          .slice(state.pauseCountBeforeHide);
        const toolbarEditor = manager.getEditor(state.editorId);
        const toolbarInternal = toolbarEditor?.div?.querySelector(".internal");
        window.__mouseToolbarPointerdownState = {
          activeElementIsEditor:document.activeElement === toolbarInternal,
          editorConnected:Boolean(toolbarEditor?.div?.isConnected),
          editorSelected:Boolean(toolbarEditor?.div?.classList.contains("selectedEditor")),
          editorEditing:Boolean(toolbarEditor?.isInEditMode?.()),
          text:toolbarInternal?.textContent?.replace(/\u200b/g, "") ?? null,
          annotationStorageModified:Boolean(app._annotationStorageModified),
          hasChanges:typeof app._hasChanges === "function"
            ? Boolean(app._hasChanges())
            : null,
        };
        window.__mouseManualPauseResumeCalls.push("pause(true)");
        pageLayer.pause(true);
        window.__mouseManualPauseResumeCalls.push("show()");
        builder.show();
        window.__mouseManualPauseResumeCalls.push("show()");
        builder.show();
      }, { once:true });
      pageView.reset({
        keepAnnotationLayer:true,
        keepAnnotationEditorLayer:true,
        keepXfaLayer:true,
        keepTextLayer:true,
        keepCanvasWrapper:true,
        preserveDetailViewState:true,
      });
      const currentEditor = manager.getEditor(state.editorId);
      const currentInternal = currentEditor?.div?.querySelector(".internal");
      const rect = currentEditor?.div?.getBoundingClientRect();
      state.hiddenAfterSamePresentationHide = Boolean(builder.div?.hidden);
      state.focusPreservedAfterSamePresentationHide =
        document.activeElement === currentInternal;
      state.editingAfterSamePresentationHide = Boolean(currentInternal?.isContentEditable);
      state.editorBoundsAfterSamePresentationHide = rect
        ? { width:rect.width, height:rect.height }
        : null;
      state.pauseCallsAfterSamePresentationHide = window.__mousePdfEditorLifecycleTrace
        ?.filter((entry) => entry.method === "layer.pause.begin")
        .slice(state.pauseCountBeforeHide)
        .map((entry) => entry.callArgs?.paused ?? null) ?? [];
      state.pageResetObserved = (window.__mousePdfEditorLifecycleTrace
        ?.filter((entry) => entry.method === "pageView.reset.begin").length ?? 0) >
        state.resetCountBefore;
      state.builderHideObserved = (window.__mousePdfEditorLifecycleTrace
        ?.filter((entry) => entry.method === "builder.hide.begin").length ?? 0) >
        state.hideCountBefore;
      return state;
    });
    assert.equal(pausedFreeText.hiddenAfterSamePresentationHide, false, JSON.stringify(pausedFreeText));
    assert.equal(pausedFreeText.focusPreservedAfterSamePresentationHide, true, JSON.stringify(pausedFreeText));
    assert.equal(pausedFreeText.editingAfterSamePresentationHide, true, JSON.stringify(pausedFreeText));
    assert.ok(
      pausedFreeText.editorBoundsAfterSamePresentationHide?.width > 0 &&
        pausedFreeText.editorBoundsAfterSamePresentationHide?.height > 0,
      JSON.stringify(pausedFreeText),
    );
    assert.equal(pausedFreeText.pageResetObserved, true, JSON.stringify(pausedFreeText));
    assert.equal(pausedFreeText.builderHideObserved, true, JSON.stringify(pausedFreeText));
    assert.deepEqual(pausedFreeText.pauseCallsAfterSamePresentationHide, [], JSON.stringify(pausedFreeText));

    // Use the viewer's normal rendering queue after reset. Calling pageView.draw()
    // directly bypasses PDFRenderingQueue's highest-priority selection, so its
    // render continuation can pause indefinitely instead of completing a redraw.
    await viewer.evaluate((pageIndex) => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(pageIndex);
      if (!app?.pdfViewer || !pageView) {
        throw new Error("The reset page must remain in the active PDF viewer before it is redrawn");
      }
      app.pdfViewer.update();
    }, pausedFreeText.pageIndex);
    const redrawStateHandle = await viewer.waitForFunction((state) => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(state.pageIndex);
      const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      if (!pageView || !manager) {
        return false;
      }
      const completedBuilderRenders = window.__mousePdfEditorLifecycleTrace
        ?.filter((entry) => entry.method === "builder.render.return").length ?? 0;
      if (pageView.renderingState !== 3 ||
          completedBuilderRenders <= state.renderCountBeforeRedraw) return false;
      const afterRedrawEditor = manager.getEditor(state.editorId);
      const afterRedrawInternal = afterRedrawEditor?.div?.querySelector(".internal");
      const afterRedrawRect = afterRedrawEditor?.div?.getBoundingClientRect();
      // Capture the rendered state and focus in the same browser turn. A
      // separate evaluate can observe a new queued render (state 1) after the
      // readiness wait already observed this completed render (state 3).
      return {
        ...state,
        editingAfterRedraw:Boolean(afterRedrawInternal?.isContentEditable),
        focusPreservedAfterRedraw:document.activeElement === afterRedrawInternal,
        editorBoundsAfterRedraw:afterRedrawRect
          ? { width:afterRedrawRect.width, height:afterRedrawRect.height }
          : null,
        pageRenderingStateAfterRedraw:pageView.renderingState,
        // Separate legitimate pause(false) calls made by the queued PDF.js draw from
        // the explicit toolbar pause/resume callbacks checked below.
        pauseCountBeforeResumeProbe:window.__mousePdfEditorLifecycleTrace
          ?.filter((entry) => entry.method === "layer.pause.begin").length ?? 0,
      };
    }, { timeout:20_000 }, pausedFreeText);
    const redrawState = await redrawStateHandle.jsonValue();
    await viewer.evaluate((state) => {
      window.__mouseTestMilestones.samePresentationHide = state;
    }, redrawState);
    Object.assign(pausedFreeText, redrawState);
    assert.equal(pausedFreeText.pageRenderingStateAfterRedraw, 3, JSON.stringify(pausedFreeText));
    assert.equal(pausedFreeText.editingAfterRedraw, true, JSON.stringify(pausedFreeText));
    assert.equal(pausedFreeText.focusPreservedAfterRedraw, true, JSON.stringify(pausedFreeText));
    assert.ok(
      pausedFreeText.editorBoundsAfterRedraw?.width > 0 &&
        pausedFreeText.editorBoundsAfterRedraw?.height > 0,
      JSON.stringify(pausedFreeText),
    );
    const savesBeforeText = await page.evaluate(() => window.__host.saves.length);
    await openSecondaryToolbar();
    const resumedFreeTextHandle = await viewer.waitForFunction((pausedState) => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(pausedState.pageIndex);
      const builder = pageView?.annotationEditorLayer;
      if (!builder || !pageView?.viewport) {
        throw new Error("The annotation layer disappeared before the pause/resume probe");
      }
      // Mode/viewport refresh may enqueue another legitimate page reset after
      // toolbar focus. Capture only a completed Canvas/editor resume boundary,
      // rather than assuming two animation frames finish that async redraw.
      if (pageView.renderingState !== 3) return false;
      const lastPause = window.__mousePdfEditorLifecycleTrace
        ?.filter(entry => entry.method === "layer.pause.begin").at(-1);
      if (lastPause?.callArgs?.paused === true) return false;
      const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
      const editor = manager.getEditor(pausedState.editorId);
      const internal = editor?.div?.querySelector(".internal");
      const button = document.querySelector(
        "#secondaryToolbarToggleButton",
      );
      const snapshot = {
        visible:!builder.div?.hidden,
        toolbarFocused:document.activeElement === button,
        focusIsInEditor:Boolean(editor?.div?.contains(document.activeElement)),
        editorConnected:Boolean(editor?.div?.isConnected),
        text:internal?.textContent?.replace(/\u200b/g, "") ?? null,
        toolbarPauseTraceStart:window.__mouseToolbarPauseTraceStart ?? null,
        toolbarPointerdownState:window.__mouseToolbarPointerdownState ?? null,
        preClickPauseEvents:window.__mouseToolbarPreClickPauseEvents ?? [],
        pauseCalls:window.__mousePdfEditorLifecycleTrace
          ?.filter((entry) => entry.method === "layer.pause.begin")
          .slice(window.__mouseToolbarPauseTraceStart ?? pausedState.pauseCountBeforeResumeProbe)
          .map((entry) => entry.callArgs?.paused ?? null) ?? [],
        pauseEvents:window.__mousePdfEditorLifecycleTrace
          ?.filter((entry) => entry.method === "layer.pause.begin")
          .slice(window.__mouseToolbarPauseTraceStart ?? pausedState.pauseCountBeforeResumeProbe)
          .map((entry) => ({
            paused:entry.callArgs?.paused ?? null,
            stack:entry.stack || [],
            pageIndex:entry.pageIndex ?? null,
            pageLayerConnected:entry.pageLayerConnected === true,
            managerCurrentLayerMatchesPage:entry.managerCurrentLayerMatchesPage === true,
            activeEditor:entry.activeEditor || null,
            pageEditors:entry.pageEditors || [],
            activeElement:entry.activeElement || null,
          })) ?? [],
        manualCalls:window.__mouseManualPauseResumeCalls.slice(),
      };
      window.__mouseTestMilestones.pauseResumeToolbarFocus = snapshot;
      return snapshot;
    }, { timeout:20_000 }, pausedFreeText);
    const resumedFreeText = await resumedFreeTextHandle.jsonValue();
    assert.equal(resumedFreeText.visible, true, JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.toolbarFocused, true, JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.focusIsInEditor, false, JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.editorConnected, true, JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.text, typedFreeText.text, JSON.stringify(resumedFreeText));
    assert.ok(Number.isInteger(resumedFreeText.toolbarPauseTraceStart),
      `The pause trace boundary must be captured at trusted toolbar pointerdown: ${JSON.stringify(resumedFreeText)}`);
    assert.equal(resumedFreeText.toolbarPointerdownState?.activeElementIsEditor, true,
      JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.toolbarPointerdownState?.editorConnected, true,
      JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.toolbarPointerdownState?.editorSelected, true,
      JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.toolbarPointerdownState?.editorEditing, true,
      JSON.stringify(resumedFreeText));
    assert.equal(resumedFreeText.toolbarPointerdownState?.text, typedFreeText.text,
      JSON.stringify(resumedFreeText));
    assert.equal(typeof resumedFreeText.toolbarPointerdownState?.annotationStorageModified,
      "boolean", JSON.stringify(resumedFreeText));
    const preClickShowPauses = resumedFreeText.preClickPauseEvents.filter((event) =>
      event.callArgs?.paused === false && event.stack.some((frame) =>
        frame.includes("AnnotationEditorLayerBuilder.show"),
      ),
    );
    assert.ok(preClickShowPauses.every((event) =>
      event.activeEditor?.id === pausedFreeText.editorId &&
      event.activeEditor?.attached === true &&
      event.activeEditor?.selected === true &&
      event.activeEditor?.editing === true &&
      event.activeEditor?.empty === false &&
      event.activeElement?.editable === true,
    ), `Any pre-click builder.show pause(false) must preserve the live dirty editor: ${JSON.stringify(preClickShowPauses)}`);
    assert.deepEqual(
      resumedFreeText.pauseCalls.slice(0, 3),
      [true, false, false],
      JSON.stringify(resumedFreeText),
    );
    const explicitToolbarPause = resumedFreeText.pauseEvents[0];
    assert.equal(explicitToolbarPause?.paused, true, JSON.stringify(resumedFreeText));
    const additionalPauses = resumedFreeText.pauseEvents.slice(3);
    assert.ok(additionalPauses.every((event) => {
      if (event.paused === true) {
        return event.stack.some((frame) => frame.includes("PDFPageView.reset"));
      }
      const blurredEditor = event.activeElement?.id === 'secondaryToolbarToggleButton' &&
        event.pageEditors.filter(editor => editor.id === pausedFreeText.editorId).length === 1 &&
        event.pageEditors.find(editor => editor.id === pausedFreeText.editorId);
      const editor = event.activeEditor || blurredEditor;
      return event.paused === false &&
        event.stack.some((frame) => frame.includes("AnnotationEditorLayerBuilder.show")) &&
        event.pageIndex === pausedFreeText.pageIndex &&
        event.pageLayerConnected && event.managerCurrentLayerMatchesPage &&
        editor?.id === pausedFreeText.editorId &&
        editor?.parentPageIndex === pausedFreeText.pageIndex &&
        editor?.parentMatchesPageLayer === true &&
        editor?.attached === true && editor?.selected === true &&
        editor?.empty === false &&
        (event.activeEditor
          ? event.activeElement?.editable === (editor.editing === true)
          : event.activeElement?.editable === false && editor.editing === false && editor.text === typedFreeText.text);
    }), `Every post-toolbar pause must be either a page-reset hide or a PDF.js show that preserves this attached, selected, nonempty editor without contradicting its editability: ${JSON.stringify(resumedFreeText.pauseEvents)}`);
    assert.equal(resumedFreeText.pauseEvents.at(-1)?.paused, false,
      `Both toolbar and redraw pauses must finish with the layer resumed: ${JSON.stringify(resumedFreeText.pauseEvents)}`);
    assert.deepEqual(
      resumedFreeText.manualCalls,
      ["pause(true)", "show()", "show()"],
      JSON.stringify(resumedFreeText),
    );
    await viewer.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const afterRealEditorBlur = await viewer.evaluate(() => ({
      activeIsMoreToggleButton:
        document.activeElement === document.querySelector(
          "#secondaryToolbarToggleButton",
        ),
      editorStillActive:Boolean(document.activeElement?.closest?.(
        ".freeTextEditor .internal[contenteditable='true']",
      )),
    }));
    assert.equal(afterRealEditorBlur.activeIsMoreToggleButton, true, JSON.stringify(afterRealEditorBlur));
    assert.equal(afterRealEditorBlur.editorStillActive, false, JSON.stringify(afterRealEditorBlur));
    const lifecycleEvidence = await viewer.evaluate((typedText) => {
      const app = window.PDFViewerApplication;
      const pdfViewer = app?.pdfViewer;
      const pageView = pdfViewer?.getPageView(0);
      const builder = pageView?.annotationEditorLayer;
      const pageLayer = builder?.annotationEditorLayer;
      const manager = pdfViewer?._layerProperties?.annotationEditorUIManager;
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor .internal",
      );
      const editorElement = internal?.closest(".freeTextEditor");
      const editor = editorElement && manager?.getEditor?.(editorElement.id);
      const viewportSummary = (viewport) => viewport ? {
        rotation:viewport.rotation ?? null,
        scale:viewport.scale ?? null,
        width:viewport.width ?? null,
        height:viewport.height ?? null,
        offsetX:viewport.offsetX ?? null,
        offsetY:viewport.offsetY ?? null,
        viewBox:viewport.viewBox ? Array.from(viewport.viewBox) : null,
        transform:viewport.transform ? Array.from(viewport.transform) : null,
      } : null;
      const elementSummary = (element) => element ? {
        tag:element.tagName || "",
        id:element.id || "",
        className:typeof element.className === "string" ? element.className : "",
        hidden:Boolean(element.hidden),
        connected:Boolean(element.isConnected),
      } : null;
      return {
        capturedAt:new Date().toISOString(),
        fixture:"tests/fixtures/tracemonkey.pdf",
        documentId:"mouse-regression-document",
        typedText,
        viewerMode:pdfViewer?.annotationEditorMode ?? null,
        currentPageNumber:pdfViewer?.currentPageNumber ?? null,
        pageView:pageView ? {
          pageIndex:pageView.id - 1,
          renderingState:pageView.renderingState,
          viewport:viewportSummary(pageView.viewport),
        } : null,
        builderElement:elementSummary(builder?.div),
        editorLayer:pageLayer ? {
          viewport:viewportSummary(pageLayer.viewport),
          element:elementSummary(pageLayer.div),
        } : null,
        editor:editor ? {
          id:editor.id,
          pageIndex:editor.pageIndex,
          parentPageIndex:editor.parent?.pageIndex ?? null,
          attached:Boolean(editor.isAttachedToDOM),
          selected:Boolean(editor.div?.classList.contains("selectedEditor")),
          editing:Boolean(editor.isInEditMode?.()),
          empty:Boolean(editor.isEmpty?.()),
          text:internal?.textContent?.replace(/\u200b/g, "") ?? null,
        } : null,
        activeElement:elementSummary(document.activeElement),
        focusEvents:window.__keyboardFocusEvents
          .filter((event) => event.type === "focusout" || event.type === "focusin")
          .slice(-96),
        modeActivationTraceState:window.__mouseModeActivationTraceState || null,
        modeActivationTrace:window.__mouseModeActivationTrace?.slice(-96) || [],
        lifecycleTraceState:window.__mousePdfEditorLifecycleTraceState || null,
        lifecycleTrace:window.__mousePdfEditorLifecycleTrace?.slice(-224) || [],
        milestones:{
          rotationBeforeFreeTextCreation:
            window.__mouseTestMilestones.rotationBeforeFreeTextCreation ?? null,
          pageBeforeFreeTextCreation:
            window.__mouseTestMilestones.pageBeforeFreeTextCreation ?? null,
          inactivePagePrepared:
            window.__mouseTestMilestones.inactivePagePrepared ?? null,
          beforeFirstFreeTextClick:
            window.__mouseTestMilestones.beforeFirstFreeTextClick ?? null,
          pauseResumeToolbarFocus:
            window.__mouseTestMilestones.pauseResumeToolbarFocus ?? null,
          modeActivationBeforeTyping:
            window.__mouseTestMilestones.modeActivationBeforeTyping ?? null,
          focusBeforeTyping:
            window.__mouseTestMilestones.focusBeforeTyping ?? null,
          deferredMoveProbe:
            window.__mouseTestMilestones.deferredMoveProbe ?? null,
          sameViewportUpdateBeforeTyping:
            window.__mouseTestMilestones.sameViewportUpdateBeforeTyping ?? null,
          sameViewportUpdateDuringTyping:
            window.__mouseTestMilestones.sameViewportUpdateDuringTyping ?? null,
          inactivePageUpdate:
            window.__mouseTestMilestones.inactivePageUpdate ?? null,
          manualPauseResumeCalls:
            window.__mouseManualPauseResumeCalls?.slice() ?? [],
        },
      };
    }, typedFreeText.text);
    const lifecyclePath = path.join(artifactsPath, `mouse-input-${artifactId}.lifecycle.json`);
    await writeFile(lifecyclePath, JSON.stringify(lifecycleEvidence, null, 2), "utf8");
    t.diagnostic(`Mouse lifecycle trace: ${lifecyclePath}`);
    await viewer.evaluate(() => window.__stopMousePdfEditorLifecycleTrace?.());
    await clickAction("save");
    // Save commits the focused FreeText before the bridge returns serialized
    // bytes. Reopen those bytes so the following probe exercises PDF.js's
    // trusted double-click edit path for an existing FreeText annotation.
    await page.waitForFunction(
      (count) => window.__host.saves.length > count,
      { timeout:20_000 },
      savesBeforeText,
    );
    const opensBeforeTextReopen = await page.evaluate(() => window.__host.opened);
    await viewer.evaluate(() => {
      const app = PDFViewerApplication;
      const trace = window.__savedFreeTextRenderEvents = [];
      const eventNames = [
        "pagesinit",
        "documentloaded",
        "pagerender",
        "pagerendered",
        "annotationlayerrendered",
        "annotationeditorlayerrendered",
        "updateviewarea",
      ];
      for (const name of eventNames) {
        app.eventBus.on(name, (event) => {
          const pageNumber = Number.isInteger(event.pageNumber)
            ? event.pageNumber
            : app.pdfViewer.currentPageNumber;
          const pageView = app.pdfViewer.getPageView(pageNumber - 1);
          const page = pageView?.div;
          const annotationLayer = pageView?.annotationLayer?.div ||
            page?.querySelector(".annotationLayer") || null;
          const annotationNodes = [...(annotationLayer?.querySelectorAll?.(
            "[data-annotation-id]",
          ) || [])];
          const target = window.__mouseTestMilestones?.savedFreeTextAnnotationId;
          const sidecarTarget = target
            ? window.__getSidecarFreeTextEditor(target)
            : null;
          const rect = (element) => {
            if (!element) return null;
            const bounds = element.getBoundingClientRect();
            return {
              x:bounds.x,
              y:bounds.y,
              width:bounds.width,
              height:bounds.height,
              connected:element.isConnected,
            };
          };
          let visiblePageIds = [];
          try {
            visiblePageIds = app.pdfViewer._getVisiblePages().views.map(({ id }) => id);
          } catch {}
          trace.push({
            type:name,
            time:performance.now(),
            pageNumber,
            error:event.error?.message || null,
            pageViewPageNumber:pageView?.pdfPage?.pageNumber ?? null,
            renderingId:pageView?.renderingId ?? null,
            renderingState:pageView?.renderingState ?? null,
            pageBounds:rect(page),
            visiblePageIds,
            viewerScrollTop:document.getElementById("viewerContainer")?.scrollTop ?? null,
            annotationLayer:{
              builderPresent:Boolean(pageView?.annotationLayer),
              divPresent:Boolean(annotationLayer),
              bounds:rect(annotationLayer),
              childCount:annotationLayer?.childElementCount ?? null,
              annotationNodeCount:annotationNodes.length,
              annotationNodes:annotationNodes.slice(0, 16).map((element) => ({
                id:element.getAttribute("data-annotation-id"),
                className:typeof element.className === "string" ? element.className : "",
              })),
              targetPresent:target
                ? annotationNodes.some((element) =>
                    element.getAttribute("data-annotation-id") === target)
                : null,
              sidecarTargetPresent:Boolean(sidecarTarget),
              sidecarTargetBounds:rect(sidecarTarget),
            },
          });
          if (trace.length > 96) trace.splice(0, trace.length - 96);
        });
      }
    });
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
    const savedFreeText = await page.evaluate(() => {
      const operations = window.__browserSidecarHost.operationsFor(
        "mouse-regression-document",
      );
      const operation = operations.find((row) =>
        row.kind === "FreeText" && row.deleted !== true,
      );
      return operation ? { id:operation.uuid, operation } : null;
    });
    assert.ok(savedFreeText?.id,
      "The saved FreeText must exist as a durable sidecar operation after source-PDF reopen");
    await viewer.evaluate((uuid) => {
      window.__mouseTestMilestones.savedFreeTextAnnotationId = uuid;
    }, savedFreeText.id);
    const freeTextModeAfterReopen = await viewer.evaluate(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode,
    );
    if (freeTextModeAfterReopen === 3) {
      // A persisted sidecar editor may reopen with its creation tool selected;
      // return to selection mode before exercising trusted pointer editing.
      const completedModeChanges = await viewer.evaluate(() =>
        window.__mouseModeActivationTrace?.filter((entry) =>
          entry.method === "event.annotationeditormodechanged" &&
          entry.requestedMode === 0,
        ).length ?? 0,
      );
      await click("#editorFreeTextButton");
      await viewer.waitForFunction((previousCount) => {
        const trace = window.__mouseModeActivationTrace || [];
        const completed = trace.filter((entry) =>
          entry.method === "event.annotationeditormodechanged" &&
          entry.requestedMode === 0,
        ).length;
        return PDFViewerApplication.pdfViewer.annotationEditorMode === 0 &&
          completed > previousCount &&
          (window.__mouseModeUpdatesPending || 0) === 0;
      }, { timeout:10_000 }, completedModeChanges);
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
        const target = window.__getSidecarFreeTextEditor(annotationId);
        return pageView?.renderingState === 3 && page?.dataset.loaded === "true" &&
          target?.isConnected;
      },
      { timeout:20_000 },
      savedFreeText.id,
    );
    const reopenedFreeText = await viewer.evaluate((annotationId) => {
      const app = window.PDFViewerApplication;
      const pageView = PDFViewerApplication.pdfViewer.getPageView(0);
      const editor = window.__getSidecarFreeTextEditor(annotationId);
      const internal = editor?.querySelector(".internal");
      const liveEditor = editor && app.pdfViewer._layerProperties.annotationEditorUIManager
        .getEditor(editor.id);
      const rect = editor?.getBoundingClientRect();
      return {
        pageNumber:pageView?.pdfPage?.pageNumber ?? null,
        runtimeId:editor?.id ?? null,
        rect:rect ? { x:rect.x, y:rect.y, width:rect.width, height:rect.height } : null,
        width:rect?.width ?? 0,
        height:rect?.height ?? 0,
        // PDF.js maps ordinary spaces to NBSP in its editable DOM to preserve
        // layout, then maps them back during FreeTextEditor.serialize().
        // Compare the rendered text semantically and verify the exact durable
        // representation separately.
        text:internal?.textContent?.replace(/\u200b/g, "").replace(/\u00a0/g, " ").trim() ?? "",
        serializedText:liveEditor?.serialize?.(false)?.value ?? null,
        visible:!!rect && getComputedStyle(editor).display !== "none" &&
          getComputedStyle(editor).visibility !== "hidden" &&
          Number(getComputedStyle(editor).opacity) > 0,
      };
    }, savedFreeText.id);
    assert.ok(
      reopenedFreeText.width > 0 && reopenedFreeText.height > 0,
      `The saved FreeText must reopen with nonzero editor geometry: ${JSON.stringify(reopenedFreeText)}`,
    );
    assert.equal(reopenedFreeText.text, "Mouse toolbar round trip");
    assert.equal(reopenedFreeText.serializedText, "Mouse toolbar round trip");
    assert.equal(reopenedFreeText.visible, true, JSON.stringify(reopenedFreeText));
    // Reopening restores the PDF's initial scroll position. Bring the exact
    // persisted sidecar editor back into view with normal DOM scrolling before
    // checking that a real browser pointer can hit it.
    await viewer.evaluate((annotationId) => {
      const target = window.__getSidecarFreeTextEditor(annotationId);
      target?.scrollIntoView({ block:"center", inline:"center", behavior:"auto" });
    }, savedFreeText.id);
    const reopenedAnnotationPoint = await viewer.waitForFunction(
      (annotationId) => {
        const target = window.__getSidecarFreeTextEditor(annotationId);
        if (!target) return false;
        const rect = target.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const viewerRect = document.getElementById("viewerContainer")?.getBoundingClientRect();
        const hit = document.elementFromPoint(x, y);
        if (!(rect.width > 0 && rect.height > 0 && viewerRect &&
          x >= Math.max(0, viewerRect.left) && x < Math.min(window.innerWidth, viewerRect.right) &&
          y >= Math.max(0, viewerRect.top) && y < Math.min(window.innerHeight, viewerRect.bottom) &&
          hit?.closest(".freeTextEditor") === target)) {
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
      `The saved FreeText pointer interaction should remain inside the visible PDF iframe: ${JSON.stringify(outerTextHit)}`,
    );
    await page.mouse.click(reopenedTextPoint.x, reopenedTextPoint.y);
    const selectedReopenedFreeText = await viewer.waitForFunction((annotationId) => {
      const editor = window.__getSidecarFreeTextEditor(annotationId);
      return editor?.classList.contains("selectedEditor") &&
        window.__mouseBridgeState.annotationUuidByRuntimeId.get(String(editor.id)) === annotationId;
    }, { timeout:10_000 }, savedFreeText.id);
    assert.ok(selectedReopenedFreeText, "A single click must select the persisted FreeText without losing its identity");
    // PDF.js enters text-edit mode for a committed FreeText editor on a
    // double-click; this second trusted click completes the first click's pair.
    await page.mouse.click(reopenedTextPoint.x, reopenedTextPoint.y, { count:2, delay:80 });
    await viewer.waitForFunction((annotationId) => {
      const editor = window.__getSidecarFreeTextEditor(annotationId);
      const internal = editor?.querySelector(".internal");
      return PDFViewerApplication.pdfViewer.annotationEditorMode === 3 &&
        internal?.isContentEditable && document.activeElement === internal &&
        editor?.classList.contains("selectedEditor") &&
        window.__mouseBridgeState.annotationUuidByRuntimeId.get(String(editor.id)) === annotationId &&
        (() => {
          const rect = internal.getBoundingClientRect();
          const hit = document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          );
          return hit?.closest("[contenteditable]:not([contenteditable=false])") === internal;
        })();
    }, { timeout:10_000 }, savedFreeText.id);
    const editedSidecarEditorCount = await viewer.evaluate(() =>
      document.querySelectorAll(".annotationEditorLayer .freeTextEditor").length,
    );
    assert.equal(editedSidecarEditorCount, 1,
      "Double-clicking a persisted sidecar FreeText must edit the same editor, not create a duplicate");
    const focusedBeforeZoom = await viewer.evaluate(() => {
      const app = window.PDFViewerApplication;
      const pageView = app.pdfViewer.getPageView(0);
      const layer = pageView.annotationEditorLayer?.annotationEditorLayer;
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editorElement = internal?.closest(".freeTextEditor");
      const editor = editorElement &&
        app.pdfViewer._layerProperties.annotationEditorUIManager.getEditor(editorElement.id);
      if (!layer || !editor || document.activeElement !== internal ||
        !internal?.isContentEditable) {
        throw new Error("The reopened annotation must be explicitly editable before zoom");
      }
      return {
        editorId:editor.id,
        scale:pageView.viewport.scale,
        pageViewport:{
          transform:Array.from(pageView.viewport.transform || []),
          width:pageView.viewport.width,
          height:pageView.viewport.height,
        },
        layerViewport:{
          scale:layer.viewport?.scale ?? null,
          transform:Array.from(layer.viewport?.transform || []),
          width:layer.viewport?.width ?? null,
          height:layer.viewport?.height ?? null,
        },
      };
    });
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer.updateScale({ scaleFactor:1.05, drawingDelay:0 });
    });
    await viewer.waitForFunction((previousScale) => {
      const app = window.PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(0);
      const layer = pageView?.annotationEditorLayer?.annotationEditorLayer;
      return pageView?.renderingState === 3 && pageView.viewport?.scale > previousScale &&
        layer?.viewport?.scale === pageView.viewport.scale;
    }, { timeout:20_000 }, focusedBeforeZoom.scale);
    const zoomedFreeText = await viewer.evaluate(({ annotationId, before }) => {
      const app = window.PDFViewerApplication;
      const pageView = app.pdfViewer.getPageView(0);
      const layer = pageView.annotationEditorLayer?.annotationEditorLayer;
      const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
      const editorDiv = window.__getSidecarFreeTextEditor(annotationId);
      const editor = editorDiv ? manager.getEditor(editorDiv.id) : null;
      const internal = editor?.div?.querySelector(".internal");
      const rect = editor?.div?.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      const sameTransform = (left, right) =>
        left?.length === right?.length && left.every((value, index) =>
          Object.is(value, right[index]));
      return {
        pageScale:pageView.viewport.scale,
        pageTransform:Array.from(pageView.viewport.transform || []),
        layerScale:layer?.viewport?.scale ?? null,
        layerTransform:Array.from(layer?.viewport?.transform || []),
        pageDimensions:[pageView.viewport.width, pageView.viewport.height],
        layerDimensions:[layer?.viewport?.width ?? null, layer?.viewport?.height ?? null],
        transformChanged:!sameTransform(
          before.pageViewport.transform,
          pageView.viewport.transform,
        ),
        editorConnected:Boolean(editor?.div?.isConnected),
        editorBounds:rect ? { x:rect.x, y:rect.y, width:rect.width, height:rect.height } : null,
        editorHit:Boolean(editor?.div?.contains(hit)),
        text:internal?.textContent?.replace(/\u200b/g, "").replace(/\u00a0/g, " ") ?? null,
        editing:Boolean(internal?.isContentEditable),
        active:document.activeElement === internal,
      };
    }, { annotationId:savedFreeText.id, before:focusedBeforeZoom });
    assert.ok(zoomedFreeText.pageScale > focusedBeforeZoom.scale, JSON.stringify(zoomedFreeText));
    assert.equal(zoomedFreeText.layerScale, zoomedFreeText.pageScale, JSON.stringify(zoomedFreeText));
    assert.equal(zoomedFreeText.transformChanged, true, JSON.stringify(zoomedFreeText));
    assert.deepEqual(
      zoomedFreeText.layerDimensions,
      zoomedFreeText.pageDimensions,
      JSON.stringify(zoomedFreeText),
    );
    assert.equal(zoomedFreeText.editorConnected, true, JSON.stringify(zoomedFreeText));
    assert.equal(zoomedFreeText.editorHit, true, JSON.stringify(zoomedFreeText));
    assert.equal(zoomedFreeText.text, "Mouse toolbar round trip", JSON.stringify(zoomedFreeText));
    if (!zoomedFreeText.editing || !zoomedFreeText.active) {
      const refreshedPoint = await viewer.evaluate((annotationId) => {
        const app = window.PDFViewerApplication;
        const editor = window.__getSidecarFreeTextEditor(annotationId);
        const rect = editor?.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) {
          throw new Error("The zoomed sidecar FreeText has no pointer hit area");
        }
        return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
      }, savedFreeText.id);
      const frameOffset = await iframeOffset();
      await page.mouse.click(frameOffset.x + refreshedPoint.x, frameOffset.y + refreshedPoint.y, {
        count:2,
        delay:80,
      });
      await viewer.waitForFunction((annotationId) => {
        const internal = window.__getSidecarFreeTextEditor(annotationId)
          ?.querySelector(".internal");
        return internal?.isContentEditable && document.activeElement === internal;
      }, { timeout:10_000 }, savedFreeText.id);
    }
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
    const saveStateAfterTextRightClick = await viewer.evaluate(() => ({
      disabled:document.getElementById("secondaryDownload")?.disabled ?? null,
      editorCount:document.querySelectorAll(".annotationEditorLayer .freeTextEditor").length,
      editorText:window.__getSidecarFreeTextEditor(
        window.__mouseTestMilestones.savedFreeTextAnnotationId,
      )?.querySelector(".internal")?.textContent?.replace(/\u200b/g, "").replace(/\u00a0/g, " ") ?? null,
    }));
    assert.equal(saveStateAfterTextRightClick.disabled, true,
      "A context-menu-only interaction must not mark the unchanged sidecar annotation dirty");
    assert.equal(saveStateAfterTextRightClick.editorCount, 1,
      "Right-click must not create an extra FreeText editor");
    assert.equal(saveStateAfterTextRightClick.editorText, "Mouse toolbar round trip");
    await clickAction("save");
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      savesAfterTextRightClick,
      "A disabled no-op Save must not append a redundant sidecar batch",
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

    // Re-enter the saved annotation, cache its focused contenteditable with
    // PDF.js pause(true), then move focus to a real input in the host document.
    // Rendering the same page twice schedules PDF.js's delayed focus callback
    // while the iframe is unfocused; it must not steal host-window focus.
    const externalFocusPoint = await viewer.evaluate((annotationId) => {
      const app = window.PDFViewerApplication;
      const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
      const editorDiv = window.__getSidecarFreeTextEditor(annotationId);
      const editor = editorDiv ? manager.getEditor(editorDiv.id) : null;
      const rect = editorDiv?.getBoundingClientRect();
      if (!editor || !rect || rect.width <= 0 || rect.height <= 0) {
        throw new Error("The saved FreeText must remain visible before host-window focus testing");
      }
      return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
    }, savedFreeText.id);
    const externalFocusFrameOffset = await iframeOffset();
    await page.mouse.click(
      externalFocusFrameOffset.x + externalFocusPoint.x,
      externalFocusFrameOffset.y + externalFocusPoint.y,
      { count:2, delay:80 },
    );
    await viewer.waitForFunction((annotationId) => {
      const app = window.PDFViewerApplication;
      const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
      const editor = window.__getSidecarFreeTextEditor(annotationId);
      const internal = editor?.querySelector(".internal");
      return internal?.isContentEditable && document.activeElement === internal &&
        editor && manager.getEditor(editor.id) && document.hasFocus() &&
        window.top.document.activeElement === window.frameElement;
    }, { timeout:10_000 }, savedFreeText.id);
    const pauseBeforeHostFocus = await viewer.evaluate(async (annotationId) => {
      const app = window.PDFViewerApplication;
      const pdfViewer = app.pdfViewer;
      const pageView = app.pdfViewer.getPageView(0);
      const builder = pageView.annotationEditorLayer;
      const builderLayer = builder.annotationEditorLayer;
      const manager = pdfViewer._layerProperties.annotationEditorUIManager;
      const editorDiv = window.__getSidecarFreeTextEditor(annotationId);
      const editor = editorDiv ? manager.getEditor(editorDiv.id) : null;
      const internal = editor?.div?.querySelector(".internal");
      if (!editor || !internal?.isContentEditable || document.activeElement !== internal) {
        throw new Error("The saved FreeText must be actively editable before host focus moves");
      }
      const activeLayer = editor.parent;
      const editorOwnership = {
        editorId:editor.id,
        editorPageIndex:editor.pageIndex,
        parentPageIndex:activeLayer?.pageIndex ?? null,
        managerCurrentLayerMatchesEditor:Boolean(manager.currentLayer === activeLayer),
        builderLayerMatchesEditor:Boolean(builderLayer === activeLayer),
        activeLayerConnected:Boolean(activeLayer?.div?.isConnected),
        activeLayerContainsEditor:Boolean(activeLayer?.div?.contains(editor.div)),
        editorAttached:Boolean(editor.isAttachedToDOM),
        editorConnected:Boolean(editor.div?.isConnected),
        currentPageViewMatches:Boolean(pdfViewer.getPageView(0) === pageView),
        pageViewPageNumber:pageView.pdfPage?.pageNumber ?? null,
        documentFingerprint:app.pdfDocument?.fingerprints?.[0] ?? null,
      };
      if (activeLayer?.pageIndex !== 0 || manager.currentLayer !== activeLayer ||
        builderLayer !== activeLayer ||
        !activeLayer.div?.isConnected || !activeLayer.div.contains(editor.div) ||
        !editor.isAttachedToDOM || !editor.div?.isConnected ||
        manager.getEditor(editor.id) !== editor || pdfViewer.getPageView(0) !== pageView ||
        pageView.pdfPage?.pageNumber !== 1) {
        throw new Error(`The focused FreeText is not owned by the current document/page: ${JSON.stringify(editorOwnership)}`);
      }
      const layerTraceIdentity = window.__mouseInstrumentPageLayer(pageView, builder, activeLayer);
      const pauseCountBefore = window.__mousePdfEditorLifecycleTrace
        ?.filter((entry) => entry.method === "layer.pause.begin" &&
          entry.receiverIdentity === layerTraceIdentity.pageLayerIdentity).length ?? 0;
      window.__mouseHostFocusIdentityRefs = {
        app,
        pdfDocument:app.pdfDocument,
        pdfViewer,
        pageView,
        builder,
        builderLayer,
        manager,
        activeLayer,
        editor,
      };
      const observedPauseCalls = [];
      const originalPause = activeLayer.pause;
      const observedPauseIdentity = {
        documentIdentity:layerTraceIdentity.documentIdentity,
        pageViewIdentity:layerTraceIdentity.pageViewIdentity,
        layerIdentity:layerTraceIdentity.pageLayerIdentity,
      };
      const observedPause = function (paused, ...args) {
        observedPauseCalls.push({
          paused:Boolean(paused),
          receiverMatches:this === activeLayer,
          time:Math.round(performance.now()),
          ...observedPauseIdentity,
        });
        return originalPause.apply(this, [paused, ...args]);
      };
      activeLayer.pause = observedPause;
      window.__mouseHostFocusPauseProbe = {
        activeLayer,
        originalPause,
        observedPause,
        calls:observedPauseCalls,
      };
      activeLayer.pause(true);
      return { editorId:editor.id, pauseCountBefore, layerTraceIdentity, editorOwnership };
    }, savedFreeText.id);
    const externalInput = await page.evaluate(() => {
      const previous = document.getElementById("mouse-external-focus-probe");
      previous?.remove();
      const input = document.createElement("input");
      input.id = "mouse-external-focus-probe";
      input.type = "text";
      input.autocomplete = "off";
      input.setAttribute("aria-label", "Mouse regression external focus target");
      input.style.cssText = "position:fixed;left:12px;top:12px;width:240px;height:28px;z-index:2147483647";
      document.body.append(input);
      const rect = input.getBoundingClientRect();
      return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
    });
    await page.mouse.click(externalInput.x, externalInput.y);
    await page.waitForFunction(
      () => document.activeElement?.id === "mouse-external-focus-probe",
      { timeout:5_000 },
    );
    const hostFocusAfterResume = await viewer.evaluate(async (pauseState) => {
      const app = window.PDFViewerApplication;
      const refs = window.__mouseHostFocusIdentityRefs;
      const pdfViewer = app.pdfViewer;
      const pageView = pdfViewer.getPageView(0);
      const builder = pageView.annotationEditorLayer;
      const manager = pdfViewer._layerProperties.annotationEditorUIManager;
      const editor = manager.getEditor(pauseState.editorId);
      const activeLayer = editor?.parent;
      const currentTraceIdentity = window.__mouseInstrumentPageLayer(
        pageView,
        builder,
        activeLayer,
      );
      builder.show();
      builder.show();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const pauseProbe = window.__mouseHostFocusPauseProbe;
      const observedPauseCalls = pauseProbe?.calls?.map((entry) => ({ ...entry })) ?? [];
      if (pauseProbe?.activeLayer?.pause === pauseProbe.observedPause) {
        pauseProbe.activeLayer.pause = pauseProbe.originalPause;
      }
      delete window.__mouseHostFocusPauseProbe;
      const pauseEntries = window.__mousePdfEditorLifecycleTrace
        ?.filter((entry) => entry.method === "layer.pause.begin" &&
          entry.receiverIdentity === pauseState.layerTraceIdentity.pageLayerIdentity) ?? [];
      return {
        frameHasFocus:document.hasFocus(),
        frameActiveElement:document.activeElement?.id || document.activeElement?.className || "",
        hostActiveElementId:window.top.document.activeElement?.id || "",
        editorConnected:Boolean(editor?.div?.isConnected),
        text:editor?.div?.querySelector(".internal")?.textContent
          ?.replace(/\u200b/g, "").replace(/\u00a0/g, " ") ?? null,
        editorOwnership:pauseState.editorOwnership,
        traceIdentity:{
          before:pauseState.layerTraceIdentity,
          after:currentTraceIdentity,
        },
        currentOwnership:{
          sameApp:app === refs.app,
          sameDocument:app.pdfDocument === refs.pdfDocument,
          samePdfViewer:pdfViewer === refs.pdfViewer,
          samePageView:pageView === refs.pageView,
          sameBuilder:builder === refs.builder,
          sameBuilderLayer:builder.annotationEditorLayer === refs.builderLayer,
          builderLayerMatchesActiveLayer:builder.annotationEditorLayer === activeLayer,
          sameManager:manager === refs.manager,
          sameActiveLayer:activeLayer === refs.activeLayer,
          managerCurrentLayerMatchesEditor:Boolean(manager.currentLayer === editor?.parent),
          editorParentMatchesManagerCurrentLayer:Boolean(editor?.parent === manager.currentLayer),
          editorMatchesOriginal:Boolean(editor === refs.editor),
          sameTraceDocument:currentTraceIdentity.documentIdentity ===
            pauseState.layerTraceIdentity.documentIdentity,
          sameTracePageView:currentTraceIdentity.pageViewIdentity ===
            pauseState.layerTraceIdentity.pageViewIdentity,
          sameTraceBuilder:currentTraceIdentity.builderIdentity ===
            pauseState.layerTraceIdentity.builderIdentity,
          sameTraceManager:currentTraceIdentity.managerIdentity ===
            pauseState.layerTraceIdentity.managerIdentity,
          sameTraceLayer:currentTraceIdentity.pageLayerIdentity ===
            pauseState.layerTraceIdentity.pageLayerIdentity,
          editorAttached:Boolean(editor?.isAttachedToDOM),
          activeLayerContainsEditor:Boolean(activeLayer?.div?.contains(editor?.div)),
          pageViewPageNumber:pageView.pdfPage?.pageNumber ?? null,
          documentFingerprint:app.pdfDocument?.fingerprints?.[0] ?? null,
        },
        pauseCalls:observedPauseCalls.map((entry) => entry.paused),
        observedPauseCalls,
        pauseTraceDiagnostics:{
          baseline:pauseState.pauseCountBefore,
          finalCount:pauseEntries.length,
          layerIdentity:pauseState.layerTraceIdentity.pageLayerIdentity,
          events:pauseEntries.map((entry) => ({
            time:entry.time,
            paused:entry.callArgs?.paused ?? null,
            documentIdentity:entry.documentIdentity,
            pageViewIdentity:entry.pageViewIdentity,
            pageLayerIdentity:entry.pageLayerIdentity,
          })),
        },
      };
    }, pauseBeforeHostFocus);
    await viewer.evaluate((snapshot) => {
      window.__mouseTestMilestones.hostWindowFocusAfterResume = snapshot;
    }, hostFocusAfterResume);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 60)));
    const hostFocusTargetStillActive = await page.evaluate(
      () => document.activeElement?.id === "mouse-external-focus-probe",
    );
    assert.deepEqual(hostFocusAfterResume.pauseCalls, [true, false, false], JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.frameHasFocus, false, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameDocument, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameApp, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.samePdfViewer, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.samePageView, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameManager, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameActiveLayer, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameTraceDocument, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameTracePageView, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameTraceBuilder, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameTraceManager, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.sameTraceLayer, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.builderLayerMatchesActiveLayer, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.managerCurrentLayerMatchesEditor, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.editorParentMatchesManagerCurrentLayer, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.currentOwnership.editorMatchesOriginal, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.hostActiveElementId, "mouse-external-focus-probe", JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.editorConnected, true, JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusAfterResume.text, "Mouse toolbar round trip", JSON.stringify(hostFocusAfterResume));
    assert.equal(hostFocusTargetStillActive, true, JSON.stringify(hostFocusAfterResume));
    await page.evaluate(() => document.getElementById("mouse-external-focus-probe")?.remove());

    const opensBeforeZoomedSaveReopen = await page.evaluate(() => window.__host.opened);
    await page.evaluate(() => window.__host.reopenSaved());
    await page.waitForFunction(
      (count) => window.__host.opened === count + 1,
      { timeout:20_000 },
      opensBeforeZoomedSaveReopen,
    );
    await viewer.waitForSelector(
      '.page[data-page-number="1"] .textLayer span',
      { timeout:20_000 },
    );
    await viewer.waitForFunction(
      (uuid) => {
        const app = window.PDFViewerApplication;
        const pageView = app?.pdfViewer?.getPageView(0);
        return pageView?.renderingState === 3 && pageView.pdfPage?.pageNumber === 1 &&
          window.__getSidecarFreeTextEditor(uuid)?.isConnected;
      },
      { timeout:20_000 },
      savedFreeText.id,
    );
    const zoomedSavedAnnotation = await viewer.evaluate(async (annotationId) => {
      const app = window.PDFViewerApplication;
      const pageView = app.pdfViewer.getPageView(0);
      const target = window.__getSidecarFreeTextEditor(annotationId);
      const editor = target && app.pdfViewer._layerProperties.annotationEditorUIManager
        .getEditor(target.id);
      target?.scrollIntoView({ block:"center", inline:"center", behavior:"auto" });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = target?.getBoundingClientRect();
      const x = rect ? rect.left + rect.width / 2 : NaN;
      const y = rect ? rect.top + rect.height / 2 : NaN;
      const hit = Number.isFinite(x) && Number.isFinite(y)
        ? document.elementFromPoint(x, y)
        : null;
      const viewerRect = document.getElementById("viewerContainer")?.getBoundingClientRect();
      return {
        documentFingerprint:app.pdfDocument?.fingerprints?.[0] ?? null,
        pageNumber:pageView.pdfPage?.pageNumber ?? null,
        pageRenderingState:pageView.renderingState,
        pageScale:pageView.viewport?.scale ?? null,
        sidecarRect:editor?.serialize?.(false)?.rect ?? null,
        pdfWidth:rect?.width ?? 0,
        pdfHeight:rect?.height ?? 0,
        annotationConnected:Boolean(target?.isConnected),
        annotationBounds:rect
          ? { x:rect.x, y:rect.y, width:rect.width, height:rect.height }
          : null,
        center:{ x, y },
        insideViewer:Boolean(viewerRect && x >= Math.max(viewerRect.left, 0) &&
          x < Math.min(viewerRect.right, window.innerWidth) &&
          y >= Math.max(viewerRect.top, 0) && y < Math.min(viewerRect.bottom, window.innerHeight)),
        hitTarget:Boolean(target && hit?.closest(".freeTextEditor") === target),
      };
    }, savedFreeText.id);
    assert.ok(
      zoomedSavedAnnotation.pdfWidth > 0 && zoomedSavedAnnotation.pdfHeight > 0,
      `The saved FreeText must retain nonzero PDF geometry after zoom and reopen: ${JSON.stringify(zoomedSavedAnnotation)}`,
    );
    assert.ok(
      zoomedSavedAnnotation.annotationBounds?.width > 0 &&
        zoomedSavedAnnotation.annotationBounds?.height > 0,
      JSON.stringify(zoomedSavedAnnotation),
    );
    assert.equal(zoomedSavedAnnotation.annotationConnected, true, JSON.stringify(zoomedSavedAnnotation));
    assert.equal(zoomedSavedAnnotation.insideViewer, true, JSON.stringify(zoomedSavedAnnotation));
    assert.equal(zoomedSavedAnnotation.hitTarget, true, JSON.stringify(zoomedSavedAnnotation));

    // The cross-page no-op guard must stop applying once the active page has
    // a real new PageViewport that its editor layer has not adopted yet. Stage
    // that ordering directly, then send an unchanged update to page 2. The
    // original PDF.js update must still run and reach its shared commit path.
    await viewer.waitForFunction(() => {
      const pageView = window.PDFViewerApplication?.pdfViewer?.getPageView(1);
      const layer = pageView?.annotationEditorLayer?.annotationEditorLayer;
      return Boolean(
        pageView?.renderingState === 3 && layer?.viewport && layer.div?.isConnected,
      );
    }, { timeout:20_000 });
    const reopenEditPoint = await viewer.evaluate((annotationId) => {
      const target = window.__getSidecarFreeTextEditor(annotationId);
      target?.scrollIntoView({ block:"center", inline:"center", behavior:"auto" });
      const rect = target?.getBoundingClientRect();
      if (!rect || rect.width <= 0 || rect.height <= 0) {
        throw new Error("The reopened sidecar FreeText must have a hit area for the viewport-change probe");
      }
      return { x:rect.left + rect.width / 2, y:rect.top + rect.height / 2 };
    }, savedFreeText.id);
    const reopenEditFrameOffset = await iframeOffset();
    const reopenEditScreenPoint = {
      x:reopenEditFrameOffset.x + reopenEditPoint.x,
      y:reopenEditFrameOffset.y + reopenEditPoint.y,
    };
    await page.mouse.click(
      reopenEditScreenPoint.x,
      reopenEditScreenPoint.y,
    );
    await viewer.waitForFunction((annotationId) => {
      const editor = window.__getSidecarFreeTextEditor(annotationId);
      return editor?.classList.contains("selectedEditor") &&
        window.__mouseBridgeState.annotationUuidByRuntimeId.get(String(editor.id)) === annotationId;
    }, { timeout:10_000 }, savedFreeText.id);
    // The second trusted click must reopen the same persisted editor in edit
    // mode before the cross-page viewport update is exercised.
    await page.mouse.click(
      reopenEditScreenPoint.x,
      reopenEditScreenPoint.y,
      { count:2, delay:80 },
    );
    await viewer.waitForFunction((annotationId) => {
      const app = window.PDFViewerApplication;
      const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      const internal = document.querySelector(
        ".annotationEditorLayer .freeTextEditor.selectedEditor .internal",
      );
      const editor = internal?.closest(".freeTextEditor");
      return editor && window.__mouseBridgeState.annotationUuidByRuntimeId
        .get(String(editor.id)) === annotationId &&
        internal?.isContentEditable && document.activeElement === internal &&
        manager?.getEditor?.(editor.id)?.isInEditMode?.();
    }, { timeout:10_000 }, savedFreeText.id);
    const crossPageViewportChange = await viewer.evaluate((annotationId) => {
      const app = window.PDFViewerApplication;
      const pdfViewer = app?.pdfViewer;
      const manager = pdfViewer?._layerProperties?.annotationEditorUIManager;
      const activePageView = pdfViewer?.getPageView(0);
      const activeLayer = activePageView?.annotationEditorLayer?.annotationEditorLayer;
      const receiverPageView = pdfViewer?.getPageView(1);
      const receiverLayer = receiverPageView?.annotationEditorLayer?.annotationEditorLayer;
      const activeInternal = document.activeElement;
      const activeElement = activeInternal instanceof Element
        ? activeInternal.closest(".freeTextEditor")
        : null;
      const editor = activeElement && manager?.getEditor?.(activeElement.id);
      const bridgeWrapperInspectorAvailable =
        typeof window.__mouseHasBridgeUpdateWrapper === "function";
      const bridgeUpdateWrapped = Boolean(
        bridgeWrapperInspectorAvailable &&
        window.__mouseHasBridgeUpdateWrapper(receiverLayer?.update),
      );
      const preconditions = {
        activeDocumentPresent:Boolean(app?.pdfDocument),
        viewerOwnsActiveDocument:pdfViewer?.pdfDocument === app?.pdfDocument,
        managerIsCurrent:Boolean(
          manager && manager === pdfViewer?._layerProperties
            ?.annotationEditorUIManager,
        ),
        activePageViewIsCurrent:pdfViewer?.getPageView(0) === activePageView,
        activePageIsExpected:activePageView?.pdfPage?.pageNumber === 1,
        activeLayerIsCurrent:
          activePageView?.annotationEditorLayer?.annotationEditorLayer === activeLayer,
        receiverPageViewIsCurrent:pdfViewer?.getPageView(1) === receiverPageView,
        receiverPageIsExpected:receiverPageView?.pdfPage?.pageNumber === 2,
        receiverLayerIsCurrent:
          receiverPageView?.annotationEditorLayer?.annotationEditorLayer === receiverLayer,
        editorPresent:Boolean(editor),
        editorPageIndex:editor?.pageIndex === 0,
        editorParentMatchesActiveLayer:editor?.parent === activeLayer,
        managerOwnsEditor:Boolean(editor && manager?.getEditor?.(editor.id) === editor),
        editorAttached:Boolean(editor?.isAttachedToDOM),
        editorConnected:Boolean(editor?.div?.isConnected),
        activeElementIsEditor:activeElement === editor?.div,
        internalIsContentEditable:Boolean(activeInternal?.isContentEditable),
        internalBelongsToEditor:Boolean(editor?.div?.contains(activeInternal)),
        internalIsActive:document.activeElement === activeInternal,
        editorMatchesSavedAnnotation:Boolean(
          editor && window.__mouseBridgeState.annotationUuidByRuntimeId
            .get(String(editor.id)) === annotationId,
        ),
        bridgeWrapperInspectorAvailable,
        receiverBridgeUpdateWrapped:bridgeUpdateWrapped,
      };
      if (Object.values(preconditions).some((value) => value !== true)) {
        throw new Error(
          `The changed-viewport probe requires the focused reopened editor and both current-document layers: ${JSON.stringify(preconditions)}`,
        );
      }
      const samePresentation = (left, right) => {
        if (!left || !right) return false;
        for (const key of ["rotation", "scale", "width", "height", "offsetX", "offsetY"]) {
          if (!Object.is(left[key], right[key])) return false;
        }
        for (const key of ["viewBox", "transform"]) {
          const before = left[key];
          const after = right[key];
          if (!before && !after) continue;
          if (!before || !after || before.length !== after.length ||
            Array.from(before).some((value, index) => !Object.is(value, after[index]))) {
            return false;
          }
        }
        return true;
      };
      const originalPageViewport = activePageView.viewport;
      const originalLayerViewport = activeLayer.viewport;
      const receiverViewport = receiverLayer.viewport;
      const pageBefore = originalPageViewport.clone({ dontFlip:true });
      const activePresentationMatchesBefore = samePresentation(
        activeLayer.viewport,
        pageBefore,
      );
      const receiverSamePresentation = samePresentation(receiverLayer.viewport, receiverViewport);
      const originalCommitOrRemove = manager.commitOrRemove;
      let managerCommitCalls = 0;
      const countedCommitOrRemove = function (...args) {
        managerCommitCalls += 1;
        return originalCommitOrRemove.apply(this, args);
      };
      let changedPagePresentationMatches = false;
      let activeLayerPresentationAfter = null;
      let changedPagePresentation = null;
      let editorAfter = null;
      try {
        activePageView.viewport = originalPageViewport.clone({
          scale:originalPageViewport.scale + 0.2,
        });
        changedPagePresentation = activePageView.viewport.clone({ dontFlip:true });
        changedPagePresentationMatches = samePresentation(
          activeLayer.viewport,
          changedPagePresentation,
        );
        activeLayerPresentationAfter = {
          scale:activeLayer.viewport.scale,
          rotation:activeLayer.viewport.rotation,
          width:activeLayer.viewport.width,
          height:activeLayer.viewport.height,
        };
        manager.commitOrRemove = countedCommitOrRemove;
        receiverLayer.update({ viewport:receiverViewport });
        const liveEditor = manager.getEditor(editor.id);
        editorAfter = {
          managerOwnsEditor:liveEditor === editor,
          editing:Boolean(liveEditor?.isInEditMode?.()),
          connected:Boolean(liveEditor?.div?.isConnected),
          text:liveEditor?.div?.querySelector(".internal")?.textContent
            ?.replace(/\u200b/g, "").replace(/\u00a0/g, " ") ?? null,
        };
      } finally {
        if (manager.commitOrRemove === countedCommitOrRemove) {
          manager.commitOrRemove = originalCommitOrRemove;
        }
        activePageView.viewport = originalPageViewport;
      }
      return {
        documentIdentity:window.__mouseObjectIdentity?.(app.pdfDocument) ?? null,
        managerIdentity:window.__mouseObjectIdentity?.(manager) ?? null,
        activePageViewIdentity:window.__mouseObjectIdentity?.(activePageView) ?? null,
        activeLayerIdentity:window.__mouseObjectIdentity?.(activeLayer) ?? null,
        receiverPageViewIdentity:window.__mouseObjectIdentity?.(receiverPageView) ?? null,
        receiverLayerIdentity:window.__mouseObjectIdentity?.(receiverLayer) ?? null,
        editorIdentity:window.__mouseObjectIdentity?.(editor) ?? null,
        editorParentIdentity:window.__mouseObjectIdentity?.(editor.parent) ?? null,
        editorPageIndex:editor.pageIndex,
        managerCurrentPageIndex:manager.currentPageIndex,
        managerCurrentLayerMatchesEditor:manager.currentLayer === editor.parent,
        activePresentationMatchesBefore,
        changedPagePresentationMatches,
        receiverSamePresentation,
        receiverBridgeUpdateWrapped:Boolean(
          window.__mouseHasBridgeUpdateWrapper?.(receiverLayer.update),
        ),
        pageScaleBefore:originalPageViewport.scale,
        pageScaleChanged:changedPagePresentation?.scale !== originalPageViewport.scale,
        activeLayerPresentationAfter,
        managerCommitCalls,
        editorAfter,
      };
    }, savedFreeText.id);
    assert.equal(crossPageViewportChange.editorPageIndex, 0, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.managerCurrentPageIndex, 0, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.managerCurrentLayerMatchesEditor, true, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.activePresentationMatchesBefore, true, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.pageScaleChanged, true, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.changedPagePresentationMatches, false, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.receiverSamePresentation, true, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.receiverBridgeUpdateWrapped, true, JSON.stringify(crossPageViewportChange));
    assert.ok(crossPageViewportChange.managerCommitCalls > 0, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.editorAfter.managerOwnsEditor, true, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.editorAfter.connected, true, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.editorAfter.editing, false, JSON.stringify(crossPageViewportChange));
    assert.equal(crossPageViewportChange.editorAfter.text, "Mouse toolbar round trip", JSON.stringify(crossPageViewportChange));

      assert.deepEqual(pageErrors, [], "The viewer should not throw during mouse input");
    const focusLifecyclePath = path.join(artifactsPath, `mouse-input-${artifactId}.focus.json`);
    await writeFile(focusLifecyclePath, JSON.stringify({
      capturedAt:new Date().toISOString(),
      fixture:"tests/fixtures/tracemonkey.pdf",
      documentId,
      samePresentationHide:pausedFreeText,
      samePresentationRedraw:{
        pageRenderingState:pausedFreeText.pageRenderingStateAfterRedraw,
        focusPreserved:pausedFreeText.focusPreservedAfterRedraw,
        editingPreserved:pausedFreeText.editingAfterRedraw,
        editorBounds:pausedFreeText.editorBoundsAfterRedraw,
      },
      focusedZoom:{ before:focusedBeforeZoom, after:zoomedFreeText },
      savedReopenAfterZoom:zoomedSavedAnnotation,
      crossPageViewportChange,
      hostFocusPauseResume:hostFocusAfterResume,
    }, null, 2), "utf8");
    t.diagnostic(`Focus lifecycle evidence: ${focusLifecyclePath}`);
    } catch (error) {
      primaryError = error;
      try {
        const captureId = artifactId;
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
          inputDiagnostics = await viewer.evaluate(async () => {
            const app = window.PDFViewerApplication;
            const pdfViewer = app?.pdfViewer;
            const pageView = pdfViewer?.getPageView(0);
            const pageElement = document.querySelector('.page[data-page-number="1"]');
            const editorLayer = pageElement?.querySelector(".annotationEditorLayer");
            const container = document.getElementById("viewerContainer");
            const annotationLayer = pageView?.annotationLayer?.div ||
              pageElement?.querySelector(".annotationLayer") || null;
            const expectedAnnotationId = window.__mouseTestMilestones
              ?.savedFreeTextAnnotationId || null;
            const annotationStorage = app?.pdfDocument?.annotationStorage;
            const annotationEditorUIManager = pdfViewer?._layerProperties
              ?.annotationEditorUIManager;
            const storageValue = expectedAnnotationId
              ? annotationStorage?.getRawValue?.(expectedAnnotationId)
              : undefined;
            const modifiedIds = annotationStorage?.modifiedIds?.ids;
            const rectSnapshot = (element) => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return {
                x:rect.x,
                y:rect.y,
                width:rect.width,
                height:rect.height,
                connected:element.isConnected,
                display:style.display,
                visibility:style.visibility,
                opacity:style.opacity,
                pointerEvents:style.pointerEvents,
              };
            };
            const containerRect = container?.getBoundingClientRect();
            const pageRect = pageElement?.getBoundingClientRect();
            const intersects = (rect, clip) => Boolean(rect && clip &&
              rect.width > 0 && rect.height > 0 &&
              Math.max(rect.left, clip.left) < Math.min(rect.right, clip.right) &&
              Math.max(rect.top, clip.top) < Math.min(rect.bottom, clip.bottom));
            const visiblePages = (() => {
              try {
                return pdfViewer?._getVisiblePages?.().views.map(({ id, percent, view }) => ({
                  id,
                  percent,
                  renderingId:view?.renderingId ?? null,
                  renderingState:view?.renderingState ?? null,
                  bounds:rectSnapshot(view?.div),
                })) ?? [];
              } catch (error) {
                return { error:error?.message || String(error) };
              }
            })();
            let annotationParseError = null;
            let parsedAnnotations = [];
            if (pageView?.pdfPage) {
              try {
                parsedAnnotations = await pageView.pdfPage.getAnnotations({ intent:"display" });
              } catch (error) {
                annotationParseError = error?.message || String(error);
              }
            }
            const parsedFreeText = parsedAnnotations
              .filter((annotation) => annotation.subtype === "FreeText")
              .map((annotation) => ({
                id:annotation.id,
                subtype:annotation.subtype,
                rect:annotation.rect,
                flags:annotation.flags,
                hasAppearance:Boolean(annotation.appearance),
                keys:Object.keys(annotation).sort(),
              }));
            const annotationNodes = [...(annotationLayer?.querySelectorAll?.(
              "[data-annotation-id]",
            ) || [])].map((element) => ({
              id:element.getAttribute("data-annotation-id"),
              className:typeof element.className === "string" ? element.className : "",
              bounds:rectSnapshot(element),
            }));
            const editableAnnotations = (() => {
              try {
                return pageView?.annotationLayer?.annotationLayer
                  ?.getEditableAnnotations?.().map((annotation) => ({
                    id:annotation.data?.id ?? null,
                    subtype:annotation.data?.subtype ?? null,
                    hidden:annotation.container?.hidden ?? null,
                    connected:annotation.container?.isConnected ?? null,
                    bounds:rectSnapshot(annotation.container),
                  })) ?? [];
              } catch (error) {
                return { error:error?.message || String(error) };
              }
            })();
            const requestedPage = app?.pdfDocument
              ? await app.pdfDocument.getPage(1).catch(() => null)
              : null;
            const frameRect = window.frameElement?.getBoundingClientRect();
            const renderState = {
              expectedAnnotationId,
              document: {
                pageCount:app?.pdfDocument?.numPages ?? null,
                documentMatchesPageView:!!requestedPage && pageView?.pdfPage === requestedPage,
                requestedPageNumber:requestedPage?.pageNumber ?? null,
                pageViewPageNumber:pageView?.pdfPage?.pageNumber ?? null,
              },
              page: {
                pageNumber:pageView?.id ?? null,
                renderingId:pageView?.renderingId ?? null,
                renderingState:pageView?.renderingState ?? null,
                datasetLoaded:pageElement?.dataset.loaded ?? null,
                bounds:rectSnapshot(pageElement),
                viewport:pageView?.viewport ? {
                  width:pageView.viewport.width,
                  height:pageView.viewport.height,
                  scale:pageView.viewport.scale,
                  rotation:pageView.viewport.rotation,
                } : null,
                visibleInViewer:intersects(pageRect, containerRect),
                visibleInFrame:intersects(pageRect, {
                  left:0,
                  top:0,
                  right:window.innerWidth,
                  bottom:window.innerHeight,
                }),
              },
              pageLoading: {
                currentPageNumber:pdfViewer?.currentPageNumber ?? null,
                currentPageIndex:pdfViewer?._currentPageNumber - 1 ?? null,
                currentScale:pdfViewer?.currentScale ?? null,
                pagesRotation:pdfViewer?.pagesRotation ?? null,
                location:pdfViewer?._location ? {
                  pageNumber:pdfViewer._location.pageNumber ?? null,
                  scale:pdfViewer._location.scale ?? null,
                  left:pdfViewer._location.left ?? null,
                  top:pdfViewer._location.top ?? null,
                } : null,
              },
              viewport: {
                visibilityState:document.visibilityState,
                frameHasFocus:document.hasFocus(),
                innerWidth:window.innerWidth,
                innerHeight:window.innerHeight,
                devicePixelRatio:window.devicePixelRatio,
                frameBounds:frameRect ? {
                  x:frameRect.x,
                  y:frameRect.y,
                  width:frameRect.width,
                  height:frameRect.height,
                } : null,
                container:container ? {
                  scrollTop:container.scrollTop,
                  scrollLeft:container.scrollLeft,
                  scrollHeight:container.scrollHeight,
                  scrollWidth:container.scrollWidth,
                  clientHeight:container.clientHeight,
                  clientWidth:container.clientWidth,
                  bounds:rectSnapshot(container),
                } : null,
                visiblePages,
              },
              renderingQueue: {
                present:Boolean(pdfViewer?.renderingQueue),
                printing:pdfViewer?.renderingQueue?.printing ?? null,
                thumbnailViewEnabled:pdfViewer?.renderingQueue?.isThumbnailViewEnabled ?? null,
              },
              annotationLayer: {
                builderPresent:Boolean(pageView?.annotationLayer),
                layerPresent:Boolean(pageView?.annotationLayer?.annotationLayer),
                divPresent:Boolean(annotationLayer),
                bounds:rectSnapshot(annotationLayer),
                hidden:annotationLayer?.hidden ?? null,
                childCount:annotationLayer?.childElementCount ?? null,
                annotationNodeCount:annotationNodes.length,
                annotationNodes,
                expectedAnnotationNodePresent:annotationNodes.some(
                  (annotation) => annotation.id === expectedAnnotationId,
                ),
                editableAnnotations,
              },
              annotationState: {
                parsedFreeText,
                parseError:annotationParseError,
                isDeletedInEditorManager:expectedAnnotationId
                  ? annotationEditorUIManager?.isDeletedAnnotationElement?.(expectedAnnotationId) ?? null
                  : null,
                editorLookup:expectedAnnotationId
                  ? (() => {
                      const editor = annotationEditorUIManager?.getEditor?.(expectedAnnotationId);
                      return editor ? {
                        id:editor.id ?? null,
                        annotationElementId:editor.annotationElementId ?? null,
                        pageIndex:editor.pageIndex ?? null,
                        deleted:editor.deleted ?? null,
                        hidden:editor.hidden ?? null,
                      } : null;
                    })()
                  : null,
                storageSize:annotationStorage?.size ?? null,
                storageValue:storageValue ? {
                  type:storageValue.constructor?.name ?? null,
                  keys:Object.keys(storageValue).sort(),
                } : null,
                modifiedIds:modifiedIds ? [...modifiedIds].slice(0, 32) : null,
                expectedIdModified:Boolean(modifiedIds?.has?.(expectedAnnotationId)),
              },
            };
            return {
              renderState,
              renderEvents:window.__savedFreeTextRenderEvents?.slice(-96) || [],
              modeActivationTraceState:
                window.__mouseModeActivationTraceState || null,
              modeActivationTrace:
                window.__mouseModeActivationTrace?.slice(-96) || [],
              pdfEditorLifecycleTraceState:
                window.__mousePdfEditorLifecycleTraceState || null,
              pdfEditorLifecycleTrace:
                window.__mousePdfEditorLifecycleTrace?.slice(-96) || [],
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
              freeTextTapProbe:window.__mouseFreeTextTapProbe?.slice(-12) || [],
              trustedDoubleClicks:window.__trustedDoubleClicks?.slice(-24) || [],
              annotationModeEvents:window.__mouseAnnotationModeEvents?.slice(-32) || [],
              pendingAnnotationMode:window.__mousePendingAnnotationMode || null,
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
          await viewer.evaluate(() => window.__stopMousePdfEditorLifecycleTrace?.())
            .catch(() => {});
          await viewer.evaluate(() => window.__stopMouseModeActivationTrace?.())
            .catch(() => {});
        }
        const bridgeDiagnostics = await page?.evaluate(
          () => window.__host?.inputDiagnostics || null,
        );
        const screenshotPath = path.join(artifactsPath, `mouse-input-${captureId}.failure.png`);
        await page?.screenshot({ path: screenshotPath, fullPage: false });
        const diagnosticPath = path.join(artifactsPath, `mouse-input-${captureId}.failure.json`);
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
      cleanupReport = await cleanupBrowserTestResources({
        browser,
        browserObserver: browserStderrObserver,
        ownedPages: page ? [page] : [],
        server,
      });
      const cleanupPath = path.join(artifactsPath, `mouse-input-${artifactId}.cleanup.json`);
      try {
        await writeFile(cleanupPath, JSON.stringify(cleanupReport, null, 2), "utf8");
      } catch (error) {
        cleanupReport.errors.push({
          phase:"cleanup-report.write",
          name:error?.name || "Error",
          message:error?.message || String(error),
          stack:error?.stack || null,
        });
      }
      t.diagnostic(`Cleanup report: ${cleanupPath}`);
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) {
      throw finalError;
    }
  },
);
