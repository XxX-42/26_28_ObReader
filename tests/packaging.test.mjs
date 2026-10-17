import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { verifyVendorHashes } from "../scripts/hash-vendor.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "vendor", "pdfjs-generic-legacy");
const adapters = path.join(root, "viewer-adapter");
const dist = path.join(root, "dist", "pdf-web-reader");
const assetBundleId = "pdfjs-full-viewer-5.7.192-3f4171c02-fork-ink-session-guard-0.5.19";

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

async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push({ absolute, path: relative });
    } else {
      throw new Error(`Unexpected file type: ${relative}`);
    }
  }
  return files;
}

async function readEmbeddedPayload() {
  const main = await readFile(path.join(dist, "main.js"), "utf8");
  const marker = "const VIEWER_ASSET_PAYLOAD = ";
  const markerIndex = main.indexOf(marker);
  assert.notEqual(
    markerIndex,
    -1,
    "Built main.js must include the runtime payload",
  );
  const jsonStart = markerIndex + marker.length;
  const jsonEnd = main.indexOf(";\n", jsonStart);
  assert.notEqual(jsonEnd, -1, "Built runtime payload must be a JSON literal");
  return JSON.parse(main.slice(jsonStart, jsonEnd));
}

async function expectedAssetFiles() {
  const license = await readFile(path.join(root, "node_modules/pdf-lib/LICENSE.md"), "utf8");
  const worker = await build({ entryPoints: [path.join(root, "plugin/pdf-merge-worker.mjs")],
    bundle: true, format: "iife", platform: "browser", target: ["es2022"],
    legalComments: "inline", banner: { js: `/* pdf-lib 1.17.1 MIT License\n${license.replaceAll("*/", "* /")}*/` }, write: false });
  return [
    ...(await listFiles(path.join(vendor, "build"), "build")),
    ...(await listFiles(path.join(vendor, "web"), "web")),
    { absolute: path.join(vendor, "LICENSE"), path: "LICENSE" },
    {
      bytes: Buffer.from(await readBridgeRuntimeSource()),
      path: "web/obsidian-bridge.js",
    },
    {
      absolute: path.join(adapters, "bridge.css"),
      path: "web/bridge.css",
    },
    { licenseCheck: true, path: "web/pdf-merge-worker-LICENSE.txt" },
    { bytes: worker.outputFiles[0].contents, path: "web/pdf-merge-worker.js" },
  ].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

test("vendored PDF.js runtime matches its frozen SHA-256 manifest", async () => {
  assert.equal(await verifyVendorHashes(), 402);
});

test("vendored viewer retains all five controls and the 1–5 mode order", async () => {
  const html = await readFile(path.join(vendor, "web", "viewer.html"), "utf8");
  const js = await readFile(path.join(vendor, "web", "viewer.mjs"), "utf8");
  for (const id of [
    "editorUnderlineButton",
    "editorSquareButton",
    "editorHighlightButton",
    "editorInkButton",
    "editorFreeTextButton",
  ]) {
    assert.ok(html.includes(id), `Missing editor control ${id}`);
  }
  assert.match(
    js,
    /AnnotationEditorType\.UNDERLINE,\s*AnnotationEditorType\.SQUARE,\s*AnnotationEditorType\.HIGHLIGHT,\s*AnnotationEditorType\.INK,\s*AnnotationEditorType\.FREETEXT/,
  );
  assert.match(js, /case 49:\s*case 97:/);
});

test("community release output is exactly the three installer assets", async () => {
  const names = (await readdir(dist)).sort();
  assert.deepEqual(names, ["main.js", "manifest.json", "styles.css"]);
  const nestedFiles = await listFiles(dist);
  assert.deepEqual(
    nestedFiles.map(({ path: name }) => name).sort(),
    names,
    "The release directory must not depend on a viewer folder, node_modules, or source tree",
  );
  const manifest = JSON.parse(
    await readFile(path.join(dist, "manifest.json"), "utf8"),
  );
  const rootManifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  const sourceManifest = JSON.parse(
    await readFile(path.join(root, "plugin", "manifest.json"), "utf8"),
  );
  const versions = JSON.parse(
    await readFile(path.join(root, "versions.json"), "utf8"),
  );
  assert.equal(manifest.id, "pdf-web-reader");
  assert.equal(manifest.version, "0.9.1");
  assert.equal(manifest.isDesktopOnly, false);
  assert.deepEqual(manifest, rootManifest);
  assert.deepEqual(manifest, sourceManifest);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  assert.ok(
    (await readFile(path.join(dist, "main.js"))).byteLength > 1_000_000,
  );
});

test("built main embeds all runtime files with checked deterministic gzip and hashes", async () => {
  const payload = await readEmbeddedPayload();
  assert.equal(payload.schema, 1);
  assert.equal(payload.id, assetBundleId);
  assert.match(payload.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(
    payload.contentHash,
    computeContentHash(payload.schema, payload.id, payload.files),
  );

  const expected = await expectedAssetFiles();
  assert.equal(payload.files.length, expected.length);
  assert.equal(payload.files.length, 406);
  assert.ok(payload.files.some((file) => file.path === "web/pdf-merge-worker.js"));
  assert.ok(payload.files.some((file) => file.path === "web/pdf-merge-worker-LICENSE.txt"));
  assert.deepEqual(
    payload.files.map(({ path: name }) => name),
    expected.map(({ path: name }) => name),
    "The embedded path manifest must exactly cover vendored assets and bridge files",
  );

  for (let index = 0; index < expected.length; index += 1) {
    const entry = payload.files[index];
    const decoded = gunzipSync(Buffer.from(entry.gzipBase64, "base64"));
    let sourceBytes;
    if (expected[index].licenseCheck) {
      const notices = decoded.toString("utf8");
      for (const [name, licensePath] of [["pdf-lib", "LICENSE.md"], ["@pdf-lib/standard-fonts", "LICENSE.md"], ["@pdf-lib/upng", "LICENSE"], ["pako", "LICENSE"], ["tslib", "LICENSE.txt"], ["@noble/hashes", "LICENSE"]]) {
        assert.ok(notices.includes(name), `Missing notice name: ${name}`);
        assert.ok(notices.includes(await readFile(path.join(root, "node_modules", name, licensePath), "utf8")), `Missing full license: ${name}`);
      }
      assert.ok(notices.includes("pako /lib/zlib Zlib notice"));
      sourceBytes = decoded;
    } else {
      sourceBytes = expected[index].bytes ? Buffer.from(expected[index].bytes) : await readFile(expected[index].absolute);
      if (entry.path === "web/obsidian-bridge.js") {
        // The packaged bridge asset includes the input modules, while the
        // build instruments only functions declared in obsidian-bridge.js.
        const source = await readFile(path.join(adapters, "obsidian-bridge.js"), "utf8");
        const names = [...source.matchAll(/^  (?:async )?function (\w+)\(/gm)].map(match => match[1]).filter(name => !name.startsWith("runtimeLog"));
        const assignments = names.map(name => `${name} = runtimeLogTrace(${name}, ${JSON.stringify(`Viewer.${name}`)});`).join("\n  ");
        sourceBytes = Buffer.from(sourceBytes.toString("utf8").replace("/* BUILD:VIEWER_FUNCTION_TRACE */", assignments));
      }
    }
    assert.equal(entry.size, sourceBytes.byteLength, `${entry.path}: size`);
    assert.equal(
      entry.sha256,
      sha256(sourceBytes),
      `${entry.path}: manifest hash`,
    );
    assert.equal(sha256(decoded), entry.sha256, `${entry.path}: decoded hash`);
    assert.deepEqual(decoded, sourceBytes, `${entry.path}: decoded bytes`);
  }
});
