import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup({ body = true } = {}) {
  const listeners = new Map();
  let observer;
  const documentListeners = new Map();
  const host = { innerWidth: 320, innerHeight: 240, document: { body: body ? {} : null, addEventListener(name, fn) { documentListeners.set(name, fn); }, removeEventListener(name) { documentListeners.delete(name); } }, queueMicrotask: fn => fn(),
    MutationObserver: class { constructor(fn) { this.callback = fn; observer = this; } observe() {} disconnect() { this.disconnected = true; } },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); } };
  function element() {
    return { style: {}, dataset: {}, children: [], removed: false,
      append(child) { this.children.push(child); }, remove() { this.removed = true; },
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, querySelector() { return { style: {} }; },
      getBoundingClientRect() { return this.rect || { left: 1000, top: 1000, width: 20, height: 20 }; } };
  }
  const doc = { createElement: element };
  const root = element(); root.ownerDocument = doc;
  const button = { style: {} }; root.querySelector = () => button;
  const active = new Set();
  const wheel = { element: root, x: 160, y: 120, radius: 80, pointerId: 7,
    items: [{ label: 'highlight', startAngle: 240, endAngle: 300 }],
    sectors: [{ classList: { toggle(name, on) { if (on) active.add(name); else active.delete(name); } } }] };
  vm.runInNewContext(readFileSync(new URL('../viewer-adapter/input/tool-wheel-color-controller.js', import.meta.url), 'utf8'), { window: host });
  let committed;
  const controller = new host.PdfReaderInputRuntime.ToolWheelColorController({ window: host,
    getWheel: () => wheel, getToolKey: () => 'highlight', getColor: () => '#FFFF98',
    commit: value => { committed = value; } });
  controller.install();
  return { host, wheel, controller, listeners, button, active, documentListeners, get observer() { return observer; }, get committed() { return committed; } };
}

test('swatch release commits color while wheel releases remain with PDF.js', () => {
  const s = setup();
  s.listeners.get('pointermove')({ pointerId: 7, clientX: 160, clientY: 60 });
  assert.equal(s.controller.palette.swatches.length, 5);
  const swatch = s.controller.palette.swatches[1];
  swatch.rect = { left: 10, top: 10, width: 20, height: 20 };
  for (const other of s.controller.palette.swatches.filter(x => x !== swatch)) other.rect = { left: 1000, top: 1000, width: 20, height: 20 };
  let stopped = false;
  s.listeners.get('pointerup')({ pointerId: 7, button: 1, clientX: 20, clientY: 20,
    preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(s.committed.color, '#53FFBC');
  assert.equal(s.wheel.element.removed, true);
  s.controller.destroy();
  assert.equal(s.listeners.size, 0);
});

test('unmatched release and disabled sectors do not commit', () => {
  const s = setup();
  s.wheel.items[0].disabled = true;
  s.listeners.get('pointermove')({ pointerId: 7, clientX: 160, clientY: 60 });
  assert.equal(s.controller.palette, null);
  s.listeners.get('pointerup')({ pointerId: 7, button: 1, clientX: 160, clientY: 60 });
  assert.equal(s.committed, undefined);
});


test('new wheel is decorated immediately and observer is disconnected on cleanup', () => {
  const s = setup();
  s.button.style.color = '';
  s.wheel.element.classList = { contains: value => value === 'pdfToolWheel' };
  s.observer.callback([{ addedNodes: [s.wheel.element] }]);
  assert.equal(s.button.style.color, '#ffffff');
  assert.ok(!s.button.style.webkitTextStroke);
  assert.ok(!s.button.style.textShadow);
  s.controller.destroy();
  assert.equal(s.observer.disconnected, true);
});

test('swatch movement preserves active sector, but outside movement is not intercepted', () => {
  const s = setup();
  s.listeners.get('pointermove')({ pointerId: 7, clientX: 160, clientY: 60 });
  for (const [i, swatch] of s.controller.palette.swatches.entries()) swatch.rect = { left: i * 30, top: 0, width: 20, height: 20 };
  let stopped = false;
  s.listeners.get('pointermove')({ pointerId: 7, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(s.active.has('active'), true);
  stopped = false;
  s.listeners.get('pointermove')({ pointerId: 7, clientX: 300, clientY: 200, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, false);
});

test('palette uses available space outside wheel near an edge', () => {
  const s = setup();
  s.wheel.x = 80;
  s.listeners.get('pointermove')({ pointerId: 7, clientX: 80, clientY: 60 });
  const radii = s.controller.palette.swatches.map(swatch => {
    const style = swatch.style.cssText;
    const left = Number(style.match(/left:([\d.-]+)px/)[1]) + s.wheel.x - s.wheel.radius;
    const top = Number(style.match(/top:([\d.-]+)px/)[1]) + s.wheel.y - s.wheel.radius;
    return Math.hypot(left + 13 - s.wheel.x, top + 13 - s.wheel.y);
  });
  assert.ok(Math.max(...radii) - Math.min(...radii) < 0.01);
  assert.ok(Math.min(...radii) > s.wheel.radius);
});


test('waits for body before observing and removes pending listener on destroy', () => {
  const s = setup({ body: false });
  assert.equal(s.observer, undefined);
  assert.ok(s.documentListeners.has('DOMContentLoaded'));
  s.host.document.body = {};
  s.documentListeners.get('DOMContentLoaded')();
  assert.ok(s.observer);
  s.controller.destroy();
  assert.equal(s.documentListeners.size, 0);
  assert.equal(s.observer.disconnected, true);
  const pending = setup({ body: false });
  pending.controller.destroy();
  assert.equal(pending.documentListeners.size, 0);
});

test('palette and swatches have accessible names', () => {
  const s = setup();
  s.listeners.get('pointermove')({ pointerId: 7, clientX: 160, clientY: 60 });
  assert.equal(s.controller.palette.element.attributes.role, 'group');
  assert.equal(s.controller.palette.swatches[0].attributes.role, 'img');
  assert.match(s.controller.palette.swatches[0].attributes['aria-label'], /#FFFF98/);
});
