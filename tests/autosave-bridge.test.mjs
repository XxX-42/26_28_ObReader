import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(
  new URL("../viewer-adapter/obsidian-bridge.js", import.meta.url),
  "utf8",
);

function harness() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const messages = [];
  const listeners = new Map();
  let content = {};
  let serializations = 0;
  let serializing = false;
  const parent = {
    postMessage(message) {
      messages.push(message);
    },
  };
  const element = () => ({
    setAttribute() {},
    append() {},
    classList: { add() {}, remove() {} },
    hidden: false,
  });
  const document = {
    currentScript: {
      dataset: { token: "token" },
      src: "https://example.test/web/obsidian-bridge.js",
    },
    body: { append() {} },
    createElement: element,
    addEventListener() {},
    removeEventListener() {},
    getElementById(id) {
      if (id === "toolbarViewer") return { insertBefore() {} };
      return null;
    },
  };
  parent.document = document;
  const window = {
    parent,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener() {},
  };
  const context = vm.createContext({
    window,
    document,
    URL,
    console,
    ArrayBuffer,
    Uint8Array,
    AbortController,
    setTimeout(callback, delay) {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  });
  vm.runInContext(
    source.replace(
      /\}\)\(\);\s*$/,
      `window.probe = { state, scheduleAutoSave, requestSave, flushSave, observeAnnotationStorage, onHostMessage, installAppHooks }; })();`,
    ),
    context,
  );
  const probe = window.probe;
  const storage = {
    get serializable() {
      return { hash: JSON.stringify(content) };
    },
    get size() {
      return Object.keys(content).length;
    },
    resetModified() {},
  };
  const manager = {
    commitOrRemove() {},
    getActive() {
      return null;
    },
  };
  const app = {
    pdfDocument: {
      annotationStorage: storage,
      async saveDocument() {
        assert.equal(serializing, false, "Serializations must never overlap");
        serializing = true;
        serializations++;
        await Promise.resolve();
        serializing = false;
        return new Uint8Array([serializations]);
      },
      async getData() {
        return new Uint8Array([0]);
      },
    },
    pdfViewer: { _layerProperties: { annotationEditorUIManager: manager } },
    initializedPromise: new Promise(() => {}),
    appConfig: { appContainer: element() },
    setTitle() {},
    _updateOverwriteOriginalState() {},
  };
  Object.assign(probe.state, {
    app,
    activeDocumentId: "book.pdf",
    sessionId: "session-1",
    savedFingerprint: storage.serializable.hash,
  });
  probe.observeAnnotationStorage(storage);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    probe,
    storage,
    manager,
    app,
    messages,
    listeners,
    mutate(value) {
      content = value;
      storage.onModified();
    },
    mutateSameObject(value) {
      content = value;
      probe.scheduleAutoSave();
    },
    async tick(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          void timer.callback();
        }
      }
      await settle();
    },
    async ack(
      message = messages.findLast((item) => item.type === "save"),
      overrides = {},
    ) {
      probe.onHostMessage({
        source: parent,
        data: {
          channel: "pdf-web-reader",
          token: "token",
          type: "saved",
          documentId: message.documentId,
          requestId: message.requestId,
          sessionId: message.sessionId,
          ...overrides,
        },
      });
      await settle();
    },
    saves() {
      return messages.filter((item) => item.type === "save");
    },
  };
}

test("autosave debounces real content, does not save open/selection, and detects mutable objects and removal", async () => {
  const h = harness();
  h.probe.scheduleAutoSave();
  await h.tick(1000);
  assert.equal(h.saves().length, 0);
  h.mutate({ square: 1 });
  await h.tick(700);
  h.mutateSameObject({ square: 2 });
  await h.tick(700);
  assert.equal(h.saves().length, 0);
  await h.tick(300);
  assert.equal(h.saves().length, 1);
  assert.equal(h.saves()[0].automatic, true);
  await h.ack();
  assert.equal(h.probe.state.saveStatusElement, undefined);
  assert.equal(
    h.probe.state.statusElement,
    null,
    "Successful saves must not create a popup",
  );
  h.probe.scheduleAutoSave();
  await h.tick(1000);
  assert.equal(h.saves().length, 1);
  h.mutateSameObject({});
  await h.tick(1000);
  assert.equal(
    h.saves().length,
    2,
    "Undo/removal returning storage to empty must be saved",
  );
  await h.ack();
});

test("autosave pauses during pointer/IME activity and preserves focused text editor", async () => {
  const h = harness();
  let commits = 0;
  h.manager.getActive = () => ({
    commitForSave() {
      commits++;
    },
  });
  h.manager.commitOrRemove = () => {
    throw new Error("Automatic save must not remove text focus");
  };
  h.mutate({ text: "a" });
  h.probe.state.pointers.add(1);
  await h.tick(1000);
  assert.equal(h.saves().length, 0);
  h.probe.state.pointers.clear();
  h.probe.state.composing = true;
  h.probe.scheduleAutoSave();
  await h.tick(1000);
  assert.equal(h.saves().length, 0);
  h.probe.state.composing = false;
  h.probe.scheduleAutoSave();
  await h.tick(1000);
  assert.equal(h.saves().length, 1);
  assert.ok(commits > 0);
  await h.ack();
});

test("in-flight edits remain dirty, stale session acknowledgments are ignored, then follow-up save runs", async () => {
  const h = harness();
  h.mutate({ text: "first" });
  await h.tick(1000);
  const first = h.saves()[0];
  h.mutate({ text: "second" });
  await h.tick(1000);
  assert.equal(h.saves().length, 1);
  await h.ack(first, { sessionId: "stale-session" });
  assert.ok(h.probe.state.savePromise);
  await h.ack(first);
  assert.equal(h.app._annotationStorageModified, true);
  await h.tick(1000);
  assert.equal(h.saves().length, 2);
  await h.ack();
  assert.equal(h.app._annotationStorageModified, undefined);
});

test("save failure pauses automatic retries, blocks closing, and manual retry can recover", async () => {
  const h = harness();
  h.mutate({ ink: 1 });
  await h.tick(1000);
  await h.ack(undefined, {
    type: "error",
    code: "conflict",
    message: "External file changed",
  });
  assert.equal(h.probe.state.autoPaused, true);
  assert.equal(
    h.probe.state.statusElement,
    null,
    "Save failures must also remain silent",
  );
  h.mutate({ ink: 2 });
  await h.tick(10000);
  assert.equal(h.saves().length, 1);
  assert.equal(await h.probe.flushSave(), false);
  const manual = h.probe.requestSave();
  await h.tick(0);
  assert.equal(h.saves().length, 2);
  assert.equal(h.saves()[1].automatic, false);
  await h.ack();
  assert.equal(await manual, true);
  assert.equal(await h.probe.flushSave(), true);
});

test("close flush waits for all edits, read-only is never written, and timeout keeps dirty state", async () => {
  const h = harness();
  h.mutate({ underline: 1 });
  let closed = false;
  const flush = h.probe.flushSave().then((ok) => {
    closed = ok;
    return ok;
  });
  await h.tick(0);
  assert.equal(closed, false);
  h.mutateSameObject({ underline: 2 });
  await h.ack();
  await h.tick(0);
  assert.equal(h.saves().length, 2);
  assert.equal(closed, false);
  await h.ack();
  assert.equal(await flush, true);
  h.probe.state.readOnly = true;
  h.mutate({ underline: 3 });
  await h.tick(1000);
  assert.equal(h.saves().length, 2);
  h.probe.state.readOnly = false;
  h.probe.scheduleAutoSave();
  await h.tick(1000);
  await h.tick(120000);
  assert.equal(h.probe.state.autoPaused, true);
  assert.equal(h.app._annotationStorageModified, true);
});
