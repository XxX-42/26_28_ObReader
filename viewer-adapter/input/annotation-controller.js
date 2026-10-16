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

    async deleteEditors(editors, {
      onDelete = null,
      onRestore = null,
      isCurrent = null,
    } = {}) {
      const manager = this.getManager();
      const targets = [...new Set(editors || [])].filter((editor) =>
        editor && editor.deleted !== true && !editor.isEmpty?.(),
      );
      if (!manager || !targets.length) return 0;
      if (
        typeof manager.setSelected === "function" &&
        typeof manager.toggleSelected === "function" &&
        typeof manager.delete === "function" &&
        typeof manager.addCommands === "function"
      ) {
        const toolbarsReady = await Promise.all(targets.map((editor) =>
          this.waitForDeleteToolbar(editor),
        ));
        if (toolbarsReady.some((ready) => !ready) ||
            (typeof isCurrent === "function" && !isCurrent())) return 0;
        manager.setSelected(targets[0]);
        for (const editor of targets.slice(1)) manager.toggleSelected(editor);
        // Let callers attach owner-managed effects to the same PDF.js history
        // command. This keeps one user action as one undo/redo step while the
        // controller remains unaware of persistence details.
        const originalAddCommands = manager.addCommands;
        let commandCaptured = false;
        let firstExecution = true;
        manager.addCommands = function (params) {
          if (!commandCaptured && params?.mustExec === true) {
            commandCaptured = true;
            const originalCommand = params.cmd;
            const originalUndo = params.undo;
            params = {
              ...params,
              cmd() {
                if (typeof isCurrent === "function" && !isCurrent()) return;
                originalCommand?.();
                if (typeof isCurrent === "function" && !isCurrent()) return;
                onDelete?.({ redo: !firstExecution });
                firstExecution = false;
              },
              undo() {
                if (typeof isCurrent === "function" && !isCurrent()) return;
                originalUndo?.();
                if (typeof isCurrent === "function" && !isCurrent()) return;
                onRestore?.();
              },
            };
          }
          return originalAddCommands.call(manager, params);
        };
        try {
          manager.delete();
        } finally {
          manager.addCommands = originalAddCommands;
        }
        if (!commandCaptured) return 0;
        return targets.length;
      }
      if (onDelete || onRestore) return 0;
      if (typeof manager.deleteEditor !== "function") return 0;
      for (const editor of targets) manager.deleteEditor(editor);
      return targets.length;
    }

    async waitForDeleteToolbar(editor) {
      if (typeof editor?.addEditToolbar !== "function") return true;
      try {
        // Start construction before manager.delete() selects and immediately
        // removes the editor. PDF.js builds some toolbar buttons asynchronously.
        await editor.addEditToolbar();
      } catch {
        return false;
      }
      const isReady = () => Boolean(
        editor?._editToolbar?.div?.querySelector?.(".deleteButton"),
      );
      if (isReady()) return true;
      if (typeof MutationObserver !== "function" || !editor?.div) return false;
      return new Promise((resolve) => {
        let finished = false;
        let observer = null;
        const timeout = setTimeout(() => finish(false), 3000);
        const finish = (ready) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          observer?.disconnect();
          resolve(ready);
        };
        observer = new MutationObserver(() => {
          if (isReady()) finish(true);
        });
        observer.observe(editor.div, { childList: true, subtree: true });
        if (isReady()) finish(true);
      });
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
