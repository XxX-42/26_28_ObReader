import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../viewer-adapter/input/floating-pdf-outline-controller.js', import.meta.url), 'utf8');
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.style = { setProperty() {} }; this.classList = { add() {}, remove() {} }; this.value = ''; this.hidden = false; }
  append(...nodes) { for (const n of nodes) { if (n.tag === 'fragment') this.children.push(...n.children); else this.children.push(n); n.parent = this; } }
  replaceChildren(node) { this.children = []; this.append(node); }
  setAttribute() {} addEventListener(name, fn) { this.listeners[name] = fn; } contains() { return false; }
  remove() { this.removed = true; } getBoundingClientRect() { return { top: 0, bottom: 100 }; } scrollIntoView() {}
}
function setup(outline, hover = false, timers = { setTimeout, clearTimeout }) {
  const body = new Element('body'), listeners = new Map(), domListeners = new Map(), calls = [];
  const document = { body, documentElement: { classList: { contains: () => false } }, getElementById: () => ({getBoundingClientRect: () => ({left:0,right:500,top:0,bottom:500})}), createElement: tag => new Element(tag), createDocumentFragment: () => new Element('fragment'), addEventListener(name, fn) { domListeners.set(name, fn); } };
  const window = {}; const context = { window, document, AbortController, matchMedia: () => ({ matches: hover }), ...timers };
  vm.runInNewContext(source, context);
  const pdf = { numPages: 4, getOutline: async () => outline, getDestination: async name => name === 'chapter' ? [{ num: 3, gen: 0 }, { name: 'XYZ' }, 1, 2, 3] : null, getPageIndex: async ref => ref.num - 1 };
  const app = { pdfDocument: pdf, pdfViewer: { currentPageNumber: 1 }, pdfLinkService: { goToDestination: value => calls.push(value) }, eventBus: { _on: (n,f) => listeners.set(n,f), _off: n => listeners.delete(n) } };
  return { Controller: window.PdfReaderInputRuntime.FloatingPdfOutlineController, app, body, listeners, domListeners, calls };
}
test('empty and unnavigable outline leave no rail', async () => {
  for (const outline of [null, [], [{ title: 'heading', dest: null }]]) { const h=setup(outline); const c=new h.Controller(h.app,()=>true); await c.start(); assert.equal(h.body.children.length,0); c.dispose(); }
});

test('outside entry waits 200 ms, while movement from inside opens immediately', async () => {
  let scheduled = null; let delay = null;
  const timers = { setTimeout(fn, ms) { scheduled = fn; delay = ms; return 1; }, clearTimeout() { scheduled = null; } };
  const h = setup([{title:'Chapter',dest:'chapter'}], true, timers);
  const c = new h.Controller(h.app, () => true); await c.start();
  h.domListeners.get('pointerover')({pointerType:'mouse',relatedTarget:null});
  h.domListeners.get('pointermove')({pointerType:'mouse',clientX:2,clientY:20,target:{}});
  assert.equal(c.panel.hidden, true); assert.equal(delay, 200);
  scheduled(); assert.equal(c.panel.hidden, false);
  c.setOpen(false);
  h.domListeners.get('pointermove')({pointerType:'mouse',clientX:200,clientY:20,target:{}});
  h.domListeners.get('pointermove')({pointerType:'mouse',clientX:2,clientY:20,target:{}});
  assert.equal(c.panel.hidden, false); c.dispose();
});
test('tree search preserves parents, navigation uses original destination and disposal removes listener', async () => {
  const dest='chapter'; const h=setup([{ title:'Parent', dest:null, items:[{title:'Child',dest}]}]); const c=new h.Controller(h.app,()=>true); await c.start(); assert.equal(h.body.children.length,1); c.search.value='child'; c.render(); assert.equal(c.tree.children.length,2); c.tree.children[1].children[1].listeners.click(); assert.deepEqual(h.calls,[dest]); h.listeners.get('pagechanging')({pageNumber:3}); assert.equal(c.active.title,'Child'); c.dispose(); assert.equal(h.listeners.size,0); assert.equal(c.root.removed,true);
});
test('late outline cannot mount after disposal', async () => {
  let resolve; const h=setup([]); h.app.pdfDocument.getOutline=()=>new Promise(r=>{resolve=r}); const c=new h.Controller(h.app,()=>true); const pending=c.start(); c.dispose(); resolve([{title:'old',dest:'chapter'}]); await pending; assert.equal(h.body.children.length,0);
});

test('leaving reader closes even a pinned outline without reacting to internal movement', async () => {
  const h = setup([{title:'Chapter',dest:'chapter'}]);
  const c = new h.Controller(h.app, () => true); await c.start();
  c.explicit = true; c.setOpen(true);
  h.domListeners.get('pointerout')({pointerType:'mouse', relatedTarget:{}});
  assert.equal(c.panel.hidden, false);
  h.domListeners.get('pointerout')({pointerType:'mouse', relatedTarget:null});
  assert.equal(c.panel.hidden, true); assert.equal(c.explicit, false); c.dispose();
});
