(() => {
  "use strict";

  function flattenTextLayer(textLayer) {
    if (!textLayer || !textLayer.ownerDocument?.createTreeWalker) return null;
    const walker = textLayer.ownerDocument.createTreeWalker(textLayer, 4);
    const nodes = [];
    let text = "";
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      const start = text.length;
      text += node.nodeValue;
      nodes.push({ node, start, end: text.length });
    }
    return { text, nodes, root: textLayer };
  }

  function anchorRange(documentRef, flattened, anchor) {
    const quote = anchor?.exactQuote;
    if (typeof quote !== "string" || !quote) return null;
    let start = anchor.textPosition?.start;
    let end = anchor.textPosition?.end;
    const prefix = typeof anchor.prefix === "string" ? anchor.prefix : "";
    const suffix = typeof anchor.suffix === "string" ? anchor.suffix : "";
    const atPosition = Number.isSafeInteger(start) && Number.isSafeInteger(end) && end > start &&
      flattened.text.slice(start, end) === quote &&
      flattened.text.slice(Math.max(0, start - prefix.length), start) === prefix &&
      flattened.text.slice(end, end + suffix.length) === suffix;
    if (!atPosition) {
      const candidates = [];
      let offset = flattened.text.indexOf(quote);
      while (offset >= 0 && candidates.length < 16) {
        const before = flattened.text.slice(Math.max(0, offset - prefix.length), offset);
        const after = flattened.text.slice(offset + quote.length, offset + quote.length + suffix.length);
        if (before === prefix && after === suffix) candidates.push(offset);
        offset = flattened.text.indexOf(quote, offset + 1);
      }
      if (candidates.length !== 1) return null;
      start = candidates[0];
      end = start + quote.length;
    }
    const boundary = (position) => {
      for (const item of flattened.nodes) {
        if (position >= item.start && position < item.end) return [item.node, position - item.start];
      }
      const last = flattened.nodes.at(-1);
      return position === flattened.text.length && last ? [last.node, last.node.nodeValue.length] : null;
    };
    const first = boundary(start);
    const last = boundary(end);
    if (!first || !last) return null;
    try {
      const range = documentRef.createRange();
      range.setStart(first[0], first[1]);
      range.setEnd(last[0], last[1]);
      return range;
    } catch { return null; }
  }

  function spanPointForNode(textLayer, node, offset) {
    if (node?.nodeType !== 3) return null;
    const span = node.parentElement?.closest?.("span");
    if (!span) return null;
    const spans = textLayer.querySelectorAll("span");
    const index = Array.prototype.indexOf.call(spans, span);
    if (index < 0) return null;
    return [index, Math.max(0, Math.min(4096, Number.isFinite(offset) ? offset : 0))];
  }

  function normalizedRect(rect, pageRect) {
    if (!rect || !pageRect?.width || !pageRect?.height) return null;
    const left = Math.max(0, Math.min(1, (rect.left - pageRect.left) / pageRect.width));
    const top = Math.max(0, Math.min(1, (rect.top - pageRect.top) / pageRect.height));
    const right = Math.max(left, Math.min(1, (rect.right - pageRect.left) / pageRect.width));
    const bottom = Math.max(top, Math.min(1, (rect.bottom - pageRect.top) / pageRect.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  class TextSelectionController {
    constructor({
      documentRef = document,
      isSessionCurrent = () => true,
    } = {}) {
      this.document = documentRef;
      this.isSessionCurrent = isSessionCurrent;
      this.pendingPointer = null;
    }

    isPending(pointer) { return this.pendingPointer === pointer; }

    clearPending(pointer = null) {
      if (!pointer || this.pendingPointer === pointer) this.pendingPointer = null;
    }

    cancelPending(pointer = null) {
      const pending = this.pendingPointer;
      if (pending && (!pointer || pending === pointer)) this.clearOwned(pending);
    }

    getSelection() {
      return this.document.getSelection();
    }

    resolveTarget(intent) {
      const point = intent?.clientPoint;
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        return { hitTarget: null, textLayer: null, textSpan: null, page: null };
      }
      const element = this.document.elementFromPoint?.(point.x, point.y) || null;
      const textLayer = element?.closest?.(".textLayer") || null;
      return {
        hitTarget: element,
        textLayer,
        textSpan: element?.closest?.(".textLayer span") || null,
        page: textLayer?.closest?.(".page") || null,
      };
    }

    snapshot(selection = this.getSelection()) {
      if (!selection) return null;
      return {
        anchorNode: selection.anchorNode,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode,
        focusOffset: selection.focusOffset,
        isCollapsed: selection.isCollapsed,
        rangeCount: selection.rangeCount,
        text: selection.toString(),
      };
    }

    rangeSnapshot() {
      const selection = this.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect?.();
        return {
          startContainer: range.startContainer,
          startOffset: range.startOffset,
          endContainer: range.endContainer,
          endOffset: range.endOffset,
          text: range.toString(),
          rect: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height } : null,
        };
      } catch { return null; }
    }

    captureRangeAnchor(textLayer, snapshot, pageRoot = null) {
      if (!textLayer || !snapshot?.text || !snapshot.startContainer || !snapshot.endContainer ||
          !textLayer.contains?.(snapshot.startContainer) || !textLayer.contains?.(snapshot.endContainer)) return null;
      const flattened = flattenTextLayer(textLayer);
      if (!flattened) return null;
      const start = this.textOffsetForPoint(flattened, snapshot.startContainer, snapshot.startOffset);
      const end = this.textOffsetForPoint(flattened, snapshot.endContainer, snapshot.endOffset);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) return null;
      const exactQuote = flattened.text.slice(start, end);
      if (!exactQuote.trim() || exactQuote.length > 4096 || exactQuote !== snapshot.text) return null;
      const startPoint = spanPointForNode(textLayer, snapshot.startContainer, snapshot.startOffset);
      const endPoint = spanPointForNode(textLayer, snapshot.endContainer, snapshot.endOffset);
      return {
        textPosition: { start, end },
        exactQuote,
        prefix: flattened.text.slice(Math.max(0, start - 96), start),
        suffix: flattened.text.slice(end, Math.min(flattened.text.length, end + 96)),
        geometry: normalizedRect(snapshot.rect, pageRoot?.getBoundingClientRect?.()),
        nativeSelection: startPoint && endPoint ? [...startPoint, ...endPoint].join(",") : null,
      };
    }

    rangeForNativeSelection(textLayer, value) {
      if (!textLayer || !this.document?.createRange || typeof value !== "string") return null;
      const match = /^(\d{1,6}),(\d{1,6}),(\d{1,6}),(\d{1,6})$/.exec(value);
      if (!match) return null;
      const [startIndex, startOffset, endIndex, endOffset] = match.slice(1).map(Number);
      const spans = textLayer.querySelectorAll?.("span");
      if (!spans || startIndex >= spans.length || endIndex >= spans.length) return null;
      const point = (span, offset) => {
        const walker = this.document.createTreeWalker?.(span, 4);
        if (!walker) return null;
        let remaining = offset;
        let last = null;
        let node;
        while ((node = walker.nextNode())) {
          last = node;
          const length = node.nodeValue?.length || 0;
          if (remaining <= length) return [node, remaining];
          remaining -= length;
        }
        return last ? [last, last.nodeValue?.length || 0] : null;
      };
      const first = point(spans[startIndex], startOffset);
      const last = point(spans[endIndex], endOffset);
      if (!first || !last) return null;
      try {
        const range = this.document.createRange();
        range.setStart(first[0], first[1]);
        range.setEnd(last[0], last[1]);
        return range;
      } catch { return null; }
    }

    textOffsetForPoint(flattened, node, offset) {
      if (!flattened || !node) return null;
      for (const entry of flattened.nodes) {
        if (entry.node === node) {
          return entry.start + Math.max(0, Math.min(entry.node.nodeValue.length, offset));
        }
      }
      if (node.nodeType !== 1 || !flattened.root?.contains?.(node)) return null;
      try {
        const prefix = this.document.createRange();
        prefix.setStart(flattened.root, 0);
        prefix.setEnd(node, Math.max(0, Math.min(node.childNodes?.length || 0, offset)));
        return prefix.toString().length;
      } catch { return null; }
    }

    rangeForAnchor(textLayer, anchor, flattenedOverride = null) {
      if (!textLayer || !this.document?.createRange) return null;
      const flattened = flattenedOverride || flattenTextLayer(textLayer);
      if (!flattened) return null;
      return anchorRange(this.document, flattened, anchor);
    }

    rangesForAnchors(textLayer, anchors) {
      return this.rangeEntriesForAnchors(textLayer, anchors).map((entry) => entry.range);
    }

    rangeEntriesForAnchors(textLayer, anchors) {
      const flattened = flattenTextLayer(textLayer);
      if (!flattened) return [];
      return (Array.isArray(anchors) ? anchors : [])
        .map((anchor, index) => ({
          anchor,
          index,
          range: this.rangeForAnchor(textLayer, anchor, flattened),
        }))
        .filter((entry) => entry.range);
    }

    selectRange(textLayer, range) {
      if (!textLayer || !range || !textLayer.contains(range.commonAncestorContainer)) return false;
      const selection = this.getSelection();
      if (!selection) return false;
      try {
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      } catch { return false; }
    }

    matchesSnapshot(selection, snapshot) {
      return !!(
        selection &&
        snapshot &&
        selection.anchorNode === snapshot.anchorNode &&
        selection.anchorOffset === snapshot.anchorOffset &&
        selection.focusNode === snapshot.focusNode &&
        selection.focusOffset === snapshot.focusOffset &&
        selection.isCollapsed === snapshot.isCollapsed &&
        selection.rangeCount === snapshot.rangeCount &&
        selection.toString() === snapshot.text
      );
    }

    caretPosition(clientX, clientY, textLayer) {
      let position = null;
      try {
        position = this.document.caretPositionFromPoint?.(clientX, clientY) || null;
      } catch {
        // Some embedded WebKit versions expose but reject caretPositionFromPoint.
      }
      if (!position) {
        try {
          position = this.document.caretRangeFromPoint?.(clientX, clientY) || null;
        } catch {
          // Ignore an unsupported or unavailable browser caret query.
        }
      }
      const node = position?.offsetNode || position?.startContainer || null;
      const offset = position?.offset ?? position?.startOffset;
      if (!node || !Number.isInteger(offset) || !textLayer?.contains(node)) {
        return null;
      }
      return { node, offset };
    }

    begin(pointer, intent, { eligible } = {}) {
      const { textLayer, textSpan, page } = this.resolveTarget(intent);
      const { x: clientX, y: clientY } = intent.clientPoint;
      pointer.textLayer = textLayer;
      pointer.textSpan = textSpan;
      pointer.page = page;
      pointer.selectionAtDown = this.snapshot();
      if (!eligible || !textLayer || !page) return false;
      this.pendingPointer = pointer;
      const caret = this.caretPosition(clientX, clientY, textLayer);
      if (
        !textSpan ||
        !textLayer.contains(textSpan) ||
        !caret ||
        !(textSpan === caret.node || textSpan.contains(caret.node)) ||
        pointer.selectionAtDown?.isCollapsed !== true ||
        !intent.trusted
      ) {
        return false;
      }
      pointer.textSelectionStart = caret;
      pointer.penTextSelectionCandidate = true;
      pointer.penTextSelectionGesture = true;
      return true;
    }

    extend(pointer, intent) {
      if (
        !pointer?.penTextSelectionCandidate ||
        !this.isPending(pointer) ||
        !pointer.moved ||
        !this.isSessionCurrent(pointer) ||
        !pointer.textLayer?.isConnected ||
        !pointer.textSelectionStart
      ) {
        return false;
      }
      const endpoint = this.caretPosition(
        intent?.clientPoint?.x,
        intent?.clientPoint?.y,
        pointer.textLayer,
      );
      if (!endpoint) return false;
      const selection = this.getSelection();
      if (typeof selection?.setBaseAndExtent !== "function") return false;
      if (pointer.ownedPenTextSelection) {
        if (!this.matchesSnapshot(selection, pointer.ownedPenTextSelection)) {
          pointer.ownedPenTextSelection = null;
          pointer.penTextSelectionCandidate = false;
          pointer.penTextSelectionOwnershipLost = true;
          return false;
        }
      } else if (
        !pointer.selectionAtDown?.isCollapsed ||
        !this.matchesSnapshot(selection, pointer.selectionAtDown)
      ) {
        // A range created by the browser or another user action takes priority.
        pointer.penTextSelectionCandidate = false;
        return false;
      }
      if (!pointer.textLayer.contains(pointer.textSelectionStart.node)) {
        pointer.penTextSelectionCandidate = false;
        return false;
      }
      try {
        selection.setBaseAndExtent(
          pointer.textSelectionStart.node,
          pointer.textSelectionStart.offset,
          endpoint.node,
          endpoint.offset,
        );
      } catch {
        return false;
      }
      pointer.ownedPenTextSelection = this.snapshot(selection);
      return true;
    }

    clearOwned(pointer) {
      const owned = pointer?.ownedPenTextSelection;
      if (owned) {
        const selection = this.getSelection();
        if (this.matchesSnapshot(selection, owned)) selection.removeAllRanges();
      }
      pointer.ownedPenTextSelection = null;
      this.clearPending(pointer);
    }

    changedSinceBegin(pointer) {
      const initial = pointer?.selectionAtDown;
      const selection = this.getSelection();
      return !!(
        selection &&
        initial &&
        (initial.anchorNode !== selection.anchorNode ||
          initial.anchorOffset !== selection.anchorOffset ||
          initial.focusNode !== selection.focusNode ||
          initial.focusOffset !== selection.focusOffset ||
          initial.isCollapsed !== selection.isCollapsed ||
          initial.text !== selection.toString())
      );
    }

    hasValidHighlightSelection(pointer) {
      const selection = this.getSelection();
      const textLayer = pointer?.textLayer;
      return !!(
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        !!selection.toString() &&
        (!pointer.ownedPenTextSelection ||
          this.matchesSnapshot(selection, pointer.ownedPenTextSelection)) &&
        this.changedSinceBegin(pointer) &&
        textLayer?.isConnected &&
        textLayer.closest(".page") === pointer.page &&
        pointer.page?.contains(textLayer) &&
        textLayer.contains(selection.anchorNode) &&
        textLayer.contains(selection.focusNode) &&
        Array.from({ length: selection.rangeCount }, (_, index) =>
          textLayer.contains(selection.getRangeAt(index).commonAncestorContainer),
        ).every(Boolean)
      );
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { TextSelectionController },
  );
})();
