import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");
const start = source.indexOf("  function clampAnnotationSidebarWidth(");
const end = source.indexOf("\n  function createAnnotationSidebarController(", start);
assert.ok(start >= 0 && end > start);
const clamp = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
test("sidebar drag respects minimum width and leaves 30% for the reader", () => {
  assert.equal(clamp(50, 1000), 240);
  assert.equal(clamp(500, 1000), 500);
  assert.equal(clamp(900, 1000), 700);
  assert.equal(clamp(500, 200), 140);
});
