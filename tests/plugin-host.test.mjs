import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRequire = createRequire(path.join(root, "plugin", "main.js"));

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
    detach() {
      this.detached = true;
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
      if (name === "obsidian") return obsidian;
      if (name === "./asset-runtime.cjs") return sourceRequire(name);
      throw new Error(`Unexpected dependency: ${name}`);
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
    WorkspaceLeaf,
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

test("same-file concurrent views must not both overwrite the same baseline", async () => {
  const h = createHarness();
  await h.plugin.onload();
  const file = new h.TFile("Books/shared.pdf", [1, 2, 3]);
  h.files.set(file.path, file);
  const replies = [];
  const views = [h.createView(), h.createView()];
  for (const view of views) {
    view.file = file;
    view.requestedPath = file.path;
    view.originalBytes = Uint8Array.from([1, 2, 3]);
    view.iframe = {
      contentWindow: { postMessage: (message) => replies.push(message) },
    };
  }
  // Both readBinary calls capture the same disk revision before either writes.
  await Promise.all(
    views.map((view, index) =>
      view.saveFile(
        Uint8Array.from([index + 4]).buffer,
        file.path,
        `concurrent-${index}`,
      ),
    ),
  );
  h.plugin.onunload();
  assert.equal(
    replies.filter((message) => message.type === "saved").length,
    1,
    `Only one stale-baseline save may succeed; replies=${JSON.stringify(replies)}, final=${[...file.bytes]}`,
  );
  assert.equal(
    replies.filter((message) => message.code === "conflict").length,
    1,
  );
});

test("renaming an open PDF must preserve its active save session", async () => {
  const h = createHarness();
  await h.plugin.onload();
  const file = new h.TFile("Books/before.pdf", [1, 2, 3]);
  h.files.set(file.path, file);
  const view = h.createView();
  const documentId = file.path;
  const replies = [];
  view.file = file;
  view.requestedPath = documentId;
  view.originalBytes = Uint8Array.from([1, 2, 3]);
  view.iframe = {
    contentWindow: { postMessage: (message) => replies.push(message) },
  };
  h.files.delete(documentId);
  file.path = "Books/after.pdf";
  h.files.set(file.path, file);
  // Obsidian retains the TFile identity when its path changes.
  await view.saveFile(Uint8Array.from([4]).buffer, documentId, "after-rename");
  h.plugin.onunload();
  assert.equal(replies.at(-1).type, "saved", JSON.stringify(replies.at(-1)));
  assert.equal(
    replies.at(-1).documentId,
    documentId,
    "Save acknowledgement must retain the bridge session identity after rename",
  );
  assert.equal(view.getState().file, file.path);
  assert.equal(file.writes, 1);
});

test("rename state updates do not reopen or discard the current document", async () => {
  const h = createHarness();
  await h.plugin.onload();
  const file = new h.TFile("Books/rename.pdf");
  h.files.set(file.path, file);
  await h.plugin.openPdf(file);
  const view = h.leaves[0].view;
  const oldId = view.requestedPath,
    session = view.sessionId;
  h.files.delete(oldId);
  file.path = "Books/renamed.pdf";
  h.files.set(file.path, file);
  view.flushBeforeLeave = () => {
    throw new Error("Rename must not flush or navigate");
  };
  await h.leaves[0].setViewState({
    type: "pdf-web-reader-view",
    state: { file: file.path },
  });
  await view.onLoadFile(file);
  assert.equal(view.requestedPath, oldId);
  assert.equal(view.sessionId, session);
  assert.equal(file.reads, 1);
  assert.equal(view.getState().file, file.path);
  await view.onUnloadFile(file);
  assert.equal(view.requestedPath, null);
  assert.equal(view.documentFile, null);
  h.plugin.onunload();
});

test("file save queue survives rename and releases after write failure", async () => {
  const h = createHarness();
  await h.plugin.onload();
  const file = new h.TFile("Books/queue.pdf", [1]);
  h.files.set(file.path, file);
  const oldId = file.path;
  const replies = [];
  const views = [h.createView(), h.createView()];
  for (const view of views) {
    view.file = file;
    view.requestedPath = oldId;
    view.originalBytes = Uint8Array.from([1]);
    view.sessionId = "session";
    view.iframe = {
      contentWindow: { postMessage: (message) => replies.push(message) },
    };
  }
  let release, started;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  const modify = h.app.vault.modifyBinary;
  h.app.vault.modifyBinary = async (...args) => {
    started();
    await gate;
    return modify(...args);
  };
  const first = views[0].saveFile(Uint8Array.from([2]).buffer, oldId, "first");
  await entered;
  h.files.delete(oldId);
  file.path = "Books/queue-renamed.pdf";
  h.files.set(file.path, file);
  const second = views[1].saveFile(
    Uint8Array.from([3]).buffer,
    oldId,
    "second",
  );
  release();
  await Promise.all([first, second]);
  assert.equal(file.writes, 1);
  assert.equal(replies.find((r) => r.requestId === "second").code, "conflict");
  h.app.vault.modifyBinary = async () => {
    throw new Error("Injected write failure");
  };
  await views[0].saveFile(Uint8Array.from([4]).buffer, oldId, "failed");
  assert.equal(replies.at(-1).code, "save-failed");
  h.app.vault.modifyBinary = modify;
  await views[0].saveFile(Uint8Array.from([5]).buffer, oldId, "retry");
  assert.equal(replies.at(-1).type, "saved");
  assert.deepEqual([...file.bytes], [5]);
  h.plugin.onunload();
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

test("close and view replacement wait for flush and preserve the original view on failure", async () => {
  const h = createHarness();
  await h.plugin.onload();
  const file = new h.TFile("Books/close.pdf");
  h.files.set(file.path, file);
  await h.plugin.openPdf(file);
  const leaf = h.leaves[0];
  const original = leaf.view;
  let resolveFlush;
  original.flushBeforeLeave = () =>
    new Promise((resolve) => {
      resolveFlush = resolve;
    });
  const closing = leaf.detach();
  assert.equal(leaf.detached, undefined);
  resolveFlush(false);
  await closing;
  assert.equal(leaf.detached, undefined);
  const replacing = leaf.setViewState({
    type: "markdown",
    state: { file: "note.md" },
  });
  assert.equal(leaf.view, original);
  resolveFlush(false);
  await replacing;
  assert.equal(leaf.view, original);
  const successfulClose = leaf.detach();
  resolveFlush(true);
  await successfulClose;
  assert.equal(leaf.detached, true);
  h.plugin.onunload();
});

test("host rejects stale same-path sessions and automatic saves do not notify success", async () => {
  const h = createHarness();
  await h.plugin.onload();
  const file = new h.TFile("Books/session.pdf");
  h.files.set(file.path, file);
  const view = h.createView();
  const replies = [];
  const frame = { postMessage: (message) => replies.push(message) };
  Object.assign(view, {
    iframe: { contentWindow: frame },
    file,
    requestedPath: file.path,
    sessionId: "new-session",
    originalBytes: file.bytes.slice(),
  });
  const message = {
    channel: "pdf-web-reader",
    token: view.token,
    type: "save",
    documentId: file.path,
    requestId: "save-1",
    sessionId: "old-session",
    data: Uint8Array.from([4]).buffer,
  };
  view.onMessage({ source: frame, data: message });
  assert.equal(file.writes, 0);
  await view.saveFile(message.data, file.path, "valid", "new-session", true);
  assert.equal(file.writes, 1);
  assert.equal(replies.at(-1).sessionId, "new-session");
  assert.equal(h.notices.length, 0);
  h.plugin.onunload();
});

test("host ignores stale source, token, and document messages", async () => {
  const harness = createHarness();
  await harness.plugin.onload();
  const view = harness.createView();
  const frame = {};
  view.iframe = { contentWindow: frame };
  view.token = "current-token";
  view.requestedPath = "current.pdf";
  const base = {
    channel: "pdf-web-reader",
    token: "current-token",
    type: "opened",
    documentId: "current.pdf",
  };

  view.onMessage({ source: {}, data: base });
  view.onMessage({ source: frame, data: { ...base, token: "stale-token" } });
  view.onMessage({ source: frame, data: { ...base, documentId: "stale.pdf" } });

  assert.deepEqual(harness.notices, []);
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
  assert.equal(
    harness.notices.length,
    0,
    "Neither save errors nor success should display notices",
  );
});
