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
      this.invalidatePendingPenHighlight = invalidatePendingPenHighlight;
      this._nativeTouchPointers = new Map();
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
          (pointer.kind === "editor" || pointer.kind === "text-selection" ||
            !!pointer.nativeOperation),
        ) || this.manualPointerValues().some((pointer) =>
          pointer.pointerType === "pen",
        );
    }

    preparePointerDown(intent) {
      if (intent.pointerType !== "touch") {
        this.getInputPolicy()?.clearFingerTextSelectionSuppression?.();
      } else if (
        this.manualPointerCount() > 0 &&
        !this.hasManualPointer(intent.pointerId)
      ) {
        for (const pointer of this.manualPointerValues()) {
          pointer.blockedByOtherPointer = true;
          pointer.cancelledByOtherPointer = true;
          pointer.moved = false;
          pointer.lastMotionAt = null;
        }
      }
    }

    routePointerDown(intent, controls, { nativeOperationActive = false } = {}) {
      if (intent.pointerType !== "touch") {
        this.getInputPolicy()?.clearPanClickTargets?.();
      }
      if (
        intent.nativeContextTarget === true ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent.targetRole)
      ) {
        return false;
      }
      if (intent.pointerType === "touch") {
        this.startNativeTouchPointer(intent, controls);
        return true;
      }
      if (intent.pointerType !== "pen") {
        return false;
      }
      const editorMode = this.getEditorMode();
      const eraserActive = this.isEraserActive();
      if (editorMode !== 0 || eraserActive || nativeOperationActive) {
        const session = this.getCurrentSession();
        this.setPenPolicyPointer(intent.pointerId, {
          pointerId: intent.pointerId,
          documentId: session.documentId,
          openRequest: session.openRequest,
          pdfDocument: session.pdfDocument,
          rendererGeneration: session.rendererGeneration,
        });
        this.suspendTouchPansForPen();
      } else {
        // Read-mode Pencil uses WebKit's native scroll and activation path.
        return true;
      }
      return false;
    }

    startNativeTouchPointer(intent, controls) {
      if (this._nativeTouchPointers.has(intent.pointerId)) return;
      const page = this.pageIdentity(intent);
      this._nativeTouchPointers.set(intent.pointerId, {
        pointerId: intent.pointerId,
        pageTarget: page,
        startX: intent.clientPoint.x,
        startY: intent.clientPoint.y,
        moved: false,
      });
      const inputPolicy = this.getInputPolicy();
      inputPolicy?.rememberPanClickTarget?.("touch", page);
      if (!this.hasActivePenEditorGesture() && this.isAnnotationToolActive()) {
        inputPolicy?.setFingerTextSelectionSuppressionOwned?.(true);
        inputPolicy?.refreshFingerTextSelectionSuppression?.();
      }
      // Keep PDF.js from treating a finger contact as an editor gesture while
      // leaving the browser's native scrolling default intact.
      controls?.stopImmediatePropagation?.();
    }

    clearNativeTouchPointer(pointerId) {
      if (!this._nativeTouchPointers.delete(pointerId)) return false;
      if (
        this._nativeTouchPointers.size === 0 &&
        !this.hasActivePenEditorGesture()
      ) {
        this.getInputPolicy()?.clearFingerTextSelectionSuppression?.();
      }
      return true;
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

    eventTime(pointer, intent, now = performance.now()) {
      return this.viewport()?.eventTime(pointer, this.pointerSample(intent), now) ?? now;
    }

    pointerSample(intent) {
      return {
        clientX: intent?.clientPoint?.x,
        clientY: intent?.clientPoint?.y,
        timeStamp: intent?.timestamp,
      };
    }

    pageIdentity(intent) {
      return Number.isInteger(intent?.pageIndex)
        ? intent.pageIndex
        : `role:${intent?.targetRole || "unknown"}`;
    }

    startManualPointer(intent, pointerType, controls) {
      const container = this.getViewerContainer();
      if (!container || this.hasManualPointer(intent.pointerId)) return null;
      const anotherDirectPointer = this.manualPointerCount() > 0;
      const startTime = this.eventTime(null, intent);
      if (anotherDirectPointer) {
        for (const activePointer of this.manualPointerValues()) {
          activePointer.blockedByOtherPointer = true;
          activePointer.cancelledByOtherPointer = true;
          activePointer.moved = false;
          activePointer.lastMotionAt = null;
          activePointer.scrollSamples = [{
            time: this.eventTime(activePointer, intent),
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
          }];
        }
      }
      const blockedByPen = this.hasActivePenEditorGesture();
      const pointer = {
        pointerId: intent.pointerId,
        pointerType,
        pageTarget: this.pageIdentity(intent),
        container,
        startX: intent.clientPoint.x,
        startY: intent.clientPoint.y,
        lastX: intent.clientPoint.x,
        lastY: intent.clientPoint.y,
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
      this.setManualPointer(intent.pointerId, pointer);
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
        this.capturePointer(intent.pointerId, container);
        this.stopDirectManipulationEvent(controls);
      } else if (pointerType === "pen") {
        // Suppress compatibility mouse selection only after this Pencil has
        // become a bridge-owned mode-NONE pan.
        controls?.preventDefault?.();
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

    stopDirectManipulationEvent(controls) {
      controls?.preventDefault?.();
      controls?.stopImmediatePropagation?.();
    }

    applyPan(pointer, intent, eventTime = null) {
      if (
        !pointer ||
        pointer.blockedByPen ||
        pointer.blockedByOtherPointer ||
        pointer.blockedByVisibility ||
        !this.isManualPointerSessionCurrent(pointer)
      ) {
        return;
      }
      this.viewport()?.applyPan(pointer, this.pointerSample(intent), eventTime);
    }

    finishManualPointer(pointerId, intent = null, { cancel = false } = {}) {
      const pointer = this.manualPointer(pointerId);
      if (!pointer) return null;
      const releaseTime = this.eventTime(pointer, intent);
      if (
        pointer.pointerType === "touch" && !cancel &&
        Number.isFinite(intent?.clientPoint?.x) && Number.isFinite(intent?.clientPoint?.y)
      ) {
        this.applyPan(pointer, intent, releaseTime);
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
      this._nativeTouchPointers.clear();
      for (const pointer of pointers) this.releasePointerCapture(pointer.pointerId);
      this.clearPenPolicyPointers();
      if (clearClickTargets) this.getInputPolicy()?.clearPanClickTargets?.();
    }

    handlePointerMove(intent, controls) {
      const nativeTouch = this._nativeTouchPointers.get(intent.pointerId);
      if (nativeTouch) {
        nativeTouch.moved ||= Math.hypot(
          intent.clientPoint.x - nativeTouch.startX,
          intent.clientPoint.y - nativeTouch.startY,
        ) > 1;
        controls?.stopImmediatePropagation?.();
        return true;
      }
      const manualPointer = this.manualPointer(intent.pointerId);
      if (!manualPointer) return false;
      if (manualPointer.pointerType === "touch") {
        this.stopDirectManipulationEvent(controls);
        this.applyPan(manualPointer, intent);
      } else {
        this.applyPan(manualPointer, intent);
        if (manualPointer.moved && !manualPointer.blockedByPen) {
          controls?.preventDefault?.();
        }
      }
      return true;
    }

    handlePointerEnd(intent, controls) {
      if (this.clearNativeTouchPointer(intent.pointerId)) {
        controls?.stopImmediatePropagation?.();
        return true;
      }
      const manualPointer = this.manualPointer(intent.pointerId);
      if (!manualPointer) return false;
      const pointer = this.finishManualPointer(intent.pointerId, intent, {
        cancel: intent.type === "pointercancel",
      });
      if (pointer?.pointerType === "touch") this.stopDirectManipulationEvent(controls);
      return true;
    }

    handlePointerOut(intent, controls) {
      if (this._nativeTouchPointers.has(intent.pointerId)) {
        if (!intent.relatedTargetPresent) {
          this.clearNativeTouchPointer(intent.pointerId);
          controls?.stopImmediatePropagation?.();
        }
        return true;
      }
      const manualPointer = this.manualPointer(intent.pointerId);
      if (!manualPointer) return false;
      if (intent.relatedTargetPresent || this.hasPointerCapture(intent.pointerId)) {
        return true;
      }
      const pointer = this.finishManualPointer(intent.pointerId, intent, { cancel: true });
      if (pointer?.pointerType === "touch") this.stopDirectManipulationEvent(controls);
      return true;
    }

    handleLostPointerCapture(intent, controls) {
      if (this.clearNativeTouchPointer(intent.pointerId)) {
        controls?.stopImmediatePropagation?.();
        return true;
      }
      const manualPointer = this.manualPointer(intent.pointerId);
      if (!manualPointer) return false;
      const pointer = this.finishManualPointer(intent.pointerId, intent, { cancel: true });
      if (pointer?.pointerType === "touch") this.stopDirectManipulationEvent(controls);
      return true;
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { IOSDirectManipulationController },
  );
})();
