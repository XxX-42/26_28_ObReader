import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../viewer-adapter/input/text-selection-controller.js", import.meta.url),
  "utf8",
);

function harness() {
  const startNode = { name: "start" };
  const endNode = { name: "end" };
  const externalNode = { name: "outside" };
  const nodes = new Set([startNode, endNode]);
  let textLayer;
  const page = { contains: (node) => node === textLayer };
  textLayer = {
    isConnected: true,
    contains(node) { return node === textLayer || nodes.has(node); },
    closest(selector) { return selector === ".page" ? page : null; },
  };
  const textSpan = {
    contains(node) { return node === startNode; },
    closest(selector) {
      if (selector === ".textLayer") return textLayer;
      if (selector === ".textLayer span") return textSpan;
      return selector === ".page" ? page : null;
    },
  };
  nodes.add(textSpan);
  let selectionText = "";
  const selection = {
    anchorNode: startNode,
    anchorOffset: 0,
    focusNode: startNode,
    focusOffset: 0,
    isCollapsed: true,
    rangeCount: 0,
    ranges: [],
    toString() { return selectionText; },
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      this.anchorNode = anchorNode;
      this.anchorOffset = anchorOffset;
      this.focusNode = focusNode;
      this.focusOffset = focusOffset;
      this.isCollapsed = anchorNode === focusNode && anchorOffset === focusOffset;
      this.rangeCount = this.isCollapsed ? 0 : 1;
      this.ranges = this.isCollapsed ? [] : [{
        commonAncestorContainer: textLayer,
      }];
      selectionText = this.isCollapsed ? "" : "selected text";
    },
    getRangeAt(index) { return this.ranges[index]; },
    removeAllRanges() {
      this.rangeCount = 0;
      this.isCollapsed = true;
      this.anchorNode = null;
      this.focusNode = null;
      this.anchorOffset = 0;
      this.focusOffset = 0;
      this.ranges = [];
      selectionText = "";
    },
  };
  const documentRef = {
    getSelection: () => selection,
    elementFromPoint: () => textSpan,
    caretPositionFromPoint(x) {
      return { offsetNode: x === 0 ? startNode : endNode, offset: x === 0 ? 0 : 4 };
    },
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(source, { window: runtimeWindow });
  let pending = true;
  let current = true;
  const controller = new runtimeWindow.PdfReaderInputRuntime.TextSelectionController({
    documentRef,
    isSessionCurrent: () => current,
    isPendingPointer: () => pending,
  });
  const pointer = { pointerId: 1, moved: false };
  return {
    controller,
    pointer,
    selection,
    textLayer,
    textSpan,
    page,
    startNode,
    endNode,
    externalNode,
    setPending(value) { pending = value; },
    setCurrent(value) { current = value; },
  };
}

test("Pencil text selection owns a collapsed caret and validates an extended range", () => {
  const h = harness();
  const intent = { clientPoint: { x: 0, y: 1 }, trusted: true };
  assert.equal(h.controller.begin(h.pointer, intent, { eligible: true }), true);
  assert.equal(h.controller.resolveTarget(intent).textLayer, h.textLayer);
  assert.equal(h.pointer.textSelectionStart.node, h.startNode);
  assert.equal(h.pointer.selectionAtDown.isCollapsed, true);

  h.pointer.moved = true;
  assert.equal(h.controller.extend(h.pointer, { clientPoint: { x: 1, y: 20 } }), true);
  assert.equal(h.selection.focusNode, h.endNode);
  assert.equal(h.controller.hasValidHighlightSelection(h.pointer), true);
});

test("selection cleanup removes only the range still owned by the Pencil gesture", () => {
  const h = harness();
  const intent = { clientPoint: { x: 0, y: 1 }, trusted: true };
  h.controller.begin(h.pointer, intent, { eligible: true });
  h.pointer.moved = true;
  h.controller.extend(h.pointer, { clientPoint: { x: 1, y: 20 } });
  h.controller.clearOwned(h.pointer);
  assert.equal(h.selection.rangeCount, 0);

  h.controller.begin(h.pointer, intent, { eligible: true });
  h.pointer.moved = true;
  h.controller.extend(h.pointer, { clientPoint: { x: 1, y: 20 } });
  h.selection.anchorNode = h.externalNode;
  h.controller.clearOwned(h.pointer);
  assert.equal(h.selection.anchorNode, h.externalNode);
  assert.equal(h.pointer.ownedPenTextSelection, null);
});

test("range extension stops on session loss or foreign selection ownership", () => {
  const h = harness();
  const intent = { clientPoint: { x: 0, y: 1 }, trusted: true };
  h.controller.begin(h.pointer, intent, { eligible: true });
  h.pointer.moved = true;
  h.setPending(false);
  assert.equal(h.controller.extend(h.pointer, { clientPoint: { x: 1, y: 20 } }), false);

  h.setPending(true);
  h.setCurrent(false);
  assert.equal(h.controller.extend(h.pointer, { clientPoint: { x: 1, y: 20 } }), false);

  h.setCurrent(true);
  h.selection.setBaseAndExtent(h.externalNode, 0, h.externalNode, 0);
  assert.equal(h.controller.extend(h.pointer, { clientX: 1, clientY: 20 }), false);
});

test("caret results outside the target text layer never begin an owned selection", () => {
  const h = harness();
  const intent = { clientPoint: { x: 0, y: 1 }, trusted: true };
  h.controller.begin(h.pointer, intent, { eligible: true });
  const outsideLayer = { ...h.textLayer, contains: () => false };
  assert.equal(h.controller.caretPosition(1, 1, outsideLayer), null);
});
