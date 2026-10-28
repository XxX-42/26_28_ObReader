import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function setup() {
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../viewer-adapter/input/annotation-tool-colors.js', import.meta.url), 'utf8'), { window });
  const manager = { hasSelection: false, active: null, mode: 3, getMode() { return this.mode; }, getActive() { return this.active; } };
  let identity = { documentId: 'doc', openRequest: 1, rendererGeneration: 'gen' };
  const messages = [], updates = [], posts = [];
  let controller;
  const bus = { dispatch(name, event) { if (name === 'switchannotationeditorparams') messages.push({ name, ...event }); else updates.push({ name, ...event }); controller.onSwitchParams(event); } };
  controller = new window.PdfReaderInputRuntime.AnnotationToolColors({ getManager: () => manager,
    getEventBus: () => bus, getIdentity: () => identity, getFallbackColor: mode => mode === 3 ? '#123456' : null, postPreference: (mode, color) => posts.push([mode, color]) });
  return { manager, messages, updates, posts, controller, changeIdentity(value) { identity = value; } };
}

test('selection and active editor delay default changes until safe', () => {
  const s = setup();
  s.manager.hasSelection = true;
  s.controller.choose(3, '#aabbcc');
  assert.equal(s.controller.get(3), '#123456');
  s.controller.applySnapshot({ 3: '#aabbcc' });
  assert.equal(s.controller.get(3), '#AABBCC');
  assert.equal(s.messages.length, 0);
  s.manager.hasSelection = false;
  s.manager.active = {};
  s.controller.onEditorStatesChanged({ hasSelectedEditor: false });
  assert.equal(s.messages.length, 0);
  s.manager.active = null;
  s.controller.onEditorStatesChanged({ hasSelectedEditor: false });
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].type, 12);
  assert.equal(s.messages[0].value, '#AABBCC');
  assert.equal(s.updates[0].name, 'annotationeditorparamschanged');
  assert.deepEqual(s.posts, [[3, '#AABBCC']]);
});

test('snapshots synchronize all supported modes and reject invalid inputs', () => {
  const s = setup();
  s.controller.onParamsChanged([[12, '#123456']]);
  assert.equal(s.controller.get(3), '#123456');
  s.controller.applySnapshot({ 3: '#abcDEF', 5: '#111111', 9: '#222222', 10: '#333333', 15: '#444444', 99: '#555555' });
  for (const mode of [5, 9, 10, 15]) { s.manager.mode = mode; s.controller.onEditorModeChanged(mode); }
  assert.deepEqual(s.messages.map(m => m.type), [12, 61, 31, 51, 21]);
  assert.equal(s.controller.get(3), '#ABCDEF');
  assert.equal(s.controller.choose(3, '#fff'), false);
  assert.equal(s.controller.choose(99, '#ffffff'), false);
  assert.equal(s.posts.length, 0);
});

test('native changes persist only when safe and old-document pending work is discarded', () => {
  const s = setup();
  s.manager.hasSelection = true;
  s.controller.onSwitchParams({ type: 12, value: '#112233' });
  s.controller.choose(5, '#abcdef');
  assert.equal(s.posts.length, 1);
  s.changeIdentity({ documentId: 'next', openRequest: 2, rendererGeneration: 'gen' });
  s.manager.hasSelection = false;
  s.controller.onEditorStatesChanged({});
  assert.equal(s.messages.length, 0);
  assert.equal(s.controller.get(5), null);
  s.controller.onSwitchParams({ type: 31, value: '#AaBbCc' });
  assert.deepEqual(s.posts.at(-1), [9, '#AABBCC']);
  s.controller.dispose();
  assert.equal(s.controller.choose(3, '#ffffff'), false);
});


test('failed choice leaves actual default unchanged and confirmed choice applies once', () => {
  const s = setup();
  assert.equal(s.controller.get(3), '#123456');
  s.controller.choose(3, '#abcdef');
  assert.equal(s.messages.length, 0);
  s.controller.applySnapshot({});
  assert.equal(s.controller.get(3), '#123456');
  assert.equal(s.messages.length, 0);
  s.controller.choose(3, '#abcdef');
  s.controller.applySnapshot({ 3: '#abcdef' });
  assert.equal(s.messages.length, 1);
  assert.equal(s.controller.get(3), '#ABCDEF');
  assert.equal(s.posts.length, 2);
});
