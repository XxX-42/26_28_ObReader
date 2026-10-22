import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const bridgePath = new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url);
const bridge = await readFile(bridgePath, "utf8");

function functionSource(name) {
  let start = bridge.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  if (bridge.slice(start - 6, start) === "async ") start -= 6;
  const signatureEnd = bridge.indexOf(") {", start);
  const open = signatureEnd + 2;
  assert.notEqual(open, -1, `missing body for ${name}`);
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < bridge.length; index += 1) {
    const char = bridge[index];
    const next = bridge[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return bridge.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function region(start, end) {
  const from = bridge.indexOf(start);
  assert.notEqual(from, -1, `missing region start: ${start}`);
  const to = bridge.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing region end: ${end}`);
  return bridge.slice(from, to);
}

function evaluateHelpers(names, body, exposed = []) {
  const helpers = names.map(functionSource).join("\n");
  return vm.runInThisContext(`(() => { ${body}\n${helpers}\nreturn { ${[...names, ...exposed].join(", ")} }; })()`);
}

test("annotation sidebar is lazy, uses sorted active targets, and refreshes only while open", async () => {
  const helpers = evaluateHelpers(
    ["getLiveAnnotationSidebarTexts", "getAnnotationSidebarTargetTexts", "getLegacyHighlightSidebarTargetText",
      "getAnnotationSidebarTargetTextEvidence", "resolveAnnotationSidebarTargetTextEvidence",
      "resolveAnnotationSidebarTargetText", "buildAnnotationSidebarViewModels", "createAnnotationSidebarController"],
    "function normalizeSyncKind(value) { return value; }",
  );
  const previousDocument = globalThis.document;
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  const pendingFrames = [];

  class Element {
    constructor(tagName = "div") {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this.parentElement = null;
      this._classes = new Set();
      this.textContent = "";
      this.value = "";
      this.disabled = false;
      this.tabIndex = -1;
      this.classList = {
        add: name => this._classes.add(name),
        remove: name => this._classes.delete(name),
        contains: name => this._classes.has(name),
        toggle: (name, force) => {
          const enabled = force ?? !this._classes.has(name);
          if (enabled) this._classes.add(name);
          else this._classes.delete(name);
          return enabled;
        },
      };
    }
    set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(" "); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
    }
    dispatch(type, event = {}) {
      for (const listener of this.listeners.get(type) || []) listener({ target: this, preventDefault() {}, ...event });
    }
    append(...nodes) {
      for (const node of nodes) {
        if (node.tagName === "#fragment") {
          this.append(...node.children);
          node.children = [];
        } else {
          node.parentElement = this;
          this.children.push(node);
        }
      }
    }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    querySelector() { return null; }
    querySelectorAll(selector) {
      const matches = [];
      const visit = node => {
        for (const child of node.children) {
          if (selector === "li.sidebarComment" && child.tagName === "li" && child.classList.contains("sidebarComment")) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) {
        if (selector === "li.sidebarComment" && node.tagName === "li" && node.classList.contains("sidebarComment")) return node;
        const className = /^\.([\w-]+)$/.exec(selector)?.[1];
        if (className && node.classList.contains(className)) return node;
      }
      return null;
    }
    contains(node) { return this.querySelectorAll("li.sidebarComment").includes(node); }
    focus() { this.focused = true; }
  }

  globalThis.document = {
    createElement: tagName => new Element(tagName),
    createDocumentFragment: () => new Element("#fragment"),
  };
  let nextFrameId = -1;
  const queuedFrames = new Map();
  const cancelledFrames = [];
  globalThis.requestAnimationFrame = callback => {
    const id = ++nextFrameId;
    queuedFrames.set(id, callback);
    pendingFrames.push(id);
    return id;
  };
  globalThis.cancelAnimationFrame = id => {
    cancelledFrames.push(id);
    queuedFrames.delete(id);
    const index = pendingFrames.indexOf(id);
    if (index >= 0) pendingFrames.splice(index, 1);
  };
  const runNextFrame = () => {
    const id = pendingFrames.shift();
    const callback = queuedFrames.get(id);
    queuedFrames.delete(id);
    callback?.();
  };
  try {
    const button = new Element("button");
    const menu = new Element("div");
    menu.className = "hidden";
    const sidebar = new Element("div");
    const list = new Element("ul");
    const count = new Element("span");
    const closeButton = new Element("button");
    const searchInput = new Element("input");
    const typeFilter = new Element("select");
    typeFilter.value = "all";
    const editorPayload = { text: "selected JavaScript target text" };
    const targets = new Map([
      ["b", { uuid: "b", pageIndex: 1, kind: "Highlight", editorPayload }],
      ["a", { uuid: "a", pageIndex: 0, kind: "Underline", editorPayload: null }],
      ["deleted", { uuid: "deleted", pageIndex: 0, kind: "Highlight", deleted: true }],
    ]);
    let collectCalls = 0;
    let navigated = [];
    const reviewRequests = [];
    const controller = helpers.createAnnotationSidebarController({
      button, menu, sidebar, list, count, closeButton,
      searchInput, typeFilter,
      collectTargets: () => { collectCalls += 1; return targets; },
      createSessionGuard: () => () => true,
      navigate: async (uuid, pageIndex) => { navigated.push([uuid, pageIndex]); return { ok: true }; },
      onAddToReview: (target, guard) => { reviewRequests.push({ ...target, current: guard() }); },
    });

    assert.equal(collectCalls, 0, "constructing the controller and initial PDF view do not collect rows");
    assert.equal(controller.refreshIfOpen(), false, "closed sidebar ignores state refreshes");
    searchInput.value = "selected";
    searchInput.dispatch("input");
    typeFilter.value = "Highlight";
    typeFilter.dispatch("change");
    assert.equal(queuedFrames.size, 0, "closed search and type changes do not schedule collection or rendering");
    assert.equal(collectCalls, 0, "closed search and type changes never scan active annotation targets");
    searchInput.value = "";
    typeFilter.value = "all";
    button.dispatch("click");
    assert.equal(collectCalls, 0, "opening queues the first active snapshot in the next animation frame");
    runNextFrame();
    assert.equal(collectCalls, 1, "the first toolbar activation builds the list");
    assert.equal(count.textContent, "2", "deleted records are excluded from the visible count");
    const rows = list.querySelectorAll("li.sidebarComment");
    assert.deepEqual(rows.map(row => row.dataset.uuid), ["a", "b"], "rows use page then UUID ordering");
    assert.equal(rows[0].children[0].children[0].tagName, "time");
    assert.equal(rows[0].children[0].children[1].className, "sidebarCommentText");
    assert.equal(rows[0].children[0].children[0].textContent, "p001 · Underline");
    assert.equal(rows[0].children[0].children[1].textContent, "（目标文字暂不可用）");
    assert.equal(rows[1].children[0].children[0].textContent, "p002 · Highlight");
    assert.equal(rows[1].children[0].children[1].textContent, "selected JavaScript target text");
    assert.equal(rows[1].children[0].children[1].title, "selected JavaScript target text",
      "the full target text is available as a hover tooltip");
    assert.equal(rows[1].children[1].textContent, "加入复习");
    assert.equal(rows[1].children[1].disabled, false, "saved Highlight text enables the explicit review action");
    assert.equal(helpers.resolveAnnotationSidebarTargetText({
      kind: "FreeText", editorPayload: { value: "free text content" },
    }, new Map()), "free text content", "FreeText uses PDF.js's serialized value field");
    assert.equal(helpers.resolveAnnotationSidebarTargetText({
      kind: "Highlight", uuid: "live", editorPayload: { text: "stale text" },
    }, new Map([["live", "current live selection"]])), "current live selection",
    "live Highlight editor text takes precedence over stale payload data");

    targets.set("c", { uuid: "c", pageIndex: 0, kind: "Highlight", editorPayload: null });
    assert.equal(controller.refreshIfOpen(), true);
    assert.equal(controller.refreshIfOpen(), false, "multiple changes coalesce into one animation frame");
    assert.equal(collectCalls, 1, "refresh waits for the coalesced frame");
    runNextFrame();
    assert.equal(collectCalls, 2);
    assert.equal(count.textContent, "3");

    const refreshedRows = list.querySelectorAll("li.sidebarComment");
    const unavailableReviewButton = refreshedRows.find(row => row.dataset.uuid === "c").children[1];
    assert.equal(unavailableReviewButton.disabled, true, "missing quote evidence disables review creation");
    assert.match(unavailableReviewButton.title, /目标文字暂不可用/);
    const availableReviewButton = refreshedRows.find(row => row.dataset.uuid === "b").children[1];
    list.dispatch("click", { target: availableReviewButton, stopPropagation() { this.stopped = true; } });
    assert.deepEqual(reviewRequests, [{ uuid: "b", pageIndex: 1, targetText: "selected JavaScript target text",
      targetTextSource: "stored", current: true }], "the review action carries one read-only text snapshot");
    assert.equal(navigated.length, 0, "review button clicks do not also activate Reader navigation");

    const collectBeforeSearch = collectCalls;
    searchInput.value = "javascript";
    searchInput.dispatch("input");
    assert.equal(collectCalls, collectBeforeSearch, "typing filters the collected snapshot without scanning again");
    runNextFrame();
    assert.deepEqual(list.querySelectorAll("li.sidebarComment").map(row => row.dataset.uuid), ["b"]);
    assert.equal(count.textContent, "1");
    typeFilter.value = "Underline";
    typeFilter.dispatch("change");
    assert.equal(collectCalls, collectBeforeSearch, "type filtering also leaves the effective source collection alone");
    runNextFrame();
    assert.equal(list.querySelectorAll("li.sidebarComment").length, 0);
    searchInput.value = "";
    typeFilter.value = "all";
    searchInput.dispatch("input");
    typeFilter.dispatch("change");
    runNextFrame();

    const allRows = list.querySelectorAll("li.sidebarComment");
    const firstNavigate = allRows[0].children[0];
    list.dispatch("click", { target: firstNavigate });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigated[0], ["a", 0], "list activation resolves through the supplied shared navigator");
    list.dispatch("keydown", { target: firstNavigate, key: "ArrowDown" });
    assert.equal(allRows[1].children[0].focused, true, "arrow navigation focuses the next list item");
    list.dispatch("keydown", { target: allRows[1].children[0], key: "Enter" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(navigated[1], ["c", 0], "Enter activates the focused annotation");

    assert.equal(controller.refreshIfOpen(), true, "a current refresh can be pending immediately before close");
    const frameToCancel = pendingFrames[0];
    closeButton.dispatch("click");
    assert.equal(controller.isOpen(), false);
    assert.equal(menu.classList.contains("hidden"), true);
    assert.ok(cancelledFrames.includes(frameToCancel), "closing cancels the pending animation frame");
    searchInput.value = "anything";
    searchInput.dispatch("input");
    assert.equal(queuedFrames.size, 0, "closed search cannot leak a scheduled observer or frame");
    controller.closeAndClear();
    assert.equal(list.querySelectorAll("li.sidebarComment").length, 0, "session replacement clears prior-document rows");
    assert.equal(count.textContent, "0");
    controller.dispose();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
    if (previousCancelRaf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = previousCancelRaf;
  }
});

test("legacy Highlight sidebar text is recovered only from text covered by its quads", () => {
  const helpers = evaluateHelpers(
    ["annotationSidebarTextGlyphs", "recoverHighlightTextFromTextLayer", "getLiveAnnotationSidebarTexts",
      "getLegacyHighlightSidebarTargetText", "getAnnotationSidebarTargetTexts", "getAnnotationSidebarTargetTextEvidence",
      "resolveAnnotationSidebarTargetTextEvidence", "resolveAnnotationSidebarTargetText", "buildAnnotationSidebarViewModels"],
      `const state = { annotationSidebarTextGeometryCache: new WeakMap(), app: null };
     function normalizeSyncKind(value) { return value; }
     function pageElementForIndex(index) { return state.pageRoots?.get(index) || null; }
     function textLayerForPage(root) { return root?.querySelector?.(".textLayer") || null; }`,
    ["state"],
  );

  const fixture = ({ nodes, transform = (x, y) => [x, y], width = 240, height = 160 }) => {
    const ownerDocument = {
      createTreeWalker(_root, _whatToShow) {
        let index = -1;
        return { nextNode() { index += 1; return nodes[index] || null; } };
      },
      createRange() {
        let node = null;
        let start = 0;
        let end = 0;
        return {
          setStart(value, offset) { node = value; start = offset; },
          setEnd(value, offset) { node = value; end = offset; },
          getClientRects() { return node.charRects.slice(start, end).filter(Boolean); },
        };
      },
    };
    const textLayer = { ownerDocument, textContent: nodes.map(node => node.nodeValue).join("") };
    const pageRoot = {
      querySelector: selector => selector === ".textLayer" ? textLayer : null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width, height }),
    };
    const viewport = { width, height, scale: 1, rotation: 0, convertToViewportPoint: transform };
    return { textLayer, pageRoot, viewport };
  };
  const textNode = (text, left, top, { charWidth = 6, glyphWidth = 5, lineHeight = 14 } = {}) => ({
    nodeValue: text,
    parentElement: { closest: () => null },
    charRects: Array.from(text, (_character, index) => ({
      left: left + index * charWidth, right: left + index * charWidth + glyphWidth,
      top, bottom: top + lineHeight, width: glyphWidth, height: lineHeight,
    })),
  });
  const quad = (left, right, top, bottom) => [left, bottom, right, bottom, left, top, right, top];

  const oneLine = fixture({ nodes: [textNode("selected outside", 10, 20)] });
  assert.equal(helpers.recoverHighlightTextFromTextLayer(oneLine.textLayer, oneLine.pageRoot,
    oneLine.viewport, quad(10, 58, 18, 36)), "selected",
  "a legacy quad does not capture adjacent unhighlighted words");

  const multipleLines = fixture({ nodes: [textNode("alpha beta", 10, 20), textNode("gamma delta", 10, 52)] });
  assert.equal(helpers.recoverHighlightTextFromTextLayer(multipleLines.textLayer, multipleLines.pageRoot,
    multipleLines.viewport, [...quad(10, 36, 18, 36), ...quad(10, 38, 50, 68)]), "alpha\ngamma",
  "separate QuadPoints recover only their covered words in line order");

  const columns = fixture({ nodes: [textNode("LEFT", 10, 20), textNode("RIGHT", 150, 20)] });
  assert.equal(helpers.recoverHighlightTextFromTextLayer(columns.textLayer, columns.pageRoot,
    columns.viewport, quad(10, 36, 18, 36)), "LEFT",
  "nearby text in a different column is not captured");

  const rotated = fixture({ nodes: [textNode("TURN", 142, 10)], transform: (x, y) => [160 - y, x] });
  assert.equal(helpers.recoverHighlightTextFromTextLayer(rotated.textLayer, rotated.pageRoot,
    rotated.viewport, quad(10, 36, 0, 18)), "TUR",
  "PDF user-space coordinates are transformed through the current rotated page viewport");

  const targets = new Map([[
    "legacy",
    { uuid: "legacy", pageIndex: 0, kind: "Highlight", editorPayload: { quadPoints: quad(10, 58, 18, 36) } },
  ]]);
  helpers.state.pageRoots = new Map([[0, oneLine.pageRoot]]);
  helpers.state.app = {
    pdfViewer: {
      getPageView: () => ({ viewport: oneLine.viewport }),
      _layerProperties: { annotationEditorUIManager: null },
    },
  };
  assert.equal(helpers.buildAnnotationSidebarViewModels(targets)[0].targetText, "selected",
    "a legacy sidecar row without text can show its recoverable quote in the sidebar");
  assert.equal(helpers.recoverHighlightTextFromTextLayer(oneLine.textLayer, oneLine.pageRoot,
    oneLine.viewport, [10, 20, NaN, 20, 10, 10, 20, 10]), null,
  "malformed geometry fails closed instead of guessing text");
});

test("annotation UUID navigation uses the existing rendered editor and page identity", async () => {
  const { navigateToAnnotationUuid, state } = evaluateHelpers(
    ["navigateToAnnotationUuid"],
    `
      const state = {
        annotationUuidByRuntimeId: new Map([["runtime-1", "durable-uuid"]]),
        app: { pdfViewer: {
          currentPageNumber: 1,
          _layerProperties: { annotationEditorUIManager: {
            getEditor(id) { return id === "runtime-1" ? { pageIndex: 3, div: { scrollIntoView(value) { state.scrolled = value; } } } : null; },
          } },
        } },
      };
      function documentElement() {}
    `,
    ["state"],
  );
  const result = await navigateToAnnotationUuid("durable-uuid", 3, () => true);
  assert.deepEqual(result, { ok: true, reason: null });
  assert.equal(state.app.pdfViewer.currentPageNumber, 4, "navigation targets the correct PDF.js page");
  assert.deepEqual(state.scrolled, { block: "center", inline: "nearest", behavior: "smooth" });
  assert.deepEqual(await navigateToAnnotationUuid("durable-uuid", 3, () => false), {
    ok: false, reason: "stale-session",
  });
  assert.match(functionSource("navigateReaderAnchor"), /navigateToAnnotationUuid\(target\.id, pageIndex, isCurrent\)/,
    "Markdown annotation backlinks and the sidebar share the same UUID navigation helper");
});

test("comment sidebar keeps PDF.js comments disabled and refreshes only at existing state boundaries", () => {
  assert.doesNotMatch(bridge, /enableComment\s*[:=]\s*true|new\s+CommentManager|AnnotationEditorType\.POPUP/);
  assert.match(functionSource("installBridgeControls"), /getElementById\("editorCommentsSidebar"\)/);
  assert.match(functionSource("installBridgeControls"), /menu\.append\(annotationSidebar\)/);
  assert.doesNotMatch(functionSource("installBridgeControls"), /getElementById\("editorCommentButton"\)/,
    "the hidden PDF.js comment-mode button is never exposed");
  assert.match(functionSource("applyExternalAnnotationsSnapshot"), /annotationSidebarController\?\.refreshIfOpen\(\)/);
  assert.match(functionSource("noteMutation"), /annotationSidebarController\?\.refreshIfOpen\(\)/);
  assert.match(functionSource("handleAnnotationSourceMismatch"), /annotationSidebarController\?\.closeAndClear\(\)/);
  assert.match(functionSource("openDocument"), /annotationSidebarController\?\.closeAndClear\(\)/);
  assert.match(functionSource("dispose"), /annotationSidebarController\?\.dispose\(\)/);
  assert.match(functionSource("installBridgeControls"), /learning-review-draft-request/,
    "review requests carry only one current PDF target and its text provenance to the Host");
  assert.match(functionSource("installBridgeControls"), /revision: state\.revision/,
    "the Host can reject drafts from an unconfirmed viewer revision");
  assert.match(functionSource("installBridgeControls"), /confirmedRevision: state\.confirmedRevision/);
  assert.match(functionSource("installBridgeControls"), /dirty: isDirty\(\)/);
  assert.match(functionSource("installBridgeControls"), /pending: Boolean\(state\.savePromise/);
  assert.match(functionSource("installBridgeControls"), /仅检索已保存文字及已渲染页面可恢复文字/);
});

test("history reveals only newly restored Sidecar FreeText in the current editor layer", () => {
  const helpers = evaluateHelpers(
    ["liveSidecarFreeTextEditors", "showRestoredSidecarFreeTextEditors"],
    "const state = { disposed: false, annotationUuidByRuntimeId: new Map() };",
    ["state"],
  );
  const { state, liveSidecarFreeTextEditors, showRestoredSidecarFreeTextEditors } = helpers;
  let shows = 0;
  const layer = { div: {} };
  const builder = { annotationEditorLayer: layer, show() { shows += 1; } };
  const editors = [];
  const manager = { *getEditors() { yield* editors; } };
  const app = { pdfDocument: { numPages: 1 }, pdfViewer: {
    _layerProperties: { annotationEditorUIManager: manager },
    getPageView() { return { annotationEditorLayer: builder }; },
  } };
  state.app = app;
  const makeEditor = (id, fields = {}) => ({
    id, editorType: "freetext", pageIndex: 0, parent: layer,
    div: { isConnected: true, parentElement: layer.div },
    isEmpty() { return false; }, ...fields,
  });
  const existing = makeEditor("existing");
  state.annotationUuidByRuntimeId.set(existing.id, "existing-uuid");
  editors.push(existing);
  const before = liveSidecarFreeTextEditors(manager, app);
  const restored = makeEditor("restored");
  state.annotationUuidByRuntimeId.set(restored.id, "same-durable-uuid");
  editors.push(restored, makeEditor("unbound"));
  for (const [id, fields] of [
    ["native", { annotationElementId: "12R" }],
    ["deleted", { deleted: true }],
    ["empty", { isEmpty() { return true; } }],
    ["stale", { parent: {} }],
    ["detached", { div: { isConnected: false, parentElement: layer.div } }],
  ]) {
    state.annotationUuidByRuntimeId.set(id, `${id}-uuid`);
    editors.push(makeEditor(id, fields));
  }
  showRestoredSidecarFreeTextEditors(manager, app, before);
  assert.equal(shows, 1, "only the rebuilt, bound Sidecar editor reveals its live layer");
  assert.equal(state.annotationUuidByRuntimeId.get(restored.id), "same-durable-uuid");
  showRestoredSidecarFreeTextEditors(manager, app, liveSidecarFreeTextEditors(manager, app));
  assert.equal(shows, 1, "unchanged history does not reveal any layer");
  state.disposed = true;
  showRestoredSidecarFreeTextEditors(manager, app, new Set());
  state.disposed = false;
  state.app = { ...app };
  showRestoredSidecarFreeTextEditors(manager, app, new Set());
  state.app = app;
  app.pdfViewer._layerProperties.annotationEditorUIManager = {};
  showRestoredSidecarFreeTextEditors(manager, app, new Set());
  assert.equal(shows, 1, "disposed, cross-document and replaced-manager sessions cannot reveal stale layers");
});

test("Sidecar hydration initializes editors without taking creation focus and restores hooks on failure", () => {
  const { addHydratedEditor } = evaluateHelpers(["addHydratedEditor"], "");
  const focusRequests = [];
  const prototype = { onceAdded(focus) { focusRequests.push(focus); } };
  const editor = Object.create(prototype);
  const layer = { add(value) { value.onceAdded(true); return value; } };
  assert.equal(addHydratedEditor(layer, editor), editor);
  assert.deepEqual(focusRequests, [false], "restoring content is not a new user-created focused editor");
  assert.equal(Object.hasOwn(editor, "onceAdded"), false, "the temporary adapter cannot leak into later user gestures");
  editor.onceAdded(true);
  assert.deepEqual(focusRequests, [false, true], "normal user creation keeps the original PDF.js focus semantics");

  const ownHook = function (focus) { focusRequests.push(focus); };
  Object.defineProperty(editor, "onceAdded", { value: ownHook, writable: false, enumerable: true, configurable: true });
  const before = Object.getOwnPropertyDescriptor(editor, "onceAdded");
  assert.throws(() => addHydratedEditor({ add(value) {
    value.onceAdded(true);
    throw new Error("renderer failed");
  } }, editor), /renderer failed/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(editor, "onceAdded"), before,
    "a failed hydration restores the exact original hook descriptor");
  assert.equal(focusRequests.at(-1), false);
});

test("selection and LingQ link capture use viewer-owned data-page-number roots with no DOM id", () => {
  const runtime = evaluateHelpers(
    ["pageElementForIndex", "readerPageNumberForRoot", "captureReaderSelection", "captureReaderOccurrence"],
    `
      const pageRoot = { id: "", dataset: { pageNumber: "2" } };
      const textLayer = { closest: () => pageRoot };
      const node = { nodeType: 3, parentElement: { closest: () => textLayer } };
      const snapshot = { startContainer: node, startOffset: 3, endContainer: node, endOffset: 15,
        text: "subscription" };
      const range = { ...snapshot, toString: () => snapshot.text, getBoundingClientRect: () => null };
      let viewerRoot = pageRoot;
      const state = {
        app: { pdfViewer: { getPageView: index => index === 1 ? { div: viewerRoot } : null } },
        actualSourceIdentity: { sourceHash: "xxh64-v1:source", orderedPageIdentities: ["ref:1R", "ref:2R"] },
        vocabularyController: { rangeForOccurrence: (page, start, end, surface) =>
          page === 2 && start === 4 && end === 5 && surface === "subscription" ? range : null },
        textSelectionController: {
          rangeSnapshot: () => snapshot,
          captureRangeAnchor: (layer, selected, root) => layer === textLayer && root === pageRoot
            ? { exactQuote: selected.text, textPosition: { start: 3, end: 15 } } : null,
        },
      };
      function replaceViewerRoot() { viewerRoot = { ...pageRoot }; }
    `,
    ["pageRoot", "replaceViewerRoot"],
  );
  for (const capture of [runtime.captureReaderSelection(), runtime.captureReaderOccurrence(2, 4, 5, "subscription")]) {
    assert.equal(capture?.pageNumber, 2);
    assert.equal(capture?.pageIndex, 1);
    assert.equal(capture?.pageIdentity, "ref:2R");
    assert.equal(capture?.sourceHash, "xxh64-v1:source");
    assert.equal(capture?.exactQuote, "subscription");
  }
  assert.equal(runtime.captureReaderOccurrence(1, 4, 5, "subscription"), null);
  assert.equal(runtime.captureReaderOccurrence(2, 4, 5, "different"), null);
  for (const invalid of ["", "0", "2junk", "2.0", "9007199254740992", "3"]) {
    runtime.pageRoot.dataset.pageNumber = invalid;
    assert.equal(runtime.captureReaderSelection(), null, `invalid or foreign page label ${invalid} must fail closed`);
    assert.equal(runtime.captureReaderOccurrence(2, 4, 5, "subscription"), null);
  }
  runtime.pageRoot.dataset.pageNumber = "2";
  runtime.pageRoot.id = "page1";
  assert.equal(runtime.captureReaderSelection(), null, "conflicting page labels must not be guessed");
  runtime.pageRoot.id = "page2";
  delete runtime.pageRoot.dataset.pageNumber;
  assert.equal(runtime.captureReaderSelection()?.pageNumber, 2, "legacy page ids still require the current viewer root");
  runtime.replaceViewerRoot();
  assert.equal(runtime.captureReaderSelection(), null, "a detached root cannot capture against a new viewer page");
  assert.equal(runtime.captureReaderOccurrence(2, 4, 5, "subscription"), null);
});

test("stable page anchors navigate through the PDF.js viewer scroll container", async () => {
  const { navigateReaderAnchor, state, messages, pageScrollCalls, pageFocus, getPageLookups } = evaluateHelpers(
    ["performanceNow", "clearTemporaryReaderAnchorFocus", "showTemporaryReaderAnchorFocus", "navigateReaderAnchor"],
    `
      const rendererGeneration = 4;
      const messages = [];
      const pageScrollCalls = [];
      const pageFocus = new Set();
      function setTimeout(callback, ms) { if (ms === 50) callback(); return 1; }
      function clearTimeout() {}
      const source = { sourceHash: "sha256-v1:source", orderedPageIdentities: ["ref:3R", "ref:14R"] };
      const state = {
        actualSourceIdentity: source,
        activeDocumentId: "doc-1",
        activeOpenRequest: "open-2",
        app: { pdfViewer: { _page: 16,
          get currentPageNumber() { return this._page; },
          set currentPageNumber(value) { this._page = value; } } },
      };
      let pageLookups = 0;
      function pageElementForIndex(index) {
        pageLookups += 1;
        if (pageLookups === 1) return null;
        return { classList: { add(name) { pageFocus.add(name); }, remove(name) { pageFocus.delete(name); } }, scrollIntoView() { pageScrollCalls.push(index); } };
      }
      function getPageLookups() { return pageLookups; }
      function postToHost(type, fields) { messages.push({ type, ...fields }); }
    `,
    ["state", "messages", "pageScrollCalls", "pageFocus", "getPageLookups"],
  );

  await navigateReaderAnchor({
    documentId: "doc-1",
    openRequest: "open-2",
    rendererGeneration: 4,
    target: { kind: "page", pageIdentity: "ref:14R", pageIndex: 1 },
  });

  assert.equal(state.app.pdfViewer.currentPageNumber, 2);
  assert.ok(getPageLookups() >= 2, "page-only focus waits for PDF.js to render the target page root");
  assert.deepEqual(pageScrollCalls, [], "offscreen page roots are not used as the navigation mechanism");
  assert.equal(pageFocus.has("pdfReaderAnchorFocusPage"), true, "page-only anchor receives visible temporary page focus");
  assert.equal(messages[0]?.type, "reader-anchor-navigation-result");
  assert.equal(messages[0]?.ok, true);
});

test("selection anchors get temporary exact-range focus without replacing document selection", async () => {
  const { navigateReaderAnchor, state, messages, highlights, pageFocus, selectionCalls } = evaluateHelpers(
    ["performanceNow", "clearTemporaryReaderAnchorFocus", "showTemporaryReaderAnchorFocus", "navigateReaderAnchor"],
    `
      const rendererGeneration = 4;
      const messages = [];
      const highlights = new Map();
      const pageFocus = new Set();
      const selectionCalls = [];
      function setTimeout(callback, ms) { return 1; }
      function clearTimeout() {}
      class Highlight { constructor(range) { this.range = range; } }
      const window = { Highlight, CSS: { highlights: {
        set(name, value) { highlights.set(name, value); },
        delete(name) { highlights.delete(name); },
      } } };
      const document = { createElement() { throw new Error("CSS Highlight API should avoid fallback nodes"); } };
      const source = { sourceHash: "sha256-v1:source", orderedPageIdentities: ["ref:14R"] };
      const range = {
        startContainer: { parentElement: { scrollIntoView() {} } },
        cloneRange() { return { cloned: true }; },
      };
      const state = {
        actualSourceIdentity: source,
        activeDocumentId: "doc-1",
        activeOpenRequest: "open-2",
        app: { pdfViewer: { currentPageNumber: 1 } },
        textSelectionController: {
          rangeForAnchor() { return range; },
          selectRange() { selectionCalls.push("selectRange"); return true; },
        },
      };
      function pageElementForIndex() {
        return { classList: { add(name) { pageFocus.add(name); }, remove(name) { pageFocus.delete(name); } } };
      }
      function textLayerForPage() { return {}; }
      function postToHost(type, fields) { messages.push({ type, ...fields }); }
    `,
    ["state", "messages", "highlights", "pageFocus", "selectionCalls"],
  );

  await navigateReaderAnchor({
    documentId: "doc-1", openRequest: "open-2", rendererGeneration: 4,
    target: { kind: "selection", pageIdentity: "ref:14R", pageIndex: 0,
      anchor: { sourceHash: "sha256-v1:source", pageIdentity: "ref:14R" } },
  });

  assert.equal(messages[0]?.ok, true);
  assert.equal(selectionCalls.length, 0, "navigation focus does not overwrite the user's persistent DOM selection");
  assert.equal(highlights.get("pdfReaderAnchorFocusText")?.range.cloned, true, "the exact stored Range is highlighted temporarily");
  assert.equal(pageFocus.has("pdfReaderAnchorFocusPage"), false, "text anchors do not flash the whole page");
});

test("stable page anchors fail closed when the ordered identity does not match", async () => {
  const { navigateReaderAnchor, state, messages } = evaluateHelpers(
    ["performanceNow", "navigateReaderAnchor"],
    `
      const rendererGeneration = 4;
      const messages = [];
      const source = { sourceHash: "sha256-v1:source", orderedPageIdentities: ["ref:3R", "ref:14R"] };
      const state = {
        actualSourceIdentity: source,
        activeDocumentId: "doc-1",
        activeOpenRequest: "open-2",
        app: { pdfViewer: { currentPageNumber: 16 } },
      };
      function pageElementForIndex() { return null; }
      function postToHost(type, fields) { messages.push({ type, ...fields }); }
    `,
    ["state", "messages"],
  );

  await navigateReaderAnchor({
    documentId: "doc-1",
    openRequest: "open-2",
    rendererGeneration: 4,
    target: { kind: "page", pageIdentity: "ref:14R", pageIndex: 2 },
  });

  assert.equal(state.app.pdfViewer.currentPageNumber, 16);
  assert.equal(messages[0]?.ok, false);
  assert.equal(messages[0]?.reason, "page-identity-unresolved");
});

test("daily save, recovery, checkpoint, sync and close never serialize a PDF", () => {
  assert.equal([...bridge.matchAll(/\.saveDocument\s*\(/g)].length, 1);
  assert.match(functionSource("handleExportCopy"), /pdfDocument\.saveDocument\(\)/);

  for (const [name, next] of [
    ["serializeSyncCheckpoint", "function handleSyncCheckpoint"],
    ["saveOneRevision", "async function runSaveSequence"],
    ["runRecoverySequence", "async function requestRecovery"],
    ["handleFlush", "function handleExternalAnnotationsUpdate"],
    ["applySyncSnapshot", "function waitForInputBoundary"],
  ]) {
    assert.doesNotMatch(region(`function ${name}(`, next), /saveDocument\s*\(/);
    assert.doesNotMatch(region(`function ${name}(`, next), /modifyBinary|appendBinary/);
  }

  const saveWait = functionSource("waitForHostSave");
  const recoveryWait = functionSource("waitForHostRecovery");
  for (const source of [saveWait, recoveryWait]) {
    assert.match(source, /postToHost\(\s*"(?:save|recover)"/);
    assert.match(source, /operations,/);
    assert.doesNotMatch(source, /\bdata\s*:/);
  }
  assert.match(recoveryWait, /source,/);
  assert.doesNotMatch(functionSource("serializeSyncCheckpoint"), /saveDocument\s*\(|getData\s*\(/);
});

test("external annotation operation batches preserve identity, tombstones and binary editor state", () => {
  const { externalOperation, encodeExternalValue, decodeExternalValue } = evaluateHelpers(
    ["encodeExternalValue", "decodeExternalValue", "encodeBase64", "decodeBase64", "externalOperation"],
    `
      const EXTERNAL_ANNOTATION_KINDS = new Set(["Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText"]);
      const state = { syncDeviceId: "device-a", syncActorId: "actor-a" };
      function normalizeSyncKind(value) { return value; }
      function canonicalPdfAnnotationRef(value) {
        if (typeof value !== "string") return null;
        const match = /^(\\d+)R(\\d+)?$/.exec(value);
        return match ? match[1] + "R" + (match[2] === "0" ? "" : match[2] || "") : null;
      }
    `,
  );

  const binaryPayload = {
    annotationType: "Ink",
    pageIndex: 16,
    outlines: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    imageData: new Uint8Array([0, 7, 255]),
    metadata: new Map([["z", 2], ["a", 1]]),
  };
  const encoded = encodeExternalValue(binaryPayload);
  const decoded = decodeExternalValue(encoded);
  assert.ok(Array.from(decoded.outlines).every((value, index) =>
    Math.abs(value - [0.1, 0.2, 0.3, 0.4][index]) < 1e-6
  ));
  assert.deepEqual(Array.from(decoded.imageData), [0, 7, 255]);
  assert.deepEqual([...decoded.metadata.entries()], [["a", 1], ["z", 2]]);

  const inkValues = Float32Array.from({ length: 4150 }, (_, index) =>
    index % 148 === 0 ? Number.NaN : Math.fround((index % 997) * 0.1234567));
  const legacyInkJson = JSON.stringify(encodeExternalValue({ lines: inkValues, points: inkValues }));
  const compactInk = encodeExternalValue({ lines: inkValues, points: inkValues }, new Set(), true);
  const compactInkJson = JSON.stringify(compactInk);
  assert.ok(compactInkJson.length <= legacyInkJson.length * 0.4,
    `compact Float32 representation should save at least 60% (${legacyInkJson.length} -> ${compactInkJson.length})`);
  assert.equal(compactInk.lines.$type, "Float32ArrayLE");
  assert.equal(compactInk.points.$type, "Float32ArrayLE", "visual lines and PDF points are both preserved");
  assert.doesNotMatch(compactInkJson, /NonFiniteNumber/);
  const compactRoundTrip = decodeExternalValue(compactInk);
  assert.equal(compactRoundTrip.lines.length, inkValues.length);
  assert.equal(compactRoundTrip.points.length, inkValues.length);
  for (let index = 0; index < inkValues.length; index += 1) {
    if (Number.isNaN(inkValues[index])) {
      assert.equal(Number.isNaN(compactRoundTrip.lines[index]), true, `NaN marker at ${index} must round-trip`);
    } else {
      assert.equal(compactRoundTrip.lines[index], inkValues[index], `Float32 precision at ${index} must be exact`);
    }
  }

  const operation = externalOperation({
    uuid: "annotation-1",
    kind: "Ink",
    pageIndex: 16,
    ref: "42R0",
    action: "upsert",
    timestamp: 1234,
    logical: 8,
    deviceId: "device-a",
    operationId: "actor-a:1234:8:1",
    payload: { editor: binaryPayload },
  });
  assert.deepEqual(Object.keys(operation).sort(), [
    "clock", "deleted", "embeddedRef", "kind", "pageIndex", "payload", "uuid",
  ]);
  assert.deepEqual(operation.clock, {
    timestamp: 1234,
    logical: 8,
    deviceId: "device-a",
    opId: "actor-a:1234:8:1",
  });
  assert.equal(operation.embeddedRef, "42R");
  assert.deepEqual(Array.from(decodeExternalValue(operation.payload.editor).imageData), [0, 7, 255]);

  const tombstone = externalOperation({
    uuid: "annotation-1",
    kind: "Ink",
    pageIndex: 16,
    action: "delete",
    timestamp: 1235,
    logical: 0,
    deviceId: "device-a",
    operationId: "actor-a:1235:0:2",
  });
  assert.equal(tombstone.deleted, true);
  assert.equal(Object.hasOwn(tombstone, "payload"), false);
});

test("free-highlight payloads are distinguished from text highlights for lossless hydration", () => {
  const { externalKindForEditor } = evaluateHelpers(
    ["externalKindForEditor"],
    `function normalizeSyncKind(value) {
      if (value === 9) return "Highlight";
      return value;
    }`,
  );
  assert.equal(externalKindForEditor({ annotationType: 9, quadPoints: [1, 2, 3, 4], outlines: { points: [] } }), "Highlight");
  assert.equal(externalKindForEditor({ annotationType: 9, quadPoints: null, outlines: { points: [0, 1, 2] } }), "InkHighlight");
  assert.equal(externalKindForEditor({ annotationType: 9, inkLists: [[0, 1, 2]] }), "InkHighlight");
});

test("schema 2 snapshots synthesize deletion operations from a compact tombstone ledger", () => {
  const { validateExternalAnnotations, decodeExternalValue, decodeBase64 } = evaluateHelpers(
    ["validateExternalAnnotations", "decodeExternalValue", "decodeBase64"],
    `
      const EXTERNAL_ANNOTATION_KINDS = new Set(["Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText"]);
      function normalizeSyncKind(value) { return value; }
      function canonicalPdfAnnotationRef(value) {
        if (typeof value !== "string") return null;
        const match = /^(\\d+)\\s*(?:R)?(\\d+)?$/.exec(value);
        return match ? match[1] + "R" + (match[2] === "0" ? "" : match[2] || "") : null;
      }
      function normalizeSyncValue(value) { return value; }
    `,
  );
  const tombstone = {
    uuid: "deleted-annotation",
    kind: "Ink",
    pageIndex: 3,
    embeddedRef: null,
    clock: { timestamp: 123, logical: 1, deviceId: "device-a", opId: "delete-1" },
  };
  const normalized = validateExternalAnnotations({
    schemaVersion: 2,
    annotations: [],
    tombstones: [tombstone],
    compactInkEncoding: true,
  });
  assert.equal(normalized.annotations.length, 1);
  assert.equal(normalized.annotations[0].deleted, true);
  assert.equal(normalized.annotations[0].editor, null);
  assert.equal(normalized.compactInkEncoding, true);
  assert.throws(() => validateExternalAnnotations({
    schemaVersion: 2,
    annotations: [],
    tombstones: [{ ...tombstone, deleted: true }],
  }), /must not contain deleted operation rows/);
});

test("hydration waits for host source confirmation and touches only exact embedded references", async () => {
  assert.match(functionSource("handleExternalAnnotationsUpdate"), /\["MATCH", "BASELINE_ESTABLISHED"\]/);
  assert.match(functionSource("applyExternalAnnotationsSnapshot"), /externalSourceIdentityMatchesViewer\(normalized\.source\)/);
  assert.match(functionSource("externalSourceIdentityMatchesViewer"), /identityStatus !== "KNOWN"/);
  assert.match(functionSource("externalSourceIdentityMatchesViewer"), /orderedPageIdentities/);
  assert.match(functionSource("hydrateExternalAnnotation"), /layer\.deserialize\(payload\)/);
  assert.match(functionSource("hydrateExternalAnnotation"), /addHydratedEditor\(layer, editor/);
  assert.match(functionSource("addHydratedEditor"), /layer\.add\(editor\)/);
  assert.match(functionSource("hydrateExternalAnnotation"), /annotationEditorLayer\?\.show\?\.\(\)/);
  assert.match(functionSource("suppressEmbeddedAnnotation"), /querySelectorAll\("\[data-annotation-id\]"\)/);
  assert.match(functionSource("findEmbeddedEditor"), /editor\?\.annotationElementId/);
  assert.match(functionSource("reportAnnotationSourceIdentity"), /pdfDocument\.getPage\(pageIndex \+ 1\)/);
  assert.match(functionSource("reportAnnotationSourceIdentity"), /identityStatus/);
  assert.doesNotMatch(functionSource("reportAnnotationSourceIdentity"), /getPageFingerprint|\.getData\(|\.getOperatorList\(/);
  const open = functionSource("openDocument");
  assert.match(open, /const provisionalExternal = validateExternalAnnotations\(message\.externalAnnotations\)/);
  assert.ok(
    open.indexOf("setNativeAnnotationLayersPending(true, gateToken)") <
      open.indexOf("state.pdfJsOpen.call(app"),
    "native PDF annotations must be gated before PDF.js starts rendering the replacement document",
  );
  assert.doesNotMatch(open, /applyExternalAnnotationsSnapshot\(message\.externalAnnotations/);
  assert.match(open, /state\.readOnly\s*=\s*true/);
  const pendingUpdate = functionSource("schedulePendingExternalAnnotationUpdate");
  assert.match(pendingUpdate, /pending\.identityConfirmed\s*===\s*true\s*\|\|\s*state\.externalSourceConfirmed/);
  assert.match(pendingUpdate, /setReadOnlyState\(state\.readOnly\)/);
  assert.match(functionSource("handleExternalAnnotationsUpdate"), /message\.identityConfirmed\s*!==\s*true/);
  assert.match(functionSource("applyConfirmedNativeAnnotationLayerState"), /setEmbeddedDeletionMask/);
  assert.match(functionSource("applyConfirmedNativeAnnotationLayerState"), /suppressEmbeddedAnnotation/);
  assert.match(functionSource("schedulePendingExternalAnnotationUpdate"), /applyConfirmedNativeAnnotationLayerState\(/);
  assert.match(await readFile(new URL("../viewer-adapter/bridge.css", import.meta.url), "utf8"),
    /pdfReaderNativeAnnotationLayersPending[^\{]*#viewerContainer \.annotationLayer/);
});

test("legacy UUIDs bind by exact annotation object reference before dirty diffs", () => {
  const scope = vm.runInThisContext(`(() => {
    const state = { app: { pdfDocument: { numPages: 2 } }, annotationUuidByPdfRef: new Map() };
    function canonicalPdfAnnotationRef(value) {
      if (typeof value !== "string") return null;
      const match = /^(\\d+)\\s+(\\d+)\\s+R$/.exec(value) || /^(\\d+)R(\\d*)$/.exec(value);
      if (!match) return null;
      const generation = match[2] || match[3] || "0";
      return match[1] + "R" + (generation === "0" ? "" : generation);
    }
    function pdfAnnotationRefKey(value) {
      const match = /^(\\d+)R(\\d*)$/.exec(value || "");
      return match ? match[1] + ":" + (match[2] || "0") : null;
    }
    ${functionSource("normalizeSyncKind")}
    ${functionSource("exactSavedIdentityForOperation")}
    ${functionSource("applyLegacyAnnotationIdentities")}
    return { state, applyLegacyAnnotationIdentities, exactSavedIdentityForOperation };
  })()`);
  scope.applyLegacyAnnotationIdentities([
    { uuid: "legacy-uuid", ref: "42 0 R", pageIndex: 1, kind: "freetext" },
    { uuid: "out-of-range", ref: "43 0 R", pageIndex: 2, kind: "freetext" },
  ]);
  assert.equal(scope.state.annotationUuidByPdfRef.get("42:0"), "legacy-uuid");
  assert.equal(scope.state.annotationUuidByPdfRef.size, 1);
  assert.deepEqual(scope.state.syncState.identities, [
    { uuid: "legacy-uuid", ref: "42R", pageIndex: 1, kind: "FreeText" },
  ], "Sidecar-confirmed identities must be eligible for unchanged native-editor Undo capture");
  assert.deepEqual(scope.exactSavedIdentityForOperation({
    uuid: "legacy-uuid", ref: "42R", pageIndex: 1, kind: "FreeText",
  }), { uuid: "legacy-uuid", ref: "42R", pageIndex: 1, kind: "FreeText", runtimeId: null });
  scope.applyLegacyAnnotationIdentities([
    { uuid: "legacy-uuid", ref: "42R", pageIndex: 1, kind: "FreeText" },
  ]);
  assert.equal(scope.state.syncState.identities.length, 1, "Repeated confirmations are idempotent");
  assert.throws(() => scope.applyLegacyAnnotationIdentities([
    { uuid: "legacy-uuid", ref: "42R", pageIndex: 0, kind: "FreeText" },
  ]), /conflicting page\/type identity/);
  assert.equal(scope.state.syncState.identities[0].pageIndex, 1,
    "A conflicting confirmation cannot replace the verified binding");
  assert.match(functionSource("validateExternalAnnotations"), /legacyIdentityRefs/);
  assert.match(functionSource("openDocument"), /applyLegacyAnnotationIdentities\(provisionalExternal\.legacyIdentities\)/);
});

test("save-boundary capture snapshots the live committed editor when AnnotationStorage is stale", () => {
  const helpers = [
    "getAnnotationStorageRows",
    "refreshAnnotationOperations",
    "captureOperationSnapshot",
    "captureDirtySyncState",
    "captureSyncOperations",
    "markDirtyAnnotation",
    "canonicalPdfAnnotationRef",
    "pdfAnnotationRefKey",
    "getPdfAnnotationRef",
  ].map(functionSource).join("\n");
  const scope = vm.runInThisContext(`(() => {
    const stale = { annotationType: 9, pageIndex: 0, quadPoints: [10, 20, 30, 20, 10, 10, 30, 10] };
    let live = { annotationType: 9, pageIndex: 0, quadPoints: [10, 20, 30, 20, 10, 10, 30, 10] };
    const editor = {
      id: "editor-1", pageIndex: 0, editorType: "Highlight",
      div: { getAttribute: name => name === "aria-label" ? "  exact selected quote  " : null },
      serialize: () => live,
    };
    const manager = { getEditor: id => id === editor.id ? editor : null, getEditors: page => page === 0 ? [editor] : [] };
    const state = {
      app: { pdfDocument: { numPages: 1, annotationStorage: { serializable: { map: new Map([["editor-1", stale]]) } } }, pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } },
      annotationUuidByRuntimeId: new Map([["editor-1", "annotation-1"]]),
      annotationRefByRuntimeId: new Map(), annotationUuidByPdfRef: new Map(), syncState: null,
      annotationSnapshot: new Map([["editor-1", { runtimeId: "editor-1", uuid: "annotation-1", reference: null, operationReference: null, annotationElementId: null, pageIndex: 0, kind: "Highlight", deleted: false, value: stale, signature: JSON.stringify(stale) }]]),
      annotationOperations: [], dirtyAnnotationRevisions: new Map(), dirtyPageRevisions: new Map(),
      dirtyNewAnnotationIds: new Set(), dirtyDeletedAnnotationIds: new Set(),
      restoredSavedAnnotations: new Map(), syncActorId: "actor-1", syncDeviceId: "device-1",
      syncClockTimestamp: 100, syncClockLogical: 0, syncOperationSequence: 0,
    };
    const logs = [];
    function normalizeSyncValue(value) { return JSON.parse(JSON.stringify(value)); }
    function normalizeSyncKind(value) { return value === 9 ? "Highlight" : value === 15 ? "Ink" : value; }
    function externalKindForEditor(value, liveEditor) { return liveEditor?.editorType || normalizeSyncKind(value?.annotationType); }
    const EXTERNAL_ANNOTATION_KINDS = new Set(["Underline", "Square", "Highlight", "Ink", "InkHighlight", "FreeText"]);
    function makeSyncUuid() { return "unexpected-new-uuid"; }
    function makeSyncStamp() { return { timestamp: 101, logical: 1, actorId: "actor-1", deviceId: "device-1", operationId: "actor-1:101:1:1" }; }
    function externalOperation(operation) { return operation; }
    function findLiveSavedEditor() { return null; }
    function runtimeLogRecord(kind, fields) { logs.push({ kind, ...fields }); }
    ${helpers}
    return { state, logs, captureOperationSnapshot, getAnnotationStorageRows, setLive(value) { live = value; } };
  })()`);

  scope.setLive({ annotationType: 9, pageIndex: 0, quadPoints: [10, 20, 30, 20, 10, 10, 30, 10] });
  const snapshot = scope.captureOperationSnapshot(9, "save");
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.operations[0].uuid, "annotation-1");
  assert.equal(snapshot.operations[0].serialized.quadPoints.length, 8);
  assert.equal(snapshot.operations[0].serialized.text, "  exact selected quote  ",
    "the live Highlight's original selection is captured in the durable editor payload");
  assert.equal(snapshot.operations[0].payload.editor.text, "  exact selected quote  ",
    "the quote is persisted in the existing operation payload, not only held by the editor");
  assert.deepEqual(snapshot.dirtyState.dirtyPageIndices, [0]);
  assert.deepEqual(snapshot.missingDirtyIds, []);
  assert.equal(scope.logs.at(-1).liveEditorCount, 1);
  assert.equal(scope.logs.at(-1).operationCount, 1);
  // PDF.js publishes deletion placeholders without a type. Exact UUID-bound
  // previous metadata supplies the original kind instead of Unknown.
  scope.state.app.pdfDocument.annotationStorage.serializable.map.set("editor-1", { deleted: true });
  scope.setLive(null);
  scope.state.app.pdfViewer._layerProperties.annotationEditorUIManager.getEditor = () => null;
  const deleted = scope.getAnnotationStorageRows().get("editor-1");
  assert.equal(deleted.kind, "Highlight");
  assert.equal(deleted.uuid, "annotation-1");
  assert.equal(deleted.deleted, true);

});

test("selecting a saved Square from NONE enters native editing without weakening creation priority", () => {
  const scope = evaluateHelpers(["observeEditorManager", "wrapMethod"], `
    const state = { readOnly: false };
    let mode = 0;
    const calls = [];
    const original = function(options) { calls.push({ receiver: this === manager, options }); return "native-result"; };
    const manager = { getMode: () => mode, updateToolbar: original };
    const app = { pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } } };
    function setMode(value) { mode = value; }
  `, ["state", "manager", "app", "calls", "setMode", "original"]);
  scope.observeEditorManager(scope.app);
  const selection = { mode: 5, editId: "saved-square" };
  assert.equal(scope.manager.updateToolbar(selection), "native-result");
  assert.equal(scope.calls.at(-1).options.mustEnterInEditMode, true,
    "a selected existing Square must use PDF.js's own explicit editing route");
  assert.equal(Object.hasOwn(selection, "mustEnterInEditMode"), false, "caller options are not mutated");
  assert.equal(scope.calls.at(-1).receiver, true);
  for (const options of [{ mode: 5 }, { mode: 3, editId: "saved-text" }, { mode: 15, editId: "saved-ink" }]) {
    scope.manager.updateToolbar(options);
    assert.equal(scope.calls.at(-1).options, options, "tool creation and other editor modes retain native semantics");
  }
  scope.setMode(5);
  scope.manager.updateToolbar(selection);
  assert.equal(scope.calls.at(-1).options, selection, "already-active creation mode is not changed");
  scope.setMode(0); scope.state.readOnly = true;
  scope.manager.updateToolbar(selection);
  assert.equal(scope.calls.at(-1).options, selection, "read-only mode cannot be promoted to editing");
  scope.state.editorManagerCleanup();
  assert.equal(scope.manager.updateToolbar, scope.original, "session cleanup restores the exact native method");
});

test("empty undo/redo does not mark the PDF dirty, while an editor change still does", () => {
  const helpers = [
    "observeEditorManager",
    "annotationRowsChanged",
    "wrapMethod",
  ].map(functionSource).join("\n");
  const scope = vm.runInThisContext(`(() => {
    const state = { revision: 0, editorManagerCleanup: null };
    const app = { rows: new Map([["editor-1", { signature: "before" }]]) };
    let changeOnUndo = false;
    const manager = {
      undo() { if (changeOnUndo) app.rows.set("editor-1", { signature: "after" }); },
      redo() {},
      getEditors() { return []; },
    };
    app.pdfViewer = { _layerProperties: { annotationEditorUIManager: manager } };
    function getAnnotationStorageRows(value) { return new Map(value.rows); }
    function captureSavedEditorHistory() { return []; }
    function snapshotSavedFreeTextEditors() { return { activeEditors: new Set(), editorStates: new Map() }; }
    function liveSidecarFreeTextEditors() { return new Set(); }
    function showRestoredSidecarFreeTextEditors() {}
    function changedSavedFreeTextEditors() { return []; }
    function hasSavedEditorHistoryTransition() { return false; }
    function noteMutation() { state.revision += 1; }
    function reconcileSavedEditorHistory() {}
    function queueFreeTextAppearanceRepair() {}
    function discardDeferredAccessibilityMove() {}
    function runAnnotationObserver(_phase, observe) { return observe(); }
    ${helpers}
    observeEditorManager(app);
    return { state, app, manager, nextUndoChange() { changeOnUndo = true; } };
  })()`);

  scope.manager.undo();
  scope.manager.redo();
  assert.equal(scope.state.revision, 0, "empty history commands must not create phantom dirty revisions");

  scope.nextUndoChange();
  scope.manager.undo();
  assert.equal(scope.state.revision, 1, "a real serialized annotation change must still mark a revision");
});

test("only a complete stable empty annotation diff can settle a stale dirty flag", () => {
  const scope = vm.runInThisContext(`(() => {
      const rows = new Map([["editor-1", { signature: "same" }]]);
      const state = {
        revision: 7, dirty: true, autoSavePending: true, autoSavePaused: true,
        externalSourceMismatch: false, externalSourceConfirmed: true,
        pendingInkCommit: false, freeTextInputPending: false,
        freeTextFocused: false, freeTextCommittedForSave: false,
        annotationSnapshot: rows,
      };
      let restored = null;
      function isEditBoundaryBusy() { return false; }
      function getAnnotationStorageRows() { return new Map(rows); }
      function clearConfirmedDirtyState() {}
      function restoreChanges(_app, snapshot) { restored = snapshot; }
      function runtimeLogRecord() {}
      const app = {
        pdfDocument: { annotationStorage: { resetModified() {} } },
        pdfThumbnailViewer: { hasStructuralChanges() { return false; } },
      };
      state.app = app;
      ${functionSource("annotationRowsChanged")}
      ${functionSource("settleEmptyDirtyRevision")}
      return { state, rows, app, restored: () => restored, annotationRowsChanged, settleEmptyDirtyRevision };
  })()`);
  const { annotationRowsChanged, settleEmptyDirtyRevision, rows } = scope;
  assert.equal(annotationRowsChanged(rows, new Map(rows)), false);
  assert.equal(annotationRowsChanged(rows, new Map([["editor-1", { signature: "changed" }]])), true);

  const validSnapshot = {
    operations: [], missingDirtyIds: [],
    dirtyState: { dirtyAnnotationIds: [], dirtyPageIndices: [] },
    capture: {
      changedAnnotationCount: 0,
      liveEditorSerializationErrorCount: 0,
      liveEditorEnumerationErrorCount: 0,
    },
  };
  assert.equal(settleEmptyDirtyRevision(validSnapshot, 7, scope.app), true);
  assert.equal(scope.state.dirty, false);
  assert.equal(scope.state.autoSavePaused, false);
  assert.deepEqual(scope.restored(), { hadAnnotationChanges: false, hadStructuralChanges: false });

  scope.state.dirty = true;
  assert.equal(settleEmptyDirtyRevision({
    ...validSnapshot,
    dirtyState: { dirtyAnnotationIds: [], dirtyPageIndices: [3] },
  }, 7, scope.app), false, "a dirty page must never be silently discarded");
  assert.equal(scope.state.dirty, true);

  assert.equal(settleEmptyDirtyRevision({
    ...validSnapshot,
    capture: { ...validSnapshot.capture, changedAnnotationCount: 1 },
  }, 7, scope.app), false, "a real annotation diff must remain protected for persistence");
  assert.equal(scope.state.dirty, true);

  assert.equal(settleEmptyDirtyRevision({
    ...validSnapshot,
    capture: { ...validSnapshot.capture, liveEditorSerializationErrorCount: 1 },
  }, 7, scope.app), false, "an incomplete live-editor snapshot must never be treated as clean");
  assert.equal(scope.state.dirty, true);

  assert.match(functionSource("saveOneRevision"), /settleEmptyDirtyRevision\(operationSnapshot, revisionAtStart, app\)/);
  assert.match(functionSource("runRecoverySequence"), /settleEmptyDirtyRevision\(operationSnapshot, revisionAtStart, app\)/);
  assert.match(functionSource("handleFlush"), /result = !isDirty\(\) \|\| closeControl\.annotationBatchDurable/);
});

test("operation snapshot completeness and durable ACK validate every dirty operation", () => {
  const { assertCompleteOperationSnapshot, validateOperationAcknowledgement } = evaluateHelpers(
    ["assertCompleteOperationSnapshot", "validateOperationAcknowledgement"],
    "",
  );
  assert.throws(() => assertCompleteOperationSnapshot({
    operations: [{ uuid: "one" }], missingDirtyIds: ["two"], dirtyState: { dirtyAnnotationIds: ["one", "two"] },
  }, "current PDF"), /complete lossless annotation operation snapshot/);
  assert.equal(validateOperationAcknowledgement({ external: true, operationCount: 2, batchId: "batch-1" }, { operationCount: 2 }), true);
  assert.equal(validateOperationAcknowledgement({ external: true, operationCount: 1, batchId: "batch-1" }, { operationCount: 2 }), false);
  assert.equal(validateOperationAcknowledgement({ operationCount: 2, batchId: "batch-1" }, { operationCount: 2 }), false);
  const save = functionSource("saveOneRevision");
  const recovery = functionSource("runRecoverySequence");
  const checkpoint = functionSource("serializeSyncCheckpoint");
  assert.match(save, /captureOperationSnapshot\(revisionAtStart, "save"\)/);
  assert.match(recovery, /captureOperationSnapshot\(revisionAtStart, "recovery"\)/);
  assert.match(checkpoint, /captureOperationSnapshot\(revisionAtStart, "sync-checkpoint"\)/);
  const ackHandler = region('if (message.type === "recovered")', 'function installAppHooks');
  assert.match(ackHandler, /validateOperationAcknowledgement\(message, pending\)/);
  assert.match(ackHandler, /clearConfirmedDirtyState\(message.revision\)/);
});

test("durable acknowledgements are scoped to the exact document, open request and revision", () => {
  const handler = region('if (message.type === "recovered")', 'function installAppHooks');
  assert.match(handler, /message\.requestId !== pending\.requestId/);
  assert.match(handler, /message\.documentId !== pending\.documentId/);
  assert.match(handler, /message\.openRequest !== pending\.openRequest/);
  assert.match(handler, /message\.revision !== pending\.revision/);
  assert.match(handler, /message\.ok !== true/);
  assert.match(functionSource("recoverySourceIdentity"), /orderedPageIdentities/);
  assert.match(functionSource("recoverySourceIdentity"), /sourceHash/);
});

test("deleted placeholders reuse exact identities and never allocate UUIDs or bypass validation", () => {
  const helpers = ["getAnnotationStorageRows", "normalizeSyncValue", "normalizeSyncKind",
    "externalKindForEditor", "canonicalPdfAnnotationRef", "pdfAnnotationRefKey",
    "getPdfAnnotationRef", "hasNonDegeneratePdfRect", "assertCompleteOperationSnapshot"].map(functionSource).join("\n");
  const scope = vm.runInThisContext(`(() => {
    const EXTERNAL_ANNOTATION_KINDS = new Set(["Ink", "InkHighlight", "Highlight", "Underline", "Square", "FreeText"]);
    let allocated = 0;
    const state = {
      annotationUuidByRuntimeId: new Map(), annotationRefByRuntimeId: new Map(),
      annotationUuidByPdfRef: new Map(), annotationSnapshot: new Map(),
      externalAnnotationRows: new Map(), embeddedDeletionTargets: new Map(), syncState: null,
    };
    const retained = new Map();
    state.app = { pdfDocument: {numPages: 2, annotationStorage: {
      serializable: {map: new Map()}, getRawValue: id => retained.get(id),
    }}, pdfViewer: {_layerProperties: {annotationEditorUIManager: {getEditor: () => null}}} };
    function makeSyncUuid() { allocated++; return "new-live-uuid"; }
    function runtimeLogRecord() {}
    ${helpers}
    return {state, retained, getAnnotationStorageRows, assertCompleteOperationSnapshot, allocated: () => allocated};
  })()`);
  const storage=scope.state.app.pdfDocument.annotationStorage.serializable.map;
  storage.set("retained-editor",{id:"2189R",pageIndex:0,deleted:true});
  assert.throws(()=>scope.getAnnotationStorageRows(), e=>e.code==="annotation-deletion-identity-unresolved");
  assert.equal(scope.allocated(),0,"unbound deletion must not mint an identity");
  assert.equal(scope.state.annotationUuidByRuntimeId.size,0,"failed capture cannot seed a fake UUID");
  assert.throws(()=>scope.assertCompleteOperationSnapshot({missingDirtyIds:["missing"]},"save"),/complete lossless/);

  scope.state.externalAnnotationRows.set("old-uuid",{uuid:"old-uuid",kind:"Ink",pageIndex:0,embeddedRef:"2189R",deleted:true});
  const resolved=scope.getAnnotationStorageRows().get("retained-editor");
  assert.equal(resolved.uuid,"old-uuid");assert.equal(resolved.kind,"Ink");assert.equal(resolved.deleted,true);
  assert.equal(scope.allocated(),0);

  scope.state.annotationUuidByRuntimeId.clear();scope.state.annotationUuidByPdfRef.clear();
  scope.state.externalAnnotationRows.set("ambiguous",{uuid:"ambiguous",kind:"Ink",pageIndex:0,embeddedRef:"2189R"});
  assert.throws(()=>scope.getAnnotationStorageRows(),/no verified annotation UUID\/type binding/);
  assert.equal(scope.allocated(),0);
  scope.state.externalAnnotationRows.clear();

  scope.state.annotationUuidByRuntimeId.set("retained-editor","native-uuid");
  scope.retained.set("retained-editor",{deleted:true,editorType:"Ink",pageIndex:0,serialize(){return {id:"2189R",deleted:true};}});
  assert.equal(scope.getAnnotationStorageRows().get("retained-editor").uuid,"native-uuid");
  assert.equal(scope.allocated(),0,"retained native editor recovers type without new identity");

  storage.clear();scope.state.annotationUuidByRuntimeId.clear();scope.state.annotationUuidByPdfRef.clear();
  storage.set("new-editor",{annotationType:15,pageIndex:0});
  assert.equal(scope.getAnnotationStorageRows().get("new-editor").uuid,"new-live-uuid");
  assert.equal(scope.allocated(),1,"only genuinely new live annotations allocate UUIDs");
});

test("hydration teardown retains exact runtime binding while a native deletion remains in storage", () => {
  const helper=functionSource("clearExternalHydration");
  const scope=vm.runInThisContext(`(() => {
    let retained = {deleted:true};
    const state = {
      app: {pdfDocument:{annotationStorage:{getRawValue:()=>retained}}},
      annotationUuidByRuntimeId:new Map([["old-editor","old-uuid"]]),
      annotationRefByRuntimeId:new Map([["old-editor","2189R"]]),
      annotationUuidByPdfRef:new Map(), externalAnnotationHydration:new Map(),
    };
    function captureDirtySyncState(){return {dirtyAnnotationIds:[]};}
    function getAnnotationEditorManager(){return {getEditor:()=>({remove(){}})};}
    function restoreSuppressedEmbeddedAnnotations(){}
    function stopExternalAnnotationLayerObserver(){}
    function pdfAnnotationRefKey(value){return value;}
    function bind(){state.externalAnnotationHydration.set("old-uuid",{runtimeId:"old-editor",embeddedRef:"2189R",adoptedEmbedded:false});}
    ${helper}
    return {state,clearExternalHydration,bind,clearRetained(){retained=null;}};
  })()`);
  scope.bind();scope.clearExternalHydration();
  assert.equal(scope.state.annotationUuidByRuntimeId.get("old-editor"),"old-uuid");
  assert.equal(scope.state.annotationRefByRuntimeId.get("old-editor"),"2189R");
  scope.clearRetained();scope.bind();scope.clearExternalHydration();
  assert.equal(scope.state.annotationUuidByRuntimeId.size,0);
  assert.equal(scope.state.annotationRefByRuntimeId.size,0);
});

test("confirmed deletion masks are installed before PDF.js receives the document, with source and session guards", () => {
  const helper=functionSource("installInitialDeletionMask");
  const scope=vm.runInThisContext(`(() => {
    const calls=[];const state={annotationController:{setEmbeddedDeletionMask(storage,refs){calls.push(["mask",storage,refs]);}}};
    const session={signal:{aborted:false,addEventListener(){},removeEventListener(){}}};state.openSession=session;
    const original=function(doc){calls.push(["setDocument",doc]);return "native-result";};
    const app={pdfViewer:{setDocument:original}};
    function runtimeLogRecord(){}
    ${helper}
    return {state,session,app,original,calls,installInitialDeletionMask};
  })()`);
  const snapshot={source:{pageCount:1},annotations:[{deleted:true,embeddedRef:"2189R"},{deleted:false,embeddedRef:"2190R"}]};
  const doc={numPages:1,annotationStorage:{}};
  const restore=scope.installInitialDeletionMask(scope.app,scope.session,snapshot,true);
  assert.equal(scope.app.pdfViewer.setDocument(doc),"native-result");
  assert.equal(scope.calls[0][0],"mask");assert.deepEqual(scope.calls[0][2],["2189R"]);
  assert.equal(scope.calls[1][0],"setDocument");restore();assert.equal(scope.app.pdfViewer.setDocument,scope.original);
  scope.calls.length=0;
  const noTrust=scope.installInitialDeletionMask(scope.app,scope.session,snapshot,false);
  scope.app.pdfViewer.setDocument(doc);assert.equal(scope.calls[0][0],"setDocument");noTrust();
  scope.calls.length=0;
  const stale=scope.installInitialDeletionMask(scope.app,scope.session,snapshot,true);scope.session.signal.aborted=true;
  scope.app.pdfViewer.setDocument(doc);assert.equal(scope.calls[0][0],"setDocument");stale();
  scope.calls.length=0;scope.session.signal.aborted=false;
  const wrongPageCount=scope.installInitialDeletionMask(scope.app,scope.session,snapshot,true);
  scope.app.pdfViewer.setDocument({...doc,numPages:2});assert.equal(scope.calls[0][0],"setDocument");wrongPageCount();
});

test("native annotation layers remain gated until exact tombstones are masked and embedded rows are hidden", () => {
  const helpers = [
    functionSource("setNativeAnnotationLayersPending"),
    functionSource("externalAnnotationMaskRows"),
    functionSource("applyConfirmedNativeAnnotationLayerState"),
  ].join("\n");
  const scope = vm.runInThisContext(`(() => {
    const events = [];
    const classes = new Set();
    const document = { documentElement: { classList: {
      add(name) { classes.add(name); events.push("gate:add"); },
      remove(name) { classes.delete(name); events.push("gate:remove"); },
    } } };
    const nativeNodes = new Map([["11R", { hidden: false }], ["22R", { hidden: false }]]);
    const state = {
      externalSourceConfirmed: true,
      externalAnnotationRows: new Map([
        ["deleted", { uuid: "deleted", pageIndex: 0, embeddedRef: "11R", deleted: true }],
        ["live", { uuid: "live", pageIndex: 0, embeddedRef: "22R", deleted: false }],
        ["unmanaged", { uuid: "unmanaged", pageIndex: 0, embeddedRef: null, deleted: false }],
      ]),
      nativeAnnotationGateToken: { documentId: "doc-a", openRequest: 7, sessionId: 3 },
      annotationController: { setEmbeddedDeletionMask(storage, refs) {
        events.push("mask:" + refs.join(","));
      } },
      app: { pdfDocument: { annotationStorage: {} } },
    };
    function canonicalPdfAnnotationRef(value) { return value; }
    function observeExternalAnnotationLayerMutations() { events.push("observe"); }
    function suppressEmbeddedAnnotation(pageIndex, ref) {
      const node = nativeNodes.get(ref);
      if (!node) return false;
      node.hidden = true;
      events.push("hide:" + ref);
      return true;
    }
    function runtimeLogRecord() {}
    ${helpers}
    return { state, classes, events, nativeNodes, setNativeAnnotationLayersPending,
      applyConfirmedNativeAnnotationLayerState };
  })()`);

  const token = scope.state.nativeAnnotationGateToken;
  scope.setNativeAnnotationLayersPending(true, token);
  assert.equal(scope.classes.has("pdfReaderNativeAnnotationLayersPending"), true);
  assert.equal(scope.applyConfirmedNativeAnnotationLayerState("other-doc", 7), false);
  assert.equal(scope.classes.has("pdfReaderNativeAnnotationLayersPending"), true,
    "a stale document update must not reveal the active PDF layer");
  assert.equal(scope.applyConfirmedNativeAnnotationLayerState("doc-a", 7), true);
  assert.deepEqual(scope.events, ["gate:add", "mask:11R", "observe", "hide:11R", "hide:22R", "gate:remove"]);
  assert.equal(scope.classes.has("pdfReaderNativeAnnotationLayersPending"), false);
  assert.equal(scope.nativeNodes.get("11R").hidden, true);
  assert.equal(scope.nativeNodes.get("22R").hidden, true);
  assert.equal(scope.nativeNodes.has("unmanaged"), false,
    "unmanaged native annotations are not suppressed by the external ledger");
});

test("confirmed native mask transitions notify the page renderer before hydration consumes the same mask", () => {
  const scope = evaluateHelpers(["externalAnnotationMaskRows", "applyConfirmedNativeAnnotationLayerState"], `
    const repaints = [];
    let masked = true;
    const row = { uuid: "native-text", pageIndex: 0, embeddedRef: "11R", deleted: false };
    const state = {
      externalSourceConfirmed: true, nativeAnnotationGateToken: null,
      externalAnnotationRows: new Map([[row.uuid, row]]),
      app: { pdfDocument: { annotationStorage: {} } },
      annotationController: { setEmbeddedDeletionMask(_storage, refs) {
        const next = refs.includes("11R"), changed = next !== masked;
        masked = next;
        return changed;
      } },
    };
    function canonicalPdfAnnotationRef(ref) { return ref; }
    function observeExternalAnnotationLayerMutations() {}
    function suppressEmbeddedAnnotation() { return true; }
    function setNativeAnnotationLayersPending() {}
    function runtimeLogRecord() {}
    function repaintEmbeddedAnnotationMaskPages(rows) { repaints.push(rows.map(row => row.uuid)); }
  `, ["state", "repaints"]);
  assert.equal(scope.applyConfirmedNativeAnnotationLayerState("doc", 1), true);
  assert.deepEqual(scope.repaints, [["native-text"]],
    "clearing the durable tombstone must invalidate the page even if a prior undo repair painted the old mask");
  assert.equal(scope.state.annotationController.setEmbeddedDeletionMask({}, []), false,
    "the later hydration sees the already-installed mask and cannot recover a lost repaint notification");
  scope.applyConfirmedNativeAnnotationLayerState("doc", 1);
  assert.equal(scope.repaints.length, 1, "an unchanged confirmed mask does not redraw the page again");
  scope.state.externalAnnotationRows.get("native-text").deleted = true;
  scope.applyConfirmedNativeAnnotationLayerState("doc", 1);
  assert.equal(scope.repaints.length, 2, "redo's mask transition also invalidates its page");
});

test("native mask repaint uses existing loaded page renderers without touching PDF storage or unloaded pages", () => {
  const scope = evaluateHelpers(["repaintEmbeddedAnnotationMaskPages"], `
    const events = [];
    const state = { disposed: false, app: {
      pdfDocument: { get annotationStorage() { throw Error("render invalidation must not write storage"); } },
      pdfViewer: {
        getPageView(index) {
          return index === 0 ? { canvas: {}, update(options) { events.push(["update", index, options]); } } :
            index === 1 ? { update() { throw Error("unloaded page must not be rendered"); } } : null;
        },
        forceRendering() { events.push(["force"]); },
      },
    } };
  `, ["state", "events"]);
  scope.repaintEmbeddedAnnotationMaskPages([
    { pageIndex: 0, embeddedRef: "11R" },
    { pageIndex: 0, embeddedRef: "12R" },
    { pageIndex: 1, embeddedRef: "21R" },
    { pageIndex: 2, embeddedRef: "31R" },
    { pageIndex: 3, embeddedRef: null },
  ]);
  assert.deepEqual(scope.events, [["update", 0, {}], ["force"]],
    "only an already-rendered page with source references is invalidated, once per page");
  scope.events.length = 0;
  scope.repaintEmbeddedAnnotationMaskPages([{ pageIndex: 1, embeddedRef: "21R" }]);
  assert.deepEqual(scope.events, [], "no loaded target means no unrelated forced rendering");
  scope.state.disposed = true;
  scope.repaintEmbeddedAnnotationMaskPages([{ pageIndex: 0, embeddedRef: "11R" }]);
  assert.deepEqual(scope.events, [], "disposed viewers do not repaint");
});
