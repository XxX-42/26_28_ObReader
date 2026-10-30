(() => {
  class MouseChordPanController {
    constructor({ targetWindow, targetDocument, getApp, cancelTracked }) {
      Object.assign(this, { window: targetWindow, document: targetDocument, getApp, cancelTracked });
      this.abort = new AbortController(); this.session = null; this.drain = false;
      const signal = this.abort.signal;
      for (const type of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','click','dblclick','contextmenu','pointercancel']) {
        targetWindow.addEventListener(type, event => this.handle(event), { capture: true, passive: false, signal });
      }
      targetWindow.addEventListener('blur', () => this.reset(), { signal });
    }
    reset() { this.session = null; this.drain = false; this.document.documentElement.classList.remove('pdf-reader-chord-pan'); }
    handle(event) {
      if (event.pointerType && event.pointerType !== 'mouse') return;
      if (event.type === 'pointercancel') { this.reset(); return; }
      if (this.drain && event.type === 'pointerdown' && (event.buttons & 3) !== 3) this.drain = false;
      const app = this.getApp(), viewer = this.document.getElementById('viewerContainer');
      const chord = (event.buttons & 3) === 3;
      if (!this.session && !this.drain && chord && app?.pdfDocument && viewer?.contains(event.target) &&
          !event.target.closest?.('input,textarea,select,[contenteditable=true],[role=dialog],.editToolbar')) {
        const manager = app.pdfViewer?._layerProperties?.annotationEditorUIManager;
        app.pdfAnnotationEraser?.cancelTemporaryStroke?.();
        manager?.currentLayer?.endDrawingSession?.(true);
        this.cancelTracked?.();
        this.window.getSelection()?.removeAllRanges();
        this.session = { pdf: app.pdfDocument, viewer, x: event.clientX, y: event.clientY };
        this.document.documentElement.classList.add('pdf-reader-chord-pan');
      }
      if (this.session) {
        if (app?.pdfDocument !== this.session.pdf) { this.reset(); return; }
        if (!chord) { this.session = null; this.drain = true; this.document.documentElement.classList.remove('pdf-reader-chord-pan'); }
        else if (event.type === 'pointermove') {
          const s = this.session; s.viewer.scrollLeft += s.x - event.clientX; s.viewer.scrollTop += s.y - event.clientY;
          s.x = event.clientX; s.y = event.clientY;
        }
      }
      // Keep release-generated clicks out of tools without blocking free hover.
      const drainingEvent = this.drain && (event.buttons ||
        ['pointerup', 'mouseup', 'click', 'dblclick', 'contextmenu'].includes(event.type));
      if (this.session || drainingEvent) {
        event.preventDefault(); event.stopImmediatePropagation();
        if ((event.type === 'pointerup' || event.type === 'mouseup') && !event.buttons) {
          this.session = null;
          // Keep the compatibility click/contextmenu from reaching tools.
          this.drain = true;
        }
      }
    }
    dispose() { this.reset(); this.abort.abort(); }
  }
  window.PdfReaderInputRuntime = Object.assign(window.PdfReaderInputRuntime || {}, { MouseChordPanController });
})();
