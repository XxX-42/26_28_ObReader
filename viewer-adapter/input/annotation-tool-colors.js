(() => {
  "use strict";

  const TYPES = new Map([[3, 12], [5, 61], [9, 31], [10, 51], [15, 21]]);
  const MODES = new Map([...TYPES].map(([mode, type]) => [type, mode]));
  const colorValue = value => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase() : null;

  class AnnotationToolColors {
    constructor({ getManager, getEventBus, getIdentity, postPreference, getFallbackColor = () => null }) {
      Object.assign(this, { getManager, getEventBus, getIdentity, postPreference, getFallbackColor });
      this.identity = null;
      this.preferences = new Map();
      this.defaults = new Map();
      this.pending = new Map();
      this.disposed = false;
      this.dispatching = false;
    }

    current() {
      if (this.disposed) return false;
      const identity = this.getIdentity();
      if (!identity || !identity.documentId || !Number.isInteger(identity.openRequest) ||
          !identity.rendererGeneration) return false;
      const key = JSON.stringify([identity.documentId, identity.openRequest, identity.rendererGeneration]);
      if (key !== this.identity) {
        this.identity = key;
        this.preferences.clear();
        this.defaults.clear();
        this.pending.clear();
      }
      return true;
    }

    safe() {
      const manager = this.getManager();
      return Boolean(manager && !manager.hasSelection && !manager.getActive?.());
    }

    flush() {
      if (!this.current() || !this.safe() || this.dispatching) return;
      const bus = this.getEventBus();
      if (!bus?.dispatch) return;
      const identity = this.identity;
      for (const [mode, color] of this.pending) {
        if (!this.current() || this.identity !== identity || !this.safe()) break;
        if (this.getManager()?.getMode?.() !== mode) continue;
        this.pending.delete(mode);
        this.dispatching = true;
        try {
          bus.dispatch("switchannotationeditorparams", { source: this, type: TYPES.get(mode), value: color });
          this.defaults.set(mode, color);
          bus.dispatch("annotationeditorparamschanged", { source: this, details: [[TYPES.get(mode), color]] });
        } finally {
          this.dispatching = false;
        }
      }
    }

    get(mode) {
      if (!this.current() || !TYPES.has(mode)) return null;
      return this.preferences.get(mode) || this.defaults.get(mode) || colorValue(this.getFallbackColor(mode));
    }

    applySnapshot(colors) {
      if (!this.current()) return false;
      const next = new Map();
      for (const mode of TYPES.keys()) {
        const color = colorValue(colors?.[mode]);
        if (color) next.set(mode, color);
      }
      this.preferences = next;
      this.pending = new Map(next);
      this.flush();
      return true;
    }

    choose(mode, value) {
      const color = colorValue(value);
      if (!this.current() || !TYPES.has(mode) || !color) return false;
      // Wait for the host snapshot: failed persistence must leave the current
      // PDF.js default untouched and the displayed color consistent with it.
      this.postPreference(mode, color);
      return true;
    }

    onEditorStatesChanged() { this.flush(); }

    onEditorModeChanged() { this.flush(); }

    onParamsChanged(details) {
      if (!this.current() || !this.safe() || !Array.isArray(details)) return;
      for (const entry of details) {
        if (!Array.isArray(entry)) continue;
        const mode = MODES.get(entry[0]);
        const color = colorValue(entry[1]);
        if (mode && color) this.defaults.set(mode, color);
      }
    }

    onSwitchParams({ type, value, source } = {}) {
      if (!this.current() || this.dispatching || source === this || !this.safe()) return;
      const mode = MODES.get(type);
      const color = colorValue(value);
      if (!mode || !color) return;
      this.defaults.set(mode, color);
      this.preferences.set(mode, color);
      this.pending.delete(mode);
      this.postPreference(mode, color);
    }

    dispose() {
      this.disposed = true;
      this.pending.clear();
      this.preferences.clear();
      this.defaults.clear();
    }
  }

  window.PdfReaderInputRuntime = Object.assign(window.PdfReaderInputRuntime || {}, { AnnotationToolColors });
})();
