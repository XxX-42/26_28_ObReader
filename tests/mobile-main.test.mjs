import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRequire = createRequire(path.join(root, "plugin", "main.js"));
const assetRuntime = sourceRequire("./asset-runtime.cjs");
const pdfHashRuntime = await sourceRequire("./pdf-hash-runtime.cjs").createPdfHashRuntime();
const source = await readFile(path.join(root, "plugin", "main.js"), "utf8");
const encoder = new TextEncoder();

function makeAssets() {
  const strings = new Map([
    [
      "web/viewer.html",
      `<!doctype html><html><head><meta charset="utf-8">
        <script src="../build/pdf.mjs" type="module"></script>
        <link rel="stylesheet" href="viewer.css">
        <script src="viewer.mjs" type="module"></script>
        </head><body><main id="viewer"></main></body></html>`,
    ],
    ["web/viewer.css", `#viewer { color: black; background-image: url(images/test-toolbar.svg); }
      .loading { background-image: url(\"images/loading-icon.gif\"); }
      .local { mask-image: url(#local-mask); }`],
    ["web/bridge.css", ".bridge { display: block; }"],
  ]);
  const binary = new Map([
    ["web/obsidian-bridge.js", encoder.encode("window.bridgeLoaded = true;")],
    ["build/pdf.mjs", encoder.encode("globalThis.pdfjsLib = { version: 'test' };")],
    ["web/viewer.mjs", encoder.encode("globalThis.viewerLoaded = true;")],
    ["build/pdf.worker.mjs", encoder.encode("globalThis.workerLoaded = true;")],
    ["web/images/test-toolbar.svg", encoder.encode("<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h1v1H0z\"/></svg>")],
    ["web/images/loading-icon.gif", Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00])],
  ]);
  const files = [...strings, ...binary].map(([assetPath, value]) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    return {
      path: assetPath,
      size: bytes.byteLength,
      sha256: assetRuntime.sha256Bytes(bytes),
      gzipBase64: "AA==",
    };
  });
  return { strings, binary, payload: { schema: 1, id: "test", contentHash: "a".repeat(64), files } };
}

test("desktop and mobile srcdoc inline verified PDF.js CSS image assets", async () => {
  for (const config of [
    { appMobile: false, platformDesktop: true },
    { appMobile: true },
  ]) {
    const harness = makeHarness(config);
    await harness.plugin.onload();
    const view = harness.makeView();
    view.iframe = {
      contentWindow: { parent: {} },
      ownerDocument: { defaultView: harness.makeWindow() },
      srcdoc: "",
      remove() {},
    };
    const html = await view.createViewerDocument();

    assert.match(html, /data:image\/svg\+xml;charset=utf-8,%3c%73%76%67/i);
    assert.match(html, /data:image\/gif,%47%49%46/i);
    assert.doesNotMatch(html, /url\(\s*["']?images\/(?:test-toolbar\.svg|loading-icon\.gif)/i);
    assert.match(html, /url\(#local-mask\)/, "non-resource fragment URLs remain unchanged");
    harness.plugin.onunload();
  }
});

function makeHarness({ appMobile = true, platformMobile = false, platformIos = false, platformDesktop = false, savedData = null } = {}) {
  const { strings, binary, payload } = makeAssets();
  const payloadMarker = "/* BUILD:VIEWER_ASSET_PAYLOAD */ const VIEWER_ASSET_PAYLOAD = null;";
  assert.ok(source.includes(payloadMarker));
  const injectedSource = source.replace(
    payloadMarker,
    `/* BUILD:VIEWER_ASSET_PAYLOAD */ const VIEWER_ASSET_PAYLOAD = ${JSON.stringify(payload)};`,
  );
  const stored = new Map();
  const folders = new Set();
  const createdUrls = new Map();
  const revokedUrls = [];
  const notices = [];
  const commands = new Map();
  const settings = [];
  const nodeRuntimeRequires = [];
  let viewFactory = null;
  let nextObjectUrl = 0;
  const cacheRoot = "test-cache";

  function makeElement(tagName, options = {}, parent = null, ownerDocument = null) {
    const classes = new Set(String(options.cls || "").split(/\s+/).filter(Boolean));
    const element = {
      tagName,
      parentNode: parent,
      parentElement: parent,
      ownerDocument: ownerDocument || parent?.ownerDocument || null,
      children: [],
      textContent: options.text || "",
      attributes: { ...(options.attr || {}) },
      listeners: new Map(),
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      get className() { return [...classes].join(" "); },
      addClass(name) { classes.add(name); },
      removeClass(name) { classes.delete(name); },
      toggleClass(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      setText(value) {
        this.textContent = String(value ?? "");
        this.empty();
      },
      empty() {
        for (const child of this.children) {
          child.parentNode = null;
          child.parentElement = null;
        }
        this.children.length = 0;
      },
      createDiv(childOptions = {}) { return this.createEl("div", childOptions); },
      createEl(childTagName, childOptions = {}) {
        const child = makeElement(childTagName, childOptions, this, this.ownerDocument);
        this.children.push(child);
        return child;
      },
      insertBefore(child, reference) {
        child.remove?.();
        const index = this.children.indexOf(reference);
        const insertAt = index < 0 ? this.children.length : index;
        this.children.splice(insertAt, 0, child);
        child.parentNode = this;
        child.parentElement = this;
        return child;
      },
      before(reference) { this.parentNode?.insertBefore?.(reference, this); },
      remove() {
        const index = this.parentNode?.children?.indexOf(this) ?? -1;
        if (index >= 0) this.parentNode.children.splice(index, 1);
        this.parentNode = null;
        this.parentElement = null;
        this.removed = true;
      },
      addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      },
      click() {
        for (const listener of this.listeners.get("click") || []) {
          listener({ type: "click", target: this });
        }
      },
    };
    return element;
  }

  class TestURL extends URL {}
  TestURL.createObjectURL = (blob) => {
    const url = `blob:pdf-reader-${++nextObjectUrl}`;
    createdUrls.set(url, blob);
    return url;
  };
  TestURL.revokeObjectURL = (url) => {
    revokedUrls.push(url);
    createdUrls.delete(url);
  };

  class TFile {
    constructor(filePath, bytes = new Uint8Array()) {
      this.path = filePath;
      this.extension = path.extname(filePath).slice(1);
      this.basename = path.basename(filePath, path.extname(filePath));
      this.bytes = new Uint8Array(bytes);
    }
  }
  class EditableFileView {
    constructor(leaf) {
      this.leaf = leaf;
      this.app = leaf.app;
      const ownerWindow = makeWindow();
      const ownerDocument = { defaultView: ownerWindow };
      ownerWindow.document = ownerDocument;
      this.contentEl = makeElement("div", {}, null, ownerDocument);
    }
    async setState() {}
    async onOpen() {}
    async onClose() {}
    async onLoadFile(file) { this.file = file; }
    async onUnloadFile(file) { if (this.file === file) this.file = null; }
    getState() { return { file: this.file?.path ?? null }; }
  }
  class WorkspaceLeaf {
    constructor(app) { this.app = app; this.view = null; }
    setViewState() { return Promise.resolve(); }
    detach() { return this; }
  }
  class Plugin {
    constructor(app, manifest) { this.app = app; this.manifest = manifest; }
    registerView(_type, factory) { viewFactory = factory; }
    addCommand(command) { commands.set(command.id, command); }
    addSettingTab(setting) { this.settingTab = setting; }
    registerEvent() {}
    async loadData() { return savedData; }
    async saveData(data) { savedData = structuredClone(data); this.persistedData = savedData; }
  }
  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = makeElement("div");
      this.containerEl.settings = settings;
    }
  }
  class Setting {
    constructor(containerEl) { this.containerEl = containerEl; settings.push(this); }
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
      const button = {
        setButtonText(value) { this.text = value; return this; },
        onClick(handler) { this.handler = handler; return this; },
      };
      callback(button);
      this.button = button;
      return this;
    }
  }

  const ownerWindows = [];
  function makeWindow() {
    const listeners = new Map();
    const window = {
      Function: (...args) => Function(...args),
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      },
      removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
      setTimeout,
      clearTimeout,
      dispatch(type, event) {
        for (const listener of listeners.get(type) || []) listener(event);
      },
    };
    ownerWindows.push(window);
    return window;
  }

  const adapter = {
    async read(assetPath) {
      if (stored.has(assetPath)) return new TextDecoder().decode(stored.get(assetPath).bytes);
      const relative = assetPath.slice(`${cacheRoot}/`.length);
      const value = strings.get(relative);
      if (typeof value !== "string") throw new Error("missing test string asset");
      return value;
    },
    async readBinary(assetPath) {
      const relative = assetPath.slice(`${cacheRoot}/`.length);
      const bytes = binary.get(relative);
      if (!bytes) throw new Error("missing test binary asset");
      return bytes.slice().buffer;
    },
    getResourcePath(assetPath) { return `app://local/${assetPath}`; },
    async exists(assetPath) { return folders.has(assetPath) || stored.has(assetPath); },
    async mkdir(assetPath) { folders.add(assetPath); },
    async list(directory) {
      const prefix = `${directory}/`;
      const files = [];
      const childFolders = new Set();
      for (const path of stored.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest.includes("/")) childFolders.add(`${directory}/${rest.split("/")[0]}`);
        else files.push(path);
      }
      for (const path of folders) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (rest) childFolders.add(`${directory}/${rest.split("/")[0]}`);
      }
      return { files, folders: [...childFolders] };
    },
    async rename(from, to) {
      if (!stored.has(from)) throw new Error(`missing rename source: ${from}`);
      if (stored.has(to)) throw new Error(`rename target exists: ${to}`);
      stored.set(to, stored.get(from));
      stored.delete(from);
    },
    async write(path, text) { stored.set(path, new TFile(path, new TextEncoder().encode(text))); },
    async append(path, text) {
      if (!stored.has(path)) throw new Error(`missing append target: ${path}`);
      const previous = new TextDecoder().decode(stored.get(path).bytes);
      stored.set(path, new TFile(path, new TextEncoder().encode(previous + text)));
    },
    async writeBinary() {},
    async remove() {},
  };
  const vault = {
    configDir: ".obsidian",
    adapter,
    getAbstractFileByPath(filePath) {
      if (folders.has(filePath)) return { path: filePath, children: [] };
      return stored.get(filePath) || null;
    },
    on() { return {}; },
    async createFolder(filePath) { folders.add(filePath); },
    async createBinary(filePath, bytes) {
      const file = new TFile(filePath, new Uint8Array(bytes));
      stored.set(filePath, file);
      return file;
    },
  };
  const workspace = {
    moveLeafToPopout() { return "original popout"; },
    getActiveFile() { return null; },
    getLeavesOfType() { return []; },
    getLeaf() { return new WorkspaceLeaf(app); },
    on() { return {}; },
    detachLeavesOfType() {},
  };
  const app = { isMobile: appMobile, vault, workspace };
  const obsidian = {
    EditableFileView,
    Modal: class Modal {},
    Notice: class Notice { constructor(message) { notices.push(message); } },
    Platform: { isMobile: platformMobile, isIosApp: platformIos, isDesktopApp: platformDesktop },
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    WorkspaceLeaf,
    normalizePath(value) { return value.replaceAll("\\", "/"); },
  };
  const moduleObject = { exports: {} };
  const context = {
    module: moduleObject,
    exports: moduleObject.exports,
    require(name) {
      if (name === "obsidian") return obsidian;
      if (name === "./asset-runtime.cjs") {
        return { ...assetRuntime, ensureViewerAssets: async () => ({
          rootPath: cacheRoot,
          webRoot: `${cacheRoot}/web`,
          version: "0.3.0-test",
          contentHash: payload.contentHash,
        }) };
      }
      if (name === "./pdf-hash-runtime.cjs") {
        return { createPdfHashRuntime: async () => pdfHashRuntime };
      }
      if (["./pdf-merge-client.cjs", "./pdf-sync-host.cjs", "./heavy-work.cjs", "./pdf-recovery.cjs",
        "./pdf-recovery-read.cjs", "./pdf-annotation-host.cjs", "./reader-anchor-store.cjs", "./vocabulary/canonical.cjs",
        "./reader-backlink-index.cjs", "./vocabulary/service.cjs", "./vocabulary/dictionary.cjs",
        "./vocabulary/modals.cjs", "./vocabulary/workspace.cjs", "./vocabulary/workbench.cjs",
        "./learning/host.cjs", "./semantic/services.cjs", "./session-log.cjs"].includes(name)) return sourceRequire(name);
      if (name.startsWith("node:")) nodeRuntimeRequires.push(name);
      throw new Error(`Unexpected plugin require: ${name}`);
    },
    URL: TestURL,
    Blob,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    console,
  };
  context.globalThis = context;
  vm.runInNewContext(
    `(function (require, module, exports) { ${injectedSource}\n})(require, module, exports);`,
    context,
    { filename: "plugin/main.js" },
  );
  const plugin = new moduleObject.exports(app, { id: "pdf-web-reader", version: "0.3.0" });

  return {
    app,
    plugin,
    commands,
    settings,
    stored,
    folders,
    notices,
    nodeRuntimeRequires,
    revokedUrls,
    createdUrls,
    ownerWindows,
    get savedData() { return savedData; },
    makeWindow,
    makeView() {
      const leaf = new WorkspaceLeaf(app);
      return viewFactory(leaf);
    },
  };
}

async function runBootScript(html, importModule, { bridgeFailure = false, fallbackEvent = "load" } = {}) {
  const match = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "mobile document includes an inline module bootstrap");
  let script = match[1];
  const configStart = script.indexOf("const config = ");
  const configEnd = script.indexOf(";\n    const stage", configStart);
  assert.ok(configStart >= 0 && configEnd > configStart, "bootstrap has inline config");
  script = `${script.slice(0, configStart)}const config = window.__testConfig${script.slice(configEnd + 1)}`;
  script = script
    .replace("await import(config.moduleUrls[name]);", 'await config.__testImport(name, "resource");')
    .replace("await import(config.fallbackUrls[name]);", 'await config.__testImport(name, "blob");')
    .replace("(async () => {", "window.__bootPromise = null;\n    window.__bootPromise = (async () => {");

  const messages = [];
  const bridgeEvents = [];
  function makeBridgeScript(attributes = new Map()) {
    const listeners = new Map();
    return {
      attributes,
      dataset: {},
      addEventListener(type, listener) {
        const callbacks = listeners.get(type) || new Set();
        callbacks.add(listener);
        listeners.set(type, callbacks);
      },
      removeEventListener(type, listener) {
        listeners.get(type)?.delete(listener);
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      setAttribute(name, value) {
        attributes.set(name, value);
      },
      set src(value) {
        attributes.set("src", value);
      },
      get src() {
        return attributes.get("src");
      },
      after(fallback) {
        bridgeEvents.fallbackScript = fallback;
        bridgeEvents.push("fallback-inserted");
        setTimeout(() => {
          bridgeEvents.push("fallback-" + fallbackEvent);
          fallback.dispatchEvent(fallbackEvent);
        }, 0);
      },
      dispatchEvent(type) {
        for (const listener of [...(listeners.get(type) || [])]) {
          listener({ type, target: this });
        }
      },
    };
  }
  const bridgeElement = makeBridgeScript(new Map([
    ["data-pdf-reader-bridge", "1"],
    ["data-channel", "pdf-web-reader"],
    ["data-token", "test-token"],
    ["data-renderer-generation", "generation-1"],
    ["data-base-url", "app://local/web/"],
    ["data-ios-input-policy", /data-ios-input-policy="true"/.test(html) ? "true" : "false"],
    ["src", "app://local/web/obsidian-bridge.js?v=test-token"],
    ["onload", "resource-load-handler"],
    ["onerror", "resource-error-handler"],
  ]));
  const context = {
    parent: { postMessage(message) { messages.push(message); } },
    __PDF_READER_BRIDGE_LOADED__: !bridgeFailure,
    __PDF_READER_BRIDGE_RESOURCE_FAILED__: bridgeFailure,
    __PDF_READER_BRIDGE_SOURCE__: bridgeFailure ? undefined : "resource",
    document: {
      querySelector(selector) {
        assert.equal(selector, 'script[data-pdf-reader-bridge="1"]');
        return bridgeElement;
      },
      createElement(tagName) {
        assert.equal(tagName, "script");
        const element = makeBridgeScript();
        bridgeEvents.freshScript = element;
        return element;
      },
    },
    setTimeout,
    clearTimeout,
    __bridgeEvents: bridgeEvents,
    __testConfig: {
      channel: "pdf-web-reader",
      token: "test-token",
      rendererGeneration: "generation-1",
      resourceUrls: {},
      moduleUrls: { pdf: "app://pdf.mjs", viewer: "app://viewer.mjs" },
      fallbackUrls: { bridge: "blob:bridge.js", pdf: "blob:pdf.mjs", viewer: "blob:viewer.mjs" },
      __testImport: null,
    },
  };
  context.window = context;
  context.globalThis = context;
  context.__testConfig.__testImport = (name, source) => importModule(name, source, context);
  vm.runInNewContext(script, context, { filename: "mobile-viewer-bootstrap.mjs" });
  await context.__bootPromise;
  return { messages, context };
}

test("mobile loader verifies adapter assets, orders bridge and PDF.js modules, and revokes by renderer generation", async () => {
  const harness = makeHarness();
  const originalPopoutMethod = harness.app.workspace.moveLeafToPopout;
  await harness.plugin.onload();
  assert.equal(harness.plugin.isMobileRuntime, true);
  assert.equal(harness.app.workspace.moveLeafToPopout, originalPopoutMethod);
  assert.equal(harness.nodeRuntimeRequires.length, 0);

  const view = harness.makeView();
  const ownerWindow = harness.makeWindow();
  const frame = {
    ownerDocument: { defaultView: ownerWindow },
    contentWindow: { parent: ownerWindow, sent: [], postMessage(message) { this.sent.push(message); } },
    srcdoc: "",
    remove() {},
  };
  view.iframe = frame;
  const html = await view.createViewerDocument();
  const bridgePosition = html.indexOf("data-base-url=");
  const bootPosition = html.indexOf("type=\"module\">");
  assert.ok(bridgePosition >= 0 && bootPosition > bridgePosition);
  assert.match(html, /<base href="app:\/\/local\/test-cache\/web\/">/);
  assert.match(html, /onerror="window\.__PDF_READER_BRIDGE_RESOURCE_FAILED__=true"/);
  assert.match(html, /data-pdf-reader-bridge="1"/);
  assert.match(html, /window\.__PDF_READER_MOBILE_RESOURCES__/);
  assert.match(html, /await importModule\("pdf"\)[\s\S]*await importModule\("viewer"\)/);
  assert.doesNotMatch(html, /src="\.\.\/build\/pdf\.mjs"/);
  assert.doesNotMatch(html, /src="viewer\.mjs"/);
  assert.equal(harness.createdUrls.size, 4);

  const send = (type, fields = {}) => view.onMessage({
    source: frame.contentWindow,
    data: {
      channel: "pdf-web-reader",
      token: view.token,
      rendererGeneration: view.rendererGeneration,
      type,
      ...fields,
    },
  });
  send("mobile-module-loaded", { module: "bridge", source: "resource" });
  send("mobile-module-loaded", { module: "pdf", source: "blob" });
  send("mobile-module-loaded", { module: "viewer", source: "blob" });
  assert.equal(harness.revokedUrls.length, 3);
  assert.equal(harness.createdUrls.size, 1, "worker URL stays live while its renderer is active");
  send("renderer-unloaded");
  assert.equal(harness.revokedUrls.length, 3, "unload waits for worker termination");
  send("worker-terminated");
  assert.equal(harness.revokedUrls.length, 4);
  assert.equal(view.mobileResourceLease, null);
  assert.equal(harness.nodeRuntimeRequires.length, 0);
  harness.plugin.onunload();
});

test("mobile bridge Blob fallback uses a fresh script and settles before imports", async () => {
  const harness = makeHarness({ platformIos: true });
  await harness.plugin.onload();
  const view = harness.makeView();
  view.iframe = {
    contentWindow: { parent: {} },
    ownerDocument: { defaultView: harness.makeWindow() },
    srcdoc: "",
    remove() {},
  };
  const html = await view.createViewerDocument();
  const imports = [];
  const loaded = await runBootScript(html, async (name, source, context) => {
    assert.deepEqual(context.__bridgeEvents.slice(0, 2), ["fallback-inserted", "fallback-load"]);
    const fallback = context.__bridgeEvents.fallbackScript;
    assert.equal(context.__bridgeEvents.freshScript, fallback);
    assert.equal(fallback.attributes.get("data-pdf-reader-bridge"), "1");
    assert.equal(fallback.attributes.get("data-channel"), "pdf-web-reader");
    assert.equal(fallback.attributes.get("data-token"), "test-token");
    assert.equal(fallback.attributes.get("data-renderer-generation"), "generation-1");
    assert.equal(fallback.attributes.get("data-base-url"), "app://local/web/");
    assert.equal(fallback.attributes.get("data-ios-input-policy"), "true");
    assert.equal(fallback.src, "blob:bridge.js");
    assert.equal(fallback.attributes.has("onload"), false);
    assert.equal(fallback.attributes.has("onerror"), false);
    assert.equal(fallback.dataset.mobileFallback, "1");
    imports.push(name);
    if (name === "pdf") context.pdfjsLib = { version: "test" };
  }, { bridgeFailure: true, fallbackEvent: "load" });
  assert.deepEqual(imports, ["pdf", "viewer"]);
  assert.deepEqual(
    loaded.messages.filter((message) => message.type === "mobile-module-loaded").map((message) => [message.module, message.source]),
    [["bridge", "blob"], ["pdf", "resource"], ["viewer", "resource"]],
  );

  const failedImports = [];
  const failed = await runBootScript(html, async (name) => failedImports.push(name), {
    bridgeFailure: true,
    fallbackEvent: "error",
  });
  assert.deepEqual(failedImports, []);
  assert.ok(failed.messages.some((message) =>
    message.type === "mobile-loader-failed" && message.code === "bridge-resource"));
  harness.plugin.onunload();
});

test("mobile module fallback does not retry after partial PDF.js or viewer evaluation", async () => {
  const harness = makeHarness();
  await harness.plugin.onload();
  const view = harness.makeView();
  view.iframe = {
    contentWindow: { parent: {} },
    ownerDocument: { defaultView: harness.makeWindow() },
    srcdoc: "",
    remove() {},
  };
  const html = await view.createViewerDocument();

  const pdfAttempts = [];
  const pdfFailure = await runBootScript(html, async (name, source, context) => {
    pdfAttempts.push([name, source]);
    if (name === "pdf" && source === "resource") {
      // Simulate pdf.mjs publishing its global before a later evaluation error.
      context.pdfjsLib = { partial: true };
      throw new Error("synthetic partial module evaluation");
    }
    throw new Error("unexpected import retry");
  });
  assert.deepEqual(pdfAttempts, [["pdf", "resource"]]);
  assert.ok(pdfFailure.messages.some((message) =>
    message.type === "mobile-loader-failed" && message.code === "pdf-module-import"));

  const viewerAttempts = [];
  const viewerFailure = await runBootScript(html, async (name, source, context) => {
    viewerAttempts.push([name, source]);
    if (name === "pdf") {
      context.pdfjsLib = { version: "test" };
      return;
    }
    if (name === "viewer" && source === "resource") {
      // The bundled viewer publishes this before running the application.
      context.PDFViewerApplication = { partial: true };
      throw new Error("synthetic partial viewer evaluation");
    }
    throw new Error("unexpected viewer retry");
  });
  assert.deepEqual(viewerAttempts, [["pdf", "resource"], ["viewer", "resource"]]);
  assert.ok(viewerFailure.messages.some((message) =>
    message.type === "mobile-loader-failed" && message.code === "viewer-module-import"));
  harness.plugin.onunload();
});

test("mobile module fallback retries only a resource rejection with no evaluation effects", async () => {
  const harness = makeHarness();
  await harness.plugin.onload();
  const view = harness.makeView();
  view.iframe = {
    contentWindow: { parent: {} },
    ownerDocument: { defaultView: harness.makeWindow() },
    srcdoc: "",
    remove() {},
  };
  const html = await view.createViewerDocument();
  const attempts = [];
  const result = await runBootScript(html, async (name, source, context) => {
    attempts.push([name, source]);
    if (name === "pdf" && source === "resource") {
      throw new Error("synthetic scheme load failure");
    }
    if (name === "pdf" && source === "blob") {
      context.pdfjsLib = { version: "test" };
      return;
    }
    if (name === "viewer") return;
    throw new Error("unexpected import");
  });
  assert.deepEqual(attempts, [["pdf", "resource"], ["pdf", "blob"], ["viewer", "resource"]]);
  assert.ok(result.messages.some((message) =>
    message.type === "mobile-module-loaded" && message.module === "pdf" && message.source === "blob"));
  assert.ok(result.messages.some((message) =>
    message.type === "mobile-module-loaded" && message.module === "viewer" && message.source === "resource"));
  harness.plugin.onunload();
});

test("mobile startup exposes sanitized stages without replacing an opened document status", async () => {
  const harness = makeHarness();
  await harness.plugin.onload();
  const view = harness.makeView();
  const status = [];
  view.statusEl = { setText: text => status.push(text), toggleClass() {} };
  view.setMobileLoaderStage("assets-loading");
  assert.match(status.at(-1), /检查资源缓存，核验变化项/);
  view.setMobileLoaderStage("viewer-module-loading");
  assert.match(status.at(-1), /加载阅读器模块/);
  view.mobileRuntime.lastError = { stage: "viewer-module-loading", code: "viewer-module-import" };
  assert.match(view.mobileStartupFailureMessage(), /加载阅读器模块（viewer-module-import）/);
  assert.match(view.mobileStartupFailureMessage(), /重新打开 PDF 重试/);
  view.mobileRuntime.lastError = { stage: "Private/secret.pdf", code: "secret bytes" };
  assert.doesNotMatch(view.mobileStartupFailureMessage(), /secret|Private/);
  view.ready = true;
  view.setMobileLoaderStage("ready");
  const count = status.length;
  view.setMobileLoaderStage("viewer-module-loaded");
  assert.equal(view.mobileRuntime.stage, "ready");
  assert.equal(status.length, count);
  harness.plugin.onunload();
});

test("status bar defaults off, toggles live Readers without reload, and restores paused recovery action", async () => {
  const harness = makeHarness({ savedData: { autoSave: false } });
  await harness.plugin.onload();
  assert.equal(harness.plugin.settings.showStatusBar, false,
    "legacy settings without the new key remain status-bar off");
  const readers = [harness.makeView(), harness.makeView()];
  await Promise.all(readers.map((view) => view.onOpen()));
  const frames = readers.map((view) => view.iframe);
  const srcdocs = frames.map((frame) => frame.srcdoc);
  assert.ok(readers.every((view) => view.statusEl === null));
  assert.ok(readers.every((view) => view.contentEl.children.length === 1));
  assert.ok(readers.every((view) => view.contentEl.children[0] === view.iframe));

  let restoreCalls = 0;
  harness.plugin.restoreLatestRecovery = () => { restoreCalls += 1; };
  const privatePath = "Private/Confidential.pdf";
  readers[0].setStatus(`同步暂停：checkpoint conflict for ${privatePath}`, { recoveryAction: true });
  assert.equal(readers[0].statusRecoveryAction, true);
  assert.equal(readers[0].statusEl, null,
    "hidden status state and recovery action are retained without creating DOM");
  assert.match(readers[0].lastStatusMessage, /同步暂停/);

  harness.plugin.settingTab.display();
  const setting = harness.settings.find((entry) => entry.name === "显示阅读器状态栏");
  assert.ok(setting);
  assert.equal(setting.toggle.value, false);
  for (const enabled of [true, false, true, false, true]) {
    await setting.toggle.change(enabled);
    for (const view of readers) {
      assert.equal(view.statusBarEnabled, enabled);
      assert.equal(view.iframe, frames[readers.indexOf(view)], "the Viewer iframe is never recreated");
      assert.equal(view.iframe.srcdoc, srcdocs[readers.indexOf(view)]);
      const statusNodes = view.contentEl.children.filter((node) => node.classList.contains("pdf-web-reader-status"));
      assert.equal(statusNodes.length, enabled ? 1 : 0, "repeated toggles do not duplicate status nodes");
      if (enabled) assert.equal(view.contentEl.children[0], view.statusEl,
        "the status bar stays before the iframe in every Reader window");
      else assert.deepEqual(view.contentEl.children, [view.iframe], "disabled status has no DOM or layout height");
    }
  }

  const status = readers[0].statusEl;
  assert.match(status.textContent, /checkpoint conflict/);
  assert.equal(status.children.filter((node) => node.tagName === "button").length, 1);
  status.children.find((node) => node.tagName === "button").click();
  assert.equal(restoreCalls, 1);
  assert.equal(harness.savedData.showStatusBar, true);
  assert.equal(harness.savedData.autoSave, false);

  const newlyOpened = harness.makeView();
  await newlyOpened.onOpen();
  assert.equal(newlyOpened.contentEl.children[0], newlyOpened.statusEl,
    "a Reader opened while the preference is enabled creates status before its iframe");
  assert.equal(newlyOpened.contentEl.children[1], newlyOpened.iframe);

  const diagnosticsPath = await harness.plugin.exportMobileDiagnostics();
  const diagnostics = JSON.parse(new TextDecoder().decode(harness.stored.get(diagnosticsPath).bytes));
  assert.equal(JSON.stringify(diagnostics).includes(privatePath), false,
    "the internal status message and document path never enter exported diagnostics");
  for (const view of [...readers, newlyOpened]) view.clearBridgeTimeout();
  harness.plugin.onunload();
});

test("iOS pointer policy follows the frozen Obsidian platform entry and survives bridge fallback", async () => {
  for (const [name, config, enabled] of [
    ["native iOS", { appMobile: true, platformIos: true }, true],
    ["desktop mobile emulator", { appMobile: true, platformDesktop: true }, true],
    ["native Android", { appMobile: true, platformMobile: true }, false],
    ["ordinary desktop", { appMobile: false, platformDesktop: true }, false],
  ]) {
    const harness = makeHarness(config);
    await harness.plugin.onload();
    assert.equal(harness.plugin.iosInputPolicy, enabled, name);
    const view = harness.makeView();
    view.iframe = {
      contentWindow: { parent: {} },
      ownerDocument: { defaultView: harness.makeWindow() },
      srcdoc: "",
      remove() {},
    };
    const html = await view.createViewerDocument();
    assert.ok(html.includes(`data-ios-input-policy="${enabled}"`), name);
    assert.equal(harness.nodeRuntimeRequires.length, 0, name);
    harness.plugin.onunload();
  }
});

test("desktop and mobile emulation keep separate entries over a shared browser-only core", async () => {
  const harness = makeHarness({ appMobile: false, platformMobile: false });
  await harness.plugin.onload();
  const view = harness.makeView();
  const html = await view.createViewerDocument();
  assert.match(html, /obsidian-bridge\.js\?v=/);
  assert.doesNotMatch(html, /__PDF_READER_MOBILE_RESOURCES__/);
  assert.equal(harness.createdUrls.size, 0);
  assert.equal(harness.nodeRuntimeRequires.length, 0);
  harness.app.isMobile = true;
  assert.equal(harness.plugin.isMobileRuntime, false,
    "Changing the host simulation flag cannot migrate a loaded Reader's platform entry");
  harness.plugin.settingTab.display();
  assert.ok(harness.settings.some((setting) => setting.name === "导出阅读器诊断" && setting.button?.text === "导出 JSON"));
  view.requestedPath = "Private/Confidential desktop.pdf";
  const outputPath = await harness.plugin.exportMobileDiagnostics();
  const output = harness.stored.get(outputPath);
  const json = JSON.parse(new TextDecoder().decode(output.bytes));
  assert.equal(json.platform.loaderMode, "desktop-resource");
  assert.equal(json.readers[0].worker.source, "resource");
  assert.equal(JSON.stringify(json).includes("Confidential desktop.pdf"), false);
  harness.plugin.onunload();
});

test("mobile JSON retains historical save errors with no Readers and disables the separate log command", async () => {
  const harness = makeHarness();
  await harness.plugin.onload();
  const history = ".obsidian/plugins/pdf-web-reader/.logs/2026-10-13T00-00-00-000Z-ipad-000.log";
  await harness.app.vault.adapter.write(history, JSON.stringify({ kind: "function.error", fn: "Viewer.requestSave", durationMs: 321, error: { message: "Could not bind new Ink editor" } }) + "\n");
  assert.equal(harness.commands.has("flush-local-runtime-log"), false);
  const firstExport = harness.plugin.exportMobileDiagnostics();
  assert.equal(harness.plugin.exportMobileDiagnostics(), firstExport, "repeated taps reuse one history export");
  const outputPath = await firstExport;
  const json = JSON.parse(new TextDecoder().decode(harness.stored.get(outputPath).bytes));
  assert.equal(json.activeReaderCount, 0);
  assert.ok(json.runtimeLog.records.some(row => row.fn === "Viewer.requestSave" && row.durationMs === 321));
  assert.ok(json.runtimeLog.records.some(row => row.kind === "session.start"));
  assert.equal(json.runtimeLog.complete, false, "the old session has no observed shutdown marker");
  assert.equal(json.runtimeLog.interruptedSessions.length, 1);
  assert.ok(harness.stored.has(history));
  await harness.plugin.onunload();
});

test("JSON export drains Viewer records created while collecting diagnostics", async () => {
  const harness = makeHarness();
  await harness.plugin.onload();
  const view = harness.makeView();
  let queued = [];
  view.iframe = { contentWindow: { __PDF_READER_DRAIN_LOG__: () => { const result = queued; queued = []; return result; } } };
  view.requestInputDiagnostics = async () => { queued.push(JSON.stringify({ kind: "function.end", fn: "Viewer.sendDiagnostics", durationMs: 4 })); return null; };
  const outputPath = await harness.plugin.exportMobileDiagnostics();
  const json = JSON.parse(new TextDecoder().decode(harness.stored.get(outputPath).bytes));
  assert.ok(json.runtimeLog.records.some(row => row.kind === "viewer" && JSON.parse(row.row).fn === "Viewer.sendDiagnostics"));
  await harness.plugin.onunload();
});

test("mobile settings export path-free diagnostics with bounded pointer samples", async () => {
  const harness = makeHarness({ appMobile: false, platformMobile: true });
  await harness.plugin.onload();
  assert.equal(harness.plugin.isMobileRuntime, true, "Platform.isMobile emulation selects mobile mode");
  harness.plugin.settingTab.display();
  assert.ok(harness.settings.some((setting) => setting.name === "导出移动端诊断" && setting.button?.text === "导出 JSON"));

  const view = harness.makeView();
  view.requestedPath = "Private/Confidential source.pdf";
  view.mobileRuntime.assetVersion = "0.3.0-test";
  view.mobileRuntime.resourceHash = "a".repeat(64);
  view.mobileRuntime.assetCount = 4;
  view.mobileRuntime.stage = "viewer-module-loaded";
  view.mobileRuntime.moduleSources = { pdf: "blob", viewer: "blob" };
  view.ready = false;
  const outputPath = await harness.plugin.exportMobileDiagnostics();
  assert.match(outputPath, /^PDF Reader Diagnostics\/.*\.json$/);
  const output = [...harness.stored.entries()].find(([filePath]) => filePath === outputPath)?.[1];
  assert.ok(output);
  const json = JSON.parse(new TextDecoder().decode(output.bytes));
  assert.equal(json.platform.loaderMode, "mobile-blob");
  assert.ok(json.browser && json.browser.capabilities);
  assert.ok(json.browser.userAgent === null ||
    (typeof json.browser.userAgent === "string" && json.browser.userAgent.length <= 256));
  assert.ok(Object.values(json.browser.capabilities).every((value) => typeof value === "boolean"));
  assert.equal(typeof json.browser.capabilities.gzipDecompression, "boolean");
  assert.equal(json.readers[0].stage, "viewer-module-loaded");
  assert.equal(json.readers[0].assets.contentHash, "a".repeat(64));
  assert.equal(json.readers[0].input, null);
  assert.equal(JSON.stringify(json).includes("Confidential source.pdf"), false);
  assert.equal(JSON.stringify(json).includes("test-cache"), false);
  assert.equal(JSON.stringify(json).includes("pdfjsLib"), false);
  harness.plugin.onunload();
});

test("ready-frame diagnostics reject stale replies and sanitize bounded input samples", async () => {
  const harness = makeHarness();
  await harness.plugin.onload();
  const view = harness.makeView();
  view.ready = true;
  view.iframe = {};
  view.rendererGeneration = "diagnostic-generation";
  let request;
  view.postToViewer = (message) => { request = message; return true; };
  const pending = view.requestInputDiagnostics();
  const samples = Array.from({ length: 40 }, (_, index) => ({
    type: "pointerdown", pointerType: "mouse", button: 0, buttons: 1,
    activePointers: 1, editorMode: index, trusted: true,
    pdfText: "Private PDF content", path: "Private/secret.pdf",
  }));
  const reply = {
    type: "input-diagnostics", requestId: request.requestId,
    rendererGeneration: "stale-generation", schema: 1,
    pointerEventsSeen: 40, pointerEventsDropped: 0, activePointers: 1,
    editorMode: 15, vocabularyEnabled: true,
    annotationTrackingFailure: { phase: "mutation.capture", code: "annotation-deletion-identity-unresolved",
      revision: 8, count: 2, message: "Private PDF content" },
    pointers: samples,
  };
  view.handleMobileRuntimeMessage(reply);
  assert.equal(view.mobileInputDiagnosticsRequests.size, 1);
  view.handleMobileRuntimeMessage({ ...reply, rendererGeneration: view.rendererGeneration });
  const snapshot = await pending;
  assert.equal(snapshot.pointers.length, 32);
  assert.equal(snapshot.pointers[0].editorMode, 8);
  assert.equal(snapshot.pointerEventsSeen, 40);
  assert.equal(snapshot.editorMode, 15);
  assert.equal(snapshot.vocabularyEnabled, true);
  assert.equal(snapshot.annotationTrackingFailure.code, "annotation-deletion-identity-unresolved");
  assert.equal(snapshot.annotationTrackingFailure.revision, 8);
  assert.equal(JSON.stringify(snapshot).includes("Private"), false);
  assert.equal(view.mobileInputDiagnosticsRequests.size, 0);

  const malformedPending = view.requestInputDiagnostics();
  view.handleMobileRuntimeMessage({
    ...reply, requestId: request.requestId, rendererGeneration: view.rendererGeneration,
    pointerEventsSeen: NaN, pointers: [null, { ...samples[0], button: "0" },
      { ...samples[0], type: "secret.pdf" }, { ...samples[0], button: 99 }],
  });
  const malformed = await malformedPending;
  assert.equal(malformed.pointerEventsSeen, 0);
  assert.equal(malformed.pointers.length, 0);
  harness.plugin.onunload();
});
