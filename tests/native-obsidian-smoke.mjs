import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedPluginVersion = JSON.parse(
  await readFile(
    path.join(root, "dist", "pdf-web-reader", "manifest.json"),
    "utf8",
  ),
).version;
const vault = "D:\\Documents\\Obsidian\\测试插件";
const vaultId = "d9f81db5f3fef6ee";
const cli = "D:\\Applications\\Obsidian\\Obsidian.com";
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const artifacts = path.join(root, "tests", "artifacts");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const relativePath = `PDF迁移测试/native-${stamp}.pdf`;
const absolutePath = path.join(vault, ...relativePath.split("/"));
const screenshotPath = path.join(
  artifacts,
  `native-obsidian-smoke-${stamp}.png`,
);
const resultPath = path.join(artifacts, `native-obsidian-smoke-${stamp}.json`);
const escapedPath = JSON.stringify(relativePath);
const viewLookup = `app.workspace.getLeavesOfType('pdf-web-reader-view')
  .find(leaf => leaf.view?.requestedPath === ${escapedPath})?.view`;

await mkdir(artifacts, { recursive: true });
await mkdir(path.dirname(absolutePath), { recursive: true });
await copyFile(fixture, absolutePath, constants.COPYFILE_EXCL);

const result = {
  startedAt: new Date().toISOString(),
  app: "D:\\Applications\\Obsidian\\Obsidian.com",
  appVaultId: vaultId,
  expectedVaultPath: vault,
  testPdf: relativePath,
  screenshot: path.relative(root, screenshotPath),
  checks: {},
  saves: [],
};

function invokeCli(args, timeout = 20_000) {
  const processResult = spawnSync(cli, [`vault=${vaultId}`, ...args], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (processResult.error) throw processResult.error;
  if (processResult.status !== 0) {
    throw new Error(
      `Obsidian CLI failed (${processResult.status}): ${processResult.stderr || processResult.stdout}`,
    );
  }
  return processResult.stdout.trim();
}

function cdp(method, params = {}, timeout = 20_000) {
  const output = invokeCli(
    ["dev:cdp", `method=${method}`, `params=${JSON.stringify(params)}`],
    timeout,
  );
  if (!output) return {};
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(
      `Obsidian CDP did not return JSON for ${method}: ${output}`,
    );
  }
  return JSON.parse(output.slice(start, end + 1));
}

function runtime(expression, timeout = 30_000) {
  const response = cdp(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeout,
  );
  if (response.exceptionDetails) {
    throw new Error(
      `Obsidian Runtime.evaluate failed: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text || JSON.stringify(response.exceptionDetails)}`,
    );
  }
  return response.result?.value;
}

function evalJson(expression, timeout = 30_000) {
  const value = runtime(expression, timeout);
  if (typeof value !== "string") {
    throw new Error(
      `Expected a JSON string from Obsidian, got ${typeof value}: ${String(value)}`,
    );
  }
  return JSON.parse(value);
}

function cdpJson(method, params = {}, timeout = 20_000) {
  const response = cdp(method, params, timeout);
  if (response.exceptionDetails) {
    throw new Error(
      `${method} failed: ${JSON.stringify(response.exceptionDetails)}`,
    );
  }
  return response;
}

async function waitFor(
  description,
  probe,
  predicate = Boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await probe();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `Timed out waiting for ${description}; last value: ${JSON.stringify(latest)}`,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pressKey(key, code, virtualKeyCode, location = 0) {
  const common = {
    key,
    code,
    location,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode,
  };
  const keyDown = { type: "keyDown", ...common };
  if (key.length === 1 && !["`"].includes(key)) {
    keyDown.text = key;
    keyDown.unmodifiedText = key;
  }
  cdpJson("Input.dispatchKeyEvent", keyDown);
  cdpJson("Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function mouse(type, x, y, extra = {}) {
  cdpJson("Input.dispatchMouseEvent", { type, x, y, ...extra });
}

async function drag(x, y, dx, dy) {
  await mouse("mouseMoved", x, y);
  await mouse("mousePressed", x, y, {
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 8; step += 1) {
    await mouse("mouseMoved", x + (dx * step) / 8, y + (dy * step) / 8, {
      button: "left",
      buttons: 1,
    });
  }
  await mouse("mouseReleased", x + dx, y + dy, {
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

function modeExpression() {
  return `JSON.stringify(${viewLookup}?.iframe?.contentWindow?.PDFViewerApplication
    ?.pdfViewer?.annotationEditorMode ?? null)`;
}

async function activeViewer() {
  return evalJson(`JSON.stringify((() => {
    const view = ${viewLookup};
    const frame = view?.iframe?.contentWindow;
    const pdf = frame?.PDFViewerApplication?.pdfDocument;
    const editor = frame?.PDFViewerApplication?.pdfViewer;
    return {
      path: view?.requestedPath || null,
      ready: !!view?.ready,
      saving: !!view?.saving,
      pages: pdf?.numPages || 0,
      mode: editor?.annotationEditorMode ?? null,
      textSpans: frame?.document?.querySelectorAll('.textLayer span').length || 0,
      canvases: frame?.document?.querySelectorAll('.page canvas').length || 0,
      workerPort: frame?.PDFViewerApplication?.pdfLoadingTask?._worker?.port?.constructor?.name || null,
    };
  })())`);
}

async function annotationInfo() {
  return evalJson(`(async () => {
    const view = ${viewLookup};
    const pdf = view?.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument;
    if (!pdf) return '[]';
    const page = await pdf.getPage(1);
    const annotations = await page.getAnnotations();
    return JSON.stringify(annotations.map(annotation => ({
      subtype: annotation.subtype,
      id: annotation.id,
      color: annotation.color ? Object.values(annotation.color) : null,
      contents: annotation.contents || '',
    })));
  })()`);
}

async function editorTypes() {
  return evalJson(`JSON.stringify([...${viewLookup}.iframe.contentWindow.PDFViewerApplication
    .pdfDocument.annotationStorage.serializable.map.values()]
      .filter(item => !item.deleted)
      .map(item => item.annotationType)
      .sort((left, right) => left - right))`);
}

async function setEditorMode(mode) {
  runtime(`(() => {
    const view = ${viewLookup};
    const app = view.iframe.contentWindow.PDFViewerApplication;
    app.eventBus.dispatch('switchannotationeditormode', { mode });
    return true;
  })()`);
  await waitFor(
    `editor mode ${mode}`,
    async () => evalJson(modeExpression()),
    (value) => value === mode,
  );
}

async function keyShortcutChecks() {
  runtime(`(() => ${viewLookup}.iframe.contentWindow.focus())()`);
  const modes = [10, 5, 9, 15, 3];
  for (let index = 0; index < modes.length; index += 1) {
    const number = index + 1;
    const code = `Digit${number}`;
    await pressKey(String(number), code, 48 + number);
    await waitFor(
      `main-key ${number}`,
      async () => evalJson(modeExpression()),
      (value) => value === modes[index],
    );
    await pressKey(String(number), code, 48 + number);
    await waitFor(
      `repeat-key exit ${number}`,
      async () => evalJson(modeExpression()),
      (value) => value === 0,
    );
  }
  for (let index = 0; index < modes.length; index += 1) {
    const number = index + 1;
    await pressKey(String(number), `Numpad${number}`, 96 + number, 3);
    await waitFor(
      `numpad ${number}`,
      async () => evalJson(modeExpression()),
      (value) => value === modes[index],
    );
    await pressKey("`", "Backquote", 192);
    await waitFor(
      `backquote exit ${number}`,
      async () => evalJson(modeExpression()),
      (value) => value === 0,
    );
  }
  runtime(`(() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    const input = frame.document.createElement('input');
    frame.document.body.append(input);
    input.focus();
    frame.__nativeShortcutInput = input;
    return true;
  })()`);
  await pressKey("2", "Digit2", 50);
  const protectedMode =
    evalJson(`JSON.stringify(${viewLookup}.iframe.contentWindow
    .PDFViewerApplication.pdfViewer.annotationEditorMode)`);
  runtime(`(() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    frame.__nativeShortcutInput?.remove();
    delete frame.__nativeShortcutInput;
    return true;
  })()`);
  assert.equal(
    protectedMode,
    0,
    "Digits typed into an input must not switch tools",
  );
  result.checks.shortcuts = {
    mainKeys: true,
    numpad: true,
    repeatExit: true,
    backquoteExit: true,
    inputProtection: true,
  };
}

async function hostDocumentGuardCheck() {
  const probe = evalJson(`(async () => {
    const view = ${viewLookup};
    const frame = view.iframe.contentWindow;
    const viewerApp = frame.PDFViewerApplication;
    const openHookSource = viewerApp.open.toString();
    const runHookSource = viewerApp.run.toString();
    if (!openHookSource.includes('Open PDFs from the Obsidian file list.')) {
      throw new Error('The host-only app.open guard is not installed; refusing to probe an unguarded URL loader.');
    }
    if (!runHookSource.includes('viewer-init-failed')) {
      throw new Error('The host initialization diagnostic wrapper is not installed.');
    }
    const before = [viewerApp.pdfDocument.fingerprints?.join(':'), viewerApp.pdfDocument.numPages].join('/');
    const openResult = await viewerApp.open();
    const input = frame.document.querySelector('input[type="file"]');
    const change = new frame.Event('change', { bubbles: true, cancelable: true });
    input.dispatchEvent(change);
    const transfer = new frame.DataTransfer();
    transfer.items.add(new frame.File(['not a pdf'], 'blocked.pdf', { type: 'application/pdf' }));
    const dragover = new frame.DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer });
    const drop = new frame.DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    frame.document.dispatchEvent(dragover);
    frame.document.dispatchEvent(drop);
    await new Promise(resolve => setTimeout(resolve, 80));
    const after = [viewerApp.pdfDocument.fingerprints?.join(':'), viewerApp.pdfDocument.numPages].join('/');
    const currentPath = view.requestedPath;
    const statusText = frame.document.getElementById('pdfReaderBridgeStatus')?.textContent || '';
    return JSON.stringify({
      openResult, inputPrevented: change.defaultPrevented,
      dragoverPrevented: dragover.defaultPrevented,
      dropPrevented: drop.defaultPrevented,
      sameDocument: before === after,
      openHookInstalled: true,
      runHookInstalled: true,
      currentPath, statusText,
    });
  })()`);
  assert.equal(probe.openResult, false);
  assert.equal(probe.inputPrevented, true);
  assert.equal(probe.dragoverPrevented, true);
  assert.equal(probe.dropPrevented, true);
  assert.equal(probe.sameDocument, true);
  assert.equal(probe.currentPath, relativePath);
  assert.match(probe.statusText, /Open PDFs from the Obsidian file list/);
  result.checks.localOpenBlocked = true;
}

async function saveAndReopen(stage, expectedSubtypes) {
  const beforeBytes = await readFile(absolutePath);
  const beforeHash = sha256(beforeBytes);
  const beforeWrites = evalJson(
    "JSON.stringify(globalThis.__nativePdfWriteCount || 0)",
  );
  const toolbarBefore = evalJson(`JSON.stringify((() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    const toolbar = frame.document.getElementById('secondaryToolbar');
    const toggle = frame.document.getElementById('secondaryToolbarToggleButton');
    const frameRect = ${viewLookup}.iframe.getBoundingClientRect();
    const rect = toggle.getBoundingClientRect();
    return { hidden: toolbar.classList.contains('hidden'),
      x: frameRect.x + rect.x + rect.width / 2,
      y: frameRect.y + rect.y + rect.height / 2 };
  })())`);
  if (toolbarBefore.hidden) {
    await mouse("mouseMoved", toolbarBefore.x, toolbarBefore.y);
    await mouse("mousePressed", toolbarBefore.x, toolbarBefore.y, {
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await mouse("mouseReleased", toolbarBefore.x, toolbarBefore.y, {
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }
  await waitFor(`${stage} secondary toolbar`, async () =>
    evalJson(`JSON.stringify(
    !${viewLookup}.iframe.contentDocument.getElementById('secondaryToolbar')
      .classList.contains('hidden')
  )`),
  );
  const saveButton = evalJson(`JSON.stringify((() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    const toolbar = frame.document.getElementById('secondaryToolbar');
    const button = frame.document.getElementById('secondaryDownload');
    const status = frame.document.getElementById('pdfReaderBridgeStatus');
    const frameRect = ${viewLookup}.iframe.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    const label = {
      text: button.querySelector('span')?.textContent?.trim(),
      title: button.title,
      ariaLabel: button.getAttribute('aria-label'),
      localizationId: button.getAttribute('data-l10n-id'),
    };
    return { hidden: toolbar.classList.contains('hidden'), label,
      statusPointerEvents: status && getComputedStyle(status).pointerEvents,
      x: frameRect.x + rect.x + rect.width / 2,
      y: frameRect.y + rect.y + rect.height / 2 };
  })())`);
  assert.equal(
    saveButton.hidden,
    false,
    "Secondary save toolbar should be open",
  );
  assert.equal(saveButton.label.text, "保存到仓库");
  assert.equal(saveButton.label.title, "保存 PDF 到仓库（覆盖当前文件）");
  assert.equal(saveButton.label.ariaLabel, saveButton.label.title);
  assert.equal(saveButton.label.localizationId, null);
  assert.equal(saveButton.statusPointerEvents, "none");
  if (stage === "initial-five-tools") {
    cdpJson("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
    });
    cdpJson("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "s",
      code: "KeyS",
      text: "s",
      unmodifiedText: "s",
      modifiers: 2,
      windowsVirtualKeyCode: 83,
      nativeVirtualKeyCode: 83,
    });
    cdpJson("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "s",
      code: "KeyS",
      modifiers: 2,
      windowsVirtualKeyCode: 83,
      nativeVirtualKeyCode: 83,
    });
    cdpJson("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Control",
      code: "ControlLeft",
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
    });
  } else {
    await mouse("mouseMoved", saveButton.x, saveButton.y);
    await mouse("mousePressed", saveButton.x, saveButton.y, {
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await mouse("mouseReleased", saveButton.x, saveButton.y, {
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }
  await waitFor(
    `${stage} host save`,
    async () =>
      evalJson(`JSON.stringify({
    writes: globalThis.__nativePdfWriteCount || 0,
    saving: ${viewLookup}?.saving || false,
  })`),
    (value) => value.writes > beforeWrites && !value.saving,
    60_000,
  );
  if (stage === "initial-five-tools") {
    result.checks.controlSSave = true;
  }
  const savedBytes = await readFile(absolutePath);
  const savedHash = sha256(savedBytes);
  if (stage !== "repeat-save-without-edits") {
    assert.notEqual(
      savedHash,
      beforeHash,
      `${stage} should update the PDF bytes`,
    );
  }

  const reopened = evalJson(`(async () => {
    const view = ${viewLookup};
    const frame = view.iframe.contentWindow;
    frame.__nativeDocLoadCount ||= 0;
    if (!frame.__nativeDocLoadCounterInstalled) {
      frame.PDFViewerApplication.eventBus._on('documentloaded', () => frame.__nativeDocLoadCount++);
      frame.__nativeDocLoadCounterInstalled = true;
    }
    const oldCount = frame.__nativeDocLoadCount;
    await view.openFile(view.app.vault.getAbstractFileByPath(${escapedPath}));
    return JSON.stringify({ oldCount });
  })()`);
  await waitFor(
    `${stage} document reopen`,
    async () =>
      evalJson(`JSON.stringify({
    count: ${viewLookup}.iframe.contentWindow.__nativeDocLoadCount || 0,
    expected: ${reopened.oldCount + 1},
  })`),
    (value) => value.count >= value.expected,
    60_000,
  );
  const annotations = await annotationInfo();
  assert.deepEqual(
    annotations.map((annotation) => annotation.subtype).sort(),
    [...expectedSubtypes].sort(),
    `${stage} should reopen with the expected PDF annotation types`,
  );
  result.saves.push({
    stage,
    hostWrites: beforeWrites + 1,
    pdfSha256: savedHash,
    annotations,
  });
  return annotations;
}

async function captureNativeScreenshot() {
  const screenshot = cdpJson("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  assert.ok(screenshot.data, "Obsidian CDP should return a screenshot");
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

try {
  const appIdentity = evalJson(`JSON.stringify({
    vault: app.vault.adapter.basePath,
    name: app.vault.getName?.(),
    enabled: app.plugins.enabledPlugins.has('pdf-web-reader'),
    pluginVersion: app.plugins.plugins['pdf-web-reader']?.manifest?.version || null,
    testView: app.workspace.getLeavesOfType('pdf-web-reader-view').length,
    settingsOpen: !!app.setting?.isOpen,
  })`);
  assert.equal(
    path.resolve(appIdentity.vault),
    path.resolve(vault),
    "CLI must target only the outer test vault",
  );
  assert.equal(
    appIdentity.enabled,
    true,
    "PDF Web Reader must be enabled in the target vault",
  );
  result.checks.appIdentity = appIdentity;

  const fileMetadata = await stat(absolutePath);
  result.testPdfBytes = fileMetadata.size;
  await waitFor("Obsidian to register the unique test PDF", async () =>
    evalJson(
      `JSON.stringify(!!app.vault.getAbstractFileByPath(${escapedPath}))`,
    ),
  );
  await waitFor(
    "the host plugin instance after reload",
    async () =>
      evalJson(
        'JSON.stringify(app.plugins.plugins["pdf-web-reader"]?.manifest?.version || null)',
      ),
    (value) => value === expectedPluginVersion,
  );
  const opened = evalJson(`(async () => {
    const file = app.vault.getAbstractFileByPath(${escapedPath});
    if (!file) throw new Error('The unique test PDF is missing from the vault.');
    const settingsWasOpen = !!app.setting?.isOpen;
    if (settingsWasOpen) app.setting.close();
    const leaf = app.workspace.getLeaf(true);
    let beforeOpenLeafCount = 0;
    let leafWasAlreadyInWorkspace = false;
    app.workspace.iterateAllLeaves(candidate => {
      beforeOpenLeafCount++;
      if (candidate === leaf) leafWasAlreadyInWorkspace = true;
    });
    await leaf.openFile(file);
    if (leaf.view?.getViewType?.() !== 'pdf-web-reader-view') {
      throw new Error('WorkspaceLeaf.openFile did not route the PDF to the bundled viewer.');
    }
    if (app.workspace.getActiveFile()?.path !== file.path) {
      throw new Error('The default PDF view did not become Obsidian’s active file.');
    }
    const routedView = leaf.view;
    await app.workspace.openLinkText(file.path, '', false);
    await new Promise(resolve => setTimeout(resolve, 100));
    let afterRepeatLeafCount = 0;
    let leafStillInWorkspace = false;
    app.workspace.iterateAllLeaves(candidate => {
      afterRepeatLeafCount++;
      if (candidate === leaf) leafStillInWorkspace = true;
    });
    return JSON.stringify({ path: file.path, settingsWasOpen, settingsNowOpen: !!app.setting?.isOpen,
      viewType: leaf.view.getViewType(), activeFile: app.workspace.getActiveFile()?.path || null,
      leafId: leaf.id, leafWasAlreadyInWorkspace, leafStillInWorkspace,
      leavesBeforeOpen: beforeOpenLeafCount, leavesAfterRepeat: afterRepeatLeafCount,
      sameLeaf: leaf.view === routedView });
  })()`);
  assert.equal(opened.path, relativePath);
  assert.equal(opened.viewType, "pdf-web-reader-view");
  assert.equal(opened.activeFile, relativePath);
  assert.equal(opened.leafStillInWorkspace, true);
  assert.equal(opened.sameLeaf, true);
  assert.equal(
    opened.leavesAfterRepeat,
    opened.leavesBeforeOpen + (opened.leafWasAlreadyInWorkspace ? 0 : 1),
  );
  result.checks.defaultOpen = opened;
  result.checks.settingsClosedBeforeMouse = opened.settingsWasOpen
    ? !opened.settingsNowOpen
    : true;

  const initialState = await waitFor(
    "native Viewer ready with a real PDF worker",
    activeViewer,
    (state) =>
      state.ready &&
      state.path === relativePath &&
      state.pages > 0 &&
      state.textSpans > 0 &&
      state.canvases > 0,
    45_000,
  );
  assert.equal(
    initialState.workerPort,
    "Worker",
    "PDF.js should use a real bundled Worker",
  );
  result.checks.nativeViewer = initialState;
  await hostDocumentGuardCheck();

  runtime(`(() => {
    if (globalThis.__nativePdfWriteOriginal) return true;
    globalThis.__nativePdfWriteOriginal = app.vault.modifyBinary;
    globalThis.__nativePdfWriteCount = 0;
    app.vault.modifyBinary = async function(file, data) {
      globalThis.__nativePdfWriteCount += 1;
      return globalThis.__nativePdfWriteOriginal.call(this, file, data);
    };
    return true;
  })()`);

  await keyShortcutChecks();
  runtime(`(() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    frame.document.getElementById('viewerContainer').scrollTop = 0;
    return true;
  })()`);
  await waitFor(
    "first PDF page to enter the viewport",
    async () =>
      evalJson(`JSON.stringify((() => {
    const frame = ${viewLookup}.iframe;
    const page = frame.contentDocument.querySelector('.page[data-page-number="1"]');
    const rect = page?.getBoundingClientRect();
    return rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      frameHeight: frame.getBoundingClientRect().height };
  })())`),
    (value) =>
      value && value.y < value.frameHeight && value.y + value.height > 0,
  );
  const pageGeometry = evalJson(`JSON.stringify((() => {
    const frame = ${viewLookup}.iframe;
    const frameRect = frame.getBoundingClientRect();
    const page = frame.contentDocument.querySelector('.page[data-page-number="1"]');
    if (!page) throw new Error('First page is missing from the Viewer.');
    const rect = page.getBoundingClientRect();
    return { x: frameRect.x + rect.x, y: frameRect.y + rect.y, width: rect.width, height: rect.height };
  })())`);
  assert.ok(
    pageGeometry.width > 300 && pageGeometry.height > 300,
    "First PDF page should be visible",
  );

  await pressKey("1", "Digit1", 49);
  await waitFor(
    "Underline tool activation",
    async () => evalJson(modeExpression()),
    (mode) => mode === 10,
  );
  runtime(`(() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    const spans = [...frame.document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
      .filter(element => element.firstChild?.nodeType === 3);
    if (spans.length < 2) throw new Error('First page does not have selectable text.');
    const selection = frame.document.getSelection();
    const range = frame.document.createRange();
    range.setStart(spans[0].firstChild, 0);
    range.setEnd(spans[1].firstChild, spans[1].textContent.length);
    selection.removeAllRanges();
    selection.addRange(range);
    frame.dispatchEvent(new frame.PointerEvent('pointerup', { button: 0, bubbles: true }));
    return true;
  })()`);
  await waitFor("native Underline creation", editorTypes, (values) =>
    values.includes(10),
  );

  await pressKey("2", "Digit2", 50);
  await waitFor(
    "Square tool activation",
    async () => evalJson(modeExpression()),
    (mode) => mode === 5,
  );
  await drag(pageGeometry.x + 100, pageGeometry.y + 150, 110, 75);
  await waitFor("native Square creation", editorTypes, (values) =>
    values.includes(5),
  );

  await pressKey("3", "Digit3", 51);
  await waitFor(
    "Highlight tool activation",
    async () => evalJson(modeExpression()),
    (mode) => mode === 9,
  );
  runtime(`(() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    const spans = [...frame.document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
      .filter(element => element.firstChild?.nodeType === 3);
    const range = frame.document.createRange();
    range.setStart(spans[1].firstChild, 0);
    range.setEnd(spans[2].firstChild, spans[2].textContent.length);
    frame.document.getSelection().removeAllRanges();
    frame.document.getSelection().addRange(range);
    frame.dispatchEvent(new frame.PointerEvent('pointerup', { button: 0, bubbles: true }));
    return true;
  })()`);
  await waitFor("native Highlight creation", editorTypes, (values) =>
    values.includes(9),
  );

  await pressKey("Escape", "Escape", 27);
  runtime(`(() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    frame.document.getSelection().removeAllRanges();
    frame.document.activeElement?.blur();
    return true;
  })()`);
  await pressKey("4", "Digit4", 52);
  await waitFor(
    "Ink tool activation",
    async () => evalJson(modeExpression()),
    (mode) => mode === 15,
  );
  const inkToolbar = evalJson(`JSON.stringify((() => {
    const frame = ${viewLookup}.iframe.contentDocument;
    const toolbar = frame.getElementById('editorInkParamsToolbar');
    return { mode: ${viewLookup}.iframe.contentWindow.PDFViewerApplication.pdfViewer.annotationEditorMode,
      paramsHidden: toolbar?.classList.contains('hidden') };
  })())`);
  assert.equal(inkToolbar.mode, 15);
  assert.equal(
    inkToolbar.paramsHidden,
    true,
    "A keyboard shortcut must not expand tool parameters",
  );
  await drag(pageGeometry.x + 60, pageGeometry.y + 70, 75, 55);
  await pressKey("5", "Digit5", 53);
  await waitFor("native Ink creation", editorTypes, (values) =>
    values.includes(15),
  );

  await waitFor(
    "FreeText tool activation",
    async () => evalJson(modeExpression()),
    (mode) => mode === 3,
  );
  await mouse("mouseMoved", pageGeometry.x + 230, pageGeometry.y + 355);
  await mouse("mousePressed", pageGeometry.x + 230, pageGeometry.y + 355, {
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await mouse("mouseReleased", pageGeometry.x + 230, pageGeometry.y + 355, {
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await waitFor("FreeText input", async () =>
    evalJson(`JSON.stringify(!!${viewLookup}.iframe.contentDocument
    .querySelector('.freeTextEditor.selectedEditor .internal'))`),
  );
  runtime(`(() => ${viewLookup}.iframe.contentDocument
    .querySelector('.freeTextEditor.selectedEditor .internal').focus())()`);
  cdpJson("Input.insertText", { text: "Obsidian native smoke" });
  await pressKey("Escape", "Escape", 27);
  await waitFor("native FreeText creation", editorTypes, (values) =>
    values.includes(3),
  );

  const createdTypes = await editorTypes();
  assert.deepEqual(createdTypes, [3, 5, 9, 10, 15]);
  result.checks.createdEditorTypes = createdTypes;
  await captureNativeScreenshot();

  const expectedFive = ["FreeText", "Highlight", "Ink", "Square", "Underline"];
  await saveAndReopen("initial-five-tools", expectedFive);
  await saveAndReopen("repeat-save-without-edits", expectedFive);

  runtime(`(() => ${viewLookup}.iframe.contentWindow.PDFViewerApplication.eventBus
    .dispatch('switchannotationeditormode', { mode: 5 }))()`);
  await waitFor(
    "reopened editable annotation layer",
    async () =>
      evalJson(`JSON.stringify(
    ${viewLookup}.iframe.contentDocument.querySelectorAll('.inkEditor').length
  )`),
    (count) => count >= 3,
  );
  runtime(`(() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    const storage = frame.PDFViewerApplication.pdfDocument.annotationStorage;
    const square = [...frame.document.querySelectorAll('.inkEditor')]
      .map(element => storage.getRawValue(element.id))
      .find(editor => editor?.constructor?._editorType === 5);
    if (!square) throw new Error('Reopened Square editor is not editable.');
    square._uiManager.setSelected(square);
    const color = frame.document.getElementById('editorSquareColor');
    color.value = '#ff0000';
    color.dispatchEvent(new frame.Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor("Square color change in editor storage", async () =>
    evalJson(`JSON.stringify(
    [...${viewLookup}.iframe.contentWindow.PDFViewerApplication.pdfDocument.annotationStorage
      .serializable.map.values()].some(item => item.annotationType === 5 &&
        item.color?.[0] === 255 && item.color?.[1] === 0 && item.color?.[2] === 0)
  )`),
  );
  const afterColor = await saveAndReopen("square-color-change", expectedFive);
  const savedSquare = afterColor.find(
    (annotation) => annotation.subtype === "Square",
  );
  assert.deepEqual(savedSquare?.color, [255, 0, 0]);

  runtime(`(() => ${viewLookup}.iframe.contentWindow.PDFViewerApplication.eventBus
    .dispatch('switchannotationeditormode', { mode: 5 }))()`);
  await waitFor(
    "reopened editable annotations after color save",
    async () =>
      evalJson(`JSON.stringify(
    ${viewLookup}.iframe.contentDocument.querySelectorAll('.inkEditor').length
  )`),
    (count) => count >= 3,
  );
  const deletedUnderline = evalJson(`JSON.stringify((() => {
    const frame = ${viewLookup}.iframe.contentWindow;
    const storage = frame.PDFViewerApplication.pdfDocument.annotationStorage;
    const underline = [...frame.document.querySelectorAll('.inkEditor')]
      .map(element => storage.getRawValue(element.id))
      .find(editor => editor?.constructor?._editorType === 10);
    if (!underline) throw new Error('Reopened Underline editor is not editable.');
    const id = underline.id;
    underline._uiManager.deleteEditor(underline);
    return JSON.stringify({ id });
  })())`);
  result.checks.deletedUnderlineEditorId = deletedUnderline.id;
  await waitFor("Underline deletion", async () =>
    evalJson(`JSON.stringify(
    [...${viewLookup}.iframe.contentWindow.PDFViewerApplication.pdfDocument.annotationStorage
      .serializable.map.values()].some(item => item.deleted)
  )`),
  );
  const finalAnnotations = await saveAndReopen("delete-underline", [
    "FreeText",
    "Highlight",
    "Ink",
    "Square",
  ]);
  assert.equal(
    finalAnnotations.filter((annotation) => annotation.subtype === "Square")
      .length,
    1,
  );
  result.checks.colorRoundTrip = savedSquare.color;
  result.checks.underlineDeletionRoundTrip = true;
  result.checks.saveDestination = relativePath;

  const services =
    evalJson(`JSON.stringify(${viewLookup}.iframe.contentWindow.performance
    .getEntriesByType('resource').map(entry => entry.name)
    .filter(url => /^https?:/i.test(url) || url.includes('/api/')))`);
  assert.deepEqual(
    services,
    [],
    "Native embedded viewer should not use an external/API service",
  );
  result.checks.externalOrApiRequests = services;

  runtime(`(() => {
    if (globalThis.__nativePdfWriteOriginal) {
      app.vault.modifyBinary = globalThis.__nativePdfWriteOriginal;
      delete globalThis.__nativePdfWriteOriginal;
    }
    return true;
  })()`);
  result.status = "passed";
} catch (error) {
  result.status = "failed";
  result.error = error?.stack || String(error);
  try {
    await captureNativeScreenshot();
  } catch (screenshotError) {
    result.screenshotError = screenshotError.message;
  }
  throw error;
} finally {
  try {
    runtime(`(() => {
      if (globalThis.__nativePdfWriteOriginal) {
        app.vault.modifyBinary = globalThis.__nativePdfWriteOriginal;
        delete globalThis.__nativePdfWriteOriginal;
        delete globalThis.__nativePdfWriteCount;
      }
      return true;
    })()`);
  } catch (restoreError) {
    result.restoreError = restoreError.message;
  }
  result.finishedAt = new Date().toISOString();
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Native smoke result: ${result.status}`);
  console.log(`Test PDF: ${absolutePath}`);
  console.log(`Result: ${resultPath}`);
  console.log(`Screenshot: ${screenshotPath}`);
}
