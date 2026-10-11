import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSafeDeploymentPreflight,
  nativeConfig,
  nativeEvalJson,
  nativeIdentityExpression,
} from "../tests/native-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist", "pdf-web-reader");
const { vault, configDir } = nativeConfig;
const configPath = path.join(vault, configDir);
const pluginsDir = path.join(configPath, "plugins");
const target = path.join(configPath, "plugins", nativeConfig.pluginId);
const backupRoot = path.join(root, ".deploy-backups");

const resolvedVault = path.resolve(vault);
const resolvedConfig = path.resolve(configPath);
const resolvedPlugins = path.resolve(resolvedConfig, "plugins");
const resolvedTarget = path.resolve(resolvedPlugins, nativeConfig.pluginId);
const isWithin = (base, candidate) => {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..");
};
assert.ok(resolvedConfig !== resolvedVault && isWithin(resolvedVault, resolvedConfig));
assert.ok(isWithin(resolvedConfig, resolvedPlugins));
assert.equal(path.resolve(pluginsDir), resolvedPlugins);
assert.equal(target, resolvedTarget, "Deployment target path is unexpected");

await stat(source).catch(() => {
  throw new Error("Build output is missing. Run `npm run build` first.");
});
const releaseEntries = await readdir(source, { withFileTypes: true });
assert.deepEqual(
  releaseEntries.map((entry) => entry.name).sort(),
  ["main.js", "manifest.json", "styles.css"],
  "Refusing to deploy a package that is not exactly the three community release assets",
);
assert.ok(
  releaseEntries.every((entry) => entry.isFile()),
  "The community release output must not include runtime subdirectories",
);
const vaultMetadata = await lstat(vault).catch(() => {
  throw new Error(`Obsidian test vault does not exist: ${vault}`);
});
assert.ok(vaultMetadata.isDirectory() && !vaultMetadata.isSymbolicLink());
const actualVaultPath = await realpath(vault);
assert.equal(actualVaultPath, resolvedVault, "Test vault must not resolve through a symlink");
const configMetadata = await lstat(configPath).catch(() => {
  throw new Error(`Obsidian config directory does not exist: ${configPath}`);
});
assert.ok(configMetadata.isDirectory() && !configMetadata.isSymbolicLink());
assert.ok(isWithin(actualVaultPath, await realpath(configPath)));
const manifest = JSON.parse(
  await readFile(path.join(source, "manifest.json"), "utf8"),
);
assert.equal(manifest.id, nativeConfig.pluginId);

const preflight = nativeEvalJson(nativeIdentityExpression(`
  pluginEnabled: app.plugins.enabledPlugins.has(${JSON.stringify(nativeConfig.pluginId)}),
  readerViews: (() => {
    const rows = [];
    app.workspace.iterateAllLeaves(leaf => {
      if (leaf.view?.getViewType?.() === 'pdf-web-reader-view') {
        rows.push({
          path: leaf.view.requestedPath || leaf.view.file?.path || null,
          saving: !!leaf.view.saving,
          pending: !!leaf.view.pendingBytes,
        });
      }
    });
    return rows;
  })(),
`));
assertSafeDeploymentPreflight(preflight);

const pluginsMetadata = await lstat(pluginsDir).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (pluginsMetadata) {
  assert.ok(
    pluginsMetadata.isDirectory() && !pluginsMetadata.isSymbolicLink(),
    `Refusing to deploy through a non-directory or symlink plugins folder: ${pluginsDir}`,
  );
} else {
  await mkdir(pluginsDir);
}
const backupMetadata = await lstat(backupRoot).catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (backupMetadata) {
  assert.ok(
    backupMetadata.isDirectory() && !backupMetadata.isSymbolicLink(),
    `Refusing to write deployment backups through a non-directory or symlink: ${backupRoot}`,
  );
}
if (!backupMetadata) await mkdir(backupRoot);
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const staging = path.join(pluginsDir, `.pdf-web-reader-staging-${process.pid}`);
const backup = path.join(backupRoot, stamp, "pdf-web-reader");
await lstat(staging).then(
  () => {
    throw new Error(`Refusing to reuse a pre-existing deployment staging path: ${staging}`);
  },
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
let movedExisting = false;

try {
  await cp(source, staging, { recursive: true });
  let targetExists = false;
  try {
    const targetInfo = await lstat(target);
    if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace a non-directory plugin target: ${target}`,
      );
    }
    targetExists = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (targetExists) {
    const oldManifest = JSON.parse(
      await readFile(path.join(target, "manifest.json"), "utf8"),
    );
    if (oldManifest.id !== manifest.id) {
      throw new Error(`Refusing to replace a different plugin at ${target}`);
    }
    await mkdir(path.dirname(backup), { recursive: true });
    const backupParent = await lstat(path.dirname(backup));
    if (!backupParent.isDirectory() || backupParent.isSymbolicLink()) {
      throw new Error(`Refusing to back up through a non-directory or symlink: ${path.dirname(backup)}`);
    }
    await lstat(backup).then(
      () => {
        throw new Error(`Refusing to overwrite a pre-existing deployment backup: ${backup}`);
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    await rename(target, backup);
    movedExisting = true;
  }
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}

try {
  await rename(staging, target);
} catch (error) {
  if (movedExisting) {
    await rename(backup, target);
  }
  await rm(staging, { recursive: true, force: true });
  throw error;
}

console.log(`Installed plugin to ${target}`);
if (movedExisting) {
  console.log(
    `Previous plugin backed up outside Obsidian's plugin scan: ${backup}`,
  );
}
