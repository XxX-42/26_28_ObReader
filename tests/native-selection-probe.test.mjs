import assert from "node:assert/strict";
import test from "node:test";
import { installNativeSelectionProbe } from "./native-selection-probe.mjs";

class FakeEventTarget {
  #listeners = new Map();

  addEventListener(type, listener, capture = false) {
    const rows = this.#listeners.get(type) || [];
    rows.push({ listener, capture });
    this.#listeners.set(type, rows);
  }

  removeEventListener(type, listener, capture = false) {
    const rows = this.#listeners.get(type) || [];
    this.#listeners.set(
      type,
      rows.filter((row) => row.listener !== listener || row.capture !== capture),
    );
  }

  dispatch(type, event = {}) {
    for (const { listener } of [...(this.#listeners.get(type) || [])]) {
      listener({ type, ...event });
    }
  }
}

test("native selection probe is self-contained, bounded, content-safe, and cleanable", () => {
  // Native doc callbacks evaluate serialized source in the viewer realm, so
  // test the exact toString/eval use rather than only the module binding.
  const installFromSource = (0, eval)(`(${installNativeSelectionProbe.toString()})`);
  const d = new FakeEventTarget();
  const w = { getSelection: () => selection };
  const a = { pdfViewer: { annotationEditorMode: 10 } };
  const trace = {};
  const page = { getAttribute: (name) => name === "data-page-number" ? "1" : null };
  const textLayer = {
    className: "textLayer",
    getAttribute: (name) => name === "data-page-number" ? "1" : null,
    closest: (selector) => selector === ".page[data-page-number]" ? page : null,
  };
  const target = {
    nodeType: 1,
    tagName: "SPAN",
    id: "glyph-1",
    className: "text-span",
    closest: (selector) => selector === ".textLayer" ? textLayer : null,
  };
  const anchorNode = { nodeType: 3, parentElement: target };
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode,
    getRangeAt: () => ({
      getClientRects: () => [{ x: 10, y: 20, width: 30, height: 8 }],
    }),
    toString: () => "PRIVATE_ANNOTATION_TEXT",
  };
  d.getSelection = () => selection;

  const cleanup = installFromSource({ d, w, a, trace });
  d.dispatch("pointerdown", {
    isTrusted: true,
    button: 0,
    buttons: 1,
    pointerId: 7,
    pointerType: "mouse",
    clientX: 11,
    clientY: 21,
    target,
  });
  for (let i = 0; i < 304; i += 1) {
    d.dispatch("pointermove", {
      isTrusted: true,
      button: -1,
      buttons: 1,
      pointerId: 7,
      pointerType: "mouse",
      clientX: 12 + i,
      clientY: 21,
      target,
    });
  }
  d.dispatch("selectionchange");
  d.dispatch("pointerup", {
    isTrusted: true,
    button: 0,
    buttons: 0,
    pointerId: 7,
    pointerType: "mouse",
    clientX: 316,
    clientY: 21,
    target,
  });

  const probe = trace.nativeSelectionProbe;
  assert.equal(probe.active, true);
  assert.equal(probe.pointerEvents.length, 300);
  assert.equal(probe.pointerEvents.at(-1).type, "pointerup");
  assert.equal(probe.pointerEvents.at(-1).trusted, true);
  assert.equal(probe.pointerEvents.at(-1).targetTextLayer.found, true);
  assert.equal(probe.pointerEvents.at(-1).mode, 10);
  assert.equal(probe.pointerEvents.at(-1).selection.collapsed, false);
  assert.equal(probe.pointerEvents.at(-1).selection.textLength, "PRIVATE_ANNOTATION_TEXT".length);
  assert.deepEqual(probe.pointerEvents.at(-1).selection.rangeRects, [
    { x: 10, y: 20, width: 30, height: 8 },
  ]);
  assert.equal(probe.selectionChanges.length, 1);
  assert.equal(probe.selectionChanges[0].selection.anchorTextLayer.found, true);
  assert.equal(probe.selectionChanges[0].selection.textLength, "PRIVATE_ANNOTATION_TEXT".length);
  assert.equal(JSON.stringify(probe).includes("PRIVATE_ANNOTATION_TEXT"), false);

  cleanup();
  assert.equal(probe.active, false);
  const countAfterCleanup = probe.pointerEvents.length;
  d.dispatch("pointerup", { target, isTrusted: true, clientX: 0, clientY: 0 });
  d.dispatch("selectionchange");
  assert.equal(probe.pointerEvents.length, countAfterCleanup);
  assert.equal(probe.selectionChanges.length, 1);
});

test("native selection probe records pre-consumption ranges and restores phase listeners and methods", () => {
  const d = new FakeEventTarget(), w = new FakeEventTarget();
  w.performance = { now: () => 42 };
  const selection = { isCollapsed:false, rangeCount:1, anchorNode:null,
    toString:()=>selection.isCollapsed ? "" : "FIXTURE TEXT",
    getRangeAt:()=>({startContainer:null,endContainer:null,startOffset:2,endOffset:8,
      collapsed:selection.isCollapsed,getClientRects:()=>[]}) };
  d.getSelection = () => selection;
  d.querySelectorAll = () => [];
  const prototype = { highlightSelection() { selection.isCollapsed=true; return "created"; } };
  const manager = Object.create(prototype);
  const a = {pdfViewer:{annotationEditorMode:10,_layerProperties:{annotationEditorUIManager:manager}}};
  const trace={};
  const cleanup = installNativeSelectionProbe({d,w,a,trace,captureFixtureText:true});
  d.dispatch("pointerup",{isTrusted:true,clientX:1,clientY:2});
  assert.equal(manager.highlightSelection(),"created");
  const probe = trace.nativeSelectionProbe;
  assert.equal(probe.consumers.length,1);
  assert.equal(probe.consumers[0].before.collapsed,false);
  assert.equal(probe.consumers[0].before.selectedText,"FIXTURE TEXT");
  assert.equal(probe.consumers[0].before.ranges[0].startOffset,2);
  assert.equal(probe.consumers[0].after.collapsed,true);
  assert.ok(probe.eventPhases.some(e=>e.capture));
  assert.ok(probe.eventPhases.some(e=>!e.capture));
  const n=probe.eventPhases.length;
  cleanup();
  assert.equal(Object.hasOwn(manager,"highlightSelection"),false);
  assert.equal(manager.highlightSelection,prototype.highlightSelection);
  d.dispatch("pointerup");w.dispatch("blur");
  assert.equal(probe.eventPhases.length,n);
});
