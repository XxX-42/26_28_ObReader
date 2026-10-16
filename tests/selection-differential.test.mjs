import assert from "node:assert/strict";
import { teardownViewerPage } from "./browser-viewer-teardown.mjs";
import { randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { installNativeSelectionProbe } from "./native-selection-probe.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const browserPath = resolveBrowserPath();
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const viewerHtmlPath = path.join(vendorRoot, "web", "viewer.html");
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const artifacts = path.join(root, "tests", "artifacts");
const channel = "pdf-web-reader";
const token = `selection-differential-${Date.now()}-${process.pid}`;
const rendererGeneration = `selection-differential-generation-${Date.now()}`;
const documentId = "tests/fixtures/tracemonkey.pdf";
const scenarioDocumentId = (condition) => `${documentId}#${condition}`;
const scenarioRendererGeneration = (condition) => `${rendererGeneration}-${condition}`;
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"], [".svg", "image/svg+xml"], [".wasm", "application/wasm"],
]);

async function listenOnSafeLoopbackPort(server) {
  const firstPort = 49_152 + randomInt(16_384);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = 49_152 + ((firstPort - 49_152 + attempt) % 16_384);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return server.address().port;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error("Could not bind the selection differential server to an unused safe loopback port.");
}

test("selection differential U0/U1/U2 and same-document viewer teardown", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 180_000,
}, async (t) => {
  await mkdir(artifacts, { recursive: true });
  const viewerHtml = await readFile(viewerHtmlPath, "utf8");
  const bridgeSource = await readBridgeRuntimeSource(bridgePath);
  const noHydrationBridgeSource = bridgeSource.replace(
    "  async function hydrateExternalAnnotationsForPage(pageIndex) {",
    "  async function hydrateExternalAnnotationsForPage(pageIndex) {\n    return true; // Selection test U1: preserve identity/read-only flow, skip editor hydration.",
  );
  assert.notEqual(noHydrationBridgeSource, bridgeSource,
    "The U1 test-only bridge must disable only annotation editor hydration");
  const sidecarScript = browserSidecarHarnessScript({ channel, token });
  const trace = {
    schemaVersion: 1,
    fixture: "tests/fixtures/tracemonkey.pdf",
    observedAt: new Date().toISOString(),
    definition: {
      U0: "frozen vendor viewer, bridge script absent, fixture opened by viewer URL",
      U1: "test-only bridge skips external editor hydration, while host open and source identity confirmation remain enabled",
      U2: "full bridge host-open, identity-confirmed empty sidecar baseline, trusted mode-10 drag and overlapping local annotation",
      issue22129: "separate test phase: same iframe Document, two PDFViewer instances, separate AbortSignals, first signal aborted while second layer survives",
    },
    scenarios: [],
    privacy: "Selection strings are not captured. Only text lengths, range offsets, targets, and rectangles are stored.",
  };
  const artifactPath = path.join(artifacts, `selection-differential-${Date.now()}-${process.pid}.json`);
  let browser;
  let page;
  let server;
  let primaryError = null;
  let cleanupReport = null;

  server = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(withTestNetworkFirewall())) response.setHeader(name, value);
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      const condition = ["U0", "U1", "U2"].includes(url.searchParams.get("condition"))
        ? url.searchParams.get("condition")
        : "U0";
      const viewerUrl = condition === "U0"
        ? `/viewer/web/viewer.html?condition=U0&file=${encodeURIComponent(`http://${request.headers.host}/tests/fixtures/tracemonkey.pdf`)}`
        : `/viewer/web/viewer.html?condition=${condition}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="PDF selection differential" src="${viewerUrl}"></iframe>${sidecarScript}<script>
          (()=>{
            const channel=${JSON.stringify(channel)}, token=${JSON.stringify(token)}, documentIdBase=${JSON.stringify(documentId)}, rendererGenerationBase=${JSON.stringify(rendererGeneration)};
            const iframe=document.querySelector('iframe');
            const trace=window.__selectionParentTrace={condition:${JSON.stringify(condition)},ready:[],opened:[],identity:[],errors:[],openSent:false};
            window.addEventListener('message',event=>{
              if(event.source!==iframe.contentWindow||!event.data||event.data.channel!==channel||event.data.token!==token)return;
              const message=event.data;
              if(message.type==='ready'){
                trace.ready.push({at:performance.now(),rendererGeneration:message.rendererGeneration||null});
                const condition=trace.condition;
                if(!['U1','U2'].includes(condition)||trace.openSent||message.rendererGeneration!==rendererGenerationBase+'-'+condition)return;
                trace.openSent=true;
                fetch('/tests/fixtures/tracemonkey.pdf').then(response=>{
                  if(!response.ok)throw new Error('fixture fetch failed');
                  return response.arrayBuffer();
                }).then(source=>{
                  const data=source.slice(0);
                  const activeDocumentId=documentIdBase+'#'+condition;
                  const openRequest=condition==='U1'?1:2;
                  iframe.contentWindow.postMessage({channel,type:'open',token,rendererGeneration:rendererGenerationBase+'-'+condition,
                    documentId:activeDocumentId,documentPath:activeDocumentId,filename:'tracemonkey.pdf',openRequest,
                    data,autoSave:false,readOnly:false,revision:0,confirmedRevision:0,
                    restoreDirty:false,restorePaused:false},'*',[data]);
                }).catch(error=>trace.errors.push({code:'host-fixture-open',message:String(error.message||error)}));
              }else if(message.type==='annotation-source-identity'){
                trace.identity.push({at:performance.now(),documentId:message.documentId,rendererGeneration:message.rendererGeneration||null,identityStatus:message.identityStatus,pageCount:message.pageCount,openRequest:message.openRequest});
              }else if(message.type==='opened'){
                trace.opened.push({at:performance.now(),documentId:message.documentId,rendererGeneration:message.rendererGeneration||null,openRequest:message.openRequest,revision:message.revision,confirmedRevision:message.confirmedRevision});
              }else if(message.type==='error'){
                trace.errors.push({at:performance.now(),code:message.code,message:String(message.message||'').slice(0,200)});
              }
            });
          })();
        </script>`);
      return;
    }
    if (url.pathname === "/viewer/web/viewer.html") {
      const condition = url.searchParams.get("condition");
      const html = ["U1", "U2"].includes(condition)
        ? viewerHtml.replace(/<head\b[^>]*>/i, (head) => `${head}<script src="/viewer/obsidian-bridge.js?condition=${condition}" data-channel="${channel}" data-token="${token}" data-renderer-generation="${scenarioRendererGeneration(condition)}"></script>`)
        : viewerHtml;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    let target;
    if (url.pathname === "/viewer/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(url.searchParams.get("condition") === "U1" ? noHydrationBridgeSource : bridgeSource);
      return;
    }
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") target = fixture;
    else if (url.pathname.startsWith("/viewer/")) target = path.resolve(vendorRoot, decodeURIComponent(url.pathname.slice("/viewer/".length)));
    else if (url.pathname.startsWith("/build/")) target = path.resolve(vendorRoot, decodeURIComponent(url.pathname.slice(1)));
    else {
      response.writeHead(404).end("not found");
      return;
    }
    const relative = target === fixture ? "" : path.relative(vendorRoot, target);
    if (target !== fixture && (relative.startsWith("..") || path.isAbsolute(relative))) {
      response.writeHead(403).end("forbidden");
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
    const serverPort = await listenOnSafeLoopbackPort(server);
    const baseUrl = `http://127.0.0.1:${serverPort}`;
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "selection-differential", artifactsDir: artifacts });
    let frameOffset = { x: 0, y: 0 };
    const openScenario = async (condition) => {
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      page.on("pageerror", (error) => { trace.pageError ||= error.message; });
      page.on("console", (message) => {
        if (message.type() === "error") (trace.consoleErrors ||= []).push(String(message.text()).slice(0, 400));
      });
      page.on("requestfailed", (request) => {
        (trace.requestFailures ||= []).push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText || null });
      });
      page.on("response", (response) => {
        if (response.status() >= 400) {
          (trace.httpErrors ||= []).push({ url: response.url(), status: response.status() });
        }
      });
      await page.goto(`${baseUrl}/?condition=${condition}`, { waitUntil: "domcontentloaded" });
      const frame = await page.waitForFrame((candidate) => candidate.parentFrame() &&
        candidate.url().includes("/viewer/web/viewer.html?") &&
        candidate.url().includes(`condition=${condition}`), { timeout: 35_000 });
      assert.ok(frame, `Viewer URL did not create a frame for ${condition}`);
      if (condition !== "U0") {
        const openRequest = condition === "U1" ? 1 : 2;
        const activeDocumentId = `${documentId}#${condition}`;
        await page.waitForFunction((expectedDocumentId, expectedOpenRequest) =>
          window.__selectionParentTrace?.opened?.some((event) =>
            event.documentId === expectedDocumentId && event.openRequest === expectedOpenRequest) ||
            window.__selectionParentTrace?.errors?.length > 0,
        { timeout: 35_000 }, activeDocumentId, openRequest);
        const errors = await page.evaluate(() => window.__selectionParentTrace?.errors || []);
        assert.equal(errors.length, 0, `${condition} host-open should not report errors`);
        await page.waitForFunction((expectedDocumentId, expectedOpenRequest) =>
          window.__browserSidecarHost?.identityRequests?.some((event) =>
            event.documentId === expectedDocumentId && event.openRequest === expectedOpenRequest),
        { timeout: 20_000 }, activeDocumentId, openRequest);
        await frame.waitForFunction(() => Boolean(PDFViewerApplication.pdfDocument), { timeout: 15_000 });
      }
      try {
        await frame.waitForSelector('.page[data-page-number="1"] .textLayer span', { timeout: 40_000 });
      } catch (error) {
        trace.readinessFailure = await frame.evaluate(() => ({
          href: location.href,
          title: document.title,
          appExists: Boolean(window.PDFViewerApplication),
          initialized: Boolean(window.PDFViewerApplication?.initializedPromise),
          pdfDocument: Boolean(window.PDFViewerApplication?.pdfDocument),
          pagesCount: window.PDFViewerApplication?.pdfViewer?.pagesCount ?? null,
          page1: Boolean(document.querySelector('.page[data-page-number="1"]')),
          textLayers: document.querySelectorAll(".textLayer").length,
          errorWrapper: document.querySelector("#errorWrapper")?.textContent?.slice(0, 400) || null,
          errorMessage: document.querySelector("#errorMessage")?.textContent?.slice(0, 400) || null,
          status: document.querySelector("#errorMessage")?.textContent?.slice(0, 400) || null,
        })).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError?.message || diagnosticError) }));
        trace.readinessParent = await page.evaluate(() => ({
          condition: window.__selectionParentTrace?.condition || null,
          iframeSrc: document.querySelector("iframe")?.src || null,
          ready: window.__selectionParentTrace?.ready || [],
          opened: window.__selectionParentTrace?.opened || [],
          identity: window.__selectionParentTrace?.identity || [],
          errors: window.__selectionParentTrace?.errors || [],
        })).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError?.message || diagnosticError) }));
        throw error;
      }
      await frame.evaluate(() => {
        window.__selectionDifferential = { checkpoints: [], trace: {}, cleanup: null };
        const input = document.createElement("input");
        input.id = "selectionDifferentialInput";
        input.setAttribute("aria-label", "Selection lifecycle test input");
        input.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;width:190px;height:28px;background:white;color:black";
        document.body.append(input);
      });
      await frame.evaluate((source) => {
        const install = (0, eval)(`(${source})`);
        const state = window.__selectionDifferential;
        state.cleanup = install({ d: document, w: window, a: PDFViewerApplication, trace: state.trace });
      }, installNativeSelectionProbe.toString());
      frameOffset = await page.$eval("iframe", (iframe) => {
        const rect = iframe.getBoundingClientRect();
        return { x: rect.left, y: rect.top };
      });
      return frame;
    };
    const persistEvidence = async (phase) => {
      trace.lastPersistedPhase = phase;
      trace.sidecarHost = await page.evaluate(() => ({
        identityRequests: window.__browserSidecarHost?.identityRequests || [],
        sourceConfirmed: window.__selectionParentTrace?.identity || [],
        opened: window.__selectionParentTrace?.opened || [],
        errors: window.__selectionParentTrace?.errors || [],
      }));
      await writeFile(artifactPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
      t.diagnostic(`Selection differential evidence (${phase}): ${artifactPath}`);
    };
    const checkpoint = (frame, phase) => frame.evaluate((name) => {
      const selection = document.getSelection();
      const layers = [...document.querySelectorAll(".textLayer")].map((layer) => ({
        page: layer.closest(".page")?.dataset.pageNumber || null,
        className: layer.className,
        selecting: layer.classList.contains("selecting"),
        endOfContent: (() => {
          const rect = layer.querySelector(".endOfContent")?.getBoundingClientRect();
          return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
        })(),
      }));
      const input = document.getElementById("selectionDifferentialInput");
      const row = {
        phase: name, at: performance.now(),
        selection: { collapsed: selection?.isCollapsed ?? null, rangeCount: selection?.rangeCount ?? 0,
          textLength: String(selection?.toString?.() ?? "").length,
          anchor: selection?.anchorNode?.parentElement?.className || selection?.anchorNode?.nodeName || null,
          focus: selection?.focusNode?.parentElement?.className || selection?.focusNode?.nodeName || null },
        activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
        inputValue: input?.value ?? null,
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        layers,
        editorCount: document.querySelectorAll(".annotationEditorLayer > div[id]").length,
      };
      window.__selectionDifferential.checkpoints.push(row);
      return row;
    }, phase);
    const geometry = (frame) => frame.evaluate(() => {
      const page = document.querySelector('.page[data-page-number="1"]');
      const phrase = "Dynamic languages such as JavaScript";
      const span = [...(page?.querySelectorAll(".textLayer span") || [])].find((element) => (element.textContent || "").includes(phrase));
      const node = span?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error(`Could not locate fixture phrase (${phrase.length} chars)`);
      const from = node.textContent.indexOf(phrase);
      const to = from + phrase.length;
      const charRect = (offset) => {
        const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1);
        const rect = range.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      const first = charRect(from); const last = charRect(to - 1);
      const range = document.createRange(); range.setStart(node, from); range.setEnd(node, to);
      const rect = range.getBoundingClientRect();
      return { phraseLength: phrase.length, target: { textNodeStartOffset: from, textNodeEndOffset: to, spanClass: span.className },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        start: { x: first.left + 1, y: (first.top + first.bottom) / 2 },
        end: { x: last.right - 1, y: (last.top + last.bottom) / 2 },
        caret: { x: first.left + (first.right - first.left) / 2, y: (first.top + first.bottom) / 2 },
        firstSpanClass: span.className };
    });
    const click = (point) => page.mouse.click(frameOffset.x + point.x, frameOffset.y + point.y);
    const drag = async (start, end) => {
      await page.mouse.move(frameOffset.x + start.x, frameOffset.y + start.y, { steps: 2 });
      await page.mouse.down({ button: "left" });
      await page.mouse.move(frameOffset.x + end.x, frameOffset.y + end.y, { steps: 12 });
      await page.mouse.up({ button: "left" });
    };
    const setMode = async (frame, mode) => {
      await frame.evaluate((value) => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { mode: value }), mode);
      await frame.waitForFunction((value) => PDFViewerApplication.pdfViewer.annotationEditorMode === value, { timeout: 8_000 }, mode);
    };
    const recordCaret = async (frame, condition) => {
      const target = await geometry(frame);
      await click(target.caret);
      await new Promise((resolve) => setTimeout(resolve, 180));
      const afterCaret = await checkpoint(frame, `${condition}:collapsed-caret-after-pointerup`);
      const field = await frame.$eval("#selectionDifferentialInput", (element) => {
        const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await click(field);
      await page.keyboard.type("caret-22134");
      const afterField = await checkpoint(frame, `${condition}:after-next-field-click-and-type`);
      const probe = await frame.evaluate(() => window.__selectionDifferential.trace.nativeSelectionProbe);
      const bridge = await frame.evaluate(() => ({
        script: Boolean(document.querySelector('script[src*="obsidian-bridge.js"]')),
        css: Boolean(document.querySelector('style[data-pdf-reader="bridge"]')),
        sourceConfirmed: window.__sidecarSelectionBridgeState?.externalSourceConfirmed ?? null,
      }));
      const row = { condition, geometry: target, afterCaret, afterField, bridge, probe };
      trace.scenarios.push({ phase: "blank-caret", ...row });
      return row;
    };
    const recordUnderline = async (frame, condition, overlapSquare = false) => {
      const target = await geometry(frame);
      let square = null;
      if (overlapSquare) {
        const beforeSquare = await frame.evaluate(() => [...(PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map?.values() || [])].filter((entry) => entry.annotationType === 5 && !entry.deleted).length);
        await setMode(frame, 5);
        await drag({ x: target.rect.x - 8, y: target.rect.y - 5 }, { x: target.rect.x + target.rect.width + 8, y: target.rect.y + target.rect.height + 5 });
        await frame.waitForFunction((before) => [...(PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map?.values() || [])].filter((entry) => entry.annotationType === 5 && !entry.deleted).length > before, { timeout: 10_000 }, beforeSquare);
        square = await checkpoint(frame, `${condition}:overlapping-square-created`);
      }
      const before = await frame.evaluate(() => ({
        annotations: [...(PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map?.values() || [])].filter((entry) => entry.annotationType === 10 && !entry.deleted).length,
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
      }));
      await setMode(frame, 10);
      await drag(target.start, target.end);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await checkpoint(frame, `${condition}:mode10-after-trusted-drag`);
      const detail = await frame.evaluate(() => ({
        probe: window.__selectionDifferential.trace.nativeSelectionProbe,
        annotationCount: [...(PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map?.values() || [])].filter((entry) => entry.annotationType === 10 && !entry.deleted).length,
        editors: [...document.querySelectorAll(".annotationEditorLayer > div[id]")].map((element) => ({ id: element.id, className: element.className })),
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
      }));
      const row = { condition, geometry: target, square, before, after, detail };
      trace.scenarios.push({ phase: "mode10-trusted-drag", ...row });
      return row;
    };

      // Each condition gets a fresh parent page and initial iframe URL. This
      // avoids WindowProxy reuse and stale `ready` messages crossing viewers.
      const u0 = await openScenario("U0");
      const u0Caret = await recordCaret(u0, "U0-pure-frozen-no-bridge");
      const u0Underline = await recordUnderline(u0, "U0-pure-frozen-no-bridge");
      const u0BridgePresence = await u0.evaluate(() => ({ script: Boolean(document.querySelector('script[src*="obsidian-bridge.js"]')), css: Boolean(document.querySelector('style[data-pdf-reader="bridge"]')) }));
      trace.bridgePresence = { U0: u0BridgePresence };
      await persistEvidence("U0-complete");
      trace.scenarios.push({ phase: "U0-teardown", resources: await teardownViewerPage(page) });
      await page.close();
      page = null;

      // U1: test-only bridge skips external editor hydration but keeps the
      // regular host open, identity confirmation, and editor-mode flow intact.
      const u1 = await openScenario("U1");
      await u1.waitForFunction(() => !document.getElementById("editorUnderlineButton")?.disabled, { timeout: 12_000 });
      const u1Caret = await recordCaret(u1, "U1-bridge-identity-confirmed-no-hydration");
      const u1Underline = await recordUnderline(u1, "U1-bridge-identity-confirmed-no-hydration");
      const u1BridgePresence = await u1.evaluate(() => ({ script: Boolean(document.querySelector('script[src*="obsidian-bridge.js"]')), css: Boolean(document.querySelector('style[data-pdf-reader="bridge"]')) }));
      trace.bridgePresence.U1 = u1BridgePresence;
      await persistEvidence("U1-complete");
      trace.scenarios.push({ phase: "U1-teardown", resources: await teardownViewerPage(page) });
      await page.close();
      page = null;

      // U2: real host-open and identity-confirmed empty sidecar baseline; then
      // run a trusted mode-10 drag through a local Square editor.
      const u2 = await openScenario("U2");
      await u2.waitForFunction(() => !document.getElementById("editorUnderlineButton")?.disabled, { timeout: 12_000 });
      const u2Caret = await recordCaret(u2, "U2-identity-confirmed-sidecar-baseline");
      const u2Underline = await recordUnderline(u2, "U2-identity-confirmed-sidecar-baseline", true);
      const u2BridgePresence = await u2.evaluate(() => ({ script: Boolean(document.querySelector('script[src*="obsidian-bridge.js"]')), css: Boolean(document.querySelector('style[data-pdf-reader="bridge"]')) }));
      trace.bridgePresence.U2 = u2BridgePresence;
      await persistEvidence("U2-complete");

      // #22129 lifecycle is kept separate from the interaction differential:
      // two PDFViewer instances in this same iframe Document, each with its own
      // abort signal, then tear down the first while the second remains.
      trace.sharedDocumentLifecycle = await u2.evaluate(async () => {
        const app = PDFViewerApplication;
        const second = document.createElement("div");
        second.id = "selectionSecondViewer";
        second.style.cssText = "position:absolute;right:0;top:0;width:620px;height:850px;overflow:auto;background:white;z-index:1000";
        const viewer = document.createElement("div"); viewer.className = "pdfViewer"; second.append(viewer); document.body.append(second);
        const controller = new AbortController();
        const secondViewer = new app.pdfViewer.constructor({ container: second, viewer, eventBus: new app.eventBus.constructor(), abortSignal: controller.signal });
        secondViewer.setDocument(app.pdfDocument);
        for (let attempt = 0; attempt < 500 && !second.querySelector('.page[data-page-number="1"] .textLayer span'); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
        const layer = second.querySelector('.page[data-page-number="1"] .textLayer');
        const before = { textLayerPresent: Boolean(layer), sameDocument: second.ownerDocument === document, firstSignalAborted: app._globalAbortController?.signal.aborted ?? null, secondSignalAborted: controller.signal.aborted, signalsDistinct: app._globalAbortController?.signal !== controller.signal, firstPages: app.pdfViewer.pagesCount, secondPages: secondViewer.pagesCount };
        app._globalAbortController?.abort();
        app.pdfViewer.setDocument(null);
        return { before, afterTeardown: { firstSignalAborted: app._globalAbortController?.signal.aborted ?? null, secondSignalAborted: controller.signal.aborted, secondLayerConnected: Boolean(layer?.isConnected), secondLayerClass: layer?.className ?? null } };
      });
      const secondGeometry = await u2.evaluate(() => {
        const page = document.querySelector("#selectionSecondViewer .page[data-page-number='1']");
        const span = [...(page?.querySelectorAll(".textLayer span") || [])].find((element) => (element.textContent || "").includes("Dynamic languages such as JavaScript"));
        const node = span?.firstChild; const phrase = "Dynamic languages such as JavaScript"; const from = node?.textContent.indexOf(phrase) ?? -1;
        const makeRect = (offset) => { const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + 1); return range.getBoundingClientRect(); };
        const first = makeRect(from); const last = makeRect(from + phrase.length - 1);
        return { start: { x: first.left + 1, y: (first.top + first.bottom) / 2 }, end: { x: last.right - 1, y: (last.top + last.bottom) / 2 } };
      });
      await drag(secondGeometry.start, secondGeometry.end);
      await new Promise((resolve) => setTimeout(resolve, 180));
      trace.sharedDocumentLifecycle.afterSecondViewerDrag = await u2.evaluate(() => {
        const layer = document.querySelector("#selectionSecondViewer .textLayer"); const selection = document.getSelection();
        return { at: performance.now(), layerClass: layer?.className ?? null, selectingAfterPointerup: Boolean(layer?.classList.contains("selecting")), layerConnected: Boolean(layer?.isConnected), selection: { collapsed: selection?.isCollapsed ?? null, rangeCount: selection?.rangeCount ?? 0, textLength: String(selection?.toString?.() ?? "").length }, pointerEvents: window.__selectionDifferential.trace.nativeSelectionProbe.pointerEvents.filter((event) => ["pointerdown", "pointerup"].includes(event.type)).slice(-4), phases: window.__selectionDifferential.trace.nativeSelectionProbe.eventPhases.slice(-20) };
      });

      trace.bridgePresence = { U0: u0BridgePresence, U1: u1BridgePresence, U2: u2BridgePresence };
      await persistEvidence("lifecycle-complete");

      // Observe first, assert after persistence. A failed run retains the
      // capture/bubble and consumer selection snapshots before Node reports red.
      const staleCaret = [u0Caret, u1Caret, u2Caret].filter((row) => row.afterCaret.layers.some((layer) => layer.selecting));
      const exactTextSelection = (row, consumer) => {
        const before = consumer.before;
        const range = before?.ranges?.length === 1 ? before.ranges[0] : null;
        return before?.collapsed === false &&
          before?.textLength === row.geometry.phraseLength &&
          before?.rangeCount === 1 &&
          before?.anchorTextLayer?.found === true &&
          before?.anchorTextLayer?.pageNumber === "1" &&
          range?.start?.className === row.geometry.target.spanClass &&
          range?.end?.className === row.geometry.target.spanClass &&
          range?.startOffset === row.geometry.target.textNodeStartOffset &&
          range?.endOffset === row.geometry.target.textNodeEndOffset;
      };
      const impreciseConsumers = [u0Underline, u1Underline, u2Underline].map((row) => ({
        condition: row.condition,
        consumers: row.detail.probe?.consumers?.map((consumer) => ({
          textLength: consumer.before?.textLength ?? null,
          rangeCount: consumer.before?.rangeCount ?? null,
          collapsed: consumer.before?.collapsed ?? null,
          pageNumber: consumer.before?.anchorTextLayer?.pageNumber ?? null,
          ranges: consumer.before?.ranges || [],
          exactTargetRange: exactTextSelection(row, consumer),
        })) || [],
      })).filter((row) => !row.consumers.some((consumer) => consumer.exactTargetRange));
      trace.validation = { staleCaret: staleCaret.map((row) => row.condition), impreciseConsumers };
      await persistEvidence("validation-complete");
      assert.deepEqual({ staleCaret: staleCaret.map((row) => row.condition), impreciseConsumers },
        { staleCaret: [], impreciseConsumers: [] },
        `Selection lifecycle/target-range evidence differs from the requested exact drag; see ${artifactPath}`);
    } catch (error) {
      primaryError = error;
      trace.failure = { name: error?.name || "Error", message: String(error?.message || error).slice(0, 1600) };
      try {
        await writeFile(artifactPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
        t.diagnostic(`Selection differential evidence (failure): ${artifactPath}`);
      } catch (captureError) {
        t.diagnostic(`Could not persist selection differential evidence: ${captureError?.message || captureError}`);
      }
    } finally {
      cleanupReport = await cleanupBrowserTestResources({ browser, server });
    }
    const error = attachCleanupErrors(primaryError, cleanupReport);
    if (error) throw error;
  });
