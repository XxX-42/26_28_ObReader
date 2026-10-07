import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRequire = createRequire(path.join(root, "plugin", "main.js"));
const VIEW_TYPE = "pdf-web-reader-view";

function createHarness() {
  const files = new Map();
  const leaves = [];
  const notices = [];
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
      this.lastState = state;
      this.lastEState = eState;
      const fileOrPath = state?.file ?? state?.path;
      const file =
        typeof fileOrPath === "string"
          ? this.app.vault.getAbstractFileByPath(fileOrPath)
          : fileOrPath;
      if (file instanceof TFile && file !== this.file) {
        if (this.file) {
          await this.onUnloadFile(this.file);
        }
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

  class CoreFileView extends FileView {
    constructor(leaf, type) {
      super(leaf);
      this.type = type;
    }

    getViewType() {
      return this.type;
    }
  }

  class WorkspaceLeaf {
    constructor(app) {
      this.app = app;
      this.view = null;
      this.viewStateCalls = [];
    }

    async setViewState(viewState, eState) {
      this.viewStateCalls.push({ viewState, eState });
      this.viewState = viewState;
      const type = viewState?.type ?? "unknown";
      if (type === VIEW_TYPE) {
        if (!(this.view instanceof EditableFileView)) {
          this.view = viewFactory(this);
        }
        await this.view.setState(viewState.state, eState);
      } else {
        this.view = new CoreFileView(this, type);
        await this.view.setState(viewState.state, eState);
      }
      this.app.workspace.activeLeaf = this;
      return this.view;
    }

    async openFile(file, openState = {}) {
      const type =
        file.extension.toLowerCase() === "pdf"
          ? "pdf"
          : file.extension.toLowerCase() === "md"
            ? "markdown"
            : "image";
      return this.setViewState(
        {
          type,
          active: openState.active ?? true,
          group: openState.group,
          state: { ...(openState.state ?? {}), file: file.path },
        },
        openState.eState,
      );
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
      if (name === "./asset-runtime.cjs") return sourceRequire(name);
      if (name !== "obsidian") {
        throw new Error(`Unexpected dependency: ${name}`);
      }
      return obsidian;
    },
    moduleObject,
    moduleObject.exports,
  );

  const app = {
    vault: {
      configDir: ".obsidian",
      getAbstractFileByPath: (filePath) => files.get(filePath) ?? null,
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
      activeLeaf: null,
      getActiveFile() {
        const view = this.activeLeaf?.view;
        return view instanceof FileView ? (view.file ?? null) : null;
      },
      getLeaf() {
        const leaf = new WorkspaceLeaf(app);
        leaves.push(leaf);
        return leaf;
      },
      getLeavesOfType(type) {
        return leaves.filter((leaf) => leaf.view?.getViewType() === type);
      },
      getLeaves() {
        return [...leaves];
      },
      openLinkText(linktext, _sourcePath, openInNewLeaf = false) {
        const file = files.get(linktext);
        if (!file) {
          throw new Error(`Missing test file: ${linktext}`);
        }
        const leaf = openInNewLeaf
          ? this.getLeaf(true)
          : (this.activeLeaf ?? this.getLeaf(true));
        return leaf.openFile(file);
      },
      on: () => ({}),
      detachLeavesOfType(type) {
        for (let index = leaves.length - 1; index >= 0; index -= 1) {
          if (leaves[index].view?.getViewType() === type) {
            leaves[index].view = null;
            leaves.splice(index, 1);
          }
        }
      },
    },
  };

  return {
    app,
    files,
    leaves,
    notices,
    PluginClass: moduleObject.exports,
    TFile,
    FileView,
    EditableFileView,
    WorkspaceLeaf,
    newPlugin() {
      return new moduleObject.exports(app, { id: "pdf-web-reader" });
    },
  };
}

const awaitSource = await readFile(
  path.join(root, "plugin", "main.js"),
  "utf8",
);

test("default PDF opens route in-place while non-PDF and embedded opens stay native", async () => {
  const harness = createHarness();
  const plugin = harness.newPlugin();
  await plugin.onload();

  const pdf = new harness.TFile("PDF迁移测试/routing.pdf");
  const note = new harness.TFile("PDF迁移测试/routing.md");
  const image = new harness.TFile("PDF迁移测试/routing.png");
  for (const file of [pdf, note, image]) {
    harness.files.set(file.path, file);
  }

  const leaf = harness.app.workspace.getLeaf(true);
  const leafCount = harness.leaves.length;
  const eState = { scroll: { left: 7, top: 19 } };
  await leaf.openFile(pdf, {
    active: true,
    group: "right-pane",
    state: { page: 4, zoom: "page-width", custom: "preserved" },
    eState,
  });

  assert.equal(
    harness.leaves.length,
    leafCount,
    "Opening a PDF must not add a tab",
  );
  assert.equal(leaf.view.getViewType(), VIEW_TYPE);
  assert.equal(leaf.view.file, pdf);
  assert.equal(leaf.view.requestedPath, pdf.path);
  assert.equal(pdf.reads, 1, "The host should read the selected PDF once");
  assert.equal(harness.app.workspace.getActiveFile(), pdf);
  assert.deepEqual(leaf.view.getState(), {
    page: 4,
    zoom: "page-width",
    custom: "preserved",
    file: pdf.path,
    path: pdf.path,
  });
  assert.deepEqual(leaf.viewStateCalls.at(-1), {
    viewState: {
      type: VIEW_TYPE,
      active: true,
      group: "right-pane",
      state: {
        page: 4,
        zoom: "page-width",
        custom: "preserved",
        file: pdf.path,
        path: pdf.path,
      },
    },
    eState,
  });

  const routedView = leaf.view;
  await harness.app.workspace.openLinkText(pdf.path, "", false);
  assert.equal(
    leaf.view,
    routedView,
    "An ordinary workspace PDF open reuses its leaf",
  );
  assert.equal(harness.leaves.length, leafCount);
  assert.equal(
    pdf.reads,
    1,
    "Reopening the same PDF should not reload its bytes",
  );

  await leaf.setViewState({
    type: "pdf",
    active: true,
    state: { path: pdf.path, page: 6 },
  });
  assert.equal(
    leaf.view.getViewType(),
    VIEW_TYPE,
    "A direct PDF view state should route too",
  );
  assert.equal(leaf.view.requestedPath, pdf.path);

  await leaf.openFile(note);
  assert.equal(leaf.view.getViewType(), "markdown");
  assert.equal(leaf.view.file, note);
  await leaf.setViewState({
    type: "markdown",
    active: true,
    state: { file: note.path, embeddedPdfPath: pdf.path },
  });
  assert.equal(
    leaf.view.getViewType(),
    "markdown",
    "An embedded PDF must not retarget its Markdown leaf",
  );
  await leaf.openFile(image);
  assert.equal(leaf.view.getViewType(), "image");
  assert.equal(leaf.view.file, image);
  assert.equal(harness.app.workspace.getActiveFile(), image);

  await plugin.onunload();
});

test("disabling restores core PDF routing; re-enabling routes new opens again", async () => {
  const harness = createHarness();
  const coreSetViewState = harness.WorkspaceLeaf.prototype.setViewState;
  const firstPlugin = harness.newPlugin();
  await firstPlugin.onload();

  const pdf = new harness.TFile("PDF迁移测试/enable-toggle.pdf");
  harness.files.set(pdf.path, pdf);
  const leaf = harness.app.workspace.getLeaf(true);
  await leaf.openFile(pdf);
  assert.equal(leaf.view.getViewType(), VIEW_TYPE);
  await firstPlugin.onunload();
  assert.equal(harness.WorkspaceLeaf.prototype.setViewState, coreSetViewState);

  const disabledLeaf = harness.app.workspace.getLeaf(true);
  await disabledLeaf.openFile(pdf);
  assert.equal(disabledLeaf.view.getViewType(), "pdf");

  const secondPlugin = harness.newPlugin();
  await secondPlugin.onload();
  const leafCount = harness.leaves.length;
  await disabledLeaf.openFile(pdf);
  assert.equal(disabledLeaf.view.getViewType(), VIEW_TYPE);
  assert.equal(disabledLeaf.view.requestedPath, pdf.path);
  assert.equal(
    harness.leaves.length,
    leafCount,
    "Re-enabling must not create a duplicate tab",
  );
  assert.equal(harness.app.workspace.getActiveFile(), pdf);

  await secondPlugin.onunload();
});

test("unload does not clobber a later wrapper and leaves its stale route inactive", async () => {
  const harness = createHarness();
  const plugin = harness.newPlugin();
  await plugin.onload();
  const routedSetViewState = harness.WorkspaceLeaf.prototype.setViewState;
  let laterWrapperCalls = 0;
  const laterWrapper = function (...args) {
    laterWrapperCalls += 1;
    return routedSetViewState.apply(this, args);
  };
  harness.WorkspaceLeaf.prototype.setViewState = laterWrapper;

  const pdf = new harness.TFile("PDF迁移测试/wrapper-conflict.pdf");
  harness.files.set(pdf.path, pdf);
  await plugin.onunload();
  assert.equal(harness.WorkspaceLeaf.prototype.setViewState, laterWrapper);

  const leaf = harness.app.workspace.getLeaf(true);
  await leaf.openFile(pdf);
  assert.equal(laterWrapperCalls, 1);
  assert.equal(leaf.view.getViewType(), "pdf");
});

test("a PDF leaf created before plugin enable remains in the built-in view", async () => {
  const harness = createHarness();
  const pdf = new harness.TFile("PDF迁移测试/already-open.pdf");
  harness.files.set(pdf.path, pdf);
  const leaf = harness.app.workspace.getLeaf(true);
  const coreSetViewState = harness.WorkspaceLeaf.prototype.setViewState;
  await coreSetViewState.call(leaf, {
    type: "pdf",
    active: true,
    state: { file: pdf.path },
  });
  assert.equal(leaf.view.getViewType(), "pdf");

  const plugin = harness.newPlugin();
  await plugin.onload();
  assert.equal(
    leaf.view.getViewType(),
    "pdf",
    "Enabling must not hijack an existing core PDF tab",
  );
  await plugin.onunload();
});
