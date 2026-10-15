import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const bridgePath = new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url);
const bridgeSource = await readFile(bridgePath, "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(bridgeSource);
  assert.ok(match, `missing function ${name}`);
  const start = match.index;
  const signatureEnd = bridgeSource.indexOf(") {", start);
  assert.notEqual(signatureEnd, -1, `missing body for ${name}`);
  const open = signatureEnd + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < bridgeSource.length; index += 1) {
    const char = bridgeSource[index];
    const next = bridgeSource[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return bridgeSource.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("mouse text selection remains tracked without taking pointer capture", () => {
  const guardSource = functionSource("shouldCaptureTrackedPointer");
  const pointerDownSource = functionSource("onBridgePointerDown");
  const pointerMoveSource = functionSource("onBridgePointerMove");
  const pointerEndSource = functionSource("onBridgePointerEnd");
  const pointerOutSource = functionSource("onBridgePointerOut");
  assert.match(pointerDownSource, /shouldCaptureTrackedPointer\(\s*pointer,\s*event,/,
    "pointerdown must use the tested capture guard");
  assert.match(pointerDownSource, /state\.activePointers\.set\(event\.pointerId,\s*pointer\)/,
    "mouse text selection must remain in the bridge's tracking lifecycle");
  assert.match(pointerDownSource, /recordPointerDiagnostic\("pointerdown",\s*pointer,\s*event\)/,
    "pointer tracking diagnostics must remain active");
  assert.match(pointerMoveSource, /state\.activePointers\.get\(event\.pointerId\)/,
    "the captured-or-native gesture must still update its tracked boundary");
  assert.match(pointerEndSource,
    /finishTrackedPointer\(event\.pointerId,\s*event\.type\s*\|\|\s*"pointerup"/,
    "pointerup and pointercancel must still finish the tracked boundary");
  assert.match(pointerOutSource, /event\.relatedTarget\s*!==\s*null/,
    "pointerout within the document must not cancel an active gesture");
  assert.match(pointerOutSource,
    /finishTrackedPointer\(event\.pointerId,\s*"pointerout",\s*event,\s*\{\s*cancel:\s*true\s*\}\)/,
    "leaving the document without capture must cancel and retire the tracked boundary");

  const shouldCapture = vm.runInNewContext(`(${guardSource})`);
  const cases = [
    {
      name: "left mouse text selection does not capture",
      pointer: { pointerType: "mouse", kind: "text-selection", nativeOperation: null },
      event: { pointerType: "mouse", button: 0 },
      eraserActive: false,
      expected: false,
    },
    {
      name: "mouse editor gesture still captures",
      pointer: { pointerType: "mouse", kind: "editor", nativeOperation: null },
      event: { pointerType: "mouse", button: 0 },
      eraserActive: false,
      expected: true,
    },
    {
      name: "mouse native editor operation still captures",
      pointer: { pointerType: "mouse", kind: "editor", nativeOperation: "move" },
      event: { pointerType: "mouse", button: 0 },
      eraserActive: false,
      expected: true,
    },
    {
      name: "mouse editor resize still captures",
      pointer: { pointerType: "mouse", kind: "editor", nativeOperation: "resize" },
      event: { pointerType: "mouse", button: 0 },
      eraserActive: false,
      expected: true,
    },
    {
      name: "pen native editor operation still captures",
      pointer: { pointerType: "pen", kind: "editor", nativeOperation: "resize" },
      event: { pointerType: "pen", button: 0 },
      eraserActive: false,
      expected: true,
    },
    {
      name: "pen text selection remains uncaptured",
      pointer: { pointerType: "pen", kind: "text-selection", nativeOperation: null },
      event: { pointerType: "pen", button: 0 },
      eraserActive: false,
      expected: false,
    },
    {
      name: "middle-button tool wheel behavior is unchanged",
      pointer: { pointerType: "mouse", kind: "tool-wheel", nativeOperation: null },
      event: { pointerType: "mouse", button: 1 },
      eraserActive: false,
      expected: true,
    },
    {
      name: "right-button eraser behavior remains uncaptured",
      pointer: { pointerType: "mouse", kind: "right-eraser", nativeOperation: null },
      event: { pointerType: "mouse", button: 2 },
      eraserActive: false,
      expected: false,
    },
    {
      name: "left-button editor eraser behavior remains uncaptured",
      pointer: { pointerType: "mouse", kind: "editor", nativeOperation: null },
      event: { pointerType: "mouse", button: 0 },
      eraserActive: true,
      expected: false,
    },
  ];
  for (const { name, pointer, event, eraserActive, expected } of cases) {
    assert.equal(Boolean(shouldCapture(pointer, event, eraserActive)), expected, name);
  }
});
