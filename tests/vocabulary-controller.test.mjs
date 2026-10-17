import assert from "node:assert/strict";
import test from "node:test";

import { VocabularyController } from "../viewer-adapter/vocabulary/controller.js";
import {
  separateOverlappingHighlightRows,
  VocabularyCanvasOverlay,
} from "../viewer-adapter/vocabulary/canvas-overlay.js";

function makeRuntime() {
  const listeners = new Map();
  const pages = new Map();
  const posted = [];
  const overlays = [];
  const identity = { documentId: "doc-1", openRequest: 7 };
  let textNodes = [{}, {}, {}];
  let visiblePageIds = [1];
  let scanCalls = 0;
  let nextFrameId = 0;
  const frameCallbacks = new Map();
  const resizeObservers = [];
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.disconnected = true; this.targets.clear(); }
    trigger(target) { this.callback([{ target }]); }
  }
  const eventBus = {
    _on(name, callback) { listeners.set(name, callback); },
    _off(name, callback) { if (listeners.get(name) === callback) listeners.delete(name); },
  };
  const app = {
    pdfDocument: { numPages: 50 },
    pdfViewer: {
      getPageView(index) { return { div: pages.get(index + 1) || null }; },
      getVisiblePages() { return { views: visiblePageIds.map((id) => ({ id })) }; },
    },
  };
  const windowRef = {
    getSelection: () => ({ rangeCount: 0 }),
    ResizeObserver: FakeResizeObserver,
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frameCallbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frameCallbacks.delete(id); },
    addEventListener() {},
    removeEventListener() {},
  };
  const controller = new VocabularyController({
    app,
    eventBus,
    documentRef: {},
    windowRef,
    postToHost(type, fields) { posted.push({ type, ...fields }); return true; },
    getIdentity: () => ({ ...identity }),
    makeId: () => "id",
    scan: () => {
      scanCalls += 1;
      return [
        { index: 0, rawSurface: "Alpha", surfaceKey: "alpha", segments: [{ textNode: textNodes[0], startOffset: 0, endOffset: 5 }] },
        { index: 1, rawSurface: "beta", surfaceKey: "beta", segments: [{ textNode: textNodes[1], startOffset: 0, endOffset: 4 }] },
        { index: 2, rawSurface: "gamma", surfaceKey: "gamma", segments: [{ textNode: textNodes[2], startOffset: 0, endOffset: 5 }] },
      ];
    },
    selectTokens: (_range, tokens) => tokens.slice(1, 3),
    makeOverlay(pageRoot) {
      const overlay = {
        pageRoot,
        draws: [],
        clearCount: 0,
        disposeCount: 0,
        draw(highlights) { this.draws.push(highlights); },
        clear() { this.clearCount += 1; },
        dispose() { this.disposeCount += 1; },
      };
      overlays.push(overlay);
      return overlay;
    },
  });
  const textLayer = { contains(node) { return textNodes.includes(node); } };
  const pageRoot = {
    querySelector(selector) { return selector === ".textLayer" ? textLayer : null; },
    contains(node) { return node === pageRoot || node?.parent === pageRoot; },
  };
  const pageRoot2 = {
    querySelector(selector) { return selector === ".textLayer" ? {} : null; },
    contains(node) { return node === pageRoot2 || node?.parent === pageRoot2; },
  };
  pages.set(1, pageRoot);
  pages.set(2, pageRoot2);
  return {
    controller, eventBus, listeners, pages, pageRoot, posted, overlays, identity, resizeObservers,
    replaceTextNodes: () => { textNodes = [{}, {}, {}]; },
    setVisiblePageIds: (ids) => { visiblePageIds = ids; },
    flushAnimationFrames() {
      const callbacks = [...frameCallbacks.values()];
      frameCallbacks.clear();
      for (const callback of callbacks) callback();
    },
    triggerPageResize(target) {
      for (const observer of resizeObservers) if (observer.targets.has(target)) observer.trigger(target);
    },
    getScanCalls: () => scanCalls,
  };
}

test("feature-off controller does no page scan or host query", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, false);
  assert.equal(runtime.posted.length, 0);
  assert.equal(runtime.overlays.length, 0);
  assert.equal(runtime.controller.pages.size, 0);
  runtime.controller.dispose();
});

test("only currently visible PDF.js pages are scanned and offscreen resources are released", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  assert.equal(runtime.getScanCalls(), 1);
  runtime.setVisiblePageIds([]);
  runtime.listeners.get("textlayerrendered")({ pageNumber: 2 });
  assert.equal(runtime.getScanCalls(), 1, "offscreen text-layer events do not trigger whole-document scanning");
  runtime.setVisiblePageIds([2]);
  runtime.listeners.get("updateviewarea")();
  runtime.listeners.get("textlayerrendered")({ pageNumber: 2 });
  assert.equal(runtime.getScanCalls(), 3);
  assert.deepEqual([...runtime.controller.pages.keys()], ["2"]);
  assert.equal(runtime.overlays[0].disposeCount, 1, "offscreen page overlay is disposed");
  runtime.controller.dispose();
});

test("visible-page scanning uses the frozen PDF.js _getVisiblePages API when no public getter exists", () => {
  const runtime = makeRuntime();
  const viewer = runtime.controller.app.pdfViewer;
  const getVisiblePages = viewer.getVisiblePages.bind(viewer);
  delete viewer.getVisiblePages;
  viewer._getVisiblePages = getVisiblePages;

  runtime.controller.setDocument("doc-1", 7, true);
  assert.equal(runtime.getScanCalls(), 1);
  assert.equal(runtime.overlays.length, 1, "the visible page gets a vocabulary canvas overlay");
  assert.equal(runtime.posted.length, 1, "the visible page is queried for saved vocabulary records");
  runtime.controller.dispose();
});

test("updateviewarea restores page-scoped scanning when the reader returns to a cached page", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  assert.equal(runtime.posted.length, 1);
  runtime.setVisiblePageIds([2]);
  runtime.listeners.get("updateviewarea")();
  assert.equal(runtime.posted.length, 2);
  assert.deepEqual([...runtime.controller.pages.keys()], ["2"]);
  runtime.setVisiblePageIds([1]);
  runtime.listeners.get("updateviewarea")();
  assert.equal(runtime.posted.length, 3);
  assert.equal(runtime.posted.at(-1).pageNumber, 1);
  assert.deepEqual([...runtime.controller.pages.keys()], ["1"]);
  runtime.controller.dispose();
});

test("PDF scale, page resize and text-layer relayout redraw cached highlights without re-querying", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const query = runtime.posted[0];
  runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 1,
    requestId: query.requestId, queryId: query.queryId, partIndex: query.partIndex,
    records: [{ key: "alpha", type: "word", status: 5 }],
  });
  const overlay = runtime.overlays[0];
  assert.equal(overlay.draws.length, 1);
  assert.equal(runtime.resizeObservers[0].targets.size, 2,
    "the visible page and its text layer are both observed for layout changes");

  runtime.listeners.get("scalechanging")({ scale: 1.25 });
  assert.equal(overlay.draws.length, 1, "redraws are coalesced to the next animation frame");
  runtime.flushAnimationFrames();
  assert.equal(overlay.draws.length, 2, "zoom remeasures the current PDF.js text ranges");

  runtime.triggerPageResize(runtime.pageRoot);
  runtime.flushAnimationFrames();
  assert.equal(overlay.draws.length, 3, "page-size changes redraw the cached marks");

  runtime.listeners.get("textlayerrendered")({ pageNumber: 1 });
  runtime.flushAnimationFrames();
  assert.equal(overlay.draws.length, 4,
    "same-node text-layer reflow updates geometry instead of retaining stale canvas pixels");
  assert.equal(runtime.getScanCalls(), 1, "scale and same-node text-layer reflow do not rescan lexical tokens");
  assert.equal(runtime.posted.length, 1, "layout redraws do not query the vocabulary host again");

  runtime.controller.dispose();
  assert.equal(runtime.resizeObservers[0].disconnected, true);
  assert.equal(runtime.listeners.has("scalechanging"), false);
});

test("host refresh re-queries unchanged visible pages after an import or durable selection", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const before = runtime.posted.length;
  assert.equal(runtime.controller.refreshPageFromHost({ documentId: "doc-1", openRequest: 7 }), true);
  assert.equal(runtime.getScanCalls(), 1, "cached physical token ranges are reused without wrapping or rewriting");
  assert.equal(runtime.posted.length, before + 1, "the host receives a fresh query even when TextNode segments are unchanged");
  assert.notEqual(runtime.posted.at(-1).queryId, runtime.posted[0].queryId);
  assert.equal(runtime.controller.refreshPageFromHost({ documentId: "stale", openRequest: 7 }), false);
  runtime.controller.dispose();
});

test("enabled controller queries only visible/rendered pages and phrase results draw on the existing page overlay", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  assert.equal(runtime.posted.length, 1);
  assert.deepEqual(runtime.posted[0].tokens, ["alpha", "beta", "gamma"]);
  assert.equal(runtime.posted[0].keys, undefined, "the reader no longer materializes page n-gram query strings");
  assert.equal(runtime.posted[0].pageNumber, 1);
  assert.equal(runtime.controller.pages.size, 1, "a 50-page document did not trigger whole-document scanning");
  assert.equal(runtime.overlays.length, 1);

  const query = runtime.posted[0];
  assert.equal(runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 1,
    requestId: query.requestId, queryId: query.queryId, partIndex: query.partIndex,
    records: [
      { key: "alpha", type: "word", status: 1 },
      { key: "beta gamma", type: "phrase", status: 3 },
      { key: "gamma", type: "word", status: 5 },
    ],
  }), true);
  assert.deepEqual(runtime.overlays[0].draws[0].map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 1], ["beta", 3], ["gamma", 3],
  ]);

  const oldRequest = query.requestId;
  runtime.listeners.get("pagerendered")({ pageNumber: 1 });
  return Promise.resolve().then(() => {
    assert.equal(runtime.posted.length, 1, "canvas rerenders reuse page-local results without querying again");
    runtime.replaceTextNodes();
    runtime.listeners.get("textlayerrendered")({ pageNumber: 1 });
    assert.equal(runtime.getScanCalls(), 2, "a true PDF.js TextNode replacement refreshes the physical token map");
    assert.equal(runtime.posted.length, 1, "same vocabulary keys reuse results after PDF.js replaces physical TextNodes");
    assert.ok(runtime.overlays[0].draws.length >= 2, "cached records are rebound to the replacement text layer");
    assert.deepEqual(runtime.overlays[0].draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [
      ["alpha", 1], ["beta", 3], ["gamma", 3],
    ]);
    assert.equal(runtime.controller.handlePageResults({
      documentId: "doc-1", openRequest: 7, pageNumber: 1,
      requestId: oldRequest, queryId: query.queryId, partIndex: query.partIndex, records: [],
    }), false, "a page reply from a retired query generation is ignored");
    runtime.controller.dispose();
    assert.equal(runtime.overlays[0].disposeCount, 1);
    assert.equal(runtime.listeners.size, 0);
  });
});

test("page token response caches lexical ranges so zoom only redraws geometry", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const query = runtime.posted[0];
  assert.deepEqual(query.tokens, ["alpha", "beta", "gamma"]);
  assert.equal(query.keys, undefined);
  let phraseMatchCalls = 0;
  runtime.controller.phraseMatcher = () => { phraseMatchCalls += 1; return []; };
  assert.equal(runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 1,
    requestId: query.requestId, queryId: query.queryId, partIndex: query.partIndex,
    wordMatches: [
      { index: 0, key: "alpha", storageKey: "alpha", type: "word", status: 4 },
    ],
    phraseMatches: [
      { startIndex: 1, endIndex: 3, key: "beta gamma", storageKey: "beta gamma", type: "phrase", status: 3 },
    ],
    metrics: { indexBuildMs: 4, matchMs: 2, trieSteps: 3 },
  }), true);
  const page = runtime.controller.pages.get("1");
  assert.equal(page.queryMetrics.viewerTokenCount, 3);
  assert.ok(page.queryMetrics.textLayerScanMs >= 0);
  assert.ok(page.queryMetrics.hostRoundTripMs >= 0);
  const overlay = runtime.overlays[0];
  assert.deepEqual(overlay.draws[0].map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 4], ["beta", 3], ["gamma", 3],
  ]);
  assert.equal(phraseMatchCalls, 0, "host-provided token ranges avoid rebuilding a phrase matcher in the viewer");

  runtime.listeners.get("scalechanging")({ scale: 1.25 });
  runtime.flushAnimationFrames();
  assert.equal(overlay.draws.length, 2);
  assert.equal(phraseMatchCalls, 0, "zoom uses cached lexical ranges and only remeasures/draws geometry");
  assert.equal(runtime.posted.length, 1, "zoom does not re-query the host");
  assert.equal(page.renderMetrics.highlightedTokenCount, 3);
  assert.ok(page.renderMetrics.overlayGeometryAndPaintMs >= 0);
  runtime.controller.dispose();
});

test("compact lexical result cache is bounded to nine recently visited pages", () => {
  const runtime = makeRuntime();
  const textLayer = runtime.pageRoot.querySelector(".textLayer");
  for (let pageNumber = 3; pageNumber <= 10; pageNumber += 1) {
    runtime.pages.set(pageNumber, {
      querySelector(selector) { return selector === ".textLayer" ? textLayer : null; },
      contains(node) { return node === this || node?.parent === this; },
    });
  }
  runtime.controller.setDocument("doc-1", 7, true);
  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    runtime.setVisiblePageIds([pageNumber]);
    if (pageNumber > 1) runtime.listeners.get("updateviewarea")();
    const query = runtime.posted.at(-1);
    assert.equal(query.pageNumber, pageNumber);
    assert.equal(runtime.controller.handlePageResults({
      documentId: "doc-1", openRequest: 7, pageNumber,
      requestId: query.requestId, queryId: query.queryId, partIndex: query.partIndex,
      wordMatches: [], phraseMatches: [], metrics: {},
    }), true);
  }
  assert.equal(runtime.controller.pageResultCache.size, 9);
  assert.equal(runtime.controller.pageResultCache.has(1), false, "the least recently visited page was evicted");
  assert.deepEqual([...runtime.controller.pages.keys()], ["10"], "live geometry remains limited to visible pages");
  runtime.controller.dispose();
});

test("known words and phrases (status 5) are included in the vocabulary highlight overlay", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const query = runtime.posted[0];
  assert.equal(runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 1,
    requestId: query.requestId, queryId: query.queryId, partIndex: query.partIndex,
    records: [
      { key: "gamma", type: "word", status: 5 },
      { key: "alpha beta", type: "phrase", status: 5 },
    ],
  }), true);
  assert.deepEqual(runtime.overlays[0].draws[0].map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 5], ["beta", 5], ["gamma", 5],
  ]);
  runtime.controller.dispose();
});

test("word highlights share conservative lemma matches while preserving exact lay precedence", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const page = runtime.controller.pages.get("1");
  page.tokens = ["run", "runs", "ran", "running", "lay", "lays", "laid", "laying", "lying"]
    .map((surfaceKey, index) => ({
      ...page.tokens[index % 3], index, surfaceKey,
      rawSurface: surfaceKey,
    }));
  const records = [
    { key: "run", storageKey: "run", type: "word", status: 2 },
    { key: "lie", storageKey: "lie", type: "word", status: 3 },
    { key: "lay", storageKey: "lay", type: "word", status: 1 },
  ];
  runtime.controller.renderPageResults(page, records);
  assert.deepEqual(runtime.overlays[0].draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [
    ["run", 2], ["runs", 2], ["ran", 2], ["running", 2],
    ["lay", 1], ["lays", 1], ["laid", 1], ["laying", 1], ["lying", 3],
  ]);

  runtime.controller.renderPageResults(page, records.slice(0, 2));
  assert.deepEqual(runtime.overlays.at(0).draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]).slice(4), [
    ["lay", 3], ["lying", 3],
  ], "bare lay uses the sole lie candidate only when no exact lay row exists");
  runtime.controller.dispose();
});

test("LingQ display modes redraw cached records without rescanning or requerying pages", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const query = runtime.posted[0];
  runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 1,
    requestId: query.requestId, queryId: query.queryId, partIndex: query.partIndex,
    records: [
      { key: "alpha", type: "word", status: 1 },
      { key: "beta", type: "word", status: 4 },
      { key: "gamma", type: "word", status: 5 },
      { key: "alpha beta", type: "phrase", status: 4 },
      { key: "beta gamma", type: "phrase", status: 5 },
    ],
  });
  assert.deepEqual(runtime.overlays[0].draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 4], ["beta", 4], ["gamma", 5],
  ]);
  const scans = runtime.getScanCalls();
  runtime.controller.setDisplayMode("learning");
  assert.deepEqual(runtime.overlays[0].draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 4], ["beta", 4],
  ], "learning mode hides level-5 entries and phrases while retaining levels 1–4");
  runtime.controller.setDisplayMode("focus");
  assert.deepEqual(runtime.overlays[0].draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 1],
  ], "focus mode keeps only levels 1–3");
  assert.equal(runtime.getScanCalls(), scans);
  assert.equal(runtime.posted.length, 1, "mode changes reuse cached page records");
  runtime.controller.dispose();
});

test("word and phrase highlight levels are independently configurable and update existing overlays immediately", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const query = runtime.posted[0];
  runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 1,
    requestId: query.requestId, queryId: query.queryId, partIndex: query.partIndex,
    records: [
      { key: "alpha", type: "word", status: 1 },
      { key: "gamma", type: "word", status: 5 },
      { key: "alpha beta", type: "phrase", status: 2 },
      { key: "beta gamma", type: "phrase", status: 5 },
    ],
  });
  assert.deepEqual(runtime.overlays[0].draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 2], ["beta", 2], ["gamma", 5],
  ]);

  runtime.controller.setHighlightLevels({ words: [5], phrases: [2] });
  assert.deepEqual(runtime.overlays[0].draws.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [
    ["alpha", 2], ["beta", 2], ["gamma", 5],
  ], "changing preferences redraws cached results without another host query");
  assert.equal(runtime.posted.length, 1);

  runtime.controller.setHighlightLevels({ words: [], phrases: [] });
  assert.deepEqual(runtime.overlays[0].draws.at(-1), [], "both categories can be disabled independently of stored vocabulary");
  runtime.controller.dispose();
});

test("selection request returns physical surfaces and logical keys through the existing bridge callback", () => {
  const runtime = makeRuntime();
  const boundary = { parent: runtime.pageRoot };
  const range = { startContainer: boundary, endContainer: boundary };
  runtime.controller.window.getSelection = () => ({ rangeCount: 1, getRangeAt: () => range });
  runtime.controller.setDocument("doc-1", 7, true);
  assert.equal(runtime.controller.handleSelectionRequest({
    requestId: "selection-1", documentId: "doc-1", openRequest: 7,
  }), true);
  const message = runtime.posted.at(-1);
  assert.equal(message.type, "vocab-selection");
  assert.equal(message.entryType, "phrase");
  assert.deepEqual(message.tokens.map((token) => token.surfaceKey), ["beta", "gamma"]);
  assert.equal(message.rendererGeneration, undefined, "the bridge’s shared postToHost adds renderer identity");
  runtime.controller.dispose();
});

test("legacy WebView fallback paints text-sized translucent rectangles and removes its canvas", () => {
  const drawn = [];
  const context = {
    setTransform() {}, clearRect() {},
    fillStyle: "",
    fillRect(...args) { drawn.push({ args, color: this.fillStyle }); },
  };
  const documentRef = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        width: 0, height: 0, style: {}, parentNode: null,
        setAttribute(name, value) { this[name] = value; },
        getContext() { return context; },
        remove() { this.parentNode?.removeChild(this); },
      };
    },
    createRange() {
      return {
        setStart() {}, setEnd() {}, detach() {},
        getClientRects() { return [{ left: 15, top: 25, right: 40, bottom: 36, width: 25, height: 11 }]; },
      };
    },
  };
  const pageRoot = {
    ownerDocument: documentRef,
    children: [],
    appendChild(node) { node.parentNode = this; this.children.push(node); },
    removeChild(node) { this.children = this.children.filter((child) => child !== node); node.parentNode = null; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 200, height: 300 }; },
  };
  const overlay = new VocabularyCanvasOverlay(pageRoot, { documentRef });
  assert.equal(pageRoot.children.length, 1);
  assert.equal(overlay.canvas["aria-hidden"], "true");
  assert.equal(overlay.canvas.style.pointerEvents, "none");
  overlay.draw([
    { token: { segments: [{ textNode: {}, startOffset: 0, endOffset: 3 }] }, status: 2 },
    { token: { segments: [{ textNode: {}, startOffset: 0, endOffset: 3 }] }, status: 5 },
  ]);
  assert.deepEqual(drawn, [
    { args: [5, 5, 25, 11], color: "rgba(202, 138, 4, 0.22)" },
    { args: [5, 5, 25, 11], color: "rgba(124, 58, 237, 0.18)" },
  ]);
  overlay.dispose();
  assert.equal(pageRoot.children.length, 0);
});

test("canvas highlight geometry separates compact text rows without shrinking same-line marks", () => {
  const rects = [
    { x: 40, y: 10, width: 12, height: 14, color: "top" },
    { x: 10, y: 11.5, width: 18, height: 14, color: "top" },
    { x: 12, y: 22, width: 20, height: 14, color: "bottom" },
  ];
  const result = separateOverlappingHighlightRows(rects);
  const topRow = result.filter(({ color }) => color === "top");
  const bottom = result.find(({ color }) => color === "bottom");
  assert.equal(topRow.length, 2, "fragments with nearby text-row centers stay grouped");
  assert.ok(topRow.every(({ height }) => Math.abs(height - 10.25) < 0.01),
    "the compact upper row fits inside the measured center-to-center pitch");
  assert.ok(topRow.every(({ y }) => Math.abs(y - 12.625) < 0.01),
    "same-line fragments remain centered on their measured text row");
  assert.ok(Math.abs(bottom.height - 10.25) < 0.01,
    "the lower compact row also fits its available line band");
  assert.ok(Math.abs(bottom.y - 23.875) < 0.01,
    "the lower mark stays centered on its own text row");
  assert.ok(topRow.every(({ y, height }) => y + height <= bottom.y - 1),
    "the upper row does not overlap the next row");

  for (const pitch of [8, 10]) {
    const tightRows = separateOverlappingHighlightRows([
      { x: 0, y: 100, width: 24, height: 14, color: "upper" },
      { x: 0, y: 100 + pitch, width: 24, height: 14, color: "lower" },
    ]);
    const [upper, lower] = tightRows;
    const expectedHeight = pitch - 1;
    assert.equal(upper.height, expectedHeight,
      `${pitch}px line pitch uses the maximum available highlight height`);
    assert.equal(upper.y, 107 - expectedHeight / 2,
      `${pitch}px line pitch keeps the highlight centered on the glyph row`);
    assert.equal(lower.height, expectedHeight,
      `${pitch}px line pitch uses the same maximum height on both rows`);
    assert.equal(lower.y, 107 + pitch - expectedHeight / 2,
      "both lines are centered in their separated line bands");
    assert.equal(upper.y + upper.height, lower.y - 1,
      "adjacent compact marks keep a full CSS-pixel separation");
    if (expectedHeight < 14 * 2 / 3) {
      assert.ok(upper.height >= expectedHeight,
        "when physical line pitch is the limit, paint the full usable height");
    }
  }

  const ordinary = separateOverlappingHighlightRows([
    { x: 0, y: 10, width: 10, height: 11 },
    { x: 0, y: 23, width: 10, height: 11 },
  ]);
  assert.deepEqual(ordinary.map(({ height }) => height), [11, 11],
    "non-overlapping rows are left untouched");

  const mixedFontRows = separateOverlappingHighlightRows([
    { x: 0, y: 50, width: 20, height: 14, color: "upper" },
    { x: 24, y: 46, width: 18, height: 22, color: "upper" },
    { x: 0, y: 61, width: 20, height: 14, color: "lower" },
  ]);
  const mixedUpper = mixedFontRows.filter(({ color }) => color === "upper");
  const mixedLower = mixedFontRows.find(({ color }) => color === "lower");
  assert.equal(mixedUpper.length, 2, "different font sizes sharing a baseline remain one visual row");
  assert.ok(mixedUpper.every(({ y, height }) => Math.abs(y + height / 2 - 57) < 0.01),
    "mixed-size fragments are centered on the actual upper text row, not its top edge");
  assert.ok(mixedUpper.every(({ y, height }) => y + height <= mixedLower.y),
    "mixed-size row clipping still prevents overlap with the next line");
});

test("modern renderer uses CSS Custom Highlights attached to PDF.js text ranges", () => {
  class FakeHighlight {
    ranges = [];
    add(range) { this.ranges.push(range); }
  }
  const registry = new Map();
  const styles = [];
  const documentRef = {
    head: { appendChild(node) { styles.push(node); node.parentNode = this; } },
    createElement(tag) {
      assert.equal(tag, "style");
      return { dataset: {}, textContent: "", remove() { this.removed = true; } };
    },
    createRange() {
      return { setStart(node, offset) { this.start = [node, offset]; }, setEnd(node, offset) { this.end = [node, offset]; } };
    },
  };
  const pageRoot = { ownerDocument: documentRef, appendChild() {} };
  const renderer = new VocabularyCanvasOverlay(pageRoot, {
    documentRef,
    windowRef: { CSS: { highlights: registry }, Highlight: FakeHighlight },
  });
  const node = {};
  assert.equal(renderer.customHighlights, true);
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /::highlight\(pdfReaderVocabulary\d+Status5\)/);
  renderer.draw([{ token: { segments: [{ textNode: node, startOffset: 2, endOffset: 7 }] }, status: 5 }]);
  assert.equal(registry.size, 1);
  const [name, highlight] = [...registry.entries()][0];
  assert.match(name, /Status5$/);
  assert.equal(highlight.ranges.length, 1);
  assert.deepEqual(highlight.ranges[0].start, [node, 2]);
  renderer.clear();
  assert.equal(registry.size, 0);
  renderer.dispose();
  assert.equal(styles[0].removed, true);
});

test("modern renderer switches only overlapping matched rows to page-local canvas geometry", () => {
  class FakeHighlight { add() {} }
  const registry = new Map();
  const fills = [];
  const rects = new Map();
  const context = {
    setTransform() {}, clearRect() {}, fillStyle: "",
    fillRect(x, y, width, height) { fills.push({ x, y, width, height, color: this.fillStyle }); },
  };
  const documentRef = {
    head: { appendChild(node) { node.parentNode = this; } },
    createElement(tag) {
      if (tag === "style") return { dataset: {}, textContent: "", remove() {} };
      return {
        width: 0, height: 0, style: {}, setAttribute() {}, getContext: () => context,
        remove() { this.parentNode?.removeChild(this); },
      };
    },
    createRange() {
      let node;
      return {
        setStart(textNode) { node = textNode; }, setEnd() {}, detach() {},
        getClientRects() { return rects.get(node) || []; },
      };
    },
  };
  const pageRoot = {
    ownerDocument: documentRef, children: [], clientLeft: 9, clientTop: 7,
    appendChild(node) { node.parentNode = this; this.children.push(node); },
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; },
    getBoundingClientRect() { return { left: 10, top: 20, width: 100, height: 100 }; },
  };
  const upper = {};
  const lower = {};
  rects.set(upper, [{ left: 12, top: 30, width: 20, height: 14 }]);
  rects.set(lower, [{ left: 12, top: 42, width: 20, height: 14 }]);
  const renderer = new VocabularyCanvasOverlay(pageRoot, {
    documentRef, windowRef: { CSS: { highlights: registry }, Highlight: FakeHighlight },
  });

  renderer.draw([
    { token: { segments: [{ textNode: upper, startOffset: 0, endOffset: 1 }] }, status: 1 },
    { token: { segments: [{ textNode: lower, startOffset: 0, endOffset: 1 }] }, status: 2 },
  ]);
  assert.equal(registry.size, 0, "unclipped CSS marks are removed when the adjusted local paint path is active");
  assert.equal(pageRoot.children.length, 1, "the canvas is scoped to this rendered PDF page");
  assert.equal(renderer.canvas.style.left, "-9px", "paint origin compensates the PDF page border");
  assert.equal(renderer.canvas.style.top, "-7px", "paint origin compensates the PDF page top border");
  assert.deepEqual(fills.map(({ y, height }) => [y, height]), [[11.5, 11], [23.5, 11]]);

  const pageCanvas = renderer.canvas;
  pageRoot.removeChild(pageCanvas);
  assert.equal(pageCanvas.parentNode, null, "PDF.js page-layer replacement can detach the overlay");
  renderer.draw([
    { token: { segments: [{ textNode: upper, startOffset: 0, endOffset: 1 }] }, status: 1 },
    { token: { segments: [{ textNode: lower, startOffset: 0, endOffset: 1 }] }, status: 2 },
  ]);
  assert.equal(renderer.canvas, pageCanvas, "the renderer reuses its page-local canvas");
  assert.equal(pageCanvas.parentNode, pageRoot, "a geometry redraw reattaches the detached canvas");
  assert.equal(pageRoot.children.length, 1);

  rects.set(upper, [{ left: 12, top: 30, width: 20, height: 10 }]);
  rects.set(lower, [{ left: 12, top: 43, width: 20, height: 10 }]);
  renderer.draw([
    { token: { segments: [{ textNode: upper, startOffset: 0, endOffset: 1 }] }, status: 1 },
    { token: { segments: [{ textNode: lower, startOffset: 0, endOffset: 1 }] }, status: 2 },
  ]);
  assert.equal(registry.size, 2, "ordinary non-overlapping rows stay on the browser text-rendering path");
  renderer.dispose();
  assert.equal(pageRoot.children.length, 0);
});

test("scrolling keeps visible highlights stable and reuses completed results when returning to a page", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const firstQuery = runtime.posted[0];
  const firstOverlay = runtime.overlays[0];
  const initialClearCount = firstOverlay.clearCount;

  for (let index = 0; index < 5; index += 1) runtime.listeners.get("updateviewarea")();
  assert.equal(runtime.posted.length, 1, "unchanged scroll frames do not re-query the host");
  assert.equal(firstOverlay.clearCount, initialClearCount, "scroll frames do not clear a painted overlay");
  runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 1,
    requestId: firstQuery.requestId, queryId: firstQuery.queryId, partIndex: firstQuery.partIndex,
    records: [{ key: "alpha", type: "word", status: 5 }],
  });
  assert.equal(firstOverlay.draws.length, 1);

  runtime.setVisiblePageIds([2]);
  runtime.listeners.get("updateviewarea")();
  const secondQuery = runtime.posted[1];
  runtime.controller.handlePageResults({
    documentId: "doc-1", openRequest: 7, pageNumber: 2,
    requestId: secondQuery.requestId, queryId: secondQuery.queryId, partIndex: secondQuery.partIndex,
    records: [],
  });
  runtime.setVisiblePageIds([1]);
  runtime.listeners.get("updateviewarea")();
  assert.equal(runtime.posted.length, 2, "a completed page result is restored from the bounded cache");
  const returnedPageOverlay = runtime.overlays.at(-1);
  assert.equal(returnedPageOverlay.draws.length, 1);
  assert.deepEqual(returnedPageOverlay.draws[0].map(({ token, status }) => [token.surfaceKey, status]), [["alpha", 5]]);
  runtime.controller.dispose();
});

test("eligible collapsed single-word click opens a local pill and durable status ACK updates the overlay", () => {
  const posted = [];
  const body = { children: [], appendChild(node) { node.parentNode = this; this.children.push(node); } };
  const documentRef = {
    body,
    createElement(tag) {
      return {
        tagName: tag, style: {}, dataset: {}, className: "", children: [], attributes: {}, listeners: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        append(...nodes) { for (const node of nodes) this.appendChild(node); },
        appendChild(node) { node.parentNode = this; this.children.push(node); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; },
        classList: { toggle() {} },
      };
    },
    createRange() {
      return {
        setStart(node, start) { this.node = node; this.start = start; },
        setEnd(node, end) { this.end = end; },
        getClientRects() { return this.node === textNode ? [{ left: 10, right: 80, top: 20, bottom: 40 }] : []; },
        detach() {},
      };
    },
  };
  const textNode = { data: "Alpha", length: 5, parentNode: null };
  const textLayer = { contains: (node) => node === textNode };
  const pageRoot = {
    children: [],
    querySelector: (selector) => selector === ".textLayer" ? textLayer : null,
    contains: (node) => node === pageRoot || node === textLayer || node === textNode,
    appendChild(node) { node.parentNode = this; this.children.push(node); },
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; },
  };
  const overlay = { drawn: [], draw(rows) { this.drawn.push(rows); }, clear() {}, dispose() {} };
  const app = { pdfViewer: {
    getPageView: () => ({ div: pageRoot }),
    getVisiblePages: () => ({ views: [{ id: 1 }] }),
  } };
  const selection = { isCollapsed: true, rangeCount: 0 };
  const controller = new VocabularyController({
    app, documentRef, windowRef: { innerWidth: 800, innerHeight: 600, getSelection: () => selection },
    postToHost(type, fields) { posted.push({ type, ...fields }); return true; },
    getIdentity: () => ({ documentId: "doc-1", openRequest: 7 }),
    makeId: () => "tap-id",
    scan: () => [{ index: 0, rawSurface: "Alpha", surfaceKey: "alpha", segments: [{ textNode, startOffset: 0, endOffset: 5 }] }],
    makeOverlay: () => overlay,
  });
  controller.setDocument("doc-1", 7, true);
  assert.equal(controller.handleTap({ type: "click", targetRole: "text-layer", button: 0, detail: 1,
    pageIndex: 0, clientPoint: { x: 30, y: 30 } }), true,
  "a collapsed click on an ordinary word can open lookup so it can be added to the local vocabulary");
  const unrecordedTap = posted.find((message) => message.type === "vocab-token-tap");
  assert.ok(unrecordedTap);
  assert.equal(controller.handleEntryResult({ requestId: unrecordedTap.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7, record: null }), true);
  assert.equal(controller.entryPill.statusElement.textContent, "未收录");
  assert.equal(controller.entryPill.meanings.textContent, "未录入释义");
  controller.dismissEntryPill();
  controller.pages.get("1").records = [
    { key: "alpha", storageKey: "alpha", type: "word", status: 2 },
    { key: "alphas", storageKey: "alpha", type: "word", status: 2 },
  ];
  assert.equal(controller.handleTap({ type: "click", targetRole: "text-layer", button: 0, detail: 1,
    pageIndex: 0, clientPoint: { x: 30, y: 30 } }), true);
  const tap = posted.filter((message) => message.type === "vocab-token-tap").at(-1);
  assert.equal(tap.key, "alpha");
  assert.equal(tap.entryType, "word");
  assert.equal(body.children.length, 1);
  assert.deepEqual(controller.entryPill.buttons.map((button) => button.textContent), ["1", "2", "3", "4", "✓"]);
  assert.equal(controller.handleEntryResult({ requestId: tap.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7,
    record: {
      key: "alpha", storageKey: "alpha", type: "word", status: 2,
      translation: "n. 细节, 详情\nvt. 详述, 选派\nvi. 画详图\n[计] 详细数据",
      note: "local note", phonetic: "/ˈælfə/",
    } }), true);
  assert.equal(controller.entryPill.meanings.textContent,
    "n. 细节, 详情\nvt. 详述, 选派\nvi. 画详图\n[计] 详细数据",
    "the lookup pill keeps each part-of-speech definition on its own line");
  assert.equal(controller.entryPill.pronunciation.textContent, "/ˈælfə/");
  assert.equal(controller.entryPill.meanings.textContent.includes("local note"), false);
  assert.equal(controller.requestStatusChange(3), true);
  const update = posted.find((message) => message.type === "vocab-set-status");
  assert.equal(update.status, 3);
  assert.equal(update.key, "alpha", "the operation keeps the queried surface as its request key");
  assert.equal(update.storageKey, "alpha", "the canonical key is separately supplied for the durable row");
  assert.equal(controller.handleStatusAck({ durable: false, requestId: update.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7, record: { key: "alpha", type: "word", status: 3 } }), false,
  "viewer state never changes before the explicit durable ACK");
  assert.equal(controller.handleStatusAck({ durable: true, requestId: update.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7, record: { key: "run", storageKey: "run", type: "word", status: 3 } }), false,
  "an ACK for a canonical key cannot be mistaken for the queried-surface request");
  assert.equal(controller.handleStatusAck({ durable: true, requestId: update.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7, record: { key: "alpha", storageKey: "alpha", type: "word", status: 3 } }), true);
  assert.equal(controller.entryPill.status, 3);
  assert.deepEqual(overlay.drawn.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [["alpha", 3]]);
  assert.deepEqual(controller.pages.get("1").records.map(({ key, status, storageKey }) => [key, status, storageKey]), [
    ["alpha", 3, "alpha"], ["alphas", 3, "alpha"],
  ], "a durable status ACK updates every query alias of the same canonical vocabulary row");
  selection.isCollapsed = false;
  assert.equal(controller.handleTap({ type: "click", targetRole: "text-layer", button: 0, detail: 1,
    pageIndex: 0, clientPoint: { x: 30, y: 30 } }), false, "existing text selection keeps priority over the popup");
  controller.dispose();
  assert.equal(body.children.length, 0, "session teardown removes the viewer popup");
});

test("LingQ lookup accepts unhighlighted words, while an enabled multiword phrase keeps priority", () => {
  const runtime = makeRuntime();
  runtime.controller.setHighlightLevels({ words: [1, 2, 3, 4], phrases: [2] });
  runtime.controller.setDocument("doc-1", 7, true);
  const page = runtime.controller.pages.get("1");
  page.records = [
    { key: "alpha", type: "word", status: 5 },
    { key: "beta gamma", type: "phrase", status: 2 },
  ];
  assert.deepEqual(runtime.controller.entryForTappedToken(page, page.tokens[0]), {
    type: "word", surfaceKey: "alpha", rawSurface: "Alpha",
  }, "words remain available for lookup even when their stored level is not highlighted");
  const phrase = runtime.controller.entryForTappedToken(page, page.tokens[1]);
  assert.deepEqual(phrase, { type: "phrase", surfaceKey: "beta gamma", rawSurface: "beta gamma" });
  runtime.controller.setHighlightLevels({ words: [1, 2, 3, 4], phrases: [1, 3, 4, 5] });
  assert.deepEqual(runtime.controller.entryForTappedToken(page, page.tokens[2]), {
    type: "word", surfaceKey: "gamma", rawSurface: "gamma",
  }, "a phrase outside configured highlight levels falls back to the tapped word");
  runtime.controller.setHighlightLevels({ words: [5], phrases: [2] });
  assert.deepEqual(runtime.controller.entryForTappedToken(page, page.tokens[0]), {
    type: "word", surfaceKey: "alpha", rawSurface: "Alpha",
  });
  runtime.controller.dispose();
});
