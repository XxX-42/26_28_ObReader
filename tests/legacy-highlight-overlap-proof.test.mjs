import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const capture = JSON.parse(await readFile(new URL("../evidence/legacy-highlight-protocol/captured-four-line-glyphs.json", import.meta.url)));
const { lines, mismatch } = capture;
const hitGlyphs = mismatch.glyphs.toSorted((a, b) => a.index - b.index);
const byIndex = new Map(hitGlyphs.map(glyph => [glyph.index, glyph]));
// The capture retained non-whitespace hit glyphs and their original TreeWalker
// indexes. Its 26 intervening index gaps are the fixture's literal spaces.
// Newlines are text-layer layout, not text nodes, and recovery must infer them.
const firstIndex = hitGlyphs[0].index;
const lastIndex = hitGlyphs.at(-1).index;
const glyphs = Array.from({ length: lastIndex - firstIndex + 1 }, (_, offset) => {
  const captured = byIndex.get(firstIndex + offset);
  return captured ? { character: captured.character, rects: captured.rects } : { character: " ", rects: [] };
});
const normalize = text => text.replace(/\s+/gu, " ").trim();

// Extract precisely the shipped helper, without reproducing its ownership or
// hit algorithm. Only the already-captured glyph provider and viewport are injected.
const bridge = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
const startMarker = "  function recoverHighlightTextFromTextLayer(";
const endMarker = "\n  function getLegacyHighlightSidebarTargetText(";
assert.equal(bridge.split(startMarker).length - 1, 1);
assert.equal(bridge.split(endMarker).length - 1, 1);
const start = bridge.indexOf(startMarker);
const end = bridge.indexOf(endMarker, start);
assert.ok(end > start);
const helperSource = bridge.slice(start, end).trim();
const recover = new Function("annotationSidebarTextGlyphs", `return (${helperSource});`)(() => glyphs);
const pageRoot = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }) };
const viewport = { width: 1000, height: 1000, convertToViewportPoint: (x, y) => [x, y] };
const quadPoints = lines.flatMap(line => line.quads.flatMap(quad => [
  quad.left, quad.top, quad.right, quad.top, quad.left, quad.bottom, quad.right, quad.bottom,
]));

test("captured legacy four-line fixture retains the observed duplicate-hit evidence", () => {
  assert.equal(hitGlyphs.filter(glyph => glyph.assignedLines.length > 1).length, 30);
  assert.equal(hitGlyphs.length, 73);
  assert.equal(lines.reduce((sum, line) => sum + line.selectedGlyphCount, 0), 103);
  assert.equal(glyphs.map(glyph => glyph.character).join(""), mismatch.selectedText.replace(/\n/gu, ""),
    "captured TreeWalker indexes preserve all original characters and literal space positions");
});

test("real bridge legacy recovery preserves exact captured quote, unique glyphs, and line order", () => {
  const recovered = recover({}, pageRoot, viewport, quadPoints);
  assert.equal(typeof recovered, "string");
  assert.equal(normalize(recovered), normalize(mismatch.selectedText),
    "real legacy helper must reconstruct the exact original four-line selected text");
  assert.deepEqual(recovered.split("\n").map(normalize), mismatch.selectedText.split("\n").map(normalize),
    "real legacy helper must preserve each original line in order");
  assert.equal(recovered.replace(/\s/gu, "").length, 73,
    "each captured non-whitespace glyph must occur once");
});
