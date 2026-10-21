import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Vocabulary shared runtime uses DataAdapter/Web APIs rather than desktop-only dependencies", async () => {
  for (const name of await readdir(path.join(root, "plugin/vocabulary"))) {
    if (!name.endsWith(".cjs")) continue;
    const source = await readFile(path.join(root, "plugin/vocabulary", name), "utf8");
    assert.doesNotMatch(source, /\brequire\s*\(\s*["'](?:node:|fs(?:\/|["'])|path(?:\/|["'])|electron["']|child_process["'])/, name);
    assert.doesNotMatch(source, /\b(?:FileSystemAdapter|ipcRenderer|process\.binding|performance\.memory)\b/, name);
    assert.doesNotMatch(source, /["']\/Users\/|["'][A-Z]:\\/, name);
  }
});

test("PDF lexical matching cannot import Context, Review, History or Dictionary stores", async () => {
  const service = await readFile(path.join(root, "plugin/vocabulary/service.cjs"), "utf8");
  const start = service.indexOf("  async matchPageTokens(");
  const end = service.indexOf("  async getTerm(", start);
  assert.ok(start > 0 && end > start, "the production matching entry point remains covered");
  assert.doesNotMatch(service.slice(start, end), /\b(?:review|context|history|dictionary|readSnapshot|adapter\.(?:read|write))\b/i);
  assert.doesNotMatch(service, /require\([^)]*(?:review-service|context-service|history|dictionary)\.cjs/);
  const host = await readFile(path.join(root, "plugin/main.js"), "utf8");
  const query = host.slice(host.indexOf('if (message.type === "vocab-page-query")'), host.indexOf('if (message.type === "vocab-token-tap")'));
  assert.ok(query.includes("matchPageTokens"));
  assert.doesNotMatch(query, /getVocabulary(?:Dictionary|Workbench|Review|Context)|lookup\(/);
  for (const module of ["controller.js", "page-scanner.js", "canvas-overlay.js", "phrase-matcher.js"]) {
    const source = await readFile(path.join(root, "viewer-adapter/vocabulary", module), "utf8");
    assert.doesNotMatch(source, /(?:from|require\()[^\n]*(?:review-service|context-service|history\.cjs|dictionary\.cjs)/, module);
  }
});

test("frozen subsystems retain baseline bytes except explicitly reviewed read-mode, deployed wheel and retention patches", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "docs/vocabulary-v2/frozen-subsystems.sha256.json"), "utf8"));
  assert.equal(Object.keys(manifest.sha256).length, 441);
  assert.deepEqual(Object.keys(manifest.reviewedUpstreamOverrides?.sha256 || {}).sort(), [
    "viewer-adapter/input/annotation-controller.js",
    "viewer-adapter/input/ios-direct-manipulation-controller.js",
  ]);
  assert.deepEqual(Object.keys(manifest.reviewedDeletionRetentionOverrides?.sha256 || {}).sort(), [
    "plugin/pdf-annotation-host.cjs", "plugin/storage/jsonl-checkpoint.cjs", "plugin/storage/wal-annotation-store.cjs",
    "vendor/pdfjs-generic-legacy/PROVENANCE.md", "vendor/pdfjs-generic-legacy/SHA256SUMS.json",
    "vendor/pdfjs-generic-legacy/web/viewer.css", "vendor/pdfjs-generic-legacy/web/viewer.mjs",
  ]);
  for (const [file, expected] of Object.entries(manifest.sha256)) {
    const actual = createHash("sha256").update(await readFile(path.join(root, file))).digest("hex");
    const reviewed = manifest.reviewedDeletionRetentionOverrides?.sha256?.[file] || manifest.reviewedUpstreamOverrides?.sha256?.[file];
    assert.equal(actual, reviewed || expected, `frozen subsystem changed outside the reviewed upstream change: ${file}`);
  }
});
