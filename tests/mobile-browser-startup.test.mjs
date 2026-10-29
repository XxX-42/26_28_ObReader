import { launchTestBrowser } from "./browser-test-launch.mjs";
import { listenBrowserSafe } from "./browser-safe-port.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import { cleanupBrowserTestResources, attachCleanupErrors } from "./browser-test-cleanup.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { createPdfHashRuntime } = createRequire(import.meta.url)("../plugin/pdf-hash-runtime.cjs");
const { readPairId } = createRequire(import.meta.url)("../plugin/pdf-pair-id.cjs");
const hashRuntime = await createPdfHashRuntime();

for (const blockDirectScripts of [false, true, "windows-memory"]) {
const windowsMemory = blockDirectScripts === "windows-memory";
test(`release real browser without Node: PDF/save/reopen (${windowsMemory ? "Windows verified memory startup" : blockDirectScripts ? "forced Blob fallback" : "resource imports"})`, { timeout: 120_000 }, async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "dist/pdf-web-reader/manifest.json"), "utf8"));
  const source = await readFile(path.join(root, "dist/pdf-web-reader/main.js"), "utf8");
  const styles = await readFile(path.join(root, "dist/pdf-web-reader/styles.css"), "utf8");
  const fixture = await readFile(path.join(root, "tests/fixtures/tracemonkey.pdf"));
  const sourceSha256Before = createHash("sha256").update(fixture).digest("hex");
  const sourceXxh64Before = hashRuntime.fingerprint(fixture);
  const files = new Map([["sample.pdf", fixture]]), directories = new Set([".obsidian"]);
  let sourcePdfWrites = 0, annotationWrites = 0, browser, page, primaryError;
  let releaseBackground;
  const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
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
      if (blockDirectScripts === true && url.pathname.startsWith("/resource/") && /\.(mjs|js)$/.test(key)) { res.writeHead(415).end("Fixture simulates unsupported script resource URLs"); return; }
      if (url.pathname === "/adapter") {
        if (op === "exists") { res.end(JSON.stringify(files.has(key) || directories.has(key))); return; }
        if (op === "mkdir") { directories.add(key); res.end("null"); return; }
        if (op === "remove") { files.delete(key); res.end("null"); return; }
        if (op === "rename") {
          const destination = url.searchParams.get("to");
          if (!destination || !files.has(key)) throw Error("Invalid fixture rename");
          files.set(destination, files.get(key)); files.delete(key); res.end("null"); return;
        }
        if (op === "list") {
          const prefix = `${key}/`;
          res.end(JSON.stringify({ files: [...files.keys()].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")), folders: [...directories].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")) })); return;
        }
        if (op === "write" || op === "append") {
          if (windowsMemory && key.includes("/.asset-cache/")) await backgroundGate;
          const chunks = []; for await (const chunk of req) chunks.push(chunk);
          if (op === "append" && !files.has(key)) throw Error("Missing fixture append target");
          files.set(key, Buffer.concat(op === "append" ? [files.get(key), ...chunks] : chunks));
          if (key === "sample.pdf") sourcePdfWrites++;
          else if (key.startsWith("00_Archive/20_PDFData/")) annotationWrites++;
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
  await listenBrowserSafe(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    browser = await launchTestBrowser(puppeteer, { executablePath: resolveBrowserPath(), headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1100, height: 850 } }, { testName: "mobile-browser-startup" });
    page = await browser.newPage();
    page.on("pageerror", error => report.errors.push(error.message));
    await page.goto(base);
    report.checks.boot = await page.evaluate(async ({ manifest, base, windowsMemory }) => {
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
      const processQueues = new Map();
      const adapter = {
        exists: target => api("exists", target), mkdir: target => api("mkdir", target),
        readBinary: target => api("read", target), writeBinary: (target, bytes) => api("write", target, bytes),
        read: async target => new TextDecoder().decode(await api("read", target)),
        write: (target, text) => api("write", target, text), remove: target => api("remove", target),
        process: (target, fn) => {
          const previous = processQueues.get(target) || Promise.resolve();
          const task = previous.catch(() => {}).then(async () => { const current = await adapter.read(target); const next = fn(current); await adapter.write(target, next); return next; });
          const tail = task.then(() => {}, () => {}); processQueues.set(target, tail);
          tail.then(() => { if (processQueues.get(target) === tail) processQueues.delete(target); });
          return task;
        },
        append: (target, text) => api("append", target, text),
        rename: (from, to) => fetch(`${base}/adapter?op=rename&path=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).then(response => { if (!response.ok) throw Error("Adapter rename failed"); return response.json(); }),
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
        async detach() {
          const index = leaves.indexOf(this);
          if (index >= 0) leaves.splice(index, 1);
          await this.view?.onClose();
          this.view?.contentEl.remove();
        }
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
      const obsidian = { EditableFileView, WorkspaceLeaf, Plugin, TFile, Modal: class Modal {}, PluginSettingTab, Setting, Platform: { isMobile: !windowsMemory, isDesktop: windowsMemory, isWin: windowsMemory, isIosApp: !windowsMemory }, Notice: class { constructor(text) { (window.notices ||= []).push(text); } }, normalizePath: target => target.replaceAll("\\", "/") };
      const app = {
        isMobile: !windowsMemory,
        vault: { adapter, configDir: ".obsidian", on: () => ({}), getAbstractFileByPath: target => vaultFiles.get(target) || null,
          readBinary: file => adapter.readBinary(file.path), modifyBinary: (file, data) => adapter.writeBinary(file.path, data),
          appendBinary: (file, data) => api("append", file.path, data),
          async createFolder(target) { await adapter.mkdir(target); vaultFiles.set(target, { path: target }); },
          async create(target, text) { await adapter.write(target, text); const file = new TFile(target); vaultFiles.set(target, file); return file; },
          async createBinary(target, data) { await adapter.writeBinary(target, data); const file = new TFile(target); vaultFiles.set(target, file); return file; },
        },
        workspace: { on: () => ({}), getActiveFile: () => vaultFiles.get("sample.pdf"), getLeavesOfType: type => leaves.filter(l => l.view?.getViewType() === type),
          getLeaf: () => new WorkspaceLeaf(app), iterateAllLeaves: fn => leaves.forEach(fn), detachLeavesOfType() {}, },
      };
      window.fixtureAdapter = adapter;
      const module = { exports: {} };
      const source = await (await fetch(`${base}/bundle`)).text();
      Function("require", "module", "exports", source)(name => { if (name !== "obsidian") throw Error(`Forbidden module ${name}`); return obsidian; }, module, module.exports);
      const plugin = new module.exports(app, manifest); await plugin.onload(); plugin.tab.display();
      window.fixturePlugin = plugin; window.fixtureApp = app; window.fixtureLeaves = leaves; window.fixtureFile = vaultFiles.get("sample.pdf");
      window.fixtureProtocol = [];
      window.addEventListener("message", event => {
        const message = event.data;
        if (message?.channel === "pdf-web-reader" && ["annotation-source-identity", "saved", "external-annotations-update", "annotation-source-mismatch"].includes(message.type)) {
          window.fixtureProtocol.push({ direction: "viewer-to-host", type: message.type, documentId: message.documentId, openRequest: message.openRequest, revision: message.revision, pageCount: message.pageCount });
        }
      });
      await plugin.openPdf(window.fixtureFile);
      const view = plugin.views.values().next().value;
      const originalOnMessage = view.onMessage.bind(view);
      view.onMessage = event => {
        if (event?.data?.type === "annotation-source-identity" || event?.data?.type === "external-annotations-update" || event?.data?.type === "annotation-source-mismatch") {
          window.fixtureProtocol.push({ type: event.data.type, documentId: event.data.documentId, openRequest: event.data.openRequest, pageCount: event.data.pageCount, identityStatus: event.data.identityStatus, revision: event.data.externalAnnotations?.revision, annotations: event.data.externalAnnotations?.annotations?.length });
        }
        return originalOnMessage(event);
      };
      return { nodeGlobalsAbsent: typeof Buffer === "undefined" && typeof process === "undefined", mobile: plugin.isMobileRuntime, settingsOpened: true, pluginLoaded: true };
    }, { manifest, base, windowsMemory });
    assert.equal(report.checks.boot.nodeGlobalsAbsent, true); assert.equal(report.checks.boot.mobile, !windowsMemory);
    await page.waitForFunction(() => window.fixtureLeaves[0]?.view.ready || window.fixtureLeaves[0]?.view.mobileRuntime.lastError, { timeout: 40_000 });
    const startup = await page.evaluate(() => ({ ready: !!fixtureLeaves[0]?.view.ready, runtime: fixtureLeaves[0]?.view.mobileRuntime, notices: window.notices || [] }));
    assert.equal(startup.ready, true, JSON.stringify(startup));
    const frame = (await page.frames()).find(f => f.parentFrame() === page.mainFrame()); assert.ok(frame);
    await frame.waitForFunction(() => window.PDFViewerApplication?.pdfDocument?.numPages === 14 && document.querySelector('.page[data-page-number="1"] canvas'), { timeout: 30_000 });
    report.checks.viewer = await frame.evaluate(() => ({ pages: PDFViewerApplication.pdfDocument.numPages, canvas: document.querySelector(".page canvas").width, worker: !!PDFViewerApplication.pdfLoadingTask?._worker?.port }));
    if (windowsMemory) {
      assert.ok(report.checks.viewer.canvas > 0, "page rendered while every disk cache write was blocked");
      assert.equal([...files.keys()].some(key => key.endsWith("/.complete.json")), false);
      const resourceMetrics = await page.evaluate(() => fixtureLeaves[0].view.startupTimings.resources);
      assert.equal(resourceMetrics.bytesWritten, 0);
      assert.equal(resourceMetrics.verificationReads, 0);
      const fallbackType = await page.evaluate(async () => {
        const url = fixtureLeaves[0].view.mobileResourceLease.urls.get("asset:web/wasm/openjpeg_nowasm_fallback.js");
        return typeof (await import(url)).default;
      });
      assert.equal(fallbackType, "function", "the verified JPEG2000 fallback remains importable before disk writes");
    }
    releaseBackground();
    // Editing is fail-closed until the host confirms source bytes and ordered
    // page references. Wait for that handshake before synthesizing input.
    await frame.waitForFunction(() => {
      const button = document.querySelector("#editorSquareButton");
      return button && !button.disabled;
    }, { timeout: 20_000 });
    await frame.click("#editorSquareButton");
    const position = await frame.$eval('.page[data-page-number="1"] .annotationEditorLayer', el => { const r = el.getBoundingClientRect(); return { x: r.x + 100, y: r.y + 180 }; });
    const iframeBox = await page.$eval("iframe", el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y }; });
    const iframeHeight = await page.$eval("iframe", el => el.getBoundingClientRect().height);
    assert.ok(position.y + 65 < iframeHeight, "Trusted pointer coordinates must be inside the visible iframe");
    await page.mouse.move(iframeBox.x + position.x, iframeBox.y + position.y); await page.mouse.down();
    await page.mouse.move(iframeBox.x + position.x + 90, iframeBox.y + position.y + 65, { steps: 10 }); await page.mouse.up();
    await page.waitForFunction(() => { const v = fixtureLeaves[0].view; return v.currentRevision > 0 && v.confirmedRevision === v.currentRevision && !v.saving; }, { timeout: 20_000 });
    const selectFixtureText=async()=>frame.evaluate(()=>{
      const spans=[...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')].filter(el=>el.firstChild?.nodeType===Node.TEXT_NODE);
      if(spans.length<2)throw Error('Fixture text layer is unavailable');
      const range=document.createRange();range.setStart(spans[0].firstChild,0);range.setEnd(spans[1].firstChild,spans[1].textContent.length);
      document.getSelection().removeAllRanges();document.getSelection().addRange(range);
      window.dispatchEvent(new PointerEvent('pointerup',{button:0,bubbles:true}));
    });
    for(const [mode,kind] of [[10,'Underline'],[9,'Highlight']]){
      await frame.evaluate(mode=>PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode}),mode);
      await selectFixtureText();
      await page.waitForFunction(kind=>fixtureLeaves[0].view.annotationSnapshot?.annotations?.some(row=>row.kind===kind),{timeout:20_000},kind);
    }
    await frame.evaluate(()=>PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode:15}));
    await page.mouse.move(iframeBox.x+position.x+160,iframeBox.y+position.y+100);await page.mouse.down();
    await page.mouse.move(iframeBox.x+position.x+220,iframeBox.y+position.y+145,{steps:8});await page.mouse.up();
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>fixtureLeaves[0].view.annotationSnapshot?.annotations?.some(row=>row.kind==='Ink'),{timeout:20_000});
    await frame.evaluate(()=>PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode:3}));
    await page.mouse.click(iframeBox.x+position.x+100,iframeBox.y+position.y+200);
    await frame.waitForSelector('.freeTextEditor.selectedEditor .internal');
    await frame.type('.freeTextEditor.selectedEditor .internal','v15 browser text');await page.keyboard.press('Escape');
    await page.waitForFunction(()=>{
      const v=fixtureLeaves[0].view,rows=v.annotationSnapshot?.annotations||[];
      return ['Underline','Square','Highlight','Ink','FreeText'].every(kind=>rows.some(row=>row.kind===kind))&&v.confirmedRevision===v.currentRevision&&!v.saving;
    },{timeout:20_000});
    const expectedRows=await page.evaluate(()=>fixtureLeaves[0].view.annotationSnapshot.annotations.map(({uuid,kind,pageIndex,payload})=>({uuid,kind,pageIndex,payload})).sort((a,b)=>a.uuid.localeCompare(b.uuid)));
    assert.equal(expectedRows.length,5);assert.equal(new Set(expectedRows.map(row=>row.uuid)).size,5);
    const textEditor=expectedRows.find(row=>row.kind==='FreeText')?.payload?.editor;
    assert.equal(textEditor?.value,'v15 browser text');assert.ok(textEditor.rect[2]>textEditor.rect[0]&&textEditor.rect[3]>textEditor.rect[1]);
    assert.ok(annotationWrites > 0, "Annotation operations must be persisted to the external store");
    assert.equal(sourcePdfWrites, 1, "Only first-time pair metadata may modify the PDF");
    assert.deepEqual(files.get("sample.pdf").subarray(0, fixture.length), fixture, "Pairing must preserve the original PDF prefix");
    assert.match(await readPairId(files.get("sample.pdf")), /^[a-f0-9]{32}$/);
    const sourceAfter = files.get("sample.pdf");
    const sourceSha256After = createHash("sha256").update(sourceAfter).digest("hex");
    const sourceXxh64After = hashRuntime.fingerprint(sourceAfter);
    assert.notEqual(sourceSha256After, sourceSha256Before);
    assert.notEqual(sourceXxh64After, sourceXxh64Before);
    report.checks.saved = {
      annotationWrites,
      sourcePdfWrites,
      originalBytesPreserved: true,
      sourceSha256Before,
      sourceSha256After,
      sourceXxh64Before,
      sourceXxh64After,
    };
    report.checks.mobileLoader = await page.evaluate(() => ({...fixtureLeaves[0].view.mobileRuntime}));
    if (blockDirectScripts) { assert.equal(report.checks.mobileLoader.moduleSources.pdf, "blob"); assert.equal(report.checks.mobileLoader.moduleSources.viewer, "blob"); }
    await page.evaluate(async () => {
      window.fixtureClosedViews = [fixtureLeaves[0].view];
      const leaf = fixtureApp.workspace.getLeaf(true);
      await leaf.setViewState({ type: "pdf-web-reader-view", active: true, state: { file: "sample.pdf" } });
      window.fixtureReopenedLeaf = leaf;
      window.fixtureReopenedView = leaf.view;
      window.fixtureHostMessages = [];
      const originalPost = leaf.view.postToViewer.bind(leaf.view);
      leaf.view.postToViewer = (message, ...args) => {
        if (message?.type === "external-annotations-update" || message?.type === "annotation-source-mismatch") {
          window.fixtureHostMessages.push({ type: message.type, sourceMatch: message.sourceMatch, identityConfirmed: message.identityConfirmed, readOnly: message.readOnly, revision: message.externalAnnotations?.revision, annotations: message.externalAnnotations?.annotations?.length, pages: message.externalAnnotations?.annotations?.map(row => row.pageIndex) });
        }
        return originalPost(message, ...args);
      };
    });
    await page.waitForFunction(() => fixtureReopenedView?.ready, { timeout: 40_000 });
    await page.waitForFunction(() => {
      const child = fixtureReopenedView?.iframe?.contentWindow;
      return child?.PDFViewerApplication?.pdfDocument?.numPages === 14;
    }, { timeout: 30_000 });
    try {
      await page.waitForFunction(() => {
        const child = fixtureReopenedView?.iframe?.contentWindow;
        return child?.document?.querySelectorAll('.page[data-page-number="1"] .annotationEditorLayer [data-l10n-id="pdfjs-editor-square-editor"]').length > 0;
      }, { timeout: 8_000 });
      report.checks.externalEditorHydrated = true;
    } catch (error) {
      report.checks.externalEditorHydrated = false;
      report.checks.hydrationWaitError = error.message;
    }
    report.checks.reopened = await page.evaluate(() => {
      const child = fixtureReopenedView?.iframe?.contentWindow;
      return {
        square: child?.document?.querySelectorAll('.page[data-page-number="1"] .annotationEditorLayer [data-l10n-id="pdfjs-editor-square-editor"]').length ?? 0,
        pages: child?.PDFViewerApplication?.pdfDocument?.numPages ?? null,
        editorChildren: child?.document?.querySelector('.page[data-page-number="1"] .annotationEditorLayer')?.childElementCount ?? null,
        squareLabels: [...(child?.document?.querySelectorAll('.page[data-page-number="1"] .annotationEditorLayer [data-l10n-id="pdfjs-editor-square-editor"]') || [])].map(el => el.getAttribute('aria-label')),
      };
    });
    report.checks.reopenedHost = await page.evaluate(() => ({
      snapshot: fixtureReopenedView?.annotationSnapshot ?? null,
      hydrationAllowed: fixtureReopenedView?.annotationHydrationAllowed,
      sourceMismatch: fixtureReopenedView?.annotationSourceMismatch,
      status: fixtureReopenedView?.lastStatusMessage,
      leaves: fixtureLeaves.length,
      pluginViews: fixturePlugin.views.size,
      viewId: fixtureReopenedView?.documentId,
      openRequest: fixtureReopenedView?.openRequest,
      filePath: fixtureReopenedView?.documentFile?.path,
      closedViewIds: fixtureClosedViews.map(view => ({ id: view.documentId, openRequest: view.openRequest, ready: view.ready })),
      sameAsClosedView: fixtureReopenedView === fixtureClosedViews[0],
    }));
    report.checks.protocol = await page.evaluate(() => fixtureProtocol);
    report.checks.hostMessages = await page.evaluate(() => fixtureHostMessages);
    assert.ok(report.checks.reopened.square >= 1, JSON.stringify(report.checks.reopened));
    const actualRows=await page.evaluate(()=>fixtureReopenedView.annotationSnapshot.annotations.map(({uuid,kind,pageIndex,payload})=>({uuid,kind,pageIndex,payload})).sort((a,b)=>a.uuid.localeCompare(b.uuid)));
    assert.deepEqual(actualRows,expectedRows,'All five annotation UUIDs and payloads must survive reopening');
    assert.equal(sourcePdfWrites, 1, "Reopening the paired PDF must not write it again");
    assert.equal(createHash("sha256").update(files.get("sample.pdf")).digest("hex"), sourceSha256After);
    assert.equal(hashRuntime.fingerprint(files.get("sample.pdf")), sourceXxh64After);
    const reopenedFrame=(await page.frames()).find(f=>f!==frame&&f.parentFrame()===page.mainFrame());
    assert.ok(reopenedFrame,'The reopened PDF must have its own Viewer frame');
    await reopenedFrame.evaluate(()=>PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode:0}));
    await reopenedFrame.click('.page[data-page-number="1"] .annotationEditorLayer [data-l10n-id="pdfjs-editor-square-editor"]');
    report.checks.deleteTarget=await reopenedFrame.evaluate(()=>({
      selected:[...document.querySelectorAll('.annotationEditorLayer .selectedEditor')].map(el=>({className:el.className,label:el.getAttribute('data-l10n-id')})),
      active:document.activeElement?.outerHTML?.slice(0,300),mode:PDFViewerApplication.pdfViewer.annotationEditorMode,
      point:(()=>{const el=document.querySelector('[data-l10n-id="pdfjs-editor-square-editor"]'),r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x+r.width/2,y:r.y+r.height/2,hit:hit?.outerHTML?.slice(0,300)}})()
    }));
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => {
      const view=fixtureReopenedView;
      return view.currentRevision>0&&view.confirmedRevision===view.currentRevision&&!view.saving&&
        (view.annotationSnapshot?.tombstones||[]).length>0;
    }, {timeout:20_000});
    const squareUuid=expectedRows.find(row=>row.kind==='Square').uuid;
    await reopenedFrame.waitForSelector('#pdfReaderBridgeUndoButton:not([disabled])');
    await reopenedFrame.click('#pdfReaderBridgeUndoButton');
    await page.waitForFunction(uuid=>{
      const v=fixtureReopenedView,s=v.annotationSnapshot;
      return v.currentRevision===v.confirmedRevision&&!v.saving&&s?.annotations?.some(row=>row.uuid===uuid)&&!s.tombstones?.some(row=>row.uuid===uuid);
    },{timeout:20_000},squareUuid);
    await reopenedFrame.waitForSelector('#pdfReaderBridgeRedoButton:not([disabled])');
    await reopenedFrame.click('#pdfReaderBridgeRedoButton');
    await page.waitForFunction(uuid=>{
      const v=fixtureReopenedView,s=v.annotationSnapshot;
      return v.currentRevision===v.confirmedRevision&&!v.saving&&!s?.annotations?.some(row=>row.uuid===uuid)&&s?.tombstones?.some(row=>row.uuid===uuid);
    },{timeout:20_000},squareUuid);
    await page.evaluate(async()=>{
      const leaf=fixtureApp.workspace.getLeaf(true);
      await leaf.setViewState({type:'pdf-web-reader-view',active:true,state:{file:'sample.pdf'}});
      window.fixtureDeletedReopen=leaf.view;
    });
    await page.waitForFunction(()=>fixtureDeletedReopen?.ready&&fixtureDeletedReopen.annotationHydrationAllowed,{timeout:40_000});
    const deletion=await page.evaluate(()=>({mismatch:fixtureDeletedReopen.annotationSourceMismatch,
      annotations:fixtureDeletedReopen.annotationSnapshot?.annotations?.length,
      tombstones:fixtureDeletedReopen.annotationSnapshot?.tombstones?.length}));
    assert.equal(deletion.mismatch,false,JSON.stringify(deletion));assert.equal(deletion.annotations,4,JSON.stringify(deletion));
    assert.equal(deletion.tombstones,1,JSON.stringify(deletion));assert.equal(sourcePdfWrites,1);
    await page.evaluate(async () => {
      fixtureClosedViews.push(fixtureReopenedView);
      fixtureClosedViews.push(fixtureDeletedReopen);
      await Promise.all([...new Set(fixtureClosedViews)].map(view => view.onClose()));
      fixturePlugin.onunload();
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
      annotationSnapshot: window.fixtureLeaves?.[0]?.view.annotationSnapshot ?? null,
      annotationHydrationAllowed: window.fixtureLeaves?.[0]?.view.annotationHydrationAllowed,
      deletedProbe: window.fixtureReopenedView ? { revision:window.fixtureReopenedView.currentRevision,
        confirmed:window.fixtureReopenedView.confirmedRevision,saving:window.fixtureReopenedView.saving,
        snapshot:window.fixtureReopenedView.annotationSnapshot,status:window.fixtureReopenedView.lastStatusMessage } : null,
      notices: window.notices || [],
      frameHeight: document.querySelector("iframe")?.getBoundingClientRect().height,
    })).catch(() => null);
  }
  finally {
    releaseBackground();
    report.cleanup = await cleanupBrowserTestResources({ browser, ownedPages: page ? [page] : [], server });
    if (report.cleanup.errors.length) { primaryError ||= new Error("Browser cleanup failed"); attachCleanupErrors(primaryError, report.cleanup); report.status = "failed"; }
    await mkdir(path.join(root, "tests/artifacts"), { recursive: true });
    await writeFile(path.join(root, `tests/artifacts/mobile-browser-startup-${Date.now()}.json`), JSON.stringify(report, null, 2) + "\n");
  }
  if (primaryError) throw primaryError;
});

}
