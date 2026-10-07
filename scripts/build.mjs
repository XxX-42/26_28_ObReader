import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVendorHashes } from "./hash-vendor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginSource = path.join(root, "plugin");
const vendor = path.join(root, "vendor", "pdfjs-generic-legacy");
const adapters = path.join(root, "viewer-adapter");
const distParent = path.join(root, "dist");
const output = path.join(distParent, "pdf-web-reader");

async function requireFile(file) {
  try {
    await readFile(file);
  } catch {
    throw new Error(
      `Required packaging input is missing: ${path.relative(root, file)}`,
    );
  }
}

async function verifyViewer(viewerRoot) {
  const htmlPath = path.join(viewerRoot, "web", "viewer.html");
  const jsPath = path.join(viewerRoot, "web", "viewer.mjs");
  const html = await readFile(htmlPath, "utf8");
  const js = await readFile(jsPath, "utf8");

  for (const id of [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
  ]) {
    assert.ok(html.includes(id), `Viewer is missing toolbar control ${id}`);
  }
  assert.match(
    js,
    /AnnotationEditorType\.UNDERLINE,\s*AnnotationEditorType\.SQUARE,\s*AnnotationEditorType\.HIGHLIGHT,\s*AnnotationEditorType\.INK,\s*AnnotationEditorType\.FREETEXT/,
    "Viewer shortcut map does not match 1–5",
  );
  for (const file of [
    "build/pdf.mjs",
    "build/pdf.worker.mjs",
    "build/pdf.sandbox.mjs",
    "web/cmaps",
    "web/iccs",
    "web/images",
    "web/locale",
    "web/standard_fonts",
    "web/wasm",
  ]) {
    const input = path.join(viewerRoot, file);
    try {
      await (await import("node:fs/promises")).access(input);
    } catch {
      throw new Error(`Viewer runtime resource is missing: ${file}`);
    }
  }
}

for (const file of ["main.js", "manifest.json", "styles.css"].map((name) =>
  path.join(pluginSource, name),
)) {
  await requireFile(file);
}
for (const file of [
  path.join(vendor, "LICENSE"),
  path.join(vendor, "build"),
  path.join(vendor, "web"),
  path.join(adapters, "obsidian-bridge.js"),
  path.join(adapters, "bridge.css"),
]) {
  try {
    await (await import("node:fs/promises")).access(file);
  } catch {
    throw new Error(
      `Required packaging input is missing: ${path.relative(root, file)}`,
    );
  }
}

const manifest = JSON.parse(
  await readFile(path.join(pluginSource, "manifest.json"), "utf8"),
);
assert.equal(manifest.id, "pdf-web-reader", "Unexpected plugin ID");
assert.equal(manifest.isDesktopOnly, true, "Plugin must be desktop-only");
const vendorFileCount = await verifyVendorHashes();

// Remove only this script's generated, fixed output folder.
assert.equal(path.dirname(output), distParent);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const name of ["main.js", "manifest.json", "styles.css"]) {
  await cp(path.join(pluginSource, name), path.join(output, name));
}

const viewerRoot = path.join(output, "viewer");
await mkdir(viewerRoot, { recursive: true });
await cp(path.join(vendor, "build"), path.join(viewerRoot, "build"), {
  recursive: true,
});
await cp(path.join(vendor, "web"), path.join(viewerRoot, "web"), {
  recursive: true,
});
await cp(path.join(vendor, "LICENSE"), path.join(viewerRoot, "LICENSE"));
await cp(
  path.join(adapters, "obsidian-bridge.js"),
  path.join(viewerRoot, "web", "obsidian-bridge.js"),
);
await cp(
  path.join(adapters, "bridge.css"),
  path.join(viewerRoot, "web", "bridge.css"),
);

await verifyViewer(viewerRoot);
await writeFile(
  path.join(output, "build-info.json"),
  `${JSON.stringify(
    {
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      pdfjsForkCommit: "c80e5a952",
      sourceBranch: "windows",
      artifact: "vendor/pdfjs-generic-legacy",
      vendorFileCount,
    },
    null,
    2,
  )}\n`,
);
console.log(`Built ${path.relative(root, output)}`);
