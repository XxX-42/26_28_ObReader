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
