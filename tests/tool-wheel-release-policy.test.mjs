import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewerPath = new URL(
  "../vendor/pdfjs-generic-legacy/web/viewer.mjs",
  import.meta.url,
);

function extractFunction(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `Missing source function: ${start}`);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(endIndex, -1, `Missing function boundary: ${end}`);
  return source.slice(startIndex, endIndex).trim();
}

test("tool wheel closes on outside release while center and sector behavior stay intact", async () => {
  const source = await readFile(viewerPath, "utf8");
  const sectorSource = extractFunction(
    source,
    "function toolWheelSector(wheel, evt) {",
    "function selectToolWheel(index) {",
  );
  const upSource = extractFunction(
    source,
    "function onToolWheelUp(evt) {",
    "function onClick(evt) {",
  );
  const toolWheelSector = new Function(`return (${sectorSource});`)();
  const selected = [];
  let closeCount = 0;
  const closeToolWheel = function () {
    closeCount += 1;
    this._toolWheel = null;
  };
  const selectToolWheel = function (index) {
    selected.push(index);
    this._toolWheel = null;
  };
  const onToolWheelUp = new Function(
    "toolWheelSector",
    "selectToolWheel",
    "closeToolWheel",
    `return (${upSource});`,
  )(toolWheelSector, selectToolWheel, closeToolWheel);
  const makeReader = () => ({
    _toolWheelPointer: 7,
    _toolWheel: {
      x: 100,
      y: 100,
      radius: 96,
      items: Array.from({ length: 6 }, (_, index) => ({ startAngle: 240 + index * 60, endAngle: 300 + index * 60 })),
    },
  });
  const release = (x, y) => ({
    button: 1,
    pointerId: 7,
    clientX: x,
    clientY: y,
    preventDefault() {},
    stopImmediatePropagation() {},
  });

  closeCount = 0;
  selected.length = 0;
  const outsideReader = makeReader();
  onToolWheelUp.call(outsideReader, release(197, 100));
  assert.equal(outsideReader._toolWheel, null, "A release beyond the wheel radius closes it immediately.");
  assert.equal(closeCount, 1);
  assert.deepEqual(selected, []);

  closeCount = 0;
  const centerReader = makeReader();
  onToolWheelUp.call(centerReader, release(100, 100));
  assert.equal(centerReader._toolWheel, null, "Center X release continues to close the wheel.");
  assert.equal(closeCount, 1);

  closeCount = 0;
  selected.length = 0;
  const squareReader = makeReader();
  const squareAngle = (4 * 60 - 90) * Math.PI / 180;
  onToolWheelUp.call(squareReader, release(
    100 + 80 * Math.cos(squareAngle),
    100 + 80 * Math.sin(squareAngle),
  ));
  assert.deepEqual(selected, [4], "Valid sector release still selects its existing tool.");
  assert.equal(closeCount, 0, "A valid sector release does not take the outside-close branch.");
});

test("LingQ sector stays open while previewing and toggles only on middle-button release", async () => {
  const source = await readFile(viewerPath, "utf8");
  const sectorSource = extractFunction(
    source,
    "function toolWheelSector(wheel, evt) {",
    "function selectToolWheel(index) {",
  );
  const moveSource = extractFunction(
    source,
    "function onToolWheelMove(evt) {",
    "function onToolWheelUp(evt) {",
  );
  const upSource = extractFunction(
    source,
    "function onToolWheelUp(evt) {",
    "function onClick(evt) {",
  );
  const toolWheelSector = new Function(`return (${sectorSource});`)();
  const selected = [];
  let closeCount = 0;
  const closeToolWheel = function () {
    closeCount += 1;
    this._toolWheel = null;
  };
  const selectToolWheel = function (index) {
    selected.push(index);
    closeToolWheel.call(this);
  };
  const onToolWheelMove = new Function(
    "toolWheelSector",
    "selectToolWheel",
    "closeToolWheel",
    "TOOL_WHEEL_ITEMS",
    "AnnotationEditorType",
    `return (${moveSource});`,
  )(
    toolWheelSector,
    selectToolWheel,
    closeToolWheel,
    Array.from({ length: 6 }, (_, index) => ({ mode: index === 0 ? null : index })),
    { DISABLE: -1 },
  );
  const onToolWheelUp = new Function(
    "toolWheelSector",
    "selectToolWheel",
    "closeToolWheel",
    `return (${upSource});`,
  )(toolWheelSector, selectToolWheel, closeToolWheel);
  const makeReader = () => ({
    pdfViewer: { annotationEditorMode: 0 },
    _toolWheelPointer: 7,
    _toolWheel: {
      x: 100,
      y: 100,
      radius: 96,
      items: Array.from({ length: 6 }, (_, index) => ({ startAngle: 240 + index * 60, endAngle: 300 + index * 60 })),
      pointerId: 7,
      sectors: Array.from({ length: 6 }, () => {
        const active = new Set();
        return { classList: { toggle(name, enabled) {
          if (enabled) active.add(name);
          else active.delete(name);
        }, contains: (name) => active.has(name) } };
      }),
    },
  });
  const event = (x, y, extra = {}) => ({
    button: 1,
    pointerId: 7,
    clientX: x,
    clientY: y,
    preventDefault() {},
    stopImmediatePropagation() {},
    ...extra,
  });

  closeCount = 0;
  selected.length = 0;
  const reader = makeReader();
  const topPoint = { x: 100, y: 100 - 70 };
  onToolWheelMove.call(reader, event(topPoint.x, topPoint.y));
  assert.ok(reader._toolWheel, "Hovering over LingQ previews without dismissing the wheel.");
  assert.deepEqual(selected, [], "Hovering must not toggle LingQ before the gesture commits.");
  assert.equal(reader._toolWheel.sectors[0].classList.contains("active"), true,
    "The LingQ sector receives the same active preview as tool sectors.");

  const readOnlyReader = makeReader();
  readOnlyReader.pdfViewer.annotationEditorMode = -1;
  onToolWheelMove.call(readOnlyReader, event(topPoint.x, topPoint.y));
  assert.equal(readOnlyReader._toolWheel.sectors[0].classList.contains("active"), true,
    "LingQ remains previewable when annotation editing is disabled.");
  assert.equal(readOnlyReader._toolWheel.sectors[1].classList.contains("active"), false,
    "Read-only annotation tools are not presented as selectable sectors.");

  onToolWheelUp.call(reader, event(topPoint.x, topPoint.y));
  assert.deepEqual(selected, [0], "Releasing on LingQ selects the LingQ action.");
  assert.equal(reader._toolWheel, null, "The wheel closes after the user releases on LingQ.");
  assert.equal(closeCount, 1);
});

test("the tool-wheel LingQ action toggles both on and off", async () => {
  const bridge = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
  const handlerSource = extractFunction(
    bridge,
    "function toggleVocabularyFromToolWheel() {",
    "function toggleVocabularyFromMenu(event) {",
  );
  const calls = [];
  const toggleVocabularyFromMenu = () => calls.push("toggle");
  const handler = new Function("toggleVocabularyFromMenu", `return (${handlerSource});`)(toggleVocabularyFromMenu);
  handler();
  handler();
  assert.deepEqual(calls, ["toggle", "toggle"],
    "The LingQ wheel action must toggle the single persisted state in either direction.");
  assert.match(bridge, /pdf-reader-toggle-lingq/,
    "The Viewer action and the authenticated bridge must use the explicit toggle event.");
});
