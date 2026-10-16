/*
 * Obsidian-only modal views for local vocabulary entries and transfer.
 * This UI module is deliberately separate from the PDF/annotation host.
 */
const MAX_VOCABULARY_TEXT_FIELD = 4096;
const MAX_VOCABULARY_IMPORT_CHARS = 8 * 1024 * 1024;

function createVocabularyModals({ Modal, Notice }) {
  if (typeof Modal !== "function" || typeof Notice !== "function") {
    throw new TypeError("Obsidian Modal and Notice constructors are required.");
  }

  class VocabularyEntryModal extends Modal {
    constructor(app, { surface, type, existing = null, onSave, onClose } = {}) {
      super(app);
      this.surface = surface;
      this.type = type;
      this.existing = existing;
      this.onSave = onSave;
      this.onCloseCallback = onClose;
      this.saving = false;
    }

    onOpen() {
      const { contentEl } = this;
      contentEl.empty();
      contentEl.createEl("h2", { text: this.type === "phrase" ? "保存英语短语" : "保存英语词汇" });
      contentEl.createEl("p", { text: this.surface });
      const status = contentEl.createEl("select", { attr: { "aria-label": "学习状态" } });
      for (const [value, label] of [[1, "新词"], [2, "学习中"], [3, "复习中"], [4, "已掌握"], [5, "已知"]]) {
        status.add(new Option(label, String(value)));
      }
      status.value = String(this.existing?.status || 1);
      const translation = contentEl.createEl("input", {
        type: "text", placeholder: "翻译（可选）", value: this.existing?.translation || "",
      });
      translation.maxLength = MAX_VOCABULARY_TEXT_FIELD;
      const note = contentEl.createEl("textarea", {
        placeholder: "笔记（可选）", text: this.existing?.note || "",
      });
      note.maxLength = MAX_VOCABULARY_TEXT_FIELD;
      const save = contentEl.createEl("button", { text: "保存词汇" });
      save.addEventListener("click", () => {
        if (this.saving) return;
        this.saving = true;
        save.disabled = true;
        void Promise.resolve(this.onSave?.({
          status: Number(status.value),
          translation: translation.value,
          note: note.value,
        })).then(() => this.close()).catch((error) => {
          new Notice(`词汇保存失败：${error.message || error}`, 8000);
          save.disabled = false;
          this.saving = false;
        });
      });
    }

    onClose() {
      this.contentEl.empty();
      this.onCloseCallback?.();
    }
  }

  class VocabularyTransferModal extends Modal {
    constructor(app, plugin) {
      super(app);
      this.plugin = plugin;
      this.busy = false;
    }

    onOpen() {
      const { contentEl } = this;
      contentEl.empty();
      contentEl.createEl("h2", { text: "本地英语词汇导入 / 导出" });
      contentEl.createEl("p", { text: "数据只保存在当前 Vault。导入默认保留已有条目，KNOWN 状态也不会被普通导入覆盖。" });
      const format = contentEl.createEl("select", { attr: { "aria-label": "导入格式" } });
      format.add(new Option("JSON", "json"));
      format.add(new Option("CSV", "csv"));
      const text = contentEl.createEl("textarea", { placeholder: "粘贴 JSON 或 CSV；导出后可从这里复制。" });
      text.rows = 14;
      text.spellcheck = false;
      text.maxLength = MAX_VOCABULARY_IMPORT_CHARS;
      const overwriteExisting = contentEl.createEl("input", { type: "checkbox" });
      const existingLabel = contentEl.createEl("label", { text: "明确覆盖已有词条" });
      existingLabel.prepend(overwriteExisting);
      const overwriteKnown = contentEl.createEl("input", { type: "checkbox" });
      const knownLabel = contentEl.createEl("label", { text: "明确允许覆盖 KNOWN 状态" });
      knownLabel.prepend(overwriteKnown);
      const importButton = contentEl.createEl("button", { text: "导入" });
      const exportJsonButton = contentEl.createEl("button", { text: "导出 JSON 到文本框" });
      const exportCsvButton = contentEl.createEl("button", { text: "导出 CSV 到文本框" });
      const setBusy = (busy) => {
        this.busy = busy;
        importButton.disabled = exportJsonButton.disabled = exportCsvButton.disabled = busy;
      };
      importButton.addEventListener("click", () => {
        if (this.busy) return;
        setBusy(true);
        void (async () => {
          const policy = {
            defaultStatus: 1,
            overwriteExisting: overwriteExisting.checked,
            overwriteKnown: overwriteKnown.checked,
          };
          const stats = await this.plugin.importVocabulary(text.value, format.value, policy);
          new Notice(`词汇导入完成：新增 ${stats.imported}，更新 ${stats.updated}，跳过已有 ${stats.skippedExisting}，跳过 KNOWN ${stats.skippedKnown}，无效 ${stats.invalid}。`, 8000);
        })().catch((error) => new Notice(`词汇导入失败：${error.message || error}`, 8000)).finally(() => setBusy(false));
      });
      const exportInto = (kind) => {
        if (this.busy) return;
        setBusy(true);
        void (async () => {
          const service = this.plugin.getVocabularyService();
          text.value = kind === "csv" ? await service.exportCsv() : await service.exportJson();
          text.focus();
          text.select();
          new Notice(`已导出本地词汇 ${kind.toUpperCase()}；可从文本框复制。`, 5000);
        })().catch((error) => new Notice(`词汇导出失败：${error.message || error}`, 8000)).finally(() => setBusy(false));
      };
      exportJsonButton.addEventListener("click", () => exportInto("json"));
      exportCsvButton.addEventListener("click", () => exportInto("csv"));
    }

    onClose() {
      this.contentEl.empty();
    }
  }

  return { VocabularyEntryModal, VocabularyTransferModal };
}

module.exports = { createVocabularyModals };
