import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeConfig, nativeEvalJson, invokeNativeCli, assertNativeVaultIdentity } from "../tests/native-config.mjs";

// Deliberately restricted to the designated Windows TEST vault. Copy only the
// three release files; leave caches, recovery files and every sidecar intact.
assert.equal(nativeConfig.vault.toLowerCase(), String.raw`D:\Documents\Obsidian\测试插件`.toLowerCase());
assert.equal(nativeConfig.vaultSelector, "06f5d50d319c56d4");
const root = path.resolve(import.meta.dirname, "..");
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const backup = path.join(root, ".deploy-backups", `test-sidecar-${stamp}`);
const target = path.join(nativeConfig.vault, ".obsidian/plugins/pdf-web-reader");
const remote = String.raw`D:\Documents\Obsidian\远程仓库1\.obsidian\plugins\pdf-web-reader`;
const files = ["main.js", "manifest.json", "styles.css"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hashes = async dir => Object.fromEntries(await Promise.all(files.map(async name => [name, sha(await readFile(path.join(dir, name)))])));
const report = { backup, target, remoteBefore: await hashes(remote), testBefore: await hashes(target) };
const preflight = nativeEvalJson(`JSON.stringify({vault:app.vault.adapter.basePath,configDir:app.vault.configDir,version:app.plugins.plugins['pdf-web-reader']?.manifest.version,views:[...app.plugins.plugins['pdf-web-reader'].views].map(v=>({path:v.requestedPath,pending:v.pendingSaves,revision:v.currentRevision,confirmed:v.confirmedRevision,dirty:!!v.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.()}))})`);
assertNativeVaultIdentity(preflight);
assert.ok(preflight.views.every(v => !v.pending && !v.dirty && v.revision === v.confirmed), "Refusing reload with any pending or unsaved Reader");
report.preflight = preflight;
await mkdir(backup, { recursive: true });
for (const name of files) await copyFile(path.join(target, name), path.join(backup, name));
// Unload only after the clean-state check. No Reader is saved or discarded.
nativeEvalJson(`(async()=>{await app.plugins.disablePlugin('pdf-web-reader');return JSON.stringify({unloaded:!app.plugins.plugins['pdf-web-reader']});})()`);
try {
  for (const name of files) await copyFile(path.join(root, "dist/pdf-web-reader", name), path.join(target, name));
  report.testAfter = await hashes(target);
  assert.deepEqual(report.testAfter, await hashes(path.join(root, "dist/pdf-web-reader")));
} catch (error) {
  // Restore only the three known files from our verified backup.
  for (const name of files) await copyFile(path.join(backup, name), path.join(target, name));
  throw error;
} finally {
  invokeNativeCli(["plugin:reload", "id=pdf-web-reader"]);
}
report.runtime = nativeEvalJson(`JSON.stringify({vault:app.vault.adapter.basePath,configDir:app.vault.configDir,enabled:app.plugins.enabledPlugins.has('pdf-web-reader'),version:app.plugins.plugins['pdf-web-reader']?.manifest.version})`);
assertNativeVaultIdentity(report.runtime);
assert.equal(report.runtime.version, "0.7.1");
assert.equal(report.runtime.enabled, true);
report.remoteAfter = await hashes(remote);
assert.deepEqual(report.remoteAfter, report.remoteBefore, "Remote vault triplet must remain byte-identical");
await writeFile(path.join(backup, "deployment-evidence.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
