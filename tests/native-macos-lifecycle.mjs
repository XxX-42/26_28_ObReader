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
const nativeToolbarButtonIds = [
  "editorUnderlineButton",
  "editorSquareButton",
  "editorHighlightButton",
  "editorInkButton",
  "editorFreeTextButton",
];
const nativeToolbarPopupPairs = [
  { buttonId: "editorUnderlineButton", popupId: "editorUnderlineParamsToolbar" },
  { buttonId: "editorSquareButton", popupId: "editorSquareParamsToolbar" },
];
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
const nativeBeforeUnloadObservers = new Map();
const nativePopoutCloseAttempts = new Map();
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

async function persistPopoutCheckpoint(evidence, step, details = {}) {
  evidence.steps ||= [];
  evidence.steps.push({ step, at: new Date().toISOString(), ...details });
  evidence.lastCompletedStep = step;
  evidence.updatedAt = new Date().toISOString();
  await persistReport();
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
  try {
    // Renderer snippets are source expressions (usually an IIFE). Compile the
    // exact string locally before touching the live WebView so a malformed
    // harness probe cannot consume a native-test attempt or leave the Reader
    // in an intermediate state.
    new Function(`return (${expression});`);
  } catch (error) {
    const preview = String(expression).replace(/\s+/g, " ").slice(0, 240);
    throw new SyntaxError(
      `Invalid native renderer expression before CDP evaluation: ${preview}`,
      { cause: error },
    );
  }
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

async function evaluateBounded(page, expression, description, timeoutMs = 10_000) {
  return withNativeCdpDeadline(
    description,
    () => evaluate(page, expression),
    timeoutMs,
  );
}

async function evaluateJsonBounded(page, expression, description, timeoutMs = 10_000) {
  const value = await evaluateBounded(page, expression, description, timeoutMs);
  assert.equal(typeof value, "string", "Expected a JSON string from Obsidian.");
  return JSON.parse(value);
}

async function waitForBounded(
  description,
  probe,
  predicate = Boolean,
  timeoutMs = 30_000,
  probeTimeoutMs = 8_000,
) {
  return waitFor(
    description,
    () => withNativeCdpDeadline(
      `probe: ${description}`,
      () => probe(),
      probeTimeoutMs,
    ),
    predicate,
    timeoutMs,
  );
}

async function popoutCloseGateState(page, description = "read the owned popout close gate") {
  return evaluateJsonBounded(page, `(() => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const entries = [...(plugin?.popoutCloseGates?.entries?.() || [])]
      .filter(([owner]) => owner === window);
    const gates = entries.map(([owner, gate]) => {
      let live = [];
      try { live = plugin.popoutViewsForGate?.(gate) || []; } catch {}
      const memberViews = [...(gate.views || [])].map(view => {
        const candidates = new Set();
        try { candidates.add(view.leaf?.getContainer?.()); } catch {}
        try { candidates.add(view.leaf?.getRoot?.()); } catch {}
        const seen = new Set();
        for (let current = view.leaf; current && !seen.has(current); current = current.parent) {
          seen.add(current);
          candidates.add(current);
        }
        candidates.delete(undefined);
        candidates.delete(null);
        return {
          path: view.requestedPath || view.file?.path || null,
          documentId: view.documentId || null,
          pluginViewMember: plugin.views?.has?.(view) === true,
          viewGateMatches: view.popoutCloseGate === gate,
          ownerWindowMatches: view.ownerWindow === owner,
          currentOwnerWindowMatches: (() => { try { return view.getOwnerWindow?.() === owner; } catch { return false; } })(),
          gateRootMembership: candidates.has(gate.root),
          liveByPluginGateQuery: live.includes(view),
        };
      });
      return {
        active: gate.active === true,
        registryMember: plugin.popoutCloseGates.get(owner) === gate,
        viewsSize: gate.views?.size ?? null,
        memberViews,
        liveViews: live.length,
        closePromise: !!gate.closePromise,
        allowClose: gate.allowClose === true,
        closeCommitted: gate.closeCommitted === true,
        rootWindowMatches: gate.root?.win === owner,
        rootCloseWrapperInstalled: gate.root?.close === gate.closeWrapper,
      };
    });
    return JSON.stringify({
      vault: app.vault.adapter.basePath,
      configDir: app.vault.configDir,
      isPopout: document.body?.classList?.contains('is-popout-window') === true,
      readerViewCount: plugin?.views?.size ?? null,
      gates,
    });
  })()`, description);
}

async function installNativeBeforeUnloadObserver(page, label) {
  const existing = nativeBeforeUnloadObservers.get(page);
  if (existing) return existing;
  const suffix = String(label).replace(/[^a-zA-Z0-9_$]/g, "_");
  const key = `__nativeLifecycleBeforeUnload_${stamp}_${suffix}`;
  const binding = `__nativeLifecycleBeforeUnloadBinding_${stamp}_${suffix}`;
  const observer = { key, binding, label, bindingEvents: [], installed: false };
  await page.exposeFunction(binding, (serialized) => {
    try { observer.bindingEvents.push(JSON.parse(serialized)); }
    catch (error) { observer.bindingError = error?.stack || String(error); }
  });
  const installed = await evaluateJsonBounded(page, `(() => {
    const key = ${JSON.stringify(key)};
    const binding = ${JSON.stringify(binding)};
    const originalPreventDefault = window.Event?.prototype?.preventDefault;
    const gateSnapshot = () => {
      const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
      const entries = [...(plugin?.popoutCloseGates?.entries?.() || [])]
        .filter(([owner]) => owner === window);
      return entries.map(([owner, gate]) => {
        let live = [];
        try { live = plugin.popoutViewsForGate?.(gate) || []; } catch {}
        return {
          active: gate.active === true,
          registryMember: plugin.popoutCloseGates.get(owner) === gate,
          viewsSize: gate.views?.size ?? null,
          liveViews: live.length,
          liveViewPaths: live.map(view => view.requestedPath || view.file?.path || null),
          closePromise: !!gate.closePromise,
          allowClose: gate.allowClose === true,
          closeCommitted: gate.closeCommitted === true,
          rootWindowMatches: gate.root?.win === owner,
          rootCloseWrapperInstalled: gate.root?.close === gate.closeWrapper,
        };
      });
    };
    const state = { events: [], originalPreventDefault, listener: null, patchedPreventDefault: null };
    const publish = record => {
      try { Promise.resolve(window[binding](JSON.stringify(record))).catch(() => {}); } catch {}
    };
    if (typeof originalPreventDefault === 'function') {
      state.patchedPreventDefault = function(...args) {
        if (this?.type !== 'beforeunload') return originalPreventDefault.apply(this, args);
        const record = {
          phase: 'preventDefault',
          at: new Date().toISOString(),
          eventTargetIsWindow: this.target === window,
          beforeDefaultPrevented: this.defaultPrevented === true,
          gates: gateSnapshot(),
        };
        const result = originalPreventDefault.apply(this, args);
        record.afterDefaultPrevented = this.defaultPrevented === true;
        state.events.push(record);
        publish(record);
        return result;
      };
      window.Event.prototype.preventDefault = state.patchedPreventDefault;
    }
    state.listener = event => {
      if (event.type !== 'beforeunload') return;
      const record = {
        phase: 'capture',
        at: new Date().toISOString(),
        eventTargetIsWindow: event.target === window,
        defaultPrevented: event.defaultPrevented === true,
        returnValue: event.returnValue ?? null,
        returnValueType: typeof event.returnValue,
        gates: gateSnapshot(),
      };
      state.events.push(record);
      publish(record);
      const afterDispatch = () => {
        const settled = {
          phase: 'post-dispatch-microtask',
          at: new Date().toISOString(),
          eventTargetIsWindow: event.target === window,
          defaultPrevented: event.defaultPrevented === true,
          returnValue: event.returnValue ?? null,
          returnValueType: typeof event.returnValue,
          gates: gateSnapshot(),
        };
        state.events.push(settled);
        publish(settled);
      };
      if (typeof queueMicrotask === 'function') queueMicrotask(afterDispatch);
      else Promise.resolve().then(afterDispatch);
    };
    window.addEventListener('beforeunload', state.listener, true);
    window[key] = state;
    return JSON.stringify({
      installed: true,
      preventDefaultPatched: window.Event?.prototype?.preventDefault === state.patchedPreventDefault,
      captureListenerInstalled: true,
      isPopout: document.body?.classList?.contains('is-popout-window') === true,
    });
  })()`, `install native beforeunload observer for ${label}`);
  assert.equal(installed.installed, true);
  assert.equal(installed.isPopout, true);
  observer.installed = true;
  observer.installation = installed;
  nativeBeforeUnloadObservers.set(page, observer);
  return observer;
}

async function readNativeBeforeUnloadObserver(page, observer) {
  if (!observer) return { events: [], available: false };
  if (page.isClosed()) {
    return {
      events: [...observer.bindingEvents],
      bindingError: observer.bindingError || null,
      available: true,
      pageClosed: true,
    };
  }
  const local = await evaluateJsonBounded(page, `(() => {
    const state = window[${JSON.stringify(observer.key)}];
    return JSON.stringify({
      events: state?.events || [],
      currentGates: (() => {
        const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
        return [...(plugin?.popoutCloseGates?.entries?.() || [])]
          .filter(([owner]) => owner === window)
          .map(([owner, gate]) => {
            let live = [];
            try { live = plugin.popoutViewsForGate?.(gate) || []; } catch {}
            return {
              active: gate.active === true,
              registryMember: plugin.popoutCloseGates.get(owner) === gate,
              viewsSize: gate.views?.size ?? null,
              liveViews: live.length,
              closePromise: !!gate.closePromise,
              allowClose: gate.allowClose === true,
              closeCommitted: gate.closeCommitted === true,
              rootWindowMatches: gate.root?.win === owner,
              rootCloseWrapperInstalled: gate.root?.close === gate.closeWrapper,
            };
          });
      })(),
    });
  })()`, `read native beforeunload observations for ${observer.label}`);
  return {
    events: local.events || [],
    currentGates: local.currentGates || [],
    bindingEvents: [...observer.bindingEvents],
    bindingError: observer.bindingError || null,
    available: true,
    pageClosed: false,
  };
}

async function restoreNativeBeforeUnloadObserver(page, observer) {
  if (!observer) return;
  if (!page.isClosed() && browser?.isConnected()) {
    await evaluateJsonBounded(page, `(() => {
      const state = window[${JSON.stringify(observer.key)}];
      if (!state) return JSON.stringify({ alreadyAbsent: true });
      if (state.patchedPreventDefault && window.Event?.prototype?.preventDefault === state.patchedPreventDefault) {
        window.Event.prototype.preventDefault = state.originalPreventDefault;
      }
      if (state.listener) window.removeEventListener('beforeunload', state.listener, true);
      delete window[${JSON.stringify(observer.key)}];
      return JSON.stringify({ restored: true });
    })()`, `restore native beforeunload observer for ${observer.label}`)
      .catch((error) => { observer.restoreError = error?.stack || String(error); });
  }
  nativeBeforeUnloadObservers.delete(page);
}

async function startNativePopoutCloseAttempt(page, { path: readerPath, attemptKey, driver }) {
  await verifyIdentity(page);
  const observer = await installNativeBeforeUnloadObserver(page, attemptKey);
  const gateBefore = await popoutCloseGateState(page, `capture popout close gate before ${attemptKey}`);
  const attempt = {
    path: readerPath,
    attemptKey,
    driver,
    gateBefore,
    startedAt: new Date().toISOString(),
    eventCountBefore: observer.bindingEvents.length,
    status: "requested",
  };
  report.checks.nativePopoutCloseAttempts ||= [];
  report.checks.nativePopoutCloseAttempts.push(attempt);
  nativePopoutCloseAttempts.set(page, attempt);
  await persistReport();
  return { observer, attempt };
}

async function finishNativePopoutCloseAttempt(page, attempt, extra = {}) {
  const observer = nativeBeforeUnloadObservers.get(page);
  if (observer) await wait(250);
  attempt.beforeUnload = await readNativeBeforeUnloadObserver(page, observer).catch((error) => ({
    available: false,
    readError: error?.stack || String(error),
    bindingEvents: observer?.bindingEvents || [],
  }));
  attempt.targetClosed = page.isClosed() || !isLivePageTarget(page);
  attempt.finishedAt = new Date().toISOString();
  Object.assign(attempt, extra);
  await persistReport();
  if (attempt.targetClosed) {
    nativeBeforeUnloadObservers.delete(page);
    nativePopoutCloseAttempts.delete(page);
  }
  return attempt;
}

async function detachPopoutReaderWithGateDiagnostics(view, label, onStarted = null) {
  const attemptKey = `reader-detach-${stamp}-${String(label).replace(/[^a-zA-Z0-9_$]/g, "_")}`;
  const { attempt } = await startNativePopoutCloseAttempt(view.page, {
    path: view.path,
    attemptKey,
    driver: `detaching the exact owned Reader (${label}); observe any native beforeunload while its PDF close gate is still registered`,
  });
  if (onStarted) await onStarted(attempt);
  try {
    await withNativeCdpDeadline(
      `detach owned popout Reader (${label})`,
      () => detachOwnedView(view),
      30_000,
    );
    await finishNativePopoutCloseAttempt(view.page, attempt, {
      status: "reader-detach-completed",
      targetClosedDuringDetach: view.page.isClosed() || !isLivePageTarget(view.page),
    });
    return attempt;
  } catch (error) {
    attempt.status = "reader-detach-failed-or-timed-out";
    attempt.error = error?.stack || String(error);
    await finishNativePopoutCloseAttempt(view.page, attempt).catch(() => {});
    throw error;
  }
}

async function recordNativePopoutCloseWithoutReader(page, label) {
  const identity = await evaluateJsonBounded(page, `JSON.stringify((() => ({
    vault: app.vault.adapter.basePath,
    configDir: app.vault.configDir,
    isPopout: document.body?.classList?.contains('is-popout-window') === true,
    readerPaths: app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .map(leaf => leaf.view?.requestedPath || leaf.view?.file?.path || null),
  }))())`, `verify empty popup before ${label}`);
  assert.deepEqual({ vault: identity.vault, configDir: identity.configDir }, expectedIdentity);
  assert.equal(identity.isPopout, true);
  assert.deepEqual(identity.readerPaths, [], `${label} popup must have no Reader views before its native close request.`);
  const { observer, attempt } = await startNativePopoutCloseAttempt(page, {
    path: null,
    attemptKey: `native-empty-popout-${stamp}-${String(label).replace(/[^a-zA-Z0-9_$]/g, "_")}`,
    driver: "Puppeteer Page.close({ runBeforeUnload: true }) on the identity-verified empty isolated popout; this requests the Electron window close and dispatches beforeunload",
  });
  attempt.identityBeforeClose = identity;
  await persistReport();
  await disableBackgroundVisibilityEmulation(page);
  await withNativeCdpDeadline(
    `request beforeunload close for empty isolated popout (${label})`,
    () => page.close({ runBeforeUnload: true }),
    10_000,
  );
  try {
    await waitForBounded(
      `identity-verified empty popout ${label} to close after beforeunload`,
      async () => ({ targetClosed: page.isClosed() || !isLivePageTarget(page) }),
      (state) => state.targetClosed,
      15_000,
      5_000,
    );
    attempt.status = "native-window-closed";
    attempt.closeMechanism = "beforeunload-dispatched CDP close request; target closure observed";
  } catch (error) {
    attempt.status = "close-not-observed";
    attempt.error = error?.stack || String(error);
    await finishNativePopoutCloseAttempt(page, attempt);
    throw error;
  }
  await finishNativePopoutCloseAttempt(page, attempt, {
    status: "native-window-closed",
    closeMechanism: "beforeunload-dispatched CDP close request; target closure observed",
  });
  assert.equal(attempt.targetClosed, true,
    `${label} must close the native Electron popout after the beforeunload guard completes; SDK split removal alone is not a pass.`);
  await restoreNativeBeforeUnloadObserver(page, observer);
  const outcome = {
    closedAfterOwnedReadersDetached: true,
    readerPaths: identity.readerPaths,
    driver: attempt.driver,
    gateBefore: attempt.gateBefore,
    beforeUnload: attempt.beforeUnload,
    testAnchorHeldWindowUntilReaderDetach: Boolean(popoutCleanupAnchors.get(page)),
  };
  report.checks.popoutWindowCleanup ??= [];
  report.checks.popoutWindowCleanup.push({ label, ...outcome });
  if (createdPopoutPage === page) createdPopoutPage = null;
  const anchor = popoutCleanupAnchors.get(page) || null;
  if (anchor) await removePopoutCleanupAnchor(anchor, label);
  return outcome;
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

async function inspectNativeReaderChrome(view, label, { openToolPopups = false } = {}) {
  const layout = await evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const reader = leaf?.view;
    const frameElement = reader?.iframe;
    const frame = frameElement?.contentWindow;
    const outerContent = reader?.contentEl;
    const outerStyle = outerContent ? getComputedStyle(outerContent) : null;
    const rect = element => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height };
    };
    return {
      path: reader?.requestedPath || reader?.file?.path || null,
      popout: document.body?.classList?.contains('is-popout-window') === true,
      outerContentPadding: outerStyle ? {
        top: outerStyle.paddingTop,
        right: outerStyle.paddingRight,
        bottom: outerStyle.paddingBottom,
        left: outerStyle.paddingLeft,
      } : null,
      outerContentRect: rect(outerContent),
      iframe: {
        rect: rect(frameElement),
        clientWidth: frameElement?.clientWidth ?? null,
        clientHeight: frameElement?.clientHeight ?? null,
      },
      frameViewport: frame ? { width: frame.innerWidth, height: frame.innerHeight } : null,
      toolbar: rect(frame?.document?.getElementById('toolbarContainer')),
      buttons: ${JSON.stringify(nativeToolbarButtonIds)}.map(id => ({
        id,
        disabled: frame?.document?.getElementById(id)?.disabled ?? null,
        rect: rect(frame?.document?.getElementById(id)),
      })),
      scroll: {
        clientWidth: frame?.document?.getElementById('toolbarViewer')?.clientWidth ?? null,
        scrollWidth: frame?.document?.getElementById('toolbarViewer')?.scrollWidth ?? null,
      },
    };
  })())`);
  assert.equal(layout.path, view.path, `${label} layout must belong to the owned PDF`);
  assert.deepEqual(
    layout.outerContentPadding,
    { top: "0px", right: "0px", bottom: "0px", left: "0px" },
    `${label} owner window must render the Reader content with zero computed padding`,
  );
  assert.ok(layout.iframe.rect?.width > 0, `${label} iframe must have an actual rendered width`);
  assert.ok(layout.frameViewport?.width > 0, `${label} iframe must have a non-zero document viewport`);
  assert.equal(layout.buttons.length, nativeToolbarButtonIds.length);
  const insideFrame = (rect, subject) => {
    assert.ok(rect, `${label} ${subject} must have a rendered rectangle`);
    assert.ok(rect.width > 0 && rect.height > 0, `${label} ${subject} must be visible`);
    assert.ok(rect.x >= -0.5 && rect.y >= -0.5,
      `${label} ${subject} starts outside the iframe: ${JSON.stringify({ rect, frameViewport: layout.frameViewport })}`);
    assert.ok(rect.right <= layout.frameViewport.width + 0.5 &&
      rect.bottom <= layout.frameViewport.height + 0.5,
      `${label} ${subject} extends outside the iframe: ${JSON.stringify({ rect, frameViewport: layout.frameViewport })}`);
  };
  insideFrame(layout.toolbar, "PDF toolbar");
  for (const button of layout.buttons) insideFrame(button.rect, button.id);
  layout.narrowToolbarViewport = layout.frameViewport.width <= 720;
  layout.toolbarContentsFit = layout.scroll.scrollWidth <= layout.scroll.clientWidth + 1;
  assert.equal(layout.toolbarContentsFit, true,
    `${label} PDF toolbar contents must fit their actual viewport: ${JSON.stringify(layout.scroll)}`);

  const toolbarPopups = [];
  if (openToolPopups) {
    for (const { buttonId, popupId } of nativeToolbarPopupPairs) {
      const before = await readerRuntimeState(view);
      assert.equal(before.editorMode, 0, `${label} must start with no active editor tool`);
      let popup;
      try {
        await clickViewerElement(view, buttonId);
        popup = await waitFor(`${label} ${popupId} to open`, async () =>
          evaluateJson(view.page, `JSON.stringify((() => {
            const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
              .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
            const frame = leaf?.view?.iframe?.contentWindow;
            const element = frame?.document?.getElementById(${JSON.stringify(popupId)});
            if (!element) return null;
            const box = element.getBoundingClientRect();
            const point = frame.document.elementFromPoint(box.left + Math.min(8, box.width / 2),
              box.top + Math.min(8, box.height / 2));
            return {
              visible: !element.classList.contains('hidden') && getComputedStyle(element).visibility === 'visible',
              rect: { x: box.x, y: box.y, right: box.right, bottom: box.bottom,
                width: box.width, height: box.height },
              hitTested: point === element || element.contains(point),
              mode: frame.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
              frameViewport: { width: frame.innerWidth, height: frame.innerHeight },
            };
          })())`), (state) => state?.visible === true, 8_000);
        insideFrame(popup.rect, popupId);
        assert.equal(popup.hitTested, true, `${label} ${popupId} must receive hit tests inside its owner iframe`);
        toolbarPopups.push({ buttonId, popupId, ...popup });
      } finally {
        const mode = await readerRuntimeState(view).catch(() => null);
        if (mode?.editorMode !== 0) {
          await clickViewerElement(view, buttonId);
        }
        await waitFor(`${label} ${buttonId} to close cleanly`, async () =>
          evaluateJson(view.page, `JSON.stringify((() => {
            const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
              .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
            const frame = leaf?.view?.iframe?.contentWindow;
            const button = frame?.document?.getElementById(${JSON.stringify(buttonId)});
            const element = frame?.document?.getElementById(${JSON.stringify(popupId)});
            return {
              mode: frame?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
              closed: !button?.classList?.contains('toggled') && !!element?.classList?.contains('hidden'),
            };
          })())`), (state) => state?.mode === 0 && state.closed, 8_000);
      }
    }
    const after = await readerRuntimeState(view);
    assert.equal(after.editorMode, 0, `${label} toolbar popup checks must restore the neutral tool mode`);
    assert.equal(after.dirty, false, `${label} toolbar popup checks must not modify the PDF`);
  }

  const evidence = {
    label,
    path: view.path,
    popout: layout.popout,
    layout,
    toolbarPopups,
  };
  report.checks.nativeReaderChrome ??= [];
  report.checks.nativeReaderChrome.push(evidence);
  return evidence;
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
    return [...(storage?.serializable?.map?.entries?.() || [])]
      .filter(([, item]) => !item.deleted && (${type == null ? "true" : `item.annotationType === ${Number(type)}`}))
      .map(([storageKey, item]) => {
        // AnnotationStorage.serializable.map contains plain serialized records,
        // keyed by the live editor id. Keep those two identities distinct.
        const serialized = item;
        return {
          id: item.id,
          storageKey,
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

async function nativeFreeTextEditorState(view) {
  return evaluateJson(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    const read = () => {
      const page = doc?.querySelector('.page[data-page-number="1"]');
      const pageView = win?.PDFViewerApplication?.pdfViewer?.getPageView?.(0);
      const layer = page?.querySelector('.annotationEditorLayer');
      const editor = page?.querySelector('.annotationEditorLayer .freeTextEditor.selectedEditor');
      const internal = editor?.querySelector('.internal');
      const rect = editor?.getBoundingClientRect();
      return { page, pageView, layer, editor, internal, rect };
    };
    const first = read();
    if (!win?.requestAnimationFrame) return JSON.stringify({ ready: false, reason: 'renderer-frame-unavailable' });
    await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    const current = read();
    const frameRect = frame?.getBoundingClientRect();
    return JSON.stringify({
      mode: win?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
      pageLoaded: current.page?.dataset?.loaded === 'true',
      pageNotLoading: !!current.page && !current.page.classList.contains('loading') && !current.page.classList.contains('loadingIcon'),
      pageMatchesView: current.pageView?.div === current.page,
      layerConnected: !!current.layer?.isConnected && current.layer.parentElement === current.page,
      editorConnected: !!current.editor?.isConnected,
      internalConnected: !!current.internal?.isConnected,
      selected: !!current.editor?.classList.contains('selectedEditor'),
      contentEditable: current.internal?.getAttribute('contenteditable') ?? null,
      active: !!current.internal && doc?.activeElement === current.internal,
      stableAfterRendererFrames: !!first.editor && first.editor === current.editor &&
        first.editor.parentElement === current.editor.parentElement && first.layer === current.layer &&
        first.internal === current.internal,
      editorId: current.editor?.id || null,
      parentClass: typeof current.editor?.parentElement?.className === 'string'
        ? current.editor.parentElement.className : null,
      rect: current.rect && frameRect ? {
        x: frameRect.x + current.rect.x,
        y: frameRect.y + current.rect.y,
        width: current.rect.width,
        height: current.rect.height,
      } : null,
      text: current.internal?.textContent || '',
    });
  })()`);
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

async function nativeFreeTextAnnotationRecords(view) {
  return evaluateJson(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const pdf = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument;
    if (!pdf) throw new Error('PDF.js document is unavailable.');
    const page = await pdf.getPage(1);
    const annotations = await page.getAnnotations();
    return JSON.stringify(annotations
      .filter(annotation => annotation.subtype === 'FreeText')
      .map(annotation => ({
        id: annotation.id,
        subtype: annotation.subtype,
        hasAppearance: !!annotation.hasAppearance,
        rect: annotation.rect ? Array.from(annotation.rect) : null,
        contentsObjText: annotation.contentsObj?.str ?? null,
        textContent: Array.isArray(annotation.textContent)
          ? annotation.textContent.join('\\n')
          : typeof annotation.textContent === 'string' ? annotation.textContent : null,
      })));
  })()`);
}

async function nativeFreeTextVisualState(view, annotationId, { inspectPixels = false, roiRect = null } = {}) {
  const roiRectJson = JSON.stringify(roiRect);
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const win = frame?.contentWindow;
    const doc = frame?.contentDocument;
    const pdf = win?.PDFViewerApplication;
    const page = doc?.querySelector('.page[data-page-number="1"]');
    const annotationLayer = page?.querySelector('.annotationLayer');
    const section = [...(annotationLayer?.querySelectorAll('.freeTextAnnotation[data-annotation-id]') || [])]
      .find(element => element.getAttribute('data-annotation-id') === ${JSON.stringify(annotationId)});
    const frameRect = frame?.getBoundingClientRect();
    const pageRect = page?.getBoundingClientRect();
    const sectionRect = section?.getBoundingClientRect();
    const effectiveVisibility = element => {
      if (!element) return false;
      for (let node = element; node && node !== doc; node = node.parentElement) {
        const style = win.getComputedStyle(node);
        if (node.hidden || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
      }
      return true;
    };
    const canvas = section?.querySelector('canvas.annotationContent');
    const canvasRect = canvas?.getBoundingClientRect();
    const canvasStyle = canvas ? win.getComputedStyle(canvas) : null;
    let pixels = null;
    if (${JSON.stringify(inspectPixels)} && canvas?.width > 0 && canvas?.height > 0) {
      try {
        const rgba = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (rgba) {
          let alphaPixels = 0;
          let nonWhitePixels = 0;
          for (let index = 0; index < rgba.length; index += 4) {
            if (rgba[index + 3] > 16) {
              alphaPixels += 1;
              if (rgba[index] < 245 || rgba[index + 1] < 245 || rgba[index + 2] < 245) {
                nonWhitePixels += 1;
              }
            }
          }
          pixels = { alphaPixels, nonWhitePixels };
        }
      } catch (error) {
        pixels = { error: error?.message || String(error) };
      }
    }
    const pageCanvas = page?.querySelector('.canvasWrapper canvas');
    const pageCanvasRect = pageCanvas?.getBoundingClientRect();
    const pageCanvasStyle = pageCanvas ? win.getComputedStyle(pageCanvas) : null;
    let pageCanvasRoi = null;
    if (${JSON.stringify(inspectPixels)} && pageCanvas?.width > 0 && pageCanvas?.height > 0 && pageCanvasRect && frameRect) {
      try {
        const requestedRoi = ${roiRectJson} || (sectionRect ? {
          x: frameRect.x + sectionRect.x,
          y: frameRect.y + sectionRect.y,
          width: sectionRect.width,
          height: sectionRect.height,
        } : null);
        if (requestedRoi) {
          const scaleX = pageCanvas.width / pageCanvasRect.width;
          const scaleY = pageCanvas.height / pageCanvasRect.height;
          const left = Math.max(0, Math.floor((requestedRoi.x - frameRect.x - pageCanvasRect.x) * scaleX));
          const top = Math.max(0, Math.floor((requestedRoi.y - frameRect.y - pageCanvasRect.y) * scaleY));
          const right = Math.min(pageCanvas.width, Math.ceil((requestedRoi.x + requestedRoi.width - frameRect.x - pageCanvasRect.x) * scaleX));
          const bottom = Math.min(pageCanvas.height, Math.ceil((requestedRoi.y + requestedRoi.height - frameRect.y - pageCanvasRect.y) * scaleY));
          const width = right - left;
          const height = bottom - top;
          if (width > 0 && height > 0) {
            const rgba = pageCanvas.getContext('2d')?.getImageData(left, top, width, height).data;
            if (rgba) {
              let nonWhitePixels = 0;
              let hash = 2166136261;
              for (let index = 0; index < rgba.length; index += 4) {
                if (rgba[index] < 245 || rgba[index + 1] < 245 || rgba[index + 2] < 245) {
                  nonWhitePixels += 1;
                }
              }
              for (let index = 0; index < rgba.length; index += 1) {
                hash = Math.imul(hash ^ rgba[index], 16777619);
              }
              pageCanvasRoi = {
                width, height, nonWhitePixels,
                fingerprint: (hash >>> 0).toString(16).padStart(8, '0'),
              };
            }
          }
        }
      } catch (error) {
        pageCanvasRoi = { error: error?.message || String(error) };
      }
    }
    const visibleText = section?.querySelector('div.annotationContent.freetext');
    const visibleTextRect = visibleText?.getBoundingClientRect();
    const visibleTextStyle = visibleText ? win.getComputedStyle(visibleText) : null;
    const editor = page?.querySelector('.annotationEditorLayer .freeTextEditor');
    const editorRect = editor?.getBoundingClientRect();
    const editorInternal = editor?.querySelector('.internal');
    const canvasVisible = !!canvas && effectiveVisibility(canvas) && !!canvasRect &&
      canvasRect.width > 0 && canvasRect.height > 0 && canvasStyle?.opacity !== '0';
    const pageCanvasVisible = !!pageCanvas && effectiveVisibility(pageCanvas) && !!pageCanvasRect &&
      pageCanvasRect.width > 0 && pageCanvasRect.height > 0 && pageCanvasStyle?.opacity !== '0';
    const visibleTextContent = visibleText?.textContent || '';
    const visibleTextVisible = !!visibleText && effectiveVisibility(visibleText) &&
      !!visibleTextRect && visibleTextRect.width > 0 && visibleTextRect.height > 0 &&
      visibleTextStyle?.opacity !== '0' && visibleTextStyle?.color !== 'transparent' &&
      visibleTextContent.trim().length > 0;
    const sectionVisible = !!section && effectiveVisibility(section) && !!sectionRect &&
      sectionRect.width > 0 && sectionRect.height > 0;
    const annotationStyle = section ? win.getComputedStyle(section) : null;
    return {
      annotationId: ${JSON.stringify(annotationId)},
      mode: pdf?.pdfViewer?.annotationEditorMode ?? null,
      pageLoaded: page?.dataset.loaded === 'true',
      pageLoading: !!page?.classList.contains('loading') || !!page?.classList.contains('loadingIcon'),
      pageRect: pageRect && frameRect ? {
        x: frameRect.x + pageRect.x, y: frameRect.y + pageRect.y,
        width: pageRect.width, height: pageRect.height,
      } : null,
      sectionPresent: !!section,
      sectionClass: section?.className || null,
      sectionHidden: section?.hidden ?? null,
      sectionVisibility: annotationStyle?.visibility ?? null,
      sectionDisplay: annotationStyle?.display ?? null,
      sectionRect: sectionRect && frameRect ? {
        x: frameRect.x + sectionRect.x, y: frameRect.y + sectionRect.y,
        width: sectionRect.width, height: sectionRect.height,
      } : null,
      sectionVisible,
      semanticText: section?.querySelector('.annotationTextContent')?.textContent || null,
      canvas: canvas ? {
        width: canvas.width, height: canvas.height,
        display: canvasStyle?.display ?? null,
        visibility: canvasStyle?.visibility ?? null,
        opacity: canvasStyle?.opacity ?? null,
        rect: canvasRect && frameRect ? {
          x: frameRect.x + canvasRect.x, y: frameRect.y + canvasRect.y,
          width: canvasRect.width, height: canvasRect.height,
        } : null,
        visible: canvasVisible,
        pixels,
      } : null,
      pageCanvas: pageCanvas ? {
        width: pageCanvas.width,
        height: pageCanvas.height,
        display: pageCanvasStyle?.display ?? null,
        visibility: pageCanvasStyle?.visibility ?? null,
        opacity: pageCanvasStyle?.opacity ?? null,
        rect: pageCanvasRect && frameRect ? {
          x: frameRect.x + pageCanvasRect.x, y: frameRect.y + pageCanvasRect.y,
          width: pageCanvasRect.width, height: pageCanvasRect.height,
        } : null,
        visible: pageCanvasVisible,
        roiPixels: pageCanvasRoi,
      } : null,
      visibleText: visibleText ? {
        className: visibleText.className,
        text: visibleTextContent,
        color: visibleTextStyle?.color ?? null,
        display: visibleTextStyle?.display ?? null,
        visibility: visibleTextStyle?.visibility ?? null,
        opacity: visibleTextStyle?.opacity ?? null,
        rect: visibleTextRect && frameRect ? {
          x: frameRect.x + visibleTextRect.x, y: frameRect.y + visibleTextRect.y,
          width: visibleTextRect.width, height: visibleTextRect.height,
        } : null,
        visible: visibleTextVisible,
      } : null,
      visibleAppearance: sectionVisible && (
        canvasVisible && (pixels === null || (pixels.alphaPixels > 0 && pixels.nonWhitePixels > 0)) ||
        visibleTextVisible ||
        pageCanvasVisible && (pageCanvasRoi === null || pageCanvasRoi.nonWhitePixels > 0)
      ),
      normalNoneEditor: editor ? {
        connected: editor.isConnected,
        hiddenClass: editor.classList.contains('hidden'),
        contentEditable: editorInternal?.getAttribute('contenteditable') ?? null,
        rect: editorRect ? { width: editorRect.width, height: editorRect.height } : null,
      } : null,
      frameViewport: frameRect && win ? { width: win.innerWidth, height: win.innerHeight } : null,
    };
  })())`);
}

async function nativeFreeTextHit(view, x, y, annotationId) {
  await verifyIdentity(view.page);
  return evaluateJson(view.page, `JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frame = leaf?.view?.iframe;
    const frameRect = frame?.getBoundingClientRect();
    const outer = document.elementFromPoint(${Number(x)}, ${Number(y)});
    const inner = frameRect && frame?.contentDocument?.elementFromPoint(
      ${Number(x)} - frameRect.left, ${Number(y)} - frameRect.top);
    const section = inner?.closest?.('.freeTextAnnotation');
    return {
      outerIsFrame: outer === frame,
      frameConnected: !!frame?.isConnected,
      inner: inner ? {
        tag: inner.tagName,
        className: typeof inner.className === 'string' ? inner.className : null,
        annotationId: section?.getAttribute('data-annotation-id') || null,
      } : null,
      hitsExpectedFreeText: section?.getAttribute('data-annotation-id') === ${JSON.stringify(annotationId)},
    };
  })())`);
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
      const textLayer=page.querySelector('.textLayer');
      const candidates=[{x:rect.x+rect.width/2,y:rect.y+rect.height/2}];
      for(const span of textLayer?.querySelectorAll('span') || []) {
        const box=span.getBoundingClientRect();
        const left=Math.max(rect.left+2,box.left), right=Math.min(rect.right-2,box.right);
        const top=Math.max(rect.top+2,box.top), bottom=Math.min(rect.bottom-2,box.bottom);
        if(right>left && bottom>top) candidates.push({x:(left+right)/2,y:(top+bottom)/2});
      }
      const wasEnabled = layer.classList.contains('getElements');
      let stack = [];
      let x=candidates[0].x,y=candidates[0].y,ordinaryHit=null,textLayerHit=false;
      // PDF.js's disabled-layer uncommitted-editor path is attached to the
      // text layer. A geometric center can land in a gap on the SVG canvas.
      // Pick an actual text hit inside this exact editor, without altering DOM
      // for the trusted input or bypassing PDF.js's normal pointer handler.
      for(const point of candidates) {
        const hit=doc.elementFromPoint(point.x,point.y);
        if(!hit || !textLayer?.contains(hit)) continue;
        let proposed=[];
        try {layer.classList.add('getElements'); proposed=doc.elementsFromPoint(point.x,point.y);}
        finally {if(!wasEnabled) layer.classList.remove('getElements');}
        const proposedEditor=proposed.find(element=>/^pdfjs_internal_editor_[0-9]+$/.test(element.id));
        if(!layer.contains(proposed[0]) || proposedEditor?.id!==targetId) continue;
        x=point.x;y=point.y;ordinaryHit=hit;stack=proposed;textLayerHit=true;break;
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
        textLayerHit,
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
      result.hitTarget && result.textLayerHit && result.firstHitInsideLayer && result.getElementsRestored),
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
    `A trusted browser double-click must deliver two pointerdown events to the target text layer: ${JSON.stringify(pointerEvents)}.`);
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

async function saveNativeFreeTextRoiScreenshot(view, label, annotationRect, evidence) {
  assertOwnedPath(view.path);
  assert.ok(annotationRect?.width > 0 && annotationRect?.height > 0,
    `${label} requires the last known non-zero FreeText annotation rectangle.`);
  await verifyIdentity(view.page);
  const viewport = await view.page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const padding = 10;
  const left = Math.max(0, Math.floor(annotationRect.x - padding));
  const top = Math.max(0, Math.floor(annotationRect.y - padding));
  const right = Math.min(viewport.width, Math.ceil(annotationRect.x + annotationRect.width + padding));
  const bottom = Math.min(viewport.height, Math.ceil(annotationRect.y + annotationRect.height + padding));
  const clip = { x: left, y: top, width: right - left, height: bottom - top };
  assert.ok(clip.width > 1 && clip.height > 1,
    `${label} FreeText screenshot ROI is outside the owner viewport: ${JSON.stringify({ clip, viewport, annotationRect })}.`);
  const screenshot = path.join(artifactsDirectory, `native-macos-lifecycle-${stamp}-${label}.png`);
  await view.page.screenshot({ path: screenshot, clip });
  report.screenshots ||= {};
  report.screenshots[label] = {
    path: screenshot,
    roi: clip,
    annotationRect,
    evidence,
  };
  await persistReport();
  return { path: screenshot, roi: clip };
}

async function inspectNativeClickHit(view, x, y, expectedElementId = null, { record = true } = {}) {
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
      pageNumber: element.closest?.('.page')?.dataset?.pageNumber || null,
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
  if (record) {
    report.inputDiagnostics.clickHitTests.push({
      at: new Date().toISOString(),
      leafId: view.leafId,
      path: view.path,
      ...hit,
    });
  }
  return hit;
}

function recordNativeClickHit(view, hit) {
  report.inputDiagnostics.clickHitTests.push({
    at: new Date().toISOString(),
    leafId: view.leafId,
    path: view.path,
    ...hit,
  });
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

async function viewerElementHitDiagnostics(view, elementId) {
  return evaluateJson(view.page, `(async () => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
    const frameElement = leaf?.view?.iframe;
    const win = frameElement?.contentWindow;
    const doc = frameElement?.contentDocument;
    const element = doc?.getElementById(${JSON.stringify(elementId)});
    if (!frameElement || !win || !doc || !element) {
      return JSON.stringify({ elementId: ${JSON.stringify(elementId)}, connected: !!element?.isConnected, missing: true });
    }
    const rectBefore = element.getBoundingClientRect();
    await new Promise(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    const rect = element.getBoundingClientRect();
    const frameRect = frameElement.getBoundingClientRect();
    const x = frameRect.x + rect.x + rect.width / 2;
    const y = frameRect.y + rect.y + rect.height / 2;
    const inner = doc.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const outer = document.elementFromPoint(x, y);
    const describe = node => node ? {
      tag: node.tagName,
      id: node.id || null,
      className: typeof node.className === 'string' ? node.className : null,
      pageNumber: node.closest?.('.page')?.dataset?.pageNumber || null,
    } : null;
    const style = getComputedStyle(element);
    const ancestors = [];
    for (let node = element; node && node !== doc; node = node.parentElement) {
      const computed = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      ancestors.push({ tag: node.tagName, id: node.id || null,
        className: typeof node.className === 'string' ? node.className : null,
        display: computed.display, visibility: computed.visibility,
        opacity: computed.opacity, pointerEvents: computed.pointerEvents,
        position: computed.position, zIndex: computed.zIndex,
        rect: { x: box.x, y: box.y, width: box.width, height: box.height } });
      if (node === doc.body) break;
    }
    const toolbar = doc.getElementById('secondaryToolbar');
    const toolbarRect = toolbar?.getBoundingClientRect();
    const toolbarStyle = toolbar ? getComputedStyle(toolbar) : null;
    const scrollContainer = element.closest('#secondaryToolbarButtonContainer');
    const scrollRect = scrollContainer?.getBoundingClientRect();
    const stack = doc.elementsFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      .slice(0, 8).map(describe);
    const rectStable = Math.abs(rect.x - rectBefore.x) < 0.5 &&
      Math.abs(rect.y - rectBefore.y) < 0.5 &&
      Math.abs(rect.width - rectBefore.width) < 0.5 &&
      Math.abs(rect.height - rectBefore.height) < 0.5;
    const visible = ancestors.every(node => node.display !== 'none' &&
      node.visibility !== 'hidden' && Number(node.opacity) !== 0) &&
      rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
    return JSON.stringify({ elementId: ${JSON.stringify(elementId)},
      connected: element.isConnected, visible, rectStable,
      disabled: element.disabled ?? false,
      point: { x, y, width: rect.width, height: rect.height },
      buttonRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      frameRect: { x: frameRect.x, y: frameRect.y, width: frameRect.width, height: frameRect.height },
      outerIsFrame: outer === frameElement, outerHit: describe(outer),
      innerWithinExpected: inner === element || element.contains(inner), innerHit: describe(inner),
      hitStack: stack, ancestors,
      secondaryToolbar: toolbar ? {
        hiddenClass: toolbar.classList.contains('hidden'),
        display: toolbarStyle.display, visibility: toolbarStyle.visibility,
        opacity: toolbarStyle.opacity, pointerEvents: toolbarStyle.pointerEvents,
        position: toolbarStyle.position, zIndex: toolbarStyle.zIndex,
        rect: toolbarRect ? { x: toolbarRect.x, y: toolbarRect.y,
          width: toolbarRect.width, height: toolbarRect.height } : null,
      } : null,
      scrollContainer: scrollContainer ? {
        scrollTop: scrollContainer.scrollTop,
        scrollHeight: scrollContainer.scrollHeight,
        clientHeight: scrollContainer.clientHeight,
        rect: scrollRect ? { x: scrollRect.x, y: scrollRect.y,
          width: scrollRect.width, height: scrollRect.height,
          right: scrollRect.right, bottom: scrollRect.bottom } : null,
        buttonRect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height },
      } : null,
      viewerScale: win.PDFViewerApplication?.pdfViewer?.currentScale ?? null,
    });
  })()`);
}

async function clickViewerElement(view, elementId) {
  await waitFor(
    `Obsidian notices to clear before clicking PDF.js control ${elementId}`,
    async () => evaluateJson(view.page, "JSON.stringify(document.querySelectorAll('.notice').length)"),
    (count) => count === 0,
    15_000,
  );
  const ready = await waitFor(
    `PDF.js control ${elementId} to become the actual native hit target`,
    () => viewerElementHitDiagnostics(view, elementId),
    (state) => state?.connected === true && state.visible && state.rectStable &&
      state.outerIsFrame && state.innerWithinExpected,
    8_000,
  );
  await clickAt(view, ready.point.x, ready.point.y, elementId);
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
  const firstButtonLayout = await viewerElementHitDiagnostics(view, buttonId);
  const scroller = firstButtonLayout.scrollContainer;
  const clippedVertically = scroller && scroller.scrollHeight > scroller.clientHeight + 1 &&
    (scroller.buttonRect.y < scroller.rect.y - 0.5 ||
      scroller.buttonRect.bottom > scroller.rect.bottom + 0.5);
  let scrollReveal = null;
  if (clippedVertically) {
    const needed = scroller.buttonRect.bottom > scroller.rect.bottom
      ? scroller.buttonRect.bottom - scroller.rect.bottom + 24
      : scroller.buttonRect.y - scroller.rect.y - 24;
    const wheelDelta = Math.sign(needed) * Math.max(60, Math.abs(needed));
    const frameRect = firstButtonLayout.frameRect;
    const scrollPoint = {
      x: frameRect.x + scroller.rect.x + Math.min(24, scroller.rect.width / 2),
      y: frameRect.y + scroller.rect.bottom - Math.min(24, scroller.rect.height / 2),
    };
    await verifyIdentity(view.page);
    await view.page.mouse.move(scrollPoint.x, scrollPoint.y);
    await view.page.mouse.wheel({ deltaY: wheelDelta });
    scrollReveal = await waitFor(
      `native wheel input to reveal clipped PDF.js control ${buttonId} in its secondary toolbar`,
      () => viewerElementHitDiagnostics(view, buttonId),
      (state) => state?.scrollContainer?.scrollTop !== scroller.scrollTop &&
        state.outerIsFrame && state.innerWithinExpected,
      5_000,
    );
  }
  const buttonReady = await waitFor(
    `PDF.js control ${buttonId} to become the actual native hit target`,
    () => viewerElementHitDiagnostics(view, buttonId),
    (state) => state?.connected === true && state.visible && state.rectStable &&
      state.outerIsFrame && state.innerWithinExpected,
    8_000,
  );
  const buttonPoint = buttonReady.point;
  assert.equal(initial.disabled, false, `${buttonId} is disabled.`);
  await clickAt(view, buttonPoint.x, buttonPoint.y, buttonId);
  return { ...initial, scrollReveal };
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
      (expectedMode === 0 || geometry.creationPriority) && geometry.expectedModeClassPresent,
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
    events.push({ type: event.type, trusted: event.isTrusted, timeStamp: event.timeStamp, clientX: event.clientX,
        clientY: event.clientY, button: event.button, buttons: event.buttons,
        pointerType: event.pointerType, target: { tag: event.target?.tagName || null,
          id: event.target?.id || null, className: typeof event.target?.className === 'string' ? event.target.className : null,
          pageNumber: event.target?.closest?.('.page')?.dataset?.pageNumber || null } });
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
  await waitFor(
    `Obsidian notices to clear before native ${mode} annotation`,
    async () => evaluateJson(view.page, "JSON.stringify(document.querySelectorAll('.notice').length)"),
    (count) => count === 0,
    15_000,
  );
  const geometry = await pageGeometry(view, mode);
  const offsets = customOffsets || (mode === 15
    ? { x: 60, y: 70, dx: 75, dy: 55 }
    : { x: 100, y: 150, dx: 100, dy: 75 });
  const endpoints = await waitFor(
    `native ${mode} annotation drag endpoints to hit the unobstructed PDF editor layer`,
    async () => {
      const dragStart = { x: geometry.x + offsets.x, y: geometry.y + offsets.y };
      const dragEnd = { x: dragStart.x + offsets.dx, y: dragStart.y + offsets.dy };
      const startHit = await inspectNativeClickHit(view, dragStart.x, dragStart.y, null, { record: false });
      const endHit = await inspectNativeClickHit(view, dragEnd.x, dragEnd.y, null, { record: false });
      return { dragStart, dragEnd, startHit, endHit };
    },
    (state) => state?.startHit?.outerIsFrame === true &&
      state?.endHit?.outerIsFrame === true &&
      state.startHit.inner?.className?.includes("annotationEditorLayer") &&
      state.endHit.inner?.className?.includes("annotationEditorLayer"),
    8_000,
  );
  const { dragStart, dragEnd, startHit, endHit } = endpoints;
  assert.equal(startHit.outerIsFrame, true, "Native annotation drag start must hit the PDF iframe.");
  assert.equal(endHit.outerIsFrame, true, "Native annotation drag end must hit the PDF iframe.");
  assert.ok(startHit.inner?.className?.includes("annotationEditorLayer"),
    `Native annotation drag start missed the ready editor layer: ${JSON.stringify(startHit.inner)}.`);
  assert.ok(endHit.inner?.className?.includes("annotationEditorLayer"),
    `Native annotation drag end missed the ready editor layer: ${JSON.stringify(endHit.inner)}.`);
  recordNativeClickHit(view, startHit);
  recordNativeClickHit(view, endHit);
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
  if (mode === 3) {
    const pointerUp = [...(report.inputDiagnostics.drags?.at(-1)?.events || [])]
      .reverse()
      .find((event) => event.type === 'pointerup');
    assert.ok(pointerUp?.trusted,
      `FreeText creation must be grounded in a trusted native pointerup: ${JSON.stringify(pointerUp)}.`);
    assert.equal(pointerUp.target?.pageNumber, '1',
      `FreeText creation pointerup must reach page 1: ${JSON.stringify(pointerUp)}.`);
    assert.match(pointerUp.target?.className || '', /annotationEditorLayer/,
      `FreeText creation pointerup must reach the ready editor layer: ${JSON.stringify(pointerUp)}.`);
    await waitFor(
      'new native FreeText input to be connected, editable, selected, and stable after renderer frames',
      () => nativeFreeTextEditorState(view),
      (state) => state?.mode === 3 && state.pageLoaded && state.pageNotLoading &&
        state.pageMatchesView && state.layerConnected && state.editorConnected &&
        state.internalConnected && state.selected && state.contentEditable === 'true' &&
        state.stableAfterRendererFrames && state.rect?.width > 0 && state.rect?.height > 0,
      15_000,
    );
  } else {
    await waitFor(
      `native ${mode === 5 ? "Square" : mode === 15 ? "Ink" : `editor ${mode}`} annotation`,
      async () => editorTypes(view),
      (types) => types.includes(mode),
      20_000,
    );
  }
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
const closeDiagnosticBindingPrefix = "__nativeLifecycleCloseSnapshot_";
let closeDiagnosticBindingSequence = 0;

async function removeCloseDiagnosticBinding(bindingName, { allowMissing = false } = {}) {
  assert.equal(typeof bindingName, "string");
  assert.ok(bindingName.startsWith(closeDiagnosticBindingPrefix),
    "Refusing to remove an exposed function outside this harness's close-diagnostic namespace.");
  if (!primaryPage || !isLivePageTarget(primaryPage)) {
    return { removed: false, skipped: "primary renderer is already closed" };
  }
  let before = null;
  let beforeReadError = null;
  try {
    before = await primaryPage.evaluate((name) => ({
      ownProperty: Object.prototype.hasOwnProperty.call(window, name),
      propertyExists: name in window,
      valueType: typeof window[name],
    }), bindingName);
  } catch (error) {
    beforeReadError = error?.stack || String(error);
  }
  try {
    // Puppeteer unregisters its CDP binding and sets the page property to
    // undefined; it intentionally does not delete the global property slot.
    await primaryPage.removeExposedFunction(bindingName);
  } catch (error) {
    if (allowMissing && (!before || before.valueType === "undefined") &&
        /Function with name .* does not exist/i.test(String(error?.message || error))) {
      return { removed: false, skipped: "Puppeteer had no registered binding", before, beforeReadError };
    }
    throw error;
  }
  let after = null;
  let afterReadError = null;
  try {
    after = await primaryPage.evaluate((name) => ({
      ownProperty: Object.prototype.hasOwnProperty.call(window, name),
      propertyExists: name in window,
      valueType: typeof window[name],
    }), bindingName);
  } catch (error) {
    afterReadError = error?.stack || String(error);
  }
  if (!after) return { removed: true, before, beforeReadError, afterReadError };
  assert.equal(after.valueType, "undefined",
    `Puppeteer did not clear the close-diagnostic binding ${bindingName} from the primary renderer.`);
  return { removed: true, before, beforeReadError, after, afterReadError };
}

function recordCloseDiagnosticBindingCleanup(monitorId, label, cleanup) {
  report.checks.closeDiagnosticBindingCleanup ??= [];
  report.checks.closeDiagnosticBindingCleanup.push({ monitorId, label, ...cleanup });
}

async function installCloseDiagnostics(view, label) {
  assertOwnedPath(view.path);
  assert.ok(primaryPage && isLivePageTarget(primaryPage),
    "Close diagnostics require the identity-verified primary Obsidian renderer.");
  await verifyIdentity(primaryPage);
  const monitorId = `${stamp}-${label}`;
  const snapshotBinding = `${closeDiagnosticBindingPrefix}${monitorId.replace(/[^a-zA-Z0-9_$]/g, "_")}_${++closeDiagnosticBindingSequence}`;
  const traceSnapshot = { value: null, bindingError: null };
  const existingBinding = await evaluateJson(primaryPage, `JSON.stringify({
    ownProperty: Object.prototype.hasOwnProperty.call(window, ${JSON.stringify(snapshotBinding)}),
    propertyExists: ${JSON.stringify(snapshotBinding)} in window,
    valueType: typeof window[${JSON.stringify(snapshotBinding)}],
  })`);
  if (existingBinding.propertyExists || existingBinding.ownProperty || existingBinding.valueType !== "undefined") {
    throw new Error(`Refusing to replace an existing primary-window property: ${snapshotBinding}`);
  }
  let snapshotBindingInstalled = false;
  let snapshotBindingAttempted = false;
  try {
    snapshotBindingAttempted = true;
    await primaryPage.exposeFunction(snapshotBinding, (serialized) => {
      try {
        traceSnapshot.value = JSON.parse(serialized);
      } catch (error) {
        traceSnapshot.bindingError = error?.stack || String(error);
      }
    });
    snapshotBindingInstalled = true;
    await evaluateJson(primaryPage, `(() => {
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    const target = [...(plugin?.views || [])].find(candidate =>
      candidate.leaf?.id === ${JSON.stringify(view.leafId)} &&
      candidate.documentId === ${JSON.stringify(view.documentId || view.originalDocumentId)} &&
      (candidate.requestedPath || candidate.file?.path) === ${JSON.stringify(view.path)});
    const leaf = target?.leaf || null;
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
      diagnosticErrors: [],
    };
    const publish = () => {
      try {
        const result = window[${JSON.stringify(snapshotBinding)}]?.(JSON.stringify(trace));
        if (result && typeof result.catch === 'function') result.catch(() => {});
        return result;
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
      const noteDiagnosticError = (phase, error) => {
        try {
          trace.diagnosticErrors.push({
            at: new Date().toISOString(), method: name, phase,
            error: error?.stack || String(error),
          });
          void publish();
        } catch {}
      };
      object[name] = function(...args) {
        let entry = null;
        try {
          entry = { at: new Date().toISOString(), ...before.call(this, args) };
          void publish();
        } catch (error) {
          noteDiagnosticError('before', error);
        }
        let result;
        try {
          result = original.apply(this, args);
        } catch (error) {
          if (entry) {
            try { entry.error = error?.stack || String(error); } catch {}
          }
          noteDiagnosticError('sync-call', error);
          throw error;
        }
        const finish = value => {
          if (!entry) return;
          try {
            if (after) after.call(this, entry, value, args);
            void publish();
          } catch (error) {
            noteDiagnosticError('after', error);
          }
        };
        let then = null;
        try {
          then = result != null && typeof result.then === 'function' ? result.then : null;
        } catch (error) {
          noteDiagnosticError('inspect-result', error);
        }
        if (then) {
          try {
            then.call(result, finish, error => {
              if (entry) {
                try { entry.error = error?.stack || String(error); } catch {}
              }
              noteDiagnosticError('async-call', error);
            });
          } catch (error) {
            noteDiagnosticError('observe-result', error);
          }
        } else {
          finish(result);
        }
        return result;
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
    const originalDetachWrapper = function(...args) {
      let receiverView = null;
      try {
        receiverView = this?.view || null;
        trace.routingDetachInvocations.push({
          at: new Date().toISOString(),
          receiverMatchesTargetLeaf: this === leaf,
          receiverLeafId: this?.id || null,
          receiverDocumentId: receiverView?.documentId || null,
          receiverPath: receiverView?.requestedPath || receiverView?.file?.path || null,
          receiverOpenRequest: receiverView?.openRequest ?? null,
        });
      } catch (error) {
        try { trace.diagnosticErrors.push({ at: new Date().toISOString(), method: 'originalDetach', phase: 'before', error: error?.stack || String(error) }); } catch {}
      }
      if (this !== leaf) return originalSdkDetach.apply(this, args);
      let entry = null;
      try {
        entry = { at: new Date().toISOString(), beforeRecoveryRead: state() };
        entry.preDetachState = state();
        entry.sdkDetachStartedAt = new Date().toISOString();
      } catch (error) {
        try { trace.diagnosticErrors.push({ at: new Date().toISOString(), method: 'originalDetach', phase: 'snapshot', error: error?.stack || String(error) }); } catch {}
      }
      if (entry) {
        try { trace.originalDetachEntries.push(entry); void publish(); } catch {}
      }
      let result;
      try {
        // This is an observer around the SDK's actual detach. It must remain
        // synchronous and return the exact value/Promise from the saved SDK
        // function so close timing and Promise identity are unchanged.
        result = originalSdkDetach.apply(this, args);
      } catch (error) {
        if (entry) {
          try {
            entry.error = error?.stack || String(error);
            entry.completedAt = new Date().toISOString();
            void publish();
          } catch {}
        }
        throw error;
      }
      const finish = (value, error = null) => {
        if (!entry) return;
        try {
          if (error) entry.error = error?.stack || String(error);
          else entry.result = summarized(value);
          entry.afterSdkDetach = state();
          entry.completedAt = new Date().toISOString();
          void publish();
        } catch (diagnosticError) {
          try { trace.diagnosticErrors.push({ at: new Date().toISOString(), method: 'originalDetach', phase: 'after', error: diagnosticError?.stack || String(diagnosticError) }); } catch {}
        }
      };
      let then = null;
      try { then = result != null && typeof result.then === 'function' ? result.then : null; }
      catch (error) {
        try { trace.diagnosticErrors.push({ at: new Date().toISOString(), method: 'originalDetach', phase: 'inspect-result', error: error?.stack || String(error) }); } catch {}
      }
      if (then) {
        try { then.call(result, value => finish(value), error => finish(undefined, error)); }
        catch (error) {
          try { trace.diagnosticErrors.push({ at: new Date().toISOString(), method: 'originalDetach', phase: 'observe-result', error: error?.stack || String(error) }); } catch {}
        }
      } else {
        finish(result);
      }
      return result;
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
      target,
      leaf,
      ownerWindow: target.ownerWindow || null,
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
        return {
          restoredExactSavedFunction: routing.originalDetach === originalSdkDetach,
          diagnosticRegistryRemaining: Object.keys(routing[${JSON.stringify(closeRoutingDiagnosticRegistryKey)}] || {}).length,
        };
      },
    };
    return JSON.stringify({ installed: true, label: trace.label, path: trace.path, leafId: trace.leafId });
    })()`);
  } catch (installError) {
    const cleanup = { monitorId, label, binding: snapshotBinding };
    try {
      if (isLivePageTarget(primaryPage)) {
        await evaluate(primaryPage, `(() => {
          window[${JSON.stringify(closeMonitorRegistryKey)}]?.[${JSON.stringify(monitorId)}]?.restore?.();
          return true;
        })()`);
      }
    } catch (error) {
      cleanup.registryRestoreError = error?.stack || String(error);
    }
    if (snapshotBindingAttempted) {
      try {
        cleanup.binding = await removeCloseDiagnosticBinding(snapshotBinding, { allowMissing: true });
        snapshotBindingInstalled = false;
      } catch (error) {
        cleanup.bindingRemovalError = error?.stack || String(error);
      }
    }
    recordCloseDiagnosticBindingCleanup(monitorId, label, cleanup);
    if (installError && typeof installError === "object") {
      installError.closeDiagnosticCleanup = cleanup;
    }
    throw installError;
  }
  return {
    page: primaryPage,
    ownerPage: view.page,
    monitorId,
    label,
    path: view.path,
    leafId: view.leafId,
    documentId: view.documentId || null,
    snapshotBinding,
    snapshotBindingInstalled,
    traceSnapshot,
  };
}

async function readCloseDiagnostics(monitor) {
  if (!isLivePageTarget(primaryPage)) return monitor.traceSnapshot?.value || null;
  try {
    const current = await evaluateJson(primaryPage, `(async () => {
      const entry = window[${JSON.stringify(closeMonitorRegistryKey)}]?.[${JSON.stringify(monitor.monitorId)}];
      const trace = entry?.trace || null;
      if (trace?.recoverCalls?.length) {
        try {
          const candidates = await app.plugins.plugins[${JSON.stringify(pluginId)}].listRecoveryCandidates();
          trace.postCloseRecoveryCandidates = candidates
            .filter(candidate => candidate.metadata?.documentId === trace.documentId)
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
          trace.postCloseRecoveryCandidatesObservedAt = new Date().toISOString();
        } catch (error) {
          trace.postCloseRecoveryCandidatesError = error?.stack || String(error);
        }
      }
      return JSON.stringify(trace);
    })()`);
    return current || monitor.traceSnapshot?.value || null;
  } catch (error) {
    if (!isLivePageTarget(primaryPage)) return monitor.traceSnapshot?.value || null;
    throw error;
  }
}

async function restoreCloseDiagnostics(monitor) {
  if (!monitor) return;
  let restoreResult = null;
  let cleanup = null;
  let bindingCleanup = null;
  let restoreError = null;
  try {
    if (isLivePageTarget(primaryPage)) {
      restoreResult = await evaluateJson(primaryPage, `JSON.stringify((() => {
        const entry = window[${JSON.stringify(closeMonitorRegistryKey)}]?.[${JSON.stringify(monitor.monitorId)}];
        if (!entry) return { found: false };
        return { found: true, ...entry.restore() };
      })())`);
    }
    if (isLivePageTarget(primaryPage)) {
      cleanup = await evaluateJson(primaryPage, `JSON.stringify((() => {
        const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
        const routing = plugin?.pdfOpenRouting;
        const key = ${JSON.stringify(closeRoutingDiagnosticRegistryKey)};
        const registry = routing?.[key];
        const patch = registry?.[${JSON.stringify(monitor.monitorId)}];
        if (!patch) return { found: false, restoredInOwnerWindow: ${JSON.stringify(restoreResult?.found === true)} };
        if (routing.originalDetach === patch.wrapper) {
          if (patch.descriptor) Object.defineProperty(routing, 'originalDetach', patch.descriptor);
          else delete routing.originalDetach;
        }
        delete registry[${JSON.stringify(monitor.monitorId)}];
        if (Object.keys(registry).length === 0) delete routing[key];
        return {
          found: true,
          restoredInOwnerWindow: ${JSON.stringify(restoreResult?.found === true)},
          restoredExactSavedFunction: routing.originalDetach === patch.original,
          diagnosticRegistryRemaining: Object.keys(routing[key] || {}).length,
        };
      })())`);
    }
    if (restoreResult?.found && restoreResult.restoredExactSavedFunction !== true) {
      throw new Error(
        `The stable-realm close monitor could not restore the exact saved SDK detach function for ${monitor.monitorId}: ${JSON.stringify(restoreResult)}`,
      );
    }
    if (restoreResult?.found && (restoreResult.diagnosticRegistryRemaining || 0) > 0) {
      throw new Error(
        `The stable-realm close monitor left diagnostic detach patches registered for ${monitor.monitorId}: ${JSON.stringify(restoreResult)}`,
      );
    }
    if (cleanup?.found && cleanup.restoredExactSavedFunction !== true) {
      throw new Error(
        `Could not restore the exact saved shared SDK detach function for close monitor ${monitor.monitorId}: ${JSON.stringify(cleanup)}`,
      );
    }
    if ((cleanup?.diagnosticRegistryRemaining || 0) > 0) {
      throw new Error(
        `Close diagnostic routing registry leaked after ${monitor.monitorId}: ${JSON.stringify(cleanup)}`,
      );
    }
  } catch (error) {
    restoreError = error;
  } finally {
    if (monitor.snapshotBindingInstalled && !monitor.snapshotBindingRemoved) {
      try {
        bindingCleanup = await removeCloseDiagnosticBinding(monitor.snapshotBinding);
        monitor.snapshotBindingRemoved = true;
      } catch (error) {
        if (!restoreError) restoreError = error;
        else if (restoreError && typeof restoreError === 'object') {
          restoreError.closeDiagnosticBindingRemovalError = error?.stack || String(error);
        }
      }
    } else {
      bindingCleanup = { removed: false, skipped: 'binding was not installed or was already removed' };
    }
    recordCloseDiagnosticBindingCleanup(monitor.monitorId, monitor.label, {
      binding: monitor.snapshotBinding,
      ...bindingCleanup,
    });
    report.checks.closeDiagnosticRoutingCleanup ??= [];
    report.checks.closeDiagnosticRoutingCleanup.push({
      monitorId: monitor.monitorId,
      label: monitor.label,
      ownerPageClosed: !isLivePageTarget(monitor.ownerPage),
      restoreResult,
      ...(cleanup || { found: false, skipped: 'primary renderer is already closed' }),
    });
  }
  if (restoreError) throw restoreError;
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
    const candidate = trace.postCloseRecoveryCandidates?.find((metadata) =>
      metadata.documentId === documentId &&
      metadata.originalPath === expectedPath &&
      metadata.origin === "recovery" &&
      metadata.reason === recoveryReason &&
      metadata.status === "draft" &&
      metadata.requestId === recovery.requestId &&
      metadata.revision === prepared.revision,
    );
    assert.ok(candidate,
      "The exact recovery draft must be present after close, following its matching durable-recovery ACK before detach.");
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
    assert.ok(square.uid, "The isolated Square editor must expose its live PDF.js UID.");
    assert.ok(square.width > 0 && square.height > 0,
      `The Square editor must have a real hit-test rectangle: ${JSON.stringify(square)}.`);
    const squareBaselineRect = before[0].serialized?.rect;
    assert.equal(before[0].type, 5, "The serialized baseline must be a Square editor.");
    assert.ok(Array.isArray(squareBaselineRect) && squareBaselineRect.length === 4,
      `The Square serialization record must expose its PDF geometry: ${JSON.stringify(before[0])}.`);
    assert.equal(before[0].storageKey, square.id,
      "The serialized Square map entry must use the live editor's internal DOM id as its storage key.");
    assert.deepEqual(square.serializedRect, squareBaselineRect,
      "The live Square editor and its annotation-storage serialization must agree on the baseline rect.");
    const assertRestoredSquareState = async (items, target, label) => {
      assert.equal(items.length, 1, `${label} must restore exactly one Square editor record.`);
      assert.equal(items[0].type, 5, `${label} must restore a Square editor record.`);
      assert.equal(items[0].storageKey, target.id,
        `${label} must restore the record under the original annotation-storage key.`);
      assert.deepEqual(items[0].serialized?.rect, squareBaselineRect,
        `${label} must restore the Square record's serialized PDF geometry.`);
      const restoredDom = await waitFor(
        `${label} to restore the original live Square editor UID`,
        () => editorDomBounds(view, 5, 0),
        (item) => item?.id === target.id && item.uid === target.uid && item.type === 5 &&
          Array.isArray(item.serializedRect),
        10_000,
      );
      assert.equal(restoredDom.id, target.id, `${label} must preserve the Square DOM id.`);
      assert.equal(restoredDom.uid, target.uid, `${label} must preserve the live Square editor UID.`);
      assert.deepEqual(restoredDom.serializedRect, squareBaselineRect,
        `${label} must restore the original Square's serialized PDF geometry.`);
      return restoredDom;
    };
    const assertSquareSurfaceHit = (hit, point, target, label) => {
      assert.equal(hit.outerIsFrame, true,
        `${label} must reach the Reader iframe: ${JSON.stringify(hit.outer)}.`);
      const pointInsideSquare = point.x > target.x && point.x < target.x + target.width &&
        point.y > target.y && point.y < target.y + target.height;
      assert.equal(pointInsideSquare, true,
        `${label} must use a point inside the Square bounds: ${JSON.stringify({ point, target })}.`);
      const directSquareHit = hit.inner?.id === target.id || hit.inner?.editorAncestorId === target.id;
      assert.equal(hit.inner?.pageNumber, "1",
        `${label} must reach the correct PDF page at the measured Square geometry: ${JSON.stringify(hit.inner)}.`);
      return { pointInsideSquare, directSquareHit, pageNumber: hit.inner.pageNumber,
        actualSurfaceClass: hit.inner.className, actualParentClass: hit.inner.parentClass };
    };
    const eraserMode = await evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      return leaf?.view?.iframe?.contentWindow?.pdfjsLib?.AnnotationEditorType?.ERASER ?? null;
    })())`);
    assert.equal(typeof eraserMode, "number", "PDF.js did not expose its current Eraser editor type.");
    evidence.mode = eraserMode;
    evidence.squareBefore = [square.uid];
    await persistReport();

    const modeForView = () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      return leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null;
    })())`);
    const rightDragResults = [];
    let contextMenu = null;
    const contextProbeKey = `__nativeRightClickProbe_${stamp}`;
    await evaluateJson(view.page, `(() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const doc = leaf?.view?.iframe?.contentDocument;
      if (!doc) throw new Error('PDF document is unavailable for the native right-click probe.');
      const events = [];
      doc.addEventListener('contextmenu', event => events.push({
        trusted: event.isTrusted,
        defaultPrevented: event.defaultPrevented,
        targetClass: typeof event.target?.className === 'string' ? event.target.className : null,
      }));
      window[${JSON.stringify(contextProbeKey)}] = events;
      return JSON.stringify(true);
    })()`);
    const squarePoint = { x: square.x + square.width / 2, y: square.y + square.height / 2 };
    const rightClickHit = await inspectNativeClickHit(view, squarePoint.x, squarePoint.y);
    const rightClickGeometry = assertSquareSurfaceHit(rightClickHit, squarePoint, square, "Native right-click");
    evidence.squareBounds = { id: square.id, uid: square.uid, x: square.x, y: square.y,
      width: square.width, height: square.height };
    evidence.rightClick = { point: squarePoint, geometry: rightClickGeometry, actualHit: rightClickHit.inner };
    await persistReport();
    await view.page.mouse.click(squarePoint.x, squarePoint.y, { button: "right" });
    await wait(150);
    contextMenu = await evaluateJson(view.page, `JSON.stringify(window[${JSON.stringify(contextProbeKey)}] || [])`);
    assert.ok(contextMenu.some((event) => event.trusted && !event.defaultPrevented),
      "An ordinary native right-click must keep its context menu and remain a no-op.");
    assert.equal(await modeForView(), 5, "An ordinary right-click must retain the active tool.");
    const squareAfterRightClick = await editorDetails(view, 5);
    assert.equal(squareAfterRightClick.length, 1,
      "An ordinary native right-click must not erase the test Square.");
    assert.equal(squareAfterRightClick[0].storageKey, before[0].storageKey,
      "An ordinary native right-click must preserve the same Square annotation-storage key.");
    assert.deepEqual(squareAfterRightClick[0].serialized, before[0].serialized,
      "An ordinary native right-click must not mutate the Square editor state.");
    const squareAfterRightClickDom = await editorDomBounds(view, 5, 0);
    assert.equal(squareAfterRightClickDom?.uid, square.uid,
      "An ordinary native right-click must preserve the same live Square editor UID.");
    evidence.rightClick = { ...evidence.rightClick, contextMenu,
      modeUnchanged: true, editorUidUnchanged: true, editorStateUnchanged: true };
    await view.page.keyboard.press("Escape");

    for (const originalMode of [0, 3, 5, 9, 10, 15, eraserMode]) {
      await setEditorMode(view, originalMode);
      if (originalMode === 9) {
        const highlightParams = () => evaluateJson(view.page, `JSON.stringify((() => {
          const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
            .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
          const frame = leaf?.view?.iframe?.contentWindow;
          const toolbar = frame?.document?.getElementById('editorHighlightParamsToolbar');
          const button = frame?.document?.getElementById('editorHighlightButton');
          const rect = toolbar?.getBoundingClientRect();
          return {
            mode: frame?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
            buttonToggled: button?.classList?.contains('toggled') ?? false,
            popupHidden: toolbar?.classList?.contains('hidden') ?? true,
            popupVisibility: toolbar ? getComputedStyle(toolbar).visibility : null,
            popupRect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          };
        })())`);
        const popupBeforeDismissal = await highlightParams();
        assert.equal(popupBeforeDismissal.mode, 9,
          `The Highlight right-drag case must start in mode 9: ${JSON.stringify(popupBeforeDismissal)}.`);
        assert.equal(popupBeforeDismissal.popupHidden, false,
          `The fixture must observe the actual mode-9 parameter popup before dismissing it: ${JSON.stringify(popupBeforeDismissal)}.`);
        await clickViewerElement(view, 'editorHighlightButton');
        const modeAfterDismissalClick = await waitFor(
          'a real click on the selected Highlight button to dismiss its parameter popup',
          highlightParams,
          (state) => state.mode === 0 && state.popupHidden,
          10_000,
        );
        await activateView(view);
        await view.page.keyboard.press('3');
        const mode9WithoutPopup = await waitFor(
          'the native PDF.js Highlight shortcut to reselect mode 9 with parameters hidden',
          highlightParams,
          (state) => state.mode === 9 && state.buttonToggled && state.popupHidden,
          10_000,
        );
        const unchangedSquare = await editorDetails(view, 5);
        assert.equal(unchangedSquare.length, 1,
          'Closing and reopening the Highlight tool must preserve the Square used for right-drag hit testing.');
        assert.equal(unchangedSquare[0].storageKey, before[0].storageKey,
          'The Highlight-popup fixture adjustment must preserve the same Square storage key.');
        assert.deepEqual(unchangedSquare[0].serialized, before[0].serialized,
          'The Highlight-popup fixture adjustment must not mutate the Square model.');
        evidence.highlightPopupDismissal = {
          initialVisiblePopup: popupBeforeDismissal,
          realButtonClick: {
            buttonId: 'editorHighlightButton',
            driver: 'trusted native pointer click through clickViewerElement',
            result: modeAfterDismissalClick,
          },
          nativeKeyboardReselect: {
            key: '3',
            shortcut: 'PDF.js built-in Highlight mode shortcut; event sets isFromKeyboard=true and hides editor parameters',
            result: mode9WithoutPopup,
          },
          squareStorageUnchanged: true,
        };
        await persistReport();
      }
      const target = await editorDomBounds(view, 5, 0);
      assert.ok(target, `The native right-drag fixture lost its Square before mode ${originalMode}.`);
      const start = { x: target.x + target.width * 0.3, y: target.y + target.height / 2 };
      const end = { x: target.x + target.width * 0.7, y: target.y + target.height / 2 };
      const startHit = await inspectNativeClickHit(view, start.x, start.y);
      const endHit = await inspectNativeClickHit(view, end.x, end.y);
      const startGeometry = assertSquareSurfaceHit(startHit, start, target,
        `Right-drag start for tool ${originalMode}`);
      const endGeometry = assertSquareSurfaceHit(endHit, end, target,
        `Right-drag end for tool ${originalMode}`);
      await verifyIdentity(view.page);
      await view.page.mouse.move(start.x, start.y);
      await view.page.mouse.down({ button: "right" });
      try {
        await view.page.mouse.move(start.x + 2, start.y);
        assert.equal(await modeForView(), originalMode,
          `Small right-button jitter must not switch tool ${originalMode} to Eraser.`);
        await view.page.mouse.move(end.x, end.y, { steps: 10 });
        await waitFor(
          `temporary native Eraser mode from right-drag while tool ${originalMode} is active`,
          modeForView,
          (mode) => mode === eraserMode,
          10_000,
        );
        await waitFor(
          `native right-drag to erase the Square while tool ${originalMode} is active`,
          () => editorDetails(view, 5),
          (items) => items.length === 0,
          10_000,
        );
      } finally {
        await view.page.mouse.up({ button: "right" });
      }
      const restoredMode = await waitFor(
        `right-drag to restore editor mode ${originalMode}`,
        modeForView,
        (mode) => mode === originalMode,
        10_000,
      );
      const undoInput = await dispatchMacChord(view, "z");
      const restoredSquare = await waitFor(
        `Command-Z to restore the Square after right-drag with mode ${originalMode}`,
        () => editorDetails(view, 5),
        (items) => items.length === 1,
        10_000,
      );
      const restoredSquareDom = await assertRestoredSquareState(
        restoredSquare, target, `Command-Z after right-drag with mode ${originalMode}`,
      );
      let redoInput = null;
      let redoRestoredUid = null;
      if (originalMode === 0) {
        redoInput = await dispatchMacChord(view, "z", { shift: true });
        await waitFor(
          "Command-Shift-Z to redo native right-drag erasure",
          () => editorDetails(view, 5),
          (items) => items.length === 0,
          10_000,
        );
        await dispatchMacChord(view, "z");
        const restoredAfterRedo = await waitFor(
          "Command-Z to restore the Square after redo verification",
          () => editorDetails(view, 5),
          (items) => items.length === 1,
          10_000,
        );
        const restoredAfterRedoDom = await assertRestoredSquareState(
          restoredAfterRedo, target, "Command-Z after redo verification",
        );
        redoRestoredUid = restoredAfterRedoDom.uid;
      }
      rightDragResults.push({
        originalMode,
        start,
        end,
        startGeometry,
        endGeometry,
        startHit: startHit.inner,
        endHit: endHit.inner,
        smallJitterPreservedMode: true,
        modeDuringDrag: eraserMode,
        restoredMode,
        erased: true,
        undoInput,
        redoInput,
        squareRestoredUid: restoredSquareDom.uid,
        restoredSerializedRect: restoredSquareDom.serializedRect,
        redoRestoredUid,
        squareRestored: (await editorDetails(view, 5)).length === 1,
      });
      await persistReport();
    }
    evidence.rightClick = { ...evidence.rightClick, actualHit: rightClickHit.inner, contextMenu };
    evidence.rightDragModes = rightDragResults;
    await persistReport();

    await setEditorMode(view, eraserMode);
    const eraserPoint = { x: square.x + square.width / 2, y: square.y + 2 };
    const eraserHit = await inspectNativeClickHit(view, eraserPoint.x, eraserPoint.y);
    const eraserGeometry = assertSquareSurfaceHit(eraserHit, eraserPoint, square, "Dedicated Eraser click");
    await verifyIdentity(view.page);
    await view.page.mouse.click(eraserPoint.x, eraserPoint.y, { button: "left" });
    await verifyIdentity(view.page);
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
    evidence.dedicatedEraserClick = { point: eraserPoint, geometry: eraserGeometry,
      actualHit: eraserHit.inner, erasedSquareUid: square.uid };
    evidence.rightDragModes = rightDragResults;
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

async function testNativeToolWheel() {
  const relativePath = testPath("native-tool-wheel");
  report.testFiles.push(relativePath);
  const evidence = {
    status: "running",
    path: relativePath,
    startedAt: new Date().toISOString(),
    sectors: [],
  };
  report.checks.nativeToolWheel = evidence;
  await persistReport();
  const view = await openReader(primaryPage, relativePath);
  try {
    await pageGeometry(view, 0);
    const center = await evaluateJson(view.page, `JSON.stringify((() => {
      const leaf=app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate=>candidate.id===${JSON.stringify(view.leafId)});
      const frame=leaf?.view?.iframe,doc=frame?.contentDocument;
      const outer=frame?.getBoundingClientRect();
      const page=doc?.querySelector('.page[data-page-number="1"]')?.getBoundingClientRect();
      const viewport=doc?.getElementById('viewerContainer')?.getBoundingClientRect();
      if(!outer || !page || !viewport) return null;
      const left=Math.max(0,outer.left+page.left,outer.left+viewport.left);
      const right=Math.min(window.innerWidth,outer.left+page.right,outer.left+viewport.right);
      const top=Math.max(0,outer.top+page.top,outer.top+viewport.top);
      const bottom=Math.min(window.innerHeight,outer.top+page.bottom,outer.top+viewport.bottom);
      if(right-left<32 || bottom-top<32) return null;
      return {x:(left+right)/2,y:(top+bottom)/2,visibleBounds:{left,right,top,bottom}};
    })())`);
    assert.ok(center,'The wheel must start in the actual visible PDF intersection');
    evidence.visibleCenter=center;
    const centerHit = await inspectNativeClickHit(view, center.x, center.y);
    assert.equal(centerHit.outerIsFrame, true,
      `Native tool-wheel center must reach the PDF iframe: ${JSON.stringify(centerHit.outer)}.`);
    const modeForView = () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      return leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null;
    })())`);
    const wheelState = () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const frame = leaf?.view?.iframe;
      const wheel = frame?.contentDocument?.querySelector('.pdfToolWheel:not(.pdfReaderBridgeClickWheel)');
      if (!frame || !wheel) return { open: false,
        mode: frame?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null };
      const frameRect = frame.getBoundingClientRect();
      const rect = wheel.getBoundingClientRect();
      return { open: true,
        mode: frame.contentWindow.PDFViewerApplication.pdfViewer.annotationEditorMode,
        center: { x: frameRect.x + rect.x + rect.width / 2, y: frameRect.y + rect.y + rect.height / 2 },
        width: rect.width, height: rect.height,
        sectors: [...wheel.querySelectorAll('button')].map(button => ({
          title: button.title || null,
          ariaLabel: button.getAttribute('aria-label'),
          className: button.className || null,
        })) };
    })())`);
    const openWheel = async () => {
      await verifyIdentity(view.page);
      await view.page.mouse.move(center.x, center.y);
      await view.page.mouse.down({ button: "middle" });
      try {
        return await waitFor(
          "native middle-button tool wheel to open",
          wheelState,
          (state) => state.open,
          8_000,
        );
      } catch (error) {
        await view.page.mouse.up({ button: "middle" }).catch(() => {});
        throw error;
      }
    };
    const selectedModes = [3, 15, 9, 5, 10];
    for (let index = 1; index <= selectedModes.length; index += 1) {
      let middleHeld = false;
      try {
        const previousMode = await modeForView();
        const opened = await openWheel();
        middleHeld = true;
        assert.equal(opened.mode, previousMode,
          "Opening the tool wheel must leave the active annotation tool unchanged.");
        const angle = ((index * 60 - 90) * Math.PI) / 180;
        const point = {
          x: opened.center.x + 80 * Math.cos(angle),
          y: opened.center.y + 80 * Math.sin(angle),
        };
        const sectorHit = await inspectNativeClickHit(view, point.x, point.y);
        assert.equal(sectorHit.outerIsFrame, true,
          `Tool-wheel sector ${index} must stay inside the Reader iframe.`);
        await view.page.mouse.move(point.x, point.y);
        const preview = await wheelState();
        assert.equal(preview.open, true, "Holding the middle button must keep the wheel open while previewing.");
        assert.equal(preview.mode, previousMode, "Moving over a wheel sector only previews until release.");
        await view.page.mouse.up({ button: "middle" });
        middleHeld = false;
        await waitFor("native tool wheel to close after sector release", wheelState, (state) => !state.open, 8_000);
        const selected = await waitFor(
          `native tool-wheel sector ${index} to select editor mode ${selectedModes[index - 1]}`,
          modeForView,
          (mode) => mode === selectedModes[index - 1],
          8_000,
        );
        evidence.sectors.push({
          index,
          previousMode,
          selectedMode: selected,
          center: opened.center,
          point,
          wheelSize: { width: opened.width, height: opened.height },
          sectorHit: sectorHit.inner,
          previewModeUnchanged: preview.mode === previousMode,
        });
        await persistReport();
      } finally {
        if (middleHeld) await view.page.mouse.up({ button: "middle" }).catch(() => {});
      }
    }

    let middleHeld = false;
    try {
      const previousMode = await modeForView();
      const opened = await openWheel();
      middleHeld = true;
      await view.page.mouse.up({ button: "middle" });
      middleHeld = false;
      const persistent = await wheelState();
      assert.equal(persistent.open, true,
        "Releasing in the wheel center must leave the wheel open for a left-click choice.");
      assert.equal(await modeForView(), previousMode,
        "Releasing in the wheel center must keep the current tool.");
      const angle = ((5 * 60 - 90) * Math.PI) / 180;
      const point = {
        x: opened.center.x + 80 * Math.cos(angle),
        y: opened.center.y + 80 * Math.sin(angle),
      };
      await view.page.mouse.click(point.x, point.y, { button: "left" });
      await waitFor("left-click to choose the active wheel sector", wheelState, (state) => !state.open, 8_000);
      assert.equal(await modeForView(), previousMode,
        "Left-clicking the already selected wheel tool must not toggle it off.");
      evidence.persistentLeftClick = { previousMode, selectedMode: await modeForView(), point };
    } finally {
      if (middleHeld) await view.page.mouse.up({ button: "middle" }).catch(() => {});
    }

    const modeBeforeExit = await modeForView();
    let exitHeld = false;
    try {
      const opened = await openWheel();
      exitHeld = true;
      const point = { x: opened.center.x, y: opened.center.y - 80 };
      await view.page.mouse.move(point.x, point.y);
      await view.page.mouse.up({ button: "middle" });
      exitHeld = false;
      await waitFor("top tool-wheel sector to close the wheel", wheelState, (state) => !state.open, 8_000);
      assert.equal(await modeForView(), modeBeforeExit,
        "Selecting the wheel exit sector must preserve the active tool.");
      evidence.exitSector = { point, mode: await modeForView() };
    } finally {
      if (exitHeld) await view.page.mouse.up({ button: "middle" }).catch(() => {});
    }

    let escapeHeld = false;
    try {
      await openWheel();
      escapeHeld = true;
      await view.page.mouse.up({ button: "middle" });
      escapeHeld = false;
      await view.page.keyboard.press("Escape");
      await waitFor("Escape to close the persistent native tool wheel", wheelState, (state) => !state.open, 8_000);
      assert.equal(await modeForView(), modeBeforeExit,
        "Escape must close the wheel without changing the active tool.");
      evidence.escape = { mode: await modeForView() };
    } finally {
      if (escapeHeld) await view.page.mouse.up({ button: "middle" }).catch(() => {});
    }

    await setEditorMode(view, 0);
    evidence.finalMode = await modeForView();
    assert.equal(evidence.finalMode, 0);
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
    await detachOwnedView(view, { allowDirty: true });
  }
}

async function testNativeFreeTextIdleAutosaveFocus() {
  const relativePath = testPath("native-freetext-idle-autosave");
  report.testFiles.push(relativePath);
  const beforeHash = await fileHash(relativePath);
  const evidence = {
    status: "running",
    path: relativePath,
    beforeHash,
    startedAt: new Date().toISOString(),
    typedText: "IdleSave",
    followUpText: "X",
    blurText: "Blur",
  };
  report.checks.nativeFreeTextIdleAutosaveFocus = evidence;
  await persistReport();
  await setAutoSave(primaryPage, true);
  const view = await openReader(primaryPage, relativePath);
  const probeKey = `__nativeFreeTextInputProbe_${stamp}`;
  try {
    await evaluateJson(view.page, `(() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const doc = leaf?.view?.iframe?.contentDocument;
      if (!doc) throw new Error('PDF document is unavailable for the native FreeText input probe.');
      const events = [];
      for (const type of ['focusin', 'focusout', 'keydown', 'beforeinput', 'input', 'keyup']) {
        doc.addEventListener(type, event => {
          const target = event.target instanceof Element ? event.target : event.target?.parentElement;
          if (!target?.closest('.freeTextEditor')) return;
          events.push({ type, trusted: event.isTrusted, timeStamp: event.timeStamp,
            key: event.key || null,
            data: event.data ?? null, targetId: target.id || null,
            activeId: doc.activeElement?.id || null,
            text: target.closest('.freeTextEditor')?.querySelector('.internal')?.textContent || '' });
        }, true);
      }
      window[${JSON.stringify(probeKey)}] = events;
      return JSON.stringify(true);
    })()`);
    await addAnnotation(view, 3);
    const freeTextSelector = '.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor .internal';
    const initial = await waitFor(
      "native FreeText editor to be connected, editable, selected, and focused",
      async () => evaluateJson(view.page, `(async () => {
        const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
          .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
        const frame = leaf?.view?.iframe;
        const doc = frame?.contentDocument;
        const internal = doc?.querySelector(${JSON.stringify(freeTextSelector)});
        const editor = internal?.closest('.freeTextEditor.selectedEditor');
        const editorRect = editor?.getBoundingClientRect();
        const selection = doc?.getSelection();
        let caretOffset = null;
        if (internal && selection?.rangeCount && selection.anchorNode && internal.contains(selection.anchorNode)) {
          const range = doc.createRange();
          range.selectNodeContents(internal);
          range.setEnd(selection.anchorNode, selection.anchorOffset);
          caretOffset = range.toString().length;
        }
        const frameRect = frame?.getBoundingClientRect();
        return JSON.stringify({ id: internal?.id || null,
          active: doc?.activeElement === internal,
          connected: !!internal?.isConnected,
          selected: !!editor,
          contentEditable: internal?.getAttribute('contenteditable') || null,
          text: internal?.textContent || '', caretOffset,
          editorRect: editorRect ? { x: frameRect.x + editorRect.x, y: frameRect.y + editorRect.y,
            width: editorRect.width, height: editorRect.height } : null,
          mode: frame?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null });
      })()`),
      (state) => state.connected && state.selected && state.contentEditable === "true" && state.editorRect?.width > 0 && state.editorRect?.height > 0,
      15_000,
    );
    if (!initial.active) {
      const point = {
        x: initial.editorRect.x + initial.editorRect.width / 2,
        y: initial.editorRect.y + initial.editorRect.height / 2,
      };
      const hit = await inspectNativeClickHit(view, point.x, point.y);
      assert.equal(hit.outerIsFrame, true,
        `Focused FreeText probe click must reach the Reader iframe: ${JSON.stringify(hit.outer)}.`);
      const inSelectedFreeText = await evaluateJson(view.page, `(() => {
        const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
          .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
        const frame = leaf?.view?.iframe;
        const rect = frame?.getBoundingClientRect();
        const hit = frame?.contentDocument?.elementFromPoint(${point.x} - rect.left, ${point.y} - rect.top);
        const editor = frame?.contentDocument?.querySelector(${JSON.stringify(freeTextSelector)})?.closest('.freeTextEditor.selectedEditor');
        return JSON.stringify(!!editor && !!hit && (hit === editor || editor.contains(hit)));
      })()`);
      assert.equal(inSelectedFreeText, true, "The focus click must hit the selected FreeText editor itself.");
      await view.page.mouse.click(point.x, point.y, { button: "left" });
    }
    const focusSnapshot = async () => evaluateJson(view.page, `(async () => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const frame = leaf?.view?.iframe;
      const doc = frame?.contentDocument;
      const internal = doc?.querySelector(${JSON.stringify(freeTextSelector)});
      const editor = internal?.closest('.freeTextEditor.selectedEditor');
      const selection = doc?.getSelection();
      let caretOffset = null;
      if (internal && selection?.rangeCount && selection.anchorNode && internal.contains(selection.anchorNode)) {
        const range = doc.createRange();
        range.selectNodeContents(internal);
        range.setEnd(selection.anchorNode, selection.anchorOffset);
        caretOffset = range.toString().length;
      }
      return JSON.stringify({ id: internal?.id || null,
        active: doc?.activeElement === internal,
        connected: !!internal?.isConnected,
        selected: !!editor,
        mode: frame?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
        contentEditable: internal?.getAttribute('contenteditable') || null,
        text: internal?.textContent || '', caretOffset,
        events: window[${JSON.stringify(probeKey)}] || [],
        dirty: !!frame?.contentWindow?.PDFViewerApplication?._hasChanges?.(),
        saving: !!leaf?.view?.saving });
    })()`);
    let focused = await waitFor(
      "native click to focus the selected FreeText editor",
      focusSnapshot,
      (state) => state.active && state.connected && state.selected && state.contentEditable === "true",
      10_000,
    );
    assert.equal(focused.mode, 3, "Focused FreeText must remain in its native editor mode.");
    const savedSnapshots = [];
    const appendAndWaitForSave = async (text, previousHash, label) => {
      const eventStart = focused.events.length;
      await verifyIdentity(view.page);
      await view.page.keyboard.type(text);
      await waitFor(
        `trusted Electron input ${JSON.stringify(text)} in selected FreeText`,
        focusSnapshot,
        (state) => state.active && state.selected && state.text.endsWith(text) &&
          state.events.slice(eventStart).filter((event) => event.type === "keydown" && event.trusted).length >= text.length &&
          state.events.slice(eventStart).filter((event) => event.type === "input" && event.trusted).length >= text.length,
        15_000,
      );
      const saved = await waitForSaved(view, relativePath, previousHash,
        `${label} FreeText idle autosave to update the PDF bytes`);
      const after = await focusSnapshot();
      assert.equal(after.active, true, `${label} idle autosave must keep the FreeText input focused.`);
      assert.equal(after.connected, true, `${label} idle autosave must keep the FreeText DOM connected.`);
      assert.equal(after.selected, true, `${label} idle autosave must keep the same FreeText editor selected.`);
      assert.equal(after.contentEditable, "true", `${label} idle autosave must leave FreeText editable.`);
      assert.equal(after.caretOffset, after.text.length,
        `${label} idle autosave must keep the caret at the end of the typed text.`);
      assert.equal(after.dirty, false, `${label} idle autosave should acknowledge the current revision.`);
      assert.equal(after.saving, false, `${label} idle autosave should finish its host write.`);
      const focusOutAfterTyping = after.events.slice(eventStart).some((event) => event.type === "focusout");
      assert.equal(focusOutAfterTyping, false, `${label} idle autosave must not blur the active FreeText editor.`);
      const result = { label, savedHash: saved.hash, state: after, typedInputEvents: after.events.slice(eventStart) };
      savedSnapshots.push(result);
      focused = after;
      evidence.idleSaves = savedSnapshots;
      await persistReport();
      return saved;
    };
    const firstSave = await appendAndWaitForSave(evidence.typedText, beforeHash, "first");
    const secondSave = await appendAndWaitForSave(evidence.followUpText, firstSave.hash, "follow-up");
    const expectedText = `${evidence.typedText}${evidence.followUpText}${evidence.blurText}`;
    evidence.expectedText = expectedText;

    // Prepare and verify an actual toolbar target before typing so the blur click
    // can follow the final input immediately, without an intervening DOM probe.
    const blurTarget = await viewerElementPoint(view, "zoomInButton");
    assert.ok(blurTarget && blurTarget.width > 0 && blurTarget.height > 0 && !blurTarget.hidden,
      `The PDF.js zoom toolbar button must be visible for a real FreeText blur click: ${JSON.stringify(blurTarget)}.`);
    const blurTargetHit = await inspectNativeClickHit(view, blurTarget.x, blurTarget.y, "zoomInButton");
    assert.equal(blurTargetHit.outerIsFrame, true,
      `The FreeText blur click must reach the PDF.js toolbar: ${JSON.stringify(blurTargetHit.outer)}.`);
    assert.equal(blurTargetHit.innerWithinExpected, true,
      `The FreeText blur click must hit the zoom toolbar button: ${JSON.stringify(blurTargetHit.inner)}.`);

    const blurEventStart = focused.events.length;
    await verifyIdentity(view.page);
    await view.page.keyboard.type(evidence.blurText);
    const dirtyBeforeBlur = await waitFor(
      "trusted dirty FreeText input immediately before a real toolbar blur",
      focusSnapshot,
      (state) => state.active && state.connected && state.selected && state.dirty &&
        state.text.endsWith(evidence.blurText) &&
        state.events.slice(blurEventStart).filter((event) => event.type === "input" && event.trusted).length >= evidence.blurText.length,
      3_000,
    );
    assert.equal(dirtyBeforeBlur.dirty, true,
      "The final FreeText edit must still be dirty immediately before clicking the toolbar.");
    const hashBeforeBlurClick = await fileHash(relativePath);
    assert.equal(hashBeforeBlurClick, secondSave.hash,
      "The real-blur probe must begin before the final FreeText text has been written to disk.");
    await verifyIdentity(view.page);
    await view.page.mouse.click(blurTarget.x, blurTarget.y, { button: "left" });
    await verifyIdentity(view.page);
    const blurred = await waitFor(
      "a trusted focusout after the real PDF.js toolbar click",
      focusSnapshot,
      (state) => !state.active && state.events.slice(blurEventStart)
        .some((event) => event.type === "focusout" && event.trusted),
      5_000,
    );
    const blurEvents = blurred.events.slice(blurEventStart);
    const lastTrustedInput = [...blurEvents].reverse()
      .find((event) => event.type === "input" && event.trusted);
    const trustedFocusOut = blurEvents.find((event) => event.type === "focusout" && event.trusted);
    assert.ok(lastTrustedInput, "The dirty-blur probe must capture a trusted input event.");
    assert.ok(trustedFocusOut, "A real toolbar click must produce a trusted FreeText focusout event.");
    const inputToBlurMs = trustedFocusOut.timeStamp - lastTrustedInput.timeStamp;
    assert.ok(inputToBlurMs >= 0 && inputToBlurMs < 1_000,
      `The real toolbar blur must follow the last trusted input within one second; observed ${inputToBlurMs}ms.`);
    assert.ok(trustedFocusOut.text.includes(expectedText),
      `The blur event must still observe the expected FreeText contents ${JSON.stringify(expectedText)}; got ${JSON.stringify(trustedFocusOut)}.`);
    const blurSave = await waitForSaved(view, relativePath, secondSave.hash,
      "dirty FreeText contents to save after the real toolbar focusout");
    const cleanAfterBlur = await waitFor(
      "the real-blur FreeText revision to become clean after the host save",
      focusSnapshot,
      (state) => !state.active && !state.dirty && !state.saving,
      10_000,
    );
    evidence.dirtyBlur = {
      toolbarTarget: "zoomInButton",
      toolbarPoint: { x: blurTarget.x, y: blurTarget.y },
      toolbarHit: blurTargetHit.inner,
      hashBeforeClick: hashBeforeBlurClick,
      dirtyBeforeClick: dirtyBeforeBlur.dirty,
      trustedInput: lastTrustedInput,
      trustedFocusOut,
      inputToBlurMs,
      savedHash: blurSave.hash,
      cleanAfterBlur,
    };
    await persistReport();

    const reopened = await reopenPdf(view);
    const reopenedText = await nativeFreeTextAnnotationRecords(view);
    assert.ok(reopened.subtypes.includes("FreeText"), "The idle-autosaved FreeText annotation must survive reopening.");
    assert.ok(reopenedText.some((annotation) =>
      `${annotation.contentsObjText || ""}\n${annotation.textContent || ""}`.includes(expectedText)),
    `The reopened PDF must preserve the actual typed FreeText contents ${JSON.stringify(expectedText)} in Contents/textContent; got ${JSON.stringify(reopenedText)}.`);
    evidence.firstSaveHash = firstSave.hash;
    evidence.idleFollowUpSaveHash = secondSave.hash;
    evidence.finalSaveHash = blurSave.hash;
    evidence.reopenedSubtypes = reopened.subtypes;
    evidence.reopenedText = reopenedText;
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
    if (!nativeCdpUnavailable) await detachOwnedView(view, { allowDirty: true }).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
  }
}

async function testNativeFreeTextUndoVisualRecovery() {
  const relativePath = testPath("native-freetext-undo");
  report.testFiles.push(relativePath);
  const originalHash = await fileHash(relativePath);
  const typedText = "UndoVisualProof";
  const evidence = {
    status: "running",
    path: relativePath,
    originalHash,
    typedText,
    startedAt: new Date().toISOString(),
  };
  report.checks.nativeFreeTextUndoVisualRecovery = evidence;
  await persistReport();
  let view;
  await setAutoSave(primaryPage, false);
  try {
    view = await openReader(primaryPage, relativePath);
    await addAnnotation(view, 3);

    const inputState = async () => evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const frame = leaf?.view?.iframe;
      const doc = frame?.contentDocument;
      const editor = doc?.querySelector('.page[data-page-number="1"] .annotationEditorLayer .freeTextEditor.selectedEditor');
      const internal = editor?.querySelector('.internal');
      const editorRect = editor?.getBoundingClientRect();
      const frameRect = frame?.getBoundingClientRect();
      return {
        mode: frame?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
        id: editor?.id || null,
        active: !!internal && doc.activeElement === internal,
        connected: !!internal?.isConnected,
        selected: !!editor,
        contentEditable: internal?.getAttribute('contenteditable') ?? null,
        text: internal?.textContent || '',
        rect: editorRect && frameRect ? {
          x: frameRect.x + editorRect.x, y: frameRect.y + editorRect.y,
          width: editorRect.width, height: editorRect.height,
        } : null,
      };
    })())`);
    let editing = await waitFor(
      "new FreeText editor to be ready for real native text input",
      inputState,
      (state) => state?.mode === 3 && state.connected && state.selected &&
        state.contentEditable === "true" && state.rect?.width > 0 && state.rect?.height > 0,
      15_000,
    );
    if (!editing.active) {
      const point = {
        x: editing.rect.x + editing.rect.width / 2,
        y: editing.rect.y + editing.rect.height / 2,
      };
      const hit = await inspectNativeClickHit(view, point.x, point.y, editing.id);
      assert.equal(hit.outerIsFrame, true,
        `The FreeText input focus click must reach the Reader iframe: ${JSON.stringify(hit.outer)}.`);
      assert.equal(hit.innerWithinExpected, true,
        `The FreeText input focus click must hit the selected editor: ${JSON.stringify(hit.inner)}.`);
      await view.page.mouse.click(point.x, point.y, { button: "left" });
      editing = await waitFor(
        "native click to focus the new FreeText editor",
        inputState,
        (state) => state.active && state.connected && state.contentEditable === "true",
        10_000,
      );
    }
    assert.equal(editing.active, true, "The created FreeText editor must receive actual keyboard input.");
    await verifyIdentity(view.page);
    await view.page.keyboard.type(typedText);
    const typed = await waitFor(
      "real typed FreeText contents to appear in the editor",
      inputState,
      (state) => state.active && state.connected && state.text.includes(typedText),
      15_000,
    );
    assert.equal(typed.mode, 3);
    const freeTextTool = await viewerElementPoint(view, "editorFreeTextButton");
    assert.ok(freeTextTool && freeTextTool.width > 0 && freeTextTool.height > 0 && !freeTextTool.hidden,
      `The selected PDF.js FreeText tool must be visible before committing the native editor: ${JSON.stringify(freeTextTool)}.`);
    const freeTextToolHit = await clickAt(
      view,
      freeTextTool.x,
      freeTextTool.y,
      "editorFreeTextButton",
    );
    const modeAfterToolbarCommit = await waitFor(
      "a trusted click on the selected FreeText toolbar button to commit the editor and return to NONE mode",
      () => readerRuntimeState(view),
      (state) => state.ready && state.editorMode === 0,
      15_000,
    );
    evidence.modeExitByToolbar = {
      button: "editorFreeTextButton",
      point: freeTextTool,
      hit: freeTextToolHit,
      committedState: modeAfterToolbarCommit,
    };
    await persistReport();
    const stored = await waitFor(
      "new FreeText contents to commit to PDF.js annotation storage",
      () => editorDetails(view, 3),
      (items) => items.length === 1 && JSON.stringify(items[0].serialized).includes(typedText),
      10_000,
    );
    evidence.createdEditor = { ...typed, serialized: stored[0].serialized };

    await dispatchMacSave(view);
    const firstSave = await waitForSaved(
      view,
      relativePath,
      originalHash,
      "Cmd+S to write the new FreeText and its PDF appearance",
    );
    evidence.firstSaveHash = firstSave.hash;
    await persistReport();

    const firstReopen = await reopenPdf(view);
    assert.ok(firstReopen.subtypes.includes("FreeText"),
      "The created FreeText must be present in the saved PDF before the undo test begins.");
    const savedAnnotations = await nativeFreeTextAnnotationRecords(view);
    assert.equal(savedAnnotations.length, 1,
      `The saved fixture must contain exactly one FreeText annotation: ${JSON.stringify(savedAnnotations)}.`);
    const savedAnnotation = savedAnnotations[0];
    const savedText = savedAnnotation.contentsObjText ?? savedAnnotation.textContent ?? "";
    assert.ok(savedText.includes(typedText),
      `The PDF Contents/textContent must preserve ${JSON.stringify(typedText)}; got ${JSON.stringify(savedAnnotation)}.`);
    assert.equal(savedAnnotation.hasAppearance, true,
      `Reopening must confirm a real FreeText AP before erasure: ${JSON.stringify(savedAnnotation)}.`);
    const modeAfterReopen = await waitFor(
      "reopened FreeText fixture to return to normal NONE mode",
      async () => readerRuntimeState(view),
      (state) => state.ready && state.editorMode === 0,
      15_000,
    );
    let baselineVisual = await waitFor(
      "the saved FreeText AP to render visibly in NONE mode before erasing",
      () => nativeFreeTextVisualState(view, savedAnnotation.id),
      (state) => state?.mode === 0 && state.pageLoaded && !state.pageLoading &&
        state.sectionPresent && state.visibleAppearance &&
        state.sectionRect?.width > 0 && state.sectionRect?.height > 0,
      30_000,
    );
    baselineVisual = await nativeFreeTextVisualState(view, savedAnnotation.id, { inspectPixels: true });
    assert.equal(baselineVisual.mode, 0, "A reopened PDF starts the erase/undo sequence in NONE mode.");
    assert.equal(baselineVisual.visibleAppearance, true,
      `The reopened FreeText AP must have visible bounds/content in NONE mode: ${JSON.stringify(baselineVisual)}.`);
    if (baselineVisual.canvas?.visible) {
      assert.ok(baselineVisual.canvas.pixels?.alphaPixels > 0 && baselineVisual.canvas.pixels?.nonWhitePixels > 0,
        `The visible AP canvas must contain painted text pixels: ${JSON.stringify(baselineVisual.canvas)}.`);
    }
    const appearanceUsesPageCanvas = baselineVisual.pageCanvas?.visible &&
      !baselineVisual.canvas?.visible && !baselineVisual.visibleText?.visible;
    if (appearanceUsesPageCanvas) {
      assert.ok(baselineVisual.pageCanvas.roiPixels?.nonWhitePixels > 0,
        `The FreeText AP must paint pixels in its page-canvas ROI: ${JSON.stringify(baselineVisual.pageCanvas)}.`);
    }
    if (baselineVisual.visibleText?.visible) {
      assert.ok(baselineVisual.visibleText.text.includes(typedText),
        `Visible PDF.js FreeText content must preserve the typed text: ${JSON.stringify(baselineVisual.visibleText)}.`);
    }
    const roi = baselineVisual.sectionRect;
    evidence.savedReopen = {
      readerState: modeAfterReopen,
      annotation: savedAnnotation,
      visible: baselineVisual,
    };
    evidence.screenshots ||= {};
    evidence.screenshots.beforeErase = await saveNativeFreeTextRoiScreenshot(
      view,
      "freetext-undo-before-erase",
      roi,
      baselineVisual,
    );

    const freeTextStorageState = async () => evaluateJson(view.page, `(() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const pdf = leaf?.view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument;
      const entries = [...(pdf?.annotationStorage?.serializable?.map?.entries?.() || [])];
      const matches = entries.filter(([key, item]) =>
        String(key) === ${JSON.stringify(savedAnnotation.id)} ||
        String(item?.id || '') === ${JSON.stringify(savedAnnotation.id)} ||
        String(item?.annotationElementId || '') === ${JSON.stringify(savedAnnotation.id)});
      return JSON.stringify({
        documentId: leaf?.view?.documentId || null,
        annotationId: ${JSON.stringify(savedAnnotation.id)},
        matchingRecords: matches.map(([key, item]) => ({
          storageKey: String(key),
          id: item?.id ?? null,
          annotationElementId: item?.annotationElementId ?? null,
          deleted: item?.deleted === true,
          annotationType: item?.annotationType ?? null,
          rect: item?.rect ? Array.from(item.rect) : null,
          value: item?.value ?? null,
        })),
        freeTextRecordCount: entries.filter(([, item]) => item?.annotationType === 3).length,
      });
    })()`);
    const beforeEraseStorage = await freeTextStorageState();
    evidence.savedReopen.storage = beforeEraseStorage;

    const start = { x: roi.x + roi.width * 0.28, y: roi.y + roi.height * 0.5 };
    const end = { x: roi.x + roi.width * 0.72, y: roi.y + roi.height * 0.5 };
    const startHit = await nativeFreeTextHit(view, start.x, start.y, savedAnnotation.id);
    const endHit = await nativeFreeTextHit(view, end.x, end.y, savedAnnotation.id);
    assert.equal(startHit.outerIsFrame, true,
      `The NONE-mode right-drag start must reach the Reader iframe: ${JSON.stringify(startHit)}.`);
    assert.equal(endHit.outerIsFrame, true,
      `The NONE-mode right-drag end must reach the Reader iframe: ${JSON.stringify(endHit)}.`);
    assert.equal(startHit.hitsExpectedFreeText, true,
      `The NONE-mode right-drag must start on the saved FreeText AP: ${JSON.stringify(startHit)}.`);
    assert.equal(endHit.hitsExpectedFreeText, true,
      `The NONE-mode right-drag must end on the saved FreeText AP: ${JSON.stringify(endHit)}.`);
    await verifyIdentity(view.page);
    await view.page.mouse.move(start.x, start.y);
    await view.page.mouse.down({ button: "right" });
    try {
      await view.page.mouse.move(start.x + 2, start.y);
      assert.equal((await readerRuntimeState(view)).editorMode, 0,
        "Two-pixel right-button jitter on a saved FreeText AP must keep normal NONE mode.");
      await view.page.mouse.move(end.x, end.y, { steps: 10 });
      const erased = await waitFor(
        "NONE-mode right-drag to activate Eraser and serialize deletion of the saved FreeText identity",
        async () => ({
          reader: await readerRuntimeState(view),
          storage: await freeTextStorageState(),
          visual: await nativeFreeTextVisualState(view, savedAnnotation.id, {
            inspectPixels: true,
            roiRect: roi,
          }),
        }),
        (state) => state.reader.editorMode === 17 && state.visual.pageLoaded &&
          !state.visual.pageLoading && state.storage.matchingRecords.some((record) =>
            record.id === savedAnnotation.id && record.deleted),
        10_000,
      );
      evidence.eraseWhileDragging = {
        eraserMode: erased.reader.editorMode,
        start,
        end,
        startHit: startHit.inner,
        endHit: endHit.inner,
        storageBeforeErase: beforeEraseStorage,
        storageAfterErase: erased.storage,
        visibleAppearanceDuringTemporaryMode: erased.visual.visibleAppearance,
        sectionPresentDuringTemporaryMode: erased.visual.sectionPresent,
        sectionVisibleDuringTemporaryMode: erased.visual.sectionVisible,
        pageCanvasDuringTemporaryMode: erased.visual.pageCanvas,
      };
    } finally {
      await view.page.mouse.up({ button: "right" });
    }
    const restoredMode = await waitFor(
      "temporary Eraser to restore normal NONE mode after right-drag",
      () => readerRuntimeState(view),
      (state) => state.editorMode === 0,
      10_000,
    );
    const erasedState = await waitFor(
      "deleted FreeText AP to remain invisible with changed ROI pixels after the right-drag restores NONE mode",
      async () => ({
        visual: await nativeFreeTextVisualState(view, savedAnnotation.id, {
          inspectPixels: true,
          roiRect: roi,
        }),
        storage: await freeTextStorageState(),
      }),
      (state) => state.visual?.mode === 0 && state.visual.pageLoaded &&
        !state.visual.pageLoading && !state.visual.sectionVisible &&
        !state.visual.visibleAppearance &&
        state.visual.pageCanvas?.roiPixels?.fingerprint !== baselineVisual.pageCanvas?.roiPixels?.fingerprint &&
        state.storage.matchingRecords.some((record) =>
          record.id === savedAnnotation.id && record.deleted),
      15_000,
    );
    const erasedVisual = erasedState.visual;
    assert.equal(erasedVisual.mode, 0,
      `The right-drag must restore NONE mode before visual erasure is assessed: ${JSON.stringify(erasedVisual)}.`);
    assert.equal(erasedVisual.sectionVisible, false,
      `The erased saved FreeText AP must not remain visible, even if PDF.js retains a hidden annotation node: ${JSON.stringify(erasedVisual)}.`);
    assert.equal(erasedVisual.visibleAppearance, false,
      `The erased saved FreeText must no longer paint its AP: ${JSON.stringify(erasedVisual)}.`);
    const deletedRecord = erasedState.storage.matchingRecords.find((record) =>
      record.id === savedAnnotation.id && record.deleted);
    assert.ok(deletedRecord,
      `PDF.js serialization must mark the matching saved annotation ID deleted: ${JSON.stringify(erasedState.storage)}.`);
    assert.notEqual(erasedVisual.pageCanvas?.roiPixels?.fingerprint,
      baselineVisual.pageCanvas?.roiPixels?.fingerprint,
      "Erasing the saved FreeText must change the original page-canvas ROI after NONE mode returns.");
    if (appearanceUsesPageCanvas) {
      assert.ok(erasedVisual.pageCanvas?.roiPixels?.fingerprint,
        `The erased FreeText page-canvas ROI must be sampled: ${JSON.stringify(erasedVisual.pageCanvas)}.`);
      assert.notEqual(erasedVisual.pageCanvas.roiPixels.fingerprint,
        baselineVisual.pageCanvas.roiPixels.fingerprint,
        "Erasing the saved FreeText must change its rendered page-canvas ROI.");
    }
    evidence.eraseWhileDragging.restoredMode = restoredMode.editorMode;
    evidence.eraseWhileDragging.deletedRecord = deletedRecord;
    evidence.eraseWhileDragging.afterRelease = erasedVisual;
    evidence.eraseWhileDragging.storageAfterRelease = erasedState.storage;
    evidence.screenshots.afterErase = await saveNativeFreeTextRoiScreenshot(
      view,
      "freetext-undo-after-erase",
      roi,
      erasedVisual,
    );
    await persistReport();

    const undoProbeKey = `__nativeFreeTextUndoProbe_${stamp}`;
    const undoProbeInstalled = await evaluateJson(view.page, `JSON.stringify((() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
      const frameElement = leaf?.view?.iframe;
      const win = frameElement?.contentWindow;
      const doc = frameElement?.contentDocument;
      if (!win || !doc || !win.PDFViewerApplication?.pdfViewer) {
        throw new Error('Cannot install the trusted Command-Z diagnostic without the current PDF iframe.');
      }
      const events = [];
      const targetState = target => target ? {
        tag: target.tagName || null,
        id: target.id || null,
        className: typeof target.className === 'string' ? target.className : null,
        contentEditable: target.getAttribute?.('contenteditable') ?? null,
      } : null;
      const snapshot = () => {
        const viewer = win.PDFViewerApplication?.pdfViewer;
        const pdf = win.PDFViewerApplication?.pdfDocument;
        const entries = [...(pdf?.annotationStorage?.serializable?.map?.entries?.() || [])];
        const matchingRecords = entries.filter(([key, item]) =>
          String(key) === ${JSON.stringify(savedAnnotation.id)} ||
          String(item?.id || '') === ${JSON.stringify(savedAnnotation.id)} ||
          String(item?.annotationElementId || '') === ${JSON.stringify(savedAnnotation.id)});
        const manager = viewer?._layerProperties?.annotationEditorUIManager;
        const editors = [...(manager?.getEditors?.(0) || [])].map(editor => {
          const element = editor?.div || null;
          const rect = element?.getBoundingClientRect();
          return {
            id: editor?.id ?? null,
            annotationElementId: editor?.annotationElementId ?? element?.dataset?.annotationId ?? null,
            deleted: editor?.deleted ?? editor?._deleted ?? null,
            connected: !!element?.isConnected,
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          };
        });
        const section = [...(doc.querySelectorAll('.annotationLayer section[data-annotation-id]') || [])]
          .find(element => element.getAttribute('data-annotation-id') === ${JSON.stringify(savedAnnotation.id)}) || null;
        const sectionRect = section?.getBoundingClientRect();
        const sectionStyle = section ? win.getComputedStyle(section) : null;
        const page = doc.querySelector('.page[data-page-number="1"]');
        const canvas = page?.querySelector('.canvasWrapper canvas');
        const canvasRect = canvas?.getBoundingClientRect();
        const frameRect = frameElement.getBoundingClientRect();
        let roiPixels = null;
        if (canvas && canvasRect && canvas.width > 0 && canvas.height > 0) {
          try {
            const requested = ${JSON.stringify(roi)};
            const scaleX = canvas.width / canvasRect.width;
            const scaleY = canvas.height / canvasRect.height;
            const left = Math.max(0, Math.floor((requested.x - frameRect.x - canvasRect.x) * scaleX));
            const top = Math.max(0, Math.floor((requested.y - frameRect.y - canvasRect.y) * scaleY));
            const right = Math.min(canvas.width, Math.ceil((requested.x + requested.width - frameRect.x - canvasRect.x) * scaleX));
            const bottom = Math.min(canvas.height, Math.ceil((requested.y + requested.height - frameRect.y - canvasRect.y) * scaleY));
            const width = right - left;
            const height = bottom - top;
            if (width > 0 && height > 0) {
              const rgba = canvas.getContext('2d')?.getImageData(left, top, width, height).data;
              if (rgba) {
                let nonWhitePixels = 0;
                let hash = 2166136261;
                for (let index = 0; index < rgba.length; index += 4) {
                  if (rgba[index] < 245 || rgba[index + 1] < 245 || rgba[index + 2] < 245) nonWhitePixels += 1;
                }
                for (let index = 0; index < rgba.length; index += 1) hash = Math.imul(hash ^ rgba[index], 16777619);
                roiPixels = { width, height, nonWhitePixels, fingerprint: (hash >>> 0).toString(16).padStart(8, '0') };
              }
            }
          } catch (error) { roiPixels = { error: error?.message || String(error) }; }
        }
        const active = doc.activeElement;
        return {
          at: performance.now(),
          mode: viewer?.annotationEditorMode ?? null,
          activeElement: targetState(active),
          focusWithinFrame: doc.hasFocus?.() ?? null,
          matchingRecords: matchingRecords.map(([key, item]) => ({
            storageKey: String(key), id: item?.id ?? null,
            annotationElementId: item?.annotationElementId ?? null,
            deleted: item?.deleted === true,
            annotationType: item?.annotationType ?? null,
            rect: item?.rect ? Array.from(item.rect) : null,
          })),
          editorCount: editors.length,
          editors,
          section: section ? {
            className: section.className,
            display: sectionStyle?.display ?? null,
            visibility: sectionStyle?.visibility ?? null,
            opacity: sectionStyle?.opacity ?? null,
            connected: section.isConnected,
            rect: sectionRect ? { x: sectionRect.x, y: sectionRect.y, width: sectionRect.width, height: sectionRect.height } : null,
          } : null,
          pageLoaded: page?.dataset?.loaded === 'true',
          pageLoading: !!page?.classList?.contains('loading') || !!page?.classList?.contains('loadingIcon'),
          roiPixels,
        };
      };
      const listener = event => {
        if (!(event.key === 'Meta' || event.key?.toLowerCase() === 'z')) return;
        const entry = {
          type: event.type, trusted: event.isTrusted, key: event.key, code: event.code,
          metaKey: event.metaKey, shiftKey: event.shiftKey, repeat: event.repeat,
          defaultPreventedAtCapture: event.defaultPrevented,
          target: targetState(event.target), activeElementAtCapture: targetState(doc.activeElement),
        };
        events.push(entry);
        queueMicrotask(() => {
          entry.defaultPreventedAfterDispatch = event.defaultPrevented;
          entry.activeElementAfterDispatch = targetState(doc.activeElement);
        });
      };
      win.addEventListener('keydown', listener, true);
      win.addEventListener('keyup', listener, true);
      win[${JSON.stringify(undoProbeKey)}] = { events, snapshot, listener };
      return { installed: true, documentId: leaf.view?.documentId || null,
        activeElement: targetState(doc.activeElement), snapshot: snapshot() };
    })())`);
    assert.equal(undoProbeInstalled.installed, true,
      `The trusted key diagnostic must be installed before Command-Z: ${JSON.stringify(undoProbeInstalled)}.`);
    evidence.undoProbeInstalled = undoProbeInstalled;
    const undoInput = await dispatchMacChord(view, "z");
    let undoDispatchDiagnostics;
    try {
      undoDispatchDiagnostics = await evaluateJsonBounded(view.page, `(async () => {
        const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
          .find(candidate => candidate.id === ${JSON.stringify(view.leafId)});
        const win = leaf?.view?.iframe?.contentWindow;
        const probe = win?.[${JSON.stringify(undoProbeKey)}];
        if (!probe) throw new Error('Trusted Command-Z diagnostic listener disappeared.');
        const snapshots = [{ phase: 'immediate-after-keyup', state: probe.snapshot() }];
        await Promise.resolve();
        snapshots.push({ phase: 'microtask-after-keyup', state: probe.snapshot() });
        await new Promise(resolve => win.requestAnimationFrame(() => resolve()));
        snapshots.push({ phase: 'animation-frame-after-keyup', state: probe.snapshot() });
        return JSON.stringify({
          events: probe.events.map(event => ({ ...event })),
          snapshots,
          commandStack: {
            canUndo: win.PDFViewerApplication?.pdfViewer?._layerProperties?.annotationEditorUIManager?.canUndo ?? null,
            canRedo: win.PDFViewerApplication?.pdfViewer?._layerProperties?.annotationEditorUIManager?.canRedo ?? null,
          },
        });
      })()`, 'capture trusted Command-Z state snapshots', 12_000);
    } catch (error) {
      undoDispatchDiagnostics = { captureError: error?.stack || String(error) };
    }
    evidence.undoDispatchDiagnostics = { input: undoInput, ...undoDispatchDiagnostics };
    await persistReport();
    let undoVisual = await waitFor(
      "Command-Z in NONE mode to restore the saved FreeText AP visibly",
      () => nativeFreeTextVisualState(view, savedAnnotation.id),
      (state) => state?.mode === 0 && state.pageLoaded && !state.pageLoading &&
        state.sectionVisible && state.visibleAppearance &&
        state.sectionRect?.width > 0 && state.sectionRect?.height > 0,
      30_000,
    );
    undoVisual = await nativeFreeTextVisualState(view, savedAnnotation.id, {
      inspectPixels: true,
      roiRect: roi,
    });
    assert.equal(undoVisual.mode, 0, "Command-Z visual recovery must leave PDF.js in normal NONE mode.");
    assert.equal(undoVisual.sectionVisible, true,
      `Command-Z must restore the visible AP section even if the editor DOM remains hidden: ${JSON.stringify(undoVisual)}.`);
    assert.equal(undoVisual.visibleAppearance, true,
      `Command-Z must restore visible AP/canvas content even if the editor DOM is hidden: ${JSON.stringify(undoVisual)}.`);
    if (undoVisual.canvas?.visible) {
      assert.ok(undoVisual.canvas.pixels?.alphaPixels > 0 && undoVisual.canvas.pixels?.nonWhitePixels > 0,
        `Command-Z must repaint the FreeText AP, not only its model: ${JSON.stringify(undoVisual.canvas)}.`);
    }
    if (undoVisual.visibleText?.visible) {
      assert.ok(undoVisual.visibleText.text.includes(typedText),
        `Command-Z must restore the entered FreeText text: ${JSON.stringify(undoVisual.visibleText)}.`);
    }
    if (appearanceUsesPageCanvas) {
      assert.equal(undoVisual.pageCanvas?.roiPixels?.fingerprint,
        baselineVisual.pageCanvas.roiPixels.fingerprint,
        "Command-Z must repaint the same FreeText appearance in the original page-canvas ROI.");
    }
    evidence.undo = {
      input: undoInput,
      visible: undoVisual,
      editorDOM: undoVisual.normalNoneEditor,
    };
    evidence.screenshots.afterUndo = await saveNativeFreeTextRoiScreenshot(
      view,
      "freetext-undo-after-undo",
      roi,
      undoVisual,
    );

    const redoInput = await dispatchMacChord(view, "z", { shift: true });
    let redoHidden = await waitFor(
      "Command-Shift-Z in NONE mode to remove the FreeText AP again",
      () => nativeFreeTextVisualState(view, savedAnnotation.id),
      (state) => state?.mode === 0 && state.pageLoaded && !state.pageLoading &&
        !state.sectionVisible && !state.visibleAppearance,
      20_000,
    );
    redoHidden = await nativeFreeTextVisualState(view, savedAnnotation.id, {
      inspectPixels: true,
      roiRect: roi,
    });
    assert.equal(redoHidden.mode, 0,
      `Command-Shift-Z must leave PDF.js in normal NONE mode: ${JSON.stringify(redoHidden)}.`);
    assert.equal(redoHidden.pageLoaded, true,
      `The page must remain loaded after Redo: ${JSON.stringify(redoHidden)}.`);
    assert.equal(redoHidden.pageLoading, false,
      `The page must finish rendering after Redo: ${JSON.stringify(redoHidden)}.`);
    assert.equal(redoHidden.sectionVisible, false,
      `Command-Shift-Z must hide the FreeText AP section again; a retained hidden PDF.js annotation node is acceptable: ${JSON.stringify(redoHidden)}.`);
    assert.equal(redoHidden.visibleAppearance, false,
      `Command-Shift-Z must remove the visible FreeText AP again: ${JSON.stringify(redoHidden)}.`);
    if (appearanceUsesPageCanvas) {
      assert.equal(redoHidden.pageCanvas?.roiPixels?.fingerprint,
        erasedVisual.pageCanvas.roiPixels.fingerprint,
        "Redo must reproduce the erased FreeText page-canvas ROI.");
    }
    evidence.redo = { input: redoInput, annotationVisible: redoHidden.sectionVisible, mode: redoHidden.mode };
    evidence.screenshots.afterRedo = await saveNativeFreeTextRoiScreenshot(
      view,
      "freetext-undo-after-redo",
      roi,
      redoHidden,
    );
    const finalUndoInput = await dispatchMacChord(view, "z");
    let finalUndoVisual = await waitFor(
      "a final Command-Z to restore the FreeText after Redo",
      () => nativeFreeTextVisualState(view, savedAnnotation.id),
      (state) => state?.mode === 0 && state.pageLoaded && !state.pageLoading &&
        state.sectionVisible && state.visibleAppearance &&
        state.sectionRect?.width > 0 && state.sectionRect?.height > 0,
      30_000,
    );
    finalUndoVisual = await nativeFreeTextVisualState(view, savedAnnotation.id, {
      inspectPixels: true,
      roiRect: roi,
    });
    assert.equal(finalUndoVisual.mode, 0,
      `The final Command-Z must leave PDF.js in normal NONE mode: ${JSON.stringify(finalUndoVisual)}.`);
    assert.equal(finalUndoVisual.pageLoaded, true,
      `The page must remain loaded after the final Command-Z: ${JSON.stringify(finalUndoVisual)}.`);
    assert.equal(finalUndoVisual.pageLoading, false,
      `The page must finish rendering after the final Command-Z: ${JSON.stringify(finalUndoVisual)}.`);
    assert.equal(finalUndoVisual.sectionVisible, true,
      `The final Command-Z must restore the visible FreeText AP section: ${JSON.stringify(finalUndoVisual)}.`);
    assert.equal(finalUndoVisual.visibleAppearance, true,
      `The final Undo after Redo must leave the FreeText visible: ${JSON.stringify(finalUndoVisual)}.`);
    if (appearanceUsesPageCanvas) {
      assert.equal(finalUndoVisual.pageCanvas?.roiPixels?.fingerprint,
        baselineVisual.pageCanvas.roiPixels.fingerprint,
        "A final Undo must restore the same FreeText page-canvas pixels after Redo.");
    }
    evidence.finalUndo = { input: finalUndoInput, visible: finalUndoVisual };
    evidence.screenshots.afterRedoUndo = await saveNativeFreeTextRoiScreenshot(
      view,
      "freetext-undo-after-redo-undo",
      roi,
      finalUndoVisual,
    );
    await persistReport();

    const hashBeforeFinalSave = await fileHash(relativePath);
    await dispatchMacSave(view);
    const finalSaveState = await waitFor(
      "Cmd+S after restored FreeText to finish without a pending dirty revision",
      () => readerRuntimeState(view),
      (state) => state.ready && !state.saving && !state.dirty,
      30_000,
    );
    let finalHash = await fileHash(relativePath);
    if (finalHash !== hashBeforeFinalSave) {
      finalHash = (await waitForSaved(
        view,
        relativePath,
        hashBeforeFinalSave,
        "Cmd+S after undo/redo to finish writing the restored FreeText",
      )).hash;
    }
    evidence.finalSave = {
      readerState: finalSaveState,
      hashBefore: hashBeforeFinalSave,
      hashAfter: finalHash,
      bytesChanged: hashBeforeFinalSave !== finalHash,
    };
    const finalReopen = await reopenPdf(view);
    assert.ok(finalReopen.subtypes.includes("FreeText"),
      "The Cmd+S/reopened PDF must retain the FreeText restored by Undo.");
    const reopenedAnnotations = await nativeFreeTextAnnotationRecords(view);
    assert.equal(reopenedAnnotations.length, 1,
      `The final reopened PDF must contain exactly one restored FreeText: ${JSON.stringify(reopenedAnnotations)}.`);
    const reopenedAnnotation = reopenedAnnotations[0];
    const reopenedText = reopenedAnnotation.contentsObjText ?? reopenedAnnotation.textContent ?? "";
    assert.ok(reopenedText.includes(typedText),
      `The final reopened FreeText must preserve ${JSON.stringify(typedText)} in Contents/textContent: ${JSON.stringify(reopenedAnnotation)}.`);
    assert.equal(reopenedAnnotation.hasAppearance, true,
      `The final reopened FreeText must retain a real AP: ${JSON.stringify(reopenedAnnotation)}.`);
    let reopenedVisual = await waitFor(
      "final reopened PDF to visibly render the restored FreeText appearance",
      () => nativeFreeTextVisualState(view, reopenedAnnotation.id),
      (state) => state?.mode === 0 && state.pageLoaded && !state.pageLoading &&
        state.sectionPresent && state.visibleAppearance &&
        state.sectionRect?.width > 0 && state.sectionRect?.height > 0,
      30_000,
    );
    reopenedVisual = await nativeFreeTextVisualState(view, reopenedAnnotation.id, { inspectPixels: true });
    assert.equal(reopenedVisual.visibleAppearance, true,
      `The final reopened FreeText must have visible AP/canvas content: ${JSON.stringify(reopenedVisual)}.`);
    if (reopenedVisual.canvas?.visible) {
      assert.ok(reopenedVisual.canvas.pixels?.alphaPixels > 0 && reopenedVisual.canvas.pixels?.nonWhitePixels > 0,
        `The final reopened AP canvas must contain painted pixels: ${JSON.stringify(reopenedVisual.canvas)}.`);
    }
    evidence.finalReopen = {
      subtypes: finalReopen.subtypes,
      annotation: reopenedAnnotation,
      visible: reopenedVisual,
    };
    evidence.screenshots.afterFinalReopen = await saveNativeFreeTextRoiScreenshot(
      view,
      "freetext-undo-after-final-reopen",
      reopenedVisual.sectionRect,
      reopenedVisual,
    );
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
    if (view && !nativeCdpUnavailable) await detachOwnedView(view, { allowDirty: true }).catch(() => {});
    await setAutoSave(primaryPage, true).catch(() => {});
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
    const chrome = await inspectNativeReaderChrome(moved, `${label} popout owner`);
    return { view: moved, page: popoutPage, originalDocumentId: move.originalDocumentId,
      originalOpenRequest: move.originalOpenRequest,
      moveAttemptKey: move.moveAttemptKey, moveInvocation: move.moveInvocation,
      chrome };
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
  const anchor = popoutCleanupAnchors.get(page) || null;
  const outcome = await recordNativePopoutCloseWithoutReader(page, label);
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
  const { attempt } = await startNativePopoutCloseAttempt(view.page, {
    path: view.path,
    attemptKey,
    driver: "Obsidian PopoutSplit.close() through the installed PDF Reader close gate; the test separately observes the resulting native beforeunload and Electron target closure",
  });
  try {
  const outcome = await evaluateJsonBounded(view.page, `(() => {
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
    const state = { status: 'pending', driver: 'Obsidian PopoutSplit.close() through the installed PDF Reader close gate',
      gateBeforeClose: ${JSON.stringify(attempt.gateBefore)} };
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
  })()`, `invoke gated popout SDK close ${attemptKey}`);
  assert.equal(outcome.invoked, true);
  assert.equal(outcome.closeGateActive, true);
  assert.equal(outcome.closeWrapperInstalled, true);
  attempt.sdkInvocation = outcome;
  await persistReport();
  return { ...outcome, attempt };
  } catch (error) {
    attempt.status = "sdk-close-invocation-failed";
    attempt.error = error?.stack || String(error);
    await finishNativePopoutCloseAttempt(view.page, attempt).catch(() => {});
    throw error;
  }
}

async function popoutCloseAttemptState(view, attemptKey) {
  if (view.page.isClosed()) return null;
  return evaluateJsonBounded(
    view.page,
    `JSON.stringify(window[${JSON.stringify(attemptKey)}] || null)`,
    `read popup close request state ${attemptKey}`,
    5_000,
  );
}

async function waitForOwnedPopoutClosed(popoutPage, relativePath, description, view) {
  assert.ok(view?.leafId && (view.documentId || view.originalDocumentId),
    "Popout teardown checks require the exact moved Reader identity.");
  const attempt = nativePopoutCloseAttempts.get(popoutPage);
  try {
    const outcome = await waitForBounded(description, async () => {
      const pages = await appWindows();
      const pageStillRegistered = isLivePageTarget(popoutPage);
      const remainingViews = await viewsFor(relativePath);
      const cleanup = await evaluateJson(primaryPage, `JSON.stringify((() => {
        const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
        const path = ${JSON.stringify(relativePath)};
        const leafId = ${JSON.stringify(view.leafId)};
        const documentId = ${JSON.stringify(view.documentId || view.originalDocumentId)};
        const monitors = Object.values(window[${JSON.stringify(closeMonitorRegistryKey)}] || {});
        const monitor = monitors.find(candidate => candidate.trace?.leafId === leafId &&
          candidate.trace?.documentId === documentId && candidate.trace?.path === path) || null;
        const target = monitor?.target || null;
        const leaf = monitor?.leaf || target?.leaf || null;
        const ownerWindow = monitor?.ownerWindow || target?.ownerWindow || null;
        const pluginViews = [...(plugin?.views || [])].filter(candidate =>
          candidate === target || (candidate.leaf?.id === leafId && candidate.documentId === documentId &&
            (candidate.requestedPath || candidate.file?.path) === path));
        const readerLeaves = app.workspace.getLeavesOfType(${JSON.stringify(viewType)}).filter(candidate =>
          candidate === leaf || candidate.id === leafId || (candidate.view === target ||
            (candidate.view?.documentId === documentId &&
              (candidate.view?.requestedPath || candidate.view?.file?.path) === path)));
        const gates = [...(plugin?.popoutCloseGates?.entries?.() || [])]
          .filter(([owner, gate]) => owner === ownerWindow || gate.views?.has?.(target) ||
            [...(gate.views || [])].some(candidate => candidate === target ||
              (candidate.leaf?.id === leafId && candidate.documentId === documentId &&
                (candidate.requestedPath || candidate.file?.path) === path)))
          .map(([owner, gate]) => ({
            active: gate.active === true,
            ownerMatchesCapturedWindow: owner === ownerWindow,
            viewsSize: gate.views?.size ?? null,
          }));
        return {
          exactTargetFound: !!target,
          exactLeafFound: !!leaf,
          ownerWindowClosed: ownerWindow ? ownerWindow.closed === true : null,
          teardownStarted: target?.teardownStarted === true,
          iframeConnected: target?.iframe?.isConnected ?? null,
          pluginViewCount: pluginViews.length,
          readerLeafCount: readerLeaves.length,
          gateCount: gates.length,
          gates,
        };
      })())`);
      const remainingExactViews = remainingViews.filter(candidate =>
        candidate.leafId === view.leafId &&
        candidate.documentId === (view.documentId || view.originalDocumentId));
      return {
        pageClosed: !pageStillRegistered,
        pageStillRegistered: pages.includes(popoutPage),
        exactViewCleanup: cleanup,
        automaticCleanupPassed: cleanup.exactTargetFound && cleanup.pluginViewCount === 0 &&
          cleanup.readerLeafCount === 0 && cleanup.gateCount === 0 && remainingExactViews.length === 0,
        remainingViews: remainingViews.map(({ leafId, documentId, path }) => ({ leafId, documentId, path })),
        remainingExactViewCount: remainingExactViews.length,
      };
    }, (state) => state.pageClosed && state.automaticCleanupPassed, 45_000, 5_000);
    assert.equal(outcome.exactViewCleanup.pluginViewCount, 0,
      "The exact closed Reader must be automatically removed from plugin.views.");
    assert.equal(outcome.exactViewCleanup.readerLeafCount, 0,
      "The exact closed Reader leaf must be automatically removed from the workspace.");
    assert.equal(outcome.exactViewCleanup.gateCount, 0,
      "The exact closed popout's close gate must be automatically unregistered.");
    if (attempt) {
      await finishNativePopoutCloseAttempt(popoutPage, attempt, {
        status: "native-window-closed",
        exactViewCleanup: outcome.exactViewCleanup,
        remainingViews: outcome.remainingViews,
      });
    }
    report.checks.popoutAutomaticViewCleanup ??= [];
    report.checks.popoutAutomaticViewCleanup.push({
      path: relativePath,
      leafId: view.leafId,
      documentId: view.documentId || view.originalDocumentId,
      ...outcome.exactViewCleanup,
      remainingViews: outcome.remainingViews,
    });
    return outcome;
  } catch (error) {
    if (attempt) {
      attempt.status = "native-close-not-observed";
      attempt.error = error?.stack || String(error);
      await finishNativePopoutCloseAttempt(popoutPage, attempt).catch(() => {});
    }
    throw error;
  }
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
  const progress = report.checks.popoutWindowCloseLifecycle = {
    status: "running",
    steps: [],
  };
  await persistPopoutCheckpoint(progress, "started");

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
    ownerChrome: held.chrome,
  };
  await persistPopoutCheckpoint(progress, "held-save-popout-ready", {
    path: heldPath,
    documentId: held.originalDocumentId,
    windowUrl: held.page.url(),
    windowTitle: await held.page.title().catch(() => ""),
  });
  let heldPatchInstalled = false;
  try {
    heldCheck.toolbarPopups = await inspectNativeReaderChrome(
      held.view,
      'held-save popout owner toolbar popups',
      { openToolPopups: true },
    );
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
    await persistPopoutCheckpoint(progress, "held-source-write-blocked", {
      path: heldPath,
      write: blockedWrite,
    });
    heldCheck.readerScreenshot = await saveNativeScreenshot(held.view.page, 'popout-close-held-save');
    const heldCloseInvocation = await invokeOwnedPopoutRootClose(held.view, heldAttemptKey);
    await persistPopoutCheckpoint(progress, "held-close-requested-with-gate-snapshot", {
      path: heldPath,
      gateBefore: heldCloseInvocation.attempt.gateBefore,
    });
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
    await persistPopoutCheckpoint(progress, "held-close-remains-pending-while-source-write-is-held", {
      path: heldPath,
      closeStatus: duringClose.status,
      reader: duringReader,
    });

    await releaseWritePatch(held.view.page);
    heldCheck.patchReleased = true;
    await persistPopoutCheckpoint(progress, "held-source-write-released", { path: heldPath });
    await waitForOwnedPopoutClosed(held.page, heldPath,
      'popout window and dirty Reader to close after the held PDF write finishes', held.view);
    await persistPopoutCheckpoint(progress, "held-popout-native-close-observed", {
      path: heldPath,
      nativeClose: nativePopoutCloseAttempts.get(held.page) || null,
    });
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
  await persistPopoutCheckpoint(progress, "autosave-disabled-popout-ready", {
    path: recoveryPath,
    documentId: recovery.originalDocumentId,
  });
  try {
    await addAnnotation(recovery.view, 5);
    await wait(1_700);
    assert.equal(await fileHash(recoveryPath), recoveryBeforeHash,
      'Autosave-disabled popout close must not write the source PDF before recovery.');
    recoveryCheck.readerScreenshot = await saveNativeScreenshot(recovery.view.page, 'popout-close-recovery');
    const recoveryCloseInvocation = await invokeOwnedPopoutRootClose(recovery.view, recoveryAttemptKey);
    recoveryCheck.closeGateBefore = recoveryCloseInvocation.attempt.gateBefore;
    await persistPopoutCheckpoint(progress, "autosave-disabled-close-requested-with-gate-snapshot", {
      path: recoveryPath,
      gateBefore: recoveryCloseInvocation.attempt.gateBefore,
    });
    await waitForOwnedPopoutClosed(recovery.page, recoveryPath,
      'autosave-disabled popout to close after exact durable recovery acknowledgement', recovery.view);
    await persistPopoutCheckpoint(progress, "autosave-disabled-popout-native-close-observed", {
      path: recoveryPath,
      nativeClose: nativePopoutCloseAttempts.get(recovery.page) || null,
    });
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
  await persistPopoutCheckpoint(progress, "recovery-write-failure-popout-ready", {
    path: failurePath,
    documentId: failure.originalDocumentId,
  });
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
    const failedCloseInvocation = await invokeOwnedPopoutRootClose(failure.view, failureAttemptKey);
    failureCheck.closeGateBefore = failedCloseInvocation.attempt.gateBefore;
    await persistPopoutCheckpoint(progress, "recovery-write-failure-close-requested-with-gate-snapshot", {
      path: failurePath,
      gateBefore: failedCloseInvocation.attempt.gateBefore,
    });
    const refusedAttempt = await waitFor('popout close to refuse the injected recovery write failure',
      () => popoutCloseAttemptState(failure.view, failureAttemptKey),
      (state) => state && state.status !== 'pending', 30_000);
    assert.equal(refusedAttempt.status, 'resolved');
    assert.equal(refusedAttempt.result, false,
      'The popout owner close must be refused when its dirty PDF recovery write fails.');
    const refusedNativeCloseAttempt = nativePopoutCloseAttempts.get(failure.view.page);
    if (refusedNativeCloseAttempt) {
      await finishNativePopoutCloseAttempt(failure.view.page, refusedNativeCloseAttempt, {
        status: "refused-before-native-window-close",
        sdkCloseResult: false,
      });
      failureCheck.refusedNativeCloseAttempt = refusedNativeCloseAttempt;
    }
    await persistPopoutCheckpoint(progress, "recovery-write-failure-close-refused-before-native-close", {
      path: failurePath,
      sdkResult: refusedAttempt.result,
      nativeClose: refusedNativeCloseAttempt || null,
    });
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
    const retryCloseInvocation = await invokeOwnedPopoutRootClose(failure.view, retryAttemptKey);
    failureCheck.retryCloseGateBefore = retryCloseInvocation.attempt.gateBefore;
    await persistPopoutCheckpoint(progress, "recovery-write-retry-close-requested-with-gate-snapshot", {
      path: failurePath,
      gateBefore: retryCloseInvocation.attempt.gateBefore,
    });
    await waitForOwnedPopoutClosed(failure.page, failurePath,
      'popout to close after removing the scoped recovery-directory write fault', failure.view);
    await persistPopoutCheckpoint(progress, "recovery-write-retry-popout-native-close-observed", {
      path: failurePath,
      nativeClose: nativePopoutCloseAttempts.get(failure.page) || null,
    });
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
  progress.status = "passed";
  progress.finishedAt = new Date().toISOString();
  await persistReport();
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
    autosave.detachCloseAttempt = await detachPopoutReaderWithGateDiagnostics(
      autosaveMoved.view,
      "popout autosave dirty migration",
    );
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
    recovery.detachCloseAttempt = await detachPopoutReaderWithGateDiagnostics(
      recoveryMoved.view,
      "popout autosave-disabled migration",
    );
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
    failure.detachCloseAttempt = await detachPopoutReaderWithGateDiagnostics(
      failureMoved.view,
      "popout recovery-write retry migration",
    );
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
  const evidence = report.checks.popoutMigrationAndCleanup = {
    status: "running",
    path: relativePath,
    steps: [],
  };
  await persistPopoutCheckpoint(evidence, "started");
  await setAutoSave(primaryPage, true);
  const beforeHash = await fileHash(relativePath);
  const view = await openReader(primaryPage, relativePath);
  const originalDocumentId = view.documentId;
  await persistPopoutCheckpoint(evidence, "reader-opened", {
    documentId: originalDocumentId,
    leafId: view.leafId,
    beforeHash,
  });
  const oldWindowKey = "__nativeLifecycleOldOwnerMonitor";
  const newWindowKey = "__nativeLifecycleNewOwnerMonitor";
  const bridgeKey = "__nativeLifecycleBridgeDisposeMonitor";
  const originalWindows = await appWindows();
  await installOwnerWindowCleanupMonitor(view, oldWindowKey);
  await persistPopoutCheckpoint(evidence, "former-owner-listener-monitor-installed", {
    originalWindowCount: originalWindows.length,
  });

  await persistPopoutCheckpoint(evidence, "before-move-command");
  await evaluateBounded(view.page, `(async () => {
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
  })()`, "dispatch the Obsidian popout move command", 12_000);
  await persistPopoutCheckpoint(evidence, "move-command-dispatched");

  const windows = await waitForBounded(
    "Obsidian popout window target",
    appWindows,
    (pages) => pages.length >= 2,
    30_000,
    5_000,
  );
  createdPopoutPage = windows.find((page) => !originalWindows.includes(page));
  assert.ok(createdPopoutPage, "Obsidian must create a distinct test-owned popout renderer.");
  await persistPopoutCheckpoint(evidence, "popout-target-created", {
    targetCount: windows.length,
    targetUrl: createdPopoutPage.url(),
    targetTitle: await createdPopoutPage.title().catch(() => ""),
  });
  const moved = await waitForBounded(
    "owned Reader tab to migrate into an Obsidian popout window",
    async () => {
      const views = await viewsFor(relativePath);
      return views.find((candidate) => candidate.popout && candidate.ready &&
        candidate.frameLoaded && candidate.pages > 0) || null;
    },
    Boolean,
    45_000,
    5_000,
  );
  assert.equal(moved.documentId, originalDocumentId, "Moving the Reader tab should preserve its open PDF identity.");
  assert.equal(moved.ownerWindowIsOwner, true, "The Reader must bind to the window that now owns its content.");
  assert.ok(windows.some((page) => page === moved.page));
  await persistPopoutCheckpoint(evidence, "reader-migrated-and-ready", {
    documentId: moved.documentId,
    leafId: moved.leafId,
    ownerWindowIsOwner: moved.ownerWindowIsOwner,
    pageCount: moved.pages,
    rendererGeneration: moved.rendererGeneration || null,
  });
  const oldMonitor = await monitorState(view.page, oldWindowKey);
  assert.ok(oldMonitor.removes >= 1 && oldMonitor.listenerMatches >= 1,
    "Migration must remove the message listener from the former owner window.");

  const newOwnerMonitorSnapshot = await installNewOwnerCleanupMonitor(moved, newWindowKey);
  const bridgeMonitorSnapshot = await installBridgeDisposeMonitor(moved, bridgeKey);
  await persistPopoutCheckpoint(evidence, "owner-and-bridge-monitors-installed");
  const saved = await (async () => {
    await addAnnotation(moved, 5);
    return waitForSaved(moved, relativePath, beforeHash, "autosave after Reader popout migration");
  })();
  const reopened = await reopenPdf(moved);
  assert.ok(reopened.subtypes.includes("Square"));
  const popoutScreenshot = await saveNativeScreenshot(moved.page, "popout");
  const hostMonitorBeforeClose = await monitorState(moved.page, newWindowKey);
  await persistPopoutCheckpoint(evidence, "saved-and-reopened-in-popout", {
    savedHash: saved.hash,
    reopenedSubtypes: reopened.subtypes,
    readerScreenshot: popoutScreenshot,
  });
  await createPopoutCleanupAnchor(moved.page, moved, "popout listener cleanup");
  await persistPopoutCheckpoint(evidence, "cleanup-anchor-created");
  const detachCloseAttempt = await detachPopoutReaderWithGateDiagnostics(
    moved,
    "popout listener cleanup",
    async (attempt) => {
      evidence.readerDetachGateBefore = attempt.gateBefore;
      await persistPopoutCheckpoint(evidence, "before-reader-detach-and-possible-native-beforeunload", {
        gate: attempt.gateBefore,
      });
    },
  );
  evidence.readerDetachBeforeUnload = detachCloseAttempt.beforeUnload;
  await persistPopoutCheckpoint(evidence, "reader-detached-before-empty-window-close");
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
  Object.assign(evidence, {
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
  });
  await persistPopoutCheckpoint(evidence, "listener-removal-evidence-collected", {
    formerOwnerCleanup: oldMonitor,
    newOwnerAfterClose: hostMonitorAfterClose,
    bridgeRemovedListenerCount: removals.length,
  });
  if (createdPopoutPage && !createdPopoutPage.isClosed()) {
    evidence.popoutEmptyBeforeCleanup = true;
    const nativeClose = await closeEmptyTestPopout(createdPopoutPage, "popout listener cleanup");
    evidence.emptyPopoutNativeClose = nativeClose;
    evidence.emptyPopoutClosedAfterEvidence = nativeClose.closedAfterOwnedReadersDetached === true;
    await persistPopoutCheckpoint(evidence, "empty-popout-native-close-observed", {
      targetClosed: nativeClose.closedAfterOwnedReadersDetached,
      beforeUnload: nativeClose.beforeUnload,
      gateBefore: nativeClose.gateBefore,
    });
  }
  evidence.status = "passed";
  evidence.finishedAt = new Date().toISOString();
  await persistReport();
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
    "tool-wheel": testNativeToolWheel,
    "freetext-focus": testNativeFreeTextIdleAutosaveFocus,
    "freetext-undo": testNativeFreeTextUndoVisualRecovery,
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
          const priorCloseAttempt = nativePopoutCloseAttempts.get(createdPopoutPage);
          if (["native-close-not-observed", "close-not-observed"].includes(priorCloseAttempt?.status)) {
            report.createdPopoutCloseSkipped = {
              reason: "A prior bounded native beforeunload close attempt failed; preserve that evidence and do not retry during final cleanup.",
              priorCloseAttempt,
            };
            report.cleanupErrors ??= [];
            report.cleanupErrors.push({
              operation: "close test-created empty popout after a failed native close attempt",
              priorCloseAttempt,
            });
          } else {
            const closeOutcome = await closeEmptyTestPopout(
              createdPopoutPage,
              "lifecycle final cleanup",
            );
            report.createdPopoutClosed = closeOutcome.closedAfterOwnedReadersDetached === true;
            report.createdPopoutCloseOutcome = closeOutcome;
          }
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
