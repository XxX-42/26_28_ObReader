(() => {
  "use strict";

  class IOSInputPolicy {
    constructor({
      documentRef = document,
      isAnnotationToolActive = () => false,
      isTextLayerTarget = () => false,
      isElementTarget = () => false,
      isViewerSurfaceTarget = () => false,
      isNativeContextTarget = () => false,
      isNativeActivationTarget = () => false,
      isPenEditableTarget = () => false,
      hasActivePenEditorGesture = () => false,
      directManipulationPage = (target) => target,
    } = {}) {
      this.documentRef = documentRef;
      this.isAnnotationToolActive = isAnnotationToolActive;
      this.isTextLayerTarget = isTextLayerTarget;
      this.isElementTarget = isElementTarget;
      this.isViewerSurfaceTarget = isViewerSurfaceTarget;
      this.isNativeContextTarget = isNativeContextTarget;
      this.isNativeActivationTarget = isNativeActivationTarget;
      this.isPenEditableTarget = isPenEditableTarget;
      this.hasActivePenEditorGesture = hasActivePenEditorGesture;
      this.directManipulationPage = directManipulationPage;
      this.fingerTextSelectionSuppressionOwned = false;
      this.lastTouchPanClickTarget = null;
      this.lastPenPanClickTarget = null;
    }

    route(intent, forwardExistingBehavior) {
      // The existing iPad event behavior remains the compatibility target in
      // this extraction-only stage; subsequent phases move its ownership here.
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

    handleTextSelectionGuard(event) {
      if (
        !this.isFingerTextSelectionSuppressionActive() ||
        !this.isTextLayerTarget(event?.target)
      ) {
        return false;
      }
      event.preventDefault();
      return true;
    }

    touchEventContainsStylus(event) {
      for (const touches of [event?.changedTouches, event?.touches]) {
        const length = Number.isInteger(touches?.length) ? touches.length : 0;
        for (let index = 0; index < length; index += 1) {
          // WebKit TouchList implements indexed access/item(), but may not be
          // iterable. Keep this safe for that IDL shape and small test doubles.
          const touch = touches.item?.(index) || touches[index];
          if (touch?.touchType === "stylus" || touch?.touchType === "pen") {
            return true;
          }
        }
      }
      return false;
    }

    handleTouchStart(event) {
      const target = event?.target;
      if (
        !this.isElementTarget(target) ||
        !this.isViewerSurfaceTarget(target) ||
        this.isNativeContextTarget(target)
      ) {
        return false;
      }
      const activeEditorStylus = this.touchEventContainsStylus(event) && (
        this.isAnnotationToolActive() || this.isPenEditableTarget(target)
      );
      if (!this.hasActivePenEditorGesture() && !activeEditorStylus) {
        return false;
      }
      // Retain Pencil editing/palm arbitration while letting read-mode Pencil
      // and ordinary finger gestures reach WebKit's native scroll handling.
      event.preventDefault();
      return true;
    }

    handleTouchMove(event) {
      const target = event?.target;
      if (
        !this.isElementTarget(target) ||
        !this.isViewerSurfaceTarget(target) ||
        this.isNativeContextTarget(target) ||
        !this.hasActivePenEditorGesture()
      ) {
        return false;
      }
      event.preventDefault();
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
        this.lastTouchPanClickTarget = target || null;
      } else if (pointerType === "pen") {
        this.lastPenPanClickTarget = target || null;
      }
    }

    clearPanClickTargets() {
      this.lastTouchPanClickTarget = null;
      this.lastPenPanClickTarget = null;
    }

    handlePanClick(event, { doubleClick = false } = {}) {
      const target = event?.target;
      if (
        !this.isElementTarget(target) ||
        !this.isViewerSurfaceTarget(target) ||
        this.isNativeContextTarget(target) ||
        this.isNativeActivationTarget(target) ||
        (doubleClick && event.detail < 2)
      ) {
        return false;
      }
      const page = this.directManipulationPage(target);
      const matchesPage = (previousPage) =>
        !!previousPage && (!page || page === previousPage);
      let suppress = false;
      if (doubleClick) {
        suppress = matchesPage(this.lastTouchPanClickTarget) ||
          matchesPage(this.lastPenPanClickTarget);
      } else {
        const touchClick = event.pointerType === "touch" || (
          event.detail > 0 && matchesPage(this.lastTouchPanClickTarget)
        );
        const completedPenPan = event.detail > 0 &&
          matchesPage(this.lastPenPanClickTarget);
        suppress = touchClick || completedPenPan;
      }
      if (suppress) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      return suppress;
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { IOSInputPolicy },
  );
})();
