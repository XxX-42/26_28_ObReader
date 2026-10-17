import { isInlineToolbarIcon } from "./inline-toolbar-icons.mjs";
import { launchTestBrowser, getTestBrowserLaunchMetadata } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, rm, stat, writeFile, mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import {
  attachCleanupErrors,
  captureOwnedBrowserIdentity,
  cleanupBrowserTestResources,
  observeBrowserTestChildStderr,
  sampleOwnedBrowserProcess,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const browserPath = resolveBrowserPath();
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifactsPath = resolveTestArtifactRoot(root);
const channel = "pdf-web-reader";
const token = "free-text-undo-appearance-regression";
const documentId = "freetext-undo-appearance.pdf";
const pdfTeardownDiagnosticsEnabled = process.env.PDF_READER_PDF_TEARDOWN_DIAGNOSTICS === "1";
const teardownDiagnosticsEnabled = process.env.PDF_READER_CHROME_TEARDOWN_DIAGNOSTICS === "1";
const defaultChromeSampleDelayMs = 7_000;
const chromeSampleDelayMs = (() => {
  if (!teardownDiagnosticsEnabled) return defaultChromeSampleDelayMs;
  const value = process.env.PDF_READER_CHROME_SAMPLE_DELAY_MS;
  if (value === undefined) return defaultChromeSampleDelayMs;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new RangeError("PDF_READER_CHROME_SAMPLE_DELAY_MS must be an integer from 0 to 7000");
  }
  const delayMs = Number(value);
  if (!Number.isSafeInteger(delayMs) || delayMs > defaultChromeSampleDelayMs) {
    throw new RangeError("PDF_READER_CHROME_SAMPLE_DELAY_MS must be an integer from 0 to 7000");
  }
  return delayMs;
})();
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

function decodePngRgb(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Expected a PNG screenshot");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const imageData = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += length + 12;
  }
  assert.equal(bitDepth, 8, "Screenshot pixels must use eight-bit channels");
  assert.ok(colorType === 2 || colorType === 6, "Screenshot must contain RGB or RGBA pixels");
  assert.equal(interlace, 0, "Interlaced screenshot PNGs are not supported");
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(imageData));
  const rgb = Buffer.alloc(width * height * 3);
  let previous = Buffer.alloc(stride);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset++];
    const row = Buffer.from(inflated.subarray(inputOffset, inputOffset + stride));
    inputOffset += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const above = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const leftDistance = Math.abs(p - left);
        const aboveDistance = Math.abs(p - above);
        const upperLeftDistance = Math.abs(p - upperLeft);
        predictor = leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
          ? left
          : aboveDistance <= upperLeftDistance ? above : upperLeft;
      } else assert.equal(filter, 0, `Unsupported PNG row filter ${filter}`);
      row[x] = (row[x] + predictor) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const target = (y * width + x) * 3;
      const alpha = colorType === 6 ? row[source + 3] : 255;
      for (let channel = 0; channel < 3; channel += 1) {
        rgb[target + channel] = colorType === 6
          ? Math.round((row[source + channel] * alpha + 255 * (255 - alpha)) / 255)
          : row[source + channel];
      }
    }
    previous = row;
  }
  return { width, height, pixels: rgb };
}

async function prepareFixturePdfViewerClose(page, remainingMs) {
  return page.evaluate(async ({ closeBudgetMs, expectedToken, expectedDocumentId }) => {
    const hostState = window.__hostState;
    const iframe = document.querySelector('iframe[name="pdf-reader"]');
    let frameUrl = null;
    try {
      frameUrl = iframe ? new URL(iframe.src, location.href) : null;
    } catch {}
    const currentEntry = hostState?.opens?.at(-1);
    const ownedFixture = location.protocol === "http:" && location.hostname === "127.0.0.1" &&
      location.pathname === "/" && hostState?.teardownDiagnosticToken === expectedToken &&
      hostState?.documentId === expectedDocumentId && hostState.opened > 0 &&
      ["fixture", "saved-data"].includes(currentEntry?.label) && iframe?.name === "pdf-reader" &&
      frameUrl?.origin === location.origin &&
      frameUrl?.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html";
    if (!ownedFixture) {
      return {
        state: "failed",
        reason: "not-the-current-public-fixture-entry",
        loopbackEntry: location.protocol === "http:" && location.hostname === "127.0.0.1" && location.pathname === "/",
        hostMarkerMatches: hostState?.teardownDiagnosticToken === expectedToken,
        currentEntryLabel: currentEntry?.label || null,
        iframeName: iframe?.name || null,
        framePath: frameUrl?.pathname || null,
      };
    }
    const app = iframe?.contentWindow?.PDFViewerApplication;
    const task = app?.pdfLoadingTask;
    if (!app || !task) {
      return {
        state: "failed",
        reason: "no-active-document",
        closeBudgetMs,
        iframePresent: Boolean(iframe),
        appPresent: Boolean(app),
        taskPresent: Boolean(task),
      };
    }

    const result = {
      state: "started",
      closeBudgetMs,
      appCloseStartedAt: Date.now(),
      docId: task.docId ?? null,
      destroyedBefore: task.destroyed === true,
      workerPresentBefore: Boolean(task._worker),
      webWorkerPresentBefore: Boolean(task._worker?._webWorker),
      workerPortPresentBefore: Boolean(task._worker?.port),
      destroyEvents: [],
    };
    const originalDestroy = task.destroy;
    const wrappedDestroy = function (...args) {
      result.destroyEvents.push({ event: "loadingTask.destroy.start", at: Date.now() });
      let destroyPromise;
      try {
        destroyPromise = originalDestroy.apply(this, args);
      } catch (error) {
        result.destroyEvents.push({
          event: "loadingTask.destroy.throw",
          at: Date.now(),
          name: error?.name || "Error",
          message: String(error?.message || error).slice(0, 500),
        });
        throw error;
      }
      return Promise.resolve(destroyPromise).then(
        (value) => {
          result.destroyEvents.push({ event: "loadingTask.destroy.resolved", at: Date.now() });
          return value;
        },
        (error) => {
          result.destroyEvents.push({
            event: "loadingTask.destroy.rejected",
            at: Date.now(),
            name: error?.name || "Error",
            message: String(error?.message || error).slice(0, 500),
          });
          throw error;
        },
      );
    };

    try {
      task.destroy = wrappedDestroy;
      await app.close();
      result.appCloseSettledAt = Date.now();
      result.destroyedAfter = task.destroyed === true;
      result.appTaskCleared = app.pdfLoadingTask == null;
      result.transportCleared = task._transport == null;
      result.workerCleared = task._worker == null;
      result.destroyResolved = result.destroyEvents.some((event) => event.event === "loadingTask.destroy.resolved");
      const incompleteTeardown = [
        !result.destroyedAfter && "loadingTask-not-marked-destroyed",
        !result.appTaskCleared && "viewer-still-has-loading-task",
        !result.transportCleared && "loading-task-transport-still-present",
        !result.workerCleared && "loading-task-worker-still-present",
        !result.destroyResolved && "loading-task-destroy-did-not-resolve",
      ].filter(Boolean);
      result.state = incompleteTeardown.length === 0 ? "fulfilled" : "failed";
      if (incompleteTeardown.length) result.reason = incompleteTeardown;
      return result;
    } catch (error) {
      result.state = "failed";
      result.appCloseSettledAt = Date.now();
      result.error = {
        name: error?.name || "Error",
        message: String(error?.message || error).slice(0, 500),
      };
      return result;
    } finally {
      if (task.destroy === wrappedDestroy) task.destroy = originalDestroy;
    }
  }, {
    closeBudgetMs: remainingMs,
    expectedToken: token,
    expectedDocumentId: documentId,
  });
}

const safeTargetUrl = (value) => {
  if (!value || value === "about:blank") return value || null;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return `${url.origin}${url.pathname}`;
    }
    return `${url.protocol}//[redacted]`;
  } catch {
    return null;
  }
};

const snapshotBrowserTargets = (browser) => {
  try {
    return browser.targets().map((target) => ({
      type: target.type(),
      url: safeTargetUrl(target.url()),
    }));
  } catch (error) {
    return [{ error: error?.message || String(error) }];
  }
};

async function collectOwnedCrashpadMetadata(crashpadDirectory) {
  const files = [];
  const visit = async (directory, depth = 0) => {
    if (depth > 5 || files.length >= 16) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= 16) break;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile() && /\.(?:dmp|meta)$/i.test(entry.name)) {
        const info = await stat(target).catch(() => null);
        if (!info || info.size > 128 * 1024 * 1024) continue;
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(target)) digest.update(chunk);
        files.push({ path: path.relative(crashpadDirectory, target), bytes: info.size, sha256: digest.digest("hex") });
      }
    }
  };
  await visit(crashpadDirectory);
  return { files, rawDumpsCopied: false, contentsIncluded: false, retainedDirectory: crashpadDirectory };
}

test(
  "saved FreeText sidecar stays visible across NONE-mode right-eraser undo and redo",
  { skip: !browserPath && "Chrome or Edge is required for this browser regression", timeout: 120_000 },
  async (t) => {
    let markFreeTextTrace = async () => {};
    await mkdir(artifactsPath, { recursive: true });
    const viewerPath = path.join(root, "vendor", "pdfjs-generic-legacy", "web", "viewer.html");
    const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
    const viewerHtml = await readFile(viewerPath, "utf8");
    const bridgeSource = await readBridgeRuntimeSource(bridgePath);
    const fixtureSourceHash = `sha256:${createHash("sha256").update(await readFile(fixturePath)).digest("hex")}`;
    const bridgeCss = await readFile(
      path.join(root, "viewer-adapter", "bridge.css"),
      "utf8",
    );
    const viewerWithBridge = viewerHtml.replace(
      /<head\b[^>]*>/i,
      (head) =>
        head +
        '<script src="/vendor/pdfjs-generic-legacy/web/obsidian-bridge.js" data-channel="' +
        channel +
        '" data-token="' +
        token +
        '" data-renderer-generation="freetext-undo-renderer"></script>',
    ).replace(
      /<\/head>/i,
      '<style data-pdf-reader="bridge">' +
        bridgeCss.replace(/<\/style/gi, "<\\/style") +
        "</style></head>",
    );
    const mimeTypeFor = (target) =>
      mimeTypes.get(path.extname(target)) || "application/octet-stream";
    let browser;
    let browserStderrObserver;
    let browserIdentity;
    let diagnosticProfileDirectory;
    let diagnosticBrowserEvents = [];
    let diagnosticTargetsBeforeClose = null;
    let diagnosticTargetsAfterClose = null;
    let diagnosticSampleTimer = null;
    let diagnosticSamplePromise = null;
    let diagnosticSampleResult = null;
    let diagnosticChildExitListener = null;
    let onBrowserCloseStart;
    let page;
    let server;
    const errors = [];
    const consoleErrors = [];
    const externalRequests = [];
    const evidence = [];
    const artifactBase = `free-text-undo-appearance-${Date.now()}-${process.pid}-${randomUUID()}`;
    let primaryError;
    let cleanupReport;
    const persistEvidence = async () => {
      const frameState = page
        ? await page.evaluate(() => {
            const frame = document.querySelector("iframe");
            const viewer = frame?.contentWindow?.PDFViewerApplication;
            return {
              host: window.__hostState || null,
              viewer: viewer
                ? {
                    documentId: viewer.pdfDocument?.fingerprint || null,
                    pageCount: viewer.pdfDocument?.numPages || null,
                    mode: viewer.pdfViewer?.annotationEditorMode ?? null,
                    loaded: viewer.pdfViewer?.getPageView(0)?.div?.dataset.loaded || null,
                    layer: (() => {
                      const pageNode = frame.contentDocument?.querySelector(
                        '.page[data-page-number="1"]',
                      );
                      const annotationLayer = pageNode?.querySelector(".annotationLayer");
                      const editorLayer = pageNode?.querySelector(".annotationEditorLayer");
                      const sections = [...(annotationLayer?.querySelectorAll(".freeTextAnnotation") || [])];
                      return {
                        annotationLayer: annotationLayer
                          ? {
                              className: annotationLayer.className,
                              rect: (() => {
                                const rect = annotationLayer.getBoundingClientRect();
                                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                              })(),
                            }
                          : null,
                        editorLayer: editorLayer
                          ? {
                              hidden: editorLayer.hidden,
                              className: editorLayer.className,
                              editors: [...editorLayer.querySelectorAll(".freeTextEditor")].map((editor) => {
                                const rect = editor.getBoundingClientRect();
                                return {
                                  id: editor.id,
                                  text: editor.textContent,
                                  deleted: frame.contentWindow.PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(editor.id)?.deleted ?? null,
                                  rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                                };
                              }),
                            }
                          : null,
                        sections: sections.map((section) => {
                          const rect = section.getBoundingClientRect();
                          const content = section.querySelector(".annotationContent");
                          return {
                            id: section.id,
                            hidden: section.hidden,
                            display: getComputedStyle(section).display,
                            visibility: getComputedStyle(section).visibility,
                            text: section.textContent.trim(),
                            contentDisplay: content ? getComputedStyle(content).display : null,
                            contentText: content?.textContent?.trim() || null,
                            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                          };
                        }),
                      };
                    })(),
                    rawValues: [
                      ...(viewer.pdfDocument?.annotationStorage?.serializable?.map?.values() || []),
                    ].map((entry) => ({
                      id: entry.id,
                      annotationType: entry.annotationType,
                      deleted: entry.deleted,
                      contents: entry.contents,
                    })),
                    uiEditors: (() => {
                      const manager = viewer.pdfViewer?._layerProperties?.annotationEditorUIManager;
                      if (!manager) return [];
                      return [...manager.getEditors(0)].map((editor) => ({
                        id: editor.id,
                        uid: editor.uid,
                        annotationElementId: editor.annotationElementId,
                        deleted: editor.deleted,
                        editorType: editor.editorType,
                        serialized: editor.serialize?.() ?? null,
                      }));
                    })(),
                    trustedKeys: frame.contentWindow.__trustedKeys || [],
                    freeTextDiagnostic: frame.contentWindow.__freeTextCommitDiagnostic
                      ? {
                          trace: frame.contentWindow.__freeTextCommitDiagnostic.trace,
                          traceLimit: frame.contentWindow.__freeTextCommitDiagnostic.traceLimit,
                        }
                      : null,
                  }
                : null,
              errors: window.__hostState?.errors || [],
            };
          })
        : null;
      await writeFile(
        path.join(artifactsPath, artifactBase + ".partial.json"),
        JSON.stringify(
          {
            bridgeSha256: await import("node:crypto").then(async ({ createHash }) =>
              createHash("sha256").update(bridgeSource).digest("hex"),
            ),
            browserPath,
            evidence,
            frameState,
            errors,
            consoleErrors,
            externalRequests,
          },
          null,
          2,
        ),
        "utf8",
      );
    };

    server = createServer(async (request, response) => {
      for (const [name, value] of Object.entries(withTestNetworkFirewall())) {
        response.setHeader(name, value);
      }
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          '<!doctype html><meta charset="utf-8">' +
            '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>' +
            '<iframe name="pdf-reader" title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>' +
            '<script>' +
            'const channel=' +
            JSON.stringify(channel) +
            ',token=' +
            JSON.stringify(token) +
            ',documentId=' +
            JSON.stringify(documentId) +
            ',sourceHash=' +
            JSON.stringify(fixtureSourceHash) +
            ';' +
            'const iframe=document.querySelector("iframe");' +
            'const state=window.__hostState={teardownDiagnosticToken:' +
            JSON.stringify(token) +
            ',documentId:' +
            JSON.stringify(documentId) +
            ',ready:false,opened:0,openRequest:0,sourceIdentityConfirmed:false,identity:null,operations:new Map(),revision:0,saves:[],heldSaves:[],holdNextSaveAck:false,recoveries:[],exports:[],errors:[],opens:[]};' +
            'let fixtureBytes=null;' +
            'const sidecarSnapshot=(source=state.identity)=>({schemaVersion:2,kind:"pdf-annotation-snapshot",documentId,docKey:"freetext-undo-appearance",revision:state.revision,source:{sourcePath:documentId,sourceHash,...(source||{pageCount:0,orderedPageIdentities:[]})},legacyIdentities:[],annotations:[...state.operations.values()].filter(row=>row.deleted!==true),tombstones:[...state.operations.values()].filter(row=>row.deleted===true).map(({deleted,...row})=>row)});' +
            'const persistOperations=message=>{for(const operation of Array.isArray(message.operations)?message.operations:[]){if(!operation||typeof operation.uuid!=="string")continue;state.operations.set(operation.uuid,structuredClone(operation));}state.revision=Math.max(state.revision,Number(message.revision)||0);};' +
            'const ackFor=(type,message)=>({channel,type,token,documentId:message.documentId,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,requestId:message.requestId,revision:message.revision,ok:true,external:true,operationCount:Array.isArray(message.operations)?message.operations.length:0,batchId:message.operations?.length?"test-batch-"+message.requestId:null,externalAnnotations:sidecarSnapshot()});' +
            'const sendOpen=(data,label)=>{' +
            'state.openRequest+=1;state.opens.push({label,openRequest:state.openRequest,byteLength:data.byteLength});' +
            'iframe.contentWindow.postMessage({channel,type:"open",token,documentId,documentPath:documentId,filename:documentId,autoSave:true,rendererGeneration:"freetext-undo-renderer",openRequest:state.openRequest,data,externalAnnotations:sidecarSnapshot()},"*",[data]);};' +
            'window.__sendOpenSaved=()=>sendOpen(fixtureBytes.slice(0),"sidecar-reopen");' +
            'window.__holdNextSaveAck=()=>{state.holdNextSaveAck=true;};' +
            'window.__releaseHeldSaveAcks=()=>{for(const save of state.heldSaves.splice(0)){iframe.contentWindow.postMessage(save.ack,"*");}};' +
            'window.__sendFlush=(id)=>iframe.contentWindow.postMessage({channel,type:"flush",token,id},"*");' +
            'window.__requestExport=()=>{const requestId="export-"+(state.exports.length+1);iframe.contentWindow.postMessage({channel,type:"export-copy",token,documentId,openRequest:state.openRequest,requestId},"*");return requestId;};' +
            'window.addEventListener("message",event=>{' +
            'if(event.source!==iframe.contentWindow)return;const message=event.data;' +
            'if(!message||message.channel!==channel||message.token!==token)return;' +
            'if(message.type==="ready"){state.ready=true;if(fixtureBytes)sendOpen(fixtureBytes.slice(0),"fixture");}' +
            'else if(message.type==="opened"){state.opened+=1;state.openedMessages ||= [];state.openedMessages.push({documentId:message.documentId,openRequest:message.openRequest,revision:message.revision,dirty:message.dirty});}' +
            'else if(message.type==="annotation-source-identity"){if(message.identityStatus!=="KNOWN"||!Number.isSafeInteger(message.pageCount)||!Array.isArray(message.orderedPageIdentities)||message.orderedPageIdentities.length!==message.pageCount||message.orderedPageIdentities.some(identity=>typeof identity!=="string")||message.sourceHash!==sourceHash){iframe.contentWindow.postMessage({channel,type:"annotation-source-mismatch",token,documentId:message.documentId,openRequest:message.openRequest,reason:"PAGE_IDENTITY_UNAVAILABLE"},"*");return;}state.sourceIdentityConfirmed=true;state.identity={pageCount:message.pageCount,orderedPageIdentities:[...message.orderedPageIdentities]};iframe.contentWindow.postMessage({channel,type:"external-annotations-update",token,documentId:message.documentId,openRequest:message.openRequest,identityConfirmed:true,sourceMatch:state.operations.size?"MATCH":"BASELINE_ESTABLISHED",externalAnnotations:sidecarSnapshot()},"*");}' +
            'else if(message.type==="save"){persistOperations(message);const save={documentId:message.documentId,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,requestId:message.requestId,revision:message.revision,origin:message.origin,operationCount:message.operations?.length||0,operations:structuredClone(message.operations||[]),receivedAt:performance.now()};state.saves.push(save);save.ack=ackFor("saved",message);if(state.holdNextSaveAck){state.holdNextSaveAck=false;state.heldSaves.push(save);}else{iframe.contentWindow.postMessage(save.ack,"*");}}' +
            'else if(message.type==="recover"){persistOperations(message);const recovery={documentId:message.documentId,openRequest:message.openRequest,rendererGeneration:message.rendererGeneration,requestId:message.requestId,revision:message.revision,reason:message.reason,operationCount:message.operations?.length||0,operations:structuredClone(message.operations||[])};state.recoveries.push(recovery);iframe.contentWindow.postMessage(ackFor("recovered",message),"*");}' +
            'else if(message.type==="export-ready"){state.exports.push({documentId:message.documentId,openRequest:message.openRequest,requestId:message.requestId,revision:message.revision,byteLength:message.data?.byteLength||0,data:new Uint8Array(message.data).slice().buffer});}' +
            'else if(message.type==="error"){state.errors.push({code:message.code,message:message.message,documentId:message.documentId,requestId:message.requestId});}' +
            'else if(message.type==="flushed"){state.flushes ||= [];state.flushes.push({id:message.id,ok:message.ok,dirty:message.dirty,revision:message.revision,recovered:message.recovered||false});}' +
            '});' +
            'fetch("/fixture.pdf").then(response=>response.arrayBuffer()).then(data=>{fixtureBytes=data;if(state.ready)sendOpen(fixtureBytes.slice(0),"fixture");}).catch(error=>state.errors.push({message:error.message}));' +
            '</script>',
        );
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
      if (url.pathname === "/fixture.pdf") {
        target = fixturePath;
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
        await access(target);
        const info = await stat(target);
        if (!info.isFile()) {
          response.writeHead(404).end("not found");
          return;
        }
        response.writeHead(200, {
          "content-type": mimeTypeFor(target),
          "content-length": info.size,
          "x-content-type-options": "nosniff",
        });
        createReadStream(target).pipe(response);
      } catch {
        response.writeHead(404).end("not found");
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = "http://127.0.0.1:" + server.address().port;
    try {
      if (teardownDiagnosticsEnabled) {
        diagnosticProfileDirectory = await mkdtemp(
          path.join(tmpdir(), `puppeteer_dev_chrome_profile-${artifactBase}-`),
        );
      }
      const launchOptions = {
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      };
      if (diagnosticProfileDirectory) launchOptions.userDataDir = diagnosticProfileDirectory;
      browser = await launchTestBrowser(puppeteer, launchOptions, { testName: "free-text-undo-appearance-regression", artifactsDir: artifactsPath });
      const browserChild = browser.process?.();
      browserStderrObserver = observeBrowserTestChildStderr(browserChild);
      if (teardownDiagnosticsEnabled) {
        browserIdentity = await captureOwnedBrowserIdentity(browserChild);
        const recordTargetEvent = (event, target) => {
          if (diagnosticBrowserEvents.length >= 1_000) return;
          let type = null;
          let url = null;
          try { type = target?.type?.() || null; } catch {}
          try { url = safeTargetUrl(target?.url?.()); } catch {}
          diagnosticBrowserEvents.push({ event, at: Date.now(), target: { type, url } });
        };
        browser.on("targetcreated", (target) => recordTargetEvent("targetcreated", target));
        browser.on("targetchanged", (target) => recordTargetEvent("targetchanged", target));
        browser.on("targetdestroyed", (target) => recordTargetEvent("targetdestroyed", target));
        onBrowserCloseStart = ({ child, startedAt }) => {
          diagnosticTargetsBeforeClose = snapshotBrowserTargets(browser);
          diagnosticBrowserEvents.push({
            event: "browser.close.request",
            at: startedAt,
            targets: diagnosticTargetsBeforeClose,
          });
          if (!child || !browserIdentity) {
            diagnosticSampleResult = {
              state: "skipped",
              reason: "Launch-time owned process identity is unavailable",
              sampleDelayMs: chromeSampleDelayMs,
            };
            return;
          }
          if (typeof child.exitCode === "number" || typeof child.signalCode === "string") {
            diagnosticSampleResult = {
              state: "skipped",
              reason: "The browser process had already exited before close",
              sampleDelayMs: chromeSampleDelayMs,
            };
            return;
          }
          const samplePath = path.join(artifactsPath, `${artifactBase}.chrome-sample.txt`);
          diagnosticChildExitListener = () => {
            if (diagnosticSampleTimer) clearTimeout(diagnosticSampleTimer);
            diagnosticSampleTimer = null;
            if (!diagnosticSamplePromise && !diagnosticSampleResult) {
              diagnosticSampleResult = {
                state: "skipped",
                reason: `The owned browser exited before the configured ${chromeSampleDelayMs} ms sample point`,
                sampleDelayMs: chromeSampleDelayMs,
              };
            }
          };
          child.once("exit", diagnosticChildExitListener);
          diagnosticSampleTimer = setTimeout(() => {
            diagnosticSampleTimer = null;
            const sampleStartedAt = Date.now();
            diagnosticSamplePromise = sampleOwnedBrowserProcess(
              child,
              browserIdentity,
              samplePath,
              { durationSeconds: 1, timeoutMs: 8_000, mayDie: true },
            ).then(
              (result) => {
                diagnosticSampleResult = {
                  ...result,
                  sampleDelayMs: chromeSampleDelayMs,
                  sampleStartedAt,
                  sampleDurationSeconds: 1,
                  sampleTimeoutMs: 8_000,
                  mayDie: true,
                };
                return diagnosticSampleResult;
              },
              (error) => {
                diagnosticSampleResult = {
                  state: "failed",
                  message: error?.message || String(error),
                  sampleDelayMs: chromeSampleDelayMs,
                  sampleStartedAt,
                  sampleDurationSeconds: 1,
                  sampleTimeoutMs: 8_000,
                  mayDie: true,
                };
                return diagnosticSampleResult;
              },
            );
          }, chromeSampleDelayMs);
        };
      }
      page = await browser.newPage();
      await page.setViewport({ width: 1360, height: 980 });
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("request", (request) => {
        if (!isInlineToolbarIcon(request.url()) && new URL(request.url()).origin !== baseUrl) externalRequests.push(request.url());
      });
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const viewer = page.frames().find((frame) => frame.name() === "pdf-reader");
      assert.ok(viewer, "Expected the PDF.js iframe");
      await page.waitForFunction(() => window.__hostState?.opened === 1, { timeout: 30_000 });
      await viewer.waitForFunction(() => {
        const app = window.PDFViewerApplication;
        const pageView = app?.pdfViewer?.getPageView(0);
        return app?.pdfDocument && pageView?.renderingState === 3 &&
          pageView?.div?.dataset.loaded === "true" &&
          !pageView.div.classList.contains("loading") &&
          !pageView.div.classList.contains("loadingIcon");
      }, { timeout: 30_000 });
      await page.waitForFunction(
        () => window.__hostState?.sourceIdentityConfirmed === true,
        { timeout: 15_000 },
      );
      await viewer.waitForFunction(
        () => document.getElementById("editorFreeTextButton")?.disabled === false,
        { timeout: 15_000 },
      );

      // Test-only instrumentation: preserve PDF.js return values and behavior
      // while recording the exact editor/model/DOM state around each real
      // FreeText commit. This distinguishes a layout/readiness failure from a
      // transient blur or accessibility-layer DOM move during commit.
      await viewer.evaluate(() => {
        const app = PDFViewerApplication;
        const manager = app.pdfViewer?._layerProperties?.annotationEditorUIManager;
        if (!manager || window.__freeTextCommitDiagnostic) {
          throw new Error("FreeText diagnostic hook requires the active annotation editor manager");
        }
        const traceLimit = 300;
        const trace = [];
        const wrappedMethods = [];
        const docListeners = [];
        const diagnostic = {
          trace,
          traceLimit,
          editorId: null,
          stage: "before-editor",
          startedAt: performance.now(),
          mark: (label, detail = null) => {
            diagnostic.stage = label;
            record(label, diagnostic.editor, false, detail);
          },
          dispose: null,
        };
        const describeNode = (node) => {
          if (!node) return null;
          const className = typeof node.className === "string" ? node.className : "";
          return {
            node: node.nodeName || null,
            id: node.id || null,
            className: className.slice(0, 160),
            connected: Boolean(node.isConnected),
          };
        };
        const rectOf = (node) => {
          if (!node?.getBoundingClientRect) return null;
          try {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
          } catch (error) {
            return { error: String(error?.message || error).slice(0, 160) };
          }
        };
        const safeValue = (read) => {
          try { return read(); } catch (error) { return { error: String(error?.message || error).slice(0, 160) }; }
        };
        const nodePath = (node, limit = 7) => {
          const path = [];
          for (let current = node; current && path.length < limit; current = current.parentElement) {
            const computed = getComputedStyle(current);
            path.push({
              ...describeNode(current),
              display: computed.display,
              visibility: computed.visibility,
              opacity: computed.opacity,
              hidden: Boolean(current.hidden),
              rect: rectOf(current),
            });
          }
          return path;
        };
        const activeElement = () => {
          const active = document.activeElement;
          return {
            ...describeNode(active),
            insideMonitoredEditor: Boolean(diagnostic.editor?.div?.contains(active)),
            insideMonitoredInput: Boolean(diagnostic.editor?.editorDiv?.contains(active)),
          };
        };
        const viewportState = () => {
          const viewport = window.visualViewport;
          const container = document.getElementById("viewerContainer");
          const containerRect = rectOf(container);
          return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            visualViewport: viewport ? {
              width: viewport.width,
              height: viewport.height,
              scale: viewport.scale,
              offsetLeft: viewport.offsetLeft,
              offsetTop: viewport.offsetTop,
              pageLeft: viewport.pageLeft,
              pageTop: viewport.pageTop,
            } : null,
            viewerContainer: {
              rect: containerRect,
              scrollLeft: container?.scrollLeft ?? null,
              scrollTop: container?.scrollTop ?? null,
            },
            pdfViewer: {
              currentScale: app.pdfViewer?.currentScale ?? null,
              currentScaleValue: app.pdfViewer?._currentScaleValue ?? null,
            },
          };
        };
        const snapshot = (editor) => {
          const page = document.querySelector('.page[data-page-number="1"]');
          const div = editor?.div || null;
          const input = editor?.editorDiv || div?.querySelector?.(".internal") || null;
          let serialized = null;
          try { serialized = editor?.serialize?.(true) ?? null; }
          catch (error) { serialized = { error: String(error?.message || error).slice(0, 240) }; }
          return {
            editorId: editor?.id ?? null,
            uid: editor?.uid ?? null,
            editorType: editor?.editorType ?? null,
            model: {
              width: editor?.width ?? null,
              height: editor?.height ?? null,
              x: editor?.x ?? null,
              y: editor?.y ?? null,
              rotation: editor?.rotation ?? null,
              parentRotation: editor?.parentRotation ?? null,
              parentScale: safeValue(() => editor.parentScale),
              pageDimensions: safeValue(() => [...editor.pageDimensions]),
              parentDimensions: safeValue(() => [...editor.parentDimensions]),
              isInEditMode: safeValue(() => editor.isInEditMode?.() ?? null),
              isEditing: editor?.isEditing ?? null,
              isAttachedToDOM: editor?.isAttachedToDOM ?? null,
            },
            text: {
              value: serialized?.value ?? null,
              editorText: input?.textContent?.slice(0, 240) ?? null,
              contentEditable: input?.contentEditable ?? null,
              inputConnected: Boolean(input?.isConnected),
            },
            serialized,
            activeElement: activeElement(),
            viewport: viewportState(),
            editorDivRect: rectOf(div),
            inputRect: rectOf(input),
            pageRect: rectOf(page),
            parentRect: rectOf(editor?.parent?.div),
            divConnected: Boolean(div?.isConnected),
            ancestorPath: nodePath(div),
          };
        };
        function record(event, editor = diagnostic.editor, includeStack = true, detail = null) {
          const entry = {
            sequence: trace.length + 1,
            event,
            at: performance.now(),
            elapsedMs: performance.now() - diagnostic.startedAt,
            stage: diagnostic.stage,
            editorId: editor?.id ?? diagnostic.editorId,
            detail,
            state: editor ? snapshot(editor) : {
              activeElement: activeElement(),
              viewport: viewportState(),
              pageRect: rectOf(document.querySelector('.page[data-page-number="1"]')),
            },
          };
          if (includeStack) entry.stack = String(new Error().stack || "").split("\n").slice(2, 10);
          trace.push(entry);
          if (trace.length > traceLimit) trace.splice(0, trace.length - traceLimit);
        }
        const addDocumentListener = (type, listener, options = true) => {
          document.addEventListener(type, listener, options);
          docListeners.push([type, listener, options]);
        };
        const targetDescription = (node) => ({
          ...describeNode(node),
          text: node?.textContent?.slice?.(0, 80) || null,
        });
        for (const type of ["focusin", "focusout", "blur", "input", "beforeinput"]) {
          addDocumentListener(type, (event) => {
            const current = diagnostic.editor;
            const targetIsEditor = Boolean(current?.div?.contains(event.target));
            const relatedIsEditor = Boolean(current?.div?.contains(event.relatedTarget));
            if (!targetIsEditor && !relatedIsEditor && type !== "blur") return;
            record(`dom.${type}`, current, false, {
              eventTimeStamp: event.timeStamp,
              trusted: event.isTrusted,
              target: targetDescription(event.target),
              relatedTarget: targetDescription(event.relatedTarget),
              inputType: event.inputType || null,
            });
          }, true);
        }
        addDocumentListener("keydown", (event) => {
          if (!event.isTrusted || !(event.metaKey || event.ctrlKey || event.key === "Enter")) return;
          record("dom.trusted-keydown", diagnostic.editor, false, {
            eventTimeStamp: event.timeStamp,
            key: event.key,
            code: event.code,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            target: targetDescription(event.target),
          });
        }, true);
        const onWindowBlur = (event) => record("window.blur", diagnostic.editor, false, {
          eventTimeStamp: event.timeStamp,
        });
        window.addEventListener("blur", onWindowBlur, true);
        const eventBus = app.eventBus;
        const onEditorMovedInDom = (event) => {
          if (!event?.source || event.source === diagnostic.editor) {
            record("pdfjs.editormovedindom", event?.source || diagnostic.editor, false, {
              sourceId: event?.source?.id ?? null,
            });
          }
        };
        eventBus?.on?.("editormovedindom", onEditorMovedInDom);
        const originalDispatch = eventBus?.dispatch;
        const eventBusHadOwnDispatch = Boolean(eventBus && Object.hasOwn(eventBus, "dispatch"));
        const wrappedDispatch = eventBus && typeof originalDispatch === "function"
          ? function (...args) {
              const [eventName, eventData] = args;
              if (eventName === "scalechanging") {
                const source = eventData?.source;
                record("pdfjs.scalechanging.before-listeners", diagnostic.editor, false, {
                  scale: eventData?.scale ?? null,
                  presetValue: eventData?.presetValue ?? null,
                  sourceType: source?.constructor?.name ?? null,
                  sourceCurrentScale: source?.currentScale ?? null,
                  sourceCurrentScaleValue: source?._currentScaleValue ?? null,
                  sourceContainerRect: rectOf(source?.container),
                  viewport: viewportState(),
                });
              }
              let result;
              try {
                result = originalDispatch.apply(this, args);
              } catch (error) {
                if (eventName === "scalechanging") {
                  record("pdfjs.scalechanging.listener-throw", diagnostic.editor, false, {
                    name: error?.name || "Error",
                    message: String(error?.message || error).slice(0, 240),
                    scale: eventData?.scale ?? null,
                    presetValue: eventData?.presetValue ?? null,
                    viewport: viewportState(),
                  });
                }
                throw error;
              }
              if (eventName === "scalechanging") {
                record("pdfjs.scalechanging.after-listeners", diagnostic.editor, false, {
                  scale: eventData?.scale ?? null,
                  presetValue: eventData?.presetValue ?? null,
                  sourceType: eventData?.source?.constructor?.name ?? null,
                  viewport: viewportState(),
                });
              }
              return result;
            }
          : null;
        if (wrappedDispatch) eventBus.dispatch = wrappedDispatch;
        const originalAddEditor = manager.addEditor;
        const managerHadOwnAddEditor = Object.hasOwn(manager, "addEditor");
        const wrappedAddEditor = function (...args) {
          const result = originalAddEditor.apply(this, args);
          const editor = args[0];
          if (editor?.editorType === "freetext" && !diagnostic.editor) {
            diagnostic.editor = editor;
            diagnostic.editorId = editor.id;
            for (const name of ["commitForSave", "commit", "commitOrRemove"]) {
              const original = editor[name];
              if (typeof original !== "function") continue;
              const hadOwn = Object.hasOwn(editor, name);
              const wrapped = function (...methodArgs) {
                record(`editor.${name}.before`, editor, true, { argsCount: methodArgs.length });
                let result;
                try {
                  result = original.apply(this, methodArgs);
                } catch (error) {
                  record(`editor.${name}.throw`, editor, true, {
                    name: error?.name || "Error",
                    message: String(error?.message || error).slice(0, 240),
                  });
                  throw error;
                }
                record(`editor.${name}.after`, editor, false, {
                  resultType: result === null ? "null" : typeof result,
                  isPromise: Boolean(result && typeof result.then === "function"),
                });
                return result;
              };
              editor[name] = wrapped;
              wrappedMethods.push({ editor, name, original, wrapped, hadOwn });
            }
            record("manager.addEditor", editor, true, {
              divPresent: Boolean(editor.div),
              divConnected: Boolean(editor.div?.isConnected),
            });
          }
          return result;
        };
        manager.addEditor = wrappedAddEditor;
        diagnostic.dispose = () => {
          for (const [type, listener, options] of docListeners) {
            document.removeEventListener(type, listener, options);
          }
          window.removeEventListener("blur", onWindowBlur, true);
          eventBus?.off?.("editormovedindom", onEditorMovedInDom);
          if (eventBus && eventBus.dispatch === wrappedDispatch) {
            if (eventBusHadOwnDispatch) eventBus.dispatch = originalDispatch;
            else delete eventBus.dispatch;
          }
          if (manager.addEditor === wrappedAddEditor) {
            if (managerHadOwnAddEditor) manager.addEditor = originalAddEditor;
            else delete manager.addEditor;
          }
          for (const { editor, name, original, wrapped, hadOwn } of wrappedMethods) {
            if (editor[name] !== wrapped) continue;
            if (hadOwn) editor[name] = original;
            else delete editor[name];
          }
          record("diagnostic.disposed", diagnostic.editor, false);
        };
        window.__freeTextCommitDiagnostic = diagnostic;
      });

      const waitForSaveCount = async (count) =>
        page.waitForFunction((expected) => window.__hostState?.saves?.length >= expected, { timeout: 30_000 }, count);
      const waitForOpenCount = async (count) =>
        page.waitForFunction((expected) => window.__hostState?.opened >= expected, { timeout: 30_000 }, count);
      const waitForPageReady = async () =>
        viewer.waitForFunction(() => {
          const app = window.PDFViewerApplication;
          const pageView = app?.pdfViewer?.getPageView(0);
          return app?.pdfDocument && app.pdfViewer.annotationEditorMode !== undefined &&
            pageView?.renderingState === 3 && pageView?.div?.dataset.loaded === "true" &&
            pageView?.annotationEditorLayer?.div?.isConnected;
        }, { timeout: 30_000 });
      const waitForVisualChangeFromBaseline = async (roi) => {
        const deadline = Date.now() + 15_000;
        let sample;
        while (Date.now() < deadline) {
          sample = await sampleVisibleRoi(roi);
          if (sample.differentPixels > 0) return sample;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`The visible FreeText ROI did not change: ${JSON.stringify(sample)}`);
      };
      const waitForVisualRestoreBaseline = async (roi) => {
        const deadline = Date.now() + 15_000;
        let sample;
        while (Date.now() < deadline) {
          sample = await sampleVisibleRoi(roi);
          if (sample.differentPixels === 0) return sample;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`The visible FreeText ROI did not restore: ${JSON.stringify(sample)}`);
      };
      const setMode = async (mode) => {
        const previousEvents = await viewer.evaluate(() => {
          window.__modeEvents ||= [];
          return window.__modeEvents.length;
        });
        await viewer.evaluate((value) => {
          PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { mode: value });
        }, mode);
        await viewer.waitForFunction((value) =>
          PDFViewerApplication.pdfViewer.annotationEditorMode === value,
          { timeout: 10_000 }, mode);
        await viewer.waitForFunction(
          ({ expectedMode, previousEvents: start }) =>
            (window.__modeEvents || []).some(
              (event, index) => index >= start && event.mode === expectedMode,
            ),
          { timeout: 15_000 },
          { expectedMode: mode, previousEvents },
        );
      };
      // The source PDF is immutable in this mode: sidecar FreeText is rendered
      // by PDF.js in the annotation editor DOM, not into the source page canvas.
      // Capture the real browser pixels at that DOM editor's viewport ROI.
      const visualBaselines = new Map();
      markFreeTextTrace = async (label, detail = null) => {
        try {
          await viewer.evaluate(({ value, extra }) =>
            window.__freeTextCommitDiagnostic?.mark?.(value, extra), { value: label, extra: detail });
        } catch {}
      };
      const sampleVisibleRoi = async (targetRect, captureBaseline = false) => {
        const frameRect = await page.$eval("iframe", (frame) => {
          const rect = frame.getBoundingClientRect();
          return { x: rect.x, y: rect.y };
        });
        const clip = {
          x: Math.max(0, Math.floor(frameRect.x + targetRect.x)),
          y: Math.max(0, Math.floor(frameRect.y + targetRect.y)),
          width: Math.max(1, Math.ceil(targetRect.width)),
          height: Math.max(1, Math.ceil(targetRect.height)),
        };
        const viewport = page.viewport();
        assert.ok(viewport, "ROI screenshot requires a known browser viewport");
        assert.ok(
          clip.x >= 0 && clip.y >= 0 &&
            clip.x + clip.width <= viewport.width &&
            clip.y + clip.height <= viewport.height,
          "Visible FreeText screenshot ROI must fit completely inside the browser viewport: " +
            JSON.stringify({ clip, viewport, targetRect, frameRect }),
        );
        const screenshotOptions = { clip, captureBeyondViewport: false };
        await markFreeTextTrace("test.screenshot.before-roi", { screenshotOptions, viewport });
        const screenshot = await page.screenshot(screenshotOptions);
        await markFreeTextTrace("test.screenshot.after-roi", { screenshotOptions, viewport });
        const decoded = decodePngRgb(Buffer.from(screenshot));
        const pixels = decoded.pixels;
        const baselineKey = JSON.stringify({ x: clip.x, y: clip.y, width: decoded.width, height: decoded.height });
        if (captureBaseline) visualBaselines.set(baselineKey, Buffer.from(pixels));
        const baseline = visualBaselines.get(baselineKey);
        let nonWhitePixels = 0;
        let darkPixels = 0;
        let differentPixels = baseline?.length === pixels.length ? 0 : null;
        for (let index = 0; index < pixels.length; index += 3) {
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          if (red < 248 || green < 248 || blue < 248) nonWhitePixels += 1;
          if (red + green + blue < 600) darkPixels += 1;
          if (baseline && (red !== baseline[index] || green !== baseline[index + 1] || blue !== baseline[index + 2])) {
            differentPixels += 1;
          }
        }
        return {
          targetRect,
          screenshotClip: clip,
          width: decoded.width,
          height: decoded.height,
          nonWhitePixels,
          darkPixels,
          fingerprint: createHash("sha256").update(pixels).digest("hex"),
          differentPixels,
        };
      };
      const snapshot = async (label, visualRoi = null) => {
        await markFreeTextTrace(`test.snapshot.before-state:${label}`);
        const state = await viewer.evaluate(({ label: labelValue }) => {
          const app = PDFViewerApplication;
          const page = document.querySelector('.page[data-page-number="1"]');
          const annotationLayer = page?.querySelector(".annotationLayer");
          const editorLayer = page?.querySelector(".annotationEditorLayer");
          const section = [...(annotationLayer?.querySelectorAll(".freeTextAnnotation") || [])]
            .find((node) => node.textContent.includes("UndoVisibilityProof"));
          const sectionRect = section?.getBoundingClientRect();
          const manager = app.pdfViewer?._layerProperties?.annotationEditorUIManager;
          const editors = manager ? [...manager.getEditors(0)] : [];
          const editor = editors.find((candidate) =>
            candidate.editorType === "freetext" &&
            (candidate.serialize?.()?.value?.includes("UndoVisibilityProof") ||
              candidate.div?.textContent?.includes("UndoVisibilityProof") ||
              app.pdfDocument.annotationStorage.getRawValue(candidate.id)?.value?.includes("UndoVisibilityProof")),
          );
          const annotation = app.pdfDocument.annotationStorage.serializable.map?.values?.();
          const rawValues = [...(annotation || [])].map((entry) => ({
            id: entry.id,
            annotationType: entry.annotationType,
            deleted: entry.deleted,
            value: entry.value,
            rect: entry.rect,
          }));
          return {
            label: labelValue,
            mode: app.pdfViewer.annotationEditorMode,
            loaded: page?.dataset.loaded,
            annotation: section ? {
              id: section.id,
              annotationId: section.getAttribute("data-annotation-id"),
              hidden: section.hidden,
              display: getComputedStyle(section).display,
              visibility: getComputedStyle(section).visibility,
              text: section.textContent.trim(),
              contentText: section.querySelector(".annotationContent")?.textContent?.trim() || null,
              rect: sectionRect ? { x: sectionRect.x, y: sectionRect.y, width: sectionRect.width, height: sectionRect.height } : null,
            } : null,
            annotationNodes: [...(annotationLayer?.querySelectorAll(".freeTextAnnotation") || [])].map((node) => ({
              id: node.id,
              annotationId: node.getAttribute("data-annotation-id"),
              text: node.textContent.trim(),
              hidden: node.hidden,
              display: getComputedStyle(node).display,
              rect: (() => {
                const rect = node.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
              })(),
            })),
            editorLayer: editorLayer ? {
              hidden: editorLayer.hidden,
              display: getComputedStyle(editorLayer).display,
              editors: [...editorLayer.querySelectorAll(".freeTextEditor")].map((node) => ({
                id: node.id,
                text: node.textContent.trim(),
                className: node.className,
                rect: (() => {
                  const rect = node.getBoundingClientRect();
                  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                })(),
              })),
            } : null,
            editor: editor ? {
              id: editor.id,
              uid: editor.uid,
              annotationElementId: editor.annotationElementId,
              deleted: editor.deleted,
              type: editor.editorType,
              serialized: editor.serialize?.() || null,
              divConnected: !!editor.div?.isConnected,
            } : null,
            editorVisual: editor?.div ? (() => {
              const rect = editor.div.getBoundingClientRect();
              const internalRect = editor.div.querySelector(".internal")?.getBoundingClientRect();
              return {
                text: editor.div.textContent.trim(),
                hidden: editor.div.hidden || editor.div.classList.contains("hidden"),
                display: getComputedStyle(editor.div).display,
                visibility: getComputedStyle(editor.div).visibility,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                textRect: internalRect
                  ? { x: internalRect.x, y: internalRect.y, width: internalRect.width, height: internalRect.height }
                  : null,
              };
            })() : null,
            rawValues,
            trustedUndo: window.__trustedKeys?.filter((event) => /z/i.test(event.key)).slice(-3) || [],
          };
        }, { label });
        await markFreeTextTrace(`test.snapshot.after-state:${label}`);
        const targetRect = visualRoi || state.editorVisual?.textRect || state.editorVisual?.rect;
        const screenshotRoi = targetRect
          ? await sampleVisibleRoi(targetRect, label === "reopened-original")
          : { targetRect: null, nonWhitePixels: null, fingerprint: null, differentPixels: null };
        const host = await page.evaluate(() => ({
          saves: (window.__hostState?.saves || []).map(({ documentId, openRequest, revision, origin, operationCount }) => ({ documentId, openRequest, revision, origin, operationCount })),
          operations: [...(window.__hostState?.operations?.values?.() || [])],
          opened: window.__hostState?.opened,
          opens: window.__hostState?.opens,
          errors: window.__hostState?.errors,
          recoveries: (window.__hostState?.recoveries || []).map(({ documentId, openRequest, revision, reason, operationCount }) => ({ documentId, openRequest, revision, reason, operationCount })),
          exports: (window.__hostState?.exports || []).map(({ documentId, openRequest, revision, requestId, byteLength }) => ({ documentId, openRequest, revision, requestId, byteLength })),
        }));
        const result = { ...state, visualRoi: screenshotRoi, host };
        evidence.push(result);
        await persistEvidence();
        return result;
      };

      await viewer.evaluate(() => {
        window.__trustedKeys = [];
        document.addEventListener("keydown", (event) => {
          if (event.isTrusted) window.__trustedKeys.push({ key: event.key, code: event.code, metaKey: event.metaKey, target: event.target?.tagName });
        }, true);
        window.__modeEvents = [];
        PDFViewerApplication.eventBus.on("annotationeditormodechanged", (event) =>
          window.__modeEvents.push({ mode: event.mode, temporary: event.isTemporary }),
        );
      });
      await setMode(3);
      const pageRect = await viewer.evaluate(() => {
        const page = document.querySelector('.page[data-page-number="1"]');
        const rect = page.getBoundingClientRect();
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
      const creationHit = await viewer.evaluate(
        ({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          const page = document.querySelector(
            '.page[data-page-number="1"]',
          );
          return {
            insideViewport:
              x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
            insidePage: !!page && (hit === page || page.contains(hit)),
            hit: hit
              ? {
                  tag: hit.tagName,
                  id: hit.id,
                  className:
                    typeof hit.className === "string" ? hit.className : "",
                }
              : null,
          };
        },
        {
          x: createPoint.x - iframeRect.x,
          y: createPoint.y - iframeRect.y,
        },
      );
      evidence.push({ stage: "creation-hit", point: createPoint, creationHit });
      assert.ok(
        creationHit.insideViewport && creationHit.insidePage,
        "FreeText creation click must hit the visible PDF page: " +
          JSON.stringify(creationHit),
      );
      await page.mouse.click(createPoint.x, createPoint.y, { button: "left" });
      const editorSelector = '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal[contenteditable="true"]';
      await viewer.waitForSelector(editorSelector, { timeout: 15_000 });
      await page.keyboard.type("UndoVisibilityProof", { delay: 15 });
      await viewer.waitForFunction((selector) => {
        const internal = document.querySelector(selector);
        return internal?.textContent?.includes("UndoVisibilityProof") &&
          document.activeElement === internal;
      }, { timeout: 15_000 }, editorSelector);
      evidence.push({ stage: "typed", point: createPoint, editor: await snapshot("typed") });
      // PDF.js commits a FreeText editor with Meta+Enter on macOS and
      // Control+Enter elsewhere. Commit before switching tools so its
      // measured PDF rectangle is available to the immutable-source sidecar.
      const commitModifier = await viewer.evaluate(() =>
        navigator.platform.includes("Mac") ? "Meta" : "Control",
      );
      await page.keyboard.down(commitModifier);
      try {
        await page.keyboard.press("Enter");
      } finally {
        await page.keyboard.up(commitModifier);
      }
      await viewer.waitForFunction((value) => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const editor = [...(manager?.getEditors(0) || [])].find((candidate) =>
          candidate.deleted !== true && candidate.editorType === "freetext" &&
          candidate.div?.querySelector(".internal")?.textContent === value,
        );
        const serialized = editor?.serialize?.(true);
        const rect = editor?.div?.getBoundingClientRect();
        return Boolean(serialized?.value === value && Array.isArray(serialized.rect) &&
          serialized.rect[2] > serialized.rect[0] && serialized.rect[3] > serialized.rect[1] &&
          rect?.width > 0 && rect?.height > 0);
      }, { timeout: 10_000 }, "UndoVisibilityProof");
      const noneButtonTarget = await viewer.$eval("#editorFreeTextButton", (button) => {
        const rect = button.getBoundingClientRect();
        const candidates = [
          [0.5, 0.5], [0.25, 0.5], [0.75, 0.5],
          [0.5, 0.25], [0.5, 0.75], [0.25, 0.25], [0.75, 0.75],
        ];
        for (const [xRatio, yRatio] of candidates) {
          const x = rect.left + rect.width * xRatio;
          const y = rect.top + rect.height * yRatio;
          const hit = document.elementFromPoint(x, y);
          if (hit === button || button.contains(hit)) {
            return {
              enabled: !button.disabled,
              hitsButton: true,
              x,
              y,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              hit: { tag: hit?.tagName, id: hit?.id || null, className: typeof hit?.className === "string" ? hit.className : "" },
            };
          }
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return {
          enabled: !button.disabled,
          hitsButton: false,
          x,
          y,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          hit: { tag: hit?.tagName, id: hit?.id || null, className: typeof hit?.className === "string" ? hit.className : "" },
        };
      });
      assert.ok(noneButtonTarget.enabled,
        "The fixture must confirm source identity before clicking a FreeText tool");
      assert.ok(noneButtonTarget.hitsButton,
        "The chosen mouse coordinate must hit the actual FreeText button: " + JSON.stringify(noneButtonTarget));
      const modeEventCountBeforeNoneClick = await viewer.evaluate(
        () => window.__modeEvents.length,
      );
      await page.mouse.click(
        iframeRect.x + noneButtonTarget.x,
        iframeRect.y + noneButtonTarget.y,
        { button: "left" },
      );
      await viewer.waitForFunction(
        (start) => (window.__modeEvents || []).some(
          (event, index) => index >= start && event.mode === 0,
        ),
        { timeout: 15_000 },
        modeEventCountBeforeNoneClick,
      );
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
        { timeout: 15_000 },
      );
      await snapshot("created-committed");
      await waitForSaveCount(1);
      await viewer.waitForFunction(() => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const editors = [...(manager?.getEditors(0) || [])];
        return PDFViewerApplication.pdfViewer.annotationEditorMode === 0 &&
          !PDFViewerApplication._hasChanges() &&
          editors.some((editor) =>
            editor.editorType === "freetext" &&
            (editor.div?.textContent?.includes("UndoVisibilityProof") ||
              PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(editor.id)?.value?.includes("UndoVisibilityProof")),
          );
      }, { timeout: 30_000 });
      const originalFreeText = await viewer.evaluate(async () => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const editor = [...(manager?.getEditors(0) || [])].find((candidate) =>
          candidate.editorType === "freetext" &&
          (candidate.div?.textContent?.includes("UndoVisibilityProof") ||
            PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(candidate.id)?.value?.includes("UndoVisibilityProof")),
        );
        const raw = editor
          ? PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(editor.id)
          : null;
        return { editor: editor ? { id: editor.id, annotationElementId: editor.annotationElementId, deleted: editor.deleted } : null, raw: raw ? { value: raw.value, annotationType: raw.annotationType } : null };
      });
      evidence.push({ stage: "saved-original", originalFreeText });
      await persistEvidence();

      const expectedOpen = 2;
      await page.evaluate(() => window.__sendOpenSaved());
      await waitForOpenCount(expectedOpen);
      await waitForPageReady();
      const afterReopen = await snapshot("reopened-original");
      const originalVisualRoi = afterReopen.visualRoi;
      const sidecarOperationFor = (snapshot, uuid) => snapshot.host.operations.find((row) => row.uuid === uuid);
      const reopenedSidecarOperation = afterReopen.host.operations.find((row) =>
        row.kind === "FreeText" && row.payload?.editor?.value?.includes("UndoVisibilityProof"),
      );
      assert.ok(
        afterReopen.editorVisual?.rect?.width > 0 && afterReopen.editorVisual?.rect?.height > 0 &&
          afterReopen.editorVisual.text.includes("UndoVisibilityProof"),
        "The reopened sidecar FreeText editor must render its text with positive DOM geometry: " +
          JSON.stringify(afterReopen.editorVisual),
      );
      assert.ok(
        reopenedSidecarOperation && reopenedSidecarOperation.deleted !== true,
        "The reopened editor must be bound to its active durable FreeText sidecar operation",
      );
      const savedFreeTextId = reopenedSidecarOperation.uuid;
      evidence.push({ stage: "reopened-sidecar-operation", operation: reopenedSidecarOperation });
      await persistEvidence();
      assert.ok(originalVisualRoi.targetRect && originalVisualRoi.nonWhitePixels > 0,
        "The reopened sidecar renderer must contribute visible pixels in the screenshot ROI: " +
          JSON.stringify(originalVisualRoi));
      assert.equal(afterReopen.editor.annotationElementId, null,
        "A sidecar-only FreeText remains a PDF.js editor and is not misreported as an embedded PDF annotation");
      assert.equal(afterReopen.host.opens[0].byteLength, afterReopen.host.opens[1].byteLength,
        "Reopening a sidecar operation supplies the unchanged source PDF bytes");
      const eraseRect = afterReopen.editorVisual.rect;
      const eraseStart = {
        x: iframeRect.x + eraseRect.x + Math.min(eraseRect.width / 2, 8),
        y: iframeRect.y + eraseRect.y + Math.min(eraseRect.height / 2, 8),
      };
      const eraseSaveCount = await page.evaluate(() => window.__hostState.saves.length + 1);
      await page.evaluate(() => window.__holdNextSaveAck());
      await page.mouse.move(eraseStart.x, eraseStart.y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(eraseStart.x + 16, eraseStart.y + 4, { steps: 4 });
      await page.mouse.up({ button: "right" });
      await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 0, { timeout: 15_000 });
      const eraserMode = await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode);
      assert.equal(eraserMode, 0, "Temporary eraser must restore NONE mode");
      await waitForSaveCount(eraseSaveCount);
      const heldEraseSave = await page.evaluate(() => ({
        held: window.__hostState.heldSaves.length,
        save: window.__hostState.saves.at(-1)
          ? { revision: window.__hostState.saves.at(-1).revision, origin: window.__hostState.saves.at(-1).origin }
          : null,
      }));
      evidence.push({ stage: "erase-save-held", ...heldEraseSave });
      assert.equal(heldEraseSave.held, 1, "The eraser save must remain unacknowledged for the undo boundary case");
      const afterErase = await snapshot(
        "after-right-erase-save-held",
        originalVisualRoi.targetRect,
      );
      const erasedOperation = sidecarOperationFor(afterErase, savedFreeTextId);
      assert.ok(
        erasedOperation?.deleted === true,
        "Right-drag must persist a tombstone for the same FreeText sidecar UUID",
      );
      assert.ok(
        !afterErase.editorVisual || afterErase.editorVisual.hidden ||
          afterErase.editorVisual.display === "none" || afterErase.editorVisual.visibility === "hidden" ||
          afterErase.editorVisual.rect.width === 0,
        "The erased sidecar editor must disappear from the visible editor layer in NONE mode",
      );
      const erasedVisualRoi = await waitForVisualChangeFromBaseline(originalVisualRoi.targetRect);
      assert.ok(
        erasedVisualRoi.differentPixels > 0 &&
          erasedVisualRoi.fingerprint !== originalVisualRoi.fingerprint,
        "Right eraser must remove the rendered sidecar text from the visible screenshot ROI: " +
          JSON.stringify({ original: originalVisualRoi, erased: erasedVisualRoi }),
      );
      evidence.push({ stage: "erased-sidecar-render-roi", visualRoi: erasedVisualRoi });
      await persistEvidence();

      const undoSaveCount = await page.evaluate(() => window.__hostState.saves.length + 1);
      await page.keyboard.down("Meta");
      await page.keyboard.press("z");
      await page.keyboard.up("Meta");
      await viewer.waitForFunction(() => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        return [...(manager?.getEditors(0) || [])].some((editor) =>
          editor.deleted === false && editor.editorType === "freetext" &&
          (editor.serialize?.()?.value?.includes("UndoVisibilityProof") ||
            editor.div?.textContent?.includes("UndoVisibilityProof")),
        );
      }, { timeout: 10_000 });
      const undoBeforeRepaint = await snapshot(
        "undo-while-erase-save-held",
        originalVisualRoi.targetRect,
      );
      const undoKey = undoBeforeRepaint.trustedUndo?.at(-1);
      assert.ok(undoKey?.metaKey && String(undoKey.key).toLowerCase() === "z", "Undo must be a trusted Meta-Z key");
      assert.equal(
        undoBeforeRepaint.mode,
        0,
        "Undo must leave the editor in NONE mode while the previous sidecar save is pending",
      );
      assert.equal(sidecarOperationFor(undoBeforeRepaint, savedFreeTextId)?.deleted, true,
        "The host must retain the right-erase tombstone until it acknowledges the pending undo save");
      const undoPendingVisualRoi = await waitForVisualRestoreBaseline(originalVisualRoi.targetRect);
      const undoWhileSaveHeld = await snapshot(
        "undo-while-erase-save-held-painted",
        originalVisualRoi.targetRect,
      );
      assert.ok(
        undoWhileSaveHeld.editorVisual?.rect?.width > 0 &&
          undoWhileSaveHeld.editorVisual?.text.includes("UndoVisibilityProof"),
        "Undo must immediately restore the visible sidecar FreeText while persistence is pending",
      );
      assert.equal(undoPendingVisualRoi.differentPixels, 0,
        "Undo restores the same rendered FreeText pixels even before the earlier save ACK arrives");
      await page.evaluate(() => window.__releaseHeldSaveAcks());
      await waitForSaveCount(undoSaveCount);
      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
      const afterUndo = await snapshot(
        "after-trusted-meta-z-and-ack",
        originalVisualRoi.targetRect,
      );
      assert.ok(
        afterUndo.editorVisual?.rect?.width > 0 && afterUndo.editorVisual?.rect?.height > 0 &&
          afterUndo.editorVisual.text.includes("UndoVisibilityProof"),
        "Undo must restore the same visible sidecar FreeText in NONE mode",
      );
      assert.equal(afterUndo.mode, 0, "Undo must keep the viewer in NONE mode after the sidecar save ACK");
      assert.equal(sidecarOperationFor(afterUndo, savedFreeTextId)?.deleted, false,
        "The durable undo operation must reactivate the same sidecar UUID");
      assert.equal(
        afterUndo.host.saves.length,
        eraseSaveCount + 1,
        "The visual sidecar repaint must not create an extra document revision or host save",
      );
      assert.ok(
        afterUndo.visualRoi.nonWhitePixels > 0,
        "Undo must repaint non-white FreeText pixels in the browser screenshot ROI: " +
          JSON.stringify({ before: originalVisualRoi, after: afterUndo.visualRoi }),
      );
      assert.equal(
        afterUndo.visualRoi.fingerprint,
        originalVisualRoi.fingerprint,
        "Undo must restore the same sidecar FreeText screenshot pixels",
      );
      assert.equal(afterUndo.visualRoi.differentPixels, 0, "Undo screenshot ROI must match the original sidecar rendering pixel-for-pixel");

      const redoSaveCount = await page.evaluate(() => window.__hostState.saves.length + 1);
      await page.keyboard.down("Meta");
      await page.keyboard.down("Shift");
      await page.keyboard.press("z");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Meta");
      await viewer.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 0, { timeout: 10_000 });
      await waitForSaveCount(redoSaveCount);
      await viewer.waitForFunction((uuid) => window.parent.__hostState?.operations?.get(uuid)?.deleted === true,
        { timeout: 15_000 }, savedFreeTextId);
      const afterRedo = await snapshot("after-trusted-meta-shift-z", originalVisualRoi.targetRect);
      assert.ok(
        !afterRedo.editorVisual || afterRedo.editorVisual.hidden ||
          afterRedo.editorVisual.display === "none" || afterRedo.editorVisual.visibility === "hidden" ||
          afterRedo.editorVisual.rect.width === 0,
        "Redo must hide the restored sidecar FreeText editor again",
      );
      assert.equal(
        afterRedo.visualRoi.fingerprint,
        erasedVisualRoi.fingerprint,
        "Redo must restore the same erased FreeText screenshot ROI pixels",
      );
      assert.equal(afterRedo.host.saves.length, redoSaveCount,
        "Redo must persist exactly one sidecar revision");
      assert.ok(afterRedo.visualRoi.differentPixels > 0,
        "Redo must remove visible FreeText pixels from the screenshot ROI");

      const secondUndoSaveCount = await page.evaluate(() => window.__hostState.saves.length + 1);
      await page.keyboard.down("Meta");
      await page.keyboard.press("z");
      await page.keyboard.up("Meta");
      await viewer.waitForFunction((targetRect) => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        return [...(manager?.getEditors(0) || [])].some((editor) =>
          editor.deleted === false && editor.editorType === "freetext" &&
          (editor.serialize?.()?.value?.includes("UndoVisibilityProof") ||
            editor.div?.textContent?.includes("UndoVisibilityProof")),
        );
      }, { timeout: 15_000 }, originalVisualRoi.targetRect);
      await waitForSaveCount(secondUndoSaveCount);
      await viewer.waitForFunction((uuid) => window.parent.__hostState?.operations?.get(uuid)?.deleted !== true,
        { timeout: 15_000 }, savedFreeTextId);
      const afterSecondUndo = await snapshot("after-second-meta-z", originalVisualRoi.targetRect);
      assert.ok(afterSecondUndo.editorVisual?.rect?.width > 0, "A second undo must remain usable after redo");
      assert.equal(afterSecondUndo.mode, 0, "A second undo must remain in NONE mode");
      assert.equal(sidecarOperationFor(afterSecondUndo, savedFreeTextId)?.deleted, false,
        "A second undo must restore the same sidecar UUID");
      assert.ok(afterSecondUndo.visualRoi.differentPixels === 0,
        "A second undo must restore the original visible FreeText screenshot ROI");
      assert.equal(
        afterSecondUndo.visualRoi.fingerprint,
        originalVisualRoi.fingerprint,
        "A second undo must restore the original sidecar screenshot pixels",
      );

      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
      const reopenedCount = await page.evaluate(() => window.__hostState.opened + 1);
      await page.evaluate(() => window.__sendOpenSaved());
      await waitForOpenCount(reopenedCount);
      await waitForPageReady();
      const afterFinalReopen = await snapshot(
        "reopened-restored-free-text",
        originalVisualRoi.targetRect,
      );
      assert.ok(
        afterFinalReopen.editorVisual?.rect?.width > 0 &&
          afterFinalReopen.editorVisual?.text.includes("UndoVisibilityProof"),
        "Saved/restored sidecar FreeText must remain visible with its text after a full save/reopen",
      );
      assert.equal(sidecarOperationFor(afterFinalReopen, savedFreeTextId)?.deleted, false,
        "The final reopen must hydrate the restored durable sidecar operation");
      assert.equal(afterFinalReopen.mode, 0, "The final reopen must retain NONE mode");
      assert.equal(afterFinalReopen.host.opens.at(-1).byteLength, afterFinalReopen.host.opens[0].byteLength,
        "The final reopen still uses the byte-identical immutable source PDF");
      assert.equal(
        afterFinalReopen.visualRoi.fingerprint,
        originalVisualRoi.fingerprint,
        "The restored FreeText sidecar renderer must retain the same screenshot pixels after save/reopen",
      );
      assert.equal(afterFinalReopen.visualRoi.differentPixels, 0,
        "The final reopened sidecar screenshot ROI must match its original pixels");
      evidence.push({
        stage: "pass",
        afterUndo,
        afterRedo,
        afterSecondUndo,
        afterFinalReopen,
      });
      assert.deepEqual(externalRequests, [], "The PDF fixture must not request external origins");
      await persistEvidence();
      const finalScreenshotOptions = {
        path: path.join(artifactsPath, artifactBase + ".png"),
        fullPage: false,
        captureBeyondViewport: false,
      };
      await markFreeTextTrace("test.screenshot.before-final", finalScreenshotOptions);
      await page.screenshot(finalScreenshotOptions);
      await markFreeTextTrace("test.screenshot.after-final", finalScreenshotOptions);
      await persistEvidence();
      t.diagnostic("Evidence: " + path.join(artifactsPath, artifactBase + ".partial.json"));
    } catch (error) {
      evidence.push({ stage: "failure", message: error.message, stack: error.stack });
      await persistEvidence().catch(() => {});
      if (page && !page.isClosed()) {
        const failureScreenshotOptions = {
          path: path.join(artifactsPath, artifactBase + ".png"),
          fullPage: false,
          captureBeyondViewport: false,
        };
        await markFreeTextTrace("test.screenshot.before-failure", failureScreenshotOptions);
        await page.screenshot(failureScreenshotOptions).catch(() => {});
        await markFreeTextTrace("test.screenshot.after-failure", failureScreenshotOptions);
        await persistEvidence().catch(() => {});
      }
      primaryError = error;
    } finally {
      if (page && !page.isClosed()) {
        await page.evaluate(() => {
          const frame = document.querySelector('iframe[name="pdf-reader"]');
          frame?.contentWindow?.__freeTextCommitDiagnostic?.dispose?.();
        }).catch(() => {});
      }
      cleanupReport = await cleanupBrowserTestResources({
        browser,
        browserObserver: browserStderrObserver,
        ownedPages: [page],
        prepareOwnedPageClose: pdfTeardownDiagnosticsEnabled
          ? prepareFixturePdfViewerClose
          : undefined,
        server,
        onBrowserCloseStart,
      });
      t.diagnostic(
        `PDF.js pre-close teardown diagnostic: ${pdfTeardownDiagnosticsEnabled ? "enabled" : "disabled"}`,
      );
      if (teardownDiagnosticsEnabled) {
        if (diagnosticSampleTimer) {
          clearTimeout(diagnosticSampleTimer);
          diagnosticSampleTimer = null;
          diagnosticSampleResult ??= {
            state: "skipped",
            reason: `Cleanup completed before the configured ${chromeSampleDelayMs} ms sample point`,
            sampleDelayMs: chromeSampleDelayMs,
          };
        }
        if (diagnosticSamplePromise) await diagnosticSamplePromise;
        const child = browser?.process?.() || null;
        if (child && diagnosticChildExitListener) {
          child.removeListener("exit", diagnosticChildExitListener);
        }
        diagnosticTargetsAfterClose = snapshotBrowserTargets(browser);
        const diagnostics = {
          enabled: true,
          launchProfile: diagnosticProfileDirectory ? path.basename(diagnosticProfileDirectory) : null,
          launchIdentityValidated: Boolean(browserIdentity?.available),
          launchIdentityReason: browserIdentity?.reason || null,
          browserEvents: diagnosticBrowserEvents,
          targetsAfterClose: diagnosticTargetsAfterClose,
          sampleDelayMs: chromeSampleDelayMs,
          sample: diagnosticSampleResult || { state: "not-scheduled" },
          stderr: browserStderrObserver?.snapshot() || null,
        };
        const closeTimings = cleanupReport.browser?.timings;
        if (closeTimings?.browserCloseSettledAt) {
          diagnosticBrowserEvents.push({
            event: "browser.close.response",
            at: closeTimings.browserCloseSettledAt,
          });
        }
        if (closeTimings?.cdpDisconnectedAt) {
          diagnosticBrowserEvents.push({
            event: "cdp.disconnected",
            at: closeTimings.cdpDisconnectedAt,
          });
        }
        if (closeTimings?.processExitAt) {
          diagnosticBrowserEvents.push({
            event: "browser.process.exit",
            at: closeTimings.processExitAt,
          });
        }
        if (diagnostics.stderr?.teardownWatchdogAt) {
          diagnosticBrowserEvents.push({
            event: "chromium.teardown-watchdog.stderr",
            at: diagnostics.stderr.teardownWatchdogAt,
          });
        }
        diagnosticBrowserEvents.sort((left, right) => left.at - right.at);
        diagnostics.browserEvents = diagnosticBrowserEvents;
        if (cleanupReport.browser) cleanupReport.browser.diagnostics = diagnostics;
        const childExitCode = child?.exitCode ?? null;
        const ownedCrashpadDirectory = getTestBrowserLaunchMetadata(browser)?.crashpadDirectory;
        if (ownedCrashpadDirectory && childExitCode === 2) {
          try {
            diagnostics.crashpad = await collectOwnedCrashpadMetadata(ownedCrashpadDirectory);
          } catch (error) {
            diagnostics.crashpad = {
              copied: [],
              phaseHints: [],
              error: error?.message || String(error),
            };
          }
        }
        if (diagnosticProfileDirectory) {
          const childExited = Boolean(
            child && (typeof child.exitCode === "number" || typeof child.signalCode === "string"),
          );
          if (childExited) {
            try {
              await rm(diagnosticProfileDirectory, { recursive: true, force: true });
              diagnostics.profileCleanup = { removed: true };
            } catch (error) {
              diagnostics.profileCleanup = { removed: false, error: error?.message || String(error) };
            }
          } else {
            diagnostics.profileCleanup = {
              removed: false,
              reason: "The test-owned browser process was still live; its profile was left in place",
            };
          }
        }
      }
      try {
        await writeFile(
          path.join(artifactsPath, artifactBase + ".cleanup.json"),
          JSON.stringify(cleanupReport, null, 2),
          "utf8",
        );
      } catch (error) {
        cleanupReport.errors.push({
          phase: "cleanup-report.write",
          name: error?.name || "Error",
          message: error?.message || String(error),
          stack: error?.stack || null,
        });
      }
      t.diagnostic("Cleanup report: " + path.join(artifactsPath, artifactBase + ".cleanup.json"));
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) throw finalError;
  },
);
