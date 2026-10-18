import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import {
  BROWSER_SCRIPT_MANIFEST,
  GATE_MANIFEST,
  RACE_TESTS,
  captureSourceFingerprint,
  casesForGate,
  diffSourceFingerprints,
  runCases,
  runRaceRounds,
  summarizeGates,
  validateManifest,
} from "../scripts/test-vocabulary-gates.mjs";

function fakeSpawn({ delayMs = 5, failureFor = () => false, outputFor = null, counters = null } = {}) {
  return (_command, _args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const testFile = options.env.VOCABULARY_GATE_TEST;
    const round = Number(options.env.VOCABULARY_GATE_ROUND);
    const fail = failureFor({ testFile, round, options });
    if (counters) {
      counters.started += 1;
      counters.active += 1;
      counters.maxActive = Math.max(counters.maxActive, counters.active);
      counters.environments.push(options.env);
    }
    setTimeout(() => {
      const stdout = outputFor
        ? outputFor({ testFile, round, options, fail })
        : fail
        ? "TAP version 13\n1..1\nnot ok 1 - fake failure\n"
        : "TAP version 13\n1..1\nok 1 - fake success\n";
      child.stdout.end(stdout);
      child.stderr.end(fail ? "raw stderr for planned failure\n" : "raw stderr for success\n");
      if (counters) counters.active -= 1;
      child.emit("close", fail ? 17 : 0, null);
    }, delayMs);
    return child;
  };
}

async function temporaryRoot() {
  return mkdtemp(path.join(os.tmpdir(), "vocabulary-gate-runner-test-"));
}

test("gate manifest explicitly classifies every test file once", async () => {
  const check = await validateManifest();
  assert.equal(check.ok, true, JSON.stringify({ duplicates: check.duplicates, missing: check.missing, stale: check.stale }, null, 2));
  assert.deepEqual(BROWSER_SCRIPT_MANIFEST, ["tests/offline-smoke.mjs"]);
  assert.deepEqual(check.missingBrowserScripts, []);
  assert.deepEqual(check.duplicateBrowserScripts, []);
  assert.ok(GATE_MANIFEST.fast.includes("tests/test-gate-runner.test.mjs"));
  assert.deepEqual(RACE_TESTS, [
    "tests/autosave-mobile-regression.test.mjs",
    "tests/highlight-multiline-regression.test.mjs",
    "tests/plugin-host.test.mjs",
    "tests/vocabulary-transactions.test.mjs",
    "tests/vocabulary-review-transaction-integration.test.mjs",
    "tests/vocabulary-v2-runtime.test.mjs",
  ]);
});

test("browser gate runs its supplemental smoke script directly and retains raw exit output", async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const browserCases = casesForGate("browser");
  assert.deepEqual(browserCases.at(-1), {
    file: "tests/offline-smoke.mjs",
    execution: "script",
  });
  let invocation;
  const scriptOutput = "offline smoke started\noffline smoke passed\n";
  const [result] = await runCases([
    { file: "tests/fake-browser-script.mjs", execution: "script" },
  ], {
    rootDir: root,
    runId: "script-check",
    artifactsRoot: path.join(root, "artifacts"),
    parallelism: 1,
    gate: "browser",
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return fakeSpawn({ outputFor: () => scriptOutput })(command, args, options);
    },
  });
  assert.deepEqual(invocation.args, [path.resolve(root, "tests/fake-browser-script.mjs")]);
  assert.equal(result.execution, "script");
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "passed");
  assert.equal(await readFile(result.stdoutPath, "utf8"), scriptOutput);
  assert.equal(await readFile(result.stderrPath, "utf8"), "raw stderr for success\n");
});

test("sidecar harness can hold identity confirmation until the fixture releases it", () => {
  const outbound = [];
  let onMessage;
  const frame = { contentWindow: { postMessage: (...args) => outbound.push(args) } };
  const window = {
    addEventListener(type, listener) {
      assert.equal(type, "message");
      onMessage = listener;
    },
  };
  runInNewContext(browserSidecarHarnessScript({
    channel:"test-channel",
    token:"test-token",
    holdIdentityResponses:true,
  }).replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, ""), {
    window,
    document:{ querySelector:() => frame },
    Date,
    Map,
    structuredClone,
  });
  onMessage({
    source:frame.contentWindow,
    data:{
      channel:"test-channel",
      token:"test-token",
      type:"annotation-source-identity",
      documentId:"held-identity-document",
      openRequest:1,
      sourceHash:"sha256:test",
      pageCount:1,
      orderedPageIdentities:["ref:page-1"],
      identityStatus:"KNOWN",
    },
  });
  assert.equal(outbound.length, 0, "Held identity must not be posted before release");
  assert.equal(window.__browserSidecarHost.heldIdentityResponses.length, 1);
  assert.equal(window.__browserSidecarHost.identityConfirmations.length, 0);
  assert.equal(window.__browserSidecarHost.releaseIdentityResponses(), 1);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0][0].type, "external-annotations-update");
  assert.equal(outbound[0][0].identityConfirmed, true);
  assert.equal(window.__browserSidecarHost.identityConfirmations.length, 1);
});

test("source fingerprint detects tracked and untracked code changes but ignores generated evidence", async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive:true, force:true }));
  await mkdir(path.join(root, "docs"), { recursive:true });
  await mkdir(path.join(root, "dist"), { recursive:true });
  await mkdir(path.join(root, "tests", "artifacts"), { recursive:true });
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive:true });
  await mkdir(path.join(root, "viewer-adapter"), { recursive:true });
  await writeFile(path.join(root, ".gitignore"), "dist/\ntests/artifacts/\nnode_modules/\n");
  await writeFile(path.join(root, "package.json"), "{\"name\":\"fingerprint-test\"}\n");
  await writeFile(path.join(root, "viewer-adapter", "bridge.js"), "export const state = 'before';\n");
  await writeFile(path.join(root, "docs", "readme.md"), "docs before\n");
  await writeFile(path.join(root, "dist", "generated.js"), "generated before\n");
  await writeFile(path.join(root, "tests", "artifacts", "evidence.json"), "{}\n");
  await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "generated dependency\n");
  execFileSync("git", ["init", "--quiet"], { cwd:root });
  execFileSync("git", ["add", "--", ".gitignore", "package.json", "viewer-adapter/bridge.js", "docs/readme.md"], { cwd:root });
  execFileSync("git", ["add", "-f", "--", "dist/generated.js", "tests/artifacts/evidence.json", "node_modules/pkg/index.js"], { cwd:root });

  const before = await captureSourceFingerprint(root);
  assert.deepEqual(Object.keys(before.files), [".gitignore", "package.json", "viewer-adapter/bridge.js"]);
  await writeFile(path.join(root, "viewer-adapter", "bridge.js"), "export const state = 'after';\n");
  await writeFile(path.join(root, "tests", "new-helper.mjs"), "export const testOnly = true;\n");
  await writeFile(path.join(root, "docs", "readme.md"), "docs after\n");
  await writeFile(path.join(root, "dist", "generated.js"), "generated after\n");
  await writeFile(path.join(root, "tests", "artifacts", "evidence.json"), "{\"new\":true}\n");
  const after = await captureSourceFingerprint(root);
  const diff = diffSourceFingerprints(before, after);
  assert.equal(diff.stable, false);
  assert.deepEqual(diff.changedFiles, ["tests/new-helper.mjs", "viewer-adapter/bridge.js"]);
  const sameSource = await captureSourceFingerprint(root);
  assert.deepEqual(diffSourceFingerprints(after, sameSource), { stable:true, changedFiles:[] });
});

test("fast process pool never exceeds its cap and gives each child private directories", async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const counters = { started: 0, active: 0, maxActive: 0, environments: [] };
  const cases = Array.from({ length: 7 }, (_, index) => `tests/fake-${index}.test.mjs`);
  const results = await runCases(cases, {
    rootDir: root,
    runId: "pool-check",
    artifactsRoot: path.join(root, "artifacts"),
    parallelism: 3,
    gate: "fast",
    spawnImpl: fakeSpawn({ delayMs: 8, counters }),
  });
  assert.equal(counters.started, cases.length);
  assert.equal(counters.maxActive, 3);
  assert.equal(results.length, cases.length);
  assert.ok(results.every((result) => result.status === "passed"));
  assert.equal(new Set(counters.environments.map((env) => env.TMPDIR)).size, cases.length);
  assert.equal(new Set(results.map((result) => result.stdoutPath)).size, cases.length);
  assert.ok(counters.environments.every((env) => path.dirname(env.TMPDIR) === os.tmpdir()));
  assert.ok(counters.environments.every((env) => path.basename(env.TMPDIR).startsWith("pvr-gate-")));
  assert.equal(new Set(counters.environments.map((env) => env.VOCABULARY_GATE_ARTIFACTS_DIR)).size, cases.length);
  assert.ok(counters.environments.every((env) => path.basename(path.dirname(path.dirname(env.VOCABULARY_GATE_ARTIFACTS_DIR))) === "out"));
  if (process.platform === "win32") {
    assert.ok(counters.environments.every((env) => env.TMPDIR.length - os.tmpdir().length < 40));
    assert.ok(counters.environments.every((env) => env.VOCABULARY_GATE_ARTIFACTS_DIR.length < 180));
  }
  assert.ok(counters.environments.every((env) => env.VOCABULARY_GATE_PORT === "0"));
  await assert.rejects(() => runCases(cases, { rootDir: root, artifactsRoot: path.join(root, "cap-check"), parallelism: 5, gate: "fast", spawnImpl: fakeSpawn() }), /capped at 4/);
});

test("failed child status and unmodified raw output stay recorded without retry", async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const counters = { started: 0, active: 0, maxActive: 0, environments: [] };
  const [result] = await runCases(["tests/fake-failure.test.mjs"], {
    rootDir: root,
    runId: "failure-check",
    artifactsRoot: path.join(root, "artifacts"),
    parallelism: 1,
    gate: "fast",
    spawnImpl: fakeSpawn({ failureFor: () => true, counters }),
  });
  assert.equal(counters.started, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 17);
  assert.equal(await readFile(result.stdoutPath, "utf8"), "TAP version 13\n1..1\nnot ok 1 - fake failure\n");
  assert.equal(await readFile(result.stderrPath, "utf8"), "raw stderr for planned failure\n");
});

test("a skipped TAP case fails the gate even when the child exits zero", async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const [result] = await runCases(["tests/fake-skip.test.mjs"], {
    rootDir: root,
    runId: "skip-check",
    artifactsRoot: path.join(root, "artifacts"),
    parallelism: 1,
    gate: "fast",
    spawnImpl: fakeSpawn({ outputFor: () => "TAP version 13\n1..1\nok 1 - browser check # SKIP unavailable\n" }),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.skipCount, 1);
  assert.equal(result.status, "failed");
});

test("race gate retains the historical browser pair and every added data race for all 10 rounds", async (t) => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const counters = { started: 0, active: 0, maxActive: 0, environments: [] };
  const rounds = await runRaceRounds({
    rounds: 10,
    rootDir: root,
    runId: "race-check",
    artifactsRoot: path.join(root, "artifacts"),
    spawnImpl: fakeSpawn({
      delayMs: 4,
      counters,
      failureFor: ({ testFile, round }) => testFile === RACE_TESTS[0] && round === 1,
    }),
  });
  const total = RACE_TESTS.length * 10;
  assert.equal(counters.started, total);
  assert.equal(counters.maxActive, 2);
  assert.equal(rounds.length, 10);
  for (const round of rounds) assert.deepEqual(round.tests.map((item) => item.test), [...RACE_TESTS]);
  assert.equal(rounds[0].status, "failed");
  assert.ok(rounds.slice(1).every((round) => round.status === "passed"));
  assert.equal(rounds.flatMap((round) => round.tests).filter((result) => result.status === "failed").length, 1);
  const summary = summarizeGates({ race: rounds });
  assert.deepEqual(summary, {
    race: { total, passed: total - 1, failed: 1, skipped: 0 },
    total,
    passed: total - 1,
    failed: 1,
    skipped: 0,
  });
  const savedLogs = await readdir(path.dirname(rounds[0].tests[0].stdoutPath));
  assert.ok(savedLogs.includes("stdout.raw.log"));
  assert.ok(savedLogs.includes("stderr.raw.log"));
  await assert.rejects(() => runRaceRounds({ rounds: 9, rootDir: root, artifactsRoot: path.join(root, "unused"), spawnImpl: fakeSpawn() }), /at least 10 rounds/);
});
