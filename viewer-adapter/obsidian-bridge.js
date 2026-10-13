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
  const iosInputPolicy = bridgeScript.dataset.iosInputPolicy === "true";
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
    activePointers: new Map(),
    manualPointers: new Map(),
    fingerTextSelectionSuppressionOwned: false,
    manualMomentum: null,
    pendingPenHighlight: null,
    penPolicyPointers: new Map(),
    lastTouchClickPage: null,
    lastPenPanClickPage: null,
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
    manualSaveRequestedDuringFlight: false,
    pendingSave: null,
    pendingRecovery: null,
    syncState: null,
    syncActorId: null,
    annotationUuidByRuntimeId: new Map(),
    annotationRefByRuntimeId: new Map(),
    annotationUuidByPdfRef: new Map(),
    annotationSnapshot: new Map(),
    annotationOperations: [],
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
    pointerAbortController: null,
    eventAbortController: null,
    localOpenAbortController: null,
    startupTimer: null,
    startupFailed: false,
  };
  if (iosInputPolicy) {
    document.documentElement.dataset.pdfReaderIosInputPolicy = "true";
  }
  function postToHost(type, fields = {}, transfer = []) {
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
    { documentId = null, requestId = null, code } = {},
  ) {
    const fields = { message: String(message || "PDF viewer error") };
    if (typeof documentId === "string") {
      fields.documentId = documentId;
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
    const title = "保存 PDF 到仓库（覆盖当前文件）";
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
      label.textContent = "保存到仓库";
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

  function dismissToolbarParameterPopups(event) {
    const target = event.target;
    if (!(target instanceof Element) ||
        target.closest(".editorParamsToolbar, #editorModeButtons")) {
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
    controls.saveButton.disabled = !hasDocument;
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
      case "save":
        void requestSave("manual");
        break;
    }
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
      saveButton,
    };
    installAdaptiveToolbarLayout();
    syncBridgeControls();
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
      return;
    }
    if (snapshot.hadAnnotationChanges) {
      app._annotationStorageModified = true;
    } else {
      delete app._annotationStorageModified;
    }
    app._updateOverwriteOriginalState?.();
    app.setTitle?.();
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
    return state.activePointers.size > 0;
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
      }[lower] || value
    );
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
      return "[Circular]";
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
      return `${pdfJsMatch[1]}R${pdfJsMatch[2] || ""}`;
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

  function getAnnotationStorageRows(app = state.app) {
    const storageMap = app?.pdfDocument?.annotationStorage?.serializable?.map;
    if (!(storageMap instanceof Map)) {
      return new Map();
    }
    const rows = new Map();
    for (const [rawRuntimeId, rawValue] of storageMap) {
      if (rawValue === null || typeof rawValue !== "object") {
        continue;
      }
      const runtimeId = String(rawRuntimeId);
      const value = normalizeSyncValue(rawValue);
      const editor = app.pdfViewer?._layerProperties
        ?.annotationEditorUIManager?.getEditor?.(runtimeId);
      const annotationElementId = getPdfAnnotationRef(value);
      const reference = annotationElementId ||
        state.annotationRefByRuntimeId.get(runtimeId) || null;
      const referenceKey = pdfAnnotationRefKey(reference);
      const runtimeUuid = state.annotationUuidByRuntimeId.get(runtimeId);
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
              : null;
      const kind = normalizeSyncKind(
        value?.annotationType ?? value?.type ?? editor?.editorType ??
          identity?.kind,
      );
      let uuid = runtimeUuid || null;
      if (!uuid && referenceKey) {
        uuid = state.annotationUuidByPdfRef.get(referenceKey) || null;
      }
      if (!uuid && identity?.uuid) {
        uuid = identity.uuid;
      }
      if (!uuid) {
        uuid = makeSyncUuid();
      }
      state.annotationUuidByRuntimeId.set(runtimeId, uuid);
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
    }
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
      state.annotationRefByRuntimeId.clear();
      state.annotationUuidByPdfRef.clear();
      state.annotationOperations = [];
      state.annotationSnapshot = new Map();
      state.syncOperationSequence = 0;
      state.syncClockTimestamp = 0;
      state.syncClockLogical = 0;
      state.syncState = null;
    }
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
      operationId: `${actorId}:${state.syncClockTimestamp}:${state.syncClockLogical}:${state.syncOperationSequence}`,
    };
  }

  function refreshAnnotationOperations(revision = state.revision) {
    const current = getAnnotationStorageRows();
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
      const deleted = !after || after.deleted;
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
        kind: currentRow.kind || before?.kind || "Unknown",
        deleted,
        action: deleted ? "delete" : "upsert",
        ...stamp,
        ...(deleted
          ? { serialized: { deleted: true } }
          : { serialized: currentRow.value }),
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
    }
    state.annotationSnapshot = current;
  }

  function captureSyncOperations(revision = state.revision) {
    return state.annotationOperations
      .map(({ operation }) => ({ ...operation }));
  }

  function captureNewSyncAnnotations() {
    const rows = getAnnotationStorageRows();
    const result = [];
    const pageOrder = new Map();
    for (const row of rows.values()) {
      if (row.annotationElementId || row.deleted) {
        continue;
      }
      const pageIndex = Number.isSafeInteger(row.pageIndex) ? row.pageIndex : 0;
      const order = pageOrder.get(pageIndex) || 0;
      pageOrder.set(pageIndex, order + 1);
      result.push({
        runtimeId: row.runtimeId,
        uuid: row.uuid,
        pageIndex,
        kind: row.kind,
        order,
      });
    }
    return result;
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
      } finally {
        state.committingInkForSave = false;
        state.pendingInkCommit = false;
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
    let willSaveDispatched = false;
    app._saveInProgress = true;
    app._updateOverwriteOriginalState?.();
    let data = null;
    let error = null;
    try {
      await app.pdfScriptingManager?.dispatchWillSave?.();
      willSaveDispatched = true;
      if (app.pdfThumbnailViewer?.hasStructuralChanges?.()) {
        throw new Error("Page reordering cannot be included in a sync checkpoint.");
      }
      // A host-confirmed save does not replace the PDF.js Worker's loaded
      // bytes. Clean live editors/tombstones still belong to this session;
      // getData() would omit them and cannot match newAnnotations/operations.
      const bytes = dirtySnapshot.hadAnnotationChanges || state.dirty ||
          app._annotationStorageModified || pdfDocument.annotationStorage?.size > 0
        ? await pdfDocument.saveDocument()
        : await pdfDocument.getData();
      if (!bytes) {
        throw new Error("PDF.js did not produce checkpoint data.");
      }
      if (willSaveDispatched) {
        await app.pdfScriptingManager?.dispatchDidSave?.();
        willSaveDispatched = false;
      }
      if (
        state.disposed ||
        state.activeDocumentId !== documentId ||
        state.activeOpenRequest !== openRequest ||
        app.pdfDocument !== pdfDocument ||
        state.revision !== revisionAtStart
      ) {
        throw new Error("The PDF changed while creating the sync checkpoint.");
      }
      data = makeArrayBuffer(bytes);
    } catch (caught) {
      error = caught;
    } finally {
      if (willSaveDispatched) {
        try {
          await app.pdfScriptingManager?.dispatchDidSave?.();
        } catch {
          // Preserve the checkpoint serialization error.
        }
      }
      if (app.pdfDocument === pdfDocument) {
        restoreChanges(app, {
          hadAnnotationChanges:
            dirtySnapshot.hadAnnotationChanges ||
            state.dirty ||
            state.revision !== revisionAtStart,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
      }
      app._saveInProgress = false;
      app._updateOverwriteOriginalState?.();
      app.setTitle?.();
    }
    if (error) {
      return postSyncCheckpointRejected(message, error.message);
    }
    const fields = {
      id: message.id,
      documentId,
      openRequest,
      revision: revisionAtStart,
      confirmedRevision: state.confirmedRevision,
      dirty: isDirty(),
      ok: true,
      data,
      operations: captureSyncOperations(revisionAtStart),
      newAnnotations: captureNewSyncAnnotations(),
      actorId: state.syncActorId,
      viewState: captureSyncViewState(app),
    };
    const posted = postToHost("sync-checkpoint-ready", fields, [data]);
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

  async function handleSyncApplyPrepare(message) {
    if (
      !validSyncRequest(message) ||
      !Number.isSafeInteger(message.expectedRevision) ||
      message.expectedRevision < 0
    ) {
      return;
    }
    const reject = (reason) => {
      postSyncApplyPrepared(
        {
          id: message.id,
          documentId: message.documentId,
          openRequest: message.openRequest,
        },
        false,
        reason,
      );
    };
    if (
      state.activeDocumentId !== message.documentId ||
      state.activeOpenRequest !== message.openRequest ||
      !state.app?.pdfDocument
    ) {
      reject("document-session-changed");
      return;
    }
    if (state.syncApplyControl) {
      if (
        state.syncApplyControl.id === message.id &&
        state.syncApplyControl.documentId === message.documentId &&
        state.syncApplyControl.openRequest === message.openRequest &&
        state.syncApplyControl.revision === message.expectedRevision &&
        state.syncApplyControl.phase === "prepared"
      ) {
        postSyncApplyPrepared(state.syncApplyControl, true);
      } else {
        reject("another-sync-apply-is-prepared");
      }
      return;
    }
    if (
      state.closeControl ||
      state.savePromise ||
      state.pendingSave ||
      state.pendingRecovery ||
      state.syncCheckpointPromise ||
      state.app._saveInProgress
    ) {
      reject("document-operation-in-progress");
      return;
    }
    if (state.revision !== message.expectedRevision) {
      reject("revision-changed");
      return;
    }
    const control = {
      id: message.id,
      documentId: message.documentId,
      openRequest: message.openRequest,
      revision: message.expectedRevision,
      phase: "preparing",
      cancelled: false,
    };
    state.syncApplyControl = control;
    const boundaryReached = await waitForInputBoundary(110000);
    if (
      state.syncApplyControl !== control ||
      control.cancelled
    ) {
      return;
    }
    if (!boundaryReached) {
      clearSyncApplyControl(control);
      reject("input-boundary-timeout");
      return;
    }
    if (
      state.disposed ||
      state.activeDocumentId !== control.documentId ||
      state.activeOpenRequest !== control.openRequest ||
      state.revision !== control.revision ||
      isEditBoundaryBusy() ||
      state.savePromise ||
      state.pendingSave ||
      state.app?._saveInProgress
    ) {
      clearSyncApplyControl(control);
      reject("revision-or-boundary-changed");
      return;
    }
    if (!setSyncApplyInert(control)) {
      clearSyncApplyControl(control);
      reject("could-not-freeze-input");
      return;
    }
    postSyncApplyPrepared(control, true);
  }

  async function applySyncSnapshot(message) {
    if (message?.rendererGeneration !== rendererGeneration) {
      return;
    }
    const control = state.syncApplyControl;
    const valid = !!(
      control &&
      control.phase === "prepared" &&
      control.id === message.id &&
      control.documentId === message.documentId &&
      control.openRequest === message.previousOpenRequest &&
      control.revision === message.expectedRevision &&
      state.activeDocumentId === control.documentId &&
      state.activeOpenRequest === control.openRequest &&
      state.revision === control.revision &&
      Number.isSafeInteger(message.newOpenRequest) &&
      message.newOpenRequest === message.previousOpenRequest + 1 &&
      message.data instanceof ArrayBuffer &&
      message.syncState &&
      Number.isSafeInteger(message.syncState.version)
    );
    if (!valid) {
      if (control?.id === message.id) {
        clearSyncApplyControl(control);
      }
      postSyncApplyRejected(message, "prepared-revision-or-payload-mismatch");
      return;
    }
    control.phase = "applying";
    const openMessage = {
      documentId: control.documentId,
      documentPath: state.activeDocumentPath,
      filename: state.activeFilename || "document.pdf",
      openRequest: message.newOpenRequest,
      revision: control.revision,
      confirmedRevision: control.revision,
      restoreDirty: false,
      restorePaused: false,
      autoSave: state.autoSaveEnabled,
      syncState: message.syncState,
      viewState: message.viewState,
      data: message.data,
      syncApplyControlId: control.id,
    };
    state.requestedOpenRequest = message.newOpenRequest;
    let opened = false;
    let openError = null;
    try {
      control.openDocumentPromise = openDocument(openMessage);
      opened = await control.openDocumentPromise;
    } catch (error) {
      openError = error;
    }
    if (control.cancelRequested) {
      const result = await control.cancelPromise;
      if (result?.ok && state.syncApplyControl === control) {
        clearSyncApplyControl(control);
      }
      return;
    }
    if (opened) {
      postToHost("sync-applied", {
        id: message.id,
        documentId: control.documentId,
        previousOpenRequest: control.openRequest,
        newOpenRequest: message.newOpenRequest,
        openRequest: message.newOpenRequest,
        revision: state.revision,
        ok: true,
        viewState: captureSyncViewState(),
      });
    } else {
      postSyncApplyRejected(
        message,
        openError?.message || "merged-pdf-open-failed",
      );
    }
    clearSyncApplyControl(control);
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

  function noteMutation({ schedule = true } = {}) {
    if (!state.activeDocumentId || state.disposed) {
      return;
    }
    state.revision += 1;
    refreshAnnotationOperations(state.revision);
    state.dirty = true;
    state.lastRecoveredDocumentId = null;
    state.lastRecoveredRevision = null;
    const app = state.app;
    if (app) {
      app._annotationStorageModified = true;
      app._updateOverwriteOriginalState?.();
      app.setTitle?.();
    }
    if (
      schedule &&
      !state.committingInkForSave &&
      !state.preparingContentForSave
    ) {
      scheduleAutoSave();
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
    if (state.pendingInkCommit) {
      state.committingInkForSave = true;
      try {
        // Ink keeps a drawing session open across strokes. End an idle stroke
        // before serialization so the current path reaches AnnotationStorage.
        app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
      } finally {
        state.committingInkForSave = false;
        state.pendingInkCommit = false;
      }
    }
    state.freeTextCommitReady =
      state.freeTextFocused && state.freeTextInputPending;
    try {
      prepareContentForSave({ commitFreeText: true });
    } finally {
      state.freeTextCommitReady = false;
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
        } finally {
          state.committingInkForSave = false;
          state.pendingInkCommit = false;
        }
      }
      void requestSave("manual").then(resolveManualSaveWaiters);
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
    data,
    documentId,
    filename,
    documentPath,
    requestId,
    revision,
    origin,
    openRequest,
    operations,
    newAnnotations,
    actorId,
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
        origin,
        openRequest,
        resolve: (syncState) => {
          clearTimeout(timeout);
          state.pendingSave = null;
          resolve(syncState);
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
            data,
            documentId,
            documentPath,
            filename,
            requestId,
            revision,
            origin,
            openRequest,
            operations,
            newAnnotations,
            actorId,
            ...(heavyLeaseId ? { heavyLeaseId } : {}),
          },
          [data],
        )
      ) {
        clearTimeout(timeout);
        state.pendingSave = null;
        reject(new Error("Could not send the PDF to Obsidian for saving."));
      }
    });
  }

  function waitForHostRecovery({
    data,
    documentId,
    documentPath,
    filename,
    reason,
    requestId,
    revision,
    timeoutMs,
    openRequest,
    operations,
    newAnnotations,
    actorId,
    heavyLeaseId,
  }) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (state.pendingRecovery?.requestId !== requestId) {
          return;
        }
        state.pendingRecovery = null;
        reject(new Error("Timed out waiting for Obsidian to save the recovery copy."));
      }, timeoutMs);

      state.pendingRecovery = {
        documentId,
        requestId,
        revision,
        openRequest,
        resolve: () => {
          clearTimeout(timeout);
          state.pendingRecovery = null;
          resolve();
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
            data,
            documentId,
            documentPath,
            filename,
            reason,
            requestId,
            revision,
            openRequest,
            operations,
            newAnnotations,
            actorId,
            ...(heavyLeaseId ? { heavyLeaseId } : {}),
          },
          [data],
        )
      ) {
        clearTimeout(timeout);
        state.pendingRecovery = null;
        reject(new Error("Could not send the PDF recovery copy to Obsidian."));
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
    if (state.readOnly) {
      showStatus("This PDF is read-only.");
      return false;
    }

    const revisionBeforeLease = state.revision;
    const sessionIsCurrent = () =>
      !state.disposed &&
      state.app === app &&
      state.activeDocumentId === documentId &&
      state.activeOpenRequest === openRequest &&
      app.pdfDocument === pdfDocument;
    let lease = null;
    let revisionAtStart = null;
    let dirtySnapshot = null;
    let requestId = null;
    let willSaveDispatched = false;
    let saveStarted = false;
    let autoStartedAt = null;

    try {
      lease = await waitForHostHeavyLease({ documentId, openRequest });
      if (!sessionIsCurrent()) {
        return false;
      }
      if (
        state.revision !== revisionBeforeLease ||
        isEditBoundaryBusy() ||
        state.pendingInkCommit
      ) {
        return SAVE_RETRY_AFTER_IDLE;
      }
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
      const operationsAtStart = captureSyncOperations(revisionAtStart);
      const newAnnotationsAtStart = captureNewSyncAnnotations();
      const actorIdAtStart = state.syncActorId;
      requestId = makeSaveRequestId();
      app._saveInProgress = true;
      saveStarted = true;
      app._updateOverwriteOriginalState?.();

      await app.pdfScriptingManager?.dispatchWillSave?.();
      willSaveDispatched = true;

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
        if (willSaveDispatched) {
          await app.pdfScriptingManager?.dispatchDidSave?.();
          willSaveDispatched = false;
        }
        if (sessionIsCurrent()) {
          restoreChanges(app, {
            hadAnnotationChanges: true,
            hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
          });
        }
        return sessionIsCurrent() ? SAVE_RETRY_AFTER_IDLE : false;
      }

      // A host ACK clears the dirty flags but does not replace PDF.js's loaded
      // base; retained id:null editors still need saveDocument serialization.
      const hasAnnotationChanges =
        dirtySnapshot.hadAnnotationChanges || state.dirty ||
        app._annotationStorageModified || pdfDocument.annotationStorage?.size > 0;
      autoStartedAt = origin === "auto" ? Date.now() : null;
      if (autoStartedAt !== null) {
        state.lastAutoSaveStartedAt = autoStartedAt;
      }
      const bytes = hasAnnotationChanges
        ? await pdfDocument.saveDocument()
        : await pdfDocument.getData();

      if (!bytes) {
        throw new Error("PDF.js did not produce PDF data to save.");
      }
      if (willSaveDispatched) {
        await app.pdfScriptingManager?.dispatchDidSave?.();
        willSaveDispatched = false;
      }

      if (!sessionIsCurrent()) {
        return false;
      }

      if (
        origin === "auto" &&
        (!state.autoSaveEnabled || state.autoSavePaused)
      ) {
        // The setting can change while PDF.js is serializing. Preserve the
        // revision as dirty without sending an auto-origin host write.
        state.dirty = true;
        restoreChanges(app, {
          hadAnnotationChanges: true,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
        return false;
      }

      // saveDocument clears PDF.js's modified flag before the Vault write.
      // Restore it until the host confirms this exact revision was written.
      const changedDuringSerialization = state.revision !== revisionAtStart;
      restoreChanges(app, {
        hadAnnotationChanges:
          dirtySnapshot.hadAnnotationChanges || changedDuringSerialization,
        hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
      });
      await waitForHostSave({
        data: makeArrayBuffer(bytes),
        documentId,
        documentPath: state.activeDocumentPath,
        filename: state.activeFilename || "document.pdf",
        requestId,
        revision: revisionAtStart,
        origin,
        openRequest,
        operations: operationsAtStart,
        newAnnotations: newAnnotationsAtStart,
        actorId: actorIdAtStart,
        heavyLeaseId: lease?.leaseId,
      });
      if (sessionIsCurrent()) {
        state.confirmedRevision = revisionAtStart;
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
      if (!sessionIsCurrent() || (error?.cancelled && !error?.leaseTimeout)) {
        return false;
      }
      state.autoSavePaused = true;
      clearAutoSaveTimer();
      const failedSnapshot = dirtySnapshot || snapshotChanges(app);
      state.dirty = true;
      if (willSaveDispatched) {
        try {
          await app.pdfScriptingManager?.dispatchDidSave?.();
        } catch {
          // Keep the original save error as the user-visible failure.
        }
      }
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
      if (saveStarted) {
        app._saveInProgress = false;
        app._updateOverwriteOriginalState?.();
        app.setTitle?.();
      }
      if (autoStartedAt !== null) {
        state.lastAutoSaveDurationMs = Math.max(0, Date.now() - autoStartedAt);
      }
      releaseHostHeavyLease(lease, documentId);
    }
  }

  async function runSaveSequence(origin) {
    const documentId = state.activeDocumentId;
    let lastResult = true;
    while (
      !state.disposed &&
      documentId &&
      state.activeDocumentId === documentId &&
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
        } finally {
          state.committingInkForSave = false;
          state.pendingInkCommit = false;
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

  async function runRecoverySequence(reason, deadline) {
    const documentId = state.activeDocumentId;
    const openRequest = state.activeOpenRequest;
    if (!documentId || !state.app?.pdfDocument || state.readOnly) {
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
        } finally {
          state.committingInkForSave = false;
          state.pendingInkCommit = false;
        }
      }

      const revisionBeforeLease = state.revision;
      let lease = null;
      try {
        if (deadline <= Date.now()) {
          return false;
        }
        lease = await waitForHostHeavyLease({
          documentId,
          openRequest,
          timeoutMs: Math.max(0, deadline - Date.now()),
        });
      } catch (error) {
        if (!sessionIsCurrent() || error?.cancelled) {
          return false;
        }
        state.dirty = true;
        restoreChanges(app, {
          hadAnnotationChanges: true,
          hadStructuralChanges: snapshotChanges(app).hadStructuralChanges,
        });
        showStatus(error?.message || "Could not request the PDF recovery lease.");
        return false;
      }
      if (!sessionIsCurrent()) {
        releaseHostHeavyLease(lease, documentId);
        return false;
      }
      if (
        state.revision !== revisionBeforeLease ||
        isEditBoundaryBusy() ||
        state.pendingInkCommit
      ) {
        releaseHostHeavyLease(lease, documentId);
        continue;
      }

      const revisionAtStart = state.revision;
      const operationsAtStart = captureSyncOperations(revisionAtStart);
      const newAnnotationsAtStart = captureNewSyncAnnotations();
      const actorIdAtStart = state.syncActorId;
      const dirtySnapshot = snapshotChanges(app);
      let willSaveDispatched = false;
      let saveStarted = false;
      app._saveInProgress = true;
      saveStarted = true;
      try {
        if (deadline <= Date.now()) {
          return false;
        }
        await app.pdfScriptingManager?.dispatchWillSave?.();
        willSaveDispatched = true;
        if (app.pdfThumbnailViewer?.hasStructuralChanges?.()) {
          throw new Error("Page reordering cannot be included in a PDF recovery copy.");
        }
        if (
          !sessionIsCurrent() ||
          state.revision !== revisionAtStart ||
          isEditBoundaryBusy() ||
          state.pendingInkCommit
        ) {
          if (willSaveDispatched) {
            await app.pdfScriptingManager?.dispatchDidSave?.();
            willSaveDispatched = false;
          }
          if (sessionIsCurrent()) {
            state.dirty = true;
            restoreChanges(app, {
              hadAnnotationChanges: true,
              hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
            });
          }
          continue;
        }
        // Recovery has the same loaded-base boundary as an ordinary save.
        const bytes =
          dirtySnapshot.hadAnnotationChanges || state.dirty ||
          app._annotationStorageModified || pdfDocument.annotationStorage?.size > 0
            ? await pdfDocument.saveDocument()
            : await pdfDocument.getData();
        if (!bytes) {
          throw new Error("PDF.js did not produce recovery data.");
        }
        if (willSaveDispatched) {
          await app.pdfScriptingManager?.dispatchDidSave?.();
          willSaveDispatched = false;
        }
        if (
          !sessionIsCurrent()
        ) {
          return false;
        }
        state.dirty = true;
        restoreChanges(app, {
          hadAnnotationChanges:
            dirtySnapshot.hadAnnotationChanges ||
            state.dirty ||
            state.revision !== revisionAtStart,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
        const timeoutMs = Math.max(0, deadline - Date.now());
        if (!timeoutMs) {
          return false;
        }
        const requestId = makeRecoveryRequestId();
        await waitForHostRecovery({
          data: makeArrayBuffer(bytes),
          documentId,
          documentPath: state.activeDocumentPath,
          filename: state.activeFilename || "document.pdf",
          reason,
          requestId,
          revision: revisionAtStart,
          timeoutMs,
          openRequest: state.activeOpenRequest,
          operations: operationsAtStart,
          newAnnotations: newAnnotationsAtStart,
          actorId: actorIdAtStart,
          heavyLeaseId: lease?.leaseId,
        });
        if (!sessionIsCurrent()) {
          return false;
        }
        state.dirty = true;
        restoreChanges(app, {
          hadAnnotationChanges: true,
          hadStructuralChanges: dirtySnapshot.hadStructuralChanges,
        });
        if (
          state.revision === revisionAtStart &&
          !isEditBoundaryBusy() &&
          !state.pendingInkCommit
        ) {
          state.lastRecoveredDocumentId = documentId;
          state.lastRecoveredRevision = revisionAtStart;
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
        showStatus(error?.message || "Could not save the PDF recovery copy.");
        return false;
      } finally {
        if (saveStarted) {
          app._saveInProgress = false;
          app._updateOverwriteOriginalState?.();
          app.setTitle?.();
        }
        releaseHostHeavyLease(lease, documentId);
      }
    }
    return sessionIsCurrent() && !isDirty();
  }

  async function requestRecovery(reason, deadline) {
    if (state.disposed) {
      return false;
    }
    if (state.recoveryPromise) {
      return state.recoveryPromise;
    }
    state.recoveryPromise = runRecoverySequence(reason, deadline).finally(() => {
      state.recoveryPromise = null;
    });
    return state.recoveryPromise;
  }

  async function requestSave(origin = "manual") {
    if (state.disposed) {
      return false;
    }
    origin = origin === "auto" ? "auto" : "manual";
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
    prepareContentForSave();
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
      } finally {
        state.committingInkForSave = false;
        state.pendingInkCommit = false;
      }
    }
    state.savePromise = runSaveSequence(origin).finally(() => {
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
      previousOnModified?.();
      noteMutation();
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
        const existed = storage.has(key);
        const result = original.call(storage, key);
        if (existed) {
          noteMutation();
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
          noteMutation();
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

    // Commands represent completed model edits (including moves, resizes,
    // parameter changes and drawing steps). UI state events also report focus
    // and selection, so they aren't used as a mutation signal.
    wrapMethod(
      manager,
      "addCommands",
      (original, args) => {
        const result = original.apply(manager, args);
        if (args[0]) {
          noteMutation();
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
          const before = snapshotSavedFreeTextEditors(manager, app);
          const result = original.apply(manager, args);
          const changedEditors = changedSavedFreeTextEditors(
            manager,
            app,
            before,
          );
          // The command stack is private in this PDF.js build, so its undo
          // availability isn't exposed to the bridge. The UI only invokes
          // these methods for an available command; an empty direct call is a
          // harmless dirty revision that the save path can settle.
          noteMutation();
          if (changedEditors.length > 0) {
            queueFreeTextAppearanceRepair(app, manager, changedEditors);
          }
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
        const changesDocument = !!(
          editor?.deleted ||
          (editor && storage?.has(editor.id)) ||
          editor?.hasBeenModified
        );
        const result = original.call(manager, editor);
        discardDeferredAccessibilityMove(editor);
        if (changesDocument) {
          noteMutation();
        }
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
          const result = original.apply(manager, args);
          noteMutation();
          return result;
        },
        cleanups,
      );
    }
    state.editorManagerCleanup = () => {
      for (const cleanup of cleanups.reverse()) cleanup();
    };
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

  function recordPointerDiagnostic(type, pointer, event = null, activePointers) {
    const diagnostics = state.pointerDiagnostics;
    diagnostics.total = Math.min(Number.MAX_SAFE_INTEGER, diagnostics.total + 1);
    if (diagnostics.samples.length === POINTER_DIAGNOSTIC_LIMIT) {
      diagnostics.samples.shift();
      diagnostics.dropped += 1;
    }
    const sample = {
      type,
      pointerType: normalizedPointerType(
        event?.pointerType ?? pointer?.pointerType,
      ),
      button: Number.isInteger(event?.button)
        ? event.button
        : Number.isInteger(pointer?.button)
          ? pointer.button
          : null,
      buttons: Number.isInteger(event?.buttons)
        ? event.buttons
        : Number.isInteger(pointer?.buttons)
          ? pointer.buttons
          : null,
      activePointers:
        Number.isInteger(activePointers) ? activePointers : state.activePointers.size,
      editorMode: Number.isInteger(state.editorMode) ? state.editorMode : null,
      trusted: event ? event.isTrusted === true : null,
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
      activePointers: state.activePointers.size,
      pointers: state.pointerDiagnostics.samples.map((sample) => ({ ...sample })),
    };
  }

  function isNativeContextTarget(target) {
    return !!target?.closest?.(
      "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=dialog], .editorToolbar, .editToolbar, .editorParamsToolbar",
    );
  }

  function isViewerSurfaceTarget(target) {
    const container = document.getElementById("viewerContainer");
    return !!(container && target instanceof Element &&
      (target === container || container.contains(target)));
  }

  function directManipulationPage(target) {
    return target?.closest?.(".page") ||
      (target instanceof Element ? target : null);
  }

  function stopDirectManipulationEvent(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function annotationToolIsActive() {
    return state.editorMode !== 0 ||
      document.body.classList.contains("editorEraserMode");
  }

  function fingerTextSelectionSuppressionIsOwned() {
    return iosInputPolicy && state.fingerTextSelectionSuppressionOwned &&
      annotationToolIsActive();
  }

  function refreshFingerTextSelectionSuppression() {
    document.documentElement.classList.toggle(
      "pdfReaderFingerTextSelectionSuppressed",
      fingerTextSelectionSuppressionIsOwned(),
    );
  }

  function clearFingerTextSelectionSuppression() {
    state.fingerTextSelectionSuppressionOwned = false;
    for (const pointer of state.manualPointers.values()) {
      pointer.suppressesFingerTextSelection = false;
    }
    document.documentElement.classList.remove(
      "pdfReaderFingerTextSelectionSuppressed",
    );
  }

  function isPdfTextLayerTarget(target) {
    const element = target instanceof Element ? target : target?.parentElement;
    return !!(
      element &&
      isViewerSurfaceTarget(element) &&
      element.closest(".textLayer")
    );
  }

  function onBridgeFingerSelectStart(event) {
    if (
      fingerTextSelectionSuppressionIsOwned() &&
      isPdfTextLayerTarget(event.target)
    ) {
      event.preventDefault();
    }
  }

  function onBridgeFingerContextMenu(event) {
    if (
      fingerTextSelectionSuppressionIsOwned() &&
      isPdfTextLayerTarget(event.target)
    ) {
      event.preventDefault();
    }
  }

  function hasActivePenEditorGesture() {
    return state.penPolicyPointers.size > 0 ||
      [...state.activePointers.values()].some((pointer) =>
        pointer.pointerType === "pen" &&
        (pointer.kind === "editor" || !!pointer.nativeOperation),
      );
  }

  function suspendTouchPansForPen() {
    clearFingerTextSelectionSuppression();
    for (const pointer of state.manualPointers.values()) {
      if (pointer.pointerType === "touch") {
        pointer.blockedByPen = true;
        pointer.moved = false;
      }
    }
  }

  const MANUAL_INERTIA_SAMPLE_WINDOW_MS = 80;
  const MANUAL_INERTIA_MAX_SAMPLES = 128;
  const MANUAL_INERTIA_MAX_SPEED = 4;
  const MANUAL_INERTIA_START_SPEED = 0.09;
  const MANUAL_INERTIA_STOP_SPEED = 0.01;
  const MANUAL_INERTIA_DECAY_MS = 350;
  const MANUAL_INERTIA_MIN_SAMPLE_SPAN_MS = 8;
  const MANUAL_INERTIA_TIMESTAMP_TOLERANCE_MS = 5000;

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }

  function cancelManualMomentum() {
    const momentum = state.manualMomentum;
    if (!momentum) {
      return;
    }
    cancelAnimationFrame(momentum.frame);
    state.manualMomentum = null;
  }

  function onManualDocumentVisibilityChange() {
    if (document.visibilityState === "hidden") {
      cancelManualMomentum();
      clearFingerTextSelectionSuppression();
      for (const pointer of state.manualPointers.values()) {
        if (pointer.pointerType === "touch") {
          pointer.blockedByVisibility = true;
          pointer.moved = false;
        }
      }
    }
  }

  function manualPointerEventTime(pointer, event, now = performance.now()) {
    const eventTime = event?.timeStamp;
    let time = Number.isFinite(eventTime) &&
        eventTime >= 0 &&
        eventTime <= now &&
        now - eventTime <= MANUAL_INERTIA_TIMESTAMP_TOLERANCE_MS
      ? eventTime
      : now;
    const previousTime = pointer?.scrollSamples?.at(-1)?.time;
    if (Number.isFinite(previousTime) && time < previousTime) {
      time = Math.max(previousTime, now);
    }
    return time;
  }

  function rememberManualScroll(pointer, time = performance.now()) {
    if (pointer.pointerType !== "touch") {
      return;
    }
    const sample = {
      time: Number.isFinite(time) ? time : performance.now(),
      scrollTop: pointer.container.scrollTop,
      scrollLeft: pointer.container.scrollLeft,
    };
    const previous = pointer.scrollSamples[pointer.scrollSamples.length - 1];
    const moved = previous && (
      Math.abs(sample.scrollTop - previous.scrollTop) >= 0.01 ||
      Math.abs(sample.scrollLeft - previous.scrollLeft) >= 0.01
    );
    if (previous && sample.time < previous.time) {
      sample.time = previous.time;
    }
    if (previous && sample.time === previous.time) {
      pointer.scrollSamples[pointer.scrollSamples.length - 1] = sample;
    } else {
      pointer.scrollSamples.push(sample);
    }
    if (moved) {
      pointer.lastMotionAt = sample.time;
    }
    const oldestRecentTime = sample.time - MANUAL_INERTIA_SAMPLE_WINDOW_MS;
    while (
      pointer.scrollSamples.length > 1 &&
      pointer.scrollSamples[1].time < oldestRecentTime
    ) {
      pointer.scrollSamples.shift();
    }
    if (pointer.scrollSamples.length > MANUAL_INERTIA_MAX_SAMPLES) {
      pointer.scrollSamples.splice(
        0,
        pointer.scrollSamples.length - MANUAL_INERTIA_MAX_SAMPLES,
      );
    }
  }

  function touchReleaseVelocity(pointer, now = performance.now()) {
    if (
      pointer.pointerType !== "touch" ||
      !pointer.moved ||
      pointer.blockedByPen ||
      pointer.blockedByOtherPointer ||
      pointer.blockedByVisibility ||
      !Number.isFinite(pointer.lastMotionAt) ||
      now < pointer.lastMotionAt ||
      now - pointer.lastMotionAt > MANUAL_INERTIA_SAMPLE_WINDOW_MS
    ) {
      return null;
    }
    const windowStart = now - MANUAL_INERTIA_SAMPLE_WINDOW_MS;
    const samples = pointer.scrollSamples.filter((sample) =>
      Number.isFinite(sample.time) &&
      sample.time >= windowStart &&
      sample.time <= now &&
      Number.isFinite(sample.scrollTop) &&
      Number.isFinite(sample.scrollLeft)
    );
    const firstRecent = samples[0];
    const predecessor = [...pointer.scrollSamples].reverse().find((sample) =>
      Number.isFinite(sample.time) &&
      sample.time < windowStart &&
      Number.isFinite(sample.scrollTop) &&
      Number.isFinite(sample.scrollLeft)
    );
    if (
      predecessor &&
      firstRecent &&
      firstRecent.time > windowStart &&
      firstRecent.time - predecessor.time <= MANUAL_INERTIA_SAMPLE_WINDOW_MS
    ) {
      const fraction = (windowStart - predecessor.time) /
        (firstRecent.time - predecessor.time);
      samples.unshift({
        time: windowStart,
        scrollLeft: predecessor.scrollLeft +
          (firstRecent.scrollLeft - predecessor.scrollLeft) * fraction,
        scrollTop: predecessor.scrollTop +
          (firstRecent.scrollTop - predecessor.scrollTop) * fraction,
      });
    }
    if (samples.length < 2) {
      return null;
    }
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (last.time - first.time < MANUAL_INERTIA_MIN_SAMPLE_SPAN_MS) {
      return null;
    }
    let weightSum = 0;
    let weightedTime = 0;
    let weightedLeft = 0;
    let weightedTop = 0;
    for (const sample of samples) {
      const weight = Math.exp(
        -(now - sample.time) / (MANUAL_INERTIA_SAMPLE_WINDOW_MS / 2),
      );
      const relativeTime = sample.time - now;
      weightSum += weight;
      weightedTime += weight * relativeTime;
      weightedLeft += weight * sample.scrollLeft;
      weightedTop += weight * sample.scrollTop;
    }
    if (weightSum <= 0) {
      return null;
    }
    const meanTime = weightedTime / weightSum;
    const meanLeft = weightedLeft / weightSum;
    const meanTop = weightedTop / weightSum;
    let timeVariance = 0;
    let leftCovariance = 0;
    let topCovariance = 0;
    for (const sample of samples) {
      const weight = Math.exp(
        -(now - sample.time) / (MANUAL_INERTIA_SAMPLE_WINDOW_MS / 2),
      );
      const timeOffset = sample.time - now - meanTime;
      timeVariance += weight * timeOffset * timeOffset;
      leftCovariance += weight * timeOffset * (sample.scrollLeft - meanLeft);
      topCovariance += weight * timeOffset * (sample.scrollTop - meanTop);
    }
    if (timeVariance <= 0) {
      return null;
    }
    const velocity = {
      x: leftCovariance / timeVariance,
      y: topCovariance / timeVariance,
    };
    const speed = Math.hypot(velocity.x, velocity.y);
    if (speed > MANUAL_INERTIA_MAX_SPEED) {
      velocity.x *= MANUAL_INERTIA_MAX_SPEED / speed;
      velocity.y *= MANUAL_INERTIA_MAX_SPEED / speed;
    }
    if (
      Math.hypot(velocity.x, velocity.y) < MANUAL_INERTIA_START_SPEED ||
      prefersReducedMotion()
    ) {
      return null;
    }
    return velocity;
  }

  function startManualMomentum(pointer, now = performance.now()) {
    if (
      !iosInputPolicy ||
      state.manualPointers.size > 0 ||
      document.visibilityState === "hidden" ||
      !manualPointerSessionCurrent(pointer)
    ) {
      return;
    }
    const velocity = touchReleaseVelocity(pointer, now);
    if (!velocity) {
      return;
    }
    cancelManualMomentum();
    const momentum = {
      container: pointer.container,
      pdfDocument: pointer.pdfDocument,
      documentId: pointer.documentId,
      openRequest: pointer.openRequest,
      rendererGeneration: pointer.rendererGeneration,
      velocityX: velocity.x,
      velocityY: velocity.y,
      targetLeft: pointer.container.scrollLeft,
      targetTop: pointer.container.scrollTop,
      lastFrameTime: now,
      frame: 0,
    };
    state.manualMomentum = momentum;
    const tick = (frameTime) => {
      if (state.manualMomentum !== momentum) {
        return;
      }
      if (
        prefersReducedMotion() ||
        document.visibilityState === "hidden"
      ) {
        cancelManualMomentum();
        return;
      }
      if (!manualPointerSessionCurrent(momentum)) {
        cancelManualMomentum();
        return;
      }
      if (!Number.isFinite(frameTime)) {
        cancelManualMomentum();
        return;
      }
      const elapsed = Math.max(0, frameTime - momentum.lastFrameTime);
      momentum.lastFrameTime = Math.max(momentum.lastFrameTime, frameTime);
      const speed = Math.hypot(momentum.velocityX, momentum.velocityY);
      const timeToStop = speed > MANUAL_INERTIA_STOP_SPEED
        ? MANUAL_INERTIA_DECAY_MS * Math.log(
          speed / MANUAL_INERTIA_STOP_SPEED,
        )
        : 0;
      const activeElapsed = Math.min(elapsed, timeToStop);
      if (activeElapsed > 0) {
        const decay = Math.exp(-activeElapsed / MANUAL_INERTIA_DECAY_MS);
        const travelFactor = MANUAL_INERTIA_DECAY_MS * (1 - decay);
        const requestedX = momentum.velocityX * travelFactor;
        const requestedY = momentum.velocityY * travelFactor;
        const previousLeft = momentum.container.scrollLeft;
        const previousTop = momentum.container.scrollTop;
        const maxLeft = Math.max(
          0,
          momentum.container.scrollWidth - momentum.container.clientWidth,
        );
        const maxTop = Math.max(
          0,
          momentum.container.scrollHeight - momentum.container.clientHeight,
        );
        momentum.targetLeft += requestedX;
        momentum.targetTop += requestedY;
        momentum.container.scrollLeft = momentum.targetLeft;
        momentum.container.scrollTop = momentum.targetTop;
        const movedX = momentum.container.scrollLeft - previousLeft;
        const movedY = momentum.container.scrollTop - previousTop;
        const atXBoundary = requestedX > 0
          ? momentum.container.scrollLeft >= maxLeft - 1
          : requestedX < 0 && momentum.container.scrollLeft <= 1;
        const atYBoundary = requestedY > 0
          ? momentum.container.scrollTop >= maxTop - 1
          : requestedY < 0 && momentum.container.scrollTop <= 1;
        if (
          Math.sign(movedX) !== Math.sign(requestedX) &&
          Math.abs(movedX) > 0.01
        ) {
          momentum.velocityX = 0;
        } else if (atXBoundary) {
          momentum.velocityX = 0;
          momentum.targetLeft = momentum.container.scrollLeft;
        } else {
          momentum.velocityX *= decay;
        }
        if (
          Math.sign(movedY) !== Math.sign(requestedY) &&
          Math.abs(movedY) > 0.01
        ) {
          momentum.velocityY = 0;
        } else if (atYBoundary) {
          momentum.velocityY = 0;
          momentum.targetTop = momentum.container.scrollTop;
        } else {
          momentum.velocityY *= decay;
        }
      }
      if (activeElapsed < elapsed ||
        Math.hypot(momentum.velocityX, momentum.velocityY) <=
          MANUAL_INERTIA_STOP_SPEED) {
        cancelManualMomentum();
        return;
      }
      momentum.frame = requestAnimationFrame(tick);
    };
    momentum.frame = requestAnimationFrame(tick);
  }

  function startManualPointer(event, pointerType) {
    const container = document.getElementById("viewerContainer");
    if (!container || state.manualPointers.has(event.pointerId)) {
      return null;
    }
    const anotherDirectPointer = state.manualPointers.size > 0;
    const startTime = manualPointerEventTime(null, event);
    if (anotherDirectPointer) {
      for (const activePointer of state.manualPointers.values()) {
        activePointer.blockedByOtherPointer = true;
        activePointer.cancelledByOtherPointer = true;
        activePointer.moved = false;
        activePointer.lastMotionAt = null;
        activePointer.scrollSamples = [{
          time: manualPointerEventTime(activePointer, event),
          scrollTop: container.scrollTop,
          scrollLeft: container.scrollLeft,
        }];
      }
    }
    const pointer = {
      pointerId: event.pointerId,
      pointerType,
      originalTarget: event.target,
      pageTarget: directManipulationPage(event.target),
      container,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startScrollTop: container.scrollTop,
      startScrollLeft: container.scrollLeft,
      lastMotionAt: null,
      scrollSamples: [{
        time: startTime,
        scrollTop: container.scrollTop,
        scrollLeft: container.scrollLeft,
      }],
      moved: false,
      blockedByPen: hasActivePenEditorGesture(),
      blockedByOtherPointer: anotherDirectPointer,
      cancelledByOtherPointer: anotherDirectPointer,
      suppressesFingerTextSelection: pointerType === "touch" &&
        !anotherDirectPointer &&
        !hasActivePenEditorGesture() &&
        annotationToolIsActive(),
      captureTarget: pointerType === "touch" ? container : null,
      documentId: state.activeDocumentId,
      openRequest: state.activeOpenRequest,
      pdfDocument: state.app?.pdfDocument,
      rendererGeneration,
    };
    state.manualPointers.set(event.pointerId, pointer);
    if (pointerType === "touch") {
      if (pointer.suppressesFingerTextSelection) {
        state.fingerTextSelectionSuppressionOwned = true;
      }
      refreshFingerTextSelectionSuppression();
      state.lastTouchClickPage = pointer.pageTarget;
      try {
        container.setPointerCapture(event.pointerId);
      } catch {
        // The capture may be unavailable for a synthetic or already-cancelled
        // contact; window listeners still finish the tracked sequence.
      }
      stopDirectManipulationEvent(event);
    } else if (pointerType === "pen") {
      // Prevent the browser's compatibility mouse sequence from selecting
      // PDF text while this bridge-owned mode-NONE pen contact is panning.
      // A normal click remains available for PDF links and reading controls.
      event.preventDefault();
    }
    return pointer;
  }

  function manualPointerSessionCurrent(pointer) {
    return !!(
      pointer &&
      state.app?.pdfDocument === pointer.pdfDocument &&
      state.activeDocumentId === pointer.documentId &&
      state.activeOpenRequest === pointer.openRequest &&
      rendererGeneration === pointer.rendererGeneration &&
      pointer.container?.isConnected
    );
  }

  function applyManualPan(pointer, event, eventTime = null) {
    if (
      !pointer ||
      pointer.blockedByPen ||
      pointer.blockedByOtherPointer ||
      pointer.blockedByVisibility ||
      !manualPointerSessionCurrent(pointer)
    ) {
      return;
    }
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (!pointer.moved) {
      pointer.moved = Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      ) >= 3;
    }
    if (!pointer.moved) {
      return;
    }
    pointer.container.scrollTop = pointer.startScrollTop -
      (event.clientY - pointer.startY);
    pointer.container.scrollLeft = pointer.startScrollLeft -
      (event.clientX - pointer.startX);
    rememberManualScroll(
      pointer,
      eventTime ?? manualPointerEventTime(pointer, event),
    );
  }

  function finishManualPointer(pointerId, event = null, { cancel = false } = {}) {
    const pointer = state.manualPointers.get(pointerId);
    if (!pointer) {
      return null;
    }
    // WebViews may deliver the final contact position only on pointerup.
    // Consume it before deriving release velocity, never on cancellation.
    const releaseTime = manualPointerEventTime(pointer, event);
    if (
      pointer.pointerType === "touch" && !cancel &&
      Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
    ) {
      applyManualPan(pointer, event, releaseTime);
    }
    state.manualPointers.delete(pointerId);
    if (pointer.pointerType === "touch") {
      if (cancel || !manualPointerSessionCurrent(pointer)) {
        if (!pointer.cancelledByOtherPointer ||
          !manualPointerSessionCurrent(pointer)) {
          clearFingerTextSelectionSuppression();
        }
        cancelManualMomentum();
      } else {
        startManualMomentum(pointer, releaseTime);
      }
    }
    if (
      pointer.pointerType === "pen" &&
      pointer.moved &&
      !cancel &&
      manualPointerSessionCurrent(pointer)
    ) {
      state.lastPenPanClickPage = pointer.pageTarget;
    }
    releasePointerCapture(pointer);
    return pointer;
  }

  function clearManualPointerSessions({ clearClickTargets = true } = {}) {
    cancelManualMomentum();
    clearFingerTextSelectionSuppression();
    invalidatePendingPenHighlight();
    const pointers = [...state.manualPointers.values()];
    state.manualPointers.clear();
    for (const pointer of pointers) {
      releasePointerCapture(pointer);
    }
    state.penPolicyPointers.clear();
    if (clearClickTargets) {
      state.lastTouchClickPage = null;
      state.lastPenPanClickPage = null;
    }
  }

  function onBridgeIosClick(event) {
    if (
      !iosInputPolicy ||
      !(event.target instanceof Element) ||
      !isViewerSurfaceTarget(event.target) ||
      isNativeContextTarget(event.target)
    ) {
      return;
    }
    const page = directManipulationPage(event.target);
    const isTouchClick = event.pointerType === "touch" || (
      event.detail > 0 &&
      state.lastTouchClickPage &&
      (!page || page === state.lastTouchClickPage)
    );
    const isCompletedPenPan = event.detail > 0 &&
      state.lastPenPanClickPage &&
      (!page || page === state.lastPenPanClickPage);
    if (isTouchClick || isCompletedPenPan) {
      stopDirectManipulationEvent(event);
    }
  }

  function onBridgeIosDoubleClick(event) {
    if (
      !iosInputPolicy ||
      !(event.target instanceof Element) ||
      !isViewerSurfaceTarget(event.target) ||
      isNativeContextTarget(event.target) ||
      event.detail < 2
    ) {
      return;
    }
    const page = directManipulationPage(event.target);
    if (
      state.lastTouchClickPage &&
      (!page || page === state.lastTouchClickPage)
    ) {
      stopDirectManipulationEvent(event);
    } else if (
      state.lastPenPanClickPage &&
      (!page || page === state.lastPenPanClickPage)
    ) {
      stopDirectManipulationEvent(event);
    }
  }

  function pointerInteractionKind(event, target) {
    if (event.button === 0) {
      if (target.closest(".annotationEditorLayer")) {
        return "editor";
      }
      if (
        [9, 10].includes(state.editorMode) &&
        target.closest(".textLayer")
      ) {
        return "text-selection";
      }
      return null;
    }
    if (
      event.pointerType !== "mouse" ||
      isNativeContextTarget(target) ||
      !target.closest("#viewerContainer")
    ) {
      return null;
    }
    if (event.button === 1) {
      return "tool-wheel";
    }
    if (event.button === 2) {
      return "right-eraser";
    }
    return null;
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
    if (!state.pendingPenHighlight) {
      return;
    }
    if (!pointer || state.pendingPenHighlight === pointer) {
      clearOwnedPenTextSelection(state.pendingPenHighlight);
      state.pendingPenHighlight = null;
    }
  }

  function selectionSnapshot(selection) {
    if (!selection) {
      return null;
    }
    return {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
      isCollapsed: selection.isCollapsed,
      rangeCount: selection.rangeCount,
      text: selection.toString(),
    };
  }

  function selectionMatchesSnapshot(selection, snapshot) {
    return !!(
      selection &&
      snapshot &&
      selection.anchorNode === snapshot.anchorNode &&
      selection.anchorOffset === snapshot.anchorOffset &&
      selection.focusNode === snapshot.focusNode &&
      selection.focusOffset === snapshot.focusOffset &&
      selection.isCollapsed === snapshot.isCollapsed &&
      selection.rangeCount === snapshot.rangeCount &&
      selection.toString() === snapshot.text
    );
  }

  function caretPositionInTextLayer(clientX, clientY, textLayer) {
    let position = null;
    try {
      position = document.caretPositionFromPoint?.(clientX, clientY) || null;
    } catch {
      // Some embedded WebKit versions expose but reject caretPositionFromPoint.
    }
    if (!position) {
      try {
        position = document.caretRangeFromPoint?.(clientX, clientY) || null;
      } catch {
        // Ignore an unsupported or unavailable browser caret query.
      }
    }
    const node = position?.offsetNode || position?.startContainer || null;
    const offset = position?.offset ?? position?.startOffset;
    if (
      !node ||
      !Number.isInteger(offset) ||
      !textLayer?.contains(node)
    ) {
      return null;
    }
    return { node, offset };
  }

  function clearOwnedPenTextSelection(pointer) {
    const owned = pointer?.ownedPenTextSelection;
    if (!owned) {
      return;
    }
    const selection = document.getSelection();
    if (selectionMatchesSnapshot(selection, owned)) {
      selection.removeAllRanges();
    }
    pointer.ownedPenTextSelection = null;
  }

  function updateOwnedPenTextSelection(pointer, event) {
    if (
      !pointer?.penTextSelectionCandidate ||
      state.pendingPenHighlight !== pointer ||
      !pointer.moved ||
      !isPointerSessionCurrent(pointer) ||
      !pointer.textLayer?.isConnected ||
      !pointer.textSelectionStart
    ) {
      return false;
    }
    const endpoint = caretPositionInTextLayer(
      event.clientX,
      event.clientY,
      pointer.textLayer,
    );
    if (!endpoint) {
      return false;
    }
    const selection = document.getSelection();
    if (typeof selection?.setBaseAndExtent !== "function") {
      return false;
    }
    if (pointer.ownedPenTextSelection) {
      if (!selectionMatchesSnapshot(selection, pointer.ownedPenTextSelection)) {
        pointer.ownedPenTextSelection = null;
        pointer.penTextSelectionCandidate = false;
        pointer.penTextSelectionOwnershipLost = true;
        return false;
      }
    } else if (
      !pointer.selectionAtDown?.isCollapsed ||
      !selectionMatchesSnapshot(selection, pointer.selectionAtDown)
    ) {
      // A range created by the browser or another user action takes priority.
      pointer.penTextSelectionCandidate = false;
      return false;
    }
    if (!pointer.textLayer.contains(pointer.textSelectionStart.node)) {
      pointer.penTextSelectionCandidate = false;
      return false;
    }
    try {
      selection.setBaseAndExtent(
        pointer.textSelectionStart.node,
        pointer.textSelectionStart.offset,
        endpoint.node,
        endpoint.offset,
      );
    } catch {
      return false;
    }
    pointer.ownedPenTextSelection = selectionSnapshot(selection);
    event.preventDefault();
    return true;
  }

  function onBridgePenTextCompatibilityMouse(event) {
    if ([...state.activePointers.values()].some((pointer) =>
      pointer.pointerType === "pen" &&
      pointer.kind === "text-selection" &&
      pointer.mode === 9 &&
      pointer.penTextSelectionGesture
    )) {
      stopDirectManipulationEvent(event);
    }
  }

  function selectionChangedSincePenDown(selection, pointer) {
    const initial = pointer.selectionAtDown;
    return !!(
      !initial ||
      initial.anchorNode !== selection.anchorNode ||
      initial.anchorOffset !== selection.anchorOffset ||
      initial.focusNode !== selection.focusNode ||
      initial.focusOffset !== selection.focusOffset ||
      initial.isCollapsed !== selection.isCollapsed ||
      initial.text !== selection.toString()
    );
  }

  function hasOtherActivePenPointer(pointer) {
    return [...state.activePointers.values()].some((candidate) =>
      candidate !== pointer &&
      candidate.pointerType === "pen" &&
      !candidate.ending
    ) || [...state.penPolicyPointers.keys()].some((pointerId) =>
      pointerId !== pointer.pointerId
    ) || [...state.manualPointers.values()].some((candidate) =>
      candidate !== pointer && candidate.pointerType === "pen"
    );
  }

  function finishPenHighlightFallback(pointer) {
    if (state.pendingPenHighlight !== pointer) {
      return;
    }
    state.pendingPenHighlight = null;
    const manager =
      state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
    const pdfViewer = state.app?.pdfViewer;
    const pageIndex = Number(pointer.page?.dataset.pageNumber) - 1;
    const pageView = Number.isInteger(pageIndex) && pageIndex >= 0
      ? pdfViewer?.getPageView?.(pageIndex)
      : null;
    const pageEditorLayerBuilder = pageView?.annotationEditorLayer;
    const selection = document.getSelection();
    if (
      !pointer.ending ||
      pointer.kind !== "text-selection" ||
      pointer.pointerType !== "pen" ||
      pointer.button !== 0 ||
      pointer.mode !== 9 ||
      !pointer.moved ||
      pointer.penTextSelectionOwnershipLost ||
      !isPointerSessionCurrent(pointer) ||
      state.editorMode !== 9 ||
      state.app?.pdfViewer?.annotationEditorMode !== 9 ||
      manager !== pointer.highlightManager ||
      manager?.getMode?.() !== 9 ||
      !manager.currentLayer ||
      manager.getLayer?.(pageIndex) !== pointer.pageEditorLayer ||
      pageEditorLayerBuilder !== pointer.pageEditorLayerBuilder ||
      pageEditorLayerBuilder?.annotationEditorLayer !== pointer.pageEditorLayer ||
      pageEditorLayerBuilder?.div !== pointer.pageEditorLayer?.div ||
      !pointer.pageEditorLayer?.div?.isConnected ||
      !pointer.page?.contains(pointer.pageEditorLayer.div) ||
      !pointer.pageEditorLayer.hasTextLayer?.(pointer.textLayer) ||
      typeof manager?.highlightSelection !== "function" ||
      !pointer.textLayer?.isConnected ||
      pointer.page !== pointer.textLayer.closest(".page") ||
      !pointer.page?.contains(pointer.textLayer) ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0 ||
      !selection.toString() ||
      (pointer.ownedPenTextSelection &&
        !selectionMatchesSnapshot(selection, pointer.ownedPenTextSelection)) ||
      !selectionChangedSincePenDown(selection, pointer) ||
      !pointer.textLayer.contains(selection.anchorNode) ||
      !pointer.textLayer.contains(selection.focusNode) ||
      hasOtherActivePenPointer(pointer) ||
      state.closeControl ||
      state.disposed
    ) {
      return;
    }
    for (let index = 0; index < selection.rangeCount; index += 1) {
      if (!pointer.textLayer.contains(selection.getRangeAt(index).commonAncestorContainer)) {
        return;
      }
    }
    manager.highlightSelection("main_toolbar");
  }

  function cancelPdfJsPointerSession(pointer) {
    if (!isPointerSessionCurrent(pointer)) {
      return;
    }
    if (pointer.button === 1) {
      // PDFViewerApplication owns this non-private underscore state: the
      // existing closeToolWheel helper is local to viewer.mjs and not
      // callable from the bridge. Clear the same DOM/state fields if a
      // physical middle-button session is cancelled before pointerup.
      const app = state.app;
      if (app?._toolWheel?.pointerId === pointer.pointerId) {
        app._toolWheel.element?.remove();
        app._toolWheel = null;
        app._toolWheelPointer = null;
      }
      return;
    }
    if (pointer.button === 2) {
      state.app?.pdfAnnotationEraser?.cancelTemporaryStroke?.();
      return;
    }
    if (pointer.button === 0 && [5, 15].includes(pointer.mode)) {
      // DrawingEditor exposes endDrawingSession(isAborted). Use PDF.js's own
      // cancellation path so a lost physical release cannot leave its private
      // CurrentPointers/drawing session waiting for an event that can no
      // longer reach this document.
      const manager =
        state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      manager?.currentLayer?.endDrawingSession?.(true);
    }
    if (
      pointer.button === 0 &&
      ["mouse", "pen"].includes(pointer.pointerType) &&
      ["move", "resize"].includes(pointer.nativeOperation) &&
      !pointer.internalCancelScheduled
    ) {
      // PDF.js's move and resize sessions keep their cleanup callbacks in
      // private closures that listen for pointerup/blur, not pointercancel.
      // Finish only this still-current pointer session with an explicitly
      // untrusted PointerEvent; never synthesize a MouseEvent or claim a
      // hardware pointerup was received. The private PDF.js listeners use the
      // matching pointerId to release selection/cursor/resize state.
      pointer.internalCancelScheduled = true;
      setDeferredTimeout(() => {
        if (
          state.activePointers.get(pointer.pointerId) !== pointer ||
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
          cleanupEvent,
          state.activePointers.size,
        );
        window.dispatchEvent(cleanupEvent);
      }, 0);
    }
  }

  function releasePointerCapture(pointer) {
    try {
      if (pointer.captureTarget?.hasPointerCapture?.(pointer.pointerId)) {
        pointer.captureTarget.releasePointerCapture(pointer.pointerId);
      }
    } catch {
      // The browser can release capture as part of pointercancel or frame blur.
    }
  }

  function finishTrackedPointer(pointerId, reason, event = null, { cancel = false } = {}) {
    const pointer = state.activePointers.get(pointerId);
    if (!pointer || pointer.ending) {
      return;
    }
    if (
      !cancel && reason === "pointerup" &&
      pointer.penTextSelectionCandidate
    ) {
      // Some WebViews deliver the last caret position only with pointerup,
      // especially when a Pencil crosses the whitespace between text lines.
      updateOwnedPenTextSelection(pointer, event);
    }
    state.penPolicyPointers.delete(pointerId);
    pointer.ending = true;
    pointer.buttons = Number.isInteger(event?.buttons)
      ? event.buttons
      : pointer.buttons;
    if (cancel) {
      invalidatePendingPenHighlight(pointer);
      cancelPdfJsPointerSession(pointer);
    }
    // Pointer listeners in PDF.js finish the editor, temporary eraser, and
    // tool wheel during this dispatch. Defer bridge cleanup until they run.
    setDeferredTimeout(() => {
      if (state.activePointers.get(pointerId) !== pointer) {
        return;
      }
      if (!cancel && reason === "pointerup") {
        finishPenHighlightFallback(pointer);
      }
      if (cancel && !isPointerSessionCurrent(pointer)) {
        // The session changed while the event was in flight; only release the
        // bridge's own bookkeeping and browser capture.
      }
      releasePointerCapture(pointer);
      state.activePointers.delete(pointerId);
      recordPointerDiagnostic(
        reason === "pointerup" ? "pointerup" : "pointercancel",
        pointer,
        event,
        state.activePointers.size,
      );
      if (pointer.button === 0 && pointer.mode === 15) {
        // Ink keeps its drawing session open for additional strokes. The idle
        // timer commits it after this stroke has been quiet for one second.
        state.pendingInkCommit = true;
        state.autoSavePending = true;
      }
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

  function onBridgePointerDown(event) {
    cancelManualMomentum();
    invalidatePendingPenHighlight();
    dismissToolbarParameterPopups(event);
    if (iosInputPolicy && event.pointerType !== "touch") {
      clearFingerTextSelectionSuppression();
    } else if (
      iosInputPolicy && event.pointerType === "touch" &&
      state.manualPointers.size > 0 &&
      !state.manualPointers.has(event.pointerId)
    ) {
      // A second finger anywhere in the document cancels manual panning, but
      // keeps the touch-owned text-selection guard until Pencil/mouse handoff.
      for (const pointer of state.manualPointers.values()) {
        pointer.blockedByOtherPointer = true;
        pointer.cancelledByOtherPointer = true;
        pointer.moved = false;
        pointer.lastMotionAt = null;
      }
    }
    if (state.closeControl) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!(event.target instanceof Element)) {
      return;
    }
    const target = event.target;
    if (iosInputPolicy && event.pointerType !== "touch") {
      // A real mouse or Pencil press starts a fresh interaction. This keeps a
      // prior finger tap from suppressing a later physical click without a
      // timeout-based compatibility-mouse heuristic.
      state.lastTouchClickPage = null;
      state.lastPenPanClickPage = null;
    }
    if (
      iosInputPolicy &&
      event.pointerType === "touch" &&
      isViewerSurfaceTarget(target) &&
      !isNativeContextTarget(target)
    ) {
      startManualPointer(event, "touch");
      return;
    }
    if (
      iosInputPolicy &&
      event.pointerType === "pen" &&
      isViewerSurfaceTarget(target) &&
      !isNativeContextTarget(target)
    ) {
      const eraserActive = document.body.classList.contains("editorEraserMode");
      const nativeOperation = target.closest(".resizer")
        ? "resize"
        : target.closest(".draggable.selectedEditor")
          ? "move"
          : null;
      if (state.editorMode !== 0 || eraserActive || nativeOperation) {
        state.penPolicyPointers.set(event.pointerId, {
          pointerId: event.pointerId,
          documentId: state.activeDocumentId,
          openRequest: state.activeOpenRequest,
          pdfDocument: state.app?.pdfDocument,
          rendererGeneration,
        });
        suspendTouchPansForPen();
      } else {
        // Mode NONE has no editor gesture to preserve. Let the native down/up
        // continue so Pencil taps still activate PDF links, while bridge-owned
        // moves scroll the viewer if the contact becomes a drag.
        startManualPointer(event, "pen");
        return;
      }
    }
    const kind = pointerInteractionKind(event, event.target);
    if (!kind || state.activePointers.has(event.pointerId)) {
      return;
    }
    const captureTarget =
      kind === "text-selection"
        ? event.target.closest(".textLayer")
        : event.target;
    const pointer = {
      pointerId: event.pointerId,
      button: event.button,
      buttons: event.buttons,
      pointerType: normalizedPointerType(event.pointerType),
      kind,
      nativeOperation:
        event.button === 0 && ["mouse", "pen"].includes(event.pointerType)
          ? event.target.closest(".resizer")
            ? "resize"
            : event.target.closest(".draggable.selectedEditor")
              ? "move"
              : null
          : null,
      mode: state.editorMode,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      moveSampled: false,
      captureTarget,
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
      pointer.textLayer = event.target.closest(".textLayer");
      pointer.textSpan = event.target.closest(".textLayer span");
      pointer.page = pointer.textLayer?.closest(".page");
      const pageIndex = Number(pointer.page?.dataset.pageNumber) - 1;
      pointer.pageEditorLayerBuilder = Number.isInteger(pageIndex) && pageIndex >= 0
        ? state.app?.pdfViewer?.getPageView?.(pageIndex)?.annotationEditorLayer
        : null;
      pointer.pageEditorLayer =
        pointer.pageEditorLayerBuilder?.annotationEditorLayer || null;
      pointer.highlightManager =
        state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager;
      pointer.selectionAtDown = selectionSnapshot(document.getSelection());
      if (
        pointer.textLayer &&
        pointer.page &&
        pointer.pageEditorLayer &&
        pointer.highlightManager
      ) {
        state.pendingPenHighlight = pointer;
        const caret = caretPositionInTextLayer(
          event.clientX,
          event.clientY,
          pointer.textLayer,
        );
        if (
          pointer.textSpan &&
          pointer.textLayer.contains(pointer.textSpan) &&
          caret &&
          (pointer.textSpan === caret.node || pointer.textSpan.contains(caret.node)) &&
          pointer.selectionAtDown?.isCollapsed === true &&
          event.isTrusted
        ) {
          pointer.textSelectionStart = caret;
          pointer.penTextSelectionCandidate = true;
          pointer.penTextSelectionGesture = true;
          // Own this glyph-span gesture so the browser's compatibility mouse
          // sequence cannot start a second PDF.js selection or freehand path.
          event.preventDefault();
        }
      }
    }
    state.activePointers.set(event.pointerId, pointer);
    recordPointerDiagnostic("pointerdown", pointer, event);
    if (
      (event.pointerType === "mouse" || pointer.nativeOperation) &&
      event.button !== 2 &&
      !(event.button === 0 &&
        document.body.classList.contains("editorEraserMode"))
    ) {
      try {
        captureTarget?.setPointerCapture?.(event.pointerId);
      } catch {
        // Keep PDF.js's native handling when a target cannot capture this
        // pointer; pointerout/blur still close the bridge boundary below.
      }
    }
    clearAutoSaveTimer();
  }

  function installPointerTrackingListeners() {
    if (state.pointerAbortController || state.disposed) {
      return;
    }
    const controller = new AbortController();
    state.pointerAbortController = controller;
    for (const [type, listener] of [
      ["pointerdown", onBridgePointerDown],
      ["pointermove", onBridgePointerMove],
      ["pointerup", onBridgePointerEnd],
      ["pointercancel", onBridgePointerEnd],
      ["mousedown", onBridgePenTextCompatibilityMouse],
      ["mousemove", onBridgePenTextCompatibilityMouse],
      ["mouseup", onBridgePenTextCompatibilityMouse],
      ["pointerout", onBridgePointerOut],
      ["lostpointercapture", onBridgeLostPointerCapture],
      ["wheel", onBridgeWheel],
      ["click", onBridgeIosClick],
      ["dblclick", onBridgeIosDoubleClick],
      ["selectstart", onBridgeFingerSelectStart],
      ["contextmenu", onBridgeFingerContextMenu],
      ["blur", onBridgeWindowBlur],
      ["keydown", onBridgePointerKeyDown],
    ]) {
      window.addEventListener(type, listener, {
        capture: true,
        signal: controller.signal,
      });
    }
    document.addEventListener(
      "visibilitychange",
      onManualDocumentVisibilityChange,
      { signal: controller.signal },
    );
  }

  function onBridgeWheel() {
    cancelManualMomentum();
  }

  function onBridgePointerMove(event) {
    const manualPointer = state.manualPointers.get(event.pointerId);
    if (manualPointer) {
      if (manualPointer.pointerType === "touch") {
        stopDirectManipulationEvent(event);
        applyManualPan(manualPointer, event);
      } else {
        applyManualPan(manualPointer, event);
        if (manualPointer.moved && !manualPointer.blockedByPen) {
          event.preventDefault();
        }
      }
      return;
    }
    const pointer = state.activePointers.get(event.pointerId);
    if (!pointer || pointer.ending) {
      return;
    }
    pointer.buttons = event.buttons;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (!pointer.moveSampled) {
      pointer.moveSampled = true;
      recordPointerDiagnostic("pointermove", pointer, event);
    }
    if (!pointer.moved) {
      pointer.moved =
        Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >
        1;
    }
    if (pointer.penTextSelectionCandidate) {
      updateOwnedPenTextSelection(pointer, event);
    }
  }

  function onBridgePointerEnd(event) {
    const manualPointer = state.manualPointers.get(event.pointerId);
    if (manualPointer) {
      const pointer = finishManualPointer(event.pointerId, event, {
        cancel: event.type === "pointercancel",
      });
      if (pointer?.pointerType === "touch") {
        stopDirectManipulationEvent(event);
      }
      return;
    }
    state.penPolicyPointers.delete(event.pointerId);
    finishTrackedPointer(event.pointerId, event.type || "pointerup", event, {
      cancel: event.type === "pointercancel",
    });
  }

  function onBridgePointerOut(event) {
    const manualPointer = state.manualPointers.get(event.pointerId);
    if (manualPointer) {
      if (
        event.relatedTarget !== null ||
        manualPointer.captureTarget?.hasPointerCapture?.(event.pointerId)
      ) {
        return;
      }
      const pointer = finishManualPointer(event.pointerId, event, { cancel: true });
      if (pointer?.pointerType === "touch") {
        stopDirectManipulationEvent(event);
      }
      return;
    }
    if (
      state.penPolicyPointers.has(event.pointerId) &&
      event.relatedTarget === null
    ) {
      state.penPolicyPointers.delete(event.pointerId);
    }
    const pointer = state.activePointers.get(event.pointerId);
    if (
      !pointer ||
      pointer.ending ||
      event.relatedTarget !== null ||
      pointer.captureTarget?.hasPointerCapture?.(event.pointerId)
    ) {
      return;
    }
    finishTrackedPointer(event.pointerId, "pointerout", event, { cancel: true });
  }

  function onBridgeLostPointerCapture(event) {
    const manualPointer = state.manualPointers.get(event.pointerId);
    if (manualPointer) {
      const pointer = finishManualPointer(event.pointerId, event, { cancel: true });
      if (pointer?.pointerType === "touch") {
        stopDirectManipulationEvent(event);
      }
      return;
    }
    state.penPolicyPointers.delete(event.pointerId);
    const pointer = state.activePointers.get(event.pointerId);
    if (!pointer || pointer.ending) {
      return;
    }
    finishTrackedPointer(event.pointerId, "lostpointercapture", event, {
      cancel: true,
    });
  }

  function onBridgeWindowBlur(event) {
    if (event?.target !== window) {
      return;
    }
    clearManualPointerSessions();
    for (const [pointerId, pointer] of state.activePointers) {
      if (!pointer.ending) {
        finishTrackedPointer(pointerId, "blur", null, { cancel: true });
      }
    }
  }

  function onBridgePointerKeyDown(event) {
    if (event.key === "Escape") {
      for (const [pointerId, pointer] of state.activePointers) {
        if (pointer.button === 2) {
          finishTrackedPointer(pointerId, "escape", null, { cancel: true });
        }
      }
    }
  }

  function onBridgeFocusIn(event) {
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
        [...state.activePointers.values()].some((pointer) => pointer.button === 2)
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
    state.activePointers.clear();
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
        if (state.savePromise) {
          // Closing waits for a write already accepted by the host, but never
          // starts another one from this lifecycle-only request.
          result = await state.savePromise;
          if (
            result === false &&
            state.activeDocumentId === documentId &&
            isDirty() &&
            (!state.autoSaveEnabled || state.autoSavePaused)
          ) {
            // The accepted write may have failed while newer edits were still
            // being made. Keep the close request eligible for a recovery copy
            // of the current revision; do not retry the original-PDF overwrite.
            result = true;
          }
        }
        if (
          closeControl &&
          (state.closeControl !== closeControl || closeControl.cancelled)
        ) {
          result = false;
        }
        if (
          result === true &&
          state.activeDocumentId === documentId &&
          (closeControl ? isInputBusy() : isEditBoundaryBusy())
        ) {
          result = await waitForInputBoundary(
            Math.max(0, closeDeadline - Date.now()),
            closeControl,
          );
        }
        if (
          result === true &&
          state.activeDocumentId === documentId &&
          closeControl
        ) {
          if (state.closeControl !== closeControl || closeControl.cancelled) {
            result = false;
          } else {
            commitFocusedFreeText();
            if (
              !isEditBoundaryBusy() &&
              setCloseInputInert(closeControl)
            ) {
              // Once input is quiescent, keep the controlled close isolated
              // from fresh edits until the host removes or resumes the view.
            } else {
              result = false;
            }
          }
        }
        if (
          result === true &&
          state.activeDocumentId === documentId &&
          !isDirty()
        ) {
          // A clean document needs no write, even when autosave is disabled or
          // paused after an earlier conflict.
          result = true;
        } else if (
          result === true &&
          state.activeDocumentId === documentId &&
          (!state.autoSaveEnabled || state.autoSavePaused)
        ) {
          const reason = state.autoSavePaused
            ? "save-conflict"
            : "auto-save-disabled";
          recovered = await requestRecovery(reason, closeDeadline);
          result = false;
        } else if (result === true && state.activeDocumentId === documentId) {
          if (state.pendingInkCommit) {
            state.committingInkForSave = true;
            try {
              state.app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
            } finally {
              state.committingInkForSave = false;
              state.pendingInkCommit = false;
            }
          }
          result = await requestSave("manual");
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
    state.requestedOpenRequest = Number.isInteger(message.openRequest)
      ? message.openRequest
      : null;
    if (!state.ready) {
      state.queuedOpens.push(message);
      return;
    }
    state.openQueue = state.openQueue
      .then(() => openDocument(message))
      .catch((error) => {
        sendError(error?.message || "Could not open the PDF.", {
          documentId: message.documentId,
          code: "open-failed",
        });
      });
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
        documentId: state.activeDocumentId,
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
        documentId: state.activeDocumentId,
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
          documentId: state.activeDocumentId,
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
              documentId: state.activeDocumentId,
              code: "open-blocked-by-unsaved-changes",
            });
            return;
          }
        } else if (isEditBoundaryBusy() && !state.pendingSave) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId: state.activeDocumentId,
            code: "open-blocked-by-unsaved-changes",
          });
          return;
        }
        const priorSaveSucceeded = await priorSave;
        if (!(await finishPreviousSave(priorSaveSucceeded))) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId: state.activeDocumentId,
            code: "open-blocked-by-unsaved-changes",
          });
          return;
        }
      } else if (isDirty()) {
        if (!state.autoSaveEnabled || state.autoSavePaused || isInputBusy()) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId: state.activeDocumentId,
            code: "open-blocked-by-unsaved-changes",
          });
          return;
        }
        if (state.pendingInkCommit) {
          state.committingInkForSave = true;
          try {
            app?.pdfViewer?._layerProperties?.annotationEditorUIManager?.currentLayer?.commitOrRemove?.();
          } finally {
            state.committingInkForSave = false;
            state.pendingInkCommit = false;
          }
        }
        const sessionToSave = captureAutoSaveSession();
        const priorSave = requestSave("auto");
        rearmPendingFreeTextAutoSave(sessionToSave);
        const priorSaveSucceeded = await priorSave;
        if (!(await finishPreviousSave(priorSaveSucceeded))) {
          sendError("The previous PDF still has unsaved changes.", {
            documentId: state.activeDocumentId,
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
      clearScheduledWork();
      cleanupStorageObserver();
      if (typeof message.heavyLeaseRequired === "boolean") {
        state.hostHeavyLeaseRequired = message.heavyLeaseRequired;
      }
      state.activeDocumentId = null;
      updatePageNumberWidth(0);
      state.activeDocumentPath = null;
      state.activeFilename = null;
      state.activeOpenRequest = null;
      state.readOnly = false;
      state.dirty = false;
      state.editorHistory.canUndo = false;
      state.editorHistory.canRedo = false;
      state.editorHistory.hasSelection = false;
      state.revision = 0;
      state.confirmedRevision = 0;
      state.lastRecoveredDocumentId = null;
      state.lastRecoveredRevision = null;
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
      const parseStartedAt = performance.now();
      session.previousLoadingTask = app.pdfLoadingTask;
      session.previousPdfDocument = app.pdfDocument;
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
      session.loadingTask = app.pdfLoadingTask;
      const parsedAt = performance.now();

      const { pdfDocument } = await waitForDocumentLoaded(app, session);
      if (session.signal.aborted || state.disposed) {
        return false;
      }
      cleanupStorageObserver();
      state.activeDocumentId = documentId;
      updatePageNumberWidth(pdfDocument.numPages);
      state.activeDocumentPath = documentPath;
      state.activeFilename = filename;
      state.activeOpenRequest = Number.isInteger(message.openRequest)
        ? message.openRequest
        : null;
      state.readOnly = message.readOnly === true;
      state.dirty = restoreDirty;
      state.revision = isSyncApply ? 0 : restoredRevision;
      state.confirmedRevision = isSyncApply ? 0 : restoredConfirmedRevision;
      state.autoSavePaused = restorePaused;
      applySyncIdentities(message.syncState, { reset: true });
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
      setReadOnlyState(state.readOnly);

      if (isSyncApply) {
        await restoreSyncViewState(app, message.viewState, session);
      }

      if (state.activeDocumentId !== documentId || state.disposed) {
        return false;
      }
      if (!isSyncApply) {
        const startupTimings = captureOpenStartupTimings({
          startedAt,
          parseStartedAt,
          parsedAt,
          app,
          pdfDocument,
        });
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
      cleanupStorageObserver();
      state.activeDocumentId = null;
      updatePageNumberWidth(0);
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
      pending.resolve();
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
        if (
          Number.isSafeInteger(message.openRequest) &&
          message.openRequest !== pending.openRequest
        ) {
          pending.reject(
            new Error("Obsidian acknowledged a different PDF open request."),
          );
          return;
        }
        if (
          message.syncState &&
          state.activeDocumentId === pending.documentId &&
          state.activeOpenRequest === pending.openRequest
        ) {
          applySyncIdentities(message.syncState);
        }
        pending.resolve(message.syncState);
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
        app.eventBus?._on(
          "pagerendered",
          ({ pageNumber }) => {
            if (state.activeDocumentId && Number.isInteger(pageNumber)) {
              observeAccessibilityManager(
                app,
                app.pdfViewer?.getPageView?.(pageNumber - 1),
              );
            }
          },
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "pagesloaded",
          ({ pagesCount } = {}) => {
            updatePageNumberWidth(pagesCount);
            observeAccessibilityManagers(app);
          },
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "annotationeditorlayerrendered",
          ({ pageNumber }) => {
            if (state.activeDocumentId && Number.isInteger(pageNumber)) {
              observeAccessibilityManager(
                app,
                app.pdfViewer?.getPageView?.(pageNumber - 1),
              );
            }
          },
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "annotationeditormodechanged",
          ({ mode }) => {
            cancelManualMomentum();
            invalidatePendingPenHighlight();
            state.editorMode = mode;
            if (annotationToolIsActive()) {
              refreshFingerTextSelectionSuppression();
            } else {
              clearFingerTextSelectionSuppression();
            }
            observeAccessibilityManagers(app);
            setDeferredTimeout(
              () => observeAccessibilityManagers(app),
              0,
            );
            if (mode !== 0) {
              cancelPendingFreeTextAppearanceRepair();
            }
            if (state.readOnly) {
              setReadOnlyState(true);
            }
            syncBridgeControls();
          },
          { signal: state.eventAbortController.signal },
        );
        app.eventBus?._on(
          "editingstateschanged",
          ({ details = {} }) => {
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
          },
          { signal: state.eventAbortController.signal },
        );
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
    if (state.disposed) {
      return;
    }
    updatePageNumberWidth(0);
    postLifecycleToHost("renderer-unloaded");
    cancelPendingHeavyLeaseWaiters("The PDF view was closed.");
    state.disposed = true;
    state.toolbarLayoutResizeObserver?.disconnect();
    state.toolbarLayoutResizeObserver = null;
    state.toolbarLayoutMutationObserver?.disconnect();
    state.toolbarLayoutMutationObserver = null;
    if (state.toolbarLayoutFrame) {
      cancelAnimationFrame(state.toolbarLayoutFrame);
      state.toolbarLayoutFrame = 0;
    }
    document.documentElement.classList.remove("pdfReaderBridgeTwoRow");
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
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("unload", dispose);
    clearTimeout(state.statusTimer);
    clearTimeout(state.startupTimer);
    clearScheduledWork();
    cleanupStorageObserver();
    state.eventAbortController?.abort();
    state.eventAbortController = null;
    state.pointerAbortController?.abort();
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
