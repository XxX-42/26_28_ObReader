import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url),
  "utf8",
);

function functionSource(name) {
  let start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
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
    if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function fakeButton(id, text = "") {
  const buttonAttributes = new Map([["data-l10n-id", `pdfjs-${id}-button`]]);
  const labelAttributes = new Map([["data-l10n-id", `pdfjs-${id}-button-label`]]);
  const label = {
    textContent: text,
    removeAttribute(name) { labelAttributes.delete(name); },
    getAttribute(name) { return labelAttributes.get(name) ?? null; },
  };
  return {
    id,
    title: "",
    attributes: buttonAttributes,
    label,
    querySelector(selector) { return selector === "span" ? label : null; },
    removeAttribute(name) { buttonAttributes.delete(name); },
    setAttribute(name, value) { buttonAttributes.set(name, String(value)); },
    getAttribute(name) { return buttonAttributes.get(name) ?? null; },
  };
}

function runFallback(language) {
  const buttons = new Map([
    ["presentationMode", fakeButton("presentationMode")],
    ["firstPage", fakeButton("firstPage")],
    ["cursorSelectTool", fakeButton("cursorSelectTool")],
    ["documentProperties", fakeButton("documentProperties", "已有译文")],
  ]);
  const apply = vm.runInNewContext(`(${functionSource("labelSecondaryToolbarControls")})`, {
    document: { getElementById: id => buttons.get(id) || null },
    window: { navigator: { language } },
  });
  apply();
  return buttons;
}

test("secondary toolbar fallback labels replace missing Fluent text without overwriting translations", () => {
  const chinese = runFallback("zh-CN");
  assert.equal(chinese.get("presentationMode").label.textContent, "演示模式");
  assert.equal(chinese.get("firstPage").label.textContent, "转到第一页");
  assert.equal(chinese.get("cursorSelectTool").label.textContent, "文本选择工具");
  assert.equal(chinese.get("presentationMode").title, "演示模式");
  assert.equal(chinese.get("presentationMode").getAttribute("aria-label"), "演示模式");
  assert.equal(chinese.get("presentationMode").getAttribute("data-l10n-id"), null);
  assert.equal(chinese.get("presentationMode").label.getAttribute("data-l10n-id"), null);
  assert.equal(chinese.get("documentProperties").label.textContent, "已有译文");

  const english = runFallback("en-US");
  assert.equal(english.get("firstPage").label.textContent, "Go to First Page");
});
