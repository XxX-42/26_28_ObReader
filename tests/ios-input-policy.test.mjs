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
  const classes = new Set();
  const documentRef = {
    documentElement: {
      classList: {
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        toggle(name, active) {
          toggled.push([name, active]);
          if (active) classes.add(name);
          else classes.delete(name);
        },
      },
    },
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(policySource, { window: runtimeWindow });
  const policy = new runtimeWindow.PdfReaderInputRuntime.IOSInputPolicy({
    documentRef,
    isAnnotationToolActive: () => annotationToolActive,
    hasActivePenEditorGesture: () => penGestureActive,
  });
  return { policy, toggled, classes };
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

test("iOS read mode blocks PDF text long-press callouts without blocking selection", async () => {
  const { policy } = createPolicy({ annotationToolActive: false });
  const callout = controls();
  assert.equal(policy.handleTextSelectionGuard({
    type: "contextmenu",
    pointerType: "touch",
    targetRole: "text-layer",
  }, callout.value), true);
  assert.equal(callout.prevented, true);

  const selection = controls();
  assert.equal(policy.handleTextSelectionGuard({
    type: "selectstart",
    targetRole: "text-layer",
  }, selection.value), false);
  assert.equal(selection.prevented, false);

  const unrelatedMenu = controls();
  assert.equal(policy.handleTextSelectionGuard({
    type: "contextmenu",
    targetRole: "viewer",
  }, unrelatedMenu.value), false);
  assert.equal(unrelatedMenu.prevented, false);

  const css = await readFile(new URL("../viewer-adapter/bridge.css", import.meta.url), "utf8");
  assert.match(css, /:root\[data-pdf-reader-ios-input-policy="true"\]\s+#viewerContainer\s+\.textLayer[\s\S]*?-webkit-touch-callout:\s*none\s*!important;/);
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


test("every Pencil tool blocks native pan before pointer tracking, while finger and read mode stay native", async () => {
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(await readFile(new URL("../viewer-adapter/input/interaction-mode.js", import.meta.url), "utf8"), { window: runtimeWindow });
  const modes = runtimeWindow.PdfReaderInputRuntime.InteractionMode;
  const { policy } = createPolicy();
  let editorMode = 0;
  let eraserActive = false;
  policy.isAnnotationToolActive = () => modes.isToolActive(modes.resolve({ editorMode, eraserActive }));
  // WKWebView may deliver touchmove before pointer bookkeeping, or after
  // pointercancel. Tool ownership must not depend on that transient map.
  policy.hasActivePenEditorGesture = () => false;
  const cases = [
    [3, false, null, "FreeText"], [5, false, null, "Square"],
    [9, false, null, "Highlight"], [10, false, null, "Underline"],
    [15, false, null, "Ink"], [17, false, null, "Eraser"],
    [0, true, null, "temporary eraser"],
    [0, false, "move", "object move"], [0, false, "resize", "object resize"],
  ];
  for (const [mode, erase, nativeOperation, label] of cases) {
    editorMode = mode;
    eraserActive = erase;
    for (const method of ["handleTouchStart", "handleTouchMove"]) {
      const intent = { targetRole: "annotation-layer", nativeContextTarget: false, touchHasStylus: true, nativeOperation };
      const pen = controls();
      assert.equal(policy[method](intent, pen.value), true, `${label}: ${method}`);
      assert.equal(pen.prevented, true, `${label}: Pencil must not scroll`);
      assert.equal(pen.stopped, false, "PDF.js still receives the edit gesture");
      const finger = controls();
      assert.equal(policy[method]({ ...intent, touchHasStylus: false }, finger.value), false);
      assert.equal(finger.prevented, false, `${label}: finger keeps native pan`);
      const control = controls();
      assert.equal(policy[method]({ ...intent, nativeContextTarget: true }, control.value), false);
    }
  }
  editorMode = 0;
  eraserActive = false;
  for (const method of ["handleTouchStart", "handleTouchMove"]) {
    const pen = controls();
    assert.equal(policy[method]({ targetRole: "viewer", touchHasStylus: true }, pen.value), false);
    assert.equal(pen.prevented, false, "tool-free Pencil keeps native scrolling");
  }
});

test("selecting a tool interrupts native momentum before Pencil input, without intercepting finger or mouse", () => {
  const { policy } = createPolicy();
  let active = false;
  let interruptions = 0;
  policy.isAnnotationToolActive = () => active;
  policy.stopNativeScroll = () => interruptions++;
  policy.onToolChange();
  assert.equal(interruptions, 0);
  active = true;
  policy.onToolChange();
  assert.equal(interruptions, 1, "cancel in-flight momentum when the tool is selected");
  const intent = { type: "pointerdown", targetRole: "viewer", pointerType: "touch" };
  const forward = () => {};
  policy.route(intent, forward, controls().value);
  policy.route({ ...intent, pointerType: "mouse" }, forward, controls().value);
  assert.equal(interruptions, 1, "ordinary finger and mouse keep native paths");
  policy.route({ ...intent, pointerType: "pen" }, forward, controls().value);
  assert.equal(interruptions, 2, "new Pencil edit also interrupts scrolling resumed since tool selection");
  active = false;
  policy.route({ ...intent, pointerType: "pen" }, forward, controls().value);
  assert.equal(interruptions, 2, "tool-free Pencil stays native");
  policy.route({
    ...intent,
    pointerType: "pen",
    targetRole: "outside-viewer",
    targetRegion: "editor-mode-buttons",
    nativeActivationTarget: true,
  }, forward, controls().value);
  assert.equal(interruptions, 3,
    "a Pencil activation on a toolbar control interrupts momentum before changing tools");
  const stylusStart = controls();
  policy.isAnnotationToolActive = () => true;
  policy.handleTouchStart({
    type: "touchstart",
    targetRole: "annotation-layer",
    nativeContextTarget: false,
    nativeOperation: null,
    touchHasStylus: true,
  }, stylusStart.value);
  assert.equal(interruptions, 4,
    "the actual active-tool stylus contact requests an interruption before editor ownership");
  assert.equal(stylusStart.prevented, true);
});

test("a finger contact on the annotation toolbar interrupts native momentum without claiming touch", () => {
  const { policy } = createPolicy();
  let interruptions = 0;
  let forwarded = 0;
  policy.stopNativeScroll = () => { interruptions++; };
  const toolbarTouch = controls();
  policy.route({
    type: "touchstart",
    pointerType: "touch",
    targetRole: "native-control",
    targetRegion: "editor-mode-buttons",
    nativeContextTarget: true,
    nativeActivationTarget: true,
    touchHasStylus: false,
  }, () => { forwarded++; }, toolbarTouch.value);
  assert.equal(interruptions, 1,
    "the toolbar contact requests cancellation of PDF native scroll inertia");
  assert.equal(toolbarTouch.prevented, false,
    "the toolbar retains its normal native finger activation");
  assert.equal(forwarded, 1,
    "the original touch event still reaches PDF.js and toolbar handling");

  const viewerTouch = controls();
  policy.route({
    type: "touchstart",
    pointerType: "touch",
    targetRole: "viewer",
    nativeContextTarget: false,
    nativeActivationTarget: false,
  }, () => { forwarded++; }, viewerTouch.value);
  assert.equal(interruptions, 1,
    "ordinary page scrolling remains browser-owned");
  assert.equal(viewerTouch.prevented, false);
  assert.equal(forwarded, 2);
});

test("native scroll interruption preserves position and restores all inline CSS, including on error", async () => {
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(await readFile(new URL("../viewer-adapter/input/viewport-controller.js", import.meta.url), "utf8"), { window: runtimeWindow });
  const frames = [];
  const viewport = new runtimeWindow.PdfReaderInputRuntime.ViewportController({
    requestFrame(callback) { frames.push(callback); return frames.length; },
    cancelFrame() {},
  });
  const values = new Map([["overflow", ["auto", ""]], ["scroll-behavior", ["smooth", "important"]]]);
  let layouts = 0;
  const positions = [];
  const container = {
    scrollTop: 137.5, scrollLeft: 22.5,
    get clientWidth() { layouts++; return 800; },
    style: {
      getPropertyValue: (name) => values.get(name)?.[0] || "",
      getPropertyPriority: (name) => values.get(name)?.[1] || "",
      setProperty: (name, value, priority) => values.set(name, [value, priority]),
      removeProperty: (name) => values.delete(name),
    },
    scrollTo(options) {
      assert.deepEqual(values.get("overflow"), ["hidden", "important"]);
      assert.deepEqual(values.get("scroll-behavior"), ["auto", "important"]);
      positions.push(JSON.parse(JSON.stringify(options)));
    },
  };
  assert.equal(viewport.interruptNativeScroll(container), true);
  assert.deepEqual(positions, [{ top: 137.5, left: 22.5, behavior: "instant" }]);
  assert.equal(layouts, 3, "measure the bound and flush layout while the temporary scroll lock is active");
  assert.deepEqual(values.get("overflow"), ["hidden", "important"]);
  frames.shift()();
  assert.deepEqual(values.get("overflow"), ["hidden", "important"],
    "keep the native scroll lock across the first rendered frame");
  frames.shift()();
  assert.deepEqual(values.get("overflow"), ["auto", ""]);
  assert.deepEqual(values.get("scroll-behavior"), ["smooth", "important"]);
  container.scrollTo = () => { throw new Error("detached"); };
  assert.equal(viewport.interruptNativeScroll(container), false,
    "a detached scrolling container fails closed without leaking the temporary lock");
  assert.deepEqual(values.get("overflow"), ["auto", ""]);
  assert.deepEqual(values.get("scroll-behavior"), ["smooth", "important"]);
});
