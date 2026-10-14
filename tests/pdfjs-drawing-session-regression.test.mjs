import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viewerPath = path.join(root, "vendor", "pdfjs-generic-legacy", "build", "pdf.mjs");

test("PDF.js retires stale Ink drawing listeners and guards a missing current draw", async () => {
  const source = await readFile(viewerPath, "utf8");
  const start = source.indexOf("static startDrawing(parent, uiManager, _isLTR, event)");
  assert.notEqual(start, -1, "Expected the vendored DrawingEditor.startDrawing implementation");
  const pointerDown = source.indexOf('window.addEventListener("pointerdown", e => {', start);
  const isCancellable = source.indexOf("DrawingEditor.#currentDraw.isCancellable()", pointerDown);
  assert.ok(pointerDown > start && isCancellable > pointerDown);

  const preflight = source.slice(start, pointerDown);
  assert.match(preflight, /DrawingEditor\.#currentDrawingAC\?\.abort\(\)/);
  assert.match(preflight, /CurrentPointers\.clearPointerIds\(\)/);

  const handler = source.slice(pointerDown, isCancellable);
  assert.match(handler, /DrawingEditor\.#currentDrawingAC !== ac/);
  assert.match(handler, /if \(!DrawingEditor\.#currentDraw\)/);
  assert.ok(
    handler.indexOf("if (!DrawingEditor.#currentDraw)") < isCancellable - pointerDown,
    "The null guard must run before calling isCancellable",
  );

  const endDrawing = source.indexOf("static endDrawing(isAborted)", isCancellable);
  const endDrawingBody = source.slice(endDrawing, source.indexOf("createDrawingOptions", endDrawing));
  assert.match(endDrawingBody, /!DrawingEditor\.#currentDraw/);
});
