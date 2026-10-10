import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { MACOS_TEST_VAULT, nativeConfig } from "./native-config.mjs";
import { nativeVirtualKeyCode } from "./native-keycodes.mjs";
import {
  fixturesForNativeCases,
  NATIVE_LIFECYCLE_CASES,
  selectNativeCases,
} from "./native-case-selection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifactsDirectory = path.join(root, "tests", "artifacts");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const testPrefix = `PDF迁移测试/native-macos-lifecycle-${stamp}`;
const pluginId = "pdf-web-reader";
const viewType = "pdf-web-reader-view";
const appUrl = "app://obsidian.md/index.html";
const expectedIdentity = {
  vault: MACOS_TEST_VAULT,
  configDir: ".obsidian",
};
const reportPath = path.join(
  artifactsDirectory,
  `native-macos-lifecycle-${stamp}.json`,
);
const reportTempPath = `${reportPath}.tmp`;
const screenshotPath = path.join(
  artifactsDirectory,
  `native-macos-lifecycle-${stamp}.png`,
);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const absolute = (relativePath) =>
  path.join(nativeConfig.vault, ...relativePath.split("/"));
const testPath = (name) => `${testPrefix}/${name}.pdf`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

assert.equal(process.platform, "darwin", "This lifecycle test is macOS-only.");
assert.equal(nativeConfig.platform, "darwin");
assert.equal(nativeConfig.vault, MACOS_TEST_VAULT);
assert.equal(nativeConfig.vaultSelector, "ObReader-Apple-Test");
assert.equal(nativeConfig.configDir, ".obsidian");
assert.ok(
  nativeConfig.cdpUrl,
  "Set PDF_READER_CDP_URL to the isolated Obsidian test instance; the CLI cannot target its private profile safely.",
);
const selectedNativeCases = selectNativeCases(process.env.PDF_READER_NATIVE_CASES);
const selectedFixtureNames = fixturesForNativeCases(selectedNativeCases);

function assertOwnedPath(relativePath) {
  assert.equal(typeof relativePath, "string");
  assert.ok(
    relativePath.startsWith(`${testPrefix}/`),
    `Refusing to modify a non-test path: ${relativePath}`,
  );
  assert.ok(relativePath.endsWith(".pdf"));
  assert.ok(!relativePath.includes("\\"));
  assert.ok(!relativePath.split("/").some((part) => part === ".." || part === "."));
  return relativePath;
}

async function waitFor(description, probe, predicate = Boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await probe();
    if (predicate(latest)) return latest;
    await wait(250);
  }
  throw new Error(
    `Timed out waiting for ${description}; last value: ${JSON.stringify(latest)}`,
  );
}

let browser;
let primaryPage;
let createdPopoutPage;
const popoutCleanupAnchors = new Map();
let originalAutoSave;
let backgroundVisibilityEmulationEnabled = false;
let nativeCdpUnavailable = false;
const backgroundVisibilitySessions = new Map();
const nativePageDiagnostics = new Map();
let report = {
  startedAt: new Date().toISOString(),
  driver: "puppeteer-core CDP to isolated Obsidian",
  cdpUrl: nativeConfig.cdpUrl,
  expectedIdentity,
  testPrefix,
  caseSelection: {
    selected: selectedNativeCases,
    available: Object.keys(NATIVE_LIFECYCLE_CASES),
  },
  executedCases: [],
  completedCases: [],
  testFiles: [],
  checks: {},
  inputDiagnostics: { clickHitTests: [] },
  limitations: [
    {
      feature: "standalone Download Copy UI",
      status: "not exercised",
      reason: "The current PDF.js secondaryDownload control is relabeled 保存到仓库 and routes to the in-vault save contract; no separate copy-download action is exposed by this UI.",
    },
  ],
  visibilityEmulation: {
    mode: "native-background-focus-emulated",
    purpose: "Make each isolated renderer document renderable; this does not claim or require OS foreground focus.",
    ownerWindows: [],
  },
  status: "running",
};

async function persistReport() {
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(reportTempPath, `${JSON.stringify(report, null, 2)}\n`);
  await rename(reportTempPath, reportPath);
}

function isNativeCdpUnavailableError(error) {
  return /Target\.detachFromTarget timed out|Target closed|Connection closed|Session closed|Target page, context or browser has been closed|Connection terminated/i
    .test(String(error?.stack || error));
}

async function withNativeCdpDeadline(operation, request, timeoutMs = 8_000) {
  let timer;
  const pending = typeof request === "function" ? request() : request;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Native CDP ${operation} did not settle within ${timeoutMs}ms.`);
      error.name = "NativeCdpOperationTimeout";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } catch (error) {
    if (error?.name === "NativeCdpOperationTimeout" || isNativeCdpUnavailableError(error)) {
      nativeCdpUnavailable = true;
      report.nativeCdpUnavailable = {
        operation,
        reason: error?.stack || String(error),
        at: new Date().toISOString(),
        laterCdpCallsQueued: false,
      };
      await persistReport().catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function checkpointMatrix(matrix, operation, status, evidence = {}) {
  matrix.steps.push({
    operation,
    status,
    at: new Date().toISOString(),
    ...evidence,
  });
  matrix.updatedAt = new Date().toISOString();
  report.checks.nativeEditorViewerMatrix = matrix;
  try {
    await persistReport();
  } catch (error) {
    matrix.checkpointPersistenceError = error?.stack || String(error);
  }
}

async function pageIdentity(page) {
  return page.evaluate(() => ({
    vault: window.app?.vault?.adapter?.basePath || null,
    configDir: window.app?.vault?.configDir || null,
  }));
}

async function verifyIdentity(page) {
  const url = page.url();
  assert.ok(
    url === appUrl || url === "about:blank",
    "Refusing a non-Obsidian CDP target.",
  );
  const identity = await pageIdentity(page);
  assert.deepEqual(
    identity,
    expectedIdentity,
    `Refusing to operate a renderer outside ${expectedIdentity.vault} (${expectedIdentity.configDir}).`,
  );
  if (url === "about:blank") {
    const isPopout = await page.evaluate(() =>
      document.body?.classList?.contains("is-popout-window") === true,
    );
    assert.equal(isPopout, true, "An about:blank renderer must prove it is an Obsidian popout.");
  }
  return identity;
}

function installNativePageDiagnostics(page) {
  if (nativePageDiagnostics.has(page)) return nativePageDiagnostics.get(page);
  const diagnostics = {
    urlAtInstall: page.url(),
    pageErrors: [],
    consoleWarningsAndErrors: [],
    frameNavigations: [],
  };
  page.on("pageerror", (error) => {
    diagnostics.pageErrors.push({
      at: new Date().toISOString(),
      error: error?.stack || String(error),
    });
    if (diagnostics.pageErrors.length > 100) diagnostics.pageErrors.shift();
  });
  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    diagnostics.consoleWarningsAndErrors.push({
      at: new Date().toISOString(),
      type,
      text: message.text(),
      location: message.location(),
    });
    if (diagnostics.consoleWarningsAndErrors.length > 100) diagnostics.consoleWarningsAndErrors.shift();
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) return;
    diagnostics.frameNavigations.push({
      at: new Date().toISOString(),
      name: frame.name(),
      url: frame.url(),
    });
    if (diagnostics.frameNavigations.length > 100) diagnostics.frameNavigations.shift();
  });
  nativePageDiagnostics.set(page, diagnostics);
  return diagnostics;
}

function isLivePageTarget(page) {
  if (!browser?.isConnected() || !page || page.isClosed()) return false;
  return browser.targets().includes(page.target());
}

async function evaluate(page, expression) {
  await verifyIdentity(page);
  return page.evaluate(async ({ expression: source, expected }) => {
    const actual = {
      vault: window.app?.vault?.adapter?.basePath || null,
      configDir: window.app?.vault?.configDir || null,
    };
    if (
      actual.vault !== expected.vault ||
      actual.configDir !== expected.configDir
    ) {
      throw new Error(
        `Renderer identity changed before native operation: ${JSON.stringify(actual)}`,
      );
    }
    return await (0, eval)(source);
  }, { expression, expected: expectedIdentity });
}

async function evaluateJson(page, expression) {
  const value = await evaluate(page, expression);
  assert.equal(typeof value, "string", "Expected a JSON string from Obsidian.");
  return JSON.parse(value);
}

async function enableBackgroundVisibilityEmulation(page) {
  if (backgroundVisibilitySessions.has(page)) return;
  await verifyIdentity(page);
  const session = await page.createCDPSession();
  try {
    await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const state = await evaluateJson(page, `JSON.stringify({
      vault: app.vault.adapter.basePath,
      configDir: app.vault.configDir,
      visibility: document.visibilityState,
      documentHasFocus: document.hasFocus(),
    })`);
    assert.deepEqual(
      { vault: state.vault, configDir: state.configDir },
      expectedIdentity,
    );
    assert.equal(
      state.visibility,
      "visible",
      "CDP background focus emulation must make the isolated renderer document renderable.",
    );
    const row = {
      title: await page.title().catch(() => ""),
      enabled: true,
      visibility: state.visibility,
      documentHasFocus: state.documentHasFocus,
      osForegroundClaimed: false,
    };
    backgroundVisibilitySessions.set(page, { session, row });
    report.visibilityEmulation.ownerWindows.push(row);
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
}

async function disableBackgroundVisibilityEmulation(page) {
  const entry = backgroundVisibilitySessions.get(page);
  if (!entry) return;
  if (page.isClosed()) {
    entry.row.enabled = false;
    entry.row.releasedByWindowClose = true;
    backgroundVisibilitySessions.delete(page);
    await entry.session.detach().catch(() => {});
    return;
  }
  await verifyIdentity(page);
  await entry.session.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  const state = await evaluateJson(page, `JSON.stringify({
    vault: app.vault.adapter.basePath,
    configDir: app.vault.configDir,
    visibility: document.visibilityState,
    documentHasFocus: document.hasFocus(),
  })`);
  assert.deepEqual(
    { vault: state.vault, configDir: state.configDir },
    expectedIdentity,
  );
  entry.row.enabled = false;
  entry.row.releasedByWindowClose = false;
  entry.row.afterDisable = {
    visibility: state.visibility,
    documentHasFocus: state.documentHasFocus,
  };
  backgroundVisibilitySessions.delete(page);
  await entry.session.detach();
}

async function appWindows() {
  const pages = [...(await browser.pages())].filter(isLivePageTarget);
  for (const target of browser.targets()) {
    if (target.type() !== "page" || ![appUrl, "about:blank"].includes(target.url())) continue;
    const page = await target.page().catch(() => null);
    if (page && isLivePageTarget(page) && !pages.includes(page)) pages.push(page);
  }
  const matching = [];
  for (const page of pages) {
    if (!isLivePageTarget(page)) continue;
    if (![appUrl, "about:blank"].includes(page.url())) continue;
    const identity = await pageIdentity(page).catch(() => null);
    if (!isLivePageTarget(page)) continue;
    if (!identity?.vault || !identity?.configDir) continue;
    assert.deepEqual(
      identity,
      expectedIdentity,
      `CDP exposed an Obsidian renderer for another vault; refusing all native operations.`,
    );
    installNativePageDiagnostics(page);
    if (page.url() === "about:blank") {
      const isPopout = await page.evaluate(() =>
        document.body?.classList?.contains("is-popout-window") === true,
      ).catch(() => false);
      if (!isLivePageTarget(page)) continue;
      if (!isPopout) continue;
    }
    matching.push(page);
  }
  if (backgroundVisibilityEmulationEnabled) {
    for (const page of matching) {
      await enableBackgroundVisibilityEmulation(page);
    }
  }
  return matching;
}

async function ownedReaderTabs() {
  const owned = [];
  for (const page of await appWindows()) {
    const tabs = await evaluateJson(page, `JSON.stringify(
      app.workspace.getLeavesOfType(${JSON.stringify(viewType)}).map(leaf => ({
        leafId: leaf.id,
        path: leaf.view?.requestedPath || leaf.view?.file?.path || null,
      })).filter(item => typeof item.path === 'string' &&
        item.path.startsWith(${JSON.stringify(`${testPrefix}/`)}))
    )`);
    owned.push(...tabs.map((tab) => ({ page, ...tab })));
  }
  return owned;
}

async function viewsFor(relativePath) {
  assertOwnedPath(relativePath);
  const found = [];
  for (const page of await appWindows()) {
    if (!isLivePageTarget(page)) continue;
    let rows;
    try {
      rows = await evaluateJson(page, `JSON.stringify(
        app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
          .filter(leaf => (leaf.view?.requestedPath || leaf.view?.file?.path) === ${JSON.stringify(relativePath)})
          .map(leaf => ({
            leafId: leaf.id,
            path: leaf.view?.requestedPath || leaf.view?.file?.path || null,
            documentId: leaf.view?.documentId || null,
            openRequest: leaf.view?.openRequest ?? null,
            ready: !!leaf.view?.ready,
            frameLoaded: !!leaf.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument,
            pages: leaf.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument?.numPages || 0,
            saving: !!leaf.view?.saving,
            ownerWindowIsOwner: leaf.view?.ownerWindow === leaf.view?.contentEl?.ownerDocument?.defaultView,
            pluginViews: app.plugins.plugins[${JSON.stringify(pluginId)}]?.views?.size ?? null,
            popout: document.body.classList.contains('is-popout-window'),
          }))
      )`);
    } catch (error) {
      if (!isLivePageTarget(page)) continue;
      throw error;
    }
    for (const row of rows) found.push({ page, ...row });
  }
  return found;
}

async function oneView(relativePath, leafId) {
  const views = await viewsFor(relativePath);
  const selected = leafId
    ? views.filter((view) => view.leafId === leafId)
    : views;
  assert.equal(
    selected.length,
    1,
    `Expected exactly one owned Reader tab for ${relativePath}${leafId ? ` (${leafId})` : ""}; found ${selected.length}`,
  );
  return selected[0];
}

async function waitForView(relativePath, leafId, timeoutMs = 60_000) {
  return waitFor(
    `Reader ready for ${relativePath}`,
    async () => {
      const views = await viewsFor(relativePath);
      const matches = leafId
        ? views.filter((view) => view.leafId === leafId)
        : views;
      return matches.length === 1 ? matches[0] : null;
    },
    (view) => Boolean(view?.ready && view?.frameLoaded && view?.pages > 0),
    timeoutMs,
  ).then(async (view) => {
    const status = await evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const frame = leaf?.view?.iframe?.contentWindow;
      const pdf = frame?.PDFViewerApplication?.pdfDocument;
      return {
        path: leaf?.view?.requestedPath || null,
        documentId: leaf?.view?.documentId || null,
        openRequest: leaf?.view?.openRequest ?? null,
        ready: !!leaf?.view?.ready,
        pages: pdf?.numPages || 0,
        frameLoaded: !!frame?.PDFViewerApplication?.pdfDocument,
        ownerWindowIsOwner: leaf?.view?.ownerWindow === leaf?.view?.contentEl?.ownerDocument?.defaultView,
      };
    })())`);
    assert.equal(status.path, relativePath);
    assert.equal(status.ready, true);
    assert.ok(status.pages > 0, `PDF.js did not load ${relativePath}`);
    assert.equal(status.ownerWindowIsOwner, true);
    return { ...view, ...status };
  });
}

async function setAutoSave(page, enabled) {
  const outcome = await evaluateJson(page, `(async () => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    if (!plugin || typeof plugin.setAutoSaveEnabled !== 'function') {
      throw new Error('Candidate plugin does not expose setAutoSaveEnabled().');
    }
    await plugin.setAutoSaveEnabled(${JSON.stringify(Boolean(enabled))});
    const persisted = await plugin.loadData();
    return JSON.stringify({
      enabled: plugin.settings.autoSave,
      persisted: persisted?.autoSave ?? null,
    });
  })()`);
  assert.equal(outcome.enabled, Boolean(enabled));
  assert.equal(outcome.persisted, Boolean(enabled));
  return outcome;
}

async function openReader(page, relativePath, { duplicate = false } = {}) {
  assertOwnedPath(relativePath);
  const result = await evaluateJson(page, `(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(relativePath)});
    if (!file || file.extension?.toLowerCase() !== 'pdf') {
      throw new Error('Missing test-owned PDF: ${relativePath}');
    }
    const leaf = app.workspace.getLeaf(true);
    if (${JSON.stringify(duplicate)}) {
      await leaf.setViewState({
        type: ${JSON.stringify(viewType)},
        active: true,
        state: { file: ${JSON.stringify(relativePath)}, path: ${JSON.stringify(relativePath)} },
      });
    } else {
      await leaf.openFile(file);
    }
    app.workspace.setActiveLeaf?.(leaf, { focus: true });
    return JSON.stringify({ leafId: leaf.id, path: leaf.view?.requestedPath || leaf.view?.file?.path || null });
  })()`);
  assert.equal(result.path, relativePath);
  return waitForView(relativePath, result.leafId);
}

async function activateView(view) {
  await evaluate(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    if (!leaf || (leaf.view?.requestedPath || leaf.view?.file?.path) !== ${JSON.stringify(view.path)}) {
      throw new Error('The target Reader tab is no longer the owned test PDF.');
    }
    app.workspace.setActiveLeaf?.(leaf, { focus: true });
    leaf.view.iframe?.contentWindow?.focus?.();
    return true;
  })()`);
}

async function setEditorMode(view, mode) {
  await activateView(view);
  await evaluate(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe?.contentWindow;
    const viewerApp = frame?.PDFViewerApplication;
    if (!viewerApp?.eventBus) throw new Error('PDF.js event bus is unavailable.');
    viewerApp.eventBus.dispatch('switchannotationeditormode', { mode: ${Number(mode)} });
    return true;
  })()`);
  await waitFor(
    `PDF.js editor mode ${mode}`,
    async () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      return leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null;
    })())`),
    (value) => value === mode,
  );
}

async function editorTypes(view) {
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const storage = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument?.annotationStorage;
    return [...(storage?.serializable?.map?.values?.() || [])]
      .filter(item => !item.deleted)
      .map(item => item.annotationType)
      .sort((a, b) => a - b);
  })())`);
}

async function editorDetails(view, type = null) {
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe?.contentWindow;
    const storage = frame?.PDFViewerApplication?.pdfDocument?.annotationStorage;
    const toRgb = value => {
      if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) {
        return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
      }
      return value ? Array.from(value) : null;
    };
    return [...(storage?.serializable?.map?.values?.() || [])]
      .filter(item => !item.deleted && (${type == null ? "true" : `item.annotationType === ${Number(type)}`}))
      .map(item => {
        const serialized = item.serialize?.() || null;
        return {
          id: item.id,
          uid: item.uid || null,
          type: item.annotationType,
          color: toRgb(serialized?.color ?? item.color),
          thickness: serialized?.thickness ?? item.thickness ?? item._drawingOptions?.['stroke-width'] ?? null,
          rect: serialized?.rect ? Array.from(serialized.rect) : item.rect ? Array.from(item.rect) : null,
          serialized,
        };
      });
  })())`);
}

async function annotationDetails(view) {
  return evaluateJson(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const pdf = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument;
    if (!pdf) throw new Error('PDF.js document is unavailable.');
    const first = await pdf.getPage(1);
    return JSON.stringify((await first.getAnnotations()).map(annotation => ({
      subtype: annotation.subtype,
      color: annotation.color ? Object.values(annotation.color) : null,
      width: annotation.borderStyle?.rawWidth ?? annotation.borderStyle?.width ?? null,
      rect: annotation.rect ? Array.from(annotation.rect) : null,
    })));
  })()`);
}

async function setShapeParameters(view, { color, thickness }) {
  await evaluate(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe?.contentWindow;
    if (!frame) throw new Error('PDF Viewer frame is unavailable.');
    for (const [id, value] of [["editorSquareColor", ${JSON.stringify(color)}], ["editorSquareThickness", ${JSON.stringify(String(thickness))}]]) {
      const input = frame.document.getElementById(id);
      if (!input) throw new Error('Missing PDF.js shape parameter: ' + id);
      const setter = Object.getOwnPropertyDescriptor(frame.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new frame.Event('input', { bubbles: true }));
    }
    return true;
  })()`);
}

async function editorDomBounds(view, type, index = 0) {
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const win = frame?.contentWindow;
    const viewer = win?.PDFViewerApplication?.pdfViewer;
    const storage = win?.PDFViewerApplication?.pdfDocument?.annotationStorage;
    const editors = [...(win?.document?.querySelectorAll('.inkEditor') || [])]
      .map(element => ({
        element,
        editor: storage?.getRawValue?.(element.id),
      }))
      .filter(({ editor }) => editor?.constructor?._editorType === ${Number(type)});
    const selected = editors[${Number(index)}];
    if (!selected) return null;
    const rect = selected.element.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const handle = selected.element.querySelector('.resizers > .resizer.bottomRight');
    const handleRect = handle?.getBoundingClientRect();
    const handleStyle = handle ? getComputedStyle(handle) : null;
    const serialized = selected.editor.serialize?.() || null;
    return {
      id: selected.element.id,
      uid: selected.editor.uid || null,
      type: selected.editor.constructor._editorType,
      editorIds: editors.map(({ element }) => element.id),
      selected: !!viewer?._layerProperties?.annotationEditorUIManager?.isSelected?.(selected.editor),
      editorClass: selected.element.className,
      explicitlyEditing: selected.element.classList.contains("explicitlyEditing"),
      x: frameRect.x + rect.x,
      y: frameRect.y + rect.y,
      width: rect.width,
      height: rect.height,
      handle: handleRect ? { x: frameRect.x + handleRect.x + handleRect.width / 2,
        y: frameRect.y + handleRect.y + handleRect.height / 2,
        width: handleRect.width, height: handleRect.height,
        display: handleStyle?.display || null,
        visibility: handleStyle?.visibility || null,
        opacity: handleStyle?.opacity || null,
        resizerName: handle?.dataset?.resizerName || null } : null,
      serializedRect: serialized?.rect || null,
      color: typeof selected.editor.color === 'string' && /^#[0-9a-f]{6}$/i.test(selected.editor.color)
        ? [1, 3, 5].map(index => parseInt(selected.editor.color.slice(index, index + 2), 16))
        : selected.editor.color ? Array.from(selected.editor.color) : null,
      thickness: selected.editor._drawingOptions?.['stroke-width'] ?? null,
    };
  })())`);
}

async function squareEditorRows(view) {
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const win = frame?.contentWindow;
    const viewer = win?.PDFViewerApplication?.pdfViewer;
    const storage = win?.PDFViewerApplication?.pdfDocument?.annotationStorage;
    const frameRect = frame?.getBoundingClientRect();
    return [...(frame?.contentDocument?.querySelectorAll(
      '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
    ) || [])]
      .map(element => ({ element, editor: storage?.getRawValue?.(element.id) }))
      .filter(({ editor }) => editor?.constructor?._editorType === 5)
      .map(({ element, editor }) => {
        const rect = element.getBoundingClientRect();
        return {
          id: element.id,
          uid: editor.uid || null,
          annotationElementId: editor.annotationElementId || null,
          className: element.className,
          selected: !!viewer?._layerProperties?.annotationEditorUIManager?.isSelected?.(editor),
          explicitlyEditing: element.classList.contains('explicitlyEditing'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            screenX: (frameRect?.x || 0) + rect.x, screenY: (frameRect?.y || 0) + rect.y },
        };
      });
  })())`);
}

async function waitForSquareHitReady(view, editor) {
  assert.ok(editor?.uid, "A Square editor UID is required for exact hit validation.");
  return waitFor(
    `disabled-layer Square editor hit target for ${editor.uid}`,
    async () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const frame = leaf?.view?.iframe;
      const doc = frame?.contentDocument;
      const page = doc?.querySelector('.page[data-page-number="1"]');
      if (!page || page.classList.contains('loading') || page.classList.contains('loadingIcon')) return null;
      const layer = page.querySelector('.annotationEditorLayer');
      const storage = frame?.contentWindow?.PDFViewerApplication?.pdfDocument?.annotationStorage;
      const targetId = ${JSON.stringify(editor.id)};
      const uid = ${JSON.stringify(editor.uid)};
      const target = doc.getElementById(targetId);
      const editor = storage?.getRawValue?.(targetId);
      if (!layer || !target || editor?.uid !== uid) return { uid, targetFound: false };
      const rect = target.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const ordinaryHit = doc.elementFromPoint(x, y);
      const wasEnabled = layer.classList.contains('getElements');
      let stack = [];
      try {
        layer.classList.add('getElements');
        stack = doc.elementsFromPoint(x, y);
      } finally {
        if (!wasEnabled) layer.classList.remove('getElements');
      }
      const editorHit = stack.find(element => /^pdfjs_internal_editor_[0-9]+$/.test(element.id));
      const hitEditor = editorHit && storage?.getRawValue?.(editorHit.id);
      const frameRect = frame.getBoundingClientRect();
      const summarize = element => element ? { tag: element.tagName, id: element.id || null,
        className: typeof element.className === 'string' ? element.className : null } : null;
      return {
        uid,
        targetId,
        targetFound: true,
        targetHasNoAnnotationElementId: editor?.annotationElementId === null,
        ordinaryHit: summarize(ordinaryHit),
        firstHit: summarize(stack[0]),
        firstHitInsideLayer: !!stack[0] && layer.contains(stack[0]),
        editorHit: summarize(editorHit),
        hitUid: hitEditor?.uid || null,
        hitTarget: editorHit?.id === targetId && hitEditor?.uid === uid && hitEditor?.annotationElementId === null,
        getElementsRestored: layer.classList.contains('getElements') === wasEnabled,
        points: { x, y, screenX: frameRect.x + x, screenY: frameRect.y + y,
          width: rect.width, height: rect.height },
        stack: stack.slice(0, 6).map(summarize),
      };
    })())`),
    (result) => Boolean(result?.targetFound && result.targetHasNoAnnotationElementId &&
      result.hitTarget && result.firstHitInsideLayer && result.getElementsRestored),
    30_000,
  );
}

async function enterExplicitSquareEdit(view, index = 0) {
  await setEditorMode(view, 0);
  const editors = await waitFor(
    "PDF.js to retain the uncommitted Square editor DOM in NONE mode",
    () => squareEditorRows(view),
    (rows) => rows.length > index,
    30_000,
  );
  const target = editors[index];
  assert.ok(target?.uid);
  assert.equal(target.annotationElementId, null,
    "This native pointer test requires an uncommitted Square handled by the PDF.js disabled-layer double-click path.");
  const hitTarget = await waitForSquareHitReady(view, target);
  const probeKey = `__nativeSquarePointerProbe_${stamp}_${Math.random().toString(36).slice(2)}`;
  await evaluateJson(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe?.contentWindow;
    const textLayer = frame?.document?.querySelector('.page[data-page-number="1"] .textLayer');
    if (!textLayer) throw new Error('The PDF.js text layer is missing for the native double-click path.');
    const events = [];
    const listener = event => {
      if (!textLayer.contains(event.target)) return;
      events.push({ timeStamp: event.timeStamp, clientX: event.clientX,
        clientY: event.clientY, detail: event.detail, pointerType: event.pointerType,
        target: { tag: event.target?.tagName || null, className: event.target?.className || null },
        layerHasGetElements: !!frame.document.querySelector('.annotationEditorLayer')?.classList.contains('getElements') });
    };
    frame.document.addEventListener('pointerdown', listener, true);
    window[${JSON.stringify(probeKey)}] = { textLayer, doc: frame.document, listener, events };
    return JSON.stringify({ installed: true, textLayerClass: textLayer.className });
  })()`);
  let hit;
  let explicit;
  let bounds;
  let pointerEvents = [];
  try {
    hit = await clickAt(view, hitTarget.points.screenX, hitTarget.points.screenY,
      null, { clickCount: 2, delay: 80 });
    explicit = await waitFor(
      `native double-click to enter explicit edit mode for Square ${target.uid}`,
      async () => evaluateJson(view.page, `JSON.stringify((() => {
        const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
          .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
        const frame = leaf?.view?.iframe?.contentWindow;
        const viewer = frame?.PDFViewerApplication?.pdfViewer;
        const storage = frame?.PDFViewerApplication?.pdfDocument?.annotationStorage;
        const layer = frame?.document?.querySelector('.page[data-page-number="1"] .annotationEditorLayer');
        const element = [...(layer?.querySelectorAll('.explicitlyEditing') || [])]
          .find(node => storage?.getRawValue?.(node.id)?.uid === ${JSON.stringify(target.uid)});
        const editor = element && storage.getRawValue(element.id);
        return {
          mode: viewer?.annotationEditorMode ?? null,
          uid: editor?.uid || null,
          id: element?.id || null,
          explicitlyEditing: !!element,
          selected: !!(editor && viewer?._layerProperties?.annotationEditorUIManager?.isSelected?.(editor)),
          className: element?.className || null,
        };
      })())`),
      (state) => state?.mode === 5 && state.uid === target.uid && state.explicitlyEditing && state.selected,
      8_000,
    );
    await waitFor(
      `Square ${target.uid} to be selected in PDF.js storage after explicit edit`,
      () => squareEditorRows(view),
      (rows) => rows.some((row) => row.uid === target.uid && row.selected),
      8_000,
    );
    bounds = await waitFor(
      `Square ${target.uid} rendered controls after explicit edit`,
      () => editorDomBounds(view, 5, index),
      (detail) => detail?.uid === target.uid && detail.selected && detail.explicitlyEditing,
      8_000,
    );
  } catch (error) {
    pointerEvents = await evaluateJson(view.page, `(() => {
      const probe = window[${JSON.stringify(probeKey)}];
      return JSON.stringify(probe?.events || []);
    })()`).catch(() => []);
    const diagnostic = { target, hitTarget, actualHit: hit?.inner || null, pointerEvents };
    const wrapped = new Error(`${error.message}; native input evidence: ${JSON.stringify(diagnostic)}`);
    wrapped.stack = `${error.stack}\nNative input evidence: ${JSON.stringify(diagnostic)}`;
    throw wrapped;
  } finally {
    const captured = await evaluateJson(view.page, `(() => {
      const probe = window[${JSON.stringify(probeKey)}];
      if (!probe) return JSON.stringify([]);
      probe.doc.removeEventListener('pointerdown', probe.listener, true);
      delete window[${JSON.stringify(probeKey)}];
      return JSON.stringify(probe.events);
    })()`).catch(() => "[]");
    if (pointerEvents.length === 0) {
      try { pointerEvents = Array.isArray(captured) ? captured : JSON.parse(captured); } catch {}
    }
  }
  assert.equal(pointerEvents.length, 2,
    `A physical double-click must deliver two pointerdown events to the target text layer: ${JSON.stringify(pointerEvents)}.`);
  assert.ok(pointerEvents[1].timeStamp - pointerEvents[0].timeStamp < 500,
    `PDF.js requires the two native pointerdowns to be within 500ms: ${JSON.stringify(pointerEvents)}.`);
  return { target, hitTarget, hit: hit?.inner || null, explicit, bounds, pointerEvents };
}

async function saveNativeScreenshot(page, label) {
  await verifyIdentity(page);
  const noticeCount = await waitFor(
    `Obsidian notices to clear before ${label} evidence capture`,
    async () => page.evaluate(() => document.querySelectorAll(".notice").length),
    (count) => count === 0,
    10_000,
  );
  const screenshot = path.join(artifactsDirectory, `native-macos-lifecycle-${stamp}-${label}.png`);
  await page.screenshot({ path: screenshot, fullPage: false });
  report.screenshots ||= {};
  report.screenshots[label] = { path: screenshot, noticeCount };
  await persistReport();
  return screenshot;
}

async function inspectNativeClickHit(view, x, y, expectedElementId = null) {
  const hit = await evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const frameRect = frame?.getBoundingClientRect();
    const outer = document.elementFromPoint(${Number(x)}, ${Number(y)});
    const inner = frameRect && frame?.contentDocument?.elementFromPoint(
      ${Number(x)} - frameRect.left,
      ${Number(y)} - frameRect.top,
    );
    const expected = ${expectedElementId == null
      ? "null"
      : `frame?.contentDocument?.getElementById(${JSON.stringify(expectedElementId)})`};
    const describe = element => element ? {
      tag: element.tagName,
      id: element.id || null,
      className: typeof element.className === 'string' ? element.className : null,
      resizerName: element.getAttribute?.('data-resizer-name') || null,
      editorAncestorId: element.closest?.('.inkEditor')?.id || null,
      parentClass: typeof element.parentElement?.className === 'string' ? element.parentElement.className : null,
      ariaLabel: element.getAttribute?.('aria-label') || null,
      title: element.getAttribute?.('title') || null,
    } : null;
    return {
      x: ${Number(x)},
      y: ${Number(y)},
      frameConnected: !!frame?.isConnected,
      outerIsFrame: outer === frame,
      outer: describe(outer),
      inner: describe(inner),
      expectedElementId: ${JSON.stringify(expectedElementId)},
      expectedFound: ${expectedElementId == null ? "null" : "!!expected"},
      innerWithinExpected: ${expectedElementId == null
        ? "null"
        : "!!expected && (inner === expected || expected.contains(inner))"},
    };
  })())`);
  report.inputDiagnostics.clickHitTests.push({
    at: new Date().toISOString(),
    leafId: view.leafId,
    path: view.path,
    ...hit,
  });
  return hit;
}

async function clickAt(view, x, y, expectedElementId = null, { clickCount = 1, delay = 0 } = {}) {
  await verifyIdentity(view.page);
  const hit = await inspectNativeClickHit(view, x, y, expectedElementId);
  assert.equal(
    hit.outerIsFrame,
    true,
    `Native click at (${x}, ${y}) is covered outside the PDF iframe: ${JSON.stringify(hit.outer)}.`,
  );
  assert.equal(hit.frameConnected, true, "Native click target PDF iframe is detached.");
  if (expectedElementId !== null) {
    assert.equal(hit.expectedFound, true, `PDF.js control ${expectedElementId} disappeared before click.`);
    assert.equal(
      hit.innerWithinExpected,
      true,
      `Native click would miss PDF.js control ${expectedElementId}: ${JSON.stringify(hit.inner)}.`,
    );
  }
  if (clickCount === 1) {
    await view.page.mouse.click(x, y, { button: "left" });
  } else {
    await view.page.mouse.move(x, y);
    for (let index = 1; index <= clickCount; index += 1) {
      await view.page.mouse.down({ button: "left", clickCount: index });
      await view.page.mouse.up({ button: "left", clickCount: index });
      if (index < clickCount) await wait(delay || 80);
    }
  }
  await verifyIdentity(view.page);
  return hit;
}

async function viewerElementPoint(view, elementId) {
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const element = frame?.contentDocument?.getElementById(${JSON.stringify(elementId)});
    if (!frame || !element) return null;
    const frameRect = frame.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return { x: frameRect.x + rect.x + rect.width / 2,
      y: frameRect.y + rect.y + rect.height / 2,
      width: rect.width, height: rect.height,
      hidden: element.hidden || getComputedStyle(element).display === 'none' };
  })())`);
}

async function clickViewerElement(view, elementId) {
  const point = await viewerElementPoint(view, elementId);
  assert.ok(point, `Missing PDF.js control ${elementId}.`);
  assert.ok(point.width > 0 && point.height > 0, `PDF.js control ${elementId} has no visible hit area.`);
  assert.equal(point.hidden, false, `PDF.js control ${elementId} is hidden.`);
  await clickAt(view, point.x, point.y, elementId);
}

async function clickViewerButton(view, buttonId) {
  await waitFor(
    `Obsidian notices to clear before clicking PDF.js control ${buttonId}`,
    async () => evaluateJson(view.page, "JSON.stringify(document.querySelectorAll('.notice').length)"),
    (count) => count === 0,
    15_000,
  );
  const initial = await evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const doc = frame?.contentDocument;
    const toggle = doc?.getElementById('secondaryToolbarToggleButton');
    const toolbar = doc?.getElementById('secondaryToolbar');
    const button = doc?.getElementById(${JSON.stringify(buttonId)});
    if (!frame || !toolbar || !toggle || !button) return null;
    const frameRect = frame.getBoundingClientRect();
    const getPoint = element => {
      const rect = element.getBoundingClientRect();
      return { x: frameRect.x + rect.x + rect.width / 2,
        y: frameRect.y + rect.y + rect.height / 2 };
    };
    const rect = button.getBoundingClientRect();
    return { hidden: toolbar.classList.contains('hidden'), toggle: getPoint(toggle),
      disabled: button.disabled,
      label: button.querySelector('span')?.textContent?.trim() || button.textContent?.trim() || '',
      title: button.title || '',
      buttonRect: { width: rect.width, height: rect.height } };
  })())`);
  assert.ok(initial, `Could not locate PDF.js toolbar control ${buttonId}.`);
  if (initial.hidden) {
    await clickAt(view, initial.toggle.x, initial.toggle.y);
    await waitFor(
      "PDF.js secondary toolbar to open",
      async () => evaluateJson(view.page, `JSON.stringify(!app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)})
        .view.iframe.contentDocument.getElementById('secondaryToolbar').classList.contains('hidden'))`),
    );
  }
  const buttonPoint = await viewerElementPoint(view, buttonId);
  assert.ok(buttonPoint, `Could not find visible PDF.js control ${buttonId}.`);
  assert.ok(buttonPoint.width > 0 && buttonPoint.height > 0, `${buttonId} has no hit area.`);
  assert.equal(buttonPoint.hidden, false, `${buttonId} is hidden.`);
  assert.equal(initial.disabled, false, `${buttonId} is disabled.`);
  await clickAt(view, buttonPoint.x, buttonPoint.y, buttonId);
  return initial;
}

async function pageGeometry(view, expectedMode) {
  return waitFor(
    `finished PDF.js PageView and ready annotation layer for ${view.path}`,
    async () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const frame = leaf?.view?.iframe;
      const frameWindow = frame?.contentWindow;
      const container = frameWindow?.document?.getElementById('viewerContainer');
      if (container) container.scrollTop = 0;
      const viewerApp = frameWindow?.PDFViewerApplication;
      const viewer = viewerApp?.pdfViewer;
      const pageView = viewer?.getPageView?.(0);
      const page = frameWindow?.document?.querySelector('.page[data-page-number="1"]');
      const annotationLayer = pageView?.annotationEditorLayer?.div;
      const textLayer = pageView?.textLayer?.div;
      const rect = page?.getBoundingClientRect();
      const frameRect = frame?.getBoundingClientRect();
      if (!rect || !frameRect || !pageView || !annotationLayer) return null;
      const modeLayerClass = ${Number(expectedMode)} === 5
        ? 'squareEditing'
        : ${Number(expectedMode)} === 15 ? 'inkEditing' : null;
      return {
        x: frameRect.x + rect.x,
        y: frameRect.y + rect.y,
        width: rect.width,
        height: rect.height,
        pageBottom: frameRect.y + rect.y + rect.height,
        frameBottom: frameRect.bottom,
        annotationEditorMode: viewer?.annotationEditorMode ?? null,
        renderingState: pageView.renderingState,
        pageLoaded: page.dataset.loaded === 'true',
        pageMatchesView: pageView.div === page,
        pageNotLoading: !page.classList.contains('loading') && !page.classList.contains('loadingIcon'),
        textLayerConnected: !!textLayer?.isConnected,
        annotationLayerConnected: annotationLayer.isConnected,
        annotationLayerOnPage: annotationLayer.parentElement === page,
        annotationLayerClass: annotationLayer.className,
        creationPriority: annotationLayer.classList.contains('creationPriority'),
        expectedModeLayerClass: modeLayerClass,
        expectedModeClassPresent: modeLayerClass ? annotationLayer.classList.contains(modeLayerClass) : true,
      };
    })())`),
    (geometry) => geometry && geometry.width > 100 && geometry.height > 100 &&
      geometry.y < geometry.frameBottom &&
      geometry.annotationEditorMode === expectedMode &&
      geometry.renderingState === 3 && geometry.pageLoaded && geometry.pageMatchesView &&
      geometry.pageNotLoading && geometry.textLayerConnected &&
      geometry.annotationLayerConnected && geometry.annotationLayerOnPage &&
      geometry.creationPriority && geometry.expectedModeClassPresent,
    60_000,
  );
}

async function drag(view, x, y, dx, dy) {
  await verifyIdentity(view.page);
  const startHit = await inspectNativeClickHit(view, x, y);
  const probeKey = `__nativeDragProbe_${stamp}_${Math.random().toString(36).slice(2)}`;
  await evaluateJson(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe?.contentWindow;
    if (!frame) throw new Error('PDF frame is unavailable before native drag.');
    const events = [];
    const listener = event => {
      if (events.length >= 24) return;
      events.push({ type: event.type, timeStamp: event.timeStamp, clientX: event.clientX,
        clientY: event.clientY, button: event.button, buttons: event.buttons,
        pointerType: event.pointerType, target: { tag: event.target?.tagName || null,
          id: event.target?.id || null, className: typeof event.target?.className === 'string' ? event.target.className : null } });
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) frame.document.addEventListener(type, listener, true);
    window[${JSON.stringify(probeKey)}] = { doc: frame.document, listener, events };
    return JSON.stringify({ dpr: window.devicePixelRatio, innerWidth, innerHeight,
      frame: (() => { const rect = leaf.view.iframe.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })() });
  })()`);
  await view.page.mouse.move(x, y);
  await view.page.mouse.down({ button: "left" });
  for (let step = 1; step <= 8; step += 1) {
    await view.page.mouse.move(x + (dx * step) / 8, y + (dy * step) / 8);
  }
  await view.page.mouse.up({ button: "left" });
  await verifyIdentity(view.page);
  const diagnostics = await evaluateJson(view.page, `(() => {
    const probe = window[${JSON.stringify(probeKey)}];
    if (!probe) return JSON.stringify({ events: [] });
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) probe.doc.removeEventListener(type, probe.listener, true);
    delete window[${JSON.stringify(probeKey)}];
    return JSON.stringify({ events: probe.events });
  })()`);
  report.inputDiagnostics.drags ??= [];
  report.inputDiagnostics.drags.push({ x, y, dx, dy, startHit, ...diagnostics });
  await persistReport();
}

async function addAnnotation(view, mode, customOffsets = null, { commitMode = null } = {}) {
  await setEditorMode(view, mode);
  const geometry = await pageGeometry(view, mode);
  const offsets = customOffsets || (mode === 15
    ? { x: 60, y: 70, dx: 75, dy: 55 }
    : { x: 100, y: 150, dx: 100, dy: 75 });
  const dragStart = { x: geometry.x + offsets.x, y: geometry.y + offsets.y };
  const dragEnd = { x: dragStart.x + offsets.dx, y: dragStart.y + offsets.dy };
  const startHit = await inspectNativeClickHit(view, dragStart.x, dragStart.y);
  const endHit = await inspectNativeClickHit(view, dragEnd.x, dragEnd.y);
  assert.equal(startHit.outerIsFrame, true, "Native annotation drag start must hit the PDF iframe.");
  assert.equal(endHit.outerIsFrame, true, "Native annotation drag end must hit the PDF iframe.");
  assert.ok(startHit.inner?.className?.includes("annotationEditorLayer"),
    `Native annotation drag start missed the ready editor layer: ${JSON.stringify(startHit.inner)}.`);
  assert.ok(endHit.inner?.className?.includes("annotationEditorLayer"),
    `Native annotation drag end missed the ready editor layer: ${JSON.stringify(endHit.inner)}.`);
  report.inputDiagnostics.annotationStarts ??= [];
  report.inputDiagnostics.annotationStarts.push({ mode, geometry, offsets, startHit, endHit });
  await persistReport();
  await drag(
    view,
    dragStart.x,
    dragStart.y,
    offsets.dx,
    offsets.dy,
  );
  if (commitMode !== null) {
    assert.equal(mode, 15, "Only an Ink draw session can request an explicit commit mode.");
    await setEditorMode(view, commitMode);
  }
  await waitFor(
    `native ${mode === 5 ? "Square" : mode === 15 ? "Ink" : `editor ${mode}`} annotation`,
    async () => editorTypes(view),
    (types) => types.includes(mode),
    20_000,
  );
  return geometry;
}

async function dispatchMacSave(view) {
  await activateView(view);
  const session = await view.page.createCDPSession();
  try {
    await verifyIdentity(view.page);
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Meta",
      code: "MetaLeft",
      windowsVirtualKeyCode: 91,
      nativeVirtualKeyCode: nativeVirtualKeyCode(nativeConfig.platform, "MetaLeft", 91),
    });
    await verifyIdentity(view.page);
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "s",
      code: "KeyS",
      text: "s",
      unmodifiedText: "s",
      modifiers: 4,
      windowsVirtualKeyCode: 83,
      nativeVirtualKeyCode: nativeVirtualKeyCode(nativeConfig.platform, "KeyS", 83),
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "s",
      code: "KeyS",
      modifiers: 4,
      windowsVirtualKeyCode: 83,
      nativeVirtualKeyCode: nativeVirtualKeyCode(nativeConfig.platform, "KeyS", 83),
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Meta",
      code: "MetaLeft",
      windowsVirtualKeyCode: 91,
      nativeVirtualKeyCode: nativeVirtualKeyCode(nativeConfig.platform, "MetaLeft", 91),
    });
  } finally {
    await session.detach();
  }
}

async function dispatchMacChord(view, key, { shift = false } = {}) {
  assert.equal(nativeConfig.platform, "darwin");
  assert.ok(["z", "y", "Backspace", "Delete"].includes(key), `Unsupported macOS chord key: ${key}`);
  await activateView(view);
  const keyboard = view.page.keyboard;
  const events = [];
  const send = async (type, keyName) => {
    await withNativeCdpDeadline(`keyboard.${type}(${keyName})`, () => keyboard[type](keyName));
    events.push({ type, key: keyName });
  };
  await send("down", "Meta");
  if (shift) await send("down", "Shift");
  await send("down", key);
  await send("up", key);
  if (shift) await send("up", "Shift");
  await send("up", "Meta");
  return {
    driver: "Puppeteer Keyboard.down/up; non-text chord keys emit rawKeyDown",
    chord: `Meta+${shift ? "Shift+" : ""}${key}`,
    events,
  };
}

async function dispatchPlainKey(view, key) {
  const session = await view.page.createCDPSession();
  const data = {
    Backspace: { code: "Backspace", windowsKeyCode: 8 },
    Delete: { code: "Delete", windowsKeyCode: 46 },
    Escape: { code: "Escape", windowsKeyCode: 27 },
  }[key];
  assert.ok(data, `Unsupported native key fixture: ${key}`);
  const nativeKeyCode = nativeVirtualKeyCode(
    nativeConfig.platform,
    data.code,
    data.windowsKeyCode,
  );
  try {
    await activateView(view);
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown", key, code: data.code,
      windowsVirtualKeyCode: data.windowsKeyCode, nativeVirtualKeyCode: nativeKeyCode,
    });
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code: data.code,
      windowsVirtualKeyCode: data.windowsKeyCode, nativeVirtualKeyCode: nativeKeyCode,
    });
  } finally {
    await session.detach();
  }
}

async function inspectPdf(view) {
  return evaluateJson(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const pdf = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument;
    if (!pdf) throw new Error('PDF.js document is unavailable.');
    const page = await pdf.getPage(1);
    const annotations = await page.getAnnotations();
    return JSON.stringify({
      fingerprint: pdf.fingerprints?.join(':') || null,
      pages: pdf.numPages,
      subtypes: annotations.map(annotation => annotation.subtype).sort(),
    });
  })()`);
}

async function reopenPdf(view) {
  const before = await evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe?.contentWindow;
    if (!frame) throw new Error('Reader frame was removed before reopen.');
    if (!frame.__lifecycleLoadCountInstalled) {
      frame.__lifecycleLoadCount = 0;
      frame.PDFViewerApplication.eventBus._on('documentloaded', () => frame.__lifecycleLoadCount++);
      frame.__lifecycleLoadCountInstalled = true;
    }
    return { count: frame.__lifecycleLoadCount,
      filePath: leaf.view.file?.path || null };
  })())`);
  await evaluate(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(view.path)});
    if (!file) throw new Error('Saved test PDF disappeared before reopen.');
    await leaf.view.openFile(file);
    return true;
  })()`);
  await waitFor(
    `fresh PDF load for ${view.path}`,
    async () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      return leaf?.view?.iframe?.contentWindow?.__lifecycleLoadCount || 0;
    })())`),
    (count) => count > before.count,
    60_000,
  );
  return inspectPdf(view);
}

async function fileHash(relativePath) {
  assertOwnedPath(relativePath);
  return sha256(await readFile(absolute(relativePath)));
}

async function waitForSaved(view, relativePath, previousHash, description) {
  assertOwnedPath(relativePath);
  return waitFor(
    description,
    async () => {
      const [hash, state] = await Promise.all([
        fileHash(relativePath),
        evaluateJson(view.page, `JSON.stringify((() => {
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
          return { saving: !!leaf?.view?.saving, ready: !!leaf?.view?.ready,
            path: leaf?.view?.requestedPath || null };
        })())`),
      ]);
      return { hash, ...state };
    },
    (state) => state.hash !== previousHash && !state.saving && state.ready && state.path === relativePath,
    60_000,
  );
}

async function detachOwnedView(view, { allowDirty = false } = {}) {
  assertOwnedPath(view.path);
  const outcome = await evaluateJson(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
        (candidate.view?.requestedPath || candidate.view?.file?.path) === ${JSON.stringify(view.path)});
    if (!leaf) return JSON.stringify({ outcome: 'already-closed' });
    if (typeof leaf.detach !== 'function') throw new Error('WorkspaceLeaf.detach() is unavailable.');
    await leaf.detach();
    return JSON.stringify({ outcome: 'detached' });
  })()`);
  await waitFor(
    `only owned Reader tab ${view.path} to close`,
    async () => (await viewsFor(view.path)).some((candidate) => candidate.leafId === view.leafId),
    (present) => !present,
    30_000,
  );
  report.checks.closedOwnedTabs ??= [];
  report.checks.closedOwnedTabs.push({
    path: view.path,
    leafId: view.leafId,
    outcome: outcome.outcome,
    allowDirty,
  });
}

const closeMonitorRegistryKey = "__pdfReaderNativeLifecycleCloseMonitors";
const closeRoutingDiagnosticRegistryKey =
  "__pdfReaderNativeLifecycleCloseDetachPatches";

async function installCloseDiagnostics(view, label) {
  assertOwnedPath(view.path);
  const monitorId = `${stamp}-${label}`;
  const snapshotBinding = `__nativeLifecycleCloseSnapshot_${monitorId.replace(/[^a-zA-Z0-9_$]/g, "_")}`;
  const traceSnapshot = { value: null, bindingError: null };
  await view.page.exposeFunction(snapshotBinding, (serialized) => {
    try {
      traceSnapshot.value = JSON.parse(serialized);
    } catch (error) {
      traceSnapshot.bindingError = error?.stack || String(error);
    }
  });
  await evaluateJson(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const target = leaf?.view;
    if (!leaf || !target ||
        (target.requestedPath || target.file?.path) !== ${JSON.stringify(view.path)}) {
      throw new Error('Close diagnostics refused a Reader outside the owned test PDF.');
    }
    const registryKey = ${JSON.stringify(closeMonitorRegistryKey)};
    const registry = window[registryKey] ||= {};
    if (registry[${JSON.stringify(monitorId)}]) {
      throw new Error('Close diagnostics are already installed for this operation.');
    }
    const trace = {
      label: ${JSON.stringify(label)},
      installedAt: new Date().toISOString(),
      path: ${JSON.stringify(view.path)},
      leafId: leaf.id,
      documentId: target.documentId || null,
      onCloseEntries: [],
      onUnloadFileEntries: [],
      viewerMessages: [],
      hostMessages: [],
      openCalls: [],
      flushCalls: [],
      recoverCalls: [],
      detachCalls: [],
      routingDetachInvocations: [],
      originalDetachEntries: [],
      rendererRestartCalls: [],
      iframeLoadEvents: [],
      rendererInitialization: [],
      childErrors: [],
    };
    const publish = () => {
      try {
        return window[${JSON.stringify(snapshotBinding)}]?.(JSON.stringify(trace));
      } catch {
        return undefined;
      }
    };
    const publishNow = async () => {
      try {
        await window[${JSON.stringify(snapshotBinding)}]?.(JSON.stringify(trace));
      } catch {
        // The close diagnostic must never change the application close result.
      }
    };
    const originals = [];
    const restoreActions = [];
    const summarizeRenderer = value => value && typeof value === 'object' ? ({
      documentId: value.documentId || null,
      openRequest: value.openRequest ?? null,
      revision: value.revision ?? null,
      confirmedRevision: value.confirmedRevision ?? null,
      restoreDirty: value.restoreDirty === true,
      restorePaused: value.restorePaused === true,
      bytesLength: value.bytes?.byteLength ?? value.bytes?.length ?? null,
      sent: value.sent ?? null,
    }) : null;
    const rendererState = () => {
      const iframe = target.iframe;
      const child = iframe?.contentWindow;
      const childDocument = iframe?.contentDocument;
      const pdf = child?.PDFViewerApplication;
      const viewerHtml = typeof target.viewerDocumentHtml === 'string' ? target.viewerDocumentHtml : '';
      const srcdoc = typeof iframe?.srcdoc === 'string' ? iframe.srcdoc : '';
      const generationFrom = html => html.match(/data-renderer-generation=["']([^"']+)["']/)?.[1] || null;
      let bridgeScripts = [];
      try {
        bridgeScripts = Array.from(childDocument?.querySelectorAll?.('script[data-channel][data-token]') || [])
          .map(script => ({
            src: script.getAttribute('src') || null,
            channel: script.dataset.channel || null,
            generation: script.dataset.rendererGeneration || null,
            tokenPresent: typeof script.dataset.token === 'string' && script.dataset.token.length > 0,
          }));
      } catch {}
      let eventBusEvents = [];
      try {
        eventBusEvents = Object.keys(pdf?.eventBus?._listeners || {});
      } catch {}
      return {
        rendererGeneration: target.rendererGeneration || null,
        iframeLoadCount: target.iframeLoadCount ?? null,
        awaitingRendererLoad: target.awaitingRendererLoad ?? null,
        pendingOpenState: summarizeRenderer(target.pendingOpenState),
        viewerDocumentHtmlLength: viewerHtml.length || null,
        viewerDocumentGeneration: generationFrom(viewerHtml),
        iframeExists: !!iframe,
        iframeIsConnected: iframe?.isConnected ?? null,
        iframeSrcAttribute: iframe?.getAttribute?.('src') || null,
        iframeSrcdocLength: srcdoc.length || null,
        iframeSrcdocGeneration: generationFrom(srcdoc),
        child: {
          exists: !!child,
          location: (() => { try { return child?.location?.href || null; } catch { return 'unreadable'; } })(),
          origin: (() => { try { return child?.origin || null; } catch { return 'unreadable'; } })(),
          parentIsOwnerWindow: (() => { try { return child?.parent === target.ownerWindow; } catch { return null; } })(),
          documentReadyState: childDocument?.readyState || null,
          currentScript: (() => {
            try {
              const script = childDocument?.currentScript;
              return script ? { src: script.src || null, generation: script.dataset?.rendererGeneration || null } : null;
            } catch { return null; }
          })(),
          bridgeScripts,
          pdfViewerApplicationExists: !!pdf,
          pdfViewerInitialized: pdf?.initialized ?? null,
          initializedPromisePresent: !!pdf?.initializedPromise,
          pdfDocumentPresent: !!pdf?.pdfDocument,
          pdfPageCount: pdf?.pdfDocument?.numPages ?? null,
          eventBusEvents,
        },
      };
    };
    const state = () => ({
      ...rendererState(),
      filePath: target.file?.path || null,
      requestedPath: target.requestedPath || null,
      documentId: target.documentId || null,
      openRequest: target.openRequest ?? null,
      ready: !!target.ready,
      ownerWindowBound: !!target.ownerWindow,
      ownerWindowIsCurrent: target.ownerWindow === target.contentEl?.ownerDocument?.defaultView,
    });
    const summarized = value => {
      if (!value || typeof value !== 'object') return value ?? null;
      const keys = ['ok', 'dirty', 'recovered', 'prepared', 'timeout', 'type', 'id',
        'documentId', 'openRequest', 'requestId', 'revision', 'confirmedRevision', 'reason', 'origin', 'code',
        'restoreDirty', 'restoreRevision', 'restoreConfirmedRevision', 'restorePaused',
        'confirmedRevision', 'success'];
      return Object.fromEntries(keys.filter(key => value[key] !== undefined)
        .map(key => [key, value[key]]));
    };
    const saveMethod = (object, name) => {
      const original = object?.[name];
      if (typeof original !== 'function') return null;
      const descriptor = Object.getOwnPropertyDescriptor(object, name) || null;
      originals.push({ object, name, descriptor });
      return original;
    };
    const wrap = (object, name, before, after) => {
      const original = saveMethod(object, name);
      if (!original) return;
      object[name] = function(...args) {
        const entry = { at: new Date().toISOString(), ...before.call(this, args) };
        void publish();
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          entry.error = error?.stack || String(error);
          throw error;
        }
        const finish = value => {
          if (after) after.call(this, entry, value, args);
          void publish();
          return value;
        };
        if (result && typeof result.then === 'function') {
          return result.then(finish, error => {
            entry.error = error?.stack || String(error);
            throw error;
          });
        }
        return finish(result);
      };
    };
    const iframeLoadListener = () => {
      const snapshot = state();
      const loadEntry = { at: new Date().toISOString(), ...snapshot };
      trace.iframeLoadEvents.push(loadEntry);
      const child = target.iframe?.contentWindow;
      if (child && child.__nativeLifecycleDiagnosticMonitor !== ${JSON.stringify(monitorId)}) {
        try {
          Object.defineProperty(child, '__nativeLifecycleDiagnosticMonitor', {
            value: ${JSON.stringify(monitorId)}, configurable: true,
          });
          const onChildError = event => {
            trace.childErrors.push({
              at: new Date().toISOString(),
              type: 'error',
              message: event?.message || null,
              filename: event?.filename || null,
              line: event?.lineno ?? null,
              column: event?.colno ?? null,
              stack: event?.error?.stack || null,
            });
            void publishNow();
          };
          const onChildRejection = event => {
            trace.childErrors.push({
              at: new Date().toISOString(),
              type: 'unhandledrejection',
              reason: event?.reason?.stack || String(event?.reason ?? ''),
            });
            void publishNow();
          };
          const onWebViewerLoaded = event => {
            trace.rendererInitialization.push({
              at: new Date().toISOString(),
              type: 'webviewerloaded',
              location: (() => { try { return child.location.href; } catch { return null; } })(),
              detail: event?.detail ?? null,
            });
            void publishNow();
          };
          child.addEventListener('error', onChildError, true);
          child.addEventListener('unhandledrejection', onChildRejection);
          child.addEventListener('webviewerloaded', onWebViewerLoaded);
          restoreActions.push(() => {
            child.removeEventListener('error', onChildError, true);
            child.removeEventListener('unhandledrejection', onChildRejection);
            child.removeEventListener('webviewerloaded', onWebViewerLoaded);
          });
        } catch (error) {
          trace.childErrors.push({ at: new Date().toISOString(), type: 'diagnostic-install', error: error?.stack || String(error) });
        }
      }
      const pdf = child?.PDFViewerApplication;
      const initialization = {
        at: new Date().toISOString(),
        type: 'iframe-load',
        documentReadyState: (() => { try { return child?.document?.readyState || null; } catch { return null; } })(),
        location: (() => { try { return child?.location?.href || null; } catch { return null; } })(),
        pdfViewerApplicationExists: !!pdf,
        pdfViewerInitialized: pdf?.initialized ?? null,
        initializedPromiseState: pdf?.initializedPromise ? 'pending' : 'missing',
        pdfDocumentPresent: !!pdf?.pdfDocument,
        eventBusEvents: (() => { try { return Object.keys(pdf?.eventBus?._listeners || {}); } catch { return []; } })(),
      };
      trace.rendererInitialization.push(initialization);
      if (pdf?.initializedPromise && typeof pdf.initializedPromise.then === 'function') {
        Promise.resolve(pdf.initializedPromise).then(() => {
          initialization.initializedPromiseState = 'fulfilled';
          initialization.pdfViewerInitialized = pdf.initialized ?? null;
          initialization.pdfDocumentPresent = !!pdf.pdfDocument;
          initialization.pdfPageCount = pdf.pdfDocument?.numPages ?? null;
          void publishNow();
        }, error => {
          initialization.initializedPromiseState = 'rejected';
          initialization.initializedPromiseError = error?.stack || String(error);
          void publishNow();
        });
      }
      void publishNow();
    };
    target.iframe?.addEventListener('load', iframeLoadListener);
    restoreActions.push(() => target.iframe?.removeEventListener('load', iframeLoadListener));
    const messageSummary = message => {
      if (typeof message === 'string') {
        try { message = JSON.parse(message); } catch { return { rawType: 'string' }; }
      }
      if (!message || typeof message !== 'object') return { rawType: typeof message };
      return summarized(message);
    };

    wrap(target, 'restartViewerAfterPopoutMove', function(args) {
      const checkpoint = args[0];
      const transaction = args[1];
      const entry = {
        at: new Date().toISOString(),
        checkpoint: summarizeRenderer(checkpoint),
        transaction: transaction ? {
          documentId: transaction.documentId || null,
          openRequest: transaction.openRequest ?? null,
        } : null,
        beforeState: state(),
      };
      trace.rendererRestartCalls.push(entry);
      return { diagnosticEntry: entry };
    }, function(entry, value) {
      const record = entry.diagnosticEntry;
      record.result = value === true;
      record.afterState = state();
      record.completedAt = new Date().toISOString();
    });

    wrap(target, 'onClose', function(args) {
      const entry = { ...state(), argumentFilePath: args[0]?.path || null };
      trace.onCloseEntries.push(entry);
      return { diagnosticEntryIndex: trace.onCloseEntries.length - 1 };
    }, function(entry) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.onCloseEntries[index].completedAt = new Date().toISOString();
    });
    wrap(target, 'onUnloadFile', function(args) {
      const entry = { ...state(), argumentFilePath: args[0]?.path || null };
      trace.onUnloadFileEntries.push(entry);
      return { diagnosticEntryIndex: trace.onUnloadFileEntries.length - 1 };
    }, function(entry) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.onUnloadFileEntries[index].completedAt = new Date().toISOString();
    });
    wrap(target, 'onMessage', function(args) {
      const event = args[0];
      const entry = {
        ...state(),
        direction: 'viewer-to-host',
        sourceMatchesCurrentIframe: !!target.iframe && event?.source === target.iframe.contentWindow,
        ...messageSummary(event?.data),
      };
      trace.viewerMessages.push(entry);
      return { diagnosticEntryIndex: trace.viewerMessages.length - 1 };
    }, function(entry) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.viewerMessages[index].completedAt = new Date().toISOString();
    });
    wrap(target, 'postToViewer', function(args) {
      const entry = {
        ...state(),
        direction: 'host-to-viewer',
        ...messageSummary(args[0]),
      };
      trace.hostMessages.push(entry);
      return { diagnosticEntryIndex: trace.hostMessages.length - 1 };
    }, function(entry, value) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.hostMessages[index].accepted = Boolean(value);
      trace.hostMessages[index].completedAt = new Date().toISOString();
    });
    wrap(target, 'sendPendingDocument', function() {
      const pending = this.pendingOpenState;
      const entry = {
        at: new Date().toISOString(),
        ...state(),
        ready: !!this.ready,
        eligible: !!this.ready && !!(pending?.bytes || this.pendingBytes || this.originalBytes),
        restoreDirty: pending?.restoreDirty === true,
        restorePaused: pending?.restorePaused === true,
        revision: pending?.revision ?? this.currentRevision ?? null,
        confirmedRevision: pending?.confirmedRevision ?? this.confirmedRevision ?? null,
      };
      trace.openCalls.push(entry);
      return { diagnosticEntryIndex: trace.openCalls.length - 1 };
    }, function(entry) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.openCalls[index].sent = this.pendingOpenState?.sent === true;
      trace.openCalls[index].openRequest = this.openRequest;
      trace.openCalls[index].sentAt = new Date().toISOString();
    });
    wrap(target, 'flushDocument', function() {
      const entry = { ...state() };
      trace.flushCalls.push(entry);
      return { diagnosticEntryIndex: trace.flushCalls.length - 1 };
    }, function(entry, value) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.flushCalls[index].result = summarized(value);
      trace.flushCalls[index].completedAt = new Date().toISOString();
    });
    wrap(target, 'recoverFile', function(args) {
      const entry = {
        ...state(),
        documentId: args[1] || null,
        requestId: args[2] || null,
        revision: Number.isSafeInteger(args[3]) ? args[3] : null,
        reason: args[4] || null,
      };
      trace.recoverCalls.push(entry);
      return { diagnosticEntryIndex: trace.recoverCalls.length - 1 };
    }, function(entry, value) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.recoverCalls[index].result = summarized(value);
      trace.recoverCalls[index].completedAt = new Date().toISOString();
    });
    wrap(leaf, 'detach', function(args) {
      const entry = { ...state(), argumentCount: args.length };
      trace.detachCalls.push(entry);
      return { diagnosticEntryIndex: trace.detachCalls.length - 1 };
    }, function(entry, value) {
      const index = entry.diagnosticEntryIndex;
      delete entry.diagnosticEntryIndex;
      trace.detachCalls[index].result = summarized(value);
      trace.detachCalls[index].after = state();
      trace.detachCalls[index].completedAt = new Date().toISOString();
    });

    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const routing = plugin?.pdfOpenRouting;
    const originalSdkDetach = routing?.originalDetach;
    if (!originalSdkDetach || typeof plugin?.listRecoveryCandidates !== 'function') {
      throw new Error('Close diagnostics require the candidate detach-preflight routing hook.');
    }
    const originalDetachDescriptor = Object.getOwnPropertyDescriptor(routing, 'originalDetach') || null;
    const routingPatchRegistry = routing[${JSON.stringify(closeRoutingDiagnosticRegistryKey)}] ||= {};
    if (routingPatchRegistry[${JSON.stringify(monitorId)}]) {
      throw new Error('This exact SDK detach diagnostic patch is already registered.');
    }
    const originalDetachWrapper = async function(...args) {
      const receiverView = this?.view || null;
      trace.routingDetachInvocations.push({
        at: new Date().toISOString(),
        receiverMatchesTargetLeaf: this === leaf,
        receiverLeafId: this?.id || null,
        receiverDocumentId: receiverView?.documentId || null,
        receiverPath: receiverView?.requestedPath || receiverView?.file?.path || null,
        receiverOpenRequest: receiverView?.openRequest ?? null,
      });
      if (this !== leaf) return originalSdkDetach.apply(this, args);
      const entry = {
        at: new Date().toISOString(),
        beforeRecoveryRead: state(),
        recoveryReadStartedAt: new Date().toISOString(),
      };
      trace.originalDetachEntries.push(entry);
      try {
        const candidates = await plugin.listRecoveryCandidates();
        entry.recoveryReadCompletedAt = new Date().toISOString();
        entry.preDetachState = state();
        entry.preDetachRecoveryCandidates = candidates
          .filter(candidate => candidate.metadata?.documentId === target.documentId)
          .map(candidate => ({
            candidateId: candidate.metadata.candidateId || null,
            documentId: candidate.metadata.documentId || null,
            originalPath: candidate.metadata.originalPath || null,
            origin: candidate.metadata.origin || null,
            reason: candidate.metadata.reason || null,
            status: candidate.metadata.status || null,
            requestId: candidate.metadata.requestId || null,
            revision: candidate.metadata.revision ?? null,
            openRequest: candidate.metadata.openRequest ?? null,
            candidatePath: candidate.candidatePath || null,
          }));
        entry.sdkDetachStartedAt = new Date().toISOString();
        await publishNow();
        const result = await originalSdkDetach.apply(this, args);
        entry.result = summarized(result);
        entry.afterSdkDetach = state();
        entry.completedAt = new Date().toISOString();
        await publishNow();
        return result;
      } catch (error) {
        entry.error = error?.stack || String(error);
        await publishNow();
        throw error;
      }
    };
    routingPatchRegistry[${JSON.stringify(monitorId)}] = {
      original: originalSdkDetach,
      wrapper: originalDetachWrapper,
      descriptor: originalDetachDescriptor,
    };
    routing.originalDetach = originalDetachWrapper;

    const restoreRoutingDetachDiagnostic = () => {
      const registry = routing[${JSON.stringify(closeRoutingDiagnosticRegistryKey)}];
      const patch = registry?.[${JSON.stringify(monitorId)}];
      if (!patch) return false;
      if (routing.originalDetach === patch.wrapper) {
        if (patch.descriptor) {
          Object.defineProperty(routing, 'originalDetach', patch.descriptor);
        } else {
          delete routing.originalDetach;
        }
      }
      delete registry[${JSON.stringify(monitorId)}];
      if (Object.keys(registry).length === 0) {
        delete routing[${JSON.stringify(closeRoutingDiagnosticRegistryKey)}];
      }
      return true;
    };

    registry[${JSON.stringify(monitorId)}] = {
      trace,
      restore() {
        for (const action of restoreActions.reverse()) {
          try { action(); } catch {}
        }
        for (const item of originals.reverse()) {
          if (item.object === routing && item.name === 'originalDetach') continue;
          if (item.descriptor) Object.defineProperty(item.object, item.name, item.descriptor);
          else delete item.object[item.name];
        }
        restoreRoutingDetachDiagnostic();
        delete registry[${JSON.stringify(monitorId)}];
        if (Object.keys(registry).length === 0) delete window[registryKey];
      },
    };
    return JSON.stringify({ installed: true, label: trace.label, path: trace.path, leafId: trace.leafId });
  })()`);
  return {
    page: view.page,
    monitorId,
    label,
    path: view.path,
    leafId: view.leafId,
    traceSnapshot,
  };
}

async function readCloseDiagnostics(monitor) {
  if (!isLivePageTarget(monitor.page)) return monitor.traceSnapshot?.value || null;
  try {
    const current = await evaluateJson(monitor.page, `JSON.stringify(
      window[${JSON.stringify(closeMonitorRegistryKey)}]?.[${JSON.stringify(monitor.monitorId)}]?.trace || null
    )`);
    return current || monitor.traceSnapshot?.value || null;
  } catch (error) {
    if (!isLivePageTarget(monitor.page)) return monitor.traceSnapshot?.value || null;
    throw error;
  }
}

async function restoreCloseDiagnostics(monitor) {
  if (!monitor) return;
  let restoredInOwnerWindow = false;
  if (isLivePageTarget(monitor.page)) {
    try {
      await evaluate(monitor.page, `(() => {
        const entry = window[${JSON.stringify(closeMonitorRegistryKey)}]?.[${JSON.stringify(monitor.monitorId)}];
        if (entry) entry.restore();
        return true;
      })()`);
      restoredInOwnerWindow = true;
    } catch (error) {
      if (isLivePageTarget(monitor.page)) throw error;
    }
  }
  if (!primaryPage || primaryPage.isClosed()) return;
  const cleanup = await evaluateJson(primaryPage, `JSON.stringify((() => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const routing = plugin?.pdfOpenRouting;
    const key = ${JSON.stringify(closeRoutingDiagnosticRegistryKey)};
    const registry = routing?.[key];
    const patch = registry?.[${JSON.stringify(monitor.monitorId)}];
    if (!patch) return { found: false, restoredInOwnerWindow: ${JSON.stringify(restoredInOwnerWindow)} };
    if (routing.originalDetach === patch.wrapper) {
      if (patch.descriptor) Object.defineProperty(routing, 'originalDetach', patch.descriptor);
      else delete routing.originalDetach;
    }
    delete registry[${JSON.stringify(monitor.monitorId)}];
    if (Object.keys(registry).length === 0) delete routing[key];
    return {
      found: true,
      restoredInOwnerWindow: ${JSON.stringify(restoredInOwnerWindow)},
      restoredExactSavedFunction: routing.originalDetach === patch.original,
      diagnosticRegistryRemaining: Object.keys(routing[key] || {}).length,
    };
  })())`);
  if (cleanup.found && cleanup.restoredExactSavedFunction !== true) {
    throw new Error(
      `Could not restore the exact saved shared SDK detach function for close monitor ${monitor.monitorId}: ${JSON.stringify(cleanup)}`,
    );
  }
  if ((cleanup.diagnosticRegistryRemaining || 0) > 0) {
    throw new Error(
      `Close diagnostic routing registry leaked after ${monitor.monitorId}: ${JSON.stringify(cleanup)}`,
    );
  }
  report.checks.closeDiagnosticRoutingCleanup ??= [];
  report.checks.closeDiagnosticRoutingCleanup.push({
    monitorId: monitor.monitorId,
    label: monitor.label,
    ownerPageClosed: !isLivePageTarget(monitor.page),
    ...cleanup,
  });
}

function assertPreparedCloseBeforeOriginalDetach(
  trace,
  { documentId, path: expectedPath, recoveryReason = null },
) {
  assert.ok(trace, "The close lifecycle trace must be available.");
  const detach = trace.originalDetachEntries?.find((entry) =>
    entry.preDetachState?.documentId === documentId ||
    entry.beforeRecoveryRead?.documentId === documentId,
  );
  assert.ok(detach, "The plugin must call the original SDK detach only after close preparation succeeds.");
  assert.equal(trace.originalDetachEntries.filter((entry) =>
    entry.preDetachState?.documentId === documentId ||
    entry.beforeRecoveryRead?.documentId === documentId,
  ).length, 1, "The owned Reader must cross the original SDK detach boundary exactly once.");
  const preDetachState = detach.preDetachState;
  assert.ok(preDetachState, "The test must capture state immediately before the SDK detach.");
  assert.equal(preDetachState.iframeIsConnected, true,
    "The Reader iframe must remain connected until close preparation is acknowledged.");
  assert.equal(preDetachState.filePath, expectedPath);
  assert.equal(preDetachState.requestedPath, expectedPath);

  const prepare = trace.hostMessages?.find((message) =>
    message.type === "prepare-close" && message.documentId === documentId,
  );
  assert.ok(prepare, "The host must send a prepare-close request for the owned document.");
  assert.equal(prepare.openRequest, preDetachState.openRequest);
  const prepared = trace.viewerMessages?.find((message) =>
    message.type === "close-prepared" &&
    message.documentId === documentId &&
    message.openRequest === prepare.openRequest &&
    message.id === prepare.id,
  );
  assert.ok(prepared, "The host must receive the matching close-prepared acknowledgement.");
  assert.equal(prepared.prepared, true,
    "The viewer must acknowledge an accepted close preparation before original detach.");
  assert.ok(Number.isSafeInteger(prepared.revision) && prepared.revision >= 0);
  assert.ok(Date.parse(prepared.completedAt) <= Date.parse(detach.sdkDetachStartedAt),
    "The matching close-prepared acknowledgement must arrive before the original SDK detach begins.");

  if (recoveryReason) {
    assert.equal(prepared.recovered, true,
      "A dirty autosave-disabled or conflict-paused close must be recovery-acknowledged.");
    const recovery = trace.viewerMessages?.find((message) =>
      message.type === "recover" &&
      message.documentId === documentId &&
      message.reason === recoveryReason &&
      message.revision === prepared.revision,
    );
    assert.ok(recovery, "The viewer must request recovery for the prepared dirty revision.");
    const recoveryCall = trace.recoverCalls?.find((message) =>
      message.documentId === documentId &&
      message.reason === recoveryReason &&
      message.requestId === recovery.requestId &&
      message.revision === prepared.revision,
    );
    assert.ok(recoveryCall, "The host must receive and handle the matching recovery request.");
    const recoveredAck = trace.hostMessages?.find((message) =>
      message.type === "recovered" &&
      message.documentId === documentId &&
      message.requestId === recovery.requestId &&
      message.revision === prepared.revision,
    );
    assert.ok(recoveredAck, "The host must acknowledge the exact durable recovery request to the viewer.");
    assert.ok(Date.parse(recoveredAck.completedAt) <= Date.parse(prepared.completedAt),
      "The host recovery acknowledgement must precede close-prepared.");
    const candidate = detach.preDetachRecoveryCandidates?.find((metadata) =>
      metadata.documentId === documentId &&
      metadata.originalPath === expectedPath &&
      metadata.origin === "recovery" &&
      metadata.reason === recoveryReason &&
      metadata.status === "draft" &&
      metadata.requestId === recovery.requestId &&
      metadata.revision === prepared.revision,
    );
    assert.ok(candidate,
      "The exact dirty recovery draft must exist before the original PDF view is detached.");
    return { prepare, prepared, detach, candidate };
  }

  assert.equal(prepared.ok, true);
  assert.equal(prepared.dirty, false);
  assert.equal(prepared.recovered, false);
  return { prepare, prepared, detach };
}

async function installWritePatch(page, relativePath, mode) {
  assertOwnedPath(relativePath);
  assert.ok(["delay-first", "fail-first"].includes(mode));
  await evaluate(page, `(() => {
    if (window.__nativeLifecycleWritePatch) throw new Error('A lifecycle write patch is already installed.');
    const original = app.vault.modifyBinary;
    const state = { path: ${JSON.stringify(relativePath)}, mode: ${JSON.stringify(mode)},
      entered: false, calls: 0, release: null, original };
    app.vault.modifyBinary = async function(file, data) {
      if (file?.path === state.path) {
        state.calls += 1;
        if (state.mode === 'delay-first' && state.calls === 1) {
          state.entered = true;
          await new Promise(resolve => { state.release = resolve; });
        }
        if (state.mode === 'fail-first' && state.calls === 1) {
          state.entered = true;
          throw new Error('native lifecycle test injected one write failure');
        }
      }
      return original.call(this, file, data);
    };
    window.__nativeLifecycleWritePatch = state;
    return true;
  })()`);
}

async function writePatchState(page) {
  return evaluateJson(page, `JSON.stringify(window.__nativeLifecycleWritePatch
    ? { path: window.__nativeLifecycleWritePatch.path,
        mode: window.__nativeLifecycleWritePatch.mode,
        entered: window.__nativeLifecycleWritePatch.entered,
        calls: window.__nativeLifecycleWritePatch.calls }
    : null)`);
}

async function releaseWritePatch(page, { restore = false } = {}) {
  await evaluate(page, `(() => {
    const state = window.__nativeLifecycleWritePatch;
    if (!state) return true;
    state.release?.();
    if (${JSON.stringify(restore)}) {
      app.vault.modifyBinary = state.original;
      delete window.__nativeLifecycleWritePatch;
    }
    return true;
  })()`);
}

async function installRecoveryDirectoryWriteFault(view) {
  return evaluateJson(view.page, `(async () => {
    if (window.__nativeLifecycleRecoveryWriteFault) {
      throw new Error('A recovery-directory write fault is already installed.');
    }
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const adapter = app.vault.adapter;
    const root = plugin?.recoveryDirectory;
    if (typeof root !== 'string' || !root) {
      throw new Error('The plugin recovery directory is unavailable.');
    }
    const documentId = ${JSON.stringify(view.documentId)};
    const existing = await plugin.listRecoveryCandidates();
    if (existing.some(candidate => candidate.metadata?.documentId === documentId)) {
      throw new Error('The owned close-failure document already has a recovery candidate.');
    }
    const candidatePrefix = root + '/' + documentId.replace(/[^a-zA-Z0-9_-]/g, '') + '-';
    const descriptor = Object.getOwnPropertyDescriptor(adapter, 'writeBinary') || null;
    const original = adapter.writeBinary;
    if (typeof original !== 'function') throw new Error('Vault adapter writeBinary is unavailable.');
    const state = { root, candidatePrefix, documentId, calls: 0,
      path: null, error: null, original, descriptor };
    adapter.writeBinary = async function(filePath, data) {
      if (state.calls === 0 && typeof filePath === 'string' &&
          filePath.startsWith(state.candidatePrefix) && filePath.toLowerCase().endsWith('.pdf')) {
        state.calls += 1;
        state.path = filePath;
        state.error = 'native lifecycle test injected one recovery PDF write failure';
        throw new Error(state.error);
      }
      return original.call(this, filePath, data);
    };
    window.__nativeLifecycleRecoveryWriteFault = state;
    return JSON.stringify({ root, candidatePrefix, documentId: state.documentId, calls: state.calls,
      faultScope: 'one PDF candidate for the current test document under plugin recoveryDirectory' });
  })()`);
}

async function recoveryDirectoryWriteFaultState(page, { restore = false } = {}) {
  return evaluateJson(page, `(async () => {
    const state = window.__nativeLifecycleRecoveryWriteFault;
    if (!state) return JSON.stringify({ installed: false });
    const result = { installed: true, root: state.root, documentId: state.documentId,
      candidatePrefix: state.candidatePrefix, calls: state.calls, path: state.path, error: state.error,
      faultScope: 'one PDF candidate for the current test document under plugin recoveryDirectory' };
    if (${JSON.stringify(restore)}) {
      if (state.descriptor) Object.defineProperty(app.vault.adapter, 'writeBinary', state.descriptor);
      else delete app.vault.adapter.writeBinary;
      delete window.__nativeLifecycleRecoveryWriteFault;
      result.restored = true;
    }
    return JSON.stringify(result);
  })()`);
}

async function recoveryCandidates(page) {
  return evaluateJson(page, `(async () => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    return JSON.stringify(await plugin.listRecoveryCandidates());
  })()`);
}

async function testAutosaveSettingAndManualShortcut() {
  const relativePath = testPath("autosave-disabled-square");
  report.testFiles.push(relativePath);
  const beforeHash = await fileHash(relativePath);
  const off = await setAutoSave(primaryPage, false);
  const view = await openReader(primaryPage, relativePath);
  await addAnnotation(view, 5);
  await wait(1_700);
  assert.equal(
    await fileHash(relativePath),
    beforeHash,
    "With autosave disabled, the edited PDF must remain unchanged until Cmd+S.",
  );
  const dirty = await evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const pdf = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication;
    return { modified: !!pdf?._annotationStorageModified,
      mode: pdf?.pdfViewer?.annotationEditorMode ?? null };
  })())`);
  assert.equal(dirty.modified, true, "The disabled-autosave fixture should retain its pending edit.");
  await dispatchMacSave(view);
  await waitForSaved(view, relativePath, beforeHash, "Mac Cmd+S to save the autosave-disabled fixture");
  const reopened = await reopenPdf(view);
  assert.ok(reopened.subtypes.includes("Square"));
  report.checks.autoSaveOffAndCmdS = {
    persisted: off,
    diskUnchangedBeforeCmdS: true,
    reopenedSubtypes: reopened.subtypes,
    modifier: "Meta/Cmd (CDP modifiers=4)",
  };
  await detachOwnedView(view);
  await setAutoSave(primaryPage, true);
}

async function testAutosaveSquareAndInk() {
  const results = [];
  for (const [name, mode] of [["autosave-square", 5], ["autosave-ink", 15]]) {
    const relativePath = testPath(name);
    report.testFiles.push(relativePath);
    const beforeHash = await fileHash(relativePath);
    const view = await openReader(primaryPage, relativePath);
    await addAnnotation(view, mode);
    const saved = await waitForSaved(view, relativePath, beforeHash, `idle autosave of ${name}`);
    const reopened = await reopenPdf(view);
    const subtype = mode === 5 ? "Square" : "Ink";
    assert.ok(reopened.subtypes.includes(subtype), `${subtype} was not serialized into the saved PDF.`);
    results.push({ path: relativePath, hash: saved.hash, subtype, reopened: reopened.subtypes });
    await detachOwnedView(view);
  }
  report.checks.squareAndInkAutosave = results;
}

async function testEditDuringInflightSave() {
  const relativePath = testPath("autosave-inflight-square-then-ink");
  report.testFiles.push(relativePath);
  await setAutoSave(primaryPage, true);
  const beforeHash = await fileHash(relativePath);
  const view = await openReader(primaryPage, relativePath);
  await installWritePatch(view.page, relativePath, "delay-first");
  let released = false;
  try {
    await addAnnotation(view, 5);
    await waitFor(
      "first host write to block while autosave is in flight",
      async () => writePatchState(view.page),
      (state) => state?.entered === true && state.calls === 1,
      60_000,
    );
    await addAnnotation(view, 15);
    assert.deepEqual(await editorTypes(view), [5, 15]);
  } finally {
    await releaseWritePatch(view.page);
    released = true;
  }
  assert.equal(released, true);
  const completed = await waitFor(
    "queued follow-up save for an edit made during an in-flight write",
    async () => writePatchState(view.page),
    (state) => state?.calls >= 2,
    60_000,
  );
    const saved = await waitForSaved(view, relativePath, beforeHash, "both revisions to reach the vault");
    const reopened = await reopenPdf(view);
    assert.ok(reopened.subtypes.includes("Square"));
    assert.ok(reopened.subtypes.includes("Ink"));
    report.checks.editDuringInflightSave = {
      writeCalls: completed.calls,
      savedHash: saved.hash,
      reopenedSubtypes: reopened.subtypes,
    };
  await releaseWritePatch(view.page, { restore: true });
  await detachOwnedView(view);
}

async function testRenameDuringPendingAutosave() {
  const sourcePath = testPath("rename-source");
  const targetPath = testPath("rename-moved");
  report.testFiles.push(sourcePath, targetPath);
  const beforeHash = await fileHash(sourcePath);
  await setAutoSave(primaryPage, false);
  const view = await openReader(primaryPage, sourcePath);
  const originalDocumentId = view.documentId;
  await addAnnotation(view, 5);
  await wait(1_700);
  assert.equal(await fileHash(sourcePath), beforeHash,
    "The rename fixture must still be dirty and unsaved when it is moved.");
  const renamed = await evaluateJson(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const file = leaf?.view?.file;
    if (!file || file.path !== ${JSON.stringify(sourcePath)}) throw new Error('Rename source identity changed unexpectedly.');
    await app.vault.rename(file, ${JSON.stringify(targetPath)});
    const renamedFile = app.vault.getAbstractFileByPath(${JSON.stringify(targetPath)});
    if (!renamedFile) throw new Error('Renamed test PDF is not present at its target path.');
    await new Promise(resolve => setTimeout(resolve, 50));
    return JSON.stringify({
      path: renamedFile.path,
      documentId: leaf.view.documentId,
      requestedPath: leaf.view.requestedPath,
      documentPath: leaf.view.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument?.fingerprints?.join(':') || null,
    });
  })()`);
  assert.equal(renamed.path, targetPath);
  assert.equal(renamed.documentId, originalDocumentId, "Rename should preserve the active document identity.");
  await waitFor(
    "host view to follow the renamed test PDF",
    async () => oneView(targetPath, view.leafId),
    (current) => current.path === targetPath && current.documentId === originalDocumentId,
  );
  const movedView = { ...view, path: targetPath };
  await setAutoSave(primaryPage, true);
  const saved = await waitForSaved(movedView, targetPath, beforeHash, "autosave to follow the renamed document");
  assert.equal(
    await readFile(absolute(sourcePath)).then(() => true, () => false),
    false,
    "The pre-rename path must no longer exist.",
  );
  const reopened = await reopenPdf(movedView);
  assert.ok(reopened.subtypes.includes("Square"));
  report.checks.renameKeepsIdentityAndSaves = {
    oldPath: sourcePath,
    newPath: targetPath,
    documentId: originalDocumentId,
    savedHash: saved.hash,
    reopenedSubtypes: reopened.subtypes,
  };
  await detachOwnedView(movedView);
}

async function testSamePdfStaleViewConflict() {
  const relativePath = testPath("same-pdf-two-views");
  const recoveredPath = testPath("same-pdf-stale-recovery-copy");
  report.testFiles.push(relativePath, recoveredPath);
  const beforeHash = await fileHash(relativePath);
  await setAutoSave(primaryPage, false);
  const first = await openReader(primaryPage, relativePath);
  const second = await openReader(first.page, relativePath, { duplicate: true });
  const all = await waitFor(
    "two independent Reader views of the same test PDF",
    async () => viewsFor(relativePath),
    (views) => views.length === 2 && new Set(views.map((view) => view.documentId)).size === 2,
  );
  assert.ok(all.some((view) => view.leafId === first.leafId));
  assert.ok(all.some((view) => view.leafId === second.leafId));
  const firstView = all.find((view) => view.leafId === first.leafId);
  const secondView = all.find((view) => view.leafId === second.leafId);
  await addAnnotation(firstView, 5);
  await addAnnotation(secondView, 15, null, { commitMode: 0 });

  await dispatchMacSave(firstView);
  const firstSaved = await waitForSaved(firstView, relativePath, beforeHash, "first of two same-PDF views to save");
  const afterFirstHash = firstSaved.hash;
  await dispatchMacSave(secondView);
  const candidate = await waitFor(
    "stale same-PDF view to be rejected with a conflict recovery candidate",
    async () => {
      const candidates = await recoveryCandidates(secondView.page);
      return candidates.find((item) => item.metadata.documentId === secondView.documentId) || null;
    },
    (item) => item?.metadata.status === "conflict",
    60_000,
  );
  const afterConflictHash = await fileHash(relativePath);
  assert.equal(afterConflictHash, afterFirstHash, "The stale view must not overwrite the first view's successful save.");
  assert.equal(candidate.metadata.originalPath, relativePath);
  assert.equal(candidate.metadata.status, "conflict");
  const candidateBytes = await readFile(absolute(candidate.candidatePath));
  assert.ok(candidateBytes.byteLength > 0);
  const latest = await recoveryCandidates(secondView.page);
  assert.equal(latest[0]?.metadata.candidateId, candidate.metadata.candidateId,
    "The stale-view conflict must be the newest recovery candidate before restore.");
  const restoredPath = await evaluateJson(secondView.page, `(async () => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    return JSON.stringify(await plugin.restoreLatestRecovery());
  })()`);
  assert.ok(typeof restoredPath === "string" && restoredPath.startsWith("PDF Recovery/"));
  const restoredBytes = await readFile(absolute(restoredPath));
  assert.deepEqual(restoredBytes, candidateBytes,
    "Restoring the stale-view recovery candidate must preserve its PDF bytes.");
  await evaluate(secondView.page, `(async () => {
    const output = app.vault.getAbstractFileByPath(${JSON.stringify(restoredPath)});
    if (!output) throw new Error('Stale-view recovery output disappeared.');
    await app.vault.rename(output, ${JSON.stringify(recoveredPath)});
    return true;
  })()`);
  const recoveredView = await openReader(primaryPage, recoveredPath);
  const recoveredPdf = await inspectPdf(recoveredView);
  assert.ok(recoveredPdf.subtypes.includes("Ink"),
    "The rejected second view's Ink edit must be recoverable from its candidate copy.");
  await detachOwnedView(recoveredView);
  report.checks.samePdfStaleWriteRejected = {
    path: relativePath,
    firstDocumentId: firstView.documentId,
    staleDocumentId: secondView.documentId,
    firstSavedHash: afterFirstHash,
    hashUnchangedAfterRejectedWrite: afterConflictHash,
    recoveryStatus: candidate.metadata.status,
    recoveryBytes: candidateBytes.byteLength,
    restoredCopy: recoveredPath,
    restoredSubtypes: recoveredPdf.subtypes,
  };
  const closeMonitor = await installCloseDiagnostics(
    secondView,
    "same-pdf-conflict-paused-close",
  );
  const closeRecovery = report.checks.samePdfStaleWriteRejected.closedDirtyRecovery = {
    status: "pending",
    sourceHashUnchanged: null,
    closeLifecycle: null,
  };
  try {
    await detachOwnedView(secondView, { allowDirty: true });
    closeRecovery.closeLifecycle = await readCloseDiagnostics(closeMonitor);
    closeRecovery.closePreparation = assertPreparedCloseBeforeOriginalDetach(
      closeRecovery.closeLifecycle,
      { documentId: secondView.documentId, path: relativePath, recoveryReason: "save-conflict" },
    );
    const pausedCloseCandidate = await waitFor(
      "conflict-paused dirty view to create a close recovery draft",
      async () => {
        const candidates = await recoveryCandidates(primaryPage);
        return candidates.find((item) =>
          item.metadata.documentId === secondView.documentId &&
          item.metadata.originalPath === relativePath &&
          item.metadata.origin === "recovery" &&
          item.metadata.reason === "save-conflict" &&
          item.metadata.status === "draft",
        ) || null;
      },
      Boolean,
      60_000,
    );
    const pausedCloseBytes = await readFile(absolute(pausedCloseCandidate.candidatePath));
    assert.ok(pausedCloseBytes.byteLength > 0);
    closeRecovery.status = "passed";
    closeRecovery.reason = pausedCloseCandidate.metadata.reason;
    closeRecovery.candidateBytes = pausedCloseBytes.byteLength;
    closeRecovery.candidateId = pausedCloseCandidate.metadata.candidateId;
    assert.equal(await fileHash(relativePath), afterFirstHash,
      "Closing the paused stale view must leave the successfully saved original unchanged.");
    closeRecovery.sourceHashUnchanged = true;
  } finally {
    try {
      closeRecovery.closeLifecycle = await readCloseDiagnostics(closeMonitor);
    } catch (error) {
      closeRecovery.closeDiagnosticsError = error?.stack || String(error);
    }
    await restoreCloseDiagnostics(closeMonitor).catch((error) => {
      closeRecovery.restoreError = error?.stack || String(error);
    });
  }
  const savedFirst = await reopenPdf(firstView);
  assert.ok(savedFirst.subtypes.includes("Square"));
  assert.ok(!savedFirst.subtypes.includes("Ink"), "The stale view's Ink edit must not replace the successful Square save.");
  await detachOwnedView(firstView);
  await setAutoSave(primaryPage, true);
}

async function testExternalBytesConflict() {
  const relativePath = testPath("external-bytes-conflict");
  report.testFiles.push(relativePath);
  const original = await readFile(absolute(relativePath));
  const beforeHash = sha256(original);
  await setAutoSave(primaryPage, false);
  const view = await openReader(primaryPage, relativePath);
  await addAnnotation(view, 5);
  const external = Buffer.concat([original, Buffer.from(`\nexternal-change-${stamp}`, "utf8")]);
  await writeFile(absolute(relativePath), external);
  await setAutoSave(primaryPage, true);
  const candidate = await waitFor(
    "external bytes conflict recovery candidate",
    async () => {
      const candidates = await recoveryCandidates(view.page);
      return candidates.find((item) => item.metadata.documentId === view.documentId) || null;
    },
    (item) => item?.metadata.status === "conflict",
    60_000,
  );
  assert.equal(await fileHash(relativePath), sha256(external), "The autosave must preserve externally changed bytes.");
  await writeFile(absolute(relativePath), original);
  await dispatchMacSave(view);
  await waitForSaved(view, relativePath, beforeHash, "manual retry after restoring the exact fixture baseline");
  const reopened = await reopenPdf(view);
  assert.ok(reopened.subtypes.includes("Square"));
  report.checks.externalBytesConflict = {
    path: relativePath,
    externalHash: sha256(external),
    candidateStatus: candidate.metadata.status,
    finalSubtypes: reopened.subtypes,
  };
  await detachOwnedView(view);
}

async function testFailedSaveRecoveryCommand() {
  const relativePath = testPath("write-failure-recovery-source");
  const recoveredPath = testPath("write-failure-recovery-copy");
  report.testFiles.push(relativePath, recoveredPath);
  const beforeHash = await fileHash(relativePath);
  await setAutoSave(primaryPage, false);
  const view = await openReader(primaryPage, relativePath);
  await addAnnotation(view, 5);
  await installWritePatch(view.page, relativePath, "fail-first");
  await setAutoSave(primaryPage, true);
  let candidate;
  try {
    candidate = await waitFor(
      "one native host save failure and retained candidate",
      async () => {
        const state = await writePatchState(view.page);
        const candidates = await recoveryCandidates(view.page);
        const match = candidates.find((item) => item.metadata.documentId === view.documentId) || null;
        return { state, candidate: match };
      },
      (outcome) => outcome.state?.entered && outcome.candidate?.metadata.status === "failed",
      60_000,
    ).then((outcome) => outcome.candidate);
    assert.equal(candidate.metadata.originalPath, relativePath);
    assert.equal(await fileHash(relativePath), beforeHash, "A failed write must leave the source PDF untouched.");
    const retained = await readFile(absolute(candidate.candidatePath));
    assert.ok(retained.byteLength > 0);

    const latest = await recoveryCandidates(view.page);
    assert.equal(latest[0]?.metadata.candidateId, candidate.metadata.candidateId,
      "The failed test candidate must be the latest recovery item before invoking the command.");
    const restorePath = await evaluateJson(view.page, `(async () => {
      const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
      const output = await plugin.restoreLatestRecovery();
      return JSON.stringify(output);
    })()`);
    assert.equal(typeof restorePath, "string");
    assert.ok(restorePath.startsWith("PDF Recovery/"));
    const restoredBytes = await readFile(absolute(restorePath));
    assert.deepEqual(restoredBytes, retained, "Recovery command output must preserve the retained candidate bytes.");
    await evaluate(view.page, `(async () => {
      const output = app.vault.getAbstractFileByPath(${JSON.stringify(restorePath)});
      if (!output) throw new Error('Recovery command output disappeared.');
      await app.vault.rename(output, ${JSON.stringify(recoveredPath)});
      return true;
    })()`);

    await releaseWritePatch(view.page, { restore: true });
    await dispatchMacSave(view);
    await waitForSaved(view, relativePath, beforeHash, "manual retry after restoring the vault write function");
    const reopened = await reopenPdf(view);
    assert.ok(reopened.subtypes.includes("Square"));
    report.checks.failedSaveRecovery = {
      path: relativePath,
      recoveredCopy: recoveredPath,
      candidateStatus: candidate.metadata.status,
      candidateBytes: retained.byteLength,
      restoredBytes: restoredBytes.byteLength,
      reopenedSubtypes: reopened.subtypes,
    };
  } finally {
    await releaseWritePatch(view.page, { restore: true }).catch(() => {});
  }
  await detachOwnedView(view);
}

async function testCloseFlushAndReopen() {
  const relativePath = testPath("close-flush-reopen");
  report.testFiles.push(relativePath);
  await setAutoSave(primaryPage, true);
  const beforeHash = await fileHash(relativePath);
  const view = await openReader(primaryPage, relativePath);
  await installWritePatch(view.page, relativePath, "delay-first");
  const closeMonitor = await installCloseDiagnostics(view, "inflight-save-close-flush");
  const closeCheck = report.checks.closeFlushAndReopen = {
    path: relativePath,
    beforeHash,
    closeLifecycle: null,
  };
  let detachRequested = false;
  try {
    await addAnnotation(view, 5);
    await waitFor(
      "autosave host write to enter its controlled delay before closing",
      async () => writePatchState(view.page),
      (state) => state?.entered === true && state.calls === 1,
      60_000,
    );
    detachRequested = true;
    await evaluateJson(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
        candidate.view?.requestedPath === ${JSON.stringify(relativePath)});
    if (!leaf) throw new Error('Close-flush test lost its owned tab.');
    void leaf.detach();
    return JSON.stringify({ closing: true });
  })()`);
    await wait(200);
    assert.equal((await viewsFor(relativePath)).some((item) => item.leafId === view.leafId), true,
      "The host must keep the tab alive while its accepted save is still blocked.");
    await releaseWritePatch(view.page);
    await waitFor(
      "dirty owned PDF tab to close after its in-flight lifecycle save completes",
      async () => (await viewsFor(relativePath)).length,
      (count) => count === 0,
      60_000,
    );
    closeCheck.closeLifecycle = await readCloseDiagnostics(closeMonitor);
    closeCheck.closePreparation = assertPreparedCloseBeforeOriginalDetach(
      closeCheck.closeLifecycle,
      { documentId: view.documentId, path: relativePath },
    );
  } finally {
    await releaseWritePatch(view.page, { restore: true }).catch(() => {});
    if (detachRequested) {
      try {
        await waitFor(
          "controlled in-flight close to finish during cleanup",
          async () => (await viewsFor(relativePath)).length,
          (count) => count === 0,
          15_000,
        );
      } catch (error) {
        closeCheck.closeCleanupError = error?.stack || String(error);
      }
    }
    try {
      closeCheck.closeLifecycle = await readCloseDiagnostics(closeMonitor);
    } catch (error) {
      closeCheck.closeDiagnosticsError = error?.stack || String(error);
    }
    await restoreCloseDiagnostics(closeMonitor).catch((error) => {
      closeCheck.restoreError = error?.stack || String(error);
    });
  }
  const afterCloseHash = await waitFor(
    "PDF bytes to change after the Reader close flush completes",
    async () => fileHash(relativePath),
    (hash) => hash !== beforeHash,
    60_000,
  );
  assert.notEqual(afterCloseHash, beforeHash, "Closing the dirty Reader should flush its edit before teardown.");
  const reopenedView = await openReader(primaryPage, relativePath);
  const reopened = await inspectPdf(reopenedView);
  assert.ok(reopened.subtypes.includes("Square"), "Bytes written during close must remain reopenable.");
  Object.assign(closeCheck, {
    path: relativePath,
    beforeHash,
    afterCloseHash,
    blockedWriteCalls: 1,
    waitedForInflightSave: true,
    reopenedSubtypes: reopened.subtypes,
  });
  await detachOwnedView(reopenedView);
}

async function testDisabledAutosaveCloseRecovery() {
  const relativePath = testPath("close-recovery-autosave-disabled");
  const recoveredPath = testPath("close-recovery-autosave-disabled-copy");
  report.testFiles.push(relativePath, recoveredPath);
  const beforeHash = await fileHash(relativePath);
  await setAutoSave(primaryPage, false);
  const view = await openReader(primaryPage, relativePath);
  await addAnnotation(view, 5);
  await wait(1_700);
  assert.equal(
    await fileHash(relativePath),
    beforeHash,
    "A dirty autosave-disabled close fixture must not have written the original PDF.",
  );
  const closeMonitor = await installCloseDiagnostics(view, "autosave-disabled-dirty-close");
  const closeCheck = report.checks.disabledAutosaveCloseRecovery = {
    path: relativePath,
    documentId: view.documentId,
    beforeHash,
    sourceHashUnchanged: null,
    closeLifecycle: null,
  };
  let candidate;
  try {
    await evaluateJson(view.page, `(async () => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
          candidate.view?.requestedPath === ${JSON.stringify(relativePath)});
      if (!leaf) throw new Error('Close-recovery fixture lost its owned Reader tab.');
      await leaf.detach();
      return JSON.stringify({ detached: true });
    })()`);
      await waitFor(
      "dirty autosave-disabled test tab to finish closing",
      async () => (await viewsFor(relativePath)).length,
      (count) => count === 0,
      60_000,
    );

    closeCheck.closeLifecycle = await readCloseDiagnostics(closeMonitor);
    closeCheck.closePreparation = assertPreparedCloseBeforeOriginalDetach(
      closeCheck.closeLifecycle,
      { documentId: view.documentId, path: relativePath, recoveryReason: "auto-save-disabled" },
    );

    candidate = await waitFor(
      "close recovery draft for the autosave-disabled test PDF",
      async () => {
        const candidates = await recoveryCandidates(primaryPage);
        return candidates.find((item) =>
          item.metadata.documentId === view.documentId &&
          item.metadata.originalPath === relativePath &&
          item.metadata.origin === "recovery" &&
          item.metadata.reason === "auto-save-disabled",
        ) || null;
      },
      (item) => item?.metadata.status === "draft",
      60_000,
    );
  } finally {
    try {
      closeCheck.closeLifecycle = await readCloseDiagnostics(closeMonitor);
    } catch (error) {
      closeCheck.closeDiagnosticsError = error?.stack || String(error);
    }
    await restoreCloseDiagnostics(closeMonitor).catch((error) => {
      closeCheck.restoreError = error?.stack || String(error);
    });
  }
  assert.equal(candidate.metadata.status, "draft");
  assert.ok(candidate.metadata.requestId, "Close recovery must be acknowledged against its request id.");
  assert.ok(Number.isSafeInteger(candidate.metadata.revision) && candidate.metadata.revision > 0);
  const candidateBytes = await readFile(absolute(candidate.candidatePath));
  assert.ok(candidateBytes.byteLength > 0);
  assert.equal(
    await fileHash(relativePath),
    beforeHash,
    "Closing with autosave disabled must preserve the original bytes and put edits in the recovery candidate.",
  );

  const restoredPath = await evaluateJson(primaryPage, `(async () => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const output = await plugin.restoreLatestRecovery();
    return JSON.stringify(output);
  })()`);
  assert.equal(typeof restoredPath, "string");
  assert.ok(restoredPath.startsWith("PDF Recovery/"));
  const restoredBytes = await readFile(absolute(restoredPath));
  assert.deepEqual(restoredBytes, candidateBytes, "The recovery command must reproduce the close-time candidate bytes.");
  await evaluate(primaryPage, `(async () => {
    const output = app.vault.getAbstractFileByPath(${JSON.stringify(restoredPath)});
    if (!output) throw new Error('Close-recovery command output disappeared.');
    await app.vault.rename(output, ${JSON.stringify(recoveredPath)});
    return true;
  })()`);

  const recoveredView = await openReader(primaryPage, recoveredPath);
  const reopened = await inspectPdf(recoveredView);
  assert.ok(reopened.subtypes.includes("Square"), "The recovered close-time bytes must reopen with the user's annotation.");
  await detachOwnedView(recoveredView);
  await setAutoSave(primaryPage, true);
  Object.assign(closeCheck, {
    path: relativePath,
    recoveredCopy: recoveredPath,
    documentId: view.documentId,
    candidateStatus: candidate.metadata.status,
    origin: candidate.metadata.origin,
    reason: candidate.metadata.reason,
    requestId: candidate.metadata.requestId,
    revision: candidate.metadata.revision,
    sourceHashUnchanged: beforeHash === await fileHash(relativePath),
    candidateBytes: candidateBytes.byteLength,
    restoredBytes: restoredBytes.byteLength,
    recoveredSubtypes: reopened.subtypes,
  });
}

async function testCloseRecoveryWriteFailureKeepsView() {
  const relativePath = testPath("close-recovery-write-failure");
  report.testFiles.push(relativePath);
  const beforeHash = await fileHash(relativePath);
  await setAutoSave(primaryPage, false);
  const view = await openReader(primaryPage, relativePath);
  await addAnnotation(view, 5);
  await wait(1_700);
  assert.equal(await fileHash(relativePath), beforeHash,
    "The close-recovery failure fixture must remain dirty without writing the original PDF.");

  let faultInstalled = false;
  let failedCloseMonitor = null;
  let retryCloseMonitor = null;
  const closeCheck = report.checks.closeRecoveryWriteFailure = {
    path: relativePath,
    documentId: view.documentId,
    beforeHash,
    failedClose: {},
    retryClose: {},
  };
  try {
    const fault = await installRecoveryDirectoryWriteFault(view);
    faultInstalled = true;
    failedCloseMonitor = await installCloseDiagnostics(view, "recovery-write-failure-refuses-close");
    const failedDetach = await evaluateJson(view.page, `(async () => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
          candidate.view?.requestedPath === ${JSON.stringify(relativePath)});
      if (!leaf) throw new Error('Recovery-failure close lost its owned Reader tab.');
      const result = await leaf.detach();
      return JSON.stringify({ result });
    })()`);
    const failureState = await recoveryDirectoryWriteFaultState(view.page, { restore: true });
    faultInstalled = false;
    assert.equal(failureState.calls, 1,
      "The injected failure must target exactly one recovery PDF binary write.");
    assert.ok(failureState.path.startsWith(fault.candidatePrefix),
      "The injected write fault must match only this document's uniquely prefixed candidate.");
    assert.ok(failureState.path.toLowerCase().endsWith(".pdf"));
    assert.equal(failedDetach.result, false,
      "A dirty view must refuse detach when its recovery draft cannot be written.");

    const failedTrace = await readCloseDiagnostics(failedCloseMonitor);
    closeCheck.failedClose.closeLifecycle = failedTrace;
    const prepare = failedTrace.hostMessages.find((message) =>
      message.type === "prepare-close" && message.documentId === view.documentId,
    );
    assert.ok(prepare, "A close attempt must begin with prepare-close.");
    const refusal = failedTrace.viewerMessages.find((message) =>
      message.type === "close-prepared" && message.id === prepare.id,
    );
    assert.ok(refusal, "The host must receive a close-prepared refusal for the failed recovery.");
    assert.equal(refusal.prepared, false);
    assert.equal(refusal.dirty, true);
    assert.equal(refusal.recovered, false);
    const failedRecovery = failedTrace.viewerMessages.find((message) =>
      message.type === "recover" &&
      message.documentId === view.documentId &&
      message.reason === "auto-save-disabled",
    );
    assert.ok(failedRecovery, "The failed close must include a recovery request for the dirty document.");
    assert.ok(failedTrace.hostMessages.some((message) =>
      message.type === "error" &&
      message.documentId === view.documentId &&
      message.requestId === failedRecovery.requestId,
    ), "The host must return the injected recovery-write failure to the viewer.");
    assert.ok(failedTrace.hostMessages.some((message) =>
      message.type === "cancel-close" && message.id === prepare.id,
    ), "The failed close must resume the still-open Reader through cancel-close.");
    assert.deepEqual(failedTrace.originalDetachEntries, [],
      "Recovery failure must prevent the original SDK detach from running.");
    assert.equal(failedTrace.detachCalls[0]?.result, false);

    const retainedView = await evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const reader = leaf?.view;
      const pdf = reader?.iframe?.contentWindow?.PDFViewerApplication;
      return { path: reader?.requestedPath || null,
        iframeIsConnected: reader?.iframe?.isConnected ?? null,
        dirty: !!pdf?._hasChanges?.() };
    })())`);
    assert.equal(retainedView.path, relativePath);
    assert.equal(retainedView.iframeIsConnected, true,
      "The refused close must leave the Reader iframe connected for another attempt.");
    assert.equal(retainedView.dirty, true,
      "The refused close must retain the unsaved annotation in the open view.");
    assert.equal(await fileHash(relativePath), beforeHash,
      "A failed recovery write must leave the original PDF unchanged.");
    const candidatesAfterFailure = (await recoveryCandidates(view.page)).filter((item) =>
      item.metadata.documentId === view.documentId &&
      item.metadata.reason === "auto-save-disabled" &&
      item.metadata.status === "draft",
    );
    assert.deepEqual(candidatesAfterFailure, [],
      "A failed recovery binary write must not expose a partial draft candidate.");
    closeCheck.failedClose = {
      injectedWrite: failureState,
      detachResult: failedDetach.result,
      closeLifecycle: failedTrace,
      viewRetained: retainedView,
      sourceHashUnchanged: true,
      partialDrafts: candidatesAfterFailure.length,
    };
    await restoreCloseDiagnostics(failedCloseMonitor);
    failedCloseMonitor = null;

    retryCloseMonitor = await installCloseDiagnostics(view, "recovery-write-failure-retry-close");
    const retryDetach = await evaluateJson(view.page, `(async () => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
          candidate.view?.requestedPath === ${JSON.stringify(relativePath)});
      if (!leaf) throw new Error('Recovery retry lost its owned Reader tab.');
      const result = await leaf.detach();
      return JSON.stringify({ result });
    })()`);
    assert.notEqual(retryDetach.result, false,
      "After the test fault is removed, a durable recovery draft must allow detach.");
    await waitFor(
      "dirty Reader to close after the recovery write fault is removed",
      async () => (await viewsFor(relativePath)).length,
      (count) => count === 0,
      60_000,
    );
    const retryTrace = await readCloseDiagnostics(retryCloseMonitor);
    closeCheck.retryClose.closeLifecycle = retryTrace;
    closeCheck.retryClose.closePreparation = assertPreparedCloseBeforeOriginalDetach(
      retryTrace,
      { documentId: view.documentId, path: relativePath, recoveryReason: "auto-save-disabled" },
    );
    const candidate = await waitFor(
      "recovery draft after retrying close without the test fault",
      async () => {
        const candidates = await recoveryCandidates(primaryPage);
        return candidates.find((item) =>
          item.metadata.documentId === view.documentId &&
          item.metadata.originalPath === relativePath &&
          item.metadata.reason === "auto-save-disabled" &&
          item.metadata.status === "draft",
        ) || null;
      },
      Boolean,
      60_000,
    );
    assert.equal(candidate.metadata.requestId, closeCheck.retryClose.closePreparation.candidate.requestId);
    assert.equal(await fileHash(relativePath), beforeHash);
    closeCheck.retryClose.candidateId = candidate.metadata.candidateId;
    closeCheck.retryClose.sourceHashUnchanged = true;
    await setAutoSave(primaryPage, true);
  } finally {
    if (faultInstalled) {
      await recoveryDirectoryWriteFaultState(view.page, { restore: true }).catch(() => {});
    }
    await restoreCloseDiagnostics(failedCloseMonitor).catch(() => {});
    await restoreCloseDiagnostics(retryCloseMonitor).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
  }
}

async function testDisabledAutosaveSameLeafSwitch() {
  const sourcePath = testPath("switch-offdirty-source");
  const targetPath = testPath("switch-offdirty-target");
  const recoveredPath = testPath("switch-offdirty-recovery-copy");
  report.testFiles.push(sourcePath, targetPath, recoveredPath);
  const sourceHash = await fileHash(sourcePath);
  const targetHash = await fileHash(targetPath);
  await setAutoSave(primaryPage, false);
  const oldView = await openReader(primaryPage, sourcePath);
  const oldDocumentId = oldView.documentId;
  await addAnnotation(oldView, 5);
  await wait(1_700);
  assert.equal(await fileHash(sourcePath), sourceHash,
    "The old switch document must remain dirty and unsaved before the same-leaf transition.");
  assert.equal(await fileHash(targetPath), targetHash);

  const transition = await evaluateJson(oldView.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(oldView.leafId)} &&
        candidate.view?.requestedPath === ${JSON.stringify(sourcePath)});
    const target = app.vault.getAbstractFileByPath(${JSON.stringify(targetPath)});
    if (!leaf || !target) throw new Error('Could not find the owned switch leaf or target PDF.');
    const oldView = leaf.view;
    const viewerWindow = oldView.iframe?.contentWindow;
    const viewerApp = viewerWindow?.PDFViewerApplication;
    if (!viewerApp?.eventBus) throw new Error('The old PDF.js event bus is unavailable.');
    if (!viewerWindow.__nativeSwitchLoadCountInstalled) {
      viewerWindow.__nativeSwitchLoadCount = 0;
      viewerApp.eventBus._on('documentloaded', () => viewerWindow.__nativeSwitchLoadCount++);
      viewerWindow.__nativeSwitchLoadCountInstalled = true;
    }
    const countBefore = viewerWindow.__nativeSwitchLoadCount;
    const oldId = oldView.documentId;
    const oldFrame = oldView.iframe;
    app.workspace.setActiveLeaf?.(leaf, { focus: true });
    await leaf.openFile(target);
    return JSON.stringify({
      leafId: leaf.id,
      sameView: leaf.view === oldView,
      sameIframe: leaf.view?.iframe === oldFrame,
      oldDocumentId: oldId,
      newDocumentId: leaf.view?.documentId || null,
      path: leaf.view?.requestedPath || null,
      countBefore,
      countAfterCall: viewerWindow.__nativeSwitchLoadCount,
    });
  })()`);
  assert.equal(transition.leafId, oldView.leafId);
  assert.equal(transition.sameView, true, "The PDF switch must keep the same Reader view in its workspace leaf.");
  assert.equal(transition.sameIframe, true, "The same-leaf switch must reuse the existing Reader iframe.");
  assert.equal(transition.oldDocumentId, oldDocumentId);
  assert.notEqual(transition.newDocumentId, oldDocumentId,
    "The new PDF must have a distinct document identity after the old dirty draft is recovered.");
  assert.equal(transition.path, targetPath);

  const loadState = await waitFor(
    "same Reader iframe to dispatch documentloaded for the new PDF after recovery",
    async () => evaluateJson(oldView.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(oldView.leafId)});
      const frame = leaf?.view?.iframe?.contentWindow;
      return {
        path: leaf?.view?.requestedPath || null,
        documentId: leaf?.view?.documentId || null,
        count: frame?.__nativeSwitchLoadCount ?? -1,
        pdfReady: !!frame?.PDFViewerApplication?.pdfDocument,
        pages: frame?.PDFViewerApplication?.pdfDocument?.numPages || 0,
      };
    })())`),
    (state) => state.path === targetPath && state.documentId === transition.newDocumentId &&
      state.count > transition.countBefore && state.pdfReady && state.pages > 0,
    60_000,
  );
  const newView = await waitForView(targetPath, oldView.leafId);
  assert.equal(newView.documentId, transition.newDocumentId);
  assert.ok(loadState.count > transition.countBefore);
  assert.equal(await fileHash(targetPath), targetHash,
    "Opening the replacement PDF must not write its original bytes.");
  assert.equal(await fileHash(sourcePath), sourceHash,
    "Recovering the old dirty document during a same-leaf switch must not write its original bytes.");

  const recoveredCandidate = await waitFor(
    "old switch document recovery draft after same-leaf transition",
    async () => {
      const candidates = await recoveryCandidates(newView.page);
      return candidates.find((item) =>
        item.metadata.documentId === oldDocumentId &&
        item.metadata.originalPath === sourcePath &&
        item.metadata.origin === "recovery" &&
        item.metadata.reason === "auto-save-disabled",
      ) || null;
    },
    (item) => item?.metadata.status === "draft",
    60_000,
  );
  assert.equal(recoveredCandidate.metadata.status, "draft");
  const recoveryBytes = await readFile(absolute(recoveredCandidate.candidatePath));
  assert.ok(recoveryBytes.byteLength > 0);
  const newest = await recoveryCandidates(newView.page);
  assert.equal(newest[0]?.metadata.candidateId, recoveredCandidate.metadata.candidateId,
    "The old dirty switch document must be the newest recovery candidate before restore.");
  const restoredPath = await evaluateJson(newView.page, `(async () => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    return JSON.stringify(await plugin.restoreLatestRecovery());
  })()`);
  assert.ok(typeof restoredPath === "string" && restoredPath.startsWith("PDF Recovery/"));
  const restoredBytes = await readFile(absolute(restoredPath));
  assert.deepEqual(restoredBytes, recoveryBytes,
    "The recovery command must preserve the old document's bytes from before the switch.");
  await evaluate(newView.page, `(async () => {
    const output = app.vault.getAbstractFileByPath(${JSON.stringify(restoredPath)});
    if (!output) throw new Error('Same-leaf switch recovery output disappeared.');
    await app.vault.rename(output, ${JSON.stringify(recoveredPath)});
    return true;
  })()`);
  const recoveredView = await openReader(primaryPage, recoveredPath);
  const recovered = await inspectPdf(recoveredView);
  assert.ok(recovered.subtypes.includes("Square"),
    "The old document's Square annotation must remain available in its recovery copy.");
  await detachOwnedView(recoveredView);

  const targetCleanState = await evaluateJson(newView.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(newView.leafId)});
    const pdf = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication;
    return { dirty: !!pdf?._hasChanges?.(), path: leaf?.view?.requestedPath || null };
  })())`);
  assert.equal(targetCleanState.path, targetPath);
  assert.equal(targetCleanState.dirty, false,
    "The replacement document must load clean after the old document's draft recovery.");
  await detachOwnedView(newView);
  assert.equal(await fileHash(targetPath), targetHash);
  const targetCandidates = (await recoveryCandidates(primaryPage)).filter((item) =>
    item.metadata.documentId === transition.newDocumentId,
  );
  assert.deepEqual(targetCandidates, [], "Closing the clean replacement PDF must not create a recovery draft.");
  await setAutoSave(primaryPage, true);
  report.checks.disabledAutosaveSameLeafSwitch = {
    sourcePath,
    targetPath,
    recoveredCopy: recoveredPath,
    oldDocumentId,
    newDocumentId: transition.newDocumentId,
    sameLeaf: transition.leafId === newView.leafId,
    sameView: transition.sameView,
    sameIframe: transition.sameIframe,
    documentLoadedCountBefore: transition.countBefore,
    documentLoadedCountAfter: loadState.count,
    oldRecoveryStatus: recoveredCandidate.metadata.status,
    oldRecoveryReason: recoveredCandidate.metadata.reason,
    sourceHashUnchanged: sourceHash === await fileHash(sourcePath),
    replacementHashUnchanged: targetHash === await fileHash(targetPath),
    recoveredSubtypes: recovered.subtypes,
    replacementWasClean: targetCleanState.dirty === false,
  };
}

function markUnresolved(operation, error) {
  report.unresolved ??= [];
  report.unresolved.push({
    operation,
    reason: error?.stack || String(error),
    classification: "not exercised to a passing native result",
  });
}

async function testNativeEditorAndViewerMatrix() {
  const relativePath = testPath("native-editor-viewer-matrix");
  report.testFiles.push(relativePath);
  await setAutoSave(primaryPage, false);
  const beforeHash = await fileHash(relativePath);
  const view = await openReader(primaryPage, relativePath);
  const matrix = {
    status: "running",
    startedAt: new Date().toISOString(),
    steps: [],
    zoom: null,
    rotations: null,
    undoRedo: null,
    delete: null,
    resize: null,
    colors: null,
    lineWidth: null,
    export: null,
    printService: null,
  };
  report.checks.nativeEditorViewerMatrix = matrix;
  await persistReport();

  try {
    const initialViewState = await evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const viewer = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer;
      return { scale: viewer?.currentScale ?? null,
        scaleValue: viewer?.currentScaleValue ?? null,
        rotation: viewer?.pagesRotation ?? null };
    })())`);
    await checkpointMatrix(matrix, "initial-view-state", "observed", initialViewState);
    try {
      await clickViewerElement(view, "zoomInButton");
      const zoomed = await waitFor(
        "native PDF.js zoom-in control to increase scale",
        async () => evaluateJson(view.page, `JSON.stringify((() => {
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
          return leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.currentScale ?? null;
        })())`),
        (scale) => typeof scale === "number" && scale > initialViewState.scale,
      );
      await clickViewerElement(view, "zoomOutButton");
      const zoomedOut = await waitFor(
        "native PDF.js zoom-out control to decrease scale",
        async () => evaluateJson(view.page, `JSON.stringify((() => {
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
          return leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.currentScale ?? null;
        })())`),
        (scale) => typeof scale === "number" && scale < zoomed - 0.01,
        8_000,
      );
      matrix.zoom = { initial: initialViewState.scale, zoomed, zoomedOut, decreased: zoomedOut < zoomed };
      await checkpointMatrix(matrix, "zoom-controls", "passed", matrix.zoom);
    } catch (error) {
      markUnresolved("zoom controls", error);
      matrix.zoom = { initial: initialViewState.scale, error: error?.stack || String(error) };
      await checkpointMatrix(matrix, "zoom-controls", "failed", matrix.zoom);
    }

    try {
      const observed = [];
      for (let index = 0; index < 4; index += 1) {
        await clickViewerButton(view, "pageRotateCw");
        const rotation = await evaluateJson(view.page, `JSON.stringify((() => {
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
          return leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.pagesRotation ?? null;
        })())`);
        observed.push(rotation);
        const expected = (initialViewState.rotation + 90 * (index + 1)) % 360;
        matrix.rotationObservations = [...observed];
        await checkpointMatrix(matrix, `rotation-${index + 1}`, rotation === expected ? "passed" : "failed", {
          expected,
          observed: rotation,
          sequence: [...observed],
        });
        assert.equal(rotation, expected, `Rotation click ${index + 1} should produce ${expected}°, got ${rotation}°.`);
      }
      matrix.rotations = observed;
      await checkpointMatrix(matrix, "four-rotations", "passed", { observed });
    } catch (error) {
      markUnresolved("four native rotations", error);
      matrix.rotationError = error?.stack || String(error);
      await checkpointMatrix(matrix, "four-rotations", "failed", {
        observed: matrix.rotationObservations || [],
        error: matrix.rotationError,
      });
    }

    await setEditorMode(view, 5);
    await setShapeParameters(view, { color: "#ff0000", thickness: 5 });
    await addAnnotation(view, 5);
    const beforeUndo = await editorDetails(view, 5);
    assert.equal(beforeUndo.length, 1, "Expected one Square editor before undo.");
    await checkpointMatrix(matrix, "square-before-undo", "observed", { count: beforeUndo.length, editor: beforeUndo[0] });
    let undoPassed = false;
    let redoPassed = false;
    let undoInput = null;
    let redoInput = null;
    try {
      undoInput = await dispatchMacChord(view, "z");
      await withNativeCdpDeadline(
        "wait for Command-Z undo state",
        () => waitFor("Mac undo to remove the current test Square", async () => editorDetails(view, 5), (items) => items.length === 0, 10_000),
        10_000,
      );
      undoPassed = true;
      await checkpointMatrix(matrix, "mac-command-z-undo", "passed", {
        remainingSquares: 0,
        input: undoInput,
      });
      redoInput = await dispatchMacChord(view, "z", { shift: true });
      await withNativeCdpDeadline(
        "wait for Command-Shift-Z redo state",
        () => waitFor("Mac redo to restore the current test Square", async () => editorDetails(view, 5), (items) => items.length === 1, 10_000),
        10_000,
      );
      redoPassed = true;
      matrix.undoRedo = { undo: undoPassed, redo: redoPassed, undoInput, redoInput };
      await checkpointMatrix(matrix, "mac-command-shift-z-redo", "passed", matrix.undoRedo);
    } catch (error) {
      markUnresolved("Mac undo/redo", error);
      matrix.undoRedo = {
        undo: undoPassed,
        redo: redoPassed,
        undoInput,
        redoInput,
        nativeCdpUnavailable,
        error: error?.stack || String(error),
      };
      await checkpointMatrix(matrix, "mac-undo-redo", "failed", matrix.undoRedo);
      if (undoPassed && !redoPassed && !nativeCdpUnavailable && !/timed out|target closed|session closed/i.test(String(error))) {
        try {
          await addAnnotation(view, 5);
          await checkpointMatrix(matrix, "restore-square-after-undo-probe", "passed", { method: "real native Square input" });
        } catch (restoreError) {
          markUnresolved("restore matrix Square after undo probe", restoreError);
          await checkpointMatrix(matrix, "restore-square-after-undo-probe", "failed", {
            error: restoreError?.stack || String(restoreError),
          });
        }
      }
    }

    if (nativeCdpUnavailable) {
      for (const operation of [
        "native-backspace-delete",
        "square-color-and-width",
        "square-resize-handle",
        "vault-save-export-and-reopen",
        "print-service-generate-and-cancel",
      ]) {
        await checkpointMatrix(matrix, operation, "not-run", {
          reason: "Stopped after a bounded native CDP operation timeout; no later Reader protocol calls were queued.",
        });
      }
      matrix.status = "interrupted";
      matrix.finishedAt = new Date().toISOString();
      await persistReport();
      return;
    }

    try {
      await addAnnotation(view, 5, { x: 245, y: 175, dx: 85, dy: 60 });
      const beforeDelete = await editorDetails(view, 5);
      assert.equal(beforeDelete.length, 2, "Expected two Square editors before Delete.");
      const selection = await enterExplicitSquareEdit(view, 1);
      assert.equal(selection.explicit.selected, true,
        "The real double-click on the rendered Square annotation must select the second editor before Delete.");
      await dispatchPlainKey(view, "Backspace");
      const afterDelete = await waitFor(
        "Mac Delete/Backspace to delete only the selected test Square",
        async () => editorDetails(view, 5),
        (items) => items.filter((item) => item.type === 5).length === 1,
        10_000,
      );
      const remainingEditor = afterDelete.filter((item) => item.type === 5);
      assert.notEqual(remainingEditor[0].uid, selection.target.uid,
        "Backspace must delete the Square selected through its rendered annotation layer.");
      matrix.delete = {
        before: beforeDelete.filter((item) => item.type === 5).map(({ uid }) => uid),
        selectedUid: selection.target.uid,
        selected: selection.explicit.selected,
        annotationHit: selection.hitTarget,
        actualInnerHit: selection.hit,
        pointerEvents: selection.pointerEvents,
        after: remainingEditor.map(({ uid }) => uid),
        key: "Backspace",
      };
      await checkpointMatrix(matrix, "native-backspace-delete", "passed", matrix.delete);
    } catch (error) {
      markUnresolved("native editor Delete key", error);
      matrix.delete = { error: error?.stack || String(error) };
      await checkpointMatrix(matrix, "native-backspace-delete", "failed", matrix.delete);
    }

    try {
      const selection = await enterExplicitSquareEdit(view, 0);
      const selected = selection.bounds;
      assert.equal(selected.selected, true, "The rendered Square double-click must select the editor before changing properties.");
      await setShapeParameters(view, { color: "#0000ff", thickness: 7 });
      const colored = await waitFor(
        "Square color and line-width controls to update the selected editor",
        async () => editorDomBounds(view, 5, 0),
        (detail) => detail?.uid === selected.uid && detail.selected &&
          detail.color?.[0] === 0 && detail.color?.[1] === 0 && detail.color?.[2] === 255 &&
          detail.thickness === 7,
        8_000,
      );
      matrix.colors = { selectedEditorColor: colored.color, selectedUid: selected.uid,
        annotationHit: selection.hitTarget, pointerEvents: selection.pointerEvents };
      matrix.lineWidth = { selectedEditorThickness: colored.thickness, selectedUid: selected.uid };
      await checkpointMatrix(matrix, "square-color-and-width", "passed", {
        color: matrix.colors,
        lineWidth: matrix.lineWidth,
      });
    } catch (error) {
      markUnresolved("Square color and line width controls", error);
      await checkpointMatrix(matrix, "square-color-and-width", "failed", { error: error?.stack || String(error) });
    }

    let resizeBefore;
    try {
      const selection = await enterExplicitSquareEdit(view, 0);
      resizeBefore = selection.bounds;
      assert.equal(resizeBefore.selected, true, "The Square must be explicitly selected before its resize handle is inspected.");
      assert.equal(resizeBefore.explicitlyEditing, true);
      assert.ok(resizeBefore?.handle, "Selected Square exposes no bottom-right resize handle.");
      assert.ok(resizeBefore.handle.width > 0 && resizeBefore.handle.height > 0,
        `The selected Square resize handle has no hit area: ${JSON.stringify(resizeBefore.handle)}.`);
      assert.equal(resizeBefore.handle.visibility, "visible");
      const handleHit = await inspectNativeClickHit(view, resizeBefore.handle.x, resizeBefore.handle.y);
      assert.equal(handleHit.outerIsFrame, true, "The resize handle must be visible above the Reader iframe.");
      assert.equal(handleHit.inner?.resizerName, "bottomRight",
        `The actual bottom-right resizer must receive the drag: ${JSON.stringify(handleHit.inner)}.`);
      await drag(view, resizeBefore.handle.x, resizeBefore.handle.y, 36, 24);
      const resizeAfter = await waitFor(
        "real pointer drag to resize the selected Square",
        async () => editorDomBounds(view, 5, 0),
        (detail) => detail && (detail.width > resizeBefore.width + 8 || detail.height > resizeBefore.height + 8),
        10_000,
      );
      matrix.resize = {
        selectedUid: resizeBefore.uid,
        selected: resizeBefore.selected,
        explicitlyEditing: resizeBefore.explicitlyEditing,
        annotationHit: selection.hitTarget,
        pointerEvents: selection.pointerEvents,
        handleHit: handleHit.inner,
        before: { width: resizeBefore.width, height: resizeBefore.height, rect: resizeBefore.serializedRect },
        after: { width: resizeAfter.width, height: resizeAfter.height, rect: resizeAfter.serializedRect },
      };
      await checkpointMatrix(matrix, "square-resize-handle", "passed", matrix.resize);
    } catch (error) {
      markUnresolved("Square resize handles", error);
      matrix.resize = { before: resizeBefore || null, error: error?.stack || String(error) };
      await checkpointMatrix(matrix, "square-resize-handle", "failed", matrix.resize);
    }

    try {
      assert.equal(await fileHash(relativePath), beforeHash,
        "The autosave-disabled matrix must keep the original PDF unchanged until the explicit vault-save control is used.");
      const saveControl = await clickViewerButton(view, "secondaryDownload");
      assert.equal(saveControl.label, "保存到仓库");
      assert.equal(saveControl.title, "保存 PDF 到仓库（覆盖当前文件）");
      const saved = await waitForSaved(
        view,
        relativePath,
        beforeHash,
        "PDF.js secondary toolbar save action to write the test PDF into the vault",
      );
      const reopened = await reopenPdf(view);
      const details = await annotationDetails(view);
      const squares = details.filter((item) => item.subtype === "Square");
      assert.equal(squares.length, 1, "The saved matrix PDF must contain exactly the one non-deleted Square.");
      const square = squares[0];
      assert.deepEqual(square.color?.slice(0, 3), [0, 0, 255], "Saved Square color did not round-trip.");
      assert.ok(square.width >= 6.5 && square.width <= 7.5, `Saved line width was ${square.width}.`);
      matrix.export = {
        kind: "vault-pdf-save",
        controlId: "secondaryDownload",
        label: saveControl.label,
        savedHash: saved.hash,
        reopenedSubtypes: reopened.subtypes,
      };
      matrix.colors = { ...matrix.colors, exportedColor: square.color };
      matrix.lineWidth = { ...matrix.lineWidth, exportedWidth: square.width };
      matrix.resize = { ...matrix.resize, exportedRect: square.rect };
      await checkpointMatrix(matrix, "vault-save-export-and-reopen", "passed", {
        export: matrix.export,
        colors: matrix.colors,
        lineWidth: matrix.lineWidth,
      });
      matrix.readerScreenshot = await saveNativeScreenshot(view.page, "matrix");
    } catch (error) {
      markUnresolved("PDF.js secondary toolbar vault save/export", error);
      matrix.export = { kind: "vault-pdf-save", error: error?.stack || String(error) };
      await checkpointMatrix(matrix, "vault-save-export-and-reopen", "failed", matrix.export);
    }

    try {
      const printed = await evaluateJson(view.page, `(async () => {
        const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
          .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
        const frame = leaf?.view?.iframe?.contentWindow;
        const viewerApp = frame?.PDFViewerApplication;
        if (!viewerApp?.pdfViewer?.pageViewsReady) throw new Error('PDF pages are not ready for the print service.');
        viewerApp.beforePrint();
        const service = viewerApp.printService;
        if (!service) throw new Error('PDF.js did not create its print service.');
        try {
          await service.renderPages();
          return JSON.stringify({
            serviceCreated: true,
            generatedPages: frame.document.querySelectorAll('#printContainer > .printedPage').length,
            expectedPages: viewerApp.pdfDocument.numPages,
            osPrintInvoked: false,
          });
        } finally {
          viewerApp.afterPrint();
        }
      })()`);
      assert.equal(printed.serviceCreated, true);
      assert.equal(printed.generatedPages, printed.expectedPages);
      assert.equal(printed.osPrintInvoked, false);
      matrix.printService = printed;
      await checkpointMatrix(matrix, "print-service-generate-and-cancel", "passed", printed);
    } catch (error) {
      markUnresolved("PDF.js print-service generation/cancel without OS print", error);
      matrix.printService = { error: error?.stack || String(error), osPrintInvoked: false };
      await checkpointMatrix(matrix, "print-service-generate-and-cancel", "failed", matrix.printService);
      try {
        await evaluate(view.page, `(() => {
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
          const viewerApp = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication;
          if (viewerApp?.printService) viewerApp.afterPrint();
          return true;
        })()`);
      } catch {}
    }

    report.checks.nativeEditorViewerMatrix = matrix;
    matrix.status = matrix.steps.some((step) => step.status === "failed") ? "incomplete" : "completed";
    matrix.finishedAt = new Date().toISOString();
    await persistReport();
  } catch (error) {
    if (matrix.status === "running") {
      matrix.status = "aborted";
      matrix.error = error?.stack || String(error);
      matrix.finishedAt = new Date().toISOString();
      report.checks.nativeEditorViewerMatrix = matrix;
      await persistReport().catch((persistError) => {
        matrix.checkpointPersistenceError = persistError?.stack || String(persistError);
      });
    }
    throw error;
  } finally {
    if (!nativeCdpUnavailable) await evaluate(view.page, `(() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const viewerApp = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication;
      if (viewerApp?.printService) viewerApp.afterPrint();
      return true;
    })()`).catch(() => {});
    if (!nativeCdpUnavailable && !matrix.readerScreenshot) {
      try {
        matrix.readerScreenshot = await saveNativeScreenshot(view.page, "matrix-failed");
        await persistReport();
      } catch (screenshotError) {
        matrix.screenshotError = screenshotError?.stack || String(screenshotError);
        await persistReport().catch(() => {});
      }
    }
  }
  if (nativeCdpUnavailable) return;
  await detachOwnedView(view, { allowDirty: true });
  await setAutoSave(primaryPage, true);
}

async function testNativeEraserAndReopen() {
  const relativePath = testPath("native-editor-eraser");
  report.testFiles.push(relativePath);
  const beforeHash = await fileHash(relativePath);
  const evidence = {
    status: "running",
    path: relativePath,
    fixtureHash: beforeHash,
    startedAt: new Date().toISOString(),
  };
  report.checks.nativeEraserAndReopen = evidence;
  await persistReport();
  let view;
  await setAutoSave(primaryPage, false);
  try {
    view = await openReader(primaryPage, relativePath);
    await addAnnotation(view, 5);
    const before = await editorDetails(view, 5);
    assert.equal(before.length, 1, "The isolated Eraser fixture must contain one Square before erasing.");
    const square = await editorDomBounds(view, 5, 0);
    assert.ok(square, "The isolated Square editor DOM was not available for the Eraser input.");
    const eraserMode = await evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      return leaf?.view?.iframe?.contentWindow?.pdfjsLib?.AnnotationEditorType?.ERASER ?? null;
    })())`);
    assert.equal(typeof eraserMode, "number", "PDF.js did not expose its current Eraser editor type.");
    evidence.mode = eraserMode;
    evidence.squareBefore = before.map(({ id }) => id);
    await persistReport();
    await setEditorMode(view, eraserMode);
    const eraserPoint = { x: square.x + square.width / 2, y: square.y + 2 };
    const eraserHit = await clickAt(view, eraserPoint.x, eraserPoint.y, square.id);
    const after = await waitFor(
      "native PDF.js Eraser to remove the Square intersected at its border",
      async () => editorDetails(view, 5),
      (items) => items.length === 0,
      8_000,
    );
    assert.deepEqual(after, [], "The Eraser click must remove the one Square in its dedicated fixture.");
    const erasedHash = await fileHash(relativePath);
    evidence.eraserPoint = eraserPoint;
    evidence.actualHit = eraserHit.inner;
    evidence.squareAfter = [];
    evidence.hashAfterErase = erasedHash;
    evidence.netNoOpBeforeSave = erasedHash === beforeHash;
    await persistReport();
    await dispatchMacSave(view);
    const postSave = await waitFor(
      "native Cmd+S to leave the Eraser fixture clean",
      async () => {
        const state = await evaluateJson(view.page, `JSON.stringify((() => {
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
          const pdf = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication;
          return { dirty: !!pdf?._hasChanges?.(), saving: !!leaf?.view?.saving };
        })())`);
        return { ...state, hash: await fileHash(relativePath) };
      },
      (state) => !state.dirty && !state.saving,
      8_000,
    );
    let savedHash = null;
    if (postSave.hash !== erasedHash) {
      savedHash = (await waitForSaved(view, relativePath, erasedHash, "manual save after native erasing")).hash;
    } else {
      assert.equal(postSave.hash, beforeHash,
        "Adding and erasing the only in-memory Square should leave the original test PDF bytes unchanged.");
    }
    const reopened = await reopenPdf(view);
    assert.ok(!reopened.subtypes.includes("Square"), "The erased Square reappeared after reopening the PDF.");
    assert.ok(!reopened.subtypes.includes("Ink"), "The Eraser fixture must not contain unrelated annotations.");
    evidence.postSave = postSave;
    evidence.savedHash = savedHash;
    evidence.netNoOp = postSave.hash === beforeHash;
    evidence.reopenedSubtypes = reopened.subtypes;
    evidence.status = "passed";
    evidence.finishedAt = new Date().toISOString();
    await persistReport();
  } catch (error) {
    evidence.status = "failed";
    evidence.error = error?.stack || String(error);
    evidence.finishedAt = new Date().toISOString();
    await persistReport().catch(() => {});
    throw error;
  } finally {
    if (view && !nativeCdpUnavailable) await detachOwnedView(view, { allowDirty: true });
    await setAutoSave(primaryPage, true);
  }
}

async function installOwnerWindowCleanupMonitor(view, key) {
  await evaluate(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const target = leaf?.view?.ownerWindow;
    if (!target || target !== leaf.view.contentEl?.ownerDocument?.defaultView) {
      throw new Error('Cannot monitor the Reader owner window before popout.');
    }
    const listener = leaf.view.messageListener;
    const originalAdd = target.addEventListener;
    const originalRemove = target.removeEventListener;
    const monitor = { adds: 0, removes: 0, listenerMatches: 0, removedTypes: [] };
    target.addEventListener = function(type, callback, options) {
      if (type === 'message' && callback === listener) monitor.adds += 1;
      return originalAdd.call(this, type, callback, options);
    };
    target.removeEventListener = function(type, callback, options) {
      if (type === 'message' && callback === listener) {
        monitor.removes += 1;
        monitor.removedTypes.push(type);
        monitor.listenerMatches += 1;
      }
      return originalRemove.call(this, type, callback, options);
    };
    window[${JSON.stringify(key)}] = { target, listener, monitor, originalAdd, originalRemove };
    return true;
  })()`);
}

async function installMonitorSnapshotBinding(page, key) {
  const binding = `__nativeLifecycleMonitorSnapshot_${stamp}_${key.replace(/[^a-zA-Z0-9_$]/g, "_")}`;
  const snapshot = { value: null, error: null };
  await page.exposeFunction(binding, (serialized) => {
    try {
      snapshot.value = JSON.parse(serialized);
    } catch (error) {
      snapshot.error = error?.stack || String(error);
    }
  });
  return { binding, snapshot };
}

async function readMonitorAfterTeardown(page, key, snapshotBinding) {
  if (!page.isClosed()) {
    const live = await monitorState(page, key).catch(() => null);
    if (live) return live;
  }
  return waitFor(
    `teardown monitor snapshot for ${key}`,
    async () => snapshotBinding?.snapshot?.value || null,
    Boolean,
    2_000,
  );
}

async function installNewOwnerCleanupMonitor(view, key) {
  const snapshotBinding = await installMonitorSnapshotBinding(view.page, key);
  await evaluate(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const target = leaf?.view?.ownerWindow;
    if (!target || target !== leaf.view.contentEl?.ownerDocument?.defaultView) {
      throw new Error('Reader owner window did not migrate with its popout leaf.');
    }
    const listener = leaf.view.messageListener;
    const originalRemove = target.removeEventListener;
    const monitor = { removes: 0, matches: 0 };
    target.removeEventListener = function(type, callback, options) {
      if (type === 'message' && callback === listener) {
        monitor.removes += 1;
        monitor.matches += 1;
      }
      const result = originalRemove.call(this, type, callback, options);
      try { window[${JSON.stringify(key)}]?.publish?.(); } catch {}
      return result;
    };
    const publish = () => {
      try {
        Promise.resolve(window[${JSON.stringify(snapshotBinding.binding)}](JSON.stringify(monitor))).catch(() => {});
      } catch {}
    };
    window[${JSON.stringify(key)}] = { target, listener, monitor, originalRemove, publish };
    return true;
  })()`);
  return snapshotBinding;
}

async function installBridgeDisposeMonitor(view, key) {
  const snapshotBinding = await installMonitorSnapshotBinding(view.page, key);
  await evaluate(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe?.contentWindow;
    if (!frame) throw new Error('Reader iframe is unavailable for disposal monitoring.');
    const originalRemove = frame.removeEventListener;
    const monitor = { removedTypes: [], removals: [] };
    frame.removeEventListener = function(type, listener, options) {
      monitor.removedTypes.push(type);
      monitor.removals.push({ type, listenerName: listener?.name || "" });
      const result = originalRemove.call(this, type, listener, options);
      try {
        Promise.resolve(window[${JSON.stringify(snapshotBinding.binding)}](JSON.stringify(monitor))).catch(() => {});
      } catch {}
      return result;
    };
    window[${JSON.stringify(key)}] = { frame, originalRemove, monitor };
    return true;
  })()`);
  return snapshotBinding;
}

async function monitorState(page, key) {
  return evaluateJson(page, `JSON.stringify(window[${JSON.stringify(key)}]?.monitor || null)`);
}

async function restoreMonitor(page, key) {
  await evaluate(page, `(() => {
    const state = window[${JSON.stringify(key)}];
    if (!state) return true;
    if (state.target) {
      state.target.addEventListener = state.originalAdd || state.target.addEventListener;
      state.target.removeEventListener = state.originalRemove || state.target.removeEventListener;
    } else if (state.frame) {
      state.frame.removeEventListener = state.originalRemove;
    }
    delete window[${JSON.stringify(key)}];
    return true;
  })()`);
}

async function requestOwnedPopoutMove(view, label) {
  assertOwnedPath(view.path);
  const originalWindows = await appWindows();
  const moveAttemptKey = `__nativeLifecyclePopoutMove_${stamp}_${label.replace(/[^a-zA-Z0-9_$]/g, "_")}`;
  const result = await evaluateJson(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
        candidate.view?.requestedPath === ${JSON.stringify(view.path)});
    if (!leaf) throw new Error('Popout move test lost its exact owned Reader leaf.');
    app.workspace.setActiveLeaf?.(leaf, { focus: true });
    const command = app.commands.findCommand?.('workspace:move-to-new-window');
    if (!command) throw new Error('Obsidian does not expose workspace:move-to-new-window.');
    const state = { status: 'pending', driver: 'Obsidian workspace:move-to-new-window command' };
    window[${JSON.stringify(moveAttemptKey)}] = state;
    let result;
    try {
      result = app.commands.executeCommandById('workspace:move-to-new-window');
    } catch (error) {
      state.status = 'rejected';
      state.error = error?.stack || String(error);
      throw error;
    }
    Promise.resolve(result).then(value => {
      state.status = 'resolved';
      state.result = value ?? null;
      state.finishedAt = new Date().toISOString();
    }, error => {
      state.status = 'rejected';
      state.error = error?.stack || String(error);
      state.finishedAt = new Date().toISOString();
    });
    return JSON.stringify({ invoked: result !== false, resultType: typeof result,
      driver: state.driver, attemptKey: ${JSON.stringify(moveAttemptKey)} });
  })()`);
  assert.equal(result.invoked, true, 'Obsidian must accept the owned Reader move command.');
  return {
    originalWindows,
    originalDocumentId: view.documentId,
    originalOpenRequest: view.openRequest,
    moveAttemptKey,
    moveInvocation: result,
  };
}

async function popoutMoveAttemptState(page, attemptKey) {
  return evaluateJson(page, `JSON.stringify(window[${JSON.stringify(attemptKey)}]
    ? { ...window[${JSON.stringify(attemptKey)}] }
    : null)`);
}

async function capturePopoutMoveFailure(view, move, monitor, label, error) {
  const evidence = {
    label,
    error: error?.stack || String(error),
    originalPage: {
      url: view.page.url(),
      closed: view.page.isClosed(),
    },
  };
  if (!view.page.isClosed()) {
    try {
      evidence.moveAttempt = await popoutMoveAttemptState(view.page, move.moveAttemptKey);
    } catch (captureError) {
      evidence.moveAttemptError = captureError?.stack || String(captureError);
    }
  }
  try {
    evidence.closeTrace = await readCloseDiagnostics(monitor);
  } catch (captureError) {
    evidence.closeTraceError = captureError?.stack || String(captureError);
    evidence.closeTrace = monitor?.traceSnapshot?.value || null;
  }
  try {
    evidence.verifiedWindows = [];
    for (const page of await appWindows()) {
      const state = await evaluateJson(page, `(async () => {
        const generationFrom = html => html?.match?.(/data-renderer-generation=["']([^"']+)["']/)?.[1] || null;
        const readers = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
          .map(leaf => {
            const reader = leaf.view;
            const iframe = reader?.iframe;
            const child = iframe?.contentWindow;
            const childDocument = iframe?.contentDocument;
            const pdf = child?.PDFViewerApplication;
            const viewerHtml = typeof reader?.viewerDocumentHtml === 'string' ? reader.viewerDocumentHtml : '';
            const srcdoc = typeof iframe?.srcdoc === 'string' ? iframe.srcdoc : '';
            let bridgeScripts = [];
            let scriptResources = [];
            try {
              bridgeScripts = Array.from(childDocument?.querySelectorAll?.('script[data-channel][data-token]') || [])
                .map(script => ({
                  src: script.getAttribute('src') || null,
                  channel: script.dataset.channel || null,
                  generation: script.dataset.rendererGeneration || null,
                  tokenPresent: !!script.dataset.token,
                }));
              scriptResources = Array.from(childDocument?.scripts || [])
                .map(script => ({
                  src: script.getAttribute('src') || null,
                  type: script.type || null,
                  async: script.async === true,
                  defer: script.defer === true,
                  readyState: script.readyState || null,
                }))
                .filter(script => script.src)
                .slice(0, 40);
            } catch {}
            return {
              leafId: leaf.id,
              path: reader?.requestedPath || reader?.file?.path || null,
              documentId: reader?.documentId || null,
              openRequest: reader?.openRequest ?? null,
              ready: !!reader?.ready,
              iframeIsConnected: iframe?.isConnected ?? null,
              iframeLoadCount: reader?.iframeLoadCount ?? null,
              awaitingRendererLoad: reader?.awaitingRendererLoad ?? null,
              rendererGeneration: reader?.rendererGeneration || null,
              pendingOpenState: reader?.pendingOpenState ? {
                documentId: reader.pendingOpenState.documentId || null,
                openRequest: reader.pendingOpenState.openRequest ?? null,
                revision: reader.pendingOpenState.revision ?? null,
                confirmedRevision: reader.pendingOpenState.confirmedRevision ?? null,
                restoreDirty: reader.pendingOpenState.restoreDirty === true,
                restorePaused: reader.pendingOpenState.restorePaused === true,
                sent: reader.pendingOpenState.sent ?? null,
                bytesLength: reader.pendingOpenState.bytes?.byteLength ?? reader.pendingOpenState.bytes?.length ?? null,
              } : null,
              hostViewerHtmlLength: viewerHtml.length || null,
              hostViewerHtmlGeneration: generationFrom(viewerHtml),
              iframeSrcAttribute: iframe?.getAttribute?.('src') || null,
              iframeSrcdocLength: srcdoc.length || null,
              iframeSrcdocGeneration: generationFrom(srcdoc),
              iframeSrcdocMatchesHostGeneration: !!reader?.rendererGeneration &&
                generationFrom(srcdoc) === reader.rendererGeneration,
              child: {
                exists: !!child,
                location: (() => { try { return child?.location?.href || null; } catch { return 'unreadable'; } })(),
                origin: (() => { try { return child?.origin || null; } catch { return 'unreadable'; } })(),
                parentIsOwnerWindow: (() => { try { return child?.parent === reader?.ownerWindow; } catch { return null; } })(),
                documentReadyState: childDocument?.readyState || null,
                currentScript: (() => {
                  try {
                    const script = childDocument?.currentScript;
                    return script ? { src: script.src || null, generation: script.dataset?.rendererGeneration || null } : null;
                  } catch { return null; }
                })(),
                bridgeScripts,
                scriptResources,
                pdfViewerApplicationExists: !!pdf,
                pdfViewerInitialized: pdf?.initialized ?? null,
                initializedPromisePresent: !!pdf?.initializedPromise,
                pdfDocumentPresent: !!pdf?.pdfDocument,
                pdfPageCount: pdf?.pdfDocument?.numPages ?? null,
                documentLoaded: !!pdf?.pdfDocument?.loadingTask?.promise,
                eventBusEvents: (() => { try { return Object.keys(pdf?.eventBus?._listeners || {}); } catch { return []; } })(),
                initializePromiseState: 'not-checked',
              },
              dirty: !!iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.(),
            };
          })
          .filter(row => typeof row.path === 'string' && row.path.startsWith(${JSON.stringify(`${testPrefix}/`)}));
        for (const reader of readers) {
          const pdf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(leaf => leaf.id === reader.leafId)?.view?.iframe?.contentWindow?.PDFViewerApplication;
          if (pdf?.initializedPromise && typeof pdf.initializedPromise.then === 'function') {
            reader.child.initializePromiseState = await Promise.race([
              Promise.resolve(pdf.initializedPromise).then(() => 'fulfilled', error => 'rejected: ' + (error?.stack || String(error))),
              new Promise(resolve => setTimeout(() => resolve('pending'), 300)),
            ]);
          } else if (pdf) {
            reader.child.initializePromiseState = 'missing';
          } else {
            reader.child.initializePromiseState = 'PDFViewerApplication-missing';
          }
        }
        return JSON.stringify({
          title: document.title,
          url: location.href,
          documentReadyState: document.readyState,
          isPopout: document.body?.classList?.contains('is-popout-window') === true,
          readers,
        });
      })()`);
      evidence.verifiedWindows.push(state);
      evidence.verifiedWindows.at(-1).rendererDiagnostics = nativePageDiagnostics.get(page) || null;
      const screenshot = path.join(
        artifactsDirectory,
        `native-macos-lifecycle-${stamp}-${label.replace(/[^a-z0-9-]+/gi, "-")}-failure-${evidence.verifiedWindows.length}.png`,
      );
      try {
        await page.screenshot({ path: screenshot, fullPage: false });
        evidence.verifiedWindows.at(-1).screenshot = screenshot;
      } catch (captureError) {
        evidence.verifiedWindows.at(-1).screenshotError = captureError?.message || String(captureError);
      }
    }
  } catch (captureError) {
    evidence.windowCaptureError = captureError?.stack || String(captureError);
  }
  report.checks.popoutMoveFailures ??= [];
  report.checks.popoutMoveFailures.push(evidence);
  await persistReport();
  return evidence;
}

async function readerRuntimeState(view) {
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const reader = leaf?.view;
    const frame = reader?.iframe?.contentWindow;
    const pdf = frame?.PDFViewerApplication;
    return {
      path: reader?.requestedPath || reader?.file?.path || null,
      documentId: reader?.documentId || null,
      openRequest: reader?.openRequest ?? null,
      ready: !!reader?.ready,
      iframeIsConnected: reader?.iframe?.isConnected ?? null,
      ownerWindowIsOwner: reader?.ownerWindow === reader?.contentEl?.ownerDocument?.defaultView,
      dirty: !!pdf?._hasChanges?.(),
      modified: pdf?._annotationStorageModified === true,
      saving: !!reader?.saving,
      editorMode: pdf?.pdfViewer?.annotationEditorMode ?? null,
      pageCount: pdf?.pdfDocument?.numPages ?? 0,
    };
  })())`);
}

async function moveOwnedViewToPopout(view, label, requestedMove = null, {
  preserveDocumentId = true,
  failureEvidence = null,
} = {}) {
  const move = requestedMove || await requestOwnedPopoutMove(view, label);
  try {
    const popoutPage = await waitFor(
      `${label} Obsidian popout renderer`,
      async () => {
        const current = await appWindows();
        return current.find((page) => !move.originalWindows.includes(page)) || null;
      },
      Boolean,
      30_000,
    );
    createdPopoutPage = popoutPage;
    const moved = await waitFor(
      `${label} owned Reader to migrate into its popout`,
      async () => {
        const views = await viewsFor(view.path);
        return views.find((candidate) => candidate.page === popoutPage && candidate.popout &&
          candidate.ready && candidate.frameLoaded && candidate.pages > 0) || null;
      },
      Boolean,
      45_000,
    );
    if (preserveDocumentId) {
      assert.equal(moved.documentId, move.originalDocumentId,
        'Moving the Reader tab to a popout must preserve its open PDF identity.');
    }
    assert.equal(moved.ownerWindowIsOwner, true);
    await verifyIdentity(popoutPage);
    return { view: moved, page: popoutPage, originalDocumentId: move.originalDocumentId,
      originalOpenRequest: move.originalOpenRequest,
      moveAttemptKey: move.moveAttemptKey, moveInvocation: move.moveInvocation };
  } catch (error) {
    if (failureEvidence) {
      await capturePopoutMoveFailure(
        view,
        move,
        failureEvidence.monitor,
        failureEvidence.label || label,
        error,
      ).catch((captureError) => {
        report.checks.popoutMoveFailureCaptureError = captureError?.stack || String(captureError);
      });
    }
    throw error;
  }
}

async function closeEmptyTestPopout(page, label) {
  if (!page || page.isClosed()) {
    const anchor = page ? popoutCleanupAnchors.get(page) : null;
    if (anchor) await removePopoutCleanupAnchor(anchor, label);
    if (createdPopoutPage === page) createdPopoutPage = null;
    return { alreadyClosed: true };
  }
  await verifyIdentity(page);
  const openReaderPaths = await evaluateJson(page, `JSON.stringify(
    app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .map(leaf => leaf.view?.requestedPath || leaf.view?.file?.path || null)
  )`);
  assert.deepEqual(openReaderPaths, [], `${label} popup must be empty before test cleanup.`);
  await disableBackgroundVisibilityEmulation(page);
  await page.close({ runBeforeUnload: false });
  const anchor = popoutCleanupAnchors.get(page) || null;
  const outcome = {
    closedAfterOwnedReadersDetached: page.isClosed(),
    openReaderPaths,
    testAnchorHeldWindowUntilReaderDetach: Boolean(anchor),
  };
  assert.equal(outcome.closedAfterOwnedReadersDetached, true);
  report.checks.popoutWindowCleanup ??= [];
  report.checks.popoutWindowCleanup.push({ label, ...outcome });
  if (createdPopoutPage === page) createdPopoutPage = null;
  if (anchor) await removePopoutCleanupAnchor(anchor, label);
  return outcome;
}

async function createPopoutCleanupAnchor(page, readerView, label) {
  const slug = String(label).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  const anchorPath = `${testPrefix}/popout-anchor-${slug}.md`;
  assert.ok(anchorPath.startsWith(`${testPrefix}/`));
  await verifyIdentity(page);
  const result = await evaluateJson(page, `(async () => {
    const anchorPath = ${JSON.stringify(anchorPath)};
    if (app.vault.getAbstractFileByPath(anchorPath)) {
      throw new Error('Refusing to reuse an existing popout cleanup anchor.');
    }
    const file = await app.vault.create(anchorPath, 'Native lifecycle cleanup anchor.\\n');
    const leaf = app.workspace.getLeaf(true);
    await leaf.openFile(file);
    app.workspace.setActiveLeaf?.(leaf, { focus: true });
    const viewType = leaf.view?.getViewType?.() || null;
    return JSON.stringify({ leafId: leaf.id, path: file.path, viewType });
  })()`);
  assert.notEqual(result.leafId, readerView.leafId,
    "The test anchor must keep the popout alive in a separate non-Reader leaf.");
  assert.notEqual(result.viewType, viewType,
    "The test anchor must not replace or impersonate the moved PDF Reader.");
  const anchor = { page, path: anchorPath, leafId: result.leafId, label };
  popoutCleanupAnchors.set(page, anchor);
  report.testFiles.push(anchorPath);
  report.checks.popoutCleanupAnchors ??= [];
  report.checks.popoutCleanupAnchors.push({
    label,
    path: anchorPath,
    leafId: result.leafId,
    viewType: result.viewType,
    driver: "test-owned Markdown leaf opened in the verified Obsidian popout to prevent SDK last-leaf window teardown during Reader cleanup",
  });
  return anchor;
}

async function removePopoutCleanupAnchor(anchor, label) {
  if (!anchor) return;
  assert.ok(anchor.path.startsWith(`${testPrefix}/`));
  if (!primaryPage || primaryPage.isClosed()) {
    throw new Error(`Cannot safely remove owned popout anchor ${anchor.path}: the verified primary test window is unavailable.`);
  }
  const removed = await evaluateJson(primaryPage, `(async () => {
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(anchor.path)});
    if (!file) return JSON.stringify({ alreadyAbsent: true });
    await app.vault.delete(file);
    return JSON.stringify({ removed: !app.vault.getAbstractFileByPath(${JSON.stringify(anchor.path)}) });
  })()`);
  assert.ok(removed.removed || removed.alreadyAbsent,
    `Could not remove test-owned popout anchor ${anchor.path}.`);
  report.checks.popoutCleanupAnchorRemoval ??= [];
  report.checks.popoutCleanupAnchorRemoval.push({
    label,
    path: anchor.path,
    removed: Boolean(removed.removed),
    alreadyAbsent: Boolean(removed.alreadyAbsent),
  });
  popoutCleanupAnchors.delete(anchor.page);
}

async function createOwnedPopout(relativePath, label) {
  assertOwnedPath(relativePath);
  const view = await openReader(primaryPage, relativePath);
  return moveOwnedViewToPopout(view, label);
}

async function invokeOwnedPopoutRootClose(view, attemptKey) {
  const outcome = await evaluateJson(view.page, `(() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
        candidate.view?.requestedPath === ${JSON.stringify(view.path)});
    const reader = leaf?.view;
    const gate = reader?.popoutCloseGate;
    const root = gate?.root;
    if (!leaf || !reader || !root || !gate.active || root.win !== window ||
        root.workspace !== app.workspace || root.close !== gate.closeWrapper) {
      throw new Error('Refusing popout close without the active candidate close gate for this exact Reader window.');
    }
    const state = { status: 'pending', driver: 'Obsidian PopoutSplit.close() through the installed PDF Reader close gate' };
    window[${JSON.stringify(attemptKey)}] = state;
    let result;
    try {
      result = root.close();
    } catch (error) {
      state.status = 'rejected';
      state.error = error?.stack || String(error);
      throw error;
    }
    Promise.resolve(result).then(value => {
      state.status = 'resolved';
      state.result = value ?? null;
      state.finishedAt = new Date().toISOString();
    }, error => {
      state.status = 'rejected';
      state.error = error?.stack || String(error);
      state.finishedAt = new Date().toISOString();
    });
    return JSON.stringify({
      invoked: true,
      closeGateActive: gate.active,
      closeWrapperInstalled: root.close === gate.closeWrapper,
      driver: state.driver,
    });
  })()`);
  assert.equal(outcome.invoked, true);
  assert.equal(outcome.closeGateActive, true);
  assert.equal(outcome.closeWrapperInstalled, true);
  return outcome;
}

async function popoutCloseAttemptState(view, attemptKey) {
  if (view.page.isClosed()) return null;
  return evaluateJson(view.page, `JSON.stringify(window[${JSON.stringify(attemptKey)}] || null)`);
}

async function waitForOwnedPopoutClosed(popoutPage, relativePath, description) {
  return waitFor(description, async () => {
    const pages = await appWindows();
    const remainingViews = await viewsFor(relativePath);
    const pageStillRegistered = isLivePageTarget(popoutPage);
    return {
      pageClosed: !pageStillRegistered,
      pageStillRegistered: pages.includes(popoutPage),
      remainingViews: remainingViews.map(({ leafId, documentId }) => ({ leafId, documentId })),
    };
  }, (state) => state.pageClosed && state.remainingViews.length === 0, 60_000);
}

async function restoreRecoveryCandidateToOwnedCopy(sourcePage, candidate, documentId, originalPath, recoveredPath, reason) {
  assertOwnedPath(originalPath);
  assertOwnedPath(recoveredPath);
  assert.equal(candidate.metadata.documentId, documentId);
  assert.equal(candidate.metadata.originalPath, originalPath);
  assert.equal(candidate.metadata.origin, 'recovery');
  assert.equal(candidate.metadata.reason, reason);
  assert.equal(candidate.metadata.status, 'draft');
  assert.ok(candidate.metadata.requestId);
  assert.ok(Number.isSafeInteger(candidate.metadata.revision) && candidate.metadata.revision > 0);
  const candidateBytes = await readFile(absolute(candidate.candidatePath));
  assert.ok(candidateBytes.byteLength > 0);
  const latest = await recoveryCandidates(sourcePage);
  assert.equal(latest[0]?.metadata.candidateId, candidate.metadata.candidateId,
    'The exact test-owned close draft must be the latest recovery item before invoking restore.');
  const restoredPath = await evaluateJson(sourcePage, `(async () => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    return JSON.stringify(await plugin.restoreLatestRecovery());
  })()`);
  assert.ok(restoredPath.startsWith('PDF Recovery/'));
  const restoredBytes = await readFile(absolute(restoredPath));
  assert.deepEqual(restoredBytes, candidateBytes,
    'Restoring the close-time candidate must preserve the exact PDF bytes.');
  await evaluate(sourcePage, `(async () => {
    const output = app.vault.getAbstractFileByPath(${JSON.stringify(restoredPath)});
    if (!output) throw new Error('Close-recovery command output disappeared.');
    await app.vault.rename(output, ${JSON.stringify(recoveredPath)});
    return true;
  })()`);
  return { restoredPath, candidateBytes: candidateBytes.byteLength, restoredBytes: restoredBytes.byteLength };
}

async function testPopoutWindowCloseLifecycle() {
  const heldPath = testPath('popout-close-held-save');
  const recoveryPath = testPath('popout-close-autosave-disabled');
  const recoveryCopyPath = testPath('popout-close-autosave-disabled-copy');
  const failurePath = testPath('popout-close-recovery-write-failure');
  const failureCopyPath = testPath('popout-close-recovery-write-failure-copy');
  report.testFiles.push(heldPath, recoveryPath, recoveryCopyPath, failurePath, failureCopyPath);

  const heldBeforeHash = await fileHash(heldPath);
  await setAutoSave(primaryPage, true);
  const held = await createOwnedPopout(heldPath, 'held-save close');
  const heldMonitor = await installCloseDiagnostics(held.view, 'popout-held-save-close');
  const heldAttemptKey = `__nativeLifecyclePopoutClose_${stamp}_held`;
  const heldCheck = report.checks.popoutHeldSaveClose = {
    path: heldPath,
    documentId: held.originalDocumentId,
    driver: 'Obsidian PopoutSplit.close() through the installed PDF Reader close gate; not an OS titlebar action',
    beforeHash: heldBeforeHash,
  };
  let heldPatchInstalled = false;
  try {
    await installWritePatch(held.view.page, heldPath, 'delay-first');
    heldPatchInstalled = true;
    await addAnnotation(held.view, 5);
    const blockedWrite = await waitFor(
      'popout autosave to enter the held test write',
      () => writePatchState(held.view.page),
      (state) => state?.entered === true && state.calls === 1,
      60_000,
    );
    heldCheck.blockedWrite = blockedWrite;
    heldCheck.readerScreenshot = await saveNativeScreenshot(held.view.page, 'popout-close-held-save');
    await invokeOwnedPopoutRootClose(held.view, heldAttemptKey);
    await wait(200);
    const duringClose = await popoutCloseAttemptState(held.view, heldAttemptKey);
    const duringViews = await viewsFor(heldPath);
    const duringReader = await evaluateJson(held.view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(held.view.leafId)});
      const reader = leaf?.view;
      return { path: reader?.requestedPath || null,
        iframeIsConnected: reader?.iframe?.isConnected ?? null,
        dirty: !!reader?.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.() };
    })())`);
    assert.equal(held.page.isClosed(), false,
      'The real popout owner must remain alive while an accepted source-PDF write is held.');
    assert.ok(duringViews.some((candidate) => candidate.leafId === held.view.leafId && candidate.popout));
    assert.equal(duringReader.iframeIsConnected, true);
    assert.equal(duringReader.dirty, true);
    assert.equal(duringClose.status, 'pending',
      'The popout close operation must remain pending until its accepted save is released.');
    assert.equal(await fileHash(heldPath), heldBeforeHash,
      'The controlled host write must not reach disk before its test gate is released.');
    heldCheck.retainedDuringHeldWrite = { attempt: duringClose, reader: duringReader, targetOpen: !held.page.isClosed() };

    await releaseWritePatch(held.view.page);
    heldCheck.patchReleased = true;
    await waitForOwnedPopoutClosed(held.page, heldPath,
      'popout window and dirty Reader to close after the held PDF write finishes');
    heldCheck.closeLifecycle = await readCloseDiagnostics(heldMonitor);
    heldCheck.closePreparation = assertPreparedCloseBeforeOriginalDetach(
      heldCheck.closeLifecycle,
      { documentId: held.originalDocumentId, path: heldPath },
    );
    heldCheck.afterHash = await waitFor('held-save source bytes to change after close',
      () => fileHash(heldPath), (hash) => hash !== heldBeforeHash, 60_000);
    const reopened = await openReader(primaryPage, heldPath);
    const pdf = await inspectPdf(reopened);
    assert.ok(pdf.subtypes.includes('Square'), 'Held-save popout close must persist its Square edit.');
    heldCheck.reopenedSubtypes = pdf.subtypes;
    await detachOwnedView(reopened);
    if (createdPopoutPage === held.page) createdPopoutPage = null;
  } finally {
    if (heldPatchInstalled && !held.view.page.isClosed()) {
      await releaseWritePatch(held.view.page, { restore: true }).catch(() => {});
    }
    await restoreCloseDiagnostics(heldMonitor).catch(() => {});
  }

  const recoveryBeforeHash = await fileHash(recoveryPath);
  await setAutoSave(primaryPage, false);
  const recovery = await createOwnedPopout(recoveryPath, 'autosave-disabled recovery close');
  const recoveryMonitor = await installCloseDiagnostics(recovery.view, 'popout-autosave-disabled-close');
  const recoveryAttemptKey = `__nativeLifecyclePopoutClose_${stamp}_recovery`;
  const recoveryCheck = report.checks.popoutAutosaveDisabledClose = {
    path: recoveryPath,
    documentId: recovery.originalDocumentId,
    driver: 'Obsidian PopoutSplit.close() through the installed PDF Reader close gate; not an OS titlebar action',
    beforeHash: recoveryBeforeHash,
  };
  try {
    await addAnnotation(recovery.view, 5);
    await wait(1_700);
    assert.equal(await fileHash(recoveryPath), recoveryBeforeHash,
      'Autosave-disabled popout close must not write the source PDF before recovery.');
    recoveryCheck.readerScreenshot = await saveNativeScreenshot(recovery.view.page, 'popout-close-recovery');
    await invokeOwnedPopoutRootClose(recovery.view, recoveryAttemptKey);
    await waitForOwnedPopoutClosed(recovery.page, recoveryPath,
      'autosave-disabled popout to close after exact durable recovery acknowledgement');
    recoveryCheck.closeLifecycle = await readCloseDiagnostics(recoveryMonitor);
    recoveryCheck.closePreparation = assertPreparedCloseBeforeOriginalDetach(
      recoveryCheck.closeLifecycle,
      { documentId: recovery.originalDocumentId, path: recoveryPath, recoveryReason: 'auto-save-disabled' },
    );
    const candidate = await waitFor('exact autosave-disabled popout recovery candidate',
      async () => (await recoveryCandidates(primaryPage)).find((item) =>
        item.metadata.documentId === recovery.originalDocumentId &&
        item.metadata.originalPath === recoveryPath &&
        item.metadata.origin === 'recovery' &&
        item.metadata.reason === 'auto-save-disabled') || null,
      (item) => item?.metadata.status === 'draft', 60_000);
    assert.equal(await fileHash(recoveryPath), recoveryBeforeHash,
      'Autosave-disabled popout recovery must leave the original PDF unchanged.');
    assert.equal(candidate.metadata.requestId, recoveryCheck.closePreparation.candidate.requestId);
    const restored = await restoreRecoveryCandidateToOwnedCopy(
      primaryPage, candidate, recovery.originalDocumentId, recoveryPath,
      recoveryCopyPath, 'auto-save-disabled');
    const recoveredView = await openReader(primaryPage, recoveryCopyPath);
    const recoveredPdf = await inspectPdf(recoveredView);
    assert.ok(recoveredPdf.subtypes.includes('Square'),
      'The exact popout close recovery candidate must reopen with its Square edit.');
    recoveryCheck.candidate = candidate.metadata;
    recoveryCheck.restored = restored;
    recoveryCheck.sourceHashUnchanged = true;
    recoveryCheck.recoveredSubtypes = recoveredPdf.subtypes;
    await detachOwnedView(recoveredView);
    if (createdPopoutPage === recovery.page) createdPopoutPage = null;
  } finally {
    await restoreCloseDiagnostics(recoveryMonitor).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
  }

  const failureBeforeHash = await fileHash(failurePath);
  await setAutoSave(primaryPage, false);
  const failure = await createOwnedPopout(failurePath, 'recovery-write failure close');
  const failureAttemptKey = `__nativeLifecyclePopoutClose_${stamp}_failure`;
  const failureCheck = report.checks.popoutRecoveryWriteFailure = {
    path: failurePath,
    documentId: failure.originalDocumentId,
    driver: 'Obsidian PopoutSplit.close() through the installed PDF Reader close gate; not an OS titlebar action',
    beforeHash: failureBeforeHash,
  };
  let faultInstalled = false;
  let failedMonitor = null;
  let retryMonitor = null;
  try {
    await addAnnotation(failure.view, 5);
    await wait(1_700);
    assert.equal(await fileHash(failurePath), failureBeforeHash,
      'Recovery-write failure fixture must remain dirty without writing its source PDF.');
    const fault = await installRecoveryDirectoryWriteFault(failure.view);
    faultInstalled = true;
    failedMonitor = await installCloseDiagnostics(failure.view, 'popout-recovery-write-failure-close');
    failureCheck.readerScreenshot = await saveNativeScreenshot(failure.view.page, 'popout-close-recovery-write-failure');
    await invokeOwnedPopoutRootClose(failure.view, failureAttemptKey);
    const refusedAttempt = await waitFor('popout close to refuse the injected recovery write failure',
      () => popoutCloseAttemptState(failure.view, failureAttemptKey),
      (state) => state && state.status !== 'pending', 30_000);
    assert.equal(refusedAttempt.status, 'resolved');
    assert.equal(refusedAttempt.result, false,
      'The popout owner close must be refused when its dirty PDF recovery write fails.');
    const faultState = await recoveryDirectoryWriteFaultState(failure.view.page, { restore: true });
    faultInstalled = false;
    assert.equal(faultState.calls, 1,
      'The recovery fault must hit exactly one binary candidate write.');
    assert.ok(faultState.path.startsWith(fault.candidatePrefix));
    assert.ok(faultState.path.toLowerCase().endsWith('.pdf'));
    const failedTrace = await readCloseDiagnostics(failedMonitor);
    const prepare = failedTrace.hostMessages.find((message) =>
      message.type === 'prepare-close' && message.documentId === failure.originalDocumentId);
    assert.ok(prepare, 'The popup close must start with prepare-close.');
    const refusal = failedTrace.viewerMessages.find((message) =>
      message.type === 'close-prepared' && message.id === prepare.id);
    assert.ok(refusal, 'The host must receive the failed close-prepared response.');
    assert.equal(refusal.prepared, false);
    assert.equal(refusal.dirty, true);
    assert.equal(refusal.recovered, false);
    const recover = failedTrace.viewerMessages.find((message) =>
      message.type === 'recover' && message.documentId === failure.originalDocumentId &&
      message.reason === 'auto-save-disabled');
    assert.ok(recover, 'The popout close must request the exact recovery candidate.');
    assert.ok(failedTrace.hostMessages.some((message) =>
      message.type === 'error' && message.documentId === failure.originalDocumentId &&
      message.requestId === recover.requestId));
    assert.ok(failedTrace.hostMessages.some((message) =>
      message.type === 'cancel-close' && message.id === prepare.id));
    assert.deepEqual(failedTrace.originalDetachEntries, [],
      'A failed popout recovery write must never cross the original SDK detach boundary.');
    assert.ok(failedTrace.detachCalls.length === 0 ||
      failedTrace.detachCalls.some((entry) => entry.result === false),
    'A refused popout close must either avoid SDK detach entirely or record a rejected detach result.');
    const retained = await evaluateJson(failure.view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(failure.view.leafId)});
      const reader = leaf?.view;
      return { path: reader?.requestedPath || null,
        iframeIsConnected: reader?.iframe?.isConnected ?? null,
        dirty: !!reader?.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.() };
    })())`);
    assert.equal(failure.page.isClosed(), false,
      'The popup owner must remain open when the recovery write is refused.');
    assert.equal(retained.path, failurePath);
    assert.equal(retained.iframeIsConnected, true);
    assert.equal(retained.dirty, true);
    assert.equal(await fileHash(failurePath), failureBeforeHash);
    const partialCandidates = (await recoveryCandidates(primaryPage)).filter((item) =>
      item.metadata.documentId === failure.originalDocumentId &&
      item.metadata.reason === 'auto-save-disabled' && item.metadata.status === 'draft');
    assert.deepEqual(partialCandidates, [],
      'A failed recovery-directory write must not create a partial candidate.');
    failureCheck.failedClose = { attempt: refusedAttempt, fault: faultState,
      closeLifecycle: failedTrace, retained, sourceHashUnchanged: true,
      partialCandidateCount: partialCandidates.length };
    await restoreCloseDiagnostics(failedMonitor);
    failedMonitor = null;

    retryMonitor = await installCloseDiagnostics(failure.view, 'popout-recovery-write-retry-close');
    const retryAttemptKey = `${failureAttemptKey}_retry`;
    await invokeOwnedPopoutRootClose(failure.view, retryAttemptKey);
    await waitForOwnedPopoutClosed(failure.page, failurePath,
      'popout to close after removing the scoped recovery-directory write fault');
    const retryTrace = await readCloseDiagnostics(retryMonitor);
    const retryPreparation = assertPreparedCloseBeforeOriginalDetach(
      retryTrace,
      { documentId: failure.originalDocumentId, path: failurePath, recoveryReason: 'auto-save-disabled' },
    );
    const candidate = await waitFor('durable popout recovery draft after retry',
      async () => (await recoveryCandidates(primaryPage)).find((item) =>
        item.metadata.documentId === failure.originalDocumentId &&
        item.metadata.originalPath === failurePath &&
        item.metadata.origin === 'recovery' && item.metadata.reason === 'auto-save-disabled' &&
        item.metadata.status === 'draft') || null,
      Boolean, 60_000);
    assert.equal(candidate.metadata.requestId, retryPreparation.candidate.requestId);
    assert.equal(await fileHash(failurePath), failureBeforeHash,
      'Successful recovery retry must preserve the original source bytes.');
    const restored = await restoreRecoveryCandidateToOwnedCopy(
      primaryPage, candidate, failure.originalDocumentId, failurePath,
      failureCopyPath, 'auto-save-disabled');
    const recoveredView = await openReader(primaryPage, failureCopyPath);
    const recoveredPdf = await inspectPdf(recoveredView);
    assert.ok(recoveredPdf.subtypes.includes('Square'));
    failureCheck.retryClose = { closeLifecycle: retryTrace,
      closePreparation: retryPreparation, candidate: candidate.metadata,
      restored, sourceHashUnchanged: true, recoveredSubtypes: recoveredPdf.subtypes };
    await detachOwnedView(recoveredView);
    if (createdPopoutPage === failure.page) createdPopoutPage = null;
  } finally {
    if (faultInstalled && !failure.view.page.isClosed()) {
      await recoveryDirectoryWriteFaultState(failure.view.page, { restore: true }).catch(() => {});
    }
    await restoreCloseDiagnostics(failedMonitor).catch(() => {});
    await restoreCloseDiagnostics(retryMonitor).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
  }
}

function assertPopoutMoveCheckpoint(
  trace,
  { documentId, openRequest, dirty, recovered, restorePaused = false },
) {
  assert.ok(trace, "The popout migration message trace must be available.");
  const prepare = trace.hostMessages?.find((message) =>
    message.type === "prepare-close" && message.documentId === documentId &&
    message.openRequest === openRequest,
  );
  assert.ok(prepare, "The migration must prepare the exact Reader generation before moving it.");
  const prepared = trace.viewerMessages?.find((message) =>
    message.type === "close-prepared" && message.documentId === documentId &&
    message.openRequest === openRequest && message.id === prepare.id,
  );
  assert.ok(prepared, "The bridge must acknowledge the matching migration checkpoint.");
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.ok, !recovered,
    "The close acknowledgement's ok flag reports original-PDF save success; recovery is carried separately.");
  assert.equal(prepared.dirty, dirty);
  assert.equal(prepared.recovered, recovered);

  let recovery = null;
  let recoveredAck = null;
  if (recovered) {
    recovery = trace.viewerMessages?.find((message) =>
      message.type === "recover" && message.documentId === documentId &&
      message.reason === "auto-save-disabled" && message.revision === prepared.revision,
    );
    assert.ok(recovery, "Autosave-off migration must request an exact recovery revision.");
    const handled = trace.recoverCalls?.find((message) =>
      message.documentId === documentId && message.requestId === recovery.requestId &&
      message.revision === prepared.revision && message.reason === "auto-save-disabled",
    );
    assert.ok(handled, "The host must persist the migration recovery request.");
    recoveredAck = trace.hostMessages?.find((message) =>
      message.type === "recovered" && message.documentId === documentId &&
      message.requestId === recovery.requestId && message.revision === prepared.revision,
    );
    assert.ok(recoveredAck, "The host must acknowledge the exact durable migration draft.");
    assert.ok(Date.parse(recoveredAck.completedAt) <= Date.parse(prepared.completedAt));
  } else {
    const save = trace.viewerMessages?.find((message) =>
      message.type === "save" && message.documentId === documentId,
    );
    assert.ok(save, "Autosave-on migration must issue a real source-PDF write.");
    const saved = trace.hostMessages?.find((message) =>
      message.type === "saved" && message.documentId === documentId &&
      message.requestId === save.requestId && message.revision === save.revision,
    );
    assert.ok(saved, "The bridge must receive the exact source-PDF save acknowledgement.");
    assert.ok(Date.parse(saved.completedAt) <= Date.parse(prepared.completedAt),
      "The in-flight source save must be acknowledged before migration preparation completes.");
  }

  const open = trace.openCalls?.find((message) =>
    message.documentId === documentId && message.openRequest > openRequest &&
    message.eligible && message.sent,
  );
  assert.ok(open, "The moved Reader must send an open checkpoint into its fresh PDF.js realm.");
  assert.equal(open.restoreDirty, recovered,
    "The migrated renderer must restore the dirty bit from the exact source or recovery checkpoint.");
  assert.equal(open.restorePaused, restorePaused);
  assert.equal(open.revision, prepared.revision);
  const opened = trace.viewerMessages?.find((message) =>
    message.type === "opened" && message.documentId === documentId &&
    message.openRequest === open.openRequest,
  );
  assert.ok(opened, "The fresh renderer must acknowledge loading the migration checkpoint.");
  assert.equal(opened.dirty, recovered);
  assert.equal(opened.restorePaused, restorePaused);
  assert.equal(opened.revision, open.revision);
  assert.equal(opened.confirmedRevision, open.confirmedRevision);
  return { prepare, prepared, recovery, recoveredAck, open, opened };
}

async function testPopoutMoveDirtyLifecycle() {
  const autosavePath = testPath("popout-move-autosave-dirty");
  const recoveryPath = testPath("popout-move-recovery");
  const failurePath = testPath("popout-move-recovery-failure");
  report.testFiles.push(autosavePath, recoveryPath, failurePath);

  const autosave = report.checks.popoutMoveAutosaveDirty = {
    path: autosavePath,
    status: "running",
    driver: "Obsidian workspace:move-to-new-window command through the installed PDF Reader migration wrapper",
    beforeHash: await fileHash(autosavePath),
  };
  await setAutoSave(primaryPage, true);
  const autosaveView = await openReader(primaryPage, autosavePath);
  const autosaveBase = await inspectPdf(autosaveView);
  const autosaveMonitor = await installCloseDiagnostics(autosaveView, "popout-move-autosave-dirty");
  let autosavePatchInstalled = false;
  let autosaveMoved = null;
  try {
    await installWritePatch(autosaveView.page, autosavePath, "delay-first");
    autosavePatchInstalled = true;
    await addAnnotation(autosaveView, 5);
    const added = await editorDetails(autosaveView, 5);
    assert.ok(added.length > 0, "The autosave migration fixture must contain a real Square edit.");
    autosave.readerScreenshot = await saveNativeScreenshot(autosaveView.page, "popout-move-autosave-before");
    const blockedWrite = await waitFor(
      "autosave-on migration fixture to enter its held source-PDF write",
      () => writePatchState(autosaveView.page),
      (state) => state?.entered === true && state.calls === 1,
      60_000,
    );
    autosave.blockedWrite = blockedWrite;
    assert.equal(await fileHash(autosavePath), autosave.beforeHash,
      "The test write gate must hold source bytes before migration preparation.");

    const move = await requestOwnedPopoutMove(autosaveView, "autosave dirty migration");
    autosave.moveInvocation = move.moveInvocation;
    await wait(250);
    const stillHome = await viewsFor(autosavePath);
    const heldState = await readerRuntimeState(autosaveView);
    assert.equal(stillHome.length, 1);
    assert.equal(stillHome[0].leafId, autosaveView.leafId);
    assert.equal(stillHome[0].page, autosaveView.page,
      "The Reader must remain in its original owner window while its save is held.");
    assert.equal(heldState.path, autosavePath);
    assert.equal(heldState.iframeIsConnected, true);
    assert.equal(heldState.dirty, true);
    assert.equal(heldState.saving, true);
    autosave.retainedDuringHeldSave = {
      reader: heldState,
      moveAttempt: await popoutMoveAttemptState(autosaveView.page, move.moveAttemptKey),
      sourceHashUnchanged: await fileHash(autosavePath) === autosave.beforeHash,
    };

    await releaseWritePatch(autosaveView.page);
    autosave.patchReleased = true;
    autosaveMoved = await moveOwnedViewToPopout(autosaveView, "autosave dirty migration", move);
    autosave.migratedDocumentId = autosaveMoved.view.documentId;
    autosave.migratedOpenRequest = autosaveMoved.view.openRequest;
    const autosaveTrace = await readCloseDiagnostics(autosaveMonitor);
    autosave.migrationTrace = autosaveTrace;
    await persistReport();
    autosave.checkpoint = assertPopoutMoveCheckpoint(
      autosaveTrace,
      { documentId: autosaveView.documentId, openRequest: autosaveView.openRequest,
        dirty: false, recovered: false },
    );
    const saved = await waitForSaved(
      autosaveMoved.view,
      autosavePath,
      autosave.beforeHash,
      "held autosave-on migration write to reach the source PDF",
    );
    autosave.afterHash = saved.hash;
    const afterPdf = await reopenPdf(autosaveMoved.view);
    const baseSquares = autosaveBase.subtypes.filter((subtype) => subtype === "Square").length;
    const afterSquares = afterPdf.subtypes.filter((subtype) => subtype === "Square").length;
    assert.ok(afterSquares > baseSquares,
      "The autosave-on edit made before the move must persist after reopening the source PDF.");
    autosave.reopenedSubtypes = afterPdf.subtypes;
    autosave.readerScreenshotAfterMove = await saveNativeScreenshot(autosaveMoved.page, "popout-move-autosave-after");
    await createPopoutCleanupAnchor(autosaveMoved.page, autosaveMoved.view, "autosave dirty migration");
    await detachOwnedView(autosaveMoved.view);
    await closeEmptyTestPopout(autosaveMoved.page, "autosave dirty migration");
    autosave.status = "passed";
    await persistReport();
  } finally {
    if (autosavePatchInstalled && !autosaveView.page.isClosed()) {
      await releaseWritePatch(autosaveView.page, { restore: true }).catch(() => {});
    }
    await restoreCloseDiagnostics(autosaveMonitor).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
  }

  const recovery = report.checks.popoutMoveRecovery = {
    path: recoveryPath,
    status: "running",
    driver: "Obsidian workspace:move-to-new-window command; restored PDF.js realm then real macOS Cmd+S",
    beforeHash: await fileHash(recoveryPath),
  };
  await setAutoSave(primaryPage, false);
  const recoveryView = await openReader(primaryPage, recoveryPath);
  const recoveryBase = await inspectPdf(recoveryView);
  const recoveryDocumentId = recoveryView.documentId;
  const recoveryOpenRequest = recoveryView.openRequest;
  const recoveryMonitor = await installCloseDiagnostics(recoveryView, "popout-move-autosave-disabled");
  let recoveryMoved = null;
  try {
    await addAnnotation(recoveryView, 5);
    const added = await waitFor(
      "autosave-off migration Square to remain in the PDF.js annotation storage",
      () => editorDetails(recoveryView, 5),
      (items) => items.length > 0,
      20_000,
    );
    const dirtyBeforeMove = await waitFor(
      "autosave-off migration edit to remain dirty in its original renderer",
      () => readerRuntimeState(recoveryView),
      (state) => state?.dirty === true && state.path === recoveryPath,
      20_000,
    );
    recovery.editCountBeforeMove = added.length;
    recovery.dirtyBeforeMove = dirtyBeforeMove;
    recovery.readerScreenshot = await saveNativeScreenshot(recoveryView.page, "popout-move-recovery-before");
    assert.equal(await fileHash(recoveryPath), recovery.beforeHash,
      "Autosave-off migration must not write the original PDF before recovery.");

    const move = await requestOwnedPopoutMove(recoveryView, "autosave-disabled dirty migration");
    recovery.moveInvocation = move.moveInvocation;
    recoveryMoved = await moveOwnedViewToPopout(
      recoveryView,
      "autosave-disabled dirty migration",
      move,
      {
        preserveDocumentId: true,
        failureEvidence: { monitor: recoveryMonitor, label: "autosave-disabled dirty migration" },
      },
    );
    const recoveryTrace = await readCloseDiagnostics(recoveryMonitor);
    recovery.migrationTrace = recoveryTrace;
    await persistReport();
    recovery.checkpoint = assertPopoutMoveCheckpoint(
      recoveryTrace,
      { documentId: recoveryDocumentId, openRequest: recoveryOpenRequest,
        dirty: true, recovered: true, restorePaused: false },
    );
    assert.equal(recoveryMoved.view.documentId, recoveryDocumentId,
      "Dirty migration must preserve the exact document session identity.");
    const candidate = await waitFor(
      "exact autosave-disabled migration recovery candidate",
      async () => (await recoveryCandidates(primaryPage)).find((item) =>
        item.metadata?.documentId === recoveryDocumentId &&
        item.metadata?.originalPath === recoveryPath &&
        item.metadata?.origin === "recovery" &&
        item.metadata?.reason === "auto-save-disabled" &&
        item.metadata?.requestId === recovery.checkpoint.recovery.requestId &&
        item.metadata?.revision === recovery.checkpoint.prepared.revision &&
        item.metadata?.status === "draft") || null,
      Boolean,
      30_000,
    );
    const restoredState = await waitFor(
      "migrated autosave-off PDF.js realm to restore the recovery revision as dirty",
      () => readerRuntimeState(recoveryMoved.view),
      (state) => state?.ready && state.pageCount > 0 && state.dirty === true,
      30_000,
    );
    const restoredPdf = await inspectPdf(recoveryMoved.view);
    const baseSquares = recoveryBase.subtypes.filter((subtype) => subtype === "Square").length;
    const restoredSquares = restoredPdf.subtypes.filter((subtype) => subtype === "Square").length;
    assert.ok(restoredSquares > baseSquares,
      "The migration's recovered PDF bytes must contain the Square made before the move.");
    assert.equal(await fileHash(recoveryPath), recovery.beforeHash,
      "Restoring a recovery checkpoint must leave the original PDF unchanged.");
    recovery.restoredState = restoredState;
    recovery.candidate = candidate.metadata;
    recovery.reopenedRecoverySubtypes = restoredPdf.subtypes;
    recovery.readerScreenshotAfterMove = await saveNativeScreenshot(recoveryMoved.page, "popout-move-recovery-after");

    await dispatchMacSave(recoveryMoved.view);
    const saved = await waitForSaved(
      recoveryMoved.view,
      recoveryPath,
      recovery.beforeHash,
      "real Cmd+S after autosave-off migration restore",
    );
    recovery.afterHash = saved.hash;
    const reopened = await reopenPdf(recoveryMoved.view);
    const reopenedSquares = reopened.subtypes.filter((subtype) => subtype === "Square").length;
    assert.ok(reopenedSquares > baseSquares,
      "Real Cmd+S after recovery migration must persist the pre-move Square to the original PDF.");
    recovery.reopenedSourceSubtypes = reopened.subtypes;
    await createPopoutCleanupAnchor(recoveryMoved.page, recoveryMoved.view, "autosave-disabled dirty migration");
    await detachOwnedView(recoveryMoved.view);
    await closeEmptyTestPopout(recoveryMoved.page, "autosave-disabled dirty migration");
    recovery.status = "passed";
    await persistReport();
  } finally {
    await restoreCloseDiagnostics(recoveryMonitor).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
  }

  const failure = report.checks.popoutMoveRecoveryFailure = {
    path: failurePath,
    status: "running",
    driver: "Obsidian workspace:move-to-new-window command; one test-owned .recovery PDF write fault",
    beforeHash: await fileHash(failurePath),
  };
  await setAutoSave(primaryPage, false);
  const failureView = await openReader(primaryPage, failurePath);
  const failureDocumentId = failureView.documentId;
  const failureOpenRequest = failureView.openRequest;
  const failedMonitor = await installCloseDiagnostics(failureView, "popout-move-recovery-write-failure");
  let faultInstalled = false;
  let retryMonitor = null;
  let failureMoved = null;
  try {
    await addAnnotation(failureView, 5);
    assert.ok((await editorDetails(failureView, 5)).length > 0,
      "The failed recovery migration fixture must contain a real Square edit.");
    await waitFor("autosave-off recovery-failure fixture to be dirty",
      () => readerRuntimeState(failureView), (state) => state?.dirty === true, 20_000);
    failure.readerScreenshot = await saveNativeScreenshot(failureView.page, "popout-move-recovery-failure-before");
    assert.equal(await fileHash(failurePath), failure.beforeHash);

    const fault = await installRecoveryDirectoryWriteFault(failureView);
    faultInstalled = true;
    failure.faultScope = fault.faultScope;
    const failedMove = await requestOwnedPopoutMove(failureView, "failed recovery migration");
    failure.moveInvocation = failedMove.moveInvocation;
    const failedTrace = await waitFor(
      "migration recovery write refusal handshake",
      () => readCloseDiagnostics(failedMonitor),
      (trace) => trace?.viewerMessages?.some((message) =>
        message.type === "close-prepared" && message.documentId === failureDocumentId &&
        message.openRequest === failureOpenRequest && message.prepared === false),
      30_000,
    );
    const prepare = failedTrace.hostMessages.find((message) =>
      message.type === "prepare-close" && message.documentId === failureDocumentId &&
      message.openRequest === failureOpenRequest);
    assert.ok(prepare);
    const refusal = failedTrace.viewerMessages.find((message) =>
      message.type === "close-prepared" && message.documentId === failureDocumentId &&
      message.openRequest === failureOpenRequest && message.id === prepare.id);
    assert.equal(refusal.ok, false);
    assert.equal(refusal.prepared, false);
    assert.equal(refusal.dirty, true);
    assert.equal(refusal.recovered, false);
    const recoveryRequest = failedTrace.viewerMessages.find((message) =>
      message.type === "recover" && message.documentId === failureDocumentId &&
      message.reason === "auto-save-disabled");
    assert.ok(recoveryRequest, "The refused migration must have attempted exact recovery persistence.");
    assert.ok(failedTrace.hostMessages.some((message) =>
      message.type === "error" && message.documentId === failureDocumentId &&
      message.requestId === recoveryRequest.requestId));
    assert.ok(failedTrace.hostMessages.some((message) =>
      message.type === "cancel-close" && message.id === prepare.id &&
      message.documentId === failureDocumentId));
    const faultState = await recoveryDirectoryWriteFaultState(failureView.page, { restore: true });
    faultInstalled = false;
    assert.equal(faultState.calls, 1,
      "The migration refusal must exercise exactly one scoped recovery PDF write.");
    assert.ok(faultState.path.startsWith(fault.candidatePrefix));
    assert.ok(faultState.path.toLowerCase().endsWith(".pdf"));
    const retained = await readerRuntimeState(failureView);
    assert.equal(retained.path, failurePath);
    assert.equal(retained.iframeIsConnected, true);
    assert.equal(retained.dirty, true);
    const failedViews = await viewsFor(failurePath);
    assert.equal(failedViews.length, 1);
    assert.equal(failedViews[0].leafId, failureView.leafId);
    assert.equal(failedViews[0].page, failureView.page,
      "A failed recovery write must leave the Reader in its original Obsidian window.");
    assert.equal(await fileHash(failurePath), failure.beforeHash);
    const partialCandidates = (await recoveryCandidates(primaryPage)).filter((item) =>
      item.metadata?.documentId === failureDocumentId &&
      item.metadata?.reason === "auto-save-disabled" && item.metadata?.status === "draft");
    assert.deepEqual(partialCandidates, [],
      "A failed recovery-directory write must not create a partial migration checkpoint.");
    failure.refusedMigration = {
      trace: failedTrace,
      fault: faultState,
      retained,
      noPartialDraft: true,
      sourceHashUnchanged: true,
      failedCommand: await popoutMoveAttemptState(failureView.page, failedMove.moveAttemptKey),
    };
    await restoreCloseDiagnostics(failedMonitor);

    retryMonitor = await installCloseDiagnostics(failureView, "popout-move-recovery-write-retry");
    const retryMove = await requestOwnedPopoutMove(failureView, "retry recovery migration");
    failureMoved = await moveOwnedViewToPopout(failureView, "retry recovery migration", retryMove, {
      failureEvidence: { monitor: retryMonitor, label: "recovery write failure retry migration" },
    });
    const retryTrace = await readCloseDiagnostics(retryMonitor);
    failure.retryTrace = retryTrace;
    await persistReport();
    failure.retryCheckpoint = assertPopoutMoveCheckpoint(
      retryTrace,
      { documentId: failureDocumentId, openRequest: failureOpenRequest,
        dirty: true, recovered: true, restorePaused: false },
    );
    const candidate = await waitFor(
      "durable autosave-disabled migration draft after retry",
      async () => (await recoveryCandidates(primaryPage)).find((item) =>
        item.metadata?.documentId === failureDocumentId &&
        item.metadata?.originalPath === failurePath &&
        item.metadata?.origin === "recovery" &&
        item.metadata?.reason === "auto-save-disabled" &&
        item.metadata?.requestId === failure.retryCheckpoint.recovery.requestId &&
        item.metadata?.revision === failure.retryCheckpoint.prepared.revision &&
        item.metadata?.status === "draft") || null,
      Boolean,
      30_000,
    );
    const restored = await waitFor(
      "retry migration to restore the PDF as dirty in the popout",
      () => readerRuntimeState(failureMoved.view),
      (state) => state?.ready && state.pageCount > 0 && state.dirty === true,
      30_000,
    );
    const recoveredPdf = await inspectPdf(failureMoved.view);
    assert.ok(recoveredPdf.subtypes.includes("Square"));
    assert.equal(await fileHash(failurePath), failure.beforeHash);
    failure.retry = {
      trace: retryTrace,
      candidate: candidate.metadata,
      restored,
      recoveredSubtypes: recoveredPdf.subtypes,
      readerScreenshot: await saveNativeScreenshot(failureMoved.page, "popout-move-recovery-failure-retry"),
    };
    await dispatchMacSave(failureMoved.view);
    const saved = await waitForSaved(
      failureMoved.view,
      failurePath,
      failure.beforeHash,
      "Cmd+S after a refused move is retried successfully",
    );
    failure.retry.afterHash = saved.hash;
    const reopened = await reopenPdf(failureMoved.view);
    assert.ok(reopened.subtypes.includes("Square"));
    failure.retry.reopenedSubtypes = reopened.subtypes;
    await createPopoutCleanupAnchor(failureMoved.page, failureMoved.view, "recovery write failure retry migration");
    await detachOwnedView(failureMoved.view);
    await closeEmptyTestPopout(failureMoved.page, "recovery write failure retry migration");
    failure.status = "passed";
    await persistReport();
  } finally {
    if (faultInstalled && !failureView.page.isClosed()) {
      await recoveryDirectoryWriteFaultState(failureView.page, { restore: true }).catch(() => {});
    }
    await restoreCloseDiagnostics(failedMonitor).catch(() => {});
    await restoreCloseDiagnostics(retryMonitor).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
  }
}

async function testPopoutMigrationSaveAndListenerCleanup() {
  const relativePath = testPath("popout-migrate-save-listeners");
  report.testFiles.push(relativePath);
  await setAutoSave(primaryPage, true);
  const beforeHash = await fileHash(relativePath);
  const view = await openReader(primaryPage, relativePath);
  const originalDocumentId = view.documentId;
  const oldWindowKey = "__nativeLifecycleOldOwnerMonitor";
  const newWindowKey = "__nativeLifecycleNewOwnerMonitor";
  const bridgeKey = "__nativeLifecycleBridgeDisposeMonitor";
  const originalWindows = await appWindows();
  await installOwnerWindowCleanupMonitor(view, oldWindowKey);

  await evaluate(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
        candidate.view?.requestedPath === ${JSON.stringify(relativePath)});
    if (!leaf) throw new Error('Popout test leaf is not the expected test-owned PDF.');
    app.workspace.setActiveLeaf?.(leaf, { focus: true });
    const command = app.commands.findCommand?.('workspace:move-to-new-window');
    if (!command) throw new Error('Obsidian does not expose workspace:move-to-new-window.');
    const invoked = app.commands.executeCommandById('workspace:move-to-new-window');
    if (invoked === false) throw new Error('Obsidian refused to move the owned Reader tab to a popout.');
    return true;
  })()`);

  const windows = await waitFor(
    "Obsidian popout window target",
    appWindows,
    (pages) => pages.length >= 2,
    30_000,
  );
  createdPopoutPage = windows.find((page) => !originalWindows.includes(page));
  assert.ok(createdPopoutPage, "Obsidian must create a distinct test-owned popout renderer.");
  const moved = await waitFor(
    "owned Reader tab to migrate into an Obsidian popout window",
    async () => {
      const views = await viewsFor(relativePath);
      return views.find((candidate) => candidate.popout && candidate.ready &&
        candidate.frameLoaded && candidate.pages > 0) || null;
    },
    Boolean,
    45_000,
  );
  assert.equal(moved.documentId, originalDocumentId, "Moving the Reader tab should preserve its open PDF identity.");
  assert.equal(moved.ownerWindowIsOwner, true, "The Reader must bind to the window that now owns its content.");
  assert.ok(windows.some((page) => page === moved.page));
  const oldMonitor = await monitorState(view.page, oldWindowKey);
  assert.ok(oldMonitor.removes >= 1 && oldMonitor.listenerMatches >= 1,
    "Migration must remove the message listener from the former owner window.");

  const newOwnerMonitorSnapshot = await installNewOwnerCleanupMonitor(moved, newWindowKey);
  const bridgeMonitorSnapshot = await installBridgeDisposeMonitor(moved, bridgeKey);
  const saved = await (async () => {
    await addAnnotation(moved, 5);
    return waitForSaved(moved, relativePath, beforeHash, "autosave after Reader popout migration");
  })();
  const reopened = await reopenPdf(moved);
  assert.ok(reopened.subtypes.includes("Square"));
  const popoutScreenshot = await saveNativeScreenshot(moved.page, "popout");
  const hostMonitorBeforeClose = await monitorState(moved.page, newWindowKey);
  await createPopoutCleanupAnchor(moved.page, moved, "popout listener cleanup");
  await detachOwnedView(moved);
  const hostMonitorAfterClose = await readMonitorAfterTeardown(
    moved.page,
    newWindowKey,
    newOwnerMonitorSnapshot,
  );
  const bridgeMonitorAfterClose = await readMonitorAfterTeardown(
    moved.page,
    bridgeKey,
    bridgeMonitorSnapshot,
  );
  assert.ok(hostMonitorAfterClose?.removes >= 1 && hostMonitorAfterClose?.matches >= 1,
    "Closing the migrated Reader must remove its message listener from the popout owner window.");
  const removals = bridgeMonitorAfterClose?.removals || [];
  const expectedBridgeListeners = [
    ["message", "onHostMessage"],
    ["keydown", "onReadOnlyHotkey"],
    ["beforeunload", "onViewerBeforeUnload"],
    ["pagehide", "dispose"],
    ["unload", "dispose"],
  ];
  for (const [eventType, listenerName] of expectedBridgeListeners) {
    assert.ok(removals.some((item) => item.type === eventType && item.listenerName === listenerName),
      `Bridge teardown did not remove its ${listenerName} ${eventType} listener.`);
  }
  await restoreMonitor(view.page, oldWindowKey).catch(() => {});
  await restoreMonitor(moved.page, newWindowKey).catch(() => {});
  await restoreMonitor(moved.page, bridgeKey).catch(() => {});
  report.checks.popoutMigrationAndCleanup = {
    path: relativePath,
    oldDocumentId: originalDocumentId,
    movedDocumentId: moved.documentId,
    popout: moved.popout,
    ownerWindowIsOwner: moved.ownerWindowIsOwner,
    formerOwnerCleanup: oldMonitor,
    newOwnerBeforeClose: hostMonitorBeforeClose,
    newOwnerAfterClose: hostMonitorAfterClose,
    bridgeRemovedListeners: removals,
    savedHash: saved.hash,
    reopenedSubtypes: reopened.subtypes,
    readerScreenshot: popoutScreenshot,
  };
  if (createdPopoutPage && !createdPopoutPage.isClosed()) {
    await verifyIdentity(createdPopoutPage);
    const remaining = await evaluateJson(createdPopoutPage, `JSON.stringify(
      app.workspace.getLeavesOfType(${JSON.stringify(viewType)}).map(leaf => leaf.view?.requestedPath || leaf.view?.file?.path || null)
    )`);
    assert.deepEqual(remaining, [], "The test-created popout must be empty before closing it.");
    report.checks.popoutMigrationAndCleanup.popoutEmptyBeforeCleanup = true;
    await disableBackgroundVisibilityEmulation(createdPopoutPage);
    await createdPopoutPage.close({ runBeforeUnload: false });
    report.checks.popoutMigrationAndCleanup.emptyPopoutClosedAfterEvidence = true;
    const anchor = popoutCleanupAnchors.get(createdPopoutPage);
    if (anchor) await removePopoutCleanupAnchor(anchor, "popout listener cleanup");
    createdPopoutPage = null;
  }
}

try {
  await mkdir(artifactsDirectory, { recursive: true });
  browser = await puppeteer.connect({
    browserURL: nativeConfig.cdpUrl,
    defaultViewport: null,
    protocolTimeout: 45_000,
  });
  const appTargets = await waitFor("isolated Obsidian renderer", appWindows, (pages) => pages.length > 0, 30_000);
  assert.equal(appTargets.length, 1, "Start with exactly one isolated Obsidian app window; this test will not change settings while unrelated windows or tabs are open.");
  primaryPage = appTargets[0];
  await verifyIdentity(primaryPage);
  backgroundVisibilityEmulationEnabled = true;
  await enableBackgroundVisibilityEmulation(primaryPage);

  const preflight = await evaluateJson(primaryPage, `(async () => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const pluginManifest = JSON.parse(await app.vault.adapter.read(
      ${JSON.stringify(`${nativeConfig.configDir}/plugins/${pluginId}/manifest.json`)},
    ));
    const leaves = app.workspace.getLeavesOfType(${JSON.stringify(viewType)}).map(leaf => ({
      id: leaf.id,
      path: leaf.view?.requestedPath || leaf.view?.file?.path || null,
      dirty: !!leaf.view?.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.(),
    }));
    return JSON.stringify({
      vault: app.vault.adapter.basePath,
      configDir: app.vault.configDir,
      vaultName: app.vault.getName?.() || null,
      pluginEnabled: app.plugins.enabledPlugins.has(${JSON.stringify(pluginId)}),
      pluginVersion: plugin?.manifest?.version || null,
      installedManifestVersion: pluginManifest.version || null,
      popoutCloseCapability: {
        requestPopoutClose: typeof plugin?.requestPopoutClose,
        gateRegistry: plugin?.popoutCloseGates instanceof Map,
      },
      autoSave: plugin?.settings?.autoSave ?? null,
      runningVersion: app.version || null,
      visibility: document.visibilityState,
      readerViews: leaves,
    });
  })()`);
  assert.deepEqual(
    { vault: preflight.vault, configDir: preflight.configDir },
    expectedIdentity,
  );
  assert.equal(preflight.vaultName, "ObReader-Apple-Test");
  assert.equal(preflight.pluginEnabled, true);
  assert.equal(preflight.visibility, "visible", "The isolated Obsidian test window must be visibly rendering for native input checks.");
  assert.equal(preflight.pluginVersion, preflight.installedManifestVersion);
  assert.equal(preflight.popoutCloseCapability.requestPopoutClose, 'function',
    'The running plugin class must include the deployed popout close-preparation method.');
  assert.equal(preflight.popoutCloseCapability.gateRegistry, true,
    'The running plugin instance must include the deployed popout close-gate registry.');
  const [major, minor] = String(preflight.pluginVersion).split(".").map(Number);
  assert.ok(major > 0 || minor >= 2, `Expected the 0.2.0 lifecycle candidate; found ${preflight.pluginVersion}.`);
  assert.deepEqual(
    preflight.readerViews,
    [],
    "Close existing Reader tabs before this test. Its global autosave setting changes and it will not touch tabs outside its unique test prefix.",
  );
  assert.equal(preflight.autoSave, true, "The 0.2 candidate must default to autosave enabled.");
  const installedPluginMainPath = path.join(
    nativeConfig.vault,
    nativeConfig.configDir,
    "plugins",
    pluginId,
    "main.js",
  );
  preflight.candidateSourceSha = process.env.PDF_READER_NATIVE_BUILD_SHA || null;
  preflight.installedPluginMainSha256 = sha256(await readFile(installedPluginMainPath));
  originalAutoSave = Boolean(preflight.autoSave);
  report.preflight = preflight;

  await readFile(fixturePath);
  const fixtureNames = selectedFixtureNames;
  await mkdir(path.join(nativeConfig.vault, "PDF迁移测试"), { recursive: true });
  await mkdir(absolute(testPrefix), { recursive: false });
  for (const name of fixtureNames) {
    const relativePath = testPath(name);
    assertOwnedPath(relativePath);
    await copyFile(fixturePath, absolute(relativePath), constants.COPYFILE_EXCL);
  }
  report.testFiles.push(...fixtureNames.map(testPath));
  await waitFor(
    "all uniquely named lifecycle PDFs to appear in the isolated vault",
    async () => evaluateJson(primaryPage, `JSON.stringify(${JSON.stringify(fixtureNames)}.every(name =>
      !!app.vault.getAbstractFileByPath(${JSON.stringify(testPrefix)} + '/' + name + '.pdf')))`),
  );

  const runners = {
    "manual-save": testAutosaveSettingAndManualShortcut,
    autosave: testAutosaveSquareAndInk,
    inflight: testEditDuringInflightSave,
    rename: testRenameDuringPendingAutosave,
    stale: testSamePdfStaleViewConflict,
    "external-conflict": testExternalBytesConflict,
    "failed-save": testFailedSaveRecoveryCommand,
    "close-flush": testCloseFlushAndReopen,
    "close-recovery": testDisabledAutosaveCloseRecovery,
    "close-recovery-write-failure": testCloseRecoveryWriteFailureKeepsView,
    switch: testDisabledAutosaveSameLeafSwitch,
    matrix: testNativeEditorAndViewerMatrix,
    eraser: testNativeEraserAndReopen,
    popout: testPopoutMigrationSaveAndListenerCleanup,
    "popout-close": testPopoutWindowCloseLifecycle,
    "popout-move": testPopoutMoveDirtyLifecycle,
  };
  for (const caseName of selectedNativeCases) {
    if (nativeCdpUnavailable) break;
    report.executedCases.push(caseName);
    report.currentCase = caseName;
    await persistReport();
    await runners[caseName]();
    report.completedCases.push(caseName);
    report.currentCase = null;
    await persistReport();
  }

  report.testFiles = [...new Set(report.testFiles)];
  if (report.unresolved?.length) {
    report.status = "incomplete";
    throw new Error(`${report.unresolved.length} native lifecycle operation(s) did not reach a passing result.`);
  }
  report.status = "passed";
} catch (error) {
  report.status = report.unresolved?.length ? "incomplete" : "failed";
  report.error = error?.stack || String(error);
  if (nativeCdpUnavailable) {
    report.screenshotSkipped = "Native CDP endpoint did not respond; no additional target command was queued.";
  } else if (primaryPage && !primaryPage.isClosed()) {
    try {
      await verifyIdentity(primaryPage);
      await primaryPage.screenshot({ path: screenshotPath, fullPage: false });
      report.screenshot = screenshotPath;
    } catch (screenshotError) {
      report.screenshotError = screenshotError.message;
    }
  }
  throw error;
} finally {
  if (browser?.isConnected()) {
    if (nativeCdpUnavailable) {
      report.cleanupSkippedDueToNativeCdpUnavailable = true;
      browser.disconnect();
    } else {
    if (primaryPage && !primaryPage.isClosed()) {
      try {
        await releaseWritePatch(primaryPage, { restore: true });
      } catch (restoreError) {
        report.writePatchRestoreError = restoreError.message;
      }
    }
    try {
      const remainingOwnedTabs = await ownedReaderTabs();
      for (const tab of remainingOwnedTabs) {
        try {
          await detachOwnedView(tab, { allowDirty: true });
        } catch (cleanupError) {
          report.cleanupErrors ??= [];
          report.cleanupErrors.push({
            path: tab.path,
            leafId: tab.leafId,
            error: cleanupError?.stack || String(cleanupError),
          });
        }
      }
    } catch (cleanupError) {
      report.cleanupErrors ??= [];
      report.cleanupErrors.push({
        operation: "enumerate test-owned Reader tabs",
        error: cleanupError?.stack || String(cleanupError),
      });
    }
    if (primaryPage && !primaryPage.isClosed()) {
      if (originalAutoSave !== undefined) {
        try {
          await setAutoSave(primaryPage, originalAutoSave);
          report.autoSaveRestored = originalAutoSave;
        } catch (restoreError) {
          report.autoSaveRestoreError = restoreError.message;
        }
      }
    }
    if (createdPopoutPage && !createdPopoutPage.isClosed()) {
      try {
        await verifyIdentity(createdPopoutPage);
        const openReaderPaths = await evaluateJson(createdPopoutPage, `JSON.stringify(
          app.workspace.getLeavesOfType(${JSON.stringify(viewType)}).map(leaf => leaf.view?.requestedPath || leaf.view?.file?.path || null)
        )`);
        if (openReaderPaths.length === 0) {
          await disableBackgroundVisibilityEmulation(createdPopoutPage);
          await createdPopoutPage.close({ runBeforeUnload: false });
          report.createdPopoutClosed = true;
          createdPopoutPage = null;
        } else {
          report.createdPopoutCloseSkipped = openReaderPaths;
          report.cleanupErrors ??= [];
          report.cleanupErrors.push({
            operation: "close test-created popout after removing owned Reader tabs",
            remainingReaderViews: openReaderPaths,
          });
        }
      } catch (cleanupError) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push({
          operation: "close test-created empty popout",
          error: cleanupError?.stack || String(cleanupError),
        });
      }
    }
    for (const anchor of [...popoutCleanupAnchors.values()]) {
      try {
        await removePopoutCleanupAnchor(anchor, "lifecycle final cleanup");
      } catch (cleanupError) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push({
          operation: "remove test-owned popout cleanup anchor",
          path: anchor.path,
          error: cleanupError?.stack || String(cleanupError),
        });
      }
    }
    for (const [page] of [...backgroundVisibilitySessions]) {
      try {
        await disableBackgroundVisibilityEmulation(page);
      } catch (cleanupError) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push({
          operation: "disable per-window background focus emulation",
          error: cleanupError?.stack || String(cleanupError),
        });
      }
    }
    backgroundVisibilityEmulationEnabled = false;
    browser.disconnect();
    }
  }
  if (report.cleanupErrors?.length || report.autoSaveRestoreError || report.writePatchRestoreError) {
    report.status = "failed";
    report.error ||= "Lifecycle cleanup did not fully restore the isolated test instance.";
    process.exitCode = 1;
  }
  report.testFiles = [...new Set(report.testFiles)];
  report.finishedAt = new Date().toISOString();
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Native macOS lifecycle result: ${report.status}`);
  console.log(`Vault: ${nativeConfig.vault}`);
  console.log(`Test prefix: ${testPrefix}`);
  console.log(`Result: ${reportPath}`);
  if (report.screenshot) console.log(`Screenshot: ${report.screenshot}`);
}
