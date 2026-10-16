(() => {
  "use strict";

  class AnnotationController {
    constructor({
      getManager = () => null,
      getPdfViewer = () => null,
      getEraser = () => null,
      getEditorMode = () => 0,
      getPdfViewerMode = () => 0,
      isPointerSessionCurrent = () => true,
      isTextSelectionValid = () => false,
      hasOtherActivePenPointer = () => false,
      isClosingOrDisposed = () => false,
      isPendingHighlight = () => false,
      clearPendingHighlight = () => {},
      clearToolWheel = () => {},
      onTransformCancel = () => {},
    } = {}) {
      this.getManager = getManager;
      this.getPdfViewer = getPdfViewer;
      this.getEraser = getEraser;
      this.getEditorMode = getEditorMode;
      this.getPdfViewerMode = getPdfViewerMode;
      this.isPointerSessionCurrent = isPointerSessionCurrent;
      this.isTextSelectionValid = isTextSelectionValid;
      this.hasOtherActivePenPointer = hasOtherActivePenPointer;
      this.isClosingOrDisposed = isClosingOrDisposed;
      this.isPendingHighlight = isPendingHighlight;
      this.clearPendingHighlight = clearPendingHighlight;
      this.clearToolWheel = clearToolWheel;
      this.onTransformCancel = onTransformCancel;
    }

    pointerInteractionKind(intent, {
      interactionMode = "READ",
    } = {}) {
      if (intent.button === 0) {
        if (intent.targetRole === "annotation-layer") return "editor";
        if (
          window.PdfReaderInputRuntime.InteractionMode.isTextSelectionMode(
            interactionMode,
          ) && intent.targetRole === "text-layer"
        ) {
          return "text-selection";
        }
        return null;
      }
      if (
        intent.pointerType !== "mouse" ||
        intent.nativeContextTarget === true ||
        ["text-control", "native-control", "outside-viewer"].includes(intent.targetRole) ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent.targetRole)
      ) {
        return null;
      }
      if (intent.button === 1) return "tool-wheel";
      if (intent.button === 2) return "right-eraser";
      return null;
    }

    nativeOperation(intent) {
      if (intent.button !== 0 || !["mouse", "pen"].includes(intent.pointerType)) {
        return null;
      }
      return ["move", "resize"].includes(intent.nativeOperation)
        ? intent.nativeOperation
        : null;
    }

    preparePenHighlight(pointer, { textLayer, page }) {
      if (!textLayer || !page) return false;
      const pageIndex = Number(page.dataset?.pageNumber) - 1;
      const pageView = Number.isInteger(pageIndex) && pageIndex >= 0
        ? this.getPdfViewer()?.getPageView?.(pageIndex)
        : null;
      pointer.pageEditorLayerBuilder = pageView?.annotationEditorLayer || null;
      pointer.pageEditorLayer =
        pointer.pageEditorLayerBuilder?.annotationEditorLayer || null;
      pointer.highlightManager = this.getManager();
      return !!(pointer.pageEditorLayer && pointer.highlightManager);
    }

    finishPenHighlight(pointer) {
      if (!this.isPendingHighlight(pointer)) return false;
      this.clearPendingHighlight();
      const manager = this.getManager();
      const pdfViewer = this.getPdfViewer();
      const pageIndex = Number(pointer.page?.dataset?.pageNumber) - 1;
      const pageView = Number.isInteger(pageIndex) && pageIndex >= 0
        ? pdfViewer?.getPageView?.(pageIndex)
        : null;
      const pageEditorLayerBuilder = pageView?.annotationEditorLayer;
      if (
        !pointer.ending ||
        pointer.kind !== "text-selection" ||
        pointer.pointerType !== "pen" ||
        pointer.button !== 0 ||
        pointer.mode !== 9 ||
        !pointer.moved ||
        pointer.penTextSelectionOwnershipLost ||
        !this.isPointerSessionCurrent(pointer) ||
        this.getEditorMode() !== 9 ||
        this.getPdfViewerMode() !== 9 ||
        manager !== pointer.highlightManager ||
        manager?.getMode?.() !== 9 ||
        !manager.currentLayer ||
        manager.getLayer?.(pageIndex) !== pointer.pageEditorLayer ||
        pageEditorLayerBuilder !== pointer.pageEditorLayerBuilder ||
        pageEditorLayerBuilder?.annotationEditorLayer !== pointer.pageEditorLayer ||
        pageEditorLayerBuilder?.div !== pointer.pageEditorLayer?.div ||
        !pointer.pageEditorLayer?.div?.isConnected ||
        !pointer.page?.contains(pointer.pageEditorLayer.div) ||
        !pointer.pageEditorLayer.hasTextLayer?.(pointer.textLayer) ||
        typeof manager?.highlightSelection !== "function" ||
        !this.isTextSelectionValid(pointer) ||
        this.hasOtherActivePenPointer(pointer) ||
        this.isClosingOrDisposed()
      ) {
        return false;
      }
      manager.highlightSelection("main_toolbar");
      return true;
    }

    cancelPointerSession(pointer) {
      if (!this.isPointerSessionCurrent(pointer)) return false;
      if (pointer.button === 1) {
        this.clearToolWheel(pointer.pointerId);
        return true;
      }
      if (pointer.button === 2) {
        this.getEraser()?.cancelTemporaryStroke?.();
        return true;
      }
      if (pointer.button === 0 && [5, 15].includes(pointer.mode)) {
        this.getManager()?.currentLayer?.endDrawingSession?.(true);
      }
      if (
        pointer.button === 0 &&
        ["mouse", "pen"].includes(pointer.pointerType) &&
        ["move", "resize"].includes(pointer.nativeOperation) &&
        !pointer.internalCancelScheduled
      ) {
        pointer.internalCancelScheduled = true;
        this.onTransformCancel(pointer);
      }
      return true;
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { AnnotationController },
  );
})();
