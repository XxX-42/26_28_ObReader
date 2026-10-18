import { analyzeEnglishWord, normalizeWordDisplayMode } from "./word-morphology.js";
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

function vocabularyPillStatusLabel(record) {
  const presentation = vocabularyEntryPresentation(record);
  // Keep the underlying distinction between missing personal state and
  // dictionary data; the compact card uses a friendlier label for an
  // unrecorded word.
  return presentation.status === null && !presentation.hasPersonalRecord
    ? "陌生词"
    : presentation.statusLabel;
}

// CSS-pixel placement shared by desktop and touch viewports. Only the open
// card is measured; this never queries vocabulary or scans a PDF text layer.
export function computeVocabularyPillPlacement({ viewport, anchor, width, height, minHeight = 150 }) {
  const margin = 10;
  const gap = 12;
  const leftEdge = Number.isFinite(viewport?.left) ? viewport.left : 0;
  const topEdge = Number.isFinite(viewport?.top) ? viewport.top : 0;
  const viewportWidth = Math.max(1, Number(viewport?.width) || 1);
  const viewportHeight = Math.max(1, Number(viewport?.height) || 1);
  const insetX = Math.min(margin, viewportWidth / 4);
  const insetY = Math.min(margin, viewportHeight / 4);
  const maxWidth = Math.max(1, viewportWidth - insetX * 2);
  const fullHeight = Math.max(1, viewportHeight - insetY * 2);
  const cardWidth = Math.min(Math.max(1, Number(width) || 320), maxWidth);
  const cardHeight = Math.min(Math.max(1, Number(height) || 180), fullHeight);
  const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
  const centerX = clamp((Number(anchor?.left) + Number(anchor?.right)) / 2 || leftEdge,
    leftEdge + insetX, leftEdge + viewportWidth - insetX);
  const anchorTop = clamp(Number(anchor?.top) || topEdge, topEdge + insetY, topEdge + viewportHeight - insetY);
  const anchorBottom = clamp(Number(anchor?.bottom) || anchorTop, anchorTop, topEdge + viewportHeight - insetY);
  const above = Math.max(0, anchorTop - topEdge - insetY - gap);
  const below = Math.max(0, topEdge + viewportHeight - insetY - anchorBottom - gap);
  const minimumSideHeight = Math.max(1, Number(minHeight) || 150);
  // Above keeps the grade row beside the word. Below moves that same row to
  // the top of the card, so the primary buttons stay close to the tap too.
  const placement = above >= cardHeight || (above >= minimumSideHeight && above >= below)
    ? "above" : below >= minimumSideHeight || below > above ? "below" : "above";
  const sideHeight = placement === "above" ? above : below;
  // A very short viewport cannot hold the whole card on either side. Use its
  // full safe area; only the body scrolls, while header and grades stay fixed.
  const maxHeight = sideHeight >= minimumSideHeight ? Math.min(fullHeight, sideHeight) : fullHeight;
  const renderedHeight = Math.min(cardHeight, maxHeight);
  return {
    placement,
    maxWidth,
    maxHeight,
    left: clamp(centerX - cardWidth / 2, leftEdge + insetX, leftEdge + viewportWidth - insetX - cardWidth),
    top: clamp(placement === "above" ? anchorTop - gap - renderedHeight : anchorBottom + gap,
      topEdge + insetY, topEdge + viewportHeight - insetY - renderedHeight),
  };
}

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
    wordDisplayMode = "whole",
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
    this.wordDisplayMode = normalizeWordDisplayMode(wordDisplayMode);
    this.identity = null;
    this.pages = new Map();
    this.pageResultCache = new Map();
    this.disposed = false;
    this.querySequence = 0;
    this.geometryRedrawHandle = null;
    this.geometryRedrawCancel = null;
    this.entryPillLayoutHandle = null;
    this.entryPillLayoutCancel = null;
    this.visualViewport = windowRef?.visualViewport || null;
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
        this.scheduleEntryPillLayout();
        return;
      }
      // Re-scan only when PDF.js actually replaced the text nodes. The page
      // signature still reuses its lexical result cache, so no vocabulary
      // request or phrase match is repeated.
      this.refreshPage(pageNumber, { refreshTokens: true });
      this.scheduleGeometryRedraw(pageNumber);
      this.scheduleEntryPillLayout();
    };
    this.onPageRendered = ({ pageNumber } = {}) => {
      // PDF.js may render the text layer just after its page canvas event.
      Promise.resolve().then(() => {
        const page = this.pages.get(pageKey(pageNumber));
        if (!page) this.refreshPage(pageNumber);
        else if (this.isPageVisible(pageNumber) && page.query?.pending.size === 0) this.renderPageResults(page, page.records);
      });
    };
    this.onViewAreaChanged = () => {
      this.scanRenderedPages();
      this.scheduleEntryPillLayout();
    };
    this.onScaleChanging = () => {
      this.scheduleGeometryRedraw();
      this.scheduleEntryPillLayout();
    };
    this.onWindowResize = () => {
      this.scheduleGeometryRedraw();
      this.scheduleEntryPillLayout();
    };
    this.onVisualViewportChanged = () => this.scheduleEntryPillLayout();
    this.eventBus?._on?.("textlayerrendered", this.onTextLayerRendered);
    this.eventBus?._on?.("pagerendered", this.onPageRendered);
    this.eventBus?._on?.("updateviewarea", this.onViewAreaChanged);
    this.eventBus?._on?.("scalechanging", this.onScaleChanging);
    this.window?.addEventListener?.("resize", this.onWindowResize, { passive: true });
    this.visualViewport?.addEventListener?.("resize", this.onVisualViewportChanged, { passive: true });
    this.visualViewport?.addEventListener?.("scroll", this.onVisualViewportChanged, { passive: true });
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
      logicalSurface: entry.logicalSurface,
      ...(entry.lineHyphenEvidence?.length ? { lineHyphenEvidence: entry.lineHyphenEvidence } : {}),
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
      let rawOffset = 0;
      const lineHyphenEvidence = [];
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        for (const evidence of token.lineHyphenEvidence || []) {
          lineHyphenEvidence.push({ ...evidence, offset: evidence.offset + rawOffset });
        }
        rawOffset += (token.rawSurface || "").length + (index + 1 < tokens.length ? 1 : 0);
      }
      return {
        type: "phrase",
        startIndex: phrase.startIndex,
        endIndex: phrase.endIndex,
        // Keep the tapped phrase surface as the request identity; storageKey
        // returned by the host identifies the durable vocabulary family.
        surfaceKey: tokens.map((token) => token.surfaceKey).join(" "),
        rawSurface: tokens.map((token) => token.rawSurface).join(" "),
        logicalSurface: tokens.map((token) => token.logicalSurface ?? token.rawSurface).join(" "),
        ...(lineHyphenEvidence.length ? { lineHyphenEvidence } : {}),
      };
    }
    // A click in LingQ mode is also the lookup gesture for words that have
    // not been added yet. Drag selection remains native because handleTap()
    // only runs when the Selection is collapsed; the tap can then add a new
    // status record through the same existing pill controls.
    return { type: "word", startIndex: tokenIndex, endIndex: tokenIndex + 1,
      surfaceKey: tappedToken.surfaceKey, rawSurface: tappedToken.rawSurface,
      logicalSurface: tappedToken.logicalSurface ?? tappedToken.rawSurface,
      ...(tappedToken.lineHyphenEvidence?.length
        ? { lineHyphenEvidence: tappedToken.lineHyphenEvidence }
        : {}) };
  }

  rangeForOccurrence(pageNumber, startIndex, endIndex, expectedSurface = null) {
    if (!isPositivePageNumber(pageNumber) || !Number.isSafeInteger(startIndex) ||
        !Number.isSafeInteger(endIndex) || startIndex < 0 || endIndex <= startIndex || endIndex - startIndex > 12) return null;
    // A vocabulary pill can outlive its page's visible-page cache entry. The
    // pill still identifies a lexical token range, but TextNodes are only
    // cached for rendered pages. Resolve against the current PDF.js text layer
    // on this explicit user action instead of treating an evicted page cache
    // as loss of occurrence identity.
    const pageRoot = this.getPageRoot(pageNumber);
    const textLayer = pageRoot?.querySelector?.(".textLayer");
    if (!pageRoot || !textLayer) return null;
    let page = this.pages.get(pageKey(pageNumber));
    const cachedNodesAreCurrent = page?.pageRoot === pageRoot && page.textLayer === textLayer &&
      page.tokens?.every((token) => token.segments?.every((segment) => segment?.textNode &&
        segment.textNode.isConnected !== false && textLayer.contains?.(segment.textNode) !== false));
    if (!cachedNodesAreCurrent) {
      let tokens;
      try { tokens = this.scan(textLayer); } catch { return null; }
      if (!Array.isArray(tokens)) return null;
      page = { pageNumber, pageRoot, textLayer, tokens };
    }
    const occurrenceTokens = page.tokens.slice(startIndex, endIndex);
    if (occurrenceTokens.length !== endIndex - startIndex) return null;
    if (typeof expectedSurface === "string") {
      const normalizeWhitespace = (value) => value.replace(/\s+/gu, " ").trim();
      const resolvedSurface = normalizeWhitespace(occurrenceTokens.map((token) => token?.rawSurface || "").join(" "));
      if (!expectedSurface.trim() || normalizeWhitespace(expectedSurface) !== resolvedSurface) return null;
    }
    const first = occurrenceTokens[0]?.segments?.[0];
    const lastSegments = occurrenceTokens.at(-1)?.segments;
    const last = lastSegments?.[lastSegments.length - 1];
    if (!textLayer || !first?.textNode || !last?.textNode ||
        !pageRoot.contains?.(first.textNode) || !pageRoot.contains?.(last.textNode)) return null;
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
    const displaySurface = entry.logicalSurface ?? entry.rawSurface;
    popup.className = "pdfReaderVocabularyPill";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", `LingQ 词条：${displaySurface}`);
    popup.dataset.requestId = requestId;
    popup.dataset.key = entry.surfaceKey;
    popup.dataset.type = entry.type;
    popup.dataset.pageNumber = String(page.pageNumber);

    const heading = this.document.createElement("button");
    heading.type = "button";
    heading.setAttribute("aria-expanded", "false");
    heading.setAttribute("aria-label", `${entry.rawSurface}：展开构词与显示模式`);
    heading.className = "pdfReaderVocabularyPillHeading";
    heading.textContent = displaySurface;
    const status = this.document.createElement("span");
    status.className = "pdfReaderVocabularyPillStatus";
    status.textContent = "正在读取学习状态…";
    const pronunciation = this.document.createElement("div");
    pronunciation.className = "pdfReaderVocabularyPillPronunciation";
    pronunciation.hidden = true;
    const meanings = this.document.createElement("div");
    meanings.className = "pdfReaderVocabularyPillMeanings";
    meanings.textContent = "正在读取个人词汇数据…";
    const actions = this.document.createElement("div");
    actions.className = "pdfReaderVocabularyPillActions";
    const occurrenceActions = this.document.createElement("div");
    occurrenceActions.className = "pdfReaderVocabularyPillOccurrenceActions";
    const copyOccurrence = this.document.createElement("button");
    copyOccurrence.type = "button";
    copyOccurrence.className = "pdfReaderVocabularyPillOccurrenceLink";
    copyOccurrence.textContent = "🔗 Link";
    copyOccurrence.setAttribute("aria-label", "复制此处链接");
    copyOccurrence.title = "复制此处链接";
    copyOccurrence.addEventListener("click", (event) => {
      event.stopPropagation?.();
      if (copyOccurrence.disabled) return;
      const occurrenceRequestId = `reader-occurrence-${++this.querySequence}-${this.makeId()}`;
      const posted = this.postToHost("reader-anchor-occurrence-link-request", {
        requestId: occurrenceRequestId,
        pageNumber: page.pageNumber,
        startIndex: entry.startIndex,
        endIndex: entry.endIndex,
        expectedSurface: entry.rawSurface,
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
    const contextActions = this.document.createElement("div");
    contextActions.className = "pdfReaderVocabularyContextActions";
    contextActions.style.display = "grid";
    contextActions.style.gap = "6px";
    const contextCapture = this.document.createElement("button");
    contextCapture.type = "button";
    contextCapture.className = "pdfReaderVocabularyContextCapture";
    contextCapture.textContent = "保存语境";
    contextCapture.setAttribute("aria-label", "保存语境：请先选择当前页中的一句文本");
    contextCapture.addEventListener("click", (event) => {
      event.stopPropagation?.();
      this.requestVocabularyContextCapture();
    });
    const contextStatus = this.document.createElement("div");
    contextStatus.className = "pdfReaderVocabularyContextStatus";
    contextStatus.hidden = true;
    const contextPreview = this.document.createElement("textarea");
    contextPreview.className = "pdfReaderVocabularyContextPreview";
    contextPreview.readOnly = true;
    contextPreview.rows = 3;
    contextPreview.setAttribute("aria-label", "Host 捕获的语境句子预览");
    contextPreview.hidden = true;
    // The preview always shows the original sentence that the host captured
    // and will verify against its private anchor. It is selectable for review
    // but cannot drift away from the text associated with captureId.
    contextPreview.style.width = "100%";
    contextPreview.style.maxWidth = "100%";
    contextPreview.style.boxSizing = "border-box";
    const contextConfirm = this.document.createElement("button");
    contextConfirm.type = "button";
    contextConfirm.className = "pdfReaderVocabularyContextConfirm";
    contextConfirm.textContent = "确认保存语境";
    contextConfirm.hidden = true;
    contextConfirm.addEventListener("click", (event) => {
      event.stopPropagation?.();
      this.confirmVocabularyContextSave();
    });
    contextActions.append(contextCapture, contextPreview, contextConfirm, contextStatus);
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
    const body = this.document.createElement("div");
    body.className = "pdfReaderVocabularyPillBody";
    const morphology = this.document.createElement("section");
    morphology.className = "pdfReaderVocabularyMorphology";
    const modeControls = this.document.createElement("div");
    modeControls.className = "pdfReaderVocabularyWordModes";
    modeControls.setAttribute("role", "group");
    modeControls.setAttribute("aria-label", "所有词条卡的构词显示模式");
    const modeButtons = ["whole", "roots"].map((mode) => {
      const button = this.document.createElement("button");
      button.type = "button";
      button.textContent = mode === "roots" ? "词根模式" : "全词模式";
      button.addEventListener("click", (event) => {
        event.stopPropagation?.();
        if (!this.identityIsCurrent()) return;
        this.postToHost("vocab-word-mode-request", { mode,
          documentId: this.identity.documentId, openRequest: this.identity.openRequest });
      });
      modeControls.appendChild(button);
      return { mode, button };
    });
    const morphologyParts = this.document.createElement("div");
    morphologyParts.className = "pdfReaderVocabularyMorphologyParts";
    const morphologyNote = this.document.createElement("div");
    morphologyNote.className = "pdfReaderVocabularyMorphologyNote";
    morphology.append(modeControls, morphologyParts, morphologyNote);
    heading.addEventListener("click", (event) => {
      event.stopPropagation?.();
      const pill = this.entryPill;
      if (!pill) return;
      pill.morphologyExpanded = !pill.morphologyExpanded;
      this.syncWordMorphology();
    });
    body.append(morphology, pronunciation, meanings, backlinkActions, contextActions);
    popup.append(heading, status, occurrenceActions, close, body, actions);
    this.document.body.appendChild(popup);
    this.entryPill = {
      popup, page, entry, requestId, heading, statusElement: status,
      anchorPoint: { x, y }, body,
      morphology, morphologyParts, morphologyNote, modeButtons,
      morphologyExpanded: this.wordDisplayMode === "roots",
      pronunciation, meanings, buttons, record: null, status: null, pendingStatus: null,
      occurrenceRequestId: null, occurrenceButton: copyOccurrence,
      backlinks, openBacklinks, backlinkRequestId: null, anchorIds: [],
      documentId: this.identity.documentId, openRequest: this.identity.openRequest,
      contextCapture, contextPreview, contextConfirm, contextStatus,
      contextRequestId: null, contextCaptureId: null, contextState: null,
    };
    this.syncWordMorphology();
    this.positionEntryPill(popup, x, y);
    const ResizeObserverImpl = this.window?.ResizeObserver || globalThis.ResizeObserver;
    if (typeof ResizeObserverImpl === "function") {
      const observedPill = this.entryPill;
      observedPill.resizeObserver = new ResizeObserverImpl(() => {
        if (this.entryPill === observedPill) this.scheduleEntryPillLayout();
      });
      observedPill.resizeObserver.observe(popup);
    }
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

  requestVocabularyContextCapture() {
    const pill = this.entryPill;
    if (!pill || !this.enabled || !this.identityIsCurrent(pill) ||
        ["capturing", "saving", "saved"].includes(pill.contextState)) return false;
    const requestId = `reader-vocabulary-context-${++this.querySequence}-${this.makeId()}`;
    pill.contextRequestId = requestId;
    pill.contextCaptureId = null;
    pill.contextState = "capturing";
    pill.contextPreview.value = "";
    pill.contextPreview.hidden = true;
    pill.contextConfirm.hidden = true;
    pill.contextConfirm.disabled = false;
    pill.contextCapture.hidden = false;
    pill.contextCapture.disabled = true;
    pill.contextCapture.textContent = "等待选句…";
    pill.contextStatus.textContent = "请先在当前 PDF 页选择一句文本。";
    pill.contextStatus.hidden = false;
    this.scheduleEntryPillLayout();
    const sent = this.postToHost("reader-vocabulary-context-capture-request", {
      requestId,
      pageNumber: pill.page.pageNumber,
      expectedSurface: pill.entry.logicalSurface ?? pill.entry.rawSurface,
      documentId: pill.documentId,
      openRequest: pill.openRequest,
    });
    if (!sent && this.entryPill === pill && pill.contextRequestId === requestId) {
      this.resetVocabularyContextPreview(pill, "语境捕获请求未发送，请重试。", "保存语境");
    }
    return sent;
  }

  handleVocabularyContextPreview(message) {
    const pill = this.entryPill;
    if (!pill || (message?.type != null && message.type !== "reader-vocabulary-context-preview") ||
        !this.identityIsCurrent(pill) || message?.documentId !== pill.documentId ||
        message?.openRequest !== pill.openRequest || message?.requestId !== pill.contextRequestId ||
        pill.contextState !== "capturing") return false;
    if (message.ok !== true) {
      this.resetVocabularyContextPreview(pill,
        message.message || message.error || "未能捕获当前页的选句，请重试。", "保存语境");
      this.scheduleEntryPillLayout();
      return true;
    }
    const expectedSurface = pill.entry.logicalSurface ?? pill.entry.rawSurface;
    if (typeof expectedSurface !== "string" || message.surface !== expectedSurface ||
        typeof message.sentence !== "string" || !message.sentence.trim() || message.sentence.length > 12000 ||
        typeof message.captureId !== "string" || !message.captureId || message.captureId.length > 128) {
      this.resetVocabularyContextPreview(pill, "无法确认 Host 捕获的句子，请重新选择。", "保存语境");
      this.scheduleEntryPillLayout();
      return true;
    }
    pill.contextCaptureId = message.captureId;
    pill.contextState = "preview";
    pill.contextPreview.value = message.sentence;
    pill.contextPreview.hidden = false;
    pill.contextConfirm.hidden = false;
    pill.contextConfirm.disabled = false;
    pill.contextCapture.disabled = false;
    pill.contextCapture.textContent = "重新选择语境";
    pill.contextStatus.textContent = "请核对 Host 捕获的原句，再确认保存。";
    pill.contextStatus.hidden = false;
    this.scheduleEntryPillLayout();
    return true;
  }

  confirmVocabularyContextSave() {
    const pill = this.entryPill;
    if (!pill || pill.contextState !== "preview" || !pill.contextRequestId || !pill.contextCaptureId ||
        !this.enabled || !this.identityIsCurrent(pill)) return false;
    pill.contextState = "saving";
    pill.contextConfirm.disabled = true;
    pill.contextCapture.disabled = true;
    pill.contextStatus.textContent = "正在保存语境…";
    pill.contextStatus.hidden = false;
    this.scheduleEntryPillLayout();
    const sent = this.postToHost("reader-vocabulary-context-save-request", {
      requestId: pill.contextRequestId,
      captureId: pill.contextCaptureId,
      documentId: pill.documentId,
      openRequest: pill.openRequest,
    });
    if (!sent && this.entryPill === pill && pill.contextState === "saving") {
      pill.contextState = "preview";
      pill.contextConfirm.disabled = false;
      pill.contextCapture.disabled = false;
      pill.contextStatus.textContent = "保存请求未发送，请重试。";
      this.scheduleEntryPillLayout();
    }
    return sent;
  }

  handleVocabularyContextSaveResult(message) {
    const pill = this.entryPill;
    if (!pill || (message?.type != null && message.type !== "reader-vocabulary-context-save-result") ||
        !this.identityIsCurrent(pill) || message?.documentId !== pill.documentId ||
        message?.openRequest !== pill.openRequest || message?.requestId !== pill.contextRequestId ||
        message?.captureId !== pill.contextCaptureId ||
        pill.contextState !== "saving") return false;
    if (message.ok === true) {
      pill.contextRequestId = null;
      pill.contextCaptureId = null;
      pill.contextState = "saved";
      pill.contextCapture.hidden = true;
      pill.contextConfirm.hidden = true;
      pill.contextPreview.disabled = true;
      pill.contextStatus.textContent = message.message || "语境已保存。";
      pill.contextStatus.hidden = false;
    } else {
      this.resetVocabularyContextPreview(pill,
        message.message || message.status || "语境保存失败，请重新选择句子。", "保存语境");
    }
    this.scheduleEntryPillLayout();
    return true;
  }

  resetVocabularyContextPreview(pill, message = "", captureLabel = "保存语境") {
    if (!pill) return false;
    pill.contextRequestId = null;
    pill.contextCaptureId = null;
    pill.contextState = null;
    pill.contextPreview.value = "";
    pill.contextPreview.disabled = false;
    pill.contextPreview.hidden = true;
    pill.contextConfirm.disabled = false;
    pill.contextConfirm.hidden = true;
    pill.contextCapture.disabled = false;
    pill.contextCapture.hidden = false;
    pill.contextCapture.textContent = captureLabel;
    pill.contextStatus.textContent = message;
    pill.contextStatus.hidden = !message;
    return true;
  }

  pillViewport() {
    const visual = this.window?.visualViewport;
    return {
      left: Math.max(0, Number(visual?.offsetLeft) || 0),
      top: Math.max(0, Number(visual?.offsetTop) || 0),
      width: Math.max(1, Number(visual?.width) || Number(this.window?.innerWidth) || 800),
      height: Math.max(1, Number(visual?.height) || Number(this.window?.innerHeight) || 600),
    };
  }

  pillAnchor(x, y) {
    const pill = this.entryPill;
    // Reuse the current lexical token range without scanning or matching.
    const page = this.pages.get(pageKey(pill?.page?.pageNumber)) || pill?.page;
    const tokens = page?.tokens?.slice(pill?.entry?.startIndex, pill?.entry?.endIndex);
    const first = tokens?.[0]?.segments?.[0];
    const last = tokens?.at(-1)?.segments?.at(-1);
    if (first?.textNode?.isConnected !== false && last?.textNode?.isConnected !== false &&
        first?.textNode && last?.textNode && this.document?.createRange) {
      const range = this.document.createRange();
      try {
        range.setStart(first.textNode, first.startOffset);
        range.setEnd(last.textNode, last.endOffset);
        const rects = Array.from(range.getClientRects()).filter((rect) =>
          [rect.left, rect.right, rect.top, rect.bottom].every(Number.isFinite) &&
          rect.right > rect.left && rect.bottom > rect.top);
        const distance = (rect) => Math.max(rect.left - x, 0, x - rect.right) ** 2 +
          Math.max(rect.top - y, 0, y - rect.bottom) ** 2;
        rects.sort((a, b) => distance(a) - distance(b));
        if (rects.length) return rects[0];
      } catch { /* Detached text geometry falls back to the original tap. */ }
      finally { range.detach?.(); }
    }
    return { left: x, right: x, top: y, bottom: y };
  }

  positionEntryPill(popup, x, y) {
    const viewport = this.pillViewport();
    const maxWidth = Math.max(1, viewport.width - 20);
    const maxHeight = Math.max(1, viewport.height - 20);
    popup.style.setProperty?.("--pill-visual-width", `${viewport.width}px`);
    popup.dataset.compactHeader = String(viewport.width < 300);
    popup.style.maxWidth = `${Math.min(420, maxWidth)}px`;
    popup.style.maxHeight = `${Math.min(420, maxHeight)}px`;
    const anchor = this.pillAnchor(x, y);
    const rect = popup.getBoundingClientRect?.();
    // A narrow pinch viewport can wrap the grade row. Reserve the measured
    // non-scrolling controls plus one line instead of clipping those controls.
    const bodyRect = this.entryPill?.body?.getBoundingClientRect?.();
    const minHeight = Math.max(150, (Number(rect?.height) || 0) - (Number(bodyRect?.height) || 0) + 30);
    const placement = computeVocabularyPillPlacement({ viewport, anchor,
      width: Number(rect?.width) || Number(popup.offsetWidth) || 320,
      height: Number(rect?.height) || Number(popup.offsetHeight) || 180, minHeight });
    popup.dataset.placement = placement.placement;
    popup.style.maxHeight = `${Math.min(420, placement.maxHeight)}px`;
    // Constraining the body can change intrinsic width/height. Measure its
    // final layout once before clamping, including the actual VisualViewport.
    const finalRect = popup.getBoundingClientRect?.();
    const finalPlacement = computeVocabularyPillPlacement({ viewport, anchor,
      width: Number(finalRect?.width) || Number(popup.offsetWidth) || 320,
      height: Number(finalRect?.height) || Number(popup.offsetHeight) || 180, minHeight });
    popup.style.left = `${finalPlacement.left}px`;
    popup.style.top = `${finalPlacement.top}px`;
  }

  scheduleEntryPillLayout() {
    const pill = this.entryPill;
    if (!pill || this.disposed || this.entryPillLayoutHandle !== null) return false;
    const layout = () => {
      if (this.entryPill !== pill) return;
      this.entryPillLayoutHandle = null;
      this.entryPillLayoutCancel = null;
      if (this.disposed || !this.identityIsCurrent()) return;
      this.positionEntryPill(pill.popup, pill.anchorPoint.x, pill.anchorPoint.y);
    };
    if (typeof this.window?.requestAnimationFrame === "function") {
      this.entryPillLayoutHandle = this.window.requestAnimationFrame(layout);
      this.entryPillLayoutCancel = () => this.window.cancelAnimationFrame?.(this.entryPillLayoutHandle);
    } else layout();
    return true;
  }

  handleEntryResult(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.documentId !== this.identity.documentId ||
        message?.openRequest !== this.identity.openRequest || message?.requestId !== pill.requestId ||
        message?.key !== pill.entry.surfaceKey || message?.pageNumber !== pill.page.pageNumber) return false;
    if (message.record && (message.record.key !== pill.entry.surfaceKey ||
        message.record.storageKey != null && (typeof message.record.storageKey !== "string" || !message.record.storageKey))) return false;
    if (message.error) {
      pill.statusElement.textContent = "学习状态不可用";
      pill.meanings.textContent = "个人词汇数据读取失败。";
      this.scheduleEntryPillLayout();
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
    pill.occurrenceButton.textContent = "🔗 Link";
    pill.occurrenceButton.setAttribute("aria-label", message.ok === true ? "已复制链接" : "复制此处链接");
    pill.occurrenceButton.title = message.ok === true ? "已复制链接" : message.message || "复制此处链接";
    pill.occurrenceButton.classList.toggle("is-copied", message.ok === true);
    this.scheduleEntryPillLayout();
    return true;
  }

  handleOccurrenceBacklinks(message) {
    const pill = this.entryPill;
    if (!pill || !this.identityIsCurrent() || message?.documentId !== this.identity.documentId ||
        message?.openRequest !== this.identity.openRequest || message?.requestId !== pill.backlinkRequestId) return false;
    pill.backlinkRequestId = null;
    if (message.ok !== true || !Number.isSafeInteger(message.count) || message.count < 0) {
      pill.backlinks.textContent = "反向链接：无法确认";
      this.scheduleEntryPillLayout();
      return true;
    }
    pill.anchorIds = Array.isArray(message.anchorIds)
      ? [...new Set(message.anchorIds.filter((value) => typeof value === "string" && value.length <= 128))].slice(0, 32)
      : [];
    pill.backlinks.textContent = `反向链接：${message.count}`;
    pill.openBacklinks.hidden = message.count === 0 || pill.anchorIds.length === 0;
    pill.openBacklinks.disabled = pill.openBacklinks.hidden;
    this.scheduleEntryPillLayout();
    return true;
  }

  setWordDisplayMode(mode) {
    if (this.disposed) return false;
    this.wordDisplayMode = normalizeWordDisplayMode(mode);
    if (this.entryPill) this.entryPill.morphologyExpanded = true;
    this.syncWordMorphology();
    return true;
  }

  syncWordMorphology() {
    const pill = this.entryPill;
    if (!pill?.morphology) return;
    const expanded = pill.morphologyExpanded === true;
    pill.heading.setAttribute("aria-expanded", String(expanded));
    pill.morphology.hidden = !expanded;
    for (const { mode, button } of pill.modeButtons) {
      button.setAttribute("aria-pressed", String(mode === this.wordDisplayMode));
    }
    if (!expanded) {
      this.scheduleEntryPillLayout();
      return;
    }
    const roots = this.wordDisplayMode === "roots";
    const analysis = roots ? (pill.wordAnalysis ||= analyzeEnglishWord(pill.entry.rawSurface)) : null;
    pill.morphologyParts.textContent = analysis?.supported
      ? analysis.parts.map((part) => `${part.form}（${part.meaning}）`).join(" + ")
      : pill.entry.rawSurface;
    pill.morphologyNote.textContent = roots ? analysis.note : "全词显示。此设置应用于所有词条卡。";
    this.scheduleEntryPillLayout();
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
      ? vocabularyPillStatusLabel(record)
      : "正在保存…";
    pill.pronunciation.textContent = presentation.pronunciation;
    pill.pronunciation.hidden = presentation.pronunciation.length === 0;
    // The host merges an optional, read-only dictionary result with this
    // document's personal learning state. The latter remains the only source
    // of status; dictionary metadata must never create a synthetic status.
    pill.meanings.textContent = presentation.meanings.length
      ? presentation.meanings.join("\n")
      : presentation.meaningFallbackLabel;
    this.scheduleEntryPillLayout();
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
      logicalSurface: pill.entry.logicalSurface,
      ...(pill.entry.lineHyphenEvidence?.length
        ? { lineHyphenEvidence: pill.entry.lineHyphenEvidence }
        : {}),
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
      ? vocabularyPillStatusLabel(pill.record)
      : "正在保存…";
    this.scheduleEntryPillLayout();
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
    const priorRecord = pill.record || {};
    this.updatePillRecord({
      ...priorRecord,
      ...message.record,
      hasPersonalRecord: true,
      dictionaryLookupState: priorRecord.dictionaryLookupState,
      translation: message.record.translation || priorRecord.translation || "",
      phonetic: message.record.phonetic || priorRecord.phonetic || "",
    });
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
    this.scheduleEntryPillLayout();
    return true;
  }

  dismissEntryPill() {
    this.entryPillLayoutCancel?.();
    this.entryPillLayoutHandle = null;
    this.entryPillLayoutCancel = null;
    const pill = this.entryPill;
    if (pill) {
      pill.contextRequestId = null;
      pill.contextCaptureId = null;
      pill.contextState = null;
      pill.resizeObserver?.disconnect?.();
      pill.popup?.remove?.();
    }
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
    if (message.changedKeys !== undefined && message.invalidateAll !== true) {
      if (!Array.isArray(message.changedKeys) || message.changedKeys.length > 64 ||
          message.changedKeys.some((key) => typeof key !== "string" || !key || normalizeTermKey(key) !== key)) return false;
      if (!message.changedKeys.length) return true;
      // Invalidation is a low-frequency mutation path, separate from page
      // matching and zoom. Compare only bounded cached token signatures; a
      // newly saved word has no old match row, so rows alone are insufficient.
      const paths = message.changedKeys.map((key) => key.split(" ").map(normalizeEnglishLemmaKey));
      const affected = (signature) => {
        const tokens = String(signature || "").split("\u001f").map(normalizeEnglishLemmaKey);
        return paths.some((path) => tokens.some((_, start) =>
          start + path.length <= tokens.length && path.every((part, offset) => part === tokens[start + offset])));
      };
      for (const [number, cached] of this.pageResultCache) {
        if (affected(cached.signature)) this.pageResultCache.delete(number);
      }
      // Reuse the physical token ranges of visible pages, including pages
      // whose first query is still pending. No PDF/textLayer rescan occurs.
      for (const page of this.pages.values()) {
        if (this.isPageVisible(page.pageNumber) && affected(page.signature)) this.queryPage(page, { force: true });
      }
      return true;
    }
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
    this.visualViewport?.removeEventListener?.("resize", this.onVisualViewportChanged);
    this.visualViewport?.removeEventListener?.("scroll", this.onVisualViewportChanged);
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
          before?.logicalSurface !== after?.logicalSurface ||
          JSON.stringify(before?.lineHyphenEvidence || []) !== JSON.stringify(after?.lineHyphenEvidence || []) ||
          before?.segments?.length !== after?.segments?.length) return false;
    for (let segmentIndex = 0; segmentIndex < before.segments.length; segmentIndex += 1) {
      const left = before.segments[segmentIndex];
      const right = after.segments[segmentIndex];
      if (left?.textNode !== right?.textNode || left?.startOffset !== right?.startOffset || left?.endOffset !== right?.endOffset) return false;
    }
  }
  return true;
}
