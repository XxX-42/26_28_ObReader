import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyVendorHashes } from "./hash-vendor.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginSource = path.join(root, "plugin");
const vendor = path.join(root, "vendor", "pdfjs-generic-legacy");
const adapters = path.join(root, "viewer-adapter");
const output = path.join(root, "dist", "pdf-web-reader");
const assetBundleId = "pdfjs-full-viewer-5.7.192-3f4171c02-fork";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function computeContentHash(schema, id, files) {
  const digest = createHash("sha256");
  digest.update(`pdf-web-reader-assets\n${schema}\n${id}\n`, "utf8");
  for (const file of files) {
    digest.update(`${file.path}\t${file.size}\t${file.sha256}\n`, "utf8");
  }
  return digest.digest("hex");
}

async function requireFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `Required packaging input is missing: ${path.relative(root, file)}`,
    );
  }
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Unexpected symlink in viewer assets: ${relative}`);
    }
    if (entry.isDirectory()) {
      result.push(...(await listFiles(absolute, relative)));
    } else if (entry.isFile()) {
      result.push({ absolute, path: relative });
    } else {
      throw new Error(`Unexpected viewer asset type: ${relative}`);
    }
  }
  return result;
}

async function verifyViewer() {
  const html = await readFile(path.join(vendor, "web", "viewer.html"), "utf8");
  const js = await readFile(path.join(vendor, "web", "viewer.mjs"), "utf8");
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
    try {
      await access(path.join(vendor, file));
    } catch {
      throw new Error(`Viewer runtime resource is missing: ${file}`);
    }
  }
}

const sourceFiles = ["main.js", "manifest.json", "styles.css"];
for (const name of sourceFiles) {
  await requireFile(path.join(pluginSource, name));
}
for (const file of [
  path.join(vendor, "LICENSE"),
  path.join(vendor, "build"),
  path.join(vendor, "web"),
  path.join(adapters, "obsidian-bridge.js"),
  path.join(adapters, "bridge.css"),
  path.join(pluginSource, "asset-runtime.cjs"),
]) {
  try {
    await access(file);
  } catch {
    throw new Error(
      `Required packaging input is missing: ${path.relative(root, file)}`,
    );
  }
}

const manifest = JSON.parse(
  await readFile(path.join(pluginSource, "manifest.json"), "utf8"),
);
const releaseManifest = JSON.parse(
  await readFile(path.join(root, "manifest.json"), "utf8"),
);
const versions = JSON.parse(
  await readFile(path.join(root, "versions.json"), "utf8"),
);
assert.deepEqual(
  releaseManifest,
  manifest,
  "Root and plugin manifests must be identical for a community release",
);
assert.equal(
  versions[manifest.version],
  manifest.minAppVersion,
  "versions.json must match this plugin version and minimum Obsidian version",
);
assert.equal(manifest.id, "pdf-web-reader", "Unexpected plugin ID");
assert.equal(manifest.isDesktopOnly, true, "Plugin must be desktop-only");
const vendorFileCount = await verifyVendorHashes();
await verifyViewer();

const runtimeInputs = [
  ...(await listFiles(path.join(vendor, "build"), "build")),
  ...(await listFiles(path.join(vendor, "web"), "web")),
  { absolute: path.join(vendor, "LICENSE"), path: "LICENSE" },
  {
    absolute: path.join(adapters, "obsidian-bridge.js"),
    path: "web/obsidian-bridge.js",
  },
  {
    absolute: path.join(adapters, "bridge.css"),
    path: "web/bridge.css",
  },
].sort((left, right) =>
  left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
);

for (let index = 1; index < runtimeInputs.length; index += 1) {
  assert.notEqual(
    runtimeInputs[index - 1].path,
    runtimeInputs[index].path,
    `Duplicate viewer asset path: ${runtimeInputs[index].path}`,
  );
}

const schema = 1;
const files = [];
for (const input of runtimeInputs) {
  const data = await readFile(input.absolute);
  const compressed = gzipSync(data, { level: 9, mtime: 0 });
  // Normalize the RFC 1952 timestamp and OS fields across Node/platform builds.
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  files.push({
    path: input.path,
    size: data.byteLength,
    sha256: sha256(data),
    gzipBase64: compressed.toString("base64"),
  });
}
const payload = {
  schema,
  id: assetBundleId,
  contentHash: computeContentHash(schema, assetBundleId, files),
  files,
};

const requireMarker =
  /\/\* BUILD:ASSET_RUNTIME_REQUIRE \*\/\s*const\s*\{\s*ensureViewerAssets,?\s*\}\s*=\s*require\((["'])\.\/asset-runtime\.cjs\1\);/s;
const payloadMarker =
  "/* BUILD:VIEWER_ASSET_PAYLOAD */ const VIEWER_ASSET_PAYLOAD = null;";
const sourceMain = await readFile(path.join(pluginSource, "main.js"), "utf8");
assert.equal(
  [...sourceMain.matchAll(new RegExp(requireMarker.source, "gs"))].length,
  1,
  "Expected exactly one asset-runtime build marker in plugin/main.js",
);
assert.equal(
  sourceMain.split(payloadMarker).length - 1,
  1,
  "Expected exactly one viewer-payload build marker in plugin/main.js",
);
const helperSource = await readFile(
  path.join(pluginSource, "asset-runtime.cjs"),
  "utf8",
);
const inlinedHelper =
  "const { ensureViewerAssets } = (() => {\n" +
  "  const module = { exports: {} };\n" +
  "  const exports = module.exports;\n" +
  "  (function (module, exports, require) {\n" +
  helperSource
    .split("\n")
    .map((line) => (line ? `    ${line}` : ""))
    .join("\n") +
  "\n  })(module, exports, require);\n" +
  "  return module.exports;\n" +
  "})();";
const bundledMain = sourceMain
  .replace(requireMarker, inlinedHelper)
  .replace(
    payloadMarker,
    `const VIEWER_ASSET_PAYLOAD = ${JSON.stringify(payload)};`,
  );
assert.ok(!bundledMain.includes("./asset-runtime.cjs"));
assert.ok(!bundledMain.includes("VIEWER_ASSET_PAYLOAD = null"));

// This is the only generated output directory touched by the build.
assert.equal(
  output,
  path.join(root, "dist", "pdf-web-reader"),
  "Refusing to write outside the fixed plugin build output",
);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "main.js"), bundledMain);
await writeFile(
  path.join(output, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  path.join(output, "styles.css"),
  await readFile(path.join(pluginSource, "styles.css")),
);

const outputFiles = await listFiles(output);
assert.deepEqual(
  outputFiles.map(({ path: name }) => name).sort(),
  ["main.js", "manifest.json", "styles.css"],
  "A community release must contain exactly main.js, manifest.json and styles.css",
);
console.log(
  `Built ${path.relative(root, output)}: 3 release files, ${files.length} embedded runtime assets, ${vendorFileCount} frozen vendor files verified, payload ${Buffer.byteLength(JSON.stringify(payload))} bytes before release transport compression.`,
);
