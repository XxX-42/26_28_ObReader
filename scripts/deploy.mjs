import assert from "node:assert/strict";
import { cp, lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist", "pdf-web-reader");
const vault =
  process.env.OBSIDIAN_VAULT_PATH || "D:\\Documents\\Obsidian\\测试插件";
const configDir = path.join(vault, ".obsidian");
const pluginsDir = path.join(configDir, "plugins");
const target = path.join(pluginsDir, "pdf-web-reader");
const backupRoot = path.join(root, ".deploy-backups");

const resolvedVault = path.resolve(vault);
const resolvedConfig = path.resolve(resolvedVault, ".obsidian");
const resolvedPlugins = path.resolve(resolvedConfig, "plugins");
const resolvedTarget = path.resolve(resolvedPlugins, "pdf-web-reader");
assert.equal(
  configDir,
  resolvedConfig,
  "Vault path must resolve to its .obsidian folder",
);
assert.equal(
  pluginsDir,
  resolvedPlugins,
  "Plugin path must remain inside this vault",
);
assert.equal(target, resolvedTarget, "Deployment target path is unexpected");

await stat(source).catch(() => {
  throw new Error("Build output is missing. Run `npm run build` first.");
});
await stat(configDir).catch(() => {
  throw new Error(`Obsidian config directory does not exist: ${configDir}`);
});
const manifest = JSON.parse(
  await readFile(path.join(source, "manifest.json"), "utf8"),
);
assert.equal(manifest.id, "pdf-web-reader");

await mkdir(pluginsDir, { recursive: true });
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replaceAll(".", "-");
const staging = path.join(pluginsDir, `.pdf-web-reader-staging-${process.pid}`);
const backup = path.join(backupRoot, stamp, "pdf-web-reader");
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
