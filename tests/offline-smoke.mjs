import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";
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
const browserPath =
  process.env.PDF_READER_CHROME ||
  process.env.PDFJS_CHROME ||
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((candidate) => candidate && existsSync(candidate));

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
const temp = await createTempRoot("offline-three-file-");
const adapter = createDiskAdapter(temp);
const mainSource = await readBuiltMain();
const payload = readPayloadFromMain(mainSource);
const harness = loadBundledPlugin(mainSource, adapter);
await harness.load();
const logicalAssetRoot = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
const output = adapter.resolve(logicalAssetRoot);
let browser;
let server;
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

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
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
  browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  const externalRequests = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Browser page error:", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error("Browser console error:", message.text());
    }
  });
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== baseUrl) {
      externalRequests.push(request.url());
      void request.abort();
    } else {
      void request.continue();
    }
  });
  await page.setRequestInterception(true);
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
          ignoredToken: 0, rejectedDocument: 0, savedData: null,
          invalidAcksSent: 0, errors: [],
        };
        let fixtureBytes;

        window.addEventListener('message', event => {
          if (event.source !== iframe.contentWindow) {
            state.ignoredSource += 1;
            return;
          }
          const message = event.data;
          if (!message || message.channel !== channel || message.token !== token) {
            state.ignoredToken += 1;
            return;
          }
          if (message.type === 'ready') {
            state.ready = true;
            const data = fixtureBytes.slice(0);
            iframe.contentWindow.postMessage({
              channel, type: 'open', token, data,
              documentId, readOnly: false,
            }, '*', [data]);
          } else if (message.type === 'opened') {
            state.opened += 1;
          } else if (message.type === 'save') {
            if (message.documentId !== documentId) {
              state.rejectedDocument += 1;
              iframe.contentWindow.postMessage({
                channel, type: 'error', token,
                documentId: message.documentId,
                requestId: message.requestId,
                code: 'document-mismatch',
                message: 'The test host rejected a save for a different document.',
              }, '*');
              return;
            }
            state.saves += 1;
            state.savedData = message.data.slice(0);
            state.invalidAcksSent += 2;
            iframe.contentWindow.postMessage({
              channel, type: 'saved', token, documentId,
              requestId: 'wrong-request-id',
            }, '*');
            iframe.contentWindow.postMessage({
              channel, type: 'saved', token,
              documentId: 'another/document.pdf',
              requestId: message.requestId,
            }, '*');
            setTimeout(() => iframe.contentWindow.postMessage({
              channel, type: 'saved', token, documentId,
              requestId: message.requestId,
            }, '*'), 25);
          } else if (message.type === 'error') {
            state.errors.push(message.code || message.message || 'viewer error');
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
          setTimeout(() => spoof.remove(), 50);
        };
        window.__reopenSavedData = () => {
          const data = state.savedData.slice(0);
          iframe.contentWindow.postMessage({
            channel, type: 'open', token, data,
            documentId, readOnly: false,
          }, '*', [data]);
        };

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
            "output",
            "offline-smoke-ink-failure.png",
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
  await page.waitForFunction(() => {
    const state = window.__hostState;
    return (
      state.ignoredSource === 1 &&
      state.ignoredToken === 1 &&
      state.rejectedDocument === 1
    );
  });
  assert.equal(await page.evaluate(() => window.__hostState.saves), 0);

  const getSavedAnnotations = () =>
    viewer.evaluate(async () => {
      const pdfPage = await PDFViewerApplication.pdfDocument.getPage(1);
      return pdfPage.getAnnotations();
    });
  const saveAndReopen = async (saveCount, openCount) => {
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
    assert.equal(saveLabel.text, "保存到仓库");
    assert.equal(saveLabel.title, "保存 PDF 到仓库（覆盖当前文件）");
    assert.equal(saveLabel.ariaLabel, saveLabel.title);
    assert.equal(saveLabel.localizationId, null);
    await viewer.click("#secondaryDownload");
    await page.waitForFunction(
      (expected) => window.__hostState.saves === expected,
      { timeout: 60_000 },
      saveCount,
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._saveInProgress, {
      timeout: 60_000,
    });
    assert.ok(
      await page.evaluate(
        () => window.__hostState.savedData instanceof ArrayBuffer,
      ),
    );
    await page.evaluate(() => window.__reopenSavedData());
    await page.waitForFunction(
      (expected) => window.__hostState.opened === expected,
      { timeout: 120_000 },
      openCount,
    );
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

  // Save again without editing to ensure previously written marks survive and
  // remain single PDF annotations.
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
  assert.deepEqual(Object.values(savedSquare?.color || {}), [255, 0, 0]);
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
    8,
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
  console.log(
    "Offline viewer smoke test passed: open, tools 1–5, bridge validation, save/reopen.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await removeTempRoot(temp);
}
