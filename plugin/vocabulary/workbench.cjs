/*
 * Responsive Obsidian workbench for the personal vocabulary workspace.
 * The UI speaks only to the host facade so it can share desktop and iPad
 * behavior without touching reader or Vault internals.
 */

const PAGE_SIZE = 100;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_CSV_CHARS = 8 * 1024 * 1024;
const TABS = [
  ["vocabulary", "词库"],
  ["contexts", "语境"],
  ["review", "今日复习"],
  ["history", "历史"],
];
const STATUS_OPTIONS = [["", "全部状态"], ["1", "新词"], ["2", "学习中"], ["3", "复习中"], ["4", "已掌握"], ["5", "已知"]];

function createVocabularyWorkbench({ Modal, Notice } = {}) {
  if (typeof Modal !== "function") throw new TypeError("Obsidian Modal is required.");
  const showNotice = typeof Notice === "function" ? (message) => new Notice(message) : () => {};
  const utf8ByteLength = (value) => new TextEncoder().encode(String(value)).byteLength;
  let reviewActionFallbackSequence = 0;
  const formatLocalReviewTime = (value) => {
    const time = Date.parse(String(value || ""));
    if (!Number.isFinite(time)) return "时间待确认";
    try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time)); }
    catch { return new Date(time).toLocaleString(); }
  };

  class VocabularyWorkbenchModal extends Modal {
    constructor(app, api) {
      super(app);
      if (!api || typeof api !== "object") throw new TypeError("Vocabulary workbench API is required.");
      this.api = api;
      this.activeTab = "vocabulary";
      this.closed = false;
      this.renderEpoch = 0;
      this.detailEpoch = 0;
      this.listEpoch = 0;
      this.searchTimer = null;
      this.pending = new Set();
      this.busyCount = 0;
      this.query = "";
      this.type = "";
      this.status = "";
      this.cursorStack = [null];
      this.pageIndex = 0;
      this.selectedKeys = new Set();
      this.selectedStatusByKey = new Map();
      this.selectedFamilyKey = null;
      this.preview = null;
      this.contextPageState = { familyKey: null, cursors: [null], index: 0, nextCursor: null, generation: 0 };
      this.reviewPageState = { cursors: [null], index: 0, nextCursor: null, generation: 0 };
      this.reviewSkippedFamilyKeys = new Set();
      this.reviewSkippedItemKeys = new Set();
      this.reviewActionIds = new Map();
      this.historyPageIndex = 0;
      this.historyBatches = [];
      this.historyPreviewPages = new Map();
      this.knownResults = [];
      this._closeStarted = false;
    }

    onOpen() {
      this.closed = false;
      this._closeStarted = false;
      this.reviewPageState = {
        cursors: [null], index: 0, nextCursor: null, generation: this.reviewPageState.generation + 1,
      };
      this.reviewSkippedFamilyKeys.clear();
      this.reviewSkippedItemKeys.clear();
      this.modalEl?.addClass?.("vocabulary-workbench-modal");
      this._renderShell();
      this._renderTab();
    }

    onClose() {
      this.closed = true;
      this.renderEpoch += 1;
      this.detailEpoch += 1;
      this.listEpoch += 1;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = null;
      this.contentEl?.empty?.();
      if (!this._closeStarted && typeof this.api.close === "function") {
        this._closeStarted = true;
        // Closing a modal must not hold up the viewer unload path.
        Promise.resolve().then(() => this.api.close()).catch((error) => {
          showNotice(`复习会话收尾失败；本地日志已保留，可稍后恢复：${error?.message || error}`);
        });
      }
    }

    _renderShell() {
      const root = this.contentEl;
      root.empty();
      root.addClass?.("vocabulary-workbench");
      const header = root.createDiv({ cls: "vocabulary-workbench__header" });
      header.createEl("h2", { text: "英语学习工作台" });
      this.statusEl = root.createDiv({ cls: "vocabulary-workbench__status", attr: { role: "status", "aria-live": "polite" } });
      this.errorEl = root.createDiv({ cls: "vocabulary-workbench__error", attr: { role: "alert", "aria-live": "assertive" } });
      this.errorEl.hidden = true;
      this.tabList = root.createDiv({ cls: "vocabulary-workbench__tabs", attr: { role: "tablist", "aria-label": "学习工作台" } });
      this.tabButtons = new Map();
      for (const [id, label] of TABS) {
        const button = this._button(this.tabList, label, `tab-${id}`, () => this._activateTab(id));
        button.addClass?.("vocabulary-workbench__tab");
        button.setAttribute?.("role", "tab");
        button.setAttribute?.("aria-selected", id === this.activeTab ? "true" : "false");
        button.setAttribute?.("aria-controls", "vocabulary-workbench-panel");
        button.tabIndex = id === this.activeTab ? 0 : -1;
        button.addEventListener("keydown", (event) => this._onTabKeydown(event, id));
        this.tabButtons.set(id, button);
      }
      this.panel = root.createDiv({ cls: "vocabulary-workbench__panel", attr: { id: "vocabulary-workbench-panel", role: "tabpanel", tabindex: "0" } });
      this.panel.setAttribute?.("aria-labelledby", `tab-${this.activeTab}`);
    }

    _activateTab(id) {
      if (!TABS.some(([key]) => key === id)) return;
      this.activeTab = id;
      for (const [key, button] of this.tabButtons) {
        button.setAttribute?.("aria-selected", key === id ? "true" : "false");
        button.tabIndex = key === id ? 0 : -1;
      }
      this.panel.setAttribute?.("aria-labelledby", `tab-${id}`);
      this._renderTab();
      this.tabButtons.get(id)?.focus?.();
    }

    _onTabKeydown(event, currentId) {
      const index = TABS.findIndex(([id]) => id === currentId);
      let next = null;
      if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
      if (event.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = TABS.length - 1;
      if (next !== null) {
        event.preventDefault?.();
        this._activateTab(TABS[next][0]);
      }
    }

    _renderTab() {
      if (!this.panel || this.closed) return;
      this.renderEpoch += 1;
      const epoch = this.renderEpoch;
      this.panel.empty();
      this.errorEl.hidden = true;
      this.errorEl.textContent = "";
      this._setStatus("");
      if (this.activeTab === "vocabulary") this._renderVocabulary(epoch);
      else if (this.activeTab === "contexts") this._renderContexts(epoch);
      else if (this.activeTab === "review") this._renderReview(epoch);
      else this._renderHistory(epoch);
    }

    _isCurrent(epoch) {
      return !this.closed && epoch === this.renderEpoch;
    }

    _setStatus(message) {
      if (this.statusEl) this.statusEl.textContent = String(message || "");
    }

    _showError(error) {
      if (this.closed || !this.errorEl) return;
      const message = String(error?.message || error || "发生未知错误。");
      this.errorEl.textContent = `操作失败：${message}`;
      this.errorEl.hidden = false;
      this._setStatus("请检查错误信息后重试。");
      showNotice(`词汇工作台：${message}`);
    }

    _track(task, epoch = this.renderEpoch) {
      const pending = Promise.resolve().then(task).catch((error) => {
        if (epoch === null || this._isCurrent(epoch)) this._showError(error);
        return undefined;
      }).finally(() => {
        this.pending.delete(pending);
        this.busyCount = Math.max(0, this.busyCount - 1);
        this.contentEl?.setAttribute?.("aria-busy", this.busyCount ? "true" : "false");
      });
      this.pending.add(pending);
      this.busyCount += 1;
      this.contentEl?.setAttribute?.("aria-busy", "true");
      return pending;
    }

    async whenIdle() {
      while (this.pending.size) await Promise.all([...this.pending]);
    }

    _button(parent, label, action, onClick, { disabled = false, cls = "" } = {}) {
      const button = parent.createEl("button", { text: label, cls, attr: { type: "button", "data-action": action } });
      button.disabled = disabled;
      button.addEventListener("click", () => {
        if (!button.disabled) this._track(async () => {
          button.disabled = true;
          try { await onClick(button); }
          finally { if (!this.closed && button.isConnected !== false) button.disabled = false; }
        });
      });
      return button;
    }

    _field(parent, tag, label, { value = "", type, placeholder = "", action, maxLength } = {}) {
      const wrap = parent.createDiv({ cls: "vocabulary-workbench__field" });
      const id = `vocabulary-workbench-${action || label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      wrap.createEl("label", { text: label, attr: { for: id } });
      const control = wrap.createEl(tag, { attr: { id, ...(action ? { "data-action": action } : {}) } });
      if (type) control.type = type;
      if (placeholder) control.placeholder = placeholder;
      if (maxLength) control.maxLength = maxLength;
      if (tag === "textarea") control.value = String(value ?? "");
      else control.value = String(value ?? "");
      return control;
    }

    _select(parent, label, action, options, current) {
      const select = this._field(parent, "select", label, { action });
      for (const [value, text] of options) {
        const option = select.createEl("option", { text, attr: { value: String(value) } });
        option.value = String(value);
      }
      select.value = String(current ?? "");
      return select;
    }

    _renderVocabulary(epoch) {
      const filters = this.panel.createDiv({ cls: "vocabulary-workbench__filters" });
      const search = this._field(filters, "input", "搜索词汇", { type: "search", value: this.query, placeholder: "输入单词或短语", action: "search" });
      search.autocomplete = "off";
      const type = this._select(filters, "类型", "type-filter", [["", "全部类型"], ["word", "单词"], ["phrase", "短语"]], this.type);
      const status = this._select(filters, "学习状态", "status-filter", STATUS_OPTIONS, this.status);
      const filterChanged = () => {
        this.query = search.value.trim();
        this.type = type.value;
        this.status = status.value;
        this._resetVocabularyCursor();
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
          this.searchTimer = null;
          this._loadVocabularyPage(epoch, list, pagination, selectedCount, bulkControls);
        }, 120);
      };
      search.addEventListener("input", filterChanged);
      type.addEventListener("change", filterChanged);
      status.addEventListener("change", filterChanged);

      const selectedCount = this.panel.createDiv({ cls: "vocabulary-workbench__selection", attr: { "data-role": "selection-count" } });
      const bulkControls = this.panel.createDiv({ cls: "vocabulary-workbench__bulk" });
      this._button(bulkControls, "加入复习", "bulk-enroll", () => this._changeEnrollment(true, epoch));
      this._button(bulkControls, "移出复习", "bulk-unenroll", () => this._changeEnrollment(false, epoch));
      const list = this.panel.createDiv({ cls: "vocabulary-workbench__list", attr: { "data-role": "vocabulary-list", "aria-live": "polite" } });
      const pagination = this.panel.createDiv({ cls: "vocabulary-workbench__pagination" });
      this._button(pagination, "上一页", "previous-page", () => {
        if (this.pageIndex > 0) {
          this.pageIndex -= 1;
          this.cursorStack.length = this.pageIndex + 1;
          return this._loadVocabularyPage(epoch, list, pagination, selectedCount, bulkControls);
        }
      }, { disabled: this.pageIndex === 0 });
      this._button(pagination, "下一页", "next-page", () => this._advanceVocabularyPage(epoch, list, pagination, selectedCount, bulkControls));
      this._button(this.panel, "查看选中词族语境", "open-contexts", () => {
        const key = this.selectedKeys.values().next().value || this.selectedFamilyKey;
        if (!key) return this._setStatus("先选择一个词族，再查看对应语境。");
        this.selectedFamilyKey = key;
        this._activateTab("contexts");
      }, { cls: "vocabulary-workbench__secondary" });
      this._renderTransferControls(epoch);
      this._loadVocabularyPage(epoch, list, pagination, selectedCount, bulkControls);
    }

    _resetVocabularyCursor() {
      this.cursorStack = [null];
      this.pageIndex = 0;
    }

    async _advanceVocabularyPage(epoch, list, pagination, selectedCount, bulkControls) {
      if (!this.currentNextCursor) return;
      this.cursorStack = this.cursorStack.slice(0, this.pageIndex + 1);
      this.cursorStack.push(this.currentNextCursor);
      this.pageIndex += 1;
      await this._loadVocabularyPage(epoch, list, pagination, selectedCount, bulkControls);
    }

    async _loadVocabularyPage(epoch, list, pagination, selectedCount, bulkControls) {
      const generation = ++this.listEpoch;
      if (!this._isCurrent(epoch)) return;
      list.empty();
      list.setAttribute?.("aria-busy", "true");
      this._setStatus("正在读取词库…");
      try {
        const page = await this.api.listFamilies({
          query: this.query,
          type: this.type || undefined,
          status: this.status ? Number(this.status) : undefined,
          limit: PAGE_SIZE,
          cursor: this.cursorStack[this.pageIndex] || undefined,
        });
        if (!this._isCurrent(epoch) || generation !== this.listEpoch) return;
        const families = Array.isArray(page?.families) ? page.families : [];
        if (families.length > PAGE_SIZE) throw new Error(`词库服务返回了 ${families.length} 个词族，超过每页 ${PAGE_SIZE} 条上限；未显示截断数据。`);
        this.currentNextCursor = page?.nextCursor || null;
        for (const family of families) this._renderFamilyRow(list, family);
        if (!families.length) list.createDiv({ cls: "vocabulary-workbench__empty", text: "没有符合条件的词汇。" });
        selectedCount.textContent = `已选 ${this.selectedKeys.size} / ${PAGE_SIZE}`;
        pagination.setAttribute?.("data-page", String(this.pageIndex + 1));
        const previous = pagination.querySelector?.('[data-action="previous-page"]');
        const next = pagination.querySelector?.('[data-action="next-page"]');
        if (previous) previous.disabled = this.pageIndex === 0;
        if (next) next.disabled = !this.currentNextCursor;
        this._setStatus(`第 ${this.pageIndex + 1} 页 · ${Number(page?.total || 0)} 个词族`);
      } catch (error) {
        if (this._isCurrent(epoch) && generation === this.listEpoch) this._showError(error);
      } finally {
        if (this._isCurrent(epoch) && generation === this.listEpoch) list.setAttribute?.("aria-busy", "false");
      }
    }

    _renderFamilyRow(list, family) {
      const row = list.createDiv({ cls: "vocabulary-workbench__row", attr: { "data-family-key": family?.familyKey || "" } });
      const familyKey = String(family?.familyKey || "");
      const checkbox = row.createEl("input", { attr: { type: "checkbox", "aria-label": `选择 ${family?.records?.[0]?.surface || "词族"}`, "data-action": "select-family", "data-family-key": familyKey } });
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedKeys.has(familyKey);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          if (this.selectedKeys.size >= PAGE_SIZE) {
            checkbox.checked = false;
            this._setStatus(`一次最多选择 ${PAGE_SIZE} 个词族。`);
            return;
          }
          this.selectedKeys.add(familyKey);
          this.selectedStatusByKey.set(familyKey, family?.status);
          this.selectedFamilyKey = familyKey;
        } else {
          this.selectedKeys.delete(familyKey);
          this.selectedStatusByKey.delete(familyKey);
        }
        const count = this.panel.querySelector?.('[data-role="selection-count"]');
        if (count) count.textContent = `已选 ${this.selectedKeys.size} / ${PAGE_SIZE}`;
      });
      const record = family?.records?.[0] || {};
      const summary = row.createDiv({ cls: "vocabulary-workbench__row-main" });
      summary.createEl("strong", { text: String(record.surface || "（无表面词形）") });
      summary.createEl("span", { text: `${family?.type === "phrase" ? "短语" : "单词"} · ${STATUS_OPTIONS.find(([value]) => Number(value) === family?.status)?.[1] || "未知状态"}` });
      if (record.translation) summary.createEl("span", { text: record.translation, cls: "vocabulary-workbench__translation" });
      const detail = this._button(row, "详情", `details-${this._safeActionKey(familyKey)}`, () => this._openDetails(familyKey), { cls: "vocabulary-workbench__secondary" });
      detail.setAttribute?.("aria-label", `查看 ${record.surface || "词族"} 详情`);
    }

    _safeActionKey(value) {
      return String(value).replace(/[^a-z0-9_-]/gi, "-").slice(-36) || "family";
    }

    async _changeEnrollment(enrolled, epoch) {
      const selected = [...this.selectedKeys];
      const knownCount = enrolled ? selected.filter((key) => this.selectedStatusByKey.get(key) === 5).length : 0;
      const keys = enrolled ? selected.filter((key) => this.selectedStatusByKey.get(key) !== 5) : selected;
      if (!keys.length) {
        this._setStatus(knownCount ? "已知词汇不会加入复习；选择了的已知词族没有加入。" : "请先选择词族。");
        return;
      }
      if (typeof this.api.setReviewEnrollment !== "function") throw new Error("复习列表服务尚未连接。");
      this._setStatus(enrolled ? "正在加入复习…" : "正在移出复习…");
      const result = await this.api.setReviewEnrollment(keys, { enrolled });
      if (!this._isCurrent(epoch)) return;
      this.selectedKeys.clear();
      this.selectedStatusByKey.clear();
      const results = Array.isArray(result) ? result : result?.results;
      const failures = Array.isArray(results) ? results.filter((item) => ["conflict", "error", "missing", "known-filtered", "skipped-known"].includes(item?.status)).length : 0;
      const completed = Array.isArray(results) ? results.length - failures : keys.length;
      const skipped = failures + knownCount;
      this._setStatus(`${enrolled ? "加入" : "移出"}复习已处理 ${completed} 个词族；跳过或未完成 ${skipped} 个。`);
      this._renderTab();
    }

    async _openDetails(familyKey) {
      const epoch = this.renderEpoch;
      const generation = ++this.detailEpoch;
      this.selectedFamilyKey = familyKey;
      this.detailPanel?.remove?.();
      const detail = this.panel.createDiv({ cls: "vocabulary-workbench__detail", attr: { "data-role": "family-detail", "aria-busy": "true" } });
      this.detailPanel = detail;
      detail.createEl("h3", { text: "正在读取词族详情…" });
      this._setStatus("正在读取详情和词典释义…");
      try {
        if (typeof this.api.getFamilyDetails !== "function") throw new Error("词族详情服务尚未连接。");
        const result = await this.api.getFamilyDetails(familyKey);
        if (!this._isCurrent(epoch) || generation !== this.detailEpoch || detail.parentNode !== this.panel) return;
        const family = result?.family || result;
        const record = family?.records?.[0];
        if (!family || !record) throw new Error("词族不存在或没有可编辑词形。");
        detail.empty();
        detail.setAttribute?.("aria-busy", "false");
        detail.createEl("h3", { text: record.surface });
        const dictionary = result?.dictionary;
        const reference = detail.createDiv({ cls: "vocabulary-workbench__dictionary", attr: { "data-role": "dictionary-reference" } });
        reference.createEl("strong", { text: "词典参考" });
        reference.createEl("p", { text: dictionary?.translation || "未找到词典释义。" });
        if (dictionary?.phonetic) reference.createEl("span", { text: dictionary.phonetic });
        const form = detail.createDiv({ cls: "vocabulary-workbench__detail-form" });
        const status = this._select(form, "学习状态", "detail-status", STATUS_OPTIONS.slice(1), String(family.status || record.status || 1));
        const translation = this._field(form, "textarea", "我的释义", { value: record.translation || "", action: "detail-translation", maxLength: 4096 });
        const phonetic = this._field(form, "input", "音标", { value: record.phonetic || "", action: "detail-phonetic", maxLength: 256 });
        const note = this._field(form, "textarea", "笔记", { value: record.note || "", action: "detail-note", maxLength: 4096 });
        this._button(form, "保存修改", "save-details", async (button) => {
          const fields = { status: Number(status.value), translation: translation.value, phonetic: phonetic.value, note: note.value };
          if (typeof this.api.updateFamily !== "function") throw new Error("词族编辑服务尚未连接。");
          button.textContent = "正在保存…";
          const saved = await this.api.updateFamily({ familyKey, surface: record.surface, fields });
          if (!this._isCurrent(epoch) || generation !== this.detailEpoch) return;
          const refreshed = this._applySavedFamily(family, saved, fields);
          if (!this._isCurrent(epoch) || generation !== this.detailEpoch) return;
          this.selectedFamilyKey = familyKey;
          this._setStatus("词族修改已保存。");
          if (refreshed) this._replaceDetailWithSaved(refreshed, dictionary, epoch, generation);
        });
        this._button(form, "查看该词族语境", "detail-contexts", () => {
          this.selectedFamilyKey = familyKey;
          this._activateTab("contexts");
        }, { cls: "vocabulary-workbench__secondary" });
        this._setStatus("详情已加载；词典查询只在打开详情时发生。");
      } catch (error) {
        if (this._isCurrent(epoch) && generation === this.detailEpoch) this._showError(error);
      }
    }

    _replaceDetailWithSaved(family, dictionary, epoch, generation) {
      if (!this._isCurrent(epoch) || generation !== this.detailEpoch) return;
      const detail = this.detailPanel;
      if (!detail) return;
      detail.empty();
      const record = family.records?.[0] || {};
      detail.createEl("h3", { text: record.surface || "词族详情" });
      const reference = detail.createDiv({ cls: "vocabulary-workbench__dictionary" });
      reference.createEl("strong", { text: "词典参考" });
      reference.createEl("p", { text: dictionary?.translation || "未找到词典释义。" });
      const form = detail.createDiv({ cls: "vocabulary-workbench__detail-form" });
      this._select(form, "学习状态", "detail-status", STATUS_OPTIONS.slice(1), String(family.status || record.status || 1));
      this._field(form, "textarea", "我的释义", { value: record.translation || "", action: "detail-translation", maxLength: 4096 });
      this._field(form, "input", "音标", { value: record.phonetic || "", action: "detail-phonetic", maxLength: 256 });
      this._field(form, "textarea", "笔记", { value: record.note || "", action: "detail-note", maxLength: 4096 });
      this._button(form, "保存修改", "save-details", async (button) => {
        const nextStatus = form.querySelector?.('[data-action="detail-status"]')?.value || family.status;
        const nextTranslation = form.querySelector?.('[data-action="detail-translation"]')?.value ?? record.translation ?? "";
        const nextPhonetic = form.querySelector?.('[data-action="detail-phonetic"]')?.value ?? record.phonetic ?? "";
        const nextNote = form.querySelector?.('[data-action="detail-note"]')?.value ?? record.note ?? "";
        button.textContent = "正在保存…";
        const saved = await this.api.updateFamily({ familyKey: family.familyKey, surface: record.surface, fields: {
          status: Number(nextStatus), translation: nextTranslation, phonetic: nextPhonetic, note: nextNote,
        } });
        if (!this._isCurrent(epoch) || generation !== this.detailEpoch) return;
        const updated = this._applySavedFamily(family, saved, {
          status: Number(nextStatus), translation: nextTranslation, phonetic: nextPhonetic, note: nextNote,
        });
        if (updated) this._replaceDetailWithSaved(updated, dictionary, epoch, generation);
        this._setStatus("词族修改已保存。");
      });
      this._button(form, "查看该词族语境", "detail-contexts", () => {
        this.selectedFamilyKey = family.familyKey;
        this._activateTab("contexts");
      }, { cls: "vocabulary-workbench__secondary" });
    }

    _applySavedFamily(previous, saved, fields) {
      if (saved?.family?.records) return saved.family;
      if (saved?.records) return saved;
      const record = saved && typeof saved.key === "string"
        ? saved
        : { ...(previous.records?.[0] || {}), ...fields };
      const records = (previous.records || []).map((item) => ({
        ...item,
        ...(item.key === record.key ? record : {}),
        ...(fields.status == null ? {} : { status: Number(fields.status) }),
      }));
      if (!records.some((item) => item.key === record.key)) records.push(record);
      return { ...previous, status: fields.status == null ? previous.status : Number(fields.status), records };
    }

    _renderTransferControls(epoch) {
      const section = this.panel.createDiv({ cls: "vocabulary-workbench__transfer" });
      section.createEl("h3", { text: "导入与导出" });
      section.createEl("p", { text: "JSON 包含个人词汇、Context 和 Review 当前状态；不包含 History；最大 64 MiB。CSV 仅包含个人词汇核心记录，不包含 Context、Review 或 History。超限内容会明确拒绝，不会截断。" });
      const text = this._field(section, "textarea", "导入文本 / 导出结果", { action: "transfer-text", placeholder: "粘贴 JSON 或 CSV；导出后可复制。" });
      text.spellcheck = false;
      const overwriteExisting = this._field(section, "input", "明确覆盖已有记录", { type: "checkbox", action: "overwrite-existing" });
      overwriteExisting.type = "checkbox";
      const overwriteKnown = this._field(section, "input", "明确允许覆盖已知词汇", { type: "checkbox", action: "overwrite-known" });
      overwriteKnown.type = "checkbox";
      const controls = section.createDiv({ cls: "vocabulary-workbench__transfer-actions" });
      this._button(controls, "导入 JSON（完整数据）", "import-json", async (button) => {
        if (utf8ByteLength(text.value) > MAX_BUNDLE_BYTES) throw new Error("完整 JSON 导入内容超过 64 MiB 限制。");
        if (typeof this.api.importJson !== "function") throw new Error("完整 JSON 导入服务尚未连接。");
        button.textContent = "正在导入…";
        const result = await this.api.importJson(text.value, { defaultStatus: 1, overwriteExisting: overwriteExisting.checked, overwriteKnown: overwriteKnown.checked });
        if (result?.status === "conflict" || result?.reloadError) throw new Error("导入存在冲突，尚未确认完成；请重载并检查数据。");
        if (this._isCurrent(epoch)) {
          this._setStatus(`JSON 导入完成：新增 ${result?.imported || 0}，更新 ${result?.updated || 0}，保留已有 ${(result?.skippedExisting || 0) + (result?.skippedKnown || 0)}。`);
          this._resetVocabularyCursor();
          this._renderTab();
        }
      });
      this._button(controls, "导入 CSV（仅个人词汇）", "import-csv", async (button) => {
        if (text.value.length > MAX_CSV_CHARS) throw new Error("CSV 导入内容超过 8 MiB 字符限制。");
        if (typeof this.api.importCsv !== "function") throw new Error("CSV 个人词汇导入服务尚未连接。");
        button.textContent = "正在导入…";
        const result = await this.api.importCsv(text.value, { defaultStatus: 1, overwriteExisting: overwriteExisting.checked, overwriteKnown: overwriteKnown.checked });
        if (this._isCurrent(epoch)) {
          this._setStatus(`CSV 导入完成：新增 ${result?.imported || 0}，更新 ${result?.updated || 0}，无效 ${result?.invalid || 0}。`);
          this._resetVocabularyCursor();
          this._renderTab();
        }
      }, { cls: "vocabulary-workbench__secondary" });
      this._button(controls, "导出 JSON（完整数据）", "export-json", async (button) => {
        if (typeof this.api.exportJson !== "function") throw new Error("完整 JSON 导出服务尚未连接。");
        button.textContent = "正在导出…";
        const result = await this.api.exportJson();
        if (this._isCurrent(epoch)) {
          text.value = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          text.focus?.();
          text.select?.();
          this._setStatus("完整 JSON 已放入文本框，可复制保存。");
        }
      }, { cls: "vocabulary-workbench__secondary" });
      this._button(controls, "导出 CSV（仅个人词汇）", "export-csv", async (button) => {
        if (typeof this.api.exportCsv !== "function") throw new Error("CSV 个人词汇导出服务尚未连接。");
        button.textContent = "正在导出…";
        const result = await this.api.exportCsv();
        if (this._isCurrent(epoch)) {
          text.value = String(result ?? "");
          text.focus?.();
          text.select?.();
          this._setStatus("个人词汇 CSV 已放入文本框；不含 Context、Review 或 History。");
        }
      }, { cls: "vocabulary-workbench__secondary" });
      section.createEl("p", { text: "学习条目导出独立于词库完整 JSON / CSV；支持 JSON、Markdown、CSV 和 Anki TSV，结果放入上方文本框，可复制保存。" });
      for (const [format, label] of [["json", "JSON"], ["markdown", "Markdown"], ["csv", "CSV"], ["anki-tsv", "Anki TSV"]]) {
        this._button(controls, `导出学习条目（${label}）`, `export-learning-${format}`, async (button) => {
          if (typeof this.api.exportLearning !== "function") throw new Error("学习条目导出服务尚未连接。");
          button.textContent = "正在导出…";
          const result = await this.api.exportLearning(format);
          if (typeof result?.content !== "string") throw new Error("学习条目导出没有返回完整文本；未写入截断结果。");
          if (this._isCurrent(epoch)) {
            text.value = result.content;
            text.focus?.();
            text.select?.();
            this._setStatus(`学习条目 ${label} 导出完成：${Number(result.itemCount || 0)} 条，已放入文本框。`);
          }
        }, { cls: "vocabulary-workbench__secondary" });
      }
    }

    _renderContexts(epoch) {
      this.panel.createEl("h3", { text: "语境" });
      this.panel.createEl("p", { text: "打开来源时会按稳定文档身份重新验证 PDF 和选区；来源失效时不会按旧路径或坐标猜测。" });
      const key = this.selectedFamilyKey || this.selectedKeys.values().next().value;
      if (!key) {
        this.panel.createDiv({ cls: "vocabulary-workbench__empty", text: "从词库选择一个词族，再查看它保存的语境。" });
        this._button(this.panel, "返回词库", "contexts-vocabulary", () => this._activateTab("vocabulary"), { cls: "vocabulary-workbench__secondary" });
        return;
      }
      if (this.contextPageState.familyKey !== key) {
        this.contextPageState = { familyKey: key, cursors: [null], index: 0, nextCursor: null, generation: 0 };
      }
      const list = this.panel.createDiv({ cls: "vocabulary-workbench__list", attr: { "data-role": "context-list", "aria-busy": "true" } });
      const familyKeyLabel = this.panel.createEl("code", { text: key });
      familyKeyLabel.addClass?.("vocabulary-workbench__family-key");
      this._button(this.panel, "返回词库", "contexts-vocabulary", () => this._activateTab("vocabulary"), { cls: "vocabulary-workbench__secondary" });
      const pagination = this.panel.createDiv({ cls: "vocabulary-workbench__pagination", attr: { "data-role": "context-pagination" } });
      this._button(pagination, "上一页", "contexts-previous", () => {
        const state = this.contextPageState;
        if (state.index === 0) return;
        state.index -= 1;
        state.cursors.length = state.index + 1;
        return this._loadContextPage(epoch, key, list, pagination);
      }, { disabled: this.contextPageState.index === 0 });
      this._button(pagination, "下一页", "contexts-next", () => {
        const state = this.contextPageState;
        if (!state.nextCursor) return;
        state.cursors.length = state.index + 1;
        state.cursors.push(state.nextCursor);
        state.index += 1;
        return this._loadContextPage(epoch, key, list, pagination);
      }, { disabled: !this.contextPageState.nextCursor });
      this._loadContextPage(epoch, key, list, pagination);
    }

    async _loadContextPage(epoch, key, list, pagination) {
      const state = this.contextPageState;
      const generation = ++state.generation;
      if (!this._isCurrent(epoch)) return;
      list.empty();
      list.setAttribute?.("aria-busy", "true");
      this._setStatus("正在读取语境…");
      try {
        if (typeof this.api.listContexts !== "function") throw new Error("Context 列表服务尚未连接。");
        const page = await this.api.listContexts(key, { limit: PAGE_SIZE, cursor: state.cursors[state.index] || undefined });
        if (!this._isCurrent(epoch) || generation !== state.generation) return;
        const contexts = Array.isArray(page?.contexts) ? page.contexts : [];
        if (contexts.length > PAGE_SIZE) throw new Error(`Context 服务返回了 ${contexts.length} 条记录，超过每页 ${PAGE_SIZE} 条上限；未显示截断数据。`);
        state.nextCursor = page?.nextCursor || null;
        for (const context of contexts) {
          const row = list.createDiv({ cls: "vocabulary-workbench__context-row", attr: { "data-role": "context-record" } });
          row.createEl("strong", { text: context.surface || key });
          row.createEl("p", { text: context.sentence || "（无句子）" });
          row.createEl("span", { text: [context.pageNumberHint ? `第 ${context.pageNumberHint} 页` : "来源页未知",
            context.createdAt ? `保存于 ${context.createdAt}` : ""].filter(Boolean).join(" · ") });
          this._button(row, "验证并打开来源", `context-open-${this._safeActionKey(context.contextId)}`, async () => {
            if (typeof this.api.openContext !== "function") throw new Error("Context 来源导航服务尚未连接。");
            const result = await this.api.openContext(context.contextId);
            if (this._isCurrent(epoch)) this._setStatus(result?.message || "已请求打开来源；Reader 会在导航前再次验证身份。");
          }, { cls: "vocabulary-workbench__secondary" });
          this._button(row, "加入复习", `context-add-review-${this._safeActionKey(context.contextId)}`, async () => {
            if (typeof this.api.addContextToReview !== "function") throw new Error("Context 加入复习的草稿服务尚未连接。");
            const result = await this.api.addContextToReview(context.contextId);
            if (!this._isCurrent(epoch)) return;
            if (["cancelled", "canceled"].includes(result?.status)) {
              this._setStatus("已取消学习草稿；未加入复习。");
            } else if (result?.status === "missing") {
              this._setStatus("该 Context 已不可用；未创建学习草稿。");
            } else {
              this._setStatus(result?.message || "学习草稿已打开；取消不会写入，确认后才会加入复习。");
            }
          }, { cls: "vocabulary-workbench__secondary" });
        }
        if (!contexts.length) list.createDiv({ cls: "vocabulary-workbench__empty", text: "这个词族还没有保存语境。" });
        pagination.setAttribute?.("data-page", String(state.index + 1));
        const previous = pagination.querySelector?.('[data-action="contexts-previous"]');
        const next = pagination.querySelector?.('[data-action="contexts-next"]');
        if (previous) previous.disabled = state.index === 0;
        if (next) next.disabled = !state.nextCursor;
        this._setStatus(`语境第 ${state.index + 1} 页 · 共 ${Number(page?.total || contexts.length)} 条`);
      } catch (error) {
        if (this._isCurrent(epoch) && generation === state.generation) this._showError(error);
      } finally {
        if (this._isCurrent(epoch) && generation === state.generation) list.setAttribute?.("aria-busy", "false");
      }
    }

    _renderReview(epoch) {
      this.panel.createEl("h3", { text: "今日复习" });
      this.panel.createEl("p", { text: "选择“记住”或“忘记”更新复习进度；“跳过”只在本次打开的复习会话中隐藏该复习项，不写入复习记录。" });
      const list = this.panel.createDiv({ cls: "vocabulary-workbench__list", attr: { "data-role": "review-list", "aria-busy": "true" } });
      const pagination = this.panel.createDiv({ cls: "vocabulary-workbench__pagination", attr: { "data-role": "review-pagination" } });
      this._button(pagination, "上一页", "review-previous", () => {
        const state = this.reviewPageState;
        if (state.index === 0) return;
        state.index -= 1;
        state.cursors.length = state.index + 1;
        return this._loadReviewPage(epoch, list, pagination);
      }, { disabled: this.reviewPageState.index === 0 });
      this._button(pagination, "下一页", "review-next", () => {
        const state = this.reviewPageState;
        if (!state.nextCursor) return;
        state.cursors.length = state.index + 1;
        state.cursors.push(state.nextCursor);
        state.index += 1;
        return this._loadReviewPage(epoch, list, pagination);
      }, { disabled: !this.reviewPageState.nextCursor });
      this._loadReviewPage(epoch, list, pagination);
    }

    async _loadReviewPage(epoch, list, pagination) {
      const state = this.reviewPageState;
      const generation = ++state.generation;
      if (!this._isCurrent(epoch)) return;
      list.empty();
      list.setAttribute?.("aria-busy", "true");
      this._setStatus("正在读取今日复习…");
      try {
        if (typeof this.api.listDueReview !== "function") throw new Error("今日复习列表服务尚未连接。");
        const page = await this.api.listDueReview({ limit: PAGE_SIZE, cursor: state.cursors[state.index] || undefined });
        if (!this._isCurrent(epoch) || generation !== state.generation) return;
        const items = Array.isArray(page?.items) ? page.items : [];
        if (items.length > PAGE_SIZE) throw new Error(`Review 服务返回了 ${items.length} 条记录，超过每页 ${PAGE_SIZE} 条上限；未显示截断数据。`);
        const normalizedItems = items.map((item) => this._normalizeReviewItem(item));
        state.nextCursor = page?.nextCursor || null;
        const visibleItems = normalizedItems.filter((item) => !this.reviewSkippedItemKeys.has(item.sessionKey) &&
          !(item.providerId === "vocabulary" && this.reviewSkippedFamilyKeys.has(item.familyKey)));
        for (const item of visibleItems) {
          const row = list.createDiv({ cls: "vocabulary-workbench__row vocabulary-workbench__review-row", attr: {
            "data-role": "review-row", "data-provider-id": item.providerId, "data-item-id": item.itemId,
          } });
          const main = row.createDiv({ cls: "vocabulary-workbench__row-main" });
          let label;
          if (item.providerId === "learning") {
            label = item.prompt || "学习问题";
            main.createEl("strong", { text: label });
            main.createEl("p", { text: `答案：${item.answer || "（无答案）"}` });
            if (item.targetText) main.createEl("span", { text: `原文：${item.targetText}` });
            this._button(row, "返回来源", `review-source-learning-${this._safeActionKey(item.itemId)}`,
              () => this._openReviewSource(item, epoch), { cls: "vocabulary-workbench__secondary" });
          } else {
            const record = item.record;
            label = record.surface || item.familyKey || "词族";
            main.createEl("strong", { text: label });
            if (record.translation) main.createEl("span", { text: record.translation });
            const open = this._button(row, "词库详情", `review-details-${this._safeActionKey(item.familyKey)}`, () => {
              this.selectedFamilyKey = item.familyKey;
              this.activeTab = "vocabulary";
              this._renderShell();
              this._renderTab();
              this._openDetails(item.familyKey);
            }, { cls: "vocabulary-workbench__secondary" });
            open.setAttribute?.("aria-label", `在词库中查看 ${label}`);
            this._button(row, "来源", `review-source-vocabulary-${this._safeActionKey(item.itemId)}`,
              () => this._openReviewSource(item, epoch), { cls: "vocabulary-workbench__secondary" });
          }
          main.createEl("span", { text: `第 ${item.state?.box || 1} 箱 · 到期：${formatLocalReviewTime(item.dueAt)}` });
          const actions = row.createDiv({ cls: "vocabulary-workbench__review-actions", attr: { role: "group", "aria-label": `复习 ${label}` } });
          for (const [kind, label] of [["remember", "记住"], ["forget", "忘记"], ["skip", "跳过"]]) {
            const button = this._button(actions, label, `review-${kind}-${item.providerId}-${this._safeActionKey(item.itemId)}`,
              () => this._runReviewAction(kind, item, epoch, list, pagination),
              { cls: kind === "skip" ? "vocabulary-workbench__secondary" : "" });
            button.setAttribute?.("aria-label", `${label}：${item.providerId === "learning" ? item.prompt || "学习问题" : item.record.surface || "词族"}`);
          }
        }
        if (!visibleItems.length) list.createDiv({ cls: "vocabulary-workbench__empty", text: normalizedItems.length
          ? (normalizedItems.every((item) => item.providerId === "vocabulary")
            ? "本页到期词族已在本次会话中跳过；可继续翻页。"
            : "本页到期复习项已在本次会话中跳过；可继续翻页。")
          : "今天没有到期的复习项。" });
        pagination.setAttribute?.("data-page", String(state.index + 1));
        const previous = pagination.querySelector?.('[data-action="review-previous"]');
        const next = pagination.querySelector?.('[data-action="review-next"]');
        if (previous) previous.disabled = state.index === 0;
        if (next) next.disabled = !state.nextCursor;
        const hasTotal = typeof page?.total === "number" && Number.isFinite(page.total) && page.total >= 0;
        this._setStatus(hasTotal
          ? `今日复习第 ${state.index + 1} 页 · 共 ${page.total} 个复习项`
          : `今日复习第 ${state.index + 1} 页 · 本页 ${items.length} 个复习项 · 总数未知`);
      } catch (error) {
        if (this._isCurrent(epoch) && generation === state.generation) this._showError(error);
      } finally {
        if (this._isCurrent(epoch) && generation === state.generation) list.setAttribute?.("aria-busy", "false");
      }
    }

    _normalizeReviewItem(item) {
      if (!item || typeof item !== "object") throw new Error("Review 服务返回了无效条目；未显示部分结果。");
      const providerId = item.providerId || "vocabulary";
      if (providerId !== "vocabulary" && providerId !== "learning") {
        throw new Error(`Review 服务返回了不支持的来源 ${String(providerId)}；未显示部分结果。`);
      }
      const familyKey = providerId === "vocabulary"
        ? (typeof item.familyKey === "string" && item.familyKey ? item.familyKey : item.itemId)
        : null;
      const itemId = typeof item.itemId === "string" && item.itemId ? item.itemId : familyKey;
      if (typeof itemId !== "string" || !itemId || (providerId === "vocabulary" && (typeof familyKey !== "string" || !familyKey))) {
        throw new Error("Review 服务返回的条目缺少稳定身份；未显示部分结果。");
      }
      const state = item.reviewState || item.state || {};
      const dueAt = item.dueAt || state.dueAt;
      const record = item.record || item.family?.records?.[0] || {};
      return {
        ...item, providerId, itemId, familyKey, state, dueAt, record,
        sessionKey: `${providerId}\u0000${itemId}`,
      };
    }

    async _openReviewSource(item, epoch) {
      if (typeof this.api.openReviewSource !== "function") throw new Error("复习来源导航服务尚未连接。");
      const request = item.providerId === "vocabulary"
        ? { providerId: "vocabulary", familyKey: item.familyKey }
        : { providerId: "learning", itemId: item.itemId };
      const result = await this.api.openReviewSource(request);
      if (!this._isCurrent(epoch)) return;
      if (result?.status === "opening") {
        this._setStatus(result.message || "Reader 已接受来源请求；正在验证后打开。");
        this.close();
      } else if (result?.status === "choose-context") {
        if (typeof result.familyKey !== "string" || !result.familyKey) {
          this._setStatus("来源需要选择语境，但服务没有返回词族身份；工作台保持打开。");
          return;
        }
        this.selectedFamilyKey = result.familyKey;
        this._activateTab("contexts");
        this._setStatus("请从现有语境列表选择要查看的 Context。");
      } else if (result?.status === "missing") {
        this._setStatus("来源已删除或不可用；学习条目仍保留，工作台保持打开。");
      } else {
        this._setStatus(result?.message || "来源尚未打开；工作台保持打开。");
      }
    }

    async _runReviewAction(kind, item, epoch, list, pagination) {
      if (typeof this.api.applyReviewAction !== "function") throw new Error("复习评分服务尚未连接。");
      const reviewItem = this._normalizeReviewItem(item);
      const actionKey = `${reviewItem.providerId}\u0000${kind}\u0000${reviewItem.itemId}`;
      let actionId = this.reviewActionIds.get(actionKey);
      if (!actionId) {
        const randomId = globalThis.crypto?.randomUUID?.();
        actionId = `workbench-review-${randomId || `${Date.now().toString(36)}-${++reviewActionFallbackSequence}`}`;
        this.reviewActionIds.set(actionKey, actionId);
      }
      const label = ({ remember: "记住", forget: "忘记", skip: "跳过" })[kind] || "复习";
      this._setStatus(`正在${label}…`);
      const request = { kind, providerId: reviewItem.providerId, itemId: reviewItem.itemId, actionId };
      if (reviewItem.providerId === "vocabulary") request.familyKey = reviewItem.familyKey;
      const result = await this.api.applyReviewAction(request);
      if (!this._isCurrent(epoch)) return;
      this.reviewActionIds.delete(actionKey);
      if (kind === "skip" && result?.status === "skipped") {
        this.reviewSkippedItemKeys.add(reviewItem.sessionKey);
        if (reviewItem.providerId === "vocabulary") this.reviewSkippedFamilyKeys.add(reviewItem.familyKey);
      }
      if (result?.status === "known-filtered" && reviewItem.providerId === "vocabulary") {
        this.reviewSkippedItemKeys.add(reviewItem.sessionKey);
        this.reviewSkippedFamilyKeys.add(reviewItem.familyKey);
      }
      if (result?.status === "known-filtered") this._setStatus("该词族已标为已知，未写入复习状态。");
      else if (result?.status === "not-due") this._setStatus("该词族已不在到期队列中；列表已刷新。");
      else this._setStatus(kind === "skip" ? "已在本次复习会话中跳过；未写入持久数据。" : `${label}已确认。`);
      this.reviewPageState.cursors = [null];
      this.reviewPageState.index = 0;
      this.reviewPageState.nextCursor = null;
      return this._loadReviewPage(epoch, list, pagination);
    }

    _renderHistory(epoch) {
      this.panel.createEl("h3", { text: "历史" });
      this.panel.createEl("p", { text: "先预览字段状态；只恢复无冲突且可完整恢复的字段组，不覆盖冲突项。每页最多显示 100 个批次。" });
      const list = this.panel.createDiv({ cls: "vocabulary-workbench__list", attr: { "data-role": "history-list", "aria-busy": "true" } });
      const pagination = this.panel.createDiv({ cls: "vocabulary-workbench__pagination", attr: { "data-role": "history-pagination" } });
      this._track(async () => {
        if (typeof this.api.listHistory !== "function") throw new Error("History 列表服务尚未连接。");
        const result = await this.api.listHistory({ limit: PAGE_SIZE });
        if (!this._isCurrent(epoch)) return;
        this.historyBatches = Array.isArray(result) ? result : result?.batches || [];
        const pageCount = Math.max(1, Math.ceil(this.historyBatches.length / PAGE_SIZE));
        this.historyPageIndex = Math.min(this.historyPageIndex, pageCount - 1);
        this._renderHistoryPage(list, pagination, epoch);
        list.setAttribute?.("aria-busy", "false");
      });
    }

    _renderHistoryPage(list, pagination, epoch) {
      list.empty();
      pagination.empty();
      const pageCount = Math.max(1, Math.ceil(this.historyBatches.length / PAGE_SIZE));
      const start = this.historyPageIndex * PAGE_SIZE;
      const batches = this.historyBatches.slice(start, start + PAGE_SIZE);
      for (const batch of batches) this._renderHistoryBatch(list, batch, epoch);
      if (!this.historyBatches.length) list.createDiv({ cls: "vocabulary-workbench__empty", text: "还没有可查看的历史批次。" });
      if (pageCount > 1) {
        this._button(pagination, "上一页", "history-previous", () => {
          this.historyPageIndex = Math.max(0, this.historyPageIndex - 1);
          this._renderHistoryPage(list, pagination, epoch);
        }, { disabled: this.historyPageIndex === 0 });
        this._button(pagination, "下一页", "history-next", () => {
          this.historyPageIndex = Math.min(pageCount - 1, this.historyPageIndex + 1);
          this._renderHistoryPage(list, pagination, epoch);
        }, { disabled: this.historyPageIndex >= pageCount - 1 });
      }
      pagination.setAttribute?.("data-page", String(this.historyPageIndex + 1));
      this._setStatus(`历史第 ${this.historyPageIndex + 1} / ${pageCount} 页 · 共 ${this.historyBatches.length} 个批次`);
    }

    _renderHistoryBatch(list, batch, epoch) {
      const row = list.createDiv({ cls: "vocabulary-workbench__history-row", attr: { "data-batch-id": batch.batchId || "" } });
      row.createEl("strong", { text: batch.batchId || "History batch" });
      row.createEl("span", { text: `${batch.kind || batch.actionKind || "批次"} · ${batch.changes?.length || 0} 项 · ${batch.createdAt || ""}` });
      const previewArea = row.createDiv({ cls: "vocabulary-workbench__history-preview", attr: { "data-role": `preview-${this._safeActionKey(batch.batchId)}` } });
      this._button(row, "预览", `preview-history-${this._safeActionKey(batch.batchId)}`, async () => {
        if (typeof this.api.previewHistory !== "function") throw new Error("History 预览服务尚未连接。");
        const preview = await this.api.previewHistory(batch.batchId, { deviceId: batch.deviceId });
        if (!this._isCurrent(epoch) || row.parentNode !== list) return;
        this.preview = preview;
        this.historyPreviewPages.set(batch.batchId, 0);
        this._renderHistoryPreview(previewArea, preview, batch, epoch);
      });
    }

    _renderHistoryPreview(previewArea, preview, batch, epoch) {
      previewArea.empty();
      const allItems = Array.isArray(preview?.items) ? preview.items : [];
      const pageCount = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
      const pageIndex = Math.min(this.historyPreviewPages.get(batch.batchId) || 0, pageCount - 1);
      this.historyPreviewPages.set(batch.batchId, pageIndex);
      const start = pageIndex * PAGE_SIZE;
      const items = allItems.slice(start, start + PAGE_SIZE);
      const eligible = this._cleanRestoreIds(allItems, items);
      previewArea.createEl("p", { text: `本批次 ${allItems.length} 个字段 · 可安全恢复本页 ${eligible.length} 项 · 冲突 ${allItems.filter((item) => item.status === "conflict").length} 项 · 已恢复 ${allItems.filter((item) => item.status === "already-restored").length} 项。每页最多 ${PAGE_SIZE} 项。` });
      for (const item of items) {
        const detail = previewArea.createDiv({ cls: "vocabulary-workbench__history-field", attr: { "data-role": "history-field" } });
        detail.createEl("span", { text: `${item.field || item.fieldPath?.join(".") || "字段"} · ${this._historyStatusLabel(item.status)}` });
        const current = this._historyValue(item.currentExists, item.current);
        const restoreTo = this._historyValue(item.beforeExists, item.before);
        detail.createEl("small", { text: `当前：${current} → 恢复后：${restoreTo}` });
      }
      if (!items.length) previewArea.createDiv({ cls: "vocabulary-workbench__empty", text: "这个批次没有可预览字段。" });
      if (pageCount > 1) {
        const pagination = previewArea.createDiv({ cls: "vocabulary-workbench__pagination", attr: { "data-role": `history-preview-pagination-${this._safeActionKey(batch.batchId)}` } });
        this._button(pagination, "上一页", "history-preview-previous", () => {
          this.historyPreviewPages.set(batch.batchId, Math.max(0, pageIndex - 1));
          this._renderHistoryPreview(previewArea, preview, batch, epoch);
        }, { disabled: pageIndex === 0 });
        this._button(pagination, "下一页", "history-preview-next", () => {
          this.historyPreviewPages.set(batch.batchId, Math.min(pageCount - 1, pageIndex + 1));
          this._renderHistoryPreview(previewArea, preview, batch, epoch);
        }, { disabled: pageIndex >= pageCount - 1 });
      }
      this._button(previewArea, `恢复无冲突项（${eligible.length}）`, `restore-history-${this._safeActionKey(batch.batchId)}`, async () => {
        if (!eligible.length) return this._setStatus("没有可安全恢复的完整字段组。");
        if (typeof this.api.restoreHistory !== "function") throw new Error("History 恢复服务尚未连接。");
        const result = await this.api.restoreHistory(batch.batchId, { selectedCleanIds: eligible, deviceId: batch.deviceId });
        if (!this._isCurrent(epoch)) return;
        this._setStatus(`History 恢复结果：${result?.status || "已提交"}。`);
        this.preview = null;
        this._renderTab();
      }, { disabled: eligible.length === 0, cls: "vocabulary-workbench__secondary" });
      this._setStatus(`已预览第 ${pageIndex + 1} / ${pageCount} 页；冲突字段未选中。`);
    }

    _cleanRestoreIds(items, visibleItems = items) {
      const clean = items.filter((item) => item.status === "clean");
      const cleanIds = new Set(clean.map((item) => item.changeId));
      const visibleIds = new Set(visibleItems.map((item) => item.changeId));
      const groups = new Map();
      for (const item of items) {
        if (item.kind !== "entityCreate" && item.kind !== "entityDelete") continue;
        const key = `${item.storeId}\u0000${item.entityId}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      for (const group of groups.values()) {
        if (!group.every((item) => cleanIds.has(item.changeId) && visibleIds.has(item.changeId))) {
          for (const item of group) cleanIds.delete(item.changeId);
        }
      }
      return [...cleanIds].filter((id) => visibleIds.has(id)).slice(0, PAGE_SIZE);
    }

    _historyStatusLabel(status) {
      return ({ clean: "无冲突", conflict: "冲突", "already-restored": "已恢复" })[status] || "未知";
    }

    _historyValue(exists, value) {
      if (!exists) return "（无值）";
      let text;
      try { text = typeof value === "string" ? value : JSON.stringify(value); }
      catch { text = String(value); }
      const normalized = String(text ?? "undefined").replace(/\s+/gu, " ");
      return normalized.length > 240 ? `${normalized.slice(0, 237)}…` : normalized;
    }
  }

  return VocabularyWorkbenchModal;
}

module.exports = { createVocabularyWorkbench, PAGE_SIZE };
