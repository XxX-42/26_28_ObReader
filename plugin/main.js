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
/* BUILD:VOCABULARY_SERVICE_REQUIRE */ const { VocabularyService, normalizeTermKey: normalizeVocabularyTermKey, VOCABULARY_PATH } = require('./vocabulary/service.cjs');
/* BUILD:VOCABULARY_CANONICAL_REQUIRE */ const { canonicalHash } = require('./vocabulary/canonical.cjs');
/* BUILD:VOCABULARY_WORKSPACE_REQUIRE */ const { createVocabularyRuntime, localVocabularyDeviceId, createContextSourceVerifier, createVocabularyTransfer } = require('./vocabulary/workspace.cjs');
/* BUILD:VOCABULARY_WORKBENCH_REQUIRE */ const { createVocabularyWorkbench } = require('./vocabulary/workbench.cjs');
/* BUILD:LEARNING_HOST_REQUIRE */ const { createLearningHost } = require('./learning/host.cjs');
/* BUILD:SEMANTIC_SERVICES_REQUIRE */ const { createAnnotationSidebarService, createBacklinkService } = require('./semantic/services.cjs');
/* BUILD:VOCABULARY_DICTIONARY_REQUIRE */ const { VocabularyDictionary } = require('./vocabulary/dictionary.cjs');
/* BUILD:HEAVY_WORK_REQUIRE */ const { createHeavyWorkCoordinator } = require('./heavy-work.cjs');
/* BUILD:PDF_RECOVERY_REQUIRE */ const { readDeltaRecovery } = require('./pdf-recovery-read.cjs');
/* BUILD:READER_ANCHOR_STORE_REQUIRE */ const { createReaderAnchorStore, parseReaderLinkFragment, parseReaderLinkDestination, encodeReaderLinkFragment } = require('./reader-anchor-store.cjs');
/* BUILD:READER_BACKLINK_INDEX_REQUIRE */ const { buildReaderBacklinkPageIndex, createReaderBacklinkIndex, normalizePdfRoutePath } = require('./reader-backlink-index.cjs');
/* BUILD:VIEWER_ASSET_PAYLOAD */ const VIEWER_ASSET_PAYLOAD = null;

const VIEW_TYPE = "pdf-web-reader-view";
const CHANNEL = "pdf-web-reader";
const VOCABULARY_DICTIONARY_ROOT = "00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v2";
const VOCABULARY_DICTIONARY_MANIFEST = `${VOCABULARY_DICTIONARY_ROOT}/manifest.json`;
const MAX_VOCABULARY_QUERY_TEXT_CHARS = 131072;
const DEFAULT_VOCABULARY_HIGHLIGHT_LEVELS = Object.freeze({
  words: Object.freeze([1, 2, 3, 4, 5]),
  phrases: Object.freeze([1, 2, 3, 4, 5]),
});
const VOCABULARY_DISPLAY_MODES = Object.freeze(["all", "learning", "focus"]);
const VOCABULARY_DISPLAY_LABELS = Object.freeze({
  all: "全部等级", learning: "学习中（1–4级）", focus: "重点（1–3级）",
});
const PERSISTABLE_ANNOTATION_TOOL_MODES = new Set([3, 5, 9, 10, 15]);
const MAX_VOCABULARY_SURFACE_CHARS = 1600;
const MAX_LINE_HYPHEN_EVIDENCE = 64;
const MAX_LINE_HYPHEN_SEGMENT_INDEX = 255;
const MAX_LINE_HYPHEN_SOURCE_OFFSET = 50000;
const VOCABULARY_LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;
const VOCABULARY_LETTER = /^\p{L}$/u;
const VOCABULARY_LINE_HYPHEN = /^[-\u2010]$/u;

function isValidEditorPosition(position) {
  return Number.isSafeInteger(position?.line) && position.line >= 0 &&
    Number.isSafeInteger(position?.ch) && position.ch >= 0;
}

function copyEditorPosition(position) {
  return isValidEditorPosition(position) ? { line: position.line, ch: position.ch } : null;
}

function sameEditorPosition(left, right) {
  return isValidEditorPosition(left) && isValidEditorPosition(right) &&
    left.line === right.line && left.ch === right.ch;
}

function vocabularyCodePointBefore(value, offset) {
  if (offset <= 0 || offset > value.length) return "";
  const last = value.charCodeAt(offset - 1);
  if (last >= 0xdc00 && last <= 0xdfff && offset > 1) {
    const previous = value.charCodeAt(offset - 2);
    if (previous >= 0xd800 && previous <= 0xdbff) return value.slice(offset - 2, offset);
  }
  return value.slice(offset - 1, offset);
}

function vocabularyHasLetterBefore(value, offset) {
  let cursor = offset;
  while (cursor > 0) {
    const previous = vocabularyCodePointBefore(value, cursor);
    cursor -= previous.length;
    if (VOCABULARY_LETTER.test(previous)) return true;
    if (!/^\p{M}$/u.test(previous)) return false;
  }
  return false;
}

function validateVocabularySurface(message) {
  const rawSurface = message?.rawSurface;
  const logicalSurface = message?.logicalSurface === undefined
    ? rawSurface
    : message.logicalSurface;
  if (typeof rawSurface !== "string" || rawSurface.length < 1 ||
      rawSurface.length > MAX_VOCABULARY_SURFACE_CHARS ||
      typeof logicalSurface !== "string" || logicalSurface.length < 1 ||
      logicalSurface.length > MAX_VOCABULARY_SURFACE_CHARS) return null;

  const evidence = message.lineHyphenEvidence === undefined ? [] : message.lineHyphenEvidence;
  if (!Array.isArray(evidence) || evidence.length > MAX_LINE_HYPHEN_EVIDENCE) return null;
  let previousOffset = -1;
  const offsets = [];
  for (const proof of evidence) {
    const offset = proof?.offset;
    const left = proof?.left;
    const hyphen = proof?.hyphen;
    const right = proof?.right;
    if (!Number.isSafeInteger(offset) || offset <= previousOffset || offset < 1 ||
        offset + 1 >= rawSurface.length || !left || !hyphen || !right) return null;
    const rawHyphen = rawSurface.slice(offset, offset + 1);
    const before = vocabularyCodePointBefore(rawSurface, offset);
    const afterCodePoint = rawSurface.codePointAt(offset + 1);
    const after = Number.isInteger(afterCodePoint) ? String.fromCodePoint(afterCodePoint) : "";
    if (!VOCABULARY_LINE_HYPHEN.test(rawHyphen) ||
        !VOCABULARY_LETTER_OR_MARK.test(before) || !vocabularyHasLetterBefore(rawSurface, offset) ||
        !VOCABULARY_LETTER.test(after) ||
        left.text !== before || hyphen.text !== rawHyphen || right.text !== after) return null;

    for (const endpoint of [left, hyphen, right]) {
      if (!Number.isSafeInteger(endpoint.segmentIndex) || endpoint.segmentIndex < 0 ||
          endpoint.segmentIndex > MAX_LINE_HYPHEN_SEGMENT_INDEX ||
          !Number.isSafeInteger(endpoint.sourceOffset) || endpoint.sourceOffset < 0 ||
          endpoint.sourceOffset > MAX_LINE_HYPHEN_SOURCE_OFFSET ||
          typeof endpoint.text !== "string" || endpoint.text.length < 1 || endpoint.text.length > 2) return null;
    }
    if (left.segmentIndex > hyphen.segmentIndex || hyphen.segmentIndex > right.segmentIndex ||
        right.segmentIndex - left.segmentIndex > MAX_LINE_HYPHEN_EVIDENCE) return null;
    if (hyphen.segmentIndex - left.segmentIndex > 1) return null;
    if (left.segmentIndex === hyphen.segmentIndex &&
        left.sourceOffset + left.text.length !== hyphen.sourceOffset) return null;
    if (hyphen.segmentIndex === right.segmentIndex &&
        hyphen.sourceOffset + hyphen.text.length > right.sourceOffset) return null;

    offsets.push(offset);
    previousOffset = offset;
  }

  let reconstructedSurface = rawSurface;
  for (let index = offsets.length - 1; index >= 0; index -= 1) {
    const offset = offsets[index];
    reconstructedSurface = reconstructedSurface.slice(0, offset) + reconstructedSurface.slice(offset + 1);
  }
  if (reconstructedSurface !== logicalSurface ||
      normalizeVocabularyTermKey(logicalSurface) !== message.key) return null;
  return logicalSurface;
}

function normalizeVocabularyDisplayMode(value) {
  return VOCABULARY_DISPLAY_MODES.includes(value) ? value : "all";
}

function normalizeAnnotationToolMode(value) {
  return Number.isInteger(value) && PERSISTABLE_ANNOTATION_TOOL_MODES.has(value) ? value : 0;
}

function normalizeVocabularyHighlightLevels(value) {
  const normalize = (items) => Array.isArray(items)
    ? [...new Set(items.filter((item) => Number.isInteger(item) && item >= 1 && item <= 5))].sort((a, b) => a - b)
    : [...DEFAULT_VOCABULARY_HIGHLIGHT_LEVELS.words];
  return {
    words: normalize(value?.words),
    phrases: normalize(value?.phrases),
  };
}

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

function vocabularyDictionaryPercent(status) {
  if (Number.isFinite(status?.percent)) {
    return Math.min(100, Math.max(0, Math.floor(status.percent)));
  }
  const count = Number.isFinite(status?.count) ? Math.max(0, status.count) : 0;
  const total = Number.isFinite(status?.total) ? Math.max(0, status.total) : 0;
  return total > 0 ? Math.min(100, Math.floor((count / total) * 100)) : 0;
}

function vocabularyDictionaryStatusText(status) {
  switch (status?.phase) {
    case "verifying": return `正在校验词典 · ${vocabularyDictionaryPercent(status)}%`;
    case "building": return `正在建立词典缓存 · ${vocabularyDictionaryPercent(status)}%`;
    case "waiting": return `等待缓存任务 · ${vocabularyDictionaryPercent(status)}%`;
    case "ready": return `词典缓存已就绪 · ${(Number(status.count) || 0).toLocaleString("zh-CN")} 条`;
    case "unavailable": return "本地词典暂不可用";
    default: return "词典缓存尚未初始化";
  }
}

function applyVocabularyDictionaryStatus(plugin, status) {
  plugin.vocabularyDictionaryStatus = status && typeof status === "object"
    ? { ...status }
    : { phase: "idle", count: 0, total: 0 };
  plugin.readerSettingsTab?.vocabularyDictionaryStatusSetting?.setName?.(
    vocabularyDictionaryStatusText(plugin.vocabularyDictionaryStatus),
  );
  if (plugin.settings?.vocabularyEnabled !== true) return;
  const phase = String(plugin.vocabularyDictionaryStatus.phase || "idle");
  const percent = Math.floor(vocabularyDictionaryPercent(plugin.vocabularyDictionaryStatus) / 10) * 10;
  const signature = `${phase}:${percent}`;
  if (phase === "idle" || signature === plugin.vocabularyDictionaryLastLogSignature) return;
  plugin.vocabularyDictionaryLastLogSignature = signature;
  plugin.sessionLog?.record("vocabularyDictionary", { event: "cache-progress", phase, percent });
}

function isVocabularyDictionaryResourcePath(value) {
  if (typeof value !== "string") return false;
  const filePath = normalizePath(value);
  if (filePath === VOCABULARY_DICTIONARY_MANIFEST) return true;
  const prefix = `${VOCABULARY_DICTIONARY_ROOT}/entries.`;
  return filePath.startsWith(prefix) && /^[a-f0-9]{64}\.jsonl\.gz$/u.test(filePath.slice(prefix.length));
}

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
      const readerTarget = parseReaderTargetFromViewState(viewState.state);
      const file = resolvePdfFile(
        activePlugin,
        viewState.state?.file ?? viewState.state?.path,
      );
      if (file) {
        routedViewState = {
          ...viewState,
          type: VIEW_TYPE,
          state: { ...viewState.state, file: file.path, path: file.path,
            ...(readerTarget ? { readerTarget } : {}) },
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
        if (currentView.preparedClose?.unconfirmed) {
          currentView.cancelPreparedClose(
            capturedDocumentId,
            capturedOpenRequest,
          );
          currentView.notifyUnflushed();
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

function normalizeReaderTarget(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "selection" && typeof value.id === "string" && value.id.length <= 128) {
    return { kind: "selection", id: value.id, docKey: value.docKey, documentId: value.documentId,
      pageNumber: value.pageNumber, selection: value.selection };
  }
  if (value.kind === "annotation" && typeof value.id === "string" && value.id.length <= 128) {
    return { kind: "annotation", id: value.id, docKey: value.docKey, documentId: value.documentId,
      pageNumber: value.pageNumber };
  }
  if (value.kind === "page" && typeof value.id === "string" && value.id.length <= 512) {
    return { kind: "page", id: value.id, docKey: value.docKey, documentId: value.documentId,
      pageNumber: value.pageNumber };
  }
  if (value.kind === "page-number" && Number.isSafeInteger(value.pageNumber) && value.pageNumber > 0) {
    return { kind: "page-number", pageNumber: value.pageNumber, selection: value.selection || null };
  }
  return null;
}

function parseReaderTargetFromViewState(state) {
  const fragment = state?.subpath ?? state?.fragment ?? state?.hash ?? "";
  const parsed = parseReaderLinkFragment(fragment);
  if (parsed.target) return normalizeReaderTarget({ ...parsed.target, docKey: parsed.docKey,
    documentId: parsed.documentId, pageNumber: parsed.pageNumber, selection: parsed.selection });
  return parsed.pageNumber ? normalizeReaderTarget({ kind: "page-number", pageNumber: parsed.pageNumber,
    selection: parsed.selection }) : null;
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

/* BUILD:VOCABULARY_MODALS_REQUIRE */ const { createVocabularyModals } = require("./vocabulary/modals.cjs");
const { VocabularyEntryModal, VocabularyTransferModal } = createVocabularyModals({ Modal, Notice });
const VocabularyWorkbenchModal = createVocabularyWorkbench({ Modal, Notice });

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
    ...(Number.isSafeInteger(value.editorMode) ? {
      editorMode: clampDiagnosticInteger(value.editorMode, 0, 1024),
    } : {}),
    ...(typeof value.vocabularyEnabled === "boolean" ? {
      vocabularyEnabled: value.vocabularyEnabled,
    } : {}),
    ...(value.annotationTrackingFailure && typeof value.annotationTrackingFailure === "object" ? {
      annotationTrackingFailure: {
        phase: String(value.annotationTrackingFailure.phase || "").slice(0, 100),
        code: String(value.annotationTrackingFailure.code || "").slice(0, 100),
        revision: clampDiagnosticInteger(value.annotationTrackingFailure.revision, 0, Number.MAX_SAFE_INTEGER),
        count: clampDiagnosticInteger(value.annotationTrackingFailure.count, 0, Number.MAX_SAFE_INTEGER),
      },
    } : {}),
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
    this.vocabularyToggle = null;
    this.vocabularyDictionaryStatusSetting = null;
    this.vocabularyDictionaryRebuildButton = null;
    this.vocabularyDictionaryUnsubscribe = null;
    this.isDisplayingVocabularySettings = false;
    this.vocabularyLevelButtons = new Map();
    this.vocabularyDisplayModeButtons = new Map();
  }

  display() {
    const { containerEl } = this;
    this.isDisplayingVocabularySettings = true;
    this.vocabularyDictionaryUnsubscribe?.();
    this.vocabularyDictionaryUnsubscribe = null;
    containerEl.empty();
    this.vocabularyLevelButtons.clear();
    this.vocabularyDisplayModeButtons.clear();
    this.vocabularyDictionaryStatusSetting = null;
    this.vocabularyDictionaryRebuildButton = null;
    const heading = (text) => containerEl.createEl("h3", {
      cls: "pdfWebReaderSettingHeading",
      text,
    });
    heading("阅读器");
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
    heading("LingQ / 词汇学习");
    new Setting(containerEl)
      .setName("启用 LingQ 式本地英语词汇学习")
      .setDesc(`默认关闭。开启后可查询、保存本地英语词汇；数据仅保存在当前 Vault 的 ${VOCABULARY_PATH}，不会随关闭 LingQ 模式而删除，不连接外部 LingQ 服务。`)
      .addToggle((toggle) => {
        this.vocabularyToggle = toggle
          .setValue(this.plugin.settings.vocabularyEnabled)
          .onChange((enabled) => this.plugin.setVocabularyEnabled(enabled));
      });
    this.vocabularyDictionaryStatusSetting = new Setting(containerEl)
      .setName(vocabularyDictionaryStatusText(this.plugin.vocabularyDictionaryStatus))
      .setDesc(`词典资源目录：${VOCABULARY_DICTIONARY_ROOT}/；仅建立本地查询缓存。`)
      .addButton((button) => {
        button.setButtonText("重建缓存");
        button.setTooltip?.("重新校验词典资源并重建本地查询缓存");
        button.setDisabled?.(!this.plugin.settings.vocabularyEnabled);
        button.onClick(() => void this.plugin.rebuildVocabularyDictionaryCache().catch((error) =>
          new Notice(`词典缓存重建失败：${error.message || error}`, 8000)));
        this.vocabularyDictionaryRebuildButton = button;
      });
    this.observeVocabularyDictionary(this.plugin.vocabularyDictionary);
    {
      const setting = new Setting(containerEl)
        .setName("高亮显示模式")
        .setDesc("全部等级、学习中（1–4级）或重点（1–3级）；只改变显示，不修改词库状态。");
      const buttons = new Map();
      for (const mode of VOCABULARY_DISPLAY_MODES) {
        setting.addButton((button) => {
          button.setButtonText(mode === "all" ? "全部" : mode === "learning" ? "学习中" : "重点");
          button.setTooltip?.(VOCABULARY_DISPLAY_LABELS[mode]);
          button.buttonEl?.setAttribute?.("aria-label", VOCABULARY_DISPLAY_LABELS[mode]);
          button.buttonEl?.setAttribute?.("aria-pressed", String(normalizeVocabularyDisplayMode(this.plugin.settings.vocabularyDisplayMode) === mode));
          button.buttonEl?.classList?.toggle("is-active", normalizeVocabularyDisplayMode(this.plugin.settings.vocabularyDisplayMode) === mode);
          button.onClick(() => this.plugin.setVocabularyDisplayMode(mode));
          buttons.set(mode, button);
        });
      }
      this.vocabularyDisplayModeButtons = buttons;
    }
    for (const [type, label, key] of [
      ["word", "单词", "words"],
      ["phrase", "短语", "phrases"],
    ]) {
      const setting = new Setting(containerEl)
        .setName(`${label}高亮等级`)
        .setDesc("选择要在 PDF 中显示的 LingQ 等级；仅控制显示，不改动词库记录。");
      setting.settingEl?.classList?.add("pdfWebReaderVocabularyLevels");
      const buttons = new Map();
      setting.addButton((button) => {
        button.setButtonText(String(1));
        button.setTooltip?.("新词（等级 1）");
        button.buttonEl?.setAttribute?.("aria-label", "新词（等级 1）");
        const active = this.plugin.settings.vocabularyHighlightLevels[key].includes(1);
        button.buttonEl?.setAttribute?.("aria-pressed", String(active));
        button.buttonEl?.classList?.toggle("is-active", active);
        button.onClick(() => {
          const enabled = !this.plugin.settings.vocabularyHighlightLevels[key].includes(1);
          return this.plugin.setVocabularyHighlightLevelEnabled(type, 1, enabled);
        });
        buttons.set(1, button);
      });
      for (const status of [2, 3, 4, 5]) {
        setting.addButton((button) => {
          const labelText = status === 5 ? "✓" : String(status);
          const statusLabel = status === 5 ? "已知（等级 5）" : `等级 ${status}`;
          button.setButtonText(labelText);
          button.setTooltip?.(statusLabel);
          button.buttonEl?.setAttribute?.("aria-label", statusLabel);
          const active = this.plugin.settings.vocabularyHighlightLevels[key].includes(status);
          button.buttonEl?.setAttribute?.("aria-pressed", String(active));
          button.buttonEl?.classList?.toggle("is-active", active);
          button.onClick(() => {
            const enabled = !this.plugin.settings.vocabularyHighlightLevels[key].includes(status);
            return this.plugin.setVocabularyHighlightLevelEnabled(type, status, enabled);
          });
          buttons.set(status, button);
        });
      }
      this.vocabularyLevelButtons.set(type, buttons);
    }
    new Setting(containerEl)
      .setName("词汇学习工作台")
      .setDesc("个人词库、语境生词本、今日复习与可逆历史；JSON 完整备份，CSV 仅词条。")
      .addButton((button) => button
        .setButtonText("打开")
        .onClick(() => this.plugin.openVocabularyWorkbench()));

    heading("批注与数据");
    new Setting(containerEl)
      .setName("PDF 批注")
      .setDesc("批注与词汇数据分开处理。词汇学习开关不会更改 PDF 批注或删除词库内容。");

    heading("诊断 / 高级");
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

  syncVocabularyEnabled(enabled) {
    this.vocabularyToggle?.setValue?.(enabled === true);
    this.vocabularyDictionaryRebuildButton?.setDisabled?.(enabled !== true);
  }

  observeVocabularyDictionary(dictionary) {
    this.vocabularyDictionaryUnsubscribe?.();
    this.vocabularyDictionaryUnsubscribe = null;
    if (typeof dictionary?.subscribe !== "function") {
      applyVocabularyDictionaryStatus(this.plugin, this.plugin.vocabularyDictionaryStatus);
      return false;
    }
    const unsubscribe = dictionary.subscribe((status) => applyVocabularyDictionaryStatus(this.plugin, status));
    this.vocabularyDictionaryUnsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
    return true;
  }

  syncVocabularyDictionaryStatus(status) {
    applyVocabularyDictionaryStatus(this.plugin, status);
  }

  hide() {
    this.vocabularyDictionaryUnsubscribe?.();
    this.vocabularyDictionaryUnsubscribe = null;
    this.isDisplayingVocabularySettings = false;
    this.vocabularyDictionaryStatusSetting = null;
    this.vocabularyDictionaryRebuildButton = null;
    this.vocabularyToggle = null;
  }

  dispose() {
    this.hide();
  }

  syncVocabularyDisplayMode(mode) {
    const selectedMode = normalizeVocabularyDisplayMode(mode);
    for (const [key, button] of this.vocabularyDisplayModeButtons) {
      const active = key === selectedMode;
      button.buttonEl?.setAttribute?.("aria-pressed", String(active));
      button.buttonEl?.classList?.toggle("is-active", active);
    }
  }

  syncVocabularyLevels(levels) {
    for (const [type, key] of [["word", "words"], ["phrase", "phrases"]]) {
      const selected = new Set(levels?.[key] || []);
      for (const [status, button] of this.vocabularyLevelButtons.get(type) || []) {
        const active = selected.has(status);
        button.buttonEl?.setAttribute?.("aria-pressed", String(active));
        button.buttonEl?.classList?.toggle("is-active", active);
      }
    }
  }
}

class ReaderBacklinksModal extends Modal {
  constructor(app, rows, onOpenSource) {
    super(app);
    this.rows = Array.isArray(rows) ? rows : [];
    this.onOpenSource = onOpenSource;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "此页的 Markdown 反向链接" });
    if (!this.rows.length) {
      contentEl.createEl("p", { text: "当前页还没有 Markdown 链接。" });
      return;
    }
    for (const row of this.rows) {
      const button = contentEl.createEl("button", {
        cls: "mod-list-item",
        text: `${row.sourcePath}${row.line != null ? ` · 第 ${row.line + 1} 行` : ""}${row.displayText ? ` — ${row.displayText}` : ""}`,
      });
      if (row.targetStatus === "deleted") button.textContent += " · 目标批注已删除";
      button.addEventListener("click", () => {
        this.onOpenSource?.(row);
        this.close();
      });
    }
  }

  onClose() { this.contentEl.empty(); }
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
    this.pendingVocabularySelections = new Map();
    this.pendingVocabularyEntryLookups = new Map();
    this.vocabularyEntryModal = null;
    this.pendingReaderAnchorCaptures = new Map();
    this.pendingVocabularyContextCaptures = new Map();
    this.pendingReaderTarget = null;
    this.currentPageNumber = 1;
    this.readerTargetApplySequence = 0;
    this.readerTargetApplyKey = null;
    this.readerTargetApplyPromise = null;
    this.readerTargetApplyPendingTarget = null;
    this.readerNavigationRequest = null;
    this.lastReaderNavigationResult = null;
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
      this.pendingReaderTarget = normalizeReaderTarget(normalizedState.readerTarget);
      this.currentPageNumber = Number.isSafeInteger(this.pendingReaderTarget?.pageNumber)
        ? this.pendingReaderTarget.pageNumber : 1;
    }
    await super.setState(normalizedState, result);
    if (this.pendingReaderTarget && this.annotationPageIdentity) void this.applyPendingReaderTarget();
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
    if (wasCurrent) this.cancelVocabularyEntryLookups();
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
    if (wasCurrent) this.cancelVocabularyWork();
    if (wasCurrent) {
      for (const pending of this.pendingReaderAnchorCaptures.values()) globalThis.clearTimeout(pending.timer);
      this.pendingReaderAnchorCaptures.clear();
      this.clearPendingVocabularyContextCaptures();
      this.pendingReaderTarget = null;
      this.readerTargetApplySequence += 1;
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
    this.cancelVocabularyEntryLookups();
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
    this.cancelVocabularyEntryLookups();
    this.readerTargetApplySequence += 1;
    for (const pending of this.pendingReaderAnchorCaptures.values()) globalThis.clearTimeout(pending.timer);
    this.pendingReaderAnchorCaptures.clear();
    this.clearPendingVocabularyContextCaptures();
    this.pendingReaderTarget = null;
    const closingFile = this.documentFile || this.file;
    const closeWasPrepared = this.isPreparedCloseForCurrent();
    if (!closeWasPrepared) {
      const flush = await this.flushDocument(250);
      this.notifyFlushOutcome(flush);
    }
    this.cancelVocabularyWork();
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
    this.annotationPageIdentity = null;
    this.annotationSourceHash = null;
    this.annotationHydrationAllowed = false;
    this.annotationSyncPending = false;
    this.annotationStorageUnavailable = false;
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
      const unconfirmed =
        this.pendingSaves > 0 || this.currentRevision > this.confirmedRevision;
      if (unconfirmed) {
        this.notifyUnflushed();
      }
      this.preparedClose = {
        id: null,
        documentId,
        openRequest,
        revision: this.currentRevision,
        recovered: false,
        unconfirmed,
        iframe: this.iframe,
      };
      return true;
    }
    if (!this.iframe) {
      this.notifyUnflushed();
      this.preparedClose = {
        id: null, documentId, openRequest, revision: this.currentRevision,
        recovered: false, unconfirmed: true, iframe: null,
      };
      return true;
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
    // synchronous and reentrant callers share this exact close preparation.
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
        const identityMatches =
          this.documentId === documentId && this.openRequest === openRequest;
        if (!identityMatches || this.plugin.isUnloading) return false;
        this.notifyUnflushed();
        this.preparedClose = {
          id: request.id, documentId, openRequest,
          revision: this.currentRevision, recovered: false,
          unconfirmed: true, iframe: request.iframe, unloaded: false,
        };
        return true;
      }
      // Best effort only: a silent or failed renderer must never lock a tab.
      // The short budget is not a save-success assertion.
      request.deadline = Date.now() + 250;
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
      if (!prepared) {
        // A response for a different request/session is not evidence that this
        // document was flushed, even if it claims a clean or recovered result.
        this.notifyUnflushed();
        this.sendCancelClose(request);
        // Closing is a user decision, not a persistence veto. Preserve the
        // warning but never pretend an unconfirmed revision was saved.
        if (identityMatches) this.preparedClose = {
          id: request.id, documentId, openRequest,
          revision: this.currentRevision, recovered: false,
          unconfirmed: true, iframe: request.iframe, unloaded: false,
        };
        return true;
      }
      this.notifyFlushOutcome(result);
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
    }).catch(() => {
      request.finish({ ok: false, dirty: true });
      this.notifyUnflushed();
      if (this.documentId === documentId && this.openRequest === openRequest) {
        this.preparedClose = {
          id: request.id, documentId, openRequest, revision: this.currentRevision,
          recovered: false, unconfirmed: true, iframe: request.iframe,
        };
      }
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
      "PDF 已允许关闭，但最新更改尚未确认保存；可能丢失未保存的操作，请检查恢复记录。",
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
    if (flush?.recovered === true) {
      this.notifyRecoveredDraft();
    } else if (!flush?.ok || flush?.dirty) {
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

  async inlineViewerCssImageResources(css) {
    const imagePaths = new Set();
    const imageUrlPattern = /url\(\s*(["']?)(images\/[^)"'\s]+)\1\s*\)/giu;
    for (const match of css.matchAll(imageUrlPattern)) imagePaths.add(match[2]);
    if (!imagePaths.size) return css;

    const mimeTypes = new Map([
      [".gif", "image/gif"],
      [".jpeg", "image/jpeg"],
      [".jpg", "image/jpeg"],
      [".png", "image/png"],
      [".svg", "image/svg+xml;charset=utf-8"],
      [".webp", "image/webp"],
    ]);
    const replacements = new Map();
    await Promise.all([...imagePaths].map(async (imagePath) => {
      const extension = imagePath.slice(imagePath.lastIndexOf(".")).toLowerCase();
      const mimeType = mimeTypes.get(extension);
      if (!mimeType || imagePath.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error(`Unsupported bundled Viewer image: ${imagePath}`);
      }
      const bytes = await this.plugin.readVerifiedAsset(`web/${imagePath}`);
      const encoded = Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
      replacements.set(imagePath, `url("data:${mimeType},${encoded}")`);
    }));

    return css.replace(imageUrlPattern, (original, _quote, imagePath) =>
      replacements.get(imagePath) || original);
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
    const viewerCssWithInlineImages = await this.inlineViewerCssImageResources(viewerCss);
    const viewerUrl = this.app.vault.adapter.getResourcePath(viewerHtmlPath);
    const webBase = new URL("./", viewerUrl).href;
    return this.plugin.runtimeAdapter.createViewerDocument(this, {
      assets, viewerHtml, viewerCss: viewerCssWithInlineImages, bridgeCss, viewerUrl, webBase,
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
      `data-vocabulary-enabled="${this.plugin.settings.vocabularyEnabled === true}" ` +
      `data-vocabulary-highlight-levels="${escapeAttribute(JSON.stringify(this.plugin.settings.vocabularyHighlightLevels))}" ` +
      `data-vocabulary-display-mode="${normalizeVocabularyDisplayMode(this.plugin.settings.vocabularyDisplayMode)}" ` +
      `data-vocabulary-word-display-mode="${this.plugin.settings.vocabularyWordDisplayMode === "roots" ? "roots" : "whole"}" ` +
      `data-renderer-generation="${escapeAttribute(this.rendererGeneration)}"></script>`;
    const baseTag = `<base href="${escapeAttribute(webBase)}">`;
    const injection = `${baseTag}${bridgeScript}`;
    const inlineViewerCss = `<style data-pdf-reader="viewer">${escapeStyleText(viewerCss)}</style>`;
    const inlineBridgeCss = `<style data-pdf-reader="bridge">${escapeStyleText(bridgeCss)}</style>`;
    const inlineThemeCss = this.getObsidianThemeStyle();
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
          return `${inlineViewerCss}${inlineBridgeCss}${inlineThemeCss}`;
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

  getObsidianThemeStyle() {
    const hostWindow = this.ownerWindow || this.containerEl?.ownerDocument?.defaultView || globalThis;
    const hostDocument = hostWindow.document || this.app?.workspace?.containerEl?.ownerDocument;
    if (!hostDocument) return "";
    const getStyle = hostWindow.getComputedStyle?.bind(hostWindow) || globalThis.getComputedStyle;
    if (typeof getStyle !== "function") return "";
    let rootStyle;
    let bodyStyle;
    try {
      rootStyle = getStyle(hostDocument.documentElement);
      bodyStyle = getStyle(hostDocument.body || hostDocument.documentElement);
    } catch { return ""; }
    const names = [
      "background-primary", "background-secondary", "background-modifier-border",
      "text-normal", "text-muted", "text-accent", "text-on-accent",
      "interactive-accent", "interactive-accent-hover",
    ];
    const declarations = [];
    for (const name of names) {
      const value = rootStyle?.getPropertyValue?.(`--${name}`)?.trim() ||
        bodyStyle?.getPropertyValue?.(`--${name}`)?.trim();
      if (value && !/[;{}]/u.test(value)) declarations.push(`--${name}:${value}`);
    }
    return declarations.length
      ? `<style data-pdf-reader="obsidian-theme">:root{${declarations.join(";")}}</style>`
      : "";
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
      const inlineThemeCss = this.getObsidianThemeStyle();
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
        `data-vocabulary-enabled="${this.plugin.settings.vocabularyEnabled === true}" ` +
        `data-vocabulary-highlight-levels="${escapeAttribute(JSON.stringify(this.plugin.settings.vocabularyHighlightLevels))}" ` +
        `data-vocabulary-display-mode="${normalizeVocabularyDisplayMode(this.plugin.settings.vocabularyDisplayMode)}" ` +
        `data-vocabulary-word-display-mode="${this.plugin.settings.vocabularyWordDisplayMode === "roots" ? "roots" : "whole"}" ` +
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
        inlineThemeCss +
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
    this.cancelVocabularyEntryLookups();
    if ((this.documentFile || this.file) !== file || this.requestedPath !== file.path) {
      this.cancelVocabularyWork();
    }
    this.releasePendingOpenAdmission();
    const openingPath = normalizePath(file.path);
    if ((this.documentFile || this.file) !== file || this.requestedPath !== file.path) {
      this.documentId = makeToken();
      this.annotationDocument = null;
      this.annotationPageIdentity = null;
      this.annotationSourceHash = null;
      this.annotationSyncState = null;
      this.annotationHydrationAllowed = false;
      this.annotationSourceMismatch = false;
      this.annotationSyncPending = false;
      this.annotationStorageUnavailable = false;
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
      this.setStatus(this.annotationStorageUnavailable
        ? "外置批注数据无法验证；PDF 已只读打开，批注数据保留且未应用。修复同步数据后重新打开。"
        : this.annotationSyncPending
          ? "批注同步尚未完整到达；PDF 暂以只读模式打开，收到完整同步数据后重新打开。"
          : this.annotationLegacyIdentityUncertain
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

  cancelVocabularyWork() {
    this.cancelVocabularyEntryLookups();
    for (const pending of this.pendingVocabularySelections.values()) {
      globalThis.clearTimeout(pending.timer);
    }
    this.pendingVocabularySelections.clear();
    this.vocabularyEntryModal?.close?.();
    this.vocabularyEntryModal = null;
  }

  clearPendingVocabularyContextCaptures() {
    for (const pending of this.pendingVocabularyContextCaptures.values()) globalThis.clearTimeout(pending.timer);
    this.pendingVocabularyContextCaptures.clear();
  }

  cancelVocabularyEntryLookups() {
    for (const pending of [...(this.pendingVocabularyEntryLookups?.values() || [])]) {
      pending.cancel?.();
    }
    this.pendingVocabularyEntryLookups?.clear?.();
  }

  updatePendingVocabularyEntryPersonalRecord(identity, entryRequestId, key, record) {
    if (!record || !this.pendingVocabularyEntryLookups) return false;
    let updated = false;
    for (const pending of this.pendingVocabularyEntryLookups.values()) {
      if (!pending.active || pending.identity?.documentId !== identity?.documentId ||
          pending.identity?.openRequest !== identity?.openRequest ||
          pending.identity?.rendererGeneration !== identity?.rendererGeneration) continue;
      if (pending.entryRequestId !== entryRequestId && pending.key !== key && pending.personal?.key !== record.key) continue;
      const prior = pending.personal || {};
      pending.updatePersonal?.({
        ...prior,
        ...record,
        key: pending.key,
        storageKey: record.key,
        type: pending.entryType,
        hasPersonalRecord: true,
        translation: record.translation || prior.translation || "",
        phonetic: record.phonetic || prior.phonetic || "",
      });
      pending.personalChanged = true;
      pending.sendProgress?.(pending.lastProgressStatus, true);
      updated = true;
    }
    return updated;
  }

  setVocabularyEnabled(enabled) {
    const isEnabled = enabled === true;
    if (!isEnabled) this.cancelVocabularyWork();
    if (!this.ready || !this.iframe || !this.documentId || !Number.isInteger(this.openRequest)) return false;
    return this.postToViewer({
      channel: CHANNEL,
      token: this.token,
      type: "vocab-set-enabled",
      documentId: this.documentId,
      openRequest: this.openRequest,
      enabled: isEnabled,
    });
  }

  setVocabularyHighlightLevels(levels) {
    if (!this.ready || !this.iframe || !this.documentId || !Number.isInteger(this.openRequest)) return false;
    return this.postToViewer({
      channel: CHANNEL,
      token: this.token,
      type: "vocab-set-highlight-levels",
      documentId: this.documentId,
      openRequest: this.openRequest,
      levels: normalizeVocabularyHighlightLevels(levels),
    });
  }

  setVocabularyDisplayMode(mode) {
    if (!this.ready || !this.iframe || !this.documentId || !Number.isInteger(this.openRequest)) return false;
    return this.postToViewer({
      channel: CHANNEL,
      token: this.token,
      type: "vocab-set-display-mode",
      documentId: this.documentId,
      openRequest: this.openRequest,
      mode: normalizeVocabularyDisplayMode(mode),
    });
  }

  setVocabularyWordDisplayMode(mode) {
    if (!this.ready || !this.iframe || !this.documentId || !Number.isInteger(this.openRequest)) return false;
    return this.postToViewer({
      channel: CHANNEL, token: this.token, type: "vocab-set-word-mode",
      documentId: this.documentId, openRequest: this.openRequest,
      mode: mode === "roots" ? "roots" : "whole",
    });
  }

  refreshVocabularyPages(change = null) {
    if (!this.plugin.settings.vocabularyEnabled || !this.ready || !this.iframe ||
        !this.documentId || !Number.isInteger(this.openRequest)) return false;
    return this.postToViewer({
      channel: CHANNEL,
      token: this.token,
      type: "vocab-page-refresh",
      documentId: this.documentId,
      openRequest: this.openRequest,
      ...(change?.invalidateAll === true ? { invalidateAll: true } :
        Array.isArray(change?.changedKeys) && change.changedKeys.length <= 64
          ? { changedKeys: [...change.changedKeys] } : {}),
    });
  }

  requestVocabularySelection() {
    if (!this.plugin.settings.vocabularyEnabled) {
      new Notice("请先启用 LingQ 式本地英语词汇学习。", 6000);
      return false;
    }
    if (!this.ready || !this.openAcknowledged || !this.iframe || !this.documentId) {
      new Notice("PDF 页面尚未准备好，请稍后再试。", 6000);
      return false;
    }
    const requestId = makeToken();
    const identity = {
      documentId: this.documentId,
      openRequest: this.openRequest,
      rendererGeneration: this.rendererGeneration,
    };
    const timer = globalThis.setTimeout(() => this.pendingVocabularySelections.delete(requestId), 15000);
    this.pendingVocabularySelections.set(requestId, { ...identity, timer });
    const sent = this.postToViewer({
      channel: CHANNEL,
      token: this.token,
      type: "vocab-selection-request",
      requestId,
      documentId: identity.documentId,
      openRequest: identity.openRequest,
    });
    if (!sent) {
      globalThis.clearTimeout(timer);
      this.pendingVocabularySelections.delete(requestId);
      new Notice("无法连接到当前 PDF 阅读器。", 6000);
    }
    return sent;
  }

  isCurrentReaderAnchorIdentity(identity) {
    return identity?.documentId === this.documentId && identity?.openRequest === this.openRequest &&
      identity?.rendererGeneration === this.rendererGeneration && !this.teardownStarted;
  }

  requestReaderAnchorCapture(mode = "reader", details = null, suppliedRequestId = null, options = {}) {
    if (!this.ready || !this.openAcknowledged || !this.iframe || !this.annotationDocument ||
        this.annotationHydrationAllowed !== true) {
      if (!options.contextRequest) new Notice("PDF 身份尚未确认，暂不能建立链接。", 6000);
      return false;
    }
    const requestId = typeof suppliedRequestId === "string" && suppliedRequestId.length <= 128
      ? suppliedRequestId : makeToken();
    if (this.pendingReaderAnchorCaptures.has(requestId)) return false;
    const identity = { documentId: this.documentId, openRequest: this.openRequest,
      rendererGeneration: this.rendererGeneration };
    const responseType = typeof options.clientResponseType === "string" &&
      /^reader-[a-z0-9-]{1,96}$/u.test(options.clientResponseType)
      ? options.clientResponseType : "reader-anchor-occurrence-result";
    const pending = { ...identity, mode, timer: null,
      clientRequestId: suppliedRequestId ? requestId : null,
      clientResponseType: responseType,
      contextRequest: options.contextRequest && typeof options.contextRequest === "object"
        ? { ...options.contextRequest } : null };
    pending.timer = globalThis.setTimeout(() => {
      if (this.pendingReaderAnchorCaptures.get(requestId) !== pending) return;
      this.pendingReaderAnchorCaptures.delete(requestId);
      if (pending.clientRequestId) this.postToViewer({ channel: CHANNEL, token: this.token,
        type: pending.clientResponseType, requestId: pending.clientRequestId,
        documentId: pending.documentId, openRequest: pending.openRequest,
        ok: false, message: pending.contextRequest ? "语境捕获超时，请重新选择句子。" : "创建链接超时，请重试。" });
    }, 15000);
    this.pendingReaderAnchorCaptures.set(requestId, pending);
    const sent = this.postToViewer({ channel: CHANNEL, token: this.token,
      type: "reader-anchor-capture-request", requestId, mode,
      documentId: identity.documentId, openRequest: identity.openRequest,
      ...(mode === "occurrence" && details ? {
        pageNumber: details.pageNumber, startIndex: details.startIndex, endIndex: details.endIndex,
        expectedSurface: details.expectedSurface,
      } : {}) });
    if (!sent) {
      globalThis.clearTimeout(pending.timer);
      this.pendingReaderAnchorCaptures.delete(requestId);
      new Notice("无法连接到当前 PDF 阅读器。", 6000);
    }
    return sent;
  }

  async applyPendingReaderTarget() {
    const pendingTarget = this.pendingReaderTarget;
    const target = normalizeReaderTarget(pendingTarget);
    const document = this.annotationDocument;
    const pageIdentities = this.annotationPageIdentity?.orderedPageIdentities;
    if (target && document && this.annotationSourceMismatch === true) {
      this.pendingReaderTarget = null;
      const { readerTarget: _readerTarget, ...state } = this.navigationState || {};
      this.navigationState = state;
      const pageNumber = Number.isSafeInteger(target.pageNumber) && target.pageNumber > 0
        ? target.pageNumber : this.currentPageNumber;
      this.plugin.sessionLog?.record("readerAnchor", { event: "target-unresolved", code: "TARGET_UNRESOLVED",
        documentId: document.documentId, sourcePath: document.sourcePath, pageNumber });
      new Notice(`TARGET_UNRESOLVED：PDF 来源身份不匹配，未应用旧页面身份或几何目标；仅保留第 ${pageNumber || 1} 页码回退。`, 7000);
      return false;
    }
    if (!target || !document || this.annotationHydrationAllowed !== true ||
        !Array.isArray(pageIdentities) || pageIdentities.length === 0 || !this.ready || !this.openAcknowledged) return false;
    const identity = { documentId: this.documentId, openRequest: this.openRequest,
      rendererGeneration: this.rendererGeneration };
    const applyKey = JSON.stringify([identity, target]);
    if (this.readerTargetApplyPromise && this.readerTargetApplyKey === applyKey &&
        this.readerTargetApplyPendingTarget === pendingTarget) {
      return this.readerTargetApplyPromise;
    }
    const sequence = ++this.readerTargetApplySequence;
    this.readerTargetApplyKey = applyKey;
    this.readerTargetApplyPendingTarget = pendingTarget;
    const isCurrent = () => sequence === this.readerTargetApplySequence &&
      this.isCurrentReaderAnchorIdentity(identity) && this.annotationDocument === document &&
      this.annotationHydrationAllowed === true && this.annotationSourceMismatch !== true &&
      this.pendingReaderTarget === pendingTarget &&
      this.annotationPageIdentity?.orderedPageIdentities === pageIdentities;
    const run = async () => {
      const rejectCurrent = (message) => {
        if (isCurrent()) {
          this.pendingReaderTarget = null;
          new Notice(message, 7000);
        }
        return false;
      };
      if ((target.docKey && target.docKey !== document.docKey) ||
          (target.documentId && target.documentId !== document.documentId)) {
        return rejectCurrent("PDF 链接的文档身份与当前文件不一致，已停止跳转。");
      }
      let resolved = { ...target };
      if (target.kind === "selection") {
        let anchor;
        try {
          anchor = await this.plugin.readerAnchorStore.get(document.docKey, target.id, document.documentId);
        } catch (error) {
          if (!isCurrent()) return false;
          return rejectCurrent(`Selection Anchor 校验失败：${error.message || "记录损坏"}；保留原生页码链接作为回退。`);
        }
        if (!isCurrent()) return false;
        if (!anchor || anchor.sourceHash !== this.annotationSourceHash ||
            anchor.pageCount !== pageIdentities.length) {
          return rejectCurrent("Selection Anchor 缺失或 PDF 来源已变化；保留原生页码链接作为回退。");
        }
        const currentPageIdentityDigest = await this.plugin.pdfHashRuntime.fingerprint(
          new TextEncoder().encode(JSON.stringify(pageIdentities)),
        );
        if (!isCurrent()) return false;
        if (anchor.orderedPageIdentityDigest !== currentPageIdentityDigest) {
          return rejectCurrent("PDF 页面身份顺序已变化，未猜测 Selection 位置；原生页码链接仍可用。");
        }
        const pageIndex = pageIdentities.indexOf(anchor.pageIdentity);
        if (pageIndex < 0) {
          return rejectCurrent("Selection Anchor 所属页面已无法可靠确认。");
        }
        resolved = { ...resolved, pageIndex, pageIdentity: anchor.pageIdentity, anchor };
      } else if (target.kind === "annotation") {
        const rows = Array.isArray(this.annotationSnapshot?.annotations)
          ? this.annotationSnapshot.annotations : Object.values(this.annotationSnapshot?.annotations || {});
        const row = rows.find((entry) => entry?.uuid === target.id && entry.deleted !== true);
        if (!row || !Number.isSafeInteger(row.pageIndex) || !pageIdentities[row.pageIndex]) {
          return rejectCurrent("批注目标已删除或页面身份无法确认；链接不会重绑。");
        }
        resolved = { ...resolved, pageIndex: row.pageIndex, pageIdentity: pageIdentities[row.pageIndex] };
      } else if (target.kind === "page") {
        const pageIndex = pageIdentities.indexOf(target.id);
        if (pageIndex < 0) {
          return rejectCurrent("页面身份已不存在，未按页码猜测其他页面。");
        }
        resolved = { ...resolved, pageIndex, pageIdentity: target.id };
      } else if (target.kind === "page-number") {
        resolved.pageIndex = Math.min(pageIdentities.length - 1, target.pageNumber - 1);
        resolved.pageIdentity = pageIdentities[resolved.pageIndex];
      }
      if (!isCurrent() || !Number.isSafeInteger(resolved.pageIndex) || !resolved.pageIdentity) return false;
      const request = { ...identity, requestId: `reader-nav-${identity.openRequest}-${sequence}`,
        kind: resolved.kind, targetId: resolved.id || null };
      this.readerNavigationRequest = request;
      this.lastReaderNavigationResult = null;
      const sent = this.postToViewer({ channel: CHANNEL, token: this.token,
        type: "reader-anchor-navigate", documentId: identity.documentId,
        openRequest: identity.openRequest, requestId: request.requestId, target: resolved });
      if (!sent && this.readerNavigationRequest === request) this.readerNavigationRequest = null;
      if (sent && isCurrent()) {
        this.pendingReaderTarget = null;
        const { readerTarget: _readerTarget, ...state } = this.navigationState || {};
        this.navigationState = state;
      }
      return sent;
    };
    const promise = run().catch((error) => {
      if (isCurrent()) new Notice(`PDF 链接目标解析失败：${error.message || error}`, 7000);
      return false;
    }).finally(() => {
      if (sequence === this.readerTargetApplySequence) {
        this.readerTargetApplyKey = null;
        this.readerTargetApplyPromise = null;
        this.readerTargetApplyPendingTarget = null;
      }
    });
    this.readerTargetApplyPromise = promise;
    return promise;
  }

  isCurrentVocabularyIdentity(identity) {
    return identity?.documentId === this.documentId &&
      identity?.openRequest === this.openRequest &&
      identity?.rendererGeneration === this.rendererGeneration &&
      this.plugin.settings.vocabularyEnabled === true &&
      this.teardownStarted !== true;
  }

  async handleVocabularyBridgeMessage(message) {
    if (!String(message?.type || "").startsWith("vocab-")) return false;
    if (message.rendererGeneration !== this.rendererGeneration ||
        message.documentId !== this.documentId ||
        message.openRequest !== this.openRequest) return true;

    // The Reader's secondary toolbar mirrors the existing persistent setting;
    // it does not own a second copy of the enabled preference.
    if (message.type === "vocab-toggle-request") {
      if (typeof message.enabled !== "boolean" || this.teardownStarted === true) return true;
      await this.plugin.setVocabularyEnabled(message.enabled);
      return true;
    }
    if (message.type === "vocab-display-mode-request") {
      if (!VOCABULARY_DISPLAY_MODES.includes(message.mode) || this.teardownStarted === true) return true;
      await this.plugin.setVocabularyDisplayMode(message.mode);
      return true;
    }
    if (message.type === "vocab-word-mode-request") {
      if (!["whole", "roots"].includes(message.mode) || this.teardownStarted === true) return true;
      await this.plugin.setVocabularyWordDisplayMode(message.mode);
      return true;
    }
    if (!this.plugin.settings.vocabularyEnabled) return true;

    if (message.type === "vocab-page-query") {
      const validRequest = typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 128;
      const validTokens = Array.isArray(message.tokens) && message.tokens.length <= 6000 &&
        message.tokens.every((token) => typeof token === "string" && token.length > 0 && token.length <= 160 && !token.includes(" ")) &&
        message.tokens.reduce((total, token) => total + token.length + 1, 0) <= MAX_VOCABULARY_QUERY_TEXT_CHARS;
      const validKeys = Array.isArray(message.keys) && message.keys.length <= 2048 &&
        message.keys.every((key) => typeof key === "string" && key.length <= 1600 &&
          key.split(" ").length <= 12 && normalizeVocabularyTermKey(key) === key) &&
        message.keys.reduce((total, key) => total + key.length + 1, 0) <= MAX_VOCABULARY_QUERY_TEXT_CHARS;
      if (!validRequest || typeof message.queryId !== "string" || message.queryId.length > 128 ||
          !Number.isInteger(message.partIndex) || message.partIndex < 0 || !(validTokens || validKeys) ||
          !Number.isInteger(message.pageNumber) || message.pageNumber < 1 || message.pageNumber > 100000) return true;
      const identity = { documentId: this.documentId, openRequest: this.openRequest, rendererGeneration: this.rendererGeneration };
      try {
        const service = this.plugin.getVocabularyService();
        const pageMatches = validTokens
          ? await service.matchPageTokens(message.tokens)
          : null;
        const matches = pageMatches ? null : await service.queryTerms([...new Set(message.keys)]);
        if (!this.isCurrentVocabularyIdentity(identity)) return true;
        this.postToViewer({
          channel: CHANNEL, token: this.token, type: "vocab-page-results",
          requestId: message.requestId, queryId: message.queryId, partIndex: message.partIndex, pageNumber: message.pageNumber,
          documentId: identity.documentId, openRequest: identity.openRequest,
          ...(pageMatches ? {
            wordMatches: pageMatches.wordMatches,
            phraseMatches: pageMatches.phraseMatches,
            metrics: pageMatches.metrics,
          } : {
            records: Object.entries(matches).map(([key, record]) => ({
              key, storageKey: record.key, type: record.type, status: record.status,
            })),
          }),
        });
      } catch (error) {
        if (this.isCurrentVocabularyIdentity(identity)) {
          this.postToViewer({
            channel: CHANNEL, token: this.token, type: "vocab-page-results",
            requestId: message.requestId, queryId: message.queryId, partIndex: message.partIndex, pageNumber: message.pageNumber,
            documentId: identity.documentId, openRequest: identity.openRequest,
            ...(validTokens ? { wordMatches: [], phraseMatches: [], metrics: null } : { records: [] }),
            error: error.code || "vocabulary-query-failed",
          });
        }
      }
      return true;
    }

    if (message.type === "vocab-token-tap") {
      const validRequest = typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 128;
      const validType = message.entryType === "word" || message.entryType === "phrase";
      const validKey = validType && typeof message.key === "string" && message.key.length <= 1600 &&
        normalizeVocabularyTermKey(message.key) === message.key &&
        (message.entryType === "phrase"
          ? message.key.split(" ").length >= 2 && message.key.split(" ").length <= 12
          : !message.key.includes(" "));
      const logicalSurface = validateVocabularySurface(message);
      if (!validRequest || !validKey || logicalSurface === null ||
          !Number.isInteger(message.pageNumber) || message.pageNumber < 1 || message.pageNumber > 100000) return true;
      const identity = { documentId: this.documentId, openRequest: this.openRequest, rendererGeneration: this.rendererGeneration };
      this.cancelVocabularyEntryLookups();
      let service, dictionaryService, vocabularyInitialization;
      try {
        dictionaryService = this.plugin.getVocabularyDictionary();
        vocabularyInitialization = Promise.resolve(this.plugin.initializeVocabulary());
      } catch (error) {
        if (this.isCurrentVocabularyIdentity(identity)) this.postToViewer({
          channel: CHANNEL, token: this.token, type: "vocab-entry-result",
          requestId: message.requestId, key: message.key, pageNumber: message.pageNumber,
          documentId: identity.documentId, openRequest: identity.openRequest,
          error: error.code || "vocabulary-read-failed",
        });
        return true;
      }
      let dictionaryStatus = null;
      try { dictionaryStatus = dictionaryService?.getStatus?.() || null; } catch { /* Older adapters need no progress UI. */ }
      const hasDictionaryStatus = Boolean(dictionaryStatus && typeof dictionaryService?.subscribe === "function");
      const supportsDictionaryProgress = hasDictionaryStatus && dictionaryStatus.phase !== "ready";
      let progressState = null;
      if (supportsDictionaryProgress) {
        progressState = {
          requestId: message.requestId,
          entryRequestId: message.requestId,
          key: message.key,
          entryType: message.entryType,
          pageNumber: message.pageNumber,
          identity,
          active: true,
          personal: null,
          personalChanged: false,
          unsubscribe: null,
          lastProgressSignature: null,
          lastProgressStatus: dictionaryStatus,
          sendProgress: null,
          updatePersonal: null,
          cancel: null,
        };
        const matchingPersonal = (record) => record && record.type === message.entryType ? record : null;
        const postEntryRecord = (personalRecord, lookupState, progress = null) => {
          if (!progressState.active || !this.isCurrentVocabularyIdentity(identity)) return false;
          const personal = matchingPersonal(personalRecord);
          return this.postToViewer({
            channel: CHANNEL, token: this.token, type: "vocab-entry-result",
            requestId: message.requestId, key: message.key, pageNumber: message.pageNumber,
            documentId: identity.documentId, openRequest: identity.openRequest,
            record: {
              key: message.key,
              ...(personal ? { storageKey: personal.key, status: personal.status } : {}),
              type: message.entryType,
              hasPersonalRecord: Boolean(personal),
              translation: personal?.translation || "",
              phonetic: personal?.phonetic || "",
              dictionaryLookupState: lookupState,
              ...(progress ? {
                dictionaryLookupCount: progress.count,
                dictionaryLookupTotal: progress.total,
                dictionaryLookupPercent: progress.percent,
              } : {}),
            },
          });
        };
        progressState.updatePersonal = (record) => {
          const personal = matchingPersonal(record);
          progressState.personal = personal ? { ...personal } : null;
        };
        progressState.sendProgress = (status, force = false) => {
          if (!progressState.active || !this.isCurrentVocabularyIdentity(identity)) return false;
          const count = Number.isFinite(status?.count) ? Math.max(0, Math.floor(status.count)) : 0;
          const total = Number.isFinite(status?.total) ? Math.max(0, Math.floor(status.total)) : 0;
          const percent = Math.floor(vocabularyDictionaryPercent({ ...status, count, total }) / 10) * 10;
          const signature = String(status?.phase || "building") + ":" + total + ":" + percent;
          if (!force && signature === progressState.lastProgressSignature) return false;
          progressState.lastProgressSignature = signature;
          progressState.lastProgressStatus = status;
          return postEntryRecord(progressState.personal, "preparing", { count, total, percent });
        };
        progressState.cancel = () => {
          if (!progressState.active) return false;
          progressState.active = false;
          progressState.unsubscribe?.();
          progressState.unsubscribe = null;
          this.pendingVocabularyEntryLookups.delete(message.requestId);
          return true;
        };
        this.pendingVocabularyEntryLookups.set(message.requestId, progressState);
        // Give the Viewer a useful cold-cache state before awaiting either
        // Vault data or the first verified dictionary generation.
        progressState.sendProgress(dictionaryStatus);
        try {
          const unsubscribe = dictionaryService.subscribe((status) => progressState.sendProgress(status));
          progressState.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;
        } catch { /* A status observer is optional; the lookup still works. */ }
      }
      try {
        await vocabularyInitialization;
        if (!this.isCurrentVocabularyIdentity(identity) || progressState && !progressState.active) return true;
        service = this.plugin.getVocabularyService();
        const [record, dictionaryResult] = await Promise.all([
          service.getTerm(message.key),
          dictionaryService.lookup(message.key)
            .then((value) => ({ value, state: value ? "found" : "not-found" }))
            .catch((error) => {
              const code = error?.code || "dictionary-unavailable";
              this.plugin.sessionLog?.record("vocabularyDictionary", { event: "lookup-unavailable", code });
              return { value: null, state: "unavailable" };
            }),
        ]);
        if (!this.isCurrentVocabularyIdentity(identity) || progressState && !progressState.active) return true;
        if (progressState && !progressState.personalChanged) {
          progressState.updatePersonal(record);
          progressState.sendProgress(progressState.lastProgressStatus, true);
        }
        // The dictionary can take long enough for a user to change this
        // entry's learning level. Read the current personal row after lookup
        // completes so a late dictionary result cannot restore stale status.
        const finalRecord = hasDictionaryStatus ? await service.getTerm(message.key) : record;
        if (!this.isCurrentVocabularyIdentity(identity) || progressState && !progressState.active) return true;
        progressState?.updatePersonal(finalRecord);
        const personal = progressState?.personal || (finalRecord && finalRecord.type === message.entryType ? finalRecord : null);
        const dictionary = dictionaryResult.value;
        const entry = {
          key: message.key,
          ...(personal ? { storageKey: personal.key, status: personal.status } : {}),
          type: message.entryType,
          hasPersonalRecord: Boolean(personal),
          translation: personal?.translation || dictionary?.translation || "",
          phonetic: personal?.phonetic || dictionary?.phonetic || "",
          dictionaryLookupState: dictionaryResult.state,
        };
        this.postToViewer({
          channel: CHANNEL, token: this.token, type: "vocab-entry-result",
          requestId: message.requestId, key: message.key, pageNumber: message.pageNumber,
          documentId: identity.documentId, openRequest: identity.openRequest,
          record: entry,
        });
      } catch (error) {
        if (this.isCurrentVocabularyIdentity(identity) && (!progressState || progressState.active)) this.postToViewer({
          channel: CHANNEL, token: this.token, type: "vocab-entry-result",
          requestId: message.requestId, key: message.key, pageNumber: message.pageNumber,
          documentId: identity.documentId, openRequest: identity.openRequest,
          error: error.code || "vocabulary-read-failed",
        });
      } finally {
        progressState?.cancel?.();
      }
      return true;
    }

    if (message.type === "vocab-set-status") {
      const validRequest = typeof message.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 128;
      const validType = message.entryType === "word" || message.entryType === "phrase";
      const validKey = validType && typeof message.key === "string" && message.key.length > 0 && message.key.length <= 1600 &&
        normalizeVocabularyTermKey(message.key) === message.key &&
        (message.entryType === "phrase"
          ? message.key.split(" ").length >= 2 && message.key.split(" ").length <= 12
          : !message.key.includes(" "));
      const logicalSurface = validateVocabularySurface(message);
      if (!validRequest || !validKey || logicalSurface === null ||
          !Number.isInteger(message.status) || message.status < 1 || message.status > 5 ||
          typeof message.entryRequestId !== "string" || message.entryRequestId.length > 128 ||
          !Number.isInteger(message.pageNumber) || message.pageNumber < 1 || message.pageNumber > 100000) return true;
      const identity = { documentId: this.documentId, openRequest: this.openRequest, rendererGeneration: this.rendererGeneration };
      try {
        if (!this.isCurrentVocabularyIdentity(identity)) return true;
        await this.plugin.initializeVocabulary();
        if (!this.isCurrentVocabularyIdentity(identity)) return true;
        const service = this.plugin.getVocabularyService();
        const runtime = await this.plugin.getVocabularyRuntime();
        if (!this.isCurrentVocabularyIdentity(identity)) return true;
        const record = await runtime.mutatePersonal(() => service.upsertTerm(logicalSurface, { type: message.entryType, status: message.status }));
        if (!this.isCurrentVocabularyIdentity(identity)) return true;
        this.updatePendingVocabularyEntryPersonalRecord(identity, message.entryRequestId, message.key, record);
        this.postToViewer({
          channel: CHANNEL, token: this.token, type: "vocab-status-ack", durable: true,
          requestId: message.requestId, entryRequestId: message.entryRequestId,
          key: message.key, pageNumber: message.pageNumber,
          documentId: identity.documentId, openRequest: identity.openRequest,
          revision: service.getRevision(), record: {
            ...record, key: message.key, storageKey: record.key,
          },
        });
      } catch (error) {
        if (this.isCurrentVocabularyIdentity(identity)) this.postToViewer({
          channel: CHANNEL, token: this.token, type: "vocab-status-error",
          requestId: message.requestId, key: message.key, pageNumber: message.pageNumber,
          documentId: identity.documentId, openRequest: identity.openRequest,
          error: error.code || "vocabulary-write-failed",
        });
      }
      return true;
    }

    if (message.type === "vocab-selection-rejected") {
      const pending = this.pendingVocabularySelections.get(message.requestId);
      if (!pending || !this.isCurrentVocabularyIdentity(pending)) return true;
      globalThis.clearTimeout(pending.timer);
      this.pendingVocabularySelections.delete(message.requestId);
      new Notice(message.code === "token-count"
        ? "请在同一页选择 1 到 12 个英语词汇。"
        : "选择范围无效；请只选择同一 PDF 页上的英语词汇。", 6000);
      return true;
    }

    if (message.type !== "vocab-selection") return true;
    const pending = this.pendingVocabularySelections.get(message.requestId);
    if (!pending || !this.isCurrentVocabularyIdentity(pending)) return true;
    globalThis.clearTimeout(pending.timer);
    this.pendingVocabularySelections.delete(message.requestId);
    const tokens = message.tokens;
    const tokenCountValid = Array.isArray(tokens) && tokens.length >= 1 && tokens.length <= 12;
    const validTokens = tokenCountValid && tokens.every((token) =>
      token && typeof token.rawSurface === "string" && token.rawSurface.length <= 128 &&
      typeof token.surfaceKey === "string" && token.surfaceKey.length <= 128 &&
      !token.surfaceKey.includes(" ") && normalizeVocabularyTermKey(token.surfaceKey) === token.surfaceKey);
    const expectedType = message.entryType;
    if (!validTokens || !["word", "phrase"].includes(expectedType) ||
        (expectedType === "word" && tokens.length !== 1) ||
        (expectedType === "phrase" && (tokens.length < 2 || tokens.length > 12)) ||
        !Number.isInteger(message.pageNumber) || message.pageNumber < 1 || message.pageNumber > 100000) {
      new Notice("无法保存该选择：只支持同一页上的英语单词或 2 到 12 个词的短语。", 6000);
      return true;
    }

    const surfaceKey = tokens.map((token) => token.surfaceKey).join(" ");
    const displaySurface = tokens.map((token) => token.rawSurface).join(" ");
    try {
      const service = this.plugin.getVocabularyService();
      const existing = await service.getTerm(surfaceKey);
      if (!this.isCurrentVocabularyIdentity(pending)) return true;
      if (this.vocabularyEntryModal) this.vocabularyEntryModal.close();
      const pageNumber = message.pageNumber;
      const modal = new VocabularyEntryModal(this.app, {
        surface: displaySurface,
        type: expectedType,
        existing,
        onClose: () => { if (this.vocabularyEntryModal === modal) this.vocabularyEntryModal = null; },
        onSave: async (fields) => {
          if (!this.isCurrentVocabularyIdentity(pending)) throw new Error("PDF 页面已切换或词汇学习已关闭。");
          await this.plugin.initializeVocabulary();
          if (!this.isCurrentVocabularyIdentity(pending)) throw new Error("PDF 页面已切换或词汇学习已关闭。");
          const runtime = await this.plugin.getVocabularyRuntime();
          if (!this.isCurrentVocabularyIdentity(pending)) throw new Error("PDF 页面已切换或词汇学习已关闭。");
          const record = await runtime.mutatePersonal(() => service.upsertTerm(surfaceKey, { ...fields, type: expectedType }));
          if (!this.isCurrentVocabularyIdentity(pending)) return;
          this.postToViewer({
            channel: CHANNEL, token: this.token, type: "vocab-selection-ack",
            requestId: message.requestId, pageNumber, documentId: pending.documentId,
            openRequest: pending.openRequest, durable: true, revision: service.getRevision(), record,
          });
        },
      });
      this.vocabularyEntryModal = modal;
      modal.open();
    } catch (error) {
      new Notice(`读取词汇数据失败：${error.message || error}`, 8000);
    }
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
    if (message.type === "annotation-source-identity" || message.type === "annotation-maintenance-state") {
      void this.plugin.annotationHost.handleMessage(this, message).then(() => {
        this.applyPendingReaderTarget();
        if (message.type === "annotation-source-identity") {
          void this.plugin.refreshReaderBacklinksForView(this);
        }
      }).catch((error) => {
        this.showError(`无法确认外置批注对应的 PDF 页面：${error.message}`);
      });
      return;
    }
    if (message.type === "reader-anchor-capture") {
      if (message.rendererGeneration !== this.rendererGeneration) return;
      const pendingCapture = this.pendingReaderAnchorCaptures.get(message.requestId);
      void this.plugin.handleReaderAnchorCapture(this, message).catch((error) => {
        if (pendingCapture?.clientRequestId) this.postToViewer({ channel: CHANNEL, token: this.token,
          type: pendingCapture.clientResponseType || "reader-anchor-occurrence-result",
          requestId: pendingCapture.clientRequestId,
          documentId: pendingCapture.documentId, openRequest: pendingCapture.openRequest,
          ok: false, message: error.message || "创建链接失败。" });
        if (!pendingCapture?.contextRequest) new Notice(`创建 PDF 链接失败：${error.message || error}`, 7000);
      });
      return;
    }
    if (message.type === "reader-vocabulary-context-capture-request") {
      if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest || typeof message.requestId !== "string" ||
          message.requestId.length > 128 || !Number.isSafeInteger(message.pageNumber) || message.pageNumber < 1 ||
          typeof message.expectedSurface !== "string" || !message.expectedSurface.trim() ||
          message.expectedSurface.length > MAX_VOCABULARY_SURFACE_CHARS ||
          this.plugin.settings.vocabularyEnabled !== true) return;
      const accepted = this.requestReaderAnchorCapture("quote", null, message.requestId, {
        clientResponseType: "reader-vocabulary-context-preview",
        contextRequest: { surface: message.expectedSurface, pageNumber: message.pageNumber },
      });
      if (!accepted) this.postToViewer({ channel: CHANNEL, token: this.token,
        type: "reader-vocabulary-context-preview", requestId: message.requestId,
        documentId: message.documentId, openRequest: message.openRequest, ok: false,
        message: "当前 PDF 尚未准备好，不能捕获语境。" });
      return;
    }
    if (message.type === "reader-vocabulary-context-save-request") {
      if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest || typeof message.requestId !== "string" ||
          message.requestId.length > 128 || typeof message.captureId !== "string" ||
          message.captureId.length > 128) return;
      void this.plugin.handleReaderVocabularyContextSave(this, message).catch((error) => {
        this.postToViewer({ channel: CHANNEL, token: this.token,
          type: "reader-vocabulary-context-save-result", requestId: message.requestId,
          captureId: message.captureId, documentId: this.documentId, openRequest: this.openRequest,
          ok: false, status: error.code || "error", message: error.message || "语境保存失败。" });
      });
      return;
    }
    if (message.type === "reader-anchor-occurrence-link-request") {
      if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest || typeof message.requestId !== "string" ||
          message.requestId.length > 128 || !Number.isSafeInteger(message.pageNumber) || message.pageNumber < 1 ||
          !Number.isSafeInteger(message.startIndex) || message.startIndex < 0 ||
          !Number.isSafeInteger(message.endIndex) || message.endIndex <= message.startIndex ||
          message.endIndex - message.startIndex > 12 ||
          typeof message.expectedSurface !== "string" || !message.expectedSurface.trim() ||
          message.expectedSurface.length > 1600) return;
      const accepted = this.requestReaderAnchorCapture("occurrence", {
        pageNumber: message.pageNumber, startIndex: message.startIndex, endIndex: message.endIndex,
        expectedSurface: message.expectedSurface,
      }, message.requestId);
      if (!accepted) this.postToViewer({ channel: CHANNEL, token: this.token,
        type: "reader-anchor-occurrence-result", requestId: message.requestId,
        documentId: message.documentId, openRequest: message.openRequest,
        ok: false, message: "当前 PDF 身份尚未准备好。" });
      return;
    }
    if (message.type === 'learning-review-draft-request') {
      if(message.rendererGeneration!==this.rendererGeneration||message.documentId!==this.documentId||
          message.openRequest!==this.openRequest||this.teardownStarted)return;
      void this.plugin.getLearningHost().fromAnnotationRequest(this,message).catch(error=>
        new Notice(error.message||'无法建立学习草稿。',7000));
      return;
    }
    if (message.type === "reader-backlink-page-request") {
      if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest) return;
      void this.plugin.handleReaderBacklinkPageRequest(this, message).catch((error) => {
        this.plugin.sessionLog?.record("readerBacklinks", { event: "page-lookup-failed",
          code: error.code || "unknown" });
      });
      return;
    }
    if (message.type === "reader-backlink-target-open") {
      if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest || typeof message.requestId !== "string" ||
          message.requestId.length > 128) return;
      void this.plugin.handleReaderBacklinkTargetOpen(this, message).catch((error) => {
        this.plugin.sessionLog?.record("readerBacklinks", { event: "target-open-failed",
          code: error.code || "unknown" });
      });
      return;
    }
    if (message.type === "reader-backlink-occurrence-query" ||
        message.type === "reader-backlink-occurrence-open") {
      if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest || typeof message.requestId !== "string" ||
          message.requestId.length > 128) return;
      void this.plugin.handleReaderBacklinkOccurrenceMessage(this, message).catch((error) => {
        this.postToViewer({ channel: CHANNEL, token: this.token,
          type: "reader-backlink-occurrence-result", requestId: message.requestId,
          documentId: this.documentId, openRequest: this.openRequest, ok: false,
          message: error.message || "反向链接暂时不可用。" });
      });
      return;
    }
    if (message.type === "reader-anchor-navigation-result") {
      const request = this.readerNavigationRequest;
      if (message.rendererGeneration !== this.rendererGeneration || message.documentId !== this.documentId ||
          message.openRequest !== this.openRequest || !request ||
          request.rendererGeneration !== this.rendererGeneration || request.documentId !== this.documentId ||
          request.openRequest !== this.openRequest || message.requestId !== request.requestId ||
          message.kind !== request.kind || message.targetId !== request.targetId) return;
      this.readerNavigationRequest = null;
      this.lastReaderNavigationResult = Object.freeze({ ...request, ok: message.ok === true,
        reason: typeof message.reason === "string" ? message.reason : null });
      if (message.ok !== true) new Notice(message.message || "无法可靠定位此 PDF 链接目标。", 7000);
      this.plugin.sessionLog?.record("readerAnchor", { event: "navigation-result", ok: message.ok === true,
        requestId: request.requestId, targetId: request.targetId,
        resolveMs: message.resolveMs, kind: message.kind, reason: message.reason || null });
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

    if (String(message.type || "").startsWith("vocab-")) {
      void this.handleVocabularyBridgeMessage(message).catch((error) => {
        new Notice(`词汇操作失败：${error.message || error}`, 8000);
      });
      return;
    }

    if (message.type === "annotation-tool-preference-request") {
      if (message.rendererGeneration !== this.rendererGeneration ||
          message.documentId !== this.documentId || message.openRequest !== this.openRequest ||
          !PERSISTABLE_ANNOTATION_TOOL_MODES.has(message.mode) || this.teardownStarted) return;
      void this.plugin.setLastAnnotationToolMode(message.mode);
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
        if (this.pendingReaderTarget && this.annotationPageIdentity) void this.applyPendingReaderTarget();
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
      initialPageNumber: Number.isSafeInteger(this.pendingReaderTarget?.pageNumber) &&
        this.pendingReaderTarget.pageNumber > 0 ? this.pendingReaderTarget.pageNumber : null,
      autoSave: this.plugin.settings.autoSave,
      vocabularyEnabled: this.plugin.settings.vocabularyEnabled === true,
      vocabularyHighlightLevels: this.plugin.settings.vocabularyHighlightLevels,
      vocabularyDisplayMode: normalizeVocabularyDisplayMode(this.plugin.settings.vocabularyDisplayMode),
      vocabularyWordDisplayMode: this.plugin.settings.vocabularyWordDisplayMode === "roots" ? "roots" : "whole",
      preferredAnnotationToolMode: normalizeAnnotationToolMode(this.plugin.settings.lastAnnotationToolMode),
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
      // initializeView verified these exact bytes against the stored source.
      // Allow the Viewer to suppress confirmed deletions before its first draw.
      sourceHashConfirmed: this.annotationSourceMismatch === false &&
        this.annotationLegacyIdentityUncertain !== true && this.annotationSyncPending !== true,
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
      vocabularyEnabled: false,
      vocabularyHighlightLevels: normalizeVocabularyHighlightLevels(null),
      vocabularyDisplayMode: "all",
      vocabularyWordDisplayMode: "whole",
      ...((await this.loadData()) || {}),
    };
    this.settings.autoSave = this.settings.autoSave !== false;
    this.settings.showStatusBar = this.settings.showStatusBar === true;
    this.settings.vocabularyEnabled = this.settings.vocabularyEnabled === true;
    this.settings.vocabularyHighlightLevels = normalizeVocabularyHighlightLevels(this.settings.vocabularyHighlightLevels);
    this.settings.vocabularyDisplayMode = normalizeVocabularyDisplayMode(this.settings.vocabularyDisplayMode);
    this.settings.vocabularyWordDisplayMode = this.settings.vocabularyWordDisplayMode === "roots" ? "roots" : "whole";
    this.vocabularyService = null;
    this.vocabularyDictionary = null;
    this.vocabularyDictionaryStatus = { phase: "idle", count: 0, total: 0 };
    this.vocabularyDictionaryWarmupTimer = null;
    this.vocabularyDictionaryRefreshTimer = null;
    this.vocabularyDictionaryLastLogSignature = null;
    this.views = new Set();
    this.vocabularyInitialization = null;
    this.vocabularyUnsubscribe = null;
    this.vocabularyRuntime = null;
    this.vocabularyWorkbench = null;
    this.learningHost = null;
    this.isUnloading = false;
    // Startup migration is confined to the personal vocabulary snapshot.
    // An absent store stays absent; PDF startup does not wait for this work.
    void this.initializeVocabulary().catch((error) => {
      this.sessionLog?.record("vocabulary", { event: "migration-failed", code: error?.code || "vocabulary-migration-failed" });
      new Notice(`词汇数据迁移未完成，原记录已保留：${error.message || error}`, 8000);
    });
    if (typeof this.app.vault.on === "function") {
      for (const event of ["create", "modify", "delete", "rename"]) {
        this.registerEvent(this.app.vault.on(event, (file, previousPath) => {
          if (file?.path !== VOCABULARY_PATH && previousPath !== VOCABULARY_PATH) return;
          void this.reloadVocabularyFromVault().catch((error) => {
            this.sessionLog?.record("vocabulary", { event: "external-reload-failed", code: error?.code || "vocabulary-reload-failed" });
            new Notice(`词汇文件发生变化，尚未完成校验：${error.message || error}`, 8000);
          });
        }));
      }
    }
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
      enableJsonl: true,
      hashRuntime: this.pdfHashRuntime,
      identityHash: (bytes) => sha256Bytes(bytes),
      inspectLegacy: (bytes) => this.getLegacyMergeClient().inspect({ bytes, fastOpen: true }),
      normalizePath,
      makeToken,
      deviceId: localAnnotationDeviceId(),
      Notice,
      log: (event, details) => this.sessionLog?.record("annotationStore", { event, ...details }),
    });
    this.readerAnchorStore = createReaderAnchorStore({
      adapter: this.app.vault.adapter,
      hash: (bytes) => this.pdfHashRuntime.fingerprint(bytes),
      makeId: makeToken,
    });
    this.readerBacklinkIndex = createReaderBacklinkIndex();
    this.readerBacklinkIndexReady = false;
    this.readerBacklinkIndexBuildPromise = null;
    this.readerBacklinkPageIndexes = new Map();
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
    this.readerSettingsTab = new PdfWebReaderSettingTab(this.app, this);
    this.addSettingTab(this.readerSettingsTab);
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
      id: "copy-pdf-reader-link",
      name: "复制当前 PDF 阅读器链接",
      callback: () => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof PdfReaderView)) return new Notice("请先打开 PDF 阅读器。", 5000);
        view.requestReaderAnchorCapture("reader");
      },
    });
    this.addCommand({
      id: "copy-pdf-quote-reader-link",
      name: "复制引用和 PDF 阅读器链接",
      callback: () => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof PdfReaderView)) return new Notice("请先打开 PDF 阅读器。", 5000);
        view.requestReaderAnchorCapture("quote");
      },
    });
    this.addCommand({
      id: "copy-pdf-annotation-link",
      name: "复制选中批注链接",
      callback: () => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof PdfReaderView)) return new Notice("请先打开 PDF 阅读器。", 5000);
        view.requestReaderAnchorCapture("annotation");
      },
    });
    this.addCommand({
      id: "show-pdf-page-backlinks",
      name: "查看当前 PDF 页的 Markdown 反向链接",
      callback: () => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof PdfReaderView)) return new Notice("请先打开 PDF 阅读器。", 5000);
        view.requestReaderAnchorCapture("backlinks");
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
      id: "save-selection-to-vocabulary",
      name: "将选中文本保存到本地英语词汇",
      callback: () => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof PdfReaderView)) {
          new Notice("请先在 PDF 阅读器中选择一个英语单词或短语。", 6000);
          return;
        }
        if (!this.settings.vocabularyEnabled) {
          new Notice("请先在 PDF 阅读器设置中启用 LingQ 式本地英语词汇学习。", 6000);
          return;
        }
        view.requestVocabularySelection();
      },
    });
    this.addCommand({
      id: "manage-local-english-vocabulary",
      name: "打开词汇学习工作台",
      callback: () => this.openVocabularyWorkbench(),
    });
    this.addCommand({
      id:'add-markdown-selection-to-review',name:'将 Markdown 选中摘录加入复习',
      editorCallback:(editor,view)=>void this.getLearningHost().fromMarkdownEditor(editor,view)
        .catch(error=>new Notice(error.message||'无法建立学习草稿。',7000)),
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
    this.addCommand({
      id: "establish-pdf-copy-identity",
      name: "将当前无法确认身份的 PDF 作为新副本建立批注身份",
      callback: () => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof PdfReaderView) || view.annotationHydrationAllowed || !isPdfFile(view.documentFile || view.file)) {
          new Notice("请先打开因副本身份不明确而暂停的 PDF。", 6000);
          return;
        }
        void this.annotationHost.establishNewCopy(view).then(async () => {
          const file = view.documentFile || view.file;
          view.requestedPath = null;
          await view.openFile(file);
        }).catch((error) => new Notice(`建立副本身份失败：${error.message || error}`, 8000));
      },
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
          if (isVocabularyDictionaryResourcePath(file?.path)) this.handleVocabularyDictionaryResourceChange(file.path);
          if (typeof file?.path === "string" && file.path.toLowerCase().endsWith(".md")) {
            this.refreshReaderBacklinkFile(file);
          }
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
          if (isVocabularyDictionaryResourcePath(file?.path)) this.handleVocabularyDictionaryResourceChange(file.path);
          if (typeof file?.path === "string" && file.path.toLowerCase().endsWith(".md")) {
            this.refreshReaderBacklinkFile(file);
          }
          void this.annotationHost.handleSidecarChange(file).catch((error) => this.sessionLog?.record("annotationStore", {
            event: "vault-create-check-failed", code: error.code || "unknown",
          }));
        }),
      );
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (isVocabularyDictionaryResourcePath(file?.path)) this.handleVocabularyDictionaryResourceChange(file.path);
          if (typeof file?.path === "string" && file.path.toLowerCase().endsWith(".md")) {
            this.removeReaderBacklinkFile(file.path);
          }
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if(typeof oldPath==='string'&&(oldPath.toLowerCase().endsWith('.md')||
              file?.path?.toLowerCase().endsWith('.md')||Array.isArray(file?.children))) {
            void this.getLearningHost().renamed(oldPath,file.path).catch(error=>
              this.sessionLog?.record('learning',{event:'source-rename-failed',code:error.code||'unknown'}));
          }
          if (isVocabularyDictionaryResourcePath(file?.path) || isVocabularyDictionaryResourcePath(oldPath)) {
            this.handleVocabularyDictionaryResourceChange(file?.path, oldPath);
          }
          if (typeof oldPath === "string" && oldPath.toLowerCase().endsWith(".md")) {
            this.removeReaderBacklinkFile(oldPath, { notify: false });
          }
          if (typeof file?.path === "string" && file.path.toLowerCase().endsWith(".md")) {
            this.refreshReaderBacklinkFile(file);
          } else if (!isPdfFile(file) && typeof oldPath === "string" && typeof file?.path === "string") {
            const oldFolderPath = normalizePath(oldPath).replace(/\/+$/g, "");
            const newFolderPath = normalizePath(file.path).replace(/\/+$/g, "");
            const sourcePaths = this.readerBacklinkIndex?.getSourcePathsUnder?.(oldFolderPath) || [];
            let changed = false;
            for (const oldSourcePath of sourcePaths) {
              this.removeReaderBacklinkFile(oldSourcePath, { notify: false });
              changed = true;
              const movedPath = `${newFolderPath}${oldSourcePath.slice(oldFolderPath.length)}`;
              const movedFile = this.app.vault.getAbstractFileByPath?.(movedPath);
              if (movedFile?.path === movedPath) {
                this.refreshReaderBacklinkFile(movedFile, { notify: false });
              }
            }
            if (changed && this.readerBacklinkIndexReady) {
              for (const view of this.views) void this.refreshReaderBacklinksForView(view);
            }
          }
          if (!isPdfFile(file)) {
            if (Array.isArray(file?.children)) {
              void this.handleReaderPdfFolderRename(file, oldPath).catch(error =>
                this.sessionLog?.record("annotationStore", { event: "folder-route-update-failed",
                  code: error.code || "unknown" }));
            }
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
    if (typeof this.app.metadataCache?.on === "function") {
      this.registerEvent(this.app.metadataCache.on("changed", (file) => this.refreshReaderBacklinkFile(file)));
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
      this.app.workspace.onLayoutReady(() => {
        this.scheduleViewerPrewarm("layout-ready");
        void this.rebuildReaderBacklinkIndex();
      });
    } else {
      void this.rebuildReaderBacklinkIndex();
    }
    const foreground = () => {
      if (globalThis.document?.visibilityState !== "hidden") {
        this.scheduleViewerPrewarm("foreground");
        void this.annotationHost?.watchDeletionRetention?.();
      }
    };
    if (typeof this.registerDomEvent === "function" && globalThis.window?.addEventListener) {
      this.registerDomEvent(globalThis.window, "focus", foreground);
      if (globalThis.document?.addEventListener) this.registerDomEvent(globalThis.document, "visibilitychange", foreground);
    }
    if (typeof this.registerDomEvent === "function" && globalThis.document?.addEventListener) {
      this.registerDomEvent(globalThis.document, "click", (event) => {
        void this.handleEnhancedPdfLinkClick(event);
      }, true);
    }
    if (this.settings.vocabularyEnabled) this.scheduleVocabularyDictionaryWarmup();
  }

  async rebuildReaderBacklinkIndex() {
    const index = this.readerBacklinkIndex;
    if (!index || this.readerBacklinkIndexReady) return;
    if (this.readerBacklinkIndexBuildPromise) return this.readerBacklinkIndexBuildPromise;
    const build = async () => {
      const startedAt = Date.now();
      const files = this.app.vault.getMarkdownFiles?.() || [];
      for (const file of files) this.refreshReaderBacklinkFile(file, { notify: false });
      this.readerBacklinkIndexReady = true;
      this.readerBacklinkPageIndexes.clear();
      this.sessionLog?.record("readerBacklinks", {
        event: "index-built", sourceFileCount: files.length,
        targetCount: index.size, durationMs: Math.max(0, Date.now() - startedAt),
      });
      for (const view of this.views) void this.refreshReaderBacklinksForView(view);
    };
    this.readerBacklinkIndexBuildPromise = build();
    try { await this.readerBacklinkIndexBuildPromise; }
    finally { this.readerBacklinkIndexBuildPromise = null; }
  }

  invalidateReaderBacklinkPageIndexes() {
    this.readerBacklinkPageIndexes?.clear?.();
  }

  removeReaderBacklinkFile(sourcePath, { notify = true } = {}) {
    const removed = this.readerBacklinkIndex?.removeFile(sourcePath) || false;
    if (!removed) return false;
    this.invalidateReaderBacklinkPageIndexes();
    if (notify && this.readerBacklinkIndexReady) {
      for (const view of this.views) void this.refreshReaderBacklinksForView(view);
    }
    return true;
  }

  refreshReaderBacklinkFile(file, { notify = true } = {}) {
    if (!file || typeof file.path !== "string" || !file.path.toLowerCase().endsWith(".md")) return false;
    const cache = this.app.metadataCache?.getFileCache?.(file);
    if (!cache) return this.removeReaderBacklinkFile(file.path, { notify });
    const updated = this.readerBacklinkIndex?.replaceFile(file, cache) || false;
    if (updated) this.invalidateReaderBacklinkPageIndexes();
    if (updated && notify && this.readerBacklinkIndexReady) {
      for (const view of this.views) void this.refreshReaderBacklinksForView(view);
    }
    return updated;
  }

  async getReaderBacklinkPageIndex(view, identity) {
    if (!this.readerBacklinkIndexReady) await this.rebuildReaderBacklinkIndex();
    const document = view?.annotationDocument;
    const pageIdentities = view?.annotationPageIdentity?.orderedPageIdentities;
    const snapshot = view?.annotationSnapshot;
    const sourceHash = view?.annotationSourceHash;
    const isCurrent = () => view?.isCurrentReaderAnchorIdentity?.(identity) === true &&
      view.annotationDocument === document && view.annotationPageIdentity?.orderedPageIdentities === pageIdentities &&
      view.annotationSnapshot === snapshot && view.annotationSourceHash === sourceHash;
    if (!document?.docKey || !document.documentId || !Array.isArray(pageIdentities) ||
        !snapshot || !isCurrent()) return null;
    const routePath = view.documentFile?.path || view.file?.path || document.sourcePath || "";
    const cacheKey = `${document.docKey}:${document.documentId}:${sourceHash || ""}:${routePath}`;
    const indexRevision = this.readerBacklinkIndex?.revision || 0;
    let entry = this.readerBacklinkPageIndexes.get(cacheKey);
    if (entry && entry.indexRevision === indexRevision && entry.pageIdentities === pageIdentities &&
        entry.snapshot === snapshot) {
      this.readerBacklinkPageIndexes.delete(cacheKey);
      this.readerBacklinkPageIndexes.set(cacheKey, entry);
      const value = entry.value || await entry.promise;
      if (!isCurrent() || this.readerBacklinkPageIndexes.get(cacheKey) !== entry) return null;
      return { value, cacheHit: true, stats: entry.stats || null };
    }
    entry = { indexRevision, pageIdentities, snapshot, value: null, promise: null, stats: null };
    this.readerBacklinkPageIndexes.set(cacheKey, entry);
    const annotations = Array.isArray(snapshot.annotations) ? snapshot.annotations :
      Object.values(snapshot.annotations || {});
    const tombstones = [...(Array.isArray(snapshot.tombstones) ? snapshot.tombstones :
      Object.values(snapshot.tombstones || {})), ...(snapshot.deletionGuards || [])];
    entry.promise = buildReaderBacklinkPageIndex({
      index: this.readerBacklinkIndex,
      anchorStore: this.readerAnchorStore,
      docKey: document.docKey,
      documentId: document.documentId,
      sourcePath: view.documentFile?.path || view.file?.path || document.sourcePath || null,
      pageIdentities,
      annotations,
      tombstones,
      onInvalidAnchor: (error) => this.sessionLog?.record("readerBacklinks", {
        event: "anchor-invalid", code: error?.code || "unknown",
      }),
    });
    try {
      const value = await entry.promise;
      if (!isCurrent() || this.readerBacklinkPageIndexes.get(cacheKey) !== entry ||
          this.readerBacklinkIndex?.revision !== indexRevision) return null;
      entry.value = value;
      entry.stats = {
        backlinkLookupMs: value.backlinkLookupMs,
        anchorResolveMs: value.anchorResolveMs,
        buildMs: value.buildMs,
      };
      while (this.readerBacklinkPageIndexes.size > 12) {
        const oldest = this.readerBacklinkPageIndexes.keys().next().value;
        if (oldest === cacheKey && this.readerBacklinkPageIndexes.size === 1) break;
        this.readerBacklinkPageIndexes.delete(oldest);
      }
      return { value, cacheHit: false, stats: entry.stats };
    } catch (error) {
      if (this.readerBacklinkPageIndexes.get(cacheKey) === entry) this.readerBacklinkPageIndexes.delete(cacheKey);
      throw error;
    }
  }

  async collectReaderBacklinksForPage(view, pageIndex, identity) {
    if (!this.readerBacklinkIndexReady) await this.rebuildReaderBacklinkIndex();
    const document = view.annotationDocument;
    const pageIdentities = view.annotationPageIdentity?.orderedPageIdentities;
    const pageIdentity = pageIdentities?.[pageIndex];
    const isCurrent = () => view.isCurrentReaderAnchorIdentity(identity) &&
      view.annotationDocument === document && view.annotationPageIdentity?.orderedPageIdentities === pageIdentities;
    if (!document?.docKey || !pageIdentity || !isCurrent()) return null;
    const cached = await this.getReaderBacklinkPageIndex(view, identity);
    if (!cached || !isCurrent()) return null;
    const page = cached.value.forPage(pageIdentity);
    return {
      rows: page.rows,
      markers: page.markers,
      backlinkLookupMs: cached.cacheHit ? 0 : cached.stats?.backlinkLookupMs || 0,
      anchorResolveMs: cached.cacheHit ? 0 : cached.stats?.anchorResolveMs || 0,
      pageIndexCacheHit: cached.cacheHit,
    };
  }

  async handleReaderBacklinkPageRequest(view, message) {
    if (message.documentId !== view.documentId || message.openRequest !== view.openRequest ||
        message.rendererGeneration !== view.rendererGeneration || !Number.isSafeInteger(message.pageIndex) ||
        message.pageIndex < 0 || message.pageNumber !== message.pageIndex + 1) return false;
    view.currentPageNumber = message.pageNumber;
    const pageIdentities = view.annotationPageIdentity?.orderedPageIdentities;
    const document = view.annotationDocument;
    if (!document || view.annotationHydrationAllowed !== true || message.pageIdentity !== pageIdentities?.[message.pageIndex] ||
        message.sourceHash !== view.annotationSourceHash) return false;
    const requestId = message.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || !requestId || requestId.length > 128)) return false;
    const queryGeneration = (view.readerBacklinkQueryGeneration || 0) + 1;
    view.readerBacklinkQueryGeneration = queryGeneration;
    view.readerBacklinkPageRequest = { requestId, documentId: message.documentId,
      openRequest: message.openRequest, rendererGeneration: message.rendererGeneration,
      pageIndex: message.pageIndex, pageIdentity: message.pageIdentity };
    const indexRevision = this.readerBacklinkIndexReady ? this.readerBacklinkIndex?.revision || 0 : null;
    const identity = { documentId: view.documentId, openRequest: view.openRequest,
      rendererGeneration: view.rendererGeneration };
    const result = await this.collectReaderBacklinksForPage(view, message.pageIndex, identity);
    if (!result || !view.isCurrentReaderAnchorIdentity(identity) ||
        view.readerBacklinkQueryGeneration !== queryGeneration ||
        indexRevision !== null && (this.readerBacklinkIndex?.revision || 0) !== indexRevision) return false;
    view.postToViewer({ channel: CHANNEL, token: view.token, type: "reader-backlink-page-results",
      documentId: identity.documentId, openRequest: identity.openRequest,
      rendererGeneration: identity.rendererGeneration, pageNumber: message.pageNumber,
      pageIndex: message.pageIndex, pageIdentity: message.pageIdentity,
      ...(requestId ? { requestId } : {}),
      backlinkCount: result.rows.length, markers: result.markers.slice(0, 64),
      backlinkLookupMs: result.backlinkLookupMs, anchorResolveMs: result.anchorResolveMs,
      pageIndexCacheHit: result.pageIndexCacheHit });
    return true;
  }

  async refreshReaderBacklinksForView(view) {
    if (!this.readerBacklinkIndexReady || !view?.ready || !view.openAcknowledged ||
        view.annotationHydrationAllowed !== true || !view.annotationPageIdentity?.orderedPageIdentities) return false;
    const pageNumber = Number.isSafeInteger(view.currentPageNumber) ? view.currentPageNumber :
      Number.isSafeInteger(view.pendingReaderTarget?.pageNumber) ? view.pendingReaderTarget.pageNumber : 1;
    const pageIndex = pageNumber - 1;
    const pageIdentity = view.annotationPageIdentity.orderedPageIdentities[pageIndex];
    if (!pageIdentity) return false;
    const pending = view.readerBacklinkPageRequest;
    const requestId = pending?.documentId === view.documentId && pending.openRequest === view.openRequest &&
      pending.rendererGeneration === view.rendererGeneration && pending.pageIndex === pageIndex &&
      pending.pageIdentity === pageIdentity ? pending.requestId : undefined;
    return this.handleReaderBacklinkPageRequest(view, {
      documentId: view.documentId, openRequest: view.openRequest,
      rendererGeneration: view.rendererGeneration, pageNumber, pageIndex,
      pageIdentity, sourceHash: view.annotationSourceHash,
      ...(requestId ? { requestId } : {}),
    });
  }

  readerBacklinkSourceEvidence(row, sourceFile, { allowLearningExcerpt = false } = {}) {
    if (!row || row.sourcePath !== sourceFile?.path ||
        typeof row.sourcePath !== "string" || !row.sourcePath.toLowerCase().endsWith(".md")) return null;
    if (row.target !== undefined && row.target !== null) {
      const target = row.target;
      if (!target || !["page", "selection", "annotation"].includes(target.kind) ||
          typeof target.id !== "string" || !target.id) return null;
      const cache = this.app.metadataCache?.getFileCache?.(sourceFile);
      const links = Array.isArray(cache?.links) ? cache.links : [];
      const matched = links.find((link) => {
        if (typeof link?.link !== "string") return false;
        const parsed = parseReaderLinkDestination(link.link);
        if (parsed.target?.kind !== target.kind || parsed.target?.id !== target.id ||
            parsed.docKey !== (row.docKey || null) || parsed.documentId !== (row.documentId || null) ||
            normalizePdfRoutePath(parsed.routePath, row.sourcePath) !==
              normalizePdfRoutePath(row.routePath, row.sourcePath)) return false;
        if (typeof row.sourceText === "string" && row.sourceText && link.original !== row.sourceText) return false;
        const offset = Number.isSafeInteger(link.position?.start?.offset) ? link.position.start.offset : -1;
        const endOffset = Number.isSafeInteger(link.position?.end?.offset) ? link.position.end.offset : null;
        return offset === row.offset && endOffset === row.endOffset;
      });
      if (!matched) return null;
      return {
        kind: "reader-link",
        offset: Number.isSafeInteger(matched.position?.start?.offset) ? matched.position.start.offset : -1,
        endOffset: Number.isSafeInteger(matched.position?.end?.offset) ? matched.position.end.offset : null,
        line: Number.isSafeInteger(matched.position?.start?.line) ? matched.position.start.line : null,
        sourceText: typeof matched.original === "string" && matched.original ? matched.original : null,
      };
    }
    if (row.sourceText !== undefined) {
      const maxSourceTextLength = allowLearningExcerpt === true ? 100_000 : 4096;
      if (typeof row.sourceText !== "string" || !row.sourceText || row.sourceText.length > maxSourceTextLength ||
          !Number.isSafeInteger(row.offset) || row.offset < 0 ||
          !Number.isSafeInteger(row.endOffset) || row.endOffset <= row.offset ||
          row.endOffset - row.offset !== row.sourceText.length) return null;
      return { kind: "source-text", offset: row.offset, endOffset: row.endOffset,
        line: Number.isSafeInteger(row.line) ? row.line : null, sourceText: row.sourceText };
    }
    return null;
  }

  async openReaderBacklinkSource(row, { source = "backlink", requireExact = false } = {}) {
    const sourcePath = typeof row?.sourcePath === "string" ? row.sourcePath : "";
    const workspace = this.app.workspace;
    if (!sourcePath || typeof workspace?.openLinkText !== "function") return false;
    const sourceFile = this.app.vault.getAbstractFileByPath?.(sourcePath);
    if (sourceFile?.path !== sourcePath || !sourcePath.toLowerCase().endsWith(".md")) return false;
    const evidenceOptions = { allowLearningExcerpt: source === "learning-item" && requireExact === true };
    let evidence = this.readerBacklinkSourceEvidence(row, sourceFile, evidenceOptions);
    if (!evidence) {
      this.sessionLog?.record("readerBacklinks", { event: "source-open-failed", source,
        code: row?.target ? "TARGET_UNRESOLVED" : "SOURCE_UNVERIFIED" });
      return false;
    }
    const requireExactSourceText = requireExact === true && evidence.kind === "source-text";
    const rejectUnresolvedSourceText = () => {
      this.sessionLog?.record("readerBacklinks", { event: "source-open-failed", source,
        code: "TARGET_UNRESOLVED" });
      return false;
    };
    try {
      await workspace.openLinkText(sourcePath, "", true);
    } catch (error) {
      this.sessionLog?.record("readerBacklinks", { event: "source-open-failed", source,
        code: error?.code || "unknown" });
      new Notice(`无法打开 Markdown 来源：${error?.message || error}`);
      return false;
    }

    const currentSourceFile = this.app.vault.getAbstractFileByPath?.(sourcePath);
    evidence = currentSourceFile?.path === sourcePath
      ? this.readerBacklinkSourceEvidence(row, currentSourceFile, evidenceOptions) : null;
    if (!evidence) {
      this.sessionLog?.record("readerBacklinks", { event: "source-open-failed", source,
        code: row?.target ? "TARGET_UNRESOLVED" : "SOURCE_UNVERIFIED" });
      return false;
    }

    const leaf = workspace.activeLeaf || workspace.getMostRecentLeaf?.() || null;
    const view = leaf?.view;
    const editor = view?.editor;
    if (view?.getViewType?.() !== "markdown" || view.file?.path !== sourcePath || !editor) {
      return requireExactSourceText ? rejectUnresolvedSourceText() : true;
    }

    let position = null;
    let endPosition = null;
    let value = null;
    try { value = editor.getValue?.(); } catch { /* Fall back to the metadata line. */ }
    const sourceTextMatches = typeof evidence.sourceText === "string" && evidence.sourceText.length > 0 &&
      typeof value === "string" && Number.isSafeInteger(evidence.offset) && Number.isSafeInteger(evidence.endOffset) &&
      evidence.offset >= 0 && evidence.endOffset <= value.length && evidence.endOffset > evidence.offset &&
      value.slice(evidence.offset, evidence.endOffset) === evidence.sourceText;
    let positionKind = "file";
    if (sourceTextMatches && typeof value === "string" && typeof editor.offsetToPos === "function" &&
        Number.isSafeInteger(evidence.offset) && evidence.offset >= 0 && evidence.offset <= value.length) {
      try {
        const candidate = editor.offsetToPos(evidence.offset);
        if (isValidEditorPosition(candidate)) {
          position = candidate;
          positionKind = "exact-start";
        }
        if (position && Number.isSafeInteger(evidence.endOffset) && evidence.endOffset > evidence.offset &&
            evidence.endOffset <= value.length) {
          const candidateEnd = editor.offsetToPos(evidence.endOffset);
          if (isValidEditorPosition(candidateEnd)) {
            endPosition = candidateEnd;
            positionKind = "exact";
          }
        }
      } catch { position = null; endPosition = null; positionKind = "file"; }
    }
    if (requireExactSourceText && (!sourceTextMatches || !position)) return rejectUnresolvedSourceText();
    if (!position && Number.isSafeInteger(evidence.line) && evidence.line >= 0) {
      let lineCount = null;
      try { lineCount = editor.lineCount?.(); } catch { /* Use the already available text when possible. */ }
      if (!Number.isSafeInteger(lineCount) && typeof value === "string") lineCount = value.split("\n").length;
      if (Number.isSafeInteger(lineCount) && evidence.line < lineCount) {
        position = { line: evidence.line, ch: 0 };
        positionKind = "line";
      }
    }
    if (!position) {
      this.sessionLog?.record("readerBacklinks", { event: "source-opened", source,
        positioned: false, selected: false, positionKind: "file" });
      return true;
    }

    try {
      if (endPosition && typeof editor.setSelection === "function") editor.setSelection(position, endPosition);
      else editor.setCursor?.(position);
      editor.scrollIntoView?.({ from: position, to: endPosition || position }, true);
      editor.focus?.();
    } catch (error) {
      this.sessionLog?.record("readerBacklinks", { event: "source-position-failed", source,
        code: error?.code || "unknown" });
      return requireExactSourceText ? false : true;
    }
    for (const cleanup of [...(this.readerBacklinkFocusCleanups || [])]) cleanup();

    // A brief selection makes the source link easy to spot without editing the note.
    // Any user input or a changed leaf/editor cancels cleanup, so we never restore an old cursor.
    if (endPosition && typeof editor.getCursor === "function" && typeof editor.setCursor === "function") {
      const from = copyEditorPosition(editor.getCursor("from"));
      const to = copyEditorPosition(editor.getCursor("to"));
      const container = view.containerEl;
      const ownerWindow = container?.ownerDocument?.defaultView || globalThis.window || globalThis;
      const addEvents = ["pointerdown", "keydown", "beforeinput"];
      let timer = null;
      let userInteracted = false;
      const focusCleanups = this.readerBacklinkFocusCleanups ||= new Set();
      const clearFocusGuard = () => {
        if (timer != null) ownerWindow.clearTimeout?.(timer);
        for (const eventName of addEvents) container?.removeEventListener?.(eventName, onUserInput, true);
        focusCleanups.delete(clearFocusGuard);
      };
      const onUserInput = () => { userInteracted = true; clearFocusGuard(); };
      for (const eventName of addEvents) container?.addEventListener?.(eventName, onUserInput, true);
      focusCleanups.add(clearFocusGuard);
      timer = ownerWindow.setTimeout?.(() => {
        try {
          if (!userInteracted && !this.isUnloading && leaf?.view === view && view.editor === editor &&
              view.file?.path === sourcePath && editor.getSelection?.() === value.slice(evidence.offset, evidence.endOffset) &&
              sameEditorPosition(editor.getCursor("from"), from) && sameEditorPosition(editor.getCursor("to"), to)) {
            editor.setCursor(endPosition);
          }
        } finally { clearFocusGuard(); }
      }, 1400);
    }
    this.sessionLog?.record("readerBacklinks", { event: "source-opened", source,
      positioned: Boolean(position), selected: Boolean(endPosition), positionKind });
    return true;
  }

  async handleReaderBacklinkTargetOpen(view, message) {
    const { documentId, openRequest, rendererGeneration } = message;
    const document = view.annotationDocument;
    const pageIdentities = view.annotationPageIdentity?.orderedPageIdentities;
    const targetKinds = new Set(["selection", "annotation", "page"]);
    const isCurrent = () => view.isCurrentReaderAnchorIdentity({ documentId, openRequest, rendererGeneration }) &&
      view.annotationDocument === document && view.annotationHydrationAllowed === true;
    if (!document?.docKey || !document.documentId || !isCurrent() || !targetKinds.has(message.targetKind) ||
        typeof message.targetId !== "string" || !message.targetId || message.targetId.length > 512 ||
        !Number.isSafeInteger(message.pageNumber) || message.pageNumber < 1 ||
        message.targetKind === "page" && message.targetId !== message.pageIdentity ||
        pageIdentities?.[message.pageNumber - 1] !== message.pageIdentity || !this.readerBacklinkIndexReady) return false;
    const backlinkPageIndex = await this.getReaderBacklinkPageIndex(view, { documentId, openRequest, rendererGeneration });
    if (!backlinkPageIndex || !isCurrent()) return false;
    const pageRows = backlinkPageIndex.value.forPage(message.pageIdentity).rows;
    const rows = message.targetKind === "page" ? pageRows : pageRows.filter((row) =>
      row.target?.kind === message.targetKind && row.target?.id === message.targetId &&
      !(message.targetKind === "annotation" && row.targetStatus === "deleted"));
    if (!isCurrent()) return false;
    if (rows.length === 1) {
      await this.openReaderBacklinkSource(rows[0], { source: "viewer" });
    } else if (rows.length > 1) {
      new ReaderBacklinksModal(this.app, rows,
        (row) => { void this.openReaderBacklinkSource(row, { source: "viewer-modal" }); }).open();
    }
    return true;
  }

  async handleReaderBacklinkOccurrenceMessage(view, message) {
    const document = view.annotationDocument;
    const pageIdentities = view.annotationPageIdentity?.orderedPageIdentities;
    const isCurrent = () => view.isCurrentReaderAnchorIdentity({ documentId: message.documentId,
      openRequest: message.openRequest, rendererGeneration: message.rendererGeneration }) &&
      view.annotationDocument === document && view.annotationHydrationAllowed === true;
    if (!document?.docKey || !document.documentId || !isCurrent()) return false;
    const identity = { documentId: message.documentId, openRequest: message.openRequest,
      rendererGeneration: message.rendererGeneration };
    if (!this.readerBacklinkIndexReady) {
      if (message.type === "reader-backlink-occurrence-query") {
        view.postToViewer({ channel: CHANNEL, token: view.token, type: "reader-backlink-occurrence-result",
          requestId: message.requestId, documentId: message.documentId, openRequest: message.openRequest,
          rendererGeneration: message.rendererGeneration, ok: false, count: 0, anchorIds: [],
          message: "反向链接索引仍在准备中，请稍后重试。" });
      }
      return false;
    }
    const backlinkPageIndex = await this.getReaderBacklinkPageIndex(view, identity);
    if (!backlinkPageIndex || !isCurrent()) return false;
    let rows = [];
    let anchorIds = [];
    if (message.type === "reader-backlink-occurrence-query") {
      if (!Number.isSafeInteger(message.pageNumber) || message.pageNumber < 1 ||
          !Number.isSafeInteger(message.startIndex) || message.startIndex < 0 ||
          !Number.isSafeInteger(message.endIndex) || message.endIndex <= message.startIndex ||
          message.endIndex - message.startIndex > 12) return false;
      const pageIdentity = pageIdentities?.[message.pageNumber - 1];
      if (!pageIdentity) return false;
      const occurrence = backlinkPageIndex.value.forOccurrence(pageIdentity, message.startIndex, message.endIndex);
      anchorIds = occurrence.anchorIds;
      rows = occurrence.rows;
    } else {
      if (!Array.isArray(message.anchorIds) || message.anchorIds.length > 32) return false;
      anchorIds = message.anchorIds.filter((anchorId) => typeof anchorId === "string");
      rows = backlinkPageIndex.value.forAnchorIds(anchorIds);
    }
    if (!isCurrent()) return false;
    if (message.type === "reader-backlink-occurrence-query") {
      view.postToViewer({ channel: CHANNEL, token: view.token, type: "reader-backlink-occurrence-result",
        requestId: message.requestId, documentId: message.documentId, openRequest: message.openRequest,
        rendererGeneration: message.rendererGeneration, ok: true, count: rows.length,
        anchorIds: [...new Set(anchorIds)] });
    } else if (rows.length === 1) {
      await this.openReaderBacklinkSource(rows[0], { source: "lingq-occurrence" });
    } else if (rows.length > 1) {
      new ReaderBacklinksModal(this.app, rows,
        (row) => { void this.openReaderBacklinkSource(row, { source: "lingq-occurrence-modal" }); }).open();
    }
    return true;
  }

  resolveLinkedPdfFile(linkPath, sourcePath = "") {
    if (!linkPath) return null;
    const metadataResolved = this.app.metadataCache?.getFirstLinkpathDest?.(linkPath, sourcePath);
    if (isPdfFile(metadataResolved)) return metadataResolved;
    // The generated links use a Vault-relative path. Direct lookup also makes
    // this work in contexts where Obsidian's metadata cache is still warming.
    const directPath = normalizePath(String(linkPath).replace(/^\//u, ""));
    const direct = this.app.vault.getAbstractFileByPath(directPath);
    return isPdfFile(direct) ? direct : null;
  }

  async resolveReaderLinkDocument(parsed, linkPath, sourcePath = "") {
    if (!parsed?.target && !parsed?.pageNumber) throw new Error("链接没有可识别的 Reader 目标。");
    let route = null;
    let file = null;
    if (parsed.docKey || parsed.documentId) {
      if (!parsed.docKey || !parsed.documentId) {
        const error = new Error("TARGET_UNRESOLVED：链接中的 PDF 身份字段不完整；不会退回历史路径。");
        error.code = "TARGET_UNRESOLVED";
        throw error;
      }
      // Legacy links keep resolving by stable identity, including after a PDF
      // rename. Legacy compact links may still carry only the PDF path.
      try {
        route = await this.annotationHost.store.documentForIdentity({
          docKey: parsed.docKey,
          documentId: parsed.documentId,
        });
      } catch (cause) {
        const error = new Error(`TARGET_UNRESOLVED：链接中的 PDF 身份当前无法验证；不会退回历史路径。${cause?.message ? ` ${cause.message}` : ""}`);
        error.code = "TARGET_UNRESOLVED";
        throw error;
      }
      if (!route || route.documentId !== parsed.documentId || route.docKey !== parsed.docKey) {
        const error = new Error("TARGET_UNRESOLVED：链接中的 PDF 文档身份无法验证；不会退回历史路径。");
        error.code = "TARGET_UNRESOLVED";
        throw error;
      }
      file = route.sourcePath ? this.app.vault.getAbstractFileByPath(route.sourcePath) : null;
      const pathFile = this.resolveLinkedPdfFile(linkPath, sourcePath);
      if (pathFile && isPdfFile(file) && pathFile.path !== file.path) {
        this.sessionLog?.record("readerAnchor", { event: "stale-path-routed-by-identity", docKey: parsed.docKey });
      }
    } else {
      file = this.resolveLinkedPdfFile(linkPath, sourcePath);
      if (!file) throw new Error("链接中的 PDF 路径当前无法解析。");
      route = await this.annotationHost.store.documentForPath(file.path);
    }
    if (!isPdfFile(file)) {
      const error = new Error(parsed.docKey || parsed.documentId
        ? "TARGET_UNRESOLVED：身份路由指向的 PDF 当前不可用；不会按旧路径猜测其他文件。"
        : "链接目标 PDF 当前未找到；不会按旧路径猜测其他文件。");
      if (parsed.docKey || parsed.documentId) error.code = "TARGET_UNRESOLVED";
      throw error;
    }
    const needsDocumentIdentity = parsed.target?.kind === "selection" || parsed.target?.kind === "annotation";
    if (needsDocumentIdentity && !route) {
      throw new Error("此稳定目标尚无已验证的 PDF 身份；可以使用原生页码回退。");
    }
    const documentId = route?.documentId || null;
    const docKey = route?.docKey || null;
    let readerTarget = normalizeReaderTarget({ ...parsed.target, docKey,
      documentId, pageNumber: parsed.pageNumber, selection: parsed.selection });
    if (!readerTarget && parsed.pageNumber) readerTarget = { kind: "page-number", pageNumber: parsed.pageNumber,
      selection: parsed.selection };
    if (!readerTarget) throw new Error("链接没有可识别的 Reader 目标。");
    let effective = null;
    if (readerTarget.kind === "annotation") {
      const store = this.annotationHost.store;
      // Link navigation must use a strictly read-only effective-state view:
      // legacy Format 3 exposes exportForMigration, while the current WAL
      // store exposes readDocument({ readOnly: true }). Neither path may ACK,
      // compact, repair a partial JSONL tail, or materialize a checkpoint.
      if (typeof store.exportForMigration === "function") {
        effective = await store.exportForMigration(route);
      } else if (typeof store.readDocument === "function") {
        effective = await store.readDocument(route, { readOnly: true });
      } else {
        throw new Error("当前批注存储不支持只读链接解析。");
      }
      const identity = effective.document || effective;
      if (identity.documentId !== documentId || identity.docKey !== docKey) {
        throw new Error("批注状态与链接中的文档身份不匹配。");
      }
    }
    if (readerTarget.kind === "selection") {
      const anchor = await this.readerAnchorStore.get(docKey, readerTarget.id, documentId);
      if (!anchor || anchor.sourceHash !== route.source?.sourceHash) {
        throw new Error("Selection Anchor 不存在或来源版本不匹配；原生页码回退仍可用。");
      }
      readerTarget = { ...readerTarget, pageNumber: anchor.pageIndexHint + 1 };
    } else if (readerTarget.kind === "annotation") {
      const toRows = (value) => Array.isArray(value) ? value : Object.values(value || {});
      const rows = toRows(effective?.annotations);
      const tombstones = [...toRows(effective?.tombstones), ...toRows(effective?.deletionGuards)];
      const row = rows.find((entry) => entry?.uuid === readerTarget.id && entry.deleted !== true &&
        !tombstones.some((deleted) => deleted?.uuid === readerTarget.id));
      if (!row) throw new Error("批注目标已删除或不存在；链接不会重新绑定到其他批注。");
      readerTarget = { ...readerTarget, pageNumber: row.pageIndex + 1 };
    }
    return { file, readerTarget };
  }

  async resolveReaderLinkFallback(parsed, linkPath, sourcePath = "") {
    const pageNumber = Number.isSafeInteger(parsed?.pageNumber) && parsed.pageNumber > 0
      ? parsed.pageNumber : 1;
    let file = null;
    if (parsed?.docKey || parsed?.documentId) {
      if (!parsed.docKey || !parsed.documentId) return null;
      try {
        const route = await this.annotationHost.store.documentForIdentity({
          docKey: parsed.docKey,
          documentId: parsed.documentId,
        });
        if (!route || route.docKey !== parsed.docKey || route.documentId !== parsed.documentId ||
            typeof route.sourcePath !== "string") return null;
        file = this.app.vault.getAbstractFileByPath(route.sourcePath);
      } catch { return null; }
    } else if (linkPath) {
      file = this.resolveLinkedPdfFile(linkPath, sourcePath);
    }
    return isPdfFile(file)
      ? { file, readerTarget: { kind: "page-number", pageNumber, selection: parsed?.selection || null } }
      : null;
  }

  async handleEnhancedPdfLinkClick(event) {
    const anchor = event?.target?.closest?.("a.internal-link[data-href], a.internal-link[href]");
    if (!anchor) return false;
    const href = anchor.getAttribute("data-href") || anchor.getAttribute("href") || "";
    const hashIndex = href.indexOf("#");
    if (hashIndex < 0) return false;
    const parsed = parseReaderLinkFragment(href.slice(hashIndex + 1));
    if (!parsed.target) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    let linkPath = "";
    let sourcePath = "";
    try {
      try { linkPath = decodeURIComponent(href.slice(0, hashIndex)); }
      catch { linkPath = href.slice(0, hashIndex); }
      sourcePath = anchor.closest?.(".markdown-preview-view")?.dataset?.sourcePath ||
        this.app.workspace.activeLeaf?.view?.file?.path || "";
      const { file, readerTarget } = await this.resolveReaderLinkDocument(parsed, linkPath, sourcePath);
      await this.openPdf(file, readerTarget);
    } catch (error) {
      const fallback = await this.resolveReaderLinkFallback(parsed, linkPath, sourcePath);
      if (fallback) {
        new Notice(`稳定目标无法确认，已退回原生 PDF 页码链接：${error.message || error}`, 7000);
        await this.openPdf(fallback.file, fallback.readerTarget);
      } else {
        new Notice(`无法打开 PDF 链接：${error.message || error}`, 7000);
      }
    }
    return true;
  }

  async handleReaderAnchorCapture(view, message) {
    const pending = view.pendingReaderAnchorCaptures.get(message.requestId);
    if (!pending) return true;
    if (message.rendererGeneration !== view.rendererGeneration ||
        message.documentId !== pending.documentId || message.openRequest !== pending.openRequest ||
        !view.isCurrentReaderAnchorIdentity(pending)) {
      globalThis.clearTimeout(pending.timer);
      view.pendingReaderAnchorCaptures.delete(message.requestId);
      if (pending.contextRequest && pending.clientRequestId && view.isCurrentReaderAnchorIdentity(pending)) {
        view.postToViewer({ channel: CHANNEL, token: view.token,
          type: pending.clientResponseType, requestId: pending.clientRequestId,
          documentId: pending.documentId, openRequest: pending.openRequest,
          ok: false, message: "Reader 身份已变化；请重新捕获语境。" });
      }
      return true;
    }
    const respondClient = (ok, messageText = null, extra = {}) => {
      if (!pending.clientRequestId) return;
      view.postToViewer({ channel: CHANNEL, token: view.token,
        type: pending.clientResponseType || "reader-anchor-occurrence-result",
        requestId: pending.clientRequestId,
        documentId: pending.documentId, openRequest: pending.openRequest,
        ok, ...(messageText ? { message: messageText } : {}), ...extra });
    };
    globalThis.clearTimeout(pending.timer);
    view.pendingReaderAnchorCaptures.delete(message.requestId);
    if (message.error || !message.capture) {
      respondClient(false, message.error || (pending.contextRequest
        ? "请先在当前 PDF 页选择一句文本。" : "当前没有可链接的 PDF 目标。"));
      if (!pending.contextRequest) new Notice(message.error || "当前没有可链接的 PDF 目标。", 6000);
      return true;
    }
    const capture = message.capture;
    const document = view.annotationDocument;
    const pageIdentities = view.annotationPageIdentity?.orderedPageIdentities;
    if (!document || !Array.isArray(pageIdentities) || pageIdentities.length !== view.annotationPageIdentity.pageCount ||
        view.annotationHydrationAllowed !== true || view.annotationSourceMismatch === true) {
      respondClient(false, "PDF 身份或页面身份尚未确认。");
      if (!pending.contextRequest) new Notice("PDF 身份或页面身份尚未确认，暂不能创建增强链接。", 7000);
      return true;
    }
    const pageIndex = capture.pageIndex;
    const pageIdentity = Number.isSafeInteger(pageIndex) ? pageIdentities[pageIndex] : null;
    if (!pageIdentity || capture.pageIdentity !== pageIdentity || capture.pageNumber !== pageIndex + 1) {
      respondClient(false, "当前页面身份与已验证 PDF 不一致。");
      if (!pending.contextRequest) new Notice("当前页面身份与已验证 PDF 不一致，未创建链接。", 7000);
      return true;
    }
    if (capture.sourceHash !== view.annotationSourceHash) {
      respondClient(false, "PDF 来源版本与 Reader 确认状态不一致。");
      if (!pending.contextRequest) new Notice("PDF 来源版本与 Reader 确认状态不一致，未创建链接。", 7000);
      return true;
    }
    const identity = { documentId: pending.documentId, openRequest: pending.openRequest,
      rendererGeneration: pending.rendererGeneration };
    const isCurrent = () => view.isCurrentReaderAnchorIdentity(identity) &&
      view.annotationDocument === document && view.annotationPageIdentity?.orderedPageIdentities === pageIdentities &&
      view.annotationHydrationAllowed === true && view.annotationSourceMismatch !== true;
    if (pending.contextRequest) {
      const surface = pending.contextRequest.surface;
      const requestedPage = pending.contextRequest.pageNumber;
      if (capture.kind !== "selection" || typeof capture.exactQuote !== "string" || !capture.exactQuote.trim() ||
          capture.exactQuote.length > 4096 || capture.pageNumber !== requestedPage) {
        respondClient(false, "请在词条所在的当前 PDF 页先选中一句文本，再重新捕获语境。");
        return true;
      }
      let family;
      try { family = await this.getVocabularyService().getFamily(surface); }
      catch (error) {
        respondClient(false, `无法确认该词条的个人词库身份：${error.message || error}`);
        return true;
      }
      if (!isCurrent()) {
        respondClient(false, "PDF 来源或页面身份已变化；请重新捕获语境。");
        return true;
      }
      if (!family) {
        respondClient(false, "请先把这个词加入个人词库，再保存语境。");
        return true;
      }
      while (view.pendingVocabularyContextCaptures.size >= 4) {
        const oldestId = view.pendingVocabularyContextCaptures.keys().next().value;
        const oldest = view.pendingVocabularyContextCaptures.get(oldestId);
        globalThis.clearTimeout(oldest?.timer);
        view.pendingVocabularyContextCaptures.delete(oldestId);
      }
      const captureId = makeToken();
      const contextPending = { captureId, requestId: pending.clientRequestId, ...identity,
        surface, familyKey: family.familyKey, pageNumber: requestedPage,
        docKey: document.docKey, sourceHash: view.annotationSourceHash,
        pageIdentity, pageCount: pageIdentities.length,
        capture: { ...capture }, timer: null, saving: false, savePromise: null, anchor: null };
      contextPending.timer = globalThis.setTimeout(() => {
        if (view.pendingVocabularyContextCaptures.get(captureId) === contextPending) {
          view.pendingVocabularyContextCaptures.delete(captureId);
        }
      }, 120000);
      view.pendingVocabularyContextCaptures.set(captureId, contextPending);
      respondClient(true, null, { surface, sentence: capture.exactQuote, captureId });
      this.sessionLog?.record("vocabularyContext", { event: "preview-ready", pageIndex, chars: capture.exactQuote.length });
      return true;
    }
    if (pending.mode === "backlinks") {
      await this.showReaderBacklinks(view, capture, identity);
      return true;
    }
    let target;
    let selection = null;
    if (capture.kind === "selection") {
      const orderedPageIdentityDigest = await this.pdfHashRuntime.fingerprint(
        new TextEncoder().encode(JSON.stringify(pageIdentities)),
      );
      if (!isCurrent()) return true;
      const anchor = await this.readerAnchorStore.create({
        anchorId: makeToken(),
        docKey: document.docKey,
        documentId: document.documentId,
        sourceHash: view.annotationSourceHash,
        pageIdentity,
        pageIndexHint: pageIndex,
        pageCount: view.annotationPageIdentity.pageCount,
        orderedPageIdentityDigest,
        textPosition: capture.textPosition,
        exactQuote: capture.exactQuote,
        prefix: capture.prefix,
        suffix: capture.suffix,
        geometry: capture.geometry,
      });
      if (!isCurrent()) return true;
      target = { kind: "selection", id: anchor.anchorId };
      selection = capture.nativeSelection || null;
    } else if (capture.kind === "annotation") {
      const rows = Array.isArray(view.annotationSnapshot?.annotations)
        ? view.annotationSnapshot.annotations : Object.values(view.annotationSnapshot?.annotations || {});
      const row = rows.find((entry) => entry?.uuid === capture.annotationUuid && entry.deleted !== true);
      if (!row || row.pageIndex !== pageIndex) {
        respondClient(false, "所选批注不存在或已删除。");
        new Notice("所选批注不存在或已删除；没有创建链接。", 6000);
        return true;
      }
      target = { kind: "annotation", id: row.uuid };
    } else if (capture.kind === "page") {
      target = { kind: "page", id: pageIdentity };
    } else {
      respondClient(false, "Reader 返回了不支持的链接目标。");
      return true;
    }
    const fragment = encodeReaderLinkFragment({ pageNumber: pageIndex + 1, selection,
      docKey: document.docKey, documentId: document.documentId, target });
    const relativePath = view.documentFile?.path || view.file?.path;
    if (!relativePath) throw new Error("当前 PDF 路径不可用。");
    const label = `${view.documentFile?.basename || view.file?.basename || "PDF"} · p.${pageIndex + 1}`;
    const safePath = relativePath.replaceAll("#", "%23").replaceAll("|", "\\|");
    const link = `[[${safePath}#${fragment}|${label.replaceAll("|", "\\|")}]]`;
    const output = pending.mode === "quote" && capture.kind === "selection"
      ? `${capture.exactQuote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${link}`
      : link;
    if (!isCurrent()) return true;
    await this.copyReaderText(output);
    if (!isCurrent()) return true;
    new Notice(capture.kind === "selection" ? "已复制带稳定 Selection Anchor 的 PDF 链接。" : "已复制 PDF 链接。", 4000);
    this.sessionLog?.record("readerAnchor", { event: "link-copied", kind: capture.kind,
      pageIndex, anchorCreated: capture.kind === "selection" });
    respondClient(true);
    return true;
  }

  async handleReaderVocabularyContextSave(view, message) {
    const pending = view.pendingVocabularyContextCaptures.get(message.captureId);
    if (!pending || pending.captureId !== message.captureId ||
        pending.requestId !== message.requestId || message.documentId !== pending.documentId ||
        message.openRequest !== pending.openRequest || !view.isCurrentReaderAnchorIdentity(pending) ||
        this.settings.vocabularyEnabled !== true) {
      throw Object.assign(new Error("语境预览已过期；请重新选择句子。"), { code: "VOCAB_CONTEXT_CAPTURE_EXPIRED" });
    }
    if (pending.savePromise) return pending.savePromise;
    pending.saving = true;
    globalThis.clearTimeout(pending.timer);
    pending.timer = null;
    const savePromise = this.commitReaderVocabularyContextSave(view, pending);
    pending.savePromise = savePromise;
    try {
      return await savePromise;
    } catch (error) {
      if (view.pendingVocabularyContextCaptures.get(pending.captureId) === pending) {
        pending.saving = false;
        pending.savePromise = null;
        pending.timer = globalThis.setTimeout(() => {
          if (view.pendingVocabularyContextCaptures.get(pending.captureId) === pending) {
            view.pendingVocabularyContextCaptures.delete(pending.captureId);
          }
        }, 120000);
      }
      throw error;
    }
  }

  async commitReaderVocabularyContextSave(view, pending) {
    const document = view.annotationDocument;
    const pageIdentities = view.annotationPageIdentity?.orderedPageIdentities;
    const isCurrent = () => view.pendingVocabularyContextCaptures.get(pending.captureId) === pending &&
      view.isCurrentReaderAnchorIdentity(pending) && view.annotationDocument === document &&
      view.annotationPageIdentity?.orderedPageIdentities === pageIdentities &&
      view.annotationHydrationAllowed === true && view.annotationSourceMismatch !== true &&
      document?.documentId === pending.documentId && document?.docKey === pending.docKey &&
      view.annotationSourceHash === pending.sourceHash &&
      pageIdentities?.[pending.pageNumber - 1] === pending.pageIdentity &&
      pageIdentities?.length === pending.pageCount;
    if (!document || document.documentId !== pending.documentId || document.docKey !== pending.docKey ||
        view.annotationSourceHash !== pending.sourceHash || !Array.isArray(pageIdentities) ||
        pageIdentities.length !== view.annotationPageIdentity.pageCount || pageIdentities.length !== pending.pageCount ||
        pageIdentities[pending.pageNumber - 1] !== pending.pageIdentity ||
        pending.capture.kind !== "selection" || pending.capture.pageNumber !== pending.pageNumber ||
        pending.capture.pageIdentity !== pending.pageIdentity || pending.capture.sourceHash !== pending.sourceHash) {
      throw Object.assign(new Error("当前 PDF 来源或选区身份已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });
    }
    if (!isCurrent()) throw Object.assign(new Error("Reader 会话已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });

    const runtime = await this.getVocabularyRuntime();
    await runtime.contexts.validateSentence({ familyKey: pending.familyKey,
      surface: pending.surface, sentence: pending.capture.exactQuote });
    if (!isCurrent()) throw Object.assign(new Error("Reader 会话已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });

    if (!pending.anchor) {
      const orderedPageIdentityDigest = await this.pdfHashRuntime.fingerprint(
        new TextEncoder().encode(JSON.stringify(pageIdentities)),
      );
      if (!isCurrent()) throw Object.assign(new Error("Reader 会话已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });
      const stableAnchorIdentity = { version: 1, docKey: pending.docKey, documentId: pending.documentId,
        sourceHash: pending.sourceHash, pageIdentity: pending.pageIdentity,
        textPosition: pending.capture.textPosition, exactQuote: pending.capture.exactQuote };
      const anchorId = `context-${canonicalHash(stableAnchorIdentity).slice("sha256-v1:".length)}`;
      let anchor = await this.readerAnchorStore.get(pending.docKey, anchorId, pending.documentId);
      if (!isCurrent()) throw Object.assign(new Error("Reader 会话已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });
      if (!anchor) {
        try {
          await this.readerAnchorStore.create({
            anchorId, docKey: pending.docKey, documentId: pending.documentId,
            sourceHash: pending.sourceHash, pageIdentity: pending.pageIdentity,
            pageIndexHint: pending.capture.pageIndex, pageCount: pending.pageCount,
            orderedPageIdentityDigest, textPosition: pending.capture.textPosition,
            exactQuote: pending.capture.exactQuote, prefix: pending.capture.prefix,
            suffix: pending.capture.suffix, geometry: pending.capture.geometry,
          });
        } catch (error) {
          // A concurrent request for this same stable selection may have won.
          // Read and verify its immutable result instead of generating a new ID.
          if (error?.code !== "READER_ANCHOR_ID_COLLISION") throw error;
        }
        if (!isCurrent()) throw Object.assign(new Error("Reader 会话已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });
        anchor = await this.readerAnchorStore.get(pending.docKey, anchorId, pending.documentId);
      }
      if (!anchor || anchor.docKey !== pending.docKey || anchor.documentId !== pending.documentId ||
          anchor.sourceHash !== pending.sourceHash || anchor.pageIdentity !== pending.pageIdentity ||
          anchor.textPosition?.start !== pending.capture.textPosition?.start ||
          anchor.textPosition?.end !== pending.capture.textPosition?.end ||
          anchor.exactQuote !== pending.capture.exactQuote ||
          anchor.orderedPageIdentityDigest !== orderedPageIdentityDigest || anchor.pageCount !== pending.pageCount) {
        throw Object.assign(new Error("相同语境身份对应的 Selection Anchor 内容不同，已停止保存。"), { code: "VOCAB_CONTEXT_ANCHOR_ID_COLLISION" });
      }
      if (!isCurrent()) throw Object.assign(new Error("Reader 会话已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });
      pending.anchor = anchor;
    }
    if (!isCurrent()) throw Object.assign(new Error("Reader 会话已变化；语境没有保存。"), { code: "VOCAB_CONTEXT_CAPTURE_STALE" });
    const result = await runtime.saveContext({ familyKey: pending.familyKey,
      surface: pending.surface, sentence: pending.capture.exactQuote, anchor: pending.anchor });
    if (result?.status === "conflict" || result?.reloadError) {
      throw Object.assign(new Error("语境文件发生外部变化；请重载后重新保存。"), { code: "VOCAB_CONTEXT_COMMIT_CONFLICT" });
    }
    if (!isCurrent()) {
      // The write may have committed while the view was closing. The data
      // remains durable, but the detached Reader must not receive a stale ack.
      globalThis.clearTimeout(pending.timer);
      view.pendingVocabularyContextCaptures.delete(pending.captureId);
      this.sessionLog?.record("vocabularyContext", { event: "save-finished-after-reader-change",
        status: result?.status || "committed" });
      return false;
    }
    globalThis.clearTimeout(pending.timer);
    view.pendingVocabularyContextCaptures.delete(pending.captureId);
    view.postToViewer({ channel: CHANNEL, token: view.token,
      type: "reader-vocabulary-context-save-result", requestId: pending.requestId,
      captureId: pending.captureId, documentId: pending.documentId, openRequest: pending.openRequest,
      ok: true, status: result?.status || "committed",
      message: result?.status === "existing" ? "这个出处已保存过，未重复写入。" : "语境已保存并验证。" });
    this.sessionLog?.record("vocabularyContext", { event: "saved", status: result?.status || "committed",
      pageIndex: pending.capture.pageIndex, sentenceChars: pending.capture.exactQuote.length });
    return true;
  }

  async copyReaderText(value) {
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard?.writeText) {
      await clipboard.writeText(value);
      return;
    }
    const doc = globalThis.document;
    const field = doc?.createElement?.("textarea");
    if (!field) throw new Error("当前环境不允许访问剪贴板。");
    field.value = value;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    doc.body.appendChild(field);
    field.select();
    const copied = doc.execCommand?.("copy") === true;
    field.remove();
    if (!copied) throw new Error("复制链接失败，请检查 Obsidian 剪贴板权限。");
  }

  async showReaderBacklinks(view, capture, identity) {
    if (!this.readerBacklinkIndexReady) await this.rebuildReaderBacklinkIndex();
    if (!view.isCurrentReaderAnchorIdentity(identity)) return;
    const document = view.annotationDocument;
    const pageIndex = capture.pageIndex;
    const pageIdentities = view.annotationPageIdentity?.orderedPageIdentities;
    const pageIdentity = pageIdentities?.[pageIndex];
    if (!document?.docKey || !pageIdentity || capture.pageIdentity !== pageIdentity ||
        capture.sourceHash !== view.annotationSourceHash) {
      new Notice("当前 PDF 页面身份尚未确认。", 5000);
      return;
    }
    const isCurrent = () => view.isCurrentReaderAnchorIdentity(identity) &&
      view.annotationDocument === document && view.annotationPageIdentity?.orderedPageIdentities === pageIdentities;
    const cached = await this.getReaderBacklinkPageIndex(view, identity);
    if (!cached || !isCurrent()) return;
    const rows = cached.value.forPage(pageIdentity).rows;
    if (!isCurrent()) return;
    new ReaderBacklinksModal(this.app, rows,
      (row) => { void this.openReaderBacklinkSource(row, { source: "page-modal" }); }).open();
    this.sessionLog?.record("readerBacklinks", { event: "page-query", pageIndex, resultCount: rows.length });
  }

  async reviewPdfAnnotationDevices() {
    const view = this.app.workspace.activeLeaf?.view;
    if (!(view instanceof PdfReaderView) || !view.annotationDocument) {
      new Notice("请先在 PDF 阅读器中打开并完成身份校验的 PDF。", 6000);
      return;
    }
    try {
      if (this.annotationHost.store.sourceProtocol?.startsWith("wal-sidecar-v3.")) {
        const { devices, errors } = await this.annotationHost.store.inspectDevices(view.annotationDocument);
        new Notice(`WAL v3.1：${devices.length} 个已验证设备分片，${errors.length} 个待恢复分片。此协议无需检查点 ACK 或设备退役。`, 8000);
        return;
      }
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
    this.learningHost?.dispose();
    for (const cleanup of [...(this.readerBacklinkFocusCleanups || [])]) cleanup();
    this.readerBacklinkFocusCleanups?.clear?.();
    this.vocabularyUnsubscribe?.();
    this.vocabularyUnsubscribe = null;
    this.vocabularyWorkbench?.close?.();
    this.clearVocabularyDictionaryTimers();
    this.readerSettingsTab?.dispose?.();
    void (async () => {
      try { await this.vocabularyRuntime?.close?.(); }
      catch (error) { this.sessionLog?.record("vocabulary", { event: "controlled-close-pending", code: error?.code || "vocabulary-close-failed" }); }
      finally {
        await Promise.allSettled([
          Promise.resolve().then(() => this.vocabularyService?.dispose?.()),
          Promise.resolve().then(() => this.vocabularyDictionary?.dispose?.()),
        ]);
      }
    })().catch(() => undefined);
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

  getVocabularyService() {
    if (!this.vocabularyService) {
      this.vocabularyService = new VocabularyService({ adapter: this.app.vault.adapter });
      this.vocabularyUnsubscribe = this.vocabularyService.subscribe((change) => {
        for (const view of this.views || []) view.refreshVocabularyPages?.(change);
      });
    }
    return this.vocabularyService;
  }

  async initializeVocabulary() {
    if (this.vocabularyInitialization) return this.vocabularyInitialization;
    const pending = (async () => {
      // Preserve the disabled-feature baseline: checking for a migration is
      // not permission to initialize an empty vocabulary/index/dictionary.
      const adapter = this.app.vault.adapter;
      if (!this.vocabularyService && !(await adapter.exists(VOCABULARY_PATH)) &&
          !(await adapter.exists(`${VOCABULARY_PATH}.previous`))) {
        return { migrated: false, schemaVersion: 2, revision: 0 };
      }
      if (this.isUnloading) return { cancelled: true };
      const service = this.getVocabularyService();
      await service.ready();
      if (this.isUnloading) return { cancelled: true };
      return service.migrate();
    })();
    this.vocabularyInitialization = pending;
    try { return await pending; }
    catch (error) {
      if (this.vocabularyInitialization === pending) this.vocabularyInitialization = null;
      throw error;
    }
  }

  async reloadVocabularyFromVault() {
    if (this.isUnloading) return false;
    this.vocabularyInitialization = null;
    const pending = (async () => {
      if (this.vocabularyService) await this.vocabularyService.reload();
      if (this.isUnloading) return false;
      return this.initializeVocabulary();
    })();
    this.vocabularyExternalReload = pending;
    return pending;
  }

  getVocabularyDictionary() {
    if (!this.vocabularyDictionary) {
      this.vocabularyDictionary = new VocabularyDictionary({
        adapter: this.app.vault.adapter,
        onStatus: (status) => applyVocabularyDictionaryStatus(this, status),
      });
      applyVocabularyDictionaryStatus(this, this.vocabularyDictionary.getStatus?.() || { phase: "idle", count: 0, total: 0 });
      if (this.readerSettingsTab?.isDisplayingVocabularySettings === true) {
        this.readerSettingsTab.observeVocabularyDictionary(this.vocabularyDictionary);
      }
    }
    return this.vocabularyDictionary;
  }

  getLearningHost() {
    if(this.isUnloading)throw new Error('阅读工作区正在关闭。');
    if(!this.learningHost)this.learningHost=createLearningHost({plugin:this,Modal,Notice});
    return this.learningHost;
  }

  getAnnotationSidebarService(view) {
    const current = () => this.views.has(view) && !view.teardownStarted &&
      view.annotationHydrationAllowed === true && !view.annotationSourceMismatch &&
      !view.annotationSyncPending && !view.annotationStorageUnavailable;
    const rows = () => current() ? (Array.isArray(view.annotationSnapshot?.annotations)
      ? view.annotationSnapshot.annotations : Object.values(view.annotationSnapshot?.annotations || {}))
      .filter(row => row.deleted !== true) : [];
    const get = uuid => rows().find(row => row.uuid === uuid) || null;
    const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
    return createAnnotationSidebarService({
      list: (query = {}) => copy(rows().filter(row => query.pageIndex == null || row.pageIndex === query.pageIndex)),
      get: uuid => copy(get(uuid)),
      navigate: async uuid => {
        if (!get(uuid)) return false;
        view.pendingReaderTarget = { kind: "annotation", id: uuid,
          docKey: view.annotationDocument.docKey, documentId: view.annotationDocument.documentId };
        return view.applyPendingReaderTarget();
      },
      createReviewDraft: uuid => {
        if (get(uuid)?.kind !== "Highlight") return false;
        return view.postToViewer({ channel: CHANNEL, token: view.token,
          type: "annotation-sidebar-review-draft", documentId: view.documentId,
          openRequest: view.openRequest, uuid });
      },
    });
  }

  getBacklinkService(view) {
    return createBacklinkService({
      resolve: (anchor, owner) => this.getLearningHost().resolveSource(anchor, owner),
      openPdfTarget: (anchor, owner) => this.getLearningHost().openPdfTarget(anchor, owner),
      openMarkdownSource: (anchor, owner) => this.getLearningHost().openMarkdownSource(anchor, owner),
      listSources: async anchor => {
        const target = anchor?.target;
        if (!target || !["annotation", "selection", "page"].includes(target.kind) ||
            typeof target.id !== "string" || !target.id || target.id.length > 512 ||
            !this.views.has(view) || view.teardownStarted || view.annotationHydrationAllowed !== true ||
            (anchor.documentId && anchor.documentId !== view.annotationDocument?.documentId) ||
            (anchor.docKey && anchor.docKey !== view.annotationDocument?.docKey)) return [];
        const identity = { documentId: view.documentId, openRequest: view.openRequest,
          rendererGeneration: view.rendererGeneration };
        let pageIdentity = anchor.pageIdentity;
        if (target.kind === "page") pageIdentity = target.id;
        else if (target.kind === "selection" && !pageIdentity) {
          pageIdentity = (await this.readerAnchorStore.get(view.annotationDocument.docKey,
            target.id, view.annotationDocument.documentId))?.pageIdentity;
        } else if (target.kind === "annotation" && !pageIdentity) {
          const row = this.getAnnotationSidebarService(view).get(target.id);
          pageIdentity = view.annotationPageIdentity?.orderedPageIdentities?.[row?.pageIndex];
        }
        const pageIndex = view.annotationPageIdentity?.orderedPageIdentities?.indexOf(pageIdentity);
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return [];
        const result = await this.collectReaderBacklinksForPage(view, pageIndex, identity);
        if (!result || !view.isCurrentReaderAnchorIdentity(identity)) return [];
        return result.rows.filter(row => row.target?.kind === target.kind && row.target?.id === target.id &&
          row.targetStatus !== "deleted");
      },
    });
  }

  async getVocabularyRuntime() {
    await this.initializeVocabulary();
    if (this.isUnloading) throw new Error("词汇工作台正在关闭。");
    if (!this.vocabularyRuntime) {
      const verify = createContextSourceVerifier({
        anchorStore: this.readerAnchorStore,
        documentStore: this.annotationHost.store,
        getFileByPath: (path) => this.app.vault.getAbstractFileByPath(path),
        hashOrderedPages: (pages) => this.pdfHashRuntime.fingerprint(new TextEncoder().encode(JSON.stringify(pages))),
        getVerifiedSource: (documentId, docKey, sourcePath) => {
          const view = [...this.views].find((entry) => entry.teardownStarted !== true &&
            entry.annotationHydrationAllowed === true && entry.annotationSourceMismatch !== true &&
            entry.annotationDocument?.documentId === documentId && entry.annotationDocument?.docKey === docKey &&
            (entry.documentFile?.path || entry.file?.path) === sourcePath);
          if (!view) return null;
          return { verified: true, documentId, docKey, sourcePath, sourceHash: view.annotationSourceHash,
            orderedPageIdentities: view.annotationPageIdentity?.orderedPageIdentities };
        },
      });
      this.vocabularyRuntime = createVocabularyRuntime({ adapter: this.app.vault.adapter,
        personalService: this.getVocabularyService(),
        deviceId: localVocabularyDeviceId({ storage: globalThis.localStorage, crypto: globalThis.crypto }),
        sessionId: makeToken(), verifySource: ({ anchor }) => verify(anchor) });
    }
    await this.vocabularyRuntime.ready();
    return this.vocabularyRuntime;
  }

  scheduleVocabularyDictionaryWarmup(delay = 0) {
    if (this.settings?.vocabularyEnabled !== true || this.isUnloading) return false;
    if (this.vocabularyDictionaryWarmupTimer != null) globalThis.clearTimeout(this.vocabularyDictionaryWarmupTimer);
    this.vocabularyDictionaryWarmupTimer = globalThis.setTimeout(() => {
      this.vocabularyDictionaryWarmupTimer = null;
      if (this.settings?.vocabularyEnabled !== true || this.isUnloading) return;
      let dictionary;
      try { dictionary = this.getVocabularyDictionary(); }
      catch (error) {
        applyVocabularyDictionaryStatus(this, { phase: "unavailable", count: 0, total: 0 });
        return;
      }
      Promise.resolve(dictionary.ensureReady?.()).catch(() => undefined);
    }, Math.max(0, Number(delay) || 0));
    return true;
  }

  scheduleVocabularyDictionaryRefresh(delay = 300) {
    if (this.settings?.vocabularyEnabled !== true || this.isUnloading) return false;
    if (this.vocabularyDictionaryRefreshTimer != null) globalThis.clearTimeout(this.vocabularyDictionaryRefreshTimer);
    this.vocabularyDictionaryRefreshTimer = globalThis.setTimeout(() => {
      this.vocabularyDictionaryRefreshTimer = null;
      if (this.settings?.vocabularyEnabled !== true || this.isUnloading) return;
      let dictionary;
      try { dictionary = this.getVocabularyDictionary(); }
      catch { return; }
      Promise.resolve(dictionary.ensureReady?.()).catch(() => undefined);
    }, Math.max(0, Number(delay) || 0));
    return true;
  }

  clearVocabularyDictionaryTimers() {
    if (this.vocabularyDictionaryWarmupTimer != null) globalThis.clearTimeout(this.vocabularyDictionaryWarmupTimer);
    if (this.vocabularyDictionaryRefreshTimer != null) globalThis.clearTimeout(this.vocabularyDictionaryRefreshTimer);
    this.vocabularyDictionaryWarmupTimer = null;
    this.vocabularyDictionaryRefreshTimer = null;
  }

  handleVocabularyDictionaryResourceChange(...paths) {
    if (!paths.some(isVocabularyDictionaryResourcePath)) return false;
    this.vocabularyDictionary?.invalidate?.();
    if (this.settings?.vocabularyEnabled === true) this.scheduleVocabularyDictionaryRefresh();
    return true;
  }

  async rebuildVocabularyDictionaryCache() {
    if (this.settings?.vocabularyEnabled !== true || this.isUnloading) return false;
    if (this.vocabularyDictionaryWarmupTimer != null) {
      globalThis.clearTimeout(this.vocabularyDictionaryWarmupTimer);
      this.vocabularyDictionaryWarmupTimer = null;
    }
    if (this.vocabularyDictionaryRefreshTimer != null) {
      globalThis.clearTimeout(this.vocabularyDictionaryRefreshTimer);
      this.vocabularyDictionaryRefreshTimer = null;
    }
    const dictionary = this.getVocabularyDictionary();
    await dictionary.rebuildCache();
    return true;
  }

  async importVocabulary(text, format, policy = {}) {
    if (typeof text === "string" && new TextEncoder().encode(text).byteLength > 64 * 1024 * 1024) {
      throw new RangeError("词汇导入超过 64 MiB 上限，未截断或写入数据。");
    }
    const runtime = await this.getVocabularyRuntime();
    if (format === "csv") return runtime.mutatePersonal((service) => service.importCsv(text, policy));
    return runtime.exclusive(async () => {
      const parsed = typeof text === "string" ? JSON.parse(text) : text;
      if (parsed?.kind === "pdf-reader-vocabulary-bundle") {
        await runtime.recoverReviewSessions();
        if (runtime.review.getStatus() && !runtime.review.getStatus().closed) await runtime.review.close();
        const result = await createVocabularyTransfer({ runtime }).importBundle(parsed, {
          overwriteExisting: policy.overwriteExisting === true, overwriteKnown: policy.overwriteKnown === true });
        if (result.status === "conflict" || result.reloadError) {
          throw Object.assign(new Error("导入遇到外部修改或重载校验失败；请重载并检查冲突，未确认导入完成。"), { code: "vocabulary-import-conflict" });
        }
        return result;
      }
      return runtime.personalService.importJson(text, policy);
    });
  }

  createVocabularyWorkbenchApi() {
    const get = () => this.getVocabularyRuntime();
    let reviewPagerPromise=null;
    const getReviewPager=()=>{
      if(!reviewPagerPromise){
        const pending=this.getLearningHost().createWorkbenchReviewPager();
        reviewPagerPromise=pending;
        pending.catch(()=>{if(reviewPagerPromise===pending)reviewPagerPromise=null;});
      }
      return reviewPagerPromise;
    };
    const invalidateReview=async()=>{if(reviewPagerPromise)await(await reviewPagerPromise).invalidate();};
    return {
      listFamilies: async (options) => this.getVocabularyService().listFamilies(options),
      getFamilyDetails: async (familyKey) => {
        const family = await this.getVocabularyService().getFamilyByKey(familyKey);
        if (!family) throw new Error("词条不存在，请刷新列表。");
        let dictionary = null, dictionaryUnavailable = false;
        try { dictionary = await this.getVocabularyDictionary().lookup(family.records?.[0]?.surface || family.surface || family.storageKey); }
        catch { dictionaryUnavailable = true; }
        return { family, dictionary, dictionaryUnavailable };
      },
      updateFamily: async ({ familyKey, surface, fields }) => {
        const runtime = await get();
        return runtime.mutatePersonal(async (service) => {
          const family = await service.getFamily(surface);
          if (!family || family.familyKey !== familyKey) throw new Error("词族身份已变化，请刷新后重试。");
          return service.upsertTerm(surface, fields);
        });
      },
      setReviewEnrollment: async (familyKeys, { enrolled }) => {
        if (!Array.isArray(familyKeys) || familyKeys.length < 1 || familyKeys.length > 100 ||
            familyKeys.some((key) => typeof key !== "string" || key.length > 4096) || typeof enrolled !== "boolean") {
          throw new RangeError("每次请选择 1 到 100 个有效词族。");
        }
        const runtime = await get();
        return runtime.exclusive(async () => {
          const review = await runtime.ensureReviewSession();
          const results = [];
          for (const familyKey of [...new Set(familyKeys)]) {
            const family = await runtime.personalService.getFamilyByKey(familyKey, { includeRecords: false });
            if (!family) { results.push({ familyKey, status: "missing" }); continue; }
            if (enrolled && family.status === 5) { results.push({ familyKey, status: "skipped-known" }); continue; }
            try { results.push({ familyKey, ...await review[enrolled ? "enroll" : "unenroll"](familyKey) }); }
            catch (error) { results.push({ familyKey, status: "error", error: error.message }); break; }
          }
          await review.flush();
          return { results };
        });
      },
      listContexts: async (familyKey, options) => (await get()).contexts.listFamily(familyKey, options),
      openContext: async (contextId) => this.openVocabularyContext(contextId),
      addContextToReview: async contextId=>{
        await this.getLearningHost().fromContextId(contextId);
        return {status:'draft',message:'学习草稿已打开；确认前不会加入复习。'};
      },
      openReviewSource: async ({providerId='vocabulary',itemId,familyKey}={})=>{
        if(providerId==='learning')return this.getLearningHost().openItemSource(itemId);
        if(providerId==='vocabulary')return this.getLearningHost().openVocabularySource(familyKey||itemId);
        throw new TypeError('复习来源类型无效。');
      },
      listDueReview: async (options) => {
        const pager=await getReviewPager();
        if(options?.cursor==null)await pager.invalidate();
        return pager.listDue(options);
      },
      applyReviewAction: async ({ kind, familyKey, itemId, providerId='vocabulary', actionId } = {}) => {
        if (!["remember", "forget", "skip"].includes(kind)) throw new TypeError("复习操作必须是 remember、forget 或 skip。");
        const id=itemId||familyKey;
        if(!['vocabulary','learning'].includes(providerId)||typeof id!=='string'||!id||id.length>4096)throw new TypeError('复习条目身份无效。');
        if (typeof actionId !== "string" || !actionId || actionId.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(actionId)) {
          throw new TypeError("复习操作需要稳定且安全的 action ID。");
        }
        return (await getReviewPager()).rate({providerId,itemId:id,kind,actionId});
      },
      listHistory: async () => ({ batches: await (await get()).history.listBatches() }),
      previewHistory: async (batchId, options) => {
        await this.getLearningHost().getService();
        return (await get()).history.previewRestore(batchId, options);
      },
      restoreHistory: async (batchId, { selectedCleanIds, deviceId } = {}) => {
        await this.getLearningHost().getService();
        const result=await(await get()).restore(batchId,{selected:selectedCleanIds,deviceId});
        if(result.status==='committed')await invalidateReview();
        return result;
      },
      importJson: (text, policy) => this.importVocabulary(text, "json", policy),
      importCsv: (text, policy) => this.importVocabulary(text, "csv", policy),
      exportCsv: () => this.getVocabularyService().exportCsv(),
      exportLearning:async format=>(await this.getLearningHost().getService()).exportItems(format),
      exportJson: async () => {
        const runtime = await get();
        return runtime.exclusive(async () => {
          await runtime.recoverReviewSessions();
          if (runtime.review.getStatus() && !runtime.review.getStatus().closed) await runtime.review.flush();
          return createVocabularyTransfer({ runtime }).exportBundle();
        });
      },
      close: async () => {
        await invalidateReview();
        await this.learningHost?.endReviewSession();
        if(this.vocabularyRuntime)await this.vocabularyRuntime.close();
      },
    };
  }

  async openVocabularyContext(contextId) {
    const runtime = await this.getVocabularyRuntime();
    const context = await runtime.contexts.getContext(contextId);
    if (!context) throw new Error("语境记录不存在或已失效。" );
    const anchor = await this.readerAnchorStore.get(context.docKey, context.anchorId, context.documentId);
    if (!anchor || anchor.exactQuote !== context.anchor.exactQuote ||
        anchor.sourceHash !== context.sourceFingerprint || anchor.pageIdentity !== context.pageIdentity) {
      throw new Error("Selection Anchor 缺失或身份不一致；没有按旧坐标或页码跳转。");
    }
    const route = await this.annotationHost.store.documentForIdentity({
      documentId: context.documentId, docKey: context.docKey,
    });
    if (!route || route.documentId !== context.documentId || route.docKey !== context.docKey ||
        route.source?.sourceHash !== anchor.sourceHash ||
        (Number.isSafeInteger(route.source?.pageCount) && route.source.pageCount !== anchor.pageCount)) {
      throw new Error("当前 PDF 路由与语境保存时的来源身份不一致；没有回退到旧路径。");
    }
    const file = route.sourcePath ? this.app.vault.getAbstractFileByPath(route.sourcePath) : null;
    if (!isPdfFile(file)) throw new Error("语境对应的 PDF 当前不存在；没有按旧路径猜测文件。");
    await this.openPdf(file, { kind: "selection", id: anchor.anchorId,
      docKey: anchor.docKey, documentId: anchor.documentId });
    return { status: "opening", message: "已打开当前文档路由；Reader 会再次验证 PDF 指纹和页面身份。" };
  }

  openVocabularyWorkbench() {
    if (this.isUnloading) return;
    if (this.vocabularyWorkbench) { this.vocabularyWorkbench.close(); this.vocabularyWorkbench = null; }
    this.vocabularyWorkbench = new VocabularyWorkbenchModal(this.app, this.createVocabularyWorkbenchApi());
    this.vocabularyWorkbench.open();
  }

  async setVocabularyEnabled(enabled) {
    this.settings.vocabularyEnabled = Boolean(enabled);
    if (!this.settings.vocabularyEnabled) {
      if (this.vocabularyDictionaryWarmupTimer != null) globalThis.clearTimeout(this.vocabularyDictionaryWarmupTimer);
      if (this.vocabularyDictionaryRefreshTimer != null) globalThis.clearTimeout(this.vocabularyDictionaryRefreshTimer);
      this.vocabularyDictionaryWarmupTimer = null;
      this.vocabularyDictionaryRefreshTimer = null;
      for (const view of this.views) view.cancelVocabularyWork();
    } else {
      this.scheduleVocabularyDictionaryWarmup();
    }
    try {
      await this.saveData(this.settings);
    } catch (error) {
      new Notice(`词汇设置无法保存：${error.message || error}`, 8000);
    } finally {
      for (const view of this.views) view.setVocabularyEnabled(this.settings.vocabularyEnabled);
      this.readerSettingsTab?.syncVocabularyEnabled(this.settings.vocabularyEnabled);
    }
  }

  async setVocabularyDisplayMode(mode) {
    this.settings.vocabularyDisplayMode = normalizeVocabularyDisplayMode(mode);
    try {
      await this.saveData(this.settings);
    } catch (error) {
      new Notice(`LingQ 显示模式无法保存：${error.message || error}`, 8000);
    } finally {
      for (const view of this.views) view.setVocabularyDisplayMode(this.settings.vocabularyDisplayMode);
      this.readerSettingsTab?.syncVocabularyDisplayMode(this.settings.vocabularyDisplayMode);
    }
  }

  async setVocabularyWordDisplayMode(mode) {
    if (!["whole", "roots"].includes(mode)) return false;
    // One plugin host serves multiple Reader windows. Serialize preference
    // writes so a late failure cannot roll back a newer confirmed choice.
    const update = async () => {
      const previous = this.settings.vocabularyWordDisplayMode;
      this.settings.vocabularyWordDisplayMode = mode;
      try {
        await this.saveData({ ...this.settings });
      } catch (error) {
        this.settings.vocabularyWordDisplayMode = previous;
        new Notice(`构词显示模式无法保存：${error.message || error}`, 8000);
      }
      for (const view of this.views) view.setVocabularyWordDisplayMode(this.settings.vocabularyWordDisplayMode);
      return this.settings.vocabularyWordDisplayMode === mode;
    };
    this.vocabularyWordModeQueue = (this.vocabularyWordModeQueue || Promise.resolve()).then(update, update);
    return this.vocabularyWordModeQueue;
  }

  async setLastAnnotationToolMode(mode) {
    const normalized = normalizeAnnotationToolMode(mode);
    if (!normalized) return false;
    this.settings.lastAnnotationToolMode = normalized;
    try {
      await this.saveData(this.settings);
      return true;
    } catch (error) {
      new Notice(`批注工具偏好无法保存：${error.message || error}`, 8000);
      return false;
    }
  }

  async setVocabularyHighlightLevelEnabled(type, status, enabled) {
    const key = type === "word" ? "words" : type === "phrase" ? "phrases" : null;
    if (!key || !Number.isInteger(status) || status < 1 || status > 5) return false;
    const levels = normalizeVocabularyHighlightLevels(this.settings.vocabularyHighlightLevels);
    const selected = new Set(levels[key]);
    if (enabled === true) selected.add(status);
    else selected.delete(status);
    levels[key] = [...selected].sort((a, b) => a - b);
    this.settings.vocabularyHighlightLevels = levels;
    try {
      await this.saveData(this.settings);
    } catch (error) {
      new Notice(`词汇高亮设置无法保存：${error.message || error}`, 8000);
    } finally {
      for (const view of this.views) view.setVocabularyHighlightLevels?.(levels);
      this.readerSettingsTab?.syncVocabularyLevels(levels);
    }
    return true;
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
    const sizeMb = (exported.bytes / 1_000_000).toFixed(2);
    const compacted = exported.omittedRecords
      ? `，压缩省略 ${exported.omittedRecords} 条（原始 ${exported.rawRecordCount} 条）`
      : `，${exported.recordCount} 条`;
    const completeness = exported.complete
      ? ""
      : "；详情与采集缺失计数见 JSON 的 runtimeLog 字段";
    new Notice(`已导出 PDF 阅读器诊断（${sizeMb}/64.00 MB${compacted}${completeness}）：${outputPath}`);
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
            { forceVerify, compactPath: Platform?.isWin === true },
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

  async handleReaderPdfFolderRename(folder, oldPath) {
    if (!Array.isArray(folder?.children) || typeof oldPath !== "string") return false;
    const from = normalizePath(oldPath).replace(/\/+$/g, "");
    const to = normalizePath(folder.path).replace(/\/+$/g, "");
    if (!from || !to || from === to) return false;
    const pending = [...folder.children];
    const seen = new Set();
    let changed = false;
    while (pending.length) {
      const file = pending.pop();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      if (Array.isArray(file.children)) { pending.push(...file.children); continue; }
      if (!isPdfFile(file) || !file.path.startsWith(`${to}/`)) continue;
      const priorPath = `${from}${file.path.slice(to.length)}`;
      // The existing host verifies whether this old path has an identity.
      // Descendant file rename events may also arrive; an already moved route
      // is a no-op. Never create a fresh PDF identity from a folder event.
      if (!await this.annotationHost.renamed(file, priorPath)) continue;
      changed = true;
      for (const view of this.views) view.onDocumentRenamed(file, priorPath);
    }
    return changed;
  }

  async openPdf(file, readerTarget = null) {
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
        state: { ...existingLeaf.view.getState(), readerTarget: normalizeReaderTarget(readerTarget) },
      });
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE,
      active: true,
      state: { path: file.path, ...(readerTarget ? { readerTarget: normalizeReaderTarget(readerTarget) } : {}) },
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
