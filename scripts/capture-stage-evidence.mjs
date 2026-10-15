import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARTIFACT_ROOT = path.join(REPO_ROOT, "tests", "artifacts");
const TEST_PLUGIN_DIR = String.raw`D:\Documents\Obsidian\测试插件\.obsidian\plugins\pdf-web-reader`;
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];
const EVIDENCE_DIR = path.join(ARTIFACT_ROOT, `stage-evidence-${timestampToken()}-${process.pid}`);

function timestampToken() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}

function runCapture(command, args, { cwd = REPO_ROOT, maxBuffer = 64 * 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
  return {
    command: [command, ...args],
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function gitCapture(args) {
  const result = runCapture("git", args);
  if (result.error || result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error || result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function sha256File(filePath) {
  try {
    const bytes = await readFile(filePath);
    return { path: filePath, exists: true, bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: filePath, exists: false, sha256: null };
    throw error;
  }
}

async function hashTriplet(directory) {
  const files = {};
  for (const name of PLUGIN_FILES) files[name] = await sha256File(path.join(directory, name));
  const complete = Object.values(files).every((entry) => entry.exists);
  const combinedSha256 = complete
    ? createHash("sha256").update(PLUGIN_FILES.map((name) => `${name}\0${files[name].sha256}\n`).join("")).digest("hex")
    : null;
  return { directory, complete, combinedSha256, files };
}

async function captureSnapshot(label) {
  const status = gitCapture(["status", "--short", "--branch", "--untracked-files=all"]);
  const branch = gitCapture(["branch", "--show-current"]).trim();
  const head = gitCapture(["rev-parse", "HEAD"]).trim();
  const trackedDiff = gitCapture(["diff", "--no-ext-diff", "--binary", "HEAD", "--"]);
  const untracked = gitCapture(["ls-files", "--others", "--exclude-standard"]);
  const distTriplet = await hashTriplet(path.join(REPO_ROOT, "dist", "pdf-web-reader"));
  const installedTestTriplet = await hashTriplet(TEST_PLUGIN_DIR);

  await writeFile(path.join(EVIDENCE_DIR, `${label}-status.txt`), status, { flag: "wx" });
  await writeFile(path.join(EVIDENCE_DIR, `${label}-tracked.diff`), trackedDiff, { flag: "wx" });
  await writeFile(path.join(EVIDENCE_DIR, `${label}-untracked.txt`), untracked, { flag: "wx" });
  await writeFile(path.join(EVIDENCE_DIR, `${label}-triplet-sha256.json`),
    `${JSON.stringify({ dist: distTriplet, installedTest: installedTestTriplet }, null, 2)}\n`, { flag: "wx" });

  const snapshot = {
    label,
    capturedAt: new Date().toISOString(),
    repoRoot: REPO_ROOT,
    statusFile: `${label}-status.txt`,
    trackedDiffFile: `${label}-tracked.diff`,
    untrackedFile: `${label}-untracked.txt`,
    tripletHashesFile: `${label}-triplet-sha256.json`,
    branch,
    head,
    trackedDiffBytes: Buffer.byteLength(trackedDiff),
    untrackedEntryCount: untracked.split(/\r?\n/).filter(Boolean).length,
    distTriplet,
    installedTestTriplet,
  };
  await writeFile(path.join(EVIDENCE_DIR, `${label}-snapshot.json`), `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
  return snapshot;
}

function parseTestTotals(text) {
  const values = {};
  const patterns = {
    tests: /(?:#|ℹ)\s*tests\s+(\d+)/i,
    passed: /(?:#|ℹ)\s*pass\s+(\d+)/i,
    failed: /(?:#|ℹ)\s*fail\s+(\d+)/i,
    cancelled: /(?:#|ℹ)\s*cancelled\s+(\d+)/i,
    skipped: /(?:#|ℹ)\s*skipped\s+(\d+)/i,
    todo: /(?:#|ℹ)\s*todo\s+(\d+)/i,
  };
  for (const [key, pattern] of Object.entries(patterns)) {
    const match = text.match(pattern);
    values[key] = match ? Number(match[1]) : null;
  }
  return values;
}

function runAndCapture(label, args) {
  return new Promise((resolve) => {
    const command = process.platform === "win32" ? "npm.cmd" : "npm";
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => { spawnError = String(error); });
    child.on("close", async (exitCode, signal) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      const combined = `${out}\n${err}`;
      const result = {
        label,
        command: ["npm", ...args],
        startedAt: resultStartedAt,
        completedAt: new Date().toISOString(),
        exitCode,
        signal,
        spawnError,
        totals: label === "npm-test" ? parseTestTotals(combined) : null,
        stdoutFile: `${label}.stdout.log`,
        stderrFile: `${label}.stderr.log`,
      };
      try {
        await writeFile(path.join(EVIDENCE_DIR, result.stdoutFile), out, { flag: "wx" });
        await writeFile(path.join(EVIDENCE_DIR, result.stderrFile), err, { flag: "wx" });
        await writeFile(path.join(EVIDENCE_DIR, `${label}.result.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
      } catch (error) {
        result.captureError = String(error);
      }
      resolve(result);
    });
    const resultStartedAt = new Date().toISOString();
  });
}

async function main() {
  await mkdir(EVIDENCE_DIR, { recursive: false });
  console.log(`Evidence directory: ${EVIDENCE_DIR}`);

  const before = await captureSnapshot("before");
  console.log(`Baseline frozen: branch=${before.branch || "(detached)"} HEAD=${before.head}; starting npm test.`);

  const testResult = await runAndCapture("npm-test", ["test"]);
  console.log(`npm test finished: exit=${testResult.exitCode ?? "null"} totals=${JSON.stringify(testResult.totals)}`);

  const offlineResult = await runAndCapture("npm-test-offline", ["run", "test:offline"]);
  console.log(`npm run test:offline finished: exit=${offlineResult.exitCode ?? "null"}`);

  const after = await captureSnapshot("after");
  const summary = {
    capturedAt: new Date().toISOString(),
    evidenceDirectory: EVIDENCE_DIR,
    before,
    testResult,
    offlineResult,
    after,
    trackedHeadDiffChanged: before.head !== after.head,
    trackedDiffChanged: before.trackedDiffBytes !== after.trackedDiffBytes ||
      await readFile(path.join(EVIDENCE_DIR, "before-tracked.diff"), "utf8") !==
      await readFile(path.join(EVIDENCE_DIR, "after-tracked.diff"), "utf8"),
    untrackedListChanged: await readFile(path.join(EVIDENCE_DIR, "before-untracked.txt"), "utf8") !==
      await readFile(path.join(EVIDENCE_DIR, "after-untracked.txt"), "utf8"),
    distTripletChanged: before.distTriplet.combinedSha256 !== after.distTriplet.combinedSha256,
    installedTestTripletChanged: before.installedTestTriplet.combinedSha256 !== after.installedTestTriplet.combinedSha256,
  };
  await writeFile(path.join(EVIDENCE_DIR, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  console.log(`Evidence complete: ${path.join(EVIDENCE_DIR, "summary.json")}`);
  process.exitCode = testResult.exitCode || offlineResult.exitCode || 0;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
