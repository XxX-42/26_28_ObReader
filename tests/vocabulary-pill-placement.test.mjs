import assert from "node:assert/strict";
import test from "node:test";

import {
  computeVocabularyPillPlacement,
  VocabularyController,
} from "../viewer-adapter/vocabulary/controller.js";

test("pill placement prefers above the occurrence when it fits and keeps its action row nearby", () => {
  const placement = computeVocabularyPillPlacement({
    viewport: { left: 40, top: 20, width: 400, height: 700 },
    anchor: { left: 180, right: 220, top: 610, bottom: 630 },
    width: 220,
    height: 160,
  });

  assert.equal(placement.placement, "above");
  assert.equal(placement.left, 90);
  assert.equal(placement.top, 438);
  assert.equal(placement.top + 160, 598, "the card ends one gap above the tapped word");
  assert.equal(placement.maxWidth, 380);
  assert.ok(placement.maxHeight >= 160);
});

test("pill placement moves below a word near the viewport top", () => {
  const placement = computeVocabularyPillPlacement({
    viewport: { left: 15, top: 25, width: 360, height: 640 },
    anchor: { left: 100, right: 130, top: 45, bottom: 65 },
    width: 240,
    height: 220,
  });

  assert.equal(placement.placement, "below");
  assert.equal(placement.left, 25, "the card is clamped to the viewport's left safe margin");
  assert.equal(placement.top, 77, "below placement starts one gap after the word");
  assert.equal(placement.maxWidth, 340);
  assert.ok(placement.maxHeight >= 220);
});

test("pill placement clamps to an offset visual viewport and caps oversized cards", () => {
  const viewport = { left: 50, top: 70, width: 300, height: 200 };
  const placement = computeVocabularyPillPlacement({
    viewport,
    anchor: { left: 340, right: 350, top: 180, bottom: 190 },
    width: 500,
    height: 260,
  });

  assert.equal(placement.maxWidth, 280);
  assert.equal(placement.left, 60, "the card remains inside the visual viewport's left safe margin");
  assert.equal(placement.top, 80);
  assert.ok(placement.left >= viewport.left + 10);
  assert.ok(placement.left + placement.maxWidth <= viewport.left + viewport.width - 10);
  assert.ok(placement.top >= viewport.top + 10);
  assert.ok(placement.top + placement.maxHeight <= viewport.top + viewport.height - 10);
  assert.equal(placement.maxHeight, 180);
});

test("a short visual viewport keeps the fixed controls inside its safe area", () => {
  const viewport = { left: 100, top: 200, width: 180, height: 110 };
  const placement = computeVocabularyPillPlacement({
    viewport,
    anchor: { left: 120, right: 150, top: 250, bottom: 260 },
    width: 320,
    height: 360,
  });

  assert.equal(placement.maxWidth, 160);
  assert.equal(placement.maxHeight, 90);
  assert.ok(placement.left >= viewport.left + 10);
  assert.ok(placement.left + placement.maxWidth <= viewport.left + viewport.width - 10);
  assert.ok(placement.top >= viewport.top + 10);
  assert.ok(placement.top + placement.maxHeight <= viewport.top + viewport.height - 10);
});

function makeLayoutRuntime() {
  const eventListeners = new Map();
  const viewportListeners = new Map();
  const frames = new Map();
  const removedViewportListeners = [];
  const posted = [];
  let nextFrameId = 0;
  let scanCalls = 0;
  const identity = { documentId: "doc-placement", openRequest: 4 };
  const visualViewport = {
    offsetLeft: 20,
    offsetTop: 30,
    width: 360,
    height: 640,
    addEventListener(type, callback) { viewportListeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (viewportListeners.get(type) === callback) viewportListeners.delete(type);
      removedViewportListeners.push(type);
    },
  };
  const eventBus = {
    _on(type, callback) { eventListeners.set(type, callback); },
    _off(type, callback) { if (eventListeners.get(type) === callback) eventListeners.delete(type); },
  };
  const windowRef = {
    innerWidth: 360,
    innerHeight: 640,
    visualViewport,
    requestAnimationFrame(callback) {
      const id = ++nextFrameId;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(type, callback) { eventListeners.set(`window:${type}`, callback); },
    removeEventListener(type, callback) {
      if (eventListeners.get(`window:${type}`) === callback) eventListeners.delete(`window:${type}`);
    },
  };
  const controller = new VocabularyController({
    app: { pdfViewer: { getVisiblePages: () => ({ views: [] }) } },
    eventBus,
    documentRef: {},
    windowRef,
    postToHost(type, fields) { posted.push({ type, ...fields }); return true; },
    getIdentity: () => ({ ...identity }),
    scan() { scanCalls += 1; return []; },
  });
  controller.setDocument(identity.documentId, identity.openRequest, true);
  const positions = [];
  controller.positionEntryPill = (popup, x, y) => positions.push({ popup, x, y });

  return {
    controller,
    frames,
    positions,
    posted,
    visualViewport,
    viewportListeners,
    removedViewportListeners,
    scanCalls: () => scanCalls,
    flushFrame(id) {
      const callback = frames.get(id);
      frames.delete(id);
      callback?.();
    },
    flushAllFrames() {
      for (const id of [...frames.keys()]) this.flushFrame(id);
    },
  };
}

test("visual viewport events coalesce to geometry-only layout without vocabulary scans or queries", () => {
  const runtime = makeLayoutRuntime();
  const pill = { popup: {}, anchorPoint: { x: 125, y: 240 } };
  runtime.controller.entryPill = pill;

  runtime.viewportListeners.get("resize")();
  runtime.viewportListeners.get("scroll")();
  runtime.viewportListeners.get("resize")();
  assert.equal(runtime.frames.size, 1, "multiple viewport events share one animation frame");
  runtime.flushAllFrames();

  assert.deepEqual(runtime.positions, [{ popup: pill.popup, x: 125, y: 240 }]);
  assert.equal(runtime.scanCalls(), 0, "viewport changes never scan PDF text");
  assert.deepEqual(runtime.posted, [], "viewport changes never send vocabulary queries");
  runtime.controller.dispose();
  assert.deepEqual([...runtime.viewportListeners.keys()], []);
  assert.deepEqual(runtime.removedViewportListeners.sort(), ["resize", "scroll"]);
});

test("a canceled layout frame cannot reposition a replacement pill", () => {
  const runtime = makeLayoutRuntime();
  const original = { popup: {}, anchorPoint: { x: 80, y: 100 } };
  runtime.controller.entryPill = original;
  runtime.controller.scheduleEntryPillLayout();
  const staleFrame = [...runtime.frames.entries()][0];

  runtime.controller.dismissEntryPill();
  const replacement = { popup: {}, anchorPoint: { x: 250, y: 350 } };
  runtime.controller.entryPill = replacement;
  runtime.controller.scheduleEntryPillLayout();
  const replacementFrameId = [...runtime.frames.keys()][0];

  // Simulate a browser delivering a callback after cancelAnimationFrame. The
  // identity guard must neither move the replacement nor clear its live RAF
  // handle, which would permit duplicate layout work on the same frame.
  staleFrame[1]();
  assert.deepEqual(runtime.positions, []);
  assert.equal(runtime.controller.scheduleEntryPillLayout(), false,
    "a stale callback cannot clear the replacement card's pending frame handle");
  assert.equal(runtime.frames.size, 1);
  runtime.flushFrame(replacementFrameId);
  assert.deepEqual(runtime.positions, [{ popup: replacement.popup, x: 250, y: 350 }]);
});
