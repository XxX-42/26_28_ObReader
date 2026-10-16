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
  const target = { targetRole: "text-layer", pageIndex: 3 };
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
    invalidatePendingPenHighlight() {},
  });
  return { controller, router, container, session, state, panCalls, momentumCalls, policyCalls, target, manual };
}

function pointerEvent(type, pointerId, target, values = {}) {
  let prevented = false;
  let stopped = false;
  const nativeShape = {
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
  return {
    intent: Object.freeze({
      type,
      pointerId,
      pointerType: nativeShape.pointerType,
      button: 0,
      buttons: nativeShape.buttons,
      detail: 1,
      clientPoint: Object.freeze({ x: nativeShape.clientX, y: nativeShape.clientY }),
      pageIndex: target.pageIndex ?? null,
      targetRole: target.targetRole || "viewer",
      nativeContextTarget: target.nativeContextTarget === true,
      timestamp: nativeShape.timeStamp,
      relatedTargetPresent: nativeShape.relatedTarget !== null,
      modifiers: Object.freeze({ alt: false, control: false, meta: false, shift: false }),
    }),
    controls: Object.freeze({
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    }),
    get defaultPrevented() { return prevented; },
    get stoppedImmediately() { return stopped; },
  };
}

test("iPad touch pan captures, pans, consumes the release endpoint, and starts momentum", () => {
  const harness = createHarness();
  const { controller, router, target, manual, panCalls, momentumCalls, policyCalls } = harness;
  harness.state.editorMode = 9;
  const down = pointerEvent("pointerdown", 11, target);
  controller.preparePointerDown(down.intent);
  assert.equal(controller.routePointerDown(down.intent, down.controls), true);
  assert.equal(manual.size, 1);
  assert.equal(router.hasPointerCapture(11), true);
  assert.equal(down.defaultPrevented, true);
  assert.equal(down.stoppedImmediately, true);
  assert.ok(policyCalls.some(([name]) => name === "suppress"));

  const move = pointerEvent("pointermove", 11, target, { clientX: 35, clientY: 80, timeStamp: 120 });
  assert.equal(controller.handlePointerMove(move.intent, move.controls), true);
  assert.equal(move.defaultPrevented, true);
  assert.deepEqual(panCalls, [{ id: 11, x: 35, y: 80 }]);

  const up = pointerEvent("pointerup", 11, target, { clientX: 30, clientY: 100, timeStamp: 140 });
  assert.equal(controller.handlePointerEnd(up.intent, up.controls), true);
  assert.equal(manual.size, 0);
  assert.equal(router.hasPointerCapture(11), false);
  assert.deepEqual(panCalls.at(-1), { id: 11, x: 30, y: 100 });
  assert.deepEqual(momentumCalls.at(-1), { id: 11, time: 140 });
});

test("iPad second contact and cancellation block pans and cancel momentum", () => {
  const harness = createHarness();
  const { controller, manual, panCalls, momentumCalls } = harness;
  const firstDown = pointerEvent("pointerdown", 1, harness.target);
  controller.preparePointerDown(firstDown.intent);
  controller.routePointerDown(firstDown.intent, firstDown.controls);
  const secondDown = pointerEvent("pointerdown", 2, harness.target);
  controller.preparePointerDown(secondDown.intent);
  assert.equal(manual.get(1).blockedByOtherPointer, true);
  assert.equal(controller.routePointerDown(secondDown.intent, secondDown.controls), true);
  const firstMove = pointerEvent("pointermove", 1, harness.target, {
    clientX: 80,
    timeStamp: 120,
  });
  controller.handlePointerMove(firstMove.intent, firstMove.controls);
  assert.equal(panCalls.length, 0, "neither contact can pan after multi-touch ownership is canceled");
  const cancel = pointerEvent("pointercancel", 2, harness.target, {
    timeStamp: 130,
  });
  controller.handlePointerEnd(cancel.intent, cancel.controls);
  assert.ok(momentumCalls.some((entry) => entry.cancel === true));
});

test("mode-NONE Pencil pans while active-tool Pencil ownership suspends finger pan", () => {
  const modeNone = createHarness();
  const penDown = pointerEvent("pointerdown", 21, modeNone.target, {
    pointerType: "pen",
  });
  modeNone.controller.preparePointerDown(penDown.intent);
  assert.equal(modeNone.controller.routePointerDown(penDown.intent, penDown.controls), true);
  assert.equal(penDown.defaultPrevented, true);
  const penMove = pointerEvent(
    "pointermove",
    21,
    modeNone.target,
    { pointerType: "pen", clientY: 25, timeStamp: 120 },
  );
  assert.equal(modeNone.controller.handlePointerMove(penMove.intent, penMove.controls), true);
  assert.equal(modeNone.panCalls.length, 1);

  const activeTool = createHarness();
  activeTool.state.editorMode = 9;
  const fingerDown = pointerEvent("pointerdown", 31, activeTool.target);
  activeTool.controller.preparePointerDown(fingerDown.intent);
  activeTool.controller.routePointerDown(fingerDown.intent, fingerDown.controls);
  const activePenDown = pointerEvent("pointerdown", 32, activeTool.target, {
    pointerType: "pen",
  });
  activeTool.controller.preparePointerDown(activePenDown.intent);
  assert.equal(activeTool.controller.routePointerDown(activePenDown.intent, activePenDown.controls, {
    nativeOperationActive: false,
  }), false,
    "active annotation mode leaves the Pencil editor gesture to PDF.js");
  assert.equal(activeTool.router.penPolicyPointerCount, 1);
  assert.equal(activeTool.manual.get(31).blockedByPen, true);
  assert.equal(activeTool.manual.get(31).moved, false);
  assert.ok(activeTool.policyCalls.some(([name]) => name === "clear-suppression"));
});

test("iPad direct manipulation leaves FreeText and native controls to their owner", () => {
  const harness = createHarness();
  const target = { ...harness.target, nativeContextTarget: true };
  const down = pointerEvent("pointerdown", 41, target);
  harness.controller.preparePointerDown(down.intent);
  assert.equal(harness.controller.routePointerDown(down.intent, down.controls), false);
  assert.equal(harness.manual.size, 0);
  assert.equal(harness.router.hasPointerCapture(41), false);
});
