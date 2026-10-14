import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
const viewerHtmlPath = path.join(
  root,
  "vendor",
  "pdfjs-generic-legacy",
  "web",
  "viewer.html",
);
const channel = "pdf-web-reader";
const token = "autosave-browser-regression";
const documentId = "test-session-1";
const documentPath = "tests/fixtures/tracemonkey.pdf";
const freeTextSelector =
  '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal';
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

test("Obsidian auto-save debounces complete edits and serializes revisions", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 90_000,
}, async () => {
  const bridgeSource = await readFile(bridgePath, "utf8");
  const viewerHtml = await readFile(viewerHtmlPath, "utf8");
  const viewerWithBridge = viewerHtml.replace(
    /<head\b[^>]*>/i,
    (head) =>
      `${head}<script src="obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="__renderer_generation__"></script>`,
  );
  let browser;
  let page;
  let blurPage;
  let server;
  let primaryError;
  let cleanupReport;

  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
        <script>
          const channel = ${JSON.stringify(channel)};
          const token = ${JSON.stringify(token)};
          const documentId = ${JSON.stringify(documentId)};
          const documentPath = ${JSON.stringify(documentPath)};
          const iframe = document.querySelector('iframe');
          const state = window.__host = { ready:false, opened:false, openCount:0, openedSessions:[], lastOpenedDocumentId:null, lastOpenedAt:null, expectedRendererGeneration:'initial-renderer', readyGenerations:[], ignoredReadyGenerations:[], initialOpenSent:false, pendingOpen:null, pointerUps:[], saves:[], recoveries:[], flushes:[], closePrepareds:[], heavyLeases:[], pendingHeavyLeases:[], errors:[], holdFirstAck:true, holdNextAck:false, holdNextRecoveryAck:false, nextRecoveryAckDelay:10, holdNextHeavyLease:false, nextAckDelay:10, failNext:false, failDelay:10 };
          window.addEventListener('message', event => {
            if (event.source !== iframe.contentWindow) return;
            const message = event.data;
            if (!message || message.channel !== channel || message.token !== token) return;
            if (message.type === 'autosave-test-pointerup') {
              state.pointerUps.push({
                sequence: message.sequence,
                rendererGeneration: message.rendererGeneration,
                frameTime: message.frameTime,
                frameNow: message.frameNow,
                frameTimeOrigin: message.frameTimeOrigin,
                pointerUpAt:
                  message.frameTimeOrigin + message.frameTime,
                frameHandlerAt:
                  message.frameTimeOrigin + message.frameNow,
                hostReceivedAt: performance.timeOrigin + performance.now(),
              });
            } else if (message.type === 'ready') {
              state.readyGenerations.push(message.rendererGeneration ?? null);
              if (message.rendererGeneration !== state.expectedRendererGeneration) {
                state.ignoredReadyGenerations.push(message.rendererGeneration ?? null);
                return;
              }
              state.ready = true;
              if (state.pendingOpen) {
                const open = state.pendingOpen;
                state.pendingOpen = null;
                const data = open.data;
                delete open.data;
                iframe.contentWindow.postMessage({
                  channel, type:'open', token, ...open, data,
                }, '*', [data]);
              } else if (!state.initialOpenSent) {
                state.initialOpenSent = true;
                fetch('/tests/fixtures/tracemonkey.pdf').then(response => response.arrayBuffer()).then(data => {
                  iframe.contentWindow.postMessage({
                    channel, type:'open', token, documentId, documentPath,
                    filename:'tracemonkey.pdf', autoSave:true, heavyLeaseRequired:true, openRequest:1, data,
                  }, '*', [data]);
                }).catch(error => state.errors.push(error.message));
              }
            } else if (message.type === 'opened') {
              state.opened = true;
              state.openCount += 1;
              state.lastOpenedDocumentId = message.documentId;
              state.lastOpenedAt = performance.timeOrigin + performance.now();
              state.openedSessions.push({
                documentId:message.documentId,
                openRequest:message.openRequest,
                revision:message.revision,
                confirmedRevision:message.confirmedRevision,
                dirty:message.dirty,
                restorePaused:message.restorePaused,
              });
            } else if (message.type === 'heavy-acquire') {
              const leaseRequest = {
                id: message.id,
                documentId: message.documentId,
                openRequest: message.openRequest,
                rendererGeneration: message.rendererGeneration,
              };
              state.heavyLeases.push(leaseRequest);
              if (state.holdNextHeavyLease) {
                state.holdNextHeavyLease = false;
                state.pendingHeavyLeases.push(leaseRequest);
                return;
              }
              setTimeout(() => iframe.contentWindow.postMessage({
                channel, type:'heavy-granted', token,
                ...leaseRequest,
                leaseId:'autosave-test-lease-' + state.heavyLeases.length,
              }, '*'), 0);
            } else if (message.type === 'heavy-release') {
              state.heavyLeases.push({ release:message.leaseId, documentId:message.documentId });
            } else if (message.type === 'save') {
              const save = {
                documentId: message.documentId,
                origin: message.origin,
                revision: message.revision,
                requestId: message.requestId,
                receivedAt: performance.timeOrigin + performance.now(),
                byteLength: message.data?.byteLength || 0,
                data: message.data?.slice(0),
                operations: message.operations,
                newAnnotations: message.newAnnotations,
              };
              state.saves.push(save);
              if (state.failNext) {
                state.failNext = false;
                setTimeout(() => iframe.contentWindow.postMessage({
                  channel, type:'error', token, documentId:message.documentId,
                  requestId:message.requestId, revision:message.revision,
                  code:'conflict', message:'Simulated external PDF conflict',
                }, '*'), state.failDelay);
                return;
              }
              let delay = state.saves.length === 1 && state.holdFirstAck ? 4000 : 10;
              if (state.holdNextAck) {
                state.holdNextAck = false;
                delay = state.nextAckDelay;
              }
              setTimeout(() => {
                save.acknowledgedAt = performance.timeOrigin + performance.now();
                iframe.contentWindow.postMessage({
                  channel, type:'saved', token, documentId:message.documentId,
                  requestId:message.requestId, revision:message.revision,
                }, '*');
              }, delay);
            } else if (message.type === 'recover') {
              const recovery = {
                documentId: message.documentId,
                requestId: message.requestId,
                revision: message.revision,
                reason: message.reason,
                byteLength: message.data?.byteLength || 0,
                data: message.data?.slice(0),
              };
              state.recoveries.push(recovery);
              let delay = 10;
              if (state.holdNextRecoveryAck) {
                state.holdNextRecoveryAck = false;
                delay = state.nextRecoveryAckDelay;
              }
              setTimeout(() => {
                recovery.durableAt = performance.timeOrigin + performance.now();
                iframe.contentWindow.postMessage({
                  channel, type:'recovered', token,
                  documentId:message.documentId,
                  openRequest:message.openRequest,
                  requestId:message.requestId,
                  revision:message.revision,
                  ...(message.reason === 'close-writeback'
                    ? { closeWritebackQueued:true }
                    : {}),
                }, '*');
              }, delay);
            } else if (message.type === 'error') {
              state.errors.push(message.message || message.code || 'viewer error');
            } else if (message.type === 'flushed') {
              state.lastFlush = message;
              state.flushes.push({
                id:message.id,
                ok:message.ok,
                dirty:message.dirty,
                ...(message.recovered ? { recovered:true } : {}),
              });
            } else if (message.type === 'close-prepared') {
              state.closePrepareds.push({
                id:message.id,
                documentId:message.documentId,
                openRequest:message.openRequest,
                revision:message.revision,
                ok:message.ok,
                dirty:message.dirty,
                recovered:message.recovered,
                prepared:message.prepared,
                closeWritebackQueued:message.closeWritebackQueued,
                ...(message.recovered
                  ? { receivedAt:performance.timeOrigin + performance.now() }
                  : {}),
              });
            }
          });
        </script>`);
      return;
    }

    let target;
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const popoutGeneration = url.searchParams.get("popout");
      const rendererGeneration = popoutGeneration
        ? `popup-renderer-${popoutGeneration}`
        : "initial-renderer";
      response.end(
        viewerWithBridge.replace(
          "__renderer_generation__",
          rendererGeneration,
        ),
      );
      return;
    }
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") {
      target = fixture;
    } else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
      const relative = decodeURIComponent(
        url.pathname.slice("/vendor/pdfjs-generic-legacy/".length),
      );
      target = path.resolve(root, "vendor", "pdfjs-generic-legacy", relative);
      if (!target.startsWith(path.join(root, "vendor", "pdfjs-generic-legacy") + path.sep)) {
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
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "autosave-regression" });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    let viewer = page.frames().find((frame) => frame.url().includes("/web/viewer.html"));
    assert.ok(viewer, "Viewer iframe should load from the repository source");
    await page.waitForFunction(() => window.__host?.opened, { timeout: 30_000 });
    assert.equal(
      await page.evaluate(() => window.__host.readyGenerations[0]),
      "initial-renderer",
      "The bridge ready event must echo the host-issued initial renderer generation",
    );
    await viewer.waitForSelector('.page[data-page-number="1"] .annotationEditorLayer');
    const installPointerUpProbe = async (targetViewer) => {
      await targetViewer.evaluate(
        ({ channel: messageChannel, token: sessionToken }) => {
          window.__autosaveTestPointerUpSequence = 0;
          const rendererGeneration =
            document.querySelector("script[data-renderer-generation]")?.dataset
              .rendererGeneration ?? null;
          window.addEventListener(
            "pointerup",
            (event) => {
              window.parent.postMessage(
                {
                  channel: messageChannel,
                  token: sessionToken,
                  type: "autosave-test-pointerup",
                  sequence: ++window.__autosaveTestPointerUpSequence,
                  rendererGeneration,
                  frameTime: event.timeStamp,
                  frameNow: performance.now(),
                  frameTimeOrigin: performance.timeOrigin,
                  target:
                    event.target instanceof Element
                      ? {
                          tag: event.target.tagName,
                          id: event.target.id || "",
                          className:
                            typeof event.target.className === "string"
                              ? event.target.className
                              : "",
                          inAnnotationEditorLayer: Boolean(
                            event.target.closest?.(".annotationEditorLayer"),
                          ),
                        }
                      : null,
                },
                "*",
              );
            },
            true,
          );
        },
        { channel, token },
      );
    };
    await installPointerUpProbe(viewer);

    const setSquareMode = async () => {
      await viewer.waitForFunction(() => {
        const button = document.getElementById("editorSquareButton");
        return button && !button.disabled;
      }, { timeout: 10_000 });
      if (
        (await viewer.evaluate(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode,
        )) === 5
      ) {
        return;
      }
      await viewer.evaluate(() => document.getElementById("editorSquareButton").click());
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
      );
    };
    const squarePoint = async (offset = 0) =>
      viewer.evaluate((shift) => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        const rect = layer.getBoundingClientRect();
        return {
          x: rect.left + 110 + shift,
          y: rect.top + 180 + shift,
        };
      }, offset);
    const startSquare = async (offset = 0) => {
      const pointerUpIdentity = await viewer.evaluate(
        () => ({
          sequence: window.__autosaveTestPointerUpSequence,
          rendererGeneration:
            document.querySelector("script[data-renderer-generation]")?.dataset
              .rendererGeneration ?? null,
        }),
      );
      const point = await squarePoint(offset);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + 42, point.y + 28, { steps: 5 });
      return { point, pointerUpIdentity };
    };
    const finishSquare = async ({ pointerUpIdentity }) => {
      await page.mouse.up();
      await page.waitForFunction(
        ({ sequence, rendererGeneration }) =>
          window.__host.pointerUps.some(
            (pointerUp) =>
              pointerUp.rendererGeneration === rendererGeneration &&
              pointerUp.sequence > sequence,
          ),
        { timeout: 5_000 },
        pointerUpIdentity,
      );
    };

    if (
      (await viewer.evaluate(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode,
      )) !== 5
    ) {
      await setSquareMode();
    }
    const firstPoint = await startSquare();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      0,
      "A pointer stroke must not be saved while it is still in progress",
    );
    await finishSquare(firstPoint);
    const firstPointerUp = await page.evaluate(
      (identity) =>
        window.__host.pointerUps.find(
          (pointerUp) =>
            pointerUp.rendererGeneration ===
              identity.rendererGeneration &&
            pointerUp.sequence > identity.sequence,
        ) || null,
      firstPoint.pointerUpIdentity,
    );
    assert.ok(firstPointerUp, "The host should observe the real iframe pointerup");
    await page.waitForFunction(() => window.__host.saves.length === 1, {
      timeout: 15_000,
    });

    const firstSaveState = await page.evaluate(() => window.__host.saves[0]);
    assert.equal(firstSaveState.origin, "auto");
    assert.ok(firstSaveState.byteLength > 0, "The host should receive PDF bytes");
    const idleDelayMs =
      firstSaveState.receivedAt - firstPointerUp.pointerUpAt;
    assert.ok(
      idleDelayMs >= 900,
      `Auto-save should wait for the one second idle debounce after the real iframe pointerup (elapsed ${idleDelayMs.toFixed(1)}ms; pointerup target ${JSON.stringify(firstPointerUp.target)})`,
    );

    // The first host write is deliberately held open. A real mouse-created
    // annotation must remain interactive while the host acknowledgement is
    // pending; its revision is then serialized after the first write settles.
    assert.equal(
      await viewer.evaluate(
        () =>
          PDFViewerApplication.appConfig?.appContainer?.classList.contains("wait") ||
          false,
      ),
      false,
      "A host write must not cover the viewer with PDF.js's blocking wait overlay",
    );
    const squaresBeforeHeldWrite = await viewer.evaluate(() => {
      const manager =
        PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return [...manager.getEditors(0)].filter(
        (editor) => editor.constructor?._editorType === 5,
      ).length;
    });
    const heldWriteSquarePoint = await startSquare(140);
    await finishSquare(heldWriteSquarePoint);
    await viewer.waitForFunction(
      (count) => {
        const manager =
          PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        return [...manager.getEditors(0)].filter(
          (editor) => editor.constructor?._editorType === 5,
        ).length === count + 1;
      },
      { timeout: 3_000 },
      squaresBeforeHeldWrite,
    );
    assert.equal(
      await page.evaluate(
        () => window.__host.saves[0].acknowledgedAt === undefined,
      ),
      true,
      "The real pointer edit must complete before the delayed host acknowledgement",
    );

    // An API undo during the same first write must also remain a later dirty
    // revision and queue behind its acknowledgement.
    await viewer.evaluate(() => {
      const manager =
        PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      manager.undo();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      1,
      "Edits during an auto flight must not send another host write before it settles",
    );
    await page
      .waitForFunction(() => window.__host.saves.length === 2, {
        timeout: 15_000,
      })
      .catch(async (error) => {
        console.error(
          "Auto-save host state:",
          await page.evaluate(() => window.__host),
        );
        console.error(
          "Auto-save viewer state:",
          await viewer.evaluate(() => ({
            changes: PDFViewerApplication._hasChanges(),
            annotationStorageModified:
              PDFViewerApplication._annotationStorageModified,
            storageSize: PDFViewerApplication.pdfDocument.annotationStorage.size,
            mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
            layers: document.querySelectorAll(".annotationEditorLayer .squareEditor").length,
          })),
        );
        throw error;
      });
    const saves = await page.evaluate(() => window.__host.saves);
    assert.ok(saves[1].revision > saves[0].revision);
    assert.ok(
      saves[1].receivedAt - saves[0].acknowledgedAt >= 900,
      "The latest revision must re-enter the one second idle debounce after the earlier flight settles",
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // Redo a changed revision, then verify Cmd+S bypasses the auto-save delay.
    const updateAndRemove = await viewer.evaluate(() => {
      const storage = PDFViewerApplication.pdfDocument.annotationStorage;
      const manager =
        PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      manager.redo();
      document.body.focus();
      const editor = Array.from(manager.getEditors(0))[0];
      if (!editor) {
        return { editorCount: 0, updated: false, removed: false };
      }
      const annotationId = `autosave-test-${Date.now()}`;
      editor.annotationElementId = annotationId;
      storage.setValue(editor.id, editor);
      editor.comment = "";
      const updated = storage.updateEditor(annotationId, {
        popup: { contents: "Autosave comment update", deleted: false },
      });
      const existed = storage.has(editor.id);
      storage.remove(editor.id);
      return {
        editorCount: 1,
        updated,
        removed: existed && !storage.has(editor.id),
      };
    });
    assert.equal(updateAndRemove.editorCount, 1, JSON.stringify(updateAndRemove));
    assert.equal(updateAndRemove.updated, true);
    assert.equal(updateAndRemove.removed, true);
    await viewer.evaluate(() => {
      document.body.focus();
    });
    const hotkeyAt = await page.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    await page.keyboard.down("Meta");
    await page.keyboard.press("s");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => window.__host.saves.length === 3, {
      timeout: 5_000,
    });
    const thirdSave = await page.evaluate(() => window.__host.saves[2]);
    assert.equal(thirdSave.origin, "manual");
    assert.ok(thirdSave.receivedAt - hotkeyAt < 1000);
    await viewer
      .waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 5_000 })
      .catch(async (error) => {
        console.error("Hotkey save host state:", await page.evaluate(() => window.__host));
        console.error(
          "Hotkey save viewer state:",
          await viewer.evaluate(() => ({
            changes: PDFViewerApplication._hasChanges(),
            modified: PDFViewerApplication._annotationStorageModified,
            storageSize: PDFViewerApplication.pdfDocument.annotationStorage.size,
            classes: PDFViewerApplication.appConfig?.appContainer?.className,
          })),
        );
        throw error;
      });

    // A pen stroke that finishes while a manual write waits for its Vault ACK
    // must be committed on the next revision boundary, then settle without an
    // unbounded save loop or a close request waiting forever.
    const saveCountBeforeHeldInk = await page.evaluate(() => {
      window.__host.holdNextAck = true;
      window.__host.nextAckDelay = 1_800;
      return window.__host.saves.length;
    });
    await viewer.evaluate(() => {
      const app = PDFViewerApplication;
      app.pdfViewer._layerProperties.annotationEditorUIManager.undo();
      document.body.focus();
      document.getElementById("editorInkButton").click();
    });
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
      { timeout: 5_000 },
    );
    await viewer.waitForFunction(() => {
      const page = document.querySelector('.page[data-page-number="1"]');
      const layer = PDFViewerApplication.pdfViewer.getPageView(0)?.annotationEditorLayer?.div;
      const rect = page?.getBoundingClientRect();
      return Boolean(
        layer?.isConnected && rect?.width > 0 && rect?.bottom > 0 &&
        rect?.top < window.innerHeight
      );
    }, { timeout: 10_000 });
    const penPoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 360, y: rect.top + 260 };
    });
    const iframeOffset = await page.$eval("iframe", (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    const penX = iframeOffset.x + penPoint.x;
    const penY = iframeOffset.y + penPoint.y;
    const heldInkCdp = await page.createCDPSession();
    const sendPen = (type, x, y) => heldInkCdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      pointerType: "pen",
      force: type === "mouseReleased" ? 0 : 0.6,
    });
    try {
      await page.keyboard.down("Meta");
      await page.keyboard.press("s");
      await page.keyboard.up("Meta");
      await page.waitForFunction(
        (count) => window.__host.saves.length === count + 1,
        { timeout: 5_000 },
        saveCountBeforeHeldInk,
      );
      const heldInkFirstSave = await page.evaluate(() => window.__host.saves.at(-1));
      assert.equal(heldInkFirstSave.origin, "manual");
      assert.equal(heldInkFirstSave.acknowledgedAt, undefined,
        "The first manual write should still be waiting for its host ACK");

      const storageSizeBeforePen = await viewer.evaluate(() =>
        PDFViewerApplication.pdfDocument.annotationStorage.size,
      );
      await sendPen("mousePressed", penX, penY);
      for (let step = 1; step <= 8; step += 1) {
        await sendPen("mouseMoved", penX + step * 8, penY + step * 4);
      }
      await sendPen("mouseReleased", penX + 64, penY + 32);
      await viewer.waitForFunction(
        (size) => PDFViewerApplication.pdfDocument.annotationStorage.size > size,
        { timeout: 5_000 },
        storageSizeBeforePen,
      );

      await page.waitForFunction(
        (count) => window.__host.saves.length === count + 2,
        { timeout: 10_000 },
        saveCountBeforeHeldInk,
      );
      const heldInkSaves = await page.evaluate((count) =>
        window.__host.saves.slice(count), saveCountBeforeHeldInk);
      assert.equal(heldInkSaves[1].origin, "manual");
      assert.ok(heldInkSaves[1].revision > heldInkSaves[0].revision,
        "The post-ACK write should cover the pen stroke's later revision");
      assert.ok(heldInkSaves[1].newAnnotations?.some((entry) => entry.kind === "Ink"),
        "The post-ACK serialization should include the committed Ink editor");
      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), {
        timeout: 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      assert.equal(await page.evaluate((count) => window.__host.saves.length, saveCountBeforeHeldInk),
        saveCountBeforeHeldInk + 2,
        "The settled manual save must not emit another write for the same revision");

      await page.evaluate(() => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel,
          type: "prepare-close",
          token,
          documentId,
          openRequest: 1,
          reason: "detach",
          id: "prepare-close-after-held-ink-save",
        }, "*");
      });
      await page.waitForFunction(() => window.__host.closePrepareds.some(
        (entry) => entry.id === "prepare-close-after-held-ink-save",
      ), { timeout: 10_000 });
      const closeAfterHeldInk = await page.evaluate(() =>
        window.__host.closePrepareds.find(
          (entry) => entry.id === "prepare-close-after-held-ink-save",
        ));
      assert.equal(closeAfterHeldInk.ok, true);
      assert.equal(closeAfterHeldInk.dirty, false);
      await page.evaluate(() => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel,
          type: "cancel-close",
          token,
          documentId,
          openRequest: 1,
          id: "prepare-close-after-held-ink-save",
        }, "*");
      });
      await viewer.waitForFunction(() =>
        !PDFViewerApplication.appConfig.appContainer.hasAttribute("inert"),
      );
    } finally {
      await heldInkCdp.detach().catch(() => {});
    }

    // Build another dirty revision, start an IME composition, then press Cmd+S.
    // The bridge must hold the request until compositionend.
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo();
    });
    await viewer.evaluate(() => {
      window.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          code: "KeyS",
          metaKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      5,
      "Both auto-save and Cmd+S must wait while IME composition is active",
    );
    await viewer.evaluate(() =>
      window.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await page.waitForFunction(() => window.__host.saves.length === 6, {
      timeout: 5_000,
    });
    const fourthSave = await page.evaluate(() => window.__host.saves[5]);
    assert.equal(fourthSave.origin, "manual");
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // A lifecycle flush waits through an active IME composition instead of
    // closing over an incomplete edit.
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo();
      window.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel, type: "flush", token, documentId, id: "flush-ime-boundary",
      }, "*");
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await page.evaluate(() => window.__host.flushes.length), 0);
    assert.equal(await page.evaluate(() => window.__host.saves.length), 6);
    await viewer.evaluate(() =>
      window.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await page.waitForFunction(() => window.__host.flushes.length === 1);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[0]),
      { id: "flush-ime-boundary", ok: true, dirty: false },
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 7);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // A close flush waits for a pointer gesture to finish, then writes the
    // completed annotation and reports a clean result to the host.
    await setSquareMode();
    const closePoint = await startSquare(150);
    await page.evaluate(() => {
      const iframe = document.querySelector("iframe");
      iframe.contentWindow.postMessage({
        channel,
        type: "flush",
        token,
        documentId,
        id: "flush-auto-close",
      }, "*");
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await page.evaluate(() => window.__host.flushes.length), 1);
    assert.equal(await page.evaluate(() => window.__host.saves.length), 7);
    await finishSquare(closePoint);
    await page.waitForFunction(() => window.__host.flushes.length === 2);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[1]),
      { id: "flush-auto-close", ok: true, dirty: false },
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 8);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // A controlled close blocks new pointer edits and can finish once its
    // latest recovery is durable, without waiting for the older save ACK.
    const recoveriesBeforeHeldClose = await page.evaluate(
      () => window.__host.recoveries.length,
    );
    await page.evaluate(() => {
      window.__host.holdNextAck = true;
      window.__host.nextAckDelay = 2_200;
      window.__host.holdNextRecoveryAck = true;
      window.__host.nextRecoveryAckDelay = 1_000;
    });
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo();
    });
    await page.waitForFunction(() => window.__host.saves.length === 9, {
      timeout: 5_000,
    });
    if (
      (await viewer.evaluate(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode,
      )) !== 5
    ) {
      await setSquareMode();
    }
    const squaresBeforeControlledClose = await viewer.evaluate(() => {
      const manager =
        PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return [...manager.getEditors(0)].filter(
        (editor) => editor.constructor?._editorType === 5,
      ).length;
    });
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "prepare-close",
        token,
        documentId,
        openRequest: 1,
        reason: "detach",
        id: "prepare-close-held-save",
      }, "*");
    });
    const blockedClosePoint = await startSquare(205);
    await finishSquare(blockedClosePoint);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      await viewer.evaluate(() => {
        const manager =
          PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        return [...manager.getEditors(0)].filter(
          (editor) => editor.constructor?._editorType === 5,
        ).length;
      }),
      squaresBeforeControlledClose,
      "A new real pointer gesture must not create an annotation during controlled close",
    );
    assert.equal(
      await page.evaluate(() => window.__host.closePrepareds.length),
      1,
      "The host must not receive a prepared acknowledgement before the recovery is durable",
    );
    const pendingCloseRecovery = await page.evaluate(
      (index) => window.__host.recoveries[index],
      recoveriesBeforeHeldClose,
    );
    assert.equal(pendingCloseRecovery.reason, "close-writeback");
    assert.equal(pendingCloseRecovery.durableAt, undefined);
    await page.waitForFunction(() => window.__host.closePrepareds.length === 2, {
      timeout: 10_000,
    });
    const heldClose = await page.evaluate(
      () => window.__host.closePrepareds[1],
    );
    const durableCloseRecovery = await page.evaluate(
      (index) => window.__host.recoveries[index],
      recoveriesBeforeHeldClose,
    );
    assert.equal(heldClose.id, "prepare-close-held-save");
    assert.equal(heldClose.documentId, documentId);
    assert.equal(heldClose.openRequest, 1);
    assert.equal(heldClose.ok, false);
    assert.equal(heldClose.dirty, true);
    assert.equal(heldClose.recovered, true);
    assert.equal(heldClose.closeWritebackQueued, true);
    assert.ok(durableCloseRecovery.durableAt <= heldClose.receivedAt);
    assert.equal(
      heldClose.revision,
      durableCloseRecovery.revision,
    );
    assert.equal(
      heldClose.revision,
      await page.evaluate(() => window.__host.saves[8].revision),
    );
    assert.equal(
      await page.evaluate(() => window.__host.saves[8].acknowledgedAt),
      undefined,
      "A durable close recovery must not wait for the older ordinary-save ACK",
    );
    assert.equal(heldClose.prepared, true);
    assert.equal(
      await viewer.evaluate(() =>
        PDFViewerApplication.appConfig.appContainer.hasAttribute("inert"),
      ),
      true,
      "The prepared viewer must be inert before the host begins teardown",
    );
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "cancel-close",
        token,
        documentId,
        openRequest: 1,
        id: "prepare-close-held-save",
      }, "*");
    });
    await viewer.waitForFunction(() =>
      !PDFViewerApplication.appConfig.appContainer.hasAttribute("inert"),
    );
    const squaresAfterCancel = await viewer.evaluate(() => {
      const manager =
        PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return [...manager.getEditors(0)].filter(
        (editor) => editor.constructor?._editorType === 5,
      ).length;
    });
    const resumedPoint = await startSquare(215);
    await finishSquare(resumedPoint);
    await viewer.waitForFunction(
      (count) => {
        const manager =
          PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        return [...manager.getEditors(0)].filter(
          (editor) => editor.constructor?._editorType === 5,
        ).length === count + 1;
      },
      { timeout: 3_000 },
      squaresAfterCancel,
    );
    await page.waitForFunction(() => window.__host.saves.length === 10, {
      timeout: 10_000,
    });
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // Closing during a focused FreeText IME composition waits for composition
    // completion, then commits and blurs without relying on a later user blur.
    await viewer.evaluate(() =>
      document.getElementById("editorFreeTextButton").click(),
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
    );
    const imeFreeTextPoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 300, y: rect.top + 350 };
    });
    await page.mouse.click(imeFreeTextPoint.x, imeFreeTextPoint.y);
    await viewer.waitForSelector(freeTextSelector);
    await viewer.type(freeTextSelector, "Close composition text");
    await viewer.evaluate(() => {
      const editor = document.querySelector(
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
      );
      editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "prepare-close",
        token,
        documentId,
        openRequest: 1,
        reason: "detach",
        id: "prepare-close-ime",
      }, "*");
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(await page.evaluate(() => window.__host.closePrepareds.length), 2);
    await viewer.evaluate(() => {
      document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal')
        .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__host.closePrepareds.length === 3, {
      timeout: 10_000,
    });
    const imeClose = await page.evaluate(() => window.__host.closePrepareds[2]);
    assert.equal(imeClose.prepared, true);
    assert.equal(imeClose.ok, false);
    assert.equal(imeClose.dirty, true);
    assert.equal(imeClose.recovered, true);
    assert.equal(imeClose.closeWritebackQueued, true);
    assert.equal(imeClose.openRequest, 1);
    const imeRecovery = await page.evaluate(() =>
      window.__host.recoveries.filter(
        (recovery) => recovery.reason === "close-writeback",
      ).at(-1),
    );
    assert.ok(imeRecovery.byteLength > 0);
    assert.ok(imeRecovery.durableAt <= imeClose.receivedAt);
    assert.equal(imeRecovery.revision, imeClose.revision);
    assert.equal(
      await viewer.evaluate(() =>
        document.activeElement.matches?.(".freeTextEditor .internal") || false,
      ),
      false,
      "A controlled close must commit and blur FreeText after compositionend",
    );
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "cancel-close",
        token,
        documentId,
        openRequest: 1,
        id: "prepare-close-ime",
      }, "*");
    });
    await viewer.waitForFunction(() =>
      !PDFViewerApplication.appConfig.appContainer.hasAttribute("inert"),
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // Disable autosave while PDF.js is serializing. The bridge must retain
    // dirty state and avoid sending an auto-origin request the host has not
    // accepted yet.
    await viewer.evaluate(() => {
      const pdfDocument = PDFViewerApplication.pdfDocument;
      const original = pdfDocument.saveDocument;
      const hold = window.__heldAutoSerialization = {
        started: false,
        release: null,
        original,
      };
      pdfDocument.saveDocument = function (...args) {
        hold.started = true;
        return new Promise((resolve, reject) => {
          hold.release = () => {
            Promise.resolve(original.apply(pdfDocument, args)).then(resolve, reject);
          };
        });
      };
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo();
    });
    await viewer.waitForFunction(() => window.__heldAutoSerialization.started, {
      timeout: 5_000,
    });
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "configure-auto-save",
        token,
        documentId,
        enabled: false,
      }, "*");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await viewer.evaluate(() => {
      const pdfDocument = PDFViewerApplication.pdfDocument;
      const hold = window.__heldAutoSerialization;
      hold.release();
      pdfDocument.saveDocument = hold.original;
    });
    // Restore the original method so subsequent manual/recovery writes are
    // normal.
    await viewer.waitForFunction(() => !PDFViewerApplication._saveInProgress, {
      timeout: 10_000,
    });
    assert.equal(await page.evaluate(() => window.__host.saves.length), 11);
    assert.equal(
      await viewer.evaluate(() => PDFViewerApplication._hasChanges()),
      true,
      "A canceled auto-origin serialization must leave the PDF dirty",
    );
    const savesAfterDisable = await page.evaluate(() => window.__host.saves);
    assert.equal(
      savesAfterDisable.length,
      11,
      `Disabling auto-save must stop idle writes; got ${JSON.stringify(savesAfterDisable)}`,
    );
    await page.evaluate(() => {
      const iframe = document.querySelector("iframe");
      iframe.contentWindow.postMessage({
        channel,
        type: "flush",
        token,
        documentId,
        id: "flush-disabled",
      }, "*");
    });
    await page.waitForFunction(() => window.__host.flushes.length === 3);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[2]),
      { id: "flush-disabled", ok: false, dirty: true, recovered: true },
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 11);
    const disabledRecovery = await page.evaluate(() =>
      window.__host.recoveries.filter(
        (recovery) => recovery.reason === "auto-save-disabled",
      ).at(-1),
    );
    assert.equal(disabledRecovery.reason, "auto-save-disabled");
    assert.ok(disabledRecovery.byteLength > 0);
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "prepare-close",
        token,
        documentId,
        openRequest: 1,
        reason: "detach",
        id: "prepare-close-disabled-recovery",
      }, "*");
    });
    await page.waitForFunction(() => window.__host.closePrepareds.length === 4, {
      timeout: 10_000,
    });
    const disabledClose = await page.evaluate(
      () => window.__host.closePrepareds[3],
    );
    assert.equal(disabledClose.id, "prepare-close-disabled-recovery");
    assert.equal(disabledClose.documentId, documentId);
    assert.equal(disabledClose.openRequest, 1);
    assert.equal(disabledClose.ok, false);
    assert.equal(disabledClose.dirty, true);
    assert.equal(disabledClose.recovered, true);
    assert.equal(disabledClose.prepared, true);
    assert.equal(
      disabledClose.revision,
      disabledRecovery.revision,
    );
    assert.equal(
      await viewer.evaluate(() =>
        PDFViewerApplication.appConfig.appContainer.hasAttribute("inert"),
      ),
      true,
      "A durable recovery candidate must also keep the close-prepared viewer inert",
    );
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "cancel-close",
        token,
        documentId,
        openRequest: 1,
        id: "prepare-close-disabled-recovery",
      }, "*");
    });
    await viewer.waitForFunction(() =>
      !PDFViewerApplication.appConfig.appContainer.hasAttribute("inert"),
    );
    assert.equal(
      await viewer.evaluate(() => PDFViewerApplication._hasChanges()),
      true,
      "Canceling close after recovery must retain the dirty editing session",
    );

    // An explicit manual save still works while the setting is disabled.
    await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
    await page.waitForFunction(() => window.__host.saves.length === 12);
    assert.equal(
      await page.evaluate(() => window.__host.saves[11].origin),
      "manual",
    );
    await viewer
      .waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 5_000 })
      .catch(async (error) => {
        console.error("Manual save host state:", await page.evaluate(() => window.__host));
        console.error(
          "Manual save viewer state:",
          await viewer.evaluate(() => ({
            changes: PDFViewerApplication._hasChanges(),
            modified: PDFViewerApplication._annotationStorageModified,
            storageSize: PDFViewerApplication.pdfDocument.annotationStorage.size,
            classes: PDFViewerApplication.appConfig?.appContainer?.className,
          })),
        );
        throw error;
      });

    await page.evaluate(() => {
      const iframe = document.querySelector("iframe");
      iframe.contentWindow.postMessage({
        channel,
        type: "flush",
        token,
        documentId,
        id: "flush-clean-disabled",
      }, "*");
    });
    await page.waitForFunction(() => window.__host.flushes.length === 4);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[3]),
      { id: "flush-clean-disabled", ok: true, dirty: false },
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 12);

    // A host conflict pauses autosave. If a newer edit occurs while the
    // conflicting write is still pending, close recovery must capture that
    // latest revision without retrying the original-PDF overwrite.
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.redo();
    });
    await page.evaluate(() => {
      window.__host.failNext = true;
      window.__host.failDelay = 800;
    });
    await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
    await page.waitForFunction(() => window.__host.saves.length === 13);
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo();
    });
    await page.evaluate(() => {
      const iframe = document.querySelector("iframe");
      iframe.contentWindow.postMessage({
        channel,
        type: "flush",
        token,
        documentId,
        id: "flush-conflict",
      }, "*");
    });
    await page.waitForFunction(() => window.__host.flushes.length === 5);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[4]),
      { id: "flush-conflict", ok: false, dirty: true, recovered: true },
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 13);
    const conflictRecovery = await page.evaluate(() =>
      window.__host.recoveries.filter(
        (recovery) => recovery.reason === "save-conflict",
      ).at(-1),
    );
    assert.equal(conflictRecovery.reason, "save-conflict");
    assert.ok(conflictRecovery.byteLength > 0);
    assert.ok(
      conflictRecovery.revision >
        (await page.evaluate(() => window.__host.saves[12].revision)),
      "Recovery must serialize the edit made while the original save was pending",
    );
    await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
    await page.waitForFunction(() => window.__host.saves.length === 14);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // Once a disabled dirty revision has a durable recovery candidate, a new
    // PDF may replace it in the same reader view. The unrecovered dirty guard
    // remains in force for every other case.
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo();
    });
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel, type: "flush", token, documentId,
        id: "flush-before-session-switch",
      }, "*");
    });
    await page.waitForFunction(() => window.__host.flushes.length === 6);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[5]),
      {
        id: "flush-before-session-switch",
        ok: false,
        dirty: true,
        recovered: true,
      },
    );
    const switchRecovery = await page.evaluate(() =>
      window.__host.recoveries.filter(
        (recovery) => recovery.reason === "auto-save-disabled",
      ).at(-1),
    );
    assert.equal(switchRecovery.documentId, documentId);
    assert.equal(switchRecovery.reason, "auto-save-disabled");

    await page.evaluate(async () => {
      const data = await fetch("/tests/fixtures/tracemonkey.pdf").then((r) => r.arrayBuffer());
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "open",
        token,
        documentId: "test-session-2",
        documentPath: "tests/fixtures/second-session.pdf",
        filename: "second-session.pdf",
        autoSave: false,
        openRequest: 2,
        data,
      }, "*", [data]);
    });
    await page.waitForFunction(() => window.__host.openCount === 2, {
      timeout: 10_000,
    });
    assert.equal(
      await page.evaluate(() => window.__host.lastOpenedDocumentId),
      "test-session-2",
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // A host may request close after it has assigned a new session but before
    // PDF.js activates it. With no older dirty/pending session, that empty
    // loading state can be prepared safely without impersonating the new doc.
    await page.evaluate(async () => {
      const data = await fetch("/tests/fixtures/tracemonkey.pdf").then((r) =>
        r.arrayBuffer(),
      );
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "open",
        token,
        documentId: "test-session-3",
        documentPath: "tests/fixtures/third-session.pdf",
        filename: "third-session.pdf",
        autoSave: false,
        openRequest: 3,
        data,
      }, "*", [data]);
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "prepare-close",
        token,
        documentId: "test-session-3",
        openRequest: 3,
        reason: "detach",
        id: "prepare-close-before-open",
      }, "*");
    });
    await page.waitForFunction(() => window.__host.closePrepareds.length === 5, {
      timeout: 5_000,
    });
    const emptyClose = await page.evaluate(
      () => window.__host.closePrepareds[4],
    );
    assert.deepEqual(emptyClose, {
      id: "prepare-close-before-open",
      documentId: "test-session-3",
      openRequest: 3,
      revision: 0,
      ok: true,
      dirty: false,
      recovered: false,
      prepared: true,
    });
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "cancel-close",
        token,
        documentId: "test-session-3",
        openRequest: 3,
        id: "prepare-close-before-open",
      }, "*");
    });
    await viewer.waitForFunction(() =>
      !PDFViewerApplication.appConfig.appContainer.hasAttribute("inert"),
    );
    await page.waitForFunction(() => window.__host.openCount === 3, {
      timeout: 10_000,
    });
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // Create a real PDF-backed editor, then have the host prepare its
    // auto-save-disabled recovery candidate before reloading the iframe.
    await setSquareMode();
    const migrationSquarePoint = await startSquare(210);
    await finishSquare(migrationSquarePoint);
    const disabledRecoveryIndex = await page.evaluate(
      () => window.__host.recoveries.length,
    );
    const closePreparedCount = await page.evaluate(
      () => window.__host.closePrepareds.length + 1,
    );
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "prepare-close",
        token,
        documentId: "test-session-3",
        openRequest: 3,
        reason: "detach",
        id: "prepare-close-popout-draft",
      }, "*");
    });
    await page.waitForFunction(
      (count) => window.__host.closePrepareds.length === count,
      { timeout: 10_000 },
      closePreparedCount,
    );
    const disabledRecoveryClose = await page.evaluate(
      () => window.__host.closePrepareds.at(-1),
    );
    const popoutDisabledRecovery = await page.evaluate(
      (index) => window.__host.recoveries[index],
      disabledRecoveryIndex,
    );
    assert.equal(disabledRecoveryClose.prepared, true);
    assert.equal(disabledRecoveryClose.dirty, true);
    assert.equal(disabledRecoveryClose.recovered, true);
    assert.equal(disabledRecoveryClose.openRequest, 3);
    assert.equal(disabledRecoveryClose.revision, popoutDisabledRecovery.revision);
    assert.equal(popoutDisabledRecovery.reason, "auto-save-disabled");
    assert.ok(popoutDisabledRecovery.byteLength > 0);

    // A popout reload creates a fresh bridge realm. Reopening serialized
    // recovery bytes must restore the old dirty revision instead of treating
    // those bytes as the new clean baseline.
    const reopenFreshRealmWithDraft = async ({
      openRequest,
      revision,
      confirmedRevision,
      autoSave,
      restorePaused,
      recoveryIndex,
    }) => {
      const expectedOpenCount =
        (await page.evaluate(() => window.__host.openCount)) + 1;
      await page.evaluate(
        ({ openRequest, revision, confirmedRevision, autoSave, restorePaused, recoveryIndex }) => {
          const state = window.__host;
          const recovery = state.recoveries[recoveryIndex];
          if (!recovery?.data?.byteLength) {
            throw new Error("The test recovery candidate has no PDF bytes.");
          }
          state.pendingOpen = {
            documentId: "test-session-3",
            documentPath: "tests/fixtures/third-session.pdf",
            filename: "third-session.pdf",
            openRequest,
            revision,
            confirmedRevision,
            restoreDirty: true,
            restorePaused,
            autoSave,
            data: recovery.data.slice(0),
          };
          state.expectedRendererGeneration = `popup-renderer-${openRequest}`;
          document.querySelector("iframe").src =
            `/vendor/pdfjs-generic-legacy/web/viewer.html?popout=${openRequest}`;
        },
        {
          openRequest,
          revision,
          confirmedRevision,
          autoSave,
          restorePaused,
          recoveryIndex,
        },
      );
      await page.waitForFunction(
        (count) => window.__host.openCount === count,
        { timeout: 20_000 },
        expectedOpenCount,
      );
      const readyState = await page.evaluate(() => ({
        expected: window.__host.expectedRendererGeneration,
        received: window.__host.readyGenerations.at(-1),
        ignored: window.__host.ignoredReadyGenerations,
      }));
      assert.equal(readyState.received, readyState.expected);
      assert.deepEqual(readyState.ignored, []);
      viewer = page
        .frames()
        .find(
          (frame) =>
            !frame.isDetached() && frame.url().includes("/web/viewer.html"),
        );
      assert.ok(viewer, "The reloaded viewer realm should be attached");
      await viewer.waitForFunction(
        () => window.PDFViewerApplication?.pdfDocument,
        { timeout: 15_000 },
      );
      await viewer.waitForSelector(
        '.page[data-page-number="1"] .annotationEditorLayer',
        { timeout: 15_000 },
      );
      await installPointerUpProbe(viewer);
      const restoredState = await viewer.evaluate(() => {
        const manager =
          PDFViewerApplication.pdfViewer._layerProperties
            .annotationEditorUIManager;
        return {
          hasChanges: PDFViewerApplication._hasChanges(),
          modified: PDFViewerApplication._annotationStorageModified === true,
          storageSize:
            PDFViewerApplication.pdfDocument.annotationStorage.size,
          editorCount: [...manager.getEditors(0)].length,
          squareEditorCount: document.querySelectorAll(
            '.annotationEditorLayer .squareEditor',
          ).length,
        };
      });
      assert.equal(
        restoredState.hasChanges,
        true,
        `The restored serialized revision must remain dirty: ${JSON.stringify(restoredState)}`,
      );
      const opened = await page.evaluate(
        () => window.__host.openedSessions.at(-1),
      );
      assert.deepEqual(opened, {
        documentId: "test-session-3",
        openRequest,
        revision,
        confirmedRevision,
        dirty: true,
        restorePaused,
      });
    };

    await reopenFreshRealmWithDraft({
      openRequest: 4,
      revision: popoutDisabledRecovery.revision,
      confirmedRevision: 0,
      autoSave: false,
      restorePaused: false,
      recoveryIndex: disabledRecoveryIndex,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      14,
      "Opening a dirty recovery candidate with autosave off must not write the original PDF",
    );
    await viewer.evaluate(() => document.body.focus());
    await page.keyboard.down("Meta");
    await page.keyboard.press("s");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => window.__host.saves.length === 15, {
      timeout: 5_000,
    });
    const restoredManualSave = await page.evaluate(
      () => window.__host.saves[14],
    );
    assert.equal(restoredManualSave.origin, "manual");
    assert.equal(
      restoredManualSave.revision,
      popoutDisabledRecovery.revision,
      "Cmd+S on the restored draft must save its current revision even with no subsequent edit",
    );
    assert.ok(restoredManualSave.byteLength > 0);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // A conflict-paused autosave session can also reload its latest recovery
    // bytes. The enabled preference must not silently overwrite the original
    // until the user explicitly invokes Cmd+S.
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "configure-auto-save",
        token,
        enabled: true,
      }, "*");
      window.__host.failNext = true;
      window.__host.failDelay = 10;
    });
    await setSquareMode();
    const conflictSquarePoint = await startSquare(250);
    await finishSquare(conflictSquarePoint);
    await page.waitForFunction(() => window.__host.saves.length === 16, {
      timeout: 10_000,
    });
    assert.equal(
      await page.evaluate(() => window.__host.saves[15].origin),
      "auto",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      16,
      "A failed auto-origin save must stay paused instead of retrying silently",
    );
    const pausedRecoveryIndex = await page.evaluate(
      () => window.__host.recoveries.length,
    );
    const pausedClosePreparedCount = await page.evaluate(
      () => window.__host.closePrepareds.length + 1,
    );
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel,
        type: "prepare-close",
        token,
        documentId: "test-session-3",
        openRequest: 4,
        reason: "detach",
        id: "prepare-close-paused-popout-draft",
      }, "*");
    });
    await page.waitForFunction(
      (count) => window.__host.closePrepareds.length === count,
      { timeout: 10_000 },
      pausedClosePreparedCount,
    );
    const pausedClose = await page.evaluate(
      () => window.__host.closePrepareds.at(-1),
    );
    const pausedRecovery = await page.evaluate(
      (index) => window.__host.recoveries[index],
      pausedRecoveryIndex,
    );
    assert.equal(pausedClose.prepared, true);
    assert.equal(pausedClose.dirty, true);
    assert.equal(pausedClose.recovered, true);
    assert.equal(pausedClose.revision, pausedRecovery.revision);
    assert.equal(pausedRecovery.reason, "save-conflict");
    assert.ok(pausedRecovery.byteLength > 0);

    await reopenFreshRealmWithDraft({
      openRequest: 5,
      revision: pausedRecovery.revision,
      confirmedRevision: popoutDisabledRecovery.revision,
      autoSave: true,
      restorePaused: true,
      recoveryIndex: pausedRecoveryIndex,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      16,
      "A restored conflict pause must suppress autosave after the viewer realm reloads",
    );
    await viewer.evaluate(() => document.body.focus());
    await page.keyboard.down("Meta");
    await page.keyboard.press("s");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => window.__host.saves.length === 17, {
      timeout: 5_000,
    });
    const pausedManualSave = await page.evaluate(
      () => window.__host.saves[16],
    );
    assert.equal(pausedManualSave.origin, "manual");
    assert.equal(pausedManualSave.revision, pausedRecovery.revision);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // FreeText autosave commits only after one idle second, preserves focus
    // and the caret, then serializes a later edit after the held host ack.
    const beforeFreeTextSaves = await page.evaluate(() => {
      window.__host.holdNextAck = true;
      window.__host.nextAckDelay = 2_800;
      return window.__host.saves.length;
    });
    await viewer.evaluate(() => {
      window.__freeTextEditorMoves = 0;
      PDFViewerApplication.eventBus._on("editormovedindom", () => {
        window.__freeTextEditorMoves += 1;
      });
    });
    await viewer.evaluate(() =>
      document.getElementById("editorFreeTextButton").click(),
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
    );
    const freeTextPoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 260, y: rect.top + 320 };
    });
    const freeTextPointerUpIdentity = await viewer.evaluate(() => ({
      sequence: window.__autosaveTestPointerUpSequence,
      rendererGeneration:
        document.querySelector("script[data-renderer-generation]")?.dataset
          .rendererGeneration ?? null,
    }));
    await page.mouse.click(freeTextPoint.x, freeTextPoint.y);
    await viewer.waitForFunction(
      ({ sequence, rendererGeneration }) =>
        document.querySelector("script[data-renderer-generation]")?.dataset
          .rendererGeneration === rendererGeneration &&
        window.__autosaveTestPointerUpSequence > sequence,
      { timeout: 5_000 },
      freeTextPointerUpIdentity,
    );
    await viewer.waitForSelector(freeTextSelector);
    await viewer.waitForFunction(
      () =>
        window.__freeTextEditorMoves > 0 &&
        document.activeElement ===
          document.querySelector(
            '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
          ),
      { timeout: 5_000 },
    );
    await viewer.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.keyboard.type("Autosave test text");
    const caretBeforeIdleCommit = await viewer.evaluate(() => {
      const editor = document.querySelector(
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
      );
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (selection?.rangeCount && editor?.contains(selection.anchorNode)) {
        range.setEnd(selection.anchorNode, selection.anchorOffset);
      }
      return {
        focused: document.activeElement === editor,
        caretOffset: range.toString().length,
        text: editor?.textContent,
      };
    });
    assert.deepEqual(
      caretBeforeIdleCommit,
      {
        focused: true,
        caretOffset: "Autosave test text".length,
        text: "Autosave test text",
      },
      "The FreeText editor must be stable and at the end of the text before the idle-save check",
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeFreeTextSaves,
      "FreeText must remain unsaved until one second after the latest input",
    );

    try {
      await page.waitForFunction(
        (count) => window.__host.saves.length === count + 1,
        { timeout: 5_000 },
        beforeFreeTextSaves,
      );
    } catch (error) {
      const diagnostics = await viewer.evaluate(() => ({
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        hasChanges: PDFViewerApplication._hasChanges(),
        activeElement: document.activeElement?.outerHTML?.slice(0, 300) ?? null,
        editorText: document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
        )?.textContent ?? null,
      }));
      const hostDiagnostics = await page.evaluate(() => ({
        saves: window.__host.saves,
        errors: window.__host.errors,
      }));
      error.message += `\nBridge state after focused FreeText idle save timeout: ${JSON.stringify(diagnostics)}\nHost state: ${JSON.stringify(hostDiagnostics)}`;
      throw error;
    }
    const firstFreeTextSave = await page.evaluate(
      (index) => window.__host.saves[index],
      beforeFreeTextSaves,
    );
    assert.equal(firstFreeTextSave.origin, "auto");
    assert.ok(firstFreeTextSave.byteLength > 0);
    await viewer.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const firstIdleCaretState = await viewer.evaluate(() => {
        const editor = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
        );
        const selection = window.getSelection();
        const caretRange = document.createRange();
        caretRange.selectNodeContents(editor);
        if (selection?.rangeCount && editor?.contains(selection.anchorNode)) {
          caretRange.setEnd(selection.anchorNode, selection.anchorOffset);
        }
        return {
          focused: document.activeElement === editor,
          caretInsideEditor: !!(
            selection?.isCollapsed && editor?.contains(selection.anchorNode)
          ),
          caretOffset: caretRange.toString().length,
          text: editor?.textContent,
        };
      });
    assert.deepEqual(
      firstIdleCaretState,
      {
        focused: true,
        caretInsideEditor: true,
        caretOffset: "Autosave test text".length,
        text: "Autosave test text",
      },
      "A FreeText idle commit must retain editor focus and the insertion point",
    );

    await page.keyboard.type(" continued");
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeFreeTextSaves + 1,
      "Typing during a host write must stay dirty and wait behind its acknowledgement",
    );
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 2,
      { timeout: 5_000 },
      beforeFreeTextSaves,
    );
    const freeTextSaves = await page.evaluate(
      (index) => window.__host.saves.slice(index, index + 2),
      beforeFreeTextSaves,
    );
    assert.ok(freeTextSaves[1].revision > freeTextSaves[0].revision);
    assert.ok(
      freeTextSaves[1].receivedAt >= freeTextSaves[0].acknowledgedAt,
      "The newer FreeText revision must follow the earlier host acknowledgement",
    );
    await page.waitForFunction(
      (index) => !!window.__host.saves[index + 1]?.acknowledgedAt,
      { timeout: 5_000 },
      beforeFreeTextSaves,
    );
    assert.deepEqual(
      await viewer.evaluate(() => {
        const editor = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
        );
        const selection = window.getSelection();
        const caretRange = document.createRange();
        caretRange.selectNodeContents(editor);
        if (selection?.rangeCount && editor?.contains(selection.anchorNode)) {
          caretRange.setEnd(selection.anchorNode, selection.anchorOffset);
        }
        return {
          focused: document.activeElement === editor,
          caretInsideEditor: !!(
            selection?.isCollapsed && editor?.contains(selection.anchorNode)
          ),
          caretOffset: caretRange.toString().length,
          text: editor?.textContent,
        };
      }),
      {
        focused: true,
        caretInsideEditor: true,
        caretOffset: "Autosave test text continued".length,
        text: "Autosave test text continued",
      },
      "A later FreeText revision must also preserve focus and the insertion point",
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // A document switch cancels the idle timer while the old session's save
    // queue waits for focused FreeText to become commit-ready. Re-arm only the
    // old session's timer, then verify its acknowledgement precedes the new
    // document becoming active.
    const beforeFreeTextDocumentSwitch = await page.evaluate(() => ({
      saveCount: window.__host.saves.length,
      openCount: window.__host.openCount,
      documentId: window.__host.lastOpenedDocumentId,
    }));
    assert.equal(beforeFreeTextDocumentSwitch.documentId, "test-session-3");
    await viewer.type(freeTextSelector, " before switch");
    await page.evaluate(async () => {
      const data = await fetch("/tests/fixtures/tracemonkey.pdf").then(
        (response) => response.arrayBuffer(),
      );
      document.querySelector("iframe").contentWindow.postMessage(
        {
          channel,
          type: "open",
          token,
          documentId: "test-session-4",
          documentPath: "tests/fixtures/fourth-session.pdf",
          filename: "fourth-session.pdf",
          autoSave: true,
          openRequest: 6,
          data,
        },
        "*",
        [data],
      );
    });
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 10_000 },
      beforeFreeTextDocumentSwitch.saveCount,
    );
    await page.waitForFunction(
      (count) => window.__host.openCount === count + 1,
      { timeout: 15_000 },
      beforeFreeTextDocumentSwitch.openCount,
    );
    const switchedFreeTextSave = await page.evaluate(
      (index) => window.__host.saves[index],
      beforeFreeTextDocumentSwitch.saveCount,
    );
    const switchedSession = await page.evaluate(() => ({
      opened: window.__host.openedSessions.at(-1),
      lastOpenedAt: window.__host.lastOpenedAt,
    }));
    assert.equal(switchedFreeTextSave.documentId, "test-session-3");
    assert.equal(switchedFreeTextSave.origin, "auto");
    assert.ok(switchedFreeTextSave.revision > freeTextSaves[1].revision);
    assert.ok(switchedFreeTextSave.acknowledgedAt > 0);
    assert.ok(
      switchedFreeTextSave.acknowledgedAt <= switchedSession.lastOpenedAt,
      "The previous document must be acknowledged before PDF.js switches documents",
    );
    assert.equal(switchedSession.opened.documentId, "test-session-4");
    assert.equal(switchedSession.opened.openRequest, 6);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeFreeTextDocumentSwitch.saveCount + 1,
      "A stale FreeText timer must not save the newly opened clean document",
    );

    // Also cover the branch where a save is already waiting on its host ack.
    // The second focused edit must get its own idle commit and old-document
    // acknowledgement before the queued open can replace PDF.js's document.
    const beforeInflightFreeTextSwitch = await page.evaluate(() => ({
      saveCount: window.__host.saves.length,
      openCount: window.__host.openCount,
    }));
    await page.evaluate(() => {
      window.__host.holdNextAck = true;
      window.__host.nextAckDelay = 2_800;
    });
    await viewer.evaluate(() =>
      document.getElementById("editorFreeTextButton").click(),
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
    );
    const secondFreeTextPoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 320, y: rect.top + 380 };
    });
    await page.mouse.click(secondFreeTextPoint.x, secondFreeTextPoint.y);
    await viewer.waitForSelector(freeTextSelector);
    await viewer.type(freeTextSelector, "In-flight switch");
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 5_000 },
      beforeInflightFreeTextSwitch.saveCount,
    );
    await viewer.type(freeTextSelector, " pending edit");
    await page.evaluate(async () => {
      const data = await fetch("/tests/fixtures/tracemonkey.pdf").then(
        (response) => response.arrayBuffer(),
      );
      document.querySelector("iframe").contentWindow.postMessage(
        {
          channel,
          type: "open",
          token,
          documentId: "test-session-5",
          documentPath: "tests/fixtures/fifth-session.pdf",
          filename: "fifth-session.pdf",
          autoSave: true,
          openRequest: 7,
          data,
        },
        "*",
        [data],
      );
    });
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 2,
      { timeout: 15_000 },
      beforeInflightFreeTextSwitch.saveCount,
    );
    await page.waitForFunction(
      (count) => window.__host.openCount === count + 1,
      { timeout: 15_000 },
      beforeInflightFreeTextSwitch.openCount,
    );
    const inflightSwitchResult = await page.evaluate((index) => ({
      saves: window.__host.saves.slice(index, index + 2),
      opened: window.__host.openedSessions.at(-1),
      lastOpenedAt: window.__host.lastOpenedAt,
    }), beforeInflightFreeTextSwitch.saveCount);
    assert.deepEqual(
      inflightSwitchResult.saves.map((save) => save.documentId),
      ["test-session-4", "test-session-4"],
    );
    assert.ok(
      inflightSwitchResult.saves[1].revision >
        inflightSwitchResult.saves[0].revision,
    );
    assert.ok(
      inflightSwitchResult.saves[1].receivedAt >=
        inflightSwitchResult.saves[0].acknowledgedAt,
      "The second old-document revision must wait for the held host acknowledgement",
    );
    assert.ok(
      inflightSwitchResult.saves[1].acknowledgedAt <=
        inflightSwitchResult.lastOpenedAt,
      "An in-flight save and its newer FreeText edit must finish before switching documents",
    );
    assert.equal(inflightSwitchResult.opened.documentId, "test-session-5");
    assert.equal(inflightSwitchResult.opened.openRequest, 7);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeInflightFreeTextSwitch.saveCount + 2,
      "The old in-flight FreeText timer must not save the newly opened document",
    );

    // A c52 right-button drag temporarily activates the eraser and deletes
    // editors on pointermove. Auto-save must keep the pointer boundary closed
    // for the whole gesture, even when the drag pauses longer than its debounce.
    const beforeEraserFreeTextSave = await page.evaluate(
      () => window.__host.saves.length,
    );
    await viewer.evaluate(() =>
      document.getElementById("editorFreeTextButton").click(),
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
    );
    const eraserTextPoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 300, y: rect.top + 300 };
    });
    await page.mouse.click(eraserTextPoint.x, eraserTextPoint.y);
    await viewer.waitForSelector(freeTextSelector);
    await viewer.type(freeTextSelector, "Eraser idle guard");
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 5_000 },
      beforeEraserFreeTextSave,
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());
    await viewer.evaluate(() => {
      window.__autosaveToolbarToggleEvents = {
        trustedPointerDown: false,
        trustedFreeTextFocusOut: false,
      };
      window.addEventListener(
        "pointerdown",
        (event) => {
          if (
            event.isTrusted &&
            event.target.closest?.("#editorFreeTextButton")
          ) {
            window.__autosaveToolbarToggleEvents.trustedPointerDown = true;
          }
        },
        true,
      );
      window.addEventListener(
        "focusout",
        (event) => {
          if (
            event.isTrusted &&
            event.target.closest?.(".freeTextEditor .internal")
          ) {
            window.__autosaveToolbarToggleEvents.trustedFreeTextFocusOut = true;
          }
        },
        true,
      );
    });
    const freeTextToolbarButtonPoint = await viewer.evaluate(() => {
      const rect = document
        .getElementById("editorFreeTextButton")
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(
      freeTextToolbarButtonPoint.x,
      freeTextToolbarButtonPoint.y,
    );
    try {
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
        { timeout: 5_000 },
      );
    } catch (error) {
      const diagnostics = await viewer.evaluate(() => ({
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        button: document.getElementById("editorFreeTextButton")?.outerHTML,
        focus: document.activeElement?.outerHTML?.slice(0, 500),
        toolbarToggleEvents: window.__autosaveToolbarToggleEvents,
      }));
      error.message += `\nFreeText toolbar toggle diagnostics: ${JSON.stringify(diagnostics)}`;
      throw error;
    }
    assert.deepEqual(
      await viewer.evaluate(() => window.__autosaveToolbarToggleEvents),
      { trustedPointerDown: true, trustedFreeTextFocusOut: true },
      "Switching out of the focused FreeText tool should use a real toolbar pointer and blur",
    );
    await viewer.evaluate(() => {
      const pdfDocument = PDFViewerApplication.pdfDocument;
      const original = pdfDocument.saveDocument;
      window.__eraserSaveDocumentCalls = 0;
      pdfDocument.saveDocument = function (...args) {
        window.__eraserSaveDocumentCalls += 1;
        return original.apply(pdfDocument, args);
      };
    });
    const eraserGesture = await viewer.evaluate(() => {
      const editor = document.querySelector(
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor',
      );
      const rect = editor.getBoundingClientRect();
      return {
        start: { x: rect.left - 60, y: rect.top + rect.height / 2 },
        end: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
        text: editor.textContent,
      };
    });
    assert.equal(eraserGesture.text, "Eraser idle guard");
    const beforeEraserHold = {
      saveCount: await page.evaluate(() => window.__host.saves.length),
      serializeCount: await viewer.evaluate(
        () => window.__eraserSaveDocumentCalls,
      ),
    };
    await viewer.evaluate(() => {
      window.__autosaveRightDragElementBlurs = [];
      window.__autosaveRightDragStartedAt = null;
      window.addEventListener(
        "pointerdown",
        (event) => {
          if (event.button === 2 && event.isTrusted) {
            window.__autosaveRightDragStartedAt = performance.now();
          }
        },
        true,
      );
      window.addEventListener(
        "blur",
        (event) => {
          if (
            window.__autosaveRightDragStartedAt !== null &&
            event.target !== window
          ) {
            window.__autosaveRightDragElementBlurs.push({
              isTrusted: event.isTrusted,
              targetTag: event.target?.tagName ?? null,
              targetId: event.target?.id ?? null,
              targetClass:
                typeof event.target?.className === "string"
                  ? event.target.className
                  : "",
            });
          }
        },
        true,
      );
      document.getElementById("editorFreeTextButton").focus();
    });
    await page.mouse.move(eraserGesture.start.x, eraserGesture.start.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(eraserGesture.end.x, eraserGesture.end.y);
    await viewer.waitForFunction(
      () =>
        [...PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager.getEditors(0)].length === 0,
      { timeout: 5_000 },
    );
    const rightDragElementBlurs = await viewer.evaluate(
      () => window.__autosaveRightDragElementBlurs,
    );
    assert.ok(
      rightDragElementBlurs.some((event) => event.isTrusted),
      "The right drag must cause a real focused-element blur while its pointer remains held",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    const heldEraserState = await page.evaluate(() => ({
      saveCount: window.__host.saves.length,
    }));
    const heldViewerSerializationCount = await viewer.evaluate(
      () => window.__eraserSaveDocumentCalls,
    );
    const heldSaves = await page.evaluate(() => window.__host.saves.slice(-3));
    assert.equal(
      heldEraserState.saveCount,
      beforeEraserHold.saveCount,
      `A paused right-button erase must not send a partial save before pointerup; recent saves=${JSON.stringify(heldSaves)}`,
    );
    assert.equal(
      heldViewerSerializationCount,
      beforeEraserHold.serializeCount,
      "A paused right-button erase must not serialize the partial deletion",
    );
    await page.mouse.up({ button: "right" });
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 5_000 },
      beforeEraserHold.saveCount,
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
    );
    const completedEraserSave = await page.evaluate(
      (index) => window.__host.saves[index],
      beforeEraserHold.saveCount,
    );
    assert.equal(completedEraserSave.documentId, "test-session-5");
    assert.equal(completedEraserSave.origin, "auto");
    assert.ok(completedEraserSave.byteLength > 0);
    assert.equal(
      await viewer.evaluate(() => window.__eraserSaveDocumentCalls),
      beforeEraserHold.serializeCount + 1,
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());
    await viewer.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          code: "KeyZ",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await viewer.waitForFunction(
      () =>
        [...PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager.getEditors(0)].length === 1,
      { timeout: 5_000 },
    );
    assert.equal(
      await viewer.evaluate(
        () =>
          document.querySelector(
            '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor',
          )?.textContent,
      ),
      "Eraser idle guard",
      "The restored NONE tool must keep right-erase undo available",
    );
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 2,
      { timeout: 5_000 },
      beforeEraserHold.saveCount,
    );
    const undoSavedAnnotations = await viewer.evaluate(async (saveIndex) => {
      const bytes = new Uint8Array(parent.__host.saves[saveIndex].data);
      const reopened = await pdfjsLib.getDocument({ data: bytes }).promise;
      const annotations = await reopened
        .getPage(1)
        .then((page) => page.getAnnotations({ intent: "display" }));
      const freeText = annotations
        .filter((annotation) => annotation.subtype === "FreeText")
        .map((annotation) =>
          Object.fromEntries(
            Object.entries(annotation).filter(([, value]) =>
              value === null || Array.isArray(value) ||
                ["string", "number", "boolean"].includes(typeof value),
            ),
          ),
        );
      await reopened.destroy();
      return freeText;
    }, beforeEraserHold.saveCount + 1);
    assert.equal(undoSavedAnnotations.length, 1);
    assert.equal(undoSavedAnnotations[0].subtype, "FreeText");
    assert.equal(undoSavedAnnotations[0].hasAppearance, true);
    assert.deepEqual(undoSavedAnnotations[0].textContent, ["Eraser idle guard"]);

    // Recreate a visible target after undo. PDF.js can leave the restored
    // editor in the model with a zero-sized DOM node until its next layout;
    // exercise Escape cancellation against a newly placed, rendered editor.
    const beforeEscapeTargetSave = await page.evaluate(
      () => window.__host.saves.length,
    );
    await viewer.evaluate(() =>
      document.getElementById("editorFreeTextButton").click(),
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
    );
    const escapeTextPoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 440, y: rect.top + 420 };
    });
    await page.mouse.click(escapeTextPoint.x, escapeTextPoint.y);
    await viewer.waitForSelector(freeTextSelector);
    await page.keyboard.type("Escape erase guard");
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 5_000 },
      beforeEscapeTargetSave,
    );
    await page.waitForFunction(
      (index) => !!window.__host.saves[index]?.acknowledgedAt,
      { timeout: 5_000 },
      beforeEscapeTargetSave,
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());
    const freeTextToolbarButtonPointAfterUndo = await viewer.evaluate(() => {
      const rect = document
        .getElementById("editorFreeTextButton")
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(
      freeTextToolbarButtonPointAfterUndo.x,
      freeTextToolbarButtonPointAfterUndo.y,
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
      { timeout: 5_000 },
    );
    try {
      await viewer.waitForFunction(
        () => {
          const editor = [
            ...document.querySelectorAll(
              '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor',
            ),
          ].find((candidate) => candidate.textContent === "Escape erase guard");
          const rect = editor?.getBoundingClientRect();
          const text = editor?.textContent;
          return editor &&
            text === "Escape erase guard" &&
            rect.width > 0 &&
            rect.height > 0;
        },
        { timeout: 5_000 },
      );
    } catch (error) {
      const diagnostics = await viewer.evaluate(() => {
        const describe = (editor) => {
          const rect = editor.getBoundingClientRect();
          return {
            text: editor.textContent,
            uid: editor.querySelector(".internal")?.id ?? null,
            className: editor.className,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
            connected: editor.isConnected,
            parent: editor.parentElement?.className ?? null,
            display: getComputedStyle(editor).display,
            visibility: getComputedStyle(editor).visibility,
            hidden: editor.hidden,
          };
        };
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        return {
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          activeElement: document.activeElement?.outerHTML?.slice(0, 240) ?? null,
          hasChanges: PDFViewerApplication._hasChanges(),
          editorNodes: [...document.querySelectorAll(".freeTextEditor")].map(describe),
          modelEditors: [...manager.getEditors(0)].map((editor) => ({
            uid: editor.uid,
            text: editor.editorDiv?.textContent,
            editing: editor.isEditing,
            editMode: editor.isInEditMode(),
            div: editor.div?.isConnected ? describe(editor.div) : null,
          })),
          freeTextAnnotation: [...document.querySelectorAll(".freeTextAnnotation")].map(describe),
        };
      });
      error.message += `\nEscape target after tool exit: ${JSON.stringify(diagnostics)}`;
      throw error;
    }
    const escapeEditorUid = await viewer.evaluate(
      () =>
        [...document.querySelectorAll(
          '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor',
        )]
          .find((editor) => editor.textContent === "Escape erase guard")
          ?.querySelector(".internal")?.id ?? null,
    );
    assert.ok(escapeEditorUid);

    // Escape cancels PDF.js's temporary eraser without a pointerup. Keep the
    // physical right button held while switching documents to prove the
    // bridge releases the old gesture and saves its final revision first.
    const beforeEscapeSwitch = await page.evaluate(() => ({
      saveCount: window.__host.saves.length,
      openCount: window.__host.openCount,
    }));
    const escapeEraseGesture = await viewer.evaluate((editorUid) => {
      const editor = document
        .getElementById(editorUid)
        ?.closest(".freeTextEditor");
      const rect = editor.getBoundingClientRect();
      return {
        start: { x: rect.left - 60, y: rect.top + rect.height / 2 },
        end: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      };
    }, escapeEditorUid);
    await page.mouse.move(escapeEraseGesture.start.x, escapeEraseGesture.start.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(
      escapeEraseGesture.start.x + 10,
      escapeEraseGesture.start.y,
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 17,
      { timeout: 5_000 },
    );
    await page.mouse.move(escapeEraseGesture.end.x, escapeEraseGesture.end.y);
    try {
      await viewer.waitForFunction(
        (editorUid) =>
          PDFViewerApplication.pdfViewer.annotationEditorMode === 17 &&
          !document.getElementById(editorUid),
        { timeout: 5_000 },
        escapeEditorUid,
      );
    } catch (error) {
      const diagnostics = await viewer.evaluate(() => {
        const editorElement = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor',
        );
        const editorModel = [
          ...PDFViewerApplication.pdfViewer._layerProperties
            .annotationEditorUIManager.getEditors(0),
        ][0];
        const rect = editorElement?.getBoundingClientRect();
        const hitStackAt = (x, y) =>
          document.elementsFromPoint(x, y).slice(0, 6).map((element) => ({
            tag: element.tagName,
            id: element.id,
            className:
              typeof element.className === "string" ? element.className : "",
            contentEditable: element.contentEditable,
          }));
        return {
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          activeElement: document.activeElement?.outerHTML?.slice(0, 300),
          editorContentEditable:
            editorElement?.querySelector(".internal")?.contentEditable ?? null,
          editorIsEditing: editorModel?.isEditing ?? null,
          editorInEditMode: editorModel?.isInEditMode?.() ?? null,
          editorUid: editorModel?.uid ?? null,
          editorText: editorElement?.textContent ?? null,
          editorConnected: editorElement?.isConnected ?? false,
          pageLoaded:
            PDFViewerApplication.pdfDocument?.numPages > 0 &&
            !!document.querySelector('.page[data-page-number="1"] canvas'),
          editorRect: rect && {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          },
          hitStackAtStart:
            rect && hitStackAt(rect.left - 60, rect.top + rect.height / 2),
          hitStackAtEnd:
            rect && hitStackAt(rect.left + rect.width / 2, rect.top + rect.height / 2),
        };
      });
      error.message += `\nEscape right-erase diagnostics: ${JSON.stringify(diagnostics)}`;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeEscapeSwitch.saveCount,
      "A held right drag must remain unsaved until Escape cancels the gesture",
    );
    await page.keyboard.press("Escape");
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
      { timeout: 5_000 },
    );
    await page.evaluate(async () => {
      const data = await fetch("/tests/fixtures/tracemonkey.pdf").then(
        (response) => response.arrayBuffer(),
      );
      document.querySelector("iframe").contentWindow.postMessage(
        {
          channel,
          type: "open",
          token,
          documentId: "test-session-6",
          documentPath: "tests/fixtures/sixth-session.pdf",
          filename: "sixth-session.pdf",
          autoSave: true,
          openRequest: 8,
          data,
        },
        "*",
        [data],
      );
    });
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 15_000 },
      beforeEscapeSwitch.saveCount,
    );
    await page.waitForFunction(
      (count) => window.__host.openCount === count + 1,
      { timeout: 15_000 },
      beforeEscapeSwitch.openCount,
    );
    const escapeSwitch = await page.evaluate((index) => ({
      save: window.__host.saves[index],
      opened: window.__host.openedSessions.at(-1),
      openedAt: window.__host.lastOpenedAt,
    }), beforeEscapeSwitch.saveCount);
    assert.equal(escapeSwitch.save.documentId, "test-session-5");
    assert.equal(escapeSwitch.save.origin, "auto");
    assert.ok(
      escapeSwitch.save.acknowledgedAt <= escapeSwitch.openedAt,
      "Escape cancellation must save and acknowledge the old PDF before switching",
    );
    assert.equal(escapeSwitch.opened.documentId, "test-session-6");
    assert.equal(escapeSwitch.opened.openRequest, 8);
    await page.mouse.up({ button: "right" });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeEscapeSwitch.saveCount + 1,
      "A canceled pointer must not leave a stale save timer on the next document",
    );

    // Also exercise blur cancellation. Prefer a real focus loss to another
    // browser page and record isTrusted; headless engines that do not surface
    // iframe blur use an explicitly labeled synthetic event as a fallback.
    await viewer.evaluate(() => {
      window.__autosaveTestBlurEvents = [];
      window.addEventListener(
        "blur",
        (event) =>
          window.__autosaveTestBlurEvents.push({
            isTrusted: event.isTrusted,
            targetIsWindow: event.target === window,
            targetTag: event.target?.tagName ?? null,
          }),
        true,
      );
    });
    const beforeBlurTextSave = await page.evaluate(
      () => window.__host.saves.length,
    );
    await viewer.evaluate(() =>
      document.getElementById("editorFreeTextButton").click(),
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
    );
    const blurTextPoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 340, y: rect.top + 420 };
    });
    await page.mouse.click(blurTextPoint.x, blurTextPoint.y);
    await viewer.waitForSelector(freeTextSelector);
    await viewer.type(freeTextSelector, "Blur cancel guard");
    await page.waitForFunction(
      (count) => window.__host.saves.length === count + 1,
      { timeout: 5_000 },
      beforeBlurTextSave,
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());
    const blurEraseGesture = await viewer.evaluate(() => {
      const editor = document.querySelector(
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor',
      );
      const rect = editor.getBoundingClientRect();
      return {
        start: { x: rect.left - 60, y: rect.top + rect.height / 2 },
        end: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      };
    });
    const beforeBlurCancel = await page.evaluate(() => ({
      saveCount: window.__host.saves.length,
      openCount: window.__host.openCount,
    }));
    await page.mouse.move(blurEraseGesture.start.x, blurEraseGesture.start.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(blurEraseGesture.end.x, blurEraseGesture.end.y);
    await viewer.waitForFunction(
      () =>
        PDFViewerApplication.pdfViewer.annotationEditorMode === 17 &&
        [...PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager.getEditors(0)].length === 0,
      { timeout: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeBlurCancel.saveCount,
      "A held right drag must not save before blur cancels the gesture",
    );
    blurPage = await browser.newPage();
    try {
      await blurPage.goto("about:blank");
      await blurPage.bringToFront();
      let blurTrigger = "trusted-browser-blur";
      try {
        await viewer.waitForFunction(
          () =>
            window.__autosaveTestBlurEvents.some(
              (event) => event.isTrusted && event.targetIsWindow,
            ),
          { timeout: 1_500 },
        );
      } catch {
        blurTrigger = "synthetic-window-blur";
        await viewer.evaluate(() => window.dispatchEvent(new Event("blur")));
      }
      try {
        await viewer.waitForFunction(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
          { timeout: 5_000 },
        );
      } catch (error) {
        const diagnostics = await viewer.evaluate(() => ({
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          blurEvents: window.__autosaveTestBlurEvents,
        }));
        error.message += `\nBlur cancellation diagnostics: ${JSON.stringify({ blurTrigger, diagnostics })}`;
        throw error;
      }
      const afterBlur = await page.evaluate((count) => ({
        saveCount: window.__host.saves.length,
        saves: window.__host.saves.slice(count).map((save) => ({
          documentId: save.documentId,
          revision: save.revision,
          origin: save.origin,
          acknowledgedAt: save.acknowledgedAt ?? null,
        })),
      }), beforeBlurCancel.saveCount);
      await page.bringToFront();
      await page.evaluate(async () => {
        const data = await fetch("/tests/fixtures/tracemonkey.pdf").then(
          (response) => response.arrayBuffer(),
        );
        document.querySelector("iframe").contentWindow.postMessage(
          {
            channel,
            type: "open",
            token,
            documentId: "test-session-7",
            documentPath: "tests/fixtures/seventh-session.pdf",
            filename: "seventh-session.pdf",
            autoSave: false,
            heavyLeaseRequired: true,
            openRequest: 9,
            data,
          },
          "*",
          [data],
        );
      });
      try {
        await page.waitForFunction(
          (count) => window.__host.openCount === count + 1,
          { timeout: 15_000 },
          beforeBlurCancel.openCount,
        );
      } catch (error) {
        const diagnostics = await page.evaluate((counts) => ({
          counts,
          saveCount: window.__host.saves.length,
          saves: window.__host.saves.map((save) => ({
            documentId: save.documentId,
            revision: save.revision,
            origin: save.origin,
            acknowledgedAt: save.acknowledgedAt ?? null,
          })),
          openCount: window.__host.openCount,
          openedSessions: window.__host.openedSessions,
          errors: window.__host.errors,
        }), { ...beforeBlurCancel, afterBlurCount: afterBlur.saveCount });
        const frame = await viewer.evaluate(() => ({
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        }));
        error.message += `\nBlur switch open diagnostics: ${JSON.stringify({ diagnostics, frame })}`;
        throw error;
      }
      const blurSwitch = await page.evaluate(
        ({ saveIndex }) => {
          const oldDocumentSaves = window.__host.saves
            .slice(saveIndex)
            .filter((save) => save.documentId === "test-session-6");
          return {
          oldDocumentSaves,
          postOpenSaveCount: window.__host.saves.length,
          opened: window.__host.openedSessions.at(-1),
          openedAt: window.__host.lastOpenedAt,
          };
        },
        { saveIndex: beforeBlurCancel.saveCount },
      );
      assert.equal(blurSwitch.oldDocumentSaves.length, 1);
      assert.equal(blurSwitch.oldDocumentSaves[0].origin, "auto");
      assert.ok(
        blurSwitch.oldDocumentSaves[0].acknowledgedAt <= blurSwitch.openedAt,
        `${blurTrigger} must clear the canceled right pointer and save before switching`,
      );
      assert.equal(blurSwitch.opened.documentId, "test-session-7");
      assert.equal(blurSwitch.opened.openRequest, 9);
      console.log("Window blur switch evidence:", JSON.stringify({
        trigger: blurTrigger,
        preCancel: beforeBlurCancel,
        afterBlur,
        oldDocumentSaves: blurSwitch.oldDocumentSaves,
        opened: blurSwitch.opened,
        openedAt: blurSwitch.openedAt,
      }));
      const blurEvidence = await viewer.evaluate(() => ({
        trustedWindow: window.__autosaveTestBlurEvents.some(
          (event) => event.isTrusted && event.targetIsWindow,
        ),
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
      }));
      if (blurTrigger === "trusted-browser-blur") {
        assert.equal(blurEvidence.trustedWindow, true);
      } else {
        assert.equal(blurEvidence.trustedWindow, false);
      }
      assert.equal(blurEvidence.mode, 0);
    } finally {
      await page.mouse.up({ button: "right" });
      await page.bringToFront();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      beforeBlurCancel.saveCount + 1,
      "Blur cancellation must not leave a stuck pointer or stale timer after switching",
    );

    // Hold the host's heavy lease after a dirty Ink editor already exists,
    // finish a second pen stroke during that wait, then grant the lease. The
    // stale pre-stroke snapshot must be discarded and retried with both Ink
    // editors before the host sees a write.
    await viewer.evaluate(() => {
      const app = PDFViewerApplication;
      app.pdfViewer.currentPageNumber = 1;
      document.querySelector('.page[data-page-number="1"]')
        .scrollIntoView({ block: "start" });
      document.body.focus();
      document.getElementById("editorInkButton").click();
    });
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
      { timeout: 5_000 },
    );
    await viewer.waitForFunction(() => {
      const page = document.querySelector('.page[data-page-number="1"]');
      const layer = PDFViewerApplication.pdfViewer.getPageView(0)?.annotationEditorLayer?.div;
      const rect = page?.getBoundingClientRect();
      return Boolean(
        layer?.isConnected && rect?.width > 0 && rect?.bottom > 0 &&
        rect?.top < window.innerHeight
      );
    }, { timeout: 10_000 });
    const inkPagePoint = await viewer.evaluate(() => {
      const rect = document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer')
        .getBoundingClientRect();
      return { x: rect.left + 330, y: rect.top + 270 };
    });
    const inkIframeOffset = await page.$eval("iframe", (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    const leasePenX = inkIframeOffset.x + inkPagePoint.x;
    const leasePenY = inkIframeOffset.y + inkPagePoint.y;
    const leasePenCdp = await page.createCDPSession();
    const sendLeasePen = (type, x, y) => leasePenCdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      pointerType: "pen",
      force: type === "mouseReleased" ? 0 : 0.6,
    });
    try {
      const drawLeasePen = async (offset) => {
        const previousPointerUps = await page.evaluate(() => window.__host.pointerUps.length);
        await sendLeasePen("mousePressed", leasePenX + offset, leasePenY + offset);
        for (let step = 1; step <= 6; step += 1) {
          await sendLeasePen(
            "mouseMoved",
            leasePenX + offset + step * 7,
            leasePenY + offset + step * 4,
          );
        }
        await sendLeasePen(
          "mouseReleased",
          leasePenX + offset + 42,
          leasePenY + offset + 24,
        );
        await page.waitForFunction(
          (count) => window.__host.pointerUps.length > count,
          { timeout: 5_000 },
          previousPointerUps,
        );
      };

      await drawLeasePen(0);
      const leaseWindowSaveCount = await page.evaluate(() => {
        window.__host.holdNextHeavyLease = true;
        return window.__host.saves.length;
      });
      await page.keyboard.down("Meta");
      await page.keyboard.press("s");
      await page.keyboard.up("Meta");
      await page.waitForFunction(() => window.__host.pendingHeavyLeases.length === 1, {
        timeout: 5_000,
      });
      assert.equal(
        await page.evaluate(() => window.__host.saves.length),
        leaseWindowSaveCount,
        "The held heavy lease must prevent serialization and host write",
      );

      await drawLeasePen(90);
      const grantedLease = await page.evaluate(() => {
        const lease = window.__host.pendingHeavyLeases.shift();
        if (!lease) return null;
        document.querySelector("iframe").contentWindow.postMessage({
          channel,
          type: "heavy-granted",
          token,
          ...lease,
          leaseId: "autosave-test-held-lease-grant",
        }, "*");
        return lease;
      });
      assert.ok(grantedLease, "The held lease request should still be pending");
      await page.waitForFunction(
        (count) => window.__host.saves.length === count + 1,
        { timeout: 10_000 },
        leaseWindowSaveCount,
      );
      const afterHeldLeaseSave = await page.evaluate(() => window.__host.saves.at(-1));
      assert.equal(afterHeldLeaseSave.origin, "manual");
      assert.ok(
        afterHeldLeaseSave.newAnnotations?.filter((entry) => entry.kind === "Ink").length >= 2,
        "The retried snapshot must include both the pre-lease and in-lease Ink editors",
      );
      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), {
        timeout: 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        await page.evaluate((count) => window.__host.saves.length, leaseWindowSaveCount),
        leaseWindowSaveCount + 1,
        "A stroke completed during the lease wait must not cause an unbounded retry/write loop",
      );
    } finally {
      await leasePenCdp.detach().catch(() => {});
    }

    assert.equal(
      await page.evaluate(() => window.__host.errors.length),
      0,
      "The host should not receive bridge errors",
    );
    console.info("Auto-save product assertions completed; entering browser cleanup.");
  } catch (error) {
    primaryError = error;
    // Preserve document/revision timing when a concurrent run fails. Never
    // serialize the PDF buffers held by this public-fixture host.
    try {
      const host = page && !page.isClosed() ? await page.evaluate(() => ({
        openCount: window.__host?.openCount,
        openedSessions: window.__host?.openedSessions,
        lastOpenedAt: window.__host?.lastOpenedAt,
        saves: window.__host?.saves.map(({ data, ...metadata }) => metadata),
        errors: window.__host?.errors,
      })) : null;
      const artifact = path.join(root, "tests", "artifacts", `autosave-failure-${Date.now()}.json`);
      await mkdir(path.dirname(artifact), { recursive: true });
      await writeFile(artifact, JSON.stringify({
        error: error.stack || String(error),
        bridgeSha256: createHash("sha256").update(bridgeSource).digest("hex"),
        harnessSha256: createHash("sha256").update(await readFile(import.meta.filename)).digest("hex"),
        host,
      }, null, 2) + "\n");
      console.error(`Auto-save failure evidence: ${artifact}`);
    } catch (diagnosticError) {
      console.error("Could not capture auto-save failure metadata:", diagnosticError.message);
    }
  } finally {
    cleanupReport = await cleanupBrowserTestResources({
      browser,
      ownedPages: [page, blurPage].filter(Boolean),
      server,
    });
  }
  const finalError = attachCleanupErrors(primaryError, cleanupReport);
  if (finalError) throw finalError;
});
