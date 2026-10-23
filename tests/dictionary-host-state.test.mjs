import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { vocabularyEntryPresentation } from "../viewer-adapter/vocabulary/presentation.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRequire = createRequire(path.join(root, "plugin", "main.js"));

class FakePlugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; }
}
class FakeView {}
class FakeModal {}
class FakeSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = {
      settings: [],
      headings: [],
      empty() { this.settings.length = 0; this.headings.length = 0; },
      createEl(tag, options = {}) {
        const element = { tag, ...options };
        if (tag === "h3") this.headings.push(element.text);
        return element;
      },
    };
  }
}
class FakeSetting {
  constructor(containerEl) {
    this.containerEl = containerEl;
    this.settingEl = { classList: { add() {} } };
    containerEl.settings.push(this);
  }
  setName(value) { this.name = value; return this; }
  setDesc(value) { this.description = value; return this; }
  addToggle(callback) {
    const toggle = {
      value: undefined, handler: null,
      setValue(value) { this.value = value; return this; },
      onChange(handler) { this.handler = handler; return this; },
      change(value) { this.value = value; return this.handler?.(value); },
    };
    callback(toggle);
    this.toggle = toggle;
    return this;
  }
  addButton(callback) {
    const button = {
      text: "", disabled: false, handler: null,
      setButtonText(value) { this.text = value; return this; },
      setTooltip(value) { this.tooltip = value; return this; },
      setDisabled(value) { this.disabled = value; return this; },
      onClick(handler) { this.handler = handler; return this; },
      click() { return this.disabled ? undefined : this.handler?.(); },
    };
    callback(button);
    (this.buttons ||= []).push(button);
    return this;
  }
}

const obsidian = {
  EditableFileView: FakeView,
  Modal: FakeModal,
  Notice: class Notice {},
  Plugin: FakePlugin,
  PluginSettingTab: FakeSettingTab,
  Platform: {},
  Setting: FakeSetting,
  TFile: class TFile {},
  WorkspaceLeaf: class WorkspaceLeaf {},
  normalizePath: (value) => value.replaceAll("\\", "/"),
};
const hostModule = { exports: {} };
const hostSource = `${await readFile(path.join(root, "plugin", "main.js"), "utf8")}\nmodule.exports.__dictionaryHostTest = { PdfReaderView, PdfWebReaderSettingTab };`;
new Function("require", "module", "exports", hostSource)(
  (name) => name === "obsidian" ? obsidian : sourceRequire(name),
  hostModule,
  hostModule.exports,
);
const HostPlugin = hostModule.exports;
const { PdfReaderView, PdfWebReaderSettingTab } = HostPlugin.__dictionaryHostTest;
const fakeLog = {
  record() {},
  begin(fn) { return { fn }; },
  end() {},
};

function makeEntryView({ service, dictionary, initializeVocabulary = async () => {} }) {
  const sent = [];
  const view = Object.create(PdfReaderView.prototype);
  Object.assign(view, {
    plugin: {
      settings: { vocabularyEnabled: true },
      sessionLog: fakeLog,
      initializeVocabulary,
      getVocabularyService: () => service,
      getVocabularyRuntime: async () => ({ mutatePersonal: async (mutate) => mutate(service) }),
      getVocabularyDictionary: () => dictionary,
    },
    documentId: "dictionary-doc",
    openRequest: 7,
    rendererGeneration: "dictionary-renderer",
    teardownStarted: false,
    token: "dictionary-token",
    pendingVocabularySelections: new Map(),
    pendingVocabularyEntryLookups: new Map(),
    vocabularyEntryModal: null,
    postToViewer(message) {
      sent.push({ rendererGeneration: this.rendererGeneration, ...message });
      return true;
    },
  });
  return { view, sent };
}

function entryTap(view, requestId = "entry-1") {
  return view.handleVocabularyBridgeMessage({
    type: "vocab-token-tap",
    rendererGeneration: view.rendererGeneration,
    documentId: view.documentId,
    openRequest: view.openRequest,
    requestId,
    pageNumber: 2,
    key: "alpha",
    rawSurface: "Alpha",
    entryType: "word",
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("entry presentation shows dictionary preparation without assigning personal learning state", () => {
  const presentation = vocabularyEntryPresentation({
    key: "alpha",
    type: "word",
    hasPersonalRecord: false,
    dictionaryLookupState: "preparing",
    dictionaryLookupCount: 275,
    dictionaryLookupTotal: 1000,
    dictionaryLookupPercent: 27,
  });
  assert.equal(presentation.meaningState, "dictionary-preparing");
  assert.equal(presentation.meaningFallbackLabel, "词典准备中 27%");
  assert.equal(presentation.status, null);
  assert.equal(presentation.statusLabel, "无个人学习状态");
});

test("token lookup waits for the vocabulary migration barrier before reading personal state or dictionary", async () => {
  const migration = deferred();
  let initialized = false;
  const service = {
    async getTerm() {
      assert.equal(initialized, true, "the personal store cannot be read before schema migration completes");
      return null;
    },
  };
  const dictionary = {
    getStatus: () => ({ phase: "ready", count: 1, total: 1 }),
    async lookup() {
      assert.equal(initialized, true, "dictionary result must not race vocabulary startup migration");
      return { translation: "阿尔法" };
    },
  };
  const { view, sent } = makeEntryView({
    service,
    dictionary,
    initializeVocabulary: async () => {
      await migration.promise;
      initialized = true;
    },
  });
  const pending = entryTap(view);
  await Promise.resolve();
  assert.equal(sent.length, 0, "the lookup remains pending while migration is unresolved");
  migration.resolve();
  await pending;
  const result = sent.find((message) => message.type === "vocab-entry-result");
  assert.equal(result.record.translation, "阿尔法");
});

test("cold dictionary lookup streams authenticated coarse progress and returns the current personal record", async () => {
  const lookup = deferred();
  const listeners = new Set();
  let currentRecord = { key: "alpha", type: "word", status: 2, translation: "旧释义" };
  let status = { phase: "idle", count: 0, total: 0 };
  let reads = 0;
  const service = {
    async getTerm() { reads += 1; return { ...currentRecord }; },
    async upsertTerm(_surface, patch) {
      currentRecord = { ...currentRecord, ...patch };
      return { ...currentRecord };
    },
    getRevision: () => 4,
  };
  const dictionary = {
    getStatus: () => ({ ...status }),
    subscribe(callback) {
      listeners.add(callback);
      callback({ ...status });
      return () => listeners.delete(callback);
    },
    lookup: () => lookup.promise,
  };
  const { view, sent } = makeEntryView({ service, dictionary });
  const pending = entryTap(view);
  const initial = sent.find((message) => message.type === "vocab-entry-result");
  assert.equal(initial.record.dictionaryLookupState, "preparing");
  assert.equal(initial.record.dictionaryLookupPercent, 0);
  assert.equal(initial.record.status, undefined);
  assert.equal(initial.rendererGeneration, "dictionary-renderer");

  status = { phase: "building", count: 423, total: 1000 };
  for (const listener of listeners) listener({ ...status });
  assert.equal(sent.at(-1).record.dictionaryLookupPercent, 40,
    "progress reports are coarse enough to avoid a per-batch message stream");

  await view.handleVocabularyBridgeMessage({
    type: "vocab-set-status", rendererGeneration: view.rendererGeneration,
    documentId: view.documentId, openRequest: view.openRequest,
    requestId: "status-1", entryRequestId: "entry-1", pageNumber: 2,
    key: "alpha", rawSurface: "Alpha", status: 4, entryType: "word",
  });
  assert.equal(sent.findLast((message) => message.type === "vocab-entry-result").record.status, 4,
    "a status change made while the dictionary loads stays visible in progress updates");

  lookup.resolve({ key: "alpha", translation: "阿尔法", phonetic: "ˈælfə", source: "ECDICT" });
  await pending;
  const final = sent.findLast((message) => message.type === "vocab-entry-result");
  assert.equal(final.record.dictionaryLookupState, "found");
  assert.equal(final.record.status, 4);
  assert.equal(final.record.translation, "旧释义", "the current personal row remains ahead of dictionary fallback data");
  assert.equal(reads, 2, "the host reads the personal row again only when the async dictionary result arrives");
  assert.equal(listeners.size, 0, "the lookup always unsubscribes when it finishes");
  assert.ok(sent.every((message) => message.rendererGeneration === "dictionary-renderer"));
});

test("disabling vocabulary cancels the lookup observer and suppresses stale progress and results", async () => {
  const lookup = deferred();
  const listeners = new Set();
  const service = { async getTerm() { return null; } };
  const dictionary = {
    getStatus: () => ({ phase: "idle", count: 0, total: 0 }),
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    lookup: () => lookup.promise,
  };
  const { view, sent } = makeEntryView({ service, dictionary });
  const pending = entryTap(view);
  assert.equal(sent.length, 1, "the cold popup gets immediate preparation feedback");
  view.plugin.settings.vocabularyEnabled = false;
  view.cancelVocabularyWork();
  assert.equal(listeners.size, 0);
  const countAtDisable = sent.length;
  for (const listener of listeners) listener({ phase: "building", count: 50, total: 100 });
  lookup.resolve(null);
  await pending;
  assert.equal(sent.length, countAtDisable, "no stale progress or completion reaches a disabled Reader");
});

test("LingQ settings expose a live cache row, data folder and explicit rebuild control", async () => {
  const listeners = new Set();
  const dictionary = {
    subscribe(callback) { listeners.add(callback); callback({ phase: "idle", count: 0, total: 0 }); return () => listeners.delete(callback); },
  };
  let rebuilds = 0;
  const plugin = {
    settings: {
      autoSave: true, showStatusBar: false, vocabularyEnabled: true,
      vocabularyHighlightLevels: { words: [1, 2, 3, 4, 5], phrases: [1, 2, 3, 4, 5] },
      vocabularyDisplayMode: "all",
    },
    vocabularyDictionaryStatus: { phase: "idle", count: 0, total: 0 },
    vocabularyDictionary: dictionary,
    isMobileRuntime: false,
    sessionLog: fakeLog,
    rebuildVocabularyDictionaryCache: async () => { rebuilds += 1; },
  };
  const tab = new PdfWebReaderSettingTab({}, plugin);
  plugin.readerSettingsTab = tab;
  tab.display();
  const row = tab.containerEl.settings.find((setting) => setting.buttons?.some((button) => button.text === "重建缓存"));
  assert.ok(row);
  assert.match(row.description, /dictionaries\/ECDICT\/resource-v3/);
  assert.equal(row.buttons[0].text, "重建缓存");
  listeners.values().next().value({ phase: "building", count: 500, total: 1000 });
  assert.match(row.name, /正在建立词典缓存 · 50%/);
  listeners.values().next().value({ phase: "resource-available", entryCount: 770611 });
  assert.match(row.name, /资源已就绪.*按需查询/);
  listeners.values().next().value({ phase: "ready", code: "DICTIONARY_RESOURCE_V3_READY", count: 0, entryCount: 770611 });
  assert.match(row.name, /770,611/);
  listeners.values().next().value({ phase: "degraded", code: "DICTIONARY_RESOURCE_V2_FALLBACK" });
  assert.match(row.name, /旧版缓存可查询/);
  row.buttons[0].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(rebuilds, 1);
  tab.hide();
  assert.equal(listeners.size, 0);
});

test("dictionary resource events cover v3 blocks and verified v2 compatibility resources", () => {
  const plugin = Object.create(HostPlugin.prototype);
  let invalidations = 0, refreshes = 0;
  Object.assign(plugin, {
    sessionLog: fakeLog,
    settings: { vocabularyEnabled: true },
    isUnloading: false,
    vocabularyDictionary: { invalidate() { invalidations += 1; } },
    scheduleVocabularyDictionaryRefresh() { refreshes += 1; },
  });
  const root = "00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v2";
  assert.equal(plugin.handleVocabularyDictionaryResourceChange("Notes/manifest.json"), false);
  assert.equal(plugin.handleVocabularyDictionaryResourceChange(`${root}/shard-aa.jsonl`), false);
  assert.equal(invalidations, 0);
  assert.equal(plugin.handleVocabularyDictionaryResourceChange(`${root}/manifest.json`), true);
  assert.equal(plugin.handleVocabularyDictionaryResourceChange(`${root}/entries.${"a".repeat(64)}.jsonl.gz`), true);
  assert.equal(invalidations, 2);
  assert.equal(refreshes, 2, "the handler schedules a debounced cache refresh rather than scanning the resource per entry");
  const v3 = root.replace(/resource-v2$/u, "resource-v3");
  assert.equal(plugin.handleVocabularyDictionaryResourceChange(`${v3}/manifest.json`), true);
  assert.equal(plugin.handleVocabularyDictionaryResourceChange(`${v3}/blocks/block.${"b".repeat(64)}.jsonl.gz`), true);
  assert.equal(plugin.handleVocabularyDictionaryResourceChange(`${v3}/blocks/block.invalid.jsonl.gz`), false);
  assert.equal(plugin.handleVocabularyDictionaryResourceChange(`${v3}/other/block.${"b".repeat(64)}.jsonl.gz`), false);
  assert.equal(invalidations, 4);
  assert.equal(refreshes, 4);
});

test("enabled dictionary availability is deferred, never starts a full import, and cancels on unload", async () => {
  const plugin = Object.create(HostPlugin.prototype);
  let initialized = 0, availabilityChecks = 0, preparations = 0;
  Object.assign(plugin, {
    sessionLog: fakeLog,
    settings: { vocabularyEnabled: true },
    isUnloading: false,
    vocabularyDictionaryWarmupTimer: null,
    vocabularyDictionaryRefreshTimer: null,
    getVocabularyDictionary() {
      initialized += 1;
      return {
        checkAvailability: async () => { availabilityChecks += 1; },
        ensureReady: async () => { preparations += 1; throw new Error("startup must not import the full dictionary"); },
      };
    },
  });
  assert.equal(plugin.scheduleVocabularyDictionaryWarmup(1), true);
  assert.equal(initialized, 0, "the initial PDF interaction never waits for dictionary construction");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(initialized, 1);
  assert.equal(availabilityChecks, 1);
  assert.equal(preparations, 0);

  plugin.scheduleVocabularyDictionaryWarmup(15);
  plugin.clearVocabularyDictionaryTimers();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(initialized, 1, "unload cleanup cancels a queued preparation timer");
  assert.equal(preparations, 0);
});
