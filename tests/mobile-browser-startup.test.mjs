import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { cleanupBrowserTestResources, attachCleanupErrors } from "./browser-test-cleanup.mjs";

const root = path.resolve(import.meta.dirname, "..");

for (const blockDirectScripts of [false, true]) {
test(`release real browser without Node: mobile PDF/save/reopen (${blockDirectScripts ? "forced Blob fallback" : "resource imports"})`, { timeout: 120_000 }, async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "dist/pdf-web-reader/manifest.json"), "utf8"));
  const source = await readFile(path.join(root, "dist/pdf-web-reader/main.js"), "utf8");
  const styles = await readFile(path.join(root, "dist/pdf-web-reader/styles.css"), "utf8");
  const fixture = await readFile(path.join(root, "tests/fixtures/tracemonkey.pdf"));
  const files = new Map([["sample.pdf", fixture]]), directories = new Set([".obsidian"]);
  let pdfWrites = 0, browser, page, primaryError;
  const report = { status: "running", mode: "real-browser-no-node/mobile", physicalIpadValidated: false, blockDirectScripts, checks: {}, errors: [] };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/") { res.setHeader("content-type", "text/html"); res.end(`<!doctype html><style>body{margin:0}.host{position:relative;width:100vw;height:100vh}${styles}</style><div id="host" class="host workspace-leaf-content"></div>`); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204).end(); return; }
      if (url.pathname === "/bundle") { res.setHeader("content-type", "text/javascript"); res.end(source); return; }
      const key = url.searchParams.get("path") || decodeURIComponent(url.pathname.slice("/resource/".length));
      if (!key || key.split("/").some(s => s === "..") || key.startsWith("/")) throw Error("Invalid fixture adapter path");
      const op = url.searchParams.get("op");
      if (blockDirectScripts && url.pathname.startsWith("/resource/") && /\.(mjs|js)$/.test(key)) { res.writeHead(415).end("Fixture simulates unsupported script resource URLs"); return; }
      if (url.pathname === "/adapter") {
        if (op === "exists") { res.end(JSON.stringify(files.has(key) || directories.has(key))); return; }
        if (op === "mkdir") { directories.add(key); res.end("null"); return; }
        if (op === "remove") { files.delete(key); res.end("null"); return; }
        if (op === "list") {
          const prefix = `${key}/`;
          res.end(JSON.stringify({ files: [...files.keys()].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")), folders: [...directories].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) })); return;
        }
        if (op === "write") {
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          files.set(key, Buffer.concat(chunks)); if (key === "sample.pdf") pdfWrites++;
          res.end("null"); return;
        }
        if (op !== "read") throw Error("Unknown fixture operation");
      }
      const bytes = files.get(key); if (!bytes) { res.writeHead(404).end(); return; }
      const ext = path.extname(key);
      res.setHeader("content-type", ({ ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".ftl": "text/plain" })[ext] || "application/octet-stream");
      res.end(bytes);
    } catch (error) { res.writeHead(500).end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await launchTestBrowser(puppeteer, { executablePath: resolveBrowserPath(), headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1100, height: 850 } }, { testName: "mobile-browser-startup" });
    page = await browser.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(base);
    report.checks.boot = await page.evaluate(async ({ manifest, base }) => {
      if (typeof Buffer !== "undefined" || typeof process !== "undefined" || typeof require !== "undefined") throw Error("Node globals leaked into browser");
      const augment = (element) => {
        element.empty = () => element.replaceChildren();
        element.addClass = (...cls) => element.classList.add(...cls);
        element.removeClass = (...cls) => element.classList.remove(...cls);
        element.toggleClass = (cls, value) => element.classList.toggle(cls, value);
        element.setText = text => { element.textContent = text; };
        element.createEl = (tag, options = {}) => {
          const child = augment(document.createElement(tag));
          if (options.cls) child.className = options.cls;
          if (options.text) child.textContent = options.text;
          for (const [name, value] of Object.entries(options.attr || {})) child.setAttribute(name, value);
          element.append(child); return child;
        };
        element.createDiv = options => element.createEl("div", options);
        return element;
      };
      const host = augment(document.getElementById("host"));
      const api = async (op, target, data) => {
        const response = await fetch(`${base}/adapter?op=${op}&path=${encodeURIComponent(target)}`, data === undefined ? {} : { method: "POST", body: data });
        if (!response.ok) throw Error(`Adapter ${op} failed`);
        return op === "read" ? response.arrayBuffer() : response.json();
      };
      const adapter = {
        exists: target => api("exists", target), mkdir: target => api("mkdir", target),
        readBinary: target => api("read", target), writeBinary: (target, bytes) => api("write", target, bytes),
        read: async target => new TextDecoder().decode(await api("read", target)),
        write: (target, text) => api("write", target, text), remove: target => api("remove", target),
        list: target => api("list", target),
        getResourcePath: target => `${base}/resource/${encodeURIComponent(target)}`,
      };
      // Preserve relative URL resolution for the real Viewer resources.
      adapter.getResourcePath = target => `${base}/resource/${target.split("/").map(encodeURIComponent).join("/")}`;
      class TFile { constructor(target) { this.path = target; this.extension = target.split(".").at(-1); this.basename = target.split("/").at(-1).replace(/\.pdf$/, ""); } }
      const vaultFiles = new Map([["sample.pdf", new TFile("sample.pdf")]]), leaves = [];
      let factory;
      class EditableFileView {
        constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.contentEl = augment(host.createDiv({ cls: "view-content" })); }
        async onOpen() {} async onClose() {} async onLoadFile(file) { this.file = file; } async onUnloadFile() { this.file = null; }
        async setState(state) { if (state?.file) await this.onLoadFile(vaultFiles.get(state.file)); }
        getState() { return { file: this.file?.path }; }
      }
      class WorkspaceLeaf {
        constructor(app) { this.app = app; this.id = crypto.randomUUID(); leaves.push(this); }
        async setViewState(state) {
          if (!this.view) { this.view = factory(this); await this.view.onOpen(); }
          await this.view.setState(state.state, {}); return this.view;
        }
        async detach() { await this.view?.onClose(); this.view?.contentEl.remove(); leaves.splice(leaves.indexOf(this), 1); }
      }
      class Plugin {
        constructor(app, manifest) { this.app = app; this.manifest = manifest; this.commands = []; }
        registerView(_id, fn) { factory = fn; } registerEvent() {} register() {}
        addCommand(command) { this.commands.push(command); } addSettingTab(tab) { this.tab = tab; }
        async loadData() { return null; } async saveData() {}
      }
      class PluginSettingTab { constructor(app) { this.app = app; this.containerEl = augment(document.createElement("div")); } }
      class Setting {
        constructor() {} setName() { return this; } setDesc() { return this; }
        addToggle(fn) { const toggle = { setValue: () => toggle, onChange: () => toggle }; fn(toggle); return this; }
        addButton(fn) { const button = { setButtonText: () => button, onClick: () => button }; fn(button); return this; }
      }
      const obsidian = { EditableFileView, WorkspaceLeaf, Plugin, TFile, PluginSettingTab, Setting, Platform: { isMobile: true, isDesktop: false, isIosApp: true }, Notice: class { constructor(text) { (window.notices ||= []).push(text); } }, normalizePath: target => target.replaceAll("\\", "/") };
      const app = {
        isMobile: true,
        vault: { adapter, configDir: ".obsidian", on: () => ({}), getAbstractFileByPath: target => vaultFiles.get(target) || null,
          readBinary: file => adapter.readBinary(file.path), modifyBinary: (file, data) => adapter.writeBinary(file.path, data),
          async createFolder(target) { await adapter.mkdir(target); vaultFiles.set(target, { path: target }); },
          async create(target, text) { await adapter.write(target, text); const file = new TFile(target); vaultFiles.set(target, file); return file; },
          async createBinary(target, data) { await adapter.writeBinary(target, data); const file = new TFile(target); vaultFiles.set(target, file); return file; },
        },
        workspace: { on: () => ({}), getActiveFile: () => vaultFiles.get("sample.pdf"), getLeavesOfType: type => leaves.filter(l => l.view?.getViewType() === type),
          getLeaf: () => new WorkspaceLeaf(app), iterateAllLeaves: fn => leaves.forEach(fn), detachLeavesOfType() {}, },
      };
      const module = { exports: {} };
      const source = await (await fetch(`${base}/bundle`)).text();
      Function("require", "module", "exports", source)(name => { if (name !== "obsidian") throw Error(`Forbidden module ${name}`); return obsidian; }, module, module.exports);
      const plugin = new module.exports(app, manifest); await plugin.onload(); plugin.tab.display();
      window.fixturePlugin = plugin; window.fixtureApp = app; window.fixtureLeaves = leaves; window.fixtureFile = vaultFiles.get("sample.pdf");
      await plugin.openPdf(window.fixtureFile);
      return { nodeGlobalsAbsent: typeof Buffer === "undefined" && typeof process === "undefined", mobile: plugin.isMobileRuntime, settingsOpened: true, pluginLoaded: true };
    }, { manifest, base });
    assert.equal(report.checks.boot.nodeGlobalsAbsent, true); assert.equal(report.checks.boot.mobile, true);
    await page.waitForFunction(() => window.fixtureLeaves[0]?.view.ready || window.fixtureLeaves[0]?.view.mobileRuntime.lastError, { timeout: 40_000 });
    const startup = await page.evaluate(() => ({ ready: !!fixtureLeaves[0]?.view.ready, runtime: fixtureLeaves[0]?.view.mobileRuntime, notices: window.notices || [] }));
    assert.equal(startup.ready, true, JSON.stringify(startup));
    const frame = (await page.frames()).find(f => f.parentFrame() === page.mainFrame()); assert.ok(frame);
    await frame.waitForFunction(() => window.PDFViewerApplication?.pdfDocument?.numPages === 14 && document.querySelector('.page[data-page-number="1"] canvas'), { timeout: 30_000 });
    report.checks.viewer = await frame.evaluate(() => ({ pages: PDFViewerApplication.pdfDocument.numPages, canvas: document.querySelector(".page canvas").width, worker: !!PDFViewerApplication.pdfLoadingTask?._worker?.port }));
    await frame.click("#editorSquareButton");
    const position = await frame.$eval('.page[data-page-number="1"] .annotationEditorLayer', el => { const r = el.getBoundingClientRect(); return { x: r.x + 100, y: r.y + 180 }; });
    const iframeBox = await page.$eval("iframe", el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const iframeHeight = await page.$eval("iframe", el => el.getBoundingClientRect().height);
    assert.ok(position.y + 65 < iframeHeight, "Trusted pointer coordinates must be inside the visible iframe");
    await page.mouse.move(iframeBox.x + position.x, iframeBox.y + position.y); await page.mouse.down();
    await page.mouse.move(iframeBox.x + position.x + 90, iframeBox.y + position.y + 65, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => { const v = fixtureLeaves[0].view; return v.currentRevision > 0 && v.confirmedRevision === v.currentRevision && !v.saving; }, { timeout: 20_000 });
    assert.ok(pdfWrites > 0); assert.notDeepEqual(files.get("sample.pdf"), fixture);
    report.checks.saved = { writes: pdfWrites, changed: true };
    report.checks.mobileLoader = await page.evaluate(() => ({...fixtureLeaves[0].view.mobileRuntime}));
    if (blockDirectScripts) { assert.equal(report.checks.mobileLoader.moduleSources.pdf, "blob"); assert.equal(report.checks.mobileLoader.moduleSources.viewer, "blob"); }
    await page.evaluate(async () => {
      window.fixtureClosedViews = [fixtureLeaves[0].view];
      await fixtureLeaves[0].detach(); await fixturePlugin.openPdf(fixtureFile);
    });
    await page.waitForFunction(() => fixtureLeaves[0]?.view.ready, { timeout: 40_000 });
    const reopened = (await page.frames()).find(f => f.parentFrame() === page.mainFrame());
    await reopened.waitForFunction(() => window.PDFViewerApplication?.pdfDocument?.numPages === 14, { timeout: 30_000 });
    report.checks.reopened = await reopened.evaluate(async () => { const app = PDFViewerApplication; const annotations = await (await app.pdfDocument.getPage(1)).getAnnotations(); return { square: annotations.filter(a => a.subtype === "Square").length, pages: app.pdfDocument.numPages }; });
    assert.ok(report.checks.reopened.square >= 1);
    await page.evaluate(async () => {
      fixtureClosedViews.push(fixtureLeaves[0].view);
      await fixtureLeaves[0].detach(); fixturePlugin.onunload();
    });
    await page.waitForFunction(() => fixtureClosedViews.every(view => !view.mobileResourceLease), { timeout: 7_000 });
    report.checks.disposed = await page.evaluate(() => ({
      readers: fixtureLeaves.length,
      pluginViews: fixturePlugin.views.size,
      leasesReleased: fixtureClosedViews.every(view => !view.mobileResourceLease),
      revokedResourceCounts: fixtureClosedViews.map(view => view.mobileRuntime.revokedResourceCount),
    }));
    assert.equal(report.checks.disposed.pluginViews, 0);
    assert.equal(report.checks.disposed.leasesReleased, true);
    assert.deepEqual(report.errors, [], "The final release must not throw uncaught browser errors");
    report.status = "passed";
  } catch (error) {
    primaryError = error; report.status = "failed"; report.error = error.stack;
    report.failureState = await page?.evaluate(() => ({
      runtime: window.fixtureLeaves?.[0]?.view.mobileRuntime,
      revision: window.fixtureLeaves?.[0]?.view.currentRevision,
      confirmed: window.fixtureLeaves?.[0]?.view.confirmedRevision,
      paused: window.fixtureLeaves?.[0]?.view.autoSavePaused,
      notices: window.notices || [],
      frameHeight: document.querySelector("iframe")?.getBoundingClientRect().height,
    })).catch(() => null);
  }
  finally {
    report.cleanup = await cleanupBrowserTestResources({ browser, ownedPages: page ? [page] : [], server });
    if (report.cleanup.errors.length) { primaryError ||= new Error("Browser cleanup failed"); attachCleanupErrors(primaryError, report.cleanup); report.status = "failed"; }
    await mkdir(path.join(root, "tests/artifacts"), { recursive: true });
    await writeFile(path.join(root, `tests/artifacts/mobile-browser-startup-${Date.now()}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  if (primaryError) throw primaryError;
});

}
