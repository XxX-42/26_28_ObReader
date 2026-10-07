import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  readFile,
  readdir,
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

const externalRequire = createRequire(builtMainPath);

export async function readBuiltMain() {
  return readFile(builtMainPath, "utf8");
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

export function loadBundledPlugin(mainSource, adapter, manifest = null) {
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
    registerEvent() {}
  }

  const obsidian = {
    EditableFileView,
    Notice: class Notice {},
    Plugin,
    TFile,
    WorkspaceLeaf,
    normalizePath: (value) => value.replaceAll("\\", "/"),
  };
  const moduleObject = { exports: {} };
  new Function("require", "module", "exports", mainSource)(
    (name) => (name === "obsidian" ? obsidian : externalRequire(name)),
    moduleObject,
    moduleObject.exports,
  );

  const files = new Map();
  const app = {
    vault: {
      configDir: ".obsidian",
      adapter,
      getAbstractFileByPath: (filePath) => files.get(filePath) ?? null,
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
  return {
    app,
    plugin,
    PluginClass: moduleObject.exports,
    TFile,
    WorkspaceLeaf,
    async load() {
      await plugin.onload();
      return plugin;
    },
    createView() {
      assert.ok(viewFactory, "The plugin must register the PDF view");
      return viewFactory(new WorkspaceLeaf(app));
    },
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
        normalized.startsWith(`${pluginRoot}/`),
      `Adapter path escaped the plugin root: ${vaultPath}`,
    );
    const relative =
      normalized === ".obsidian" || normalized === ".obsidian/plugins"
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
  return {
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
        value instanceof ArrayBuffer,
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
    async read(vaultPath) {
      return readFile(resolve(vaultPath), "utf8");
    },
    async write(vaultPath, value) {
      await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
      await writeFile(resolve(vaultPath), value, "utf8");
    },
    async stat(vaultPath) {
      return stat(resolve(vaultPath));
    },
  };
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
  await rm(target, { recursive: true, force: true });
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
