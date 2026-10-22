import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readLearningBrowserProductionMethods } from './learning-browser-production-methods.mjs';
import { runLearningContextBrowserFlow } from './learning-context-browser-flow.mjs';
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources, attachCleanupErrors } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";
import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createPdfHashRuntime } = require("../plugin/pdf-hash-runtime.cjs");
const { encodeReaderLinkFragment, parseReaderLinkFragment } = require("../plugin/reader-anchor-store.cjs");
const { createReaderAnchorStore } = require("../plugin/reader-anchor-store.cjs");
const { buildReaderBacklinkPageIndex, createReaderBacklinkIndex } = require("../plugin/reader-backlink-index.cjs");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const browserPath = resolveBrowserPath();
const channel = "pdf-web-reader";
const token = `reader-bidirectional-link-${Date.now()}-${process.pid}`;
const rendererGeneration = `reader-bidirectional-renderer-${Date.now()}`;
const documentId = "reader-bidirectional-document";
const docKey = "b10f9a3ce227";
const initialPdfPath = "Books/tracemonkey.pdf";
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"], [".svg", "image/svg+xml"], [".wasm", "application/wasm"],
]);

function createMemoryAdapter() {
  const files = new Map();
  const directories = new Set([""]);
  return {
    files,
    async exists(pathname) { return files.has(pathname) || directories.has(pathname); },
    async mkdir(pathname) { directories.add(pathname); },
    async read(pathname) { if (!files.has(pathname)) throw new Error(`Missing test anchor ${pathname}`); return files.get(pathname); },
    async write(pathname, value) { files.set(pathname, value); },
    async rename(from, to) { if (files.has(to)) throw new Error(`Anchor target already exists: ${to}`); files.set(to, files.get(from)); files.delete(from); },
    async list(pathname) { return { files: [...files.keys()].filter((item) => item.startsWith(`${pathname}/`) && !item.slice(pathname.length + 1).includes("/")), folders: [] }; },
  };
}

function createHostHarness(hashRuntime) {
  const index = createReaderBacklinkIndex();
  const adapter = createMemoryAdapter();
  let anchorSequence = 0;
  const anchorStore = createReaderAnchorStore({
    adapter,
    hash: async (bytes) => hashRuntime.fingerprint(bytes),
    makeId: () => `browser-anchor-${++anchorSequence}`,
  });
  const state = {
    identity: null,
    currentPdfPath: initialPdfPath,
    backlinkPageQueryGeneration: 0,
    annotations: [],
    tombstones: [],
    captures: new Map(),
    openedSources: [],
    modalRows: [],
    protocolErrors: [],
    annotationIds: [],
    anchorIds: [],
    exactSourceOpener(row, source = "viewer") {
      // This is the public Workspace/Markdown editor boundary. Production Host
      // tests exercise plugin.openReaderBacklinkSource; the browser harness
      // records the same path/range/line request without pretending Obsidian is loaded.
      state.openedSources.push({ sourcePath: row.sourcePath, offset: row.offset,
        endOffset: row.endOffset ?? null, line: row.line, source, focused: true });
    },
  };

  const pageIndexFor = async () => {
    const identity = state.identity;
    if (!identity || identity.identityStatus !== "KNOWN") return null;
    return buildReaderBacklinkPageIndex({
      index,
      anchorStore,
      docKey,
      documentId,
      sourcePath: state.currentPdfPath,
      pageIdentities: identity.orderedPageIdentities,
      annotations: state.annotations,
      tombstones: state.tombstones,
    });
  };

  function addMarkdownLink({ sourcePath, target, pageNumber, displayText, offset, line = 4, pdfPath = state.currentPdfPath }) {
    const fragment = encodeReaderLinkFragment({ pageNumber, target });
    const text = displayText || `${target.kind} backlink`;
    const link = {
      link: `${pdfPath}#${fragment}`,
      displayText: text,
      position: { start: { offset, line }, end: { offset: offset + text.length, line } },
    };
    const current = markdownLinks.get(sourcePath) || [];
    markdownLinks.set(sourcePath, [...current, link]);
    index.replaceFile({ path: sourcePath }, { links: markdownLinks.get(sourcePath) });
    return link;
  }
  const markdownLinks = new Map();

  async function createSelectionAnchor(capture, sourcePath, offset) {
    const identity = state.identity;
    assert.equal(capture.kind, "selection");
    const orderedPageIdentityDigest = hashRuntime.fingerprint(
      new TextEncoder().encode(JSON.stringify(identity.orderedPageIdentities)),
    );
    const anchor = await anchorStore.create({
      docKey,
      documentId,
      sourceHash: capture.sourceHash,
      pageIdentity: capture.pageIdentity,
      pageIndexHint: capture.pageIndex,
      pageCount: identity.pageCount,
      orderedPageIdentityDigest,
      textPosition: capture.textPosition,
      exactQuote: capture.exactQuote,
      prefix: capture.prefix,
      suffix: capture.suffix,
      geometry: capture.geometry,
      createdAt: Date.now(),
    });
    state.anchorIds.push(anchor.anchorId);
    addMarkdownLink({ sourcePath, target: { kind: "selection", id: anchor.anchorId },
      pageNumber: capture.pageNumber, displayText: capture.exactQuote, offset });
    return anchor;
  }

  async function handleViewerMessage(message) {
    if (message.documentId !== documentId || message.openRequest !== 1 ||
        message.rendererGeneration !== rendererGeneration) {
      state.protocolErrors.push({ type: message.type, reason: "stale identity" });
      return null;
    }
    if (message.type === "annotation-source-identity") {
      state.identity = { ...message };
      return null;
    }
    if (message.type === "reader-anchor-capture") {
      state.captures.set(message.requestId, message);
      return null;
    }
    if (message.type === "reader-backlink-page-request") {
      const queryGeneration = ++state.backlinkPageQueryGeneration;
      const pageIndex = await pageIndexFor();
      if (!pageIndex || queryGeneration !== state.backlinkPageQueryGeneration) return null;
      const result = pageIndex.forPage(message.pageIdentity);
      return {
        type: "reader-backlink-page-results",
        requestId: message.requestId,
        documentId, openRequest: 1, rendererGeneration,
        pageNumber: message.pageNumber, pageIndex: message.pageIndex,
        pageIdentity: message.pageIdentity,
        backlinkCount: result.rows.length, markers: result.markers,
        backlinkLookupMs: 0, anchorResolveMs: 0, pageIndexCacheHit: true,
      };
    }
    if (message.type === "reader-backlink-target-open") {
      const identity = state.identity;
      if (!identity || message.pageIdentity !== identity.orderedPageIdentities[message.pageNumber - 1]) return null;
      const pageIndex = await pageIndexFor();
      if (!pageIndex) return null;
      let rows;
      if (message.targetKind === "selection") rows = pageIndex.forAnchorIds([message.targetId]);
      else rows = pageIndex.forPage(message.pageIdentity).rows.filter((row) =>
        row.target?.kind === message.targetKind && row.target.id === message.targetId && row.targetStatus !== "deleted");
      if (rows.length === 1) state.exactSourceOpener(rows[0], "viewer");
      else if (rows.length > 1) state.modalRows = rows.map((row) => ({ sourcePath: row.sourcePath, offset: row.offset }));
      return { type: "test-target-open-result", requestId: message.requestId,
        targetKind: message.targetKind, targetId: message.targetId, rowCount: rows.length };
    }
    if (message.type === "save") {
      return { type: "saved", requestId: message.requestId, revision: message.revision,
        external: true, operationCount: Array.isArray(message.operations) ? message.operations.length : 0,
        batchId: message.operations?.length ? `browser-${message.requestId}` : null };
    }
    return null;
  }

  return { state, index, anchorStore, markdownLinks, addMarkdownLink, createSelectionAnchor,
    handleViewerMessage, pageIndexFor };
}

test("PDF Viewer backlinks resolve actual selection/page/annotation markers through the existing index and target-open protocol", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 180_000,
}, async (t) => {
  const [bridgeRuntimeSource, bridgeCss, viewerHtml, fixtureBytes, hashRuntime] = await Promise.all([
    readBridgeRuntimeSource(path.join(root, "viewer-adapter", "obsidian-bridge.js")),
    readFile(path.join(root, "viewer-adapter", "bridge.css"), "utf8"),
    readFile(path.join(vendorRoot, "web", "viewer.html"), "utf8"),
    readFile(fixture),
    createPdfHashRuntime(),
  ]);
  const instrumentedBridgeSource = bridgeRuntimeSource.replace("  const state = {", "  const state = window.__pdfReaderBridgeState = {");
  assert.notEqual(instrumentedBridgeSource, bridgeRuntimeSource, "test instrumentation must expose the actual bridge state object");
  const bridgeSource = instrumentedBridgeSource;
  const sourceHash = hashRuntime.fingerprint(fixtureBytes);
  const sourceSha256 = createHash('sha256').update(fixtureBytes).digest('hex');
  const productionMethodSource = await readLearningBrowserProductionMethods(path.join(root, 'plugin/main.js'));
  const learningBundle = await build({ entryPoints: [path.join(root, 'tests/learning-browser-host-fixture.mjs')],
    bundle: true, format: 'iife', globalName: 'LearningBrowserFixture', platform: 'browser', write: false });
  const host = createHostHarness(hashRuntime);
  const sidecarHarness = browserSidecarHarnessScript({ channel, token, sourceHash, sourcePath: initialPdfPath });
  const viewerWithBridge = viewerHtml.replace(/<head\b[^>]*>/i, (head) =>
    `${head}<link rel="stylesheet" href="/viewer-adapter/bridge.css"><script src="/viewer-adapter/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}" data-base-url="/vendor/pdfjs-generic-legacy/web/"></script>`);
  const server = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(withTestNetworkFirewall())) response.setHeader(name, value);
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="PDF Web Reader backlink E2E" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
        ${sidecarHarness}
        <script>${learningBundle.outputFiles[0].text}</script>
        <script>(()=>{
          const channel=${JSON.stringify(channel)},token=${JSON.stringify(token)},rendererGeneration=${JSON.stringify(rendererGeneration)},documentId=${JSON.stringify(documentId)},pdfPath=${JSON.stringify(initialPdfPath)},sourceHash=${JSON.stringify(sourceHash)};
          const iframe=document.querySelector('iframe');
          LearningBrowserFixture.installLearningBrowserHost({documentId,docKey:${JSON.stringify(docKey)},rendererGeneration,sourcePath:pdfPath});
          const host=window.__readerBacklinkE2E={messages:[],opened:[],identity:null,openSent:false,sourceBytes:null,errors:[],lastTargetResult:null};
          window.__readerHostPost=fields=>iframe.contentWindow.postMessage({channel,token,rendererGeneration,...fields},'*');
          window.__readerHostPostPageResult=result=>window.__readerHostPost(result);
          window.__readerHostRefreshPage=async()=>{
            const identity=host.identity;if(!identity||identity.identityStatus!=='KNOWN')throw new Error('Viewer page identity is not confirmed');
            const pageNumber=Number(host.lastPageRequest?.pageNumber)||1;
            const message={type:'reader-backlink-page-request',requestId:host.lastPageRequest?.requestId,documentId,openRequest:1,rendererGeneration,pageNumber,pageIndex:pageNumber-1,pageIdentity:identity.orderedPageIdentities[pageNumber-1],sourceHash:identity.sourceHash};
            const result=await window.__readerBacklinkHost(message);if(result)window.__readerHostPostPageResult(result);return result;
          };
          window.addEventListener('message',async event=>{
            if(event.source!==iframe.contentWindow||!event.data||event.data.channel!==channel||event.data.token!==token)return;
            const message=event.data;host.messages.push(message);
            try{
              if(message.type==='ready'&&!host.openSent){host.openSent=true;host.opened.push({type:'ready',at:performance.now()});
                host.sourceBytes=await(await fetch('/tests/fixtures/tracemonkey.pdf')).arrayBuffer();const data=host.sourceBytes.slice(0);
                window.__readerHostPost({type:'open',documentId,documentPath:pdfPath,filename:'tracemonkey.pdf',openRequest:1,data,externalAnnotations:{schemaVersion:2,kind:'pdf-annotation-snapshot',documentId,docKey:${JSON.stringify(docKey)},revision:0,source:{sourcePath:pdfPath,sourceHash},legacyIdentities:[],annotations:[],tombstones:[]},readOnly:false,autoSave:false,revision:0,confirmedRevision:0,restoreDirty:false,restorePaused:false});
              }else if(message.type==='annotation-source-identity'){
                host.identity=message;await window.__readerBacklinkHost(message);
              }else if(message.type==='opened')host.opened.push(message);
              else if(message.type==='reader-backlink-page-request'){
                host.lastPageRequest=message;
                const result=await window.__readerBacklinkHost(message);if(result)window.__readerHostPostPageResult(result);
              }else if(message.type==='reader-backlink-target-open'){
                const result=await window.__readerBacklinkHost(message);host.lastTargetResult=result||null;
              }else if(message.type==='reader-anchor-capture')await window.__readerBacklinkHost(message);
              else if(message.type==='save'){
                await window.__readerBacklinkHost(message);
                window.__readerHostPost({type:'saved',documentId:message.documentId,openRequest:message.openRequest,rendererGeneration,requestId:message.requestId,revision:message.revision,external:true,operationCount:message.operations?.length||0,batchId:message.operations?.length?'e2e-'+message.requestId:null});
              }else if(message.type==='reader-anchor-navigation-result')host.opened.push({...message,type:'navigation-result'});
              else if(message.type==='error')host.errors.push({code:message.code||null,message:String(message.message||'')});
            }catch(error){host.errors.push({type:message.type,message:String(error?.stack||error)});}
          });
        })();</script>`);
      return;
    }
    if (url.pathname === "/viewer-adapter/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }); response.end(bridgeSource); return;
    }
    if (url.pathname === "/viewer-adapter/bridge.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" }); response.end(bridgeCss); return;
    }
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(viewerWithBridge); return;
    }
    let target;
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") target = fixture;
    else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
      const relative = decodeURIComponent(url.pathname.slice("/vendor/pdfjs-generic-legacy/".length));
      target = path.resolve(vendorRoot, relative);
      if (!target.startsWith(`${vendorRoot}${path.sep}`)) { response.writeHead(403).end("forbidden"); return; }
    } else { response.writeHead(404).end("not found"); return; }
    try {
      const info = await stat(target);
      response.writeHead(200, { "content-type": mimeTypes.get(path.extname(target)) || "application/octet-stream",
        "content-length": info.size, "x-content-type-options": "nosniff" });
      createReadStream(target).pipe(response);
    } catch { response.writeHead(404).end("not found"); }
  });

  let browser;
  let page;
  let primaryError;
  let cleanupReport;
  let diagnosticDirectory;
  const gestureDiagnostics = [];
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    browser = await launchTestBrowser(puppeteer, { executablePath: browserPath, headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"] }, { testName: "reader-bidirectional-link-browser" });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.exposeFunction("__readerBacklinkHost", (message) => host.handleViewerMessage(message));
    await page.exposeFunction('__learningFingerprint', bytes => hashRuntime.fingerprint(Uint8Array.from(bytes)));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((id) => window.__readerBacklinkE2E?.opened?.some((row) => row.documentId === id && row.type === "opened") || window.__readerBacklinkE2E?.errors?.length,
      { timeout: 40_000 }, documentId);
    const openState = await page.evaluate(() => ({ opened: window.__readerBacklinkE2E.opened, errors: window.__readerBacklinkE2E.errors }));
    assert.deepEqual(openState.errors, [], "the actual Viewer bridge must open the fixture without host protocol errors");
    const frame = page.frames().find((candidate) => candidate.url().includes("/web/viewer.html"));
    assert.ok(frame, "the actual PDF.js Viewer frame must be present");
    await frame.evaluate(() => {
      window.__backlinkE2EClicks = [];
      document.addEventListener("click", (event) => window.__backlinkE2EClicks.push({
        detail: event.detail, button: event.button, x: event.clientX, y: event.clientY,
        target: event.target?.className?.baseVal || event.target?.className || event.target?.nodeName,
      }), true);
    });
    await frame.waitForFunction(() => PDFViewerApplication?.pdfDocument && PDFViewerApplication?.pdfViewer?.getPageView(0)?.renderingState === 3,
      { timeout: 40_000 });
    await frame.waitForSelector('.page[data-page-number="1"] .textLayer span', { timeout: 35_000 });
    await frame.evaluate(() => {
      window.__learningSourceSaveCalls = 0;
      const original = PDFViewerApplication.pdfDocument.saveDocument.bind(PDFViewerApplication.pdfDocument);
      PDFViewerApplication.pdfDocument.saveDocument = (...args) => { window.__learningSourceSaveCalls++; return original(...args); };
    });
    await page.waitForFunction(() => window.__readerBacklinkE2E.identity?.identityStatus === "KNOWN", { timeout: 20_000 });
    const frameOffset = await page.$eval("iframe", (iframe) => { const rect = iframe.getBoundingClientRect(); return { x: rect.x, y: rect.y }; });

    const requestCapture = async (requestId, mode) => {
      await page.evaluate(({ requestId, mode }) => {
        const host = window.__readerBacklinkE2E;
        window.__readerHostPost({ type: "reader-anchor-capture-request", requestId, mode,
          documentId: host.identity.documentId, openRequest: host.identity.openRequest });
      }, { requestId, mode });
      await page.waitForFunction((requestId) => window.__readerBacklinkE2E.messages.some((message) =>
        message.type === "reader-anchor-capture" && message.requestId === requestId), { timeout: 10_000 }, requestId);
      const captureMessage = host.state.captures.get(requestId);
      assert.ok(captureMessage, `Viewer did not return capture ${requestId}`);
      assert.ok(captureMessage.capture, captureMessage.error || `capture ${requestId} should resolve to an actual PDF target`);
      return captureMessage.capture;
    };
    const refreshPage = async () => {
      const result = await page.evaluate(() => window.__readerHostRefreshPage());
      assert.ok(result, "the existing Reader backlink page index should return a current page result");
      try {
        await frame.waitForFunction(({ pageNumber, pageIdentity, backlinkCount }) => {
          const current = window.__pdfReaderBridgeState?.readerBacklinkPageResults;
          return current?.pageNumber === pageNumber && current.pageIdentity === pageIdentity &&
            current.backlinkCount === backlinkCount;
        }, { timeout: 8_000 }, { pageNumber: result.pageNumber, pageIdentity: result.pageIdentity,
          backlinkCount: result.backlinkCount });
      } catch (error) {
        const trace = await frame.evaluate(() => {
          const state = window.__pdfReaderBridgeState;
          return { activeDocumentId: state?.activeDocumentId, activeOpenRequest: state?.activeOpenRequest,
            currentPageNumber: state?.app?.pdfViewer?.currentPageNumber,
            actualIdentity: state?.actualSourceIdentity && { status: state.actualSourceIdentity.identityStatus,
              pageIdentity: state.actualSourceIdentity.orderedPageIdentities?.[0] },
            currentResults: state?.readerBacklinkPageResults,
            currentPageElement: Boolean(document.querySelector(`.page[data-page-number="${state?.app?.pdfViewer?.currentPageNumber}"]`)) };
        });
        error.message += `\\nExpected Host result: ${JSON.stringify(result)}\\nBridge state trace: ${JSON.stringify(trace)}`;
        throw error;
      }
      await frame.waitForFunction(({ pageNumber, pageIdentity, backlinkCount }) => {
        const page = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
        const badge = page?.querySelector(":scope > .pdfReaderBacklinkPageBadge");
        if (backlinkCount === 0) return !badge;
        return badge?.dataset.backlinkTargetId === pageIdentity &&
          Number(badge.textContent.match(/\d+/)?.[0]) === backlinkCount;
      }, { timeout: 8_000 }, { pageNumber: result.pageNumber, pageIdentity: result.pageIdentity,
        backlinkCount: result.backlinkCount });
      return result;
    };
    const navigateMarkdownTargetInViewer = async (target) => {
      const before = await page.evaluate(() => window.__readerBacklinkE2E.opened
        .filter((row) => row.type === "navigation-result").length);
      await page.evaluate((target) => {
        const identity = window.__readerBacklinkE2E.identity;
        window.__readerHostPost({ type: "reader-anchor-navigate", documentId: identity.documentId,
          openRequest: identity.openRequest, target });
      }, target);
      try {
        await page.waitForFunction((count) => window.__readerBacklinkE2E.opened
          .filter((row) => row.type === "navigation-result").length === count + 1, { timeout: 8_000 }, before);
      } catch (error) {
        const trace = await page.evaluate(() => ({
          identity: window.__readerBacklinkE2E.identity,
          navigationResults: window.__readerBacklinkE2E.opened.filter((row) => row.type === "navigation-result"),
          bridgeMessages: window.__readerBacklinkE2E.messages.filter((message) =>
            message.type === "reader-anchor-navigation-result" || message.type === "error").slice(-8),
          protocolErrors: window.__readerBacklinkE2E.errors,
        }));
        error.message += `\nNavigation probe trace: ${JSON.stringify(trace)}`;
        throw error;
      }
      // Navigation acknowledges the target before scrollIntoView's smooth animation ends.
      // Trusted pointer geometry must be measured after both documents stop scrolling.
      await page.evaluate(() => { window.__backlinkScrollSettlement = { position: null, stableFrames: 0 }; });
      await page.waitForFunction(() => {
        const iframe = document.querySelector("iframe");
        const viewer = iframe?.contentDocument?.querySelector("#viewerContainer");
        const rect = iframe?.getBoundingClientRect();
        const position = [scrollX, scrollY, rect?.x, rect?.y, viewer?.scrollLeft, viewer?.scrollTop].join(",");
        const state = window.__backlinkScrollSettlement ||= { position: null, stableFrames: 0 };
        state.stableFrames = state.position === position ? state.stableFrames + 1 : 0;
        state.position = position;
        return state.stableFrames >= 8;
      }, { timeout: 5_000, polling: "raf" });
      return page.evaluate(() => window.__readerBacklinkE2E.opened
        .filter((row) => row.type === "navigation-result").at(-1));
    };
    const clickFramePoint = async (point) => {
      const currentFrameOffset = await page.$eval("iframe", (iframe) => iframe.getBoundingClientRect().toJSON());
      const viewer = await frame.evaluate((point) => ({ point,
        hit: document.elementFromPoint(point.x, point.y)?.outerHTML,
        currentPage: PDFViewerApplication.pdfViewer.currentPageNumber,
        ranges: [...(CSS.highlights.get("pdfReaderMarkdownBacklinks") || [])].map((range) => ({
          text: range.toString(), rects: [...range.getClientRects()].map((rect) => rect.toJSON()) })),
        activeRequest: window.__pdfReaderBridgeState?.readerBacklinkActiveRequest,
        controllerPage: window.__pdfReaderBridgeState?.backlinkInteractionController?.page,
        pageResults: window.__pdfReaderBridgeState?.readerBacklinkPageResults,
      }), point);
      gestureDiagnostics.push({ cachedFrameOffset: frameOffset, currentFrameOffset, viewer });
      await page.mouse.click(currentFrameOffset.x + point.x, currentFrameOffset.y + point.y);
    };
    const targetOpenCount = () => page.evaluate(() => window.__readerBacklinkE2E.messages.filter((message) => message.type === "reader-backlink-target-open").length);
    const pageBadgePoint = async (pageNumber, pageIdentity) => frame.evaluate(({ pageNumber, pageIdentity }) => {
      const page = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
      const node = page?.querySelector(":scope > .pdfReaderBacklinkPageBadge");
      if (!node || node.dataset.backlinkTargetId !== pageIdentity) {
        throw new Error(`Expected page ${pageNumber} badge for ${pageIdentity} was not painted`);
      }
      const rect = node.getBoundingClientRect();
      for (const fx of [0.5, 0.2, 0.8]) for (const fy of [0.5, 0.2, 0.8]) {
        const x = rect.left + rect.width * fx, y = rect.top + rect.height * fy;
        if (node.contains(document.elementFromPoint(x, y))) return { x, y };
      }
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(center.x, center.y);
      return { ...center, hit: hit?.className?.baseVal || hit?.className || hit?.nodeName,
        badge: node.outerHTML, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    }, { pageNumber, pageIdentity });

    // Real Viewer page target capture -> real index row -> page marker -> the new identity-only click protocol.
    const pageCapture = await requestCapture("capture-page-target", "backlinks");
    assert.equal(pageCapture.kind, "page");
    const pageLink = host.addMarkdownLink({ sourcePath: "Notes/Page.md", target: { kind: "page", id: pageCapture.pageIdentity },
      pageNumber: pageCapture.pageNumber, displayText: "Page source link", offset: 120 });
    const parsedPageLink = parseReaderLinkFragment(pageLink.link.slice(pageLink.link.indexOf("#") + 1));
    assert.deepEqual(parsedPageLink.target, { kind: "page", id: pageCapture.pageIdentity });
    const pageNavigation = await navigateMarkdownTargetInViewer({ kind: "page", id: parsedPageLink.target.id,
      pageIndex: pageCapture.pageIndex, pageIdentity: parsedPageLink.target.id });
    assert.equal(pageNavigation.ok, true, "the actual Viewer should accept the page target resolved from Markdown");
    await refreshPage();
    await frame.waitForSelector(".pdfReaderBacklinkPageBadge", { timeout: 8_000 });
    const pageBadge = await pageBadgePoint(pageCapture.pageNumber, pageCapture.pageIdentity);
    assert.equal(typeof pageBadge.hit, "undefined", `page badge must receive a real pointer hit: ${JSON.stringify(pageBadge)}`);
    await clickFramePoint(pageBadge);
    try {
      await page.waitForFunction(() => window.__readerBacklinkE2E.lastTargetResult?.targetKind === "page", { timeout: 5_000 });
    } catch (error) {
      const trace = await page.evaluate(() => ({
        clicks: window.__readerBacklinkE2EClicks,
        pageRequests: window.__readerBacklinkE2E.messages.filter((message) => message.type === "reader-backlink-page-request").map(({ requestId, pageNumber, pageIdentity }) => ({ requestId, pageNumber, pageIdentity })),
        targetMessages: window.__readerBacklinkE2E.messages.filter((message) => message.type === "reader-backlink-target-open"),
        targetResult: window.__readerBacklinkE2E.lastTargetResult,
        errors: window.__readerBacklinkE2E.errors,
      }));
      const viewerTrace = await frame.evaluate(() => ({
        currentPageNumber: PDFViewerApplication.pdfViewer.currentPageNumber,
        bridgePageResults: window.__pdfReaderBridgeState?.readerBacklinkPageResults,
        activePageRequest: window.__pdfReaderBridgeState?.readerBacklinkActiveRequest,
        controllerPage: window.__pdfReaderBridgeState?.backlinkInteractionController?.page,
      }));
      error.message += `\nPage badge interaction trace: ${JSON.stringify({ trace, viewerTrace, pageBadge })}`;
      throw error;
    }
    assert.equal(host.state.openedSources.at(-1)?.sourcePath, "Notes/Page.md");
    assert.equal(host.state.openedSources.at(-1)?.offset, 120);

    // Trusted pointer drag in the actual text layer -> Viewer capture -> immutable Anchor Store -> Markdown metadata/index -> CSS Highlight.
    const geometry = await frame.evaluate(() => {
      const page = document.querySelector('.page[data-page-number="1"]');
      const phrase = "Dynamic languages such as JavaScript";
      const span = [...(page?.querySelectorAll(".textLayer span") || [])].find((node) => (node.textContent || "").includes(phrase));
      const node = span?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("Selection fixture text is not in the rendered PDF text layer");
      const start = node.textContent.indexOf(phrase), end = start + phrase.length;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
      const first = document.createRange(); first.setStart(node, start); first.setEnd(node, start + 1);
      const last = document.createRange(); last.setStart(node, end - 1); last.setEnd(node, end);
      const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
      return { start: { x: a.left + 1, y: (a.top + a.bottom) / 2 }, end: { x: b.right - 1, y: (b.top + b.bottom) / 2 }, expected: range.toString() };
    });
    await page.mouse.move(frameOffset.x + geometry.start.x, frameOffset.y + geometry.start.y, { steps: 2 });
    await page.mouse.down({ button: "left" });
    await page.mouse.move(frameOffset.x + geometry.end.x, frameOffset.y + geometry.end.y, { steps: 12 });
    await page.mouse.up({ button: "left" });
    const selected = await frame.evaluate(() => ({ collapsed: getSelection()?.isCollapsed, text: getSelection()?.toString() }));
    assert.equal(selected.collapsed, false, "trusted drag should create a real noncollapsed PDF text selection");
    assert.equal(selected.text, geometry.expected);
    const selectionCapture = await requestCapture("capture-selection-target", "reader");
    const anchor = await host.createSelectionAnchor(selectionCapture, "Notes/Selection.md", 400);
    const selectionLink = host.markdownLinks.get("Notes/Selection.md")?.at(-1);
    assert.ok(selectionLink, "the mocked Markdown metadata must contain the newly created Selection link");
    const parsedSelectionLink = parseReaderLinkFragment(selectionLink.link.slice(selectionLink.link.indexOf("#") + 1));
    const storedAnchor = await host.anchorStore.get(docKey, parsedSelectionLink.target.id, documentId);
    assert.equal(storedAnchor.anchorId, anchor.anchorId, "the real Anchor Store must resolve the parsed Markdown target");
    const selectionNavigation = await navigateMarkdownTargetInViewer({ kind: "selection", id: parsedSelectionLink.target.id,
      pageIndex: storedAnchor.pageIndexHint, pageIdentity: storedAnchor.pageIdentity, anchor: storedAnchor });
    assert.equal(selectionNavigation.ok, true, "the actual Viewer should focus the Selection Anchor resolved from Markdown");
    assert.ok(await frame.evaluate(() => window.CSS?.highlights?.get("pdfReaderAnchorFocusText")?.size > 0),
      "the exact restored selection range must receive the Viewer temporary focus highlight");
    await refreshPage();
    await frame.waitForFunction(() => Boolean(window.CSS?.highlights?.get("pdfReaderMarkdownBacklinks")), { timeout: 8_000 });
    const selectionPoint = await frame.evaluate(() => {
      const ranges = [...(window.CSS.highlights.get("pdfReaderMarkdownBacklinks") || [])];
      const target = ranges.find((range) => range.toString().startsWith("Dynamic languages"));
      const rect = target?.getBoundingClientRect();
      if (!rect) throw new Error("The actual CSS Highlight range was not painted");
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const beforeSelectionOpen = await targetOpenCount();
    await clickFramePoint(selectionPoint);
    await page.waitForFunction((count) => window.__readerBacklinkE2E.messages.filter((message) => message.type === "reader-backlink-target-open").length === count + 1,
      { timeout: 5_000 }, beforeSelectionOpen);
    const selectionIntent = await page.evaluate(() => window.__readerBacklinkE2E.messages.findLast((message) => message.type === "reader-backlink-target-open"));
    assert.deepEqual({ targetKind: selectionIntent.targetKind, targetId: selectionIntent.targetId },
      { targetKind: "selection", targetId: anchor.anchorId });
    assert.equal(host.state.openedSources.at(-1)?.sourcePath, "Notes/Selection.md");
    assert.equal(host.state.openedSources.at(-1)?.offset, 400);
    assert.equal(host.state.openedSources.at(-1)?.endOffset, 400 + geometry.expected.length,
      "exact Markdown focus range should preserve both offset endpoints");

    // A repeated source creates multiple real index rows; the target protocol must not choose one by timestamp.
    host.addMarkdownLink({ sourcePath: "Notes/Selection-duplicate.md", target: { kind: "selection", id: anchor.anchorId },
      pageNumber: selectionCapture.pageNumber, displayText: geometry.expected, offset: 900 });
    await refreshPage();
    const duplicateBefore = await targetOpenCount();
    const refreshedSelectionPoint = await frame.evaluate((quote) => {
      const ranges = [...(window.CSS.highlights.get("pdfReaderMarkdownBacklinks") || [])];
      const target = ranges.find((range) => range.toString().startsWith(quote));
      if (!target) throw new Error(`Selection backlink range for ${quote} was not restored after page refresh`);
      const rect = target.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }, geometry.expected);
    await clickFramePoint(refreshedSelectionPoint);
    try {
      await page.waitForFunction((count) => window.__readerBacklinkE2E.messages.filter((message) => message.type === "reader-backlink-target-open").length > count,
        { timeout: 5_000 }, duplicateBefore);
    } catch (error) {
      const trace = await frame.evaluate(() => ({
        clicks: window.__backlinkE2EClicks,
        highlights: [...(window.CSS?.highlights?.get("pdfReaderMarkdownBacklinks") || [])].map((range) => ({
          text: range.toString(), rects: [...range.getClientRects()].map(({ x, y, width, height }) => ({ x, y, width, height })),
        })),
      }));
      error.message += `\\nDuplicate-source interaction trace: ${JSON.stringify(trace)}`;
      throw error;
    }
    await page.waitForFunction(() => window.__readerBacklinkE2E.lastTargetResult?.rowCount === 2, { timeout: 5_000 });
    assert.equal(host.state.modalRows.length, 2, "multiple source rows should be routed to the existing modal boundary");

    // Markdown rename is an incremental source replacement, not a vault rescan; the next Viewer intent resolves the new path.
    host.index.removeFile("Notes/Page.md");
    host.markdownLinks.delete("Notes/Page.md");
    host.addMarkdownLink({ sourcePath: "Notes/Page-renamed.md", target: { kind: "page", id: pageCapture.pageIdentity },
      pageNumber: pageCapture.pageNumber, displayText: "Page source after rename", offset: 220 });
    await refreshPage();
    const refreshedPageSelector = `.page[data-page-number="${pageCapture.pageNumber}"] > .pdfReaderBacklinkPageBadge`;
    const badgeDiagBefore = await frame.$eval(refreshedPageSelector, (node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return { pageNumber: node.closest(".page")?.dataset.pageNumber,
        pageIdentity: node.dataset.backlinkTargetId,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        hit: hit?.className?.baseVal || hit?.className || hit?.nodeName,
        hitPath: document.elementsFromPoint(x, y).slice(0, 5).map((element) => ({
          tag: element.tagName, className: element.className?.baseVal || element.className || "",
          pageNumber: element.closest?.(".page")?.dataset.pageNumber || null,
          isBadge: element === node || node.contains(element),
        })),
        zIndex: getComputedStyle(node).zIndex, pointerEvents: getComputedStyle(node).pointerEvents,
        html: node.outerHTML };
    });
    const opensBeforeRenameBadge = await targetOpenCount();
    await frame.click(refreshedPageSelector);
    await page.waitForFunction(count => window.__readerBacklinkE2E.messages.filter(message => message.type === 'reader-backlink-target-open').length === count + 1,
      { timeout: 5_000 }, opensBeforeRenameBadge);
    const renameBadgeClicks = await frame.evaluate(() => window.__backlinkE2EClicks.slice(-2));
    const badgeDiagAfter = await frame.evaluate(() => ({
      lastClick: window.__backlinkE2EClicks.at(-1),
      hostOpenMessages: window.parent.__readerBacklinkE2E?.messages?.filter((message) => message.type === "reader-backlink-target-open").length,
    }));
    try {
      await page.waitForFunction(() => window.__readerBacklinkE2E.lastTargetResult?.targetKind === "page" &&
        window.__readerBacklinkE2E.lastTargetResult.rowCount === 1, { timeout: 5_000 });
    } catch (error) {
      const trace = {
        messages: await targetOpenCount(),
        lastTargetResult: await page.evaluate(() => window.__readerBacklinkE2E.lastTargetResult),
        click: badgeDiagAfter,
        clicks: renameBadgeClicks,
        badgeBefore: badgeDiagBefore,
      };
      error.message += `\\nRenamed-page interaction trace: ${JSON.stringify(trace)}`;
      throw error;
    }
    assert.equal(host.state.openedSources.at(-1)?.sourcePath, "Notes/Page-renamed.md");
    assert.equal(host.state.openedSources.at(-1)?.offset, 220);

    // PDF rename follows Obsidian's incremental metadata refresh contract: the renamed Markdown link is re-indexed once.
    const renamedPdfPath = "Books/tracemonkey-renamed.pdf";
    const oldPageLinks = host.markdownLinks.get("Notes/Page-renamed.md") || [];
    host.markdownLinks.set("Notes/Page-renamed.md", oldPageLinks.map((entry) => ({ ...entry,
      link: `${renamedPdfPath}#${entry.link.split("#").slice(1).join("#")}` })));
    host.index.replaceFile({ path: "Notes/Page-renamed.md" }, { links: host.markdownLinks.get("Notes/Page-renamed.md") });
    host.state.currentPdfPath = renamedPdfPath;
    const renamedIndex = await host.pageIndexFor();
    assert.ok(renamedIndex.forPage(pageCapture.pageIdentity).rows.some((row) => row.sourcePath === "Notes/Page-renamed.md"),
      "after Obsidian updates the Markdown route, the existing index resolves the renamed PDF without a new index");

    // Annotation target capture is tied to an actual live PDF.js editor; deletion remains row history but loses its live badge.
    await frame.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { mode: 9 }));
    await frame.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 9, { timeout: 8_000 });
    const annotationGeometry = await frame.evaluate(() => {
      const phrase = "Trace-based Just-in-Time Type Specialization";
      const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].find((node) => (node.textContent || "").includes(phrase));
      const node = span?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error("Could not locate annotation fixture text");
      const start = node.textContent.indexOf(phrase), end = start + phrase.length;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end);
      const rect = range.getBoundingClientRect(); return { x: rect.left + 4, y: rect.top + rect.height / 2, width: rect.width };
    });
    await page.mouse.move(frameOffset.x + annotationGeometry.x, frameOffset.y + annotationGeometry.y, { steps: 2 });
    await page.mouse.down({ button: "left" });
    await page.mouse.move(frameOffset.x + annotationGeometry.x + annotationGeometry.width, frameOffset.y + annotationGeometry.y, { steps: 10 });
    await page.mouse.up({ button: "left" });
    await frame.waitForSelector(".annotationEditorLayer .selectedEditor", { timeout: 8_000 });
    const annotationCapture = await requestCapture("capture-annotation-target", "annotation");
    const annotationId = annotationCapture.annotationUuid;
    assert.ok(annotationId, "the Viewer must return the stable UUID of a selected live annotation");
    // E2E-4: trusted Viewer Highlight -> real Sidebar -> real learning draft and
    // durable coordinator/History -> actual Workbench -> exact Viewer UUID.
    // Obsidian Modal/Workspace and Vault DataAdapter are explicit test boundaries.
    await frame.$eval('#secondaryToolbarToggleButton', button => button.click());
    await frame.click('#secondaryDownload');
    await page.waitForFunction(id => window.__browserSidecarHost.snapshotFor(id)?.annotations.some(row => row.payload?.editor?.text), { timeout: 10_000 }, documentId);
    const persistedHighlight = await page.evaluate(({ id, uuid }) => window.__browserSidecarHost.snapshotFor(id).annotations.find(row => row.uuid === uuid), { id: documentId, uuid: annotationId });
    assert.ok(persistedHighlight?.payload.editor.text, 'actual captured targetText must be persisted');
    await frame.$eval('#pdfReaderAnnotationSidebarButton', button => button.click());
    const reviewSelector = `#editorCommentsSidebarList li.sidebarComment[data-uuid="${annotationId}"] .pdfReaderAnnotationReviewButton`;
    await frame.waitForFunction(selector => { const button = document.querySelector(selector); return button && !button.disabled; }, { timeout: 10_000 }, reviewSelector);
    await frame.click(reviewSelector);
    await page.waitForFunction(() => window.__learningBrowser.draft || window.__learningBrowser.errors.length, { timeout: 10_000 });
    assert.deepEqual(await page.evaluate(() => window.__learningBrowser.errors), []);
    assert.equal(await page.$eval('textarea[aria-label="答案"]', node => node.value), persistedHighlight.payload.editor.text);
    assert.equal(await page.evaluate(() => window.__learningBrowser.adapter.files.size), 0, 'draft opening performs no canonical writes');
    await page.type('textarea[aria-label="问题"]', 'What is this exact Highlight?');
    await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent === '确认加入复习').click());
    await page.waitForFunction(() => window.__learningBrowser.draft.confirmed || window.__learningBrowser.draft.lastError, { timeout: 10_000 });
    assert.equal(await page.evaluate(() => window.__learningBrowser.draft.lastError?.message || null), null);
    const learningEvidence = await page.evaluate(async () => {
      const state = window.__learningBrowser;
      const service = await state.host.getService();
      const page = await service.listDue({ limit: 10 });
      return { items: page.items, files: [...state.adapter.files.keys()], request: state.request };
    });
    assert.equal(learningEvidence.items.length, 1);
    const learned = learningEvidence.items[0];
    assert.equal(learned.source.target.id, annotationId);
    assert.equal(learned.source.sourceHash, sourceHash);
    assert.equal(learned.source.pageIdentity, annotationCapture.pageIdentity);
    assert.equal(learned.source.documentId, documentId);
    assert.equal(learned.source.docKey, docKey);
    assert.equal(learned.answer, persistedHighlight.payload.editor.text);
    assert.equal(learningEvidence.request.uuid, annotationId);
    assert.ok(learningEvidence.files.some(name => name.includes('/history/')), 'confirmation creates real immutable History');
    assert.ok(learningEvidence.files.every(name => !name.endsWith('.pdf') && !name.includes('20_PDFData')));
    await page.evaluate(() => window.__learningBrowser.openReview());
    await page.waitForSelector('[data-role="review-row"][data-provider-id="learning"]', { timeout: 10_000 });
    await page.click('[data-role="review-row"][data-provider-id="learning"] button');
    await page.waitForFunction(uuid => window.__learningBrowser.opened.some(row => row.target.id === uuid), { timeout: 8_000 }, annotationId);
    await frame.waitForFunction(uuid => {
      const editor = document.querySelector('.annotationEditorLayer .selectedEditor');
      return editor && window.__pdfReaderBridgeState.annotationUuidByRuntimeId.get(editor.id) === uuid;
    }, { timeout: 8_000 }, annotationId);
    assert.equal(createHash('sha256').update(await readFile(fixture)).digest('hex'), sourceSha256, 'source SHA-256 remains unchanged');
    assert.equal(await frame.evaluate(() => window.__learningSourceSaveCalls), 0, 'ordinary annotation/learning saves never call PDF saveDocument');
    await page.evaluate(receipt => { window.__learningBrowser.receipt = receipt; }, {
      stage: 'E2E-4 assertions passed', itemId: learned.itemId, source: learned.source,
      answer: learned.answer, sourceSha256, canonicalFiles: learningEvidence.files,
      boundary: 'mocked Obsidian Modal/Workspace/DataAdapter; real Host/draft/Workbench/coordinator/shards/History',
    });
    await frame.$eval('#editorCommentsSidebarCloseButton', button => button.click());
    host.state.annotationIds.push(annotationId);
    host.state.annotations.push({ uuid: annotationId, pageIndex: annotationCapture.pageIndex, deleted: false });
    const annotationLink = host.addMarkdownLink({ sourcePath: "Notes/Annotation.md", target: { kind: "annotation", id: annotationId },
      pageNumber: annotationCapture.pageNumber, displayText: "Annotation source", offset: 700 });
    const parsedAnnotationLink = parseReaderLinkFragment(annotationLink.link.slice(annotationLink.link.indexOf("#") + 1));
    assert.equal(parsedAnnotationLink.target.id, annotationId);
    const annotationNavigation = await navigateMarkdownTargetInViewer({ kind: "annotation", id: annotationId,
      pageIndex: annotationCapture.pageIndex, pageIdentity: annotationCapture.pageIdentity });
    assert.equal(annotationNavigation.ok, true, "the Viewer should resolve the annotation UUID to its existing editor");
    await refreshPage();
    await frame.waitForSelector(".pdfReaderAnnotationBacklinkBadge", { timeout: 8_000 });
    const annotationBadge = await frame.$eval(".pdfReaderAnnotationBacklinkBadge", (node) => { const r = node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const beforeToolBadge = await targetOpenCount();
    await clickFramePoint(annotationBadge);
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await targetOpenCount(), beforeToolBadge, 'active Highlight tool owns the pointer and cannot open a backlink');
    await frame.evaluate(() => PDFViewerApplication.eventBus.dispatch('switchannotationeditormode', { mode: 0 }));
    await frame.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 0, { timeout: 8_000 });
    // The earlier Highlight gesture opens its real parameter popup. Close it
    // through an outside trusted click before attempting the badge underneath.
    const badgeBeforeDismiss = await frame.$eval('.pdfReaderAnnotationBacklinkBadge', node => {
      const rect = node.getBoundingClientRect();
      return { rect: rect.toJSON(), hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML };
    });
    gestureDiagnostics.push({ annotationBadgeBeforePopupDismiss: badgeBeforeDismiss });
    await frame.click('#pageNumber');
    await frame.evaluate(() => { window.__annotationBadgeSettlement = { rect: null, stable: 0 }; });
    await frame.waitForFunction(() => {
      const badge = document.querySelector('.pdfReaderAnnotationBacklinkBadge');
      if (!badge) return false;
      const rect = JSON.stringify(badge.getBoundingClientRect().toJSON());
      const state = window.__annotationBadgeSettlement;
      state.stable = state.rect === rect ? state.stable + 1 : 0; state.rect = rect;
      return state.stable >= 8;
    }, { timeout: 5_000, polling: 'raf' });
    const badgeAfterDismiss = await frame.$eval('.pdfReaderAnnotationBacklinkBadge', node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { rect: rect.toJSON(), hit: hit?.outerHTML, hitsBadge: hit === node || node.contains(hit) };
    });
    gestureDiagnostics.push({ annotationBadgeAfterPopupDismiss: badgeAfterDismiss });
    assert.equal(badgeAfterDismiss.hitsBadge, true, JSON.stringify(badgeAfterDismiss));
    await frame.evaluate(() => {
      const state = window.__pdfReaderBridgeState;
      window.__annotationBadgeRouting = [];
      const routerIntent = state.inputRouter.onIntent;
      state.inputRouter.onIntent = (intent, controls) => {
        const point = intent.clientPoint;
        window.__annotationBadgeRouting.push({ router: true, type: intent.type,
          targetRole: intent.targetRole, targetRegion: intent.targetRegion, point,
          mode: state.editorMode, managerMode: PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getMode(),
          hit: Number.isFinite(point?.x) && Number.isFinite(point?.y) ? document.elementFromPoint(point.x, point.y)?.outerHTML?.slice(0, 1000) : null,
          activeElement: document.activeElement?.outerHTML?.slice(0, 500) });
        return routerIntent(intent, controls);
      };
      for (const type of ['focusin', 'focusout']) window.addEventListener(type, event => {
        window.__annotationBadgeRouting.push({ focus: type, target: event.target?.outerHTML?.slice(0, 500), mode: state.editorMode });
      }, true);
      const controller = state.backlinkInteractionController;
      const routed = controller.handleRoutedPointerEvent.bind(controller);
      controller.handleRoutedPointerEvent = (intent, controls) => {
        const point = intent.clientPoint;
        const before = { type: intent.type, point, targetRegion: intent.targetRegion,
          canActivate: controller.canActivate(), mode: state.editorMode,
          pdfMode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          hit: point && document.elementFromPoint(point.x, point.y)?.outerHTML,
          selectedEditor: document.querySelector('.selectedEditor')?.id };
        const result = routed(intent, controls);
        window.__annotationBadgeRouting.push({ ...before, result, afterMode: state.editorMode,
          afterHit: point && document.elementFromPoint(point.x, point.y)?.outerHTML });
        return result;
      };
    });
    const beforeReadBadgeOpen = await targetOpenCount();
    await frame.click('.pdfReaderAnnotationBacklinkBadge');
    await page.waitForFunction(() => window.__readerBacklinkE2E.lastTargetResult?.targetKind === "annotation", { timeout: 5_000 });
    assert.equal(await targetOpenCount(), beforeReadBadgeOpen + 1, 'one owned badge gesture opens its exact source once');
    const ownedBadgeTrace = await frame.evaluate(() => window.__annotationBadgeRouting.filter(row => row.router && ['pointerdown', 'pointerup', 'click'].includes(row.type)));
    assert.ok(ownedBadgeTrace.some(row => row.type === 'click'));
    assert.ok(ownedBadgeTrace.every(row => row.mode === 0), JSON.stringify(ownedBadgeTrace));
    assert.equal(host.state.openedSources.at(-1)?.sourcePath, "Notes/Annotation.md");
    const beforeKeyboardBadgeOpen = await targetOpenCount();
    await frame.focus('.pdfReaderAnnotationBacklinkBadge');
    await page.keyboard.press('Enter');
    await page.waitForFunction(count => window.__readerBacklinkE2E.messages.filter(message => message.type === 'reader-backlink-target-open').length === count + 1,
      { timeout: 5_000 }, beforeKeyboardBadgeOpen);
    assert.equal(await frame.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode), 0,
      'keyboard badge focus must not activate its containing Highlight tool');
    const contextLearningEvidence = await runLearningContextBrowserFlow({ page, frame, methodSource: productionMethodSource, sourceHash });
    assert.equal(createHash('sha256').update(await readFile(fixture)).digest('hex'), sourceSha256);
    assert.equal(await frame.evaluate(() => window.__learningSourceSaveCalls), 0);

    host.state.annotations = [];
    host.state.tombstones = [{ uuid: annotationId, pageIndex: annotationCapture.pageIndex }];
    await refreshPage();
    assert.equal(await frame.$$eval(".pdfReaderAnnotationBacklinkBadge", (nodes) => nodes.length), 0,
      "a deleted annotation remains in tombstone resolution but must not render an active annotation badge");
    const tombstonePage = await host.pageIndexFor();
    const deletedRow = tombstonePage.forPage(annotationCapture.pageIdentity).rows.find((row) =>
      row.target.kind === "annotation" && row.target.id === annotationId);
    assert.equal(deletedRow?.targetStatus, "deleted");

    // A stale source hash must fail closed in the actual Viewer target navigator; no alternate text/geometry is guessed.
    const mismatchAnchor = { ...anchor, sourceHash: "xxh64-v1:0000000000000000" };
    await page.evaluate(({ anchor, pageIndex, pageIdentity }) => window.__readerHostPost({
      type: "reader-anchor-navigate", documentId: window.__readerBacklinkE2E.identity.documentId,
      openRequest: window.__readerBacklinkE2E.identity.openRequest,
      target: { kind: "selection", id: anchor.anchorId,
        pageIndex, pageIdentity, anchor },
    }), { anchor: mismatchAnchor, pageIndex: selectionCapture.pageIndex, pageIdentity: selectionCapture.pageIdentity });
    await page.waitForFunction(() => window.__readerBacklinkE2E.opened.some((row) =>
      row.type === "navigation-result" && row.kind === "selection"), { timeout: 5_000 });
    const mismatch = await page.evaluate(() => window.__readerBacklinkE2E.opened.findLast((row) => row.type === "navigation-result" && row.kind === "selection"));
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, "source-or-page-mismatch");
    assert.equal(host.state.protocolErrors.length, 0, "all Viewer requests must retain the exact active session identity");

    t.diagnostic(JSON.stringify({
      browser: "real Chromium PDF.js Viewer iframe + real obsidian-bridge.js",
      hostBoundary: "mocked Obsidian Workspace/editor; actual reader-anchor-store and reader-backlink-index modules",
      selectionAnchorId: anchor.anchorId,
      annotationUuid: annotationId,
      learning: { itemId: learned.itemId, source: learned.source, answer: learned.answer,
        canonicalFiles: learningEvidence.files, sourceSha256,
        boundary: 'mocked Obsidian Modal/Workspace/DataAdapter; real Host/draft/Workbench/coordinator/shards/History',
        contextFlow: contextLearningEvidence },
      sourceOpenings: host.state.openedSources,
      modalRows: host.state.modalRows,
      currentPdfPathAfterRename: host.state.currentPdfPath,
      sourceHashMismatch: { ok: mismatch.ok, reason: mismatch.reason },
    }));
    const successDirectory = path.join(root, "test-results", `backlink-success-${Date.now()}-${process.pid}`);
    diagnosticDirectory = successDirectory;
    await mkdir(successDirectory, { recursive: true });
    await writeFile(path.join(successDirectory, "trace.json"), JSON.stringify({ gestureDiagnostics,
      learning: { itemId: learned.itemId, source: learned.source, answer: learned.answer, canonicalFiles: learningEvidence.files, sourceSha256 },
      host: await page.evaluate(() => window.__readerBacklinkE2E) }, null, 2));
    t.diagnostic(`Success artifacts: ${successDirectory}`);
  } catch (error) {
    primaryError = error;
    if (page && !page.isClosed()) {
      const artifactDirectory = path.join(root, "test-results", `backlink-failure-${Date.now()}-${process.pid}`);
      diagnosticDirectory = artifactDirectory;
      await mkdir(artifactDirectory, { recursive: true });
      const trace = await page.evaluate(() => ({ host: window.__readerBacklinkE2E,
        learning: window.__learningBrowser && { receipt: window.__learningBrowser.receipt,
          errors: window.__learningBrowser.errors, request: window.__learningBrowser.request,
          draftError: window.__learningBrowser.draft?.lastError?.message,
          contextDraftError: window.__learningBrowser.contextDraft?.lastError?.message,
          canonicalFiles: [...window.__learningBrowser.adapter.files.keys()] },
        iframeRect: document.querySelector("iframe")?.getBoundingClientRect().toJSON() }));
      const viewer = page.frames().find((candidate) => candidate.url().includes("/web/viewer.html"));
      const viewerTrace = viewer && await viewer.evaluate(() => ({ clicks: window.__backlinkE2EClicks,
        annotationBadgeRouting: window.__annotationBadgeRouting,
        currentPage: PDFViewerApplication.pdfViewer.currentPageNumber,
        selection: getSelection()?.toString(),
        highlights: [...(CSS.highlights.get("pdfReaderMarkdownBacklinks") || [])].map((range) => ({
          text: range.toString(), rects: [...range.getClientRects()].map((rect) => {
            const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
            return { ...rect.toJSON(), hit: document.elementFromPoint(x, y)?.outerHTML };
          }) })),
        pageResults: window.__pdfReaderBridgeState?.readerBacklinkPageResults,
        activeRequest: window.__pdfReaderBridgeState?.readerBacklinkActiveRequest,
        controllerPage: window.__pdfReaderBridgeState?.backlinkInteractionController?.page }));
      await writeFile(path.join(artifactDirectory, "trace.json"), JSON.stringify({ error: error.stack, gestureDiagnostics, trace, viewerTrace }, null, 2));
      await page.screenshot({ path: path.join(artifactDirectory, "failure.png") });
      error.message += `\nFailure artifacts: ${artifactDirectory}`;
    }
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
    if (diagnosticDirectory) await writeFile(path.join(diagnosticDirectory, "cleanup.json"), JSON.stringify(cleanupReport, null, 2));
  }
  const error = attachCleanupErrors(primaryError, cleanupReport);
  if (error) throw error;
});
