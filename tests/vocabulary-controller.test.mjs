import assert from "node:assert/strict";
import test from "node:test";

import { VocabularyController } from "../viewer-adapter/vocabulary/controller.js";
import { VocabularyCanvasOverlay } from "../viewer-adapter/vocabulary/canvas-overlay.js";

function makeRuntime() {
  const listeners = new Map();
  const pages = new Map();
  const posted = [];
  const overlays = [];
  const identity = { documentId: "doc-1", openRequest: 7 };
  let textNodes = [{}, {}, {}];
  let visiblePageIds = [1];
  let scanCalls = 0;
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
  const controller = new VocabularyController({
    app,
    eventBus,
    documentRef: {},
    windowRef: { getSelection: () => ({ rangeCount: 0 }) },
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
  const textLayer = {};
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
    controller, eventBus, listeners, pages, pageRoot, posted, overlays, identity,
    replaceTextNodes: () => { textNodes = [{}, {}, {}]; },
    setVisiblePageIds: (ids) => { visiblePageIds = ids; },
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
  runtime.listeners.get("textlayerrendered")({ pageNumber: 2 });
  assert.equal(runtime.getScanCalls(), 2);
  assert.deepEqual([...runtime.controller.pages.keys()], ["2"]);
  assert.equal(runtime.overlays[0].disposeCount, 1, "offscreen page overlay is disposed");
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
  assert.deepEqual(runtime.posted[0].keys, ["alpha", "beta", "gamma", "alpha beta", "alpha beta gamma", "beta gamma"]);
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
    assert.equal(runtime.posted.length, 2);
    assert.notEqual(runtime.posted[1].requestId, oldRequest);
    assert.equal(runtime.controller.handlePageResults({
      documentId: "doc-1", openRequest: 7, pageNumber: 1,
      requestId: oldRequest, queryId: query.queryId, partIndex: query.partIndex, records: [],
    }), false, "a stale page reply is ignored");
    runtime.controller.dispose();
    assert.equal(runtime.overlays[0].disposeCount, 1);
    assert.equal(runtime.listeners.size, 0);
  });
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

test("Canvas overlay is one aria-hidden, pointer-transparent canvas and removes itself on dispose", () => {
  const drawn = [];
  const context = {
    setTransform() {}, clearRect() {},
    fillRect(...args) { drawn.push(args); },
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
  overlay.draw([{ token: { segments: [{ textNode: {}, startOffset: 0, endOffset: 3 }] }, status: 2 }]);
  assert.deepEqual(drawn, [[5, 14, 25, 2]]);
  overlay.dispose();
  assert.equal(pageRoot.children.length, 0);
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
    pageIndex: 0, clientPoint: { x: 30, y: 30 } }), true);
  const tap = posted.find((message) => message.type === "vocab-token-tap");
  assert.equal(tap.key, "alpha");
  assert.equal(body.children.length, 1);
  assert.deepEqual(controller.entryPill.buttons.map((button) => button.textContent), ["1", "2", "3", "4", "✓ Known"]);
  assert.equal(controller.handleEntryResult({ requestId: tap.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7,
    record: { key: "alpha", type: "word", status: 2, translation: "局部释义", note: "local note" } }), true);
  assert.match(controller.entryPill.summary.textContent, /局部释义/);
  assert.equal(controller.requestStatusChange(3), true);
  const update = posted.find((message) => message.type === "vocab-set-status");
  assert.equal(update.status, 3);
  assert.equal(controller.handleStatusAck({ durable: false, requestId: update.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7, record: { key: "alpha", type: "word", status: 3 } }), false,
  "viewer state never changes before the explicit durable ACK");
  assert.equal(controller.handleStatusAck({ durable: true, requestId: update.requestId, key: "alpha", pageNumber: 1,
    documentId: "doc-1", openRequest: 7, record: { key: "alpha", type: "word", status: 3 } }), true);
  assert.equal(controller.entryPill.status, 3);
  assert.deepEqual(overlay.drawn.at(-1).map(({ token, status }) => [token.surfaceKey, status]), [["alpha", 3]]);
  selection.isCollapsed = false;
  assert.equal(controller.handleTap({ type: "click", targetRole: "text-layer", button: 0, detail: 1,
    pageIndex: 0, clientPoint: { x: 30, y: 30 } }), false, "existing text selection keeps priority over the popup");
  controller.dispose();
  assert.equal(body.children.length, 0, "session teardown removes the viewer popup");
});
