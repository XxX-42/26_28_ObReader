#!/usr/bin/env node
// Runnable isolated Chromium benchmark. It creates ten fresh ordinary browser
// profiles/processes (five per VFS) only when --run is explicitly supplied.
// This does not access Obsidian or any Vault.
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const artifactRoot = path.join(root, "tests/artifacts/sqlite-opfs-2026-10-23");
const runtimeRoot = path.join(artifactRoot, "runtime/sqlite-wasm-3540100/jswasm");
const databasePath = path.join(artifactRoot, "ecdict-v2-lean.sqlite");
const fixturePath = path.join(artifactRoot, "fixture-report-lean.json");
const expectedDatabaseSha256 = "f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c";
const expectedDatabaseBytes = 48779264;
const fixtureEntryCount = 770611;
const optionNames = ["opfs", "opfs-sahpool"];
const repetitionsPerOption = 5;

function parseArgs(argv) {
  const result = { run: false, output: path.join(root, "tests/output/sqlite-opfs"), chrome: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--run") result.run = true;
    else if (arg === "--output") result.output = path.resolve(argv[++index]);
    else if (arg === "--chrome") result.chrome = path.resolve(argv[++index]);
    else if (arg === "--help") {
      console.log("Usage: node scripts/sqlite-opfs/run-cold-benchmark.mjs [--output DIR] [--chrome EXECUTABLE] [--run]\n\nWithout --run this writes a predeclared ten-trial plan only. --run launches five fresh ordinary Chromium profiles/processes per VFS option; it never targets Obsidian or a Vault.");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function findChrome(explicit) {
  for (const candidate of [explicit, process.env.SQLITE_OPFS_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    try { if ((await stat(candidate)).isFile()) return candidate; } catch {}
  }
  return null;
}

async function sha256File(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function directoryBytes(directory) {
  const stack = [directory];
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (entry.isFile()) {
        try { bytes += (await stat(entryPath)).size; } catch {}
      }
    }
  }
  return bytes;
}

function responseHeaders(response, isolated) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (isolated) {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  }
}

async function startServer(variant) {
  const isolated = variant === "opfs";
  const counters = { runtimeBytes: 0, databaseBytes: 0, requests: [] };
  const server = createServer(async (request, response) => {
    responseHeaders(response, isolated);
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    let filename;
    if (pathname === "/" || pathname === "/index.html") filename = path.join(scriptRoot, "bench-page.html");
    else if (pathname === "/bench-main.js") filename = path.join(scriptRoot, "bench-main.js");
    else if (pathname === "/bench-worker.js") filename = path.join(scriptRoot, "bench-worker.js");
    else if (pathname === "/ecdict-v2.sqlite") filename = databasePath;
    else if (pathname === "/fixture-report.json") filename = fixturePath;
    else if (pathname.startsWith("/runtime/")) {
      const relative = pathname.slice("/runtime/".length);
      filename = path.resolve(runtimeRoot, relative);
      if (!filename.startsWith(`${runtimeRoot}${path.sep}`)) {
        response.writeHead(400).end("Bad path");
        return;
      }
    } else {
      response.writeHead(404).end("Not found");
      return;
    }

    try {
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("Not a file");
      const contentType = filename.endsWith(".js") ? "text/javascript; charset=utf-8"
        : filename.endsWith(".wasm") ? "application/wasm"
        : filename.endsWith(".json") ? "application/json; charset=utf-8"
        : filename.endsWith(".sqlite") ? "application/vnd.sqlite3"
        : "text/html; charset=utf-8";
      response.setHeader("Content-Type", contentType);
      response.setHeader("Content-Length", info.size);
      if (pathname.startsWith("/runtime/")) counters.runtimeBytes += info.size;
      if (pathname === "/ecdict-v2.sqlite") counters.databaseBytes += info.size;
      counters.requests.push({ pathname, bytes: info.size });
      createReadStream(filename).pipe(response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error?.message || error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    counters,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function writePlan(planPath, plan) {
  const tempPath = `${planPath}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(plan, null, 2)}\n`);
  await (await import("node:fs/promises")).rename(tempPath, planPath);
}

const options = parseArgs(process.argv.slice(2));
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.equal(fixture.databaseBytes, expectedDatabaseBytes, "lean prebuilt DB byte count");
assert.equal(fixture.databaseSha256, expectedDatabaseSha256, "prebuilt DB expected SHA-256");
assert.equal(fixture.entryCount, fixtureEntryCount, "prebuilt DB row count");
const databaseInfo = await stat(databasePath);
assert.equal(databaseInfo.size, fixture.databaseBytes, "prebuilt DB file byte count");
const chrome = options.run ? await findChrome(options.chrome) : null;
if (options.run && !chrome) throw new Error("No ordinary Chromium executable found. Pass --chrome /path/to/Google-Chrome or set SQLITE_OPFS_CHROME.");
if (options.run) {
  const actualDatabaseSha256 = await sha256File(databasePath);
  assert.equal(actualDatabaseSha256, expectedDatabaseSha256, "prebuilt DB file SHA-256");
}

await mkdir(options.output, { recursive: true });
const runSetId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
const planPath = path.join(options.output, `${runSetId}-run-plan.json`);
const logPath = path.join(options.output, `${runSetId}-runs.jsonl`);
const runs = optionNames.flatMap((option, optionIndex) => Array.from({ length: repetitionsPerOption }, (_, index) => ({
  sequence: optionIndex * repetitionsPerOption + index + 1,
  option,
  repetition: index + 1,
  status: "NOT_RUN",
})));
const plan = {
  protocol: "sqlite-wasm-opfs-isolated-chromium-benchmark-v1",
  runSetId,
  createdAt: new Date().toISOString(),
  executionMode: options.run ? "RUN_REQUESTED" : "PREDECLARE_ONLY",
  status: options.run ? "RUNNING" : "PREDECLARED; no cold trials have started",
    host: "local headed Chromium with a normal persistent profile on 127.0.0.1; NOT an Obsidian app:// result",
  chromeExecutable: chrome,
  repetitionsPerOption,
  options: optionNames,
  runs,
  fixture: {
    entryCount: fixtureEntryCount,
    databaseBytes: fixture.databaseBytes,
    databaseSha256: expectedDatabaseSha256,
    sourceCompressedSha256: fixture.resourceSha256,
    logicalNormalizedSha256: fixture.logicalNormalizedSha256,
  },
  isolation: {
    opfs: "Local-only COOP same-origin and COEP require-corp response headers for standard OPFS prerequisites.",
    opfsSahpool: "No cross-origin-isolation headers; isolated local Chromium only.",
    vaultWrites: false,
    runtime770kInserts: false,
    incognito: false,
  },
  metrics: [
    "fresh browser process/profile per trial; runtime initialization and runtime bytes",
    "prebuilt database fetch, SHA-256, OPFS import bytes/time, open, integrity, count, five exact rows, and absent-key behavior",
    "first exact-key query, 20 warm query latencies with p50/p95/max, close/reopen and first reopened query",
    "second browser window/worker read-only concurrent open while primary DB remains open",
    "corrupt disposable DB header detection, intact prebuilt rebuild, integrity/count/sample verification, and cleanup",
    "OPFS usage delta, browser profile bytes after close, optional JS heap, and main-thread Long Tasks",
  ],
  interpretation: "A local-Chromium result is an isolated harness result, never evidence that the Obsidian app:// origin supports a VFS. No production recommendation follows from this experiment.",
  outcomesPath: logPath,
};
await writePlan(planPath, plan);
console.log(JSON.stringify({ runSetId, planPath, logPath, status: plan.status, chromeExecutable: chrome }, null, 2));
if (!options.run) process.exit(0);

const profileRoot = path.join(options.output, `${runSetId}-profiles`);
await mkdir(profileRoot, { recursive: true });

for (const row of runs) {
  const variant = row.option;
  const trialId = `${variant}-${String(row.repetition).padStart(2, "0")}-${randomUUID()}`;
  const profilePath = path.join(profileRoot, trialId);
  const host = await startServer(variant);
  let browser;
  let primaryPage;
  let secondaryPage;
  let browserCdp;
  let result;
  const trialStartedAt = new Date().toISOString();
  try {
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: false,
      userDataDir: profilePath,
      defaultViewport: { width: 1280, height: 900 },
      args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking"],
    });
    const browserVersion = await browser.version();
    primaryPage = await browser.newPage();
    primaryPage.on("pageerror", error => {
      (result ||= {}).pageErrors ||= [];
      result.pageErrors.push(`${error.name || "Error"}: ${error.message || String(error)}`);
    });
    const trialUrl = `${host.origin}/?variant=${encodeURIComponent(variant)}&runId=${encodeURIComponent(trialId)}`;
    await primaryPage.goto(trialUrl, { waitUntil: "load", timeout: 30_000 });
    await primaryPage.waitForFunction(() => window.__benchState?.phase === "primary-open" || window.__benchState?.phase === "done", { timeout: 180_000 });
    let secondaryConnection = { status: "NOT_RUN" };
    const phase = await primaryPage.evaluate(() => window.__benchState?.phase);
    if (phase === "primary-open") {
      try {
        const secondaryUrl = `${trialUrl}&mode=secondary`;
        browserCdp = await browser.target().createCDPSession();
        await browserCdp.send("Target.createTarget", { url: secondaryUrl, newWindow: true });
        const secondaryTarget = await browser.waitForTarget(target => target.type() === "page" && target.url() === secondaryUrl);
        secondaryPage = await secondaryTarget.page();
        if (!secondaryPage) throw new Error("Chrome created the second target but Puppeteer could not attach a page.");
        await secondaryPage.waitForFunction(() => window.__secondaryReady === true, { timeout: 30_000 });
        secondaryConnection = await secondaryPage.evaluate(() => window.__openSecondary());
      } catch (error) {
        secondaryConnection = { status: "FAIL", error: `${error.name || "Error"}: ${error.message || String(error)}` };
      } finally {
        await primaryPage.evaluate(value => {
          window.__secondaryResult = value;
          window.__resumeAfterSecondary?.();
        }, secondaryConnection).catch(() => {});
        await secondaryPage?.close().catch(() => {});
        secondaryPage = undefined;
      }
    }
    await primaryPage.waitForFunction(() => window.__benchState?.phase === "done", { timeout: 600_000 });
    result = await primaryPage.evaluate(() => window.__benchmarkResult || null);
    if (!result) throw new Error("Benchmark page reached done without producing a result.");
    result.secondaryConnection = secondaryConnection;
    result.browserVersion = browserVersion;
    result.profilePath = profilePath;
    result.profileBytes = null;
  } catch (error) {
    result = {
      ...(result || {}),
      status: "FAIL",
      variant,
      runId: trialId,
      error: `${error.name || "Error"}: ${error.message || String(error)}`,
      stack: error.stack || null,
      profilePath,
    };
  } finally {
    await secondaryPage?.close().catch(() => {});
    await browserCdp?.detach().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    result ||= { status: "FAIL", variant, runId: trialId, error: "No result produced." };
    result.profileBytes = await directoryBytes(profilePath);
    result.runtimeResourceBytes = host.counters.runtimeBytes;
    await host.close();
  }

  const trialRecord = {
    sequence: row.sequence,
    option: variant,
    repetition: row.repetition,
    status: result.status,
    trialStartedAt,
    trialFinishedAt: new Date().toISOString(),
    serverCounters: host.counters,
    result,
  };
  row.status = result.status;
  row.profilePath = profilePath;
  row.error = result.error || null;
  row.output = trialRecord;
  await appendFile(logPath, `${JSON.stringify(trialRecord)}\n`);
  await writePlan(planPath, plan);
  console.log(JSON.stringify({ sequence: row.sequence, option: variant, repetition: row.repetition,
    status: result.status, profileBytes: result.profileBytes, error: result.error || null }, null, 2));
}

plan.status = runs.every(run => run.status === "PASS") ? "COMPLETE" : "COMPLETE_WITH_FAILURES";
plan.completedAt = new Date().toISOString();
await writePlan(planPath, plan);
console.log(JSON.stringify({ status: plan.status, planPath, logPath, runs: runs.map(({ sequence, option, repetition, status, error }) => ({ sequence, option, repetition, status, error })) }, null, 2));
