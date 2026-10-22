import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber } from "pdf-lib";
import { cleanupBrowserTestResources } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";

const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const artifactRoot = resolveTestArtifactRoot(root);
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"], [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"], [".svg", "image/svg+xml"], [".wasm", "application/wasm"],
]);

function numberArray(context, values) {
  const result = PDFArray.withContext(context);
  for (const value of values) result.push(PDFNumber.of(value));
  return result;
}

function addTextHighlight(pdf, page, { id, color, x1, x2, top, bottom }) {
  const context = pdf.context;
  const annotation = PDFDict.withContext(context);
  annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
  annotation.set(PDFName.of("Subtype"), PDFName.of("Highlight"));
  annotation.set(PDFName.of("Rect"), numberArray(context, [x1, bottom, x2, top]));
  annotation.set(PDFName.of("QuadPoints"), numberArray(context, [x1, top, x2, top, x1, bottom, x2, bottom]));
  annotation.set(PDFName.of("C"), numberArray(context, color));
  annotation.set(PDFName.of("CA"), PDFNumber.of(0.5));
  annotation.set(PDFName.of("F"), PDFNumber.of(4));
  annotation.set(PDFName.of("NM"), PDFHexString.fromText(id));
  annotation.set(PDFName.of("P"), page.ref);
  page.node.addAnnot(context.register(annotation));
}

function addInkHighlight(pdf, page, { id, color, points, rect }) {
  const context = pdf.context;
  const annotation = PDFDict.withContext(context);
  const inkLists = PDFArray.withContext(context);
  inkLists.push(numberArray(context, points));
  const border = PDFDict.withContext(context);
  border.set(PDFName.of("W"), PDFNumber.of(4));
  annotation.set(PDFName.of("Type"), PDFName.of("Annot"));
  annotation.set(PDFName.of("Subtype"), PDFName.of("Ink"));
  annotation.set(PDFName.of("Rect"), numberArray(context, rect));
  annotation.set(PDFName.of("InkList"), inkLists);
  annotation.set(PDFName.of("C"), numberArray(context, color));
  annotation.set(PDFName.of("CA"), PDFNumber.of(0.5));
  annotation.set(PDFName.of("BS"), context.obj({ W: 4 }));
  annotation.set(PDFName.of("F"), PDFNumber.of(4));
  annotation.set(PDFName.of("NM"), PDFHexString.fromText(id));
  annotation.set(PDFName.of("P"), page.ref);
  page.node.addAnnot(context.register(annotation));
}

async function createCollisionFixture() {
  const source = await PDFDocument.load(await readFile(fixturePath));
  const page = source.getPages()[0];
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  const top = pageHeight - 90;
  // Red and blue occupy intersecting, adjacent visual rows. Green and yellow
  // overlap on the same line in an independent column and must stay unchanged.
  addTextHighlight(source, page, { id: "collision-red", color: [1, 0, 0], x1: 48, x2: 210, top, bottom: top - 14 });
  addTextHighlight(source, page, { id: "collision-blue", color: [0, 0, 1], x1: 68, x2: 232, top: top - 9, bottom: top - 23 });
  addTextHighlight(source, page, { id: "same-line-green", color: [0, 0.65, 0], x1: 330, x2: 455, top, bottom: top - 14 });
  addTextHighlight(source, page, { id: "same-line-yellow", color: [0.9, 0.7, 0], x1: 350, x2: 480, top: top - 2, bottom: top - 16 });
  addInkHighlight(source, page, {
    id: "freehand-ink-control",
    color: [0.3, 0.1, 0.8],
    points: [65, pageHeight - 135, 90, pageHeight - 130, 125, pageHeight - 138],
    rect: [62, pageHeight - 145, 130, pageHeight - 125],
  });
  return {
    bytes: Buffer.from(await source.save()),
    pageWidth,
    pageHeight,
    sourceBytes: (await readFile(fixturePath)).byteLength,
  };
}

test("PDF.js text Highlights avoid cross-annotation line collisions without changing canonical quads or Ink", {
  skip: !resolveBrowserPath() && "Chrome or Edge is required for the PDF.js drawing regression",
  timeout: 180_000,
}, async (t) => {
  await mkdir(artifactRoot, { recursive: true });
  const fixture = await createCollisionFixture();
  const sourceFixtureHash = createHash("sha256").update(fixture.bytes).digest("hex");
  const bridgeSource = await readBridgeRuntimeSource();
  const viewerHtmlPath = path.join(vendorRoot, "web", "viewer.html");
  const viewerHtml = await readFile(viewerHtmlPath, "utf8");
  const artifactPath = path.join(artifactRoot, `pdfjs-highlight-collision-${Date.now()}-${process.pid}.json`);
  const trace = {
    schemaVersion: 1,
    fixture: "in-memory copy of tracemonkey.pdf with four overlapping /Highlight quads and one /Ink control",
    sourceBytes: fixture.sourceBytes,
    collisionAnnotations: ["collision-red", "collision-blue"],
    unaffectedAnnotations: ["same-line-green", "same-line-yellow", "freehand-ink-control"],
    results: [],
    failure: null,
  };
  let browser;
  let server;
  let page;
  let primaryError = null;
  let cleanupReport = null;
  const persist = async (phase) => {
    trace.lastPersistedPhase = phase;
    await writeFile(artifactPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
    t.diagnostic(`PDF highlight collision evidence (${phase}): ${artifactPath}`);
  };

  try {
    await new Promise((resolve, reject) => {
      server = createServer(async (request, response) => {
        const pathname = new URL(request.url, "http://127.0.0.1").pathname;
        try {
          if (pathname === "/viewer/bridge-runtime.js") {
            response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
            response.end(bridgeSource);
            return;
          }
          if (pathname === "/collision.pdf") {
            response.writeHead(200, { "content-type": "application/pdf", "content-length": fixture.bytes.length });
            response.end(fixture.bytes);
            return;
          }
          if (!pathname.startsWith("/viewer/")) {
            response.writeHead(404).end("not found");
            return;
          }
          const target = path.resolve(vendorRoot, decodeURIComponent(pathname.slice("/viewer/".length)));
          const relative = path.relative(vendorRoot, target);
          if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
            response.writeHead(403).end("forbidden");
            return;
          }
          let data;
          if (pathname === "/viewer/web/viewer.html") {
            data = viewerHtml.replace(/<head\b[^>]*>/i, (head) =>
              `${head}<script src="/viewer/bridge-runtime.js"></script>`);
          } else {
            data = await readFile(target);
          }
          response.writeHead(200, {
            "content-type": mimeTypes.get(path.extname(target)) || "application/octet-stream",
            "x-content-type-options": "nosniff",
          });
          response.end(data);
        } catch (error) {
          response.writeHead(500).end(String(error?.message || error));
        }
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await launchTestBrowser(puppeteer, {
      executablePath: resolveBrowserPath(),
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "pdfjs-highlight-collision" });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on("pageerror", (error) => trace.results.push({ type: "pageerror", message: String(error.message).slice(0, 500) }));
    page.on("dialog", (dialog) => {
      trace.results.push({ phase: "browser-dialog", type: dialog.type() });
      if (dialog.type() === "beforeunload") {
        void dialog.accept();
      } else {
        void dialog.dismiss();
      }
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/viewer/web/viewer.html?file=%2Fcollision.pdf#page=1`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(() => Boolean(window.PDFViewerApplication?.pdfDocument), { timeout: 40_000 });
    await page.evaluate(() => {
      PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { mode: 9 });
    });
    await page.waitForFunction(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return [...manager.getEditors(0)].length === 5 &&
        [...manager.getEditors(0)].filter((editor) => editor.editorType === "highlight").length === 4;
    }, { timeout: 35_000 });
    await page.waitForFunction(() => document.querySelectorAll('.page[data-page-number="1"] .canvasWrapper svg.highlight:not(.free)').length === 4,
      { timeout: 15_000 });

    const inspect = () => page.evaluate(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const editors = [...manager.getEditors(0)].filter((editor) => editor.editorType === "highlight");
      const roots = [...document.querySelectorAll('.page[data-page-number="1"] .canvasWrapper svg.highlight:not(.free)')];
      const inkRoots = [...document.querySelectorAll('.page[data-page-number="1"] .canvasWrapper svg.draw')]
        .filter((root) => root.getAttribute("stroke") && root.getAttribute("stroke") !== "none");
      const rows = roots.map((root) => {
        const rect = root.getBoundingClientRect();
        return {
          color: (root.getAttribute("fill") || "").toLowerCase(),
          free: root.classList.contains("free"),
          left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height,
          path: root.querySelector("defs > path")?.getAttribute("d") || "",
        };
      });
      const originals = editors.map((editor) => ({
        id: editor._initialData?.id || null,
        color: editor.color.toLowerCase(),
        quads: Array.from(editor._initialData?.quadPoints || []),
        free: editor.div?.classList.contains("free") === true,
      }));
      return {
        pageWidth: PDFViewerApplication.pdfViewer.getPageView(0).viewport.width,
        pageHeight: PDFViewerApplication.pdfViewer.getPageView(0).viewport.height,
        editors: originals,
        roots: rows,
        inkPaths: inkRoots.map((root) => ({
          stroke: (root.getAttribute("stroke") || "").toLowerCase(),
          path: root.querySelector("defs > path")?.getAttribute("d") || "",
        })),
      };
    });

    const initial = await inspect();
    trace.results.push({ phase: "initial", ...initial });
    await persist("initial");
    assert.equal(initial.editors.length, 4, "four standard text Highlights should hydrate");
    assert.equal(initial.roots.length, 4, "every standard text Highlight should have one paint SVG");
    const red = initial.roots.find((row) => row.color === "#ff0000");
    const blue = initial.roots.find((row) => row.color === "#0000ff");
    const green = initial.roots.find((row) => row.color === "#00a600" || row.color === "#009f00" || row.color === "#00ff00");
    const yellow = initial.roots.find((row) => row.color === "#e6b300" || row.color === "#e5b200" || row.color === "#e6b200");
    assert.ok(red && blue, `Expected distinct red/blue text Highlight paint roots: ${JSON.stringify(initial.roots.map((row) => row.color))}`);
    assert.ok(green && yellow, `Expected same-line green/yellow controls: ${JSON.stringify(initial.roots.map((row) => row.color))}`);
    assert.equal(initial.inkPaths.length, 1, "the separate PDF Ink editor must remain outside text-highlight geometry");
    assert.ok(Math.abs(blue.top - red.bottom - 1) < 1.1,
      `Adjacent independently stored Highlight rows should have a one-CSS-pixel gap: red=${red.bottom}, blue=${blue.top}`);
    assert.ok(Math.abs(green.height - yellow.height) < 1.75 && green.height > 24 && yellow.height > 24,
      "same-line marks must keep their full paint height when another row is adjusted");
    assert.ok(Math.abs((yellow.top - green.top) - 3.33) < 1.25,
      "same-line marks must retain their distinct canonical centers");

    const canonicalQuads = await page.evaluate(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const editors = [...manager.getEditors(0)].filter((editor) => editor.editorType === "highlight" && !editor._initialData?.inkLists);
      return editors.map((editor) => {
        const initial = Array.from(editor._initialData.quadPoints);
        const originalColor = editor.color;
        editor.color = "#123456";
        const serialized = editor.serialize();
        editor.color = originalColor;
        if (!serialized?.quadPoints) throw new Error("A changed embedded Highlight did not serialize QuadPoints");
        return { id: editor._initialData.id, initial, serialized: Array.from(serialized.quadPoints) };
      });
    });
    for (const row of canonicalQuads) {
      assert.deepEqual(row.serialized, row.initial, `display-only collision adjustment changed serialized QuadPoints for ${row.id}`);
    }
    trace.results.push({ phase: "canonical-serialization", canonicalQuads });

    const exportedBase64 = await page.evaluate(async () => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const redEditor = [...manager.getEditors(0)].find((editor) => editor._initialData?.quadPoints?.[0] === 48);
      if (!redEditor) throw new Error("Expected the red standard Highlight editor for explicit export");
      redEditor.updateParams(31, "#123456");
      redEditor.commit();
      const bytes = await PDFViewerApplication.pdfDocument.saveDocument();
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      redEditor.color = "#ff0000";
      redEditor.onUpdatedColor();
      redEditor.commit();
      return btoa(binary);
    });
    const exportedPdf = await PDFDocument.load(Buffer.from(exportedBase64, "base64"));
    const exportedQuads = (exportedPdf.getPage(0).node.Annots()?.asArray() || [])
      .map((ref) => exportedPdf.context.lookup(ref, PDFDict))
      .filter((annotation) => annotation.get(PDFName.of("Subtype"))?.toString() === "/Highlight")
      .map((annotation) => annotation.get(PDFName.of("QuadPoints"))?.asArray().map((number) => number.asNumber()))
      .filter(Boolean);
    const expectedRedQuads = canonicalQuads.find((row) => row.id === "997R")?.initial;
    assert.ok(expectedRedQuads && exportedQuads.some((quads) =>
      quads.length === expectedRedQuads.length && quads.every((value, index) => value === expectedRedQuads[index])
    ), "explicit PDF export must preserve the original red Highlight QuadPoints");
    assert.equal(createHash("sha256").update(fixture.bytes).digest("hex"), sourceFixtureHash,
      "explicit export must produce separate bytes without mutating the served source fixture");
    trace.results.push({ phase: "explicit-export", exportedBytes: Buffer.from(exportedBase64, "base64").length, exportedQuads });

    const originalDimensions = { width: initial.pageWidth, height: initial.pageHeight };
    await page.evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = "2.5"; });
    await page.waitForFunction((oldWidth) => PDFViewerApplication.pdfViewer.getPageView(0).viewport.width > oldWidth * 1.2,
      { timeout: 20_000 }, originalDimensions.width);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const zoomed = await inspect();
    trace.results.push({ phase: "zoom", ...zoomed });
    await persist("zoom");
    const zoomRed = zoomed.roots.find((row) => row.color === "#ff0000");
    const zoomBlue = zoomed.roots.find((row) => row.color === "#0000ff");
    assert.ok(zoomRed && zoomBlue && Math.abs(zoomBlue.top - zoomRed.bottom - 1) < 1.1,
      `zoom must recompute the display-only one-pixel gap: red=${zoomRed?.bottom}, blue=${zoomBlue?.top}`);
    assert.deepEqual(zoomed.editors.map((editor) => editor.quads), initial.editors.map((editor) => editor.quads),
      "zoom must only recompute paint geometry and preserve original QuadPoints");

    for (const rotation of [90, 180, 270, 0]) {
      await page.evaluate((angle) => { PDFViewerApplication.pdfViewer.pagesRotation = angle; }, rotation);
      await page.waitForFunction((angle) => PDFViewerApplication.pdfViewer.pagesRotation === angle,
        { timeout: 15_000 }, rotation);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const rotated = await inspect();
      trace.results.push({ phase: `rotation-${rotation}`, ...rotated });
      await persist(`rotation-${rotation}`);
      const rotatedRed = rotated.roots.find((row) => row.color === "#ff0000");
      const rotatedBlue = rotated.roots.find((row) => row.color === "#0000ff");
      const gap = rotation === 90 ? rotatedRed?.left - rotatedBlue?.right
        : rotation === 180 ? rotatedRed?.top - rotatedBlue?.bottom
        : rotation === 270 ? rotatedBlue?.left - rotatedRed?.right
        : rotatedBlue?.top - rotatedRed?.bottom;
      assert.ok(Number.isFinite(gap) && Math.abs(gap - 1) < 1.1,
        `rotation ${rotation} must recompute the display-only one-pixel gap: ${gap}`);
      assert.deepEqual(rotated.editors.map((editor) => editor.quads), initial.editors.map((editor) => editor.quads),
        `rotation ${rotation} must retain original QuadPoints`);
      assert.deepEqual(rotated.inkPaths, initial.inkPaths, "the separate PDF Ink path must not be rewritten by text-highlight layout");
    }

    await page.evaluate(() => { PDFViewerApplication.pdfViewer.currentScaleValue = "page-fit"; });
    await page.waitForFunction((oldWidth) => PDFViewerApplication.pdfViewer.getPageView(0).viewport.width < oldWidth * 1.3,
      { timeout: 20_000 }, zoomed.pageWidth);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      const redEditor = [...manager.getEditors(0)].find((editor) => !editor.div?.classList.contains("free") && editor.color.toLowerCase() === "#ff0000");
      if (!redEditor) throw new Error("Expected the test red Highlight editor");
      redEditor.remove();
    });
    await page.waitForFunction(() => document.querySelectorAll('.page[data-page-number="1"] .canvasWrapper svg.highlight:not(.free)').length === 3,
      { timeout: 15_000 });
    const afterDelete = await inspect();
    trace.results.push({ phase: "delete", ...afterDelete });
    await persist("delete");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.PDFViewerApplication?.pdfDocument), { timeout: 40_000 });
    await page.evaluate(() => PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", { mode: 9 }));
    await page.waitForFunction(() => {
      const manager = PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager;
      return [...manager.getEditors(0)].length === 5 &&
        [...manager.getEditors(0)].filter((editor) => editor.editorType === "highlight").length === 4 &&
        document.querySelectorAll('.page[data-page-number="1"] .canvasWrapper svg.highlight:not(.free)').length === 4;
    }, { timeout: 35_000 });
    const reopened = await inspect();
    trace.results.push({ phase: "reopen", ...reopened });
    assert.deepEqual(reopened.editors.map((editor) => editor.quads), initial.editors.map((editor) => editor.quads),
      "closing/reopening must restore the original embedded annotation coordinates");
    await persist("complete");
  } catch (error) {
    primaryError = error;
    trace.failure = { name: error?.name || "Error", message: String(error?.message || error).slice(0, 2_000) };
    if (page && !page.isClosed()) {
      trace.failureViewer = await page.evaluate(() => ({
        url: location.href,
        app: Boolean(window.PDFViewerApplication?.pdfDocument),
        pages: window.PDFViewerApplication?.pdfViewer?.pagesCount || null,
        mode: window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
        editors: window.PDFViewerApplication?.pdfViewer?._layerProperties?.annotationEditorUIManager
          ? [...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].map((editor) => ({
            type: editor.editorType, id: editor._initialData?.id || null, color: editor.color || null,
          })) : [],
        errors: window.PDFViewerApplication?.pdfDocument?.loadingTask?.onPassword ? "password callback installed" : null,
      })).catch((captureError) => ({ captureError: String(captureError?.message || captureError) }));
    }
    await persist("failure");
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
  }
  if (cleanupReport?.errors?.length) {
    if (!primaryError) primaryError = new Error(`Browser cleanup failed: ${JSON.stringify(cleanupReport.errors)}`);
    else primaryError.cleanupErrors = cleanupReport.errors;
  }
  if (primaryError) throw primaryError;
});
