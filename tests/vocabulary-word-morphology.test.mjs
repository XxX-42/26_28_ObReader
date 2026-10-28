import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { analyzeEnglishWord, normalizeWordDisplayMode } from "../viewer-adapter/vocabulary/word-morphology.js";
import { VocabularyController } from "../viewer-adapter/vocabulary/controller.js";

test("reviewed derivations expand nested stems and retain the complete surface", () => {
  for (const [word, expected] of [
    ["creativity", ["create", "-ive", "-ity"]],
    ["international", ["inter-", "nation", "-al"]],
    ["subscription", ["sub-", "script", "-ion"]],
    ["unhappiness", ["un-", "happy", "-ness"]],
    ["reusable", ["re-", "use", "-able"]],
    ["development", ["develop", "-ment"]],
    ["mostly", ["most", "-ly"]],
    ["readability", ["read", "-able", "-ity"]],
    ["unreadable", ["un-", "read", "-able"]],
    ["helpfulness", ["help", "-ful", "-ness"]],
    ["reusability", ["re-", "use", "-able", "-ity"]],
    ["HAPPINESS", ["happy", "-ness"]], ["running", ["run", "-ing"]],
  ]) {
    const result = analyzeEnglishWord(word);
    assert.equal(result.word, word);
    assert.equal(result.supported, true);
    assert.deepEqual(result.parts.map((part) => part.form), expected);
    assert.ok(result.parts.every((part) => part.meaning));
  }
});

test("unknown words, false suffix matches and phrases are never guessed", () => {
  for (const word of ["on", "corner", "business", "butterfly", "uniqueunknownness", "department", "take off", "re-enter", "A".repeat(81), "", null]) {
    assert.equal(analyzeEnglishWord(word).supported, false, String(word));
    assert.deepEqual(analyzeEnglishWord(word).parts, []);
  }
  assert.match(analyzeEnglishWord("subscription").note, /subscribe.*script/);
  assert.equal(normalizeWordDisplayMode("roots"), "roots");
  assert.equal(normalizeWordDisplayMode("anything"), "whole");
});

function runtime(wordDisplayMode = "whole") {
  const posted = [];
  const documentRef = {
    body: { appendChild() {} },
    createElement() {
      return { style: {}, dataset: {}, attributes: {}, listeners: {}, children: [],
        setAttribute(key, value) { this.attributes[key] = value; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener(key, callback) { this.listeners[key] = callback; },
        remove() {}, classList: { toggle() {} } };
    },
  };
  const identity = { documentId: "doc", openRequest: 1 };
  const controller = new VocabularyController({ app: {}, wordDisplayMode, documentRef,
    windowRef: { innerWidth: 900, innerHeight: 700 },
    postToHost(type, payload) { posted.push({ type, ...payload }); return true; },
    getIdentity: () => identity,
  });
  controller.setDocument("doc", 1, true);
  const page = { pageNumber: 1, tokens: [], pageRoot: null };
  controller.showEntryPill({ page, entry: { rawSurface: "creativity", surfaceKey: "creativity", type: "word", startIndex: 0, endIndex: 1 }, requestId: "entry", x: 120, y: 220 });
  return { controller, posted, identity };
}

test("title opens card-only morphology controls; authenticated mode intent does not mutate learning state", () => {
  const { controller, posted, identity } = runtime();
  const pill = controller.entryPill;
  assert.equal(pill.morphology.hidden, true);
  pill.heading.listeners.click({ stopPropagation() {} });
  assert.equal(pill.morphology.hidden, false);
  pill.modeButtons[1].button.listeners.click({ stopPropagation() {} });
  assert.deepEqual(posted.at(-1), { type: "vocab-word-mode-request", mode: "roots", documentId: "doc", openRequest: 1 });
  assert.equal(controller.wordDisplayMode, "whole", "host must confirm persisted setting before visual switch");
  controller.setWordDisplayMode("roots");
  assert.match(pill.morphologyParts.textContent, /create.*-ive.*-ity/);
  assert.equal(pill.heading.textContent, "creativity", "complete original word stays readable");
  assert.equal(pill.modeButtons[1].button.attributes["aria-pressed"], "true");
  assert.ok(!posted.some(({ type }) => ["vocab-set-status", "vocab-page-query"].includes(type)));
  identity.openRequest = 2;
  const count = posted.length;
  pill.modeButtons[0].button.listeners.click({ stopPropagation() {} });
  assert.equal(posted.length, count, "stale document card cannot persist a preference");
  controller.dispose();
});

test("restored global roots preference opens newly created cards and remote updates refresh an open card", () => {
  const { controller } = runtime("roots");
  assert.equal(controller.entryPill.morphology.hidden, false);
  assert.match(controller.entryPill.morphologyParts.textContent, /create/);
  controller.setWordDisplayMode("whole");
  assert.equal(controller.entryPill.morphologyParts.textContent, "creativity");
  controller.dispose();
});

const hostSource = await readFile(new URL("../plugin/main.js", import.meta.url), "utf8");
const bridgeSource = await readFile(new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url), "utf8");

test("host persists one setting and broadcasts only after save; write failure restores confirmed mode", async () => {
  const begin = hostSource.indexOf("  async setVocabularyWordDisplayMode(mode) {");
  const end = hostSource.indexOf("\n  async setLastAnnotationToolMode", begin);
  const queueBegin = hostSource.indexOf("  enqueueSettingsWrite(write) {");
  const queueEnd = hostSource.indexOf("\n  async setAutoSaveEnabled", queueBegin);
  const Host = vm.runInNewContext(`class Host { ${hostSource.slice(queueBegin, queueEnd)} ${hostSource.slice(begin, end)} }; Host`, { Notice: class {} });
  const host = new Host();
  host.settings = { vocabularyWordDisplayMode: "whole" };
  const calls = [];
  host.views = [1, 2].map((id) => ({ setVocabularyWordDisplayMode(mode) { calls.push([id, mode]); } }));
  host.saveData = async (settings) => { calls.push(["save", settings.vocabularyWordDisplayMode]); };
  assert.equal(await host.setVocabularyWordDisplayMode("roots"), true);
  assert.deepEqual(calls, [["save", "roots"], [1, "roots"], [2, "roots"]]);
  host.saveData = async () => { throw new Error("write failed"); };
  assert.equal(await host.setVocabularyWordDisplayMode("whole"), false);
  assert.equal(host.settings.vocabularyWordDisplayMode, "roots");
  assert.deepEqual(calls.slice(-2), [[1, "roots"], [2, "roots"]]);
  let active = 0, maxActive = 0;
  host.saveData = async () => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
  };
  await Promise.all([host.setVocabularyWordDisplayMode("whole"), host.setVocabularyWordDisplayMode("roots")]);
  assert.equal(maxActive, 1, "same host serializes cross-window preference requests");
  assert.equal(host.settings.vocabularyWordDisplayMode, "roots");
});

test("viewer mode broadcast rejects wrong renderer and stale open while preserving pending-open preference", () => {
  const begin = bridgeSource.indexOf("  function handleVocabularyWordDisplayModeMessage(message) {");
  const end = bridgeSource.indexOf("\n  function handleVocabularyEnabledMessage", begin);
  const calls = [];
  const state = { activeDocumentId: "doc", activeOpenRequest: 1,
    requestedDocumentId: "next", requestedOpenRequest: 2,
    pendingVocabularySettings: { documentId: "next", openRequest: 2 },
    vocabularyController: { setWordDisplayMode: (mode) => calls.push(mode) } };
  const apply = vm.runInNewContext(`(${bridgeSource.slice(begin, end).trim()})`, { state, rendererGeneration: "r" });
  assert.equal(apply({ rendererGeneration: "old", documentId: "doc", openRequest: 1, mode: "roots" }), false);
  assert.equal(apply({ rendererGeneration: "r", documentId: "doc", openRequest: 0, mode: "roots" }), false);
  assert.equal(apply({ rendererGeneration: "r", documentId: "doc", openRequest: 1, mode: "roots" }), true);
  assert.equal(apply({ rendererGeneration: "r", documentId: "next", openRequest: 2, mode: "whole" }), true);
  assert.equal(state.pendingVocabularySettings.wordDisplayMode, "whole");
  assert.deepEqual(calls, ["roots", "whole"]);
});
