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
  });

  policy.setFingerTextSelectionSuppressionOwned(true);
  assert.equal(suppressed, false, "read mode does not suppress text selection");
  let prevented = false;
  const controls = { preventDefault() { prevented = true; } };
  assert.equal(policy.handleTextSelectionGuard({ targetRole: "text-layer" }, controls), false);
  assert.equal(prevented, false);

  annotationToolActive = true;
  assert.equal(policy.refreshFingerTextSelectionSuppression(), true);
  assert.equal(suppressed, true);
  assert.equal(policy.handleTextSelectionGuard({ targetRole: "native-control" }, controls), false,
    "toolbar interaction stays available");
  assert.equal(policy.handleTextSelectionGuard({ targetRole: "text-layer" }, controls), true);
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
  });
  const click = (pageIndex, detail = 1, pointerType = "mouse", targetRole = "viewer", nativeContextTarget = false) => {
    let prevented = false;
    let stopped = false;
    const intent = {
      detail,
      pointerType,
      pageIndex,
      targetRole,
      nativeContextTarget,
    };
    const controls = {
      preventDefault() { prevented = true; },
      stopImmediatePropagation() { stopped = true; },
    };
    return {
      intent,
      controls,
      wasSuppressed: policy.handlePanClick(intent, controls),
      get prevented() { return prevented; },
      get stopped() { return stopped; },
    };
  };

  policy.rememberPanClickTarget("touch", 0);
  const samePageCompatibilityClick = click(0);
  assert.equal(samePageCompatibilityClick.wasSuppressed, true);
  assert.equal(samePageCompatibilityClick.prevented, true);
  assert.equal(samePageCompatibilityClick.stopped, true);
  assert.equal(click(1).wasSuppressed, false);
  assert.equal(click(0, 1, "mouse", "native-control").wasSuppressed, false);
  assert.equal(click(0, 1, "mouse", "annotation-layer", true).wasSuppressed, false,
    "FreeText does not inherit a pan's compatibility-click suppression");
  assert.equal(click(1, 1, "touch").wasSuppressed, true);

  policy.clearPanClickTargets();
  assert.equal(click(0).wasSuppressed, false);
  policy.rememberPanClickTarget("pen", 0);
  const doubleClick = click(0, 2);
  assert.equal(policy.handlePanClick(doubleClick.intent, doubleClick.controls, { doubleClick: true }), true);
  assert.equal(policy.handlePanClick({
    ...doubleClick.intent,
    detail: 1,
  }, doubleClick.controls, { doubleClick: true }), false);
});
