#!/usr/bin/env node
// Write the full five-fresh-profile-by-five-process run order before any cold run.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDirectory = path.resolve(process.argv[2] || path.join(root, "tests/output/sqlite-opfs"));
const options = ["opfs", "opfs-sahpool"];
const repeats = 5;
const runs = options.flatMap((option, optionIndex) => Array.from({ length: repeats }, (_, index) => ({
  sequence: optionIndex * repeats + index + 1,
  option,
  repetition: index + 1,
  status: "NOT_RUN",
})));
const runSetId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
const plan = {
  protocol: "sqlite-wasm-opfs-isolated-chromium-benchmark-v1",
  runSetId,
  createdAt: new Date().toISOString(),
  status: "PREDECLARED; no cold trials have started",
  repetitionsPerOption: repeats,
  options,
  runs,
  executionRequirements: [
    "Each run uses a fresh ordinary Chromium process and persistent user-data directory; no off-record/incognito profile.",
    "Run only after root grants the dedicated benchmark lease; the local harness never targets Obsidian or a Vault.",
    "Keep all attempted failures and timeouts in sequence; do not retry, skip, extend deadlines, or select passes.",
    "Use the same prebuilt read-only ECDICT database and pinned SQLite WASM release for both VFS options.",
    "No runtime INSERT or construction of the 770,611 resource rows; transfer the prebuilt SQLite bytes into OPFS.",
    "The opfs-sahpool second-window/worker outcome is recorded as a capability limitation if it cannot open concurrently.",
    "Do not change Obsidian scheme, response headers, security settings, or any production Vault contents.",
  ],
  measuredPhases: [
    "SQLite JS/WASM load and initialization, OPFS VFS install, main-thread long tasks, optional memory snapshot.",
    "Prebuilt DB fetch/copy duration and bytes, SHA-256 duration/result, OPFS import duration and bytes, storage estimate delta.",
    "Database open, first exact-key query, 20 warm exact-key queries (individual latency and p50/p95/max), and missing-key query.",
    "Close, reopen, reopened first query, and a second-window/worker concurrency attempt while the first handle remains open.",
    "Corrupt only a disposable DB header, record importer/open/integrity detection, rebuild from the intact prebuilt DB, and verify count/sample rows.",
    "Profile directory total bytes and OPFS storage usage before/after, plus runtime/bundle bytes; report API-unavailable values as null.",
  ],
  fixture: {
    entryCount: 770611,
    compressedResourceSha256: "b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126",
    logicalNormalizedSha256: "c89eea8a579da1ea743eea9febbe7ecaed63695056d093f2c478b93a265fbd98",
    databaseBytes: 48779264,
    databaseSha256: "f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c",
    fixtureLayout: "WITHOUT ROWID; key PRIMARY KEY, translation, phonetic; no duplicate row_json or ordinal",
  },
};
await mkdir(outputDirectory, { recursive: true });
const output = path.join(outputDirectory, `${runSetId}-run-plan.json`);
await writeFile(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, runSetId, plannedRuns: runs.length, status: plan.status }, null, 2));
