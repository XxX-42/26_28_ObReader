import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";

const browserPath = resolveBrowserPath();
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const viewerHtmlPath = path.join(
  root,
  "vendor",
  "pdfjs-generic-legacy",
  "web",
  "viewer.html",
);
const artifactsPath = path.join(root, "tests", "artifacts");
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
  "sync bridge persists UUID sidecar operations, hydrates remote state, and fails closed on PDF replacement",
  {
    skip: !browserPath && "Chrome or Edge is required for this browser regression",
    timeout: 120_000,
  },
  async (t) => {
    const channel = "pdf-web-reader";
    const token = `sync-sidecar-${Date.now()}-${process.pid}`;
    const rendererGeneration = `sync-renderer-${Date.now()}`;
    const documentId = "sync-sidecar-fixture-document";
    const documentPath = "tests/fixtures/tracemonkey.pdf";
    const runId = `${Date.now()}-${process.pid}`;
    const fixtureBytes = await readFile(fixturePath);
    const sourceHash = createHash("sha256").update(fixtureBytes).digest("hex");
    const bridgeSource = await readFile(bridgePath, "utf8");
    const instrumentedBridgeSource = bridgeSource.replace(
      "  if (iosInputPolicy) {",
      `  window.__syncBridgeState = state;
  window.__syncPointerProbe = [];
  for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click"]) {
    document.addEventListener(type, (event) => window.__syncPointerProbe.push({
      type, trusted: event.isTrusted, target: event.target?.className || event.target?.id || event.target?.tagName,
      x: event.clientX, y: event.clientY, buttons: event.buttons, prevented: event.defaultPrevented,
    }), true);
  }
  if (iosInputPolicy) {`,
    );
    assert.notEqual(instrumentedBridgeSource, bridgeSource,
      "The browser harness should expose bridge internals only for this regression");

    const viewerHtml = await readFile(viewerHtmlPath, "utf8");
    const viewerWithBridge = viewerHtml.replace(
      /<head\b[^>]*>/i,
      (head) => `${head}<script src="/viewer/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}"></script>`,
    );
    let browser;
    let page;
    let server;
    let primaryError = null;
    let cleanupReport = null;

    server = createServer(async (request, response) => {
      for (const [name, value] of Object.entries(withTestNetworkFirewall())) {
        response.setHeader(name, value);
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html>
          <meta charset="utf-8">
          <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
          <iframe title="PDF Reader" src="/viewer/web/viewer.html"></iframe>
          ${browserSidecarHarnessScript({
            channel,
            token,
            sourceHash: `sha256:${sourceHash}`,
            sourcePath: documentPath,
          })}
          <script>
            const channel=${JSON.stringify(channel)};
            const token=${JSON.stringify(token)};
            const rendererGeneration=${JSON.stringify(rendererGeneration)};
            const documentId=${JSON.stringify(documentId)};
            const documentPath=${JSON.stringify(documentPath)};
            const iframe=document.querySelector('iframe');
            const host=window.__syncSidecarHost={opened:[],saves:[],recoveries:[],checkpoints:[],applyReplies:[],errors:[],sourceSha256:${JSON.stringify(sourceHash)},sourceBytes:null,nextOpenRequest:0,autoAck:false};
            const sendOpen=openRequest=>{
              if(!(host.sourceBytes instanceof ArrayBuffer))throw new Error('Fixture PDF bytes are unavailable');
              const data=host.sourceBytes.slice(0);
              iframe.contentWindow.postMessage({channel,type:'open',token,rendererGeneration,documentId,documentPath,filename:'tracemonkey.pdf',autoSave:false,openRequest,data},'*',[data]);
            };
            host.reopen=()=>{host.nextOpenRequest+=1;sendOpen(host.nextOpenRequest);return host.nextOpenRequest;};
            host.ackSave=(index,overrides={})=>{
              const save=host.saves[index];
              if(!save)throw new Error('No captured sidecar save at index '+index);
              iframe.contentWindow.postMessage({channel,type:'saved',token,rendererGeneration:save.rendererGeneration,documentId:save.documentId,openRequest:save.openRequest,requestId:save.requestId,revision:save.revision,external:true,operationCount:save.operations.length,batchId:save.operations.length?'sidecar-batch-'+save.requestId:null,...overrides},'*');
            };
            window.addEventListener('message',event=>{
              if(event.source!==iframe.contentWindow)return;
              const message=event.data;
              if(!message||message.channel!==channel||message.token!==token)return;
              if(message.type==='ready'){
                fetch('/tests/fixtures/tracemonkey.pdf').then(response=>response.arrayBuffer()).then(data=>{
                  host.sourceBytes=data;
                  host.nextOpenRequest=1;
                  sendOpen(host.nextOpenRequest);
                }).catch(error=>host.errors.push(String(error?.message||error)));
              }else if(message.type==='opened'){
                host.opened.push({documentId:message.documentId,openRequest:message.openRequest,revision:message.revision,confirmedRevision:message.confirmedRevision,dirty:message.dirty,rendererGeneration:message.rendererGeneration});
              }else if(message.type==='save'||message.type==='recover'){
                const operations=Array.isArray(message.operations)?message.operations:[];
                const record={type:message.type,documentId:message.documentId,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,requestId:message.requestId,revision:message.revision,operations:structuredClone(operations),dirtyState:message.dirtyState||null,actorId:message.actorId||null,sourceBytes:message.data?.byteLength||0};
                (message.type==='save'?host.saves:host.recoveries).push(record);
                if(message.type==='recover'){
                  host.errors.push('Unexpected recovery request during an ordinary sidecar save test');
                }else if(host.autoAck){
                  setTimeout(()=>host.ackSave(host.saves.length-1),0);
                }
              }else if(message.type==='sync-checkpoint-ready'){
                host.checkpoints.push({id:message.id,documentId:message.documentId,openRequest:message.openRequest,revision:message.revision,confirmedRevision:message.confirmedRevision,dirty:message.dirty,ok:message.ok,operations:structuredClone(message.operations||[]),dirtyState:message.dirtyState||null,byteLength:message.data?.byteLength||0});
              }else if(message.type==='sync-checkpoint-rejected'){
                host.errors.push('Checkpoint rejected: '+String(message.reason||'unknown'));
              }else if(message.type==='sync-apply-prepared'||message.type==='sync-apply-rejected'){
                host.applyReplies.push({type:message.type,id:message.id,ok:message.ok,reason:message.reason,documentId:message.documentId,openRequest:message.openRequest});
              }else if(message.type==='error'){
                host.errors.push(message.message||message.code||'Viewer error');
              }
            });
          </script>`);
        return;
      }
      let target;
      if (url.pathname === "/viewer/web/viewer.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(viewerWithBridge);
        return;
      }
      if (url.pathname === "/viewer/obsidian-bridge.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(instrumentedBridgeSource);
        return;
      }
      if (url.pathname === "/tests/fixtures/tracemonkey.pdf") {
        target = fixturePath;
      } else if (url.pathname.startsWith("/build/") || url.pathname.startsWith("/viewer/")) {
        const prefix = url.pathname.startsWith("/build/") ? "/" : "/viewer/";
        const relative = decodeURIComponent(url.pathname.slice(prefix.length));
        target = path.resolve(root, "vendor", "pdfjs-generic-legacy", relative);
        const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
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

    try {
      await mkdir(artifactsPath, { recursive: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      browser = await launchTestBrowser(
        puppeteer,
        {
          executablePath: browserPath,
          headless: true,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
        },
        { testName: "sync-bridge-regression", artifactsDir: artifactsPath },
      );
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`http://127.0.0.1:${server.address().port}`, {
        waitUntil: "domcontentloaded",
      });
      const viewer = page.frames().find((frame) => frame.url().includes("/viewer/web/viewer.html"));
      assert.ok(viewer, "The PDF.js viewer iframe should load");
      await page.waitForFunction(() => window.__syncSidecarHost?.opened.some(
        (entry) => entry.openRequest === 1,
      ), { timeout: 30_000 });
      await viewer.waitForFunction(() => {
        const app = window.PDFViewerApplication;
        const bridge = window.__syncBridgeState;
        const pageView = app?.pdfViewer?.getPageView(0);
        const buttons = [
          "editorUnderlineButton", "editorSquareButton", "editorHighlightButton",
          "editorInkButton", "editorFreeTextButton",
        ].map((id) => document.getElementById(id));
        return Boolean(app?.pdfDocument && pageView?.pdfPage &&
          pageView?.annotationEditorLayer?.div?.isConnected &&
          bridge?.externalSourceConfirmed && buttons.every((button) => button && !button.disabled));
      }, { timeout: 30_000 });

      await viewer.evaluate(async () => {
        PDFViewerApplication.pdfViewer.currentScaleValue = "page-fit";
        await new Promise(requestAnimationFrame);
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          mode: 5, isFromKeyboard: true, createNewEditor: false,
        });
      });
      await viewer.waitForFunction(() =>
        PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
      { timeout: 15_000 });
      await viewer.waitForFunction(() =>
        document.querySelector('.page[data-page-number="1"] .annotationEditorLayer.squareEditing'),
      { timeout: 15_000 });
      const pageRect = await viewer.$eval('.page[data-page-number="1"]', (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const iframeRect = await page.$eval("iframe", (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      const start = {
        x: iframeRect.x + pageRect.x + pageRect.width * 0.26,
        y: iframeRect.y + pageRect.y + pageRect.height * 0.32,
      };
      const end = {
        x: start.x + Math.min(75, pageRect.width * 0.12),
        y: start.y + Math.min(52, pageRect.height * 0.12),
      };
      await viewer.evaluate((geometry) => {
        window.__syncDrawGeometry = geometry;
      }, { pageRect, iframeRect, start, end });
      const startHit = await viewer.evaluate(({ x, y, frameX, frameY }) => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer.squareEditing',
        );
        const hit = document.elementFromPoint(x - frameX, y - frameY);
        return {
          layerReady: Boolean(layer),
          targetIsLayer: Boolean(layer && (hit === layer || layer.contains(hit))),
          hit: hit?.className || hit?.id || hit?.tagName || null,
        };
      }, { x: start.x, y: start.y, frameX: iframeRect.x, frameY: iframeRect.y });
      assert.equal(startHit.layerReady, true,
        "Square mode must be applied to the page layer before pointerdown");
      assert.equal(startHit.targetIsLayer, true,
        `The trusted Square gesture must begin on its editing layer, got ${startHit.hit}`);
      const priorSquares = await viewer.evaluate(() => {
        const map = PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map;
        return map instanceof Map
          ? [...map.values()].filter((value) => value?.annotationType === 5).length
          : 0;
      });
      await page.mouse.move(start.x, start.y, { steps: 2 });
      await page.mouse.down({ button: "left" });
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up({ button: "left" });
      await viewer.waitForFunction((before) => {
        const map = PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map;
        return map instanceof Map &&
          [...map.values()].filter((value) => value?.annotationType === 5).length > before;
      }, { timeout: 15_000 }, priorSquares);

      const requestCheckpoint = async (id, openRequest = 1) => {
        await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id: requestId, openRequest: currentOpenRequest }) => {
          document.querySelector("iframe").contentWindow.postMessage({
            channel: messageChannel, type: "sync-checkpoint", token: sessionToken,
            rendererGeneration: generation, id: requestId, documentId: currentDocumentId,
            openRequest: currentOpenRequest,
          }, "*");
        }, { channel, token, rendererGeneration, documentId, id, openRequest });
        await page.waitForFunction((requestId) => window.__syncSidecarHost?.checkpoints.some(
          (entry) => entry.id === requestId,
        ), { timeout: 15_000 }, id);
        const checkpoint = await page.evaluate((requestId) =>
          window.__syncSidecarHost.checkpoints.find((entry) => entry.id === requestId), id);
        assert.equal(checkpoint.ok, true, `Checkpoint ${id} should be accepted`);
        assert.equal(checkpoint.byteLength, 0,
          "A sidecar checkpoint must not serialize or transfer the source PDF");
        return checkpoint;
      };

      const first = await requestCheckpoint("sidecar-checkpoint-created");
      assert.equal(first.dirty, true, "The unsaved annotation checkpoint must remain dirty");
      assert.ok(first.operations.length > 0, "A real editor gesture must produce a WAL operation");
      const rawFirst = first.operations.find((operation) =>
        operation.kind === "Square" && operation.deleted !== true,
      );
      assert.ok(rawFirst, "The checkpoint should contain the newly created Square operation");
      assert.equal(rawFirst.pageIndex, 0);
      assert.equal(rawFirst.payload.editor.annotationType, 5);
      assert.equal(rawFirst.payload.editor.pageIndex, 0);
      assert.equal(rawFirst.deleted, false);
      assert.equal(rawFirst.embeddedRef, null,
        "A sidecar annotation does not need a PDF object reference");
      assert.ok(Array.isArray(rawFirst.payload.editor.rect) &&
        rawFirst.payload.editor.rect.length === 4 &&
        rawFirst.payload.editor.rect.every(Number.isFinite) &&
        rawFirst.payload.editor.rect[2] > rawFirst.payload.editor.rect[0] &&
        rawFirst.payload.editor.rect[3] > rawFirst.payload.editor.rect[1],
      "The durable Square payload must preserve its positive-area source-space geometry");
      assert.ok(rawFirst.clock && Number.isSafeInteger(rawFirst.clock.timestamp) &&
        Number.isSafeInteger(rawFirst.clock.logical) &&
        typeof rawFirst.clock.deviceId === "string" && rawFirst.clock.deviceId.length > 0 &&
        typeof rawFirst.clock.opId === "string" && rawFirst.clock.opId.length > 0,
      "The sidecar operation must carry its complete deterministic clock");
      const uuid = rawFirst.uuid;
      assert.equal(typeof uuid, "string");
      assert.ok(uuid.length > 0);

      await viewer.evaluate(() => { void PDFViewerApplication.save(); });
      await page.waitForFunction(() => window.__syncSidecarHost?.saves.length === 1, {
        timeout: 15_000,
      });
      const saved = await page.evaluate(() => window.__syncSidecarHost.saves[0]);
      assert.equal(saved.documentId, documentId);
      assert.equal(saved.openRequest, 1);
      assert.equal(saved.rendererGeneration, rendererGeneration);
      assert.ok(saved.requestId.includes(rendererGeneration),
        "The durable save request must be scoped to this renderer generation");
      assert.equal(saved.sourceBytes, 0,
        "Ordinary sidecar saves must never transfer or serialize the PDF source");
      assert.ok(saved.operations.some((operation) => operation.uuid === uuid));
      const durableOperation = await page.evaluate((currentDocumentId, annotationUuid) =>
        window.__browserSidecarHost.operationsFor(currentDocumentId)
          .find((operation) => operation.uuid === annotationUuid),
      documentId, uuid);
      assert.ok(durableOperation, "The host must persist the operation before acknowledging it");
      assert.equal(durableOperation.kind, "Square");
      assert.deepEqual(durableOperation.payload, rawFirst.payload);
      assert.equal(durableOperation.clock.opId, rawFirst.clock.opId);

      await page.evaluate(({ channel: messageChannel, token: sessionToken }) => {
        const frame = document.querySelector("iframe").contentWindow;
        const save = window.__syncSidecarHost.saves[0];
        frame.postMessage({
          channel: messageChannel, type: "saved", token: sessionToken,
          documentId: save.documentId, openRequest: save.openRequest,
          rendererGeneration: "stale-renderer-generation", requestId: save.requestId,
          revision: save.revision, external: true,
          operationCount: save.operations.length, batchId: "stale-batch",
        }, "*");
      }, { channel, token });
      await viewer.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const dirtyAfterStaleAck = await viewer.evaluate(() => window.__syncBridgeState.dirty);
      assert.equal(dirtyAfterStaleAck, true,
        "A stale renderer-generation ACK must not clear the local dirty revision");
      await page.evaluate(() => {
        window.__syncSidecarHost.autoAck = true;
        window.__syncSidecarHost.ackSave(0);
      });
      await viewer.waitForFunction(() => {
        const state = window.__syncBridgeState;
        return state && !state.dirty && state.confirmedRevision >= state.revision;
      }, { timeout: 15_000 });
      const clean = await requestCheckpoint("sidecar-checkpoint-after-ack");
      assert.equal(clean.dirty, false,
        "Only the exact durable ACK should settle the committed revision");
      assert.deepEqual(clean.operations, [],
        "A clean checkpoint carries no new operation delta after the exact durable ACK");
      const acknowledgedSnapshotRow = await page.evaluate((currentDocumentId, annotationUuid) =>
        window.__browserSidecarHost.snapshotFor(currentDocumentId)?.annotations
          .find((operation) => operation.uuid === annotationUuid), documentId, uuid);
      assert.ok(acknowledgedSnapshotRow,
        "The durable host snapshot, rather than the clean delta, retains the acknowledged operation");
      assert.equal(acknowledgedSnapshotRow.payload.editor.annotationType, 5);
      assert.deepEqual(acknowledgedSnapshotRow.payload.editor.rect, rawFirst.payload.editor.rect);

      const beforeSelfEcho = await viewer.evaluate((annotationUuid) => {
        const bridge = window.__syncBridgeState;
        const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        const editors = [...manager.getEditors(0)].filter((editor) =>
          editor.deleted !== true &&
          bridge.annotationUuidByRuntimeId.get(String(editor.id)) === annotationUuid,
        );
        return editors.map((editor) => String(editor.id));
      }, uuid);
      assert.equal(beforeSelfEcho.length, 1,
        "The committed local UUID must map to exactly one live PDF.js editor");
      assert.ok(await page.evaluate(({ currentDocumentId, openRequest }) =>
        window.__browserSidecarHost.broadcastSnapshot(currentDocumentId, openRequest),
      { currentDocumentId: documentId, openRequest: 1 }),
      "The host should replay the durable sidecar snapshot to the originating Reader");
      await viewer.waitForFunction((annotationUuid) =>
        window.__syncBridgeState.externalAnnotationHydration.has(annotationUuid),
      { timeout: 10_000 }, uuid);
      const afterSelfEcho = await viewer.evaluate((annotationUuid) => {
        const bridge = window.__syncBridgeState;
        const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        const editors = [...manager.getEditors(0)].filter((editor) =>
          editor.deleted !== true &&
          bridge.annotationUuidByRuntimeId.get(String(editor.id)) === annotationUuid,
        );
        return {
          ids: editors.map((editor) => String(editor.id)),
          boundRuntimeId: bridge.externalAnnotationHydration.get(annotationUuid)?.runtimeId || null,
          dirty: bridge.dirty,
        };
      }, uuid);
      assert.deepEqual(afterSelfEcho.ids, beforeSelfEcho,
        "A self-originated sidecar snapshot must not create or replace the live editor");
      assert.equal(afterSelfEcho.boundRuntimeId, beforeSelfEcho[0]);
      assert.equal(afterSelfEcho.dirty, false,
        "Hydrating the writer's own snapshot must not create a new local edit");

      const editorRuntimeId = beforeSelfEcho[0];
      await viewer.evaluate((runtimeId) => {
        const app = PDFViewerApplication;
        const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor = manager.getEditor(runtimeId);
        if (!editor) throw new Error("The committed Square editor must remain addressable");
        manager.setSelected(editor);
        app.eventBus.dispatch("switchannotationeditorparams", {
          source: window, type: 62, value: 4,
        });
      }, editorRuntimeId);
      await viewer.waitForFunction((runtimeId) =>
        PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager
          .getEditor(runtimeId)?.serialize?.()?.thickness === 4,
      { timeout: 10_000 }, editorRuntimeId);
      const styleCheckpoint = await requestCheckpoint("sidecar-checkpoint-square-style");
      const styled = styleCheckpoint.operations.find((operation) => operation.uuid === uuid);
      assert.ok(styled, "A style edit must retain the stable annotation UUID");
      assert.equal(styled.deleted, false);
      assert.equal(styled.kind, "Square");
      assert.equal(styled.payload.editor.thickness, 4,
        "A committed Square style edit must be captured from the live PDF.js editor");
      const styledRect = styled.payload.editor.rect;
      assert.deepEqual(styledRect.map((value, index) =>
        Number((value - rawFirst.payload.editor.rect[index]).toFixed(3)),
      ), [-1.5, -1.5, 1.5, 1.5],
      "Increasing a Square border from 1pt to 4pt must preserve its visual path by expanding each edge 1.5pt");

      await viewer.evaluate((runtimeId) => {
        const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor = manager.getEditor(runtimeId);
        if (!editor) throw new Error("The local Square editor must be available for delete/undo testing");
        manager.deleteEditor(editor);
      }, editorRuntimeId);
      const deleteCheckpoint = await requestCheckpoint("sidecar-checkpoint-square-delete");
      const deletedOperation = deleteCheckpoint.operations.find((operation) => operation.uuid === uuid);
      assert.equal(deletedOperation?.deleted, true,
        "Deleting a local editor must create a UUID tombstone, not mutate the PDF source");
      assert.equal(deletedOperation?.kind, "Square");
      assert.equal(deletedOperation?.pageIndex, 0);

      await viewer.evaluate(() => PDFViewerApplication.pdfViewer._layerProperties
        .annotationEditorUIManager.undo());
      const undoCheckpoint = await requestCheckpoint("sidecar-checkpoint-square-undo");
      const undoOperation = undoCheckpoint.operations.find((operation) => operation.uuid === uuid);
      assert.equal(undoOperation?.deleted, false,
        "Undo must restore the same UUID as an active sidecar operation");
      assert.equal(undoOperation?.payload.editor.thickness, 4);
      assert.deepEqual(undoOperation?.payload.editor.rect, styledRect,
        "Undo must preserve the committed styled geometry, not revert its border inset");

      await viewer.evaluate(() => PDFViewerApplication.pdfViewer._layerProperties
        .annotationEditorUIManager.redo());
      const redoCheckpoint = await requestCheckpoint("sidecar-checkpoint-square-redo");
      const redoOperation = redoCheckpoint.operations.find((operation) => operation.uuid === uuid);
      assert.equal(redoOperation?.deleted, true,
        "Redo must restore the tombstone for the same UUID");
      await viewer.evaluate(async () => PDFViewerApplication.save());
      await page.waitForFunction(() => window.__syncSidecarHost?.saves.length === 2, {
        timeout: 15_000,
      });
      const deleteSave = await page.evaluate(() => window.__syncSidecarHost.saves[1]);
      assert.ok(deleteSave.operations.some((operation) =>
        operation.uuid === uuid && operation.deleted === true,
      ), "The durable save batch must include the exact UUID tombstone, not a PDF byte payload");
      assert.equal(deleteSave.sourceBytes, 0);
      await viewer.waitForFunction(() => !window.__syncBridgeState.dirty, { timeout: 15_000 });
      const tombstone = await page.evaluate((currentDocumentId, annotationUuid) =>
        window.__browserSidecarHost.snapshotFor(currentDocumentId)?.tombstones
          .find((operation) => operation.uuid === annotationUuid), documentId, uuid);
      assert.ok(tombstone, "The durable snapshot must retain the deleted UUID tombstone");
      assert.equal(Object.hasOwn(tombstone, "deleted"), false,
        "The compact tombstone ledger must not serialize deleted:true rows");

      await viewer.evaluate(() => PDFViewerApplication.pdfViewer._layerProperties
        .annotationEditorUIManager.undo());
      const revivedCheckpoint = await requestCheckpoint("sidecar-checkpoint-square-revive");
      const revived = revivedCheckpoint.operations.find((operation) => operation.uuid === uuid);
      assert.equal(revived?.deleted, false);
      assert.equal(revived?.payload.editor.thickness, 4);
      await viewer.evaluate(async () => PDFViewerApplication.save());
      await page.waitForFunction(() => window.__syncSidecarHost?.saves.length === 3, {
        timeout: 15_000,
      });
      await viewer.waitForFunction(() => !window.__syncBridgeState.dirty, { timeout: 15_000 });
      const activeSnapshotRow = await page.evaluate((currentDocumentId, annotationUuid) =>
        window.__browserSidecarHost.snapshotFor(currentDocumentId)?.annotations
          .find((operation) => operation.uuid === annotationUuid), documentId, uuid);
      assert.ok(activeSnapshotRow, "Undo after a durable delete must revive the same sidecar UUID");
      assert.equal(activeSnapshotRow.payload.editor.thickness, 4);

      const remoteUuid = "remote-sidecar-square-0001";
      const remoteRevision = await page.evaluate(({ currentDocumentId, localUuid, remoteAnnotationUuid }) => {
        const host = window.__browserSidecarHost;
        const documentState = host.documents.get(currentDocumentId);
        const local = documentState?.operations.get(localUuid);
        if (!local) throw new Error("The local durable operation is missing before remote merge");
        const remote = structuredClone(local);
        remote.uuid = remoteAnnotationUuid;
        remote.embeddedRef = null;
        remote.deleted = false;
        remote.clock = {
          timestamp: Math.max(Date.now(), Number(local.clock?.timestamp) || 0) + 100,
          logical: 0,
          deviceId: "remote-device-fixture",
          opId: "remote-device-fixture:sidecar-square-1",
        };
        remote.payload.editor.id = null;
        remote.payload.editor.rect = [240, 320, 310, 390];
        documentState.operations.set(remoteAnnotationUuid, remote);
        documentState.revision += 1;
        host.broadcastSnapshot(currentDocumentId, 1);
        return documentState.revision;
      }, { currentDocumentId: documentId, localUuid: uuid, remoteAnnotationUuid: remoteUuid });
      await viewer.waitForFunction((annotationUuid) =>
        window.__syncBridgeState.externalAnnotationHydration.has(annotationUuid),
      { timeout: 15_000 }, remoteUuid);
      const remoteHydration = await viewer.evaluate((annotationUuid) => {
        const bridge = window.__syncBridgeState;
        const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        const binding = bridge.externalAnnotationHydration.get(annotationUuid);
        const editor = binding && manager.getEditor(binding.runtimeId);
        const rect = editor?.div?.getBoundingClientRect();
        return {
          binding: binding ? { runtimeId: binding.runtimeId, pageIndex: binding.pageIndex } : null,
          row: binding?.row || null,
          editorCount: [...manager.getEditors(0)].filter((candidate) =>
            bridge.annotationUuidByRuntimeId.get(String(candidate.id)) === annotationUuid &&
            candidate.deleted !== true,
          ).length,
          connected: Boolean(editor?.div?.isConnected),
          visible: Boolean(rect?.width > 0 && rect?.height > 0),
          dirty: bridge.dirty,
        };
      }, remoteUuid);
      const hostRemoteRevision = await page.evaluate((currentDocumentId) =>
        window.__browserSidecarHost.snapshotFor(currentDocumentId)?.revision,
      documentId);
      assert.ok(hostRemoteRevision >= remoteRevision,
        "The sidecar host should retain the broadcast revision");
      assert.equal(remoteHydration.row?.uuid, remoteUuid,
        "The Reader must hydrate the exact remote UUID from the current snapshot");
      assert.equal(remoteHydration.row?.clock?.opId, "remote-device-fixture:sidecar-square-1");
      assert.ok(remoteHydration.binding?.runtimeId);
      assert.equal(remoteHydration.binding.pageIndex, 0);
      assert.equal(remoteHydration.editorCount, 1,
        "A remote UUID should hydrate into exactly one live editor");
      assert.equal(remoteHydration.connected, true);
      assert.equal(remoteHydration.visible, true);
      assert.equal(remoteHydration.dirty, false,
        "Remote sidecar hydration must not be mistaken for a local user edit");

      const applyId = "legacy-pdf-replacement-must-fail-closed";
      await page.evaluate(({ channel: messageChannel, sessionToken, generation, currentDocumentId, id }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel, token: sessionToken, rendererGeneration: generation,
          type: "sync-apply-prepare", id, documentId: currentDocumentId, openRequest: 1,
          previousOpenRequest: 1, newOpenRequest: 2, expectedRevision: 1,
        }, "*");
      }, { channel, sessionToken: token, generation: rendererGeneration, currentDocumentId: documentId, id: applyId });
      await page.waitForFunction((id) => window.__syncSidecarHost?.applyReplies.some(
        (reply) => reply.id === id,
      ), { timeout: 10_000 }, applyId);
      const applyReply = await page.evaluate((id) => window.__syncSidecarHost.applyReplies.find(
        (reply) => reply.id === id,
      ), applyId);
      assert.equal(applyReply.type, "sync-apply-rejected");
      assert.equal(applyReply.ok, false);
      assert.equal(applyReply.reason, "immutable-source-annotations-only",
        "A sync request must not replace the immutable source PDF with a merged copy");

      const reopened = await page.evaluate(() => window.__syncSidecarHost.reopen());
      assert.equal(reopened, 2);
      await page.waitForFunction((openRequest) => window.__syncSidecarHost?.opened.some(
        (entry) => entry.documentId === "sync-sidecar-fixture-document" &&
          entry.openRequest === openRequest,
      ), { timeout: 30_000 }, reopened);
      await viewer.waitForFunction(({ openRequest, localUuid, remoteAnnotationUuid }) => {
        const bridge = window.__syncBridgeState;
        return bridge?.activeOpenRequest === openRequest && bridge.externalSourceConfirmed &&
          bridge.externalAnnotationHydration.has(remoteAnnotationUuid) &&
          bridge.externalAnnotationHydration.has(localUuid);
      }, { timeout: 30_000 }, {
        openRequest: reopened, localUuid: uuid, remoteAnnotationUuid: remoteUuid,
      });
      const reopenedState = await viewer.evaluate(({ localUuid, remoteAnnotationUuid }) => {
        const bridge = window.__syncBridgeState;
        const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        const count = (uuid) => [...manager.getEditors(0)].filter((editor) =>
          editor.deleted !== true && bridge.annotationUuidByRuntimeId.get(String(editor.id)) === uuid,
        ).length;
        return {
          documentId: bridge.activeDocumentId,
          openRequest: bridge.activeOpenRequest,
          localEditors: count(localUuid),
          remoteEditors: count(remoteAnnotationUuid),
          localHydration: bridge.externalAnnotationHydration.get(localUuid)?.runtimeId || null,
          remoteHydration: bridge.externalAnnotationHydration.get(remoteAnnotationUuid)?.runtimeId || null,
          dirty: bridge.dirty,
        };
      }, { localUuid: uuid, remoteAnnotationUuid: remoteUuid });
      assert.equal(reopenedState.documentId, documentId);
      assert.equal(reopenedState.openRequest, reopened);
      assert.equal(reopenedState.localEditors, 1,
        "The local UUID must reopen from the sidecar without duplicate editors");
      assert.equal(reopenedState.remoteEditors, 1,
        "The remote UUID must reopen from the sidecar without duplicate editors");
      assert.ok(reopenedState.localHydration);
      assert.ok(reopenedState.remoteHydration);
      assert.equal(reopenedState.dirty, false);

      const finalFixtureBytes = await readFile(fixturePath);
      assert.equal(createHash("sha256").update(finalFixtureBytes).digest("hex"), sourceHash,
        "Ordinary sidecar saves and sync replay must leave the source PDF byte-identical");
      const finalHostState = await page.evaluate(() => ({
        errors: window.__syncSidecarHost.errors,
        saves: window.__syncSidecarHost.saves.map((save) => ({
          requestId: save.requestId,
          revision: save.revision,
          operationCount: save.operations.length,
          sourceBytes: save.sourceBytes,
        })),
        durableWrites: window.__browserSidecarHost.durableWrites.map((write) => ({
          revision: write.revision,
          operationCount: write.operationCount,
          sourceBytes: write.sourceBytes,
        })),
        active: window.__browserSidecarHost.snapshotFor("sync-sidecar-fixture-document")
          ?.annotations.map((operation) => operation.uuid).sort(),
        tombstones: window.__browserSidecarHost.snapshotFor("sync-sidecar-fixture-document")
          ?.tombstones.map((operation) => operation.uuid).sort(),
      }));
      assert.deepEqual(finalHostState.errors, []);
      assert.equal(finalHostState.saves.length, 3,
        "Create, delete, and undo-revive should each cross the durable sidecar save boundary");
      assert.ok(finalHostState.saves.every((save) => save.sourceBytes === 0));
      assert.ok(finalHostState.durableWrites.every((write) => write.sourceBytes === 0));
      assert.ok(finalHostState.active.includes(uuid));
      assert.ok(finalHostState.active.includes(remoteUuid));
      assert.equal(finalHostState.tombstones.includes(uuid), false,
        "Undo after a durable deletion must remove its active tombstone by a newer operation");
      const sourceBytesLoadedByHost = await page.evaluate(() =>
        window.__syncSidecarHost.sourceBytes.byteLength,
      );
      assert.equal(sourceBytesLoadedByHost, fixtureBytes.byteLength);
      t.diagnostic(`Sidecar sync lifecycle verified; source SHA-256=${sourceHash}; rendererGeneration=${rendererGeneration}`);
    } catch (error) {
      primaryError = error;
      try {
        const state = page && !page.isClosed()
          ? await page.evaluate(() => {
              const host = window.__syncSidecarHost;
              const frame = document.querySelector("iframe")?.contentWindow;
              const bridge = frame?.__syncBridgeState;
              const manager = frame?.PDFViewerApplication?.pdfViewer?._layerProperties
                ?.annotationEditorUIManager;
              return {
                host: host && {
                  opened: host.opened,
                  saves: host.saves,
                  recoveries: host.recoveries,
                  checkpoints: host.checkpoints,
                  applyReplies: host.applyReplies,
                  errors: host.errors,
                  sidecarWrites: window.__browserSidecarHost?.durableWrites,
                  snapshot: window.__browserSidecarHost?.snapshotFor("sync-sidecar-fixture-document"),
                },
                bridge: bridge && {
                  activeDocumentId: bridge.activeDocumentId,
                  activeOpenRequest: bridge.activeOpenRequest,
                  revision: bridge.revision,
                  confirmedRevision: bridge.confirmedRevision,
                  dirty: bridge.dirty,
                  externalSourceConfirmed: bridge.externalSourceConfirmed,
                  hydration: [...bridge.externalAnnotationHydration.entries()].map(([uuid, binding]) => ({
                    uuid, runtimeId: binding.runtimeId, pageIndex: binding.pageIndex,
                  })),
                  editors: manager ? [...manager.getEditors(0)].map((editor) => ({
                    id: String(editor.id),
                    uuid: bridge.annotationUuidByRuntimeId.get(String(editor.id)) || null,
                    type: editor.constructor?._editorType || editor.editorType,
                    deleted: editor.deleted === true,
                    serialized: editor.serialize?.(true) || null,
                  })) : [],
                },
                viewer: frame?.PDFViewerApplication && (() => {
                  const pageElement = frame.document.querySelector('.page[data-page-number="1"]');
                  const layer = pageElement?.querySelector(".annotationEditorLayer");
                  const pageRect = pageElement?.getBoundingClientRect();
                  const layerRect = layer?.getBoundingClientRect();
                  const geometry = frame.__syncDrawGeometry;
                  const pointHit = (point) => {
                    if (!point || !frame.document.elementFromPoint) return null;
                    const hit = frame.document.elementFromPoint(
                      point.x - (geometry?.iframeRect?.x || 0),
                      point.y - (geometry?.iframeRect?.y || 0),
                    );
                    return hit?.className || hit?.id || hit?.tagName || null;
                  };
                  return {
                    editorMode: frame.PDFViewerApplication.pdfViewer.annotationEditorMode,
                    geometry,
                    pageRect: pageRect && { x: pageRect.x, y: pageRect.y, width: pageRect.width, height: pageRect.height },
                    layerRect: layerRect && { x: layerRect.x, y: layerRect.y, width: layerRect.width, height: layerRect.height },
                    startHit: pointHit(geometry?.start),
                    endHit: pointHit(geometry?.end),
                    pointers: frame.__syncPointerProbe,
                  };
                })(),
              };
            }).catch((diagnosticError) => ({ error: String(diagnosticError?.message || diagnosticError) }))
          : null;
        const artifact = path.join(artifactsPath, `sync-bridge-failure-${runId}.json`);
        await writeFile(artifact, `${JSON.stringify({
          error: error?.stack || String(error),
          rendererGeneration,
          sourceHash,
          state,
        }, null, 2)}\n`, "utf8");
        t.diagnostic(`Sync regression failure evidence: ${artifact}`);
      } catch (captureError) {
        t.diagnostic(`Could not write sync regression failure evidence: ${captureError?.message || captureError}`);
      }
    } finally {
      cleanupReport = await cleanupBrowserTestResources({
        browser,
        ownedPages: [page].filter(Boolean),
        server,
      });
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) throw finalError;
  },
);
