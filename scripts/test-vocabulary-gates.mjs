#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.dirname(SCRIPT_DIR);
export const DEFAULT_ARTIFACTS_ROOT = path.join(DEFAULT_ROOT, "tests", "artifacts", "vocabulary-gates");
export const RACE_TESTS = Object.freeze([
  "tests/autosave-mobile-regression.test.mjs",
  "tests/highlight-multiline-regression.test.mjs",
  "tests/plugin-host.test.mjs",
  "tests/vocabulary-transactions.test.mjs",
  "tests/vocabulary-review-transaction-integration.test.mjs",
  "tests/vocabulary-v2-runtime.test.mjs",
]);
// Script-style browser checks are explicit additions, not part of the
// exhaustive tests/*.test.mjs classification.
export const BROWSER_SCRIPT_MANIFEST = Object.freeze([
  "tests/offline-smoke.mjs",
]);
const UNTRACKED_SOURCE_EXTENSIONS = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".mjs", ".ts", ".tsx", ".jsx",
]);
const SOURCE_FINGERPRINT_EXCLUDED_PREFIXES = Object.freeze([
  "docs/",
  "node_modules/",
  "dist/",
  "test-vault/",
]);

function isExcludedFingerprintPath(file) {
  const normalized = file.replaceAll("\\", "/");
  return SOURCE_FINGERPRINT_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    normalized.split("/").includes("artifacts") ||
    normalized.split("/").includes(".git");
}

function gitPaths(rootDir, args) {
  return execFileSync("git", ["ls-files", "-z", ...args], {
    cwd:rootDir,
    encoding:"buffer",
    stdio:["ignore", "pipe", "pipe"],
  }).toString("utf8").split("\0").filter(Boolean);
}

async function fingerprintFile(rootDir, relativePath) {
  const absolutePath = path.join(rootDir, relativePath);
  let info;
  try {
    info = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") return createHash("sha256").update("missing").digest("hex");
    throw error;
  }
  const content = info.isSymbolicLink()
    ? Buffer.from(`symlink:${await readlink(absolutePath)}`)
    : info.isDirectory()
    ? Buffer.from("gitlink:directory")
    : await readFile(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}

/** Hash tracked files and untracked source files, excluding generated and evidence paths. */
export async function captureSourceFingerprint(rootDir = DEFAULT_ROOT) {
  const tracked = gitPaths(rootDir, ["--cached"]);
  const untracked = gitPaths(rootDir, ["--others", "--exclude-standard"])
    .filter((file) => UNTRACKED_SOURCE_EXTENSIONS.has(path.posix.extname(file).toLowerCase()));
  const files = [...new Set([...tracked, ...untracked])]
    .filter((file) => !isExcludedFingerprintPath(file))
    .sort();
  const fileHashes = {};
  const aggregate = createHash("sha256");
  for (const file of files) {
    const hash = await fingerprintFile(rootDir, file);
    fileHashes[file] = hash;
    aggregate.update(file).update("\0").update(hash).update("\0");
  }
  return {
    algorithm:"sha256",
    hash:aggregate.digest("hex"),
    fileCount:files.length,
    files:fileHashes,
  };
}

export function diffSourceFingerprints(before, after) {
  const paths = [...new Set([
    ...Object.keys(before?.files || {}),
    ...Object.keys(after?.files || {}),
  ])].sort();
  const changedFiles = paths.filter((file) => before?.files?.[file] !== after?.files?.[file]);
  return {
    stable:!!before?.hash && before.hash === after?.hash,
    changedFiles,
  };
}

function fingerprintSummary(fingerprint) {
  if (!fingerprint) return null;
  return {
    algorithm:fingerprint.algorithm,
    hash:fingerprint.hash,
    fileCount:fingerprint.fileCount,
  };
}

export function casesForGate(gate) {
  if (gate === "browser") {
    return [
      ...GATE_MANIFEST.browser.map((file) => ({ file, execution: "test" })),
      ...BROWSER_SCRIPT_MANIFEST.map((file) => ({ file, execution: "script" })),
    ];
  }
  if (gate === "fast") return GATE_MANIFEST.fast;
  throw new Error(`No static case list for gate: ${gate}`);
}

// Every tests/*.test.mjs file belongs to exactly one maintained gate class.
// Browser files are the suites that launch a real Chromium/Edge process. The
// launch/cleanup helper unit suites stay in fast because they use fake children.
export const GATE_MANIFEST = Object.freeze({
  fast: Object.freeze([
    "tests/annotation-controller.test.mjs",
    "tests/annotation-observer-isolation.test.mjs",
    "tests/asset-runtime-guards.test.mjs",
    "tests/asset-runtime-performance.test.mjs",
    "tests/asset-runtime-stat-index.test.mjs",
    "tests/asset-runtime.test.mjs",
    "tests/backlink-interaction-controller.test.mjs",
    "tests/browser-test-cleanup.test.mjs",
    "tests/browser-test-launch.test.mjs",
    "tests/bulk-annotation-delete.test.mjs",
    "tests/build-dictionary-resource.test.mjs",
    "tests/controlled-close-nonblocking.test.mjs",
    "tests/controlled-close-publication.test.mjs",
    "tests/default-routing.test.mjs",
    "tests/deletion-retention.test.mjs",
    "tests/dictionary-cache.test.mjs",
    "tests/dictionary-host-state.test.mjs",
    "tests/detached-writeback-integration.test.mjs",
    "tests/external-annotation-bridge.test.mjs",
    "tests/external-hydration-race.test.mjs",
    "tests/general-incremental-audit.test.mjs",
    "tests/heavy-work.test.mjs",
    "tests/highlight-row-collision.test.mjs",
    "tests/input-architecture-boundary.test.mjs",
    "tests/interaction-mode.test.mjs",
    "tests/lingq-read-mode-transition.test.mjs",
    "tests/ios-direct-manipulation-controller.test.mjs",
    "tests/ios-input-policy.test.mjs",
    "tests/mobile-main.test.mjs",
    "tests/native-selection-probe.test.mjs",
    "tests/native-sidecar-isolation.test.mjs",
    "tests/native-tooling.test.mjs",
    "tests/packaging.test.mjs",
    "tests/pdf-annotation-host.test.mjs",
    "tests/pdf-annotation-store.test.mjs",
    "tests/pdf-hash-runtime.test.mjs",
    "tests/pdf-incremental.test.mjs",
    "tests/pdf-journal.test.mjs",
    "tests/pdf-merge-client.test.mjs",
    "tests/pdf-merge-core.test.mjs",
    "tests/pdf-merge-worker.test.mjs",
    "tests/pdf-recovery.test.mjs",
    "tests/pdf-sync-host.test.mjs",
    "tests/pdfjs-annotation-permission-policy.test.mjs",
    "tests/pdfjs-collapsed-selection-backport.test.mjs",
    "tests/pdfjs-drawing-session-regression.test.mjs",
    "tests/pending-save-integration.test.mjs",
    "tests/plugin-host.test.mjs",
    "tests/reader-anchor-store.test.mjs",
    "tests/secondary-toolbar-labels.test.mjs",
    "tests/selection-pointer-capture.test.mjs",
    "tests/session-log.test.mjs",
    "tests/source-binding-matrix.test.mjs",
    "tests/startup-prewarm.test.mjs",
    "tests/store-checkpoint-race.test.mjs",
    "tests/store-cross-instance-race.test.mjs",
    "tests/store-gc-race.test.mjs",
    "tests/store-process-crash-boundary.test.mjs",
    "tests/text-selection-controller.test.mjs",
    "tests/tool-wheel-release-policy.test.mjs",
    "tests/touch-inertia.test.mjs",
    "tests/vocabulary-bridge-open-state.test.mjs",
    "tests/vocabulary-canonical.test.mjs",
    "tests/vocabulary-context-service.test.mjs",
    "tests/vocabulary-controller.test.mjs",
    "tests/vocabulary-context-identity.test.mjs",
    "tests/vocabulary-dictionary.test.mjs",
    "tests/vocabulary-line-end-hyphen-regression.test.mjs",
    "tests/vocabulary-history.test.mjs",
    "tests/vocabulary-nightly-gate.test.mjs",
    "tests/vocabulary-normalizer-scanner.test.mjs",
    "tests/vocabulary-phrase-matcher.test.mjs",
    "tests/vocabulary-pill-placement.test.mjs",
    "tests/vocabulary-presentation.test.mjs",
    "tests/vocabulary-service.test.mjs",
    "tests/vocabulary-review-service.test.mjs",
    "tests/vocabulary-review-transaction-integration.test.mjs",
    "tests/vocabulary-sharded-store.test.mjs",
    "tests/vocabulary-tap-priority.test.mjs",
    "tests/vocabulary-transactions.test.mjs",
    "tests/vocabulary-transfer-v2.test.mjs",
    "tests/vocabulary-transfer-large.test.mjs",
    "tests/vocabulary-workbench.test.mjs",
    "tests/vocabulary-word-morphology.test.mjs",
    "tests/vocabulary-v2-boundaries.test.mjs",
    "tests/vocabulary-v2-context-source.test.mjs",
    "tests/vocabulary-v2-device-identity.test.mjs",
    "tests/vocabulary-v2-runtime.test.mjs",
    "tests/vocabulary-v2-schema-family.test.mjs",
    "tests/wal-boundaries.test.mjs",
    "tests/wal-chaos.test.mjs",
    "tests/wal-host.test.mjs",
    "tests/wal-importer.test.mjs",
    "tests/wal-model.test.mjs",
    "tests/wal-persistence.test.mjs",
    "tests/wal-source-binding.test.mjs",
    "tests/wal-store-integration.test.mjs",
    "tests/wal-v32-bridge.test.mjs",
    "tests/wal-v32-crash.test.mjs",
    "tests/wal-v32-engine.test.mjs",
    "tests/wal-v32-store-integration.test.mjs",
    "tests/test-gate-runner.test.mjs",
  ]),
  browser: Object.freeze([
    "tests/annotation-interaction-regression.test.mjs",
    "tests/autosave-mobile-regression.test.mjs",
    "tests/autosave-regression.test.mjs",
    "tests/annotation-observer-lifecycle-browser.test.mjs",
    "tests/desktop-toolbar.test.mjs",
    "tests/dictionary-cache-browser.test.mjs",
    "tests/embedded-annotation-scan.test.mjs",
    "tests/free-text-undo-appearance-regression.test.mjs",
    "tests/free-text-native-ap-undo-regression.test.mjs",
    "tests/highlight-multiline-regression.test.mjs",
    "tests/ipad-pointer-policy.test.mjs",
    "tests/mobile-browser-startup.test.mjs",
    "tests/mouse-input-regression.test.mjs",
    "tests/native-finger-ownership.test.mjs",
    "tests/open-lifecycle-regression.test.mjs",
    "tests/pdfjs-highlight-collision-browser.test.mjs",
    "tests/reader-bidirectional-link-browser.test.mjs",
    "tests/selection-differential.test.mjs",
    "tests/sidecar-freetext-geometry.test.mjs",
    "tests/sidecar-freetext-hydration.test.mjs",
    "tests/sync-bridge-regression.test.mjs",
    "tests/tool-wheel-lingq-browser.test.mjs",
    "tests/underline-regression.test.mjs",
    "tests/vocabulary-pill-layout-browser.test.mjs",
    "tests/vocabulary-read-mode-transition-browser.test.mjs",
    "tests/vocabulary-workbench-browser.test.mjs",
    "tests/vocabulary-word-morphology-browser.test.mjs",
  ]),
});

export function validateManifest(rootDir = DEFAULT_ROOT, manifest = GATE_MANIFEST) {
  const listed = Object.entries(manifest).flatMap(([gate, files]) =>
    files.map((file) => ({ gate, file })),
  );
  const browserScripts = [...BROWSER_SCRIPT_MANIFEST];
  const duplicates = listed
    .map(({ file }) => file)
    .filter((file, index, all) => all.indexOf(file) !== index);
  const duplicateBrowserScripts = browserScripts.filter((file, index, all) =>
    all.indexOf(file) !== index || listed.some((item) => item.file === file),
  );
  const discovered = readdir(path.join(rootDir, "tests"), { withFileTypes: true });
  return discovered.then((entries) => {
    const actual = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
      .map((entry) => `tests/${entry.name}`)
      .sort();
    const actualNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => `tests/${entry.name}`));
    const expected = listed.map(({ file }) => file).sort();
    const missing = actual.filter((file) => !expected.includes(file));
    const stale = expected.filter((file) => !actual.includes(file));
    const missingBrowserScripts = browserScripts.filter((file) => !actualNames.has(file));
    return {
      ok: duplicates.length === 0 && missing.length === 0 && stale.length === 0 &&
        duplicateBrowserScripts.length === 0 && missingBrowserScripts.length === 0,
      duplicates,
      missing,
      stale,
      duplicateBrowserScripts,
      missingBrowserScripts,
      actual,
    };
  });
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "case";
}

function parseTapSkips(text) {
  const skips = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*ok\s+(\d+)(?:\s+-\s+(.*?))?\s+#\s*SKIP(?:\s+(.*))?\s*$/i);
    if (match) skips.push({ number: Number(match[1]), name: match[2] || null, reason: match[3] || null, line });
  }
  return skips;
}

function childEnvironment({ env = process.env, rootDir, runId, gate, testFile, round, profileDir, artifactsDir }) {
  return {
    ...env,
    TMPDIR: profileDir,
    TMP: profileDir,
    TEMP: profileDir,
    VOCABULARY_GATE_RUN_ID: runId,
    VOCABULARY_GATE_NAME: gate,
    VOCABULARY_GATE_TEST: testFile,
    VOCABULARY_GATE_ROUND: String(round ?? 1),
    VOCABULARY_GATE_PROFILE_DIR: profileDir,
    VOCABULARY_GATE_ARTIFACTS_DIR: artifactsDir,
    // Test servers bind port 0 and let the OS assign a collision-free port.
    VOCABULARY_GATE_PORT: "0",
    PDF_READER_TEST_PORT: "0",
    VOCABULARY_GATE_ROOT: rootDir,
  };
}

async function ensureCaseDirectories(caseDir, artifactsDir) {
  await mkdir(path.join(caseDir, "artifacts"), { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
}

function waitForStreamFinish(stream) {
  if (stream.closed || stream.writableFinished) return Promise.resolve();
  return once(stream, "finish").then(() => undefined);
}

/** Run independent Node test files with a strict process cap and preserve raw child streams. */
export async function runCases(cases, {
  rootDir = DEFAULT_ROOT,
  runId = `run-${Date.now()}-${process.pid}`,
  artifactsRoot = DEFAULT_ARTIFACTS_ROOT,
  parallelism = 1,
  gate = "fast",
  round = null,
  spawnImpl = (command, args, options) => spawn(command, args, options),
} = {}) {
  if (!Number.isInteger(parallelism) || parallelism < 1) throw new RangeError("parallelism must be a positive integer");
  if (gate === "fast" && parallelism > 4) throw new RangeError("fast gate is capped at 4 child processes");
  if (gate === "browser" && parallelism !== 1) throw new RangeError("browser gate must use exactly 1 child process");
  if (gate === "race" && parallelism !== 2) throw new RangeError("race gate must use exactly 2 child processes");

  const results = new Array(cases.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= cases.length) return;
      const item = typeof cases[index] === "string" ? { file: cases[index] } : cases[index];
      const testFile = item.file;
      const execution = item.execution || "test";
      if (!["test", "script"].includes(execution)) throw new Error(`Unknown case execution mode: ${execution}`);
      const itemGate = item.gate || gate;
      const itemRound = item.round ?? round ?? 1;
      const key = `${itemGate}-round-${String(itemRound).padStart(2, "0")}-${path.basename(testFile, ".test.mjs")}`;
      const caseDir = path.join(artifactsRoot, "runs", runId, "children", safeName(key));
      const artifactKey = createHash("sha256")
        .update(`${runId}\0${itemGate}\0${itemRound}\0${testFile}`)
        .digest("hex")
        .slice(0, 12);
      const artifactName = safeName(path.basename(testFile, ".test.mjs")).slice(0, 24) || "case";
      // Keep retained test artifacts below a short per-case path. The raw
      // runner logs remain under caseDir, while browser profiles/screenshots
      // must not exceed Windows MAX_PATH when launch metadata adds more levels.
      const testArtifactsDir = path.join(artifactsRoot, "out", artifactKey, artifactName);
      await ensureCaseDirectories(caseDir, testArtifactsDir);
      // Keep OS temp paths shallow. Nesting temporary browser profiles under
      // the retained run-artifact tree exceeds the Windows MAX_PATH limit once
      // browser tests create their own artifacts below TMPDIR.
      const profileDir = await mkdtemp(path.join(tmpdir(), "pvr-gate-"));
      const stdoutPath = path.join(caseDir, "stdout.raw.log");
      const stderrPath = path.join(caseDir, "stderr.raw.log");
      const stdoutStream = createWriteStream(stdoutPath, { flags: "wx" });
      const stderrStream = createWriteStream(stderrPath, { flags: "wx" });
      const env = childEnvironment({ env: process.env, rootDir, runId, gate: itemGate, testFile, round: itemRound, profileDir, artifactsDir: testArtifactsDir });
      const resolvedFile = path.resolve(rootDir, testFile);
      const args = execution === "script"
        ? [resolvedFile]
        : ["--test", "--test-reporter=tap", resolvedFile];
      let child;
      let spawnError = null;
      let exitCode = null;
      let signal = null;
      try {
        child = await spawnImpl(process.execPath, args, { cwd: rootDir, env, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.pipe(stdoutStream);
        child.stderr.pipe(stderrStream);
        child.once("error", (error) => { spawnError = { name: error?.name || "Error", message: error?.message || String(error) }; });
        const [code, childSignal] = await once(child, "close");
        exitCode = code;
        signal = childSignal;
      } catch (error) {
        spawnError = { name: error?.name || "Error", message: error?.message || String(error) };
      } finally {
        if (!stdoutStream.destroyed) stdoutStream.end();
        if (!stderrStream.destroyed) stderrStream.end();
        await Promise.all([waitForStreamFinish(stdoutStream), waitForStreamFinish(stderrStream)]);
      }

      const { readFile } = await import("node:fs/promises");
      const stdout = await readFile(stdoutPath, "utf8");
      const stderr = await readFile(stderrPath, "utf8");
      const skips = parseTapSkips(stdout);
      const status = exitCode === 0 && signal === null && !spawnError && skips.length === 0 ? "passed" : "failed";
      results[index] = {
        gate: itemGate,
        round: itemRound,
        test: testFile,
        execution,
        status,
        exitCode,
        signal,
        spawnError,
        skipCount: skips.length,
        skips,
        stdoutPath,
        stderrPath,
        testArtifactsPath: testArtifactsDir,
        rawBytes: { stdout: Buffer.byteLength(stdout), stderr: Buffer.byteLength(stderr) },
        logContainsFailure: /\bnot ok\b|ERR_TEST_FAILURE|AssertionError|Error:/i.test(`${stdout}\n${stderr}`),
      };
      if (status === "passed") {
        await rm(profileDir, { recursive: true, force: true });
      } else {
        // Keep a failed child's private temp directory available for diagnosis.
        results[index].profileTempPath = profileDir;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(parallelism, cases.length) }, worker));
  return results;
}

export async function runRaceRounds({ rounds = 10, rootDir = DEFAULT_ROOT, runId, artifactsRoot = DEFAULT_ARTIFACTS_ROOT, spawnImpl } = {}) {
  if (!Number.isInteger(rounds) || rounds < 10) throw new RangeError("race gate requires at least 10 rounds");
  const results = [];
  for (let round = 1; round <= rounds; round += 1) {
    const pair = await runCases(RACE_TESTS.map((file) => ({ file, gate: "race", round })), {
      rootDir,
      runId,
      artifactsRoot,
      parallelism: 2,
      gate: "race",
      round,
      spawnImpl,
    });
    results.push({ round, tests: pair, status: pair.every((result) => result.status === "passed") ? "passed" : "failed" });
  }
  return results;
}

function summarizeResults(results) {
  const flat = results.flatMap((result) => result.tests ? result.tests : [result]);
  return {
    total: flat.length,
    passed: flat.filter((result) => result.status === "passed").length,
    failed: flat.filter((result) => result.status !== "passed").length,
    skipped: flat.reduce((sum, result) => sum + (result.skipCount || 0), 0),
  };
}

export function summarizeGates(gates) {
  const byGate = Object.fromEntries(Object.entries(gates).map(([name, results]) => [name, summarizeResults(results)]));
  const totals = Object.values(byGate).reduce((sum, value) => ({
    total: sum.total + value.total,
    passed: sum.passed + value.passed,
    failed: sum.failed + value.failed,
    skipped: sum.skipped + value.skipped,
  }), { total: 0, passed: 0, failed: 0, skipped: 0 });
  return { ...byGate, ...totals };
}

function parseArgs(argv) {
  const [gate, ...rest] = argv;
  const options = { gate: gate || "" };
  if (gate === "--help" || gate === "-h") {
    options.help = true;
    return options;
  }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--help" || value === "-h") options.help = true;
    else if (value === "--jobs") options.jobs = Number(rest[++index]);
    else if (value.startsWith("--jobs=")) options.jobs = Number(value.slice("--jobs=".length));
    else if (value === "--rounds") options.rounds = Number(rest[++index]);
    else if (value.startsWith("--rounds=")) options.rounds = Number(value.slice("--rounds=".length));
    else if (value === "--report") options.reportPath = rest[++index];
    else if (value.startsWith("--report=")) options.reportPath = value.slice("--report=".length);
    else throw new Error(`Unknown option: ${value}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node scripts/test-vocabulary-gates.mjs <fast|browser|race|all> [options]",
    "  fast     Run all fast tests with at most 4 child processes (default 4).",
    "  browser  Run all real-browser suites sequentially (one test process/browser at a time).",
    "  race     Run the maintained concurrency-sensitive pairs together for at least 10 rounds.",
    "  all      Run fast, browser, then race and retain one JSON report plus raw logs.",
    "Options:",
    "  --jobs N       Fast gate process cap, 1..4.",
    "  --rounds N     Race repetitions, minimum 10 (default 10).",
    "  --report PATH  JSON report path under tests/artifacts/vocabulary-gates/.",
    "Reports include before/after source fingerprints; any source change marks the run ineligible for acceptance.",
  ].join("\n");
}

async function runMain(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!["fast", "browser", "race", "all"].includes(options.gate)) throw new Error(`Unknown gate: ${options.gate || "(missing)"}`);
  if (options.jobs !== undefined && (!Number.isInteger(options.jobs) || options.jobs < 1 || options.jobs > 4)) {
    throw new RangeError("--jobs must be an integer from 1 through 4");
  }
  const rounds = options.rounds ?? 10;
  if (!Number.isInteger(rounds) || rounds < 10) throw new RangeError("--rounds must be an integer of at least 10");
  if (options.gate !== "race" && options.gate !== "all" && options.rounds !== undefined) {
    throw new Error("--rounds is only valid for race and all gates");
  }
  if (options.gate !== "fast" && options.gate !== "all" && options.jobs !== undefined) {
    throw new Error("--jobs is only valid for fast and all gates");
  }

  if (process.env.NATIVE_AP_BRIDGE_SOURCE) {
    throw new Error("NATIVE_AP_BRIDGE_SOURCE is a diagnostic source override and cannot be used for gate acceptance.");
  }
  const sourceFingerprintBefore = await captureSourceFingerprint(DEFAULT_ROOT);
  const manifest = await validateManifest();
  if (!manifest.ok) {
    throw new Error(`Gate manifest mismatch: ${JSON.stringify({
      duplicates: manifest.duplicates,
      missing: manifest.missing,
      stale: manifest.stale,
      duplicateBrowserScripts: manifest.duplicateBrowserScripts,
      missingBrowserScripts: manifest.missingBrowserScripts,
    })}`);
  }
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runRoot = path.join(DEFAULT_ARTIFACTS_ROOT, "runs", runId);
  await mkdir(runRoot, { recursive: true });
  const gates = {};
  const requested = options.gate === "all" ? ["fast", "browser", "race"] : [options.gate];
  for (const gate of requested) {
    if (gate === "race") {
      gates.race = await runRaceRounds({ rounds, runId, artifactsRoot: DEFAULT_ARTIFACTS_ROOT });
    } else {
      const parallelism = gate === "fast" ? (options.jobs ?? 4) : 1;
      gates[gate] = await runCases(casesForGate(gate), {
        rootDir: DEFAULT_ROOT,
        runId,
        artifactsRoot: DEFAULT_ARTIFACTS_ROOT,
        parallelism,
        gate,
      });
    }
  }
  let sourceFingerprintAfter = null;
  let sourceFingerprintError = null;
  try {
    sourceFingerprintAfter = await captureSourceFingerprint(DEFAULT_ROOT);
  } catch (error) {
    sourceFingerprintError = { name:error?.name || "Error", message:error?.message || String(error) };
  }
  const sourceFingerprintDiff = sourceFingerprintAfter
    ? diffSourceFingerprints(sourceFingerprintBefore, sourceFingerprintAfter)
    : { stable:false, changedFiles:[] };
  const report = {
    schemaVersion: 1,
    runId,
    gate: options.gate,
    createdAt: new Date().toISOString(),
    root: DEFAULT_ROOT,
    constraints: { fastMaxProcesses: 4, browserProcesses: 1, raceProcesses: 2, raceRounds: options.gate === "fast" || options.gate === "browser" ? null : rounds, skipPolicy: "any skipped test fails its gate", timeoutPolicy: "test-defined timeouts only; runner adds none", retries: 0 },
    manifest: {
      fast: GATE_MANIFEST.fast.length,
      browserTests: GATE_MANIFEST.browser.length,
      browserScripts: BROWSER_SCRIPT_MANIFEST,
      racePair: RACE_TESTS,
    },
    sourceFingerprint: {
      policy:"SHA-256 of Git-tracked files plus untracked source files; excludes docs, dist, node_modules, test-vault, .git, and artifact directories.",
      before:fingerprintSummary(sourceFingerprintBefore),
      after:fingerprintSummary(sourceFingerprintAfter),
      stable:sourceFingerprintDiff.stable,
      changedFiles:sourceFingerprintDiff.changedFiles,
      captureError:sourceFingerprintError,
    },
    gates,
  };
  report.summary = summarizeGates(gates);
  report.acceptanceEligible = report.summary.failed === 0 && sourceFingerprintDiff.stable;
  let reportPath = path.join(runRoot, "report.json");
  if (options.reportPath) {
    reportPath = path.resolve(DEFAULT_ROOT, options.reportPath);
    const relative = path.relative(DEFAULT_ARTIFACTS_ROOT, reportPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("--report must stay under tests/artifacts/vocabulary-gates/");
  }
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Gate ${options.gate}: ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.\n`);
  process.stdout.write(`Acceptance eligible: ${report.acceptanceEligible ? "yes" : "no"}.\n`);
  if (!sourceFingerprintDiff.stable) {
    const changed = sourceFingerprintDiff.changedFiles.length
      ? sourceFingerprintDiff.changedFiles.join(", ")
      : sourceFingerprintError?.message || "after-run source fingerprint unavailable";
    process.stderr.write(`Source changed during this run: ${changed}\n`);
  }
  process.stdout.write(`JSON report: ${reportPath}\nRaw child logs: ${path.join(runRoot, "children")}\n`);
  return report.acceptanceEligible ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMain(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${error?.stack || error}\n${usage()}\n`);
    process.exitCode = 2;
  });
}
