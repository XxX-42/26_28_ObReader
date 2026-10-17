const STATUS_COLORS = Object.freeze({
  1: "rgba(217, 119, 6, 0.22)",
  2: "rgba(202, 138, 4, 0.22)",
  3: "rgba(22, 163, 74, 0.18)",
  4: "rgba(37, 99, 235, 0.18)",
  5: "rgba(124, 58, 237, 0.18)",
});

const SAME_TEXT_LINE_TOP_TOLERANCE_PX = 2;
const INTER_LINE_GAP_PX = 0.5;

/**
 * Keep fallback rectangles for compact neighboring text rows from painting
 * over each other. The classifier only sees ranges already selected for
 * vocabulary marks; it never scans the page. Rects whose tops differ by at
 * most 2 CSS px are treated as one line. For distinct lines, a row is clipped
 * only when its measured boxes overlap the next row, leaving a 0.5 CSS px gap.
 */
export function separateOverlappingHighlightRows(rectangles) {
  if (!Array.isArray(rectangles) || rectangles.length < 2) return rectangles || [];
  const ordered = rectangles
    .filter((rect) => [rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite) && rect.height > 0)
    .sort((left, right) => left.y - right.y || left.x - right.x);
  const rows = [];
  for (const rect of ordered) {
    let row = rows.at(-1);
    if (!row || rect.y - row.top > SAME_TEXT_LINE_TOP_TOLERANCE_PX) {
      row = { top: rect.y, bottom: rect.y + rect.height, rects: [] };
      rows.push(row);
    } else {
      row.top = Math.min(row.top, rect.y);
      row.bottom = Math.max(row.bottom, rect.y + rect.height);
    }
    row.rects.push(rect);
  }

  for (const row of rows) {
    const heights = row.rects.map((rect) => rect.height).sort((left, right) => left - right);
    row.naturalHeight = heights[Math.floor(heights.length / 2)];
  }

  for (let index = 0; index + 1 < rows.length; index += 1) {
    const row = rows[index];
    const next = rows[index + 1];
    const pitch = next.top - row.top;
    if (!(pitch > 0) || row.bottom <= next.top) continue;
    row.overlapPitch = Math.min(row.overlapPitch ?? Infinity, pitch);
    next.overlapPitch = Math.min(next.overlapPitch ?? Infinity, pitch);
  }

  for (const row of rows) {
    if (!Number.isFinite(row.overlapPitch)) continue;
    // Fit the row into its actual inter-line band, centered when there is
    // spare room and keeping a half-pixel gap at both edges. At very tight
    // line spacing this can be under 2/3 of the glyph box; that is a geometric
    // limit, so use the full available height.
    const availableHeight = Math.max(1, row.overlapPitch - INTER_LINE_GAP_PX);
    const targetHeight = Math.min(row.naturalHeight, availableHeight);
    const centeredTop = row.top + INTER_LINE_GAP_PX / 2 + (availableHeight - targetHeight) / 2;
    for (const rect of row.rects) {
      rect.y = centeredTop;
      rect.height = targetHeight;
    }
  }
  return ordered;
}

let nextRendererId = 0;

/**
 * Paint vocabulary marks through the browser's text-rendering highlight layer.
 * CSS Custom Highlights keep ranges attached to PDF.js text nodes, so zoom,
 * scrolling, selection and PDF.js page transforms don't depend on cached pixel
 * coordinates. A page-local canvas is used for older WebViews and only for
 * already-matched ranges whose compact line boxes overlap geometrically.
 */
export class VocabularyHighlightRenderer {
  constructor(pageRoot, {
    documentRef = pageRoot?.ownerDocument || globalThis.document,
    windowRef = documentRef?.defaultView || globalThis.window,
  } = {}) {
    if (!pageRoot || typeof pageRoot.appendChild !== "function") {
      throw new TypeError("A rendered PDF page element is required.");
    }
    if (typeof documentRef?.createElement !== "function") {
      throw new TypeError("A document with createElement() is required.");
    }
    this.pageRoot = pageRoot;
    this.document = documentRef;
    this.window = windowRef;
    this.registry = windowRef?.CSS?.highlights;
    this.HighlightConstructor = windowRef?.Highlight;
    this.rendererId = ++nextRendererId;
    this.names = new Map(Object.keys(STATUS_COLORS).map((status) => [
      Number(status), `pdfReaderVocabulary${this.rendererId}Status${status}`,
    ]));
    this.styleElement = null;
    this.canvas = null;
    this.disposed = false;
    this.customHighlights = typeof this.registry?.set === "function" &&
      typeof this.registry?.delete === "function" &&
      typeof this.HighlightConstructor === "function" &&
      typeof documentRef.createRange === "function";

    if (this.customHighlights) {
      this.installHighlightStyles();
    } else {
      this.createCanvasFallback();
    }
  }

  installHighlightStyles() {
    this.styleElement = this.document.createElement("style");
    this.styleElement.dataset.pdfReaderVocabularyStyles = String(this.rendererId);
    this.styleElement.textContent = [...this.names.entries()]
      .map(([status, name]) => `::highlight(${name}) { background-color: ${STATUS_COLORS[status]}; }`)
      .join("\n");
    (this.document.head || this.document.documentElement || this.pageRoot).appendChild(this.styleElement);
  }

  createCanvasFallback() {
    if (this.canvas) return this.canvas;
    this.canvas = this.document.createElement("canvas");
    this.canvas.className = "pdfReaderVocabularyOverlay";
    this.canvas.setAttribute("aria-hidden", "true");
    Object.assign(this.canvas.style, {
      position: "absolute",
      top: "0",
      left: "0",
      pointerEvents: "none",
      zIndex: "3",
      width: "0px",
      height: "0px",
    });
    this.pageRoot.appendChild(this.canvas);
    return this.canvas;
  }

  draw(tokenHighlights) {
    if (this.disposed) return false;
    if (this.customHighlights) return this.drawTextHighlights(tokenHighlights);
    return this.drawCanvasFallback(tokenHighlights);
  }

  drawTextHighlights(tokenHighlights) {
    const rangesByStatus = new Map([...this.names.keys()].map((status) => [status, []]));
    const pageRect = this.pageRoot.getBoundingClientRect?.();
    const canMeasurePageRects = Number(pageRect?.width) > 0 && Number(pageRect?.height) > 0;
    const rectangles = [];
    for (const { token, status } of Array.isArray(tokenHighlights) ? tokenHighlights : []) {
      const ranges = rangesByStatus.get(status);
      if (!ranges || !token?.segments) continue;
      for (const segment of token.segments) {
        let range;
        try {
          range = this.document.createRange();
          range.setStart(segment.textNode, segment.startOffset);
          range.setEnd(segment.textNode, segment.endOffset);
          ranges.push(range);
          if (canMeasurePageRects) {
            const color = STATUS_COLORS[status];
            for (const rect of Array.from(range.getClientRects?.() || [])) {
              const x = rect.left - pageRect.left;
              const y = rect.top - pageRect.top;
              const width = Math.max(1, rect.width);
              const height = Math.max(1, rect.height);
              if ([x, y, width, height].every(Number.isFinite)) {
                rectangles.push({ x, y, width, height, color });
              }
            }
          }
        } catch {
          range?.detach?.();
        }
      }
    }

    if (canMeasurePageRects && rectangles.length > 1) {
      const originalHeights = new Map(rectangles.map((rect) => [rect, rect.height]));
      const adjusted = separateOverlappingHighlightRows(rectangles);
      const hasCompactOverlap = adjusted.some((rect) => rect.height < originalHeights.get(rect));
      if (hasCompactOverlap) {
        this.clearTextHighlights();
        return this.paintCanvasRectangles(adjusted, pageRect);
      }
    }
    this.clearCanvas();

    try {
      for (const [status, name] of this.names) {
        this.registry.delete(name);
        const ranges = rangesByStatus.get(status);
        if (!ranges.length) continue;
        const highlight = new this.HighlightConstructor();
        for (const range of ranges) highlight.add(range);
        this.registry.set(name, highlight);
      }
      return true;
    } catch {
      this.clearTextHighlights();
      return false;
    }
  }

  drawCanvasFallback(tokenHighlights) {
    const pageRect = this.pageRoot.getBoundingClientRect?.();
    const width = Number(pageRect?.width);
    const height = Number(pageRect?.height);
    if (!(width > 0) || !(height > 0)) {
      this.clear();
      return false;
    }
    return this.paintCanvasRectangles(this.collectRangeRectangles(tokenHighlights, pageRect), pageRect);
  }

  collectRangeRectangles(tokenHighlights, pageRect) {
    const rectangles = [];
    const rangeFactory = this.document.createRange?.bind(this.document);
    if (typeof rangeFactory !== "function") return rectangles;
    for (const { token, status } of Array.isArray(tokenHighlights) ? tokenHighlights : []) {
      const color = STATUS_COLORS[status];
      if (!color || !token?.segments) continue;
      for (const segment of token.segments) {
        let range;
        try {
          range = rangeFactory();
          range.setStart(segment.textNode, segment.startOffset);
          range.setEnd(segment.textNode, segment.endOffset);
          for (const rect of Array.from(range.getClientRects?.() || [])) {
            const x = rect.left - pageRect.left;
            const y = rect.top - pageRect.top;
            const width = Math.max(1, rect.width);
            const height = Math.max(1, rect.height);
            if ([x, y, width, height].every(Number.isFinite)) {
              rectangles.push({ x, y, width, height, color });
            }
          }
        } catch {
          // A detached Text node is a stale render; the next render will refresh it.
        } finally {
          range?.detach?.();
        }
      }
    }
    return rectangles;
  }

  paintCanvasRectangles(rectangles, pageRect) {
    const width = Number(pageRect?.width);
    const height = Number(pageRect?.height);
    const dpr = Math.max(1, Number(this.window?.devicePixelRatio || globalThis.devicePixelRatio) || 1);
    if (!(width > 0) || !(height > 0)) return false;
    this.createCanvasFallback();
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
      this.canvas.width = backingWidth;
      this.canvas.height = backingHeight;
    }
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const context = this.canvas.getContext?.("2d");
    if (!context) return false;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    for (const rect of separateOverlappingHighlightRows(rectangles)) {
      context.fillStyle = rect.color;
      context.fillRect(rect.x, rect.y, rect.width, rect.height);
    }
    return true;
  }

  clearTextHighlights() {
    for (const name of this.names.values()) this.registry?.delete?.(name);
  }

  clear() {
    if (this.disposed) return;
    if (this.customHighlights) {
      this.clearTextHighlights();
    }
    this.clearCanvas();
  }

  clearCanvas() {
    const context = this.canvas?.getContext?.("2d");
    context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose() {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.styleElement?.remove?.();
    this.canvas?.remove?.();
    if (this.canvas?.parentNode === this.pageRoot) this.pageRoot.removeChild(this.canvas);
  }
}

// Keep the previous named export for focused regression tests and older local
// imports; the implementation now prefers browser text rendering.
export const VocabularyCanvasOverlay = VocabularyHighlightRenderer;
