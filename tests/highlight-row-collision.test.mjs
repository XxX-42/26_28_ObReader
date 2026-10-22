import assert from "node:assert/strict";
import test from "node:test";
import { separateOverlappingRangeRects } from "../viewer-adapter/vocabulary/canvas-overlay.js";

test("PDF highlight rows from separate annotations keep their centers and a one-pixel visual gap", () => {
  const source = [
    { x: 12, y: 100, width: 96, height: 14, color: "#ff0000", editorId: "left", boxIndex: 0 },
    { x: 24, y: 109, width: 104, height: 14, color: "#0000ff", editorId: "right", boxIndex: 0 },
  ];
  const untouched = structuredClone(source);
  const result = separateOverlappingRangeRects(source);

  assert.equal(result.changed, true);
  assert.deepEqual(source, untouched, "the shared solver must not mutate canonical input boxes");
  assert.equal(result.rectangles.length, 2);
  assert.deepEqual(result.rectangles.map(({ color, editorId, boxIndex }) => ({ color, editorId, boxIndex })), [
    { color: "#ff0000", editorId: "left", boxIndex: 0 },
    { color: "#0000ff", editorId: "right", boxIndex: 0 },
  ]);
  const [upper, lower] = result.rectangles;
  assert.equal(upper.y + upper.height / 2, 107);
  assert.equal(lower.y + lower.height / 2, 116);
  assert.ok(Math.abs(lower.y - (upper.y + upper.height) - 1) < 1e-9);
});
test("same-line highlights and independent columns are not squeezed", () => {
  const sameLine = [
    { x: 8, y: 100, width: 60, height: 14, color: "#f00" },
    { x: 20, y: 103, width: 65, height: 14, color: "#0f0" },
  ];
  const columns = [
    { x: 0, y: 100, width: 30, height: 14, color: "#f00" },
    { x: 50, y: 109, width: 30, height: 14, color: "#0f0" },
  ];

  for (const input of [sameLine, columns]) {
    const result = separateOverlappingRangeRects(input);
    assert.equal(result.changed, false);
    assert.deepEqual(result.rectangles, input);
  }
});

test("paint adapters can reserve renderer-specific antialias bleed without moving row centers", () => {
  const source = [
    { x: 10, y: 20, width: 90, height: 14, color: "#f00" },
    { x: 15, y: 29, width: 90, height: 14, color: "#00f" },
  ];
  const result = separateOverlappingRangeRects(source, { gapPx: 4 });
  assert.equal(result.changed, true);
  const [upper, lower] = result.rectangles;
  assert.equal(upper.y + upper.height / 2, 27);
  assert.equal(lower.y + lower.height / 2, 36);
  assert.equal(lower.y - (upper.y + upper.height), 4);
});

test("dense page-sized row sets are grouped and preserve every annotation box", () => {
  const rectangles = [];
  for (let row = 0; row < 357; row += 1) {
    for (let item = 0; item < 12; item += 1) {
      rectangles.push({
        x: item * 2,
        y: row * 18,
        width: 1,
        height: 12,
        editorId: `editor-${row}-${item}`,
        boxIndex: item,
        color: item % 2 ? "#00f" : "#f00",
      });
    }
  }
  const result = separateOverlappingRangeRects(rectangles);
  assert.equal(result.changed, false);
  assert.equal(result.rectangles.length, 357 * 12);
  assert.equal(new Set(result.rectangles.map(({ editorId, boxIndex }) => `${editorId}:${boxIndex}`)).size, 357 * 12);
});
