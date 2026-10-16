(() => {
  "use strict";

  class IOSInputPolicy {
    constructor({
      documentRef = document,
      isAnnotationToolActive = () => false,
      hasActivePenEditorGesture = () => false,
    } = {}) {
      this.documentRef = documentRef;
      this.isAnnotationToolActive = isAnnotationToolActive;
      this.hasActivePenEditorGesture = hasActivePenEditorGesture;
      this.fingerTextSelectionSuppressionOwned = false;
      this.lastTouchPanClickTarget = null;
      this.lastPenPanClickTarget = null;
    }

    route(intent, forwardExistingBehavior, controls) {
      // The existing iPad event behavior remains the compatibility target in
      // this extraction-only stage; subsequent phases move its ownership here.
      if (intent?.type === "touchstart") this.handleTouchStart(intent, controls);
      if (intent?.type === "touchmove") this.handleTouchMove(intent, controls);
      return forwardExistingBehavior(intent);
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

    handleTouchStart(intent, controls) {
      if (
        intent?.nativeContextTarget === true ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent?.targetRole)
      ) {
        return false;
      }
      const activeEditorStylus = intent.touchHasStylus === true && (
        this.isAnnotationToolActive() || intent.nativeOperation != null
      );
      if (!this.hasActivePenEditorGesture() && !activeEditorStylus) return false;
      // WebKit decides touch-action before pointerdown, so keep the legacy
      // Pencil-only cancellation while finger/read-mode Pencil stay native.
      controls?.preventDefault?.();
      return true;
    }

    handleTouchMove(intent, controls) {
      if (
        intent?.nativeContextTarget === true ||
        !["viewer", "text-layer", "annotation-layer"].includes(intent?.targetRole) ||
        !this.hasActivePenEditorGesture()
      ) {
        return false;
      }
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
