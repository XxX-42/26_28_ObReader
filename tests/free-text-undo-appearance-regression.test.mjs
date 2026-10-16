import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
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

const browserPath = resolveBrowserPath();
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifactsPath = path.join(root, "tests", "artifacts");
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
  "saved sidecar FreeText stays visible across NONE-mode right-eraser undo and redo",
  { skip: !browserPath && "Chrome or Edge is required for this browser regression", timeout: 120_000 },
  async (t) => {
    await mkdir(artifactsPath, { recursive: true });
    const sourcePdfBefore = {
      sha256: createHash("sha256").update(await readFile(fixturePath)).digest("hex"),
      mtimeMs: (await stat(fixturePath)).mtimeMs,
    };
    const viewerPath = path.join(root, "vendor", "pdfjs-generic-legacy", "web", "viewer.html");
    const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
    const viewerHtml = await readFile(viewerPath, "utf8");
    const bridgeSource = await readFile(bridgePath, "utf8");
    const instrumentedBridgeSource = bridgeSource.replace(
      "  if (iosInputPolicy) {",
      "  window.__freeTextUndoBridgeState = state;\n  if (iosInputPolicy) {",
    );
    assert.notEqual(instrumentedBridgeSource, bridgeSource,
      "The browser regression should expose the private UUID binding map only for diagnostics");
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
            browserSidecarHarnessScript({ channel, token }) + '<script>' +
            'const channel=' +
            JSON.stringify(channel) +
            ',token=' +
            JSON.stringify(token) +
            ',documentId=' +
            JSON.stringify(documentId) +
            ';' +
            'const iframe=document.querySelector("iframe");' +
            'const state=window.__hostState={teardownDiagnosticToken:' +
            JSON.stringify(token) +
            ',documentId:' +
            JSON.stringify(documentId) +
            ',ready:false,opened:0,openRequest:0,saves:[],heldSaves:[],holdNextSaveAck:false,recoveries:[],errors:[],opens:[]};' +
            'let fixtureBytes=null;' +
            'const sendOpen=(data,label)=>{' +
            'state.openRequest+=1;state.opens.push({label,openRequest:state.openRequest,byteLength:data.byteLength});' +
            'iframe.contentWindow.postMessage({channel,type:"open",token,documentId,documentPath:documentId,filename:documentId,autoSave:true,openRequest:state.openRequest,data},"*",[data]);};' +
            'window.__sendOpenSaved=()=>sendOpen(fixtureBytes.slice(0),"source-reopen");' +
            'window.__holdNextSaveAck=()=>{state.holdNextSaveAck=true;};' +
            'window.__releaseHeldSaveAcks=()=>{for(const save of state.heldSaves.splice(0).reverse()){iframe.contentWindow.postMessage(save.acknowledgement,"*");}};' +
            'window.__sendFlush=(id)=>iframe.contentWindow.postMessage({channel,type:"flush",token,id},"*");' +
            'window.addEventListener("message",event=>{' +
            'if(event.source!==iframe.contentWindow)return;const message=event.data;' +
            'if(!message||message.channel!==channel||message.token!==token)return;' +
            'if(message.type==="ready"){state.ready=true;if(fixtureBytes)sendOpen(fixtureBytes.slice(0),"fixture");}' +
            'else if(message.type==="opened"){state.opened+=1;state.openedMessages ||= [];state.openedMessages.push({documentId:message.documentId,openRequest:message.openRequest,revision:message.revision,dirty:message.dirty});}' +
            'else if(message.type==="save"||message.type==="recover"){const operations=Array.isArray(message.operations)?message.operations:[];for(const operation of operations){if(operation.kind==="FreeText")state.freeTextUuid=operation.uuid;}const acknowledgement={channel,type:message.type==="recover"?"recovered":"saved",token,documentId:message.documentId,requestId:message.requestId,openRequest:message.openRequest,revision:message.revision,external:true,operationCount:operations.length};if(operations.length>0)acknowledgement.batchId="free-text-undo-"+message.requestId;const record={documentId:message.documentId,requestId:message.requestId,revision:message.revision,origin:message.origin,operationCount:operations.length,operations:structuredClone(operations),acknowledgement,receivedAt:performance.now()};if(message.type==="recover"){record.reason=message.reason;state.recoveries.push(record);}else{state.saves.push(record);}if(state.holdNextSaveAck){state.holdNextSaveAck=false;state.heldSaves.push(record);}else{iframe.contentWindow.postMessage(acknowledgement,"*");}}' +
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
        response.end(instrumentedBridgeSource);
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
      browser = await launchTestBrowser(puppeteer, launchOptions, { testName: "free-text-undo-appearance-regression" });
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
      const waitForCanvasChangeFromBaseline = async (roi) =>
        viewer.waitForFunction(
          (targetRect) => {
            const pageView = PDFViewerApplication.pdfViewer?.getPageView(0);
            const sample = window.__samplePageCanvasRoi(targetRect);
            return pageView?.renderingState === 3 &&
              Number.isFinite(sample?.differentPixels) &&
              sample.differentPixels > 0;
          },
          { timeout: 15_000 },
          roi,
        );
      const waitForCanvasRestoreBaseline = async (roi) =>
        viewer.waitForFunction(
          (targetRect) => {
            const pageView = PDFViewerApplication.pdfViewer?.getPageView(0);
            const sample = window.__samplePageCanvasRoi(targetRect);
            return pageView?.renderingState === 3 &&
              sample?.differentPixels === 0 &&
              sample?.fingerprint === sample?.baselineFingerprint;
          },
          { timeout: 15_000 },
          roi,
        );
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
      await viewer.evaluate(() => {
        window.__pageCanvasRoiBaselines = new Map();
        window.__samplePageCanvasRoi = (requestedRect, captureBaseline = false) => {
          const page = document.querySelector('.page[data-page-number="1"]');
          const section = [...(page?.querySelectorAll(".annotationLayer .freeTextAnnotation") || [])]
            .find((node) => node.textContent.includes("UndoVisibilityProof"));
          const targetRect = requestedRect || (() => {
            const rect = section?.getBoundingClientRect();
            return rect
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null;
          })();
          const canvasWrapper = page?.querySelector(".canvasWrapper");
          const canvas = [...(canvasWrapper?.querySelectorAll("canvas:not(.detailView)") || [])]
            .sort((left, right) => right.width * right.height - left.width * left.height)[0];
          if (!targetRect || !canvas || !canvas.width || !canvas.height) {
            return { targetRect, canvasFound: !!canvas, nonWhitePixels: null };
          }
          const rect = canvas.getBoundingClientRect();
          if (!rect.width || !rect.height) {
            return { targetRect, canvasFound: true, nonWhitePixels: null };
          }
          const scaleX = canvas.width / rect.width;
          const scaleY = canvas.height / rect.height;
          const bounds = {
            left: Math.max(0, Math.floor((targetRect.x - rect.x) * scaleX)),
            top: Math.max(0, Math.floor((targetRect.y - rect.y) * scaleY)),
            right: Math.min(canvas.width, Math.ceil((targetRect.x + targetRect.width - rect.x) * scaleX)),
            bottom: Math.min(canvas.height, Math.ceil((targetRect.y + targetRect.height - rect.y) * scaleY)),
          };
          if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
            return {
              targetRect,
              canvasFound: true,
              canvasSize: { width: canvas.width, height: canvas.height },
              canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              bounds,
              nonWhitePixels: null,
            };
          }
          const sampleWidth = bounds.right - bounds.left;
          const sampleHeight = bounds.bottom - bounds.top;
          let pixels;
          try {
            pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(
              bounds.left,
              bounds.top,
              sampleWidth,
              sampleHeight,
            ).data;
          } catch (error) {
            return {
              targetRect,
              canvasFound: true,
              bounds,
              readError: error.message,
              nonWhitePixels: null,
            };
          }
          let nonWhitePixels = 0;
          let darkPixels = 0;
          let hash = 2166136261;
          const baselineKey = JSON.stringify({
            x: targetRect.x,
            y: targetRect.y,
            width: targetRect.width,
            height: targetRect.height,
            sampleWidth,
            sampleHeight,
          });
          if (captureBaseline) {
            window.__pageCanvasRoiBaselines.set(baselineKey, new Uint8ClampedArray(pixels));
          }
          const baseline = window.__pageCanvasRoiBaselines.get(baselineKey);
          let differentPixels = baseline?.length === pixels.length ? 0 : null;
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index];
            const green = pixels[index + 1];
            const blue = pixels[index + 2];
            const alpha = pixels[index + 3];
            if (alpha > 0 && (red < 248 || green < 248 || blue < 248)) {
              nonWhitePixels += 1;
            }
            if (alpha > 0 && red + green + blue < 600) {
              darkPixels += 1;
            }
            for (let channel = 0; channel < 4; channel += 1) {
              hash = Math.imul(hash ^ pixels[index + channel], 16777619) >>> 0;
            }
            if (
              baseline &&
              (pixels[index] !== baseline[index] ||
                pixels[index + 1] !== baseline[index + 1] ||
                pixels[index + 2] !== baseline[index + 2] ||
                pixels[index + 3] !== baseline[index + 3])
            ) {
              differentPixels += 1;
            }
          }
          let baselineFingerprint = null;
          if (baseline) {
            let baselineHash = 2166136261;
            for (const channel of baseline) {
              baselineHash = Math.imul(baselineHash ^ channel, 16777619) >>> 0;
            }
            baselineFingerprint = baselineHash.toString(16).padStart(8, "0");
          }
          return {
            targetRect,
            canvasFound: true,
            canvasSize: { width: canvas.width, height: canvas.height },
            canvasRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            bounds,
            pixelCount: pixels.length / 4,
            nonWhitePixels,
            darkPixels,
            fingerprint: hash.toString(16).padStart(8, "0"),
            baselineFingerprint,
            differentPixels,
          };
        };
      });
      const snapshot = async (label, canvasRoi = null) => {
        const state = await viewer.evaluate(({ label: labelValue, canvasRoi: roiValue }) => {
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
            uid: entry.uid,
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
                display: getComputedStyle(node).display,
                visibility: getComputedStyle(node).visibility,
                opacity: getComputedStyle(node).opacity,
                rect: (() => {
                  const rect = node.getBoundingClientRect();
                  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                })(),
              })),
            } : null,
            editor: editor ? {
              id: editor.id,
              uid: editor.uid,
              uuid: window.__freeTextUndoBridgeState?.annotationUuidByRuntimeId.get(String(editor.id)) || null,
              annotationElementId: editor.annotationElementId,
              deleted: editor.deleted,
              type: editor.editorType,
              serialized: editor.serialize?.() || null,
              divConnected: !!editor.div?.isConnected,
              className: editor.div?.className || null,
              display: editor.div ? getComputedStyle(editor.div).display : null,
              visibility: editor.div ? getComputedStyle(editor.div).visibility : null,
              opacity: editor.div ? getComputedStyle(editor.div).opacity : null,
              rect: editor.div ? (() => { const rect = editor.div.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() : null,
            } : null,
            sidecarRow: window.parent.__browserSidecarHost?.operationsFor(
              window.parent.__hostState.documentId,
            ).find((row) => row.uuid === window.parent.__hostState.freeTextUuid) || null,
            rawValues,
            canvasRoi: window.__samplePageCanvasRoi(
              roiValue,
              labelValue === "reopened-original",
            ),
            trustedUndo: window.__trustedKeys?.filter((event) => /z/i.test(event.key)).slice(-3) || [],
          };
        }, { label, canvasRoi });
        const host = await page.evaluate(() => ({
          saves: (window.__hostState?.saves || []).map(({ documentId, revision, origin, operationCount, operations }) => ({ documentId, revision, origin, operationCount, operations })),
          opened: window.__hostState?.opened,
          opens: window.__hostState?.opens,
          errors: window.__hostState?.errors,
          recoveries: (window.__hostState?.recoveries || []).map(({ documentId, revision, reason, operationCount, operations }) => ({ documentId, revision, reason, operationCount, operations })),
        }));
        const result = { ...state, host };
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
      const compositeClip = {
        x: Math.max(0, Math.floor(createPoint.x - 8)),
        y: Math.max(0, Math.floor(createPoint.y - 8)),
        width: Math.min(240, page.viewport().width - Math.max(0, Math.floor(createPoint.x - 8))),
        height: Math.min(120, page.viewport().height - Math.max(0, Math.floor(createPoint.y - 8))),
      };
      assert.ok(compositeClip.width > 0 && compositeClip.height > 0);
      const compositeHash = async () => {
        await page.mouse.move(10, 10);
        const png = await page.screenshot({ type: "png", clip: compositeClip });
        return { sha256: createHash("sha256").update(png).digest("hex"), bytes: png.length };
      };
      const compositeBeforeCreate = await compositeHash();
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
      const noneButtonRect = await viewer.$eval("#editorFreeTextButton", (button) => {
        const rect = button.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      const modeEventCountBeforeNoneClick = await viewer.evaluate(
        () => window.__modeEvents.length,
      );
      await page.mouse.click(
        iframeRect.x + noneButtonRect.x + noneButtonRect.width / 2,
        iframeRect.y + noneButtonRect.y + noneButtonRect.height / 2,
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
      const originalCompositeRoi = await compositeHash();
      assert.ok(afterReopen.editor, "Reopened sidecar FreeText must hydrate into a PDF.js editor");
      assert.equal(afterReopen.editor.type, "freetext");
      assert.equal(afterReopen.editor.deleted, false);
      assert.ok(afterReopen.editor.rect.width > 0 && afterReopen.editor.rect.height > 0);
      assert.notEqual(
        originalCompositeRoi.sha256,
        compositeBeforeCreate.sha256,
        "The final iframe composite ROI must contain visible sidecar FreeText pixels",
      );
      const reopenedAnnotation = {
        id: afterReopen.sidecarRow?.uuid,
        uuid: afterReopen.editor.uuid,
        value: afterReopen.editor.serialized?.value,
      };
      evidence.push({ stage: "saved-sidecar-data", annotation: reopenedAnnotation, composite: originalCompositeRoi });
      await persistEvidence();
      assert.ok(reopenedAnnotation.id, "Saved FreeText must have a durable sidecar UUID");
      assert.equal(reopenedAnnotation.uuid, reopenedAnnotation.id, "Hydrated FreeText editor runtime ID must retain its sidecar UUID binding");
      assert.ok(reopenedAnnotation.value?.includes("UndoVisibilityProof"));
      const eraseRect = afterReopen.editor.rect;
      assert.ok(eraseRect.width > 0 && eraseRect.height > 0, "Expected a positive sidecar FreeText editor rect");
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
      const eraserMode = await viewer.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode);
      assert.equal(eraserMode, 0, "Temporary eraser must restore NONE mode");
      const eraseSaveCount = await page.evaluate(() => window.__hostState.saves.length + 1);
      await waitForSaveCount(eraseSaveCount);
      const heldEraseSave = await page.evaluate(() => ({
        held: window.__hostState.heldSaves.length,
        save: window.__hostState.saves.at(-1)
          ? { revision: window.__hostState.saves.at(-1).revision, origin: window.__hostState.saves.at(-1).origin }
          : null,
      }));
      evidence.push({ stage: "erase-save-held", ...heldEraseSave });
      assert.equal(heldEraseSave.held, 1, "The eraser save must remain unacknowledged for the undo boundary case");
      const afterErase = await snapshot("after-right-erase-save-held");
      const erasedCompositeRoi = await compositeHash();
      assert.equal(afterErase.sidecarRow?.uuid, reopenedAnnotation.id);
      assert.equal(afterErase.sidecarRow?.deleted, true,
        "Right-drag must durably serialize a sidecar FreeText tombstone");
      assert.ok(
        afterErase.editor?.deleted === true || afterErase.sidecarRow?.deleted === true,
        "Right-drag must remove the hydrated sidecar FreeText from the visible editor state",
      );
      assert.ok(
        erasedCompositeRoi.sha256 !== originalCompositeRoi.sha256,
        "Right eraser must change the final viewer composite where the sidecar FreeText was visible",
      );
      evidence.push({ stage: "erased-composite-roi", composite: erasedCompositeRoi });
      await persistEvidence();

      await page.keyboard.down("Meta");
      await page.keyboard.press("z");
      await page.keyboard.up("Meta");
      await viewer.waitForFunction((uuid) => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        return [...(manager?.getEditors(0) || [])].some((editor) =>
          window.__freeTextUndoBridgeState?.annotationUuidByRuntimeId.get(String(editor.id)) === uuid &&
          editor.deleted === false && editor.editorType === "freetext" &&
          editor.div?.isConnected && editor.div.textContent?.includes("UndoVisibilityProof") &&
          getComputedStyle(editor.div).display !== "none" &&
          getComputedStyle(editor.div).visibility !== "hidden" &&
          editor.div.getBoundingClientRect().width > 0 &&
          editor.div.getBoundingClientRect().height > 0,
        );
      }, { timeout: 10_000 }, reopenedAnnotation.id);
      const undoWhileSavesHeld = await snapshot("undo-while-save-acks-held");
      const undoCompositeRoi = await compositeHash();
      assert.ok(undoWhileSavesHeld.trustedUndo?.at(-1)?.metaKey);
      assert.equal(undoWhileSavesHeld.mode, 0);
      assert.equal(undoWhileSavesHeld.editor?.uuid, reopenedAnnotation.id);
      assert.equal(undoWhileSavesHeld.editor?.deleted, false);
      assert.ok(undoWhileSavesHeld.editor?.rect?.width > 0 && undoWhileSavesHeld.editor?.rect?.height > 0);
      assert.equal(undoWhileSavesHeld.editor?.display, "block");
      assert.notEqual(undoCompositeRoi.sha256, erasedCompositeRoi.sha256);
      const heldAckState = await page.evaluate(() => ({
        saves: window.__hostState.saves.length,
        held: window.__hostState.heldSaves.length,
        dirty: document.querySelector("iframe").contentWindow.PDFViewerApplication._hasChanges(),
      }));
      assert.equal(heldAckState.held, 1, "Only the in-flight delete batch should be held before its durable ACK");
      assert.equal(heldAckState.saves, eraseSaveCount, "Undo must queue behind, not overlap, the in-flight sidecar save");
      assert.equal(heldAckState.dirty, true, "Undo during an in-flight delete must remain dirty until its compensating operation is durable");
      await page.evaluate(() => window.__releaseHeldSaveAcks());
      await waitForSaveCount(eraseSaveCount + 1);
      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
      const afterUndo = await snapshot("after-undo-and-exact-acks");
      const afterUndoComposite = await compositeHash();
      assert.equal(afterUndo.mode, 0);
      assert.equal(afterUndo.editor?.uuid, reopenedAnnotation.id);
      assert.equal(afterUndo.editor?.deleted, false);
      assert.ok(afterUndo.editor?.serialized?.value?.includes("UndoVisibilityProof"));
      assert.equal(afterUndoComposite.sha256, originalCompositeRoi.sha256);
      assert.ok(afterUndo.sidecarRow && afterUndo.sidecarRow.deleted !== true);

      await page.keyboard.down("Meta");
      await page.keyboard.down("Shift");
      await page.keyboard.press("z");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Meta");
      await viewer.waitForFunction((uuid) => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const editor = [...(manager?.getEditors(0) || [])].find((candidate) =>
          window.__freeTextUndoBridgeState?.annotationUuidByRuntimeId.get(String(candidate.id)) === uuid,
        );
        return PDFViewerApplication.pdfViewer.annotationEditorMode === 0 &&
          (editor?.deleted === true || editor?.div?.isConnected !== true);
      }, { timeout: 10_000 }, reopenedAnnotation.id);
      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
      const afterRedo = await snapshot("after-redo");
      const redoCompositeRoi = await compositeHash();
      assert.ok(afterRedo.sidecarRow?.deleted === true);
      assert.notEqual(redoCompositeRoi.sha256, originalCompositeRoi.sha256);

      await page.keyboard.down("Meta");
      await page.keyboard.press("z");
      await page.keyboard.up("Meta");
      await viewer.waitForFunction((uuid) => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        const editor = [...(manager?.getEditors(0) || [])].find((candidate) =>
          window.__freeTextUndoBridgeState?.annotationUuidByRuntimeId.get(String(candidate.id)) === uuid,
        );
        return editor?.deleted === false && editor?.div?.textContent?.includes("UndoVisibilityProof");
      }, { timeout: 10_000 }, reopenedAnnotation.id);
      await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 30_000 });
      const afterSecondUndo = await snapshot("after-second-undo");
      const secondUndoComposite = await compositeHash();
      assert.equal(afterSecondUndo.editor?.uuid, reopenedAnnotation.id);
      assert.equal(afterSecondUndo.editor?.deleted, false);
      assert.equal(secondUndoComposite.sha256, originalCompositeRoi.sha256);

      const reopenedCount = await page.evaluate(() => window.__hostState.opened + 1);
      await page.evaluate(() => window.__sendOpenSaved());
      await waitForOpenCount(reopenedCount);
      await waitForPageReady();
      await viewer.waitForFunction((uuid) => {
        const manager = PDFViewerApplication.pdfViewer?._layerProperties?.annotationEditorUIManager;
        return [...(manager?.getEditors(0) || [])].some((editor) =>
          window.__freeTextUndoBridgeState?.annotationUuidByRuntimeId.get(String(editor.id)) === uuid &&
          editor.editorType === "freetext" && !editor.deleted &&
          editor.div?.textContent?.includes("UndoVisibilityProof"),
        );
      }, { timeout: 15_000 }, reopenedAnnotation.id);
      const afterFinalReopen = await snapshot("reopened-restored-free-text");
      const finalCompositeRoi = await compositeHash();
      const sourcePdfAfter = {
        sha256: createHash("sha256").update(await readFile(fixturePath)).digest("hex"),
        mtimeMs: (await stat(fixturePath)).mtimeMs,
      };
      assert.equal(afterFinalReopen.sidecarRow?.uuid, reopenedAnnotation.id);
      assert.equal(afterFinalReopen.sidecarRow?.deleted, false);
      assert.equal(afterFinalReopen.editor?.uuid, reopenedAnnotation.id);
      assert.equal(afterFinalReopen.editor?.serialized?.value, "UndoVisibilityProof");
      assert.ok(afterFinalReopen.editor.rect.width > 0 && afterFinalReopen.editor.rect.height > 0);
      assert.equal(afterFinalReopen.editor.display, "block");
      assert.equal(afterFinalReopen.editor.visibility, "visible");
      assert.notEqual(finalCompositeRoi.sha256, compositeBeforeCreate.sha256);
      assert.equal(sourcePdfAfter.sha256, sourcePdfBefore.sha256, "Ordinary sidecar edits must not change source PDF bytes");
      assert.equal(sourcePdfAfter.mtimeMs, sourcePdfBefore.mtimeMs, "Ordinary sidecar edits must not touch source PDF mtime");
      const sourcePdfAnnotation = await viewer.evaluate(async () => {
        const page = await PDFViewerApplication.pdfDocument.getPage(1);
        return (await page.getAnnotations()).some((entry) =>
          entry.subtype === "FreeText" &&
          (entry.contents?.includes("UndoVisibilityProof") || entry.contentsObj?.str?.includes("UndoVisibilityProof")),
        );
      });
      assert.equal(sourcePdfAnnotation, false, "Ordinary sidecar saves must not write FreeText into the source PDF");
      evidence.push({
        stage: "pass",
        originalCompositeRoi,
        erasedCompositeRoi,
        undoCompositeRoi,
        redoCompositeRoi,
        secondUndoComposite,
        finalCompositeRoi,
        afterUndo,
        afterRedo,
        afterSecondUndo,
        afterFinalReopen,
        sourcePdf: { before: sourcePdfBefore, after: sourcePdfAfter },
      });
      assert.deepEqual(externalRequests, [], "The PDF fixture must not request external origins");
      await persistEvidence();
      await page.screenshot({ path: path.join(artifactsPath, artifactBase + ".png"), fullPage: false });
      t.diagnostic("Evidence: " + path.join(artifactsPath, artifactBase + ".partial.json"));
    } catch (error) {
      evidence.push({ stage: "failure", message: error.message, stack: error.stack });
      await persistEvidence().catch(() => {});
      if (page && !page.isClosed()) {
        await page.screenshot({ path: path.join(artifactsPath, artifactBase + ".png"), fullPage: false }).catch(() => {});
      }
      primaryError = error;
    } finally {
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
