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
    rememberPanClickTarget: (type, target) => policyCalls.push(["click-target", type, target]),
    clearPanClickTargets: () => policyCalls.push(["clear-click-targets"]),
  };
  const target = { page: "page-1", viewer: true };
  const windowRef = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(controllerSource, { window: windowRef, performance });
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
    getNativeOperation: () => null,
    isViewerSurfaceTarget: (candidate) => candidate?.viewer === true,
    isNativeContextTarget: () => false,
    directManipulationPage: (candidate) => candidate.page,
    invalidatePendingPenHighlight() {},
  });
  return { controller, router, container, session, state, panCalls, momentumCalls, policyCalls, target, manual };
}

function pointerEvent(type, pointerId, target, values = {}) {
  let prevented = false;
  let stopped = false;
  return {
    type,
    pointerId,
    pointerType: "touch",
    target,
    clientX: 40,
    clientY: 60,
    timeStamp: 100,
    buttons: type === "pointerup" ? 0 : 1,
    relatedTarget: null,
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
    get defaultPrevented() { return prevented; },
    get stoppedImmediately() { return stopped; },
    ...values,
  };
}

test("page touch remains native and never starts a bridge pan or pointer capture", () => {
  const harness = createHarness();
  const { controller, router, target, manual, panCalls, momentumCalls, policyCalls } = harness;
  harness.state.editorMode = 9;
  const down = pointerEvent("pointerdown", 11, target);
  controller.preparePointerDown(down);
  assert.equal(controller.routePointerDown(down), true);
  assert.equal(manual.size, 0);
  assert.equal(controller._nativeTouchPointers.size, 1);
  assert.equal(router.hasPointerCapture(11), false);
  assert.equal(down.defaultPrevented, false);
  assert.equal(down.stoppedImmediately, true);
  assert.ok(policyCalls.some(([name]) => name === "suppress"));

  const move = pointerEvent("pointermove", 11, target, { clientX: 35, clientY: 80, timeStamp: 120 });
  assert.equal(controller.handlePointerMove(move), true);
  assert.equal(move.defaultPrevented, false);
  assert.deepEqual(panCalls, []);

  const up = pointerEvent("pointerup", 11, target, { clientX: 30, clientY: 100, timeStamp: 140 });
  assert.equal(controller.handlePointerEnd(up), true);
  assert.equal(manual.size, 0);
  assert.equal(controller._nativeTouchPointers.size, 0);
  assert.equal(router.hasPointerCapture(11), false);
  assert.deepEqual(panCalls, []);
  assert.deepEqual(momentumCalls, []);
  assert.ok(policyCalls.some(([name]) => name === "clear-suppression"));
});

test("native multi-touch remains uncaptured and never enters custom inertia", () => {
  const harness = createHarness();
  const { controller, router, manual, panCalls, momentumCalls } = harness;
  const firstDown = pointerEvent("pointerdown", 1, harness.target);
  controller.preparePointerDown(firstDown);
  controller.routePointerDown(firstDown);
  const secondDown = pointerEvent("pointerdown", 2, harness.target);
  controller.preparePointerDown(secondDown);
  assert.equal(controller.routePointerDown(secondDown), true);
  assert.equal(controller._nativeTouchPointers.size, 2);
  assert.equal(manual.size, 0);
  assert.equal(router.hasPointerCapture(1), false);
  assert.equal(router.hasPointerCapture(2), false);
  controller.handlePointerMove(pointerEvent("pointermove", 1, harness.target, {
    clientX: 80,
    timeStamp: 120,
  }));
  assert.equal(panCalls.length, 0, "WebKit owns both contacts without bridge pan calls");
  controller.handlePointerEnd(pointerEvent("pointercancel", 2, harness.target, {
    timeStamp: 130,
  }));
  controller.handlePointerEnd(pointerEvent("pointercancel", 1, harness.target, {
    timeStamp: 131,
  }));
  assert.equal(controller._nativeTouchPointers.size, 0);
  assert.deepEqual(momentumCalls, []);
});

test("read-mode Pencil stays native while active-tool Pencil retains editor ownership", () => {
  const modeNone = createHarness();
  const penDown = pointerEvent("pointerdown", 21, modeNone.target, {
    pointerType: "pen",
  });
  modeNone.controller.preparePointerDown(penDown);
  assert.equal(modeNone.controller.routePointerDown(penDown), true);
  assert.equal(penDown.defaultPrevented, false);
  assert.equal(modeNone.router.penPolicyPointerCount, 0);
  assert.equal(modeNone.manual.size, 0);
  assert.equal(modeNone.controller.handlePointerMove(pointerEvent(
    "pointermove",
    21,
    modeNone.target,
    { pointerType: "pen", clientY: 25, timeStamp: 120 },
  )), false);
  assert.equal(modeNone.panCalls.length, 0);

  const activeTool = createHarness();
  activeTool.state.editorMode = 9;
  const fingerDown = pointerEvent("pointerdown", 31, activeTool.target);
  activeTool.controller.preparePointerDown(fingerDown);
  activeTool.controller.routePointerDown(fingerDown);
  const activePenDown = pointerEvent("pointerdown", 32, activeTool.target, {
    pointerType: "pen",
  });
  activeTool.controller.preparePointerDown(activePenDown);
  assert.equal(activeTool.controller.routePointerDown(activePenDown), false,
    "active annotation mode leaves the Pencil editor gesture to PDF.js");
  assert.equal(activeTool.router.penPolicyPointerCount, 1);
  assert.equal(activeTool.manual.size, 0);
  assert.equal(activeTool.controller._nativeTouchPointers.size, 1,
    "a finger contact remains a native scroll gesture during pen arbitration");
  assert.ok(activeTool.policyCalls.some(([name]) => name === "clear-suppression"));
});
