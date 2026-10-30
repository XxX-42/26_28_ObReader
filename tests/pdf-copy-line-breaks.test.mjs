import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
const start = source.indexOf("  function normalizeCopiedPdfText(value) {");
const end = source.indexOf("\n  function selectedPdfText()", start);
assert.ok(start >= 0 && end > start);
const normalize = vm.runInNewContext(`(${source.slice(start, end).trim()})`);

test("PDF copy joins Chinese visual lines and keeps punctuation", () => {
  assert.equal(normalize("我记 \n得初级训犬课列有多本推荐书目，其中一本就是《别毙了那 \n只狗》。"),
    "我记得初级训犬课列有多本推荐书目，其中一本就是《别毙了那只狗》。");
});

test("PDF copy preserves blank paragraph breaks and word spacing", () => {
  assert.equal(normalize("First line\r\nsecond line\n\n下一段\n文字。"), "First line second line\n\n下一段文字。");
});

test("PDF copy keeps a paragraph break after a Chinese sentence ending", () => {
  assert.equal(normalize("其中一本就是《别毙了那\n只狗》。\n这本书被美国宠物犬训练师协会"),
    "其中一本就是《别毙了那只狗》。\n这本书被美国宠物犬训练师协会");
});
