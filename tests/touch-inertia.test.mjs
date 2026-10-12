import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
const section = source.slice(source.indexOf("  const MANUAL_INERTIA_SAMPLE_WINDOW_MS"), source.indexOf("  function clearManualPointerSessions"));
function harness() {
  let time = 0, frameId = 0, top = 100, left = 0;
  const frames = new Map();
  const container = {
    isConnected: true, scrollHeight: 10000, clientHeight: 500,
    scrollWidth: 500, clientWidth: 500,
    get scrollTop() { return top; }, set scrollTop(v) { top = Math.max(0, Math.min(9500, v)); },
    get scrollLeft() { return left; }, set scrollLeft(v) { left = Math.max(0, Math.min(0, v)); },
  };
  const pdfDocument = {};
  const state = { app: { pdfDocument }, activeDocumentId: "doc", activeOpenRequest: 1, manualPointers: new Map(), manualMomentum: null };
  const context = {
    state, rendererGeneration: 1, iosInputPolicy: true,
    window: { matchMedia: () => ({ matches: false }) },
    performance: { now: () => time },
    requestAnimationFrame(fn) { const id = ++frameId; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    releasePointerCapture() {},
  };
  vm.runInNewContext(section + "\nglobalThis.api = { startManualMomentum, finishManualPointer };", context);
  const pointer = { pointerId: 1, pointerType: "touch", container, pdfDocument,
    documentId: "doc", openRequest: 1, rendererGeneration: 1,
    startX: 50, startY: 300, startScrollTop: 0, startScrollLeft: 0,
    lastX: 50, lastY: 200, moved: true, lastMotionAt: 100,
    scrollSamples: [{ time: 0, scrollTop: 0, scrollLeft: 0 }, { time: 100, scrollTop: 100, scrollLeft: 0 }] };
  return { state, pointer, container, api: context.api,
    setTime(t) { time = t; },
    advance(t) { while (time < t) { time = Math.min(t, time + 16); const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(time); } },
  };
}

test("finger inertia decelerates below its launch threshold before stopping", () => {
  const h = harness(); h.setTime(100); h.api.startManualMomentum(h.pointer);
  h.advance(1000); const tailStart = h.container.scrollTop;
  h.advance(1200);
  assert.ok(h.container.scrollTop > tailStart + 3, "The slow tail must still move instead of cutting off at 120 px/s");
  h.advance(1800); assert.equal(h.state.manualMomentum, null);
  const stopped = h.container.scrollTop; h.advance(2000); assert.equal(h.container.scrollTop, stopped);
});

test("finger release consumes the final pointerup position before starting momentum", () => {
  const h = harness(); h.state.manualPointers.set(1, h.pointer); h.setTime(116);
  h.api.finishManualPointer(1, { clientX: 50, clientY: 160 });
  assert.equal(h.container.scrollTop, 140);
  assert.equal(h.state.manualPointers.size, 0);
  assert.ok(h.state.manualMomentum);
  h.advance(148); assert.ok(h.container.scrollTop > 140);
});

test("cancelled finger does not apply terminal coordinates or start momentum", () => {
  const h = harness(); h.state.manualPointers.set(1, h.pointer); h.setTime(116);
  h.api.finishManualPointer(1, { clientX: 50, clientY: 160 }, { cancel: true });
  assert.equal(h.container.scrollTop, 100);
  assert.equal(h.state.manualMomentum, null);
  assert.equal(h.state.manualPointers.size, 0);
});
