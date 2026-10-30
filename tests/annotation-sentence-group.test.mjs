import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
const start = source.indexOf("  function annotationSentenceForRect(");
const end = source.indexOf("\n  function groupSidebarSentenceBoxes(", start);
assert.ok(start >= 0 && end > start);
const sentenceForRect = vm.runInNewContext(`(${source.slice(start, end).trim()})`);

test("separate boxes in one sentence resolve to the same full original sentence", () => {
  const text = "前文。原则是根本性的真理，它构成了行动的基础，通过行动实现愿望。下一句。";
  const glyphs = [...text].map((character, i) => ({ character, rects: [{left:i*10, right:i*10+9, top:0, bottom:10}] }));
  const rect = (s) => { const i = text.indexOf(s); return {left:i*10, right:(i+s.length)*10, top:0, bottom:10}; };
  const result = ["根本性", "基础", "通过"].map((word) => sentenceForRect(glyphs, rect(word)));
  for (const row of result) assert.equal(row.text, "原则是根本性的真理，它构成了行动的基础，通过行动实现愿望。");
  assert.equal(new Set(result.map((row) => `${row.start}:${row.end}`)).size, 1);
  assert.equal(sentenceForRect(glyphs, {left:-50,right:-40,top:0,bottom:10}), null);
});

test("a character is marked only when at least 90 percent of its area is covered", () => {
  const glyphs = [..."甲乙。"].map((character, i) => ({character, rects:[{left:i*10,right:i*10+10,top:0,bottom:10}]}));
  const atThreshold = sentenceForRect(glyphs, {left:1,right:20,top:0,bottom:10});
  assert.deepEqual(Array.from(atThreshold.covered), [0, 1]);
  const belowThreshold = sentenceForRect(glyphs, {left:1.1,right:20,top:0,bottom:10});
  assert.deepEqual(Array.from(belowThreshold.covered), [1]);
  const vertical = sentenceForRect(glyphs, {left:0,right:20,top:1.1,bottom:10});
  assert.deepEqual(Array.from(vertical.covered), []);
});
