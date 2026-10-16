(() => {
  "use strict";

  class IOSDirectManipulationController {
    constructor({
      getInputRouter,
      getViewportController,
      getInputPolicy,
      getViewerContainer,
      getCurrentSession,
      getEditorMode,
      isEraserActive,
      isAnnotationToolActive,
      getNativeOperation,
      isViewerSurfaceTarget,
      isNativeContextTarget,
      directManipulationPage,
      invalidatePendingPenHighlight,
    }) {
      this.getInputRouter = getInputRouter;
      this.getViewportController = getViewportController;
      this.getInputPolicy = getInputPolicy;
      this.getViewerContainer = getViewerContainer;
      this.getCurrentSession = getCurrentSession;
      this.getEditorMode = getEditorMode;
      this.isEraserActive = isEraserActive;
      this.isAnnotationToolActive = isAnnotationToolActive;
      this.getNativeOperation = getNativeOperation;
      this.isViewerSurfaceTarget = isViewerSurfaceTarget;
      this.isNativeContextTarget = isNativeContextTarget;
      this.directManipulationPage = directManipulationPage;
      this.invalidatePendingPenHighlight = invalidatePendingPenHighlight;
    }

    router() { return this.getInputRouter?.() || null; }
    viewport() { return this.getViewportController?.() || null; }
    manualPointerCount() { return this.router()?.manualPointerCount || 0; }
    manualPointerValues() { return this.router()?.manualPointerValues() || []; }
    manualPointer(pointerId) { return this.router()?.manualPointer(pointerId) || null; }
    hasManualPointer(pointerId) { return !!this.router()?.hasManualPointer(pointerId); }
    setManualPointer(pointerId, pointer) { this.router()?.setManualPointer(pointerId, pointer); }
    deleteManualPointer(pointerId) { return this.router()?.deleteManualPointer(pointerId) || false; }
    clearManualPointers() { this.router()?.clearManualPointers(); }
    hasPointerCapture(pointerId) { return !!this.router()?.hasPointerCapture(pointerId); }
    hasActivePointer(pointerId) { return !!this.router()?.hasActivePointer(pointerId); }
    activePointerValues() { return this.router()?.activePointerValues() || []; }
    penPolicyPointerIds() { return this.router()?.penPolicyPointerIds() || []; }
    setPenPolicyPointer(pointerId, pointer) { this.router()?.setPenPolicyPointer(pointerId, pointer); }
    clearPenPolicyPointers() { this.router()?.clearPenPolicyPointers(); }
    capturePointer(pointerId, target) { return this.router()?.capturePointer(pointerId, target) || false; }
    releasePointerCapture(pointerId) { this.router()?.releasePointerCapture(pointerId); }

    hasActivePenEditorGesture() {
      return (this.router()?.penPolicyPointerCount || 0) > 0 ||
        this.activePointerValues().some((pointer) =>
          pointer.pointerType === "pen" &&
          (pointer.kind === "editor" || !!pointer.nativeOperation),
        ) || this.manualPointerValues().some((pointer) =>
          pointer.pointerType === "pen",
        );
    }

    preparePointerDown(event) {
      if (event.pointerType !== "touch") {
        this.getInputPolicy()?.clearFingerTextSelectionSuppression?.();
      } else if (
        this.manualPointerCount() > 0 &&
        !this.hasManualPointer(event.pointerId)
      ) {
        for (const pointer of this.manualPointerValues()) {
          pointer.blockedByOtherPointer = true;
          pointer.cancelledByOtherPointer = true;
          pointer.moved = false;
          pointer.lastMotionAt = null;
        }
      }
    }

    routePointerDown(event) {
      if (event.pointerType !== "touch") {
        this.getInputPolicy()?.clearPanClickTargets?.();
      }
      if (
        !this.isViewerSurfaceTarget(event.target) ||
        this.isNativeContextTarget(event.target)
      ) {
        return false;
      }
      if (event.pointerType === "touch") {
        this.startManualPointer(event, "touch");
        return true;
      }
      if (event.pointerType !== "pen") {
        return false;
      }
      const editorMode = this.getEditorMode();
      const eraserActive = this.isEraserActive();
      const nativeOperation = this.getNativeOperation(event, event.target);
      if (editorMode !== 0 || eraserActive || nativeOperation) {
        const session = this.getCurrentSession();
        this.setPenPolicyPointer(event.pointerId, {
          pointerId: event.pointerId,
          documentId: session.documentId,
          openRequest: session.openRequest,
          pdfDocument: session.pdfDocument,
          rendererGeneration: session.rendererGeneration,
        });
        this.suspendTouchPansForPen();
      } else {
        // In mode NONE, preserve native tap behavior for links while taking
        // ownership only when the Pencil contact becomes a pan.
        this.startManualPointer(event, "pen");
        return true;
      }
      return false;
    }

    suspendTouchPansForPen() {
      this.getInputPolicy()?.clearFingerTextSelectionSuppression?.();
      for (const pointer of this.manualPointerValues()) {
        if (pointer.pointerType === "touch") {
          pointer.blockedByPen = true;
          pointer.moved = false;
        }
      }
    }

    cancelMomentum() {
      this.viewport()?.cancelMomentum();
    }

    onDocumentVisibilityChange() {
      if (document.visibilityState !== "hidden") return;
      this.cancelMomentum();
      this.getInputPolicy()?.clearFingerTextSelectionSuppression?.();
      for (const pointer of this.manualPointerValues()) {
        if (pointer.pointerType === "touch") {
          pointer.blockedByVisibility = true;
          pointer.moved = false;
        }
      }
    }

    eventTime(pointer, event, now = performance.now()) {
      return this.viewport()?.eventTime(pointer, event, now) ?? now;
    }

    startManualPointer(event, pointerType) {
      const container = this.getViewerContainer();
      if (!container || this.hasManualPointer(event.pointerId)) return null;
      const anotherDirectPointer = this.manualPointerCount() > 0;
      const startTime = this.eventTime(null, event);
      if (anotherDirectPointer) {
        for (const activePointer of this.manualPointerValues()) {
          activePointer.blockedByOtherPointer = true;
          activePointer.cancelledByOtherPointer = true;
          activePointer.moved = false;
          activePointer.lastMotionAt = null;
          activePointer.scrollSamples = [{
            time: this.eventTime(activePointer, event),
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
          }];
        }
      }
      const blockedByPen = this.hasActivePenEditorGesture();
      const pointer = {
        pointerId: event.pointerId,
        pointerType,
        pageTarget: this.directManipulationPage(event.target),
        container,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        startScrollTop: container.scrollTop,
        startScrollLeft: container.scrollLeft,
        lastMotionAt: null,
        scrollSamples: [{
          time: startTime,
          scrollTop: container.scrollTop,
          scrollLeft: container.scrollLeft,
        }],
        moved: false,
        blockedByPen,
        blockedByOtherPointer: anotherDirectPointer,
        cancelledByOtherPointer: anotherDirectPointer,
        documentId: this.getCurrentSession().documentId,
        openRequest: this.getCurrentSession().openRequest,
        pdfDocument: this.getCurrentSession().pdfDocument,
        rendererGeneration: this.getCurrentSession().rendererGeneration,
      };
      this.setManualPointer(event.pointerId, pointer);
      if (pointerType === "touch") {
        if (
          !anotherDirectPointer &&
          !blockedByPen &&
          this.isAnnotationToolActive()
        ) {
          this.getInputPolicy()?.setFingerTextSelectionSuppressionOwned?.(true);
        }
        this.getInputPolicy()?.refreshFingerTextSelectionSuppression?.();
        this.getInputPolicy()?.rememberPanClickTarget?.("touch", pointer.pageTarget);
        this.capturePointer(event.pointerId, container);
        this.stopDirectManipulationEvent(event);
      } else if (pointerType === "pen") {
        // Suppress compatibility mouse selection only after this Pencil has
        // become a bridge-owned mode-NONE pan.
        event.preventDefault();
      }
      return pointer;
    }

    isManualPointerSessionCurrent(pointer) {
      const current = this.getCurrentSession();
      return !!(
        pointer &&
        current.pdfDocument === pointer.pdfDocument &&
        current.documentId === pointer.documentId &&
        current.openRequest === pointer.openRequest &&
        current.rendererGeneration === pointer.rendererGeneration &&
        pointer.container?.isConnected
      );
    }

    stopDirectManipulationEvent(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    applyPan(pointer, event, eventTime = null) {
      if (
        !pointer ||
        pointer.blockedByPen ||
        pointer.blockedByOtherPointer ||
        pointer.blockedByVisibility ||
        !this.isManualPointerSessionCurrent(pointer)
      ) {
        return;
      }
      this.viewport()?.applyPan(pointer, event, eventTime);
    }

    finishManualPointer(pointerId, event = null, { cancel = false } = {}) {
      const pointer = this.manualPointer(pointerId);
      if (!pointer) return null;
      const releaseTime = this.eventTime(pointer, event);
      if (
        pointer.pointerType === "touch" && !cancel &&
        Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
      ) {
        this.applyPan(pointer, event, releaseTime);
      }
      this.deleteManualPointer(pointerId);
      if (pointer.pointerType === "touch") {
        if (cancel || !this.isManualPointerSessionCurrent(pointer)) {
          if (
            !pointer.cancelledByOtherPointer ||
            !this.isManualPointerSessionCurrent(pointer)
          ) {
            this.getInputPolicy()?.clearFingerTextSelectionSuppression?.();
          }
          this.cancelMomentum();
        } else {
          this.viewport()?.startMomentum(pointer, releaseTime);
        }
      }
      if (
        pointer.pointerType === "pen" && pointer.moved && !cancel &&
        this.isManualPointerSessionCurrent(pointer)
      ) {
        this.getInputPolicy()?.rememberPanClickTarget?.("pen", pointer.pageTarget);
      }
      this.releasePointerCapture(pointerId);
      return pointer;
    }

    clearSessions({ clearClickTargets = true } = {}) {
      this.cancelMomentum();
      this.getInputPolicy()?.clearFingerTextSelectionSuppression?.();
      this.invalidatePendingPenHighlight?.();
      const pointers = this.manualPointerValues();
      this.clearManualPointers();
      for (const pointer of pointers) this.releasePointerCapture(pointer.pointerId);
      this.clearPenPolicyPointers();
      if (clearClickTargets) this.getInputPolicy()?.clearPanClickTargets?.();
    }

    handlePointerMove(event) {
      const manualPointer = this.manualPointer(event.pointerId);
      if (!manualPointer) return false;
      if (manualPointer.pointerType === "touch") {
        this.stopDirectManipulationEvent(event);
        this.applyPan(manualPointer, event);
      } else {
        this.applyPan(manualPointer, event);
        if (manualPointer.moved && !manualPointer.blockedByPen) {
          event.preventDefault();
        }
      }
      return true;
    }

    handlePointerEnd(event) {
      const manualPointer = this.manualPointer(event.pointerId);
      if (!manualPointer) return false;
      const pointer = this.finishManualPointer(event.pointerId, event, {
        cancel: event.type === "pointercancel",
      });
      if (pointer?.pointerType === "touch") this.stopDirectManipulationEvent(event);
      return true;
    }

    handlePointerOut(event) {
      const manualPointer = this.manualPointer(event.pointerId);
      if (!manualPointer) return false;
      if (event.relatedTarget !== null || this.hasPointerCapture(event.pointerId)) {
        return true;
      }
      const pointer = this.finishManualPointer(event.pointerId, event, { cancel: true });
      if (pointer?.pointerType === "touch") this.stopDirectManipulationEvent(event);
      return true;
    }

    handleLostPointerCapture(event) {
      const manualPointer = this.manualPointer(event.pointerId);
      if (!manualPointer) return false;
      const pointer = this.finishManualPointer(event.pointerId, event, { cancel: true });
      if (pointer?.pointerType === "touch") this.stopDirectManipulationEvent(event);
      return true;
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { IOSDirectManipulationController },
  );
})();
