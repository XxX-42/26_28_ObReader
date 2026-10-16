const STATUS_COLORS = Object.freeze({
  1: "#d97706",
  2: "#ca8a04",
  3: "#16a34a",
  4: "#2563eb",
});

/**
 * A single, non-interactive Canvas overlay per rendered PDF page. The PDF.js
 * text layer and its Text nodes remain untouched and continue to own selection.
 */
export class VocabularyCanvasOverlay {
  constructor(pageRoot, { documentRef = pageRoot?.ownerDocument || globalThis.document } = {}) {
    if (!pageRoot || typeof pageRoot.appendChild !== "function") {
      throw new TypeError("A rendered PDF page element is required.");
    }
    if (typeof documentRef?.createElement !== "function") {
      throw new TypeError("A document with createElement() is required.");
    }
    this.pageRoot = pageRoot;
    this.canvas = documentRef.createElement("canvas");
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
    pageRoot.appendChild(this.canvas);
    this.disposed = false;
  }

  draw(tokenHighlights) {
    if (this.disposed) return false;
    const pageRect = this.pageRoot.getBoundingClientRect?.();
    const width = Number(pageRect?.width);
    const height = Number(pageRect?.height);
    const dpr = Math.max(1, Number(globalThis.devicePixelRatio) || 1);
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

    const rangeFactory = this.pageRoot.ownerDocument?.createRange?.bind(this.pageRoot.ownerDocument);
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
            const y = rect.bottom - pageRect.top - 2;
            const rectWidth = Math.max(1, rect.width);
            if ([x, y, rectWidth].every(Number.isFinite)) {
              context.fillRect(x, y, rectWidth, 2);
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

  clear() {
    if (this.disposed) return;
    const context = this.canvas.getContext?.("2d");
    context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.remove?.();
    if (this.canvas.parentNode === this.pageRoot) {
      this.pageRoot.removeChild(this.canvas);
    }
  }
}
