import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
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
});

test("InteractionIntent contains value data and no DOM target or native event", async () => {
  const intent = await source("interaction-intent.js");
  assert.match(intent, /Object\.freeze\(/);
  assert.match(intent, /pageIndex/);
  assert.match(intent, /clientPoint/);
  assert.match(intent, /modifiers/);
  assert.doesNotMatch(intent, /nativeEvent|rawEvent|target:\s*event\.target/);
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

test("bridge delegates top-level listener installation to InputRouter", async () => {
  const bridge = await readFile(path.join(root, "viewer-adapter", "obsidian-bridge.js"), "utf8");
  const install = /function installPointerTrackingListeners\(\)\s*\{([\s\S]*?)\n  \}/.exec(bridge)?.[1];
  assert.ok(install, "installPointerTrackingListeners must remain as bridge wiring");
  assert.match(install, /new window\.PdfReaderInputRuntime\.InputRouter/);
  assert.doesNotMatch(install, /addEventListener\(/);
});
