(() => {
  "use strict";

  const HIGHLIGHT_COLORS = ["#FFFF98", "#53FFBC", "#80EBFF", "#FFCBE6", "#FF4F5F"];
  const TOOL_COLORS = ["#000000", "#E03131", "#1971C2", "#2F9E44", "#E67700"];

  // Install before PDF.js registers its capture listeners: its wheel consumes
  // pointermove and pointerup with stopImmediatePropagation.
  class ToolWheelColorController {
    constructor({ getWheel, getToolKey, getColor, commit, window: host = window }) {
      Object.assign(this, { getWheel, getToolKey, getColor, commit, host });
      this.move = this.move.bind(this);
      this.up = this.up.bind(this);
      this.cancel = this.cancel.bind(this);
      this.observeBody = this.observeBody.bind(this);
      this.installed = false;
      this.palette = null;
      this.observer = null;
    }

    install() {
      if (this.installed) return;
      this.installed = true;
      this.host.addEventListener("pointermove", this.move, true);
      this.host.addEventListener("pointerup", this.up, true);
      this.host.addEventListener("pointercancel", this.cancel, true);
      this.host.addEventListener("blur", this.cancel);
      this.host.addEventListener("resize", this.cancel);
      if (this.host.document?.body) this.observeBody();
      else this.host.document?.addEventListener("DOMContentLoaded", this.observeBody, { once: true });
      const wheel = this.getWheel();
      if (wheel) this.decorate(wheel);
    }

    observeBody() {
      if (!this.installed || this.observer) return;
      const Observer = this.host.MutationObserver;
      if (Observer && this.host.document?.body) {
        this.observer = new Observer(records => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!node.classList?.contains("pdfToolWheel")) continue;
              // PDF.js appends the node just before assigning _toolWheel.
              this.host.queueMicrotask(() => {
                const wheel = this.installed && this.getWheel();
                if (wheel?.element === node) this.decorate(wheel);
              });
            }
          }
        });
        this.observer.observe(this.host.document.body, { childList: true });
      }
    }

    destroy() {
      if (!this.installed) return;
      this.installed = false;
      this.host.document?.removeEventListener("DOMContentLoaded", this.observeBody);
      this.observer?.disconnect();
      this.observer = null;
      this.host.removeEventListener("pointermove", this.move, true);
      this.host.removeEventListener("pointerup", this.up, true);
      this.host.removeEventListener("pointercancel", this.cancel, true);
      this.host.removeEventListener("blur", this.cancel);
      this.host.removeEventListener("resize", this.cancel);
      this.clear();
    }

    clear() {
      this.palette?.element.remove();
      this.palette = null;
    }

    cancel() { this.clear(); }

    sector(wheel, x, y) {
      const dx = x - wheel.x, dy = y - wheel.y;
      const distance = Math.hypot(dx, dy);
      if (distance < wheel.radius * 0.26 || distance > wheel.radius) return -1;
      let angle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (angle < 0) angle += 360;
      if (angle < 240) angle += 360;
      return wheel.items.findIndex(item => angle >= item.startAngle && angle < item.endAngle);
    }

    decorate(wheel) {
      wheel.items.forEach((item, index) => {
        const key = this.getToolKey(item, index);
        const color = key && this.getColor(key);
        const button = wheel.element.querySelector(`button[data-sector="${index}"]`);
        if (!button || !color || item.disabled) return;
        button.style.color = color;
        const outline = color.toUpperCase() === "#000000" ? "white" : "#252525";
        button.style.webkitTextStroke = `0.7px ${outline}`;
        button.style.paintOrder = "stroke fill";
        button.style.textShadow = `-1px -1px 0 ${outline}, 1px -1px 0 ${outline}, -1px 1px 0 ${outline}, 1px 1px 0 ${outline}`;
      });
    }

    show(wheel, index, key) {
      if (this.palette?.wheel === wheel && this.palette.index === index) return;
      this.clear();
      const item = wheel.items[index];
      const colors = key === "highlight" ? HIGHLIGHT_COLORS : TOOL_COLORS;
      const doc = wheel.element.ownerDocument;
      const element = doc.createElement("div");
      element.className = "pdfToolWheelColors";
      element.setAttribute("role", "group");
      element.setAttribute("aria-label", `${item.label}颜色`);
      // The palette may extend outside the wheel without clipping.
      // Clamp its center to the viewport, including narrow/small windows.
      const angle = (item.startAngle + item.endAngle) * Math.PI / 360;
      const diameter = Math.max(14, Math.min(26, (Math.max(this.host.innerWidth, this.host.innerHeight) - 16) / 5));
      const gap = 4, length = 5 * diameter + 4 * gap;
      const desiredX = wheel.x + Math.cos(angle) * (wheel.radius + diameter / 2 + 5);
      const desiredY = wheel.y + Math.sin(angle) * (wheel.radius + diameter / 2 + 5);
      const clamp = (value, max) => Math.max(0, Math.min(Math.max(0, max), value));
      // Prefer a strip wholly outside the wheel. Evaluate both orientations
      // and choose the visible one closest to the hovered sector.
      const candidates = [
        { x: desiredX - length / 2, y: wheel.y - wheel.radius - diameter - 4, w: length, h: diameter, vertical: false },
        { x: desiredX - length / 2, y: wheel.y + wheel.radius + 4, w: length, h: diameter, vertical: false },
        { x: wheel.x - wheel.radius - diameter - 4, y: desiredY - length / 2, w: diameter, h: length, vertical: true },
        { x: wheel.x + wheel.radius + 4, y: desiredY - length / 2, w: diameter, h: length, vertical: true },
      ].map(candidate => {
        const x = clamp(candidate.x, this.host.innerWidth - candidate.w);
        const y = clamp(candidate.y, this.host.innerHeight - candidate.h);
        const outside = x + candidate.w <= wheel.x - wheel.radius || x >= wheel.x + wheel.radius ||
          y + candidate.h <= wheel.y - wheel.radius || y >= wheel.y + wheel.radius;
        const overflow = Math.max(0, candidate.w - this.host.innerWidth) + Math.max(0, candidate.h - this.host.innerHeight);
        const distance = Math.hypot(x + candidate.w / 2 - desiredX, y + candidate.h / 2 - desiredY);
        return { ...candidate, x, y, score: (outside ? 0 : wheel.radius * 0.5) + overflow * 100 + distance };
      }).sort((a, b) => a.score - b.score);
      const layout = candidates[0];
      element.style.cssText = `position:absolute;left:${layout.x - (wheel.x - wheel.radius)}px;top:${layout.y - (wheel.y - wheel.radius)}px;display:flex;flex-direction:${layout.vertical ? "column" : "row"};gap:${gap}px;z-index:2147483647;pointer-events:none`;
      const swatches = colors.map(color => {
        const swatch = doc.createElement("span");
        swatch.dataset.color = color;
        swatch.setAttribute("role", "img");
        swatch.setAttribute("aria-label", `${item.label}颜色 ${color}`);
        swatch.style.cssText = `display:block;box-sizing:border-box;width:${diameter}px;height:${diameter}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 1px #333`;
        element.append(swatch);
        return swatch;
      });
      wheel.element.append(element);
      this.palette = { wheel, item, index, key, element, swatches };
    }

    hit(x, y) {
      return this.palette?.swatches.find(swatch => {
        const rect = swatch.getBoundingClientRect();
        return Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2)) <= rect.width / 2;
      }) || null;
    }

    move(event) {
      const wheel = this.getWheel();
      if (!wheel || event.pointerId !== wheel.pointerId) {
        if (!wheel) this.clear();
        return;
      }
      this.decorate(wheel);
      // A clamped palette can overlap the wheel; preserve it while over a swatch.
      const hit = this.palette?.wheel === wheel && this.hit(event.clientX, event.clientY);
      if (!hit) {
        const index = this.sector(wheel, event.clientX, event.clientY);
        const item = wheel.items[index];
        const key = item && !item.disabled && this.getToolKey(item, index);
        if (key) this.show(wheel, index, key);
        else if (index >= 0) this.clear();
      }
      const selected = this.hit(event.clientX, event.clientY);
      if (selected) {
        wheel.sectors?.forEach((sector, index) => sector.classList.toggle("active", index === this.palette.index));
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      this.palette?.swatches.forEach(swatch => {
        swatch.style.outline = swatch === selected ? "3px solid #333" : "";
      });
    }

    up(event) {
      const wheel = this.getWheel();
      if (!wheel || wheel !== this.palette?.wheel || event.pointerId !== wheel.pointerId || event.button !== 1) return;
      const swatch = this.hit(event.clientX, event.clientY);
      if (!swatch) return;
      const { item, index, key } = this.palette;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.clear();
      wheel.element.remove();
      this.commit({ item, index, key, color: swatch.dataset.color, wheel });
    }
  }

  window.PdfReaderInputRuntime = Object.assign(window.PdfReaderInputRuntime || {}, { ToolWheelColorController });
})();
