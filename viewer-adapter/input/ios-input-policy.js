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
      directManipulationPage = (target) => target,
    } = {}) {
      this.documentRef = documentRef;
      this.isAnnotationToolActive = isAnnotationToolActive;
      this.isTextLayerTarget = isTextLayerTarget;
      this.isElementTarget = isElementTarget;
      this.isViewerSurfaceTarget = isViewerSurfaceTarget;
      this.isNativeContextTarget = isNativeContextTarget;
      this.isNativeActivationTarget = isNativeActivationTarget;
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
