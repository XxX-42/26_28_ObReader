import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertNativeLearningForeground, assertNativeCandidateFiles, auditNativeRouteMatrixEvidence,
  assertNativeResumeCandidate, ensureOwnedNativeRendererForeground, nativeProcessRestartVerified,
  NATIVE_ROUTE_STAGES, resolveNativeOwnedProfileApp,
} from "./native-learning-acceptance.mjs";

const files = { "main.js": "a".repeat(64), "manifest.json": "b".repeat(64), "styles.css": "c".repeat(64) };
const vault = "/test/Native-Vault";
const identity = { vault, configDir: ".obsidian", visibility: "visible", focused: true,
  ownerDocumentIsRenderer: true, ownerWindowIsRenderer: true };
const activationVault = "/Users/jiajia/Documents/ObReader-Apple-Test";
const activationNative = () => ({ ownerPid: 200, profileRoot:
  "/Users/jiajia/.codex/worktrees/obreader-0.14/evidence/macos-native-profile-run-1",
  marker: { kind: "codex-owned-native-test-profile", allowedVault: activationVault,
    appPath: "/Applications/Obsidian.app" },
  appExecutable: "/Applications/Obsidian.app/Contents/MacOS/Obsidian", appVersion: "1.14.5",
  port: 9222, ownerCommandHash: "e".repeat(64), nativeConfig: { vault: activationVault,
    configDir: ".obsidian", cdpUrl: "http://127.0.0.1:9222" } });
const activationIdentity = (patch = {}) => ({ url: "app://obsidian.md/index.html",
  title: "Native - ObReader-Apple-Test - Obsidian 1.14.5", vault: activationVault,
  vaultName: "ObReader-Apple-Test", configDir: ".obsidian", visibility: "visible", focused: true,
  ownerDocumentIsRenderer: true, ownerWindowIsRenderer: true, ...patch });
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

test("Native foreground recovery validates PID, owned profile and exact test Vault before activation", async () => {
  const base = activationNative();
  let processReads = 0;
  let activations = 0;
  const options = {
    native: base, expectedVault: activationVault,
    readProcessState: async pid => { processReads++; return { pid, ownedProfileProcess: true,
      commandHash: base.ownerCommandHash }; },
    readIdentity: async () => activationIdentity(),
    activatePid: async () => { activations++; },
  };
  const result = await ensureOwnedNativeRendererForeground(options);
  assert.equal(result.status, "already-foreground");
  assert.equal(result.ownerPid, base.ownerPid);
  assert.equal(processReads, 1);
  assert.equal(activations, 0, "a focused exact renderer is a no-op");

  for (const [mutate, expectedCode] of [
    [target => { target.ownerPid = 0; }, "NATIVE_ACTIVATION_TARGET_MISMATCH"],
    [target => { target.profileRoot = "/private/tmp/unowned-profile"; }, "NATIVE_PROFILE_NOT_OWNED"],
    [target => { target.marker.allowedVault = "/Users/jiajia/Documents/Production"; }, "NATIVE_ACTIVATION_TARGET_MISMATCH"],
    [target => { target.nativeConfig.vault = "/Users/jiajia/Documents/Production"; }, "NATIVE_ACTIVATION_TARGET_MISMATCH"],
  ]) {
    const invalid = activationNative(); mutate(invalid);
    let called = false;
    await assert.rejects(ensureOwnedNativeRendererForeground({ ...options, native: invalid,
      readProcessState: async () => { called = true; return {}; },
      activatePid: async () => { called = true; } }), error => error.code === expectedCode);
    assert.equal(called, false, "invalid target bindings fail before process inspection or activation");
  }

  await assert.rejects(ensureOwnedNativeRendererForeground({ ...options,
    readProcessState: async pid => ({ pid, ownedProfileProcess: true, commandHash: "f".repeat(64) }),
    activatePid: async () => { activations++; },
  }), error => error.code === "NATIVE_ACTIVATION_PROCESS_MISMATCH");
  assert.equal(activations, 0, "a reused or substituted PID is never activated");

  await assert.rejects(ensureOwnedNativeRendererForeground({ ...options,
    readIdentity: async () => activationIdentity({ vault: "/Users/jiajia/Documents/Production" }),
    activatePid: async () => { activations++; },
  }), error => error.code === "NATIVE_ACTIVATION_RENDERER_MISMATCH");
  assert.equal(activations, 0, "a foreign renderer is rejected before activation");
});

test("Native foreground recovery activates only the bound PID and waits for exact renderer focus", async () => {
  const native = activationNative();
  const identities = [activationIdentity({ focused: false, ownerDocumentIsRenderer: false,
    ownerWindowIsRenderer: false }), activationIdentity()];
  const activatedPids = [];
  let processReads = 0;
  const result = await ensureOwnedNativeRendererForeground({
    native, expectedVault: activationVault,
    readProcessState: async pid => { processReads++; return { pid, ownedProfileProcess: true,
      commandHash: native.ownerCommandHash }; },
    readIdentity: async () => identities.shift(),
    activatePid: async pid => { activatedPids.push(pid); },
    timeoutMs: 100, pollMs: 1,
  });
  assert.equal(result.status, "reactivated");
  assert.deepEqual(activatedPids, [native.ownerPid]);
  assert.equal(processReads, 2, "the same PID/profile binding is checked before and after activation");

  await assert.rejects(ensureOwnedNativeRendererForeground({
    native, expectedVault: activationVault,
    readProcessState: async pid => ({ pid, ownedProfileProcess: true, commandHash: native.ownerCommandHash }),
    readIdentity: async () => activationIdentity({ focused: false, ownerDocumentIsRenderer: false,
      ownerWindowIsRenderer: false }),
    activatePid: async pid => { activatedPids.push(pid); }, timeoutMs: 0,
  }), error => error.code === "NATIVE_ACTIVATION_FOREGROUND_TIMEOUT");
  assert.deepEqual(activatedPids, [native.ownerPid, native.ownerPid]);
});

test("Native profile trust binds the exact test Vault, profile root and Obsidian app bundle", () => {
  const standard = resolveNativeOwnedProfileApp(
    "/Users/jiajia/.codex/worktrees/obreader-0.14/evidence/macos-native-profile-run-1",
    { kind: "codex-owned-native-test-profile", allowedVault: "/Users/jiajia/Documents/ObReader-Apple-Test",
      appPath: "/Applications/Obsidian.app" },
  );
  assert.equal(standard, "/Applications/Obsidian.app/Contents/MacOS/Obsidian");

  const runtimeProfile = "/private/tmp/obreader-014-runtime/profile-1.14.5";
  const runtimeMarker = { kind: "codex-owned-native-test-profile", allowedVault: "/Users/jiajia/Documents/ObReader-Apple-Test",
    appPath: "/private/tmp/obreader-014-runtime/mnt/Obsidian.app" };
  assert.throws(() => resolveNativeOwnedProfileApp(runtimeProfile, runtimeMarker),
    error => error.code === "NATIVE_PROFILE_NOT_OWNED", "external test profiles require explicit opt-in");
  assert.equal(resolveNativeOwnedProfileApp(runtimeProfile, runtimeMarker, { allowRuntimeTestProfile: true }),
    "/private/tmp/obreader-014-runtime/mnt/Obsidian.app/Contents/MacOS/Obsidian");
  const scratchVault = "/private/tmp/obreader-014-runtime/native-loop-vaults/native-loop-b-fixture";
  const scratchProfile = "/private/tmp/obreader-014-runtime/profile-native-loop-b-fixture";
  const scratchMarker = { ...runtimeMarker, allowedVault: scratchVault };
  assert.equal(resolveNativeOwnedProfileApp(scratchProfile, scratchMarker, {
    allowRuntimeTestProfile: true,
    allowScratchNativeVault: true,
    expectedVault: scratchVault,
  }), "/private/tmp/obreader-014-runtime/mnt/Obsidian.app/Contents/MacOS/Obsidian");
  assert.throws(() => resolveNativeOwnedProfileApp(scratchProfile, scratchMarker, {
    allowRuntimeTestProfile: true,
    expectedVault: scratchVault,
  }), error => error.code === "NATIVE_PROFILE_NOT_OWNED");
  for (const [profile, marker] of [
    ["/private/tmp/obreader-014-runtime/profile-other/path", runtimeMarker],
    [runtimeProfile, { ...runtimeMarker, allowedVault: "/Users/jiajia/Documents/Other" }],
    [runtimeProfile, { ...runtimeMarker, appPath: "/Applications/Obsidian.app" }],
  ]) {
    assert.throws(() => resolveNativeOwnedProfileApp(profile, marker, { allowRuntimeTestProfile: true }),
      error => error.code === "NATIVE_PROFILE_NOT_OWNED");
  }
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

test("the Native learning runner can reactivate only the validated owner PID and rechecks focus", async () => {
  const runner = await readFile(new URL("./native-learning-loop.mjs", import.meta.url), "utf8");
  assert.match(runner, /ensureOwnedNativeRendererForeground\(/u);
  assert.match(runner, /assert\.equal\(pid, native\.ownerPid/u);
  assert.match(runner, /System Events/u);
  assert.match(runner, /unix id is \$\{pid\}/u);
  assert.match(runner, /set frontmost of targetProcess to true/u);
  assert.doesNotMatch(runner, /tell application "Obsidian" to activate|open -a Obsidian|NSRunningApplication|\.bringToFront\(|Browser\.setWindowBounds/u);
  assert.match(runner, /url: location\.href,[\s\S]*?title: document\.title/u);
  assert.match(runner, /assertNativeLearningForeground\(before/u);
  const main = runner.slice(runner.indexOf("async function main()"));
  assert.ok(main.indexOf("assertNativeLearningForeground(before") < main.indexOf("await installNativeIsolation()"),
    "foreground failure must happen before any test isolation or Vault mutation");
  const resumeCheck = main.indexOf("assertNativeResumeCandidate(report.candidateArtifact.files, resumeEvidence)");
  assert.ok(resumeCheck >= 0 && resumeCheck < main.indexOf("await enablePluginAfterIsolation()"),
    "stale or mixed-candidate resume receipts must be rejected before plugin enable or Native writes");
  const settingsClose = runner.indexOf("await ensureNativeOwnerForeground(\"after Settings window close\")");
  const closeWait = runner.indexOf("Settings window closed through macOS Cmd+W UI action");
  assert.ok(settingsClose > closeWait, "PID activation runs only after the owned Settings window closes");
});

test("Quartz pointer input is limited to the explicitly bound scratch stage and rechecks focus", async () => {
  const runner = await readFile(new URL("./native-learning-loop.mjs", import.meta.url), "utf8");
  const helper = await readFile(new URL("./native-os-pointer.mjs", import.meta.url), "utf8");
  const driver = await readFile(new URL("./native-os-pointer.swift", import.meta.url), "utf8");
  assert.match(runner, /PDF_READER_NATIVE_OS_POINTER === "1"/u);
  assert.match(runner, /scratchVaultMode && boundedOpenMoveStage && processOnlyBoundOwnedProfile/u);
  const focusAssertion = runner.indexOf("The exact scratch renderer must still own document focus before OS pointer input.");
  const dispatch = runner.indexOf("dispatchNativeOsPointerDrag({");
  assert.ok(focusAssertion >= 0 && focusAssertion < dispatch,
    "the exact scratch renderer must pass focus checks before Quartz events are posted");
  assert.match(helper, /execFileSync\("swift", \[DRIVER, "drag"/u);
  assert.match(driver, /CGEvent\(mouseEventSource: nil/u);
  assert.match(driver, /event\.post\(tap: \.cghidEventTap\)/u);
  assert.doesNotMatch(driver, /NSRunningApplication|System Events|open\(/u,
    "the pointer helper must not activate windows or apps");
});

test("Native Highlight setup observes PDF.js selection consumption and samples the entire drag path", async () => {
  const runner = await readFile(new URL("./native-learning-loop.mjs", import.meta.url), "utf8");
  assert.match(runner, /installNativeSelectionProbe\.toString\(\)/u);
  assert.match(runner, /probe\?\.consumers\s*\|\|\s*\[\]/u);
  assert.match(runner, /dragPathHitTests:\s*Array\.from\(\{ length: 13 \}/u);
  assert.match(runner, /beforeDrag\.dragPathHitTests\.every\(sample => sample\.inTextLayer\)/u);
  assert.match(runner, /if \(activeMode !== 9\) await frame\.click/u,
    "already-active Highlight must not be toggled off by Native setup");
  assert.match(runner, /reader-after-highlight-pointer-drag/u,
    "preserve the visible state immediately after the actual pointer gesture");
});
