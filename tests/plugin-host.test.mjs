import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createHarness() {
  const notices = [];
  const files = new Map();
  const leaves = [];
  let viewFactory;

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
      this.contentEl = {
        empty() {},
        addClass() {},
        removeClass() {},
      };
    }

    async setState() {}

    async onOpen() {}

    async onClose() {}
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

    async setViewState(state, eState) {
      this.lastViewState = state;
      this.lastEState = eState;
      if (!this.view || this.view.getViewType() !== state?.type) {
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
  }

  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }

    registerView(_type, factory) {
      viewFactory = factory;
    }

    addCommand() {}
    registerEvent() {}
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
    TFile,
    WorkspaceLeaf,
    normalizePath: (value) => value.replaceAll("\\", "/"),
  };
  const moduleObject = { exports: {} };
  const source = awaitSource;
  new Function("require", "module", "exports", source)(
    (name) => {
      if (name !== "obsidian")
        throw new Error(`Unexpected dependency: ${name}`);
      return obsidian;
    },
    moduleObject,
    moduleObject.exports,
  );

  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: (filePath) => files.get(filePath) || null,
      readBinary: async (file) => {
        file.reads += 1;
        return file.bytes.slice().buffer;
      },
      modifyBinary: async (file, value) => {
        file.writes += 1;
        file.bytes = new Uint8Array(value.slice(0));
      },
    },
    workspace: {
      getActiveFile: () => null,
      on: () => ({}),
      detachLeavesOfType() {},
      getLeavesOfType: () => leaves,
      getLeaf: () => {
        return new WorkspaceLeaf(app);
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
    createView() {
      const leaf = { app };
      return viewFactory(leaf);
    },
  };
}

const awaitSource = await readFile(
  path.join(root, "plugin", "main.js"),
  "utf8",
);

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
    documentId: "current.pdf",
  };

  view.onMessage({ source: {}, data: base });
  view.onMessage({ source: frame, data: { ...base, token: "stale-token" } });
  view.onMessage({ source: frame, data: { ...base, documentId: "stale.pdf" } });

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
  view.statusEl = {
    setText() {},
    toggleClass() {},
  };
  const incoming = Uint8Array.from([4, 5, 6]).buffer;

  await view.saveFile(incoming, "Books/other.pdf", "request-mismatch");
  assert.equal(file.writes, 0);
  assert.equal(replies.at(-1).code, "document-mismatch");
  assert.equal(replies.at(-1).requestId, "request-mismatch");
  assert.deepEqual([...view.originalBytes], [1, 2, 3]);

  file.bytes = Uint8Array.from([8, 8, 8]);
  await view.saveFile(incoming, file.path, "request-conflict");
  assert.equal(file.writes, 0);
  assert.equal(replies.at(-1).code, "conflict");
  assert.equal(replies.at(-1).requestId, "request-conflict");
  assert.deepEqual([...view.originalBytes], [1, 2, 3]);

  file.bytes = Uint8Array.from([1, 2, 3]);
  await view.saveFile(incoming, file.path, "request-success");
  assert.equal(file.writes, 1);
  assert.deepEqual([...file.bytes], [4, 5, 6]);
  assert.deepEqual([...view.originalBytes], [4, 5, 6]);
  assert.equal(replies.at(-1).type, "saved");
  assert.equal(replies.at(-1).documentId, file.path);
  assert.equal(replies.at(-1).requestId, "request-success");
});
