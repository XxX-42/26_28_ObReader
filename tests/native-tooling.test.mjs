import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

process.env.OBSIDIAN_VAULT_PATH =
  "/Users/jiajia/Documents/ObReader-Apple-Test";
process.env.OBSIDIAN_VAULT_NAME = "ObReader-Apple-Test";
process.env.PDF_READER_OBSIDIAN_CLI = "/usr/local/bin/obsidian";
process.env.OBSIDIAN_CONFIG_DIR = ".obsidian";

const { resolveBrowserPath } = await import("./browser-path.mjs");
const { nativeVirtualKeyCode } = await import("./native-keycodes.mjs");
const {
  fixturesForNativeCases,
  NATIVE_LIFECYCLE_CASES,
  selectNativeCases,
} = await import("./native-case-selection.mjs");
const {
  assertNativeVaultIdentity,
  assertSafeDeploymentPreflight,
  assertNativeTestPreflight,
  invokeNativeCli,
  loadNativeConfig,
  NATIVE_CLI_MAX_BUFFER,
} = await import("./native-config.mjs");

const nativeCliTestConfig = {
  platform: process.platform,
  vault: "test-only-vault",
  vaultSelector: "test-only-vault",
  cli: process.execPath,
  cdpUrl: "",
};

function invokeNodeThroughNativeCli(script, timeout = 5_000) {
  return invokeNativeCli(
    ["test-only-command"],
    timeout,
    nativeCliTestConfig,
    (_cli, _args, options) => {
      assert.equal(options.maxBuffer, 128 * 1024 * 1024);
      return spawnSync(process.execPath, ["-e", script], options);
    },
  );
}

test("native config retains the Windows test target", () => {
  const config = loadNativeConfig({}, "win32");
  assert.equal(config.vault, String.raw`D:\Documents\Obsidian\测试插件`);
  assert.equal(config.vaultSelector, "测试插件");
  assert.equal(config.cli, String.raw`D:\Applications\Obsidian\Obsidian.com`);
  assert.equal(config.configDir, ".obsidian");
});

test("non-Windows native tests require an explicit test vault, CLI and selector", () => {
  assert.throws(() => loadNativeConfig({}, "darwin"), /OBSIDIAN_VAULT_PATH/);
  assert.throws(
    () => loadNativeConfig({ OBSIDIAN_VAULT_PATH: "/tmp/test-vault" }, "linux"),
    /OBSIDIAN_VAULT_ID/,
  );
  assert.throws(
    () => loadNativeConfig({
      OBSIDIAN_VAULT_PATH: "/tmp/test-vault",
      OBSIDIAN_VAULT_ID: "test",
    }, "linux"),
    /PDF_READER_OBSIDIAN_CLI/,
  );
  const cdpOnly = loadNativeConfig({
    OBSIDIAN_VAULT_PATH: "/tmp/test-vault",
    OBSIDIAN_VAULT_ID: "test",
    PDF_READER_CDP_URL: "http://127.0.0.1:9226",
  }, "linux");
  assert.equal(cdpOnly.cli, "");
  assert.equal(cdpOnly.cdpUrl, "http://127.0.0.1:9226");
});

test("active-vault mode requires an exact test path and never sends a vault selector", () => {
  const config = loadNativeConfig({
    OBSIDIAN_ACTIVE_VAULT: "1",
    OBSIDIAN_VAULT_PATH: String.raw`D:\Documents\Obsidian\测试插件`,
    PDF_READER_OBSIDIAN_CLI: String.raw`D:\Applications\Obsidian\Obsidian.com`,
    OBSIDIAN_CONFIG_DIR: ".obsidian",
  }, "win32");
  assert.equal(config.useActiveVault, true);
  assert.equal(config.vaultSelector, "");
  let capturedArgs;
  const output = invokeNativeCli(["version"], 1_000, config, (_cli, args) => {
    capturedArgs = args;
    return { status: 0, stdout: "1.14.4\n", stderr: "" };
  });
  assert.deepEqual(capturedArgs, ["version"]);
  assert.equal(output, "1.14.4");

  assert.throws(() => loadNativeConfig({
    OBSIDIAN_ACTIVE_VAULT: "1",
    OBSIDIAN_VAULT_NAME: "测试插件",
    OBSIDIAN_VAULT_PATH: String.raw`D:\Documents\Obsidian\测试插件`,
    PDF_READER_OBSIDIAN_CLI: String.raw`D:\Applications\Obsidian\Obsidian.com`,
  }, "win32"), /Do not combine OBSIDIAN_ACTIVE_VAULT/);
  assert.throws(() => loadNativeConfig({
    OBSIDIAN_ACTIVE_VAULT: "1",
    PDF_READER_OBSIDIAN_CLI: String.raw`D:\Applications\Obsidian\Obsidian.com`,
  }, "win32"), /OBSIDIAN_VAULT_PATH/);
});

test("macOS native config only accepts the explicit isolated test vault", () => {
  const config = loadNativeConfig({
    OBSIDIAN_VAULT_PATH: "/Users/jiajia/Documents/ObReader-Apple-Test",
    OBSIDIAN_VAULT_NAME: "ObReader-Apple-Test",
    PDF_READER_OBSIDIAN_CLI: "/usr/local/bin/obsidian",
    OBSIDIAN_CONFIG_DIR: ".obsidian",
  }, "darwin");
  assert.equal(config.vault, "/Users/jiajia/Documents/ObReader-Apple-Test");
  assert.equal(config.vaultSelector, "ObReader-Apple-Test");
  assert.equal(config.cli, "/usr/local/bin/obsidian");
  assert.throws(() => loadNativeConfig({
    OBSIDIAN_VAULT_PATH: "/Users/jiajia/Documents/Obsidian",
    OBSIDIAN_VAULT_NAME: "Obsidian",
    PDF_READER_OBSIDIAN_CLI: "/usr/local/bin/obsidian",
  }, "darwin"), /restricted to the isolated test vault/);

  const direct = loadNativeConfig({
    OBSIDIAN_VAULT_PATH: "/Users/jiajia/Documents/ObReader-Apple-Test",
    OBSIDIAN_VAULT_NAME: "ObReader-Apple-Test",
    PDF_READER_CDP_URL: "http://127.0.0.1:9226",
  }, "darwin");
  assert.equal(direct.cdpUrl, "http://127.0.0.1:9226");
  assert.equal(direct.cli, "/usr/local/bin/obsidian");
});

test("custom config directory must remain inside the vault", () => {
  assert.throws(() => loadNativeConfig({
    OBSIDIAN_VAULT_PATH: "/tmp/test-vault",
    OBSIDIAN_VAULT_ID: "test",
    PDF_READER_OBSIDIAN_CLI: "/usr/bin/obsidian",
    OBSIDIAN_CONFIG_DIR: "../outside",
  }, "linux"), /must stay inside the vault/);
});

test("identity and deployment guards fail closed before disk changes", () => {
  const config = loadNativeConfig({
    OBSIDIAN_VAULT_PATH: "/Users/jiajia/Documents/ObReader-Apple-Test",
    OBSIDIAN_VAULT_NAME: "ObReader-Apple-Test",
    PDF_READER_OBSIDIAN_CLI: "/usr/local/bin/obsidian",
    OBSIDIAN_CONFIG_DIR: ".obsidian",
  }, "darwin");
  const identity = {
    vault: config.vault,
    configDir: config.configDir,
    pluginEnabled: false,
    readerViews: [],
  };
  assertNativeVaultIdentity(identity, config);
  assertSafeDeploymentPreflight(identity, config);
  assert.throws(
    () => assertNativeVaultIdentity({ ...identity, vault: "/Users/jiajia/Documents/Obsidian" }, config),
    /refusing to use anything except the configured test vault/,
  );
  assert.throws(
    () => assertSafeDeploymentPreflight({ ...identity, pluginEnabled: true }, config),
    /Disable PDF Web Reader manually/,
  );
  assert.throws(
    () => assertSafeDeploymentPreflight({
      ...identity,
      readerViews: [{ path: "unsaved.pdf", pending: true }],
    }, config),
    /Save and close every PDF Web Reader tab/,
  );
});

test("Native acceptance requires the exact enabled runtime, visible window, and no existing Readers", () => {
  const config = loadNativeConfig({
    OBSIDIAN_VAULT_PATH: "/Users/jiajia/Documents/ObReader-Apple-Test",
    OBSIDIAN_VAULT_NAME: "ObReader-Apple-Test",
    PDF_READER_OBSIDIAN_CLI: "/usr/local/bin/obsidian",
    OBSIDIAN_CONFIG_DIR: ".obsidian",
  }, "darwin");
  const preflight = {
    vault: config.vault,
    configDir: config.configDir,
    pluginEnabled: true,
    pluginVersion: "0.8.0",
    visibility: "visible",
    readerViews: [],
  };
  assertNativeTestPreflight(preflight, "0.8.0", config);
  assert.throws(
    () => assertNativeTestPreflight({ ...preflight, visibility: "hidden" }, "0.8.0", config),
    /visible Obsidian test Vault window/,
  );
  assert.throws(
    () => assertNativeTestPreflight({ ...preflight, readerViews: [{ pending: false }] }, "0.8.0", config),
    /Close all existing Reader tabs/,
  );
  assert.throws(
    () => assertNativeTestPreflight({ ...preflight, pluginVersion: "0.6.0" }, "0.8.0", config),
    /Expected runtime plugin 0.8.0/,
  );
});

test("browser resolution finds macOS Chrome and honors explicit paths", () => {
  const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  assert.equal(
    resolveBrowserPath({
      env: {},
      platform: "darwin",
      exists: (candidate) => candidate === chrome,
    }),
    chrome,
  );
  assert.equal(
    resolveBrowserPath({
      env: { PDF_READER_CHROME: "/custom/chrome" },
      platform: "darwin",
      exists: (candidate) => candidate === "/custom/chrome",
    }),
    "/custom/chrome",
  );
  assert.equal(
    resolveBrowserPath({
      env: { PDF_READER_CHROME: "/missing/chrome" },
      platform: "darwin",
      exists: () => false,
    }),
    undefined,
  );
});

test("native keycode helper uses Carbon codes on macOS and preserves Windows codes", () => {
  assert.equal(nativeVirtualKeyCode("darwin", "MetaLeft", 91), 55);
  assert.equal(nativeVirtualKeyCode("darwin", "ShiftLeft", 16), 56);
  assert.equal(nativeVirtualKeyCode("darwin", "KeyZ", 90), 6);
  assert.equal(nativeVirtualKeyCode("darwin", "KeyY", 89), 16);
  assert.equal(nativeVirtualKeyCode("darwin", "KeyS", 83), 1);
  assert.equal(nativeVirtualKeyCode("darwin", "Backspace", 8), 51);
  assert.equal(nativeVirtualKeyCode("darwin", "Delete", 46), 117);
  assert.equal(nativeVirtualKeyCode("darwin", "Escape", 27), 53);
  assert.equal(nativeVirtualKeyCode("darwin", "Digit1", 49), 18);
  assert.equal(nativeVirtualKeyCode("darwin", "Numpad1", 97), 83);
  assert.equal(nativeVirtualKeyCode("win32", "KeyZ", 90), 90);
  assert.throws(() => nativeVirtualKeyCode("darwin", "Unknown", 999), /Missing macOS native keycode/);
});

test("native lifecycle case allowlist defaults to all and selects only requested fixtures", () => {
  const allCases = Object.keys(NATIVE_LIFECYCLE_CASES);
  assert.equal(allCases.length, 19, "The native lifecycle suite has nineteen independently selectable groups.");
  assert.deepEqual(selectNativeCases(undefined), allCases);
  assert.deepEqual(selectNativeCases("all"), allCases);
  assert.deepEqual(selectNativeCases("matrix,popout"), ["matrix", "popout"]);
  assert.deepEqual(selectNativeCases("popout-close"), ["popout-close"]);
  assert.deepEqual(fixturesForNativeCases(["matrix", "popout"]), [
    "native-editor-viewer-matrix",
    "popout-migrate-save-listeners",
  ]);
  assert.deepEqual(fixturesForNativeCases(["popout-close"]), [
    "popout-close-held-save",
    "popout-close-autosave-disabled",
    "popout-close-recovery-write-failure",
  ]);
  assert.deepEqual(fixturesForNativeCases(["popout-move"]), [
    "popout-move-autosave-dirty",
    "popout-move-recovery",
    "popout-move-recovery-failure",
  ]);
  assert.deepEqual(selectNativeCases("freetext-undo"), ["freetext-undo"]);
  assert.deepEqual(fixturesForNativeCases(["freetext-undo"]), ["native-freetext-undo"]);
  assert.throws(() => selectNativeCases("matrix,unknown"), /Unknown PDF_READER_NATIVE_CASES/);
  assert.throws(() => selectNativeCases("matrix,matrix"), /duplicate case names/);
  assert.throws(() => selectNativeCases("matrix,,popout"), /comma-separated list/);
});

test("native CLI captures 20 MiB stdout and stderr within the bounded test buffer", () => {
  assert.equal(NATIVE_CLI_MAX_BUFFER, 128 * 1024 * 1024);
  const bytes = 20 * 1024 * 1024;
  const output = invokeNodeThroughNativeCli(
    `process.stdout.write(Buffer.alloc(${bytes}, 0x61));process.stderr.write(Buffer.alloc(${bytes}, 0x62));`,
  );
  assert.equal(Buffer.byteLength(output, "utf8"), bytes);
  assert.equal(output[0], "a");
  assert.equal(output.at(-1), "a");
});

test("native CLI preserves a non-zero exit and stderr diagnostics", () => {
  assert.throws(
    () => invokeNodeThroughNativeCli("process.stderr.write('intentional-cli-error');process.exitCode=7;"),
    /Obsidian CLI failed \(7\): intentional-cli-error/,
  );
});

test("native CLI timeout remains an error", () => {
  assert.throws(
    () => invokeNodeThroughNativeCli("setInterval(()=>{},1000);", 500),
    error => error?.code === "ETIMEDOUT",
  );
});
