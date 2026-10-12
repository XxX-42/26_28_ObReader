import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assertNativeVaultIdentity, MACOS_TEST_VAULT, nativeConfig } from "./native-config.mjs";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appUrl = "app://obsidian.md/index.html";
function validateIsolatedCdpUrl(value) {
  assert.ok(typeof value === "string" && value.length > 0,
    "Set PDF_READER_CDP_URL to the isolated Obsidian test endpoint.");
  const endpoint = new URL(value);
  assert.ok(["http:", "https:"].includes(endpoint.protocol),
    "PDF_READER_CDP_URL must be a local HTTP endpoint.");
  assert.ok(["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname),
    "PDF_READER_CDP_URL must point to a loopback endpoint.");
  assert.equal(endpoint.username, "", "PDF_READER_CDP_URL must not include credentials.");
  assert.equal(endpoint.password, "", "PDF_READER_CDP_URL must not include credentials.");
  return value;
}
const cdpUrl = validateIsolatedCdpUrl(nativeConfig.cdpUrl);
const pluginId = "pdf-web-reader";
const viewType = "pdf-web-reader-view";
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const runId = `${stamp}-${randomUUID().slice(0, 8)}`;
const ownedDirectoryName = `native-mobile-controls-${runId}`;
const testPrefix = "PDF迁移测试";
const ownedDirectory = path.join(nativeConfig.vault, testPrefix, ownedDirectoryName);
const testFile = path.join(ownedDirectory, "tracemonkey.pdf");
const testPath = `${testPrefix}/${ownedDirectoryName}/tracemonkey.pdf`;
const artifactsDirectory = path.join(root, "tests", "artifacts");
const reportPath = path.join(artifactsDirectory, `native-mobile-controls-${runId}.json`);
const screenshotPaths = {
  opened: path.join(artifactsDirectory, `native-mobile-controls-${runId}-opened.png`),
  created: path.join(artifactsDirectory, `native-mobile-controls-${runId}-created.png`),
  saved: path.join(artifactsDirectory, `native-mobile-controls-${runId}-saved.png`),
  reopened: path.join(artifactsDirectory, `native-mobile-controls-${runId}-reopened.png`),
};
const identityFile = process.env.PDF_READER_NATIVE_IDENTITY_FILE;
assert.ok(identityFile, "Set PDF_READER_NATIVE_IDENTITY_FILE to the frozen native product identity JSON.");
assert.ok(path.isAbsolute(identityFile), "PDF_READER_NATIVE_IDENTITY_FILE must be an absolute path.");
const expected = JSON.parse(await readFile(identityFile, "utf8"));
const nativeBuildSha = process.env.PDF_READER_NATIVE_BUILD_SHA;
const expectedIdentity = {
  vault: MACOS_TEST_VAULT,
  configDir: ".obsidian",
  vaultName: "ObReader-Apple-Test",
};

assert.equal(process.platform, "darwin", "This native mobile-controls test is macOS-only.");
assert.equal(nativeConfig.platform, "darwin");
assert.equal(nativeConfig.vault, MACOS_TEST_VAULT);
assert.equal(nativeConfig.vaultSelector, "ObReader-Apple-Test");
assert.equal(nativeConfig.configDir, expectedIdentity.configDir);
assert.equal(nativeConfig.cdpUrl, cdpUrl, "Use only the configured loopback endpoint for the isolated test vault.");
assert.match(expected.productMain || "", /^[a-f0-9]{64}$/, "Frozen identity JSON must include productMain SHA-256.");
assert.match(expected.manifest || "", /^[a-f0-9]{64}$/, "Frozen identity JSON must include manifest SHA-256.");
assert.match(expected.styles || "", /^[a-f0-9]{64}$/, "Frozen identity JSON must include styles SHA-256.");
assert.match(expected.bridge || "", /^[a-f0-9]{64}$/, "Frozen identity JSON must include bridge SHA-256.");
assert.equal(nativeBuildSha, expected.productMain,
  "Set PDF_READER_NATIVE_BUILD_SHA to the productMain SHA in the frozen identity file.");
assert.match(expected.mobileControlsHarness || "", /^[a-f0-9]{64}$/,
  "Frozen identity JSON must include mobileControlsHarness SHA-256 after static audit.");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownedLeafIds = new Set();
const report = {
  schemaVersion: 1,
  task: "Identity-guarded desktop mobile-emulation verification for the PDF Reader clickable mouse controls.",
  physicalIpadValidated: false,
  startedAt: new Date().toISOString(),
  status: "not-started",
  cdpUrl,
  expectedIdentity,
  product: { expectedSha256: expected.productMain, observedSha256: null, installedSha256: null },
  harness: { expectedSha256: expected.mobileControlsHarness, observedSha256: null },
  initialState: null,
  mobileState: null,
  fixture: {
    path: testPath,
    source: "tests/fixtures/tracemonkey.pdf",
    sha256Before: null,
    sha256AfterSave: null,
    pageNavigation: [],
  },
  interactions: [],
  screenshots: {},
  diagnostics: { path: null, privacyChecked: false, input: null },
  cleanup: { reader: "not-run", fixture: "not-run", modeRestoration: "not-run", diagnostic: "retained-for-user" },
};

let browser;
let page;
let verifiedAppTarget;
let priorState;
let createdFixture = false;
let createdOwnedDirectory = false;
let modeTransitionStarted = false;
let autoSaveChangeRequired = false;
let primaryError = null;

function assertOwnedPath(relativePath) {
  assert.equal(typeof relativePath, "string");
  assert.ok(relativePath.startsWith(`${testPrefix}/`), `Refusing to modify a non-test path: ${relativePath}`);
  assert.ok(relativePath.endsWith(".pdf"));
  assert.ok(!relativePath.includes("\\"));
  assert.ok(!relativePath.split("/").some((part) => part === ".." || part === "."));
  const absolute = path.resolve(nativeConfig.vault, ...relativePath.split("/"));
  const relative = path.relative(nativeConfig.vault, absolute);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `Refusing a path outside the isolated test vault: ${relativePath}`);
  return relativePath;
}

function targetIdentity(target) {
  return target?._targetInfo?.targetId || target?._targetId || null;
}

function assertDiagnosticPrivacy(diagnostic) {
  const sensitiveKey = /^(?:path|filepath|documentpath|documentid|requestid|coordinates?|text|filename|stack|url)$/i;
  const visit = (value, context = "diagnostics") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${context}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") {
      if (typeof value === "string") {
        assert.ok(!value.includes(nativeConfig.vault), `${context} leaked the isolated vault path.`);
        assert.ok(!value.includes(testPath), `${context} leaked the test document path.`);
        assert.ok(!path.isAbsolute(value), `${context} contains an absolute path.`);
        assert.ok(!/^(?:file|blob):\/\//i.test(value), `${context} contains a resource URL.`);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      assert.ok(!sensitiveKey.test(key), `${context} contains forbidden field ${key}.`);
      visit(child, `${context}.${key}`);
    }
  };
  visit(diagnostic);
}

assertOwnedPath(testPath);

async function persistReport() {
  await mkdir(artifactsDirectory, { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function verifyPageIdentity(candidate = page) {
  assert.ok(candidate && !candidate.isClosed(), "The identity-guarded Obsidian page is unavailable.");
  assert.equal(candidate.url(), appUrl, "Refusing a non-Obsidian app renderer.");
  const identity = await candidate.evaluate(() => ({
    vault: app?.vault?.adapter?.basePath || null,
    configDir: app?.vault?.configDir || null,
    vaultName: app?.vault?.getName?.() || null,
  }));
  assertNativeVaultIdentity(identity, nativeConfig);
  assert.deepEqual(identity, expectedIdentity, "Refusing to operate outside the frozen test-vault identity.");
  return identity;
}

async function assertSingleAppPage() {
  assert.ok(browser?.connected, "The isolated Obsidian CDP connection is closed.");
  const pages = await browser.pages();
  const appPages = pages.filter((candidate) => candidate.url() === appUrl);
  const pageTargets = browser.targets().filter((target) => target.type() === "page");
  assert.equal(appPages.length, 1, "Require exactly one isolated Obsidian app page.");
  assert.equal(pageTargets.length, 1, "Refuse to operate while another page or popout target exists.");
  if (page && !page.isClosed() && targetIdentity(page.target()) !== targetIdentity(appPages[0].target())) {
    throw new Error("The identity-verified Obsidian app page changed during the test.");
  }
  if (verifiedAppTarget && targetIdentity(appPages[0].target()) !== verifiedAppTarget) {
    throw new Error("The Obsidian app page target changed during the test.");
  }
  page = appPages[0];
  verifiedAppTarget ||= targetIdentity(page.target());
  assert.ok(verifiedAppTarget, "Could not identify the exact Obsidian app page target.");
  return verifyPageIdentity(page);
}

async function ownedEval(candidate, callback, argument = null) {
  await verifyPageIdentity(candidate);
  const result = await candidate.evaluate(async ({ source, argument, expectedIdentity }) => {
    const assertIdentity = () => {
      const actual = {
        vault: app?.vault?.adapter?.basePath || null,
        configDir: app?.vault?.configDir || null,
        vaultName: app?.vault?.getName?.() || null,
      };
      if (actual.vault !== expectedIdentity.vault || actual.configDir !== expectedIdentity.configDir || actual.vaultName !== expectedIdentity.vaultName) {
        throw new Error("Refusing a native operation after the Obsidian vault identity changed.");
      }
    };
    assertIdentity();
    const operation = (0, eval)(`(${source})`);
    const value = await operation(argument);
    assertIdentity();
    return value;
  }, {
    source: callback.toString(),
    argument,
    expectedIdentity,
  });
  await verifyPageIdentity(candidate);
  return result;
}

async function readAppState(candidate) {
  return ownedEval(candidate, () => {
    const plugin = app.plugins?.plugins?.["pdf-web-reader"];
    const leaves = [];
    app.workspace?.iterateAllLeaves?.((leaf) => leaves.push(leaf));
    const readers = leaves.filter((leaf) => leaf?.view?.getViewType?.() === "pdf-web-reader-view");
    return {
      vault: app.vault?.adapter?.basePath || null,
      configDir: app.vault?.configDir || null,
      vaultName: app.vault?.getName?.() || null,
      appMobile: app.isMobile === true,
      pluginMobile: plugin?.isMobileRuntime === true,
      pluginEnabled: app.plugins?.enabledPlugins?.has("pdf-web-reader") === true,
      autoSave: plugin?.settings?.autoSave ?? null,
      readerPaths: readers.map((leaf) => leaf.view?.requestedPath || leaf.view?.file?.path || null),
      allReaderCount: readers.length,
      pluginViewCount: plugin?.views?.size ?? null,
      gates: [...(plugin?.popoutCloseGates?.values?.() || [])].map((gate) => ({
        active: gate.active === true,
        views: gate.views?.size ?? null,
      })),
      canEmulateMobile: typeof app.emulateMobile === "function",
    };
  });
}

async function waitFor(description, probe, predicate = Boolean, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await probe();
    if (predicate(latest)) return latest;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(latest)}`);
}

function isExpectedNavigationError(error) {
  return /Execution context was destroyed|Cannot find context with specified id/i
    .test(String(error?.message || error));
}

async function ensureFreshBrowserConnection() {
  if (!browser?.connected) {
    browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 30_000 });
  }
  return browser;
}

async function waitForVerifiedAppPage(targetId = verifiedAppTarget, wantedMobile = null, nonce = null, timeoutMs = 60_000) {
  assert.ok(targetId, "The exact Obsidian app page target was not captured during preflight.");
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    await ensureFreshBrowserConnection();
    const targets = browser.targets().filter((candidate) => candidate.type() === "page");
    if (targets.length > 1) {
      throw new Error("Refusing to reacquire Obsidian while another page or popout target exists.");
    }
    if (targets.length === 0) {
      await wait(250);
      continue;
    }
    const target = targets[0];
    assert.equal(targetIdentity(target), targetId,
      "Obsidian replaced the exact app page target during mode reload.");
    const pages = await browser.pages();
    const candidate = pages.find((entry) => targetIdentity(entry.target()) === targetId);
    if (!candidate || candidate.isClosed() || candidate.url() !== appUrl) {
      await wait(250);
      continue;
    }
    let state;
    try {
      state = await candidate.evaluate(() => {
        const instance = window.app;
        const vault = instance?.vault;
        const workspace = instance?.workspace;
        const plugins = instance?.plugins;
        return {
          identity: {
            vault: vault?.adapter?.basePath || null,
            configDir: vault?.configDir || null,
            vaultName: vault?.getName?.() || null,
          },
          ready: !!vault?.adapter?.basePath &&
            typeof vault?.getAbstractFileByPath === "function" &&
            typeof workspace?.iterateAllLeaves === "function" &&
            !!workspace?.layoutReady &&
            typeof plugins?.enabledPlugins?.has === "function" &&
            typeof plugins?.disablePluginAndSave === "function" &&
            typeof plugins?.enablePluginAndSave === "function",
          appMobile: typeof instance?.isMobile === "boolean" ? instance.isMobile : null,
          nonce: globalThis.__pdfReaderNativeMobileControlsNonce ?? null,
        };
      });
    } catch (error) {
      if (!isExpectedNavigationError(error)) throw error;
      await wait(250);
      continue;
    }
    lastState = state;
    if (state.identity.vault && state.identity.configDir && state.identity.vaultName) {
      assertNativeVaultIdentity(state.identity, nativeConfig);
      assert.deepEqual(state.identity, expectedIdentity,
        "Refusing to continue after Obsidian reloaded into a different vault.");
    }
    const newRealm = nonce === null || state.nonce !== nonce;
    if (!newRealm || !state.ready || (wantedMobile !== null && state.appMobile !== wantedMobile)) {
      await wait(250);
      continue;
    }
    page = candidate;
    verifiedAppTarget = targetId;
    await verifyPageIdentity(candidate);
    return state;
  }
  throw new Error(`Timed out waiting for the exact Obsidian app page to initialize; last state: ${JSON.stringify(lastState)}`);
}

async function invokeMobileEmulation(wanted, targetId, nonce) {
  await waitForVerifiedAppPage(targetId);
  await page.evaluate((value) => {
    globalThis.__pdfReaderNativeMobileControlsNonce = value;
  }, nonce);
  try {
    await page.evaluate(({ wanted, expectedIdentity }) => {
      const instance = window.app;
      const identity = {
        vault: instance?.vault?.adapter?.basePath || null,
        configDir: instance?.vault?.configDir || null,
        vaultName: instance?.vault?.getName?.() || null,
      };
      if (identity.vault !== expectedIdentity.vault || identity.configDir !== expectedIdentity.configDir || identity.vaultName !== expectedIdentity.vaultName) {
        throw new Error("Vault identity changed before mobile emulation.");
      }
      if (typeof instance?.emulateMobile !== "function") {
        throw new Error("The isolated Obsidian test build does not expose app.emulateMobile().");
      }
      const leaves = [];
      instance.workspace?.iterateAllLeaves?.((leaf) => leaves.push(leaf));
      const readers = leaves.filter((leaf) => leaf?.view?.getViewType?.() === "pdf-web-reader-view");
      const plugin = instance.plugins?.plugins?.["pdf-web-reader"];
      if (readers.length || plugin?.views?.size || plugin?.popoutCloseGates?.size) {
        throw new Error("Readers, plugin views, and close gates must be empty before changing mobile emulation.");
      }
      instance.emulateMobile(wanted);
      return true;
    }, { wanted, expectedIdentity });
  } catch (error) {
    if (!isExpectedNavigationError(error)) throw error;
  }
  if (browser?.connected) await browser.disconnect().catch(() => {});
  browser = null;
  page = null;
  await waitForVerifiedAppPage(targetId, wanted, nonce);
}

async function transitionMobileMode(wanted) {
  const targetId = verifiedAppTarget || targetIdentity(page?.target());
  await waitForVerifiedAppPage(targetId);
  const before = await readAppState(page);
  assert.equal(before.allReaderCount, 0, "Refusing to reload while a Reader is open.");
  assert.equal(before.pluginViewCount, 0, "Refusing to reload while plugin views are live.");
  assert.deepEqual(before.gates, [], "Refusing to reload while a popout close gate is live.");
  if (before.appMobile === wanted) {
    const restored = await ownedEval(page, async (argument) => {
      const id = "pdf-web-reader";
      if (!app.plugins.enabledPlugins.has(id)) await app.plugins.enablePluginAndSave(id);
      const plugin = app.plugins.plugins[id];
      if (app.isMobile !== argument.wanted || plugin?.isMobileRuntime !== argument.wanted) {
        throw new Error("The loaded plugin does not match the already-selected application mode.");
      }
      if (plugin?.settings?.autoSave !== argument.autoSave) await plugin?.setAutoSaveEnabled?.(argument.autoSave);
      if (plugin?.settings?.autoSave !== argument.autoSave) throw new Error("Auto-save setting did not return to its prior value.");
      return {
        appMobile: app.isMobile === true,
        pluginMobile: plugin.isMobileRuntime === true,
        pluginEnabled: app.plugins.enabledPlugins.has(id),
        autoSave: plugin.settings.autoSave,
      };
    }, { wanted, autoSave: priorState.autoSave });
    assert.equal(restored.pluginEnabled, priorState.pluginEnabled);
    return restored;
  }
  await ownedEval(page, async () => {
    const id = "pdf-web-reader";
    const plugin = app.plugins?.plugins?.[id];
    const leaves = [];
    app.workspace.iterateAllLeaves?.((leaf) => leaves.push(leaf));
    const readers = leaves.filter((leaf) => leaf?.view?.getViewType?.() === "pdf-web-reader-view");
    if (readers.length || plugin?.views?.size || plugin?.popoutCloseGates?.size) {
      throw new Error("Readers, plugin views, and close gates must be empty before changing mobile emulation.");
    }
    if (app.plugins.enabledPlugins.has(id)) await app.plugins.disablePluginAndSave(id);
    return true;
  });

  const nonce = `pdf-reader-mobile-controls-${randomUUID()}`;
  await invokeMobileEmulation(wanted, targetId, nonce);
  return ownedEval(page, async (argument) => {
    const id = "pdf-web-reader";
    if (!app.plugins.enabledPlugins.has(id)) await app.plugins.enablePluginAndSave(id);
    const plugin = app.plugins.plugins[id];
    if (app.plugins.enabledPlugins.has(id) !== argument.pluginEnabled) {
      throw new Error("Plugin enabled state did not survive the application mode transition.");
    }
    if (app.isMobile !== argument.wanted || plugin?.isMobileRuntime !== argument.wanted) {
      throw new Error("Reloaded plugin did not select the requested mobile runtime.");
    }
    if (plugin?.settings?.autoSave !== argument.autoSave) {
      await plugin?.setAutoSaveEnabled?.(argument.autoSave);
    }
    if (plugin?.settings?.autoSave !== argument.autoSave) {
      throw new Error("Plugin reload did not preserve the prior auto-save setting.");
    }
    const leaves = [];
    app.workspace.iterateAllLeaves?.((leaf) => leaves.push(leaf));
    const readers = leaves.filter((leaf) => leaf?.view?.getViewType?.() === "pdf-web-reader-view");
    if (readers.length || plugin?.views?.size || plugin?.popoutCloseGates?.size) {
      throw new Error("A Reader, plugin view, or close gate appeared during the app mode transition.");
    }
    return {
      appMobile: app.isMobile === true,
      pluginMobile: plugin.isMobileRuntime === true,
      pluginEnabled: app.plugins.enabledPlugins.has(id),
      autoSave: plugin.settings.autoSave,
    };
  }, { wanted, pluginEnabled: priorState.pluginEnabled, autoSave: priorState.autoSave });
}

async function switchMobileMode(wanted) {
  modeTransitionStarted = true;
  return transitionMobileMode(wanted);
}

async function readerState(leafId) {
  return ownedEval(page, (id) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === id);
    const view = leaf?.view;
    const frame = view?.iframe?.contentWindow;
    const pdfApp = frame?.PDFViewerApplication;
    const values = pdfApp?.pdfDocument?.annotationStorage?.serializable?.map?.values?.() || [];
    const editorTypes = [...values].filter((item) => !item?.deleted).map((item) => item.annotationType).sort((a, b) => a - b);
    return {
      found: !!view,
      path: view?.requestedPath || view?.file?.path || null,
      ready: view?.ready === true,
      mobile: view?.mobileRuntime?.loaderMode === "mobile-blob",
      stage: view?.mobileRuntime?.stage || null,
      pages: pdfApp?.pdfDocument?.numPages || 0,
      editorMode: pdfApp?.pdfViewer?.annotationEditorMode ?? null,
      editorTypes,
      currentRevision: view?.currentRevision ?? null,
      confirmedRevision: view?.confirmedRevision ?? null,
      saving: view?.saving === true,
      dirty: view?.dirty ?? null,
      pdfHasChanges: typeof pdfApp?._hasChanges === "function" ? pdfApp._hasChanges() : null,
    };
  }, leafId);
}

async function reopenedPageState(leafId) {
  return ownedEval(page, async (id) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === id);
    const view = leaf?.view;
    const iframe = view?.iframe;
    const frame = iframe?.contentWindow;
    const doc = frame?.document;
    const pdfApp = frame?.PDFViewerApplication;
    const pdfDocument = pdfApp?.pdfDocument;
    const pdfViewer = pdfApp?.pdfViewer;
    const activeLeaf = app.workspace.activeLeaf;
    const viewerContainer = doc?.querySelector("#viewerContainer");
    const page = doc?.querySelector('.page[data-page-number="1"]');
    const pageView = pdfViewer?.getPageView?.(0);
    const annotationLayer = pageView?.annotationLayer?.div;
    const frameRect = iframe?.getBoundingClientRect();
    const viewerRect = viewerContainer?.getBoundingClientRect();
    const pageRect = page?.getBoundingClientRect();
    const rect = (value) => value ? {
      x: value.x,
      y: value.y,
      width: value.width,
      height: value.height,
      right: value.right,
      bottom: value.bottom,
    } : null;
    const pageIntersectsViewer = !!pageRect && !!viewerRect &&
      Math.min(pageRect.right, viewerRect.right) > Math.max(pageRect.left, viewerRect.left) &&
      Math.min(pageRect.bottom, viewerRect.bottom) > Math.max(pageRect.top, viewerRect.top);
    const annotations = pdfDocument ? await (await pdfDocument.getPage(1)).getAnnotations() : [];
    const squareAnnotations = annotations.filter((annotation) => annotation.subtype === "Square");
    const squares = squareAnnotations.map((annotation) => {
      const element = [...(annotationLayer?.querySelectorAll("section.squareAnnotation[data-annotation-id]") || [])]
        .find((candidate) => candidate.getAttribute("data-annotation-id") === annotation.id);
      const elementRect = element?.getBoundingClientRect();
      const style = element && frame.getComputedStyle(element);
      return {
        id: annotation.id || null,
        subtype: annotation.subtype,
        rendered: !!element,
        visible: !!element && style.display !== "none" && style.visibility !== "hidden" &&
          elementRect.width > 0 && elementRect.height > 0,
        hasSvgRect: !!element?.querySelector("svg rect"),
        rect: rect(elementRect),
      };
    });
    const previous = doc?.querySelector("#previous");
    const previousStyle = previous && frame.getComputedStyle(previous);
    return {
      leafFound: !!leaf && !!view,
      leafId: leaf?.id || null,
      activeLeafId: activeLeaf?.id || null,
      activeLeafViewType: activeLeaf?.view?.getViewType?.() || null,
      leafIsActive: activeLeaf?.id === id && activeLeaf?.view === view,
      iframeConnected: !!iframe?.isConnected,
      iframeBounds: rect(frameRect),
      iframeVisibleInHostViewport: !!frameRect && frameRect.width > 0 && frameRect.height > 0 &&
        Math.min(frameRect.right, window.innerWidth) > Math.max(frameRect.left, 0) &&
        Math.min(frameRect.bottom, window.innerHeight) > Math.max(frameRect.top, 0),
      hostViewport: { width: window.innerWidth, height: window.innerHeight },
      frameViewport: frame ? { width: frame.innerWidth, height: frame.innerHeight } : null,
      viewerBounds: rect(viewerRect),
      viewerVisibleInFrame: !!viewerRect && !!frame && viewerRect.width > 0 && viewerRect.height > 0 &&
        Math.min(viewerRect.right, frame.innerWidth) > Math.max(viewerRect.left, 0) &&
        Math.min(viewerRect.bottom, frame.innerHeight) > Math.max(viewerRect.top, 0),
      pageBounds: rect(pageRect),
      pageIntersectsViewer,
      currentPageNumber: Number(pdfViewer?.currentPageNumber) || null,
      numPages: Number(pdfDocument?.numPages) || 0,
      pageNumber: Number(page?.dataset?.pageNumber) || null,
      renderingState: pageView?.renderingState ?? null,
      pageLoaded: page?.dataset?.loaded === "true" && !page.classList.contains("loading") &&
        !page.classList.contains("loadingIcon"),
      pageMatchesView: !!page && pageView?.div === page,
      annotationLayerConnected: !!annotationLayer?.isConnected && annotationLayer?.parentElement === page,
      annotationLayerRendered: !!pageView?.annotationLayer?.annotationLayer,
      subtypes: annotations.map((annotation) => annotation.subtype),
      squareAnnotations: squares,
      previousButton: {
        exists: !!previous,
        visible: !!previous && previous.hidden !== true && previousStyle?.display !== "none" &&
          previousStyle?.visibility !== "hidden" && Number(previousStyle?.opacity) !== 0 &&
          previous.getBoundingClientRect().width > 0 && previous.getBoundingClientRect().height > 0,
        disabled: previous?.disabled === true || previous?.getAttribute("aria-disabled") === "true",
      },
    };
  }, leafId);
}

async function readerForPath(relativePath, onlyLeafId = null) {
  const state = await ownedEval(page, ({ relativePath, onlyLeafId }) => {
    const matches = app.workspace.getLeavesOfType("pdf-web-reader-view").filter((leaf) =>
      (leaf.view?.requestedPath || leaf.view?.file?.path) === relativePath &&
      (!onlyLeafId || leaf.id === onlyLeafId));
    return matches.map((leaf) => ({ id: leaf.id, path: leaf.view.requestedPath || leaf.view.file?.path || null }));
  }, { relativePath, onlyLeafId });
  return state;
}

async function openOwnedReader(relativePath) {
  assertOwnedPath(relativePath);
  const opened = await ownedEval(page, async (pathArg) => {
    const file = app.vault.getAbstractFileByPath(pathArg);
    if (!file || file.extension?.toLowerCase() !== "pdf") throw new Error("The owned TraceMonkey fixture is not indexed as a PDF.");
    const leaf = app.workspace.getLeaf(true);
    await leaf.openFile(file);
    app.workspace.setActiveLeaf?.(leaf, { focus: true });
    return { id: leaf.id, path: leaf.view?.requestedPath || leaf.view?.file?.path || null };
  }, relativePath);
  assert.ok(typeof opened?.id === "string" && opened.id.length > 0, "The owned Reader leaf ID is unavailable.");
  ownedLeafIds.add(opened.id);
  await waitFor(`mobile Reader to load ${relativePath}`, () => readerState(opened.id),
    (state) => state.found && state.path === relativePath && state.ready && state.pages > 0 && state.mobile && state.stage === "ready");
  return opened.id;
}

async function selectorState(leafId, selector) {
  return ownedEval(page, ({ leafId, selector }) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === leafId);
    const iframe = leaf?.view?.iframe;
    const doc = iframe?.contentDocument;
    const win = iframe?.contentWindow;
    const element = doc?.querySelector(selector);
    if (!leaf || !iframe || !doc || !element) return null;
    const rect = element.getBoundingClientRect();
    const style = win.getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && element.hidden !== true;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const outerRect = iframe.getBoundingClientRect();
    const outerHit = document.elementFromPoint(outerRect.left + x, outerRect.top + y);
    const innerHit = doc.elementFromPoint(x, y);
    return {
      visible,
      disabled: element.disabled === true,
      x: outerRect.left + x,
      y: outerRect.top + y,
      outerIsFrame: outerHit === iframe,
      innerWithinElement: innerHit === element || element.contains(innerHit),
      label: element.getAttribute("aria-label") || element.textContent?.trim() || null,
    };
  }, { leafId, selector });
}

async function clickOwnedSelector(leafId, selector, label, timeoutMs = 45_000) {
  const target = await waitFor(`${label} to become a visible hit target`,
    () => selectorState(leafId, selector),
    (state) => state?.visible === true && state.disabled === false && state.outerIsFrame && state.innerWithinElement,
    timeoutMs);
  await verifyPageIdentity(page);
  await page.mouse.click(target.x, target.y, { button: "left" });
  await verifyPageIdentity(page);
  report.interactions.push({ action: label, selector, driver: "trusted Puppeteer page.mouse.click" });
  await persistReport();
  return target;
}

async function waitForMenu(leafId, selector) {
  return waitFor(`mobile toolbar menu ${selector} to open`, () => ownedEval(page, ({ leafId, selector }) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === leafId);
    const element = leaf?.view?.iframe?.contentDocument?.querySelector(selector);
    return !!element && element.hidden !== true && getComputedStyle(element).display !== "none";
  }, { leafId, selector }), (open) => open === true);
}

async function openSecondaryToolbar(leafId) {
  const isOpen = await ownedEval(page, (id) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === id);
    const menu = leaf?.view?.iframe?.contentDocument?.querySelector("#secondaryToolbar");
    return !!menu && !menu.classList.contains("hidden");
  }, leafId);
  if (!isOpen) {
    await clickOwnedSelector(
      leafId,
      "#secondaryToolbarToggleButton",
      "open native More menu",
    );
    await waitForMenu(leafId, "#secondaryToolbar:not(.hidden)");
  }
}

async function clickAction(leafId, action) {
  const selectors = {
    undo: "#pdfReaderBridgeUndoButton",
    redo: "#pdfReaderBridgeRedoButton",
    delete: "#pdfReaderBridgeDeleteButton",
    save: "#secondaryDownload",
  };
  const selector = selectors[action];
  if (!selector) throw new Error(`Unsupported native toolbar action: ${action}`);
  if (action === "delete" || action === "save") {
    await openSecondaryToolbar(leafId);
  }
  await clickOwnedSelector(leafId, selector, `native toolbar action ${action}`);
}

async function screenshot(label, outputPath) {
  await assertSingleAppPage();
  await page.screenshot({ path: outputPath, fullPage: false });
  report.screenshots[label] = outputPath;
  await persistReport();
}

async function fileHash() {
  return hash(await readFile(testFile));
}

async function closeOnlyOwnedReaders() {
  if (!page || page.isClosed() || !browser?.connected) return;
  await assertSingleAppPage();
  const readers = await ownedEval(page, () => {
    const rows = [];
    app.workspace.iterateAllLeaves?.((leaf) => {
      if (leaf?.view?.getViewType?.() === "pdf-web-reader-view") {
        rows.push({ id: leaf.id, path: leaf.view?.requestedPath || leaf.view?.file?.path || null });
      }
    });
    return rows;
  });
  const unexpected = readers.filter((reader) => !ownedLeafIds.has(reader.id) || reader.path !== testPath);
  if (unexpected.length) {
    report.cleanup.reader = "refused: an unexpected Reader appeared; no other view was closed";
    report.cleanup.unexpectedReaders = unexpected;
    throw new Error("Refusing to close or reload with an unexpected PDF Reader view.");
  }
  for (const reader of readers) {
    await ownedEval(page, async ({ id, path: ownedPath }) => {
      const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) =>
        candidate.id === id && (candidate.view?.requestedPath || candidate.view?.file?.path) === ownedPath);
      if (!leaf) return "already-closed";
      if (typeof leaf.detach !== "function") throw new Error("The owned Reader tab has no controlled detach method.");
      await leaf.detach();
      return "controlled-detach-requested";
    }, { id: reader.id, path: testPath });
    await waitFor(`owned Reader ${reader.id} to finish controlled close`, async () => {
      const rows = await readerForPath(testPath, reader.id);
      return { present: rows.length > 0, state: await readAppState(page) };
    }, (value) => !value.present && value.state.pluginViewCount === 0 && value.state.gates.length === 0, 30_000);
  }
  const after = await readAppState(page);
  assert.equal(after.allReaderCount, 0, "All Readers must be gone before restoring mobile emulation.");
  assert.equal(after.pluginViewCount, 0, "Plugin views must be empty before restoring mobile emulation.");
  assert.deepEqual(after.gates, [], "Popout close gates must be empty before restoring mobile emulation.");
  report.cleanup.reader = readers.length ? "controlled-close-complete" : "no-reader-open";
}

async function restoreAutoSaveIfNeeded() {
  if (!priorState || !page || page.isClosed() || !browser?.connected) return;
  await assertSingleAppPage();
  const state = await readAppState(page);
  if (state.autoSave === priorState.autoSave) return;
  await ownedEval(page, async (enabled) => {
    const plugin = app.plugins?.plugins?.["pdf-web-reader"];
    if (typeof plugin?.setAutoSaveEnabled !== "function") throw new Error("Could not restore the prior PDF Reader auto-save setting.");
    await plugin.setAutoSaveEnabled(enabled);
    if (plugin.settings.autoSave !== enabled) throw new Error("Auto-save setting did not return to its prior value.");
    return true;
  }, priorState.autoSave);
  report.cleanup.autoSaveRestored = priorState.autoSave;
}

async function restorePriorMode() {
  if (!modeTransitionStarted || !priorState) {
    report.cleanup.modeRestoration = "not-needed";
    return;
  }
  await ensureFreshBrowserConnection();
  await waitForVerifiedAppPage(verifiedAppTarget, null);
  const before = await readAppState(page);
  assert.equal(before.allReaderCount, 0, "Refusing to reload while a Reader is open.");
  assert.equal(before.pluginViewCount, 0, "Refusing to reload while plugin views are live.");
  assert.deepEqual(before.gates, [], "Refusing to reload while a popout close gate is live.");
  const restored = await transitionMobileMode(priorState.appMobile);
  assert.deepEqual(restored, {
    appMobile: priorState.appMobile,
    pluginMobile: priorState.pluginMobile,
    pluginEnabled: priorState.pluginEnabled,
    autoSave: priorState.autoSave,
  });
  report.cleanup.autoSaveRestored = priorState.autoSave;
  report.cleanup.modeRestoration = { status: "restored", ...restored };
}

async function cleanupOwnedFixture() {
  if (!createdFixture && !createdOwnedDirectory) return;
  if (!page || page.isClosed() || !browser?.connected) {
    report.cleanup.fixture = "retained: cannot verify the isolated vault connection";
    throw new Error("Refusing fixture cleanup after the verified Obsidian connection closed.");
  }
  await assertSingleAppPage();
  const readers = await readerForPath(testPath);
  assert.deepEqual(readers, [], "Refusing to remove the fixture while any Reader still has it open.");
  const hadFixture = createdFixture;
  if (createdFixture) {
    const fileStat = await stat(testFile);
    assert.ok(fileStat.isFile(), "Refusing to remove a non-file fixture path.");
    const currentHash = hash(await readFile(testFile));
    const allowedHashes = new Set([
      report.fixture.sha256Before,
      report.fixture.sha256AfterSave,
    ].filter((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)));
    assert.ok(allowedHashes.has(currentHash),
      "Refusing to remove the owned fixture after an unexpected PDF byte change.");
    await unlink(testFile);
    createdFixture = false;
  }
  if (createdOwnedDirectory) {
    await rmdir(ownedDirectory);
    createdOwnedDirectory = false;
  }
  report.cleanup.fixture = hadFixture ? "removed-owned-public-fixture" : "removed-owned-empty-directory";
}

async function compareFrozenProduct() {
  const distDirectory = path.join(root, "dist", "pdf-web-reader");
  const installDirectory = path.join(nativeConfig.vault, nativeConfig.configDir, "plugins", pluginId);
  const names = [
    ["main.js", "productMain"],
    ["manifest.json", "manifest"],
    ["styles.css", "styles"],
  ];
  const built = {};
  const installed = {};
  for (const [name, field] of names) {
    const [builtBytes, installedBytes] = await Promise.all([
      readFile(path.join(distDirectory, name)),
      readFile(path.join(installDirectory, name)),
    ]);
    built[name] = hash(builtBytes);
    installed[name] = hash(installedBytes);
    assert.equal(built[name], expected[field], `Built ${name} does not match the frozen product identity.`);
    assert.equal(installed[name], expected[field], `Installed ${name} does not match the frozen product identity.`);
  }
  const bridgeSha = hash(await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js")));
  assert.equal(bridgeSha, expected.bridge, "Bridge source does not match the frozen identity file.");
  report.product.observedSha256 = built;
  report.product.installedSha256 = installed;
  report.product.bridgeSha256 = bridgeSha;
  report.harness.observedSha256 = hash(await readFile(fileURLToPath(import.meta.url)));
  assert.equal(report.harness.observedSha256, expected.mobileControlsHarness,
    "Native mobile-controls harness differs from the source reviewed for the frozen identity file.");
}

async function attemptCleanup(name, operation) {
  try {
    await operation();
  } catch (error) {
    report.cleanup[name] = { status: "failed", message: String(error?.message || error) };
    report.status = report.status === "passed" ? "incomplete" : report.status;
    primaryError ||= error;
  }
}

async function run() {
  report.status = "running";
  assert.equal(nativeBuildSha, expected.productMain);
  await compareFrozenProduct();
  browser = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null, protocolTimeout: 30_000 });
  await assertSingleAppPage();
  const initial = await readAppState(page);
  assertNativeVaultIdentity(initial, nativeConfig);
  assert.deepEqual({ vault: initial.vault, configDir: initial.configDir, vaultName: initial.vaultName }, expectedIdentity);
  assert.equal(initial.pluginEnabled, true, "The frozen candidate plugin must already be enabled in the isolated test vault.");
  assert.equal(initial.pluginMobile, initial.appMobile,
    "The loaded plugin branch must match Obsidian's current app.isMobile value before testing.");
  assert.equal(initial.autoSave === false || initial.autoSave === true, true,
    "The prior auto-save preference must be a real boolean.");
  assert.deepEqual(initial.readerPaths, [], "Close every Reader before starting this isolated mobile test.");
  assert.equal(initial.allReaderCount, 0);
  assert.equal(initial.pluginViewCount, 0);
  assert.deepEqual(initial.gates, []);
  assert.equal(initial.canEmulateMobile, true, "The isolated Obsidian test build must expose app.emulateMobile().");
  priorState = initial;
  report.initialState = {
    appMobile: initial.appMobile,
    pluginMobile: initial.pluginMobile,
    pluginEnabled: initial.pluginEnabled,
    autoSave: initial.autoSave,
    allReaderCount: initial.allReaderCount,
    pluginViewCount: initial.pluginViewCount,
    gateCount: initial.gates.length,
  };
  await persistReport();

  if (!initial.appMobile) {
    const selected = await switchMobileMode(true);
    report.mobileState = selected;
  } else {
    assert.equal(initial.pluginMobile, true);
    report.mobileState = { appMobile: true, pluginMobile: true, reusedExistingMode: true };
  }
  await assertSingleAppPage();
  const mobileState = await readAppState(page);
  assert.equal(mobileState.appMobile, true);
  assert.equal(mobileState.pluginMobile, true,
    "The actual plugin loader must select mobile mode after Obsidian mobile emulation and reload.");
  assert.equal(mobileState.autoSave, priorState.autoSave);
  assert.equal(mobileState.allReaderCount, 0);
  assert.equal(mobileState.pluginViewCount, 0);
  assert.deepEqual(mobileState.gates, []);

  await mkdir(path.dirname(ownedDirectory), { recursive: true });
  await mkdir(ownedDirectory);
  createdOwnedDirectory = true;
  await copyFile(fixture, testFile, constants.COPYFILE_EXCL);
  createdFixture = true;
  const sourceBytes = await readFile(testFile);
  report.fixture.sha256Before = hash(sourceBytes);
  report.fixture.bytes = sourceBytes.byteLength;
  await persistReport();

  const indexed = await waitFor("the unique public TraceMonkey fixture to enter the test vault index", () =>
    ownedEval(page, (relativePath) => !!app.vault.getAbstractFileByPath(relativePath), testPath), (value) => value === true);
  assert.equal(indexed, true);
  const leafId = await openOwnedReader(testPath);
  report.fixture.leafId = leafId;
  await screenshot("after-open", screenshotPaths.opened);
  const mobileControls = await ownedEval(page, (id) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === id);
    const doc = leaf?.view?.iframe?.contentDocument;
    const nativeToolIds = [
      "editorUnderlineButton",
      "editorSquareButton",
      "editorHighlightButton",
      "editorInkButton",
      "editorFreeTextButton",
    ];
    const nativeTools = nativeToolIds.filter((id) =>
      doc?.getElementById(id)?.getClientRects().length > 0,
    );
    const actionButtons = [...(doc?.querySelectorAll(
      ".pdfReaderBridgeHistoryButton[data-action], #pdfReaderBridgeDeleteButton[data-action]",
    ) || [])]
      .map((button) => button.dataset.action);
    const bridgeControls = [...(doc?.querySelectorAll(
      ".pdfReaderBridgeControls .pdfReaderBridgeControlButton",
    ) || [])].map((button) => button.textContent.trim());
    return {
      loaderMode: leaf?.view?.mobileRuntime?.loaderMode || null,
      nativeTools,
      actionNames: actionButtons,
      bridgeControls,
      historyControls: ["pdfReaderBridgeUndoButton", "pdfReaderBridgeRedoButton"].map((id) => {
        const button = doc?.getElementById(id);
        const rect = button?.getBoundingClientRect();
        return button && {
          id,
          action: button.dataset.action,
          label: button.textContent.trim(),
          width: rect?.width || 0,
          height: rect?.height || 0,
          connected: button.isConnected,
        };
      }),
      deleteLocation: doc?.getElementById("pdfReaderBridgeDeleteButton")?.parentElement?.id || null,
      saveLabel: doc?.getElementById("secondaryDownload")?.querySelector("span")?.textContent?.trim() || null,
      floatingEditMenuPresent: !!doc?.querySelector(".pdfReaderBridgeActionMenu"),
      bridgeClickWheelPresent: !!doc?.querySelector(".pdfReaderBridgeClickWheel"),
    };
  }, leafId);
  assert.equal(mobileControls.loaderMode, "mobile-blob");
  assert.deepEqual(mobileControls.nativeTools, [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
  ]);
  assert.deepEqual(mobileControls.actionNames, ["undo", "redo", "delete"]);
  assert.deepEqual(mobileControls.bridgeControls, ["↶", "↷"]);
  assert.deepEqual(mobileControls.historyControls, [
    { id: "pdfReaderBridgeUndoButton", action: "undo", label: "↶", width: 32, height: 28, connected: true },
    { id: "pdfReaderBridgeRedoButton", action: "redo", label: "↷", width: 32, height: 28, connected: true },
  ]);
  assert.equal(mobileControls.deleteLocation, "secondaryToolbarButtonContainer");
  assert.equal(mobileControls.saveLabel, "保存到仓库");
  assert.equal(mobileControls.floatingEditMenuPresent, false);
  assert.equal(mobileControls.bridgeClickWheelPresent, false);
  report.interactions.push({ action: "mobile bridge controls rendered", ...mobileControls });
  await persistReport();

  autoSaveChangeRequired = priorState.autoSave !== false;
  const autoSaveDisabled = await ownedEval(page, async () => {
    const plugin = app.plugins.plugins["pdf-web-reader"];
    await plugin.setAutoSaveEnabled(false);
    return { autoSave: plugin.settings.autoSave, persisted: (await plugin.loadData())?.autoSave };
  });
  assert.deepEqual(autoSaveDisabled, { autoSave: false, persisted: false });

  await clickOwnedSelector(leafId, "#editorSquareButton", "select Square from the native mobile tools");
  await waitFor("Square editor mode from the native mobile tools", () => readerState(leafId),
    (state) => state.editorMode === 5);

  const draw = await waitFor("a visible PDF page region with unobstructed native draw endpoints", () =>
    ownedEval(page, ({ id, path: ownedPath }) => {
      const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) =>
        candidate.id === id && (candidate.view?.requestedPath || candidate.view?.file?.path) === ownedPath);
      const view = leaf?.view;
      const iframe = view?.iframe;
      const doc = iframe?.contentDocument;
      const win = iframe?.contentWindow;
      const pdfApp = win?.PDFViewerApplication;
      const pdfViewer = pdfApp?.pdfViewer;
      const pageView = pdfViewer?.getPageView?.(0);
      const pdfPage = doc?.querySelector(".page[data-page-number='1']");
      const container = doc?.getElementById("viewerContainer");
      const layer = pageView?.annotationEditorLayer?.div;
      if (!iframe || !doc || !pdfViewer || !pdfPage || !container || !layer) return null;
      if (pdfViewer.annotationEditorMode !== 5 || pageView.div !== pdfPage ||
        pageView.renderingState !== 3 || pdfPage.dataset.loaded !== "true" ||
        pdfPage.classList.contains("loading") || pdfPage.classList.contains("loadingIcon") ||
        !layer.isConnected || layer.parentElement !== pdfPage ||
        !layer.classList.contains("creationPriority")) return null;

      // Keep PDF.js's page in the viewer's own scroll viewport. scrollIntoView()
      // can also scroll the containing app pane and center the page underneath
      // the fixed PDF toolbar, producing coordinates that are in the iframe but
      // outside the actual annotation layer hit area.
      container.scrollTop = 0;
      const frameRect = iframe.getBoundingClientRect();
      const pageRect = pdfPage.getBoundingClientRect();
      const layerRect = layer.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const viewerRect = {
        left: containerRect.left + container.clientLeft,
        top: containerRect.top + container.clientTop,
        right: containerRect.left + container.clientLeft + container.clientWidth,
        bottom: containerRect.top + container.clientTop + container.clientHeight,
      };
      const intersect = (a, b) => ({
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
      });
      const visiblePage = intersect(intersect(pageRect, layerRect), viewerRect);
      if (visiblePage.right - visiblePage.left < 150 || visiblePage.bottom - visiblePage.top < 100) return null;

      const hostViewport = {
        left: 0,
        top: 0,
        right: document.documentElement.clientWidth,
        bottom: document.documentElement.clientHeight,
      };
      const frameInHost = {
        left: frameRect.left,
        top: frameRect.top,
        right: frameRect.right,
        bottom: frameRect.bottom,
      };
      const visibleFrame = intersect(frameInHost, hostViewport);
      const width = Math.min(110, Math.floor(visiblePage.right - visiblePage.left - 24));
      const height = Math.min(72, Math.floor(visiblePage.bottom - visiblePage.top - 24));
      if (width < 60 || height < 40 || visibleFrame.right <= visibleFrame.left || visibleFrame.bottom <= visibleFrame.top) return null;

      const visibleOverlays = [...doc.querySelectorAll(
        ".editorParamsToolbar, #secondaryToolbar:not(.hidden)",
      )].filter((element) => {
        const style = win.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }).map((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      });
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const layerHitAt = (point) => {
        const hit = doc.elementFromPoint(point.x, point.y);
        return hit === layer || layer.contains(hit);
      };
      const frameHitAt = (point) => {
        const x = frameRect.left + point.x;
        const y = frameRect.top + point.y;
        return x >= visibleFrame.left && x < visibleFrame.right &&
          y >= visibleFrame.top && y < visibleFrame.bottom && document.elementFromPoint(x, y) === iframe;
      };

      // Search a bounded grid in the actually visible viewer region. Each
      // candidate is checked against both documents and visible parameter/menu
      // overlays before any trusted mouse gesture is sent.
      for (const fy of [0.16, 0.30, 0.44, 0.58, 0.70]) {
        for (const fx of [0.12, 0.28, 0.44, 0.60]) {
          const startInner = {
            x: visiblePage.left + (visiblePage.right - visiblePage.left - width) * fx,
            y: visiblePage.top + (visiblePage.bottom - visiblePage.top - height) * fy,
          };
          const endInner = { x: startInner.x + width, y: startInner.y + height };
          const drawBounds = {
            left: startInner.x,
            top: startInner.y,
            right: endInner.x,
            bottom: endInner.y,
          };
          if (visibleOverlays.some((rect) => overlaps(drawBounds, rect))) continue;
          if (!layerHitAt(startInner) || !layerHitAt(endInner) ||
            !frameHitAt(startInner) || !frameHitAt(endInner)) continue;
          let pathHit = true;
          for (let step = 1; step < 12; step += 1) {
            const point = {
              x: startInner.x + ((endInner.x - startInner.x) * step) / 12,
              y: startInner.y + ((endInner.y - startInner.y) * step) / 12,
            };
            if (!layerHitAt(point) || !frameHitAt(point)) {
              pathHit = false;
              break;
            }
          }
          if (!pathHit) continue;
          return {
            start: { x: frameRect.left + startInner.x, y: frameRect.top + startInner.y },
            end: { x: frameRect.left + endInner.x, y: frameRect.top + endInner.y },
            width,
            height,
            outerIsFrame: true,
            layerHit: true,
            startOuterIsFrame: true,
            endOuterIsFrame: true,
            startLayerHit: true,
            endLayerHit: true,
            pathHit,
            visibleViewerBounds: {
              top: viewerRect.top,
              bottom: viewerRect.bottom,
              pageTop: pageRect.top,
              pageBottom: pageRect.bottom,
            },
            pageLoaded: true,
            devicePixelRatio: win.devicePixelRatio || 1,
          };
        }
      }
      return null;
    }, { id: leafId, path: testPath }),
  (state) => state?.outerIsFrame && state.layerHit && state.startOuterIsFrame &&
    state.endOuterIsFrame && state.startLayerHit && state.endLayerHit && state.pathHit && state.pageLoaded,
  30_000);
  assert.ok(draw?.outerIsFrame && draw.layerHit && draw.startOuterIsFrame && draw.endOuterIsFrame &&
    draw.startLayerHit && draw.endLayerHit && draw.pathHit,
  `The real mouse draw must follow visible owned-PDF annotation-layer hits: ${JSON.stringify(draw)}`);
  assert.ok(draw.width >= 60 && draw.height >= 40, "The test fixture page must have enough visible room for a Square.");
  await verifyPageIdentity(page);
  await page.mouse.move(draw.start.x, draw.start.y);
  await page.mouse.down({ button: "left" });
  try {
    await page.mouse.move(draw.end.x, draw.end.y, { steps: 12 });
  } finally {
    await page.mouse.up({ button: "left" });
  }
  await verifyPageIdentity(page);
  report.interactions.push({
    action: "draw Square",
    driver: "trusted Puppeteer page.mouse drag",
    geometry: {
      width: draw.width,
      height: draw.height,
      outerIsFrame: draw.outerIsFrame,
      layerHit: draw.layerHit,
    },
  });
  const squareAfterDraw = await waitFor("the trusted mouse drag to create one PDF.js Square", () => readerState(leafId),
    (state) => state.editorTypes.filter((type) => type === 5).length === 1 && state.editorMode === 5);
  assert.deepEqual(squareAfterDraw.editorTypes, [5]);
  await screenshot("square-created-before-undo", screenshotPaths.created);

  await clickAction(leafId, "undo");
  const afterUndo = await waitFor("direct mobile undo to remove the Square model", () => readerState(leafId),
    (state) => state.editorTypes.length === 0 && state.editorMode === 5);
  assert.deepEqual(afterUndo.editorTypes, []);
  report.interactions.push({ action: "undo Square through direct mobile toolbar control", editorTypes: afterUndo.editorTypes });

  await clickAction(leafId, "redo");
  const afterRedo = await waitFor("direct mobile redo to restore the Square model", () => readerState(leafId),
    (state) => state.editorTypes.filter((type) => type === 5).length === 1 && state.editorMode === 5);
  assert.deepEqual(afterRedo.editorTypes, [5]);
  report.interactions.push({ action: "redo Square through direct mobile toolbar control", editorTypes: afterRedo.editorTypes });

  const beforeManualSave = await fileHash();
  assert.equal(beforeManualSave, report.fixture.sha256Before,
    "Auto-save is disabled, so undo/redo must not write fixture bytes before the explicit Save control.");
  await clickAction(leafId, "save");
  const saved = await waitFor("native More-menu Save to change the owned PDF bytes and settle the revision", async () => {
    const [currentHash, state] = await Promise.all([fileHash(), readerState(leafId)]);
    return { hash: currentHash, ...state };
  }, (state) => state.hash !== report.fixture.sha256Before && !state.saving && state.ready && state.currentRevision === state.confirmedRevision && state.pdfHasChanges === false, 60_000);
  report.fixture.sha256AfterSave = saved.hash;
  assert.notEqual(saved.hash, report.fixture.sha256Before, "Manual save must write changed PDF bytes.");
  report.interactions.push({ action: "manual Save through native More menu", revision: saved.currentRevision, confirmedRevision: saved.confirmedRevision, sha256AfterSave: saved.hash });
  await persistReport();
  await screenshot("after-manual-save", screenshotPaths.saved);

  const priorDiagnostics = await ownedEval(page, (folder) => {
    const directory = app.vault.getAbstractFileByPath(folder);
    return (directory?.children || []).map((file) => file.path);
  }, "PDF Reader Diagnostics");
  const exportedPath = await ownedEval(page, async () => {
    const plugin = app.plugins.plugins["pdf-web-reader"];
    if (typeof plugin?.exportMobileDiagnostics !== "function") throw new Error("The mobile diagnostics export method is unavailable.");
    return await plugin.exportMobileDiagnostics();
  });
  assert.equal(typeof exportedPath, "string");
  assert.match(exportedPath, /^PDF Reader Diagnostics\/PDF Reader diagnostics .*\.json$/);
  assert.ok(!priorDiagnostics.includes(exportedPath), "The diagnostics export must be a new JSON file created by this run.");
  const diagnosticText = await ownedEval(page, async (diagnosticsPath) => {
    const file = app.vault.getAbstractFileByPath(diagnosticsPath);
    if (!file || file.extension?.toLowerCase() !== "json") throw new Error("Exported mobile diagnostics JSON is missing.");
    return new TextDecoder().decode(await app.vault.readBinary(file));
  }, exportedPath);
  const diagnostic = JSON.parse(diagnosticText);
  assertDiagnosticPrivacy(diagnostic);
  assert.equal(diagnostic.schema, 1);
  assert.equal(diagnostic.platform.mobile, true);
  assert.equal(diagnostic.platform.loaderMode, "mobile-blob");
  assert.ok(diagnostic.browser && typeof diagnostic.browser === "object");
  assert.ok(diagnostic.browser.userAgent === null ||
    (typeof diagnostic.browser.userAgent === "string" && diagnostic.browser.userAgent.length <= 256));
  const expectedCapabilities = [
    "blob",
    "objectUrl",
    "worker",
    "pointerEvents",
    "textEncoder",
    "decompressionStream",
    "gzipDecompression",
  ];
  assert.deepEqual(Object.keys(diagnostic.browser.capabilities).sort(), [...expectedCapabilities].sort());
  for (const capability of expectedCapabilities) {
    assert.equal(diagnostic.browser.capabilities[capability], true, `Mobile loader capability ${capability} is unavailable.`);
  }
  assert.equal(diagnostic.activeReaderCount, 1);
  assert.equal(diagnostic.readers.length, 1);
  assert.equal(diagnostic.readers[0].stage, "ready");
  assert.ok(typeof diagnostic.readers[0].assets.version === "string" && diagnostic.readers[0].assets.version.length > 0 && diagnostic.readers[0].assets.version.length <= 64);
  assert.match(diagnostic.readers[0].assets.contentHash || "", /^[a-f0-9]{64}$/);
  assert.ok(diagnostic.readers[0].assets.resourceCount > 0);
  assert.ok(diagnostic.readers[0].assets.resourceCount <= 10_000);
  assert.equal(diagnostic.readers[0].resourceFailureCount, 0);
  assert.ok(Number.isSafeInteger(diagnostic.readers[0].revokedResourceCount) && diagnostic.readers[0].revokedResourceCount >= 0 && diagnostic.readers[0].revokedResourceCount <= 10_000);
  assert.equal(diagnostic.readers[0].lastError, null);
  assert.ok(["resource", "blob"].includes(diagnostic.readers[0].modules.pdf));
  assert.ok(["resource", "blob"].includes(diagnostic.readers[0].modules.viewer));
  assert.equal(diagnostic.readers[0].worker.source, "blob");
  assert.equal(diagnostic.readers[0].worker.terminated, false);
  const input = diagnostic.readers[0].input;
  assert.ok(input && input.schema === 1, "The actual diagnostics export must include the bridge pointer snapshot.");
  assert.ok(Number.isSafeInteger(input.pointerEventsSeen) && input.pointerEventsSeen > 0);
  assert.ok(Number.isSafeInteger(input.pointerEventsDropped) && input.pointerEventsDropped >= 0);
  assert.ok(Number.isSafeInteger(input.activePointers) && input.activePointers >= 0 && input.activePointers <= 64);
  assert.ok(Array.isArray(input.pointers) && input.pointers.length > 0 && input.pointers.length <= 32);
  const pointerFields = ["activePointers", "button", "buttons", "editorMode", "pointerType", "trusted", "type"];
  for (const pointer of input.pointers) {
    assert.deepEqual(Object.keys(pointer).sort(), pointerFields);
    assert.ok(["pointerdown", "pointermove", "pointerup", "pointercancel"].includes(pointer.type));
    assert.ok(["mouse", "touch", "pen", "unknown"].includes(pointer.pointerType));
    assert.ok(Number.isInteger(pointer.button) && pointer.button >= -1 && pointer.button <= 31);
    assert.ok(Number.isInteger(pointer.buttons) && pointer.buttons >= 0 && pointer.buttons <= 255);
    assert.ok(Number.isInteger(pointer.activePointers) && pointer.activePointers >= 0 && pointer.activePointers <= 64);
    assert.ok(Number.isInteger(pointer.editorMode) && pointer.editorMode >= 0 && pointer.editorMode <= 1024);
    assert.equal(typeof pointer.trusted, "boolean");
  }
  assert.ok(input.pointers.some((pointer) => pointer.trusted && pointer.pointerType === "mouse" && pointer.type === "pointerdown"),
    "Exported diagnostics must contain a trusted Puppeteer mouse pointerdown.");
  report.diagnostics = {
    path: exportedPath,
    privacyChecked: true,
    input: {
      pointerEventsSeen: input.pointerEventsSeen,
      pointerEventsDropped: input.pointerEventsDropped,
      activePointers: input.activePointers,
      sampleCount: input.pointers.length,
      trustedMouseDownObserved: true,
    },
    loader: {
      stage: diagnostic.readers[0].stage,
      moduleSources: diagnostic.readers[0].modules,
      workerSource: diagnostic.readers[0].worker.source,
      browserCapabilities: diagnostic.browser.capabilities,
    },
  };
  report.cleanup.diagnostic = "retained-for-user";
  await persistReport();

  const closedForReopen = await ownedEval(page, async ({ id, path: ownedPath }) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) =>
      candidate.id === id && (candidate.view?.requestedPath || candidate.view?.file?.path) === ownedPath);
    if (!leaf) throw new Error("The original owned Reader disappeared before save/reopen verification.");
    await leaf.detach();
    return true;
  }, { id: leafId, path: testPath });
  assert.equal(closedForReopen, true);
  await waitFor("the saved fixture's original Reader to close cleanly", async () => {
    const [matches, state] = await Promise.all([readerForPath(testPath), readAppState(page)]);
    return { matches, state };
  }, (value) => value.matches.length === 0 && value.state.pluginViewCount === 0 && value.state.gates.length === 0, 30_000);

  const reopenedLeafId = await openOwnedReader(testPath);
  report.fixture.reopenedLeafId = reopenedLeafId;
  const [reopenedInitialState, reopenedInitialRender] = await Promise.all([
    readerState(reopenedLeafId),
    reopenedPageState(reopenedLeafId),
  ]);
  const reopenedBeforeNavigation = { state: reopenedInitialState, rendered: reopenedInitialRender };
  report.fixture.reopenedBeforeNavigation = {
    activeLeafId: reopenedBeforeNavigation.rendered.activeLeafId,
    leafId: reopenedBeforeNavigation.rendered.leafId,
    leafIsActive: reopenedBeforeNavigation.rendered.leafIsActive,
    iframeConnected: reopenedBeforeNavigation.rendered.iframeConnected,
    iframeBounds: reopenedBeforeNavigation.rendered.iframeBounds,
    iframeVisibleInHostViewport: reopenedBeforeNavigation.rendered.iframeVisibleInHostViewport,
    hostViewport: reopenedBeforeNavigation.rendered.hostViewport,
    frameViewport: reopenedBeforeNavigation.rendered.frameViewport,
    viewerBounds: reopenedBeforeNavigation.rendered.viewerBounds,
    viewerVisibleInFrame: reopenedBeforeNavigation.rendered.viewerVisibleInFrame,
    pageBounds: reopenedBeforeNavigation.rendered.pageBounds,
    pageIntersectsViewer: reopenedBeforeNavigation.rendered.pageIntersectsViewer,
    currentPageNumber: reopenedBeforeNavigation.rendered.currentPageNumber,
    pageNumber: reopenedBeforeNavigation.rendered.pageNumber,
    numPages: reopenedBeforeNavigation.rendered.numPages,
    renderingState: reopenedBeforeNavigation.rendered.renderingState,
    pageLoaded: reopenedBeforeNavigation.rendered.pageLoaded,
    pageMatchesView: reopenedBeforeNavigation.rendered.pageMatchesView,
    annotationLayerConnected: reopenedBeforeNavigation.rendered.annotationLayerConnected,
    annotationLayerRendered: reopenedBeforeNavigation.rendered.annotationLayerRendered,
    previousButton: reopenedBeforeNavigation.rendered.previousButton,
  };
  await persistReport();
  assert.equal(reopenedBeforeNavigation.rendered.leafId, reopenedLeafId,
    "The post-reopen probe must inspect the exact owned Reader leaf.");
  assert.equal(reopenedBeforeNavigation.rendered.activeLeafId, reopenedLeafId,
    "The host UI must keep the reopened owned Reader leaf active.");
  assert.equal(reopenedBeforeNavigation.rendered.leafIsActive, true,
    "The reopened PDF frame must belong to the active host leaf.");
  assert.ok(reopenedBeforeNavigation.state.ready && reopenedBeforeNavigation.state.pages > 0 &&
    reopenedBeforeNavigation.rendered.leafFound &&
    reopenedBeforeNavigation.rendered.subtypes.filter((subtype) => subtype === "Square").length === 1 &&
    reopenedBeforeNavigation.rendered.squareAnnotations.length === 1 &&
    reopenedBeforeNavigation.rendered.squareAnnotations[0].id,
  "The reopened owned Reader must contain the saved Square before render verification.");
  assert.ok(reopenedBeforeNavigation.rendered.iframeConnected &&
    reopenedBeforeNavigation.rendered.iframeBounds?.width > 0 &&
    reopenedBeforeNavigation.rendered.iframeBounds?.height > 0 &&
    reopenedBeforeNavigation.rendered.iframeVisibleInHostViewport,
  "The active owned Reader iframe must have non-zero geometry inside the host viewport.");
  assert.ok(reopenedBeforeNavigation.rendered.frameViewport?.width > 0 &&
    reopenedBeforeNavigation.rendered.frameViewport?.height > 0 &&
    reopenedBeforeNavigation.rendered.viewerVisibleInFrame,
  "The PDF.js viewer must have a non-zero viewport inside the active Reader frame.");
  assert.ok(reopenedBeforeNavigation.rendered.numPages > 0 &&
    Number.isInteger(reopenedBeforeNavigation.rendered.currentPageNumber) &&
    reopenedBeforeNavigation.rendered.currentPageNumber >= 1 &&
    reopenedBeforeNavigation.rendered.currentPageNumber <= reopenedBeforeNavigation.rendered.numPages,
  "PDF.js must report a valid current page after reopening.");

  let navigationState = reopenedBeforeNavigation.rendered;
  const navigationDeadline = Date.now() + 30_000;
  for (let step = 0; navigationState.currentPageNumber > 1 && step < navigationState.numPages - 1; step += 1) {
    const fromPage = navigationState.currentPageNumber;
    const remainingMs = navigationDeadline - Date.now();
    assert.ok(remainingMs > 0, "Trusted Previous-button navigation to page 1 exceeded its 30-second setup budget.");
    await clickOwnedSelector(reopenedLeafId, "#previous", `navigate reopened PDF from page ${fromPage} to Previous`, Math.min(5_000, remainingMs));
    const moveTimeoutMs = Math.min(5_000, navigationDeadline - Date.now());
    assert.ok(moveTimeoutMs > 0, "Trusted Previous-button navigation to page 1 exceeded its 30-second setup budget.");
    navigationState = await waitFor(`trusted Previous-button click to move from page ${fromPage} toward page 1`,
      () => reopenedPageState(reopenedLeafId),
      (value) => value.leafIsActive && value.currentPageNumber !== null && value.currentPageNumber < fromPage,
      moveTimeoutMs);
    report.fixture.pageNavigation.push({
      button: "#previous",
      driver: "trusted Puppeteer page.mouse.click",
      fromPage,
      toPage: navigationState.currentPageNumber,
    });
    await persistReport();
  }
  assert.equal(navigationState.currentPageNumber, 1,
    "The reopened render verification must reach page 1 using at most numPages - 1 trusted Previous-button clicks.");
  report.fixture.reopenedAtPageOne = {
    currentPageNumber: navigationState.currentPageNumber,
    numPages: navigationState.numPages,
    leafIsActive: navigationState.leafIsActive,
    iframeBounds: navigationState.iframeBounds,
    frameViewport: navigationState.frameViewport,
    viewerBounds: navigationState.viewerBounds,
    viewerVisibleInFrame: navigationState.viewerVisibleInFrame,
    pageBounds: navigationState.pageBounds,
    pageIntersectsViewer: navigationState.pageIntersectsViewer,
    previousButton: navigationState.previousButton,
    renderingState: navigationState.renderingState,
    pageLoaded: navigationState.pageLoaded,
  };
  await persistReport();

  const reopened = await waitFor("the reopened PDF to render the saved Square annotation on page 1", async () => {
    const [state, rendered] = await Promise.all([
      readerState(reopenedLeafId),
      reopenedPageState(reopenedLeafId),
    ]);
    return { state, rendered };
  }, (value) => value.state.ready && value.rendered.leafIsActive && value.rendered.currentPageNumber === 1 &&
    value.rendered.pageIntersectsViewer && value.rendered.pageNumber === 1 &&
    value.rendered.renderingState === 3 && value.rendered.pageLoaded && value.rendered.pageMatchesView &&
    value.rendered.annotationLayerConnected && value.rendered.annotationLayerRendered &&
    value.rendered.subtypes.filter((subtype) => subtype === "Square").length === 1 &&
    value.rendered.squareAnnotations.length === 1 && value.rendered.squareAnnotations[0].id &&
    value.rendered.squareAnnotations[0].rendered && value.rendered.squareAnnotations[0].visible &&
    value.rendered.squareAnnotations[0].hasSvgRect);
  report.fixture.reopenedSquareCount = reopened.rendered.squareAnnotations.length;
  report.fixture.reopenedAnnotationId = reopened.rendered.squareAnnotations[0].id;
  report.fixture.reopenedAnnotationSubtypes = reopened.rendered.subtypes;
  report.fixture.reopenedRenderedSquare = reopened.rendered.squareAnnotations[0];
  report.fixture.reopenedPageRender = {
    activeLeafId: reopened.rendered.activeLeafId,
    leafId: reopened.rendered.leafId,
    leafIsActive: reopened.rendered.leafIsActive,
    iframeBounds: reopened.rendered.iframeBounds,
    hostViewport: reopened.rendered.hostViewport,
    frameViewport: reopened.rendered.frameViewport,
    viewerBounds: reopened.rendered.viewerBounds,
    viewerVisibleInFrame: reopened.rendered.viewerVisibleInFrame,
    pageBounds: reopened.rendered.pageBounds,
    pageIntersectsViewer: reopened.rendered.pageIntersectsViewer,
    previousButton: reopened.rendered.previousButton,
    currentPageNumber: reopened.rendered.currentPageNumber,
    numPages: reopened.rendered.numPages,
    pageNumber: reopened.rendered.pageNumber,
    renderingState: reopened.rendered.renderingState,
    pageLoaded: reopened.rendered.pageLoaded,
    pageMatchesView: reopened.rendered.pageMatchesView,
    annotationLayerConnected: reopened.rendered.annotationLayerConnected,
    annotationLayerRendered: reopened.rendered.annotationLayerRendered,
    editorTypes: reopened.state.editorTypes,
  };
  assert.equal(reopened.rendered.subtypes.filter((subtype) => subtype === "Square").length, 1);
  assert.equal(reopened.rendered.squareAnnotations.length, 1);
  assert.ok(reopened.rendered.squareAnnotations[0].rendered && reopened.rendered.squareAnnotations[0].visible &&
    reopened.rendered.squareAnnotations[0].hasSvgRect,
  "The saved Square must appear as a visible native annotation-layer element after reopening.");
  assert.equal(reopened.rendered.subtypes.filter((subtype) => subtype === "Square").length, 1);
  const reopenedHash = await fileHash();
  assert.equal(reopenedHash, saved.hash, "Reopen must use the exact bytes written by manual Save.");
  report.fixture.sha256AfterReopen = reopenedHash;
  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  await screenshot("reopened-square", screenshotPaths.reopened);
}

try {
  await run();
} catch (error) {
  primaryError = error;
  report.status = "failed";
  report.error = error?.stack || String(error);
} finally {
  if (modeTransitionStarted) {
    try {
      // Reacquire the exact target after app.emulateMobile() before any cleanup
      // reads state from the renderer. Electron reloads may not complete the
      // Puppeteer navigation lifecycle on the original CDP session.
      await waitForVerifiedAppPage(verifiedAppTarget, null);
    } catch (error) {
      report.cleanup.modeReconnect = { status: "failed", message: String(error?.message || error) };
      primaryError ||= error;
      if (report.status === "passed") report.status = "incomplete";
    }
  }
  if (browser?.connected && page && !page.isClosed()) {
    await attemptCleanup("reader", closeOnlyOwnedReaders);
    await attemptCleanup("autoSave", restoreAutoSaveIfNeeded);
    if (createdFixture || createdOwnedDirectory) {
      await attemptCleanup("fixture", async () => {
        const remaining = await readerForPath(testPath);
        if (remaining.length === 0) {
          await cleanupOwnedFixture();
        } else {
          report.cleanup.fixture = "retained: still open in a Reader";
          throw new Error("Refusing to remove the owned fixture while a Reader still has it open.");
        }
      });
    }
    await attemptCleanup("modeRestoration", restorePriorMode);
  } else {
    if (modeTransitionStarted) await attemptCleanup("modeRestoration", restorePriorMode);
    if (autoSaveChangeRequired && report.cleanup.autoSaveRestored !== priorState?.autoSave) {
      report.cleanup.autoSave = "unavailable: Obsidian connection is closed";
      primaryError ||= new Error("Could not restore auto-save because the verified Obsidian connection is closed.");
      if (report.status === "passed") report.status = "incomplete";
    }
    if (modeTransitionStarted && !report.cleanup.modeRestoration) {
      report.cleanup.modeRestoration = "unavailable: Obsidian connection is closed";
      primaryError ||= new Error("Could not restore Obsidian mobile mode because its verified connection is closed.");
      if (report.status === "passed") report.status = "incomplete";
    }
    if (createdFixture || createdOwnedDirectory) {
      report.cleanup.fixture = "retained: cannot verify the isolated vault connection";
      primaryError ||= new Error("Could not remove the owned fixture because the verified Obsidian connection is closed.");
      if (report.status === "passed") report.status = "incomplete";
    }
  }
  if (browser?.connected) await browser.disconnect().catch(() => {});
  report.finishedAt ||= new Date().toISOString();
  if (primaryError && report.status === "running") report.status = "failed";
  await persistReport().catch((persistError) => {
    primaryError ||= persistError;
  });
}

console.log(`Report: ${reportPath}`);
console.log(`Status: ${report.status}`);
if (report.diagnostics.path) console.log(`Retained diagnostics: ${report.diagnostics.path}`);
if (primaryError) throw primaryError;
if (report.status !== "passed") throw new Error(`Native mobile-controls test did not pass: ${report.status}`);
