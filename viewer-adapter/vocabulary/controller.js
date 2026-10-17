import { scanPageTextLayer } from "./page-scanner.js";
import { getSelectedPageTokens, matchPhrases } from "./phrase-matcher.js";
import {
  isAmbiguousEnglishSurface,
  isLayVerbInflectionSurface,
  normalizeEnglishLemmaKey,
  normalizeTermKey,
} from "./english-normalizer.js";
import { VocabularyHighlightRenderer } from "./canvas-overlay.js";
import { vocabularyEntryPresentation, vocabularyStatusLabel } from "./presentation.js";

function isPositivePageNumber(value) {
  return Number.isInteger(value) && value > 0;
}

function performanceNow() {
  return globalThis.performance?.now?.() ?? Date.now();
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

export function normalizeVocabularyDisplayMode(value) {
  return ["all", "learning", "focus"].includes(value) ? value : "all";
}

function statusVisibleInMode(status, mode) {
  if (!Number.isInteger(status) || status < 1 || status > 5) return false;
  if (mode === "learning") return status <= 4;
  if (mode === "focus") return status <= 3;
  return true;
}

function getVisiblePageViews(pdfViewer) {
  const getVisiblePages = typeof pdfViewer?.getVisiblePages === "function"
    ? pdfViewer.getVisiblePages
    : pdfViewer?._getVisiblePages;
  const result = getVisiblePages?.call(pdfViewer);
  return Array.isArray(result?.views) ? result.views : null;
}

// Keep compact lexical results for only the recently visited pages. The live
// `pages` map is stricter: it retains PDF TextNodes/overlay geometry only for
// currently rendered pages, while this LRU stores integer token ranges only.
const PAGE_RESULT_CACHE_LIMIT = 9;

function pageTokenSignature(tokens) {
  return Array.isArray(tokens) ? tokens.map((token) => token?.surfaceKey || "").join("\u001f") : "";
}

function wordRecordsByLemma(records) {
  const grouped = new Map();
  for (const record of records) {
    if (record?.type !== "word" || typeof record.key !== "string") continue;
    const lemma = normalizeEnglishLemmaKey(record.key);
    if (!lemma) continue;
    const lemmaKeys = new Set([lemma]);
    const canonicalKey = typeof record.storageKey === "string" && record.storageKey
      ? record.storageKey
      : record.key;
    if (normalizeTermKey(canonicalKey) === "lay") lemmaKeys.add("lay");
    for (const lemmaKey of lemmaKeys) {
      const candidates = grouped.get(lemmaKey) || [];
      candidates.push(record);
      grouped.set(lemmaKey, candidates);
    }
  }
  return grouped;
}

function bestWordRecord(token, recordsByLemma) {
  const lemma = normalizeEnglishLemmaKey(token?.surfaceKey);
  if (!lemma) return null;
  const candidates = (recordsByLemma.get(lemma) || []).filter((record) => {
    const canonicalKey = typeof record.storageKey === "string" && record.storageKey
      ? record.storageKey
      : record.key;
    const canonical = normalizeTermKey(canonicalKey);
    return !isAmbiguousEnglishSurface(canonical) || canonical === token.surfaceKey ||
      (canonical === "lay" && isLayVerbInflectionSurface(token.surfaceKey));
  });
  const exact = candidates.find((record) => record.key === token.surfaceKey);
  if (exact) return exact;

  // If two unrelated persisted keys happen to share a lemma, leave the word
  // unhighlighted until the host can resolve the surface unambiguously.
  const canonicalKeys = new Set(candidates.map((record) =>
    typeof record.storageKey === "string" && record.storageKey ? record.storageKey : record.key));
  return canonicalKeys.size === 1 ? candidates[0] : null;
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
    displayMode = "all",
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
    this.displayMode = normalizeVocabularyDisplayMode(displayMode);
    this.identity = null;
    this.pages = new Map();
    this.pageResultCache = new Map();
    this.disposed = false;
    this.querySequence = 0;
    this.geometryRedrawHandle = null;
    this.geometryRedrawCancel = null;
    this.pendingGeometryPageNumbers = new Set();
    this.pendingAllGeometryPages = false;
    this.pageByResizeTarget = new WeakMap();
    const ResizeObserverImpl = windowRef?.ResizeObserver || globalThis.ResizeObserver;
    this.pageResizeObserver = typeof ResizeObserverImpl === "function"
      ? new ResizeObserverImpl((entries) => this.handlePageLayoutResize(entries))
      : null;
    this.onTextLayerRendered = ({ pageNumber } = {}) => {
      const page = this.pages.get(pageKey(pageNumber));
      const pageRoot = this.getPageRoot(pageNumber);
      const textLayer = pageRoot?.querySelector?.(".textLayer");
      const physicalTokensStillBound = page && page.pageRoot === pageRoot && page.textLayer === textLayer &&
        page.tokens.every((token) => token.segments?.every((segment) => {
          const node = segment?.textNode;
          return node && node.isConnected !== false &&
            (typeof textLayer?.contains !== "function" || textLayer.contains(node));
        }));
      if (physicalTokensStillBound) {
        // PDF.js changes range geometry when scaling/reflowing, but the lexical
        // token sequence is unchanged. Keep its cache and only remeasure the
        // existing ranges in the next frame.
        this.scheduleGeometryRedraw(pageNumber);
        return;
      }
      // Re-scan only when PDF.js actually replaced the text nodes. The page
      // signature still reuses its lexical result cache, so no vocabulary
      // request or phrase match is repeated.
      this.refreshPage(pageNumber, { refreshTokens: true });
      this.scheduleGeometryRedraw(pageNumber);
    };
    this.onPageRendered = ({ pageNumber } = {}) => {
      // PDF.js may render the text layer just after its page canvas event.
      Promise.resolve().then(() => {
        const page = this.pages.get(pageKey(pageNumber));
        if (!page) this.refreshPage(pageNumber);
        else if (this.isPageVisible(pageNumber) && page.query?.pending.size === 0) this.renderPageResults(page, page.records);
      });
    };
    this.onViewAreaChanged = () => this.scanRenderedPages();
    this.onScaleChanging = () => this.scheduleGeometryRedraw();
    this.onWindowResize = () => this.scheduleGeometryRedraw();
    this.eventBus?._on?.("textlayerrendered", this.onTextLayerRendered);
    this.eventBus?._on?.("pagerendered", this.onPageRendered);
    this.eventBus?._on?.("updateviewarea", this.onViewAreaChanged);
    this.eventBus?._on?.("scalechanging", this.onScaleChanging);
    this.window?.addEventListener?.("resize", this.onWindowResize, { passive: true });
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

  setDisplayMode(mode) {
    if (this.disposed) return false;
    const next = normalizeVocabularyDisplayMode(mode);
    if (next === this.displayMode) return true;
    this.displayMode = next;
    // The page token scan and dictionary query are unchanged; only redraw the
    // small set of already-cached visible-page records for this mode.
    if (this.enabled) {
      for (const page of this.pages.values()) this.renderPageResults(page, page.records);
    }
    return true;
  }

  isStatusVisible(type, status) {
    const levels = type === "phrase" ? this.highlightLevels.phrases : this.highlightLevels.words;
    return levels.has(status) && statusVisibleInMode(status, this.displayMode);
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
      this.unobservePageLayout(page);
      page.overlay?.dispose?.();
      this.pages.delete(key);
    }
  }

  isPageVisible(pageNumber) {
    const visiblePages = getVisiblePageViews(this.app.pdfViewer);
    if (!Array.isArray(visiblePages)) return false;
    return visiblePages.some((page) => page?.id === pageNumber);
  }

  observePageLayout(page) {
    if (!this.pageResizeObserver || !page) return;
    const targets = [...new Set([page.pageRoot, page.textLayer])].filter((target) =>
      target && (typeof target === "object" || typeof target === "function"));
    page.observedLayoutTargets = targets;
    for (const target of targets) {
      this.pageByResizeTarget.set(target, page.pageNumber);
      try { this.pageResizeObserver.observe(target); } catch {}
    }
  }

  unobservePageLayout(page) {
    for (const target of page?.observedLayoutTargets || []) {
      this.pageByResizeTarget.delete(target);
      try { this.pageResizeObserver?.unobserve?.(target); } catch {}
    }
    if (page) page.observedLayoutTargets = [];
  }

  handlePageLayoutResize(entries) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const pageNumber = this.pageByResizeTarget.get(entry?.target);
      const page = this.pages.get(pageKey(pageNumber));
      if (!page || !this.isPageVisible(pageNumber)) continue;
      this.scheduleGeometryRedraw(pageNumber);
    }
  }

  scheduleGeometryRedraw(pageNumber = null) {
    if (this.disposed) return false;
    if (isPositivePageNumber(pageNumber)) this.pendingGeometryPageNumbers.add(pageNumber);
    else this.pendingAllGeometryPages = true;
    if (this.geometryRedrawHandle !== null) return true;
    const redraw = () => {
      this.geometryRedrawHandle = null;
      this.geometryRedrawCancel = null;
      const pageNumbers = this.pendingAllGeometryPages
        ? [...this.pages.values()].map((page) => page.pageNumber)
        : [...this.pendingGeometryPageNumbers];
      this.pendingAllGeometryPages = false;
      this.pendingGeometryPageNumbers.clear();
      for (const number of pageNumbers) {
        const page = this.pages.get(pageKey(number));
        if (!page || !this.isPageVisible(number) || page.query?.pending?.size > 0) continue;
        this.renderPageResults(page, page.records);
      }
    };
    if (typeof this.window?.requestAnimationFrame === "function") {
      this.geometryRedrawCancel = (handle) => this.window?.cancelAnimationFrame?.(handle);
      this.geometryRedrawHandle = this.window.requestAnimationFrame(redraw);
    } else {
      this.geometryRedrawCancel = (handle) => clearTimeout(handle);
      this.geometryRedrawHandle = setTimeout(redraw, 0);
    }
    return true;
  }

  cancelGeometryRedraw() {
    if (this.geometryRedrawHandle !== null) {
      try { this.geometryRedrawCancel?.(this.geometryRedrawHandle); } catch {}
    }
    this.geometryRedrawHandle = null;
    this.geometryRedrawCancel = null;
    this.pendingGeometryPageNumbers.clear();
    this.pendingAllGeometryPages = false;
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
    if (pageReplaced && page) {
      this.unobservePageLayout(page);
      page.overlay?.dispose?.();
    }
    let tokens;
    const scanStartedAt = performanceNow();
    try { tokens = this.scan(textLayer); } catch {
      this.unobservePageLayout(page);
      page?.overlay?.dispose?.();
      this.pages.delete(key);
      return false;
    }
    const scanMetrics = {
      tokenCount: Array.isArray(tokens) ? tokens.length : 0,
      scanMs: Math.max(0, performanceNow() - scanStartedAt),
    };
    if (!Array.isArray(tokens)) {
      this.unobservePageLayout(page);
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
      ? { pageNumber, pageRoot, textLayer, tokens, signature: pageTokenSignature(tokens), overlay, query: null, records: [], scanMetrics }
      : { ...page, tokens, signature: pageTokenSignature(tokens), query: null, records: [], scanMetrics };
    this.pages.set(key, page);
    if (pageReplaced) this.observePageLayout(page);
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
        page.wordMatches = cached.wordMatches || [];
        page.phraseMatches = cached.phraseMatches || [];
        page.queryMetrics = {
          ...(cached.metrics || {}),
          lexicalCacheHit: true,
          textLayerScanMs: page.scanMetrics?.scanMs ?? null,
          hostRoundTripMs: 0,
        };
        page.query = { id: null, pending: new Map(), records: new Map(), finished: true };
        this.renderPageResults(page, page.records);
        return false;
      }
    }
    if (force) this.pageResultCache.delete(page.pageNumber);
    const queryId = `vocab-page-${++this.querySequence}-${this.makeId()}`;
    const query = {
      id: queryId, pending: new Map(), records: new Map(), finished: false,
      startedAt: performanceNow(),
    };
    page.query = query;
    page.overlay?.clear?.();
    const requestId = `${queryId}-tokens`;
    query.pending.set(requestId, 0);
    const posted = this.postToHost("vocab-page-query", {
      requestId, queryId, partIndex: 0,
      pageNumber: page.pageNumber,
      documentId: this.identity.documentId,
      openRequest: this.identity.openRequest,
      tokens: page.tokens.map((token) => token?.surfaceKey || ""),
    });
    if (!posted) query.pending.delete(requestId);
    query.finished = true;
    if (query.pending.size === 0) {
      page.records = [];
      page.wordMatches = [];
      page.phraseMatches = [];
      page.queryMetrics = null;
      this.cachePageResults(page);
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
    if (!page || page.query.id !== message.queryId || currentPart !== message.partIndex) return false;
    page.query.pending.delete(message.requestId);
    const validMatch = (row, type) => row && typeof row.key === "string" &&
      typeof row.storageKey === "string" && row.storageKey.length > 0 && row.type === type &&
      Number.isInteger(row.status) && row.status >= 1 && row.status <= 5;
    if (Array.isArray(message.wordMatches) && Array.isArray(message.phraseMatches)) {
      page.wordMatches = message.wordMatches.filter((row) => Number.isInteger(row?.index) &&
        row.index >= 0 && row.index < page.tokens.length && validMatch(row, "word"));
      page.phraseMatches = message.phraseMatches.filter((row) => Number.isInteger(row?.startIndex) &&
        Number.isInteger(row?.endIndex) && row.startIndex >= 0 && row.endIndex > row.startIndex &&
        row.endIndex <= page.tokens.length && row.endIndex - row.startIndex >= 2 &&
        row.endIndex - row.startIndex <= 12 && validMatch(row, "phrase"));
      page.queryMetrics = {
        ...(message.metrics && typeof message.metrics === "object" ? message.metrics : {}),
        lexicalCacheHit: false,
      };
      const unique = new Map();
      for (const match of [...page.wordMatches, ...page.phraseMatches]) {
        const key = `${match.type}\u001f${match.key}\u001f${match.storageKey}`;
        unique.set(key, { key: match.key, storageKey: match.storageKey, type: match.type, status: match.status });
      }
      page.records = [...unique.values()];
    } else if (Array.isArray(message.records)) {
      // Read responses from older host builds during a rolling update. New
      // readers send only tokens and never materialize the old n-gram set.
      for (const record of message.records.filter((row) => row && typeof row.key === "string" &&
        ["word", "phrase"].includes(row.type) && Number.isInteger(row.status) && row.status >= 1 && row.status <= 5)) {
        page.query.records.set(record.key, record);
      }
      page.records = [...page.query.records.values()];
      this.rebuildLexicalMatchesFromRecords(page);
    } else return false;
    const queryMetrics = page.queryMetrics && typeof page.queryMetrics === "object"
      ? page.queryMetrics
      : {};
    page.queryMetrics = {
      ...queryMetrics,
      viewerTokenCount: page.tokens.length,
      textLayerScanMs: page.scanMetrics?.scanMs ?? null,
      hostRoundTripMs: Math.max(0, performanceNow() - page.query.startedAt),
    };
    if (page.query.finished && page.query.pending.size === 0) {
      this.cachePageResults(page);
      this.renderPageResults(page, page.records);
    }
    return true;
  }

  cachePageResults(page) {
    if (!page || typeof page.signature !== "string") return;
    this.pageResultCache.delete(page.pageNumber);
    this.pageResultCache.set(page.pageNumber, {
      signature: page.signature,
      records: (page.records || []).map(({ key, storageKey, type, status }) => ({ key, storageKey, type, status })),
      wordMatches: (page.wordMatches || []).map((match) => ({ ...match })),
      phraseMatches: (page.phraseMatches || []).map((match) => ({ ...match })),
      metrics: page.queryMetrics ? { ...page.queryMetrics } : null,
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
    const phrase = Array.isArray(page.phraseMatches)
      ? page.phraseMatches.filter((match) => this.isStatusVisible("phrase", match.status))
        .find((match) => tokenIndex >= match.startIndex && tokenIndex < match.endIndex)
      : this.phraseMatcher(page.tokens, page.records
        .filter((record) => record?.type === "phrase" && this.isStatusVisible("phrase", record.status))
        .map((record) => ({ ...record, surfaceKeys: record.key.split(" ") })))
        .find((match) => tokenIndex >= match.startIndex && tokenIndex < match.endIndex);
    if (phrase) {
      const tokens = page.tokens.slice(phrase.startIndex, phrase.endIndex);
      return {
        type: "phrase",
        startIndex: phrase.startIndex,
        endIndex: phrase.endIndex,
        // Keep the tapped phrase surface as the request identity; storageKey
        // returned by the host identifies the durable vocabulary family.
        surfaceKey: tokens.map((token) => token.surfaceKey).join(" "),
        rawSurface: tokens.map((token) => token.rawSurface).join(" "),
      };
    }
    // A click in LingQ mode is also the lookup gesture for words that have
    // not been added yet. Drag selection remains native because handleTap()
    // only runs when the Selection is collapsed; the tap can then add a new
    // status record through the same existing pill controls.
    return { type: "word", startIndex: tokenIndex, endIndex: tokenIndex + 1,
      surfaceKey: tappedToken.surfaceKey, rawSurface: tappedToken.rawSurface };
  }

  rangeForOccurrence(pageNumber, startIndex, endIndex) {
    if (!isPositivePageNumber(pageNumber) || !Number.isSafeInteger(startIndex) ||
        !Number.isSafeInteger(endIndex) || startIndex < 0 || endIndex <= startIndex || endIndex - startIndex > 12) return null;
    const page = this.pages.get(pageKey(pageNumber));
    const first = page?.tokens?.[startIndex]?.segments?.[0];
    const lastSegments = page?.tokens?.[endIndex - 1]?.segments;
    const last = lastSegments?.[lastSegments.length - 1];
    const textLayer = page?.pageRoot?.querySelector?.(".textLayer");
    if (!textLayer || !first?.textNode || !last?.textNode ||
        !page.pageRoot.contains?.(first.textNode) || !page.pageRoot.contains?.(last.textNode)) return null;
    const document = this.document || first.textNode.ownerDocument;
    if (typeof document?.createRange !== "function") return null;
    try {
      const range = document.createRange();
      range.setStart(first.textNode, first.startOffset);
      range.setEnd(last.textNode, last.endOffset);
      return range;
    } catch { return null; }
  }

  textPositionForOccurrence(page, startIndex, endIndex) {
    const range = this.rangeForOccurrence(page?.pageNumber, startIndex, endIndex);
    const textLayer = page?.textLayer;
    const document = this.document;
    if (!range || !textLayer || typeof document?.createTreeWalker !== "function") return null;
    try {
      const walker = document.createTreeWalker(textLayer, 4);
      let offset = 0;
      let start = null;
      let end = null;
      let node;
      while ((node = walker.nextNode())) {
        const length = String(node.nodeValue || "").length;
        if (node === range.startContainer) start = offset + range.startOffset;
        if (node === range.endContainer) end = offset + range.endOffset;
        offset += length;
        if (start !== null && end !== null) break;
      }
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start
        ? { start, end }
        : null;
    } catch { return null; }
    finally { range.detach?.(); }
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
    const occurrenceActions = this.document.createElement("div");
    occurrenceActions.className = "pdfReaderVocabularyPillOccurrenceActions";
    const copyOccurrence = this.document.createElement("button");
    copyOccurrence.type = "button";
    copyOccurrence.className = "pdfReaderVocabularyPillOccurrenceLink";
    copyOccurrence.textContent = "复制此处链接";
    copyOccurrence.addEventListener("click", (event) => {
      event.stopPropagation?.();
      if (copyOccurrence.disabled) return;
      const occurrenceRequestId = `reader-occurrence-${++this.querySequence}-${this.makeId()}`;
      const posted = this.postToHost("reader-anchor-occurrence-link-request", {
        requestId: occurrenceRequestId,
        pageNumber: page.pageNumber,
        startIndex: entry.startIndex,
        endIndex: entry.endIndex,
        documentId: this.identity.documentId,
        openRequest: this.identity.openRequest,
      });
      if (posted) {
        copyOccurrence.disabled = true;
        this.entryPill.occurrenceRequestId = occurrenceRequestId;
        copyOccurrence.textContent = "正在创建…";
      }
    });
    occurrenceActions.appendChild(copyOccurrence);
    const backlinks = this.document.createElement("div");
    backlinks.className = "pdfReaderVocabularyPillBacklinks";
    backlinks.textContent = "反向链接：查询中…";
    const openBacklinks = this.document.createElement("button");
    openBacklinks.type = "button";
    openBacklinks.className = "pdfReaderVocabularyPillBacklinksButton";
    openBacklinks.textContent = "查看";
    openBacklinks.hidden = true;
    openBacklinks.disabled = true;
    openBacklinks.addEventListener("click", (event) => {
      event.stopPropagation?.();
      const pill = this.entryPill;
      if (!pill || !pill.anchorIds?.length || !this.identityIsCurrent()) return;
      this.postToHost("reader-backlink-occurrence-open", {
        requestId: `reader-backlink-open-${++this.querySequence}-${this.makeId()}`,
        anchorIds: pill.anchorIds.slice(0, 32),
        documentId: this.identity.documentId,
        openRequest: this.identity.openRequest,
      });
    });
    const backlinkActions = this.document.createElement("div");
    backlinkActions.className = "pdfReaderVocabularyPillBacklinkActions";
    backlinkActions.append(backlinks, openBacklinks);
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
    popup.append(heading, status, pronunciation, meanings, occurrenceActions, backlinkActions, actions, close);
    this.document.body.appendChild(popup);
    this.positionEntryPill(popup, x, y);
    this.entryPill = {
      popup, page, entry, requestId, heading, statusElement: status,
      pronunciation, meanings, buttons, record: null, status: null, pendingStatus: null,
      occurrenceRequestId: null, occurrenceButton: copyOccurrence,
      backlinks, openBacklinks, backlinkRequestId: null, anchorIds: [],
    };
    const textPosition = this.textPositionForOccurrence(page, entry.startIndex, entry.endIndex);
    if (textPosition) {
      const backlinkRequestId = `reader-backlink-query-${++this.querySequence}-${this.makeId()}`;
      const sent = this.postToHost("reader-backlink-occurrence-query", {
        requestId: backlinkRequestId,
        pageNumber: page.pageNumber,
        startIndex: textPosition.start,
        endIndex: textPosition.end,
        documentId: this.identity?.documentId,
        openRequest: this.identity?.openRequest,
      });
      if (sent) this.entryPill.backlinkRequestId = backlinkRequestId;
      else backlinks.textContent = "反向链接：暂不可用";
    } else {
      backlinks.textContent = "反向链接：位置未确认";
    }
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
    if (message.record && (message.record.key !== pill.entry.surfaceKey ||
        message.record.storageKey != null && (typeof message.record.storageKey !== "string" || !message.record.storageKey))) return false;
    if (message.error) {
      pill.meanings.textContent = "词库暂时无法读取。";
      return true;
    }
    this.updatePillRecord(message.record || null);
    return true;
  }

  handleOccurrenceLinkResult(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.documentId !== this.identity.documentId ||
        message?.openRequest !== this.identity.openRequest ||
        message?.requestId !== pill.occurrenceRequestId) return false;
    pill.occurrenceRequestId = null;
    pill.occurrenceButton.disabled = message.ok === true;
    pill.occurrenceButton.textContent = message.ok === true ? "已复制链接" : "复制此处链接";
    if (message.ok !== true) pill.occurrenceButton.title = message.message || "创建链接失败";
    return true;
  }

  handleOccurrenceBacklinks(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.documentId !== this.identity.documentId ||
        message?.openRequest !== this.identity.openRequest || message?.requestId !== pill.backlinkRequestId) return false;
    pill.backlinkRequestId = null;
    if (message.ok !== true || !Number.isSafeInteger(message.count) || message.count < 0) {
      pill.backlinks.textContent = "反向链接：无法确认";
      return true;
    }
    pill.anchorIds = Array.isArray(message.anchorIds)
      ? [...new Set(message.anchorIds.filter((value) => typeof value === "string" && value.length <= 128))].slice(0, 32)
      : [];
    pill.backlinks.textContent = `反向链接：${message.count}`;
    pill.openBacklinks.hidden = message.count === 0 || pill.anchorIds.length === 0;
    pill.openBacklinks.disabled = pill.openBacklinks.hidden;
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
    // Keep dictionary senses on separate readable lines. The presentation
    // layer already splits real and escaped source line breaks into entries.
    pill.meanings.textContent = presentation.meanings.length ? presentation.meanings.join("\n") : "未录入释义";
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
      ...(typeof pill.record?.storageKey === "string" && pill.record.storageKey
        ? { storageKey: pill.record.storageKey }
        : {}),
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
        message?.record?.key !== pill.entry.surfaceKey ||
        message?.pageNumber !== pill.page.pageNumber || !Number.isInteger(message?.record?.status) ||
        message.record.status < 1 || message.record.status > 5) return false;
    const priorStorageKey = pill.record?.storageKey;
    if (typeof priorStorageKey === "string" && priorStorageKey &&
        message.record.storageKey !== priorStorageKey) return false;
    pill.pendingStatus = null;
    this.updatePillRecord(message.record);
    const acknowledged = message.record;
    const canonicalKey = typeof acknowledged.storageKey === "string" && acknowledged.storageKey
      ? acknowledged.storageKey
      : acknowledged.key;
    let updated = false;
    pill.page.records = pill.page.records.map((record) => {
      if (record.type !== acknowledged.type) return record;
      const recordCanonicalKey = typeof record.storageKey === "string" && record.storageKey
        ? record.storageKey
        : record.key;
      if (record.key !== acknowledged.key && recordCanonicalKey !== canonicalKey) return record;
      updated = true;
      // Keep each requested surface alias but update its shared persisted row.
      return { ...record, status: acknowledged.status, storageKey: recordCanonicalKey };
    });
    if (!updated) pill.page.records.push(acknowledged);
    this.rebuildLexicalMatchesFromRecords(pill.page);
    this.cachePageResults(pill.page);
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

  rebuildLexicalMatchesFromRecords(page) {
    if (!page) return false;
    const wordsByLemma = wordRecordsByLemma(page.records || []);
    page.wordMatches = [];
    for (const [index, token] of page.tokens.entries()) {
      const record = bestWordRecord(token, wordsByLemma);
      if (!record) continue;
      page.wordMatches.push({
        index, key: token.surfaceKey,
        storageKey: record.storageKey || record.key,
        type: "word", status: record.status,
      });
    }
    const phraseRecords = (page.records || [])
      .filter((record) => record.type === "phrase")
      .map((record) => ({ ...record, surfaceKeys: record.key.split(" ") }));
    page.phraseMatches = this.phraseMatcher(page.tokens, phraseRecords).map((match) => ({
      startIndex: match.startIndex, endIndex: match.endIndex,
      key: match.record.key, storageKey: match.record.storageKey || match.record.key,
      type: "phrase", status: match.record.status,
    }));
    return true;
  }

  renderPageResults(page, records = page.records || []) {
    const renderStartedAt = performanceNow();
    page.records = records;
    const highlights = new Map();
    if (Array.isArray(page.wordMatches) && Array.isArray(page.phraseMatches)) {
      for (const match of page.wordMatches) {
        if (this.isStatusVisible("word", match.status)) highlights.set(match.index, match.status);
      }
      for (const match of page.phraseMatches) {
        if (!this.isStatusVisible("phrase", match.status)) continue;
        for (let index = match.startIndex; index < match.endIndex; index += 1) {
          highlights.set(index, match.status);
        }
      }
    } else {
      const wordsByLemma = wordRecordsByLemma(page.records);
      for (const [index, token] of page.tokens.entries()) {
        const record = bestWordRecord(token, wordsByLemma);
        if (record && this.isStatusVisible("word", record.status)) highlights.set(index, record.status);
      }
      const phraseRecords = page.records
        .filter((record) => record.type === "phrase" && this.isStatusVisible("phrase", record.status))
        .map((record) => ({ ...record, surfaceKeys: record.key.split(" ") }));
      const phraseMatches = this.phraseMatcher(page.tokens, phraseRecords);
      for (const match of phraseMatches) {
        for (let index = match.startIndex; index < match.endIndex; index += 1) {
          highlights.set(index, match.record.status);
        }
      }
    }
    const drawStartedAt = performanceNow();
    page.overlay.draw([...highlights]
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([index, status]) => ({ token: page.tokens[index], status })));
    page.renderMetrics = {
      highlightedTokenCount: highlights.size,
      overlayGeometryAndPaintMs: Math.max(0, performanceNow() - drawStartedAt),
      totalMs: Math.max(0, performanceNow() - renderStartedAt),
    };
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
    this.cancelGeometryRedraw();
    this.dismissEntryPill();
    for (const page of this.pages.values()) {
      this.unobservePageLayout(page);
      page.overlay?.dispose?.();
    }
    this.pages.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearPages();
    this.pageResultCache.clear();
    this.identity = null;
    this.pageResizeObserver?.disconnect?.();
    this.eventBus?._off?.("textlayerrendered", this.onTextLayerRendered);
    this.eventBus?._off?.("pagerendered", this.onPageRendered);
    this.eventBus?._off?.("updateviewarea", this.onViewAreaChanged);
    this.eventBus?._off?.("scalechanging", this.onScaleChanging);
    this.window?.removeEventListener?.("resize", this.onWindowResize);
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
