import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../viewer-adapter/input/interaction-mode.js", import.meta.url),
  "utf8",
);
const runtimeWindow = { PdfReaderInputRuntime: {} };
vm.runInNewContext(source, { window: runtimeWindow });
const InteractionMode = runtimeWindow.PdfReaderInputRuntime.InteractionMode;

test("PDF.js editor tools resolve to narrow interaction modes", () => {
  const cases = [
    [0, "READ"],
    [3, "FREETEXT"],
    [5, "OBJECT_EDIT"],
    [9, "HIGHLIGHT"],
    [10, "TEXT_SELECT"],
    [15, "INK"],
    [17, "ERASER"],
    [999, "OBJECT_EDIT"],
  ];
  for (const [editorMode, expected] of cases) {
    assert.equal(InteractionMode.resolve({ editorMode }), expected);
  }
  assert.equal(InteractionMode.resolve({ eraserActive: true }), "ERASER");
  assert.equal(InteractionMode.resolve({ editorMode: 0, pointerType: "pen", isPanGesture: true }), "PAN");
  assert.equal(InteractionMode.resolve({ editorMode: 0, nativeOperation: "resize" }), "OBJECT_EDIT");
});

test("interaction modes expose only their intended controller owners", () => {
  assert.equal(InteractionMode.allows("READ", "pdfjs"), true);
  assert.equal(InteractionMode.allows("PAN", "viewport"), true);
  assert.equal(InteractionMode.allows("HIGHLIGHT", "text-selection"), true);
  assert.equal(InteractionMode.allows("HIGHLIGHT", "annotation"), true);
  assert.equal(InteractionMode.allows("INK", "text-selection"), false);
  assert.equal(InteractionMode.allows("ERASER", "viewport"), false);
  assert.equal(InteractionMode.isTextSelectionMode("TEXT_SELECT"), true);
  assert.equal(InteractionMode.isTextSelectionMode("HIGHLIGHT"), true);
  assert.equal(InteractionMode.isTextSelectionMode("INK"), false);
  assert.equal(InteractionMode.isToolActive("READ"), false);
  assert.equal(InteractionMode.isToolActive("FREETEXT"), true);
});
