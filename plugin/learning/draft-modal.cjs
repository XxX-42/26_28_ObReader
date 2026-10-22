"use strict";

function defaultActionId() {
  return `learning-confirm:${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}

function showNotice(Notice, message) {
  if (typeof Notice !== "function") return;
  try { new Notice(message); }
  catch { Notice(message); }
}

function createLearningDraftModal({ Modal, Notice } = {}) {
  if (typeof Modal !== "function") throw new TypeError("Learning draft modal requires the host Modal constructor.");

  return class LearningDraftModal extends Modal {
    constructor(app, { service, source, prompt = "", answer, makeActionId = defaultActionId } = {}) {
      super(app);
      if (!service || typeof service.createDraft !== "function" || typeof service.updateDraft !== "function" ||
          typeof service.confirmDraft !== "function" || typeof service.cancelDraft !== "function") {
        throw new TypeError("Learning draft modal requires the learning draft service API.");
      }
      if (typeof makeActionId !== "function") throw new TypeError("Learning draft modal requires an action ID factory.");
      this.service = service;
      this.source = source;
      this.initialPrompt = prompt;
      this.initialAnswer = answer;
      this.makeActionId = makeActionId;
      this.draft = null;
      this.actionId = null;
      this.confirmPromise = null;
      this.confirmed = false;
      this.lastError = null;
    }

    onOpen() {
      try {
        this.draft = this.service.createDraft({ source: this.source, prompt: this.initialPrompt, answer: this.initialAnswer });
        this.render();
      } catch (error) {
        showNotice(Notice, error.message || "Could not create the learning draft.");
        this.close();
      }
    }

    render() {
      this.contentEl.empty();
      this.titleEl.textContent = "新建学习条目";
      this.contentEl.createEl("p", { text: "检查问题与答案后确认加入复习。" });

      const promptLabel = this.contentEl.createEl("label", { text: "问题" });
      this.promptInput = this.contentEl.createEl("textarea", {
        attr: { "aria-label": "问题", rows: "3" },
      });
      this.promptInput.value = this.draft.prompt;
      promptLabel.appendChild?.(this.promptInput);

      const answerLabel = this.contentEl.createEl("label", { text: "答案" });
      this.answerInput = this.contentEl.createEl("textarea", {
        attr: { "aria-label": "答案", rows: "4" },
      });
      this.answerInput.value = this.draft.answer;
      answerLabel.appendChild?.(this.answerInput);

      this.statusEl = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
      const footer = this.contentEl.createEl("div", { cls: "learning-draft-modal-actions" });
      this.cancelButton = footer.createEl("button", { text: "取消", attr: { type: "button" } });
      this.confirmButton = footer.createEl("button", { text: "确认加入复习", attr: { type: "button" } });

      const update = () => {
        this.draft = this.service.updateDraft(this.draft.draftId, {
          prompt: this.promptInput.value,
          answer: this.answerInput.value,
        });
        this.syncConfirmButton();
      };
      this.promptInput.addEventListener("input", update);
      this.answerInput.addEventListener("input", update);
      this.cancelButton.addEventListener("click", () => this.cancel());
      this.confirmButton.addEventListener("click", () => {
        void this.confirm().catch((error) => {
          // Direct callers still receive a rejected promise. The DOM boundary
          // records the failure in the open modal instead of leaking an
          // unhandled rejection from an event listener.
          this.lastError = error;
          if (this.statusEl && !this.statusEl.textContent) {
            this.statusEl.textContent = error?.message || "学习条目未能保存。";
          }
        });
      });
      this.syncConfirmButton();
    }

    syncConfirmButton() {
      const valid = Boolean(this.promptInput?.value.trim() && this.answerInput?.value.trim());
      if (this.confirmButton) this.confirmButton.disabled = !valid || Boolean(this.confirmPromise);
    }

    cancel() {
      if (this.confirmPromise) return { status: "busy" };
      if (this.draft) this.service.cancelDraft(this.draft.draftId);
      this.draft = null;
      this.close();
      return { status: "cancelled", writes: 0 };
    }

    confirm() {
      if (this.confirmPromise) return this.confirmPromise;
      if (!this.draft || !this.promptInput?.value.trim() || !this.answerInput?.value.trim()) {
        this.syncConfirmButton();
        return Promise.resolve({ status: "invalid", writes: 0 });
      }
      this.draft = this.service.updateDraft(this.draft.draftId, {
        prompt: this.promptInput.value,
        answer: this.answerInput.value,
      });
      this.actionId ||= this.makeActionId();
      this.lastError = null;
      this.confirmButton.disabled = true;
      this.cancelButton.disabled = true;
      this.statusEl.textContent = "正在验证来源并保存…";

      const pending = Promise.resolve().then(() => this.service.confirmDraft(this.draft.draftId, { actionId: this.actionId }))
        .then((result) => {
          this.confirmed = true;
          this.draft = null;
          this.statusEl.textContent = "已加入复习。";
          this.close();
          return result;
        }, (error) => {
          this.lastError = error;
          const message = error?.code === "LEARNING_SOURCE_STALE"
            ? "来源已变化，草稿和文字仍保留在这里；请重新检查后再试。"
            : (error?.message || "学习条目未能保存。");
          this.statusEl.textContent = message;
          showNotice(Notice, message);
          throw error;
        }).finally(() => {
          this.confirmPromise = null;
          if (!this.confirmed) {
            if (this.cancelButton) this.cancelButton.disabled = false;
            this.syncConfirmButton();
          }
        });
      this.confirmPromise = pending;
      return pending;
    }

    onClose() {
      if (this.draft && !this.confirmed) this.service.cancelDraft(this.draft.draftId);
      this.draft = null;
      this.contentEl.empty();
    }
  };
}

module.exports = { createLearningDraftModal };
