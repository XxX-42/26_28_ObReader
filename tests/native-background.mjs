import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = "D:\\Applications\\Obsidian\\Obsidian.com";
const vault = "D:\\Documents\\Obsidian\\测试插件";
const vaultId = "d9f81db5f3fef6ee";
const artifacts = path.join(root, "tests", "artifacts");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const reportPath = path.join(artifacts, `native-background-${stamp}.json`);

await mkdir(artifacts, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  vault,
  vaultId,
  focusEmulation: "Emulation.setFocusEmulationEnabled",
  status: "running",
  checks: {},
};

function invokeCli(args, timeout = 30_000) {
  const result = spawnSync(cli, [`vault=${vaultId}`, ...args], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Obsidian CLI failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
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

let focusCleanupRequired = false;
let failure;
try {
  const identity = evalJson(`JSON.stringify({
    vault: app.vault.adapter.basePath,
    pluginEnabled: app.plugins.enabledPlugins.has('pdf-web-reader'),
  })`);
  report.checks.identity = identity;
  assert.equal(
    path.resolve(identity.vault),
    path.resolve(vault),
    "Refusing to target a vault other than the configured native test vault",
  );
  assert.equal(
    identity.pluginEnabled,
    true,
    "PDF Web Reader must be enabled before native tests start",
  );

  focusCleanupRequired = true;
  cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  const focusState = evalJson(`JSON.stringify({
    vault: app.vault.adapter.basePath,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
  })`);
  report.checks.focusEnabledSnapshot = focusState;
  assert.equal(path.resolve(focusState.vault), path.resolve(vault));
  assert.equal(
    focusState.visibility,
    "visible",
    "Obsidian did not become renderable under background focus emulation",
  );
  assert.equal(focusState.hasFocus, true);

  const child = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", "npm run test:native"],
    {
      cwd: root,
      stdio: "inherit",
      timeout: 20 * 60 * 1000,
      windowsHide: true,
    },
  );
  report.checks.nativeTest = {
    status: child.status,
    signal: child.signal,
    error: child.error?.message || null,
  };
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `npm run test:native failed with exit code ${child.status}`,
    );
  }
  report.status = "passed";
} catch (error) {
  failure = error;
  report.status = "failed";
  report.error = error?.stack || String(error);
} finally {
  if (focusCleanupRequired) {
    try {
      cdp("Emulation.setFocusEmulationEnabled", { enabled: false });
      report.checks.focusEmulationDisabled = true;
      report.checks.afterFocusDisable = evalJson(`JSON.stringify({
        vault: app.vault.adapter.basePath,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
      })`);
    } catch (error) {
      report.checks.focusEmulationDisableError = error?.stack || String(error);
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
