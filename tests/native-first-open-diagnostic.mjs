import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { assertNativeVaultIdentity, nativeConfig } from "./native-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifactRoot = path.join(root, "tests", "artifacts");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const testPath = `PDF迁移测试/native-first-open-${stamp}.pdf`;
const testFile = path.join(nativeConfig.vault, ...testPath.split("/"));
const reportPath = path.join(
  artifactRoot,
  `native-first-open-diagnostic-${stamp}.json`,
);
const screenshotPath = path.join(
  artifactRoot,
  `native-first-open-diagnostic-${stamp}.png`,
);
const viewType = "pdf-web-reader-view";
const pluginId = "pdf-web-reader";
const blockedPatterns = process.env.PDF_READER_DIAGNOSTIC_BLOCK_NETWORK === "1"
  ? ["http://*", "https://*", "ws://*", "wss://*"]
  : [];

const report = {
  startedAt: new Date().toISOString(),
  purpose: "e27 first-open diagnosis; test vault only",
  cachePrecondition: process.env.PDF_READER_DIAGNOSTIC_CACHE_MODE || "existing",
  cdpUrl: nativeConfig.cdpUrl,
  expectedVaultPath: nativeConfig.vault,
  configDir: nativeConfig.configDir,
  testPath,
  networkBlocking: { patterns: blockedPatterns },
  checks: {},
  events: [],
  network: [],
  runtimeErrors: [],
  console: [],
  frameLifecycle: [],
  snapshots: [],
};

let browser;
let page;
let cdp;
let focusEmulationEnabled = false;
let createdTestFile = false;
let testReaderLeafId = null;

function safeMessageData(data, view = null) {
  if (!data || typeof data !== "object") return { valueType: typeof data };
  return {
    channel: data.channel || null,
    type: data.type || null,
    tokenMatches: view ? data.token === view.token : null,
    tokenPresent: typeof data.token === "string",
    documentId: data.documentId || null,
    requestId: data.requestId || null,
    openRequest: Number.isInteger(data.openRequest) ? data.openRequest : null,
    rendererGeneration: data.rendererGeneration || null,
    revision: Number.isSafeInteger(data.revision) ? data.revision : null,
    confirmedRevision: Number.isSafeInteger(data.confirmedRevision)
      ? data.confirmedRevision
      : null,
    code: data.code || null,
    message: typeof data.message === "string" ? data.message.slice(0, 1200) : null,
    hasArrayBuffer: data.data instanceof ArrayBuffer,
    dataBytes: data.data instanceof ArrayBuffer ? data.data.byteLength : null,
  };
}

function logNodeEvent(kind, fields = {}) {
  report.events.push({ at: new Date().toISOString(), kind, ...fields });
}

async function evaluateProbe() {
  return page.evaluate(() => {
    const plugin = app.plugins.plugins["pdf-web-reader"];
    const leaves = [];
    app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view;
      if (view?.getViewType?.() !== "pdf-web-reader-view") return;
      const frame = view.iframe?.contentWindow;
      const pdfApp = frame?.PDFViewerApplication;
      const task = pdfApp?.pdfLoadingTask || null;
      const sender = view.ownerWindowMessageSender;
      const senderPrototype = sender ? Object.getPrototypeOf(sender) : null;
      const senderConstructor = senderPrototype?.constructor || null;
      const frameProbe = frame?.__pdfFirstOpenFrameProbe || null;
      let originRelation = null;
      try {
        originRelation = {
          frameParentIsOwner: frame?.parent === view.ownerWindow,
          ownerIsHostWindow: view.ownerWindow === window,
          frameParentIsHost: frame?.parent === window,
          frameDocumentOrigin: frame?.location?.origin || null,
          hostOrigin: location.origin,
        };
      } catch (error) {
        originRelation = { error: String(error) };
      }
      leaves.push({
        leafId: leaf.id,
        viewType: view.getViewType(),
        path: view.requestedPath || view.file?.path || null,
        ready: !!view.ready,
        pendingBytes: !!view.pendingBytes,
        pendingByteLength: view.pendingBytes?.byteLength ?? null,
        openRequest: view.openRequest,
        documentId: view.documentId,
        rendererGeneration: view.rendererGeneration,
        lastOpenSentRequest: view.lastOpenSentRequest,
        iframeLoadCount: view.iframeLoadCount,
        iframeReadyState: frame?.document?.readyState || null,
        iframeVisibility: frame?.document?.visibilityState || null,
        iframeUrl: frame?.location?.href || null,
        iframeBaseUri: frame?.document?.baseURI || null,
        iframeOriginRelation: originRelation,
        ownerWindowMessageListenerAttached: !!view.ownerWindow &&
          view.ownerWindow === window &&
          !!view.messageListener,
        ownerWindowMessageSender: {
          present: typeof sender === "function",
          ownerWindowFunctionConstructor: !!sender &&
            senderConstructor === view.ownerWindow?.Function,
          hostWindowFunctionConstructor: !!sender &&
            senderConstructor === window.Function,
        },
        cache: view.assetCache || null,
        bridgeScript: frame?.document?.querySelector("script[data-channel]")
          ? {
              src: frame.document.querySelector("script[data-channel]").src,
              channel: frame.document.querySelector("script[data-channel]").dataset.channel,
              tokenMatches: frame.document.querySelector("script[data-channel]").dataset.token === view.token,
              rendererGenerationMatches: frame.document.querySelector("script[data-channel]").dataset.rendererGeneration === view.rendererGeneration,
            }
          : null,
        pdfjsVersion: frame?.pdfjsLib?.version || null,
        pdfApp: pdfApp
          ? {
              present: true,
              initialized: pdfApp.initialized ?? null,
              initializedPromisePresent: !!pdfApp.initializedPromise,
              initializedPromiseState: frameProbe?.initializedPromiseState || null,
              documentPresent: !!pdfApp.pdfDocument,
              numPages: pdfApp.pdfDocument?.numPages ?? null,
              loadingTaskPresent: !!task,
              loadingTaskDestroyed: task?._worker?.destroyed ?? null,
              loadingTaskWorkerPort: task?._worker?.port?.constructor?.name || null,
              loadingTaskDocId: task?.docId || null,
              viewerPagesCount: pdfApp.pdfViewer?.pagesCount ?? null,
              pageElements: frame?.document?.querySelectorAll(".page").length ?? null,
              canvases: frame?.document?.querySelectorAll(".page canvas").length ?? null,
              textSpans: frame?.document?.querySelectorAll(".textLayer span").length ?? null,
              loadingIconVisible: !!frame?.document?.querySelector("#loadingIcon:not(.hidden), #loadingBar:not(.hidden)"),
            }
          : null,
        frameProbe: frameProbe
          ? {
              appObservedAt: frameProbe.appObservedAt || null,
              initializedPromiseState: frameProbe.initializedPromiseState || null,
              initializedPromiseError: frameProbe.initializedPromiseError || null,
              messages: frameProbe.messages.slice(-20),
              events: frameProbe.events.slice(-20),
              exceptions: frameProbe.exceptions.slice(-20),
              securityViolations: frameProbe.securityViolations.slice(-20),
            }
          : null,
        performanceResources: frame?.performance?.getEntriesByType("resource")
          .map((entry) => ({ name: entry.name, initiatorType: entry.initiatorType, duration: entry.duration })) || [],
        dirty: view.dirty ?? null,
        saving: !!view.saving,
        annotationStorageModified: !!pdfApp?._annotationStorageModified,
        pdfJsHasChanges: typeof pdfApp?._hasChanges === "function"
          ? !!pdfApp._hasChanges()
          : null,
      });
    });
    const rawHostEvents = window.__pdfFirstOpenProbe?.events || [];
    const hostEventRows = new Map();
    for (const event of rawHostEvents) {
      if (event.kind !== "host-window-message-capture") continue;
      const key = JSON.stringify([
        event.eventOrigin,
        event.data?.type,
        event.data?.documentId,
        event.data?.openRequest,
        event.data?.rendererGeneration,
        event.data?.channel,
      ]);
      const previous = hostEventRows.get(key);
      if (!previous || event.guardBefore) hostEventRows.set(key, event);
    }
    return {
      identity: {
        vault: app.vault.adapter.basePath,
        configDir: app.vault.configDir,
        vaultName: app.vault.getName?.() || null,
      },
      visibility: document.visibilityState,
      hidden: document.hidden,
      pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
      pluginVersion: plugin?.manifest?.version || null,
      readerCount: leaves.length,
      leaves,
      hostEvents: [...hostEventRows.values()].slice(-80),
    };
  });
}

try {
  await mkdir(artifactRoot, { recursive: true });
  browser = await puppeteer.connect({
    browserURL: nativeConfig.cdpUrl,
    defaultViewport: null,
  });
  const pages = await browser.pages();
  const candidates = pages.filter((candidate) => candidate.url() === "app://obsidian.md/index.html");
  assert.equal(candidates.length, 1, "Expected exactly one isolated Obsidian app page");
  page = candidates[0];
  const identity = await page.evaluate(() => ({
    vault: app.vault.adapter.basePath,
    configDir: app.vault.configDir,
    vaultName: app.vault.getName?.() || null,
  }));
  assertNativeVaultIdentity(identity, nativeConfig);
  report.checks.initialIdentity = identity;
  const initialState = await page.evaluate(() => {
    const plugin = app.plugins.plugins["pdf-web-reader"];
    const readers = [];
    app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType?.() === "pdf-web-reader-view") {
        readers.push({ id: leaf.id, path: leaf.view.requestedPath || leaf.view.file?.path || null });
      }
    });
    return {
      enabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
      version: plugin?.manifest?.version || null,
      readers,
      visibility: document.visibilityState,
    };
  });
  assert.equal(initialState.enabled, true, "The deployed test candidate must be enabled");
  assert.equal(initialState.version, "0.2.0");
  assert.deepEqual(initialState.readers, [], "Refusing to proceed with an unowned Reader");
  report.checks.initialState = initialState;

  page.on("console", (message) => {
    const row = {
      type: message.type(),
      text: message.text().slice(0, 2000),
      url: message.location()?.url || null,
      line: message.location()?.lineNumber ?? null,
    };
    report.console.push(row);
  });
  page.on("pageerror", (error) => {
    report.runtimeErrors.push({ source: "puppeteer-pageerror", message: error.stack || String(error) });
  });
  page.on("requestfailed", (request) => {
    report.network.push({
      kind: "requestfailed",
      url: request.url(),
      failure: request.failure()?.errorText || null,
      frameUrl: request.frame()?.url() || null,
    });
  });
  page.on("framenavigated", (frame) => {
    report.frameLifecycle.push({ kind: "framenavigated", url: frame.url(), parent: frame.parentFrame()?.url() || null });
  });
  page.on("frameattached", (frame) => {
    report.frameLifecycle.push({ kind: "frameattached", url: frame.url(), parent: frame.parentFrame()?.url() || null });
  });
  page.on("framedetached", (frame) => {
    report.frameLifecycle.push({ kind: "framedetached", url: frame.url(), parent: frame.parentFrame()?.url() || null });
  });

  cdp = await page.target().createCDPSession();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.setBlockedURLs", { urls: blockedPatterns });
  report.networkBlocking = { explicitlySet: true, patterns: blockedPatterns };
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  focusEmulationEnabled = true;

  cdp.on("Runtime.exceptionThrown", (event) => {
    report.runtimeErrors.push({
      source: "Runtime.exceptionThrown",
      text: event.exceptionDetails?.text || null,
      exception: event.exceptionDetails?.exception?.description || null,
      url: event.exceptionDetails?.url || null,
      line: event.exceptionDetails?.lineNumber ?? null,
      column: event.exceptionDetails?.columnNumber ?? null,
      executionContextId: event.exceptionDetails?.executionContextId ?? null,
    });
  });
  cdp.on("Runtime.consoleAPICalled", (event) => {
    const args = (event.args || []).map((arg) => arg.value ?? arg.description ?? arg.type);
    report.console.push({
      source: "Runtime.consoleAPICalled",
      type: event.type,
      args,
      executionContextId: event.executionContextId,
      timestamp: event.timestamp,
    });
  });
  cdp.on("Log.entryAdded", (event) => {
    report.console.push({
      source: "Log.entryAdded",
      level: event.entry?.level,
      text: event.entry?.text,
      url: event.entry?.url,
      line: event.entry?.lineNumber,
      timestamp: event.entry?.timestamp,
    });
  });
  cdp.on("Network.requestWillBeSent", (event) => {
    report.network.push({
      kind: "request",
      requestId: event.requestId,
      url: event.request.url,
      method: event.request.method,
      frameId: event.frameId,
      documentURL: event.documentURL,
      resourceType: event.type,
      initiator: event.initiator?.type || null,
    });
  });
  cdp.on("Network.responseReceived", (event) => {
    report.network.push({
      kind: "response",
      requestId: event.requestId,
      url: event.response.url,
      status: event.response.status,
      mimeType: event.response.mimeType,
      fromDiskCache: event.response.fromDiskCache,
      fromServiceWorker: event.response.fromServiceWorker,
      frameId: event.frameId,
      resourceType: event.type,
    });
  });
  cdp.on("Network.loadingFailed", (event) => {
    report.network.push({
      kind: "loadingFailed",
      requestId: event.requestId,
      errorText: event.errorText,
      blockedReason: event.blockedReason || null,
      canceled: event.canceled,
      resourceType: event.type,
    });
  });
  cdp.on("Page.frameNavigated", (event) => {
    report.frameLifecycle.push({
      kind: "cdp-frameNavigated",
      frameId: event.frame.id,
      parentId: event.frame.parentId || null,
      url: event.frame.url,
      securityOrigin: event.frame.securityOrigin,
      mimeType: event.frame.mimeType,
    });
  });
  cdp.on("Page.frameDetached", (event) => {
    report.frameLifecycle.push({ kind: "cdp-frameDetached", frameId: event.frameId, reason: event.reason });
  });

  await page.evaluateOnNewDocument(() => {
    if (window === window.top) return;
    const probe = window.__pdfFirstOpenFrameProbe = {
      startedAt: new Date().toISOString(),
      messages: [],
      events: [],
      exceptions: [],
      securityViolations: [],
      initializedPromiseState: "not-observed",
      initializedPromiseError: null,
      appObservedAt: null,
      attachedApp: null,
    };
    const summarize = (data) => {
      if (!data || typeof data !== "object") return { valueType: typeof data };
      const script = document.querySelector("script[data-channel]");
      return {
        channel: data.channel || null,
        channelMatches: data.channel === script?.dataset.channel,
        type: data.type || null,
        tokenPresent: typeof data.token === "string",
        tokenMatches: data.token === script?.dataset.token,
        documentId: data.documentId || null,
        openRequest: Number.isInteger(data.openRequest) ? data.openRequest : null,
        rendererGeneration: data.rendererGeneration || null,
        rendererGenerationMatches: data.type === "ready"
          ? data.rendererGeneration === script?.dataset.rendererGeneration
          : null,
        revision: Number.isSafeInteger(data.revision) ? data.revision : null,
        confirmedRevision: Number.isSafeInteger(data.confirmedRevision) ? data.confirmedRevision : null,
        hasArrayBuffer: data.data instanceof ArrayBuffer,
        dataBytes: data.data instanceof ArrayBuffer ? data.data.byteLength : null,
      };
    };
    window.addEventListener("message", (event) => {
      probe.messages.push({
        at: new Date().toISOString(),
        sourceIsParent: event.source === window.parent,
        eventOrigin: event.origin,
        data: summarize(event.data),
      });
    }, true);
    window.addEventListener("error", (event) => {
      probe.exceptions.push({
        kind: "error",
        message: event.message || null,
        filename: event.filename || null,
        line: event.lineno || null,
        column: event.colno || null,
        error: event.error?.stack || String(event.error || ""),
      });
    }, true);
    window.addEventListener("unhandledrejection", (event) => {
      probe.exceptions.push({ kind: "unhandledrejection", reason: String(event.reason?.stack || event.reason) });
    }, true);
    document.addEventListener("securitypolicyviolation", (event) => {
      probe.securityViolations.push({
        directive: event.violatedDirective,
        blockedURI: event.blockedURI,
        effectiveDirective: event.effectiveDirective,
        sourceFile: event.sourceFile,
        line: event.lineNumber,
        disposition: event.disposition,
      });
    }, true);
    const attachApp = () => {
      const app = window.PDFViewerApplication;
      if (!app || probe.attachedApp === app) return;
      probe.attachedApp = app;
      probe.appObservedAt = new Date().toISOString();
      if (app.initializedPromise?.then) {
        probe.initializedPromiseState = "pending";
        app.initializedPromise.then(() => {
          probe.initializedPromiseState = "resolved";
          probe.events.push({ at: new Date().toISOString(), kind: "initializedPromise-resolved" });
        }, (error) => {
          probe.initializedPromiseState = "rejected";
          probe.initializedPromiseError = String(error?.stack || error);
          probe.events.push({ at: new Date().toISOString(), kind: "initializedPromise-rejected", error: probe.initializedPromiseError });
        });
      }
      for (const type of ["documentloaded", "documenterror", "pagesinit", "pagesloaded"]) {
        try {
          app.eventBus?.on?.(type, (event) => probe.events.push({
            at: new Date().toISOString(),
            kind: `pdfjs-${type}`,
            pageNumber: event?.pageNumber ?? null,
            message: event?.message || event?.error?.message || null,
          }));
        } catch (error) {
          probe.events.push({ kind: "event-listener-failed", type, error: String(error) });
        }
      }
      probe.events.push({ at: new Date().toISOString(), kind: "PDFViewerApplication-observed" });
    };
    attachApp();
    const timer = setInterval(attachApp, 25);
    setTimeout(() => clearInterval(timer), 30_000);
  });

  await page.evaluate(() => {
    window.__pdfFirstOpenProbe = { events: [] };
    window.addEventListener("message", (event) => {
      const data = event.data;
      const plugin = app.plugins.plugins["pdf-web-reader"];
      const view = [...(plugin?.views || [])].find((candidate) => candidate.iframe?.contentWindow === event.source) || null;
      const guardBefore = {
        sourceIsIframe: !!view,
        messageObject: !!data && typeof data === "object",
        channelMatches: data?.channel === "pdf-web-reader",
        tokenMatches: view ? data?.token === view.token : null,
        typeIsString: typeof data?.type === "string",
        documentIdMatches: !data?.documentId || data.documentId === view?.documentId,
        requestMatches: !Number.isInteger(data?.openRequest) || data.openRequest === view?.openRequest,
        rendererGenerationMatches: data?.type !== "ready" || data.rendererGeneration === view?.rendererGeneration,
        readyWasFalse: data?.type !== "ready" || view?.ready === false,
      };
      const record = {
        at: new Date().toISOString(),
        kind: "host-window-message-capture",
        eventOrigin: event.origin,
        sourceIsIframe: !!view,
        sourceIsHost: event.source === window,
        guardBefore,
        hostStateBefore: view ? {
          ready: view.ready,
          openRequest: view.openRequest,
          documentId: view.documentId,
          rendererGeneration: view.rendererGeneration,
          pendingBytes: !!view.pendingBytes,
          lastOpenSentRequest: view.lastOpenSentRequest,
        } : null,
        data: data && typeof data === "object" ? {
          channel: data.channel || null,
          channelMatches: data.channel === "pdf-web-reader",
          type: data.type || null,
          tokenMatches: view ? data.token === view.token : null,
          documentId: data.documentId || null,
          openRequest: Number.isInteger(data.openRequest) ? data.openRequest : null,
          rendererGeneration: data.rendererGeneration || null,
          revision: Number.isSafeInteger(data.revision) ? data.revision : null,
          code: data.code || null,
          message: typeof data.message === "string" ? data.message.slice(0, 1200) : null,
        } : { valueType: typeof data },
      };
      window.__pdfFirstOpenProbe.events.push(record);
      setTimeout(() => {
        if (!view) return;
        record.hostStateAfter = {
          ready: view.ready,
          openRequest: view.openRequest,
          documentId: view.documentId,
          rendererGeneration: view.rendererGeneration,
          pendingBytes: !!view.pendingBytes,
          lastOpenSentRequest: view.lastOpenSentRequest,
          currentRevision: view.currentRevision,
          confirmedRevision: view.confirmedRevision,
        };
      }, 0);
    }, true);
  });

  await mkdir(path.dirname(testFile), { recursive: true });
  await copyFile(fixture, testFile, constants.COPYFILE_EXCL);
  createdTestFile = true;
  report.checks.fixture = {
    source: path.relative(root, fixture),
    bytes: (await readFile(testFile)).byteLength,
    testPath,
  };

  const indexDeadline = Date.now() + 15_000;
  let indexedFile = false;
  while (Date.now() < indexDeadline) {
    indexedFile = await page.evaluate((relativePath) =>
      !!app.vault.getAbstractFileByPath(relativePath), testPath);
    if (indexedFile) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(indexedFile, true, "The test vault did not index the scratch PDF");

  const firstOpen = await page.evaluate(async ({ viewType, relativePath }) => {
    const leaf = app.workspace.activeLeaf || app.workspace.getLeaf(true);
    await leaf.setViewState({ type: viewType, active: true, state: { file: relativePath, path: relativePath } });
    return {
      id: leaf.id,
      type: leaf.view?.getViewType?.() || null,
      path: leaf.view?.requestedPath || leaf.view?.file?.path || null,
      visibility: document.visibilityState,
    };
  }, { viewType, relativePath: testPath });
  testReaderLeafId = firstOpen.id;
  report.checks.firstOpenRequest = firstOpen;
  assert.equal(firstOpen.type, viewType, "Could not create the diagnostic Reader");
  assert.equal(firstOpen.path, testPath, "The diagnostic Reader did not load the scratch PDF path");

  const deadline = Date.now() + 30_000;
  let readySnapshot = null;
  while (Date.now() < deadline) {
    readySnapshot = await evaluateProbe().catch((error) => ({ error: String(error), leaves: [] }));
    report.snapshots.push({ at: new Date().toISOString(), phase: "first-open-init", state: readySnapshot });
    if (readySnapshot.leaves?.some((entry) => entry.leafId === testReaderLeafId && entry.ready)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    readySnapshot?.leaves?.some((entry) => entry.leafId === testReaderLeafId),
    "The diagnostic Reader disappeared during its first PDF open",
  );
  const initialLeafState = await page.evaluate((leafId) => {
    const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === leafId);
    if (!leaf) return null;
    return {
      leafId: leaf.id,
      path: leaf.view.requestedPath || leaf.view.file?.path || null,
      ready: !!leaf.view.ready,
      openRequest: leaf.view.openRequest,
      documentId: leaf.view.documentId,
      rendererGeneration: leaf.view.rendererGeneration,
      lastOpenSentRequest: leaf.view.lastOpenSentRequest,
      pendingBytes: !!leaf.view.pendingBytes,
    };
  }, testReaderLeafId);
  assert.equal(initialLeafState?.path, testPath);
  report.checks.firstOpenStateAfterReady = initialLeafState;

  const openedDeadline = Date.now() + 60_000;
  let lastSnapshot = null;
  let outcome = "timed-out";
  while (Date.now() < openedDeadline) {
    lastSnapshot = await evaluateProbe();
    report.snapshots.push({ at: new Date().toISOString(), phase: "first-open", state: lastSnapshot });
    const events = lastSnapshot.hostEvents;
    const gotOpened = events.some((event) => event.kind === "host-window-message-capture" && event.data?.type === "opened");
    const gotError = events.some((event) => event.kind === "host-window-message-capture" && event.data?.type === "error");
    const leaf = lastSnapshot.leaves.find((entry) => entry.leafId === testReaderLeafId);
    if (gotOpened && leaf?.pdfApp?.documentPresent && leaf.pdfApp.numPages > 0) {
      outcome = "opened";
      break;
    }
    if (gotError) {
      outcome = "host-error";
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  report.checks.outcome = outcome;
  report.checks.finalSnapshotBeforeCleanup = lastSnapshot;
  report.checks.blockedUrlEvidence = report.network.filter((entry) => entry.kind === "loadingFailed" && entry.blockedReason);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    report.screenshot = path.relative(root, screenshotPath);
    report.screenshotPhase = "before-reader-cleanup";
  } catch (error) {
    report.screenshotError = String(error);
  }
  report.finishedAt = new Date().toISOString();
  report.status = outcome === "opened" ? "opened" : "diagnostic-timeout";
} catch (error) {
  report.status = "script-error";
  report.error = error?.stack || String(error);
} finally {
  try {
  if (page && !testReaderLeafId) {
    try {
      testReaderLeafId = await page.evaluate((relativePath) =>
        app.workspace.getLeavesOfType("pdf-web-reader-view")
          .find((leaf) => (leaf.view.requestedPath || leaf.view.file?.path || null) === relativePath)?.id || null,
      testPath);
    } catch {}
  }
  if (page && testReaderLeafId) {
      const beforeCleanup = await evaluateProbe().catch((error) => ({ error: String(error) }));
      report.checks.finalPreCleanupState = beforeCleanup;
      const exactLeaf = await page.evaluate((leafId) => {
        const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === leafId);
        if (!leaf) return { found: false };
        const view = leaf.view;
        const pdfApp = view.iframe?.contentWindow?.PDFViewerApplication;
        return {
          found: true,
          id: leaf.id,
          path: view.requestedPath || view.file?.path || null,
          ready: !!view.ready,
          saving: !!view.saving,
          pendingBytes: !!view.pendingBytes,
          pendingSaves: view.pendingSaves,
          dirty: view.dirty ?? null,
          annotationStorageModified: !!pdfApp?._annotationStorageModified,
          hasChanges: typeof pdfApp?._hasChanges === "function" ? !!pdfApp._hasChanges() : null,
          revision: view.currentRevision,
          confirmedRevision: view.confirmedRevision,
          hostBytesMatch: null,
          pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
          vault: app.vault.adapter.basePath,
          configDir: app.vault.configDir,
        };
      }, testReaderLeafId).catch((error) => ({ error: String(error) }));
      report.checks.ownedReaderBeforeCleanup = exactLeaf;
      if (exactLeaf.found && (exactLeaf.path === testPath || exactLeaf.path === null) && exactLeaf.saving === false && exactLeaf.pendingSaves === 0 && exactLeaf.dirty !== true && exactLeaf.annotationStorageModified === false && exactLeaf.hasChanges !== true) {
        const identity = await page.evaluate(() => ({ vault: app.vault.adapter.basePath, configDir: app.vault.configDir }));
        assertNativeVaultIdentity(identity, nativeConfig);
        const detached = await page.evaluate((leafId) => {
          const leaf = app.workspace.getLeavesOfType("pdf-web-reader-view").find((candidate) => candidate.id === leafId);
          if (!leaf) return "already-closed";
          if (typeof leaf.detach !== "function") throw new Error("Owned Reader leaf cannot be detached");
          leaf.detach();
          return "detached-owned-reader";
        }, testReaderLeafId);
        report.checks.readerCleanup = detached;
      } else if (exactLeaf.found) {
        report.checks.readerCleanup = "retained-because-not-proven-clean";
      }
      if (createdTestFile && report.checks.readerCleanup === "detached-owned-reader") {
        await unlink(testFile);
        createdTestFile = false;
        report.checks.scratchPdfRemoved = true;
      } else if (createdTestFile) {
        report.checks.scratchPdfRemoved = false;
      }
      const afterCleanup = await page.evaluate(() => {
        const rows = [];
        app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view?.getViewType?.() === "pdf-web-reader-view") {
            rows.push({ id: leaf.id, path: leaf.view.requestedPath || leaf.view.file?.path || null, ready: !!leaf.view.ready, saving: !!leaf.view.saving, pending: !!leaf.view.pendingBytes, dirty: leaf.view.dirty ?? null });
          }
        });
        return {
          vault: app.vault.adapter.basePath,
          configDir: app.vault.configDir,
          visibility: document.visibilityState,
          pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
          pluginVersion: app.plugins.plugins["pdf-web-reader"]?.manifest?.version || null,
          readers: rows,
        };
      }).catch((error) => ({ error: String(error) }));
      report.checks.finalAppState = afterCleanup;
    }
    if (createdTestFile && page && report.checks.readerCleanup !== "detached-owned-reader") {
      const ownershipState = await page.evaluate((relativePath) => ({
        vault: app.vault.adapter.basePath,
        configDir: app.vault.configDir,
        readersForScratch: app.workspace.getLeavesOfType("pdf-web-reader-view")
          .filter((leaf) => (leaf.view.requestedPath || leaf.view.file?.path || null) === relativePath)
          .map((leaf) => ({ id: leaf.id, saving: !!leaf.view.saving, pending: !!leaf.view.pendingBytes, dirty: leaf.view.dirty ?? null })),
      }), testPath).catch((error) => ({ error: String(error) }));
      report.checks.scratchOwnershipAtCleanup = ownershipState;
      if (ownershipState.vault === nativeConfig.vault && ownershipState.configDir === nativeConfig.configDir && ownershipState.readersForScratch?.length === 0) {
        await unlink(testFile);
        createdTestFile = false;
        report.checks.scratchPdfRemoved = true;
      }
    }
  } catch (cleanupError) {
    report.cleanupError = cleanupError?.stack || String(cleanupError);
    if (report.status === "opened") report.status = "opened-cleanup-error";
  }
  if (cdp && focusEmulationEnabled) {
    try {
      await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      report.checks.focusEmulationRestored = true;
    } catch (error) {
      report.checks.focusEmulationRestored = false;
      report.checks.focusEmulationRestoreError = String(error);
    }
  }
  if (cdp) {
    try {
      await cdp.send("Network.setBlockedURLs", { urls: [] });
      report.checks.networkBlockingRestored = true;
    } catch (error) {
      report.checks.networkBlockingRestored = false;
      report.checks.networkBlockingRestoreError = String(error);
    }
  }
  report.finishedAt ||= new Date().toISOString();
  try {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    report.reportPath = path.relative(root, reportPath);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } catch (writeError) {
    process.stderr.write(`Could not write first-open report: ${writeError?.stack || writeError}\n`);
  }
  if (cdp) await cdp.detach().catch(() => {});
  if (browser) await browser.disconnect();
}

process.stdout.write(`${JSON.stringify({ status: report.status, report: reportPath, screenshot: report.screenshot || null, outcome: report.checks?.outcome || null, cleanup: report.checks?.readerCleanup || null, finalAppState: report.checks?.finalAppState || null }, null, 2)}\n`);
if (!["opened", "diagnostic-timeout", "opened-cleanup-error"].includes(report.status)) {
  process.exitCode = 1;
}
