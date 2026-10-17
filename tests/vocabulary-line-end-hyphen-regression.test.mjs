import assert from "node:assert/strict";
import test from "node:test";

import { VocabularyController } from "../viewer-adapter/vocabulary/controller.js";
import { VocabularyHighlightRenderer } from "../viewer-adapter/vocabulary/canvas-overlay.js";
import { getSelectedPageTokens } from "../viewer-adapter/vocabulary/phrase-matcher.js";
import { scanPageTextLayer } from "../viewer-adapter/vocabulary/page-scanner.js";

function makeRangeDocument(unitRects = new Map(), segmentRects = new Map()) {
  const document = {
    head: { appendChild(node) { node.parentNode = this; } },
    createElement(tag) {
      assert.equal(tag, "style");
      return { dataset: {}, textContent: "", remove() {} };
    },
    createRange() {
      let startNode = null;
      let startOffset = 0;
      let endNode = null;
      let endOffset = 0;
      return {
        setStart(node, offset) { startNode = node; startOffset = offset; this.start = [node, offset]; },
        setEnd(node, offset) { endNode = node; endOffset = offset; this.end = [node, offset]; },
        getBoundingClientRect() { return unitRects.get(`${startNode?.id}:${startOffset}`) || null; },
        getClientRects() { return segmentRects.get(startNode) || []; },
        detach() {},
      };
    },
  };
  return document;
}

function makeText(value, id, ownerDocument) {
  return {
    id,
    nodeType: 3,
    nodeName: "#text",
    nodeValue: value,
    data: value,
    length: value.length,
    ownerDocument,
    isConnected: true,
    parentNode: null,
  };
}

function makeElement(children, ownerDocument, className = "") {
  const element = {
    nodeType: 1,
    tagName: "DIV",
    className,
    childNodes: children,
    ownerDocument,
    parentNode: null,
    contains(node) {
      return node === this || this.childNodes.some((child) =>
        child === node || child.contains?.(node));
    },
    appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; },
    getAttribute() { return null; },
  };
  for (const child of children) child.parentNode = element;
  return element;
}

function makeCompabreakFixture() {
  const unitRects = new Map();
  const segmentRects = new Map();
  const document = makeRangeDocument(unitRects, segmentRects);
  const firstLine = makeText("compa-", "first-line", document);
  const secondLine = makeText("rable", "second-line", document);
  // The hyphen sits at the end of one line; the continuation starts at the
  // left edge of the next line. Coordinates scale proportionally like a PDF
  // text layer at any zoom level.
  unitRects.set("first-line:5", { top: 10, left: 70, width: 5, height: 12 });
  unitRects.set("second-line:0", { top: 24, left: 4, width: 7, height: 12 });
  segmentRects.set(firstLine, [{ left: 10, top: 10, right: 74, bottom: 22, width: 64, height: 12 }]);
  segmentRects.set(secondLine, [{ left: 4, top: 24, right: 38, bottom: 36, width: 34, height: 12 }]);
  const firstSpan = makeElement([firstLine], document, "markedContent");
  const secondSpan = makeElement([secondLine], document, "markedContent");
  const textLayer = makeElement([firstSpan, secondSpan], document, "textLayer");
  const pageRoot = makeElement([textLayer], document, "page");
  pageRoot.querySelector = (selector) => selector === ".textLayer" ? textLayer : null;
  pageRoot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 800 });
  return { document, firstLine, secondLine, textLayer, pageRoot, unitRects, segmentRects };
}

test("PDF line-end compa-/rable keeps comparable lookup identity and both physical ranges", () => {
  const fixture = makeCompabreakFixture();
  const { document, firstLine, secondLine, textLayer, pageRoot, segmentRects } = fixture;
  const originalText = [firstLine.nodeValue, secondLine.nodeValue];
  const [token] = scanPageTextLayer(textLayer);

  assert.equal(token.rawSurface, "compa-rable", "the displayed PDF text retains its visible line-end hyphen");
  assert.equal(token.surfaceKey, "comparable", "dictionary lookup uses the unhyphenated logical word");
  assert.deepEqual(token.segments, [
    { textNode: firstLine, startOffset: 0, endOffset: 6 },
    { textNode: secondLine, startOffset: 0, endOffset: 5 },
  ]);
  assert.deepEqual(token.segments.map(({ textNode, startOffset, endOffset }) =>
    textNode.nodeValue.slice(startOffset, endOffset)), ["compa-", "rable"]);
  assert.deepEqual([firstLine.nodeValue, secondLine.nodeValue], originalText,
    "tokenization never rewrites PDF.js source text");

  const selection = {
    startContainer: firstLine,
    startOffset: 2,
    endContainer: secondLine,
    endOffset: 3,
    commonAncestorContainer: textLayer,
    collapsed: false,
  };
  const selected = getSelectedPageTokens(selection, [token], {
    pageRoot,
    minTokens: 1,
    maxTokens: 1,
  });
  assert.deepEqual(selected, [token], "selection crossing the line break resolves to the whole logical word");

  const posted = [];
  const drawn = [];
  const overlay = { draw(rows) { drawn.push(rows); }, clear() {}, dispose() {} };
  const eventBus = { _on() {}, _off() {} };
  const app = {
    pdfViewer: {
      getVisiblePages() { return { views: [{ id: 1 }] }; },
      getPageView() { return { div: pageRoot }; },
    },
  };
  const windowRef = {
    getSelection() { return { rangeCount: 0 }; },
    addEventListener() {},
    removeEventListener() {},
  };
  const controller = new VocabularyController({
    app,
    eventBus,
    documentRef: document,
    windowRef,
    postToHost(type, fields) { posted.push({ type, ...fields }); return true; },
    getIdentity: () => ({ documentId: "doc-1", openRequest: 1 }),
    makeOverlay: () => overlay,
  });
  controller.setDocument("doc-1", 1, true);
  const query = posted.find((message) => message.type === "vocab-page-query");
  assert.deepEqual(query?.tokens, ["comparable"], "the dictionary query receives the stitched lookup key");
  assert.equal(controller.handlePageResults({
    documentId: "doc-1",
    openRequest: 1,
    pageNumber: 1,
    requestId: query.requestId,
    queryId: query.queryId,
    partIndex: query.partIndex,
    wordMatches: [{ index: 0, key: "comparable", storageKey: "comparable", type: "word", status: 5 }],
    phraseMatches: [],
  }), true);
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].length, 1);
  assert.equal(drawn[0][0].token.surfaceKey, "comparable");
  assert.equal(drawn[0][0].token.segments.length, 2,
    "the matched vocabulary mark is attached to both physical line segments");

  class FakeHighlight {
    ranges = [];
    add(range) { this.ranges.push(range); }
  }
  const registry = new Map();
  const renderer = new VocabularyHighlightRenderer(pageRoot, {
    documentRef: document,
    windowRef: { CSS: { highlights: registry }, Highlight: FakeHighlight },
  });
  assert.equal(renderer.draw(drawn[0]), true);
  const [highlight] = registry.values();
  assert.equal(highlight.ranges.length, 2, "the visual highlight contains one Range for each line");
  assert.deepEqual(highlight.ranges.map((range) => [range.start, range.end]), [
    [[firstLine, 0], [firstLine, 6]],
    [[secondLine, 0], [secondLine, 5]],
  ]);
  assert.equal(segmentRects.size, 2);
  renderer.dispose();
  controller.dispose();
});

test("an explicit newline after a PDF line-end hyphen stitches identity and selects the full physical word", () => {
  const unitRects = new Map();
  const segmentRects = new Map();
  const document = makeRangeDocument(unitRects, segmentRects);
  const text = makeText("compa-\nrable", "single-node-wrap", document);
  unitRects.set("single-node-wrap:5", { top: 10, left: 70, width: 5, height: 12 });
  unitRects.set("single-node-wrap:7", { top: 24, left: 4, width: 7, height: 12 });
  segmentRects.set(text, [
    { left: 10, top: 10, right: 74, bottom: 22, width: 64, height: 12 },
    { left: 4, top: 24, right: 38, bottom: 36, width: 34, height: 12 },
  ]);
  const textLayer = makeElement([text], document, "textLayer");
  const pageRoot = makeElement([textLayer], document, "page");
  const [token] = scanPageTextLayer(textLayer);

  assert.equal(token.rawSurface, "compa-rable", "layout newline is not exposed as part of the word");
  assert.equal(token.surfaceKey, "comparable", "lookup joins only after geometry confirms a line break");
  assert.deepEqual(token.segments, [
    { textNode: text, startOffset: 0, endOffset: 12 },
  ], "the physical range still spans the visible hyphen and line separator");

  const selection = {
    startContainer: text,
    startOffset: 2,
    endContainer: text,
    endOffset: 10,
    commonAncestorContainer: textLayer,
    collapsed: false,
  };
  assert.deepEqual(getSelectedPageTokens(selection, [token], {
    pageRoot,
    minTokens: 1,
    maxTokens: 1,
  }), [token], "selection across the explicit line break resolves to one logical word");
});

test("same-line ordinary hyphens stay separate and are not treated as wrapped words", () => {
  const unitRects = new Map();
  const document = makeRangeDocument(unitRects);
  const firstLine = makeText("well-", "well", document);
  const continuation = makeText("known", "known", document);
  unitRects.set("well:4", { top: 10, left: 42, width: 5, height: 12 });
  unitRects.set("known:0", { top: 10, left: 50, width: 6, height: 12 });
  const textLayer = makeElement([
    makeElement([firstLine], document),
    makeElement([continuation], document),
  ], document, "textLayer");

  const tokens = scanPageTextLayer(textLayer);
  assert.deepEqual(tokens.map((token) => token.surfaceKey), ["well", "known"]);
  assert.deepEqual(tokens.map((token) => token.rawSurface), ["well", "known"]);
});
