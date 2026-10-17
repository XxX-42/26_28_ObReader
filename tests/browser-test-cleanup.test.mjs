import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { once } from "node:events";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { test } from "node:test";
import { launchTestBrowser, getTestBrowserLaunchMetadata } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  captureOwnedBrowserIdentity,
  cleanupBrowserTestResources,
  MAX_BROWSER_SAMPLE_OUTPUT_BYTES,
  observeBrowserTestChildStderr,
  processIdentityMatches,
  registerOwnedBrowserChild,
  readPosixProcessTable,
  sampleOwnedBrowserProcess,
} from "./browser-test-cleanup.mjs";

const execFileAsync = promisify(execFile);

async function launchControlledBrowserProcess({ ignoreTerm, profileDirectory }) {
  const source = ignoreTerm
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready\\n');"
    : "setInterval(() => {}, 1000); process.stdout.write('ready\\n');";
  const child = spawn(
    process.execPath,
    ["-e", source, "--", `--user-data-dir=${profileDirectory}`],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await once(child, "spawn");
  await once(child.stdout, "data");
  assert.equal(registerOwnedBrowserChild(child), true);
  return child;
}

async function launchReadyExitProcess(profileDirectory) {
  const source = [
    "process.on('message', message => {",
    "if (message?.type !== 'schedule-exit') return;",
    "setTimeout(() => process.exit(message.exitCode), message.delayMs);",
    "process.send({ type: 'exit-scheduled', delayMs: message.delayMs, exitCode: message.exitCode });",
    "});",
    "process.send({ type: 'ready' });",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const child = spawn(
    process.execPath,
    ["-e", source, "--", `--user-data-dir=${profileDirectory}`],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  await once(child, "spawn");
  const [ready] = await once(child, "message");
  assert.deepEqual(ready, { type: "ready" });
  assert.equal(registerOwnedBrowserChild(child), true);
  return child;
}

async function scheduleNaturalExit(child, { delayMs = 0, exitCode = 0 } = {}) {
  const scheduled = once(child, "message");
  child.send({ type: "schedule-exit", delayMs, exitCode });
  const [message] = await scheduled;
  assert.deepEqual(message, { type: "exit-scheduled", delayMs, exitCode });
}

async function launchDelayedReadyCloseProcess(profileDirectory, readyDelayMs) {
  const source = [
    "let ready = false;",
    "process.on('message', message => {",
    `if (message === 'release-ready') { setTimeout(() => { ready = true; process.send({ type: 'ready' }); }, ${readyDelayMs}); return; }`,
    "if (message === 'close' && !ready) { process.send({ type: 'close-dropped-before-ready' }); return; }",
    "if (message === 'close' && ready) process.exit(0);",
    "});",
    `process.send({ type: 'not-ready', injectedDelayMs: ${readyDelayMs} });`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const child = spawn(
    process.execPath,
    ["-e", source, "--", `--user-data-dir=${profileDirectory}`],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  await once(child, "spawn");
  const [state] = await once(child, "message");
  assert.deepEqual(state, { type: "not-ready", injectedDelayMs: readyDelayMs });
  assert.equal(registerOwnedBrowserChild(child), true);
  return child;
}

async function launchBrowserCloseControlledProcess(profileDirectory) {
  const source = [
    "process.stdout.write('ready\\n');",
    "process.on('message', (message) => { if (message === 'browser-close') process.exit(0); });",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const child = spawn(
    process.execPath,
    ["-e", source, "--", `--user-data-dir=${profileDirectory}`],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  await once(child, "spawn");
  await once(child.stdout, "data");
  assert.equal(registerOwnedBrowserChild(child), true);
  return child;
}

function browserFor(child) {
  let connected = true;
  return {
    process: () => child,
    isConnected: () => connected,
    close: () => new Promise(() => {}),
    disconnect: () => {
      connected = false;
    },
  };
}

test("a close command before delayed fixture readiness is deterministically dropped", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-delayed-ready-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-delayed-ready");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchDelayedReadyCloseProcess(profileDirectory, 80);
  const droppedMessage = once(child, "message");
  child.send("close");
  const [dropped] = await droppedMessage;
  assert.deepEqual(dropped, { type: "close-dropped-before-ready" });
  assert.equal(child.exitCode, null, "The pre-ready close request must not produce a natural exit");

  const readyMessage = once(child, "message");
  child.send("release-ready");
  const [ready] = await readyMessage;
  assert.deepEqual(ready, { type: "ready" });
  const exited = once(child, "exit");
  child.send("close");
  const [exitCode, signalCode] = await exited;
  assert.equal(exitCode, 0);
  assert.equal(signalCode, null);
});

test("browser cleanup reports a natural close separately from forced cleanup", async () => {
  const browser = {
    process: () => null,
    isConnected: () => false,
    close: async () => undefined,
  };
  const report = await cleanupBrowserTestResources({ browser });

  assert.equal(report.status, "normal");
  assert.equal(report.browser.status, "normal");
  assert.deepEqual(report.errors, []);
});

test("browser cleanup accepts verified zero-exit when Puppeteer close remains pending", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-natural-exit-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-natural-exit");
  await mkdir(profileDirectory);
  let child;
  let connected = true;
  const browser = new EventEmitter();
  browser.process = () => child;
  browser.isConnected = () => connected;
  browser.close = async () => {
    await scheduleNaturalExit(child, { delayMs: 50, exitCode: 0 });
    return new Promise(() => {});
  };
  browser.disconnect = () => {
    connected = false;
    browser.emit("disconnected");
  };
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchReadyExitProcess(profileDirectory);
  child.once("exit", () => {
    connected = false;
    browser.emit("disconnected");
  });
  const report = await cleanupBrowserTestResources({
    browser,
    ownedPages: [],
    browserTimeoutMs: 500,
    processExitTimeoutMs: 100,
  });

  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  assert.equal(report.browser.connectedAfterClose, false);
  assert.equal(report.browser.closeState, "process-exited");
  assert.equal(report.browser.closeCompletion, "verified-process-exit");
  assert.equal(report.browser.status, "normal", JSON.stringify(report));
  assert.equal(report.status, "normal", JSON.stringify(report));
  assert.deepEqual(report.errors, []);
});

test("browser cleanup accepts a verified natural exit within the existing process-exit grace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-delayed-exit-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-delayed-exit");
  await mkdir(profileDirectory);
  let child;
  let connected = true;
  const browser = new EventEmitter();
  browser.process = () => child;
  browser.isConnected = () => connected;
  browser.close = () => {
    connected = false;
    browser.emit("disconnected");
    child.send("close");
    return new Promise(() => {});
  };
  browser.disconnect = () => {
    connected = false;
    browser.emit("disconnected");
  };
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchReadyExitProcess(profileDirectory);
  browser.close = async () => {
    connected = false;
    browser.emit("disconnected");
    await scheduleNaturalExit(child, { delayMs: 80, exitCode: 0 });
    return new Promise(() => {});
  };
  const report = await cleanupBrowserTestResources({
    browser,
    ownedPages: [],
    browserTimeoutMs: 50,
    processExitTimeoutMs: 250,
  });

  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
  assert.equal(report.browser.connectedAfterClose, false);
  assert.equal(report.browser.closeState, "process-exited");
  assert.equal(report.browser.closeCompletion, "verified-process-exit");
  assert.equal(report.browser.status, "normal", JSON.stringify(report));
  assert.equal(report.status, "normal", JSON.stringify(report));
  assert.deepEqual(report.browser.termination, []);
  assert.deepEqual(report.errors, []);
});

test("browser cleanup attaches launch metadata and fails if terminal recording fails", async (t) => {
  const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-launch-record-test-"));
  let connected = true;
  const browser = {
    process: () => null,
    isConnected: () => connected,
    async close() { connected = false; },
    disconnect() { connected = false; },
  };
  t.after(async () => rm(artifactsDir, { recursive: true, force: true }));

  await launchTestBrowser({ launch: async () => browser }, {}, {
    testName: "cleanup-record-failure",
    artifactsDir,
  });
  const launchMetadata = getTestBrowserLaunchMetadata(browser);
  assert.ok(launchMetadata?.recordPath);
  await rm(launchMetadata.recordPath);
  await mkdir(launchMetadata.recordPath);

  const report = await cleanupBrowserTestResources({ browser });

  assert.equal(report.status, "failed");
  assert.equal(report.browser.status, "failed");
  assert.equal(report.browser.testBrowserLaunch.state, "record-write-failed");
  assert.ok(report.browser.testBrowserLaunch.recordErrors.length > 0);
  assert.ok(report.errors.some((entry) => entry.phase === "browser.launch-record"));
});

test("stderr observer retains only a bounded tail from the owned child stderr", () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  Object.assign(child, { stdout, stderr, exitCode: null, signalCode: null });
  const observer = observeBrowserTestChildStderr(child, { maxBytes: 10_000 });

  stderr.write("a".repeat(5_000));
  stdout.write("stdout marker");
  stderr.write("tail-marker");
  const snapshot = observer.snapshot();
  assert.equal(snapshot.limitBytes, 4_096);
  assert.equal(snapshot.capturedBytes, 4_096);
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.tail.endsWith("tail-marker"));
  assert.equal(snapshot.tail.includes("stdout marker"), false);
  assert.ok(snapshot.firstByteAt > 0);
  assert.ok(snapshot.lastByteAt >= snapshot.firstByteAt);
  child.exitCode = 0;
  child.emit("exit", 0, null);
  assert.ok(observer.snapshot().childExitAt > 0);
  observer.dispose();
  stderr.write("after-dispose");
  assert.equal(observer.snapshot().tail, snapshot.tail);
  stdout.destroy();
  stderr.destroy();
});

test("stderr observer timestamps the Chromium teardown watchdog marker", () => {
  const stderr = new PassThrough();
  const child = new EventEmitter();
  Object.assign(child, { stderr, exitCode: null, signalCode: null });
  const observer = observeBrowserTestChildStderr(child);
  stderr.write("prefix Teardown watchdog expired; recording dump and terminating. suffix");
  const snapshot = observer.snapshot();
  assert.ok(snapshot.teardownWatchdogAt > 0);
  assert.match(snapshot.tail, /Teardown watchdog expired; recording dump and terminating\./);
  observer.dispose();
  stderr.destroy();
});

test("failed owned-child exit report includes early bounded stderr and excludes stdout", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-stderr-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-stderr");
  await mkdir(profileDirectory);
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.stderr.write('A'.repeat(5000)); process.stderr.write('shutdown-marker\\n'); process.stdout.write('stdout-marker\\n'); setTimeout(() => process.exit(2), 100);",
      "--",
      `--user-data-dir=${profileDirectory}`,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const browserObserver = observeBrowserTestChildStderr(child);
  t.after(async () => {
    browserObserver.dispose();
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });
  await once(child, "spawn");
  await once(child.stdout, "data");
  assert.equal(registerOwnedBrowserChild(child), true);

  const browser = new EventEmitter();
  browser.connected = true;
  browser.process = () => child;
  browser.isConnected = () => browser.connected;
  browser.close = () => once(child, "close");
  browser.disconnect = () => {
    browser.connected = false;
    browser.emit("disconnected");
  };
  child.once("exit", () => {
    browser.connected = false;
    browser.emit("disconnected");
  });

  const report = await cleanupBrowserTestResources({ browser, browserObserver });

  assert.equal(report.status, "failed");
  assert.equal(report.browser.process.exitCode, 2);
  assert.equal(report.browser.process.signalCode, null);
  assert.equal(report.browser.stderr.limitBytes, 4_096);
  assert.equal(report.browser.stderr.capturedBytes, 4_096);
  assert.equal(report.browser.stderr.truncated, true);
  assert.ok(report.browser.stderr.tail.endsWith("shutdown-marker\n"));
  assert.equal(report.browser.stderr.tail.includes("stdout-marker"), false);
  assert.ok(report.errors.some((entry) => entry.phase === "browser.process.exit"));
});

test("owned pages close before browser.close within one shared deadline", async () => {
  const events = [];
  let connected = true;
  let hookCalledAt = null;
  const page = {
    isClosed: () => false,
    url: () => "http://127.0.0.1:8123/fixture.pdf?private=removed#fragment",
    async close() {
      events.push("page.close:start");
      await new Promise((resolve) => setTimeout(resolve, 220));
      events.push("page.close:done");
    },
  };
  const browser = {
    process: () => null,
    isConnected: () => connected,
    pages: async () => {
      events.push("pages");
      return [page];
    },
    async close() {
      assert.ok(hookCalledAt, "diagnostic callback should run before Puppeteer browser.close");
      events.push("browser.close:start");
      return new Promise(() => {});
    },
    disconnect() {
      connected = false;
      events.push("browser.disconnect");
    },
  };
  const startedAt = Date.now();
  const report = await cleanupBrowserTestResources({
    browser,
    browserTimeoutMs: 300,
    onBrowserCloseStart: ({ startedAt }) => { hookCalledAt = startedAt; },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(events.slice(0, 3), ["pages", "page.close:start", "page.close:done"]);
  assert.ok(events.indexOf("browser.close:start") > events.indexOf("page.close:done"));
  assert.equal(report.browser.pageClose.state, "fulfilled");
  assert.equal(report.browser.pageClose.attempted, 1);
  assert.equal(report.browser.pageClose.closed, 1);
  assert.equal(report.browser.pageClose.pages[0].target, "http://127.0.0.1:8123/fixture.pdf");
  assert.ok(report.browser.pageClose.pages[0].startedAt > 0);
  assert.ok(report.browser.pageClose.pages[0].settledAt >= report.browser.pageClose.pages[0].startedAt);
  assert.ok(report.browser.timings.browserCloseCalledAt >= report.browser.pageClose.pages[0].settledAt);
  assert.ok(report.browser.timings.browserCloseSettledAt === null || report.browser.timings.browserCloseSettledAt >= report.browser.timings.browserCloseCalledAt);
  assert.equal(report.browser.timings.browserCloseCalledAt, hookCalledAt);
  assert.equal(report.browser.closeState, "timeout");
  assert.ok(elapsedMs < 450, `page and browser close should share the 300 ms deadline (observed ${elapsedMs} ms)`);
  assert.ok(report.errors.some((entry) => entry.phase === "browser.close"));
});

test("page-close rejection is reported once and does not skip browser.close", async () => {
  const events = [];
  let connected = true;
  const browser = {
    process: () => null,
    isConnected: () => connected,
    pages: async () => [
      {
        isClosed: () => false,
        close: async () => {
          events.push("page.close");
          throw new Error("page target rejected close");
        },
      },
    ],
    async close() {
      events.push("browser.close");
      connected = false;
    },
    disconnect() {
      connected = false;
    },
  };

  const report = await cleanupBrowserTestResources({ browser, browserTimeoutMs: 500 });

  assert.deepEqual(events, ["page.close", "browser.close"]);
  assert.equal(report.status, "failed");
  assert.equal(report.browser.pageClose.state, "failed");
  assert.equal(report.browser.pageClose.attempted, 1);
  assert.equal(report.browser.pageClose.pages[0].state, "rejected");
  assert.equal(report.browser.closeState, "fulfilled");
  assert.equal(report.errors.filter((entry) => entry.phase === "browser.page.close").length, 1);
  const functionalError = new Error("page behavior assertion failed");
  const combinedError = attachCleanupErrors(functionalError, report);
  assert.equal(combinedError, functionalError);
  assert.ok(combinedError.cleanupErrors.some((entry) => entry.phase === "browser.page.close"));
});

test("owned page pre-close preparation runs before close on the existing deadline", async () => {
  const events = [];
  let connected = true;
  const page = {
    isClosed: () => false,
    async close() {
      events.push("page.close");
    },
  };
  const browser = {
    process: () => null,
    isConnected: () => connected,
    async close() {
      events.push("browser.close");
      connected = false;
    },
    disconnect() { connected = false; },
  };
  let callbackPage;
  let callbackBudgetMs;
  const report = await cleanupBrowserTestResources({
    browser,
    ownedPages: [page],
    browserTimeoutMs: 500,
    prepareOwnedPageClose: async (ownedPage, remainingMs) => {
      events.push("prepare");
      callbackPage = ownedPage;
      callbackBudgetMs = remainingMs;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { state: "fulfilled", phase: "fixture-pdf-close" };
    },
  });

  assert.equal(callbackPage, page);
  assert.ok(callbackBudgetMs > 0 && callbackBudgetMs <= 500);
  assert.deepEqual(events, ["prepare", "page.close", "browser.close"]);
  assert.equal(report.browser.pageClose.pages[0].preparation.state, "fulfilled");
  assert.equal(report.browser.pageClose.pages[0].preparation.result.phase, "fixture-pdf-close");
  assert.ok(report.browser.pageClose.pages[0].preparation.remainingMsAtStart <= 500);
  assert.ok(report.browser.pageClose.pages[0].preparation.settledAt <= report.browser.pageClose.pages[0].startedAt);
  assert.equal(report.browser.pageClose.state, "fulfilled");
  assert.equal(report.status, "normal", JSON.stringify(report));
});

test("owned page pre-close preparation failures are recorded and do not skip page or browser close", async () => {
  const events = [];
  let connected = true;
  const page = {
    isClosed: () => false,
    async close() { events.push("page.close"); },
  };
  const browser = {
    process: () => null,
    isConnected: () => connected,
    async close() {
      events.push("browser.close");
      connected = false;
    },
    disconnect() { connected = false; },
  };
  const report = await cleanupBrowserTestResources({
    browser,
    ownedPages: [page],
    prepareOwnedPageClose: async () => ({ state: "failed", reason: "no-active-document" }),
  });

  assert.deepEqual(events, ["page.close", "browser.close"]);
  assert.equal(report.browser.pageClose.pages[0].preparation.state, "failed");
  assert.equal(report.browser.pageClose.pages[0].preparation.result.reason, "no-active-document");
  assert.equal(report.browser.pageClose.state, "failed");
  assert.equal(report.browser.closeState, "fulfilled");
  assert.equal(report.status, "failed");
  assert.equal(report.errors.filter((entry) => entry.phase === "browser.page.prepare-close").length, 1);
});

test("a timed out owned-page preparation does not renew the close deadline or skip close attempts", async () => {
  const events = [];
  let connected = true;
  const page = {
    isClosed: () => false,
    async close() { events.push("page.close"); },
  };
  const browser = {
    process: () => null,
    isConnected: () => connected,
    async close() {
      events.push("browser.close");
      connected = false;
    },
    disconnect() { connected = false; },
  };
  const startedAt = Date.now();
  const timeoutMs = 35;
  const report = await cleanupBrowserTestResources({
    browser,
    ownedPages: [page],
    browserTimeoutMs: timeoutMs,
    prepareOwnedPageClose: () => new Promise(() => {}),
  });
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(events, ["page.close", "browser.close"]);
  assert.equal(report.browser.pageClose.pages[0].preparation.state, "timeout");
  assert.equal(report.browser.pageClose.state, "timeout");
  assert.equal(report.browser.closeState, "timeout", "browser.close must not receive a new deadline after preparation consumes it");
  assert.equal(
    report.browser.timings.closeDeadlineAt,
    report.browser.timings.cleanupStartedAt + timeoutMs,
  );
  assert.ok(elapsedMs < 150, `pre-close preparation must share the ${timeoutMs} ms budget (observed ${elapsedMs} ms)`);
  assert.equal(report.status, "failed");
  assert.ok(report.errors.some((entry) => entry.phase === "browser.page.prepare-close.timeout"));
});

test("owned-page preparation is not started after synchronous page checks exhaust the deadline", async () => {
  const events = [];
  let connected = true;
  let preparationCalls = 0;
  const page = {
    isClosed() {
      const blockedUntil = Date.now() + 25;
      while (Date.now() < blockedUntil) {}
      return false;
    },
    async close() { events.push("page.close"); },
  };
  const browser = {
    process: () => null,
    isConnected: () => connected,
    async close() {
      events.push("browser.close");
      connected = false;
    },
    disconnect() { connected = false; },
  };
  const report = await cleanupBrowserTestResources({
    browser,
    ownedPages: [page],
    browserTimeoutMs: 10,
    prepareOwnedPageClose: () => {
      preparationCalls += 1;
      return { state: "fulfilled" };
    },
  });

  assert.equal(preparationCalls, 0);
  assert.deepEqual(events, ["page.close", "browser.close"]);
  assert.equal(report.browser.pageClose.pages[0].preparation.state, "timeout");
  assert.equal(report.browser.pageClose.pages[0].preparation.remainingMsAtStart, 0);
  assert.ok(report.errors.some((entry) => entry.phase === "browser.page.prepare-close.timeout"));
});

test("browser cleanup accepts only a zero-exit owned browser process as natural", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-natural-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-natural");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchBrowserCloseControlledProcess(profileDirectory);
  const report = await cleanupBrowserTestResources({
    browser: {
      process: () => child,
      isConnected: () => typeof child.exitCode !== "number" && child.signalCode === null,
      close: () => { const exited = once(child, "exit"); child.send("browser-close"); return exited; },
      disconnect() {},
    },
    browserTimeoutMs: 1_000,
    processExitTimeoutMs: 1_000,
  });

  assert.equal(report.status, "normal");
  assert.equal(report.browser.status, "normal");
  assert.equal(report.browser.process.exitCode, 0);
  assert.equal(report.browser.process.signalCode, null);
  assert.equal(report.browser.process.identity.validated, true);
  assert.equal(report.browser.process.identity.pid, child.pid);
  if (process.platform === "win32") {
    assert.equal(report.browser.process.identity.startedAt, null,
      "Windows cleanup uses the exact Node ChildProcess handle instead of a PowerShell birth-time query");
    assert.equal(report.browser.process.identity.identityMode, "node-child-process-handle");
  } else {
    assert.ok(report.browser.process.identity.startedAt,
      "POSIX cleanup records the process-table birth time used to revalidate the owned child");
    assert.equal(report.browser.process.identity.identityMode, "process-table");
  }
  assert.equal(report.browser.process.identity.executableValidated, true);
  assert.equal(report.browser.process.identity.profileValidated, true);
  assert.deepEqual(report.errors, []);
});

test("targeted async process queries allow child exit events and accept an empty exited group", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process-group query behavior is not available on Windows");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-async-query-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-async-query");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchBrowserCloseControlledProcess(profileDirectory);
  const browser = new EventEmitter();
  let connected = true;
  Object.assign(browser, {
    process: () => child,
    isConnected: () => connected,
    async close() {
      connected = false;
      browser.emit("disconnected");
    },
    disconnect() {
      connected = false;
      browser.emit("disconnected");
    },
  });

  let queryInFlight = false;
  let exitObservedDuringQuery = false;
  let firstQuery = true;
  const queries = [];
  child.once("exit", () => {
    exitObservedDuringQuery = queryInFlight;
  });
  const processQuery = async (command, args, options) => {
    queries.push({ command, args: [...args] });
    const result = await execFileAsync(command, args, options);
    if (firstQuery) {
      firstQuery = false;
      queryInFlight = true;
      const exitTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.send("browser-close");
      }, 20);
      await new Promise((resolve) => setTimeout(resolve, 150));
      clearTimeout(exitTimer);
      queryInFlight = false;
    }
    return result;
  };

  const report = await cleanupBrowserTestResources({ browser, processQuery });

  assert.equal(exitObservedDuringQuery, true, "the child exit event should run while the async ps query is pending");
  assert.ok(queries.length >= 2);
  assert.ok(queries.every(({ command }) => command === "ps" || command === "pgrep"));
  assert.ok(queries.some(({ command, args }) => command === "ps" && args.includes("-p") && args.includes(String(child.pid))));
  assert.ok(queries.some(({ command, args }) =>
    (command === "pgrep" && args.includes("-g")) ||
    (command === "ps" && args.includes("-g")),
  ));
  assert.ok(queries.every(({ args }) => !args.includes("-axo")), "process checks must not scan the global table");
  assert.equal(report.status, "normal", JSON.stringify(report));
  assert.equal(report.browser.process.exitCode, 0);
  assert.equal(report.browser.process.signalCode, null);
  assert.deepEqual(report.browser.termination, []);
  assert.deepEqual(report.errors, []);
});

test("Linux process-group checks use pgrep IDs and a targeted ps PID list", async () => {
  const queries = [];
  const processQuery = async (command, args) => {
    queries.push({ command, args: [...args] });
    if (command === "pgrep") return { stdout: "41001\n41002\n", stderr: "" };
    assert.equal(command, "ps");
    return {
      stdout: [
        "41001 1 41000 S Mon Oct 12 09:30:00 2026 /tmp/test-browser --user-data-dir=/tmp/puppeteer_dev_chrome_profile-test",
        "41002 41001 41000 S Mon Oct 12 09:30:01 2026 /tmp/test-browser --type=renderer --user-data-dir=/tmp/puppeteer_dev_chrome_profile-test",
        "41000 40000 41000 S Mon Oct 12 09:29:59 2026 /tmp/test-browser --user-data-dir=/tmp/puppeteer_dev_chrome_profile-test",
      ].join("\n"),
      stderr: "",
    };
  };

  const rows = await readPosixProcessTable(41000, 41000, processQuery, "linux");

  assert.deepEqual(queries, [
    { command: "pgrep", args: ["-g", "41000"] },
    { command: "ps", args: ["-p", "41001,41002,41000", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="] },
  ]);
  assert.deepEqual(rows.map((row) => row.pid), [41001, 41002, 41000]);
  assert.ok(queries.every(({ args }) => !args.includes("--pgroup") && !args.includes("-axo")));
});

test("Linux process-group lookup accepts only a silent no-match and fails closed on diagnostics", async () => {
  const absentQueries = [];
  const absentRows = await readPosixProcessTable(null, 41999, async (command, args) => {
    absentQueries.push({ command, args });
    throw Object.assign(new Error("no matching process"), { code: 1, stdout: "", stderr: "" });
  }, "linux");
  assert.deepEqual(absentRows, []);
  assert.deepEqual(absentQueries, [{ command: "pgrep", args: ["-g", "41999"] }]);

  await assert.rejects(
    readPosixProcessTable(null, 42000, async () => {
      throw Object.assign(new Error("invalid process group"), {
        code: 1,
        stdout: "",
        stderr: "process group too large",
      });
    }, "linux"),
    /invalid process group/,
  );
});

test("process-query diagnostics and timeouts still fail closed without signaling", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-query-failure-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-query-failure");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: true, profileDirectory });
  let queryCount = 0;
  const queriesNeededToCaptureIdentity = process.platform === "linux" ? 2 : 1;
  const processQuery = async (command, args, options) => {
    queryCount += 1;
    if (queryCount === 1) {
      if (process.platform === "win32") {
        return {
          stdout: JSON.stringify({
            pid: child.pid,
            parentPid: process.pid,
            executablePath: child.spawnfile,
            commandLine: `${child.spawnfile} ${child.spawnargs.join(" ")}`,
            startedAt: "2026-10-16T00:00:00.000Z",
          }),
          stderr: "",
        };
      }
    }
    if (process.platform !== "win32" && queryCount <= queriesNeededToCaptureIdentity) {
      return execFileAsync(command, args, options);
    }
    throw Object.assign(new Error("targeted process query timed out"), {
      code: "ETIMEDOUT",
      stdout: "",
      stderr: "",
    });
  };

  const report = await cleanupBrowserTestResources({
    browser: browserFor(child),
    processQuery,
    browserTimeoutMs: 25,
    processExitTimeoutMs: 25,
    terminateTimeoutMs: 40,
    killTimeoutMs: 40,
  });

  assert.equal(queryCount, queriesNeededToCaptureIdentity + 1,
    "the baseline identity queries should succeed before the bounded revalidation query times out");
  assert.equal(report.status, "failed");
  assert.equal(report.browser.termination.length, 1);
  assert.equal(report.browser.termination[0].signal, "SIGTERM");
  assert.equal(report.browser.termination[0].sent, false);
  assert.match(report.browser.termination[0].validationError, /timed out/);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("explicit ownedPages skips browser.pages and leaves the initial blank target for Browser.close", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-owned-pages-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-owned-pages");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchBrowserCloseControlledProcess(profileDirectory);
  let connected = true;
  let listingCalls = 0;
  const events = [];
  const blankTarget = { closed: false };
  const readerPage = {
    closed: false,
    url: () => "http://127.0.0.1:8123/reader",
    isClosed() { return this.closed; },
    async close() {
      this.closed = true;
      events.push("owned-page.close");
    },
  };
  const browser = new EventEmitter();
  Object.assign(browser, {
    process: () => child,
    isConnected: () => connected,
    async pages() {
      listingCalls += 1;
      throw new Error("explicit ownedPages must bypass Browser.pages");
    },
    async close() {
      assert.equal(readerPage.closed, true);
      assert.equal(blankTarget.closed, false, "the unowned initial blank target must remain open until Browser.close");
      events.push("browser.close:blank-still-open");
      blankTarget.closed = true;
      const exited = once(child, "exit");
      child.send("browser-close");
      await exited;
      connected = false;
      browser.emit("disconnected");
    },
    disconnect() {
      connected = false;
      browser.emit("disconnected");
    },
  });

  const report = await cleanupBrowserTestResources({ browser, ownedPages: [readerPage] });

  assert.equal(listingCalls, 0);
  assert.deepEqual(events, ["owned-page.close", "browser.close:blank-still-open"]);
  assert.equal(blankTarget.closed, true);
  assert.equal(report.browser.pageClose.source, "ownedPages");
  assert.equal(report.browser.pageClose.attempted, 1);
  assert.equal(report.browser.closeState, "fulfilled");
  assert.equal(report.status, "normal", JSON.stringify(report));
  assert.equal(report.browser.process.exitCode, 0);
  assert.equal(report.browser.process.signalCode, null);
  assert.deepEqual(report.browser.termination, []);
  assert.deepEqual(report.errors, []);
});

test("browser cleanup naturally accepts an owned child that exited before cleanup began", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-already-exited-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-already-exited");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchReadyExitProcess(profileDirectory);
  const exited = once(child, "exit");
  await scheduleNaturalExit(child, { delayMs: 0, exitCode: 0 });
  await exited;
  assert.equal(child.exitCode, 0);
  let browserCloseCalls = 0;
  const report = await cleanupBrowserTestResources({
    browser: {
      process: () => child,
      isConnected: () => false,
      pages: async () => { throw new Error("empty ownedPages must skip enumeration"); },
      close: async () => { browserCloseCalls += 1; },
      disconnect() {},
    },
    ownedPages: [],
    browserTimeoutMs: 100,
    processExitTimeoutMs: 100,
  });

  assert.equal(browserCloseCalls, 1);
  assert.equal(report.status, "normal", JSON.stringify(report));
  assert.equal(report.browser.process.exitCode, 0);
  assert.equal(report.browser.process.signalCode, null);
  assert.deepEqual(report.browser.termination, []);
  assert.deepEqual(report.errors, []);
});

test("browser cleanup releases owned pipes after natural exit and CDP disconnect", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-inherited-stderr-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-inherited-stderr");
  await mkdir(profileDirectory);
  // Keep this test-owned pipe holder alive until explicit teardown, not until
  // a wall-clock timer that may expire during an OS identity query.
  const descendantScript = "const server=require('node:net').createServer(socket=>socket.once('data',()=>process.exit(0))); server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));";
  const source = [
    "const { spawn } = require('node:child_process');",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { detached: true, stdio: ['ignore', 'ignore', 2, 'ipc'] });`,
    "descendant.once('message', message => process.stdout.write('ready:' + descendant.pid + ':' + message.port + '\\n'));",
    "process.on('message', (message) => { if (message === 'exit-now') process.exit(0); });",
  ].join(" ");
  const child = spawn(
    process.execPath,
    ["-e", source, "--", `--user-data-dir=${profileDirectory}`],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  await once(child, "spawn");
  const [ready] = await once(child.stdout, "data");
  assert.equal(registerOwnedBrowserChild(child), true);
  const grandchildPid = Number(String(ready).match(/ready:(\d+)/)?.[1]);
  const grandchildPort = Number(String(ready).match(/ready:\d+:(\d+)/)?.[1]);
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
  t.after(() => { try { process.kill(grandchildPid); } catch (error) { if (error.code !== "ESRCH") throw error; } });
  const browser = new EventEmitter();
  browser.connected = true;
  browser.process = () => child;
  browser.isConnected = () => browser.connected;
  let closeResolvedAt = null;
  let childExitedAt = null;
  let disconnectedAt = null;
  let childAliveAtDisconnect = false;
  let pipesOpenAtDisconnect = false;
  let descendantAliveAtClose = false;
  let descendantProbeError = null;
  browser.close = () => {
    const childClosed = once(child, "close");
    childAliveAtDisconnect = child.exitCode === null && child.signalCode === null;
    pipesOpenAtDisconnect = !child.stdout.destroyed && !child.stderr.destroyed;
    disconnectedAt = Date.now();
    browser.connected = false;
    browser.emit("disconnected");
    child.send("exit-now");
    return childClosed.then(() => {
      closeResolvedAt = Date.now();
      try {
        process.kill(grandchildPid, 0);
        descendantAliveAtClose = true;
      } catch (error) {
        descendantProbeError = { code: error.code, message: error.message };
        descendantAliveAtClose = error?.code === "EPERM";
      }
    });
  };
  browser.disconnect = () => {
    browser.connected = false;
    browser.emit("disconnected");
  };
  child.once("exit", () => {
    childExitedAt = Date.now();
  });

  const startedAt = Date.now();
  const closeDeadlineMs = 700;
  const report = await cleanupBrowserTestResources({
    browser,
    browserTimeoutMs: closeDeadlineMs,
    processExitTimeoutMs: 2_500,
  });

  assert.equal(report.status, "normal", JSON.stringify(report));
  assert.equal(report.browser.status, "normal");
  assert.equal(report.browser.closeState, "fulfilled");
  assert.equal(report.browser.process.exitCode, 0);
  assert.equal(report.browser.process.signalCode, null);
  assert.equal(report.browser.process.profileIdentityValidatedAtStart, true);
  if (process.platform === "win32") {
    assert.equal(report.browser.process.processGroupValidatedAtStart, false,
      "Windows cleanup uses the exact ChildProcess handle and does not validate POSIX process groups");
  } else {
    const { stdout } = await execFileAsync("ps", ["-p", String(grandchildPid), "-o", "pgid="], {
      encoding: "utf8",
      timeout: 500,
      maxBuffer: 1_024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    assert.notEqual(Number(stdout.trim()), child.pid,
      "the pipe holder must stay in its own detached process group, outside the owned browser group");
    assert.equal(report.browser.process.processGroupValidatedAtStart, true,
      "the browser's own process group can be validated without including the detached pipe holder");
  }
  assert.equal(report.browser.releasedExitedProcessPipes, true);
  assert.ok(closeResolvedAt !== null);
  assert.ok(childExitedAt !== null);
  assert.ok(disconnectedAt !== null);
  assert.ok(disconnectedAt < childExitedAt, "the simulated CDP disconnect should arrive while the browser child is alive");
  assert.equal(childAliveAtDisconnect, true);
  assert.equal(pipesOpenAtDisconnect, true, "owned streams must stay open until the child exits");
  assert.ok(closeResolvedAt - report.browser.timings.cleanupStartedAt < closeDeadlineMs,
    "the existing close deadline starts after OS ownership capture, not before it");
  assert.ok(report.browser.timings.cleanupStartedAt >= startedAt);
  assert.ok(closeResolvedAt >= childExitedAt, "close must not finish before child exit");
  assert.equal(descendantAliveAtClose, true, "the simulated Crashpad descendant must still hold stderr when close finishes: " + JSON.stringify(descendantProbeError));
  assert.deepEqual(report.browser.termination, []);
  assert.deepEqual(report.errors, []);
  await new Promise((resolve, reject) => {
    const socket = connect(grandchildPort, "127.0.0.1", () => { socket.end("fixture-complete"); resolve(); });
    socket.once("error", reject);
  });
  assert.equal(await waitForPidExit(grandchildPid, 2_500), true, "the unowned fixture descendant must exit on its own within the bound");
  assert.ok(Date.now() - startedAt < 3_500, "the unowned fixture descendant must exit within the bounded cleanup window");
});

test("process identity matching requires the exact nonempty birth timestamp", () => {
  const baseline = { pid: 24_680, startedAt: "Mon Oct 12 09:30:00 2026" };

  assert.equal(processIdentityMatches({ ...baseline }, baseline), true);
  assert.equal(processIdentityMatches({ pid: baseline.pid }, baseline), false);
  assert.equal(processIdentityMatches({ ...baseline, startedAt: "" }, baseline), false);
  assert.equal(processIdentityMatches({ ...baseline, startedAt: "  " }, baseline), false);
  assert.equal(processIdentityMatches({ pid: baseline.pid, startedAt: baseline.startedAt }, { pid: baseline.pid }), false);
  assert.equal(processIdentityMatches({ ...baseline, startedAt: "Mon Oct 12 09:30:01 2026" }, baseline), false);
});

test("owned-process sampling refuses an identity with a missing birth timestamp", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-sample-identity-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-sample");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: false, profileDirectory });
  const ownership = await captureOwnedBrowserIdentity(child);
  assert.equal(ownership.available, true);
  const staleIdentity = {
    ...ownership,
    baselineLeader: { ...ownership.baselineLeader, startedAt: "" },
  };
  const result = await sampleOwnedBrowserProcess(
    child,
    staleIdentity,
    path.join(root, "must-not-sample.txt"),
  );

  assert.equal(result.state, "skipped");
  assert.match(result.reason, /identity|profile/i);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("opt-in mayDie sampling keeps its command bound and reports timeout signal metadata", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Owned browser process sampling is macOS-only");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-sample-may-die-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-sample-may-die");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: false, profileDirectory });
  const ownership = await captureOwnedBrowserIdentity(child);
  assert.equal(ownership.available, true);
  const outputPath = path.join(root, "sample.txt");
  let receivedArgs;
  let receivedOptions;
  const timeoutError = Object.assign(new Error("sample runner timed out"), {
    code: "ETIMEDOUT",
    killed: true,
    signal: "SIGKILL",
  });

  const result = await sampleOwnedBrowserProcess(child, ownership, outputPath, {
    durationSeconds: 1,
    timeoutMs: 8_000,
    mayDie: true,
    sampleRunner: async (command, args, options) => {
      assert.equal(command, "/usr/bin/sample");
      receivedArgs = args;
      receivedOptions = options;
      throw timeoutError;
    },
  });

  assert.deepEqual(receivedArgs, [String(child.pid), "1", "-mayDie", "-file", outputPath]);
  assert.equal(receivedOptions.timeout, 8_000);
  assert.equal(result.state, "failed");
  assert.equal(result.durationSeconds, 1);
  assert.equal(result.mayDie, true);
  assert.equal(result.command.timeoutMs, 8_000);
  assert.equal(result.command.killed, true);
  assert.equal(result.command.signal, "SIGKILL");
  assert.equal(result.command.code, "ETIMEDOUT");
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("sample success without a nonempty artifact is reported as failure with bounded command output", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Owned browser process sampling is macOS-only");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-sample-empty-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-sample-empty");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: false, profileDirectory });
  const ownership = await captureOwnedBrowserIdentity(child);
  assert.equal(ownership.available, true);
  const outputPath = path.join(root, "sample.txt");
  const result = await sampleOwnedBrowserProcess(
    child,
    ownership,
    outputPath,
    {
      sampleRunner: async (command, args) => {
        assert.equal(command, "/usr/bin/sample");
        assert.equal(args[0], String(child.pid));
        const childExit = once(child, "exit");
        child.kill("SIGTERM");
        await childExit;
        return { stdout: "sample fixture stdout", stderr: "sample fixture stderr", code: 0 };
      },
    },
  );

  assert.equal(result.state, "failed");
  assert.equal(result.command.state, "fulfilled");
  assert.equal(result.command.code, 0);
  assert.equal(result.command.stdout.tail, "sample fixture stdout");
  assert.equal(result.command.stderr.tail, "sample fixture stderr");
  assert.equal(result.output.state, "missing");
  assert.equal(result.output.exists, false);
  assert.equal(result.childExitedBySampleReturn, true);
  assert.match(result.reason, /without a valid nonempty output file/);
});

test("sampler preflight preserves an oversized pre-existing output inode and contents", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Owned browser process sampling is macOS-only");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-sample-existing-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-sample-existing");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: false, profileDirectory });
  const ownership = await captureOwnedBrowserIdentity(child);
  assert.equal(ownership.available, true);
  const outputPath = path.join(root, "pre-existing-sample.txt");
  const original = Buffer.alloc(MAX_BROWSER_SAMPLE_OUTPUT_BYTES + 1);
  original.write("pre-existing sample sentinel", 0, "utf8");
  original.write("preserve-this-tail", original.length - 18, "utf8");
  await writeFile(outputPath, original);
  const before = await lstat(outputPath);
  let sampleRunnerCalled = false;

  const result = await sampleOwnedBrowserProcess(child, ownership, outputPath, {
    sampleRunner: async () => {
      sampleRunnerCalled = true;
      return { code: 0 };
    },
  });

  const after = await lstat(outputPath);
  const afterContents = await readFile(outputPath);
  assert.equal(result.state, "failed");
  assert.equal(result.output.state, "oversized");
  assert.equal(result.output.bytes, original.length);
  assert.equal(sampleRunnerCalled, false);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.deepEqual(afterContents, original);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("only an oversized artifact created during sampling is truncated to the output cap", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("Owned browser process sampling is macOS-only");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-sample-owned-output-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-sample-owned-output");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: false, profileDirectory });
  const ownership = await captureOwnedBrowserIdentity(child);
  assert.equal(ownership.available, true);
  const outputPath = path.join(root, "owned-sample.txt");
  const oversized = Buffer.alloc(MAX_BROWSER_SAMPLE_OUTPUT_BYTES + 4_096, 0x41);
  const result = await sampleOwnedBrowserProcess(child, ownership, outputPath, {
    sampleRunner: async (_command, args) => {
      assert.equal(args[3], outputPath);
      await writeFile(outputPath, oversized);
      return { code: 0 };
    },
  });

  const finalStat = await lstat(outputPath);
  assert.equal(result.state, "failed");
  assert.equal(result.output.state, "oversized-truncated");
  assert.equal(result.output.originalBytes, oversized.length);
  assert.equal(result.output.bytes, MAX_BROWSER_SAMPLE_OUTPUT_BYTES);
  assert.deepEqual(result.output.truncation, {
    state: "truncated",
    limitBytes: MAX_BROWSER_SAMPLE_OUTPUT_BYTES,
  });
  assert.equal(finalStat.size, MAX_BROWSER_SAMPLE_OUTPUT_BYTES);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("browser cleanup preserves a signal exit from browser.close as failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-signaled-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-signaled");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: false, profileDirectory });
  const report = await cleanupBrowserTestResources({
    browser: {
      process: () => child,
      isConnected: () => child.signalCode === null,
      close: () => {
        child.kill("SIGTERM");
        return once(child, "exit");
      },
      disconnect() {},
    },
    browserTimeoutMs: 1_000,
    processExitTimeoutMs: 1_000,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.browser.status, "failed");
  assert.equal(report.browser.process.signalCode, "SIGTERM");
  assert.ok(report.errors.some((entry) => entry.message.includes("exited from signal SIGTERM")));
});

test("browser cleanup reports a natural nonzero child exit and keeps exit-code details visible", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-exit-code-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-exit-code");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchReadyExitProcess(profileDirectory);
  let connected = true;
  child.once("exit", () => { connected = false; });
  const report = await cleanupBrowserTestResources({
    browser: {
      process: () => child,
      isConnected: () => connected,
      close: async () => {
        const exited = once(child, "exit");
        await scheduleNaturalExit(child, { delayMs: 500, exitCode: 2 });
        return exited;
      },
      disconnect() { connected = false; },
    },
    browserTimeoutMs: 1_000,
    processExitTimeoutMs: 1_000,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.browser.status, "failed");
  assert.equal(report.browser.closeState, "fulfilled");
  assert.equal(report.browser.process.exitCode, 2);
  assert.equal(report.browser.process.signalCode, null);
  assert.equal(report.browser.process.identity.validated, true);
  assert.ok(report.errors.some((entry) =>
    entry.phase === "browser.process.exit" && entry.message.includes("code 2"),
  ));

  const error = attachCleanupErrors(null, report);
  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /browser\.process\.exit/);
  assert.match(error.message, /code 2/);
  assert.equal(error.errors[0].phase, "browser.process.exit");
  assert.equal(error.cleanupReport, report);
});

async function stopControlledChild(child) {
  if (!child || typeof child.exitCode === "number" || typeof child.signalCode === "string") return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

async function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code === "EPERM";
  }
  if (process.platform === "win32") return true;
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      timeout: 500,
      maxBuffer: 1_024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    const state = String(stdout || "").trim().split(/\s+/, 1)[0] || "";
    return Boolean(state) && !state.includes("Z");
  } catch (error) {
    if (
      Number(error?.code) === 1 &&
      !String(error?.stdout || "").trim() &&
      !String(error?.stderr || "").trim()
    ) return false;
    return true;
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (await pidIsAlive(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
  return true;
}

test("browser cleanup TERM/KILL is bounded, identity-checked, and reported as forced", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-controlled");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: true, profileDirectory });
  const childBeforeCleanup = {
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    spawnfile: child.spawnfile,
    profileArgument: child.spawnargs.find((argument) => argument.startsWith("--user-data-dir=")) || null,
  };
  const report = await cleanupBrowserTestResources({
    browser: browserFor(child),
    browserTimeoutMs: 25,
    processExitTimeoutMs: 25,
    terminateTimeoutMs: 40,
    killTimeoutMs: 1_000,
  });

  if (report.status !== "forced" || report.browser.status !== "forced") {
    const artifactDirectory = path.resolve("tests/artifacts");
    const artifactPath = path.join(
      artifactDirectory,
      `browser-cleanup-forced-failure-${Date.now()}-${process.pid}-${randomUUID()}.json`,
    );
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(artifactPath, JSON.stringify({
      capturedAt: new Date().toISOString(),
      childBeforeCleanup,
      child: {
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        spawnfile: child.spawnfile,
        profileArgument: child.spawnargs.find((argument) => argument.startsWith("--user-data-dir=")) || null,
      },
      helperIdentityAtStart: report.browser.process.identity,
      helperGroup: {
        validatedAtStart: report.browser.process.processGroupValidatedAtStart,
        groupId: report.browser.process.processGroupId,
        reason: report.browser.process.processGroupIdentityValidationReason,
      },
      helperIdentityReason: report.browser.process.identityValidationReason,
      report,
    }, null, 2), "utf8");
    t.diagnostic(`Unexpected forced-cleanup report: ${artifactPath}`);
  }

  assert.equal(report.status, "forced");
  assert.equal(report.browser.status, "forced");
  const terminationSignals = report.browser.termination.map(({ signal }) => signal);
  if (process.platform === "win32") {
    assert.ok(
      JSON.stringify(terminationSignals) === JSON.stringify(["SIGTERM"]) ||
        JSON.stringify(terminationSignals) === JSON.stringify(["SIGTERM", "SIGKILL"]),
      `Windows cleanup must terminate through its verified signal path: ${JSON.stringify(terminationSignals)}`,
    );
    if (terminationSignals.length === 2) {
      assert.equal(report.browser.termination[1].method, "taskkill.exe /PID /T /F");
    }
    assert.ok(report.browser.process.exitCode !== null || typeof report.browser.process.signalCode === "string");
  } else {
    assert.deepEqual(terminationSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(typeof report.browser.process.signalCode, "string");
  }
  assert.ok(report.browser.termination.every((entry) => entry.identityRevalidated));
  assert.ok(report.errors.some((entry) => entry.phase === "browser.forced-cleanup"));
  assert.ok(attachCleanupErrors(null, report) instanceof AggregateError);
});

test("browser cleanup refuses to signal a process when the profile identity changed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-identity-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-controlled");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchControlledBrowserProcess({ ignoreTerm: false, profileDirectory });
  const actualArgs = child.spawnargs;
  child.spawnargs = actualArgs.filter((argument) => !argument.startsWith("--user-data-dir="));
  child.spawnargs.push(`--user-data-dir=${path.join(root, "puppeteer_dev_chrome_profile-different")}`);

  const report = await cleanupBrowserTestResources({
    browser: browserFor(child),
    browserTimeoutMs: 25,
    processExitTimeoutMs: 25,
    terminateTimeoutMs: 40,
    killTimeoutMs: 40,
  });

  assert.equal(report.status, "failed");
  assert.equal(report.browser.status, "failed");
  assert.equal(report.browser.process.profileIdentityValidatedAtStart, false);
  assert.deepEqual(report.browser.termination, []);
  assert.ok(report.errors.some((entry) => entry.phase === "browser.identity"));
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);

  child.spawnargs = actualArgs;
});

test("cleanup errors remain attached to the original functional error", () => {
  const functionalError = new Error("functional assertion failed");
  const report = {
    status: "forced",
    errors: [{ phase: "browser.forced-cleanup", message: "browser required SIGKILL" }],
  };

  const result = attachCleanupErrors(functionalError, report);
  assert.equal(result, functionalError);
  assert.match(result.message, /^functional assertion failed/);
  assert.equal(result.cleanupErrors[0].phase, "browser.forced-cleanup");
  assert.equal(result.cleanupReport, report);
});

test("cleanup AggregateError surfaces the phase and nonzero child exit in its message", () => {
  const report = {
    status: "failed",
    browser: {
      status: "failed",
      process: { pid: 4242, exitCode: 2, signalCode: null },
    },
    errors: [{
      phase: "browser.process.exit",
      message: "Browser child 4242 exited with code 2 instead of 0",
    }],
  };

  const error = attachCleanupErrors(null, report);

  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /browser\.process\.exit/);
  assert.match(error.message, /code 2/);
  assert.equal(error.errors[0].phase, "browser.process.exit");
  assert.equal(error.cleanupReport, report);
});

test("browser cleanup retains inner AggregateError causes and codes in the report and summary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-cleanup-inner-error-test-"));
  const profileDirectory = path.join(root, "puppeteer_dev_chrome_profile-inner-error");
  await mkdir(profileDirectory);
  let child;
  t.after(async () => {
    await stopControlledChild(child);
    await rm(root, { recursive: true, force: true });
  });

  child = await launchReadyExitProcess(profileDirectory);
  let connected = true;
  const lowLevelCause = Object.assign(new Error("target session closed before disposal"), {
    code: "ERR_TARGET_SESSION_CLOSED",
  });
  const innerError = Object.assign(new Error("page close handshake failed"), {
    code: "ERR_PAGE_CLOSE_HANDSHAKE",
    cause: lowLevelCause,
  });
  const closeError = new AggregateError([innerError], "Browser close aggregated a page teardown failure");
  const report = await cleanupBrowserTestResources({
    browser: {
      process: () => child,
      isConnected: () => connected,
      close: async () => {
        await scheduleNaturalExit(child, { delayMs: 0, exitCode: 0 });
        throw closeError;
      },
      disconnect: () => { connected = false; },
    },
    ownedPages: [],
    browserTimeoutMs: 1_000,
    processExitTimeoutMs: 1_000,
  });

  const closeEntry = report.errors.find((entry) => entry.phase === "browser.close");
  assert.ok(closeEntry);
  assert.equal(closeEntry.name, "AggregateError");
  assert.equal(closeEntry.errors[0].code, "ERR_PAGE_CLOSE_HANDSHAKE");
  assert.equal(closeEntry.errors[0].cause.code, "ERR_TARGET_SESSION_CLOSED");
  assert.equal(report.browser.process.exitCode, 0);
  assert.equal(report.browser.process.signalCode, null);

  const cleanupError = attachCleanupErrors(null, report);
  assert.ok(cleanupError.message.includes("Browser close aggregated a page teardown failure"));
  assert.ok(cleanupError.message.includes("ERR_PAGE_CLOSE_HANDSHAKE"));
  assert.ok(cleanupError.message.includes("ERR_TARGET_SESSION_CLOSED"));
  assert.equal(cleanupError.errors[0].errors[0].cause.code, "ERR_TARGET_SESSION_CLOSED");
  assert.equal(cleanupError.cleanupReport, report);
});
