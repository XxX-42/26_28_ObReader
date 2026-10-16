import assert from "node:assert/strict";
import { teardownViewerPage } from "./browser-viewer-teardown.mjs";
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
const token = `highlight-multiline-${Date.now()}-${process.pid}`;
const documentPath = "tests/fixtures/tracemonkey.pdf";
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"], [".svg", "image/svg+xml"], [".wasm", "application/wasm"],
]);

function legacyCaptureDiagnostic(source) {
  const currentGuard = `  function shouldCaptureTrackedPointer(pointer, intent, eraserActive) {
    const plainMouseTextSelection =
      pointer.pointerType === "mouse" &&
      pointer.kind === "text-selection" &&
      !pointer.nativeOperation;
    return !plainMouseTextSelection &&
      (intent.pointerType === "mouse" || pointer.nativeOperation) &&
      intent.button !== 2 &&
      !(intent.button === 0 && eraserActive);
  }`;
  const oldBehavior = `  function shouldCaptureTrackedPointer(pointer, intent, eraserActive) {
    return (intent.pointerType === "mouse" || pointer.nativeOperation) &&
      intent.button !== 2 &&
      !(intent.button === 0 && eraserActive);
  }`;
  assert.equal(source.split(currentGuard).length - 1, 1,
    "The diagnostic transform must find exactly one current capture guard in the concatenated runtime modules");
  return source.replace(currentGuard, oldBehavior);
}

test("mode-9 highlighter preserves exact one-, two-, and four-line selections", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 180_000,
}, async (t) => {
  await mkdir(artifacts, { recursive: true });
  const viewerHtml = await readFile(viewerHtmlPath, "utf8");
  const bridgeSource = await readBridgeRuntimeSource(bridgePath);
  const instrumentedBridge = bridgeSource.replace(
    "  if (iosInputPolicy) {",
    "  window.__highlightMultilineBridgeState = state;\n  if (iosInputPolicy) {",
  );
  assert.notEqual(instrumentedBridge, bridgeSource, "The test should expose bridge state only for diagnostics");
  const oldCaptureSource = legacyCaptureDiagnostic(instrumentedBridge);
  const sidecarScript = browserSidecarHarnessScript({ channel, token });
  const trace = {
    schemaVersion: 1,
    fixture: documentPath,
    observedAt: new Date().toISOString(),
    intent: "Diagnose trusted mouse selection and mode-9 highlighter output at 1, 2, and 4 visual text lines.",
    variants: {
      candidate: "Current bridge capture guard and frozen vendored PDF.js viewer.",
      legacyCaptureDiagnostic: "Test-only transform restores the previous mouse-text-selection capture predicate; not a byte-identical old bridge build.",
    },
    results: [],
    privacy: "Artifacts retain selected-text lengths, range endpoints, geometry, quads, and sidecar payloads; they do not store selected PDF text.",
  };
  const artifactPath = path.join(artifacts, `highlight-multiline-regression-${Date.now()}-${process.pid}.json`);
  let browser;
  let server;
  let activePage;
  let primaryError = null;
  let cleanupReport = null;

  server = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(withTestNetworkFirewall())) response.setHeader(name, value);
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      const variant = ["candidate", "legacy-capture-diagnostic"].includes(url.searchParams.get("variant"))
        ? url.searchParams.get("variant")
        : "candidate";
      const rendererGeneration = `highlight-multiline-${variant}-${Date.now()}`;
      const documentId = `${documentPath}#highlight-multiline-${variant}`;
      const viewerUrl = `/viewer/web/viewer.html?variant=${variant}&generation=${encodeURIComponent(rendererGeneration)}&documentId=${encodeURIComponent(documentId)}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="Highlight multiline regression" src="${viewerUrl}"></iframe>${sidecarScript}<script>
          (()=>{
            const channel=${JSON.stringify(channel)},token=${JSON.stringify(token)};
            const rendererGeneration=${JSON.stringify(rendererGeneration)},documentId=${JSON.stringify(documentId)},documentPath=${JSON.stringify(documentPath)};
            const iframe=document.querySelector('iframe');
            const trace=window.__highlightMultilineHost={variant:${JSON.stringify(variant)},rendererGeneration,documentId,ready:[],opened:[],identity:[],errors:[],saves:[],openSent:false,sourceBytes:null,nextOpenRequest:0};
            const sendOpen=openRequest=>{
              if(!(trace.sourceBytes instanceof ArrayBuffer))throw new Error('PDF fixture bytes are not ready');
              const data=trace.sourceBytes.slice(0);
              iframe.contentWindow.postMessage({channel,type:'open',token,rendererGeneration,documentId,documentPath,filename:'tracemonkey.pdf',
                openRequest,data,autoSave:false,readOnly:false,revision:0,confirmedRevision:0,restoreDirty:false,restorePaused:false},'*',[data]);
            };
            trace.reopen=()=>{trace.nextOpenRequest+=1;sendOpen(trace.nextOpenRequest);return trace.nextOpenRequest;};
            window.addEventListener('message',event=>{
              if(event.source!==iframe.contentWindow||!event.data||event.data.channel!==channel||event.data.token!==token)return;
              const message=event.data;
              if(message.type==='ready'){
                trace.ready.push({at:performance.now(),rendererGeneration:message.rendererGeneration||null});
                if(trace.openSent||message.rendererGeneration!==rendererGeneration)return;
                trace.openSent=true;
                fetch('/tests/fixtures/tracemonkey.pdf').then(response=>{if(!response.ok)throw new Error('fixture fetch failed');return response.arrayBuffer();}).then(bytes=>{
                  trace.sourceBytes=bytes;trace.nextOpenRequest=1;sendOpen(1);
                }).catch(error=>trace.errors.push(String(error?.message||error)));
              }else if(message.type==='annotation-source-identity'){
                trace.identity.push({at:performance.now(),documentId:message.documentId,openRequest:message.openRequest,identityStatus:message.identityStatus,pageCount:message.pageCount});
              }else if(message.type==='opened'){
                trace.opened.push({at:performance.now(),documentId:message.documentId,openRequest:message.openRequest,revision:message.revision,confirmedRevision:message.confirmedRevision});
              }else if(message.type==='save'){
                trace.saves.push({at:performance.now(),documentId:message.documentId,openRequest:message.openRequest,requestId:message.requestId,revision:message.revision,operationCount:message.operations?.length||0});
                setTimeout(()=>iframe.contentWindow.postMessage({channel,type:'saved',token,documentId:message.documentId,openRequest:message.openRequest,
                  rendererGeneration:message.rendererGeneration,requestId:message.requestId,revision:message.revision,
                  external:true,operationCount:message.operations?.length||0,
                  batchId:message.operations?.length?'test-'+message.requestId:null},'*'),10);
              }else if(message.type==='error')trace.errors.push({code:message.code||null,message:String(message.message||'').slice(0,300)});
            });
          })();
        </script>`);
      return;
    }
    if (url.pathname === "/viewer/web/viewer.html") {
      const variant = url.searchParams.get("variant") || "candidate";
      const rendererGeneration = url.searchParams.get("generation") || "";
      const html = viewerHtml.replace(/<head\b[^>]*>/i, (head) => `${head}<script src="/viewer/obsidian-bridge.js?variant=${variant}" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}"></script>`);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (url.pathname === "/viewer/obsidian-bridge.js") {
      const source = url.searchParams.get("variant") === "legacy-capture-diagnostic" ? oldCaptureSource : instrumentedBridge;
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    let target;
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

  const persistEvidence = async (phase) => {
    trace.lastPersistedPhase = phase;
    await writeFile(artifactPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
    t.diagnostic(`Highlight multiline evidence (${phase}): ${artifactPath}`);
  };

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "highlight-multiline-regression", artifactsDir: artifacts });

    for (const variant of ["candidate", "legacy-capture-diagnostic"]) {
      const page = await browser.newPage();
      activePage = page;
      await page.setViewport({ width: 1280, height: 900 });
      await page.evaluateOnNewDocument(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      const result = { variant, interactions: [], errors: [] };
      trace.results.push(result);
      page.on("pageerror", (error) => result.errors.push({ source: "pageerror", message: String(error.message).slice(0, 400) }));
      page.on("console", (message) => { if (message.type() === "error") result.errors.push({ source: "console", message: String(message.text()).slice(0, 400) }); });
      page.on("requestfailed", (request) => result.errors.push({ source: "requestfailed", url: request.url(), message: request.failure()?.errorText || null }));
      await page.goto(`http://127.0.0.1:${server.address().port}/?variant=${variant}`, { waitUntil: "domcontentloaded" });
      const frame = await page.waitForFrame((candidate) => candidate.parentFrame() &&
        candidate.url().includes("/viewer/web/viewer.html?") && candidate.url().includes(`variant=${variant}`), { timeout: 35_000 });
      assert.ok(frame, `Viewer frame did not initialize for ${variant}`);
      const hostInfo = await page.evaluate(() => window.__highlightMultilineHost);
      result.documentId = hostInfo.documentId;
      result.rendererGeneration = hostInfo.rendererGeneration;
      await page.waitForFunction((documentId) =>
        window.__highlightMultilineHost?.opened?.some((event) => event.documentId === documentId && event.openRequest === 1) ||
        window.__highlightMultilineHost?.errors?.length > 0,
      { timeout: 35_000 }, hostInfo.documentId);
      await page.waitForFunction((documentId) =>
        window.__browserSidecarHost?.identityRequests?.some((event) => event.documentId === documentId && event.openRequest === 1),
      { timeout: 20_000 }, hostInfo.documentId);
      await frame.waitForFunction(() => {
        const bridge = window.__highlightMultilineBridgeState;
        return Boolean(PDFViewerApplication?.pdfDocument && bridge?.externalSourceConfirmed &&
          document.getElementById("editorHighlightButton") && !document.getElementById("editorHighlightButton").disabled);
      }, { timeout: 25_000 });
      await frame.waitForSelector('.page[data-page-number="1"] .textLayer span', { timeout: 40_000 });
      await frame.evaluate((source) => {
        window.__highlightMultilineProbe = { trace: {} };
        const install = (0, eval)(`(${source})`);
        window.__highlightMultilineProbe.cleanup = install({ d: document, w: window, a: PDFViewerApplication, trace: window.__highlightMultilineProbe.trace });
      }, installNativeSelectionProbe.toString());

      await frame.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { mode: 9 }));
      await frame.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 9, { timeout: 8_000 });
      const usedBands = [];
      const frameOffset = await page.$eval("iframe", (iframe) => {
        const rect = iframe.getBoundingClientRect();
        return { x: rect.left, y: rect.top };
      });

      for (const requestedLines of [1, 2, 4]) {
        const pageNumber = requestedLines === 4 ? 2 : 1;
        const pageIndex = pageNumber - 1;
        const scenarioUsedBands = requestedLines === 4 ? [] : usedBands;
        if (pageNumber > 1) {
          await frame.evaluate(async (number) => {
            const container = document.getElementById("viewerContainer");
            const page = document.querySelector(`.page[data-page-number="${number}"]`);
            if (!container || !page) throw new Error(`Page ${number} is not available for scrolling`);
            container.scrollTop = page.offsetTop - 90;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }, pageNumber);
          await frame.waitForSelector(`.page[data-page-number="${pageNumber}"] .textLayer span`, { timeout: 20_000 });
        }
        const target = await frame.evaluate(({ requestedLines, usedBands, pageNumber }) => {
          const page = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
          const grouped = [];
          for (const span of page?.querySelectorAll(".textLayer span") || []) {
            const text = span.textContent || "";
            const node = span.firstChild;
            const rect = span.getBoundingClientRect();
            if (!text.trim() || node?.nodeType !== Node.TEXT_NODE || rect.width <= 0 || rect.height <= 0 ||
                rect.top < 115 || rect.bottom > window.innerHeight - 35 || rect.left < 25 || rect.right > window.innerWidth - 25) continue;
            let row = grouped.find((candidate) => Math.abs(candidate.y - rect.top) <= 2.5);
            if (!row) { row = { y: rect.top, cells: [] }; grouped.push(row); }
            row.cells.push({ span, node, text, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
          }
          grouped.sort((a, b) => a.y - b.y);
          for (const row of grouped) row.cells.sort((a, b) => a.left - b.left);
          const pageRect = page.getBoundingClientRect();
          const columnDivider = pageRect.left + pageRect.width / 2;
          const lineRows = (rects) => {
            const ys = [];
            for (const rect of rects) {
              if (!ys.some((y) => Math.abs(y - rect.top) <= 2.5)) ys.push(rect.top);
            }
            return ys.length;
          };
          const sameColumnRows = (column) => grouped.map((row) => ({
            ...row,
            cells: row.cells.filter((cell) => column === "left" ? cell.left < columnDivider : cell.left >= columnDivider),
          })).filter((row) => row.cells.length > 0);
          const columns = pageNumber === 2 ? ["left", "right"] : [null];
          for (const column of columns) {
            const columnRows = column === null ? grouped : sameColumnRows(column);
            for (let firstIndex = 0; firstIndex <= columnRows.length - requestedLines; firstIndex += 1) {
            const rows = columnRows.slice(firstIndex, firstIndex + requestedLines);
            if (rows.some((row) => row.cells.length === 0)) continue;
            if (rows.some((row, index) => index > 0 && (row.y - rows[index - 1].y < 8 || row.y - rows[index - 1].y > 32))) continue;
            if (rows.some((row) => usedBands.some((band) => row.y >= band.top - 3 && row.y <= band.bottom + 3))) continue;
            const leadingXs = rows.map((row) => row.cells[0].left);
            // Keep the selection within one text column while allowing the
            // PDF's indented first/continuation lines to shift the left edge.
            if (Math.max(...leadingXs) - Math.min(...leadingXs) > 180) continue;
            const first = rows[0].cells[0];
            const last = rows.at(-1).cells.at(-1);
            const range = document.createRange();
            range.setStart(first.node, 0);
            range.setEnd(last.node, last.node.textContent.length);
            const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
            if (lineRows(rects) !== requestedLines || rects.some((rect) => rect.top < 100 || rect.bottom > window.innerHeight - 25)) continue;
            if (column && rects.some((rect) => column === "left" ? rect.right > columnDivider + 16 : rect.left < columnDivider - 16)) continue;
            const firstChar = document.createRange();
            firstChar.setStart(first.node, 0); firstChar.setEnd(first.node, 1);
            const firstRect = firstChar.getBoundingClientRect();
            const lastChar = document.createRange();
            lastChar.setStart(last.node, last.node.textContent.length - 1); lastChar.setEnd(last.node, last.node.textContent.length);
            const lastRect = lastChar.getBoundingClientRect();
            if (firstRect.width <= 0 || lastRect.width <= 0) continue;
            const lineYs = [...new Set(rows.map((row) => Math.round(row.y * 2) / 2))];
            return {
              requestedLines,
              pageNumber,
              expectedVisualLines: lineRows(rects),
              start: { x: firstRect.left + Math.min(1, firstRect.width / 3), y: firstRect.top + firstRect.height / 2 },
              end: { x: lastRect.right - Math.min(1, lastRect.width / 3), y: lastRect.top + lastRect.height / 2 },
              bounds: { top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)), left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)) },
              rows: rows.map((row) => ({ y: row.y, firstSpanTextLength: row.cells[0].text.length, lastSpanTextLength: row.cells.at(-1).text.length, spanCount: row.cells.length })),
              lineYs,
              column,
              startTarget: { tag: first.span.tagName.toLowerCase(), className: first.span.className, offset: 0 },
              endTarget: { tag: last.span.tagName.toLowerCase(), className: last.span.className, offset: last.node.textContent.length },
              excludedBands: usedBands.length,
            };
            }
          }
          const rowDebug = grouped.map((row) => ({ y: Math.round(row.y), x: Math.round(row.cells[0]?.left ?? -1), n: row.cells.length,
            lengths: row.cells.map((cell) => cell.text.length).slice(0, 4) })).slice(0, 90);
          throw new Error(`Could not find ${requestedLines} consecutive visible text lines with aligned left edges; rows=${JSON.stringify(rowDebug)}`);
        }, { requestedLines, usedBands: scenarioUsedBands, pageNumber });
        usedBands.push({ top: target.bounds.top, bottom: target.bounds.bottom });
        const before = await frame.evaluate((pageIndex) => {
          const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
          const highlights = [...manager.getEditors(pageIndex)].filter((editor) => editor.annotationEditorType === 9 || editor.constructor?._editorType === 9);
          return {
            mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
            highlightEditors: highlights.length,
            editorIds: highlights.map((editor) => String(editor.id)),
            consumers: window.__highlightMultilineProbe.trace.nativeSelectionProbe.consumers.length,
            selection: document.getSelection()?.isCollapsed ?? null,
          };
        }, pageIndex);
        await page.mouse.move(frameOffset.x + target.start.x, frameOffset.y + target.start.y, { steps: 2 });
        await page.mouse.down({ button: "left" });
        await page.mouse.move(frameOffset.x + target.end.x, frameOffset.y + target.end.y, { steps: 16 });
        await page.mouse.up({ button: "left" });
        await new Promise((resolve) => setTimeout(resolve, 180));
        const interaction = await frame.evaluate(({ variant, requestedLines, pageNumber, pageIndex, target, before }) => {
          const app = PDFViewerApplication;
          const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
          const probe = window.__highlightMultilineProbe.trace.nativeSelectionProbe;
          const consumers = probe.consumers.slice(before.consumers);
          const editors = [...manager.getEditors(pageIndex)].filter((editor) => editor.annotationEditorType === 9 || editor.constructor?._editorType === 9);
          const newEditors = editors.filter((editor) => !before.editorIds.includes(String(editor.id)));
          const serialized = newEditors.map((editor) => {
            const value = editor.serialize?.() || null;
            const bounds = editor.div?.getBoundingClientRect();
            return value ? { runtimeId: String(editor.id), editorClass: editor.div?.className || null,
              visible: Boolean(bounds?.width > 0 && bounds?.height > 0), ...value }
              : { runtimeId: String(editor.id), serializeReturnedNull: true };
          });
          const groupQuadLines = (points) => {
            const lines = [];
            if (!Array.isArray(points) && !ArrayBuffer.isView(points)) return lines;
            for (let index = 0; index + 7 < points.length; index += 8) {
              const ys = [points[index + 1], points[index + 3], points[index + 5], points[index + 7]];
              const center = ys.reduce((sum, y) => sum + y, 0) / ys.length;
              if (!lines.some((line) => Math.abs(line - center) <= 0.8)) lines.push(center);
            }
            return lines;
          };
          const newRows = [...(app.pdfDocument.annotationStorage.serializable?.map?.values() || [])]
            .filter((row) => (row.annotationType === 9 || row.annotationEditorType === 9) && row.deleted !== true);
          const lineCount = (rects) => {
            const ys = [];
            for (const rect of rects || []) {
              if (rect.width <= 0 || rect.height <= 0) continue;
              if (!ys.some((y) => Math.abs(y - rect.y) <= 2.5)) ys.push(rect.y);
            }
            return ys.length;
          };
          const page = document.querySelector(`.page[data-page-number="${pageNumber}"]`);
          const svg = [...(page?.querySelectorAll("svg") || [])].map((element) => {
            const rect = element.getBoundingClientRect();
            return { className: element.getAttribute("class"), pathCount: element.querySelectorAll("path").length,
              visible: rect.width > 0 && rect.height > 0, width: rect.width, height: rect.height };
          });
          return {
            variant,
            requestedLines,
            pageNumber,
            pageIndex,
            target,
            before,
            consumerCount: consumers.length,
            consumers: consumers.map((consumer) => ({
              at: consumer.at,
              mode: consumer.mode,
              before: consumer.before,
              after: consumer.after,
              editorCount: consumer.editorCount,
              visualRangeLines: lineCount(consumer.before?.rangeRects),
            })),
            newEditorCount: newEditors.length,
            newEditors: serialized.map((editor) => ({
              runtimeId: editor.runtimeId,
              annotationType: editor.annotationType ?? null,
              annotationEditorType: editor.annotationEditorType ?? null,
              textLength: typeof editor.text === "string" ? editor.text.length : null,
              quadPointCount: editor.quadPoints?.length ? Math.floor(editor.quadPoints.length / 8) : 0,
              quadLineCount: groupQuadLines(editor.quadPoints).length,
              quadPoints: editor.quadPoints ? Array.from(editor.quadPoints) : null,
              rect: editor.rect ? Array.from(editor.rect) : null,
            })),
            annotationStorageHighlightCount: newRows.length,
            annotationStorageHighlights: newRows.map((row) => ({
              annotationType: row.annotationType ?? row.annotationEditorType ?? null,
              quadPointCount: row.quadPoints?.length ? Math.floor(row.quadPoints.length / 8) : 0,
              quadLineCount: groupQuadLines(row.quadPoints).length,
              quadPoints: row.quadPoints ? Array.from(row.quadPoints) : null,
            })),
            drawSvg: svg,
            textLayerSelectingAfterUp: Boolean(document.querySelector('.page[data-page-number="1"] .textLayer')?.classList.contains("selecting")),
          };
        }, { variant, requestedLines, pageNumber, pageIndex, target, before });
        result.interactions.push(interaction);
        await persistEvidence(`${variant}-${requestedLines}-line-complete`);
      }

      await frame.evaluate(() => PDFViewerApplication.save());
      await page.waitForFunction((documentId) =>
        window.__highlightMultilineHost?.saves?.some((save) => save.documentId === documentId) ||
        window.__highlightMultilineHost?.errors?.length > 0,
      { timeout: 20_000 }, hostInfo.documentId);
      const saveRecord = await page.evaluate((documentId) => ({
        saves: window.__highlightMultilineHost.saves,
        durableWrites: window.__browserSidecarHost.durableWrites.filter((row) => row.documentId === documentId),
        operations: window.__browserSidecarHost.operationsFor(documentId),
      }), hostInfo.documentId);
      result.save = saveRecord;
      await persistEvidence(`${variant}-save-complete`);

      if (variant === "candidate") {
        const reopenRequest = await page.evaluate(() => window.__highlightMultilineHost.reopen());
        await page.waitForFunction((documentId, openRequest) =>
          window.__highlightMultilineHost?.opened?.some((event) => event.documentId === documentId && event.openRequest === openRequest) ||
          window.__highlightMultilineHost?.errors?.length > 0,
        { timeout: 25_000 }, hostInfo.documentId, reopenRequest);
        await frame.waitForFunction((openRequest, documentId) => {
          const bridge = window.__highlightMultilineBridgeState;
          return bridge?.activeOpenRequest === openRequest && bridge.externalSourceConfirmed &&
            bridge.activeDocumentId === documentId && Boolean(PDFViewerApplication.pdfDocument);
        }, { timeout: 25_000 }, reopenRequest, hostInfo.documentId);
        const expectedHydratedHighlights = saveRecord.operations.filter((operation) =>
          String(operation.kind || "").toLowerCase() === "highlight" && operation.deleted !== true,
        ).length;
        await frame.waitForFunction((expected) => {
          const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
          const allEditors = Array.from({ length: PDFViewerApplication.pdfViewer.pagesCount }, (_, index) => [...manager.getEditors(index)]).flat();
          const highlights = allEditors.filter((editor) => editor.annotationEditorType === 9 || editor.constructor?._editorType === 9);
          return highlights.length >= expected;
        }, { timeout: 25_000 }, expectedHydratedHighlights);
        result.reopen = await frame.evaluate(() => {
          const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
          const highlights = Array.from({ length: PDFViewerApplication.pdfViewer.pagesCount }, (_, index) => [...manager.getEditors(index)]).flat()
            .filter((editor) => editor.annotationEditorType === 9 || editor.constructor?._editorType === 9);
          return {
            activeOpenRequest: window.__highlightMultilineBridgeState.activeOpenRequest,
            externalSourceConfirmed: window.__highlightMultilineBridgeState.externalSourceConfirmed,
            hydratedHighlightCount: highlights.length,
            editors: highlights.map((editor) => {
              const serialized = editor.serialize?.() || {};
              const bounds = editor.div?.getBoundingClientRect();
              return { id: String(editor.id), textLength: serialized.text?.length ?? null,
                quadPointCount: serialized.quadPoints?.length ? Math.floor(serialized.quadPoints.length / 8) : 0,
                visible: Boolean(bounds?.width > 0 && bounds?.height > 0),
                pageNumber: editor.pageIndex + 1,
                drawSvgPathCount: document.querySelector(`.page[data-page-number="${editor.pageIndex + 1}"]`)?.querySelectorAll("svg path").length ?? 0 };
            }),
          };
        });
        await persistEvidence("candidate-reopen-complete");
      }

      result.hostErrors = await page.evaluate(() => ({
        parent: window.__highlightMultilineHost.errors,
        sidecar: window.__browserSidecarHost.errors,
      }));
      await persistEvidence(`${variant}-complete`);
      trace.results.at(-1).teardown = await teardownViewerPage(page);
      await page.close();
      activePage = null;
    }

    const candidate = trace.results.find((result) => result.variant === "candidate");
    const candidateFailures = candidate.interactions.map((interaction) => ({
      requestedLines: interaction.requestedLines,
      consumerCount: interaction.consumerCount,
      selectedTextLength: interaction.consumers[0]?.before?.textLength ?? null,
      consumerLineCount: interaction.consumers[0]?.visualRangeLines ?? null,
      newEditorCount: interaction.newEditorCount,
      quadLineCount: interaction.newEditors[0]?.quadLineCount ?? null,
    })).filter((row) => row.consumerCount < 1 || row.newEditorCount < 1 || row.consumerLineCount !== row.requestedLines || row.quadLineCount < row.requestedLines);
    trace.validation = { candidateFailures };
    await persistEvidence("validation-complete");
    assert.deepEqual(candidateFailures, [], `Current mode-9 selection did not preserve every requested visual line; see ${artifactPath}`);
    assert.ok(candidate.reopen?.hydratedHighlightCount >= 3,
      `Saved highlights should hydrate after reopen; see ${artifactPath}`);
  } catch (error) {
    primaryError = error;
    trace.failure = { name: error?.name || "Error", message: String(error?.message || error).slice(0, 2_000) };
    try {
      if (activePage && !activePage.isClosed()) {
        trace.failurePage = await activePage.evaluate(() => ({
          href: location.href,
          host: window.__highlightMultilineHost,
          sidecarErrors: window.__browserSidecarHost?.errors || [],
          frame: (() => {
            const frame = document.querySelector("iframe")?.contentWindow;
            const app = frame?.PDFViewerApplication;
            const bridge = frame?.__highlightMultilineBridgeState;
            return app ? { openRequest: bridge?.activeOpenRequest, documentId: bridge?.activeDocumentId,
              sourceConfirmed: bridge?.externalSourceConfirmed, mode: app.pdfViewer?.annotationEditorMode,
              pages: app.pdfViewer?.pagesCount, consumers: frame.__highlightMultilineProbe?.trace?.nativeSelectionProbe?.consumers,
              layers: [...frame.document.querySelectorAll(".textLayer")].slice(0, 4).map((layer) => layer.className) } : null;
          })(),
        })).catch((captureError) => ({ captureError: String(captureError?.message || captureError) }));
      }
      await persistEvidence("failure");
    } catch (captureError) {
      t.diagnostic(`Could not persist multiline failure details: ${captureError?.message || captureError}`);
    }
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [activePage].filter(Boolean), server });
  }
  const error = attachCleanupErrors(primaryError, cleanupReport);
  if (error) throw error;
});
