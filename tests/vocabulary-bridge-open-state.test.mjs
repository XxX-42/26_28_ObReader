import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridge = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");

function extractFunction(name) {
  const start = bridge.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing ${name}`);
  const body = bridge.indexOf(") {", start) + 2;
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = body; index < bridge.length; index += 1) {
    const char = bridge[index], next = bridge[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockComment) { if (char === "*" && next === "/") { blockComment = false; index += 1; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (["'", '"', "`"].includes(char)) { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return bridge.slice(start, index + 1);
  }
  throw new Error(`Unterminated ${name}`);
}

test("vocabulary enable changes during parsing follow the matching open and ignore stale opens", () => {
  const functions = [
    "normalizeVocabularyDisplayMode", "normalizeAnnotationToolMode", "normalizeVocabularyHighlightLevels",
    "syncVocabularyDisplayModeButton", "setVocabularyDisplayMode",
    "queueOpen", "handleVocabularyEnabledMessage", "requestVocabularyReadMode",
    "syncVocabularyMenuButton",
    "setVocabularyHighlightLevels", "handleVocabularyHighlightLevelsMessage",
    "prepareVocabularyOpen", "bindVocabularyToOpenedDocument",
  ].map(extractFunction).join("\n");
  const api = vm.runInNewContext(`(() => {
    const calls = [];
    const state = {
      disposed: false, ready: false, queuedOpens: [], openQueue: Promise.resolve(),
      requestedOpenRequest: null, requestedDocumentId: null, pendingVocabularySettings: null,
      activeOpenRequest: null, activeDocumentId: null, vocabularyEnabled: false,
      vocabularyHighlightLevels: null, vocabularyDisplayMode: "all",
      bridgeControls: null,
      vocabularyController: {
        setDocument(...args) { calls.push({ method: "setDocument", args }); },
        setHighlightLevels(levels) { calls.push({ method: "setHighlightLevels", levels }); },
        setDisplayMode(mode) { calls.push({ method: "setDisplayMode", mode }); },
      },
      bulkDeleteDialog: null, embeddedDeletionTargets: new Set(), embeddedDeletionScan: null,
    };
    const VOCABULARY_DISPLAY_MODES = ["all", "learning", "focus"];
    const VOCABULARY_DISPLAY_LABELS = { all: "全部等级", learning: "学习中（1–4）", focus: "重点（1–3）" };
    const PERSISTABLE_ANNOTATION_TOOL_MODES = new Set([3, 5, 9, 10, 15]);
    const rendererGeneration = "generation-current";
    function setVocabularyEnabled(enabled) { state.vocabularyEnabled = enabled === true; }
    function ensureVocabularyController() { return state.vocabularyController; }
    ${functions}
    return { state, calls, queueOpen, handleVocabularyEnabledMessage, handleVocabularyHighlightLevelsMessage,
      prepareVocabularyOpen, bindVocabularyToOpenedDocument };
  })()`, { document: { documentElement: { dataset: {} } } });

  const first = { documentId: "document-a", openRequest: 1, vocabularyEnabled: false,
    vocabularyDisplayMode: "focus",
    vocabularyHighlightLevels: { words: [1, 5], phrases: [2, 4] } };
  api.queueOpen(first);
  assert.equal(api.state.pendingVocabularySettings.enabled, false);
  assert.equal(api.state.pendingVocabularySettings.displayMode, "focus");
  assert.equal(api.state.vocabularyDisplayMode, "focus");
  assert.deepEqual(JSON.parse(JSON.stringify(api.state.pendingVocabularySettings.levels)),
    { words: [1, 5], phrases: [2, 4] });
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-a", openRequest: 1, enabled: true,
  }), true);
  api.prepareVocabularyOpen(first);
  assert.equal(api.state.vocabularyEnabled, true, "the latest toggle is applied when PDF parsing starts");
  assert.deepEqual(JSON.parse(JSON.stringify(api.state.vocabularyHighlightLevels)),
    { words: [1, 5], phrases: [2, 4] }, "configured levels are applied before page highlighting");
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-a", openRequest: 1, enabled: false,
  }), true);
  api.bindVocabularyToOpenedDocument("document-a", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.at(-1))),
    { method: "setDocument", args: [null, null, false] }, "a toggle-off during parsing prevents late controller activation");
  assert.equal(api.state.pendingVocabularySettings, null);

  const second = { documentId: "document-b", openRequest: 2, vocabularyEnabled: true };
  api.queueOpen(second);
  api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-b", openRequest: 2, enabled: true,
  });
  api.prepareVocabularyOpen(first);
  api.bindVocabularyToOpenedDocument("document-a", 1);
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.at(-1))),
    { method: "setDocument", args: [null, null, false] }, "a stale earlier open cannot attach the controller");

  api.prepareVocabularyOpen(second);
  api.bindVocabularyToOpenedDocument("document-b", 2);
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.at(-1))),
    { method: "setDocument", args: ["document-b", 2, true] }, "the newest enabled open attaches only after parse");
  assert.equal(api.state.pendingVocabularySettings, null);

  api.state.activeDocumentId = "document-b";
  api.state.activeOpenRequest = 2;
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-b", openRequest: 2, enabled: false,
  }), true);
  assert.equal(api.state.vocabularyEnabled, false, "a live active-document toggle remains immediate");

  assert.equal(api.handleVocabularyHighlightLevelsMessage({
    rendererGeneration: "generation-current", documentId: "document-b", openRequest: 2,
    levels: { words: [3], phrases: [1, 5] },
  }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(api.state.vocabularyHighlightLevels)),
    { words: [3], phrases: [1, 5] }, "live preference changes are applied to an open document");
  assert.deepEqual(JSON.parse(JSON.stringify(api.calls.at(-1))),
    { method: "setHighlightLevels", levels: { words: [3], phrases: [1, 5] } });
});

test("Reader menu waits for host enable before scanning and binds toggles to a pending open", () => {
  const functions = [
    "syncVocabularyMenuButton", "setVocabularyEnabled", "toggleVocabularyFromMenu",
    "handleVocabularyEnabledMessage", "bindVocabularyToOpenedDocument", "requestVocabularyReadMode",
  ].map(extractFunction).join("\n");
  const api = vm.runInNewContext(`(() => {
    const events = [];
    const state = {
      vocabularyEnabled: false, vocabularyController: null, vocabularyHighlightLevels: null,
      app: {}, bridgeControls: null, activeDocumentId: "doc-active", activeOpenRequest: 3,
      requestedDocumentId: "doc-active", requestedOpenRequest: 3, pendingVocabularySettings: null,
    };
    const rendererGeneration = "generation-current";
    function ensureVocabularyController() {
      if (!state.vocabularyController) state.vocabularyController = {
        setDocument(documentId, openRequest, enabled) {
          events.push("scan:" + documentId + ":" + openRequest + ":" + enabled);
        },
        dispose() { events.push("dispose"); },
      };
      return state.vocabularyController;
    }
    function postToHost(type, fields) { events.push("host:" + type + ":" + fields.documentId + ":" + fields.enabled); return true; }
    function showStatus(message) { events.push("status:" + message); }
    ${functions}
    return { state, events, toggleVocabularyFromMenu, handleVocabularyEnabledMessage, bindVocabularyToOpenedDocument };
  })()`, { document: { documentElement: { dataset: {} } } });

  api.toggleVocabularyFromMenu({ preventDefault() {}, stopPropagation() {} });
  assert.equal(api.state.vocabularyEnabled, false, "the viewer does not optimistically enable page queries");
  assert.deepEqual(Array.from(api.events), ["host:vocab-toggle-request:doc-active:true"],
    "the host receives enable before the controller can scan and query visible pages");
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "doc-active", openRequest: 3, enabled: true,
  }), true);
  assert.deepEqual(Array.from(api.events).slice(1), ["scan:doc-active:3:true"],
    "visible-page scanning begins only after the matching host confirmation");

  api.state.activeDocumentId = null;
  api.state.activeOpenRequest = null;
  api.state.vocabularyEnabled = false;
  api.state.requestedDocumentId = "doc-pending";
  api.state.requestedOpenRequest = 4;
  api.state.pendingVocabularySettings = { documentId: "doc-pending", openRequest: 4, enabled: false, levels: null };
  api.toggleVocabularyFromMenu({ preventDefault() {}, stopPropagation() {} });
  assert.equal(api.events.at(-1), "host:vocab-toggle-request:doc-pending:true",
    "a toggle during PDF parsing is sent with the pending document identity instead of being lost locally");
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "doc-pending", openRequest: 4, enabled: true,
  }), true);
  api.state.activeDocumentId = "doc-pending";
  api.state.activeOpenRequest = 4;
  api.bindVocabularyToOpenedDocument("doc-pending", 4);
  assert.equal(api.events.at(-1), "scan:doc-pending:4:true",
    "the pending document scans only after it becomes active with the acknowledged enabled state");
});
