import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  assertNativeVaultIdentity,
  invokeNativeCli,
  nativeConfig,
} from "./native-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { cli, vault, vaultSelector: vaultId } = nativeConfig;
const artifacts = path.join(root, "tests", "artifacts");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const reportPath = path.join(artifacts, `native-background-${stamp}.json`);

await mkdir(artifacts, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  app: nativeConfig.cdpUrl || cli,
  driver: nativeConfig.cdpUrl ? "isolated-cdp" : "obsidian-cli-cdp",
  vault,
  vaultId,
  focusEmulation: "Emulation.setFocusEmulationEnabled",
  buildIdentity: {
    candidateSourceSha: process.env.PDF_READER_NATIVE_BUILD_SHA || null,
    installedPluginMainSha256: null,
  },
  status: "running",
  checks: {},
};

function invokeCli(args, timeout = 30_000) {
  return invokeNativeCli(args, timeout);
}

function cdp(method, params = {}, timeout = 30_000) {
  const output = invokeCli(
    ["dev:cdp", `method=${method}`, `params=${JSON.stringify(params)}`],
    timeout,
  );
  if (!output) return {};
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(
      `Obsidian CDP did not return JSON for ${method}: ${output}`,
    );
  }
  return JSON.parse(output.slice(start, end + 1));
}

function evalJson(expression, timeout = 30_000) {
  const response = cdp(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeout,
  );
  if (response.exceptionDetails) {
    throw new Error(
      `Obsidian Runtime.evaluate failed: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text || JSON.stringify(response.exceptionDetails)}`,
    );
  }
  const value = response.result?.value;
  if (typeof value !== "string") {
    throw new Error(`Expected JSON text from Obsidian, got ${typeof value}`);
  }
  return JSON.parse(value);
}

async function startPersistentFocusBroker() {
  const brokerPath = path.join(root, "tests", "native-cdp-broker.mjs");
  const child = spawn(
    process.execPath,
    [
      brokerPath,
      nativeConfig.cdpUrl,
      vault,
      nativeConfig.configDir,
      vaultId,
      "30000",
    ],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: nativeConfig.platform === "win32",
    },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const queue = [];
  let lineWaiter;
  let lineFailure;
  const onLine = (line) => {
    if (lineWaiter) {
      const waiter = lineWaiter;
      lineWaiter = null;
      waiter.resolve(line);
    } else {
      queue.push(line);
    }
  };
  const onClose = () => {
    lineFailure ||= new Error("Persistent Obsidian CDP broker closed unexpectedly");
    if (lineWaiter) {
      const waiter = lineWaiter;
      lineWaiter = null;
      waiter.reject(lineFailure);
    }
  };
  lines.on("line", onLine);
  lines.on("close", onClose);
  child.once("error", (error) => {
    lineFailure ||= error;
    if (lineWaiter) {
      const waiter = lineWaiter;
      lineWaiter = null;
      waiter.reject(lineFailure);
    }
  });

  const nextLine = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (lineFailure) return Promise.reject(lineFailure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (lineWaiter?.timer === timer) lineWaiter = null;
        reject(new Error("Timed out waiting for the persistent Obsidian CDP broker"));
      }, 35_000);
      lineWaiter = {
        timer,
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  };
  const ready = JSON.parse(await nextLine());
  if (!ready.ready) {
    child.kill();
    throw new Error(ready.error || "Persistent Obsidian CDP broker did not start");
  }

  let nextId = 1;
  let closed = false;
  const client = {
    async request(method, params = {}) {
      assert.equal(closed, false, "Persistent Obsidian CDP broker is closed");
      const id = nextId++;
      const written = new Promise((resolve, reject) => {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await written;
      const result = JSON.parse(await nextLine());
      assert.equal(result.id, id, "Persistent CDP broker response did not match its request");
      if (result.error) throw new Error(result.error);
      return result.response;
    },
    async close() {
      if (closed) return;
      closed = true;
      const exited = child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve));
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5_000);
      await exited;
      clearTimeout(timer);
      lines.close();
    },
  };
  return client;
}

async function focusCdp(method, params = {}) {
  return focusBroker
    ? await focusBroker.request(method, params)
    : cdp(method, params);
}

async function focusEvalJson(expression) {
  const response = await focusCdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(
      `Obsidian Runtime.evaluate failed: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text || JSON.stringify(response.exceptionDetails)}`,
    );
  }
  const value = response.result?.value;
  assert.equal(typeof value, "string", `Expected JSON text from Obsidian, got ${typeof value}`);
  return JSON.parse(value);
}

let focusCleanupRequired = false;
let failure;
let focusBroker;
try {
  const installedPluginMainPath = path.join(
    vault,
    nativeConfig.configDir,
    "plugins",
    nativeConfig.pluginId,
    "main.js",
  );
  report.buildIdentity.installedPluginMainSha256 = createHash("sha256")
    .update(await readFile(installedPluginMainPath))
    .digest("hex");
  if (report.buildIdentity.candidateSourceSha) {
    assert.equal(
      report.buildIdentity.candidateSourceSha,
      report.buildIdentity.installedPluginMainSha256,
      "Native background tests must run against the exact candidate installed in the isolated vault.",
    );
  }
  const identity = evalJson(`JSON.stringify({
    vault: app.vault.adapter.basePath,
    configDir: app.vault.configDir,
    pluginEnabled: app.plugins.enabledPlugins.has('pdf-web-reader'),
  })`);
  report.checks.identity = identity;
  assertNativeVaultIdentity(identity);
  assert.equal(
    identity.pluginEnabled,
    true,
    "PDF Web Reader must be enabled before native tests start",
  );

  if (nativeConfig.cdpUrl) {
    focusBroker = await startPersistentFocusBroker();
  }
  focusCleanupRequired = true;
  await focusCdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  const focusState = await focusEvalJson(`JSON.stringify({
    vault: app.vault.adapter.basePath,
    configDir: app.vault.configDir,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
  })`);
  report.checks.focusEnabledSnapshot = focusState;
  assertNativeVaultIdentity(focusState);
  assert.equal(
    focusState.visibility,
    "visible",
    "Obsidian did not become renderable under background focus emulation",
  );
  // Keep the app genuinely in the background. Chromium can emulate renderer
  // visibility without making document.hasFocus() true or activating the OS
  // window, so record that signal instead of treating it as a precondition.
  report.checks.documentFocusAtSnapshot = focusState.hasFocus;

  const childResults = [];
  for (const script of [
    "native-obsidian-smoke.mjs",
    "native-default-routing.mjs",
  ]) {
    const child = spawnSync(
      process.execPath,
      [path.join(root, "tests", script)],
      {
        cwd: root,
        stdio: "inherit",
        timeout: 20 * 60 * 1000,
        windowsHide: nativeConfig.platform === "win32",
      },
    );
    childResults.push({
      script,
      status: child.status,
      signal: child.signal,
      error: child.error?.message || null,
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      throw new Error(`${script} failed with exit code ${child.status}`);
    }
  }
  report.checks.nativeTests = childResults;
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.error = error?.stack || String(error);
} finally {
  if (focusCleanupRequired) {
    try {
      await focusCdp("Emulation.setFocusEmulationEnabled", { enabled: false });
      report.checks.focusEmulationDisabled = true;
      report.checks.afterFocusDisable = await focusEvalJson(`JSON.stringify({
        vault: app.vault.adapter.basePath,
        configDir: app.vault.configDir,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
      })`);
      assertNativeVaultIdentity(report.checks.afterFocusDisable);
    } catch (error) {
      report.checks.focusEmulationDisableError = error?.stack || String(error);
      report.status = "failed";
      failure ||= error;
    }
  }
  if (focusBroker) {
    try {
      await focusBroker.close();
    } catch (error) {
      report.checks.focusBrokerCloseError = error?.stack || String(error);
      report.status = "failed";
      failure ||= error;
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Native background report: ${reportPath}`);
  console.log(`Native background status: ${report.status}`);
}

if (failure) {
  console.error(failure?.stack || String(failure));
  process.exitCode = 1;
}
