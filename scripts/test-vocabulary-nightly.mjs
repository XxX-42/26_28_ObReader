#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { captureSourceFingerprint } from "./test-vocabulary-gates.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.dirname(SCRIPT_DIR);
export const DEFAULT_DURATION_MS = 30 * 60 * 1000;
export const NIGHTLY_MATRIX = Object.freeze([
  { id: "lexical-scale", command: "node", args: ["scripts/benchmark-vocabulary-v2.mjs"],
    covers: ["5,340/25,000 records", "6,000 page tokens", "12-token phrase", "cold/warm/re-entry/next-page", "overflow rejection"] },
  { id: "large-transfer", command: "node", args: ["--test", "--test-concurrency=1", "tests/vocabulary-transfer-large.test.mjs"],
    covers: ["25,000-record export/preview/import", "history file and byte amplification"] },
  { id: "fast", command: "node", args: ["scripts/test-vocabulary-gates.mjs", "fast"],
    covers: ["schema/migration", "family", "Context/Review/History", "dictionary faults/concurrency", "transaction faults", "static hot-path boundaries"] },
  { id: "browser", command: "node", args: ["scripts/test-vocabulary-gates.mjs", "browser"],
    covers: ["Reader lifecycle", "LingQ UI/toggle", "zoom geometry", "desktop/mobile browser simulation", "offline three-file smoke"] },
  { id: "race", command: "node", args: ["scripts/test-vocabulary-gates.mjs", "race"],
    covers: ["ten rounds of isolated concurrent persistence and lifecycle tests"] },
]);

export function parseNightlyOptions(argv = []) {
  let durationMs = DEFAULT_DURATION_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true, durationMs };
    const match = /^--duration-ms(?:=(\d+))?$/.exec(value);
    if (match) {
      const raw = match[1] ?? argv[++index];
      durationMs = Number(raw);
      if (!Number.isSafeInteger(durationMs) || durationMs < 1) {
        throw new RangeError("--duration-ms must be a positive safe integer.");
      }
      continue;
    }
    throw new Error(`Unknown nightly stress option: ${value}`);
  }
  return { help: false, durationMs };
}

function summarizeFingerprint(value) {
  return { algorithm: value.algorithm, hash: value.hash, fileCount: value.fileCount };
}

async function listPdfFixtureHashes(rootDir) {
  const output = {};
  async function visit(directory) {
    let names;
    try { names = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
        output[relative] = createHash("sha256").update(await readFile(absolute)).digest("hex");
      }
    }
  }
  await visit(path.join(rootDir, "tests", "fixtures"));
  return output;
}

async function writeReport(runDirectory, report) {
  const target = path.join(runDirectory, "report.json");
  const pending = target + ".tmp";
  await writeFile(pending, JSON.stringify(report, null, 2) + "\n");
  await rename(pending, target);
  return target;
}

function keepTail(current, chunk, limit = 24 * 1024) {
  const next = current + chunk.toString("utf8");
  return next.length > limit ? next.slice(-limit) : next;
}

async function runChild({ rootDir, workingDirectory, roundDirectory, id, command, args }) {
  const caseDirectory = path.join(roundDirectory, id);
  await mkdir(caseDirectory, { recursive: true });
  const stdoutPath = path.join(caseDirectory, "stdout.raw.log");
  const stderrPath = path.join(caseDirectory, "stderr.raw.log");
  const stdout = createWriteStream(stdoutPath, { flags: "wx" });
  const stderr = createWriteStream(stderrPath, { flags: "wx" });
  const started = performance.now();
  let stdoutTail = "";
  let stderrTail = "";
  const child = spawn(process.execPath, args, {
    cwd: workingDirectory,
    env: { ...process.env, VOCABULARY_NIGHTLY_RUN: path.basename(path.dirname(roundDirectory)) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { stdout.write(chunk); stdoutTail = keepTail(stdoutTail, chunk); });
  child.stderr.on("data", (chunk) => { stderr.write(chunk); stderrTail = keepTail(stderrTail, chunk); });
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: null, signal: null, spawnError: `${error.name}: ${error.message}` }));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError: null }));
  });
  await Promise.all([new Promise((resolve) => stdout.end(resolve)), new Promise((resolve) => stderr.end(resolve))]);
  const durationMs = performance.now() - started;
  const row = { id, command, args, ...result, durationMs: Math.round(durationMs * 100) / 100,
    stdoutPath: path.relative(rootDir, stdoutPath).split(path.sep).join("/"),
    stderrPath: path.relative(rootDir, stderrPath).split(path.sep).join("/"),
    stdoutTail, stderrTail };
  const benchmarkPath = path.join(caseDirectory, "benchmark.json");
  if (id === "lexical-scale" && result.exitCode === 0) {
    try { row.metrics = JSON.parse(await readFile(benchmarkPath, "utf8")); }
    catch (error) { row.metricsReadError = `${error.name}: ${error.message}`; }
  }
  if (id === "large-transfer" && result.exitCode === 0) {
    const line = stdoutTail.split(/\r?\n/).map((value) => value.replace(/^#\s*/, "").trim())
      .find((value) => value.startsWith('{"scale":"25000"'));
    if (line) {
      try { row.metrics = JSON.parse(line); }
      catch (error) { row.metricsReadError = `${error.name}: ${error.message}`; }
    }
  }
  return row;
}

export async function runNightlyStress({ rootDir = DEFAULT_ROOT, durationMs = DEFAULT_DURATION_MS,
  now = () => new Date(), progress = (message) => process.stdout.write(message + "\n") } = {}) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1) throw new RangeError("durationMs must be a positive safe integer.");
  const runId = `run-${now().toISOString().replaceAll(":", "-")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runDirectory = path.join(rootDir, "tests", "artifacts", "vocabulary-stress", "runs", runId);
  await mkdir(runDirectory, { recursive: true });
  const sourceBefore = summarizeFingerprint(await captureSourceFingerprint(rootDir));
  const pdfBefore = await listPdfFixtureHashes(rootDir);
  const started = performance.now();
  const startedAt = now().toISOString();
  const report = {
    schemaVersion: 1,
    runId,
    gate: "vocabulary-nightly-stress",
    startedAt,
    requestedDurationMs: durationMs,
    requiredDefaultDurationMs: DEFAULT_DURATION_MS,
    platform: `${process.platform}/${process.arch} Node DataAdapter and Chromium simulation`,
    realDeviceAcceptance: "not-tested-by-this-runner",
    matrix: NIGHTLY_MATRIX.map(({ id, command, args, covers }) => ({ id, command, args, covers })),
    sourceFingerprintBefore: sourceBefore,
    pdfFixtureSha256Before: pdfBefore,
    rounds: [],
    stopReason: null,
    acceptanceEligible: false,
  };
  await writeReport(runDirectory, report);

  let roundNumber = 0;
  let stop = false;
  while (!stop && performance.now() - started < durationMs) {
    roundNumber += 1;
    const roundStarted = performance.now();
    const roundDirectory = path.join(runDirectory, `round-${String(roundNumber).padStart(2, "0")}`);
    await mkdir(roundDirectory, { recursive: true });
    const round = { number: roundNumber, startedAt: now().toISOString(), cases: [], passed: false };
    report.rounds.push(round);
    progress(`Vocabulary stress ${runId}: round ${roundNumber} started.`);
    for (const item of NIGHTLY_MATRIX) {
      const args = item.id === "lexical-scale"
        ? [...item.args, `--out=${path.join(roundDirectory, item.id, "benchmark.json")}`]
        : item.args;
      const result = await runChild({ rootDir, workingDirectory: rootDir, roundDirectory,
        id: item.id, command: item.command, args });
      round.cases.push(result);
      await writeReport(runDirectory, report);
      if (result.spawnError || result.exitCode !== 0) {
        round.failedCase = item.id;
        round.failure = result.spawnError || `exit ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`;
        report.stopReason = `failed-case:${roundNumber}:${item.id}`;
        stop = true;
        break;
      }
    }
    round.passed = !round.failedCase && round.cases.length === NIGHTLY_MATRIX.length;
    round.durationMs = Math.round(performance.now() - roundStarted);
    round.finishedAt = now().toISOString();
    const liveFingerprint = summarizeFingerprint(await captureSourceFingerprint(rootDir));
    if (liveFingerprint.hash !== sourceBefore.hash) {
      report.stopReason = `source-changed-after-round-${roundNumber}`;
      report.sourceFingerprintChanged = liveFingerprint;
      stop = true;
    }
    await writeReport(runDirectory, report);
    progress(`Vocabulary stress ${runId}: round ${roundNumber} ${round.passed ? "passed" : "failed"}.`);
  }

  const ended = performance.now();
  const sourceAfter = summarizeFingerprint(await captureSourceFingerprint(rootDir));
  const pdfAfter = await listPdfFixtureHashes(rootDir);
  report.finishedAt = now().toISOString();
  report.elapsedMs = Math.round(ended - started);
  report.sourceFingerprintAfter = sourceAfter;
  report.sourceStable = sourceBefore.hash === sourceAfter.hash;
  report.pdfFixturesStable = JSON.stringify(pdfBefore) === JSON.stringify(pdfAfter);
  report.pdfFixtureSha256After = pdfAfter;
  if (!report.stopReason && report.elapsedMs >= durationMs) report.stopReason = "duration-reached";
  report.acceptanceEligible = durationMs >= DEFAULT_DURATION_MS && report.elapsedMs >= durationMs &&
    report.rounds.length > 0 && report.rounds.every((round) => round.passed) &&
    report.sourceStable && report.pdfFixturesStable;
  report.status = report.acceptanceEligible ? "passed" : "incomplete-or-failed";
  report.reportPath = path.relative(rootDir, path.join(runDirectory, "report.json")).split(path.sep).join("/");
  const output = await writeReport(runDirectory, report);
  progress(`Vocabulary stress ${runId}: ${report.status}; ${report.rounds.length} rounds; ${report.elapsedMs} ms; report ${output}`);
  return report;
}

function usage() {
  return "Usage: node scripts/test-vocabulary-nightly.mjs [--duration-ms=N]\n" +
    `Default duration: ${DEFAULT_DURATION_MS} ms (30 minutes). Short runs are diagnostic only.`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseNightlyOptions(process.argv.slice(2));
    if (options.help) process.stdout.write(usage() + "\n");
    else {
      const report = await runNightlyStress({ durationMs: options.durationMs });
      if (!report.acceptanceEligible) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n${usage()}\n`);
    process.exitCode = 1;
  }
}
