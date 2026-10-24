export const NATIVE_RELEASE_FILES = Object.freeze(["main.js", "manifest.json", "styles.css"]);
export const NATIVE_ROUTE_STAGES = Object.freeze([
  "full-pdfrename", "full-foldermove", "full-mdrename", "full-mdmove",
  "full-bothmove", "full-closedmove", "full-openmove", "full-owned-process-restart",
]);

const sha256 = /^[a-f0-9]{64}$/u;
const nonempty = value => typeof value === "string" && value.length > 0;
const digestFor = (files, file) => typeof files?.[file] === "string"
  ? files[file] : files?.[file]?.sha256;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

// Window selection belongs to the external CUA driver. This helper only
// inspects the exact owned renderer; it never activates, raises or selects one.
export function assertNativeLearningForeground(identity, { vault, configDir = ".obsidian", stage = "preflight" } = {}) {
  if (!identity || identity.vault !== vault || identity.configDir !== configDir) {
    fail("NATIVE_WINDOW_IDENTITY_MISMATCH", `${stage}: the renderer is not the configured test Vault.`);
  }
  if (identity.visibility !== "visible" || identity.focused !== true) {
    fail("NATIVE_WINDOW_NOT_FOREGROUND",
      `${stage}: select the exact owned test window through CUA before Native UI input; the harness will not activate a window.`);
  }
  return Object.freeze({ status: "verified", policy: "external-cua-selection", stage, vault, configDir,
    visibility: identity.visibility, focused: identity.focused });
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

function stageReceiptValid(stage, report) {
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

export function nativeProcessRestartVerified(report) {
  const restart = report?.completeDirectionMatrix?.processRestart;
  const previous = restart?.previous;
  return report?.completeDirectionMatrix?.status === "passed" &&
    restart?.kind === "owned-process-restart" && restart.previousProcessExited === true &&
    Number.isSafeInteger(previous?.ownerPid) && previous.ownerPid > 0 &&
    Number.isSafeInteger(restart?.currentOwnerPid) && restart.currentOwnerPid > 0 &&
    restart.currentOwnerPid !== previous.ownerPid &&
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
      if (!NATIVE_ROUTE_STAGES.includes(stage?.name) || !stageReceiptValid(stage, report)) continue;
      if (stage.name === "full-owned-process-restart" && !nativeProcessRestartVerified(report)) continue;
      accepted.set(stage.name, { name: stage.name, status: "PASS", reportIndex: index });
    }
  }
  const stages = NATIVE_ROUTE_STAGES.map(name => accepted.get(name) || { name, status: "NOT_VERIFIED" });
  const gaps = stages.filter(stage => stage.status !== "PASS").map(stage => stage.name);
  return Object.freeze({ scope: "saved Native route-matrix receipts for the exact candidate files",
    status: gaps.length ? "INCOMPLETE" : "PASS", matchingReports, rejectedReports, stages, gaps });
}
