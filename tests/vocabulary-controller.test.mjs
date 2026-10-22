import assert from "node:assert/strict";
import test from "node:test";

import { VocabularyController } from "../viewer-adapter/vocabulary/controller.js";
import {
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

function makeContextPillRuntime() {
  const posted = [];
  const body = {
    children: [],
    appendChild(node) { node.parentNode = this; this.children.push(node); },
  };
  const documentRef = {
    body,
    createElement(tagName) {
      return {
        tagName,
        style: {},
        dataset: {},
        className: "",
        children: [],
        attributes: {},
        listeners: {},
        hidden: false,
        disabled: false,
        readOnly: false,
        value: "",
        setAttribute(name, value) { this.attributes[name] = String(value); },
        append(...nodes) { for (const node of nodes) this.appendChild(node); },
        appendChild(node) { node.parentNode = this; this.children.push(node); },
        addEventListener(type, listener) { this.listeners[type] = listener; },
        click() { this.listeners.click?.({ stopPropagation() {} }); },
        remove() {
          const index = this.parentNode?.children.indexOf(this) ?? -1;
          if (index >= 0) this.parentNode.children.splice(index, 1);
          this.parentNode = null;
        },
        classList: { toggle() {} },
      };
    },
  };
  const textNode = { data: "walking", nodeValue: "walking", length: 7, nodeType: 3 };
  const textLayer = { contains: (node) => node === textNode };
  const pageRoot = {
    querySelector: (selector) => selector === ".textLayer" ? textLayer : null,
    contains: (node) => node === pageRoot || node === textLayer || node === textNode,
  };
  let identity = { documentId: "doc-context", openRequest: 31 };
  const overlay = { draw() {}, clear() {}, dispose() {} };
  const app = { pdfViewer: {
    getPageView: () => ({ div: pageRoot }),
    getVisiblePages: () => ({ views: [{ id: 1 }] }),
  } };
  const controller = new VocabularyController({
    app,
    documentRef,
    windowRef: { innerWidth: 800, innerHeight: 600, addEventListener() {}, removeEventListener() {} },
    postToHost(type, fields) { posted.push({ type, ...fields }); return true; },
    getIdentity: () => ({ ...identity }),
    makeId: () => "context-test",
    scan: () => [{ index: 0, rawSurface: "walking", logicalSurface: "walking", surfaceKey: "walking",
      segments: [{ textNode, startOffset: 0, endOffset: 7 }] }],
    makeOverlay: () => overlay,
  });
  controller.setDocument(identity.documentId, identity.openRequest, true);
  const openPill = () => {
    assert.equal(controller.showEntryPill({
      page: controller.pages.get("1"),
      entry: { type: "word", startIndex: 0, endIndex: 1,
        surfaceKey: "walking", rawSurface: "walk-\ning", logicalSurface: "walking" },
      requestId: `entry-${posted.length}`,
      x: 30,
      y: 30,
    }), true);
    return controller.entryPill;
  };
  return {
    body,
    controller,
    identity,
    posted,
    documentRef,
    openPill,
    setIdentity(next) { identity = next; },
  };
}

test("Context sentence selection preserves only the current pill page and session", () => {
  const runtime = makeContextPillRuntime();
  const pill = runtime.openPill();
  const page = pill.page;
  const node = page.tokens[0].segments[0].textNode;
  const range = { collapsed: false, startContainer: node, endContainer: node };
  const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range };
  runtime.controller.window.getSelection = () => selection;
  const intent = { type: "click", targetRole: "text-layer", pageIndex: 0, button: 0 };
  assert.equal(runtime.controller.shouldPreserveEntryPillForSelection(intent), true);
  assert.equal(runtime.controller.entryPill, pill);
  for (const invalid of [ { pageIndex: 1 }, { nativeActivationTarget: true },
    { nativeContextTarget: true }, { targetRole: "toolbar" }, { button: 2 } ]) {
    assert.equal(runtime.controller.shouldPreserveEntryPillForSelection({ ...intent, ...invalid }), false);
  }
  range.endContainer = {};
  assert.equal(runtime.controller.shouldPreserveEntryPillForSelection(intent), false, "cross-page selection is not retained");
  range.endContainer = node;
  selection.isCollapsed = true;
  assert.equal(runtime.controller.shouldPreserveEntryPillForSelection(intent), false);
  selection.isCollapsed = false;
  runtime.setIdentity({ documentId: "doc-context", openRequest: 32 });
  assert.equal(runtime.controller.shouldPreserveEntryPillForSelection(intent), false, "old session cannot retain a pill");
  assert.equal(runtime.posted.filter(row => row.type === "reader-vocabulary-context-save-request").length, 0,
    "retaining selection never writes Context; explicit confirmation is still required");
  runtime.controller.dispose();
});

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

test("bounded changed-key invalidation reuses visible tokens and preserves unrelated lexical cache", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const identity = { documentId: "doc-1", openRequest: 7 };
  runtime.controller.pageResultCache.set(1, { signature: "alpha\u001fbeta\u001fgamma" });
  runtime.controller.pageResultCache.set(2, { signature: "walking\u001fthe\u001fdog" });
  runtime.controller.pageResultCache.set(3, { signature: "unrelated\u001fpage" });
  const before = runtime.posted.length;
  assert.equal(runtime.controller.refreshPageFromHost({ ...identity, changedKeys: ["beta"] }), true);
  assert.equal(runtime.posted.length, before + 1);
  assert.equal(runtime.controller.pageResultCache.has(1), false);
  assert.equal(runtime.controller.pageResultCache.has(2), true);
  assert.equal(runtime.controller.pageResultCache.has(3), true);
  assert.equal(runtime.getScanCalls(), 1, "mutation invalidation never rescans physical text");
  assert.equal(runtime.controller.refreshPageFromHost({ ...identity, changedKeys: ["walk the dog"] }), true);
  assert.equal(runtime.controller.pageResultCache.has(2), false, "phrase family invalidates an offscreen lexical result");
  assert.equal(runtime.posted.length, before + 1, "offscreen mutation does not query or render the page");
  assert.equal(runtime.controller.pageResultCache.has(3), true);
  runtime.controller.dispose();
});

test("invalidation rejects oversized or stale key lists and all-invalidation queries only visible pages", () => {
  const runtime = makeRuntime();
  runtime.controller.setDocument("doc-1", 7, true);
  const identity = { documentId: "doc-1", openRequest: 7 };
  const before = runtime.posted.length;
  assert.equal(runtime.controller.refreshPageFromHost({ ...identity, changedKeys: Array(65).fill("alpha") }), false);
  assert.equal(runtime.controller.refreshPageFromHost({ ...identity, changedKeys: ["Alpha"] }), false);
  assert.equal(runtime.controller.refreshPageFromHost({ ...identity, openRequest: 6, changedKeys: ["alpha"] }), false);
  assert.equal(runtime.controller.refreshPageFromHost({ ...identity, changedKeys: [] }), true);
  assert.equal(runtime.posted.length, before);
  runtime.controller.pageResultCache.set(99, { signature: "alpha" });
  assert.equal(runtime.controller.refreshPageFromHost({ ...identity, invalidateAll: true }), true);
  assert.equal(runtime.controller.pageResultCache.size, 0);
  assert.equal(runtime.posted.length, before + 1);
  assert.equal(runtime.posted.at(-1).pageNumber, 1);
  assert.equal(runtime.getScanCalls(), 1);
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
  runtime.listeners.get("scalechanging")({ scale: 2 });
  runtime.flushAnimationFrames();
  assert.equal(overlay.draws.length, 3, "100% → 125% → 200% recomputes only visible geometry");
  assert.equal(phraseMatchCalls, 0, "zoom uses cached lexical ranges and only remeasures/draws geometry");
  assert.equal(runtime.posted.length, 1, "125% and 200% zoom do not re-query the host");
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
  const rects = new Map();
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
      let node;
      return {
        setStart(textNode) { node = textNode; }, setEnd() {}, detach() {},
        getClientRects() { return rects.get(node) || []; },
      };
    },
  };
  let pageRect = { left: 10, top: 20, width: 200, height: 300 };
  const pageRoot = {
    ownerDocument: documentRef,
    children: [],
    appendChild(node) { node.parentNode = this; this.children.push(node); },
    removeChild(node) { this.children = this.children.filter((child) => child !== node); node.parentNode = null; },
    getBoundingClientRect() { return pageRect; },
  };
  const overlay = new VocabularyCanvasOverlay(pageRoot, { documentRef });
  assert.equal(pageRoot.children.length, 1);
  assert.equal(overlay.canvas["aria-hidden"], "true");
  assert.equal(overlay.canvas.style.pointerEvents, "none");
  const upper = {};
  const lower = {};
  rects.set(upper, [{ left: 15, top: 25, right: 40, bottom: 39, width: 25, height: 14 }]);
  rects.set(lower, [{ left: 20, top: 48, right: 42, bottom: 62, width: 22, height: 14 }]);
  overlay.draw([
    { token: { segments: [{ textNode: upper, startOffset: 0, endOffset: 3 }] }, status: 2 },
    { token: { segments: [{ textNode: lower, startOffset: 0, endOffset: 3 }] }, status: 5 },
  ]);
  assert.deepEqual(drawn, [
    { args: [5, 5, 25, 14], color: "rgba(202, 138, 4, 0.22)" },
    { args: [10, 28, 22, 14], color: "rgba(124, 58, 237, 0.18)" },
  ]);

  // PDF.js may change range geometry and the page frame after zoom. Drawing
  // the same cached token ranges must measure the new viewport instead of
  // reusing stale canvas pixels.
  drawn.length = 0;
  pageRect = { left: 20, top: 40, width: 400, height: 600 };
  rects.set(upper, [{ left: 30, top: 50, right: 80, bottom: 78, width: 50, height: 28 }]);
  rects.set(lower, [{ left: 40, top: 82, right: 84, bottom: 110, width: 44, height: 28 }]);
  overlay.draw([
    { token: { segments: [{ textNode: upper, startOffset: 0, endOffset: 3 }] }, status: 2 },
    { token: { segments: [{ textNode: lower, startOffset: 0, endOffset: 3 }] }, status: 5 },
  ]);
  assert.deepEqual(drawn, [
    { args: [10, 10, 50, 28], color: "rgba(202, 138, 4, 0.22)" },
    { args: [20, 42, 44, 28], color: "rgba(124, 58, 237, 0.18)" },
  ], "fallback repaint follows the new scale and page origin");
  assert.equal(overlay.canvas.width, 400);
  assert.equal(overlay.canvas.height, 600);
  overlay.dispose();
  assert.equal(pageRoot.children.length, 0);
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

test("overlap detection does not merge independent PDF columns", () => {
  class FakeHighlight {
    ranges = [];
    add(range) { this.ranges.push(range); }
  }
  const registry = new Map();
  const rects = new Map();
  const documentRef = {
    head: { appendChild(node) { node.parentNode = this; } },
    createElement(tag) {
      assert.equal(tag, "style", "non-overlapping columns stay on CSS text ranges");
      return { dataset: {}, textContent: "", remove() {} };
    },
    createRange() {
      let node;
      return {
        setStart(textNode) { node = textNode; }, setEnd() {},
        getClientRects() { return rects.get(node) || []; },
      };
    },
  };
  const pageRoot = {
    ownerDocument: documentRef,
    appendChild() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 900 }; },
  };
  const leftColumn = {};
  const rightColumn = {};
  rects.set(leftColumn, [{ left: 40, top: 50, width: 70, height: 18 }]);
  rects.set(rightColumn, [{ left: 500, top: 60, width: 80, height: 18 }]);
  const renderer = new VocabularyCanvasOverlay(pageRoot, {
    documentRef, windowRef: { CSS: { highlights: registry }, Highlight: FakeHighlight },
  });

  renderer.draw([
    { token: { segments: [{ textNode: leftColumn, startOffset: 0, endOffset: 1 }] }, status: 5 },
    { token: { segments: [{ textNode: rightColumn, startOffset: 0, endOffset: 1 }] }, status: 5 },
  ]);
  assert.equal(registry.size, 1);
  assert.equal([...registry.values()][0].ranges.length, 2);
  assert.equal(renderer.canvas, null,
    "vertical overlap between columns with disjoint x ranges must not trigger row clipping");
  renderer.dispose();
});

test("modern renderer separates only colliding text rows around measured centers and recomputes after zoom", () => {
  class FakeHighlight {
    ranges = [];
    add(range) { this.ranges.push(range); }
  }
  const registry = new Map();
  const rects = new Map();
  const fills = [];
  const context = {
    setTransform() {}, clearRect() {}, fillStyle: "",
    fillRect(x, y, width, height) { fills.push({ x, y, width, height, color: this.fillStyle }); },
  };
  const documentRef = {
    head: { appendChild(node) { node.parentNode = this; } },
    createElement(tag) {
      if (tag === "style") return { dataset: {}, textContent: "", remove() {} };
      assert.equal(tag, "canvas");
      return {
        width: 0, height: 0, style: {}, parentNode: null, setAttribute() {},
        getContext: () => context,
        remove() { this.parentNode?.removeChild(this); },
      };
    },
    createRange() {
      let node;
      return {
        setStart(textNode, offset) { node = textNode; this.start = [textNode, offset]; },
        setEnd(textNode, offset) { this.end = [textNode, offset]; }, detach() {},
        getClientRects() { return rects.get(node) || []; },
      };
    },
  };
  let pageRect = { left: 10, top: 20, width: 200, height: 300 };
  const pageRoot = {
    ownerDocument: documentRef, children: [], clientLeft: 0, clientTop: 0,
    appendChild(node) { node.parentNode = this; this.children.push(node); },
    removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; },
    getBoundingClientRect() { return pageRect; },
  };
  const upper = {};
  const lower = {};
  rects.set(upper, [{ left: 30, top: 30, width: 50, height: 20 }]);
  rects.set(lower, [{ left: 32, top: 47, width: 48, height: 20 }]);
  const renderer = new VocabularyCanvasOverlay(pageRoot, {
    documentRef, windowRef: { CSS: { highlights: registry }, Highlight: FakeHighlight },
  });

  renderer.draw([
    { token: { segments: [{ textNode: upper, startOffset: 0, endOffset: 1 }] }, status: 1 },
    { token: { segments: [{ textNode: lower, startOffset: 0, endOffset: 1 }] }, status: 2 },
  ]);
  assert.equal(registry.size, 0, "colliding lines use measured geometry rather than overlapping native marks");
  assert.ok(renderer.canvas, "the page-local fallback is used only when ranges collide");
  assert.deepEqual(fills.map(({ x, y, width, height }) => [x, y, width, height]), [
    [20, 12, 50, 16],
    [22, 29, 48, 16],
  ]);
  assert.equal(fills[0].y + fills[0].height / 2, 20,
    "the upper highlight remains centered on its measured text range");
  assert.equal(fills[1].y + fills[1].height / 2, 37,
    "the lower highlight remains centered on its measured text range");
  assert.equal(fills[0].y + fills[0].height, fills[1].y - 1,
    "intersecting words on adjacent lines keep a one-pixel visual gap");

  // New zoom geometry is measured from the same source ranges. There is no
  // stale page-level row cache to restore the old overlap or shift the marks.
  fills.length = 0;
  pageRect = { left: 20, top: 40, width: 400, height: 600 };
  rects.set(upper, [{ left: 44, top: 100, width: 100, height: 40 }]);
  rects.set(lower, [{ left: 48, top: 134, width: 96, height: 40 }]);
  renderer.draw([
    { token: { segments: [{ textNode: upper, startOffset: 0, endOffset: 1 }] }, status: 1 },
    { token: { segments: [{ textNode: lower, startOffset: 0, endOffset: 1 }] }, status: 2 },
  ]);
  assert.deepEqual(fills.map(({ x, y, width, height }) => [x, y, width, height]), [
    [24, 63.5, 100, 33],
    [28, 97.5, 96, 33],
  ], "zoom redraw scales the separation while preserving each new range center");
  renderer.dispose();
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

test("occurrence link resolves a pruned page against its current text layer and rejects stale token identity", () => {
  const textNode = { nodeType: 3, nodeValue: "mostly", isConnected: true, ownerDocument: null };
  const textLayer = { contains: (node) => node === textNode };
  const pageRoot = {
    querySelector: (selector) => selector === ".textLayer" ? textLayer : null,
    contains: (node) => node === textLayer || node === textNode,
  };
  const ranges = [];
  const documentRef = {
    createRange() {
      const range = {
        setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
        setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; },
      };
      ranges.push(range);
      return range;
    },
  };
  textNode.ownerDocument = documentRef;
  let scanCount = 0;
  const controller = new VocabularyController({
    app: { pdfViewer: { getPageView: () => ({ div: pageRoot }) } },
    documentRef,
    postToHost: () => true,
    getIdentity: () => ({ documentId: "doc-1", openRequest: 7 }),
    scan: (layer) => {
      scanCount += 1;
      assert.equal(layer, textLayer);
      return [{ index: 0, rawSurface: "mostly", surfaceKey: "mostly",
        segments: [{ textNode, startOffset: 0, endOffset: 6 }] }];
    },
  });
  controller.setDocument("doc-1", 7, true);
  // The page has been pruned from the live visible-page cache while its pill
  // remains open. An explicit copy action must rescan only this current page.
  controller.pages.delete("1");
  assert.equal(controller.rangeForOccurrence(1, 0, 1, "mostly"), ranges.at(-1));
  assert.equal(scanCount, 1);
  assert.equal(ranges.at(-1).startContainer, textNode);
  assert.equal(ranges.at(-1).startOffset, 0);
  assert.equal(ranges.at(-1).endContainer, textNode);
  assert.equal(ranges.at(-1).endOffset, 6);
  assert.equal(controller.rangeForOccurrence(1, 0, 1, "most"), null,
    "a stale pill cannot silently bind to a different token at the same index");
  assert.equal(scanCount, 2);
  controller.dispose();
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
        setEnd(node, end) { this.end = end; this.endContainer = node; this.endOffset = end; this.startContainer = this.node; this.startOffset = this.start; },
        getClientRects() { return this.node === textNode ? [{ left: 10, right: 80, top: 20, bottom: 40 }] : []; },
        detach() {},
      };
    },
  };
  const textNode = { data: "Alpha", nodeValue: "Alpha", length: 5, nodeType: 3, parentNode: null };
  const textLayer = {
    contains: (node) => node === textNode,
    ownerDocument: documentRef,
  };
  documentRef.createTreeWalker = () => {
    let consumed = false;
    return { nextNode: () => consumed ? null : (consumed = true, textNode) };
  };
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
  assert.equal(controller.entryPill.heading.textContent, "Alpha",
    "ordinary surface capitalization remains visible in the pill title");
  assert.equal(controller.entryPill.popup.attributes["aria-label"], "LingQ 词条：Alpha",
    "ordinary surface capitalization is retained in the accessible label");
  assert.equal(controller.handleEntryResult({ requestId: unrecordedTap.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7, record: null }), true);
  assert.equal(controller.entryPill.statusElement.textContent, "陌生词");
  assert.equal(controller.entryPill.meanings.textContent, "未查询外部词典");
  const dictionaryTranslation = "prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开";
  assert.equal(controller.handleEntryResult({ requestId: unrecordedTap.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7,
    record: {
      key: "alpha", type: "word", hasPersonalRecord: false,
      translation: dictionaryTranslation, phonetic: "ɒn", dictionaryLookupState: "found",
    } }), true);
  assert.equal(controller.entryPill.meanings.textContent, dictionaryTranslation);
  assert.equal(controller.entryPill.pronunciation.textContent, "ɒn");
  assert.equal(controller.entryPill.record.hasPersonalRecord, false);
  assert.equal(controller.requestStatusChange(5), true);
  const dictionaryStatusUpdate = posted.filter((message) => message.type === "vocab-set-status").at(-1);
  assert.equal(controller.handleStatusAck({ durable: true, requestId: dictionaryStatusUpdate.requestId,
    key: "alpha", pageNumber: 1, documentId: "doc-1", openRequest: 8,
    record: { key: "alpha", storageKey: "alpha", type: "word", status: 5 } }), false,
  "a stale durable ACK cannot alter the current dictionary-backed card");
  assert.equal(controller.entryPill.meanings.textContent, dictionaryTranslation);
  assert.equal(controller.entryPill.pronunciation.textContent, "ɒn");
  assert.equal(controller.entryPill.record.hasPersonalRecord, false);
  assert.equal(controller.handleStatusAck({ durable: true, requestId: dictionaryStatusUpdate.requestId,
    key: "alpha", pageNumber: 1, documentId: "doc-1", openRequest: 7,
    record: { key: "alpha", storageKey: "alpha", type: "word", status: 5 } }), true,
  "a durable status ACK may omit dictionary fields because they are not persisted in the personal record");
  assert.equal(controller.entryPill.meanings.textContent, dictionaryTranslation);
  assert.equal(controller.entryPill.pronunciation.textContent, "ɒn");
  assert.equal(controller.entryPill.record.hasPersonalRecord, true);
  assert.equal(controller.entryPill.status, 5);
  controller.updatePillRecord({ key: "alpha", type: "word" });
  assert.equal(controller.entryPill.statusElement.textContent, "学习状态未设置");
  assert.equal(controller.entryPill.meanings.textContent, "个人词条未保存释义");
  controller.dismissEntryPill();
  controller.pages.get("1").records = [
    { key: "alpha", storageKey: "alpha", type: "word", status: 2 },
    { key: "alphas", storageKey: "alpha", type: "word", status: 2 },
  ];
  assert.equal(controller.handleTap({ type: "click", targetRole: "text-layer", button: 0, detail: 1,
    pageIndex: 0, clientPoint: { x: 30, y: 30 } }), true);
  const tap = posted.filter((message) => message.type === "vocab-token-tap").at(-1);
  const backlinkQuery = posted.filter((message) => message.type === "reader-backlink-occurrence-query").at(-1);
  assert.equal(backlinkQuery.startIndex, 0);
  assert.equal(backlinkQuery.endIndex, 5);
  controller.entryPill.occurrenceButton.listeners.click({ stopPropagation() {} });
  const occurrenceRequest = posted.filter((message) => message.type === "reader-anchor-occurrence-link-request").at(-1);
  assert.equal(occurrenceRequest.pageNumber, 1);
  assert.equal(occurrenceRequest.startIndex, 0);
  assert.equal(occurrenceRequest.endIndex, 1);
  assert.equal(occurrenceRequest.expectedSurface, "Alpha",
    "the authenticated host can verify the clicked occurrence instead of trusting stale token indices alone");
  assert.equal(controller.handleOccurrenceBacklinks({ documentId: "doc-1", openRequest: 7,
    requestId: backlinkQuery.requestId, ok: true, count: 2, anchorIds: ["anchor-0001"] }), true);
  assert.equal(controller.entryPill.backlinks.textContent, "反向链接：2");
  assert.equal(controller.entryPill.openBacklinks.hidden, false);
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
  const update = posted.filter((message) => message.type === "vocab-set-status").at(-1);
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
    type: "word", startIndex: 0, endIndex: 1, surfaceKey: "alpha", rawSurface: "Alpha", logicalSurface: "Alpha",
  }, "words remain available for lookup even when their stored level is not highlighted");
  const phrase = runtime.controller.entryForTappedToken(page, page.tokens[1]);
  assert.deepEqual(phrase, { type: "phrase", startIndex: 1, endIndex: 3,
    surfaceKey: "beta gamma", rawSurface: "beta gamma", logicalSurface: "beta gamma" });
  runtime.controller.setHighlightLevels({ words: [1, 2, 3, 4], phrases: [1, 3, 4, 5] });
  assert.deepEqual(runtime.controller.entryForTappedToken(page, page.tokens[2]), {
    type: "word", startIndex: 2, endIndex: 3, surfaceKey: "gamma", rawSurface: "gamma", logicalSurface: "gamma",
  }, "a phrase outside configured highlight levels falls back to the tapped word");
  runtime.controller.setHighlightLevels({ words: [5], phrases: [2] });
  assert.deepEqual(runtime.controller.entryForTappedToken(page, page.tokens[0]), {
    type: "word", startIndex: 0, endIndex: 1, surfaceKey: "alpha", rawSurface: "Alpha", logicalSurface: "Alpha",
  });
  runtime.controller.dispose();
});

test("LingQ context capture binds the preview to the pill identity and saves only after explicit confirmation", () => {
  const runtime = makeContextPillRuntime();
  const pill = runtime.openPill();
  pill.contextCapture.click();
  const capture = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-capture-request").at(-1);
  assert.deepEqual(capture, {
    type: "reader-vocabulary-context-capture-request",
    requestId: pill.contextRequestId,
    pageNumber: 1,
    expectedSurface: "walking",
    documentId: "doc-context",
    openRequest: 31,
  });

  const preview = {
    type: "reader-vocabulary-context-preview",
    requestId: capture.requestId,
    documentId: "doc-context",
    openRequest: 31,
    ok: true,
    surface: "walking",
    sentence: "She is walking home.",
    captureId: "capture-context-1",
  };
  assert.equal(runtime.controller.handleVocabularyContextPreview({ ...preview, documentId: "stale-doc" }), false,
    "a preview from another PDF cannot update the open card");
  assert.equal(runtime.controller.handleVocabularyContextPreview({ ...preview, requestId: "old-request" }), false,
    "a preview from a retired request cannot update the open card");
  assert.equal(runtime.controller.handleVocabularyContextPreview({ ...preview, surface: "walk" }), true,
    "a host preview for a different surface is rejected and leaves the card recoverable");
  assert.equal(pill.contextPreview.hidden, true);
  assert.equal(pill.contextCapture.disabled, false);
  pill.contextCapture.click();
  const retryCapture = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-capture-request").at(-1);

  assert.equal(runtime.controller.handleVocabularyContextPreview({ ...preview, requestId: retryCapture.requestId }), true);
  assert.equal(pill.contextPreview.value, "She is walking home.");
  assert.equal(pill.contextPreview.readOnly, true,
    "the UI displays the exact sentence the host will verify against its private anchor");
  assert.equal(pill.contextConfirm.hidden, false);
  assert.equal(runtime.posted.filter((message) => message.type === "reader-vocabulary-context-save-request").length, 0,
    "receiving a preview never saves it automatically");

  pill.contextConfirm.click();
  const save = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-save-request").at(-1);
  assert.deepEqual(save, {
    type: "reader-vocabulary-context-save-request",
    requestId: retryCapture.requestId,
    captureId: "capture-context-1",
    documentId: "doc-context",
    openRequest: 31,
  });
  assert.equal("sentence" in save, false, "the host-owned capture remains the source of the saved sentence");
  assert.equal("anchor" in save, false, "the viewer never receives or sends the private anchor");
  assert.equal(pill.contextState, "saving");

  assert.equal(runtime.controller.handleVocabularyContextSaveResult({
    type: "reader-vocabulary-context-save-result",
    requestId: save.requestId,
    captureId: "wrong-capture",
    documentId: "doc-context",
    openRequest: 31,
    ok: true,
    status: "committed",
  }), false, "a save result for a different capture is ignored");
  assert.equal(runtime.controller.handleVocabularyContextSaveResult({
    type: "reader-vocabulary-context-save-result",
    requestId: save.requestId,
    captureId: "capture-context-1",
    documentId: "doc-context",
    openRequest: 30,
    ok: true,
    status: "committed",
  }), false, "a save result from an expired open request is ignored");
  assert.equal(pill.contextState, "saving");
  runtime.setIdentity({ documentId: "doc-next", openRequest: 32 });
  assert.equal(runtime.controller.handleVocabularyContextSaveResult({
    type: "reader-vocabulary-context-save-result",
    requestId: save.requestId,
    captureId: "capture-context-1",
    documentId: "doc-context",
    openRequest: 31,
    ok: true,
    status: "committed",
  }), false, "a matching response cannot update a card after the host identity has advanced");

  runtime.controller.dispose();
});

test("LingQ context failure permits a fresh capture, success completes the flow, and dismiss clears pending work", () => {
  const runtime = makeContextPillRuntime();
  let pill = runtime.openPill();
  pill.contextCapture.click();
  const failedCapture = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-capture-request").at(-1);
  assert.equal(runtime.controller.handleVocabularyContextPreview({
    type: "reader-vocabulary-context-preview",
    requestId: failedCapture.requestId,
    documentId: "doc-context",
    openRequest: 31,
    ok: false,
    error: "selection-required",
    message: "请先选择一句文本。",
  }), true);
  assert.equal(pill.contextState, null);
  assert.equal(pill.contextStatus.textContent, "请先选择一句文本。",
    "the human-readable host message is surfaced when present");

  pill.contextCapture.click();
  const firstCapture = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-capture-request").at(-1);
  const firstPreview = {
    type: "reader-vocabulary-context-preview",
    requestId: firstCapture.requestId,
    documentId: "doc-context",
    openRequest: 31,
    ok: true,
    surface: "walking",
    sentence: "She is walking home.",
    captureId: "capture-context-retry",
  };
  assert.equal(runtime.controller.handleVocabularyContextPreview(firstPreview), true);
  pill.contextConfirm.click();
  const failedSave = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-save-request").at(-1);
  assert.equal(runtime.controller.handleVocabularyContextSaveResult({
    type: "reader-vocabulary-context-save-result",
    requestId: failedSave.requestId,
    captureId: "capture-context-retry",
    documentId: "doc-context",
    openRequest: 31,
    ok: false,
    status: "source-stale",
    message: "原文已变化，请重新选择。",
  }), true);
  assert.equal(pill.contextPreview.hidden, true,
    "a failed save discards the preview and asks for a newly verified capture");
  assert.equal(pill.contextCapture.disabled, false);
  assert.equal(runtime.controller.handleVocabularyContextSaveResult({
    type: "reader-vocabulary-context-save-result",
    requestId: failedSave.requestId,
    captureId: "capture-context-retry",
    documentId: "doc-context",
    openRequest: 31,
    ok: true,
    status: "committed",
  }), false, "a duplicate result after failure cannot complete a later capture");

  pill.contextCapture.click();
  const successfulCapture = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-capture-request").at(-1);
  assert.notEqual(successfulCapture.requestId, failedSave.requestId);
  assert.equal(runtime.controller.handleVocabularyContextPreview({
    ...firstPreview,
    requestId: successfulCapture.requestId,
    captureId: "capture-context-success",
  }), true);
  pill.contextConfirm.click();
  const successfulSave = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-save-request").at(-1);
  assert.equal(runtime.controller.handleVocabularyContextSaveResult({
    type: "reader-vocabulary-context-save-result",
    requestId: successfulSave.requestId,
    captureId: "capture-context-success",
    documentId: "doc-context",
    openRequest: 31,
    ok: true,
    status: "committed",
    message: "语境已保存。",
  }), true);
  assert.equal(pill.contextState, "saved");
  assert.equal(pill.contextStatus.textContent, "语境已保存。");
  assert.equal(pill.contextCapture.hidden, true);
  assert.equal(pill.contextConfirm.hidden, true);
  assert.equal(pill.contextPreview.value, "She is walking home.");

  runtime.controller.dismissEntryPill();
  pill = runtime.openPill();
  pill.contextCapture.click();
  const pendingCapture = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-capture-request").at(-1);
  runtime.controller.dismissEntryPill();
  assert.equal(pill.contextRequestId, null);
  assert.equal(pill.contextCaptureId, null);
  assert.equal(runtime.controller.handleVocabularyContextPreview({
    ...firstPreview,
    requestId: pendingCapture.requestId,
  }), false, "dismissing the pill retires an in-flight capture request");

  pill = runtime.openPill();
  pill.contextCapture.click();
  const finalCapture = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-capture-request").at(-1);
  assert.equal(runtime.controller.handleVocabularyContextPreview({
    ...firstPreview,
    requestId: finalCapture.requestId,
  }), true);
  pill.contextConfirm.click();
  const pendingSave = runtime.posted.filter((message) =>
    message.type === "reader-vocabulary-context-save-request").at(-1);
  runtime.controller.dismissEntryPill();
  assert.equal(runtime.controller.handleVocabularyContextSaveResult({
    type: "reader-vocabulary-context-save-result",
    requestId: pendingSave.requestId,
    captureId: "capture-context-retry",
    documentId: "doc-context",
    openRequest: 31,
    ok: true,
    status: "committed",
  }), false, "dismissing the pill retires an in-flight save result");
  runtime.controller.dispose();
  assert.equal(runtime.body.children.length, 0);
});
