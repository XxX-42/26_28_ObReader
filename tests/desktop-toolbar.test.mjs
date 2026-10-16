import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { test } from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";

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
    <iframe id="pdf-reader" name="pdf-reader"
      style="display:block;width:100vw;height:900px;border:0"></iframe>
    ${browserSidecarHarnessScript({ channel: "pdf-web-reader", token: "desktop-toolbar-test" })}
    <script>
      const channel = "pdf-web-reader";
      const token = "desktop-toolbar-test";
      const frame = document.getElementById("pdf-reader");
      const locale = new URL(location.href).searchParams.get("locale") || "en-US";
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
      // PDF.js reads its optional locale override from the viewer hash.
      frame.src = "/viewer/viewer.html#locale=" + encodeURIComponent(locale);
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
    const scaleSelect = document.getElementById("scaleSelect");
    const toolbarGroupWidth = (element) => {
      if (!element) return 0;
      return Math.max(element.scrollWidth, element.getBoundingClientRect().width);
    };
    const singleRowRequiredWidth = [
      document.getElementById("toolbarViewerLeft"),
      document.getElementById("toolbarViewerMiddle"),
      document.getElementById("editorModeButtons"),
      document.querySelector(".pdfReaderBridgeControls"),
      document.getElementById("secondaryToolbarToggle"),
    ].reduce((sum, element) => sum + toolbarGroupWidth(element), 0) + 20;
    const coreToolIds = [
      "editorUnderlineButton",
      "editorSquareButton",
      "editorHighlightButton",
      "editorInkButton",
      "editorFreeTextButton",
    ];
    const zoomPresetIds = [
      "pageAutoOption",
      "pageActualOption",
      "pageFitOption",
      "pageWidthOption",
    ];
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
      twoRows: document.documentElement.classList.contains("pdfReaderBridgeTwoRow"),
      singleRowRequiredWidth,
      pageNumber: {
        rect: rect("pageNumber"),
        width: document.getElementById("pageNumber")?.style.width || null,
        min: document.getElementById("pageNumber")?.min || null,
        max: document.getElementById("pageNumber")?.max || null,
        value: document.getElementById("pageNumber")?.value || null,
        pagesLabel: document.getElementById("numPages")?.textContent?.trim() || null,
      },
      zoom: {
        language: window.PDFViewerApplication?.l10n?.getLanguage?.() || null,
        container: rect("scaleSelectContainer"),
        select: rect("scaleSelect"),
        selectPaddingInlineEnd: scaleSelect
          ? getComputedStyle(scaleSelect).paddingInlineEnd
          : null,
        presets: zoomPresetIds.map((id) => {
          const option = document.getElementById(id);
          return option && {
            id,
            value: option.value,
            label: option.textContent,
            title: option.title,
            ariaLabel: option.getAttribute("aria-label"),
            l10nId: option.getAttribute("data-l10n-id"),
            l10nArgs: option.getAttribute("data-l10n-args"),
          };
        }),
        retainedValues: scaleSelect ? [...scaleSelect.options].map((option) => ({
          value: option.value,
          disabled: option.disabled,
          hidden: option.hidden,
        })) : [],
      },
      nativeCoreTools: coreToolIds.filter((id) =>
        document.getElementById(id)?.getClientRects().length > 0,
      ),
      bridgeControlLabels: [...document.querySelectorAll(
        ".pdfReaderBridgeControls .pdfReaderBridgeControlButton",
      )].map((button) => button.textContent.trim()),
      historyOrder: (() => {
        const nativeTools = document.getElementById("editorModeButtons");
        const history = document.querySelector(".pdfReaderBridgeControls");
        const more = document.getElementById("secondaryToolbarToggle");
        return {
          afterNativeTools: !!nativeTools && !!history &&
            Boolean(nativeTools.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING),
          beforeMore: !!history && !!more &&
            Boolean(history.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      })(),
      bridgeHistory: [...document.querySelectorAll(
        ".pdfReaderBridgeControls .pdfReaderBridgeHistoryButton",
      )].map((button) => {
        const box = button.getBoundingClientRect();
        const glyph = button.querySelector(".pdfReaderBridgeHistoryGlyph");
        return {
          id: button.id,
          action: button.dataset.action,
          label: button.textContent.trim(),
          title: button.title,
          ariaLabel: button.getAttribute("aria-label"),
          width: box.width,
          height: box.height,
          disabled: button.disabled,
          iconDisplay: getComputedStyle(button, "::before").display,
          iconWidth: getComputedStyle(button, "::before").width,
          iconHeight: getComputedStyle(button, "::before").height,
          iconMask: getComputedStyle(button, "::before").maskImage,
          iconMaskSize: getComputedStyle(button, "::before").maskSize,
          iconMaskPosition: getComputedStyle(button, "::before").maskPosition,
          iconColor: getComputedStyle(button, "::before").backgroundColor,
          hiddenGlyphWidth: glyph ? getComputedStyle(glyph).width : null,
          hiddenGlyphHeight: glyph ? getComputedStyle(glyph).height : null,
          nativeIconColor: getComputedStyle(
            document.getElementById("editorInkButton"),
            "::before",
          ).backgroundColor,
        };
      }),
      bridgeDelete: (() => {
        const button = document.getElementById("pdfReaderBridgeDeleteButton");
        return button && {
          action: button.dataset.action,
          title: button.title,
          ariaLabel: button.getAttribute("aria-label"),
          inSecondaryMenu: button.parentElement?.id === "secondaryToolbarButtonContainer",
          beforeSave: !!button.nextElementSibling && button.nextElementSibling.id === "secondaryDownload",
        };
      })(),
      saveControl: (() => {
        const button = document.getElementById("secondaryDownload");
        return button && {
          title: button.title,
          ariaLabel: button.getAttribute("aria-label"),
          label: button.querySelector("span")?.textContent?.trim() || "",
          count: document.querySelectorAll("#secondaryDownload").length,
          bridgeSaveActions: document.querySelectorAll(
            ".pdfReaderBridgeControls [data-action='save'], #pdfReaderBridgeSaveButton",
          ).length,
        };
      })(),
      hiddenToolbarDom: [
        "editorStamp",
        "printButton",
        "secondaryPrint",
        "overwriteOriginalButton",
        "secondaryOverwriteOriginal",
        "editorModeSeparator",
      ].map((id) => {
        const element = document.getElementById(id);
        return {
          id,
          connected: !!element?.isConnected,
          hidden: !!element?.hidden,
          rectCount: element?.getClientRects().length || 0,
          parentHidden: !!element?.parentElement?.hidden,
        };
      }),
      hiddenRightSeparators: [...document.querySelectorAll(
        "#toolbarViewerRight > .verticalToolbarSeparator",
      )].map((element) => ({ hidden: element.hidden, rectCount: element.getClientRects().length })),
      floatingEditMenuPresent: !!document.querySelector(".pdfReaderBridgeActionMenu"),
      bridgeClickWheelPresent: !!document.querySelector(".pdfReaderBridgeClickWheel"),
      visibleEditorTools: [
        "editorUnderlineButton",
        "editorSquareButton",
        "editorHighlightButton",
        "editorInkButton",
        "editorFreeTextButton",
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

function assertZoomPresets(layout, languagePrefix) {
  const expected = [
    ["auto", "auto", "自动适配页面"],
    ["page-actual", "1:1", "按原始大小显示（100%）"],
    ["page-fit", "↕", "适合整页"],
    ["page-width", "↔", "适合页面宽度"],
  ];
  assert.ok(
    layout.zoom.language?.toLowerCase().startsWith(languagePrefix),
    `Expected ${languagePrefix} PDF.js localization, got ${layout.zoom.language}`,
  );
  assert.equal(layout.zoom.container.width, 64);
  assert.equal(layout.zoom.select.width, 64);
  assert.equal(layout.zoom.selectPaddingInlineEnd, "16px");
  assert.deepEqual(
    layout.zoom.presets.map((option) => [option.value, option.label, option.title]),
    expected,
  );
  assert.ok(layout.zoom.presets.every((option, index) =>
    option.ariaLabel === expected[index][2] &&
    option.l10nId === null && option.l10nArgs === null,
  ), "Preset tooltips and accessible names must be stable and independent of PDF.js localization");
  const retainedOptions = new Map(layout.zoom.retainedValues.map((option) => [option.value, option]));
  assert.deepEqual(
    ["custom", "0.5", "0.75", "1", "1.25", "1.5", "2", "3", "4"]
      .filter((value) => retainedOptions.has(value)),
    ["custom", "0.5", "0.75", "1", "1.25", "1.5", "2", "3", "4"],
    "The custom and percentage zoom choices must remain available",
  );
  assert.equal(retainedOptions.get("custom").disabled, true);
  assert.equal(retainedOptions.get("custom").hidden, true);
  assert.deepEqual(layout.nativeCoreTools, [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
  ]);
  assert.deepEqual(layout.bridgeControlLabels, ["↶", "↷"]);
  assert.deepEqual(layout.historyOrder, { afterNativeTools: true, beforeMore: true });
  assert.deepEqual(layout.bridgeHistory.map((button) => [
    button.id,
    button.action,
    button.label,
    button.title,
    button.ariaLabel,
    button.width,
    button.height,
    button.iconDisplay,
    button.iconWidth,
    button.iconHeight,
    button.iconMask.includes("data:image/svg+xml"),
    button.iconMaskSize,
    button.iconMaskPosition,
    button.iconColor === button.nativeIconColor,
    button.hiddenGlyphWidth,
    button.hiddenGlyphHeight,
  ]), [
    ["pdfReaderBridgeUndoButton", "undo", "↶", "撤销", "撤销", 32, 28, "block", "16px", "16px", true, "cover", "50% 50%", true, "0px", "0px"],
    ["pdfReaderBridgeRedoButton", "redo", "↷", "重做", "重做", 32, 28, "block", "16px", "16px", true, "cover", "50% 50%", true, "0px", "0px"],
  ]);
  assert.equal(layout.bridgeDelete.action, "delete");
  assert.equal(layout.bridgeDelete.title, "删除所选批注");
  assert.equal(layout.bridgeDelete.ariaLabel, "删除所选批注");
  assert.equal(layout.bridgeDelete.inSecondaryMenu, true);
  assert.equal(layout.bridgeDelete.beforeSave, true);
  assert.deepEqual(layout.saveControl, {
    title: "保存批注到外置记录",
    ariaLabel: "保存批注到外置记录",
    label: "保存批注",
    count: 1,
    bridgeSaveActions: 0,
  });
  assert.equal(layout.floatingEditMenuPresent, false);
  assert.ok(layout.hiddenToolbarDom.every((item) =>
    item.connected && item.hidden && item.rectCount === 0,
  ), `Unused toolbar DOM stays connected and hidden: ${JSON.stringify(layout.hiddenToolbarDom)}`);
  assert.ok(layout.hiddenRightSeparators.every((item) => item.hidden && item.rectCount === 0));
  assert.equal(layout.bridgeClickWheelPresent, false);
}

test(
  "narrow Obsidian panes keep PDF tools, popups, and the secondary menu inside the viewport",
  {
    timeout: 150_000,
    skip: browserPath ? false : "Chrome or Edge is required for DOM geometry checks",
  },
  async (t) => {
    const vendorViewerHtml = viewerHtml(
      await readFile(path.join(vendorWeb, "viewer.html"), "utf8"),
    );
    let browser;
    let page;
    let server;
    let primaryError;
    let cleanupReport;
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
      browser = await launchTestBrowser(puppeteer, {
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }, { testName: "desktop-toolbar" });
      page = await browser.newPage();
      await page.setViewport({ width: 900, height: 900, deviceScaleFactor: 1 });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserDiagnostics.push(message.text());
      });
      page.on("requestfailed", (request) => {
        browserDiagnostics.push(`${request.url()}: ${request.failure()?.errorText}`);
      });
      await page.goto(`${baseUrl}/?locale=en-US`, { waitUntil: "domcontentloaded" });
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
      assertZoomPresets(wide, "en");
      assert.equal(wide.pageNumber.width, "36px");
      assert.equal(wide.pageNumber.rect.width, 36);
      assert.equal(wide.pageNumber.min, "1");
      assert.equal(wide.pageNumber.value, "1");
      assert.equal(
        Number(wide.pageNumber.max),
        await viewer.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages),
        "The page input maximum continues to track the loaded document",
      );
      const expectedVisibleTools = wide.visibleEditorTools;
      assert.ok(expectedVisibleTools.includes("editorUnderlineButton"));
      assert.ok(expectedVisibleTools.includes("editorSquareButton"));

      await viewer.evaluate(async () => {
        await PDFViewerApplication.l10n.translate(document.documentElement);
      });
      assertZoomPresets(await measureToolbar(viewer), "en");

      await page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.id = "zoom-l10n-zh-probe";
        frame.name = "zoom-l10n-zh-probe";
        frame.title = "PDF zoom localization probe";
        frame.style.cssText = "position:absolute;left:-10000px;top:0;width:900px;height:900px;border:0";
        frame.src = "/viewer/viewer.html#locale=zh-CN";
        document.body.append(frame);
      });
      await page.waitForFunction(() => {
        const app = document.getElementById("zoom-l10n-zh-probe")
          ?.contentWindow?.PDFViewerApplication;
        return app?.initialized && app.l10n?.getLanguage?.().toLowerCase() === "zh-cn";
      }, { timeout: 30_000 });
      const chineseViewer = page.frames().find((frame) =>
        frame.name() === "zoom-l10n-zh-probe",
      );
      assert.ok(chineseViewer, "Expected the zh-CN localization probe viewer");
      await chineseViewer.evaluate(async () => {
        await PDFViewerApplication.l10n.translate(document.documentElement);
      });
      assertZoomPresets(await measureToolbar(chineseViewer), "zh-cn");
      await page.evaluate(() => {
        document.getElementById("zoom-l10n-zh-probe").style.width = "780px";
      });
      await chineseViewer.waitForFunction(() => {
        const toolbarViewer = document.getElementById("toolbarViewer");
        const groups = [
          document.getElementById("toolbarViewerLeft"),
          document.getElementById("toolbarViewerMiddle"),
          document.getElementById("editorModeButtons"),
          document.querySelector(".pdfReaderBridgeControls"),
          document.getElementById("secondaryToolbarToggle"),
        ];
        const required = groups.reduce((sum, element) =>
          sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width),
        20);
        return window.innerWidth === 780 &&
          !document.documentElement.classList.contains("pdfReaderBridgeTwoRow") &&
          required <= toolbarViewer.clientWidth + 1;
      });
      const narrowChinese = await measureToolbar(chineseViewer);
      assert.equal(narrowChinese.toolbarHeight, 32);
      assert.equal(narrowChinese.twoRows, false,
        "CJK localization keeps the measured 780px toolbar in one row");
      assert.ok(narrowChinese.toolbarScrollWidth <= narrowChinese.toolbarClientWidth + 1);

      await page.setViewport({ width: 881, height: 900, deviceScaleFactor: 1 });
      const breakpointWide = await measureToolbar(viewer);
      assert.equal(breakpointWide.toolbarHeight, 32);
      assert.notEqual(breakpointWide.toolbarDisplay, "grid");
      assertRectInside(breakpointWide.right, 881, "toolbar right group at 881px");
      assert.equal(breakpointWide.twoRows, false);

      for (const width of [880, 800, 780, 720, 691, 640, 432, 320]) {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        await viewer.waitForFunction(() => {
          const viewer = document.getElementById("viewerContainer").getBoundingClientRect();
          const toolbar = document.getElementById("toolbarContainer").getBoundingClientRect();
          const groups = [
            document.getElementById("toolbarViewerLeft"),
            document.getElementById("toolbarViewerMiddle"),
            document.getElementById("editorModeButtons"),
            document.querySelector(".pdfReaderBridgeControls"),
            document.getElementById("secondaryToolbarToggle"),
          ];
          const required = groups.reduce((sum, element) => {
            return sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width);
          }, 20);
          return viewer.top >= toolbar.bottom - 0.5 &&
            document.documentElement.classList.contains("pdfReaderBridgeTwoRow") ===
              (required > document.getElementById("toolbarViewer").clientWidth + 1);
        });
        const layout = await measureToolbar(viewer);
        const expectedTwoRows = layout.singleRowRequiredWidth > layout.toolbarClientWidth + 1;
        assert.equal(layout.twoRows, expectedTwoRows,
          `row mode should follow measured control widths at ${width}px`);
        if (width === 780) {
          assert.equal(expectedTwoRows, false,
            "The measured controls fit in one row at the iPad screenshot width");
        }
        if ([780, 720, 640, 432, 320].includes(width)) {
          t.diagnostic(JSON.stringify({
            viewportWidth: width,
            toolbarHeight: layout.toolbarHeight,
            twoRows: layout.twoRows,
            requiredSingleRowWidth: layout.singleRowRequiredWidth,
            availableSingleRowWidth: layout.toolbarClientWidth,
          }));
        }
        assert.equal(layout.toolbarHeight, expectedTwoRows ? 64 : 32,
          `toolbar height at ${width}px`);
        assert.equal(layout.toolbarDisplay === "grid", expectedTwoRows,
          `toolbar display at ${width}px`);
        assertRectInside(layout.left, width, `left group at ${width}px`);
        assertRectInside(layout.middle, width, `middle group at ${width}px`);
        assertRectInside(layout.right, width, `right group at ${width}px`);
        assertRectInside(layout.editors, width, `editor tools at ${width}px`);
        assertRectInside(layout.secondaryToggle, width, `secondary toggle at ${width}px`);
        if (expectedTwoRows) {
          assert.equal(layout.left.y, layout.middle.y,
            `left and middle groups share the first row at ${width}px`);
          assert.ok(layout.right.y > layout.left.y,
            `right group occupies the second row at ${width}px`);
          assert.ok(layout.right.bottom <= layout.toolbar.bottom + 0.5,
            `second row stays in the toolbar at ${width}px`);
        } else {
          assert.equal(layout.left.y, layout.middle.y,
            `left and middle groups share the one row at ${width}px`);
          assert.equal(layout.right.y, layout.left.y,
            `right group shares the one row at ${width}px`);
          assert.equal(layout.toolbarHeight, 32,
            `a fitting toolbar stays one row at ${width}px`);
        }
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

      // Grow back after the narrowest pane to prove the measured layout
      // returns to one row without a ResizeObserver feedback oscillation.
      await page.setViewport({ width: 780, height: 900, deviceScaleFactor: 1 });
      await viewer.waitForFunction(() =>
        !document.documentElement.classList.contains("pdfReaderBridgeTwoRow") &&
        document.getElementById("toolbarViewer").clientWidth >= 778,
      );
      const grownModes = await viewer.evaluate(async () => {
        const modes = [];
        for (let index = 0; index < 6; index += 1) {
          await new Promise(requestAnimationFrame);
          modes.push(document.documentElement.classList.contains("pdfReaderBridgeTwoRow"));
        }
        return modes;
      });
      assert.deepEqual(grownModes, Array(6).fill(false),
        "The 780px toolbar remains stably one row after shrinking and growing");

      // Exercise the exact one-pixel fit boundary in both directions. The
      // two-row class must not change intrinsic group widths, or ResizeObserver
      // can alternate between rows after crossing this threshold.
      await page.setViewport({ width: 640, height: 900, deviceScaleFactor: 1 });
      await viewer.waitForFunction(() =>
        !document.documentElement.classList.contains("pdfReaderBridgeTwoRow") &&
        !(
          [
            document.getElementById("toolbarViewerLeft"),
            document.getElementById("toolbarViewerMiddle"),
            document.getElementById("editorModeButtons"),
            document.querySelector(".pdfReaderBridgeControls"),
            document.getElementById("secondaryToolbarToggle"),
          ].reduce((sum, element) =>
            sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width), 20,
          ) > document.getElementById("toolbarViewer").clientWidth + 1
        ),
      );
      const fitBoundaryWidth = await viewer.evaluate(() => {
        const toolbarViewer = document.getElementById("toolbarViewer");
        const groups = [
          document.getElementById("toolbarViewerLeft"),
          document.getElementById("toolbarViewerMiddle"),
          document.getElementById("editorModeButtons"),
          document.querySelector(".pdfReaderBridgeControls"),
          document.getElementById("secondaryToolbarToggle"),
        ];
        const required = groups.reduce((sum, element) =>
          sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width), 20,
        );
        const viewportInset = window.innerWidth - toolbarViewer.clientWidth;
        // The bridge wraps when required > clientWidth + 1.
        return Math.ceil(required + viewportInset - 1);
      });

      const sampleBoundaryMode = async (width, expectedTwoRows) => {
        await page.setViewport({ width, height: 900, deviceScaleFactor: 1 });
        await viewer.waitForFunction((expected) => {
          const groups = [
            document.getElementById("toolbarViewerLeft"),
            document.getElementById("toolbarViewerMiddle"),
            document.getElementById("editorModeButtons"),
            document.querySelector(".pdfReaderBridgeControls"),
            document.getElementById("secondaryToolbarToggle"),
          ];
          const required = groups.reduce((sum, element) =>
            sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width), 20,
          );
          const needsTwoRows = required >
            document.getElementById("toolbarViewer").clientWidth + 1;
          return needsTwoRows === expected &&
            document.documentElement.classList.contains("pdfReaderBridgeTwoRow") === expected;
        }, { timeout: 5_000 }, expectedTwoRows);
        return viewer.evaluate(async () => {
          const read = () => {
            const groups = [
              document.getElementById("toolbarViewerLeft"),
              document.getElementById("toolbarViewerMiddle"),
              document.getElementById("editorModeButtons"),
              document.querySelector(".pdfReaderBridgeControls"),
              document.getElementById("secondaryToolbarToggle"),
            ];
            return {
              twoRows: document.documentElement.classList.contains("pdfReaderBridgeTwoRow"),
              required: groups.reduce((sum, element) =>
                sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width), 20,
              ),
              available: document.getElementById("toolbarViewer").clientWidth + 1,
            };
          };
          const samples = [];
          for (let index = 0; index < 8; index += 1) {
            await new Promise(requestAnimationFrame);
            samples.push(read());
          }
          return samples;
        });
      };

      const exactFitSamples = await sampleBoundaryMode(fitBoundaryWidth, false);
      const onePixelTooNarrowSamples = await sampleBoundaryMode(fitBoundaryWidth - 1, true);
      const grownBoundarySamples = await sampleBoundaryMode(fitBoundaryWidth, false);
      for (const [label, samples, expected] of [
        ["exact-fit", exactFitSamples, false],
        ["one-pixel-narrow", onePixelTooNarrowSamples, true],
        ["grow-back", grownBoundarySamples, false],
      ]) {
        assert.deepEqual(samples.map((sample) => sample.twoRows), Array(8).fill(expected),
          `${label} row mode stays stable across animation frames`);
      }
      const measuredWidths = [
        exactFitSamples[0].required,
        onePixelTooNarrowSamples[0].required,
        grownBoundarySamples[0].required,
      ];
      assert.ok(Math.max(...measuredWidths) - Math.min(...measuredWidths) <= 0.5,
        `Row mode does not change the measured intrinsic width: ${JSON.stringify({ fitBoundaryWidth, measuredWidths })}`);
      t.diagnostic(JSON.stringify({
        fitBoundaryWidth,
        exactFit: exactFitSamples[0],
        onePixelNarrow: onePixelTooNarrowSamples[0],
        growBack: grownBoundarySamples[0],
      }));

      await page.setViewport({ width: 780, height: 900, deviceScaleFactor: 1 });
      await viewer.waitForFunction(() =>
        !document.documentElement.classList.contains("pdfReaderBridgeTwoRow"),
      );
      const editableLayout = await measureToolbar(viewer);
      assert.equal(editableLayout.toolbarHeight, 32);
      assert.equal(editableLayout.twoRows, false);
      const widePageCount = await viewer.evaluate(async () => {
        const app = window.PDFViewerApplication;
        const input = document.getElementById("pageNumber");
        const requiredWidth = () => [
          document.getElementById("toolbarViewerLeft"),
          document.getElementById("toolbarViewerMiddle"),
          document.getElementById("editorModeButtons"),
          document.querySelector(".pdfReaderBridgeControls"),
          document.getElementById("secondaryToolbarToggle"),
        ].reduce((sum, element) =>
          sum + Math.max(element.scrollWidth, element.getBoundingClientRect().width), 20,
        );
        const original = {
          min: input.min,
          max: input.max,
          value: input.value,
        };
        const originalRequiredWidth = requiredWidth();
        app.eventBus.dispatch("pagesloaded", {
          source: app.pdfViewer,
          pagesCount: 10_000,
        });
        const simulatedWidth = input.getBoundingClientRect().width;
        const simulatedInlineWidth = input.style.width;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        const simulatedRequiredWidth = requiredWidth();
        const simulatedTwoRows = document.documentElement.classList.contains(
          "pdfReaderBridgeTwoRow",
        );
        app.eventBus.dispatch("pagesloaded", {
          source: app.pdfViewer,
          pagesCount: app.pdfDocument.numPages,
        });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return {
          original,
          originalRequiredWidth,
          simulatedWidth,
          simulatedInlineWidth,
          simulatedRequiredWidth,
          simulatedTwoRows,
          restoredWidth: input.getBoundingClientRect().width,
          restoredInlineWidth: input.style.width,
          restoredRequiredWidth: requiredWidth(),
          restoredTwoRows: document.documentElement.classList.contains(
            "pdfReaderBridgeTwoRow",
          ),
          min: input.min,
          max: input.max,
          value: input.value,
          pageCount: app.pdfDocument.numPages,
        };
      });
      assert.equal(widePageCount.simulatedWidth, 44);
      assert.equal(widePageCount.simulatedInlineWidth, "44px");
      assert.ok(widePageCount.simulatedRequiredWidth > widePageCount.originalRequiredWidth,
        "The measured toolbar width responds when a five-digit page count needs more space");
      assert.equal(widePageCount.simulatedTwoRows, false,
        "The larger page input still fits within the one-row screenshot-width toolbar");
      assert.equal(widePageCount.restoredWidth, 36);
      assert.equal(widePageCount.restoredInlineWidth, "36px");
      assert.equal(widePageCount.restoredTwoRows, false);
      assert.equal(widePageCount.restoredRequiredWidth, widePageCount.originalRequiredWidth);
      assert.deepEqual(
        { min: widePageCount.min, max: widePageCount.max, value: widePageCount.value },
        widePageCount.original,
        "Changing the displayed page count width must preserve page navigation constraints and value",
      );
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
          middle: readOnlyLayout.middle,
          right: readOnlyLayout.right,
          editors: readOnlyLayout.editors,
          secondaryToggle: readOnlyLayout.secondaryToggle,
        },
        {
          middle: editableLayout.middle,
          right: editableLayout.right,
          editors: editableLayout.editors,
          secondaryToggle: editableLayout.secondaryToggle,
        },
        "read-only disables editing without changing the narrow-pane geometry",
      );
      assert.equal(readOnlyLayout.pageNumber.width, "36px");
      assert.equal(readOnlyLayout.pageNumber.rect.width, 36);
      assert.equal(
        editableLayout.left.x - readOnlyLayout.left.x,
        0,
        "Page number width resets on document switch without moving the left group origin",
      );
      assert.ok(readOnlyLayout.disabledEditorTools.includes("editorUnderlineButton"));
      assert.equal(
        await viewer.$eval("#editorUnderlineButton", (element) => getComputedStyle(element).cursor),
        "not-allowed",
      );
      assert.deepEqual(pageErrors, [], "The real vendor viewer should remain error-free");
    } catch (error) {
      primaryError = error;
    } finally {
      cleanupReport = await cleanupBrowserTestResources({
        browser,
        ownedPages: page ? [page] : [],
        server,
      });
      const directory = path.join(root, "tests", "artifacts");
      await mkdir(directory, { recursive: true });
      const artifact = path.join(directory, `desktop-toolbar-${Date.now()}-${process.pid}.cleanup.json`);
      await writeFile(artifact, JSON.stringify(cleanupReport, null, 2) + "\n", { flag: "wx" });
      t.diagnostic(`Cleanup report: ${artifact}`);
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) throw finalError;
  },
);
