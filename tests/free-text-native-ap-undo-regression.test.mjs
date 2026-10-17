import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources, attachCleanupErrors } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";
import mergeCore from "../plugin/pdf-merge-core.cjs";

const browserPath = resolveBrowserPath();
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const channel = "pdf-web-reader";
const token = `freetext-native-ap-undo-${randomUUID()}`;
const documentId = "freetext-native-ap-undo.pdf";
const rendererGeneration = "freetext-native-ap-undo-renderer";
const artifactsPath = resolveTestArtifactRoot(root);
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"], [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"], [".svg", "image/svg+xml"], [".wasm", "application/wasm"],
]);

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("native FreeText AP survives held-delete-ACK undo, redo, and immutable-source reopen", {
  timeout: 120_000,
}, async (t) => {
  assert.ok(browserPath, "Chrome or Edge is required for this browser regression; configure PDF_READER_CHROME");
  const fixtureBytes = await readFile(fixturePath);
  const initialSourceHash = sha256(fixtureBytes);
  const viewerPath = path.join(root, "vendor", "pdfjs-generic-legacy", "web", "viewer.html");
  const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
  const bridgeCssPath = path.join(root, "viewer-adapter", "bridge.css");
  const viewerHtml = await readFile(viewerPath, "utf8");
  const traceBridgePath = process.env.NATIVE_AP_BRIDGE_SOURCE || bridgePath;
  const bridgeSourceSha256 = sha256(await readFile(traceBridgePath));
  const rawBridgeSource = await readBridgeRuntimeSource(traceBridgePath);
  const tracePrelude = `
  window.__nativeApRepairTrace = [];
  const __nativeApTrace = (event, details = {}) => {
    try {
      const controller = state.annotationController;
      if (controller && typeof controller.setEmbeddedDeletionMask === "function" &&
          controller.__nativeApTraceMaskMethod !== true) {
        const original = controller.setEmbeddedDeletionMask;
        controller.setEmbeddedDeletionMask = function(storage, references) {
          const before = [...(this.embeddedRenderMasks?.get(storage)?.ids || [])];
          const requested = Array.isArray(references) ? [...references] : [];
          const changed = original.call(this, storage, references);
          const after = [...(this.embeddedRenderMasks?.get(storage)?.ids || [])];
          __nativeApTrace("setEmbeddedDeletionMask", { requested, changed: !!changed, before, after });
          return changed;
        };
        controller.__nativeApTraceMaskMethod = true;
      }
      const app = state.app;
      const storage = app?.pdfDocument?.annotationStorage;
      const repair = state.pendingFreeTextAppearanceRepair;
      const manager = repair?.manager || app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      const rows = [...(state.externalAnnotationRows?.values?.() || [])].map((row) => ({
        uuid: row.uuid, deleted: row.deleted === true, embeddedRef: row.embeddedRef || null,
        pageIndex: row.pageIndex, kind: row.kind,
        clock: row.clock ? {
          timestamp: row.clock.timestamp, logical: row.clock.logical,
          deviceId: row.clock.deviceId, opId: row.clock.opId,
        } : null,
      }));
      const editors = [...(manager?.getEditors?.(0) || [])].map((editor) => ({
        id: editor.id, uid: editor.uid, annotationElementId: editor.annotationElementId,
        deleted: editor.deleted === true, editorType: editor.editorType,
      }));
      const mask = controller?.embeddedRenderMasks?.get(storage);
      const pdfViewer = app?.pdfViewer;
      const pageView = pdfViewer?.getPageView?.(0);
      const wrapMethod = (object, method, event) => {
        const marker = "__nativeApTrace_" + method;
        if (!object || object[marker] || typeof object[method] !== "function") return;
        const original = object[method];
        object[method] = function(...args) {
          __nativeApTrace(event, { pageIndex: this.id ? this.id - 1 : null, argCount: args.length });
          return original.apply(this, args);
        };
        object[marker] = true;
      };
      wrapMethod(pdfViewer, "update", "pdfViewer.update");
      wrapMethod(pdfViewer, "forceRendering", "pdfViewer.forceRendering");
      wrapMethod(pageView, "update", "pageView.update");
      wrapMethod(pageView, "toggleEditingMode", "pageView.toggleEditingMode");
      const entry = {
        seq: window.__nativeApRepairTrace.length + 1,
        at: performance.now(), event, details,
        pendingSave: state.pendingSave ? {
          requestId: state.pendingSave.requestId, revision: state.pendingSave.revision,
          openRequest: state.pendingSave.openRequest, operationCount: state.pendingSave.operationCount,
        } : null,
        savePromise: Boolean(state.savePromise), pendingRecovery: Boolean(state.pendingRecovery),
        dirty: state.dirty, revision: state.revision, confirmedRevision: state.confirmedRevision,
        autoSavePending: state.autoSavePending, autoSaveTimer: Boolean(state.autoSaveTimer),
        dirtyAnnotationRevisions: [...(state.dirtyAnnotationRevisions?.entries?.() || [])],
        dirtyDeletedAnnotationIds: [...(state.dirtyDeletedAnnotationIds || [])],
        pendingBulkDeletedUuids: [...(state.pendingBulkDeletedUuids || [])],
        pendingExternalAnnotationsUpdate: state.pendingExternalAnnotationsUpdate ? {
          documentId: state.pendingExternalAnnotationsUpdate.documentId,
          openRequest: state.pendingExternalAnnotationsUpdate.openRequest,
        } : null,
        pendingFreeTextAppearanceRepair: repair ? {
          documentId: repair.documentId, openRequest: repair.openRequest,
          editors: [...repair.editors].map((editor) => ({
            id: editor.id, uid: editor.uid, annotationElementId: editor.annotationElementId,
            deleted: editor.deleted === true, editorType: editor.editorType,
          })),
        } : null,
        externalRows: rows,
        renderMaskIds: [...(mask?.ids || [])],
        storageModifiedIds: [...(storage?.modifiedIds?.ids || [])],
        pageView: pageView ? {
          renderingState: pageView.renderingState, hasCanvas: Boolean(pageView.canvas),
          canvasWidth: pageView.canvas?.width || 0, canvasHeight: pageView.canvas?.height || 0,
        } : null,
        editors,
      };
      window.__nativeApRepairTrace.push(entry);
      if (window.__nativeApRepairTrace.length > 5000) window.__nativeApRepairTrace.shift();
    } catch {}
  };
  window.__freeTextNativeApBridgeState = state;
  `;
  const replaceBridgeAnchor = (source, anchor, replacement, label) => {
    const index = source.indexOf(anchor);
    assert.ok(index >= 0, `Native AP trace anchor missing: ${label}`);
    assert.equal(source.indexOf(anchor, index + anchor.length), -1,
      `Native AP trace anchor must be unique: ${label}`);
    return source.slice(0, index) + replacement + source.slice(index + anchor.length);
  };
  let bridgeSource = rawBridgeSource.replace(
    "  if (iosInputPolicy) {",
    `${tracePrelude}\n  if (iosInputPolicy) {`,
  );
  assert.notEqual(bridgeSource, rawBridgeSource,
    "The regression harness must expose bridge state and repair trace only for this browser test");
  bridgeSource = replaceBridgeAnchor(
    bridgeSource,
    "  function restoreSuppressedEmbeddedAnnotations(excludedReferences = new Set()) {",
    `  const __nativeApOriginalApplyConfirmed = applyConfirmedNativeAnnotationLayerState;
  applyConfirmedNativeAnnotationLayerState = function(...args) {
    __nativeApTrace("applyConfirmed.before", { documentId: args[0], openRequest: args[1] });
    const result = __nativeApOriginalApplyConfirmed.apply(this, args);
    __nativeApTrace("applyConfirmed.after", { documentId: args[0], openRequest: args[1], result });
    return result;
  };

  function restoreSuppressedEmbeddedAnnotations(excludedReferences = new Set()) {`,
    "applyConfirmed wrapper",
  );
  bridgeSource = replaceBridgeAnchor(
    bridgeSource,
    "  function applyExternalAnnotationsSnapshot(value, { reset = false } = {}) {",
    `  const __nativeApOriginalHydratePage = hydrateExternalAnnotationsForPage;
  hydrateExternalAnnotationsForPage = async function(...args) {
    __nativeApTrace("hydratePage.before", { pageIndex: args[0] });
    try {
      const result = await __nativeApOriginalHydratePage.apply(this, args);
      __nativeApTrace("hydratePage.after", { pageIndex: args[0], result });
      return result;
    } catch (error) {
      __nativeApTrace("hydratePage.error", { pageIndex: args[0], error: String(error?.message || error) });
      throw error;
    }
  };

  function applyExternalAnnotationsSnapshot(value, { reset = false } = {}) {`,
    "hydrate page wrapper",
  );
  bridgeSource = replaceBridgeAnchor(
    bridgeSource,
    "  function externalSourceIdentityMatchesViewer(source) {",
    `  const __nativeApOriginalApplySnapshot = applyExternalAnnotationsSnapshot;
  applyExternalAnnotationsSnapshot = function(...args) {
    __nativeApTrace("applySnapshot.before", { reset: args[1]?.reset === true });
    const result = __nativeApOriginalApplySnapshot.apply(this, args);
    __nativeApTrace("applySnapshot.after", { result });
    return result;
  };

  function externalSourceIdentityMatchesViewer(source) {`,
    "snapshot wrapper",
  );
  bridgeSource = replaceBridgeAnchor(
    bridgeSource,
    "  function basename(documentId) {",
    `  const __nativeApOriginalCanRepair = canRepairFreeTextAppearance;
  canRepairFreeTextAppearance = function(...args) {
    const result = __nativeApOriginalCanRepair.apply(this, args);
    __nativeApTrace("canRepair", { allowed: result });
    return result;
  };
  const __nativeApOriginalRepaint = repaintFreeTextAppearancePages;
  repaintFreeTextAppearancePages = function(...args) {
    __nativeApTrace("repaintPages.before", { pageIndexes: [...(args[1] || [])] });
    const result = __nativeApOriginalRepaint.apply(this, args);
    __nativeApTrace("repaintPages.after", { pageIndexes: [...(args[1] || [])] });
    return result;
  };
  const __nativeApOriginalRepair = repairFreeTextAppearance;
  repairFreeTextAppearance = function(...args) {
    __nativeApTrace("repair.before");
    const result = __nativeApOriginalRepair.apply(this, args);
    __nativeApTrace("repair.after");
    return result;
  };
  const __nativeApOriginalQueueRepair = queueFreeTextAppearanceRepair;
  queueFreeTextAppearanceRepair = function(...args) {
    __nativeApTrace("queueRepair.before", { editorCount: args[2]?.length || 0 });
    const result = __nativeApOriginalQueueRepair.apply(this, args);
    __nativeApTrace("queueRepair.after");
    return result;
  };
  const __nativeApOriginalAttemptRepair = attemptFreeTextAppearanceRepair;
  attemptFreeTextAppearanceRepair = function(...args) {
    __nativeApTrace("attemptRepair.before");
    const result = __nativeApOriginalAttemptRepair.apply(this, args);
    __nativeApTrace("attemptRepair.after");
    return result;
  };
  const __nativeApOriginalScheduleUpdate = schedulePendingExternalAnnotationUpdate;
  schedulePendingExternalAnnotationUpdate = function(...args) {
    __nativeApTrace("scheduleExternalUpdate");
    return __nativeApOriginalScheduleUpdate.apply(this, args);
  };

  function basename(documentId) {`,
    "repair wrappers",
  );
  bridgeSource = replaceBridgeAnchor(
    bridgeSource,
    `        clearConfirmedDirtyState(message.revision);
        if (message.externalAnnotations) {
          state.pendingExternalAnnotationsUpdate = {
            documentId: message.documentId,
            openRequest: message.openRequest,
            externalAnnotations: message.externalAnnotations,
          };
        }
        schedulePendingExternalAnnotationUpdate();
        pending.resolve(message);`,
    `        __nativeApTrace("savedAck.beforeClear", { revision: message.revision, requestId: message.requestId });
        clearConfirmedDirtyState(message.revision);
        if (message.externalAnnotations) {
          state.pendingExternalAnnotationsUpdate = {
            documentId: message.documentId,
            openRequest: message.openRequest,
            externalAnnotations: message.externalAnnotations,
          };
        }
        schedulePendingExternalAnnotationUpdate();
        __nativeApTrace("savedAck.beforeResolve", { revision: message.revision, requestId: message.requestId });
        pending.resolve(message);
        __nativeApTrace("savedAck.afterResolve", { revision: message.revision, requestId: message.requestId });`,
    "saved ACK branch",
  );
  const bridgeCss = await readFile(bridgeCssPath, "utf8");
  const viewerWithBridge = viewerHtml.replace(
    /<head\b[^>]*>/i,
    (head) => `${head}<script src="/vendor/pdfjs-generic-legacy/web/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}"></script>`,
  ).replace(
    /<\/head>/i,
    `<style data-pdf-reader="bridge">${bridgeCss.replace(/<\/style/gi, "<\\/style")}</style></head>`,
  );

  const hostHarness = `
    <script>
      (() => {
        const channel = ${JSON.stringify(channel)};
        const token = ${JSON.stringify(token)};
        const initialDocumentId = ${JSON.stringify(documentId)};
        const initialSourceHash = ${JSON.stringify(initialSourceHash)};
        const rendererGeneration = ${JSON.stringify(rendererGeneration)};
        const frame = document.querySelector("iframe");
        const state = window.__nativeApHost = {
          documentId: initialDocumentId, sourceHash: initialSourceHash, data: null,
          identity: null, sourceIdentityConfirmed: false, legacyIdentities: [],
          operations: new Map(), revision: 0, openRequest: 0, opened: 0,
          saves: [], recoveries: [], heldSaves: [], holdNextSaveAck: false, exports: [], errors: [],
        };
        const snapshot = () => ({
          schemaVersion: 2, kind: "pdf-annotation-snapshot", documentId: state.documentId,
          docKey: "freetext-native-ap-undo", revision: state.revision,
          source: {
            sourcePath: state.documentId, sourceHash: state.sourceHash,
            ...(state.identity || { pageCount: 0, orderedPageIdentities: [] }),
          },
          legacyIdentities: state.legacyIdentities,
          annotations: [...state.operations.values()].filter((row) => row.deleted !== true),
          tombstones: [...state.operations.values()].filter((row) => row.deleted === true)
            .map(({ deleted, ...row }) => row),
        });
        const persist = (message) => {
          for (const operation of Array.isArray(message.operations) ? message.operations : []) {
            if (operation && typeof operation.uuid === "string") {
              state.operations.set(operation.uuid, structuredClone(operation));
            }
          }
          state.revision = Math.max(state.revision, Number(message.revision) || 0);
        };
        const ackFor = (type, message) => ({
          channel, type, token, documentId: message.documentId,
          openRequest: message.openRequest, rendererGeneration: message.rendererGeneration,
          requestId: message.requestId, revision: message.revision, ok: true, external: true,
          operationCount: Array.isArray(message.operations) ? message.operations.length : 0,
          batchId: message.operations?.length ? "native-ap-" + message.requestId : null,
          externalAnnotations: snapshot(),
        });
        const sendOpen = (data, label) => {
          state.openRequest += 1;
          state.sourceIdentityConfirmed = false;
          state.identity = null;
          frame.contentWindow.postMessage({
            channel, type: "open", token, documentId: state.documentId,
            documentPath: state.documentId, filename: state.documentId,
            autoSave: true, rendererGeneration, openRequest: state.openRequest,
            data, externalAnnotations: snapshot(),
          }, "*", [data]);
          state.lastOpenLabel = label;
        };
        window.__sendOpenSaved = () => sendOpen(state.data.slice(0), "explicit-export-reopen");
        window.__holdNextSaveAck = () => { state.holdNextSaveAck = true; };
        window.__releaseHeldSaveAcks = () => {
          const held = state.heldSaves.splice(0);
          for (const save of held) frame.contentWindow.postMessage(save.ack, "*");
          return held.length;
        };
        window.__requestNativeExport = () => {
          const requestId = "native-export-" + (state.exports.length + 1);
          frame.contentWindow.postMessage({
            channel, type: "export-copy", token, documentId: state.documentId,
            openRequest: state.openRequest, requestId,
          }, "*");
          return requestId;
        };
        window.__installExportedCopy = (bytes, sourceHash, legacyIdentities) => {
          state.data = Uint8Array.from(bytes).buffer;
          state.sourceHash = sourceHash;
          state.documentId = initialDocumentId + "-explicit-export";
          state.operations.clear();
          state.revision = 0;
          state.identity = null;
          state.sourceIdentityConfirmed = false;
          state.legacyIdentities = legacyIdentities;
        };
        window.addEventListener("message", (event) => {
          if (event.source !== frame.contentWindow) return;
          const message = event.data;
          if (!message || message.channel !== channel || message.token !== token) return;
          if (message.type === "ready") {
            fetch("/fixture.pdf").then((response) => response.arrayBuffer()).then((data) => {
              state.data = data;
              sendOpen(data.slice(0), "fixture");
            }).catch((error) => state.errors.push(String(error?.message || error)));
          } else if (message.type === "opened") {
            state.opened += 1;
          } else if (message.type === "annotation-source-identity") {
            const valid = message.identityStatus === "KNOWN" &&
              Number.isSafeInteger(message.pageCount) &&
              Array.isArray(message.orderedPageIdentities) &&
              message.orderedPageIdentities.length === message.pageCount &&
              message.orderedPageIdentities.every((identity) => typeof identity === "string") &&
              message.sourceHash === state.sourceHash;
            if (!valid) {
              frame.contentWindow.postMessage({
                channel, type: "annotation-source-mismatch", token,
                documentId: message.documentId, openRequest: message.openRequest,
                reason: "PAGE_IDENTITY_UNAVAILABLE",
              }, "*");
              return;
            }
            state.sourceIdentityConfirmed = true;
            state.identity = {
              pageCount: message.pageCount,
              orderedPageIdentities: [...message.orderedPageIdentities],
            };
            frame.contentWindow.postMessage({
              channel, type: "external-annotations-update", token,
              documentId: message.documentId, openRequest: message.openRequest,
              identityConfirmed: true,
              sourceMatch: state.operations.size ? "MATCH" : "BASELINE_ESTABLISHED",
              externalAnnotations: snapshot(),
            }, "*");
          } else if (message.type === "save" || message.type === "recover") {
            persist(message);
            const save = {
              type: message.type, documentId: message.documentId,
              openRequest: message.openRequest, rendererGeneration: message.rendererGeneration,
              requestId: message.requestId, revision: message.revision,
              origin: message.origin ?? null, hasBinaryPayload: Object.hasOwn(message, "data"),
              operationCount: message.operations?.length || 0,
              operations: structuredClone(message.operations || []),
            };
            if (message.type === "recover") state.recoveries.push(save);
            else state.saves.push(save);
            save.ack = ackFor(message.type === "recover" ? "recovered" : "saved", message);
            if (state.holdNextSaveAck && message.type === "save") {
              state.holdNextSaveAck = false;
              state.heldSaves.push(save);
            } else {
              frame.contentWindow.postMessage(save.ack, "*");
            }
          } else if (message.type === "export-ready") {
            state.exports.push({
              documentId: message.documentId, openRequest: message.openRequest,
              requestId: message.requestId, revision: message.revision,
              byteLength: message.data?.byteLength || 0,
              data: new Uint8Array(message.data).slice().buffer,
            });
          } else if (message.type === "error") {
            state.errors.push({ code: message.code, message: message.message });
          }
        });
      })();
    </script>`;

  const html = `<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
    <iframe name="pdf-reader" title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
    ${hostHarness}`;
  const externalRequests = [];
  const consoleErrors = [];
  const errors = [];
  const evidence = [];
  const artifactBase = `freetext-native-ap-undo-${Date.now()}-${process.pid}-${randomUUID()}`;
  const artifactJson = path.join(artifactsPath, `${artifactBase}.json`);
  let browser;
  let page;
  let server;
  let functionalError = null;
  let cleanupReport = null;

  const persistEvidence = async (stage) => {
    const viewerFrame = page?.frames().find((frame) => frame.name() === "pdf-reader");
    const bridgeTrace = viewerFrame
      ? await viewerFrame.evaluate(() => window.__nativeApRepairTrace || [])
        .catch((error) => ({ captureError: String(error?.message || error) }))
      : null;
    await writeFile(artifactJson, JSON.stringify({
      stage, evidence, errors, consoleErrors, externalRequests,
      bridgeSourceSha256, traceBridgePath, bridgeTrace,
      host: page ? await page.evaluate(() => {
        const state = window.__nativeApHost;
        return state ? {
          documentId: state.documentId, sourceHash: state.sourceHash,
          sourceIdentityConfirmed: state.sourceIdentityConfirmed,
          opened: state.opened, saves: state.saves.map(({ ack, ...save }) => save),
          heldSaves: state.heldSaves.length, errors: state.errors,
          operations: [...state.operations.values()], exports: state.exports.map(({ data, ...row }) => row),
        } : null;
      }).catch((error) => ({ captureError: String(error?.message || error) })) : null,
    }, null, 2), "utf8");
  };

  server = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(withTestNetworkFirewall())) response.setHeader(name, value);
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(viewerWithBridge);
      return;
    }
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    let target;
    if (url.pathname === "/fixture.pdf") target = fixturePath;
    else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
      const relative = decodeURIComponent(url.pathname.slice("/vendor/pdfjs-generic-legacy/".length));
      const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
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
      await access(target);
      const info = await stat(target);
      if (!info.isFile()) {
        response.writeHead(404).end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": mimeTypes.get(path.extname(target)) || "application/octet-stream",
        "content-length": info.size, "x-content-type-options": "nosniff",
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  try {
    await mkdir(artifactsPath, { recursive: true });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "free-text-native-ap-undo-regression", artifactsDir: artifactsPath });
    page = await browser.newPage();
    await page.setViewport({ width: 1360, height: 980 });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("request", (request) => {
      try {
        const url = new URL(request.url());
        if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
            url.origin !== new URL(baseUrl).origin) {
          externalRequests.push(request.url());
        }
      } catch {
        externalRequests.push(request.url());
      }
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const viewer = page.frames().find((frame) => frame.name() === "pdf-reader");
    assert.ok(viewer, "Expected the PDF.js Reader iframe");
    await page.waitForFunction(() => window.__nativeApHost?.opened === 1, { timeout: 30_000 });
    await page.waitForFunction(() => window.__nativeApHost?.sourceIdentityConfirmed === true, { timeout: 15_000 });
    await viewer.waitForFunction(() => {
      const app = PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(0);
      return Boolean(app?.pdfDocument && app.pdfViewer.annotationEditorMode !== undefined &&
        pageView?.renderingState === 3 && pageView?.div?.dataset.loaded === "true" &&
        pageView?.annotationEditorLayer?.div?.isConnected &&
        document.getElementById("editorFreeTextButton")?.disabled === false);
    }, { timeout: 30_000 });

    const waitForSaveCount = (count) => page.waitForFunction(
      (expected) => window.__nativeApHost?.saves?.length >= expected,
      { timeout: 30_000 }, count,
    );
    const waitForOpenCount = (count) => page.waitForFunction(
      (expected) => window.__nativeApHost?.opened >= expected,
      { timeout: 30_000 }, count,
    );
    const waitForPageReady = () => viewer.waitForFunction(() => {
      const app = PDFViewerApplication;
      const pageView = app?.pdfViewer?.getPageView(0);
      return Boolean(app?.pdfDocument && pageView?.renderingState === 3 &&
        pageView?.div?.dataset.loaded === "true" && pageView?.annotationEditorLayer?.div?.isConnected);
    }, { timeout: 30_000 });

    await viewer.evaluate(() => {
      window.__trustedUndoKeys = [];
      document.addEventListener("keydown", (event) => {
        if (event.isTrusted && /z/i.test(event.key)) {
          window.__trustedUndoKeys.push({ key: event.key, metaKey: event.metaKey, shiftKey: event.shiftKey });
        }
      }, true);
      window.__nativeModeEvents = [];
      PDFViewerApplication.eventBus.on("annotationeditormodechanged", (event) => {
        window.__nativeModeEvents.push({ mode: event.mode, temporary: event.isTemporary });
      });
      window.__nativeRoiBaselines = new Map();
      window.__sampleNativeApCanvasRoi = (requestedRect, captureBaseline = false) => {
        const page = document.querySelector('.page[data-page-number="1"]');
        const section = [...(page?.querySelectorAll(".annotationLayer .freeTextAnnotation") || [])]
          .find((node) => node.textContent.includes("NativeAppearanceProof"));
        const rect = requestedRect || (() => {
          const bounds = section?.getBoundingClientRect();
          return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
        })();
        const canvas = [...(page?.querySelector(".canvasWrapper")?.querySelectorAll("canvas:not(.detailView)") || [])]
          .sort((a, b) => b.width * b.height - a.width * a.height)[0];
        if (!rect || !canvas?.width || !canvas?.height) return { targetRect: rect, canvasFound: !!canvas, nonWhitePixels: null };
        const canvasRect = canvas.getBoundingClientRect();
        if (!canvasRect.width || !canvasRect.height) return { targetRect: rect, canvasFound: true, nonWhitePixels: null };
        const left = Math.max(0, Math.floor((rect.x - canvasRect.x) * canvas.width / canvasRect.width));
        const top = Math.max(0, Math.floor((rect.y - canvasRect.y) * canvas.height / canvasRect.height));
        const right = Math.min(canvas.width, Math.ceil((rect.x + rect.width - canvasRect.x) * canvas.width / canvasRect.width));
        const bottom = Math.min(canvas.height, Math.ceil((rect.y + rect.height - canvasRect.y) * canvas.height / canvasRect.height));
        if (right <= left || bottom <= top) return { targetRect: rect, canvasFound: true, nonWhitePixels: null };
        const pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(left, top, right - left, bottom - top).data;
        const key = JSON.stringify({ rect, width: right - left, height: bottom - top });
        if (captureBaseline) window.__nativeRoiBaselines.set(key, new Uint8ClampedArray(pixels));
        const baseline = window.__nativeRoiBaselines.get(key);
        let nonWhitePixels = 0;
        let differentPixels = baseline?.length === pixels.length ? 0 : null;
        let hash = 2166136261;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] > 0 && (pixels[i] < 248 || pixels[i + 1] < 248 || pixels[i + 2] < 248)) nonWhitePixels += 1;
          for (let channel = 0; channel < 4; channel += 1) {
            hash = Math.imul(hash ^ pixels[i + channel], 16777619) >>> 0;
            if (baseline && pixels[i + channel] !== baseline[i + channel]) differentPixels += 1;
          }
        }
        let baselineFingerprint = null;
        if (baseline) {
          let baselineHash = 2166136261;
          for (const byte of baseline) baselineHash = Math.imul(baselineHash ^ byte, 16777619) >>> 0;
          baselineFingerprint = baselineHash.toString(16).padStart(8, "0");
        }
        return {
          targetRect: rect, canvasFound: true, nonWhitePixels,
          fingerprint: hash.toString(16).padStart(8, "0"), baselineFingerprint,
          differentPixels: differentPixels === null ? null : differentPixels / 4,
          pixelCount: pixels.length / 4,
        };
      };
    });

    const snapshot = async (label, roi = null) => {
      const viewerState = await viewer.evaluate(({ label, roi }) => {
        const app = PDFViewerApplication;
        const page = document.querySelector('.page[data-page-number="1"]');
        const section = [...(page?.querySelectorAll(".annotationLayer .freeTextAnnotation") || [])]
          .find((node) => node.textContent.includes("NativeAppearanceProof"));
        const sectionRect = section?.getBoundingClientRect();
        const manager = app.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const editor = [...(manager?.getEditors(0) || [])].find((candidate) =>
          candidate.editorType === "freetext" && candidate.annotationElementId &&
          (candidate.serialize?.()?.value?.includes("NativeAppearanceProof") ||
            candidate.div?.textContent?.includes("NativeAppearanceProof") ||
            app.pdfDocument.annotationStorage.getRawValue(candidate.id)?.value?.includes("NativeAppearanceProof")),
        );
        const rawValues = [...(app.pdfDocument.annotationStorage.serializable.map?.values?.() || [])]
          .map((row) => ({ id: row.id, annotationType: row.annotationType, deleted: row.deleted, value: row.value }));
        return {
          label, mode: app.pdfViewer.annotationEditorMode,
          annotation: section ? {
            id: section.id, annotationId: section.getAttribute("data-annotation-id"),
            hidden: section.hidden, display: getComputedStyle(section).display,
            rect: sectionRect ? { x: sectionRect.x, y: sectionRect.y, width: sectionRect.width, height: sectionRect.height } : null,
          } : null,
          editor: editor ? {
            id: editor.id, uid: editor.uid, annotationElementId: editor.annotationElementId,
            deleted: editor.deleted, type: editor.editorType,
          } : null,
          rawValues, roi: window.__sampleNativeApCanvasRoi(roi, label === "reopened-native-baseline"),
          trustedUndoKeys: [...window.__trustedUndoKeys],
        };
      }, { label, roi });
      const hostState = await page.evaluate(() => {
        const host = window.__nativeApHost;
        return {
          saves: host.saves.map(({ ack, ...save }) => save),
          recoveries: host.recoveries.map(({ ack, ...row }) => row), opened: host.opened,
          heldSaves: host.heldSaves.length,
          operations: [...host.operations.values()].map(({ uuid, kind, pageIndex, deleted, embeddedRef }) => ({ uuid, kind, pageIndex, deleted, embeddedRef })),
          errors: host.errors,
        };
      });
      const result = { ...viewerState, host: hostState };
      evidence.push(result);
      await persistEvidence(label);
      return result;
    };

    const setMode = async (mode) => {
      const before = await viewer.evaluate(() => window.__nativeModeEvents.length);
      await viewer.evaluate((value) => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { mode: value }), mode);
      await viewer.waitForFunction((value) => PDFViewerApplication.pdfViewer.annotationEditorMode === value, { timeout: 10_000 }, mode);
      await viewer.waitForFunction(({ mode, before }) => window.__nativeModeEvents.some((event, index) => index >= before && event.mode === mode),
        { timeout: 15_000 }, { mode, before });
    };

    await setMode(3);
    const pageRect = await viewer.evaluate(() => {
      const rect = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const iframeRect = await page.$eval("iframe", (frame) => {
      const rect = frame.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    });
    const createPoint = {
      x: iframeRect.x + pageRect.x + pageRect.width * 0.78,
      y: iframeRect.y + pageRect.y + pageRect.height * 0.55,
    };
    await page.mouse.click(createPoint.x, createPoint.y);
    const editorSelector = '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal[contenteditable="true"]';
    await viewer.waitForSelector(editorSelector, { timeout: 15_000 });
    await page.keyboard.type("NativeAppearanceProof", { delay: 15 });
    await viewer.waitForFunction((selector) => {
      const internal = document.querySelector(selector);
      return internal?.textContent?.includes("NativeAppearanceProof") && document.activeElement === internal;
    }, { timeout: 15_000 }, editorSelector);
    const freeTextButton = await viewer.$eval("#editorFreeTextButton", (button) => {
      const rect = button.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, disabled: button.disabled };
    });
    assert.equal(freeTextButton.disabled, false, "Source identity must be confirmed before committing a FreeText");
    const modeEventsBeforeCommit = await viewer.evaluate(() => window.__nativeModeEvents.length);
    await page.mouse.click(iframeRect.x + freeTextButton.x, iframeRect.y + freeTextButton.y);
    await viewer.waitForFunction((before) => window.__nativeModeEvents.some((event, index) => index >= before && event.mode === 0),
      { timeout: 15_000 }, modeEventsBeforeCommit);
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 0, { timeout: 15_000 });
    await waitForSaveCount(1);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
    const firstSave = await page.evaluate(() => window.__nativeApHost.saves[0]);
    assert.ok(firstSave.operationCount > 0, "The ordinary annotation save must persist a structured sidecar operation");
    assert.equal(firstSave.hasBinaryPayload, false, "The ordinary annotation save must not serialize or send PDF bytes");
    evidence.push({ stage: "sidecar-before-explicit-export", firstSave });
    await persistEvidence("sidecar-before-explicit-export");

    const exportRequestId = await page.evaluate(() => window.__requestNativeExport());
    await page.waitForFunction((requestId) => window.__nativeApHost.exports.some((entry) => entry.requestId === requestId),
      { timeout: 30_000 }, exportRequestId);
    const exportedBytes = await page.evaluate((requestId) => Array.from(new Uint8Array(
      window.__nativeApHost.exports.find((entry) => entry.requestId === requestId).data,
    )), exportRequestId);
    const exportedPdf = Buffer.from(exportedBytes);
    const exportedPdfHash = sha256(exportedPdf);
    const exportedAppearance = await viewer.evaluate(async (bytes) => {
      const task = pdfjsLib.getDocument({ data: Uint8Array.from(bytes) });
      const pdfDocument = await task.promise;
      try {
        const page = await pdfDocument.getPage(1);
        const annotation = (await page.getAnnotations()).find((entry) =>
          entry.subtype === "FreeText" &&
          (entry.contents?.includes("NativeAppearanceProof") || entry.contentsObj?.str?.includes("NativeAppearanceProof")),
        );
        if (!annotation) return { annotation: null, renderedPixels: 0 };
        const viewport = page.getViewport({ scale: 1.25 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
        const left = Math.max(0, Math.floor(Math.min(x1, x2)));
        const top = Math.max(0, Math.floor(Math.min(y1, y2)));
        const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(Math.abs(x2 - x1))));
        const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(Math.abs(y2 - y1))));
        const pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(left, top, width, height).data;
        let renderedPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245) renderedPixels += 1;
        }
        return { annotation: { id: annotation.id, hasAppearance: annotation.hasAppearance, rect: annotation.rect }, renderedPixels };
      } finally {
        await task.destroy();
      }
    }, exportedBytes);
    const exportedInspection = await mergeCore.inspect({ bytes: exportedPdf });
    const exactIdentity = exportedInspection.identities.filter((identity) =>
      identity.ref === exportedAppearance.annotation?.id && identity.pageIndex === 0 &&
      identity.kind === "freetext" && identity.deleted !== true);
    assert.equal(exactIdentity.length, 1,
      "The exported native AP must map to exactly one inspected UUID/type/page identity and PDF.js object reference");
    assert.equal(exportedAppearance.annotation?.hasAppearance, true,
      "The explicit PDF.js export must contain a native FreeText appearance stream");
    assert.ok(exportedAppearance.renderedPixels > 0,
      "The explicit PDF.js export must render visible native FreeText pixels");
    const legacyIdentities = exactIdentity.map(({ uuid, ref, pageIndex, kind }) => ({ uuid, ref, pageIndex, kind }));
    evidence.push({ stage: "explicit-native-export", requestId: exportRequestId, sourceHash: exportedPdfHash,
      byteLength: exportedPdf.byteLength, exportedAppearance, identity: legacyIdentities[0] });
    await page.evaluate(({ bytes, sourceHash, legacyIdentities }) => {
      window.__installExportedCopy(bytes, sourceHash, legacyIdentities);
      window.__sendOpenSaved();
    }, { bytes: exportedBytes, sourceHash: exportedPdfHash, legacyIdentities });
    await waitForOpenCount(2);
    await page.waitForFunction(() => window.__nativeApHost.sourceIdentityConfirmed, { timeout: 15_000 });
    await waitForPageReady();
    const reopenedAnnotation = await viewer.evaluate(async () => {
      const page = await PDFViewerApplication.pdfDocument.getPage(1);
      const annotation = (await page.getAnnotations()).find((entry) =>
        entry.subtype === "FreeText" &&
        (entry.contents?.includes("NativeAppearanceProof") || entry.contentsObj?.str?.includes("NativeAppearanceProof")),
      );
      return annotation ? { id: annotation.id, hasAppearance: annotation.hasAppearance } : null;
    });
    assert.ok(reopenedAnnotation, "The immutable exported baseline must reopen with its native FreeText annotation");
    assert.equal(reopenedAnnotation.id, exportedAppearance.annotation.id,
      "Reopening the explicit export must retain the exact PDF.js annotation object reference");
    assert.equal(reopenedAnnotation.hasAppearance, true, "The reopened native FreeText must retain its AP stream");
    const original = await snapshot("reopened-native-baseline");
    assert.ok(original.roi.canvasFound && original.roi.targetRect && Number.isFinite(original.roi.nonWhitePixels),
      "The reopened native AP must map to a readable page-canvas ROI: " + JSON.stringify(original.roi));
    assert.ok(original.roi.nonWhitePixels > 0,
      "The immutable native AP must contribute non-white pixels to the PDF page canvas: " + JSON.stringify(original.roi));
    assert.ok(original.annotation?.rect?.width > 0 && original.annotation?.rect?.height > 0,
      "The native AP annotation layer must have a positive erase target rect");
    assert.equal(original.host.operations.length, 0,
      "The exported-copy reopen must start from a clean sidecar operation set and the inspected legacy identity");

    const eraseRect = original.annotation.rect;
    const eraseSaveCount = await page.evaluate(() => window.__nativeApHost.saves.length + 1);
    const eraseStart = {
      x: iframeRect.x + eraseRect.x + Math.min(eraseRect.width / 2, 8),
      y: iframeRect.y + eraseRect.y + Math.min(eraseRect.height / 2, 8),
    };
    await page.evaluate(() => window.__holdNextSaveAck());
    await page.mouse.move(eraseStart.x, eraseStart.y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(eraseStart.x + 16, eraseStart.y + 4, { steps: 4 });
    await page.mouse.up({ button: "right" });
    await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 0, { timeout: 15_000 });
    await waitForSaveCount(eraseSaveCount);
    const heldDelete = await page.evaluate(() => ({
      heldCount: window.__nativeApHost.heldSaves.length,
      save: window.__nativeApHost.saves.at(-1),
    }));
    assert.equal(heldDelete.heldCount, 1, "The native AP delete save must remain unacknowledged for the undo boundary case");
    assert.equal(heldDelete.save.hasBinaryPayload, false, "The ordinary native AP tombstone save must not carry PDF bytes");
    assert.ok(heldDelete.save.operations.some((row) => row.uuid === legacyIdentities[0].uuid && row.deleted === true),
      "Right-drag must persist a tombstone for the exact UUID inspected from the exported PDF");
    const erased = await snapshot("native-ap-erased-ack-held", original.roi.targetRect);
    assert.ok(erased.rawValues.some((row) => row.deleted === true && row.id === reopenedAnnotation.id),
      "Right-drag must serialize the native FreeText annotation tombstone in PDF.js annotation storage");
    assert.ok(!erased.annotation || erased.annotation.hidden || erased.annotation.display === "none" || erased.annotation.rect.width === 0,
      "The erased native FreeText AP must be hidden while its delete ACK is held");
    await viewer.waitForFunction((rect) => window.__sampleNativeApCanvasRoi(rect).differentPixels > 0,
      { timeout: 15_000 }, original.roi.targetRect);
    const erasedRoi = await viewer.evaluate((rect) => window.__sampleNativeApCanvasRoi(rect), original.roi.targetRect);
    assert.ok(erasedRoi.differentPixels > 0 && erasedRoi.fingerprint !== original.roi.fingerprint,
      "Right-drag must remove pixels from the immutable native AP page-canvas ROI");
    evidence.push({ stage: "native-ap-delete-held", erasedRoi, heldDelete });
    await persistEvidence("native-ap-delete-held");

    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.keyboard.up("Meta");
    await viewer.waitForFunction(() => {
      const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
      return [...(manager?.getEditors(0) || [])].some((editor) =>
        editor.annotationElementId && editor.deleted === false && editor.editorType === "freetext");
    }, { timeout: 10_000 });
    const undoWhileHeld = await snapshot("trusted-undo-while-delete-ack-held", original.roi.targetRect);
    const undoKey = undoWhileHeld.trustedUndoKeys.at(-1);
    assert.ok(undoKey?.metaKey && undoKey.key.toLowerCase() === "z", "Undo must be a trusted Meta-Z key event");
    assert.equal(undoWhileHeld.mode, 0, "Undo must stay in NONE mode while the native delete save ACK is pending");
    assert.equal(undoWhileHeld.editor?.annotationElementId, reopenedAnnotation.id,
      "Undo must restore the same native FreeText PDF object identity while ACK is held");
    assert.equal(undoWhileHeld.roi.fingerprint, erasedRoi.fingerprint,
      "The native AP page canvas must remain erased until the held delete ACK is released");
    assert.ok(!undoWhileHeld.annotation || undoWhileHeld.annotation.hidden || undoWhileHeld.annotation.display === "none" || undoWhileHeld.annotation.rect.width === 0,
      "The AP repair must wait until the host acknowledges the held delete save");
    assert.equal(undoWhileHeld.host.heldSaves, 1, "The host must still be holding the original delete ACK at the undo boundary");

    assert.equal(await page.evaluate(() => window.__releaseHeldSaveAcks()), 1,
      "The host must release exactly the held native delete ACK");
    await waitForSaveCount(eraseSaveCount + 1);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
    await viewer.waitForFunction((rect) => {
      const sample = window.__sampleNativeApCanvasRoi(rect);
      return sample.differentPixels === 0 && sample.fingerprint === sample.baselineFingerprint;
    }, { timeout: 15_000 }, original.roi.targetRect);
    const afterUndo = await snapshot("after-delete-ack-and-undo-repair", original.roi.targetRect);
    assert.ok(afterUndo.annotation?.hidden || afterUndo.annotation?.display === "none" || afterUndo.annotation?.rect?.width === 0,
      "The native PDF.js annotation DOM must stay suppressed while the inspected external identity owns the embedded AP");
    assert.equal(afterUndo.mode, 0, "Undo must keep the viewer in NONE mode after ACK-triggered repair");
    assert.equal(afterUndo.annotation?.annotationId, reopenedAnnotation.id, "Undo must restore the same saved native AP reference");
    assert.equal(afterUndo.editor?.annotationElementId, reopenedAnnotation.id, "Undo must retain the same native AP editor identity");
    assert.equal(afterUndo.editor?.uid, undoWhileHeld.editor?.uid,
      "Page repaint after ACK must preserve the exact undo-restored editor instance");
    const undoUpsert = afterUndo.host.saves.at(-1)?.operations.find((row) => row.uuid === legacyIdentities[0].uuid);
    assert.ok(undoUpsert, "Undo must persist the exact UUID returned by mergeCore.inspect");
    assert.equal(undoUpsert.deleted, false, "Undo must persist a live operation instead of repeating the held tombstone");
    assert.equal(undoUpsert.embeddedRef, reopenedAnnotation.id, "Undo must retain the exact native PDF object reference");
    assert.equal(afterUndo.host.saves.length, eraseSaveCount + 1,
      "The visual PDF page repaint must not create another host save or document revision");
    assert.ok(afterUndo.roi.nonWhitePixels >= Math.max(1, Math.floor(original.roi.nonWhitePixels * 0.75)),
      "Undo must repaint visible native AP pixels on the PDF page canvas");
    assert.equal(afterUndo.roi.fingerprint, original.roi.fingerprint, "Undo must restore the original native AP ROI pixel-for-pixel");
    assert.equal(afterUndo.roi.differentPixels, 0, "Undo page-canvas ROI must match the immutable native AP baseline exactly");

    await page.keyboard.down("Meta");
    await page.keyboard.down("Shift");
    await page.keyboard.press("z");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Meta");
    await viewer.waitForFunction((expected) => {
      const page = document.querySelector('.page[data-page-number="1"]');
      const section = [...(page?.querySelectorAll(".annotationLayer .freeTextAnnotation") || [])]
        .find((node) => node.textContent.includes("NativeAppearanceProof"));
      const sample = window.__sampleNativeApCanvasRoi(expected.rect);
      return PDFViewerApplication.pdfViewer.annotationEditorMode === 0 &&
        (!section || section.hidden || getComputedStyle(section).display === "none" || section.getBoundingClientRect().width === 0) &&
        sample.fingerprint === expected.fingerprint && sample.differentPixels > 0;
    }, { timeout: 15_000 }, { rect: original.roi.targetRect, fingerprint: erasedRoi.fingerprint });
    const afterRedo = await snapshot("trusted-redo", original.roi.targetRect);
    assert.ok(!afterRedo.annotation || afterRedo.annotation.hidden || afterRedo.annotation.display === "none" || afterRedo.annotation.rect.width === 0,
      "Redo must hide the restored native FreeText AP again");
    assert.equal(afterRedo.roi.fingerprint, erasedRoi.fingerprint, "Redo must restore the same erased page-canvas ROI pixels");
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });

    const finalSaveCount = await page.evaluate(() => window.__nativeApHost.saves.length + 1);
    await page.keyboard.down("Meta");
    await page.keyboard.press("z");
    await page.keyboard.up("Meta");
    await viewer.waitForFunction((rect) => {
      const sample = window.__sampleNativeApCanvasRoi(rect);
      window.__nativeApSecondUndoRoiPoll = { at: performance.now(), sample, mode: PDFViewerApplication.pdfViewer.annotationEditorMode };
      return sample.differentPixels === 0;
    }, { timeout: 15_000 }, original.roi.targetRect);
    const afterSecondUndo = await snapshot("second-trusted-undo", original.roi.targetRect);
    assert.ok(afterSecondUndo.annotation?.hidden || afterSecondUndo.annotation?.display === "none" || afterSecondUndo.annotation?.rect?.width === 0,
      "The second undo must keep one external owner instead of exposing a duplicate native annotation layer");
    assert.equal(afterSecondUndo.mode, 0, "A second undo must remain in NONE mode");
    assert.equal(afterSecondUndo.annotation?.annotationId, reopenedAnnotation.id, "A second undo must restore the same saved AP reference");
    assert.equal(afterSecondUndo.editor?.uid, undoWhileHeld.editor?.uid,
      "Redo followed by second undo must preserve the same editor-history identity");
    assert.equal(afterSecondUndo.roi.fingerprint, original.roi.fingerprint,
      "A second undo must restore the original native AP page-canvas ROI pixels");
    assert.equal(afterSecondUndo.roi.differentPixels, 0, "Second undo must match original AP pixels exactly");

    await waitForSaveCount(finalSaveCount);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
    for (const save of await page.evaluate(() => [
      ...window.__nativeApHost.saves, ...window.__nativeApHost.recoveries,
    ])) {
      assert.equal(save.hasBinaryPayload, false,
        `Ordinary ${save.type} message ${save.requestId} must not mutate or transmit the immutable PDF source`);
    }
    const reopenCount = await page.evaluate(() => window.__nativeApHost.opened + 1);
    await page.evaluate(() => window.__sendOpenSaved());
    await waitForOpenCount(reopenCount);
    await page.waitForFunction(() => window.__nativeApHost.sourceIdentityConfirmed, { timeout: 15_000 });
    await waitForPageReady();
    await viewer.waitForFunction((uuid) => {
      const state = window.__freeTextNativeApBridgeState;
      const row = state?.externalAnnotationRows?.get(uuid);
      const binding = state?.externalAnnotationHydration?.get(uuid);
      return row?.deleted === false && binding?.row?.deleted === false;
    }, { timeout: 15_000 }, legacyIdentities[0].uuid);
    const afterFinalReopen = await snapshot("final-reopen-native-ap", original.roi.targetRect);
    const finalAnnotation = await viewer.evaluate(async () => {
      const page = await PDFViewerApplication.pdfDocument.getPage(1);
      const annotation = (await page.getAnnotations()).find((entry) =>
        entry.subtype === "FreeText" &&
        (entry.contents?.includes("NativeAppearanceProof") || entry.contentsObj?.str?.includes("NativeAppearanceProof")),
      );
      return annotation ? { id: annotation.id, hasAppearance: annotation.hasAppearance } : null;
    });
    assert.ok(afterFinalReopen.annotation?.hidden || afterFinalReopen.annotation?.display === "none" || afterFinalReopen.annotation?.rect?.width === 0,
      "The final reopen must suppress the PDF.js annotation DOM while the external identity owns the AP");
    assert.equal(afterFinalReopen.annotation?.annotationId, reopenedAnnotation.id,
      "The final reopened external annotation must bind to the same PDF object reference");
    const reopenedUpsert = afterFinalReopen.host.operations.find((row) => row.uuid === legacyIdentities[0].uuid);
    assert.ok(reopenedUpsert, "The final sidecar must retain the exact inspected legacy UUID");
    assert.equal(reopenedUpsert.deleted, false, "The final effective native AP operation must remain live after reopen");
    assert.equal(reopenedUpsert.embeddedRef, reopenedAnnotation.id,
      "The final sidecar operation must retain the exact embedded PDF object reference");
    assert.equal(finalAnnotation?.id, reopenedAnnotation.id, "Final reopen must retain the native annotation reference");
    assert.equal(finalAnnotation?.hasAppearance, true, "Final reopen must retain the native FreeText appearance stream");
    assert.equal(afterFinalReopen.roi.fingerprint, original.roi.fingerprint,
      "Final reopen must reproduce the original native AP page-canvas pixels");
    assert.equal(afterFinalReopen.roi.differentPixels, 0,
      "Final reopened saved AP must match the original native pixels exactly");
    const finalSourceBytes = await viewer.evaluate(async () =>
      Array.from(new Uint8Array(await PDFViewerApplication.pdfDocument.getData())));
    assert.equal(sha256(Buffer.from(finalSourceBytes)), exportedPdfHash,
      "Ordinary saves, undo/redo, and final reopen must leave the explicit-export PDF source bytes immutable");
    assert.deepEqual(externalRequests, [], "The PDF fixture must not request external origins");
    assert.deepEqual(errors, [], "The browser page must not report uncaught errors");
    assert.deepEqual(await page.evaluate(() => window.__nativeApHost.errors), [], "The host harness must not receive bridge errors");
    evidence.push({ stage: "pass", sourceHash: exportedPdfHash, identity: legacyIdentities[0],
      afterUndo, afterRedo, afterSecondUndo, afterFinalReopen, finalAnnotation });
    await persistEvidence("pass");
    await page.screenshot({ path: path.join(artifactsPath, `${artifactBase}.png`), fullPage: false });
    t.diagnostic(`Native AP evidence: ${artifactJson}`);
  } catch (error) {
    functionalError = error;
    const viewerFrame = page?.frames().find((frame) => frame.name() === "pdf-reader");
    const liveViewerState = viewerFrame ? await viewerFrame.evaluate(() => {
      const app = PDFViewerApplication;
      const pageNode = document.querySelector('.page[data-page-number="1"]');
      const sections = [...(pageNode?.querySelectorAll(".annotationLayer .freeTextAnnotation") || [])].map((node) => {
        const rect = node.getBoundingClientRect();
        return { id: node.id, annotationId: node.getAttribute("data-annotation-id"), text: node.textContent, hidden: node.hidden, display: getComputedStyle(node).display, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
      });
      const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      const editors = [...(manager?.getEditors(0) || [])].map((editor) => ({
        id: editor.id, uid: editor.uid, annotationElementId: editor.annotationElementId, deleted: editor.deleted,
        editorType: editor.editorType, serialized: editor.serialize?.() ?? null,
      }));
      const rawValues = [...(app?.pdfDocument?.annotationStorage?.serializable?.map?.values?.() || [])]
        .map((row) => ({ id: row.id, annotationType: row.annotationType, deleted: row.deleted, value: row.value }));
      const targetRect = window.__nativeApSecondUndoRoiPoll?.sample?.targetRect || null;
      return {
        mode: app?.pdfViewer?.annotationEditorMode ?? null,
        renderingState: app?.pdfViewer?.getPageView(0)?.renderingState ?? null,
        loaded: pageNode?.dataset.loaded ?? null,
        sections, editors, rawValues,
        lastSecondUndoRoiPoll: window.__nativeApSecondUndoRoiPoll || null,
        currentRoi: targetRect && window.__sampleNativeApCanvasRoi(targetRect),
        trustedUndoKeys: window.__trustedUndoKeys || [],
      };
    }).catch((captureError) => ({ captureError: String(captureError?.message || captureError) })) : null;
    evidence.push({ stage: "failure-live-viewer-state", viewer: liveViewerState });
    evidence.push({ stage: "failure", name: error?.name || "Error", message: String(error?.message || error), stack: error?.stack || null });
    await page?.screenshot({ path: path.join(artifactsPath, `${artifactBase}.failure.png`), fullPage: false }).catch(() => {});
    await persistEvidence("failure").catch(() => {});
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
    if (cleanupReport.errors.length) {
      await writeFile(path.join(artifactsPath, `${artifactBase}.cleanup.json`), JSON.stringify(cleanupReport, null, 2), "utf8").catch(() => {});
      t.diagnostic(`Cleanup report: ${path.join(artifactsPath, `${artifactBase}.cleanup.json`)}`);
    }
  }
  const finalError = attachCleanupErrors(functionalError, cleanupReport);
  if (finalError) throw finalError;
});
