import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const pluginRoot = ".obsidian/plugins/pdf-web-reader";
export const builtMainPath = path.join(
  root,
  "dist",
  "pdf-web-reader",
  "main.js",
);

const testTempRootKey = Symbol("pdfReaderTestTempRoot");
const harnessesByTempRoot = new Map();

const externalRequire = createRequire(builtMainPath);

export async function readBuiltMain() {
  return readFile(process.env.PDF_READER_TEST_MAIN || builtMainPath, "utf8");
}

export function readPayloadFromMain(mainSource) {
  const marker = "const VIEWER_ASSET_PAYLOAD = ";
  const markerIndex = mainSource.indexOf(marker);
  assert.notEqual(markerIndex, -1, "Built main.js must include viewer assets");
  const start = markerIndex + marker.length;
  const end = mainSource.indexOf(";\n", start);
  assert.notEqual(end, -1, "Built asset payload must be a JSON literal");
  return JSON.parse(mainSource.slice(start, end));
}

export function replacePayloadInMain(mainSource, payload) {
  const marker = "const VIEWER_ASSET_PAYLOAD = ";
  const markerIndex = mainSource.indexOf(marker);
  assert.notEqual(markerIndex, -1, "Built main.js must include viewer assets");
  const start = markerIndex + marker.length;
  const end = mainSource.indexOf(";\n", start);
  assert.notEqual(end, -1, "Built asset payload must be a JSON literal");
  return `${mainSource.slice(0, start)}${JSON.stringify(payload)}${mainSource.slice(end)}`;
}

export function computePayloadHash(payload) {
  const rows = [...payload.files]
    .sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    )
    .map((file) => `${file.path}\t${file.size}\t${file.sha256}\n`)
    .join("");
  return externalRequire("node:crypto")
    .createHash("sha256")
    .update(
      `pdf-web-reader-assets\n${payload.schema}\n${payload.id}\n${rows}`,
      "utf8",
    )
    .digest("hex");
}

export function loadBundledPlugin(
  mainSource,
  adapter,
  manifest = null,
  { browserOnly = true, browserGlobals = {} } = {},
) {
  let viewFactory = null;
  class TFile {
    constructor(filePath) {
      this.path = filePath;
      this.extension = path.posix.extname(filePath).slice(1);
      this.basename = path.posix.basename(
        filePath,
        path.posix.extname(filePath),
      );
    }
  }

  class EditableFileView {
    constructor(leaf) {
      this.leaf = leaf;
      this.app = leaf.app;
      this.file = null;
      this.contentEl = {
        empty() {},
        addClass() {},
        removeClass() {},
        createDiv() {
          return { setText() {}, toggleClass() {} };
        },
        createEl() {
          return { remove() {}, contentWindow: { postMessage() {} } };
        },
      };
    }

    async setState() {}
    async onOpen() {}
    async onClose() {}
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

  class WorkspaceLeaf {
    constructor(app) {
      this.app = app;
    }

    async setViewState(state, eState) {
      this.lastViewState = state;
      this.lastEState = eState;
      if (!this.view || this.view.getViewType() !== state?.type) {
        this.view = viewFactory?.(this);
      }
      if (state?.state) await this.view?.setState(state.state, eState);
      return this.view;
    }
  }

  class Plugin {
    constructor(app, pluginManifest) {
      this.app = app;
      this.manifest = pluginManifest;
    }

    registerView(_type, factory) {
      viewFactory = factory;
    }
    addCommand() {}
    addSettingTab() {}
    registerEvent() {}
    async loadData() { return null; }
    async saveData() {}
  }

  const obsidian = {
    EditableFileView,
    Modal: class Modal {},
    Notice: class Notice {},
    Plugin,
    PluginSettingTab: class PluginSettingTab {},
    Setting: class Setting {},
    TFile,
    WorkspaceLeaf,
    normalizePath: (value) => value.replaceAll("\\", "/"),
  };
  const moduleObject = { exports: {} };
  const requirePluginModule = (name) => {
    if (name === "obsidian") return obsidian;
    if (browserOnly) {
      throw new Error(`Unexpected external module in browser release: ${name}`);
    }
    return externalRequire(name);
  };
  const browserContext = {
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Blob,
    DecompressionStream,
    TransformStream,
    ReadableStream,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto ?? webcrypto,
    ...browserGlobals,
  };
  const nodeContext = browserOnly ? {} : { Buffer, process };
  const runtimeContext = {
    ...browserContext,
    ...nodeContext,
    require: requirePluginModule,
    module: moduleObject,
    exports: moduleObject.exports,
  };
  runInNewContext(mainSource, runtimeContext, {
    filename: "pdf-web-reader-main.js",
  });

  const files = new Map();
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter,
      getAbstractFileByPath: (filePath) => files.get(filePath) ?? null,
      on: () => ({}),
    },
    workspace: {
      getActiveFile: () => null,
      on: () => ({}),
      detachLeavesOfType() {},
      getLeavesOfType: () => [],
      getLeaf: () => new WorkspaceLeaf(app),
    },
  };
  const pluginManifest =
    manifest ??
    JSON.parse(
      externalRequire("node:fs").readFileSync(
        path.join(root, "manifest.json"),
        "utf8",
      ),
    );
  const plugin = new moduleObject.exports(app, pluginManifest);
  let unloadPromise = null;
  let loaded = false;
  const tempRoot = adapter?.[testTempRootKey];
  const harness = {
    app,
    plugin,
    PluginClass: moduleObject.exports,
    runtimeContext,
    TFile,
    WorkspaceLeaf,
    async load() {
      if (loaded) return plugin;
      loaded = true;
      if (tempRoot) {
        let harnesses = harnessesByTempRoot.get(tempRoot);
        if (!harnesses) {
          harnesses = new Set();
          harnessesByTempRoot.set(tempRoot, harnesses);
        }
        harnesses.add(harness);
      }
      try {
        await plugin.onload();
      } catch (error) {
        await harness.unload();
        throw error;
      }
      return plugin;
    },
    createView() {
      assert.ok(viewFactory, "The plugin must register the PDF view");
      return viewFactory(new WorkspaceLeaf(app));
    },
    async unload() {
      if (unloadPromise) return unloadPromise;
      unloadPromise = (async () => {
        const collectPendingWork = () => [
          plugin.prewarmPromise,
          plugin.viewerAssetsPromise,
          ...(plugin.verifiedAssetBytes?.values() || []),
          ...(plugin.verifiedAssetTexts?.values() || []),
        ].filter((value) => value && typeof value.then === "function");
        let unloadError = null;
        try {
          const pendingBeforeUnload = [...new Set(collectPendingWork())];
          try {
            if (plugin.isUnloading !== true) await plugin.onunload?.();
          } catch (error) {
            unloadError = error;
          }
          // The prewarm promise owns its nested resource reads; the maps cover
          // any callers that started verified reads outside that chain.
          await Promise.allSettled([
            ...new Set([...pendingBeforeUnload, ...collectPendingWork()]),
          ]);
          if (unloadError) throw unloadError;
        } finally {
          if (tempRoot) {
            const harnesses = harnessesByTempRoot.get(tempRoot);
            harnesses?.delete(harness);
            if (harnesses?.size === 0) harnessesByTempRoot.delete(tempRoot);
          }
        }
      })();
      return unloadPromise;
    },
  };
  return {
    ...harness,
  };
}

export function createDiskAdapter(tempRoot, { failWrite = null } = {}) {
  const rootPath = path.resolve(tempRoot);
  let writeCount = 0;
  function resolve(vaultPath) {
    assert.equal(typeof vaultPath, "string");
    const normalized = vaultPath.replaceAll("\\", "/");
    assert.ok(
      normalized === ".obsidian" ||
        normalized === ".obsidian/plugins" ||
        normalized === pluginRoot ||
        normalized.startsWith(`${pluginRoot}/`) ||
        normalized === "00_Archive/20_PDFData" ||
        normalized.startsWith("00_Archive/20_PDFData/"),
      `Adapter path escaped the plugin root: ${vaultPath}`,
    );
    const relative =
      normalized === ".obsidian" || normalized === ".obsidian/plugins"
        ? normalized
        : normalized.startsWith("00_Archive/")
          ? normalized
          : normalized.slice(pluginRoot.length).replace(/^\//, "");
    const target = path.resolve(
      rootPath,
      ...relative.split("/").filter(Boolean),
    );
    assert.ok(
      target === rootPath || target.startsWith(`${rootPath}${path.sep}`),
      `Adapter path escaped its temporary root: ${vaultPath}`,
    );
    return target;
  }
  async function exists(vaultPath) {
    try {
      await access(resolve(vaultPath));
      return true;
    } catch {
      return false;
    }
  }
  const adapter = {
    resolve,
    get writeCount() {
      return writeCount;
    },
    async exists(vaultPath) {
      return exists(vaultPath);
    },
    async mkdir(vaultPath) {
      await mkdir(resolve(vaultPath), { recursive: true });
    },
    async readBinary(vaultPath) {
      const bytes = await readFile(resolve(vaultPath));
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
    async writeBinary(vaultPath, value) {
      assert.ok(
        Object.prototype.toString.call(value) === "[object ArrayBuffer]",
        "The helper should write ArrayBuffer data",
      );
      writeCount += 1;
      if (failWrite?.(vaultPath, writeCount)) {
        throw new Error(`Simulated adapter write failure: ${vaultPath}`);
      }
      await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
      await writeFile(resolve(vaultPath), new Uint8Array(value));
    },
    async remove(vaultPath) {
      await rm(resolve(vaultPath), { force: true });
    },
    async rename(fromPath, toPath) {
      const source = resolve(fromPath);
      const target = resolve(toPath);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
    },
    async list(vaultPath) {
      const target = resolve(vaultPath);
      try {
        const entries = await readdir(target, { withFileTypes: true });
        return {
          files: entries.filter((entry) => entry.isFile()).map((entry) => `${vaultPath}/${entry.name}`),
          folders: entries.filter((entry) => entry.isDirectory()).map((entry) => `${vaultPath}/${entry.name}`),
        };
      } catch (error) {
        if (error?.code === "ENOENT") return { files: [], folders: [] };
        throw error;
      }
    },
    async read(vaultPath) {
      return readFile(resolve(vaultPath), "utf8");
    },
    async write(vaultPath, value) {
      await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
      await writeFile(resolve(vaultPath), value, "utf8");
    },
    async append(vaultPath, value) {
      await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
      await appendFile(resolve(vaultPath), value, "utf8");
    },
    async stat(vaultPath) {
      const value = await stat(resolve(vaultPath));
      return {
        type: value.isFile() ? "file" : "folder",
        size: value.size,
        mtime: value.mtimeMs,
        ctime: value.ctimeMs,
      };
    },
  };
  Object.defineProperty(adapter, testTempRootKey, { value: rootPath });
  return adapter;
}

export async function createTempRoot(prefix = "pdf-reader-assets-") {
  const output = path.join(root, "tests", "output");
  await mkdir(output, { recursive: true });
  const folder = `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const temp = path.join(output, folder);
  await mkdir(temp, { recursive: false });
  return temp;
}

export async function removeTempRoot(tempRoot) {
  const output = path.resolve(root, "tests", "output");
  const target = path.resolve(tempRoot);
  assert.ok(
    target.startsWith(`${output}${path.sep}`),
    `Refusing to remove path outside tests/output: ${target}`,
  );
  const harnesses = [...(harnessesByTempRoot.get(target) || [])];
  const unloadResults = await Promise.allSettled(
    harnesses.map((harness) => harness.unload()),
  );
  await rm(target, { recursive: true, force: true });
  const unloadFailure = unloadResults.find((result) => result.status === "rejected");
  if (unloadFailure) throw unloadFailure.reason;
}

export async function listDiskFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDiskFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push({ absolute, path: relative });
    } else {
      throw new Error(`Unexpected output type: ${relative}`);
    }
  }
  return files;
}
