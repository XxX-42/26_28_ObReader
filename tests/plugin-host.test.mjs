import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRequire = createRequire(path.join(root, "plugin", "main.js"));

function createHarness() {
  const notices = [];
  const files = new Map();
  const storedFiles = new Map();
  const directories = new Set([".obsidian"]);
  const leaves = [];
  const vaultEvents = new Map();
  const workspaceEvents = new Map();
  let viewFactory;

  function addListener(collection, name, listener) {
    if (!collection.has(name)) collection.set(name, new Set());
    collection.get(name).add(listener);
    return { name, listener };
  }

  function emit(collection, name, ...args) {
    for (const listener of collection.get(name) || []) listener(...args);
  }

  function makeWindow() {
    const listeners = new Map();
    const listenerOptions = new Map();
    const timers = new Map();
    let nextTimerId = 0;
    const ownerWindow = {
      listeners,
      listenerOptions,
      timers,
      closed: false,
      document: null,
      lastBeforeUnloadEvent: null,
      messageSenderCalls: 0,
      Function(...args) {
        const generated = Function(...args);
        return (...callArgs) => {
          ownerWindow.messageSenderCalls += 1;
          return generated(...callArgs);
        };
      },
      addEventListener(type, listener, options) {
        addListener(listeners, type, listener);
        listenerOptions.set(listener, options);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
        listenerOptions.delete(listener);
      },
      dispatchEvent(type, event = {}) {
        event.type = type;
        event.defaultPrevented ??= false;
        event.immediateStopped ??= false;
        event.preventDefault ??= function () {
          this.defaultPrevented = true;
        };
        event.stopImmediatePropagation ??= function () {
          this.immediateStopped = true;
        };
        const callbacks = [...(listeners.get(type) || [])];
        for (const capture of [true, false]) {
          for (const callback of callbacks) {
            const options = listenerOptions.get(callback);
            const listenerCaptures =
              options === true || options?.capture === true;
            if (listenerCaptures !== capture) continue;
            callback.call(this, event);
            if (event.immediateStopped) return !event.defaultPrevented;
          }
        }
        return !event.defaultPrevented;
      },
      close() {
        const event = { returnValue: true };
        this.lastBeforeUnloadEvent = event;
        const allowed = this.dispatchEvent("beforeunload", event);
        if (allowed) {
          this.closed = true;
          this.dispatchEvent("pagehide", {});
        }
        return allowed;
      },
      setTimeout(callback, delay) {
        const id = ++nextTimerId;
        const handle = globalThis.setTimeout(() => {
          timers.delete(id);
          callback();
        }, delay);
        timers.set(id, { callback, delay, handle });
        return id;
      },
      clearTimeout(id) {
        const timer = timers.get(id);
        if (timer) globalThis.clearTimeout(timer.handle);
        timers.delete(id);
      },
      fireTimeout(id) {
        const timer = timers.get(id);
        if (!timer) return false;
        globalThis.clearTimeout(timer.handle);
        timers.delete(id);
        timer.callback();
        return true;
      },
    };
    return ownerWindow;
  }

  class TFile {
    constructor(filePath, bytes = [1, 2, 3]) {
      this.path = filePath;
      this.extension = path.extname(filePath).slice(1);
      this.basename = path.basename(filePath, path.extname(filePath));
      this.bytes = Uint8Array.from(bytes);
      this.reads = 0;
      this.writes = 0;
    }
  }

  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.app = leaf.app;
      const ownerWindow = makeWindow();
      const ownerDocument = { defaultView: ownerWindow };
      ownerDocument.body = {
        classList: {
          classes: new Set(),
          contains(name) {
            return this.classes.has(name);
          },
          add(name) {
            this.classes.add(name);
          },
          remove(name) {
            this.classes.delete(name);
          },
        },
      };
      ownerWindow.document = ownerDocument;
      this.contentEl = {
        ownerDocument,
        empty() {},
        addClass() {},
        removeClass() {},
        createDiv() {
          return {
            setText() {},
            toggleClass() {},
          };
        },
        createEl() {
          const frame = {
            ownerDocument,
            srcdoc: "",
            sent: [],
            removed: false,
            contentWindow: {
              postMessage(message) {
                frame.sent.push(message);
              },
            },
            remove() {
              frame.removed = true;
            },
          };
          return frame;
        },
      };
      this.ownerWindow = ownerWindow;
    }

    async setState() {}

    async onOpen() {}

    async onClose() {
      if (this.onCloseBarrier) await this.onCloseBarrier;
      if (this.simulateSdkFileUnloadOnClose && this.file) {
        await this.onUnloadFile(this.file);
      }
    }
  }

  class FileView extends ItemView {
    async setState(state, eState) {
      await super.setState(state, eState);
      const fileOrPath = state?.file ?? state?.path;
      const file =
        typeof fileOrPath === "string"
          ? this.app.vault.getAbstractFileByPath(fileOrPath)
          : fileOrPath;
      if (file instanceof TFile && file !== this.file) {
        if (this.file) await this.onUnloadFile(this.file);
        await this.onLoadFile(file);
      }
    }

    async onLoadFile(file) {
      this.file = file;
    }

    async onUnloadFile(file) {
      if (this.file === file) this.file = null;
    }

    getState() {
      return { file: this.file?.path ?? null };
    }
  }

  class EditableFileView extends FileView {}

  class WorkspaceLeaf {
    constructor(app) {
      this.app = app;
      this.view = null;
    }

    getContainer() {
      return this.popoutRoot || null;
    }

    getRoot() {
      let current = this;
      while (current.parent) current = current.parent;
      return current;
    }

    async setViewState(state, eState) {
      this.lastViewState = state;
      this.lastEState = eState;
      if (!this.view || this.view.getViewType() !== state?.type) {
        const previousView = this.view;
        if (previousView?.onClose) void previousView.onClose();
        if (!viewFactory) throw new Error("View factory was not registered");
        this.view =
          state?.type === "pdf-web-reader-view"
            ? viewFactory(this)
            : { getViewType: () => state?.type };
      }
      if (state?.state) await this.view.setState?.(state.state, eState);
      if (!leaves.includes(this)) leaves.push(this);
      return this.view;
    }

    detach() {
      this.detachCalls = (this.detachCalls || 0) + 1;
      this.detached = true;
      if (this.popoutRoot?.leaves) {
        const popoutIndex = this.popoutRoot.leaves.indexOf(this);
        if (popoutIndex >= 0) this.popoutRoot.leaves.splice(popoutIndex, 1);
      }
      if (this.view?.onClose) void this.view.onClose();
      const index = leaves.indexOf(this);
      if (index >= 0) leaves.splice(index, 1);
      return this;
    }
  }

  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }

    registerView(_type, factory) {
      viewFactory = factory;
    }

    addCommand(command) {
      this.commands ??= new Map();
      this.commands.set(command.id, command);
    }
    addSettingTab(settingTab) {
      this.settingTab = settingTab;
    }
    registerEvent() {}
    async loadData() {
      return this.persistedData ?? null;
    }
    async saveData(data) {
      this.persistedData = structuredClone(data);
    }
  }

  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = { empty() {} };
    }
  }

  class Setting {
    constructor(containerEl) {
      this.containerEl = containerEl;
    }
    setName() { return this; }
    setDesc() { return this; }
    addToggle(callback) {
      const toggle = { setValue() { return toggle; }, onChange() { return toggle; } };
      callback(toggle);
      return this;
    }
  }

  const obsidian = {
    EditableFileView,
    FileView,
    ItemView,
    Notice: class Notice {
      constructor(message) {
        notices.push(message);
      }
    },
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    WorkspaceLeaf,
    normalizePath: (value) => value.replaceAll("\\", "/"),
  };
  const moduleObject = { exports: {} };
  const source = awaitSource;
  new Function("require", "module", "exports", source)(
    (name) => {
      if (name === "obsidian") return obsidian;
      if (name === "./asset-runtime.cjs") return sourceRequire(name);
      return sourceRequire(name);
    },
    moduleObject,
    moduleObject.exports,
  );

  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: (filePath) => files.get(filePath) || null,
      on: (name, listener) => addListener(vaultEvents, name, listener),
      readBinary: async (file) => {
        file.reads += 1;
        return file.bytes.slice().buffer;
      },
      modifyBinary: async (file, value) => {
        file.writes += 1;
        file.bytes = new Uint8Array(value.slice(0));
      },
      adapter: {
        async exists(filePath) {
          return storedFiles.has(filePath) || directories.has(filePath);
        },
        async mkdir(filePath) {
          directories.add(filePath);
        },
        async write(filePath, value) {
          storedFiles.set(filePath, String(value));
        },
        async read(filePath) {
          if (!storedFiles.has(filePath)) throw new Error(`Missing ${filePath}`);
          return String(storedFiles.get(filePath));
        },
        async writeBinary(filePath, value) {
          storedFiles.set(filePath, new Uint8Array(value.slice(0)));
        },
        async readBinary(filePath) {
          const value = storedFiles.get(filePath);
          if (!value) throw new Error(`Missing ${filePath}`);
          return value.slice().buffer;
        },
        async remove(filePath) {
          storedFiles.delete(filePath);
        },
        async list(directory) {
          const prefix = `${directory}/`;
          const files = [...storedFiles.keys()].filter((filePath) =>
            filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/"),
          );
          const folders = [...directories].filter((filePath) =>
            filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/"),
          );
          return { files, folders };
        },
      },
      async createFolder(folderPath) {
        directories.add(folderPath);
      },
      async createBinary(filePath, value) {
        const file = new TFile(filePath, new Uint8Array(value));
        files.set(filePath, file);
        return file;
      },
    },
    workspace: {
      popoutMoveCalls: [],
      getActiveFile: () => null,
      on: (name, listener) => addListener(workspaceEvents, name, listener),
      emit: (name, ...args) => emit(workspaceEvents, name, ...args),
      detachLeavesOfType() {},
      getLeavesOfType: () => leaves,
      iterateLeaves: (container, callback) => {
        for (const leaf of [...(container.leaves || [])]) callback(leaf);
      },
      getLeaf: () => {
        return new WorkspaceLeaf(app);
      },
      moveLeafToPopout(leaf, options = {}) {
        this.popoutMoveCalls.push({ leaf, options });
        const ownerWindow = makeWindow();
        const classes = new Set(["is-popout-window"]);
        const ownerDocument = {
          defaultView: ownerWindow,
          body: {
            classList: {
              contains(name) { return classes.has(name); },
              add(name) { classes.add(name); },
              remove(name) { classes.delete(name); },
            },
          },
        };
        ownerWindow.document = ownerDocument;
        const root = {
          win: ownerWindow,
          workspace: this,
          leaves: [leaf],
          close() {},
        };
        leaf.parent = root;
        leaf.popoutRoot = root;
        if (leaf.view?.contentEl) {
          leaf.view.contentEl.ownerDocument = ownerDocument;
        }
        if (leaf.view?.iframe) {
          leaf.view.iframe.ownerDocument = ownerDocument;
          if (leaf.view.iframe.contentWindow) {
            leaf.view.iframe.contentWindow.parent = ownerWindow;
          }
        }
        emit(workspaceEvents, "layout-change");
        return root;
      },
    },
  };

  const plugin = new moduleObject.exports(app, { id: "pdf-web-reader" });
  return {
    app,
    files,
    leaves,
    notices,
    plugin,
    TFile,
    WorkspaceLeaf,
    storedFiles,
    workspaceEvents,
    vaultEvents,
    emitWorkspace: (name, ...args) => emit(workspaceEvents, name, ...args),
    emitVault: (name, ...args) => emit(vaultEvents, name, ...args),
    makeWindow,
    createView() {
      const leaf = new WorkspaceLeaf(app);
      return viewFactory(leaf);
    },
    createLeaf() {
      return new WorkspaceLeaf(app);
    },
  };
}

const awaitSource = await readFile(
  path.join(root, "plugin", "main.js"),
  "utf8",
);

async function createControlledReader(harness, file) {
  harness.files.set(file.path, file);
  const leaf = harness.createLeaf();
  await leaf.setViewState({ type: "pdf", state: { path: file.path } });
  const view = leaf.view;
  const sent = [];
  const frame = {
    parent: view.contentEl.ownerDocument.defaultView,
    postMessage(message) {
      sent.push(message);
    },
    remove() {
      this.removed = true;
    },
  };
  view.ready = true;
  view.iframe = {
    ownerDocument: view.contentEl.ownerDocument,
    contentWindow: frame,
    srcdoc: "viewer document",
    listeners: new Map(),
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (this.listeners.get(type) === listener) this.listeners.delete(type);
    },
    dispatchEvent(type) {
      this.listeners.get(type)?.({ type, target: this });
    },
    remove() {
      frame.remove();
    },
  };
  view.iframeLoadListener = () => view.onIframeLoad(view.iframe);
  view.iframe.addEventListener("load", view.iframeLoadListener);
  view.viewerDocumentHtml = `<html><script data-renderer-generation="${view.rendererGeneration}"></script></html>`;
  view.iframe.srcdoc = view.viewerDocumentHtml;
  view.iframeLoadCount = 1;
  view.statusEl = { setText() {}, toggleClass() {} };
  return {
    leaf,
    view,
    frame,
    sent,
    replyClose(result = {}) {
      const request = sent.filter((message) => message.type === "prepare-close").at(-1);
      assert.ok(request, "The host should send a controlled close request");
      view.onMessage({
        source: frame,
        data: {
          channel: "pdf-web-reader",
          token: view.token,
          type: "close-prepared",
          id: request.id,
          documentId: request.documentId,
          openRequest: request.openRequest,
          revision: 0,
          ok: true,
          dirty: false,
          recovered: false,
          prepared: true,
          ...result,
        },
      });
    },
  };
}

function attachReadersToPopout(harness, readers, ownerWindow = harness.makeWindow()) {
  const ownerDocument = readers[0].view.contentEl.ownerDocument;
  ownerDocument.defaultView = ownerWindow;
  ownerWindow.document = ownerDocument;
  ownerDocument.body.classList.add("is-popout-window");
  for (const { leaf, view } of readers) {
    view.contentEl.ownerDocument = ownerDocument;
    if (view.iframe) {
      view.iframe.ownerDocument = ownerDocument;
      if (view.iframe.contentWindow) {
        view.iframe.contentWindow.parent = ownerWindow;
      }
    }
  }

  const popout = {
    win: ownerWindow,
    workspace: harness.app.workspace,
    leaves: readers.map(({ leaf }) => leaf),
    originalCloseCalls: 0,
    destroyWindowCalls: 0,
    deferWindowClose: false,
    failBeforeDestroy: false,
    detachResults: [],
    sdkBeforeUnloadCalls: 0,
    component: { unload() {} },
    close() {
      this.originalCloseCalls += 1;
      if (this.failBeforeDestroy) return;
      this.workspace.iterateLeaves(this, (leaf) => {
        // Obsidian 1.14.4 does not await WorkspaceLeaf.detach() here.
        this.detachResults.push(leaf.detach());
      });
      this.component.unload();
      this.destroyWindow();
    },
    destroyWindow() {
      const closingWindow = this.win;
      this.win = null;
      this.destroyWindowCalls += 1;
      if (this.deferWindowClose) {
        Promise.resolve().then(() => closingWindow?.close());
      } else {
        closingWindow?.close();
      }
    },
  };
  for (const { leaf } of readers) {
    leaf.popoutRoot = popout;
    leaf.parent = popout;
  }
  ownerWindow.addEventListener("beforeunload", () => {
    popout.sdkBeforeUnloadCalls += 1;
    if (popout.win) popout.close();
  });
  for (const { view } of readers) view.bindOwnerWindow();
  return { ownerWindow, ownerDocument, popout };
}

async function settleMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test("different PDF paths receive distinct leaves and reopening reuses its file leaf", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = new harness.TFile("Books/first.pdf");
  const second = new harness.TFile("Books/second.pdf");
  harness.files.set(first.path, first);
  harness.files.set(second.path, second);

  await harness.plugin.openPdf(first);
  const firstLeaf = harness.leaves[0];
  await harness.plugin.openPdf(second);
  await harness.plugin.openPdf(first);

  assert.equal(harness.leaves.length, 2);
  assert.equal(harness.leaves[0], firstLeaf);
  assert.equal(first.reads, 1);
  assert.equal(second.reads, 1);
  assert.equal(firstLeaf.view.requestedPath, first.path);
  assert.equal(harness.leaves[1].view.requestedPath, second.path);
});

test("host ignores stale source, token, and document messages", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const frame = {};
  const status = [];
  view.iframe = { contentWindow: frame };
  view.token = "current-token";
  view.requestedPath = "current.pdf";
  view.statusEl = {
    setText: (message) => status.push(message),
    toggleClass() {},
  };
  const base = {
    channel: "pdf-web-reader",
    token: "current-token",
    type: "opened",
    documentId: view.documentId,
  };

  view.onMessage({ source: {}, data: base });
  view.onMessage({ source: frame, data: { ...base, token: "stale-token" } });
  view.onMessage({ source: frame, data: { ...base, documentId: "stale-session" } });

  assert.deepEqual(status, []);
  assert.equal(view.ready, false);
});

test("host refuses mismatched/conflicting saves and acknowledges a valid write", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/current.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const view = harness.createView();
  const replies = [];
  const frame = {
    postMessage: (message) => replies.push(message),
  };
  view.iframe = { contentWindow: frame };
  view.file = file;
  view.requestedPath = file.path;
  view.originalBytes = Uint8Array.from([1, 2, 3]);
  harness.plugin.setDocumentBaseline(file.path, view.originalBytes);
  view.statusEl = {
    setText() {},
    toggleClass() {},
  };
  const incoming = vm.runInNewContext("new Uint8Array([4, 5, 6]).buffer");

  await view.saveFile(incoming, "other-session", "request-mismatch", 1, "manual");
  assert.equal(file.writes, 0);
  assert.equal(replies.at(-1).code, "document-mismatch");
  assert.equal(replies.at(-1).requestId, "request-mismatch");
  assert.deepEqual([...view.originalBytes], [1, 2, 3]);

  file.bytes = Uint8Array.from([8, 8, 8]);
  await view.saveFile(incoming, view.documentId, "request-conflict", 2, "auto");
  assert.equal(file.writes, 0);
  assert.equal(replies.at(-1).code, "conflict");
  assert.equal(replies.at(-1).requestId, "request-conflict");
  assert.deepEqual([...view.originalBytes], [1, 2, 3]);
  assert.equal((await harness.plugin.listRecoveryCandidates()).length, 1);

  file.bytes = Uint8Array.from([1, 2, 3]);
  await view.saveFile(incoming, view.documentId, "request-success", 3, "manual");
  assert.equal(file.writes, 1);
  assert.deepEqual([...file.bytes], [4, 5, 6]);
  assert.deepEqual([...view.originalBytes], [4, 5, 6]);
  assert.equal(replies.at(-1).type, "saved");
  assert.equal(replies.at(-1).documentId, view.documentId);
  assert.equal(replies.at(-1).requestId, "request-success");
  assert.equal(replies.at(-1).revision, 3);
  assert.equal((await harness.plugin.listRecoveryCandidates()).length, 1,
    "A later successful save must not erase an earlier conflict candidate");
});

test("two views of one PDF serialize writes and preserve the stale view as a recovery candidate", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/shared.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const makeOpenView = () => {
    const view = harness.createView();
    const replies = [];
    view.file = file;
    view.requestedPath = file.path;
    view.originalBytes = Uint8Array.from([1, 2, 3]);
    view.iframe = { contentWindow: { postMessage: (message) => replies.push(message) } };
    view.statusEl = { setText() {}, toggleClass() {} };
    return { view, replies };
  };
  const first = makeOpenView();
  const second = makeOpenView();
  harness.plugin.setDocumentBaseline(file.path, [1, 2, 3]);

  await Promise.all([
    first.view.saveFile(Uint8Array.from([4, 4, 4]).buffer, first.view.documentId, "first", 1, "auto"),
    second.view.saveFile(Uint8Array.from([5, 5, 5]).buffer, second.view.documentId, "second", 1, "auto"),
  ]);

  assert.equal(file.writes, 1);
  assert.deepEqual([...file.bytes], [4, 4, 4]);
  assert.equal(first.replies.at(-1).type, "saved");
  assert.equal(second.replies.at(-1).code, "conflict");
  assert.equal(harness.notices.length, 1, "Successful auto-save stays quiet; only the conflict notifies");
  const candidates = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    [...new Uint8Array(await harness.app.vault.adapter.readBinary(candidates[0].candidatePath))],
    [5, 5, 5],
  );
});

test("a queued save cannot write old PDF bytes into a newly selected PDF", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = new harness.TFile("Books/first-queued.pdf", [1, 2, 3]);
  const second = new harness.TFile("Books/second-queued.pdf", [7, 7, 7]);
  harness.files.set(first.path, first);
  harness.files.set(second.path, second);
  const view = harness.createView();
  view.file = first;
  view.requestedPath = first.path;
  view.originalBytes = Uint8Array.from([1, 2, 3]);
  view.iframe = { contentWindow: { postMessage() {} } };
  harness.plugin.setDocumentBaseline(first.path, view.originalBytes);

  let releaseQueue;
  const gate = new Promise((resolve) => { releaseQueue = resolve; });
  const blocker = harness.plugin.enqueueSave(() => gate);
  const queuedSave = view.saveFile(
    Uint8Array.from([4, 4, 4]).buffer,
    view.documentId,
    "queued-old-document",
    9,
    "auto",
  );
  const oldDocumentId = view.documentId;

  // Exercise the host's queued-write identity guard while a new open request
  // supersedes the old renderer, without faking an impossible clean close ack
  // while the old save is still queued.
  await view.openFile(second);
  assert.notEqual(view.documentId, oldDocumentId);
  releaseQueue();
  await blocker;
  await queuedSave;

  assert.equal(first.writes, 0);
  assert.equal(second.writes, 0);
  assert.deepEqual([...second.bytes], [7, 7, 7]);
  assert.equal(view.saving, false);
  const [candidate] = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidate.metadata.originalPath, first.path);
  assert.equal(candidate.metadata.filename, first.basename);
  assert.equal(candidate.metadata.documentId, oldDocumentId);
  assert.deepEqual(
    [...new Uint8Array(await harness.app.vault.adapter.readBinary(candidate.candidatePath))],
    [4, 4, 4],
  );
});

test("a rename during the asynchronous disk check rejects the write and keeps recovery", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/rename-race.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const view = harness.createView();
  view.file = file;
  view.requestedPath = file.path;
  view.originalBytes = Uint8Array.from([1, 2, 3]);
  view.iframe = { contentWindow: { postMessage() {} } };
  harness.plugin.setDocumentBaseline(file.path, view.originalBytes);
  const originalRead = harness.app.vault.readBinary;
  let releaseRead;
  let startedRead;
  const readStarted = new Promise((resolve) => { startedRead = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  harness.app.vault.readBinary = async (target) => {
    const bytes = await originalRead(target);
    if (target === file && target.reads === 1) {
      startedRead();
      await readGate;
    }
    return bytes;
  };

  const saving = view.saveFile(
    Uint8Array.from([6, 6, 6]).buffer,
    view.documentId,
    "rename-race",
    10,
    "auto",
  );
  await readStarted;
  harness.files.delete(file.path);
  const oldPath = file.path;
  file.path = "Archive/rename-race.pdf";
  harness.files.set(file.path, file);
  harness.emitVault("rename", file, oldPath);
  releaseRead();
  await saving;

  assert.equal(file.writes, 0);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(view.requestedPath, file.path);
  const [candidate] = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidate.metadata.originalPath, oldPath);
  assert.deepEqual(
    [...new Uint8Array(await harness.app.vault.adapter.readBinary(candidate.candidatePath))],
    [6, 6, 6],
  );
});

test("open uses a stable session ID and sends current path, filename, and default auto-save", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/first.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const view = harness.createView();
  const frame = { sent: [], postMessage(message) { this.sent.push(message); } };
  view.file = file;
  view.requestedPath = file.path;
  view.pendingBytes = Uint8Array.from([1, 2, 3]).buffer;
  view.iframe = { contentWindow: frame };
  view.ready = true;

  view.sendPendingDocument();

  assert.equal(frame.sent[0].type, "open");
  assert.notEqual(view.documentId, file.path);
  assert.equal(frame.sent[0].documentId, view.documentId);
  assert.equal(frame.sent[0].documentPath, file.path);
  assert.equal(frame.sent[0].filename, file.basename);
  assert.equal(frame.sent[0].openRequest, view.openRequest);
  assert.equal(frame.sent[0].autoSave, true);
});

test("a not-ready Reader closes only when clean or backed by an exact durable draft", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const cleanFile = new harness.TFile("Books/preopen-clean.pdf", [1, 2, 3]);
  const cleanReader = await createControlledReader(harness, cleanFile);
  cleanReader.view.ready = false;
  assert.equal(await cleanReader.view.prepareControlledClose("detach"), true);
  assert.equal(cleanReader.view.preparedClose.revision, 0);
  assert.equal(cleanReader.view.preparedClose.recovered, false);

  const dirtyFile = new harness.TFile("Books/preopen-dirty.pdf", [4, 5, 6]);
  const dirtyReader = await createControlledReader(harness, dirtyFile);
  dirtyReader.view.ready = false;
  dirtyReader.view.currentRevision = 3;
  dirtyReader.view.confirmedRevision = 1;
  assert.equal(await dirtyReader.view.prepareControlledClose("detach"), false);
  assert.equal(dirtyReader.view.preparedClose, null);

  await dirtyReader.view.recoverFile(
    Uint8Array.from([7, 8, 9]).buffer,
    dirtyReader.view.documentId,
    "preopen-draft",
    3,
    "auto-save-disabled",
  );
  assert.equal(await dirtyReader.view.prepareControlledClose("detach"), true);
  assert.equal(dirtyReader.view.preparedClose.revision, 3);
  assert.equal(dirtyReader.view.preparedClose.recovered, true);
});

test("popout migration reopens the confirmed PDF in a fresh renderer generation", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/popout-clean.pdf", [1, 2, 3]);
  const reader = await createControlledReader(harness, file);
  const { leaf, view, sent, replyClose } = reader;
  const documentId = view.documentId;
  const oldRendererGeneration = view.rendererGeneration;
  const oldOpenRequest = view.openRequest;
  view.currentRevision = 5;
  view.confirmedRevision = 5;

  const moving = harness.app.workspace.moveLeafToPopout(leaf);
  await Promise.resolve();
  replyClose({ revision: 5 });
  const popoutRoot = await moving;

  assert.equal(popoutRoot, leaf.popoutRoot);
  assert.equal(view.documentId, documentId, "renderer migration keeps the PDF session identity");
  assert.equal(view.openRequest, oldOpenRequest + 1, "the new renderer gets a fresh generation");
  assert.notEqual(view.rendererGeneration, oldRendererGeneration);
  assert.equal(view.ready, false);
  assert.equal(view.preparedClose, null, "the old realm's prepared state cannot authorize a later close");
  assert.equal(view.ownerWindow, popoutRoot.win);
  assert.match(view.iframe.srcdoc, /data-renderer-generation=/);

  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: oldRendererGeneration,
    },
  });
  assert.equal(sent.filter((message) => message.type === "open").length, 0,
    "a queued ready from the previous renderer must not consume the checkpoint");

  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });
  const open = sent.filter((message) => message.type === "open").at(-1);
  assert.ok(open);
  assert.deepEqual([...new Uint8Array(open.data)], [1, 2, 3]);
  assert.equal(open.documentId, documentId);
  assert.equal(open.openRequest, view.openRequest);
  assert.equal(open.revision, 5);
  assert.equal(open.confirmedRevision, 5);
  assert.equal(open.restoreDirty, false);
  assert.equal(open.restorePaused, false);
  assert.ok(popoutRoot.win.messageSenderCalls > 0, "open must be posted from the popout realm");
  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });
  assert.equal(sent.filter((message) => message.type === "open").length, 1,
    "a duplicate ready must not resend a second open into an already active document");

  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "opened",
      documentId,
      openRequest: view.openRequest,
      revision: 5,
      confirmedRevision: 5,
      dirty: false,
      restorePaused: false,
    },
  });
  assert.equal(view.pendingOpenState, null);
  assert.equal(view.currentRevision, 5);
  assert.equal(view.confirmedRevision, 5);
});

test("async iframe adoption rebinds the owner before the fresh renderer sends ready", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-async-adoption.pdf", [1, 2, 3]),
  );
  const { leaf, view, frame, sent, replyClose } = reader;
  view.bindOwnerWindow();
  const oldOwnerWindow = view.ownerWindow;
  const newOwnerWindow = harness.makeWindow();
  const classes = new Set(["is-popout-window"]);
  const newOwnerDocument = {
    defaultView: newOwnerWindow,
    body: {
      classList: {
        contains(name) {
          return classes.has(name);
        },
      },
    },
  };
  newOwnerWindow.document = newOwnerDocument;
  const popoutRoot = {
    win: newOwnerWindow,
    workspace: harness.app.workspace,
    leaves: [leaf],
    close() {},
  };

  // The SDK's synchronous move returns before it adopts the iframe into the
  // popout document. Keep contentEl and iframe in the old document until the
  // test delivers the later iframe load event.
  harness.plugin.pdfOpenRouting.originalMoveLeafToPopout = function (movingLeaf) {
    this.popoutMoveCalls.push({ leaf: movingLeaf, options: {} });
    movingLeaf.parent = popoutRoot;
    movingLeaf.popoutRoot = popoutRoot;
    return popoutRoot;
  };

  const moving = harness.app.workspace.moveLeafToPopout(leaf);
  await settleMicrotasks();
  replyClose({ revision: 0 });
  assert.equal(await moving, popoutRoot);
  assert.equal(view.ownerWindow, oldOwnerWindow,
    "The synchronous SDK return still precedes iframe adoption in this scenario");
  assert.equal(oldOwnerWindow.listeners.get("message").has(view.messageListener), true);
  assert.equal(view.ready, false);
  assert.equal(view.awaitingRendererLoad, true);

  frame.parent = newOwnerWindow;
  view.iframe.ownerDocument = newOwnerDocument;
  view.iframe.dispatchEvent("load");

  assert.equal(view.ownerWindow, newOwnerWindow,
    "An adopted iframe's actual parent window supersedes a stale contentEl document");
  assert.equal(oldOwnerWindow.listeners.get("message").has(view.messageListener), false);
  assert.equal(newOwnerWindow.listeners.get("message").has(view.messageListener), true,
    "The load handler rebinds before its awaiting-renderer early return");
  assert.equal(view.awaitingRendererLoad, false);

  newOwnerWindow.dispatchEvent("message", {
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });

  const open = sent.filter((message) => message.type === "open").at(-1);
  assert.ok(open, "The new parent's one-shot ready message must deliver the checkpoint");
  assert.equal(open.documentId, view.documentId);
  assert.equal(open.openRequest, view.openRequest);
  assert.equal(open.restoreDirty, false);
  assert.ok(newOwnerWindow.messageSenderCalls > 0,
    "The checkpoint message must use the adopted owner's realm");
});

test("popout migration restores the exact paused recovery draft without replacing the disk baseline", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/popout-paused.pdf", [1, 2, 3]);
  const reader = await createControlledReader(harness, file);
  const { leaf, view, sent, replyClose } = reader;
  const documentId = view.documentId;
  view.currentRevision = 3;
  view.confirmedRevision = 3;
  const draft = Uint8Array.from([9, 8, 7]);

  await view.recoverFile(
    draft.buffer,
    documentId,
    "recovery-for-popout",
    7,
    "save-conflict",
  );
  assert.equal(view.originalBytes[0], 1);
  assert.deepEqual([...view.latestRecoveryDraft.bytes], [9, 8, 7]);

  const moving = harness.app.workspace.moveLeafToPopout(leaf);
  await Promise.resolve();
  replyClose({ revision: 7, dirty: true, recovered: true });
  await moving;
  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });

  const open = sent.filter((message) => message.type === "open").at(-1);
  assert.deepEqual([...new Uint8Array(open.data)], [9, 8, 7]);
  assert.equal(open.documentId, documentId);
  assert.equal(open.revision, 7);
  assert.equal(open.confirmedRevision, 3);
  assert.equal(open.restoreDirty, true);
  assert.equal(open.restorePaused, true);
  assert.deepEqual([...view.originalBytes], [1, 2, 3]);
  assert.equal(file.writes, 0, "migration must not turn a recovery draft into an original-PDF write");

  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "opened",
      documentId,
      openRequest: view.openRequest,
      revision: 7,
      confirmedRevision: 3,
      dirty: true,
      restorePaused: true,
    },
  });
  assert.equal(view.pendingOpenState, null);
  assert.equal(view.currentRevision, 7);
  assert.equal(view.confirmedRevision, 3);
});

test("a rejected SDK popout move cancels the prepared checkpoint and keeps the live renderer", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/popout-not-moved.pdf", [1, 2, 3]);
  const reader = await createControlledReader(harness, file);
  const { leaf, view, sent, replyClose } = reader;
  const documentId = view.documentId;
  const openRequest = view.openRequest;
  const originalOwnerWindow = view.getOwnerWindow();
  harness.plugin.pdfOpenRouting.originalMoveLeafToPopout = function () {
    this.popoutMoveCalls.push({ leaf, options: {} });
    return false;
  };

  const moving = harness.app.workspace.moveLeafToPopout(leaf);
  await Promise.resolve();
  replyClose({ revision: 0 });
  const result = await moving;

  assert.equal(result, false);
  assert.equal(view.getOwnerWindow(), originalOwnerWindow);
  assert.equal(view.documentId, documentId);
  assert.equal(view.openRequest, openRequest);
  assert.equal(view.ready, true);
  assert.equal(view.popoutMoveTransaction, null);
  assert.equal(view.preparedClose, null);
  assert.ok(sent.some((message) => message.type === "cancel-close"));
});

test("the SDK popout wrapper leaves non-Reader leaves synchronous and restores the workspace method", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const workspace = harness.app.workspace;
  const originalDescriptor =
    harness.plugin.pdfOpenRouting.originalMoveLeafToPopoutDescriptor;
  const noteLeaf = harness.createLeaf();
  noteLeaf.view = { getViewType: () => "markdown" };

  const result = workspace.moveLeafToPopout(noteLeaf, { width: 500 });
  assert.equal(typeof result?.then, "undefined");
  assert.equal(workspace.popoutMoveCalls.length, 1);
  assert.equal(workspace.popoutMoveCalls[0].leaf, noteLeaf);

  harness.plugin.onunload();
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(workspace, "moveLeafToPopout"),
    originalDescriptor,
  );
});

test("an unexpected renderer reload uses the exact recovery checkpoint or warns before reopening the confirmed PDF", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/unexpected-reload.pdf", [1, 2, 3]);
  const reader = await createControlledReader(harness, file);
  const { view, sent, frame } = reader;
  view.currentRevision = 4;
  view.confirmedRevision = 4;
  const previousRendererGeneration = view.rendererGeneration;

  view.iframe.dispatchEvent("load");
  assert.equal(view.ready, false);
  assert.equal(view.rendererStateUnknown, true);
  assert.equal(view.pendingOpenState.restoreDirty, false);
  assert.ok(harness.notices.some((message) => message.includes("未提交的更改可能需要从恢复副本取回")));

  view.onMessage({
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: previousRendererGeneration,
    },
  });
  assert.equal(sent.filter((message) => message.type === "open").length, 0);

  view.onMessage({
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });
  const open = sent.filter((message) => message.type === "open").at(-1);
  assert.deepEqual([...new Uint8Array(open.data)], [1, 2, 3]);
  assert.equal(open.revision, 4);
  assert.equal(open.confirmedRevision, 4);
  assert.equal(open.restoreDirty, false);
});

test("renaming a PDF updates the path while retaining the view session ID", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/before.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const view = harness.createView();
  const sent = [];
  view.iframe = { contentWindow: { postMessage: (message) => sent.push(message) } };
  view.file = file;
  view.requestedPath = file.path;
  harness.plugin.setDocumentBaseline(file.path, [1, 2, 3]);
  const documentId = view.documentId;

  harness.files.delete(file.path);
  file.path = "Archive/after.pdf";
  file.basename = "after";
  harness.files.set(file.path, file);
  harness.emitVault("rename", file, "Books/before.pdf");

  assert.equal(view.documentId, documentId);
  assert.equal(view.requestedPath, file.path);
  assert.deepEqual(harness.plugin.documentBaselines.get(file.path), Uint8Array.from([1, 2, 3]));
  assert.equal(sent.at(-1).type, "rename");
  assert.equal(sent.at(-1).documentPath, file.path);
  assert.equal(sent.at(-1).filename, file.basename);
});

test("auto-save preference persists and is sent to open views", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const sent = [];
  view.iframe = { contentWindow: { postMessage: (message) => sent.push(message) } };

  await harness.plugin.setAutoSaveEnabled(false);

  assert.equal(harness.plugin.settings.autoSave, false);
  assert.deepEqual(harness.plugin.persistedData, { autoSave: false });
  assert.equal(sent.at(-1).type, "configure-auto-save");
  assert.equal(sent.at(-1).enabled, false);
});

test("recovery protocol persists a draft without writing the original PDF", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/recovery-draft.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const view = harness.createView();
  const replies = [];
  const frame = {
    postMessage(message) {
      replies.push(message);
    },
  };
  view.iframe = { contentWindow: frame };
  view.file = file;
  view.requestedPath = file.path;
  view.originalBytes = Uint8Array.from([1, 2, 3]);
  harness.plugin.setDocumentBaseline(file.path, view.originalBytes);

  await view.recoverFile(
    Uint8Array.from([4, 5, 6]).buffer,
    view.documentId,
    "recover-disabled-autosave",
    17,
    "auto-save-disabled",
  );

  assert.equal(file.writes, 0);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.deepEqual(replies.at(-1), {
    channel: "pdf-web-reader",
    type: "recovered",
    token: view.token,
    documentId: view.documentId,
    requestId: "recover-disabled-autosave",
    revision: 17,
  });
  const [candidate] = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidate.metadata.status, "draft");
  assert.equal(candidate.metadata.origin, "recovery");
  assert.equal(candidate.metadata.reason, "auto-save-disabled");
  assert.equal(candidate.metadata.requestId, "recover-disabled-autosave");
  assert.equal(candidate.metadata.revision, 17);
  assert.equal(candidate.metadata.originalPath, file.path);

  const restoredPath = await harness.plugin.restoreLatestRecovery();
  assert.match(restoredPath, /^PDF Recovery\/recovery-draft \(Recovered /);
  assert.deepEqual([...harness.files.get(restoredPath).bytes], [4, 5, 6]);
});

test("queued recovery keeps the source PDF identity when the view switches", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = new harness.TFile("Books/recovery-before-switch.pdf", [1, 2, 3]);
  const second = new harness.TFile("Books/recovery-after-switch.pdf", [7, 7, 7]);
  harness.files.set(first.path, first);
  harness.files.set(second.path, second);
  const view = harness.createView();
  const replies = [];
  const frame = { postMessage: (message) => replies.push(message) };
  view.iframe = { contentWindow: frame };
  view.file = first;
  view.requestedPath = first.path;
  view.originalBytes = Uint8Array.from([1, 2, 3]);
  harness.plugin.setDocumentBaseline(first.path, view.originalBytes);

  let releaseQueue;
  const gate = new Promise((resolve) => { releaseQueue = resolve; });
  const blocker = harness.plugin.enqueueSave(() => gate);
  const recovery = view.recoverFile(
    Uint8Array.from([4, 4, 4]).buffer,
    view.documentId,
    "queued-recovery",
    22,
    "save-conflict",
  );
  const oldDocumentId = view.documentId;

  await view.openFile(second);
  assert.notEqual(view.documentId, oldDocumentId);
  releaseQueue();
  await Promise.all([blocker, recovery]);

  assert.equal(first.writes, 0);
  assert.equal(second.writes, 0);
  assert.deepEqual([...first.bytes], [1, 2, 3]);
  assert.deepEqual([...second.bytes], [7, 7, 7]);
  assert.equal(replies.at(-1).type, "recovered");
  assert.equal(replies.at(-1).documentId, oldDocumentId);
  const [candidate] = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidate.metadata.documentId, oldDocumentId);
  assert.equal(candidate.metadata.originalPath, first.path);
  assert.equal(candidate.metadata.status, "draft");
  assert.deepEqual(
    [...new Uint8Array(await harness.app.vault.adapter.readBinary(candidate.candidatePath))],
    [4, 4, 4],
  );
});

test("close reports a persisted recovery draft distinctly from an unflushed loss", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  view.file = new harness.TFile("Books/close-recovery.pdf");
  view.requestedPath = view.file.path;
  view.ready = true;
  const sent = [];
  const frame = {
    postMessage(message) {
      sent.push(message);
      if (message.type === "flush") {
        view.onMessage({
          source: frame,
          data: {
            channel: "pdf-web-reader",
            token: view.token,
            type: "flushed",
            documentId: view.documentId,
            id: message.id,
            ok: false,
            dirty: true,
            recovered: true,
          },
        });
      }
    },
    remove() {
      this.removed = true;
    },
  };
  view.iframe = { contentWindow: frame, remove: () => frame.remove() };

  await view.onClose();

  assert.equal(sent[0].type, "flush");
  assert.equal(view.iframe, null);
  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0], /原 PDF 未写回；关闭前已保留恢复副本/);
});

test("forced onClose keeps its failed flush warning without preparing twice on file unload", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const file = new harness.TFile("Books/forced-close-unflushed.pdf");
  view.file = file;
  view.documentFile = file;
  view.requestedPath = file.path;
  view.ready = true;
  view.simulateSdkFileUnloadOnClose = true;
  const sent = [];
  const frame = {
    postMessage(message) {
      sent.push(message);
      if (message.type === "flush") {
        view.onMessage({
          source: frame,
          data: {
            channel: "pdf-web-reader",
            token: view.token,
            type: "flushed",
            documentId: view.documentId,
            id: message.id,
            ok: false,
            dirty: true,
          },
        });
      }
    },
    remove() {
      this.removed = true;
    },
  };
  view.iframe = { contentWindow: frame, remove: () => frame.remove() };

  await view.onClose();

  assert.equal(view.teardownStarted, true);
  assert.equal(sent.filter((message) => message.type === "flush").length, 1);
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 0);
  assert.equal(view.file, null, "The simulated SDK unload still clears its file reference");
  assert.equal(view.iframe, null);
  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0], /尚有未确认的更改/);
});

test("close waits for the bridge flush response before removing the frame", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const file = new harness.TFile("Books/close.pdf");
  view.file = file;
  view.requestedPath = file.path;
  view.ready = true;
  const sent = [];
  const frame = {
    postMessage(message) {
      sent.push(message);
      if (message.type === "flush") {
        view.onMessage({
          source: frame,
          data: {
            channel: "pdf-web-reader",
            token: view.token,
            type: "flushed",
            documentId: view.documentId,
            id: message.id,
            ok: true,
            dirty: false,
          },
        });
      }
    },
  };
  view.iframe = { contentWindow: frame, remove() { this.removed = true; } };

  await view.onClose();

  assert.equal(sent[0].type, "flush");
  assert.equal(sent[0].documentId, view.documentId);
  assert.equal(view.iframe, null);
  assert.equal(harness.notices.length, 0);
});

test("controlled detach waits for a prepared ack and skips duplicate onClose flush", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { leaf, view, sent, replyClose } = await createControlledReader(
    harness,
    new harness.TFile("Books/controlled-detach.pdf"),
  );

  const detaching = leaf.detach();
  await Promise.resolve();

  assert.equal(leaf.detached, undefined, "The SDK detach must wait for the bridge gate");
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1);
  assert.equal(sent.some((message) => message.type === "flush"), false);
  replyClose({ revision: 6 });
  await detaching;
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(leaf.detachCalls, 1);
  assert.equal(leaf.detached, true);
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1);
  assert.equal(sent.some((message) => message.type === "flush"), false);
  assert.equal(view.iframe, null);
});

test("failed controlled detach keeps the Reader leaf open and sends cancel-close", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { leaf, sent, replyClose } = await createControlledReader(
    harness,
    new harness.TFile("Books/blocked-detach.pdf"),
  );

  const detaching = leaf.detach();
  await Promise.resolve();
  replyClose({ ok: false, dirty: true, prepared: false });
  const result = await detaching;

  assert.equal(result, false);
  assert.equal(leaf.detached, undefined);
  assert.equal(harness.leaves.includes(leaf), true);
  assert.ok(sent.some((message) => message.type === "cancel-close"));
  assert.ok(harness.notices.some((notice) => notice.includes("标签保持打开")));
});

test("controlled detach rejects a close ack for a different open request", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { leaf, view, sent, frame } = await createControlledReader(
    harness,
    new harness.TFile("Books/stale-close-ack.pdf"),
  );

  const detaching = leaf.detach();
  await Promise.resolve();
  const request = sent.find((message) => message.type === "prepare-close");
  view.onMessage({
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "close-prepared",
      id: request.id,
      documentId: request.documentId,
      openRequest: request.openRequest + 1,
      revision: 99,
      ok: true,
      dirty: false,
      prepared: true,
    },
  });
  const result = await detaching;
  assert.equal(result, false);
  assert.equal(leaf.detached, undefined);
  assert.ok(sent.some((message) => message.type === "cancel-close"));
});

test("controlled detach accepts a durable recovery draft", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { leaf, sent, replyClose } = await createControlledReader(
    harness,
    new harness.TFile("Books/recovered-detach.pdf"),
  );

  const detaching = leaf.detach();
  await Promise.resolve();
  replyClose({
    ok: false,
    dirty: true,
    recovered: true,
    prepared: true,
    revision: 11,
  });
  await detaching;

  assert.equal(leaf.detached, true);
  assert.equal(sent.some((message) => message.type === "cancel-close"), false);
  assert.ok(harness.notices.some((notice) => notice.includes("已保留恢复副本")));
});

test("popout beforeunload waits for every Reader and resumes after a failed close", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-close.pdf"),
  );
  const { ownerWindow, popout } = attachReadersToPopout(harness, [reader]);
  const gate = harness.plugin.popoutCloseGates.get(ownerWindow);
  assert.ok(gate);

  const failedAttempt = { returnValue: true };
  assert.equal(ownerWindow.dispatchEvent("beforeunload", failedAttempt), false);
  assert.equal(failedAttempt.defaultPrevented, true);
  assert.equal(failedAttempt.immediateStopped, true);
  assert.equal(popout.sdkBeforeUnloadCalls, 0,
    "The capture gate must stop Obsidian's synchronous beforeunload close handler");
  await settleMicrotasks();
  assert.equal(popout.originalCloseCalls, 0);
  assert.equal(popout.destroyWindowCalls, 0);
  assert.equal(ownerWindow.closed, false);
  assert.equal(reader.sent.filter((message) => message.type === "prepare-close").length, 1);

  const firstClose = gate.closePromise;
  reader.replyClose({ ok: false, dirty: true, prepared: false });
  assert.equal(await firstClose, false);
  assert.equal(popout.originalCloseCalls, 0);
  assert.equal(ownerWindow.closed, false);
  assert.equal(reader.leaf.detached, undefined);
  assert.ok(reader.sent.some((message) => message.type === "cancel-close"));

  const retry = { returnValue: true };
  assert.equal(ownerWindow.dispatchEvent("beforeunload", retry), false);
  await settleMicrotasks();
  const successfulClose = gate.closePromise;
  reader.replyClose({ revision: 12 });
  await successfulClose;

  assert.equal(popout.originalCloseCalls, 1);
  assert.equal(popout.destroyWindowCalls, 1);
  assert.equal(ownerWindow.closed, true);
  assert.equal(reader.leaf.detached, true);
  assert.equal(popout.detachResults[0], reader.leaf,
    "Prepared detach must stay synchronous while the SDK parent ignores its return value");
  assert.equal(reader.sent.some((message) => message.type === "flush"), false);
});

test("last prepared Reader leaf lets the SDK parent close synchronously", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-last-reader.pdf"),
  );
  const { ownerWindow, popout } = attachReadersToPopout(harness, [reader]);
  const gate = harness.plugin.popoutCloseGates.get(ownerWindow);
  let releaseOnClose;
  reader.view.onCloseBarrier = new Promise((resolve) => {
    releaseOnClose = resolve;
  });

  const detach = reader.leaf.detach();
  await settleMicrotasks();
  assert.equal(popout.destroyWindowCalls, 0);
  reader.replyClose({ revision: 18 });
  await detach;
  assert.equal(reader.leaf.detached, true);
  assert.equal(popout.leaves.length, 0);
  assert.equal(reader.view.hasPreparedClose(reader.view.documentId, reader.view.openRequest), true);

  popout.deferWindowClose = true;
  const parentClose = popout.close();
  assert.equal(parentClose, undefined,
    "The prepared-only path must call the SDK close synchronously, not return a Promise");
  assert.equal(popout.originalCloseCalls, 1);
  assert.equal(popout.destroyWindowCalls, 1);
  assert.equal(gate.allowClose, true,
    "A committed close keeps the beforeunload gate open through delayed SDK teardown");
  assert.equal(ownerWindow.closed, false,
    "The SDK may dispatch beforeunload after its synchronous close method returns");
  await settleMicrotasks();
  assert.equal(ownerWindow.closed, true);
  assert.equal(ownerWindow.lastBeforeUnloadEvent.defaultPrevented, false,
    "The late beforeunload must not be intercepted after root.win is cleared");

  releaseOnClose();
  await settleMicrotasks();
});

test("an uncommitted prepared parent close cancels the freeze and resets the gate", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-close-not-committed.pdf"),
  );
  const { ownerWindow, popout } = attachReadersToPopout(harness, [reader]);
  const gate = harness.plugin.popoutCloseGates.get(ownerWindow);

  const prepare = reader.view.prepareControlledClose("detach");
  await settleMicrotasks();
  reader.replyClose({ revision: 19 });
  assert.equal(await prepare, true);
  assert.equal(reader.view.hasPreparedClose(reader.view.documentId, reader.view.openRequest), true);

  popout.failBeforeDestroy = true;
  assert.equal(popout.close(), false,
    "A close method that leaves the owner window attached must be treated as uncommitted");
  assert.equal(gate.allowClose, false);
  assert.equal(gate.closeCommitted, false);
  assert.equal(reader.view.preparedClose, null,
    "A close that did not commit must unfreeze the Reader");
  assert.equal(ownerWindow.closed, false);
  assert.equal(reader.leaf.detached, undefined);
  assert.ok(harness.notices.some((notice) => notice.includes("无法关闭 PDF 弹出窗口")));
});

test("popout parent close cancels already prepared Readers if another Reader fails", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-first.pdf"),
  );
  const second = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-second.pdf"),
  );
  const { ownerWindow, popout } = attachReadersToPopout(harness, [first, second]);

  const close = popout.close();
  await settleMicrotasks();
  assert.equal(first.sent.filter((message) => message.type === "prepare-close").length, 1);
  assert.equal(second.sent.filter((message) => message.type === "prepare-close").length, 1);
  assert.equal(popout.destroyWindowCalls, 0);

  first.replyClose({ revision: 3 });
  second.replyClose({ ok: false, dirty: true, prepared: false });
  assert.equal(await close, false);
  assert.equal(popout.originalCloseCalls, 0);
  assert.equal(popout.destroyWindowCalls, 0);
  assert.equal(ownerWindow.closed, false);
  assert.equal(first.leaf.detached, undefined);
  assert.equal(second.leaf.detached, undefined);
  assert.equal(first.view.preparedClose, null,
    "A successful peer must be unfrozen when any Reader cannot prepare");
  assert.ok(first.sent.some((message) => message.type === "cancel-close"));
});

test("popout close aborts if a new Reader joins while close preparation is pending", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-before-add.pdf"),
  );
  const { ownerWindow, ownerDocument, popout } = attachReadersToPopout(harness, [first]);

  const close = popout.close();
  await settleMicrotasks();
  const added = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-added.pdf"),
  );
  added.view.contentEl.ownerDocument = ownerDocument;
  added.view.iframe.ownerDocument = ownerDocument;
  added.view.iframe.contentWindow.parent = ownerWindow;
  added.leaf.popoutRoot = popout;
  added.leaf.parent = popout;
  popout.leaves.push(added.leaf);
  added.view.bindOwnerWindow();

  first.replyClose({ revision: 4 });
  assert.equal(await close, false);
  assert.equal(popout.originalCloseCalls, 0);
  assert.equal(ownerWindow.closed, false);
  assert.equal(first.view.preparedClose, null);
  assert.equal(first.leaf.detached, undefined);
  assert.equal(added.leaf.detached, undefined);
  assert.ok(first.sent.some((message) => message.type === "cancel-close"));
});

test("popout close aborts when a Reader document session changes before its ack", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-session-change.pdf"),
  );
  const { ownerWindow, popout } = attachReadersToPopout(harness, [reader]);

  const close = popout.close();
  await settleMicrotasks();
  const request = reader.sent.find((message) => message.type === "prepare-close");
  assert.ok(request);
  reader.view.documentId = "rotated-document-session";
  reader.view.openRequest += 1;
  reader.replyClose({ revision: 8 });

  assert.equal(await close, false);
  assert.equal(popout.originalCloseCalls, 0);
  assert.equal(ownerWindow.closed, false);
  assert.equal(reader.leaf.detached, undefined);
  assert.ok(reader.sent.some((message) => message.type === "cancel-close"));
});

test("popout owner migration releases the former gate and unload preserves later close wrappers", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-migration-cleanup.pdf"),
  );
  const first = attachReadersToPopout(harness, [reader]);
  const firstGate = harness.plugin.popoutCloseGates.get(first.ownerWindow);
  assert.ok(firstGate);
  const originalFirstClose = firstGate.originalClose;

  const other = await createControlledReader(
    harness,
    new harness.TFile("Books/other-popout-reader.pdf"),
  );
  const second = attachReadersToPopout(harness, [other]);
  reader.view.contentEl.ownerDocument = second.ownerDocument;
  reader.view.iframe.ownerDocument = second.ownerDocument;
  reader.view.iframe.contentWindow.parent = second.ownerWindow;
  reader.leaf.popoutRoot = second.popout;
  reader.leaf.parent = second.popout;
  second.popout.leaves.push(reader.leaf);
  harness.emitWorkspace("layout-change");

  assert.equal(reader.view.ownerWindow, second.ownerWindow);
  assert.equal(harness.plugin.popoutCloseGates.has(first.ownerWindow), false);
  assert.equal(first.popout.close, originalFirstClose);
  assert.equal(first.ownerWindow.listeners.get("beforeunload").has(firstGate.beforeUnloadListener), false);
  const secondGate = harness.plugin.popoutCloseGates.get(second.ownerWindow);
  assert.ok(secondGate);
  assert.equal(secondGate.views.has(reader.view), true);

  const installedClose = second.popout.close;
  let laterWrapperCalls = 0;
  const laterWrapper = function (...args) {
    laterWrapperCalls += 1;
    return installedClose.apply(this, args);
  };
  second.popout.close = laterWrapper;
  reader.view.ready = false;
  other.view.ready = false;
  harness.plugin.onunload();

  assert.equal(second.popout.close, laterWrapper,
    "Unload must leave a wrapper installed later by another plugin intact");
  assert.equal(second.ownerWindow.listeners.get("beforeunload").has(secondGate.beforeUnloadListener), false);
  second.popout.close();
  assert.equal(laterWrapperCalls, 1);
  assert.equal(second.popout.originalCloseCalls, 1,
    "The preserved outer wrapper must delegate through the inactive shim to the SDK");
});

test("popout close falls back with a notice when the SDK split cannot be verified", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const ownerWindow = view.getOwnerWindow();
  ownerWindow.document.body.classList.add("is-popout-window");
  view.bindOwnerWindow();

  assert.equal(harness.plugin.popoutCloseGates.size, 0);
  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0], /无法确认此 PDF 弹出窗口的安全关闭入口/);
});

test("same-leaf PDF switch prepares the old document before FileView unload", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = new harness.TFile("Books/switch-before.pdf");
  const second = new harness.TFile("Books/switch-after.pdf");
  harness.files.set(second.path, second);
  const { leaf, view, sent, replyClose } = await createControlledReader(harness, first);
  const oldDocumentId = view.documentId;

  const switching = leaf.setViewState({
    type: "pdf",
    state: { path: second.path },
  });
  await Promise.resolve();
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1);
  replyClose({ revision: 15 });
  await switching;

  assert.equal(leaf.view, view);
  assert.equal(view.requestedPath, second.path);
  assert.notEqual(view.documentId, oldDocumentId);
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1);
  assert.equal(sent.some((message) => message.type === "flush"), false,
    "onUnloadFile must consume the prepared close instead of flushing twice");
  const open = sent.filter((message) => message.type === "open").at(-1);
  assert.equal(open.openRequest, view.openRequest);
});

test("failed view transition preserves the current PDF leaf and document", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const original = new harness.TFile("Books/transition-blocked.pdf");
  const note = new harness.TFile("Notes/next.md");
  harness.files.set(note.path, note);
  const { leaf, view, sent, replyClose } = await createControlledReader(
    harness,
    original,
  );
  const originalViewState = leaf.lastViewState;

  const switching = leaf.setViewState({
    type: "markdown",
    state: { path: note.path },
  });
  await Promise.resolve();
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1);
  replyClose({ ok: false, dirty: true, prepared: false });
  const result = await switching;

  assert.equal(result, undefined, "A failed close gate must not invoke SDK view replacement");
  assert.equal(leaf.view, view);
  assert.equal(leaf.lastViewState, originalViewState);
  assert.equal(view.documentFile, original);
  assert.equal(view.requestedPath, original.path);
  assert.ok(sent.some((message) => message.type === "cancel-close"));
  assert.equal(sent.some((message) => message.type === "flush"), false);
});

test("unload leaves a later detach wrapper intact and routes it through the inactive shim", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const prototype = harness.WorkspaceLeaf.prototype;
  const installedDetach = prototype.detach;
  const laterWrapper = function (...args) {
    this.laterDetachCalls = (this.laterDetachCalls || 0) + 1;
    return installedDetach.apply(this, args);
  };
  prototype.detach = laterWrapper;

  harness.plugin.onunload();

  assert.equal(prototype.detach, laterWrapper);
  const leaf = harness.createLeaf();
  leaf.detach();
  assert.equal(leaf.laterDetachCalls, 1);
  assert.equal(leaf.detached, true);
});

test("owner-window migration rebinds listeners and startup/flush deadlines", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  view.bindOwnerWindow();
  const oldWindow = view.ownerWindow;
  view.iframe = { contentWindow: { postMessage() {} } };
  view.bridgeTimeoutDeadline = Date.now() + 20000;
  view.scheduleBridgeTimeout();
  const startupTimer = view.bridgeTimeout;
  assert.ok(oldWindow.timers.has(startupTimer));

  const newWindow = harness.makeWindow();
  view.contentEl.ownerDocument.defaultView = newWindow;

  harness.emitWorkspace("layout-change");

  assert.equal(oldWindow.listeners.get("message").has(view.messageListener), false);
  assert.equal(newWindow.listeners.get("message").has(view.messageListener), true);
  assert.equal(oldWindow.timers.has(startupTimer), false);
  assert.ok(newWindow.timers.has(view.bridgeTimeout));
  assert.equal(view.bridgeTimeoutDeadline !== null, true);

  view.ready = true;
  view.requestedPath = "Books/pending-flush.pdf";
  view.clearBridgeTimeout();
  const flushing = view.flushDocument(60000);
  const [request] = view.flushRequests.values();
  const flushTimer = request.timer;
  assert.ok(newWindow.timers.has(flushTimer));

  const finalWindow = harness.makeWindow();
  view.contentEl.ownerDocument.defaultView = finalWindow;
  harness.emitWorkspace("layout-change");

  assert.equal(newWindow.timers.has(flushTimer), false);
  assert.ok(finalWindow.timers.has(request.timer));
  assert.equal(finalWindow.fireTimeout(request.timer), true);
  assert.deepEqual(await flushing, { ok: false, dirty: true, timeout: true });
  assert.equal(view.flushRequests.size, 0);
});

test("close clears other outstanding flush timers", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const file = new harness.TFile("Books/close-pending.pdf");
  view.file = file;
  view.requestedPath = file.path;
  view.ready = true;
  const sent = [];
  const frame = {
    postMessage(message) {
      sent.push(message);
    },
    remove() {
      this.removed = true;
    },
  };
  view.iframe = { contentWindow: frame, remove: () => frame.remove() };
  view.bindOwnerWindow();
  const ownerWindow = view.ownerWindow;

  const pendingFlush = view.flushDocument(60000);
  const [pendingRequest] = view.flushRequests.values();
  const timer = pendingRequest.timer;
  assert.ok(ownerWindow.timers.has(timer));
  view.ready = false;

  await view.onClose();

  assert.equal(sent.length, 1, "close does not start a second flush after the bridge is gone");
  assert.equal(ownerWindow.timers.has(timer), false);
  assert.equal(view.flushRequests.size, 0);
  assert.deepEqual(await pendingFlush, { ok: false, dirty: true });
  assert.equal(view.iframe, null);
});

test("recovery command creates a separate visible PDF copy", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  view.file = new harness.TFile("Books/recover.pdf");
  const record = await harness.plugin.writeRecoveryCandidate({
    view,
    data: Uint8Array.from([9, 8, 7]).buffer,
    originalBytes: Uint8Array.from([1, 2, 3]),
    documentPath: view.file.path,
    revision: 12,
    origin: "auto",
  });
  await harness.plugin.markRecoveryCandidate(record, { status: "conflict" });

  const restoredPath = await harness.plugin.restoreLatestRecovery();

  assert.match(restoredPath, /^PDF Recovery\/recover \(Recovered /);
  assert.deepEqual([...harness.files.get(restoredPath).bytes], [9, 8, 7]);
  assert.equal((await harness.plugin.listRecoveryCandidates()).length, 1,
    "Restore must leave the original recovery candidate intact");
});

test("recovery metadata is written before bytes and failed candidates leave no orphan", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  view.file = new harness.TFile("Books/recovery-order.pdf");
  const adapter = harness.app.vault.adapter;
  const write = adapter.write.bind(adapter);
  const writeBinary = adapter.writeBinary.bind(adapter);
  const order = [];
  adapter.write = async (...args) => {
    order.push("metadata");
    return write(...args);
  };
  adapter.writeBinary = async (...args) => {
    order.push("binary");
    return writeBinary(...args);
  };

  const record = await harness.plugin.writeRecoveryCandidate({
    view,
    data: Uint8Array.from([9, 8, 7]).buffer,
    originalBytes: Uint8Array.from([1, 2, 3]),
    documentPath: view.file.path,
    revision: 1,
    origin: "auto",
  });
  assert.deepEqual(order, ["metadata", "binary"]);
  await harness.plugin.removeRecoveryCandidate(record);
  assert.equal(harness.storedFiles.size, 0);

  order.length = 0;
  adapter.write = async (...args) => {
    order.push("metadata");
    throw new Error("metadata write failed");
  };
  await assert.rejects(
    harness.plugin.writeRecoveryCandidate({
      view,
      data: Uint8Array.from([4, 5, 6]).buffer,
      originalBytes: Uint8Array.from([1, 2, 3]),
      documentPath: view.file.path,
      revision: 2,
      origin: "auto",
    }),
    /metadata write failed/,
  );
  assert.deepEqual(order, ["metadata"]);
  assert.equal(harness.storedFiles.size, 0, "No unindexed recovery bytes are written");

  adapter.write = write;
  adapter.writeBinary = async (...args) => {
    order.push("binary-failed");
    throw new Error("binary write failed");
  };
  await assert.rejects(
    harness.plugin.writeRecoveryCandidate({
      view,
      data: Uint8Array.from([4, 5, 6]).buffer,
      originalBytes: Uint8Array.from([1, 2, 3]),
      documentPath: view.file.path,
      revision: 3,
      origin: "auto",
    }),
    /binary write failed/,
  );
  assert.equal(harness.storedFiles.size, 0, "A failed binary write removes its pending metadata");
  assert.equal((await harness.plugin.listRecoveryCandidates()).length, 0);
});
