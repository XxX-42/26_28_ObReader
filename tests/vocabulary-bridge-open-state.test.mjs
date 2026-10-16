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
    "queueOpen", "handleVocabularyEnabledMessage", "prepareVocabularyOpen", "bindVocabularyToOpenedDocument",
  ].map(extractFunction).join("\n");
  const api = vm.runInNewContext(`(() => {
    const calls = [];
    const state = {
      disposed: false, ready: false, queuedOpens: [], openQueue: Promise.resolve(),
      requestedOpenRequest: null, requestedDocumentId: null, pendingVocabularySettings: null,
      activeOpenRequest: null, activeDocumentId: null, vocabularyEnabled: false,
      vocabularyController: { setDocument(...args) { calls.push(args); } },
      bulkDeleteDialog: null, embeddedDeletionTargets: new Set(), embeddedDeletionScan: null,
    };
    const rendererGeneration = "generation-current";
    function setVocabularyEnabled(enabled) { state.vocabularyEnabled = enabled === true; }
    function ensureVocabularyController() { return state.vocabularyController; }
    ${functions}
    return { state, calls, queueOpen, handleVocabularyEnabledMessage, prepareVocabularyOpen, bindVocabularyToOpenedDocument };
  })()`, {});

  const first = { documentId: "document-a", openRequest: 1, vocabularyEnabled: false };
  api.queueOpen(first);
  assert.equal(api.state.pendingVocabularySettings.enabled, false);
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-a", openRequest: 1, enabled: true,
  }), true);
  api.prepareVocabularyOpen(first);
  assert.equal(api.state.vocabularyEnabled, true, "the latest toggle is applied when PDF parsing starts");
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-a", openRequest: 1, enabled: false,
  }), true);
  api.bindVocabularyToOpenedDocument("document-a", 1);
  assert.equal(JSON.stringify(api.calls.at(-1)), JSON.stringify([null, null, false]), "a toggle-off during parsing prevents late controller activation");
  assert.equal(api.state.pendingVocabularySettings, null);

  const second = { documentId: "document-b", openRequest: 2, vocabularyEnabled: true };
  api.queueOpen(second);
  api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-b", openRequest: 2, enabled: true,
  });
  api.prepareVocabularyOpen(first);
  api.bindVocabularyToOpenedDocument("document-a", 1);
  assert.equal(JSON.stringify(api.calls.at(-1)), JSON.stringify([null, null, false]), "a stale earlier open cannot attach the controller");

  api.prepareVocabularyOpen(second);
  api.bindVocabularyToOpenedDocument("document-b", 2);
  assert.equal(JSON.stringify(api.calls.at(-1)), JSON.stringify(["document-b", 2, true]), "the newest enabled open attaches only after parse");
  assert.equal(api.state.pendingVocabularySettings, null);

  api.state.activeDocumentId = "document-b";
  api.state.activeOpenRequest = 2;
  assert.equal(api.handleVocabularyEnabledMessage({
    rendererGeneration: "generation-current", documentId: "document-b", openRequest: 2, enabled: false,
  }), true);
  assert.equal(api.state.vocabularyEnabled, false, "a live active-document toggle remains immediate");
});
