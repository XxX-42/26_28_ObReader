import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { root } from "./bundled-plugin-test-utils.mjs";

const inputRoot = path.join(root, "viewer-adapter", "input");
const source = async (name) => readFile(path.join(inputRoot, name), "utf8");

test("InputRouter owns event subscriptions without reaching into PDF or persistence APIs", async () => {
  const router = await source("input-router.js");
  assert.match(router, /class InputRouter/);
  assert.match(router, /pointerdown/);
  assert.match(router, /pointercancel/);
  assert.match(router, /lostpointercapture/);
  assert.match(router, /visibilitychange/);
  for (const forbidden of [
    "document.getSelection",
    "setBaseAndExtent",
    "highlightSelection",
    "annotationStorage",
    "appendOperations",
    "scheduleAutoSave",
    "save()",
    "PDFViewerApplication",
    "onLegacyEvent",
  ]) {
    assert.ok(!router.includes(forbidden), `InputRouter must not contain ${forbidden}`);
  }
  for (const ownershipApi of [
    "_activePointers = new Map()",
    "_manualPointers = new Map()",
    "_penPolicyPointers = new Map()",
    "_captureTargets = new Map()",
    "capturePointer(pointerId, target)",
    "releasePointerCapture(pointerId)",
  ]) {
    assert.ok(router.includes(ownershipApi), `InputRouter must own ${ownershipApi}`);
  }
  assert.match(router, /shouldSuppressPenCompatibilityMouse/);
  assert.doesNotMatch(
    await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8"),
    /onBridgePenTextCompatibilityMouse/,
  );
});

test("InputRouter owns pointer sessions and releases capture during teardown", async () => {
  const listeners = new Map();
  const targetWindow = {
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  const targetDocument = {
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  const runtimeWindow = {
    PdfReaderInputRuntime: {
      createInteractionIntent: (event) => Object.freeze({ type: event.type }),
    },
  };
  const context = { window: runtimeWindow, AbortController };
  vm.runInNewContext(await source("input-router.js"), context);
  const router = new runtimeWindow.PdfReaderInputRuntime.InputRouter({
    targetWindow,
    targetDocument,
    policy: { route: (intent, forward) => forward(intent) },
    onIntent: (intent, controls) => dispatched.push([intent, controls]),
  });
  const dispatched = [];
  router.start();
  const pointer = { pointerId: 7, type: "pointerdown" };
  listeners.get("pointerdown")(pointer);
  assert.equal(dispatched[0][0].type, "pointerdown");
  assert.equal(dispatched[0].length, 2, "native events do not leave InputRouter");
  assert.equal(typeof dispatched[0][1].preventDefault, "function");
  assert.equal(listeners.has("touchstart"), false,
    "desktop input routing does not add legacy touch listeners");

  router.setActivePointer(7, pointer);
  router.setManualPointer(7, pointer);
  router.setPenPolicyPointer(7, pointer);
  let captured = true;
  let released = 0;
  const captureTarget = {
    setPointerCapture() { captured = true; },
    hasPointerCapture() { return captured; },
    releasePointerCapture() { captured = false; released += 1; },
  };
  assert.equal(router.capturePointer(7, captureTarget), true);
  assert.equal(router.hasPointerCapture(7), true);
  router.stop();
  assert.equal(router.activePointerCount, 0);
  assert.equal(router.manualPointerCount, 0);
  assert.equal(router.penPolicyPointerCount, 0);
  assert.equal(router.hasPointerCapture(7), false);
  assert.equal(released, 1);
});

test("iOS InputRouter owns non-passive touch compatibility events", async () => {
  const listeners = new Map();
  const optionsByType = new Map();
  const targetWindow = {
    addEventListener(type, callback, options) {
      listeners.set(type, callback);
      optionsByType.set(type, options);
    },
  };
  const runtimeWindow = {
    PdfReaderInputRuntime: {
      createInteractionIntent: (event) => Object.freeze({ type: event.type }),
    },
  };
  vm.runInNewContext(await source("input-router.js"), {
    window: runtimeWindow,
    AbortController,
  });
  const routed = [];
  const router = new runtimeWindow.PdfReaderInputRuntime.InputRouter({
    targetWindow,
    targetDocument: { addEventListener() {} },
    policy: {
      route(intent, forward, controls) {
        routed.push([intent.type, controls]);
        forward(intent);
      },
    },
    onIntent: (intent) => routed.push([`forward:${intent.type}`]),
    includeTouchEvents: true,
  });
  router.start();
  for (const type of ["touchstart", "touchmove"]) {
    assert.deepEqual(
      { capture: optionsByType.get(type).capture, passive: optionsByType.get(type).passive },
      { capture: true, passive: false },
      `${type} must be cancelable for active Pencil arbitration`,
    );
    listeners.get(type)({
      type,
      preventDefault() {},
      stopImmediatePropagation() {},
    });
  }
  assert.deepEqual(routed.map(([type]) => type), [
    "touchstart", "forward:touchstart", "touchmove", "forward:touchmove",
  ]);
  assert.equal(typeof routed[0][1].preventDefault, "function");
  router.stop();
});

test("InputRouter suppresses only mouse events synthesized during Pencil text highlighting", async () => {
  const listeners = new Map();
  const targetWindow = {
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  const targetDocument = { addEventListener() {} };
  const runtimeWindow = {
    PdfReaderInputRuntime: {
      createInteractionIntent: (event) => Object.freeze({ type: event.type }),
    },
  };
  vm.runInNewContext(await source("input-router.js"), {
    window: runtimeWindow,
    AbortController,
  });
  const dispatched = [];
  const router = new runtimeWindow.PdfReaderInputRuntime.InputRouter({
    targetWindow,
    targetDocument,
    policy: { route: (_intent, forward) => forward(_intent) },
    onIntent: (intent) => dispatched.push(intent.type),
  });
  router.start();
  router.setActivePointer(9, {
    pointerId: 9,
    pointerType: "pen",
    kind: "text-selection",
    mode: 9,
    penTextSelectionGesture: true,
  });
  let prevented = false;
  let stopped = false;
  listeners.get("mousedown")({
    type: "mousedown",
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.deepEqual(dispatched, []);

  listeners.get("wheel")({ type: "wheel" });
  assert.deepEqual(dispatched, ["wheel"], "ordinary input still reaches the adapter");
  router.deleteActivePointer(9);
  listeners.get("mouseup")({
    type: "mouseup",
    preventDefault() { prevented = true; },
    stopImmediatePropagation() { stopped = true; },
  });
  assert.deepEqual(dispatched, ["wheel", "mouseup"],
    "ordinary mouse events are forwarded when no Pencil text gesture owns them");
  router.stop();
});

test("InteractionIntent contains value data and no DOM target or native event", async () => {
  const intent = await source("interaction-intent.js");
  assert.match(intent, /Object\.freeze\(/);
  assert.match(intent, /pageIndex/);
  assert.match(intent, /clientPoint/);
  assert.match(intent, /nativeOperation/);
  assert.match(intent, /nativeContextTarget/);
  assert.match(intent, /nativeActivationTarget/);
  assert.match(intent, /targetRegion/);
  assert.match(intent, /trusted/);
  assert.match(intent, /modifiers/);
  assert.doesNotMatch(intent, /nativeEvent|rawEvent|target:\s*event\.target/);
  const page = { dataset: { pageNumber: "4" } };
  class FakeElement {
    constructor({ activation = false } = {}) { this.activation = activation; }
    closest(selector) {
      if (selector === ".page") return page;
      if (selector === ".annotationEditorLayer" || selector === ".resizer") return this;
      if (selector === "a[href], button, [role=button], [role=link]") {
        return this.activation ? this : null;
      }
      if (selector.includes("contenteditable") || selector.includes("role=dialog")) return null;
      return null;
    }
  }
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(intent, {
    window: runtimeWindow,
    document: {},
    Element: FakeElement,
  });
  const nativeEvent = {
    type: "pointerdown",
    target: new FakeElement(),
    pointerId: 3,
    pointerType: "pen",
    button: 0,
    buttons: 1,
    clientX: 14,
    clientY: 29,
    timeStamp: 50,
    isTrusted: true,
  };
  const value = runtimeWindow.PdfReaderInputRuntime.createInteractionIntent(nativeEvent);
  assert.equal(value.targetRole, "annotation-layer");
  assert.equal(value.nativeOperation, "resize");
  assert.equal(value.pageIndex, 3);
  assert.equal(value.clientPoint.x, 14);
  assert.equal(value.trusted, true);
  assert.equal(value.nativeActivationTarget, false);
  assert.equal("target" in value, false);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.clientPoint), true);

  const touchList = {
    0: { touchType: "stylus" },
    length: 1,
    item(index) { return this[index] || null; },
  };
  const anchorEvent = runtimeWindow.PdfReaderInputRuntime.createInteractionIntent({
    type: "click",
    target: new FakeElement({ activation: true }),
    detail: 1,
    changedTouches: touchList,
  });
  assert.equal(anchorEvent.nativeActivationTarget, true,
    "native links and controls are represented without retaining their DOM target");
  const stylusEvent = runtimeWindow.PdfReaderInputRuntime.createInteractionIntent({
    type: "touchstart",
    target: new FakeElement(),
    changedTouches: touchList,
  });
  assert.equal(stylusEvent.touchHasStylus, true,
    "TouchList values are read by index/item without requiring iteration");
  assert.equal("target" in stylusEvent, false);
});

test("ViewportController owns motion math without depending on PDF, selection, or persistence", async () => {
  const viewport = await source("viewport-controller.js");
  assert.match(viewport, /class ViewportController/);
  assert.match(viewport, /scrollTop/);
  assert.match(viewport, /scrollLeft/);
  assert.match(viewport, /requestFrame/);
  for (const forbidden of [
    "document.getSelection",
    "setBaseAndExtent",
    "highlightSelection",
    "annotationStorage",
    "appendOperations",
    "Vault",
    "sidecar",
    "IOSInputPolicy",
  ]) {
    assert.ok(!viewport.includes(forbidden), `ViewportController must not contain ${forbidden}`);
  }
});

test("TextSelectionController owns DOM selection and caret operations only", async () => {
  const selection = await source("text-selection-controller.js");
  assert.match(selection, /document\.getSelection/);
  assert.match(selection, /caretPositionFromPoint/);
  assert.match(selection, /caretRangeFromPoint/);
  assert.match(selection, /setBaseAndExtent/);
  assert.match(selection, /getRangeAt/);
  assert.match(selection, /elementFromPoint/);
  for (const forbidden of [
    "annotationStorage",
    "highlightSelection",
    "appendOperations",
    "scheduleAutoSave",
    "Vault",
    "sidecar",
    "manualMomentum",
    "scrollTop",
  ]) {
    assert.ok(!selection.includes(forbidden), `TextSelectionController must not contain ${forbidden}`);
  }
  const bridge = await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8");
  for (const forbidden of [
    "document.getSelection(",
    "caretPositionFromPoint(",
    "caretRangeFromPoint(",
    "setBaseAndExtent(",
    "selection.getRangeAt(",
  ]) {
    assert.ok(!bridge.includes(forbidden), `Bridge must delegate ${forbidden}`);
  }
});

test("AnnotationController owns PDF.js editor cancellation and highlight fallback only", async () => {
  const annotation = await source("annotation-controller.js");
  assert.match(annotation, /class AnnotationController/);
  assert.match(annotation, /highlightSelection\("main_toolbar"\)/);
  assert.match(annotation, /endDrawingSession/);
  assert.match(annotation, /cancelTemporaryStroke/);
  assert.match(annotation, /nativeOperation/);
  for (const forbidden of [
    "event.target",
    "target.closest",
    "-webkit-touch-callout",
    "fingerTextSelectionSuppression",
    "manualMomentum",
    "scrollTop",
    "document.getSelection",
    "annotationStorage",
    "appendOperations",
    "scheduleAutoSave",
    "Vault",
    "sidecar",
  ]) {
    assert.ok(!annotation.includes(forbidden), `AnnotationController must not contain ${forbidden}`);
  }
  const bridge = await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8");
  assert.match(bridge, /state\.annotationController\?\.pointerInteractionKind/);
  assert.match(bridge, /state\.annotationController\?\.preparePenHighlight/);
  assert.match(bridge, /state\.annotationController\?\.finishPenHighlight/);
  assert.match(bridge, /state\.annotationController\?\.cancelPointerSession/);
  assert.doesNotMatch(bridge, /manager\.highlightSelection\(/);
});

test("DesktopInputPolicy only forwards established behavior and contains no iPad overrides", async () => {
  const desktop = await source("desktop-input-policy.js");
  assert.match(desktop, /forwardExistingBehavior/);
  for (const forbidden of [
    "manualMomentum",
    "-webkit-touch-callout",
    "fingerTextSelectionSuppression",
    "touch-action:none",
    "IOSInputPolicy",
    "iPad",
  ]) {
    assert.ok(!desktop.includes(forbidden), `DesktopInputPolicy must not contain ${forbidden}`);
  }
});

test("IOSInputPolicy owns finger text-selection suppression", async () => {
  const ios = await source("ios-input-policy.js");
  assert.match(ios, /class IOSInputPolicy/);
  assert.match(ios, /setFingerTextSelectionSuppressionOwned/);
  assert.match(ios, /handleTextSelectionGuard/);
  assert.match(ios, /handlePanClick/);
  assert.match(ios, /pdfReaderFingerTextSelectionSuppressed/);
  const bridge = await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8");
  assert.doesNotMatch(bridge, /state\.fingerTextSelectionSuppressionOwned/);
  assert.doesNotMatch(bridge, /pdfReaderFingerTextSelectionSuppressed/);
  assert.doesNotMatch(bridge, /lastTouchClickPage|lastPenPanClickPage/);
  assert.match(bridge, /state\.inputPolicy\?\.handleTextSelectionGuard\?\.\(intent, controls\)/);
  assert.match(bridge, /state\.inputPolicy\?\.handlePanClick\?\.\(intent, controls/);
});

test("IOSDirectManipulationController delegates page touch and read-mode Pencil to WebKit", async () => {
  const direct = await source("ios-direct-manipulation-controller.js");
  assert.match(direct, /class IOSDirectManipulationController/);
  for (const ownedBehavior of [
    "preparePointerDown(intent)",
    "routePointerDown(intent, controls",
    "startNativeTouchPointer(intent, controls)",
    "clearNativeTouchPointer(pointerId)",
    "onDocumentVisibilityChange()",
  ]) {
    assert.ok(direct.includes(ownedBehavior), `iOS controller must own ${ownedBehavior}`);
  }
  const routeDown = direct.slice(
    direct.indexOf("    routePointerDown(intent, controls"),
    direct.indexOf("    startNativeTouchPointer(intent, controls)"),
  );
  assert.match(routeDown, /this\.startNativeTouchPointer\(intent, controls\)/);
  assert.match(routeDown, /Read-mode Pencil uses WebKit's native scroll and activation path/);
  assert.doesNotMatch(routeDown, /startManualPointer/,
    "page touch and read-mode Pencil never enter the dormant manual-pan path");
  const nativeTouchPath = direct.slice(
    direct.indexOf("    startNativeTouchPointer(intent, controls)"),
    direct.indexOf("    suspendTouchPansForPen()"),
  );
  assert.match(nativeTouchPath, /controls\?\.stopImmediatePropagation\?\./);
  assert.doesNotMatch(nativeTouchPath, /controls\?\.preventDefault\?\./,
    "native page contact ownership does not cancel WebKit scrolling");
  for (const forbidden of [
    "document.getSelection",
    "setBaseAndExtent",
    "highlightSelection",
    "annotationStorage",
    "appendOperations",
    "scheduleAutoSave",
    "Vault",
    "sidecar",
  ]) {
    assert.ok(!direct.includes(forbidden), `iOS controller must not contain ${forbidden}`);
  }
  const bridge = await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8");
  assert.doesNotMatch(bridge, /function startManualPointer\(/);
  assert.doesNotMatch(bridge, /function finishManualPointer\(/);
  assert.doesNotMatch(bridge, /function applyManualPan\(/);
  assert.match(bridge, /state\.iosDirectManipulationController\?\.handlePointerMove\(intent, controls\)/);
  assert.match(bridge, /state\.iosDirectManipulationController\?\.routePointerDown\(intent, controls/);
  assert.match(bridge, /state\.inputPolicy\?\.refreshPenGestureTouchAction\?\./);
});

test("bridge delegates top-level listener installation to InputRouter", async () => {
  const bridge = await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8");
  const install = /function installPointerTrackingListeners\(\)\s*\{([\s\S]*?)\n  \}/.exec(bridge)?.[1];
  assert.ok(install, "installPointerTrackingListeners must remain as bridge wiring");
  assert.match(install, /new window\.PdfReaderInputRuntime\.InputRouter/);
  assert.doesNotMatch(install, /addEventListener\(/);
  assert.doesNotMatch(bridge, /state\.(?:activePointers|manualPointers|penPolicyPointers)/);
  assert.doesNotMatch(bridge, /pointer\.captureTarget|manualPointer\.captureTarget/);
  assert.doesNotMatch(bridge, /state\.manualMomentum/);
  assert.match(bridge, /new window\.PdfReaderInputRuntime\.ViewportController/);
});
