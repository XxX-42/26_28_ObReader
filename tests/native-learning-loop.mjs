import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import xxhash from "xxhash-wasm";
import {
  assertNativeLearningLoopAdapterEvidence,
  assertNativeLearningLoopInvariantUnchanged,
  createNativeLearningLoopIsolationPlan,
  serializeNativeLearningLoopIsolationInstaller,
  summarizeNativeLearningLoopInvariant,
} from "./native-learning-loop-isolation.mjs";
import { readNativeSidecarTree } from "./native-sidecar-isolation.mjs";
import { readNativeWalEvidence } from "./native-wal-evidence.mjs";
import { completeNativeControlledClose } from "./native-controlled-close.mjs";
import { assertNativeCandidateFiles, assertNativeLearningForeground, assertNativeResumeCandidate,
  resolveNativeOwnedProfileApp } from "./native-learning-acceptance.mjs";
import { installNativeSelectionProbe } from "./native-selection-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER_HEAD = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const RUNNER_BRANCH = execFileSync("git", ["branch", "--show-current"], { cwd: ROOT, encoding: "utf8" }).trim();
const NATIVE_RUNTIME_ROOT = "/private/tmp/obreader-014-runtime";
const NATIVE_SCRATCH_VAULT_ROOT = `${NATIVE_RUNTIME_ROOT}/native-loop-vaults`;
const scratchVaultMode = process.env.PDF_READER_NATIVE_SCRATCH_VAULT === "1";
const EXPECTED_VAULT = (() => {
  if (!scratchVaultMode) return "/Users/jiajia/Documents/ObReader-Apple-Test";
  const requested = process.env.PDF_READER_NATIVE_SCRATCH_VAULT_PATH;
  assert.ok(typeof requested === "string" && path.isAbsolute(requested),
    "Scratch-vault mode requires an explicit absolute PDF_READER_NATIVE_SCRATCH_VAULT_PATH");
  const resolved = path.resolve(requested);
  const relative = path.relative(NATIVE_SCRATCH_VAULT_ROOT, resolved);
  assert.ok(relative.startsWith("native-loop-b-") && !relative.includes(path.sep),
    `Refusing Native scratch vault outside ${NATIVE_SCRATCH_VAULT_ROOT}`);
  return resolved;
})();
const EXPECTED_VAULT_NAME = path.basename(EXPECTED_VAULT);
const OWNED_PROFILE_PARENT = "/Users/jiajia/.codex/worktrees/obreader-0.14/evidence";
const PLUGIN_ID = "pdf-web-reader";
const VIEW_TYPE = "pdf-web-reader-view";
const APP_URL = "app://obsidian.md/index.html";
const EXPECTED_PLUGIN_DIST = process.env.PDF_READER_NATIVE_PLUGIN_DIST || path.join(ROOT, "dist", PLUGIN_ID);
const FIXTURE_PDF = path.join(ROOT, "tests", "fixtures", "tracemonkey.pdf");
const MARKDOWN_EXCERPT = "This Markdown excerpt survives every route change.";
const HIGHLIGHT_TEXT = "Trace-based Just-in-Time Type Specialization";
const NATIVE_TEXT_LAYER_READY_TIMEOUT_MS = 60_000;
const CONTEXT_WORD = "Dynamic";
const boundedOpenMoveStage = process.argv.includes("--bounded-openmove-stage");
const attachedExistingTestVault = process.argv.includes("--attached-existing-test-vault") || boundedOpenMoveStage;
const processOnlyBoundOwnedProfile = process.argv.includes("--process-only-owned-profile");
assert.ok(!processOnlyBoundOwnedProfile || (scratchVaultMode && boundedOpenMoveStage),
  "Process-only mode is restricted to the bounded stage in a disposable scratch vault.");
const resumePath = process.env.PDF_READER_NATIVE_RESUME_AFTER_HIGHLIGHT;
assert.ok(!attachedExistingTestVault || !resumePath, "Attached mode requires a fresh unique run and must not mutate the preserved run.");
const resumeEvidence = resumePath ? JSON.parse(await readFile(resumePath, "utf8")) : null;
if (resumeEvidence) {
  assert.equal(resumeEvidence.cleanup?.status, "complete");
  assert.equal(resumeEvidence.cleanup?.isolationRestored, true);
  assert.equal(resumeEvidence.uiFlows?.[0]?.status, "passed");
  assert.ok(resumeEvidence.uiFlows[0].sourceEvidence?.navigation?.ok);
  assert.match(resumeEvidence.runId, /^native-learning-loop-[a-z0-9-]+$/u);
}
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/[-:.TZ]/g, "");
const runId = resumeEvidence?.runId || `native-learning-loop-${stamp}-${randomBytes(5).toString("hex")}`;
const fixturePrefix = `PDF迁移测试/${runId}`;
const reportPath = path.join(ROOT, "tests", "artifacts", `${runId}${resumeEvidence ? `-continued-${stamp}` : ""}.json`);
const reportTempPath = `${reportPath}.tmp`;
const screenshotDirectory = path.join(ROOT, "tests", "artifacts", `${runId}${resumeEvidence ? `-continued-${stamp}` : ""}`);
const report = {
  agent: "impl_b_native",
  workstream: "macOS Native learning-loop runner, store isolation, routes and bytes invariants",
  base: "65de915b306954a160ed99002f33ada639cebd4e",
  branch: RUNNER_BRANCH,
  runnerHead: RUNNER_HEAD,
  planA: "Install DataAdapter write isolation before enabling the plugin; execute actual UI workflows and route moves in one identity-checked owned Obsidian profile.",
  planB: "Exercise Highlight and LingQ Context creation through Viewer/Workbench UI; verify Today Source identity and the existing route scenarios. The restart scenario in this runner is a plugin reload, not an application-process restart.",
  startedAt: startedAt.toISOString(),
  runId,
  fixturePrefix,
  status: "running",
  nativeProfile: null,
  identity: null,
  sync: null,
  plugin: null,
  stores: null,
  uiFlows: [],
  routeScenarios: [],
  screenshots: [],
  errors: [],
  nativeAcceptance: { status: "NOT_VERIFIED", fullFiveDirectionMatrix: "NOT_RUN_BY_THIS_RUNNER",
    actualProcessRestart: "NOT_RUN_BY_THIS_RUNNER", foregroundPolicy: "external-cua-selection" },
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const absoluteVaultPath = (relative) => path.join(EXPECTED_VAULT, ...relative.split("/"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertFixturePath(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.startsWith(`${fixturePrefix}/`), `Refusing to change a non-fixture path: ${value}`);
  assert.ok(!value.includes("\\") && !value.split("/").some((part) => part === ".." || part === "."));
  return value;
}

async function waitFor(description, probe, predicate = Boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await probe();
    if (predicate(latest)) return latest;
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(latest)}`);
}

async function persistReport() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportTempPath, `${JSON.stringify(report, null, 2)}\n`);
  await rename(reportTempPath, reportPath);
}

async function checkpoint(label, evidence = {}) {
  report.lastStep = { label, at: new Date().toISOString(), ...evidence };
  await persistReport();
}

function verifyOwnedProfile() {
  assert.equal(process.platform, "darwin", "This test runner is macOS-only.");
  const requested = process.env.PDF_READER_NATIVE_PROFILE_ROOT;
  assert.ok(requested, "Set PDF_READER_NATIVE_PROFILE_ROOT to this run's owned Obsidian profile.");
  assert.ok(path.isAbsolute(requested));
  const resolved = path.resolve(requested);
  const standardProfile = resolved.startsWith(`${OWNED_PROFILE_PARENT}/macos-native-profile-`) &&
    !resolved.slice(`${OWNED_PROFILE_PARENT}/macos-native-profile-`.length).includes("/");
  const runtimeProfile = process.env.PDF_READER_NATIVE_ALLOW_RUNTIME_TEST_PROFILE === "1" &&
    resolved.startsWith("/private/tmp/obreader-014-runtime/profile-") &&
    !resolved.slice("/private/tmp/obreader-014-runtime/profile-".length).includes("/");
  assert.ok(standardProfile || runtimeProfile,
    `Refusing an unapproved Native profile: ${resolved}`);
  return resolved;
}

function assertNativeSessionUnlocked() {
  const probe = `import subprocess,plistlib,json
x=plistlib.loads(subprocess.check_output(["ioreg","-a","-n","Root","-d","1"]))
x=x if isinstance(x,dict) else x[0]
s=x.get("IOConsoleUsers",[])
print(json.dumps({"screenLocked":any(v.get("CGSSessionScreenIsLocked",False) for v in s),"onConsole":any(v.get("kCGSSessionOnConsoleKey",False) for v in s)}))`;
  const state = JSON.parse(execFileSync("python3", ["-c", probe], { encoding: "utf8" }));
  assert.equal(state.screenLocked, false, "Native UI acceptance stops while macOS is screen-locked; wait for the user to unlock.");
  assert.equal(state.onConsole, true, "Native UI acceptance requires an active console session.");
  return state;
}

async function initializeNativeConfig(profileRoot) {
  assertNativeSessionUnlocked();
  const canonicalProfile = await realpath(profileRoot);
  const marker = JSON.parse(await readFile(path.join(canonicalProfile, ".codex-native-profile.json"), "utf8"));
  assert.equal(marker.kind, "codex-owned-native-test-profile");
  assert.equal(marker.allowedVault, EXPECTED_VAULT);
  const appExecutable = resolveNativeOwnedProfileApp(canonicalProfile, marker, {
    allowRuntimeTestProfile: process.env.PDF_READER_NATIVE_ALLOW_RUNTIME_TEST_PROFILE === "1",
    allowScratchNativeVault: scratchVaultMode,
    expectedVault: EXPECTED_VAULT,
  });
  const appInfo = path.join(marker.appPath, "Contents", "Info.plist");
  assert.equal(execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", appInfo], { encoding: "utf8" }).trim(),
    "md.obsidian", "The owned process must use the Obsidian application bundle.");
  const appVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", appInfo], { encoding: "utf8" }).trim();
  if (marker.appPath === "/private/tmp/obreader-014-runtime/mnt/Obsidian.app") {
    assert.equal(appVersion, "1.14.5", "The explicitly allowed runtime test copy must remain on its verified Obsidian version.");
  }

  const [portText] = (await readFile(path.join(canonicalProfile, "DevToolsActivePort"), "utf8")).split(/\r?\n/u);
  const port = Number(portText);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65_536, "Owned profile has no valid DevTools port.");
  const processListing = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  const ownerLines = processListing.split(/\r?\n/u).filter((line) =>
    line.includes(appExecutable) && line.includes(`--user-data-dir=${canonicalProfile}`) &&
    (line.includes("--remote-debugging-port=0") || line.includes(`--remote-debugging-port=${port}`)));
  assert.equal(ownerLines.length, 1, "CDP must belong to exactly one Obsidian main process using this owned profile.");
  const ownerPid = Number(ownerLines[0].trim().split(/\s/u)[0]);
  if (processOnlyBoundOwnedProfile) {
    const requestedOwnerPid = Number(process.env.PDF_READER_NATIVE_EXPECT_OWNER_PID);
    assert.ok(Number.isSafeInteger(requestedOwnerPid) && requestedOwnerPid > 0,
      "Process-only mode requires PDF_READER_NATIVE_EXPECT_OWNER_PID.");
    assert.equal(ownerPid, requestedOwnerPid, "CDP owner PID must match the explicitly selected scratch process.");
  }

  process.env.OBSIDIAN_VAULT_PATH = EXPECTED_VAULT;
  process.env.OBSIDIAN_ACTIVE_VAULT = "1";
  process.env.OBSIDIAN_CONFIG_DIR = ".obsidian";
  process.env.PDF_READER_CDP_URL = `http://127.0.0.1:${port}`;
  const { nativeConfig, assertNativeVaultIdentity } = await import("./native-config.mjs");
  assert.equal(nativeConfig.vault, EXPECTED_VAULT);
  assert.equal(nativeConfig.configDir, ".obsidian");
  return { profileRoot: canonicalProfile, marker, appExecutable, appVersion, port, ownerPid,
    ownerCommandHash: sha256(Buffer.from(ownerLines[0].trim().replace(/^\d+\s+/u, ""))), nativeConfig, assertNativeVaultIdentity };
}

function ownedProcessForPid(pid, profileRoot, appExecutable, cdpPort) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(profileRoot) || typeof appExecutable !== "string") {
    return { pid, exists: false, ownedProfileProcess: false, commandHash: null };
  }
  let command = "";
  try { command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim(); }
  catch (error) {
    if (error?.status !== 1) throw error;
  }
  return {
    pid,
    exists: Boolean(command),
    ownedProfileProcess: Boolean(command && command.includes(appExecutable) &&
      command.includes(`--user-data-dir=${profileRoot}`) &&
      (command.includes("--remote-debugging-port=0") || command.includes(`--remote-debugging-port=${cdpPort}`))),
    commandHash: command ? sha256(Buffer.from(command)) : null,
  };
}

const profileRoot = verifyOwnedProfile();
const native = await initializeNativeConfig(profileRoot);
const { h64Raw } = await xxhash();
report.nativeProfile = { root: native.profileRoot, marker: native.marker, appExecutable: native.appExecutable,
  appVersion: native.appVersion, cdpPort: native.port, ownerPid: native.ownerPid,
  ownerCommandHash: native.ownerCommandHash,
  ownerProcessHash: sha256(Buffer.from(execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" }))),
  targetBinding: scratchVaultMode ? { kind: "single-owned-profile", vault: EXPECTED_VAULT,
    siblingProfileInspection: processOnlyBoundOwnedProfile ? "skipped; disposable scratch vault" : "required" } : null };
const expectedManifest = JSON.parse(await readFile(path.join(ROOT, "manifest.json"), "utf8"));
const settingsUiPreflight = process.argv.includes("--settings-ui-preflight");
const installedManifestPath = absoluteVaultPath(".obsidian/plugins/pdf-web-reader/manifest.json");
const installedManifest = JSON.parse(await readFile(installedManifestPath, "utf8"));
assert.equal(installedManifest.id, PLUGIN_ID);
assert.equal(installedManifest.version, expectedManifest.version,
  `Deploy the integration build ${expectedManifest.version} before Native learning-loop acceptance.`);

async function recordCandidateArtifact() {
  const candidate = {};
  const installed = {};
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    const [expectedBytes, installedBytes] = await Promise.all([
      readFile(path.join(EXPECTED_PLUGIN_DIST, file)),
      readFile(absoluteVaultPath(`.obsidian/plugins/${PLUGIN_ID}/${file}`)),
    ]);
    candidate[file] = { sha256: sha256(expectedBytes), bytes: expectedBytes.length };
    installed[file] = { sha256: sha256(installedBytes), bytes: installedBytes.length };
  }
  assertNativeCandidateFiles(candidate, installed);
  report.candidateArtifact = { directory: EXPECTED_PLUGIN_DIST, version: expectedManifest.version,
    files: candidate, installedFiles: installed };
  assertNativeCandidateFiles(candidate, installed);
}

let browser;
let page;
let settingsPage;
let isolationPlan;
let originalSettings;
let baseVocabularySnapshot;
let learningItems = {};
let contexts = {};
let adapterCalls = [];
let runtimeSettingsChanged = false;
const nativeMaintenanceState = { installed: false };

async function appIdentity() {
  return page.evaluate((pluginId, viewType) => {
    const plugin = app.plugins.plugins[pluginId];
    const views = app.workspace.getLeavesOfType(viewType).map((leaf) => ({
      path: leaf.view?.requestedPath || leaf.view?.file?.path || leaf.view?.documentFile?.path || null,
      token: leaf.view?.token || null,
    }));
    return {
      vault: app.vault?.adapter?.basePath || null,
      configDir: app.vault?.configDir || null,
      vaultName: app.vault?.getName?.() || null,
      pluginActive: Boolean(plugin),
      pluginVersion: plugin?.manifest?.version || null,
      enabledPlugins: [...(app.plugins?.enabledPlugins || [])],
      syncEnabled: app.internalPlugins?.plugins?.sync?.enabled ?? null,
      readerViews: views,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      ownerDocumentIsRenderer: typeof activeDocument !== "undefined" && activeDocument === document,
      ownerWindowIsRenderer: typeof activeWindow !== "undefined" && activeWindow === window,
    };
  }, PLUGIN_ID, VIEW_TYPE);
}

async function installNativeIsolation() {
  const storageRootAbsolute = absoluteVaultPath(`${native.nativeConfig.configDir}/plugins/pdf-web-reader/.native-learning-loop/${runId}`);
  try {
    await access(storageRootAbsolute);
    assert.ok(resumeEvidence, `Per-run sidecar storage already exists: ${storageRootAbsolute}`);
    assert.equal(resumeEvidence.fixturePrefix, fixturePrefix);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  isolationPlan = createNativeLearningLoopIsolationPlan({ runId, configDir: native.nativeConfig.configDir, fixturePrefix });
  const installer = serializeNativeLearningLoopIsolationInstaller(isolationPlan);
  const result = await page.evaluate((source) => (0, eval)(`(function(){${source}})()`), installer);
  assert.ok(result?.includes?.(runId),
    "Native sidecar isolation did not install in the verified renderer.");
  const installed = await page.evaluate(() => ({
    runId: window.__nativeLearningLoopIsolation?.runId || null,
    roots: window.__nativeLearningLoopIsolation?.roots || [],
    calls: window.__nativeLearningLoopIsolation?.calls?.length || 0,
  }));
  assert.equal(installed.runId, runId);
  assert.deepEqual(installed.roots, isolationPlan.roots);
  report.stores = { storageRoot: isolationPlan.storageRoot, roots: isolationPlan.roots,
    dictionaryRoot: isolationPlan.dictionaryRoot, installedBeforePluginEnable: true };
  await checkpoint("sidecar-isolation-installed", installed);
}

async function restoreOwnedStaleIsolation() {
  const stale = await page.evaluate(() => {
    const state = window.__nativeLearningLoopIsolation;
    if (!state) return null;
    return {
      runId: state.runId,
      storageRoot: state.storageRoot,
      roots: state.roots,
      callCount: state.calls?.length || 0,
      restorable: typeof state.restore === "function",
      vault: app.vault?.adapter?.basePath || null,
      syncEnabled: app.internalPlugins?.plugins?.sync?.enabled ?? null,
      pluginActive: Boolean(app.plugins.plugins["pdf-web-reader"]),
      pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
      readerViews: app.workspace.getLeavesOfType("pdf-web-reader-view").length,
    };
  });
  if (!stale) return;
  assert.match(stale.runId, /^native-learning-loop-[0-9]+-[a-f0-9]+$/u,
    "Only a previous per-run Native isolation wrapper may be restored.");
  assert.equal(stale.storageRoot,
    `${native.nativeConfig.configDir}/plugins/pdf-web-reader/.native-learning-loop/${stale.runId}`);
  assert.deepEqual(stale.roots, [
    { logicalRoot: "00_Archive/20_PDFData", physicalRoot: `${stale.storageRoot}/PDFData` },
    { logicalRoot: "00_Archive/21_VocabularyData", physicalRoot: `${stale.storageRoot}/VocabularyData` },
  ]);
  assert.equal(stale.vault, EXPECTED_VAULT);
  assert.equal(stale.syncEnabled, false);
  assert.equal(stale.pluginActive, false);
  assert.equal(stale.pluginEnabled, false);
  assert.equal(stale.readerViews, 0);
  assert.equal(stale.restorable, true);
  const restored = await page.evaluate(() => window.__nativeLearningLoopIsolation?.restore?.() === true);
  assert.equal(restored, true, "The old owned-profile adapter wrapper must restore its original methods.");
  assert.equal(await page.evaluate(() => Boolean(window.__nativeLearningLoopIsolation)), false);
  report.restoredPriorIsolation = { ...stale, restored: true };
  await checkpoint("prior-owned-isolation-restored", { runId: stale.runId, callCount: stale.callCount });
}

async function clearStaleNativeMaintenanceLogger() {
  const stale = await page.evaluate(() => {
    const state = window.__sidecarNative07;
    if (!state) return null;
    return {
      maintenanceCount: Array.isArray(state.maintenance) ? state.maintenance.length : null,
      navigationResultCount: Array.isArray(state.navigationResults) ? state.navigationResults.length : null,
      hasOriginalRecorder: typeof state.original === "function",
      vault: app.vault?.adapter?.basePath || null,
      syncEnabled: app.internalPlugins?.plugins?.sync?.enabled ?? null,
      pluginActive: Boolean(app.plugins.plugins["pdf-web-reader"]),
      pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
      readerViews: app.workspace.getLeavesOfType("pdf-web-reader-view").length,
    };
  });
  if (!stale) return;
  assert.equal(stale.vault, EXPECTED_VAULT);
  assert.equal(stale.syncEnabled, false);
  assert.equal(stale.pluginActive, false);
  assert.equal(stale.pluginEnabled, false);
  assert.equal(stale.readerViews, 0);
  assert.equal(stale.hasOriginalRecorder, true);
  const cleared = await page.evaluate(() => {
    delete window.__sidecarNative07;
    return !window.__sidecarNative07;
  });
  assert.equal(cleared, true, "Only the stale Native harness evidence hook should be removed.");
  report.restoredPriorMaintenanceLogger = { ...stale, cleared: true };
  await checkpoint("prior-owned-maintenance-hook-cleared", stale);
}

async function waitForPersistedPluginState(enabled, label) {
  let stableReads = 0;
  return waitFor(label, async () => {
    const ids = JSON.parse(await readFile(absoluteVaultPath(".obsidian/community-plugins.json"), "utf8"));
    stableReads = ids.includes(PLUGIN_ID) === enabled ? stableReads + 1 : 0;
    return { enabled: ids.includes(PLUGIN_ID), stableReads };
  }, state => state.stableReads >= 2);
}

async function enablePluginAfterIsolation() {
  const before = await page.evaluate((pluginId) => ({
    enabled: app.plugins.enabledPlugins.has(pluginId),
    pluginActive: Boolean(app.plugins.plugins[pluginId]),
    views: app.workspace.getLeavesOfType("pdf-web-reader-view").length,
  }), PLUGIN_ID);
  assert.equal(before.enabled, false, "Disable the plugin in the owned profile before the isolation install.");
  assert.equal(before.pluginActive, false);
  assert.equal(before.views, 0);
  await page.evaluate(async (pluginId) => {
    await app.plugins.enablePluginAndSave(pluginId); await app.plugins.saveConfig();
  }, PLUGIN_ID);
  const plugin = await waitFor("PDF Web Reader to load after isolation install", appIdentity,
    value => value.pluginActive && value.pluginVersion === expectedManifest.version);
  await waitForPersistedPluginState(true, "plugin enabled config stable twice");
  report.plugin = { ...plugin, enabledAfterIsolation: true };
  assert.equal(plugin.vault, EXPECTED_VAULT);
  assert.equal(plugin.configDir, ".obsidian");
  assert.equal(plugin.syncEnabled, false, "Obsidian Sync must stay disabled in the test vault.");
  assert.deepEqual(plugin.readerViews, []);
  report.installedFiles = {};
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    report.installedFiles[file] = sha256(await readFile(absoluteVaultPath(`.obsidian/plugins/${PLUGIN_ID}/${file}`)));
  }
  await checkpoint("plugin-enabled-after-isolation", { version: plugin.pluginVersion, installedFiles: report.installedFiles });

  originalSettings = await page.evaluate((pluginId) => {
    const instance = app.plugins.plugins[pluginId];
    return { autoSave: instance.settings.autoSave, vocabularyEnabled: instance.settings.vocabularyEnabled };
  }, PLUGIN_ID);
  await page.evaluate(async ({ pluginId }) => {
    const instance = app.plugins.plugins[pluginId];
    // Save behavior is exercised through the visible Reader control. LingQ is
    // enabled later through its visible toolbar toggle so the Viewer receives
    // the real read-mode transition before any word selection.
    instance.settings.autoSave = false;
  }, { pluginId: PLUGIN_ID });
  runtimeSettingsChanged = true;
  await installMaintenanceLogger();
}

async function installMaintenanceLogger() {
  const result = await page.evaluate((pluginId) => {
    const instance = app.plugins.plugins[pluginId];
    const record = instance.sessionLog?.record;
    if (typeof record !== "function") return { installed: false, reason: "annotation session log unavailable" };
    if (window.__sidecarNative07) throw new Error("Native maintenance logger already installed.");
    const state = { maintenance: [], navigationResults: [], copiedLinks: [], original: record };
    instance.sessionLog.record = function(kind, fields) {
      if (kind === "annotationStore" && ["annotation-snapshot-materialized", "annotation-snapshot-sync-pending",
          "annotation-snapshot-materialize-failed"].includes(fields?.event)) {
        state.maintenance.push({ ...fields, receivedAt: performance.now() });
      }
      if (kind === "readerAnchor" && fields?.event === "link-copied") state.copiedLinks.push({ ...fields });
      if (kind === "readerAnchor" && fields?.event === "navigation-result") {
        state.navigationResults.push({ ...fields, receivedAt: performance.now() });
      }
      return record.call(this, kind, fields);
    };
    window.__sidecarNative07 = state;
    return { installed: true };
  }, PLUGIN_ID);
  nativeMaintenanceState.installed = result.installed === true;
  report.nativeMaintenanceLogger = result;
}

async function recordScreen(name, target = page) {
  await mkdir(screenshotDirectory, { recursive: true });
  const screenshotPath = path.join(screenshotDirectory, `${name}.png`);
  await target.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
  report.screenshots.push(screenshotPath);
  await persistReport();
  return screenshotPath;
}

async function createFixtures() {
  const directory = absoluteVaultPath(fixturePrefix);
  try {
    await access(directory);
    assert.fail(`Unique fixture directory already exists: ${directory}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const pdfDirectory = `${fixturePrefix}/Reader Files`;
  const markdownDirectory = `${fixturePrefix}/Markdown Files`;
  await mkdir(absoluteVaultPath(pdfDirectory), { recursive: true });
  await mkdir(absoluteVaultPath(markdownDirectory), { recursive: true });
  const pdfPath = `${pdfDirectory}/reading.pdf`;
  const markdownPath = `${markdownDirectory}/learning.md`;
  await copyFile(FIXTURE_PDF, absoluteVaultPath(pdfPath), constants.COPYFILE_EXCL);
  await writeFile(absoluteVaultPath(markdownPath), `# Native learning route fixture\n\n${MARKDOWN_EXCERPT}\n`, { flag: "wx" });
  report.fixtures = {
    pdfPath,
    markdownPath,
    originalPdfSha256: sha256(await readFile(FIXTURE_PDF)),
    fixturePdfSha256: sha256(await readFile(absoluteVaultPath(pdfPath))),
    markdownExcerpt: MARKDOWN_EXCERPT,
    fixtureDirectory: directory,
  };
  assert.equal(report.fixtures.originalPdfSha256, report.fixtures.fixturePdfSha256,
    "Fixture copy must be byte-identical to the read-only source PDF.");
  await checkpoint("owned-fixtures-created");
  return { pdfPath, markdownPath, pdfDirectory, markdownDirectory };
}

async function openFixture(pathValue) {
  assertFixturePath(pathValue);
  await page.evaluate(async (targetPath) => {
    const file = app.vault.getAbstractFileByPath(targetPath);
    if (!file) throw new Error(`Owned test fixture does not exist: ${targetPath}`);
    await app.workspace.getLeaf(true).openFile(file);
  }, pathValue);
  return await waitFor(`Reader view for ${pathValue}`, async () => appIdentity(),
    state => state.readerViews.some(view => view.path === pathValue), 30_000);
}

async function readerFrame(pathValue) {
  const handle = await page.evaluateHandle((targetPath, pluginId) => {
    const plugin = app.plugins.plugins[pluginId];
    const view = [...(plugin?.views || [])].find(candidate =>
      candidate.requestedPath === targetPath || candidate.file?.path === targetPath || candidate.documentFile?.path === targetPath);
    return view?.iframe || null;
  }, pathValue, PLUGIN_ID);
  const element = handle.asElement();
  assert.ok(element, `No exact Reader iframe for ${pathValue}`);
  const frame = await element.contentFrame();
  assert.ok(frame, `Reader iframe did not attach for ${pathValue}`);
  return { element, frame };
}

async function readerFrameRect(pathValue) {
  return page.evaluate((targetPath, pluginId) => {
    const view = [...(app.plugins.plugins[pluginId]?.views || [])].find(candidate =>
      candidate.requestedPath === targetPath || candidate.file?.path === targetPath || candidate.documentFile?.path === targetPath);
    if (!view?.iframe) return null;
    const rect = view.iframe.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, pathValue, PLUGIN_ID);
}

async function selectTextByPointer({ frame, pathValue, text, mode, exact = true }) {
  const buttonId = mode === "highlight" ? "editorHighlightButton" : null;
  if (buttonId) {
    await frame.waitForSelector(`#${buttonId}`, { timeout: 15_000 });
    const activeMode = await frame.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode);
    if (activeMode !== 9) await frame.click(`#${buttonId}`);
    await frame.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 9, { timeout: 8_000 });
  }
  // TextLayer ranges keep nonzero geometry when the Reader restores a scroll
  // position below the title. Bring the actual drag target into the viewport
  // before measuring; otherwise the real pointer can land on the toolbar.
  await frame.evaluate(async text => {
    const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
      .find(node => node.textContent.includes(text));
    if (!span) throw new Error(`Could not find PDF.js textLayer text: ${text}`);
    span.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, text);
  const geometry = await frame.evaluate(({ text, exact }) => {
    const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')];
    const span = spans.find(node => exact ? node.textContent.includes(text) : node.textContent.includes(text));
    const node = span?.firstChild;
    if (node?.nodeType !== Node.TEXT_NODE) throw new Error(`Could not find PDF.js textLayer text: ${text}`);
    const start = node.textContent.indexOf(text);
    if (start < 0) throw new Error(`PDF.js textLayer did not contain ${text}`);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) throw new Error(`PDF text has no visible geometry: ${text}`);
    if (rect.left < 0 || rect.right + 1 >= innerWidth || rect.top < 0 || rect.bottom >= innerHeight) {
      throw new Error(`PDF text drag range is outside the Reader viewport: ${text}`);
    }
    const hit = document.elementFromPoint(rect.left + 0.25, rect.top + rect.height / 2);
    if (!hit?.closest(".textLayer")) throw new Error(`PDF text drag target is obscured: ${text}`);
    return { x1: rect.left + 0.25, x2: rect.right + 1, y: rect.top + rect.height / 2,
      text: node.textContent.slice(start, start + text.length), mode: PDFViewerApplication.pdfViewer.annotationEditorMode };
  }, { text, exact });
  const frameRect = await readerFrameRect(pathValue);
  assert.ok(frameRect && frameRect.width > 0 && frameRect.height > 0, "Owned Reader iframe must be visible.");
  await frame.evaluate(() => {
    window.__nativePointerTrace = [];
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel",
      "mousedown", "mousemove", "mouseup", "click"]) {
      document.addEventListener(type, event => {
        const target = event.target;
        const selection = document.getSelection();
        window.__nativePointerTrace.push({ type, target: target?.tagName || null,
          id: target?.id || null, className: typeof target?.className === "string" ? target.className : null,
          x: event.clientX, y: event.clientY, button: event.button, buttons: event.buttons,
          selection: selection?.toString?.() || "", rangeCount: selection?.rangeCount || 0,
          defaultPrevented: event.defaultPrevented, trusted: event.isTrusted });
      }, true);
      document.addEventListener("selectionchange", () => {
        const selection = document.getSelection();
        window.__nativePointerTrace.push({ type: "selectionchange",
          selection: selection?.toString?.() || "", rangeCount: selection?.rangeCount || 0,
          collapsed: selection?.isCollapsed ?? true });
      }, true);
    }
  });
  const selectionProbeInstalled = await frame.evaluate((source) => {
    const trace = window.__nativeSelectionTrace || { installers: [] };
    if (!trace.installers) trace.installers = [];
    const install = (0, eval)(`(${source})`);
    const cleanup = install({ d: document, w: window, a: PDFViewerApplication, trace, captureFixtureText: true });
    trace.installers.push(cleanup);
    window.__nativeSelectionTrace = trace;
    return trace.nativeSelectionProbe?.active === true;
  }, installNativeSelectionProbe.toString());
  assert.equal(selectionProbeInstalled, true, "Native selection probe must observe the actual PDF.js consumer path.");
  const activeEditorMode = await frame.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode);
  if (activeEditorMode === 9) {
    // Confirm the active tool's palette was actually mounted and shown before
    // moving away. The caller may already have entered Highlight mode, so
    // first hover its selected button instead of toggling the tool off.
    const palette = await frame.evaluate(() => {
      const toolbar = document.querySelector("#editorHighlightParamsToolbar");
      const button = document.querySelector("#editorHighlightButton");
      const toolbarRect = toolbar?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      if (!toolbarRect || !buttonRect) return null;
      return {
        left: toolbarRect.left, right: toolbarRect.right, top: toolbarRect.top,
        buttonX: buttonRect.left + buttonRect.width / 2,
        buttonY: buttonRect.top + buttonRect.height / 2,
      };
    });
    assert.ok(palette, "The PDF.js Highlight parameter palette must have geometry.");
    await page.mouse.move(frameRect.x + palette.buttonX, frameRect.y + palette.buttonY, { steps: 2 });
    await frame.waitForFunction(() => {
      const toolbar = document.querySelector("#editorHighlightParamsToolbar");
      return toolbar && !toolbar.classList.contains("hidden") &&
        !toolbar.classList.contains("editorParamsToolbarAutoHidden");
    }, { timeout: 5_000 });
    // Route above the palette first. A direct diagonal from the toolbar button
    // to the text can cross the popup, re-arm its hover timer, and put it over
    // the middle of the drag. The text origin lies left of this palette.
    const stagingY = Math.max(1, palette.top - 4);
    await page.mouse.move(frameRect.x + palette.buttonX, frameRect.y + stagingY, { steps: 3 });
    await page.mouse.move(frameRect.x + geometry.x1, frameRect.y + stagingY, { steps: 4 });
    // Pointerleave schedules PDF.js' one-second auto-hide. Wait for the actual
    // hidden state before starting the drag, then verify the selected mode.
    await frame.waitForFunction(() => {
      const toolbar = document.querySelector("#editorHighlightParamsToolbar");
      return !!toolbar && (toolbar.classList.contains("hidden") ||
        toolbar.classList.contains("editorParamsToolbarAutoHidden"));
    }, { timeout: 5_000 });
    const mode = await frame.evaluate(() => PDFViewerApplication.pdfViewer.annotationEditorMode);
    assert.equal(mode, 9, "PDF.js Highlight mode must remain active after its parameter palette auto-hides.");
    assert.ok(geometry.x1 < palette.left || geometry.x1 > palette.right,
      "The drag origin must remain outside the hidden Highlight palette bounds.");
    await page.mouse.move(frameRect.x + geometry.x1, frameRect.y + geometry.y, { steps: 2 });
  } else {
    await page.mouse.move(frameRect.x + geometry.x1, frameRect.y + geometry.y, { steps: 2 });
  }
  await frame.evaluate(({ x }) => { window.__nativeDragEndX = x; }, { x: geometry.x2 });
  const beforeDrag = await frame.evaluate(({ x, y }) => ({
    mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
    paramsClass: document.querySelector("#editorHighlightParamsToolbar")?.className || null,
    startTarget: document.elementFromPoint(x, y)?.closest(".textLayer")?.className || null,
    dragPathHitTests: Array.from({ length: 13 }, (_, index) => {
      const sampleX = x + (window.__nativeDragEndX - x) * index / 12;
      const hit = document.elementFromPoint(sampleX, y);
      return { x: sampleX, target: hit?.tagName || null,
        textLayerClass: hit?.closest(".textLayer")?.className || null,
        inTextLayer: Boolean(hit?.closest(".textLayer")) };
    }),
  }), { x: geometry.x1, y: geometry.y });
  await page.mouse.down({ button: "left" });
  await page.mouse.move(frameRect.x + geometry.x2, frameRect.y + geometry.y, { steps: 12 });
  await page.mouse.up({ button: "left" });
  const dragDiagnostics = await frame.evaluate(() => {
    const probe = window.__nativeSelectionTrace?.nativeSelectionProbe;
    const consumerRows = (probe?.consumers || []).map(row => ({
      mode: row.mode,
      before: row.before,
      after: row.after,
      editorCount: row.editorCount,
    }));
    const pointerRows = (probe?.pointerEvents || []).filter(row =>
      ["pointerdown", "pointerup"].includes(row.type) || row.buttons > 0);
    const selectionChanges = probe?.selectionChanges || [];
    const result = {
      events: window.__nativePointerTrace || [],
      selectionProbe: { consumers: consumerRows, pointerEvents: pointerRows, selectionChanges,
        eventPhaseCount: probe?.eventPhases?.length || 0 },
      selection: document.getSelection()?.toString() || "",
      mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
      activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      highlightEditorCount: document.querySelectorAll(".annotationEditorLayer .highlightEditor").length,
      editorLayerChildren: document.querySelector(".annotationEditorLayer")?.children.length || 0,
      paramsClass: document.querySelector("#editorHighlightParamsToolbar")?.className || null,
    };
    for (const cleanup of window.__nativeSelectionTrace?.installers || []) cleanup();
    if (window.__nativeSelectionTrace) window.__nativeSelectionTrace.installers = [];
    return result;
  });
  assert.ok(beforeDrag.dragPathHitTests.every(sample => sample.inTextLayer),
    "Every sampled point of the native drag must stay over the PDF text layer.");
  return { ...geometry, beforeDrag, dragDiagnostics };
}

async function saveAnnotationThroughReaderUI(frame, documentId) {
  // A selected PDF.js editor is still a draft. Deselect it through the normal
  // keyboard UI, then use the Reader's visible "Save annotations" control so
  // the real Viewer -> host WAL path produces the durable UUID.
  await page.keyboard.press("Escape");
  const deselected = await frame.evaluate(() => ({
    selectedEditorCount: document.querySelectorAll(".annotationEditorLayer .selectedEditor").length,
    highlightEditorCount: document.querySelectorAll(".annotationEditorLayer .highlightEditor").length,
    dirty: PDFViewerApplication._hasChanges(),
  }));
  assert.equal(deselected.selectedEditorCount, 0, "The real PDF.js Highlight editor must be finalized through Escape.");
  assert.ok(deselected.highlightEditorCount > 0, "The selected source range must have created a real Highlight editor.");
  assert.equal(deselected.dirty, true, "The new Highlight must remain pending until the user saves it.");
  await recordScreen("reader-highlight-ready-to-save");

  const toolbarHidden = await frame.$eval("#secondaryToolbar", node => node.classList.contains("hidden"));
  if (toolbarHidden) await frame.click("#secondaryToolbarToggleButton");
  await frame.waitForFunction(() => {
    const toolbar = document.querySelector("#secondaryToolbar");
    const save = document.querySelector("#secondaryDownload");
    return toolbar && !toolbar.classList.contains("hidden") && save && !save.disabled;
  }, { timeout: 10_000 });
  const saveControl = await frame.$eval("#secondaryDownload", node => ({
    text: node.querySelector("span")?.textContent?.trim() || "",
    title: node.title,
    disabled: node.disabled,
  }));
  assert.equal(saveControl.text, "保存批注", "Use the Reader's normal Save annotations UI.");
  assert.equal(saveControl.title, "保存批注到外置记录");
  assert.equal(saveControl.disabled, false);
  await recordScreen("reader-highlight-save-menu");
  await frame.click("#secondaryDownload");

  const saved = await waitFor("durable Highlight UUID after the visible Reader Save annotations action", async () =>
    page.evaluate(({ pluginId, documentId }) => {
      const view = [...app.plugins.plugins[pluginId].views].find(candidate => candidate.documentId === documentId);
      const row = (view?.annotationSnapshot?.annotations || []).find(candidate =>
        candidate.kind === "Highlight" && candidate.deleted !== true);
      return row ? { row, revision: view.currentRevision, confirmedRevision: view.confirmedRevision,
        pending: view.pendingSaves || 0,
        dirty: !!view.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.() } : null;
    }, { pluginId: PLUGIN_ID, documentId }),
  value => value?.row?.uuid && value.revision > 0 && value.revision === value.confirmedRevision &&
    value.pending === 0 && value.dirty === false, 20_000);
  await recordScreen("reader-highlight-saved");
  return { ...saved, saveControl };
}

async function readLearningItems() {
  return page.evaluate(async (pluginId) => {
    const plugin = app.plugins.plugins[pluginId];
    const service = await plugin.getLearningHost().getService();
    const page = await service.listDue({ limit: 100 });
    return page.items || [];
  }, PLUGIN_ID);
}

async function readContextRows(familyKey) {
  return page.evaluate(async ({ pluginId, familyKey }) => {
    const runtime = await app.plugins.plugins[pluginId].getVocabularyRuntime();
    const page = await runtime.contexts.listFamily(familyKey, { limit: 100 });
    return page.contexts || [];
  }, { pluginId: PLUGIN_ID, familyKey });
}

async function openCommand(commandText) {
  const paletteButton = await page.$$('.side-dock-ribbon-action[aria-label="打开命令面板"]');
  assert.equal(paletteButton.length, 1, "Use Obsidian's visible Open Command Palette control from the owned window.");
  const visible = await paletteButton[0].evaluate(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
      getComputedStyle(node).display !== "none";
  });
  assert.equal(visible, true, "Command Palette ribbon control must be visible before activation.");
  await paletteButton[0].click();
  await paletteButton[0].dispose();
  let target = await findOwnedVisibleDialog(".prompt-input");
  if (!target) {
    await page.keyboard.up("Meta");
    await page.keyboard.up("Shift");
    await page.keyboard.down("Meta");
    await page.keyboard.press("p");
    await page.keyboard.up("Meta");
    target = await waitFor("visible native Command Palette after real Cmd+P", () => findOwnedVisibleDialog(".prompt-input"), Boolean, 8_000);
  }
  await target.click(".prompt-input");
  await target.keyboard.down("Meta");
  await target.keyboard.press("a");
  await target.keyboard.up("Meta");
  await target.keyboard.type(commandText, { delay: 15 });
  await waitFor(`command palette result ${commandText}`, async () => target.$$eval(".suggestion-item", nodes => nodes.map(node => node.innerText)),
    rows => rows.some(row => row.includes(commandText)), 8_000);
  await target.keyboard.press("Enter");
}

async function findOwnedVisibleDialog(selector) {
  // This browser is attached only after the exact owned process/profile check.
  // Verify the sole host vault before accepting its native modal renderers.
  native.assertNativeVaultIdentity(await appIdentity(), native.nativeConfig);
  const candidates = await browser.pages();
  const hosts = candidates.filter(candidate => candidate.url() === APP_URL);
  if (!attachedExistingTestVault) assert.equal(hosts.length, 1, "Dialog ownership requires exactly one owned vault renderer.");
  const matches = [];
  for (const candidate of candidates) {
    if (attachedExistingTestVault && candidate !== page && !(await candidate.title()).includes(" - ObReader-Apple-Test - ")) continue;
    const state = await candidate.evaluate(selector => {
      const nodes = [...document.querySelectorAll(selector)];
      return { title: document.title, popout: document.body?.classList.contains("is-popout-modal"),
        visible: nodes.length > 0 && nodes.every(node => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
        }) };
    }, selector).catch(() => null);
    if (!state?.visible) continue;
    assert.ok(candidate === page || state.popout,
      `Refusing a dialog outside the owned host/native modal: ${state.title}`);
    if (state.title.includes("ObReader-") || state.title.includes("Obsidian")) {
      assert.ok(state.title.includes("ObReader-Apple-Test"), `Unexpected dialog vault: ${state.title}`);
    }
    matches.push({ candidate, state });
  }
  assert.ok(matches.length <= 1, "Expected one visible owned dialog target.");
  if (!matches.length) return null;
  report.dialogTargets ||= [];
  report.dialogTargets.push({ selector, url: matches[0].candidate.url(), ...matches[0].state,
    ownership: "exact owned process/profile with one validated vault renderer", at: new Date().toISOString() });
  return matches[0].candidate;
}

async function openWorkbench() {
  let target = await findOwnedVisibleDialog(".vocabulary-workbench");
  if (!target) {
    await openPluginSettingsThroughUI();
    target = await waitFor("owned Workbench dialog", () => findOwnedVisibleDialog(".vocabulary-workbench"));
  }
  await target.waitForSelector('.vocabulary-workbench [data-action="tab-review"]', { timeout: 15_000 });
  return target;
}

async function openLearningDraftAndConfirm({ question, expectedAnswer, beforeCount }) {
  const target = await waitFor("visible owned learning draft with question and answer", () =>
    findOwnedVisibleDialog('textarea[aria-label="问题"], textarea[aria-label="答案"]'), Boolean, 12_000);
  await target.waitForSelector('textarea[aria-label="问题"]', { visible: true });
  await target.waitForSelector('textarea[aria-label="答案"]', { visible: true });
  const answer = await target.$eval('textarea[aria-label="答案"]', node => node.value);
  assert.equal(answer, expectedAnswer, "Draft answer must be the exact selected/source text.");
  assert.equal((await readLearningItems()).length, beforeCount,
    "Opening a draft must not create a Review item before confirmation.");
  await recordScreen("learning-draft-before-confirm", target);
  await target.click('textarea[aria-label="问题"]');
  await target.keyboard.type(question, { delay: 8 });
  await clickVisibleButtonByExactText("确认加入复习", target);
}

async function clickVisibleButtonByExactText(label, target = page) {
  const buttons = await target.$$("button");
  const matches = [];
  for (const button of buttons) {
    const candidate = await button.evaluate(node => ({
      text: node.textContent.replace(/\s+/gu, " ").trim(),
      visible: node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 &&
        getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none",
    }));
    if (candidate.text === label && candidate.visible) matches.push(button);
    else await button.dispose();
  }
  assert.equal(matches.length, 1, `Expected one visible button named ${label}; found ${matches.length}.`);
  await matches[0].click();
  await matches[0].dispose();
}

async function clickVisibleElementContainingText(selector, text, target = page) {
  const candidates = await target.$$(selector);
  const matches = [];
  for (const candidate of candidates) {
    const state = await candidate.evaluate(node => ({
      text: node.textContent || "",
      visible: node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 &&
        getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none",
    }));
    if (state.visible && state.text.includes(text)) matches.push(candidate);
    else await candidate.dispose();
  }
  assert.equal(matches.length, 1, `Expected one visible ${selector} containing ${text}; found ${matches.length}.`);
  await matches[0].click();
  await matches[0].dispose();
}

async function visibleText(selector, target = page) {
  return target.$$eval(selector, nodes => nodes.filter(node => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
      getComputedStyle(node).display !== "none";
  }).map(node => (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim()));
}

async function findSettingsWindow() {
  const pages = await browser.pages();
  for (const candidate of pages) {
    if (attachedExistingTestVault && candidate !== page && !(await candidate.title()).includes(" - ObReader-Apple-Test - ")) continue;
    const isSettings = await candidate.evaluate(() => Boolean(
      document.body?.classList.contains("is-popout-modal") &&
      document.querySelector(".modal.mod-settings"),
    )).catch(() => false);
    if (isSettings) return candidate;
  }
  return null;
}

async function openPluginSettingsThroughUI() {
  settingsPage = await findSettingsWindow();
  if (!settingsPage) {
    const ribbon = await page.$$(".workspace-drawer-vault-actions .clickable-icon");
    const matches = [];
    for (const button of ribbon) {
      const state = await button.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return {
          label: [node.getAttribute("aria-label"), node.getAttribute("title"),
            node.querySelector("svg")?.getAttribute("class")].filter(Boolean).join(" ").trim(),
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
            getComputedStyle(node).display !== "none",
        };
      });
      if (state.visible && /lucide-settings|settings|设置/iu.test(state.label)) matches.push(button);
      else await button.dispose();
    }
    assert.equal(matches.length, 1, `Expected one visible vault-footer Settings control; found ${matches.length}.`);
    await recordScreen("settings-vault-footer-control");
    await matches[0].click();
    await matches[0].dispose();
    settingsPage = await waitFor("native Obsidian Settings window", findSettingsWindow, Boolean, 10_000);
  }
  settingsPage.setDefaultTimeout(15_000);
  let entries = await visibleText(".vertical-tab-nav-item", settingsPage);
  assert.ok(entries.length > 0, "The native Settings window must expose its visible navigation tabs.");
  if (!entries.some(label => label.includes("PDF Web Reader"))) {
    const community = entries.filter(label => /community plugins|第三方插件|社区插件/iu.test(label));
    assert.equal(community.length, 1, `Expected one Community Plugins settings section; found ${community.length}.`);
    await clickVisibleElementContainingText(".vertical-tab-nav-item", community[0], settingsPage);
    await waitFor("PDF Web Reader settings tab", () => visibleText(".vertical-tab-nav-item", settingsPage),
      labels => labels.some(label => label.includes("PDF Web Reader")), 10_000);
  }
  await clickVisibleElementContainingText(".vertical-tab-nav-item", "PDF Web Reader", settingsPage);
  await waitFor("Workbench setting row", () => visibleText(".setting-item", settingsPage),
    rows => rows.some(label => label.includes("词汇学习工作台")), 10_000);
  const rows = await settingsPage.$$(".setting-item");
  const matchingRows = [];
  for (const row of rows) {
    const state = await row.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { text: (node.innerText || "").replace(/\s+/gu, " ").trim(),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
          getComputedStyle(node).display !== "none" };
    });
    if (state.visible && state.text.includes("词汇学习工作台")) matchingRows.push(row);
    else await row.dispose();
  }
  assert.equal(matchingRows.length, 1, `Expected one visible Workbench Settings row; found ${matchingRows.length}.`);
  const buttons = await matchingRows[0].$$("button");
  const openButtons = [];
  for (const button of buttons) {
    const state = await button.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { text: (node.innerText || node.textContent || "").replace(/\s+/gu, " ").trim(),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
          getComputedStyle(node).display !== "none" };
    });
    if (state.visible && state.text === "打开") openButtons.push(button);
    else await button.dispose();
  }
  assert.equal(openButtons.length, 1, `Expected one visible Workbench Settings Open button; found ${openButtons.length}.`);
  await recordScreen("settings-workbench-open-control", settingsPage);
  await openButtons[0].click();
  await openButtons[0].dispose();
  await matchingRows[0].dispose();
  await waitFor("Workbench opened from visible Settings UI", async () => {
    const target = settingsPage && !settingsPage.isClosed() ? settingsPage : page;
    return target.$eval(".vocabulary-workbench [data-action=\"tab-review\"]", () => true).catch(() => false);
  }, Boolean, 15_000);
  report.workbenchOpenMethod = "visible Settings > PDF Web Reader > 词汇学习工作台 > 打开";
  await recordScreen("workbench-opened-from-settings", settingsPage && !settingsPage.isClosed() ? settingsPage : page);
}

async function closeSettingsThroughUIIfVisible() {
  if (!settingsPage || settingsPage.isClosed()) return false;
  await settingsPage.waitForFunction(() => !document.querySelector(".vocabulary-workbench"), { timeout: 8_000 });
  const settingsOpen = await settingsPage.$eval(".modal.mod-settings", node => node.getBoundingClientRect().width > 0)
    .catch(() => false);
  if (!settingsOpen) return false;
  await settingsPage.keyboard.down("Meta");
  try {
    await settingsPage.keyboard.press("w");
  } catch (error) {
    // Cmd+W can destroy the target before its key-up acknowledgement returns.
    if (!String(error).includes("TargetCloseError")) throw error;
    await waitFor("Settings target closure after Cmd+W", () => settingsPage.isClosed(), Boolean, 8_000);
  } finally {
    // Release modifiers on the surviving host even when Cmd+W destroys its target.
    if (page && !page.isClosed()) await page.keyboard.up("Meta");
    if (!settingsPage.isClosed()) await settingsPage.keyboard.up("Meta").catch(async error => {
      if (!String(error).includes("TargetCloseError")) throw error;
      await waitFor("Settings target closure after Cmd+W key release", () => settingsPage.isClosed(), Boolean, 8_000);
    });
  }
  await waitFor("Settings window closed through macOS Cmd+W UI action", () => settingsPage.isClosed(), Boolean, 8_000);
  settingsPage = null;
  assertNativeLearningForeground(await appIdentity(), {
    vault: EXPECTED_VAULT, configDir: native.nativeConfig.configDir, stage: "after Settings window close",
  });
  return true;
}

async function closeWorkbenchThroughUI() {
  const target = settingsPage && !settingsPage.isClosed() ? settingsPage : page;
  const modals = await target.$$(".modal");
  const workbenches = [];
  for (const modal of modals) {
    const state = await modal.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { hasWorkbench: Boolean(node.querySelector(".vocabulary-workbench")),
        visible: rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
          getComputedStyle(node).display !== "none" };
    });
    if (state.hasWorkbench && state.visible) workbenches.push(modal);
    else await modal.dispose();
  }
  assert.equal(workbenches.length, 1, `Expected one visible Workbench modal to close; found ${workbenches.length}.`);
  const closeButton = await workbenches[0].$(".modal-close-button");
  if (closeButton) {
    const visible = await closeButton.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden" &&
        getComputedStyle(node).display !== "none";
    });
    assert.equal(visible, true, "The Workbench close control must be visible before closing through the UI.");
    await closeButton.click();
    await closeButton.dispose();
  } else {
    await target.keyboard.press("Escape");
  }
  await workbenches[0].dispose();
  await target.waitForFunction(() => !document.querySelector(".vocabulary-workbench"), { timeout: 8_000 });
  if (settingsPage && !settingsPage.isClosed()) {
    await recordScreen("workbench-closed-through-ui", settingsPage);
  }
  return true;
}

async function prepareEmptyIsolationRoots() {
  for (const root of isolationPlan.roots) {
    await mkdir(absoluteVaultPath(root.physicalRoot), { recursive: true });
  }
}

async function queryFamilyKey(surface) {
  return page.evaluate(async ({ pluginId, surface }) => {
    const family = await app.plugins.plugins[pluginId].getVocabularyService().getFamily(surface);
    return family?.familyKey || null;
  }, { pluginId: PLUGIN_ID, surface });
}

async function clickTodaySource(itemId) {
  const target = await openWorkbench();
  await target.click('[data-action="tab-review"]');
  await waitFor(`Today row ${itemId}`,
    () => target.$$eval('[data-role="review-row"][data-provider-id="learning"]', rows =>
      rows.map(row => ({ id: row.dataset.itemId, text: row.innerText }))),
    rows => rows.some(row => row.id === itemId), 15_000);
  const sourceSelector = `[data-role="review-row"][data-provider-id="learning"][data-item-id="${itemId}"] [data-action^="review-source-learning-"]`;
  await target.waitForSelector(sourceSelector, { timeout: 10_000 });
  await target.click(sourceSelector);
  await closeSettingsThroughUIIfVisible();
}

async function readItem(itemId) {
  return page.evaluate(async ({ pluginId, itemId }) =>
    (await app.plugins.plugins[pluginId].getLearningHost().getService()).getItem(itemId),
  { pluginId: PLUGIN_ID, itemId });
}

async function findItemBySource({ targetKind, targetId }) {
  const matches = await waitFor(`Learning item for ${targetKind}:${targetId}`, readLearningItems, items =>
    items.some(item => item.source?.target?.kind === targetKind && item.source?.target?.id === targetId), 15_000);
  return matches.find(item => item.source?.target?.kind === targetKind && item.source?.target?.id === targetId);
}

async function snapshotVocabularyInvariant() {
  const physicalRoot = isolationPlan.roots[1].physicalRoot;
  const physicalFiles = await readNativeSidecarTree(physicalRoot, {
    resolvePath: absoluteVaultPath,
    rejectPending: true,
  });
  const logicalFiles = new Map([...physicalFiles].map(([file, bytes]) => [
    `${isolationPlan.roots[1].logicalRoot}${file.slice(physicalRoot.length)}`,
    bytes,
  ]));
  return summarizeNativeLearningLoopInvariant(logicalFiles);
}

async function currentPdfRoute(item) {
  return page.evaluate(async ({ pluginId, item }) => {
    const plugin = app.plugins.plugins[pluginId];
    const route = await plugin.annotationHost.store.documentForIdentity({
      docKey: item.source.docKey,
      documentId: item.source.documentId,
    });
    return route ? { sourcePath: route.sourcePath, docKey: route.docKey, documentId: route.documentId } : null;
  }, { pluginId: PLUGIN_ID, item });
}

async function currentMarkdownRoute(itemId) {
  return page.evaluate(async ({ pluginId, itemId }) => {
    const plugin = app.plugins.plugins[pluginId];
    if (typeof plugin.getLearningHost?.().getMarkdownRouting !== "function") {
      return { status: "unsupported", code: "MARKDOWN_ROUTING_UNAVAILABLE" };
    }
    return (await plugin.getLearningHost().getMarkdownRouting()).resolve({
      ownerKind: "learning-item",
      ownerId: itemId,
    });
  }, { pluginId: PLUGIN_ID, itemId });
}

async function renameOwnedPath(from, to) {
  assertFixturePath(from);
  assertFixturePath(to);
  await page.evaluate(({ from, to }) => {
    const file = app.vault.getAbstractFileByPath(from);
    if (!file) throw new Error(`Owned route source does not exist: ${from}`);
    const state = window.__nativeOwnedRename = { from, to, done: false };
    state.promise = (from === to ? Promise.resolve() : app.fileManager.renameFile(file, to))
      .then(() => { state.done = true; }, error => { state.error = String(error?.stack || error); state.done = true; });
  }, { from, to });
  await waitFor(`owned rename ${to}`, async () => {
    const buttons = await page.$$(".modal-container button");
    for (const button of buttons) {
      const match = await button.evaluate(node => node.textContent.trim() === "仅此一次" && node.getBoundingClientRect().width > 0);
      if (match) await button.click();
      await button.dispose();
    }
    return page.evaluate(() => ({ done: window.__nativeOwnedRename.done, error: window.__nativeOwnedRename.error }));
  }, state => state.done);
  const error = await page.evaluate(() => window.__nativeOwnedRename.error);
  assert.ok(!error, error);
}

async function makeOwnedFolder(relative) {
  assertFixturePath(`${relative}/created`);
  await page.evaluate(async targetPath => {
    if (app.vault.getAbstractFileByPath(targetPath)) return;
    await app.vault.createFolder(targetPath);
  }, relative);
}

async function verifySource(itemId, expectedTarget, expectedPath, { markdown = false } = {}) {
  const item = await readItem(itemId);
  assert.ok(item, `Learning item disappeared: ${itemId}`);
  const exactTarget = { ...expectedTarget, documentId: item.source.documentId };
  assert.equal(item.source.target.id, exactTarget.id);
  assert.equal(item.source.target.kind, exactTarget.kind);
  const priorApplySequence = await page.evaluate(({ pluginId, documentId }) => {
    const view = [...(app.plugins.plugins[pluginId]?.views || [])]
      .find(candidate => candidate.documentId === documentId);
    return view?.readerTargetApplySequence || 0;
  }, { pluginId: PLUGIN_ID, documentId: item.source.documentId });
  const navigationOffset = await page.evaluate(() => window.__sidecarNative07?.navigationResults?.length || 0);
  await clickTodaySource(itemId);
  if (markdown) {
    await waitFor(`Markdown source editor ${expectedPath}`, () => page.evaluate(expectedPath => {
      const view = app.workspace.activeLeaf?.view;
      return view?.file?.path === expectedPath ? view.editor?.getSelection?.() || "" : "";
    }, expectedPath), selected => selected === MARKDOWN_EXCERPT, 15_000);
    const active = await page.evaluate(() => ({
      path: app.workspace.activeLeaf?.view?.file?.path || null,
      selection: app.workspace.activeLeaf?.view?.editor?.getSelection?.() || "",
    }));
    assert.deepEqual(active, { path: expectedPath, selection: MARKDOWN_EXCERPT });
    return { itemId, target: item.source.target, path: active.path, selection: active.selection };
  }
  const route = await waitFor(`PDF identity route ${item.source.documentId}`, () => currentPdfRoute(item),
    value => value?.sourcePath === expectedPath, 15_000);
  const view = await waitFor(`PDF Reader source ${expectedPath}`, appIdentity,
    state => state.readerViews.find(candidate => candidate.path === expectedPath), 15_000);
  const matchingAnnotation = await page.evaluate(({ pluginId, expectedTarget }) => {
    const plugin = app.plugins.plugins[pluginId];
    const view = [...plugin.views].find(candidate => candidate.documentId === expectedTarget.documentId);
    const rows = view?.annotationSnapshot?.annotations || [];
    return rows.some(row => row.uuid === expectedTarget.id && row.deleted !== true);
  }, { pluginId: PLUGIN_ID, expectedTarget: exactTarget });
  if (exactTarget.kind === "annotation") assert.equal(matchingAnnotation, true, "Source must return to the same Highlight UUID.");
  const navigationIdentity = await waitFor(`fresh Reader target application for ${item.source.documentId}`,
    () => page.evaluate(({ pluginId, documentId }) => {
      const view = [...(app.plugins.plugins[pluginId]?.views || [])]
        .find(candidate => candidate.documentId === documentId);
      return view ? { documentId: view.documentId, openRequest: view.openRequest,
        rendererGeneration: view.rendererGeneration, applySequence: view.readerTargetApplySequence,
        pending: view.readerNavigationRequest || null } : null;
    }, { pluginId: PLUGIN_ID, documentId: item.source.documentId }),
    value => value?.applySequence > priorApplySequence, 15_000);
  assert.equal(navigationIdentity?.documentId, item.source.documentId,
    "The correlated Reader navigation must belong to the Learning item's document identity.");
  const expectedRequestId = `reader-nav-${navigationIdentity.openRequest}-${navigationIdentity.applySequence}`;
  const navigationEvents = await waitFor(`current Reader navigation acknowledgement for ${expectedTarget.id}`,
    () => page.evaluate(() => window.__sidecarNative07?.navigationResults || []), rows =>
      rows.slice(navigationOffset).some(row => row.ok === true && row.targetId === exactTarget.id &&
        row.kind === exactTarget.kind && row.requestId === expectedRequestId), 15_000);
  const navigation = navigationEvents.slice(navigationOffset).filter(row => row.ok === true &&
    row.targetId === exactTarget.id && row.kind === exactTarget.kind &&
    row.requestId === expectedRequestId).at(-1);
  assert.ok(navigation, `Reader navigation must acknowledge the exact current target ${expectedTarget.id}.`);
  const acceptedNavigation = await page.evaluate(({ pluginId, documentId }) => {
    const candidate = [...(app.plugins.plugins[pluginId]?.views || [])].find(row => row.documentId === documentId);
    return candidate?.lastReaderNavigationResult || null;
  }, { pluginId: PLUGIN_ID, documentId: item.source.documentId });
  assert.ok(acceptedNavigation, "Host must retain the accepted current navigation receipt.");
  for (const [key, expected] of Object.entries({ requestId: expectedRequestId,
    documentId: item.source.documentId, openRequest: navigationIdentity.openRequest,
    rendererGeneration: navigationIdentity.rendererGeneration, kind: exactTarget.kind,
    targetId: exactTarget.id, ok: true })) {
    assert.equal(acceptedNavigation[key], expected, `Accepted Source receipt must exactly match ${key}.`);
  }
  const pendingNavigation = await page.evaluate(({ pluginId, documentId }) => {
    const candidate = [...(app.plugins.plugins[pluginId]?.views || [])]
      .find(row => row.documentId === documentId);
    return candidate?.readerNavigationRequest || null;
  }, { pluginId: PLUGIN_ID, documentId: item.source.documentId });
  assert.equal(pendingNavigation, null, "Accepted Reader navigation must clear its correlated pending request.");
  return { itemId, target: item.source.target, path: route.sourcePath, view,
    navigationIdentity: { ...navigationIdentity, priorApplySequence },
    acceptedNavigation,
    navigation: { requestId: navigation.requestId, targetId: navigation.targetId,
      kind: navigation.kind, ok: navigation.ok, pendingAfterAck: pendingNavigation } };
}

async function compareInvariantAfterMove(label) {
  const after = await snapshotVocabularyInvariant();
  assertNativeLearningLoopInvariantUnchanged(baseVocabularySnapshot, after, label);
  return { fileCount: after.fileCount, unchanged: true };
}

async function routeScenario(name, operation, expectedPaths) {
  const before = await snapshotVocabularyInvariant();
  assertNativeLearningLoopInvariantUnchanged(baseVocabularySnapshot, before, `${name} pre-move`);
  if (resumeEvidence?.routeScenarios?.some(row => row.name === name && row.status === "passed")) {
    await checkpoint(`route-${name}-prior-proof-retained`);
    return;
  }
  const evidence = await operation();
  const invariant = await compareInvariantAfterMove(name);
  const pdfItem = await readItem(learningItems.highlight.itemId);
  const mdItem = await readItem(learningItems.markdown.itemId);
  const pdfRoute = await currentPdfRoute(pdfItem);
  const markdownRoute = await currentMarkdownRoute(mdItem.itemId);
  if (expectedPaths.pdf) assert.equal(pdfRoute?.sourcePath, expectedPaths.pdf,
    `${name} must keep the same PDF identity on the new exact path.`);
  if (expectedPaths.markdown) {
    assert.equal(markdownRoute?.status, "verified", `${name} must preserve a verified Markdown route.`);
    assert.equal(markdownRoute.currentPath, expectedPaths.markdown,
      `${name} must resolve the Markdown owner to the exact moved path.`);
  }
  report.routeScenarios.push({ name, status: "passed", at: new Date().toISOString(), evidence, invariant,
    routes: { pdf: pdfRoute, markdown: markdownRoute } });
  await checkpoint(`route-${name}-passed`);
}

async function addMarkdownLearningItem(markdownPath) {
  assertFixturePath(markdownPath);
  await page.evaluate(async targetPath => {
    const file = app.vault.getAbstractFileByPath(targetPath);
    if (!file) throw new Error(`Owned Markdown fixture is missing: ${targetPath}`);
    await app.workspace.getLeaf(true).openFile(file);
  }, markdownPath);
  await page.waitForSelector(".cm-line", { timeout: 10_000 });
  await clickVisibleElementContainingText(".cm-line", MARKDOWN_EXCERPT);
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  const selection = await page.evaluate(() => app.workspace.activeLeaf?.view?.editor?.getSelection?.() || "");
  assert.equal(selection, MARKDOWN_EXCERPT, "Markdown source text must be selected through real editor input.");
  await openCommand("将 Markdown 选中摘录加入复习");
  await openLearningDraftAndConfirm({ question: "Where did this exact Markdown sentence come from?",
    expectedAnswer: MARKDOWN_EXCERPT, beforeCount: (await readLearningItems()).length });
  const items = await waitFor("Markdown Learning item creation after UI confirmation", readLearningItems,
    rows => rows.some(candidate => candidate.source?.target?.kind === "markdown" &&
      candidate.source?.targetText === MARKDOWN_EXCERPT), 15_000);
  const item = items.find(candidate => candidate.source?.target?.kind === "markdown" &&
    candidate.source?.targetText === MARKDOWN_EXCERPT);
  assert.equal(item.source.sourcePath, markdownPath);
  assert.equal(item.source.sourceRange?.text, MARKDOWN_EXCERPT);
  return item;
}

async function createHighlightLearningItem(pdfPath) {
  await openFixture(pdfPath);
  const { frame } = await readerFrame(pdfPath);
  const textLayerWaitStartedAt = Date.now();
  // This is a bounded readiness wait, not a performance pass. Preserve the
  // observed cold Native render duration in the receipt so slow readiness
  // cannot be mistaken for an accepted latency target.
  await frame.waitForFunction(() => document.querySelectorAll('.page[data-page-number="1"] .textLayer span').length > 0,
    { timeout: NATIVE_TEXT_LAYER_READY_TIMEOUT_MS });
  report.nativeTextLayerReadyMs = Date.now() - textLayerWaitStartedAt;
  const initial = await page.evaluate(async ({ pluginId }) => {
    const plugin = app.plugins.plugins[pluginId];
    const service = await plugin.getLearningHost().getService();
    const due = await service.listDue({ limit: 100 });
    return { items: due.items || [], storeRoot: service.root || null };
  }, { pluginId: PLUGIN_ID });
  assert.equal(initial.items.length, 0, "Native isolation starts with no seeded Learning/Review items.");
  const before = await page.evaluate(({ pluginId, pdfPath }) => {
    const view = [...app.plugins.plugins[pluginId].views].find(candidate => candidate.requestedPath === pdfPath);
    return view?.documentId || null;
  }, { pluginId: PLUGIN_ID, pdfPath });
  assert.ok(before, "Reader must have an exact document identity before Highlight creation.");
  await page.screenshot({ path: path.join(screenshotDirectory, "reader-before-highlight.png"), fullPage: false });
  report.screenshots.push(path.join(screenshotDirectory, "reader-before-highlight.png"));

  await frame.waitForSelector("#editorHighlightButton", { timeout: 15_000 });
  await frame.waitForFunction(expectedText => {
    const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
      .find(node => node.textContent.includes(expectedText));
    const rect = span?.getBoundingClientRect();
    return Boolean(PDFViewerApplication.pdfDocument && rect?.width > 0 && rect?.height > 0);
  }, { timeout: NATIVE_TEXT_LAYER_READY_TIMEOUT_MS }, HIGHLIGHT_TEXT);
  const readHighlightMode = () => frame.evaluate(() => ({
    mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
    expanded: document.querySelector("#editorHighlightButton")?.getAttribute("aria-expanded") || null,
  }));
  let highlightMode = await readHighlightMode();
  if (highlightMode.mode !== 9) {
    await frame.click("#editorHighlightButton");
    try {
      await frame.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 9, { timeout: 8_000 });
    } catch (firstClickError) {
      highlightMode = await readHighlightMode();
      if (highlightMode.mode !== 9) {
        await frame.click("#editorHighlightButton");
        await frame.waitForFunction(() => PDFViewerApplication.pdfViewer.annotationEditorMode === 9, { timeout: 8_000 });
      }
    }
  }
  assert.equal((await readHighlightMode()).mode, 9, "The visible PDF.js Highlight toolbar must enter mode 9.");
  await recordScreen("reader-highlight-tool-active");
  const selection = await selectTextByPointer({ frame, pathValue: pdfPath, text: HIGHLIGHT_TEXT, mode: "selection" });
  assert.equal(selection.text, HIGHLIGHT_TEXT);
  report.highlightPointerGeometry = selection;
  await recordScreen("reader-after-highlight-pointer-drag");
  await frame.waitForFunction(() => document.querySelectorAll(".annotationEditorLayer .highlightEditor").length > 0,
    { timeout: 8_000 });
  const annotation = await saveAnnotationThroughReaderUI(frame, before);
  report.highlight = { uuid: annotation.row.uuid, pageIndex: annotation.row.pageIndex,
    revision: annotation.revision, confirmedRevision: annotation.confirmedRevision,
    sourceText: annotation.row.payload?.editor?.text || null, saveControl: annotation.saveControl };
  assert.equal(annotation.row.payload?.editor?.text, HIGHLIGHT_TEXT,
    "Durable Highlight must keep the selected source text.");

  await frame.waitForSelector("#pdfReaderAnnotationSidebarButton", { timeout: 10_000 });
  await frame.click("#pdfReaderAnnotationSidebarButton");
  const reviewSelector = `#editorCommentsSidebarList li.sidebarComment[data-uuid="${annotation.row.uuid}"] .pdfReaderAnnotationReviewButton`;
  await frame.waitForFunction(selector => {
    const button = document.querySelector(selector);
    return Boolean(button && !button.disabled);
  }, { timeout: 10_000 }, reviewSelector);
  await frame.click(reviewSelector);
  const beforeItems = (await readLearningItems()).length;
  await openLearningDraftAndConfirm({ question: "What does this exact Highlight explain?",
    expectedAnswer: HIGHLIGHT_TEXT, beforeCount: beforeItems });
  const items = await waitFor("Highlight Learning item after real Sidebar Add Review confirmation", readLearningItems,
    rows => rows.some(candidate => candidate.source?.target?.kind === "annotation" &&
      candidate.source.target.id === annotation.row.uuid), 15_000);
  const item = items.find(candidate => candidate.source?.target?.kind === "annotation" &&
    candidate.source.target.id === annotation.row.uuid);
  assert.equal(item.source.documentId, before);
  assert.equal(item.source.target.id, annotation.row.uuid);
  assert.equal(item.answer, HIGHLIGHT_TEXT);
  learningItems.highlight = item;
  report.uiFlows.push({ name: "Highlight -> durable sidecar -> Sidebar -> Add Review -> Today", status: "passed",
    uuid: annotation.row.uuid, itemId: item.itemId, sourcePath: pdfPath, pageIndex: annotation.row.pageIndex });
  await checkpoint("highlight-learning-item-created", { uuid: annotation.row.uuid, itemId: item.itemId });
  const workbench = await openWorkbench();
  await workbench.click('[data-action="tab-review"]');
  await workbench.waitForSelector(`[data-role="review-row"][data-provider-id="learning"][data-item-id="${item.itemId}"]`, { timeout: 15_000 });
  await recordScreen("highlight-today-review", workbench);
  const sourceEvidence = await verifySource(item.itemId, { kind: "annotation", id: annotation.row.uuid,
    documentId: item.source.documentId }, pdfPath);
  report.uiFlows.at(-1).sourceEvidence = sourceEvidence;
  await recordScreen("highlight-today-source");
  await page.keyboard.press("Escape").catch(() => {});
  return item;
}

async function enableLingQReadModeThroughUI(frame) {
  const hidden = await frame.$eval("#secondaryToolbar", node => node.classList.contains("hidden"));
  if (hidden) await frame.click("#secondaryToolbarToggleButton");
  await frame.waitForSelector("#pdfReaderVocabularyToggleButton", { timeout: 10_000 });
  let pressed = await frame.$eval("#pdfReaderVocabularyToggleButton", node => node.getAttribute("aria-pressed") === "true");
  if (pressed) {
    await frame.click("#pdfReaderVocabularyToggleButton");
    await frame.waitForFunction(() => document.querySelector("#pdfReaderVocabularyToggleButton")?.getAttribute("aria-pressed") === "false",
      { timeout: 10_000 });
    pressed = false;
  }
  assert.equal(pressed, false);
  await frame.click("#pdfReaderVocabularyToggleButton");
  await frame.waitForFunction(() => {
    const viewer = PDFViewerApplication.pdfViewer;
    const manager = viewer?._layerProperties?.annotationEditorUIManager;
    return document.querySelector("#pdfReaderVocabularyToggleButton")?.getAttribute("aria-pressed") === "true" &&
      viewer?.annotationEditorMode === 0 && manager?.getMode?.() === 0;
  }, { timeout: 15_000 });
  return { enabledThroughVisibleToolbar: true, viewerMode: 0, managerMode: 0 };
}

async function selectCompleteDynamicSentenceByPointer(frame, pdfPath) {
  const geometry = await frame.evaluate(() => {
    const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')];
    const firstIndex = spans.findLastIndex(node => node.textContent.includes("Dynamic languages"));
    if (firstIndex < 0) throw new Error("Dynamic sentence start is missing from actual textLayer.");
    const last = spans.slice(firstIndex).find(node => node.textContent.normalize("NFKC").includes("source file."));
    if (!last) throw new Error("Complete Dynamic sentence ending is missing from actual textLayer.");
    const first = spans[firstIndex];
    const start = first.textContent.indexOf("Dynamic languages");
    const endingStart = last.textContent.indexOf("source ");
    const end = last.textContent.indexOf(".", endingStart) + 1;
    const begin = document.createRange(); begin.setStart(first.firstChild, start); begin.setEnd(first.firstChild, start + 1);
    const finish = document.createRange(); finish.setStart(last.firstChild, end - 1); finish.setEnd(last.firstChild, end);
    const a = begin.getBoundingClientRect(), z = finish.getBoundingClientRect();
    return { x1: a.left + 0.25, y1: a.top + a.height / 2, x2: z.right + 1, y2: z.top + z.height / 2,
      sourceStart: first.textContent, sourceEnd: last.textContent };
  });
  const offset = await readerFrameRect(pdfPath);
  assert.ok(geometry.y1 > 0 && geometry.y2 < offset.height, "Complete sentence must be visible before pointer drag.");
  await page.mouse.move(offset.x + geometry.x1, offset.y + geometry.y1);
  await page.mouse.down();
  await page.mouse.move(offset.x + geometry.x2, offset.y + geometry.y2, { steps: 24 });
  await page.mouse.up();
  const actualSelection = await frame.evaluate(() => getSelection()?.toString() || "");
  assert.match(actualSelection, /^Dynamic languages/u);
  assert.match(actualSelection.normalize("NFKC"), /source file\.$/u);
  assert.ok(actualSelection.length > 100, "The extra case must capture the complete sentence, not a phrase.");
  return { ...geometry, actualSelection, scope: "complete sentence across actual PDF textLayer lines" };
}

async function createContextLearningItem(pdfPath, { completeSentence = false } = {}) {
  const { frame } = await readerFrame(pdfPath);
  let lingqMode, familyStatus, familyKey, selectionGeometry, selected, context;
  const previousContext = !completeSentence && resumeEvidence?.lastStep?.label === "lingq-context-saved" ? resumeEvidence.lastStep : null;
  if (previousContext) {
    familyKey = previousContext.familyKey;
    selected = previousContext.exactQuote;
    context = (await readContextRows(familyKey)).find(row => row.contextId === previousContext.contextId);
    assert.ok(context && context.anchor.exactQuote === selected, "Resume only the exact Context previously created through real UI.");
    familyStatus = await page.evaluate(async pluginId => (await app.plugins.plugins[pluginId].getVocabularyRuntime()).personalService.getTerm("dynamic"), PLUGIN_ID);
    lingqMode = { resumedPriorVisibleUI: true };
    selectionGeometry = { resumedEvidence: resumePath };
    contexts.dynamic = context;
  } else {
  lingqMode = await enableLingQReadModeThroughUI(frame);
  if (await frame.$eval("#pdfReaderAnnotationSidebarMenu", node => !node.classList.contains("hidden"))) {
    await frame.click("#pdfReaderAnnotationSidebarButton");
    await frame.waitForFunction(() => document.querySelector("#pdfReaderAnnotationSidebarMenu")?.classList.contains("hidden"));
  }
  if (await frame.$eval("#secondaryToolbar", node => !node.classList.contains("hidden"))) {
    await frame.click("#secondaryToolbarToggleButton");
  }
  await recordScreen("lingq-read-mode-ready");
  const initialCount = (await page.evaluate(async pluginId => {
    const runtime = await app.plugins.plugins[pluginId].getVocabularyRuntime();
    const family = await runtime.personalService.getFamily("dynamic");
    if (!family) return 0;
    return (await runtime.contexts.listFamily(family.familyKey, { limit: 20 })).contexts.length;
  }, PLUGIN_ID));
  if (!completeSentence) assert.equal(initialCount, 0, "No Context is seeded before a real LingQ sentence selection.");
  else assert.ok(initialCount >= 1, "Complete sentence extends the already proven real phrase Context.");
  const wordGeometry = await frame.evaluate(() => {
    const span = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span')]
      .find(node => /Dynamic languages/.test(node.textContent));
    const node = span?.firstChild;
    if (node?.nodeType !== Node.TEXT_NODE) throw new Error("Actual Dynamic languages PDF text is required.");
    const start = node.textContent.indexOf("Dynamic");
    const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 7);
    const rect = range.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  const offset = await readerFrameRect(pdfPath);
  await page.mouse.click(offset.x + wordGeometry.x, offset.y + wordGeometry.y);
  await frame.waitForSelector('.pdfReaderVocabularyPill[data-key="dynamic"]', { timeout: 10_000 });
  await recordScreen("lingq-word-pill-visible");
  await frame.click('.pdfReaderVocabularyPill button[data-status="2"]');
  familyStatus = await waitFor("real LingQ status write for dynamic", () => page.evaluate(async pluginId => {
    const runtime = await app.plugins.plugins[pluginId].getVocabularyRuntime();
    return runtime.personalService.getTerm("dynamic");
  }, PLUGIN_ID), value => value?.status === 2, 12_000);
  familyKey = await waitFor("Dynamic vocabulary family after its visible status action",
    () => queryFamilyKey("dynamic"), Boolean, 12_000);
  selectionGeometry = completeSentence ? await selectCompleteDynamicSentenceByPointer(frame, pdfPath)
    : await selectTextByPointer({ frame, pathValue: pdfPath, text: "Dynamic languages", mode: "selection", exact: false });
  selected = await frame.evaluate(({ completeSentence }) => {
    const selection = getSelection();
    return completeSentence && selection?.rangeCount === 1 ? selection.getRangeAt(0).toString() : selection?.toString() || "";
  }, { completeSentence });
  assert.match(selected, /Dynamic languages/u);
  if (completeSentence) {
    assert.equal(selected, selectionGeometry.actualSelection.replace(/\n/gu, ""),
      "The exact native DOM Range must differ from rendered Selection only by layout line breaks.");
    selectionGeometry.exactRangeText = selected;
  }
  await frame.click(".pdfReaderVocabularyContextCapture");
  await frame.waitForSelector(".pdfReaderVocabularyContextConfirm:not([hidden])", { timeout: 10_000 });
  assert.equal(await frame.$eval(".pdfReaderVocabularyContextPreview", node => node.value), selected);
  await frame.click(".pdfReaderVocabularyContextConfirm");
  const contextsForFamily = await waitFor("Context saved through the actual Viewer selection UI", () => readContextRows(familyKey),
    rows => rows.some(row => row.sentence === selected), 15_000);
  context = contextsForFamily.find(row => row.sentence === selected);
  assert.equal(context.surface.toLowerCase(), "dynamic");
  assert.equal(context.anchor.exactQuote, selected);
  assert.equal(context.anchor.textPosition.end - context.anchor.textPosition.start, selected.length,
    "Context selection offsets must span the exact user-selected text.");
  contexts.dynamic = context;
  await checkpoint("lingq-context-saved", { contextId: context.contextId, familyKey, exactQuote: selected });
  const pillClose = await frame.$(".pdfReaderVocabularyPillClose");
  if (pillClose && await pillClose.evaluate(node => node.getBoundingClientRect().width > 0)) await pillClose.click();
  await recordScreen("lingq-context-captured");

  }
  const workbench = await openWorkbench();
  await workbench.click('[data-action="tab-vocabulary"]');
  const familySelector = `[data-action="select-family"][data-family-key=${JSON.stringify(familyKey)}]`;
  await workbench.waitForSelector(familySelector, { timeout: 15_000 });
  await workbench.click(familySelector);
  await workbench.click('[data-action="tab-contexts"]');
  await waitFor("Context row in Workbench", () => workbench.$$eval('[data-role="context-record"]', rows => rows.map(row => row.innerText)),
    rows => rows.some(row => row.includes(selected)), 15_000);
  const existingContextItem = (await readLearningItems()).find(candidate =>
    candidate.source?.contextId === context.contextId && candidate.source?.target?.id === context.anchorId);
  if (!existingContextItem) {
  const contextRows = await workbench.$$('[data-role="context-record"]');
  const matchingRows = [];
  for (const row of contextRows) {
    if (await row.$eval("p", node => node.textContent) === selected) matchingRows.push(row);
    else await row.dispose();
  }
  assert.equal(matchingRows.length, 1, "Add Review must target the exact selected Context row.");
  const contextAddReview = await matchingRows[0].$('[data-action^="context-add-review-"]');
  assert.ok(contextAddReview, "The exact real Context Add Review action must be visible.");
  await contextAddReview.click();
  const beforeItems = (await readLearningItems()).length;
  await openLearningDraftAndConfirm({ question: "What does Dynamic mean in this exact sentence?",
    expectedAnswer: selected, beforeCount: beforeItems });
  } else {
    assert.ok(previousContext, "Only a resumed real UI Context may reuse its confirmed Review item.");
    report.resumedContextItem = existingContextItem.itemId;
  }
  const items = await waitFor("Context Learning item after real Add Review confirmation", readLearningItems,
    rows => rows.some(candidate => candidate.source?.evidenceKind === "context" &&
      candidate.source?.target?.id === context.anchorId), 15_000);
  const item = items.find(candidate => candidate.source?.evidenceKind === "context" &&
    candidate.source?.target?.id === context.anchorId);
  assert.equal(item.source.target.id, context.anchorId);
  assert.equal(item.source.targetText, selected);
  assert.equal(item.source.sourceRange, null, "PDF Context uses its Reader anchor; sourceRange belongs to Markdown source slices.");
  assert.equal(context.anchor.exactQuote, selected);
  assert.equal(context.anchor.textPosition.end - context.anchor.textPosition.start, selected.length);
  assert.equal(item.answer, selected);
  learningItems.context = item;
  report.uiFlows.push({ name: `LingQ status -> ${completeSentence ? "complete sentence" : "phrase"} selection -> Context -> Add Review -> Today`,
    selectionScope: completeSentence ? "complete sentence" : "phrase", status: "passed", contextId: context.contextId, anchorId: context.anchorId,
    exactQuote: selected, itemId: item.itemId, familyKey,
    familyStatus: familyStatus.status, lingqMode, selectionGeometry });
  await checkpoint("context-learning-item-created", { itemId: item.itemId, anchorId: context.anchorId });
  await workbench.click('[data-action="tab-review"]');
  await workbench.waitForSelector(`[data-role="review-row"][data-provider-id="learning"][data-item-id="${item.itemId}"]`, { timeout: 15_000 });
  await recordScreen("context-today-review", workbench);
  const sourceEvidence = await verifySource(item.itemId, { kind: "selection", id: context.anchorId,
    documentId: item.source.documentId }, pdfPath);
  const { frame: sourceFrame } = await readerFrame(pdfPath);
  const rangeText = await waitFor("Today Source exact Context anchor highlight", () => sourceFrame.evaluate(() =>
    window.CSS?.highlights?.get("pdfReaderAnchorFocusText")
      ? [...window.CSS.highlights.get("pdfReaderAnchorFocusText")].map(range => range.toString()).join("")
      : ""), value => value === selected, 15_000);
  assert.equal(rangeText, selected);
  report.uiFlows.at(-1).sourceEvidence = { ...sourceEvidence, exactAnchorText: rangeText };
  await recordScreen("context-today-source-exact-anchor");
  await page.keyboard.press("Escape").catch(() => {});
  return item;
}

async function performPathScenarios({ pdfPath, markdownPath, pdfDirectory, markdownDirectory }) {
  const priorMarkdown = resumeEvidence?.uiFlows?.find(flow => flow.name === "Markdown selected excerpt -> Add Review");
  learningItems.markdown = priorMarkdown ? await readItem(priorMarkdown.itemId) : await addMarkdownLearningItem(markdownPath);
  const mdItem = learningItems.markdown;
  if (!priorMarkdown) report.uiFlows.push({ name: "Markdown selected excerpt -> Add Review", status: "passed",
    itemId: mdItem.itemId, sourcePath: markdownPath, exactQuote: mdItem.source.targetText });
  let priorStable = null;
  baseVocabularySnapshot = await waitFor("durable Vocabulary transaction completion and stable bytes before freeze", async () => {
    const snapshot = await snapshotVocabularyInvariant();
    const pending = snapshot.files.some(file => /\.pending(?:\.json)?$/u.test(file.path));
    const stable = !pending && priorStable && JSON.stringify(priorStable.files) === JSON.stringify(snapshot.files);
    priorStable = pending ? null : snapshot;
    return stable ? snapshot : null;
  }, Boolean, 20_000);
  if (resumeEvidence?.stores?.invariantBaseline) {
    assertNativeLearningLoopInvariantUnchanged(resumeEvidence.stores.invariantBaseline, baseVocabularySnapshot,
      "route continuation must retain the original frozen bytes");
    baseVocabularySnapshot = resumeEvidence.stores.invariantBaseline;
  }
  report.stores.invariantBaseline = baseVocabularySnapshot;
  await checkpoint("invariant-baseline-captured", { fileCount: baseVocabularySnapshot.fileCount });

  let currentPdfPath = pdfPath;
  let currentPdfDirectory = pdfDirectory;
  let currentMarkdownPath = markdownPath;
  let currentMarkdownDirectory = markdownDirectory;

  const renamedPdfPath = `${currentPdfDirectory}/reading-renamed.pdf`;
  await routeScenario("pdfrename", async () => {
    await renameOwnedPath(currentPdfPath, renamedPdfPath);
    currentPdfPath = renamedPdfPath;
    const pdfSource = await verifySource(learningItems.highlight.itemId,
      { kind: "annotation", id: learningItems.highlight.source.target.id }, currentPdfPath);
    return { pdfSource };
  }, { pdf: renamedPdfPath });

  const movedPdfDirectory = `${fixturePrefix}/Reader Files Moved`;
  const movedPdfPath = `${movedPdfDirectory}/reading-renamed.pdf`;
  await routeScenario("foldermove", async () => {
    await renameOwnedPath(currentPdfDirectory, movedPdfDirectory);
    currentPdfDirectory = movedPdfDirectory;
    currentPdfPath = movedPdfPath;
    const pdfSource = await verifySource(learningItems.highlight.itemId,
      { kind: "annotation", id: learningItems.highlight.source.target.id }, currentPdfPath);
    return { pdfSource };
  }, { pdf: movedPdfPath });

  const renamedMarkdownPath = `${currentMarkdownDirectory}/learning-renamed.md`;
  await routeScenario("mdrename", async () => {
    await renameOwnedPath(currentMarkdownPath, renamedMarkdownPath);
    currentMarkdownPath = renamedMarkdownPath;
    const markdownSource = await verifySource(mdItem.itemId,
      { kind: "markdown", id: mdItem.source.target.id }, currentMarkdownPath, { markdown: true });
    return { markdownSource };
  }, { markdown: renamedMarkdownPath });

  const movedMarkdownDirectory = `${fixturePrefix}/Markdown Files Moved`;
  await makeOwnedFolder(movedMarkdownDirectory);
  const movedMarkdownPath = `${movedMarkdownDirectory}/learning-renamed.md`;
  await routeScenario("mdmove", async () => {
    await renameOwnedPath(currentMarkdownPath, movedMarkdownPath);
    currentMarkdownDirectory = movedMarkdownDirectory;
    currentMarkdownPath = movedMarkdownPath;
    const markdownSource = await verifySource(mdItem.itemId,
      { kind: "markdown", id: mdItem.source.target.id }, currentMarkdownPath, { markdown: true });
    return { markdownSource };
  }, { markdown: movedMarkdownPath });

  const bothPdfDirectory = `${fixturePrefix}/Reader Both Moved`;
  const bothMdDirectory = `${fixturePrefix}/Markdown Both Moved`;
  await makeOwnedFolder(bothMdDirectory);
  const bothPdfPath = `${bothPdfDirectory}/reading-renamed.pdf`;
  const bothMdPath = `${bothMdDirectory}/learning-renamed.md`;
  await routeScenario("bothmove", async () => {
    await renameOwnedPath(currentPdfDirectory, bothPdfDirectory);
    await renameOwnedPath(currentMarkdownPath, bothMdPath);
    currentPdfDirectory = bothPdfDirectory;
    currentPdfPath = bothPdfPath;
    currentMarkdownDirectory = bothMdDirectory;
    currentMarkdownPath = bothMdPath;
    const pdfSource = await verifySource(learningItems.context.itemId,
      { kind: "selection", id: contexts.dynamic.anchorId }, currentPdfPath);
    const markdownSource = await verifySource(mdItem.itemId,
      { kind: "markdown", id: mdItem.source.target.id }, currentMarkdownPath, { markdown: true });
    return { pdfSource, markdownSource };
  }, { pdf: bothPdfPath, markdown: bothMdPath });

  const closeResult = await completeNativeControlledClose({
    runSerialized: async (fn, arg) => page.evaluate(({ source, arg }) =>
      (0, eval)(`(${source})`)(arg), { source: fn.toString(), arg }),
    waitFor,
    loadFiles: isolatedRoot => readNativeSidecarTree(isolatedRoot, { resolvePath: absoluteVaultPath, rejectPending: true }),
    readWalEvidence: readNativeWalEvidence,
    hash: bytes => `xxh64-v1:${h64Raw(bytes).toString(16).padStart(16, "0")}`,
    filePath: currentPdfPath,
    expectedRemaining: 0,
    label: "closedmove",
    maintenanceOffset: await page.evaluate(() => window.__sidecarNative07?.maintenance?.length || 0),
    isolatedRoot: isolationPlan.roots[0].physicalRoot,
    virtualRoot: isolationPlan.roots[0].logicalRoot,
  });
  const closedMovePath = `${currentPdfDirectory}/reading-closed-move.pdf`;
  await routeScenario("closedmove", async () => {
    await renameOwnedPath(currentPdfPath, closedMovePath);
    currentPdfPath = closedMovePath;
    const source = await verifySource(learningItems.highlight.itemId,
      { kind: "annotation", id: learningItems.highlight.source.target.id }, currentPdfPath);
    return { controlledClose: closeResult, source };
  }, { pdf: closedMovePath });

  const openMovePath = `${currentPdfDirectory}/reading-open-move.pdf`;
  await routeScenario("openmove", async () => {
    await openFixture(currentPdfPath);
    await renameOwnedPath(currentPdfPath, openMovePath);
    currentPdfPath = openMovePath;
    const pdfSource = await verifySource(learningItems.context.itemId,
      { kind: "selection", id: contexts.dynamic.anchorId }, currentPdfPath);
    return { pdfSource };
  }, { pdf: openMovePath });

  const restartBefore = await snapshotVocabularyInvariant();
  assertNativeLearningLoopInvariantUnchanged(baseVocabularySnapshot, restartBefore, "restart precondition");
  const restartViews = (await appIdentity()).readerViews;
  report.restartControlledCloses = [];
  for (let index = 0; index < restartViews.length; index += 1) {
    const targetPath = restartViews[index].path;
    report.restartControlledCloses.push(await completeNativeControlledClose({
      runSerialized: async (fn, arg) => page.evaluate(({ source, arg }) => (0, eval)(`(${source})`)(arg), { source: fn.toString(), arg }),
      waitFor,
      loadFiles: root => readNativeSidecarTree(root, { resolvePath: absoluteVaultPath, rejectPending: true }),
      readWalEvidence: readNativeWalEvidence,
      hash: bytes => `xxh64-v1:${h64Raw(bytes).toString(16).padStart(16, "0")}`,
      filePath: targetPath, expectedRemaining: restartViews.slice(index + 1).filter(row => row.path === targetPath).length,
      label: "plugin-restart", maintenanceOffset: await page.evaluate(() => window.__sidecarNative07?.maintenance?.length || 0),
      isolatedRoot: isolationPlan.roots[0].physicalRoot, virtualRoot: isolationPlan.roots[0].logicalRoot,
    }));
  }
  const restart = await page.evaluate(async ({ pluginId }) => {
    await app.plugins.disablePluginAndSave(pluginId); await app.plugins.saveConfig();
    return { enabled: app.plugins.enabledPlugins.has(pluginId), loaded: Boolean(app.plugins.plugins[pluginId]) };
  }, { pluginId: PLUGIN_ID });
  assert.equal(restart.enabled, false);
  assert.equal(restart.loaded, false);
  await waitForPersistedPluginState(false, "plugin restart disabled config stable twice");
  // This case tests a plugin restart in the same owned renderer. It does not
  // claim an application-process restart; the ROOT-owned app remains open.
  await page.evaluate(() => {
    if (window.__nativeLearningLoopIsolation?.restore?.() !== true) throw new Error("Could not restore the owned adapter before reinstall.");
    delete window.__sidecarNative07;
  });
  const reinstalledSource = serializeNativeLearningLoopIsolationInstaller(isolationPlan);
  const reinstalled = await page.evaluate(source => (0, eval)(`(function(){${source}})()`), reinstalledSource);
  assert.ok(reinstalled?.includes?.(runId));
  await page.evaluate(async pluginId => { await app.plugins.enablePluginAndSave(pluginId); await app.plugins.saveConfig(); }, PLUGIN_ID);
  const restartedPlugin = await waitFor("plugin restart after route persistence", appIdentity,
    state => state.pluginActive && state.pluginVersion === expectedManifest.version);
  assert.equal(restartedPlugin.syncEnabled, false);
  await installMaintenanceLogger();
  runtimeSettingsChanged = true;
  await page.evaluate(({ pluginId }) => {
    const instance = app.plugins.plugins[pluginId];
    instance.settings.autoSave = false;
  }, { pluginId: PLUGIN_ID });
  const restartPdf = await currentPdfRoute(await readItem(learningItems.highlight.itemId));
  const restartMarkdown = await currentMarkdownRoute(mdItem.itemId);
  assert.equal(restartPdf?.sourcePath, currentPdfPath);
  assert.equal(restartMarkdown?.status, "verified");
  assert.equal(restartMarkdown.currentPath, currentMarkdownPath);
  await verifySource(learningItems.highlight.itemId,
    { kind: "annotation", id: learningItems.highlight.source.target.id }, currentPdfPath);
  await verifySource(mdItem.itemId,
    { kind: "markdown", id: mdItem.source.target.id }, currentMarkdownPath, { markdown: true });
  const restartInvariant = await compareInvariantAfterMove("restart");
  report.routeScenarios.push({ name: "restart", status: "passed", scope: "plugin-reload",
    actualProcessRestart: false, at: new Date().toISOString(), restart,
    pluginVersion: restartedPlugin.pluginVersion, routes: { pdf: restartPdf, markdown: restartMarkdown },
    invariant: restartInvariant });
  await checkpoint("route-restart-passed");
}

async function assertIsolationEvidence() {
  adapterCalls = await page.evaluate(() => window.__nativeLearningLoopIsolation?.calls || []);
  assertNativeLearningLoopAdapterEvidence(adapterCalls, isolationPlan);
  report.stores.adapterCallCount = adapterCalls.length;
  report.stores.writeCount = adapterCalls.filter(call => call.write).length;
  report.stores.unmappedWriteCount = 0;
  const physicalPdfFiles = await readNativeSidecarTree(isolationPlan.roots[0].physicalRoot,
    { resolvePath: absoluteVaultPath, rejectPending: true });
  report.stores.pdfDataFileCount = physicalPdfFiles.size;
  report.stores.pdfWalDocuments = [...new Set([...physicalPdfFiles.keys()]
    .filter(file => file.includes("/wal/")).map(file => file.split("/wal/")[1]?.split("/")[0]).filter(Boolean))];
}

async function diagnoseBacklinkCorrelation() {
  const pdfPath = (await currentPdfRoute(learningItems.highlight)).sourcePath;
  const { frame } = await readerFrame(pdfPath);
  await frame.waitForFunction(() => PDFViewerApplication.pdfDocument && PDFViewerApplication.pdfViewer.pagesCount > 1);
  await page.evaluate(pluginId => {
    const plugin = app.plugins.plugins[pluginId];
    const trace = { wire: [], originals: [] };
    const copy = value => { const { token, ...fields } = value || {}; return { ...fields, tokenPresent: typeof token === "string" }; };
    trace.listener = event => {
      const view = [...plugin.views].find(view => view.iframe?.contentWindow === event.source);
      if (view && /reader-backlink-page/u.test(event.data?.type || "")) trace.wire.push({ direction: "viewer-to-host",
        authenticatedSource: true, tokenMatches: event.data.token === view.token, message: copy(event.data) });
    };
    window.addEventListener("message", trace.listener, true);
    for (const view of plugin.views) {
      const original = view.postToViewer;
      trace.originals.push({ view, original });
      view.postToViewer = function(message, ...args) {
        if (/reader-backlink-page/u.test(message?.type || "")) trace.wire.push({ direction: "host-to-viewer",
          tokenMatches: message.token === this.token, message: copy(message) });
        return original.call(this, message, ...args);
      };
    }
    window.__nativeBacklinkWireDiag = trace;
  }, PLUGIN_ID);
  await frame.evaluate(() => {
    const proto = window.PdfReaderInputRuntime.BacklinkInteractionController.prototype;
    const trace = { calls: [], originals: {} };
    for (const name of ["beginPageRequest", "isCurrentPageRequest", "setPageResults"]) {
      const original = proto[name]; trace.originals[name] = original;
      proto[name] = function(message, ...args) {
        const before = this.latestPageRequest ? { ...this.latestPageRequest } : null;
        const result = original.call(this, message, ...args);
        trace.calls.push({ name, message: { ...message }, pendingBefore: before,
          pendingAfter: this.latestPageRequest ? { ...this.latestPageRequest } : null, result });
        return result;
      };
    }
    window.__nativeBacklinkControllerDiag = trace;
  });
  try {
    for (const number of [2, 1]) {
      await frame.click("#pageNumber");
      await page.keyboard.down("Meta"); await page.keyboard.press("a"); await page.keyboard.up("Meta");
      await page.keyboard.type(String(number)); await page.keyboard.press("Enter");
      await frame.waitForFunction(number => PDFViewerApplication.pdfViewer.currentPageNumber === number, {}, number);
      await waitFor(`real page ${number} request wire`, () => page.evaluate(() => window.__nativeBacklinkWireDiag.wire),
        rows => rows.some(row => row.direction === "host-to-viewer" && row.message.pageNumber === number), 8000).catch(error => {
          report.backlinkDiagnosticWaitErrors ||= []; report.backlinkDiagnosticWaitErrors.push(String(error));
        });
    }
    report.backlinkCorrelationDiagnostic = {
      wire: await page.evaluate(() => window.__nativeBacklinkWireDiag.wire),
      controllerCalls: await frame.evaluate(() => window.__nativeBacklinkControllerDiag.calls),
      finalBadgeState: await frame.evaluate(() => ({ page: PDFViewerApplication.pdfViewer.currentPageNumber,
        badges: [...document.querySelectorAll(".pdfReaderBacklinkPageBadge")].map(node => node.textContent) })),
    };
    await recordScreen("backlink-correlation-diagnostic-page1");
  } finally {
    await frame.evaluate(() => {
      const trace = window.__nativeBacklinkControllerDiag;
      for (const [name, original] of Object.entries(trace.originals)) window.PdfReaderInputRuntime.BacklinkInteractionController.prototype[name] = original;
      delete window.__nativeBacklinkControllerDiag;
    });
    await page.evaluate(() => {
      const trace = window.__nativeBacklinkWireDiag;
      window.removeEventListener("message", trace.listener, true);
      for (const { view, original } of trace.originals) view.postToViewer = original;
      delete window.__nativeBacklinkWireDiag;
    });
  }
}

async function exerciseNavigationDirections() {
  const pdfRoute = await currentPdfRoute(learningItems.highlight);
  const mdFlow = report.uiFlows.find(flow => flow.name === "Markdown selected excerpt -> Add Review");
  learningItems.markdown = await readItem(mdFlow.itemId);
  const mdRoute = await currentMarkdownRoute(mdFlow.itemId);
  const pdfPath = pdfRoute.sourcePath, markdownPath = mdRoute.currentPath;
  const initialFrame = (await readerFrame(pdfPath)).frame;
  await initialFrame.waitForFunction(() => PDFViewerApplication.pdfDocument && PDFViewerApplication.pdfViewer.pagesCount > 0);
  const baseline = await snapshotVocabularyInvariant();
  const walSnapshot = async () => {
    const files = await readNativeSidecarTree(isolationPlan.roots[0].physicalRoot,
      { resolvePath: absoluteVaultPath, rejectPending: true });
    return [...files].filter(([name]) => /\.jsonl(?:$|\.archive\.)/u.test(name))
      .map(([name, bytes]) => ({ name, sha256: sha256(bytes), bytes: bytes.length })).sort((a, b) => a.name.localeCompare(b.name));
  };
  const walBefore = await walSnapshot();
  const copiedOffset = await page.evaluate(() => window.__sidecarNative07.copiedLinks.length);
  await openCommand("复制当前 PDF 阅读器链接");
  await waitFor("real Copy Reader Link acknowledgement", () => page.evaluate(() => window.__sidecarNative07.copiedLinks.length), count => count > copiedOffset);
  const link = await page.evaluate(() => require("electron").clipboard.readText());
  assert.ok(link.startsWith(`[[${pdfPath}#`) && link.endsWith("]]"), "Use the exact real Copy Reader Link clipboard result.");
  report.directionProgress = { copiedLink: link };
  await checkpoint("direction-real-copy-reader-link");
  const destination = link.slice(2, -2).split("|")[0];
  const params = new URLSearchParams(destination.slice(destination.indexOf("#") + 1));
  const targetText = params.get("obreader"), targetMatch = /^(ann|sel|page)\.(.+)$/u.exec(targetText || "");
  assert.ok(targetMatch, "Copied link must contain the authenticated enhanced Reader target.");
  const target = { kind: targetMatch[1] === "ann" ? "annotation" : targetMatch[1] === "sel" ? "selection" : "page", id: targetMatch[2] };
  assert.equal(params.get("obdoc"), learningItems.highlight.source.documentId);
  await page.evaluate(async targetPath => await app.workspace.getLeaf(true).openFile(app.vault.getAbstractFileByPath(targetPath)), markdownPath);
  const markdownMode = await page.evaluate(() => app.workspace.activeLeaf.view.getMode?.());
  if (markdownMode === "preview") {
    const toggle = await page.evaluate(() => app.commands.commands["markdown:toggle-preview"].name);
    await openCommand(toggle);
  }
  await page.waitForSelector(".workspace-leaf.mod-active .cm-content", { visible: true });
  let original = await page.evaluate(() => app.workspace.activeLeaf.view.editor.getValue());
  assert.ok(original.includes(MARKDOWN_EXCERPT));
  const previousLinkLine = original.split("\n").findLast(line => line.startsWith("[["));
  if (previousLinkLine && previousLinkLine !== link) {
    // Repair only this harness's previously typed, autocomplete-mutated tail.
    assert.ok(previousLinkLine.includes("reading-open-move.pdf#page="));
    await page.click(".workspace-leaf.mod-active .cm-content");
    await page.keyboard.down("Meta"); await page.keyboard.press("ArrowDown"); await page.keyboard.up("Meta");
    await page.keyboard.press("End");
    await page.keyboard.down("Shift");
    try {
      for (let count = 0; count < previousLinkLine.length + 4; count += 1) {
        const selected = await page.evaluate(() => app.workspace.activeLeaf.view.editor.getSelection());
        if (selected === previousLinkLine) break;
        assert.ok(selected.length <= previousLinkLine.length, "Refuse to delete outside the harness-added malformed link.");
        await page.keyboard.press("ArrowLeft");
      }
    } finally { await page.keyboard.up("Shift"); }
    assert.equal(await page.evaluate(() => app.workspace.activeLeaf.view.editor.getSelection()), previousLinkLine);
    await page.keyboard.press("Backspace");
    original = await page.evaluate(() => app.workspace.activeLeaf.view.editor.getValue());
  }
  await page.click(".workspace-leaf.mod-active .cm-content");
  await page.keyboard.down("Meta"); await page.keyboard.press("ArrowDown"); await page.keyboard.up("Meta");
  await page.keyboard.press("End");
  const cursor = await page.evaluate(() => ({ cursor: app.workspace.activeLeaf.view.editor.getCursor(), last: app.workspace.activeLeaf.view.editor.lineCount() - 1 }));
  assert.equal(cursor.cursor.line, cursor.last, "Append only outside the original learning excerpt.");
  if (!original.includes(link)) {
    await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => require("electron").clipboard.readText()), link);
    await page.keyboard.sendCharacter(link);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.down("Meta"); await page.keyboard.press("s"); await page.keyboard.up("Meta");
  await waitFor("real Markdown editor link append saved", async () => readFile(absoluteVaultPath(markdownPath), "utf8"), text => text.startsWith(original) && text.includes(link));
  report.directionProgress.appendedLink = link;
  report.directionProgress.markdownPath = markdownPath;
  await checkpoint("direction-real-editor-append");
  const previewCommand = await page.evaluate(() => app.commands.commands["markdown:toggle-preview"].name);
  await openCommand(previewCommand);
  await page.waitForSelector("[data-native-matrix-active=\"true\"] .markdown-preview-view a.internal-link", { visible: true });
  const links = await page.$$("[data-native-matrix-active=\"true\"] .markdown-preview-view a.internal-link");
  const matching = [];
  for (const candidate of links) {
    const href = await candidate.evaluate(node => node.getAttribute("data-href") || node.getAttribute("href"));
    if (href === destination) matching.push(candidate); else await candidate.dispose();
  }
  assert.equal(matching.length, 1, "Click the one real rendered copied link.");
  const beforeNavigation = await page.evaluate(pluginId => [...app.plugins.plugins[pluginId].views].map(view => view.lastReaderNavigationResult || null), PLUGIN_ID);
  await matching[0].click();
  const accepted = await waitFor("Markdown clicked link exact current PDF receipt", () => page.evaluate(({ pluginId, documentId }) => {
    const view = [...app.plugins.plugins[pluginId].views].find(view => view.documentId === documentId);
    return view ? { documentId: view.documentId, openRequest: view.openRequest, rendererGeneration: view.rendererGeneration,
      receipt: view.lastReaderNavigationResult || null } : null;
  }, { pluginId: PLUGIN_ID, documentId: params.get("obdoc") }), state => state?.receipt?.ok === true &&
    state.receipt.targetId === target.id && state.receipt.kind === target.kind &&
    state.receipt.documentId === state.documentId && state.receipt.openRequest === state.openRequest &&
    state.receipt.rendererGeneration === state.rendererGeneration &&
    !beforeNavigation.some(row => row?.requestId === state.receipt.requestId && row?.rendererGeneration === state.receipt.rendererGeneration));
  report.directionProgress.markdownToPdf = accepted;
  await checkpoint("direction-real-markdown-to-pdf-passed");
  await recordScreen("direction-markdown-to-pdf");
  let { frame } = await readerFrame(pdfPath);
  await frame.waitForSelector(".pdfReaderBacklinkPageBadge", { visible: true, timeout: 15000 }).catch(async error => {
    report.backlinkDiagnostic = await page.evaluate(({ pluginId, documentId }) => {
      const plugin = app.plugins.plugins[pluginId];
      return { indexReady: plugin.readerBacklinkIndexReady, revision: plugin.readerBacklinkIndex?.revision,
        rows: plugin.readerBacklinkIndex?.getDocument("0cd915c44ec9", documentId),
        views: [...plugin.views].map(view => ({ documentId: view.documentId, openRequest: view.openRequest,
          rendererGeneration: view.rendererGeneration, currentPageNumber: view.currentPageNumber,
          pageRequest: view.readerBacklinkPageRequest, hydration: view.annotationHydrationAllowed })) };
    }, { pluginId: PLUGIN_ID, documentId: params.get("obdoc") });
    report.backlinkFrameDiagnostic = await frame.evaluate(() => ({ page: PDFViewerApplication.pdfViewer.currentPageNumber,
      badges: [...document.querySelectorAll(".pdfReaderBacklinkPageBadge")].map(node => ({ text: node.textContent,
        rect: node.getBoundingClientRect().toJSON() })) }));
    throw error;
  });
  const badgeText = await frame.$eval(".pdfReaderBacklinkPageBadge", node => node.textContent);
  await frame.click(".pdfReaderBacklinkPageBadge");
  const backlink = await waitFor("PDF page badge exact Markdown link span", () => page.evaluate(() => ({
    path: app.workspace.activeLeaf?.view?.file?.path, selection: app.workspace.activeLeaf?.view?.editor?.getSelection?.(),
    cursor: app.workspace.activeLeaf?.view?.editor?.getCursor?.(),
  })), state => state.path === markdownPath && state.selection === link);
  await recordScreen("direction-pdf-badge-to-markdown");
  await verifySource(learningItems.highlight.itemId, learningItems.highlight.source.target, pdfPath);
  ({ frame } = await readerFrame(pdfPath));
  const sidebarHidden = await frame.$eval("#pdfReaderAnnotationSidebarMenu", node => node.classList.contains("hidden"));
  if (sidebarHidden) await frame.click("#pdfReaderAnnotationSidebarButton");
  const rowSelector = `#editorCommentsSidebarList li.sidebarComment[data-uuid="${learningItems.highlight.source.target.id}"]`;
  await frame.waitForSelector(`${rowSelector} .pdfReaderAnnotationSidebarNavigate`, { visible: true });
  await frame.click(`${rowSelector} .pdfReaderAnnotationSidebarNavigate`);
  const sidebar = await waitFor("Sidebar navigate same durable Highlight UUID", () => frame.$eval(rowSelector, row => ({ uuid: row.dataset.uuid,
    selected: row.classList.contains("selected"), text: row.querySelector(".sidebarCommentText")?.textContent })), row => row.selected === true);
  assert.equal(sidebar.uuid, learningItems.highlight.source.target.id);
  assert.equal(sidebar.text, HIGHLIGHT_TEXT);
  await recordScreen("direction-sidebar-same-highlight");
  const after = await snapshotVocabularyInvariant();
  assertNativeLearningLoopInvariantUnchanged(baseline, after, "additional navigation directions");
  const walAfter = await walSnapshot();
  assert.deepEqual(walAfter, walBefore, "Link/backlink/Sidebar navigation must not append Annotation WAL operations.");
  report.navigationDirections = { status: "passed", clipboardLink: link, target, markdownToPdf: accepted,
    pdfBadgeToMarkdown: { badgeText, ...backlink }, sidebarSameHighlight: sidebar,
    vocabularyBytesUnchanged: true, annotationWalBytesUnchanged: true, baseline, walBefore, walAfter,
    learningExcerptUnchanged: (await readFile(absoluteVaultPath(markdownPath), "utf8")).includes(MARKDOWN_EXCERPT) };
}

async function controlledCloseMatrixReaders(label) {
  const views = (await appIdentity()).readerViews;
  const results = [];
  for (let index = 0; index < views.length; index += 1) results.push(await completeNativeControlledClose({
    runSerialized: async (fn, arg) => page.evaluate(({ source, arg }) => (0, eval)(`(${source})`)(arg), { source: fn.toString(), arg }),
    waitFor,
    loadFiles: root => readNativeSidecarTree(root, { resolvePath: absoluteVaultPath, rejectPending: true }),
    readWalEvidence: readNativeWalEvidence,
    hash: bytes => `xxh64-v1:${h64Raw(bytes).toString(16).padStart(16, "0")}`,
    filePath: views[index].path, expectedRemaining: views.slice(index + 1).filter(row => row.path === views[index].path).length,
    label, maintenanceOffset: await page.evaluate(() => window.__sidecarNative07?.maintenance?.length || 0),
    isolatedRoot: isolationPlan.roots[0].physicalRoot, virtualRoot: isolationPlan.roots[0].logicalRoot,
  }));
  return results;
}

async function quickOpenOwnedMarkdown(markdownPath) {
  assertFixturePath(markdownPath);
  await closeOwnedMarkdownTabs(markdownPath, "before-fresh-QuickOpen");
  const openButton = await page.$('.empty-state-action[aria-label="打开文件"]');
  if (openButton && await openButton.evaluate(node => node.getBoundingClientRect().width > 0)) await openButton.click();
  else {
    await page.click(".workspace-tab-header.is-active");
    await page.keyboard.down("Meta");
    try { await page.keyboard.press("o"); } finally { await page.keyboard.up("Meta"); }
  }
  await page.waitForSelector(".prompt-input", { visible: true });
  await page.type(".prompt-input", markdownPath, { delay: 1 });
  await waitFor("QuickOpen exact fixture candidate", () => page.evaluate(() => [...document.querySelectorAll(".suggestion-item")].filter(n=>n.getBoundingClientRect().width).map(n=>n.innerText)), rows => rows.length === 1);
  await page.keyboard.press("Enter");
  await waitFor("QuickOpen exact Markdown UI owner", () => page.evaluate(() => ({ path:app.workspace.activeLeaf.view.file?.path, type:app.workspace.activeLeaf.view.getViewType(), visible:app.workspace.activeLeaf.view.containerEl.getBoundingClientRect().width })), state => state.path === markdownPath && state.type === "markdown" && state.visible > 0);
}

async function closeOwnedMarkdownTabs(markdownPath, label) {
  assertFixturePath(markdownPath);
  const before = await readFile(absoluteVaultPath(markdownPath));
  const result = await page.evaluate(async markdownPath => {
    const leaves = app.workspace.getLeavesOfType("markdown").filter(leaf => leaf.view?.file?.path === markdownPath);
    const closedLeafIds = leaves.map(leaf => leaf.id);
    for (const leaf of leaves) await leaf.detach();
    await app.workspace.saveLayout();
    return { closedLeafIds, remaining: app.workspace.getLeavesOfType("markdown").filter(leaf => leaf.view?.file?.path === markdownPath).length };
  }, markdownPath);
  assert.equal(result.remaining, 0);
  assert.deepEqual(await readFile(absoluteVaultPath(markdownPath)), before, `${label} own Markdown tab cleanup preserves exact bytes`);
  return { label, markdownPath, ...result, bytesUnchanged: true, sha256: sha256(before) };
}

async function installEditorRoutePassiveProbe() {
  await page.evaluate(pluginId => {
    const state = window.__nativeEditorRouteProbe = { calls: [], restores: [], startedAt: Date.now() };
    const copy = value => { try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); } };
    const wrap = (owner, name, label) => {
      if (!owner || typeof owner[name] !== "function") { state.calls.push({ label, missing: true }); return; }
      const original = owner[name], hadOwn = Object.hasOwn(owner, name);
      const wrapper = function(...args) {
        state.calls.push({ label, args: args.map(copy), at: Date.now(), receiverPath: this.view?.file?.path || this.file?.path,
          target: copy(this.readerPendingNavigationTarget || this.pendingNavigationTarget || this.currentTarget) });
        return Reflect.apply(original, this, args);
      };
      owner[name] = wrapper;
      state.restores.push(() => { if (owner[name] === wrapper) { if (hadOwn) owner[name] = original; else delete owner[name]; } });
    };
    wrap(Object.getPrototypeOf(app.workspace.activeLeaf), "setViewState", "WorkspaceLeaf.setViewState");
    const reader = [...app.plugins.plugins[pluginId].views][0];
    wrap(Object.getPrototypeOf(reader), "setEphemeralState", "PdfReaderView.setEphemeralState");
  }, PLUGIN_ID);
}

async function checkFiveNavigationDirections(stage) {
  const pdfPath = (await currentPdfRoute(learningItems.highlight)).sourcePath;
  const markdownPath = (await currentMarkdownRoute(learningItems.markdown.itemId)).currentPath;
  const highlightSource = await verifySource(learningItems.highlight.itemId, learningItems.highlight.source.target, pdfPath);
  const markdownReview = await verifySource(learningItems.markdown.itemId, learningItems.markdown.source.target, markdownPath, { markdown: true });
  await controlledCloseMatrixReaders(`${stage}-before-markdown-link`);
  const text = await readFile(absoluteVaultPath(markdownPath), "utf8");
  const links = text.match(/\[\[[^\n]*#page=[^\n]*obreader=[^\n]*\]\]/gu) || [];
  assert.equal(links.length, 1, "Reuse the one actual Copy Reader Link already pasted through editor UI.");
  const link = links[0], destination = link.slice(2, -2).split("|")[0];
  const params = new URLSearchParams(destination.slice(destination.indexOf("#") + 1));
  assert.equal(params.get("obdoc"), learningItems.highlight.source.documentId);
  const active = await page.evaluate(expected => {
    const view = app.workspace.activeLeaf.view, rect = view.containerEl.getBoundingClientRect();
    if (view.getViewType() !== "markdown" || view.file.path !== expected || !view.containerEl.isConnected || !rect.width) throw Error("Wrong Markdown UI owner");
    for (const el of document.querySelectorAll("[data-native-matrix-active]")) delete el.dataset.nativeMatrixActive;
    view.containerEl.dataset.nativeMatrixActive = "true";
    return { path: view.file.path, mode: view.getMode() };
  }, markdownPath);
  const oldReceipts = await page.evaluate(pluginId => [...app.plugins.plugins[pluginId].views].map(view => view.lastReaderNavigationResult), PLUGIN_ID);
  if (!process.argv.includes("--editor-route-passive-diagnostic")) {
    if (active.mode !== "preview") await page.click('[data-native-matrix-active="true"] .view-action[aria-label*="切换至阅读视图"]');
    await page.waitForSelector('[data-native-matrix-active="true"] .markdown-preview-view a.internal-link', { visible: true, timeout: 10000 });
    const handles = await page.$$('[data-native-matrix-active="true"] .markdown-preview-view a.internal-link');
    const matches = [];
    for (const handle of handles) {
      if (await handle.evaluate((node, destination) => (node.getAttribute("data-href") || node.getAttribute("href")) === destination && node.getBoundingClientRect().width > 0, destination)) matches.push(handle);
      else await handle.dispose();
    }
    assert.equal(matches.length, 1, "Persisted enhanced wiki must match one visible actual ReadingView anchor");
    await matches[0].click();
  } else {
  if (active.mode === "preview") await page.click('[data-native-matrix-active="true"] .view-action[aria-label*="切换至编辑视图"]');
  const alias = link.slice(2, -2).split("|")[1];
  const handles = await page.$$('[data-native-matrix-active="true"] .cm-link-alias .cm-underline');
  const matches = [];
  for (const handle of handles) {
    if (await handle.evaluate((node, alias) => node.textContent === alias && node.getBoundingClientRect().width > 0, alias)) matches.push(handle);
    else await handle.dispose();
  }
  assert.equal(matches.length, 1, "Actual persisted wiki alias must be uniquely visible in the owned Markdown editor");
  await page.keyboard.down("Meta");
  try { await matches[0].click(); } finally { await page.keyboard.up("Meta"); }
  }
  if (process.argv.includes("--editor-route-passive-diagnostic")) {
    await waitFor("passive actual editor open Reader", appIdentity, state => state.readerViews.length === 1);
    await readerFrame(pdfPath);
    await recordScreen("editor-route-passive-first-open");
    report.editorRoutePassive = await page.evaluate(pluginId => ({ calls: window.__nativeEditorRouteProbe.calls,
      readers: [...app.plugins.plugins[pluginId].views].map(view => ({ path: view.file?.path, documentId: view.documentId,
        openRequest: view.openRequest, rendererGeneration: view.rendererGeneration, receipt: view.lastReaderNavigationResult,
        target: view.readerPendingNavigationTarget || view.pendingNavigationTarget || null })) }), PLUGIN_ID);
    report.editorRoutePassive.link = link;
    return report.editorRoutePassive;
  }
  const markdownToPdf = await waitFor(`${stage} exact Markdown-to-PDF receipt`, () => page.evaluate(({ pluginId, documentId }) => {
    const view = [...app.plugins.plugins[pluginId].views].find(view => view.documentId === documentId);
    return view ? { documentId: view.documentId, openRequest: view.openRequest, rendererGeneration: view.rendererGeneration,
      receipt: view.lastReaderNavigationResult } : null;
  }, { pluginId: PLUGIN_ID, documentId: params.get("obdoc") }), state => state?.receipt?.ok === true &&
    state.receipt.requestId && state.receipt.documentId === state.documentId && state.receipt.openRequest === state.openRequest &&
    state.receipt.rendererGeneration === state.rendererGeneration && state.receipt.kind === "page" && state.receipt.targetId === "ref:2R" &&
    !oldReceipts.some(row => row?.requestId === state.receipt.requestId && row?.rendererGeneration === state.receipt.rendererGeneration));
  await recordScreen(`${stage}-markdown-to-pdf`);
  let { frame } = await readerFrame(pdfPath);
  await frame.waitForSelector(".pdfReaderBacklinkPageBadge", { visible: true, timeout: 15000 });
  const badge = await frame.$eval(".pdfReaderBacklinkPageBadge", node => node.textContent);
  await frame.click(".pdfReaderBacklinkPageBadge");
  const backlinkToMarkdown = await waitFor(`${stage} exact backlink source span`, () => page.evaluate(() => ({
    path: app.workspace.activeLeaf?.view?.file?.path, selection: app.workspace.activeLeaf?.view?.editor?.getSelection?.(),
  })), state => state.path === markdownPath && state.selection === link);
  await recordScreen(`${stage}-backlink-to-markdown`);
  await verifySource(learningItems.highlight.itemId, learningItems.highlight.source.target, pdfPath);
  ({ frame } = await readerFrame(pdfPath));
  if (await frame.$eval("#pdfReaderAnnotationSidebarMenu", node => node.classList.contains("hidden"))) await frame.click("#pdfReaderAnnotationSidebarButton");
  const row = `#editorCommentsSidebarList li.sidebarComment[data-uuid="${learningItems.highlight.source.target.id}"]`;
  await frame.waitForSelector(`${row} .pdfReaderAnnotationSidebarNavigate`, { visible: true });
  await frame.click(`${row} .pdfReaderAnnotationSidebarNavigate`);
  const sidebar = await waitFor(`${stage} Sidebar exact UUID`, () => frame.$eval(row, node => ({ uuid: node.dataset.uuid,
    selected: node.classList.contains("selected"), text: node.querySelector(".sidebarCommentText")?.textContent })), state => state.selected);
  assert.equal(sidebar.uuid, learningItems.highlight.source.target.id); assert.equal(sidebar.text, HIGHLIGHT_TEXT);
  await recordScreen(`${stage}-sidebar-highlight`);
  await frame.click("#pdfReaderAnnotationSidebarButton");
  const fullContext = [...report.uiFlows].reverse().find(flow => flow.selectionScope === "complete sentence");
  const contextItem = await readItem(fullContext.itemId);
  const contextSource = await verifySource(contextItem.itemId, contextItem.source.target, pdfPath);
  ({ frame } = await readerFrame(pdfPath));
  contextSource.exactAnchorText = await frame.evaluate(() => [...(window.CSS?.highlights?.get("pdfReaderAnchorFocusText") || [])].map(range => range.toString()).join(""));
  assert.equal(contextSource.exactAnchorText, fullContext.exactQuote);
  await recordScreen(`${stage}-context-pdf`);
  return { highlightSource, markdownReview, markdownToPdf, backlinkToMarkdown: { badge, ...backlinkToMarkdown }, sidebar, contextSource,
    paths: { pdfPath, markdownPath }, currentLink: link };
}

async function runCompleteFiveDirectionMatrix() {
  const mdFlow = report.uiFlows.find(flow => flow.name === "Markdown selected excerpt -> Add Review");
  learningItems.markdown = await readItem(mdFlow.itemId);
  let fullContextFlow = [...report.uiFlows].reverse().find(flow => flow.selectionScope === "complete sentence" && flow.contextId);
  if (!fullContextFlow) {
    const route = await currentPdfRoute(learningItems.highlight);
    await createContextLearningItem(route.sourcePath, { completeSentence: true });
    fullContextFlow = [...report.uiFlows].reverse().find(flow => flow.selectionScope === "complete sentence" && flow.contextId);
  }
  assert.ok(fullContextFlow?.itemId && fullContextFlow?.exactQuote,
    "The five-direction matrix requires a real complete-sentence Context Review item before any stage can pass.");
  learningItems.context = await readItem(fullContextFlow.itemId);
  assert.equal(learningItems.context.source.targetText, fullContextFlow.exactQuote);
  await verifySource(learningItems.context.itemId, learningItems.context.source.target,
    (await currentPdfRoute(learningItems.context)).sourcePath);
  const baseline = await snapshotVocabularyInvariant();
  assert.ok(!baseline.files.some(row => /\.pending(?:\.json)?$/u.test(row.path)));
  const defaultBaseline = JSON.parse(await readFile(path.join(ROOT, "evidence/native-final-resume/default-trees-controlled-baseline.json"), "utf8"));
  const defaultSnapshot = async () => {
    const files = [];
    const visit = async root => {
      for (const entry of await readdir(absoluteVaultPath(root), { withFileTypes: true })) {
        const child = `${root}/${entry.name}`;
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile()) { const bytes = await readFile(absoluteVaultPath(child)); files.push({ path: child, bytes: bytes.length, sha256: sha256(bytes) }); }
      }
    };
    for (const root of defaultBaseline.roots) await visit(root);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  };
  const sortedDefault = [...defaultBaseline.files].sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(await defaultSnapshot(), sortedDefault);
  const completedStages = resumeEvidence
    ? assertNativeResumeCandidate(report.candidateArtifact?.files, resumeEvidence)
    : [];
  report.completeDirectionMatrix = { scope: "five actual UI directions at each additional stage; old eight Source-only stages retained separately",
    baseline, defaultFileCount: sortedDefault.length, stages: completedStages };
  const stage = async (name, action) => {
    if (completedStages.some(row => row.name === name && row.status === "passed")) return;
    assertNativeLearningLoopInvariantUnchanged(baseline, await snapshotVocabularyInvariant(), `${name} before move`);
    await action();
    await waitFor(`${name} PDF route resolves existing moved file`, async () => {
      const route = await currentPdfRoute(learningItems.highlight);
      return page.evaluate(sourcePath => ({ sourcePath, exists: !!app.vault.getAbstractFileByPath(sourcePath) }), route.sourcePath);
    }, state => state.exists);
    await waitFor(`${name} Markdown route resolves existing moved file`, async () => {
      const route = await currentMarkdownRoute(learningItems.markdown.itemId);
      return page.evaluate(currentPath => ({ currentPath, exists: !!app.vault.getAbstractFileByPath(currentPath) }), route.currentPath);
    }, state => state.exists);
    const directions = await checkFiveNavigationDirections(name);
    assertNativeLearningLoopInvariantUnchanged(baseline, await snapshotVocabularyInvariant(), `${name} after five directions`);
    const closes = await controlledCloseMatrixReaders(name);
    const markdownCleanup = await closeOwnedMarkdownTabs(directions.paths.markdownPath, name);
    assert.deepEqual(await defaultSnapshot(), sortedDefault, `${name} must not write default data trees`);
    const currentPdf = (await currentPdfRoute(learningItems.highlight)).sourcePath;
    assert.equal(sha256(await readFile(absoluteVaultPath(currentPdf))), report.fixtures.originalPdfSha256);
    report.completeDirectionMatrix.stages.push({ name, status: "passed", directions, closes, markdownCleanup,
      canonicalBytesUnchanged: true, defaultTreesUnchanged: true, sourcePdfUnchanged: true });
    await checkpoint(`complete-five-directions-${name}-passed`);
  };
  await controlledCloseMatrixReaders("matrix-precondition");
  await stage("full-pdfrename", async () => { const route = await currentPdfRoute(learningItems.highlight); await renameOwnedPath(route.sourcePath, `${path.posix.dirname(route.sourcePath)}/reading-full-renamed.pdf`); });
  await stage("full-foldermove", async () => { const route = await currentPdfRoute(learningItems.highlight); await renameOwnedPath(path.posix.dirname(route.sourcePath), `${fixturePrefix}/Full Matrix PDF Moved`); });
  await stage("full-mdrename", async () => { const route = await currentMarkdownRoute(learningItems.markdown.itemId); await renameOwnedPath(route.currentPath, `${path.posix.dirname(route.currentPath)}/learning-full-renamed.md`); });
  await stage("full-mdmove", async () => { const route = await currentMarkdownRoute(learningItems.markdown.itemId); await makeOwnedFolder(`${fixturePrefix}/Full Matrix MD Moved`); await renameOwnedPath(route.currentPath, `${fixturePrefix}/Full Matrix MD Moved/learning-full-renamed.md`); });
  await stage("full-bothmove", async () => { const pdf = await currentPdfRoute(learningItems.highlight); const md = await currentMarkdownRoute(learningItems.markdown.itemId);
    await makeOwnedFolder(`${fixturePrefix}/Full Matrix Both MD`); await renameOwnedPath(path.posix.dirname(pdf.sourcePath), `${fixturePrefix}/Full Matrix Both PDF`);
    await renameOwnedPath(md.currentPath, `${fixturePrefix}/Full Matrix Both MD/learning-full-renamed.md`); });
  await stage("full-closedmove", async () => { const pdf = await currentPdfRoute(learningItems.highlight); await renameOwnedPath(pdf.sourcePath, `${path.posix.dirname(pdf.sourcePath)}/reading-full-closed.pdf`); });
  await stage("full-openmove", async () => { const pdf = await currentPdfRoute(learningItems.highlight); await verifySource(learningItems.highlight.itemId, learningItems.highlight.source.target, pdf.sourcePath);
    await renameOwnedPath(pdf.sourcePath, `${path.posix.dirname(pdf.sourcePath)}/reading-full-open.pdf`); });
  if (!process.argv.includes("--after-owned-process-restart")) {
    report.completeDirectionMatrix.status = "awaiting-owned-process-restart";
    report.completeDirectionMatrix.processRestartPending = { ownerPid: native.ownerPid, cdpPort: native.port, profileRoot: native.profileRoot,
      appExecutable: native.appExecutable, ownerCommandHash: native.ownerCommandHash,
      candidateFiles: report.candidateArtifact.files,
      installedFiles: report.candidateArtifact.installedFiles,
      note: "ROOT must safely restart the exact owned process after final cleanup; plugin toggles do not satisfy this stage." };
    await checkpoint("seven-full-stages-awaiting-ROOT-owned-process-restart");
    return;
  }
  const previous = resumeEvidence.completeDirectionMatrix.processRestartPending;
  assert.ok(previous && Number.isInteger(previous.ownerPid));
  assert.notEqual(native.ownerPid, previous.ownerPid, "Formal restart requires a different actual owned main PID");
  assert.equal(native.profileRoot, previous.profileRoot);
  assert.equal(native.appExecutable, previous.appExecutable);
  assertNativeCandidateFiles(report.candidateArtifact.files, previous.candidateFiles);
  assertNativeCandidateFiles(report.candidateArtifact.files, previous.installedFiles);
  const previousProcess = ownedProcessForPid(previous.ownerPid, previous.profileRoot, native.appExecutable, previous.cdpPort);
  assert.equal(previousProcess.ownedProfileProcess, false,
    "A new PID is insufficient: the previous owned Obsidian process for this profile must no longer be running.");
  await stage("full-owned-process-restart", async () => {});
  report.completeDirectionMatrix.status = "passed";
  report.completeDirectionMatrix.restartScope = "actual owned Obsidian process restart by ROOT, independently verified new main PID";
  report.completeDirectionMatrix.processRestart = { kind: "owned-process-restart", previous,
    previousProcessExited: !previousProcess.ownedProfileProcess,
    previousProcessState: previousProcess,
    currentOwnerPid: native.ownerPid, currentOwnerCommandHash: native.ownerCommandHash,
    currentCdpPort: native.port, profileRoot: native.profileRoot };

}

async function captureNativeEvidence() {
  await assertIsolationEvidence();
  const active = await appIdentity();
  report.identity = active;
  report.sync = { enabled: active.syncEnabled, off: active.syncEnabled === false };
  assert.equal(report.sync.off, true);
  assert.equal(active.vault, EXPECTED_VAULT);
  assert.equal(active.configDir, ".obsidian");
  await recordScreen("final-today-review");
  const finalRoute = await currentPdfRoute(learningItems.highlight);
  assertFixturePath(finalRoute.sourcePath);
  report.fixtures.finalPdfPath = finalRoute.sourcePath;
  report.fixtures.finalPdfSha256 = sha256(await readFile(absoluteVaultPath(finalRoute.sourcePath)));
  assert.equal(report.fixtures.finalPdfSha256, report.fixtures.originalPdfSha256,
    "The physically moved PDF must remain byte-identical after every UI action and route move.");
  const sourcePdf = await readFile(absoluteVaultPath(report.fixtures.pdfPath)).catch(error => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  report.fixtures.originalPdfUnchanged = sourcePdf == null
    ? "renamed test copy; source fixture remains unchanged"
    : sha256(sourcePdf) === report.fixtures.originalPdfSha256;
  await persistReport();
}

async function cleanupNativeRun() {
  if (!page || !browser || !isolationPlan) return;
  const before = await page.evaluate(({ pluginId, viewType }) => ({
    vault: app.vault?.adapter?.basePath || null,
    configDir: app.vault?.configDir || null,
    syncEnabled: app.internalPlugins?.plugins?.sync?.enabled ?? null,
    pluginActive: Boolean(app.plugins.plugins[pluginId]),
    enabledPlugins: [...(app.plugins.enabledPlugins || [])],
    views: [...(app.plugins.plugins[pluginId]?.views || [])].map(view => ({
      path: view.requestedPath || view.file?.path || view.documentFile?.path || null,
      token: view.token || null,
    })),
    workspaceViewCount: app.workspace.getLeavesOfType(viewType).length,
  }), { pluginId: PLUGIN_ID, viewType: VIEW_TYPE });
  if (before.vault !== EXPECTED_VAULT || before.configDir !== ".obsidian" || before.syncEnabled !== false) {
    report.cleanup = { status: "skipped", reason: "owned-vault-or-sync-precondition-changed", before };
    return;
  }
  if (before.views.some(view => !view.path?.startsWith(`${fixturePrefix}/`))) {
    report.cleanup = { status: "skipped", reason: "unrelated-reader-view-present", before };
    return;
  }

  const closeResults = [];
  for (let index = 0; index < before.views.length; index += 1) {
    const view = before.views[index];
    assertFixturePath(view.path);
    const remainingSamePath = before.views.slice(index + 1)
      .filter(candidate => candidate.path === view.path).length;
    const close = await completeNativeControlledClose({
      runSerialized: async (fn, arg) => page.evaluate(({ source, arg }) =>
        (0, eval)(`(${source})`)(arg), { source: fn.toString(), arg }),
      waitFor,
      loadFiles: root => readNativeSidecarTree(root, { resolvePath: absoluteVaultPath, rejectPending: true }),
      readWalEvidence: readNativeWalEvidence,
      hash: bytes => `xxh64-v1:${h64Raw(bytes).toString(16).padStart(16, "0")}`,
      filePath: view.path,
      targetToken: view.token,
      expectedRemaining: remainingSamePath,
      label: `cleanup-${view.path}`,
      maintenanceOffset: await page.evaluate(() => window.__sidecarNative07?.maintenance?.length || 0),
      isolatedRoot: isolationPlan.roots[0].physicalRoot,
      virtualRoot: isolationPlan.roots[0].logicalRoot,
    });
    closeResults.push(close);
  }
  const afterClose = await appIdentity();
  let adapterEvidence;
  try {
    await assertIsolationEvidence();
    adapterEvidence = {
      status: "verified",
      adapterCallCount: report.stores.adapterCallCount,
      writeCount: report.stores.writeCount,
      pdfDataFileCount: report.stores.pdfDataFileCount,
      pdfWalDocuments: report.stores.pdfWalDocuments,
    };
  } catch (error) {
    adapterEvidence = { status: "failed", error: error?.stack || String(error) };
  }
  if (afterClose.readerViews.length !== 0) {
    report.cleanup = { status: "incomplete", reason: "Reader-view-remains-after-controlled-close", before,
      closeResults, afterClose, adapterEvidence };
    return;
  }

  if (attachedExistingTestVault && report.fixtures?.markdownPath) {
    report.attachedMode.finalMarkdownCleanup = await closeOwnedMarkdownTabs(report.fixtures.markdownPath, "attached-final-cleanup");
  }
  await page.evaluate(async pluginId => { await app.plugins.disablePluginAndSave(pluginId); await app.plugins.saveConfig(); }, PLUGIN_ID);
  const disabled = await appIdentity();
  if (disabled.pluginActive || disabled.enabledPlugins.includes(PLUGIN_ID) || disabled.readerViews.length !== 0) {
    report.cleanup = { status: "incomplete", reason: "Plugin-remains-enabled-after-test", before,
      closeResults, disabled, adapterEvidence };
    return;
  }
  await waitForPersistedPluginState(false, "cleanup disabled config stable twice before adapter restore");
  const restored = await page.evaluate(runId => {
    const state = window.__nativeLearningLoopIsolation;
    if (!state) return false;
    if (state.runId !== runId) throw new Error(`Refusing to remove foreign isolation ${state.runId}`);
    const ok = state.restore();
    delete window.__sidecarNative07;
    return ok;
  }, runId);
  report.cleanup = { status: "complete", before, closeResults, disabled, adapterEvidence,
    isolationRestored: restored, disabledStatePersisted: true, at: new Date().toISOString() };
}

async function assertSiblingTestVaultProcessesQuiescent() {
  const processLines = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" }).split(/\r?\n/u);
  const siblings = [];
  for (const line of processLines) {
    const match = line.match(/^\s*(\d+)\s+(.+?\.app\/Contents\/MacOS\/Obsidian)\s+--user-data-dir=([^\s]+)/u);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === native.ownerPid) continue;
    const profile = match[3];
    const portText = await readFile(path.join(profile, "DevToolsActivePort"), "utf8").catch(error => {
      if (error?.code === "ENOENT") throw new Error(`Cannot inspect Obsidian sibling PID ${pid}; refusing shared test-Vault writes.`);
      throw error;
    });
    const port = Number(portText.split(/\r?\n/u)[0]);
    assert.ok(Number.isInteger(port) && port > 0, `Sibling PID ${pid} has no valid DevTools port.`);
    const siblingBrowser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
    try {
      const candidates = (await siblingBrowser.pages()).filter(candidate => candidate.url() === APP_URL);
      let matchingVaults = 0;
      for (const candidate of candidates) {
        const state = await candidate.evaluate(pluginId => ({ path: app.vault.adapter.basePath, name: app.vault.getName(),
          loaded: !!app.plugins.plugins[pluginId], enabled: app.plugins.enabledPlugins.has(pluginId),
          readers: app.workspace.getLeavesOfType("pdf-web-reader-view").length, sync: app.internalPlugins.plugins.sync?.enabled }), PLUGIN_ID);
        if (state.path !== EXPECTED_VAULT) continue;
        matchingVaults++;
        siblings.push({ pid, profile, port, ...state });
        assert.equal(state.name, "ObReader-Apple-Test");
        assert.equal(state.loaded, false, `Sibling PID ${pid} has the test plugin loaded.`);
        assert.equal(state.enabled, false, `Sibling PID ${pid} has the test plugin enabled.`);
        assert.equal(state.readers, 0, `Sibling PID ${pid} has a Reader view open.`);
        assert.equal(state.sync, false, `Sibling PID ${pid} has Sync enabled.`);
      }
      assert.ok(matchingVaults <= 1, `Sibling PID ${pid} exposes duplicate test-Vault renderers.`);
    } finally { siblingBrowser.disconnect(); }
  }
  if (attachedExistingTestVault) report.attachedMode.siblingPreflight = siblings;
  else report.nativeProfile.siblingTestVaultProcesses = siblings;
}

async function attachedReadOnlySnapshot(onlyRoot = null) {
  const roots = onlyRoot ? [onlyRoot] : ["00_Archive/20_PDFData", "00_Archive/21_VocabularyData"];
  const files = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(absoluteVaultPath(root), { recursive: true });
    } catch (error) {
      // The preserved-run comparison is optional when that historical run was
      // never present in this test Vault. Missing protected data roots remain
      // an error for the required default snapshot.
      if (onlyRoot && error?.code === "ENOENT") return null;
      throw error;
    }
    for (const relative of entries) {
      const file = `${root}/${relative}`;
      const stat = await import("node:fs/promises").then(fs => fs.stat(absoluteVaultPath(file)));
      if (!stat.isFile()) continue;
      const bytes = await readFile(absoluteVaultPath(file));
      files.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

async function main() {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await mkdir(screenshotDirectory, { recursive: true });
  assert.equal(native.nativeConfig.vault, EXPECTED_VAULT);
  browser = await puppeteer.connect({ browserURL: native.nativeConfig.cdpUrl, defaultViewport: null });
  const pages = await browser.pages();
  const appPages = pages.filter(candidate => candidate.url() === APP_URL);
  if (attachedExistingTestVault) {
    const matched = [];
    report.attachedMode = { enabled: true, temporaryHarnessMode: true,
      processRestart: boundedOpenMoveStage ? "NOT_RUN: bounded open-move stage scope" : "NOT_RUN: shared process ownership",
      excludedRenderers: [] };
    if (boundedOpenMoveStage) {
      assert.equal(appPages.length, 1, "Bounded scratch mode requires exactly one renderer in the bound process/profile.");
      report.boundedStage = { name: "openmove-five-directions", status: "running", scratchVault: EXPECTED_VAULT,
        ownerPid: native.ownerPid, cdpPort: native.port, profileRoot: native.profileRoot };
    }
    for (const candidate of appPages) {
      const identity = await candidate.evaluate(() => ({ path: app.vault.adapter.basePath, name: app.vault.getName() }));
      if (identity.path === EXPECTED_VAULT && identity.name === EXPECTED_VAULT_NAME) matched.push(candidate);
      else report.attachedMode.excludedRenderers.push({ url: candidate.url(), ...identity, action: "excluded; no navigation, interaction, content read, or mutation" });
    }
    assert.equal(matched.length, 1, "Bound Native mode requires exactly one renderer for the configured test vault");
    page = matched[0];
  } else {
    assert.equal(appPages.length, 1, "Owned profile must expose exactly one Obsidian main-window renderer.");
    page = appPages[0];
  }
  page.setDefaultTimeout(15_000);
  page.on("console", message => {
    if (message.type() === "error") {
      report.consoleErrors ||= [];
      report.consoleErrors.push({ text: message.text(), location: message.location(), at: new Date().toISOString() });
    }
  });
  page.on("pageerror", error => report.errors.push({ at: new Date().toISOString(), error: error?.stack || String(error) }));

  const before = await appIdentity();
  native.assertNativeVaultIdentity(before, native.nativeConfig);
  report.identity = before;
  report.foregroundPreflight = { status: "not-verified", policy: "external-cua-selection",
    visibility: before.visibility, focused: before.focused };
  report.foregroundPreflight = assertNativeLearningForeground(before, {
    vault: EXPECTED_VAULT, configDir: native.nativeConfig.configDir, stage: "before Native test mutations",
  });
  await recordCandidateArtifact();
  const continuingNativeMatrix = process.argv.includes("--complete-direction-matrix") ||
    process.argv.includes("--after-owned-process-restart");
  if (process.argv.includes("--after-owned-process-restart")) {
    assert.ok(resumeEvidence, "The process-restart phase requires the saved first-phase Native receipt.");
  }
  if (resumeEvidence && continuingNativeMatrix) {
    const reusableStages = assertNativeResumeCandidate(report.candidateArtifact.files, resumeEvidence);
    report.resumeMatrixEvidence = { status: "verified-current-candidate", reusableStageCount: reusableStages.length,
      releaseFiles: Object.keys(report.candidateArtifact.files).sort() };
  }
  assert.equal(before.syncEnabled, false, "Disable Obsidian Sync before Native acceptance.");
  assert.deepEqual(before.readerViews, [], "Close all Reader tabs before Native acceptance.");
  assert.equal(before.pluginActive, false, "Disable PDF Web Reader before installing write isolation.");
  assert.equal(before.enabledPlugins.includes(PLUGIN_ID), false);
  assert.equal(before.visibility, "visible",
    "Keep the owned Obsidian test window visible; if this is hidden, stop rather than automate another window.");
  if (attachedExistingTestVault) {
    assert.ok(await page.evaluate(() => document.hasFocus() && typeof activeDocument !== "undefined" &&
      activeDocument === document && typeof activeWindow !== "undefined" && activeWindow === window),
    "Attached test window/document owner must exactly match the foreground renderer before writes");
    assert.ok((await page.title()).endsWith(`${EXPECTED_VAULT_NAME} - Obsidian ${native.appVersion}`));
    for (const file of ["main.js", "manifest.json", "styles.css"]) {
      assert.equal(sha256(await readFile(absoluteVaultPath(`.obsidian/plugins/${PLUGIN_ID}/${file}`))),
        sha256(await readFile(path.join(ROOT, "dist", PLUGIN_ID, file))), `Attached bundle ${file} must exactly match integration dist`);
    }
    await waitForPersistedPluginState(false, "attached pre-write disabled config stable twice");
    report.attachedMode.defaultBaseline = await attachedReadOnlySnapshot();
    report.attachedMode.preservedRunBaseline = await attachedReadOnlySnapshot(`.obsidian/plugins/${PLUGIN_ID}/.native-learning-loop/native-learning-loop-20261023142727241-ab1fac1a68`);
  }
  report.identity = before;
  report.sync = { enabled: before.syncEnabled, off: before.syncEnabled === false };
  report.plugin = { ...before, expectedVersion: expectedManifest.version,
    installedManifestVersion: installedManifest.version };
  await recordScreen("preflight-safe-mode");

  if (processOnlyBoundOwnedProfile) {
    assert.equal(scratchVaultMode, true);
    assert.equal(native.marker.allowedVault, EXPECTED_VAULT);
    report.nativeProfile.siblingTestVaultProcesses = "NOT_INSPECTED: isolated scratch vault and process-only mode";
  } else {
    await assertSiblingTestVaultProcessesQuiescent();
  }
  await restoreOwnedStaleIsolation();
  await clearStaleNativeMaintenanceLogger();
  await installNativeIsolation();
  if (settingsUiPreflight) {
    await prepareEmptyIsolationRoots();
    await enablePluginAfterIsolation();
    await openPluginSettingsThroughUI();
    await closeWorkbenchThroughUI();
    const settingsClosed = await closeSettingsThroughUIIfVisible();
    assert.equal(settingsClosed, true, "The Settings overlay must close through its visible UI control.");
    await assertIsolationEvidence();
    report.settingsUiPreflight = {
      status: "passed",
      workbenchEntry: report.workbenchOpenMethod,
      workbenchClosedThroughUI: true,
      settingsClosedThroughUI: true,
      fixtureCount: 0,
      at: new Date().toISOString(),
    };
    report.status = "passed";
    report.completedAt = new Date().toISOString();
    report.recommendation = "Settings UI navigation preflight passed with storage isolation installed and no learning fixtures created.";
    return;
  }
  const fixtures = resumeEvidence ? { ...resumeEvidence.fixtures,
    pdfDirectory: path.posix.dirname(resumeEvidence.fixtures.pdfPath),
    markdownDirectory: path.posix.dirname(resumeEvidence.fixtures.markdownPath) } : await createFixtures();
  if (resumeEvidence) {
    report.fixtures = resumeEvidence.fixtures;
    report.highlight = resumeEvidence.highlight;
    report.uiFlows = resumeEvidence.uiFlows;
    report.routeScenarios = resumeEvidence.routeScenarios || [];
    report.continuation = { previousReport: resumePath, reason: "Context pointer setup overlay; retain proven Highlight chain",
      previousFailure: resumeEvidence.errors, at: new Date().toISOString() };
  }
  await enablePluginAfterIsolation();
  if (resumeEvidence) {
    learningItems.highlight = await readItem(resumeEvidence.uiFlows[0].itemId);
    assert.equal(learningItems.highlight.source.target.id, resumeEvidence.highlight.uuid);
    const persistedPdf = await currentPdfRoute(learningItems.highlight);
    assert.ok(persistedPdf?.sourcePath?.startsWith(`${fixturePrefix}/`));
    fixtures.pdfPath = persistedPdf.sourcePath;
    fixtures.pdfDirectory = path.posix.dirname(fixtures.pdfPath);
    const priorMarkdown = resumeEvidence.uiFlows.find(flow => flow.name === "Markdown selected excerpt -> Add Review");
    if (priorMarkdown) {
      const persistedMarkdown = await currentMarkdownRoute(priorMarkdown.itemId);
      assert.equal(persistedMarkdown.status, "verified");
      assertFixturePath(persistedMarkdown.currentPath);
      fixtures.markdownPath = persistedMarkdown.currentPath;
      fixtures.markdownDirectory = path.posix.dirname(fixtures.markdownPath);
    }
    report.continuation.currentPaths = { pdf: fixtures.pdfPath, markdown: fixtures.markdownPath };
    assert.equal(sha256(await readFile(absoluteVaultPath(fixtures.pdfPath))), fixtures.fixturePdfSha256);
    await openFixture(fixtures.pdfPath);
    await readerFrame(fixtures.pdfPath);
  } else await createHighlightLearningItem(fixtures.pdfPath);
  const provenContexts = resumeEvidence?.uiFlows?.filter(flow => flow.contextId && flow.sourceEvidence?.navigation?.ok) || [];
  const provenContext = [...provenContexts].reverse().find(flow => flow.selectionScope === "complete sentence") || provenContexts.at(-1);
  if (provenContext) {
    learningItems.context = await readItem(provenContext.itemId);
    contexts.dynamic = (await readContextRows(provenContext.familyKey)).find(row => row.contextId === provenContext.contextId);
    assert.ok(contexts.dynamic && learningItems.context.source.target.id === contexts.dynamic.anchorId);
    report.resumedProvenContext = provenContext;
  } else await createContextLearningItem(fixtures.pdfPath);
  if (attachedExistingTestVault) {
    const md = await addMarkdownLearningItem(fixtures.markdownPath);
    learningItems.markdown = md;
    report.uiFlows.push({ name: "Markdown selected excerpt -> Add Review", status: "passed", itemId: md.itemId,
      sourcePath: fixtures.markdownPath, exactQuote: md.source.targetText });
    await createContextLearningItem(fixtures.pdfPath, { completeSentence: true });
    await verifySource(learningItems.highlight.itemId, learningItems.highlight.source.target, fixtures.pdfPath);
    await exerciseNavigationDirections();
    const baseline = await snapshotVocabularyInvariant();
    report.attachedMode.postLearningCanonicalBaseline = baseline;
    const movedPath = `${fixtures.pdfDirectory}/reading-attached-open-move.pdf`;
    await verifySource(learningItems.highlight.itemId, learningItems.highlight.source.target, fixtures.pdfPath);
    await renameOwnedPath(fixtures.pdfPath, movedPath);
    await waitFor("attached exact open-move identity route", () => currentPdfRoute(learningItems.highlight), route => route.sourcePath === movedPath);
    const directions = await checkFiveNavigationDirections("attached-openmove");
    assertNativeLearningLoopInvariantUnchanged(baseline, await snapshotVocabularyInvariant(), "attached openmove five directions");
    const closes = await controlledCloseMatrixReaders("attached-openmove");
    const markdownCleanup = await closeOwnedMarkdownTabs(fixtures.markdownPath, "attached-openmove");
    assert.equal(sha256(await readFile(absoluteVaultPath(movedPath))), report.fixtures.originalPdfSha256);
    report.attachedMode.openMove = { status: "passed", directions, closes, markdownCleanup, canonicalUnchanged: true, sourcePdfUnchanged: true };
    report.fixtures.finalPdfPath = movedPath;
    if (boundedOpenMoveStage) {
      report.boundedStage = { ...report.boundedStage, status: "passed", routeStage: "openmove",
        directions, closes, markdownCleanup, sourcePdfSha256: report.fixtures.originalPdfSha256 };
    }
    await captureNativeEvidence();
    report.status = "passed";
    report.recommendation = boundedOpenMoveStage
      ? "One bounded open-move five-direction stage passed in the disposable scratch vault; remaining matrix stages and real process restart are not run."
      : "Attached E2E and open-move only. Original six-stage run unchanged; real process restart NOT_RUN due shared process.";
    return;
  }
  if (process.argv.includes("--markdown-quick-open-diagnostic") || process.argv.includes("--markdown-source-visibility-diagnostic") || process.argv.includes("--editor-route-passive-diagnostic") || process.argv.includes("--source-checkpoint-only") || process.argv.includes("--navigation-directions-only") || process.argv.includes("--backlink-correlation-diagnostic") || process.argv.includes("--complete-direction-matrix")) {
    report.sourceCheckpointOnly = true;
    report.routesFrozenBytesVerified = resumeEvidence.routesFrozenBytesVerified;
    report.stores.invariantBaseline = resumeEvidence.stores.invariantBaseline;
    if (process.argv.includes("--markdown-quick-open-diagnostic")) {
      const item = await readItem(report.uiFlows.find(flow => flow.name === "Markdown selected excerpt -> Add Review").itemId);
      const route = await currentMarkdownRoute(item.itemId);
      await controlledCloseMatrixReaders("before-QuickOpen-preview-diagnostic");
      await quickOpenOwnedMarkdown(route.currentPath);
      const mode = await page.evaluate(() => { app.workspace.activeLeaf.view.containerEl.dataset.nativeQuickOpen = "true"; return app.workspace.activeLeaf.view.getMode(); });
      if (mode !== "preview") await page.click('[data-native-quick-open="true"] .view-action[aria-label*="切换至阅读视图"]');
      try { await page.waitForSelector('[data-native-quick-open="true"] .markdown-preview-view a.internal-link', { visible:true,timeout:10000 }); } finally {
        report.markdownQuickOpen = await page.evaluate(() => {const v=app.workspace.activeLeaf.view;return{path:v.file?.path,mode:v.getMode(),preview:v.containerEl.querySelector(".markdown-preview-view")?.outerHTML,links:[...v.containerEl.querySelectorAll("a.internal-link")].map(n=>({href:n.getAttribute("data-href"),text:n.textContent,rect:n.getBoundingClientRect().toJSON()}))}});
        await recordScreen("markdown-fresh-quickopen-preview-once");
        await closeOwnedMarkdownTabs(route.currentPath, "QuickOpen-preview-diagnostic");
      }
    } else if (process.argv.includes("--markdown-source-visibility-diagnostic")) {
      const item = await readItem(report.uiFlows.find(flow => flow.name === "Markdown selected excerpt -> Add Review").itemId);
      const route = await currentMarkdownRoute(item.itemId);
      const source = await verifySource(item.itemId, item.source.target, route.currentPath, { markdown: true });
      report.markdownSourceVisibility = await page.evaluate(() => {
        const view = app.workspace.activeLeaf.view;
        const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(), style = getComputedStyle(node); return { x:r.x,y:r.y,width:r.width,height:r.height,display:style.display,visibility:style.visibility,connected:node.isConnected }; };
        const editor = view.containerEl.querySelector(".cm-content"), preview = view.containerEl.querySelector(".markdown-preview-view");
        const selection = window.getSelection();
        return { path:view.file?.path, mode:view.getMode(), editor:rect(editor), preview:rect(preview), previewText:preview?.innerText,
          editorSelection:view.editor?.getSelection(), domSelection:selection?.toString(), domRangeRects:selection?.rangeCount ? [...selection.getRangeAt(0).getClientRects()].map(r=>({x:r.x,y:r.y,width:r.width,height:r.height})) : [], activeElement:document.activeElement?.outerHTML.slice(0,300) };
      });
      report.markdownSourceVisibility.source = source;
      await recordScreen("markdown-source-visibility-no-toggle");
      await controlledCloseMatrixReaders("markdown-source-visibility-diagnostic");
      report.markdownSourceVisibility.cleanup = await closeOwnedMarkdownTabs(route.currentPath, "markdown-source-visibility-diagnostic");
    } else if (process.argv.includes("--editor-route-passive-diagnostic")) {
      learningItems.markdown = await readItem(report.uiFlows.find(flow => flow.name === "Markdown selected excerpt -> Add Review").itemId);
      await installEditorRoutePassiveProbe();
      await checkFiveNavigationDirections("passive-editor-route");
      await page.evaluate(() => { for (const restore of window.__nativeEditorRouteProbe.restores.reverse()) restore(); delete window.__nativeEditorRouteProbe; });
    } else if (process.argv.includes("--complete-direction-matrix")) await runCompleteFiveDirectionMatrix();
    else if (process.argv.includes("--backlink-correlation-diagnostic")) await diagnoseBacklinkCorrelation();
    else if (process.argv.includes("--navigation-directions-only")) await exerciseNavigationDirections();
    else for (const flow of report.uiFlows) {
      const item = await readItem(flow.itemId);
      assert.ok(item, "Source checkpoint reuses an existing confirmed Review item.");
      const markdown = item.source.target.kind === "markdown";
      const expectedPath = markdown ? (await currentMarkdownRoute(item.itemId)).currentPath : (await currentPdfRoute(item)).sourcePath;
      const sourceEvidence = await verifySource(item.itemId, item.source.target, expectedPath, { markdown });
      if (flow.selectionScope === "complete sentence") {
        const { frame } = await readerFrame(expectedPath);
        const close = await frame.$(".pdfReaderVocabularyPillClose");
        if (close && await close.evaluate(node => node.getBoundingClientRect().width > 0)) await close.click();
        sourceEvidence.exactAnchorText = await frame.evaluate(() => [...(window.CSS?.highlights?.get("pdfReaderAnchorFocusText") || [])].map(range => range.toString()).join(""));
        assert.equal(sourceEvidence.exactAnchorText, flow.exactQuote);
      }
      flow.sourceCheckpoint = sourceEvidence;
      await recordScreen(`source-checkpoint-${flow.selectionScope || item.source.target.kind}`);
    }
    report.postLearningInvariant = await snapshotVocabularyInvariant();
    await captureNativeEvidence();
    report.status = "passed";
    report.completedAt = new Date().toISOString();
    report.recommendation = "Source-only checkpoint reuses all confirmed Review items and records fresh exact receipts; process restart remains separately managed by ROOT.";
    return;
  }
  const priorAllRoutes = ["pdfrename", "foldermove", "mdrename", "mdmove", "bothmove", "closedmove", "openmove", "restart"]
    .every(name => resumeEvidence?.routeScenarios?.some(row => row.name === name && row.status === "passed"));
  if (priorAllRoutes) {
    assert.equal(resumeEvidence.routesFrozenBytesVerified?.unchanged, true);
    report.routesFrozenBytesVerified = resumeEvidence.routesFrozenBytesVerified;
    report.stores.invariantBaseline = resumeEvidence.stores.invariantBaseline;
    report.routeEvidenceClosedBeforeAdditionalLearning = true;
    const priorMd = resumeEvidence.uiFlows.find(flow => flow.name === "Markdown selected excerpt -> Add Review");
    learningItems.markdown = await readItem(priorMd.itemId);
  } else {
    await performPathScenarios(fixtures);
    // Route invariants are complete before the additional real learning write.
    report.routesFrozenBytesVerified = await compareInvariantAfterMove("all eight routes complete");
  }
  const finalPdfRoute = await currentPdfRoute(learningItems.highlight);
  await verifySource(learningItems.context.itemId,
    { kind: "selection", id: learningItems.context.source.target.id }, finalPdfRoute.sourcePath);
  await createContextLearningItem(finalPdfRoute.sourcePath, { completeSentence: true });
  await captureNativeEvidence();
  report.status = "passed";
  report.completedAt = new Date().toISOString();
  report.recommendation = "The recorded UI and route scenarios passed for the exact candidate files. Full five-direction route coverage and an actual owned Obsidian process restart remain separate required Native acceptance gates.";
}

try {
  await main();
} catch (error) {
  report.status = "failed";
  report.failedAt = new Date().toISOString();
  // Capture owned-profile modal targets before cleanup closes them.
  if (browser) {
    report.failureTargets = [];
    for (const target of await browser.pages()) {
      if (attachedExistingTestVault && target !== page && !(await target.title()).includes(` - ${EXPECTED_VAULT_NAME} - `)) continue;
      const state = await target.evaluate(() => ({ title: document.title,
        bodyClass: document.body?.className || "",
        text: (document.body?.innerText || "").slice(0, 6000),
        textareas: [...document.querySelectorAll("textarea")].map(node => ({
          label: node.getAttribute("aria-label"), value: node.value,
        })),
      })).catch(error => ({ error: String(error) }));
      report.failureTargets.push({ url: target.url(), ...state });
      await recordScreen(`failure-target-${report.failureTargets.length}`, target).catch(() => {});
    }
  }
  report.errors.push({ at: report.failedAt, code: error?.code || null, error: error?.stack || String(error) });
  report.recommendation = "Do not accept; inspect the first failing Native stage and preserve the per-run sidecars for diagnosis.";
} finally {
  if (page) await page.evaluate(() => { const state = window.__nativeEditorRouteProbe; if (state) { for (const restore of state.restores.reverse()) restore(); delete window.__nativeEditorRouteProbe; } }).catch(() => {});
  await cleanupNativeRun().catch(error => {
    report.cleanup = { status: "failed", error: error?.stack || String(error), at: new Date().toISOString() };
  });
  if (attachedExistingTestVault && report.attachedMode?.defaultBaseline) {
    const after = await attachedReadOnlySnapshot();
    report.attachedMode.defaultAfter = after;
    report.attachedMode.defaultUnchanged = JSON.stringify(after) === JSON.stringify(report.attachedMode.defaultBaseline);
    if (report.attachedMode.preservedRunBaseline === null) {
      report.attachedMode.preservedRunAfter = null;
      report.attachedMode.preservedRunUnchanged = "NOT_PRESENT";
    } else {
      const preservedAfter = await attachedReadOnlySnapshot(`.obsidian/plugins/${PLUGIN_ID}/.native-learning-loop/native-learning-loop-20261023142727241-ab1fac1a68`);
      report.attachedMode.preservedRunAfter = preservedAfter;
      report.attachedMode.preservedRunUnchanged = JSON.stringify(preservedAfter) === JSON.stringify(report.attachedMode.preservedRunBaseline);
    }
    if (!report.attachedMode.defaultUnchanged || report.attachedMode.preservedRunUnchanged === false) report.status = "failed";
  }
  if (browser) browser.disconnect();
  report.completedAt ||= new Date().toISOString();
  await persistReport().catch((error) => {
    process.stderr.write(`Unable to persist Native learning-loop evidence: ${error?.stack || error}\n`);
  });
}

console.log(JSON.stringify({ status: report.status, reportPath, runId,
  uiFlows: report.uiFlows.map(flow => ({ name: flow.name, status: flow.status, itemId: flow.itemId || null })),
  routeScenarios: report.routeScenarios.map(scenario => ({ name: scenario.name, status: scenario.status })),
  errors: report.errors.map(entry => entry.error), nativeProfile: report.nativeProfile,
  sync: report.sync, identity: report.identity }, null, 2));
if (report.status !== "passed") process.exitCode = 1;
