(() => {
  "use strict";

  class TextSelectionController {
    constructor({
      documentRef = document,
      isSessionCurrent = () => true,
      isPendingPointer = () => true,
    } = {}) {
      this.document = documentRef;
      this.isSessionCurrent = isSessionCurrent;
      this.isPendingPointer = isPendingPointer;
    }

    getSelection() {
      return this.document.getSelection();
    }

    resolveTarget(target) {
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      const textLayer = element?.closest?.(".textLayer") || null;
      return {
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

    begin(pointer, {
      textLayer,
      textSpan,
      page,
      clientX,
      clientY,
      isTrusted,
      eligible,
    }) {
      pointer.textLayer = textLayer;
      pointer.textSpan = textSpan;
      pointer.page = page;
      pointer.selectionAtDown = this.snapshot();
      if (!eligible || !textLayer || !page) return false;
      const caret = this.caretPosition(clientX, clientY, textLayer);
      if (
        !textSpan ||
        !textLayer.contains(textSpan) ||
        !caret ||
        !(textSpan === caret.node || textSpan.contains(caret.node)) ||
        pointer.selectionAtDown?.isCollapsed !== true ||
        !isTrusted
      ) {
        return false;
      }
      pointer.textSelectionStart = caret;
      pointer.penTextSelectionCandidate = true;
      pointer.penTextSelectionGesture = true;
      return true;
    }

    extend(pointer, { clientX, clientY }) {
      if (
        !pointer?.penTextSelectionCandidate ||
        !this.isPendingPointer(pointer) ||
        !pointer.moved ||
        !this.isSessionCurrent(pointer) ||
        !pointer.textLayer?.isConnected ||
        !pointer.textSelectionStart
      ) {
        return false;
      }
      const endpoint = this.caretPosition(clientX, clientY, pointer.textLayer);
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
      if (!owned) return;
      const selection = this.getSelection();
      if (this.matchesSnapshot(selection, owned)) selection.removeAllRanges();
      pointer.ownedPenTextSelection = null;
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
