import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridgeSource = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
const annotationControllerSource = await readFile(
  new URL("../viewer-adapter/input/annotation-controller.js", import.meta.url),
  "utf8",
);
const iosControllerSource = await readFile(
  new URL("../viewer-adapter/input/ios-direct-manipulation-controller.js", import.meta.url),
  "utf8",
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const body = source.indexOf(") {", start) + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = body; index < source.length; index += 1) {
    const char = source[index], next = source[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (["'", '"', "`"].includes(char)) { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

const bridgeFunctions = [
  "normalizeAnnotationToolMode",
  "vocabularyReadModeIsSafe",
  "requestVocabularyReadMode",
  "syncVocabularyMenuButton",
  "setVocabularyEnabled",
  "restorePreferredAnnotationTool",
  "bindVocabularyToOpenedDocument",
  "onBridgeIosClick",
].map((name) => extractFunction(bridgeSource, name)).join("\n");
const keyboardReadCancellation = bridgeSource.match(
  /if \(mode !== 0 && isFromKeyboard\) state\.annotationController\?\.cancelPendingReadMode\?\.\(\);/,
)?.[0];
assert.ok(keyboardReadCancellation, "the keyboard mode-change hook must cancel a pending LingQ READ request");

function makeBridgeHarness({ mobile = false } = {}) {
  const context = vm.createContext({
    window: { PdfReaderInputRuntime: { InteractionMode: { resolve: ({ editorMode }) => editorMode === 0 ? "READ" : "INK" } } },
    document: { documentElement: { dataset: {} }, body: { classList: { contains: () => false } } },
  });
  vm.runInContext(annotationControllerSource, context);
  const harness = vm.runInContext(`(() => {
    const calls = [];
    const events = [];
    const pdfDocument = {};
    const state = {
      disposed: false,
      vocabularyEnabled: false,
      vocabularyController: {
        setDocument(...args) { calls.push({ type: "setDocument", args }); },
        dispose() { calls.push({ type: "dispose" }); },
        dismissEntryPill() {},
        handleTap(intent) { calls.push({ type: "lookup", intent }); },
      },
      app: null,
      bridgeControls: null,
      activeDocumentId: "doc-a",
      activeOpenRequest: 11,
      requestedDocumentId: "doc-a",
      requestedOpenRequest: 11,
      pendingVocabularySettings: null,
      annotationController: null,
      iosDirectManipulationController: null,
      inputPolicy: { handlePanClick: () => false },
      editorMode: 15,
      preferredAnnotationToolMode: 15,
      restoredAnnotationToolIdentity: null,
      readOnly: false,
      externalSourceConfirmed: true,
      closeControl: null,
      isComposing: false,
      compositionEndPending: false,
      freeTextFocused: false,
      freeTextCommittedForSave: false,
    };
    const pdfViewer = {
      annotationEditorMode: 15,
      _layerProperties: { annotationEditorUIManager: {} },
    };
    const eventBus = {
      dispatch(type, event) {
        events.push({ type, event });
        if (type === "switchannotationeditormode") {
          state.editorMode = event.mode;
          pdfViewer.annotationEditorMode = event.mode;
        }
      },
    };
    state.app = { pdfDocument, pdfViewer, eventBus };
    state.annotationController = new window.PdfReaderInputRuntime.AnnotationController({
      getEventBus: () => state.app?.eventBus,
    });
    let editBoundaryBusy = false;
    let manualPointers = 0;
    let penPolicyPointers = 0;
    let mobileInputBusy = false;
    const PERSISTABLE_ANNOTATION_TOOL_MODES = new Set([3, 5, 9, 10, 15]);
    let rendererGeneration = "generation-a";
    function isEditBoundaryBusy() {
      return editBoundaryBusy || state.isComposing || state.compositionEndPending ||
        (state.freeTextFocused && !state.freeTextCommittedForSave);
    }
    function manualPointerCount() { return manualPointers; }
    function penPolicyPointerIds() { return penPolicyPointers ? [1] : []; }
    function annotationToolIsActive() { return state.editorMode !== 0; }
    function setEditBoundaryBusy(value) { editBoundaryBusy = value; }
    function setManualPointers(value) { manualPointers = value; }
    function setPenPolicyPointers(value) { penPolicyPointers = value; }
    function setMobileInputBusy(value) { mobileInputBusy = value; }
    function ensureVocabularyController() { return state.vocabularyController; }
    ${bridgeFunctions}
    return {
      state, calls, events, pdfDocument, pdfViewer, setEditBoundaryBusy,
      setManualPointers, setPenPolicyPointers, setMobileInputBusy,
      setRendererGeneration(value) { rendererGeneration = value; },
      getModePreferenceIsPersistable: () => PERSISTABLE_ANNOTATION_TOOL_MODES.has(0),
      vocabularyReadModeIsSafe,
      requestVocabularyReadMode,
      setVocabularyEnabled,
      restorePreferredAnnotationTool,
      bindVocabularyToOpenedDocument,
      onBridgeIosClick,
      notifyInputBoundary: () => state.annotationController.notifyInputBoundary(),
      hasPendingReadMode: () => state.annotationController.pendingReadModeRequest !== null,
      isMobileInputBusy: () => mobileInputBusy,
      setEditorMode(mode) { state.editorMode = mode; pdfViewer.annotationEditorMode = mode; },
      setPdfViewerMode(mode) { pdfViewer.annotationEditorMode = mode; },
    };
  })()`, context);
  if (mobile) {
    harness.state.iosDirectManipulationController = {
      hasActiveInputSession: () => harness.isMobileInputBusy(),
      consumeVocabularyTapCandidate: () => false,
      hasActivePenEditorGesture: () => false,
    };
  }
  return harness;
}

test("enabling LingQ from Ink enters READ and makes the guarded lookup path available", () => {
  const api = makeBridgeHarness();
  api.setVocabularyEnabled(true);
  assert.deepEqual(Array.from(api.events, ({ event }) => event.mode), [0]);
  assert.equal(api.state.editorMode, 0);
  assert.equal(api.getModePreferenceIsPersistable(), false, "READ does not overwrite the saved annotation tool");

  api.onBridgeIosClick({ type: "click", pointerType: "mouse", pageIndex: 2, clientPoint: { x: 20, y: 30 } }, {});
  assert.equal(api.calls.filter(({ type }) => type === "lookup").length, 1);
  api.setEditorMode(15);
  api.onBridgeIosClick({ type: "click", pointerType: "mouse", pageIndex: 2, clientPoint: { x: 20, y: 30 } }, {});
  assert.equal(api.calls.filter(({ type }) => type === "lookup").length, 1,
    "the existing annotation/Pencil-priority guard still suppresses lookup in tool mode");
});

test("an Ink gesture defers READ until its safe boundary, including on mobile", () => {
  for (const mobile of [false, true]) {
    const api = makeBridgeHarness({ mobile });
    if (mobile) api.setMobileInputBusy(true);
    else api.setEditBoundaryBusy(true);
    api.setVocabularyEnabled(true);
    assert.equal(api.events.length, 0);
    assert.equal(api.hasPendingReadMode(), true);

    if (mobile) api.setMobileInputBusy(false);
    else api.setEditBoundaryBusy(false);
    assert.equal(api.notifyInputBoundary(), true);
    assert.deepEqual(Array.from(api.events, ({ event }) => event.mode), [0]);
    assert.equal(api.hasPendingReadMode(), false);
  }
});

test("an async keyboard tool switch cannot release pending LingQ READ before the bridge catches up", () => {
  const api = makeBridgeHarness();
  api.setManualPointers(1);
  api.setVocabularyEnabled(true);
  assert.equal(api.hasPendingReadMode(), true);

  // PDF.js applies keyboard mode changes before the bridge's mode-changed
  // observer runs. Exercise the real extracted safety predicate in this gap.
  api.setPdfViewerMode(5);
  assert.equal(api.state.editorMode, 15, "the bridge still reports the previous Ink mode");
  assert.equal(api.vocabularyReadModeIsSafe(), false,
    "the real bridge safety predicate must reject a stale bridge/PDF.js mode pair");
  api.setManualPointers(0);
  assert.equal(api.notifyInputBoundary(), false,
    "a boundary during the async keyboard setter window must not dispatch READ");
  assert.equal(api.hasPendingReadMode(), true);
  assert.equal(api.events.length, 0);

  // Run the exact keyboard-cancellation guard from annotationeditormodechanged,
  // then the observer's mode update and boundary notification.
  const onKeyboardModeChanged = new Function(
    "state", "mode", "isFromKeyboard",
    `${keyboardReadCancellation}\nstate.editorMode = mode;\nstate.annotationController.notifyInputBoundary();`,
  );
  onKeyboardModeChanged(api.state, 5, true);
  assert.equal(api.hasPendingReadMode(), false,
    "the keyboard-selected annotation tool cancels the queued LingQ transition");
  assert.equal(api.events.length, 0, "no stale READ switch may follow the keyboard tool choice");
});

test("FreeText composition keeps the current mode until composition has fully ended", () => {
  const api = makeBridgeHarness();
  api.state.isComposing = true;
  api.setVocabularyEnabled(true);
  assert.equal(api.events.length, 0);
  api.state.isComposing = false;
  api.state.compositionEndPending = true;
  assert.equal(api.notifyInputBoundary(), false);
  api.state.compositionEndPending = false;
  assert.equal(api.notifyInputBoundary(), true);
  assert.deepEqual(Array.from(api.events, ({ event }) => event.mode), [0]);
});

test("manual and Pencil policy sessions also hold the transition until all inputs end", () => {
  const api = makeBridgeHarness();
  api.setManualPointers(1);
  api.setVocabularyEnabled(true);
  assert.equal(api.events.length, 0);
  api.setManualPointers(0);
  api.setPenPolicyPointers(1);
  api.notifyInputBoundary();
  assert.equal(api.events.length, 0, "a second active input session keeps READ pending");
  api.setPenPolicyPointers(0);
  assert.equal(api.notifyInputBoundary(), true);
  assert.deepEqual(Array.from(api.events, ({ event }) => event.mode), [0]);
});

test("a later explicit tool click cancels a pending LingQ READ request", () => {
  const api = makeBridgeHarness();
  api.setEditBoundaryBusy(true);
  api.setVocabularyEnabled(true);
  api.onBridgeIosClick({
    type: "click", targetRegion: "editor-mode-buttons", pointerType: "mouse",
    pageIndex: null, clientPoint: { x: 0, y: 0 },
  }, {});
  assert.equal(api.hasPendingReadMode(), false);
  assert.equal(api.requestVocabularyReadMode("doc-a", 11), false,
    "late bind or router-start callbacks cannot revive READ for the same explicit tool choice");
  api.setEditBoundaryBusy(false);
  assert.equal(api.notifyInputBoundary(), false);
  assert.equal(api.events.length, 0);

  api.setVocabularyEnabled(false);
  api.setEditorMode(15);
  api.setVocabularyEnabled(true);
  assert.equal(api.state.vocabularyReadModeToolChoice, null);
  assert.equal(api.requestVocabularyReadMode("doc-a", 11), true);
  assert.deepEqual(Array.from(api.events, ({ event }) => event.mode), [0],
    "an explicit LingQ off/on cycle clears the tool-choice override");
});

test("stale document requests cannot switch a later session, while late open-mode events do not cancel the current request", () => {
  const stale = makeBridgeHarness();
  stale.setEditBoundaryBusy(true);
  stale.setVocabularyEnabled(true);
  stale.state.activeDocumentId = "doc-b";
  stale.state.activeOpenRequest = 12;
  stale.state.requestedDocumentId = "doc-b";
  stale.state.requestedOpenRequest = 12;
  stale.setEditBoundaryBusy(false);
  assert.equal(stale.notifyInputBoundary(), false);
  assert.equal(stale.events.length, 0);

  const lateModeEvent = makeBridgeHarness();
  lateModeEvent.setEditBoundaryBusy(true);
  lateModeEvent.setVocabularyEnabled(true);
  lateModeEvent.setEditorMode(9);
  assert.equal(lateModeEvent.hasPendingReadMode(), true,
    "a PDF.js mode event during initial layer setup is not treated as a user's tool choice");
  lateModeEvent.setEditBoundaryBusy(false);
  assert.equal(lateModeEvent.notifyInputBoundary(), true);
  assert.deepEqual(Array.from(lateModeEvent.events, ({ event }) => event.mode), [0]);

  const staleGeneration = makeBridgeHarness();
  staleGeneration.setEditBoundaryBusy(true);
  staleGeneration.setVocabularyEnabled(true);
  staleGeneration.setRendererGeneration("generation-b");
  staleGeneration.setEditBoundaryBusy(false);
  assert.equal(staleGeneration.notifyInputBoundary(), false);
  assert.equal(staleGeneration.events.length, 0);
});

test("enabled LingQ takes priority over the saved annotation tool on open without erasing it", () => {
  const api = makeBridgeHarness();
  api.state.vocabularyEnabled = true;
  assert.equal(api.restorePreferredAnnotationTool("doc-a", 11), false);
  assert.equal(api.events.length, 0);
  assert.equal(api.state.preferredAnnotationToolMode, 15);
  api.state.vocabularyEnabled = false;
  assert.equal(api.restorePreferredAnnotationTool("doc-a", 11), true);
  assert.deepEqual(Array.from(api.events, ({ event }) => event.mode), [15]);
});

test("a LingQ-enabled first open waits for annotation-layer readiness before entering READ", () => {
  const api = makeBridgeHarness();
  api.state.vocabularyEnabled = true;
  api.pdfViewer._layerProperties.annotationEditorUIManager = null;
  api.bindVocabularyToOpenedDocument("doc-a", 11);
  assert.equal(api.calls.some(({ type }) => type === "setDocument"), true);
  assert.equal(api.events.length, 0);
  assert.equal(api.hasPendingReadMode(), true);

  api.pdfViewer._layerProperties.annotationEditorUIManager = {};
  assert.equal(api.notifyInputBoundary(), true, "the matching layer-ready boundary releases the queued request");
  assert.deepEqual(Array.from(api.events, ({ event }) => event.mode), [0]);
  assert.equal(api.restorePreferredAnnotationTool("doc-a", 11), false);
});

test("iOS direct manipulation exposes active finger sessions and reports their end boundary", () => {
  const context = vm.createContext({ window: { PdfReaderInputRuntime: {} }, document: { visibilityState: "visible" } });
  vm.runInContext(iosControllerSource, context);
  const controller = vm.runInContext(`(() => {
    let boundaries = 0;
    const router = {
      manualPointerCount: 0,
      manualPointerValues: () => [],
      activePointerValues: () => [],
      penPolicyPointerIds: () => [],
      manualPointer: () => null,
      hasManualPointer: () => false,
      hasPointerCapture: () => false,
      setManualPointer() {}, deleteManualPointer() { return false; },
      clearManualPointers() {}, clearPenPolicyPointers() {},
      releasePointerCapture() {}, capturePointer() {},
    };
    const controller = new window.PdfReaderInputRuntime.IOSDirectManipulationController({
      getInputRouter: () => router,
      getViewportController: () => null,
      getInputPolicy: () => ({ rememberPanClickTarget() {}, refreshFingerTextSelectionSuppression() {} }),
      getViewerContainer: () => null,
      getCurrentSession: () => ({ documentId: "doc-a", openRequest: 1, pdfDocument: {}, rendererGeneration: "g" }),
      getEditorMode: () => 0,
      isEraserActive: () => false,
      isAnnotationToolActive: () => false,
      invalidatePendingPenHighlight() {},
      onInputBoundary() { boundaries += 1; },
    });
    return { controller, router, boundaries: () => boundaries };
  })()`, context);

  const touchDown = {
    pointerType: "touch", pointerId: 41, targetRole: "viewer", nativeContextTarget: false,
    pageIndex: 1, clientPoint: { x: 8, y: 12 },
  };
  assert.equal(controller.controller.routePointerDown(touchDown, { stopImmediatePropagation() {} }), true);
  assert.equal(controller.controller.hasActiveInputSession(), true);
  assert.equal(controller.controller.handlePointerEnd({
    type: "pointerup", pointerType: "touch", pointerId: 41,
    pageIndex: 1, clientPoint: { x: 8, y: 12 },
  }, { stopImmediatePropagation() {} }), true);
  assert.equal(controller.controller.hasActiveInputSession(), false);
  assert.equal(controller.boundaries(), 1);
});

test("a failing READ dispatch throws and clears the pending request instead of reporting success", () => {
  const context = vm.createContext({ window: { PdfReaderInputRuntime: {} } });
  vm.runInContext(annotationControllerSource, context);
  const controller = vm.runInContext(`new window.PdfReaderInputRuntime.AnnotationController({
    getEventBus: () => ({ dispatch() { throw new Error("mode switch failed"); } }),
  })`, context);
  assert.throws(() => controller.requestReadMode(), /mode switch failed/);
  assert.equal(controller.pendingReadModeRequest, null);
  assert.equal(controller.notifyInputBoundary(), false);
});
