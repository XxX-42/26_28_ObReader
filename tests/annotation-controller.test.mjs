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

test("embedded deletion scanning copies supported native annotations from every page", async () => {
  const controller = createController();
  const calls = [];
  const pages = [
    [
      {
        id: "10R0", annotationType: 15, rect: [1, 2, 30, 40], rotation: 0,
        color: new Uint8ClampedArray([12, 34, 56]), opacity: 0.5,
        borderStyle: { rawWidth: 2 },
        inkLists: [new Float32Array([1, 2, 3, 4])],
      },
      {
        id: "11R0", annotationType: 9, rect: [0, 0, 20, 20], rotation: 90,
        color: new Uint8ClampedArray([255, 240, 0]), opacity: 0.7,
        quadPoints: new Float32Array([0, 20, 20, 20, 0, 0, 20, 0]),
      },
      {
        id: "12R0", annotationType: 9, rect: [0, 0, 20, 20], rotation: 0,
        color: new Uint8ClampedArray([255, 240, 0]), opacity: 1,
        borderStyle: { rawWidth: 1 },
        inkLists: [new Float32Array([2, 3, 4, 5])],
      },
      {
        id: "13R0", annotationType: 5, rect: [5, 6, 15, 16], rotation: 0,
        color: null, opacity: 1, borderStyle: { rawWidth: 0.25 },
      },
      {
        id: "14R0", annotationType: 10, rect: [0, 0, 20, 20], rotation: 0,
        color: new Uint8ClampedArray([0, 128, 255]), opacity: 0.8,
        borderStyle: { rawWidth: 0.5 },
        quadPoints: new Float32Array([0, 20, 20, 20, 0, 0, 20, 0]),
      },
      {
        id: "15R0", annotationType: 3, rect: [1, 2, 30, 40], rotation: 0,
        color: null,
        defaultAppearanceData: {
          fontColor: new Uint8ClampedArray([5, 6, 7]), fontSize: 11,
        },
        textContent: ["Principles annotation"], textPosition: [4, 5],
      },
      {
        id: "19R0", annotationType: 15, it: "InkHighlight",
        rect: [1, 2, 30, 40], rotation: 0,
        color: new Uint8ClampedArray([255, 240, 0]), opacity: 0,
        borderStyle: { rawWidth: 1.5 },
        inkLists: [new Float32Array([6, 7, 8, 9])],
      },
      {
        id: "16R0", annotationType: 3, rect: [1, 2, 30, 40], rotation: 0,
        defaultAppearanceData: {
          fontColor: new Uint8ClampedArray([5, 6, 7]), fontSize: 11,
        },
      },
      { id: "17R0", annotationType: 2, rect: [0, 0, 20, 20], rotation: 0 },
      {
        id: "18R0", annotationType: 15, rect: [0, 0, 20, 20], rotation: 0,
        color: new Uint8ClampedArray([1, 2, 3]), opacity: 1,
        borderStyle: { rawWidth: 1 }, inkLists: [[1, 2, NaN, 4]],
      },
    ],
    [
      {
        id: "20R0", annotationType: 5, rect: [1, 1, 8, 8],
        color: new Uint8ClampedArray([10, 20, 30]), opacity: 0,
        borderStyle: { rawWidth: 0 },
      },
      {
        id: "21 0 R", annotationType: 5, rect: [1, 1, 8, 8],
        color: new Uint8ClampedArray([10, 20, 30]),
      },
      {
        id: "not-a-pdf-ref", annotationType: 5, rect: [1, 1, 8, 8],
        color: new Uint8ClampedArray([10, 20, 30]),
      },
      {
        id: "22R0", annotationType: 15, rect: [1, 1, 8, 8], rotation: 0,
        color: new Uint8ClampedArray([10, 20, 30]), opacity: 1,
        borderStyle: { rawWidth: 1 }, inkLists: [new Float32Array([100, 200])],
      },
      {
        id: "23R0", annotationType: 15, it: "InkHighlight",
        rect: [1, 1, 8, 8], rotation: 0,
        color: new Uint8ClampedArray([255, 220, 0]), opacity: 1,
        borderStyle: { rawWidth: 1 },
        inkLists: [new Float32Array([2, 3]), new Float32Array([4, 5, 6, 7, 8, 9])],
      },
    ],
  ];
  const pdfDocument = {
    numPages: pages.length,
    async getPage(pageNumber) {
      calls.push(`page:${pageNumber}`);
      return {
        async getAnnotations(options) {
          calls.push(`annotations:${pageNumber}:${options.intent}`);
          return pages[pageNumber - 1];
        },
      };
    },
  };

  const targets = await controller.scanEmbeddedDeletionTargets(pdfDocument, "doc-7", {
    resolveUuid: (ref, page) => ref === "10R" && page === 0 ? "existing-uuid" : null,
  });
  pages[0][0].inkLists[0][0] = 999;
  pages[0][0].color[0] = 99;

  assert.deepEqual(calls, [
    "page:1", "annotations:1:any", "page:2", "annotations:2:any",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets.map((target) => [
    target.kind, target.pageIndex, target.ref, target.uuid,
  ]))), [
    ["Ink", 0, "10R", "existing-uuid"],
    ["Highlight", 0, "11R", "embedded-v1:doc-7:0:11R"],
    ["InkHighlight", 0, "12R", "embedded-v1:doc-7:0:12R"],
    ["Square", 0, "13R", "embedded-v1:doc-7:0:13R"],
    ["Underline", 0, "14R", "embedded-v1:doc-7:0:14R"],
    ["FreeText", 0, "15R", "embedded-v1:doc-7:0:15R"],
    ["InkHighlight", 0, "19R", "embedded-v1:doc-7:0:19R"],
    ["Square", 1, "20R", "embedded-v1:doc-7:1:20R"],
    ["Square", 1, "21R", "embedded-v1:doc-7:1:21R"],
    ["Ink", 1, "22R", "embedded-v1:doc-7:1:22R"],
    ["InkHighlight", 1, "23R", "embedded-v1:doc-7:1:23R"],
  ]);
  const inkPayload = JSON.parse(JSON.stringify(targets[0].editorPayload));
  assert.deepEqual(inkPayload, {
    annotationType: 15,
    pageIndex: 0,
    rect: [1, 2, 30, 40],
    rotation: 0,
    color: [12, 34, 56],
    annotationElementId: "10R",
    id: "10R",
    deleted: false,
    opacity: 0.5,
    thickness: 2,
    paths: { points: [[1, 2, 3, 4]] },
    boxes: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(targets[1].editorPayload)).quadPoints, [
    0, 20, 20, 20, 0, 0, 20, 0,
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets[2].editorPayload)).inkLists, [[2, 3, 4, 5]]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets[3].editorPayload)).color, [0, 0, 0]);
  assert.equal(targets[4].editorPayload.thickness, 0.5);
  assert.deepEqual(JSON.parse(JSON.stringify(targets[5].editorPayload)), {
    annotationType: 3,
    pageIndex: 0,
    rect: [1, 2, 30, 40],
    rotation: 0,
    color: [5, 6, 7],
    annotationElementId: "15R",
    id: "15R",
    deleted: false,
    fontSize: 11,
    value: "Principles annotation",
    position: [4, 5],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(targets[6].editorPayload)), {
    annotationType: 9,
    pageIndex: 0,
    rect: [1, 2, 30, 40],
    rotation: 0,
    color: [255, 240, 0],
    annotationElementId: "19R",
    id: "19R",
    deleted: false,
    opacity: 1,
    thickness: 1.5,
    inkLists: [[6, 7, 8, 9]],
    boxes: null,
  });
  assert.equal(targets[7].editorPayload.rotation, 0);
  assert.equal(targets[7].editorPayload.opacity, 0);
  assert.equal(targets[7].editorPayload.thickness, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(targets[9].editorPayload.paths.points)), [[100, 200]]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets[10].editorPayload.inkLists)), [
    [2, 3], [4, 5, 6, 7, 8, 9],
  ]);
  assert.ok(targets.every((target) => target.source === "embedded"));
});

test("embedded deletion scan accepts one page and rejects malformed geometry without guessing", async () => {
  const controller = createController();
  const requestedPages = [];
  const pdfDocument = {
    numPages: 3,
    async getPage(pageNumber) {
      requestedPages.push(pageNumber);
      return {
        async getAnnotations() {
          return [{
            id: "30R0", annotationType: 15, rect: [1, 2, 3, 4], rotation: 0,
            color: [1, 2, 3], opacity: 1, borderStyle: { rawWidth: 1 },
            inkLists: [[1, 2, 3]],
          }, {
            id: "31R0", annotationType: 5, rect: [1, 2, 1, 4], rotation: 0,
            color: [1, 2, 3], opacity: 1, borderStyle: { rawWidth: 1 },
          }];
        },
      };
    },
  };

  const targets = await controller.scanEmbeddedDeletionTargets(pdfDocument, "doc", {
    pageIndex: 2,
  });
  assert.deepEqual(requestedPages, [3]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), []);
  await assert.rejects(
    controller.scanEmbeddedDeletionTargets(pdfDocument, "doc", { pageIndex: 3 }),
    (error) => error.name === "RangeError",
  );
});

test("embedded deletion scanning aborts after each awaited step when the PDF session changes", async () => {
  const controller = createController();
  const annotation = {
    id: "40R0", annotationType: 5, rect: [1, 2, 3, 4], rotation: 0,
    color: [1, 2, 3], opacity: 1, borderStyle: { rawWidth: 1 },
  };
  const staleError = (promise) => assert.rejects(promise, (error) =>
    error.name === "AbortError" && error.code === "ERR_ANNOTATION_SCAN_STALE_SESSION",
  );

  let current = true;
  let annotationReads = 0;
  const staleDuringPage = {
    numPages: 1,
    getPage() {
      return Promise.resolve().then(() => {
        current = false;
        return { getAnnotations: async () => { annotationReads += 1; return [annotation]; } };
      });
    },
  };
  await staleError(controller.scanEmbeddedDeletionTargets(staleDuringPage, "doc", {
    isCurrent: () => current,
  }));
  assert.equal(annotationReads, 0);

  current = true;
  const staleDuringAnnotations = {
    numPages: 1,
    async getPage() {
      return {
        getAnnotations() {
          return Promise.resolve().then(() => {
            current = false;
            return [annotation];
          });
        },
      };
    },
  };
  await staleError(controller.scanEmbeddedDeletionTargets(staleDuringAnnotations, "doc", {
    isCurrent: () => current,
  }));

  current = true;
  const stablePdf = {
    numPages: 1,
    async getPage() {
      return { getAnnotations: async () => [annotation] };
    },
  };
  await staleError(controller.scanEmbeddedDeletionTargets(stablePdf, "doc", {
    isCurrent: () => current,
    resolveUuid: () => Promise.resolve().then(() => {
      current = false;
      return "known";
    }),
  }));
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

test("embedded rendering mask composes with native changes and can be cleared without writes", () => {
  const controller = createController();
  const nativeIds = new Set(["12R"]);
  const storage = { get modifiedIds() { return { ids: nativeIds, hash: "12R" }; } };
  assert.equal(controller.setEmbeddedDeletionMask(storage, ["10R"]), true);
  assert.deepEqual([...storage.modifiedIds.ids].sort(), ["10R", "12R"]);
  assert.equal(controller.setEmbeddedDeletionMask(storage, ["10R"]), false);
  assert.deepEqual([...nativeIds], ["12R"]);
  assert.equal(controller.setEmbeddedDeletionMask(storage, []), true);
  assert.equal(storage.modifiedIds.ids, nativeIds);
});
