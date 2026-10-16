import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../viewer-adapter/input/annotation-controller.js", import.meta.url),
  "utf8",
);
const modeSource = await readFile(
  new URL("../viewer-adapter/input/interaction-mode.js", import.meta.url),
  "utf8",
);

function createController(options = {}) {
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(modeSource, { window: runtimeWindow });
  vm.runInNewContext(source, { window: runtimeWindow });
  return new runtimeWindow.PdfReaderInputRuntime.AnnotationController(options);
}

test("annotation pointer classification preserves editor, text, wheel, and eraser intents", () => {
  const controller = createController();
  const editorTarget = { closest: (selector) => selector === ".annotationEditorLayer" };
  const viewerTarget = { closest: () => null };
  const common = {
    isTextLayerTarget: () => true,
    isNativeContextTarget: () => false,
    isViewerSurfaceTarget: () => true,
  };

  assert.equal(controller.pointerInteractionKind({ button: 0 }, editorTarget, common), "editor");
  assert.equal(controller.pointerInteractionKind({ button: 0 }, viewerTarget, {
    ...common,
    interactionMode: "HIGHLIGHT",
  }), "text-selection");
  assert.equal(controller.pointerInteractionKind({ button: 0 }, viewerTarget, {
    ...common,
    interactionMode: "INK",
  }), null);
  assert.equal(controller.pointerInteractionKind({ pointerType: "mouse", button: 1 }, viewerTarget, common), "tool-wheel");
  assert.equal(controller.pointerInteractionKind({ pointerType: "mouse", button: 2 }, viewerTarget, common), "right-eraser");
  assert.equal(controller.pointerInteractionKind({ pointerType: "touch", button: 2 }, viewerTarget, common), null);
  assert.equal(controller.pointerInteractionKind({ pointerType: "mouse", button: 2 }, viewerTarget, {
    ...common,
    isNativeContextTarget: () => true,
  }), null);
});

test("native annotation operation detection only recognizes selected editor move and resize handles", () => {
  const controller = createController();
  const target = (selector) => ({ closest: (candidate) => candidate === selector });

  assert.equal(controller.nativeOperation({ button: 0, pointerType: "pen" }, target(".resizer")), "resize");
  assert.equal(controller.nativeOperation({ button: 0, pointerType: "mouse" }, target(".draggable.selectedEditor")), "move");
  assert.equal(controller.nativeOperation({ button: 0, pointerType: "touch" }, target(".resizer")), null);
  assert.equal(controller.nativeOperation({ button: 2, pointerType: "pen" }, target(".resizer")), null);
});

test("Pencil highlight fallback commits only the exact live editor and selection session", () => {
  const textLayer = { id: "text" };
  const page = {
    dataset: { pageNumber: "3" },
    contains: (node) => node === editorLayer.div,
  };
  const editorLayer = {
    div: { isConnected: true },
    hasTextLayer: (candidate) => candidate === textLayer,
  };
  const builder = { annotationEditorLayer: editorLayer, div: editorLayer.div };
  const manager = {
    currentLayer: {},
    getMode: () => 9,
    getLayer: (index) => index === 2 ? editorLayer : null,
    highlightSelection: (source) => highlights.push(source),
  };
  const highlights = [];
  let pending = null;
  const controller = createController({
    getManager: () => manager,
    getPdfViewer: () => ({ getPageView: (index) => index === 2 ? { annotationEditorLayer: builder } : null }),
    getEditorMode: () => 9,
    getPdfViewerMode: () => 9,
    isPointerSessionCurrent: () => true,
    isTextSelectionValid: () => true,
    hasOtherActivePenPointer: () => false,
    isClosingOrDisposed: () => false,
    isPendingHighlight: (pointer) => pending === pointer,
    clearPendingHighlight: () => { pending = null; },
  });
  const pointer = {
    pointerId: 1,
    pointerType: "pen",
    button: 0,
    mode: 9,
    kind: "text-selection",
    page,
    textLayer,
    ending: true,
    moved: true,
    penTextSelectionOwnershipLost: false,
  };

  assert.equal(controller.preparePenHighlight(pointer, { textLayer, page }), true);
  pending = pointer;
  assert.equal(controller.finishPenHighlight(pointer), true);
  assert.deepEqual(highlights, ["main_toolbar"]);
  assert.equal(pending, null);
  assert.equal(controller.finishPenHighlight(pointer), false);
});

test("stale Pencil highlight references and selection ownership loss fail closed", () => {
  let current = true;
  let pending;
  let highlightCount = 0;
  const textLayer = {};
  const page = { dataset: { pageNumber: "1" }, contains: () => true };
  const editorLayer = { div: { isConnected: true }, hasTextLayer: () => true };
  const builder = { annotationEditorLayer: editorLayer, div: editorLayer.div };
  const manager = {
    currentLayer: {},
    getMode: () => 9,
    getLayer: () => editorLayer,
    highlightSelection: () => { highlightCount += 1; },
  };
  const controller = createController({
    getManager: () => manager,
    getPdfViewer: () => ({ getPageView: () => ({ annotationEditorLayer: builder }) }),
    getEditorMode: () => 9,
    getPdfViewerMode: () => 9,
    isPointerSessionCurrent: () => current,
    isTextSelectionValid: () => true,
    hasOtherActivePenPointer: () => false,
    isPendingHighlight: (pointer) => pending === pointer,
    clearPendingHighlight: () => { pending = null; },
  });
  const pointer = {
    pointerId: 2,
    pointerType: "pen",
    button: 0,
    mode: 9,
    kind: "text-selection",
    page,
    textLayer,
    ending: true,
    moved: true,
    penTextSelectionOwnershipLost: false,
  };

  assert.equal(controller.preparePenHighlight(pointer, { textLayer, page }), true);
  pending = pointer;
  pointer.penTextSelectionOwnershipLost = true;
  assert.equal(controller.finishPenHighlight(pointer), false);
  assert.equal(highlightCount, 0);

  pointer.penTextSelectionOwnershipLost = false;
  assert.equal(controller.preparePenHighlight(pointer, { textLayer, page }), true);
  pending = pointer;
  current = false;
  assert.equal(controller.finishPenHighlight(pointer), false);
  assert.equal(highlightCount, 0);
});

test("pointer cancellation delegates cleanup to the matching PDF.js owner", () => {
  const actions = [];
  const controller = createController({
    isPointerSessionCurrent: () => true,
    getEraser: () => ({ cancelTemporaryStroke: () => actions.push("erase-cancel") }),
    getManager: () => ({ currentLayer: { endDrawingSession: (aborted) => actions.push(`draw-${aborted}`) } }),
    clearToolWheel: (pointerId) => actions.push(`wheel-${pointerId}`),
    onTransformCancel: (pointer) => actions.push(`transform-${pointer.pointerId}`),
  });

  assert.equal(controller.cancelPointerSession({ pointerId: 3, button: 1 }), true);
  assert.equal(controller.cancelPointerSession({ pointerId: 4, button: 2 }), true);
  assert.equal(controller.cancelPointerSession({ pointerId: 5, button: 0, mode: 15 }), true);
  assert.equal(controller.cancelPointerSession({
    pointerId: 6,
    button: 0,
    mode: 0,
    pointerType: "pen",
    nativeOperation: "move",
  }), true);
  assert.equal(controller.cancelPointerSession({ pointerId: 7, button: 0, pointerType: "mouse" }), true);
  assert.deepEqual(actions, ["wheel-3", "erase-cancel", "draw-true", "transform-6"]);
});
