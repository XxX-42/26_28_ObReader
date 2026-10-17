const STATUS_COLORS = Object.freeze({
  1: "rgba(217, 119, 6, 0.22)",
  2: "rgba(202, 138, 4, 0.22)",
  3: "rgba(22, 163, 74, 0.18)",
  4: "rgba(37, 99, 235, 0.18)",
  5: "rgba(124, 58, 237, 0.18)",
});

const SAME_LINE_CENTER_RATIO = 0.55;
const HIGHLIGHT_ROW_GAP_PX = 1;
const MIN_HORIZONTAL_OVERLAP_PX = 0.5;

let nextRendererId = 0;

/**
 * Keep overlapping marks inside the actual selected text bands. Only ranges
 * that overlap both vertically and horizontally can constrain one another;
 * this avoids mixing independent PDF columns. When two distinct line boxes
 * collide, shrink around each range's measured center instead of moving the
 * highlight to a page-wide guessed row. The input is rebuilt from live Ranges
 * on every draw, so the same calculation follows PDF.js zoom and reflow.
 */
function separateOverlappingRangeRects(rectangles) {
  const ordered = rectangles
    .filter((rect) => [rect?.x, rect?.y, rect?.width, rect?.height].every(Number.isFinite) &&
      rect.width > 0 && rect.height > 0)
    .map((rect) => ({ ...rect, centerY: rect.y + rect.height / 2, paintHeight: rect.height }))
    .sort((left, right) => left.y - right.y || left.x - right.x);
  let changed = false;

  for (let index = 0; index < ordered.length; index += 1) {
    const upper = ordered[index];
    const upperBottom = upper.y + upper.height;
    for (let nextIndex = index + 1; nextIndex < ordered.length; nextIndex += 1) {
      const lower = ordered[nextIndex];
      if (lower.y >= upperBottom) break;

      const centerDistance = Math.abs(lower.centerY - upper.centerY);
      const rowTolerance = Math.min(upper.height, lower.height) * SAME_LINE_CENTER_RATIO;
      if (centerDistance <= rowTolerance) continue;

      const horizontalOverlap = Math.min(upper.x + upper.width, lower.x + lower.width) -
        Math.max(upper.x, lower.x);
      if (horizontalOverlap < MIN_HORIZONTAL_OVERLAP_PX) continue;

      const upperTop = upper.centerY - upper.paintHeight / 2;
      const upperPaintBottom = upper.centerY + upper.paintHeight / 2;
      const lowerTop = lower.centerY - lower.paintHeight / 2;
      const lowerPaintBottom = lower.centerY + lower.paintHeight / 2;
      if (upperPaintBottom <= lowerTop || lowerPaintBottom <= upperTop) continue;

      const availableHeight = Math.max(1, centerDistance - HIGHLIGHT_ROW_GAP_PX);
      if (upper.paintHeight > availableHeight || lower.paintHeight > availableHeight) {
        upper.paintHeight = Math.min(upper.paintHeight, availableHeight);
        lower.paintHeight = Math.min(lower.paintHeight, availableHeight);
        changed = true;
      }
    }
  }

  return {
    changed,
    rectangles: ordered.map(({ centerY, paintHeight, ...rect }) => ({
      ...rect,
      y: centerY - paintHeight / 2,
      height: paintHeight,
    })),
  };
}

/**
 * Paint vocabulary marks through the browser's text-rendering highlight layer.
 * CSS Custom Highlights keep ranges attached to PDF.js text nodes, so zoom,
 * scrolling, selection and PDF.js page transforms don't depend on cached pixel
 * coordinates. A page-local canvas is also used when measured line boxes
 * overlap, so those boxes can be fitted around their own text centers. Both
 * paths start from live PDF.js text ranges and never infer a page-wide row.
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
    if (this.canvas) {
      // PDF.js can replace the page's child layers during zoom or page-size
      // changes. The page root survives, but a plugin canvas may be detached
      // with the old layer subtree; reattach the same page-local surface.
      if (this.canvas.parentNode !== this.pageRoot) this.pageRoot.appendChild(this.canvas);
      return this.canvas;
    }
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
              const width = Number(rect.width);
              const height = Number(rect.height);
              if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
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
      const separated = separateOverlappingRangeRects(rectangles);
      if (separated.changed) {
        this.clearTextHighlights();
        return this.paintCanvasRectangles(separated.rectangles, pageRect);
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
    const separated = separateOverlappingRangeRects(this.collectRangeRectangles(tokenHighlights, pageRect));
    return this.paintCanvasRectangles(separated.rectangles, pageRect);
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
    // Range rectangles are measured from the page border box. An absolutely
    // positioned child starts at the page's padding edge, inside its border;
    // compensate so the canvas origin and measured coordinates share a frame.
    const borderLeft = Math.max(0, Number(this.pageRoot.clientLeft) || 0);
    const borderTop = Math.max(0, Number(this.pageRoot.clientTop) || 0);
    this.canvas.style.left = `${-borderLeft}px`;
    this.canvas.style.top = `${-borderTop}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    const context = this.canvas.getContext?.("2d");
    if (!context) return false;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    for (const rect of rectangles) {
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
