import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Pure captured-geometry proof. The original browser test still requires exact
// normalized selected text plus its one/two/four-line geometry assertions.
const capture = JSON.parse(await readFile(new URL("../evidence/legacy-highlight-protocol/captured-four-line-glyphs.json", import.meta.url)));
const { lines, mismatch } = capture;
const glyphs = mismatch.glyphs.toSorted((a, b) => a.index - b.index);
function eligibleScores(glyph, line) {
  return glyph.rects.flatMap(rect => line.quads.flatMap(quad => {
    const width = rect.right - rect.left, height = rect.bottom - rect.top;
    const overlapWidth = Math.max(0, Math.min(rect.right, quad.right) - Math.max(rect.left, quad.left));
    const centerX = (rect.left + rect.right) / 2, centerY = (rect.top + rect.bottom) / 2;
    if (!(width > 0 && height > 0) || centerY < quad.top - 1 || centerY > quad.bottom + 1 ||
        !(overlapWidth / width >= 0.35 || centerX >= quad.left && centerX <= quad.right)) return [];
    return [Math.max(0, Math.min(rect.bottom, quad.bottom) - Math.max(rect.top, quad.top)) / height];
  }));
}

test("captured legacy quads assign 30 glyphs to adjacent lines under the current predicate", () => {
  let duplicates = 0;
  for (const glyph of glyphs) {
    const eligible = lines.flatMap((line, index) => eligibleScores(glyph, line).length ? [index] : []);
    assert.deepEqual(eligible, glyph.assignedLines);
    if (eligible.length > 1) duplicates += 1;
  }
  assert.equal(duplicates, 30);
  assert.equal(glyphs.length, 73);
  assert.equal(lines.reduce((sum, line) => sum + line.selectedGlyphCount, 0), 103);
});

test("maximum vertical overlap uniquely restores the captured non-whitespace glyph order", () => {
  const owned = lines.map(() => []);
  for (const glyph of glyphs) {
    const scores = lines.map(line => Math.max(-1, ...eligibleScores(glyph, line)));
    const owner = scores.indexOf(Math.max(...scores));
    assert.ok(scores[owner] >= 0);
    owned[owner].push(glyph);
  }
  const recovered = owned.map(row => row.map(glyph => glyph.character).join("")).join("");
  assert.equal(recovered, mismatch.selectedText.replace(/\s/gu, ""));
  assert.deepEqual(owned.map(row => row.map(glyph => glyph.character).join("")),
    mismatch.selectedText.split("\n").map(line => line.replace(/\s/gu, "")));
  assert.equal(owned.flat().length, 73);
});
