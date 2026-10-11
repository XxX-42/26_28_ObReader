import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
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
const artifacts = path.join(root, "tests", "artifacts");
const browserPath = resolveBrowserPath();

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

function findNestedRectPairs(rangeRects, textNodeRects) {
  const positiveRects = rangeRects.filter(
    (rect) => rect.width > 0 && rect.height > 0,
  );
  return positiveRects.flatMap((rangeRect) =>
    textNodeRects
      .filter(
        (textRect) =>
          Math.abs(rangeRect.x - textRect.x) < 0.75 &&
          Math.abs(rangeRect.right - textRect.right) < 0.75 &&
          Math.abs(rangeRect.bottom - textRect.bottom) >= 1 &&
          Math.abs(rangeRect.bottom - textRect.bottom) <= 6,
      )
      .map((textRect) => ({
        rangeRect,
        textRect,
        bottomDelta: rangeRect.bottom - textRect.bottom,
      })),
  );
}

function mapQuadsToScreen(annotation) {
  const { left, width, center, pdfWidth } = annotation.pageGeometry;
  const scale = width / pdfWidth;
  const rects = [];
  for (let index = 0; index < annotation.quadPoints.length; index += 8) {
    const quad = annotation.quadPoints.slice(index, index + 8);
    const x0 = left + quad[0] * scale;
    const x1 = left + quad[2] * scale;
    rects.push({ left: Math.min(x0, x1), right: Math.max(x0, x1), center });
  }
  return rects;
}

function countTextRows(textNodeRects, pageCenter) {
  const rows = [];
  for (const rect of [...textNodeRects].sort(
    (left, right) => left.y - right.y,
  )) {
    const column = rect.x + rect.width / 2 < pageCenter ? "left" : "right";
    const row = rows.find((candidate) => {
      if (candidate.column !== column) return false;
      const overlap =
        Math.min(candidate.bottom, rect.bottom) -
        Math.max(candidate.top, rect.y);
      return overlap > Math.min(candidate.height, rect.height) * 0.4;
    });
    if (row) {
      row.top = Math.min(row.top, rect.y);
      row.bottom = Math.max(row.bottom, rect.bottom);
      row.height = row.bottom - row.top;
    } else {
      rows.push({
        column,
        top: rect.y,
        bottom: rect.bottom,
        height: rect.height,
      });
    }
  }
  return rows;
}

function normalizeQuadPoints(points) {
  return points.map((point) => Math.round(point * 1000) / 1000);
}

function assertQuadPointsMatchTextRects(selection, label) {
  const actual = selection.annotation.quadPoints;
  const expected = selection.expectedQuadPoints;
  assert.equal(
    actual.length,
    expected.length,
    `${label}: serialized QuadPoints count should match independently mapped text-node rectangles`,
  );
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(
      Math.abs(actual[index] - expected[index]) < 1,
      `${label}: QuadPoints[${index}] ${actual[index]} differs from the text-node viewport mapping ${expected[index]}`,
    );
  }
}

function settleWithin(promise, milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), milliseconds);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ error });
      },
    );
  });
}

function childHasExited(child) {
  return Boolean(
    child &&
      (typeof child.exitCode === "number" ||
        typeof child.signalCode === "string"),
  );
}

function readProcessGroupId(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 250,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const processGroupId = Number(output);
    return Number.isInteger(processGroupId) ? processGroupId : null;
  } catch {
    return null;
  }
}

function readLiveProcessGroupMembers(processGroupId) {
  if (process.platform === "win32" || !Number.isInteger(processGroupId)) {
    return null;
  }
  try {
    const output = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
      encoding: "utf8",
      timeout: 250,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        ([pid, pgid, state]) =>
          Number.isInteger(Number(pid)) &&
          Number(pgid) === processGroupId &&
          typeof state === "string" &&
          !state.includes("Z"),
      )
      .map(([pid, , state]) => ({ pid: Number(pid), state }));
  } catch {
    return null;
  }
}

function waitForChildExit(child, milliseconds) {
  if (!child) {
    return Promise.resolve({ available: false, exited: false });
  }

  return new Promise((resolve) => {
    let settled = false;
    let exitEvent = null;
    let closeEvent = null;
    const stdioClosed = () =>
      (!child.stdout || child.stdout.destroyed) &&
      (!child.stderr || child.stderr.destroyed);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      resolve({
        available: true,
        exited: childHasExited(child),
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        exitEvent,
        closeEvent,
        stdioClosed: stdioClosed(),
        ...result,
      });
    };
    const onExit = (code, signal) => {
      exitEvent = { code, signal };
      if (stdioClosed()) finish({ observed: "exit-and-stdio-closed" });
    };
    const onClose = (code, signal) => {
      closeEvent = { code, signal };
      finish({ observed: "close" });
    };
    const timer = setTimeout(
      () => finish({ timedOut: true, observed: null }),
      milliseconds,
    );
    child.once("exit", onExit);
    child.once("close", onClose);
    // ChildProcess exit can race listener registration. Preserve its state and
    // wait for stdio closure as well when the `exit` event has already passed.
    if (childHasExited(child)) {
      if (stdioClosed()) finish({ observed: "state-and-stdio-closed" });
    }
  });
}

function appendErrorDetails(error, details) {
  const oldMessage = error.message || String(error);
  const oldStack = error.stack;
  error.message = `${oldMessage}\n${details}`;
  if (typeof oldStack === "string") {
    error.stack = oldStack.replace(oldMessage, error.message);
  }
}

test(
  "underline selection geometry stays single-stroke across text runs and columns",
  { timeout: 150_000 },
  async () => {
    assert.ok(browserPath, "Set PDF_READER_CHROME to Chrome or Edge");
    assert.deepEqual(
      (await readdir(dist)).sort(),
      ["main.js", "manifest.json", "styles.css"],
      "The test must start from the built three-file plugin",
    );
    await mkdir(artifacts, { recursive: true });

    const temp = await createTempRoot("underline-regression-");
    const adapter = createDiskAdapter(temp);
    const mainSource = await readBuiltMain();
    const payload = readPayloadFromMain(mainSource);
    const harness = loadBundledPlugin(mainSource, adapter);
    await harness.load();
    const logicalAssetRoot = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
    const output = adapter.resolve(logicalAssetRoot);
    const captureId = payload.contentHash.slice(0, 12);
    let browser;
    let server;
    let page;
    let viewer;
    let primaryError = null;
    let phase = "setup";
    let apiRequestCount = 0;
    const externalRequests = [];
    const pageErrors = [];
    const consoleErrors = [];

    server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) apiRequestCount += 1;
      if (url.pathname === "/" || url.pathname === "/favicon.ico") {
        response.writeHead(url.pathname === "/" ? 200 : 204, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          url.pathname === "/"
            ? "<!doctype html><title>Underline regression</title>"
            : undefined,
        );
        return;
      }

      let target;
      if (url.pathname === "/fixtures/tracemonkey.pdf") {
        target = fixture;
      } else if (url.pathname.startsWith("/viewer/")) {
        const relative = decodeURIComponent(
          url.pathname.slice("/viewer/".length),
        );
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
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    try {
      adapter.getResourcePath = (vaultPath) => {
        const prefix = `${logicalAssetRoot}/`;
        assert.ok(
          vaultPath.startsWith(prefix),
          `Unexpected viewer resource: ${vaultPath}`,
        );
        return new URL(
          `viewer/${vaultPath.slice(prefix.length)}`,
          `${baseUrl}/`,
        ).href;
      };
      const testView = harness.createView();
      const viewerDocument = await testView.createViewerDocument();
      const viewerLiteral = JSON.stringify(viewerDocument).replaceAll(
        "<",
        "\\u003c",
      );

      phase = "launching the test browser";
      browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 1000 });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
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
      phase = "loading the viewer harness";
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      phase = "installing the viewer and host message harness";
      await page.setContent(`
        <!doctype html><meta charset="utf-8">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
        <iframe name="pdf-reader" title="PDF Web Reader"
          sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"></iframe>
        <script>
          const channel = 'pdf-web-reader';
          const token = ${JSON.stringify(testView.token)};
          const documentId = 'fixtures/tracemonkey.pdf';
          const iframe = document.querySelector('iframe');
          const state = window.__hostState = { opened: 0, saves: 0, savedData: null, savedDataByteLength: 0, events: [], openRequests: [], errors: [] };
          let fixtureBytes;
          const recordOpenRequest = (data, reason) => {
            state.openRequests.push({
              at: performance.now(),
              reason,
              documentId,
              byteLength: data?.byteLength ?? null,
            });
          };
          const postOpen = (data, reason) => {
            recordOpenRequest(data, reason);
            iframe.contentWindow.postMessage({channel, type:'open', token, data, documentId, readOnly:false, autoSave:false}, '*', [data]);
          };
          window.addEventListener('message', event => {
            if (event.source !== iframe.contentWindow) return;
            const message = event.data;
            if (!message || message.channel !== channel || message.token !== token) return;
            const record = {
              at: performance.now(),
              type: message.type,
              documentId: message.documentId ?? null,
              requestId: message.requestId ?? null,
              revision: message.revision ?? null,
              openRequest: message.openRequest ?? null,
              code: message.code ?? null,
              message: message.message ?? null,
              byteLength: message.data?.byteLength ?? null,
            };
            state.events.push(record);
            if (message.type === 'ready') {
              const data = fixtureBytes.slice(0);
              postOpen(data, 'initial-ready');
            } else if (message.type === 'opened') {
              state.opened += 1;
              record.openedCount = state.opened;
            } else if (message.type === 'save') {
              state.saves += 1;
              state.savedData = message.data.slice(0);
              state.savedDataByteLength = state.savedData.byteLength;
              record.saveCount = state.saves;
              iframe.contentWindow.postMessage({channel, type:'saved', token, documentId, requestId:message.requestId, revision:message.revision}, '*');
              state.events.push({
                at: performance.now(),
                direction: 'host-to-viewer',
                type: 'saved-ack',
                documentId,
                requestId: message.requestId ?? null,
                revision: message.revision ?? null,
                saveCount: state.saves,
              });
            } else if (message.type === 'error') {
              state.errors.push(record);
            }
          });
          window.__reopenSavedData = () => {
            const data = state.savedData.slice(0);
            postOpen(data, 'saved-data-reopen');
          };
          window.__reopenFixture = () => {
            const data = fixtureBytes.slice(0);
            postOpen(data, 'fixture-reopen');
          };
          (async () => {
            fixtureBytes = await fetch('/fixtures/tracemonkey.pdf').then(response => {
              if (!response.ok) throw new Error('fixture fetch failed');
              return response.arrayBuffer();
            });
            iframe.srcdoc = ${viewerLiteral};
          })().catch(error => { state.error = error.message; });
        </script>
      `);
      const waitForOpenedOrError = async (
        expectedCount,
        eventStart,
        timeout,
        description,
      ) => {
        const handle = await page.waitForFunction(
          ({ expectedCount, eventStart }) => {
            const state = window.__hostState;
            if (!state) return false;
            if (state.error) {
              return { kind: "host-harness-error", error: state.error };
            }
            const error = state.events
              .slice(eventStart)
              .find((event) => event.type === "error");
            if (error) return { kind: "error", error };
            if (state.opened >= expectedCount) {
              return { kind: "opened", opened: state.opened };
            }
            return false;
          },
          { timeout },
          { expectedCount, eventStart },
        );
        try {
          const result = await handle.jsonValue();
          if (result.kind !== "opened") {
            throw new Error(
              `${description} failed before opened(${expectedCount}): ${JSON.stringify(result.error)}`,
            );
          }
          return result;
        } finally {
          await handle.dispose();
        }
      };

      phase = "waiting for the initial viewer open";
      await waitForOpenedOrError(1, 0, 45_000, "Initial PDF open");
      phase = "waiting for the initial text and annotation layers";
      viewer = page
        .frames()
        .find((frame) => frame.name() === "pdf-reader");
      assert.ok(viewer, "Expected the isolated viewer frame");
      await viewer.waitForSelector(
        '.page[data-page-number="1"] .textLayer span',
      );
      await viewer.waitForFunction(
        () => !document.getElementById("editorUnderlineButton").disabled,
      );

      const initial = await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .textLayer',
        );
        const spans = [...layer.querySelectorAll("span")];
        const textNodes = [];
        const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim())
            textNodes.push(walker.currentNode);
        }
        return {
          text: textNodes.map((node) => node.textContent).join(""),
          spans: spans.map((span) => {
            const rect = span.getBoundingClientRect();
            return {
              text: span.textContent,
              html: span.innerHTML,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              fontSize: getComputedStyle(span).fontSize,
            };
          }),
        };
      });
      assert.match(initial.text, /Dynamic languages/);
      assert.match(initial.text, /programs\./);
      assert.match(initial.text, /Compilers for statically typed languages/);
      assert.match(initial.text, /performance\./);

      const selectAndCreateAnnotation = async ({
        mode = 10,
        annotationType = mode,
        start,
        startDelta = 0,
        end,
        endDelta = 0,
        backwards = false,
        elementBoundaries = false,
      }) => {
        await viewer.evaluate(
          (mode) =>
            PDFViewerApplication.eventBus.dispatch(
              "switchannotationeditormode",
              { mode },
            ),
          mode,
        );
        const geometry = await viewer.evaluate(
          async ({
            mode,
            annotationType,
            start,
            startDelta,
            end,
            endDelta,
            backwards,
            elementBoundaries,
          }) => {
            const textLayer = document.querySelector(
              '.page[data-page-number="1"] .textLayer',
            );
            const spans = [...textLayer.querySelectorAll("span")];
            const startIndex = spans.findIndex((span) =>
              span.textContent.includes(start),
            );
            const endIndex = spans.findIndex((span) =>
              span.textContent.includes(end),
            );
            if (startIndex < 0 || endIndex < startIndex) {
              throw new Error(
                `Could not resolve selection anchors: ${start} … ${end}`,
              );
            }
            const startSpan = spans[startIndex];
            const endSpan = spans[endIndex];
            const startNode = startSpan.firstChild;
            const endNode = endSpan.firstChild;
            if (
              startNode?.nodeType !== Node.TEXT_NODE ||
              endNode?.nodeType !== Node.TEXT_NODE
            ) {
              throw new Error(
                "Expected text-layer spans to contain text nodes",
              );
            }
            const startOffset = elementBoundaries
              ? 0
              : startSpan.textContent.indexOf(start) + startDelta;
            const endOffset = elementBoundaries
              ? endNode.textContent.length
              : endSpan.textContent.indexOf(end) + end.length + endDelta;
            if (startOffset < 0 || endOffset > endNode.textContent.length) {
              throw new Error("Selection offsets escaped their text nodes");
            }

            const range = document.createRange();
            if (elementBoundaries) {
              range.setStartBefore(startSpan);
              range.setEndAfter(endSpan);
            } else {
              range.setStart(startNode, startOffset);
              range.setEnd(endNode, endOffset);
            }
            const selection = document.getSelection();
            selection.removeAllRanges();
            if (backwards) {
              selection.setBaseAndExtent(
                endNode,
                endOffset,
                startNode,
                startOffset,
              );
            } else {
              selection.addRange(range);
            }

            const toRect = (rect) => ({
              x: rect.x,
              y: rect.y,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
            });
            const rangeRects = [...range.getClientRects()].map(toRect);
            const textNodeRects = [];
            const spanRects = [];
            for (let index = startIndex; index <= endIndex; index += 1) {
              const span = spans[index];
              const node = span.firstChild;
              if (node?.nodeType !== Node.TEXT_NODE) continue;
              const from = index === startIndex ? startOffset : 0;
              const to =
                index === endIndex ? endOffset : node.textContent.length;
              if (to <= from) continue;
              const textRange = document.createRange();
              textRange.setStart(node, from);
              textRange.setEnd(node, to);
              textNodeRects.push(
                ...[...textRange.getClientRects()].map(toRect),
              );
              spanRects.push({
                text: span.textContent,
                fontSize: getComputedStyle(span).fontSize,
                rect: toRect(span.getBoundingClientRect()),
              });
            }
            const textLayerBox = textLayer.getBoundingClientRect();
            const pdfPage = await PDFViewerApplication.pdfDocument.getPage(1);
            const pdfPageView = PDFViewerApplication.pdfViewer.getPageView(0);
            const expectedQuadPoints = textNodeRects.flatMap((rect) => {
              const pdfCorners = [
                pdfPageView.getPagePoint(
                  rect.x - textLayerBox.left,
                  rect.y - textLayerBox.top,
                ),
                pdfPageView.getPagePoint(
                  rect.right - textLayerBox.left,
                  rect.y - textLayerBox.top,
                ),
                pdfPageView.getPagePoint(
                  rect.x - textLayerBox.left,
                  rect.bottom - textLayerBox.top,
                ),
                pdfPageView.getPagePoint(
                  rect.right - textLayerBox.left,
                  rect.bottom - textLayerBox.top,
                ),
              ];
              const xs = pdfCorners.map(([x]) => x);
              const ys = pdfCorners.map(([, y]) => y);
              const left = Math.min(...xs);
              const right = Math.max(...xs);
              const bottom = Math.min(...ys);
              const top = Math.max(...ys);
              return [left, top, right, top, left, bottom, right, bottom];
            });
            const selectionText = selection.toString();
            const selectionIsBackward =
              selection.anchorNode === endNode &&
              selection.anchorOffset === endOffset;
            const rangeUsesElementBoundaries =
              range.startContainer.nodeType === Node.ELEMENT_NODE &&
              range.endContainer.nodeType === Node.ELEMENT_NODE;
            const pageBox = document
              .querySelector('.page[data-page-number="1"]')
              .getBoundingClientRect();
            const pageView = pdfPage.view;
            const beforeCount = [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter(
              (annotation) =>
                annotation.annotationType === annotationType &&
                !annotation.deleted,
            ).length;
            window.dispatchEvent(
              new PointerEvent("pointerup", { button: 0, bubbles: true }),
            );
            return {
              mode,
              annotationType,
              selectionText,
              selectionIsBackward,
              rangeUsesElementBoundaries,
              startOffset,
              endOffset,
              startSpanText: startSpan.textContent,
              endSpanText: endSpan.textContent,
              rangeRects,
              textNodeRects,
              spanRects,
              expectedQuadPoints,
              pageGeometry: {
                left: pageBox.left,
                width: pageBox.width,
                center: pageBox.left + pageBox.width / 2,
                pdfWidth: pageView[2] - pageView[0],
              },
              beforeCount,
            };
          },
          {
            mode,
            annotationType,
            start,
            startDelta,
            end,
            endDelta,
            backwards,
            elementBoundaries,
          },
        );

        await viewer.waitForFunction(
          (beforeCount, annotationType) =>
            [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter(
              (annotation) =>
                annotation.annotationType === annotationType &&
                !annotation.deleted,
            ).length > beforeCount,
          {},
          geometry.beforeCount,
          annotationType,
        );
        const annotation = await viewer.evaluate((annotationType) => {
          const annotations = [
            ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
              []),
          ].filter(
            (entry) =>
              entry.annotationType === annotationType && !entry.deleted,
          );
          const entry = annotations.at(-1);
          if (!entry)
            throw new Error(
              `Annotation type ${annotationType} did not serialize`,
            );
          return {
            annotationType: entry.annotationType,
            id: entry.id,
            pageIndex: entry.pageIndex,
            rect: entry.rect ?? null,
            quadPoints: entry.quadPoints ? [...entry.quadPoints] : [],
            quadCount: entry.quadPoints ? entry.quadPoints.length / 8 : 0,
          };
        }, annotationType);
        return {
          ...geometry,
          annotation: { ...annotation, pageGeometry: geometry.pageGeometry },
        };
      };

      const selectAndCreateUnderline = (options) =>
        selectAndCreateAnnotation({ ...options, mode: 10, annotationType: 10 });

      const reopenFixture = async (openCount) => {
        phase = `fixture reopen before open count ${openCount}`;
        if (await viewer.evaluate(() => PDFViewerApplication._hasChanges())) {
          const expectedSave = await page.evaluate(
            () => window.__hostState.saves + 1,
          );
          await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
          await page.waitForFunction(
            (expected) => window.__hostState.saves === expected,
            { timeout: 60_000 },
            expectedSave,
          );
          await viewer.waitForFunction(
            () =>
              !PDFViewerApplication._hasChanges() &&
              !PDFViewerApplication._saveInProgress,
            { timeout: 60_000 },
          );
        }
        const eventStart = await page.evaluate(
          () => window.__hostState.events.length,
        );
        await page.evaluate(() => window.__reopenFixture());
        await waitForOpenedOrError(
          openCount,
          eventStart,
          90_000,
          "Fixture reopen",
        );
        await viewer.waitForSelector(
          '.page[data-page-number="1"] .textLayer span',
        );
        await viewer.evaluate(() => {
          PDFViewerApplication.pdfViewer.pagesRotation = 0;
        });
        await viewer.waitForFunction(() => {
          const textLayer = document.querySelector(
            '.page[data-page-number="1"] .textLayer',
          );
          return (
            PDFViewerApplication.pdfViewer.pagesRotation === 0 &&
            textLayer?.getAttribute("data-main-rotation") === "0"
          );
        });
      };

      // This real page-one selection begins inside the left Abstract paragraph
      // and ends inside the right column, so every text line and both columns
      // must retain independent underline quads.
      const abstractAcrossColumns = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        startDelta: 8,
        end: "performance.",
      });

      // The author row contains PDF text runs of 18.27px and 13.28px on the
      // same visual line (superscript affiliations), another real mixed-height
      // selection that used to create offset strokes.
      await viewer.evaluate(() => window.getSelection().removeAllRanges());
      const mixedHeightAuthorLine = await selectAndCreateUnderline({
        start: "Andreas Gal",
        end: "David Mandelin",
      });
      const abstractNestedRectPairs = findNestedRectPairs(
        abstractAcrossColumns.rangeRects,
        abstractAcrossColumns.textNodeRects,
      );
      const authorNestedRectPairs = findNestedRectPairs(
        mixedHeightAuthorLine.rangeRects,
        mixedHeightAuthorLine.textNodeRects,
      );
      const abstractRows = countTextRows(
        abstractAcrossColumns.textNodeRects,
        abstractAcrossColumns.pageGeometry.center,
      );
      const abstractQuadScreens = mapQuadsToScreen(
        abstractAcrossColumns.annotation,
      );

      await page.screenshot({
        path: path.join(artifacts, `underline-regression-${captureId}.png`),
        fullPage: false,
      });
      phase = "captured underline selections; beginning PDF save and round trip";

      const saveAndReopen = async (saveCount, openCount) => {
        phase = `save and reopen saved PDF before open count ${openCount}`;
        await viewer.evaluate(() => {
          if (
            document
              .getElementById("secondaryToolbar")
              .classList.contains("hidden")
          ) {
            document.getElementById("secondaryToolbarToggleButton").click();
          }
        });
        await viewer.waitForSelector("#secondaryToolbar:not(.hidden)");
        await viewer.click("#secondaryDownload");
        await page.waitForFunction(
          (expected) => window.__hostState.saves === expected,
          { timeout: 60_000 },
          saveCount,
        );
        await viewer.waitForFunction(
          () => !PDFViewerApplication._saveInProgress,
          { timeout: 60_000 },
        );
        await viewer.waitForFunction(
          () => !PDFViewerApplication._hasChanges(),
          { timeout: 60_000 },
        );
        const eventStart = await page.evaluate(
          () => window.__hostState.events.length,
        );
        await page.evaluate(() => window.__reopenSavedData());
        await waitForOpenedOrError(
          openCount,
          eventStart,
          90_000,
          "Saved PDF reopen",
        );
        await viewer.waitForSelector(
          '.page[data-page-number="1"] .textLayer span',
        );
        return viewer.evaluate(async () => {
          const page = await PDFViewerApplication.pdfDocument.getPage(1);
          const annotations = await page.getAnnotations();
          return annotations
            .filter((annotation) => annotation.subtype === "Underline")
            .map((annotation) => ({
              subtype: annotation.subtype,
              id: annotation.id,
              rect: annotation.rect,
              quadPoints: [...annotation.quadPoints],
              hasAppearance: annotation.hasAppearance,
              quadCount: annotation.quadPoints.length / 8,
            }));
        });
      };

      const savedUnderlines = await saveAndReopen(1, 2);
      assert.equal(
        savedUnderlines.length,
        2,
        "Both real selections should save as one underline each",
      );
      assert.ok(
        savedUnderlines.every((annotation) => annotation.hasAppearance),
        "Saved underlines should have AP appearances after reopen",
      );
      assert.equal(
        savedUnderlines.reduce(
          (count, annotation) => count + annotation.quadCount,
          0,
        ),
        abstractAcrossColumns.annotation.quadCount +
          mixedHeightAuthorLine.annotation.quadCount,
        "The PDF round trip must retain every selection quad",
      );

      // Select an all-body-font paragraph using element-boundary endpoints.
      // This exercises Range.setStartBefore/setEndAfter around full text spans.
      await reopenFixture(3);
      const sameFontElementBoundary = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        end: "programs.",
        elementBoundaries: true,
      });
      assert.equal(sameFontElementBoundary.rangeUsesElementBoundaries, true);
      assert.equal(
        new Set(
          sameFontElementBoundary.spanRects.map((entry) => entry.fontSize),
        ).size,
        1,
      );
      assert.equal(
        sameFontElementBoundary.annotation.quadCount,
        sameFontElementBoundary.textNodeRects.length,
        "Whole-span endpoints must not add element-box strokes",
      );
      assertQuadPointsMatchTextRects(
        sameFontElementBoundary,
        "same-font element-boundary selection",
      );

      // Clip both endpoints inside text nodes to cover partial text selection.
      await reopenFixture(4);
      const partialText = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        startDelta: 8,
        end: "programs.",
        endDelta: -2,
      });
      assert.match(partialText.selectionText, /^languages/);
      assert.ok(partialText.selectionText.trimEnd().endsWith("program"));
      assert.equal(
        partialText.annotation.quadCount,
        partialText.textNodeRects.length,
      );
      assertQuadPointsMatchTextRects(
        partialText,
        "partial text-node selection",
      );

      // A backward user selection must serialize the same geometry as the
      // forward selection of the same text.
      await reopenFixture(5);
      const reverseSelection = await selectAndCreateUnderline({
        start: "Dynamic languages such as JavaScript",
        end: "programs.",
        backwards: true,
      });
      assert.equal(reverseSelection.selectionIsBackward, true);
      assert.deepEqual(
        normalizeQuadPoints(reverseSelection.annotation.quadPoints),
        normalizeQuadPoints(sameFontElementBoundary.annotation.quadPoints),
        "Selection direction must not reorder or duplicate underline geometry",
      );
      assertQuadPointsMatchTextRects(reverseSelection, "backward selection");

      const rotationScenarios = [
        {
          rotation: 0,
          quadCount: partialText.annotation.quadCount,
          textRectCount: partialText.textNodeRects.length,
        },
      ];
      let nextOpenCount = 6;
      for (const rotation of [90, 180, 270]) {
        await reopenFixture(nextOpenCount);
        nextOpenCount += 1;
        await viewer.evaluate((value) => {
          PDFViewerApplication.pdfViewer.pagesRotation = value;
        }, rotation);
        await viewer.waitForFunction(
          (value) => {
            const textLayer = document.querySelector(
              '.page[data-page-number="1"] .textLayer',
            );
            return (
              PDFViewerApplication.pdfViewer.pagesRotation === value &&
              textLayer?.getAttribute("data-main-rotation") === String(value)
            );
          },
          {},
          rotation,
        );
        const rotatedSelection = await selectAndCreateUnderline({
          start: "Dynamic languages such as JavaScript",
          startDelta: 8,
          end: "programs.",
          endDelta: -2,
        });
        assert.equal(
          rotatedSelection.annotation.quadCount,
          rotatedSelection.textNodeRects.length,
        );
        assertQuadPointsMatchTextRects(
          rotatedSelection,
          `${rotation}-degree selection`,
        );
        rotationScenarios.push({
          rotation,
          quadCount: rotatedSelection.annotation.quadCount,
          textRectCount: rotatedSelection.textNodeRects.length,
        });
      }

      // Highlight intentionally keeps the pre-existing full Range geometry.
      // This guards the fix to the Underline path only.
      await reopenFixture(9);
      const highlightSelection = await selectAndCreateAnnotation({
        mode: 9,
        annotationType: 9,
        start: "Dynamic languages such as JavaScript",
        startDelta: 8,
        end: "performance.",
      });
      const positiveRangeRects = highlightSelection.rangeRects.filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      assert.equal(
        highlightSelection.annotation.quadCount,
        positiveRangeRects.length,
      );

      const savedBase64 = await page.evaluate(() => {
        const bytes = new Uint8Array(window.__hostState.savedData);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 0x8000),
          );
        }
        return btoa(binary);
      });
      await writeFile(
        path.join(artifacts, `underline-regression-${captureId}.pdf`),
        Buffer.from(savedBase64, "base64"),
      );
      const diagnostics = {
        payloadId: payload.id,
        contentHash: payload.contentHash,
        initialText: initial.text,
        abstractAcrossColumns,
        mixedHeightAuthorLine,
        sameFontElementBoundary,
        partialText,
        reverseSelection,
        rotationScenarios,
        highlightSelection,
        abstractNestedRectPairs,
        authorNestedRectPairs,
        abstractRows,
        abstractQuadScreens,
        savedUnderlines,
        apiRequestCount,
        externalRequests,
        pageErrors,
        consoleErrors,
      };
      await writeFile(
        path.join(artifacts, `underline-regression-${captureId}.json`),
        JSON.stringify(diagnostics, null, 2),
        "utf8",
      );

      // A pair of separately saved selections must never be joined across
      // columns or collapse to a single line. Source and serialized geometry
      // are retained above so failures show the exact browser and PDF quads.
      assert.ok(
        abstractAcrossColumns.rangeRects.length > 8,
        "The Abstract selection should span multiple lines in both columns",
      );
      assert.ok(
        abstractNestedRectPairs.length > 0,
        "The browser Range should expose nested span/text rectangles in the baseline fixture",
      );
      assert.ok(
        authorNestedRectPairs.length > 0,
        "Mixed-size author text should expose nested span/text rectangles",
      );
      assert.ok(
        abstractRows.length > 8,
        "The selected text should cover many distinct line rows",
      );
      assert.ok(
        abstractAcrossColumns.annotation.quadCount >= abstractRows.length,
        "Adjacent selected lines must remain distinct underline quads",
      );
      assert.ok(abstractQuadScreens.some((rect) => rect.right < rect.center));
      assert.ok(abstractQuadScreens.some((rect) => rect.left > rect.center));
      assert.ok(
        abstractQuadScreens.every(
          (rect) => rect.right < rect.center || rect.left > rect.center,
        ),
        "No serialized underline quad may connect the two text columns",
      );
      assert.ok(
        mixedHeightAuthorLine.spanRects.some(
          (entry) => Number.parseFloat(entry.fontSize) < 15,
        ),
      );
      assert.ok(
        mixedHeightAuthorLine.spanRects.some(
          (entry) => Number.parseFloat(entry.fontSize) > 17,
        ),
      );
      assert.equal(
        abstractAcrossColumns.annotation.quadCount,
        abstractAcrossColumns.textNodeRects.length,
        "Underline quads must follow clipped text-node rects, not nested Range element boxes",
      );
      assert.equal(
        mixedHeightAuthorLine.annotation.quadCount,
        mixedHeightAuthorLine.textNodeRects.length,
        "Mixed-height runs must not add a second underline for their span bounding boxes",
      );
      assertQuadPointsMatchTextRects(
        abstractAcrossColumns,
        "cross-column Abstract selection",
      );
      assertQuadPointsMatchTextRects(
        mixedHeightAuthorLine,
        "mixed-height author row",
      );
      assert.equal(
        apiRequestCount,
        0,
        "The offline viewer must not call a PDF.js API service",
      );
      assert.deepEqual(
        externalRequests,
        [],
        "The browser must not request external resources",
      );
      assert.deepEqual(pageErrors, []);
      console.log(
        `Underline geometry and PDF round-trip captured in tests/artifacts/underline-regression-${captureId}.{json,png,pdf}`,
      );
    } catch (error) {
      primaryError = error;
      const captureErrors = [];
      const failureId = `${captureId}-${Date.now()}`;
      const failureJsonPath = path.join(
        artifacts,
        `underline-regression-${failureId}-failure.json`,
      );
      const failurePngPath = path.join(
        artifacts,
        `underline-regression-${failureId}-failure.png`,
      );
      const diagnostics = {
        captureId,
        failureId,
        payloadId: payload.id,
        contentHash: payload.contentHash,
        phase,
        failure: {
          name: error?.name ?? typeof error,
          message: error?.message ?? String(error),
          stack: error?.stack ?? null,
        },
        browser: (() => {
          const child = browser?.process?.();
          return {
            connected: browser?.isConnected?.() ?? null,
            pid: child?.pid ?? null,
            exitCode: child?.exitCode ?? null,
            signalCode: child?.signalCode ?? null,
          };
        })(),
        serverListening: server?.listening ?? null,
        pageErrors,
        consoleErrors,
        externalRequests,
        apiRequestCount,
      };
      if (page && !page.isClosed()) {
        const pageSnapshot = await settleWithin(
          page.evaluate(() => {
            const state = window.__hostState;
            return {
              url: location.href,
              state: state
                ? {
                    opened: state.opened,
                    saves: state.saves,
                    harnessError: state.error ?? null,
                    savedDataByteLength: state.savedDataByteLength,
                    openRequests: state.openRequests,
                    events: state.events,
                    errors: state.errors,
                  }
                : null,
            };
          }),
          3_000,
        );
        if (pageSnapshot.value) {
          diagnostics.page = pageSnapshot.value;
        } else {
          captureErrors.push(
            `Could not capture host state: ${pageSnapshot.error?.message || "page evaluation timed out"}`,
          );
        }
        try {
          await settleWithin(
            page.screenshot({ path: failurePngPath, fullPage: false }),
            5_000,
          ).then((result) => {
            if (result.timedOut) {
              throw new Error("Failure screenshot timed out after 5000ms.");
            }
            if (result.error) throw result.error;
          });
          diagnostics.failureScreenshot = failurePngPath;
        } catch (captureError) {
          captureErrors.push(
            `Could not capture failure screenshot: ${captureError?.message || captureError}`,
          );
        }
      }
      if (viewer && !viewer.isDetached()) {
        const viewerSnapshot = await settleWithin(
          viewer.evaluate(() => {
            const app = window.PDFViewerApplication;
            const pdfDocument = app?.pdfDocument;
            return {
              url: location.href,
              appReady: !!app,
              pdfDocument: pdfDocument
                ? {
                    numPages: pdfDocument.numPages,
                    fingerprints: pdfDocument.fingerprints,
                  }
                : null,
              saveInProgress: app?._saveInProgress ?? null,
              hasChanges: app?._hasChanges?.() ?? null,
              annotationMode:
                app?.pdfViewer?.annotationEditorMode ?? null,
              loadedPages: [...window.document.querySelectorAll(".page")].map(
                (page) => page.dataset.pageNumber,
              ),
              textLayerSpanCount: window.document.querySelectorAll(
                '.page[data-page-number="1"] .textLayer span',
              ).length,
            };
          }),
          3_000,
        );
        if (viewerSnapshot.value) {
          diagnostics.viewer = viewerSnapshot.value;
        } else {
          captureErrors.push(
            `Could not capture viewer state: ${viewerSnapshot.error?.message || "frame evaluation timed out"}`,
          );
        }
      }
      diagnostics.captureErrors = captureErrors;
      try {
        await writeFile(failureJsonPath, JSON.stringify(diagnostics, null, 2));
        const details = [`Underline failure diagnostics: ${failureJsonPath}`];
        if (diagnostics.failureScreenshot) {
          details.push(`Underline failure screenshot: ${failurePngPath}`);
        }
        if (captureErrors.length) {
          details.push(`Diagnostic capture issues: ${captureErrors.join("; ")}`);
        }
        appendErrorDetails(error, details.join("\n"));
      } catch (captureError) {
        appendErrorDetails(
          error,
          `Could not write underline failure diagnostics: ${captureError?.message || captureError}`,
        );
      }
      throw error;
    } finally {
      const cleanupErrors = [];
      if (browser) {
        const closePromise = Promise.resolve().then(() => browser.close());
        let closePromisePending = true;
        let closePromiseError = null;
        void closePromise.then(
          () => {
            closePromisePending = false;
          },
          (error) => {
            closePromisePending = false;
            closePromiseError = error?.message || String(error);
          },
        );
        let outcome = await settleWithin(closePromise, 5_000);
        if (outcome.timedOut || outcome.error) {
          const initialCloseError = outcome.error?.message || null;
          let child = null;
          try {
            child = browser.process();
          } catch (error) {
            cleanupErrors.push(`browser.process: ${error?.message || error}`);
          }
          const childStateBefore = {
            pid: child?.pid ?? null,
            exitCode: child?.exitCode ?? null,
            signalCode: child?.signalCode ?? null,
          };
          const childWasRunning = Boolean(child && !childHasExited(child));
          let processGroupId = null;
          let processGroupValidated = false;
          let signalTarget = null;
          let signalError = null;
          if (childWasRunning && child.pid) {
            if (process.platform !== "win32") {
              processGroupId = readProcessGroupId(child.pid);
              // Puppeteer launches a detached process group on POSIX. Only
              // signal that group after verifying it is led by this exact
              // test-owned Chrome PID; never signal the app/runner group.
              processGroupValidated = processGroupId === child.pid;
            }
            try {
              if (processGroupValidated) {
                process.kill(-child.pid, "SIGTERM");
                signalTarget = `owned-process-group:${processGroupId}`;
              } else {
                child.kill("SIGTERM");
                signalTarget = `owned-child:${child.pid}`;
              }
            } catch (error) {
              signalError = error?.message || String(error);
            }
          }
          try {
            browser.disconnect();
          } catch (error) {
            cleanupErrors.push(`browser.disconnect: ${error?.message || error}`);
          }
          const childExit = await waitForChildExit(child, 2_000);
          const childStateAfter = {
            pid: child?.pid ?? null,
            exitCode: child?.exitCode ?? null,
            signalCode: child?.signalCode ?? null,
            killed: child?.killed ?? null,
            stdioClosed: Boolean(
              child &&
                (!child.stdout || child.stdout.destroyed) &&
                (!child.stderr || child.stderr.destroyed),
            ),
          };
          const liveProcessGroupMembers = processGroupValidated
            ? readLiveProcessGroupMembers(processGroupId)
            : null;
          let connectedAfterDisconnect = null;
          try {
            connectedAfterDisconnect = browser.isConnected();
          } catch (error) {
            cleanupErrors.push(`browser.isConnected: ${error?.message || error}`);
          }

          if (!childExit.exited) {
            cleanupErrors.push(
              `test-launched browser child ${child?.pid ?? "unknown"} remained alive after the 2000ms fallback window`,
            );
          }
          if (!childStateAfter.stdioClosed) {
            cleanupErrors.push(
              `test-launched browser child ${child?.pid ?? "unknown"} stdio remained open after the 2000ms fallback window`,
            );
          }
          if (connectedAfterDisconnect !== false) {
            cleanupErrors.push(
              `Puppeteer browser remained connected after disconnect (${String(connectedAfterDisconnect)})`,
            );
          }
          if (
            processGroupValidated &&
            liveProcessGroupMembers !== null &&
            liveProcessGroupMembers.length > 0
          ) {
            cleanupErrors.push(
              `owned Chrome process group ${processGroupId} still has live processes: ${liveProcessGroupMembers.map(({ pid }) => pid).join(", ")}`,
            );
          } else if (processGroupValidated && liveProcessGroupMembers === null) {
            cleanupErrors.push(
              `could not verify whether owned Chrome process group ${processGroupId} is empty`,
            );
          }

          const fallbackId = `${captureId}-${Date.now()}`;
          const fallbackJsonPath = path.join(
            artifacts,
            `underline-regression-${fallbackId}-cleanup.json`,
          );
          const fallbackDiagnostics = {
            captureId,
            fallbackId,
            payloadId: payload.id,
            contentHash: payload.contentHash,
            createdAt: new Date().toISOString(),
            primaryError: primaryError
              ? {
                  name: primaryError.name || "Error",
                  message: primaryError.message || String(primaryError),
                }
              : null,
            close: {
              timedOut: Boolean(outcome.timedOut),
              initialError: initialCloseError,
              pendingAfterFallback: closePromisePending,
              errorAfterFallback: closePromiseError,
            },
            browser: {
              connectedAfterDisconnect,
            },
            child: {
              before: childStateBefore,
              after: childStateAfter,
              exitObservation: childExit,
            },
            processGroup: {
              id: processGroupId,
              validatedAsOwned: processGroupValidated,
              signalTarget,
              signalError,
              liveMembersAfterFallback: liveProcessGroupMembers,
            },
            cleanupErrors: [...cleanupErrors],
          };
          try {
            await writeFile(
              fallbackJsonPath,
              JSON.stringify(fallbackDiagnostics, null, 2),
            );
            console.log(
              `Underline browser cleanup fallback captured in ${fallbackJsonPath}`,
            );
          } catch (error) {
            cleanupErrors.push(
              `Could not write browser cleanup fallback diagnostics: ${error?.message || error}`,
            );
          }
        }
      }
      if (server?.listening) {
        try {
          const closePromise = new Promise((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
          server.closeAllConnections?.();
          const outcome = await settleWithin(closePromise, 5_000);
          if (outcome.error) throw outcome.error;
          if (outcome.timedOut) {
            throw new Error("HTTP server close timed out after closeAllConnections.");
          }
        } catch (error) {
          cleanupErrors.push(`server.close: ${error?.message || error}`);
        }
      }
      try {
        await removeTempRoot(temp);
      } catch (error) {
        cleanupErrors.push(`removeTempRoot: ${error?.message || error}`);
      }
      if (cleanupErrors.length) {
        const cleanupMessage = `Underline test cleanup issues: ${cleanupErrors.join("; ")}`;
        if (primaryError) {
          appendErrorDetails(primaryError, cleanupMessage);
        } else {
          throw new AggregateError(cleanupErrors, cleanupMessage);
        }
      }
    }
  },
);
