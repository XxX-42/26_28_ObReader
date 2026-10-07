import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Native acceptance test for a community release containing only main.js,
// manifest.json, and styles.css. It intentionally refuses to clean old cache
// data or overwrite existing vault files; use a fresh three-file installation.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "dist", "pdf-web-reader");
const vault = "D:\\Documents\\Obsidian\\测试插件";
const vaultId = "d9f81db5f3fef6ee";
const cli = "D:\\Applications\\Obsidian\\Obsidian.com";
const pluginId = "pdf-web-reader";
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const adapterRoot = path.join(root, "viewer-adapter");
const artifacts = path.join(root, "tests", "artifacts");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const testPdf = `PDF迁移测试/native-threefile-${stamp}.pdf`;
const resultPath = path.join(
  artifacts,
  `native-threefile-release-${stamp}.json`,
);
const screenshotPath = path.join(
  artifacts,
  `native-threefile-release-${stamp}.png`,
);
const releaseFiles = ["main.js", "manifest.json", "styles.css"];
const viewType = "pdf-web-reader-view";
const toolbarIds = [
  "editorUnderlineButton",
  "editorSquareButton",
  "editorHighlightButton",
  "editorInkButton",
  "editorFreeTextButton",
];
const corruptedAssetPath = "web/images/toolbarButton-editorSquare.svg";
const corruptionBytes = Buffer.from(
  `native-threefile-test-corruption:${stamp}`,
  "utf8",
);
const absolute = (relativePath) => path.join(vault, ...relativePath.split("/"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isWithin = (base, candidate) => {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
};

await mkdir(artifacts, { recursive: true });

const result = {
  startedAt: new Date().toISOString(),
  app: cli,
  appVaultId: vaultId,
  expectedVaultPath: vault,
  releaseDirectory: path.relative(root, releaseRoot),
  testPdf,
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
  timeoutMs = 45_000,
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

async function snapshot() {
  return evalJson(`JSON.stringify((() => {
    const leaves = [];
    app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (!view) return;
      leaves.push({
        id: leaf.id,
        type: view.getViewType?.() || null,
        path: view.requestedPath || view.file?.path || null,
        ready: view.ready ?? null,
        saving: view.saving ?? null,
        pending: !!view.pendingBytes,
      });
    });
    const plugin = app.plugins.plugins[${JSON.stringify(pluginId)}];
    return {
      vaultPath: app.vault.adapter.basePath,
      configDir: app.vault.configDir,
      visibility: document.visibilityState,
      hidden: document.hidden,
      enabled: app.plugins.enabledPlugins.has(${JSON.stringify(pluginId)}),
      version: plugin?.manifest?.version || null,
      leaves,
    };
  })())`);
}

async function registeredTestPdfPaths() {
  const paths = new Set(["PDF迁移测试/五工具测试.pdf", testPdf]);
  let entries;
  try {
    entries = await readdir(artifacts, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return paths;
    throw error;
  }
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^native-(?:obsidian-smoke|default-routing|threefile-release)-.+\.json$/.test(
        entry.name,
      )
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
        (/^PDF迁移测试\/native-\d+\.pdf$/.test(report.testPdf) ||
          /^PDF迁移测试\/native-threefile-\d+\.pdf$/.test(report.testPdf))
      ) {
        paths.add(report.testPdf);
      }
      if (Array.isArray(report.testFiles)) {
        if (typeof report.passed !== "boolean") continue;
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
      // An incomplete artifact must never grant permission to detach a leaf.
    }
  }
  return paths;
}

async function inspectReaderViews(allowedPaths) {
  const proof = await evalJson(`(async () => {
    const rows = [];
    app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view?.getViewType?.() === ${JSON.stringify(viewType)}) {
        rows.push({ leaf, view: leaf.view });
      }
    });
    const results = [];
    for (const { leaf, view } of rows) {
      const frame = view.iframe?.contentWindow;
      const pdfApp = frame?.PDFViewerApplication;
      const activeElement = frame?.document?.activeElement;
      const focusedEditable = !!activeElement && (
        activeElement.isContentEditable ||
        activeElement.matches?.('input,textarea,[contenteditable="true"]') ||
        !!activeElement.closest?.('[contenteditable="true"]')
      );
      const original = view.originalBytes;
      const originalBytes = original instanceof ArrayBuffer
        ? new Uint8Array(original)
        : ArrayBuffer.isView(original)
          ? new Uint8Array(original.buffer, original.byteOffset, original.byteLength)
          : null;
      const vaultBytes = new Uint8Array(await app.vault.readBinary(view.file));
      const bytesMatch = !!originalBytes && originalBytes.length === vaultBytes.length &&
        originalBytes.every((byte, index) => byte === vaultBytes[index]);
      results.push({
        leafId: leaf.id,
        path: view.requestedPath || view.file?.path || null,
        ready: !!view.ready,
        saving: !!view.saving,
        pendingBytes: !!view.pendingBytes,
        editorMode: pdfApp?.pdfViewer?.annotationEditorMode ?? null,
        hasChanges: typeof pdfApp?._hasChanges === 'function' ? !!pdfApp._hasChanges() : null,
        annotationStorageModified: !!pdfApp?._annotationStorageModified,
        structuralChanges: !!pdfApp?.pdfThumbnailViewer?.hasStructuralChanges?.(),
        saveInProgress: !!pdfApp?._saveInProgress,
        overwriteInProgress: !!pdfApp?._overwriteInProgress,
        focusedEditable,
        bytesMatch,
      });
    }
    return JSON.stringify(results);
  })()`);
  for (const view of proof) {
    assert.ok(
      allowedPaths.has(view.path),
      `Refusing to detach or disable around an unregistered Reader tab: ${view.path}`,
    );
    assert.equal(view.ready, true, `Reader is not ready: ${view.path}`);
    assert.equal(view.saving, false, `Reader is saving: ${view.path}`);
    assert.equal(
      view.pendingBytes,
      false,
      `Reader has pending bytes: ${view.path}`,
    );
    assert.equal(view.editorMode, 0, `Reader has an active tool: ${view.path}`);
    assert.equal(
      view.hasChanges,
      false,
      `Reader has unsaved edits: ${view.path}`,
    );
    assert.equal(
      view.annotationStorageModified,
      false,
      `Reader annotations are modified: ${view.path}`,
    );
    assert.equal(
      view.structuralChanges,
      false,
      `Reader has structural edits: ${view.path}`,
    );
    assert.equal(
      view.saveInProgress,
      false,
      `Reader save is in progress: ${view.path}`,
    );
    assert.equal(
      view.overwriteInProgress,
      false,
      `Reader overwrite is in progress: ${view.path}`,
    );
    assert.equal(
      view.focusedEditable,
      false,
      `Reader has focused editable text: ${view.path}`,
    );
    assert.equal(
      view.bytesMatch,
      true,
      `Vault bytes differ from the opened PDF: ${view.path}`,
    );
  }
  return proof;
}

async function detachExactSavedTestViews(
  proof,
  resultField = "detachedInitialReaderViews",
) {
  for (const view of proof) {
    const detached = runtime(`(() => {
      const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .find(candidate => candidate.id === ${JSON.stringify(view.leafId)} &&
          (candidate.view?.requestedPath || candidate.view?.file?.path) === ${JSON.stringify(view.path)});
      if (!leaf) return 'already-detached';
      if (typeof leaf.detach !== 'function') throw new Error('WorkspaceLeaf.detach is unavailable');
      leaf.detach();
      return 'detached';
    })()`);
    result.checks[resultField] ??= [];
    result.checks[resultField].push({
      ...view,
      outcome: detached,
    });
  }
  if (proof.length > 0) {
    await waitFor(
      "only previously saved test Reader views to detach",
      async () =>
        evalJson(
          `JSON.stringify(app.workspace.getLeavesOfType(${JSON.stringify(viewType)}).length)`,
        ),
      (count) => count === 0,
    );
  }
}

async function exactTopLevelFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const names = entries.map((entry) => entry.name).sort();
  assert.deepEqual(
    names,
    [...releaseFiles].sort(),
    `Expected a strict three-file release folder at ${directory}`,
  );
  for (const entry of entries) {
    assert.ok(
      entry.isFile(),
      `Unexpected non-file in three-file package: ${entry.name}`,
    );
    assert.ok(
      !entry.isSymbolicLink(),
      `Symlink in three-file package: ${entry.name}`,
    );
  }
}

async function compareReleaseDirectories(installedRoot) {
  await exactTopLevelFiles(releaseRoot);
  await exactTopLevelFiles(installedRoot);
  const hashes = {};
  for (const name of releaseFiles) {
    const [built, installed] = await Promise.all([
      readFile(path.join(releaseRoot, name)),
      readFile(path.join(installedRoot, name)),
    ]);
    assert.deepEqual(
      installed,
      built,
      `Installed ${name} does not match the local three-file release`,
    );
    hashes[name] = sha256(installed);
  }
  const mainSource = await readFile(
    path.join(installedRoot, "main.js"),
    "utf8",
  );
  assert.doesNotMatch(
    mainSource,
    /require\s*\(\s*["']\.\//,
    "The installed entry point must not depend on a sibling helper file",
  );
  const runtimeRequires = [
    ...mainSource.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(runtimeRequires)].sort(),
    ["node:crypto", "node:zlib", "obsidian"],
    "The three-file entry point may use only Obsidian and Node built-ins",
  );
  result.checks.threeFileInstall = {
    directory: installedRoot,
    topLevel: releaseFiles,
    sha256: hashes,
    runtimeRequires: [...new Set(runtimeRequires)].sort(),
  };
  return JSON.parse(
    await readFile(path.join(installedRoot, "manifest.json"), "utf8"),
  );
}

async function openPdf(relativePath) {
  const resultForOpen = await evalJson(`(async () => {
    const before = ${leafCountExpression()};
    await app.workspace.openLinkText(${JSON.stringify(relativePath)}, '', true);
    await new Promise(resolve => setTimeout(resolve, 100));
    const leaf = app.workspace.activeLeaf;
    let after = 0;
    app.workspace.iterateAllLeaves(() => { after++; });
    return JSON.stringify({
      before,
      after,
      viewType: leaf?.view?.getViewType?.() || null,
      path: leaf?.view?.requestedPath || leaf?.view?.file?.path || null,
      activeFile: app.workspace.getActiveFile()?.path || null,
    });
  })()`);
  assert.ok(
    resultForOpen.after >= resultForOpen.before &&
      resultForOpen.after <= resultForOpen.before + 1,
    "Opening the test PDF must not create extra leaves",
  );
  assert.equal(resultForOpen.viewType, viewType);
  assert.equal(resultForOpen.path, relativePath);
  assert.equal(resultForOpen.activeFile, relativePath);
  await waitFor(`Viewer readiness for ${relativePath}`, async () =>
    evalJson(`JSON.stringify(app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
        .some(leaf => leaf.view?.requestedPath === ${JSON.stringify(relativePath)} && leaf.view.ready))`),
  );
  return resultForOpen;
}

async function inspectActiveViewer(relativePath) {
  return evalJson(`JSON.stringify((() => {
    const leaf = app.workspace.getLeavesOfType(${JSON.stringify(viewType)})
      .find(candidate => candidate.view?.requestedPath === ${JSON.stringify(relativePath)});
    const view = leaf?.view;
    const frame = view?.iframe?.contentWindow;
    const pdfApp = frame?.PDFViewerApplication;
    const resourceUrls = frame?.performance?.getEntriesByType('resource')
      .map(entry => entry.name) || [];
    const cache = view?.assetCache || null;
    return {
      ready: !!view?.ready,
      path: view?.requestedPath || null,
      outerVisibility: document.visibilityState,
      frameVisibility: frame?.document?.visibilityState || null,
      cache,
      workerPort: pdfApp?.pdfLoadingTask?._worker?.port?.constructor?.name || null,
      toolbar: ${JSON.stringify(toolbarIds)}.map(id => ({
        id,
        present: !!frame?.document?.getElementById(id),
        disabled: frame?.document?.getElementById(id)?.disabled ?? null,
      })),
      resourceUrls,
      loadedPages: pdfApp?.pdfViewer?.pagesCount || 0,
      pageElements: frame?.document?.querySelectorAll('.page').length || 0,
      textSpans: frame?.document?.querySelectorAll('.textLayer span').length || 0,
      canvases: frame?.document?.querySelectorAll('.page canvas').length || 0,
    };
  })())`);
}

function safeVaultRelativePath(relativePath) {
  assert.equal(typeof relativePath, "string");
  assert.ok(relativePath.length > 0);
  assert.ok(!path.posix.isAbsolute(relativePath));
  assert.ok(!/^[A-Za-z]:/.test(relativePath));
  assert.ok(!relativePath.includes("\\"));
  assert.ok(!relativePath.includes("\0"));
  const segments = relativePath.split("/");
  assert.ok(
    segments.every((segment) => segment && segment !== "." && segment !== ".."),
  );
  return segments;
}

async function walkRegularFiles(directory, rootDirectory = directory) {
  const collected = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const metadata = await lstat(fullPath);
    assert.ok(
      !metadata.isSymbolicLink(),
      `Symlink in generated cache: ${fullPath}`,
    );
    if (entry.isDirectory()) {
      collected.push(...(await walkRegularFiles(fullPath, rootDirectory)));
    } else {
      assert.ok(
        entry.isFile(),
        `Unexpected filesystem object in generated cache: ${fullPath}`,
      );
      collected.push(
        path.relative(rootDirectory, fullPath).split(path.sep).join("/"),
      );
    }
  }
  return collected;
}

async function assertNoSymlinkPath(baseDirectory, targetPath) {
  const relative = path.relative(
    path.resolve(baseDirectory),
    path.resolve(targetPath),
  );
  assert.ok(
    relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".."),
    `Path escaped generated cache: ${targetPath}`,
  );
  let currentPath = path.resolve(baseDirectory);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const metadata = await lstat(currentPath);
    assert.ok(
      !metadata.isSymbolicLink(),
      `Symlink in generated cache path: ${currentPath}`,
    );
  }
}

async function expectedAssetManifest() {
  const vendorHashes = JSON.parse(
    await readFile(path.join(vendorRoot, "SHA256SUMS.json"), "utf8"),
  );
  const expected = new Map();
  for (const [relativePath, digest] of Object.entries(vendorHashes)) {
    const filePath = path.join(vendorRoot, ...relativePath.split("/"));
    const bytes = await readFile(filePath);
    assert.equal(
      sha256(bytes),
      digest,
      `Vendor hash manifest mismatch: ${relativePath}`,
    );
    expected.set(relativePath, {
      path: relativePath,
      size: bytes.byteLength,
      sha256: digest,
    });
  }
  for (const [sourceName, packagedName] of [
    ["obsidian-bridge.js", "web/obsidian-bridge.js"],
    ["bridge.css", "web/bridge.css"],
  ]) {
    const bytes = await readFile(path.join(adapterRoot, sourceName));
    expected.set(packagedName, {
      path: packagedName,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  assert.equal(
    expected.size,
    404,
    "Expected 402 vendor files plus bridge JS/CSS",
  );
  assert.ok(
    expected.has("LICENSE"),
    "Expected the PDF.js license in the cache",
  );
  assert.ok(expected.has("build/pdf.worker.mjs"));
  assert.ok(expected.has("web/viewer.html"));
  assert.ok(expected.has("web/viewer.mjs"));
  assert.ok(expected.has("web/viewer.css"));
  return expected;
}

async function validateExtractedAssets(cache, expected) {
  assert.ok(
    cache && typeof cache === "object",
    "Viewer must expose assetCache metadata",
  );
  const rootSegments = safeVaultRelativePath(cache.rootPath);
  const webSegments = safeVaultRelativePath(cache.webRoot);
  assert.match(cache.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(typeof cache.version, "string");
  assert.ok(cache.version.length > 0);
  assert.equal(rootSegments.at(-1), cache.contentHash);
  assert.equal(rootSegments.at(-2), cache.version);
  assert.deepEqual(webSegments, [...rootSegments, "web"]);

  const configDir = result.checks.preflight.configDir;
  const pluginRootRelative = `${configDir}/plugins/${pluginId}`.replaceAll(
    "\\",
    "/",
  );
  const expectedCachePrefix = `${pluginRootRelative}/.asset-cache/`;
  assert.ok(
    cache.rootPath.startsWith(expectedCachePrefix),
    `Cache must remain under the plugin's own cache root: ${cache.rootPath}`,
  );
  const cacheAbsolute = path.resolve(vault, ...rootSegments);
  const pluginRootAbsolute = path.resolve(
    vault,
    ...pluginRootRelative.split("/"),
  );
  assert.ok(
    isWithin(path.join(pluginRootAbsolute, ".asset-cache"), cacheAbsolute),
  );
  assert.ok(isWithin(vault, cacheAbsolute));

  const markerAbsolute = path.join(cacheAbsolute, ".complete.json");
  const marker = JSON.parse(await readFile(markerAbsolute, "utf8"));
  assert.equal(marker.schema, 1);
  assert.equal(marker.id, cache.version);
  assert.equal(marker.contentHash, cache.contentHash);
  assert.equal(marker.fileCount, expected.size);
  assert.ok(Array.isArray(marker.files));
  assert.equal(marker.files.length, expected.size);

  const listed = new Map();
  for (const item of marker.files) {
    assert.equal(typeof item.path, "string");
    assert.ok(
      !listed.has(item.path),
      `Duplicate cache marker path: ${item.path}`,
    );
    safeVaultRelativePath(item.path);
    listed.set(item.path, item);
  }
  assert.deepEqual(
    [...listed.keys()].sort(),
    [...expected.keys()].sort(),
    "Cache marker must include the complete embedded runtime asset set",
  );

  const storedNames = await walkRegularFiles(cacheAbsolute);
  assert.deepEqual(
    [...storedNames].sort(),
    [...expected.keys(), ".complete.json"].sort(),
    "The cache must contain only the 404 packaged files and completion marker",
  );
  const actual = {};
  for (const [relativePath, expectedItem] of expected) {
    const filePath = path.join(cacheAbsolute, ...relativePath.split("/"));
    assert.ok(
      isWithin(cacheAbsolute, filePath),
      `Cache asset escaped root: ${relativePath}`,
    );
    const bytes = await readFile(filePath);
    const digest = sha256(bytes);
    assert.equal(
      bytes.byteLength,
      expectedItem.size,
      `Asset size mismatch: ${relativePath}`,
    );
    assert.equal(
      digest,
      expectedItem.sha256,
      `Asset hash mismatch: ${relativePath}`,
    );
    const markerItem = listed.get(relativePath);
    assert.deepEqual(
      markerItem,
      expectedItem,
      `Completion marker record mismatch: ${relativePath}`,
    );
    actual[relativePath] = digest;
  }

  return {
    rootPath: cache.rootPath,
    webRoot: cache.webRoot,
    version: cache.version,
    contentHash: cache.contentHash,
    fileCount: expected.size,
    marker: markerAbsolute,
    fileHashes: actual,
  };
}

async function captureScreenshotIfTestViewIsActive() {
  try {
    const activePath = runtime(
      "app.workspace.activeLeaf?.view?.requestedPath || app.workspace.activeLeaf?.view?.file?.path || null",
    );
    if (activePath !== testPdf) return null;
    const response = cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    assert.ok(response.data, "Obsidian CDP should provide a screenshot");
    await writeFile(screenshotPath, Buffer.from(response.data, "base64"), {
      flag: "wx",
    });
    return screenshotPath;
  } catch (error) {
    result.screenshotError = error.message;
    return null;
  }
}

let networkBlocked = false;
let pluginDisabledByTest = false;
let installedRoot = null;
let savedCorruptedAsset = null;
let savedCorruptedAssetPath = null;
let passed = false;
let failure = null;

try {
  const initial = await snapshot();
  assert.equal(
    path.resolve(initial.vaultPath),
    path.resolve(vault),
    "CLI must target only the explicit Obsidian test vault",
  );
  result.checks.preflight = {
    ...initial,
    releaseRoot,
  };
  assert.equal(
    initial.visibility,
    "visible",
    "Obsidian is hidden; refusing to create a test PDF until the target vault window is visible",
  );
  assert.equal(initial.hidden, false);
  assert.equal(initial.configDir, ".obsidian");
  assert.equal(
    initial.enabled,
    false,
    "The clean-install test must start disabled",
  );
  assert.equal(
    initial.version,
    null,
    "A disabled plugin should not be loaded yet",
  );
  result.obsidianVersion = invokeCli(["version"]);

  installedRoot = path.resolve(vault, initial.configDir, "plugins", pluginId);
  await assertNoSymlinkPath(vault, installedRoot);
  const releaseManifest = await compareReleaseDirectories(installedRoot);
  assert.equal(releaseManifest.id, pluginId);
  result.expectedPluginVersion = releaseManifest.version;

  const cacheRoot = path.join(installedRoot, ".asset-cache");
  assert.equal(
    await lstat(cacheRoot).then(
      () => true,
      (error) => error.code !== "ENOENT",
    ),
    false,
    "A clean three-file install must not already have extracted viewer assets",
  );
  const preexistingAssetDirs = (
    await readdir(installedRoot, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.deepEqual(
    preexistingAssetDirs,
    [],
    "The installed plugin must start with no unpacked Viewer directory",
  );

  const oldReaders = await inspectReaderViews(await registeredTestPdfPaths());
  result.checks.preexistingReaderViews = oldReaders;
  await detachExactSavedTestViews(oldReaders);

  const testPdfAbsolute = absolute(testPdf);
  const testPdfParent = path.dirname(testPdfAbsolute);
  const parentMetadata = await lstat(testPdfParent);
  assert.ok(
    parentMetadata.isDirectory(),
    "The known PDF migration test folder must exist",
  );
  assert.ok(
    !parentMetadata.isSymbolicLink(),
    "Refusing a symlinked test output folder",
  );
  await copyFile(fixture, testPdfAbsolute, constants.COPYFILE_EXCL);
  result.checks.testFixture = {
    path: testPdf,
    bytes: (await lstat(testPdfAbsolute)).size,
    sha256: sha256(await readFile(testPdfAbsolute)),
  };
  await waitFor(`Obsidian to index ${testPdf}`, async () =>
    evalJson(
      `JSON.stringify(!!app.vault.getAbstractFileByPath(${JSON.stringify(testPdf)}))`,
    ),
  );

  cdp("Network.enable");
  networkBlocked = true;
  cdp("Network.setBlockedURLs", {
    urls: ["http://*", "https://*", "ws://*", "wss://*"],
  });
  result.checks.network = {
    blockedPatterns: ["http://*", "https://*", "ws://*", "wss://*"],
    scope: "temporary CDP request blocking for this Obsidian renderer only",
  };

  invokeCli(["plugin:enable", `id=${pluginId}`], 60_000);
  await waitFor(
    "plugin enable",
    async () => await snapshot(),
    (state) => state.enabled && state.version === releaseManifest.version,
    60_000,
  );
  result.checks.pluginEnabled = true;

  const firstOpen = await openPdf(testPdf);
  result.checks.firstOpen = firstOpen;
  const firstViewer = await waitFor(
    "first native Viewer with its cache metadata and real Worker",
    async () => await inspectActiveViewer(testPdf),
    (state) =>
      state.ready &&
      state.outerVisibility === "visible" &&
      state.frameVisibility === "visible" &&
      state.cache &&
      state.workerPort === "Worker" &&
      state.loadedPages > 0 &&
      state.pageElements > 0 &&
      state.textSpans > 0 &&
      state.canvases > 0 &&
      state.toolbar.length === toolbarIds.length &&
      state.toolbar.every((button) => button.present && !button.disabled),
    60_000,
  );
  assert.equal(firstViewer.path, testPdf);
  assert.equal(
    firstViewer.workerPort,
    "Worker",
    "PDF.js must use a real bundled Worker",
  );
  assert.equal(firstViewer.toolbar.length, toolbarIds.length);
  for (const button of firstViewer.toolbar) {
    assert.equal(
      button.present,
      true,
      `Missing editor tool button: ${button.id}`,
    );
    assert.equal(
      button.disabled,
      false,
      `Editor tool is disabled: ${button.id}`,
    );
  }
  const externalUrls = firstViewer.resourceUrls.filter(
    (url) => !/^(?:app:|data:|blob:|about:)/i.test(url),
  );
  assert.deepEqual(
    externalUrls,
    [],
    `Viewer requested resources outside bundled/local schemes: ${externalUrls.join(", ")}`,
  );
  result.checks.firstViewer = {
    ready: firstViewer.ready,
    outerVisibility: firstViewer.outerVisibility,
    frameVisibility: firstViewer.frameVisibility,
    workerPort: firstViewer.workerPort,
    loadedPages: firstViewer.loadedPages,
    pageElements: firstViewer.pageElements,
    textSpans: firstViewer.textSpans,
    canvases: firstViewer.canvases,
    toolbar: firstViewer.toolbar,
    resourceUrls: firstViewer.resourceUrls,
    externalUrls,
  };

  const expectedAssets = await expectedAssetManifest();
  const firstCache = await validateExtractedAssets(
    firstViewer.cache,
    expectedAssets,
  );
  result.checks.firstExtraction = firstCache;

  const iconAbsolute = path.resolve(
    vault,
    ...safeVaultRelativePath(`${firstCache.rootPath}/${corruptedAssetPath}`),
  );
  assert.ok(isWithin(path.resolve(vault, firstCache.rootPath), iconAbsolute));
  assert.ok(isWithin(path.join(installedRoot, ".asset-cache"), iconAbsolute));
  const iconMetadata = await lstat(iconAbsolute);
  assert.ok(iconMetadata.isFile() && !iconMetadata.isSymbolicLink());
  await assertNoSymlinkPath(
    path.join(installedRoot, ".asset-cache"),
    iconAbsolute,
  );
  savedCorruptedAsset = await readFile(iconAbsolute);
  assert.equal(
    sha256(savedCorruptedAsset),
    expectedAssets.get(corruptedAssetPath).sha256,
  );
  savedCorruptedAssetPath = iconAbsolute;
  await writeFile(iconAbsolute, corruptionBytes);
  assert.equal(sha256(await readFile(iconAbsolute)), sha256(corruptionBytes));
  result.checks.cacheCorruption = {
    relativePath: `${firstCache.rootPath}/${corruptedAssetPath}`,
    expectedSha256: expectedAssets.get(corruptedAssetPath).sha256,
    sentinelSha256: sha256(corruptionBytes),
  };

  // Obsidian unload detaches this plugin's Reader leaves. Only proceed when
  // every current Reader leaf is an already-registered test PDF and byte-clean.
  const beforeDisable = await inspectReaderViews(
    await registeredTestPdfPaths(),
  );
  assert.equal(
    beforeDisable.length,
    1,
    "Only the single owned test Reader may be open",
  );
  assert.equal(beforeDisable[0].path, testPdf);
  result.checks.savedBeforeRepairReload = beforeDisable;
  pluginDisabledByTest = true;
  invokeCli(["plugin:disable", `id=${pluginId}`], 60_000);
  await waitFor(
    "plugin disable and Reader detach",
    async () => await snapshot(),
    (state) =>
      !state.enabled && !state.leaves.some((leaf) => leaf.type === viewType),
    60_000,
  );

  invokeCli(["plugin:enable", `id=${pluginId}`], 60_000);
  await waitFor(
    "plugin re-enable from the three-file installation",
    async () => await snapshot(),
    (state) => state.enabled && state.version === releaseManifest.version,
    60_000,
  );
  pluginDisabledByTest = false;

  const secondOpen = await openPdf(testPdf);
  result.checks.reopenAfterRepair = secondOpen;
  const repairedViewer = await waitFor(
    "Viewer reopen after cache corruption",
    async () => await inspectActiveViewer(testPdf),
    (state) =>
      state.ready &&
      state.outerVisibility === "visible" &&
      state.frameVisibility === "visible" &&
      state.cache &&
      state.workerPort === "Worker" &&
      state.loadedPages > 0 &&
      state.pageElements > 0 &&
      state.textSpans > 0 &&
      state.canvases > 0 &&
      state.toolbar.length === toolbarIds.length &&
      state.toolbar.every((button) => button.present && !button.disabled),
    60_000,
  );
  assert.equal(repairedViewer.workerPort, "Worker");
  const repairedCache = await validateExtractedAssets(
    repairedViewer.cache,
    expectedAssets,
  );
  assert.equal(repairedCache.rootPath, firstCache.rootPath);
  assert.equal(repairedCache.webRoot, firstCache.webRoot);
  assert.equal(repairedCache.version, firstCache.version);
  assert.equal(repairedCache.contentHash, firstCache.contentHash);
  assert.equal(
    sha256(await readFile(iconAbsolute)),
    expectedAssets.get(corruptedAssetPath).sha256,
    "A damaged cache asset must be restored from the embedded payload",
  );
  result.checks.cacheRepair = {
    rootPathStable: true,
    version: repairedCache.version,
    contentHash: repairedCache.contentHash,
    fileCount: expectedAssets.size,
    repairedAsset: corruptedAssetPath,
    repairedSha256: sha256(await readFile(iconAbsolute)),
  };

  // Validate the resource protocol after repair as well; the Viewer remains
  // local even after plugin lifecycle reload.
  const secondExternalUrls = repairedViewer.resourceUrls.filter(
    (url) => !/^(?:app:|data:|blob:|about:)/i.test(url),
  );
  assert.deepEqual(secondExternalUrls, []);
  result.checks.reloadedViewer = {
    outerVisibility: repairedViewer.outerVisibility,
    frameVisibility: repairedViewer.frameVisibility,
    workerPort: repairedViewer.workerPort,
    loadedPages: repairedViewer.loadedPages,
    pageElements: repairedViewer.pageElements,
    textSpans: repairedViewer.textSpans,
    canvases: repairedViewer.canvases,
    toolbar: repairedViewer.toolbar,
    resourceUrls: repairedViewer.resourceUrls,
    externalUrls: secondExternalUrls,
  };
  const finalState = await snapshot();
  assert.equal(finalState.enabled, true, "The plugin must be left enabled");
  await captureScreenshotIfTestViewIsActive();
  const finalReaderProof = await inspectReaderViews(
    await registeredTestPdfPaths(),
  );
  assert.equal(
    finalReaderProof.length,
    1,
    "Only the owned clean test Reader may remain open at the end",
  );
  assert.equal(finalReaderProof[0].path, testPdf);
  await detachExactSavedTestViews(finalReaderProof, "detachedFinalReaderView");
  result.final = await snapshot();
  assert.equal(
    result.final.leaves.some((leaf) => leaf.type === viewType),
    false,
    "The owned test Reader must be detached so later native checks are isolated",
  );
  passed = true;
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (savedCorruptedAsset && savedCorruptedAssetPath) {
    try {
      // Restore the exact original bytes saved from this test-owned cache file.
      // They were verified against the embedded source hash before corruption.
      await assertNoSymlinkPath(
        path.join(installedRoot, ".asset-cache"),
        savedCorruptedAssetPath,
      );
      await writeFile(savedCorruptedAssetPath, savedCorruptedAsset);
      result.cacheAssetRestoredInFinally = true;
    } catch (restoreError) {
      result.cacheAssetRestoreError = restoreError.message;
    }
  }
  if (pluginDisabledByTest) {
    try {
      invokeCli(["plugin:enable", `id=${pluginId}`], 60_000);
      result.reenabledAfterFailure = true;
    } catch (restoreError) {
      result.restorePluginError = restoreError.message;
    }
  }
  if (networkBlocked) {
    try {
      cdp("Network.setBlockedURLs", { urls: [] });
      cdp("Network.disable");
      result.networkBlockingRestored = true;
    } catch (restoreError) {
      result.networkBlockingRestoreError = restoreError.message;
    }
  }
  result.finishedAt = new Date().toISOString();
  result.status = passed ? "passed" : "failed";
  if (failure) result.error = failure.stack || String(failure);
  try {
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (artifactError) {
    if (failure) failure.artifactError = artifactError.message;
    else throw artifactError;
  }
}

console.log(`Native three-file release test passed: ${resultPath}`);
