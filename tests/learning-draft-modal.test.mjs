import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createLearningDraftModal } = require("../plugin/learning/draft-modal.cjs");

class FakeElement {
  constructor(tag, options = {}) {
    this.tagName = tag;
    this.textContent = options.text || "";
    this.attributes = options.attr || {};
    this.className = options.cls || "";
    this.children = [];
    this.listeners = new Map();
    this.value = "";
    this.disabled = false;
  }
  createEl(tag, options = {}) {
    const child = new FakeElement(tag, options);
    this.children.push(child);
    return child;
  }
  appendChild(child) { this.children.push(child); }
  empty() { this.children = []; }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }
  dispatch(name) {
    for (const callback of this.listeners.get(name) || []) callback({ target: this });
  }
}

class FakeModal {
  constructor(app) {
    this.app = app;
    this.contentEl = new FakeElement("div");
    this.titleEl = new FakeElement("h2");
    this.isOpen = false;
  }
  open() { this.isOpen = true; this.onOpen(); }
  close() { this.isOpen = false; this.onClose(); }
}

function makeService({ confirm } = {}) {
  const state = { writes: 0, confirms: [], cancels: [], draft: null };
  return {
    state,
    createDraft({ source, prompt = "", answer }) {
      state.draft = { draftId: "draft-1", prompt, answer: answer ?? source.targetText, source, targetText: source.targetText };
      return { ...state.draft };
    },
    updateDraft(draftId, changes) {
      assert.equal(draftId, "draft-1");
      state.draft = { ...state.draft, ...changes };
      return { ...state.draft };
    },
    async confirmDraft(draftId, options) {
      state.confirms.push({ draftId, ...options, prompt: state.draft.prompt, answer: state.draft.answer });
      return confirm ? confirm(state, options) : { status: "committed", item: { itemId: "item-1" }, writes: 1 };
    },
    cancelDraft(draftId) { state.cancels.push(draftId); return { status: "cancelled", writes: 0 }; },
  };
}

const source = { target: { kind: "markdown", id: "md:10" }, targetText: "captured answer" };

test("draft modal prefills answer, requires nonempty question and answer, and cancel performs no write", () => {
  const notices = [];
  class Notice { constructor(message) { notices.push(message); } }
  const service = makeService();
  const DraftModal = createLearningDraftModal({ Modal: FakeModal, Notice });
  const modal = new DraftModal({}, { service, source, makeActionId: () => "ui-action-1" });
  modal.open();

  assert.equal(modal.titleEl.textContent, "新建学习条目");
  assert.equal(modal.answerInput.value, "captured answer");
  assert.equal(modal.confirmButton.textContent, "确认加入复习");
  assert.equal(modal.confirmButton.disabled, true);
  modal.promptInput.value = "";
  modal.promptInput.dispatch("input");
  assert.equal(modal.confirmButton.disabled, true);
  modal.promptInput.value = "What is this?";
  modal.promptInput.dispatch("input");
  assert.equal(modal.confirmButton.disabled, false);

  const cancelled = modal.cancel();
  assert.equal(cancelled.writes, 0);
  assert.equal(modal.isOpen, false);
  assert.deepEqual(service.state.cancels, ["draft-1"]);
  assert.equal(service.state.confirms.length, 0);
  assert.equal(service.state.writes, 0);
  assert.deepEqual(notices, []);
});
test("stale confirmation keeps edited text in the open modal and retries with the same action ID", async () => {
  const notices = [];
  class Notice { constructor(message) { notices.push(message); } }
  const service = makeService({
    async confirm() {
      throw Object.assign(new Error("The source is stale."), { code: "LEARNING_SOURCE_STALE" });
    },
  });
  let actionCalls = 0;
  const DraftModal = createLearningDraftModal({ Modal: FakeModal, Notice });
  const modal = new DraftModal({}, { service, source, makeActionId: () => { actionCalls += 1; return "stable-action"; } });
  modal.open();
  modal.promptInput.value = "Edited prompt";
  modal.promptInput.dispatch("input");
  modal.answerInput.value = "Edited answer";
  modal.answerInput.dispatch("input");

  await assert.rejects(modal.confirm(), (error) => error.code === "LEARNING_SOURCE_STALE");
  assert.equal(modal.isOpen, true);
  assert.equal(modal.promptInput.value, "Edited prompt");
  assert.equal(modal.answerInput.value, "Edited answer");
  assert.match(modal.statusEl.textContent, /草稿和文字仍保留/);
  await assert.rejects(modal.confirm(), (error) => error.code === "LEARNING_SOURCE_STALE");
  assert.equal(actionCalls, 1);
  assert.deepEqual(service.state.confirms.map((entry) => entry.actionId), ["stable-action", "stable-action"]);
  assert.equal(notices.length, 2);
  assert.equal(service.state.writes, 0);
});

test("reentrant confirm shares one in-flight request and closes after commit", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const service = makeService({ async confirm() { return pending; } });
  let actionCalls = 0;
  const DraftModal = createLearningDraftModal({ Modal: FakeModal });
  const modal = new DraftModal({}, { service, source, prompt: "Question", makeActionId: () => { actionCalls += 1; return "same-action"; } });
  modal.open();
  assert.equal(modal.confirmButton.disabled, false);
  const first = modal.confirm();
  const second = modal.confirm();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(service.state.confirms.length, 1);
  assert.equal(service.state.confirms[0].actionId, "same-action");
  assert.equal(actionCalls, 1);

  release({ status: "committed", item: { itemId: "item-1" }, writes: 1 });
  const result = await first;
  assert.equal(result.status, "committed");
  assert.equal(modal.isOpen, false);
  assert.deepEqual(service.state.cancels, []);
});

test("an unresolved Markdown route is explained and the modal can still be closed", async () => {
  const service = makeService({ async confirm() {
    return { status: "committed", item: { itemId: "item-1" },
      sourceStatus: { status: "TARGET_UNRESOLVED", code: "markdown-route-bind-failed" }, writes: 1 };
  } });
  const DraftModal = createLearningDraftModal({ Modal: FakeModal });
  const modal = new DraftModal({}, { service, source, prompt: "Question", makeActionId: () => "route-action" });
  modal.open();

  await modal.confirm();
  assert.equal(modal.isOpen, true);
  assert.match(modal.statusEl.textContent, /来源关联未完成/);
  assert.equal(modal.confirmButton.textContent, "重试来源关联");
  assert.equal(modal.promptInput.readOnly, true);
  assert.equal(modal.answerInput.readOnly, true);
  assert.equal(modal.cancelButton.disabled, false);

  const cancelled = modal.cancel();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(modal.isOpen, false, "the user can close a modal after the canonical item was saved");
});

test("clicking a stale confirmation keeps the draft visible without an unhandled rejection", async () => {
  const service = makeService({
    async confirm() {
      throw Object.assign(new Error("The source is stale."), { code: "LEARNING_SOURCE_STALE" });
    },
  });
  const DraftModal = createLearningDraftModal({ Modal: FakeModal });
  const modal = new DraftModal({}, { service, source, prompt: "Question", makeActionId: () => "click-action" });
  modal.open();
  const unhandled = [];
  const recordUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", recordUnhandled);
  modal.confirmButton.dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  process.off("unhandledRejection", recordUnhandled);

  assert.deepEqual(unhandled, [], "the DOM click boundary must observe the rejecting confirm promise");
  assert.equal(modal.lastError.code, "LEARNING_SOURCE_STALE");
  assert.match(modal.statusEl.textContent, /草稿和文字仍保留/);
  assert.equal(modal.isOpen, true);
  assert.deepEqual(service.state.cancels, []);
});
