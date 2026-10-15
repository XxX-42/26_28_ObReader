import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const bridgeSource = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(bridgeSource);
  assert.ok(match, `missing function ${name}`);
  const signatureEnd = bridgeSource.indexOf(") {", match.index);
  assert.notEqual(signatureEnd, -1, `missing body for ${name}`);
  const open = signatureEnd + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < bridgeSource.length; index += 1) {
    const char = bridgeSource[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return bridgeSource.slice(match.index, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("ordinary mouse text selection is tracked without pointer capture", () => {
  const guard = functionSource("shouldCaptureTrackedPointer");
  const downStart = bridgeSource.indexOf("function onBridgePointerDown(");
  const downEnd = bridgeSource.indexOf("function shouldCaptureTrackedPointer(", downStart);
  assert.ok(downStart >= 0 && downEnd > downStart);
  const down = bridgeSource.slice(downStart, downEnd);
  assert.match(down, /shouldCaptureTrackedPointer\(\s*pointer,\s*event,/);
  assert.match(down, /state\.activePointers\.set\(event\.pointerId,\s*pointer\)/);
  const shouldCapture = vm.runInNewContext(`(${guard})`);
  assert.equal(shouldCapture(
    { pointerType: "mouse", kind: "text-selection", nativeOperation: null },
    { pointerType: "mouse", button: 0 }, false,
  ), false);
  assert.equal(shouldCapture(
    { pointerType: "mouse", kind: "editor", nativeOperation: null },
    { pointerType: "mouse", button: 0 }, false,
  ), true);
  assert.equal(shouldCapture(
    { pointerType: "mouse", kind: "tool-wheel", nativeOperation: null },
    { pointerType: "mouse", button: 1 }, false,
  ), true);
  assert.equal(shouldCapture(
    { pointerType: "mouse", kind: "right-eraser", nativeOperation: null },
    { pointerType: "mouse", button: 2 }, false,
  ), false);
  assert.equal(shouldCapture(
    { pointerType: "mouse", kind: "editor", nativeOperation: null },
    { pointerType: "mouse", button: 0 }, true,
  ), false);
});
