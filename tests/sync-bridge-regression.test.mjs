import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";

const require = createRequire(import.meta.url);
const { prepareLocal } = require("../plugin/pdf-merge-core.cjs");
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
  "sync bridge keeps UUID operations across saves and applies a prepared checkpoint in place",
  {
    skip: !browserPath && "Chrome or Edge is required for this browser regression",
    timeout: 120_000,
  },
  async (t) => {
    const channel = "pdf-web-reader";
    const token = `sync-bridge-${Date.now()}-${process.pid}`;
    const rendererGeneration = `sync-renderer-${Date.now()}`;
    const documentId = "sync-bridge-fixture-document";
    const actorId = "00000000-0000-4000-8000-000000000001";
    const runId = `${Date.now()}-${process.pid}`;
    const bridgeSource = await readFile(bridgePath, "utf8");
    const loadedBaseBytes = await readFile(fixturePath);
    const viewerHtml = await readFile(viewerHtmlPath, "utf8");
    const viewerWithBridge = viewerHtml.replace(
      /<head\b[^>]*>/i,
      (head) =>
        `${head}<script src="/viewer/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}"></script>`,
    );
    let browser;
    let page;
    let server;
    let primaryError = null;
    let cleanupReport = null;
    const prepareFailures = [];

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
          <script>
            const channel=${JSON.stringify(channel)};
            const token=${JSON.stringify(token)};
            const rendererGeneration=${JSON.stringify(rendererGeneration)};
            const documentId=${JSON.stringify(documentId)};
            const actorId=${JSON.stringify(actorId)};
            const iframe=document.querySelector('iframe');
            const state=window.__syncHost={ready:false,opened:[],startupTimings:[],saves:[],recoveries:[],flushes:[],checkpoints:[],prepared:[],rejected:[],applied:[],cancelled:[],errors:[],preparedLocal:null,prepareCount:0,rejectNextSave:false,rejectNextRecovery:false,syncState:{version:1,actorId,identities:[],ledger:{version:1,entries:[]}}};
            const bytesToBase64=value=>{const bytes=new Uint8Array(value);let binary='';for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));return btoa(binary)};
            const base64ToArrayBuffer=value=>{const binary=atob(value);const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);return bytes.buffer};
            const sendOpen=async()=>{
              const response=await fetch('/tests/fixtures/tracemonkey.pdf');
              const data=await response.arrayBuffer();
              iframe.contentWindow.postMessage({channel,type:'open',token,rendererGeneration,documentId,documentPath:'tests/fixtures/tracemonkey.pdf',filename:'tracemonkey.pdf',autoSave:false,openRequest:1,syncState:state.syncState,data},'*',[data]);
            };
            window.addEventListener('message',event=>{
              if(event.source!==iframe.contentWindow)return;
              const message=event.data;
              if(!message||message.channel!==channel||message.token!==token)return;
              if(message.type==='ready'){
                state.ready=true;
                void sendOpen().catch(error=>state.errors.push(String(error?.message||error)));
              }else if(message.type==='opened'){
                state.opened.push({documentId:message.documentId,openRequest:message.openRequest,revision:message.revision,confirmedRevision:message.confirmedRevision,dirty:message.dirty,rendererGeneration:message.rendererGeneration,startupTimings:message.startupTimings,syncState:message.syncState});
              }else if(message.type==='startup-timings'){
                state.startupTimings.push({documentId:message.documentId,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,timings:message.timings});
              }else if(message.type==='save'){
                const save={documentId:message.documentId,requestId:message.requestId,revision:message.revision,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,operations:message.operations,newAnnotations:message.newAnnotations,actorId:message.actorId,byteLength:message.data?.byteLength||0};
                state.saves.push(save);
                if(state.rejectNextSave){
                  state.rejectNextSave=false;
                  const failed={channel,type:'error',token,documentId:message.documentId,requestId:message.requestId,revision:message.revision,message:'legacy save error'};
                  iframe.contentWindow.postMessage({...failed,rendererGeneration:'stale-generation',message:'stale-generation save error'},'*');
                  setTimeout(()=>iframe.contentWindow.postMessage(failed,'*'),50);
                  return;
                }
                void fetch('/prepare-local',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({checkpointBytes:state.preparedLocal?.bytesBase64||null,draftBytes:bytesToBase64(message.data),operations:message.operations,newAnnotations:message.newAnnotations,actorId:message.actorId})})
                  .then(async response=>{const body=await response.json();if(!response.ok)throw new Error('prepareLocal returned HTTP '+response.status+' ('+(body.code||'unknown-code')+'): '+(body.error||'unknown merge error'));return body})
                  .then(prepared=>{
                    state.preparedLocal=prepared;
                    state.prepareCount++;
                    state.syncState={version:1,actorId:message.actorId||actorId,identities:prepared.identities,ledger:prepared.ledger};
                    const saved={channel,type:'saved',token,rendererGeneration:message.rendererGeneration,documentId:message.documentId,requestId:message.requestId,revision:message.revision,openRequest:message.openRequest,syncState:state.syncState};
                    if(state.saves.length===1){
                      iframe.contentWindow.postMessage({...saved,rendererGeneration:'stale-generation',syncState:{...state.syncState,actorId:'stale-generation-actor'}},'*');
                      setTimeout(()=>{delete saved.rendererGeneration;iframe.contentWindow.postMessage(saved,'*');},50);
                    }else{
                      iframe.contentWindow.postMessage(saved,'*');
                    }
                  })
                  .catch(error=>state.errors.push(String(error?.message||error)));
              }else if(message.type==='recover'){
                state.recoveries.push({documentId:message.documentId,requestId:message.requestId,revision:message.revision,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,operations:message.operations,newAnnotations:message.newAnnotations,actorId:message.actorId,byteLength:message.data?.byteLength||0});
                if(state.rejectNextRecovery){
                  state.rejectNextRecovery=false;
                  const failed={channel,type:'recovery-error',token,documentId:message.documentId,requestId:message.requestId,revision:message.revision,message:'legacy recovery error'};
                  iframe.contentWindow.postMessage({...failed,rendererGeneration:'stale-generation',message:'stale-generation recovery error'},'*');
                  setTimeout(()=>iframe.contentWindow.postMessage(failed,'*'),50);
                  return;
                }
                const recovered={channel,type:'recovered',token,rendererGeneration:message.rendererGeneration,documentId:message.documentId,requestId:message.requestId,revision:message.revision,openRequest:message.openRequest};
                iframe.contentWindow.postMessage({...recovered,rendererGeneration:'stale-generation',revision:message.revision+1},'*');
                setTimeout(()=>{delete recovered.rendererGeneration;iframe.contentWindow.postMessage(recovered,'*');},50);
              }else if(message.type==='flushed'){
                state.flushes.push({id:message.id,documentId:message.documentId,revision:message.revision,ok:message.ok,dirty:message.dirty,recovered:message.recovered===true});
              }else if(message.type==='sync-checkpoint-ready'){
                state.checkpoints.push({id:message.id,documentId:message.documentId,openRequest:message.openRequest,revision:message.revision,confirmedRevision:message.confirmedRevision,dirty:message.dirty,ok:message.ok,byteLength:message.data?.byteLength||0,operations:message.operations,newAnnotations:message.newAnnotations,actorId:message.actorId,viewState:message.viewState,data:message.data});
              }else if(message.type==='sync-checkpoint-rejected'){
                state.rejected.push(message);
              }else if(message.type==='sync-apply-prepared'||message.type==='sync-apply-rejected'){
                state.prepared.push(message);
              }else if(message.type==='sync-applied'){
                state.applied.push(message);
              }else if(message.type==='sync-apply-cancelled'){
                state.cancelled.push(message);
              }else if(message.type==='error'){
                state.errors.push(message.message||message.code||'bridge-error');
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
        response.end(bridgeSource);
        return;
      }
      if (url.pathname === "/tests/fixtures/tracemonkey.pdf") {
        target = fixturePath;
      } else if (url.pathname === "/prepare-local" && request.method === "POST") {
        let input = null;
        let draftPdfBytes = null;
        let checkpointPdfBytes = null;
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          draftPdfBytes = Buffer.from(input.draftBytes, "base64");
          checkpointPdfBytes = input.checkpointBytes
            ? Buffer.from(input.checkpointBytes, "base64")
            : null;
          const prepared = await prepareLocal({
            baseBytes: loadedBaseBytes,
            draftBytes: draftPdfBytes,
            checkpointBytes: checkpointPdfBytes || undefined,
            operations: input.operations,
            newAnnotations: input.newAnnotations,
            actorId: input.actorId,
          });
          response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({
            bytesBase64: Buffer.from(prepared.bytes).toString("base64"),
            stateDigest: prepared.stateDigest,
            ledger: prepared.ledger,
            identities: prepared.identities,
          }));
        } catch (error) {
          const diagnostic = {
            attempt: prepareFailures.length + 1,
            code: error?.code || null,
            error: String(error?.message || error),
            actorId: input?.actorId || null,
            operations: input?.operations || null,
            newAnnotations: input?.newAnnotations || null,
            draftBytes: draftPdfBytes ? {
              byteLength: draftPdfBytes.length,
              sha256: createHash("sha256").update(draftPdfBytes).digest("hex"),
            } : null,
            checkpointBytes: checkpointPdfBytes ? {
              byteLength: checkpointPdfBytes.length,
              sha256: createHash("sha256").update(checkpointPdfBytes).digest("hex"),
            } : null,
          };
          const diagnosticPrefix = path.join(artifactsPath, `sync-bridge-prepare-failure-${runId}-${diagnostic.attempt}`);
          try {
            await mkdir(artifactsPath, { recursive: true });
            if (draftPdfBytes) {
              diagnostic.draftBytes.path = `${diagnosticPrefix}-draft.pdf`;
              await writeFile(diagnostic.draftBytes.path, draftPdfBytes);
            }
            if (checkpointPdfBytes) {
              diagnostic.checkpointBytes.path = `${diagnosticPrefix}-checkpoint.pdf`;
              await writeFile(diagnostic.checkpointBytes.path, checkpointPdfBytes);
            }
          } catch (writeError) {
            diagnostic.evidenceWriteError = String(writeError?.message || writeError);
          }
          prepareFailures.push(diagnostic);
          response.writeHead(422, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: diagnostic.error, code: diagnostic.code }));
        }
        return;
      } else if (url.pathname.startsWith("/build/")) {
        const relative = decodeURIComponent(url.pathname.slice(1));
        target = path.resolve(root, "vendor", "pdfjs-generic-legacy", relative);
        const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
        if (!target.startsWith(`${vendorRoot}${path.sep}`)) {
          response.writeHead(403).end("forbidden");
          return;
        }
      } else if (url.pathname.startsWith("/viewer/")) {
        const relative = decodeURIComponent(url.pathname.slice("/viewer/".length));
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
      await page.waitForFunction(() => window.__syncHost?.opened.length === 1, {
        timeout: 30_000,
      });
      await viewer.waitForFunction(() => {
        const app = window.PDFViewerApplication;
        const pageView = app?.pdfViewer?.getPageView(0);
        const host = window.parent.__syncHost;
        const opened = host?.opened?.[0];
        const reported = Object.assign(
          {},
          opened?.startupTimings || {},
          ...((host?.startupTimings || [])
            .filter((entry) => entry.documentId === opened?.documentId &&
              entry.openRequest === opened?.openRequest &&
              entry.rendererGeneration === opened?.rendererGeneration)
            .map((entry) => entry.timings || {})),
        );
        const toolButtons = [
          "editorUnderlineButton",
          "editorSquareButton",
          "editorHighlightButton",
          "editorInkButton",
          "editorFreeTextButton",
        ].map((id) => document.getElementById(id));
        return Boolean(
          app?.pdfDocument &&
          app?.pdfViewer?.pdfDocument === app.pdfDocument &&
          pageView?.pdfPage &&
          pageView?.annotationEditorLayer?.div?.isConnected &&
          app.pdfViewer?._layerProperties?.annotationEditorUIManager &&
          toolButtons.every((button) => button && !button.disabled) &&
          Number.isFinite(reported.firstPageAnnotationLayerMs) &&
          ["annotationLayer", "annotationEditorLayer"].includes(
            reported.firstPageAnnotationLayerKind,
          ) &&
          Number.isFinite(reported.toolsUsableMs),
        );
      }, { timeout: 30_000 });

      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          mode: 5,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      const pageRect = await viewer.$eval(
        '.page[data-page-number="1"]',
        (element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        },
      );
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

      const requestCheckpoint = async (id) => {
        await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id: requestId }) => {
          document.querySelector("iframe").contentWindow.postMessage({
            channel: messageChannel,
            type: "sync-checkpoint",
            token: sessionToken,
            rendererGeneration: generation,
            id: requestId,
            documentId: currentDocumentId,
            openRequest: 1,
          }, "*");
        }, { channel, token, rendererGeneration, documentId, id });
        await page.waitForFunction((requestId) =>
          window.__syncHost?.checkpoints.some((entry) => entry.id === requestId) ||
          window.__syncHost?.rejected.some((entry) => entry.id === requestId),
        { timeout: 30_000 }, id);
        const result = await page.evaluate((requestId) => {
          const host = window.__syncHost;
          return {
            checkpoint: host.checkpoints.find((entry) => entry.id === requestId),
            rejected: host.rejected.find((entry) => entry.id === requestId) || null,
            saves: host.saves.length,
          };
        }, id);
        assert.equal(result.rejected, null, `Checkpoint ${id} should succeed`);
        assert.ok(result.checkpoint?.byteLength > 0, "A checkpoint should return a PDF ArrayBuffer");
        return result;
      };
      const saveAndWaitForPreparation = async (saveCount) => {
        await viewer.evaluate(async () => PDFViewerApplication.save());
        await page.waitForFunction((expected) =>
          window.__syncHost?.saves.length >= expected,
        { timeout: 30_000 }, saveCount);
        await page.waitForFunction((expected) =>
          window.__syncHost?.prepareCount >= expected ||
          window.__syncHost?.errors.length,
        { timeout: 30_000 }, saveCount);
        assert.deepEqual(await page.evaluate(() => window.__syncHost.errors), []);
        const host = await page.evaluate(() => window.__syncHost);
        assert.ok(host.preparedLocal?.bytesBase64, "The real merge core should return prepared PDF bytes");
        return host;
      };

      const first = await requestCheckpoint("checkpoint-first");
      assert.equal(first.saves, 0, "A sync checkpoint must not persist a Vault save");
      assert.equal(first.checkpoint.ok, true);
      assert.ok(first.checkpoint.dirty, "Checkpoint should describe the pending local edit");
      assert.ok(first.checkpoint.operations.length > 0, "An annotation edit should produce an operation");
      const firstOperation = first.checkpoint.operations.at(-1);
      assert.equal(firstOperation.action, "upsert");
      assert.equal(firstOperation.kind, "Square");
      assert.equal(typeof firstOperation.uuid, "string");
      assert.ok(Number.isSafeInteger(firstOperation.timestamp) && firstOperation.timestamp >= 0);
      assert.ok(Number.isSafeInteger(firstOperation.logical));
      assert.ok(first.checkpoint.newAnnotations.length > 0);
      const runtimeId = first.checkpoint.newAnnotations[0].runtimeId;
      const uuid = first.checkpoint.newAnnotations[0].uuid;

      await viewer.evaluate((editorRuntimeId) => {
        const app = PDFViewerApplication;
        const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor = manager?.getEditor(editorRuntimeId);
        if (!editor) throw new Error("The new Square editor should remain addressable by runtime id.");
        manager.setSelected(editor);
        app.eventBus.dispatch("switchannotationeditorparams", {
          source: window,
          type: 62,
          value: 4,
        });
      }, runtimeId);
      const styled = await requestCheckpoint("checkpoint-square-style");
      const styledOperation = styled.checkpoint.operations.find(
        (operation) => operation.uuid === uuid,
      );
      assert.equal(styledOperation?.action, "upsert");
      assert.equal(styledOperation?.serialized?.thickness, 4,
        "A Square style edit should update its UUID operation from AnnotationStorage");

      const firstSaveHost = await saveAndWaitForPreparation(1);
      const saved = firstSaveHost.saves[0];
      assert.equal(saved.rendererGeneration, rendererGeneration);
      assert.ok(saved.requestId.includes(rendererGeneration),
        "A save request ID must be scoped to its renderer generation");
      assert.ok(saved.byteLength > 0);
      const preparedLocal = firstSaveHost.preparedLocal;
      assert.ok(preparedLocal?.bytesBase64, "The real merge core should return prepared PDF bytes");
      assert.ok(preparedLocal.stateDigest);
      assert.ok(preparedLocal.identities.some((identity) =>
        identity.uuid === uuid && identity.runtimeId === runtimeId && /^\d+R(?:\d+)?$/.test(identity.ref),
      ), "The real merge core should bind the runtime editor to its output PDF ref");
      assert.ok(saved.operations.some((operation) => operation.uuid === uuid));
      assert.equal(saved.operations.find((operation) => operation.uuid === uuid)
        ?.serialized?.thickness, 4);
      assert.ok(saved.newAnnotations.some((annotation) =>
        annotation.runtimeId === runtimeId && annotation.uuid === uuid,
      ), "A saved id-null editor must remain represented until merged reload");

      const second = await requestCheckpoint("checkpoint-after-save");
      assert.equal(second.checkpoint.actorId, actorId,
        "The stale-generation save ACK must not replace the active sync actor");
      const retainedOperation = second.checkpoint.operations.find(
        (operation) => operation.uuid === uuid,
      );
      assert.ok(retainedOperation, "The UUID operation must survive a successful save acknowledgment");
      assert.equal(retainedOperation.ref, null, "An id-null editor remains a new annotation against the loaded base");
      assert.ok(second.checkpoint.newAnnotations.some((annotation) =>
        annotation.runtimeId === runtimeId && annotation.uuid === uuid,
      ));

      const checkpointIdentity = preparedLocal.identities.find((identity) =>
        identity.uuid === uuid,
      );
      assert.ok(checkpointIdentity?.ref, "The checkpoint should retain the saved UUID-to-ref mapping");
      await viewer.evaluate((editorRuntimeId) => {
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        const editor = manager?.getEditor(editorRuntimeId);
        if (!editor) throw new Error("The saved Square editor should remain in the session.");
        manager.deleteEditor(editor);
      }, runtimeId);
      const deletedBeforeSave = await requestCheckpoint("checkpoint-delete-before-save");
      const deleteOperation = deletedBeforeSave.checkpoint.operations.find(
        (operation) => operation.uuid === uuid,
      );
      assert.equal(deleteOperation?.action, "delete");
      assert.equal(deleteOperation?.ref, checkpointIdentity.ref,
        "A saved id:null editor deletion must use its checkpoint ref");
      assert.equal(deletedBeforeSave.checkpoint.newAnnotations.some(
        (annotation) => annotation.uuid === uuid,
      ), false, "A deleted editor must leave the new-annotation assignment list");

      await viewer.evaluate(() => {
        PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager.undo();
      });
      const undoneBeforeSave = await requestCheckpoint("checkpoint-undo-before-save");
      const undoOperation = undoneBeforeSave.checkpoint.operations.find(
        (operation) => operation.uuid === uuid,
      );
      assert.equal(undoOperation?.action, "upsert");
      assert.equal(undoOperation?.ref, null,
        "Undo restoring a current id:null editor must bind it from fresh draft bytes");
      assert.ok(undoneBeforeSave.checkpoint.newAnnotations.some(
        (annotation) => annotation.runtimeId === runtimeId && annotation.uuid === uuid,
      ));

      await viewer.evaluate(() => {
        PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager.redo();
      });
      const redoneBeforeSave = await requestCheckpoint("checkpoint-redo-before-save");
      const redoOperation = redoneBeforeSave.checkpoint.operations.find(
        (operation) => operation.uuid === uuid,
      );
      assert.equal(redoOperation?.action, "delete");
      assert.equal(redoOperation?.ref, checkpointIdentity.ref);
      assert.equal(redoneBeforeSave.checkpoint.newAnnotations.some(
        (annotation) => annotation.uuid === uuid,
      ), false);

      const secondSaveHost = await saveAndWaitForPreparation(2);
      const savedTombstone = secondSaveHost.preparedLocal.ledger.entries.find(
        (entry) => entry.uuid === uuid,
      );
      assert.equal(savedTombstone?.deleted, true,
        "The actual merge core should persist the saved new-editor tombstone");

      await viewer.evaluate(() => {
        PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager.undo();
      });
      const revivedCheckpoint = await requestCheckpoint("checkpoint-undo-after-save");
      const revivedOperation = revivedCheckpoint.checkpoint.operations.find(
        (operation) => operation.uuid === uuid,
      );
      assert.equal(revivedOperation?.action, "upsert");
      assert.equal(revivedOperation?.ref, null);
      assert.ok(revivedCheckpoint.checkpoint.newAnnotations.some(
        (annotation) => annotation.runtimeId === runtimeId && annotation.uuid === uuid,
      ));
      const thirdSaveHost = await saveAndWaitForPreparation(3);
      const revivedIdentity = thirdSaveHost.preparedLocal.identities.find(
        (identity) => identity.uuid === uuid,
      );
      assert.ok(revivedIdentity?.ref && !revivedIdentity.deleted,
        "The actual merge core should revive the UUID after undoing its saved tombstone");

      const staleId = "sync-prepare-stale";
      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id, expectedRevision }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-apply-prepare",
          token: sessionToken,
          rendererGeneration: generation,
          id,
          documentId: currentDocumentId,
          openRequest: 1,
          expectedRevision,
        }, "*");
      }, { channel, token, rendererGeneration, documentId, id: staleId, expectedRevision: revivedCheckpoint.checkpoint.revision + 1 });
      await page.waitForFunction((id) => window.__syncHost?.prepared.some((entry) => entry.id === id), {
        timeout: 10_000,
      }, staleId);
      const stale = await page.evaluate((id) => window.__syncHost.prepared.find((entry) => entry.id === id), staleId);
      assert.equal(stale.type, "sync-apply-rejected");
      assert.equal(stale.ok, false);

      await viewer.evaluate(() => {
        window.__syncApplySentinel = "same-renderer";
        window.__syncBeforeDocument = PDFViewerApplication.pdfDocument;
      });
      const prepareId = "sync-prepare-valid";
      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id, expectedRevision }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-apply-prepare",
          token: sessionToken,
          rendererGeneration: generation,
          id,
          documentId: currentDocumentId,
          openRequest: 1,
          expectedRevision,
        }, "*");
      }, { channel, token, rendererGeneration, documentId, id: prepareId, expectedRevision: revivedCheckpoint.checkpoint.revision });
      await page.waitForFunction((id) => window.__syncHost?.prepared.some((entry) => entry.id === id && entry.type === "sync-apply-prepared"), {
        timeout: 30_000,
      }, prepareId);
      const prepared = await page.evaluate((id) => window.__syncHost.prepared.find((entry) => entry.id === id), prepareId);
      assert.equal(prepared.ok, true);
      assert.equal(prepared.prepared, true);

      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id, expectedRevision, checkpointId }) => {
        const host = window.__syncHost;
        const checkpoint = host.checkpoints.find((entry) => entry.id === checkpointId);
        const data = base64ToArrayBuffer(host.preparedLocal.bytesBase64);
        const syncState = host.syncState;
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-apply",
          token: sessionToken,
          rendererGeneration: generation,
          id,
          documentId: currentDocumentId,
          previousOpenRequest: 1,
          newOpenRequest: 2,
          expectedRevision,
          data,
          syncState,
          viewState: checkpoint.viewState,
        }, "*", [data]);
      }, { channel, token, rendererGeneration, documentId, id: prepareId, expectedRevision: revivedCheckpoint.checkpoint.revision, checkpointId: "checkpoint-undo-after-save" });
      await page.waitForFunction(() => window.__syncHost?.applied.length === 1, {
        timeout: 30_000,
      });
      const applied = await page.evaluate(() => window.__syncHost.applied[0]);
      assert.equal(applied.ok, true);
      assert.equal(applied.previousOpenRequest, 1);
      assert.equal(applied.newOpenRequest, 2);
      assert.equal(await viewer.evaluate(() => window.__syncApplySentinel), "same-renderer");
      assert.notEqual(
        await viewer.evaluate(() => PDFViewerApplication.pdfDocument === window.__syncBeforeDocument),
        true,
        "Apply should reopen PDF.js in the current iframe without replacing its renderer",
      );
      assert.equal(await page.evaluate(() => window.__syncHost.opened.length), 1,
        "An in-place sync apply should not announce a second host open");
      assert.equal(applied.revision, 0, "An applied snapshot starts a fresh renderer revision");
      assert.equal(
        await viewer.evaluate(() => PDFViewerApplication.pdfViewer.currentPageNumber),
        applied.viewState.pageNumber,
      );
      const expectedRect = revivedOperation.serialized?.rect;
      assert.ok(Array.isArray(expectedRect) && expectedRect.length === 4,
        "The revived Square operation should retain its serialized geometry");
      await viewer.waitForFunction(async ({ annotationRef, rect }) => {
        const app = PDFViewerApplication;
        const pdfPage = await app.pdfDocument.getPage(1);
        const annotations = await pdfPage.getAnnotations({ intent: "display" });
        const square = annotations.find((annotation) =>
          annotation.annotationType === 5 && annotation.id === annotationRef,
        );
        if (!square || !Array.isArray(square.rect) || square.rect.length !== 4) {
          return false;
        }
        const geometryMatches = square.rect.every((value, index) =>
          Number.isFinite(value) && Math.abs(value - rect[index]) <= 1,
        );
        const pageView = app.pdfViewer.getPageView(0);
        const element = [...(pageView?.div?.querySelectorAll?.(".squareAnnotation") || [])]
          .find((candidate) => candidate.dataset.annotationId === annotationRef);
        const annotationBounds = element?.getBoundingClientRect();
        const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor = [...manager.getEditors(0)].find((candidate) =>
          candidate.annotationElementId === annotationRef,
        );
        const editorBounds = editor?.div?.getBoundingClientRect();
        const editorStyle = editor?.div ? getComputedStyle(editor.div) : null;
        const editorOverlayVisible = Boolean(
          editor?.div?.isConnected &&
          editorBounds?.width > 0 &&
          editorBounds?.height > 0 &&
          editorStyle?.display !== "none" &&
          editorStyle?.visibility !== "hidden",
        );
        const annotationElementVisible = Boolean(
          element?.isConnected &&
          annotationBounds?.width > 0 &&
          annotationBounds?.height > 0,
        );
        return Boolean(
          geometryMatches &&
          square.borderStyle?.width === 4 &&
          editor?.mode === 5 &&
          editor?.editorType === "square" &&
          editorOverlayVisible
        );
      }, { timeout: 30_000 }, { annotationRef: revivedIdentity.ref, rect: expectedRect });
      const persistedSquare = await viewer.evaluate(async ({ annotationRef }) => {
        const app = PDFViewerApplication;
        const pdfPage = await app.pdfDocument.getPage(1);
        const annotations = await pdfPage.getAnnotations({ intent: "display" });
        const annotation = annotations.find((entry) =>
          entry.annotationType === 5 && entry.id === annotationRef,
        );
        const pageView = app.pdfViewer.getPageView(0);
        const rectSnapshot = (node) => {
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const annotationElement = [...(pageView?.div?.querySelectorAll?.(".squareAnnotation") || [])]
          .find((candidate) => candidate.dataset.annotationId === annotationRef);
        const annotationElementBounds = annotationElement?.getBoundingClientRect();
        const annotationElementStyle = annotationElement
          ? getComputedStyle(annotationElement)
          : null;
        const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor = [...manager.getEditors(0)].find((candidate) =>
          candidate.annotationElementId === annotationRef,
        );
        const editorBounds = editor?.div?.getBoundingClientRect();
        const editorStyle = editor?.div ? getComputedStyle(editor.div) : null;
        const editorOverlayVisible = Boolean(
          editor?.div?.isConnected &&
          editorBounds?.width > 0 &&
          editorBounds?.height > 0 &&
          editorStyle?.display !== "none" &&
          editorStyle?.visibility !== "hidden",
        );
        const annotationElementVisible = Boolean(
          annotationElement?.isConnected &&
          annotationElementBounds?.width > 0 &&
          annotationElementBounds?.height > 0,
        );
        const annotationLayer = pageView?.annotationLayer?.div;
        return {
          id: annotation?.id,
          annotationType: annotation?.annotationType,
          rect: annotation?.rect,
          borderWidth: annotation?.borderStyle?.width,
          layerConnected: Boolean(annotationLayer?.isConnected),
          pageViewBounds: rectSnapshot(pageView?.div),
          viewerContainerBounds: rectSnapshot(document.getElementById("viewerContainer")),
          annotationLayerBounds: rectSnapshot(annotationLayer),
          pdfViewport: pageView?.viewport && {
            width: pageView.viewport.width,
            height: pageView.viewport.height,
            scale: pageView.viewport.scale,
          },
          editor: editor && {
            annotationElementId: editor.annotationElementId,
            editorType: editor.editorType,
            mode: editor.mode,
            pageIndex: editor.pageIndex,
            pdfRect: editor.getPDFRect?.(),
            connected: Boolean(editor.div?.isConnected),
            className: editor.div?.className,
            bounds: rectSnapshot(editor.div),
            display: editorStyle?.display,
            visibility: editorStyle?.visibility,
          },
          annotationElement: annotationElement && {
            visible: annotationElementVisible,
            connected: annotationElement.isConnected,
            hidden: annotationElement.hidden,
            className: annotationElement.className,
            bounds: rectSnapshot(annotationElement),
            display: annotationElementStyle?.display,
            visibility: annotationElementStyle?.visibility,
          },
          visibleSquareNodes: [...(pageView?.div?.querySelectorAll?.(".squareAnnotation") || [])]
            .map((candidate) => ({
              id: candidate.dataset.annotationId,
              connected: candidate.isConnected,
              bounds: rectSnapshot(candidate),
            })),
          annotationElementVisible,
          editorOverlayVisible,
          rendered: editorOverlayVisible || annotationElementVisible,
        };
      }, { annotationRef: revivedIdentity.ref });
      assert.equal(persistedSquare.id, revivedIdentity.ref,
        "The reopened PDF should contain the Square with its core-assigned ref");
      assert.equal(persistedSquare.annotationType, 5);
      assert.equal(persistedSquare.borderWidth, 4,
        "The reopened PDF annotation should preserve the saved Square thickness");
      assert.equal(persistedSquare.editor?.annotationElementId, revivedIdentity.ref,
        "The current Square editor model should bind to the saved PDF annotation ref");
      assert.equal(persistedSquare.editor?.editorType, "square");
      assert.ok(persistedSquare.editor?.pdfRect?.every((value, index) =>
        Number.isFinite(value) && Math.abs(value - expectedRect[index]) <= 3,
      ), "The editable model should retain the saved Square geometry within PDF.js's 3pt outline import margin");
      assert.ok(persistedSquare.editorOverlayVisible,
        `The reopened Square should be represented by a visible, connected editor overlay: ${JSON.stringify(persistedSquare)}`);
      assert.ok(persistedSquare.rect.every((value, index) =>
        Number.isFinite(value) && Math.abs(value - expectedRect[index]) <= 1,
      ), "The reopened PDF should preserve the Square's saved geometry");

      await viewer.evaluate((annotationRef) => {
        const app = PDFViewerApplication;
        const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor = [...manager.getEditors(0)].find((candidate) =>
          candidate.annotationElementId === annotationRef,
        );
        if (!editor) throw new Error("The applied Square editor should remain addressable by PDF ref.");
        manager.setSelected(editor);
        app.eventBus.dispatch("switchannotationeditorparams", {
          source: window,
          type: 62,
          value: 5,
        });
      }, revivedIdentity.ref);
      await viewer.waitForFunction((annotationRef) => {
        const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
        const editor = [...manager.getEditors(0)].find((candidate) =>
          candidate.annotationElementId === annotationRef,
        );
        return editor?.serialize()?.thickness === 5;
      }, { timeout: 15_000 }, revivedIdentity.ref);
      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-checkpoint",
          token: sessionToken,
          rendererGeneration: generation,
          id: "checkpoint-post-apply-edit",
          documentId: currentDocumentId,
          openRequest: 2,
        }, "*");
      }, { channel, token, rendererGeneration, documentId });
      await page.waitForFunction(() => window.__syncHost?.checkpoints.some(
        (entry) => entry.id === "checkpoint-post-apply-edit",
      ), { timeout: 15_000 });
      const postApplyCheckpoint = await page.evaluate(() => window.__syncHost.checkpoints.find(
        (entry) => entry.id === "checkpoint-post-apply-edit",
      ));
      assert.equal(postApplyCheckpoint.ok, true);
      assert.equal(postApplyCheckpoint.dirty, true,
        "Editing the applied Square should produce a dirty current revision");
      assert.ok(postApplyCheckpoint.operations.some((operation) =>
        operation.uuid === uuid && operation.action === "upsert" &&
        operation.serialized?.thickness === 5,
      ), "The edited Square should remain associated with its UUID operation");

      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "flush",
          token: sessionToken,
          rendererGeneration: generation,
          id: "flush-legacy-recovery-ack",
          documentId: currentDocumentId,
          openRequest: 2,
        }, "*");
      }, { channel, token, rendererGeneration, documentId });
      await page.waitForFunction(() =>
        window.__syncHost?.recoveries.length === 1 &&
        window.__syncHost?.flushes.some((entry) =>
          entry.id === "flush-legacy-recovery-ack",
        ), { timeout: 30_000 });
      const recoveryResult = await page.evaluate(() => ({
        recovery: window.__syncHost.recoveries[0],
        flushed: window.__syncHost.flushes.find((entry) =>
          entry.id === "flush-legacy-recovery-ack",
        ),
      }));
      assert.equal(recoveryResult.recovery.documentId, documentId);
      assert.equal(recoveryResult.recovery.openRequest, 2);
      assert.equal(recoveryResult.recovery.rendererGeneration, rendererGeneration);
      assert.ok(recoveryResult.recovery.requestId.includes(rendererGeneration),
        "A recovery request ID must be scoped to its renderer generation");
      assert.ok(recoveryResult.recovery.requestId);
      assert.equal(recoveryResult.flushed.recovered, true,
        "A matching legacy recovered ACK should complete after an explicit wrong-generation ACK is ignored");
      assert.equal(recoveryResult.flushed.dirty, true);

      await page.evaluate(() => { window.__syncHost.rejectNextSave = true; });
      await viewer.evaluate(async () => { await PDFViewerApplication.save(); });
      await viewer.waitForFunction(() =>
        document.getElementById("pdfReaderBridgeStatus")?.textContent === "legacy save error",
      { timeout: 15_000 });
      const legacyFailedSave = await page.evaluate(() => window.__syncHost.saves.at(-1));
      assert.ok(legacyFailedSave.requestId.includes(rendererGeneration));

      await page.evaluate(() => { window.__syncHost.rejectNextRecovery = true; });
      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "flush",
          token: sessionToken,
          rendererGeneration: generation,
          id: "flush-legacy-recovery-error",
          documentId: currentDocumentId,
          openRequest: 2,
        }, "*");
      }, { channel, token, rendererGeneration, documentId });
      await page.waitForFunction(() =>
        window.__syncHost?.recoveries.length === 2 &&
        window.__syncHost?.flushes.some((entry) =>
          entry.id === "flush-legacy-recovery-error",
        ), { timeout: 30_000 });
      const failedRecoveryResult = await page.evaluate(() => ({
        recovery: window.__syncHost.recoveries.at(-1),
        flushed: window.__syncHost.flushes.find((entry) =>
          entry.id === "flush-legacy-recovery-error",
        ),
        status: document.querySelector("iframe").contentDocument
          .getElementById("pdfReaderBridgeStatus")?.textContent,
      }));
      assert.ok(failedRecoveryResult.recovery.requestId.includes(rendererGeneration));
      assert.equal(failedRecoveryResult.flushed.recovered, false);
      assert.equal(failedRecoveryResult.flushed.ok, false);
      assert.equal(failedRecoveryResult.flushed.dirty, true);
      assert.equal(failedRecoveryResult.status, "legacy recovery error",
        "A matching legacy recovery-error ACK should complete after a wrong-generation error is ignored");

      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-checkpoint",
          token: sessionToken,
          rendererGeneration: generation,
          id: "checkpoint-before-apply-cancel",
          documentId: currentDocumentId,
          openRequest: 2,
        }, "*");
      }, { channel, token, rendererGeneration, documentId });
      await page.waitForFunction(() => window.__syncHost?.checkpoints.some(
        (entry) => entry.id === "checkpoint-before-apply-cancel",
      ), { timeout: 15_000 });
      const cancelCheckpoint = await page.evaluate(() => window.__syncHost.checkpoints.find(
        (entry) => entry.id === "checkpoint-before-apply-cancel",
      ));
      assert.equal(cancelCheckpoint.ok, true);

      const cancelApplyId = "sync-apply-controlled-cancel";
      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id, expectedRevision }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-apply-prepare",
          token: sessionToken,
          rendererGeneration: generation,
          id,
          documentId: currentDocumentId,
          openRequest: 2,
          expectedRevision,
        }, "*");
      }, { channel, token, rendererGeneration, documentId, id: cancelApplyId, expectedRevision: cancelCheckpoint.revision });
      await page.waitForFunction((id) => window.__syncHost?.prepared.some(
        (entry) => entry.id === id && entry.type === "sync-apply-prepared",
      ), { timeout: 30_000 }, cancelApplyId);

      await viewer.evaluate(() => {
        const app = PDFViewerApplication;
        const originalClose = app.close;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        window.__syncApplyCloseGate = {
          release,
          started: 0,
          originalClose,
          loadingTask: app.pdfLoadingTask,
        };
        app.close = async function () {
          window.__syncApplyCloseGate.started += 1;
          await gate;
          throw new Error("controlled PDF.js close failure");
        };
      });
      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id, expectedRevision, checkpointId }) => {
        const host = window.__syncHost;
        const checkpoint = host.checkpoints.find((entry) => entry.id === checkpointId);
        const data = base64ToArrayBuffer(host.preparedLocal.bytesBase64);
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-apply",
          token: sessionToken,
          rendererGeneration: generation,
          id,
          documentId: currentDocumentId,
          previousOpenRequest: 2,
          newOpenRequest: 3,
          expectedRevision,
          data,
          syncState: host.syncState,
          viewState: checkpoint.viewState,
        }, "*", [data]);
      }, { channel, token, rendererGeneration, documentId, id: cancelApplyId, expectedRevision: cancelCheckpoint.revision, checkpointId: "checkpoint-before-apply-cancel" });
      await viewer.waitForFunction(() => window.__syncApplyCloseGate?.started >= 1, {
        timeout: 15_000,
      });
      await page.evaluate(({ channel: messageChannel, token: sessionToken, rendererGeneration: generation, documentId: currentDocumentId, id }) => {
        document.querySelector("iframe").contentWindow.postMessage({
          channel: messageChannel,
          type: "sync-apply-cancel",
          token: sessionToken,
          rendererGeneration: generation,
          id,
          documentId: currentDocumentId,
          openRequest: 2,
        }, "*");
      }, { channel, token, rendererGeneration, documentId, id: cancelApplyId });
      await viewer.waitForFunction(() => window.__syncApplyCloseGate?.started >= 2, {
        timeout: 15_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const beforeCloseSettled = await page.evaluate((id) => ({
        cancelled: window.__syncHost.cancelled.some((entry) => entry.id === id),
        rejected: window.__syncHost.prepared.some((entry) =>
          entry.id === id && entry.type === "sync-apply-rejected",
        ),
      }), cancelApplyId);
      assert.equal(beforeCloseSettled.cancelled, false,
        "The host must not receive a cancellation ACK while PDF.js cleanup is held");
      assert.equal(beforeCloseSettled.rejected, false,
        "An apply rejection must not race ahead of PDF.js cleanup");
      await viewer.evaluate(() => window.__syncApplyCloseGate.release());
      await page.waitForFunction((id) => window.__syncHost?.cancelled.some(
        (entry) => entry.id === id,
      ), { timeout: 30_000 }, cancelApplyId);
      const cancelResult = await page.evaluate((id) => ({
        cancelled: window.__syncHost.cancelled.find((entry) => entry.id === id),
        rejected: window.__syncHost.prepared.some((entry) =>
          entry.id === id && entry.type === "sync-apply-rejected",
        ),
        applied: window.__syncHost.applied.some((entry) => entry.id === id),
      }), cancelApplyId);
      assert.equal(cancelResult.cancelled.ok, true);
      assert.equal(cancelResult.cancelled.documentId, documentId);
      assert.equal(cancelResult.cancelled.openRequest, 2,
        "The cancellation ACK must identify the old open request");
      assert.equal(cancelResult.cancelled.cleanupFallback, true,
        "A failed app.close should use the explicit loading-task destroy fallback");
      assert.equal(cancelResult.rejected, false,
        "A canceled apply should not also report an early rejection");
      assert.equal(cancelResult.applied, false,
        "A canceled apply must not be reported as successful");
      const cancelledDocumentState = await viewer.evaluate(() => {
        const gate = window.__syncApplyCloseGate;
        PDFViewerApplication.close = gate.originalClose;
        return {
          hasLoadingTask: Boolean(PDFViewerApplication.pdfLoadingTask),
          hasPdfDocument: Boolean(PDFViewerApplication.pdfDocument),
          hasViewerDocument: Boolean(PDFViewerApplication.pdfViewer.pdfDocument),
          loadingTaskDestroyed: gate.loadingTask?.destroyed === true,
          readonly: document.documentElement.hasAttribute("data-pdf-reader-readonly"),
          status: document.getElementById("pdfReaderBridgeStatus")?.textContent || "",
        };
      });
      const { status, ...documentState } = cancelledDocumentState;
      assert.deepEqual(documentState, {
        hasLoadingTask: false,
        hasPdfDocument: false,
        hasViewerDocument: false,
        loadingTaskDestroyed: true,
        readonly: true,
      }, "The apply cancellation ACK must follow PDF.js document destruction");
      assert.match(status, /controlled PDF\.js close failure/);
      assert.deepEqual(await page.evaluate(() => window.__syncHost.errors), []);
      t.diagnostic(`Sync checkpoint/apply regression completed; rendererGeneration=${rendererGeneration}`);
    } catch (error) {
      primaryError = error;
      try {
        const hostState = page && !page.isClosed()
          ? await page.evaluate(() => {
              const host = window.__syncHost;
              return host && {
                opened: host.opened,
                startupTimings: host.startupTimings,
                saves: host.saves,
                recoveries: host.recoveries,
                checkpoints: host.checkpoints.map(({ data, ...entry }) => entry),
                prepared: host.prepared,
                applied: host.applied,
                rejected: host.rejected,
                errors: host.errors,
              };
            })
          : null;
        const viewerFrame = page?.frames().find((frame) =>
          frame.url().includes("/viewer/web/viewer.html"),
        );
        const viewerDiagnostics = viewerFrame
          ? await viewerFrame.evaluate(() => {
              const app = window.PDFViewerApplication;
              const pageView = app?.pdfViewer?.getPageView(0);
              const buttons = [
                "editorUnderlineButton",
                "editorSquareButton",
                "editorHighlightButton",
                "editorInkButton",
                "editorFreeTextButton",
              ].map((id) => {
                const button = document.getElementById(id);
                return {
                  id,
                  present: Boolean(button),
                  disabled: button?.disabled ?? null,
                };
              });
              return {
                hostOpenedDocumentId: window.parent.__syncHost?.opened?.at(-1)?.documentId || null,
                hostOpenedRequest: window.parent.__syncHost?.opened?.at(-1)?.openRequest ?? null,
                pdfDocumentMatchesViewer: Boolean(
                  app?.pdfDocument && app?.pdfViewer?.pdfDocument === app.pdfDocument,
                ),
                annotationLayerConnected: Boolean(pageView?.annotationLayer?.div?.isConnected),
                editorLayerConnected: Boolean(pageView?.annotationEditorLayer?.div?.isConnected),
                editorManagerPresent: Boolean(
                  app?.pdfViewer?._layerProperties?.annotationEditorUIManager,
                ),
                buttons,
              };
            }).catch((diagnosticError) => ({
              error: String(diagnosticError?.message || diagnosticError),
            }))
          : null;
        const artifact = path.join(artifactsPath, `sync-bridge-failure-${runId}.json`);
        await writeFile(artifact, `${JSON.stringify({
          error: error?.stack || String(error),
          rendererGeneration,
          hostState,
          prepareFailures,
          viewerDiagnostics,
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
