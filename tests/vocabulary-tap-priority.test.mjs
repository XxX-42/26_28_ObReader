import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

test("vocabulary tap is routed through the existing click owner after pan and annotation priority", async () => {
  const bridge = await read("viewer-adapter/obsidian-bridge.js");
  const inputRouter = await read("viewer-adapter/input/input-router.js");
  const clickHandlerStart = bridge.indexOf("  function onBridgeIosClick(intent, controls) {");
  const clickHandlerEnd = bridge.indexOf("\n  function onBridgeIosDoubleClick", clickHandlerStart);
  const clickHandler = bridge.slice(clickHandlerStart, clickHandlerEnd);
  assert.ok(clickHandlerStart >= 0 && clickHandlerEnd > clickHandlerStart);
  assert.match(inputRouter, /"click"/);
  assert.match(bridge, /\["click", onBridgeIosClick\]/);
  assert.ok(clickHandler.indexOf("handlePanClick") < clickHandler.indexOf("handleTap"),
    "the existing pan suppression decides before vocabulary considers the same click");
  assert.match(clickHandler, /state\.editorMode !== 0 \|\| annotationToolIsActive\(\)/,
    "annotation tools win before the vocabulary tap");
  assert.match(clickHandler, /hasActivePenEditorGesture/,
    "an active Pencil editor gesture cannot open the popup");
  assert.match(clickHandler, /knownPanClick/,
    "a remembered touch or Pencil pan is not reinterpreted as a tap");
  assert.doesNotMatch(inputRouter, /Vocabulary|vocab-/,
    "InputRouter remains persistence- and feature-agnostic");
});

test("word hit testing reads original TextNode Ranges and owns no parallel global input listener", async () => {
  const controller = await read("viewer-adapter/vocabulary/controller.js");
  assert.match(controller, /intent\.targetRole !== "text-layer"/);
  assert.match(controller, /selection\.isCollapsed !== true/);
  assert.match(controller, /intent\.button !== 0 \|\| intent\.detail !== 1/);
  assert.match(controller, /tokenAtPoint\(page, intent\.clientPoint\.x, intent\.clientPoint\.y, this\.document\)/);
  assert.match(controller, /range\.setStart\(segment\.textNode, segment\.startOffset\)/);
  assert.match(controller, /range\.setEnd\(segment\.textNode, segment\.endOffset\)/);
  assert.doesNotMatch(controller, /(?:document|window|this\.document|this\.window)\.addEventListener\(/,
    "page vocabulary logic does not add a second document/window input pipeline");
  assert.doesNotMatch(controller, /selection\.toString\(/,
    "single-token keys are resolved from physical TextNode offsets, not flattened selection text");
});
