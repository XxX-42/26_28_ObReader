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
  let current = true;
  const controller = new runtimeWindow.PdfReaderInputRuntime.TextSelectionController({
    documentRef,
    isSessionCurrent: () => current,
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
    setPending(value) {
      if (value) controller.pendingPointer = pointer;
      else controller.clearPending(pointer);
    },
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

test("selection range snapshot is obtained by the TextSelectionController as value data", () => {
  const h = harness();
  const rectangle = { left: 10, top: 20, right: 40, bottom: 32, width: 30, height: 12 };
  h.selection.isCollapsed = false;
  h.selection.rangeCount = 1;
  h.selection.ranges = [{ startContainer: h.startNode, startOffset: 1,
    endContainer: h.endNode, endOffset: 3, toString: () => "selected text",
    getBoundingClientRect: () => rectangle }];
  const snapshot = h.controller.rangeSnapshot();
  assert.equal(snapshot.startContainer, h.startNode);
  assert.equal(snapshot.startOffset, 1);
  assert.equal(snapshot.endContainer, h.endNode);
  assert.equal(snapshot.endOffset, 3);
  assert.equal(snapshot.text, "selected text");
  assert.deepEqual({ ...snapshot.rect }, rectangle);
  assert.equal(Object.hasOwn(snapshot, "range"), false);
});

test("TextSelectionController resolves stable text anchors and owns applying the resulting range", () => {
  const textNode = { nodeValue: "prefix target suffix", nodeType: 3 };
  const selection = {
    removeAllRanges() { this.range = null; },
    addRange(range) { this.range = range; },
  };
  const documentRef = {
    getSelection: () => selection,
    createTreeWalker: () => {
      let consumed = false;
      return { nextNode: () => consumed ? null : (consumed = true, textNode) };
    },
    createRange() {
      return {
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
        get commonAncestorContainer() { return textNode; },
      };
    },
  };
  const textLayer = {
    ownerDocument: documentRef,
    contains: (node) => node === textNode,
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(source, { window: runtimeWindow });
  const SelectionController = runtimeWindow.PdfReaderInputRuntime.TextSelectionController;
  const controller = new SelectionController({ documentRef });
  const anchor = {
    textPosition: { start: 7, end: 13 }, exactQuote: "target", prefix: "prefix ", suffix: " suffix",
  };
  const range = controller.rangeForAnchor(textLayer, anchor);
  assert.equal(range.startContainer, textNode);
  assert.equal(range.startOffset, 7);
  assert.equal(range.endOffset, 13);
  assert.equal(controller.selectRange(textLayer, range), true);
  assert.equal(selection.range, range);
  assert.equal(controller.rangesForAnchors(textLayer, [anchor, { ...anchor, exactQuote: "missing" }]).length, 1);
});

test("TextSelectionController captures quote, text position, native selector, and normalized geometry", () => {
  const textNode = { nodeType: 3, nodeValue: "prefix target suffix" };
  const span = {
    closest: (selector) => selector === "span" || selector === ".textLayer span" ? span : null,
  };
  textNode.parentElement = span;
  const selection = {};
  const documentRef = {
    getSelection: () => selection,
    createTreeWalker(root) {
      let consumed = false;
      return { nextNode: () => consumed ? null : (consumed = true, textNode) };
    },
    createRange() { return {}; },
  };
  const textLayer = {
    ownerDocument: documentRef,
    contains: (node) => node === textNode,
    querySelectorAll: () => [span],
  };
  const pageRoot = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(source, { window: runtimeWindow });
  const controller = new runtimeWindow.PdfReaderInputRuntime.TextSelectionController({ documentRef });
  const captured = controller.captureRangeAnchor(textLayer, {
    startContainer: textNode, startOffset: 7,
    endContainer: textNode, endOffset: 13,
    text: "target",
    rect: { left: 10, top: 20, right: 40, bottom: 32, width: 30, height: 12 },
  }, pageRoot);
  assert.deepEqual({ ...captured.textPosition }, { start: 7, end: 13 });
  assert.equal(captured.exactQuote, "target");
  assert.equal(captured.prefix, "prefix ");
  assert.equal(captured.suffix, " suffix");
  assert.equal(captured.nativeSelection, "0,7,0,13");
  assert.equal(captured.geometry.x, 0.1);
  assert.equal(captured.geometry.y, 0.2);
  assert.ok(Math.abs(captured.geometry.width - 0.3) < 1e-12);
  assert.equal(captured.geometry.height, 0.12);
});

test("TextSelectionController restores a four-part native PDF selection across spans", () => {
  const firstText = { nodeType: 3, nodeValue: "first" };
  const secondText = { nodeType: 3, nodeValue: "second" };
  const firstSpan = {};
  const secondSpan = {};
  firstText.parentElement = firstSpan;
  secondText.parentElement = secondSpan;
  const ranges = [];
  const documentRef = {
    getSelection: () => null,
    createTreeWalker(root) {
      const nodes = root === firstSpan ? [firstText] : root === secondSpan ? [secondText] : [];
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
    createRange() {
      const range = {
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
      };
      ranges.push(range);
      return range;
    },
  };
  const textLayer = {
    querySelectorAll: () => [firstSpan, secondSpan],
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(source, { window: runtimeWindow });
  const controller = new runtimeWindow.PdfReaderInputRuntime.TextSelectionController({ documentRef });
  const range = controller.rangeForNativeSelection(textLayer, "0,2,1,3");
  assert.equal(range.startContainer, firstText);
  assert.equal(range.startOffset, 2);
  assert.equal(range.endContainer, secondText);
  assert.equal(range.endOffset, 3);
  assert.equal(controller.rangeForNativeSelection(textLayer, "0,2,9,3"), null);
  assert.equal(controller.rangeForNativeSelection(textLayer, "0,2,1,-1"), null);
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
  assert.equal(h.controller.extend(h.pointer, { clientPoint: { x: 1, y: 20 } }), false);
});

test("TextSelectionController owns and cancels its pending Pencil session", () => {
  const h = harness();
  const intent = { clientPoint: { x: 0, y: 1 }, trusted: true };
  assert.equal(h.controller.begin(h.pointer, intent, { eligible: true }), true);
  assert.equal(h.controller.isPending(h.pointer), true);
  h.controller.cancelPending(h.pointer);
  assert.equal(h.controller.isPending(h.pointer), false);
  assert.equal(h.pointer.ownedPenTextSelection, null);
});

test("caret results outside the target text layer never begin an owned selection", () => {
  const h = harness();
  const intent = { clientPoint: { x: 0, y: 1 }, trusted: true };
  h.controller.begin(h.pointer, intent, { eligible: true });
  const outsideLayer = { ...h.textLayer, contains: () => false };
  assert.equal(h.controller.caretPosition(1, 1, outsideLayer), null);
});
