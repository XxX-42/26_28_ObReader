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
      if (!wheel.colorLayoutPositioned) {
        const margin = 36;
        const maxRadius = Math.min(this.host.innerWidth, this.host.innerHeight) / 2 - margin;
        // Existing wheel geometry remains intact; in very small windows the
        // arc is fitted by show() without changing the sector geometry.
        if (maxRadius >= wheel.radius) {
          const safe = wheel.radius + margin;
          wheel.x = Math.max(safe, Math.min(this.host.innerWidth - safe, wheel.x));
          wheel.y = Math.max(safe, Math.min(this.host.innerHeight - safe, wheel.y));
          wheel.element.style.left = `${wheel.x - wheel.radius}px`;
          wheel.element.style.top = `${wheel.y - wheel.radius}px`;
        }
        wheel.colorLayoutPositioned = true;
      }
      wheel.items.forEach((item, index) => {
        const key = this.getToolKey(item, index);
        const color = key && this.getColor(key);
        const button = wheel.element.querySelector(`button[data-sector="${index}"]`);
        if (!button || !color || item.disabled) return;
        button.style.color = "#ffffff";
        if (!wheel.colorRings) wheel.colorRings = new Map();
        let ring = wheel.colorRings.get(index);
        if (!ring) {
          ring = wheel.element.ownerDocument.createElement("div");
          ring.className = "pdfToolWheelColorRing";
          ring.setAttribute("aria-hidden", "true");
          wheel.element.append(ring);
          wheel.colorRings.set(index, ring);
        }
        const start = ((item.startAngle + 90) % 360 + 360) % 360;
        const end = start + item.endAngle - item.startAngle;
        const gradient = end <= 360
          ? `transparent 0deg ${start}deg, ${color} ${start}deg ${end}deg, transparent ${end}deg 360deg`
          : `${color} 0deg ${end - 360}deg, transparent ${end - 360}deg ${start}deg, ${color} ${start}deg 360deg`;
        ring.style.cssText = `position:absolute;inset:-5px;border-radius:50%;pointer-events:none;background:conic-gradient(${gradient});mask:radial-gradient(circle,transparent calc(100% - 5px),#000 calc(100% - 5px));-webkit-mask:radial-gradient(circle,transparent calc(100% - 5px),#000 calc(100% - 5px))`;
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
      // Place the five centres on the same circle around the wheel. Rotate
      // the arc inward near viewport edges, retaining a circular layout.
      const preferred = angle;
      const half = diameter / 2;
      let positions = null;
      for (let radius = wheel.radius + half + 5; radius >= 0 && !positions; radius -= 2) {
        for (let step = 0; step <= 180 && !positions; step++) {
          for (const direction of step ? [1, -1] : [1]) {
            const middle = preferred + direction * step * Math.PI / 180;
            const points = colors.map((_, i) => {
              const spacing = Math.max(0.28, 2 * Math.asin(Math.min(1, (diameter + 2) / (2 * Math.max(radius, 1)))));
              const theta = middle + (i - 2) * spacing;
              return { x: wheel.x + radius * Math.cos(theta), y: wheel.y + radius * Math.sin(theta) };
            });
            if (points.every(p => p.x >= half && p.y >= half && p.x <= this.host.innerWidth - half && p.y <= this.host.innerHeight - half)) { positions = points; break; }
          }
        }
      }
      if (!positions) return;
      element.style.cssText = `position:absolute;left:0;top:0;z-index:2147483647;pointer-events:none`;
      const swatches = colors.map((color, index) => {
        const swatch = doc.createElement("span");
        swatch.dataset.color = color;
        swatch.setAttribute("role", "img");
        swatch.setAttribute("aria-label", `${item.label}颜色 ${color}`);
        swatch.style.cssText = `position:absolute;left:${positions[index].x - (wheel.x - wheel.radius) - half}px;top:${positions[index].y - (wheel.y - wheel.radius) - half}px;display:block;box-sizing:border-box;width:${diameter}px;height:${diameter}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 1px #333`;
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
