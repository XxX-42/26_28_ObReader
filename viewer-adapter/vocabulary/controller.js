import { scanPageTextLayer } from "./page-scanner.js";
import { getSelectedPageTokens, matchPhrases } from "./phrase-matcher.js";
import { VocabularyHighlightRenderer } from "./canvas-overlay.js";
import { vocabularyEntryPresentation, vocabularyStatusLabel } from "./presentation.js";

function isPositivePageNumber(value) {
  return Number.isInteger(value) && value > 0;
}

function pageKey(pageNumber) {
  return String(pageNumber);
}

function normalizeHighlightLevels(value) {
  const normalize = (items) => new Set(Array.isArray(items)
    ? items.filter((status) => Number.isInteger(status) && status >= 1 && status <= 5)
    : [1, 2, 3, 4, 5]);
  return { words: normalize(value?.words), phrases: normalize(value?.phrases) };
}

function getVisiblePageViews(pdfViewer) {
  const getVisiblePages = typeof pdfViewer?.getVisiblePages === "function"
    ? pdfViewer.getVisiblePages
    : pdfViewer?._getVisiblePages;
  const result = getVisiblePages?.call(pdfViewer);
  return Array.isArray(result?.views) ? result.views : null;
}

const PAGE_QUERY_KEY_LIMIT = 32768;
const PAGE_QUERY_CHUNK_SIZE = 2048;
const PAGE_QUERY_TEXT_LIMIT = 131072;
const PAGE_RESULT_CACHE_LIMIT = 32;

function pageTokenSignature(tokens) {
  return Array.isArray(tokens) ? tokens.map((token) => token?.surfaceKey || "").join("\u001f") : "";
}

/**
 * Render-generation-scoped page queries and selection requests for the
 * existing Obsidian PDF Reader bridge. It never owns global input listeners.
 */
export class VocabularyController {
  constructor({
    app,
    eventBus,
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    postToHost,
    getIdentity,
    isEnabled = false,
    highlightLevels,
    makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    scan = scanPageTextLayer,
    selectTokens = getSelectedPageTokens,
    phraseMatcher = matchPhrases,
    makeOverlay = (pageRoot) => new VocabularyHighlightRenderer(pageRoot, { documentRef, windowRef }),
  } = {}) {
    if (!app || typeof postToHost !== "function" || typeof getIdentity !== "function") {
      throw new TypeError("VocabularyController requires the PDF.js app and existing bridge callbacks.");
    }
    this.app = app;
    this.eventBus = eventBus;
    this.document = documentRef;
    this.window = windowRef;
    this.postToHost = postToHost;
    this.getIdentity = getIdentity;
    this.makeId = makeId;
    this.scan = scan;
    this.selectTokens = selectTokens;
    this.phraseMatcher = phraseMatcher;
    this.makeOverlay = makeOverlay;
    this.enabled = isEnabled === true;
    this.highlightLevels = normalizeHighlightLevels(highlightLevels);
    this.identity = null;
    this.pages = new Map();
    this.pageResultCache = new Map();
    this.disposed = false;
    this.querySequence = 0;
    this.onTextLayerRendered = ({ pageNumber } = {}) => this.refreshPage(pageNumber, { refreshTokens: true });
    this.onPageRendered = ({ pageNumber } = {}) => {
      // PDF.js may render the text layer just after its page canvas event.
      Promise.resolve().then(() => {
        const page = this.pages.get(pageKey(pageNumber));
        if (!page) this.refreshPage(pageNumber);
        else if (this.isPageVisible(pageNumber) && page.query?.pending.size === 0) this.renderPageResults(page, page.records);
      });
    };
    this.onViewAreaChanged = () => this.scanRenderedPages();
    this.eventBus?._on?.("textlayerrendered", this.onTextLayerRendered);
    this.eventBus?._on?.("pagerendered", this.onPageRendered);
    this.eventBus?._on?.("updateviewarea", this.onViewAreaChanged);
  }

  setDocument(documentId, openRequest, enabled = this.enabled) {
    if (this.disposed) return;
    const next = { documentId, openRequest };
    if (!documentId || !Number.isInteger(openRequest)) {
      this.clearPages();
      this.identity = null;
      this.enabled = false;
      return;
    }
    const changed = !this.identity || this.identity.documentId !== documentId || this.identity.openRequest !== openRequest;
    if (changed) {
      this.clearPages();
      this.pageResultCache.clear();
    }
    this.identity = next;
    this.enabled = enabled === true;
    if (this.enabled) this.scanRenderedPages();
    else this.clearPages();
  }

  setEnabled(enabled) {
    if (this.disposed) return;
    this.enabled = enabled === true;
    if (this.enabled && this.identity) this.scanRenderedPages();
    else this.clearPages();
  }

  setHighlightLevels(levels) {
    if (this.disposed) return false;
    this.highlightLevels = normalizeHighlightLevels(levels);
    if (this.enabled) {
      for (const page of this.pages.values()) this.renderPageResults(page, page.records);
    }
    return true;
  }

  identityIsCurrent(identity = this.identity) {
    if (!identity || !this.identity || this.disposed) return false;
    const current = this.getIdentity();
    return this.identity.documentId === identity.documentId &&
      this.identity.openRequest === identity.openRequest &&
      current?.documentId === identity.documentId &&
      current?.openRequest === identity.openRequest;
  }

  getPageRoot(pageNumber) {
    if (!isPositivePageNumber(pageNumber)) return null;
    return this.app.pdfViewer?.getPageView?.(pageNumber - 1)?.div || null;
  }

  scanRenderedPages() {
    const visiblePages = getVisiblePageViews(this.app.pdfViewer);
    if (!Array.isArray(visiblePages)) return;
    const visible = new Set(visiblePages.map((page) => page?.id).filter(isPositivePageNumber));
    for (const pageNumber of visible) this.refreshPage(pageNumber);
    this.pruneOffscreenPages(visible);
  }

  pruneOffscreenPages(visiblePageNumbers) {
    const current = getVisiblePageViews(this.app.pdfViewer);
    const visible = visiblePageNumbers instanceof Set
      ? visiblePageNumbers
      : new Set(Array.isArray(current) ? current.map((page) => page?.id).filter(isPositivePageNumber) : []);
    for (const [key, page] of this.pages) {
      if (visible.has(page.pageNumber)) continue;
      page.overlay?.dispose?.();
      this.pages.delete(key);
    }
  }

  isPageVisible(pageNumber) {
    const visiblePages = getVisiblePageViews(this.app.pdfViewer);
    if (!Array.isArray(visiblePages)) return false;
    return visiblePages.some((page) => page?.id === pageNumber);
  }

  refreshPage(pageNumber, { refreshTokens = false } = {}) {
    if (!this.enabled || !this.identityIsCurrent() || !isPositivePageNumber(pageNumber) || !this.isPageVisible(pageNumber)) return false;
    const pageRoot = this.getPageRoot(pageNumber);
    const textLayer = pageRoot?.querySelector?.(".textLayer");
    if (!pageRoot || !textLayer) return false;
    const key = pageKey(pageNumber);
    let page = this.pages.get(key);
    const pageReplaced = !page || page.pageRoot !== pageRoot || page.textLayer !== textLayer;
    if (!pageReplaced && !refreshTokens) return false;
    if (pageReplaced) page?.overlay?.dispose?.();
    let tokens;
    try { tokens = this.scan(textLayer); } catch {
      page?.overlay?.dispose?.();
      this.pages.delete(key);
      return false;
    }
    if (!Array.isArray(tokens)) {
      page?.overlay?.dispose?.();
      this.pages.delete(key);
      return false;
    }
    if (!pageReplaced && sameTokenSegments(page.tokens, tokens)) return false;
    let overlay;
    if (pageReplaced) {
      try { overlay = this.makeOverlay(pageRoot); } catch { return false; }
    }
    page = pageReplaced
      ? { pageNumber, pageRoot, textLayer, tokens, signature: pageTokenSignature(tokens), overlay, query: null, records: [] }
      : { ...page, tokens, signature: pageTokenSignature(tokens), query: null, records: [] };
    this.pages.set(key, page);
    return this.queryPage(page);
  }

  queryPage(page, { force = false } = {}) {
    if (!this.enabled || !this.identityIsCurrent() || !page?.tokens?.length) {
      page?.overlay?.clear?.();
      return false;
    }
    // A forced host refresh supersedes an in-flight query. The response from
    // the old query is rejected by queryId once this page points at the new
    // generation; normal scroll/render events keep the existing request.
    if (page.query?.pending?.size > 0 && !force) return true;
    if (!force) {
      const cached = this.pageResultCache.get(page.pageNumber);
      if (cached?.signature === page.signature) {
        this.pageResultCache.delete(page.pageNumber);
        this.pageResultCache.set(page.pageNumber, cached);
        page.records = cached.records;
        page.query = { id: null, pending: new Map(), records: new Map(), finished: true };
        this.renderPageResults(page, page.records);
        return false;
      }
    }
    if (force) this.pageResultCache.delete(page.pageNumber);
    const queryId = `vocab-page-${++this.querySequence}-${this.makeId()}`;
    const keys = new Set();
    // Include all page words first, then page-local n-grams for saved phrases.
    // This bounds pathological pages without ever querying the whole lexicon.
    for (const token of page.tokens) {
      if (token?.surfaceKey) keys.add(token.surfaceKey);
      if (keys.size >= PAGE_QUERY_KEY_LIMIT) break;
    }
    for (let start = 0; start < page.tokens.length && keys.size < PAGE_QUERY_KEY_LIMIT; start += 1) {
      const parts = [];
      for (let end = start; end < Math.min(page.tokens.length, start + 12) && keys.size < PAGE_QUERY_KEY_LIMIT; end += 1) {
        const key = page.tokens[end]?.surfaceKey;
        if (!key) break;
        parts.push(key);
        if (parts.length >= 2) keys.add(parts.join(" "));
      }
    }
    const allKeys = [...keys];
    const query = { id: queryId, pending: new Map(), records: new Map(), finished: false };
    page.query = query;
    page.overlay?.clear?.();
    let partIndex = 0;
    let chunk = [];
    let chunkTextSize = 0;
    const batches = [];
    for (const key of allKeys) {
      const keyTextSize = key.length + 1;
      if (chunk.length && (chunk.length >= PAGE_QUERY_CHUNK_SIZE || chunkTextSize + keyTextSize > PAGE_QUERY_TEXT_LIMIT)) {
        batches.push(chunk);
        chunk = [];
        chunkTextSize = 0;
      }
      chunk.push(key);
      chunkTextSize += keyTextSize;
    }
    if (chunk.length) batches.push(chunk);
    for (const batch of batches) {
      const requestChunk = batch;
      const requestId = `${queryId}-part-${partIndex}`;
      query.pending.set(requestId, partIndex);
      const posted = this.postToHost("vocab-page-query", {
        requestId, queryId, partIndex,
        pageNumber: page.pageNumber,
        documentId: this.identity.documentId,
        openRequest: this.identity.openRequest,
        keys: requestChunk,
      });
      if (!posted) query.pending.delete(requestId);
      partIndex += 1;
    }
    query.finished = true;
    if (query.pending.size === 0) {
      this.cachePageResults(page, []);
      this.renderPageResults(page, []);
    }
    return query.pending.size > 0;
  }

  handlePageResults(message) {
    if (!this.enabled || !this.identityIsCurrent() || !message ||
        message.documentId !== this.identity.documentId ||
        message.openRequest !== this.identity.openRequest ||
        !isPositivePageNumber(message.pageNumber) ||
        typeof message.requestId !== "string" || typeof message.queryId !== "string" ||
        !Number.isInteger(message.partIndex)) return false;
    const page = this.pages.get(pageKey(message.pageNumber));
    const currentPart = page?.query?.pending.get(message.requestId);
    if (!page || page.query.id !== message.queryId || currentPart !== message.partIndex || !Array.isArray(message.records)) return false;
    page.query.pending.delete(message.requestId);
    for (const record of message.records.filter((row) => row && typeof row.key === "string" &&
      ["word", "phrase"].includes(row.type) && Number.isInteger(row.status) && row.status >= 1 && row.status <= 5)) {
      page.query.records.set(record.key, record);
    }
    if (page.query.finished && page.query.pending.size === 0) {
      const records = [...page.query.records.values()];
      this.cachePageResults(page, records);
      this.renderPageResults(page, records);
    }
    return true;
  }

  cachePageResults(page, records) {
    if (!page || typeof page.signature !== "string") return;
    this.pageResultCache.delete(page.pageNumber);
    this.pageResultCache.set(page.pageNumber, {
      signature: page.signature,
      records: records.map(({ key, type, status }) => ({ key, type, status })),
    });
    while (this.pageResultCache.size > PAGE_RESULT_CACHE_LIMIT) {
      this.pageResultCache.delete(this.pageResultCache.keys().next().value);
    }
  }

  /**
   * Open the lightweight single-word pill from the bridge's existing click
   * ownership hook. This method deliberately installs no document/window
   * listeners; TextLayer nodes are only measured through short-lived Ranges.
   */
  handleTap(intent) {
    if (!this.enabled || !this.identityIsCurrent() || intent?.type !== "click" ||
        intent.targetRole !== "text-layer" || intent.nativeContextTarget ||
        intent.nativeActivationTarget || intent.button !== 0 || intent.detail !== 1 ||
        !Number.isFinite(intent.clientPoint?.x) || !Number.isFinite(intent.clientPoint?.y)) return false;
    const selection = this.window?.getSelection?.();
    if (!selection || selection.isCollapsed !== true || selection.rangeCount > 0 && !selection.getRangeAt(0)?.collapsed) return false;
    const pageNumber = Number(intent.pageIndex) + 1;
    if (!isPositivePageNumber(pageNumber) || !this.isPageVisible(pageNumber)) return false;
    const page = this.pages.get(pageKey(pageNumber));
    // InteractionIntent intentionally carries no raw target. Use only page
    // identity plus the already scanned physical TextNode segments.
    if (!page) return false;
    const tappedToken = tokenAtPoint(page, intent.clientPoint.x, intent.clientPoint.y, this.document);
    if (!tappedToken) return false;
    const entry = this.entryForTappedToken(page, tappedToken);
    if (!entry) return false;
    const requestId = `vocab-entry-${++this.querySequence}-${this.makeId()}`;
    if (!this.showEntryPill({ page, entry, requestId, x: intent.clientPoint.x, y: intent.clientPoint.y })) return false;
    const posted = this.postToHost("vocab-token-tap", {
      requestId,
      pageNumber,
      key: entry.surfaceKey,
      rawSurface: entry.rawSurface,
      entryType: entry.type,
      documentId: this.identity.documentId,
      openRequest: this.identity.openRequest,
    });
    if (!posted) this.dismissEntryPill();
    return posted;
  }

  entryForTappedToken(page, tappedToken) {
    const tokenIndex = page.tokens.indexOf(tappedToken);
    if (tokenIndex < 0) return null;
    const phraseRecords = page.records
      .filter((record) => record?.type === "phrase" && this.highlightLevels.phrases.has(record.status))
      .map((record) => ({ ...record, surfaceKeys: record.key.split(" ") }));
    const phrase = this.phraseMatcher(page.tokens, phraseRecords)
      .find((match) => tokenIndex >= match.startIndex && tokenIndex < match.endIndex);
    if (phrase) {
      const tokens = page.tokens.slice(phrase.startIndex, phrase.endIndex);
      return {
        type: "phrase",
        surfaceKey: phrase.record.key,
        rawSurface: tokens.map((token) => token.rawSurface).join(" "),
      };
    }
    const word = page.records.find((record) => record?.type === "word" &&
      record.key === tappedToken.surfaceKey && this.highlightLevels.words.has(record.status));
    // Only highlighted entries open the lookup card; ordinary PDF text keeps
    // its normal click/selection behavior.
    if (!word) return null;
    return { type: "word", surfaceKey: tappedToken.surfaceKey, rawSurface: tappedToken.rawSurface };
  }

  showEntryPill({ page, entry, requestId, x, y }) {
    this.dismissEntryPill();
    if (!this.document?.createElement || !this.document.body) return false;
    const popup = this.document.createElement("section");
    popup.className = "pdfReaderVocabularyPill";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", `LingQ 词条：${entry.rawSurface}`);
    popup.dataset.requestId = requestId;
    popup.dataset.key = entry.surfaceKey;
    popup.dataset.type = entry.type;
    popup.dataset.pageNumber = String(page.pageNumber);

    const heading = this.document.createElement("div");
    heading.className = "pdfReaderVocabularyPillHeading";
    heading.textContent = entry.rawSurface;
    const status = this.document.createElement("span");
    status.className = "pdfReaderVocabularyPillStatus";
    status.textContent = "未收录";
    const pronunciation = this.document.createElement("div");
    pronunciation.className = "pdfReaderVocabularyPillPronunciation";
    pronunciation.hidden = true;
    const meanings = this.document.createElement("div");
    meanings.className = "pdfReaderVocabularyPillMeanings";
    meanings.textContent = "正在查询…";
    const actions = this.document.createElement("div");
    actions.className = "pdfReaderVocabularyPillActions";
    const buttons = [];
    for (const status of [1, 2, 3, 4, 5]) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.dataset.status = String(status);
      button.textContent = status === 5 ? "✓" : String(status);
      button.title = vocabularyStatusLabel(status);
      button.setAttribute("aria-label", `设置 LingQ 状态：${vocabularyStatusLabel(status)}`);
      button.addEventListener("click", (event) => {
        event.stopPropagation?.();
        this.requestStatusChange(status);
      });
      actions.appendChild(button);
      buttons.push(button);
    }
    const close = this.document.createElement("button");
    close.type = "button";
    close.className = "pdfReaderVocabularyPillClose";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭词条卡片");
    close.addEventListener("click", (event) => {
      event.stopPropagation?.();
      this.dismissEntryPill();
    });
    popup.append(heading, status, pronunciation, meanings, actions, close);
    this.document.body.appendChild(popup);
    this.positionEntryPill(popup, x, y);
    this.entryPill = {
      popup, page, entry, requestId, heading, statusElement: status,
      pronunciation, meanings, buttons, record: null, status: null, pendingStatus: null,
    };
    return true;
  }

  positionEntryPill(popup, x, y) {
    const width = Math.max(0, Number(this.window?.innerWidth) || 0);
    const height = Math.max(0, Number(this.window?.innerHeight) || 0);
    popup.style.left = "8px";
    popup.style.top = "8px";
    const rect = popup.getBoundingClientRect?.();
    const popupWidth = Number(rect?.width) || Number(popup.offsetWidth) || 320;
    const popupHeight = Number(rect?.height) || Number(popup.offsetHeight) || 180;
    const left = Math.max(8, Math.min(x + 12, Math.max(8, width - popupWidth - 8)));
    const below = y + 14;
    const top = below + popupHeight <= height - 8
      ? below
      : Math.max(8, y - popupHeight - 14);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  handleEntryResult(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.documentId !== this.identity.documentId ||
        message?.openRequest !== this.identity.openRequest || message?.requestId !== pill.requestId ||
        message?.key !== pill.entry.surfaceKey || message?.pageNumber !== pill.page.pageNumber) return false;
    if (message.error) {
      pill.meanings.textContent = "词库暂时无法读取。";
      return true;
    }
    this.updatePillRecord(message.record || null);
    return true;
  }

  updatePillRecord(record) {
    const pill = this.entryPill;
    if (!pill) return false;
    pill.record = record && typeof record === "object" ? record : null;
    const presentation = vocabularyEntryPresentation(record);
    pill.status = presentation.status;
    for (const button of pill.buttons) {
      const status = Number(button.dataset.status);
      button.setAttribute("aria-pressed", String(pill.status === status));
      button.disabled = pill.pendingStatus !== null;
      button.classList.toggle("is-active", pill.status === status);
    }
    pill.statusElement.textContent = pill.pendingStatus === null
      ? presentation.statusLabel
      : "正在保存…";
    pill.pronunciation.textContent = presentation.pronunciation;
    pill.pronunciation.hidden = presentation.pronunciation.length === 0;
    pill.meanings.textContent = presentation.meanings.length ? presentation.meanings.join("；") : "暂无释义";
    return true;
  }

  requestStatusChange(status) {
    const pill = this.entryPill;
    if (!pill || !this.enabled || !this.identityIsCurrent() ||
        !Number.isInteger(status) || status < 1 || status > 5 || pill.pendingStatus !== null) return false;
    const requestId = `vocab-status-${++this.querySequence}-${this.makeId()}`;
    pill.pendingStatus = status;
    this.syncPillStatus(pill);
    const sent = this.postToHost("vocab-set-status", {
      requestId,
      key: pill.entry.surfaceKey,
      rawSurface: pill.entry.rawSurface,
      status,
      entryType: pill.entry.type,
      pageNumber: pill.page.pageNumber,
      entryRequestId: pill.requestId,
      documentId: this.identity.documentId,
      openRequest: this.identity.openRequest,
    });
    pill.statusRequestId = requestId;
    if (!sent) {
      pill.pendingStatus = null;
      this.syncPillStatus(pill);
    }
    return sent;
  }

  syncPillStatus(pill = this.entryPill) {
    if (!pill) return false;
    for (const button of pill.buttons) {
      const status = Number(button.dataset.status);
      button.setAttribute("aria-pressed", String(pill.status === status));
      button.disabled = pill.pendingStatus !== null;
      button.classList.toggle("is-active", pill.status === status);
    }
    pill.statusElement.textContent = pill.pendingStatus === null
      ? vocabularyEntryPresentation(pill.record).statusLabel
      : "正在保存…";
    return true;
  }

  handleStatusAck(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.durable !== true ||
        message?.documentId !== this.identity.documentId || message?.openRequest !== this.identity.openRequest ||
        message?.requestId !== pill.statusRequestId || message?.key !== pill.entry.surfaceKey ||
        message?.pageNumber !== pill.page.pageNumber || !Number.isInteger(message?.record?.status) ||
        message.record.status < 1 || message.record.status > 5) return false;
    pill.pendingStatus = null;
    this.updatePillRecord(message.record);
    const index = pill.page.records.findIndex((record) => record.key === message.record.key);
    if (index >= 0) pill.page.records[index] = message.record;
    else pill.page.records.push(message.record);
    this.cachePageResults(pill.page, pill.page.records);
    this.renderPageResults(pill.page, pill.page.records);
    return true;
  }

  handleStatusError(message) {
    const pill = this.entryPill;
    if (!pill || message?.documentId !== this.identity?.documentId ||
        message?.openRequest !== this.identity?.openRequest || message?.requestId !== pill.statusRequestId) return false;
    pill.pendingStatus = null;
    this.syncPillStatus(pill);
    pill.meanings.textContent = "状态保存未确认；词库数据未确认更改。";
    return true;
  }

  dismissEntryPill() {
    this.entryPill?.popup?.remove?.();
    this.entryPill = null;
  }

  renderPageResults(page, records) {
    page.records = records;
    const highlights = new Map();
    for (const record of page.records) {
      if (record.type !== "word" || !this.highlightLevels.words.has(record.status)) continue;
      for (const [index, token] of page.tokens.entries()) {
        if (token.surfaceKey === record.key && !highlights.has(index)) highlights.set(index, record.status);
      }
    }
    const phraseRecords = page.records
      .filter((record) => record.type === "phrase" && this.highlightLevels.phrases.has(record.status))
      .map((record) => ({ ...record, surfaceKeys: record.key.split(" ") }));
    const phraseMatches = this.phraseMatcher(page.tokens, phraseRecords);
    for (const match of phraseMatches) {
      for (let index = match.startIndex; index < match.endIndex; index += 1) {
        highlights.set(index, match.record.status);
      }
    }
    page.overlay.draw([...highlights]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([index, status]) => ({ token: page.tokens[index], status })));
    return true;
  }

  handleSelectionRequest(message) {
    if (!this.enabled || !this.identityIsCurrent() || !message ||
        message.documentId !== this.identity.documentId ||
        message.openRequest !== this.identity.openRequest ||
        typeof message.requestId !== "string" || message.requestId.length > 128) return false;
    const selection = this.window?.getSelection?.();
    if (!selection || selection.rangeCount !== 1) {
      return this.postToHost("vocab-selection-rejected", {
        requestId: message.requestId, code: "selection-count",
        documentId: this.identity.documentId, openRequest: this.identity.openRequest,
      });
    }
    let range;
    try { range = selection.getRangeAt(0); } catch { range = null; }
    const page = [...this.pages.values()].find((candidate) =>
      candidate.pageRoot.contains?.(range?.startContainer) && candidate.pageRoot.contains?.(range?.endContainer));
    if (!page || !range) {
      return this.postToHost("vocab-selection-rejected", {
        requestId: message.requestId, code: "cross-page",
        documentId: this.identity.documentId, openRequest: this.identity.openRequest,
      });
    }
    let tokens;
    try {
      tokens = this.selectTokens(range, page.tokens, {
        pageRoot: page.pageRoot, minTokens: 1, maxTokens: 12,
      });
    } catch (error) {
      return this.postToHost("vocab-selection-rejected", {
        requestId: message.requestId,
        code: typeof error?.code === "string" ? error.code : "invalid-selection",
        documentId: this.identity.documentId, openRequest: this.identity.openRequest,
      });
    }
    return this.postToHost("vocab-selection", {
      requestId: message.requestId,
      pageNumber: page.pageNumber,
      entryType: tokens.length === 1 ? "word" : "phrase",
      tokens: tokens.map(({ rawSurface, surfaceKey }) => ({ rawSurface, surfaceKey })),
      documentId: this.identity.documentId,
      openRequest: this.identity.openRequest,
    });
  }

  refreshPageFromHost(message) {
    if (!this.identityIsCurrent() || message?.documentId !== this.identity.documentId ||
        message?.openRequest !== this.identity.openRequest) return false;
    if (message.pageNumber == null) {
      this.pageResultCache.clear();
      const alreadyRendered = new Set(this.pages.values());
      this.scanRenderedPages();
      // New visible pages were queried by scanRenderedPages(). Replace only
      // pre-existing page queries so a host refresh does not double-submit.
      for (const page of this.pages.values()) {
        if (alreadyRendered.has(page)) this.queryPage(page, { force: true });
      }
      return true;
    }
    this.pageResultCache.delete(message.pageNumber);
    let page = this.pages.get(pageKey(message.pageNumber));
    if (!page && this.isPageVisible(message.pageNumber)) {
      this.refreshPage(message.pageNumber, { refreshTokens: true });
      page = this.pages.get(pageKey(message.pageNumber));
      return Boolean(page);
    }
    return page && this.isPageVisible(page.pageNumber) ? this.queryPage(page, { force: true }) : false;
  }

  clearPages() {
    this.dismissEntryPill();
    for (const page of this.pages.values()) page.overlay?.dispose?.();
    this.pages.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPages();
    this.pageResultCache.clear();
    this.identity = null;
    this.eventBus?._off?.("textlayerrendered", this.onTextLayerRendered);
    this.eventBus?._off?.("pagerendered", this.onPageRendered);
    this.eventBus?._off?.("updateviewarea", this.onViewAreaChanged);
  }
}

function tokenAtPoint(page, x, y, documentRef) {
  if (!page?.tokens?.length || !documentRef?.createRange) return null;
  const matches = [];
  for (const token of page.tokens) {
    for (const segment of token.segments || []) {
      let range;
      try {
        range = documentRef.createRange();
        range.setStart(segment.textNode, segment.startOffset);
        range.setEnd(segment.textNode, segment.endOffset);
        const rects = Array.from(range.getClientRects?.() || []);
        if (rects.some((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)) {
          matches.push(token);
          break;
        }
      } catch {
        // Detached physical TextNodes are ignored until the page rerenders.
      } finally {
        range?.detach?.();
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function sameTokenSegments(previous, next) {
  if (!Array.isArray(previous) || previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    const before = previous[index];
    const after = next[index];
      if (before?.surfaceKey !== after?.surfaceKey || before?.rawSurface !== after?.rawSurface ||
          before?.segments?.length !== after?.segments?.length) return false;
    for (let segmentIndex = 0; segmentIndex < before.segments.length; segmentIndex += 1) {
      const left = before.segments[segmentIndex];
      const right = after.segments[segmentIndex];
      if (left?.textNode !== right?.textNode || left?.startOffset !== right?.startOffset || left?.endOffset !== right?.endOffset) return false;
    }
  }
  return true;
}
