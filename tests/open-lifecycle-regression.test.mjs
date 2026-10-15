import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  observeBrowserTestChildStderr,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const browserPath = resolveBrowserPath();
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const bridgeCssPath = path.join(root, "viewer-adapter", "bridge.css");
const viewerHtmlPath = path.join(
  root,
  "vendor",
  "pdfjs-generic-legacy",
  "web",
  "viewer.html",
);
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const artifacts = path.join(root, "tests", "artifacts");
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

async function boundedFailureSnapshot(promise) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).catch(error => ({ diagnosticError: error?.message || String(error) })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ diagnosticTimeoutMs: 2000 }), 2000); }),
    ]);
  } finally { clearTimeout(timer); }
}


test(
  "PDF open waits for its own document readiness and cancels on renderer disposal",
  {
    skip: !browserPath && "Chrome or Edge is required for this browser regression",
    timeout: 120_000,
  },
  async (t) => {
    const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
    const artifactPath = path.join(artifacts, `open-lifecycle-${runId}.json`);
    const cleanupArtifactPath = path.join(
      artifacts,
      `open-lifecycle-${runId}.cleanup.json`,
    );
    const [bridgeSource, bridgeCss, viewerHtml] = await Promise.all([
      readBridgeRuntimeSource(bridgePath),
      readFile(bridgeCssPath, "utf8"),
      readFile(viewerHtmlPath, "utf8"),
    ]);
    const probeScript = `
      <script>
        const probe = window.__openLifecycleProbe = {
          opens: [],
          loads: [],
          boundaryTimers: { created: 0, cleared: 0, active: new Set() },
        };
        const nativeSetTimeout = window.setTimeout.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        window.setTimeout = function(callback, delay, ...args) {
          const timer = nativeSetTimeout(callback, delay, ...args);
          if (delay === 110000) {
            probe.boundaryTimers.created += 1;
            probe.boundaryTimers.active.add(timer);
          }
          return timer;
        };
        window.clearTimeout = function(timer) {
          if (probe.boundaryTimers.active.delete(timer)) {
            probe.boundaryTimers.cleared += 1;
          }
          return nativeClearTimeout(timer);
        };
        window.__armOpenReadinessGate = () => {
          window.__openReadinessGate = { armed: true, started: false, released: false };
        };
        const installProbe = () => {
          const app = window.PDFViewerApplication;
          const probe = window.__openLifecycleProbe;
          if (!app || !probe || probe.installed) return;
          probe.installed = true;
          const originalOpen = app.open;
          app.open = function(args) {
            probe.opens.push({
              at: performance.now(),
              byteLength: args?.data?.byteLength ?? args?.data?.length ?? null,
              previousDocId: this.pdfLoadingTask?.docId ?? null,
            });
            return originalOpen.call(this, args);
          };
          const originalLoad = app.load;
          app.load = function(pdfDocument, ...args) {
            const gate = window.__openReadinessGate;
            probe.loads.push({
              at: performance.now(),
              docId: this.pdfLoadingTask?.docId ?? null,
              pageCount: pdfDocument?.numPages ?? null,
            });
            if (gate?.armed) {
              gate.armed = false;
              gate.started = true;
              gate.docId = this.pdfLoadingTask?.docId ?? null;
              const getDownloadInfo = pdfDocument.getDownloadInfo.bind(pdfDocument);
              let resolveHeld;
              let rejectHeld;
              gate.readiness = new Promise((resolve, reject) => {
                resolveHeld = resolve;
                rejectHeld = reject;
              });
              gate.release = () => {
                if (gate.released) return;
                gate.released = true;
                Promise.resolve().then(getDownloadInfo).then(resolveHeld, rejectHeld);
              };
              pdfDocument.getDownloadInfo = () => gate.readiness;
            }
            return originalLoad.call(this, pdfDocument, ...args);
          };
        };
        try {
          window.parent.document.addEventListener("webviewerloaded", installProbe, true);
        } catch {}
        document.addEventListener("webviewerloaded", installProbe, true);
      </script>`;
    const viewerWithBridge = viewerHtml.replace(
      /<head\b[^>]*>/i,
      (head) =>
        `${head}${probeScript}<link rel="stylesheet" href="/viewer-adapter/bridge.css"><script src="/viewer-adapter/obsidian-bridge.js" data-channel="pdf-web-reader" data-token="open-lifecycle-${runId}" data-renderer-generation="open-lifecycle-renderer-${runId}" data-base-url="/vendor/pdfjs-generic-legacy/web/"></script>`,
    );
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <meta charset="utf-8">
          <title>PDF open lifecycle regression</title>
          <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
          <iframe name="pdf-reader" title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
          <script>
            const channel = "pdf-web-reader";
            const token = ${JSON.stringify(`open-lifecycle-${runId}`)};
            const documentId = "public-fixture-tracemonkey";
            const iframe = document.querySelector("iframe");
            const preflightScenario = new URLSearchParams(location.search).has("preflight");
            const host = window.__openLifecycleHost = {
              opened: 0,
              openSends: 0,
              errors: [],
              lifecycle: [],
              autoSave: preflightScenario,
              holdSaves: preflightScenario,
              saves: [],
              savedAcks: [],
            };
            let fixtureBytes;
            const sendOpen = () => {
              host.openSends += 1;
              const data = fixtureBytes.slice(0);
              iframe.contentWindow.postMessage({
                channel, type: "open", token, documentId, filename: "tracemonkey.pdf",
                autoSave: host.autoSave, readOnly: false, openRequest: host.openSends, data,
              }, "*", [data]);
            };
            window.addEventListener("message", event => {
              if (event.source !== iframe.contentWindow) return;
              const message = event.data;
              if (!message || message.channel !== channel || message.token !== token) return;
              if (message.type === "ready") {
                fetch("/tests/fixtures/tracemonkey.pdf").then(response => {
                  if (!response.ok) throw new Error("fixture fetch failed");
                  return response.arrayBuffer();
                }).then(bytes => { fixtureBytes = bytes; sendOpen(); })
                  .catch(error => host.errors.push(error.message));
              } else if (message.type === "opened") {
                host.opened += 1;
                (host.openedMessages ||= []).push({
                  openRequest: message.openRequest ?? null,
                  documentId: message.documentId ?? null,
                });
              } else if (message.type === "save") {
                host.saves.push({
                  requestId: message.requestId ?? null,
                  documentId: message.documentId ?? null,
                  revision: message.revision ?? null,
                  origin: message.origin ?? null,
                  dataBytes: message.data?.byteLength ?? message.data?.length ?? null,
                });
                if (!host.holdSaves) {
                  host.savedAcks.push(message.requestId ?? null);
                  iframe.contentWindow.postMessage({
                    channel, type: "saved", token,
                    documentId: message.documentId,
                    requestId: message.requestId,
                    revision: message.revision,
                  }, "*");
                }
              } else if (message.type === "error") {
                host.errors.push({ code: message.code ?? null, message: message.message ?? null });
              } else if (message.type === "renderer-unloaded" || message.type === "worker-terminated") {
                host.lifecycle.push(message.type);
              }
            });
            host.reopen = sendOpen;
          </script>`);
        return;
      }
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
      let target;
      if (url.pathname === "/tests/fixtures/tracemonkey.pdf") {
        target = fixturePath;
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
          "content-type": mimeTypes.get(path.extname(target)) || "application/octet-stream",
          "content-length": info.size,
          "x-content-type-options": "nosniff",
        });
        createReadStream(target).pipe(response);
      } catch {
        response.writeHead(404).end("not found");
      }
    });

    await mkdir(artifacts, { recursive: true });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    let browser;
    let page;
    let viewer;
    let browserStderrObserver;
    let primaryError;
    let cleanupReport;
    let evidenceWriteErrors = [];
    const evidence = {
      runId,
      fixture: "tests/fixtures/tracemonkey.pdf (public PDF.js fixture)",
      scenario: "session-bound open readiness, queued open, and disposal",
      assertions: [],
    };
    try {
      browser = await launchTestBrowser(puppeteer, {
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }, { testName: "open-lifecycle-regression" });
      browserStderrObserver = observeBrowserTestChildStderr(browser.process());
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__openLifecycleHost?.opened === 1, {
        timeout: 45_000,
      });
      viewer = page.frames().find((frame) =>
        frame.url().includes("/vendor/pdfjs-generic-legacy/web/viewer.html"),
      );
      assert.ok(viewer, "Expected the PDF.js viewer frame");
      await viewer.waitForFunction(() => {
        const app = window.PDFViewerApplication;
        return Boolean(app?.pdfDocument && app.pdfViewer?.firstPagePromise);
      }, { timeout: 30_000 });

      await viewer.evaluate(() => window.__armOpenReadinessGate());
      await page.evaluate(() => window.__openLifecycleHost.reopen());
      await viewer.waitForFunction(() => window.__openReadinessGate?.started, {
        timeout: 30_000,
      });
      const blockedOpen = await viewer.evaluate(() => {
        const app = window.PDFViewerApplication;
        const gate = window.__openReadinessGate;
        app.eventBus.dispatch("documentloaded", { source: app });
        return {
          gateReleased: gate.released,
          taskId: app.pdfLoadingTask?.docId ?? null,
          documentTaskMatches: app.pdfDocument?.loadingTask === app.pdfLoadingTask,
          viewerDocumentMatches: app.pdfViewer?.pdfDocument === app.pdfDocument,
          openCalls: window.__openLifecycleProbe.opens.length,
        };
      });
      await page.evaluate(() => window.__openLifecycleHost.reopen());
      let acknowledgedBeforeReadiness = false;
      try {
        await page.waitForFunction(
          () => window.__openLifecycleHost?.opened >= 2,
          { timeout: 350 },
        );
        acknowledgedBeforeReadiness = true;
      } catch (error) {
        if (error?.name !== "TimeoutError") throw error;
        // The held getDownloadInfo promise is the deterministic readiness gate.
      }
      const queuedBeforeRelease = await viewer.evaluate(() => ({
        opened: window.parent.__openLifecycleHost?.opened ?? null,
        openCalls: window.__openLifecycleProbe.opens.length,
        gateReleased: window.__openReadinessGate?.released ?? null,
      }));
      assert.equal(blockedOpen.gateReleased, false);
      assert.equal(blockedOpen.documentTaskMatches, true);
      assert.equal(blockedOpen.viewerDocumentMatches, true);
      assert.equal(acknowledgedBeforeReadiness, false,
        "A stale global documentloaded event must not acknowledge a still-loading open");
      assert.equal(queuedBeforeRelease.opened, 1,
        "The queued request must not acknowledge before the active open is ready");
      assert.equal(queuedBeforeRelease.openCalls, 2,
        "The bridge must not start a queued PDF.js open while the current one is pending");
      assert.equal(queuedBeforeRelease.gateReleased, false);
      evidence.assertions.push({
        staleEventIgnored: true,
        firstTaskId: blockedOpen.taskId,
        queuedOpenStayedSerialized: true,
        stateBeforeRelease: queuedBeforeRelease,
      });

      await viewer.evaluate(() => window.__openReadinessGate.release());
      await page.waitForFunction(() => window.__openLifecycleHost?.opened === 3, {
        timeout: 45_000,
      });
      await viewer.waitForFunction(() => window.__openLifecycleProbe.opens.length === 3, {
        timeout: 15_000,
      });
      const opensBeforeDispose = await viewer.evaluate(() =>
        window.__openLifecycleProbe.opens.length,
      );
      assert.equal(opensBeforeDispose, 3,
        "Both queued requests should eventually finish in order");
      evidence.probe = await viewer.evaluate(() => ({
        opens: window.__openLifecycleProbe.opens,
        loads: window.__openLifecycleProbe.loads,
        gate: {
          started: window.__openReadinessGate?.started ?? false,
          released: window.__openReadinessGate?.released ?? false,
          docId: window.__openReadinessGate?.docId ?? null,
        },
      }));

      await viewer.evaluate(() => window.__armOpenReadinessGate());
      await page.evaluate(() => window.__openLifecycleHost.reopen());
      await viewer.waitForFunction(() => window.__openReadinessGate?.started, {
        timeout: 30_000,
      });
      // Trigger the same pagehide callback the bridge registers for renderer
      // disposal while keeping this isolated frame inspectable for assertions.
      await viewer.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.waitForFunction(
        () => window.__openLifecycleHost?.lifecycle.includes("worker-terminated"),
        { timeout: 20_000 },
      );
      const afterDispose = await page.evaluate(() => ({
        opened: window.__openLifecycleHost.opened,
        errors: window.__openLifecycleHost.errors,
        lifecycle: window.__openLifecycleHost.lifecycle,
      }));
      assert.equal(afterDispose.opened, 3,
        "A pending open must not acknowledge after renderer disposal");
      assert.deepEqual(afterDispose.errors, [],
        "Disposal should cancel the pending open without reporting a stale load error");
      assert.deepEqual(afterDispose.lifecycle,
        ["renderer-unloaded", "worker-terminated"]);
      evidence.assertions.push({ pendingOpenCancelledOnDispose: true, afterDispose });
      evidence.readinessAndSessionDisposal = {
        probe: evidence.probe,
        afterDispose,
      };

      // A separate renderer instance exercises the pre-session branch where
      // openDocument waits for an in-flight host save and active composition.
      // The bridge already drains current waiters in clearScheduledWork(); this
      // checks that the preflight waiter and its long timer are actually gone
      // after disposal, while the unsaved editor remains in PDF.js memory.
      await page.goto(`${baseUrl}/?preflight=1`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__openLifecycleHost?.opened === 1, {
        timeout: 45_000,
      });
      viewer = page.frames().find((frame) =>
        frame.url().includes("/vendor/pdfjs-generic-legacy/web/viewer.html"),
      );
      assert.ok(viewer, "Expected a fresh PDF.js viewer for preflight cancellation");
      await viewer.waitForFunction(() => {
        const app = window.PDFViewerApplication;
        return Boolean(
          app?.pdfDocument &&
          app.pdfViewer?.firstPagePromise &&
          app.pdfViewer?.getPageView?.(0)?.annotationEditorLayer?.annotationEditorLayer,
        );
      }, { timeout: 30_000 });
      await viewer.evaluate(() => new Promise((resolve) => {
        const app = window.PDFViewerApplication;
        const eventBus = app.eventBus;
        const currentMode = app.pdfViewer.annotationEditorMode;
        if (currentMode === 3) {
          resolve();
          return;
        }
        const onModeChanged = ({ mode }) => {
          if (mode !== 3) return;
          eventBus._off("annotationeditormodechanged", onModeChanged);
          resolve();
        };
        eventBus._on("annotationeditormodechanged", onModeChanged);
        app.pdfViewer.annotationEditorMode = { mode: 3 };
      }));
      const editorSetup = await viewer.evaluate(() => {
        const app = window.PDFViewerApplication;
        const pageView = app.pdfViewer.getPageView(0);
        const layer = pageView.annotationEditorLayer.annotationEditorLayer;
        layer.addNewEditor();
        const editorElement = pageView.div.querySelector(".freeTextEditor");
        const internal = editorElement?.querySelector(
          ".internal[contenteditable='true']",
        );
        if (!internal) {
          throw new Error("PDF.js did not create an editable FreeText field");
        }
        internal.focus();
        return {
          editorId: editorElement.id,
          focused: document.activeElement === internal,
          connected: internal.isConnected,
          managerOwnsEditor: Boolean(
            app.pdfViewer._layerProperties.annotationEditorUIManager.getEditor(
              editorElement.id,
            ),
          ),
        };
      });
      assert.equal(editorSetup.focused, true, "The new FreeText field should be focused");
      assert.equal(editorSetup.connected, true);
      assert.equal(editorSetup.managerOwnsEditor, true);
      await page.keyboard.type("Retained preflight content");
      await viewer.waitForFunction(() => {
        const internal = document.querySelector(
          ".freeTextEditor .internal[contenteditable='true']",
        );
        return internal?.textContent?.includes("Retained preflight content");
      }, { timeout: 10_000 });
      await page.waitForFunction(
        () => window.__openLifecycleHost?.saves?.length === 1,
        { timeout: 15_000 },
      );
      const heldSave = await page.evaluate(() => ({
        opened: window.__openLifecycleHost.opened,
        saves: window.__openLifecycleHost.saves,
        savedAcks: window.__openLifecycleHost.savedAcks,
      }));
      assert.equal(heldSave.opened, 1);
      assert.equal(heldSave.saves.length, 1, "The autosave should be in flight at preflight");
      assert.equal(heldSave.saves[0].origin, "auto");
      assert.ok(heldSave.saves[0].dataBytes > 0);
      assert.deepEqual(heldSave.savedAcks, [], "The host intentionally holds the save ack");

      await page.keyboard.type(" and unsaved tail");
      await viewer.waitForFunction(() => {
        const internal = document.querySelector(
          ".freeTextEditor .internal[contenteditable='true']",
        );
        return internal?.textContent?.includes("and unsaved tail");
      }, { timeout: 10_000 });
      const compositionState = await viewer.evaluate(() => {
        const internal = document.activeElement;
        if (!(internal instanceof HTMLElement) ||
            !internal.matches(".freeTextEditor .internal[contenteditable='true']")) {
          throw new Error("The dirty FreeText editor lost focus before open preflight");
        }
        internal.dispatchEvent(new CompositionEvent("compositionstart", {
          bubbles: true,
          data: "",
        }));
        return {
          focused: document.activeElement === internal,
          text: internal.textContent,
          composingEventDispatched: true,
        };
      });
      assert.equal(compositionState.focused, true);
      assert.ok(compositionState.text.includes("Retained preflight content"));
      assert.ok(compositionState.text.includes("and unsaved tail"));

      await page.evaluate(() => window.__openLifecycleHost.reopen());
      await viewer.waitForFunction(
        () => window.parent.__openLifecycleHost?.openSends === 2,
        { timeout: 10_000 },
      );
      await viewer.waitForFunction(
        () => window.__openLifecycleProbe.boundaryTimers.active.size > 0,
        { timeout: 10_000 },
      );
      const preflightBlocked = await viewer.evaluate(() => {
        const host = window.parent.__openLifecycleHost;
        const probe = window.__openLifecycleProbe;
        const app = window.PDFViewerApplication;
        const editorId = document.querySelector(".freeTextEditor")?.id ?? null;
        return {
          openCalls: probe.opens.length,
          boundaryTimers: {
            created: probe.boundaryTimers.created,
            cleared: probe.boundaryTimers.cleared,
            active: probe.boundaryTimers.active.size,
          },
          opened: host.opened,
          openSends: host.openSends,
          saves: host.saves,
          savedAcks: host.savedAcks,
          focusedEditor: document.activeElement?.closest?.(".freeTextEditor")?.id ?? null,
          managerOwnsEditor: Boolean(editorId && app.pdfViewer._layerProperties
            .annotationEditorUIManager.getEditor(editorId)),
        };
      });
      assert.equal(preflightBlocked.openCalls, 1,
        "An open waiting on the pending save and composition must not reach PDF.js");
      assert.equal(preflightBlocked.boundaryTimers.active, 1,
        "The pre-session composition waiter should own one active boundary timer");
      assert.equal(preflightBlocked.opened, 1,
        "The preflight open must remain unacknowledged while input is busy");
      assert.equal(preflightBlocked.openSends, 2);
      assert.deepEqual(preflightBlocked.savedAcks, []);
      assert.equal(preflightBlocked.focusedEditor, editorSetup.editorId);
      assert.equal(preflightBlocked.managerOwnsEditor, true);

      await viewer.evaluate(() => window.dispatchEvent(new Event("pagehide")));
      await page.waitForFunction(
        () => window.__openLifecycleHost?.lifecycle.includes("worker-terminated"),
        { timeout: 20_000 },
      );
      const preflightAfterDispose = await viewer.evaluate((editorId) => {
        const host = window.parent.__openLifecycleHost;
        const probe = window.__openLifecycleProbe;
        const app = window.PDFViewerApplication;
        const editor = app.pdfViewer._layerProperties
          .annotationEditorUIManager.getEditor(editorId);
        const internal = editor?.div?.querySelector(
          ".internal[contenteditable='true']",
        );
        return {
          opened: host.opened,
          errors: host.errors,
          lifecycle: host.lifecycle,
          openCalls: probe.opens.length,
          boundaryTimers: {
            created: probe.boundaryTimers.created,
            cleared: probe.boundaryTimers.cleared,
            active: probe.boundaryTimers.active.size,
          },
          savedAcks: host.savedAcks,
          editorRetained: Boolean(editor && editor.isAttachedToDOM && internal?.isConnected),
          retainedText: internal?.textContent ?? null,
        };
      }, editorSetup.editorId);
      assert.equal(preflightAfterDispose.opened, 1,
        "Disposal must not acknowledge the open that was waiting before a session existed");
      assert.deepEqual(preflightAfterDispose.errors, [],
        "Disposal should cancel the preflight without a stale host error");
      assert.deepEqual(preflightAfterDispose.lifecycle,
        ["renderer-unloaded", "worker-terminated"]);
      assert.equal(preflightAfterDispose.openCalls, 1,
        "The canceled preflight must never start the replacement PDF.js load");
      assert.equal(preflightAfterDispose.boundaryTimers.active, 0,
        "Disposal must clear the pre-session input boundary timer");
      assert.equal(preflightAfterDispose.boundaryTimers.cleared,
        preflightAfterDispose.boundaryTimers.created,
        "Every tracked input boundary timer should be canceled");
      assert.deepEqual(preflightAfterDispose.savedAcks, [],
        "The pending save remains unacknowledged when the renderer is disposed");
      assert.equal(preflightAfterDispose.editorRetained, true,
        "Cancellation must preserve the manager-owned unsaved FreeText editor");
      assert.ok(preflightAfterDispose.retainedText.includes("Retained preflight content"));
      assert.ok(preflightAfterDispose.retainedText.includes("and unsaved tail"));
      evidence.preSessionInputBoundaryCancellation = {
        editorId: editorSetup.editorId,
        editorSetup,
        heldSave,
        compositionState,
        preflightBlocked,
        preflightAfterDispose,
      };
      evidence.assertions.push({
        preSessionWaiterCanceled: true,
        activeBoundaryTimerCountAfterDispose: 0,
        unsavedEditorRetained: true,
        heldSaveAcknowledged: false,
      });
      evidence.pageErrors = pageErrors;
      assert.deepEqual(pageErrors, []);
    } catch (error) {
      primaryError = error;
      evidence.failure = error?.stack || error?.message || String(error);
      evidence.pageErrors = await boundedFailureSnapshot(page?.evaluate(() =>
        window.__openLifecycleHost ? {
          opened: window.__openLifecycleHost.opened,
          errors: window.__openLifecycleHost.errors,
          lifecycle: window.__openLifecycleHost.lifecycle,
        } : null,
      ));
      try {
        evidence.probe = await boundedFailureSnapshot(viewer?.evaluate(() => ({
          opens: window.__openLifecycleProbe?.opens ?? [],
          loads: window.__openLifecycleProbe?.loads ?? [],
          gate: window.__openReadinessGate ? {
            started: window.__openReadinessGate.started,
            released: window.__openReadinessGate.released,
            docId: window.__openReadinessGate.docId,
          } : null,
          current: {
            taskId: window.PDFViewerApplication?.pdfLoadingTask?.docId ?? null,
            hasDocument: Boolean(window.PDFViewerApplication?.pdfDocument),
          },
        })));
      } catch {
        // The failure may have followed the deliberate iframe-disposal check.
      }
    } finally {
      try {
        cleanupReport = await cleanupBrowserTestResources({
          browser,
          browserObserver: browserStderrObserver,
          ownedPages: page ? [page] : [],
          server,
        });
      } catch (error) {
        cleanupReport = {
          status: "failed",
          browser: null,
          server: null,
          errors: [{
            phase: "cleanup.throw",
            message: error?.message || String(error),
          }],
        };
      }
      evidence.cleanupReport = cleanupReport;
      evidence.browserStderr = browserStderrObserver?.snapshot() ?? null;
      if (primaryError) {
        evidence.failure ??= primaryError?.stack || primaryError?.message || String(primaryError);
      }
      for (const [filePath, value] of [
        [artifactPath, evidence],
        [cleanupArtifactPath, {
          runId,
          artifactPath,
          cleanupReport,
          browserStderr: evidence.browserStderr,
          primaryFailure: evidence.failure ?? null,
        }],
      ]) {
        try {
          await writeFile(filePath, JSON.stringify(value, null, 2), {
            encoding: "utf8",
            flag: "wx",
          });
        } catch (error) {
          const entry = {
            phase: "evidence.write",
            path: filePath,
            message: error?.message || String(error),
          };
          evidenceWriteErrors.push(entry);
          cleanupReport.errors.push(entry);
        }
      }
      t.diagnostic(`Open lifecycle evidence: ${artifactPath}`);
      t.diagnostic(`Open lifecycle cleanup evidence: ${cleanupArtifactPath}`);
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) throw finalError;
  },
);
