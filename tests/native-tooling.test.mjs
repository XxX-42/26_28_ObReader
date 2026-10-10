import assert from "node:assert/strict";
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
  loadNativeConfig,
} = await import("./native-config.mjs");

test("native config retains the Windows test target", () => {
  const config = loadNativeConfig({}, "win32");
  assert.equal(config.vault, String.raw`D:\Documents\Obsidian\测试插件`);
  assert.equal(config.vaultSelector, "d9f81db5f3fef6ee");
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
  assert.throws(() => selectNativeCases("matrix,unknown"), /Unknown PDF_READER_NATIVE_CASES/);
  assert.throws(() => selectNativeCases("matrix,matrix"), /duplicate case names/);
  assert.throws(() => selectNativeCases("matrix,,popout"), /comma-separated list/);
});
