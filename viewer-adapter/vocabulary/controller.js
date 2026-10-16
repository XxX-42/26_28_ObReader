import { scanPageTextLayer } from "./page-scanner.js";
import { getSelectedPageTokens, matchPhrases } from "./phrase-matcher.js";
import { VocabularyCanvasOverlay } from "./canvas-overlay.js";

function isPositivePageNumber(value) {
  return Number.isInteger(value) && value > 0;
}

function pageKey(pageNumber) {
  return String(pageNumber);
}

const PAGE_QUERY_KEY_LIMIT = 32768;
const PAGE_QUERY_CHUNK_SIZE = 2048;
const PAGE_QUERY_TEXT_LIMIT = 131072;

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
    makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    scan = scanPageTextLayer,
    selectTokens = getSelectedPageTokens,
    phraseMatcher = matchPhrases,
    makeOverlay = (pageRoot) => new VocabularyCanvasOverlay(pageRoot, { documentRef }),
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
    this.identity = null;
    this.pages = new Map();
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
    if (changed) this.clearPages();
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
    const visiblePages = this.app.pdfViewer?.getVisiblePages?.()?.views;
    if (!Array.isArray(visiblePages)) return;
    const visible = new Set(visiblePages.map((page) => page?.id).filter(isPositivePageNumber));
    for (const pageNumber of visible) this.refreshPage(pageNumber);
    this.pruneOffscreenPages(visible);
  }

  pruneOffscreenPages(visiblePageNumbers) {
    const current = this.app.pdfViewer?.getVisiblePages?.()?.views;
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
    const visiblePages = this.app.pdfViewer?.getVisiblePages?.()?.views;
    if (!Array.isArray(visiblePages)) return false;
    return visiblePages.some((page) => page?.id === pageNumber);
  }

  refreshPage(pageNumber, { refreshTokens = false } = {}) {
    if (!this.enabled || !this.identityIsCurrent() || !isPositivePageNumber(pageNumber) || !this.isPageVisible(pageNumber)) return false;
    this.pruneOffscreenPages();
    const pageRoot = this.getPageRoot(pageNumber);
    const textLayer = pageRoot?.querySelector?.(".textLayer");
    if (!pageRoot || !textLayer) return false;
    const key = pageKey(pageNumber);
    let page = this.pages.get(key);
    const pageReplaced = !page || page.pageRoot !== pageRoot || page.textLayer !== textLayer;
    if (pageReplaced) page?.overlay?.dispose?.();
    if (pageReplaced || refreshTokens) {
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
        ? { pageNumber, pageRoot, textLayer, tokens, overlay, query: null, records: [] }
        : { ...page, tokens, query: null, records: [] };
      this.pages.set(key, page);
    }
    return this.queryPage(page);
  }

  queryPage(page) {
    if (!this.enabled || !this.identityIsCurrent() || !page?.tokens?.length) {
      page?.overlay?.clear?.();
      return false;
    }
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
    if (query.pending.size === 0) this.renderPageResults(page, []);
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
      this.renderPageResults(page, [...page.query.records.values()]);
    }
    return true;
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
    const token = tokenAtPoint(page, intent.clientPoint.x, intent.clientPoint.y, this.document);
    if (!token || token.surfaceKey.split(" ").length !== 1) return false;
    const requestId = `vocab-entry-${++this.querySequence}-${this.makeId()}`;
    if (!this.showEntryPill({ page, token, requestId, x: intent.clientPoint.x, y: intent.clientPoint.y })) return false;
    return this.postToHost("vocab-token-tap", {
      requestId,
      pageNumber,
      key: token.surfaceKey,
      rawSurface: token.rawSurface,
      documentId: this.identity.documentId,
      openRequest: this.identity.openRequest,
    });
  }

  showEntryPill({ page, token, requestId, x, y }) {
    this.dismissEntryPill();
    if (!this.document?.createElement || !this.document.body) return false;
    const popup = this.document.createElement("section");
    popup.className = "pdfReaderVocabularyPill";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", `Vocabulary entry: ${token.rawSurface}`);
    popup.dataset.requestId = requestId;
    popup.dataset.key = token.surfaceKey;
    popup.dataset.pageNumber = String(page.pageNumber);
    popup.style.left = `${Math.max(8, Math.min(x, (this.window?.innerWidth || x + 8) - 320))}px`;
    popup.style.top = `${Math.max(8, Math.min(y + 12, (this.window?.innerHeight || y + 12) - 180))}px`;

    const heading = this.document.createElement("div");
    heading.className = "pdfReaderVocabularyPillHeading";
    heading.textContent = token.rawSurface;
    const summary = this.document.createElement("div");
    summary.className = "pdfReaderVocabularyPillSummary";
    summary.textContent = "Loading local entry…";
    const actions = this.document.createElement("div");
    actions.className = "pdfReaderVocabularyPillActions";
    const buttons = [];
    for (const status of [1, 2, 3, 4, 5]) {
      const button = this.document.createElement("button");
      button.type = "button";
      button.dataset.status = String(status);
      button.textContent = status === 5 ? "✓ Known" : String(status);
      button.setAttribute("aria-label", status === 5 ? "Mark known" : `Set vocabulary status ${status}`);
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
    close.setAttribute("aria-label", "Close vocabulary entry");
    close.addEventListener("click", (event) => {
      event.stopPropagation?.();
      this.dismissEntryPill();
    });
    popup.append(heading, summary, actions, close);
    this.document.body.appendChild(popup);
    this.entryPill = { popup, page, token, requestId, heading, summary, buttons, status: null, pendingStatus: null };
    return true;
  }

  handleEntryResult(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.documentId !== this.identity.documentId ||
        message?.openRequest !== this.identity.openRequest || message?.requestId !== pill.requestId ||
        message?.key !== pill.token.surfaceKey || message?.pageNumber !== pill.page.pageNumber) return false;
    if (message.error) {
      pill.summary.textContent = "Local vocabulary data is unavailable.";
      return true;
    }
    this.updatePillRecord(message.record || null);
    return true;
  }

  updatePillRecord(record) {
    const pill = this.entryPill;
    if (!pill) return false;
    pill.status = Number.isInteger(record?.status) && record.status >= 1 && record.status <= 5 ? record.status : null;
    for (const button of pill.buttons) {
      const status = Number(button.dataset.status);
      button.setAttribute("aria-pressed", String(pill.status === status));
      button.disabled = pill.pendingStatus !== null;
      button.classList.toggle("is-active", pill.status === status);
    }
    const details = [record?.translation, record?.note].filter((value) => typeof value === "string" && value.trim());
    const statusText = pill.status === null ? "Not saved" : pill.status === 5 ? "Known" : `Status ${pill.status}`;
    pill.summary.textContent = [statusText, ...details].join(" · ");
    return true;
  }

  requestStatusChange(status) {
    const pill = this.entryPill;
    if (!pill || !this.enabled || !this.identityIsCurrent() ||
        !Number.isInteger(status) || status < 1 || status > 5 || pill.pendingStatus !== null) return false;
    const requestId = `vocab-status-${++this.querySequence}-${this.makeId()}`;
    pill.pendingStatus = status;
    this.updatePillRecord({ status: pill.status });
    const sent = this.postToHost("vocab-set-status", {
      requestId,
      key: pill.token.surfaceKey,
      rawSurface: pill.token.rawSurface,
      status,
      entryType: "word",
      pageNumber: pill.page.pageNumber,
      entryRequestId: pill.requestId,
      documentId: this.identity.documentId,
      openRequest: this.identity.openRequest,
    });
    pill.statusRequestId = requestId;
    if (!sent) {
      pill.pendingStatus = null;
      this.updatePillRecord({ status: pill.status });
    }
    return sent;
  }

  handleStatusAck(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.durable !== true ||
        message?.documentId !== this.identity.documentId || message?.openRequest !== this.identity.openRequest ||
        message?.requestId !== pill.statusRequestId || message?.key !== pill.token.surfaceKey ||
        message?.pageNumber !== pill.page.pageNumber || !Number.isInteger(message?.record?.status) ||
        message.record.status < 1 || message.record.status > 5) return false;
    pill.pendingStatus = null;
    this.updatePillRecord(message.record);
    const index = pill.page.records.findIndex((record) => record.key === message.record.key);
    if (index >= 0) pill.page.records[index] = message.record;
    else pill.page.records.push(message.record);
    this.renderPageResults(pill.page, pill.page.records);
    return true;
  }

  handleStatusError(message) {
    const pill = this.entryPill;
    if (!pill || message?.documentId !== this.identity?.documentId ||
        message?.openRequest !== this.identity?.openRequest || message?.requestId !== pill.statusRequestId) return false;
    pill.pendingStatus = null;
    this.updatePillRecord({ status: pill.status });
    pill.summary.textContent = "Could not save; local data was not acknowledged.";
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
      if (record.type !== "word" || record.status === 5) continue;
      for (const [index, token] of page.tokens.entries()) {
        if (token.surfaceKey === record.key && !highlights.has(index)) highlights.set(index, record.status);
      }
    }
    const phraseRecords = page.records
      .filter((record) => record.type === "phrase" && record.status !== 5)
      .map((record) => ({ ...record, surfaceKeys: record.key.split(" ") }));
    const phraseMatches = this.phraseMatcher(page.tokens, phraseRecords);
    for (const match of phraseMatches) {
      for (let index = match.startIndex; index < match.endIndex; index += 1) {
        highlights.set(index, match.record.status);
      }
    }
    page.overlay.draw([...highlights].map(([index, status]) => ({ token: page.tokens[index], status })));
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
      this.scanRenderedPages();
      return true;
    }
    const page = this.pages.get(pageKey(message.pageNumber));
    return page && this.isPageVisible(page.pageNumber) ? this.queryPage(page) : false;
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
