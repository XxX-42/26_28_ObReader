import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createVocabularyWorkbench, PAGE_SIZE } = require("../plugin/vocabulary/workbench.cjs");

class FakeElement {
  constructor(tagName, options = {}, parent = null) {
    this.tagName = tagName.toLowerCase();
    this.parentNode = parent;
    this.parentElement = parent;
    this.children = [];
    this.attributes = { ...(options.attr || {}) };
    this.classes = new Set(String(options.cls || "").split(/\s+/).filter(Boolean));
    this.listeners = new Map();
    this._textContent = options.text || "";
    this.value = options.value || "";
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.tabIndex = 0;
    this.isConnected = true;
  }
  addClass(name) { this.classes.add(name); }
  removeClass(name) { this.classes.delete(name); }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent).join(""); }
  set textContent(value) {
    this._textContent = String(value ?? "");
    for (const child of this.children) child.remove();
    this.children.length = 0;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  createDiv(options = {}) { return this.createEl("div", options); }
  createEl(tagName, options = {}) {
    const child = new FakeElement(tagName, options, this);
    this.children.push(child);
    return child;
  }
  empty() {
    for (const child of this.children) child.remove();
    this.children.length = 0;
    this.textContent = "";
  }
  remove() {
    const index = this.parentNode?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.isConnected = false;
    this.parentNode = null;
    this.parentElement = null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener({ type, target: this, key: "", preventDefault() {}, ...event });
  }
  click() { this.dispatch("click"); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const match = (element) => {
      const dataAction = selector.match(/^\[data-action(?:\^=|=)"([^"]+)"\]$/);
      const dataRole = selector.match(/^\[data-role="([^"]+)"\]$/);
      if (selector === "[data-batch-id]") return Object.hasOwn(element.attributes, "data-batch-id");
      if (dataAction) {
        const value = element.attributes["data-action"] || "";
        return selector.includes("^=") ? value.startsWith(dataAction[1]) : value === dataAction[1];
      }
      if (dataRole) return element.attributes["data-role"] === dataRole[1];
      return false;
    };
    const visit = (element) => {
      for (const child of element.children) {
        if (match(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

class FakeModal {
  constructor(app) {
    this.app = app;
    this.contentEl = new FakeElement("div");
    this.modalEl = new FakeElement("div");
  }
  close() { this.onClose(); }
}

const pause = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settle(modal, ms = 0) {
  await pause(ms);
  await modal.whenIdle();
  await pause(0);
}

function makeFamily(index, { status = 1 } = {}) {
  const surface = `term-${index}`;
  return {
    familyKey: `en-family:v1:word:["${surface}"]`,
    type: "word",
    status,
    records: [{ key: surface, surface, type: "word", status, translation: "", phonetic: "", note: "" }],
  };
}

function findAction(root, action) {
  return root.querySelector(`[data-action="${action}"]`);
}

function makeApi(overrides = {}) {
  const calls = { listFamilies: [], details: [], enrollment: [], contexts: [], openContext: [], addContextToReview: [], due: [], openReviewSource: [], history: [], preview: [], restore: [], imports: [], exports: [], learningExports: [] };
  const families = Array.from({ length: 105 }, (_, index) => makeFamily(index + 1));
  const api = {
    async listFamilies(options) {
      calls.listFamilies.push(options);
      const page = options.cursor ? families.slice(100) : families.slice(0, 100);
      return { families: page, nextCursor: options.cursor ? null : "cursor-2", total: families.length };
    },
    async getFamilyDetails(familyKey) {
      calls.details.push(familyKey);
      const family = families.find((item) => item.familyKey === familyKey) || makeFamily(1);
      return { family: structuredClone(family), dictionary: { translation: "dictionary meaning", phonetic: "/ˈwɜːd/" } };
    },
    async updateFamily(payload) {
      calls.enrollment.push({ kind: "edit", ...payload });
      const family = families.find((item) => item.familyKey === payload.familyKey) || makeFamily(1);
      const updated = { ...structuredClone(family), status: payload.fields.status, records: [{ ...family.records[0], ...payload.fields }] };
      return updated;
    },
    async setReviewEnrollment(keys, options) {
      calls.enrollment.push({ keys, options });
      return { results: keys.map((familyKey) => ({ familyKey, status: "committed" })) };
    },
    async listContexts(familyKey, options) {
      calls.contexts.push({ familyKey, options });
      return { total: 1, contexts: [{ contextId: "context:v1:1", surface: "term-1", sentence: "A sentence with term-1.", documentId: "vault://book.pdf", pageNumberHint: 2, createdAt: "2026-10-18T00:00:00.000Z" }] };
    },
    async openContext(contextId) { calls.openContext.push(contextId); return { status: "opening", message: "Reader will verify the source." }; },
    async addContextToReview(contextId) { calls.addContextToReview.push(contextId); return { status: "draft-opened" }; },
    async listDueReview(options) {
      calls.due.push(options);
      return { total: 1, items: [{ familyKey: families[0].familyKey, dueAt: "2026-10-18T00:00:00.000Z", family: families[0] }] };
    },
    async applyReviewAction() { return { status: "committed" }; },
    async openReviewSource(input) { calls.openReviewSource.push(input); return { status: "opening" }; },
    async exportLearning(format) { calls.learningExports.push(format); return { format, content: `learning:${format}`, itemCount: 1 }; },
    async listHistory(options) {
      calls.history.push(options);
      return { batches: [{ batchId: "batch-a", deviceId: "device-1", kind: "review-final", createdAt: "2026-10-18T00:00:00.000Z", changes: [{ changeId: "raw-1" }] }] };
    },
    async previewHistory(batchId) {
      calls.preview.push(batchId);
      return { status: "conflict", items: [
        { changeId: "clean-1", storeId: "vocab", entityId: "term", field: "note", status: "clean", kind: "field", currentExists: true, current: "new note", beforeExists: true, before: "old note" },
        { changeId: "conflict-1", storeId: "vocab", entityId: "term", field: "translation", status: "conflict", kind: "field" },
        { changeId: "life-clean", storeId: "review", entityId: "family", field: "enrolled", status: "clean", kind: "entityCreate" },
        { changeId: "life-conflict", storeId: "review", entityId: "family", field: "box", status: "conflict", kind: "entityCreate" },
      ] };
    },
    async restoreHistory(batchId, options) {
      calls.restore.push({ batchId, options });
      return { status: "committed" };
    },
    async exportJson() { calls.exports.push("json"); return JSON.stringify({ core: true, contexts: [], review: [], history: [] }); },
    async exportCsv() { calls.exports.push("csv"); return "term,status\r\nterm-1,1\r\n"; },
    async importJson(text, policy) { calls.imports.push({ kind: "json", text, policy }); return { imported: 1 }; },
    async importCsv(text, policy) { calls.imports.push({ kind: "csv", text, policy }); return { imported: 1 }; },
    async close() { calls.closed = (calls.closed || 0) + 1; },
    ...overrides,
  };
  return { api, calls, families };
}

function createModal(api) {
  const Workbench = createVocabularyWorkbench({ Modal: FakeModal, Notice: class { constructor(message) { this.message = message; } } });
  const modal = new Workbench({}, api);
  modal.onOpen();
  return modal;
}

test("workbench exposes four accessible tabs and caps vocabulary pages at 100 rows", async () => {
  const { api, calls } = makeApi({ async listFamilies(options) {
    calls.listFamilies.push(options);
    return { families: Array.from({ length: 100 }, (_, i) => makeFamily(i + 1)), total: 130, nextCursor: "next" };
  } });
  const modal = createModal(api);
  await settle(modal);
  const tabs = modal.contentEl.querySelectorAll('[data-action^="tab-"]');
  assert.equal(tabs.length, 4);
  assert.deepEqual(tabs.map((tab) => tab.getAttribute("aria-selected")), ["true", "false", "false", "false"]);
  assert.equal(modal.panel.querySelectorAll('[data-action^="details-"]').length, PAGE_SIZE);
  assert.equal(calls.listFamilies[0].limit, 100);
  assert.equal(modal.panel.querySelector('[data-action="next-page"]').disabled, false);
  modal.panel.querySelector('[data-action="next-page"]').click();
  await settle(modal);
  assert.equal(calls.listFamilies[1].cursor, "next");
  assert.equal(calls.listFamilies[1].limit, 100);
  assert.equal(modal.panel.querySelectorAll('[data-action^="details-"]').length, PAGE_SIZE);
  modal.onClose();
  await pause();
  assert.equal(calls.closed, 1);
});

test("stale search responses cannot replace newer query results", async () => {
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  let number = 0;
  const { api } = makeApi({ async listFamilies(options) {
    number += 1;
    if (number === 1) return first;
    return { families: [makeFamily(options.query === "new" ? 99 : 88)], total: 1, nextCursor: null };
  } });
  const modal = createModal(api);
  const search = findAction(modal.panel, "search");
  search.value = "new";
  search.dispatch("input");
  await pause(150);
  releaseFirst({ families: [makeFamily(1)], total: 1, nextCursor: null });
  await pause(0);
  assert.equal(modal.panel.querySelectorAll('[data-action^="details-"]').length, 1);
  assert.match(modal.panel.querySelector('[data-action^="details-"]').getAttribute("data-action"), /99/);
  modal.onClose();
});

test("an oversized vocabulary page is rejected instead of silently truncated", async () => {
  const { api } = makeApi({ async listFamilies() {
    return { families: Array.from({ length: 101 }, (_, i) => makeFamily(i + 1)), total: 101, nextCursor: null };
  } });
  const modal = createModal(api);
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-action^="details-"]').length, 0);
  assert.match(modal.errorEl.textContent, /超过每页 100 条上限/);
  modal.onClose();
});

test("dictionary lookup is deferred until opening details and edits flow through the host API", async () => {
  const { api, calls, families } = makeApi();
  const modal = createModal(api);
  await settle(modal);
  assert.equal(calls.details.length, 0);
  const firstKey = families[0].familyKey;
  const detailButton = modal.panel.querySelector('[data-action^="details-"]');
  detailButton.click();
  await settle(modal);
  assert.deepEqual(calls.details, [firstKey]);
  assert.equal(modal.detailPanel.querySelector('[data-role="dictionary-reference"]').children[1].textContent, "dictionary meaning");
  modal.detailPanel.querySelector('[data-action="detail-status"]').value = "3";
  modal.detailPanel.querySelector('[data-action="detail-translation"]').value = "my translation";
  modal.detailPanel.querySelector('[data-action="detail-phonetic"]').value = "/mine/";
  modal.detailPanel.querySelector('[data-action="detail-note"]').value = "note";
  modal.detailPanel.querySelector('[data-action="save-details"]').click();
  await settle(modal);
  const edit = calls.enrollment.find((item) => item.kind === "edit");
  assert.equal(edit.familyKey, firstKey);
  assert.deepEqual(edit.fields, { status: 3, translation: "my translation", phonetic: "/mine/", note: "note" });
  modal.onClose();
});

test("bulk enrollment is bounded and Context, Review, and History use read/clean-only APIs", async () => {
  const { api, calls, families } = makeApi();
  const modal = createModal(api);
  await settle(modal);
  const checkbox = modal.panel.querySelector('[data-action="select-family"]');
  checkbox.checked = true;
  checkbox.dispatch("change");
  modal.panel.querySelector('[data-action="bulk-enroll"]').click();
  await settle(modal);
  assert.deepEqual(calls.enrollment[0], { keys: [families[0].familyKey], options: { enrolled: true } });

  modal.contentEl.querySelector('[data-action="tab-contexts"]').click();
  await settle(modal);
  assert.equal(calls.contexts[0].familyKey, families[0].familyKey);
  assert.match(modal.panel.textContent, /A sentence with term-1/);
  modal.panel.querySelector('[data-action^="context-open-"]').click();
  await settle(modal);
  assert.deepEqual(calls.openContext, ["context:v1:1"],
    "the UI sends only the opaque context ID; path and page hints never become navigation authority");
  assert.match(modal.statusEl.textContent, /Reader will verify the source/);

  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);
  assert.equal(calls.due[0].limit, 100);
  assert.equal(modal.panel.querySelectorAll('[data-action^="review-details-"]').length, 1);

  modal.contentEl.querySelector('[data-action="tab-history"]').click();
  await settle(modal);
  modal.panel.querySelector('[data-action^="preview-history-"]').click();
  await settle(modal);
  assert.deepEqual(calls.restore, []);
  const restoreButton = modal.panel.querySelector('[data-action^="restore-history-"]');
  assert.equal(restoreButton.disabled, false);
  assert.match(restoreButton.textContent, /1/);
  assert.match(modal.panel.textContent, /恢复后：old note/);
  restoreButton.click();
  await settle(modal);
  assert.deepEqual(calls.restore[0], { batchId: "batch-a", options: { selectedCleanIds: ["clean-1"], deviceId: "device-1" } });
  modal.onClose();
});

test("Context and Review use service cursors and reject oversized page payloads", async () => {
  const contextCalls = [];
  const dueCalls = [];
  const { api, families } = makeApi({
    async listContexts(familyKey, options) {
      contextCalls.push({ familyKey, options });
      const records = options.cursor ? [{ surface: "term-1", sentence: "Second page." }] : Array.from({ length: 100 }, (_, index) => ({ surface: "term-1", sentence: `Sentence ${index}` }));
      return { contexts: records, total: 101, nextCursor: options.cursor ? null : "context-next" };
    },
    async listDueReview(options) {
      dueCalls.push(options);
      const items = options.cursor ? [{ familyKey: families[0].familyKey, family: families[0], dueAt: "2026-10-18T00:00:00.000Z" }] : Array.from({ length: 100 }, (_, index) => ({ familyKey: `due-${index}`, family: families[0], dueAt: "2026-10-18T00:00:00.000Z" }));
      return { items, total: 101, nextCursor: options.cursor ? null : "review-next" };
    },
  });
  const modal = createModal(api);
  await settle(modal);
  modal.selectedFamilyKey = families[0].familyKey;
  modal.contentEl.querySelector('[data-action="tab-contexts"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-role="context-record"]').length, 100);
  modal.panel.querySelector('[data-action="contexts-next"]').click();
  await settle(modal);
  assert.equal(contextCalls[1].options.cursor, "context-next");
  assert.equal(modal.panel.querySelectorAll('[data-role="context-record"]').length, 1);

  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-role="review-row"]').length, 100);
  modal.panel.querySelector('[data-action="review-next"]').click();
  await settle(modal);
  assert.equal(dueCalls[1].cursor, "review-next");
  assert.equal(modal.panel.querySelectorAll('[data-role="review-row"]').length, 1);
  modal.onClose();
});

test("Today Review offers ratings and session-only skip with stable retry ID and local due-time display", async () => {
  const actionCalls = [];
  const dueCalls = [];
  let attempt = 0;
  const { api, families } = makeApi({
    async listDueReview(options) {
      dueCalls.push(options);
      return { items: [{ familyKey: families[0].familyKey, dueAt: "2026-10-18T00:00:00.000Z",
        state: { box: 3 }, family: families[0] }], total: 1, nextCursor: null };
    },
    async applyReviewAction(input) {
      actionCalls.push(input);
      attempt += 1;
      if (attempt === 1) throw new Error("temporary acknowledgement loss");
      return { status: input.kind === "skip" ? "skipped" : "duplicate" };
    },
  });
  const modal = createModal(api);
  await settle(modal);
  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);
  const row = modal.panel.querySelector('[data-role="review-row"]');
  assert.match(row.textContent, /第 3 箱/);
  assert.doesNotMatch(row.textContent, /2026-10-18T00:00:00\.000Z/, "UTC remains in storage; the user sees local date formatting");
  assert.ok(modal.panel.querySelector('[data-action^="review-remember-"]'));
  assert.ok(modal.panel.querySelector('[data-action^="review-forget-"]'));
  assert.ok(modal.panel.querySelector('[data-action^="review-skip-"]'));

  const remember = modal.panel.querySelector('[data-action^="review-remember-"]');
  remember.click();
  await settle(modal);
  remember.click();
  await settle(modal);
  assert.equal(actionCalls[0].kind, "remember");
  assert.equal(actionCalls[0].actionId, actionCalls[1].actionId, "retry reuses the same durable action ID");

  modal.panel.querySelector('[data-action^="review-skip-"]').click();
  await settle(modal);
  assert.equal(actionCalls[2].kind, "skip");
  assert.equal(modal.panel.querySelectorAll('[data-role="review-row"]').length, 0);
  assert.match(modal.panel.textContent, /本页到期词族已在本次会话中跳过/);
  assert.equal(dueCalls.length, 3);
  modal.onClose();
});

test("mixed Review renders learning Q/A and routes ratings with provider-scoped stable identities", async () => {
  const actions = [];
  const vocab = makeFamily(1);
  const learningId = "learning:v1:shared";
  const { api, calls } = makeApi({
    async listDueReview(options) {
      calls.due.push(options);
      return { total: 2, items: [
        { providerId: "vocabulary", itemId: "shared", familyKey: "shared", record: { surface: "verb", translation: "meaning" }, state: { box: 1 }, dueAt: "2026-10-18T00:00:00.000Z" },
        { providerId: "learning", itemId: learningId, prompt: "What does it mean?", answer: "A saved answer", targetText: "captured quote", reviewState: { box: 2 }, dueAt: "2026-10-18T00:00:00.000Z" },
      ] };
    },
    async applyReviewAction(input) { actions.push(input); return { status: "committed" }; },
  });
  const modal = createModal(api);
  await settle(modal);
  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);

  const rows = modal.panel.querySelectorAll('[data-role="review-row"]');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /verb/);
  assert.match(rows[1].textContent, /What does it mean\?/);
  assert.match(rows[1].textContent, /A saved answer/);
  assert.match(rows[1].textContent, /captured quote/);
  assert.ok(modal.panel.querySelector('[data-action^="review-source-learning-"]'));

  modal.panel.querySelectorAll('[data-action^="review-remember-"]')[0].click();
  await settle(modal);
  modal.panel.querySelectorAll('[data-action^="review-remember-"]')[1].click();
  await settle(modal);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map(({ providerId, itemId, familyKey }) => ({ providerId, itemId, familyKey })), [
    { providerId: "vocabulary", itemId: "shared", familyKey: "shared" },
    { providerId: "learning", itemId: learningId, familyKey: undefined },
  ]);
  assert.notEqual(actions[0].actionId, actions[1].actionId, "same kind and raw item key across providers cannot share retry identity");
  modal.onClose();
});

test("review Source opens and closes only for accepted navigation; choose-context stays in the existing tab", async () => {
  let sourceResult = { status: "opening", message: "Reader accepted the request." };
  const row = { providerId: "learning", itemId: "learning:v1:source", prompt: "Prompt", answer: "Answer", targetText: "Quote", dueAt: "2026-10-18T00:00:00.000Z" };
  const { api, calls } = makeApi({
    async listDueReview(options) { calls.due.push(options); return { items: [row], total: 1, nextCursor: null }; },
    async openReviewSource(input) { calls.openReviewSource.push(input); return sourceResult; },
    async listContexts(familyKey, options) {
      calls.contexts.push({ familyKey, options });
      return { total: 1, contexts: [{ contextId: "context:v1:review", surface: "term-1", sentence: "A review context." }] };
    },
    async addContextToReview(contextId) { calls.addContextToReview.push(contextId); return { status: "cancelled" }; },
  });
  const modal = createModal(api);
  await settle(modal);
  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);
  modal.panel.querySelector('[data-action^="review-source-learning-"]').click();
  await settle(modal);
  assert.equal(modal.closed, true, "accepted source navigation closes the workbench so it cannot cover the PDF");
  assert.deepEqual(calls.openReviewSource[0], { providerId: "learning", itemId: row.itemId });
  assert.equal(calls.closed, 1);

  const choose = createModal(api);
  await settle(choose);
  choose.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(choose);
  sourceResult = { status: "choose-context", familyKey: "family-for-context" };
  choose.panel.querySelector('[data-action^="review-source-learning-"]').click();
  await settle(choose);
  assert.equal(choose.closed, false);
  assert.equal(choose.activeTab, "contexts");
  assert.equal(choose.selectedFamilyKey, "family-for-context");
  const addContext = choose.panel.querySelector('[data-action^="context-add-review-"]');
  assert.ok(addContext, "existing Context tab offers an explicit add-to-review action");
  addContext.click();
  await settle(choose);
  assert.deepEqual(calls.addContextToReview, ["context:v1:review"]);
  assert.match(choose.statusEl.textContent, /已取消.*未加入复习/);
  assert.equal(choose.closed, false, "canceling the draft flow leaves the workbench open and unchanged");

  const missing = createModal(api);
  await settle(missing);
  missing.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(missing);
  sourceResult = { status: "missing" };
  missing.panel.querySelector('[data-action^="review-source-learning-"]').click();
  await settle(missing);
  assert.equal(missing.closed, false);
  assert.match(missing.statusEl.textContent, /来源.*不可用|不可用.*来源/);
  modal.onClose();
  choose.onClose();
  missing.onClose();
});

test("vocabulary review Source uses provider and family identity; unknown totals stay explicitly unknown", async () => {
  let sourceResult = { status: "opening" };
  const family = makeFamily(1);
  const { api, calls } = makeApi({
    async listDueReview(options) {
      calls.due.push(options);
      return { items: [{ providerId: "vocabulary", itemId: family.familyKey, familyKey: family.familyKey,
        record: family.records[0], state: { box: 1 }, dueAt: "2026-10-18T00:00:00.000Z" }], nextCursor: "more" };
    },
    async openReviewSource(input) { calls.openReviewSource.push(input); return sourceResult; },
  });
  const modal = createModal(api);
  await settle(modal);
  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);
  assert.match(modal.statusEl.textContent, /本页 1 个复习项.*总数未知/);

  modal.panel.querySelector('[data-action^="review-source-vocabulary-"]').click();
  await settle(modal);
  assert.deepEqual(calls.openReviewSource[0], { providerId: "vocabulary", familyKey: family.familyKey });
  assert.equal(modal.closed, true);

  const choose = createModal(api);
  await settle(choose);
  choose.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(choose);
  sourceResult = { status: "choose-context", familyKey: family.familyKey };
  choose.panel.querySelector('[data-action^="review-source-vocabulary-"]').click();
  await settle(choose);
  assert.equal(choose.closed, false);
  assert.equal(choose.activeTab, "contexts");
  assert.equal(calls.contexts.at(-1).familyKey, family.familyKey);
  modal.onClose();
  choose.onClose();
});

test("review session close resets local skips on reopen without changing review pagination behavior", async () => {
  const family = makeFamily(1);
  const { api, calls } = makeApi({ async listDueReview(options) {
    calls.due.push(options);
    return { items: [{ familyKey: family.familyKey, itemId: family.familyKey, providerId: "vocabulary", record: family.records[0], state: { box: 1 }, dueAt: "2026-10-18T00:00:00.000Z" }], total: 1 };
  }, async applyReviewAction(input) { return { status: input.kind === "skip" ? "skipped" : "committed" }; } });
  const modal = createModal(api);
  await settle(modal);
  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);
  modal.panel.querySelector('[data-action^="review-skip-vocabulary-"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-role="review-row"]').length, 0);
  modal.onClose();
  await pause();
  modal.onOpen();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-role="review-row"]').length, 1,
    "a new modal session clears local skip suppression; ordinary page refresh remains session-local");
  assert.equal(calls.closed, 1);
  modal.onClose();
});

test("learning exports use the independent API and existing transfer textarea; mixed review rejects over 100 items", async () => {
  const { api, calls } = makeApi({ async listDueReview() {
    return { items: Array.from({ length: 101 }, (_, index) => ({
      providerId: "learning", itemId: `learning:v1:${index}`, prompt: `P${index}`, answer: `A${index}`, dueAt: "2026-10-18T00:00:00.000Z",
    })), total: 101 };
  } });
  const modal = createModal(api);
  await settle(modal);
  const textarea = modal.panel.querySelector('[data-action="transfer-text"]');
  for (const format of ["json", "markdown", "csv", "anki-tsv"]) {
    modal.panel.querySelector(`[data-action="export-learning-${format}"]`).click();
    await settle(modal);
    assert.equal(calls.learningExports.at(-1), format);
    assert.equal(textarea.value, `learning:${format}`);
  }
  modal.contentEl.querySelector('[data-action="tab-review"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-role="review-row"]').length, 0);
  assert.match(modal.errorEl.textContent, /超过每页 100 条上限/);
  modal.onClose();
});

test("History batches and field previews paginate at 100 without losing later pages", async () => {
  const batches = Array.from({ length: 101 }, (_, index) => ({ batchId: `batch-${index + 1}`, deviceId: "device-1", kind: "review-final", changes: [] }));
  const { api } = makeApi({
    async listHistory() { return { batches }; },
    async previewHistory() {
      return { items: Array.from({ length: 101 }, (_, index) => ({ changeId: `change-${index + 1}`, field: `field-${index + 1}`, status: "clean", kind: "field", currentExists: true, current: "after", beforeExists: true, before: "before" })) };
    },
  });
  const modal = createModal(api);
  await settle(modal);
  modal.contentEl.querySelector('[data-action="tab-history"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-batch-id]').length, 100);
  modal.panel.querySelector('[data-action="history-next"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-batch-id]').length, 1);
  modal.panel.querySelector('[data-action^="preview-history-"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-role="history-field"]').length, 100);
  modal.panel.querySelector('[data-action="history-preview-next"]').click();
  await settle(modal);
  assert.equal(modal.panel.querySelectorAll('[data-role="history-field"]').length, 1);
  assert.match(modal.panel.textContent, /field-101/);
  modal.onClose();
});

test("transfer panel offers JSON and CSV and states that CSV omits ancillary stores", async () => {
  const { api, calls } = makeApi();
  const modal = createModal(api);
  await settle(modal);
  assert.match(modal.panel.textContent, /CSV 仅包含个人词汇核心记录/);
  const text = modal.panel.querySelector('[data-action="transfer-text"]');
  text.value = "{\"records\":[]}";
  modal.panel.querySelector('[data-action="import-json"]').click();
  await settle(modal);
  assert.equal(calls.imports.at(-1).kind, "json");
  assert.equal(calls.imports.at(-1).policy.defaultStatus, 1);
  modal.panel.querySelector('[data-action="export-csv"]').click();
  await settle(modal);
  assert.equal(calls.exports.at(-1), "csv");
  assert.match(modal.panel.querySelector('[data-action="transfer-text"]').value, /term-1/);
  modal.onClose();
});

test("history excludes partial lifecycle groups from clean restore selection", async () => {
  const { api, calls } = makeApi();
  const modal = createModal(api);
  await settle(modal);
  modal.contentEl.querySelector('[data-action="tab-history"]').click();
  await settle(modal);
  modal.panel.querySelector('[data-action^="preview-history-"]').click();
  await settle(modal);
  modal.panel.querySelector('[data-action^="restore-history-"]').click();
  await settle(modal);
  assert.deepEqual(calls.restore[0].options.selectedCleanIds, ["clean-1"]);
  assert.equal(calls.restore[0].options.deviceId, "device-1");
  assert.equal(calls.restore[0].options.selectedCleanIds.includes("life-clean"), false);
  modal.onClose();
});
