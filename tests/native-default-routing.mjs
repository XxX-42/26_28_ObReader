import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const prefix = `PDF迁移测试/native-default-${stamp}`;
const enabledPdfPath = `${prefix}-enabled.pdf`;
const disabledPdfPath = `${prefix}-disabled.pdf`;
const reenabledPdfPath = `${prefix}-reenabled.pdf`;
const notePath = `${prefix}-note.md`;
const imagePath = `${prefix}-image.png`;
const screenshotPath = path.join(
  artifacts,
  `native-default-routing-${stamp}.png`,
);
const resultPath = path.join(artifacts, `native-default-routing-${stamp}.json`);
const absolute = (relativePath) => path.join(vault, ...relativePath.split("/"));

await mkdir(artifacts, { recursive: true });
await mkdir(path.dirname(absolute(enabledPdfPath)), { recursive: true });
for (const relativePath of [
  enabledPdfPath,
  disabledPdfPath,
  reenabledPdfPath,
]) {
  await copyFile(fixture, absolute(relativePath), constants.COPYFILE_EXCL);
}
await writeFile(
  absolute(notePath),
  `# Default PDF routing test\n\nEmbedded PDF: ![[${path.basename(enabledPdfPath)}]]\n`,
  { flag: "wx" },
);
await writeFile(
  absolute(imagePath),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=",
    "base64",
  ),
  { flag: "wx" },
);

const result = {
  startedAt: new Date().toISOString(),
  app: cli,
  appVaultId: vaultId,
  expectedVaultPath: vault,
  manifestVersion: expectedPluginVersion,
  testFiles: [
    enabledPdfPath,
    disabledPdfPath,
    reenabledPdfPath,
    notePath,
    imagePath,
  ],
  screenshot: path.relative(root, screenshotPath),
  checks: {},
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
      `Obsidian CDP returned invalid JSON for ${method}: ${output}`,
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
      `Expected JSON from Obsidian, got ${typeof value}: ${String(value)}`,
    );
  }
  return JSON.parse(value);
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

function leafCountExpression() {
  return "(() => { let count = 0; app.workspace.iterateAllLeaves(() => { count++; }); return count; })()";
}

async function openLink(relativePath, newLeaf) {
  const escapedPath = JSON.stringify(relativePath);
  return evalJson(`(async () => {
    const before = ${leafCountExpression()};
    const beforeLeafId = app.workspace.activeLeaf?.id || null;
    await app.workspace.openLinkText(${escapedPath}, '', ${newLeaf});
    await new Promise(resolve => setTimeout(resolve, 100));
    const leaf = app.workspace.activeLeaf;
    const after = ${leafCountExpression()};
    return JSON.stringify({
      before,
      after,
      beforeLeafId,
      leafId: leaf?.id || null,
      reusedActiveLeaf: leaf?.id === beforeLeafId,
      viewType: leaf?.view?.getViewType?.() || null,
      activePath: app.workspace.getActiveFile()?.path || null,
      viewPath: leaf?.view?.requestedPath || leaf?.view?.file?.path || null,
    });
  })()`);
}

async function snapshotPluginAndLeaves() {
  return evalJson(`JSON.stringify((() => {
    const leaves = [];
    app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      const pdfApp = view?.iframe?.contentWindow?.PDFViewerApplication;
      const activeElement = view?.iframe?.contentDocument?.activeElement;
      const focusedEditable = !!activeElement && (
        activeElement.isContentEditable ||
        activeElement.matches?.('input,textarea,[contenteditable="true"]') ||
        !!activeElement.closest?.('[contenteditable="true"]')
      );
      leaves.push({
        id: leaf.id,
        type: view?.getViewType?.() || null,
        path: view?.requestedPath || view?.file?.path || null,
        saving: view?.saving ?? false,
        ready: view?.ready ?? false,
        pending: !!view?.pendingBytes,
        editorMode: pdfApp?.pdfViewer?.annotationEditorMode ?? null,
        hasChanges: typeof pdfApp?._hasChanges === 'function'
          ? !!pdfApp._hasChanges()
          : null,
        annotationStorageModified: !!pdfApp?._annotationStorageModified,
        structuralChanges: !!pdfApp?.pdfThumbnailViewer?.hasStructuralChanges?.(),
        saveInProgress: !!pdfApp?._saveInProgress,
        overwriteInProgress: !!pdfApp?._overwriteInProgress,
        focusedEditable,
      });
    });
    return {
      enabled: app.plugins.enabledPlugins.has('pdf-web-reader'),
      version: app.plugins.plugins['pdf-web-reader']?.manifest?.version || null,
      activePath: app.workspace.getActiveFile()?.path || null,
      leaves,
    };
  })())`);
}

async function assertAllOpenReaderViewsAreSaved() {
  const allowedPaths = await registeredTestPdfPaths();
  allowedPaths.add("PDF迁移测试/五工具测试.pdf");
  for (const relativePath of result.testFiles.filter((item) =>
    item.endsWith(".pdf"),
  )) {
    allowedPaths.add(relativePath);
  }
  const proof = await evalJson(`(async () => {
    const rows = [];
    app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view?.getViewType?.() === 'pdf-web-reader-view') rows.push(leaf.view);
    });
    const results = [];
    for (const view of rows) {
      const frame = view.iframe?.contentWindow;
      const pdfApp = frame?.PDFViewerApplication;
      const activeElement = frame?.document?.activeElement;
      const focusedEditable = !!activeElement && (
        activeElement.isContentEditable ||
        activeElement.matches?.('input,textarea,[contenteditable="true"]') ||
        !!activeElement.closest?.('[contenteditable="true"]')
      );
      const hasChanges = typeof pdfApp?._hasChanges === 'function'
        ? !!pdfApp._hasChanges()
        : null;
      const vaultBytes = new Uint8Array(await app.vault.readBinary(view.file));
      const original = view.originalBytes;
      const bytesMatch = !!original && original.length === vaultBytes.length &&
        original.every((byte, index) => byte === vaultBytes[index]);
      results.push({
        path: view.requestedPath,
        saving: !!view.saving,
        ready: !!view.ready,
        editorMode: pdfApp?.pdfViewer?.annotationEditorMode ?? null,
        hasChanges,
        annotationStorageModified: !!pdfApp?._annotationStorageModified,
        structuralChanges: !!pdfApp?.pdfThumbnailViewer?.hasStructuralChanges?.(),
        saveInProgress: !!pdfApp?._saveInProgress,
        overwriteInProgress: !!pdfApp?._overwriteInProgress,
        focusedEditable,
        pendingBytes: !!view.pendingBytes,
        bytesMatch,
      });
    }
    return JSON.stringify(results);
  })()`);
  assert.ok(
    proof.length > 0,
    "A previously successful Viewer tab should remain open for safety verification",
  );
  for (const view of proof) {
    assert.ok(
      allowedPaths.has(view.path),
      `Refusing to detach a Reader tab not registered as this test's PDF: ${view.path}`,
    );
    assert.equal(view.saving, false, `Viewer is still saving: ${view.path}`);
    assert.equal(view.ready, true, `Viewer is not ready: ${view.path}`);
    assert.equal(
      view.editorMode,
      0,
      `Viewer has an active annotation tool: ${view.path}`,
    );
    assert.equal(
      view.hasChanges,
      false,
      `Viewer has unsaved edits: ${view.path}`,
    );
    assert.equal(
      view.annotationStorageModified,
      false,
      `Viewer annotation storage is dirty: ${view.path}`,
    );
    assert.equal(
      view.structuralChanges,
      false,
      `Viewer has structural PDF changes: ${view.path}`,
    );
    assert.equal(
      view.saveInProgress,
      false,
      `Viewer has a save in progress: ${view.path}`,
    );
    assert.equal(
      view.overwriteInProgress,
      false,
      `Viewer has an overwrite in progress: ${view.path}`,
    );
    assert.equal(
      view.focusedEditable,
      false,
      `Viewer has focused editable text: ${view.path}`,
    );
    assert.equal(
      view.pendingBytes,
      false,
      `Viewer has pending file bytes: ${view.path}`,
    );
    assert.equal(
      view.bytesMatch,
      true,
      `Saved bytes do not match vault file: ${view.path}`,
    );
  }
  return proof;
}

async function registeredTestPdfPaths() {
  const paths = new Set();
  for (const entry of await readdir(artifacts, { withFileTypes: true })) {
    if (
      !entry.isFile() ||
      !/^native-(?:obsidian-smoke|default-routing)-.+\.json$/.test(entry.name)
    ) {
      continue;
    }
    try {
      const report = JSON.parse(
        await readFile(path.join(artifacts, entry.name), "utf8"),
      );
      const belongsToVault =
        report.appVaultId === vaultId &&
        path.resolve(report.expectedVaultPath || "") === path.resolve(vault);
      if (!belongsToVault) continue;
      if (
        ["passed", "failed"].includes(report.status) &&
        typeof report.testPdf === "string" &&
        /^PDF迁移测试\/native-\d+\.pdf$/.test(report.testPdf)
      ) {
        paths.add(report.testPdf);
      }
      if (
        typeof report.passed === "boolean" &&
        Array.isArray(report.testFiles)
      ) {
        for (const item of report.testFiles) {
          if (
            typeof item === "string" &&
            /^PDF迁移测试\/native-default-\d+-(?:enabled|disabled|reenabled)\.pdf$/.test(
              item,
            )
          ) {
            paths.add(item);
          }
        }
      }
    } catch {
      // Only complete test reports grant permission to detach a Reader tab.
    }
  }
  return paths;
}

async function saveScreenshot() {
  const response = cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  assert.ok(response.data, "Obsidian CDP should provide a screenshot");
  await writeFile(screenshotPath, Buffer.from(response.data, "base64"), {
    flag: "wx",
  });
}

let didDisablePlugin = false;
let passed = false;
let failure = null;

try {
  const initial = await snapshotPluginAndLeaves();
  assert.equal(
    path.resolve(evalJson("JSON.stringify(app.vault.adapter.basePath)")),
    path.resolve(vault),
    "CLI must target only the outer test vault",
  );
  assert.equal(initial.enabled, true, "The target plugin must start enabled");
  assert.equal(initial.version, expectedPluginVersion);
  result.obsidianVersion = invokeCli(["version"]);
  result.initial = initial;

  for (const relativePath of result.testFiles) {
    await waitFor(`Obsidian to register ${relativePath}`, async () =>
      evalJson(
        `JSON.stringify(!!app.vault.getAbstractFileByPath(${JSON.stringify(relativePath)}))`,
      ),
    );
  }
  for (const relativePath of [
    enabledPdfPath,
    disabledPdfPath,
    reenabledPdfPath,
  ]) {
    result.fileSizes ??= {};
    result.fileSizes[relativePath] = (await stat(absolute(relativePath))).size;
  }

  const enabledOpen = await openLink(enabledPdfPath, true);
  assert.ok(
    enabledOpen.after >= enabledOpen.before &&
      enabledOpen.after <= enabledOpen.before + 1,
    "Ordinary PDF routing must not add more than the requested new leaf",
  );
  assert.equal(enabledOpen.viewType, "pdf-web-reader-view");
  assert.equal(enabledOpen.viewPath, enabledPdfPath);
  assert.equal(enabledOpen.activePath, enabledPdfPath);
  const readerLeafId = enabledOpen.leafId;
  result.checks.enabledOrdinaryOpen = {
    method: "workspace.openLinkText(newLeaf=true)",
    ...enabledOpen,
  };

  const sameFileOpen = await openLink(enabledPdfPath, false);
  assert.equal(sameFileOpen.after, enabledOpen.after);
  assert.equal(sameFileOpen.leafId, readerLeafId);
  assert.equal(sameFileOpen.reusedActiveLeaf, true);
  assert.equal(sameFileOpen.viewType, "pdf-web-reader-view");
  assert.equal(sameFileOpen.activePath, enabledPdfPath);
  result.checks.sameFileReusesLeaf = sameFileOpen;
  await waitFor("the enabled Viewer to initialize", async () =>
    evalJson(`JSON.stringify(app.workspace.getLeavesOfType('pdf-web-reader-view')
        .some(leaf => leaf.view?.requestedPath === ${JSON.stringify(enabledPdfPath)} && leaf.view.ready))`),
  );

  const noteOpen = await openLink(notePath, true);
  assert.ok(
    noteOpen.after >= noteOpen.before && noteOpen.after <= noteOpen.before + 1,
  );
  assert.equal(noteOpen.viewType, "markdown");
  assert.equal(noteOpen.activePath, notePath);
  const embeddedState = evalJson(`(async () => {
    const leaf = app.workspace.activeLeaf;
    await leaf.setViewState({ type: 'markdown', active: true,
      state: { file: ${JSON.stringify(notePath)}, embeddedPdfPath: ${JSON.stringify(enabledPdfPath)} } });
    return JSON.stringify({ type: leaf.view.getViewType(), active: app.workspace.getActiveFile()?.path || null });
  })()`);
  assert.equal(embeddedState.type, "markdown");
  assert.equal(embeddedState.active, notePath);
  const imageOpen = await openLink(imagePath, true);
  assert.ok(
    imageOpen.after >= imageOpen.before &&
      imageOpen.after <= imageOpen.before + 1,
  );
  assert.equal(imageOpen.viewType, "image");
  assert.equal(imageOpen.activePath, imagePath);
  result.checks.nonPdfAndEmbedded = {
    note: noteOpen.viewType,
    embeddedPdfState: embeddedState,
    image: imageOpen.viewType,
  };

  const savedReaderViews = await assertAllOpenReaderViewsAreSaved();
  result.checks.savedBeforeDisable = savedReaderViews;
  invokeCli(["plugin:disable", "id=pdf-web-reader"], 60_000);
  didDisablePlugin = true;
  await waitFor(
    "plugin disable",
    async () => (await snapshotPluginAndLeaves()).enabled,
    (enabled) => enabled === false,
  );
  const disabledOpen = await openLink(disabledPdfPath, true);
  assert.ok(
    disabledOpen.after >= disabledOpen.before &&
      disabledOpen.after <= disabledOpen.before + 1,
  );
  assert.equal(disabledOpen.viewType, "pdf");
  assert.equal(disabledOpen.viewPath, disabledPdfPath);
  assert.equal(disabledOpen.activePath, disabledPdfPath);
  result.checks.disabledUsesCoreViewer = disabledOpen;

  invokeCli(["plugin:enable", "id=pdf-web-reader"], 60_000);
  await waitFor(
    "plugin re-enable and reload",
    async () => await snapshotPluginAndLeaves(),
    (state) => state.enabled && state.version === expectedPluginVersion,
    60_000,
  );
  didDisablePlugin = false;
  const existingCore = evalJson(`JSON.stringify((() => {
    const leaf = [...(app.workspace.getLeavesOfType('pdf') || [])]
      .find(candidate => candidate.view?.file?.path === ${JSON.stringify(disabledPdfPath)});
    return { found: !!leaf, viewType: leaf?.view?.getViewType?.() || null };
  })())`);
  assert.equal(existingCore.found, true);
  assert.equal(
    existingCore.viewType,
    "pdf",
    "Re-enabling must not hijack an already-open core PDF tab",
  );
  result.checks.preexistingCoreViewRemainsCore = existingCore;

  const reenabledOpen = await openLink(reenabledPdfPath, true);
  assert.ok(
    reenabledOpen.after >= reenabledOpen.before &&
      reenabledOpen.after <= reenabledOpen.before + 1,
  );
  assert.equal(reenabledOpen.viewType, "pdf-web-reader-view");
  assert.equal(reenabledOpen.viewPath, reenabledPdfPath);
  assert.equal(reenabledOpen.activePath, reenabledPdfPath);
  await waitFor("the re-enabled Viewer to initialize", async () =>
    evalJson(`JSON.stringify(app.workspace.activeLeaf?.view?.ready || false)`),
  );
  result.checks.reenabledOrdinaryOpen = reenabledOpen;
  result.final = await snapshotPluginAndLeaves();
  assert.equal(result.final.enabled, true, "The plugin must be left enabled");
  await saveScreenshot();
  passed = true;
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (didDisablePlugin) {
    try {
      invokeCli(["plugin:enable", "id=pdf-web-reader"], 60_000);
      result.reenabledAfterFailure = true;
    } catch (restoreError) {
      result.restoreError = restoreError.message;
    }
  }
  result.finishedAt = new Date().toISOString();
  result.passed = passed;
  if (failure) result.error = failure.stack || failure.message;
  try {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (artifactError) {
    if (failure) {
      failure.artifactError = artifactError.message;
    } else {
      throw artifactError;
    }
  }
}

console.log(`Native default-routing test passed: ${resultPath}`);
