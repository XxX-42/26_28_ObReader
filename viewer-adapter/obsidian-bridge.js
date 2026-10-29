/*
 * Obsidian host bridge for the packaged PDF.js viewer.
 *
 * The host inserts this classic script before viewer.mjs and supplies
 * data-channel and data-token attributes on the script element. Keeping this
 * script outside the upstream fork lets the Viewer run without its localhost
 * file server while retaining the fork's annotation editors and serializers.
 */
(() => {
  "use strict";

  const bridgeScript = document.currentScript;
  if (!bridgeScript || window.parent === window) {
    return;
  }

  const channel = bridgeScript.dataset.channel || "pdf-web-reader";
  const token = bridgeScript.dataset.token;
  const rendererGeneration =
    typeof bridgeScript.dataset.rendererGeneration === "string" &&
    bridgeScript.dataset.rendererGeneration
      ? bridgeScript.dataset.rendererGeneration
      : null;
  function performanceNow() {
    return globalThis.performance?.now?.() ?? Date.now();
  }
  const iosInputPolicy = bridgeScript.dataset.iosInputPolicy === "true";
  const vocabularyEnabledAtBoot = bridgeScript.dataset.vocabularyEnabled === "true";
  const VOCABULARY_DISPLAY_MODES = ["all", "learning", "focus"];
  const VOCABULARY_DISPLAY_LABELS = Object.freeze({
    all: "全部等级", learning: "学习中（1–4）", focus: "重点（1–3）",
  });
  const PERSISTABLE_ANNOTATION_TOOL_MODES = new Set([3, 5, 9, 10, 15]);
  function normalizeVocabularyDisplayMode(value) {
    return VOCABULARY_DISPLAY_MODES.includes(value) ? value : "all";
  }
  function normalizeAnnotationToolMode(value) {
    return Number.isInteger(value) && PERSISTABLE_ANNOTATION_TOOL_MODES.has(value) ? value : 0;
  }
  function normalizeVocabularyHighlightLevels(value) {
    const normalize = (items) => Array.isArray(items)
      ? [...new Set(items.filter((item) => Number.isInteger(item) && item >= 1 && item <= 5))].sort((a, b) => a - b)
      : [1, 2, 3, 4, 5];
    return { words: normalize(value?.words), phrases: normalize(value?.phrases) };
  }
  function readVocabularyHighlightLevels(value) {
    try { return normalizeVocabularyHighlightLevels(JSON.parse(value || "{}")); }
    catch { return normalizeVocabularyHighlightLevels(null); }
  }
  const vocabularyHighlightLevelsAtBoot = readVocabularyHighlightLevels(bridgeScript.dataset.vocabularyHighlightLevels);
  const AUTO_SAVE_IDLE_DELAY_MS = iosInputPolicy ? 3000 : 1000;
  const IOS_AUTO_SAVE_MIN_INTERVAL_MS = 10000;
  const IOS_AUTO_SAVE_MAX_INTERVAL_MS = 30000;
  const HEAVY_LEASE_TIMEOUT_MS = 120000;
  const SAVE_RETRY_AFTER_IDLE = Symbol("save-retry-after-idle");
  const POINTER_DIAGNOSTIC_LIMIT = 32;
  const DEFERRED_ACCESSIBILITY_MOVE_LIMIT = 8;
  if (!token) {
    console.error("PDF Reader bridge is missing its session token.");
    return;
  }

  const viewerBaseUrl = new URL(
    bridgeScript.dataset.baseUrl || ".",
    bridgeScript.src || document.baseURI,
  );
  const state = {
    app: null,
    pdfJsOpen: null,
    pdfJsClose: null,
    configured: false,
    disposed: false,
    ready: false,
    activeDocumentId: null,
    activeDocumentPath: null,
    activeFilename: null,
    activeOpenRequest: null,
    requestedOpenRequest: null,
    requestedDocumentId: null,
    pendingVocabularySettings: null,
    readOnly: false,
    autoSaveEnabled: true,
    autoSavePaused: false,
    autoSaveTimer: null,
    autoSavePending: false,
    lastAutoSaveStartedAt: null,
    lastAutoSaveDurationMs: 0,
    hostHeavyLeaseRequired: false,
    heavyLeaseSequence: 0,
    heavyLeaseWaiters: new Map(),
    cancelledHeavyLeaseRequests: new Map(),
    heavyLeaseCleanupTimer: null,
    pendingInkCommit: false,
    committingInkForSave: false,
    dirty: false,
    viewportController: null,
    iosDirectManipulationController: null,
    textSelectionController: null,
    annotationController: null,
    pointerDiagnostics: {
      total: 0,
      dropped: 0,
      samples: [],
    },
    editorHistory: {
      canUndo: false,
      canRedo: false,
      hasSelection: false,
    },
    bridgeControls: null,
    annotationSidebarController: null,
    annotationSidebarTextGeometryCache: new WeakMap(),
    annotationTargetTextByRuntimeId: new Map(),
    pendingHighlightSelection: null,
    toolbarLayoutResizeObserver: null,
    toolbarLayoutMutationObserver: null,
    toolbarLayoutFrame: 0,
    isComposing: false,
    compositionEndPending: false,
    freeTextFocused: false,
    freeTextCommittedForSave: false,
    freeTextInputPending: false,
    freeTextFocusGeneration: 0,
    freeTextCommitReady: false,
    preparingContentForSave: false,
    manualSaveQueued: false,
    manualCommitQueued: false,
    manualSaveWaiters: [],
    inputBoundaryWaiters: [],
    deferredTimers: new Set(),
    editorMode: 0,
    revision: 0,
    confirmedRevision: 0,
    openQueue: Promise.resolve(),
    openSession: null,
    openSessionSequence: 0,
    queuedOpens: [],
    savePromise: null,
    recoveryPromise: null,
    recoveryCloseIntent: false,
    manualSaveRequestedDuringFlight: false,
    pendingSave: null,
    pendingRecovery: null,
    syncState: null,
    syncActorId: null,
    syncDeviceId: null,
    compactInkEncoding: false,
    externalAnnotationRows: new Map(),
    externalAnnotationHydration: new Map(),
    externalAnnotationRefs: new Set(),
    externalAnnotationLayerObserver: null,
    nativeAnnotationLayersPending: false,
    nativeAnnotationGateToken: null,
    externalSource: null,
    externalSourceConfirmed: false,
    actualSourceIdentity: null,
    externalSourceMismatch: false,
    hydratingExternalAnnotations: false,
    pendingExternalAnnotationsUpdate: null,
    annotationUuidByRuntimeId: new Map(),
    annotationRefByRuntimeId: new Map(),
    annotationUuidByPdfRef: new Map(),
    annotationRuntimeBindings: new Map(),
    annotationProvenanceByUuid: new Map(),
    annotationTrackingFailure: null,
    annotationSnapshot: new Map(),
    externalDeletionGuards: new Map(),
    annotationOperations: [],
    dirtyAnnotationRevisions: new Map(),
    dirtyPageRevisions: new Map(),
    dirtyNewAnnotationIds: new Set(),
    dirtyDeletedAnnotationIds: new Set(),
    pendingBulkDeletedUuids: new Set(),
    embeddedDeletionTargets: new Map(),
    embeddedDeletionScan: null,
    bulkDeleteDialog: null,
    bulkDeleteInProgress: false,
    // A saved editor restored by Undo can be live in the editor manager while
    // PDF.js omits it from AnnotationStorage because it is unchanged against
    // the loaded PDF base. Keep that exact saved identity until Redo removes
    // the editor or the document is replaced.
    restoredSavedAnnotations: new Map(),
    syncClockTimestamp: 0,
    syncClockLogical: 0,
    syncOperationSequence: 0,
    syncCheckpointInProgress: false,
    syncCheckpointPromise: null,
    syncCheckpointRequests: new Set(),
    syncApplyControl: null,
    syncApplyInertState: null,
    openStartupObserverCleanup: null,
    closeControl: null,
    closeInertState: null,
    lastRecoveredDocumentId: null,
    lastRecoveredRevision: null,
    lastCloseWritebackAck: null,
    saveSequence: 0,
    recoverySequence: 0,
    storageCleanup: null,
    editorManagerCleanup: null,
    accessibilityManagerCleanup: null,
    accessibilityManagers: new WeakSet(),
    accessibilityEditorLayers: new WeakSet(),
    deferredAccessibilityMoves: new Map(),
    pendingFreeTextAppearanceRepair: null,
    statusTimer: null,
    statusElement: null,
    readOnlyButtonStates: null,
    inputRouter: null,
    pointerAbortController: null,
    eventAbortController: null,
    localOpenAbortController: null,
    startupTimer: null,
    startupFailed: false,
    vocabularyEnabled: vocabularyEnabledAtBoot,
    vocabularyHighlightLevels: vocabularyHighlightLevelsAtBoot,
    vocabularyDisplayMode: normalizeVocabularyDisplayMode(bridgeScript.dataset.vocabularyDisplayMode),
    vocabularyWordDisplayMode: bridgeScript.dataset.vocabularyWordDisplayMode === "roots" ? "roots" : "whole",
    readerBacklinkHighlights: null,
    readerBacklinkPageKey: null,
    readerBacklinkPageResults: null,
    readerBacklinkRequestSequence: 0,
    readerBacklinkActiveRequest: null,
    readerBacklinkRetryTimer: null,
    backlinkInteractionController: null,
    preferredAnnotationToolMode: 0,
    restoredAnnotationToolIdentity: null,
    vocabularyReadModeToolChoice: null,
    vocabularyController: null,
  };

  const wheelToolKeys = new Map([[3, "freetext"], [5, "square"], [9, "highlight"], [10, "underline"], [15, "ink"]]);
  const wheelToolModes = new Map([...wheelToolKeys].map(([mode, key]) => [key, mode]));
  const annotationToolColors = window.PdfReaderInputRuntime?.AnnotationToolColors && new window.PdfReaderInputRuntime.AnnotationToolColors({
    getManager: () => state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager,
    getEventBus: () => state.app?.eventBus,
    getIdentity: () => ({ documentId: state.activeDocumentId, openRequest: state.activeOpenRequest, rendererGeneration }),
    getFallbackColor: (mode) => {
      const manager = state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      if (!manager?.hasSelection && !manager?.getActive?.()) {
        const id = new Map([[3, "editorFreeTextColor"], [5, "editorSquareColor"], [10, "editorUnderlineColor"], [15, "editorInkColor"]]).get(mode);
        const value = id && document.getElementById(id)?.value;
        if (value) return value;
      }
      return mode === 9 ? "#FFFF98" : "#000000";
    },
    postPreference: (mode, color) => postToHost("annotation-tool-color-preference-request", {
      mode, color, documentId: state.activeDocumentId, openRequest: state.activeOpenRequest,
    }),
  });
  const wheelColors = window.PdfReaderInputRuntime?.ToolWheelColorController && new window.PdfReaderInputRuntime.ToolWheelColorController({
    getWheel: () => (state.app || window.PDFViewerApplication)?._toolWheel,
    getToolKey: item => wheelToolKeys.get(item.mode),
    getColor: key => annotationToolColors?.get(wheelToolModes.get(key)),
    commit: ({ item, color, wheel }) => {
      const app = state.app;
      if (!app || app._toolWheel !== wheel || state.readOnly || state.disposed || item.disabled) return;
      app._toolWheel = null;
      app._toolWheelPointer = null;
      app._toolWheelSuppressUntil = performanceNow() + 1000;
      app.eventBus.dispatch("hideannotationeditorparams", { source: window });
      app.eventBus.dispatch("switchannotationeditormode", { source: window, mode: item.mode, isFromKeyboard: true, createNewEditor: false });
      annotationToolColors?.choose(item.mode, color);
    },
  });
  wheelColors?.install();
  if (document.documentElement?.dataset) {
    document.documentElement.dataset.vocabularyEnabled = String(state.vocabularyEnabled === true);
  }
  if (iosInputPolicy) {
    document.documentElement.dataset.pdfReaderIosInputPolicy = "true";
  }
  // Diagnostic-only channel. Batches contain metadata, never PDF bytes or text.
  const runtimeLogStarted = performance.now();
  let runtimeLogRows = [], runtimeLogBytes = 0, runtimeLogLost = 0, runtimeLogSequence = 0, runtimeLogClosed = false, runtimeLogClosing = false;
  const runtimeLogHighFrequencySampleEvery = 64;
  const runtimeLogEventSamples = { pointermove: 0, mousemove: 0, wheel: 0, scroll: 0, touchmove: 0 };
  const runtimeLogListeners = [];
  function runtimeLogRecord(kind, fields = {}) {
    if (runtimeLogClosed) return;
    try {
      const row = JSON.stringify({ time: new Date().toISOString(), elapsedMs: +(performance.now() - runtimeLogStarted).toFixed(3), seq: ++runtimeLogSequence, kind, revision: state.revision, ...fields });
      if (runtimeLogBytes + row.length > 262144) { runtimeLogLost++; return; }
      runtimeLogRows.push(row); runtimeLogBytes += row.length;
    } catch { runtimeLogLost++; }
  }
  function runtimeLogTake() {
    if (runtimeLogLost) { runtimeLogRows.push(JSON.stringify({ kind: "log-loss", dropped: runtimeLogLost })); runtimeLogLost = 0; }
    const rows = runtimeLogRows; runtimeLogRows = []; runtimeLogBytes = 0;
    return rows;
  }
  window.__PDF_READER_DRAIN_LOG__ = runtimeLogTake;
  function runtimeLogFlush() {
    const pending = runtimeLogTake();
    while (pending.length) {
      const rows = pending.splice(0, 256);
      try { window.parent.postMessage({ channel, token, rendererGeneration, type: "runtime-log", rows }, "*"); }
      catch { runtimeLogLost += rows.length + pending.length; break; }
    }
  }
  function runtimeLogError(error) { return { name: String(error?.name || "Error"), message: String(error?.message ?? error).slice(0, 4096), stack: String(error?.stack || "").slice(0, 8192) }; }
  function runtimeLogListen(type, fn) { window.addEventListener(type, fn, true); runtimeLogListeners.push([type, fn]); }
  const runtimeLogConsoleRestore = [];
  for (const level of ["warn", "error"]) {
    const original = console[level];
    console[level] = function (...args) {
      try { runtimeLogRecord(`console.${level}`, { fn: `Viewer.console.${level}`, message: typeof args[0] === "string" ? args[0].slice(0, 4096) : undefined, error: args.find(value => value instanceof Error) ? runtimeLogError(args.find(value => value instanceof Error)) : undefined }); } catch { /* Keep console behavior. */ }
      return original.apply(this, args);
    };
    runtimeLogConsoleRestore.push([level, original, console[level]]);
  }
  for (const type of ["click", "dblclick", "contextmenu", "pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "keydown", "input", "change", "compositionstart", "compositionend", "scroll"]) {
    runtimeLogListen(type, event => {
      // Input diagnostics are observational. Sampling high-rate events keeps
      // instrumentation from adding synchronous JSON work to scroll/drag.
      if (Object.hasOwn(runtimeLogEventSamples, type) &&
          (runtimeLogEventSamples[type]++ % runtimeLogHighFrequencySampleEvery) !== 0) return;
      runtimeLogRecord("user", { event: type, trusted: event.isTrusted === true, target: event.target?.id || event.target?.tagName || "window", pointerType: event.pointerType, pointerId: event.pointerId, button: event.button, buttons: event.buttons, x: event.clientX, y: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY, key: type === "keydown" ? (/^(Enter|Escape|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Shift|Control|Alt|Meta|CapsLock|Dead|Process|Unidentified|F[0-9]{1,2})$/.test(event.key || "") ? event.key : "character") : undefined, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, scrollTop: type === "scroll" ? event.target?.scrollTop : undefined });
    });
  }
  runtimeLogListen("error", event => runtimeLogRecord("error", { error: runtimeLogError(event.error || event.message), source: event.filename, line: event.lineno, column: event.colno }));
  runtimeLogListen("unhandledrejection", event => runtimeLogRecord("unhandledrejection", { error: runtimeLogError(event.reason) }));
  const runtimeLogTimer = setInterval(runtimeLogFlush, 1000);
  runtimeLogRecord("viewer.start", { highFrequencyInputSampleEvery: runtimeLogHighFrequencySampleEvery });
  function runtimeLogClose() {
    if (runtimeLogClosing) return;
    runtimeLogClosing = true;
    clearInterval(runtimeLogTimer);
    for (const [level, original, wrapped] of runtimeLogConsoleRestore) if (console[level] === wrapped) console[level] = original;
    for (const [type, fn] of runtimeLogListeners.splice(0)) window.removeEventListener(type, fn, true);
    Promise.resolve().then(() => { runtimeLogRecord("viewer.end"); runtimeLogClosed = true; runtimeLogFlush(); });
  }
  function postToHost(type, fields = {}, transfer = []) {
    if (type === "close-prepared" || type === "flushed") runtimeLogFlush();
    if (state.disposed) {
      return false;
    }
    try {
      window.parent.postMessage(
        { channel, type, token, rendererGeneration, ...fields },
        "*",
        transfer,
      );
      return true;
    } catch (error) {
      console.error("PDF Reader bridge could not message its host:", error);
      return false;
    }
  }

  function postLifecycleToHost(type) {
    try {
      window.parent.postMessage(
        { channel, type, token, rendererGeneration },
        "*",
      );
      return true;
    } catch (error) {
      console.error("PDF Reader bridge could not report renderer lifecycle:", error);
      return false;
    }
  }

  function pageElementForIndex(pageIndex) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return null;
    return state.app?.pdfViewer?.getPageView?.(pageIndex)?.div || null;
  }

  function textLayerForPage(pageRoot) {
    return pageRoot?.querySelector?.(".textLayer") || null;
  }

  function annotationSidebarTextGlyphs(textLayer, pageRoot, viewport) {
    const ownerDocument = textLayer?.ownerDocument;
    const pageRect = pageRoot?.getBoundingClientRect?.();
    if (!ownerDocument?.createTreeWalker || !ownerDocument?.createRange ||
        !pageRect?.width || !pageRect?.height || !viewport?.width || !viewport?.height ||
        typeof viewport.convertToViewportPoint !== "function") return null;
    const cacheKey = [viewport.scale, viewport.rotation, viewport.width, viewport.height,
      pageRect.width, pageRect.height, textLayer.textContent?.length].join(":");
    const cached = state.annotationSidebarTextGeometryCache?.get(textLayer);
    if (cached?.key === cacheKey) return cached.glyphs;
    const glyphs = [];
    const walker = ownerDocument.createTreeWalker(textLayer, 4);
    const range = ownerDocument.createRange();
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest?.(".endOfContent")) continue;
      const value = typeof node.nodeValue === "string" ? node.nodeValue : "";
      let offset = 0;
      for (const character of value) {
        const start = offset;
        offset += character.length;
        let rects = [];
        try {
          range.setStart(node, start);
          range.setEnd(node, offset);
          rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
            .map(rect => ({
              left: rect.left - pageRect.left,
              top: rect.top - pageRect.top,
              right: rect.right - pageRect.left,
              bottom: rect.bottom - pageRect.top,
            }));
        } catch {
          // A stale text node should not block opening the annotation list.
          rects = [];
        }
        glyphs.push({ character, rects });
      }
    }
    state.annotationSidebarTextGeometryCache?.set(textLayer, { key: cacheKey, glyphs });
    return glyphs;
  }

  function recoverHighlightTextFromTextLayer(textLayer, pageRoot, viewport, rawQuadPoints) {
    const quadPoints = ArrayBuffer.isView(rawQuadPoints)
      ? Array.from(rawQuadPoints)
      : Array.isArray(rawQuadPoints) ? rawQuadPoints
        : Array.isArray(rawQuadPoints?.values) ? rawQuadPoints.values : null;
    if (!textLayer || !pageRoot || !viewport || !quadPoints || quadPoints.length < 8 ||
        quadPoints.length % 8 !== 0) return null;
    const pageRect = pageRoot.getBoundingClientRect?.();
    if (!pageRect?.width || !pageRect?.height || !viewport.width || !viewport.height) return null;
    const scaleX = pageRect.width / viewport.width;
    const scaleY = pageRect.height / viewport.height;
    const quads = [];
    for (let index = 0; index < quadPoints.length; index += 8) {
      const points = [];
      for (let point = 0; point < 8; point += 2) {
        const x = quadPoints[index + point];
        const y = quadPoints[index + point + 1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        let viewportPoint;
        try { viewportPoint = viewport.convertToViewportPoint(x, y); }
        catch { return null; }
        if (!Array.isArray(viewportPoint) || viewportPoint.length < 2 ||
            !Number.isFinite(viewportPoint[0]) || !Number.isFinite(viewportPoint[1])) return null;
        points.push([viewportPoint[0] * scaleX, viewportPoint[1] * scaleY]);
      }
      const left = Math.min(...points.map(point => point[0]));
      const right = Math.max(...points.map(point => point[0]));
      const top = Math.min(...points.map(point => point[1]));
      const bottom = Math.max(...points.map(point => point[1]));
      if (!(right > left && bottom > top)) return null;
      quads.push({ left, right, top, bottom });
    }
    const glyphs = annotationSidebarTextGlyphs(textLayer, pageRoot, viewport);
    if (!glyphs?.length) return null;
    const textRects = glyphs.map(glyph => glyph.rects);
    const lines = [];
    for (const quad of quads) {
      let line = lines.find(candidate => {
        const overlap = Math.min(candidate.bottom, quad.bottom) - Math.max(candidate.top, quad.top);
        return overlap > 0 && overlap / Math.min(candidate.bottom - candidate.top, quad.bottom - quad.top) >= 0.45;
      });
      if (!line) {
        line = { ...quad, quads: [quad] };
        lines.push(line);
      } else {
        line.top = Math.min(line.top, quad.top);
        line.bottom = Math.max(line.bottom, quad.bottom);
        line.quads.push(quad);
      }
    }
    lines.sort((left, right) => left.top - right.top || left.left - right.left);

    // A glyph can overlap adjacent Highlight lines because PDF.js quads and
    // DOM font rectangles have different vertical extents. Assign it once to
    // the eligible line with the greatest vertical overlap before assembling text.
    const glyphLineOwners = glyphs.map((glyph, index) => {
      if (/^\s+$/u.test(glyph.character)) return null;
      let owner = null;
      let bestOverlap = -1;
      for (const line of lines) {
        for (const rect of textRects[index]) {
          const width = rect.right - rect.left;
          const height = rect.bottom - rect.top;
          if (!(width > 0 && height > 0)) continue;
          for (const quad of line.quads) {
            const overlapWidth = Math.max(0, Math.min(rect.right, quad.right) - Math.max(rect.left, quad.left));
            const centerX = (rect.left + rect.right) / 2;
            const centerY = (rect.top + rect.bottom) / 2;
            if (centerY < quad.top - 1 || centerY > quad.bottom + 1 ||
                !(overlapWidth / width >= 0.35 || (centerX >= quad.left && centerX <= quad.right))) continue;
            const overlap = Math.max(0, Math.min(rect.bottom, quad.bottom) - Math.max(rect.top, quad.top)) / height;
            if (overlap > bestOverlap) { bestOverlap = overlap; owner = line; }
          }
        }
      }
      return owner;
    });
    const fragments = [];
    for (const line of lines) {
      const selected = new Set();
      for (let index = 0; index < glyphs.length; index += 1) {
        if (glyphLineOwners[index] === line) selected.add(index);
      }
      if (!selected.size) continue;
      const indexes = [...selected].sort((left, right) => left - right);
      const first = indexes[0];
      const last = indexes.at(-1);
      let value = "";
      let previousGlyph = null;
      for (let index = first; index <= last; index += 1) {
        const glyph = glyphs[index];
        if (selected.has(index)) {
          const rect = glyph.rects[0];
          if (previousGlyph && rect && previousGlyph.rect) {
            const gap = Math.max(0, rect.left - previousGlyph.rect.right, previousGlyph.rect.left - rect.right);
            const fontHeight = Math.min(rect.bottom - rect.top,
              previousGlyph.rect.bottom - previousGlyph.rect.top);
            if (gap > Math.max(1, fontHeight * 0.24) && !/\s$/u.test(value)) value += " ";
          }
          value += glyph.character;
          previousGlyph = { rect };
        } else if (/^\s+$/u.test(glyph.character) &&
            [...selected].some(selectedIndex => selectedIndex < index) &&
            [...selected].some(selectedIndex => selectedIndex > index)) {
          value += glyph.character;
        }
      }
      const fragment = value.replace(/\s+/gu, " ").trim();
      if (fragment) fragments.push(fragment);
    }
    const recovered = fragments.join("\n").trim();
    return recovered || null;
  }

  function getLegacyHighlightSidebarTargetText(pageIndex, editorPayload) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || !editorPayload) return null;
    const pageView = state.app?.pdfViewer?.getPageView?.(pageIndex);
    const pageRoot = pageElementForIndex(pageIndex);
    const textLayer = textLayerForPage(pageRoot);
    return recoverHighlightTextFromTextLayer(textLayer, pageRoot, pageView?.viewport,
      editorPayload.quadPoints);
  }

  function readerPageNumberForRoot(pageRoot) {
    if (!pageRoot) return null;
    // PDF.js page divs normally have no id; data-page-number is their page
    // label. Confirm the DOM root against the current viewer before using it
    // to select a verified page identity. Preserve legacy ids only when they
    // agree with that same viewer-owned root.
    const dataNumber = pageRoot.dataset?.pageNumber ?? pageRoot.getAttribute?.("data-page-number");
    const legacy = /^page([1-9]\d*)$/i.exec(pageRoot.id || "");
    const value = dataNumber ?? legacy?.[1];
    if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
    const pageNumber = Number(value);
    if (!Number.isSafeInteger(pageNumber) ||
        (legacy && Number(legacy[1]) !== pageNumber) ||
        pageElementForIndex(pageNumber - 1) !== pageRoot) return null;
    return pageNumber;
  }

  function captureReaderSelection() {
    const selected = state.textSelectionController?.rangeSnapshot?.();
    if (!selected?.text) return null;
    const textLayer = selected.startContainer?.nodeType === 1
      ? selected.startContainer.closest?.(".textLayer")
      : selected.startContainer?.parentElement?.closest?.(".textLayer");
    const endTextLayer = selected.endContainer?.nodeType === 1
      ? selected.endContainer.closest?.(".textLayer")
      : selected.endContainer?.parentElement?.closest?.(".textLayer");
    if (!textLayer || textLayer !== endTextLayer) return null;
    const pageRoot = textLayer.closest?.(".page");
    const pageNumber = readerPageNumberForRoot(pageRoot);
    const actual = state.actualSourceIdentity;
    const pageIndex = pageNumber - 1;
    const pageIdentity = actual?.orderedPageIdentities?.[pageIndex];
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || typeof pageIdentity !== "string") return null;
    const stableRange = state.textSelectionController?.captureRangeAnchor?.(textLayer, selected, pageRoot);
    if (!stableRange) return null;
    return {
      kind: "selection",
      pageNumber,
      pageIndex,
      pageIdentity,
      sourceHash: actual.sourceHash,
      ...stableRange,
    };
  }

  function captureReaderOccurrence(pageNumber, startIndex, endIndex, expectedSurface) {
    const controller = state.vocabularyController;
    const range = controller?.rangeForOccurrence?.(pageNumber, startIndex, endIndex, expectedSurface);
    if (!range) return null;
    const textLayer = range.startContainer?.nodeType === 1
      ? range.startContainer.closest?.(".textLayer")
      : range.startContainer?.parentElement?.closest?.(".textLayer");
    const endTextLayer = range.endContainer?.nodeType === 1
      ? range.endContainer.closest?.(".textLayer")
      : range.endContainer?.parentElement?.closest?.(".textLayer");
    if (!textLayer || textLayer !== endTextLayer) return null;
    const pageRoot = textLayer.closest?.(".page");
    const parsedPageNumber = readerPageNumberForRoot(pageRoot);
    const actual = state.actualSourceIdentity;
    const pageIndex = parsedPageNumber - 1;
    const pageIdentity = actual?.orderedPageIdentities?.[pageIndex];
    if (parsedPageNumber !== pageNumber || !Number.isSafeInteger(pageIndex) || pageIndex < 0 ||
        typeof pageIdentity !== "string") return null;
    const stableRange = state.textSelectionController?.captureRangeAnchor?.(textLayer, {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      text: range.toString?.() || "",
      rect: range.getBoundingClientRect?.() || null,
    }, pageRoot);
    if (!stableRange) return null;
    return {
      kind: "selection", pageNumber, pageIndex, pageIdentity,
      sourceHash: actual.sourceHash,
      ...stableRange,
    };
  }

  function captureReaderAnchor(mode, occurrence = null) {
    const app = state.app;
    const actual = state.actualSourceIdentity;
    if (!app?.pdfViewer || !actual || actual.identityStatus !== "KNOWN") return { error: "PDF 页面身份尚未确认。" };
    if (mode === "annotation") {
      const selected = Array.from(document.querySelectorAll(".annotationEditorLayer .selectedEditor, .annotationEditorLayer [aria-selected='true']"));
      if (selected.length !== 1) return { error: "请先选中一个批注，再复制批注链接。" };
      const runtimeId = selected[0].id;
      const uuid = state.annotationUuidByRuntimeId.get(String(runtimeId));
      const editor = app.pdfViewer?._layerProperties?.annotationEditorUIManager?.getEditor?.(runtimeId);
      const pageIndex = editor?.pageIndex;
      const pageIdentity = actual.orderedPageIdentities?.[pageIndex];
      if (!uuid || !Number.isSafeInteger(pageIndex) || !pageIdentity) return { error: "无法确认所选批注的稳定 UUID。" };
      return { capture: { kind: "annotation", annotationUuid: uuid, pageIndex,
        pageNumber: pageIndex + 1, pageIdentity, sourceHash: actual.sourceHash } };
    }
    if (mode === "quote" || mode === "reader") {
      const selected = captureReaderSelection();
      if (selected) return { capture: selected };
      if (mode === "quote") return { error: "请先在同一 PDF 页面选择一段文本。" };
    }
    if (mode === "occurrence") {
      const capture = captureReaderOccurrence(occurrence?.pageNumber, occurrence?.startIndex,
        occurrence?.endIndex, occurrence?.expectedSurface);
      if (!capture) return { error: "无法稳定读取当前 LingQ 词汇位置，请重新打开词条后重试。" };
      return { capture };
    }
    const pageNumber = app.pdfViewer.currentPageNumber;
    const pageIndex = Number.isSafeInteger(pageNumber) ? pageNumber - 1 : -1;
    const pageIdentity = actual.orderedPageIdentities?.[pageIndex];
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || !pageIdentity) return { error: "当前页身份无法确认。" };
    return { capture: { kind: "page", pageNumber, pageIndex, pageIdentity, sourceHash: actual.sourceHash } };
  }

  function sendReaderAnchorCapture(requestId, mode, occurrence = null) {
    const result = captureReaderAnchor(mode, occurrence);
    postToHost("reader-anchor-capture", {
      requestId,
      mode,
      documentId: state.activeDocumentId,
      openRequest: state.activeOpenRequest,
      ...(result.capture ? { capture: result.capture } : { error: result.error || "目标不可用。" }),
    });
  }

  function clearTemporaryReaderAnchorFocus() {
    if (state.readerAnchorFocusTimer) clearTimeout(state.readerAnchorFocusTimer);
    state.readerAnchorFocusTimer = null;
    state.readerAnchorFocusPage?.classList?.remove?.("pdfReaderAnchorFocusPage");
    state.readerAnchorFocusPage = null;
    try { window.CSS?.highlights?.delete?.("pdfReaderAnchorFocusText"); } catch {}
    state.readerAnchorFocusFallbackNodes?.forEach((node) => node.remove?.());
    state.readerAnchorFocusFallbackNodes = null;
  }

  function showTemporaryReaderAnchorFocus(pageRoot, range = null) {
    clearTemporaryReaderAnchorFocus();
    if (!pageRoot) return false;
    if (!range) {
      pageRoot.classList?.add?.("pdfReaderAnchorFocusPage");
      state.readerAnchorFocusPage = pageRoot;
    } else {
      const focusRange = range.cloneRange?.() || range;
      let installed = false;
      try {
        const HighlightCtor = window.Highlight;
        if (HighlightCtor && window.CSS?.highlights?.set) {
          window.CSS.highlights.set("pdfReaderAnchorFocusText", new HighlightCtor(focusRange));
          installed = true;
        }
      } catch {}
      if (!installed) {
        const pageRect = pageRoot.getBoundingClientRect?.();
        const rects = Array.from(focusRange.getClientRects?.() || []);
        if (pageRect && rects.length) {
          const scaleX = pageRect.width > 0 ? (pageRoot.offsetWidth || pageRect.width) / pageRect.width : 1;
          const scaleY = pageRect.height > 0 ? (pageRoot.offsetHeight || pageRect.height) / pageRect.height : 1;
          state.readerAnchorFocusFallbackNodes = rects.map((rect) => {
            const node = document.createElement("span");
            node.className = "pdfReaderAnchorFocusTextFallback";
            node.style.left = `${(rect.left - pageRect.left) * scaleX}px`;
            node.style.top = `${(rect.top - pageRect.top) * scaleY}px`;
            node.style.width = `${rect.width * scaleX}px`;
            node.style.height = `${rect.height * scaleY}px`;
            pageRoot.appendChild(node);
            return node;
          });
          installed = state.readerAnchorFocusFallbackNodes.length > 0;
        }
      }
    }
    state.readerAnchorFocusTimer = setTimeout(clearTemporaryReaderAnchorFocus, 1800);
    return true;
  }

  async function navigateToAnnotationUuid(uuid, pageIndex, sessionGuard = () => true) {
    if (typeof uuid !== "string" || !uuid || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
      return { ok: false, reason: "invalid-annotation-target" };
    }
    if (!sessionGuard()) return { ok: false, reason: "stale-session" };
    const pdfViewer = state.app?.pdfViewer;
    const targetPageNumber = pageIndex + 1;
    if (!pdfViewer || !Number.isSafeInteger(targetPageNumber)) {
      return { ok: false, reason: "pdf-viewer-navigation-unavailable" };
    }
    pdfViewer.currentPageNumber = targetPageNumber;
    if (pdfViewer.currentPageNumber !== targetPageNumber) {
      return { ok: false, reason: "pdf-viewer-navigation-rejected" };
    }
    const manager = pdfViewer._layerProperties?.annotationEditorUIManager;
    let editorNode = null;
    for (let attempt = 0; attempt < 40 && !editorNode; attempt += 1) {
      if (!sessionGuard()) return { ok: false, reason: "stale-session" };
      for (const [runtimeId, mappedUuid] of state.annotationUuidByRuntimeId) {
        if (mappedUuid !== uuid) continue;
        const editor = manager?.getEditor?.(runtimeId);
        if (editor && editor.pageIndex === pageIndex) {
          editorNode = editor.div || document.getElementById?.(String(runtimeId)) || null;
          break;
        }
      }
      if (!editorNode && attempt < 39) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!sessionGuard()) return { ok: false, reason: "stale-session" };
    if (!editorNode) return { ok: false, reason: "annotation-rendered-target-unresolved" };
    editorNode.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
    return { ok: true, reason: null };
  }

  async function navigateReaderAnchor(message) {
    const startedAt = performanceNow();
    const navigationSequence = (state.readerAnchorNavigationSequence || 0) + 1;
    state.readerAnchorNavigationSequence = navigationSequence;
    const target = message?.target;
    let result = { ok: false, reason: "invalid-target" };
    const current = state.actualSourceIdentity;
    const isCurrent = () => message.documentId === state.activeDocumentId &&
      message.openRequest === state.activeOpenRequest &&
      message.rendererGeneration === rendererGeneration && state.actualSourceIdentity === current &&
      state.readerAnchorNavigationSequence === navigationSequence;
    if (!isCurrent() || !target || !current) {
      result.reason = "stale-session";
    } else {
      const pageIndex = current.orderedPageIdentities.indexOf(target.pageIdentity);
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex !== target.pageIndex) {
        result.reason = "page-identity-unresolved";
      } else if (target.kind === "annotation") {
        result = await navigateToAnnotationUuid(target.id, pageIndex, isCurrent);
      } else {
        const pdfViewer = state.app?.pdfViewer;
        const targetPageNumber = pageIndex + 1;
        if (!pdfViewer || !Number.isSafeInteger(targetPageNumber)) {
          result.reason = "pdf-viewer-navigation-unavailable";
        } else {
          // PDF.js pages live inside its own scroll container. Calling
          // scrollIntoView() on an offscreen page root does not reliably
          // update that container, so navigate through the public viewer API.
          pdfViewer.currentPageNumber = targetPageNumber;
          if (pdfViewer.currentPageNumber !== targetPageNumber) {
            result.reason = "pdf-viewer-navigation-rejected";
          } else {
            let pageRoot = pageElementForIndex(pageIndex);
            if (!isCurrent()) {
              result.reason = "stale-session";
            } else if (target.kind === "selection") {
              if (!target.anchor || target.anchor.sourceHash !== current.sourceHash || target.anchor.pageIdentity !== target.pageIdentity) {
                result.reason = "source-or-page-mismatch";
              } else {
                let textLayer = textLayerForPage(pageRoot);
                for (let attempt = 0; !textLayer && attempt < 40; attempt += 1) {
                  await new Promise((resolve) => setTimeout(resolve, 50));
                  if (!isCurrent()) {
                    result.reason = "stale-session";
                    break;
                  }
                  pageRoot = pageElementForIndex(pageIndex);
                  textLayer = textLayerForPage(pageRoot);
                }
                const range = isCurrent()
                  ? state.textSelectionController?.rangeForAnchor?.(textLayer, target.anchor)
                  : null;
                if (!isCurrent()) result.reason = "stale-session";
                else if (!range) result.reason = "selection-not-unique";
                else {
                  const startNode = range.startContainer?.nodeType === 1
                    ? range.startContainer
                    : range.startContainer?.parentElement;
                  startNode?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
                  if (!isCurrent()) {
                    result.reason = "stale-session";
                  } else {
                    const focused = showTemporaryReaderAnchorFocus(pageRoot, range);
                    result = focused ? { ok: true, reason: null } : { ok: false, reason: "selection-owner-unavailable" };
                  }
                }
              }
            } else if (target.kind === "page-number" && typeof target.selection === "string") {
              let textLayer = textLayerForPage(pageRoot);
              for (let attempt = 0; !textLayer && attempt < 40; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (!isCurrent()) {
                  result.reason = "stale-session";
                  break;
                }
                pageRoot = pageElementForIndex(pageIndex);
                textLayer = textLayerForPage(pageRoot);
              }
              const range = isCurrent()
                ? state.textSelectionController?.rangeForNativeSelection?.(textLayer, target.selection)
                : null;
              if (!isCurrent()) result.reason = "stale-session";
              else if (!range) result = { ok: false, reason: "native-selection-unresolved" };
              else {
                range.startContainer?.parentElement?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
                const focused = showTemporaryReaderAnchorFocus(pageRoot, range);
                result = focused ? { ok: true, reason: null } : { ok: false, reason: "selection-owner-unavailable" };
              }
            } else if (target.kind === "page") {
              for (let attempt = 0; !pageRoot && attempt < 40; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                if (!isCurrent()) {
                  result.reason = "stale-session";
                  break;
                }
                pageRoot = pageElementForIndex(pageIndex);
              }
              if (!isCurrent()) result.reason = "stale-session";
              else if (!pageRoot) result = { ok: false, reason: "page-rendered-target-unresolved" };
              else {
                const focused = showTemporaryReaderAnchorFocus(pageRoot);
                result = focused ? { ok: true, reason: null } : { ok: false, reason: "page-focus-unavailable" };
              }
            } else {
              result = { ok: true, reason: null };
            }
          }
        }
      }
    }
    postToHost("reader-anchor-navigation-result", {
      documentId: message.documentId,
      openRequest: message.openRequest,
      rendererGeneration: message.rendererGeneration,
      requestId: message.requestId,
      targetId: target?.id || null,
      kind: target?.kind || null,
      ok: result.ok,
      reason: result.reason,
      message: result.ok ? undefined : "无法可靠解析此目标；请使用链接中的原生页码回退。",
      resolveMs: Math.max(0, performanceNow() - startedAt),
    });
  }

  const READER_BACKLINK_HIGHLIGHT_NAME = "pdfReaderMarkdownBacklinks";

  function clearReaderBacklinkPresentation() {
    try { window.CSS?.highlights?.delete?.(READER_BACKLINK_HIGHLIGHT_NAME); } catch {}
    document.querySelectorAll?.(".pdfReaderBacklinkPageBadge").forEach((node) => node.remove());
    document.querySelectorAll?.(".pdfReaderAnnotationBacklinkBadge").forEach((node) => node.remove());
    state.readerBacklinkHighlights = null;
    state.readerBacklinkPageKey = null;
    state.readerBacklinkPageResults = null;
    state.readerBacklinkActiveRequest = null;
    state.backlinkInteractionController?.clearPage?.();
    if (state.readerBacklinkRetryTimer) clearTimeout(state.readerBacklinkRetryTimer);
    state.readerBacklinkRetryTimer = null;
  }

  function requestReaderBacklinksForPage(pageNumber = state.app?.pdfViewer?.currentPageNumber, refresh = false) {
    const actual = state.actualSourceIdentity;
    if (!state.activeDocumentId || !Number.isSafeInteger(state.activeOpenRequest) ||
        actual?.identityStatus !== "KNOWN" || !Number.isSafeInteger(pageNumber) || pageNumber < 1) return false;
    const pageIndex = pageNumber - 1;
    const pageIdentity = actual.orderedPageIdentities?.[pageIndex];
    if (typeof pageIdentity !== "string") return false;
    const key = `${state.activeDocumentId}:${state.activeOpenRequest}:${pageIndex}:${pageIdentity}`;
    if (!refresh && state.readerBacklinkPageKey === key) return false;
    clearReaderBacklinkPresentation();
    state.readerBacklinkPageKey = key;
    const request = {
      requestId: `reader-backlink-page-${state.activeOpenRequest}-${++state.readerBacklinkRequestSequence}`,
      documentId: state.activeDocumentId,
      openRequest: state.activeOpenRequest,
      rendererGeneration,
      pageNumber,
      pageIndex,
      pageIdentity,
    };
    state.readerBacklinkActiveRequest = request;
    const controller = state.backlinkInteractionController || ensureBacklinkInteractionController();
    controller?.beginPageRequest?.(request);
    const sent = postToHost("reader-backlink-page-request", {
      ...request,
      sourceHash: actual.sourceHash,
    });
    if (!sent && state.readerBacklinkPageKey === key) {
      state.readerBacklinkPageKey = null;
      state.readerBacklinkActiveRequest = null;
      controller?.clearPage?.();
    }
    return sent;
  }

  async function applyReaderBacklinkPageResults(message, attempt = 0) {
    const startedAt = performanceNow();
    const actual = state.actualSourceIdentity;
    const activeRequest = state.readerBacklinkActiveRequest;
    const isCorrelatedRequest = activeRequest
      ? message?.requestId === activeRequest.requestId &&
        message?.documentId === activeRequest.documentId &&
        message?.openRequest === activeRequest.openRequest &&
        message?.rendererGeneration === activeRequest.rendererGeneration &&
        message?.pageNumber === activeRequest.pageNumber &&
        message?.pageIndex === activeRequest.pageIndex &&
        message?.pageIdentity === activeRequest.pageIdentity
      : !message?.requestId;
    if (!isCorrelatedRequest ||
        state.backlinkInteractionController?.isCurrentPageRequest?.(message) === false) return false;
    const isCurrent = () => !state.disposed &&
      message?.rendererGeneration === rendererGeneration &&
      message?.documentId === state.activeDocumentId &&
      message?.openRequest === state.activeOpenRequest &&
      state.readerBacklinkActiveRequest === activeRequest &&
      actual === state.actualSourceIdentity &&
      state.app?.pdfViewer?.currentPageNumber === message.pageNumber &&
      actual?.orderedPageIdentities?.[message.pageIndex] === message.pageIdentity;
    if (!isCurrent() || !Array.isArray(message.markers)) return false;
    const pageRoot = pageElementForIndex(message.pageIndex);
    const textLayer = textLayerForPage(pageRoot);
    if ((!pageRoot || !textLayer) && attempt < 12) {
      state.readerBacklinkRetryTimer = setTimeout(() => {
        state.readerBacklinkRetryTimer = null;
        void applyReaderBacklinkPageResults(message, attempt + 1);
      }, 180);
      return false;
    }
    if (!isCurrent() || !pageRoot) return false;
    try { window.CSS?.highlights?.delete?.(READER_BACKLINK_HIGHLIGHT_NAME); } catch {}
    const priorBadge = pageRoot.querySelector?.(":scope > .pdfReaderBacklinkPageBadge");
    priorBadge?.remove?.();
    const markers = message.markers.slice(0, 256);
    pageRoot.querySelectorAll?.(".pdfReaderAnnotationBacklinkBadge").forEach((node) => node.remove());
    const selectionMarkers = markers.filter((marker) => marker?.kind === "selection" &&
      typeof marker.id === "string" && marker.anchor);
    const rangeEntries = textLayer
      ? (state.textSelectionController?.rangeEntriesForAnchors?.(
        textLayer,
        selectionMarkers.map((marker) => marker.anchor),
      ) || [])
      : [];
    const rangeTargets = rangeEntries.map((entry) => ({
      kind: "selection",
      id: selectionMarkers[entry.index]?.id,
      range: entry.range,
    })).filter((target) => typeof target.id === "string" && target.range);
    const ranges = rangeTargets.map((target) => target.range);
    const HighlightCtor = window.Highlight || globalThis.Highlight;
    let paintedRanges = 0;
    if (ranges.length && typeof HighlightCtor === "function" && window.CSS?.highlights?.set) {
      try {
        window.CSS.highlights.set(READER_BACKLINK_HIGHLIGHT_NAME, new HighlightCtor(...ranges));
        state.readerBacklinkHighlights = ranges;
        paintedRanges = ranges.length;
      } catch { /* The page badge remains a safe visual fallback. */ }
    }
    const manager = state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    for (const marker of markers) {
      if (marker?.kind !== "annotation" || typeof marker.id !== "string") continue;
      for (const [runtimeId, uuid] of state.annotationUuidByRuntimeId) {
        if (uuid !== marker.id) continue;
        const editor = manager?.getEditor?.(runtimeId);
        const editorNode = editor?.div || document.getElementById?.(String(runtimeId));
        if (!editorNode || !pageRoot.contains?.(editorNode)) continue;
        const badge = document.createElement?.("span");
        if (!badge) continue;
        badge.className = "pdfReaderAnnotationBacklinkBadge";
        badge.dataset.backlinkTargetKind = "annotation";
        badge.dataset.backlinkTargetId = marker.id;
        badge.setAttribute("role", "button");
        badge.setAttribute("tabindex", "0");
        const count = Number.isSafeInteger(marker.backlinkCount) ? marker.backlinkCount : 1;
        badge.textContent = count > 1 ? `↗${count}` : "↗";
        badge.title = count === 1
          ? "1 条 Markdown 反向链接；点击定位（Ctrl/Cmd 悬停预览不可用）"
          : `${count} 条 Markdown 反向链接；点击查看来源（Ctrl/Cmd 悬停预览不可用）`;
        badge.setAttribute("aria-label", badge.title);
        editorNode.appendChild(badge);
      }
    }
    const badge = Number(message.backlinkCount) > 0 ? document.createElement?.("div") : null;
    if (badge) {
      badge.className = "pdfReaderBacklinkPageBadge";
      badge.dataset.backlinkTargetKind = "page";
      badge.dataset.backlinkTargetId = message.pageIdentity;
      badge.setAttribute("role", "button");
      badge.setAttribute("tabindex", "0");
      const count = Number.isSafeInteger(message.backlinkCount) ? message.backlinkCount : markers.length;
      badge.textContent = count === 1 ? "1 条 Markdown 引用" : `${count} 条 Markdown 引用`;
      badge.title = `${badge.textContent}；点击查看来源（Ctrl/Cmd 悬停预览不可用）`;
      badge.setAttribute("aria-label", badge.title);
      pageRoot.appendChild(badge);
    }
    runtimeLogRecord("reader-backlinks.paint", {
      pageIndex: message.pageIndex,
      markerCount: markers.length,
      rangeCount: paintedRanges,
      lookupMs: Number.isFinite(message.backlinkLookupMs) ? message.backlinkLookupMs : null,
      anchorResolveMs: Number.isFinite(message.anchorResolveMs) ? message.anchorResolveMs : null,
      pageIndexCacheHit: message.pageIndexCacheHit === true,
      paintMs: Math.max(0, performanceNow() - startedAt),
    });
    state.readerBacklinkPageResults = message;
    state.backlinkInteractionController?.setPageResults?.(message, rangeTargets);
    return true;
  }

  function ensureBacklinkInteractionController() {
    if (state.backlinkInteractionController || state.disposed) {
      return state.backlinkInteractionController;
    }
    const Controller = window.PdfReaderInputRuntime?.BacklinkInteractionController;
    if (typeof Controller !== "function") return null;
    state.backlinkInteractionController = new Controller({
      documentRef: document,
      routedPointerEvents: true,
      canActivate: () => !state.disposed && !state.closeControl && state.editorMode === 0 &&
        !annotationToolIsActive() && !state.iosDirectManipulationController?.hasActivePenEditorGesture?.(),
      getCurrentPageState: () => {
        const pageNumber = state.app?.pdfViewer?.currentPageNumber;
        const actual = state.actualSourceIdentity;
        if (!state.activeDocumentId || !Number.isSafeInteger(state.activeOpenRequest) ||
            !Number.isSafeInteger(pageNumber) || pageNumber < 1 ||
            actual?.identityStatus !== "KNOWN") return null;
        const pageIndex = pageNumber - 1;
        const pageIdentity = actual.orderedPageIdentities?.[pageIndex];
        if (typeof pageIdentity !== "string") return null;
        return {
          documentId: state.activeDocumentId,
          openRequest: state.activeOpenRequest,
          rendererGeneration,
          pageNumber,
          pageIdentity,
        };
      },
      postToHost,
    });
    return state.backlinkInteractionController;
  }

  function ensureVocabularyController() {
    if (state.vocabularyController || !state.app || !state.vocabularyEnabled) return state.vocabularyController;
    const Runtime = window.PdfReaderVocabularyRuntimeModule;
    if (typeof Runtime?.VocabularyController !== "function") return null;
    state.vocabularyController = new Runtime.VocabularyController({
      app: state.app,
      eventBus: state.app.eventBus,
      documentRef: document,
      windowRef: window,
      postToHost,
      getIdentity: () => ({ documentId: state.activeDocumentId, openRequest: state.activeOpenRequest }),
      isEnabled: true,
      highlightLevels: state.vocabularyHighlightLevels,
      displayMode: state.vocabularyDisplayMode,
      wordDisplayMode: state.vocabularyWordDisplayMode,
    });
    return state.vocabularyController;
  }

  function vocabularyReadModeIsSafe() {
    const pdfViewer = state.app?.pdfViewer;
    return !!pdfViewer?._layerProperties?.annotationEditorUIManager &&
      Number.isInteger(pdfViewer.annotationEditorMode) &&
      state.editorMode === pdfViewer.annotationEditorMode &&
      !isEditBoundaryBusy() &&
      manualPointerCount() === 0 &&
      penPolicyPointerIds().length === 0 &&
      state.iosDirectManipulationController?.hasActiveInputSession?.() !== true;
  }

  function requestVocabularyReadMode(documentId, openRequest) {
    const app = state.app;
    const pdfDocument = app?.pdfDocument;
    const pdfViewer = app?.pdfViewer;
    if (!state.vocabularyEnabled || !app || !pdfViewer) {
      return false;
    }
    if (state.editorMode === 0 && pdfViewer.annotationEditorMode === 0) {
      state.annotationController?.cancelPendingReadMode?.();
      return false;
    }
    const generation = rendererGeneration;
    const explicitToolChoice = state.vocabularyReadModeToolChoice;
    if (explicitToolChoice?.documentId === documentId &&
        explicitToolChoice?.openRequest === openRequest &&
        explicitToolChoice?.rendererGeneration === generation) {
      return false;
    }
    const identity = { documentId, openRequest };
    return state.annotationController?.requestReadMode?.({
      isSafe: vocabularyReadModeIsSafe,
      isCurrent: () => !state.disposed &&
        state.vocabularyEnabled === true &&
        rendererGeneration === generation &&
        state.app === app && app.pdfDocument === pdfDocument &&
        state.activeDocumentId === identity.documentId &&
        state.activeOpenRequest === identity.openRequest &&
        state.requestedDocumentId === identity.documentId &&
        state.requestedOpenRequest === identity.openRequest,
    }) === true;
  }

  function setVocabularyEnabled(enabled) {
    const wasEnabled = state.vocabularyEnabled === true;
    state.vocabularyEnabled = enabled === true;
    syncVocabularyMenuButton();
    if (!state.vocabularyEnabled) {
      state.vocabularyReadModeToolChoice = null;
      state.annotationController?.cancelPendingReadMode?.();
      state.vocabularyController?.dispose?.();
      state.vocabularyController = null;
      return;
    }
    if (!wasEnabled) state.vocabularyReadModeToolChoice = null;
    const controller = ensureVocabularyController();
    if (controller && state.activeDocumentId && Number.isInteger(state.activeOpenRequest)) {
      controller.setDocument(state.activeDocumentId, state.activeOpenRequest, true);
      requestVocabularyReadMode(state.activeDocumentId, state.activeOpenRequest);
    }
    syncVocabularyMenuButton();
  }

  function syncVocabularyMenuButton() {
    const enabled = state.vocabularyEnabled === true;
    if (document.documentElement?.dataset) {
      document.documentElement.dataset.vocabularyEnabled = String(enabled);
    }
    const button = state.bridgeControls?.vocabularyToggleButton;
    if (!button) return;
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("is-active", enabled);
    button.title = enabled ? "LingQ 模式：开启" : "LingQ 模式：关闭";
  }

  function syncVocabularyDisplayModeButton() {
    const button = state.bridgeControls?.vocabularyDisplayModeButton;
    if (!button) return;
    const mode = normalizeVocabularyDisplayMode(state.vocabularyDisplayMode);
    button.textContent = `LingQ：${VOCABULARY_DISPLAY_LABELS[mode]}`;
    button.title = `LingQ 显示模式：${VOCABULARY_DISPLAY_LABELS[mode]}（点击切换）`;
    button.setAttribute("aria-label", button.title);
    button.dataset.mode = mode;
  }

  function setVocabularyDisplayMode(mode) {
    state.vocabularyDisplayMode = normalizeVocabularyDisplayMode(mode);
    state.vocabularyController?.setDisplayMode?.(state.vocabularyDisplayMode);
    syncVocabularyDisplayModeButton();
  }

  function requestVocabularyDisplayMode(mode) {
    const next = normalizeVocabularyDisplayMode(mode);
    const hasActiveDocument = state.activeDocumentId && Number.isInteger(state.activeOpenRequest);
    const hasPendingDocument = state.requestedDocumentId && Number.isInteger(state.requestedOpenRequest);
    const target = hasActiveDocument
      ? { documentId: state.activeDocumentId, openRequest: state.activeOpenRequest }
      : hasPendingDocument
        ? { documentId: state.requestedDocumentId, openRequest: state.requestedOpenRequest }
        : null;
    return target && postToHost("vocab-display-mode-request", {
      mode: next, documentId: target.documentId, openRequest: target.openRequest,
    });
  }

  function cycleVocabularyDisplayMode(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const current = normalizeVocabularyDisplayMode(state.vocabularyDisplayMode);
    const next = VOCABULARY_DISPLAY_MODES[(VOCABULARY_DISPLAY_MODES.indexOf(current) + 1) % VOCABULARY_DISPLAY_MODES.length];
    if (!requestVocabularyDisplayMode(next)) showStatus("LingQ 显示模式尚未同步到 Obsidian。");
  }

  function toggleVocabularyFromToolWheel() {
    toggleVocabularyFromMenu();
  }

  function toggleVocabularyFromMenu(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const enabled = !state.vocabularyEnabled;
    const previousEnabled = state.vocabularyEnabled === true;
    const hasActiveDocument = state.activeDocumentId && Number.isInteger(state.activeOpenRequest);
    const hasPendingDocument = state.requestedDocumentId && Number.isInteger(state.requestedOpenRequest);
    const target = hasActiveDocument
      ? { documentId: state.activeDocumentId, openRequest: state.activeOpenRequest }
      : hasPendingDocument
        ? { documentId: state.requestedDocumentId, openRequest: state.requestedOpenRequest }
        : null;

    if (!target) {
      showStatus("PDF 尚未完成打开，LingQ 设置暂时无法同步。");
      return;
    }

    // Enabling must be acknowledged by the host before the controller starts
    // querying page terms. The host rejects vocab-page-query while its
    // persisted setting is still false. Starting a query optimistically here
    // leaves that page's pending request stuck forever, so the highlights do
    // not return until a later page rerender or scroll. Disabling remains
    // immediate so the visible overlays disappear as soon as the user asks.
    // During a pending open the bridge cannot scan a page yet, so it may keep
    // the requested state locally while still binding the setting update to
    // the pending document identity. The matching host response is applied by
    // handleVocabularyEnabledMessage before that document is hydrated.
    if (!enabled || !hasActiveDocument) setVocabularyEnabled(enabled);
    if (!postToHost("vocab-toggle-request", {
      enabled,
      documentId: target.documentId,
      openRequest: target.openRequest,
    })) {
      setVocabularyEnabled(previousEnabled);
      showStatus("LingQ 设置尚未同步到 Obsidian。");
    }
  }

  function setVocabularyHighlightLevels(levels) {
    state.vocabularyHighlightLevels = normalizeVocabularyHighlightLevels(levels);
    state.vocabularyController?.setHighlightLevels?.(state.vocabularyHighlightLevels);
  }

  function handleVocabularyHighlightLevelsMessage(message) {
    if (message?.rendererGeneration !== rendererGeneration || !message.levels ||
        !Array.isArray(message.levels.words) || !Array.isArray(message.levels.phrases)) return false;
    const matchesActive = message.documentId === state.activeDocumentId &&
      message.openRequest === state.activeOpenRequest;
    if (matchesActive) {
      setVocabularyHighlightLevels(message.levels);
      return true;
    }
    const matchesPending = message.documentId === state.requestedDocumentId &&
      message.openRequest === state.requestedOpenRequest;
    if (!matchesPending || state.pendingVocabularySettings?.documentId !== message.documentId ||
        state.pendingVocabularySettings?.openRequest !== message.openRequest) return false;
    state.pendingVocabularySettings.levels = normalizeVocabularyHighlightLevels(message.levels);
    setVocabularyHighlightLevels(state.pendingVocabularySettings.levels);
    state.vocabularyController?.setDocument?.(null, null, false);
    return true;
  }

  function handleVocabularyDisplayModeMessage(message) {
    if (message?.rendererGeneration !== rendererGeneration || !VOCABULARY_DISPLAY_MODES.includes(message.mode)) return false;
    const matchesActive = message.documentId === state.activeDocumentId &&
      message.openRequest === state.activeOpenRequest;
    if (matchesActive) {
      setVocabularyDisplayMode(message.mode);
      return true;
    }
    const matchesPending = message.documentId === state.requestedDocumentId &&
      message.openRequest === state.requestedOpenRequest;
    if (!matchesPending || state.pendingVocabularySettings?.documentId !== message.documentId ||
        state.pendingVocabularySettings?.openRequest !== message.openRequest) return false;
    state.pendingVocabularySettings.displayMode = normalizeVocabularyDisplayMode(message.mode);
    setVocabularyDisplayMode(state.pendingVocabularySettings.displayMode);
    state.vocabularyController?.setDocument?.(null, null, false);
    return true;
  }

  function handleVocabularyWordDisplayModeMessage(message) {
    if (message?.rendererGeneration !== rendererGeneration || !["whole", "roots"].includes(message.mode)) return false;
    const matchesActive = message.documentId === state.activeDocumentId && message.openRequest === state.activeOpenRequest;
    const pending = state.pendingVocabularySettings;
    const matchesPending = message.documentId === state.requestedDocumentId && message.openRequest === state.requestedOpenRequest &&
      pending?.documentId === message.documentId && pending?.openRequest === message.openRequest;
    if (!matchesActive && !matchesPending) return false;
    if (matchesPending) pending.wordDisplayMode = message.mode;
    state.vocabularyWordDisplayMode = message.mode;
    state.vocabularyController?.setWordDisplayMode?.(message.mode);
    return true;
  }

  function handleVocabularyEnabledMessage(message) {
    if (message?.rendererGeneration !== rendererGeneration || typeof message.enabled !== "boolean") return false;
    const matchesActive = message.documentId === state.activeDocumentId &&
      message.openRequest === state.activeOpenRequest;
    if (matchesActive) {
      setVocabularyEnabled(message.enabled);
      return true;
    }
    const matchesPending = message.documentId === state.requestedDocumentId &&
      message.openRequest === state.requestedOpenRequest;
    if (!matchesPending || state.pendingVocabularySettings?.documentId !== message.documentId ||
        state.pendingVocabularySettings?.openRequest !== message.openRequest) return false;
    state.pendingVocabularySettings.enabled = message.enabled;
    state.vocabularyEnabled = message.enabled;
    if (!message.enabled) {
      state.vocabularyReadModeToolChoice = null;
      state.annotationController?.cancelPendingReadMode?.();
    }
    syncVocabularyMenuButton();
    // A newer document is queued; clear old page overlays now and defer
    // scanning until that exact open request becomes active.
    state.vocabularyController?.setDocument?.(null, null, false);
    return true;
  }

  function prepareVocabularyOpen(message) {
    state.annotationController?.cancelPendingReadMode?.();
    state.vocabularyController?.setDocument?.(null, null, false);
    const pending = state.pendingVocabularySettings;
    const matchesPending = pending?.documentId === message.documentId &&
      pending?.openRequest === message.openRequest;
    state.vocabularyEnabled = pending?.documentId === message.documentId &&
      pending?.openRequest === message.openRequest
      ? pending.enabled === true
      : message.vocabularyEnabled === true;
    if (!state.vocabularyEnabled) state.vocabularyReadModeToolChoice = null;
    setVocabularyHighlightLevels(pending?.documentId === message.documentId &&
      pending?.openRequest === message.openRequest
      ? pending.levels
      : message.vocabularyHighlightLevels);
    setVocabularyDisplayMode(matchesPending ? pending.displayMode : message.vocabularyDisplayMode);
    state.vocabularyWordDisplayMode = (matchesPending ? pending.wordDisplayMode : message.vocabularyWordDisplayMode) === "roots" ? "roots" : "whole";
    state.vocabularyController?.setWordDisplayMode?.(state.vocabularyWordDisplayMode);
    state.preferredAnnotationToolMode = normalizeAnnotationToolMode(message.preferredAnnotationToolMode);
    state.restoredAnnotationToolIdentity = null;
    syncVocabularyMenuButton();
  }

  function restorePreferredAnnotationTool(documentId, openRequest) {
    const mode = normalizeAnnotationToolMode(state.preferredAnnotationToolMode);
    const identityKey = `${documentId}:${openRequest}`;
    // LingQ has explicit priority while enabled: keep its read interaction
    // available, while retaining the saved annotation preference for later.
    if (state.vocabularyEnabled || mode === 0 || state.readOnly || !state.externalSourceConfirmed ||
        state.restoredAnnotationToolIdentity === identityKey ||
        documentId !== state.activeDocumentId || openRequest !== state.activeOpenRequest) return false;
    state.restoredAnnotationToolIdentity = identityKey;
    state.app?.eventBus?.dispatch("switchannotationeditormode", {
      source: window,
      mode,
      isFromKeyboard: false,
      createNewEditor: false,
    });
    return true;
  }

  function bindVocabularyToOpenedDocument(documentId, openRequest) {
    const isLatestOpen = state.requestedDocumentId === documentId &&
      state.requestedOpenRequest === openRequest;
    if (state.vocabularyEnabled && isLatestOpen) {
      ensureVocabularyController()?.setDocument?.(documentId, openRequest, true);
      requestVocabularyReadMode(documentId, openRequest);
    } else {
      state.vocabularyController?.setDocument?.(null, null, false);
    }
    if (state.pendingVocabularySettings?.documentId === documentId &&
        state.pendingVocabularySettings?.openRequest === openRequest) {
      state.pendingVocabularySettings = null;
    }
  }

  function setDeferredTimeout(callback, delay = 0) {
    if (state.disposed) {
      return null;
    }
    const timeout = setTimeout(() => {
      state.deferredTimers.delete(timeout);
      if (!state.disposed) {
        callback();
      }
    }, delay);
    state.deferredTimers.add(timeout);
    return timeout;
  }

  function clearDeferredTimeouts() {
    for (const timeout of state.deferredTimers) {
      clearTimeout(timeout);
    }
    state.deferredTimers.clear();
  }

  function showStatus(message) {
    if (!message || state.disposed) {
      return;
    }
    if (!state.statusElement && document.body) {
      const element = document.createElement("div");
      element.id = "pdfReaderBridgeStatus";
      element.className = "pdfReaderBridgeStatus";
      element.setAttribute("role", "status");
      element.setAttribute("aria-live", "polite");
      document.body.append(element);
      state.statusElement = element;
    }
    if (state.statusElement) {
      state.statusElement.textContent = message;
      state.statusElement.hidden = false;
      clearTimeout(state.statusTimer);
      state.statusTimer = setTimeout(() => {
        if (state.statusElement) {
          state.statusElement.hidden = true;
        }
      }, 7000);
    }
  }

  function sendError(
    message,
    { documentId = null, openRequest = null, requestId = null, code } = {},
  ) {
    const fields = { message: String(message || "PDF viewer error") };
    if (typeof documentId === "string") {
      fields.documentId = documentId;
    }
    if (Number.isSafeInteger(openRequest) && openRequest >= 0) {
      fields.openRequest = openRequest;
    }
    if (typeof requestId === "string") {
      fields.requestId = requestId;
    }
    if (typeof code === "string") {
      fields.code = code;
    }
    postToHost("error", fields);
    showStatus(fields.message);
  }

  function resourceUrl(path) {
    return new URL(path, viewerBaseUrl).href;
  }

  function ensureViewerLayout() {
    const viewerContainer = document.getElementById("viewerContainer");
    if (
      !viewerContainer ||
      getComputedStyle(viewerContainer).position === "absolute"
    ) {
      return;
    }

    // Some Obsidian app:// srcdoc combinations report the packaged stylesheet
    // as loaded while its rules are not yet in the cascade when PDFViewer is
    // constructed. PDF.js requires an absolutely positioned viewer container
    // and aborts initialization otherwise. Add only the viewer's critical
    // layout rules as a last-resort stylesheet; the normal viewer.css remains
    // responsible for the full UI and its more-specific state selectors.
    if (document.getElementById("pdfReaderViewerLayoutFallback")) {
      return;
    }
    const style = document.createElement("style");
    style.id = "pdfReaderViewerLayoutFallback";
    style.textContent = `
      html, body { width: 100%; height: 100%; overflow: hidden; }
      body { margin: 0; }
      #outerContainer { width: 100%; height: 100%; position: relative; margin: 0; }
      #mainContainer {
        position: absolute;
        inset: 0;
        min-width: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
      }
      #viewerContainer {
        position: absolute;
        inset: var(--toolbar-height, 32px) 0 0;
        overflow: auto;
        outline: none;
        z-index: 0;
      }
    `;
    (document.head || document.documentElement).append(style);
  }

  function labelSaveControls() {
    const title = "保存批注到外置记录";
    const button = document.getElementById("secondaryDownload");
    if (!button) {
      return;
    }
    button.removeAttribute("data-l10n-id");
    button.removeAttribute("data-l10n-args");
    button.title = title;
    button.setAttribute("aria-label", title);

    const label = button.querySelector("span");
    if (label) {
      label.removeAttribute("data-l10n-id");
      label.removeAttribute("data-l10n-args");
      label.textContent = "保存批注";
    }
  }

  function labelSecondaryToolbarControls() {
    // The bundled Fluent locale files are not readable from Obsidian's app://
    // viewer origin on Windows. Keep PDF.js's existing labels whenever they
    // were localized, and only provide a fallback for empty label spans.
    const isChinese = /^zh(?:-|$)/iu.test(window.navigator?.language || "");
    const labels = isChinese
      ? {
          presentationMode: "演示模式",
          firstPage: "转到第一页",
          lastPage: "转到最后一页",
          pageRotateCw: "顺时针旋转",
          pageRotateCcw: "逆时针旋转",
          cursorSelectTool: "文本选择工具",
          cursorHandTool: "手形工具",
          scrollPage: "单页滚动",
          scrollVertical: "垂直滚动",
          scrollHorizontal: "水平滚动",
          scrollWrapped: "连续滚动",
          spreadNone: "不分栏",
          spreadOdd: "奇数页跨页",
          spreadEven: "偶数页跨页",
          documentProperties: "文档属性",
        }
      : {
          presentationMode: "Presentation Mode",
          firstPage: "Go to First Page",
          lastPage: "Go to Last Page",
          pageRotateCw: "Rotate Clockwise",
          pageRotateCcw: "Rotate Counterclockwise",
          cursorSelectTool: "Text Selection Tool",
          cursorHandTool: "Hand Tool",
          scrollPage: "Page Scrolling",
          scrollVertical: "Vertical Scrolling",
          scrollHorizontal: "Horizontal Scrolling",
          scrollWrapped: "Wrapped Scrolling",
          spreadNone: "No Spreads",
          spreadOdd: "Odd Spreads",
          spreadEven: "Even Spreads",
          documentProperties: "Document Properties",
        };

    for (const [id, fallback] of Object.entries(labels)) {
      const button = document.getElementById(id);
      const label = button?.querySelector("span");
      if (!button || !label || label.textContent?.trim()) continue;

      // Detach only this untranslated label from Fluent; translated labels
      // above remain fully owned by PDF.js localization.
      for (const element of [button, label]) {
        element.removeAttribute("data-l10n-id");
        element.removeAttribute("data-l10n-args");
      }
      label.textContent = fallback;
      button.title = fallback;
      button.setAttribute("aria-label", fallback);
    }
  }

  function hideUnusedToolbarControls() {
    for (const id of [
      "editorStamp",
      "printButton",
      "secondaryPrint",
      "overwriteOriginalButton",
      "secondaryOverwriteOriginal",
    ]) {
      const element = document.getElementById(id);
      if (element) {
        element.hidden = true;
      }
    }

    const primaryPrintGroup = document.getElementById("printButton")?.parentElement;
    if (primaryPrintGroup) {
      primaryPrintGroup.hidden = true;
    }
    const secondaryPrintGroup = document.getElementById("secondaryPrint")?.parentElement;
    if (secondaryPrintGroup) {
      secondaryPrintGroup.hidden = true;
    }
    document.getElementById("editorModeSeparator")?.setAttribute("hidden", "");
    for (const separator of document.querySelectorAll(
      "#toolbarViewerRight > .verticalToolbarSeparator",
    )) {
      separator.hidden = true;
    }
  }

  function updatePageNumberWidth(pagesCount = state.app?.pdfDocument?.numPages) {
    const input = document.getElementById("pageNumber");
    if (!input) {
      return;
    }
    const pageCount = Number.isSafeInteger(pagesCount) && pagesCount > 0
      ? pagesCount
      : 0;
    const digits = pageCount ? String(pageCount).length : 0;
    input.style.width = `${36 + Math.max(0, digits - 4) * 8}px`;
  }

  function configureZoomPresetOptions() {
    const presets = [
      ["pageAutoOption", "auto", "自动适配页面"],
      ["pageActualOption", "1:1", "按原始大小显示（100%）"],
      ["pageFitOption", "↕", "适合整页"],
      ["pageWidthOption", "↔", "适合页面宽度"],
    ];
    for (const [id, label, description] of presets) {
      const option = document.getElementById(id);
      if (!option) {
        continue;
      }
      // webviewerloaded fires before PDFViewerApplication.run starts l10n.
      // Removing these attributes first keeps the compact preset labels from
      // being replaced during either the initial or a later translation pass.
      option.removeAttribute("data-l10n-id");
      option.removeAttribute("data-l10n-args");
      option.textContent = label;
      option.title = description;
      option.setAttribute("aria-label", description);
    }
  }

  function dismissToolbarParameterPopups(intent) {
    if (intent?.targetRegion === "editor-params-toolbar" ||
        intent?.targetRegion === "editor-mode-buttons") {
      return;
    }
    if (document.querySelector(".editorParamsToolbar:not(.hidden)")) {
      // Use the frozen toolbar's existing hide event: it cancels its timers
      // and updates expanded state without changing the active editor mode.
      state.app?.eventBus?.dispatch("hideannotationeditorparams", { source: window });
    }
  }

  function syncBridgeControls() {
    const controls = state.bridgeControls;
    if (!controls) {
      return;
    }
    const hasDocument = !!(state.activeDocumentId && state.app?.pdfDocument);
    const canEdit = hasDocument && !state.readOnly;
    controls.historyButtons.undo.disabled =
      !canEdit || !state.editorHistory.canUndo;
    controls.historyButtons.redo.disabled =
      !canEdit || !state.editorHistory.canRedo;
    controls.deleteButton.disabled =
      !canEdit || !state.editorHistory.hasSelection;
    controls.deletePageAnnotationsButton.disabled =
      !canEdit || state.bulkDeleteInProgress;
    controls.deleteAllAnnotationsButton.disabled =
      !canEdit || state.bulkDeleteInProgress;
    controls.saveButton.disabled =
      !canEdit || !hasUnsavedAnnotationChanges();
    if (controls.annotationSidebarButton) {
      controls.annotationSidebarButton.disabled = !(
        hasDocument && state.externalSourceConfirmed && !state.externalSourceMismatch &&
        state.actualSourceIdentity?.identityStatus === "KNOWN"
      );
    }
    if (controls.annotationSidebarButton?.disabled && state.annotationSidebarController?.isOpen()) {
      state.annotationSidebarController.closeAndClear();
    }
    syncVocabularyMenuButton();
  }

  function toolbarContentWidth(element) {
    if (!element) {
      return 0;
    }
    return Math.max(element.scrollWidth, element.getBoundingClientRect().width);
  }

  function updateAdaptiveToolbarLayout() {
    const toolbarViewer = document.getElementById("toolbarViewer");
    if (!toolbarViewer || !state.bridgeControls) {
      return;
    }
    const left = document.getElementById("toolbarViewerLeft");
    const middle = document.getElementById("toolbarViewerMiddle");
    const editorModes = document.getElementById("editorModeButtons");
    const more = document.getElementById("secondaryToolbarToggle");
    const availableWidth = toolbarViewer.clientWidth;
    const groupWidths = [left, middle, editorModes, state.bridgeControls.group, more]
      .map(toolbarContentWidth);
    // A one-row toolbar contains two outer groups, then the editor, history,
    // and More controls. Include their default 1px gaps, left inset, and the
    // history group's 8px inline margins. The measured content widths adapt
    // to page counts, localization, browser fonts, and visible controls. Do
    // not include computed margins: the More control has an auto margin in
    // two-row mode, which would otherwise add distributed whitespace and
    // make the measured width depend on the layout being selected.
    const requiredWidth = groupWidths.reduce((sum, width) => sum + width, 0) + 20;
    const needsTwoRows = availableWidth > 0 && requiredWidth > availableWidth + 1;
    document.documentElement.classList.toggle(
      "pdfReaderBridgeTwoRow",
      needsTwoRows,
    );
  }

  function scheduleAdaptiveToolbarLayout() {
    if (state.disposed || state.toolbarLayoutFrame) {
      return;
    }
    state.toolbarLayoutFrame = requestAnimationFrame(() => {
      state.toolbarLayoutFrame = 0;
      updateAdaptiveToolbarLayout();
    });
  }

  function installAdaptiveToolbarLayout() {
    const toolbar = document.getElementById("toolbarContainer");
    const toolbarViewer = document.getElementById("toolbarViewer");
    if (!toolbar || !toolbarViewer || !state.bridgeControls) {
      return;
    }
    const observedElements = [
      toolbar,
      toolbarViewer,
      document.getElementById("toolbarViewerLeft"),
      document.getElementById("toolbarViewerMiddle"),
      document.getElementById("toolbarViewerRight"),
      document.getElementById("editorModeButtons"),
      state.bridgeControls.group,
      document.getElementById("secondaryToolbarToggle"),
    ].filter(Boolean);
    if (typeof ResizeObserver === "function") {
      state.toolbarLayoutResizeObserver = new ResizeObserver(
        scheduleAdaptiveToolbarLayout,
      );
      for (const element of observedElements) {
        state.toolbarLayoutResizeObserver.observe(element);
      }
    }
    if (typeof MutationObserver === "function") {
      state.toolbarLayoutMutationObserver = new MutationObserver(
        scheduleAdaptiveToolbarLayout,
      );
      state.toolbarLayoutMutationObserver.observe(toolbar, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-label", "class", "disabled", "hidden", "style", "title"],
      });
    }
    window.addEventListener("resize", scheduleAdaptiveToolbarLayout, {
      passive: true,
      signal: state.eventAbortController?.signal,
    });
    scheduleAdaptiveToolbarLayout();
  }

  function runBridgeAction(action) {
    const manager =
      state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    if (!state.activeDocumentId || !state.app?.pdfDocument) {
      return;
    }
    switch (action) {
      case "undo":
        if (manager && !state.readOnly && state.editorHistory.canUndo) {
          manager.undo();
        }
        break;
      case "redo":
        if (manager && !state.readOnly && state.editorHistory.canRedo) {
          manager.redo();
        }
        break;
      case "delete":
        if (manager && !state.readOnly && state.editorHistory.hasSelection) {
          state.app.secondaryToolbar?.close();
          manager.delete();
        }
        break;
      case "delete-page-annotations":
        if (manager && !state.readOnly) {
          state.app.secondaryToolbar?.close();
          const currentPageNumber = state.app.pdfViewer.currentPageNumber;
          if (Number.isSafeInteger(currentPageNumber) && currentPageNumber > 0) {
            requestManagedAnnotationDeletion(
              currentPageNumber - 1,
              captureBulkDeleteSession(),
            );
          }
        }
        break;
      case "delete-all-annotations":
        if (manager && !state.readOnly) {
          state.app.secondaryToolbar?.close();
          showDeleteAllAnnotationsConfirmation();
        }
        break;
      case "save":
        void requestSave("manual");
        break;
    }
  }

  function collectKnownAnnotationDeletionTargets(pageIndex = null) {
    const targets = new Map();
    const authoritativeTombstones = new Set();
    const add = (row, { editorPayload, ref, source } = {}) => {
      if (!row || typeof row.uuid !== "string" || !row.uuid ||
          !Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0 ||
          (pageIndex !== null && row.pageIndex !== pageIndex)) return;
      const kind = normalizeSyncKind(row.kind);
      if (!EXTERNAL_ANNOTATION_KINDS.has(kind)) return;
      targets.set(row.uuid, {
        uuid: row.uuid,
        pageIndex: row.pageIndex,
        kind,
        ref: canonicalPdfAnnotationRef(ref || row.embeddedRef || row.reference || row.operationReference),
        editorPayload: editorPayload && typeof editorPayload === "object" ? editorPayload : null,
        version: row.version && typeof row.version === "object" ? { ...row.version } : null,
        clock: row.clock && typeof row.clock === "object" ? { ...row.clock } : null,
        source,
      });
    };

    for (const target of state.embeddedDeletionTargets?.values() || []) {
      const mappedUuid = state.annotationUuidByPdfRef.get(pdfAnnotationRefKey(target.ref));
      add({ ...target, uuid: mappedUuid || target.uuid }, {
        editorPayload: target.editorPayload, ref: target.ref, source: "embedded",
      });
    }

    for (const row of externalAnnotationMaskRows()) {
      if (!row?.uuid) continue;
      if (row.deleted === true || state.pendingBulkDeletedUuids.has(row.uuid) ||
          state.dirtyDeletedAnnotationIds.has(row.uuid)) {
        authoritativeTombstones.add(row.uuid);
        targets.delete(row.uuid);
        continue;
      }
      add(row, { editorPayload: row.editor, ref: row.embeddedRef, source: "sidecar" });
    }

    for (const row of state.annotationSnapshot.values()) {
      if (!row?.uuid || authoritativeTombstones.has(row.uuid)) continue;
      if (row.deleted === true) {
        targets.delete(row.uuid);
        continue;
      }
      add(row, {
        editorPayload: row.value,
        ref: row.operationReference || row.reference,
        source: "editor-snapshot",
      });
    }

    const latestOperations = new Map();
    for (const entry of state.annotationOperations) {
      if (entry?.operation?.uuid) latestOperations.set(entry.operation.uuid, entry.operation);
    }
    for (const operation of latestOperations.values()) {
      // annotationOperations retains acknowledged operations for sync history.
      // Only the current dirty revision may override an external snapshot or
      // tombstone; an acknowledged stale upsert must not resurrect a target.
      if (!state.dirtyAnnotationRevisions.has(operation.uuid)) continue;
      if (operation.deleted === true || operation.action === "delete") {
        targets.delete(operation.uuid);
        continue;
      }
      const payload = operation.payload?.editor ?? operation.serialized;
      add(operation, {
        editorPayload: payload,
        ref: operation.embeddedRef || operation.ref,
        source: "pending-operation",
      });
    }
    return targets;
  }

  function countKnownAnnotationDeletionTargets(pageIndex = null) {
    return collectKnownAnnotationDeletionTargets(pageIndex).size;
  }

  function getLiveAnnotationSidebarTexts() {
    const texts = new Map();
    if (typeof state === "undefined" || !state?.app) return texts;
    const manager = state.app.pdfViewer?._layerProperties?.annotationEditorUIManager;
    if (!manager) return texts;
    for (const [runtimeId, uuid] of state.annotationUuidByRuntimeId || []) {
      if (typeof uuid !== "string" || !uuid) continue;
      const editor = manager.getEditor?.(runtimeId);
      if (normalizeSyncKind(editor?.editorType) !== "Highlight") continue;
      // Accessibility labels can become localized editor role descriptions
      // after hydration. Only the exact selection capture is live quote evidence.
      const text = state.annotationTargetTextByRuntimeId?.get(runtimeId);
      if (typeof text === "string" && text.trim()) texts.set(uuid, text);
    }
    return texts;
  }

  function getAnnotationSidebarTargetTexts(targets) {
    const texts = getLiveAnnotationSidebarTexts();
    if (typeof state === "undefined" || !state?.app || !targets?.values) return texts;
    for (const row of targets.values()) {
      if (row?.deleted === true || normalizeSyncKind(row?.kind) !== "Highlight" ||
          typeof row?.uuid !== "string" || !row.uuid || texts.has(row.uuid)) continue;
      const storedText = row.editorPayload?.text;
      if (typeof storedText === "string" && storedText.trim()) continue;
      const text = getLegacyHighlightSidebarTargetText(row.pageIndex, row.editorPayload);
      if (text) texts.set(row.uuid, text);
    }
    return texts;
  }

  function getAnnotationSidebarTargetTextEvidence(targets) {
    const evidence = new Map();
    for (const [uuid, text] of getLiveAnnotationSidebarTexts()) {
      evidence.set(uuid, { text, source: "captured" });
    }
    if (!targets?.values) return evidence;
    for (const row of targets.values()) {
      if (!row || row.deleted === true || typeof row.uuid !== "string" || !row.uuid) continue;
      const kind = normalizeSyncKind(row.kind);
      const payload = row.editorPayload && typeof row.editorPayload === "object" ? row.editorPayload : null;
      if (kind === "FreeText" && typeof payload?.value === "string" && payload.value.trim()) {
        evidence.set(row.uuid, { text: payload.value, source: "stored" });
        continue;
      }
      if (kind !== "Highlight" || evidence.has(row.uuid)) continue;
      if (typeof payload?.text === "string" && payload.text.trim()) {
        evidence.set(row.uuid, { text: payload.text, source: "stored" });
        continue;
      }
      if (typeof state === "undefined" || !state?.app) continue;
      const recovered = getLegacyHighlightSidebarTargetText(row.pageIndex, payload);
      if (typeof recovered === "string" && recovered.trim()) {
        evidence.set(row.uuid, { text: recovered, source: "recovered" });
      }
    }
    return evidence;
  }

  function resolveAnnotationSidebarTargetTextEvidence(row, textEvidence) {
    const evidence = textEvidence?.get?.(row?.uuid);
    if (typeof evidence?.text === "string" && evidence.text.trim() &&
        ["captured", "stored", "recovered"].includes(evidence.source)) {
      return { targetText: evidence.text, targetTextSource: evidence.source };
    }
    return { targetText: "", targetTextSource: "unavailable" };
  }

  function resolveAnnotationSidebarTargetText(row, liveTexts) {
    const payload = row?.editorPayload && typeof row.editorPayload === "object"
      ? row.editorPayload
      : null;
    const candidates = row?.kind === "FreeText"
      ? [payload?.value]
      : row?.kind === "Highlight"
        ? [liveTexts?.get?.(row?.uuid), payload?.text]
        : [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const text = candidate.replace(/\s+/gu, " ").trim();
      if (text) return text;
    }
    return "（目标文字暂不可用）";
  }

  function buildAnnotationSidebarViewModels(targets, textEvidence = getAnnotationSidebarTargetTextEvidence(targets)) {
    return [...(targets?.values?.() || [])]
      .filter((row) => row && row.deleted !== true && typeof row.uuid === "string" &&
        row.uuid && Number.isSafeInteger(row.pageIndex) && row.pageIndex >= 0)
      .map((row) => {
        const rowTextEvidence = resolveAnnotationSidebarTargetTextEvidence(row, textEvidence);
        const targetText = rowTextEvidence.targetText;
        return {
          uuid: row.uuid,
          pageIndex: row.pageIndex,
          pageIdentity: row.pageIdentity || null,
          sourceHash: row.sourceHash || null,
          kind: normalizeSyncKind(row.kind),
          editorPayload: row.editorPayload && typeof row.editorPayload === "object"
            ? row.editorPayload
            : null,
          version: row.version && typeof row.version === "object" ? { ...row.version } : null,
          clock: row.clock && typeof row.clock === "object" ? { ...row.clock } : null,
          targetText,
          targetTextSource: rowTextEvidence.targetTextSource,
          displayText: targetText ? targetText.replace(/\s+/gu, " ").trim() : "（目标文字暂不可用）",
        };
      })
      .sort((left, right) => left.pageIndex - right.pageIndex ||
        (left.uuid < right.uuid ? -1 : left.uuid > right.uuid ? 1 : 0));
  }

  function createAnnotationSidebarController({
    button,
    menu,
    sidebar,
    list,
    count,
    closeButton,
    searchInput = null,
    typeFilter = null,
    collectTargets,
    createSessionGuard,
    navigate,
    onAddToReview = null,
  }) {
    let open = false;
    let refreshFrame = null;
    let pendingTargetRefresh = false;
    let selectedUuid = null;
    let items = [];
    let visibleItems = [];

    function setSelected(uuid, focus = false) {
      selectedUuid = uuid;
      for (const row of list.querySelectorAll("li.sidebarComment")) {
        const selected = row.dataset.uuid === uuid;
        row.classList.toggle("selected", selected);
        const navigateButton = row.children?.[0];
        navigateButton?.classList.toggle("selected", selected);
        navigateButton?.setAttribute("aria-pressed", String(selected));
        if (navigateButton) navigateButton.tabIndex = selected ? 0 : -1;
        if (selected && focus) navigateButton?.focus();
      }
    }

    async function activate(row, focus = false) {
      const item = items.find((candidate) => candidate.uuid === row?.dataset?.uuid);
      if (!open || !item) return false;
      const guard = createSessionGuard();
      const result = await navigate(item.uuid, item.pageIndex, guard);
      if (!open || !guard() || result?.ok !== true) return false;
      setSelected(item.uuid, focus);
      return true;
    }

    function filteredItems() {
      const term = typeof searchInput?.value === "string"
        ? searchInput.value.trim().replace(/\s+/gu, " ").toLocaleLowerCase()
        : "";
      const kind = typeof typeFilter?.value === "string" ? typeFilter.value : "all";
      return items.filter((item) => {
        if (kind !== "all" && kind && item.kind !== kind) return false;
        if (!term) return true;
        if (item.targetTextSource === "unavailable" || !item.targetText) return false;
        return item.targetText.replace(/\s+/gu, " ").toLocaleLowerCase().includes(term);
      });
    }

    function render({ reloadTargets = false } = {}) {
      if (!open) return;
      if (reloadTargets) items = buildAnnotationSidebarViewModels(collectTargets());
      if (selectedUuid && !items.some((item) => item.uuid === selectedUuid)) selectedUuid = null;
      visibleItems = filteredItems();
      const fragment = document.createDocumentFragment();
      for (const item of visibleItems) {
        const row = document.createElement("li");
        row.className = "sidebarComment";
        row.setAttribute("role", "group");
        row.dataset.uuid = item.uuid;
        row.dataset.pageIndex = String(item.pageIndex);

        const navigateButton = document.createElement("button");
        navigateButton.type = "button";
        navigateButton.className = "pdfReaderAnnotationSidebarNavigate";
        navigateButton.setAttribute("aria-pressed", String(item.uuid === selectedUuid));
        navigateButton.tabIndex = item.uuid === selectedUuid ? 0 : -1;
        const pageLabel = `p${String(item.pageIndex + 1).padStart(3, "0")} · ${item.kind}`;
        const page = document.createElement("time");
        page.textContent = pageLabel;
        page.setAttribute("aria-label", pageLabel);
        const text = document.createElement("div");
        text.className = "sidebarCommentText";
        text.textContent = item.displayText;
        text.title = item.displayText;
        text.setAttribute("aria-label", item.displayText);
        navigateButton.setAttribute("aria-label", `${pageLabel} · ${item.displayText}`);
        navigateButton.append(page, text);
        row.append(navigateButton);
        if (item.kind === "Highlight") {
          const reviewButton = document.createElement("button");
          reviewButton.type = "button";
          reviewButton.className = "pdfReaderAnnotationReviewButton";
          reviewButton.textContent = "加入复习";
          reviewButton.setAttribute("aria-label", `将第 ${item.pageIndex + 1} 页高亮加入复习`);
          reviewButton.disabled = !item.targetText || item.targetTextSource === "unavailable" ||
            typeof onAddToReview !== "function";
          reviewButton.title = !item.targetText || item.targetTextSource === "unavailable"
            ? "目标文字暂不可用，无法加入复习"
            : typeof onAddToReview !== "function" ? "复习功能尚未连接" : "加入复习";
          row.append(reviewButton);
        }
        fragment.append(row);
      }
      list.replaceChildren(fragment);
      count.textContent = String(visibleItems.length);
      setSelected(selectedUuid);
    }

    function scheduleRender({ reloadTargets = false } = {}) {
      if (!open) return false;
      if (reloadTargets) pendingTargetRefresh = true;
      if (refreshFrame !== null) return false;
      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = null;
        const shouldReload = pendingTargetRefresh;
        pendingTargetRefresh = false;
        render({ reloadTargets: shouldReload });
      });
      return true;
    }

    function openSidebar() {
      if (button.disabled) return false;
      open = true;
      menu.classList.remove("hidden");
      button.setAttribute("aria-expanded", "true");
      scheduleRender({ reloadTargets: true });
      return true;
    }

    function close() {
      open = false;
      if (refreshFrame !== null) cancelAnimationFrame(refreshFrame);
      refreshFrame = null;
      pendingTargetRefresh = false;
      menu.classList.add("hidden");
      button.setAttribute("aria-expanded", "false");
      return true;
    }

    function closeAndClear() {
      close();
      selectedUuid = null;
      items = [];
      visibleItems = [];
      if (searchInput) searchInput.value = "";
      if (typeFilter) typeFilter.value = "all";
      list.replaceChildren();
      count.textContent = "0";
    }

    function refreshIfOpen() {
      return scheduleRender({ reloadTargets: true });
    }

    function onSearchInput() {
      scheduleRender();
    }

    function onTypeFilterChange() {
      scheduleRender();
    }

    function onButtonClick() {
      if (open) close();
      else openSidebar();
    }

    function onCloseClick() {
      close();
      button.focus();
    }

    function onListClick(event) {
      const reviewButton = event.target?.closest?.(".pdfReaderAnnotationReviewButton");
      if (reviewButton) {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (reviewButton.disabled || !open) return;
        const row = reviewButton.closest?.("li.sidebarComment");
        void createReviewDraft(row?.dataset?.uuid);
        return;
      }
      const row = event.target?.closest?.("li.sidebarComment");
      if (!row || !list.contains(row)) return;
      void activate(row, false);
    }

    function onListKeyDown(event) {
      if (event.target?.closest?.(".pdfReaderAnnotationReviewButton")) return;
      const navigateButton = event.target?.closest?.(".pdfReaderAnnotationSidebarNavigate");
      if (!navigateButton) return;
      const row = event.target?.closest?.("li.sidebarComment");
      const index = visibleItems.findIndex((item) => item.uuid === row?.dataset?.uuid);
      let nextIndex = index;
      if (event.key === "ArrowDown") nextIndex = Math.min(visibleItems.length - 1, Math.max(0, index + 1));
      else if (event.key === "ArrowUp") nextIndex = Math.max(0, index < 0 ? 0 : index - 1);
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = visibleItems.length - 1;
      else if (event.key === "Enter" || event.key === " ") {
        if (row) {
          event.preventDefault();
          void activate(row, true);
        }
        return;
      } else return;
      if (!visibleItems.length) return;
      event.preventDefault();
      const next = [...list.querySelectorAll("li.sidebarComment")]
        .find((candidate) => candidate.dataset.uuid === visibleItems[nextIndex].uuid);
      next?.children?.[0]?.focus();
    }

    button.addEventListener("click", onButtonClick);
    closeButton.addEventListener("click", onCloseClick);
    list.addEventListener("click", onListClick);
    list.addEventListener("keydown", onListKeyDown);
    searchInput?.addEventListener("input", onSearchInput);
    typeFilter?.addEventListener("change", onTypeFilterChange);
    sidebar.querySelector("#editorCommentsSidebarResizer")?.setAttribute("hidden", "");
    function createReviewDraft(uuid) {
      const guard = createSessionGuard();
      if (!guard()) return false;
      const item = buildAnnotationSidebarViewModels(collectTargets()).find(candidate => candidate.uuid === uuid);
      if (!item || item.kind !== "Highlight" || !item.targetText ||
          item.targetTextSource === "unavailable" || typeof onAddToReview !== "function") return false;
      return onAddToReview({ uuid: item.uuid, pageIndex: item.pageIndex,
        targetText: item.targetText, targetTextSource: item.targetTextSource }, guard);
    }
    return {
      open: openSidebar,
      close,
      closeAndClear,
      refreshIfOpen,
      isOpen: () => open,
      createReviewDraft,
      dispose() {
        closeAndClear();
        button.removeEventListener("click", onButtonClick);
        closeButton.removeEventListener("click", onCloseClick);
        list.removeEventListener("click", onListClick);
        list.removeEventListener("keydown", onListKeyDown);
        searchInput?.removeEventListener("input", onSearchInput);
        typeFilter?.removeEventListener("change", onTypeFilterChange);
      },
    };
  }

  function latestPendingAnnotationOperation(uuid) {
    for (let index = state.annotationOperations.length - 1; index >= 0; index -= 1) {
      const operation = state.annotationOperations[index]?.operation;
      if (operation?.uuid === uuid) return operation;
    }
    return null;
  }

  function collectManagedAnnotationDeletionPlan(pageIndex = null) {
    const app = state.app;
    const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    if (!app?.pdfDocument || !manager?.getEditors) {
      return { targets: new Map(), liveEditors: [], sidecarOnly: [] };
    }
    const targets = collectKnownAnnotationDeletionTargets(pageIndex);
    // Refresh runtime-to-stable UUID bindings before looking up editor objects.
    // This enumerates the live PDF.js model once at the user's explicit action.
    const currentRows = getAnnotationStorageRows(app, { includeLiveEditors: true });
    for (const row of currentRows.values()) {
      if (!row?.uuid || row.deleted === true) continue;
      if (pageIndex !== null && row.pageIndex !== pageIndex) continue;
      let target = targets.get(row.uuid);
      if (!target) {
        const kind = normalizeSyncKind(row.kind);
        if (!EXTERNAL_ANNOTATION_KINDS.has(kind)) continue;
        target = {
          uuid: row.uuid,
          pageIndex: row.pageIndex,
          kind,
          ref: canonicalPdfAnnotationRef(row.operationReference || row.reference),
          editorPayload: row.value && typeof row.value === "object" ? row.value : null,
          source: "editor-snapshot",
        };
        targets.set(row.uuid, target);
      }
      target.editorPayload = row.value && typeof row.value === "object"
        ? row.value : target.editorPayload;
      target.ref ||= canonicalPdfAnnotationRef(row.operationReference || row.reference);
    }

    const liveEditors = [];
    const liveUuids = new Set();
    for (const row of currentRows.values()) {
      if (!row?.uuid || row.deleted === true || !targets.has(row.uuid)) continue;
      const editor = manager.getEditor?.(row.runtimeId);
      if (editor && editor.deleted !== true) {
        liveEditors.push(editor);
        liveUuids.add(row.uuid);
      }
    }
    // Unchanged hydrated editors legitimately serialize to null and need not
    // appear in AnnotationStorage. Their exact hydration binding still owns
    // a live editor; do not mistake it for an offscreen-only record.
    for (const target of targets.values()) {
      if (liveUuids.has(target.uuid)) continue;
      const binding = state.externalAnnotationHydration.get(target.uuid);
      if (!binding || binding.pageIndex !== target.pageIndex) continue;
      const editor = manager.getEditor?.(binding.runtimeId);
      if (!editor || editor.deleted === true || editor.pageIndex !== target.pageIndex) continue;
      const mappedUuid = state.annotationUuidByRuntimeId.get(String(editor.id));
      if (mappedUuid && mappedUuid !== target.uuid) continue;
      liveEditors.push(editor);
      liveUuids.add(target.uuid);
    }
    const sidecarOnly = [...targets.values()].filter((target) => !liveUuids.has(target.uuid));
    return { targets, liveEditors, sidecarOnly };
  }

  function captureBulkDeleteSession() {
    const app = state.app;
    return {
      documentId: state.activeDocumentId,
      openRequest: state.activeOpenRequest,
      app,
      pdfDocument: app?.pdfDocument || null,
      manager: app?.pdfViewer?._layerProperties?.annotationEditorUIManager || null,
      rendererGeneration,
    };
  }

  function isCurrentBulkDeleteSession(session) {
    return !!session && !state.disposed &&
      state.activeDocumentId === session.documentId &&
      state.activeOpenRequest === session.openRequest &&
      state.requestedOpenRequest === session.openRequest &&
      state.app === session.app &&
      session.pdfDocument != null &&
      state.app?.pdfDocument === session.pdfDocument &&
      rendererGeneration === session.rendererGeneration &&
      session.manager != null &&
      state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager === session.manager;
  }

  async function prepareEmbeddedDeletionTargets(session, pageIndex = null) {
    if (!isCurrentBulkDeleteSession(session)) return false;
    if (typeof session.pdfDocument.getPage !== "function" ||
        typeof state.annotationController?.scanEmbeddedDeletionTargets !== "function") return true;
    if (!state.externalSourceConfirmed || state.readOnly) return false;
    let scan = state.embeddedDeletionScan;
    if (!scan || scan.pdfDocument !== session.pdfDocument) {
      scan = { pdfDocument: session.pdfDocument, requests: new Map() };
      state.embeddedDeletionScan = scan;
      state.embeddedDeletionTargets.clear();
    }
    const key = pageIndex === null ? "all" : pageIndex;
    if (scan.requests.has("all")) return scan.requests.get("all");
    if (scan.requests.has(key)) return scan.requests.get(key);
    const request = (async () => {
      const targets = await state.annotationController.scanEmbeddedDeletionTargets(
        session.pdfDocument, session.documentId, {
          pageIndex,
          isCurrent: () => isCurrentBulkDeleteSession(session),
          resolveUuid: (ref, page) => {
            const existing = [...state.externalAnnotationRows.values()].find((row) =>
              row.pageIndex === page && canonicalPdfAnnotationRef(row.embeddedRef) === ref);
            return existing?.uuid || state.annotationUuidByPdfRef.get(pdfAnnotationRefKey(ref));
          },
        },
      );
      if (!isCurrentBulkDeleteSession(session) || state.readOnly || !state.externalSourceConfirmed) return false;
      for (const target of targets) state.embeddedDeletionTargets.set(target.uuid, target);
      return true;
    })();
    scan.requests.set(key, request);
    try { return await request; }
    catch (error) { scan.requests.delete(key); throw error; }
  }

  function requestManagedAnnotationDeletion(pageIndex = null, expectedSession = null) {
    if (expectedSession && !isCurrentBulkDeleteSession(expectedSession)) return;
    void deleteManagedAnnotations(pageIndex, expectedSession).catch((error) => {
      state.bulkDeleteInProgress = false;
      syncBridgeControls();
      if (expectedSession && !isCurrentBulkDeleteSession(expectedSession)) return;
      sendError(error?.message || "无法安全删除批注。", {
        documentId: expectedSession?.documentId ?? state.activeDocumentId,
        openRequest: expectedSession?.openRequest ?? state.activeOpenRequest,
        code: "bulk-annotation-delete-failed",
      });
    });
  }

  function replaceAnnotationOperation(operation, revision) {
    const existingIndex = state.annotationOperations.findIndex(
      (entry) => entry.operation?.uuid === operation.uuid,
    );
    if (existingIndex >= 0) state.annotationOperations.splice(existingIndex, 1);
    state.annotationOperations.push({ revision, operation });
    markDirtyAnnotation(
      operation.uuid,
      operation.pageIndex,
      operation.deleted ? "delete" : "upsert",
      revision,
      false,
    );
  }

  function createManagedAnnotationOperation(target, deleted) {
    const stamp = makeSyncStamp();
    const editorPayload = target.editorPayload && typeof target.editorPayload === "object"
      ? normalizeSyncValue(target.editorPayload)
      : null;
    if (!deleted && !editorPayload) {
      throw new Error(`无法安全恢复批注 ${target.uuid}：缺少完整编辑数据。`);
    }
    return {
      uuid: target.uuid,
      ref: target.ref || null,
      pageIndex: target.pageIndex,
      kind: target.kind,
      provenance: target.source === "embedded" ? "embedded" : "external",
      deleted,
      action: deleted ? "delete" : "upsert",
      ...stamp,
      serialized: deleted ? { deleted: true } : editorPayload,
      payload: deleted ? null : { editor: editorPayload },
    };
  }

  function applySidecarBulkDelete(targets, deleted, { advanceRevision = false } = {}) {
    if (!targets.length) return false;
    const revision = state.revision + 1;
    for (const target of targets) {
      if (target.ref) {
        const key = pdfAnnotationRefKey(target.ref);
        const existing = state.annotationUuidByPdfRef.get(key);
        if (existing && existing !== target.uuid) throw new Error("PDF 批注身份已变化，请重新确认删除。");
      }
    }
    for (const target of targets) {
      if (target.ref) state.annotationUuidByPdfRef.set(pdfAnnotationRefKey(target.ref), target.uuid);
      const operation = createManagedAnnotationOperation(target, deleted);
      replaceAnnotationOperation(operation, revision);
      state.externalAnnotationRows?.set(target.uuid, {
        uuid: target.uuid, pageIndex: target.pageIndex, kind: target.kind,
        provenance: target.source === "embedded" ? "embedded" : "external",
        embeddedRef: target.ref || null, deleted,
        editor: deleted ? null : target.editorPayload,
        clock: { timestamp: operation.timestamp, logical: operation.logical,
          deviceId: operation.deviceId, opId: operation.operationId },
      });
      if (deleted) state.pendingBulkDeletedUuids.add(target.uuid);
      else state.pendingBulkDeletedUuids.delete(target.uuid);
    }
    // Initial command execution is followed by the existing addCommands
    // mutation observer. Undo/redo bypass addCommands, so explicitly advance
    // the revision and autosave after those history transitions.
    if (advanceRevision) noteMutation();
    if (state.app?.pdfDocument) {
      const session = captureBulkDeleteSession();
      setDeferredTimeout(() => {
        if (!isCurrentBulkDeleteSession(session)) return;
        for (const page of new Set(targets.map((target) => target.pageIndex))) {
          void hydrateExternalAnnotationsForPage(page).catch((error) => {
            if (isCurrentBulkDeleteSession(session)) sendError(error.message || "无法更新批注显示。", {
              documentId: session.documentId, openRequest: session.openRequest,
              code: "bulk-annotation-preview-failed",
            });
          });
        }
      }, 0);
    }
    state.annotationSidebarController?.refreshIfOpen();
    syncBridgeControls();
    return true;
  }

  function applyManagedBulkDelete(plan, deleted, { advanceRevision = false } = {}) {
    const targets = [...(plan?.targets?.values?.() || [])];
    if (!targets.length) return false;
    // Live PDF.js editors also need the owner-side tombstone guard. Their
    // remove() event can be followed by a stale AnnotationStorage/editor
    // snapshot; guarding only sidecar-only rows lets that snapshot re-emit an
    // upsert after the user's explicit bulk delete.
    return applySidecarBulkDelete(targets, deleted, { advanceRevision });
  }

  function addSidecarBulkDeleteUndoCommand(manager, targets, isCurrent = null) {
    if (!targets.length) return false;
    const records = targets.map((target) => ({ ...target }));
    let firstExecution = true;
    manager.addCommands({
      cmd: () => {
        if (typeof isCurrent === "function" && !isCurrent()) return;
        applySidecarBulkDelete(records, true, {
          advanceRevision: !firstExecution,
        });
        firstExecution = false;
      },
      undo: () => {
        if (typeof isCurrent === "function" && !isCurrent()) return;
        applySidecarBulkDelete(records, false, { advanceRevision: true });
      },
      mustExec: true,
    });
    return true;
  }

  async function deleteManagedAnnotations(pageIndex = null, expectedSession = null) {
    const session = expectedSession || captureBulkDeleteSession();
    if (!isCurrentBulkDeleteSession(session)) return false;
    if (state.readOnly || state.bulkDeleteInProgress || isEditBoundaryBusy() ||
        state.pendingInkCommit || state.freeTextInputPending ||
        (state.freeTextFocused && !state.freeTextCommittedForSave)) {
      showStatus("请结束当前批注或文字输入后，再删除批注。");
      return false;
    }
    const documentId = session.documentId;
    const manager = session.manager;
    if (!manager) return false;
    if (!(await prepareEmbeddedDeletionTargets(session, pageIndex))) return false;
    const plan = collectManagedAnnotationDeletionPlan(pageIndex);
    if (!plan.targets.size) {
      showStatus(pageIndex === null ? "没有可删除的批注。" : "本页没有可删除的批注。");
      return false;
    }
    const incomplete = plan.sidecarOnly.filter((target) => !target.editorPayload);
    if (incomplete.length) {
      showStatus("部分批注缺少可验证的编辑数据，已停止批量删除；没有写入这些批注。");
      return false;
    }

    state.bulkDeleteInProgress = true;
    syncBridgeControls();
    try {
      // A freshly hydrated editor may still be completing its async toolbar
      // construction. Let that PDF.js microtask finish before remove() tears
      // the toolbar down, which otherwise can leave a rejected addButton task.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (state.disposed || !isCurrentBulkDeleteSession(session) ||
          state.activeDocumentId !== documentId || state.app?.pdfDocument == null) {
        return false;
      }
      if (isEditBoundaryBusy() || state.pendingInkCommit || state.freeTextInputPending ||
          (state.freeTextFocused && !state.freeTextCommittedForSave)) {
        showStatus("请结束当前批注或文字输入后，再删除批注。");
        return false;
      }
      if (plan.liveEditors.length) {
        const isCurrent = () => isCurrentBulkDeleteSession(session);
        const deleted = await state.annotationController?.deleteEditors(plan.liveEditors, {
          onDelete: ({ redo }) => {
            if (!isCurrent()) return;
            applyManagedBulkDelete(plan, true, { advanceRevision: redo === true });
          },
          onRestore: () => {
            if (!isCurrent()) return;
            applyManagedBulkDelete(plan, false, { advanceRevision: true });
          },
          isCurrent,
        }) || 0;
        if (state.disposed || !isCurrentBulkDeleteSession(session)) return false;
        if (deleted !== plan.liveEditors.length) {
          throw new Error("当前批注未能进入安全删除状态，未删除任何已加载批注。");
        }
      } else if (plan.sidecarOnly.length) {
        addSidecarBulkDeleteUndoCommand(
          manager,
          plan.sidecarOnly,
          () => isCurrentBulkDeleteSession(session),
        );
      }
      state.app?.secondaryToolbar?.close();
      showStatus(`已删除 ${plan.targets.size} 条批注，正在保存；可用撤销恢复。`);
      return true;
    } catch (error) {
      sendError(error?.message || "无法删除批注。", {
        documentId: state.activeDocumentId,
        openRequest: state.activeOpenRequest,
        code: "bulk-annotation-delete-failed",
      });
      return false;
    } finally {
      state.bulkDeleteInProgress = false;
      syncBridgeControls();
    }
  }

  async function showDeleteAllAnnotationsConfirmation() {
    if (state.bulkDeleteDialog) return;
    const session = captureBulkDeleteSession();
    if (!isCurrentBulkDeleteSession(session)) return;
    try {
      if (!(await prepareEmbeddedDeletionTargets(session))) return;
    } catch (error) {
      sendError(error?.message || "无法读取 PDF 内嵌批注。", {
        documentId: session.documentId, openRequest: session.openRequest,
        code: "bulk-annotation-scan-failed",
      });
      return;
    }
    if (state.bulkDeleteDialog || !isCurrentBulkDeleteSession(session)) return;
    const initialTargets = collectKnownAnnotationDeletionTargets();
    const count = initialTargets.size;
    if (!count) {
      showStatus("没有可删除的批注。");
      return;
    }
    const previousFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "pdfReaderBulkDeleteOverlay";
    overlay.setAttribute("data-pdf-reader-ui", "true");
    const dialog = document.createElement("section");
    dialog.className = "pdfReaderBulkDeleteDialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "pdfReaderBulkDeleteTitle");
    dialog.setAttribute("aria-describedby", "pdfReaderBulkDeleteDescription");
    const title = document.createElement("h2");
    title.id = "pdfReaderBulkDeleteTitle";
    title.textContent = "删除所有页的批注？";
    const description = document.createElement("p");
    description.id = "pdfReaderBulkDeleteDescription";
    description.textContent = `将删除 ${count} 条本插件管理的批注。此操作会写入可同步的删除记录，原始 PDF 文件保持不变；删除后可用撤销恢复。`;
    const actions = document.createElement("div");
    actions.className = "pdfReaderBulkDeleteActions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "pdfReaderBulkDeleteCancel";
    cancel.textContent = "取消";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "pdfReaderBulkDeleteConfirm";
    confirm.textContent = "删除所有批注";
    actions.append(cancel, confirm);
    dialog.append(title, description, actions);
    overlay.append(dialog);
    document.body.append(overlay);

    const close = () => {
      if (state.bulkDeleteDialog?.overlay !== overlay) return;
      overlay.remove();
      state.bulkDeleteDialog = null;
      if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = [...dialog.querySelectorAll("button:not(:disabled)")];
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    cancel.addEventListener("click", close);
    const dialogState = {
      overlay,
      close,
      documentId: session.documentId,
      openRequest: session.openRequest,
      targetUuids: new Set(initialTargets.keys()),
    };
    confirm.addEventListener("click", () => {
      if (state.bulkDeleteDialog !== dialogState) return;
      if (!isCurrentBulkDeleteSession(session)) {
        close();
        return;
      }
      const currentTargets = collectKnownAnnotationDeletionTargets();
      const currentUuids = new Set(currentTargets.keys());
      const targetsChanged = currentUuids.size !== dialogState.targetUuids.size ||
        [...currentUuids].some((uuid) => !dialogState.targetUuids.has(uuid));
      if (targetsChanged) {
        dialogState.targetUuids = currentUuids;
        if (!currentTargets.size) {
          close();
          showStatus("没有可删除的批注。");
          return;
        }
        description.textContent = `批注列表已变化。将删除 ${currentTargets.size} 条本插件管理的批注。此操作会写入可同步的删除记录，原始 PDF 文件保持不变；删除后可用撤销恢复。请再次确认。`;
        return;
      }
      close();
      requestManagedAnnotationDeletion(null, session);
    });
    state.bulkDeleteDialog = dialogState;
    cancel.focus();
  }

  function installBridgeControls() {
    if (state.bridgeControls) {
      return;
    }
    const toolbar = document.getElementById("toolbarViewerRight");
    const secondaryContainer = document.getElementById(
      "secondaryToolbarButtonContainer",
    );
    const saveButton = document.getElementById("secondaryDownload");
    if (!toolbar || !secondaryContainer || !saveButton) {
      return;
    }
    hideUnusedToolbarControls();
    const group = document.createElement("div");
    group.className = "toolbarHorizontalGroup pdfReaderBridgeControls";
    group.setAttribute("aria-label", "PDF 撤销与重做");

    const annotationSidebar = document.getElementById("editorCommentsSidebar");
    const annotationSidebarList = document.getElementById("editorCommentsSidebarList");
    const annotationSidebarCount = document.getElementById("editorCommentsSidebarCount");
    const annotationSidebarClose = document.getElementById("editorCommentsSidebarCloseButton");
    const annotationSidebarListContainer = document.getElementById("editorCommentsSidebarListContainer");
    let annotationSidebarButton = null;
    if (annotationSidebar && annotationSidebarList && annotationSidebarCount && annotationSidebarClose) {
      const filters = document.createElement("div");
      filters.className = "pdfReaderAnnotationSidebarFilters";
      const searchInput = document.createElement("input");
      searchInput.id = "pdfReaderAnnotationSidebarSearch";
      searchInput.type = "search";
      searchInput.placeholder = "搜索已保存文字";
      searchInput.setAttribute("aria-label", "搜索批注文字");
      const typeFilter = document.createElement("select");
      typeFilter.id = "pdfReaderAnnotationSidebarTypeFilter";
      typeFilter.setAttribute("aria-label", "按批注类型筛选");
      for (const [value, label] of [
        ["all", "全部类型"], ["Highlight", "Highlight"], ["Underline", "Underline"],
        ["FreeText", "FreeText"], ["Square", "Square"], ["Ink", "Ink"],
        ["InkHighlight", "InkHighlight"],
      ]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        typeFilter.append(option);
      }
      const filterHelp = document.createElement("p");
      filterHelp.className = "pdfReaderAnnotationSidebarHelp";
      filterHelp.textContent = "仅检索已保存文字及已渲染页面可恢复文字";
      filters.append(searchInput, typeFilter, filterHelp);
      if (annotationSidebarListContainer?.parentElement === annotationSidebar) {
        annotationSidebar.insertBefore(filters, annotationSidebarListContainer);
      } else {
        annotationSidebar.append(filters);
      }

      const container = document.createElement("div");
      container.className = "toolbarButtonWithContainer pdfReaderAnnotationSidebarControl";
      annotationSidebarButton = document.createElement("button");
      annotationSidebarButton.id = "pdfReaderAnnotationSidebarButton";
      annotationSidebarButton.type = "button";
      annotationSidebarButton.className = "toolbarButton pdfReaderAnnotationSidebarButton";
      annotationSidebarButton.title = "批注";
      annotationSidebarButton.setAttribute("aria-label", "批注");
      annotationSidebarButton.setAttribute("aria-expanded", "false");
      annotationSidebarButton.setAttribute("aria-haspopup", "true");
      annotationSidebarButton.setAttribute("aria-controls", "pdfReaderAnnotationSidebarMenu");

      const menu = document.createElement("div");
      menu.id = "pdfReaderAnnotationSidebarMenu";
      menu.className = "editorParamsToolbar hidden menu pdfReaderAnnotationSidebarMenu";
      menu.setAttribute("aria-label", "批注列表");
      annotationSidebar.setAttribute("aria-label", "批注列表");
      menu.append(annotationSidebar);
      container.append(annotationSidebarButton, menu);
      group.append(container);
      state.annotationSidebarController = createAnnotationSidebarController({
        button: annotationSidebarButton,
        menu,
        sidebar: annotationSidebar,
        list: annotationSidebarList,
        count: annotationSidebarCount,
        closeButton: annotationSidebarClose,
        searchInput,
        typeFilter,
        collectTargets: () => collectKnownAnnotationDeletionTargets(),
        createSessionGuard: () => {
          const documentId = state.activeDocumentId;
          const openRequest = state.activeOpenRequest;
          const source = state.actualSourceIdentity;
          return () => !state.disposed && state.activeDocumentId === documentId &&
            state.activeOpenRequest === openRequest && state.actualSourceIdentity === source &&
            state.externalSourceConfirmed && !state.externalSourceMismatch &&
            source?.identityStatus === "KNOWN";
        },
        navigate: navigateToAnnotationUuid,
        onAddToReview: (item, guard) => {
          const actual = state.actualSourceIdentity;
          const pageIdentity = actual?.orderedPageIdentities?.[item.pageIndex];
          if (!guard() || typeof pageIdentity !== "string" || !actual?.sourceHash) return false;
          return postToHost("learning-review-draft-request", {
            documentId: state.activeDocumentId,
            openRequest: state.activeOpenRequest,
            sourceHash: actual.sourceHash,
            revision: state.revision,
            confirmedRevision: state.confirmedRevision,
            dirty: isDirty() || state.dirtyAnnotationRevisions.size > 0,
            pending: Boolean(state.savePromise || state.pendingSave || state.pendingRecovery ||
              state.recoveryPromise || state.pendingExternalAnnotationsUpdate ||
              state.hydratingExternalAnnotations || state.syncCheckpointInProgress),
            pageIndex: item.pageIndex,
            pageIdentity,
            uuid: item.uuid,
            targetText: item.targetText,
            targetTextSource: item.targetTextSource,
          });
        },
      });
    }

    const historyButtons = {};
    for (const [action, symbol, label, id] of [
      ["undo", "↶", "撤销", "pdfReaderBridgeUndoButton"],
      ["redo", "↷", "重做", "pdfReaderBridgeRedoButton"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.id = id;
      button.className = "toolbarButton pdfReaderBridgeControlButton pdfReaderBridgeHistoryButton";
      const glyph = document.createElement("span");
      glyph.className = "pdfReaderBridgeHistoryGlyph";
      glyph.textContent = symbol;
      button.append(glyph);
      button.title = label;
      button.setAttribute("aria-label", label);
      button.dataset.action = action;
      button.addEventListener("click", () => runBridgeAction(action));
      group.append(button);
      historyButtons[action] = button;
    }

    const deleteButton = document.createElement("button");
    deleteButton.id = "pdfReaderBridgeDeleteButton";
    deleteButton.type = "button";
    deleteButton.className = "toolbarButton labeled pdfReaderBridgeDeleteButton";
    deleteButton.title = "删除所选批注";
    deleteButton.setAttribute("aria-label", deleteButton.title);
    deleteButton.dataset.action = "delete";
    const deleteLabel = document.createElement("span");
    deleteLabel.textContent = deleteButton.title;
    deleteButton.append(deleteLabel);
    deleteButton.addEventListener("click", () => runBridgeAction("delete"));
    if (deleteButton.parentElement !== secondaryContainer) {
      secondaryContainer.insertBefore(deleteButton, saveButton);
    }

    const deletePageAnnotationsButton = document.createElement("button");
    deletePageAnnotationsButton.id = "pdfReaderBridgeDeletePageAnnotationsButton";
    deletePageAnnotationsButton.type = "button";
    deletePageAnnotationsButton.className = "toolbarButton labeled pdfReaderBridgeBulkDeleteButton";
    deletePageAnnotationsButton.title = "删除本页所有批注";
    deletePageAnnotationsButton.setAttribute("aria-label", deletePageAnnotationsButton.title);
    deletePageAnnotationsButton.dataset.action = "delete-page-annotations";
    const deletePageLabel = document.createElement("span");
    deletePageLabel.textContent = deletePageAnnotationsButton.title;
    deletePageAnnotationsButton.append(deletePageLabel);
    deletePageAnnotationsButton.addEventListener("click", () =>
      runBridgeAction("delete-page-annotations"),
    );
    secondaryContainer.insertBefore(deletePageAnnotationsButton, saveButton);

    const deleteAllAnnotationsButton = document.createElement("button");
    deleteAllAnnotationsButton.id = "pdfReaderBridgeDeleteAllAnnotationsButton";
    deleteAllAnnotationsButton.type = "button";
    deleteAllAnnotationsButton.className = "toolbarButton labeled pdfReaderBridgeBulkDeleteButton";
    deleteAllAnnotationsButton.title = "删除所有页的批注";
    deleteAllAnnotationsButton.setAttribute("aria-label", deleteAllAnnotationsButton.title);
    deleteAllAnnotationsButton.dataset.action = "delete-all-annotations";
    const deleteAllLabel = document.createElement("span");
    deleteAllLabel.textContent = deleteAllAnnotationsButton.title;
    deleteAllAnnotationsButton.append(deleteAllLabel);
    deleteAllAnnotationsButton.addEventListener("click", () =>
      runBridgeAction("delete-all-annotations"),
    );
    secondaryContainer.insertBefore(deleteAllAnnotationsButton, saveButton);

    const vocabularyToggleButton = document.createElement("button");
    vocabularyToggleButton.id = "pdfReaderVocabularyToggleButton";
    vocabularyToggleButton.type = "button";
    vocabularyToggleButton.className = "toolbarButton labeled pdfReaderVocabularyToggleButton";
    vocabularyToggleButton.textContent = "LingQ 模式";
    vocabularyToggleButton.setAttribute("aria-label", "LingQ 模式");
    vocabularyToggleButton.setAttribute("aria-pressed", String(state.vocabularyEnabled === true));
    vocabularyToggleButton.addEventListener("click", toggleVocabularyFromMenu);
    // Keep the existing delete-action group contiguous; the LingQ toggle is
    // available in this menu without changing the bulk-delete toolbar order.
    secondaryContainer.insertBefore(vocabularyToggleButton, deleteButton);

    const vocabularyDisplayModeButton = document.createElement("button");
    vocabularyDisplayModeButton.id = "pdfReaderVocabularyDisplayModeButton";
    vocabularyDisplayModeButton.type = "button";
    vocabularyDisplayModeButton.className = "toolbarButton labeled pdfReaderVocabularyDisplayModeButton";
    vocabularyDisplayModeButton.addEventListener("click", cycleVocabularyDisplayMode);
    secondaryContainer.insertBefore(vocabularyDisplayModeButton, deleteButton);

    const secondaryToolbar = document.getElementById("secondaryToolbarToggle");
    if (secondaryToolbar?.parentElement === toolbar) {
      toolbar.insertBefore(group, secondaryToolbar);
    } else {
      toolbar.append(group);
    }
    state.bridgeControls = {
      group,
      historyButtons,
      deleteButton,
      deletePageAnnotationsButton,
      deleteAllAnnotationsButton,
      vocabularyToggleButton,
      vocabularyDisplayModeButton,
      annotationSidebarButton,
      saveButton,
    };
    installAdaptiveToolbarLayout();
    syncBridgeControls();
    syncVocabularyDisplayModeButton();
  }

  function makeArrayBuffer(value) {
    if (value instanceof ArrayBuffer) {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      // PDF.js RPC returns a buffer owned by this request in the Viewer realm.
      // Hand it to the host instead of retaining it and cloning the whole PDF.
      if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength &&
          Object.prototype.toString.call(value.buffer) === "[object ArrayBuffer]") {
        return value.buffer;
      }
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      );
    }
    throw new TypeError("PDF.js returned an unsupported PDF byte buffer.");
  }

  function snapshotChanges(app) {
    if (!app) {
      return {
        hadAnnotationChanges: false,
        hadStructuralChanges: false,
      };
    }
    return (
      app._captureDirtySnapshot?.() || {
        hadAnnotationChanges: !!app._annotationStorageModified,
        hadStructuralChanges:
          !!app.pdfThumbnailViewer?.hasStructuralChanges?.(),
      }
    );
  }

  function restoreChanges(app, snapshot) {
    if (typeof app._restoreDirtySnapshot === "function") {
      app._restoreDirtySnapshot(snapshot);
      syncBridgeControls();
      return;
    }
    if (snapshot.hadAnnotationChanges) {
      app._annotationStorageModified = true;
    } else {
      delete app._annotationStorageModified;
    }
    app._updateOverwriteOriginalState?.();
    app.setTitle?.();
    syncBridgeControls();
  }

  function hasUnsavedAnnotationChanges(app = state.app) {
    const snapshot = snapshotChanges(app);
    return !!(
      state.dirty ||
      state.pendingInkCommit ||
      state.freeTextInputPending ||
      snapshot.hadAnnotationChanges
    );
  }

  function isDirty(app = state.app) {
    const snapshot = snapshotChanges(app);
    return !!(
      state.dirty ||
      state.pendingInkCommit ||
      state.freeTextInputPending ||
      hasActivePointerInteraction() ||
      snapshot.hadAnnotationChanges ||
      snapshot.hadStructuralChanges
    );
  }

  function hasActivePointerInteraction() {
    return activePointerCount() > 0;
  }

  function activePointerCount() {
    return state.inputRouter?.activePointerCount || 0;
  }

  function activePointerValues() {
    return state.inputRouter?.activePointerValues() || [];
  }

  function activePointerEntries() {
    return state.inputRouter?.activePointerEntries() || [];
  }

  function activePointer(pointerId) {
    return state.inputRouter?.activePointer(pointerId) || null;
  }

  function hasActivePointer(pointerId) {
    return state.inputRouter?.hasActivePointer(pointerId) === true;
  }

  function setActivePointer(pointerId, pointer) {
    state.inputRouter?.setActivePointer(pointerId, pointer);
  }

  function deleteActivePointer(pointerId) {
    return state.inputRouter?.deleteActivePointer(pointerId) || false;
  }

  function clearActivePointers() {
    state.inputRouter?.clearActivePointers();
    state.inputPolicy?.refreshPenGestureTouchAction?.();
  }

  function manualPointerCount() {
    return state.inputRouter?.manualPointerCount || 0;
  }

  function manualPointerValues() {
    return state.inputRouter?.manualPointerValues() || [];
  }

  function getManualPointer(pointerId) {
    return state.inputRouter?.manualPointer(pointerId) || null;
  }

  function hasManualPointer(pointerId) {
    return state.inputRouter?.hasManualPointer(pointerId) === true;
  }

  function setManualPointer(pointerId, pointer) {
    state.inputRouter?.setManualPointer(pointerId, pointer);
  }

  function deleteManualPointer(pointerId) {
    return state.inputRouter?.deleteManualPointer(pointerId) || false;
  }

  function clearManualPointers() {
    state.inputRouter?.clearManualPointers();
  }

  function penPolicyPointerCount() {
    return state.inputRouter?.penPolicyPointerCount || 0;
  }

  function penPolicyPointerIds() {
    return state.inputRouter?.penPolicyPointerIds() || [];
  }

  function hasPenPolicyPointer(pointerId) {
    return state.inputRouter?.hasPenPolicyPointer(pointerId) === true;
  }

  function setPenPolicyPointer(pointerId, pointer) {
    state.inputRouter?.setPenPolicyPointer(pointerId, pointer);
  }

  function deletePenPolicyPointer(pointerId) {
    return state.inputRouter?.deletePenPolicyPointer(pointerId) || false;
  }

  function clearPenPolicyPointers() {
    state.inputRouter?.clearPenPolicyPointers();
  }

  function isInputBusy() {
    return (
      state.isComposing ||
      state.compositionEndPending ||
      hasActivePointerInteraction()
    );
  }

  function isEditBoundaryBusy() {
    return (
      isInputBusy() ||
      (state.freeTextFocused && !state.freeTextCommittedForSave)
    );
  }

  function makeSyncUuid() {
    const cryptoApi = window.crypto || globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === "function") {
      return cryptoApi.randomUUID();
    }
    const bytes = new Uint8Array(16);
    cryptoApi?.getRandomValues?.(bytes);
    if (!bytes.some((value) => value !== 0)) {
      throw new Error("Secure random UUID generation is unavailable.");
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  function normalizeSyncKind(value) {
    const numericKinds = new Map([
      [3, "FreeText"],
      [5, "Square"],
      [9, "Highlight"],
      [10, "Underline"],
      [15, "Ink"],
    ]);
    if (numericKinds.has(value)) {
      return numericKinds.get(value);
    }
    if (typeof value !== "string") {
      return "Unknown";
    }
    const lower = value.toLowerCase();
    return (
      {
        freetext: "FreeText",
        square: "Square",
        highlight: "Highlight",
        underline: "Underline",
        ink: "Ink",
        inkhighlight: "InkHighlight",
      }[lower] || value
    );
  }

  const EXTERNAL_ANNOTATION_KINDS = new Set([
    "Underline",
    "Square",
    "Highlight",
    "Ink",
    "InkHighlight",
    "FreeText",
  ]);

  function decodeExternalValue(value, seen = new Set()) {
    if (value === null || typeof value !== "object") return value;
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      return value.constructor.from
        ? value.constructor.from(value)
        : new value.constructor(value);
    }
    if (seen.has(value)) throw new Error("External annotation payload contains a cycle.");
    seen.add(value);
    let result;
    if (value.$type === "NonFiniteNumber" &&
        ["NaN", "+Infinity", "-Infinity"].includes(value.value)) {
      result = value.value === "NaN" ? Number.NaN
        : value.value === "+Infinity" ? Number.POSITIVE_INFINITY
          : Number.NEGATIVE_INFINITY;
    } else if (value.$type === "BigInt" && typeof value.value === "string" &&
        /^-?\d+$/.test(value.value) && typeof BigInt === "function") {
      result = BigInt(value.value);
    } else if (value.$type === "Float32ArrayLE" &&
        Number.isSafeInteger(value.length) && value.length >= 0 &&
        typeof value.base64 === "string") {
      const bytes = decodeBase64(value.base64);
      if (bytes.byteLength !== value.length * 4) {
        throw new Error("Invalid compact Float32Array payload length.");
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      result = new Float32Array(value.length);
      for (let index = 0; index < value.length; index += 1) {
        result[index] = view.getFloat32(index * 4, true);
      }
    } else if (value.$type === "ArrayBuffer" && Array.isArray(value.values)) {
      result = Uint8Array.from(value.values).buffer;
    } else if (typeof value.$type === "string" && Array.isArray(value.values)) {
      const constructors = {
        Int8Array,
        Uint8Array,
        Uint8ClampedArray,
        Int16Array,
        Uint16Array,
        Int32Array,
        Uint32Array,
        Float32Array,
        Float64Array,
        BigInt64Array: typeof BigInt64Array === "function" ? BigInt64Array : null,
        BigUint64Array: typeof BigUint64Array === "function" ? BigUint64Array : null,
      };
      const Constructor = constructors[value.$type];
      if (!Constructor) throw new Error(`Unsupported external annotation byte type: ${value.$type}`);
      result = Constructor.from(value.values.map((item) => decodeExternalValue(item, seen)));
    } else if (value.$type === "Map" && Array.isArray(value.entries)) {
      result = new Map(value.entries.map(([key, item]) => [
        String(key),
        decodeExternalValue(item, seen),
      ]));
    } else if (Array.isArray(value)) {
      result = value.map((item) => decodeExternalValue(item, seen));
    } else {
      result = {};
      for (const [key, item] of Object.entries(value)) {
        result[key] = decodeExternalValue(item, seen);
      }
    }
    seen.delete(value);
    return result;
  }

  function encodeExternalValue(value, seen = new Set(), compactFloat32 = false) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return { $type: "NonFiniteNumber", value: Number.isNaN(value)
          ? "NaN" : value > 0 ? "+Infinity" : "-Infinity" };
      }
      return value;
    }
    if (typeof value === "bigint") return { $type: "BigInt", value: value.toString() };
    if (typeof value === "undefined" || typeof value === "function") return undefined;
    if (value instanceof ArrayBuffer) {
      return { $type: "ArrayBuffer", values: Array.from(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      if (compactFloat32 && value instanceof Float32Array) {
        const bytes = new Uint8Array(value.length * 4);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < value.length; index += 1) {
          view.setFloat32(index * 4, value[index], true);
        }
        return {
          $type: "Float32ArrayLE",
          length: value.length,
          base64: encodeBase64(bytes),
        };
      }
      return {
        $type: value.constructor?.name || "TypedArray",
        values: Array.from(value, (item) => encodeExternalValue(item, seen, compactFloat32)),
      };
    }
    if (seen.has(value)) throw new Error("External annotation payload contains a cycle.");
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      result = value.map((item) => encodeExternalValue(item, seen, compactFloat32));
    } else if (value instanceof Map) {
      result = {
        $type: "Map",
        entries: [...value.entries()]
          .map(([key, item]) => [String(key), encodeExternalValue(item, seen, compactFloat32)])
          .sort(([left], [right]) => left.localeCompare(right)),
      };
    } else {
      result = {};
      for (const key of Object.keys(value).sort()) {
        const normalized = encodeExternalValue(value[key], seen, compactFloat32);
        if (typeof normalized !== "undefined") result[key] = normalized;
      }
    }
    seen.delete(value);
    return result;
  }

  function encodeBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  function decodeBase64(value) {
    if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error("Invalid compact Float32Array base64 payload.");
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function externalKindForEditor(value, editor = null) {
    const normalized = normalizeSyncKind(
      editor?.editorType ?? value?.annotationType ?? value?.type,
    );
    if (
      normalized === "Highlight" &&
      (Array.isArray(value?.inkLists) ||
        (value?.quadPoints == null &&
          (Array.isArray(value?.outlines?.points) ||
            Array.isArray(value?.paths?.points))))
    ) {
      return "InkHighlight";
    }
    return normalized;
  }

  function validateExternalAnnotations(value) {
    if (value == null) return { source: null, annotations: [] };
    if (!value || typeof value !== "object" || ![1, 2].includes(value.schemaVersion)) {
      throw new Error("Unsupported external annotation schema.");
    }
    const rows = Array.isArray(value.annotations) ? [...value.annotations] : [];
    if (value.schemaVersion === 2 && rows.some((row) => row?.deleted === true)) {
      throw new Error("External annotation snapshots must keep tombstones in their separate ledger.");
    }
    if (value.schemaVersion === 2) {
      if (!Array.isArray(value.tombstones)) throw new Error("External annotation tombstone ledger is invalid.");
      for (const tombstone of value.tombstones) {
        if (!tombstone || typeof tombstone !== "object" || Object.hasOwn(tombstone, "deleted")) {
          throw new Error("External annotation tombstones must not contain deleted operation rows.");
        }
        rows.push({ ...tombstone, deleted: true });
      }
    }
    if (value.legacyIdentities !== undefined && !Array.isArray(value.legacyIdentities)) {
      throw new Error("Legacy PDF annotation identities must be a list.");
    }
    const rawLegacyIdentities = Array.isArray(value.legacyIdentities) ? value.legacyIdentities : [];
    if (rawLegacyIdentities.length > 100000) {
      throw new Error("Too many legacy PDF annotation identities were supplied.");
    }
    const legacyIdentityUuids = new Set();
    const legacyIdentityRefs = new Set();
    const legacyIdentities = rawLegacyIdentities.map((row) => {
      const ref = canonicalPdfAnnotationRef(row?.ref);
      if (!row || typeof row.uuid !== "string" || !row.uuid || !ref ||
          !Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0 ||
          typeof row.kind !== "string" || !row.kind ||
          legacyIdentityUuids.has(row.uuid) || legacyIdentityRefs.has(`${row.pageIndex}\0${ref}`)) {
        throw new Error("Legacy PDF annotation identities are incomplete or ambiguous.");
      }
      legacyIdentityUuids.add(row.uuid);
      legacyIdentityRefs.add(`${row.pageIndex}\0${ref}`);
      return { uuid: row.uuid, ref, pageIndex: row.pageIndex, kind: normalizeSyncKind(row.kind) };
    });
    const deletionGuards = [];
    const guardIds = new Set();
    if (value.deletionGuards !== undefined && !Array.isArray(value.deletionGuards)) {
      throw new Error("External PDF deletion guard list is invalid.");
    }
    for (const guard of value.deletionGuards || []) {
      const version = guard?.version;
      if (!guard || typeof guard.uuid !== "string" || !guard.uuid || guardIds.has(guard.uuid) ||
          !Number.isSafeInteger(guard.pageIndex) || guard.pageIndex < 0 ||
          !version || !Number.isSafeInteger(version.rev) || version.rev < 0 ||
          !Number.isSafeInteger(version.seq) || version.seq < 0 ||
          typeof version.deviceId !== "string" || !version.deviceId ||
          (guard.embeddedRef != null && !canonicalPdfAnnotationRef(guard.embeddedRef))) {
        throw new Error("External PDF deletion guard is invalid.");
      }
      guardIds.add(guard.uuid);
      deletionGuards.push({ uuid: guard.uuid, version: { ...version }, pageIndex: guard.pageIndex,
        embeddedRef: guard.embeddedRef == null ? null : canonicalPdfAnnotationRef(guard.embeddedRef) });
    }
    const seen = new Set();
    const annotations = [];
    for (const row of rows) {
      if (
        !row || typeof row !== "object" ||
        typeof row.uuid !== "string" || !row.uuid || seen.has(row.uuid) || guardIds.has(row.uuid) ||
        !EXTERNAL_ANNOTATION_KINDS.has(normalizeSyncKind(row.kind)) ||
        !Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0 ||
        !row.clock || !Number.isSafeInteger(row.clock.timestamp) ||
        !Number.isSafeInteger(row.clock.logical) ||
        typeof row.clock.deviceId !== "string" ||
        typeof row.clock.opId !== "string"
      ) {
        throw new Error("External annotation record is incomplete or ambiguous.");
      }
      const embeddedRef = row.embeddedRef == null
        ? null
        : canonicalPdfAnnotationRef(row.embeddedRef);
      if (row.embeddedRef != null && !embeddedRef) {
        throw new Error(`External annotation ${row.uuid} has an invalid embedded reference.`);
      }
      const kind = normalizeSyncKind(row.kind);
      const deleted = row.deleted === true;
      let editor = null;
      if (!deleted) {
        if (!row.payload || typeof row.payload.editor !== "object") {
          throw new Error(`External annotation ${row.uuid} has no editor payload.`);
        }
        editor = decodeExternalValue(row.payload.editor);
        if (
          !editor || typeof editor !== "object" ||
          !Number.isSafeInteger(editor.pageIndex) ||
          editor.pageIndex !== row.pageIndex
        ) {
          throw new Error(`External annotation ${row.uuid} has an invalid editor payload.`);
        }
        const actualKind = externalKindForEditor(editor);
        if (actualKind !== kind) {
          throw new Error(`External annotation ${row.uuid} type does not match its editor payload.`);
        }
      }
      if (row.clock.timestamp < 0 || row.clock.logical < 0) {
        throw new Error(`External annotation ${row.uuid} has an invalid logical clock.`);
      }
      seen.add(row.uuid);
      annotations.push({
        uuid: row.uuid,
        kind,
        pageIndex: row.pageIndex,
        embeddedRef,
        deleted,
        ...(row.provenance === "embedded" || row.provenance === "external" ? { provenance: row.provenance } : {}),
        authoritative: value.storageProtocol === "wal-sidecar-v3.1",
        clock: {
          timestamp: row.clock.timestamp,
          logical: row.clock.logical,
          deviceId: row.clock.deviceId,
          opId: row.clock.opId,
        },
        editor,
      });
    }
    return {
      source: value.source && typeof value.source === "object"
        ? normalizeSyncValue(value.source)
        : null,
      legacyIdentities,
      annotations,
      compactInkEncoding: value.compactInkEncoding === true,
      deletionGuards,
    };
  }

  function compareDeletionGuardVersion(guard, row) {
    const right = row.version || { rev: row.clock.timestamp, deviceId: row.clock.deviceId, seq: row.clock.logical };
    const left = guard.version;
    return left.rev - right.rev || (left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0) || left.seq - right.seq;
  }

  function externalAnnotationMaskRows() {
    return [...state.externalAnnotationRows.values(), ...(state.externalDeletionGuards?.values() || [])].map(row =>
      row.version && !row.clock ? { ...row, deleted: true } : row);
  }

  function applyLegacyAnnotationIdentities(identities = []) {
    if (!Array.isArray(identities)) return;
    for (const identity of identities) {
      if (!identity || !Number.isSafeInteger(identity.pageIndex) ||
          identity.pageIndex < 0 || identity.pageIndex >= (state.app?.pdfDocument?.numPages || 0)) continue;
      const ref = canonicalPdfAnnotationRef(identity.ref);
      if (!ref || typeof identity.uuid !== "string" || !identity.uuid) continue;
      const key = pdfAnnotationRefKey(ref);
      const prior = state.annotationUuidByPdfRef.get(key);
      if (prior && prior !== identity.uuid) {
        throw new Error(`Legacy annotation reference ${ref} maps to more than one UUID.`);
      }
      const kind = normalizeSyncKind(identity.kind);
      const cached = state.syncState?.identities || [];
      const priorIdentity = cached.find((row) => row.uuid === identity.uuid ||
        pdfAnnotationRefKey(row.ref) === key);
      if (priorIdentity && (priorIdentity.uuid !== identity.uuid ||
          pdfAnnotationRefKey(priorIdentity.ref) !== key ||
          priorIdentity.pageIndex !== identity.pageIndex ||
          normalizeSyncKind(priorIdentity.kind) !== kind)) {
        throw new Error(`Legacy annotation reference ${ref} has conflicting page/type identity.`);
      }
      // The sidecar handshake replaces the old binary syncState handshake.
      // Keep its verified identity metadata in the existing runtime cache too:
      // unchanged native editors serialize to null after Undo, and history
      // reconciliation must still recover their exact UUID/ref/page/type.
      if (!priorIdentity) {
        state.syncState ||= { version: 1, actorId: state.syncActorId || null, identities: [], ledger: null };
        state.syncState.identities.push({ uuid: identity.uuid, ref,
          pageIndex: identity.pageIndex, kind });
      }
      state.annotationUuidByPdfRef.set(key, identity.uuid);
    }
  }

  function normalizeSyncValue(value, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : String(value);
    }
    if (typeof value === "undefined" || typeof value === "function") {
      return undefined;
    }
    if (value instanceof ArrayBuffer) {
      return { $type: "ArrayBuffer", values: Array.from(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        $type: value.constructor?.name || "TypedArray",
        values: Array.from(value),
      };
    }
    if (seen.has(value)) {
      throw new Error("PDF.js annotation data contains a cycle and cannot be saved losslessly.");
    }
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.map((item) => normalizeSyncValue(item, seen));
      seen.delete(value);
      return result;
    }
    if (value instanceof Map) {
      const result = [...value.entries()]
        .map(([key, item]) => [String(key), normalizeSyncValue(item, seen)])
        .sort(([left], [right]) => left.localeCompare(right));
      seen.delete(value);
      return { $type: "Map", entries: result };
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = normalizeSyncValue(value[key], seen);
      if (typeof normalized !== "undefined") {
        result[key] = normalized;
      }
    }
    seen.delete(value);
    return result;
  }

  function canonicalPdfAnnotationRef(value) {
    if (typeof value !== "string") {
      return null;
    }
    const pdfJsMatch = /^(\d+)R(\d+)?$/.exec(value);
    if (pdfJsMatch) {
      return `${pdfJsMatch[1]}R${pdfJsMatch[2] === "0" ? "" : pdfJsMatch[2] || ""}`;
    }
    const pdfLibMatch = /^(\d+)\s+(\d+)\s+R$/.exec(value);
    if (pdfLibMatch) {
      return `${pdfLibMatch[1]}R${pdfLibMatch[2] === "0" ? "" : pdfLibMatch[2]}`;
    }
    return null;
  }

  function pdfAnnotationRefKey(value) {
    const canonical = canonicalPdfAnnotationRef(value);
    if (!canonical) {
      return null;
    }
    const match = /^(\d+)R(\d+)?$/.exec(canonical);
    return `${match[1]}:${match[2] || "0"}`;
  }

  function getPdfAnnotationRef(value) {
    for (const candidate of [
      value?.annotationElementId,
      value?.annotationId,
      value?.ref,
      value?.id,
    ]) {
      const canonical = canonicalPdfAnnotationRef(candidate);
      if (canonical) {
        return canonical;
      }
    }
    return null;
  }

  function hasNonDegeneratePdfRect(rect) {
    return Boolean(
      (Array.isArray(rect) || ArrayBuffer.isView(rect)) &&
      rect.length === 4 &&
      [...rect].every(Number.isFinite) &&
      Math.abs(rect[2] - rect[0]) > 0 &&
      Math.abs(rect[3] - rect[1]) > 0
    );
  }

  function getAnnotationStorageRows(app = state.app, { includeLiveEditors = false } = {}) {
    const storageMap = app?.pdfDocument?.annotationStorage?.serializable?.map;
    const rows = new Map();
    let storageRowCount = 0;
    let liveEditorCount = 0;
    let liveEditorSerializationErrorCount = 0;
    let liveEditorEnumerationErrorCount = 0;
    const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    const addRow = (rawRuntimeId, rawValue, editor = null) => {
      if (rawValue === null || typeof rawValue !== "object") {
        return;
      }
      const runtimeId = String(rawRuntimeId);
      let value = normalizeSyncValue(rawValue);
      editor ||= manager?.getEditor?.(runtimeId) || null;
      if (!editor) {
        const retained = app?.pdfDocument?.annotationStorage?.getRawValue?.(runtimeId);
        if (typeof retained?.serialize === "function") editor = retained;
      }
      if (
        normalizeSyncKind(editor?.editorType) === "FreeText" &&
        !hasNonDegeneratePdfRect(value?.rect)
      ) {
        // PDF.js can publish a FreeText storage row before its first layout
        // pass. Fill only the missing geometry from the live editor; retain
        // AnnotationStorage as the source of all other serialized fields.
        try {
          const liveValue = editor.serialize?.(true);
          if (hasNonDegeneratePdfRect(liveValue?.rect)) {
            value = { ...value, rect: Array.from(liveValue.rect) };
          }
        } catch {
          // Serialization fails closed later rather than persisting a zero rect.
        }
      }
      const annotationElementId = getPdfAnnotationRef(value);
      const reference = annotationElementId ||
        state.annotationRefByRuntimeId.get(runtimeId) || null;
      const referenceKey = pdfAnnotationRefKey(reference);
      const runtimeUuid = state.annotationUuidByRuntimeId.get(runtimeId);
      const runtimeBinding = state.annotationRuntimeBindings?.get(runtimeId);
      const priorRow = state.annotationSnapshot?.get(runtimeId);
      const boundRow = state.externalAnnotationRows?.get(runtimeUuid ||
        (referenceKey && state.annotationUuidByPdfRef.get(referenceKey)));
      const identity = state.syncState?.identities?.find(
        (candidate) => candidate?.uuid === runtimeUuid ||
          (referenceKey && pdfAnnotationRefKey(candidate?.ref) === referenceKey),
      );
      const canonicalReference = canonicalPdfAnnotationRef(identity?.ref) ||
        canonicalPdfAnnotationRef(reference) || null;
      const pageIndex = Number.isSafeInteger(value?.pageIndex)
        ? value.pageIndex
        : Number.isSafeInteger(editor?.pageIndex)
          ? editor.pageIndex
          : Number.isSafeInteger(value?.pageNumber) && value.pageNumber > 0
            ? value.pageNumber - 1
            : Number.isSafeInteger(identity?.pageIndex)
              ? identity.pageIndex
              : Number.isSafeInteger(priorRow?.pageIndex)
                ? priorRow.pageIndex
                : Number.isSafeInteger(boundRow?.pageIndex) ? boundRow.pageIndex
                  : Number.isSafeInteger(runtimeBinding?.pageIndex) ? runtimeBinding.pageIndex : null;
      let uuid = runtimeUuid || (referenceKey && state.annotationUuidByPdfRef.get(referenceKey)) ||
        identity?.uuid || priorRow?.uuid || null;
      let exactRow = uuid ? state.externalAnnotationRows?.get(uuid) || priorRow : null;
      if (value.deleted === true && !uuid && referenceKey) {
        const matches = [
          ...state.externalAnnotationRows?.values?.() || [],
          ...state.embeddedDeletionTargets?.values?.() || [],
        ].filter(row => row?.uuid && row.pageIndex === pageIndex &&
          pdfAnnotationRefKey(row.embeddedRef || row.ref || row.reference) === referenceKey);
        const uuids = new Set(matches.map(row => row.uuid));
        if (uuids.size === 1) {
          exactRow = matches[0];
          uuid = exactRow.uuid;
        }
      }
      let kind = externalKindForEditor(value, editor);
      if (!EXTERNAL_ANNOTATION_KINDS.has(kind)) {
        kind = [identity?.kind, exactRow?.kind, priorRow?.kind, runtimeBinding?.kind]
          .map(normalizeSyncKind).find(candidate => EXTERNAL_ANNOTATION_KINDS.has(candidate)) || kind;
      }
      if (value?.deleted !== true && normalizeSyncKind(kind) === "Highlight") {
        const targetText = state.annotationTargetTextByRuntimeId?.get(runtimeId) ||
          value?.text ||
          exactRow?.editor?.text || exactRow?.editorPayload?.text || priorRow?.value?.text;
        if (typeof targetText === "string" && targetText.trim()) {
          // PDF.js captures Selection.toString() for a Highlight, but its
          // serialize() omits that private text. Keep it in the existing
          // external annotation payload without mutating AnnotationStorage or
          // the PDF.js editor, so the operation signature and durable sidecar
          // capture include the quote immediately after the committed edit.
          value = { ...value, text: targetText };
        }
      }
      if (value.deleted === true && (!uuid || !EXTERNAL_ANNOTATION_KINDS.has(kind) ||
          !Number.isSafeInteger(pageIndex) ||
          (Number.isSafeInteger(exactRow?.pageIndex) && exactRow.pageIndex !== pageIndex))) {
        // Deletion cannot create an annotation identity. Do not skip the row
        // or acknowledge a save: preserve state and require exact resolution.
        const error = new Error(`Deletion placeholder ${runtimeId} has no verified annotation UUID/type binding.`);
        error.code = "annotation-deletion-identity-unresolved";
        throw error;
      }
      if (!uuid) uuid = makeSyncUuid();
      state.annotationUuidByRuntimeId.set(runtimeId, uuid);
      if (EXTERNAL_ANNOTATION_KINDS.has(kind) && Number.isSafeInteger(pageIndex)) {
        state.annotationRuntimeBindings?.set(runtimeId, { uuid, kind, pageIndex });
      }
      if (canonicalReference) {
        state.annotationRefByRuntimeId.set(runtimeId, canonicalReference);
        state.annotationUuidByPdfRef.set(
          pdfAnnotationRefKey(canonicalReference),
          uuid,
        );
      }
      rows.set(runtimeId, {
        runtimeId,
        uuid,
        reference: canonicalReference,
        operationReference: canonicalPdfAnnotationRef(annotationElementId),
        annotationElementId,
        pageIndex,
        kind,
        deleted: value?.deleted === true,
        value,
        signature: JSON.stringify(value),
      });
    };
    if (storageMap instanceof Map) {
      for (const [rawRuntimeId, rawValue] of storageMap) {
        addRow(rawRuntimeId, rawValue);
        storageRowCount += 1;
      }
    }
    // Some PDF.js editor commands mark the document dirty before the editor's
    // final serialization has been published to AnnotationStorage. At a save,
    // recovery, or sync checkpoint boundary, serialize the committed live
    // editors as a second source of truth and let those values supersede a
    // stale storage row. Never use this while a Pencil/Ink gesture is active.
    if (includeLiveEditors && manager?.getEditors && app?.pdfDocument) {
      const pageCount = Number.isSafeInteger(app.pdfDocument.numPages)
        ? app.pdfDocument.numPages
        : 0;
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        let editors;
        try {
          editors = manager.getEditors(pageIndex);
          for (const editor of editors || []) {
            let serialized;
            try {
              serialized = editor?.serialize?.(false);
            } catch (error) {
              liveEditorSerializationErrorCount += 1;
              runtimeLogRecord("annotation-operation.live-editor-serialize-error", {
                pageIndex,
                editorType: String(editor?.editorType || "unknown").slice(0, 64),
                error: runtimeLogError(error),
              });
              continue;
            }
            if (!serialized || typeof serialized !== "object") continue;
            liveEditorCount += 1;
            addRow(editor.id, serialized, editor);
          }
        } catch (error) {
          liveEditorEnumerationErrorCount += 1;
          runtimeLogRecord("annotation-operation.live-editor-enumeration-error", {
            pageIndex,
            error: runtimeLogError(error),
          });
        }
      }
    }
    Object.defineProperties(rows, {
      storageRowCount: { value: storageRowCount },
      liveEditorCount: { value: liveEditorCount },
      liveEditorSerializationErrorCount: { value: liveEditorSerializationErrorCount },
      liveEditorEnumerationErrorCount: { value: liveEditorEnumerationErrorCount },
    });
    return rows;
  }

  function seedSyncClock(syncState) {
    const clockRows = [
      ...(Array.isArray(syncState?.ledger?.entries)
        ? syncState.ledger.entries
        : []),
      ...(Array.isArray(syncState?.ledger?.annotations)
        ? syncState.ledger.annotations
        : []),
      ...(Array.isArray(syncState?.identities) ? syncState.identities : []),
    ];
    for (const row of clockRows) {
      if (!Number.isSafeInteger(row?.timestamp) || row.timestamp < 0) {
        continue;
      }
      const logical = Number.isSafeInteger(row.logical) && row.logical >= 0
        ? row.logical
        : 0;
      const currentTime = state.syncClockTimestamp;
      const rowTime = row.timestamp;
      if (
        rowTime > currentTime ||
        (rowTime === currentTime && logical > state.syncClockLogical)
      ) {
        state.syncClockTimestamp = rowTime;
        state.syncClockLogical = logical;
      }
    }
    const ledgerClockTimestamp = syncState?.ledger?.clock?.timestamp;
    const ledgerClockLogical = syncState?.ledger?.clock?.logical;
    if (
      Number.isSafeInteger(ledgerClockTimestamp) &&
      ledgerClockTimestamp >= 0 &&
      (ledgerClockTimestamp > state.syncClockTimestamp ||
        (ledgerClockTimestamp === state.syncClockTimestamp &&
          Number.isSafeInteger(ledgerClockLogical) &&
          ledgerClockLogical > state.syncClockLogical))
    ) {
      state.syncClockTimestamp = ledgerClockTimestamp;
      state.syncClockLogical = Number.isSafeInteger(ledgerClockLogical) &&
          ledgerClockLogical >= 0
        ? ledgerClockLogical
        : 0;
    }
  }

  function normalizeSyncState(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const actorId = typeof value.actorId === "string" && value.actorId.length > 0
      ? value.actorId
      : null;
    const identities = Array.isArray(value.identities)
      ? value.identities.filter(
          (row) => row && typeof row === "object" &&
            typeof row.uuid === "string" && row.uuid.length > 0,
        )
      : [];
    return {
      version: Number.isSafeInteger(value.version) ? value.version : 1,
      ...(actorId ? { actorId } : {}),
      identities,
      ledger: value.ledger && typeof value.ledger === "object"
        ? value.ledger
        : null,
    };
  }

  function remapSessionIdentities(syncState) {
    if (!Array.isArray(syncState?.identities)) return;
    const canonicalByRef = new Map();
    for (const identity of syncState.identities) {
      const refKey = pdfAnnotationRefKey(identity?.ref);
      if (refKey && typeof identity?.uuid === "string") canonicalByRef.set(refKey, identity.uuid);
    }
    if (!canonicalByRef.size) return;
    const remapUuid = (uuid, reference) => canonicalByRef.get(pdfAnnotationRefKey(reference)) || uuid;
    const oldToCanonical = new Map();
    for (const [runtimeId, uuid] of state.annotationUuidByRuntimeId) {
      // Stable UUIDs already identify a specific annotation operation. A PDF
      // writer may reuse an old object reference after a deletion, so resolving
      // every UUID through the latest ref table can attach that operation to a
      // different annotation. Only legacy fast-open session IDs need remapping.
      if (!String(uuid || "").startsWith("session-")) continue;
      const reference = state.annotationRefByRuntimeId.get(runtimeId);
      const canonical = remapUuid(uuid, reference);
      if (canonical !== uuid) {
        oldToCanonical.set(uuid, canonical);
        state.annotationUuidByRuntimeId.set(runtimeId, canonical);
      }
    }
    for (const [referenceKey, uuid] of state.annotationUuidByPdfRef) {
      const canonical = canonicalByRef.get(referenceKey);
      if (canonical) state.annotationUuidByPdfRef.set(referenceKey, canonical);
    }
    const remappedOperations = new Map();
    for (const entry of state.annotationOperations) {
      const operation = { ...entry.operation };
      if (String(operation.uuid || "").startsWith("session-")) {
        operation.uuid = remapUuid(operation.uuid, operation.ref);
      }
      if (operation.uuid !== entry.operation.uuid) oldToCanonical.set(entry.operation.uuid, operation.uuid);
      const previous = remappedOperations.get(operation.uuid);
      if (!previous || entry.revision > previous.revision ||
          (entry.revision === previous.revision && compareSyncStamps(operation, previous.operation) > 0)) {
        remappedOperations.set(operation.uuid, { ...entry, operation });
      }
    }
    state.annotationOperations = [...remappedOperations.values()];
    const remapRevisionMap = (source) => {
      const next = new Map();
      for (const [uuid, revision] of source) {
        const canonical = oldToCanonical.get(uuid) || uuid;
        next.set(canonical, Math.max(next.get(canonical) ?? -1, revision));
      }
      return next;
    };
    state.dirtyAnnotationRevisions = remapRevisionMap(state.dirtyAnnotationRevisions);
    const remapSet = (source) => new Set([...source].map((uuid) => oldToCanonical.get(uuid) || uuid));
    state.dirtyNewAnnotationIds = remapSet(state.dirtyNewAnnotationIds);
    state.dirtyDeletedAnnotationIds = remapSet(state.dirtyDeletedAnnotationIds);
  }

  function compareSyncStamps(left, right) {
    for (const key of ["timestamp", "logical"]) {
      const a = Number(left?.[key] || 0), b = Number(right?.[key] || 0);
      if (a !== b) return a < b ? -1 : 1;
    }
    for (const key of ["actorId", "operationId"]) {
      const a = String(left?.[key] || ""), b = String(right?.[key] || "");
      if (a !== b) return a < b ? -1 : 1;
    }
    return 0;
  }

  function applySyncIdentities(value, { reset = false } = {}) {
    const normalizedSyncState = normalizeSyncState(value);
    const syncState = reset && normalizedSyncState
      ? {
          ...normalizedSyncState,
          // Runtime editor IDs are local to the document that produced the
          // checkpoint. Remove them from adopted state too, so a later
          // same-document ACK cannot re-seed those stale IDs by merging.
          identities: normalizedSyncState.identities.map((identity) => {
            const { runtimeId: _runtimeId, ...stableIdentity } = identity;
            return stableIdentity;
          }),
        }
      : normalizedSyncState;
    if (reset) {
      state.annotationUuidByRuntimeId.clear();
      state.annotationProvenanceByUuid.clear();
      state.annotationTargetTextByRuntimeId.clear();
      state.pendingHighlightSelection = null;
      state.annotationRefByRuntimeId.clear();
      state.annotationUuidByPdfRef.clear();
      state.annotationRuntimeBindings?.clear();
      state.annotationTrackingFailure = null;
      state.annotationOperations = [];
      state.dirtyAnnotationRevisions.clear();
      state.dirtyPageRevisions.clear();
      state.dirtyNewAnnotationIds.clear();
      state.dirtyDeletedAnnotationIds.clear();
      state.pendingBulkDeletedUuids.clear();
      state.annotationSnapshot = new Map();
      state.restoredSavedAnnotations.clear();
      state.syncOperationSequence = 0;
      state.syncClockTimestamp = 0;
      state.syncClockLogical = 0;
      state.syncState = null;
    }
    if (!reset) remapSessionIdentities(syncState);
    if (!syncState) {
      if (reset) {
        state.syncActorId = makeSyncUuid();
        state.syncState = {
          version: 1,
          actorId: state.syncActorId,
          identities: [],
          ledger: null,
        };
        seedSyncClock(state.syncState);
      }
      return;
    }
    const mergedIdentityByUuid = new Map(
      (!reset && Array.isArray(state.syncState?.identities)
        ? state.syncState.identities
        : []).map((identity) => [identity.uuid, identity]),
    );
    for (const identity of syncState.identities) {
      mergedIdentityByUuid.set(identity.uuid, {
        ...mergedIdentityByUuid.get(identity.uuid),
        ...identity,
      });
    }
    const mergedSyncState = {
      ...(!reset && state.syncState ? state.syncState : {}),
      ...syncState,
      identities: [...mergedIdentityByUuid.values()],
      ledger: syncState.ledger || (!reset ? state.syncState?.ledger : null) || null,
    };
    for (const identity of mergedSyncState.identities) {
      const uuid = identity.uuid;
      // A sync apply opens a new PDF.js document, whose editor IDs are newly
      // allocated. Runtime IDs in the host identity list belong to the writer
      // document that produced the checkpoint, so only reuse them when
      // adopting same-document state; the new document will rebuild them from
      // exact annotation refs below.
      if (!reset && typeof identity.runtimeId === "string" && identity.runtimeId) {
        state.annotationUuidByRuntimeId.set(identity.runtimeId, uuid);
        const reference = canonicalPdfAnnotationRef(identity.ref);
        if (reference) {
          state.annotationRefByRuntimeId.set(identity.runtimeId, reference);
        }
      }
      const reference = canonicalPdfAnnotationRef(identity.ref);
      if (reference) {
        state.annotationUuidByPdfRef.set(pdfAnnotationRefKey(reference), uuid);
      }
    }
    const referenceByUuid = new Map(
      mergedSyncState.identities
        .filter((identity) => typeof identity.uuid === "string")
        .map((identity) => [
          identity.uuid,
          canonicalPdfAnnotationRef(identity.ref),
        ])
        .filter(([, reference]) => reference),
    );
    state.syncActorId = mergedSyncState.actorId || state.syncActorId || makeSyncUuid();
    state.syncState = {
      ...mergedSyncState,
      actorId: state.syncActorId,
    };
    seedSyncClock(state.syncState);
    const currentRows = getAnnotationStorageRows();
    state.annotationSnapshot = currentRows;
    const currentRowsByUuid = new Map(
      [...currentRows.values()].map((row) => [row.uuid, row]),
    );
    for (const entry of state.annotationOperations) {
      const operation = entry.operation;
      const currentRow = currentRowsByUuid.get(operation.uuid);
      if (currentRow && !currentRow.deleted) {
        // PDF.js still serializes this editor from the original loaded base.
        // Keep a live id:null editor as a new annotation on every save.
        operation.ref = currentRow.operationReference || null;
        continue;
      }
      const reference = currentRow?.reference ||
        referenceByUuid.get(operation.uuid);
      if (reference) {
        operation.ref = reference;
      }
    }
  }

  function makeSyncStamp() {
    const actorId = state.syncActorId || (state.syncActorId = makeSyncUuid());
    const deviceId = state.syncDeviceId || actorId;
    const now = Date.now();
    const prior = state.syncClockTimestamp;
    if (now > prior) {
      state.syncClockTimestamp = now;
      state.syncClockLogical = 0;
    } else {
      state.syncClockLogical += 1;
    }
    state.syncOperationSequence += 1;
    return {
      timestamp: state.syncClockTimestamp,
      logical: state.syncClockLogical,
      actorId,
      deviceId,
      operationId: `${actorId}:${state.syncClockTimestamp}:${state.syncClockLogical}:${state.syncOperationSequence}`,
    };
  }

  function externalOperation(operation) {
    if (!operation || typeof operation.uuid !== "string") return null;
    const deleted = operation.deleted === true || operation.action === "delete";
    const serialized = operation.payload?.editor ?? operation.serialized;
    let editor = null;
    if (!deleted) {
      if (!serialized || typeof serialized !== "object") {
        throw new Error(`Annotation ${operation.uuid} has no lossless editor snapshot.`);
      }
      editor = encodeExternalValue(serialized, new Set(), state.compactInkEncoding === true);
    }
    const timestamp = Number.isSafeInteger(operation.timestamp)
      ? operation.timestamp
      : Number.isSafeInteger(operation.clock?.timestamp)
        ? operation.clock.timestamp
        : 0;
    const logical = Number.isSafeInteger(operation.logical)
      ? operation.logical
      : Number.isSafeInteger(operation.clock?.logical)
        ? operation.clock.logical
        : 0;
    const deviceId = String(
      operation.deviceId || operation.clock?.deviceId || operation.actorId || state.syncDeviceId || state.syncActorId || "",
    );
    const opId = String(
      operation.operationId || operation.clock?.opId || "",
    );
    if (!deviceId || !opId || !Number.isSafeInteger(operation.pageIndex) || operation.pageIndex < 0) {
      throw new Error(`Annotation ${operation.uuid} is missing stable operation identity.`);
    }
    const kind = normalizeSyncKind(operation.kind);
    if (!EXTERNAL_ANNOTATION_KINDS.has(kind)) {
      throw new Error(`Annotation ${operation.uuid} has unsupported type ${kind}.`);
    }
    if (!deleted && kind === "FreeText" && !hasNonDegeneratePdfRect(serialized.rect)) {
      throw new Error(`FreeText annotation ${operation.uuid} has no measurable editor rectangle.`);
    }
    return {
      uuid: operation.uuid,
      kind,
      pageIndex: operation.pageIndex,
      deleted,
      ...(operation.provenance === "embedded" || operation.provenance === "external" ? { provenance: operation.provenance } : {}),
      embeddedRef: canonicalPdfAnnotationRef(operation.embeddedRef || operation.ref),
      clock: { timestamp, logical, deviceId, opId },
      ...(!deleted ? { payload: { editor } } : {}),
    };
  }

  function captureSyncOperations(revision = state.revision) {
    const dirtyIds = new Set(captureDirtySyncState(revision).dirtyAnnotationIds);
    return state.annotationOperations
      .filter(({ revision: changedAt, operation }) =>
        changedAt <= revision && dirtyIds.has(operation.uuid),
      )
      .map(({ operation }) => externalOperation(operation))
      .filter(Boolean);
  }

  function recoverySourceIdentity() {
    const source = state.externalSource;
    if (
      !source || typeof source.sourceHash !== "string" ||
      !Number.isSafeInteger(source.pageCount) || source.pageCount < 0 ||
      !Array.isArray(source.orderedPageIdentities) ||
      source.orderedPageIdentities.length !== source.pageCount ||
      source.orderedPageIdentities.some((identity) => typeof identity !== "string")
    ) {
      throw new Error("Cannot quarantine recovery operations without the loaded PDF source identity.");
    }
    return {
      sourceHash: source.sourceHash,
      pageCount: source.pageCount,
      orderedPageIdentities: [...source.orderedPageIdentities],
    };
  }

  function getAnnotationEditorManager(app = state.app) {
    return app?.pdfViewer?._layerProperties?.annotationEditorUIManager || null;
  }

  function getAnnotationEditorLayer(app, pageIndex) {
    const pageView = app?.pdfViewer?.getPageView?.(pageIndex);
    return pageView?.annotationEditorLayer?.annotationEditorLayer || null;
  }

  function canonicalPdfPageRef(reference) {
    if (reference && Number.isSafeInteger(reference.num)) {
      const generation = Number.isSafeInteger(reference.gen) ? reference.gen : 0;
      return `${reference.num}R${generation || ""}`;
    }
    if (typeof reference?.toString === "function") {
      return canonicalPdfAnnotationRef(reference.toString());
    }
    return canonicalPdfAnnotationRef(reference);
  }

  async function reportAnnotationSourceIdentity(pdfDocument, externalAnnotations) {
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    const pageCount = Number.isSafeInteger(pdfDocument?.numPages)
      ? pdfDocument.numPages
      : 0;
    const identities = Array(pageCount).fill(null);
    const pageRefs = Array(pageCount).fill(null);
    // getPage resolves page-tree references only. It does not request page
    // content streams, render pages, or compute content fingerprints.
    for (let start = 0; start < pageCount; start += 8) {
      const end = Math.min(pageCount, start + 8);
      const batch = await Promise.all(Array.from({ length: end - start }, async (_, offset) => {
        const pageIndex = start + offset;
        try {
          const page = await pdfDocument.getPage(pageIndex + 1);
          return [pageIndex, canonicalPdfPageRef(page?.ref)];
        } catch {
          return [pageIndex, null];
        }
      }));
      for (const [pageIndex, reference] of batch) pageRefs[pageIndex] = reference;
    }
    const counts = new Map();
    for (const reference of pageRefs) {
      if (reference) counts.set(reference, (counts.get(reference) || 0) + 1);
    }
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      const reference = pageRefs[pageIndex];
      if (reference && counts.get(reference) === 1) {
        identities[pageIndex] = `ref:${reference}`;
      }
    }
    const identityStatus = identities.every((identity) => typeof identity === "string")
      ? "KNOWN"
      : "UNKNOWN";
    const source = externalAnnotations?.source;
    let pairId = null;
    if (externalAnnotations?.requiresPairValidation === true) {
      const metadata = await pdfDocument.getMetadata();
      const candidate = metadata?.info?.Custom?.ObReaderPairId;
      pairId = typeof candidate === "string" && /^[a-f0-9]{32}$/.test(candidate) ? candidate : null;
    }
    const actualIdentity = {
      pageCount,
      orderedPageIdentities: identities,
      identityStatus,
      sourceHash: typeof source?.sourceHash === "string" ? source.sourceHash : null,
    };
    if (
      !documentId || state.activeDocumentId !== documentId ||
      state.activeOpenRequest !== openRequest ||
      state.app?.pdfDocument !== pdfDocument
    ) return null;
    state.actualSourceIdentity = actualIdentity;
    postToHost("annotation-source-identity", {
      documentId,
      openRequest,
      sourceHash: actualIdentity.sourceHash,
      ...(externalAnnotations?.requiresPairValidation === true ? { pairId } : {}),
      pageCount,
      orderedPageIdentities: identities,
      identityStatus,
    });
    if (identityStatus === "KNOWN") requestReaderBacklinksForPage();
    return actualIdentity;
  }

  async function hydrateRenderedExternalPages(app = state.app) {
    const pageViews = app?.pdfViewer?._pages;
    if (!Array.isArray(pageViews) || (!state.externalAnnotationRows.size && !state.externalDeletionGuards?.size)) return;
    for (const pageView of pageViews) {
      const layer = pageView?.annotationEditorLayer?.annotationEditorLayer;
      if (!layer || !Number.isSafeInteger(layer.pageIndex)) continue;
      const hydrated = await hydrateExternalAnnotationsForPage(layer.pageIndex);
      if (!hydrated) scheduleExternalAnnotationHydrationRetry(layer.pageIndex);
    }
  }

  function scheduleExternalAnnotationHydrationRetry(pageIndex, attempt = 0) {
    if (attempt >= 6 || state.disposed) return;
    setDeferredTimeout(() => {
      void hydrateExternalAnnotationsForPage(pageIndex).then((hydrated) => {
        if (!hydrated) scheduleExternalAnnotationHydrationRetry(pageIndex, attempt + 1);
      }).catch((error) => {
        runtimeLogRecord("external-annotation.hydrate-retry-error", {
          pageIndex,
          attempt,
          error: runtimeLogError(error),
        });
      });
    }, 50 * (attempt + 1));
  }

  function sameAnnotationPayload(left, right) {
    const comparable = (value) => {
      if (!value || typeof value !== "object") return value;
      const copy = { ...value };
      delete copy.id;
      delete copy.annotationElementId;
      delete copy.deleted;
      delete copy.popupRef;
      return JSON.stringify(copy);
    };
    return comparable(left) === comparable(right);
  }

  function suppressEmbeddedAnnotation(pageIndex, reference) {
    const pageView = state.app?.pdfViewer?.getPageView?.(pageIndex);
    const layer = pageView?.div;
    if (!layer || !reference) return false;
    const canonical = canonicalPdfAnnotationRef(reference);
    const owners = externalAnnotationMaskRows().filter(row => row.pageIndex === pageIndex &&
      canonicalPdfAnnotationRef(row.embeddedRef) === canonical);
    if (!owners.some(row => row.deleted === true && row.provenance === "embedded")) return false;
    const element = [...layer.querySelectorAll("[data-annotation-id]")].find((candidate) => {
      const value = candidate.getAttribute("data-annotation-id");
      return canonicalPdfAnnotationRef(value) === canonical || value === reference;
    });
    if (!element) return false;
    if (!element.hasAttribute("data-pdf-reader-external-hidden")) {
      element.setAttribute("data-pdf-reader-external-hidden", "1");
      element.dataset.pdfReaderPreviousDisplay = element.style.display;
      element.dataset.pdfReaderPreviousAriaHidden = element.getAttribute("aria-hidden") ?? "__absent__";
    }
    element.style.display = "none";
    element.setAttribute("aria-hidden", "true");
    return true;
  }

  function setNativeAnnotationLayersPending(pending, token = null) {
    if (pending) {
      state.nativeAnnotationLayersPending = true;
      state.nativeAnnotationGateToken = token;
      document.documentElement?.classList?.add("pdfReaderNativeAnnotationLayersPending");
      return true;
    }
    if (token && state.nativeAnnotationGateToken !== token) return false;
    state.nativeAnnotationLayersPending = false;
    state.nativeAnnotationGateToken = null;
    document.documentElement?.classList?.remove("pdfReaderNativeAnnotationLayersPending");
    return true;
  }

  function stopExternalAnnotationLayerObserver() {
    state.externalAnnotationLayerObserver?.disconnect?.();
    state.externalAnnotationLayerObserver = null;
  }

  function observeExternalAnnotationLayerMutations() {
    stopExternalAnnotationLayerObserver();
    const rows = externalAnnotationMaskRows()
      .filter((row) => row.embeddedRef);
    if (!rows.length || typeof MutationObserver !== "function") return false;
    const pageIndices = new Set(rows.map((row) => row.pageIndex));
    const viewer = state.app?.pdfViewer;
    const pageTargets = [...pageIndices]
      .map((pageIndex) => viewer?.getPageView?.(pageIndex)?.div)
      .filter(Boolean);
    const root = viewer?.viewer || document.querySelector("#viewer");
    const targets = pageTargets.length === pageIndices.size ? pageTargets : [root].filter(Boolean);
    if (!targets.length) return false;
    const observer = new MutationObserver((records) => {
      const touchedPages = new Set();
      for (const record of records) {
        const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
        const layer = target?.closest?.(".annotationLayer");
        const pageNumber = Number(layer?.closest?.(".page")?.dataset?.pageNumber);
        if (Number.isSafeInteger(pageNumber) && pageNumber > 0) {
          touchedPages.add(pageNumber - 1);
        }
        for (const node of record.addedNodes || []) {
          if (node?.nodeType !== 1) continue;
          const layers = [];
          if (node.matches?.(".annotationLayer")) layers.push(node);
          node.querySelectorAll?.(".annotationLayer").forEach((item) => layers.push(item));
          for (const addedLayer of layers) {
            const addedPageNumber = Number(addedLayer.closest?.(".page")?.dataset?.pageNumber);
            if (Number.isSafeInteger(addedPageNumber) && addedPageNumber > 0) {
              touchedPages.add(addedPageNumber - 1);
            }
          }
        }
      }
      for (const pageIndex of touchedPages) {
        if (!pageIndices.has(pageIndex)) continue;
        for (const row of rows) {
          if (row.pageIndex === pageIndex && row.embeddedRef) {
            suppressEmbeddedAnnotation(pageIndex, row.embeddedRef);
          }
        }
      }
    });
    for (const target of targets) {
      observer.observe(target, { childList: true, subtree: true });
    }
    state.externalAnnotationLayerObserver = observer;
    return true;
  }

  function applyConfirmedNativeAnnotationLayerState(documentId, openRequest) {
    if (!state.externalSourceConfirmed) return false;
    const token = state.nativeAnnotationGateToken;
    if (token && (token.documentId !== documentId || token.openRequest !== openRequest)) {
      return false;
    }
    const rows = externalAnnotationMaskRows();
    const deletedRefs = [...new Set(rows
      .filter((row) => row.deleted === true && row.embeddedRef &&
        row.provenance === "embedded")
      .map((row) => canonicalPdfAnnotationRef(row.embeddedRef))
      .filter(Boolean))];
    const maskChanged = state.annotationController?.setEmbeddedDeletionMask?.(
      state.app?.pdfDocument?.annotationStorage,
      deletedRefs,
    );
    observeExternalAnnotationLayerMutations();
    let hiddenCount = 0;
    for (const row of rows) {
      if (row.embeddedRef && suppressEmbeddedAnnotation(row.pageIndex, row.embeddedRef)) {
        hiddenCount += 1;
      }
    }
    // The confirmation installs this mask before page hydration runs. Consume
    // its invalidation here: hydration will otherwise see an unchanged mask,
    // leaving the old tombstone painted after an undo that has been saved.
    if (maskChanged) repaintEmbeddedAnnotationMaskPages(rows);
    const isCurrentGate = token && token.documentId === documentId &&
      token.openRequest === openRequest;
    if (isCurrentGate) setNativeAnnotationLayersPending(false, token);
    runtimeLogRecord("external-annotation.native-layer-confirmed", {
      documentId,
      openRequest,
      deletedReferences: deletedRefs.length,
      hiddenEmbeddedReferences: hiddenCount,
      gateReleased: Boolean(isCurrentGate),
    });
    return true;
  }

  function restoreSuppressedEmbeddedAnnotations(excludedReferences = new Set()) {
    for (const element of document.querySelectorAll(
      '[data-pdf-reader-external-hidden="1"]',
    )) {
      const annotationReference = canonicalPdfAnnotationRef(
        element.getAttribute("data-annotation-id"),
      );
      if (annotationReference && excludedReferences.has(annotationReference)) continue;
      element.style.display = element.dataset.pdfReaderPreviousDisplay || "";
      if (element.dataset.pdfReaderPreviousAriaHidden === "__absent__") {
        element.removeAttribute("aria-hidden");
      } else if (typeof element.dataset.pdfReaderPreviousAriaHidden === "string") {
        element.setAttribute("aria-hidden", element.dataset.pdfReaderPreviousAriaHidden);
      }
      delete element.dataset.pdfReaderPreviousDisplay;
      delete element.dataset.pdfReaderPreviousAriaHidden;
      element.removeAttribute("data-pdf-reader-external-hidden");
    }
  }

  function clearExternalHydration({
    clearRows = false,
    restoreEmbedded = false,
    preserveDirty = false,
  } = {}) {
    const manager = getAnnotationEditorManager();
    const dirtyIds = new Set(captureDirtySyncState(state.revision).dirtyAnnotationIds);
    const retainedEmbeddedRefs = new Set();
    state.hydratingExternalAnnotations = true;
    try {
      for (const [uuid, binding] of state.externalAnnotationHydration) {
        if (preserveDirty && dirtyIds.has(uuid)) {
          if (binding.embeddedRef) retainedEmbeddedRefs.add(binding.embeddedRef);
          continue;
        }
        if (binding.runtimeId && !binding.adoptedEmbedded) {
          manager?.getEditor?.(binding.runtimeId)?.remove?.();
        }
        if (binding.runtimeId) {
          // A removed native editor can remain in AnnotationStorage as a
          // deletion placeholder. Keep its exact binding until document reset.
          const retained = state.app?.pdfDocument?.annotationStorage?.getRawValue?.(binding.runtimeId);
          if (retained?.deleted !== true) {
            state.annotationUuidByRuntimeId.delete(binding.runtimeId);
            state.annotationRefByRuntimeId.delete(binding.runtimeId);
          }
        }
        if (restoreEmbedded && binding.adoptedEmbedded) {
          // Adopted source editors remain part of the PDF's original annotation
          // layer; removing only their external binding leaves them visible.
          state.annotationUuidByPdfRef.delete(pdfAnnotationRefKey(binding.embeddedRef));
        }
        state.externalAnnotationHydration.delete(uuid);
      }
    } finally {
      state.hydratingExternalAnnotations = false;
    }
    if (restoreEmbedded) restoreSuppressedEmbeddedAnnotations(retainedEmbeddedRefs);
    if (clearRows) {
      state.externalAnnotationRows.clear();
      state.externalDeletionGuards?.clear();
      state.maskPaintCleanup?.();
      state.maskPaintCleanup = null;
      state.externalAnnotationRefs.clear();
      state.externalSource = null;
      state.pendingExternalAnnotationsUpdate = null;
      stopExternalAnnotationLayerObserver();
    }
  }

  function findEmbeddedEditor(manager, pageIndex, reference) {
    const canonical = canonicalPdfAnnotationRef(reference);
    if (!canonical) return null;
    const editors = manager?.getEditors?.(pageIndex);
    if (!editors || typeof editors[Symbol.iterator] !== "function") return null;
    const matches = [...editors].filter((editor) =>
      canonicalPdfAnnotationRef(editor?.annotationElementId) === canonical &&
      editor.deleted !== true,
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function externalAnnotationMatchesClock(left, right) {
    if (!left || !right) return false;
    const a = left.clock || {};
    const b = right.clock || {};
    return a.timestamp === b.timestamp && a.logical === b.logical &&
      a.deviceId === b.deviceId && a.opId === b.opId;
  }

  function findUuidMappedEditors(manager, pageIndex, uuid) {
    const editors = manager?.getEditors?.(pageIndex);
    if (!editors || typeof editors[Symbol.iterator] !== "function") return [];
    return [...editors].filter((editor) =>
      editor?.deleted !== true &&
      state.annotationUuidByRuntimeId.get(String(editor.id)) === uuid,
    );
  }

  function externalAnnotationMatchesLocalOperation(row) {
    const entry = state.annotationOperations.find(({ operation }) =>
      operation?.uuid === row?.uuid,
    );
    const operation = entry?.operation;
    if (!operation || operation.deleted === true || operation.action === "delete") {
      return false;
    }
    return operation.timestamp === row.clock.timestamp &&
      operation.logical === row.clock.logical &&
      operation.deviceId === row.clock.deviceId &&
      operation.operationId === row.clock.opId;
  }

  function addHydratedEditor(layer, editor, { freeTextFontSize = null } = {}) {
    // Hydration restores durable content, not a user creation gesture. The
    // normal layer.add path asks onceAdded(true) to focus/select a new editor;
    // during mode restoration that can focus a page without a currentLayer.
    // Preserve all onceAdded bookkeeping, but do not take keyboard focus.
    const onceAddedDescriptor = Object.getOwnPropertyDescriptor(editor, "onceAdded");
    const onceAdded = editor.onceAdded;
    Object.defineProperty(editor, "onceAdded", {
      configurable: true,
      writable: true,
      value: function () { return onceAdded.call(this, false); },
    });
    try {
      if (
        typeof freeTextFontSize !== "number" ||
        !Number.isFinite(freeTextFontSize) ||
        freeTextFontSize <= 0
      ) {
        return layer.add(editor);
      }
      const methodName = "getInitialTranslation";
      const ownDescriptor = Object.getOwnPropertyDescriptor(editor, methodName);
      const originalMethod = editor?.[methodName];
      if (
        typeof originalMethod !== "function" ||
        ownDescriptor?.configurable === false ||
        (!ownDescriptor && !Object.isExtensible(editor))
      ) {
        return layer.add(editor);
      }

      try {
        Object.defineProperty(editor, methodName, {
          configurable: true,
          enumerable: ownDescriptor?.enumerable ?? false,
          writable: true,
          value: function (...args) {
            const translation = originalMethod.apply(this, args);
            const scale = this?.parentScale;
            if (
              (!Array.isArray(translation) && !ArrayBuffer.isView(translation)) ||
              translation.length < 2 ||
              !Number.isFinite(translation[0]) ||
              !Number.isFinite(translation[1]) ||
              !Number.isFinite(scale) ||
              scale <= 0
            ) {
              return translation;
            }
            const correction = freeTextFontSize * scale;
            if (!Number.isFinite(correction)) return translation;
            const correctedX = translation[0];
            const correctedY = translation[1] + correction;
            const editorRotation = this?.rotation;
            const parentRotation = this?.parentRotation;
            if (!Number.isFinite(editorRotation) || !Number.isFinite(parentRotation)) {
              return [correctedX, correctedY];
            }
            const relativeRotation = ((editorRotation - parentRotation) % 360 + 360) % 360;
            switch (relativeRotation) {
              case 90:
                return [correctedY, -correctedX];
              case 180:
                return [-correctedX, -correctedY];
              case 270:
                return [-correctedY, correctedX];
              default:
                return [correctedX, correctedY];
            }
          },
        });
      } catch {
        // If PDF.js made the editor non-extensible, preserve its normal render.
        return layer.add(editor);
      }

      try {
        // Hydrated FreeText rects already include the font-size translation from
        // their original render. Cancel only that screen-space component for
        // this synchronous render; PDF.js still applies padding and page rotation.
        return layer.add(editor);
      } finally {
        if (ownDescriptor) {
          Object.defineProperty(editor, methodName, ownDescriptor);
        } else {
          Reflect.deleteProperty(editor, methodName);
        }
      }
    } finally {
      if (onceAddedDescriptor) Object.defineProperty(editor, "onceAdded", onceAddedDescriptor);
      else Reflect.deleteProperty(editor, "onceAdded");
    }
  }

  async function hydrateExternalAnnotation(row, { replace = false } = {}) {
    const app = state.app;
    const pdfDocument = app?.pdfDocument;
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    const startingRevision = state.revision;
    const startingDirty = state.dirty;
    const startingChanges = snapshotChanges(app);
    const manager = getAnnotationEditorManager(app);
    const layer = getAnnotationEditorLayer(app, row.pageIndex);
    if (!manager || !layer) return false;
    const currentBinding = state.externalAnnotationHydration.get(row.uuid);
    if (
      !replace && currentBinding &&
      externalAnnotationMatchesClock(currentBinding.row, row)
    ) return true;
    const mappedEditors = findUuidMappedEditors(manager, row.pageIndex, row.uuid);
    const existing = currentBinding?.runtimeId
      ? manager.getEditor?.(currentBinding.runtimeId)
      : row.embeddedRef
        ? findEmbeddedEditor(manager, row.pageIndex, row.embeddedRef) || mappedEditors[0] || null
        : mappedEditors[0] || null;
    let replacedRuntimeId = null;
    if (
      existing &&
      externalAnnotationMatchesLocalOperation(row)
    ) {
      // A save ACK can immediately echo the operation made by this very
      // editor. Its PDF.js runtime ID is local and is not a persisted ref, so
      // the external hydration binding may not exist yet. Adopt the exact
      // UUID-mapped editor only when the full operation stamp matches; do not
      // compare transformed rectangle floats or replace a newer operation.
      const runtimeId = String(existing.id);
      state.annotationUuidByRuntimeId.set(runtimeId, row.uuid);
      if (row.embeddedRef) {
        state.annotationRefByRuntimeId.set(runtimeId, row.embeddedRef);
        state.annotationUuidByPdfRef.set(pdfAnnotationRefKey(row.embeddedRef), row.uuid);
      }
      state.externalAnnotationHydration.set(row.uuid, {
        runtimeId,
        pageIndex: row.pageIndex,
        embeddedRef: row.embeddedRef,
        row,
        adoptedEmbedded: Boolean(
          row.embeddedRef &&
          canonicalPdfAnnotationRef(existing.annotationElementId) === row.embeddedRef,
        ),
      });
      return true;
    }
    if (
      existing && !replace &&
      sameAnnotationPayload(
        encodeExternalValue(existing.serialize?.(true)),
        encodeExternalValue(row.editor),
      )
    ) {
      state.annotationUuidByRuntimeId.set(String(existing.id), row.uuid);
      if (row.embeddedRef) {
        state.annotationRefByRuntimeId.set(String(existing.id), row.embeddedRef);
        state.annotationUuidByPdfRef.set(pdfAnnotationRefKey(row.embeddedRef), row.uuid);
      }
      state.externalAnnotationHydration.set(row.uuid, {
        runtimeId: String(existing.id),
        pageIndex: row.pageIndex,
        embeddedRef: row.embeddedRef,
        row,
        adoptedEmbedded: Boolean(
          (currentBinding?.runtimeId === String(existing.id) && currentBinding.adoptedEmbedded) ||
          (row.embeddedRef &&
            canonicalPdfAnnotationRef(existing.annotationElementId) === row.embeddedRef),
        ),
      });
      return true;
    }
    if (currentBinding?.runtimeId) {
      replacedRuntimeId = String(currentBinding.runtimeId);
      state.hydratingExternalAnnotations = true;
      try {
        manager.getEditor?.(currentBinding.runtimeId)?.remove?.();
      } finally {
        state.hydratingExternalAnnotations = false;
      }
      state.externalAnnotationHydration.delete(row.uuid);
    } else if (existing && (row.embeddedRef || mappedEditors.includes(existing))) {
      // Replace only the exact legacy editor whose source ref is being hidden,
      // or the local editor already mapped to this UUID when a newer external
      // operation supersedes it.
      replacedRuntimeId = String(existing.id);
      state.hydratingExternalAnnotations = true;
      try {
        existing.remove?.();
      } finally {
        state.hydratingExternalAnnotations = false;
      }
    }
    const payload = decodeExternalValue(row.editor);
    delete payload.annotationElementId;
    delete payload.id;
    delete payload.deleted;
    payload.pageIndex = row.pageIndex;
    const isFreeText = normalizeSyncKind(row.kind) === "FreeText";
    if (isFreeText) {
      // PDF.js only fills FreeTextEditor.editorDiv from serialized `value`
      // when rendering a copy or a source-PDF annotation. Sidecar hydration
      // deliberately strips the source annotation ID, so mark this payload as
      // a copy to restore its content without inventing a PDF object ref.
      payload.isCopy = true;
    }

    // Snapshot only the state immediately before the async deserialize. This
    // lets hydration distinguish its own editor replacement from annotation
    // rows or dirty state created while PDF.js yielded to the event loop.
    const revisionBeforeDeserialize = state.revision;
    const dirtyBeforeDeserialize = state.dirty;
    const changesBeforeDeserialize = snapshotChanges(app);
    const rowsBeforeDeserialize = getAnnotationStorageRows(app);
    const withoutTargetUuid = (rows) => new Map(
      [...rows].filter(([, candidate]) => candidate.uuid !== row.uuid),
    );
    const baselineBeforeDeserialize = withoutTargetUuid(state.annotationSnapshot);
    const rowsBeforeDeserializeWithoutTarget = withoutTargetUuid(rowsBeforeDeserialize);
    const hadUntrackedRowsBeforeDeserialize = annotationRowsChanged(
      baselineBeforeDeserialize,
      rowsBeforeDeserializeWithoutTarget,
    );
    const editor = await layer.deserialize(payload);
    if (
      state.disposed || state.app !== app || app.pdfDocument !== pdfDocument ||
      state.activeDocumentId !== documentId || state.activeOpenRequest !== openRequest
    ) {
      // The async deserialize belongs to a document session that is no longer
      // active. Never attach its editor or write its baseline into the new one.
      return false;
    }
    if (!editor) {
      throw new Error(`PDF.js refused to hydrate ${row.kind} annotation ${row.uuid}.`);
    }
    const changesAfterDeserialize = snapshotChanges(app);
    const rowsAfterDeserialize = getAnnotationStorageRows(app);
    const hadConcurrentMutation =
      state.revision !== revisionBeforeDeserialize ||
      state.dirty !== dirtyBeforeDeserialize ||
      changesAfterDeserialize.hadAnnotationChanges !== changesBeforeDeserialize.hadAnnotationChanges ||
      changesAfterDeserialize.hadStructuralChanges !== changesBeforeDeserialize.hadStructuralChanges ||
      annotationRowsChanged(
        rowsBeforeDeserializeWithoutTarget,
        withoutTargetUuid(rowsAfterDeserialize),
      ) ||
      isEditBoundaryBusy() || state.pendingInkCommit;
    if (isFreeText) {
      // The copy render path calls _moveAfterPaste. `isClone` makes that
      // method consume the marker without shifting the persisted rectangle.
      editor.isClone = true;
    }
    let hadUntrackedRowsAfterHydration = false;
    state.hydratingExternalAnnotations = true;
    try {
      addHydratedEditor(layer, editor, {
        freeTextFontSize: isFreeText ? payload.fontSize : null,
      });
      // PDF.js leaves an empty editor layer hidden after its first render.
      // Hydrating an external annotation later adds an editor without going
      // through PDF.js's toolbar path, so explicitly reveal the builder once
      // it is no longer empty.
      app.pdfViewer?.getPageView?.(row.pageIndex)?.annotationEditorLayer?.show?.();
      const runtimeId = String(editor.id);
      state.annotationUuidByRuntimeId.set(runtimeId, row.uuid);
      if (row.embeddedRef) {
        state.annotationRefByRuntimeId.set(runtimeId, row.embeddedRef);
        state.annotationUuidByPdfRef.set(pdfAnnotationRefKey(row.embeddedRef), row.uuid);
      }
      state.externalAnnotationHydration.set(row.uuid, {
        runtimeId,
        pageIndex: row.pageIndex,
        embeddedRef: row.embeddedRef,
        row,
        adoptedEmbedded: false,
      });
      const rowsAfterHydration = getAnnotationStorageRows(app);
      const nextSnapshot = new Map(state.annotationSnapshot);
      for (const [oldRuntimeId, oldRow] of nextSnapshot) {
        if (oldRuntimeId === replacedRuntimeId || oldRow.uuid === row.uuid) {
          nextSnapshot.delete(oldRuntimeId);
        }
      }
      const hydratedRow = rowsAfterHydration.get(runtimeId);
      if (hydratedRow) nextSnapshot.set(runtimeId, hydratedRow);
      state.annotationSnapshot = nextSnapshot;
      hadUntrackedRowsAfterHydration = annotationRowsChanged(
        withoutTargetUuid(nextSnapshot),
        withoutTargetUuid(rowsAfterHydration),
      );

      const canClearHydrationOnlyDirtyState =
        !startingDirty &&
        !startingChanges.hadAnnotationChanges &&
        !startingChanges.hadStructuralChanges &&
        !hadUntrackedRowsBeforeDeserialize &&
        !hadConcurrentMutation &&
        state.revision === startingRevision &&
        !state.dirty &&
        !hadUntrackedRowsAfterHydration;
      if (canClearHydrationOnlyDirtyState) {
        app.pdfDocument?.annotationStorage?.resetModified?.();
        restoreChanges(app, startingChanges);
      }
    } finally {
      state.hydratingExternalAnnotations = false;
    }
    if (hadUntrackedRowsAfterHydration) noteMutation();
    return true;
  }

  function repaintEmbeddedAnnotationMaskPages(rows) {
    const app = state.app;
    if (state.disposed || !app?.pdfDocument) return;
    // Reuse PDF.js page rendering only for loaded pages with exact embedded
    // references. Its update preserves editor/selection layers and source bytes.
    const pages = new Set(rows.filter(row => row.embeddedRef).map(row => row.pageIndex));
    state.maskPaintCleanup?.();
    const cleanups = [];
    const pdfDocument = app.pdfDocument;
    const session = state.openSession;
    const cleanup = () => { for (const dispose of cleanups.splice(0)) dispose(); };
    state.maskPaintCleanup = cleanup;
    session?.signal.addEventListener("abort", cleanup, { once: true });
    cleanups.push(() => session?.signal.removeEventListener("abort", cleanup));
    let updated = false;
    for (const pageIndex of pages) {
      const view = app.pdfViewer?.getPageView?.(pageIndex);
      if (view?.canvas && typeof view.update === "function") {
        const bus = app.eventBus;
        if (view.div && bus?._on && bus?._off) {
          // update() replaces Canvas asynchronously. Hide the previous AP
          // until the render using the confirmed deletion mask finishes.
          view.div.setAttribute("data-pdf-reader-mask-pending", "");
          const onRendered = (event) => {
            if (event.pageNumber !== pageIndex + 1 || event.error || app.pdfDocument !== pdfDocument ||
                state.openSession !== session) return;
            view.div.removeAttribute("data-pdf-reader-mask-pending");
            bus._off("pagerendered", onRendered);
            runtimeLogRecord("external-annotation.mask-page-rendered", { pageIndex });
          };
          bus._on("pagerendered", onRendered);
          cleanups.push(() => { bus._off("pagerendered", onRendered); view.div.removeAttribute("data-pdf-reader-mask-pending"); });
        }
        view.update({});
        updated = true;
      }
    }
    if (updated) app.pdfViewer?.forceRendering?.();
  }

  async function hydrateExternalAnnotationsForPage(pageIndex) {
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || state.disposed) return true;
    const rows = externalAnnotationMaskRows()
      .filter((row) => row.pageIndex === pageIndex && (
        row.deleted === true
          ? !state.dirtyAnnotationRevisions.has(row.uuid) || state.pendingBulkDeletedUuids.has(row.uuid)
          : !state.pendingBulkDeletedUuids.has(row.uuid) &&
            !state.dirtyDeletedAnnotationIds.has(row.uuid)
      ));
    if (!rows.length) return true;
    const deletedRefs = externalAnnotationMaskRows()
      .filter(row => row.deleted && row.embeddedRef &&
        row.provenance === "embedded" &&
        (!state.dirtyAnnotationRevisions.has(row.uuid) || state.pendingBulkDeletedUuids.has(row.uuid)))
      .map(row => canonicalPdfAnnotationRef(row.embeddedRef)).filter(Boolean);
    const maskChanged = state.annotationController?.setEmbeddedDeletionMask?.(state.app?.pdfDocument?.annotationStorage, deletedRefs);
    if (maskChanged) {
      repaintEmbeddedAnnotationMaskPages(externalAnnotationMaskRows());
    }
    const pageView = state.app?.pdfViewer?.getPageView?.(pageIndex);
    if (!getAnnotationEditorManager() || !pageView?.annotationEditorLayer?.annotationEditorLayer) {
      return false;
    }
    let complete = true;
    for (const row of rows) {
      if (row.embeddedRef) suppressEmbeddedAnnotation(pageIndex, row.embeddedRef);
      if (row.deleted) {
        const binding = state.externalAnnotationHydration.get(row.uuid);
        const manager = getAnnotationEditorManager();
        const deletedEditor = manager?.getEditor?.(binding?.runtimeId) ||
          (row.embeddedRef && row.provenance === "embedded" ? findEmbeddedEditor(manager, pageIndex, row.embeddedRef) : null);
        if (deletedEditor) {
          // PDF.js may recreate original editors when a tool is enabled. Bind
          // this exact source editor before removing it so its retained delete
          // placeholder cannot acquire a second identity during capture.
          const runtimeId = String(deletedEditor.id);
          state.annotationUuidByRuntimeId.set(runtimeId, row.uuid);
          if (row.embeddedRef) {
            state.annotationRefByRuntimeId.set(runtimeId, row.embeddedRef);
            state.annotationUuidByPdfRef.set(pdfAnnotationRefKey(row.embeddedRef), row.uuid);
          }
          state.hydratingExternalAnnotations = true;
          try {
            deletedEditor.remove?.();
          } finally {
            state.hydratingExternalAnnotations = false;
          }
        }
        state.externalAnnotationHydration.delete(row.uuid);
        const nextSnapshot = new Map(state.annotationSnapshot);
        for (const [runtimeId, snapshotRow] of nextSnapshot) {
          if (runtimeId === binding?.runtimeId || snapshotRow.uuid === row.uuid) {
            nextSnapshot.delete(runtimeId);
          }
        }
        state.annotationSnapshot = nextSnapshot;
        continue;
      }
      try {
        const current = state.externalAnnotationHydration.get(row.uuid)?.row;
        const newer = !current || (row.authoritative ? !externalAnnotationMatchesClock(row, current) : compareSyncStamps(
          { timestamp: row.clock.timestamp, logical: row.clock.logical, actorId: row.clock.deviceId, operationId: row.clock.opId },
          { timestamp: current.clock.timestamp, logical: current.clock.logical, actorId: current.clock.deviceId, operationId: current.clock.opId },
        ) > 0);
        if (newer && !(await hydrateExternalAnnotation(row, { replace: Boolean(current) }))) {
          complete = false;
          continue;
        }
      } catch (error) {
        runtimeLogRecord("external-annotation.hydrate-error", {
          uuid: row.uuid,
          pageIndex,
          kind: row.kind,
          error: runtimeLogError(error),
        });
        sendError(error.message || "Could not restore external PDF annotation.", {
          documentId: state.activeDocumentId,
          openRequest: state.activeOpenRequest,
          code: "external-annotation-hydration-failed",
          annotationId: row.uuid,
        });
      }
    }
    return complete;
  }

  function applyExternalAnnotationsSnapshot(value, { reset = false } = {}) {
    const normalized = validateExternalAnnotations(value);
    if (!externalSourceIdentityMatchesViewer(normalized.source)) {
      throw new Error("External PDF annotations are not confirmed against this document's page identity.");
    }
    const incoming = new Map(normalized.annotations.map((row) => [row.uuid, row]));
    const dirtyIds = new Set(captureDirtySyncState(state.revision).dirtyAnnotationIds);
    const merged = reset ? new Map() : new Map(state.externalAnnotationRows);
    const guards = reset ? new Map() : new Map(state.externalDeletionGuards);
    const deferredUuids = [];
    for (const row of incoming.values()) {
      if (dirtyIds.has(row.uuid)) {
        deferredUuids.push(row.uuid);
        continue;
      }
      const guard = guards.get(row.uuid);
      if (guard && compareDeletionGuardVersion(guard, row) >= 0) continue;
      guards.delete(row.uuid);
      const previous = merged.get(row.uuid);
      if (!previous || row.authoritative || compareSyncStamps(
        { timestamp: row.clock.timestamp, logical: row.clock.logical, actorId: row.clock.deviceId, operationId: row.clock.opId },
        { timestamp: previous.clock.timestamp, logical: previous.clock.logical, actorId: previous.clock.deviceId, operationId: previous.clock.opId },
      ) >= 0) {
        merged.set(row.uuid, row);
      }
      if (state.pendingBulkDeletedUuids.has(row.uuid)) {
        const pendingDelete = latestPendingAnnotationOperation(row.uuid);
        const incomingStamp = {
          timestamp: row.clock.timestamp,
          logical: row.clock.logical,
          actorId: row.clock.deviceId,
          operationId: row.clock.opId,
        };
        const pendingStamp = pendingDelete && {
          timestamp: pendingDelete.timestamp,
          logical: pendingDelete.logical,
          actorId: pendingDelete.deviceId || pendingDelete.actorId,
          operationId: pendingDelete.operationId,
        };
        if (!pendingStamp || compareSyncStamps(incomingStamp, pendingStamp) >= 0) {
          state.pendingBulkDeletedUuids.delete(row.uuid);
        }
      }
    }
    for (const guard of normalized.deletionGuards || []) {
      if (dirtyIds.has(guard.uuid)) { deferredUuids.push(guard.uuid); continue; }
      const row = merged.get(guard.uuid);
      const previous = guards.get(guard.uuid);
      if ((row && compareDeletionGuardVersion(guard, row) < 0) ||
          (previous && compareDeletionGuardVersion(guard, previous) < 0)) continue;
      merged.delete(guard.uuid);
      guards.set(guard.uuid, guard);
    }
    state.externalAnnotationRows = merged;
    state.externalDeletionGuards = guards;
    state.externalAnnotationRefs = new Set(
      externalAnnotationMaskRows().filter((row) => row.embeddedRef).map((row) => row.embeddedRef),
    );
    state.externalSource = normalized.source;
    state.compactInkEncoding = normalized.compactInkEncoding === true;
    applyLegacyAnnotationIdentities(normalized.legacyIdentities);
    // Seed editor UUIDs from exact PDF object references before the next
    // AnnotationStorage diff. This preserves pre-0.6 UUIDs when an embedded
    // annotation is first edited and lazily migrated into the sidecar log.
    if (reset) {
      state.annotationSnapshot = getAnnotationStorageRows();
    }
    state.externalSourceConfirmed = true;
    for (const row of merged.values()) seedSyncClock({ identities: [row.clock] });
    state.annotationSidebarController?.refreshIfOpen();
    return {
      pages: [...new Set([...incoming.values(), ...guards.values()].map((row) => row.pageIndex))],
      deferredUuids,
    };
  }

  function externalSourceIdentityMatchesViewer(source) {
    const actual = state.actualSourceIdentity;
    if (
      !source || !actual || actual.identityStatus !== "KNOWN" ||
      !Number.isSafeInteger(source.pageCount) ||
      source.pageCount !== actual.pageCount ||
      !Array.isArray(source.orderedPageIdentities) ||
      source.orderedPageIdentities.length !== actual.orderedPageIdentities.length ||
      source.orderedPageIdentities.some((identity, index) =>
        typeof identity !== "string" || identity !== actual.orderedPageIdentities[index]
      )
    ) return false;
    if (
      typeof source.sourceHash === "string" &&
      typeof actual.sourceHash === "string" &&
      source.sourceHash !== actual.sourceHash
    ) return false;
    return true;
  }

  function schedulePendingExternalAnnotationUpdate() {
    if (!state.pendingExternalAnnotationsUpdate || state.disposed) return;
    if (isEditBoundaryBusy() || state.pendingInkCommit || state.hydratingExternalAnnotations) return;
    const pending = state.pendingExternalAnnotationsUpdate;
    setDeferredTimeout(() => {
      if (state.pendingExternalAnnotationsUpdate !== pending) return;
      if (
        state.disposed || state.activeDocumentId !== pending.documentId ||
        state.activeOpenRequest !== pending.openRequest
      ) return;
      // The edit boundary may become busy after this task is queued. Keep the
      // latest update pending rather than applying a snapshot across a stroke,
      // text commit, or an in-flight annotation hydration.
      if (isEditBoundaryBusy() || state.pendingInkCommit || state.hydratingExternalAnnotations) {
        return;
      }
      void (async () => {
        try {
          const identityConfirmed = pending.identityConfirmed === true || state.externalSourceConfirmed;
          if (!identityConfirmed) return;
          if (state.pendingExternalAnnotationsUpdate !== pending) return;
          state.pendingExternalAnnotationsUpdate = null;
          const result = applyExternalAnnotationsSnapshot(pending.externalAnnotations);
          applyConfirmedNativeAnnotationLayerState(
            pending.documentId,
            pending.openRequest,
          );
          for (const pageIndex of new Set(result.pages)) {
          const hydrated = await hydrateExternalAnnotationsForPage(pageIndex);
          if (!hydrated) scheduleExternalAnnotationHydrationRetry(pageIndex);
          }
          // Opening stays fail-closed until the host has verified both the
          // full source hash and ordered page identities. Only that response
          // may enable editing for this document revision.
          state.readOnly = pending.readOnly === true || !identityConfirmed;
          setReadOnlyState(state.readOnly);
          if (!state.readOnly) restorePreferredAnnotationTool(pending.documentId, pending.openRequest);
          if (result.deferredUuids.length) {
            if (!state.pendingExternalAnnotationsUpdate) {
              state.pendingExternalAnnotationsUpdate = pending;
            }
          }
        } catch (error) {
          sendError(error.message || "Could not apply synchronized PDF annotations.", {
            documentId: pending.documentId,
            openRequest: pending.openRequest,
            code: "external-annotation-update-failed",
          });
        }
      })();
    }, 0);
  }

  function exactSavedIdentityForOperation(operation) {
    if (
      !operation ||
      typeof operation.uuid !== "string" ||
      !operation.uuid ||
      !Number.isSafeInteger(operation.pageIndex) ||
      typeof operation.kind !== "string" ||
      !operation.kind ||
      normalizeSyncKind(operation.kind) === "Unknown"
    ) {
      return null;
    }
    const operationRef = canonicalPdfAnnotationRef(operation.ref);
    if (!operationRef) {
      return null;
    }
    const identity = state.syncState?.identities?.find((candidate) =>
      candidate?.uuid === operation.uuid &&
      canonicalPdfAnnotationRef(candidate.ref) === operationRef &&
      candidate.pageIndex === operation.pageIndex &&
      normalizeSyncKind(candidate.kind) === normalizeSyncKind(operation.kind),
    );
    if (!identity) {
      return null;
    }
    return {
      uuid: identity.uuid,
      ref: operationRef,
      pageIndex: identity.pageIndex,
      kind: normalizeSyncKind(identity.kind),
      runtimeId: typeof identity.runtimeId === "string" ? identity.runtimeId : null,
    };
  }

  function findLiveSavedEditor(manager, identity) {
    if (!manager || !identity) {
      return null;
    }
    // A newly-created PDF.js editor can remain id:null in the open Viewer even
    // after the host has confirmed its persisted PDF reference. When undo
    // restores that editor, runtimeId is the exact session binding carried by
    // the host ACK; accept it only with the same page/type and a live editor.
    if (identity.runtimeId) {
      const editor = manager.getEditor?.(identity.runtimeId);
      if (
        editor &&
        editor.deleted !== true &&
        editor.pageIndex === identity.pageIndex &&
        normalizeSyncKind(editor.editorType) === identity.kind
      ) {
        return editor;
      }
    }
    const editors = manager.getEditors?.(identity.pageIndex);
    if (!editors || typeof editors[Symbol.iterator] !== "function") {
      return null;
    }
    for (const editor of editors) {
      const editorUuid = typeof editor?.id === "string"
        ? state.annotationUuidByRuntimeId.get(editor.id)
        : null;
      if (
        editor &&
        editor.deleted !== true &&
        editor.pageIndex === identity.pageIndex &&
        (editorUuid === identity.uuid ||
          canonicalPdfAnnotationRef(editor.annotationElementId) === identity.ref) &&
        normalizeSyncKind(editor.editorType) === identity.kind
      ) {
        return editor;
      }
    }
    return null;
  }

  function captureSavedEditorHistory(manager, direction) {
    const candidates = [];
    for (const { operation } of state.annotationOperations) {
      if (direction === "undo" && operation.action !== "delete") {
        continue;
      }
      if (direction === "redo" && operation.action !== "upsert") {
        continue;
      }
      if (
        direction === "redo" &&
        !state.restoredSavedAnnotations.has(operation.uuid)
      ) {
        continue;
      }
      const identity = exactSavedIdentityForOperation(operation);
      if (!identity) {
        continue;
      }
      candidates.push({
        identity,
        wasLive: Boolean(findLiveSavedEditor(manager, identity)),
      });
    }
    return candidates;
  }

  function recordSavedEditorHistoryOperation(identity, editor, action) {
    if (action === "upsert" && state.pendingBulkDeletedUuids?.has(identity.uuid)) return;
    const stamp = makeSyncStamp();
    let serialized;
    if (action === "upsert") {
      try {
        const snapshot = editor?.serialize?.(true);
        if (snapshot && typeof snapshot === "object") {
          serialized = normalizeSyncValue(snapshot);
        }
      } catch {
        // A full editor snapshot is supplemental. The exact saved identity and
        // transition are sufficient to record this restored unchanged editor.
      }
    }
    const operation = {
      uuid: identity.uuid,
      // Until the live PDF.js editor is rebound to the persisted annotation
      // object, an undo upsert must stay an exact id:null creation against the
      // loaded base. A later delete may still use the ACK's saved PDF ref.
      ref: action === "upsert" && !canonicalPdfAnnotationRef(editor?.annotationElementId)
        ? null
        : identity.ref,
      pageIndex: identity.pageIndex,
      kind: identity.kind,
      deleted: action === "delete",
      provenance: state.annotationProvenanceByUuid.get(identity.uuid) || "external",
      action,
      ...stamp,
      serialized: action === "delete" ? { deleted: true } : serialized,
      payload: action === "delete" || !serialized
        ? null
        : { editor: serialized },
    };
    const existingIndex = state.annotationOperations.findIndex(
      (entry) => entry.operation.uuid === identity.uuid,
    );
    if (existingIndex >= 0) {
      state.annotationOperations.splice(existingIndex, 1);
    }
    state.annotationOperations.push({ revision: state.revision, operation });
    const isNew = action === "upsert" && !canonicalPdfAnnotationRef(editor?.annotationElementId);
    markDirtyAnnotation(identity.uuid, identity.pageIndex, action, state.revision, isNew);
    if (action === "upsert") {
      state.restoredSavedAnnotations.set(identity.uuid, identity);
    } else {
      state.restoredSavedAnnotations.delete(identity.uuid);
    }
  }

  function reconcileSavedEditorHistory(manager, direction, candidates) {
    let changed = 0;
    for (const { identity, wasLive } of candidates) {
      const editor = findLiveSavedEditor(manager, identity);
      const isLive = Boolean(editor);
      const restored = direction === "undo" && !wasLive && isLive;
      const removed = direction === "redo" && wasLive && !isLive;
      if (restored) {
        recordSavedEditorHistoryOperation(identity, editor, "upsert");
        changed += 1;
      } else if (removed) {
        recordSavedEditorHistoryOperation(identity, null, "delete");
        changed += 1;
      }
    }
    return changed;
  }

  function annotationRowsChanged(before, after) {
    if (!(before instanceof Map) || !(after instanceof Map)) return true;
    if (before.size !== after.size) return true;
    for (const [runtimeId, row] of after) {
      if (before.get(runtimeId)?.signature !== row?.signature) return true;
    }
    return false;
  }

  function hasSavedEditorHistoryTransition(manager, direction, candidates) {
    return candidates.some(({ identity, wasLive }) => {
      const isLive = Boolean(findLiveSavedEditor(manager, identity));
      return direction === "undo" ? !wasLive && isLive : wasLive && !isLive;
    });
  }

  function refreshAnnotationOperations(revision = state.revision, { includeLiveEditors = false } = {}) {
    const current = getAnnotationStorageRows(state.app, { includeLiveEditors });
    const previous = state.annotationSnapshot;
    const changed = new Map();
    const runtimeIds = new Set([...previous.keys(), ...current.keys()]);
    for (const runtimeId of runtimeIds) {
      const before = previous.get(runtimeId) || null;
      const after = current.get(runtimeId) || null;
      if (before?.signature === after?.signature) {
        continue;
      }
      const row = after || before;
      if (!row) {
        continue;
      }
      changed.set(row.uuid, { before, after, row });
    }
    for (const { before, after, row } of changed.values()) {
      const currentRow = after || row;
      // A stale editor/storage snapshot is not an undo. Keep the explicit
      // bulk tombstone until ACK; only the undo command clears this ownership.
      if (state.pendingBulkDeletedUuids?.has(currentRow.uuid)) continue;
      const deleted = !after || after.deleted;
      for (const pageIndex of new Set([before?.pageIndex, after?.pageIndex].filter(Number.isSafeInteger))) {
        state.dirtyPageRevisions.set(pageIndex, revision);
      }
      const isNew = !deleted && !after?.annotationElementId && !after?.reference && !after?.operationReference;
      markDirtyAnnotation(currentRow.uuid, currentRow.pageIndex ?? before?.pageIndex ?? null,
        deleted ? "delete" : "upsert", revision, isNew);
      const operationReference = after
        ? after.deleted
          ? after.reference || after.operationReference
          : after.operationReference
        : before?.reference || before?.operationReference;
      const stamp = makeSyncStamp();
      const operation = {
        uuid: currentRow.uuid,
        ref: operationReference || null,
        pageIndex: currentRow.pageIndex ?? before?.pageIndex ?? null,
        kind: EXTERNAL_ANNOTATION_KINDS.has(normalizeSyncKind(currentRow.kind))
          ? normalizeSyncKind(currentRow.kind)
          : before?.kind || "Unknown",
        deleted,
        provenance: state.annotationProvenanceByUuid.get(currentRow.uuid) || "external",
        action: deleted ? "delete" : "upsert",
        ...stamp,
        ...(deleted
          ? { serialized: { deleted: true }, payload: null }
          : { serialized: currentRow.value, payload: { editor: currentRow.value } }),
      };
      const existingIndex = state.annotationOperations.findIndex(
        (entry) => entry.operation.uuid === operation.uuid,
      );
      if (existingIndex >= 0) {
        state.annotationOperations.splice(existingIndex, 1);
      }
      state.annotationOperations.push({
        revision,
        operation,
      });
      if (deleted) {
        state.restoredSavedAnnotations.delete(operation.uuid);
      }
    }
    state.annotationSnapshot = current;
    const manager = state.app?.pdfViewer?._layerProperties
      ?.annotationEditorUIManager;
    if (manager) {
      for (const [uuid, identity] of state.restoredSavedAnnotations) {
        if (!findLiveSavedEditor(manager, identity)) {
          state.restoredSavedAnnotations.delete(uuid);
        }
      }
    }
    return {
      storageRowCount: current.storageRowCount || 0,
      liveEditorCount: current.liveEditorCount || 0,
      liveEditorSerializationErrorCount: current.liveEditorSerializationErrorCount || 0,
      liveEditorEnumerationErrorCount: current.liveEditorEnumerationErrorCount || 0,
      changedAnnotationCount: changed.size,
    };
  }

  function captureOperationSnapshot(revision = state.revision, reason = "save") {
    const capture = refreshAnnotationOperations(revision, { includeLiveEditors: true });
    const dirtyState = captureDirtySyncState(revision);
    const operations = captureSyncOperations(revision);
    const operationIds = new Set(operations.map((operation) => operation.uuid));
    const missingDirtyIds = dirtyState.dirtyAnnotationIds.filter((uuid) => !operationIds.has(uuid));
    if (!missingDirtyIds.length && !capture.liveEditorSerializationErrorCount &&
        !capture.liveEditorEnumerationErrorCount) state.annotationTrackingFailure = null;
    runtimeLogRecord("annotation-operation.capture", {
      reason,
      revision,
      storageRowCount: capture.storageRowCount,
      liveEditorCount: capture.liveEditorCount,
      liveEditorSerializationErrorCount: capture.liveEditorSerializationErrorCount,
      liveEditorEnumerationErrorCount: capture.liveEditorEnumerationErrorCount,
      changedAnnotationCount: capture.changedAnnotationCount,
      dirtyAnnotationCount: dirtyState.dirtyAnnotationIds.length,
      dirtyPageCount: dirtyState.dirtyPageIndices.length,
      operationCount: operations.length,
      missingDirtyCount: missingDirtyIds.length,
    });
    return { operations, dirtyState, missingDirtyIds, capture };
  }

  function settleEmptyDirtyRevision(snapshot, revision, app = state.app) {
    const capture = snapshot?.capture;
    if (
      !snapshot || snapshot.operations?.length || snapshot.missingDirtyIds?.length ||
      snapshot.dirtyState?.dirtyAnnotationIds?.length ||
      snapshot.dirtyState?.dirtyPageIndices?.length ||
      capture?.changedAnnotationCount !== 0 ||
      capture?.liveEditorSerializationErrorCount !== 0 ||
      capture?.liveEditorEnumerationErrorCount !== 0 ||
      state.revision !== revision || !app ||
      state.externalSourceMismatch || !state.externalSourceConfirmed ||
      state.pendingInkCommit || state.freeTextInputPending ||
      (state.freeTextFocused && !state.freeTextCommittedForSave) ||
      isEditBoundaryBusy() || app.pdfThumbnailViewer?.hasStructuralChanges?.()
    ) {
      return false;
    }
    const confirmation = getAnnotationStorageRows(app, { includeLiveEditors: true });
    if (
      confirmation.liveEditorSerializationErrorCount ||
      confirmation.liveEditorEnumerationErrorCount ||
      annotationRowsChanged(state.annotationSnapshot, confirmation) ||
      state.revision !== revision || isEditBoundaryBusy() ||
      app.pdfThumbnailViewer?.hasStructuralChanges?.()
    ) {
      return false;
    }
    // PDF.js can leave its global modified flag set after a no-op history
    // command. Only settle it after two complete, stable annotation snapshots
    // prove there is no annotation delta or active input to preserve.
    state.dirty = false;
    state.autoSavePending = false;
    state.autoSavePaused = false;
    state.lastRecoveredDocumentId = null;
    state.lastRecoveredRevision = null;
    clearConfirmedDirtyState(revision);
    app.pdfDocument?.annotationStorage?.resetModified?.();
    restoreChanges(app, { hadAnnotationChanges: false, hadStructuralChanges: false });
    runtimeLogRecord("annotation-operation.empty-dirty-settled", {
      revision,
      reason: "stable-empty-annotation-diff",
    });
    return true;
  }

  function assertCompleteOperationSnapshot(snapshot, context) {
    if (!snapshot || snapshot.missingDirtyIds?.length ||
        snapshot.capture?.liveEditorSerializationErrorCount ||
        snapshot.capture?.liveEditorEnumerationErrorCount) {
      throw new Error(
        `The ${context} edits do not have a complete lossless annotation operation snapshot (${snapshot?.missingDirtyIds?.length || 0} dirty annotations are missing).`,
      );
    }
    if (snapshot.dirtyState?.dirtyAnnotationIds?.length && !snapshot.operations?.length) {
      throw new Error(`The ${context} edits have no lossless annotation operation payload.`);
    }
  }

  function validateOperationAcknowledgement(message, pending) {
    return message?.external === true &&
      Number.isSafeInteger(message.operationCount) &&
      message.operationCount === pending?.operationCount &&
      (message.operationCount === 0 || (typeof message.batchId === "string" && message.batchId.length > 0));
  }

  function markDirtyAnnotation(uuid, pageIndex, action, revision, isNew) {
    if (typeof uuid !== "string" || !uuid) return;
    state.dirtyAnnotationRevisions.set(uuid, revision);
    if (Number.isSafeInteger(pageIndex) && pageIndex >= 0) {
      state.dirtyPageRevisions.set(pageIndex, revision);
    }
    if (isNew) state.dirtyNewAnnotationIds.add(uuid);
    if (action === "delete") state.dirtyDeletedAnnotationIds.add(uuid);
    else state.dirtyDeletedAnnotationIds.delete(uuid);
  }

  function captureDirtySyncState(revision = state.revision) {
    const eligible = (map) => [...map.entries()].filter(([, changedAt]) => changedAt <= revision);
    const annotationRows = eligible(state.dirtyAnnotationRevisions);
    const pageRows = eligible(state.dirtyPageRevisions);
    const annotationIds = new Set(annotationRows.map(([uuid]) => uuid));
    return {
      dirtyAnnotationIds: [...annotationIds],
      dirtyPageIndices: pageRows.map(([pageIndex]) => pageIndex).sort((a, b) => a - b),
      newAnnotationIds: [...state.dirtyNewAnnotationIds].filter((uuid) => annotationIds.has(uuid)),
      deletedAnnotationIds: [...state.dirtyDeletedAnnotationIds].filter((uuid) => annotationIds.has(uuid)),
    };
  }

  function clearConfirmedDirtyState(revision) {
    for (const [uuid, changedAt] of state.dirtyAnnotationRevisions) {
      if (changedAt <= revision) {
        state.dirtyAnnotationRevisions.delete(uuid);
        state.dirtyNewAnnotationIds.delete(uuid);
        state.dirtyDeletedAnnotationIds.delete(uuid);
        state.pendingBulkDeletedUuids.delete(uuid);
      }
    }
    for (const [pageIndex, changedAt] of state.dirtyPageRevisions) {
      if (changedAt <= revision) state.dirtyPageRevisions.delete(pageIndex);
    }
  }

  function captureSyncViewState(app = state.app) {
    const viewer = app?.pdfViewer;
    const container = document.getElementById("viewerContainer");
    const mode = viewer?.annotationEditorMode;
    return {
      pageNumber: Number.isSafeInteger(viewer?.currentPageNumber)
        ? viewer.currentPageNumber
        : 1,
      zoom: typeof viewer?.currentScaleValue === "string" ||
          typeof viewer?.currentScaleValue === "number"
        ? viewer.currentScaleValue
        : "auto",
      rotation: Number.isSafeInteger(viewer?.pagesRotation)
        ? viewer.pagesRotation
        : 0,
      scroll: {
        top: Number.isFinite(container?.scrollTop) ? container.scrollTop : 0,
        left: Number.isFinite(container?.scrollLeft) ? container.scrollLeft : 0,
      },
      tool: Number.isSafeInteger(mode) ? mode : state.editorMode,
    };
  }

  async function restoreSyncViewState(app, viewState, session) {
    if (!viewState || !app?.pdfViewer) {
      return;
    }
    const viewer = app.pdfViewer;
    const pdfDocument = app.pdfDocument;
    const pageCount = pdfDocument?.numPages || 0;
    const pageNumber = Number.isSafeInteger(viewState.pageNumber)
      ? Math.min(Math.max(viewState.pageNumber, 1), Math.max(pageCount, 1))
      : 1;
    const rotation = Number.isSafeInteger(viewState.rotation)
      ? ((viewState.rotation % 360) + 360) % 360
      : 0;
    viewer.pagesRotation = rotation;
    if (typeof viewState.zoom === "string" || typeof viewState.zoom === "number") {
      viewer.currentScaleValue = viewState.zoom;
    }
    viewer.currentPageNumber = pageNumber;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (
      session?.signal.aborted ||
      state.openSession !== session ||
      state.app !== app ||
      app.pdfDocument !== pdfDocument
    ) {
      return;
    }
    const container = document.getElementById("viewerContainer");
    if (container && viewState.scroll && typeof viewState.scroll === "object") {
      if (Number.isFinite(viewState.scroll.top)) {
        container.scrollTop = viewState.scroll.top;
      }
      if (Number.isFinite(viewState.scroll.left)) {
        container.scrollLeft = viewState.scroll.left;
      }
    }
    if (Number.isSafeInteger(viewState.tool)) {
      state.editorMode = viewState.tool;
      app.eventBus?.dispatch("switchannotationeditormode", {
        source: window,
        mode: viewState.tool,
        isFromKeyboard: true,
        createNewEditor: false,
      });
    }
  }

  function getConnectedFirstPageAnnotationLayer(app) {
    const firstPageView = app?.pdfViewer?.getPageView?.(0);
    const candidates = [
      {
        kind: "annotationLayer",
        element: firstPageView?.annotationLayer?.div ||
          firstPageView?.div?.querySelector?.(".annotationLayer"),
      },
      {
        kind: "annotationEditorLayer",
        element: firstPageView?.annotationEditorLayer?.div ||
          firstPageView?.annotationEditorLayer?.annotationEditorLayer?.div ||
          firstPageView?.div?.querySelector?.(".annotationEditorLayer"),
      },
    ];
    return candidates.find(({ element }) => element?.isConnected) || null;
  }

  function captureOpenStartupTimings({
    startedAt,
    parseStartedAt,
    parsedAt,
    app,
    pdfDocument,
  }) {
    const timings = {};
    if (Number.isFinite(parseStartedAt) && Number.isFinite(parsedAt)) {
      timings.pdfParseMs = Math.max(0, parsedAt - parseStartedAt);
    }
    const annotationLayer = getConnectedFirstPageAnnotationLayer(app);
    if (
      Number.isFinite(startedAt) &&
      app?.pdfDocument === pdfDocument &&
      app?.pdfViewer?.pdfDocument === pdfDocument &&
      annotationLayer
    ) {
      timings.firstPageAnnotationLayerMs = Math.max(
        0,
        performance.now() - startedAt,
      );
      timings.firstPageAnnotationLayerKind = annotationLayer.kind;
    }
    const manager = app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    const toolButtons = [
      "editorUnderlineButton",
      "editorSquareButton",
      "editorHighlightButton",
      "editorInkButton",
      "editorFreeTextButton",
    ].map((id) => document.getElementById(id));
    if (
      Number.isFinite(startedAt) &&
      app?.pdfDocument === pdfDocument &&
      app?.pdfViewer?.pdfDocument === pdfDocument &&
      manager &&
      !state.readOnly &&
      toolButtons.every((button) => button && !button.disabled)
    ) {
      timings.toolsUsableMs = Math.max(0, performance.now() - startedAt);
    }
    return timings;
  }

  function stopOpenStartupObserver() {
    const cleanup = state.openStartupObserverCleanup;
    state.openStartupObserverCleanup = null;
    cleanup?.();
  }

  function observeOpenStartupStages({
    startedAt,
    app,
    pdfDocument,
    session,
    documentId,
    openRequest,
    reportedTimings = {},
  }) {
    stopOpenStartupObserver();
    const completed = new Set(Object.keys(reportedTimings));
    const toolsExpected = !state.readOnly;
    if (!toolsExpected) {
      completed.add("toolsUsableMs");
    }
    if (
      typeof MutationObserver !== "function" ||
      !document.getElementById("viewerContainer") ||
      !document.getElementById("editorModeButtons")
    ) {
      return;
    }

    let observer = null;
    let stopped = false;
    const cleanup = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      observer?.disconnect();
      session.signal.removeEventListener("abort", cleanup);
      if (state.openStartupObserverCleanup === cleanup) {
        state.openStartupObserverCleanup = null;
      }
    };
    const isCurrentSession = () => !!(
      !stopped &&
      !session.signal.aborted &&
      !state.disposed &&
      session.id === state.openSessionSequence &&
      state.app === app &&
      app.pdfDocument === pdfDocument &&
      app.pdfViewer?.pdfDocument === pdfDocument &&
      state.activeDocumentId === documentId &&
      state.activeOpenRequest === openRequest
    );
    const check = () => {
      if (!isCurrentSession()) {
        cleanup();
        return;
      }
      const timings = {};
      const annotationLayer = getConnectedFirstPageAnnotationLayer(app);
      if (
        !completed.has("firstPageAnnotationLayerMs") &&
        annotationLayer
      ) {
        timings.firstPageAnnotationLayerMs = Math.max(
          0,
          performance.now() - startedAt,
        );
        timings.firstPageAnnotationLayerKind = annotationLayer.kind;
        completed.add("firstPageAnnotationLayerMs");
      }
      if (!completed.has("toolsUsableMs")) {
        const manager = app.pdfViewer?._layerProperties
          ?.annotationEditorUIManager;
        const toolButtons = [
          "editorUnderlineButton",
          "editorSquareButton",
          "editorHighlightButton",
          "editorInkButton",
          "editorFreeTextButton",
        ].map((id) => document.getElementById(id));
        if (
          toolsExpected &&
          manager &&
          toolButtons.every((button) => button && !button.disabled)
        ) {
          timings.toolsUsableMs = Math.max(0, performance.now() - startedAt);
          completed.add("toolsUsableMs");
        }
      }
      if (Object.keys(timings).length > 0) {
        postToHost("startup-timings", {
          documentId,
          openRequest,
          timings,
        });
      }
      if (
        completed.has("firstPageAnnotationLayerMs") &&
        completed.has("toolsUsableMs")
      ) {
        cleanup();
      }
    };

    observer = new MutationObserver(check);
    state.openStartupObserverCleanup = cleanup;
    session.signal.addEventListener("abort", cleanup, { once: true });
    observer.observe(document.getElementById("viewerContainer"), {
      childList: true,
      subtree: true,
    });
    observer.observe(document.getElementById("editorModeButtons"), {
      attributes: true,
      attributeFilter: ["disabled"],
      childList: true,
      subtree: true,
    });
    check();
  }

  function validSyncRequest(message) {
    return !!(
      message &&
      typeof message.id === "string" &&
      message.id.length > 0 &&
      message.id.length <= 128 &&
      typeof message.documentId === "string" &&
      Number.isSafeInteger(message.openRequest) &&
      message.openRequest >= 0 &&
      message.rendererGeneration === rendererGeneration
    );
  }

  function hasCompatibleHostAckGeneration(message) {
    return !Object.prototype.hasOwnProperty.call(message, "rendererGeneration") ||
      message.rendererGeneration === rendererGeneration;
  }

  function postSyncCheckpointRejected(message, reason) {
    return postToHost("sync-checkpoint-rejected", {
      id: message.id,
      documentId: message.documentId,
      openRequest: message.openRequest,
      revision: state.revision,
      ok: false,
      reason: String(reason || "checkpoint-rejected"),
    });
  }

  async function serializeSyncCheckpoint(message) {
    const app = state.app;
    const pdfDocument = app?.pdfDocument;
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    if (
      !app ||
      !pdfDocument ||
      !documentId ||
      documentId !== message.documentId ||
      openRequest !== message.openRequest
    ) {
      return postSyncCheckpointRejected(message, "document-session-changed");
    }
    if (state.savePromise || state.pendingSave || state.pendingRecovery) {
      return postSyncCheckpointRejected(message, "save-in-progress");
    }
    state.syncCheckpointInProgress = true;
    clearAutoSaveTimer();
    const boundaryReached = await waitForInputBoundary(110000);
    if (!boundaryReached) {
      return postSyncCheckpointRejected(message, "input-boundary-timeout");
    }
    if (
      state.disposed ||
      state.activeDocumentId !== documentId ||
      state.activeOpenRequest !== openRequest ||
      state.app?.pdfDocument !== pdfDocument
    ) {
      return postSyncCheckpointRejected(message, "document-session-changed");
    }
    if (
      Number.isSafeInteger(message.expectedRevision) &&
      message.expectedRevision !== state.revision
    ) {
      return postSyncCheckpointRejected(message, "revision-changed");
    }
    if (state.pendingInkCommit) {
      state.committingInkForSave = true;
      try {
        app.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
        state.pendingInkCommit = false;
      } finally {
        state.committingInkForSave = false;
      }
    }
    prepareContentForSave();
    const revisionAtStart = state.revision;
    if (
      Number.isSafeInteger(message.expectedRevision) &&
      message.expectedRevision !== revisionAtStart
    ) {
      return postSyncCheckpointRejected(message, "revision-changed-at-boundary");
    }
    const dirtySnapshot = snapshotChanges(app);
    let operations = [];
    let dirtyState = captureDirtySyncState(revisionAtStart);
    try {
      const operationSnapshot = captureOperationSnapshot(revisionAtStart, "sync-checkpoint");
      assertCompleteOperationSnapshot(operationSnapshot, "sync checkpoint");
      operations = operationSnapshot.operations;
      dirtyState = operationSnapshot.dirtyState;
      if (
        isDirty(app) && !operations.length &&
        !settleEmptyDirtyRevision(operationSnapshot, revisionAtStart, app)
      ) {
        throw new Error("The current PDF edits have no lossless annotation operation payload.");
      }
      if (app.pdfThumbnailViewer?.hasStructuralChanges?.()) {
        throw new Error("Page reordering cannot be synchronized while the PDF source is immutable.");
      }
      if (
        state.disposed ||
        state.activeDocumentId !== documentId ||
        state.activeOpenRequest !== openRequest ||
        app.pdfDocument !== pdfDocument ||
        state.revision !== revisionAtStart
      ) {
        throw new Error("The annotation state changed while creating the sync checkpoint.");
      }
    } catch (caught) {
      if (app.pdfDocument === pdfDocument) {
        restoreChanges(app, {
          hadAnnotationChanges:
            dirtySnapshot.hadAnnotationChanges ||
            state.dirty ||
            state.revision !== revisionAtStart,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
      }
      return postSyncCheckpointRejected(message, caught?.message || "checkpoint-failed");
    }
    const fields = {
      id: message.id,
      documentId,
      openRequest,
      revision: revisionAtStart,
      confirmedRevision: state.confirmedRevision,
      dirty: isDirty(),
      ok: true,
      operations,
      dirtyState,
      actorId: state.syncActorId,
      viewState: captureSyncViewState(app),
    };
    const posted = postToHost("sync-checkpoint-ready", fields);
    if (!posted) {
      postSyncCheckpointRejected(message, "checkpoint-message-failed");
    }
    return posted;
  }

  function handleSyncCheckpoint(message) {
    if (!validSyncRequest(message)) {
      return;
    }
    if (state.syncCheckpointRequests.has(message.id)) {
      postSyncCheckpointRejected(message, "duplicate-request-id");
      return;
    }
    if (
      state.activeDocumentId !== message.documentId ||
      state.activeOpenRequest !== message.openRequest ||
      !state.app?.pdfDocument
    ) {
      postSyncCheckpointRejected(message, "document-session-changed");
      return;
    }
    if (state.syncApplyControl) {
      postSyncCheckpointRejected(message, "sync-apply-prepared");
      return;
    }
    state.syncCheckpointRequests.add(message.id);
    const operation = serializeSyncCheckpoint(message);
    state.syncCheckpointPromise = operation;
    void operation
      .catch((error) => {
        postSyncCheckpointRejected(message, error?.message || "checkpoint-failed");
      })
      .finally(() => {
      state.syncCheckpointInProgress = false;
      state.syncCheckpointRequests.delete(message.id);
      if (state.syncCheckpointPromise === operation) {
        state.syncCheckpointPromise = null;
      }
      if (
        !state.disposed &&
        state.autoSaveEnabled &&
        !state.autoSavePaused &&
        isDirty()
      ) {
        scheduleAutoSave();
      }
      runQueuedManualSave();
    });
  }

  function postSyncApplyRejected(message, reason) {
    return postToHost("sync-apply-rejected", {
      id: message.id,
      documentId: message.documentId,
      openRequest: Number.isSafeInteger(message.previousOpenRequest)
        ? message.previousOpenRequest
        : state.activeOpenRequest,
      previousOpenRequest: message.previousOpenRequest,
      newOpenRequest: message.newOpenRequest,
      revision: state.revision,
      ok: false,
      prepared: false,
      reason: String(reason || "apply-rejected"),
    });
  }

  function setSyncApplyInert(control) {
    if (state.syncApplyControl !== control || control.cancelled) {
      return false;
    }
    const element = state.app?.appConfig?.appContainer;
    if (!element) {
      return false;
    }
    const wasInert = element.hasAttribute("inert");
    state.syncApplyInertState = { element, wasInert };
    if (!wasInert) {
      element.setAttribute("inert", "");
    }
    control.phase = "prepared";
    return true;
  }

  function clearSyncApplyControl(control = state.syncApplyControl) {
    if (!control || state.syncApplyControl !== control) {
      return false;
    }
    control.cancelled = true;
    if (state.syncApplyInertState) {
      const { element, wasInert } = state.syncApplyInertState;
      if (!wasInert) {
        element.removeAttribute("inert");
      }
      state.syncApplyInertState = null;
    }
    state.syncApplyControl = null;
    if (
      state.autoSaveEnabled &&
      !state.autoSavePaused &&
      isDirty()
    ) {
      scheduleAutoSave();
    }
    return true;
  }

  function startSyncApplySessionClose(control, session, app) {
    if (
      !app ||
      !session ||
      state.syncApplyControl !== control ||
      control.applyingSession !== session ||
      typeof app.close !== "function"
    ) {
      return Promise.resolve(null);
    }
    const currentTask = app.pdfLoadingTask;
    const currentDocument = app.pdfDocument;
    if (
      currentTask &&
      currentTask !== session.previousLoadingTask &&
      !session.loadingTask
    ) {
      session.loadingTask = currentTask;
    }
    const taskMatchesSession = session.loadingTask
      ? currentTask === session.loadingTask
      : currentTask === session.previousLoadingTask ||
        (!!currentTask && currentTask !== session.previousLoadingTask);
    if (!taskMatchesSession && currentTask) {
      return Promise.resolve(null);
    }
    if (!currentTask && !currentDocument) {
      return Promise.resolve(null);
    }
    try {
      // Call close immediately so PDF.js destroys the current loading task
      // before cancellation waits on an open promise that may still be parsing.
      return Promise.resolve(app.close()).then(() => {
        if (currentTask) {
          control.destroyedTasks.add(currentTask);
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function syncApplySessionTasks(session, app) {
    const tasks = new Set(
      [session?.previousLoadingTask, session?.loadingTask, app?.pdfLoadingTask]
        .filter(Boolean),
    );
    if (
      app?.pdfLoadingTask &&
      app.pdfLoadingTask !== session?.previousLoadingTask &&
      !session?.loadingTask
    ) {
      session.loadingTask = app.pdfLoadingTask;
      tasks.add(app.pdfLoadingTask);
    }
    return tasks;
  }

  function syncApplyHasLiveViewerReferences(app) {
    return !!(
      app?.pdfLoadingTask ||
      app?.pdfDocument ||
      app?.pdfViewer?.pdfDocument ||
      app?.pdfThumbnailViewer?.pdfDocument ||
      app?.pdfLinkService?.pdfDocument ||
      app?.pdfDocumentProperties?.pdfDocument
    );
  }

  async function clearSyncApplyViewerReferences(session, app, tasks) {
    const errors = [];
    const documents = new Set(
      [
        session?.previousPdfDocument,
        session?.pdfDocument,
        app?.pdfDocument,
        app?.pdfViewer?.pdfDocument,
        app?.pdfThumbnailViewer?.pdfDocument,
        app?.pdfLinkService?.pdfDocument,
        app?.pdfDocumentProperties?.pdfDocument,
      ].filter(Boolean),
    );
    const clearDocument = async (owner) => {
      if (!owner || !documents.has(owner.pdfDocument)) {
        return;
      }
      try {
        await owner.setDocument?.(null);
      } catch (error) {
        errors.push(error);
      }
    };
    const currentTask = app?.pdfLoadingTask;
    if (currentTask && tasks.has(currentTask)) {
      app.pdfLoadingTask = null;
    }
    if (app?.pdfDocument && documents.has(app.pdfDocument)) {
      app.pdfDocument = null;
    }
    await clearDocument(app?.pdfThumbnailViewer);
    await clearDocument(app?.pdfViewer);
    await clearDocument(app?.pdfLinkService);
    await clearDocument(app?.pdfDocumentProperties);
    return errors;
  }

  async function forceSyncApplySessionCleanup(control, session, app, errors) {
    const tasks = syncApplySessionTasks(session, app);
    for (const task of tasks) {
      if (control.destroyedTasks.has(task)) {
        continue;
      }
      if (typeof task.destroy !== "function") {
        errors.push(new Error("The PDF.js loading task cannot be destroyed."));
        continue;
      }
      try {
        await task.destroy();
        control.destroyedTasks.add(task);
      } catch (error) {
        errors.push(error);
      }
    }

    const closeViewer = state.pdfJsClose || app?.close;
    if (typeof closeViewer === "function") {
      const closingTask = app?.pdfLoadingTask;
      try {
        await closeViewer.call(app);
        if (closingTask) {
          control.destroyedTasks.add(closingTask);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    errors.push(...await clearSyncApplyViewerReferences(session, app, tasks));

    const allTasksDestroyed = [...syncApplySessionTasks(session, app)].every(
      (task) => control.destroyedTasks.has(task),
    );
    return {
      stopped: allTasksDestroyed && !syncApplyHasLiveViewerReferences(app),
      tasks,
    };
  }

  function markSyncApplyCancellationError(reason) {
    state.autoSavePaused = true;
    state.readOnly = true;
    setReadOnlyState(true);
    const message = reason
      ? `Sync refresh cleanup needed recovery: ${reason}. The recovery copy is preserved; reopen this PDF.`
      : "Sync refresh cleanup failed. The recovery copy is preserved; close and reopen this PDF.";
    showStatus(message);
  }

  function cancelSyncApply(control) {
    if (control.cancelPromise) {
      return control.cancelPromise;
    }
    control.cancelRequested = true;
    control.destroyedTasks = new Set();
    const session = control.applyingSession;
    const app = state.app;
    session?.controller.abort();

    // Start stopping the active PDF.js task before awaiting the open promise.
    const firstClose = startSyncApplySessionClose(control, session, app);
    const openSettled = session?.pdfJsOpenPromise
      ? Promise.resolve(session.pdfJsOpenPromise).then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error }),
        )
      : Promise.resolve({ ok: true });
    control.cancelPromise = (async () => {
      const errors = [];
      let cleanupFallback = false;
      try {
        await firstClose;
      } catch (error) {
        errors.push(error);
        cleanupFallback = true;
        await forceSyncApplySessionCleanup(control, session, app, errors);
      }
      let openDone = false;
      void openSettled.then(() => {
        openDone = true;
      });
      while (!openDone && session && state.syncApplyControl === control) {
        const currentTask = app?.pdfLoadingTask;
        if (
          currentTask &&
          currentTask !== session.previousLoadingTask
        ) {
          try {
            // PDFViewerApplication.open may have been waiting for the previous
            // document's close when cancellation began. Close again as soon as
            // its replacement task appears, before waiting for that parse.
            await startSyncApplySessionClose(control, session, app);
          } catch (error) {
            errors.push(error);
            cleanupFallback = true;
            await forceSyncApplySessionCleanup(control, session, app, errors);
          }
        }
        if (!openDone) {
          await Promise.race([
            openSettled.then(() => {
              openDone = true;
            }),
            new Promise((resolve) => setTimeout(resolve, 10)),
          ]);
        }
      }
      const openResult = await openSettled;
      if (
        openResult.ok &&
        session?.previousLoadingTask &&
        session.pdfJsOpenPromise
      ) {
        control.destroyedTasks.add(session.previousLoadingTask);
      }
      try {
        await control.openDocumentPromise;
      } catch {
        // openDocument reports the cancellation through its settled result.
      }
      try {
        await startSyncApplySessionClose(control, session, app);
      } catch (error) {
        errors.push(error);
        cleanupFallback = true;
      }
      if (syncApplyHasLiveViewerReferences(app)) {
        cleanupFallback = true;
      }
      const cleanup = await forceSyncApplySessionCleanup(
        control,
        session,
        app,
        errors,
      );
      if (!cleanup.stopped) {
        const reason = String(errors[0]?.message || errors[0] || "pdf-close-failed");
        markSyncApplyCancellationError(reason);
        return { ok: false, reason };
      }
      if (cleanupFallback || errors.length > 0) {
        const reason = String(errors[0]?.message || errors[0] || "pdf-close-fallback");
        markSyncApplyCancellationError(reason);
        return { ok: true, cleanupFallback: true, reason };
      }
      return {
        ok: true,
        cleanupFallback: false,
      };
    })();
    return control.cancelPromise;
  }

  async function handleSyncApplyCancel(message) {
    const control = state.syncApplyControl;
    if (
      message.rendererGeneration !== rendererGeneration ||
      !control ||
      control.id !== message.id ||
      control.documentId !== message.documentId ||
      control.openRequest !== message.openRequest
    ) {
      return;
    }
    if (control.phase !== "applying") {
      clearSyncApplyControl(control);
      postToHost("sync-apply-cancelled", {
        id: control.id,
        documentId: control.documentId,
        openRequest: control.openRequest,
        ok: true,
      });
      return;
    }
    let result;
    try {
      result = await cancelSyncApply(control);
    } catch (error) {
      result = {
        ok: false,
        reason: String(error?.message || error || "PDF.js cleanup failed."),
      };
      markSyncApplyCancellationError(result.reason);
    }
    if (result.ok) {
      clearSyncApplyControl(control);
      postToHost("sync-apply-cancelled", {
        id: control.id,
        documentId: control.documentId,
        openRequest: control.openRequest,
        ok: true,
        ...(result.cleanupFallback ? { cleanupFallback: true } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
    } else {
      postToHost("sync-apply-cancel-failed", {
        id: control.id,
        documentId: control.documentId,
        openRequest: control.openRequest,
        ok: false,
        reason: result.reason || "PDF.js is still active.",
      });
    }
  }

  function postSyncApplyPrepared(control, ok, reason = null) {
    const fields = {
      id: control.id,
      documentId: control.documentId,
      openRequest: control.openRequest,
      revision: state.revision,
      ok,
      prepared: ok,
      ...(reason ? { reason } : {}),
    };
    postToHost(ok ? "sync-apply-prepared" : "sync-apply-rejected", fields);
  }

  function handleSyncApplyPrepare(message) {
    if (!validSyncRequest(message)) return;
    postSyncApplyPrepared(
      {
        id: message.id,
        documentId: message.documentId,
        openRequest: message.openRequest,
      },
      false,
      "immutable-source-annotations-only",
    );
  }

  function applySyncSnapshot(message) {
    if (message?.rendererGeneration !== rendererGeneration) return;
    const control = state.syncApplyControl;
    if (control?.id === message.id) clearSyncApplyControl(control);
    postSyncApplyRejected(message, "immutable-source-annotations-only");
  }

  function waitForInputBoundary(timeoutMs = 110000, closeControl = null) {
    if (!isEditBoundaryBusy()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {
        closeControl,
        resolve,
        timer: setTimeout(() => {
          const index = state.inputBoundaryWaiters.indexOf(waiter);
          if (index >= 0) {
            state.inputBoundaryWaiters.splice(index, 1);
            resolve(false);
          }
        }, timeoutMs),
      };
      state.inputBoundaryWaiters.push(waiter);
    });
  }

  function resolveInputBoundaryWaiters(result, closeControl = null) {
    const remaining = [];
    for (const waiter of state.inputBoundaryWaiters) {
      if (closeControl && waiter.closeControl !== closeControl) {
        remaining.push(waiter);
        continue;
      }
      if (result && isEditBoundaryBusy()) {
        remaining.push(waiter);
        continue;
      }
      clearTimeout(waiter.timer);
      waiter.resolve(result);
    }
    state.inputBoundaryWaiters = remaining;
    if (result) {
      schedulePendingExternalAnnotationUpdate();
      runAnnotationObserver("input.boundary", () => state.annotationController?.notifyInputBoundary?.());
    }
  }

  function closeControlMatches(control, message) {
    return !!(
      control &&
      message &&
      control.id === message.id &&
      control.documentId === message.documentId &&
      control.openRequest ===
        (Number.isInteger(message.openRequest) ? message.openRequest : null)
    );
  }

  function setCloseInputInert(control) {
    if (state.closeControl !== control || control.cancelled) {
      return false;
    }
    const element = state.app?.appConfig?.appContainer;
    if (element && !state.closeInertState) {
      const wasInert = element.hasAttribute("inert");
      state.closeInertState = { element, wasInert };
      if (!wasInert) {
        element.setAttribute("inert", "");
      }
    }
    control.phase = "frozen";
    return true;
  }

  function clearCloseControl(control = state.closeControl, { resume = true } = {}) {
    if (!control || state.closeControl !== control) {
      return false;
    }
    control.cancelled = true;
    if (state.closeInertState) {
      const { element, wasInert } = state.closeInertState;
      if (!wasInert) {
        element.removeAttribute("inert");
      }
      state.closeInertState = null;
    }
    state.closeControl = null;
    resolveInputBoundaryWaiters(false, control);
    if (
      resume &&
      !state.disposed &&
      state.autoSaveEnabled &&
      !state.autoSavePaused &&
      isDirty()
    ) {
      scheduleAutoSave();
    }
    return true;
  }

  function commitFocusedFreeText() {
    if (!state.freeTextFocused || isInputBusy()) {
      return false;
    }
    state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.commitOrRemove?.();
    document.activeElement?.blur?.();
    state.freeTextFocused = isFreeTextTarget(document.activeElement);
    state.freeTextCommittedForSave = false;
    state.freeTextInputPending = false;
    return !state.freeTextFocused;
  }

  function prepareContentForSave({
    commitFreeText = false,
    commitEditors = false,
  } = {}) {
    const manager =
      state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    manager?.currentLayer?.endDrawingSession?.(false);
    const active = manager?.getActive?.();
    if (
      commitFreeText &&
      state.freeTextCommitReady &&
      state.freeTextInputPending &&
      active?.commitForSave
    ) {
      state.preparingContentForSave = true;
      try {
        active.commitForSave();
      } finally {
        state.preparingContentForSave = false;
      }
      state.freeTextInputPending = false;
      state.freeTextCommittedForSave =
        state.freeTextFocused && isFreeTextTarget(document.activeElement);
      resolveInputBoundaryWaiters(true);
      return true;
    }
    if (commitEditors) {
      manager?.commitOrRemove?.();
    }
    return false;
  }

  function isFreeTextTarget(target) {
    return (
      target instanceof Element &&
      !!target.closest(
        ".freeTextEditor .internal[contenteditable='true'], .freeTextEditor [role='textbox']",
      )
    );
  }

  function isFreeTextEditorContainer(target) {
    return target instanceof Element && !!target.closest(".freeTextEditor");
  }

  function restoreExternalFreeTextFocus(event, session) {
    const editor = session?.editorElement;
    const target = session?.relatedTarget;
    if (
      !event.isTrusted ||
      !session?.sourceWasEditableInternal ||
      event.target !== session.sourceTarget ||
      event.relatedTarget !== target ||
      state.disposed ||
      state.activeDocumentId !== session.documentId ||
      state.activeOpenRequest !== session.openRequest ||
      state.freeTextFocusGeneration !== session.focusGeneration ||
      state.app !== session.app ||
      state.app?.pdfDocument !== session.pdfDocument ||
      rendererGeneration !== session.rendererGeneration ||
      state.app?.pdfViewer?.getPageView?.(session.pageIndex) !==
        session.pageView ||
      session.pageView?.annotationEditorLayer?.annotationEditorLayer !==
        session.editorLayer ||
      !editor ||
      !editor.isConnected ||
      !editor.contains(session.sourceTarget) ||
      session.sourceTarget.ownerDocument !== document ||
      !session.pdfEditor ||
      session.pdfEditor.editorType !== "freetext" ||
      session.pdfEditor.div !== editor ||
      session.pdfEditor.parent !== session.editorLayer ||
      session.pdfEditor.pageIndex !== session.pageIndex ||
      !(target instanceof HTMLElement) ||
      target.ownerDocument !== document ||
      !target.isConnected ||
      editor.contains(target) ||
      target.matches(":disabled, [hidden]") ||
      target.closest("[hidden]") ||
      !(target.tabIndex >= 0 || target.matches("button,input,select,textarea,a[href]")) ||
      !document.hasFocus() ||
      state.isComposing ||
      state.compositionEndPending ||
      !editor.contains(document.activeElement)
    ) {
      return false;
    }
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  }

  function captureExternalFreeTextFocusSession(event, focusGeneration) {
    const sourceTarget = event.target;
    if (
      !isFreeTextTarget(sourceTarget) ||
      !(sourceTarget instanceof HTMLElement) ||
      !sourceTarget.matches(".internal[contenteditable='true']")
    ) {
      return null;
    }
    const editorElement = sourceTarget.closest(".freeTextEditor");
    const pageNumber = Number(
      editorElement?.closest(".page")?.dataset.pageNumber,
    );
    const pageIndex = Number.isInteger(pageNumber) ? pageNumber - 1 : -1;
    const app = state.app;
    const pageView = pageIndex >= 0
      ? app?.pdfViewer?.getPageView?.(pageIndex)
      : null;
    const editorLayer =
      pageView?.annotationEditorLayer?.annotationEditorLayer;
    const pdfEditor = app?.pdfViewer?._layerProperties
      ?.annotationEditorUIManager?.getEditor?.(editorElement?.id);
    return {
      documentId: state.activeDocumentId,
      openRequest: state.activeOpenRequest,
      rendererGeneration,
      app,
      pdfDocument: app?.pdfDocument,
      pageIndex,
      pageView,
      editorLayer,
      pdfEditor,
      editorElement,
      sourceTarget,
      sourceWasEditableInternal: true,
      relatedTarget: event.relatedTarget,
      focusGeneration,
    };
  }

  function clearAutoSaveTimer() {
    clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = null;
  }

  function autoSaveMinimumIntervalMs() {
    if (!iosInputPolicy) {
      return 0;
    }
    return Math.min(
      IOS_AUTO_SAVE_MAX_INTERVAL_MS,
      Math.max(
        IOS_AUTO_SAVE_MIN_INTERVAL_MS,
        IOS_AUTO_SAVE_MIN_INTERVAL_MS + state.lastAutoSaveDurationMs,
      ),
    );
  }

  function autoSaveDelayMs() {
    if (!iosInputPolicy || !Number.isFinite(state.lastAutoSaveStartedAt)) {
      return AUTO_SAVE_IDLE_DELAY_MS;
    }
    const cooldownRemaining =
      state.lastAutoSaveStartedAt + autoSaveMinimumIntervalMs() - Date.now();
    return Math.max(AUTO_SAVE_IDLE_DELAY_MS, cooldownRemaining);
  }

  function captureAutoSaveSession() {
    return {
      documentId: state.activeDocumentId,
      pdfDocument: state.app?.pdfDocument || null,
      openRequest: state.activeOpenRequest,
      revision: state.revision,
      rendererGeneration,
    };
  }

  function isAutoSaveSessionCurrent(session) {
    return !!(
      session &&
      !state.disposed &&
      session.documentId &&
      state.activeDocumentId === session.documentId &&
      state.app?.pdfDocument === session.pdfDocument &&
      state.activeOpenRequest === session.openRequest &&
      state.revision === session.revision &&
      rendererGeneration === session.rendererGeneration
    );
  }

  function rearmPendingFreeTextAutoSave(session) {
    if (
      !isAutoSaveSessionCurrent(session) ||
      !state.autoSaveEnabled ||
      state.autoSavePaused ||
      !state.freeTextFocused ||
      !state.freeTextInputPending ||
      state.freeTextCommittedForSave
    ) {
      return false;
    }
    // Reuse the regular debounce so composition and pointer activity keep
    // deferring the commit. Its timer is bound to this old document session.
    return scheduleAutoSave();
  }

  function recordAnnotationTrackingFailure(phase, error) {
    // An observer must never unwind through PDF.js's commit/cleanup stack.
    // This does not acknowledge or discard edits: the save/recovery boundary
    // still captures and validates every row again, including tombstones.
    state.dirty = true;
    state.autoSavePending = true;
    state.lastRecoveredDocumentId = null;
    state.lastRecoveredRevision = null;
    state.lastCloseWritebackAck = null;
    const previous = state.annotationTrackingFailure;
    const message = String(error?.message || error);
    state.annotationTrackingFailure = {
      phase, message, code: error?.code || null, revision: state.revision,
      count: previous?.phase === phase && previous?.message === message ? previous.count + 1 : 1,
    };
    if (state.annotationTrackingFailure.count === 1) {
      try { runtimeLogRecord("annotation-operation.observer-error", {
        phase, error: runtimeLogError(error),
      }); } catch { /* Diagnostics cannot interrupt editor cleanup either. */ }
    }
  }

  function runAnnotationObserver(phase, observe) {
    try { return observe(); }
    catch (error) {
      recordAnnotationTrackingFailure(phase, error);
      return undefined;
    }
  }

  function failAnnotationPreparation(phase, error) {
    recordAnnotationTrackingFailure(phase, error);
    state.autoSavePaused = true;
    clearAutoSaveTimer();
    try { sendError(error?.message || "Could not commit the current annotation.", {
      documentId: state.activeDocumentId, code: "annotation-editor-commit-failed",
    }); } catch { /* Keep the dirty state even if the host is unavailable. */ }
    return false;
  }

  function rememberAnnotationEditorIdentity(editor, { deletingNative = false } = {}) {
    if (state.hydratingExternalAnnotations || !editor || typeof editor.id !== "string" || !editor.id ||
        !Number.isSafeInteger(editor.pageIndex) || editor.pageIndex < 0) return;
    const kind = normalizeSyncKind(editor.editorType);
    if (!EXTERNAL_ANNOTATION_KINDS.has(kind)) return;
    const runtimeId = editor.id;
    const reference = canonicalPdfAnnotationRef(editor.annotationElementId);
    const referenceKey = pdfAnnotationRefKey(reference);
    const identity = referenceKey && state.syncState?.identities?.find(candidate =>
      pdfAnnotationRefKey(candidate?.ref) === referenceKey);
    let uuid = state.annotationUuidByRuntimeId.get(runtimeId) ||
      (referenceKey && state.annotationUuidByPdfRef.get(referenceKey)) || identity?.uuid;
    if (!uuid && referenceKey && deletingNative && state.externalSourceConfirmed && state.activeDocumentId) {
      uuid = `embedded-v1:${state.activeDocumentId}:${editor.pageIndex}:${reference}`;
    }
    if (uuid) {
      const externalOwner = state.externalAnnotationRows?.get(uuid)?.deleted === false || state.externalAnnotationHydration?.has(uuid);
      const previousProvenance = state.annotationProvenanceByUuid.get(uuid);
      state.annotationProvenanceByUuid.set(uuid, externalOwner ? "external" : previousProvenance ||
        (identity || referenceKey && deletingNative ? "embedded" : "external"));
    }
    // Native editor registration can precede the source-identity handshake.
    // Only genuinely new, reference-free editors may allocate a UUID here.
    if (!uuid && (referenceKey || editor.deleted)) return;
    uuid ||= makeSyncUuid();
    state.annotationUuidByRuntimeId.set(runtimeId, uuid);
    state.annotationRuntimeBindings ||= new Map();
    state.annotationRuntimeBindings.set(runtimeId, { uuid, kind, pageIndex: editor.pageIndex });
    if (reference) {
      state.annotationRefByRuntimeId.set(runtimeId, reference);
      state.annotationUuidByPdfRef.set(referenceKey, uuid);
    }
  }

  function noteMutation({ schedule = true } = {}) {
    if (!state.activeDocumentId || state.disposed || state.hydratingExternalAnnotations) {
      return;
    }
    state.revision += 1;
    state.dirty = true;
    state.lastRecoveredDocumentId = null;
    state.lastRecoveredRevision = null;
    state.lastCloseWritebackAck = null;
    runAnnotationObserver("mutation.capture", () => refreshAnnotationOperations(state.revision));
    state.annotationSidebarController?.refreshIfOpen();
    const app = state.app;
    if (app) {
      app._annotationStorageModified = true;
      runAnnotationObserver("mutation.controls", () => {
        app._updateOverwriteOriginalState?.();
        app.setTitle?.();
      });
    }
    runAnnotationObserver("mutation.controls", () => syncBridgeControls());
    if (
      schedule &&
      !state.committingInkForSave &&
      !state.preparingContentForSave
    ) {
      runAnnotationObserver("mutation.schedule", () => scheduleAutoSave());
    }
  }

  function scheduleAutoSave() {
    if (state.disposed) {
      return false;
    }
    state.autoSavePending = true;
    clearAutoSaveTimer();
    if (
      !state.autoSaveEnabled ||
      state.autoSavePaused ||
      state.closeControl ||
      !state.activeDocumentId ||
      state.readOnly ||
      state.syncCheckpointInProgress ||
      state.syncApplyControl ||
      state.isComposing ||
      hasActivePointerInteraction()
    ) {
      return;
    }
    if (state.savePromise) {
      // Preserve only the dirty state while a save is active. The settled
      // flight re-enters the idle debounce with the latest revision.
      if (state.freeTextFocused && state.freeTextInputPending) {
        const session = captureAutoSaveSession();
        state.autoSaveTimer = setTimeout(() => {
          state.autoSaveTimer = null;
          if (
            !isAutoSaveSessionCurrent(session) ||
            !state.autoSaveEnabled ||
            state.autoSavePaused ||
            state.closeControl ||
            state.isComposing ||
            hasActivePointerInteraction()
          ) {
            return;
          }
          if (state.savePromise) {
            if (state.freeTextFocused && state.freeTextInputPending) {
              state.freeTextCommitReady = true;
              try {
                prepareContentForSave({ commitFreeText: true });
              } catch (error) {
                failAnnotationPreparation("autosave.in-flight-prepare", error);
              } finally {
                state.freeTextCommitReady = false;
              }
            }
            state.autoSavePending = true;
            return;
          }
          void runAutoSaveAfterIdle(session);
        }, AUTO_SAVE_IDLE_DELAY_MS);
      }
      return;
    }
    const session = captureAutoSaveSession();
    state.autoSaveTimer = setTimeout(() => {
      state.autoSaveTimer = null;
      if (
        !isAutoSaveSessionCurrent(session) ||
        state.isComposing ||
        hasActivePointerInteraction()
      ) {
        return;
      }
      if (state.savePromise) {
        state.autoSavePending = true;
        return;
      }
      void runAutoSaveAfterIdle(session);
    }, autoSaveDelayMs());
  }

  async function runAutoSaveAfterIdle(session) {
    const app = state.app;
    if (
      !isAutoSaveSessionCurrent(session) ||
      !state.autoSaveEnabled ||
      state.autoSavePaused ||
      state.closeControl ||
      state.syncCheckpointInProgress ||
      state.syncApplyControl ||
      !state.activeDocumentId ||
      state.readOnly ||
      isInputBusy()
    ) {
      return false;
    }
    if (state.savePromise) {
      state.autoSavePending = true;
      return false;
    }
    try {
      if (state.pendingInkCommit) {
        state.committingInkForSave = true;
        try {
          // Ink keeps a drawing session open across strokes. End an idle stroke
          // before serialization so the current path reaches AnnotationStorage.
          app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
          state.pendingInkCommit = false;
        } finally {
          state.committingInkForSave = false;
        }
      }
      state.freeTextCommitReady =
        state.freeTextFocused && state.freeTextInputPending;
      try {
        prepareContentForSave({ commitFreeText: true });
      } finally {
        state.freeTextCommitReady = false;
      }
    } catch (error) {
      return failAnnotationPreparation("autosave.prepare", error);
    }
    state.autoSavePending = false;
    if (!isDirty(app)) {
      return true;
    }
    return requestSave("auto");
  }

  function resolveManualSaveWaiters(result) {
    for (const resolve of state.manualSaveWaiters.splice(0)) {
      resolve(result);
    }
  }

  function runQueuedManualSave() {
    if (
      state.disposed ||
      !state.manualSaveQueued ||
      isInputBusy() ||
      (state.freeTextFocused && !state.manualCommitQueued)
    ) {
      return;
    }
    state.manualSaveQueued = false;
    clearAutoSaveTimer();
    setDeferredTimeout(() => {
      if (
        isInputBusy() ||
        (state.freeTextFocused && !state.manualCommitQueued)
      ) {
        state.manualSaveQueued = true;
        return;
      }
      try {
      if (state.manualCommitQueued) {
        state.manualCommitQueued = false;
        state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.commitOrRemove?.();
        if (state.freeTextFocused) {
          document.activeElement?.blur?.();
          state.freeTextFocused = isFreeTextTarget(document.activeElement);
        }
        state.freeTextCommittedForSave = false;
        state.freeTextInputPending = false;
      }
      if (state.pendingInkCommit) {
        state.committingInkForSave = true;
        try {
          state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
          state.pendingInkCommit = false;
        } finally {
          state.committingInkForSave = false;
        }
      }
      void requestSave("manual").then(resolveManualSaveWaiters, error => {
        failAnnotationPreparation("manual.prepare", error);
        resolveManualSaveWaiters(false);
      });
      } catch (error) {
        failAnnotationPreparation("manual.prepare", error);
        resolveManualSaveWaiters(false);
      }
    }, 0);
  }

  function deferManualSave({ commit = false } = {}) {
    if (state.disposed) {
      return Promise.resolve(false);
    }
    state.manualSaveQueued = true;
    state.manualCommitQueued ||= commit;
    return new Promise((resolve) => {
      state.manualSaveWaiters.push(resolve);
      runQueuedManualSave();
    });
  }

  function wrapMethod(target, name, wrapper, cleanups) {
    if (!target || typeof target[name] !== "function") {
      return;
    }
    const original = target[name];
    const wrapped = function (...args) {
      return wrapper.call(this, original, args);
    };
    target[name] = wrapped;
    cleanups.push(() => {
      if (target[name] === wrapped) {
        target[name] = original;
      }
    });
  }

  function makeSaveRequestId() {
    state.saveSequence += 1;
    return `save-${rendererGeneration || "legacy"}-${Date.now().toString(36)}-${state.saveSequence.toString(36)}`;
  }

  function makeRecoveryRequestId() {
    state.recoverySequence += 1;
    return `recovery-${rendererGeneration || "legacy"}-${Date.now().toString(36)}-${state.recoverySequence.toString(36)}`;
  }

  function makeHeavyLeaseRequestId() {
    state.heavyLeaseSequence += 1;
    return `heavy-${rendererGeneration || "legacy"}-${Date.now().toString(36)}-${state.heavyLeaseSequence.toString(36)}`;
  }

  function rememberCancelledHeavyLease(waiter) {
    state.cancelledHeavyLeaseRequests.set(waiter.id, {
      documentId: waiter.documentId,
      openRequest: waiter.openRequest,
      cancelledAt: Date.now(),
    });
    while (state.cancelledHeavyLeaseRequests.size > 128) {
      const oldestId = state.cancelledHeavyLeaseRequests.keys().next().value;
      state.cancelledHeavyLeaseRequests.delete(oldestId);
    }
  }

  function finishHeavyLeaseWaiter(waiter) {
    clearTimeout(waiter.timeout);
    state.heavyLeaseWaiters.delete(waiter.id);
  }

  function cancelHeavyLeaseWaiter(
    waiter,
    reason = "The PDF save lease request was cancelled.",
    { notifyHost = true, leaseTimeout = false } = {},
  ) {
    if (!waiter || state.heavyLeaseWaiters.get(waiter.id) !== waiter) {
      return false;
    }
    finishHeavyLeaseWaiter(waiter);
    rememberCancelledHeavyLease(waiter);
    if (notifyHost) {
      postToHost("heavy-cancel", {
        id: waiter.id,
        documentId: waiter.documentId,
        openRequest: waiter.openRequest,
      });
    }
    const error = new Error(reason);
    error.cancelled = true;
    if (leaseTimeout) {
      error.leaseTimeout = true;
      error.fromHost = true;
      error.code = "heavy-lease-timeout";
    }
    waiter.reject(error);
    return true;
  }

  function cancelPendingHeavyLeaseWaiters(
    reason = "The PDF view changed while waiting for a save lease.",
  ) {
    for (const waiter of [...state.heavyLeaseWaiters.values()]) {
      cancelHeavyLeaseWaiter(waiter, reason);
    }
  }

  function releaseHostHeavyLease(lease, documentId) {
    if (!lease?.leaseId) {
      return false;
    }
    const fields = {
      leaseId: lease.leaseId,
      ...(documentId ? { documentId } : {}),
    };
    if (!state.disposed) {
      return postToHost("heavy-release", fields);
    }
    try {
      window.parent.postMessage(
        { channel, type: "heavy-release", token, rendererGeneration, ...fields },
        "*",
      );
      return true;
    } catch (error) {
      console.error("PDF Reader bridge could not release its host save lease:", error);
      return false;
    }
  }

  function finishDisposedHeavyLeaseCleanup() {
    if (
      !state.disposed ||
      state.heavyLeaseWaiters.size > 0 ||
      state.cancelledHeavyLeaseRequests.size > 0
    ) {
      return false;
    }
    clearTimeout(state.heavyLeaseCleanupTimer);
    state.heavyLeaseCleanupTimer = null;
    window.removeEventListener("message", onHostMessage);
    return true;
  }

  function waitForHostHeavyLease({
    documentId,
    openRequest,
    timeoutMs = HEAVY_LEASE_TIMEOUT_MS,
  }) {
    if (!state.hostHeavyLeaseRequired) {
      return Promise.resolve(null);
    }
    const id = makeHeavyLeaseRequestId();
    return new Promise((resolve, reject) => {
      const waiter = {
        id,
        documentId,
        openRequest,
        resolve,
        reject,
        timeout: setTimeout(() => {
          cancelHeavyLeaseWaiter(
            waiter,
            "Timed out waiting for the Obsidian PDF save lease.",
            { leaseTimeout: true },
          );
        }, Math.max(0, Math.min(HEAVY_LEASE_TIMEOUT_MS, timeoutMs))),
      };
      state.heavyLeaseWaiters.set(id, waiter);
      if (
        !postToHost("heavy-acquire", {
          id,
          documentId,
          openRequest,
        })
      ) {
        finishHeavyLeaseWaiter(waiter);
        const error = new Error("Could not request the Obsidian PDF save lease.");
        error.fromHost = true;
        reject(error);
      }
    });
  }

  function waitForHostSave({
    documentId,
    requestId,
    revision,
    openRequest,
    operations,
    origin,
    heavyLeaseId,
  }) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (state.pendingSave?.requestId !== requestId) {
          return;
        }
        state.pendingSave = null;
        reject(new Error("Timed out waiting for Obsidian to save the PDF."));
      }, 120000);

      state.pendingSave = {
        documentId,
        requestId,
        revision,
        openRequest,
        operationCount: operations.length,
        resolve: (message) => {
          clearTimeout(timeout);
          state.pendingSave = null;
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          state.pendingSave = null;
          reject(error);
        },
      };

      if (
        !postToHost(
          "save",
          {
            documentId,
            openRequest,
            requestId,
            revision,
            origin,
            ...(heavyLeaseId ? { heavyLeaseId } : {}),
            operations,
          },
        )
      ) {
        clearTimeout(timeout);
        state.pendingSave = null;
        reject(new Error("Could not send the PDF to Obsidian for saving."));
      }
    });
  }

  function waitForHostRecovery({
    documentId,
    requestId,
    revision,
    timeoutMs,
    openRequest,
    operations,
    source,
    reason,
  }) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (state.pendingRecovery?.requestId !== requestId) {
          return;
        }
        state.pendingRecovery = null;
        reject(new Error("Timed out waiting for Obsidian to persist the annotation recovery batch."));
      }, timeoutMs);

      state.pendingRecovery = {
        documentId,
        requestId,
        revision,
        openRequest,
        operationCount: operations.length,
        resolve: (message) => {
          clearTimeout(timeout);
          state.pendingRecovery = null;
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timeout);
          state.pendingRecovery = null;
          reject(error);
        },
      };

      if (
        !postToHost(
          "recover",
          {
            documentId,
            openRequest,
            requestId,
            revision,
            reason,
            operations,
            source,
          },
        )
      ) {
        clearTimeout(timeout);
        state.pendingRecovery = null;
        reject(new Error("Could not send the annotation recovery batch to Obsidian."));
      }
    });
  }

  async function saveOneRevision(origin) {
    const app = state.app;
    const pdfDocument = app?.pdfDocument;
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    if (!app || !pdfDocument || !documentId) {
      return false;
    }
    if (state.externalSourceMismatch) {
      showStatus("PDF 来源已变化；普通保存已暂停，当前批注保留在恢复记录中。");
      return false;
    }
    if (!state.externalSourceConfirmed) {
      showStatus("正在核对 PDF 页面身份；核对完成前不会保存外置批注。");
      return false;
    }
    if (state.readOnly) {
      showStatus("This PDF is read-only.");
      return false;
    }

    const sessionIsCurrent = () =>
      !state.disposed &&
      state.app === app &&
      state.activeDocumentId === documentId &&
      state.activeOpenRequest === openRequest &&
      app.pdfDocument === pdfDocument;
    let revisionAtStart = null;
    let dirtySnapshot = null;
    let requestId = null;
    let saveStarted = false;
    let autoStartedAt = null;
    let heavyLease = null;
    const finishSavePhase = () => {
      if (!saveStarted) return;
      app._saveInProgress = false;
      app._updateOverwriteOriginalState?.();
      app.setTitle?.();
      saveStarted = false;
    };
    try {
      if (
        origin === "auto" &&
        (!state.autoSaveEnabled || state.autoSavePaused)
      ) {
        return false;
      }

      revisionAtStart = state.revision;
      dirtySnapshot = snapshotChanges(app);
      if (!isDirty(app)) {
        return true;
      }
      if (
        !sessionIsCurrent() || state.revision !== revisionAtStart ||
        isEditBoundaryBusy() || state.pendingInkCommit
      ) {
        if (sessionIsCurrent()) {
          restoreChanges(app, {
            hadAnnotationChanges: true,
            hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
          });
        }
        return sessionIsCurrent() ? SAVE_RETRY_AFTER_IDLE : false;
      }
      const operationSnapshot = captureOperationSnapshot(revisionAtStart, "save");
      assertCompleteOperationSnapshot(operationSnapshot, "current PDF");
      const operationsAtStart = operationSnapshot.operations;
      if (!operationsAtStart.length) {
        if (settleEmptyDirtyRevision(operationSnapshot, revisionAtStart, app)) {
          return true;
        }
        throw new Error("The current PDF edits have no lossless annotation operation payload.");
      }
      requestId = makeSaveRequestId();
      app._saveInProgress = true;
      saveStarted = true;
      app._updateOverwriteOriginalState?.();
      const hasStructuralChanges =
        app.pdfThumbnailViewer?.hasStructuralChanges?.() || false;
      if (hasStructuralChanges) {
        throw new Error(
          "Page reordering is unavailable in the Obsidian PDF viewer.",
        );
      }
      if (
        !sessionIsCurrent() ||
        state.revision !== revisionAtStart ||
        isEditBoundaryBusy() ||
        state.pendingInkCommit
      ) {
        if (sessionIsCurrent()) {
          restoreChanges(app, {
            hadAnnotationChanges: true,
            hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
          });
        }
        return sessionIsCurrent() ? SAVE_RETRY_AFTER_IDLE : false;
      }
      autoStartedAt = origin === "auto" ? Date.now() : null;
      if (autoStartedAt !== null) {
        state.lastAutoSaveStartedAt = autoStartedAt;
      }
      if (!sessionIsCurrent()) {
        return false;
      }

      heavyLease = await waitForHostHeavyLease({ documentId, openRequest });
      if (!sessionIsCurrent()) {
        return false;
      }
      if (
        state.revision !== revisionAtStart ||
        isEditBoundaryBusy() ||
        state.pendingInkCommit
      ) {
        restoreChanges(app, {
          hadAnnotationChanges: true,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
        return SAVE_RETRY_AFTER_IDLE;
      }

      if (
        origin === "auto" &&
        (!state.autoSaveEnabled || state.autoSavePaused)
      ) {
        // The setting may change while the host is durably writing this batch.
        state.dirty = true;
        restoreChanges(app, {
          hadAnnotationChanges: true,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
        return false;
      }
      await waitForHostSave({
        documentId,
        requestId,
        revision: revisionAtStart,
        openRequest,
        operations: operationsAtStart,
        origin,
        heavyLeaseId: heavyLease?.leaseId,
      });
      if (sessionIsCurrent()) {
        state.confirmedRevision = revisionAtStart;
        clearConfirmedDirtyState(revisionAtStart);
        schedulePendingExternalAnnotationUpdate();
        if (state.revision === revisionAtStart) {
          state.dirty = false;
          pdfDocument.annotationStorage?.resetModified?.();
          restoreChanges(app, {
            hadAnnotationChanges: false,
            hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
          });
        } else {
          state.dirty = true;
          restoreChanges(app, {
            hadAnnotationChanges: true,
            hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
          });
        }
      }
      return true;
    } catch (error) {
      if (!sessionIsCurrent() || error?.cancelled) {
        return false;
      }
      state.autoSavePaused = true;
      clearAutoSaveTimer();
      const failedSnapshot = dirtySnapshot || snapshotChanges(app);
      state.dirty = true;
      if (sessionIsCurrent()) {
        restoreChanges(app, {
          hadAnnotationChanges: true,
          hadStructuralChanges: failedSnapshot.hadStructuralChanges,
        });
      }
      if (!error?.fromHost) {
        sendError(error?.message || "Could not save the PDF.", {
          documentId,
          requestId,
          code: "save-failed",
        });
      } else {
        showStatus(error.message || "Obsidian could not save the PDF.");
      }
      return false;
    } finally {
      if (heavyLease) {
        releaseHostHeavyLease(heavyLease, documentId);
      }
      finishSavePhase();
      if (autoStartedAt !== null) {
        state.lastAutoSaveDurationMs = Math.max(0, Date.now() - autoStartedAt);
      }
    }
  }

  async function runSaveSequence(origin) {
    const documentId = state.activeDocumentId;
    let lastResult = true;
    while (
      !state.disposed &&
      documentId &&
      state.activeDocumentId === documentId &&
      !state.closeControl &&
      isDirty()
    ) {
      if (
        origin === "auto" &&
        (!state.autoSaveEnabled || state.autoSavePaused)
      ) {
        return false;
      }
      if (isEditBoundaryBusy()) {
        const boundaryReached = await waitForInputBoundary();
        if (!boundaryReached || state.activeDocumentId !== documentId) {
          return false;
        }
        continue;
      }
      if (state.pendingInkCommit) {
        state.committingInkForSave = true;
        try {
          // A stroke can finish while an earlier Vault write is awaiting its
          // ACK. Commit it at this revision boundary before serializing again.
          state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager
            ?.currentLayer?.commitOrRemove?.();
          state.pendingInkCommit = false;
        } finally {
          state.committingInkForSave = false;
        }
      }
      lastResult = await saveOneRevision(origin);
      if (lastResult === SAVE_RETRY_AFTER_IDLE) {
        if (origin === "auto") {
          state.autoSavePending = true;
          return true;
        }
        continue;
      }
      if (!lastResult) {
        return false;
      }
      if (origin === "auto") {
        if (isDirty()) {
          state.autoSavePending = true;
        }
        return true;
      }
      if (!isDirty()) {
        return true;
      }
    }
    return lastResult;
  }

  async function runRecoverySequence(reason, deadline, { closeRecovery = false } = {}) {
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    if (
      !documentId || !state.app?.pdfDocument ||
      (state.readOnly && !state.externalSourceMismatch) ||
      (!state.externalSourceConfirmed && !state.externalSourceMismatch)
    ) {
      return false;
    }
    const app = state.app;
    const pdfDocument = app.pdfDocument;
    const sessionIsCurrent = () =>
      !state.disposed &&
      state.app === app &&
      state.activeDocumentId === documentId &&
      state.activeOpenRequest === openRequest &&
      app.pdfDocument === pdfDocument;
    while (
      sessionIsCurrent() &&
      isDirty()
    ) {
      if (state.freeTextFocused && !isInputBusy()) {
        app.pdfViewer?._layerProperties?.annotationEditorUIManager?.commitOrRemove?.();
        document.activeElement?.blur?.();
        state.freeTextFocused = isFreeTextTarget(document.activeElement);
      }
      if (isEditBoundaryBusy()) {
        const boundaryReached = await waitForInputBoundary(
          Math.max(0, deadline - Date.now()),
        );
        if (!boundaryReached) {
          return false;
        }
        continue;
      }
      if (state.pendingInkCommit) {
        state.committingInkForSave = true;
        try {
          app.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
          state.pendingInkCommit = false;
        } finally {
          state.committingInkForSave = false;
        }
      }

      const revisionAtStart = state.revision;
      const operationSnapshot = captureOperationSnapshot(revisionAtStart, "recovery");
      assertCompleteOperationSnapshot(operationSnapshot, "recovery");
      const operationsAtStart = operationSnapshot.operations;
      if (!operationsAtStart.length) {
        if (settleEmptyDirtyRevision(operationSnapshot, revisionAtStart, app)) {
          return true;
        }
        throw new Error("The current PDF edits have no lossless recovery operation payload.");
      }
      const dirtySnapshot = snapshotChanges(app);
      const source = recoverySourceIdentity();
      let saveStarted = false;
      try {
        const timeoutMs = Math.max(0, deadline - Date.now());
        if (!timeoutMs) {
          return false;
        }
        if (app.pdfThumbnailViewer?.hasStructuralChanges?.()) {
          throw new Error("Page reordering cannot be included while the PDF source is immutable.");
        }
        if (
          !sessionIsCurrent() || state.revision !== revisionAtStart ||
          isEditBoundaryBusy() || state.pendingInkCommit
        ) continue;
        app._saveInProgress = true;
        saveStarted = true;
        app._updateOverwriteOriginalState?.();
        const requestId = makeRecoveryRequestId();
        const recoveryAck = await waitForHostRecovery({
          documentId,
          requestId,
          revision: revisionAtStart,
          timeoutMs,
          openRequest: state.activeOpenRequest,
          operations: operationsAtStart,
          source,
          reason,
        });
        if (!sessionIsCurrent()) return false;
        if (recoveryAck?.ok !== true) {
          throw new Error(recoveryAck?.message || "Obsidian did not confirm the external recovery batch.");
        }
        if (
          state.revision === revisionAtStart &&
          !isEditBoundaryBusy() &&
          !state.pendingInkCommit
        ) {
          state.confirmedRevision = revisionAtStart;
          clearConfirmedDirtyState(revisionAtStart);
          schedulePendingExternalAnnotationUpdate();
          state.dirty = false;
          pdfDocument.annotationStorage?.resetModified?.();
          restoreChanges(app, {
            hadAnnotationChanges: false,
            hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
          });
          state.lastRecoveredDocumentId = documentId;
          state.lastRecoveredRevision = revisionAtStart;
          state.lastCloseWritebackAck = {
            documentId,
            openRequest,
            revision: revisionAtStart,
            queued: false,
            durable: true,
          };
          return true;
        }
      } catch (error) {
        if (!sessionIsCurrent() || error?.cancelled) {
          return false;
        }
        state.dirty = true;
        restoreChanges(app, {
          hadAnnotationChanges: true,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
        showStatus(error?.message || "Could not save the annotation recovery batch.");
        return false;
      } finally {
        if (saveStarted) {
          app._saveInProgress = false;
          app._updateOverwriteOriginalState?.();
          app.setTitle?.();
        }
      }
    }
    return sessionIsCurrent() && !isDirty();
  }

  async function requestRecovery(reason, deadline, { closeRecovery = false } = {}) {
    if (state.disposed) {
      return false;
    }
    if (state.recoveryPromise) {
      const existing = state.recoveryPromise;
      if (!closeRecovery || state.recoveryCloseIntent === true) return existing;
      await existing;
      if (state.disposed) return false;
      return requestRecovery(reason, deadline, { closeRecovery });
    }
    state.recoveryCloseIntent = closeRecovery;
    state.recoveryPromise = runRecoverySequence(reason, deadline, { closeRecovery })
      .catch(error => failAnnotationPreparation("recovery.prepare", error)).finally(() => {
      state.recoveryPromise = null;
      state.recoveryCloseIntent = false;
    });
    return state.recoveryPromise;
  }

  async function requestSave(origin = "manual") {
    if (state.disposed) {
      return false;
    }
    origin = origin === "auto" ? "auto" : "manual";
    if (state.closeControl) return false;
    if (state.syncCheckpointPromise) {
      const checkpoint = state.syncCheckpointPromise;
      try {
        await checkpoint;
      } catch {
        // The checkpoint reply already reports its own failure.
      }
      if (state.disposed) {
        return false;
      }
      return requestSave(origin);
    }
    if (state.syncApplyControl) {
      return false;
    }
    if (
      origin === "manual" &&
      (isInputBusy() ||
        (state.freeTextFocused && !state.freeTextCommittedForSave))
    ) {
      return deferManualSave({ commit: true });
    }
    if (origin === "auto" && isInputBusy()) {
      return false;
    }
    if (origin === "auto" && state.autoSavePaused) {
      return false;
    }
    if (origin === "auto" && state.closeControl) {
      return false;
    }
    if (origin === "manual") {
      state.autoSavePaused = false;
      state.autoSavePending = false;
    }
    clearAutoSaveTimer();
    try { prepareContentForSave(); }
    catch (error) { return failAnnotationPreparation("save.prepare", error); }
    if (state.savePromise) {
      if (origin === "manual") {
        state.manualSaveRequestedDuringFlight = true;
      } else if (isDirty()) {
        state.autoSavePending = true;
      }
      const inFlight = state.savePromise;
      const result = await inFlight;
      if (
        origin === "manual" &&
        state.manualSaveRequestedDuringFlight
      ) {
        state.manualSaveRequestedDuringFlight = false;
        if (state.disposed) {
          return false;
        }
        return requestSave("manual");
      }
      state.manualSaveRequestedDuringFlight = false;
      return result;
    }
    if (origin === "manual" && state.pendingInkCommit) {
      state.committingInkForSave = true;
      try {
        state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
        state.pendingInkCommit = false;
      } catch (error) {
        return failAnnotationPreparation("save.ink-commit", error);
      } finally {
        state.committingInkForSave = false;
      }
    }
    state.savePromise = runSaveSequence(origin).catch(error =>
      failAnnotationPreparation("save.sequence", error),
    ).finally(() => {
      state.savePromise = null;
      if (!isDirty()) {
        state.autoSavePending = false;
      } else if (
        state.autoSavePending &&
        state.autoSaveEnabled &&
        !state.autoSavePaused &&
        !state.closeControl
      ) {
        scheduleAutoSave();
      }
    });
    return state.savePromise;
  }

  function cleanupStorageObserver() {
    state.storageCleanup?.();
    state.storageCleanup = null;
    state.editorManagerCleanup?.();
    state.editorManagerCleanup = null;
    state.accessibilityManagerCleanup?.();
    state.accessibilityManagerCleanup = null;
    state.accessibilityManagers = new WeakSet();
    state.accessibilityEditorLayers = new WeakSet();
    state.deferredAccessibilityMoves.clear();
  }

  function observeAnnotationStorage(storage) {
    cleanupStorageObserver();
    if (!storage) {
      return;
    }
    const previousOnModified = storage.onModified;
    const wrappedOnModified = () => {
      try { previousOnModified?.(); }
      finally { runAnnotationObserver("storage.modified", () => noteMutation()); }
    };
    storage.onModified = wrappedOnModified;
    const cleanups = [() => {
      if (storage.onModified === wrappedOnModified) {
        storage.onModified = previousOnModified;
      }
    }];

    // AnnotationStorage.remove and updateEditor don't call onModified in this
    // PDF.js snapshot. Observe them so deletion and comment updates advance the
    // same revision stream as ordinary setValue edits.
    wrapMethod(
      storage,
      "remove",
      (original, [key]) => {
        const existed = runAnnotationObserver("storage.remove-before", () => storage.has(key));
        const result = original.call(storage, key);
        if (existed !== false) {
          runAnnotationObserver("storage.remove", () => noteMutation());
        }
        return result;
      },
      cleanups,
    );
    wrapMethod(
      storage,
      "updateEditor",
      (original, args) => {
        const result = original.apply(storage, args);
        if (result) {
          runAnnotationObserver("storage.updateEditor", () => noteMutation());
        }
        return result;
      },
      cleanups,
    );
    state.storageCleanup = () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }

  function observeEditorManager(app) {
    const manager =
      app.pdfViewer?._layerProperties?.annotationEditorUIManager;
    if (!manager) {
      return;
    }
    const cleanups = [];

    // A NONE-mode click selects a saved Square and activates its tool. Without
    // the native editId flag, creation-priority CSS then makes that very object
    // unreachable for the next drag. Tool activation/new drawing has no editId
    // at this boundary and must keep the normal creation-priority behavior.
    wrapMethod(manager, "updateToolbar", (original, [options]) => {
      const selectSavedSquare = !state.readOnly && manager.getMode?.() === 0 &&
        options?.mode === 5 && typeof options.editId === "string" && options.editId.length > 0;
      return original.call(manager, selectSavedSquare
        ? { ...options, mustEnterInEditMode: true } : options);
    }, cleanups);

    // PDF.js's HighlightEditor keeps Selection.toString() in a private field,
    // then drops it from serialize(). Capture the exact selection before the
    // native handler empties it; addEditor associates it with the new runtime
    // ID before the existing addCommands mutation observer persists a row.
    wrapMethod(manager, "highlightSelection", (original, args) => {
      const selection = state.textSelectionController?.snapshot?.();
      const text = !selection?.isCollapsed && selection?.rangeCount === 1
        ? selection.text
        : null;
      const anchor = selection?.anchorNode;
      const anchorElement = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
      const textLayer = anchorElement?.closest?.(".textLayer");
      const pageRoot = textLayer?.closest?.(".page");
      const pageNumber = readerPageNumberForRoot(pageRoot);
      const pageIndex = Number.isSafeInteger(pageNumber) ? pageNumber - 1 : null;
      const isHighlightMode = Number(app.pdfViewer?.annotationEditorMode) === 9;
      const previousPending = state.pendingHighlightSelection;
      const pending = isHighlightMode && typeof text === "string" && text.trim() &&
        Number.isSafeInteger(pageIndex) && pageIndex >= 0
        ? { text, pageIndex, assigned: false }
        : null;
      if (pending) state.pendingHighlightSelection = pending;
      try {
        return original.apply(manager, args);
      } finally {
        if (pending && state.pendingHighlightSelection === pending) {
          state.pendingHighlightSelection = previousPending;
        }
      }
    }, cleanups);

    // A live editor can be removed before its first serializable snapshot.
    // Capture identity/type at registration, never manufacture an identity
    // later from a deleted placeholder or guess its geometry.
    wrapMethod(manager, "addEditor", (original, [editor]) => {
      const result = original.call(manager, editor);
      runAnnotationObserver("editor.identity", () => rememberAnnotationEditorIdentity(editor));
      const pendingSelection = state.pendingHighlightSelection;
      const runtimeId = String(editor?.id ?? "");
      if (pendingSelection?.text && !pendingSelection.assigned &&
          normalizeSyncKind(editor?.editorType) === "Highlight" &&
          editor?.pageIndex === pendingSelection.pageIndex && runtimeId) {
        state.annotationTargetTextByRuntimeId.set(runtimeId, pendingSelection.text);
        pendingSelection.assigned = true;
      }
      return result;
    }, cleanups);

    // Commands represent completed model edits (including moves, resizes,
    // parameter changes and drawing steps). UI state events also report focus
    // and selection, so they aren't used as a mutation signal.
    wrapMethod(
      manager,
      "addCommands",
      (original, args) => {
        const result = original.apply(manager, args);
        if (args[0]) {
          runAnnotationObserver("editor.commands", () => {
            noteMutation();
            scheduleFreeTextGeometryRefresh(app);
          });
        }
        return result;
      },
      cleanups,
    );
    for (const methodName of ["undo", "redo"]) {
      wrapMethod(
        manager,
        methodName,
        (original, args) => {
          const direction = methodName;
          const revisionBefore = state.revision;
          const beforeState = runAnnotationObserver("history.before", () => ({
            rows: getAnnotationStorageRows(app, { includeLiveEditors: true }),
            history: captureSavedEditorHistory(manager, direction),
            freeText: snapshotSavedFreeTextEditors(manager, app),
            sidecar: liveSidecarFreeTextEditors(manager, app),
          }));
          const result = original.apply(manager, args);
          if (!beforeState) {
            noteMutation();
            return result;
          }
          runAnnotationObserver("history.after", () => {
            const { rows: annotationRowsBefore, history: savedEditorHistory, freeText: before, sidecar: sidecarBefore } = beforeState;
            showRestoredSidecarFreeTextEditors(manager, app, sidecarBefore);
            const changedEditors = changedSavedFreeTextEditors(
              manager,
              app,
              before,
            );
            const annotationRowsAfter = getAnnotationStorageRows(app, {
              includeLiveEditors: true,
            });
            const historyChanged = hasSavedEditorHistoryTransition(
              manager,
              direction,
              savedEditorHistory,
            );
            // PDF.js does not expose whether undo/redo consumed a command. Only
            // mark a new revision when the annotation model or saved-editor
            // history actually changed; a no-op command must not trap close in a
            // dirty state with an empty operation batch.
            if (
              state.revision === revisionBefore &&
              (annotationRowsChanged(annotationRowsBefore, annotationRowsAfter) ||
                changedEditors.length > 0 || historyChanged)
            ) {
              noteMutation();
            }
            reconcileSavedEditorHistory(manager, direction, savedEditorHistory);
            if (changedEditors.length > 0) {
              queueFreeTextAppearanceRepair(app, manager, changedEditors);
            }
          });
          return result;
        },
        cleanups,
      );
    }
    wrapMethod(
      manager,
      "removeEditor",
      (original, [editor]) => {
        const storage = app.pdfDocument?.annotationStorage;
        const changesDocument = runAnnotationObserver("editor.remove-before", () => !!(
          editor?.deleted ||
          (editor && storage?.has(editor.id)) ||
          editor?.hasBeenModified
        ));
        const result = original.call(manager, editor);
        runAnnotationObserver("editor.remove", () => {
          discardDeferredAccessibilityMove(editor);
          if (changesDocument !== false) noteMutation();
        });
        return result;
      },
      cleanups,
    );
    for (const methodName of [
      "addDeletedAnnotationElement",
      "removeDeletedAnnotationElement",
    ]) {
      wrapMethod(
        manager,
        methodName,
        (original, args) => {
          runAnnotationObserver("editor.deletion-identity", () => rememberAnnotationEditorIdentity(args[0], {
            deletingNative: methodName === "addDeletedAnnotationElement",
          }));
          const result = original.apply(manager, args);
          runAnnotationObserver("editor.deletion", () => noteMutation());
          return result;
        },
        cleanups,
      );
    }
    state.editorManagerCleanup = () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }

  function scheduleFreeTextGeometryRefresh(app) {
    const hasUnmeasuredFreeText = [...state.annotationSnapshot.values()].some(
      (row) => row.kind === "FreeText" && !hasNonDegeneratePdfRect(row.value?.rect),
    );
    if (!hasUnmeasuredFreeText) return;
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    const before = state.annotationSnapshot;
    setDeferredTimeout(() => {
      if (
        state.app !== app ||
        state.activeDocumentId !== documentId ||
        state.activeOpenRequest !== openRequest
      ) return;
      runAnnotationObserver("editor.freetext-geometry", () => {
        const current = getAnnotationStorageRows(app);
        const geometrySettled = [...current.values()].some((row) =>
          row.kind === "FreeText" &&
          !hasNonDegeneratePdfRect(before.get(row.runtimeId)?.value?.rect) &&
          hasNonDegeneratePdfRect(row.value?.rect),
        );
        if (geometrySettled) {
          // Re-capture after PDF.js has measured the committed FreeText.
          noteMutation();
        }
      });
    }, 0);
  }

  function observeAccessibilityManagers(app) {
    if (!app?.pdfDocument || !state.activeDocumentId || state.disposed) {
      return;
    }
    const pageCount = app.pdfDocument.numPages || 0;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      observeAccessibilityManager(app, app.pdfViewer?.getPageView?.(pageIndex));
    }
  }

  function samePdfViewportPresentation(left, right) {
    if (!left || !right) {
      return false;
    }
    for (const key of [
      "rotation",
      "scale",
      "width",
      "height",
      "offsetX",
      "offsetY",
    ]) {
      if (!Object.is(left[key], right[key])) {
        return false;
      }
    }
    for (const key of ["viewBox", "transform"]) {
      const before = left[key];
      const after = right[key];
      if (!before && !after) {
        continue;
      }
      if (
        !before ||
        !after ||
        before.length !== after.length ||
        Array.from(before).some((value, index) => !Object.is(value, after[index]))
      ) {
        return false;
      }
    }
    return true;
  }

  function observeAccessibilityManager(app, pageView) {
    const accessibilityManager = pageView?._accessibilityManager;
    if (
      !accessibilityManager ||
      typeof accessibilityManager.moveElementInDOM !== "function"
    ) {
      return;
    }
    const cleanups = [];
    const pageIndex = pageView.id - 1;
    if (!state.accessibilityManagers.has(accessibilityManager)) {
      wrapMethod(
        accessibilityManager,
        "moveElementInDOM",
        function (original, args) {
          const [container, element, contentElement, isRemovable] = args;
          const active = document.activeElement;
          if (
            !state.activeDocumentId ||
            state.disposed ||
            !element?.contains(active) ||
            !container?.isConnected ||
            !element.isConnected ||
            typeof this.addPointerInTextLayer !== "function"
          ) {
            return original.apply(this, args);
          }

          const editorLayer =
            pageView.annotationEditorLayer?.annotationEditorLayer;
          // getEditorByUID() compares the persistent annotation `uid`, which
          // can differ from the runtime DOM editor id after reopening a saved
          // FreeText annotation. PDF.js's UI manager indexes these live
          // editors by `editor.id`, matching element.id.
          const editor = app.pdfViewer?._layerProperties
            ?.annotationEditorUIManager?.getEditor?.(element.id);
          if (
            !editor ||
            editor.editorType !== "freetext" ||
            editor.div !== element ||
            editor.parent !== editorLayer ||
            editor.pageIndex !== pageIndex
          ) {
            return original.apply(this, args);
          }

          // PDF.js reorders an active editor in the text layer for accessible
          // reading order. Moving that live contenteditable synchronously blurs
          // it before PDF.js's own next-task focus restoration can run. Keep
          // aria-owns current now, but defer the physical DOM reorder until this
          // editor genuinely loses focus. Repeated moves of this same editor are
          // coalesced, and a hard limit bounds stale work during rapid focus
          // changes.
          const structTreeParentId = this.addPointerInTextLayer(
            contentElement,
            isRemovable,
          );
          makeDeferredAccessibilityMoveRoom(element);
          state.deferredAccessibilityMoves.set(element, {
            app,
            documentId: state.activeDocumentId,
            openRequest: state.activeOpenRequest,
            rendererGeneration,
            pdfDocument: app.pdfDocument,
            pageView,
            pageIndex,
            pdfPage: pageView.pdfPage,
            accessibilityManager,
            editorLayer,
            editor,
            container,
            element,
            contentElement,
            isRemovable,
            structTreeParentId,
            original,
          });
          return structTreeParentId;
        },
        cleanups,
      );
      state.accessibilityManagers.add(accessibilityManager);
    }

    // The frozen PDF.js layer method schedules a zero-delay focus restoration
    // before calling moveElementInDOM. Once the bridge defers that DOM move,
    // the restoration is no longer needed and could reclaim focus from a real
    // toolbar click. For the one active FreeText editor, route directly through
    // the wrapped accessibility method; every inactive editor retains the
    // original PDF.js path.
    const editorLayer = pageView.annotationEditorLayer?.annotationEditorLayer;
    const editorManager =
      app.pdfViewer?._layerProperties?.annotationEditorUIManager;
    if (
      editorLayer &&
      (typeof editorLayer.moveEditorInDOM === "function" ||
        typeof editorLayer.update === "function") &&
      !state.accessibilityEditorLayers.has(editorLayer)
    ) {
      const editorBuilder = pageView.annotationEditorLayer;
      if (typeof editorBuilder?.hide === "function") {
        wrapMethod(
          editorBuilder,
          "hide",
          function (original, args) {
            const layer = this.annotationEditorLayer;
            const active = document.activeElement;
            const activeInternal =
              active instanceof Element &&
              active.matches(".internal[contenteditable='true']")
                ? active
                : null;
            const editorElement = activeInternal?.closest(".freeTextEditor");
            const editor = editorElement &&
              editorManager?.getEditor?.(editorElement.id);
            let nextViewport = null;
            try {
              nextViewport = pageView.viewport?.clone?.({ dontFlip:true }) || null;
            } catch {
              nextViewport = null;
            }
            if (
              samePdfViewportPresentation(layer?.viewport, nextViewport) &&
              state.activeDocumentId &&
              !state.disposed &&
              state.app === app &&
              app.pdfDocument &&
              app.pdfViewer?._layerProperties?.annotationEditorUIManager ===
                editorManager &&
              app.pdfViewer?.getPageView?.(pageIndex) === pageView &&
              pageView._accessibilityManager === accessibilityManager &&
              pageView.annotationEditorLayer === this &&
              layer === editorLayer &&
              editorManager?.currentLayer === layer &&
              editor?.editorType === "freetext" &&
              editor.parent === layer &&
              editor.pageIndex === pageIndex &&
              editor.isAttachedToDOM &&
              editor.div === editorElement &&
              editor.div?.isConnected &&
              activeInternal.isContentEditable &&
              editor.div.contains(activeInternal) &&
              editor.isInEditMode?.() &&
              editorManager?.getEditor?.(editor.id) === editor
            ) {
              // PDFPageView.reset hides a retained annotation editor layer
              // before redrawing it. If the upcoming and current presentations
              // are identical, hiding it would blur and commit the live editor
              // while layout may report a zero-sized rectangle. Keep only this
              // exact, focused editor visible through the no-op reset; changed
              // scale or rotation still uses PDF.js's normal hide/commit path.
              return undefined;
            }
            return original.apply(this, args);
          },
          cleanups,
        );
      }
      const pendingResumeFocusByLayer = new WeakMap();
      const pendingResumeCallbacksByLayer = new WeakMap();
      const deferredResumeGuardCleanupsByLayer = new WeakMap();
      const focusSessionByTarget = new WeakMap();
      const focusGuardCleanupByTarget = new WeakMap();
      const flushDeferredResumeGuardCleanups = (layer) => {
        if ((pendingResumeCallbacksByLayer.get(layer) || 0) > 0) {
          return;
        }
        const deferred = deferredResumeGuardCleanupsByLayer.get(layer);
        if (!deferred) {
          return;
        }
        deferredResumeGuardCleanupsByLayer.delete(layer);
        for (const cleanup of deferred) {
          cleanup();
        }
      };
      const isResumeFocusSessionCurrent = (session) => !!(
        session &&
        !state.disposed &&
        state.activeDocumentId === session.documentId &&
        state.activeOpenRequest === session.openRequest &&
        state.app === session.app &&
        state.app?.pdfDocument === session.pdfDocument &&
        rendererGeneration === session.rendererGeneration &&
        state.app?.pdfViewer?.getPageView?.(session.pageIndex) ===
          session.pageView &&
        session.pageView?._accessibilityManager === accessibilityManager &&
        session.pageView?.annotationEditorLayer?.annotationEditorLayer ===
          session.editorLayer &&
        session.editor?.editorType === "freetext" &&
        session.editor?.parent === session.editorLayer &&
        session.editor?.pageIndex === session.pageIndex &&
        session.editor?.div === session.editorElement &&
        editorManager?.getEditor?.(session.editor.id) === session.editor
      );
      const hasExternalFocus = (session) => {
        if (!document.hasFocus()) {
          return true;
        }
        const frameElement = window.frameElement;
        const ownerDocument = frameElement?.ownerDocument;
        const ownerActiveElement = ownerDocument?.activeElement;
        if (
          frameElement &&
          ownerDocument &&
          ownerActiveElement &&
          ownerActiveElement !== frameElement &&
          ownerActiveElement !== ownerDocument.body &&
          ownerActiveElement !== ownerDocument.documentElement
        ) {
          return true;
        }
        const active = document.activeElement;
        return !!(
          active instanceof HTMLElement &&
          active !== document.body &&
          active !== document.documentElement &&
          !session.editorElement.contains(active)
        );
      };
      const installResumeFocusGuard = (target) => {
        if (!(target instanceof HTMLElement) || focusGuardCleanupByTarget.has(target)) {
          return;
        }
        const ownFocusDescriptor = Object.getOwnPropertyDescriptor(target, "focus");
        const originalFocus = target.focus;
        const capturedSession = focusSessionByTarget.get(target);
        const guardedFocus = function (...args) {
          const session = focusSessionByTarget.get(target);
          if (
            session?.resumeCallbackExecuting &&
            (hasExternalFocus(session) || !isResumeFocusSessionCurrent(session))
          ) {
            session.focusRestoreSuppressed = true;
            return undefined;
          }
          return originalFocus.apply(this, args);
        };
        try {
          Object.defineProperty(target, "focus", {
            configurable:true,
            enumerable:ownFocusDescriptor?.enumerable ?? false,
            writable:true,
            value:guardedFocus,
          });
        } catch {
          return;
        }
        const cleanup = () => {
          const layer = capturedSession?.editorLayer;
          if ((pendingResumeCallbacksByLayer.get(layer) || 0) > 0) {
            capturedSession.guardCleanupRequested = true;
            let deferred = deferredResumeGuardCleanupsByLayer.get(layer);
            if (!deferred) {
              deferred = new Set();
              deferredResumeGuardCleanupsByLayer.set(layer, deferred);
            }
            deferred.add(cleanup);
            return;
          }
          if (target.focus !== guardedFocus) {
            focusGuardCleanupByTarget.delete(target);
            if (focusSessionByTarget.get(target) === capturedSession) {
              focusSessionByTarget.delete(target);
            }
            return;
          }
          if (ownFocusDescriptor) {
            Object.defineProperty(target, "focus", ownFocusDescriptor);
          } else {
            delete target.focus;
          }
          focusGuardCleanupByTarget.delete(target);
          focusSessionByTarget.delete(target);
        };
        focusGuardCleanupByTarget.set(target, cleanup);
        cleanups.push(cleanup);
      };
      if (typeof editorLayer.pause === "function") {
        wrapMethod(
          editorLayer,
          "pause",
          function (original, [paused, ...args]) {
            const layer = this;
            if (paused) {
              const active = document.activeElement;
              if (this.div?.contains(active)) {
                const editorElement = active instanceof Element
                  ? active.closest(".freeTextEditor")
                  : null;
                const editor = editorElement &&
                  editorManager?.getEditor?.(editorElement.id);
                if (
                  active instanceof HTMLElement &&
                  editor?.editorType === "freetext" &&
                  editor.parent === this &&
                  editor.pageIndex === pageView.id - 1 &&
                  editor.div === editorElement &&
                  editor.isAttachedToDOM &&
                  editorElement.contains(active) &&
                  pageView._accessibilityManager === accessibilityManager &&
                  pageView.annotationEditorLayer?.annotationEditorLayer === this
                ) {
                  const previous = pendingResumeFocusByLayer.get(layer);
                  if (previous && previous.target !== active) {
                    pendingResumeFocusByLayer.delete(layer);
                    if (focusSessionByTarget.get(previous.target) === previous) {
                      focusSessionByTarget.delete(previous.target);
                    }
                    focusGuardCleanupByTarget.get(previous.target)?.();
                  }
                  const session = {
                    target:active,
                    editorElement,
                    editor,
                    pageIndex:pageView.id - 1,
                    pageView,
                    editorLayer:this,
                    app,
                    pdfDocument:app.pdfDocument,
                    documentId:state.activeDocumentId,
                    openRequest:state.activeOpenRequest,
                    rendererGeneration,
                    resumeCallbackExecuting:false,
                  };
                  pendingResumeFocusByLayer.set(layer, session);
                  focusSessionByTarget.set(active, session);
                  installResumeFocusGuard(active);
                } else {
                  // PDF.js replaces its cached target whenever the active
                  // element is inside the layer, so discard an older FreeText
                  // target when this pause captures some other layer child.
                  const previous = pendingResumeFocusByLayer.get(layer);
                  if (previous) {
                    pendingResumeFocusByLayer.delete(layer);
                    focusSessionByTarget.delete(previous.target);
                    focusGuardCleanupByTarget.get(previous.target)?.();
                  }
                }
              }
              return original.apply(this, [paused, ...args]);
            }

            const session = pendingResumeFocusByLayer.get(layer);
            if (!session) {
              return original.apply(this, [paused, ...args]);
            }

            let interceptedResumeCallback = false;
            const nativeSetTimeout = window.setTimeout;
            const interceptResumeTimeout = function (callback, delay, ...timerArgs) {
              if (
                !interceptedResumeCallback &&
                typeof callback === "function" &&
                delay === 0
              ) {
                interceptedResumeCallback = true;
                pendingResumeCallbacksByLayer.set(
                  layer,
                  (pendingResumeCallbacksByLayer.get(layer) || 0) + 1,
                );
                const scheduledSession =
                  pendingResumeFocusByLayer.get(layer) || session;
                const wrappedCallback = function (...callbackArgs) {
                  const resumeSession =
                    pendingResumeFocusByLayer.get(layer) || scheduledSession;
                  if (resumeSession) {
                    resumeSession.resumeCallbackExecuting = true;
                  }
                  try {
                    return callback.apply(this, callbackArgs);
                  } finally {
                    if (resumeSession) {
                      resumeSession.resumeCallbackExecuting = false;
                    }
                    const remaining = Math.max(
                      0,
                      (pendingResumeCallbacksByLayer.get(layer) || 1) - 1,
                    );
                    if (remaining > 0) {
                      pendingResumeCallbacksByLayer.set(layer, remaining);
                    } else {
                      pendingResumeCallbacksByLayer.delete(layer);
                    }
                    if (
                      remaining === 0 &&
                      resumeSession &&
                      pendingResumeFocusByLayer.get(layer) === resumeSession
                    ) {
                      pendingResumeFocusByLayer.delete(layer);
                      if (focusSessionByTarget.get(resumeSession.target) === resumeSession) {
                        focusSessionByTarget.delete(resumeSession.target);
                      }
                    }
                    if (remaining === 0) {
                      flushDeferredResumeGuardCleanups(layer);
                    }
                  }
                };
                return nativeSetTimeout.call(this, wrappedCallback, delay, ...timerArgs);
              }
              return nativeSetTimeout.call(this, callback, delay, ...timerArgs);
            };

            let result;
            try {
              window.setTimeout = interceptResumeTimeout;
              result = original.apply(this, [paused, ...args]);
            } finally {
              if (window.setTimeout === interceptResumeTimeout) {
                window.setTimeout = nativeSetTimeout;
              }
              if (!interceptedResumeCallback) {
                if (pendingResumeFocusByLayer.get(layer) === session) {
                  pendingResumeFocusByLayer.delete(layer);
                }
                if (focusSessionByTarget.get(session.target) === session) {
                  focusSessionByTarget.delete(session.target);
                }
                focusGuardCleanupByTarget.get(session.target)?.();
              }
            }
            return result;
          },
          cleanups,
        );
      }
      if (typeof editorLayer.moveEditorInDOM === "function") {
        wrapMethod(
          editorLayer,
          "moveEditorInDOM",
          function (original, [editor, ...args]) {
            const active = document.activeElement;
            if (
              state.activeDocumentId &&
              !state.disposed &&
              state.app === app &&
              app.pdfDocument &&
              pageView._accessibilityManager === accessibilityManager &&
              editor?.editorType === "freetext" &&
              editor.parent === this &&
              editor.isAttachedToDOM &&
              editor.div?.isConnected &&
              editor.div.contains(active)
            ) {
              editor._structTreeParentId = accessibilityManager.moveElementInDOM(
                this.div,
                editor.div,
                editor.contentDiv,
                true,
              );
              return;
            }
            return original.call(this, editor, ...args);
          },
          cleanups,
        );
      }
      if (typeof editorLayer.update === "function") {
        wrapMethod(
          editorLayer,
          "update",
          function (original, [parameters, ...args]) {
            const viewport = parameters?.viewport;
            const active = document.activeElement;
            const activeInternal =
              active instanceof Element &&
              active.matches(".internal[contenteditable='true']")
                ? active
                : null;
            const activeElement = activeInternal?.closest(".freeTextEditor");
            const editor = activeElement && editorManager?.getEditor?.(activeElement.id);
            const samePresentation = samePdfViewportPresentation(
              this.viewport,
              viewport,
            );
            if (
              samePresentation &&
              state.activeDocumentId &&
              !state.disposed &&
              state.app === app &&
              app.pdfDocument &&
              app.pdfViewer?._layerProperties?.annotationEditorUIManager ===
                editorManager &&
              editorManager?.currentLayer === this &&
              app.pdfViewer?.getPageView?.(pageView.id - 1) === pageView &&
              pageView.annotationEditorLayer?.annotationEditorLayer === this &&
              editor?.editorType === "freetext" &&
              editor.parent === this &&
              editor.pageIndex === pageView.id - 1 &&
              editor.isAttachedToDOM &&
              editor.div === activeElement &&
              editor.div?.isConnected &&
              activeInternal.isContentEditable &&
              editor.div.contains(activeInternal) &&
              editorManager?.getEditor?.(editor.id) === editor
            ) {
              // A page redraw can replay the exact same annotation-layer
              // viewport after text layout settles. PDF.js commits and cleans
              // up editors at the start of that no-op presentation update,
              // disabling the focused FreeText field or removing it if empty.
              // Skip only this identical update; a real blur or viewport
              // change still takes PDF.js's normal commit path.
              return undefined;
            }
            const activeEditorPageView = editor &&
              app.pdfViewer?.getPageView?.(editor.pageIndex);
            const activeEditorLayer = activeEditorPageView
              ?.annotationEditorLayer?.annotationEditorLayer;
            let activeEditorPresentationMatchesPageView = false;
            try {
              const currentPageViewport = activeEditorPageView?.viewport
                ?.clone?.({ dontFlip: true });
              activeEditorPresentationMatchesPageView =
                samePdfViewportPresentation(
                  activeEditorLayer?.viewport,
                  currentPageViewport,
                );
            } catch {
              activeEditorPresentationMatchesPageView = false;
            }
            if (
              samePresentation &&
              activeEditorPresentationMatchesPageView &&
              state.activeDocumentId &&
              !state.disposed &&
              state.app === app &&
              app.pdfDocument &&
              app.pdfViewer?._layerProperties?.annotationEditorUIManager ===
                editorManager &&
              app.pdfViewer?.getPageView?.(pageView.id - 1) === pageView &&
              pageView.annotationEditorLayer?.annotationEditorLayer === this &&
              editorManager?.currentPageIndex === editor?.pageIndex &&
              editorManager?.currentLayer === activeEditorLayer &&
              activeEditorPageView?.id - 1 === editor?.pageIndex &&
              activeEditorPageView?.annotationEditorLayer
                ?.annotationEditorLayer === activeEditorLayer &&
              editor?.editorType === "freetext" &&
              editor.parent === activeEditorLayer &&
              editor.parent !== this &&
              editor.pageIndex !== pageView.id - 1 &&
              editor.isAttachedToDOM &&
              editor.div === activeElement &&
              editor.div?.isConnected &&
              activeInternal.isContentEditable &&
              editor.div.contains(activeInternal) &&
              editorManager?.getEditor?.(editor.id) === editor
            ) {
              // PDF.js's UI manager is shared by every page layer. A replay of
              // another page's unchanged viewport therefore commits the live
              // editor from the current page before that other page can update.
              // Preserve the other layer's no-op presentation update only while
              // the exact current-document editor remains focused and owned by
              // the UI manager's current layer and that page still has the
              // presentation represented by its editor layer. A blur, stale
              // layer, or genuine active-page/receiver viewport change still
              // uses PDF.js's normal commit path.
              return undefined;
            }
            return original.apply(this, [parameters, ...args]);
          },
          cleanups,
        );
      }
      state.accessibilityEditorLayers.add(editorLayer);
    }
    if (cleanups.length === 0) {
      return;
    }
    const previousCleanup = state.accessibilityManagerCleanup;
    state.accessibilityManagerCleanup = () => {
      previousCleanup?.();
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }

  function isDeferredAccessibilityMoveCurrent(move) {
    return !!(
      move &&
      !state.disposed &&
      state.activeDocumentId === move.documentId &&
      state.activeOpenRequest === move.openRequest &&
      state.app === move.app &&
      state.app?.pdfDocument === move.pdfDocument &&
      rendererGeneration === move.rendererGeneration &&
      state.app?.pdfViewer?.getPageView?.(move.pageIndex) === move.pageView &&
      move.pageView?.pdfPage === move.pdfPage &&
      move.pageView?._accessibilityManager === move.accessibilityManager &&
      move.pageView?.annotationEditorLayer?.annotationEditorLayer ===
        move.editorLayer &&
      move.editor?.parent === move.editorLayer &&
      move.editor?.div === move.element &&
      move.container?.isConnected &&
      move.element?.isConnected &&
      move.container.contains(move.element) &&
      move.contentElement?.isConnected &&
      move.element.contains(move.contentElement)
    );
  }

  function discardDeferredAccessibilityMove(editor) {
    if (!editor) {
      return;
    }
    for (const [element, move] of state.deferredAccessibilityMoves) {
      if (move.editor === editor) {
        state.deferredAccessibilityMoves.delete(element);
      }
    }
  }

  function applyDeferredAccessibilityMove(move) {
    if (!isDeferredAccessibilityMoveCurrent(move)) {
      return false;
    }
    try {
      const structTreeParentId = move.original.call(
        move.accessibilityManager,
        move.container,
        move.element,
        move.contentElement,
        move.isRemovable,
      );
      move.editor._structTreeParentId = structTreeParentId;
      return true;
    } catch (error) {
      console.error("PDF.js accessibility editor placement failed:", error);
      return false;
    }
  }

  function makeDeferredAccessibilityMoveRoom(element) {
    if (state.deferredAccessibilityMoves.has(element)) {
      return;
    }
    for (const [pendingElement, move] of state.deferredAccessibilityMoves) {
      if (
        !pendingElement?.isConnected ||
        !isDeferredAccessibilityMoveCurrent(move)
      ) {
        state.deferredAccessibilityMoves.delete(pendingElement);
      }
    }
    while (
      state.deferredAccessibilityMoves.size >=
      DEFERRED_ACCESSIBILITY_MOVE_LIMIT
    ) {
      let evicted = false;
      for (const [pendingElement, move] of state.deferredAccessibilityMoves) {
        // The caller is deferring a different editor that owns focus. An older
        // pending editor is therefore inactive and can safely catch up without
        // moving the active editor or disturbing its composition session.
        if (pendingElement.contains(document.activeElement)) {
          continue;
        }
        state.deferredAccessibilityMoves.delete(pendingElement);
        applyDeferredAccessibilityMove(move);
        evicted = true;
        break;
      }
      if (!evicted) {
        break;
      }
    }
  }

  function flushDeferredAccessibilityMoves(
    blurTarget = null,
    { allowDocumentBlur = false } = {},
  ) {
    if (state.isComposing || state.compositionEndPending) {
      return;
    }
    for (const [element, move] of state.deferredAccessibilityMoves) {
      if (
        blurTarget &&
        blurTarget !== element &&
        !element.contains(blurTarget)
      ) {
        continue;
      }
      if (
        element.contains(document.activeElement) &&
        !(allowDocumentBlur && !document.hasFocus())
      ) {
        continue;
      }
      state.deferredAccessibilityMoves.delete(element);
      applyDeferredAccessibilityMove(move);
    }
  }

  function liveSidecarFreeTextEditors(manager, app) {
    const editors = new Set();
    if (
      state.disposed || state.app !== app || !app?.pdfDocument ||
      app.pdfViewer?._layerProperties?.annotationEditorUIManager !== manager
    ) return editors;
    for (let pageIndex = 0; pageIndex < app.pdfDocument.numPages; pageIndex += 1) {
      for (const editor of manager.getEditors(pageIndex)) {
        if (
          editor?.editorType === "freetext" && !editor.annotationElementId &&
          editor.deleted !== true && !editor.isEmpty?.() &&
          state.annotationUuidByRuntimeId.has(String(editor.id))
        ) editors.add(editor);
      }
    }
    return editors;
  }

  function showRestoredSidecarFreeTextEditors(manager, app, before) {
    for (const editor of liveSidecarFreeTextEditors(manager, app)) {
      if (before.has(editor)) continue;
      const builder = app.pdfViewer.getPageView(editor.pageIndex)?.annotationEditorLayer;
      const layer = builder?.annotationEditorLayer;
      if (
        editor.parent === layer && editor.div?.isConnected &&
        editor.div.parentElement === layer?.div
      ) {
        // PDF.js rebuilds the editor on undo, but a layer hidden when its last
        // Sidecar editor was erased stays hidden in reading mode. Hydration
        // already shows that layer; history restoration needs the same adapter.
        builder.show();
      }
    }
  }

  function snapshotSavedFreeTextEditors(manager, app) {
    const activeEditors = new Set();
    const editorStates = new Map();
    const pageCount = app.pdfDocument?.numPages || 0;
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      for (const editor of manager.getEditors(pageIndex)) {
        if (
          editor?.editorType !== "freetext" ||
          !editor.annotationElementId
        ) {
          continue;
        }
        activeEditors.add(editor);
        editorStates.set(editor, editor.deleted === true);
      }
    }
    return { activeEditors, editorStates };
  }

  function changedSavedFreeTextEditors(manager, app, before) {
    const after = snapshotSavedFreeTextEditors(manager, app);
    const candidates = new Set([
      ...before.activeEditors,
      ...after.activeEditors,
    ]);
    return [...candidates].filter((editor) => {
      if (
        editor?.editorType !== "freetext" ||
        !editor.annotationElementId
      ) {
        return false;
      }
      const wasActive = before.activeEditors.has(editor);
      const isActive = after.activeEditors.has(editor);
      const hadDeletedState = before.editorStates.has(editor);
      return (
        wasActive !== isActive ||
        (hadDeletedState &&
          before.editorStates.get(editor) !== (editor.deleted === true))
      );
    });
  }

  function isFreeTextAppearanceRepairCurrent(repair) {
    return !!(
      repair &&
      !state.disposed &&
      state.app === repair.app &&
      state.activeDocumentId === repair.documentId &&
      state.activeOpenRequest === repair.openRequest &&
      state.app?.pdfDocument === repair.pdfDocument &&
      rendererGeneration === repair.rendererGeneration &&
      repair.app.pdfViewer?._layerProperties?.annotationEditorUIManager ===
        repair.manager
    );
  }

  function canRepairFreeTextAppearance(repair) {
    return !!(
      isFreeTextAppearanceRepairCurrent(repair) &&
      !isInputBusy() &&
      !state.isComposing &&
      !state.compositionEndPending &&
      !state.freeTextFocused &&
      !state.freeTextInputPending &&
      !state.preparingContentForSave &&
      !repair.app._saveInProgress &&
      !state.pendingSave &&
      !state.pendingRecovery &&
      repair.app.pdfViewer?.annotationEditorMode === 0 &&
      state.editorMode === 0
    );
  }

  function isFreeTextAppearanceRepairEditorCurrent(manager, editor) {
    if (
      !editor?.id ||
      !editor.annotationElementId ||
      editor.editorType !== "freetext" ||
      !Number.isInteger(editor.pageIndex)
    ) {
      return false;
    }
    const current = manager.getEditor(editor.id);
    if (current && current !== editor) {
      return false;
    }
    if (editor.deleted) {
      return !!(
        manager.isDeletedAnnotationElement?.(editor.annotationElementId) &&
        (!current || current === editor)
      );
    }
    return current === editor &&
      !manager.isDeletedAnnotationElement?.(editor.annotationElementId);
  }

  function repaintFreeTextAppearancePages(repair, pageIndexes) {
    if (
      pageIndexes.size === 0 ||
      !isFreeTextAppearanceRepairCurrent(repair) ||
      repair.app.pdfViewer?.annotationEditorMode !== 0 ||
      state.editorMode !== 0
    ) {
      return;
    }

    const pdfViewer = repair.app.pdfViewer;
    const pageViews = [];
    for (const pageIndex of pageIndexes) {
      const pageView = pdfViewer.getPageView?.(pageIndex);
      const editorLayer = repair.manager.getLayer(pageIndex);
      if (
        !pageView ||
        pageView.id !== pageIndex + 1 ||
        !pageView.pdfPage ||
        pageView.annotationEditorLayer?.annotationEditorLayer !== editorLayer ||
        editorLayer?.pageIndex !== pageIndex ||
        repair.manager.getLayer(pageIndex) !== editorLayer ||
        !pageView.hasEditableAnnotations?.()
      ) {
        continue;
      }
      pageViews.push(pageView);
    }
    if (pageViews.length === 0) {
      return;
    }

    // Undo/redo changes the serialized annotation state. Invalidate PDF.js's
    // derived modified-id cache, then reuse its normal NONE-mode page refresh
    // so the saved appearance is painted back into the page canvas. These
    // operations preserve the editor manager, layers and undo/redo history.
    repair.pdfDocument.annotationStorage?.resetModifiedIds?.();
    for (const pageView of pageViews) {
      pageView.toggleEditingMode(false);
    }
    pdfViewer.update?.();
  }

  function repairFreeTextAppearance(repair) {
    const { manager, editors } = repair;
    const repaintedPages = new Set();
    for (const editor of editors) {
      if (!isFreeTextAppearanceRepairEditorCurrent(manager, editor)) {
        continue;
      }
      const layer = manager.getLayer(editor.pageIndex);
      const editable = layer?.getEditableAnnotation?.(
        editor.annotationElementId,
      );
      if (
        !editable ||
        editable.data?.id !== editor.annotationElementId ||
        layer.pageIndex !== editor.pageIndex ||
        repair.app.pdfViewer?.getPageView?.(editor.pageIndex)
          ?.annotationEditorLayer?.annotationEditorLayer !== layer ||
        !isFreeTextAppearanceRepairEditorCurrent(manager, editor)
      ) {
        continue;
      }

      // Keep the editor and its undo/redo closures intact. Reconcile only the
      // saved AP that this history action changed, using the same PDF.js
      // rendering methods as AnnotationEditorLayer.disable().
      if (editor.deleted) {
        editor.renderAnnotationElement(editable);
        repaintedPages.add(editor.pageIndex);
        continue;
      }

      if (editor.serialize() === null) {
        manager.removeChangedExistingAnnotation(editor);
        editor.resetAnnotationElement(editable);
        editor.show(false);
        editable.show();
        repaintedPages.add(editor.pageIndex);
        continue;
      }

      manager.addChangedExistingAnnotation(editor);
      if (editor.renderAnnotationElement(editable)) {
        editor.show(false);
      }
      editable.show();
      repaintedPages.add(editor.pageIndex);
    }
    repaintFreeTextAppearancePages(repair, repaintedPages);
  }

  function queueFreeTextAppearanceRepair(app, manager, editors) {
    if (
      state.editorMode !== 0 ||
      app.pdfViewer?.annotationEditorMode !== 0
    ) {
      return;
    }
    const current = state.pendingFreeTextAppearanceRepair;
    if (
      current &&
      current.app === app &&
      current.manager === manager &&
      current.pdfDocument === app.pdfDocument &&
      current.documentId === state.activeDocumentId &&
      current.openRequest === state.activeOpenRequest
    ) {
      for (const editor of editors) {
        current.editors.add(editor);
      }
      attemptFreeTextAppearanceRepair(current);
      return;
    }

    const repair = {
      app,
      manager,
      editors: new Set(editors),
      pdfDocument: app.pdfDocument,
      documentId: state.activeDocumentId,
      openRequest: state.activeOpenRequest,
      rendererGeneration,
    };
    state.pendingFreeTextAppearanceRepair = repair;
    attemptFreeTextAppearanceRepair(repair);
  }

  function cancelPendingFreeTextAppearanceRepair() {
    if (!state.pendingFreeTextAppearanceRepair) {
      return;
    }
    state.pendingFreeTextAppearanceRepair = null;
    resolveInputBoundaryWaiters(true);
  }

  function attemptFreeTextAppearanceRepair(repair) {
    if (state.pendingFreeTextAppearanceRepair !== repair) {
      return;
    }
    if (!isFreeTextAppearanceRepairCurrent(repair)) {
      state.pendingFreeTextAppearanceRepair = null;
      resolveInputBoundaryWaiters(false);
      return;
    }
    if (
      repair.app.pdfViewer?.annotationEditorMode !== 0 ||
      state.editorMode !== 0
    ) {
      cancelPendingFreeTextAppearanceRepair();
      return;
    }
    if (!canRepairFreeTextAppearance(repair)) {
      setDeferredTimeout(() => attemptFreeTextAppearanceRepair(repair), 50);
      return;
    }

    try {
      repairFreeTextAppearance(repair);
    } catch (error) {
      console.error("Could not refresh a saved FreeText appearance:", error);
      showStatus("Could not refresh the saved FreeText appearance.");
    } finally {
      if (state.pendingFreeTextAppearanceRepair === repair) {
        state.pendingFreeTextAppearanceRepair = null;
      }
      resolveInputBoundaryWaiters(true);
      if (state.manualSaveQueued) {
        runQueuedManualSave();
      } else if (state.autoSavePending && !isInputBusy()) {
        scheduleAutoSave();
      }
    }
  }

  function basename(documentId) {
    const parts = documentId.split(/[\\/]/);
    return parts.at(-1) || "document.pdf";
  }

  function normalizedPointerType(value) {
    if (typeof value !== "string" || !value) {
      return "unknown";
    }
    return value.slice(0, 16);
  }

  function recordPointerDiagnostic(type, pointer, intent = null, activePointers) {
    const diagnostics = state.pointerDiagnostics;
    diagnostics.total = Math.min(Number.MAX_SAFE_INTEGER, diagnostics.total + 1);
    if (diagnostics.samples.length === POINTER_DIAGNOSTIC_LIMIT) {
      diagnostics.samples.shift();
      diagnostics.dropped += 1;
    }
    const sample = {
      type,
      pointerType: normalizedPointerType(
        intent?.pointerType ?? pointer?.pointerType,
      ),
      button: Number.isInteger(intent?.button)
        ? intent.button
        : Number.isInteger(pointer?.button)
          ? pointer.button
          : null,
      buttons: Number.isInteger(intent?.buttons)
        ? intent.buttons
        : Number.isInteger(pointer?.buttons)
          ? pointer.buttons
          : null,
      activePointers:
        Number.isInteger(activePointers) ? activePointers : activePointerCount(),
      editorMode: Number.isInteger(state.editorMode) ? state.editorMode : null,
      trusted: intent ? intent.trusted === true : null,
    };
    diagnostics.samples.push(sample);
    return sample;
  }

  function inputDiagnosticsSnapshot(requestId) {
    return {
      schema: 1,
      requestId,
      rendererGeneration,
      pointerEventsSeen: state.pointerDiagnostics.total,
      pointerEventsDropped: state.pointerDiagnostics.dropped,
      activePointers: activePointerCount(),
      editorMode: state.editorMode,
      vocabularyEnabled: state.vocabularyEnabled === true,
      annotationTrackingFailure: state.annotationTrackingFailure
        ? { ...state.annotationTrackingFailure } : null,
      pointers: state.pointerDiagnostics.samples.map((sample) => ({ ...sample })),
    };
  }

  function currentInteractionMode(editorMode = state.editorMode) {
    return window.PdfReaderInputRuntime.InteractionMode.resolve({
      editorMode,
      eraserActive: document.body.classList.contains("editorEraserMode"),
    });
  }

  function annotationToolIsActive() {
    return window.PdfReaderInputRuntime.InteractionMode.isToolActive(
      currentInteractionMode(),
    );
  }

  function refreshFingerTextSelectionSuppression() {
    state.inputPolicy?.refreshFingerTextSelectionSuppression?.();
  }

  function clearFingerTextSelectionSuppression() {
    state.inputPolicy?.clearFingerTextSelectionSuppression?.();
  }

  function onBridgeFingerSelectStart(intent, controls) {
    state.inputPolicy?.handleTextSelectionGuard?.(intent, controls);
  }

  function onBridgeFingerContextMenu(intent, controls) {
    state.inputPolicy?.handleTextSelectionGuard?.(intent, controls);
  }

  function cancelManualMomentum() {
    state.iosDirectManipulationController?.cancelMomentum();
  }

  function onManualDocumentVisibilityChange() {
    state.iosDirectManipulationController?.onDocumentVisibilityChange();
    if (document.visibilityState === "hidden") clearReaderBacklinkPresentation();
    else if (document.visibilityState === "visible") requestReaderBacklinksForPage();
  }

  function clearManualPointerSessions({ clearClickTargets = true } = {}) {
    state.iosDirectManipulationController?.clearSessions({ clearClickTargets });
  }

  function manualPointerSessionCurrent(pointer) {
    return state.iosDirectManipulationController
      ?.isManualPointerSessionCurrent(pointer) === true;
  }

  function onBridgeIosClick(intent, controls) {
    if (intent?.targetRegion === "editor-mode-buttons") {
      if (state.activeDocumentId && Number.isInteger(state.activeOpenRequest)) {
        state.vocabularyReadModeToolChoice = {
          documentId: state.activeDocumentId,
          openRequest: state.activeOpenRequest,
          rendererGeneration,
        };
      }
      state.annotationController?.cancelPendingReadMode?.();
    }
    if (intent?.targetRegion === "vocabulary-pill") return;
    const panClickSuppressed = state.inputPolicy?.handlePanClick?.(intent, controls) === true;
    // Selecting a sentence is the existing Save Context workflow. The drag's
    // final native click must not dismiss its owner or navigate a backlink.
    if (!panClickSuppressed && state.editorMode === 0 && !annotationToolIsActive() &&
        !state.closeControl && !state.disposed &&
        !state.iosDirectManipulationController?.hasActivePenEditorGesture?.() &&
        state.vocabularyController?.shouldPreserveEntryPillForSelection?.(intent) === true) return;
    // Keep the lookup transient: an outside click closes it. A click on a
    // different highlighted token can open the next card in this same event.
    state.vocabularyController?.dismissEntryPill?.();
    if (state.editorMode !== 0 || annotationToolIsActive() || state.closeControl || state.disposed) return;
    if (state.iosDirectManipulationController?.hasActivePenEditorGesture?.()) return;
    // Explicit role=button badges are native activations, not text-tap
    // candidates. Their pointerdown deliberately does not start a page pan.
    if (intent.nativeActivationTarget === true &&
        state.backlinkInteractionController?.handleRoutedPointerEvent?.(intent, controls)) return;
    const pageIndex = Number.isInteger(intent?.pageIndex) ? intent.pageIndex : null;
    const touchTap = state.iosDirectManipulationController
      ?.consumeVocabularyTapCandidate?.(intent) === true;
    const knownTouchContact = pageIndex !== null &&
      state.inputPolicy?.lastTouchPanClickTarget === pageIndex;
    const knownPanClick = pageIndex !== null && (
      state.inputPolicy?.lastTouchPanClickTarget === pageIndex ||
      state.inputPolicy?.lastPenPanClickTarget === pageIndex
    );
    // iOS prevents the synthesized touch click from entering PDF.js. A plain
    // tap is still eligible for vocabulary only when the direct-manipulation
    // controller did not classify it as a completed page pan.
    if ((intent.pointerType === "touch" || knownTouchContact) && !touchTap) return;
    if (panClickSuppressed && knownPanClick && !touchTap) return;
    if (state.backlinkInteractionController?.handleRoutedPointerEvent?.(intent, controls)) return;
    state.vocabularyController?.handleTap?.(intent);
  }

  function onBridgeIosDoubleClick(intent, controls) {
    if (state.inputPolicy?.handlePanClick?.(intent, controls, { doubleClick: true })) return;
    if (state.editorMode !== 0 || annotationToolIsActive() || state.closeControl || state.disposed) return;
    if (state.iosDirectManipulationController?.hasActivePenEditorGesture?.()) return;
    state.backlinkInteractionController?.handleRoutedPointerEvent?.(intent, controls);
  }

  function pointerInteractionKind(intent) {
    return state.annotationController?.pointerInteractionKind(intent, {
      interactionMode: currentInteractionMode(),
    }) || null;
  }

  function isPointerSessionCurrent(pointer) {
    return !!(
      pointer &&
      state.app?.pdfDocument === pointer.pdfDocument &&
      state.activeDocumentId === pointer.documentId &&
      state.activeOpenRequest === pointer.openRequest &&
      rendererGeneration === pointer.rendererGeneration
    );
  }

  function invalidatePendingPenHighlight(pointer = null) {
    state.textSelectionController?.cancelPending?.(pointer);
  }

  function updateOwnedPenTextSelection(pointer, intent, controls) {
    const updated = state.textSelectionController?.extend(pointer, intent) === true;
    if (updated) controls?.preventDefault?.();
    return updated;
  }

  function hasOtherActivePenPointer(pointer) {
    return activePointerValues().some((candidate) =>
      candidate !== pointer &&
      candidate.pointerType === "pen" &&
      !candidate.ending
    ) || penPolicyPointerIds().some((pointerId) =>
      pointerId !== pointer.pointerId
    ) || manualPointerValues().some((candidate) =>
      candidate !== pointer && candidate.pointerType === "pen"
    );
  }

  function finishPenHighlightFallback(pointer) {
    return state.annotationController?.finishPenHighlight(pointer) === true;
  }

  function cancelPdfJsPointerSession(pointer) {
    state.annotationController?.cancelPointerSession(pointer);
  }

  function scheduleAnnotationTransformCancel(pointer) {
    // PDF.js move and resize sessions listen for pointerup/blur rather than
    // pointercancel. The controller requests this bridge-owned event delivery
    // only after confirming the matching editor operation.
    setDeferredTimeout(() => {
      if (
        activePointer(pointer.pointerId) !== pointer ||
        !isPointerSessionCurrent(pointer) ||
        pointer.internalCancelDispatched
      ) {
        return;
      }
      pointer.internalCancelDispatched = true;
      const cleanupEvent = new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: pointer.pointerId,
        pointerType: pointer.pointerType,
        isPrimary: true,
        clientX: pointer.lastX,
        clientY: pointer.lastY,
        button: 0,
        buttons: 0,
      });
      recordPointerDiagnostic(
        "pointerup",
        pointer,
        window.PdfReaderInputRuntime.createInteractionIntent(cleanupEvent),
        activePointerCount(),
      );
      window.dispatchEvent(cleanupEvent);
    }, 0);
  }

  function releasePointerCapture(pointer) {
    state.inputRouter?.releasePointerCapture(pointer.pointerId);
  }

  function finishTrackedPointer(
    pointerId,
    reason,
    intent = null,
    { cancel = false, controls = null } = {},
  ) {
    const pointer = activePointer(pointerId);
    if (!pointer || pointer.ending) {
      return;
    }
    if (
      !cancel && reason === "pointerup" &&
      pointer.penTextSelectionCandidate
    ) {
      // Some WebViews deliver the last caret position only with pointerup,
      // especially when a Pencil crosses the whitespace between text lines.
      runAnnotationObserver("pointer.selection-end", () => updateOwnedPenTextSelection(pointer, intent, controls));
    }
    deletePenPolicyPointer(pointerId);
    runAnnotationObserver("pointer.touch-action-end", () => state.inputPolicy?.refreshPenGestureTouchAction?.());
    pointer.ending = true;
    pointer.buttons = Number.isInteger(intent?.buttons)
      ? intent.buttons
      : pointer.buttons;
    if (cancel) {
      runAnnotationObserver("pointer.cancel", () => {
        invalidatePendingPenHighlight(pointer);
        cancelPdfJsPointerSession(pointer);
      });
    }
    // Pointer listeners in PDF.js finish the editor, temporary eraser, and
    // tool wheel during this dispatch. Defer bridge cleanup until they run.
    setDeferredTimeout(() => {
      if (activePointer(pointerId) !== pointer) {
        return;
      }
      try {
        if (!cancel && reason === "pointerup") finishPenHighlightFallback(pointer);
      } catch (error) {
        recordAnnotationTrackingFailure("pointer.highlight-end", error);
      } finally {
        // Each cleanup step is independent: an observer or a stale PDF.js
        // layer must not leave our pointer/capture ownership behind.
        runAnnotationObserver("pointer.release", () => releasePointerCapture(pointer));
        deleteActivePointer(pointerId);
        runAnnotationObserver("pointer.touch-action", () => state.inputPolicy?.refreshPenGestureTouchAction?.());
      }
      recordPointerDiagnostic(
        reason === "pointerup" ? "pointerup" : "pointercancel",
        pointer,
        intent,
        activePointerCount(),
      );
      if (pointer.button === 0 && pointer.mode === 15) {
        // Ink keeps its drawing session open for additional strokes. The idle
        // timer commits it after this stroke has been quiet for one second.
        state.pendingInkCommit = true;
        state.autoSavePending = true;
      }
      runAnnotationObserver("pointer.controls", () => syncBridgeControls());
      if (!hasActivePointerInteraction()) {
        if (
          state.closeControl?.phase === "closing" &&
          !isInputBusy()
        ) {
          commitFocusedFreeText();
        }
        resolveInputBoundaryWaiters(true);
        if (state.manualSaveQueued) {
          runQueuedManualSave();
        } else if (state.autoSavePending && !isInputBusy()) {
          scheduleAutoSave();
        }
      }
    }, 0);
  }

  function onBridgePointerDown(intent, controls) {
    cancelManualMomentum();
    invalidatePendingPenHighlight();
    dismissToolbarParameterPopups(intent);
    if (state.backlinkInteractionController?.handleRoutedPointerEvent?.(intent, controls)) return;
    state.iosDirectManipulationController?.preparePointerDown(intent);
    if (state.closeControl) {
      controls?.preventDefault?.();
      controls?.stopImmediatePropagation?.();
      return;
    }
    const resolvedTarget = state.textSelectionController?.resolveTarget(intent) || {};
    if (!resolvedTarget.hitTarget) return;
    const directManipulationHandled =
      state.iosDirectManipulationController?.routePointerDown(intent, controls, {
        nativeOperationActive: state.annotationController?.nativeOperation(intent) != null,
      }) === true;
    state.inputPolicy?.refreshPenGestureTouchAction?.();
    if (directManipulationHandled) {
      return;
    }
    const kind = pointerInteractionKind(intent);
    if (!kind || hasActivePointer(intent.pointerId)) {
      return;
    }
    const captureTarget =
      kind === "text-selection"
        ? resolvedTarget.textLayer
        : resolvedTarget.hitTarget;
    const pointer = {
      pointerId: intent.pointerId,
      button: intent.button,
      buttons: intent.buttons,
      pointerType: normalizedPointerType(intent.pointerType),
      kind,
      nativeOperation: state.annotationController?.nativeOperation(intent) || null,
      mode: state.editorMode,
      startX: intent.clientPoint.x,
      startY: intent.clientPoint.y,
      lastX: intent.clientPoint.x,
      lastY: intent.clientPoint.y,
      moved: false,
      moveSampled: false,
      documentId: state.activeDocumentId,
      openRequest: state.activeOpenRequest,
      pdfDocument: state.app?.pdfDocument,
      rendererGeneration,
    };
    if (
      pointer.pointerType === "pen" &&
      pointer.kind === "text-selection" &&
      pointer.mode === 9
    ) {
      const { textLayer, page } = resolvedTarget;
      const eligible = state.annotationController?.preparePenHighlight(pointer, {
        textLayer,
        page,
      }) === true;
      if (eligible) {
        const ownsGesture = state.textSelectionController?.begin(pointer, intent, {
          eligible,
        }) === true;
        if (ownsGesture) {
          // Own this glyph-span gesture so the browser's compatibility mouse
          // sequence cannot start a second PDF.js selection or freehand path.
          controls?.preventDefault?.();
        }
      }
    }
    setActivePointer(intent.pointerId, pointer);
    recordPointerDiagnostic("pointerdown", pointer, intent);
    if (shouldCaptureTrackedPointer(
      pointer,
      intent,
      document.body.classList.contains("editorEraserMode"),
    )) {
      state.inputRouter?.capturePointer(intent.pointerId, captureTarget);
    }
    clearAutoSaveTimer();
  }

  function shouldCaptureTrackedPointer(pointer, intent, eraserActive) {
    const plainMouseTextSelection =
      pointer.pointerType === "mouse" &&
      pointer.kind === "text-selection" &&
      !pointer.nativeOperation;
    return !plainMouseTextSelection &&
      (intent.pointerType === "mouse" || pointer.nativeOperation) &&
      intent.button !== 2 &&
      !(intent.button === 0 && eraserActive);
  }

  function installPointerTrackingListeners() {
    if (state.pointerAbortController || state.disposed) {
      return;
    }
    state.textSelectionController =
      new window.PdfReaderInputRuntime.TextSelectionController({
        documentRef: document,
        isSessionCurrent: isPointerSessionCurrent,
      });
    state.annotationController =
      new window.PdfReaderInputRuntime.AnnotationController({
        getManager: () =>
          state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager || null,
        getPdfViewer: () => state.app?.pdfViewer || null,
        getEventBus: () => state.app?.eventBus || null,
        getEraser: () => state.app?.pdfAnnotationEraser || null,
        getEditorMode: () => state.editorMode,
        getPdfViewerMode: () => state.app?.pdfViewer?.annotationEditorMode,
        isPointerSessionCurrent,
        isTextSelectionValid: (pointer) =>
          state.textSelectionController?.hasValidHighlightSelection(pointer) === true,
        hasOtherActivePenPointer,
        isClosingOrDisposed: () => !!state.closeControl || state.disposed,
        isPendingHighlight: (pointer) =>
          state.textSelectionController?.isPending(pointer) === true,
        clearPendingHighlight: () => state.textSelectionController?.clearPending(),
        clearToolWheel: (pointerId) => {
          const app = state.app;
          if (app?._toolWheel?.pointerId === pointerId) {
            app._toolWheel.element?.remove();
            app._toolWheel = null;
            app._toolWheelPointer = null;
          }
        },
        onTransformCancel: scheduleAnnotationTransformCancel,
      });
    const policy = iosInputPolicy
      ? new window.PdfReaderInputRuntime.IOSInputPolicy({
        documentRef: document,
        isAnnotationToolActive: annotationToolIsActive,
        stopNativeScroll: () => state.viewportController?.interruptNativeScroll(
          document.getElementById("viewerContainer"),
        ),
        hasActivePenEditorGesture: () =>
          state.iosDirectManipulationController?.hasActivePenEditorGesture() === true,
      })
      : new window.PdfReaderInputRuntime.DesktopInputPolicy();
    state.inputPolicy = policy;
    state.viewportController = iosInputPolicy
      ? new window.PdfReaderInputRuntime.ViewportController({
        canPan(pointer) {
          return !pointer.blockedByPen &&
            !pointer.blockedByOtherPointer &&
            !pointer.blockedByVisibility &&
            manualPointerSessionCurrent(pointer);
        },
        canStartMomentum(pointer) {
          return iosInputPolicy &&
            manualPointerCount() === 0 &&
            manualPointerSessionCurrent(pointer);
        },
        getVisibilityState: () => document.visibilityState,
      })
      : null;
    state.iosDirectManipulationController = iosInputPolicy
      ? new window.PdfReaderInputRuntime.IOSDirectManipulationController({
        getInputRouter: () => state.inputRouter,
        getViewportController: () => state.viewportController,
        getInputPolicy: () => state.inputPolicy,
        getViewerContainer: () => document.getElementById("viewerContainer"),
        getCurrentSession: () => ({
          documentId: state.activeDocumentId,
          openRequest: state.activeOpenRequest,
          pdfDocument: state.app?.pdfDocument,
          rendererGeneration,
        }),
        getEditorMode: () => state.editorMode,
        isEraserActive: () => document.body.classList.contains("editorEraserMode"),
        isAnnotationToolActive: annotationToolIsActive,
        invalidatePendingPenHighlight: () => invalidatePendingPenHighlight(),
        onInputBoundary: () => runAnnotationObserver(
          "input.boundary",
          () => state.annotationController?.notifyInputBoundary?.(),
        ),
      })
      : null;
    const legacyListeners = new Map([
      ["pointerdown", onBridgePointerDown],
      ["pointermove", onBridgePointerMove],
      ["pointerup", onBridgePointerEnd],
      ["pointercancel", onBridgePointerEnd],
      ["touchcancel", onBridgeTouchCancel],
      ["pointerout", onBridgePointerOut],
      ["lostpointercapture", onBridgeLostPointerCapture],
      ["wheel", onBridgeWheel],
      ["click", onBridgeIosClick],
      ["dblclick", onBridgeIosDoubleClick],
      ["selectstart", onBridgeFingerSelectStart],
      ["contextmenu", onBridgeFingerContextMenu],
      ["blur", onBridgeWindowBlur],
      ["keydown", onBridgePointerKeyDown],
    ]);
    const router = new window.PdfReaderInputRuntime.InputRouter({
      targetWindow: window,
      targetDocument: document,
      policy,
      includeTouchEvents: iosInputPolicy,
      onIntent(intent, controls) {
        const listener = intent.type === "visibilitychange"
          ? onManualDocumentVisibilityChange
          : legacyListeners.get(intent.type);
        listener?.(intent, controls);
      },
    });
    state.inputRouter = router;
    state.pointerAbortController = router.start();
    if (state.vocabularyEnabled && state.activeDocumentId && Number.isInteger(state.activeOpenRequest)) {
      requestVocabularyReadMode(state.activeDocumentId, state.activeOpenRequest);
    }
  }

  function onBridgeWheel() {
    cancelManualMomentum();
  }

  function onBridgePointerMove(intent, controls) {
    if (state.iosDirectManipulationController?.handlePointerMove(intent, controls)) {
      return;
    }
    const pointer = activePointer(intent.pointerId);
    if (!pointer || pointer.ending) {
      return;
    }
    pointer.buttons = intent.buttons;
    pointer.lastX = intent.clientPoint.x;
    pointer.lastY = intent.clientPoint.y;
    if (!pointer.moveSampled) {
      pointer.moveSampled = true;
      recordPointerDiagnostic("pointermove", pointer, intent);
    }
    if (!pointer.moved) {
      pointer.moved =
        Math.hypot(intent.clientPoint.x - pointer.startX, intent.clientPoint.y - pointer.startY) >
        1;
    }
    if (pointer.penTextSelectionCandidate) {
      updateOwnedPenTextSelection(pointer, intent, controls);
    }
  }

  function onBridgePointerEnd(intent, controls) {
    if (state.iosDirectManipulationController?.handlePointerEnd(intent, controls)) return;
    deletePenPolicyPointer(intent.pointerId);
    runAnnotationObserver("pointer.touch-action-end", () => state.inputPolicy?.refreshPenGestureTouchAction?.());
    finishTrackedPointer(intent.pointerId, intent.type || "pointerup", intent, {
      cancel: intent.type === "pointercancel",
      controls,
    });
  }

  function onBridgeTouchCancel(intent, controls) {
    if (state.iosDirectManipulationController?.handleTouchCancel(intent)) {
      controls?.stopImmediatePropagation?.();
    }
  }

  function onBridgePointerOut(intent, controls) {
    if (state.iosDirectManipulationController?.handlePointerOut(intent, controls)) return;
    if (
      hasPenPolicyPointer(intent.pointerId) &&
      !intent.relatedTargetPresent
    ) {
      deletePenPolicyPointer(intent.pointerId);
      runAnnotationObserver("pointer.touch-action-out", () => state.inputPolicy?.refreshPenGestureTouchAction?.());
    }
    const pointer = activePointer(intent.pointerId);
    if (
      !pointer ||
      pointer.ending ||
      intent.relatedTargetPresent ||
      state.inputRouter?.hasPointerCapture(intent.pointerId)
    ) {
      return;
    }
    finishTrackedPointer(intent.pointerId, "pointerout", intent, { cancel: true, controls });
  }

  function onBridgeLostPointerCapture(intent, controls) {
    if (state.iosDirectManipulationController?.handleLostPointerCapture(intent, controls)) return;
    deletePenPolicyPointer(intent.pointerId);
    runAnnotationObserver("pointer.touch-action-lost-capture", () => state.inputPolicy?.refreshPenGestureTouchAction?.());
    const pointer = activePointer(intent.pointerId);
    if (!pointer || pointer.ending) {
      return;
    }
    finishTrackedPointer(intent.pointerId, "lostpointercapture", intent, {
      cancel: true,
      controls,
    });
  }

  function onBridgeWindowBlur(intent) {
    if (intent?.targetRole !== "window") {
      return;
    }
    clearManualPointerSessions();
    for (const [pointerId, pointer] of activePointerEntries()) {
      if (!pointer.ending) {
        finishTrackedPointer(pointerId, "blur", null, { cancel: true });
      }
    }
  }

  function onBridgePointerKeyDown(intent) {
    if (intent.key === "Escape") {
      for (const [pointerId, pointer] of activePointerEntries()) {
        if (pointer.button === 2) {
          finishTrackedPointer(pointerId, "escape", null, { cancel: true });
        }
      }
    }
  }

  function onBridgeFocusIn(event) {
    if (state.backlinkInteractionController?.handleBadgeFocus?.(event)) return;
    if (isFreeTextTarget(event.target)) {
      state.freeTextFocusGeneration += 1;
      state.freeTextFocused = true;
      state.freeTextCommittedForSave = !state.freeTextInputPending;
      if (!state.freeTextInputPending) {
        clearAutoSaveTimer();
      }
    }
  }

  function onBridgeFocusOut(event) {
    setDeferredTimeout(() => annotationToolColors?.onEditorStatesChanged(), 0);
    if (state.backlinkInteractionController?.handleBadgeFocus?.(event)) return;
    if (
      !isFreeTextTarget(event.target) &&
      !isFreeTextEditorContainer(event.target)
    ) {
      return;
    }
    const focusGeneration = ++state.freeTextFocusGeneration;
    const externalFocusSession = captureExternalFreeTextFocusSession(
      event,
      focusGeneration,
    );
    setDeferredTimeout(() => {
      // PDF.js moves an active editor in the DOM and restores its focus in a
      // later task. Let that restoration run before treating this as a real
      // edit boundary; deferred accessibility moves are flushed only if this
      // editor still has genuinely lost focus after that recovery turn.
      setDeferredTimeout(() => {
        // PDF.js's FreeText blur commits by disabling contenteditable and
        // focusing the editor wrapper. If a trusted blur named a real external
        // focus target, restore that target only while focus is still trapped
        // in this same editor subtree. A later user focus change always wins.
        if (focusGeneration === state.freeTextFocusGeneration) {
          restoreExternalFreeTextFocus(event, externalFocusSession);
        }
        flushDeferredAccessibilityMoves(event.target);
        if (focusGeneration !== state.freeTextFocusGeneration) {
          return;
        }
        state.freeTextFocused = isFreeTextTarget(document.activeElement);
        if (!state.freeTextFocused) {
          state.freeTextCommittedForSave = false;
          if (!state.isComposing && !state.compositionEndPending) {
            // PDF.js commits FreeText on blur after its editor-move/refocus
            // task has had a chance to restore the active editing target.
            state.freeTextInputPending = false;
          }
          resolveInputBoundaryWaiters(true);
        }
        if (state.freeTextFocused) {
          return;
        }
        if (state.manualSaveQueued) {
          runQueuedManualSave();
        } else if (state.autoSavePending && !isInputBusy()) {
          scheduleAutoSave();
        }
      }, 0);
    }, 0);
  }

  function onBridgeInput(event) {
    if (!isFreeTextTarget(event.target)) {
      return;
    }
    state.freeTextFocused = true;
    state.freeTextCommittedForSave = false;
    state.freeTextInputPending = true;
    noteMutation({ schedule: false });
    scheduleAutoSave();
  }

  function isSaveShortcut(event) {
    return (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key?.toLowerCase() === "s"
    );
  }

  function onBridgeKeyDown(event) {
    if (state.closeControl) {
      if (
        event.key === "Escape" &&
        activePointerValues().some((pointer) => pointer.button === 2)
      ) {
        // Let PDF.js cancel its temporary right-button eraser; the early
        // boundary listener defers release until that handler has run.
        return;
      }
      if (
        state.isComposing ||
        state.compositionEndPending ||
        event.isComposing
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!isSaveShortcut(event)) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (state.isComposing || event.isComposing) {
      void deferManualSave({ commit: true });
    } else {
      void requestSave("manual");
    }
  }

  function onCompositionStart(event) {
    if (state.closeControl && !state.isComposing) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    state.isComposing = true;
    state.compositionEndPending = false;
    clearAutoSaveTimer();
  }

  function onCompositionEnd() {
    state.isComposing = false;
    state.compositionEndPending = true;
    setDeferredTimeout(() => {
      state.compositionEndPending = false;
      if (state.closeControl?.phase === "closing") {
        commitFocusedFreeText();
      }
      if (!state.freeTextFocused) {
        state.freeTextInputPending = false;
      }
      if (!isFreeTextTarget(document.activeElement) || !document.hasFocus()) {
        flushDeferredAccessibilityMoves(null, {
          allowDocumentBlur: !document.hasFocus(),
        });
      }
      resolveInputBoundaryWaiters(true);
      if (state.manualSaveQueued) {
        runQueuedManualSave();
      } else if (state.autoSavePending && !isInputBusy()) {
        scheduleAutoSave();
      }
    }, 0);
  }

  function onBridgeBeforeInput(event) {
    if (
      !state.closeControl ||
      state.isComposing ||
      state.compositionEndPending ||
      event.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function clearScheduledWork() {
    cancelPendingHeavyLeaseWaiters();
    clearAutoSaveTimer();
    clearDeferredTimeouts();
    state.pendingFreeTextAppearanceRepair = null;
    state.autoSavePending = false;
    state.lastAutoSaveStartedAt = null;
    state.lastAutoSaveDurationMs = 0;
    state.pendingInkCommit = false;
    state.manualSaveQueued = false;
    state.manualCommitQueued = false;
    clearManualPointerSessions();
    clearActivePointers();
    state.freeTextFocused = false;
    state.freeTextCommittedForSave = false;
    state.freeTextInputPending = false;
    state.freeTextFocusGeneration += 1;
    state.freeTextCommitReady = false;
    state.preparingContentForSave = false;
    state.isComposing = false;
    state.compositionEndPending = false;
    resolveInputBoundaryWaiters(false);
    resolveManualSaveWaiters(false);
  }

  async function handleFlush(message, closeControl = null) {
    const id = message.id;
    if (typeof id !== "string") {
      return;
    }
    const documentId = state.activeDocumentId;
    const closeDeadline = Date.now() + 110000;
    let result = true;
    let recovered = false;
    try {
      if (
        closeControl &&
        (state.closeControl !== closeControl ||
          closeControl.cancelled ||
          state.activeDocumentId !== closeControl.documentId)
      ) {
        result = false;
      }
      if (documentId && result) {
        if (state.freeTextFocused && !isInputBusy()) {
          // A close commits a focused FreeText editor after any IME or pointer
          // interaction has reached its natural boundary.
          commitFocusedFreeText();
        }
        if (closeControl) {
          if (isInputBusy()) {
            result = await waitForInputBoundary(
              Math.max(0, closeDeadline - Date.now()),
              closeControl,
            );
          }
          if (
            result === true &&
            state.activeDocumentId === documentId &&
            state.closeControl === closeControl &&
            !closeControl.cancelled
          ) {
            commitFocusedFreeText();
            result = !isEditBoundaryBusy() && setCloseInputInert(closeControl);
          } else {
            result = false;
          }

          if (result === true && state.activeDocumentId === documentId) {
            // A queued Viewer save that has not serialized yet must not race a
            // fresh close snapshot. Cancel only its lease waiter; an already
            // serialized save can continue in the host while recovery proceeds.
            if (!state.pendingSave && state.heavyLeaseWaiters.size > 0) {
              cancelPendingHeavyLeaseWaiters("Close is capturing a durable recovery revision.");
            }
            if (state.savePromise) {
              await state.savePromise;
            }
            if (
              state.closeControl !== closeControl ||
              closeControl.cancelled ||
              state.activeDocumentId !== documentId
            ) {
              result = false;
            } else if (!isDirty()) {
              result = true;
            } else {
              const reason = state.autoSavePaused
                ? "save-conflict"
                : state.autoSaveEnabled
                  ? "close-writeback"
                  : "auto-save-disabled";
              recovered = await requestRecovery(reason, closeDeadline, {
                closeRecovery: true,
              });
              const recoveryAck = state.lastCloseWritebackAck;
              closeControl.annotationBatchDurable = Boolean(
                recovered && recoveryAck?.documentId === documentId &&
                recoveryAck?.openRequest === state.activeOpenRequest &&
                recoveryAck?.revision === state.revision && recoveryAck.durable,
              );
              // A durable operation batch permits close. A stable empty diff
              // is also safe: there is no annotation change to recover.
              result = !isDirty() || closeControl.annotationBatchDurable;
            }
          }
        } else {
          if (state.savePromise) {
            result = await state.savePromise;
          }
          if (
            result === true &&
            state.activeDocumentId === documentId &&
            isEditBoundaryBusy()
          ) {
            result = await waitForInputBoundary(
              Math.max(0, closeDeadline - Date.now()),
            );
          }
          if (result === true && state.activeDocumentId === documentId && !isDirty()) {
            result = true;
          } else if (
            result === true &&
            state.activeDocumentId === documentId &&
            (!state.autoSaveEnabled || state.autoSavePaused)
          ) {
            const reason = state.autoSavePaused ? "save-conflict" : "auto-save-disabled";
            recovered = await requestRecovery(reason, closeDeadline);
            result = !isDirty();
          } else if (result === true && state.activeDocumentId === documentId) {
            if (state.pendingInkCommit) {
              state.committingInkForSave = true;
              try {
                state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
                state.pendingInkCommit = false;
              } finally {
                state.committingInkForSave = false;
              }
            }
            result = await requestSave("manual");
          }
        }
      }
    } catch (error) {
      result = false;
      showStatus(error?.message || "Could not prepare the PDF view to close.");
    }

    const dirty = documentId && state.activeDocumentId === documentId
      ? isDirty()
      : false;
    if (closeControl) {
      const recoveryIsCurrent = !!(
        recovered &&
        state.lastRecoveredDocumentId === documentId &&
        state.lastRecoveredRevision === state.revision &&
        !isEditBoundaryBusy() &&
        !state.pendingInkCommit
      );
      const durable = (result === true && !dirty) || recoveryIsCurrent;
      if (
        durable &&
        state.closeControl === closeControl &&
        closeControl.phase === "frozen" &&
        state.activeDocumentId === documentId
      ) {
        closeControl.phase = "prepared";
      }
      const prepared = !!(
        state.closeControl === closeControl &&
        closeControl.phase === "prepared" &&
        state.activeDocumentId === documentId &&
        ((result === true && !dirty) || recoveryIsCurrent)
      );
      if (!prepared) {
        clearCloseControl(closeControl);
      }
      const posted = postToHost("close-prepared", {
        id,
        documentId: closeControl.documentId,
        openRequest: closeControl.openRequest,
        revision: state.revision,
        ok: result === true && !dirty,
        dirty,
        recovered,
        closeWritebackQueued: closeControl.closeWritebackQueued === true,
        annotationBatchDurable: closeControl.annotationBatchDurable === true,
        prepared,
      });
      if (!posted && prepared) {
        clearCloseControl(closeControl);
      }
      return;
    }
    postToHost("flushed", {
      id,
      documentId,
      revision: state.revision,
      ok: result === true && !dirty,
      dirty,
      ...(recovered ? { recovered: true } : {}),
    });
  }

  function handleExternalAnnotationsUpdate(message) {
    if (
      message.documentId !== state.activeDocumentId ||
      message.openRequest !== state.activeOpenRequest
    ) return;
    if (message.sourceMatch === "MISMATCH") {
      handleAnnotationSourceMismatch(message);
      return;
    }
    if (!(["MATCH", "BASELINE_ESTABLISHED"].includes(message.sourceMatch))) {
      state.externalSourceConfirmed = false;
      sendError("Obsidian has not confirmed that the external annotations belong to this PDF revision.", {
        documentId: message.documentId,
        openRequest: message.openRequest,
        code: "external-annotation-source-unconfirmed",
      });
      return;
    }
    if (!message.externalAnnotations || typeof message.externalAnnotations !== "object") {
      sendError("Obsidian sent an invalid external annotation snapshot.", {
        documentId: message.documentId,
        openRequest: message.openRequest,
        code: "external-annotation-snapshot-invalid",
      });
      return;
    }
    if (!state.externalSourceConfirmed && message.identityConfirmed !== true) {
      // A sidecar notification can race the initial source-identity reply.
      // Keep the Reader locked; the confirming host response will carry a
      // fresh replayed snapshot after hash/page-identity validation.
      return;
    }
    state.pendingExternalAnnotationsUpdate = message;
    schedulePendingExternalAnnotationUpdate();
  }

  function handleAnnotationSourceMismatch(message) {
    if (
      message.documentId !== state.activeDocumentId ||
      message.openRequest !== state.activeOpenRequest
    ) return;
    clearAutoSaveTimer();
    state.autoSavePaused = true;
    state.externalSourceConfirmed = false;
    state.externalSourceMismatch = true;
    state.annotationSidebarController?.closeAndClear();
    state.readOnly = true;
    const loadedSource = state.externalSource;
    clearExternalHydration({
      clearRows: true,
      restoreEmbedded: true,
      preserveDirty: true,
    });
    const gateToken = state.nativeAnnotationGateToken;
    if (gateToken?.documentId === message.documentId &&
        gateToken?.openRequest === message.openRequest) {
      setNativeAnnotationLayersPending(false, gateToken);
    }
    state.externalSource = loadedSource;
    setReadOnlyState(true);
    showStatus(
      "PDF 来源已变化；外置批注已暂停加载和保存，原 PDF 未修改。请核对恢复记录。",
    );
  }

  async function handleExportCopy(message) {
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    const app = state.app;
    const pdfDocument = app?.pdfDocument;
    const requestId = message.requestId;
    const fail = (error) => postToHost("export-error", {
      requestId,
      documentId: message.documentId,
      openRequest: message.openRequest,
      message: String(error?.message || error || "PDF export failed."),
    });
    if (
      typeof requestId !== "string" || !requestId ||
      message.documentId !== documentId ||
      message.openRequest !== openRequest ||
      !pdfDocument
    ) {
      return fail(new Error("The PDF export request belongs to an inactive document session."));
    }
    let revision = state.revision;
    const startedAt = performance.now();
    try {
      const boundaryReached = await waitForInputBoundary(110000);
      if (!boundaryReached) return fail(new Error("Finish the current PDF annotation before exporting."));
      if (state.disposed || state.app !== app || app.pdfDocument !== pdfDocument ||
          state.activeDocumentId !== documentId || state.activeOpenRequest !== openRequest) {
        return fail(new Error("The PDF export request belongs to an inactive document session."));
      }
      if (state.pendingInkCommit) {
        state.committingInkForSave = true;
        try {
          app.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
          state.pendingInkCommit = false;
        } finally {
          state.committingInkForSave = false;
        }
      }
      prepareContentForSave();
      revision = state.revision;
      assertCompleteOperationSnapshot(captureOperationSnapshot(revision, "export"), "export");
      // This full PDF serialization is intentionally reachable only through
      // the explicit “export annotated copy” command. The result is returned
      // as a new file; it never replaces the immutable source PDF.
      const output = await pdfDocument.saveDocument();
      if (
        state.disposed || state.app !== app || app.pdfDocument !== pdfDocument ||
        state.activeDocumentId !== documentId || state.activeOpenRequest !== openRequest ||
        state.revision !== revision
      ) {
        throw new Error("The document changed during export; no output copy was created. Retry the export.");
      }
      const data = output instanceof ArrayBuffer
        ? output.slice(0)
        : ArrayBuffer.isView(output)
          ? output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
          : null;
      if (!data || !data.byteLength) throw new Error("PDF.js returned an empty export.");
      const outputBytes = data.byteLength;
      const posted = postToHost("export-ready", {
        requestId,
        documentId,
        openRequest,
        revision,
        data,
      }, [data]);
      if (!posted) throw new Error("Could not return the exported PDF to Obsidian.");
      runtimeLogRecord("pdf.export-copy", {
        documentId,
        openRequest,
        revision,
        bytes: outputBytes,
        durationMs: +(performance.now() - startedAt).toFixed(3),
      });
    } catch (error) {
      runtimeLogRecord("pdf.export-copy.error", {
        documentId,
        openRequest,
        revision,
        durationMs: +(performance.now() - startedAt).toFixed(3),
        error: runtimeLogError(error),
      });
      fail(error);
    }
  }

  function handlePrepareClose(message) {
    const openRequest = Number.isInteger(message.openRequest)
      ? message.openRequest
      : null;
    const hasValidRequest = !!(
      typeof message.id === "string" &&
      typeof message.documentId === "string"
    );
    const isCurrentDocument = !!(
      hasValidRequest &&
      message.documentId === state.activeDocumentId &&
      openRequest === state.activeOpenRequest
    );
    const hasNoDirtySession = !!(
      hasValidRequest &&
      !state.activeDocumentId &&
      !state.dirty &&
      !state.savePromise &&
      !state.recoveryPromise &&
      !state.pendingSave &&
      !state.pendingRecovery &&
      !state.app?._saveInProgress &&
      !state.pendingInkCommit &&
      !state.freeTextFocused &&
      !isInputBusy()
    );
    if (!isCurrentDocument && !hasNoDirtySession) {
      postToHost("close-prepared", {
        id: message.id,
        documentId: message.documentId,
        openRequest,
        revision: state.revision,
        ok: false,
        dirty: true,
        recovered: false,
        prepared: false,
      });
      return;
    }
    if (hasNoDirtySession) {
      const control = {
        id: message.id,
        documentId: message.documentId,
        openRequest,
        reason: message.reason === "view-transition" ? "view-transition" : "detach",
        phase: "closing",
        cancelled: false,
      };
      if (state.closeControl) {
        postToHost("close-prepared", {
          id: message.id,
          documentId: message.documentId,
          openRequest,
          revision: state.revision,
          ok: false,
          dirty: false,
          recovered: false,
          prepared: false,
        });
        return;
      }
      state.closeControl = control;
      clearManualPointerSessions();
      clearAutoSaveTimer();
      const frozen = setCloseInputInert(control);
      if (frozen) {
        control.phase = "prepared";
      }
      const posted = postToHost("close-prepared", {
        id: control.id,
        documentId: control.documentId,
        openRequest: control.openRequest,
        revision: state.revision,
        ok: frozen,
        dirty: false,
        recovered: false,
        prepared: frozen,
      });
      if (!posted || !frozen) {
        clearCloseControl(control);
      }
      return;
    }
    const existing = state.closeControl;
    if (existing) {
      if (!closeControlMatches(existing, { ...message, openRequest })) {
        postToHost("close-prepared", {
          id: message.id,
          documentId: message.documentId,
          openRequest,
          revision: state.revision,
          ok: false,
          dirty: isDirty(),
          recovered: false,
          prepared: false,
        });
        return;
      }
      if (existing.phase === "prepared") {
        postToHost("close-prepared", {
          id: existing.id,
          documentId: existing.documentId,
          openRequest: existing.openRequest,
          revision: state.revision,
          ok: !isDirty(),
          dirty: isDirty(),
          recovered:
            state.lastRecoveredDocumentId === existing.documentId &&
            state.lastRecoveredRevision === state.revision &&
            !state.pendingInkCommit,
          closeWritebackQueued: state.lastCloseWritebackAck?.documentId === existing.documentId &&
            state.lastCloseWritebackAck?.openRequest === openRequest &&
            state.lastCloseWritebackAck?.revision === state.revision &&
            state.lastCloseWritebackAck?.queued === true,
          prepared: true,
        });
      }
      return;
    }
    const control = {
      id: message.id,
      documentId: message.documentId,
      openRequest,
      reason: message.reason === "view-transition" ? "view-transition" : "detach",
      phase: "closing",
      cancelled: false,
    };
    state.closeControl = control;
    clearManualPointerSessions();
    clearAutoSaveTimer();
    void handleFlush(message, control).finally(() => {
      if (state.closeControl === control && control.phase !== "prepared") {
        clearCloseControl(control);
      }
    });
  }

  function handleCancelClose(message) {
    const control = state.closeControl;
    if (!closeControlMatches(control, message)) {
      return;
    }
    clearCloseControl(control);
  }

  function queueOpen(message) {
    if (state.disposed) {
      return;
    }
    // Any queued open invalidates a pending destructive confirmation before
    // the new document can become active in this iframe.
    state.bulkDeleteDialog?.close?.();
    state.embeddedDeletionTargets.clear();
    state.embeddedDeletionScan = null;
    state.requestedOpenRequest = Number.isInteger(message.openRequest)
      ? message.openRequest
      : null;
    state.requestedDocumentId = typeof message.documentId === "string" ? message.documentId : null;
    state.pendingVocabularySettings = {
      documentId: state.requestedDocumentId,
      openRequest: state.requestedOpenRequest,
      enabled: message.vocabularyEnabled === true,
      levels: normalizeVocabularyHighlightLevels(message.vocabularyHighlightLevels),
      displayMode: normalizeVocabularyDisplayMode(message.vocabularyDisplayMode),
      wordDisplayMode: message.vocabularyWordDisplayMode === "roots" ? "roots" : "whole",
    };
    state.vocabularyEnabled = state.pendingVocabularySettings.enabled;
    setVocabularyHighlightLevels(state.pendingVocabularySettings.levels);
    setVocabularyDisplayMode(state.pendingVocabularySettings.displayMode);
    if (!state.ready) {
      state.queuedOpens.push(message);
      return;
    }
    state.openQueue = state.openQueue
      .then(() => openDocument(message))
      .catch((error) => {
        sendError(error?.message || "Could not open the PDF.", {
          documentId: message.documentId,
          openRequest: message.openRequest,
          code: "open-failed",
        });
      });
  }

  function installInitialDeletionMask(app, session, snapshot, sourceHashConfirmed) {
    const viewer = app.pdfViewer;
    if (sourceHashConfirmed !== true || !viewer || typeof viewer.setDocument !== "function") return () => {};
    const refs = [...snapshot.annotations.filter(row => row.deleted && row.provenance === "embedded")]
      .filter(row => row.embeddedRef).map(row => row.embeddedRef);
    if (!refs.length) return () => {};
    const original = viewer.setDocument;
    const wrapped = function (pdfDocument, ...args) {
      if (pdfDocument && state.openSession === session && !session.signal.aborted &&
          snapshot.source?.pageCount === pdfDocument.numPages) {
        state.annotationController?.setEmbeddedDeletionMask?.(pdfDocument.annotationStorage, refs);
        runtimeLogRecord("external-annotation.before-first-render", { deletedReferences: refs.length });
      }
      return original.call(this, pdfDocument, ...args);
    };
    viewer.setDocument = wrapped;
    const restore = () => {
      if (viewer.setDocument === wrapped) viewer.setDocument = original;
      session.signal.removeEventListener("abort", restore);
    };
    session.signal.addEventListener("abort", restore, { once: true });
    runtimeLogRecord("external-annotation.initial-mask-installed", { deletedReferences: refs.length });
    return restore;
  }

  function createOpenSession(documentId) {
    const controller = new AbortController();
    return {
      id: ++state.openSessionSequence,
      documentId,
      controller,
      signal: controller.signal,
    };
  }

  function abortError() {
    const error = new Error("The PDF view was closed.");
    error.name = "AbortError";
    return error;
  }

  function waitForOpenSession(promise, session) {
    const { signal } = session;
    const pending = Promise.resolve(promise);
    if (signal.aborted) {
      pending.catch(() => {});
      return Promise.reject(abortError());
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });
  }

  function waitForDocumentLoaded(app, session) {
    // The Viewer dispatches documentloaded globally, with only the application
    // as its source. A prior document can still have asynchronous PDF.js
    // callbacks in flight while a replacement is opening, so that event alone
    // cannot identify which loading task finished. Mirror PDF.js's readiness
    // prerequisites against the exact current proxy instead: load() dispatches
    // documentloaded only after getDownloadInfo() and the viewer's first page
    // promise both settle.
    const loadingTask = app.pdfLoadingTask;
    const pdfDocument = app.pdfDocument;
    const pdfViewer = app.pdfViewer;
    if (
      !loadingTask ||
      !pdfDocument ||
      pdfDocument.loadingTask !== loadingTask ||
      pdfViewer?.pdfDocument !== pdfDocument
    ) {
      throw new Error("PDF.js did not keep the opened document active.");
    }
    session.loadingTask = loadingTask;
    session.pdfDocument = pdfDocument;
    const firstPagePromise = pdfViewer.firstPagePromise;
    if (!firstPagePromise) {
      throw new Error("PDF.js did not start loading the first page.");
    }
    return waitForOpenSession(
      Promise.all([pdfDocument.getDownloadInfo(), firstPagePromise]),
      session,
    ).then(() => {
      if (
        session.signal.aborted ||
        state.openSession !== session ||
        state.disposed ||
        app.pdfLoadingTask !== loadingTask ||
        app.pdfDocument !== pdfDocument ||
        pdfDocument.loadingTask !== loadingTask ||
        pdfViewer.pdfDocument !== pdfDocument
      ) {
        throw abortError();
      }
      return { loadingTask, pdfDocument };
    });
  }

  async function openDocument(message) {
    if (state.disposed) {
      return false;
    }
    prepareVocabularyOpen(message);
    cancelManualMomentum();
    invalidatePendingPenHighlight();
    const startedAt = performance.now();
    const { app } = state;
    const documentId = message.documentId;
    const syncApplyControl = state.syncApplyControl;
    const isSyncApply = !!(
      syncApplyControl &&
      syncApplyControl.phase === "applying" &&
      syncApplyControl.id === message.syncApplyControlId &&
      syncApplyControl.documentId === documentId &&
      syncApplyControl.openRequest === state.activeOpenRequest &&
      message.openRequest === syncApplyControl.openRequest + 1
    );
    if (state.syncApplyControl && !isSyncApply) {
      sendError("A synchronized PDF update is being applied.", {
        documentId,
        openRequest: message.openRequest,
        code: "open-blocked-by-sync-apply",
      });
      return false;
    }
    const documentPath =
      typeof message.documentPath === "string" ? message.documentPath : null;
    const filename =
      (typeof message.filename === "string" && message.filename) ||
      basename(documentPath || documentId);
    const restoreDirty = message.restoreDirty === true;
    const restoredRevision =
      Number.isSafeInteger(message.revision) && message.revision >= 0
        ? message.revision
        : 0;
    const restoredConfirmedRevision =
      Number.isSafeInteger(message.confirmedRevision) &&
      message.confirmedRevision >= 0
        ? message.confirmedRevision
        : restoreDirty
          ? 0
          : restoredRevision;
    const restorePaused = restoreDirty && message.restorePaused === true;
    if (
      state.closeControl?.phase !== "prepared" &&
      state.closeControl &&
      state.closeControl.documentId === state.activeDocumentId
    ) {
      sendError("The previous PDF is still preparing to close.", {
        documentId,
        openRequest: message.openRequest,
        code: "open-blocked-by-close-preparation",
      });
      return false;
    }

    const previousSession = captureAutoSaveSession();
    // A same-view file switch must finish the previous session before PDF.js
    // replaces its document and the bridge drops the old revision observer.
    if (state.activeDocumentId && !isSyncApply) {
      const finishPreviousSave = async (saveSucceeded) => {
        if (
          !saveSucceeded ||
          state.activeDocumentId !== previousSession.documentId
        ) {
          return false;
        }
        if (!isDirty()) {
          return true;
        }
        if (!state.autoSaveEnabled || state.autoSavePaused) {
          return false;
        }
        // An auto flight commits only the revision it started with. A file
        // switch is an explicit flush boundary, so write the latest safe
        // revision manually instead of treating that remaining dirty state
        // as a failed switch.
        const latestRevisionSaved = await requestSave("manual");
        return (
          latestRevisionSaved &&
          state.activeDocumentId === previousSession.documentId &&
          !isDirty()
        );
      };
      clearAutoSaveTimer();
      const recoveredDirtySessionCanSwitch = !!(
        isDirty() &&
        !state.savePromise &&
        !state.pendingSave &&
        !state.pendingRecovery &&
        !state.pendingInkCommit &&
        !isEditBoundaryBusy() &&
        state.lastRecoveredDocumentId === state.activeDocumentId &&
        state.lastRecoveredRevision === state.revision
      );
      if (
        state.autoSavePaused &&
        isDirty() &&
        !recoveredDirtySessionCanSwitch
      ) {
        sendError("The previous PDF still has unsaved changes.", {
          documentId,
          openRequest: message.openRequest,
          code: "open-blocked-by-unsaved-changes",
        });
        return;
      }
      if (recoveredDirtySessionCanSwitch) {
        // The exact dirty revision has a durable host recovery candidate. A
        // same-view file switch may now drop its in-memory PDF.js state.
      } else if (state.savePromise) {
        const priorSave = state.savePromise;
        if (state.autoSaveEnabled && !state.autoSavePaused) {
          // request/open can cancel the old timer while its save sequence is
          // waiting for a focused FreeText edit to become commit-ready.
          rearmPendingFreeTextAutoSave(previousSession);
          if (isInputBusy() && !(await waitForInputBoundary())) {
            sendError("The previous PDF still has unsaved changes.", {
              documentId,
              openRequest: message.openRequest,
              code: "open-blocked-by-unsaved-changes",
            });
            return;
          }
        } else if (isEditBoundaryBusy() && !state.pendingSave) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId,
            openRequest: message.openRequest,
            code: "open-blocked-by-unsaved-changes",
          });
          return;
        }
        const priorSaveSucceeded = await priorSave;
        if (!(await finishPreviousSave(priorSaveSucceeded))) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId,
            openRequest: message.openRequest,
            code: "open-blocked-by-unsaved-changes",
          });
          return;
        }
      } else if (isDirty()) {
        if (!state.autoSaveEnabled || state.autoSavePaused || isInputBusy()) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId,
            openRequest: message.openRequest,
            code: "open-blocked-by-unsaved-changes",
          });
          return;
        }
        if (state.pendingInkCommit) {
          state.committingInkForSave = true;
          try {
            app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
            state.pendingInkCommit = false;
          } finally {
            state.committingInkForSave = false;
          }
        }
        const sessionToSave = captureAutoSaveSession();
        const priorSave = requestSave("auto");
        rearmPendingFreeTextAutoSave(sessionToSave);
        const priorSaveSucceeded = await priorSave;
        if (!(await finishPreviousSave(priorSaveSucceeded))) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId,
            openRequest: message.openRequest,
            code: "open-blocked-by-unsaved-changes",
          });
          return;
        }
      }
    }
    if (!isSyncApply && state.closeControl?.phase === "prepared") {
      clearCloseControl(state.closeControl, { resume: false });
    }
    if (state.disposed) {
      return false;
    }
    stopOpenStartupObserver();
    const session = createOpenSession(documentId);
    state.openSession = session;
    if (isSyncApply) {
      syncApplyControl.applyingSession = session;
    }
    try {
      if (session.signal.aborted || state.disposed) {
        return false;
      }
      const gateToken = {
        documentId,
        openRequest: Number.isInteger(message.openRequest) ? message.openRequest : null,
        sessionId: session.id,
      };
      session.nativeAnnotationGateToken = gateToken;
      setNativeAnnotationLayersPending(true, gateToken);
      clearScheduledWork();
      cleanupStorageObserver();
      if (typeof message.heavyLeaseRequired === "boolean") {
        state.hostHeavyLeaseRequired = message.heavyLeaseRequired;
      }
      state.activeDocumentId = null;
      state.annotationSidebarController?.closeAndClear();
      updatePageNumberWidth(0);
      clearReaderBacklinkPresentation();
      clearExternalHydration({ clearRows: true, restoreEmbedded: true });
      state.externalSourceConfirmed = false;
      state.actualSourceIdentity = null;
      state.externalSourceMismatch = false;
      state.activeDocumentPath = null;
      state.activeFilename = null;
      state.activeOpenRequest = null;
      state.readOnly = true;
      setReadOnlyState(true);
      state.dirty = false;
      syncBridgeControls();
      state.editorHistory.canUndo = false;
      state.editorHistory.canRedo = false;
      state.editorHistory.hasSelection = false;
      state.revision = 0;
      state.confirmedRevision = 0;
      state.lastRecoveredDocumentId = null;
      state.lastRecoveredRevision = null;
      state.lastCloseWritebackAck = null;
      state.autoSavePaused = false;
      state.lastAutoSaveStartedAt = null;
      state.lastAutoSaveDurationMs = 0;
      if (typeof message.autoSave === "boolean") {
        state.autoSaveEnabled = message.autoSave;
      }
      const data = new Uint8Array(message.data);
      if (typeof state.pdfJsOpen !== "function") {
        throw new Error("PDF.js open handler is unavailable.");
      }
      const provisionalExternal = validateExternalAnnotations(message.externalAnnotations);
      const restoreSetDocument = installInitialDeletionMask(app, session, provisionalExternal, message.sourceHashConfirmed);
      const parseStartedAt = performance.now();
      const pdfOpenStages = {};
      const stageListeners = [["pagesinit", "pdfPagesInitMs"], ["documentloaded", "pdfDocumentLoadedMs"],
        ["pagerendered", "pdfFirstRenderMs"]].map(([event, key]) => {
        const listener = () => { if (!Number.isFinite(pdfOpenStages[key])) pdfOpenStages[key] = Math.max(0, performance.now() - parseStartedAt); };
        app.eventBus?._on?.(event, listener);
        return [event, listener];
      });
      session.previousLoadingTask = app.pdfLoadingTask;
      session.previousPdfDocument = app.pdfDocument;
      try {
        session.pdfJsOpenPromise = Promise.resolve(
          state.pdfJsOpen.call(app, {
            data,
            filename,
            sourceKind: "generic-source",
            localSessionId: null,
            canOverwriteOriginal: false,
          }),
        );
        await waitForOpenSession(session.pdfJsOpenPromise, session);
      } finally {
        for (const [event, listener] of stageListeners) app.eventBus?._off?.(event, listener);
        restoreSetDocument();
      }
      session.loadingTask = app.pdfLoadingTask;
      const parsedAt = performance.now();

      const { pdfDocument } = await waitForDocumentLoaded(app, session);
      if (session.signal.aborted || state.disposed) {
        return false;
      }
      cleanupStorageObserver();
      state.activeDocumentId = documentId;
      updatePageNumberWidth(pdfDocument.numPages);
      if (Number.isSafeInteger(message.initialPageNumber) && message.initialPageNumber > 0) {
        app.pdfViewer.currentPageNumber = Math.min(message.initialPageNumber, pdfDocument.numPages);
      }
      state.activeDocumentPath = documentPath;
      state.activeFilename = filename;
      state.activeOpenRequest = Number.isInteger(message.openRequest)
        ? message.openRequest
        : null;
      annotationToolColors?.applySnapshot(message.preferredAnnotationToolColors);
      bindVocabularyToOpenedDocument(documentId, state.activeOpenRequest);
      // Source identity is asynchronous; never accept edits before the host
      // confirms the source hash and ordered page identity after PDF parse.
      state.readOnly = true;
      state.dirty = restoreDirty;
      state.revision = isSyncApply ? 0 : restoredRevision;
      state.confirmedRevision = isSyncApply ? 0 : restoredConfirmedRevision;
      state.autoSavePaused = restorePaused;
      applySyncIdentities(message.syncState, { reset: true });
      state.syncDeviceId =
        (typeof message.deviceId === "string" && message.deviceId) ||
        (typeof message.actorId === "string" && message.actorId) ||
        state.syncActorId;
      state.externalSource = provisionalExternal.source;
      state.compactInkEncoding = provisionalExternal.compactInkEncoding === true;
      applyLegacyAnnotationIdentities(provisionalExternal.legacyIdentities);
      state.externalAnnotationRows.clear();
      state.externalAnnotationRefs.clear();
      state.externalDeletionGuards.clear();
      state.annotationSnapshot = getAnnotationStorageRows(app);
      const loadedSnapshot = snapshotChanges(app);
      restoreChanges(app, {
        hadAnnotationChanges:
          restoreDirty || loadedSnapshot.hadAnnotationChanges,
        hadStructuralChanges: loadedSnapshot.hadStructuralChanges,
      });
      app._contentDispositionFilename = filename;
      app.setTitle(filename);
      observeAnnotationStorage(app.pdfDocument?.annotationStorage);
      observeEditorManager(app);
      observeAccessibilityManagers(app);
      await hydrateRenderedExternalPages(app);
      setReadOnlyState(state.readOnly);

      if (isSyncApply) {
        await restoreSyncViewState(app, message.viewState, session);
      }

      if (state.activeDocumentId !== documentId || state.disposed) {
        return false;
      }
      if (message.deferredAnnotationInitialization !== true) void reportAnnotationSourceIdentity(pdfDocument, message.externalAnnotations).catch((error) => {
        runtimeLogRecord("annotation-source-identity.error", {
          documentId,
          openRequest: state.activeOpenRequest,
          error: runtimeLogError(error),
        });
        postToHost("annotation-source-identity", {
          documentId,
          openRequest: state.activeOpenRequest,
          sourceHash: message.externalAnnotations?.source?.sourceHash || null,
          pageCount: pdfDocument.numPages,
          orderedPageIdentities: Array(pdfDocument.numPages).fill(null),
          identityStatus: "UNKNOWN",
        });
      });
      if (!isSyncApply) {
        if (message.deferredAnnotationInitialization === true) {
          // Give the page its first completed paint before the host starts
          // annotation hashing and JSONL reads.
          await waitForOpenSession(app.pdfViewer.onePageRendered, session);
          await waitForOpenSession(new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))), session);
        }
        const startupTimings = captureOpenStartupTimings({
          startedAt,
          parseStartedAt,
          parsedAt,
          app,
          pdfDocument,
        });
        Object.assign(startupTimings, pdfOpenStages);
        const openedPosted = postToHost("opened", {
          documentId,
          documentPath,
          filename,
          openRequest: state.activeOpenRequest,
          revision: state.revision,
          confirmedRevision: state.confirmedRevision,
          dirty: isDirty(),
          restorePaused: state.autoSavePaused,
          syncState: state.syncState,
          startupTimings,
        });
        if (openedPosted) {
          observeOpenStartupStages({
            startedAt,
            app,
            pdfDocument,
            session,
            documentId,
            openRequest: state.activeOpenRequest,
            reportedTimings: startupTimings,
          });
        }
      }
      return true;
    } catch (error) {
      if (session.signal.aborted || state.disposed) {
        return false;
      }
      if (session.nativeAnnotationGateToken) {
        setNativeAnnotationLayersPending(false, session.nativeAnnotationGateToken);
      }
      cleanupStorageObserver();
      state.activeDocumentId = null;
      state.annotationSidebarController?.closeAndClear();
      updatePageNumberWidth(0);
      clearReaderBacklinkPresentation();
      clearExternalHydration({ clearRows: true, restoreEmbedded: true });
      state.externalSourceConfirmed = false;
      state.actualSourceIdentity = null;
      state.externalSourceMismatch = false;
      state.activeDocumentPath = null;
      state.activeFilename = null;
      state.activeOpenRequest = null;
      state.readOnly = false;
      state.dirty = false;
      state.revision = 0;
      state.confirmedRevision = 0;
      state.autoSavePaused = false;
      state.hostHeavyLeaseRequired = false;
      state.lastAutoSaveStartedAt = null;
      state.lastAutoSaveDurationMs = 0;
      setReadOnlyState(false);
      if (isSyncApply) {
        throw error;
      }
      sendError(error?.message || "Could not open the PDF.", {
        documentId,
          openRequest: message.openRequest,
        code: "open-failed",
      });
      return false;
    } finally {
      if (state.openSession === session) {
        state.openSession = null;
      }
    }
  }

  const readOnlyToolIds = [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
    "editorCommentButton",
    "editorEraserButton",
    "editorStampButton",
    "editorSignatureButton",
  ];

  function setReadOnlyState(readOnly) {
    document.documentElement.toggleAttribute(
      "data-pdf-reader-readonly",
      readOnly,
    );
    if (readOnly && !state.readOnlyButtonStates) {
      state.readOnlyButtonStates = new Map();
    }
    for (const id of readOnlyToolIds) {
      const button = document.getElementById(id);
      if (button) {
        if (readOnly) {
          state.readOnlyButtonStates?.set(id, button.disabled);
          button.disabled = true;
        } else if (state.readOnlyButtonStates?.has(id)) {
          button.disabled = state.readOnlyButtonStates.get(id);
        }
      }
    }
    if (!readOnly) {
      state.readOnlyButtonStates = null;
    }
    syncBridgeControls();
  }

  function onReadOnlyHotkey(event) {
    if (
      !state.readOnly ||
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    ) {
      return;
    }
    const target = event.target;
    if (
      target instanceof Element &&
      (target.matches(
        "input, textarea, select, [contenteditable='true'], [role='textbox']",
      ) ||
        target.closest(
          "input, textarea, select, [contenteditable='true'], [role='textbox']",
        ))
    ) {
      return;
    }
    if (/^[1-5]$/.test(event.key) || /^Numpad[1-5]$/.test(event.code)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function onViewerBeforeUnload(event) {
    // Obsidian owns the view lifecycle and its file-save flow. Do not let the
    // generic browser Viewer open a page-unload confirmation inside its iframe.
    event.stopImmediatePropagation();
  }

  function onHostMessage(event) {
    if (event.source !== window.parent) {
      return;
    }
    const message = event.data;
    if (
      !message ||
      typeof message !== "object" ||
      message.channel !== channel ||
      message.token !== token
    ) {
      return;
    }
    if (
      state.disposed &&
      message.type !== "heavy-granted" &&
      message.type !== "heavy-rejected"
    ) {
      return;
    }

    if (message.type === "open") {
      if (
        typeof message.documentId !== "string" ||
        (message.rendererGeneration != null &&
          message.rendererGeneration !== rendererGeneration) ||
        !(message.data instanceof ArrayBuffer)
      ) {
        sendError("The host sent an invalid PDF open request.", {
          documentId:
            typeof message.documentId === "string" ? message.documentId : null,
          code: "invalid-open-request",
        });
        return;
      }
      queueOpen(message);
      return;
    }

    if (message.type === "annotation-tool-color-preference-update") {
      if (message.rendererGeneration === rendererGeneration &&
          message.documentId === state.activeDocumentId &&
          message.openRequest === state.activeOpenRequest) {
        annotationToolColors?.applySnapshot(message.colors);
      }
      return;
    }

    if (message.type === "get-input-diagnostics") {
      if (
        typeof message.requestId !== "string" ||
        message.requestId.length === 0 ||
        message.requestId.length > 128
      ) {
        return;
      }
      postToHost("input-diagnostics", inputDiagnosticsSnapshot(message.requestId));
      return;
    }

    if (message.type === "configure-auto-save") {
      if (typeof message.enabled !== "boolean") {
        return;
      }
      state.autoSaveEnabled = message.enabled;
      if (!state.autoSaveEnabled) {
        clearAutoSaveTimer();
      } else if (isDirty() || state.autoSavePending) {
        scheduleAutoSave();
      }
      return;
    }

    if (message.type === "rename") {
      if (
        message.documentId !== state.activeDocumentId ||
        !state.activeDocumentId
      ) {
        return;
      }
      if (typeof message.documentPath === "string") {
        state.activeDocumentPath = message.documentPath;
      }
      if (typeof message.filename === "string" && message.filename) {
        state.activeFilename = message.filename;
        state.app._contentDispositionFilename = message.filename;
        state.app.setTitle(message.filename);
      }
      return;
    }

    if (message.type === "reader-anchor-capture-request") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest ||
          typeof message.requestId !== "string" || message.requestId.length > 128 ||
          !["reader", "quote", "annotation", "backlinks", "occurrence"].includes(message.mode)) return;
      sendReaderAnchorCapture(message.requestId, message.mode, {
        pageNumber: message.pageNumber,
        startIndex: message.startIndex,
        endIndex: message.endIndex,
        expectedSurface: message.expectedSurface,
      });
      return;
    }

    if (message.type === "reader-anchor-occurrence-result") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest) return;
      state.vocabularyController?.handleOccurrenceLinkResult?.(message);
      return;
    }

    if (message.type === "reader-vocabulary-context-preview") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest) return;
      state.vocabularyController?.handleVocabularyContextPreview?.(message);
      return;
    }

    if (message.type === "reader-vocabulary-context-save-result") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest) return;
      state.vocabularyController?.handleVocabularyContextSaveResult?.(message);
      return;
    }

    if (message.type === "annotation-sidebar-review-draft") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId || message.openRequest !== state.activeOpenRequest ||
          typeof message.uuid !== "string" || !message.uuid || message.uuid.length > 512) return;
      state.annotationSidebarController?.createReviewDraft?.(message.uuid);
      return;
    }

    if (message.type === "reader-anchor-navigate") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest) return;
      void navigateReaderAnchor(message);
      return;
    }

    if (message.type === "reader-backlink-page-refresh") {
      const actual = state.actualSourceIdentity;
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest ||
          actual?.identityStatus !== "KNOWN" || message.sourceHash !== actual.sourceHash ||
          !Number.isSafeInteger(message.pageIndex) || message.pageIndex < 0 ||
          message.pageNumber !== message.pageIndex + 1 ||
          message.pageNumber !== state.app?.pdfViewer?.currentPageNumber ||
          message.pageIdentity !== actual.orderedPageIdentities?.[message.pageIndex]) return;
      requestReaderBacklinksForPage(message.pageNumber, true);
      return;
    }

    if (message.type === "reader-backlink-page-results") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest) return;
      void applyReaderBacklinkPageResults(message);
      return;
    }

    if (message.type === "reader-backlink-occurrence-result") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest) return;
      state.vocabularyController?.handleOccurrenceBacklinks?.(message);
      return;
    }

    if (message.type === "vocab-set-enabled") {
      handleVocabularyEnabledMessage(message);
      return;
    }

    if (message.type === "vocab-set-highlight-levels") {
      handleVocabularyHighlightLevelsMessage(message);
      return;
    }

    if (message.type === "vocab-set-display-mode") {
      handleVocabularyDisplayModeMessage(message);
      return;
    }

    if (message.type === "vocab-set-word-mode") {
      handleVocabularyWordDisplayModeMessage(message);
      return;
    }

    if (message.type === "vocab-page-results") {
      if (message.rendererGeneration !== rendererGeneration) return;
      state.vocabularyController?.handlePageResults?.(message);
      return;
    }

    if (message.type === "vocab-entry-result") {
      if (message.rendererGeneration !== rendererGeneration) return;
      state.vocabularyController?.handleEntryResult?.(message);
      return;
    }

    if (message.type === "vocab-status-ack") {
      if (message.rendererGeneration !== rendererGeneration || message.durable !== true) return;
      state.vocabularyController?.handleStatusAck?.(message);
      return;
    }

    if (message.type === "vocab-status-error") {
      if (message.rendererGeneration !== rendererGeneration) return;
      state.vocabularyController?.handleStatusError?.(message);
      return;
    }

    if (message.type === "vocab-selection-request") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.documentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest) return;
      const handled = state.vocabularyController?.handleSelectionRequest?.(message);
      if (!handled) {
        postToHost("vocab-selection-rejected", {
          requestId: message.requestId,
          code: "vocabulary-disabled",
          documentId: state.activeDocumentId,
          openRequest: state.activeOpenRequest,
        });
      }
      return;
    }

    if (message.type === "vocab-page-refresh") {
      if (message.rendererGeneration !== rendererGeneration) return;
      state.vocabularyController?.refreshPageFromHost?.(message);
      return;
    }

    if (message.type === "vocab-selection-ack") {
      if (message.rendererGeneration !== rendererGeneration || message.durable !== true) return;
      state.vocabularyController?.refreshPageFromHost?.(message);
      return;
    }

    if (message.type === "annotation-maintenance-probe") {
      if (message.documentId !== state.activeDocumentId || message.openRequest !== state.activeOpenRequest) return;
      postToHost("annotation-maintenance-state", {
        probeId: message.probeId, documentId: state.activeDocumentId, openRequest: state.activeOpenRequest,
        idle: !state.disposed && document.visibilityState !== "hidden" && !isEditBoundaryBusy() &&
          !isDirty() && !state.savePromise && !state.recoveryPromise && !state.closeControl,
      });
      return;
    }

    if (message.type === "annotation-initialize-late") {
      if (message.rendererGeneration !== rendererGeneration ||
          message.previousDocumentId !== state.activeDocumentId ||
          message.openRequest !== state.activeOpenRequest ||
          typeof message.documentId !== "string" || !state.readOnly ||
          !state.app?.pdfDocument) return;
      const snapshot = validateExternalAnnotations(message.externalAnnotations);
      state.activeDocumentId = message.documentId;
      if (state.nativeAnnotationGateToken) state.nativeAnnotationGateToken.documentId = message.documentId;
      state.externalSource = snapshot.source;
      state.compactInkEncoding = snapshot.compactInkEncoding === true;
      applyLegacyAnnotationIdentities(snapshot.legacyIdentities);
      bindVocabularyToOpenedDocument(message.documentId, message.openRequest);
      void reportAnnotationSourceIdentity(state.app.pdfDocument, message.externalAnnotations).catch((error) => {
        sendError(error.message || "Could not verify PDF annotations.", {
          documentId: message.documentId, openRequest: message.openRequest,
          code: "annotation-source-identity-failed",
        });
      });
      return;
    }

    if (message.type === "external-annotations-update") {
      handleExternalAnnotationsUpdate(message);
      return;
    }

    if (message.type === "annotation-source-mismatch") {
      handleAnnotationSourceMismatch(message);
      return;
    }

    if (message.type === "export-copy") {
      void handleExportCopy(message);
      return;
    }

    if (message.type === "flush") {
      void handleFlush(message);
      return;
    }

    if (message.type === "sync-checkpoint") {
      handleSyncCheckpoint(message);
      return;
    }

    if (message.type === "sync-apply-prepare") {
      void handleSyncApplyPrepare(message);
      return;
    }

    if (message.type === "sync-apply-cancel") {
      void handleSyncApplyCancel(message);
      return;
    }

    if (message.type === "sync-apply") {
      void applySyncSnapshot(message);
      return;
    }

    if (message.type === "heavy-granted") {
      if (
        typeof message.id !== "string" ||
        typeof message.leaseId !== "string" ||
        !message.leaseId
      ) {
        return;
      }
      const waiter = state.heavyLeaseWaiters.get(message.id);
      if (!waiter) {
        const cancelled = state.cancelledHeavyLeaseRequests.get(message.id);
        if (cancelled) {
          state.cancelledHeavyLeaseRequests.delete(message.id);
          releaseHostHeavyLease(
            { leaseId: message.leaseId },
            cancelled.documentId,
          );
        }
        finishDisposedHeavyLeaseCleanup();
        return;
      }
      if (
        !hasCompatibleHostAckGeneration(message) ||
        (typeof message.documentId === "string" &&
          message.documentId !== waiter.documentId) ||
        (Number.isInteger(message.openRequest) &&
          message.openRequest !== waiter.openRequest) ||
        state.disposed ||
        !state.hostHeavyLeaseRequired ||
        state.activeDocumentId !== waiter.documentId ||
        state.activeOpenRequest !== waiter.openRequest
      ) {
        finishHeavyLeaseWaiter(waiter);
        rememberCancelledHeavyLease(waiter);
        releaseHostHeavyLease({ leaseId: message.leaseId }, waiter.documentId);
        const error = new Error("The PDF save lease belongs to an old document session.");
        error.cancelled = true;
        waiter.reject(error);
        finishDisposedHeavyLeaseCleanup();
        return;
      }
      finishHeavyLeaseWaiter(waiter);
      waiter.resolve({ id: message.id, leaseId: message.leaseId });
      finishDisposedHeavyLeaseCleanup();
      return;
    }

    if (message.type === "heavy-rejected") {
      if (typeof message.id !== "string") {
        return;
      }
      const waiter = state.heavyLeaseWaiters.get(message.id);
      if (waiter) {
        if (
          !hasCompatibleHostAckGeneration(message) ||
          (typeof message.documentId === "string" &&
            message.documentId !== waiter.documentId) ||
          (Number.isInteger(message.openRequest) &&
            message.openRequest !== waiter.openRequest)
        ) {
          return;
        }
        finishHeavyLeaseWaiter(waiter);
        state.cancelledHeavyLeaseRequests.delete(message.id);
        const error = new Error(
          message.message || message.reason ||
            "Obsidian could not grant the PDF save lease.",
        );
        error.code = message.code;
        error.fromHost = true;
        waiter.reject(error);
      } else {
        state.cancelledHeavyLeaseRequests.delete(message.id);
      }
      finishDisposedHeavyLeaseCleanup();
      return;
    }

    if (message.type === "prepare-close") {
      handlePrepareClose(message);
      return;
    }

    if (message.type === "cancel-close") {
      handleCancelClose(message);
      return;
    }

    if (message.type === "recovered") {
      const pending = state.pendingRecovery;
      if (
        !pending ||
        message.requestId !== pending.requestId ||
        message.documentId !== pending.documentId ||
        message.openRequest !== pending.openRequest ||
        !hasCompatibleHostAckGeneration(message)
      ) {
        return;
      }
      if (message.revision !== pending.revision) {
        pending.reject(
          new Error("Obsidian acknowledged a different recovery revision."),
        );
        return;
      }
      if (message.ok !== true) {
        pending.reject(new Error(message.message || "Obsidian did not durably acknowledge the recovery batch."));
        return;
      }
      if (!validateOperationAcknowledgement(message, pending)) {
        runtimeLogRecord("annotation-operation.ack-mismatch", {
          phase: "recovery",
          revision: message.revision,
          expectedOperationCount: pending.operationCount,
          receivedOperationCount: Number.isSafeInteger(message.operationCount) ? message.operationCount : null,
          hasBatchId: typeof message.batchId === "string" && message.batchId.length > 0,
        });
        const error = new Error("Obsidian acknowledged the recovery revision without confirming the complete operation batch.");
        error.code = "PDF_ANNOTATION_ACK_MISMATCH";
        pending.reject(error);
        return;
      }
      runtimeLogRecord("annotation-operation.ack", {
        phase: "recovery",
        revision: message.revision,
        operationCount: message.operationCount,
        batchId: message.batchId,
        durable: true,
      });
      pending.resolve(message);
      return;
    }

    if (
      message.type === "saved" ||
      message.type === "error" ||
      message.type === "recovery-error"
    ) {
      const recovery = state.pendingRecovery;
      if (
        recovery &&
        message.requestId === recovery.requestId &&
        message.documentId === recovery.documentId &&
        message.openRequest === recovery.openRequest &&
        message.revision === recovery.revision &&
        hasCompatibleHostAckGeneration(message)
      ) {
        const error = new Error(
          message.message || "Obsidian could not save the PDF recovery copy.",
        );
        error.code = message.code;
        error.fromHost = true;
        recovery.reject(error);
        return;
      }
      const pending = state.pendingSave;
      if (
        !pending ||
        message.requestId !== pending.requestId ||
        message.documentId !== pending.documentId ||
        message.openRequest !== pending.openRequest ||
        message.revision !== pending.revision ||
        !hasCompatibleHostAckGeneration(message)
      ) {
        return;
      }
      if (message.type === "saved") {
        if (message.revision !== pending.revision) {
          pending.reject(
            new Error("Obsidian acknowledged a different PDF revision."),
          );
          return;
        }
        if (!validateOperationAcknowledgement(message, pending)) {
          runtimeLogRecord("annotation-operation.ack-mismatch", {
            phase: "save",
            revision: message.revision,
            expectedOperationCount: pending.operationCount,
            receivedOperationCount: Number.isSafeInteger(message.operationCount) ? message.operationCount : null,
            hasBatchId: typeof message.batchId === "string" && message.batchId.length > 0,
          });
          const error = new Error("Obsidian acknowledged the revision without confirming the complete annotation operation batch.");
          error.code = "PDF_ANNOTATION_ACK_MISMATCH";
          pending.reject(error);
          return;
        }
        if (typeof message.nativeSourceHash === "string" && state.activeDocumentId === pending.documentId) {
          if (state.externalSource) state.externalSource = { ...state.externalSource, sourceHash: message.nativeSourceHash };
          if (state.actualSourceIdentity) state.actualSourceIdentity = { ...state.actualSourceIdentity, sourceHash: message.nativeSourceHash };
          state.externalSourceConfirmed = true;
          state.externalSourceMismatch = false;
        }
        runtimeLogRecord("annotation-operation.ack", {
          phase: "save",
          revision: message.revision,
          operationCount: message.operationCount,
          batchId: message.batchId,
          durable: true,
        });
        if (
          message.syncState &&
          state.activeDocumentId === pending.documentId &&
          state.activeOpenRequest === pending.openRequest
        ) {
          applySyncIdentities(message.syncState);
        }
        clearConfirmedDirtyState(message.revision);
        if (message.externalAnnotations) {
          state.pendingExternalAnnotationsUpdate = {
            documentId: message.documentId,
            openRequest: message.openRequest,
            externalAnnotations: message.externalAnnotations,
          };
        }
        schedulePendingExternalAnnotationUpdate();
        pending.resolve(message);
      } else {
        const error = new Error(
          message.message || "Obsidian could not save the PDF.",
        );
        error.code = message.code;
        error.fromHost = true;
        pending.reject(error);
      }
    }
  }

  function installAppHooks(app) {
    state.app = app;

    // Retain PDF.js's loader for documents explicitly supplied by Obsidian,
    // but prevent the Viewer file picker/drop path from changing the document
    // while the bridge still associates saves with the host's vault path.
    state.pdfJsOpen = app.open;
    state.pdfJsClose = app.close;
    app.open = async () => {
      showStatus("Open PDFs from the Obsidian file list.");
      return false;
    };
    const localOpenGuard = (event) => {
      const target = event.target;
      const isFileInputChange =
        event.type === "change" &&
        target instanceof HTMLInputElement &&
        target.type === "file";
      const transfer = event.dataTransfer;
      const containsFiles =
        !!transfer?.files?.length ||
        Array.from(transfer?.items || []).some((item) => item.kind === "file");

      if (!isFileInputChange && !containsFiles) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      showStatus("Open PDFs from the Obsidian file list.");
    };
    state.localOpenAbortController = new AbortController();
    for (const type of ["change", "dragover", "drop"]) {
      document.addEventListener(type, localOpenGuard, {
        capture: true,
        signal: state.localOpenAbortController.signal,
      });
    }

    const originalRun = app.run;
    app.run = async function (config) {
      try {
        return await originalRun.call(this, config);
      } catch (error) {
        state.startupFailed = true;
        clearTimeout(state.startupTimer);
        console.error("PDF.js viewer initialization failed:", error);
        sendError(error?.message || "Could not initialize the PDF viewer.", {
          documentId: state.activeDocumentId,
          code: "viewer-init-failed",
        });
        return undefined;
      }
    };

    // PDF.js binds these methods to its event bus during run(). Replacing them
    // during webviewerloaded ensures toolbar save/download actions go to the
    // host instead of starting a browser download or local-server request.
    app.downloadOrSave = requestSave;
    app.downloadCopy = requestSave;
    app.save = requestSave;
    app._openLocalFile = async () => {
      showStatus("Open PDFs from the Obsidian file list.");
      return true;
    };
    // PDF.js maps Ctrl+S to `overwriteoriginal`, while toolbar download/save
    // controls use `download` / `downloadcopy`. Route all of them through the
    // same host-mediated save path; do not invoke the fork's local-session API.
    app.overwriteOriginal = requestSave;
    app._scheduleAutoOverwriteOriginal = () => {};
    app._clearAutoOverwriteOriginalTimer?.();

    app.initializedPromise
      .then(() => {
        if (state.disposed || state.startupFailed) {
          return;
        }
        clearTimeout(state.startupTimer);
        state.eventAbortController = new AbortController();
        if (state.vocabularyEnabled) ensureVocabularyController();
        ensureBacklinkInteractionController();
        app.eventBus?._on(
          "pagerendered",
          ({ pageNumber }) => runAnnotationObserver("viewer.page-rendered", () => {
            if (state.activeDocumentId && Number.isInteger(pageNumber)) {
              observeAccessibilityManager(
                app,
                app.pdfViewer?.getPageView?.(pageNumber - 1),
              );
            }
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "textlayerrendered",
          ({ pageNumber }) => runAnnotationObserver("viewer.text-layer", () => {
            state.annotationSidebarTextGeometryCache = new WeakMap();
            state.annotationSidebarController?.refreshIfOpen();
            const results = state.readerBacklinkPageResults;
            if (results?.pageNumber === pageNumber) void applyReaderBacklinkPageResults(results);
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "pagesloaded",
          ({ pagesCount } = {}) => runAnnotationObserver("viewer.pages-loaded", () => {
            updatePageNumberWidth(pagesCount);
            observeAccessibilityManagers(app);
            void hydrateRenderedExternalPages(app).catch((error) => {
              runtimeLogRecord("external-annotation.hydrate-pages-error", {
                error: runtimeLogError(error),
              });
            });
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "pagechanging",
          () => runAnnotationObserver("viewer.pagechanged", () => {
            syncBridgeControls();
            requestReaderBacklinksForPage();
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "annotationlayerrendered",
          ({ pageNumber }) => runAnnotationObserver("viewer.annotation-layer", () => {
            if (state.activeDocumentId && Number.isInteger(pageNumber)) {
              const pageIndex = pageNumber - 1;
              for (const row of externalAnnotationMaskRows()) {
                if (row.pageIndex === pageIndex && row.embeddedRef &&
                    (row.deleted !== true || row.provenance === "external" || row.provenance === "embedded")) {
                  suppressEmbeddedAnnotation(pageIndex, row.embeddedRef);
                }
              }
            }
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "annotationeditorlayerrendered",
          ({ pageNumber }) => runAnnotationObserver("viewer.editor-layer", () => {
            if (state.activeDocumentId && Number.isInteger(pageNumber)) {
              runAnnotationObserver("input.layer-ready", () => state.annotationController?.notifyInputBoundary?.());
              observeAccessibilityManager(
                app,
                app.pdfViewer?.getPageView?.(pageNumber - 1),
              );
              void hydrateExternalAnnotationsForPage(pageNumber - 1).then((hydrated) => {
                if (!hydrated) scheduleExternalAnnotationHydrationRetry(pageNumber - 1);
              }).catch((error) => {
                runtimeLogRecord("external-annotation.hydrate-page-error", {
                  pageIndex: pageNumber - 1,
                  error: runtimeLogError(error),
                });
              });
              const backlinks = state.readerBacklinkPageResults;
              if (backlinks?.pageNumber === pageNumber) void applyReaderBacklinkPageResults(backlinks);
            }
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "switchannotationeditormode",
          ({ mode }) => {
            // PDF.js completes mode changes asynchronously. Stop touch
            // momentum when eraser selection is requested, before that await.
            if (mode === 17 && iosInputPolicy) {
              state.viewportController?.interruptNativeScroll(
                document.getElementById("viewerContainer"),
              );
            }
          },
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "annotationeditormodechanged",
          ({ mode, isFromKeyboard }) => runAnnotationObserver("viewer.editor-mode", () => {
            annotationToolColors?.onEditorModeChanged(mode);
            if (mode !== 0 && isFromKeyboard) state.annotationController?.cancelPendingReadMode?.();
            cancelManualMomentum();
            invalidatePendingPenHighlight();
            state.editorMode = mode;
            if (PERSISTABLE_ANNOTATION_TOOL_MODES.has(mode) && !state.readOnly &&
                state.activeDocumentId && Number.isInteger(state.activeOpenRequest)) {
              postToHost("annotation-tool-preference-request", {
                mode,
                documentId: state.activeDocumentId,
                openRequest: state.activeOpenRequest,
              });
            }
            state.inputPolicy?.onToolChange?.();
            if (annotationToolIsActive()) {
              refreshFingerTextSelectionSuppression();
            } else {
              clearFingerTextSelectionSuppression();
            }
            observeAccessibilityManagers(app);
            const documentId = state.activeDocumentId;
            const openRequest = state.activeOpenRequest;
            const pdfDocument = app.pdfDocument;
            setDeferredTimeout(() => {
              if (state.disposed || state.app !== app || app.pdfDocument !== pdfDocument ||
                  state.activeDocumentId !== documentId || state.activeOpenRequest !== openRequest) return;
              annotationToolColors?.onEditorModeChanged(mode);
              runAnnotationObserver("viewer.editor-mode-deferred", () => observeAccessibilityManagers(app));
              // Enabling a PDF.js tool recreates native source editors without
              // emitting a new page-layer render. Reapply verified tombstones.
              void hydrateRenderedExternalPages(app).catch(error => {
                runtimeLogRecord("external-annotation.tool-hydrate-error", { error: runtimeLogError(error) });
              });
            }, 0);
            if (mode !== 0) {
              cancelPendingFreeTextAppearanceRepair();
            }
            if (state.readOnly) {
              setReadOnlyState(true);
            }
            syncBridgeControls();
            state.annotationController?.notifyInputBoundary?.();
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "editingstateschanged",
          ({ details = {} }) => runAnnotationObserver("viewer.editor-history", () => {
            annotationToolColors?.onEditorStatesChanged(details);
            setDeferredTimeout(() => annotationToolColors?.onEditorStatesChanged(details), 0);
            if (typeof details.hasSomethingToUndo === "boolean") {
              state.editorHistory.canUndo = details.hasSomethingToUndo;
            }
            if (typeof details.hasSomethingToRedo === "boolean") {
              state.editorHistory.canRedo = details.hasSomethingToRedo;
            }
            if (typeof details.hasSelectedEditor === "boolean") {
              state.editorHistory.hasSelection = details.hasSelectedEditor;
            }
            syncBridgeControls();
          }),
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on("annotationeditorparamschanged", ({ details }) => annotationToolColors?.onParamsChanged(details),
          { signal: state.eventAbortController.signal });
        app.eventBus?._on("switchannotationeditorparams", event => annotationToolColors?.onSwitchParams(event),
          { signal: state.eventAbortController.signal });
        window.addEventListener("focusin", onBridgeFocusIn, {
          capture: true,
          signal: state.eventAbortController.signal,
        });
        window.addEventListener("focusout", onBridgeFocusOut, {
          capture: true,
          signal: state.eventAbortController.signal,
        });
        window.addEventListener(
          "blur",
          () => {
            setDeferredTimeout(() =>
              flushDeferredAccessibilityMoves(null, { allowDocumentBlur: true }),
            );
          },
          { signal: state.eventAbortController.signal },
        );
        window.addEventListener("input", onBridgeInput, {
          capture: true,
          signal: state.eventAbortController.signal,
        });
        window.addEventListener("compositionstart", onCompositionStart, {
          capture: true,
          signal: state.eventAbortController.signal,
        });
        window.addEventListener("compositionend", onCompositionEnd, {
          capture: true,
          signal: state.eventAbortController.signal,
        });
        window.addEventListener("beforeinput", onBridgeBeforeInput, {
          capture: true,
          signal: state.eventAbortController.signal,
        });
        window.addEventListener("keydown", onBridgeKeyDown, {
          capture: true,
          signal: state.eventAbortController.signal,
        });
        for (const id of [
          "openFile",
          "secondaryOpenFile",
          "overwriteOriginalButton",
          "secondaryOverwriteOriginal",
        ]) {
          const button = document.getElementById(id);
          if (button) {
            button.hidden = true;
          }
        }
        labelSaveControls();
        labelSecondaryToolbarControls();
        installBridgeControls();
        state.ready = true;
        postToHost("ready", { rendererGeneration });
        for (const message of state.queuedOpens.splice(0)) {
          queueOpen(message);
        }
      })
      .catch((error) => {
        state.startupFailed = true;
        clearTimeout(state.startupTimer);
        sendError(error?.message || "Could not initialize the PDF viewer.", {
          code: "viewer-init-failed",
        });
      });

    state.startupTimer = setTimeout(() => {
      if (state.ready || state.disposed || state.startupFailed) {
        return;
      }
      state.startupFailed = true;
      const diagnostics = {
        eventBus: !!app.eventBus,
        l10n: !!app.l10n,
        pdfViewer: !!app.pdfViewer,
        thumbnailViewer: !!app.pdfThumbnailViewer,
        initialized: !!app.initialized,
      };
      console.error("PDF.js viewer initialization stalled:", diagnostics);
      sendError(
        `PDF viewer initialization timed out (${Object.entries(diagnostics)
          .map(([name, ready]) => `${name}=${ready ? "yes" : "no"}`)
          .join(", ")}).`,
        { code: "viewer-init-timeout" },
      );
    }, 15000);
  }

  function configureBeforeViewerRun(event) {
    if (state.configured) {
      return true;
    }
    if (event?.detail?.source && event.detail.source !== window) {
      return false;
    }
    const app = window.PDFViewerApplication;
    const options = window.PDFViewerApplicationOptions;
    if (!app || !options?.setAll) {
      return false;
    }

    configureZoomPresetOptions();

    const mobileResources =
      window.__PDF_READER_MOBILE_RESOURCES__ &&
      typeof window.__PDF_READER_MOBILE_RESOURCES__ === "object"
        ? window.__PDF_READER_MOBILE_RESOURCES__
        : {};
    const resourceOverride = (key, fallback) => {
      const value = mobileResources[key];
      return typeof value === "string" && value.trim()
        ? value
        : resourceUrl(fallback);
    };
    options.setAll({
      defaultUrl: "",
      disablePreferences: true,
      enableScripting: false,
      enableAltText: false,
      enableGuessAltText: false,
      enableAltTextModelDownload: false,
      enableFakeMLManager: false,
      enablePermissions: true,
      enableMerge: false,
      enableSplitMerge: false,
      workerSrc: resourceOverride("workerSrc", "../build/pdf.worker.mjs"),
      cMapUrl: resourceOverride("cMapUrl", "./cmaps/"),
      iccUrl: resourceOverride("iccUrl", "./iccs/"),
      standardFontDataUrl: resourceOverride("fontUrl", "./standard_fonts/"),
      wasmUrl: resourceOverride("wasmUrl", "./wasm/"),
      imageResourcesPath: resourceOverride("imageResourcesPath", "./images/"),
    });

    ensureViewerLayout();
    hideUnusedToolbarControls();
    updatePageNumberWidth(0);
    state.configured = true;
    installAppHooks(app);
    return true;
  }

  function onViewerLoaded(event) {
    if (configureBeforeViewerRun(event)) {
      // Install before PDF.js creates its temporary right-button eraser. Its
      // window-capture pointerup handler calls stopImmediatePropagation(), so
      // the boundary tracker must see pointerup first and defer cleanup until
      // PDF.js finishes the final erase in the same event dispatch.
      installPointerTrackingListeners();
      removeViewerLoadedListeners();
    }
  }

  function removeViewerLoadedListeners() {
    document.removeEventListener("webviewerloaded", onViewerLoaded, true);
    try {
      window.parent.document.removeEventListener(
        "webviewerloaded",
        onViewerLoaded,
        true,
      );
    } catch {
      // The generic Viewer also dispatches on its own document if the parent
      // document cannot be accessed.
    }
  }

  function dispose() {
    runtimeLogClose();
    if (state.disposed) {
      return;
    }
    state.bulkDeleteDialog?.close?.();
    clearReaderBacklinkPresentation();
    updatePageNumberWidth(0);
    postLifecycleToHost("renderer-unloaded");
    cancelPendingHeavyLeaseWaiters("The PDF view was closed.");
    state.disposed = true;
    wheelColors?.destroy();
    annotationToolColors?.dispose();
    state.annotationSidebarController?.dispose();
    state.annotationSidebarController = null;
    state.backlinkInteractionController?.dispose?.();
    state.backlinkInteractionController = null;
    state.vocabularyController?.dispose?.();
    state.vocabularyController = null;
    state.restoredSavedAnnotations.clear();
    state.toolbarLayoutResizeObserver?.disconnect();
    state.toolbarLayoutResizeObserver = null;
    state.toolbarLayoutMutationObserver?.disconnect();
    state.toolbarLayoutMutationObserver = null;
    if (state.toolbarLayoutFrame) {
      cancelAnimationFrame(state.toolbarLayoutFrame);
      state.toolbarLayoutFrame = 0;
    }
    document.documentElement.classList.remove("pdfReaderBridgeTwoRow");
    stopExternalAnnotationLayerObserver();
    setNativeAnnotationLayersPending(false);
    clearFingerTextSelectionSuppression();
    stopOpenStartupObserver();
    state.openSession?.controller.abort();
    if (state.closeControl) {
      clearCloseControl(state.closeControl, { resume: false });
    }
    removeViewerLoadedListeners();
    if (
      state.heavyLeaseWaiters.size > 0 ||
      state.cancelledHeavyLeaseRequests.size > 0
    ) {
      clearTimeout(state.heavyLeaseCleanupTimer);
      state.heavyLeaseCleanupTimer = setTimeout(() => {
        state.heavyLeaseWaiters.clear();
        state.cancelledHeavyLeaseRequests.clear();
        finishDisposedHeavyLeaseCleanup();
      }, HEAVY_LEASE_TIMEOUT_MS);
    } else {
      window.removeEventListener("message", onHostMessage);
    }
    window.removeEventListener("keydown", onReadOnlyHotkey, true);
    window.removeEventListener("beforeunload", onViewerBeforeUnload, true);
    window.removeEventListener("pdf-reader-toggle-lingq", toggleVocabularyFromToolWheel);
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("unload", dispose);
    clearTimeout(state.statusTimer);
    clearTimeout(state.startupTimer);
    clearScheduledWork();
    invalidatePendingPenHighlight();
    cleanupStorageObserver();
    state.eventAbortController?.abort();
    state.eventAbortController = null;
    state.viewportController?.dispose();
    state.viewportController = null;
    state.textSelectionController = null;
    state.annotationController = null;
    state.inputRouter?.stop();
    state.inputPolicy?.refreshPenGestureTouchAction?.();
    state.inputRouter = null;
    state.inputPolicy = null;
    state.iosDirectManipulationController = null;
    state.pointerAbortController = null;
    state.localOpenAbortController?.abort();
    state.localOpenAbortController = null;

    if (state.pendingSave) {
      state.pendingSave.reject(new Error("The PDF view was closed."));
    }
    if (state.pendingRecovery) {
      state.pendingRecovery.reject(new Error("The PDF view was closed."));
    }
    resolveManualSaveWaiters(false);
    const loadingTask = state.app?.pdfLoadingTask;
    if (loadingTask) {
      try {
        Promise.resolve(loadingTask.destroy()).then(
          () => postLifecycleToHost("worker-terminated"),
          () => {},
        );
      } catch {
        // Keep the host's generation resources alive if worker shutdown failed.
      }
    } else {
      // No loading task means this renderer never created a PDF worker.
      postLifecycleToHost("worker-terminated");
    }
  }

  window.addEventListener("message", onHostMessage);
  window.addEventListener("keydown", onReadOnlyHotkey, true);
  window.addEventListener("beforeunload", onViewerBeforeUnload, true);
  window.addEventListener("pdf-reader-toggle-lingq", toggleVocabularyFromToolWheel);
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("unload", dispose, { once: true });
  document.addEventListener("webviewerloaded", onViewerLoaded, true);
  try {
    window.parent.document.addEventListener(
      "webviewerloaded",
      onViewerLoaded,
      true,
    );
  } catch {
    // The embedded Viewer falls back to dispatching webviewerloaded locally.
  }
})();
