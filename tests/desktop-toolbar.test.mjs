import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";

const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const vendorWeb = path.join(vendorRoot, "web");
const bridgeCssPath = path.join(root, "viewer-adapter", "bridge.css");
const bridgeJsPath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
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

function hostHtml() {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>PDF narrow toolbar test host</title>
    <iframe id="pdf-reader" name="pdf-reader" src="/viewer/viewer.html"
      style="display:block;width:100vw;height:900px;border:0"></iframe>
    <script>
      const channel = "pdf-web-reader";
      const token = "desktop-toolbar-test";
      const frame = document.getElementById("pdf-reader");
      let sequence = 0;
      let initialOpenSent = false;
      window.__openedDocuments = [];
      window.__bridgeErrors = [];
      window.__openPdf = async (readOnly) => {
        const data = await fetch("/fixtures/tracemonkey.pdf").then((response) => {
          if (!response.ok) throw new Error("Could not fetch PDF fixture");
          return response.arrayBuffer();
        });
        const documentId = "toolbar-doc-" + (++sequence);
        frame.contentWindow.postMessage({
          channel, token, type: "open", data, documentId,
          documentPath: "Tests/tracemonkey.pdf",
          filename: "tracemonkey.pdf", autoSave: true,
          readOnly: readOnly === true,
        }, "*", [data]);
        return documentId;
      };
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (!message || message.channel !== channel || message.token !== token) return;
        if (message.type === "ready" && !initialOpenSent) {
          initialOpenSent = true;
          void window.__openPdf(false);
        } else if (message.type === "opened") {
          window.__openedDocuments.push({
            documentId: message.documentId,
            documentPath: message.documentPath,
            filename: message.filename,
          });
        } else if (message.type === "error") {
          window.__bridgeErrors.push(message.message || "viewer error");
        }
      });
    </script>`;
}

function viewerHtml(source) {
  const bridgeAssets = `
    <link rel="stylesheet" href="/bridge.css" />
    <script src="/bridge.js" data-channel="pdf-web-reader" data-token="desktop-toolbar-test"></script>`;
  const viewerScript = '<script src="viewer.mjs" type="module"></script>';
  assert.ok(source.includes(viewerScript), "Vendor viewer script marker must exist");
  return source.replace(viewerScript, `${bridgeAssets}\n  ${viewerScript}`);
}

function getTarget(pathname) {
  if (pathname === "/fixtures/tracemonkey.pdf") return fixturePath;
  if (pathname === "/bridge.css") return bridgeCssPath;
  if (pathname === "/bridge.js") return bridgeJsPath;
  if (
    pathname.startsWith("/viewer/") ||
    pathname.startsWith("/build/") ||
    pathname.startsWith("/cmaps/") ||
    pathname.startsWith("/standard_fonts/") ||
    pathname.startsWith("/wasm/") ||
    pathname.startsWith("/images/") ||
    pathname.startsWith("/locale/")
  ) {
    const isBuildResource = pathname.startsWith("/build/");
    const resourceRoot = isBuildResource ? vendorRoot : vendorWeb;
    const relativePath = isBuildResource
      ? pathname.slice(1)
      : pathname.replace(/^\/viewer\//, "");
    const target = path.resolve(resourceRoot, relativePath);
    if (!target.startsWith(`${resourceRoot}${path.sep}`)) return null;
    return target;
  }
  return null;
}

async function measureToolbar(frame) {
  return frame.evaluate(() => {
    const rect = (id) => {
      const element = document.getElementById(id);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const toolbar = document.getElementById("toolbarContainer");
    const toolbarViewer = document.getElementById("toolbarViewer");
    return {
      viewportWidth: window.innerWidth,
      toolbarHeight: Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--toolbar-height"),
      ),
      toolbar: rect("toolbarContainer"),
      viewer: rect("viewerContainer"),
      left: rect("toolbarViewerLeft"),
      middle: rect("toolbarViewerMiddle"),
      right: rect("toolbarViewerRight"),
      editors: rect("editorModeButtons"),
      secondaryToggle: rect("secondaryToolbarToggleButton"),
      toolbarDisplay: getComputedStyle(toolbarViewer).display,
      gridRows: getComputedStyle(toolbarViewer).gridTemplateRows,
      toolbarScrollWidth: toolbarViewer.scrollWidth,
      toolbarClientWidth: toolbarViewer.clientWidth,
      visibleEditorTools: [
        "editorUnderlineButton",
        "editorSquareButton",
        "editorHighlightButton",
        "editorInkButton",
        "editorFreeTextButton",
        "editorEraserButton",
        "editorStampButton",
      ].filter((id) => {
        const element = document.getElementById(id);
        return element && element.getClientRects().length > 0;
      }),
      disabledEditorTools: [
        "editorUnderlineButton",
        "editorSquareButton",
        "editorHighlightButton",
        "editorInkButton",
        "editorFreeTextButton",
        "editorEraserButton",
        "editorStampButton",
      ].filter((id) => document.getElementById(id)?.disabled),
      rootOverflow: document.documentElement.scrollWidth,
    };
  });
}

function assertRectInside(rect, width, label) {
  assert.ok(rect, `${label} should exist`);
  assert.ok(rect.x >= -0.5, `${label} should not extend past the left edge: ${JSON.stringify(rect)}`);
  assert.ok(rect.right <= width + 0.5, `${label} should not extend past the right edge: ${JSON.stringify(rect)}`);
}

test(
  "narrow Obsidian panes keep PDF tools, popups, and the secondary menu inside the viewport",
  {
    timeout: 150_000,
    skip: browserPath ? false : "Chrome or Edge is required for DOM geometry checks",
  },
  async () => {
    const vendorViewerHtml = viewerHtml(
      await readFile(path.join(vendorWeb, "viewer.html"), "utf8"),
    );
    let browser;
    let server;
    const pageErrors = [];
    const browserDiagnostics = [];
    const missingRequests = [];
    server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(hostHtml());
        return;
      }
      if (url.pathname === "/viewer/viewer.html") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(vendorViewerHtml);
        return;
      }
      const target = getTarget(url.pathname);
      if (!target) {
        missingRequests.push(url.pathname);
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
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 800, height: 900, deviceScaleFactor: 1 });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserDiagnostics.push(message.text());
      });
      page.on("requestfailed", (request) => {
        browserDiagnostics.push(`${request.url()}: ${request.failure()?.errorText}`);
      });
      await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
      const viewer = page.frames().find((frame) => frame.name() === "pdf-reader");
      assert.ok(viewer, "Expected the vendor PDF.js viewer frame");
      try {
        await viewer.waitForFunction(
          () =>
            !!window.PDFViewerApplication?.pdfDocument &&
            !!document.querySelector('.page[data-page-number="1"] .textLayer span'),
          { timeout: 20_000 },
        );
      } catch (error) {
        const viewerState = await viewer.evaluate(() => ({
          ready: window.PDFViewerApplication?.initialized,
          hasDocument: !!window.PDFViewerApplication?.pdfDocument,
          pageCount: window.PDFViewerApplication?.pagesCount,
          pageExists: !!document.querySelector('.page[data-page-number="1"]'),
          textLayerExists: !!document.querySelector('.page[data-page-number="1"] .textLayer'),
          bridgeErrors: window.parent.__bridgeErrors,
        }));
        throw new Error(
          `${error.message}; viewer=${JSON.stringify(viewerState)}; missing=${missingRequests.join(",")}; console=${browserDiagnostics.join(" | ")}; page=${pageErrors.join(" | ")}`,
          { cause: error },
        );
      }
      await page.waitForFunction(
        () => window.__openedDocuments?.length === 1,
        { timeout: 45_000 },
      );
      await viewer.waitForFunction(
        () => !document.getElementById("editorUnderlineButton").disabled,
      );

      const wide = await measureToolbar(viewer);
      assert.equal(wide.toolbarHeight, 32);
      assert.notEqual(wide.toolbarDisplay, "grid", "Wide panes keep the original one-row toolbar");
      const expectedVisibleTools = wide.visibleEditorTools;
      assert.ok(expectedVisibleTools.includes("editorUnderlineButton"));
      assert.ok(expectedVisibleTools.includes("editorSquareButton"));

      await page.setViewport({ width: 721, height: 900, deviceScaleFactor: 1 });
      const breakpointWide = await measureToolbar(viewer);
      assert.equal(breakpointWide.toolbarHeight, 32);
      assert.notEqual(breakpointWide.toolbarDisplay, "grid");
      assertRectInside(breakpointWide.right, 721, "toolbar right group at 721px");

      for (const width of [720, 691, 432, 320]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        await viewer.waitForFunction(() => {
          const viewer = document.getElementById("viewerContainer").getBoundingClientRect();
          const toolbar = document.getElementById("toolbarContainer").getBoundingClientRect();
          return viewer.top >= toolbar.bottom - 0.5;
        });
        const layout = await measureToolbar(viewer);
        assert.equal(layout.toolbarHeight, 64, `toolbar height at ${width}px`);
        assert.equal(layout.toolbarDisplay, "grid", `toolbar should use two rows at ${width}px`);
        assertRectInside(layout.left, width, `left group at ${width}px`);
        assertRectInside(layout.middle, width, `middle group at ${width}px`);
        assertRectInside(layout.right, width, `right group at ${width}px`);
        assertRectInside(layout.editors, width, `editor tools at ${width}px`);
        assertRectInside(layout.secondaryToggle, width, `secondary toggle at ${width}px`);
        assert.equal(layout.left.y, layout.middle.y, `left and middle groups share the first row at ${width}px`);
        assert.ok(layout.right.y > layout.left.y, `right group occupies the second row at ${width}px`);
        assert.ok(layout.right.bottom <= layout.toolbar.bottom + 0.5, `second row stays in the toolbar at ${width}px`);
        assert.ok(
          layout.viewer.y >= layout.toolbar.bottom - 0.5,
          `viewer starts below the taller toolbar at ${width}px: ${JSON.stringify({ viewer: layout.viewer, toolbar: layout.toolbar, toolbarHeight: layout.toolbarHeight })}`,
        );
        assert.ok(layout.toolbarScrollWidth <= layout.toolbarClientWidth + 1, `toolbar contents do not overflow at ${width}px`);
        assert.ok(layout.visibleEditorTools.includes("editorUnderlineButton"));
        assert.ok(layout.visibleEditorTools.includes("editorSquareButton"));
        assert.deepEqual(
          layout.visibleEditorTools,
          expectedVisibleTools,
          `responsive layout preserves the available editing tools at ${width}px`,
        );

        for (const [buttonId, popupId] of [
          ["editorUnderlineButton", "editorUnderlineParamsToolbar"],
          ["editorSquareButton", "editorSquareParamsToolbar"],
        ]) {
          await viewer.click(`#${buttonId}`);
          await viewer.waitForFunction(
            (id) => !document.getElementById(id).classList.contains("hidden"),
            { timeout: 5_000 },
            popupId,
          );
          const popup = await viewer.$eval(`#${popupId}`, (element) => {
            const box = element.getBoundingClientRect();
            const point = document.elementFromPoint(box.left + 8, box.top + 8);
            return {
              x: box.x,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              visible: getComputedStyle(element).visibility === "visible",
              hitTested: point === element || element.contains(point),
            };
          });
          assert.ok(popup.visible, `${popupId} is visible at ${width}px`);
          assert.ok(popup.hitTested, `${popupId} is not clipped at ${width}px`);
          assertRectInside(popup, width, popupId);
          assert.ok(popup.top >= layout.toolbar.bottom - 0.5, `${popupId} opens below the toolbar at ${width}px`);
        }

        await viewer.evaluate(() => {
          document.getElementById("secondaryToolbarToggleButton").click();
        });
        await viewer.waitForFunction(
          () => !document.getElementById("secondaryToolbar").classList.contains("hidden"),
        );
        const secondaryMenu = await viewer.$eval("#secondaryToolbar", (element) => {
          const box = element.getBoundingClientRect();
          return { x: box.x, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
        });
        assertRectInside(secondaryMenu, width, `secondary menu at ${width}px`);
        assert.ok(secondaryMenu.top >= layout.toolbar.bottom - 0.5, `secondary menu opens below the toolbar at ${width}px`);
        await viewer.evaluate(() => {
          document.getElementById("secondaryToolbarToggleButton").click();
        });
      }

      await page.setViewport({ width: 432, height: 900, deviceScaleFactor: 1 });
      await viewer.evaluate(() => new Promise(requestAnimationFrame));
      const editableLayout = await measureToolbar(viewer);
      await page.evaluate(() => window.__openPdf(true));
      await page.waitForFunction(
        () => window.__openedDocuments?.length === 2,
        { timeout: 45_000 },
      );
      await viewer.waitForFunction(
        () =>
          document.documentElement.hasAttribute("data-pdf-reader-readonly") &&
          [...document.querySelectorAll(
            "#editorUnderlineButton,#editorSquareButton,#editorHighlightButton,#editorInkButton,#editorFreeTextButton,#editorEraserButton,#editorStampButton",
          )].every((button) => button.disabled),
        { timeout: 10_000 },
      );
      const readOnlyLayout = await measureToolbar(viewer);
      assert.deepEqual(
        {
          left: readOnlyLayout.left,
          middle: readOnlyLayout.middle,
          right: readOnlyLayout.right,
          editors: readOnlyLayout.editors,
          secondaryToggle: readOnlyLayout.secondaryToggle,
        },
        {
          left: editableLayout.left,
          middle: editableLayout.middle,
          right: editableLayout.right,
          editors: editableLayout.editors,
          secondaryToggle: editableLayout.secondaryToggle,
        },
        "read-only disables editing without changing the narrow-pane geometry",
      );
      assert.ok(readOnlyLayout.disabledEditorTools.includes("editorUnderlineButton"));
      assert.equal(
        await viewer.$eval("#editorUnderlineButton", (element) => getComputedStyle(element).cursor),
        "not-allowed",
      );
      assert.deepEqual(pageErrors, [], "The real vendor viewer should remain error-free");
    } finally {
      await browser?.close();
      if (server?.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  },
);
