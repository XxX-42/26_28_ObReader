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
  const intent = (targetRole, values = {}) => ({
    targetRole,
    pointerType: "mouse",
    button: 0,
    ...values,
  });

  assert.equal(controller.pointerInteractionKind(intent("annotation-layer")), "editor");
  assert.equal(controller.pointerInteractionKind(intent("annotation-layer", {
    nativeContextTarget: true,
  })), "editor", "FreeText editing still belongs to PDF.js");
  assert.equal(controller.pointerInteractionKind(intent("text-layer"), {
    interactionMode: "HIGHLIGHT",
  }), "text-selection");
  assert.equal(controller.pointerInteractionKind(intent("text-layer"), {
    interactionMode: "INK",
  }), null);
  assert.equal(controller.pointerInteractionKind(intent("viewer", { button: 1 })), "tool-wheel");
  assert.equal(controller.pointerInteractionKind(intent("viewer", { button: 2 })), "right-eraser");
  assert.equal(controller.pointerInteractionKind(intent("viewer", { pointerType: "touch", button: 2 })), null);
  assert.equal(controller.pointerInteractionKind(intent("native-control", { button: 2 })), null);
  assert.equal(controller.pointerInteractionKind(intent("annotation-layer", {
    button: 2,
    nativeContextTarget: true,
  })), null, "context menus inside native text controls remain native");
});

test("native annotation operation detection only recognizes selected editor move and resize handles", () => {
  const controller = createController();
  assert.equal(controller.nativeOperation({ button: 0, pointerType: "pen", nativeOperation: "resize" }), "resize");
  assert.equal(controller.nativeOperation({ button: 0, pointerType: "mouse", nativeOperation: "move" }), "move");
  assert.equal(controller.nativeOperation({ button: 0, pointerType: "touch", nativeOperation: "resize" }), null);
  assert.equal(controller.nativeOperation({ button: 2, pointerType: "pen", nativeOperation: "resize" }), null);
  assert.equal(controller.nativeOperation({ button: 0, pointerType: "mouse", nativeOperation: "other" }), null);
});

test("bulk deletion submits one PDF.js undoable command for the exact target editors", async () => {
  const selected = new Set();
  let deleted = null;
  const commands = [];
  const sidecarEvents = [];
  const first = { id: "a", isEmpty: () => false };
  const second = { id: "b", isEmpty: () => false };
  const ignored = { id: "empty", isEmpty: () => true };
  const manager = {
    setSelected(editor) {
      selected.clear();
      selected.add(editor);
    },
    toggleSelected(editor) {
      if (selected.has(editor)) selected.delete(editor);
      else selected.add(editor);
    },
    delete() {
      const editors = [...selected];
      this.addCommands({
        cmd() { deleted = editors; },
        undo() { deleted = []; },
        mustExec: true,
      });
    },
    addCommands(command) {
      commands.push(command);
      if (command.mustExec) command.cmd();
    },
  };
  const controller = createController({ getManager: () => manager });

  assert.equal(await controller.deleteEditors([first, second, first, ignored, null], {
    onDelete: ({ redo }) => sidecarEvents.push(redo ? "redo-delete" : "delete"),
    onRestore: () => sidecarEvents.push("restore"),
  }), 2);
  assert.deepEqual(deleted, [first, second]);
  assert.equal(commands.length, 1, "all editors share one PDF.js history entry");
  assert.deepEqual(sidecarEvents, ["delete"]);
  commands[0].undo();
  assert.deepEqual(sidecarEvents, ["delete", "restore"]);
  commands[0].cmd();
  assert.deepEqual(sidecarEvents, ["delete", "restore", "redo-delete"]);
});

test("bulk deletion aborts after toolbar setup when its document session changes", async () => {
  let sessionCurrent = true;
  let resolveToolbar;
  let deleteCalls = 0;
  let selectionCalls = 0;
  const manager = {
    setSelected() { selectionCalls += 1; },
    toggleSelected() { selectionCalls += 1; },
    delete() { deleteCalls += 1; },
    addCommands() {},
  };
  const editor = {
    deleted: false,
    isEmpty: () => false,
    addEditToolbar() {
      return new Promise((resolve) => {
        resolveToolbar = () => {
          this._editToolbar = { div: { querySelector: () => ({}) } };
          resolve();
        };
      });
    },
  };
  const controller = createController({ getManager: () => manager });
  const deletion = controller.deleteEditors([editor], {
    isCurrent: () => sessionCurrent,
  });
  await Promise.resolve();
  sessionCurrent = false;
  resolveToolbar();

  assert.equal(await deletion, 0);
  assert.equal(selectionCalls, 0);
  assert.equal(deleteCalls, 0);
});

test("bulk history callbacks stop when their originating session is no longer current", async () => {
  let sessionCurrent = true;
  const sidecarEvents = [];
  let deleted = false;
  const commands = [];
  const manager = {
    setSelected() {},
    toggleSelected() {},
    delete() {
      const command = {
        cmd() { deleted = true; },
        undo() { deleted = false; },
        mustExec: true,
      };
      this.addCommands(command);
    },
    addCommands(command) {
      commands.push(command);
      if (command.mustExec) command.cmd();
    },
  };
  const editor = { deleted: false, isEmpty: () => false };
  const controller = createController({ getManager: () => manager });

  assert.equal(await controller.deleteEditors([editor], {
    isCurrent: () => sessionCurrent,
    onDelete: ({ redo }) => sidecarEvents.push(redo ? "redo-delete" : "delete"),
    onRestore: () => sidecarEvents.push("restore"),
  }), 1);
  assert.equal(deleted, true);
  assert.deepEqual(sidecarEvents, ["delete"]);

  sessionCurrent = false;
  commands[0].undo();
  commands[0].cmd();
  assert.equal(deleted, true, "stale history commands do not mutate the new session");
  assert.deepEqual(sidecarEvents, ["delete"], "stale history commands do not write sidecar operations");
});

test("bulk deletion safely falls back to PDF.js deleteEditor when group selection is unavailable", async () => {
  const removed = [];
  const manager = { deleteEditor: (editor) => removed.push(editor.id) };
  const controller = createController({ getManager: () => manager });

  assert.equal(await controller.deleteEditors([{ id: "one" }, { id: "two", deleted: true }]), 1);
  assert.deepEqual(removed, ["one"]);
  assert.equal(await createController().deleteEditors([{ id: "no-manager" }]), 0);
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
