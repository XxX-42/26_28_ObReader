(() => {
  "use strict";

  const WINDOW_EVENTS = Object.freeze([
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "lostpointercapture",
    "pointerout",
    "mousedown",
    "mousemove",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
    "wheel",
    "keydown",
    "blur",
  ]);

  class InputRouter {
    constructor({ targetWindow, targetDocument, policy, onLegacyEvent }) {
      if (!targetWindow || !targetDocument || !policy || !onLegacyEvent) {
        throw new TypeError("InputRouter requires window, document, policy, and event adapter.");
      }
      this.targetWindow = targetWindow;
      this.targetDocument = targetDocument;
      this.policy = policy;
      this.onLegacyEvent = onLegacyEvent;
      this.controller = null;
      this._activePointers = new Map();
      this._manualPointers = new Map();
      this._penPolicyPointers = new Map();
      this._captureTargets = new Map();
    }

    get activePointerCount() { return this._activePointers.size; }
    get manualPointerCount() { return this._manualPointers.size; }
    get penPolicyPointerCount() { return this._penPolicyPointers.size; }
    activePointerValues() { return [...this._activePointers.values()]; }
    activePointerEntries() { return [...this._activePointers.entries()]; }
    manualPointerValues() { return [...this._manualPointers.values()]; }
    penPolicyPointerIds() { return [...this._penPolicyPointers.keys()]; }
    activePointer(id) { return this._activePointers.get(id); }
    manualPointer(id) { return this._manualPointers.get(id); }
    hasActivePointer(id) { return this._activePointers.has(id); }
    hasManualPointer(id) { return this._manualPointers.has(id); }
    hasPenPolicyPointer(id) { return this._penPolicyPointers.has(id); }
    setActivePointer(id, pointer) { this._activePointers.set(id, pointer); }
    setManualPointer(id, pointer) { this._manualPointers.set(id, pointer); }
    setPenPolicyPointer(id, pointer) { this._penPolicyPointers.set(id, pointer); }
    deleteActivePointer(id) { return this._activePointers.delete(id); }
    deleteManualPointer(id) { return this._manualPointers.delete(id); }
    deletePenPolicyPointer(id) { return this._penPolicyPointers.delete(id); }
    clearActivePointers() {
      for (const pointerId of this._activePointers.keys()) {
        this.releasePointerCapture(pointerId);
      }
      this._activePointers.clear();
    }
    clearManualPointers() { this._manualPointers.clear(); }
    clearPenPolicyPointers() { this._penPolicyPointers.clear(); }

    shouldSuppressPenCompatibilityMouse(type) {
      return ["mousedown", "mousemove", "mouseup"].includes(type) &&
        this.activePointerValues().some((pointer) =>
          pointer.pointerType === "pen" &&
          pointer.kind === "text-selection" &&
          pointer.mode === 9 &&
          pointer.penTextSelectionGesture,
        );
    }

    capturePointer(pointerId, target) {
      if (!target?.setPointerCapture) return false;
      try {
        target.setPointerCapture(pointerId);
        this._captureTargets.set(pointerId, target);
        return true;
      } catch {
        return false;
      }
    }

    hasPointerCapture(pointerId) {
      const target = this._captureTargets.get(pointerId);
      try {
        return !!target?.hasPointerCapture?.(pointerId);
      } catch {
        return false;
      }
    }

    releasePointerCapture(pointerId) {
      const target = this._captureTargets.get(pointerId);
      this._captureTargets.delete(pointerId);
      try {
        if (target?.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture(pointerId);
        }
      } catch {
        // The browser may release capture during cancel or frame disposal.
      }
    }

    start() {
      if (this.controller) return this.controller;
      const controller = new AbortController();
      this.controller = controller;
      const signal = controller.signal;
      for (const type of WINDOW_EVENTS) {
        this.targetWindow.addEventListener(type, (event) => {
          const intent = window.PdfReaderInputRuntime.createInteractionIntent(event);
          if (this.shouldSuppressPenCompatibilityMouse(intent.type)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
          }
          // Transitional adapter: the native event remains inside the input
          // boundary closure and is never attached to InteractionIntent.
          this.policy.route(intent, (routedIntent) =>
            this.onLegacyEvent(routedIntent, event),
          );
        }, { capture: true, signal });
      }
      this.targetDocument.addEventListener("visibilitychange", (event) => {
        const intent = window.PdfReaderInputRuntime.createInteractionIntent(event);
        this.policy.route(intent, (routedIntent) =>
          this.onLegacyEvent(routedIntent, event),
        );
      }, { signal });
      return controller;
    }

    stop() {
      this.controller?.abort();
      this.controller = null;
      for (const pointerId of this._captureTargets.keys()) {
        this.releasePointerCapture(pointerId);
      }
      this._activePointers.clear();
      this._manualPointers.clear();
      this._penPolicyPointers.clear();
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { InputRouter },
  );
})();
