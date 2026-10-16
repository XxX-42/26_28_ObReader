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
    onLegacyEvent: (intent, event) => dispatched.push([intent, event]),
  });
  const dispatched = [];
  router.start();
  const pointer = { pointerId: 7, type: "pointerdown" };
  listeners.get("pointerdown")(pointer);
  assert.equal(dispatched[0][0].type, "pointerdown");
  assert.equal(dispatched[0][1], pointer);

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

test("InteractionIntent contains value data and no DOM target or native event", async () => {
  const intent = await source("interaction-intent.js");
  assert.match(intent, /Object\.freeze\(/);
  assert.match(intent, /pageIndex/);
  assert.match(intent, /clientPoint/);
  assert.match(intent, /modifiers/);
  assert.doesNotMatch(intent, /nativeEvent|rawEvent|target:\s*event\.target/);
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
  assert.match(bridge, /state\.inputPolicy\?\.handleTextSelectionGuard\?\.\(event\)/);
  assert.match(bridge, /state\.inputPolicy\?\.handlePanClick\?\.\(event/);
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
