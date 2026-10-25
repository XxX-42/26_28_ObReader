export const NATIVE_RELEASE_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);
export const NATIVE_ROUTE_STAGES = Object.freeze([
  "full-pdfrename", "full-foldermove", "full-mdrename", "full-mdmove",
  "full-bothmove", "full-closedmove", "full-openmove", "full-owned-process-restart",
]);
const OWNED_PROFILE_PARENT = "/Users/jiajia/.codex/worktrees/obreader-0.14/evidence";
const RUNTIME_TEST_ROOT = "/private/tmp/obreader-014-runtime";
const EXPECTED_VAULT = "/Users/jiajia/Documents/ObReader-Apple-Test";
const INSTALLED_OBSIDIAN_APP = "/Applications/Obsidian.app";
const RUNTIME_OBSIDIAN_APP = `${RUNTIME_TEST_ROOT}/mnt/Obsidian.app`;
const OBSIDIAN_RENDERER_URL = "app://obsidian.md/index.html";

const sha256 = /^[a-f0-9]{64}$/u;
const nonempty = value => typeof value === "string" && value.length > 0;
const digestFor = (files, file) => typeof files?.[file] === "string"
  ? files[file] : files?.[file]?.sha256;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function resolveNativeOwnedProfileApp(profileRoot, marker, { allowRuntimeTestProfile = false } = {}) {
  const isDirectProfileChild = (parent, value, prefix) => {
    if (typeof value !== "string" || !value.startsWith(`${parent}/${prefix}`)) return false;
    const suffix = value.slice(parent.length + 1);
    return suffix.length > prefix.length && !suffix.slice(prefix.length).includes("/");
  };
  const normalProfile = isDirectProfileChild(OWNED_PROFILE_PARENT, profileRoot, "macos-native-profile-");
  const runtimeTestProfile = allowRuntimeTestProfile === true &&
    isDirectProfileChild(RUNTIME_TEST_ROOT, profileRoot, "profile-");
  const expectedApp = normalProfile ? INSTALLED_OBSIDIAN_APP : runtimeTestProfile ? RUNTIME_OBSIDIAN_APP : null;
  if (!expectedApp || marker?.kind !== "codex-owned-native-test-profile" ||
      marker.allowedVault !== EXPECTED_VAULT || marker.appPath !== expectedApp) {
    fail("NATIVE_PROFILE_NOT_OWNED", "Native tests require a verified ObReader-Apple-Test profile and its matching Obsidian app.");
  }
  return `${expectedApp}/Contents/MacOS/Obsidian`;
}

// Window selection belongs to the external CUA driver. This helper only
// inspects the exact owned renderer; it never activates, raises or selects one.
export function assertNativeLearningForeground(identity, { vault, configDir = ".obsidian", stage = "preflight" } = {}) {
  if (!identity || identity.vault !== vault || identity.configDir !== configDir) {
    fail("NATIVE_WINDOW_IDENTITY_MISMATCH", `${stage}: the renderer is not the configured test Vault.`);
  }
  if (identity.visibility !== "visible" || identity.focused !== true ||
      identity.ownerDocumentIsRenderer !== true || identity.ownerWindowIsRenderer !== true) {
    fail("NATIVE_WINDOW_NOT_FOREGROUND",
      `${stage}: select the exact owned test window through CUA and verify its active document/window identity before Native UI input; the harness will not activate a window.`);
  }
  return Object.freeze({ status: "verified", policy: "external-cua-selection", stage, vault, configDir,
    visibility: identity.visibility, focused: identity.focused,
    ownerDocumentIsRenderer: identity.ownerDocumentIsRenderer, ownerWindowIsRenderer: identity.ownerWindowIsRenderer });
}

function assertNativeRendererBinding(identity, native, { vault, configDir }) {
  const vaultName = vault.slice(vault.lastIndexOf("/") + 1);
  const expectedTitleSuffix = `${vaultName} - Obsidian ${native.appVersion}`;
  if (!identity || identity.vault !== vault || identity.vaultName !== vaultName || identity.configDir !== configDir ||
      identity.url !== OBSIDIAN_RENDERER_URL || typeof identity.title !== "string" ||
      !identity.title.endsWith(expectedTitleSuffix)) {
    fail("NATIVE_CDP_RENDERER_IDENTITY_MISMATCH",
      "The CDP page must be the exact configured test Vault renderer.");
  }
}

function assertNativeProcessBinding(native, state) {
  if (state?.pid !== native.ownerPid || state.ownedProfileProcess !== true ||
      state.commandHash !== native.ownerCommandHash) {
    fail("NATIVE_WINDOW_PROCESS_MISMATCH",
      "The process probe does not match the validated Obsidian executable and owned profile.");
  }
}

function assertClosedSettingsStaleReferences(identity, openWindows, closedSettingsTarget, { vault, appVersion }) {
  const stale = [];
  if (identity.ownerDocumentIsRenderer === false) stale.push(["activeDocument", identity.activeDocumentRef]);
  else if (identity.ownerDocumentIsRenderer !== true) {
    fail("NATIVE_WINDOW_STALE_REFERENCE_UNPROVEN", "activeDocument renderer identity is unavailable.");
  }
  if (identity.ownerWindowIsRenderer === false) stale.push(["activeWindow.document", identity.activeWindowDocumentRef]);
  else if (identity.ownerWindowIsRenderer !== true) {
    fail("NATIVE_WINDOW_STALE_REFERENCE_UNPROVEN", "activeWindow renderer identity is unavailable.");
  }
  if (!stale.length) return [];

  const vaultName = vault.slice(vault.lastIndexOf("/") + 1);
  const settingsTitles = new Set([
    `Settings - ${vaultName} - Obsidian ${appVersion}`,
    `设置 - ${vaultName} - Obsidian ${appVersion}`,
  ]);
  let target = closedSettingsTarget;
  if (target) {
    if (target.closed !== true || target.settingsVisible !== true || target.vault !== vault ||
        target.url !== OBSIDIAN_RENDERER_URL || !settingsTitles.has(target.title)) {
      fail("NATIVE_WINDOW_STALE_REFERENCE_UNPROVEN", "The recorded Settings target was not proven closed in this test Vault.");
    }
  } else {
    const [first] = stale;
    target = first?.[1] ? { url: first[1].url, title: first[1].title, closed: first[1].closed } : null;
    if (target?.closed !== true || target.url !== OBSIDIAN_RENDERER_URL || !settingsTitles.has(target.title)) {
      fail("NATIVE_WINDOW_STALE_REFERENCE_UNPROVEN", "A stale global is accepted only when it identifies a closed Settings window.");
    }
  }

  for (const [name, reference] of stale) {
    if (!reference || reference.closed !== true || reference.url !== target.url || reference.title !== target.title) {
      fail("NATIVE_WINDOW_STALE_REFERENCE_UNPROVEN", `${name} does not identify the proven closed Settings target.`);
    }
  }
  if (!Array.isArray(openWindows) || openWindows.some(window => window?.url === target.url &&
      (window.title === target.title || (target.targetId && window.targetId === target.targetId)))) {
    fail("NATIVE_WINDOW_STALE_REFERENCE_UNPROVEN", "A matching Settings target is still present in the owned CDP session.");
  }
  return stale.map(([name]) => name);
}

export async function verifyOwnedNativeRendererForeground({
  native,
  expectedVault = EXPECTED_VAULT,
  configDir = ".obsidian",
  allowRuntimeTestProfile = false,
  allowScratchNativeVault = false,
  readNativeWindow,
  readRendererIdentity,
  closedSettingsTarget = null,
} = {}) {
  if (!Number.isSafeInteger(native?.ownerPid) || native.ownerPid <= 0 ||
      native?.nativeConfig?.vault !== expectedVault || native?.nativeConfig?.configDir !== configDir ||
      native?.marker?.allowedVault !== expectedVault || !sha256.test(native?.ownerCommandHash || "") ||
      !Number.isInteger(native?.port) || native.port <= 0 || native.port >= 65_536 ||
      native?.nativeConfig?.cdpUrl !== `http://127.0.0.1:${native.port}` || !nonempty(native?.appVersion)) {
    fail("NATIVE_WINDOW_TARGET_MISMATCH", "Foreground verification requires the exact validated test PID, profile, CDP port and Vault.");
  }
  const expectedExecutable = resolveNativeOwnedProfileApp(native.profileRoot, native.marker, {
    allowRuntimeTestProfile,
    allowScratchNativeVault,
    expectedVault,
  });
  if (native.appExecutable !== expectedExecutable) {
    fail("NATIVE_WINDOW_TARGET_MISMATCH", "The PID executable does not match the validated profile marker.");
  }
  if (typeof readNativeWindow !== "function" || typeof readRendererIdentity !== "function") {
    fail("NATIVE_WINDOW_PROBE_MISSING", "Foreground verification requires injected process/window and CDP renderer probes.");
  }
  const target = Object.freeze({ ownerPid: native.ownerPid, profileRoot: native.profileRoot,
    appExecutable: expectedExecutable, port: native.port, vault: expectedVault });
  const windowProbe = await readNativeWindow(target.ownerPid);
  assertNativeProcessBinding(native, windowProbe?.process);
  const osWindow = windowProbe?.osFrontmostWindow;
  if (osWindow?.pid !== target.ownerPid || osWindow.processName !== "Obsidian" ||
      osWindow.frontmost !== true || typeof osWindow.title !== "string" || osWindow.title.length === 0) {
    fail("NATIVE_OS_WINDOW_IDENTITY_MISMATCH", "System Events did not report the exact owned Obsidian PID as frontmost.");
  }
  const identity = await readRendererIdentity();
  assertNativeRendererBinding(identity, native, { vault: expectedVault, configDir });
  if (osWindow.title !== identity.title) {
    fail("NATIVE_OS_WINDOW_IDENTITY_MISMATCH", "The frontmost OS window title does not match the exact CDP renderer title.");
  }
  if (identity.visibility !== "visible" || identity.focused !== true) {
    fail("NATIVE_WINDOW_NOT_FOREGROUND", "The owned OS front window and focused CDP renderer do not identify the same test window.");
  }
  const openWindows = windowProbe.openWindows;
  if (!Array.isArray(openWindows) || !openWindows.some(window => window?.url === identity.url &&
      window.title === identity.title) || openWindows.filter(window => window?.url === identity.url &&
      window.title === identity.title).length !== 1) {
    fail("NATIVE_CDP_WINDOW_IDENTITY_MISMATCH", "The exact focused renderer is not unique in the owned CDP session.");
  }
  const staleReferences = assertClosedSettingsStaleReferences(identity, openWindows, closedSettingsTarget,
    { vault: expectedVault, appVersion: native.appVersion });
  return Object.freeze({ status: "verified", policy: staleReferences.length ? "owned-pid-os-cdp-closed-settings-stale-globals" : "owned-pid-os-cdp",
    ownerPid: target.ownerPid, profileRoot: target.profileRoot, vault: target.vault,
    osWindowTitle: osWindow.title, rendererUrl: identity.url, rendererTitle: identity.title,
    staleGlobalReferences: staleReferences, rendererIdentity: identity });
}

export function assertNativeCandidateFiles(expectedFiles, installedFiles) {
  const files = {};
  for (const file of NATIVE_RELEASE_FILES) {
    const expected = digestFor(expectedFiles, file);
    const installed = digestFor(installedFiles, file);
    if (!sha256.test(expected || "") || expected !== installed) {
      fail("NATIVE_CANDIDATE_ARTIFACT_MISMATCH", `Installed ${file} must match the candidate SHA-256; a matching version number is insufficient.`);
    }
    files[file] = Object.freeze({ sha256: expected });
  }
  return Object.freeze(files);
}

function sameSession(receipt, identity) {
  return receipt?.ok === true && nonempty(receipt.requestId) && nonempty(receipt.documentId) &&
    Number.isSafeInteger(receipt.openRequest) && receipt.openRequest > 0 && nonempty(receipt.rendererGeneration) &&
    ["documentId", "openRequest", "rendererGeneration"].every(key => receipt[key] === identity?.[key]);
}

function sourceReceipt(value, kind) {
  return value?.target?.kind === kind && nonempty(value.target.id) && value.navigation?.ok === true &&
    sameSession(value.acceptedNavigation, value.navigationIdentity) &&
    value.acceptedNavigation.kind === kind && value.acceptedNavigation.targetId === value.target.id &&
    value.navigation.requestId === value.acceptedNavigation.requestId &&
    value.navigation.kind === kind && value.navigation.targetId === value.target.id &&
    value.navigation.pendingAfterAck === null;
}

export function nativeRouteStageReceiptVerified(stage, report) {
  const d = stage?.directions;
  const flows = Array.isArray(report?.uiFlows) ? report.uiFlows : [];
  const contextFlow = flows.find(flow => flow && typeof flow === "object" &&
    flow.itemId === d?.contextSource?.itemId &&
    flow.status === "passed" && flow.selectionScope === "complete sentence");
  return stage?.status === "passed" && stage.canonicalBytesUnchanged === true &&
    stage.defaultTreesUnchanged === true && stage.sourcePdfUnchanged === true &&
    sourceReceipt(d?.highlightSource, "annotation") && sourceReceipt(d?.contextSource, "selection") &&
    d.highlightSource.target.id === report?.highlight?.uuid &&
    nonempty(d?.paths?.pdfPath) && d.highlightSource.path === d.paths.pdfPath && d.contextSource.path === d.paths.pdfPath &&
    nonempty(contextFlow?.exactQuote) && d.contextSource.exactAnchorText === contextFlow.exactQuote &&
    sameSession(d?.markdownToPdf?.receipt, d?.markdownToPdf) &&
    d.markdownToPdf.receipt.kind === "selection" && nonempty(d.markdownToPdf.receipt.targetId) &&
    nonempty(d?.currentLink) && d?.backlinkToMarkdown?.selection === d.currentLink &&
    d.backlinkToMarkdown.path === d?.paths?.markdownPath &&
    d?.sidebar?.selected === true && d.sidebar.uuid === d.highlightSource.target.id;
}

export function assertNativeResumeCandidate(expectedFiles, resumeReport) {
  assertNativeCandidateFiles(expectedFiles, expectedFiles);
  const prior = resumeReport?.candidateArtifact;
  if (!prior || !prior.files || !prior.installedFiles) {
    fail("NATIVE_RESUME_CANDIDATE_MISSING", "Resumed Native stages require saved expected and installed hashes for all three candidate files.");
  }
  assertNativeCandidateFiles(expectedFiles, prior.files);
  assertNativeCandidateFiles(expectedFiles, prior.installedFiles);
  const restartPending = resumeReport?.completeDirectionMatrix?.processRestartPending;
  if (restartPending) {
    assertNativeCandidateFiles(expectedFiles, restartPending.candidateFiles);
    assertNativeCandidateFiles(expectedFiles, restartPending.installedFiles);
  }
  const stages = Array.isArray(resumeReport?.completeDirectionMatrix?.stages)
    ? resumeReport.completeDirectionMatrix.stages : [];
  const invalidPassed = stages.filter(row => row?.status === "passed" && !nativeRouteStageReceiptVerified(row, resumeReport));
  if (invalidPassed.length) {
    fail("NATIVE_RESUME_STAGE_RECEIPT_INVALID", `Refusing to reuse invalid Native stage receipts: ${invalidPassed.map(row => row.name).join(", ")}`);
  }
  return stages.filter(row => row?.status === "passed" && nativeRouteStageReceiptVerified(row, resumeReport));
}

export function nativeProcessRestartVerified(report) {
  const restart = report?.completeDirectionMatrix?.processRestart;
  const previous = restart?.previous;
  const previousProcessState = restart?.previousProcessState;
  return report?.completeDirectionMatrix?.status === "passed" &&
    restart?.kind === "owned-process-restart" && restart.previousProcessExited === true &&
    Number.isSafeInteger(previous?.ownerPid) && previous.ownerPid > 0 &&
    nonempty(previous?.ownerCommandHash) && previousProcessState?.pid === previous.ownerPid &&
    previousProcessState.ownedProfileProcess === false &&
    (previousProcessState.commandHash === null || previousProcessState.commandHash !== previous.ownerCommandHash) &&
    Number.isSafeInteger(restart?.currentOwnerPid) && restart.currentOwnerPid > 0 &&
    restart.currentOwnerPid !== previous.ownerPid &&
    nonempty(restart?.currentOwnerCommandHash) &&
    restart.profileRoot === previous.profileRoot &&
    report?.nativeProfile?.ownerPid === restart.currentOwnerPid &&
    nonempty(previous?.profileRoot) && report.nativeProfile.root === previous.profileRoot;
}

// This is an offline receipt audit, not a substitute for running Native UI.
// A failed later stage may retain earlier complete receipts, but only when
// cleanup and the exact three-file candidate binding also passed.
export function auditNativeRouteMatrixEvidence({ candidateFiles, reports = [] } = {}) {
  assertNativeCandidateFiles(candidateFiles, candidateFiles);
  const accepted = new Map();
  const rejectedReports = [];
  let matchingReports = 0;
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    try {
      assertNativeCandidateFiles(candidateFiles, report?.candidateArtifact?.installedFiles ||
        report?.candidateArtifact?.files || report?.installedFiles);
    } catch {
      rejectedReports.push({ index, reason: "CANDIDATE_ARTIFACT_MISMATCH" });
      continue;
    }
    matchingReports += 1;
    if (report?.cleanup?.status !== "complete" || report.cleanup.isolationRestored !== true) {
      rejectedReports.push({ index, reason: "CLEANUP_NOT_VERIFIED" });
      continue;
    }
    const stages = Array.isArray(report?.completeDirectionMatrix?.stages)
      ? report.completeDirectionMatrix.stages : [];
    for (const stage of stages) {
      if (!NATIVE_ROUTE_STAGES.includes(stage?.name) || !nativeRouteStageReceiptVerified(stage, report)) continue;
      if (stage.name === "full-owned-process-restart" && !nativeProcessRestartVerified(report)) continue;
      accepted.set(stage.name, { name: stage.name, status: "PASS", reportIndex: index });
    }
  }
  const stages = NATIVE_ROUTE_STAGES.map(name => accepted.get(name) || { name, status: "NOT_VERIFIED" });
  const gaps = stages.filter(stage => stage.status !== "PASS").map(stage => stage.name);
  return Object.freeze({ scope: "saved Native route-matrix receipts for the exact candidate files",
    status: gaps.length ? "INCOMPLETE" : "PASS", matchingReports, rejectedReports, stages, gaps });
}
