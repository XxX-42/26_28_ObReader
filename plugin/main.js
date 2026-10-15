/*
 * Copyright 2026 XxX-42 and contributors
 * SPDX-License-Identifier: Apache-2.0
 * Bundled third-party notices are preserved in the embedded viewer resources.
 */
const {
  EditableFileView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Platform,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
} = require("obsidian");
/* BUILD:SESSION_LOG_REQUIRE */ const { createSessionLog, traceFunction, traceMethods } = require("./session-log.cjs");
let activeSessionLog = null;
function drainViewerRuntimeLog(view) {
  try {
    for (const row of view.iframe?.contentWindow?.__PDF_READER_DRAIN_LOG__?.() || []) {
      view.plugin.sessionLog?.record("viewer", { documentId: view.documentId, rendererGeneration: view.rendererGeneration, row });
    }
  } catch { /* A log flush must never block Reader teardown. */ }
}

/* BUILD:ASSET_RUNTIME_REQUIRE */ const { ensureViewerAssets, sha256Bytes } = require("./asset-runtime.cjs");
/* BUILD:PDF_HASH_RUNTIME_REQUIRE */ const { createPdfHashRuntime } = require("./pdf-hash-runtime.cjs");
/* BUILD:PDF_MERGE_CLIENT_REQUIRE */ const { createPdfMergeClient } = require("./pdf-merge-client.cjs");
/* BUILD:PDF_ANNOTATION_HOST_REQUIRE */ const { createPdfAnnotationHost } = require('./pdf-annotation-host.cjs');
/* BUILD:HEAVY_WORK_REQUIRE */ const { createHeavyWorkCoordinator } = require('./heavy-work.cjs');
/* BUILD:PDF_RECOVERY_REQUIRE */ const { readDeltaRecovery } = require('./pdf-recovery-read.cjs');
/* BUILD:VIEWER_ASSET_PAYLOAD */ const VIEWER_ASSET_PAYLOAD = null;

const VIEW_TYPE = "pdf-web-reader-view";
const CHANNEL = "pdf-web-reader";
const MOBILE_DIAGNOSTICS_DIRECTORY = "PDF Reader Diagnostics";
const MOBILE_RESOURCE_SCRIPT_PATHS = Object.freeze({
  bridge: "web/obsidian-bridge.js",
  pdf: "build/pdf.mjs",
  viewer: "web/viewer.mjs",
  worker: "build/pdf.worker.mjs",
});
const MOBILE_STAGE_VALUES = new Set([
  "idle",
  "assets-loading",
  "assets-ready",
  "resources-read",
  "bridge-loading",
  "pdf-module-loading",
  "pdf-module-loaded",
  "viewer-module-loading",
  "viewer-module-loaded",
  "ready",
  "resource-failed",
  "disposed",
]);
const MOBILE_STAGE_LABELS = Object.freeze({
  idle: "初始化",
  "assets-loading": "检查资源缓存，核验变化项",
  "assets-ready": "读取已校验资源",
  "resources-read": "准备模块与 Worker",
  "bridge-loading": "加载宿主桥接",
  "pdf-module-loading": "加载 PDF 模块",
  "pdf-module-loaded": "PDF 模块已加载",
  "viewer-module-loading": "加载阅读器模块",
  "viewer-module-loaded": "阅读器模块已加载",
  ready: "阅读器就绪",
  "resource-failed": "资源加载失败",
  disposed: "阅读器已关闭",
});

let activePdfHashRuntime = null;

function isMobilePlatform(app) {
  return app?.isMobile === true || Platform?.isMobile === true;
}

// Select the host entry once per plugin load. PDF editing, resource validation,
// save/recovery and pointer behavior are shared by both entries.
const DESKTOP_RUNTIME_ADAPTER = Object.freeze({
  mobile: false,
  loaderMode: "desktop-resource",
  workerSource: "resource",
  supportsPopout: true,
  createViewerDocument: (view, resources) => view.createDesktopViewerDocument(resources),
});
const MOBILE_RUNTIME_ADAPTER = Object.freeze({
  mobile: true,
  loaderMode: "mobile-blob",
  workerSource: "blob",
  supportsPopout: false,
  createViewerDocument: (view, resources) => view.createMobileViewerDocument(resources),
});

function isPdfFile(file) {
  return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

function resolvePdfFile(plugin, fileOrPath) {
  if (isPdfFile(fileOrPath)) {
    return fileOrPath;
  }
  if (typeof fileOrPath !== "string" || !fileOrPath) {
    return null;
  }
  const file = plugin.app.vault.getAbstractFileByPath(
    normalizePath(fileOrPath),
  );
  return isPdfFile(file) ? file : null;
}

function isPopoutWindow(ownerWindow) {
  try {
    return ownerWindow?.document?.body?.classList?.contains("is-popout-window") === true;
  } catch {
    return false;
  }
}

function findPopoutSplit(leaf, ownerWindow, workspace) {
  if (!leaf || !ownerWindow || !isPopoutWindow(ownerWindow)) return null;
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };
  try {
    add(leaf.getContainer?.());
  } catch {
    // Fall through to the public leaf parent/root relationships.
  }
  try {
    add(leaf.getRoot?.());
  } catch {
    // Fall through to the parent chain.
  }
  const ancestors = new Set();
  for (
    let current = leaf;
    current && !ancestors.has(current);
    current = current.parent
  ) {
    ancestors.add(current);
    add(current);
  }

  return (
    candidates.find(
      (candidate) =>
        candidate.win === ownerWindow &&
        candidate.workspace === workspace &&
        typeof candidate.close === "function",
    ) || null
  );
}

function createOwnerWindowMessageSender(ownerWindow) {
  const FunctionConstructor = ownerWindow?.Function;
  if (typeof FunctionConstructor !== "function") return null;
  try {
    // The bridge accepts messages only from its actual parent window. A
    // function compiled in Obsidian's main window keeps that window as
    // event.source after the iframe is adopted by a popout, so compile this
    // tiny static trampoline in the current owner window's realm instead.
    return FunctionConstructor(
      "target",
      "message",
      "transfer",
      `try {
        if (transfer && transfer.length) {
          target.postMessage(message, "*", transfer);
        } else {
          target.postMessage(message, "*");
        }
        return true;
      } catch (error) {
        if (!transfer || transfer.length === 0) return false;
        try {
          target.postMessage(message, "*");
          return true;
        } catch {
          return false;
        }
      }`,
    );
  } catch {
    return null;
  }
}

function installPdfOpenRouting(plugin) {
  const prototype = WorkspaceLeaf?.prototype;
  if (!prototype || typeof prototype.setViewState !== "function") {
    return null;
  }

  const routing = {
    active: true,
    plugin,
    prototype,
    originalSetViewState: prototype.setViewState,
    setViewStateWrapper: null,
    originalDetach: prototype.detach,
    detachWrapper: null,
    detachOperations: new WeakMap(),
    workspace: plugin.app?.workspace || null,
    originalMoveLeafToPopout: plugin.app?.workspace?.moveLeafToPopout,
    originalMoveLeafToPopoutDescriptor: plugin.app?.workspace
      ? Object.getOwnPropertyDescriptor(
          plugin.app.workspace,
          "moveLeafToPopout",
        )
      : null,
    moveLeafToPopoutWrapper: null,
    mobile: plugin.isMobileRuntime === true,
  };

  routing.setViewStateWrapper = function (viewState, eState) {
    const activePlugin = routing.plugin;
    if (!routing.active || !activePlugin || this.app !== activePlugin.app) {
      return routing.originalSetViewState.call(this, viewState, eState);
    }

    let routedViewState = viewState;
    if (viewState?.type === "pdf") {
      const file = resolvePdfFile(
        activePlugin,
        viewState.state?.file ?? viewState.state?.path,
      );
      if (file) {
        routedViewState = {
          ...viewState,
          type: VIEW_TYPE,
          state: { ...viewState.state, file: file.path, path: file.path },
        };
      }
    }

    const currentView = this.view;
    if (!(currentView instanceof PdfReaderView)) {
      return routing.originalSetViewState.call(this, routedViewState, eState);
    }
    const targetFile =
      routedViewState?.type === VIEW_TYPE
        ? resolvePdfFile(
            activePlugin,
            routedViewState.state?.file ?? routedViewState.state?.path,
          )
        : null;
    const changesDocument = Boolean(
      targetFile &&
        (currentView.documentFile !== targetFile ||
          currentView.requestedPath !== targetFile.path),
    );
    const leavesReader = routedViewState?.type !== VIEW_TYPE;
    if (!leavesReader && !changesDocument) {
      return routing.originalSetViewState.call(this, routedViewState, eState);
    }

    const capturedDocumentId = currentView.documentId;
    const capturedOpenRequest = currentView.openRequest;
    return currentView
      .prepareControlledClose("view-transition")
      .then((prepared) => {
        if (!prepared) return undefined;
        if (
          this.view !== currentView ||
          currentView.documentId !== capturedDocumentId ||
          currentView.openRequest !== capturedOpenRequest
        ) {
          currentView.cancelPreparedClose(
            capturedDocumentId,
            capturedOpenRequest,
          );
          return undefined;
        }
        let result;
        try {
          result = routing.originalSetViewState.call(
            this,
            routedViewState,
            eState,
          );
        } catch (error) {
          currentView.cancelPreparedClose(
            capturedDocumentId,
            capturedOpenRequest,
          );
          throw error;
        }
        return Promise.resolve(result).catch((error) => {
          currentView.cancelPreparedClose(
            capturedDocumentId,
            capturedOpenRequest,
          );
          throw error;
        });
      });
  };

  prototype.setViewState = routing.setViewStateWrapper;

  if (typeof routing.originalDetach === "function") {
    routing.detachWrapper = function (...args) {
      const activePlugin = routing.plugin;
      const view = this.view;
      if (
        !routing.active ||
        !activePlugin ||
        this.app !== activePlugin.app ||
        !(view instanceof PdfReaderView)
      ) {
        return routing.originalDetach.apply(this, args);
      }

      const existing = routing.detachOperations.get(this);
      if (existing) return existing;

      const documentId = view.documentId;
      const openRequest = view.openRequest;
      if (
        this.view === view &&
        view.documentId === documentId &&
        view.openRequest === openRequest &&
        view.hasPreparedClose(documentId, openRequest)
      ) {
        // Obsidian's popout close iterates leaves without awaiting detach().
        // Once this exact document session is durably prepared, preserve the
        // SDK's synchronous detach behavior so its parent can close safely.
        return routing.originalDetach.apply(this, args);
      }
      const operation = (async () => {
        const prepared = await view.prepareControlledClose("detach");
        if (!prepared) return false;
        if (
          !routing.active ||
          routing.plugin !== activePlugin ||
          this.app !== activePlugin.app
        ) {
          view.cancelPreparedClose(documentId, openRequest);
          return routing.originalDetach.apply(this, args);
        }
        if (
          this.view !== view ||
          view.documentId !== documentId ||
          view.openRequest !== openRequest
        ) {
          view.cancelPreparedClose(documentId, openRequest);
          return false;
        }
        try {
          return await routing.originalDetach.apply(this, args);
        } catch (error) {
          view.cancelPreparedClose(documentId, openRequest);
          throw error;
        }
      })();
      routing.detachOperations.set(this, operation);
      return operation.finally(() => {
        if (routing.detachOperations.get(this) === operation) {
          routing.detachOperations.delete(this);
        }
      });
    };
    prototype.detach = routing.detachWrapper;
  }

  if (!routing.mobile && typeof routing.originalMoveLeafToPopout === "function") {
    routing.moveLeafToPopoutWrapper = function (leaf, ...args) {
      const activePlugin = routing.plugin;
      const originalMove = routing.originalMoveLeafToPopout;
      if (
        !routing.active ||
        !activePlugin ||
        this !== routing.workspace ||
        leaf?.app !== activePlugin.app ||
        !(leaf.view instanceof PdfReaderView)
      ) {
        return originalMove.apply(this, [leaf, ...args]);
      }
      return activePlugin.moveReaderToPopout(
        this,
        leaf,
        originalMove,
        args,
      );
    };
    try {
      Object.defineProperty(routing.workspace, "moveLeafToPopout", {
        configurable: true,
        enumerable:
          routing.originalMoveLeafToPopoutDescriptor?.enumerable ?? false,
        writable: true,
        value: routing.moveLeafToPopoutWrapper,
      });
    } catch {
      routing.moveLeafToPopoutWrapper = null;
    }
  }
  return routing;
}

function restorePdfOpenRouting(routing) {
  if (!routing) {
    return;
  }
  routing.active = false;
  routing.plugin = null;
  if (routing.prototype.setViewState === routing.setViewStateWrapper) {
    routing.prototype.setViewState = routing.originalSetViewState;
  }
  if (
    routing.detachWrapper &&
    routing.prototype.detach === routing.detachWrapper
  ) {
    routing.prototype.detach = routing.originalDetach;
  }
  if (
    routing.moveLeafToPopoutWrapper &&
    routing.workspace?.moveLeafToPopout ===
      routing.moveLeafToPopoutWrapper
  ) {
    try {
      if (routing.originalMoveLeafToPopoutDescriptor) {
        Object.defineProperty(
          routing.workspace,
          "moveLeafToPopout",
          routing.originalMoveLeafToPopoutDescriptor,
        );
      } else {
        delete routing.workspace.moveLeafToPopout;
      }
    } catch {
      // Preserve an outer SDK/plugin wrapper; the inactive shim delegates.
    }
  }
}

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeStyleText(value) {
  return String(value).replace(/<\/style/gi, "<\\/style");
}

function makeToken() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function localAnnotationDeviceId() {
  const key = "pdf-web-reader.annotation-device-id.v1";
  try {
    const saved = globalThis.localStorage?.getItem(key);
    if (typeof saved === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(saved)) return saved;
    const created = makeToken().replace(/[^a-zA-Z0-9_-]/g, "");
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    return makeToken().replace(/[^a-zA-Z0-9_-]/g, "");
  }
}

class AnnotationDeviceReviewModal extends Modal {
  constructor(app, plugin, document, checkpointHash, devices) {
    super(app);
    this.plugin = plugin;
    this.document = document;
    this.checkpointHash = checkpointHash;
    this.devices = devices;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "审查此 PDF 的批注同步设备" });
    contentEl.createEl("p", {
      text: "设备必须升级到当前版本并确认同一检查点后，旧操作批次才会压实。长期离线设备可在确认没有未同步批注后退役。",
    });
    const select = contentEl.createEl("select");
    select.add(new Option("选择要退役的设备…", ""));
    for (const device of this.devices.filter((entry) => !entry.isCurrent && !entry.retired)) {
      const status = device.acknowledged
        ? "已确认当前检查点"
        : `未确认（版本 ${device.pluginVersion || "未知/旧版"}）`;
      select.add(new Option(`${device.deviceId} — ${status}`, device.deviceId));
    }
    contentEl.createEl("p", {
      text: "退役是按此 PDF 生效的不可逆同步决定；该设备之后重新出现的旧格式操作会被忽略。",
      cls: "mod-warning",
    });
    const button = contentEl.createEl("button", { text: "确认退役所选设备" });
    button.addEventListener("click", () => {
      const targetDeviceId = select.value;
      if (!targetDeviceId) return;
      button.disabled = true;
      void (async () => {
        try {
          await this.plugin.annotationHost.store.retireDevice({
            document: this.document,
            targetDeviceId,
            confirmedCheckpointHash: this.checkpointHash,
          });
          await this.plugin.annotationHost.store.materializeSnapshot(this.document);
          new Notice(`已将设备 ${targetDeviceId} 从此 PDF 的批注同步中退役。`);
          this.close();
        } catch (error) {
          new Notice(`设备退役失败：${error.message || error}`, 8000);
          button.disabled = false;
        }
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

function toArrayBuffer(value) {
  // The viewer may be hosted in another Electron window/realm, where
  // instanceof ArrayBuffer is false even though the value is an ArrayBuffer.
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return bytes.slice().buffer;
  }
  throw new Error("The PDF viewer returned invalid document data.");
}

function receivedArrayBuffer(value) {
  // The bridge transfers an owned buffer to the host. Adopt that received
  // buffer; do not copy an entire PDF again just to change its byte view.
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return value;
  return toArrayBuffer(value);
}

function bytesEqual(left, right) {
  if (!left || !right || left.byteLength !== right.byteLength) {
    return false;
  }
  if (activePdfHashRuntime) return activePdfHashRuntime.compare(left, right);
  const sampleLength = Math.min(64 * 1024, left.byteLength);
  const sampleStart = left.byteLength - sampleLength;
  for (let index = sampleStart; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function fingerprint(bytes) {
  return activePdfHashRuntime?.fingerprint(bytes) || `sha256-v1:${sha256Bytes(bytes)}`;
}

function fingerprintMatches(bytes, expected) {
  if (activePdfHashRuntime) return activePdfHashRuntime.matches(bytes, expected);
  const value = String(expected || "");
  const digest = sha256Bytes(bytes);
  return value === digest || value.toLowerCase() === `sha256-v1:${digest}`.toLowerCase();
}

function hashFileKey(value) {
  if (activePdfHashRuntime) return activePdfHashRuntime.hashFileKey(value);
  return String(value).replace(/^xxh64-v1:/i, "xxh64-v1-").replace(/^sha256-v1:/i, "sha256-v1-");
}

function isSupportedFingerprint(value) {
  if (activePdfHashRuntime) return activePdfHashRuntime.isSupportedHash(value);
  return typeof value === "string" && (/^[a-f0-9]{64}$/i.test(value) ||
    /^sha256-v1:[a-f0-9]{64}$/i.test(value) || /^xxh64-v1:[a-f0-9]{16}$/i.test(value));
}

function clampDiagnosticInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function sanitizeInputDiagnostics(value) {
  if (!value || value.schema !== 1) return null;
  const sampleTypes = new Set(["pointerdown", "pointermove", "pointerup", "pointercancel"]);
  const pointerTypes = new Set(["mouse", "touch", "pen", "unknown"]);
  const pointers = Array.isArray(value.pointers)
    ? value.pointers.slice(-32).flatMap((pointer) => {
        if (!pointer || typeof pointer !== "object") return [];
        const type = sampleTypes.has(pointer.type) ? pointer.type : null;
        const pointerType = pointerTypes.has(pointer.pointerType)
          ? pointer.pointerType
          : "unknown";
        const button = clampDiagnosticInteger(pointer.button, -1, 31);
        const buttons = clampDiagnosticInteger(pointer.buttons, 0, 255);
        const activePointers = clampDiagnosticInteger(pointer.activePointers, 0, 64);
        const editorMode = clampDiagnosticInteger(pointer.editorMode, 0, 1024);
        if (!type || button === null || buttons === null || activePointers === null || editorMode === null) {
          return [];
        }
        return [{
          type,
          pointerType,
          button,
          buttons,
          activePointers,
          editorMode,
          trusted: pointer.trusted === true,
        }];
      })
    : [];
  return {
    schema: 1,
    pointerEventsSeen: clampDiagnosticInteger(value.pointerEventsSeen, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    pointerEventsDropped: clampDiagnosticInteger(value.pointerEventsDropped, 0, Number.MAX_SAFE_INTEGER) ?? 0,
    activePointers: clampDiagnosticInteger(value.activePointers, 0, 64) ?? 0,
    pointers,
  };
}

function safeDiagnosticCode(value) {
  const allowed = new Set([
    "asset-prewarm-failed",
    "asset-read-failed",
    "asset-hash-mismatch",
    "blob-url-unavailable",
    "bridge-resource",
    "pdf-module-import",
    "pdfjs-global-missing",
    "viewer-module-import",
    "mobile-bootstrap",
  ]);
  return typeof value === "string" && allowed.has(value) ? value : "mobile-bootstrap";
}

function createMobileBootScript(serializedConfig) {
  return `(() => {
    const config = ${serializedConfig};
    const stage = (value) => window.parent.postMessage({
      channel: config.channel,
      token: config.token,
      rendererGeneration: config.rendererGeneration,
      type: "mobile-loader-stage",
      stage: value,
    }, "*");
    const loaded = (name, source) => window.parent.postMessage({
      channel: config.channel,
      token: config.token,
      rendererGeneration: config.rendererGeneration,
      type: "mobile-module-loaded",
      module: name,
      source,
    }, "*");
    const failed = (code) => window.parent.postMessage({
      channel: config.channel,
      token: config.token,
      rendererGeneration: config.rendererGeneration,
      type: "mobile-loader-failed",
      code,
    }, "*");
    function bridgeLoadError() {
      const error = new Error("bridge-resource");
      error.code = "bridge-resource";
      return error;
    }
    async function waitForBridge() {
      if (window.__PDF_READER_BRIDGE_LOADED__ === true) {
        return window.__PDF_READER_BRIDGE_SOURCE__ || "resource";
      }
      const bridgeScript = document.querySelector('script[data-pdf-reader-bridge="1"]');
      if (!bridgeScript) throw bridgeLoadError();

      if (window.__PDF_READER_BRIDGE_RESOURCE_FAILED__ !== true) {
        await new Promise((resolve, reject) => {
          let timer;
          const cleanup = () => {
            bridgeScript.removeEventListener("load", onLoad);
            bridgeScript.removeEventListener("error", onError);
            if (timer !== undefined) window.clearTimeout(timer);
          };
          const onLoad = () => { cleanup(); resolve(); };
          const onError = () => { cleanup(); resolve(); };
          bridgeScript.addEventListener("load", onLoad, { once: true });
          bridgeScript.addEventListener("error", onError, { once: true });
          timer = window.setTimeout(() => { cleanup(); reject(bridgeLoadError()); }, 15000);
        });
        if (window.__PDF_READER_BRIDGE_LOADED__ === true) {
          return window.__PDF_READER_BRIDGE_SOURCE__ || "resource";
        }
      }
      if (window.__PDF_READER_BRIDGE_RESOURCE_FAILED__ !== true) {
        throw bridgeLoadError();
      }

      return await new Promise((resolve, reject) => {
        const fallback = document.createElement("script");
        for (const name of [
          "data-pdf-reader-bridge",
          "data-channel",
          "data-token",
          "data-renderer-generation",
          "data-base-url",
          "data-ios-input-policy",
        ]) {
          const value = bridgeScript.getAttribute(name);
          if (value !== null) fallback.setAttribute(name, value);
        }
        fallback.dataset.mobileFallback = "1";
        fallback.async = false;
        let timer;
        const cleanup = () => {
          fallback.removeEventListener("load", onLoad);
          fallback.removeEventListener("error", onError);
          if (timer !== undefined) window.clearTimeout(timer);
        };
        const onLoad = () => {
          cleanup();
          window.__PDF_READER_BRIDGE_LOADED__ = true;
          window.__PDF_READER_BRIDGE_SOURCE__ = "blob";
          loaded("bridge", "blob");
          resolve("blob");
        };
        const onError = () => {
          cleanup();
          reject(bridgeLoadError());
        };
        fallback.addEventListener("load", onLoad, { once: true });
        fallback.addEventListener("error", onError, { once: true });
        timer = window.setTimeout(() => { cleanup(); reject(bridgeLoadError()); }, 15000);
        fallback.src = config.fallbackUrls.bridge;
        bridgeScript.after(fallback);
      });
    }
    const moduleGlobalNames = [
      "pdfjsLib",
      "_pdfjsTestingUtils",
      "PDFViewerApplication",
      "PDFViewerApplicationConstants",
      "PDFViewerApplicationOptions",
      "PDFViewerApplicationConfiguration",
    ];
    function captureModuleState() {
      const globals = Object.create(null);
      for (const name of moduleGlobalNames) {
        globals[name] = globalThis[name];
      }
      return {
        globalKeys: new Set(Reflect.ownKeys(globalThis)),
        globals,
        print: window.print,
      };
    }
    function moduleHasSideEffects(before) {
      for (const key of Reflect.ownKeys(globalThis)) {
        if (!before.globalKeys.has(key)) return true;
      }
      for (const name of moduleGlobalNames) {
        if (globalThis[name] !== before.globals[name]) return true;
      }
      return window.print !== before.print;
    }
    function moduleFailure(name) {
      const error = new Error("module-import-failed");
      error.code = name === "pdf" ? "pdf-module-import" : "viewer-module-import";
      return error;
    }
    async function importModule(name) {
      const beforeResourceImport = captureModuleState();
      try {
        await import(config.moduleUrls[name]);
        loaded(name, "resource");
      } catch {
        // An ESM import that rejects after publishing globals is not safe to
        // evaluate again under a blob URL: the second module has a distinct
        // cache key and can initialize PDF.js twice in one renderer.
        if (moduleHasSideEffects(beforeResourceImport)) {
          throw moduleFailure(name);
        }
        try {
          await import(config.fallbackUrls[name]);
          loaded(name, "blob");
        } catch {
          // The blob copy is the final permitted evaluation attempt.
          throw moduleFailure(name);
        }
      }
    }
    (async () => {
      try {
        await waitForBridge();
        window.__PDF_READER_MOBILE_RESOURCES__ = config.resourceUrls;
        stage("pdf-module-loading");
        await importModule("pdf");
        if (!globalThis.pdfjsLib) {
          const error = new Error("pdfjs-global-missing");
          error.code = "pdfjs-global-missing";
          throw error;
        }
        stage("viewer-module-loading");
        await importModule("viewer");
      } catch (error) {
        failed(error?.code || "mobile-bootstrap");
      }
    })();
  })();`;
}

async function ensureAdapterDirectory(adapter, directoryPath) {
  const segments = directoryPath.split("/");
  let currentPath = "";
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!(await adapter.exists(currentPath))) {
      await adapter.mkdir(currentPath);
    }
  }
}

function safeFileName(value) {
  return String(value || "recovered.pdf").split(/[\\/]/).at(-1) || "recovered.pdf";
}

class PdfWebReaderSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("自动保存 PDF 注释")
      .setDesc("编辑后的 PDF 注释会自动写回原文件。关闭后可用 Ctrl/Cmd+S 或阅读器保存按钮手动保存。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSave)
          .onChange((enabled) => this.plugin.setAutoSaveEnabled(enabled)),
      );
    new Setting(containerEl)
      .setName("显示阅读器状态栏")
      .setDesc("在 PDF 阅读器中显示加载、保存和同步状态；关闭后阅读区域不保留状态栏空间。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showStatusBar)
          .onChange((enabled) => this.plugin.setStatusBarEnabled(enabled)),
      );
    {
      const diagnosticSetting = new Setting(containerEl)
        .setName(this.plugin.isMobileRuntime ? "导出移动端诊断" : "导出阅读器诊断")
        .setDesc("将诊断快照及历史函数调用、操作、报错和耗时导出到 PDF Reader Diagnostics；不转储 PDF 内容，真实异常可能含文件路径。");
      if (typeof diagnosticSetting.addButton === "function") {
        diagnosticSetting.addButton((button) =>
          button
            .setButtonText("导出 JSON")
            .onClick(() => void this.plugin.exportMobileDiagnostics().catch(error => new Notice(`诊断导出失败：${error.message || error}`))),
        );
      }
    }
  }
}

class PdfReaderView extends EditableFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.token = makeToken();
    this.documentId = makeToken();
    this.rendererGeneration = makeToken();
    this.file = null;
    this.documentFile = null;
    this.requestedPath = null;
    this.navigationState = {};
    this.originalBytes = null;
    this.loadedBaseBytes = null;
    this.annotationSyncState = null;
    this.syncRequests = new Map();
    this.startupTimings = {};
    this.pendingBytes = null;
    this.pendingOpenGeneration = null;
    this.pendingOpenRefreshPromise = null;
    this.pendingOpenAdmission = null;
    this.currentRevision = 0;
    this.confirmedRevision = 0;
    this.latestRecoveryDraft = null;
    this.pendingOpenState = null;
    this.popoutMoveTransaction = null;
    this.rendererStateUnknown = false;
    this.viewerDocumentHtml = null;
    this.iframeLoadCount = 0;
    this.iframeLoadListener = null;
    this.awaitingRendererLoad = false;
    this.lastOpenSentRequest = null;
    this.ready = false;
    this.openAcknowledged = false;
    this.teardownStarted = false;
    this.openRequest = 0;
    this.resourcePromise = null;
    this._assetCache = null;
    this.mobileRuntime = {
      loaderMode: plugin.runtimeAdapter.loaderMode,
      stage: "idle",
      moduleSources: {},
      assetCount: null,
      workerSource: plugin.runtimeAdapter.workerSource,
      workerTerminated: null,
      resourceFailureCount: 0,
      lastError: null,
    };
    this.mobileResourceLease = null;
    this.mobileInputDiagnostics = null;
    this.mobileInputDiagnosticsRequests = new Map();
    this.iframe = null;
    this.statusEl = null;
    this.statusBarOpen = false;
    this.lastStatusMessage = "";
    this.statusRecoveryAction = false;
    this.ownerWindow = null;
    this.ownerWindowMessageSender = null;
    this.flushRequests = new Map();
    this.exportRequests = new Map();
    this.pendingSaves = 0;
    this.preparedClose = null;
    this.closePreparation = null;
    this.failureNoticeShown = false;
    this.bridgeTimeoutWindow = null;
    this.bridgeTimeoutDeadline = null;
    this.messageListener = (event) => this.onMessage(event);
    this.syncForegroundListener = () => {};
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.documentFile?.basename || this.file?.basename || "PDF 阅读器";
  }

  getIcon() {
    return "file-text";
  }

  get assetCache() {
    return this._assetCache;
  }

  get saving() {
    return this.pendingSaves > 0;
  }

  getState() {
    const baseState = super.getState();
    const path = this.requestedPath ?? this.file?.path ?? null;
    return {
      ...baseState,
      ...this.navigationState,
      ...(path ? { path, file: path } : {}),
    };
  }

  async setState(state, result) {
    const file = resolvePdfFile(this.plugin, state?.file ?? state?.path);
    if (!file && (this.requestedPath || this.documentFile || this.file)) {
      return;
    }
    const normalizedState = file
      ? { ...state, file: file.path, path: file.path }
      : state;
    if (file) {
      this.navigationState = { ...normalizedState };
    }
    await super.setState(normalizedState, result);
  }

  async onLoadFile(file) {
    await super.onLoadFile(file);
    if (!isPdfFile(file)) {
      return;
    }
    this.navigationState = {
      ...this.navigationState,
      file: file.path,
      path: file.path,
    };
    if (this.requestedPath !== file.path) {
      await this.openFile(file);
    }
  }

  async onUnloadFile(file) {
    const documentId = this.documentId;
    const openRequest = this.openRequest;
    const wasCurrent =
      this.documentFile === file || this.file === file || this.requestedPath === file.path;
    // FileView may invoke this from super.onClose(). Once SDK teardown has
    // started, the onClose flush result must stand; a second prepare request
    // cannot veto destruction and can only fail against a detached iframe.
    if (
      wasCurrent &&
      !this.teardownStarted &&
      !this.hasPreparedClose(documentId, openRequest)
    ) {
      const prepared = await this.prepareControlledClose("view-transition");
      if (!prepared) {
        throw new Error("The PDF remains open because its latest changes were not saved or recovered.");
      }
    }
    this.releasePendingOpenAdmission(documentId, openRequest);
    await super.onUnloadFile(file);
    if (wasCurrent) {
      const preparedClose = this.preparedClose;
      if (
        preparedClose?.documentId === documentId &&
        preparedClose?.openRequest === openRequest
      ) {
        preparedClose.unloaded = true;
      }
      this.openRequest += 1;
      this.releasePendingOpenAdmission();
      this.pendingBytes = null;
      this.pendingOpenGeneration = null;
      this.pendingOpenRefreshPromise = null;
      this.originalBytes = null;
      this.loadedBaseBytes = null;
      this.annotationSyncState = null;
      this.currentRevision = 0;
      this.confirmedRevision = 0;
      this.latestRecoveryDraft = null;
      this.pendingOpenState = null;
      this.rendererStateUnknown = false;
      this.requestedPath = null;
      this.documentFile = null;
      this.navigationState = {};
      this.plugin.heavyWork?.cancel(this);
      this.plugin.annotationHost?.releaseView(this);
    }
  }

  async onOpen() {
    this.teardownStarted = false;
    this.rendererGeneration = makeToken();
    await super.onOpen();
    this.contentEl.empty();
    this.contentEl.addClass("pdf-web-reader-content");

    /*
    this.statusEl = this.contentEl.createDiv({
      cls: "pdf-web-reader-status",
      text: "正在加载 PDF 阅读器…",
    });
    */
    this.statusEl = null;
    this.statusBarOpen = true;
    if (!this.lastStatusMessage && !this.statusRecoveryAction) {
      this.setStatus("正在加载 PDF 阅读器…");
    }
    this.setStatusBarEnabled(this.plugin.settings.showStatusBar);
    this.iframe = this.contentEl.createEl("iframe", {
      cls: "pdf-web-reader-frame",
      attr: {
        title: "PDF 阅读器",
        allow: "clipboard-read; clipboard-write",
        sandbox:
          "allow-downloads allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts",
      },
    });
    this.bindOwnerWindow();
    const iframe = this.iframe;
    this.iframeLoadCount = 0;
    this.iframeLoadListener = () => this.onIframeLoad(iframe);
    iframe.addEventListener?.("load", this.iframeLoadListener);

    try {
      const documentHtml = await this.createViewerDocument();
      if (this.iframe === iframe) {
        this.viewerDocumentHtml = documentHtml;
        this.viewerBootStartedAt = Date.now();
        iframe.srcdoc = documentHtml;
        this.bridgeTimeoutDeadline = Date.now() + 20000;
        this.scheduleBridgeTimeout();
      }
    } catch (error) {
      if (this.iframe === iframe) {
        this.plugin.invalidateViewerAssets();
        if (this.plugin.isMobileRuntime) {
          if (this.mobileRuntime.stage !== "resource-failed") {
            this.mobileRuntime.resourceFailureCount += 1;
            this.mobileRuntime.lastError = {
              stage: this.mobileRuntime.stage,
              code: safeDiagnosticCode(error?.diagnosticCode || "asset-read-failed"),
            };
            this.setMobileLoaderStage("resource-failed");
          }
          this.showError(this.mobileStartupFailureMessage());
        } else {
          this.showError(`无法加载内置 PDF 阅读器：${error.message}`);
        }
      }
    }
  }

  async onClose() {
    this.teardownStarted = true;
    const closingFile = this.documentFile || this.file;
    const closeWasPrepared = this.isPreparedCloseForCurrent();
    if (!closeWasPrepared) {
      const flush = await this.flushDocument();
      this.notifyFlushOutcome(flush);
    }
    this.releasePendingOpenAdmission();
    this.finishFlushRequests({ ok: false, dirty: true });
    for (const request of this.exportRequests.values()) {
      globalThis.clearTimeout(request.timer);
      request.reject(new Error("PDF 阅读器已关闭，导出已取消。"));
    }
    this.exportRequests.clear();
    for (const request of [...this.mobileInputDiagnosticsRequests.values()]) request.finish(null);
    this.clearBridgeTimeout();
    await super.onClose();
    const mobileGeneration = this.mobileResourceLease?.generation || null;
    if (this.iframe) {
      drainViewerRuntimeLog(this);
      this.iframe.removeEventListener?.("load", this.iframeLoadListener);
      this.iframe.srcdoc = "";
      this.iframe.remove();
      this.iframe = null;
    }
    if (!mobileGeneration) this.unbindOwnerWindow();
    else {
      this.mobileCleanupTimer = globalThis.setTimeout(() => this.revokeMobileResources(mobileGeneration, { force: true }), 5000);
    }
    this.iframeLoadListener = null;
    this.viewerDocumentHtml = null;
    this.iframeLoadCount = 0;
    this.statusBarOpen = false;
    this.removeStatusElement();
    this.ready = false;
    this.openAcknowledged = false;
    this.openRequest += 1;
    this.releasePendingOpenAdmission();
    this.pendingBytes = null;
    this.pendingOpenGeneration = null;
    this.pendingOpenRefreshPromise = null;
    this.originalBytes = null;
    this.loadedBaseBytes = null;
    this.annotationSyncState = null;
    this.annotationDocument = null;
    this.annotationHydrationAllowed = false;
    this.currentRevision = 0;
    this.confirmedRevision = 0;
    this.latestRecoveryDraft = null;
    this.pendingOpenState = null;
    this.popoutMoveTransaction = null;
    this.awaitingRendererLoad = false;
    this.lastOpenSentRequest = null;
    this.rendererStateUnknown = false;
    this.requestedPath = null;
    this.documentFile = null;
    this.navigationState = {};
    this.preparedClose = null;
    this.closePreparation = null;
    this.plugin.views.delete(this);
    this.plugin.heavyWork?.cancel(this);
    this.plugin.annotationHost?.releaseView(this);
    this.contentEl.removeClass("pdf-web-reader-content");
  }

  getOwnerWindow() {
    try {
      const frameWindow = this.iframe?.contentWindow;
      if (frameWindow?.parent) return frameWindow.parent;
    } catch {
      // A detached or cross-origin frame may not expose its parent. Fall back
      // to the iframe's owner document, which is more specific than contentEl.
    }
    return (
      this.iframe?.ownerDocument?.defaultView ||
      this.contentEl?.ownerDocument?.defaultView ||
      globalThis.window ||
      null
    );
  }

  onIframeLoad(iframe) {
    if (this.iframe !== iframe) return;
    this.iframeLoadCount += 1;
    // Obsidian can adopt the iframe after its synchronous move method returns.
    // In that window, contentEl may still belong to the former document, while
    // the iframe's active browsing context already has a different parent.
    // Rebind before every early return so the new realm's one-shot `ready`
    // message cannot be lost on the old owner window.
    this.bindOwnerWindow();
    if (this.popoutMoveTransaction) {
      // The SDK adopts the iframe while the Reader is frozen. The move wrapper
      // will install the exact reopen checkpoint after the synchronous move.
      this.popoutMoveTransaction.realmReloaded = true;
      return;
    }
    if (this.awaitingRendererLoad) {
      this.awaitingRendererLoad = false;
      if (this.bridgeTimeoutDeadline === null) {
        this.bridgeTimeoutDeadline = Date.now() + 20000;
      }
      this.scheduleBridgeTimeout();
      return;
    }
    if (this.iframeLoadCount === 1 || !this.ready) {
      if (this.bridgeTimeoutDeadline === null) {
        this.bridgeTimeoutDeadline = Date.now() + 20000;
      }
      this.scheduleBridgeTimeout();
      return;
    }

    // Renderer state is not durable. Reopen the unchanged source PDF and
    // rehydrate the confirmed external operation log instead of retaining a
    // second full PDF/recovery buffer in the host.
    const file = this.documentFile || this.file;
    this.ready = false;
    this.rendererStateUnknown = true;
    this.preparedClose = null;
    this.pendingOpenState = null;
    this.pendingBytes = null;
    this.clearBridgeTimeout();
    this.bridgeTimeoutDeadline = Date.now() + 20000;
    if (!file || !this.rotateRendererGeneration()) {
      this.showError("PDF 阅读器页面意外重载，无法恢复安全会话。请重新打开此 PDF。");
      return;
    }
    this.awaitingRendererLoad = true;
    this.iframe.srcdoc = this.viewerDocumentHtml;
    this.scheduleBridgeTimeout();
    void this.openFile(file);
    this.showError("PDF 阅读器页面意外重载；已从只读底本与已确认的外置批注日志重新打开。未确认的最后操作可能未保存。");
  }

  rotateRendererGeneration() {
    this.openAcknowledged = false;
    const currentHtml = this.viewerDocumentHtml;
    const currentAttribute = `data-renderer-generation="${escapeAttribute(this.rendererGeneration)}"`;
    if (typeof currentHtml !== "string" || !currentHtml.includes(currentAttribute)) {
      return false;
    }
    const nextGeneration = makeToken();
    this.viewerDocumentHtml = currentHtml.replace(
      currentAttribute,
      `data-renderer-generation="${escapeAttribute(nextGeneration)}"`,
    );
    this.rendererGeneration = nextGeneration;
    return true;
  }

  createPopoutMigrationState(prepared) {
    if (
      !prepared ||
      prepared.documentId !== this.documentId ||
      prepared.openRequest !== this.openRequest ||
      !Number.isSafeInteger(prepared.revision) || prepared.revision < 0 ||
      !this.annotationDocument ||
      !this.viewerDocumentHtml?.includes(`data-renderer-generation="${escapeAttribute(this.rendererGeneration)}"`)
    ) return null;
    if (prepared.revision !== this.confirmedRevision || this.currentRevision !== this.confirmedRevision) return null;
    return { revision: this.confirmedRevision, confirmedRevision: this.confirmedRevision };
  }

  restartViewerAfterPopoutMove(checkpoint, transaction) {
    if (
      !this.iframe || !this.viewerDocumentHtml ||
      transaction.documentId !== this.documentId || transaction.openRequest !== this.openRequest
    ) return false;
    const file = this.documentFile || this.file;
    if (!file || !this.rotateRendererGeneration()) return false;
    this.pendingBytes = null;
    this.pendingOpenState = null;
    this.preparedClose = null;
    this.closePreparation = null;
    this.popoutMoveTransaction = null;
    this.rendererStateUnknown = false;
    this.awaitingRendererLoad = true;
    this.ready = false;
    this.currentRevision = checkpoint.revision;
    this.confirmedRevision = checkpoint.confirmedRevision;
    this.clearBridgeTimeout();
    this.bridgeTimeoutDeadline = Date.now() + 20000;
    this.bindOwnerWindow();
    this.scheduleBridgeTimeout();
    this.setStatus("正在从外置批注记录恢复 PDF 阅读器…");
    this.iframe.srcdoc = this.viewerDocumentHtml;
    void this.openFile(file);
    return true;
  }

  bindOwnerWindow() {
    const nextWindow = this.getOwnerWindow() || this.ownerWindow;
    if (nextWindow === this.ownerWindow) {
      if (!this.ownerWindowMessageSender) {
        this.ownerWindowMessageSender = createOwnerWindowMessageSender(nextWindow);
      }
      this.plugin.registerPopoutCloseProtection(this, nextWindow);
      return;
    }
    this.unbindOwnerWindow();
    this.ownerWindow = nextWindow;
    this.ownerWindowMessageSender = createOwnerWindowMessageSender(nextWindow);
    this.ownerWindow?.addEventListener("message", this.messageListener);
    this.ownerWindow?.addEventListener("focus", this.syncForegroundListener);
    this.plugin.registerPopoutCloseProtection(this, this.ownerWindow);
    if (this.bridgeTimeoutDeadline !== null && !this.ready) {
      this.scheduleBridgeTimeout();
    }
    for (const request of this.flushRequests.values()) {
      this.scheduleFlushTimeout(request, this.ownerWindow);
    }
  }

  unbindOwnerWindow() {
    this.plugin.unregisterPopoutCloseProtection(this);
    this.ownerWindow?.removeEventListener("message", this.messageListener);
    this.ownerWindow?.removeEventListener("focus", this.syncForegroundListener);
    this.ownerWindow = null;
    this.ownerWindowMessageSender = null;
  }

  setMobileLoaderStage(stage) {
    if (!MOBILE_STAGE_VALUES.has(stage)) return;
    if (this.ready && !["ready", "resource-failed", "disposed"].includes(stage)) {
      return;
    }
    this.mobileRuntime.stage = stage;
    if (this.plugin.isMobileRuntime && !this.ready && !this.teardownStarted &&
        !["ready", "resource-failed", "disposed"].includes(stage)) {
      this.setStatus(`正在启动 PDF 阅读器：${MOBILE_STAGE_LABELS[stage]}…`);
    }
  }

  mobileStartupFailureMessage() {
    const error = this.mobileRuntime.lastError;
    const label = MOBILE_STAGE_LABELS[error?.stage] || MOBILE_STAGE_LABELS.idle;
    const code = safeDiagnosticCode(error?.code);
    return `移动端 PDF 阅读器启动失败：${label}（${code}）。请导出诊断 JSON，关闭此标签后重新打开 PDF 重试。`;
  }

  revokeMobileResourceUrl(generation, key) {
    const lease = this.mobileResourceLease;
    if (!lease || lease.generation !== generation) return false;
    const url = lease.urls.get(key);
    if (!url) return false;
    try {
      globalThis.URL?.revokeObjectURL?.(url);
    } catch {
      // A WebView may already have discarded the object URL registry.
    }
    lease.urls.delete(key);
    this.mobileRuntime.revokedResourceCount =
      (this.mobileRuntime.revokedResourceCount || 0) + 1;
    return true;
  }

  revokeMobileResources(generation, { force = false } = {}) {
    const lease = this.mobileResourceLease;
    if (!lease || lease.generation !== generation) return false;
    if (!force && !(lease.rendererUnloaded && lease.workerTerminated)) {
      return false;
    }
    for (const key of [...lease.urls.keys()]) {
      this.revokeMobileResourceUrl(generation, key);
    }
    this.mobileResourceLease = null;
    if (this.mobileCleanupTimer !== null && this.mobileCleanupTimer !== undefined) {
      globalThis.clearTimeout(this.mobileCleanupTimer);
      this.mobileCleanupTimer = null;
    }
    if (this.teardownStarted) this.unbindOwnerWindow();
    return true;
  }

  handleMobileRuntimeMessage(message) {
    if (message.type === "input-diagnostics") {
      if (message.rendererGeneration !== this.rendererGeneration) return true;
      const request = this.mobileInputDiagnosticsRequests.get(message.requestId);
      if (!request) return true;
      const snapshot = sanitizeInputDiagnostics(message);
      this.mobileInputDiagnostics = snapshot;
      request.finish(snapshot);
      return true;
    }

    const generation = message.rendererGeneration;
    if (typeof generation !== "string" || generation !== this.rendererGeneration) {
      return message.type.startsWith("mobile-") ||
        message.type === "renderer-unloaded" ||
        message.type === "worker-terminated";
    }

    if (message.type === "mobile-loader-stage") {
      this.setMobileLoaderStage(message.stage);
      return true;
    }
    if (message.type === "mobile-module-loaded") {
      if (!["bridge", "pdf", "viewer"].includes(message.module)) return true;
      const source = ["resource", "blob"].includes(message.source)
        ? message.source
        : "unknown";
      this.mobileRuntime.moduleSources[message.module] = source;
      if (message.module === "pdf") {
        this.setMobileLoaderStage("pdf-module-loaded");
      } else if (message.module === "viewer") {
        this.setMobileLoaderStage("viewer-module-loaded");
      }
      this.revokeMobileResourceUrl(generation, message.module);
      return true;
    }
    if (message.type === "mobile-loader-failed") {
      this.plugin.invalidateViewerAssets();
      const code = safeDiagnosticCode(message.code);
      this.mobileRuntime.resourceFailureCount += 1;
      this.mobileRuntime.lastError = {
        stage: this.mobileRuntime.stage,
        code,
      };
      this.setMobileLoaderStage("resource-failed");
      this.clearBridgeTimeout();
      this.showError(this.mobileStartupFailureMessage());
      this.revokeMobileResources(generation, { force: true });
      return true;
    }
    if (message.type === "renderer-unloaded") {
      const lease = this.mobileResourceLease;
      if (lease?.generation === generation) {
        lease.rendererUnloaded = true;
        this.setMobileLoaderStage("disposed");
        this.revokeMobileResources(generation);
      }
      return true;
    }
    if (message.type === "worker-terminated") {
      const lease = this.mobileResourceLease;
      if (lease?.generation === generation) {
        lease.workerTerminated = true;
        this.mobileRuntime.workerTerminated = true;
        this.revokeMobileResources(generation);
      }
      return true;
    }
    return false;
  }

  requestInputDiagnostics(timeoutMs = 1000) {
    if (!this.iframe || !this.ready) return Promise.resolve(null);
    const requestId = makeToken();
    return new Promise((resolve) => {
      const request = {
        timer: null,
        finish: (snapshot) => {
          if (request.timer !== null) globalThis.clearTimeout(request.timer);
          this.mobileInputDiagnosticsRequests.delete(requestId);
          resolve(snapshot);
        },
      };
      this.mobileInputDiagnosticsRequests.set(requestId, request);
      request.timer = globalThis.setTimeout(() => request.finish(null), timeoutMs);
      const sent = this.postToViewer({
        channel: CHANNEL,
        type: "get-input-diagnostics",
        token: this.token,
        requestId,
      });
      if (!sent) request.finish(null);
    });
  }

  clearBridgeTimeout() {
    if (this.bridgeTimeout !== null && this.bridgeTimeout !== undefined) {
      this.bridgeTimeoutWindow?.clearTimeout(this.bridgeTimeout);
    }
    this.bridgeTimeout = null;
    this.bridgeTimeoutWindow = null;
    this.bridgeTimeoutDeadline = null;
  }

  scheduleBridgeTimeout() {
    if (
      this.bridgeTimeoutDeadline === null ||
      !this.ownerWindow ||
      !this.iframe ||
      this.ready
    ) {
      return;
    }
    if (this.bridgeTimeout !== null && this.bridgeTimeout !== undefined) {
      this.bridgeTimeoutWindow?.clearTimeout(this.bridgeTimeout);
    }
    const iframe = this.iframe;
    const timerWindow = this.ownerWindow;
    const delay = Math.max(0, this.bridgeTimeoutDeadline - Date.now());
    let timer;
    timer = timerWindow.setTimeout(() => {
      if (
        this.bridgeTimeoutWindow !== timerWindow ||
        this.bridgeTimeout !== timer
      ) {
        return;
      }
      this.bridgeTimeout = null;
      this.bridgeTimeoutWindow = null;
      this.bridgeTimeoutDeadline = null;
      if (this.iframe === iframe && !this.ready) {
        this.plugin.invalidateViewerAssets();
        if (this.plugin.isMobileRuntime) {
          this.mobileRuntime.resourceFailureCount += 1;
          this.mobileRuntime.lastError = {
            stage: this.mobileRuntime.stage,
            code: "mobile-bootstrap",
          };
          this.setMobileLoaderStage("resource-failed");
          this.showError(this.mobileStartupFailureMessage());
          if (this.mobileResourceLease) {
            this.revokeMobileResources(this.mobileResourceLease.generation, { force: true });
          }
        } else {
          this.showError(
            "PDF 阅读器未能启动。请检查插件内置的 Viewer 资源是否完整。",
          );
        }
      }
    }, delay);
    this.bridgeTimeout = timer;
    this.bridgeTimeoutWindow = timerWindow;
  }

  scheduleFlushTimeout(request, timerWindow = this.ownerWindow) {
    if (request.timer !== null && request.timer !== undefined) {
      request.timerWindow?.clearTimeout(request.timer);
      request.timer = null;
      request.timerWindow = null;
    }
    // A controlled close does not consume its Viewer-ack budget while the
    // host is quiescing sync work. Its deadline is assigned immediately before
    // prepare-close is posted; owner-window rebinding during quiesce can call
    // this method, so leave an unarmed request alone until then.
    if (!Number.isFinite(request.deadline)) return;
    if (!timerWindow) {
      request.finish({ ok: false, dirty: true, timeout: true });
      return;
    }
    const delay = Math.max(0, request.deadline - Date.now());
    let timer;
    timer = timerWindow.setTimeout(() => {
      if (request.timerWindow !== timerWindow || request.timer !== timer) {
        return;
      }
      request.finish({ ok: false, dirty: true, timeout: true });
    }, delay);
    request.timer = timer;
    request.timerWindow = timerWindow;
  }

  finishFlushRequests(result) {
    for (const request of [...this.flushRequests.values()]) {
      request.finish(result);
    }
  }

  async flushDocument(timeoutMs = 120000) {
    if (!this.ready || !this.requestedPath || !this.iframe) {
      return { ok: true, dirty: false };
    }
    const id = makeToken();
    const ownerWindow = this.getOwnerWindow() || this.ownerWindow;
    if (!ownerWindow) return { ok: false, dirty: true };
    this.bindOwnerWindow();
    const response = new Promise((resolve) => {
      const request = {
        id,
        deadline: Date.now() + timeoutMs,
        timer: null,
        timerWindow: null,
        finish: (result) => {
          if (request.settled) return;
          request.settled = true;
          if (request.timer !== null && request.timer !== undefined) {
            request.timerWindow?.clearTimeout(request.timer);
          }
          request.timer = null;
          request.timerWindow = null;
          if (this.flushRequests.get(id) === request) {
            this.flushRequests.delete(id);
          }
          resolve(result);
        },
        settled: false,
      };
      this.flushRequests.set(id, request);
      this.scheduleFlushTimeout(request, this.ownerWindow || ownerWindow);
    });
    if (
      !this.postToViewer({
        channel: CHANNEL,
        type: "flush",
        token: this.token,
        documentId: this.documentId,
        id,
      })
    ) {
      this.flushRequests.get(id)?.finish({ ok: false, dirty: true });
    }
    return response;
  }

  isPreparedCloseForCurrent() {
    const prepared = this.preparedClose;
    if (!prepared || prepared.documentId !== this.documentId) return false;
    if (prepared.openRequest === this.openRequest) return true;
    return Boolean(
      prepared.unloaded &&
        this.requestedPath === null &&
        this.openRequest === prepared.openRequest + 1,
    );
  }

  hasPreparedClose(documentId, openRequest) {
    return Boolean(
      this.preparedClose?.documentId === documentId &&
        this.preparedClose?.openRequest === openRequest,
    );
  }

  sendCancelClose(request) {
    if (!request?.iframe) return;
    this.postToViewer(
      {
        channel: CHANNEL,
        type: "cancel-close",
        token: this.token,
        id: request.id,
        documentId: request.documentId,
        openRequest: request.openRequest,
      },
      [],
      request.iframe,
    );
  }

  cancelPreparedClose(documentId, openRequest) {
    const prepared = this.preparedClose;
    if (
      prepared?.documentId === documentId &&
      prepared?.openRequest === openRequest
    ) {
      this.sendCancelClose(prepared);
      this.preparedClose = null;
    }
  }

  async prepareControlledClose(reason) {
    const documentId = this.documentId;
    const openRequest = this.openRequest;
    if (this.hasPreparedClose(documentId, openRequest)) return true;
    if (!this.ready) {
      if (this.pendingSaves > 0 || this.currentRevision > this.confirmedRevision) {
        new Notice(
          "PDF 标签保持打开：尚未确认最新批注操作已写入外置记录。",
          8000,
        );
        return false;
      }
      this.preparedClose = {
        id: null,
        documentId,
        openRequest,
        revision: this.currentRevision,
        recovered: false,
        iframe: this.iframe,
      };
      return true;
    }
    if (!this.iframe) {
      new Notice(
        "PDF 标签保持打开：阅读器连接已断开，无法确认最新更改已保存或恢复。",
        8000,
      );
      return false;
    }

    const inFlight = this.closePreparation;
    if (
      inFlight &&
      inFlight.documentId === documentId &&
      inFlight.openRequest === openRequest
    ) {
      return inFlight.promise;
    }

    const request = {
      id: makeToken(),
      documentId,
      openRequest,
      iframe: this.iframe,
      deadline: null,
      timer: null,
      timerWindow: null,
      settled: false,
      finish: null,
    };
    this.bindOwnerWindow();
    const response = new Promise((resolve) => {
      request.finish = (result) => {
        if (request.settled) return;
        request.settled = true;
        if (request.timer !== null && request.timer !== undefined) {
          request.timerWindow?.clearTimeout(request.timer);
        }
        request.timer = null;
        request.timerWindow = null;
        if (this.flushRequests.get(request.id) === request) {
          this.flushRequests.delete(request.id);
        }
        resolve(result);
      };
      this.flushRequests.set(request.id, request);
      this.scheduleFlushTimeout(request, this.ownerWindow);
    });
    const pending = {
      documentId,
      openRequest,
      promise: null,
    };
    // Publish the session before its first identity check. Defer execution so
    // even a synchronous/reentrant bridge observes the shared close promise.
    this.closePreparation = pending;
    pending.promise = Promise.resolve().then(async () => {
      const stillCurrent =
        !request.settled &&
        !this.plugin.isUnloading &&
        this.documentId === documentId &&
        this.openRequest === openRequest &&
        this.ready &&
        this.iframe === request.iframe &&
        this.closePreparation === pending;
      if (!stillCurrent) {
        request.finish({ ok: false, dirty: true });
        return false;
      }
      // Quiescing can safely spend time stopping a background sync checkpoint
      // or apply. Give the Viewer a fresh, complete acknowledgement window
      // only after that work has settled and the captured session is rechecked.
      request.deadline = Date.now() + 120000;
      this.scheduleFlushTimeout(request, this.ownerWindow);
      const sent = this.postToViewer(
        {
          channel: CHANNEL,
          type: "prepare-close",
          token: this.token,
          id: request.id,
          documentId,
          openRequest,
          reason: ["detach", "view-transition"].includes(reason)
            ? reason
            : "detach",
        },
        [],
        request.iframe,
      );
      if (!sent) request.finish({ ok: false, dirty: true });
      const result = await response;
      const identityMatches =
        this.documentId === documentId && this.openRequest === openRequest;
      const revisionValid = Number.isSafeInteger(result?.revision) && result.revision >= 0;
      const revisionCurrent = revisionValid && result.revision >= this.currentRevision;
      const clean = result?.ok === true && result?.dirty === false;
      const recovered = result?.recovered === true;
      const prepared =
        identityMatches &&
        result?.documentId === documentId &&
        result?.openRequest === openRequest &&
        result?.prepared === true &&
        revisionCurrent &&
        (clean || recovered);
      this.notifyFlushOutcome(result);
      if (!prepared) {
        this.sendCancelClose(request);
        new Notice(
          "PDF 标签保持打开：关闭前未能确认最新更改已保存或恢复。请解决保存问题后再关闭。",
          8000,
        );
        return false;
      }
      this.preparedClose = {
        id: request.id,
        documentId,
        openRequest,
        revision: result.revision,
        recovered,
        iframe: request.iframe,
        unloaded: false,
      };
      return true;
    }).finally(() => {
      if (this.closePreparation === pending) this.closePreparation = null;
    });
    return pending.promise;
  }

  notifyUnflushed() {
    if (this.failureNoticeShown) return;
    this.failureNoticeShown = true;
    new Notice(
      "PDF 尚有未确认的批注操作写入外置记录；请保持标签打开后重试保存。",
      8000,
    );
  }

  notifyRecoveredDraft() {
    if (this.failureNoticeShown) return;
    this.failureNoticeShown = true;
    new Notice(
      "关闭前的批注操作已写入外置恢复记录；原始 PDF 保持不变。",
      8000,
    );
  }

  notifyFlushOutcome(flush) {
    if (!flush?.ok || flush?.dirty) {
      this.notifyUnflushed();
    }
  }

  async createViewerDocument() {
    if (!this.resourcePromise) {
      this.resourcePromise = this.loadViewerDocument().catch((error) => {
        this.resourcePromise = null;
        throw error;
      });
    }
    return this.resourcePromise;
  }

  async loadViewerDocument() {
    const started = Date.now();
    if (this.plugin.isMobileRuntime) this.setMobileLoaderStage("assets-loading");
    const assets = await this.plugin.ensureViewerAssets();
    this.startupTimings.resourcesMs = Date.now() - started;
    this.startupTimings.resources = assets.metrics || null;
    this._assetCache = Object.freeze({ ...assets });
    this.mobileRuntime.assetCount = Array.isArray(VIEWER_ASSET_PAYLOAD?.files)
      ? VIEWER_ASSET_PAYLOAD.files.length
      : null;
    this.mobileRuntime.resourceHash = assets.contentHash;
    this.mobileRuntime.assetVersion = assets.version;
    this.setMobileLoaderStage("assets-ready");
    const webRoot = assets.webRoot;
    const viewerHtmlPath = `${webRoot}/viewer.html`;
    const viewerCssPath = `${webRoot}/viewer.css`;
    const bridgeCssPath = `${webRoot}/bridge.css`;
    const [viewerHtml, viewerCss, bridgeCss] = await Promise.all([
      this.plugin.readVerifiedAssetText("web/viewer.html"),
      this.plugin.readVerifiedAssetText("web/viewer.css"),
      this.plugin.readVerifiedAssetText("web/bridge.css"),
    ]);
    const viewerUrl = this.app.vault.adapter.getResourcePath(viewerHtmlPath);
    const webBase = new URL("./", viewerUrl).href;
    return this.plugin.runtimeAdapter.createViewerDocument(this, {
      assets, viewerHtml, viewerCss, bridgeCss, viewerUrl, webBase,
    });
  }

  createDesktopViewerDocument({ viewerHtml, viewerCss, bridgeCss, webBase }) {
    const bridgeUrl = new URL("obsidian-bridge.js", webBase);
    // Obsidian's app:// resource URLs can remain stable across plugin reloads,
    // and Chromium may then reuse an older bridge script from its cache.
    // A per-view cache key ensures the bridge matches this host's protocol.
    bridgeUrl.searchParams.set("v", this.token);

    const bridgeScript =
      `<script src="${escapeAttribute(bridgeUrl.href)}" ` +
      `data-channel="${CHANNEL}" data-token="${escapeAttribute(this.token)}" ` +
      `data-ios-input-policy="${this.plugin.iosInputPolicy}" ` +
      `data-renderer-generation="${escapeAttribute(this.rendererGeneration)}"></script>`;
    const baseTag = `<base href="${escapeAttribute(webBase)}">`;
    const injection = `${baseTag}${bridgeScript}`;
    const inlineViewerCss = `<style data-pdf-reader="viewer">${escapeStyleText(viewerCss)}</style>`;
    const inlineBridgeCss = `<style data-pdf-reader="bridge">${escapeStyleText(bridgeCss)}</style>`;
    let viewerCssInserted = false;
    const htmlWithInlineStyles = viewerHtml.replace(
      /<link\b[^>]*>/gi,
      (tag) => {
        const relMatch = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(
          tag,
        );
        const hrefMatch =
          /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const rel = relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? "";
        const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
        if (
          rel.toLowerCase() === "stylesheet" &&
          /(?:^|\/)viewer\.css(?:[?#].*)?$/i.test(href)
        ) {
          viewerCssInserted = true;
          return `${inlineViewerCss}${inlineBridgeCss}`;
        }
        return tag;
      },
    );
    if (!viewerCssInserted) {
      throw new Error("The bundled viewer.html does not reference viewer.css.");
    }
    const headMatch = /<head\b[^>]*>/i.exec(htmlWithInlineStyles);
    if (headMatch) {
      const withBase = htmlWithInlineStyles.replace(/<base\b[^>]*>/gi, "");
      return withBase.replace(/<head\b[^>]*>/i, `${headMatch[0]}${injection}`);
    }
    return `${injection}${htmlWithInlineStyles}`;
  }

  async createMobileViewerDocument({
    assets,
    viewerHtml,
    viewerCss,
    bridgeCss,
    viewerUrl,
    webBase,
  }) {
    const adapter = this.app.vault.adapter;
    const payloadFiles = new Map(
      (VIEWER_ASSET_PAYLOAD?.files || []).map((file) => [file.path, file]),
    );
    const blobApi = globalThis.URL;
    if (
      typeof blobApi?.createObjectURL !== "function" ||
      typeof globalThis.Blob !== "function"
    ) {
      this.mobileRuntime.lastError = {
        stage: "resources-read",
        code: "blob-url-unavailable",
      };
      this.mobileRuntime.stage = "resource-failed";
      throw new Error("This mobile WebView cannot create local module URLs.");
    }

    const scripts = {};
    const scriptPaths = {};
    const createdUrls = new Map();
    try {
      for (const [name, relativePath] of Object.entries(
        MOBILE_RESOURCE_SCRIPT_PATHS,
      )) {
        const manifestEntry = payloadFiles.get(relativePath);
        if (!manifestEntry) {
          throw Object.assign(new Error("A required viewer resource is missing."), {
            diagnosticCode: "asset-read-failed",
          });
        }
        const fullPath = `${assets.rootPath}/${relativePath}`;
        const bytes = await this.plugin.readVerifiedAsset(relativePath);
        // The plugin already hashed these bytes in readVerifiedAsset and keeps
        // the checked promise across Readers. Rehashing the large Worker here
        // would repeat the CPU cost after successful background preparation.
        if (bytes.byteLength !== manifestEntry.size) {
          throw Object.assign(new Error("A viewer resource failed verification."), {
            diagnosticCode: "asset-hash-mismatch",
          });
        }
        scripts[name] = bytes;
        scriptPaths[name] = adapter.getResourcePath(fullPath);
      }

      this.setMobileLoaderStage("resources-read");
      const pdfModuleUrl = blobApi.createObjectURL(
        new globalThis.Blob([scripts.pdf], { type: "text/javascript" }),
      );
      createdUrls.set("pdf", pdfModuleUrl);
      const bridgeFallbackUrl = blobApi.createObjectURL(
        new globalThis.Blob([scripts.bridge], { type: "text/javascript" }),
      );
      createdUrls.set("bridge", bridgeFallbackUrl);
      const viewerModuleUrl = blobApi.createObjectURL(
        new globalThis.Blob([scripts.viewer], { type: "text/javascript" }),
      );
      createdUrls.set("viewer", viewerModuleUrl);
      const workerUrl = blobApi.createObjectURL(
        new globalThis.Blob([scripts.worker], { type: "text/javascript" }),
      );
      createdUrls.set("worker", workerUrl);

      if (this.teardownStarted || !this.iframe) {
        for (const url of createdUrls.values()) blobApi.revokeObjectURL?.(url);
        throw new Error("The PDF viewer closed while its resources were loading.");
      }

      const generation = this.rendererGeneration;
      const bridgeUrl = new URL(scriptPaths.bridge);
      bridgeUrl.searchParams.set("v", this.token);
      const resourceUrls = {
        workerSrc: workerUrl,
        cMapUrl: new URL("cmaps/", webBase).href,
        iccUrl: new URL("iccs/", webBase).href,
        fontUrl: new URL("standard_fonts/", webBase).href,
        wasmUrl: new URL("wasm/", webBase).href,
        imageResourcesPath: new URL("images/", webBase).href,
      };
      this.mobileResourceLease = {
        generation,
        frameWindow: this.iframe.contentWindow,
        urls: createdUrls,
        rendererUnloaded: false,
        workerTerminated: false,
      };
      this.setMobileLoaderStage("bridge-loading");
      this.mobileRuntime.workerSource = "blob";
      this.mobileRuntime.workerTerminated = false;
      this.mobileRuntime.moduleSources = {};

      const inlineViewerCss = `<style data-pdf-reader="viewer">${escapeStyleText(viewerCss)}</style>`;
      const inlineBridgeCss = `<style data-pdf-reader="bridge">${escapeStyleText(bridgeCss)}</style>`;
      const bootConfig = JSON.stringify({
        channel: CHANNEL,
        token: this.token,
        rendererGeneration: generation,
        resourceUrls,
        moduleUrls: {
          pdf: scriptPaths.pdf,
          viewer: scriptPaths.viewer,
        },
        fallbackUrls: {
          bridge: bridgeFallbackUrl,
          pdf: pdfModuleUrl,
          viewer: viewerModuleUrl,
        },
      }).replaceAll("<", "\\u003c");
      const bootScript = `<script type="module">${createMobileBootScript(bootConfig)}</script>`;
      const bridgeScript =
        `<script data-pdf-reader-bridge="1" src="${escapeAttribute(bridgeUrl.href)}" ` +
        `data-channel="${CHANNEL}" data-token="${escapeAttribute(this.token)}" ` +
        `data-ios-input-policy="${this.plugin.iosInputPolicy}" ` +
        `data-renderer-generation="${escapeAttribute(generation)}" ` +
        `data-base-url="${escapeAttribute(webBase)}" ` +
        `onload="window.__PDF_READER_BRIDGE_LOADED__=true;window.__PDF_READER_BRIDGE_SOURCE__=window.__PDF_READER_BRIDGE_SOURCE__||'resource';window.parent.postMessage({channel:'${CHANNEL}',token:'${escapeAttribute(this.token)}',rendererGeneration:'${escapeAttribute(generation)}',type:'mobile-module-loaded',module:'bridge',source:window.__PDF_READER_BRIDGE_SOURCE__},'*')" ` +
        `onerror="window.__PDF_READER_BRIDGE_RESOURCE_FAILED__=true"></script>`;
      let viewerCssInserted = false;
      let htmlWithInlineStyles = viewerHtml.replace(/<link\b[^>]*>/gi, (tag) => {
        const relMatch = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const rel = relMatch?.[1] ?? relMatch?.[2] ?? relMatch?.[3] ?? "";
        const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "";
        if (rel.toLowerCase() === "stylesheet" && /(?:^|\/)viewer\.css(?:[?#].*)?$/i.test(href)) {
          viewerCssInserted = true;
          return "";
        }
        return tag;
      });
      htmlWithInlineStyles = htmlWithInlineStyles.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (tag) => {
        const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
        const src = srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? "";
        return /(?:^|\/)build\/pdf\.mjs(?:[?#].*)?$/i.test(src) || /(?:^|\/)viewer\.mjs(?:[?#].*)?$/i.test(src)
          ? ""
          : tag;
      });
      if (!viewerCssInserted) {
        throw new Error("The bundled viewer.html does not reference viewer.css.");
      }
      const headMatch = /<head\b[^>]*>/i.exec(htmlWithInlineStyles);
      const injection =
        `<base href="${escapeAttribute(webBase)}">` +
        inlineViewerCss +
        inlineBridgeCss +
        bridgeScript +
        bootScript;
      if (headMatch) {
        htmlWithInlineStyles = htmlWithInlineStyles.replace(/<base\b[^>]*>/gi, "");
        return htmlWithInlineStyles.replace(/<head\b[^>]*>/i, `${headMatch[0]}${injection}`);
      }
      return `${injection}${htmlWithInlineStyles}`;
    } catch (error) {
      for (const url of createdUrls.values()) blobApi.revokeObjectURL?.(url);
      this.mobileRuntime.resourceFailureCount += 1;
      const code = safeDiagnosticCode(error?.diagnosticCode || "asset-read-failed");
      this.mobileRuntime.lastError = { stage: this.mobileRuntime.stage, code };
      this.mobileRuntime.stage = "resource-failed";
      throw new Error("The mobile PDF reader could not prepare verified viewer resources.");
    }
  }

  async openFile(file) {
    if (!isPdfFile(file)) {
      throw new Error("Only PDF files can be opened in this view.");
    }
    this.releasePendingOpenAdmission();
    const openingPath = normalizePath(file.path);
    if ((this.documentFile || this.file) !== file || this.requestedPath !== file.path) {
      this.documentId = makeToken();
      this.annotationDocument = null;
      this.annotationSyncState = null;
      this.annotationHydrationAllowed = false;
      this.annotationSourceMismatch = false;
      this.preparedClose = null;
      this.closePreparation = null;
      this.currentRevision = 0;
      this.confirmedRevision = 0;
      this.latestRecoveryDraft = null;
      this.pendingOpenState = null;
      this.popoutMoveTransaction = null;
      this.rendererStateUnknown = false;
    }
    const request = ++this.openRequest;
    this.openAcknowledged = false;
    this.openStartedAt = Date.now();
    this.documentFile = file;
    this.requestedPath = file.path;
      this.annotationLegacyIdentityUncertain = false;
    this.pendingBytes = null;
    this.pendingOpenGeneration = null;
    try {
      const bytes = await this.app.vault.readBinary(file);
      if (request !== this.openRequest) return;
      if (normalizePath(file.path) !== openingPath ||
          this.app.vault.getAbstractFileByPath(openingPath) !== file) {
        throw new Error("PDF 在读取期间已移动或被替换；批注尚未写入外置记录。");
      }
      const externalAnnotations = await this.plugin.annotationHost.initializeView(this, bytes);
      if (request !== this.openRequest) {
        this.plugin.annotationHost.releaseView(this);
        return;
      }
      this.documentId = externalAnnotations.documentId;
      this.annotationDocument = this.annotationDocument || {
        documentId: externalAnnotations.documentId,
        sourcePath: openingPath,
      };
      this.annotationSyncState = externalAnnotations;
      this.originalBytes = null;
      this.loadedBaseBytes = null;
      this.pendingBytes = bytes;
      this.pendingOpenState = null;
      this.lastOpenSentRequest = null;
      this.setStatus(this.annotationLegacyIdentityUncertain
        ? (this.annotationSourceMismatch
          ? "PDF 来源已变化；外置批注已暂停，Reader 以只读模式打开。"
          : "检测到旧版 PDF 批注，但无法验证其身份；已进入只读模式，原 PDF 未修改。")
        : `正在打开：${file.path}`);
      if (this.ready) this.sendPendingDocument();
    } catch (error) {
      if (request === this.openRequest) {
        this.showError(`无法读取 ${file.path}：${error.message}`);
      }
    }
  }

  releasePendingOpenAdmission(documentId = null, openRequest = null) {
    const admission = this.pendingOpenAdmission;
    if (!admission ||
        (documentId !== null && admission.documentId !== documentId) ||
        (openRequest !== null && admission.openRequest !== openRequest)) return false;
    this.pendingOpenAdmission = null;
    admission.release?.();
    return true;
  }

  onMessage(event) {
    const message = event.data;
    const cleanupMessage = Boolean(
      this.mobileResourceLease &&
        event.source === this.mobileResourceLease.frameWindow &&
        message?.rendererGeneration === this.mobileResourceLease.generation &&
        ["renderer-unloaded", "worker-terminated"].includes(message?.type),
    );
    if (
      (!this.iframe || event.source !== this.iframe.contentWindow) &&
      !cleanupMessage
    ) {
      return;
    }
    this.bindOwnerWindow();
    if (
      !message ||
      message.channel !== CHANNEL ||
      message.token !== this.token ||
      typeof message.type !== "string"
    ) {
      return;
    }
    if (message.type === "runtime-log") {
      if (message.rendererGeneration !== this.rendererGeneration || !Array.isArray(message.rows)) return;
      for (const row of message.rows.slice(0, 256)) {
        if (typeof row !== "string" || row.length > 20000) continue;
        this.plugin.sessionLog?.record("viewer", { documentId: this.documentId, rendererGeneration: this.rendererGeneration, row });
      }
      return;
    }
    if (message.type === "annotation-source-identity") {
      void this.plugin.annotationHost.handleMessage(this, message).catch((error) => {
        this.showError(`无法确认外置批注对应的 PDF 页面：${error.message}`);
      });
      return;
    }
    this.plugin.sessionLog?.record("protocol", { documentId: this.documentId, type: message.type, revision: message.revision, openRequest: message.openRequest, code: message.code, bytes: message.data?.byteLength });
    if (this.handleMobileRuntimeMessage(message)) return;
    if (message.rendererGeneration === this.rendererGeneration) {
      if (message.type === "heavy-release") {
        this.plugin.heavyWork?.release(this, message.leaseId);
        return;
      }
      if (message.type === "heavy-cancel") {
        if (typeof message.id === "string") this.plugin.heavyWork?.cancel(this, message.id);
        return;
      }
    }
    if (message.type === "close-prepared") {
      const request = this.flushRequests.get(message.id);
      if (!request) return;
      const identityMatches =
        request.documentId === message.documentId &&
        request.openRequest === message.openRequest &&
        this.documentId === request.documentId &&
        this.openRequest === request.openRequest;
      request.finish({
        ok: identityMatches && message.ok === true,
        dirty: message.dirty === true,
        recovered: message.recovered === true,
        closeWritebackQueued: message.closeWritebackQueued === true,
        prepared: identityMatches && message.prepared === true,
        revision: message.revision,
        documentId: message.documentId,
        openRequest: message.openRequest,
      });
      return;
    }
    if (message.documentId && message.documentId !== this.documentId) {
      return;
    }
    if (
      Number.isInteger(message.openRequest) &&
      message.openRequest !== this.openRequest
    ) {
      return;
    }

    switch (message.type) {
      case "heavy-acquire": {
        if (message.rendererGeneration !== this.rendererGeneration || typeof message.id !== "string" || !message.id || message.documentId !== this.documentId) return;
        const captured = this.captureSaveRequest();
        void this.plugin.acquireHeavyLease(this, captured.file, "viewer", null, message.id).then((lease) => {
          if (!this.isCurrentSaveRequest(captured) || !this.postToViewer({ channel: CHANNEL, token: this.token, type: "heavy-granted", id: message.id, leaseId: lease.id, documentId: captured.documentId, openRequest: captured.openRequest })) lease.release();
        }, (error) => {
          this.postToViewer({ channel: CHANNEL, token: this.token, type: "heavy-rejected", id: message.id, documentId: captured.documentId, openRequest: captured.openRequest, reason: error.message });
        });
        break;
      }
      case "ready":
        if (message.rendererGeneration !== this.rendererGeneration || this.ready) {
          return;
        }
        this.ready = true;
        this.startupTimings.modulesMs = this.viewerBootStartedAt ? Date.now() - this.viewerBootStartedAt : null;
        this.setMobileLoaderStage("ready");
        this.clearBridgeTimeout();
        this.sendPendingDocument();
        break;
      case "opened":
        if (
          message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest
        ) {
          return;
        }
        if (
          Number.isSafeInteger(message.revision) &&
          message.revision >= 0 &&
          Number.isSafeInteger(message.confirmedRevision) &&
          message.confirmedRevision >= 0
        ) {
          const pending = this.pendingOpenState;
          if (
            pending &&
            (message.revision !== pending.revision ||
              message.confirmedRevision !== pending.confirmedRevision ||
              message.dirty !== pending.restoreDirty ||
              message.restorePaused !== pending.restorePaused)
          ) {
            this.releasePendingOpenAdmission(message.documentId, message.openRequest);
            this.showError(
              "PDF 阅读器恢复状态与宿主确认的检查点不一致；请先检查恢复副本。",
            );
            return;
          }
          this.currentRevision = message.revision;
          this.confirmedRevision = message.confirmedRevision;
          if (pending) this.pendingOpenState = null;
          this.rendererStateUnknown = false;
        }
        this.openAcknowledged = true;
        this.setStatus(this.file ? `已打开：${this.file.path}` : "");
        this.releasePendingOpenAdmission(message.documentId, message.openRequest);
        this.pendingOpenGeneration = null;
        this.startupTimings.openMs = this.openStartedAt ? Date.now() - this.openStartedAt : null;
        this.startupTimings.viewer = message.startupTimings || null;
        break;
      case "startup-timings": {
        if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId || message.openRequest !== this.openRequest) return;
        const timings = { ...(this.startupTimings.viewer || {}) };
        for (const key of ["pdfParseMs", "firstPageAnnotationLayerMs", "toolsUsableMs"]) {
          const value = message.timings?.[key];
          if (Number.isFinite(value) && value >= 0) timings[key] = value;
        }
        this.startupTimings.viewer = timings;
        break;
      }
      case "save":
        void this.saveFile(
          message.data,
          message.documentId,
          message.requestId,
          message.revision,
          message.origin,
          message,
        );
        break;
      case "recover":
        void this.recoverFile(
          message.data,
          message.documentId,
          message.requestId,
          message.revision,
          message.reason,
          message,
        );
        break;
      case "flushed": {
        const request = this.flushRequests.get(message.id);
        request?.finish({
          ok: Boolean(message.ok),
          dirty: Boolean(message.dirty),
          recovered: Boolean(message.recovered),
        });
        break;
      }
      case "error":
        if ((message.code === "open-failed" || String(message.code || "").startsWith("open-blocked-")) &&
            typeof message.documentId === "string" && Number.isSafeInteger(message.openRequest)) {
          const released = this.releasePendingOpenAdmission(message.documentId, message.openRequest);
          if (released) {
            this.openAcknowledged = false;
            this.pendingOpenGeneration = null;
          }
        }
        this.showError(message.message || "PDF 阅读器报告了错误。");
        break;
      case "export-ready":
      case "export-error": {
        const request = this.exportRequests.get(message.requestId);
        if (!request || request.documentId !== message.documentId || request.openRequest !== message.openRequest) return;
        this.exportRequests.delete(message.requestId);
        globalThis.clearTimeout(request.timer);
        if (message.type === "export-error") request.reject(new Error(message.message || "导出 PDF 失败。"));
        else request.resolve(message.data);
        break;
      }
    }
  }

  sendPendingDocument() {
    const file = this.documentFile || this.file;
    const restore = this.pendingOpenState;
    const sourceBytes = restore?.bytes || this.pendingBytes || this.originalBytes;
    if (
      !this.ready ||
      this.popoutMoveTransaction ||
      !sourceBytes ||
      !file ||
      this.lastOpenSentRequest === this.openRequest ||
      restore?.sent === true
    ) {
      return;
    }
    const data = sourceBytes instanceof ArrayBuffer
      ? sourceBytes
      : sourceBytes instanceof Uint8Array
        ? sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength)
        : sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
    const message = {
      channel: CHANNEL,
      type: "open",
      token: this.token,
      data,
      documentId: this.documentId,
      documentPath: file.path,
      filename: file.basename,
      openRequest: this.openRequest,
      autoSave: this.plugin.settings.autoSave,
      heavyLeaseRequired: this.plugin.isMobileRuntime,
      revision: restore?.revision ?? this.currentRevision,
      confirmedRevision:
        restore?.confirmedRevision ?? this.confirmedRevision,
      restoreDirty: restore?.restoreDirty === true,
      restorePaused: restore?.restorePaused === true,
      // The Viewer may finish parsing before ordered page identities are
      // confirmed by the host. Keep all editing disabled until the verified
      // external-annotations-update handshake arrives.
      readOnly: true,
      externalAnnotations: this.annotationHydrationAllowed === false
        ? { ...this.annotationSyncState, annotations: [] }
        : this.annotationSyncState,
    };
    if (!this.postToViewer(message, [data])) return;
    this.originalBytes = null;
    this.loadedBaseBytes = null;
    this.lastOpenSentRequest = this.openRequest;
    if (restore) {
      restore.sent = true;
    } else {
      this.pendingBytes = null;
    }
  }

  postToViewer(message, transfer = [], iframe = this.iframe) {
    message = { rendererGeneration: this.rendererGeneration, ...message };
    const target = iframe?.contentWindow;
    if (!target) {
      return false;
    }
    const currentOwnerWindow = this.getOwnerWindow() || this.ownerWindow;
    if (currentOwnerWindow !== this.ownerWindow) this.bindOwnerWindow();
    const sender = this.ownerWindowMessageSender;
    if (sender) {
      try {
        return sender(target, message, transfer);
      } catch {
        return false;
      }
    }
    // The main-window plugin realm can safely use its native sender when the
    // Function constructor is unavailable. Never use that fallback for a
    // popup-owned Reader because the bridge checks event.source === parent.
    if (this.ownerWindow && this.ownerWindow === globalThis.window) {
      try {
        if (transfer.length) target.postMessage(message, "*", transfer);
        else target.postMessage(message, "*");
        return true;
      } catch {
        if (!transfer.length) return false;
        try {
          target.postMessage(message, "*");
          return true;
        } catch {
          return false;
        }
      }
    }
    return false;
  }

  captureSaveRequest() {
    const file = this.documentFile || this.file;
    return {
      documentId: this.documentId,
      file,
      documentPath: this.requestedPath,
      openRequest: this.openRequest,
      rendererGeneration: this.rendererGeneration,
      loadedBaseBytes: this.loadedBaseBytes,
      originalBytes: this.originalBytes,
      filename: file?.basename || safeFileName(this.requestedPath),
      iframe: this.iframe,
    };
  }

  async saveFile(value, documentId, requestId, revision = null, origin = "manual", annotationSync = null) {
    const request = this.captureSaveRequest();
    this.pendingSaves += 1;
    try {
      if (!request.file || !request.documentId || documentId !== request.documentId) {
        throw Object.assign(new Error("保存请求对应的 PDF 与当前打开的文件不一致。"), { code: "document-mismatch" });
      }
      const message = {
        ...(annotationSync && typeof annotationSync === "object" ? annotationSync : {}),
        type: "save",
        documentId,
        requestId,
        revision,
        origin,
      };
      await this.plugin.annotationHost.handleMessage(this, message);
    } catch (error) {
      this.postToViewer({
        channel: CHANNEL, token: this.token, type: "error",
        code: error.code || "save-failed", message: error.message,
        documentId, requestId, revision,
      }, [], request.iframe);
    } finally {
      this.pendingSaves = Math.max(0, this.pendingSaves - 1);
    }
  }

  async recoverFile(value, documentId, requestId, revision, reason, annotationSync = null) {
    const request = this.captureSaveRequest();
    this.pendingSaves += 1;
    try {
      if (!request.file || !request.documentId || documentId !== request.documentId) {
        throw Object.assign(new Error("恢复请求对应的 PDF 与当前打开的文件不一致。"), { code: "document-mismatch" });
      }
      const message = {
        ...(annotationSync && typeof annotationSync === "object" ? annotationSync : {}),
        type: "recover",
        documentId,
        requestId,
        revision,
        reason,
      };
      await this.plugin.annotationHost.handleMessage(this, message);
    } catch (error) {
      this.postToViewer({
        channel: CHANNEL, token: this.token, type: "error",
        code: error.code || "recovery-failed", message: error.message,
        documentId, requestId, revision,
      }, [], request.iframe);
    } finally {
      this.pendingSaves = Math.max(0, this.pendingSaves - 1);
    }
  }

  async exportAnnotatedCopy() {
    const file = this.documentFile || this.file;
    if (!isPdfFile(file) || !this.ready || !this.iframe) {
      throw new Error("请先在 PDF 阅读器中打开一个 PDF。");
    }
    const requestId = makeToken();
    const request = {
      documentId: this.documentId,
      openRequest: this.openRequest,
      rendererGeneration: this.rendererGeneration,
      file,
      timer: null,
      resolve: null,
      reject: null,
    };
    const response = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
      request.timer = globalThis.setTimeout(() => {
        this.exportRequests.delete(requestId);
        reject(new Error("PDF 导出等待 Viewer 响应超时。"));
      }, 120000);
    });
    this.exportRequests.set(requestId, request);
    const sent = this.postToViewer({
      channel: CHANNEL,
      token: this.token,
      type: "export-copy",
      requestId,
      documentId: this.documentId,
      openRequest: this.openRequest,
      revision: this.currentRevision,
    });
    if (!sent) {
      this.exportRequests.delete(requestId);
      globalThis.clearTimeout(request.timer);
      throw new Error("无法向 PDF 阅读器发送导出请求。");
    }
    let bytes;
    try {
      bytes = await response;
    } finally {
      globalThis.clearTimeout(request.timer);
      if (this.exportRequests.get(requestId) === request) this.exportRequests.delete(requestId);
    }
    if (this.documentId !== request.documentId || this.openRequest !== request.openRequest ||
        (this.documentFile || this.file) !== file || this.rendererGeneration !== request.rendererGeneration) {
      throw new Error("PDF 阅读器会话在导出过程中已变化；没有创建输出文件。");
    }
    const array = bytes instanceof ArrayBuffer ? bytes :
      bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null;
    if (!array || array.byteLength === 0) throw new Error("Viewer 没有返回有效的 PDF 导出数据。");
    const folder = normalizePath(file.path).split("/").slice(0, -1).join("/");
    const base = file.basename.replace(/\.pdf$/i, "") || "PDF";
    let outputPath = normalizePath(`${folder ? `${folder}/` : ""}${base} (PDF Reader Export).pdf`);
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(outputPath)) {
      outputPath = normalizePath(`${folder ? `${folder}/` : ""}${base} (PDF Reader Export ${index}).pdf`);
      index += 1;
    }
    await this.app.vault.createBinary(outputPath, array);
    new Notice(`已导出带批注的独立 PDF：${outputPath}`);
    return outputPath;
  }

  isCurrentSaveRequest(request) {
    return Boolean(
      request?.file &&
        (this.documentFile || this.file) === request.file &&
        this.documentId === request.documentId &&
        this.openRequest === request.openRequest &&
        (!request.rendererGeneration || this.rendererGeneration === request.rendererGeneration) &&
        normalizePath(this.requestedPath || "") ===
          normalizePath(request.file.path),
    );
  }

  onDocumentRenamed(file, oldPath) {
    if (this.documentFile !== file && this.file !== file && this.requestedPath !== oldPath) return;
    this.file = file;
    this.documentFile = file;
    this.requestedPath = file.path;
    this.navigationState = {
      ...this.navigationState,
      file: file.path,
      path: file.path,
    };
    this.postToViewer({
      channel: CHANNEL,
      type: "rename",
      token: this.token,
      documentId: this.documentId,
      documentPath: file.path,
      filename: file.basename,
    });
    this.setStatus(`已移动：${file.path}`);
  }

  setStatus(message, options = {}) {
    if (typeof options.recoveryAction === "boolean") {
      this.statusRecoveryAction = options.recoveryAction;
    }
    if (!this.statusRecoveryAction || options.recoveryAction === true) {
      this.lastStatusMessage = String(message || "");
    }
    this.renderStatus();
  }

  removeStatusElement() {
    const status = this.statusEl;
    if (!status) return;
    if (typeof status.remove === "function") status.remove();
    else status.parentElement?.removeChild?.(status);
    this.statusEl = null;
  }

  setStatusBarEnabled(enabled) {
    this.statusBarEnabled = Boolean(enabled);
    if (!this.statusBarEnabled || !this.statusBarOpen) {
      if (!this.statusBarEnabled) this.removeStatusElement();
      return;
    }
    if (!this.statusEl) {
      this.statusEl = this.contentEl.createDiv({ cls: "pdf-web-reader-status" });
      const frame = this.iframe;
      if (frame?.parentNode && frame.parentNode === this.contentEl) {
        frame.parentNode.insertBefore?.(this.statusEl, frame);
      } else if (frame?.before) {
        frame.before(this.statusEl);
      }
    }
    this.renderStatus();
  }

  renderStatus() {
    const status = this.statusEl;
    if (!status) return;
    status.empty?.();
    status.setText?.(this.lastStatusMessage);
    if (this.statusRecoveryAction && typeof status.createEl === "function") {
      status.createEl("button", { text: "恢复本地副本" })
        .addEventListener("click", () => void this.plugin.restoreLatestRecovery());
    }
    status.toggleClass?.(
      "is-hidden",
      !this.lastStatusMessage && !this.statusRecoveryAction,
    );
  }

  showError(message) {
    this.plugin.sessionLog?.record("error", { fn: "PdfReaderView.showError", documentId: this.documentId, message: String(message).slice(0, 4096) });
    this.setStatus(message);
    new Notice(message, 8000);
  }
}

module.exports = class PdfWebReaderPlugin extends Plugin {
  get runtimeAdapter() {
    return this.platformRuntimeAdapter || DESKTOP_RUNTIME_ADAPTER;
  }

  get isMobileRuntime() {
    return this.mobileRuntimeSelected === true;
  }

  get iosInputPolicy() {
    // Obsidian's desktop mobile emulator exercises the same policy as iOS.
    // Native Android and ordinary desktop Readers keep their existing input.
    return this.isMobileRuntime &&
      (Platform?.isIosApp === true || Platform?.isDesktopApp === true);
  }

  async onload() {
    this.platformRuntimeAdapter = isMobilePlatform(this.app)
      ? MOBILE_RUNTIME_ADAPTER : DESKTOP_RUNTIME_ADAPTER;
    this.mobileRuntimeSelected = this.runtimeAdapter.mobile;
    this.pdfHashRuntime = await createPdfHashRuntime();
    activePdfHashRuntime = this.pdfHashRuntime;
    this.sessionLog?.record("hashRuntime", {
      algorithm: this.pdfHashRuntime.algorithm,
      fallback: this.pdfHashRuntime.algorithm !== "xxh64-v1",
      fallbackReason: this.pdfHashRuntime.fallbackReason,
    });
    this.settings = {
      autoSave: true,
      showStatusBar: false,
      ...((await this.loadData()) || {}),
    };
    this.settings.autoSave = this.settings.autoSave !== false;
    this.settings.showStatusBar = this.settings.showStatusBar === true;
    this.views = new Set();
    this.popoutCloseGates = new Map();
    this.popoutProtectionWarnings = new WeakSet();
    this.isQuitting = false;
    this.isUnloading = false;
    this.heavyWork = createHeavyWorkCoordinator({ enabled: () => this.isMobileRuntime, makeId: makeToken });
    this.verifiedAssetBytes = new Map();
    this.verifiedAssetTexts = new Map();
    this.resourcePrewarm = {
      status: "idle", reason: null, attempts: 0,
      durationMs: null, lastErrorCode: null,
    };
    this.prewarmPromise = null;
    this.prewarmTimer = null;
    this.annotationHost = createPdfAnnotationHost({
      app: this.app,
      hashRuntime: this.pdfHashRuntime,
      identityHash: (bytes) => sha256Bytes(bytes),
      inspectLegacy: (bytes) => this.getLegacyMergeClient().inspect({ bytes, fastOpen: true }),
      normalizePath,
      makeToken,
      deviceId: localAnnotationDeviceId(),
      Notice,
      log: (event, details) => this.sessionLog?.record("annotationStore", { event, ...details }),
    });
    traceMethods(this.annotationHost, "PdfAnnotationHost", () => this.sessionLog);
    traceMethods(this.heavyWork, "HeavyWork", () => this.sessionLog);
    this.recoveryDirectory = normalizePath(
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/.recovery`,
    );
    this.registerView(VIEW_TYPE, (leaf) => {
      const view = new PdfReaderView(leaf, this);
      this.views.add(view);
      return view;
    });
    this.pdfOpenRouting = installPdfOpenRouting(this);
    this.addSettingTab(new PdfWebReaderSettingTab(this.app, this));
    this.addCommand({
      id: "open-current-pdf",
      name: "在 PDF 阅读器中打开当前 PDF",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isPdfFile(file)) {
          return false;
        }
        if (!checking) {
          void this.openPdf(file);
        }
        return true;
      },
    });
    this.addCommand({
      id: "restore-latest-pdf-recovery",
      name: "恢复旧版 PDF 自动保存副本",
      callback: () => void this.restoreLatestRecovery(),
    });
    this.addCommand({
      id: "export-pdf-with-external-annotations",
      name: "将当前 PDF 与外置批注合并导出为独立 PDF",
      callback: () => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof PdfReaderView)) {
          new Notice("请先在 PDF 阅读器中打开一个 PDF。");
          return;
        }
        void view.exportAnnotatedCopy().catch((error) => new Notice(`PDF 导出失败：${error.message || error}`, 8000));
      },
    });
    this.addCommand({
      id: "export-mobile-pdf-diagnostics",
      name: "导出 PDF 阅读器诊断 JSON",
      callback: () => void this.exportMobileDiagnostics().catch(error => new Notice(`诊断导出失败：${error.message || error}`)),
    });
    this.addCommand({
      id: "review-pdf-annotation-devices",
      name: "审查当前 PDF 的批注同步设备",
      callback: () => void this.reviewPdfAnnotationDevices(),
    });
    /* 单独 .log 路径命令保留但不启用；完整运行记录并入“导出诊断 JSON”。
    this.addCommand({
      id: "flush-local-runtime-log",
      name: "立即写入本地运行日志",
      callback: () => void this.sessionLog.flush().then(ok => new Notice(ok ? `运行日志：${this.sessionLog.path}` : `日志写入失败：${this.sessionLog.lastWriteError?.message || "请检查存储权限"}`)),
    });
    */
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!isPdfFile(file)) {
          return;
        }
        menu.addItem((item) => {
          item
            .setTitle("使用 PDF 阅读器打开")
            .setIcon("file-text")
            .onClick(() => void this.openPdf(file));
        });
      }),
    );
    if (typeof this.app.vault.on === "function") {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          void this.annotationHost.handleSidecarChange(file).then((handled) => {
            if (!handled && isPdfFile(file)) return this.annotationHost.handleSourceModify(file);
            return undefined;
          }).catch((error) => this.sessionLog?.record("annotationStore", {
            event: "vault-modify-check-failed", path: safeFileName(file?.path), code: error.code || "unknown",
          }));
        }),
      );
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          void this.annotationHost.handleSidecarChange(file).catch((error) => this.sessionLog?.record("annotationStore", {
            event: "vault-create-check-failed", code: error.code || "unknown",
          }));
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (!isPdfFile(file)) {
            void this.annotationHost.handleSidecarChange(file).catch((error) => this.sessionLog?.record("annotationStore", {
              event: "sidecar-rename-check-failed", path: safeFileName(file?.path), code: error.code || "unknown",
            }));
            return;
          }
          const normalizedOldPath = normalizePath(oldPath);
          void this.annotationHost.renamed(file, normalizedOldPath).catch((error) => this.sessionLog?.record("annotationStore", {
            event: "rename-index-failed", path: safeFileName(file.path), code: error.code || "unknown",
          }));
          for (const view of this.views) {
            view.onDocumentRenamed(file, normalizedOldPath);
          }
        }),
      );
    }
    if (typeof this.app.workspace.on === "function") {
      this.registerEvent(
        this.app.workspace.on("layout-change", () => {
          for (const view of this.views) view.bindOwnerWindow();
        }),
      );
      this.registerEvent(
        this.app.workspace.on("quit", () => {
          // Obsidian owns application-quit teardown; do not hold it open for
          // an asynchronous renderer handshake.
          this.isQuitting = true;
        }),
      );
    }
    // Resource preparation belongs to the plugin, not to DeferredView
    // materialization or completion of the workspace layout.
    this.scheduleViewerPrewarm("plugin-load");
    if (typeof this.app.workspace.onLayoutReady === "function") {
      this.app.workspace.onLayoutReady(() => this.scheduleViewerPrewarm("layout-ready"));
    }
    const foreground = () => {
      if (globalThis.document?.visibilityState !== "hidden") {
        this.scheduleViewerPrewarm("foreground");
      }
    };
    if (typeof this.registerDomEvent === "function" && globalThis.window?.addEventListener) {
      this.registerDomEvent(globalThis.window, "focus", foreground);
      if (globalThis.document?.addEventListener) this.registerDomEvent(globalThis.document, "visibilitychange", foreground);
    }
  }

  async reviewPdfAnnotationDevices() {
    const view = this.app.workspace.activeLeaf?.view;
    if (!(view instanceof PdfReaderView) || !view.annotationDocument) {
      new Notice("请先在 PDF 阅读器中打开并完成身份校验的 PDF。", 6000);
      return;
    }
    try {
      const { checkpointHash, devices } = await this.annotationHost.store.inspectDevices(view.annotationDocument);
      if (!checkpointHash) {
        new Notice("此 PDF 尚无可审查的批注检查点。", 6000);
        return;
      }
      const pending = devices.filter((device) => !device.isCurrent && !device.retired && !device.acknowledged);
      if (!pending.length) {
        new Notice("所有已登记设备均已确认当前检查点；已退役设备不再参与同步。", 6000);
        return;
      }
      new AnnotationDeviceReviewModal(this.app, this, view.annotationDocument, checkpointHash, devices).open();
    } catch (error) {
      new Notice(`读取批注设备状态失败：${error.message || error}`, 8000);
    }
  }

  onunload() {
    this.isUnloading = true;
    if (activePdfHashRuntime === this.pdfHashRuntime) activePdfHashRuntime = null;
    if (this.prewarmTimer != null) globalThis.clearTimeout(this.prewarmTimer);
    this.prewarmTimer = null;
    if (this.resourcePrewarm) this.resourcePrewarm.status = "disposed";
    this.annotationHost?.dispose();
    this.legacyMergeClient?.dispose();
    this.legacyMergeClient = null;
    this.heavyWork?.dispose();
    this.viewerAssetsResult = null;
    this.verifiedAssetBytes?.clear();
    this.verifiedAssetTexts?.clear();
    for (const gate of [...(this.popoutCloseGates?.values() || [])]) {
      this.disposePopoutCloseGate(gate);
    }
    restorePdfOpenRouting(this.pdfOpenRouting);
    this.pdfOpenRouting = null;
    this.viewerAssetsPromise = null;
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    void this.sessionLog?.close();
    activeSessionLog = null;
  }

  async moveReaderToPopout(workspace, leaf, originalMove, args) {
    const callOriginal = () => originalMove.apply(workspace, [leaf, ...args]);
    const view = leaf?.view;
    if (
      workspace !== this.app.workspace ||
      !(view instanceof PdfReaderView) ||
      this.isQuitting ||
      this.isUnloading
    ) {
      return callOriginal();
    }

    const documentId = view.documentId;
    const openRequest = view.openRequest;
    const oldOwnerWindow = view.getOwnerWindow();
    const oldParent = leaf.parent;
    const prepared = await view.prepareControlledClose("view-transition");
    if (!prepared) return false;
    if (
      leaf.view !== view ||
      view.documentId !== documentId ||
      view.openRequest !== openRequest
    ) {
      view.cancelPreparedClose(documentId, openRequest);
      return false;
    }

    const checkpoint = view.createPopoutMigrationState(view.preparedClose);
    if (!checkpoint) {
      view.cancelPreparedClose(documentId, openRequest);
      view.showError(
        "无法确认 PDF 弹出迁移的保存检查点；当前标签保持原位。请先保存或恢复更改。",
      );
      return false;
    }
    const transaction = {
      documentId,
      openRequest,
      oldOwnerWindow,
      oldParent,
      checkpoint,
      realmReloaded: false,
    };
    view.popoutMoveTransaction = transaction;

    let result;
    try {
      // Obsidian 1.14.4 moves the existing leaf synchronously through this
      // workspace-instance API. Keep the transaction active if a later SDK
      // version changes it to return a promise.
      result = callOriginal();
      if (result && typeof result.then === "function") {
        result = await result;
      }
    } catch (error) {
      const ownerChanged = view.getOwnerWindow() !== oldOwnerWindow;
      if (ownerChanged || transaction.realmReloaded) {
        view.bindOwnerWindow();
        if (!view.restartViewerAfterPopoutMove(checkpoint, transaction)) {
          view.popoutMoveTransaction = null;
          view.cancelPreparedClose(documentId, openRequest);
        }
      } else {
        view.popoutMoveTransaction = null;
        view.cancelPreparedClose(documentId, openRequest);
      }
      throw error;
    }

    view.bindOwnerWindow();
    const newOwnerWindow = view.getOwnerWindow();
    const moved =
      newOwnerWindow !== oldOwnerWindow ||
      (result?.workspace === workspace &&
        result?.win &&
        result.win !== oldOwnerWindow &&
        leaf.parent !== oldParent);
    if (!moved) {
      if (transaction.realmReloaded) {
        if (view.restartViewerAfterPopoutMove(checkpoint, transaction)) {
          return result;
        }
      }
      view.popoutMoveTransaction = null;
      view.cancelPreparedClose(documentId, openRequest);
      return result;
    }

    // A changed owner window is sufficient evidence that the SDK moved this
    // Reader even if its internal split cannot be identified for close guard
    // installation; bindOwnerWindow reports that limited-protection case.
    if (!view.restartViewerAfterPopoutMove(checkpoint, transaction)) {
      view.popoutMoveTransaction = null;
      view.cancelPreparedClose(documentId, openRequest);
      view.showError(
        "PDF 标签已移动，但阅读器恢复未能启动。已保留迁移前确认的恢复检查点。",
      );
    }
    return result;
  }

  registerPopoutCloseProtection(view, ownerWindow) {
    if (!this.runtimeAdapter.supportsPopout) {
      this.unregisterPopoutCloseProtection(view);
      return false;
    }
    const isPopout = isPopoutWindow(ownerWindow);
    const root = isPopout
      ? findPopoutSplit(view.leaf, ownerWindow, this.app.workspace)
      : null;
    const currentGate = view.popoutCloseGate;
    if (
      currentGate?.active &&
      currentGate.ownerWindow === ownerWindow &&
      currentGate.root === root
    ) {
      return true;
    }
    this.unregisterPopoutCloseProtection(view);
    if (!isPopout) return false;
    if (!root) {
      this.warnPopoutProtectionUnavailable(ownerWindow);
      return false;
    }

    let gate = this.popoutCloseGates.get(ownerWindow);
    if (gate && gate.root !== root) {
      this.warnPopoutProtectionUnavailable(ownerWindow);
      return false;
    }
    if (!gate) {
      gate = this.createPopoutCloseGate(ownerWindow, root);
      if (!gate) {
        this.warnPopoutProtectionUnavailable(ownerWindow);
        return false;
      }
      this.popoutCloseGates.set(ownerWindow, gate);
    }
    gate.views.add(view);
    view.popoutCloseGate = gate;
    return true;
  }

  unregisterPopoutCloseProtection(view) {
    const gate = view.popoutCloseGate;
    if (!gate) return;
    view.popoutCloseGate = null;
    gate.views.delete(view);
    if (gate.views.size === 0 && !gate.closePromise) {
      this.disposePopoutCloseGate(gate);
    }
  }

  warnPopoutProtectionUnavailable(ownerWindow) {
    if (
      ownerWindow &&
      (typeof ownerWindow === "object" || typeof ownerWindow === "function")
    ) {
      if (this.popoutProtectionWarnings.has(ownerWindow)) return;
      this.popoutProtectionWarnings.add(ownerWindow);
    }
    new Notice(
      "无法确认此 PDF 弹出窗口的安全关闭入口。请先保存或恢复更改，再关闭该窗口。",
      8000,
    );
  }

  createPopoutCloseGate(ownerWindow, root) {
    const originalClose = root.close;
    if (typeof originalClose !== "function") return null;
    const ownCloseDescriptor = Object.getOwnPropertyDescriptor(root, "close");
    const gate = {
      ownerWindow,
      root,
      originalClose,
      ownCloseDescriptor,
      closeWrapper: null,
      beforeUnloadListener: null,
      views: new Set(),
      active: true,
      allowClose: false,
      closeCommitted: false,
      closePromise: null,
    };
    gate.closeWrapper = function (...args) {
      return thisPlugin.requestPopoutClose(gate, this, args);
    };
    const thisPlugin = this;
    gate.beforeUnloadListener = (event) =>
      this.handlePopoutBeforeUnload(gate, event);

    try {
      Object.defineProperty(root, "close", {
        configurable: true,
        enumerable: ownCloseDescriptor?.enumerable ?? false,
        writable: true,
        value: gate.closeWrapper,
      });
      ownerWindow.addEventListener(
        "beforeunload",
        gate.beforeUnloadListener,
        true,
      );
    } catch {
      this.restorePopoutCloseWrapper(gate);
      return null;
    }
    return gate;
  }

  restorePopoutCloseWrapper(gate) {
    if (gate.root.close !== gate.closeWrapper) return;
    try {
      if (gate.ownCloseDescriptor) {
        Object.defineProperty(gate.root, "close", gate.ownCloseDescriptor);
      } else {
        delete gate.root.close;
      }
    } catch {
      // Keep an inactive shim if another SDK wrapper made restoration unsafe.
    }
  }

  disposePopoutCloseGate(gate) {
    if (!gate?.active) return;
    gate.active = false;
    try {
      gate.ownerWindow.removeEventListener(
        "beforeunload",
        gate.beforeUnloadListener,
        true,
      );
    } catch {
      // A closing WindowProxy may already reject listener operations.
    }
    this.restorePopoutCloseWrapper(gate);
    if (this.popoutCloseGates.get(gate.ownerWindow) === gate) {
      this.popoutCloseGates.delete(gate.ownerWindow);
    }
    for (const view of gate.views) {
      if (view.popoutCloseGate === gate) view.popoutCloseGate = null;
    }
    gate.views.clear();
  }

  popoutViewsForGate(gate) {
    return [...this.views].filter(
      (view) =>
        view.getOwnerWindow() === gate.ownerWindow &&
        findPopoutSplit(view.leaf, gate.ownerWindow, this.app.workspace) ===
          gate.root,
    );
  }

  isPopoutQuitInProgress(ownerWindow) {
    if (this.isQuitting || this.isUnloading) return true;
    try {
      return Boolean(
        ownerWindow?.electron?.ipcRenderer?.sendSync?.("is-quitting"),
      );
    } catch {
      return false;
    }
  }

  handlePopoutBeforeUnload(gate, event) {
    if (
      !gate.active ||
      gate.allowClose ||
      this.isPopoutQuitInProgress(gate.ownerWindow)
    ) {
      return;
    }
    if (
      !gate.closePromise &&
      this.popoutViewsForGate(gate).length === 0
    ) {
      this.disposePopoutCloseGate(gate);
      return;
    }
    event?.preventDefault?.();
    event?.stopImmediatePropagation?.();
    // The SDK beforeunload hook cannot await this operation. requestPopoutClose
    // reports close failures with a Notice, so consume both async and sync
    // close errors here.
    try {
      void Promise.resolve(
        this.requestPopoutClose(gate, gate.root, []),
      ).catch(() => {});
    } catch {
      // The failure Notice was already shown by requestPopoutClose.
    }
  }

  invokeOriginalPopoutClose(gate, receiver, args) {
    const wasAllowed = gate.allowClose;
    gate.allowClose = true;
    let result;
    try {
      result = gate.originalClose.apply(receiver, args);
    } catch (error) {
      const committed =
        gate.root.win !== gate.ownerWindow || gate.ownerWindow.closed;
      gate.closeCommitted ||= committed;
      gate.allowClose = committed ? true : wasAllowed;
      throw error;
    }

    const committed =
      gate.root.win !== gate.ownerWindow || gate.ownerWindow.closed;
    gate.closeCommitted ||= committed;
    // Obsidian may dispatch the Window's beforeunload after close() returns.
    // Keep the gate open once SDK destroyWindow has detached this WindowProxy;
    // otherwise the late event can be blocked after root.win has been nulled.
    gate.allowClose = committed ? true : wasAllowed;
    return { result, committed };
  }

  cancelPopoutPreparations(snapshots) {
    for (const { view, documentId, openRequest } of snapshots) {
      view.cancelPreparedClose(documentId, openRequest);
    }
  }

  reportPopoutCloseFailure(error = null) {
    const detail = error?.message ? `：${error.message}` : "";
    new Notice(`无法关闭 PDF 弹出窗口${detail}`, 8000);
  }

  requestPopoutClose(gate, receiver, args) {
    const originalClose = () => gate.originalClose.apply(receiver, args);
    if (
      !gate.active ||
      receiver !== gate.root ||
      this.isPopoutQuitInProgress(gate.ownerWindow)
    ) {
      return originalClose();
    }
    if (gate.allowClose) return originalClose();
    if (gate.closePromise) return gate.closePromise;

    const views = this.popoutViewsForGate(gate);
    if (views.length === 0) {
      try {
        return this.invokeOriginalPopoutClose(gate, receiver, args).result;
      } finally {
        if (
          gate.active &&
          !gate.closePromise &&
          this.popoutViewsForGate(gate).length === 0
        ) {
          this.disposePopoutCloseGate(gate);
        }
      }
    }
    const snapshots = views.map((view) => ({
      view,
      documentId: view.documentId,
      openRequest: view.openRequest,
    }));
    const allAlreadyPrepared = snapshots.every(
      ({ view, documentId, openRequest }) =>
        view.documentId === documentId &&
        view.openRequest === openRequest &&
        view.hasPreparedClose(documentId, openRequest),
    );
    if (allAlreadyPrepared) {
      try {
        const { result, committed } = this.invokeOriginalPopoutClose(
          gate,
          receiver,
          args,
        );
        if (committed) return result;
        this.cancelPopoutPreparations(snapshots);
        this.reportPopoutCloseFailure();
        return false;
      } catch (error) {
        const committed =
          gate.root.win !== gate.ownerWindow || gate.ownerWindow.closed;
        if (!committed) this.cancelPopoutPreparations(snapshots);
        this.reportPopoutCloseFailure(error);
        throw error;
      }
    }

    const pending = (async () => {
      const results = await Promise.all(
        snapshots.map(async (snapshot) => {
          if (
            snapshot.view.teardownStarted &&
            !snapshot.view.hasPreparedClose(
              snapshot.documentId,
              snapshot.openRequest,
            )
          ) {
            return { ...snapshot, ok: false, blockedByTeardown: true };
          }
          try {
            const ok = await snapshot.view.prepareControlledClose("detach");
            return {
              ...snapshot,
              ok:
                ok &&
                snapshot.view.hasPreparedClose(
                  snapshot.documentId,
                  snapshot.openRequest,
                ),
            };
          } catch {
            return { ...snapshot, ok: false };
          }
        }),
      );
      const currentViews = this.popoutViewsForGate(gate);
      const identitiesUnchanged =
        currentViews.length === snapshots.length &&
        snapshots.every(
          ({ view, documentId, openRequest }) =>
            currentViews.includes(view) &&
            view.ownerWindow === gate.ownerWindow &&
            view.documentId === documentId &&
            view.openRequest === openRequest,
        ) &&
        gate.root.win === gate.ownerWindow;
      const prepared =
        gate.active && identitiesUnchanged && results.every((result) => result.ok);

      if (!prepared) {
        for (const result of results) {
          if (result.ok) {
            result.view.cancelPreparedClose(
              result.documentId,
              result.openRequest,
            );
          }
        }
        if (
          gate.active &&
          (results.every((result) => result.ok) ||
            results.some((result) => result.blockedByTeardown))
        ) {
          new Notice(
            "弹出窗口中的 PDF 阅读器发生变化或未能确认保存；窗口保持打开，请重试。",
            8000,
          );
        }
        return false;
      }

      try {
        const { result, committed } = this.invokeOriginalPopoutClose(
          gate,
          gate.root,
          args,
        );
        if (committed) return result;
        this.cancelPopoutPreparations(snapshots);
        this.reportPopoutCloseFailure();
        return false;
      } catch (error) {
        const committed =
          gate.root.win !== gate.ownerWindow || gate.ownerWindow.closed;
        if (!committed) {
          this.cancelPopoutPreparations(snapshots);
          this.reportPopoutCloseFailure(error);
        }
        throw error;
      }
    })().finally(() => {
      if (gate.closePromise === pending) gate.closePromise = null;
      if (gate.active && gate.views.size === 0) {
        this.disposePopoutCloseGate(gate);
      }
    });
    gate.closePromise = pending;
    return pending;
  }

  acquireHeavyLease(view, file, reason, leaseId = null, requestId = null) {
    const context = { file, reason, documentId: view.documentId, openRequest: view.openRequest, rendererGeneration: view.rendererGeneration };
    if (!this.heavyWork) return Promise.resolve({ id: null, release() {} });
    if (leaseId) return Promise.resolve(this.heavyWork.borrow(view, context, leaseId));
    return this.heavyWork.acquire(view, context, {
      requestId,
      valid: () => !this.isUnloading && (view.documentFile || view.file) === file &&
        view.documentId === context.documentId && view.openRequest === context.openRequest &&
        view.rendererGeneration === context.rendererGeneration,
    });
  }

  async setAutoSaveEnabled(enabled) {
    this.settings.autoSave = Boolean(enabled);
    await this.saveData(this.settings);
    for (const view of this.views) {
      view.postToViewer({
        channel: CHANNEL,
        type: "configure-auto-save",
        token: view.token,
        documentId: view.documentId,
        enabled: this.settings.autoSave,
      });
    }
  }

  async setStatusBarEnabled(enabled) {
    this.settings.showStatusBar = Boolean(enabled);
    for (const view of this.views) {
      view.setStatusBarEnabled(this.settings.showStatusBar);
    }
    await this.saveData(this.settings);
  }

  exportMobileDiagnostics() {
    // Repeated taps share one export, not simultaneous full-history reads.
    if (!this.diagnosticsExportPromise) {
      this.diagnosticsExportPromise = this.writeMobileDiagnostics()
        .finally(() => { this.diagnosticsExportPromise = null; });
    }
    return this.diagnosticsExportPromise;
  }

  async writeMobileDiagnostics() {
    const views = [...this.views].slice(0, 16);
    for (const view of this.views) drainViewerRuntimeLog(view);
    let gzipDecompression = false;
    if (typeof globalThis.DecompressionStream === "function") {
      try {
        new globalThis.DecompressionStream("gzip");
        gzipDecompression = true;
      } catch {
        // Some WebViews expose DecompressionStream without the gzip format.
      }
    }
    const pointerSnapshots = await Promise.all(
      views.map((view) => view.requestInputDiagnostics(800)),
    );
    const readers = views.map((view, index) => {
      const runtime = view.mobileRuntime || {};
      const lastError = runtime.lastError;
      return {
        loaderMode: runtime.loaderMode || this.runtimeAdapter.loaderMode,
        stage: MOBILE_STAGE_VALUES.has(runtime.stage) ? runtime.stage : "idle",
        assets: {
          version: typeof runtime.assetVersion === "string" ? runtime.assetVersion : null,
          contentHash: typeof runtime.resourceHash === "string" ? runtime.resourceHash : null,
          resourceCount: clampDiagnosticInteger(runtime.assetCount, 0, 10000),
        },
        modules: {
          pdf: runtime.moduleSources?.pdf || "unknown",
          viewer: runtime.moduleSources?.viewer || "unknown",
        },
        worker: {
          source: runtime.workerSource || "unknown",
          terminated: typeof runtime.workerTerminated === "boolean"
            ? runtime.workerTerminated
            : null,
        },
        resourceFailureCount: clampDiagnosticInteger(runtime.resourceFailureCount, 0, 10000) ?? 0,
        revokedResourceCount: clampDiagnosticInteger(runtime.revokedResourceCount, 0, 10000) ?? 0,
        lastError: lastError && {
          stage: MOBILE_STAGE_VALUES.has(lastError.stage) ? lastError.stage : "resource-failed",
          code: safeDiagnosticCode(lastError.code),
        },
        input: pointerSnapshots[index] || null,
        startupTimings: Object.fromEntries(Object.entries({ ...(view.startupTimings || {}), ...(view.startupTimings?.viewer || {}) }).filter(([key, value]) => /Ms$/.test(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)),
        resourcePreparation: this.resourcePreparationMetrics(view.startupTimings?.resources),
      };
    });
    const diagnostic = {
      schema: 1,
      exportedAt: new Date().toISOString(),
      pluginVersion: typeof this.manifest?.version === "string" ? this.manifest.version : null,
      resourcePrewarm: { ...this.resourcePrewarm },
      resourcePreparation: this.resourcePreparationMetrics(this.viewerAssetsResult?.assets?.metrics),
      platform: {
        mobile: this.isMobileRuntime,
        loaderMode: this.runtimeAdapter.loaderMode,
      },
      browser: {
        userAgent: typeof globalThis.navigator?.userAgent === "string"
          ? globalThis.navigator.userAgent.slice(0, 256)
          : null,
        capabilities: {
          blob: typeof globalThis.Blob === "function",
          objectUrl: typeof globalThis.URL?.createObjectURL === "function",
          worker: typeof globalThis.Worker === "function",
          pointerEvents: typeof globalThis.PointerEvent === "function",
          textEncoder: typeof globalThis.TextEncoder === "function",
          decompressionStream: typeof globalThis.DecompressionStream === "function",
          gzipDecompression,
        },
      },
      activeReaderCount: views.length,
      readers,
    };
    const folderPath = MOBILE_DIAGNOSTICS_DIRECTORY;
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }
    const timestamp = diagnostic.exportedAt.replace(/[:.]/g, "-");
    const outputPath = normalizePath(
      `${folderPath}/PDF Reader diagnostics ${timestamp} ${makeToken().slice(0, 8)}.json`,
    );
    const writeText = (path, text) => this.app.vault.createBinary(path, new TextEncoder().encode(text).buffer);
    // Diagnostic replies may generate more Viewer records while awaited.
    for (const view of this.views) drainViewerRuntimeLog(view);
    const exported = await this.sessionLog.exportDiagnostic(diagnostic, outputPath, writeText);
    new Notice(`已导出 PDF 阅读器诊断和运行日志（${exported.recordCount} 条${exported.complete ? "" : "，含缺失标记"}）：${outputPath}`);
    return outputPath;
  }

  async listRecoveryCandidates() {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.recoveryDirectory))) return [];
    const listing = await adapter.list(this.recoveryDirectory);
    const candidates = [];
    const validStorage = (value, id) => Boolean(
      value && value.candidateId === id && value.completed === true &&
      ((value.schema === 1 && value.candidateFile === `${id}.pdf`) ||
        (value.schema === 2 && value.storage === "pdf-prefix-delta" &&
          value.candidateFile === `${id}.delta`)),
    );
    const hasVerifiedOutput = (value) => isSupportedFingerprint(value?.outputHash) &&
      Number.isSafeInteger(value?.outputLength) && value.outputLength > 0;
    const requiresVerifiedOutput = (value) => value?.schema === 2 ||
      value?.reason === "close-writeback" || value?.closeWriteback !== undefined;
    const metadataIsListable = (value, id) => Boolean(
      validStorage(value, id) &&
      (!requiresVerifiedOutput(value) || hasVerifiedOutput(value)) &&
      ["pending", "conflict", "failed", "draft"].includes(value.status),
    );
    const isSavedTombstone = (value, id) => Boolean(
      validStorage(value, id) && value.status === "saved" &&
      hasVerifiedOutput(value),
    );
    const primaryIds = new Set();
    for (const metadataPath of listing.files.filter((filePath) => filePath.endsWith(".json"))) {
      const idFromPath = metadataPath.slice(metadataPath.lastIndexOf("/") + 1, -5);
      primaryIds.add(idFromPath);
      try {
        let metadata;
        try {
          metadata = JSON.parse(await adapter.read(metadataPath));
        } catch {
          metadata = null;
        }
        if (isSavedTombstone(metadata, idFromPath)) continue;
        if (!metadataIsListable(metadata, idFromPath)) {
          // A close-job status update can fail while replacing its JSON. The
          // immutable raw descriptor was verified before intent attachment,
          // so keep the exact recovery PDF listable even if that mutable file
          // is torn, unreadable, or otherwise no longer a complete candidate.
          if (!/^[a-zA-Z0-9_-]+$/.test(idFromPath)) throw new Error("恢复副本元数据无效");
          const rawMetadataPath = `${this.recoveryDirectory}/${idFromPath}.rawmeta`;
          const fallback = JSON.parse(await adapter.read(rawMetadataPath));
          if (!metadataIsListable(fallback, idFromPath)) throw new Error("恢复保护元数据无效");
          metadata = fallback;
        }
        const safeId = metadata.candidateId?.replace(/[^a-zA-Z0-9_-]/g, "");
        if (!safeId) continue;
        const isDelta = metadata.schema === 2 && metadata.storage === "pdf-prefix-delta";
        const candidatePath = `${this.recoveryDirectory}/${safeId}.${isDelta ? "delta" : "pdf"}`;
        if (!(await adapter.exists(candidatePath))) continue;
        candidates.push({ metadata, candidatePath, metadataPath });
      } catch {
        // Ignore incomplete/corrupt metadata; the remaining candidates stay intact.
      }
    }
    // A provider may lose the mutable primary descriptor while retaining the
    // independently written immutable raw descriptor and candidate bytes.
    // Reconstruct those raw-only candidates, while primary tombstones above
    // remain authoritative for completed cleanup.
    for (const rawMetadataPath of listing.files.filter((filePath) => filePath.endsWith(".rawmeta"))) {
      const idFromPath = rawMetadataPath.slice(rawMetadataPath.lastIndexOf("/") + 1, -".rawmeta".length);
      if (primaryIds.has(idFromPath) || !/^[a-zA-Z0-9_-]+$/.test(idFromPath)) continue;
      try {
        const metadata = JSON.parse(await adapter.read(rawMetadataPath));
        if (!metadataIsListable(metadata, idFromPath)) continue;
        const isDelta = metadata.schema === 2 && metadata.storage === "pdf-prefix-delta";
        const candidatePath = `${this.recoveryDirectory}/${idFromPath}.${isDelta ? "delta" : "pdf"}`;
        if (!(await adapter.exists(candidatePath))) continue;
        candidates.push({
          metadata,
          candidatePath,
          metadataPath: `${this.recoveryDirectory}/${idFromPath}.json`,
        });
      } catch {
        // Leave malformed sidecars and their bytes untouched for inspection.
      }
    }
    return candidates.sort((left, right) =>
      String(right.metadata.updatedAt || right.metadata.createdAt || "").localeCompare(
        String(left.metadata.updatedAt || left.metadata.createdAt || ""),
      ),
    );
  }

  async restoreLatestRecovery() {
    const candidates = await this.listRecoveryCandidates();
    if (candidates.length === 0) {
      new Notice("没有可恢复的 PDF 自动保存副本。");
      return null;
    }
    let candidate, bytes;
    for (const item of candidates) {
      try { bytes = await this.readRecoveryBytes(item); candidate = item; break; }
      catch { /* Preserve corrupt/new records and try an older intact branch. */ }
    }
    if (!candidate) throw new Error("恢复副本校验未通过；原记录已保留，请导出诊断。");
    const originalName = safeFileName(candidate.metadata.filename || candidate.metadata.originalPath);
    const baseName = originalName.replace(/\.pdf$/i, "") || "recovered";
    const date = new Date(candidate.metadata.createdAt || Date.now())
      .toISOString()
      .replace(/[:.]/g, "-");
    const folderPath = "PDF Recovery";
    if (!this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }
    let outputPath = normalizePath(`${folderPath}/${baseName} (Recovered ${date}).pdf`);
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(outputPath)) {
      outputPath = normalizePath(
        `${folderPath}/${baseName} (Recovered ${date} ${suffix}).pdf`,
      );
      suffix += 1;
    }
    await this.app.vault.createBinary(outputPath, bytes);
    new Notice(`已创建恢复副本：${outputPath}`);
    return outputPath;
  }

  async readRecoveryBytes(candidate) {
    const adapter = this.app.vault.adapter;
    const bytes = candidate.metadata.storage === "pdf-prefix-delta"
        ? await readDeltaRecovery(adapter, this.recoveryDirectory, candidate, this.pdfHashRuntime)
      : await adapter.readBinary(candidate.candidatePath);
    if (candidate.metadata.outputHash && (bytes.byteLength !== candidate.metadata.outputLength ||
      !fingerprintMatches(bytes, candidate.metadata.outputHash))) throw new Error("恢复 PDF 完整性校验失败");
    return bytes instanceof Uint8Array ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
  }

  resourcePreparationMetrics(metrics) {
    return Object.fromEntries([
      "checkedFiles", "verificationReads", "statChecks", "statCacheFiles",
      "decodedFiles", "repairedFiles", "decodedBytes", "bytesWritten", "elapsedMs",
    ].filter((key) => typeof metrics?.[key] === "number" &&
      Number.isFinite(metrics[key]) && metrics[key] >= 0)
      .map((key) => [key, metrics[key]]));
  }

  scheduleViewerPrewarm(reason, delay = 0) {
    if (this.isUnloading || !VIEWER_ASSET_PAYLOAD || this.prewarmPromise) return;
    if (this.resourcePrewarm?.status === "ready" &&
      this.viewerAssetsResult?.adapter === this.app.vault.adapter &&
      this.viewerAssetsResult?.contentHash === VIEWER_ASSET_PAYLOAD.contentHash) return;
    if (this.prewarmTimer != null) {
      if (delay > 0) return;
      globalThis.clearTimeout(this.prewarmTimer);
    }
    if (reason !== "retry" && this.resourcePrewarm?.status === "failed") {
      this.resourcePrewarm.attempts = 0;
    }
    this.resourcePrewarm.status = "scheduled";
    this.prewarmTimer = globalThis.setTimeout(() => {
      this.prewarmTimer = null;
      void this.prewarmViewerAssets(reason);
    }, delay);
  }

  prewarmViewerAssets(reason = "plugin-load") {
    if (this.isUnloading || !VIEWER_ASSET_PAYLOAD) return Promise.resolve(null);
    if (this.prewarmPromise) return this.prewarmPromise;
    const started = Date.now();
    this.resourcePrewarm.status = "running";
    this.resourcePrewarm.reason = ["plugin-load", "layout-ready", "foreground", "retry"]
      .includes(reason) ? reason : "requested";
    this.resourcePrewarm.attempts += 1;
    const pending = Promise.resolve().then(async () => {
      const assets = await this.ensureViewerAssets();
      if (this.isUnloading) return null;
      await Promise.all(["web/viewer.html", "web/viewer.css", "web/bridge.css"]
        .map((relativePath) => this.readVerifiedAssetText(relativePath)));
      if (this.isMobileRuntime && !this.isUnloading) {
        await Promise.all(Object.values(MOBILE_RESOURCE_SCRIPT_PATHS)
          .map((relativePath) => this.readVerifiedAsset(relativePath)));
      }
      if (!this.isUnloading) {
        this.resourcePrewarm.status = "ready";
        this.resourcePrewarm.lastErrorCode = null;
      }
      return assets;
    }).catch((error) => {
      if (!this.isUnloading) {
        this.resourcePrewarm.status = "failed";
        this.resourcePrewarm.lastErrorCode = safeDiagnosticCode(
          error?.diagnosticCode || "asset-prewarm-failed",
        );
      }
      return null;
    }).finally(() => {
      if (this.prewarmPromise !== pending) return;
      this.prewarmPromise = null;
      this.resourcePrewarm.durationMs = Date.now() - started;
      if (!this.isUnloading && this.resourcePrewarm.status === "failed") {
        if (this.resourcePrewarm.attempts < 3) {
          this.scheduleViewerPrewarm("retry", this.resourcePrewarm.attempts * 1000);
        } else {
          new Notice("PDF 阅读器后台预热未完成；打开 PDF 时会重试。可导出诊断查看启动状态。");
        }
      }
    });
    this.prewarmPromise = pending;
    return pending;
  }

  ensureViewerAssets({ forceVerify = false } = {}) {
    const pluginRoot = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    const adapter = this.app.vault.adapter;
    const result = this.viewerAssetsResult;
    if (!forceVerify && result && result.adapter === adapter && result.pluginRoot === pluginRoot && result.contentHash === VIEWER_ASSET_PAYLOAD?.contentHash) {
      return Promise.resolve({ ...result.assets, metrics: {
        ...result.assets.metrics, cacheHit: true, checkedFiles: 0,
        verificationReads: 0, statChecks: 0, statCacheFiles: 0,
        decodedFiles: 0, repairedFiles: 0, decodedBytes: 0,
        bytesWritten: 0, elapsedMs: 0,
      } });
    }
    if (forceVerify && this.viewerAssetsPromise) {
      return this.viewerAssetsPromise.catch(() => {}).then(() =>
        this.ensureViewerAssets({ forceVerify: true }),
      );
    }
    if (forceVerify) this.invalidateViewerAssets();
    if (!this.viewerAssetsPromise) {
      const pending = Promise.resolve()
        .then(() =>
          ensureViewerAssets(
            adapter,
            pluginRoot,
            VIEWER_ASSET_PAYLOAD,
            { forceVerify },
          ),
        )
        .then((assets) => {
          if (!this.isUnloading) this.viewerAssetsResult = { adapter, pluginRoot, contentHash: VIEWER_ASSET_PAYLOAD?.contentHash, assets };
          return assets;
        }, (error) => { this.invalidateViewerAssets(); throw error; })
        .finally(() => {
          if (this.viewerAssetsPromise === pending) {
            this.viewerAssetsPromise = null;
          }
        });
      this.viewerAssetsPromise = pending;
    }
    return this.viewerAssetsPromise;
  }

  invalidateViewerAssets() {
    this.viewerAssetsResult = null;
    this.verifiedAssetBytes?.clear();
    this.verifiedAssetTexts?.clear();
  }

  async readVerifiedAsset(relativePath) {
    if (this.verifiedAssetBytes.has(relativePath)) return this.verifiedAssetBytes.get(relativePath);
    const pending = (async () => {
      const entry = VIEWER_ASSET_PAYLOAD?.files?.find((file) => file.path === relativePath);
      if (!entry) throw new Error(`Missing bundled resource: ${relativePath}`);
      const assets = await this.ensureViewerAssets();
      const path = `${assets.rootPath}/${relativePath}`;
      let raw;
      try { raw = await this.app.vault.adapter.readBinary(path); }
      catch { raw = new TextEncoder().encode(await this.app.vault.adapter.read(path)); }
      const bytes = new Uint8Array(toArrayBuffer(raw));
      if (bytes.length !== entry.size || sha256Bytes(bytes) !== entry.sha256) throw new Error(`Resource verification failed: ${relativePath}`);
      return bytes;
    })().catch((error) => { this.invalidateViewerAssets(); throw error; });
    this.verifiedAssetBytes.set(relativePath, pending);
    return pending;
  }

  getLegacyMergeClient() {
    if (!this.legacyMergeClient) {
      this.legacyMergeClient = createPdfMergeClient({
        loadWorkerSource: async () => {
          const assets = await this.ensureViewerAssets();
          const bytes = await this.readVerifiedAsset("web/pdf-merge-worker.js");
          return {
            bytes,
            sha256: sha256Bytes(bytes),
            url: this.app.vault.adapter.getResourcePath(`${assets.rootPath}/web/pdf-merge-worker.js`),
          };
        },
        WorkerClass: globalThis.Worker,
        URLApi: globalThis.URL,
        BlobClass: globalThis.Blob,
        onTaskTiming: (timing) => {
          if (timing?.method !== "inspect") return;
          this.sessionLog?.record("legacyAnnotationMigration", timing);
        },
      });
    }
    return this.legacyMergeClient;
  }

  async readVerifiedAssetText(relativePath) {
    if (!this.verifiedAssetTexts.has(relativePath)) {
      this.verifiedAssetTexts.set(relativePath, this.readVerifiedAsset(relativePath).then((bytes) => new TextDecoder().decode(bytes)));
    }
    return this.verifiedAssetTexts.get(relativePath);
  }

  async openPdf(file) {
    if (!isPdfFile(file)) {
      new Notice("请选择一个 PDF 文件。");
      return;
    }
    const existingLeaf = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .find(
        (leaf) =>
          leaf.view instanceof PdfReaderView &&
          (leaf.view.requestedPath === file.path ||
            leaf.view.file?.path === file.path),
      );
    if (existingLeaf) {
      await existingLeaf.setViewState({
        type: VIEW_TYPE,
        active: true,
        state: existingLeaf.view.getState(),
      });
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: { path: file.path },
    });
  }
};

traceMethods(PdfReaderView.prototype, "PdfReaderView", view => view.plugin?.sessionLog);
traceMethods(PdfWebReaderSettingTab.prototype, "PdfWebReaderSettingTab", tab => tab.plugin?.sessionLog);
traceMethods(module.exports.prototype, "PdfWebReaderPlugin", plugin => {
  if (!plugin.sessionLog) {
    plugin.sessionLog = createSessionLog({
      adapter: plugin.app.vault.adapter,
      directory: `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}/.logs`,
      version: plugin.manifest.version,
    });
    activeSessionLog = plugin.sessionLog;
    void plugin.sessionLog.flush();
    plugin.sessionLog.observe(globalThis.window, "host", event =>
      [...(plugin.views || [])].some(view => view.containerEl?.contains?.(event.target)));
  }
  return plugin.sessionLog;
});
/* BUILD:HOST_FUNCTION_TRACE */
