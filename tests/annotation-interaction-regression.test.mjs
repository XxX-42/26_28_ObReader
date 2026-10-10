import assert from "node:assert/strict";
import { createReadStream, existsSync } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
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

const typeNames = new Map([
  [3, "FreeText"],
  [5, "Square"],
  [9, "Highlight"],
  [10, "Underline"],
  [15, "Ink"],
]);

test(
  "annotation creation tools take priority over existing markup only while creating",
  { timeout: 300_000 },
  async () => {
    assert.ok(browserPath, "Set PDF_READER_CHROME to Chrome or Edge");
    await mkdir(artifacts, { recursive: true });

    const mainSource = await readBuiltMain();
    const payload = readPayloadFromMain(mainSource);
    const distFiles = (await import("node:fs/promises")).readdir;
    assert.deepEqual(
      (await distFiles(dist)).sort(),
      ["main.js", "manifest.json", "styles.css"],
      "The test must start from the built three-file plugin",
    );

    const temp = await createTempRoot("annotation-interaction-regression-");
    const adapter = createDiskAdapter(temp);
    const harness = loadBundledPlugin(mainSource, adapter);
    await harness.load();
    const logicalAssetRoot = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
    const output = adapter.resolve(logicalAssetRoot);
    const captureId = payload.contentHash.slice(0, 12);
    const results = [];
    const errors = [];
    const externalRequests = [];
    let apiRequestCount = 0;
    let browser;
    let server;
    const persistProgress = async () =>
      writeFile(
        path.join(
          artifacts,
          `annotation-interaction-${captureId}.partial.json`,
        ),
        JSON.stringify(
          {
            fixture:
              "tests/fixtures/tracemonkey.pdf (read-only public fixture)",
            payloadId: payload.id,
            contentHash: payload.contentHash,
            browserPath,
            scenarios: results,
            apiRequestCount,
            externalRequests,
            errors,
          },
          null,
          2,
        ),
        "utf8",
      );

    server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) apiRequestCount += 1;
      if (url.pathname === "/" || url.pathname === "/favicon.ico") {
        response.writeHead(url.pathname === "/" ? 200 : 204, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(
          url.pathname === "/"
            ? "<!doctype html><title>Annotation interaction regression</title>"
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
      const view = harness.createView();
      const viewerDocument = await view.createViewerDocument();
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
          const channel='pdf-web-reader', token=${JSON.stringify(view.token)};
          const documentId='fixtures/tracemonkey.pdf';
          const iframe=document.querySelector('iframe');
          const state=window.__hostState={opened:0,saves:0,savedData:null};
          let fixtureBytes;
          window.addEventListener('message',event=>{
            if(event.source!==iframe.contentWindow)return;
            const message=event.data;
            if(!message||message.channel!==channel||message.token!==token)return;
            if(message.type==='ready'){
              const data=fixtureBytes.slice(0);
              iframe.contentWindow.postMessage({channel,type:'open',token,data,documentId,readOnly:false},'*',[data]);
            } else if(message.type==='opened') state.opened+=1;
            else if(message.type==='save'){
              state.saves+=1; state.savedData=message.data.slice(0);
              iframe.contentWindow.postMessage({channel,type:'saved',token,documentId,requestId:message.requestId,sessionId:message.sessionId},'*');
            }
          });
          window.__reopenSavedData=()=>{
            const data=state.savedData.slice(0);
            iframe.contentWindow.postMessage({channel,type:'open',token,data,documentId,readOnly:false},'*',[data]);
          };
          window.__reopenFixture=()=>{
            const data=fixtureBytes.slice(0);
            iframe.contentWindow.postMessage({channel,type:'open',token,data,documentId,readOnly:false},'*',[data]);
          };
          (async()=>{
            fixtureBytes=await fetch('/fixtures/tracemonkey.pdf').then(response=>{
              if(!response.ok)throw new Error('fixture fetch failed');
              return response.arrayBuffer();
            });
            iframe.srcdoc=${viewerLiteral};
          })().catch(error=>state.error=error.message);
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
      await new Promise((resolve) => setTimeout(resolve, 1300));
      assert.equal(
        await page.evaluate(() => window.__hostState.saves),
        0,
        "Opening alone must not write the PDF",
      );
      // Real mouse events inside the packaged srcdoc viewer, not synthetic
      // DOM dispatch: this also exercises capture and the middle-button mask.
      const wheelCenter = { x: 700, y: 500 };
      const wheelMode = () =>
        viewer.evaluate(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode,
        );
      const openWheel = async () => {
        await page.mouse.move(wheelCenter.x, wheelCenter.y);
        await page.mouse.down({ button: "middle" });
        await viewer.waitForSelector(".pdfToolWheel");
      };
      const wheelModes = [null, 3, 15, 9, 5, 10];
      for (let index = 1; index < 6; index++) {
        await openWheel();
        if (index === 1) {
          await page.screenshot({
            path: path.join(artifacts, `tool-wheel-${captureId}.png`),
          });
        }
        const angle = ((index * 60 - 90) * Math.PI) / 180;
        const previousMode = await wheelMode();
        await page.mouse.move(700, 580);
        assert.equal(
          await wheelMode(),
          previousMode,
          "Crossing another sector only previews",
        );
        await page.mouse.move(
          wheelCenter.x + 80 * Math.cos(angle),
          wheelCenter.y + 80 * Math.sin(angle),
        );
        assert.ok(
          await viewer.$(".pdfToolWheel"),
          "Held movement only previews",
        );
        assert.equal(
          await wheelMode(),
          previousMode,
          "Tool must not change until release",
        );
        await page.mouse.up({ button: "middle" });
        await viewer.waitForFunction(
          () => !document.querySelector(".pdfToolWheel"),
        );
        await viewer.waitForFunction(
          (mode) =>
            PDFViewerApplication.pdfViewer.annotationEditorMode === mode,
          {},
          wheelModes[index],
        );
      }
      assert.equal(await wheelMode(), 10);
      await openWheel();
      await page.mouse.up({ button: "middle" });
      await page.mouse.click(631, 460);
      assert.equal(
        await wheelMode(),
        10,
        "Selecting active tool does not toggle it off",
      );
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      await openWheel();
      await page.mouse.move(700, 420);
      assert.ok(await viewer.$(".pdfToolWheel"), "Exit also waits for release");
      await page.mouse.up({ button: "middle" });
      await viewer.waitForFunction(
        () => !document.querySelector(".pdfToolWheel"),
      );
      assert.equal(await wheelMode(), 10, "Exit preserves selected underline");
      await openWheel();
      await page.mouse.up({ button: "middle" });
      await page.mouse.move(700, 580);
      assert.ok(
        await viewer.$(".pdfToolWheel"),
        "Released wheel must not select on hover",
      );
      assert.equal(await wheelMode(), 10);
      await page.mouse.click(700, 580);
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 9,
      );
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      await openWheel();
      await page.mouse.move(631, 460);
      assert.equal(
        await wheelMode(),
        9,
        "Returning from a sector to the center must not select",
      );
      await page.mouse.move(705, 505);
      assert.ok(await viewer.$(".pdfToolWheel"), "Center dead zone");
      await page.mouse.up({ button: "middle" });
      await page.keyboard.press("Escape");
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      assert.equal(await wheelMode(), 9, "Escape only closes wheel");
      await openWheel();
      await page.mouse.up({ button: "middle" });
      await page.mouse.click(930, 500);
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      assert.equal(await wheelMode(), 9);
      await openWheel();
      await page.mouse.up({ button: "middle" });
      await viewer.evaluate(() => window.dispatchEvent(new Event("blur")));
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      await page.mouse.move(20, 500);
      await page.mouse.down({ button: "middle" });
      await page.mouse.up({ button: "middle" });
      assert.equal(
        await viewer.$(".pdfToolWheel"),
        null,
        "Insufficient edge space",
      );
      await page.mouse.move(70, 500);
      await page.mouse.down({ button: "middle" });
      assert.equal(
        await viewer.$eval(
          ".pdfToolWheel",
          (el) => el.getBoundingClientRect().width,
        ),
        140,
        "Wheel shrinks at edge without moving its center",
      );
      await page.mouse.up({ button: "middle" });
      await page.mouse.move(700, 500);
      await page.mouse.down({ button: "middle" });
      assert.equal(
        await viewer.$eval(
          ".pdfToolWheel",
          (el) => el.getBoundingClientRect().width,
        ),
        240,
        "Second middle press recenters wheel",
      );
      await page.mouse.up({ button: "middle" });
      await viewer.evaluate(() =>
        window.dispatchEvent(new PointerEvent("pointercancel")),
      );
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      await viewer.evaluate(() => {
        const input = document.createElement("input");
        input.id = "wheel-test-input";
        input.style.cssText =
          "position:fixed;left:600px;top:450px;width:200px;height:40px;z-index:10000";
        PDFViewerApplication.pdfViewer.container.append(input);
      });
      await page.mouse.click(650, 470, { button: "middle" });
      assert.equal(
        await viewer.$(".pdfToolWheel"),
        null,
        "Inputs must not trigger wheel",
      );
      // Input middle-click retains browser behavior; dismiss Chrome's native
      // autoscroll before resuming PDF-area pointer assertions.
      await page.keyboard.press("Escape");
      await viewer.evaluate(() =>
        document.getElementById("wheel-test-input").remove(),
      );
      await openWheel();
      await page.mouse.up({ button: "middle" });
      await viewer.evaluate(() => window.dispatchEvent(new Event("resize")));
      assert.equal(await viewer.$(".pdfToolWheel"), null);
      await page.mouse.move(700, 500);
      await page.keyboard.press("Backquote");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
      );
      results.push({
        scenario:
          "middle-button wheel: five held selections, exit, persistent click, dead zone, Escape, outside, blur, edge",
        passed: true,
      });
      await viewer.evaluate(() => {
        window.__interactionEvents = [];
        const describe = (element) => {
          if (!element) return null;
          return {
            tag: element.tagName,
            id: element.id || "",
            className:
              typeof element.className === "string" ? element.className : "",
            text: (element.textContent || "").trim().slice(0, 80),
          };
        };
        for (const type of [
          "pointerdown",
          "pointermove",
          "pointerup",
          "mousedown",
          "mouseup",
          "click",
          "dblclick",
        ]) {
          document.addEventListener(
            type,
            (event) => {
              if (
                type === "pointermove" &&
                "buttons" in event &&
                event.buttons === 0
              ) {
                return;
              }
              const hit = document.elementFromPoint(
                event.clientX,
                event.clientY,
              );
              const layer = document.querySelector(
                '.page[data-page-number="1"] .annotationEditorLayer',
              );
              window.__interactionEvents.push({
                type,
                target: describe(event.target),
                hit: describe(hit),
                point: { x: event.clientX, y: event.clientY },
                buttons: event.buttons,
                pointerId: event.pointerId,
                stack: document
                  .elementsFromPoint(event.clientX, event.clientY)
                  .slice(0, 4)
                  .map(describe),
                targetInTextLayer: Boolean(
                  event.target.closest?.(".textLayer"),
                ),
                targetInEditorLayer: Boolean(
                  event.target.closest?.(".annotationEditorLayer"),
                ),
                layerClass: layer?.className || "",
                drawingChildren: [...(layer?.children || [])]
                  .filter((element) => element.classList.contains("drawing"))
                  .map((element) => element.id),
                mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
              });
            },
            true,
          );
        }
        document.addEventListener(
          "selectionchange",
          () => {
            const selection = document.getSelection();
            const text = selection?.toString() || "";
            if (text) {
              window.__interactionEvents.push({
                type: "selectionchange",
                text,
                anchor: describe(selection?.anchorNode?.parentElement),
                focus: describe(selection?.focusNode?.parentElement),
              });
            }
          },
          true,
        );
      });

      const iframeBox = await page.$eval("iframe", (iframe) => {
        const rect = iframe.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      const mouseMove = async (start, end, steps = 10) => {
        await page.mouse.move(iframeBox.x + start.x, iframeBox.y + start.y, {
          steps: 2,
        });
        await page.mouse.down({ button: "left" });
        await page.mouse.move(iframeBox.x + end.x, iframeBox.y + end.y, {
          steps,
        });
        await page.mouse.up({ button: "left" });
      };
      const mouseInkStroke = async (rect) => {
        const points = [
          { x: rect.x + 8, y: rect.y + 4 },
          { x: rect.x + rect.width * 0.25, y: rect.y + rect.height * 0.25 },
          { x: rect.x + rect.width * 0.52, y: rect.y + rect.height * 0.5 },
          { x: rect.x + rect.width * 0.77, y: rect.y + rect.height * 0.72 },
          { x: rect.x + rect.width - 8, y: rect.bottom - 4 },
        ];
        await page.mouse.move(
          iframeBox.x + points[0].x,
          iframeBox.y + points[0].y,
          {
            steps: 2,
          },
        );
        await page.mouse.down({ button: "left" });
        for (const point of points.slice(1)) {
          await page.mouse.move(iframeBox.x + point.x, iframeBox.y + point.y, {
            steps: 5,
          });
        }
        await page.mouse.up({ button: "left" });
      };
      const setMode = async (mode) => {
        await viewer.evaluate((value) => {
          PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
            mode: value,
          });
        }, mode);
        await viewer.waitForFunction(
          (value) =>
            PDFViewerApplication.pdfViewer.annotationEditorMode === value,
          { timeout: 8_000 },
          mode,
        );
      };
      const storageCounts = async () =>
        viewer.evaluate(() => {
          const entries = [
            ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
              []),
          ].filter((entry) => !entry.deleted);
          return Object.fromEntries(
            [3, 5, 9, 10, 15].map((type) => [
              type,
              entries.filter((entry) => entry.annotationType === type).length,
            ]),
          );
        });
      const pdfSubtypeCounts = async () =>
        viewer.evaluate(async () => {
          const page = await PDFViewerApplication.pdfDocument.getPage(1);
          const annotations = await page.getAnnotations();
          return Object.fromEntries(
            ["FreeText", "Square", "Highlight", "Underline", "Ink"].map(
              (subtype) => [
                subtype,
                annotations.filter(
                  (annotation) => annotation.subtype === subtype,
                ).length,
              ],
            ),
          );
        });
      const clearProbe = async () =>
        viewer.evaluate(() => {
          window.__interactionEvents.length = 0;
          document.getSelection()?.removeAllRanges();
        });
      const waitForNewAnnotation = async (type, previousCount) =>
        viewer.waitForFunction(
          (annotationType, previous) => {
            const entries = [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter(
              (entry) =>
                entry.annotationType === annotationType && !entry.deleted,
            );
            return entries.length > previous;
          },
          { timeout: 12_000 },
          type,
          previousCount,
        );
      const phraseGeometry = async (
        phrase = "Dynamic languages such as JavaScript",
      ) =>
        viewer.evaluate((targetPhrase) => {
          const spans = [
            ...document.querySelectorAll(
              '.page[data-page-number="1"] .textLayer span',
            ),
          ];
          const span = spans.find((node) =>
            node.textContent.includes(targetPhrase),
          );
          const node = span?.firstChild;
          if (!node || node.nodeType !== Node.TEXT_NODE) {
            throw new Error(`Could not find text-node phrase: ${targetPhrase}`);
          }
          const from = node.textContent.indexOf(targetPhrase);
          const to = from + targetPhrase.length;
          const charRect = (offset) => {
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            const rect = range.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              top: rect.top,
              bottom: rect.bottom,
            };
          };
          const first = charRect(from);
          const last = charRect(to - 1);
          const range = document.createRange();
          range.setStart(node, from);
          range.setEnd(node, to);
          const rect = range.getBoundingClientRect();
          const box = {
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          };
          return {
            phrase: targetPhrase,
            rect: box,
            start: {
              x: first.left + Math.min(1, (first.right - first.left) / 2),
              y: (first.top + first.bottom) / 2,
            },
            end: {
              x: last.right - Math.min(1, (last.right - last.left) / 2),
              y: (last.top + last.bottom) / 2,
            },
          };
        }, phrase);
      const squareEditors = async () =>
        viewer.evaluate(() => {
          const storage = PDFViewerApplication.pdfDocument.annotationStorage;
          return [
            ...document.querySelectorAll(
              '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
            ),
          ]
            .filter((element) => {
              const editor = storage.getRawValue(element.id);
              return editor?.constructor?._editorType === 5;
            })
            .map((element) => {
              const editor = storage.getRawValue(element.id);
              const rect = element.getBoundingClientRect();
              return {
                id: element.id,
                uid: editor.uid,
                annotationElementId: editor.annotationElementId || null,
                className: element.className,
                rect: {
                  x: rect.x,
                  y: rect.y,
                  right: rect.right,
                  bottom: rect.bottom,
                  width: rect.width,
                  height: rect.height,
                },
              };
            });
        });
      const getTextDragPoints = async (
        phrase = "Dynamic languages such as JavaScript",
      ) => {
        const geometry = await phraseGeometry(phrase);
        return viewer.evaluate((target) => {
          const layer = document.querySelector(
            '.page[data-page-number="1"] .annotationEditorLayer',
          );
          const xLeft = target.start.x;
          const xRight = target.end.x;
          const overlays = [...(layer?.children || [])].map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName,
              className: element.className,
              rect: {
                x: rect.x,
                y: rect.y,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.width,
                height: rect.height,
              },
            };
          });
          const overlapping = overlays.find(
            ({ rect }) =>
              rect.width > 0 &&
              rect.height > 0 &&
              rect.x <= xLeft &&
              rect.right >= xRight &&
              Math.min(rect.bottom, target.rect.bottom) >
                Math.max(rect.y, target.rect.y),
          );
          const y = overlapping
            ? (Math.max(overlapping.rect.y, target.rect.y) +
                Math.min(overlapping.rect.bottom, target.rect.bottom)) /
              2
            : (target.start.y + target.end.y) / 2;
          const start = { ...target.start, y };
          const end = { ...target.end, y };
          const describe = (element) =>
            element
              ? {
                  tag: element.tagName,
                  id: element.id || "",
                  className:
                    typeof element.className === "string"
                      ? element.className
                      : "",
                }
              : null;
          return {
            ...target,
            start,
            end,
            overlappingEditor: overlapping || null,
            plannedStartHit: document
              .elementsFromPoint(start.x, start.y)
              .slice(0, 5)
              .map(describe),
            plannedEndHit: document
              .elementsFromPoint(end.x, end.y)
              .slice(0, 5)
              .map(describe),
          };
        }, geometry);
      };
      const eventSummary = async () =>
        viewer.evaluate(() => ({
          events: [...window.__interactionEvents],
          selection: document.getSelection()?.toString() || "",
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        }));
      const openCount = async () =>
        page.evaluate(() => window.__hostState.opened);
      const saveCount = async () =>
        page.evaluate(() => window.__hostState.saves);
      const reopenFixture = async () => {
        const expected = (await openCount()) + 1;
        await page.evaluate(() => window.__reopenFixture());
        await page.waitForFunction(
          (count) => window.__hostState.opened === count,
          { timeout: 60_000 },
          expected,
        );
        await viewer.waitForSelector(
          '.page[data-page-number="1"] .textLayer span',
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      };
      const reopenSavedData = async () => {
        const expected = (await openCount()) + 1;
        await page.evaluate(() => window.__reopenSavedData());
        await page.waitForFunction(
          (count) => window.__hostState.opened === count,
          { timeout: 60_000 },
          expected,
        );
        await viewer.waitForSelector(
          '.page[data-page-number="1"] .textLayer span',
        );
        await viewer.waitForSelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
      };
      const waitAutoSave = async (previous) => {
        await page.waitForFunction(
          (count) => window.__hostState.saves > count,
          { timeout: 15000 },
          previous,
        );
        await viewer.waitForFunction(
          () => !PDFViewerApplication._saveInProgress,
        );
        const status = await viewer.evaluate(() => {
          const element = document.getElementById("pdfReaderSaveStatus");
          return {
            text: element?.textContent,
            toolbar: !!element?.closest("#toolbarViewer"),
            width: element?.getBoundingClientRect().width,
            popup:
              document.getElementById("pdfReaderBridgeStatus")?.textContent ||
              "",
          };
        });
        assert.equal(status.text, undefined);
        assert.equal(status.toolbar, false);
        assert.doesNotMatch(status.popup, /^(待保存|保存中|已保存)$/);
      };
      const saveAndReopen = async (automatic = false) => {
        const expectedSave = (await saveCount()) + 1;
        if (automatic) {
          await waitAutoSave(expectedSave - 1);
        } else {
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
            (count) => window.__hostState.saves >= count,
            { timeout: 60_000 },
            expectedSave,
          );
        }
        await viewer.waitForFunction(
          () => !PDFViewerApplication._saveInProgress,
          { timeout: 60_000 },
        );
        const byteLength = await page.evaluate(
          () => window.__hostState.savedData?.byteLength || 0,
        );
        assert.ok(byteLength > 0, "Host save bridge should retain a PDF copy");
        await reopenSavedData();
        return { byteLength, save: expectedSave };
      };
      const rightDrag = await phraseGeometry();
      await setMode(5);
      const initialSquares = (await storageCounts())[5];
      await mouseMove(
        { x: rightDrag.rect.x - 3, y: rightDrag.rect.y - 3 },
        { x: rightDrag.rect.right + 3, y: rightDrag.rect.bottom + 3 },
      );
      await waitForNewAnnotation(5, initialSquares);
      const beforeRightDrag = await storageCounts();
      await viewer.evaluate(() => {
        window.__rightMenus = [];
        document.addEventListener("contextmenu", (event) =>
          window.__rightMenus.push({ prevented: event.defaultPrevented }),
        );
      });
      await setMode(10);
      await page.mouse.click(rightDrag.start.x, rightDrag.start.y, {
        button: "right",
      });
      assert.equal(await wheelMode(), 10, "Right-click must not change tools");
      assert.deepEqual(
        await storageCounts(),
        beforeRightDrag,
        "Right-click does not erase",
      );
      assert.ok(
        await viewer.evaluate(() =>
          window.__rightMenus.some((event) => !event.prevented),
        ),
        "Ordinary contextmenu stays available",
      );
      await page.keyboard.press("Escape");
      // Give native selectionchange callbacks time to run after right-button
      // release; an immediate storage snapshot can miss delayed annotations.
      for (let attempt = 0; attempt < 10; attempt++) {
        await page.mouse.click(rightDrag.start.x, rightDrag.start.y, {
          button: "right",
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(
          await storageCounts(),
          beforeRightDrag,
          `Right-click ${attempt + 1} must not create delayed annotations`,
        );
        assert.equal(await wheelMode(), 10);
        await page.keyboard.press("Escape");
      }
      // Some platforms select the word under a context-menu click only after
      // pointerup. Replay that native default-action timing deterministically.
      await viewer.evaluate(() => {
        document.addEventListener(
          "contextmenu",
          () => {
            setTimeout(() => {
              const text = document.querySelector(
                ".page .textLayer span",
              )?.firstChild;
              if (!text)
                throw new Error("Missing text for context selection probe");
              const range = document.createRange();
              range.setStart(text, 0);
              range.setEnd(text, Math.min(6, text.length));
              const selection = document.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }, 0);
          },
          { once: true },
        );
      });
      await page.mouse.click(rightDrag.start.x, rightDrag.start.y, {
        button: "right",
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(
        await storageCounts(),
        beforeRightDrag,
        "Delayed context-menu text selection must not create underline",
      );
      await viewer.evaluate(() => document.getSelection().removeAllRanges());
      await page.keyboard.press("Escape");
      for (const originalMode of [0, 3, 5, 9, 10, 15, 17]) {
        await setMode(originalMode);
        await page.mouse.move(rightDrag.start.x, rightDrag.start.y);
        await page.mouse.down({ button: "right" });
        await page.mouse.move(rightDrag.start.x + 2, rightDrag.start.y);
        assert.equal(
          await wheelMode(),
          originalMode,
          "Tiny click jitter must not activate temporary eraser",
        );
        await page.mouse.move(rightDrag.end.x, rightDrag.end.y, { steps: 10 });
        await viewer.waitForFunction(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode === 17,
        );
        await page.mouse.up({ button: "right" });
        await viewer.waitForFunction(
          (mode) =>
            PDFViewerApplication.pdfViewer.annotationEditorMode === mode,
          {},
          originalMode,
        );
        assert.equal(
          (await storageCounts())[5],
          initialSquares,
          "Right-drag erases square",
        );
        assert.equal(
          (await storageCounts())[9],
          beforeRightDrag[9],
          "Right-drag no longer creates highlights",
        );
        await page.keyboard.down("Control");
        await page.keyboard.press("z");
        await page.keyboard.up("Control");
        await viewer.waitForFunction(
          (count) =>
            [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].filter((entry) => entry.annotationType === 5 && !entry.deleted)
              .length === count,
          {},
          beforeRightDrag[5],
        );
        if (originalMode === 0) {
          await page.keyboard.down("Control");
          await page.keyboard.press("y");
          await page.keyboard.up("Control");
          assert.equal(
            (await storageCounts())[5],
            initialSquares,
            "Redo reapplies erasure without changing NONE",
          );
          await page.keyboard.down("Control");
          await page.keyboard.press("z");
          await page.keyboard.up("Control");
          assert.equal((await storageCounts())[5], beforeRightDrag[5]);
        }
      }
      await setMode(10);
      await page.mouse.move(rightDrag.start.x, rightDrag.start.y);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(rightDrag.end.x, rightDrag.end.y, { steps: 10 });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 17,
      );
      await viewer.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.mouse.up({ button: "right" });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 10,
      );
      await page.keyboard.down("Control");
      await page.keyboard.press("z");
      await page.keyboard.up("Control");
      assert.equal(
        (await storageCounts())[5],
        beforeRightDrag[5],
        "Cancellation restores tool and keeps erasure undoable",
      );
      const menuCount = await viewer.evaluate(() => window.__rightMenus.length);
      await page.mouse.click(rightDrag.start.x, rightDrag.start.y, {
        button: "right",
      });
      assert.ok(
        await viewer.evaluate(
          (count) => window.__rightMenus.length > count,
          menuCount,
        ),
        "New right-click after drag is not suppressed",
      );
      await page.keyboard.press("Escape");
      assert.equal(
        await viewer.$(".pdfToolWheel"),
        null,
        "Right-drag does not open wheel",
      );
      await openWheel();
      await page.mouse.up({ button: "middle" });
      await reopenFixture();
      assert.equal(
        await viewer.$(".pdfToolWheel"),
        null,
        "Document replacement cleans up persistent wheel",
      );
      results.push({
        scenario:
          "right-click retains contextmenu; drag erases with undo and restores all five tools, NONE and ERASER; reopening cleans up wheel",
        passed: true,
      });
      const createSquareAroundText = async (phrase) => {
        const target = await phraseGeometry(phrase);
        const before = await storageCounts();
        await clearProbe();
        await setMode(5);
        await mouseMove(
          { x: target.rect.x - 3, y: target.rect.y - 3 },
          { x: target.rect.right + 3, y: target.rect.bottom + 3 },
          8,
        );
        await waitForNewAnnotation(5, before[5]);
        const after = await storageCounts();
        return {
          target,
          storageBefore: before,
          storageAfter: after,
          storage: after,
          events: await eventSummary(),
        };
      };
      const createTextMarkup = async (type) => {
        const before = await storageCounts();
        const target = await getTextDragPoints();
        await clearProbe();
        await setMode(type);
        const modeBefore = await viewer.evaluate(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode,
        );
        await mouseMove(target.start, target.end, 12);
        await waitForNewAnnotation(type, before[type]);
        const summary = await eventSummary();
        const after = await storageCounts();
        return {
          type,
          modeBefore,
          modeAfter: summary.mode,
          target,
          storageBefore: before,
          storageAfter: after,
          eventSummary: summary,
        };
      };
      const assertTextSelectionWasPrioritized = (result, type) => {
        const pointerdown = result.eventSummary.events.find(
          (event) => event.type === "pointerdown",
        );
        assert.ok(
          pointerdown,
          `${typeNames.get(type)} must receive a real pointerdown`,
        );
        assert.equal(
          pointerdown.targetInTextLayer,
          true,
          `${typeNames.get(type)} should route old-markup drags to the text layer; hit was ${JSON.stringify(pointerdown)}`,
        );
        assert.equal(
          pointerdown.targetInEditorLayer,
          false,
          `${typeNames.get(type)} must not select the existing editor body during creation`,
        );
        const observedSelection = [
          result.eventSummary.selection,
          ...result.eventSummary.events
            .filter((event) => event.type === "selectionchange")
            .map((event) => event.text),
        ].join("\n");
        assert.match(
          observedSelection,
          /Dynamic languages/,
          `${typeNames.get(type)} should produce a native text selection`,
        );
        assert.equal(
          result.modeAfter,
          type,
          `${typeNames.get(type)} creation must leave the requested tool active`,
        );
        assert.equal(
          result.storageAfter[type],
          result.storageBefore[type] + 1,
          `${typeNames.get(type)} should add exactly one annotation`,
        );
      };
      const assertDrawingWasPrioritized = (result, type) => {
        const pointerdown = result.events.events.find(
          (event) => event.type === "pointerdown",
        );
        assert.ok(
          pointerdown,
          `${typeNames.get(type)} must receive pointerdown`,
        );
        assert.equal(
          pointerdown.targetInEditorLayer,
          true,
          `${typeNames.get(type)} should start drawing on the annotation layer, not the old editor body: ${JSON.stringify(pointerdown)}`,
        );
        assert.equal(
          result.events.mode,
          type,
          `${typeNames.get(type)} drawing must leave the creation tool active`,
        );
        assert.equal(
          result.storageAfter[type],
          result.storageBefore[type] + 1,
          `${typeNames.get(type)} should add exactly one annotation`,
        );
      };

      // Create a true mouse-drawn Square, then save/reopen it. The following
      // tests begin inside this persisted body instead of manufacturing a DOM
      // Selection, so they exercise Chrome hit-testing and PDF.js event routing.
      const baseSquare = await createSquareAroundText(
        "Dynamic languages such as JavaScript",
      );
      const baseSquareSave = await saveAndReopen(true);
      await setMode(5);
      await viewer.waitForFunction(
        () =>
          document.querySelectorAll(
            '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
          ).length >= 1,
        { timeout: 8_000 },
      );
      const squareEditorsAfterReopen = await squareEditors();
      results.push({
        scenario: "square-base-save-reopen",
        baseSquare,
        save: baseSquareSave,
        squareEditorsAfterReopen,
      });
      await persistProgress();
      assert.ok(
        squareEditorsAfterReopen.length >= 1,
        "The saved Square must be restored as an editable layer object",
      );

      // Core regression: the underline tool must still route real pointer
      // drags through a saved Square to the text layer, and the newly created
      // annotation must survive the host save/reopen bridge.
      const underlineOnSquare = await createTextMarkup(10);
      results.push({
        scenario: "underline-over-saved-square",
        underlineOnSquare,
      });
      await persistProgress();
      assertTextSelectionWasPrioritized(underlineOnSquare, 10);
      const underlineSave = await saveAndReopen(true);
      const pdfAfterUnderlineSave = await pdfSubtypeCounts();
      results.at(-1).save = underlineSave;
      results.at(-1).pdfAfterSave = pdfAfterUnderlineSave;
      await persistProgress();
      assert.ok(
        pdfAfterUnderlineSave.Underline >= 1,
        "A mouse-created Underline over old markup must survive save/reopen",
      );
      const underlineOverUnderline = await createTextMarkup(10);
      results.at(-1).underlineOverSavedUnderline = underlineOverUnderline;
      await persistProgress();
      assertTextSelectionWasPrioritized(underlineOverUnderline, 10);

      // Starting inside an old Square in Square mode must create a second
      // Square, not select/move the old editor. Save it as the reusable
      // two-Square fixture for the remaining branches.
      await setMode(5);
      const squareBefore = await storageCounts();
      const oldSquare = (await squareEditors())[0];
      const squareStart = {
        x: oldSquare.rect.x + oldSquare.rect.width * 0.35,
        y: oldSquare.rect.y + oldSquare.rect.height / 2,
      };
      const squareEnd = {
        x: oldSquare.rect.x + oldSquare.rect.width * 0.7,
        y: oldSquare.rect.y + oldSquare.rect.height / 2 + 7,
      };
      await clearProbe();
      await mouseMove(squareStart, squareEnd, 8);
      await waitForNewAnnotation(5, squareBefore[5]);
      const squareOnSquare = {
        storageBefore: squareBefore,
        storageAfter: await storageCounts(),
        events: await eventSummary(),
      };
      results.push({
        scenario: "square-inside-saved-square",
        oldSquare,
        squareOnSquare,
      });
      await persistProgress();
      assertDrawingWasPrioritized(squareOnSquare, 5);
      const twoSquareSave = await saveAndReopen();
      await setMode(5);
      await viewer.waitForFunction(
        () =>
          document.querySelectorAll(
            '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
          ).length >= 2,
        { timeout: 8_000 },
      );
      const squaresAfterSave = await squareEditors();
      const pdfAfterSquareSave = await pdfSubtypeCounts();
      results.at(-1).save = twoSquareSave;
      results.at(-1).squaresAfterSave = squaresAfterSave;
      results.at(-1).pdfAfterSave = pdfAfterSquareSave;
      await persistProgress();
      assert.ok(
        squaresAfterSave.length >= 2 && pdfAfterSquareSave.Square >= 2,
        `Both mouse-created Squares must survive save/reopen; editors=${squaresAfterSave.length}, PDF=${pdfAfterSquareSave.Square}`,
      );

      // Ink starts in the restored Square body. The page editor layer should
      // receive the actual pointer and create a new stroke.
      await setMode(15);
      const inkBefore = await storageCounts();
      const inkAutoBefore = await saveCount();
      const inkStartSquare = (await squareEditors())[0];
      await clearProbe();
      await mouseInkStroke(inkStartSquare.rect);
      const inkGestureEvents = await eventSummary();
      assert.ok(
        inkGestureEvents.events.some(
          (event) =>
            event.type === "pointermove" &&
            event.layerClass.includes("drawing"),
        ),
        "Ink should enter the drawing session while the mouse is held",
      );
      assert.equal(inkGestureEvents.mode, 15);
      // Idle automatic saving commits the drawing without leaving Ink mode.
      try {
        await waitForNewAnnotation(15, inkBefore[15]);
      } catch (error) {
        const failure = {
          scenario: "ink-inside-saved-square-commit-timeout",
          square: inkStartSquare,
          storageBefore: inkBefore,
          storageAfter: await storageCounts(),
          events: inkGestureEvents,
          afterEscape: await viewer.evaluate(() => ({
            mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
            layerClass: document.querySelector(
              '.page[data-page-number="1"] .annotationEditorLayer',
            )?.className,
            activeElement: {
              tag: document.activeElement?.tagName,
              className: document.activeElement?.className,
            },
            rawValues: [
              ...(PDFViewerApplication.pdfDocument.annotationStorage.serializable.map?.values() ||
                []),
            ].map((entry) => ({
              annotationType: entry.annotationType,
              deleted: entry.deleted,
              rect: entry.rect,
            })),
          })),
        };
        results.push(failure);
        await persistProgress();
        throw new Error(
          `${error.message}; evidence: ${JSON.stringify(failure)}`,
        );
      }
      const inkInSquare = {
        storageBefore: inkBefore,
        storageAfter: await storageCounts(),
        events: inkGestureEvents,
        modeAfterCommit: (await eventSummary()).mode,
      };
      results.push({ scenario: "ink-inside-saved-square", inkInSquare });
      await persistProgress();
      assertDrawingWasPrioritized(inkInSquare, 15);
      await waitAutoSave(inkAutoBefore);
      assert.equal(
        await wheelMode(),
        15,
        "Autosave must not leave the Ink tool",
      );
      results.push({ scenario: "ink-autosave", saves: await saveCount() });

      // Discard that branch and use the saved two-Square document to create a
      // FreeText box over old markup with the real mouse.
      await reopenSavedData();
      await setMode(3);
      const freeTextBefore = await storageCounts();
      const freeTextSquare = (await squareEditors())[0];
      await clearProbe();
      await page.mouse.click(
        iframeBox.x + freeTextSquare.rect.x + freeTextSquare.rect.width / 2,
        iframeBox.y + freeTextSquare.rect.y + freeTextSquare.rect.height / 2,
        { button: "left" },
      );
      await viewer.waitForSelector(
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
      );
      const textAutoBefore = await saveCount();
      await viewer.type(
        '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
        "12345",
      );
      await waitAutoSave(textAutoBefore);
      const freeTextBeforeCommit = await viewer.evaluate(() => {
        const internal = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal',
        );
        return {
          text: internal?.textContent || "",
          contentEditable: internal?.getAttribute("contenteditable"),
          active: document.activeElement === internal,
        };
      });
      assert.equal(freeTextBeforeCommit.contentEditable, "true");
      assert.equal(
        freeTextBeforeCommit.active,
        true,
        "Autosave must retain text input focus",
      );
      assert.match(freeTextBeforeCommit.text, /12345/);
      await page.keyboard.type("6");
      const secondTextSave = await saveCount();
      await waitAutoSave(secondTextSave);
      assert.equal(
        await viewer.evaluate(() => document.activeElement?.textContent),
        "123456",
        "Typing continues at the same caret after automatic save",
      );
      await page.keyboard.press("Escape");
      await waitForNewAnnotation(3, freeTextBefore[3]);
      const freeTextOnSquare = {
        storageBefore: freeTextBefore,
        storageAfter: await storageCounts(),
        events: await eventSummary(),
        input: freeTextBeforeCommit,
      };
      results.push({
        scenario: "freetext-over-saved-square",
        freeTextOnSquare,
      });
      await persistProgress();
      assert.equal(freeTextOnSquare.storageAfter[3], freeTextBefore[3] + 1);
      assert.equal(
        freeTextOnSquare.input.contentEditable,
        "true",
        "New FreeText must remain editable over existing markup",
      );
      assert.equal(freeTextOnSquare.events.mode, 3);
      const freeTextSave = await saveAndReopen();
      const savedFreeText = await viewer.evaluate(async () => {
        const page = await PDFViewerApplication.pdfDocument.getPage(1);
        return (await page.getAnnotations())
          .filter((annotation) => annotation.subtype === "FreeText")
          .map((annotation) => ({
            contents: annotation.contents,
            contentsObj: annotation.contentsObj?.str,
            rect: annotation.rect,
          }));
      });
      results.at(-1).save = freeTextSave;
      results.at(-1).savedFreeText = savedFreeText;
      await persistProgress();
      assert.ok(
        savedFreeText.some(
          (annotation) =>
            annotation.contents?.includes("12345") ||
            annotation.contentsObj?.includes("12345"),
        ),
        "Entered FreeText '12345' must survive save/reopen",
      );

      // Create a Highlight over the old markup, save/reopen it, and verify
      // that the next Highlight gesture selects text over its internal/SVG
      // bodies instead of entering object-selection mode.
      await reopenSavedData();
      const highlightOnMarkup = await createTextMarkup(9);
      results.push({
        scenario: "highlight-over-saved-markup-and-highlight",
        highlightOnMarkup,
      });
      await persistProgress();
      assertTextSelectionWasPrioritized(highlightOnMarkup, 9);
      const highlightSave = await saveAndReopen(true);
      results.at(-1).save = highlightSave;
      await persistProgress();
      const highlightOverHighlight = await createTextMarkup(9);
      results.at(-1).highlightOverHighlight = highlightOverHighlight;
      await persistProgress();
      assertTextSelectionWasPrioritized(highlightOverHighlight, 9);

      // Add an unmarked Square near the title so the NONE/double-click test
      // does not accidentally hit the several intentional markups over the
      // Abstract phrase used by the other scenarios.
      const titleSquare = await createSquareAroundText(
        "Trace-based Just-in-Time",
      );
      results.push({
        scenario: "separate-square-for-explicit-edit",
        titleSquare,
      });
      await persistProgress();
      assertDrawingWasPrioritized(titleSquare, 5);
      const titleSquareSave = await saveAndReopen();
      results.at(-1).save = titleSquareSave;
      await persistProgress();

      // Capture saved objects while mode 5 has reconstructed their editors;
      // NONE may tear down those DOM roots, so never read the target from the
      // disabled layer after switching modes.
      await setMode(5);
      await viewer.waitForFunction(
        () => {
          const storage = PDFViewerApplication.pdfDocument.annotationStorage;
          return (
            [
              ...document.querySelectorAll(
                '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
              ),
            ].filter(
              (element) =>
                storage.getRawValue(element.id)?.constructor?._editorType === 5,
            ).length >= 3
          );
        },
        { timeout: 8_000 },
      );
      const squaresBeforeEdit = await squareEditors();
      assert.ok(squaresBeforeEdit.length >= 3);
      const titleGeometry = await phraseGeometry("Trace-based Just-in-Time");
      const titleCenter = {
        x: titleGeometry.rect.x + titleGeometry.rect.width / 2,
        y: titleGeometry.rect.y + titleGeometry.rect.height / 2,
      };
      const firstSquare = [...squaresBeforeEdit].sort((left, right) => {
        const distance = (square) =>
          Math.hypot(
            square.rect.x + square.rect.width / 2 - titleCenter.x,
            square.rect.y + square.rect.height / 2 - titleCenter.y,
          );
        return distance(left) - distance(right);
      })[0];
      const secondSquareBeforeEdit = squaresBeforeEdit.find(
        (editor) => editor.id !== firstSquare.id,
      );
      await setMode(0);
      await clearProbe();
      await page.mouse.click(
        iframeBox.x + firstSquare.rect.x + firstSquare.rect.width / 2,
        iframeBox.y + firstSquare.rect.y + firstSquare.rect.height / 2,
        { button: "left", clickCount: 2, delay: 80 },
      );
      try {
        await viewer.waitForFunction(
          () =>
            PDFViewerApplication.pdfViewer.annotationEditorMode === 5 &&
            document.querySelector(
              '.page[data-page-number="1"] .annotationEditorLayer .explicitlyEditing',
            ),
          { timeout: 8_000 },
        );
      } catch (error) {
        const failure = {
          scenario: "none-doubleclick-edit-timeout",
          target: firstSquare,
          mode: await viewer.evaluate(
            () => PDFViewerApplication.pdfViewer.annotationEditorMode,
          ),
          events: await eventSummary(),
          pointHits: await viewer.evaluate(
            (point) =>
              document
                .elementsFromPoint(point.x, point.y)
                .slice(0, 8)
                .map((element) => ({
                  tag: element.tagName,
                  id: element.id,
                  className: element.className,
                })),
            {
              x: firstSquare.rect.x + firstSquare.rect.width / 2,
              y: firstSquare.rect.y + firstSquare.rect.height / 2,
            },
          ),
          layers: await viewer.evaluate(() => {
            const page = document.querySelector('.page[data-page-number="1"]');
            return [
              ...page.querySelectorAll(
                ".annotationEditorLayer, .annotationLayer",
              ),
            ].map((layer) => ({
              className: layer.className,
              pointerEvents: getComputedStyle(layer).pointerEvents,
              children: [...layer.children].slice(0, 10).map((child) => ({
                tag: child.tagName,
                className: child.className,
                id: child.id,
              })),
            }));
          }),
        };
        results.push(failure);
        await persistProgress();
        await page.screenshot({
          path: path.join(
            artifacts,
            `annotation-interaction-${captureId}-explicit-timeout.png`,
          ),
          fullPage: false,
        });
        throw new Error(
          `${error.message}; evidence: ${JSON.stringify(failure)}`,
        );
      }
      const explicitFirst = await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        const selected = layer.querySelector(".explicitlyEditing");
        const rect = selected.getBoundingClientRect();
        return {
          id: selected.id,
          uid: PDFViewerApplication.pdfDocument.annotationStorage.getRawValue(
            selected.id,
          )?.uid,
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          editorClass: selected.className,
          explicitCount: layer.querySelectorAll(".explicitlyEditing").length,
          selectedCount: layer.querySelectorAll(".selectedEditor").length,
          rect: {
            x: rect.x,
            y: rect.y,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
          toolbar: Boolean(selected.querySelector(".editToolbar")),
        };
      });
      assert.equal(explicitFirst.mode, 5);
      assert.equal(explicitFirst.explicitCount, 1);
      assert.equal(explicitFirst.toolbar, true);

      const moveStart = {
        x: explicitFirst.rect.x + explicitFirst.rect.width * 0.45,
        y: explicitFirst.rect.y + explicitFirst.rect.height / 2,
      };
      const moveEnd = { x: moveStart.x + 28, y: moveStart.y + 24 };
      await clearProbe();
      await mouseMove(moveStart, moveEnd, 8);
      await viewer.waitForFunction(
        ({ id, x, y }) => {
          const rect = document.getElementById(id)?.getBoundingClientRect();
          return rect && Math.abs(rect.x - x) > 5 && Math.abs(rect.y - y) > 5;
        },
        { timeout: 8_000 },
        {
          id: explicitFirst.id,
          x: explicitFirst.rect.x,
          y: explicitFirst.rect.y,
        },
      );
      const movedFirst = await viewer.evaluate((id) => {
        const rect = document.getElementById(id).getBoundingClientRect();
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        return {
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          explicitCount: layer.querySelectorAll(".explicitlyEditing").length,
          toolbarHitTesting: getComputedStyle(
            document.getElementById(id).querySelector(".editToolbar"),
          ).pointerEvents,
        };
      }, explicitFirst.id);
      assert.ok(Math.abs(movedFirst.rect.x - explicitFirst.rect.x) > 5);
      assert.ok(Math.abs(movedFirst.rect.y - explicitFirst.rect.y) > 5);
      assert.equal(movedFirst.explicitCount, 1);
      assert.notEqual(movedFirst.toolbarHitTesting, "none");

      assert.ok(
        secondSquareBeforeEdit,
        "Expected a second same-type Square editor",
      );
      // Request a same-mode edit by the real editor UID. This covers the
      // explicit editId path independently of a second on-screen double-click
      // (which would be ambiguous for overlapping creation-mode hitboxes).
      await viewer.evaluate((editId) => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          mode: 5,
          editId,
          mustEnterInEditMode: true,
        });
      }, secondSquareBeforeEdit.uid);
      await viewer.waitForFunction(
        (uid) => {
          const layer = document.querySelector(
            '.page[data-page-number="1"] .annotationEditorLayer',
          );
          const explicit = layer.querySelectorAll(".explicitlyEditing");
          if (explicit.length !== 1) return false;
          const storage = PDFViewerApplication.pdfDocument.annotationStorage;
          return storage.getRawValue(explicit[0].id)?.uid === uid;
        },
        { timeout: 8_000 },
        secondSquareBeforeEdit.uid,
      );
      const explicitSecond = await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        const storage = PDFViewerApplication.pdfDocument.annotationStorage;
        return {
          explicitCount: layer.querySelectorAll(".explicitlyEditing").length,
          explicitUids: [...layer.querySelectorAll(".explicitlyEditing")].map(
            (element) => storage.getRawValue(element.id)?.uid,
          ),
        };
      });
      assert.deepEqual(explicitSecond.explicitUids, [
        secondSquareBeforeEdit.uid,
      ]);
      results.push({
        scenario: "none-doubleclick-explicit-edit-and-move",
        explicitFirst,
        movedFirst,
        explicitSecond,
      });
      await persistProgress();

      await page.screenshot({
        path: path.join(artifacts, `annotation-interaction-${captureId}.png`),
        fullPage: false,
      });
      const diagnostics = {
        fixture: "tests/fixtures/tracemonkey.pdf (read-only public fixture)",
        payloadId: payload.id,
        contentHash: payload.contentHash,
        browserPath,
        scenarios: results,
        apiRequestCount,
        externalRequests,
        errors,
      };
      await writeFile(
        path.join(artifacts, `annotation-interaction-${captureId}.json`),
        JSON.stringify(diagnostics, null, 2),
        "utf8",
      );
      assert.equal(apiRequestCount, 0);
      assert.deepEqual(externalRequests, []);
      assert.deepEqual(errors, []);
      console.log(
        `Real-pointer annotation interaction checks captured in tests/artifacts/annotation-interaction-${captureId}.{json,png}`,
      );
    } finally {
      await browser?.close();
      await new Promise((resolve) => server.close(resolve));
      await removeTempRoot(temp);
    }
  },
);
