import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../viewer-adapter/input/backlink-interaction-controller.js", import.meta.url),
  "utf8",
);

function harness(options = {}) {
  const listeners = new Map();
  const timers = new Map();
  const posted = [];
  let timerId = 0;
  let current = {
    documentId: "doc-1", openRequest: 7, rendererGeneration: "generation-9",
    pageNumber: 2, pageIdentity: "page-2",
  };
  const documentRef = {
    visibilityState: "visible",
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
  };
  const runtimeWindow = { PdfReaderInputRuntime: {} };
  vm.runInNewContext(source, { window: runtimeWindow });
  const Controller = runtimeWindow.PdfReaderInputRuntime.BacklinkInteractionController;
  const controller = new Controller({
    documentRef,
    getCurrentPageState: () => current,
    postToHost(type, fields) { posted.push({ type, ...fields }); return true; },
    setTimeoutFn(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeoutFn(id) { timers.delete(id); },
    ...options,
  });
  const message = {
    documentId: "doc-1", openRequest: 7, rendererGeneration: "generation-9",
    pageNumber: 2, pageIndex: 1, pageIdentity: "page-2",
  };
  const range = {
    startContainer: { isConnected: true },
    endContainer: { isConnected: true },
    getClientRects: () => [{ left: 10, right: 50, top: 20, bottom: 34 }],
  };
  controller.setPageResults(message, [{ kind: "selection", id: "anchor-1", range }]);
  const advanceTimers = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  };
  const dispatch = (type, event) => listeners.get(type)?.(event);
  return {
    controller, current, documentRef, listeners, posted, range, message,
    advanceTimers, dispatch,
    setCurrent(value) { current = value; },
  };
}

function click({ target = { closest: () => null }, detail = 1, x = 30, y = 27 } = {}) {
  return {
    button: 0, detail, clientX: x, clientY: y, target,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
}

test("single selection-backlink click resolves the current Range and posts only target identity", () => {
  const h = harness();
  h.dispatch("click", click());
  assert.equal(h.posted.length, 0, "single click waits briefly so a double-click can cancel it");
  h.advanceTimers();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].type, "reader-backlink-target-open");
  assert.equal(h.posted[0].targetKind, "selection");
  assert.equal(h.posted[0].targetId, "anchor-1");
  assert.equal(h.posted[0].pageIdentity, "page-2");
  assert.equal(h.posted[0].documentId, "doc-1");
  assert.equal(h.posted[0].openRequest, 7);
  assert.equal(h.posted[0].rendererGeneration, "generation-9");
  assert.equal(Object.hasOwn(h.posted[0], "rows"), false);
  h.controller.dispose();
});

test("double-click cancels the pending single-click and opens exactly once", () => {
  const h = harness();
  h.dispatch("click", click({ detail: 1 }));
  h.dispatch("click", click({ detail: 2 }));
  h.dispatch("dblclick", click({ detail: 2 }));
  h.advanceTimers();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].targetId, "anchor-1");
  h.controller.dispose();
});

test("late native double-click does not reopen a target after the single-click settles", () => {
  const h = harness();
  h.dispatch("click", click({ detail: 1 }));
  h.advanceTimers();
  assert.equal(h.posted.length, 1, "a settled single click opens once");
  h.dispatch("click", click({ detail: 2 }));
  h.dispatch("dblclick", click({ detail: 2 }));
  assert.equal(h.posted.length, 1,
    "a native double-click whose system threshold exceeds the settle timer is deduplicated");
  h.controller.dispose();
});

test("annotation and page badges resolve exact identities without Range hit testing", () => {
  const h = harness();
  const annotationBadge = {
    dataset: { backlinkTargetKind: "annotation", backlinkTargetId: "uuid-2" },
  };
  const annotationTarget = { closest: () => annotationBadge };
  const pointerDown = {
    target: annotationTarget,
    stopPropagation() { this.propagationStopped = true; },
    preventDefault() { this.defaultPrevented = true; },
  };
  h.dispatch("pointerdown", pointerDown);
  assert.equal(pointerDown.propagationStopped, true,
    "badge pointerdown must not reach the PDF editor drag handler");
  assert.equal(pointerDown.defaultPrevented, undefined,
    "preserve the browser-generated click after pointerdown");
  const annotationClick = click({ target: annotationTarget, x: -1, y: -1 });
  h.dispatch("click", annotationClick);
  assert.equal(annotationClick.defaultPrevented, true);
  assert.equal(annotationClick.propagationStopped, true);
  h.advanceTimers();
  assert.equal(h.posted[0].targetKind, "annotation");
  assert.equal(h.posted[0].targetId, "uuid-2");

  const pageBadge = { dataset: { backlinkTargetKind: "page", backlinkTargetId: "page-2" } };
  h.dispatch("dblclick", click({ target: { closest: () => pageBadge }, x: -1, y: -1 }));
  assert.equal(h.posted.length, 2);
  assert.equal(h.posted[1].targetKind, "page");
  assert.equal(h.posted[1].targetId, "page-2");
  h.controller.dispose();
});

test("ambiguous overlapping anchors fail closed and Enter/Space activate button badges", () => {
  const h = harness();
  h.controller.setPageResults(h.message, [
    { kind: "selection", id: "anchor-1", range: h.range },
    { kind: "selection", id: "anchor-2", range: h.range },
  ]);
  h.dispatch("dblclick", click());
  assert.equal(h.posted.length, 0, "overlapping distinct anchors are not guessed");

  const badge = { dataset: { backlinkTargetKind: "annotation", backlinkTargetId: "uuid-keyboard" } };
  const target = { closest: () => badge };
  const enter = {
    key: "Enter", target,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
  };
  h.dispatch("keydown", enter);
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].targetId, "uuid-keyboard");
  assert.equal(enter.defaultPrevented, true);
  assert.equal(enter.propagationStopped, true);
  h.dispatch("click", click({ target, detail: 0, x: -1, y: -1 }));
  assert.equal(h.posted.length, 1, "an associated keyboard click event is not sent twice");

  h.dispatch("keydown", { ...enter, key: " " });
  assert.equal(h.posted.length, 2, "a later Space activation remains independently usable");
  h.controller.dispose();
});

test("stale page identity and replaced session never open an old backlink", () => {
  const h = harness();
  h.dispatch("click", click());
  h.controller.clearPage();
  h.advanceTimers();
  assert.equal(h.posted.length, 0);

  h.controller.setPageResults(h.message, [{ kind: "selection", id: "anchor-1", range: h.range }]);
  h.setCurrent({ ...h.current, documentId: "doc-2" });
  h.dispatch("dblclick", click());
  assert.equal(h.posted.length, 0);
  h.controller.dispose();
});

test("same-page page-query results reject an older response that arrives last", () => {
  const h = harness();
  const olderRequest = { ...h.message, requestId: "reader-page-request-1" };
  const currentRequest = { ...h.message, requestId: "reader-page-request-2" };

  assert.equal(typeof h.controller.beginPageRequest, "function",
    "the interaction controller must remember the latest page-query request ID");
  h.controller.beginPageRequest(olderRequest);
  h.controller.beginPageRequest(currentRequest);
  assert.equal(h.controller.setPageResults({ ...currentRequest, backlinkCount: 1 }), true);
  assert.equal(h.controller.setPageResults({ ...olderRequest, backlinkCount: 0 }), false,
    "an older same-page lookup must not replace the newer marker snapshot");
  assert.equal(h.controller.page.requestId, currentRequest.requestId,
    "the active interaction snapshot must remain on the latest result");
  h.controller.clearPage();
  assert.equal(h.controller.setPageResults(h.message), true,
    "legacy fixture results without requestId remain supported when no correlated request is active");
  h.controller.dispose();
});

test("dispose removes delegated listeners and modifier-hover has no preview side effect", () => {
  const h = harness();
  assert.equal(h.listeners.has("pointermove"), false,
    "unsupported modifier-hover preview does not install a polling/hover handler");
  h.controller.dispose();
  assert.equal(h.listeners.size, 0);
});

test("routed pointers use the existing input owner and do not register parallel pointer listeners", () => {
  let allowed = true;
  const h = harness({ routedPointerEvents: true, canActivate: () => allowed });
  for (const type of ["click", "dblclick", "pointerdown"]) assert.equal(h.listeners.has(type), false);
  h.documentRef.elementFromPoint = () => ({ closest: () => null });
  const intent = { type: "click", button: 0, detail: 1, clientPoint: { x: 30, y: 27 } };
  assert.equal(h.controller.handleRoutedPointerEvent(intent, {}), true);
  allowed = false;
  h.advanceTimers();
  assert.equal(h.posted.length, 0, "switching tools while click is pending revokes navigation");
  assert.equal(h.controller.handleRoutedPointerEvent(intent, {}), false);
  allowed = true;
  assert.equal(h.controller.handleRoutedPointerEvent(intent, {}), true);
  h.advanceTimers();
  assert.equal(h.posted.length, 1);
  h.controller.dispose();
  assert.equal(h.listeners.size, 0);
});

test("visibility lifecycle invalidates presentation and refreshes the same page on return", async () => {
  const bridge = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
  const handler = bridge.match(/  function onManualDocumentVisibilityChange\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(handler);
  const calls = [];
  const document = { visibilityState: "hidden" };
  const context = { document, state: { iosDirectManipulationController: {
    onDocumentVisibilityChange() { calls.push("motion"); },
  } }, clearReaderBacklinkPresentation() { calls.push("clear"); },
  requestReaderBacklinksForPage() { calls.push("request-current-page"); } };
  vm.runInNewContext(`${handler}; onManualDocumentVisibilityChange();`, context);
  assert.deepEqual(calls, ["motion", "clear"]);
  document.visibilityState = "visible";
  vm.runInNewContext("onManualDocumentVisibilityChange();", context);
  assert.deepEqual(calls, ["motion", "clear", "motion", "request-current-page"]);
});
