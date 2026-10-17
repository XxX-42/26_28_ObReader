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
