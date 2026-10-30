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

test("question marks inside quotes do not split a highlighted quotation", () => {
  const text = '上一句。转变为：“你站着不动时我可以摸摸你吗？可以？按响片就赏你好吃的东西。”这是下一句。';
  const glyphs = [...text].map((character, i) => ({character, rects:[{left:i*10,right:i*10+10,top:0,bottom:10}]}));
  const from = text.indexOf("转变为"), to = text.indexOf("这是下一句");
  const result = sentenceForRect(glyphs, {left:from*10,right:to*10,top:0,bottom:10});
  assert.equal(result.text, '转变为：“你站着不动时我可以摸摸你吗？可以？按响片就赏你好吃的东西。”');
});

test("mixed OCR quotation marks do not hide later sentences", () => {
  const text = '以前可能强化了“努力"去做某事和"实际"做到某事是不同的，或许小孩哭喊着"我做不到！"。一般而言，在行为出现前给予礼物，也最可能是要求强化物的行为。下一句。';
  const glyphs = [...text].map((character, i) => ({character, rects:[{left:i*10,right:i*10+10,top:0,bottom:10}]}));
  const i = text.indexOf("出现前");
  const result = sentenceForRect(glyphs, {left:i*10,right:(i+3)*10,top:0,bottom:10});
  assert.equal(result.text, "一般而言，在行为出现前给予礼物，也最可能是要求强化物的行为。");
});

test("square colors and highlight quads share the same original sentence", () => {
  const groupStart = source.indexOf("  function groupSidebarSentenceBoxes(");
  const groupEnd = source.indexOf("\n  function buildAnnotationSidebarViewModels(", groupStart);
  const result = vm.runInNewContext(`(() => {
    const glyphs = [..."甲乙丙丁。"].map((character,i)=>({character,rects:[{left:i*10,right:i*10+10,top:0,bottom:10}]}));
    const viewport = {width:100,height:100,convertToViewportPoint:(x,y)=>[x,y]};
    const root = {getBoundingClientRect:()=>({width:100,height:100})};
    const state = {app:{pdfViewer:{getPageView:()=>({div:root,viewport})}}};
    function textLayerForPage() { return {}; }
    function annotationSidebarTextGlyphs() { return glyphs; }
    ${source.slice(start, end)}
    ${source.slice(groupStart, groupEnd)}
    return groupSidebarSentenceBoxes([
      {uuid:"a",pageIndex:0,kind:"Square",editorPayload:{rect:[0,0,10,10],color:[255,0,0]}},
      {uuid:"b",pageIndex:0,kind:"Square",editorPayload:{rect:[10,0,20,10],color:[0,0,255]}},
      {uuid:"c",pageIndex:0,kind:"Highlight",editorPayload:{quadPoints:[20,0,30,0,20,10,30,10],color:[255,255,0]}}
    ]);
  })()`);
  assert.equal(result.length, 1);
  assert.equal(result[0].displayText, "甲乙丙丁。");
  assert.deepEqual(Array.from(result[0].sentenceStyles, s => [s.kind, s.color]), [
    ["Square", "rgb(255, 0, 0)"], ["Square", "rgb(0, 0, 255)"], ["Highlight", "rgb(255, 255, 0)"]
  ]);
  assert.deepEqual(Array.from(result[0].sentenceChars.slice(0, 3), s => s.owner), [0,1,2]);
});

test("a saved whole-sentence highlight includes spaces and final punctuation", () => {
  const groupStart = source.indexOf("  function groupSidebarSentenceBoxes(");
  const groupEnd = source.indexOf("\n  function buildAnnotationSidebarViewModels(", groupStart);
  const result = vm.runInNewContext(`(() => {
    const glyphs = [..."甲 乙。"].map((character,i)=>({character,rects:[{left:i*10,right:i*10+10,top:0,bottom:10}]}));
    const viewport = {width:100,height:100,convertToViewportPoint:(x,y)=>[x,y]};
    const root = {getBoundingClientRect:()=>({width:100,height:100})};
    const state = {app:{pdfViewer:{getPageView:()=>({div:root,viewport})}}};
    function textLayerForPage() { return {}; }
    function annotationSidebarTextGlyphs() { return glyphs; }
    ${source.slice(start, end)}
    ${source.slice(groupStart, groupEnd)}
    return groupSidebarSentenceBoxes([{uuid:"a",pageIndex:0,kind:"Highlight",editorPayload:{quadPoints:[0,0,25,0,0,10,25,10],text:"甲 乙。",color:[255,255,0]}}]);
  })()`);
  assert.equal(result[0].sentenceChars.map(c=>c.character).join(""), "甲 乙。");
  assert.deepEqual(Array.from(result[0].sentenceChars, c=>c.owner), [0,0,0,0]);
});
