import { isInlineToolbarIcon } from "./inline-toolbar-icons.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { withTestNetworkFirewall } from "./test-network-firewall.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
  observeBrowserTestChildStderr,
} from "./browser-test-cleanup.mjs";
import {
  createDiskAdapter,
  createTempRoot,
  loadBundledPlugin,
  pluginRoot,
  readBuiltMain,
  readPayloadFromMain,
  removeTempRoot,
  root,
} from "./bundled-plugin-test-utils.mjs";

const dist = path.join(root, "dist", "pdf-web-reader");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const browserPath = resolveBrowserPath();

if (!browserPath) {
  throw new Error(
    "Chrome or Edge was not found. Set PDF_READER_CHROME to its executable path.",
  );
}

assert.deepEqual(
  (await readdir(dist)).sort(),
  ["main.js", "manifest.json", "styles.css"],
  "Offline smoke must start from the three-file release output only",
);
let browser;
let page;
let browserObserver;
let primaryError;
let cleanupReport;
const runId = `${Date.now()}-${process.pid}-${randomUUID()}`;
let server;
let temp;

try {
  await mkdir(path.join(root, "tests", "artifacts"), { recursive: true });
  temp = await createTempRoot("offline-three-file-");
  const adapter = createDiskAdapter(temp);
  const mainSource = await readBuiltMain();
  const payload = readPayloadFromMain(mainSource);
  const harness = loadBundledPlugin(mainSource, adapter);
  await harness.load();
  const logicalAssetRoot = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
  const output = adapter.resolve(logicalAssetRoot);
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
  let apiRequestCount = 0;

  server = createServer(async (request, response) => {
    for (const [name, value] of Object.entries(withTestNetworkFirewall())) {
      response.setHeader(name, value);
    }
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) apiRequestCount += 1;
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>PDF Web Reader offline smoke test</title>",
      );
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }

    let target;
    if (url.pathname === "/fixtures/tracemonkey.pdf") {
      target = fixture;
    } else if (url.pathname.startsWith("/viewer/")) {
      const relative = decodeURIComponent(url.pathname.slice("/viewer/".length));
      target = path.resolve(output, relative);
      if (!target.startsWith(`${output}${path.sep}`)) {
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
        "content-type":
          mimeTypes.get(path.extname(target)) || "application/octet-stream",
        "content-length": info.size,
        "x-content-type-options": "nosniff",
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  adapter.getResourcePath = (vaultPath) => {
    const prefix = `${logicalAssetRoot}/`;
    assert.ok(
      vaultPath.startsWith(prefix),
      `Unexpected viewer resource: ${vaultPath}`,
    );
    return new URL(`viewer/${vaultPath.slice(prefix.length)}`, `${baseUrl}/`)
      .href;
  };
  const testView = harness.createView();
  const viewerDocument = await testView.createViewerDocument();
  assert.match(viewerDocument, /data-pdf-reader="viewer"/);
  assert.match(viewerDocument, /obsidian-bridge\.js/);
  const viewerDocumentLiteral = JSON.stringify(viewerDocument).replaceAll(
    "<",
    "\\u003c",
  );
  browser = await launchTestBrowser(puppeteer, {
    executablePath: browserPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  }, { testName: "offline-smoke" });
  browserObserver = observeBrowserTestChildStderr(browser.process?.());
  page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  const consoleErrors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser page error:", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
      console.error("Browser console error:", message.text());
    }
  });
  page.on("request", (request) => {
    if (!isInlineToolbarIcon(request.url()) && new URL(request.url()).origin !== baseUrl) {
      externalRequests.push(request.url());
    }
  });
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.setContent(`
    <!doctype html>
    <meta charset="utf-8">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
    <iframe name="pdf-reader" title="PDF Web Reader"
      sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"></iframe>
    <script>
      const viewerDocument = ${viewerDocumentLiteral};
      (() => {
        const channel = 'pdf-web-reader';
        const token = ${JSON.stringify(testView.token)};
        const documentId = 'fixtures/tracemonkey.pdf';
        const iframe = document.querySelector('iframe');
        const state = window.__hostState = {
          ready: false, opened: 0, saves: 0, ignoredSource: 0,
          ignoredToken: 0, rejectedDocument: 0, sourceIdentity: null,
          openRequest: 0, annotationRows: new Map(),
          invalidAcksSent: 0, errors: [], inbound: [],
        };
        let fixtureBytes;

        const makeSnapshot = () => ({
          schemaVersion: 1,
          kind: 'pdf-annotation-snapshot',
          documentId,
          docKey: 'offline-smoke',
          revision: state.annotationRows.size,
          updatedAt: Date.now(),
          legacyIdentities: [],
          source: state.sourceIdentity ? {
            sourcePath: documentId,
            sourceHash: 'xxh64-v1:offline-smoke-source',
            pageCount: state.sourceIdentity.pageCount,
            orderedPageIdentities: state.sourceIdentity.orderedPageIdentities,
          } : null,
          annotations: [...state.annotationRows.values()],
        });

        const sendOpen = () => {
          const data = fixtureBytes.slice(0);
          state.openRequest += 1;
          iframe.contentWindow.postMessage({
            channel, type: 'open', token, data, documentId,
            openRequest: state.openRequest,
            deviceId: 'offline-smoke-device',
            externalAnnotations: state.sourceIdentity ? makeSnapshot() : null,
            readOnly: false, autoSave: false,
          }, '*', [data]);
        };

        window.addEventListener('message', event => {
          const message = event.data;
          state.inbound.push({
            sourceIsViewer: event.source === iframe.contentWindow,
            type: message?.type || null,
            channelMatches: message?.channel === channel,
            tokenMatches: message?.token === token,
            documentId: message?.documentId || null,
          });
          if (event.source !== iframe.contentWindow) {
            state.ignoredSource += 1;
            return;
          }
          if (!message || message.channel !== channel || message.token !== token) {
            state.ignoredToken += 1;
            return;
          }
          if (message.type === 'ready') {
            state.ready = true;
            sendOpen();
          } else if (message.type === 'opened') {
            state.opened += 1;
          } else if (message.type === 'annotation-source-identity') {
            state.sourceIdentity = {
              pageCount: message.pageCount,
              orderedPageIdentities: message.orderedPageIdentities,
            };
            iframe.contentWindow.postMessage({
              channel, type: 'external-annotations-update', token, documentId,
              openRequest: message.openRequest,
              sourceMatch: state.annotationRows.size ? 'MATCH' : 'BASELINE_ESTABLISHED',
              identityConfirmed: true,
              externalAnnotations: makeSnapshot(),
            }, '*');
          } else if (message.type === 'save') {
            if (message.documentId !== documentId) {
              state.rejectedDocument += 1;
              iframe.contentWindow.postMessage({
                channel, type: 'error', token,
                documentId: message.documentId,
                requestId: message.requestId, revision: message.revision,
                code: 'document-mismatch',
                message: 'The test host rejected a save for a different document.',
              }, '*');
              return;
            }
            state.saves += 1;
            for (const operation of message.operations || []) {
              state.annotationRows.set(operation.uuid, {
                uuid: operation.uuid,
                kind: operation.kind,
                pageIndex: operation.pageIndex,
                embeddedRef: operation.embeddedRef || null,
                deleted: operation.deleted === true,
                clock: operation.clock,
                ...(operation.deleted ? {} : { payload: operation.payload }),
              });
            }
            state.invalidAcksSent += 2;
            iframe.contentWindow.postMessage({
              channel, type: 'saved', token, documentId,
              openRequest: message.openRequest,
              requestId: 'wrong-request-id',
            }, '*');
            iframe.contentWindow.postMessage({
              channel, type: 'saved', token,
              documentId: 'another/document.pdf',
              openRequest: message.openRequest,
              requestId: message.requestId, revision: message.revision,
            }, '*');
            setTimeout(() => iframe.contentWindow.postMessage({
              channel, type: 'saved', token, documentId,
              openRequest: message.openRequest,
              requestId: message.requestId, revision: message.revision,
              external: true,
              operationCount: (message.operations || []).length,
              batchId: 'offline-smoke-' + message.requestId,
            }, '*'), 25);
          } else if (message.type === 'error') {
            state.errors.push({
              code: message.code || null,
              message: message.message || null,
              requestId: message.requestId || null,
              revision: message.revision ?? null,
            });
          }
        });

        window.__sendSpoofedSource = () => {
          const spoof = document.createElement('iframe');
          spoof.style.display = 'none';
          const payload = JSON.stringify({
            channel, type: 'save', token, documentId,
            requestId: 'spoofed-source',
          });
          spoof.srcdoc = '<script>parent.postMessage(' + payload + ', "*")<' + '/script>';
          document.body.append(spoof);
          window.__spoofSourceFrame = spoof;
        };
        window.__removeSpoofedSourceFrame = () => {
          window.__spoofSourceFrame?.remove();
          window.__spoofSourceFrame = null;
        };
        window.__reopenExternalSnapshot = sendOpen;

        (async () => {
          fixtureBytes = await fetch('/fixtures/tracemonkey.pdf').then(r => {
            if (!r.ok) throw new Error('fixture fetch failed');
            return r.arrayBuffer();
          });
          iframe.srcdoc = viewerDocument;
        })().catch(error => state.errors.push(error.message));
      })();
    <\/script>
  `);

  console.log("Waiting for the bundled viewer to open the fixture…");
  await page
    .waitForFunction(() => window.__hostState?.opened === 1, {
      timeout: 45_000,
    })
    .catch(async (error) => {
      console.error(
        "Host state at open timeout:",
        await page.evaluate(() => window.__hostState),
      );
      throw error;
    });
  console.log("Fixture opened in the embedded viewer.");
  const viewer = page.frames().find((frame) => frame.name() === "pdf-reader");
  assert.ok(viewer, "Expected the isolated viewer frame");
  await viewer.waitForSelector(".textLayer span");
  await viewer.evaluate(() => {
    const app = window.PDFViewerApplication;
    window.__offlineOpenEvents = [];
    for (const type of ["documentloaded", "documenterror", "pagesloaded"]) {
      app?.eventBus?.on?.(type, (event) => {
        window.__offlineOpenEvents.push({
          type,
          at: performance.now(),
          message: event?.message || null,
          reason: event?.reason || null,
          hasDocument: Boolean(app.pdfDocument),
          pageCount: app.pdfDocument?.numPages ?? null,
        });
      });
    }
  });
  await viewer.waitForFunction(
    () => !document.getElementById("editorUnderlineButton").disabled,
  );

  const hostOnlyOpen = await viewer.evaluate(async () => {
    const app = PDFViewerApplication;
    const before = `${app.pdfDocument.fingerprints?.join(":")}:${app.pdfDocument.numPages}`;
    const openResult = await app.open({
      url: "https://example.invalid/replacement.pdf",
    });
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) throw new Error("Viewer file input is missing");
    const fileInputChange = new Event("change", {
      bubbles: true,
      cancelable: true,
    });
    fileInput.dispatchEvent(fileInputChange);

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(
      new File(["not a PDF"], "replacement.pdf", {
        type: "application/pdf",
      }),
    );
    const dragover = new DragEvent("dragover", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    });
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer,
    });
    document.dispatchEvent(dragover);
    document.dispatchEvent(drop);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const guardStatus = document.getElementById(
      "pdfReaderBridgeStatus",
    )?.textContent;

    return {
      openResult,
      fileInputPrevented: fileInputChange.defaultPrevented,
      dragoverPrevented: dragover.defaultPrevented,
      dropPrevented: drop.defaultPrevented,
      sameDocument:
        before ===
        `${app.pdfDocument.fingerprints?.join(":")}:${app.pdfDocument.numPages}`,
      openButtonsHidden: ["openFile", "secondaryOpenFile"].every(
        (id) =>
          !document.getElementById(id) || document.getElementById(id).hidden,
      ),
      guardStatus,
    };
  });
  assert.equal(
    hostOnlyOpen.openResult,
    false,
    "Viewer app.open must not change documents",
  );
  assert.equal(
    hostOnlyOpen.fileInputPrevented,
    true,
    "The file picker must be blocked",
  );
  assert.equal(
    hostOnlyOpen.dragoverPrevented,
    true,
    "File dragover must be blocked",
  );
  assert.equal(
    hostOnlyOpen.dropPrevented,
    true,
    "Dropped PDFs must be blocked",
  );
  assert.equal(
    hostOnlyOpen.sameDocument,
    true,
    "Local open attempts must retain host identity",
  );
  assert.equal(
    hostOnlyOpen.openButtonsHidden,
    true,
    "Local open toolbar actions must be hidden",
  );
  assert.match(
    hostOnlyOpen.guardStatus,
    /Open PDFs from the Obsidian file list/,
  );

  const modes = [10, 5, 9, 15, 3];
  const buttons = [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
  ];
  await page.evaluate(() =>
    document.querySelector("iframe").contentWindow.focus(),
  );
  console.log("Checking shortcuts and editor creation…");
  for (let index = 0; index < modes.length; index += 1) {
    await page.keyboard.press(String(index + 1));
    await viewer.waitForFunction(
      (expected) =>
        PDFViewerApplication.pdfViewer.annotationEditorMode === expected,
      {},
      modes[index],
    );
    assert.equal(
      await viewer.$eval(`#${buttons[index]}`, (element) =>
        element.classList.contains("toggled"),
      ),
      true,
      `Shortcut ${index + 1} should select ${buttons[index]}`,
    );
    await viewer.waitForFunction(() =>
      [
        ...document.querySelectorAll("#editorModeButtons .editorParamsToolbar"),
      ].every((element) => element.classList.contains("hidden")),
    );
    await page.keyboard.press(String(index + 1));
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
    );
  }
  for (let index = 0; index < modes.length; index += 1) {
    await viewer.evaluate(
      (n) =>
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: String(n + 1),
            code: `Numpad${n + 1}`,
            keyCode: 97 + n,
            bubbles: true,
          }),
        ),
      index,
    );
    await viewer.waitForFunction(
      (expected) =>
        PDFViewerApplication.pdfViewer.annotationEditorMode === expected,
      {},
      modes[index],
    );
    await viewer.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "`",
          code: "Backquote",
          keyCode: 192,
          bubbles: true,
        }),
      ),
    );
    await viewer.waitForFunction(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
    );
  }

  await viewer.evaluate(() => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "2",
        code: "Digit2",
        keyCode: 50,
        bubbles: true,
      }),
    );
    input.remove();
  });
  assert.equal(
    await viewer.evaluate(
      () => PDFViewerApplication.pdfViewer.annotationEditorMode,
    ),
    0,
    "Numeric shortcuts must not switch tools while editing an input",
  );

  const draw = async (x, y, dx, dy) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
  };
  const setTextSelection = async () => {
    await viewer.evaluate(() => {
      const spans = [
        ...document.querySelectorAll(
          '.page[data-page-number="1"] .textLayer span',
        ),
      ].filter((element) => element.firstChild?.nodeType === Node.TEXT_NODE);
      if (spans.length < 2)
        throw new Error("The fixture has no selectable text");
      const range = document.createRange();
      range.setStart(spans[0].firstChild, 0);
      range.setEnd(spans[1].firstChild, spans[1].textContent.length);
      document.getSelection().removeAllRanges();
      document.getSelection().addRange(range);
      window.dispatchEvent(
        new PointerEvent("pointerup", { button: 0, bubbles: true }),
      );
    });
  };
  const storage = () =>
    viewer.evaluate(() =>
      [
        ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
          []),
      ].filter((annotation) => !annotation.deleted),
    );

  await viewer.evaluate(() =>
    PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      mode: 10,
    }),
  );
  await viewer.waitForSelector(".annotationEditorLayer.underlineEditing");
  await setTextSelection();
  await viewer.waitForFunction(() =>
    [
      ...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values(),
    ].some((annotation) => annotation.annotationType === 10),
  );
  console.log("Underline created.");

  await viewer.evaluate(() =>
    PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      mode: 5,
    }),
  );
  const layer = await viewer.$eval(
    '.page[data-page-number="1"] .annotationEditorLayer',
    (element) => {
      const { x, y } = element.getBoundingClientRect();
      return { x, y };
    },
  );
  const frameBox = await page.$eval("iframe", (element) => {
    const { x, y } = element.getBoundingClientRect();
    return { x, y };
  });
  await draw(frameBox.x + layer.x + 100, frameBox.y + layer.y + 160, 110, 70);
  await viewer.waitForFunction(() =>
    [
      ...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values(),
    ].some((annotation) => annotation.annotationType === 5),
  );
  console.log("Square created.");

  await viewer.evaluate(() =>
    PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      mode: 9,
    }),
  );
  await setTextSelection();
  await viewer.waitForFunction(() =>
    [
      ...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values(),
    ].some((annotation) => annotation.annotationType === 9),
  );
  console.log("Highlight created.");

  await viewer.evaluate(() =>
    PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      mode: 15,
    }),
  );
  await draw(frameBox.x + layer.x + 300, frameBox.y + layer.y + 260, 70, 55);
  await page.keyboard.press("Escape");
  await viewer
    .waitForFunction(
      () =>
        [
          ...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values(),
        ].some((annotation) => annotation.annotationType === 15),
      { timeout: 10000 },
    )
    .catch(async (error) => {
      console.error(
        "Ink storage after pointer:",
        await viewer.evaluate(() => ({
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          entries: [
            ...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values(),
          ].map((a) => ({
            type: a.annotationType,
            id: a.id,
            deleted: a.deleted,
          })),
          editors: [...document.querySelectorAll(".inkEditor")].length,
          target: document.elementFromPoint(300, 260)?.className,
        })),
      );
      await page
        .screenshot({
          path: path.join(
            root,
            "tests",
            "artifacts",
            `offline-smoke-ink-failure-${runId}.png`,
          ),
        })
        .catch(() => {});
      throw error;
    });
  console.log("Ink created.");

  await viewer.evaluate(() =>
    PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      mode: 3,
    }),
  );
  await viewer.waitForFunction(
    () => PDFViewerApplication.pdfViewer.annotationEditorMode === 3,
  );
  await page.mouse.click(
    frameBox.x + layer.x + 220,
    frameBox.y + layer.y + 360,
  );
  await viewer.waitForSelector(".freeTextEditor.selectedEditor .internal");
  await viewer.type(
    ".freeTextEditor.selectedEditor .internal",
    "Obsidian smoke test",
  );
  await page.keyboard.press("Escape");
  await viewer.waitForSelector(
    ".freeTextEditor.selectedEditor .overlay.enabled",
  );
  await viewer.waitForFunction(() =>
    [
      ...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values(),
    ].some((annotation) => annotation.annotationType === 3),
  );
  const created = await storage();
  assert.deepEqual(
    created
      .map((annotation) => annotation.annotationType)
      .sort((a, b) => a - b),
    [3, 5, 9, 10, 15],
    "Each of the five tools should create a PDF annotation",
  );
  console.log("All five editors created.");

  await page.evaluate(() => window.__sendSpoofedSource());
  await viewer.evaluate((validToken) => {
    window.parent.postMessage(
      {
        channel: "pdf-web-reader",
        type: "save",
        token: "wrong-token",
        documentId: "fixtures/tracemonkey.pdf",
        requestId: "wrong-token",
        data: new ArrayBuffer(1),
      },
      "*",
    );
    window.parent.postMessage(
      {
        channel: "pdf-web-reader",
        type: "save",
        token: validToken,
        documentId: "another/document.pdf",
        requestId: "wrong-document",
        data: new ArrayBuffer(1),
      },
      "*",
    );
  }, testView.token);
  try {
    await page.waitForFunction(() => {
      const state = window.__hostState;
      return (
        state.ignoredSource === 1 &&
        state.ignoredToken === 1 &&
        state.rejectedDocument === 1
      );
    });
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const iframe = document.querySelector('iframe[name="pdf-reader"]');
      const child = iframe?.contentWindow;
      let viewer = null;
      try {
        const app = child?.PDFViewerApplication;
        viewer = {
          location: child?.location?.href || null,
          readyState: child?.document?.readyState || null,
          parentIsHost: child?.parent === window,
          bridgeScripts: Array.from(child?.document?.scripts || [])
            .filter((script) => script.dataset.channel === 'pdf-web-reader')
            .map((script) => ({
              src: script.src,
              generation: script.dataset.rendererGeneration || null,
            })),
          initialized: app?.initialized ?? null,
          hasPdfDocument: Boolean(app?.pdfDocument),
          pageCount: app?.pdfDocument?.numPages ?? null,
        };
      } catch (diagnosticError) {
        viewer = { error: diagnosticError?.message || String(diagnosticError) };
      }
      return {
        counters: {
          ready: window.__hostState?.ready,
          opened: window.__hostState?.opened,
          saves: window.__hostState?.saves,
          ignoredSource: window.__hostState?.ignoredSource,
          ignoredToken: window.__hostState?.ignoredToken,
          rejectedDocument: window.__hostState?.rejectedDocument,
          errors: window.__hostState?.errors,
        },
        inbound: window.__hostState?.inbound,
        iframe: {
          connected: iframe?.isConnected ?? false,
          srcdocLength: iframe?.srcdoc?.length ?? null,
        },
        spoofFrame: {
          connected: window.__spoofSourceFrame?.isConnected ?? false,
          readyState: window.__spoofSourceFrame?.contentDocument?.readyState || null,
        },
        viewer,
      };
    });
    error.message = `${error.message}\nOffline message-auth snapshot: ${JSON.stringify(snapshot)}`;
    throw error;
  }
  await page.evaluate(() => window.__removeSpoofedSourceFrame?.());
  assert.equal(await page.evaluate(() => window.__hostState.saves), 0);

  const getSavedAnnotations = () =>
    page.evaluate(() => [...window.__hostState.annotationRows.values()]
      .filter((row) => !row.deleted)
      .map((row) => ({
        subtype: row.kind,
        pageIndex: row.pageIndex,
        color: row.payload?.editor?.color || null,
        uuid: row.uuid,
      })));
  const saveAndReopen = async (_historicalSaveCount, openCount) => {
    const before = await page.evaluate(() => window.__hostState.saves);
    const dirty = await viewer.evaluate(() => PDFViewerApplication._hasChanges());
    const saveCount = before + (dirty ? 1 : 0);
    await viewer.evaluate(() => {
      if (
        document.getElementById("secondaryToolbar").classList.contains("hidden")
      ) {
        document.getElementById("secondaryToolbarToggleButton").click();
      }
    });
    await viewer.waitForSelector("#secondaryToolbar:not(.hidden)");
    const saveLabel = await viewer.$eval("#secondaryDownload", (button) => ({
      text: button.querySelector("span")?.textContent?.trim(),
      title: button.title,
      ariaLabel: button.getAttribute("aria-label"),
      localizationId: button.getAttribute("data-l10n-id"),
    }));
    assert.equal(saveLabel.text, "保存批注");
    assert.equal(saveLabel.title, "保存批注到外置记录");
    assert.equal(saveLabel.ariaLabel, saveLabel.title);
    assert.equal(saveLabel.localizationId, null);
    await viewer.click("#secondaryDownload");
    await page.waitForFunction(
      (expected) => window.__hostState.saves === expected,
      { timeout: 15_000 },
      saveCount,
    ).catch(async (error) => {
      const state = await page.evaluate(() => {
        const frame = document.querySelector('iframe[name="pdf-reader"]')?.contentWindow;
        const app = frame?.PDFViewerApplication;
        return {
          host: window.__hostState && {
            saves: window.__hostState.saves,
            opened: window.__hostState.opened,
            inbound: window.__hostState.inbound?.slice(-12),
            errors: window.__hostState.errors,
            operationCount: [...window.__hostState.annotationRows.values()].length,
          },
          viewer: app && {
            dirty: app._hasChanges?.(),
            saveInProgress: app._saveInProgress,
            readOnly: frame.document.documentElement.hasAttribute('data-pdf-reader-readonly'),
            mode: app.pdfViewer?.annotationEditorMode,
            storedRows: app.pdfDocument?.annotationStorage?.serializable?.map?.size,
            pendingSave: Boolean(frame.__pdfReaderBridgeState?.pendingSave),
          },
        };
      });
      error.message = `${error.message}\nOffline external-save diagnostic: ${JSON.stringify(state)}`;
      throw error;
    });
    await viewer.waitForFunction(() => !PDFViewerApplication._saveInProgress, {
      timeout: 60_000,
    });
    assert.ok(
      await page.evaluate(() => window.__hostState.annotationRows.size > 0),
      "The host should persist annotation operations instead of PDF bytes",
    );
    await page.evaluate(
      (expected) => {
        window.__expectedOfflineOpenCount = expected;
      },
      openCount,
    );
    await page.evaluate(() => window.__reopenExternalSnapshot());
    try {
      await page.waitForFunction(
        (expected) => window.__hostState.opened === expected,
        { timeout: 120_000 },
        openCount,
      );
    } catch (error) {
      let snapshot = null;
      try {
        snapshot = await page.evaluate(() => {
          const iframe = document.querySelector('iframe[name="pdf-reader"]');
          const child = iframe?.contentWindow;
          let renderer = null;
          try {
            const app = child?.PDFViewerApplication;
            renderer = {
              location: child?.location?.href || null,
              readyState: child?.document?.readyState || null,
              parentIsHost: child?.parent === window,
              initialized: app?.initialized ?? null,
              initializedPromise: app?.initializedPromise
                ? "present"
                : null,
              hasPdfDocument: Boolean(app?.pdfDocument),
              pageCount: app?.pdfDocument?.numPages ?? null,
              hasLoadingTask: Boolean(app?.pdfLoadingTask),
              loadingTaskDestroyed:
                app?.pdfLoadingTask?.destroyed ?? null,
              loadingPercent: app?.progress ?? null,
              hasChanges: app?._hasChanges?.() ?? null,
              documentTitle: child?.document?.title || null,
              bridgeScripts: Array.from(child?.document?.scripts || [])
                .filter((script) =>
                  script.dataset.channel === "pdf-web-reader",
                )
                .map((script) => ({
                  src: script.src,
                  generation: script.dataset.rendererGeneration || null,
                })),
              documentEvents: child?.__offlineOpenEvents || null,
            };
          } catch (diagnosticError) {
            renderer = { error: diagnosticError?.message || String(diagnosticError) };
          }
          return {
            expectedOpened: window.__expectedOfflineOpenCount ?? null,
            counters: {
              ready: window.__hostState?.ready,
              opened: window.__hostState?.opened,
              saves: window.__hostState?.saves,
              sidecarOperationCount: window.__hostState?.annotationRows?.size ?? null,
              inbound: window.__hostState?.inbound,
              errors: window.__hostState?.errors,
            },
            iframe: {
              connected: iframe?.isConnected ?? false,
              src: iframe?.getAttribute("src") || null,
              srcdocLength: iframe?.srcdoc?.length ?? null,
            },
            renderer,
          };
        });
      } catch (snapshotError) {
        snapshot = { snapshotError: snapshotError?.message || String(snapshotError) };
      }
      const artifact = {
        test: "offline smoke external-annotation reopen",
        result: "failed while waiting for the exact opened acknowledgement",
        capturedAt: new Date().toISOString(),
        expectedOpened: openCount,
        savesBeforeReopen: before,
        latestSaveExpected: saveCount,
        sidecarOperationCount: await page
          .evaluate(() => window.__hostState?.annotationRows?.size ?? null)
          .catch(() => null),
        pageErrors: errors,
        consoleErrors,
        snapshot,
      };
      const artifactPath = path.join(
        root,
        "tests",
        "artifacts",
        `mac-offline-reopen-timeout-${runId}.json`,
      );
      await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
      console.error(`Offline reopen diagnostic saved: ${artifactPath}`);
      error.message = `${error.message}\nOffline reopen snapshot: ${JSON.stringify(artifact)}`;
      throw error;
    }
    await viewer.waitForSelector(".textLayer span");
  };

  console.log("Saving and reopening the five annotations…");
  await saveAndReopen(1, 2);
  const savedAnnotations = await getSavedAnnotations();
  const savedSubtypes = savedAnnotations
    .map((annotation) => annotation.subtype)
    .sort();
  assert.deepEqual(savedSubtypes, [
    "FreeText",
    "Highlight",
    "Ink",
    "Square",
    "Underline",
  ]);

  // Reopen again without editing to ensure the external snapshot remains
  // visible and does not create duplicate editors.
  await saveAndReopen(2, 3);
  const repeatedSave = await getSavedAnnotations();
  assert.deepEqual(
    repeatedSave.map((annotation) => annotation.subtype).sort(),
    savedSubtypes,
    "A second save without edits must preserve each annotation exactly once",
  );

  // Reopened Square annotations remain editable and retain color changes.
  await viewer.evaluate(() =>
    PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      mode: 5,
    }),
  );
  await viewer.waitForFunction(
    () => document.querySelectorAll(".inkEditor").length >= 3,
  );
  await viewer.evaluate(() => {
    const storage = PDFViewerApplication.pdfDocument.annotationStorage;
    const square = [...document.querySelectorAll(".inkEditor")]
      .map((element) => storage.getRawValue(element.id))
      .find((editor) => editor?.constructor?._editorType === 5);
    if (!square) throw new Error("Could not find the reopened Square editor");
    square._uiManager.setSelected(square);
    const color = document.getElementById("editorSquareColor");
    color.value = "#ff0000";
    color.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await viewer.waitForFunction(() =>
    [
      ...PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values(),
    ].some(
      (annotation) =>
        annotation.annotationType === 5 &&
        annotation.color?.[0] === 255 &&
        annotation.color?.[1] === 0 &&
        annotation.color?.[2] === 0,
    ),
  );
  await saveAndReopen(3, 4);
  const colorRoundTrip = await getSavedAnnotations();
  const savedSquare = colorRoundTrip.find(
    (annotation) => annotation.subtype === "Square",
  );
  assert.deepEqual(Array.from(savedSquare?.color || []), [255, 0, 0]);
  assert.deepEqual(
    colorRoundTrip.map((annotation) => annotation.subtype).sort(),
    savedSubtypes,
    "Editing the Square must not create a duplicate annotation",
  );

  // Delete the reopened Underline, then verify the save does not retain a
  // stale or duplicated copy.
  await viewer.evaluate(() =>
    PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
      mode: 5,
    }),
  );
  await viewer.waitForFunction(
    () => document.querySelectorAll(".inkEditor").length >= 3,
  );
  await viewer.evaluate(() => {
    const storage = PDFViewerApplication.pdfDocument.annotationStorage;
    const underline = [...document.querySelectorAll(".inkEditor")]
      .map((element) => storage.getRawValue(element.id))
      .find((editor) => editor?.constructor?._editorType === 10);
    if (!underline)
      throw new Error("Could not find the reopened Underline editor");
    underline._uiManager.deleteEditor(underline);
  });
  await saveAndReopen(4, 5);
  const deletedRoundTrip = await getSavedAnnotations();
  assert.deepEqual(
    deletedRoundTrip.map((annotation) => annotation.subtype).sort(),
    ["FreeText", "Highlight", "Ink", "Square"],
  );
  assert.equal(
    deletedRoundTrip.filter((annotation) => annotation.subtype === "Square")
      .length,
    1,
  );
  assert.equal(
    await page.evaluate(() => window.__hostState.invalidAcksSent),
    2 * await page.evaluate(() => window.__hostState.saves),
    "The bridge must ignore mismatched save request and document IDs",
  );
  assert.equal(
    apiRequestCount,
    0,
    "The viewer must not call a PDF.js API service",
  );
  assert.deepEqual(
    externalRequests,
    [],
    "The offline test must not fetch external resources",
  );
  assert.deepEqual(await page.evaluate(() => window.__hostState.errors), []);
  assert.deepEqual(errors, []);
} catch (error) {
  primaryError = error;
} finally {
  cleanupReport = await cleanupBrowserTestResources({
    browser,
    browserObserver,
    ownedPages: [page],
    server: server?.listening ? server : undefined,
  });
  const cleanupPath = path.join(root, "tests", "artifacts", `offline-smoke-${runId}.cleanup.json`);
  try {
    if (temp) await removeTempRoot(temp);
  } catch (error) {
    cleanupReport.status = "failed";
    cleanupReport.errors.push({ phase: "temp-root.remove", name: error.name, message: error.message });
  }
  try {
    await writeFile(cleanupPath, JSON.stringify(cleanupReport, null, 2) + "\n", { flag: "wx" });
    console.log(`Offline cleanup evidence: ${cleanupPath}`);
  } catch (error) {
    cleanupReport.status = "failed";
    cleanupReport.errors.push({ phase: "cleanup-evidence.write", name: error.name, message: error.message });
  }
}
const finalError = attachCleanupErrors(primaryError, cleanupReport);
if (finalError) throw finalError;
  console.log("Offline viewer smoke test passed: open, tools 1–5, bridge validation, external operation save/reopen; normal browser exit.");
