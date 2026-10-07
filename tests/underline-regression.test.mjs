import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
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
const artifacts = path.join(root, "tests", "artifacts");
const browserPath =
  process.env.PDF_READER_CHROME ||
  process.env.PDFJS_CHROME ||
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((candidate) => candidate && existsSync(candidate));

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
    let apiRequestCount = 0;

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

      browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 1000 });
      const externalRequests = [];
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
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
        <!doctype html><meta charset="utf-8">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>
        <iframe name="pdf-reader" title="PDF Web Reader"
          sandbox="allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"></iframe>
        <script>
          const channel = 'pdf-web-reader';
          const token = ${JSON.stringify(testView.token)};
          const documentId = 'fixtures/tracemonkey.pdf';
          const iframe = document.querySelector('iframe');
          const state = window.__hostState = { opened: 0, saves: 0, savedData: null };
          let fixtureBytes;
          window.addEventListener('message', event => {
            if (event.source !== iframe.contentWindow) return;
            const message = event.data;
            if (!message || message.channel !== channel || message.token !== token) return;
            if (message.type === 'ready') {
              const data = fixtureBytes.slice(0);
              iframe.contentWindow.postMessage({channel, type:'open', token, data, documentId, readOnly:false}, '*', [data]);
            } else if (message.type === 'opened') {
              state.opened += 1;
            } else if (message.type === 'save') {
              state.saves += 1;
              state.savedData = message.data.slice(0);
              iframe.contentWindow.postMessage({channel, type:'saved', token, documentId, requestId:message.requestId}, '*');
            }
          });
          window.__reopenSavedData = () => {
            const data = state.savedData.slice(0);
            iframe.contentWindow.postMessage({channel, type:'open', token, data, documentId, readOnly:false}, '*', [data]);
          };
          window.__reopenFixture = () => {
            const data = fixtureBytes.slice(0);
            iframe.contentWindow.postMessage({channel, type:'open', token, data, documentId, readOnly:false}, '*', [data]);
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
      await page.waitForFunction(() => window.__hostState?.opened === 1, {
        timeout: 45_000,
      });
      const viewer = page
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
        await page.evaluate(() => window.__reopenFixture());
        await page.waitForFunction(
          (expected) => window.__hostState.opened === expected,
          { timeout: 90_000 },
          openCount,
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

      const saveAndReopen = async (saveCount, openCount) => {
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
        await page.evaluate(() => window.__reopenSavedData());
        await page.waitForFunction(
          (expected) => window.__hostState.opened === expected,
          { timeout: 90_000 },
          openCount,
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
        errors,
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
      assert.deepEqual(errors, []);
      console.log(
        `Underline geometry and PDF round-trip captured in tests/artifacts/underline-regression-${captureId}.{json,png,pdf}`,
      );
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await removeTempRoot(temp);
    }
  },
);
