import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const policySource = await readFile(
  new URL("../viewer-adapter/input/ios-input-policy.js", import.meta.url),
  "utf8",
);

test("iOS policy owns finger selection suppression until explicit handoff", () => {
  let annotationToolActive = false;
  let suppressed = false;
  const documentRef = {
    documentElement: {
      classList: {
        toggle(_name, enabled) { suppressed = enabled; },
      },
    },
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(policySource, { window: runtimeWindow });
  const policy = new runtimeWindow.PdfReaderInputRuntime.IOSInputPolicy({
    documentRef,
    isAnnotationToolActive: () => annotationToolActive,
    isTextLayerTarget: (target) => target?.role === "text-layer",
  });

  policy.setFingerTextSelectionSuppressionOwned(true);
  assert.equal(suppressed, false, "read mode does not suppress text selection");
  let prevented = false;
  assert.equal(policy.handleTextSelectionGuard({
    target: { role: "text-layer" },
    preventDefault() { prevented = true; },
  }), false);
  assert.equal(prevented, false);

  annotationToolActive = true;
  assert.equal(policy.refreshFingerTextSelectionSuppression(), true);
  assert.equal(suppressed, true);
  assert.equal(policy.handleTextSelectionGuard({
    target: { role: "toolbar" },
    preventDefault() { prevented = true; },
  }), false, "toolbar interaction stays available");
  assert.equal(policy.handleTextSelectionGuard({
    target: { role: "text-layer" },
    preventDefault() { prevented = true; },
  }), true);
  assert.equal(prevented, true);

  policy.clearFingerTextSelectionSuppression();
  assert.equal(suppressed, false);
});

test("iOS policy suppresses only the compatibility click after a pan", () => {
  const pageOne = {};
  const pageTwo = {};
  const policyWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(policySource, { window: policyWindow });
  const policy = new policyWindow.PdfReaderInputRuntime.IOSInputPolicy({
    documentRef: {},
    isElementTarget: (target) => target?.element === true,
    isViewerSurfaceTarget: (target) => target?.viewer === true,
    isNativeContextTarget: (target) => target?.native === true,
    isNativeActivationTarget: (target) => target?.activation === true,
    directManipulationPage: (target) => target.page || target,
  });
  const target = (page, overrides = {}) => ({
    element: true,
    viewer: true,
    page,
    ...overrides,
  });
  const click = (eventTarget, detail = 1, pointerType = "mouse") => {
    let prevented = false;
    let stopped = false;
    const event = {
      target: eventTarget,
      detail,
      pointerType,
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    };
    return { event, wasSuppressed: policy.handlePanClick(event), prevented, stopped };
  };

  policy.rememberPanClickTarget("touch", pageOne);
  const samePageCompatibilityClick = click(target(pageOne));
  assert.equal(samePageCompatibilityClick.wasSuppressed, true);
  assert.equal(samePageCompatibilityClick.prevented, true);
  assert.equal(samePageCompatibilityClick.stopped, true);
  assert.equal(click(target(pageTwo)).wasSuppressed, false);
  assert.equal(click(target(pageOne, { native: true })).wasSuppressed, false);
  assert.equal(click(target(pageOne, { activation: true })).wasSuppressed, false,
    "native links and controls retain their activation click");
  assert.equal(click(target(pageTwo), 1, "touch").wasSuppressed, true);

  policy.clearPanClickTargets();
  assert.equal(click(target(pageOne)).wasSuppressed, false);
  policy.rememberPanClickTarget("pen", pageOne);
  const doubleClick = click(target(pageOne), 2);
  assert.equal(policy.handlePanClick(doubleClick.event, { doubleClick: true }), true);
  assert.equal(policy.handlePanClick({
    ...doubleClick.event,
    detail: 1,
  }, { doubleClick: true }), false);
});

test("iOS Pencil guard handles indexed non-iterable TouchLists and leaves native contacts alone", () => {
  let annotationToolActive = false;
  let penGestureActive = false;
  const toggled = [];
  const documentRef = {
    documentElement: {
      classList: { toggle: (name, enabled) => toggled.push([name, enabled]) },
    },
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(policySource, { window: runtimeWindow });
  const policy = new runtimeWindow.PdfReaderInputRuntime.IOSInputPolicy({
    documentRef,
    isAnnotationToolActive: () => annotationToolActive,
    isElementTarget: (target) => target?.element === true,
    isViewerSurfaceTarget: (target) => target?.viewer === true,
    isNativeContextTarget: (target) => target?.native === true,
    isPenEditableTarget: (target) => target?.penEditable === true,
    hasActivePenEditorGesture: () => penGestureActive,
  });
  const stylus = { touchType: "stylus" };
  const indexedTouchList = {
    0: stylus,
    length: 1,
    item(index) { return this[index] || null; },
  };
  assert.equal(indexedTouchList[Symbol.iterator], undefined,
    "the fixture represents WebKit's non-iterable TouchList IDL shape");
  const target = { element: true, viewer: true };
  const touch = (list, touchTarget = target) => {
    let prevented = false;
    return {
      event: {
        target: touchTarget,
        touches: list,
        changedTouches: list,
        preventDefault() { prevented = true; },
        get defaultPrevented() { return prevented; },
      },
    };
  };

  assert.equal(policy.touchEventContainsStylus(touch(indexedTouchList).event), true);
  assert.equal(policy.handleTouchStart(touch(indexedTouchList).event), false,
    "read-mode Pencil is not canceled");
  const fingerList = { 0: { touchType: "direct" }, length: 1, item(index) { return this[index]; } };
  const ordinaryFinger = touch(fingerList).event;
  assert.equal(policy.handleTouchStart(ordinaryFinger), false);
  assert.equal(ordinaryFinger.defaultPrevented, false,
    "ordinary finger contact retains native scrolling");

  annotationToolActive = true;
  const editingStylus = touch(indexedTouchList).event;
  assert.equal(policy.handleTouchStart(editingStylus), true,
    "active-tool Pencil keeps the legacy editing guard");
  assert.equal(editingStylus.defaultPrevented, true);

  annotationToolActive = false;
  penGestureActive = true;
  const palmContact = touch(fingerList).event;
  assert.equal(policy.handleTouchStart(palmContact), true,
    "a finger arriving during active Pencil input is arbitrated");
  const palmMove = touch(fingerList).event;
  assert.equal(policy.handleTouchMove(palmMove), true);
  assert.equal(palmMove.defaultPrevented, true);
  const focusedControl = touch(fingerList, { element: true, viewer: true, native: true }).event;
  assert.equal(policy.handleTouchMove(focusedControl), false,
    "native editing controls keep their own touch behavior");
  assert.equal(policy.refreshPenGestureTouchAction(), true);
  assert.deepEqual(toggled.at(-1), ["pdfReaderPenGestureActive", true]);
});
