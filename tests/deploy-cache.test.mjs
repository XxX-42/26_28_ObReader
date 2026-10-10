import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("deployment preserves asset URLs used by already open Viewer frames", async () => {
  // Deployment uses an atomic rename into the repository backup directory.
  // Keep this isolated fixture on the same volume as that directory.
  await mkdir(path.join(root, ".deploy-backups"), { recursive: true });
  const vault = await mkdtemp(path.join(root, ".deploy-backups", "test-vault-"));
  try {
    const plugin = path.join(vault, ".obsidian", "plugins", "pdf-web-reader");
    const cacheFile = path.join(
      plugin,
      ".asset-cache",
      "old-version",
      "web",
      "images",
      "icon.svg",
    );
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(
      path.join(plugin, "manifest.json"),
      JSON.stringify({ id: "pdf-web-reader" }),
    );
    await writeFile(cacheFile, "<svg/>");
    const result = spawnSync(process.execPath, ["scripts/deploy.mjs"], {
      cwd: root,
      env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(cacheFile, "utf8"), "<svg/>");
    assert.equal(
      await readFile(path.join(plugin, "styles.css"), "utf8"),
      await readFile(
        path.join(root, "dist", "pdf-web-reader", "styles.css"),
        "utf8",
      ),
    );
  } finally {
    await rm(vault, { recursive: true, force: true });
  }
});
