import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { build as buildBundle } from "esbuild";
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
const assetBundleId = "pdfjs-full-viewer-5.7.192-3f4171c02-fork-ink-session-guard-0.5.19-highlight-row-collision-0.12.1";
const bundledRuntimeFileCount = 406;
const inputRuntimeFiles = [
  "input/interaction-intent.js",
  "input/interaction-mode.js",
  "input/viewport-controller.js",
  "input/ios-direct-manipulation-controller.js",
  "input/text-selection-controller.js",
  "input/backlink-interaction-controller.js",
  "input/annotation-controller.js",
  "input/desktop-input-policy.js",
  "input/ios-input-policy.js",
  "input/input-router.js",
  "input/annotation-tool-colors.js",
  "input/tool-wheel-color-controller.js",
];

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
  path.join(adapters, "vocabulary", "runtime-entry.js"),
  ...inputRuntimeFiles.map((file) => path.join(adapters, file)),
  path.join(pluginSource, "asset-runtime.cjs"),
  path.join(pluginSource, "pdf-merge-core.cjs"),
  path.join(pluginSource, "pdf-merge-worker.mjs"),
  path.join(pluginSource, "pdf-merge-client.cjs"),
  path.join(pluginSource, "pdf-sync-host.cjs"),
  path.join(pluginSource, "pdf-hash-runtime.cjs"),
  path.join(pluginSource, "reader-anchor-store.cjs"),
  path.join(pluginSource, "reader-backlink-index.cjs"),
  path.join(pluginSource, "vocabulary", "service.cjs"),
  path.join(pluginSource, "vocabulary", "dictionary.cjs"),
  path.join(pluginSource, "vocabulary", "modals.cjs"),
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
assert.equal(manifest.isDesktopOnly, false, "Plugin must support desktop and mobile");
assert.equal(manifest.minAppVersion, "1.14.4");
const vendorFileCount = await verifyVendorHashes();
assert.equal(vendorFileCount, 402, "The frozen PDF.js vendor set changed");
await verifyViewer();

const pdfLibPackage = JSON.parse(
  await readFile(path.join(root, "node_modules", "pdf-lib", "package.json"), "utf8"),
);
assert.equal(pdfLibPackage.version, "1.17.1", "Unexpected pinned pdf-lib version");
const pdfLibLicense = await readFile(path.join(root, "node_modules", "pdf-lib", "LICENSE.md"), "utf8");

async function readBundledDependencyLicense(packageName, candidates) {
  const packageDir = path.join(root, "node_modules", ...packageName.split("/"));
  const metadata = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  let licenseFile = null;
  for (const candidate of candidates) {
    try {
      licenseFile = path.join(packageDir, candidate);
      await access(licenseFile);
      break;
    } catch {
      licenseFile = null;
    }
  }
  if (!licenseFile) throw new Error(`Missing license text for bundled dependency ${packageName}`);
  const text = await readFile(licenseFile, "utf8");
  return `\n\n===== ${packageName} ${metadata.version} (${metadata.license}) =====\n\n${text.trim()}\n`;
}

const mergeWorkerLicense = [
  "pdf-lib: PDF modification and copying",
  await readBundledDependencyLicense("pdf-lib", ["LICENSE.md", "LICENSE"]),
  await readBundledDependencyLicense("@pdf-lib/standard-fonts", ["LICENSE.md", "LICENSE"]),
  await readBundledDependencyLicense("@pdf-lib/upng", ["LICENSE", "LICENSE.md"]),
  await readBundledDependencyLicense("pako", ["LICENSE", "LICENSE.md"]),
  // pako's /lib/zlib files are distributed under the separate Zlib license;
  // the bundled worker contains this code through pdf-lib's compression path.
  "\n\n===== pako /lib/zlib Zlib notice =====\n\n" +
    "Copyright (C) 1995-2013 Jean-loup Gailly and Mark Adler\n" +
    "Copyright (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin\n\n" +
    "This software is provided 'as-is', without any express or implied\n" +
    "warranty. In no event will the authors be held liable for any damages\n" +
    "arising from the use of this software.\n\n" +
    "Permission is granted to anyone to use this software for any purpose,\n" +
    "including commercial applications, and to alter it and redistribute it\n" +
    "freely, subject to the following restrictions:\n\n" +
    "1. The origin of this software must not be misrepresented; you must not\n" +
    "   claim that you wrote the original software. If you use this software\n" +
    "   in a product, an acknowledgment in the product documentation would be\n" +
    "   appreciated but is not required.\n" +
    "2. Altered source versions must be plainly marked as such, and must not be\n" +
    "   misrepresented as being the original software.\n" +
    "3. This notice may not be removed or altered from any source distribution.\n",
  await readBundledDependencyLicense("tslib", ["LICENSE.txt", "LICENSE"]),
  await readBundledDependencyLicense("@noble/hashes", ["LICENSE", "LICENSE.md"]),
  await readBundledDependencyLicense("xxhash-wasm", ["LICENSE.md", "LICENSE"]),
  await readBundledDependencyLicense("dexie", ["LICENSE", "LICENSE.md"]),
  "\n\n===== dexie NOTICE =====\n\n" +
    await readFile(path.join(root, "node_modules", "dexie", "NOTICE"), "utf8"),
].join("");

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

const mergeWorkerBundle = await buildBundle({
  entryPoints: [path.join(pluginSource, "pdf-merge-worker.mjs")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  legalComments: "inline",
  metafile: true,
  banner: {
    js: `/* pdf-lib ${pdfLibPackage.version} MIT License\n${pdfLibLicense.replaceAll("*/", "* /")}*/`,
  },
  write: false,
});
assert.equal(mergeWorkerBundle.outputFiles.length, 1);
for (const packageName of [
  "pdf-lib",
  "@pdf-lib/standard-fonts",
  "@pdf-lib/upng",
  "pako",
  "tslib",
  "@noble/hashes",
  "xxhash-wasm",
]) {
  assert.ok(
    Object.keys(mergeWorkerBundle.metafile.inputs).some((input) =>
      (`/${input}`).includes(`/node_modules/${packageName}/`),
    ),
    `Expected the merge worker to bundle ${packageName}`,
  );
}
runtimeInputs.push({
  bytes: Buffer.from(mergeWorkerBundle.outputFiles[0].contents),
  path: "web/pdf-merge-worker.js",
});
runtimeInputs.push({
  bytes: Buffer.from(mergeWorkerLicense, "utf8"),
  path: "web/pdf-merge-worker-LICENSE.txt",
});
runtimeInputs.sort((left, right) =>
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
const vocabularyRuntimeBundle = await buildBundle({
  entryPoints: [path.join(adapters, "vocabulary", "runtime-entry.js")],
  bundle: true,
  format: "iife",
  globalName: "PdfReaderVocabularyRuntimeModule",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  write: false,
});
assert.equal(vocabularyRuntimeBundle.outputFiles.length, 1);
const inputRuntimeSource = (await Promise.all(
  inputRuntimeFiles.map((file) => readFile(path.join(adapters, file), "utf8")),
)).join("\n") + `\n${vocabularyRuntimeBundle.outputFiles[0].text}`;
for (const input of runtimeInputs) {
  let data = input.bytes || await readFile(input.absolute);
  if (input.path === "web/obsidian-bridge.js") {
    data = Buffer.from(`${inputRuntimeSource}\n${data.toString("utf8")}`);
  }
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
assert.equal(
  files.length,
  bundledRuntimeFileCount,
  "The frozen viewer, bridge, merge worker, and required licenses must contain 406 files",
);

const requireMarker =
  /\/\* BUILD:ASSET_RUNTIME_REQUIRE \*\/\s*const\s*\{\s*ensureViewerAssets\s*,\s*(?:sha256Bytes\s*,?\s*)?\}\s*=\s*require\((["'])\.\/asset-runtime\.cjs\1\);/s;
const payloadMarker =
  "/* BUILD:VIEWER_ASSET_PAYLOAD */ const VIEWER_ASSET_PAYLOAD = null;";
const annotationHostMarker =
  /\/\* BUILD:PDF_ANNOTATION_HOST_REQUIRE \*\/\s*const\s*\{\s*createPdfAnnotationHost\s*\}\s*=\s*require\((['"])\.\/pdf-annotation-host\.cjs\1\);/s;
const vocabularyServiceMarker =
  /\/\* BUILD:VOCABULARY_SERVICE_REQUIRE \*\/\s*const\s*\{\s*VocabularyService\s*,\s*normalizeTermKey\s*:\s*normalizeVocabularyTermKey\s*,?\s*(?:VOCABULARY_PATH\s*,?\s*)?\}\s*=\s*require\((['"])\.\/vocabulary\/service\.cjs\1\);/s;
const vocabularyCanonicalMarker =
  /\/\* BUILD:VOCABULARY_CANONICAL_REQUIRE \*\/\s*const\s*\{\s*canonicalHash\s*\}\s*=\s*require\((['"])\.\/vocabulary\/canonical\.cjs\1\);/s;
const vocabularyWorkspaceMarker = /\/\* BUILD:VOCABULARY_WORKSPACE_REQUIRE \*\/\s*const\s*\{[^}]+\}\s*=\s*require\((['"])\.\/vocabulary\/workspace\.cjs\1\);/s;
const vocabularyWorkbenchMarker = /\/\* BUILD:VOCABULARY_WORKBENCH_REQUIRE \*\/\s*const\s*\{\s*createVocabularyWorkbench\s*\}\s*=\s*require\((['"])\.\/vocabulary\/workbench\.cjs\1\);/s;
const learningHostMarker = /\/\* BUILD:LEARNING_HOST_REQUIRE \*\/\s*const\s*\{\s*createLearningHost\s*\}\s*=\s*require\((['"])\.\/learning\/host\.cjs\1\);/s;
const semanticServicesMarker = /\/\* BUILD:SEMANTIC_SERVICES_REQUIRE \*\/\s*const\s*\{\s*createAnnotationSidebarService\s*,\s*createBacklinkService\s*\}\s*=\s*require\((['"])\.\/semantic\/services\.cjs\1\);/s;
const vocabularyDictionaryMarker =
  /\/\* BUILD:VOCABULARY_DICTIONARY_REQUIRE \*\/\s*const\s*\{\s*VocabularyDictionary\s*\}\s*=\s*require\((['"])\.\/vocabulary\/dictionary\.cjs\1\);/s;
const vocabularyModalsMarker =
  /\/\* BUILD:VOCABULARY_MODALS_REQUIRE \*\/\s*const\s*\{\s*createVocabularyModals\s*\}\s*=\s*require\((['"])\.\/vocabulary\/modals\.cjs\1\);/s;
const heavyWorkMarker =
  /\/\* BUILD:HEAVY_WORK_REQUIRE \*\/\s*const\s*\{\s*createHeavyWorkCoordinator\s*\}\s*=\s*require\((['"])\.\/heavy-work\.cjs\1\);/s;
const recoveryMarker = /\/\* BUILD:PDF_RECOVERY_REQUIRE \*\/\s*const\s*\{\s*readDeltaRecovery\s*\}\s*=\s*require\((['"])\.\/pdf-recovery-read\.cjs\1\);/s;
const sessionLogMarker = /\/\* BUILD:SESSION_LOG_REQUIRE \*\/\s*const\s*\{\s*createSessionLog\s*\}\s*=\s*require\((['"])\.\/session-log\.cjs\1\);/s;
const readerAnchorStoreMarker = /\/\* BUILD:READER_ANCHOR_STORE_REQUIRE \*\/\s*const\s*\{\s*createReaderAnchorStore\s*,\s*parseReaderLinkFragment\s*,\s*parseReaderLinkDestination\s*,\s*encodeReaderLinkFragment\s*\}\s*=\s*require\((['"])\.\/reader-anchor-store\.cjs\1\);/s;
const readerBacklinkIndexMarker = /\/\* BUILD:READER_BACKLINK_INDEX_REQUIRE \*\/\s*const\s*\{\s*buildReaderBacklinkPageIndex\s*,\s*createReaderBacklinkIndex\s*,\s*normalizePdfRoutePath\s*\}\s*=\s*require\((['"])\.\/reader-backlink-index\.cjs\1\);/s;
const sourceMain = await readFile(path.join(pluginSource, "main.js"), "utf8");
assert.doesNotMatch(sourceMain, /\btraceMethods\s*\(|\b\w+\s*=\s*traceFunction\s*\(|BUILD:HOST_FUNCTION_TRACE/,
  "Production Host methods must not be automatically wrapped for per-call diagnostics");
const hashRuntimeMarker = /\/\* BUILD:PDF_HASH_RUNTIME_REQUIRE \*\/\s*const\s*\{\s*createPdfHashRuntime\s*\}\s*=\s*require\((['"])\.\/pdf-hash-runtime\.cjs\1\);/s;
const mergeClientMarker = /\/\* BUILD:PDF_MERGE_CLIENT_REQUIRE \*\/\s*const\s*\{\s*createPdfMergeClient\s*\}\s*=\s*require\((['"])\.\/pdf-merge-client\.cjs\1\);/s;
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
assert.equal(
  [...sourceMain.matchAll(new RegExp(annotationHostMarker.source, "gs"))].length,
  1,
  "Expected exactly one PDF annotation host build marker in plugin/main.js",
);
assert.equal(
  [...sourceMain.matchAll(new RegExp(vocabularyServiceMarker.source, "gs"))].length,
  1,
  "Expected exactly one vocabulary service build marker in plugin/main.js",
);
assert.equal(
  [...sourceMain.matchAll(new RegExp(vocabularyCanonicalMarker.source, "gs"))].length,
  1,
  "Expected exactly one vocabulary canonical build marker in plugin/main.js",
);
assert.equal(
  [...sourceMain.matchAll(new RegExp(vocabularyDictionaryMarker.source, "gs"))].length,
  1,
  "Expected exactly one offline dictionary build marker in plugin/main.js",
);
assert.equal(
  [...sourceMain.matchAll(new RegExp(vocabularyModalsMarker.source, "gs"))].length,
  1,
  "Expected exactly one vocabulary modals build marker in plugin/main.js",
);
assert.equal(
  [...sourceMain.matchAll(new RegExp(hashRuntimeMarker.source, "gs"))].length,
  1,
  "Expected exactly one PDF hash runtime build marker in plugin/main.js",
);
const noblePackage = JSON.parse(
  await readFile(path.join(root, "node_modules", "@noble", "hashes", "package.json"), "utf8"),
);
assert.equal(noblePackage.version, "1.8.0", "Unexpected @noble/hashes version");
const nobleLicense = await readFile(
  path.join(root, "node_modules", "@noble", "hashes", "LICENSE"),
  "utf8",
);
const runtimeBundle = await buildBundle({
  entryPoints: [path.join(pluginSource, "asset-runtime.cjs")],
  bundle: true,
  format: "iife",
  globalName: "__PDFReaderAssetRuntime",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  banner: {
    js: `/* @noble/hashes ${noblePackage.version} MIT License\n${nobleLicense.replaceAll("*/", "* /")}*/`,
  },
  write: false,
});
assert.equal(runtimeBundle.outputFiles.length, 1);
const inlinedHelper =
  "const { ensureViewerAssets, sha256Bytes } = (() => {\n" +
  runtimeBundle.outputFiles[0].text
    .trimEnd() +
  "\n  return __PDFReaderAssetRuntime;\n})();";
const dictionaryWorkerBundle = await buildBundle({
  entryPoints: [path.join(pluginSource, "vocabulary", "dictionary-worker.cjs")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  legalComments: "inline",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
assert.equal(dictionaryWorkerBundle.outputFiles.length, 1);
async function inlineModule(entry, globalName, exportName) {
  const bundle = await buildBundle({
    entryPoints: [path.join(pluginSource, entry)],
    bundle: true,
    format: "iife",
    globalName,
    platform: "browser",
    target: ["es2022"],
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"',
      __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(dictionaryWorkerBundle.outputFiles[0].text) },
    write: false,
  });
  assert.equal(bundle.outputFiles.length, 1, `Expected one bundle for ${entry}`);
  return `const { ${exportName} } = (() => {\n${bundle.outputFiles[0].text.trimEnd()}\n  return ${globalName};\n})();`;
}
const inlinedAnnotationHost = await inlineModule(
  "pdf-annotation-host.cjs",
  "__PDFReaderAnnotationHost",
  "createPdfAnnotationHost",
);
const inlinedVocabularyService = await inlineModule(
  "vocabulary/service.cjs",
  "__PDFReaderVocabularyService",
  "VocabularyService, normalizeTermKey: normalizeVocabularyTermKey, VOCABULARY_PATH",
);
const inlinedVocabularyCanonical = await inlineModule(
  "vocabulary/canonical.cjs",
  "__PDFReaderVocabularyCanonical",
  "canonicalHash",
);
assert.equal([...sourceMain.matchAll(new RegExp(vocabularyWorkspaceMarker.source, "gs"))].length, 1);
assert.equal([...sourceMain.matchAll(new RegExp(vocabularyWorkbenchMarker.source, "gs"))].length, 1);
const inlinedVocabularyWorkspace = await inlineModule("vocabulary/workspace.cjs", "__PDFReaderVocabularyWorkspace", "createVocabularyRuntime, localVocabularyDeviceId, createContextSourceVerifier, createVocabularyTransfer");
const inlinedVocabularyWorkbench = await inlineModule("vocabulary/workbench.cjs", "__PDFReaderVocabularyWorkbench", "createVocabularyWorkbench");
assert.equal([...sourceMain.matchAll(new RegExp(learningHostMarker.source,'gs'))].length,1);
const inlinedLearningHost = await inlineModule('learning/host.cjs','__PDFReaderLearningHost','createLearningHost');
assert.equal([...sourceMain.matchAll(new RegExp(semanticServicesMarker.source, 'gs'))].length, 1);
const inlinedSemanticServices = await inlineModule('semantic/services.cjs', '__PDFReaderSemanticServices', 'createAnnotationSidebarService, createBacklinkService');
const inlinedVocabularyDictionary = await inlineModule(
  "vocabulary/dictionary.cjs",
  "__PDFReaderVocabularyDictionary",
  "VocabularyDictionary",
);
const inlinedVocabularyModals = await inlineModule(
  "vocabulary/modals.cjs",
  "__PDFReaderVocabularyModals",
  "createVocabularyModals",
);
const inlinedHashRuntime = await inlineModule(
  "pdf-hash-runtime.cjs",
  "__PDFReaderHashRuntime",
  "createPdfHashRuntime",
);
const inlinedMergeClient = await inlineModule(
  "pdf-merge-client.cjs",
  "__PDFReaderMergeClient",
  "createPdfMergeClient",
);
assert.equal([...sourceMain.matchAll(new RegExp(heavyWorkMarker.source, "gs"))].length, 1, "Expected one heavy-work build marker");
const inlinedHeavyWork = await inlineModule("heavy-work.cjs", "__PDFReaderHeavyWork", "createHeavyWorkCoordinator");
assert.equal([...sourceMain.matchAll(new RegExp(recoveryMarker.source, "gs"))].length, 1, "Expected one recovery build marker");
const inlinedRecovery = await inlineModule("pdf-recovery-read.cjs", "__PDFReaderRecovery", "readDeltaRecovery");
assert.equal([...sourceMain.matchAll(new RegExp(sessionLogMarker.source, "gs"))].length, 1);
const inlinedSessionLog = await inlineModule("session-log.cjs", "__PDFReaderSessionLog", "createSessionLog");
assert.equal([...sourceMain.matchAll(new RegExp(readerAnchorStoreMarker.source, "gs"))].length, 1, "Expected one Reader Anchor Store build marker");
const inlinedReaderAnchorStore = await inlineModule("reader-anchor-store.cjs", "__PDFReaderAnchorStore", "createReaderAnchorStore, parseReaderLinkFragment, parseReaderLinkDestination, encodeReaderLinkFragment");
assert.equal([...sourceMain.matchAll(new RegExp(readerBacklinkIndexMarker.source, "gs"))].length, 1, "Expected one Reader Backlink Index build marker");
const inlinedReaderBacklinkIndex = await inlineModule("reader-backlink-index.cjs", "__PDFReaderBacklinkIndex", "buildReaderBacklinkPageIndex, createReaderBacklinkIndex, normalizePdfRoutePath");
const bundledMain = sourceMain
  .replace(requireMarker, () => inlinedHelper)
  .replace(hashRuntimeMarker, () => inlinedHashRuntime)
  .replace(mergeClientMarker, () => inlinedMergeClient)
  .replace(annotationHostMarker, () => inlinedAnnotationHost)
  .replace(vocabularyServiceMarker, () => inlinedVocabularyService)
  .replace(vocabularyCanonicalMarker, () => inlinedVocabularyCanonical)
  .replace(vocabularyWorkspaceMarker, () => inlinedVocabularyWorkspace)
  .replace(vocabularyWorkbenchMarker, () => inlinedVocabularyWorkbench)
  .replace(learningHostMarker,()=>inlinedLearningHost)
  .replace(semanticServicesMarker,()=>inlinedSemanticServices)
  .replace(vocabularyDictionaryMarker, () => inlinedVocabularyDictionary)
  .replace(vocabularyModalsMarker, () => inlinedVocabularyModals)
  .replace(heavyWorkMarker, () => inlinedHeavyWork)
  .replace(recoveryMarker, () => inlinedRecovery)
  .replace(sessionLogMarker, () => inlinedSessionLog)
  .replace(readerAnchorStoreMarker, () => inlinedReaderAnchorStore)
  .replace(readerBacklinkIndexMarker, () => inlinedReaderBacklinkIndex)
  .replace(
    payloadMarker,
    () => `const VIEWER_ASSET_PAYLOAD = ${JSON.stringify(payload)};`,
  );
assert.ok(!bundledMain.includes("./asset-runtime.cjs"));
assert.ok(!bundledMain.includes("./pdf-merge-client.cjs"));
assert.ok(!bundledMain.includes("./pdf-sync-host.cjs"));
assert.ok(!bundledMain.includes("./pdf-hash-runtime.cjs"));
assert.ok(!bundledMain.includes("./vocabulary/dictionary.cjs"));
assert.ok(!bundledMain.includes("./vocabulary/canonical.cjs"));
assert.ok(!bundledMain.includes("./pdf-merge-client.cjs"));
assert.ok(!bundledMain.includes("./heavy-work.cjs"));
assert.ok(!bundledMain.includes("./pdf-recovery.cjs"));
assert.ok(!bundledMain.includes("./reader-anchor-store.cjs"));
assert.ok(!bundledMain.includes("./reader-backlink-index.cjs"));
assert.ok(!bundledMain.includes("writeDeltaRecovery"), "0.6.0 runtime must not contain the legacy binary recovery writer");
assert.ok(!bundledMain.includes("VIEWER_ASSET_PAYLOAD = null"));
assert.equal(/\btraceMethods\s*\(\s*(?:this\.|PdfReaderView\.|PdfWebReaderSettingTab\.|module\.exports\.)|\b\w+\s*=\s*traceFunction\s*\(/.test(bundledMain), false,
  "The production Host bundle must not instrument hot paths per call");
const externalRequires = [...bundledMain.matchAll(/\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g)].map(
  (match) => match[2],
);
assert.deepEqual(
  externalRequires,
  ["obsidian"],
  "The release bundle may only load Obsidian as an external module",
);
assert.doesNotMatch(
  bundledMain,
  /(?<![\w$.])Buffer\s*(?:\.|\[|\()|(?:globalThis|window|self)(?:\?\.|\.)Buffer\b|(?<![\w$.])process\s*(?:\?\.|\.)\s*(?:env|versions|version|platform|arch|argv|execPath|binding|getBuiltinModule)\b|(?<![\w$.])process\s*\[\s*["'](?:env|versions|version|platform|arch|argv|execPath|binding|getBuiltinModule)["']\s*\]|(?:globalThis|window|self)(?:\?\.|\.)process\b|(?:globalThis|window|self)(?:\?\.|\.)electron\b|\brequire\s*\(\s*["'](?:node:|electron|crypto|zlib|fs|path|os|stream|buffer)/,
  "The release bundle must not depend on Node or Electron runtime globals/modules",
);

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
