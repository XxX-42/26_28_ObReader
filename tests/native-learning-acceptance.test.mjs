import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertNativeLearningForeground, assertNativeCandidateFiles, auditNativeRouteMatrixEvidence,
  assertNativeResumeCandidate, nativeProcessRestartVerified, NATIVE_ROUTE_STAGES,
} from "./native-learning-acceptance.mjs";

const files = { "main.js": "a".repeat(64), "manifest.json": "b".repeat(64), "styles.css": "c".repeat(64) };
const vault = "/test/Native-Vault";
const identity = { vault, configDir: ".obsidian", visibility: "visible", focused: true,
  ownerDocumentIsRenderer: true, ownerWindowIsRenderer: true };
const receipt = (kind, targetId) => ({ kind, targetId, ok: true, requestId: `nav-${kind}`,
  documentId: "doc-1", openRequest: 3, rendererGeneration: "generation-1" });
const source = (kind, id) => ({ target: { kind, id }, itemId: kind === "selection" ? "context-review-1" : "annotation-review-1",
  path: "Books/Book.pdf", navigation: { ...receipt(kind, id), pendingAfterAck: null },
  acceptedNavigation: receipt(kind, id), navigationIdentity: receipt(kind, id), exactAnchorText: "exact source" });
const stage = name => ({ name, status: "passed", canonicalBytesUnchanged: true,
  defaultTreesUnchanged: true, sourcePdfUnchanged: true, directions: {
    highlightSource: source("annotation", "annotation-1"), contextSource: source("selection", "context-1"),
    markdownToPdf: { ...receipt("selection", "anchor-1"), receipt: receipt("selection", "anchor-1") },
    currentLink: "[[Book.pdf#page=1&obreader=sel.anchor-1]]",
    backlinkToMarkdown: { path: "Notes/Source.md", selection: "[[Book.pdf#page=1&obreader=sel.anchor-1]]" },
    paths: { pdfPath: "Books/Book.pdf", markdownPath: "Notes/Source.md" }, sidebar: { uuid: "annotation-1", selected: true },
  } });
const report = () => ({ installedFiles: files, cleanup: { status: "complete", isolationRestored: true },
  highlight: { uuid: "annotation-1" }, uiFlows: [{ itemId: "context-review-1", status: "passed",
    selectionScope: "complete sentence", exactQuote: "exact source" }],
  nativeProfile: { ownerPid: 200, root: "/owned/profile" }, completeDirectionMatrix: {
    status: "passed", stages: NATIVE_ROUTE_STAGES.map(stage), processRestart: {
      kind: "owned-process-restart", previousProcessExited: true,
      previous: { ownerPid: 100, profileRoot: "/owned/profile", ownerCommandHash: "old-command" },
      previousProcessState: { pid: 100, exists: false, ownedProfileProcess: false, commandHash: null },
      currentOwnerPid: 200, currentOwnerCommandHash: "new-command", profileRoot: "/owned/profile",
    },
  } });

test("Native foreground validation is passive and rejects hidden, unfocused or foreign windows", () => {
  assert.equal(assertNativeLearningForeground(identity, { vault }).policy, "external-cua-selection");
  for (const patch of [{ visibility: "hidden" }, { focused: false }, { ownerDocumentIsRenderer: false },
    { ownerWindowIsRenderer: false }, { ownerDocumentIsRenderer: undefined }]) {
    assert.throws(() => assertNativeLearningForeground({ ...identity, ...patch }, { vault }),
      error => error.code === "NATIVE_WINDOW_NOT_FOREGROUND");
  }
  assert.throws(() => assertNativeLearningForeground({ ...identity, vault: "/production" }, { vault }),
    error => error.code === "NATIVE_WINDOW_IDENTITY_MISMATCH");
});

test("a matching version cannot replace exact three-file Native candidate hashes", () => {
  assert.equal(assertNativeCandidateFiles(files, files)["main.js"].sha256, files["main.js"]);
  for (const installed of [{ ...files, "main.js": "d".repeat(64) }, { "manifest.json": files["manifest.json"] }]) {
    assert.throws(() => assertNativeCandidateFiles(files, installed),
      error => error.code === "NATIVE_CANDIDATE_ARTIFACT_MISMATCH");
  }
});

test("saved Native matrix receipts require current artifacts, every direction and unchanged data", () => {
  assert.equal(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [report()] }).status, "PASS");
  const missing = report();
  delete missing.completeDirectionMatrix.stages[6].directions.contextSource;
  const result = auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [missing] });
  assert.deepEqual(result.gaps, ["full-openmove"]);
  const changed = report();
  changed.completeDirectionMatrix.stages[0].defaultTreesUnchanged = false;
  assert.ok(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [changed] }).gaps.includes("full-pdfrename"));
  const stale = report(); stale.installedFiles = { ...files, "main.js": "d".repeat(64) };
  assert.equal(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [stale] }).matchingReports, 0);
  const failedInstall = report();
  failedInstall.candidateArtifact = { files, installedFiles: { ...files, "main.js": "d".repeat(64) } };
  assert.equal(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [failedInstall] }).matchingReports, 0,
    "recording expected candidate bytes cannot hide an installed artifact mismatch");
});

test("resumed Native stages bind both prior expected and installed package hashes to the current candidate", () => {
  const valid = report();
  valid.candidateArtifact = { files, installedFiles: files };
  assert.equal(assertNativeResumeCandidate(files, valid).length, NATIVE_ROUTE_STAGES.length);
  for (const candidateArtifact of [
    { files: { ...files, "main.js": "d".repeat(64) }, installedFiles: files },
    { files, installedFiles: { ...files, "styles.css": "e".repeat(64) } },
  ]) {
    const evidence = report(); evidence.candidateArtifact = candidateArtifact;
    assert.throws(() => assertNativeResumeCandidate(files, evidence),
      error => error.code === "NATIVE_CANDIDATE_ARTIFACT_MISMATCH");
  }
  assert.throws(() => assertNativeResumeCandidate(files, report()),
    error => error.code === "NATIVE_RESUME_CANDIDATE_MISSING");
  const staleRestart = report();
  staleRestart.candidateArtifact = { files: { ...files }, installedFiles: { ...files } };
  staleRestart.completeDirectionMatrix.processRestartPending = { candidateFiles: { ...files },
    installedFiles: { ...files, "manifest.json": "e".repeat(64) } };
  assert.throws(() => assertNativeResumeCandidate(files, staleRestart),
    error => error.code === "NATIVE_CANDIDATE_ARTIFACT_MISMATCH",
    "the saved restart boundary must remain bound to the same exact three-file candidate");
  const badReceipt = report();
  badReceipt.candidateArtifact = { files: { ...files }, installedFiles: { ...files } };
  badReceipt.completeDirectionMatrix.stages[2].directions.contextSource.exactAnchorText = "wrong sentence";
  assert.throws(() => assertNativeResumeCandidate(files, badReceipt),
    error => error.code === "NATIVE_RESUME_STAGE_RECEIPT_INVALID");
});

test("plugin reload and a different profile cannot count as actual owned-process restart", () => {
  const samePid = report(); samePid.completeDirectionMatrix.processRestart.currentOwnerPid = 100;
  assert.equal(nativeProcessRestartVerified(samePid), false);
  assert.ok(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [samePid] }).gaps.includes("full-owned-process-restart"));
  const foreignProfile = report(); foreignProfile.nativeProfile.root = "/another/profile";
  assert.equal(nativeProcessRestartVerified(foreignProfile), false);
  const unprovenExit = report(); delete unprovenExit.completeDirectionMatrix.processRestart.previousProcessExited;
  assert.equal(nativeProcessRestartVerified(unprovenExit), false,
    "a new PID alone cannot prove that the previous owned process actually exited");
  const priorStillRunning = report();
  priorStillRunning.completeDirectionMatrix.processRestart.previousProcessState.ownedProfileProcess = true;
  assert.equal(nativeProcessRestartVerified(priorStillRunning), false,
    "saved restart receipts must show the old exact-profile process is no longer running");
  const unclean = report(); unclean.cleanup.isolationRestored = false;
  assert.equal(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [unclean] }).status, "INCOMPLETE");
});

test("stale or substituted navigation receipts cannot count as an exact Native direction", () => {
  for (const mutate of [r => { r.directions.highlightSource.acceptedNavigation.targetId = "other"; },
    r => { r.directions.markdownToPdf.receipt.rendererGeneration = "old-generation"; },
    r => { r.directions.highlightSource.navigation.requestId = "prior-request"; },
    r => { r.directions.contextSource.exactAnchorText = "other sentence"; },
    r => { r.directions.contextSource.path = "Books/Unrelated.pdf"; },
    r => { r.directions.backlinkToMarkdown.selection = "different slice"; }]) {
    const evidence = report(); mutate(evidence.completeDirectionMatrix.stages[0]);
    assert.ok(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [evidence] }).gaps.includes("full-pdfrename"));
  }
});

test("malformed saved evidence cannot hide a valid report or manufacture matrix coverage", () => {
  const malformed = report(); malformed.uiFlows = {}; malformed.completeDirectionMatrix.stages = {};
  assert.equal(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [malformed] }).status, "INCOMPLETE");
  assert.equal(auditNativeRouteMatrixEvidence({ candidateFiles: files, reports: [null, malformed, report()] }).status, "PASS");
});

test("the Native learning runner contains no automatic native window activation path", async () => {
  const runner = await readFile(new URL("./native-learning-loop.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(runner, /execFileSync\(["'](?:swift|osascript|open)["']|NSRunningApplication|System Events|\.bringToFront\(|Browser\.setWindowBounds/u);
  assert.match(runner, /assertNativeLearningForeground\(before/u);
  const main = runner.slice(runner.indexOf("async function main()"));
  assert.ok(main.indexOf("assertNativeLearningForeground(before") < main.indexOf("await installNativeIsolation()"),
    "foreground failure must happen before any test isolation or Vault mutation");
  const resumeCheck = main.indexOf("assertNativeResumeCandidate(report.candidateArtifact.files, resumeEvidence)");
  assert.ok(resumeCheck >= 0 && resumeCheck < main.indexOf("await enablePluginAfterIsolation()"),
    "stale or mixed-candidate resume receipts must be rejected before plugin enable or Native writes");
});
