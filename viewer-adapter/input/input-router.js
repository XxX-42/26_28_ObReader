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
    }

    start() {
      if (this.controller) return this.controller;
      const controller = new AbortController();
      this.controller = controller;
      const signal = controller.signal;
      for (const type of WINDOW_EVENTS) {
        this.targetWindow.addEventListener(type, (event) => {
          const intent = window.PdfReaderInputRuntime.createInteractionIntent(event);
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
    }
  }

  window.PdfReaderInputRuntime = Object.assign(
    window.PdfReaderInputRuntime || {},
    { InputRouter },
  );
})();
