import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WINDOWS_TEST_VAULT = String.raw`D:\Documents\Obsidian\测试插件`;
const WINDOWS_TEST_VAULT_NAME = "测试插件";
const WINDOWS_OBSIDIAN_CLI = String.raw`D:\Applications\Obsidian\Obsidian.com`;
const MACOS_OBSIDIAN_CLI = "/usr/local/bin/obsidian";
export const NATIVE_CLI_MAX_BUFFER = 128 * 1024 * 1024;
export const MACOS_TEST_VAULT =
  "/Users/jiajia/Documents/ObReader-Apple-Test";

function resolveForPlatform(value, platform) {
  return platform === "win32" ? path.win32.resolve(value) : path.posix.resolve(value);
}

function validateConfigDir(configDir, platform) {
  assert.equal(typeof configDir, "string", "OBSIDIAN_CONFIG_DIR must be text");
  assert.ok(configDir.length > 0, "OBSIDIAN_CONFIG_DIR must not be empty");
  assert.ok(
    !path.isAbsolute(configDir) && !path.win32.isAbsolute(configDir),
    "OBSIDIAN_CONFIG_DIR must be relative to the vault",
  );
  const pathApi = platform === "win32" ? path.win32 : path;
  const normalized = pathApi.normalize(configDir);
  assert.ok(
    normalized !== "." &&
      normalized !== ".." &&
      !normalized.startsWith(`..${pathApi.sep}`),
    "OBSIDIAN_CONFIG_DIR must stay inside the vault",
  );
  return normalized;
}

export function loadNativeConfig(env = process.env, platform = process.platform) {
  const isWindows = platform === "win32";
  const isMac = platform === "darwin";
  const useActiveVault = env.OBSIDIAN_ACTIVE_VAULT === "1";
  assert.ok(
    !useActiveVault || env.OBSIDIAN_VAULT_PATH,
    "OBSIDIAN_ACTIVE_VAULT=1 requires an explicit OBSIDIAN_VAULT_PATH identity guard",
  );
  const vault = env.OBSIDIAN_VAULT_PATH ||
    (isWindows ? WINDOWS_TEST_VAULT : "");
  assert.ok(
    vault,
    "Set OBSIDIAN_VAULT_PATH to the isolated native test vault; no vault is selected by default on this platform",
  );

  if (isMac) {
    assert.equal(
      resolveForPlatform(vault, platform),
      resolveForPlatform(MACOS_TEST_VAULT, platform),
      `macOS native tests are restricted to the isolated test vault at ${MACOS_TEST_VAULT}`,
    );
  }

  // Current Obsidian CLI selects by vault name; IDs are not accepted by
  // `vault=<name>`. An explicitly requested active-vault mode omits the
  // selector and relies on an exact runtime path guard before every test call.
  const vaultSelector = useActiveVault
    ? ""
    : env.OBSIDIAN_VAULT_NAME || env.OBSIDIAN_VAULT_ID ||
      (isWindows ? WINDOWS_TEST_VAULT_NAME : "");
  assert.ok(
    useActiveVault || vaultSelector,
    "Set OBSIDIAN_VAULT_ID (or OBSIDIAN_VAULT_NAME), or explicitly set OBSIDIAN_ACTIVE_VAULT=1",
  );
  assert.ok(
    !useActiveVault || (!env.OBSIDIAN_VAULT_NAME && !env.OBSIDIAN_VAULT_ID),
    "Do not combine OBSIDIAN_ACTIVE_VAULT=1 with a named Vault selector",
  );

  const cli = env.PDF_READER_OBSIDIAN_CLI ||
    (isWindows ? WINDOWS_OBSIDIAN_CLI : isMac ? MACOS_OBSIDIAN_CLI : "");
  const cdpUrl = env.PDF_READER_CDP_URL || "";
  assert.ok(
    cli || cdpUrl,
    "Set PDF_READER_OBSIDIAN_CLI or PDF_READER_CDP_URL to a local, isolated Obsidian test instance",
  );

  const configDir = validateConfigDir(
    env.OBSIDIAN_CONFIG_DIR || ".obsidian",
    platform,
  );

  return Object.freeze({
    platform,
    vault: resolveForPlatform(vault, platform),
    vaultSelector,
    useActiveVault,
    cli: cli ? resolveForPlatform(cli, platform) : "",
    cdpUrl,
    configDir,
    pluginId: "pdf-web-reader",
  });
}

export const nativeConfig = loadNativeConfig();

export function nativeIdentityExpression(extra = "") {
  return `JSON.stringify({
    vault: app.vault.adapter.basePath,
    configDir: app.vault.configDir,
    vaultName: app.vault.getName?.() || null,
    ${extra}
  })`;
}

export function assertNativeVaultIdentity(identity, config = nativeConfig) {
  assert.ok(identity && typeof identity === "object", "Vault identity is missing");
  const actualVault = resolveForPlatform(identity.vault || "", config.platform);
  const expectedVault = resolveForPlatform(config.vault, config.platform);
  const fold = config.platform === "win32" ? (value) => value.toLowerCase() : (value) => value;
  assert.equal(
    fold(actualVault),
    fold(expectedVault),
    `CLI opened ${identity.vault}; refusing to use anything except the configured test vault ${config.vault}`,
  );
  assert.equal(
    identity.configDir,
    config.configDir,
    `Obsidian reports configDir ${identity.configDir}; expected ${config.configDir}`,
  );
  return identity;
}

export function assertNativeTestPreflight(preflight, expectedVersion, config = nativeConfig) {
  assertNativeVaultIdentity(preflight, config);
  assert.equal(preflight.pluginEnabled, true, "PDF Web Reader must be enabled for Native acceptance");
  assert.equal(preflight.pluginVersion, expectedVersion, `Expected runtime plugin ${expectedVersion}`);
  assert.equal(preflight.visibility, "visible", "Native acceptance requires a visible Obsidian test Vault window");
  assert.deepEqual(preflight.readerViews, [], "Close all existing Reader tabs before Native acceptance");
  return preflight;
}

export function assertSafeDeploymentPreflight(
  preflight,
  config = nativeConfig,
) {
  assertNativeVaultIdentity(preflight, config);
  assert.equal(
    preflight.pluginEnabled,
    false,
    "Disable PDF Web Reader manually after saving and closing its PDF tabs; deploy will not unload it",
  );
  assert.deepEqual(
    preflight.readerViews,
    [],
    `Save and close every PDF Web Reader tab before deployment; deploy will not save, close, or unload them: ${JSON.stringify(preflight.readerViews)}`,
  );
  return preflight;
}

export function invokeNativeCli(
  args,
  timeout = 20_000,
  config = nativeConfig,
  spawn = spawnSync,
) {
  if (config.cdpUrl) {
    return invokeThroughDirectCdp(args, timeout, config);
  }
  const result = spawn(
    config.cli,
    [...(config.useActiveVault ? [] : [`vault=${config.vaultSelector}`]), ...args],
    {
      encoding: "utf8",
      timeout,
      windowsHide: config.platform === "win32",
      maxBuffer: NATIVE_CLI_MAX_BUFFER,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Obsidian CLI failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

export function nativeCdp(method, params = {}, timeout = 20_000, config = nativeConfig) {
  if (config.cdpUrl) {
    return directCdpRequest(method, params, timeout, config);
  }
  const output = invokeNativeCli(
    ["dev:cdp", `method=${method}`, `params=${JSON.stringify(params)}`],
    timeout,
    config,
  );
  if (!output) return {};
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  assert.ok(start >= 0 && end >= start, `Obsidian CDP returned invalid JSON for ${method}: ${output}`);
  return JSON.parse(output.slice(start, end + 1));
}

export function nativeEvalJson(expression, timeout = 30_000, config = nativeConfig) {
  const response = nativeCdp(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    },
    timeout,
    config,
  );
  if (response.exceptionDetails) {
    throw new Error(
      `Obsidian Runtime.evaluate failed: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text || JSON.stringify(response.exceptionDetails)}`,
    );
  }
  const value = response.result?.value;
  assert.equal(typeof value, "string", `Expected JSON text from Obsidian, got ${typeof value}`);
  return JSON.parse(value);
}

function directCdpRequest(method, params, timeout, config) {
  const transport = fileURLToPath(
    new URL("./native-cdp-transport.mjs", import.meta.url),
  );
  const child = spawnSync(
    process.execPath,
    [
      transport,
      config.cdpUrl,
      config.vault,
      config.configDir,
      config.vaultSelector,
      method,
      JSON.stringify(params),
      String(timeout),
    ],
    {
      encoding: "utf8",
      timeout: timeout + 5_000,
      windowsHide: config.platform === "win32",
      maxBuffer: NATIVE_CLI_MAX_BUFFER,
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `Isolated Obsidian CDP failed (${child.status}): ${child.stderr || child.stdout}`,
    );
  }
  try {
    return JSON.parse(child.stdout.trim());
  } catch (error) {
    throw new Error(
      `Isolated Obsidian CDP returned invalid JSON: ${child.stdout}`,
      { cause: error },
    );
  }
}

function invokeThroughDirectCdp(args, timeout, config) {
  if (args[0] === "dev:cdp") {
    const method = args.find((argument) => argument.startsWith("method="))?.slice(7);
    const rawParams = args.find((argument) => argument.startsWith("params="))?.slice(7) || "{}";
    assert.ok(method, "dev:cdp requires an explicit method");
    return JSON.stringify(
      directCdpRequest(method, JSON.parse(rawParams), timeout, config),
    );
  }

  if (args[0] === "version") {
    const response = directCdpRequest(
      "Runtime.evaluate",
      {
        expression: "JSON.stringify(window.app?.version || window.app?.getVersion?.() || null)",
        returnByValue: true,
        awaitPromise: true,
      },
      timeout,
      config,
    );
    if (response.exceptionDetails) {
      throw new Error(`Could not read the isolated Obsidian version: ${JSON.stringify(response.exceptionDetails)}`);
    }
    return String(response.result?.value ?? "unknown");
  }

  if (["plugin:enable", "plugin:disable", "plugin:reload"].includes(args[0])) {
    const pluginId = args.find((argument) => argument.startsWith("id="))?.slice(3);
    assert.equal(
      pluginId,
      config.pluginId,
      `Direct CDP only permits plugin commands for ${config.pluginId}`,
    );
    const action = args[0].slice("plugin:".length);
    const expression = `(async () => {
      const manager = app.plugins;
      const id = ${JSON.stringify(pluginId)};
      const enabled = manager.enabledPlugins.has(id);
      const call = async (preferred, fallback) => {
        const method = manager[preferred] || manager[fallback];
        if (typeof method !== 'function') throw new Error('Obsidian plugin manager does not expose ' + preferred);
        await method.call(manager, id);
      };
      if (${JSON.stringify(action)} === 'enable') {
        if (!manager.enabledPlugins.has(id)) await call('enablePluginAndSave', 'enablePlugin');
      } else if (${JSON.stringify(action)} === 'disable') {
        if (manager.enabledPlugins.has(id)) await call('disablePluginAndSave', 'disablePlugin');
      } else if (enabled) {
        await call('disablePluginAndSave', 'disablePlugin');
        await call('enablePluginAndSave', 'enablePlugin');
      }
      return JSON.stringify({ enabled: manager.enabledPlugins.has(id) });
    })()`;
    const response = directCdpRequest(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeout,
      config,
    );
    if (response.exceptionDetails) {
      throw new Error(`Could not ${action} ${pluginId} in the isolated Obsidian instance: ${response.exceptionDetails.exception?.description || response.exceptionDetails.text}`);
    }
    return String(response.result?.value ?? "{}");
  }

  throw new Error(
    `With PDF_READER_CDP_URL set, native tooling only supports dev:cdp, version, and scoped PDF Web Reader plugin enable/disable/reload commands; received ${args[0]}`,
  );
}
