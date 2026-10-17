const STATUS_COLORS = Object.freeze({
  1: "rgba(217, 119, 6, 0.22)",
  2: "rgba(202, 138, 4, 0.22)",
  3: "rgba(22, 163, 74, 0.18)",
  4: "rgba(37, 99, 235, 0.18)",
  5: "rgba(124, 58, 237, 0.18)",
});

let nextRendererId = 0;

/**
 * Paint vocabulary marks through the browser's text-rendering highlight layer.
 * CSS Custom Highlights keep ranges attached to PDF.js text nodes, so zoom,
 * scrolling, selection and PDF.js page transforms don't depend on cached pixel
 * coordinates. A translucent page-local canvas is retained only for older
 * WebViews that do not implement the Custom Highlight API.
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
  }

  draw(tokenHighlights) {
    if (this.disposed) return false;
    if (this.customHighlights) return this.drawTextHighlights(tokenHighlights);
    return this.drawCanvasFallback(tokenHighlights);
  }

  drawTextHighlights(tokenHighlights) {
    const rangesByStatus = new Map([...this.names.keys()].map((status) => [status, []]));
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
        } catch {
          range?.detach?.();
        }
      }
    }

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
    const dpr = Math.max(1, Number(this.window?.devicePixelRatio || globalThis.devicePixelRatio) || 1);
    if (!(width > 0) || !(height > 0)) {
      this.clear();
      return false;
    }

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

    const rangeFactory = this.document.createRange?.bind(this.document);
    if (typeof rangeFactory !== "function") return true;
    for (const { token, status } of Array.isArray(tokenHighlights) ? tokenHighlights : []) {
      const color = STATUS_COLORS[status];
      if (!color || !token?.segments) continue;
      context.fillStyle = color;
      for (const segment of token.segments) {
        let range;
        try {
          range = rangeFactory();
          range.setStart(segment.textNode, segment.startOffset);
          range.setEnd(segment.textNode, segment.endOffset);
          for (const rect of Array.from(range.getClientRects?.() || [])) {
            const x = rect.left - pageRect.left;
            const y = rect.top - pageRect.top;
            const rectWidth = Math.max(1, rect.width);
            const rectHeight = Math.max(1, rect.height);
            if ([x, y, rectWidth, rectHeight].every(Number.isFinite)) {
              context.fillRect(x, y, rectWidth, rectHeight);
            }
          }
        } catch {
          // A detached Text node is a stale render; the next render will refresh it.
        } finally {
          range?.detach?.();
        }
      }
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
      return;
    }
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
