import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
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
  let server;

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
          const state = window.__host = { ready:false, opened:false, openCount:0, openedSessions:[], lastOpenedDocumentId:null, expectedRendererGeneration:'initial-renderer', readyGenerations:[], ignoredReadyGenerations:[], initialOpenSent:false, pendingOpen:null, pointerUps:[], saves:[], recoveries:[], flushes:[], closePrepareds:[], errors:[], holdFirstAck:true, holdNextAck:false, nextAckDelay:10, failNext:false, failDelay:10 };
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
                    filename:'tracemonkey.pdf', autoSave:true, openRequest:1, data,
                  }, '*', [data]);
                }).catch(error => state.errors.push(error.message));
              }
            } else if (message.type === 'opened') {
              state.opened = true;
              state.openCount += 1;
              state.lastOpenedDocumentId = message.documentId;
              state.openedSessions.push({
                documentId:message.documentId,
                openRequest:message.openRequest,
                revision:message.revision,
                confirmedRevision:message.confirmedRevision,
                dirty:message.dirty,
                restorePaused:message.restorePaused,
              });
            } else if (message.type === 'save') {
              const save = {
                origin: message.origin,
                revision: message.revision,
                requestId: message.requestId,
                receivedAt: performance.timeOrigin + performance.now(),
                byteLength: message.data?.byteLength || 0,
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
              state.recoveries.push({
                documentId: message.documentId,
                requestId: message.requestId,
                revision: message.revision,
                reason: message.reason,
                byteLength: message.data?.byteLength || 0,
                data: message.data?.slice(0),
              });
              setTimeout(() => iframe.contentWindow.postMessage({
                channel, type:'recovered', token,
                documentId:message.documentId,
                requestId:message.requestId,
                revision:message.revision,
              }, '*'), 10);
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

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await puppeteer.launch({
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
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
      saves[1].receivedAt >= saves[0].acknowledgedAt,
      "A newer revision must wait for the earlier host acknowledgement",
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
      3,
      "Both auto-save and Cmd+S must wait while IME composition is active",
    );
    await viewer.evaluate(() =>
      window.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await page.waitForFunction(() => window.__host.saves.length === 4, {
      timeout: 5_000,
    });
    const fourthSave = await page.evaluate(() => window.__host.saves[3]);
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
    assert.equal(await page.evaluate(() => window.__host.saves.length), 4);
    await viewer.evaluate(() =>
      window.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await page.waitForFunction(() => window.__host.flushes.length === 1);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[0]),
      { id: "flush-ime-boundary", ok: true, dirty: false },
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 5);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // Create a real PDF.js FreeText editor. Autosave waits for ordinary blur,
    // while explicit Cmd+S commits the focused editor and writes immediately.
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
    await page.mouse.click(freeTextPoint.x, freeTextPoint.y);
    const freeTextSelector =
      '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal';
    await viewer.waitForSelector(freeTextSelector);
    await viewer.type(freeTextSelector, "Autosave test text");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      5,
      "Autosave must wait until a focused FreeText editor leaves its edit boundary",
    );
    await page.keyboard.down("Meta");
    await page.keyboard.press("s");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => window.__host.saves.length === 6, {
      timeout: 5_000,
    });
    assert.equal(
      await page.evaluate(() => window.__host.saves[5].origin),
      "manual",
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());
    assert.equal(
      await viewer.evaluate(
        () => document.activeElement.matches?.(".freeTextEditor .internal") || false,
      ),
      false,
      "Cmd+S must commit and blur a focused FreeText editor",
    );

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
    assert.equal(await page.evaluate(() => window.__host.saves.length), 6);
    await finishSquare(closePoint);
    await page.waitForFunction(() => window.__host.flushes.length === 2);
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[1]),
      { id: "flush-auto-close", ok: true, dirty: false },
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 7);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    // A controlled close blocks new pointer edits while it waits for an
    // already accepted host write, then stays inert until the host cancels or
    // removes the view.
    await page.evaluate(() => {
      window.__host.holdNextAck = true;
      window.__host.nextAckDelay = 2_200;
    });
    await viewer.evaluate(() => {
      PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.undo();
    });
    await page.waitForFunction(() => window.__host.saves.length === 8, {
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
      0,
      "The host must not receive a prepared acknowledgement before its pending write settles",
    );
    await page.waitForFunction(() => window.__host.closePrepareds.length === 1, {
      timeout: 10_000,
    });
    const heldClose = await page.evaluate(
      () => window.__host.closePrepareds[0],
    );
    assert.equal(heldClose.id, "prepare-close-held-save");
    assert.equal(heldClose.documentId, documentId);
    assert.equal(heldClose.openRequest, 1);
    assert.equal(
      heldClose.revision,
      await page.evaluate(() => window.__host.saves[7].revision),
    );
    assert.equal(heldClose.ok, true);
    assert.equal(heldClose.dirty, false);
    assert.equal(heldClose.recovered, false);
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
    await page.waitForFunction(() => window.__host.saves.length === 9, {
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
    assert.equal(await page.evaluate(() => window.__host.closePrepareds.length), 1);
    await viewer.evaluate(() => {
      document
        .querySelector('.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal')
        .dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await page.waitForFunction(() => window.__host.closePrepareds.length === 2, {
      timeout: 10_000,
    });
    const imeClose = await page.evaluate(() => window.__host.closePrepareds[1]);
    assert.equal(imeClose.prepared, true);
    assert.equal(imeClose.ok, true);
    assert.equal(imeClose.dirty, false);
    assert.equal(imeClose.openRequest, 1);
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
    assert.equal(await page.evaluate(() => window.__host.saves.length), 10);
    assert.equal(
      await viewer.evaluate(() => PDFViewerApplication._hasChanges()),
      true,
      "A canceled auto-origin serialization must leave the PDF dirty",
    );
    const savesAfterDisable = await page.evaluate(() => window.__host.saves);
    assert.equal(
      savesAfterDisable.length,
      10,
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
    assert.equal(await page.evaluate(() => window.__host.saves.length), 10);
    const disabledRecovery = await page.evaluate(() => window.__host.recoveries[0]);
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
    await page.waitForFunction(() => window.__host.closePrepareds.length === 3, {
      timeout: 10_000,
    });
    const disabledClose = await page.evaluate(
      () => window.__host.closePrepareds[2],
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
      await page.evaluate(() => window.__host.recoveries[1].revision),
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
    await page.waitForFunction(() => window.__host.saves.length === 11);
    assert.equal(
      await page.evaluate(() => window.__host.saves[10].origin),
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
    assert.equal(await page.evaluate(() => window.__host.saves.length), 11);

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
    await page.waitForFunction(() => window.__host.saves.length === 12);
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
    assert.equal(await page.evaluate(() => window.__host.saves.length), 12);
    const conflictRecovery = await page.evaluate(() => window.__host.recoveries[2]);
    assert.equal(conflictRecovery.reason, "save-conflict");
    assert.ok(conflictRecovery.byteLength > 0);
    assert.ok(
      conflictRecovery.revision >
        (await page.evaluate(() => window.__host.saves[11].revision)),
      "Recovery must serialize the edit made while the original save was pending",
    );
    await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
    await page.waitForFunction(() => window.__host.saves.length === 13);
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
    const switchRecovery = await page.evaluate(() => window.__host.recoveries[3]);
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
    await page.waitForFunction(() => window.__host.closePrepareds.length === 4, {
      timeout: 5_000,
    });
    const emptyClose = await page.evaluate(
      () => window.__host.closePrepareds[3],
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
      13,
      "Opening a dirty recovery candidate with autosave off must not write the original PDF",
    );
    await viewer.evaluate(() => document.body.focus());
    await page.keyboard.down("Meta");
    await page.keyboard.press("s");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => window.__host.saves.length === 14, {
      timeout: 5_000,
    });
    const restoredManualSave = await page.evaluate(
      () => window.__host.saves[13],
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
    await page.waitForFunction(() => window.__host.saves.length === 15, {
      timeout: 10_000,
    });
    assert.equal(
      await page.evaluate(() => window.__host.saves[14].origin),
      "auto",
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      await page.evaluate(() => window.__host.saves.length),
      15,
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
      15,
      "A restored conflict pause must suppress autosave after the viewer realm reloads",
    );
    await viewer.evaluate(() => document.body.focus());
    await page.keyboard.down("Meta");
    await page.keyboard.press("s");
    await page.keyboard.up("Meta");
    await page.waitForFunction(() => window.__host.saves.length === 16, {
      timeout: 5_000,
    });
    const pausedManualSave = await page.evaluate(
      () => window.__host.saves[15],
    );
    assert.equal(pausedManualSave.origin, "manual");
    assert.equal(pausedManualSave.revision, pausedRecovery.revision);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges());

    assert.equal(
      await page.evaluate(() => window.__host.errors.length),
      0,
      "The host should not receive bridge errors",
    );
  } finally {
    await browser?.close();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
