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

test("wheel layout keeps annotation tools off and reserves three equal sectors while LingQ is on", async () => {
  const source = await readFile(viewerPath, "utf8");
  const layoutSource = extractFunction(
    source,
    "function toolWheelItemsForState(vocabularyEnabled) {",
    "function closeToolWheel() {",
  );
  const legacyItems = [
    { label: "LingQ 模式", action: "toggle-lingq" },
    { label: "5 文字框" },
    { label: "4 自由画笔" },
    { label: "3 荧光笔" },
    { label: "2 矩形框" },
    { label: "1 下划线" },
  ];
  const toolWheelItemsForState = new Function(
    "TOOL_WHEEL_ITEMS",
    `return (${layoutSource});`,
  )(legacyItems);

  const disabledLayout = toolWheelItemsForState(false);
  assert.equal(disabledLayout.length, 6);
  assert.deepEqual(disabledLayout.map((item) => item.label), legacyItems.map((item) => item.label));
  assert.deepEqual(disabledLayout.map(({ startAngle, endAngle }) => endAngle - startAngle), [60, 60, 60, 60, 60, 60]);

  const enabledLayout = toolWheelItemsForState(true);
  assert.equal(enabledLayout.length, 4);
  assert.equal(enabledLayout[0].label, "退出 LingQ");
  assert.equal(enabledLayout[0].action, "toggle-lingq");
  assert.equal(enabledLayout[0].disabled, undefined);
  assert.deepEqual(enabledLayout.map(({ startAngle, endAngle }) => endAngle - startAngle), [60, 100, 100, 100]);
  assert.deepEqual(enabledLayout.slice(1).map((item) => item.label), ["预留 1", "预留 2", "预留 3"]);
  assert.ok(enabledLayout.slice(1).every((item) => item.disabled === true));
});

test("active LingQ layout hit-tests top exit and all three placeholder arcs", async () => {
  const source = await readFile(viewerPath, "utf8");
  const sectorSource = extractFunction(
    source,
    "function toolWheelSector(wheel, evt) {",
    "function selectToolWheel(index) {",
  );
  const toolWheelSector = new Function(`return (${sectorSource});`)();
  const items = [
    { startAngle: 240, endAngle: 300 },
    { startAngle: 300, endAngle: 400 },
    { startAngle: 400, endAngle: 500 },
    { startAngle: 500, endAngle: 600 },
  ];
  const wheel = { x: 100, y: 100, radius: 96, items };
  const pointAt = (angle) => ({
    clientX: 100 + 70 * Math.cos((angle * Math.PI) / 180),
    clientY: 100 + 70 * Math.sin((angle * Math.PI) / 180),
  });
  assert.equal(toolWheelSector(wheel, pointAt(270)), 0, "The top sector remains the LingQ exit action.");
  assert.deepEqual([350, 450, 550].map((angle) => toolWheelSector(wheel, pointAt(angle))), [1, 2, 3]);
});

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
      items: Array.from({ length: 6 }, (_, index) => ({
        startAngle: 240 + index * 60,
        endAngle: 300 + index * 60,
      })),
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
    `return (${moveSource});`,
  )(toolWheelSector, selectToolWheel, closeToolWheel);
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
      pointerId: 7,
      items: Array.from({ length: 6 }, (_, index) => ({
        startAngle: 240 + index * 60,
        endAngle: 300 + index * 60,
      })),
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

  onToolWheelUp.call(reader, event(topPoint.x, topPoint.y));
  assert.deepEqual(selected, [0], "Releasing on LingQ selects the LingQ action.");
  assert.equal(reader._toolWheel, null, "The wheel closes after the user releases on LingQ.");
  assert.equal(closeCount, 1);
});

test("disabled placeholders do not receive hover selection", async () => {
  const source = await readFile(viewerPath, "utf8");
  const moveSource = extractFunction(
    source,
    "function onToolWheelMove(evt) {",
    "function onToolWheelUp(evt) {",
  );
  const selected = [];
  const toolWheelSector = () => 1;
  const selectToolWheel = (index) => selected.push(index);
  const closeToolWheel = () => {};
  const onToolWheelMove = new Function(
    "toolWheelSector",
    "selectToolWheel",
    "closeToolWheel",
    `return (${moveSource});`,
  )(toolWheelSector, selectToolWheel, closeToolWheel);
  const active = new Set();
  const reader = {
    _toolWheel: {
      pointerId: 7,
      items: [{ disabled: false }, { disabled: true }],
      sectors: [0, 1].map(() => ({ classList: { toggle(name, enabled) {
        if (enabled) active.add(name);
        else active.delete(name);
      } } })),
    },
  };
  onToolWheelMove.call(reader, {
    pointerId: 7,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  assert.equal(active.size, 0);
  assert.deepEqual(selected, []);
  assert.ok(reader._toolWheel, "Hovering a disabled placeholder leaves the wheel open.");
});

test("disabled placeholder selection only closes the wheel", async () => {
  const source = await readFile(viewerPath, "utf8");
  const selectSource = extractFunction(
    source,
    "function selectToolWheel(index) {",
    "function onToolWheelDown(evt) {",
  );
  let closeCount = 0;
  const events = [];
  const closeToolWheel = function () {
    closeCount += 1;
    this._toolWheel = null;
  };
  const selectToolWheel = new Function(
    "closeToolWheel",
    "window",
    "Event",
    "AnnotationEditorType",
    `return (${selectSource});`,
  )(closeToolWheel, { dispatchEvent: (event) => events.push(event.type) }, Event, { DISABLE: 0 });
  const reader = {
    _toolWheel: {
      items: [
        { label: "退出 LingQ", action: "toggle-lingq", mode: null },
        { label: "预留 1", disabled: true, mode: null },
      ],
    },
    pdfViewer: { annotationEditorMode: 3 },
    eventBus: { dispatch() { throw new Error("A placeholder must not switch the PDF tool."); } },
  };

  selectToolWheel.call(reader, 1);
  assert.equal(reader._toolWheel, null);
  assert.equal(closeCount, 1);
  assert.deepEqual(events, []);
});

test("active LingQ exit sector dispatches the existing bridge toggle event", async () => {
  const source = await readFile(viewerPath, "utf8");
  const selectSource = extractFunction(
    source,
    "function selectToolWheel(index) {",
    "function onToolWheelDown(evt) {",
  );
  let closeCount = 0;
  const events = [];
  const closeToolWheel = function () {
    closeCount += 1;
    this._toolWheel = null;
  };
  const selectToolWheel = new Function(
    "closeToolWheel",
    "window",
    "Event",
    "AnnotationEditorType",
    `return (${selectSource});`,
  )(closeToolWheel, { dispatchEvent: (event) => events.push(event.type) }, Event, { DISABLE: 0 });
  const reader = {
    _toolWheel: {
      items: [{ label: "退出 LingQ", action: "toggle-lingq", mode: null }],
    },
  };

  selectToolWheel.call(reader, 0);
  assert.equal(reader._toolWheel, null);
  assert.equal(closeCount, 1);
  assert.deepEqual(events, ["pdf-reader-toggle-lingq"]);
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
