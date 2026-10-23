import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { PDFDocument } from "pdf-lib";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";
import { VocabularyController } from "../viewer-adapter/vocabulary/controller.js";
import { scanPageTextLayer } from "../viewer-adapter/vocabulary/page-scanner.js";



const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRequire = createRequire(path.join(root, "plugin", "main.js"));
const { encodeReaderLinkFragment, parseReaderLinkFragment } = sourceRequire("./reader-anchor-store.cjs");

function createHarness({
  storedFiles = new Map(),
  directories = new Set([".obsidian"]),
  inspectLegacy = null,
  storageProtocol = "format3",
} = {}) {
  const notices = [];
  const openedModals = [];
  const files = new Map();
  const leaves = [];
  const vaultEvents = new Map();
  const workspaceEvents = new Map();
  const metadataCacheEvents = new Map();
  const metadataCaches = new Map();
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
      this.stat = { size: this.bytes.byteLength, mtime: 1 };
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

  class EditableFileView extends FileView {
    syncState() {}
  }

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
      this.containerEl = {
        settings: [],
        headings: [],
        empty() { this.settings.length = 0; this.headings.length = 0; },
        createEl(tag, options = {}) {
          const element = { tag, ...options };
          if (tag === "h3") this.headings.push(element.text);
          return element;
        },
      };
    }
  }

  class Setting {
    constructor(containerEl) {
      this.containerEl = containerEl;
      containerEl.settings?.push(this);
      this.settingEl = { classList: { add() {} } };
    }
    setName(value) { this.name = value; return this; }
    setDesc(value) { this.description = value; return this; }
    addToggle(callback) {
      const toggle = {
        value: undefined,
        handler: null,
        setValue(value) { this.value = value; return this; },
        onChange(handler) { this.handler = handler; return this; },
        change(value) { this.value = value; return this.handler?.(value); },
      };
      callback(toggle);
      this.toggle = toggle;
      return this;
    }
    addButton(callback) {
      const classes = new Set();
      const button = {
        text: "",
        tooltip: "",
        handler: null,
        buttonEl: {
          attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          classList: {
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); },
          },
        },
        setButtonText(value) { this.text = value; return this; },
        setTooltip(value) { this.tooltip = value; return this; },
        onClick(handler) { this.handler = handler; return this; },
        click() { return this.handler?.(); },
      };
      callback(button);
      (this.buttons ||= []).push(button);
      return this;
    }
  }

  class Modal {
    constructor(app) {
      this.app = app;
      this.contentEl = {
        children: [],
        empty() { this.children = []; },
        createEl(tag, options = {}) {
          const listeners = new Map();
          const element = { tag, textContent: options.text || "", listeners,
            addEventListener(type, callback) { listeners.set(type, callback); } };
          this.children.push(element);
          return element;
        },
      };
    }
    open() { openedModals.push(this); this.onOpen?.(); }
    close() { this.closed = true; this.onClose?.(); }
  }

  const obsidian = {
    EditableFileView,
    FileView,
    ItemView,
    Modal,
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
      if (name === "./vocabulary/workbench.cjs") return { createVocabularyWorkbench: () => class {
        constructor(app, api) { this.app = app; this.api = api; }
        open() { this.opened = true; }
        close() { this.closed = true; }
      } }; // real DOM and factory behavior run in the Workbench browser gate
      if (name === "./vocabulary/workspace.cjs") return { ...sourceRequire(name),
        // This fixture represents one stable installation across restarts.
        // Persistence/unavailability is independently tested by device-identity.
        localVocabularyDeviceId: () => "host-test-device" };
      if (name === "./pdf-annotation-host.cjs" && storageProtocol === "format3") {
        // Preserve the exact Format 3 golden assertions and race barriers.
        // WAL-specific cases below exercise the new production default.
        const { createPdfAnnotationHost } = sourceRequire(name);
        const { createPdfAnnotationStore } = sourceRequire("./pdf-annotation-store.cjs");
        return { createPdfAnnotationHost: (options) => createPdfAnnotationHost({ ...options, storeFactory: createPdfAnnotationStore }) };
      }
      return sourceRequire(name);
    },
    moduleObject,
    moduleObject.exports,
  );

  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: (filePath) => files.get(filePath) || null,
      getMarkdownFiles: () => [...files.values()].filter((file) =>
        typeof file?.path === "string" && file.path.toLowerCase().endsWith(".md")),
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
        async append(filePath, value) {
          storedFiles.set(filePath, `${storedFiles.get(filePath) || ""}${String(value)}`);
        },
        async rename(fromPath, toPath) {
          if (!storedFiles.has(fromPath)) throw new Error(`Missing rename source: ${fromPath}`);
          if (storedFiles.has(toPath)) throw new Error(`Rename target exists: ${toPath}`);
          storedFiles.set(toPath, storedFiles.get(fromPath));
          storedFiles.delete(fromPath);
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
    metadataCache: {
      on: (name, listener) => addListener(metadataCacheEvents, name, listener),
      getFileCache: (file) => metadataCaches.get(file?.path) || null,
    },
  };

  withAtomicProcess(app.vault.adapter, storedFiles);
  const plugin = new moduleObject.exports(app, { id: "pdf-web-reader" });
  if (inspectLegacy) {
    plugin.legacyMergeClient = {
      inspect: inspectLegacy,
      dispose() {},
    };
  }
  return {
    app,
    files,
    leaves,
    notices,
    openedModals,
    plugin,
    TFile,
    WorkspaceLeaf,
    storedFiles,
    workspaceEvents,
    vaultEvents,
    metadataCacheEvents,
    metadataCaches,
    emitWorkspace: (name, ...args) => emit(workspaceEvents, name, ...args),
    emitVault: (name, ...args) => emit(vaultEvents, name, ...args),
    emitMetadataCache: (name, ...args) => emit(metadataCacheEvents, name, ...args),
    setFileCache(file, cache) { metadataCaches.set(file.path, cache); },
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

test("WAL production host saves, reopens and renames without source writes or Format 3 output", async () => {
  const storedFiles = new Map(), directories = new Set([".obsidian"]);
  const first = createHarness({ storedFiles, directories, storageProtocol: "wal" });
  await first.plugin.onload();
  const source = Uint8Array.from([37, 80, 68, 70, 10, 1, 2, 3]);
  const file = new first.TFile("Books/wal-main.pdf", source);
  const reader = await createSidecarReader(first, file);
  const documentId = reader.view.documentId;
  const ack = await saveSidecarOperations(reader, { requestId: "wal-main-edit" });
  assert.equal(ack.type, "saved");
  assert.equal(ack.operationCount, 1);
  assert.ok(ack.batchId);
  assert.equal(file.writes, 0);
  assert.deepEqual(file.bytes, source);
  assert.ok([...storedFiles.keys()].some((name) => name.includes("/wal/") && name.endsWith(".jsonl")));
  assert.equal([...storedFiles.keys()].some((name) => /\/(ops|checkpoints|identity-events)\//.test(name)), false);
  first.plugin.onunload();

  const reopened = createHarness({ storedFiles, directories, storageProtocol: "wal" });
  await reopened.plugin.onload();
  const reopenedFile = new reopened.TFile("Books/wal-main.pdf", source);
  const second = await createSidecarReader(reopened, reopenedFile);
  assert.equal(second.view.documentId, documentId);
  assert.equal(second.view.annotationSyncState.storageProtocol, "wal-sidecar-v3.2-jsonl");
  assert.deepEqual(second.view.annotationSyncState.annotations.map((row) => row.uuid), ["annotation-wal-main-edit"]);
  const oldPath = reopenedFile.path;
  reopened.files.delete(oldPath);
  reopenedFile.path = "Archive/wal-renamed.pdf";
  reopened.files.set(reopenedFile.path, reopenedFile);
  await reopened.plugin.annotationHost.renamed(reopenedFile, oldPath);
  const moved = await reopened.plugin.annotationHost.store.documentForPath(reopenedFile.path);
  assert.equal(moved.documentId, documentId);
  assert.equal(await reopened.plugin.annotationHost.store.documentForPath(oldPath), null);
  assert.equal(reopenedFile.writes, 0);
  reopened.plugin.onunload();
});

test("WAL production multi-view saves are serialized and close only after the matching confirmation", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  const file = new harness.TFile("Books/wal-multiview.pdf", [1, 2, 3]);
  const a = await createSidecarReader(harness, file), b = await createSidecarReader(harness, file);
  const results = await Promise.all([
    saveSidecarOperations(a, { requestId: "wal-a" }), saveSidecarOperations(b, { requestId: "wal-b" }),
  ]);
  assert.ok(results.every((result) => result.type === "saved" && result.operationCount === 1));
  const snapshot = await harness.plugin.annotationHost.store.readDocument(a.view.annotationDocument);
  assert.deepEqual(snapshot.annotations.map((row) => row.uuid).sort(), ["annotation-wal-a", "annotation-wal-b"]);
  const close = a.view.onClose();
  const flush = await waitForSentMessage(a, (message) => message.type === "flush");
  assert.ok(a.view.iframe, "the Reader remains alive until its matching save confirmation");
  a.view.onMessage({ source: a.frame, data: { channel: "pdf-web-reader", token: a.view.token,
    type: "flushed", id: flush.id, documentId: a.view.documentId,
    openRequest: a.view.openRequest, revision: 1, confirmedRevision: 1, dirty: false, ok: true } });
  await close;
  assert.equal(a.view.iframe, null);
  assert.equal(file.writes, 0);
  harness.plugin.onunload();
});

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

async function confirmViewerPageIdentity(harness, reader, {
  pageCount = 1,
  orderedPageIdentities = ["4 0 R"],
} = {}) {
  const { view } = reader;
  const message = {
    type: "annotation-source-identity",
    documentId: view.documentId,
    openRequest: view.openRequest,
    pageCount,
    orderedPageIdentities,
  };
  await harness.plugin.annotationHost.handleMessage(view, message);
  return message;
}

async function createSidecarReader(harness, file, identity = {}) {
  const reader = await createControlledReader(harness, file);
  const { view, frame } = reader;
  view.ready = false;
  view.onMessage({
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });
  const open = reader.sent.find((message) => message.type === "open");
  assert.ok(open, "the ready Viewer receives its PDF and provisional sidecar snapshot");
  view.onMessage({
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "opened",
      documentId: view.documentId,
      openRequest: view.openRequest,
      revision: 0,
      confirmedRevision: 0,
      dirty: false,
      restorePaused: false,
    },
  });
  await confirmViewerPageIdentity(harness, reader, identity);
  return reader;
}

async function waitForSentMessage(reader, predicate, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const message = reader.sent.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("Timed out waiting for the expected Viewer bridge message");
}

function makeWrappedVocabularyFixture() {
  const unitRects = new Map([
    ["wrapped-first:5", { top: 10, left: 70, width: 5, height: 12 }],
    ["wrapped-second:0", { top: 24, left: 4, width: 7, height: 12 }],
  ]);
  const segmentRects = new Map();
  let textLayer;
  const documentRef = {
    body: {
      children: [],
      appendChild(node) { node.parentNode = this; this.children.push(node); return node; },
      removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; return node; },
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(), dataset: {}, style: {}, attributes: {}, childNodes: [], listeners: new Map(),
        classList: { toggle() {} },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(type, listener) { this.listeners.set(type, listener); },
        appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; },
        append(...nodes) { nodes.forEach((node) => this.appendChild(node)); },
        getBoundingClientRect() { return { width: 320, height: 180 }; },
        remove() { this.parentNode?.removeChild?.(this); },
      };
    },
    createRange() {
      let startNode = null;
      let startOffset = 0;
      return {
        setStart(node, offset) { startNode = node; startOffset = offset; },
        setEnd() {},
        getBoundingClientRect() { return unitRects.get(`${startNode?.id}:${startOffset}`) || null; },
        getClientRects() { return segmentRects.get(startNode) || []; },
        detach() {},
      };
    },
  };
  const makeText = (value, id) => ({
    id, nodeType: 3, nodeName: "#text", nodeValue: value, data: value, length: value.length,
    ownerDocument: documentRef, isConnected: true, parentNode: null,
  });
  const firstLine = makeText("compa-", "wrapped-first");
  const secondLine = makeText("rable", "wrapped-second");
  segmentRects.set(firstLine, [{ left: 10, top: 10, right: 74, bottom: 22, width: 64, height: 12 }]);
  segmentRects.set(secondLine, [{ left: 4, top: 24, right: 38, bottom: 36, width: 34, height: 12 }]);
  textLayer = {
    nodeType: 1, tagName: "DIV", childNodes: [firstLine, secondLine], ownerDocument: documentRef,
    contains(node) { return node === this || node === firstLine || node === secondLine; },
  };
  firstLine.parentNode = textLayer;
  secondLine.parentNode = textLayer;
  const pageRoot = {
    ownerDocument: documentRef,
    querySelector(selector) { return selector === ".textLayer" ? textLayer : null; },
    contains(node) { return node === this || node === textLayer || textLayer.contains(node); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 800 }; },
  };
  textLayer.parentNode = pageRoot;
  return { documentRef, firstLine, pageRoot, textLayer };
}

async function saveSidecarOperations(reader, {
  requestId = "sidecar-save",
  revision = 1,
  batchId,
  operations = [{
    uuid: `annotation-${requestId}`,
    kind: "Highlight",
    pageIndex: 0,
    deleted: false,
    payload: { editor: { type: "highlight", color: [1, 1, 0] } },
  }],
  origin = "manual",
} = {}) {
  const { view } = reader;
  await view.saveFile(null, view.documentId, requestId, revision, origin, {
    openRequest: view.openRequest,
    batchId,
    operations,
  });
  return reader.sent.at(-1);
}

async function seedRecoveryCandidate(harness, {
  candidateId,
  originalPath = "Books/recovered.pdf",
  filename = path.basename(originalPath),
  bytes,
  status = "draft",
  requestId = candidateId,
  reason = "legacy-recovery",
  rawmeta = false,
  primary = true,
  metadataOverrides = {},
} = {}) {
  const data = Uint8Array.from(bytes || []);
  const directory = `${harness.app.vault.configDir}/plugins/${harness.plugin.manifest.id}/.recovery`;
  const metadataPath = `${directory}/${candidateId}.json`;
  const candidatePath = `${directory}/${candidateId}.pdf`;
  const metadata = {
    schema: 1,
    documentId: `legacy-${candidateId}`,
    candidateId,
    originalPath,
    filename,
    openRequest: 1,
    revision: 1,
    origin: "recovery",
    requestId,
    reason,
    candidateFile: `${candidateId}.pdf`,
    createdAt: "2026-10-14T01:00:00.000Z",
    status,
    completed: true,
    outputHash: createHash("sha256").update(data).digest("hex"),
    outputLength: data.byteLength,
    ...metadataOverrides,
  };
  await harness.app.vault.adapter.mkdir(directory);
  await harness.app.vault.adapter.writeBinary(candidatePath,
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (primary) await harness.app.vault.adapter.write(metadataPath, JSON.stringify(metadata));
  if (rawmeta) await harness.app.vault.adapter.write(`${directory}/${candidateId}.rawmeta`, JSON.stringify(metadata));
  return {
    metadata,
    directory,
    metadataPath,
    candidatePath,
    rawmetaPath: `${directory}/${candidateId}.rawmeta`,
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

test("mobile host save slots reject stale queued Readers and accept only the matching lease borrower", async () => {
  const harness = createHarness();
  harness.app.isMobile = true;
  await harness.plugin.onload();
  const a = await createControlledReader(harness, new harness.TFile("Books/lease-a.pdf", [1, 2, 3]));
  const b = await createControlledReader(harness, new harness.TFile("Books/lease-b.pdf", [1, 2, 3]));
  const send = (reader, fields) => reader.view.onMessage({ source: reader.frame, data: {
    channel: "pdf-web-reader", token: reader.view.token, rendererGeneration: reader.view.rendererGeneration,
    documentId: reader.view.documentId, openRequest: reader.view.openRequest, ...fields,
  } });
  send(a, { type: "heavy-acquire", id: "a" });
  await settleMicrotasks();
  const grant = a.sent.find(m => m.type === "heavy-granted");
  assert.ok(grant?.leaseId);
  const borrower = await harness.plugin.acquireHeavyLease(a.view, a.view.file, "save", grant.leaseId);
  await assert.rejects(async () => harness.plugin.acquireHeavyLease(b.view, b.view.file, "save", grant.leaseId));
  send(b, { type: "heavy-acquire", id: "b" });
  b.view.openRequest += 1;
  send(a, { type: "heavy-release", leaseId: grant.leaseId });
  await settleMicrotasks();
  assert.equal(b.sent.some(m => m.type === "heavy-granted"), false);
  borrower.release();
  await settleMicrotasks();
  assert.equal(b.sent.find(m => m.type === "heavy-rejected")?.id, "b");
  harness.plugin.heavyWork.dispose();
});

test("an explicit close tears down a renderer that cannot confirm flush and warns without changing the PDF", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/failed-flush-close.pdf", [1, 2, 3]);
  const reader = await createControlledReader(harness, file);
  const closing = reader.view.onClose();
  await settleMicrotasks();
  const flush = reader.sent.find((message) => message.type === "flush");
  assert.ok(flush, "close asks the Viewer to confirm its latest annotation state");
  reader.view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: reader.view.token,
      type: "flushed",
      documentId: reader.view.documentId,
      id: flush.id,
      ok: false,
      dirty: true,
      recovered: false,
    },
  });
  await closing;
  assert.equal(harness.plugin.views.has(reader.view), false);
  assert.equal(reader.frame.removed, true, "explicit SDK teardown still removes the unresponsive renderer");
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(file.writes, 0);
  assert.ok(harness.notices.some(message => message.includes("最新更改尚未确认保存")));
});

test("merge metadata preserves the Obsidian EditableFileView syncState method", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  assert.equal(typeof view.syncState, "function");
  assert.equal(Object.hasOwn(view, "syncState"), false);
});

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

test("ACTIVE_DAILY_SIDECAR keeps the PDF immutable and restores durable operations in a new session", async () => {
  const storedFiles = new Map();
  const directories = new Set([".obsidian"]);
  const original = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 1, 2, 3]);
  const firstHarness = createHarness({ storedFiles, directories });
  await firstHarness.plugin.onload();
  const firstFile = new firstHarness.TFile("Books/daily-sidecar.pdf", original);
  const firstReader = await createSidecarReader(firstHarness, firstFile, {
    pageCount: 1,
    orderedPageIdentities: ["12 0 R"],
  });
  const documentId = firstReader.view.documentId;
  const saved = await saveSidecarOperations(firstReader, {
    requestId: "daily-highlight-1",
    batchId: "daily-sidecar-batch-1",
    revision: 1,
    operations: [{
      uuid: "daily-highlight-1",
      kind: "Highlight",
      pageIndex: 0,
      deleted: false,
      payload: { editor: { type: "highlight", color: [1, 0.9, 0] } },
    }],
  });

  assert.equal(saved.type, "saved");
  assert.equal(saved.external, true);
  assert.equal(saved.operationCount, 1);
  assert.deepEqual(firstFile.bytes, original);
  assert.equal(firstFile.writes, 0, "ordinary annotation save never writes the source PDF");
  assert.equal(firstReader.sent.some((message) => message.type === "export-copy"), false,
    "ordinary annotation persistence never asks the Viewer to serialize an export PDF");
  const operationPath = [...storedFiles.keys()].find((path) =>
    path.includes("/ops/") && path.endsWith(".json"));
  assert.ok(operationPath, "the immutable sidecar operation batch is durable before ACK");
  assert.equal(JSON.parse(String(storedFiles.get(operationPath))).batchId, "daily-sidecar-batch-1");
  firstHarness.plugin.onunload();

  const secondHarness = createHarness({ storedFiles, directories });
  await secondHarness.plugin.onload();
  const reopenedFile = new secondHarness.TFile("Books/daily-sidecar.pdf", original);
  const reopened = await createSidecarReader(secondHarness, reopenedFile, {
    pageCount: 1,
    orderedPageIdentities: ["12 0 R"],
  });
  assert.equal(reopened.view.documentId, documentId, "the source path reopens the same annotation identity");
  const restored = Object.values(reopened.view.annotationSyncState.annotations || {})
    .find((operation) => operation.uuid === "daily-highlight-1");
  assert.equal(restored?.payload?.editor?.type, "highlight");
  assert.deepEqual(reopenedFile.bytes, original);
  assert.equal(reopenedFile.writes, 0);
  secondHarness.plugin.onunload();
});

test("ACTIVE_EXPLICIT_EXPORT creates a separate PDF only after an explicit Viewer export response", async () => {
  const sourcePdf = await PDFDocument.create();
  sourcePdf.addPage([300, 400]);
  const sourceBytes = new Uint8Array(await sourcePdf.save());
  const exportPdf = await PDFDocument.create();
  exportPdf.addPage([300, 400]);
  exportPdf.setTitle("PDF Reader export with external annotations");
  const exportBytes = new Uint8Array(await exportPdf.save());

  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/export-source.pdf", sourceBytes);
  const reader = await createSidecarReader(harness, file);
  harness.app.workspace.activeLeaf = reader.leaf;
  const command = harness.plugin.commands.get("export-pdf-with-external-annotations");
  assert.ok(command, "the explicit export command remains registered");

  command.callback();
  const request = reader.sent.find((message) => message.type === "export-copy");
  assert.ok(request, "the host asks the active Viewer for an export only after user invocation");
  assert.deepEqual(file.bytes, sourceBytes);
  assert.equal(file.writes, 0);
  reader.view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: reader.view.token,
      type: "export-ready",
      requestId: request.requestId,
      documentId: request.documentId,
      openRequest: request.openRequest,
      data: exportBytes.buffer.slice(exportBytes.byteOffset, exportBytes.byteOffset + exportBytes.byteLength),
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const outputPath = "Books/export-source (PDF Reader Export).pdf";
  const output = harness.files.get(outputPath);
  assert.ok(output, "the explicit export produces a new visible PDF file");
  assert.deepEqual(output.bytes, exportBytes);
  assert.deepEqual(file.bytes, sourceBytes, "export does not mutate the source PDF");
  assert.equal(file.writes, 0);
  harness.plugin.onunload();
});

test("ACTIVE_LEGACY_MIGRATION imports inspected annotation identity without editing the PDF", async () => {
  const storedFiles = new Map();
  const directories = new Set([".obsidian"]);
  const original = new TextEncoder().encode("%PDF-1.7\n/ObReaderMerge\nlegacy annotation fixture\n%%EOF");
  let inspections = 0;
  const inspectLegacy = async ({ bytes, fastOpen }) => {
    inspections += 1;
    assert.equal(fastOpen, true);
    assert.deepEqual(new Uint8Array(bytes), original,
      "the inspector receives the exact source bytes before identity migration");
    return { identities: [
      { uuid: "migrated-live-ink", ref: "42 0 R", pageIndex: 0, kind: "ink", deleted: false },
      { uuid: "migrated-deleted-mark", ref: "43 0 R", pageIndex: 0, kind: "highlight", deleted: true,
        timestamp: 100, logical: 1, actorId: "old-device", operationId: "old-delete-op" },
    ] };
  };
  const harness = createHarness({ storedFiles, directories, inspectLegacy });
  await harness.plugin.onload();
  const file = new harness.TFile("Books/legacy-sidecar.pdf", original);
  const reader = await createSidecarReader(harness, file, {
    pageCount: 1,
    orderedPageIdentities: ["9 0 R"],
  });

  assert.equal(inspections, 1);
  assert.equal(reader.view.annotationLegacyIdentityUncertain, false);
  assert.equal(reader.view.annotationHydrationAllowed, true);
  assert.equal(reader.view.annotationDocument.legacyIdentityScanComplete, true);
  assert.deepEqual(reader.view.annotationDocument.legacyIdentities.map(({ uuid, ref }) => ({ uuid, ref })), [
    { uuid: "migrated-live-ink", ref: "42 0 R" },
  ]);
  const stored = await harness.plugin.annotationHost.store.readDocument(reader.view.annotationDocument);
  const deleted = stored.tombstones.find((operation) => operation.uuid === "migrated-deleted-mark");
  assert.ok(deleted, "legacy deleted identity becomes a durable sidecar tombstone");
  assert.equal(deleted.embeddedRef, "43 0 R");
  assert.deepEqual(file.bytes, original, "legacy migration leaves embedded PDF bytes unchanged");
  assert.equal(file.writes, 0);
  harness.plugin.onunload();

  const reopenedHarness = createHarness({ storedFiles, directories, inspectLegacy });
  await reopenedHarness.plugin.onload();
  const reopenedFile = new reopenedHarness.TFile("Books/legacy-sidecar.pdf", original);
  const reopened = await createSidecarReader(reopenedHarness, reopenedFile, {
    pageCount: 1,
    orderedPageIdentities: ["9 0 R"],
  });
  assert.equal(reopened.view.annotationDocument.legacyIdentityScanComplete, true,
    "the completed inspection is durable and is not repeated at the next open");
  assert.equal(inspections, 1);
  assert.deepEqual(reopenedFile.bytes, original);
  reopenedHarness.plugin.onunload();
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

test("vocabulary page query requires the current renderer and returns only requested local keys", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  harness.plugin.settings.vocabularyEnabled = true;
  const service = harness.plugin.getVocabularyService();
  await service.upsertTerm("rare word", { type: "phrase", status: 2, translation: "local only" });
  await service.upsertTerm("unrequested", { type: "word", status: 1 });
  await service.upsertTerm("walk", { type: "word", status: 5 });

  const view = harness.createView();
  const sent = [];
  const frame = { postMessage: (message) => sent.push(message) };
  view.iframe = { contentWindow: frame };
  view.rendererGeneration = "renderer-current";
  view.documentId = "vocab-doc-current";
  view.openRequest = 8;
  const send = (rendererGeneration, keys) => view.onMessage({ source: frame, data: {
    channel: "pdf-web-reader", token: view.token, type: "vocab-page-query",
    rendererGeneration, documentId: view.documentId, openRequest: view.openRequest,
    requestId: `query-${rendererGeneration}`, queryId: `page-query-${rendererGeneration}`,
    partIndex: 0, pageNumber: 3, keys,
  } });

  send("renderer-stale", ["rare", "word", "rare word", "walked"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0, "stale generation cannot receive vocabulary data");

  send("renderer-current", ["rare", "word", "rare word", "walked"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reply = sent.find((message) => message.type === "vocab-page-results");
  assert.equal(reply.requestId, "query-renderer-current");
  assert.equal(reply.queryId, "page-query-renderer-current");
  assert.equal(reply.partIndex, 0);
  assert.equal(reply.pageNumber, 3);
  assert.equal(reply.documentId, "vocab-doc-current");
  assert.equal(reply.openRequest, 8);
  assert.deepEqual(reply.records, [
    { key: "rare word", storageKey: "rare word", type: "phrase", status: 2 },
    { key: "walked", storageKey: "walk", type: "word", status: 5 },
  ]);
  assert.equal(JSON.stringify(reply).includes("local only"), false, "notes and translations stay in the host-side modal");
  assert.equal(JSON.stringify(reply).includes("unrequested"), false);
});

test("word popup lookup is identity-bound and vocabulary status replies only after durable host commit", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  harness.plugin.settings.vocabularyEnabled = true;
  const pdfBytes = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 9, 8, 7]);
  const pdfFile = new harness.TFile("Books/vocabulary-immutable.pdf", pdfBytes);
  const reader = await createSidecarReader(harness, pdfFile);
  const { view, frame, sent } = reader;
  view.rendererGeneration = "renderer-vocab";
  view.documentId = "word-click-doc";
  view.openRequest = 11;
  harness.plugin.getVocabularyDictionary = () => ({
    lookup: async (key) => key === "alpha"
      ? { key: "alpha", translation: "阿尔法", phonetic: "ˈælfə", source: "ECDICT" }
      : key === "comparable"
        ? { key: "comparable", translation: "可比较的", phonetic: "ˌkɒmpəˈræbəl", source: "ECDICT" }
        : null,
  });
  sent.length = 0;
  const send = (type, fields = {}, rendererGeneration = "renderer-vocab") => view.onMessage({ source: frame, data: {
    channel: "pdf-web-reader", token: view.token, type, rendererGeneration,
    documentId: view.documentId, openRequest: view.openRequest, ...fields,
  } });
  const wrappedProof = [{
    offset: 5,
    left: { segmentIndex: 0, sourceOffset: 4, text: "a" },
    hyphen: { segmentIndex: 0, sourceOffset: 5, text: "-" },
    right: { segmentIndex: 1, sourceOffset: 0, text: "r" },
  }];

  send("vocab-token-tap", { requestId: "entry-1", pageNumber: 1, key: "alpha", rawSurface: "Alpha", entryType: "word" }, "renderer-old");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0, "stale renderer cannot query the local store");

  send("vocab-token-tap", { requestId: "entry-invalid", pageNumber: 1, key: "comparable",
    rawSurface: "compa-rable", logicalSurface: "unrelated", entryType: "word" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0, "a display surface cannot authorize a different logical lookup key");

  send("vocab-token-tap", { requestId: "entry-unproven-hyphen", pageNumber: 1, key: "wellknown",
    rawSurface: "well-known", logicalSurface: "wellknown", entryType: "word" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sent.length, 0, "a normal lexical hyphen cannot be removed without scanner evidence");

  for (const [requestId, lineHyphenEvidence] of [
    ["entry-fake-offset", [{
      offset: 4,
      left: { segmentIndex: 0, sourceOffset: 3, text: "p" },
      hyphen: { segmentIndex: 0, sourceOffset: 4, text: "a" },
      right: { segmentIndex: 1, sourceOffset: 0, text: "r" },
    }]],
    ["entry-mismatched-neighbor", [{
      ...wrappedProof[0], right: { ...wrappedProof[0].right, text: "x" },
    }]],
    ["entry-too-many-proofs", Array.from({ length: 65 }, () => wrappedProof[0])],
  ]) {
    send("vocab-token-tap", { requestId, pageNumber: 1, key: "comparable",
      rawSurface: "compa-rable", logicalSurface: "comparable", lineHyphenEvidence, entryType: "word" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(sent.length, 0, `${requestId} cannot authorize a vocabulary lookup`);
  }

  send("vocab-set-status", { requestId: "status-unproven-hyphen", entryRequestId: "entry-unproven-hyphen", pageNumber: 1,
    key: "wellknown", rawSurface: "well-known", logicalSurface: "wellknown", status: 5, entryType: "word" });
  send("vocab-set-status", { requestId: "status-fake-offset", entryRequestId: "entry-fake-offset", pageNumber: 1,
    key: "comparable", rawSurface: "compa-rable", logicalSurface: "comparable",
    lineHyphenEvidence: [{ ...wrappedProof[0], offset: 4 }], status: 5, entryType: "word" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await harness.plugin.getVocabularyService().getTerm("wellknown")) ?? null, null,
    "an unproven ordinary hyphen cannot create a durable status record");
  assert.equal((await harness.plugin.getVocabularyService().getTerm("comparable")) ?? null, null,
    "a fabricated status offset cannot create a durable status record");
  assert.equal(sent.some((message) => message.type === "vocab-status-ack"), false,
    "rejected status proofs never receive a durable acknowledgement");

  send("vocab-token-tap", { requestId: "entry-ordinary-hyphen", pageNumber: 1,
    key: "well-known", rawSurface: "well-known", entryType: "word" });
  const ordinaryHyphenEntry = await waitForSentMessage(reader,
    (message) => message.type === "vocab-entry-result" && message.requestId === "entry-ordinary-hyphen");
  assert.equal(ordinaryHyphenEntry.record.key, "well-known",
    "an unmodified ordinary hyphen retains its original lookup identity");

  send("vocab-token-tap", { requestId: "entry-wrapped", pageNumber: 1, key: "comparable",
    rawSurface: "compa-rable", logicalSurface: "comparable", lineHyphenEvidence: wrappedProof, entryType: "word" });
  const wrappedEntry = await waitForSentMessage(reader,
    (message) => message.type === "vocab-entry-result" && message.requestId === "entry-wrapped");
  assert.deepEqual(wrappedEntry.record, {
    key: "comparable", type: "word", hasPersonalRecord: false,
    translation: "可比较的", phonetic: "ˌkɒmpəˈræbəl", dictionaryLookupState: "found",
  }, "a validated logical surface reaches the host dictionary and returns to the pill");

  send("vocab-set-status", { requestId: "status-wrapped", entryRequestId: "entry-wrapped", pageNumber: 1,
    key: "comparable", rawSurface: "compa-rable", logicalSurface: "comparable",
    lineHyphenEvidence: wrappedProof, status: 5, entryType: "word" });
  const wrappedAck = await waitForSentMessage(reader,
    (message) => message.type === "vocab-status-ack" && message.requestId === "status-wrapped");
  assert.equal(wrappedAck.record.key, "comparable");
  assert.equal(wrappedAck.record.storageKey, "comparable");
  assert.equal((await harness.plugin.getVocabularyService().getTerm("comparable")).status, 5,
    "status is saved against the logical vocabulary surface without persisting the visible wrap hyphen");
  const beforeVocabularyMutation = new Map(harness.storedFiles);

  send("vocab-token-tap", { requestId: "entry-1", pageNumber: 1, key: "alpha", rawSurface: "Alpha", entryType: "word" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const entry = sent.find((message) => message.type === "vocab-entry-result" && message.requestId === "entry-1");
  assert.equal(entry.requestId, "entry-1");
  assert.deepEqual(entry.record, {
    key: "alpha", type: "word", hasPersonalRecord: false,
    translation: "阿尔法", phonetic: "ˈælfə", dictionaryLookupState: "found",
  }, "dictionary meaning is returned without inventing a personal learning record");
  assert.equal(entry.documentId, "word-click-doc");
  assert.deepEqual([...harness.storedFiles], [...beforeVocabularyMutation],
    "looking up a missing personal vocabulary record is read-only");

  const service = harness.plugin.getVocabularyService();
  await service.upsertTerm("run", { type: "word", status: 3, translation: "跑" });
  send("vocab-token-tap", { requestId: "entry-run", pageNumber: 2,
    key: "ran", rawSurface: "Ran", entryType: "word" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const runEntry = sent.find((message) => message.type === "vocab-entry-result" && message.requestId === "entry-run");
  assert.deepEqual(runEntry.record, {
    key: "ran", storageKey: "run", status: 3, type: "word", hasPersonalRecord: true,
    translation: "跑", phonetic: "", dictionaryLookupState: "not-found",
  });

  send("vocab-set-status", { requestId: "status-run", entryRequestId: "entry-run", pageNumber: 2,
    key: "running", rawSurface: "Running", status: 5, entryType: "word" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const runAck = sent.find((message) => message.type === "vocab-status-ack" && message.requestId === "status-run");
  assert.equal(runAck.record.key, "running", "ack keeps the request surface identity");
  assert.equal(runAck.record.storageKey, "run", "ack exposes the actual persisted record key");
  assert.equal(runAck.record.status, 5);
  assert.equal((await service.getTerm("run")).status, 5);
  assert.deepEqual(JSON.parse(await service.exportJson()).records.map((record) => record.key), ["comparable", "run"]);

  send("vocab-set-status", { requestId: "status-1", entryRequestId: "entry-1", pageNumber: 1,
    key: "alpha", rawSurface: "Alpha", status: 5, entryType: "word" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const ack = sent.find((message) => message.type === "vocab-status-ack" && message.requestId === "status-1");
  assert.equal(ack.durable, true);
  assert.equal(ack.requestId, "status-1");
  assert.equal(ack.record.status, 5);
  assert.equal((await harness.plugin.getVocabularyService().getTerm("alpha")).status, 5);
  send("vocab-set-status", { requestId: "phrase-status-1", entryRequestId: "phrase-entry-1", pageNumber: 1,
    key: "rare word", rawSurface: "Rare word", status: 2, entryType: "phrase" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const phraseAck = sent.find((message) => message.type === "vocab-status-ack" && message.requestId === "phrase-status-1");
  assert.equal(phraseAck?.record.type, "phrase");
  assert.equal((await harness.plugin.getVocabularyService().getTerm("rare word")).status, 2);
  assert.deepEqual(pdfFile.bytes, pdfBytes, "vocabulary changes never modify source PDF bytes");
  assert.equal(pdfFile.writes, 0, "vocabulary changes never call the source PDF write path");
  const changedPaths = [...new Set([...beforeVocabularyMutation.keys(), ...harness.storedFiles.keys()])]
    .filter((path) => beforeVocabularyMutation.get(path) !== harness.storedFiles.get(path));
  assert.ok(changedPaths.includes("00_Archive/21_VocabularyData/en.vocab.json"));
  assert.ok(changedPaths.every((path) => path === "00_Archive/21_VocabularyData/en.vocab.json" ||
    /^00_Archive\/21_VocabularyData\/history\/host-test-device\/[a-f0-9]{64}\.json$/.test(path)),
    "status mutations change only personal vocabulary and verified reversible History, never PDF/annotation paths");
  const workspaceHistory = await harness.plugin.vocabularyRuntime.history.listBatches();
  assert.ok(workspaceHistory.length >= 3, "each committed status transaction retains its reversible field diff");
  const jsonlBefore = [...beforeVocabularyMutation].filter(([path]) => path.endsWith(".jsonl"));
  const jsonlAfter = [...harness.storedFiles].filter(([path]) => path.endsWith(".jsonl"));
  assert.deepEqual(jsonlAfter, jsonlBefore, "vocabulary status does not write or alter annotation WAL files");
  harness.plugin.onunload();
});

test("scanner proof crosses the authenticated controller-host bridge and commits the logical pill key", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  harness.plugin.settings.vocabularyEnabled = true;
  const pdfFile = new harness.TFile("Books/vocabulary-wrap-e2e.pdf", [37, 80, 68, 70, 45, 49]);
  const reader = await createSidecarReader(harness, pdfFile);
  const { view, frame, sent } = reader;
  harness.plugin.getVocabularyDictionary = () => ({
    lookup: async (key) => key === "comparable"
      ? { key, translation: "可比较的", phonetic: "ˌkɒmpəˈræbəl", source: "ECDICT" }
      : null,
  });

  const fixture = makeWrappedVocabularyFixture();
  const listeners = new Map();
  const eventBus = {
    _on(name, listener) { listeners.set(name, listener); },
    _off(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
  };
  const app = {
    pdfDocument: { numPages: 1 },
    pdfViewer: {
      getPageView(index) { return index === 0 ? { div: fixture.pageRoot } : null; },
      getVisiblePages() { return { views: [{ id: 1 }] }; },
    },
  };
  const windowRef = {
    getSelection() { return { isCollapsed: true, rangeCount: 0 }; },
    innerWidth: 800,
    innerHeight: 600,
    addEventListener() {},
    removeEventListener() {},
  };
  const sentToHost = [];
  const controller = new VocabularyController({
    app,
    eventBus,
    documentRef: fixture.documentRef,
    windowRef,
    postToHost(type, fields) {
      const data = {
        channel: "pdf-web-reader",
        token: view.token,
        type,
        rendererGeneration: view.rendererGeneration,
        documentId: view.documentId,
        openRequest: view.openRequest,
        ...fields,
      };
      sentToHost.push(data);
      view.onMessage({ source: frame, data });
      return true;
    },
    getIdentity: () => ({ documentId: view.documentId, openRequest: view.openRequest }),
    makeId: () => "wrap-e2e",
    scan: scanPageTextLayer,
    makeOverlay: () => ({ draw() {}, clear() {}, dispose() {} }),
  });
  const originalPostMessage = frame.postMessage.bind(frame);
  frame.postMessage = (message) => {
    originalPostMessage(message);
    if (message.type === "vocab-page-results") controller.handlePageResults(message);
    else if (message.type === "vocab-entry-result") controller.handleEntryResult(message);
    else if (message.type === "vocab-status-ack") controller.handleStatusAck(message);
    else if (message.type === "reader-backlink-occurrence-result") controller.handleOccurrenceBacklinks(message);
  };

  controller.setDocument(view.documentId, view.openRequest, true);
  const pageResults = await waitForSentMessage(reader, (message) => message.type === "vocab-page-results");
  assert.equal(controller.handlePageResults(pageResults), false,
    "the simulated Viewer event route already delivered the host page result to the controller");
  const [token] = controller.pages.get("1").tokens;
  assert.equal(token.rawSurface, "compa-rable");
  assert.equal(token.logicalSurface, "comparable");
  assert.equal(token.surfaceKey, "comparable");
  assert.deepEqual(token.lineHyphenEvidence, [{
    offset: 5,
    left: { segmentIndex: 0, sourceOffset: 4, text: "a" },
    hyphen: { segmentIndex: 0, sourceOffset: 5, text: "-" },
    right: { segmentIndex: 1, sourceOffset: 0, text: "r" },
  }], "the proof is produced by the geometry-confirming scanner");

  assert.equal(controller.handleTap({
    type: "click", targetRole: "text-layer", button: 0, detail: 1,
    pageIndex: 0, clientPoint: { x: 30, y: 15 },
  }), true);
  const tap = sentToHost.find((message) => message.type === "vocab-token-tap");
  assert.deepEqual(tap.lineHyphenEvidence, token.lineHyphenEvidence,
    "the controller sends the scanner-generated proof through the authenticated bridge envelope");
  assert.deepEqual({
    channel: tap.channel,
    token: tap.token,
    rendererGeneration: tap.rendererGeneration,
    documentId: tap.documentId,
    openRequest: tap.openRequest,
  }, {
    channel: "pdf-web-reader",
    token: view.token,
    rendererGeneration: view.rendererGeneration,
    documentId: view.documentId,
    openRequest: view.openRequest,
  });

  const entryReply = await waitForSentMessage(reader,
    (message) => message.type === "vocab-entry-result" && message.requestId === tap.requestId);
  assert.equal(entryReply.record.translation, "可比较的");
  assert.equal(controller.entryPill.heading.textContent, "comparable",
    "the actual host dictionary response resolves into the logical word pill");
  assert.equal(controller.entryPill.entry.rawSurface, "compa-rable",
    "the pill retains the physical PDF surface for occurrence checks");

  assert.equal(controller.requestStatusChange(5), true);
  const status = sentToHost.find((message) => message.type === "vocab-set-status");
  assert.deepEqual(status.lineHyphenEvidence, token.lineHyphenEvidence,
    "status reuses the same scanner proof and request identity");
  const statusAck = await waitForSentMessage(reader,
    (message) => message.type === "vocab-status-ack" && message.requestId === status.requestId);
  assert.equal(statusAck.durable, true);
  assert.equal(controller.entryPill.status, 5,
    "the durable host acknowledgement updates the live pill");
  assert.equal((await harness.plugin.getVocabularyService().getTerm("comparable")).status, 5,
    "the host persists the logical term, without creating a raw-hyphen key");
  assert.equal((await harness.plugin.getVocabularyService().getTerm("compa-rable")) ?? null, null);

  controller.dispose();
  harness.plugin.onunload();
});

test("successful vocabulary imports refresh live Readers without refreshing on a skipped no-op", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  harness.plugin.settings.vocabularyEnabled = true;
  const refreshed = [];
  harness.plugin.views.add({ refreshVocabularyPages: () => refreshed.push("reader-a") });
  harness.plugin.views.add({ refreshVocabularyPages: () => refreshed.push("reader-b") });

  const added = await harness.plugin.importVocabulary(
    [{ surface: "borrowed phrase", type: "phrase", status: 2 }], "json");
  assert.equal(added.imported, 1);
  assert.deepEqual(refreshed.sort(), ["reader-a", "reader-b"]);
  assert.equal((await harness.plugin.getVocabularyService().getTerm("borrowed phrase")).status, 2);

  refreshed.length = 0;
  const skipped = await harness.plugin.importVocabulary(
    [{ surface: "borrowed phrase", type: "phrase", status: 1 }], "json");
  assert.equal(skipped.skippedExisting, 1);
  assert.deepEqual(refreshed, [], "unchanged imports do not generate redundant page scans");
});

test("plugin startup migrates an existing personal vocabulary and leaves absent data absent", async () => {
  const absent = createHarness();
  await absent.plugin.onload();
  await absent.plugin.initializeVocabulary();
  assert.equal([...absent.storedFiles.keys()].some((key) => key.startsWith("00_Archive/21_VocabularyData/")), false);
  absent.plugin.onunload();

  const vocabularyPath = "00_Archive/21_VocabularyData/en.vocab.json";
  const storedFiles = new Map([[vocabularyPath, JSON.stringify({
    schema: "pdf-web-reader-vocabulary", schemaVersion: 1, language: "en", revision: 7,
    records: [{ key: "walked", surface: "Walked", type: "word", status: 5,
      translation: "走过", note: "保留笔记", phonetic: "wɔːkt", source: "user", createdAt: 1000, updatedAt: 2000 }],
  })]]);
  const migrated = createHarness({ storedFiles });
  await migrated.plugin.onload();
  await migrated.plugin.initializeVocabulary();
  const snapshot = JSON.parse(storedFiles.get(vocabularyPath));
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.records.length, 1);
  assert.ok(snapshot.records[0].familyKey.startsWith("en-family:v1:word:"));
  assert.equal(snapshot.records[0].translation, "走过");
  assert.equal(snapshot.records[0].note, "保留笔记");
  assert.equal((await migrated.plugin.getVocabularyService().getTerm("walking")).status, 5);
  const firstBytes = storedFiles.get(vocabularyPath);
  await migrated.plugin.initializeVocabulary();
  assert.equal(storedFiles.get(vocabularyPath), firstBytes, "startup migration is idempotent");
  migrated.plugin.onunload();
});

test("Vocabulary subscription sends bounded authenticated invalidation to each Reader", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  await harness.plugin.initializeVocabulary();
  harness.plugin.settings.vocabularyEnabled = true;
  const outgoing = [];
  for (let index = 0; index < 2; index += 1) {
    const view = harness.createView();
    view.ready = true;
    view.documentId = `v2-doc-${index}`;
    view.openRequest = index + 1;
    view.rendererGeneration = `v2-generation-${index}`;
    view.iframe = { contentWindow: { postMessage: (message) => outgoing.push({ view, message }) } };
  }
  await harness.plugin.getVocabularyService().upsertTerm("walk", { status: 4 });
  const changes = outgoing.filter(({ message }) => message.type === "vocab-page-refresh");
  assert.equal(changes.length, 2);
  for (const { view, message } of changes) {
    assert.equal(message.channel, "pdf-web-reader");
    assert.equal(message.token, view.token);
    assert.equal(message.rendererGeneration, view.rendererGeneration);
    assert.equal(message.documentId, view.documentId);
    assert.equal(message.openRequest, view.openRequest);
    assert.deepEqual([...message.changedKeys], ["walk"]);
  }
  harness.plugin.onunload();
});

test("external Vocabulary replacement reloads through the Vault event without touching PDF state", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const service = harness.plugin.getVocabularyService();
  await service.upsertTerm("walk", { status: 2, translation: "步行" });
  const vocabularyPath = "00_Archive/21_VocabularyData/en.vocab.json";
  const raw = harness.storedFiles.get(vocabularyPath);
  const external = JSON.parse(raw);
  external.revision += 1;
  external.records[0].status = 5;
  harness.storedFiles.set(vocabularyPath, JSON.stringify(external));
  harness.emitVault("modify", { path: vocabularyPath });
  await harness.plugin.vocabularyExternalReload;
  assert.equal((await service.getTerm("walking")).status, 5);
  assert.equal(service.getRevision(), external.revision);
  await service.setNote("walk", "可继续编辑");
  assert.equal(JSON.parse(harness.storedFiles.get(vocabularyPath)).records[0].note, "可继续编辑");
  assert.equal([...harness.storedFiles.keys()].some((path) => path.startsWith("00_Archive/20_PDFData/")), false);
  harness.plugin.onunload();
});

test("host refuses wrong-session or externally changed annotation saves and durably ACKs a valid sidecar batch", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/current.pdf", [1, 2, 3]);
  const reader = await createSidecarReader(harness, file);
  const { view } = reader;
  const operation = {
    uuid: "current-highlight",
    kind: "Highlight",
    pageIndex: 0,
    deleted: false,
    payload: { editor: { color: [1, 0, 0] } },
  };

  await view.saveFile(null, "other-session", "request-mismatch", 1, "manual", {
    openRequest: view.openRequest,
    operations: [operation],
  });
  assert.equal(file.writes, 0);
  assert.equal(reader.sent.at(-1).code, "document-mismatch");
  assert.equal(reader.sent.at(-1).requestId, "request-mismatch");
  assert.deepEqual(file.bytes, Uint8Array.from([1, 2, 3]));
  assert.equal((await harness.plugin.annotationHost.store.listOperationBatches(view.annotationDocument)).length, 0);

  file.stat.mtime += 1;
  await view.saveFile(null, view.documentId, "request-conflict", 2, "auto", {
    openRequest: view.openRequest,
    operations: [operation],
  });
  assert.equal(file.writes, 0);
  assert.equal(reader.sent.at(-1).code, "PDF_ANNOTATION_SOURCE_CHANGED");
  assert.equal(reader.sent.at(-1).requestId, "request-conflict");
  assert.equal((await harness.plugin.annotationHost.store.listOperationBatches(view.annotationDocument)).length, 0);

  file.stat.mtime -= 1;
  const saved = await saveSidecarOperations(reader, {
    requestId: "request-success",
    revision: 3,
    operations: [operation],
  });
  assert.equal(saved.type, "saved");
  assert.equal(saved.external, true);
  assert.equal(saved.documentId, view.documentId);
  assert.equal(saved.requestId, "request-success");
  assert.equal(saved.revision, 3);
  assert.equal(saved.operationCount, 1);
  assert.equal(file.writes, 0);
  assert.deepEqual(file.bytes, Uint8Array.from([1, 2, 3]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(view.annotationSnapshot.annotations.some((row) => row.uuid === "current-highlight"),
    "the writer view's host-side annotation snapshot advances after its durable save");
});

test("two views of one PDF serialize durable sidecar batches without overwriting the PDF", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/shared.pdf", [1, 2, 3]);
  const first = await createSidecarReader(harness, file);
  const second = await createSidecarReader(harness, file);
  assert.equal(first.view.documentId, second.view.documentId);

  const [firstAck, secondAck] = await Promise.all([
    saveSidecarOperations(first, {
      requestId: "first-view-operation",
      batchId: "first-view-batch",
      operations: [{ uuid: "first-view-highlight", kind: "Highlight", pageIndex: 0,
        deleted: false, payload: { editor: { color: [1, 0, 0] } } }],
    }),
    saveSidecarOperations(second, {
      requestId: "second-view-operation",
      batchId: "second-view-batch",
      operations: [{ uuid: "second-view-highlight", kind: "Highlight", pageIndex: 0,
        deleted: false, payload: { editor: { color: [0, 1, 0] } } }],
    }),
  ]);

  assert.equal(firstAck.type, "saved");
  assert.equal(secondAck.type, "saved");
  assert.equal(file.writes, 0);
  assert.deepEqual(file.bytes, Uint8Array.from([1, 2, 3]));
  const batches = await harness.plugin.annotationHost.store.listOperationBatches(first.view.annotationDocument);
  assert.equal(batches.length, 2);
  const snapshot = await harness.plugin.annotationHost.store.readDocument(first.view.annotationDocument);
  assert.deepEqual(snapshot.annotations.map((operation) => operation.uuid).sort(), [
    "first-view-highlight",
    "second-view-highlight",
  ], "the checkpoint replay contains both independently serialized view batches");
});

test("Reader backlink pages use a document cache and invalidate it when Markdown or annotation state changes", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/backlink-cache.pdf", [1, 2, 3]);
  const reader = await createSidecarReader(harness, file, { orderedPageIdentities: ["page-one"] });
  const view = reader.view;
  const rawIndex = harness.plugin.readerBacklinkIndex;
  let documentLookups = 0;
  const link = {
    link: `Book.pdf#page=1&docKey=${view.annotationDocument.docKey}&obdoc=${encodeURIComponent(view.annotationDocument.documentId)}&obreader=page.page-one`,
    displayText: "page reference",
    position: { start: { offset: 10, line: 1 } },
  };
  rawIndex.replaceFile({ path: "Notes/Backlink.md" }, { links: [link] });
  harness.plugin.readerBacklinkIndex = {
    get size() { return rawIndex.size; },
    get revision() { return rawIndex.revision; },
    replaceFile: (...args) => rawIndex.replaceFile(...args),
    removeFile: (...args) => rawIndex.removeFile(...args),
    get: (...args) => rawIndex.get(...args),
    getDocument: (...args) => { documentLookups += 1; return rawIndex.getDocument(...args); },
  };
  harness.plugin.readerBacklinkIndexReady = true;
  const identity = { documentId: view.documentId, openRequest: view.openRequest,
    rendererGeneration: view.rendererGeneration };
  const first = await harness.plugin.collectReaderBacklinksForPage(view, 0, identity);
  const repeated = await harness.plugin.collectReaderBacklinksForPage(view, 0, identity);
  assert.equal(first.rows.length, 1);
  assert.equal(repeated.rows.length, 1);
  assert.equal(first.pageIndexCacheHit, false);
  assert.equal(repeated.pageIndexCacheHit, true);
  assert.equal(documentLookups, 1, "scrolling to the same document's next page does not rescan its Markdown rows");

  harness.plugin.removeReaderBacklinkFile("Notes/Backlink.md", { notify: false });
  const afterMarkdownChange = await harness.plugin.collectReaderBacklinksForPage(view, 0, identity);
  assert.equal(afterMarkdownChange.rows.length, 0);
  assert.equal(documentLookups, 2, "a Markdown change invalidates the derived per-document page map");

  view.annotationSnapshot = { ...view.annotationSnapshot, revision: 2 };
  await harness.plugin.collectReaderBacklinksForPage(view, 0, identity);
  assert.equal(documentLookups, 3, "a new annotation snapshot rebuilds page-to-annotation mappings");
  harness.plugin.onunload();
});

test("Reader backlink index follows actual Markdown cache and folder rename events without scanning the Vault", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  await harness.plugin.rebuildReaderBacklinkIndex();
  const link = (page) => ({ link: `Books/Book.pdf#page=1&obreader=page.${page}`,
    position: { start: { offset: 0, line: 0 }, end: { offset: 24, line: 0 } } });
  const note = new harness.TFile("Notes/Nested/Reference.md");
  const sibling = new harness.TFile("Notes-old/Reference.md");
  harness.files.set(note.path, note);
  harness.files.set(sibling.path, sibling);
  harness.setFileCache(note, { links: [link("page-one")] });
  harness.setFileCache(sibling, { links: [link("sibling-page")] });
  harness.emitMetadataCache("changed", note);
  harness.emitMetadataCache("changed", sibling);
  assert.deepEqual(harness.plugin.readerBacklinkIndex.getByPdfPath("Books/Book.pdf")
    .map((row) => row.sourcePath).sort(), ["Notes-old/Reference.md", "Notes/Nested/Reference.md"].sort());

  let vaultScans = 0;
  const getMarkdownFiles = harness.app.vault.getMarkdownFiles;
  harness.app.vault.getMarkdownFiles = () => { vaultScans += 1; return getMarkdownFiles(); };
  const oldNotePath = note.path;
  harness.files.delete(oldNotePath);
  harness.metadataCaches.delete(oldNotePath);
  note.path = "Archive/Nested/Reference.md";
  harness.files.set(note.path, note);
  harness.setFileCache(note, { links: [link("page-one")] });
  harness.emitVault("rename", { path: "Archive" }, "Notes");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const routes = harness.plugin.readerBacklinkIndex.getByPdfPath("Books/Book.pdf");
  assert.deepEqual(routes.map((row) => row.sourcePath).sort(),
    ["Archive/Nested/Reference.md", "Notes-old/Reference.md"].sort(),
    "folder rename removes old source rows and refreshes relocated indexed Markdown files");
  assert.equal(vaultScans, 0, "folder rename uses the index's existing source set, not another Vault scan");
  harness.plugin.onunload();
});

test("Reader backlink source jump rejects a changed MetadataCache target or source span", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const note = new harness.TFile("Notes/Source.md");
  harness.files.set(note.path, note);
  const expected = { kind: "page", id: "page-one" };
  const fragment = encodeReaderLinkFragment({ pageNumber: 1, docKey: "aabbccddeeff",
    documentId: "xxh64-v1:0123456789abcdef", target: expected });
  const link = (target, start = 10, end = 40) => ({
    link: `Books/Book.pdf#${target === expected ? fragment : encodeReaderLinkFragment({ pageNumber: 1,
      docKey: "aabbccddeeff", documentId: "xxh64-v1:0123456789abcdef", target })}`,
    position: { start: { offset: start, line: 2 }, end: { offset: end, line: 2 } },
  });
  let openCalls = 0;
  harness.app.workspace.openLinkText = async () => { openCalls += 1; };
  const row = { sourcePath: note.path, routePath: "Books/Book.pdf", docKey: "aabbccddeeff",
    documentId: "xxh64-v1:0123456789abcdef", target: expected, offset: 10, endOffset: 40, line: 2 };

  harness.setFileCache(note, { links: [link({ kind: "page", id: "page-two" })] });
  assert.equal(await harness.plugin.openReaderBacklinkSource(row), false,
    "the current source at the old span no longer names the clicked Reader target");
  assert.equal(openCalls, 0, "a stale source row is rejected before changing the active Markdown leaf");
  harness.setFileCache(note, { links: [link(expected, 11, 41)] });
  assert.equal(await harness.plugin.openReaderBacklinkSource(row), false,
    "a moved MetadataCache span is not treated as the stale indexed source row");
  assert.equal(openCalls, 0);
  const unresolved = [];
  const originalRecord = harness.plugin.sessionLog.record.bind(harness.plugin.sessionLog);
  harness.plugin.sessionLog.record = (category, details) => {
    if (category === "readerBacklinks" && details?.event === "source-open-failed") unresolved.push(details.code);
    return originalRecord(category, details);
  };
  harness.setFileCache(note, { links: [link({ kind: "page", id: "page-two" })] });
  assert.equal(await harness.plugin.openReaderBacklinkSource(row), false);
  assert.deepEqual(unresolved, ["TARGET_UNRESOLVED"],
    "a changed Reader target is explicitly reported as TARGET_UNRESOLVED");
  assert.equal(openCalls, 0);
  harness.plugin.onunload();
});

test("Reader backlink page lookup cannot publish a superseded same-page result", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const messages = [], pending = [];
  const view = {
    documentId: "doc", openRequest: 1, rendererGeneration: "generation",
    annotationDocument: { docKey: "aabbccddeeff" },
    annotationPageIdentity: { orderedPageIdentities: ["page-one"] },
    annotationSourceHash: "xxh64-v1:0000000000000000", annotationHydrationAllowed: true,
    isCurrentReaderAnchorIdentity: () => true, postToViewer: message => messages.push(message),
  };
  harness.plugin.collectReaderBacklinksForPage = () => new Promise(resolve => pending.push(resolve));
  const request = { documentId: "doc", openRequest: 1, rendererGeneration: "generation",
    pageNumber: 1, pageIndex: 0, pageIdentity: "page-one", sourceHash: view.annotationSourceHash };
  const old = harness.plugin.handleReaderBacklinkPageRequest(view, { ...request, requestId: "old" });
  const current = harness.plugin.handleReaderBacklinkPageRequest(view, { ...request, requestId: "current" });
  pending[1]({ rows: [{ sourcePath: "Current.md" }], markers: [{ id: "current" }] });
  assert.equal(await current, true);
  pending[0]({ rows: [], markers: [] });
  assert.equal(await old, false, "a late empty result cannot erase the newer page markers");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].requestId, "current");
  assert.equal(messages[0].backlinkCount, 1);
  assert.equal(await harness.plugin.handleReaderBacklinkPageRequest(view, { ...request, requestId: "" }), false);
  harness.plugin.onunload();
});

test("Reader backlink source navigation focuses the exact Markdown link and never overwrites user movement", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const noteFile = new harness.TFile("Notes/Source.md");
  harness.files.set(noteFile.path, noteFile);
  const docKey = "aabbccddeeff";
  const documentId = "xxh64-v1:0123456789abcdef";
  const target = { kind: "page", id: "page-two" };
  const fragment = encodeReaderLinkFragment({ pageNumber: 2, docKey, documentId, target });
  const content = `A quote.\n[[Books/Book.pdf#${fragment}|Reader source]]\nLater text.`;
  const start = content.indexOf("[[Books/");
  const end = content.indexOf("]]", start) + 2;
  const selected = content.slice(start, end);
  const metadataLink = { link: `Books/Book.pdf#${fragment}`, original: selected, displayText: "Reader source",
    position: { start: { offset: start, line: 1 }, end: { offset: end, line: 1 } } };
  harness.setFileCache(noteFile, { links: [metadataLink] });
  harness.plugin.readerBacklinkIndex.replaceFile(noteFile, { links: [metadataLink] });
  const [row] = harness.plugin.readerBacklinkIndex.get(docKey, target, documentId);
  assert.ok(row, "navigation starts from the same indexed MetadataCache link row");
  const timers = new Map();
  let timerId = 0;
  const listeners = new Map();
  const ownerWindow = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    fireTimeout(id) {
      const timer = timers.get(id);
      if (!timer) return false;
      timers.delete(id);
      timer.callback();
      return true;
    },
  };
  const fromOffset = (offset) => {
    const prefix = content.slice(0, offset).split("\n");
    return { line: prefix.length - 1, ch: prefix.at(-1).length };
  };
  const toOffset = ({ line, ch }) => content.split("\n").slice(0, line).join("\n").length +
    (line > 0 ? 1 : 0) + ch;
  const editor = {
    value: content,
    anchor: { line: 0, ch: 0 },
    head: { line: 0, ch: 0 },
    selection: "",
    scrolls: [],
    focused: false,
    getValue() { return this.value; },
    offsetToPos(offset) { return fromOffset(offset); },
    lineCount() { return this.value.split("\n").length; },
    setSelection(anchor, head) {
      this.anchor = { ...anchor };
      this.head = { ...head };
      this.selection = this.value.slice(toOffset(anchor), toOffset(head));
    },
    setCursor(position) {
      this.anchor = { ...position };
      this.head = { ...position };
      this.selection = "";
    },
    getSelection() { return this.selection; },
    getCursor(which) { return { ...(which === "from" ? this.anchor : this.head) }; },
    scrollIntoView(position, center) { this.scrolls.push({ position, center }); },
    focus() { this.focused = true; },
  };
  const containerEl = {
    ownerDocument: { defaultView: ownerWindow },
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    dispatch(name) { for (const listener of [...(listeners.get(name) || [])]) listener({ type: name }); },
  };
  const markdownLeaf = { view: { file: noteFile, editor, containerEl,
    getViewType: () => "markdown" } };
  const openCalls = [];
  harness.app.workspace.openLinkText = async (...args) => {
    openCalls.push(args);
    harness.app.workspace.activeLeaf = markdownLeaf;
  };
  assert.equal(await harness.plugin.openReaderBacklinkSource(row, { source: "unit-test" }), true);
  assert.deepEqual(openCalls, [["Notes/Source.md", "", true]]);
  assert.equal(editor.getSelection(), selected);
  assert.deepEqual(editor.scrolls, [{ position: { from: fromOffset(start), to: fromOffset(end) }, center: true }]);
  assert.equal(editor.focused, true);
  const [timer] = timers.keys();
  assert.equal(timers.get(timer).delay, 1400);
  assert.equal(ownerWindow.fireTimeout(timer), true);
  assert.equal(editor.getSelection(), "", "the temporary link focus clears after its short display interval");
  assert.deepEqual(editor.getCursor("to"), fromOffset(end));

  await harness.plugin.openReaderBacklinkSource(row, { source: "unit-test" });
  const secondTimer = [...timers.keys()][0];
  containerEl.dispatch("pointerdown");
  editor.setCursor({ line: 2, ch: 3 });
  assert.equal(timers.has(secondTimer), false, "real user input cancels temporary focus cleanup immediately");
  assert.deepEqual(editor.getCursor("to"), { line: 2, ch: 3 }, "user movement is never reset");

  await harness.plugin.openReaderBacklinkSource(row, { source: "same-target-first" });
  const supersededTimer = [...timers.keys()][0];
  await harness.plugin.openReaderBacklinkSource(row, { source: "same-target-second" });
  assert.equal(timers.size, 1, "a repeated exact jump replaces its older temporary-focus timer");
  assert.equal(timers.has(supersededTimer), false, "the older timer cannot clear a newer identical selection");
  const repeatedFocusTimer = [...timers.keys()][0];
  harness.app.workspace.activeLeaf = { view: { file: { path: "Notes/Other.md" } } };
  assert.equal(ownerWindow.fireTimeout(repeatedFocusTimer), true);
  assert.equal(editor.getSelection(), "", "temporary focus expires in its original leaf after the user switches tabs");

  harness.app.workspace.activeLeaf = markdownLeaf;
  await harness.plugin.openReaderBacklinkSource(row, { source: "same-view-new-file" });
  const switchedDocumentTimer = [...timers.keys()][0];
  markdownLeaf.view.file.path = "Notes/Other.md";
  assert.equal(ownerWindow.fireTimeout(switchedDocumentTimer), true);
  assert.equal(editor.getSelection(), selected,
    "the cleanup must not alter a reused Markdown view after it has switched to another file");

  editor.scrolls.length = 0;
  markdownLeaf.view.file.path = "Notes/Source.md";
  const invalidLink = { ...metadataLink, position: { start: { offset: content.length + 1, line: 0 },
    end: { offset: content.length + 2, line: 0 } } };
  harness.setFileCache(noteFile, { links: [invalidLink] });
  harness.plugin.readerBacklinkIndex.replaceFile(noteFile, { links: [invalidLink] });
  const [invalidRow] = harness.plugin.readerBacklinkIndex.get(docKey, target, documentId);
  await harness.plugin.openReaderBacklinkSource(invalidRow,
    { source: "invalid-offset-test" });
  assert.deepEqual(editor.getCursor("to"), { line: 0, ch: 0 }, "an invalid offset safely falls back to the indexed line");
  assert.deepEqual(editor.scrolls, [{ position: { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } }, center: true }]);

  const excerpt = { sourcePath: noteFile.path, offset: 0, endOffset: 8, line: 0, sourceText: "A quote." };
  await harness.plugin.openReaderBacklinkSource(excerpt, { source: "learning-excerpt" });
  assert.equal(editor.getSelection(), "A quote.", "a Markdown excerpt selects only its exact sourceText span");
  await harness.plugin.openReaderBacklinkSource({ ...excerpt, offset: 1, endOffset: 9 },
    { source: "stale-learning-excerpt" });
  assert.equal(editor.getSelection(), "", "a mismatch is never repaired by searching for similar text elsewhere");
  assert.deepEqual(editor.getCursor("to"), { line: 0, ch: 0 }, "the stale excerpt falls back only to its verified line");

  const positionReports = [];
  const originalRecord = harness.plugin.sessionLog.record.bind(harness.plugin.sessionLog);
  harness.plugin.sessionLog.record = (category, details) => {
    if (category === "readerBacklinks" && details?.event === "source-opened") positionReports.push(details);
    return originalRecord(category, details);
  };
  harness.setFileCache(noteFile, { links: [metadataLink] });
  harness.plugin.readerBacklinkIndex.replaceFile(noteFile, { links: [metadataLink] });
  const [currentRow] = harness.plugin.readerBacklinkIndex.get(docKey, target, documentId);
  editor.value = `Unsaved text moved the link.\n${content}`;
  await harness.plugin.openReaderBacklinkSource(currentRow, { source: "unsaved-link-move" });
  assert.equal(editor.getSelection(), "",
    "stale MetadataCache offsets cannot select unrelated unsaved text from the editor buffer");
  assert.deepEqual(editor.getCursor("to"), { line: 1, ch: 0 },
    "a stale raw link span degrades only to the MetadataCache line position");
  assert.equal(positionReports.at(-1)?.positionKind, "line",
    "the host reports line fallback distinctly from exact source positioning");
  const noLineLink = { ...metadataLink, position: { start: { offset: start, line: null },
    end: { offset: end, line: null } } };
  harness.setFileCache(noteFile, { links: [noLineLink] });
  harness.plugin.readerBacklinkIndex.replaceFile(noteFile, { links: [noLineLink] });
  const [noLineRow] = harness.plugin.readerBacklinkIndex.get(docKey, target, documentId);
  await harness.plugin.openReaderBacklinkSource(noLineRow, { source: "unsaved-link-move-no-line" });
  assert.equal(positionReports.at(-1)?.positionKind, "file",
    "without an exact raw span or verified line the host reports file-only navigation");
  assert.equal(positionReports.at(-1)?.positioned, false);
  assert.equal(positionReports.at(-1)?.selected, false);
  harness.plugin.onunload();
});

test("Reader backlink target-open reuses the page index and routes one exact source row", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = {
    annotationDocument: { docKey: "doc-key", documentId: "document-id" },
    annotationPageIdentity: { orderedPageIdentities: ["page-one", "page-two"] },
    annotationHydrationAllowed: true,
    isCurrentReaderAnchorIdentity: () => true,
  };
  const row = { sourcePath: "Notes/Source.md", target: { kind: "annotation", id: "annotation-id" } };
  const selectionRow = { sourcePath: "Notes/Selection.md", target: { kind: "selection", id: "anchor-id" } };
  let opened = null;
  harness.plugin.readerBacklinkIndexReady = true;
  harness.plugin.getReaderBacklinkPageIndex = async () => ({ value: {
    forPage: (pageIdentity) => ({ rows: pageIdentity === "page-one" ? [row, selectionRow] : [] }),
  } });
  harness.plugin.openReaderBacklinkSource = async (actual, options) => { opened = { actual, options }; return true; };
  const identity = { documentId: "document-id", openRequest: 3, rendererGeneration: "generation" };
  assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(view, {
    ...identity, requestId: "target-open", targetKind: "annotation", targetId: "annotation-id",
    pageNumber: 1, pageIdentity: "page-one",
  }), true);
  assert.deepEqual(opened, { actual: row, options: { source: "viewer" } });

  opened = null;
  await harness.plugin.handleReaderBacklinkTargetOpen(view, {
    ...identity, requestId: "target-open-selection", targetKind: "selection", targetId: "anchor-id",
    pageNumber: 1, pageIdentity: "page-one",
  });
  assert.equal(opened.actual, selectionRow);
  opened = null;
  await harness.plugin.handleReaderBacklinkTargetOpen(view, {
    ...identity, requestId: "target-open-selection-wrong-page", targetKind: "selection", targetId: "anchor-id",
    pageNumber: 2, pageIdentity: "page-two",
  });
  assert.equal(opened, null, "a selection from another page is never opened from this page's marker intent");
  harness.plugin.readerBacklinkIndexReady = false;
  let pageIndexReads = 0;
  const getPageIndex = harness.plugin.getReaderBacklinkPageIndex;
  harness.plugin.getReaderBacklinkPageIndex = async (...args) => {
    pageIndexReads += 1;
    return getPageIndex(...args);
  };
  assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(view, {
    ...identity, requestId: "target-open-index-cold", targetKind: "annotation", targetId: "annotation-id",
    pageNumber: 1, pageIdentity: "page-one",
  }), false, "an unexpected target-open cannot trigger a cold full-Vault index build");
  assert.equal(pageIndexReads, 0);
  harness.plugin.readerBacklinkIndexReady = true;
  assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(view, {
    ...identity, requestId: "target-open-stale", targetKind: "annotation", targetId: "annotation-id",
    pageNumber: 2, pageIdentity: "stale-page",
  }), false, "a stale or mismatched page identity fails closed");
  harness.plugin.onunload();
});

test("LingQ occurrence backlink query never starts a cold full-Vault index scan", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  harness.plugin.readerBacklinkIndexReady = false;
  let indexReads = 0;
  harness.plugin.getReaderBacklinkPageIndex = async () => {
    indexReads += 1;
    throw new Error("a cold occurrence interaction must not rebuild the Vault index");
  };
  const replies = [];
  const view = {
    annotationDocument: { docKey: "doc-key", documentId: "document-id" },
    annotationPageIdentity: { orderedPageIdentities: ["page-one"] },
    annotationHydrationAllowed: true,
    token: "reader-token",
    isCurrentReaderAnchorIdentity: () => true,
    postToViewer: (message) => replies.push(message),
  };
  const handled = await harness.plugin.handleReaderBacklinkOccurrenceMessage(view, {
    type: "reader-backlink-occurrence-query",
    requestId: "cold-occurrence-query",
    documentId: "document-id",
    openRequest: 3,
    rendererGeneration: "renderer-generation",
    pageNumber: 1,
    startIndex: 0,
    endIndex: 6,
  });
  assert.equal(handled, false);
  assert.equal(indexReads, 0, "a LingQ click cannot trigger a full-Vault index build on the interaction path");
  assert.deepEqual(replies, [{
    channel: "pdf-web-reader",
    token: "reader-token",
    type: "reader-backlink-occurrence-result",
    requestId: "cold-occurrence-query",
    documentId: "document-id",
    openRequest: 3,
    rendererGeneration: "renderer-generation",
    ok: false,
    count: 0,
    anchorIds: [],
    message: "反向链接索引仍在准备中，请稍后重试。",
  }]);
  harness.plugin.onunload();
});

test("enhanced Reader links keep stable page, selection and annotation identity across PDF rename", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const originalBytes = Uint8Array.from([37, 80, 68, 70, 9, 8, 7]);
  const file = new harness.TFile("Books/rename-link.pdf", originalBytes);
  const reader = await createSidecarReader(harness, file, {
    pageCount: 2,
    orderedPageIdentities: ["page-one", "page-two"],
  });
  const { view } = reader;
  const document = view.annotationDocument;
  const selectionAnchor = await harness.plugin.readerAnchorStore.create({
    anchorId: "anchor-rename-test",
    docKey: document.docKey,
    documentId: document.documentId,
    sourceHash: view.annotationSourceHash,
    pageIdentity: "page-two",
    pageIndexHint: 1,
    pageCount: 2,
    orderedPageIdentityDigest: await harness.plugin.pdfHashRuntime.fingerprint(
      new TextEncoder().encode(JSON.stringify(["page-one", "page-two"])),
    ),
    textPosition: { start: 10, end: 22 },
    exactQuote: "stable selected text",
    prefix: "before ",
    suffix: " after",
    geometry: { x: 0.1, y: 0.2, width: 0.4, height: 0.03 },
    createdAt: 1792200000000,
  });
  const annotationId = "550e8400-e29b-41d4-a716-446655440000";
  await saveSidecarOperations(reader, {
    requestId: "rename-link-create-annotation",
    operations: [{ uuid: annotationId, kind: "Highlight", pageIndex: 1, deleted: false,
      payload: { editor: { type: "highlight", color: [1, 1, 0] } } }],
  });

  const link = (target, pageNumber) => encodeReaderLinkFragment({
    pageNumber,
    docKey: document.docKey,
    documentId: document.documentId,
    target,
  });
  const selection = await harness.plugin.resolveReaderLinkDocument(
    parseReaderLinkFragment(link({ kind: "selection", id: selectionAnchor.anchorId }, 2)),
    file.path,
  );
  assert.equal(selection.file, file);
  assert.equal(selection.readerTarget.kind, "selection");
  assert.equal(selection.readerTarget.pageNumber, 2);

  const page = await harness.plugin.resolveReaderLinkDocument(
    parseReaderLinkFragment(link({ kind: "page", id: "page-two" }, 2)),
    file.path,
  );
  assert.equal(page.file, file);
  assert.deepEqual(page.readerTarget, {
    kind: "page", id: "page-two", docKey: document.docKey,
    documentId: document.documentId, pageNumber: 2,
  });

  const oldPath = file.path;
  harness.files.delete(oldPath);
  file.path = "Archive/renamed-link.pdf";
  file.basename = "renamed-link";
  harness.files.set(file.path, file);
  harness.emitVault("rename", file, oldPath);
  await new Promise((resolve) => setTimeout(resolve, 0));

  const legacyAnnotationLink = `page=2&docKey=${document.docKey}&obdoc=${encodeURIComponent(document.documentId)}&obreader=ann.${annotationId}`;
  const annotation = await harness.plugin.resolveReaderLinkDocument(
    parseReaderLinkFragment(legacyAnnotationLink),
    "rename-link.pdf",
  );
  assert.equal(annotation.file, file, "the stable document route wins over a stale Markdown path");
  assert.equal(annotation.readerTarget.pageNumber, 2);
  assert.equal(view.annotationDocument.documentId, document.documentId);
  assert.equal(view.annotationDocument.docKey, document.docKey);

  const compactAnnotationLink = link({ kind: "annotation", id: annotationId }, 2);
  assert.equal(compactAnnotationLink,
    `page=2&docKey=${document.docKey}&obdoc=${encodeURIComponent(document.documentId)}&obreader=ann.${annotationId}`,
    "newly copied links keep the stable document identity as well as the native fallback and target ID");
  const compactAnnotation = await harness.plugin.resolveReaderLinkDocument(
    parseReaderLinkFragment(compactAnnotationLink), file.path,
  );
  assert.equal(compactAnnotation.file, file, "the compact link resolves through its current PDF route");
  assert.equal(compactAnnotation.readerTarget.documentId, document.documentId);
  assert.equal(compactAnnotation.readerTarget.docKey, document.docKey);

  const copy = new harness.TFile(oldPath, originalBytes);
  harness.files.set(copy.path, copy);
  const copyReader = await createSidecarReader(harness, copy, {
    pageCount: 2, orderedPageIdentities: ["page-one", "page-two"],
  });
  assert.notEqual(copyReader.view.annotationDocument.documentId, document.documentId,
    "a PDF copy at the former route receives its own path-derived identity");
  const originalFromStaleRoute = await harness.plugin.resolveReaderLinkDocument(
    parseReaderLinkFragment(compactAnnotationLink), oldPath,
  );
  assert.equal(originalFromStaleRoute.file, file,
    "the embedded original identity wins over a different copied PDF at the stale path");

  await saveSidecarOperations(reader, {
    requestId: "rename-link-delete-annotation",
    operations: [{ uuid: annotationId, kind: "Highlight", pageIndex: 1, deleted: true,
      payload: { editor: { type: "highlight", color: [1, 1, 0] } } }],
  });
  await assert.rejects(
    harness.plugin.resolveReaderLinkDocument(
      parseReaderLinkFragment(legacyAnnotationLink),
      "rename-link.pdf",
    ),
    /已删除或不存在/,
  );
  assert.deepEqual(file.bytes, originalBytes, "link resolution and rename never write source PDF bytes");
  assert.equal(file.writes, 0);
  harness.plugin.onunload();
});

test("identity-bearing Reader links keep closed-file navigation but report replacement targets unresolved", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const original = new harness.TFile("Books/identity-replaced.pdf", [37, 80, 68, 70, 1, 2, 3]);
  const originalReader = await createSidecarReader(harness, original, {
    pageCount: 1, orderedPageIdentities: ["original-page-one"],
  });
  const identity = { docKey: originalReader.view.annotationDocument.docKey,
    documentId: originalReader.view.annotationDocument.documentId };
  const parsed = parseReaderLinkFragment(encodeReaderLinkFragment({ pageNumber: 1, ...identity,
    target: { kind: "page", id: "original-page-one" } }));

  // A closed Reader still resolves its identity route; source verification is
  // performed by the normal open/initialize handshake, not a second click hash.
  harness.plugin.views.delete(originalReader.view);
  harness.plugin.annotationHost.releaseView(originalReader.view);
  const readsBeforeLinkResolution = original.reads;
  const closedRoute = await harness.plugin.resolveReaderLinkDocument(parsed, original.path);
  assert.equal(closedRoute.file, original);
  assert.equal(closedRoute.readerTarget.kind, "page");
  assert.equal(original.reads, readsBeforeLinkResolution,
    "closed-file identity routing does not reread or fingerprint the PDF on the interaction path");

  const replacement = new harness.TFile(original.path, [37, 80, 68, 70, 9, 8, 7]);
  harness.files.set(replacement.path, replacement);
  const resolved = await harness.plugin.resolveReaderLinkDocument(parsed, original.path);
  assert.equal(resolved.file, replacement, "identity routing may open the current file shell for normal source verification");
  assert.equal(resolved.readerTarget.id, "original-page-one");

  const replacementReader = await createSidecarReader(harness, replacement, {
    pageCount: 1, orderedPageIdentities: ["replacement-page-one"],
  });
  assert.equal(replacementReader.view.annotationSourceMismatch, true,
    "the ordinary open handshake detects that the same-path PDF has different bytes");
  const unresolved = [];
  const originalRecord = harness.plugin.sessionLog.record.bind(harness.plugin.sessionLog);
  harness.plugin.sessionLog.record = (category, details) => {
    if (category === "readerAnchor" && details?.event === "target-unresolved") unresolved.push(details.code);
    return originalRecord(category, details);
  };
  await replacementReader.view.setState({ path: replacement.path, readerTarget: resolved.readerTarget });
  assert.deepEqual(unresolved, ["TARGET_UNRESOLVED"],
    "a source mismatch is reported explicitly after the existing verified open gate");
  assert.equal(replacementReader.view.pendingReaderTarget, null,
    "a mismatched identity target is discarded after preserving only the native page-number fallback");
  assert.equal(replacementReader.view.currentPageNumber, 1);
  assert.equal(replacementReader.sent.some((message) => message.type === "reader-anchor-navigate"), false,
    "the old page identity is never sent to the replacement PDF");
  assert.ok(harness.notices.some((message) => message.includes("TARGET_UNRESOLVED") && message.includes("页码回退")));
  harness.plugin.onunload();
});

test("identity route absence never falls back to an unrelated PDF at the historical link path", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const unrelated = new harness.TFile("Books/historical-route.pdf", [37, 80, 68, 70, 1]);
  harness.files.set(unrelated.path, unrelated);
  const parsed = parseReaderLinkFragment(
    "page=3&docKey=abcdef123456&obdoc=missing-route-identity&obreader=page=old-page",
  );
  assert.equal(await harness.plugin.resolveReaderLinkFallback(parsed, unrelated.path), null,
    "a missing stable identity cannot silently downgrade to the path now occupied by another PDF");
  await assert.rejects(harness.plugin.resolveReaderLinkDocument(parsed, unrelated.path),
    (error) => error.code === "TARGET_UNRESOLVED",
    "the unresolved identity is surfaced explicitly to the link handler");
  harness.plugin.onunload();
});

test("WAL Reader links resolve a renamed document through a read-only effective-state adapter", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  const source = Uint8Array.from([37, 80, 68, 70, 4, 5, 6]);
  const file = new harness.TFile("Books/wal-link.pdf", source);
  const reader = await createSidecarReader(harness, file, {
    pageCount: 1,
    orderedPageIdentities: ["wal-page-one"],
  });
  const document = reader.view.annotationDocument;
  const annotationId = "550e8400-e29b-41d4-a716-446655440010";
  await saveSidecarOperations(reader, {
    requestId: "wal-link-create",
    operations: [{ uuid: annotationId, kind: "Underline", pageIndex: 0, deleted: false,
      payload: { editor: { type: "underline", rect: [1, 2, 20, 8] } } }],
  });
  const oldPath = file.path;
  harness.files.delete(oldPath);
  file.path = "Archive/wal-link-renamed.pdf";
  harness.files.set(file.path, file);
  await harness.plugin.annotationHost.renamed(file, oldPath);

  let storageWrites = 0;
  const adapter = harness.app.vault.adapter;
  const write = adapter.write.bind(adapter);
  const append = adapter.append.bind(adapter);
  adapter.write = async (...args) => { storageWrites += 1; return write(...args); };
  adapter.append = async (...args) => { storageWrites += 1; return append(...args); };
  const legacyFragment = `page=1&docKey=${document.docKey}&obdoc=${encodeURIComponent(document.documentId)}&obreader=ann.${annotationId}`;
  const result = await harness.plugin.resolveReaderLinkDocument(parseReaderLinkFragment(legacyFragment), "wal-link.pdf");
  assert.equal(result.file, file);
  assert.equal(result.readerTarget.kind, "annotation");
  assert.equal(result.readerTarget.pageNumber, 1);
  assert.equal(storageWrites, 0, "annotation link lookup cannot write, compact, or acknowledge WAL state");
  assert.deepEqual(file.bytes, source);
  assert.equal(file.writes, 0);
  harness.plugin.onunload();
});

test("a queued annotation save stays with its source PDF when the Reader switches documents", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = new harness.TFile("Books/first-queued.pdf", [1, 2, 3]);
  const second = new harness.TFile("Books/second-queued.pdf", [7, 7, 7]);
  harness.files.set(first.path, first);
  harness.files.set(second.path, second);
  const reader = await createSidecarReader(harness, first);
  const { view } = reader;
  const originalDocument = view.annotationDocument;
  let releaseQueue;
  let startedQueue;
  const queuedWriteStarted = new Promise((resolve) => { startedQueue = resolve; });
  const gate = new Promise((resolve) => { releaseQueue = resolve; });
  const adapter = harness.app.vault.adapter;
  const originalWrite = adapter.write.bind(adapter);
  let firstOperationWrite = true;
  adapter.write = async (filePath, value) => {
    if (firstOperationWrite && filePath.includes("/ops/") &&
        filePath.includes("queued-old-document-batch") && filePath.endsWith(".pending")) {
      firstOperationWrite = false;
      startedQueue();
      await gate;
    }
    return originalWrite(filePath, value);
  };
  const queuedSave = saveSidecarOperations(reader, {
    requestId: "queued-old-document",
    batchId: "queued-old-document-batch",
    revision: 9,
    operations: [{ uuid: "queued-old-annotation", kind: "Ink", pageIndex: 0,
      deleted: false, payload: { editor: { paths: [[0, 0, 1, 1]] } } }],
  });
  const oldDocumentId = view.documentId;
  await queuedWriteStarted;
  await view.openFile(second);
  assert.notEqual(view.documentId, oldDocumentId);
  releaseQueue();
  await queuedSave;

  assert.equal(first.writes, 0);
  assert.equal(second.writes, 0);
  assert.deepEqual([...second.bytes], [7, 7, 7]);
  assert.equal(view.saving, false);
  assert.equal(reader.sent.at(-1).code, "PDF_ANNOTATION_SESSION_CHANGED");
  const oldBatches = await harness.plugin.annotationHost.store.listOperationBatches(originalDocument);
  assert.equal(oldBatches.length, 1, "the in-flight batch remains under the original annotation identity");
  const oldSnapshot = await harness.plugin.annotationHost.store.readDocument(originalDocument);
  assert.ok(oldSnapshot.annotations.some((operation) => operation.uuid === "queued-old-annotation"));
  const currentSnapshot = await harness.plugin.annotationHost.store.readDocument(view.annotationDocument);
  assert.deepEqual(currentSnapshot.annotations, [], "the old edit is never hydrated into the newly selected PDF");
  assert.deepEqual(first.bytes, Uint8Array.from([1, 2, 3]));
});

test("a rename during sidecar persistence keeps the operation with its original document identity", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/rename-race.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const reader = await createSidecarReader(harness, file);
  const { view } = reader;
  const originalDocument = view.annotationDocument;
  const adapter = harness.app.vault.adapter;
  const originalWrite = adapter.write.bind(adapter);
  let releaseWrite;
  let startedWrite;
  const writeStarted = new Promise((resolve) => { startedWrite = resolve; });
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  let gated = false;
  adapter.write = async (targetPath, value) => {
    if (!gated && targetPath.includes("/ops/") && targetPath.endsWith(".pending")) {
      gated = true;
      startedWrite();
      await writeGate;
    }
    return originalWrite(targetPath, value);
  };

  const saving = saveSidecarOperations(reader, {
    requestId: "rename-race",
    batchId: "rename-race-batch",
    revision: 10,
    origin: "auto",
    operations: [{ uuid: "rename-race-highlight", kind: "Highlight", pageIndex: 0,
      deleted: false, payload: { editor: { color: [1, 0, 0] } } }],
  });
  await writeStarted;
  harness.files.delete(file.path);
  const oldPath = file.path;
  file.path = "Archive/rename-race.pdf";
  harness.files.set(file.path, file);
  releaseWrite();
  await saving;

  assert.equal(file.writes, 0);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(reader.sent.at(-1).type, "error");
  assert.equal(reader.sent.at(-1).code, "PDF_ANNOTATION_SESSION_CHANGED",
    "the host refuses to acknowledge a batch after the source path changes mid-write");

  await harness.plugin.annotationHost.renamed(file, oldPath);
  view.onDocumentRenamed(file, oldPath);
  assert.equal(view.requestedPath, file.path);
  const renamedDocument = await harness.plugin.annotationHost.store.documentForPath(file.path);
  assert.equal(renamedDocument.documentId, originalDocument.documentId);
  assert.equal(await harness.plugin.annotationHost.store.documentForPath(oldPath), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const snapshot = await harness.plugin.annotationHost.store.readDocument(renamedDocument);
  assert.ok(snapshot.annotations.some((operation) => operation.uuid === "rename-race-highlight"),
    "the durable operation remains in the renamed document checkpoint even after batch compaction");
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
  assert.equal(frame.sent[0].vocabularyDisplayMode, "all");
  assert.equal(frame.sent[0].preferredAnnotationToolMode, 0);
  assert.equal(frame.sent[0].initialPageNumber, null);
  view.pendingReaderTarget = { kind: "page-number", pageNumber: 12 };
  view.openRequest += 1;
  view.pendingBytes = Uint8Array.from([1, 2, 3]).buffer;
  view.lastOpenSentRequest = null;
  view.sendPendingDocument();
  assert.equal(frame.sent.at(-1).initialPageNumber, 12,
    "the standard page= fallback is carried into the Viewer even before source identity confirmation");
});

test("sidecar saves require the matching opened ACK and exact Viewer page-identity handshake", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/open-admission.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const view = harness.createView();
  const frame = { sent: [], postMessage(message) { this.sent.push(message); } };
  view.iframe = { contentWindow: frame };

  await view.openFile(file);
  assert.equal(view.openAcknowledged, false,
    "a requested open is not eligible for annotation persistence until PDF.js confirms parsing");
  view.ready = true;
  view.sendPendingDocument();
  assert.equal(frame.sent.at(-1).type, "open");
  const save = async (requestId) => view.saveFile(null, view.documentId, requestId, 1, "manual", {
    openRequest: view.openRequest,
    batchId: `${requestId}-batch`,
    operations: [{ uuid: requestId, kind: "Highlight", pageIndex: 0, deleted: false,
      payload: { editor: { color: [1, 1, 0] } } }],
  });

  await save("before-open-ack");
  assert.equal(frame.sent.at(-1).code, "PDF_ANNOTATION_PAGE_IDENTITY_UNCONFIRMED",
    "the host refuses to persist annotations before the Viewer proves page identity");

  const opened = {
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "opened",
      documentId: view.documentId,
      openRequest: view.openRequest - 1,
    },
  };
  view.onMessage(opened);
  assert.equal(view.openAcknowledged, false, "a stale open ACK cannot enable annotation reconciliation");
  opened.data.openRequest = view.openRequest;
  opened.data.revision = 0;
  opened.data.confirmedRevision = 0;
  opened.data.dirty = false;
  opened.data.restorePaused = false;
  view.onMessage(opened);
  assert.equal(view.openAcknowledged, true,
    "only the matching parsed open enables the next identity-verification phase");
  await save("before-identity-handshake");
  assert.equal(frame.sent.at(-1).code, "PDF_ANNOTATION_PAGE_IDENTITY_UNCONFIRMED");

  await confirmViewerPageIdentity(harness, { view }, {
    pageCount: 1,
    orderedPageIdentities: ["4 0 R"],
  });
  await save("after-identity-handshake");
  assert.equal(frame.sent.at(-1).type, "saved");
  assert.equal(frame.sent.at(-1).external, true);
  assert.equal((await harness.plugin.annotationHost.store.listOperationBatches(view.annotationDocument)).length, 1);
});

test("a not-ready Reader can close without claiming an unconfirmed sidecar revision is durable", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const cleanFile = new harness.TFile("Books/preopen-clean.pdf", [1, 2, 3]);
  const cleanReader = await createControlledReader(harness, cleanFile);
  cleanReader.view.ready = false;
  assert.equal(await cleanReader.view.prepareControlledClose("detach"), true);
  assert.equal(cleanReader.view.preparedClose.revision, 0);
  assert.equal(cleanReader.view.preparedClose.recovered, false);

  const dirtyFile = new harness.TFile("Books/preopen-dirty.pdf", [4, 5, 6]);
  const dirtyReader = await createSidecarReader(harness, dirtyFile);
  dirtyReader.view.ready = false;
  dirtyReader.view.currentRevision = 3;
  dirtyReader.view.confirmedRevision = 1;
  assert.equal(await dirtyReader.view.prepareControlledClose("detach"), true);
  assert.equal(dirtyReader.view.preparedClose.unconfirmed, true);

  // Simulate the user leaving the tab open after seeing the warning, then
  // allowing recovery persistence to finish before trying close again.
  dirtyReader.view.cancelPreparedClose(
    dirtyReader.view.documentId,
    dirtyReader.view.openRequest,
  );

  await dirtyReader.view.recoverFile(
    null,
    dirtyReader.view.documentId,
    "preopen-draft",
    3,
    "auto-save-disabled",
    {
      openRequest: dirtyReader.view.openRequest,
      batchId: "preopen-draft-batch",
      operations: [{ uuid: "preopen-durable-annotation", kind: "Highlight", pageIndex: 0,
        deleted: false, payload: { editor: { color: [0, 1, 0] } } }],
    },
  );
  const recoveryAck = dirtyReader.sent.at(-1);
  assert.equal(recoveryAck.type, "recovered");
  assert.equal(recoveryAck.external, true);
  assert.equal(await dirtyReader.view.prepareControlledClose("detach"), true);
  assert.equal(dirtyReader.view.preparedClose.revision, 3);
  assert.equal(dirtyReader.view.preparedClose.recovered, false,
    "a durable sidecar revision is clean external state, not an embedded-PDF recovery draft");
  assert.equal(recoveryAck.batchId, "preopen-draft-batch",
    "the close becomes eligible only after the recovery protocol reports durable operation storage");
});

test("popout migration reopens the unchanged PDF and rehydrates confirmed sidecar operations", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/popout-clean.pdf", [1, 2, 3]);
  const reader = await createSidecarReader(harness, file);
  const { leaf, view, sent, replyClose } = reader;
  const documentId = view.documentId;
  const oldRendererGeneration = view.rendererGeneration;
  const oldOpenRequest = view.openRequest;
  const saved = await saveSidecarOperations(reader, {
    requestId: "popout-confirmed-operation",
    batchId: "popout-confirmed-operation-batch",
    revision: 1,
    operations: [{ uuid: "popout-confirmed-highlight", kind: "Highlight", pageIndex: 0,
      deleted: false, payload: { editor: { color: [0, 0, 1] } } }],
  });
  assert.equal(saved.type, "saved");
  const confirmedRevision = view.confirmedRevision;
  const openCountBeforeMove = sent.filter((message) => message.type === "open").length;

  const moving = harness.app.workspace.moveLeafToPopout(leaf);
  await Promise.resolve();
  replyClose({ revision: confirmedRevision });
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
  assert.equal(sent.filter((message) => message.type === "open").length, openCountBeforeMove,
    "a queued ready from the previous renderer must not open a stale PDF session");

  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });
  const open = await waitForSentMessage(reader, (message) =>
    message.type === "open" && message.openRequest === view.openRequest);
  assert.ok(open);
  assert.deepEqual([...new Uint8Array(open.data)], [1, 2, 3]);
  assert.equal(open.documentId, documentId);
  assert.equal(open.openRequest, view.openRequest);
  assert.equal(open.revision, confirmedRevision);
  assert.equal(open.confirmedRevision, confirmedRevision);
  assert.deepEqual(open.externalAnnotations.annotations.map((operation) => operation.uuid),
    ["popout-confirmed-highlight"], "confirmed operations are replayed into the new renderer");
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
  assert.equal(sent.filter((message) => message.type === "open").length, openCountBeforeMove + 1,
    "a duplicate ready must not resend a second open into an already active document");

  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "opened",
      documentId,
      openRequest: view.openRequest,
      revision: confirmedRevision,
      confirmedRevision,
      dirty: false,
      restorePaused: false,
    },
  });
  assert.equal(view.openAcknowledged, true);
  assert.equal(view.currentRevision, confirmedRevision);
  assert.equal(view.confirmedRevision, confirmedRevision);
});

test("async iframe adoption rebinds the owner before the fresh renderer sends ready", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createSidecarReader(
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
  replyClose({ revision: view.confirmedRevision });
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

  const open = await waitForSentMessage(reader, (message) =>
    message.type === "open" && message.openRequest === view.openRequest);
  assert.ok(open, "The new parent's one-shot ready message must deliver the checkpoint");
  assert.equal(open.documentId, view.documentId);
  assert.equal(open.openRequest, view.openRequest);
  assert.deepEqual([...new Uint8Array(open.data)], [1, 2, 3]);
  assert.ok(newOwnerWindow.messageSenderCalls > 0,
    "The checkpoint message must use the adopted owner's realm");
});

test("popout migration restores confirmed recovery operations without replacing the source PDF", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/popout-paused.pdf", [1, 2, 3]);
  const reader = await createSidecarReader(harness, file);
  const { leaf, view, sent, replyClose } = reader;
  const documentId = view.documentId;
  await saveSidecarOperations(reader, {
    requestId: "recovery-for-popout-base",
    batchId: "recovery-for-popout-base-batch",
    revision: 3,
    operations: [{ uuid: "popout-before-recovery", kind: "Highlight", pageIndex: 0,
      deleted: false, payload: { editor: { color: [1, 0, 0] } } }],
  });
  await view.recoverFile(
    null,
    documentId,
    "recovery-for-popout",
    7,
    "save-conflict",
    {
      openRequest: view.openRequest,
      batchId: "recovery-for-popout-batch",
      operations: [{ uuid: "popout-recovered-operation", kind: "Ink", pageIndex: 0,
        deleted: false, payload: { editor: { paths: [[2, 2, 10, 10]], color: [1, 0, 0] } } }],
    },
  );
  const recoveredRevision = view.confirmedRevision;

  const moving = harness.app.workspace.moveLeafToPopout(leaf);
  await Promise.resolve();
  replyClose({ revision: recoveredRevision });
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

  const open = await waitForSentMessage(reader, (message) =>
    message.type === "open" && message.openRequest === view.openRequest);
  assert.deepEqual([...new Uint8Array(open.data)], [1, 2, 3],
    "migration reloads the immutable source PDF, not a transient recovery byte buffer");
  assert.equal(open.documentId, documentId);
  assert.equal(open.revision, recoveredRevision);
  assert.equal(open.confirmedRevision, recoveredRevision);
  assert.deepEqual(open.externalAnnotations.annotations.map((operation) => operation.uuid).sort(), [
    "popout-before-recovery",
    "popout-recovered-operation",
  ]);
  assert.equal(file.writes, 0, "migration must not turn a recovery draft into an original-PDF write");

  view.onMessage({
    source: reader.frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "opened",
      documentId,
      openRequest: view.openRequest,
      revision: recoveredRevision,
      confirmedRevision: recoveredRevision,
      dirty: false,
      restorePaused: false,
    },
  });
  assert.equal(view.openAcknowledged, true);
  assert.equal(view.currentRevision, recoveredRevision);
  assert.equal(view.confirmedRevision, recoveredRevision);
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

test("an unexpected renderer reload reopens the confirmed PDF and sidecar log, never renderer bytes", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/unexpected-reload.pdf", [1, 2, 3]);
  const reader = await createSidecarReader(harness, file);
  const { view, sent, frame } = reader;
  await saveSidecarOperations(reader, {
    requestId: "reload-confirmed-operation",
    batchId: "reload-confirmed-operation-batch",
    revision: 4,
    operations: [{ uuid: "reload-confirmed-highlight", kind: "Highlight", pageIndex: 0,
      deleted: false, payload: { editor: { color: [1, 1, 0] } } }],
  });
  const oldOpenCount = sent.filter((message) => message.type === "open").length;
  const nextOpenRequest = view.openRequest + 1;
  const previousRendererGeneration = view.rendererGeneration;

  view.iframe.dispatchEvent("load");
  assert.equal(view.ready, false);
  assert.equal(view.rendererStateUnknown, true);
  assert.ok(harness.notices.some((message) => message.includes("未确认的最后操作可能未保存")));

  view.onMessage({
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: previousRendererGeneration,
    },
  });
  assert.equal(sent.filter((message) => message.type === "open").length, oldOpenCount,
    "a ready signal from the replaced renderer generation cannot reopen stale bytes");

  view.onMessage({
    source: frame,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      type: "ready",
      rendererGeneration: view.rendererGeneration,
    },
  });
  const open = await waitForSentMessage(reader, (message) =>
    message.type === "open" && message.openRequest === nextOpenRequest);
  assert.deepEqual([...new Uint8Array(open.data)], [1, 2, 3]);
  assert.equal(open.revision, view.confirmedRevision);
  assert.equal(open.confirmedRevision, view.confirmedRevision);
  assert.equal(open.restoreDirty, false);
  assert.deepEqual(open.externalAnnotations.annotations.map((operation) => operation.uuid),
    ["reload-confirmed-highlight"], "the replacement renderer rehydrates the durable sidecar operation");
  assert.equal(file.writes, 0);
  assert.deepEqual(file.bytes, Uint8Array.from([1, 2, 3]));
});

test("renaming a PDF updates the path while retaining the view session ID", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/before.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const reader = await createSidecarReader(harness, file);
  const { view, sent } = reader;
  const annotationDocumentId = view.annotationDocument.documentId;
  const documentId = view.documentId;

  harness.files.delete(file.path);
  file.path = "Archive/after.pdf";
  file.basename = "after";
  harness.files.set(file.path, file);
  harness.emitVault("rename", file, "Books/before.pdf");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(view.documentId, documentId);
  assert.equal(view.requestedPath, file.path);
  assert.equal(view.annotationDocument.documentId, annotationDocumentId);
  assert.equal((await harness.plugin.annotationHost.store.documentForPath(file.path)).documentId,
    annotationDocumentId, "the sidecar path index follows the rename without creating a new PDF identity");
  assert.equal(await harness.plugin.annotationHost.store.documentForPath("Books/before.pdf"), null);
  assert.equal(sent.at(-1).type, "annotation-path-updated");
  assert.equal(sent.at(-1).documentId, annotationDocumentId);
  assert.equal(sent.at(-1).sourcePath, file.path);
});

test("auto-save preference persists and is sent to open views", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const sent = [];
  view.iframe = { contentWindow: { postMessage: (message) => sent.push(message) } };

  await harness.plugin.setAutoSaveEnabled(false);

  assert.equal(harness.plugin.settings.autoSave, false);
  assert.deepEqual(harness.plugin.persistedData, { autoSave: false, showStatusBar: false, vocabularyEnabled: false,
    vocabularyHighlightLevels: { words: [1, 2, 3, 4, 5], phrases: [1, 2, 3, 4, 5] }, vocabularyDisplayMode: "all",
    vocabularyWordDisplayMode: "whole" });
  assert.equal(sent.at(-1).type, "configure-auto-save");
  assert.equal(sent.at(-1).enabled, false);
});

test("status bar preference defaults off and updates every live Reader immediately", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  assert.equal(harness.plugin.settings.showStatusBar, false);
  const readers = [harness.createView(), harness.createView()];
  for (const view of readers) view.statusBarOpen = true;

  const pending = harness.plugin.setStatusBarEnabled(true);
  assert.equal(harness.plugin.settings.showStatusBar, true);
  assert.ok(readers.every((view) => view.statusBarEnabled === true));
  await pending;
  assert.deepEqual(harness.plugin.persistedData, { autoSave: true, showStatusBar: true, vocabularyEnabled: false,
    vocabularyHighlightLevels: { words: [1, 2, 3, 4, 5], phrases: [1, 2, 3, 4, 5] }, vocabularyDisplayMode: "all",
    vocabularyWordDisplayMode: "whole" });

  await harness.plugin.setStatusBarEnabled(false);
  assert.ok(readers.every((view) => view.statusBarEnabled === false));
  assert.deepEqual(harness.plugin.persistedData, { autoSave: true, showStatusBar: false, vocabularyEnabled: false,
    vocabularyHighlightLevels: { words: [1, 2, 3, 4, 5], phrases: [1, 2, 3, 4, 5] }, vocabularyDisplayMode: "all",
    vocabularyWordDisplayMode: "whole" });
});

test("LingQ-style vocabulary setting renders off, persists across reload, and toggles the authenticated view", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  assert.equal(harness.plugin.settings.vocabularyEnabled, false);

  harness.plugin.settingTab.display();
  const setting = harness.plugin.settingTab.containerEl.settings.find((entry) =>
    entry.name === "启用 LingQ 式本地英语词汇学习");
  assert.ok(setting, "the Obsidian settings tab exposes the local LingQ-style vocabulary control");
  assert.match(setting.description, /默认关闭/);
  assert.match(setting.description, /不连接外部 LingQ 服务/);
  assert.match(setting.description, /00_Archive\/21_VocabularyData\/en\.vocab\.json/);
  assert.equal(setting.toggle.value, false, "the UI starts unchecked for a fresh vault");

  const view = harness.createView();
  view.ready = true;
  view.documentId = "vocab-doc";
  view.openRequest = 4;
  view.rendererGeneration = "vocab-renderer";
  const sent = [];
  view.iframe = { contentWindow: { postMessage: (message) => sent.push(message) } };

  await setting.toggle.change(true);
  assert.equal(harness.plugin.settings.vocabularyEnabled, true);
  assert.equal(harness.plugin.persistedData.vocabularyEnabled, true);
  assert.deepEqual(sent.at(-1), {
    rendererGeneration: "vocab-renderer", channel: "pdf-web-reader", token: view.token,
    type: "vocab-set-enabled", documentId: "vocab-doc", openRequest: 4, enabled: true,
  });

  const reloaded = createHarness();
  reloaded.plugin.persistedData = structuredClone(harness.plugin.persistedData);
  await reloaded.plugin.onload();
  assert.equal(reloaded.plugin.settings.vocabularyEnabled, true,
    "an enabled setting is restored by the next plugin load");
  reloaded.plugin.settingTab.display();
  assert.deepEqual(reloaded.plugin.settingTab.containerEl.headings,
    ["阅读器", "LingQ / 词汇学习", "批注与数据", "诊断 / 高级"]);
  const restoredSetting = reloaded.plugin.settingTab.containerEl.settings.find((entry) =>
    entry.name === "启用 LingQ 式本地英语词汇学习");
  assert.equal(restoredSetting.toggle.value, true, "the Settings UI reflects the persisted enabled value");
  await restoredSetting.toggle.change(false);
  assert.equal(reloaded.plugin.settings.vocabularyEnabled, false);
  assert.equal(reloaded.plugin.persistedData.vocabularyEnabled, false);

  const disabledReload = createHarness();
  disabledReload.plugin.persistedData = structuredClone(reloaded.plugin.persistedData);
  await disabledReload.plugin.onload();
  assert.equal(disabledReload.plugin.settings.vocabularyEnabled, false,
    "a disabled setting also remains disabled after reload");
  assert.equal(disabledReload.plugin.vocabularyService, null,
    "loading while disabled does not initialize the local vocabulary service");

  await setting.toggle.change(false);
  assert.equal(harness.plugin.settings.vocabularyEnabled, false);
  assert.equal(harness.plugin.persistedData.vocabularyEnabled, false);
  assert.equal(sent.at(-1).type, "vocab-set-enabled");
  assert.equal(sent.at(-1).enabled, false);

  harness.plugin.onunload();
  reloaded.plugin.onunload();
  disabledReload.plugin.onunload();
});

test("Context capture stays bound to the confirmed Reader and saves one verified Anchor-backed citation", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  harness.plugin.settings.vocabularyEnabled = true;
  await harness.plugin.getVocabularyService().upsertTerm("walk", { status: 2 });
  const sourceBytes = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 9, 8, 7]);
  const file = new harness.TFile("Books/context-capture.pdf", sourceBytes);
  harness.files.set(file.path, file);
  const reader = await createSidecarReader(harness, file);
  const { view, frame, sent } = reader;
  const requestId = "context-capture-1";
  const send = (type, fields) => view.onMessage({ source: frame, data: {
    channel: "pdf-web-reader", token: view.token, type,
    rendererGeneration: view.rendererGeneration, documentId: view.documentId,
    openRequest: view.openRequest, ...fields,
  } });

  send("reader-vocabulary-context-capture-request", {
    requestId, pageNumber: 1, expectedSurface: "walk",
  });
  const captureRequest = sent.find((message) => message.type === "reader-anchor-capture-request");
  assert.ok(captureRequest, "the authenticated Reader receives a quote-capture request");
  assert.equal(captureRequest.mode, "quote");
  send("reader-anchor-capture", {
    requestId: captureRequest.requestId,
    capture: {
      kind: "selection", pageIndex: 0, pageNumber: 1,
      pageIdentity: view.annotationPageIdentity.orderedPageIdentities[0],
      sourceHash: view.annotationSourceHash,
      exactQuote: "I walk home.", prefix: "", suffix: "",
      textPosition: { start: 0, end: 12 }, geometry: null,
    },
  });
  const preview = await waitForSentMessage(reader, (message) =>
    message.type === "reader-vocabulary-context-preview" && message.requestId === requestId);
  assert.equal(preview.ok, true);
  assert.equal(preview.surface, "walk");
  assert.equal(preview.sentence, "I walk home.");
  assert.ok(preview.captureId);

  send("reader-vocabulary-context-save-request", { requestId, captureId: preview.captureId });
  const saved = await waitForSentMessage(reader, (message) =>
    message.type === "reader-vocabulary-context-save-result" && message.requestId === requestId);
  assert.equal(saved.ok, true, saved.message);
  assert.equal(saved.captureId, preview.captureId);
  assert.equal(saved.documentId, view.documentId);
  assert.equal(saved.openRequest, view.openRequest);
  const contextPaths = [...harness.storedFiles.keys()].filter((item) =>
    item.startsWith("00_Archive/21_VocabularyData/contexts/"));
  assert.ok(contextPaths.some((item) => item.endsWith("/manifest.json")));
  assert.equal(file.writes, 0, "context capture and save never write the source PDF");
  assert.deepEqual(file.bytes, sourceBytes);
  harness.plugin.onunload();
});

test("simultaneous Context save retries share one in-flight operation and cancel preview expiry", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  harness.plugin.settings.vocabularyEnabled = true;
  const view = harness.createView();
  view.documentId = "context-race-doc";
  view.openRequest = 7;
  view.rendererGeneration = "context-race-renderer";
  const sent = [];
  view.iframe = { contentWindow: { postMessage: (message) => sent.push(message) } };
  view.pendingVocabularyContextCaptures = new Map();
  const pending = { captureId: "context-race-capture", requestId: "context-race-request",
    documentId: view.documentId, openRequest: view.openRequest, rendererGeneration: view.rendererGeneration,
    timer: setTimeout(() => {}, 120000), saving: false, savePromise: null };
  view.pendingVocabularyContextCaptures.set(pending.captureId, pending);
  let resolveStarted;
  const started = new Promise((resolve) => { resolveStarted = resolve; });
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let commitCount = 0;
  harness.plugin.commitReaderVocabularyContextSave = async (targetView, target) => {
    commitCount += 1;
    resolveStarted();
    await barrier;
    targetView.pendingVocabularyContextCaptures.delete(target.captureId);
    targetView.postToViewer({ channel: "pdf-web-reader", token: targetView.token,
      type: "reader-vocabulary-context-save-result", requestId: target.requestId,
      captureId: target.captureId, documentId: target.documentId, openRequest: target.openRequest, ok: true });
    return true;
  };
  const message = { requestId: pending.requestId, captureId: pending.captureId,
    documentId: pending.documentId, openRequest: pending.openRequest };
  const first = harness.plugin.handleReaderVocabularyContextSave(view, message);
  await started;
  assert.equal(pending.timer, null, "confirmed saves are not discarded by the preview expiry timer");
  const duplicate = harness.plugin.handleReaderVocabularyContextSave(view, message);
  release();
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true]);
  assert.equal(commitCount, 1);
  assert.equal(sent.filter((entry) => entry.type === "reader-vocabulary-context-save-result").length, 1);
  harness.plugin.onunload();
});

test("authenticated Reader menu toggle persists the single setting and synchronizes Settings and open Readers", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  harness.plugin.settingTab.display();
  const setting = harness.plugin.settingTab.containerEl.settings.find((entry) =>
    entry.name === "启用 LingQ 式本地英语词汇学习");
  const [source, peer] = [harness.createView(), harness.createView()];
  const outgoing = [[], []];
  for (const [index, view] of [source, peer].entries()) {
    view.ready = true;
    view.documentId = "lingq-shared-doc";
    view.openRequest = 17;
    view.rendererGeneration = `lingq-renderer-${index}`;
    view.iframe = { contentWindow: { postMessage: (message) => outgoing[index].push(message) } };
  }
  const sourceFrame = source.iframe.contentWindow;
  source.onMessage({ source: sourceFrame, data: {
    channel: "pdf-web-reader", token: source.token, type: "vocab-toggle-request",
    rendererGeneration: "stale-renderer", documentId: source.documentId,
    openRequest: source.openRequest, enabled: true,
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.plugin.settings.vocabularyEnabled, false, "a stale renderer cannot change the persisted switch");
  source.onMessage({ source: sourceFrame, data: {
    channel: "pdf-web-reader", token: source.token, type: "vocab-toggle-request",
    rendererGeneration: source.rendererGeneration, documentId: source.documentId,
    openRequest: source.openRequest, enabled: true,
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.plugin.settings.vocabularyEnabled, true);
  assert.equal(harness.plugin.persistedData.vocabularyEnabled, true);
  assert.equal(setting.toggle.value, true, "Settings mirrors a change initiated from the Reader menu");
  assert.ok(outgoing.every((messages) => messages.at(-1)?.type === "vocab-set-enabled"),
    "the host broadcasts the new state to every open Reader");
  assert.ok(outgoing.every((messages) => messages.at(-1)?.enabled === true));
  await harness.plugin.getVocabularyService().upsertTerm("kept word", { status: 3, translation: "保留" });
  source.onMessage({ source: sourceFrame, data: {
    channel: "pdf-web-reader", token: source.token, type: "vocab-toggle-request",
    rendererGeneration: source.rendererGeneration, documentId: source.documentId,
    openRequest: source.openRequest, enabled: false,
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.plugin.settings.vocabularyEnabled, false);
  assert.equal(setting.toggle.value, false);
  assert.equal((await harness.plugin.getVocabularyService().getTerm("kept word")).translation, "保留",
    "turning off the UI never deletes persistent vocabulary data");
  assert.ok(outgoing.every((messages) => messages.at(-1)?.type === "vocab-set-enabled" && messages.at(-1)?.enabled === false));
  const reload = createHarness();
  reload.plugin.persistedData = structuredClone(harness.plugin.persistedData);
  await reload.plugin.onload();
  assert.equal(reload.plugin.settings.vocabularyEnabled, false, "the latest disabled state survives a plugin restart");
  harness.plugin.onunload();
  reload.plugin.onunload();
});

test("LingQ display modes persist, redraw all Readers, and survive reload", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  harness.plugin.settingTab.display();
  const modeSetting = harness.plugin.settingTab.containerEl.settings.find((entry) => entry.name === "高亮显示模式");
  assert.ok(modeSetting);
  const readers = [harness.createView(), harness.createView()];
  const outgoing = readers.map((view, index) => {
    view.ready = true;
    view.documentId = `mode-doc-${index}`;
    view.openRequest = 5;
    view.rendererGeneration = `mode-renderer-${index}`;
    const messages = [];
    view.iframe = { contentWindow: { postMessage: (message) => messages.push(message) } };
    return messages;
  });
  const [source] = readers;
  source.onMessage({ source: source.iframe.contentWindow, data: {
    channel: "pdf-web-reader", token: source.token, type: "vocab-display-mode-request",
    rendererGeneration: "stale", documentId: source.documentId, openRequest: source.openRequest,
    mode: "focus",
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.plugin.settings.vocabularyDisplayMode, "all", "stale frame cannot change the setting");
  source.onMessage({ source: source.iframe.contentWindow, data: {
    channel: "pdf-web-reader", token: source.token, type: "vocab-display-mode-request",
    rendererGeneration: source.rendererGeneration, documentId: source.documentId, openRequest: source.openRequest,
    mode: "focus",
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.plugin.settings.vocabularyDisplayMode, "focus");
  assert.equal(harness.plugin.persistedData.vocabularyDisplayMode, "focus");
  assert.ok(outgoing.every((messages) => messages.at(-1)?.type === "vocab-set-display-mode" && messages.at(-1)?.mode === "focus"));
  assert.equal(modeSetting.buttons[2].buttonEl.attributes["aria-pressed"], "true");
  const reloaded = createHarness();
  reloaded.plugin.persistedData = structuredClone(harness.plugin.persistedData);
  await reloaded.plugin.onload();
  assert.equal(reloaded.plugin.settings.vocabularyDisplayMode, "focus");
  reloaded.plugin.onunload();
  harness.plugin.onunload();
});

test("last annotation tool is saved from the authenticated active Reader and restored on open", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const frame = { sent: [], postMessage(message) { this.sent.push(message); } };
  view.documentId = "tool-pref-doc";
  view.openRequest = 8;
  view.rendererGeneration = "tool-pref-renderer";
  view.iframe = { contentWindow: frame };
  view.onMessage({ source: frame, data: {
    channel: "pdf-web-reader", token: view.token, type: "annotation-tool-preference-request",
    rendererGeneration: "stale", documentId: view.documentId, openRequest: view.openRequest, mode: 15,
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.plugin.settings.lastAnnotationToolMode, undefined, "stale renderer cannot update the tool preference");
  view.onMessage({ source: frame, data: {
    channel: "pdf-web-reader", token: view.token, type: "annotation-tool-preference-request",
    rendererGeneration: view.rendererGeneration, documentId: view.documentId, openRequest: view.openRequest, mode: 15,
  } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.plugin.settings.lastAnnotationToolMode, 15);
  assert.equal(harness.plugin.persistedData.lastAnnotationToolMode, 15);

  const file = new harness.TFile("Books/tool-preference.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  view.file = file;
  view.pendingBytes = Uint8Array.from([1, 2, 3]).buffer;
  view.ready = true;
  view.sendPendingDocument();
  assert.equal(frame.sent.at(-1).preferredAnnotationToolMode, 15);
  harness.plugin.onunload();
});

test("word and phrase highlight levels use compact selectors and update every open Reader", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  assert.deepEqual(harness.plugin.settings.vocabularyHighlightLevels,
    { words: [1, 2, 3, 4, 5], phrases: [1, 2, 3, 4, 5] },
    "old settings without level preferences keep all levels visible by default");
  harness.plugin.settingTab.display();
  const settings = harness.plugin.settingTab.containerEl.settings;
  const wordLevels = settings.find((entry) => entry.name === "单词高亮等级");
  const phraseLevels = settings.find((entry) => entry.name === "短语高亮等级");
  const wordKnown = wordLevels.buttons[4];
  const phraseLevelTwo = phraseLevels.buttons[1];
  assert.equal(wordKnown.buttonEl.attributes["aria-pressed"], "true");
  assert.equal(phraseLevelTwo.buttonEl.attributes["aria-pressed"], "true");
  assert.match(wordLevels.description, /不改动词库记录/);

  const readers = [harness.createView(), harness.createView()];
  const sent = readers.map((view) => {
    view.ready = true;
    view.documentId = "vocab-level-doc";
    view.openRequest = 12;
    view.rendererGeneration = "vocab-level-renderer";
    const messages = [];
    view.iframe = { contentWindow: { postMessage: (message) => messages.push(message) } };
    return messages;
  });
  await wordKnown.click();
  await Promise.resolve();
  assert.deepEqual(harness.plugin.settings.vocabularyHighlightLevels,
    { words: [1, 2, 3, 4], phrases: [1, 2, 3, 4, 5] });
  assert.deepEqual(harness.plugin.persistedData.vocabularyHighlightLevels,
    { words: [1, 2, 3, 4], phrases: [1, 2, 3, 4, 5] });
  assert.ok(sent.every((messages) => messages.at(-1).type === "vocab-set-highlight-levels"));
  assert.ok(sent.every((messages) => messages.at(-1).levels.words.join(",") === "1,2,3,4"));

  await phraseLevelTwo.click();
  await Promise.resolve();
  assert.deepEqual(harness.plugin.settings.vocabularyHighlightLevels,
    { words: [1, 2, 3, 4], phrases: [1, 3, 4, 5] }, "word and phrase levels do not affect each other");

  const reloaded = createHarness();
  reloaded.plugin.persistedData = structuredClone(harness.plugin.persistedData);
  await reloaded.plugin.onload();
  reloaded.plugin.settingTab.display();
  const restoredSettings = reloaded.plugin.settingTab.containerEl.settings;
  assert.equal(restoredSettings.find((entry) => entry.name === "单词高亮等级").buttons[4].buttonEl.attributes["aria-pressed"], "false");
  assert.equal(restoredSettings.find((entry) => entry.name === "短语高亮等级").buttons[1].buttonEl.attributes["aria-pressed"], "false");
  reloaded.plugin.onunload();
  harness.plugin.onunload();
});

test("sidecar write failure reports that the unacknowledged operation remains in the live Reader", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/sidecar-failure.pdf", [1, 2, 3]);
  const reader = await createSidecarReader(harness, file);
  const { view } = reader;
  let statusCall = null;
  view.setStatus = (message, options) => { statusCall = { message, options }; };
  const adapter = harness.app.vault.adapter;
  const originalWrite = adapter.write.bind(adapter);
  adapter.write = async (targetPath, value) => {
    if (targetPath.includes("/ops/") && targetPath.endsWith(".pending")) {
      throw new Error("injected sidecar checkpoint verification failure");
    }
    return originalWrite(targetPath, value);
  };

  const error = await saveSidecarOperations(reader, {
    requestId: "sidecar-write-failure",
    batchId: "sidecar-write-failure-batch",
  });

  assert.equal(error.type, "error");
  assert.equal(error.code, "save-failed");
  assert.match(statusCall.message, /injected sidecar checkpoint verification failure/);
  assert.equal(statusCall.options, true, "the host marks the live Reader status as an error");
  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0], /操作仍保留在当前阅读器中/);
  assert.equal(file.writes, 0);
  assert.deepEqual(file.bytes, Uint8Array.from([1, 2, 3]));
  assert.equal((await harness.plugin.annotationHost.store.listOperationBatches(view.annotationDocument)).length, 0,
    "a failed immutable batch write is not acknowledged or left as a partial operation record");
});

test("recovery protocol durably stores structured Ink operations without writing the original PDF", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const file = new harness.TFile("Books/recovery-operations.pdf", [1, 2, 3]);
  harness.files.set(file.path, file);
  const reader = await createSidecarReader(harness, file);
  const { view, sent } = reader;
  const inkOperation = {
    uuid: "recovered-ink-operation",
    kind: "Ink",
    pageIndex: 0,
    deleted: false,
    payload: { editor: { paths: [[0, 0, 12, 12, 24, 6]], color: [0.08, 0.28, 0.78], width: 5 } },
  };
  await view.recoverFile(null, view.documentId, "recover-disabled-autosave", 17,
    "auto-save-disabled", {
      openRequest: view.openRequest,
      batchId: "recovery-ink-sidecar-batch",
      actorId: "recovery-reader",
      operations: [inkOperation],
    });

  assert.equal(file.writes, 0);
  assert.deepEqual([...file.bytes], [1, 2, 3]);
  assert.equal(sent.at(-1).type, "recovered");
  assert.equal(sent.at(-1).documentId, view.documentId);
  assert.equal(sent.at(-1).openRequest, view.openRequest);
  assert.equal(sent.at(-1).requestId, "recover-disabled-autosave");
  assert.equal(sent.at(-1).revision, 17);
  assert.equal(sent.at(-1).external, true);
  const batchPaths = await harness.plugin.annotationHost.store.listOperationBatches(view.annotationDocument);
  assert.equal(batchPaths.length, 1, "recovery ACK follows a durable immutable operation batch");
  const batch = JSON.parse(await harness.app.vault.adapter.read(batchPaths[0]));
  assert.equal(batch.batchId, "recovery-ink-sidecar-batch");
  assert.equal(batch.operations[0].uuid, inkOperation.uuid);
  assert.deepEqual(batch.operations[0].payload, inkOperation.payload);
  assert.deepEqual(await harness.plugin.listRecoveryCandidates(), [],
    "new annotation operations use the sidecar store rather than the legacy PDF recovery queue");
});

test("startup initializes the legacy recovery directory before listing verified candidates", async () => {
  const harness = createHarness();
  const recoveryDirectory = ".obsidian/plugins/pdf-web-reader/.recovery";
  const raw = Uint8Array.from([6, 5, 4]);
  await seedRecoveryCandidate(harness, {
    candidateId: "startup-recovery-order",
    originalPath: "Books/startup-order.pdf",
    bytes: raw,
  });

  await harness.plugin.onload();

  assert.equal(harness.plugin.recoveryDirectory, recoveryDirectory);
  const candidates = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidates.length, 1, "the configured recovery directory exposes its verified legacy candidate");
  assert.equal(candidates[0].metadata.candidateId, "startup-recovery-order");
  assert.deepEqual([...new Uint8Array(await harness.plugin.readRecoveryBytes(candidates[0]))], [...raw]);
});

test("malformed primary recovery metadata falls back to its verified immutable raw descriptor", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const raw = Uint8Array.from([9, 8, 7, 6]);
  const seeded = await seedRecoveryCandidate(harness, {
    candidateId: "torn-primary-recovery",
    originalPath: "Books/torn-close-intent.pdf",
    bytes: raw,
    reason: "close-writeback",
    rawmeta: true,
  });
  const adapter = harness.app.vault.adapter;
  await adapter.write(seeded.metadataPath, "{\"truncated\":");
  const candidates = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidates.length, 1, "a torn mutable descriptor does not hide the independently verified candidate");
  assert.equal(candidates[0].metadata.candidateId, seeded.metadata.candidateId);
  assert.equal(candidates[0].metadata.requestId, seeded.metadata.requestId);
  assert.deepEqual([...new Uint8Array(await harness.plugin.readRecoveryBytes(candidates[0]))], [...raw]);
  assert.equal(await adapter.read(seeded.metadataPath), '{"truncated":',
    "listing falls back to rawmeta without silently overwriting the damaged primary descriptor");
});

test("saved tombstones suppress rawmeta replay and missing or incomplete metadata falls back safely", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const completed = await seedRecoveryCandidate(harness, {
    candidateId: "saved-close-candidate",
    originalPath: "Books/rawmeta-fallback.pdf",
    bytes: [1, 2, 9],
    status: "saved",
    rawmeta: true,
  });
  const primaryMissing = await seedRecoveryCandidate(harness, {
    candidateId: "missing-primary-candidate",
    originalPath: "Books/rawmeta-fallback.pdf",
    bytes: [1, 2, 8],
    rawmeta: true,
    primary: false,
  });
  const incompletePrimary = await seedRecoveryCandidate(harness, {
    candidateId: "incomplete-primary-candidate",
    originalPath: "Books/rawmeta-fallback.pdf",
    bytes: [1, 2, 7],
    reason: "close-writeback",
    rawmeta: true,
  });
  const incompleteMetadata = { ...incompletePrimary.metadata };
  delete incompleteMetadata.outputHash;
  delete incompleteMetadata.outputLength;
  await harness.app.vault.adapter.write(incompletePrimary.metadataPath,
    `${JSON.stringify(incompleteMetadata, null, 2)}\n`);

  const candidates = await harness.plugin.listRecoveryCandidates();
  assert.equal(candidates.some(({ metadata }) => metadata.candidateId === completed.metadata.candidateId), false,
    "a valid saved tombstone must not fall back to the old raw draft");
  const restored = candidates.find(({ metadata }) => metadata.candidateId === primaryMissing.metadata.candidateId);
  assert.ok(restored, "the immutable raw descriptor reconstructs a candidate whose primary JSON is missing");
  assert.deepEqual([...new Uint8Array(await harness.plugin.readRecoveryBytes(restored))], [1, 2, 8]);
  const restoredIncomplete = candidates.find(({ metadata }) => metadata.candidateId === incompletePrimary.metadata.candidateId);
  assert.ok(restoredIncomplete,
    "syntactically valid but incomplete close metadata falls back to the verified raw descriptor");
  assert.equal(restoredIncomplete.metadata.outputHash, incompletePrimary.metadata.outputHash);
  assert.deepEqual([...new Uint8Array(await harness.plugin.readRecoveryBytes(restoredIncomplete))], [1, 2, 7]);
});

test("failed recovery verification preserves the candidate and creates no partial visible copy", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const record = await seedRecoveryCandidate(harness, {
    candidateId: "verification-failure-recovery",
    originalPath: "Books/partial-close-cleanup.pdf",
    bytes: [1, 2, 4],
  });
  const adapter = harness.app.vault.adapter;
  await adapter.writeBinary(record.candidatePath, Uint8Array.from([9, 9, 9]).buffer);
  await assert.rejects(harness.plugin.restoreLatestRecovery(), /恢复副本校验未通过/);
  assert.equal(harness.files.has("PDF Recovery"), false, "no visible output is created from unverified bytes");
  assert.equal(await adapter.exists(record.candidatePath), true);
  assert.equal(await adapter.exists(record.metadataPath), true,
    "verification failure preserves the original candidate and descriptor for inspection or retry");
  assert.equal((await harness.plugin.listRecoveryCandidates()).length, 1);
});

test("recovered Ink operation is durable before ACK while the source PDF remains byte-identical", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const original = new Uint8Array(await readFile(path.join(root, "tests/fixtures/tracemonkey.pdf")));
  const source = await PDFDocument.load(original);
  assert.equal(source.getPageCount(), 14);
  const file = new harness.TFile("Books/ink-editor-11-page-10.pdf", original);
  harness.files.set(file.path, file);
  const identity = {
    pageCount: 14,
    orderedPageIdentities: Array.from({ length: 14 }, (_, index) => `${index + 1} 0 R`),
  };
  const reader = await createSidecarReader(harness, file, identity);
  const { view, sent, replyClose } = reader;
  const operation = {
    uuid: "native-ink-11",
    pageIndex: 9,
    kind: "Ink",
    deleted: false,
    payload: { editor: { inkList: [[64, 80, 108, 117, 146, 99]], color: [0.08, 0.28, 0.78], width: 5 } },
  };
  await view.recoverFile(null, view.documentId, "close-recovery-ink-11", 11,
    "save-conflict", {
      openRequest: view.openRequest,
      batchId: "close-recovery-ink-11-batch",
      actorId: "native-ipad-device",
      operations: [operation],
    });

  assert.equal(sent.at(-1).type, "recovered");
  assert.equal(sent.at(-1).revision, 11);
  assert.equal(sent.at(-1).external, true,
    "the recovery response identifies the external operation store as its durable destination");
  assert.equal(file.writes, 0, "raw recovery never overwrites the source PDF");
  assert.deepEqual([...file.bytes], [...original]);
  const batches = await harness.plugin.annotationHost.store.listOperationBatches(view.annotationDocument);
  assert.equal(batches.length, 1, "the Ink operation batch is stored before its recovered acknowledgement");
  const batch = JSON.parse(await harness.app.vault.adapter.read(batches[0]));
  assert.equal(batch.operations[0].uuid, "native-ink-11");
  assert.equal(batch.operations[0].kind, "Ink");
  assert.equal(batch.operations[0].pageIndex, 9);
  assert.deepEqual(batch.operations[0].payload, operation.payload);
  const closing = view.prepareControlledClose("detach");
  await settleMicrotasks();
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1);
  replyClose({ revision: 11 });
  assert.equal(await closing, true,
    "the durable revision permits close after the Viewer confirms external persistence");
  assert.equal(view.preparedClose.revision, 11);
  assert.equal(view.preparedClose.recovered, false);
  assert.equal(view.preparedClose.revision, 11);
});

test("queued recovery keeps its sidecar batch with the source PDF when the view switches", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const first = new harness.TFile("Books/recovery-before-switch.pdf", [1, 2, 3]);
  const second = new harness.TFile("Books/recovery-after-switch.pdf", [7, 7, 7]);
  harness.files.set(first.path, first);
  harness.files.set(second.path, second);
  const reader = await createSidecarReader(harness, first);
  const { view } = reader;
  const originalDocument = view.annotationDocument;
  const adapter = harness.app.vault.adapter;
  let releaseQueue;
  let startedQueue;
  const queueStarted = new Promise((resolve) => { startedQueue = resolve; });
  const gate = new Promise((resolve) => { releaseQueue = resolve; });
  const originalWrite = adapter.write.bind(adapter);
  let gated = false;
  adapter.write = async (targetPath, value) => {
    if (!gated && targetPath.includes("/ops/") && targetPath.endsWith(".pending")) {
      gated = true;
      startedQueue();
      await gate;
    }
    return originalWrite(targetPath, value);
  };
  const recovery = view.recoverFile(null, view.documentId, "queued-recovery", 22,
    "save-conflict", {
      openRequest: view.openRequest,
      batchId: "queued-recovery-sidecar-batch",
      operations: [{ uuid: "queued-recovery-annotation", kind: "Highlight", pageIndex: 0,
        deleted: false, payload: { editor: { color: [0, 1, 0] } } }],
    });
  await queueStarted;
  const oldDocumentId = view.documentId;

  await view.openFile(second);
  assert.notEqual(view.documentId, oldDocumentId);
  releaseQueue();
  await recovery;

  assert.equal(first.writes, 0);
  assert.equal(second.writes, 0);
  assert.deepEqual([...first.bytes], [1, 2, 3]);
  assert.deepEqual([...second.bytes], [7, 7, 7]);
  assert.equal(reader.sent.at(-1).type, "error");
  assert.equal(reader.sent.at(-1).code, "PDF_ANNOTATION_SESSION_CHANGED");
  assert.equal(originalDocument.documentId, oldDocumentId);
  const oldBatches = await harness.plugin.annotationHost.store.listOperationBatches(originalDocument);
  assert.equal(oldBatches.length, 1, "the queued immutable batch remains under the source document identity");
  const oldBatch = JSON.parse(await adapter.read(oldBatches[0]));
  assert.equal(oldBatch.operations[0].uuid, "queued-recovery-annotation");
  const currentSnapshot = await harness.plugin.annotationHost.store.readDocument(view.annotationDocument);
  assert.deepEqual(currentSnapshot.annotations, [], "the old recovery operation is not misapplied to the newly selected PDF");
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
  assert.match(harness.notices[0], /已写入外置恢复记录/);
  assert.doesNotMatch(harness.notices[0], /保持标签打开/);
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
  assert.match(harness.notices[0], /最新更改尚未确认保存/);
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

test("controlled close registers its session before sending prepare-close", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { view, sent, frame } = await createControlledReader(
    harness,
    new harness.TFile("Books/prepare-close-registration.pdf"),
  );

  let duplicatePreparing = null;
  let reentered = false;
  frame.postMessage = (message) => {
    sent.push(message);
    if (message.type === "prepare-close" && !reentered) {
      reentered = true;
      duplicatePreparing = view.prepareControlledClose("detach");
    }
  };
  const preparing = view.prepareControlledClose("detach");
  await settleMicrotasks();
  const request = sent.find((message) => message.type === "prepare-close");
  assert.ok(request, "A ready Reader must receive a controlled close request");
  assert.ok(duplicatePreparing, "a synchronous reentrant caller joins the registered session");
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1,
    "reentrant close does not post a duplicate Viewer request");
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
    },
  });
  assert.equal(await preparing, true);
  assert.equal(await duplicatePreparing, true);
  assert.equal(view.preparedClose.documentId, view.documentId);
  assert.equal(view.closePreparation, null);
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

test("controlled close shares one pending prepare request and permits close after a failed Viewer acknowledgement", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { leaf, view, sent, replyClose } = await createControlledReader(
    harness,
    new harness.TFile("Books/close-quiesce-order.pdf"),
  );

  const first = view.prepareControlledClose("detach");
  const duplicate = view.prepareControlledClose("detach");
  await settleMicrotasks();
  assert.equal(sent.filter((message) => message.type === "prepare-close").length, 1);
  assert.equal(leaf.detached, undefined);
  replyClose({ ok: false, dirty: true, prepared: false });
  assert.deepEqual(await Promise.all([first, duplicate]), [true, true],
    "concurrent close callers share the same best-effort close result");
  assert.equal(leaf.detached, undefined);
  assert.equal(view.preparedClose.unconfirmed, true);
  assert.ok(sent.some((message) => message.type === "cancel-close"));
});

test("controlled close uses a short best-effort Viewer acknowledgement budget", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { view, sent } = await createControlledReader(
    harness,
    new harness.TFile("Books/close-quiesce-ack-budget.pdf"),
  );
  const originalNow = Date.now;
  let now = originalNow();
  let request = null;
  const ownerWindow = view.getOwnerWindow();
  Date.now = () => now;

  try {
    const preparing = view.prepareControlledClose("detach");
    await settleMicrotasks();
    const message = sent.find((item) => item.type === "prepare-close");
    assert.ok(message, "the ready Viewer receives the controlled-close request");
    request = view.flushRequests.get(message.id);
    assert.ok(request);
    assert.equal(request.deadline, now + 250,
      "the Viewer gets only a short chance to confirm before a user close proceeds");
    const timer = ownerWindow.timers.get(request.timer);
    assert.equal(timer?.delay, 250);
    now += 251;
    assert.equal(ownerWindow.fireTimeout(request.timer), true,
      "the deadline expires the close request when the Viewer never responds");
    assert.equal(await preparing, true);
    assert.equal(view.flushRequests.size, 0);
    assert.equal(view.preparedClose.unconfirmed, true);
  } finally {
    if (request?.timer !== null && request?.timer !== undefined) {
      ownerWindow.clearTimeout(request.timer);
      request.finish?.({ ok: false, dirty: true });
    }
    Date.now = originalNow;
  }
});

test("controlled close permits a same-document close if its Viewer becomes unavailable before send", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const { view, sent } = await createControlledReader(
    harness,
    new harness.TFile("Books/close-quiesce-stale-session.pdf"),
  );
  const preparing = view.prepareControlledClose("detach");
  view.ready = false;
  assert.equal(await preparing, true);
  assert.equal(sent.some((message) => message.type === "prepare-close"), false,
    "the captured renderer is revalidated immediately before posting close");
  assert.equal(view.flushRequests.size, 0);
  assert.equal(view.preparedClose.unconfirmed, true);
});

test("failed controlled detach still closes the Reader leaf with an unconfirmed-save warning", async () => {
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

  assert.equal(result, leaf);
  assert.equal(leaf.detached, true);
  assert.equal(harness.leaves.includes(leaf), false);
  assert.ok(sent.some((message) => message.type === "cancel-close"));
  assert.ok(harness.notices.some((notice) => notice.includes("最新更改尚未确认保存")));
});

test("controlled detach does not trust a mismatched close ack but allows the user to close", async () => {
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
  assert.equal(result, leaf);
  assert.equal(leaf.detached, true);
  assert.ok(harness.notices.some((notice) => notice.includes("最新更改尚未确认保存")));
  assert.ok(sent.some((message) => message.type === "cancel-close"));
});

test("controlled detach accepts a Viewer-confirmed durable recovery batch", async () => {
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
  assert.ok(harness.notices.some((notice) => notice.includes("已写入外置恢复记录")),
    "a recovered close is accepted and reports its durable recovery destination");
});

test("popout beforeunload gives Readers a brief flush chance then closes with an unconfirmed warning", async () => {
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
  await firstClose;
  assert.equal(popout.originalCloseCalls, 1);
  assert.equal(ownerWindow.closed, true);
  assert.equal(reader.leaf.detached, true);
  assert.ok(reader.sent.some((message) => message.type === "cancel-close"));
  assert.equal(popout.detachResults[0], reader.leaf,
    "Prepared detach must stay synchronous while the SDK parent ignores its return value");
  assert.equal(reader.sent.some((message) => message.type === "flush"), false);
});

test("stale popout beforeunload gate allows native close when no Reader remains", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-empty-beforeunload.pdf"),
  );
  const { ownerWindow, popout } = attachReadersToPopout(harness, [reader]);
  const gate = harness.plugin.popoutCloseGates.get(ownerWindow);
  assert.ok(gate);
  const installedWrapper = popout.close;

  // Simulate a stale gate whose Reader has already left this split but whose
  // reference has not yet been pruned from the gate itself.
  popout.leaves = [];
  reader.leaf.popoutRoot = null;
  reader.leaf.parent = null;
  harness.plugin.views.delete(reader.view);
  assert.equal(gate.views.has(reader.view), true);
  assert.equal(harness.plugin.popoutViewsForGate(gate).length, 0);

  const event = { returnValue: true };
  assert.equal(ownerWindow.dispatchEvent("beforeunload", event), true);
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.immediateStopped, false);
  assert.equal(ownerWindow.closed, true);
  assert.equal(popout.originalCloseCalls, 1,
    "With no live Reader, Obsidian's beforeunload close should run synchronously");
  assert.equal(popout.destroyWindowCalls, 1);
  assert.equal(popout.win, null);
  assert.equal(gate.active, false);
  assert.equal(harness.plugin.popoutCloseGates.has(ownerWindow), false);
  assert.equal(ownerWindow.listeners.get("beforeunload").has(gate.beforeUnloadListener), false);
  assert.equal(popout.close, gate.originalClose);
  assert.notEqual(popout.close, installedWrapper);
  assert.equal(gate.views.size, 0);
  assert.equal(reader.view.popoutCloseGate, null);
  assert.equal(reader.sent.some((message) => message.type === "prepare-close"), false);
  assert.equal(harness.notices.length, 0);
});

test("direct SDK close disposes a stale zero-Reader popout gate", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const reader = await createControlledReader(
    harness,
    new harness.TFile("Books/popout-empty-direct-close.pdf"),
  );
  const { ownerWindow, popout } = attachReadersToPopout(harness, [reader]);
  const gate = harness.plugin.popoutCloseGates.get(ownerWindow);
  assert.ok(gate);
  const installedWrapper = popout.close;

  popout.leaves = [];
  reader.leaf.popoutRoot = null;
  reader.leaf.parent = null;
  harness.plugin.views.delete(reader.view);
  assert.equal(gate.views.has(reader.view), true);
  assert.equal(harness.plugin.popoutViewsForGate(gate).length, 0);

  assert.equal(popout.close(), undefined);
  assert.equal(popout.originalCloseCalls, 1);
  assert.equal(popout.destroyWindowCalls, 1);
  assert.equal(ownerWindow.closed, true);
  assert.equal(popout.win, null);
  assert.equal(gate.active, false);
  assert.equal(harness.plugin.popoutCloseGates.has(ownerWindow), false);
  assert.equal(ownerWindow.listeners.get("beforeunload").has(gate.beforeUnloadListener), false);
  assert.equal(popout.close, gate.originalClose);
  assert.notEqual(popout.close, installedWrapper);
  assert.equal(gate.views.size, 0);
  assert.equal(reader.view.popoutCloseGate, null);
  assert.equal(reader.sent.some((message) => message.type === "prepare-close"), false);
  assert.equal(harness.notices.length, 0);
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

test("popout parent close proceeds when a Reader cannot confirm its latest save", async () => {
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
  await close;
  assert.equal(popout.originalCloseCalls, 1);
  assert.equal(popout.destroyWindowCalls, 1);
  assert.equal(ownerWindow.closed, true);
  assert.equal(first.leaf.detached, true);
  assert.equal(second.leaf.detached, true);
  assert.equal(first.view.preparedClose, null,
    "the peer's prepared state is disposed with its Reader");
  assert.equal(first.sent.some((message) => message.type === "cancel-close"), false,
    "a confirmed Reader remains prepared until the parent actually closes it");
  assert.ok(harness.notices.some((notice) => notice.includes("最新更改尚未确认保存")));
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
  const source = await PDFDocument.create();
  source.addPage([300, 400]);
  const sourceBytes = new Uint8Array(await source.save());
  const recovery = await PDFDocument.create();
  recovery.addPage([300, 400]);
  recovery.setTitle("Verified legacy recovery candidate");
  const recoveryBytes = new Uint8Array(await recovery.save());
  const sourceFile = new harness.TFile("Books/recover.pdf", sourceBytes);
  harness.files.set(sourceFile.path, sourceFile);
  const candidate = await seedRecoveryCandidate(harness, {
    candidateId: "visible-legacy-recovery",
    originalPath: sourceFile.path,
    bytes: recoveryBytes,
    status: "conflict",
  });

  const restoredPath = await harness.plugin.restoreLatestRecovery();

  assert.match(restoredPath, /^PDF Recovery\/recover \(Recovered /);
  assert.deepEqual(harness.files.get(restoredPath).bytes, recoveryBytes);
  assert.deepEqual(sourceFile.bytes, sourceBytes);
  assert.equal(sourceFile.writes, 0, "restoring a candidate creates a separate output rather than editing the source");
  assert.equal((await harness.plugin.listRecoveryCandidates()).length, 1,
    "Restore must leave the original recovery candidate intact");
  assert.equal((await harness.plugin.listRecoveryCandidates())[0].metadata.candidateId,
    candidate.metadata.candidateId);
});

test("recovery restore verifies bytes, falls back to an intact candidate, and retains corruption", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const adapter = harness.app.vault.adapter;
  const intact = new Uint8Array(await (async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]);
    document.setTitle("Older intact recovery");
    return document.save();
  })());
  const corrupted = await seedRecoveryCandidate(harness, {
    candidateId: "newer-corrupt-recovery",
    originalPath: "Books/recovery-order.pdf",
    bytes: [4, 5, 6],
    metadataOverrides: { createdAt: "2026-10-15T01:00:00.000Z" },
  });
  const older = await seedRecoveryCandidate(harness, {
    candidateId: "older-intact-recovery",
    originalPath: "Books/recovery-order.pdf",
    bytes: intact,
    metadataOverrides: { createdAt: "2026-10-14T01:00:00.000Z" },
  });
  await adapter.writeBinary(corrupted.candidatePath, Uint8Array.from([9, 9, 9]).buffer);

  const restoredPath = await harness.plugin.restoreLatestRecovery();

  assert.match(restoredPath, /^PDF Recovery\/recovery-order \(Recovered /);
  assert.deepEqual(harness.files.get(restoredPath).bytes, intact,
    "restore skips the newest candidate whose bytes fail the recorded digest");
  assert.equal(await adapter.exists(corrupted.candidatePath), true,
    "a corrupt candidate remains available for inspection rather than being deleted");
  assert.equal(await adapter.exists(corrupted.metadataPath), true);
  assert.equal(await adapter.exists(older.candidatePath), true,
    "successful restoration also preserves the source recovery candidate");
  assert.equal((await harness.plugin.listRecoveryCandidates()).length, 2);
});


test("Vocabulary workbench host keeps list/dictionary/hot-path stores separate and journals opt-in review", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  assert.equal(harness.plugin.vocabularyRuntime, null, "startup does not load learning stores");
  const service = harness.plugin.getVocabularyService();
  await service.upsertTerm("walk", { status: 2, translation: "走" });
  await service.upsertTerm("known", { status: 5 });
  let lookups = 0;
  harness.plugin.getVocabularyDictionary = () => ({ lookup: async () => { lookups++; return { translation: "词典释义" }; } });
  const api = harness.plugin.createVocabularyWorkbenchApi();
  const page = await api.listFamilies({ limit: 100 });
  assert.equal(page.families.length, 2);
  assert.equal(lookups, 0);
  assert.equal(harness.plugin.vocabularyRuntime, null, "listing remains personal-only");
  const walk = await service.getFamily("walking"), known = await service.getFamily("known");
  await api.getFamilyDetails(walk.familyKey);
  assert.equal(lookups, 1, "only explicit details query the dictionary");
  await api.updateFamily({ familyKey: walk.familyKey, surface: "walk", fields: { note: "工作台编辑" } });
  assert.equal((await service.getTerm("walk")).note, "工作台编辑");
  const result = await api.setReviewEnrollment([walk.familyKey, known.familyKey], { enrolled: true });
  assert.equal(result.results[1].status, "skipped-known");
  const duePage=await api.listDueReview({limit:100});
  assert.equal(duePage.items.length,1);
  assert.equal(duePage.items[0].providerId,'vocabulary');
  assert.equal(duePage.items[0].familyKey,walk.familyKey);
  assert.equal(duePage.nextCursor,null);
  assert.equal(duePage.total,undefined,'mixed providers do not invent an exact global total');
  const beforeMatch = new Map(harness.storedFiles);
  await service.matchPageTokens(["walking", "known"]);
  assert.deepEqual([...harness.storedFiles], [...beforeMatch], "matching cannot mutate Review or history");
  await api.close();
  assert.equal((await harness.plugin.vocabularyRuntime.history.listBatches()).filter((batch) => batch.actionKind === "review-final").length, 1);
  const bundle = JSON.parse(await api.exportJson());
  assert.equal(bundle.kind, "pdf-reader-vocabulary-bundle");
  assert.equal(bundle.stores.core.records.length, 2);
  assert.equal(bundle.stores.review.records.length, 1, "JSON backup includes acknowledged Review state");
  const restored = createHarness({ storageProtocol: "wal" });
  await restored.plugin.onload();
  const imported = await restored.plugin.importVocabulary(JSON.stringify(bundle), "json", { defaultStatus: 1 });
  assert.equal(imported.status, "committed");
  assert.equal((await restored.plugin.getVocabularyService().getTerm("walk")).note, "工作台编辑");
  const restoredDue=await restored.plugin.createVocabularyWorkbenchApi().listDueReview({limit:100});
  assert.equal(restoredDue.items.length,1);
  assert.equal(restoredDue.items[0].familyKey,walk.familyKey);
  assert.equal(restoredDue.items[0].state.box,duePage.items[0].state.box);
  assert.equal(restoredDue.items[0].dueAt,duePage.items[0].dueAt);
  assert.equal(restoredDue.nextCursor,null);
  await restored.plugin.createVocabularyWorkbenchApi().close();
  restored.plugin.onunload();
  assert.ok([...harness.storedFiles.keys()].filter((path) => path.startsWith("00_Archive/")).every((path) => path.startsWith("00_Archive/21_VocabularyData/")));
  harness.plugin.onunload();
});

test("Review host applies stable acknowledged ratings without rewriting personal vocabulary and coalesces close", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  const service = harness.plugin.getVocabularyService();
  await service.upsertTerm("reviewable", { status: 2, translation: "待复习" });
  const family = await service.getFamily("reviewable");
  const corePath = "00_Archive/21_VocabularyData/en.vocab.json";
  const coreBefore = harness.storedFiles.get(corePath);
  const api = harness.plugin.createVocabularyWorkbenchApi();
  await assert.rejects(api.applyReviewAction({ kind: "remember", familyKey: family.familyKey }), /稳定.*action ID/);
  await api.setReviewEnrollment([family.familyKey], { enrolled: true });

  const first = await api.applyReviewAction({ kind: "remember", familyKey: family.familyKey, actionId: "host-review-action-1" });
  const retry = await api.applyReviewAction({ kind: "remember", familyKey: family.familyKey, actionId: "host-review-action-1" });
  assert.equal(first.state.box, 2);
  assert.equal(retry.status, "duplicate");
  assert.equal(retry.state.box, 2, "retrying the acknowledged action does not advance twice");
  assert.equal(harness.storedFiles.get(corePath), coreBefore, "Review ratings never rewrite en.vocab.json");
  const afterRating=await api.listDueReview({limit:100});
  assert.equal(afterRating.items.length,0,'remembering moves the card to its next UTC interval');
  assert.equal(afterRating.nextCursor,null);

  const runtime = harness.plugin.vocabularyRuntime;
  await Promise.all([api.close(), api.close(), runtime.close()]);
  const history = await runtime.history.listBatches();
  assert.equal(history.filter((batch) => batch.batchId.startsWith("review-final:")).length, 1);
  harness.plugin.onunload();
});


test("Workbench command opens the shared factory class with a narrow lazy host facade", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  harness.plugin.commands.get("manage-local-english-vocabulary").callback();
  const modal = harness.plugin.vocabularyWorkbench;
  assert.equal(modal.opened, true);
  assert.equal(typeof modal.api.listFamilies, "function");
  assert.equal(typeof modal.api.exportJson, "function");
  assert.equal(harness.plugin.vocabularyRuntime, null, "opening the shell does not eagerly load Review/Context/History");
  await assert.rejects(modal.api.setReviewEnrollment(Array(101).fill("family"), { enrolled: true }), RangeError);
  assert.equal([...harness.storedFiles.keys()].some((path) => path.startsWith("00_Archive/21_VocabularyData/")), false,
    "oversized bulk input is rejected before any vocabulary data writes");
  harness.plugin.onunload();
});

test('learning Host wiring stays lazy and accepts only the authenticated current Reader request', async () => {
  const harness=createHarness({storageProtocol:'wal'});
  await harness.plugin.onload();
  assert.equal(typeof harness.plugin.getLearningHost,'function');
  assert.equal(harness.plugin.learningHost,null);
  const api=harness.plugin.createVocabularyWorkbenchApi();
  for(const name of ['addContextToReview','openReviewSource','exportLearning'])assert.equal(typeof api[name],'function');
  assert.equal(harness.plugin.learningHost,null,'workbench shell must not initialize learning state');
  assert.ok(harness.plugin.commands.has('add-markdown-selection-to-review'));
  const reader=await createSidecarReader(harness,new harness.TFile('Books/learning-message.pdf'));
  const calls=[];
  harness.plugin.getLearningHost=()=>({fromAnnotationRequest:async(view,message)=>calls.push({view,message})});
  const {view,frame}=reader;
  const message={channel:'pdf-web-reader',token:view.token,type:'learning-review-draft-request',
    documentId:view.documentId,openRequest:view.openRequest,rendererGeneration:view.rendererGeneration,
    uuid:'exact-highlight',pageIndex:0,targetText:'quote'};
  for(const invalid of [{token:'wrong'},{documentId:'old'},{openRequest:-1},{rendererGeneration:'old'}]) {
    view.onMessage({source:frame,data:{...message,...invalid}});
  }
  view.onMessage({source:{},data:message});
  await settleMicrotasks();
  assert.equal(calls.length,0);
  view.onMessage({source:frame,data:message});
  await settleMicrotasks();
  assert.equal(calls.length,1);
  assert.equal(calls[0].view,view);
  assert.equal(calls[0].message,message);
  assert.equal(harness.storedFiles.has('00_Archive/21_VocabularyData/learning/items/manifest.json'),false);
  harness.plugin.onunload();
});

test("selection Reader navigation stops if source verification changes during anchor lookup", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const originalBytes = Uint8Array.from([37, 80, 68, 70, 1, 2, 3]);
  const file = new harness.TFile("Books/anchor-race.pdf", originalBytes);
  const reader = await createSidecarReader(harness, file, {
    pageCount: 1, orderedPageIdentities: ["verified-page-one"],
  });
  const { view } = reader;
  assert.equal(view.annotationHydrationAllowed, true);
  assert.equal(view.annotationSourceMismatch, false);

  const target = { kind: "selection", id: "anchor-race-target",
    docKey: view.annotationDocument.docKey, documentId: view.annotationDocument.documentId, pageNumber: 1 };
  view.pendingReaderTarget = target;
  view.navigationState = { readerTarget: target };

  let markLookupStarted;
  const lookupStarted = new Promise((resolve) => { markLookupStarted = resolve; });
  let resumeLookup;
  const pendingAnchor = new Promise((resolve) => { resumeLookup = resolve; });
  harness.plugin.readerAnchorStore = { get: (...args) => {
    markLookupStarted(args);
    return pendingAnchor;
  } };
  const navigation = view.applyPendingReaderTarget();
  const [docKey, anchorId, documentId] = await lookupStarted;
  assert.deepEqual([docKey, anchorId, documentId],
    [target.docKey, target.id, target.documentId]);

  file.bytes = Uint8Array.from([37, 80, 68, 70, 9, 8, 7]);
  assert.equal(await harness.plugin.annotationHost.handleSourceModify(file), true,
    "the existing host source-modify path handles the changed PDF bytes");
  assert.equal(view.annotationSourceMismatch, true);
  assert.equal(view.annotationHydrationAllowed, false);

  resumeLookup({
    anchorId: target.id,
    docKey: target.docKey,
    documentId: target.documentId,
    sourceHash: view.annotationSourceHash,
    pageIdentity: "verified-page-one",
    pageCount: 1,
    orderedPageIdentityDigest: await harness.plugin.pdfHashRuntime.fingerprint(
      new TextEncoder().encode(JSON.stringify(["verified-page-one"])),
    ),
  });
  assert.equal(await navigation, false,
    "navigation is discarded after async work observes source hydration has been revoked");
  assert.equal(reader.sent.some((message) => message.type === "reader-anchor-navigate"), false,
    "the prior PDF's Selection Anchor is never applied to the modified source");
  harness.plugin.onunload();
});

test("learning Markdown Source opens exact large excerpts without widening generic backlink limits", async () => {
  const { fromMarkdown } = sourceRequire("./semantic/semantic-anchor.cjs");
  for (const length of [4097, 100000]) {
    const harness = createHarness();
    await harness.plugin.onload();
    const noteFile = new harness.TFile("Notes/Large Learning.md");
    harness.files.set(noteFile.path, noteFile);
    const excerpt = "x".repeat(length);
    const editor = {
      value: `prefix ${excerpt} suffix`, selections: [], cursors: [], focuses: 0,
      getValue() { return this.value; },
      offsetToPos(offset) { return { line: 0, ch: offset }; },
      setSelection(from, to) { this.selections.push([{ ...from }, { ...to }]); },
      setCursor(pos) { this.cursors.push({ ...pos }); },
      // Match Obsidian's Editor API rather than accepting a bare position.
      scrollIntoView(range, center) {
        assert.deepEqual(range, { from: { line: 0, ch: 7 }, to: { line: 0, ch: 7 + length } });
        assert.equal(center, true);
      },
      focus() { this.focuses++; },
    };
    harness.app.workspace.activeLeaf = { view: {
      file: noteFile, editor, containerEl: {}, getViewType: () => "markdown",
    } };
    harness.app.workspace.getLeavesOfType = type => type === "markdown" ? [harness.app.workspace.activeLeaf] : [];
    let opens = 0;
    harness.app.workspace.openLinkText = async () => { opens++; };
    const row = { sourcePath: noteFile.path, offset: 7, endOffset: 7 + length,
      line: 0, sourceText: excerpt };
    const exactOptions = { source: "learning-item", requireExact: true };
    let host, saved;
    if (length === 4097) {
      host = harness.plugin.getLearningHost();
      const service = await host.getService();
      const source = fromMarkdown({ sourcePath: noteFile.path, offset: 7,
        endOffset: 7 + length, line: 0, text: excerpt });
      const draft = service.createDraft({ source, prompt: "Large excerpt?" });
      saved = await service.confirmDraft(draft.draftId, { actionId: `large-${length}` });
      assert.equal(saved.status, "committed");
      // A direct domain fixture is legacy/unbound. Explicitly associate its
      // confirmed source without changing the canonical item or History.
      assert.equal((await host.bindMarkdownSource(saved.item.itemId, noteFile.path)).status, "VERIFIED");
      assert.equal((await host.openItemSource(saved.item.itemId)).status, "opening");
    } else {
      // Exercise the navigation boundary directly: the existing shard byte cap
      // can reject a 100k item with several duplicated text snapshots.
      assert.equal(await harness.plugin.openReaderBacklinkSource(row, exactOptions), true);
    }
    assert.equal(opens, 1);
    assert.deepEqual(editor.selections, [[{ line: 0, ch: 7 }, { line: 0, ch: 7 + length }]]);
    assert.equal(await harness.plugin.openReaderBacklinkSource(row), false);
    assert.equal(await harness.plugin.openReaderBacklinkSource(row, { source: "learning-item" }), false);
    assert.equal(await harness.plugin.openReaderBacklinkSource(row, { requireExact: true }), false);
    assert.equal(opens, 1, "generic and nonexact calls reject before opening the note");
    harness.app.workspace.openLinkText = async () => { opens++; editor.value = `prefix y${excerpt.slice(1)} suffix`; };
    if (host) await assert.rejects(host.openItemSource(saved.item.itemId), error => error.code === "TARGET_UNRESOLVED");
    else assert.equal(await harness.plugin.openReaderBacklinkSource(row, exactOptions), false);
    assert.equal(opens, 2, "changed literal is detected after the asynchronous open");
    assert.equal(editor.selections.length, 1, "the changed source is never reselected");
    assert.equal(editor.focuses, 1, "failed source validation does not steal focus");
    assert.deepEqual(editor.cursors, [], "failed exact validation never falls back to a cursor");
    const tooLong = { ...row, sourceText: "x".repeat(100001), endOffset: row.offset + 100001 };
    assert.equal(await harness.plugin.openReaderBacklinkSource(tooLong, exactOptions), false);
    assert.equal(opens, 2, "the learning navigation bound still rejects oversized evidence before opening");
    harness.plugin.onunload();
  }
});

test("learning Markdown Source requires its exact editor span after the asynchronous note open", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const noteFile = new harness.TFile("Notes/Learning Source.md");
  harness.files.set(noteFile.path, noteFile);
  const originalText = "exact excerpt\nMore source text.";
  const editor = {
    value: originalText,
    cursors: [], selections: [], scrolls: 0, focuses: 0,
    getValue() { return this.value; },
    offsetToPos(offset) {
      const prefix = this.value.slice(0, offset).split("\n");
      return { line: prefix.length - 1, ch: prefix.at(-1).length };
    },
    lineCount() { return this.value.split("\n").length; },
    setCursor(position) { this.cursors.push({ ...position }); },
    setSelection(from, to) { this.selections.push([{ ...from }, { ...to }]); },
    scrollIntoView() { this.scrolls += 1; },
    focus() { this.focuses += 1; },
  };
  harness.app.workspace.activeLeaf = { view: {
    file: noteFile, editor, containerEl: {}, getViewType: () => "markdown",
  } };
  let openStarted;
  const started = new Promise((resolve) => { openStarted = resolve; });
  let finishOpen;
  const openBarrier = new Promise((resolve) => { finishOpen = resolve; });
  harness.app.workspace.openLinkText = async () => {
    openStarted();
    await openBarrier;
  };
  const sourceText = "exact excerpt";
  const row = { sourcePath: noteFile.path, offset: 0, endOffset: sourceText.length,
    line: 0, sourceText };
  const pending = harness.plugin.openReaderBacklinkSource(row, {
    source: "learning-item", requireExact: true,
  });
  await started;
  editor.value = `New leading text\n${sourceText}\n${sourceText}\nMore source text.`;
  assert.notEqual(editor.value.slice(row.offset, row.endOffset), sourceText,
    "the recorded editor span no longer contains the saved excerpt");
  assert.notEqual(editor.value.indexOf(sourceText), -1);
  assert.notEqual(editor.value.lastIndexOf(sourceText), editor.value.indexOf(sourceText),
    "the same excerpt now occurs at multiple other spans");
  finishOpen();

  assert.equal(await pending, false,
    "a learning excerpt whose recorded editor span changed during open is unresolved");
  assert.deepEqual(editor.selections, [], "no duplicate excerpt is searched for or selected");
  assert.deepEqual(editor.cursors, [], "requireExact suppresses stale line fallback");
  assert.equal(editor.scrolls, 0);
  assert.equal(editor.focuses, 0);
  harness.plugin.onunload();
});

test("Reader navigation accepts exactly one current request and target acknowledgement", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const file = new harness.TFile("Books/navigation-request.pdf", [37, 80, 68, 70, 3]);
    const reader = await createSidecarReader(harness, file, { pageCount: 1,
      orderedPageIdentities: ["navigation-request-page"] });
    const { view, frame } = reader;
    const outcomes = [];
    const record = harness.plugin.sessionLog.record.bind(harness.plugin.sessionLog);
    harness.plugin.sessionLog.record = (category, details) => {
      if (category === "readerAnchor" && details.event === "navigation-result") outcomes.push(details);
      return record(category, details);
    };
    view.pendingReaderTarget = { kind: "page", id: "navigation-request-page" };
    assert.equal(await view.applyPendingReaderTarget(), true);
    const request = reader.sent.findLast(row => row.type === "reader-anchor-navigate");
    assert.equal(typeof request.requestId, "string", "navigation must carry a runtime correlation ID");
    const reply = { channel: "pdf-web-reader", token: view.token,
      type: "reader-anchor-navigation-result", rendererGeneration: view.rendererGeneration,
      documentId: view.documentId, openRequest: view.openRequest, requestId: request.requestId,
      kind: "page", targetId: "navigation-request-page", ok: true };
    for (const altered of [{ requestId: "prior-request" }, { targetId: "other-page" },
      { rendererGeneration: "old-renderer" }, { openRequest: view.openRequest - 1 }]) {
      view.onMessage({ source: frame, data: { ...reply, ...altered } });
    }
    assert.equal(outcomes.length, 0, "stale or wrong-target results cannot acknowledge navigation");
    view.onMessage({ source: frame, data: reply });
    view.onMessage({ source: frame, data: reply });
    assert.equal(outcomes.length, 1, "duplicate results are consumed only once");
    assert.equal(outcomes[0].requestId, request.requestId);
    assert.equal(outcomes[0].targetId, reply.targetId);
    assert.equal(view.lastReaderNavigationResult.requestId, request.requestId);
    assert.equal(view.lastReaderNavigationResult.targetId, reply.targetId);
    assert.equal(view.lastReaderNavigationResult.rendererGeneration, view.rendererGeneration);
    assert.equal(view.lastReaderNavigationResult.ok, true);
  } finally { harness.plugin.onunload(); }
});

test("a PDF folder rename updates the existing identity route for open and closed Readers", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const file = new harness.TFile("Books/Folder/book.pdf", [37, 80, 68, 70, 4]);
    const reader = await createSidecarReader(harness, file, { pageCount: 1,
      orderedPageIdentities: ["folder-page"] });
    const identity = { documentId: reader.view.annotationDocument.documentId,
      docKey: reader.view.annotationDocument.docKey };
    const beforeBytes = Uint8Array.from(file.bytes);
    const move = async (fromPath, toPath, open) => {
      if (!open) {
        harness.plugin.views.delete(reader.view);
        harness.plugin.annotationHost.releaseView(reader.view);
      }
      const oldPdf = file.path;
      harness.files.delete(oldPdf);
      file.path = `${toPath}/book.pdf`;
      harness.files.set(file.path, file);
      harness.emitVault("rename", { path: toPath, children: [file] }, fromPath);
      let route;
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 0));
        route = await harness.plugin.annotationHost.store.documentForIdentity(identity);
        if (route?.sourcePath === file.path) break;
      }
      assert.equal(route?.sourcePath, file.path, "a folder event preserves the stable document route");
      assert.equal(route.documentId, identity.documentId);
      assert.equal(route.docKey, identity.docKey);
    };
    await move("Books/Folder", "Archive/Folder", true);
    await move("Archive/Folder", "Archive/Closed", false);
    assert.deepEqual(file.bytes, beforeBytes);
    assert.equal(file.writes, 0);
  } finally { harness.plugin.onunload(); }
});

test("Sidebar and Backlink facades delegate to the current effective Reader without a second store", async () => {
  const harness = createHarness({ storageProtocol: "wal" });
  await harness.plugin.onload();
  try {
    const reader = await createSidecarReader(harness, new harness.TFile("Books/facades.pdf"), {
      pageCount: 1, orderedPageIdentities: ["facade-page"],
    });
    const uuid = "550e8400-e29b-41d4-a716-446655440099";
    await saveSidecarOperations(reader, { requestId: "facade-create", operations: [{ uuid,
      kind: "Highlight", pageIndex: 0, deleted: false,
      payload: { editor: { type: "highlight", text: "current source", color: [1, 1, 0] } } }] });
    for (let attempt = 0; attempt < 50 && !reader.view.annotationSnapshot?.annotations?.some(row => row.uuid === uuid); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const api = harness.plugin.getAnnotationSidebarService(reader.view);
    assert.ok(Object.isFrozen(api));
    assert.equal(api.list().length, 1);
    assert.equal(api.get(uuid).payload.editor.text, "current source");
    const copy = api.get(uuid);
    copy.payload.editor.text = "consumer mutation";
    assert.equal(api.get(uuid).payload.editor.text, "current source", "view models do not mutate authority");
    assert.equal(await api.navigate(uuid), true);
    assert.equal(reader.sent.findLast(row => row.type === "reader-anchor-navigate").target.id, uuid);
    assert.equal(api.createReviewDraft(uuid), true);
    const request = reader.sent.findLast(row => row.type === "annotation-sidebar-review-draft");
    assert.equal(request.uuid, uuid);
    assert.equal(request.documentId, reader.view.documentId);
    const backlinks = harness.plugin.getBacklinkService(reader.view);
    assert.ok(Object.isFrozen(backlinks));
    assert.deepEqual(await backlinks.listSources({ target: { kind: "page", id: "wrong-page" } }), []);
    reader.view.annotationHydrationAllowed = false;
    assert.deepEqual(api.list(), []);
    assert.equal(api.get(uuid), null);
    assert.equal(await api.navigate(uuid), false);
    assert.equal(api.createReviewDraft(uuid), false);
  } finally { harness.plugin.onunload(); }
});


function pageBadgeFixture(harness, rows) {
  const identity = { documentId: "page-badge-runtime", openRequest: 3, rendererGeneration: "page-badge-generation" };
  const view = {
    annotationDocument: { docKey: "page-badge-doc", documentId: "page-badge-stable-document" },
    annotationPageIdentity: { orderedPageIdentities: ["page-badge-one", "page-badge-two"] },
    annotationHydrationAllowed: true,
    isCurrentReaderAnchorIdentity: candidate => Object.keys(identity).every(key => candidate[key] === identity[key]),
  };
  const opened = [];
  let indexReads = 0;
  harness.plugin.readerBacklinkIndexReady = true;
  harness.plugin.getReaderBacklinkPageIndex = async () => {
    indexReads++;
    return { value: { forPage: page => ({ rows: page === "page-badge-one" ? rows : [] }) } };
  };
  harness.plugin.openReaderBacklinkSource = async (row, options) => { opened.push({ row, options }); return true; };
  const message = { ...identity, requestId: "page-badge-open", targetKind: "page", targetId: "page-badge-one",
    pageNumber: 1, pageIdentity: "page-badge-one" };
  return { view, message, opened, indexReads: () => indexReads };
}

test("page backlink badge opens the page's sole selection source", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const row = { sourcePath: "Notes/Selection.md", target: { kind: "selection", id: "selection-one" } };
    const f = pageBadgeFixture(harness, [row]);
    assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(f.view, f.message), true);
    assert.deepEqual(f.opened, [{ row, options: { source: "viewer" } }],
      "page aggregation must include a selection backlink even without any page-kind link");
    assert.equal(f.indexReads(), 1);
    assert.equal(harness.openedModals.length, 0);
  } finally { harness.plugin.onunload(); }
});

test("page backlink badge lists every page target source and opens the chosen row", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const rows = [
      { sourcePath: "Notes/Selection.md", target: { kind: "selection", id: "selection-one" } },
      { sourcePath: "Notes/Annotation.md", target: { kind: "annotation", id: "annotation-one" } },
      { sourcePath: "Notes/Page.md", target: { kind: "page", id: "page-badge-one" } },
    ];
    const f = pageBadgeFixture(harness, rows);
    assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(f.view, f.message), true);
    assert.equal(f.opened.length, 0, "multiple sources require an explicit choice");
    assert.equal(harness.openedModals.length, 1);
    const modal = harness.openedModals[0];
    assert.deepEqual(modal.rows, rows);
    const buttons = modal.contentEl.children.filter(element => element.tag === "button");
    assert.deepEqual(buttons.map(button => button.textContent), rows.map(row => row.sourcePath));
    buttons[1].listeners.get("click")();
    assert.deepEqual(f.opened, [{ row: rows[1], options: { source: "viewer-modal" } }]);
    assert.equal(modal.closed, true);
  } finally { harness.plugin.onunload(); }
});

test("page backlink badge rejects forged target IDs and preserves current-page and warm-index guards", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const f = pageBadgeFixture(harness, [{ sourcePath: "Notes/Selection.md", target: { kind: "selection", id: "selection-one" } }]);
    for (const altered of [
      { rendererGeneration: "old-generation" }, { openRequest: 2 },
      { pageIdentity: "page-badge-two" }, { pageNumber: 2 },
    ]) {
      assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(f.view, { ...f.message, ...altered }), false);
    }
    harness.plugin.readerBacklinkIndexReady = false;
    assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(f.view, f.message), false);
    assert.equal(f.indexReads(), 0, "rejected/cold requests cannot start a full-Vault index scan");
    harness.plugin.readerBacklinkIndexReady = true;
    assert.equal(await harness.plugin.handleReaderBacklinkTargetOpen(f.view, { ...f.message, targetId: "forged-page" }), false,
      "aggregation must require page target ID to equal the verified page identity");
    assert.equal(f.opened.length, 0);
    assert.equal(harness.openedModals.length, 0);
  } finally { harness.plugin.onunload(); }
});

test("page backlink badge cannot open sources after asynchronous session revocation", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const row = { sourcePath: "Notes/Selection.md", target: { kind: "selection", id: "selection-one" } };
    const f = pageBadgeFixture(harness, [row]);
    let release;
    harness.plugin.getReaderBacklinkPageIndex = () => new Promise(resolve => { release = resolve; });
    const pending = harness.plugin.handleReaderBacklinkTargetOpen(f.view, f.message);
    f.view.annotationHydrationAllowed = false;
    release({ value: { forPage: () => ({ rows: [row] }) } });
    assert.equal(await pending, false);
    assert.equal(f.opened.length, 0);
    assert.equal(harness.openedModals.length, 0);
  } finally { harness.plugin.onunload(); }
});

// RED: the bridge posts source identity and immediately posts its first page
// request, while Host identity hydration completes asynchronously. Keep the
// genuine Host handlers here: no alternate request/correlation implementation.
test("Reader backlink initial hydration requests a genuine correlated Viewer requery RED", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const messages = [];
    const view = {
      ready: true, openAcknowledged: true,
      documentId: "hydrating-doc", openRequest: 1, rendererGeneration: "generation",
      annotationDocument: { docKey: "aabbccddeeff" },
      annotationPageIdentity: { orderedPageIdentities: ["page-one"] },
      annotationSourceHash: "xxh64-v1:0000000000000000", annotationHydrationAllowed: false,
      isCurrentReaderAnchorIdentity: () => true, postToViewer: message => messages.push(message),
    };
    harness.plugin.readerBacklinkIndexReady = true;
    let queries = 0;
    harness.plugin.collectReaderBacklinksForPage = async () => {
      queries += 1;
      return { rows: [{ sourcePath: "Reference.md" }], markers: [], backlinkLookupMs: 0, anchorResolveMs: 0 };
    };
    const request = { documentId: view.documentId, openRequest: view.openRequest,
      rendererGeneration: view.rendererGeneration, requestId: "reader-backlink-page-1-1",
      pageNumber: 1, pageIndex: 0, pageIdentity: "page-one", sourceHash: view.annotationSourceHash };
    // The initial request arrives before the asynchronous source identity handler
    // allows hydration. It must not read page data before that authorization.
    await harness.plugin.handleReaderBacklinkPageRequest(view, request);
    assert.equal(queries, 0, "the hydration guard remains effective");
    assert.equal(messages.length, 0);
    // This is the source-identity handler's existing completion refresh path.
    view.annotationHydrationAllowed = true;
    await harness.plugin.refreshReaderBacklinksForView(view);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "reader-backlink-page-refresh",
      "hydration completion must request a genuine Viewer query instead of publishing uncorrelated results");
    assert.equal(queries, 0, "a refresh notification must not synthesize a Host query");
    assert.equal(messages[0].requestId, undefined, "the Host must not invent a Viewer request ID");
    for (const field of ["documentId", "openRequest", "rendererGeneration", "pageNumber", "pageIndex", "pageIdentity", "sourceHash"]) {
      assert.equal(messages[0][field], request[field], `refresh carries current ${field}`);
    }
    // Model only the next authenticated wire input, not Viewer correlation logic.
    // The real bridge must validate the refresh and issue its own next sequence.
    const requery = { ...request, requestId: "reader-backlink-page-1-2" };
    assert.equal(await harness.plugin.handleReaderBacklinkPageRequest(view, requery), true);
    assert.equal(queries, 1);
    assert.equal(messages[1].type, "reader-backlink-page-results");
    assert.equal(messages[1].requestId, requery.requestId);
    assert.equal(messages[1].backlinkCount, 1);
  } finally { harness.plugin.onunload(); }
});

test("Reader backlink metadata refresh preserves an already accepted initial request correlation", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const messages = [], pending = [];
    const view = {
      ready: true, openAcknowledged: true,
      documentId: "hydrated-doc", openRequest: 1, rendererGeneration: "generation",
      annotationDocument: { docKey: "aabbccddeeff" },
      annotationPageIdentity: { orderedPageIdentities: ["page-one"] },
      annotationSourceHash: "xxh64-v1:0000000000000000", annotationHydrationAllowed: true,
      isCurrentReaderAnchorIdentity: () => true, postToViewer: message => messages.push(message),
    };
    harness.plugin.readerBacklinkIndexReady = true;
    harness.plugin.collectReaderBacklinksForPage = () => new Promise(resolve => pending.push(resolve));
    const request = { documentId: view.documentId, openRequest: view.openRequest,
      rendererGeneration: view.rendererGeneration, requestId: "reader-backlink-page-1-1",
      pageNumber: 1, pageIndex: 0, pageIdentity: "page-one", sourceHash: view.annotationSourceHash };
    const initial = harness.plugin.handleReaderBacklinkPageRequest(view, request);
    const refresh = harness.plugin.refreshReaderBacklinksForView(view);
    pending[1]({ rows: [{ sourcePath: "Reference.md" }], markers: [] });
    assert.equal(await refresh, true);
    pending[0]({ rows: [], markers: [] });
    assert.equal(await initial, false, "superseded initial result remains suppressed");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].requestId, request.requestId);
    assert.equal(messages[0].backlinkCount, 1);
  } finally { harness.plugin.onunload(); }
});

test("Reader backlink metadata refresh cannot publish after a newer page request", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  try {
    const messages = [], pending = [];
    const view = {
      ready: true, openAcknowledged: true,
      documentId: "hydrated-doc", openRequest: 1, rendererGeneration: "generation",
      annotationDocument: { docKey: "aabbccddeeff" },
      annotationPageIdentity: { orderedPageIdentities: ["page-one", "page-two"] },
      annotationSourceHash: "xxh64-v1:0000000000000000", annotationHydrationAllowed: true,
      isCurrentReaderAnchorIdentity: () => true, postToViewer: message => messages.push(message),
    };
    harness.plugin.readerBacklinkIndexReady = true;
    harness.plugin.collectReaderBacklinksForPage = () => new Promise(resolve => pending.push(resolve));
    const request = { documentId: view.documentId, openRequest: view.openRequest,
      rendererGeneration: view.rendererGeneration, requestId: "reader-backlink-page-1-1",
      pageNumber: 1, pageIndex: 0, pageIdentity: "page-one", sourceHash: view.annotationSourceHash };
    const initial = harness.plugin.handleReaderBacklinkPageRequest(view, request);
    const refresh = harness.plugin.refreshReaderBacklinksForView(view);
    const nextPage = harness.plugin.handleReaderBacklinkPageRequest(view, { ...request,
      requestId: "reader-backlink-page-1-2", pageNumber: 2, pageIndex: 1, pageIdentity: "page-two" });
    pending[2]({ rows: [{ sourcePath: "PageTwo.md" }], markers: [] });
    assert.equal(await nextPage, true);
    pending[1]({ rows: [{ sourcePath: "StalePageOne.md" }], markers: [] });
    assert.equal(await refresh, false);
    pending[0]({ rows: [], markers: [] });
    assert.equal(await initial, false);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].requestId, "reader-backlink-page-1-2");
    assert.equal(messages[0].pageIndex, 1);
  } finally { harness.plugin.onunload(); }
});
