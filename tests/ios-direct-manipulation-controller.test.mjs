import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const controllerSource = await readFile(
  new URL("../viewer-adapter/input/ios-direct-manipulation-controller.js", import.meta.url),
  "utf8",
);

function createHarness() {
  const manual = new Map();
  const active = new Map();
  const penPolicy = new Map();
  const captures = new Set();
  const panCalls = [];
  const momentumCalls = [];
  const policyCalls = [];
  const container = {
    scrollTop: 100,
    scrollLeft: 20,
    isConnected: true,
    setPointerCapture(id) { captures.add(id); },
    hasPointerCapture(id) { return captures.has(id); },
    releasePointerCapture(id) { captures.delete(id); },
  };
  const session = {
    documentId: "doc-1",
    openRequest: 4,
    pdfDocument: { id: "pdf-1" },
    rendererGeneration: 7,
  };
  const state = { editorMode: 0 };
  const documentRef = { visibilityState: "visible" };
  const router = {
    get manualPointerCount() { return manual.size; },
    get penPolicyPointerCount() { return penPolicy.size; },
    manualPointerValues: () => [...manual.values()],
    manualPointer: (id) => manual.get(id),
    hasManualPointer: (id) => manual.has(id),
    setManualPointer: (id, pointer) => manual.set(id, pointer),
    deleteManualPointer: (id) => manual.delete(id),
    clearManualPointers: () => manual.clear(),
    hasPointerCapture: (id) => captures.has(id),
    hasActivePointer: (id) => active.has(id),
    activePointerValues: () => [...active.values()],
    penPolicyPointerIds: () => [...penPolicy.keys()],
    setPenPolicyPointer: (id, pointer) => penPolicy.set(id, pointer),
    clearPenPolicyPointers: () => penPolicy.clear(),
    capturePointer: (id, target) => {
      target.setPointerCapture(id);
      return true;
    },
    releasePointerCapture: (id) => container.releasePointerCapture(id),
  };
  const viewport = {
    eventTime: (_pointer, event) => event.timeStamp,
    applyPan: (pointer, event) => {
      pointer.moved = true;
      panCalls.push({ id: pointer.pointerId, x: event.clientX, y: event.clientY });
    },
    startMomentum: (pointer, time) => momentumCalls.push({ id: pointer.pointerId, time }),
    cancelMomentum() { momentumCalls.push({ cancel: true }); },
  };
  const inputPolicy = {
    setFingerTextSelectionSuppressionOwned: (value) => policyCalls.push(["suppress", value]),
    refreshFingerTextSelectionSuppression: () => policyCalls.push(["refresh"]),
    clearFingerTextSelectionSuppression: () => policyCalls.push(["clear-suppression"]),
    clearReadPenSelectionSuppression: () => policyCalls.push(["clear-read-pen-suppression"]),
    rememberPanClickTarget: (type, target) => policyCalls.push(["click-target", type, target]),
    clearPanClickTargets: () => policyCalls.push(["clear-click-targets"]),
  };
  const target = { pageIndex: 0, targetRole: "viewer" };
  const windowRef = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(controllerSource, {
    window: windowRef,
    performance,
    document: documentRef,
  });
  const Controller = windowRef.PdfReaderInputRuntime.IOSDirectManipulationController;
  const controller = new Controller({
    getInputRouter: () => router,
    getViewportController: () => viewport,
    getInputPolicy: () => inputPolicy,
    getViewerContainer: () => container,
    getCurrentSession: () => session,
    getEditorMode: () => state.editorMode,
    isEraserActive: () => false,
    isAnnotationToolActive: () => state.editorMode !== 0,
    invalidatePendingPenHighlight() {},
  });
  return { controller, router, container, session, state, panCalls, momentumCalls, policyCalls, target, manual, documentRef };
}

function pointerEvent(type, pointerId, target, values = {}) {
  let prevented = false;
  let stopped = false;
  const pointerType = values.pointerType || "touch";
  const x = values.clientX ?? 40;
  const y = values.clientY ?? 60;
  const nativeShape = {
    type,
    pointerId,
    pointerType,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientPoint: { x, y },
    pageIndex: target.pageIndex ?? null,
    targetRole: target.targetRole || "viewer",
    nativeContextTarget: target.nativeContextTarget === true,
    nativeOperation: target.nativeOperation ?? null,
    timestamp: values.timeStamp ?? 100,
    relatedTargetPresent: values.relatedTarget != null,
  };
  return {
    intent: nativeShape,
    controls: {
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    },
    get defaultPrevented() { return prevented; },
    get stoppedImmediately() { return stopped; },
  };
}

test("page touch remains native and never starts a bridge pan or pointer capture", () => {
  const harness = createHarness();
  const { controller, router, target, manual, panCalls, momentumCalls, policyCalls } = harness;
  harness.state.editorMode = 9;
  const down = pointerEvent("pointerdown", 11, target);
  controller.preparePointerDown(down.intent);
  assert.equal(controller.routePointerDown(down.intent, down.controls), true);
  assert.equal(manual.size, 0);
  assert.equal(controller._nativeTouchPointers.size, 1);
  assert.equal(router.hasPointerCapture(11), false);
  assert.equal(down.defaultPrevented, false);
  assert.equal(down.stoppedImmediately, true);
  assert.ok(policyCalls.some(([name]) => name === "suppress"));

  const move = pointerEvent("pointermove", 11, target, { clientX: 35, clientY: 80, timeStamp: 120 });
  assert.equal(controller.handlePointerMove(move.intent, move.controls), true);
  assert.equal(move.defaultPrevented, false);
  assert.deepEqual(panCalls, []);

  const up = pointerEvent("pointerup", 11, target, { clientX: 30, clientY: 100, timeStamp: 140 });
  assert.equal(controller.handlePointerEnd(up.intent, up.controls), true);
  assert.equal(manual.size, 0);
  assert.equal(controller._nativeTouchPointers.size, 0);
  assert.equal(router.hasPointerCapture(11), false);
  assert.deepEqual(panCalls, []);
  assert.deepEqual(momentumCalls, []);
  assert.ok(!policyCalls.some(([name]) => name === "clear-suppression"),
    "pointerup must not release annotation-mode finger selection suppression");
});

test("native-scroll pointercancel keeps the finger guard until a real touchcancel", () => {
  const harness = createHarness();
  const { controller, policyCalls, target, state } = harness;
  state.editorMode = 9;
  const down = pointerEvent("pointerdown", 41, target);
  controller.preparePointerDown(down.intent);
  controller.routePointerDown(down.intent, down.controls);
  controller.handlePointerEnd(pointerEvent("pointercancel", 41, target).intent, {});
  assert.ok(!policyCalls.some(([name]) => name === "clear-suppression"),
    "WebKit pointercancel during native pan must preserve the tool guard");

  assert.equal(controller.handleTouchCancel({
    type: "touchcancel",
    activeTouchCount: 0,
  }), true);
  assert.ok(policyCalls.some(([name]) => name === "clear-suppression"),
    "an actual touchcancel with no remaining contacts releases the guard");
});

test("visibility loss and session teardown release the read-mode Pencil selection guard", () => {
  const harness = createHarness();
  const { controller, policyCalls, documentRef } = harness;
  documentRef.visibilityState = "hidden";
  controller.onDocumentVisibilityChange();
  assert.ok(policyCalls.some(([name]) => name === "clear-read-pen-suppression"));
  controller.clearSessions();
  assert.equal(policyCalls.filter(([name]) => name === "clear-read-pen-suppression").length, 2);
});

test("native multi-touch remains uncaptured and never enters custom inertia", () => {
  const harness = createHarness();
  const { controller, router, manual, panCalls, momentumCalls } = harness;
  const firstDown = pointerEvent("pointerdown", 1, harness.target);
  controller.preparePointerDown(firstDown.intent);
  controller.routePointerDown(firstDown.intent, firstDown.controls);
  const secondDown = pointerEvent("pointerdown", 2, harness.target);
  controller.preparePointerDown(secondDown.intent);
  assert.equal(controller.routePointerDown(secondDown.intent, secondDown.controls), true);
  assert.equal(controller._nativeTouchPointers.size, 2);
  assert.equal(manual.size, 0);
  assert.equal(router.hasPointerCapture(1), false);
  assert.equal(router.hasPointerCapture(2), false);
  controller.handlePointerMove(pointerEvent("pointermove", 1, harness.target, {
    clientX: 80,
    timeStamp: 120,
  }).intent, {
    stopImmediatePropagation() {},
  });
  assert.equal(panCalls.length, 0, "WebKit owns both contacts without bridge pan calls");
  controller.handlePointerEnd(pointerEvent("pointercancel", 2, harness.target, {
    timeStamp: 130,
  }).intent, { stopImmediatePropagation() {} });
  controller.handlePointerEnd(pointerEvent("pointercancel", 1, harness.target, {
    timeStamp: 131,
  }).intent, { stopImmediatePropagation() {} });
  assert.equal(controller._nativeTouchPointers.size, 0);
  assert.deepEqual(momentumCalls, []);
});

test("read-mode Pencil stays native while active-tool Pencil retains editor ownership", () => {
  const modeNone = createHarness();
  const penDown = pointerEvent("pointerdown", 21, modeNone.target, {
    pointerType: "pen",
  });
  modeNone.controller.preparePointerDown(penDown.intent);
  assert.equal(modeNone.controller.routePointerDown(penDown.intent, penDown.controls), true);
  assert.equal(penDown.defaultPrevented, false);
  assert.equal(modeNone.router.penPolicyPointerCount, 0);
  assert.equal(modeNone.manual.size, 0);
  assert.equal(modeNone.controller.handlePointerMove(pointerEvent(
    "pointermove",
    21,
    modeNone.target,
    { pointerType: "pen", clientY: 25, timeStamp: 120 },
  ).intent, {}), false);
  assert.equal(modeNone.panCalls.length, 0);

  const activeTool = createHarness();
  activeTool.state.editorMode = 9;
  const fingerDown = pointerEvent("pointerdown", 31, activeTool.target);
  activeTool.controller.preparePointerDown(fingerDown.intent);
  activeTool.controller.routePointerDown(fingerDown.intent, fingerDown.controls);
  const activePenDown = pointerEvent("pointerdown", 32, activeTool.target, {
    pointerType: "pen",
  });
  activeTool.controller.preparePointerDown(activePenDown.intent);
  assert.equal(activeTool.controller.routePointerDown(activePenDown.intent, activePenDown.controls), false,
    "active annotation mode leaves the Pencil editor gesture to PDF.js");
  assert.equal(activeTool.router.penPolicyPointerCount, 1);
  assert.equal(activeTool.manual.size, 0);
  assert.equal(activeTool.controller._nativeTouchPointers.size, 1,
    "a finger contact remains a native scroll gesture during pen arbitration");
  assert.ok(activeTool.policyCalls.some(([name]) => name === "clear-suppression"));
});
