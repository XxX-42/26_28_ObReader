(() => {
  "use strict";

  class IOSInputPolicy {
    constructor({
      documentRef = document,
      isAnnotationToolActive = () => false,
      hasActivePenEditorGesture = () => false,
      stopNativeScroll = () => {},
    } = {}) {
      this.documentRef = documentRef;
      this.isAnnotationToolActive = isAnnotationToolActive;
      this.hasActivePenEditorGesture = hasActivePenEditorGesture;
      this.stopNativeScroll = stopNativeScroll;
      this.fingerTextSelectionSuppressionOwned = false;
      this.lastTouchPanClickTarget = null;
      this.lastPenPanClickTarget = null;
      this.readPenSelectionPointers = new Map();
    }

    route(intent, forwardExistingBehavior, controls) {
      // The existing iPad event behavior remains the compatibility target in
      // this extraction-only stage; subsequent phases move its ownership here.
      if (intent?.type === "pointerdown" &&
          intent.pointerType === "pen" &&
          !intent.nativeContextTarget &&
          ((["viewer", "text-layer", "annotation-layer"].includes(intent.targetRole) &&
            (this.isAnnotationToolActive() || intent.nativeOperation != null)) ||
            intent.targetRegion === "editor-mode-buttons" ||
            intent.nativeActivationTarget === true)) {
        this.stopNativeScroll();
      }
      if (this.updateReadPenSelectionSuppression(intent, controls)) return false;
      if (intent?.type === "touchstart") this.handleTouchStart(intent, controls);
      if (intent?.type === "touchmove") this.handleTouchMove(intent, controls);
      return forwardExistingBehavior(intent);
    }

    updateReadPenSelectionSuppression(intent, controls) {
      if (
        intent?.type === "pointerdown" &&
        intent.pointerType === "pen" &&
        !intent.nativeContextTarget &&
        ["viewer", "text-layer", "annotation-layer"].includes(intent.targetRole) &&
        !this.isAnnotationToolActive() &&
        intent.nativeOperation == null
      ) {
        this.readPenSelectionPointers.set(intent.pointerId, {
          page: Number.isInteger(intent.pageIndex) ? intent.pageIndex : null,
          x: intent.clientPoint?.x,
          y: intent.clientPoint?.y,
          moved: false,
          ending: false,
        });
        this.documentRef?.documentElement?.classList?.add(
          "pdfReaderReadPenTextSelectionSuppressed",
        );
        return false;
      }
      const readPen = this.readPenSelectionPointers.get(intent?.pointerId);
      if (readPen && intent?.type === "pointermove") {
        readPen.moved ||= Math.hypot(
          (intent.clientPoint?.x ?? readPen.x) - readPen.x,
          (intent.clientPoint?.y ?? readPen.y) - readPen.y,
        ) > 3;
        return false;
      }
      if (readPen && ["pointerup", "pointercancel", "lostpointercapture"].includes(intent?.type)) {
        readPen.ending = true;
        if (intent.type === "pointercancel" || intent.type === "lostpointercapture") {
          this.readPenSelectionPointers.delete(intent.pointerId);
          this.releaseReadPenSelectionClassSoon();
        } else {
          this.releaseReadPenSelectionClassSoon();
          const view = this.documentRef?.defaultView;
          view?.setTimeout?.(() => {
            if (this.readPenSelectionPointers.get(intent.pointerId) === readPen) {
              this.readPenSelectionPointers.delete(intent.pointerId);
              this.releaseReadPenSelectionClassSoon();
            }
          }, 700);
        }
        return false;
      }

      if (["mousedown", "mousemove", "mouseup"].includes(intent?.type) &&
          this.readPenSelectionPointers.size) {
        // PointerEvents remain browser-owned for native WebKit scrolling.
        // Suppress only the compatibility mouse stream that PDF.js would
        // otherwise interpret as a second selection/editor gesture.
        controls?.stopImmediatePropagation?.();
        return true;
      }
      if (intent?.type === "click" && this.readPenSelectionPointers.size) {
        const pending = [...this.readPenSelectionPointers.values()].find((entry) => entry.ending);
        if (pending?.moved) this.rememberPanClickTarget("pen", pending.page);
        for (const [pointerId, entry] of this.readPenSelectionPointers) {
          if (entry.ending) this.readPenSelectionPointers.delete(pointerId);
        }
        if (!this.readPenSelectionPointers.size) this.releaseReadPenSelectionClassSoon();
        return false;
      }
      if (!readPen) return false;
      return false;
    }

    releaseReadPenSelectionClassSoon() {
      // Keep the selection guard through the pointerup default action, then
      // release it. This does not cancel the browser-owned scroll gesture.
      const view = this.documentRef?.defaultView;
      const clear = () => {
        const activeContact = [...this.readPenSelectionPointers.values()].some(
          (contact) => !contact.ending,
        );
        if (!activeContact) {
          this.documentRef?.documentElement?.classList?.remove(
            "pdfReaderReadPenTextSelectionSuppressed",
          );
        }
      };
      if (typeof view?.setTimeout === "function") view.setTimeout(clear, 0);
      else clear();
    }

    clearReadPenSelectionSuppression() {
      this.readPenSelectionPointers.clear();
      this.documentRef?.documentElement?.classList?.remove(
        "pdfReaderReadPenTextSelectionSuppressed",
      );
    }

    onToolChange() {
      if (this.isAnnotationToolActive()) this.stopNativeScroll();
    }

    setFingerTextSelectionSuppressionOwned(owned) {
      this.fingerTextSelectionSuppressionOwned = owned === true;
      return this.refreshFingerTextSelectionSuppression();
    }

    isFingerTextSelectionSuppressionActive() {
      return this.fingerTextSelectionSuppressionOwned &&
        this.isAnnotationToolActive();
    }

    refreshFingerTextSelectionSuppression() {
      const active = this.isFingerTextSelectionSuppressionActive();
      this.documentRef?.documentElement?.classList?.toggle(
        "pdfReaderFingerTextSelectionSuppressed",
        active,
      );
      return active;
    }

    clearFingerTextSelectionSuppression() {
      return this.setFingerTextSelectionSuppressionOwned(false);
    }

    handleTextSelectionGuard(intent, controls) {
      if (
        !this.isFingerTextSelectionSuppressionActive() ||
        intent?.targetRole !== "text-layer"
      ) {
        return false;
      }
      controls?.preventDefault?.();
      return true;
    }

    isEditingStylusContact(intent) {
      return intent?.touchHasStylus === true && (
        this.isAnnotationToolActive() || intent.nativeOperation != null
      );
    }

    handleTouchStart(intent, controls) {
      if (
        intent?.nativeContextTarget === true ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent?.targetRole)
      ) {
        return false;
      }
      if (!this.hasActivePenEditorGesture() && !this.isEditingStylusContact(intent)) return false;
      // WebKit decides touch-action before pointerdown, so keep the legacy
      // Pencil-only cancellation while finger/read-mode Pencil stay native.
      this.stopNativeScroll();
      controls?.preventDefault?.();
      return true;
    }

    handleTouchMove(intent, controls) {
      if (
        intent?.nativeContextTarget === true ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent?.targetRole) ||
        (!this.hasActivePenEditorGesture() && !this.isEditingStylusContact(intent))
      ) {
        return false;
      }
      // Keep ownership across WebKit touch/pointer event ordering and
      // pointercancel; an editing Pencil must not turn into native page pan.
      controls?.preventDefault?.();
      return true;
    }

    refreshPenGestureTouchAction() {
      const active = this.hasActivePenEditorGesture();
      this.documentRef?.documentElement?.classList?.toggle(
        "pdfReaderPenGestureActive",
        active,
      );
      return active;
    }

    rememberPanClickTarget(pointerType, target) {
      if (pointerType === "touch") {
        this.lastTouchPanClickTarget = target ?? null;
      } else if (pointerType === "pen") {
        this.lastPenPanClickTarget = target ?? null;
      }
    }

    clearPanClickTargets() {
      this.lastTouchPanClickTarget = null;
      this.lastPenPanClickTarget = null;
    }

    handlePanClick(intent, controls, { doubleClick = false } = {}) {
      if (
        intent?.nativeContextTarget === true ||
        intent?.nativeActivationTarget === true ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent?.targetRole) ||
        (doubleClick && intent?.detail < 2)
      ) {
        return false;
      }
      const page = Number.isInteger(intent?.pageIndex)
        ? intent.pageIndex
        : `role:${intent?.targetRole}`;
      const matchesPage = (previousPage) =>
        previousPage !== null && previousPage !== undefined &&
        (page === null || page === previousPage);
      let suppress = false;
      if (doubleClick) {
        suppress = matchesPage(this.lastTouchPanClickTarget) ||
          matchesPage(this.lastPenPanClickTarget);
      } else {
        const touchClick = intent.pointerType === "touch" || (
          intent.detail > 0 && matchesPage(this.lastTouchPanClickTarget)
        );
        const completedPenPan = intent.detail > 0 &&
          matchesPage(this.lastPenPanClickTarget);
        suppress = touchClick || completedPenPan;
      }
      if (suppress) {
        controls?.preventDefault?.();
        controls?.stopImmediatePropagation?.();
      }
      return suppress;
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { IOSInputPolicy },
  );
})();
