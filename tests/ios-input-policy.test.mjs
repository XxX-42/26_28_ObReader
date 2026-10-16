import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const policySource = await readFile(
  new URL("../viewer-adapter/input/ios-input-policy.js", import.meta.url),
  "utf8",
);

function createPolicy({ annotationToolActive = false, penGestureActive = false } = {}) {
  const toggled = [];
  const documentRef = {
    documentElement: {
      classList: { toggle: (name, active) => toggled.push([name, active]) },
    },
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(policySource, { window: runtimeWindow });
  const policy = new runtimeWindow.PdfReaderInputRuntime.IOSInputPolicy({
    documentRef,
    isAnnotationToolActive: () => annotationToolActive,
    hasActivePenEditorGesture: () => penGestureActive,
  });
  return { policy, toggled };
}

function controls() {
  let prevented = false;
  let stopped = false;
  return {
    value: {
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    },
    get prevented() { return prevented; },
    get stopped() { return stopped; },
  };
}

test("iOS policy owns finger selection suppression until explicit handoff", () => {
  let annotationToolActive = false;
  const { policy, toggled } = createPolicy({ annotationToolActive });
  policy.isAnnotationToolActive = () => annotationToolActive;
  policy.setFingerTextSelectionSuppressionOwned(true);
  assert.deepEqual(toggled.at(-1), ["pdfReaderFingerTextSelectionSuppressed", false]);
  let eventControls = controls();
  assert.equal(policy.handleTextSelectionGuard({ targetRole: "text-layer" }, eventControls.value), false);
  assert.equal(eventControls.prevented, false);

  annotationToolActive = true;
  assert.equal(policy.refreshFingerTextSelectionSuppression(), true);
  assert.equal(policy.handleTextSelectionGuard({ targetRole: "viewer" }, eventControls.value), false);
  assert.equal(policy.handleTextSelectionGuard({ targetRole: "text-layer" }, eventControls.value), true);
  assert.equal(eventControls.prevented, true);
  policy.clearFingerTextSelectionSuppression();
  assert.deepEqual(toggled.at(-1), ["pdfReaderFingerTextSelectionSuppressed", false]);
});

test("pan click suppression preserves native activation and double-click targets", () => {
  const { policy } = createPolicy();
  const click = (pageIndex, overrides = {}, { doubleClick = false } = {}) => {
    const eventControls = controls();
    const intent = {
      detail: doubleClick ? 2 : 1,
      pointerType: "mouse",
      pageIndex,
      targetRole: "viewer",
      nativeContextTarget: false,
      nativeActivationTarget: false,
      ...overrides,
    };
    return {
      suppressed: policy.handlePanClick(intent, eventControls.value, { doubleClick }),
      ...eventControls,
    };
  };

  policy.rememberPanClickTarget("touch", 0);
  const samePage = click(0);
  assert.equal(samePage.suppressed, true);
  assert.equal(samePage.prevented, true);
  assert.equal(samePage.stopped, true);
  assert.equal(click(1).suppressed, false);
  assert.equal(click(0, { nativeContextTarget: true }).suppressed, false);
  assert.equal(click(0, { nativeActivationTarget: true }).suppressed, false,
    "native links and controls keep their synthesized activation click");
  assert.equal(click(0, { nativeActivationTarget: true }, { doubleClick: true }).suppressed, false,
    "native activation is also exempt from double-click suppression");
  assert.equal(click(1, { pointerType: "touch" }).suppressed, true);

  policy.clearPanClickTargets();
  assert.equal(click(0).suppressed, false);
  policy.rememberPanClickTarget("pen", 0);
  assert.equal(click(0, {}, { doubleClick: true }).suppressed, true);
  assert.equal(click(0, { detail: 1 }, { doubleClick: true }).suppressed, false,
    "a single click does not masquerade as a native double click");
});

test("iOS touch policy cancels only active Pencil editing and palm arbitration", () => {
  let annotationToolActive = false;
  let penGestureActive = false;
  const { policy, toggled } = createPolicy();
  policy.isAnnotationToolActive = () => annotationToolActive;
  policy.hasActivePenEditorGesture = () => penGestureActive;
  const intent = (overrides = {}) => ({
    type: "touchstart",
    targetRole: "viewer",
    nativeContextTarget: false,
    nativeOperation: null,
    touchHasStylus: false,
    ...overrides,
  });
  const dispatch = (method, value) => {
    const eventControls = controls();
    const preventedByPolicy = policy[method](value, eventControls.value);
    return { preventedByPolicy, ...eventControls };
  };

  const finger = dispatch("handleTouchStart", intent());
  assert.equal(finger.preventedByPolicy, false);
  assert.equal(finger.prevented, false, "finger scrolling stays native");
  const readPencil = dispatch("handleTouchStart", intent({ touchHasStylus: true }));
  assert.equal(readPencil.prevented, false, "read-mode Pencil stays native");

  annotationToolActive = true;
  const editingPencil = dispatch("handleTouchStart", intent({ touchHasStylus: true }));
  assert.equal(editingPencil.preventedByPolicy, true);
  assert.equal(editingPencil.prevented, true, "active-tool Pencil keeps editor ownership");

  annotationToolActive = false;
  penGestureActive = true;
  const palm = dispatch("handleTouchStart", intent());
  const palmMove = dispatch("handleTouchMove", intent({ type: "touchmove" }));
  assert.equal(palm.preventedByPolicy, true);
  assert.equal(palmMove.preventedByPolicy, true);
  assert.equal(palmMove.prevented, true);
  const nativeControl = dispatch("handleTouchMove", intent({ nativeContextTarget: true }));
  assert.equal(nativeControl.prevented, false,
    "native editing controls retain their own touch behavior");
  assert.equal(policy.refreshPenGestureTouchAction(), true);
  assert.deepEqual(toggled.at(-1), ["pdfReaderPenGestureActive", true]);
});
