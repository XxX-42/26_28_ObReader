import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  computePayloadHash,
  createDiskAdapter,
  createTempRoot,
  listDiskFiles,
  loadBundledPlugin,
  pluginRoot,
  readBuiltMain,
  readPayloadFromMain,
  removeTempRoot,
  replacePayloadInMain,
  root,
} from "./bundled-plugin-test-utils.mjs";

async function expectedVendorPaths() {
  const vendor = path.join(root, "vendor", "pdfjs-generic-legacy");
  const files = [];
  async function walk(directory, prefix = "") {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, name);
      else files.push(name);
    }
  }
  await walk(path.join(vendor, "build"), "build");
  await walk(path.join(vendor, "web"), "web");
  files.push("LICENSE");
  return [...new Set(files)].sort();
}

async function assertPayloadIncludesExpectedResources(payload) {
  const vendorPaths = await expectedVendorPaths();
  assert.equal(vendorPaths.length, 402, "the frozen PDF.js runtime files and license are unchanged");
  const payloadPaths = new Set(payload.files.map(({ path: name }) => name));
  for (const vendorPath of vendorPaths) {
    assert.ok(payloadPaths.has(vendorPath), `payload omits vendor file ${vendorPath}`);
  }
  assert.ok(payloadPaths.has("web/obsidian-bridge.js"));
  assert.ok(payloadPaths.has("web/bridge.css"));
  assert.ok(payloadPaths.has("web/pdf-merge-worker.js"));
  assert.ok(payloadPaths.has("web/pdf-merge-worker-LICENSE.txt"));
  assert.ok(payload.files.length >= vendorPaths.length + 4);
}

function adapterFilePath(adapter, rootPath, relative) {
  return `${rootPath}/${relative}`;
}

function asArrayBuffer(bytes) {
  const buffer = Buffer.from(bytes);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("built main extracts every manifest asset once, serializes concurrent requests, repairs cache and isolates versions", async () => {
  const temp = await createTempRoot("asset-roundtrip-");
  try {
    const adapter = createDiskAdapter(temp);
    const source = await readBuiltMain();
    const payload = readPayloadFromMain(source);
    await assertPayloadIncludesExpectedResources(payload);
    const harness = loadBundledPlugin(source, adapter);
    await harness.load();
    assert.equal("Buffer" in harness.runtimeContext, false);
    assert.equal("process" in harness.runtimeContext, false);

    const [first, concurrent] = await Promise.all([
      harness.plugin.ensureViewerAssets(),
      harness.plugin.ensureViewerAssets(),
      harness.plugin.ensureViewerAssets(),
    ]);
    assert.deepEqual(first, concurrent);
    assert.equal(
      first.rootPath,
      `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`,
    );
    assert.equal(first.webRoot, `${first.rootPath}/web`);
    assert.equal(first.version, payload.id);
    assert.equal(first.contentHash, payload.contentHash);
    assert.equal(
      adapter.writeCount,
      payload.files.length,
      "Concurrent first-use should write each manifest asset exactly once",
    );

    const actualFiles = await listDiskFiles(adapter.resolve(first.rootPath));
    assert.deepEqual(
      actualFiles.map(({ path: name }) => name).sort(),
      [...payload.files.map(({ path: name }) => name), ".complete.json"].sort(),
    );
    const viewerCssPath = adapterFilePath(
      adapter,
      first.rootPath,
      "web/viewer.css",
    );
    const bridgeCssPath = adapterFilePath(
      adapter,
      first.rootPath,
      "web/bridge.css",
    );
    await adapter.writeBinary(
      viewerCssPath,
      asArrayBuffer("corrupted cache content"),
    );
    await adapter.remove(bridgeCssPath);

    const writesBeforeRepair = adapter.writeCount;
    const repaired = await harness.plugin.ensureViewerAssets({ forceVerify: true });
    assert.equal(repaired.rootPath, first.rootPath);
    assert.equal(
      adapter.writeCount,
      writesBeforeRepair + 2,
      "Only the corrupted and missing assets should be repaired",
    );

    const isolatedPayload = structuredClone(payload);
    const license = isolatedPayload.files.find(
      (file) => file.path === "LICENSE",
    );
    const changedLicense = Buffer.concat([
      gunzipSync(Buffer.from(license.gzipBase64, "base64")),
      Buffer.from("\nasset-cache-version-isolation-test\n"),
    ]);
    const changedCompressed = gzipSync(changedLicense, { level: 9, mtime: 0 });
    changedCompressed.writeUInt32LE(0, 4);
    changedCompressed[9] = 255;
    license.size = changedLicense.byteLength;
    license.sha256 = sha256(changedLicense);
    license.gzipBase64 = changedCompressed.toString("base64");
    isolatedPayload.contentHash = computePayloadHash(isolatedPayload);
    const isolatedSource = replacePayloadInMain(source, isolatedPayload);
    const isolatedHarness = loadBundledPlugin(isolatedSource, adapter);
    await isolatedHarness.load();
    const writesBeforeIsolated = adapter.writeCount;
    const isolated = await isolatedHarness.plugin.ensureViewerAssets();
    assert.notEqual(isolated.rootPath, first.rootPath);
    assert.equal(isolated.version, payload.id);
    assert.notEqual(isolated.contentHash, first.contentHash);
    assert.ok(await adapter.exists(`${first.rootPath}/.complete.json`));
    assert.ok(await adapter.exists(`${isolated.rootPath}/.complete.json`));
    assert.equal(
      adapter.writeCount,
      writesBeforeIsolated + payload.files.length,
      "A different payload version gets an isolated full cache",
    );
  } finally {
    await removeTempRoot(temp);
  }
});

test("bundled runtime preserves full manifest hashing and multiline canonical bytes", async () => {
  const temp = await createTempRoot("asset-bundled-hash-");
  try {
    const source = await readBuiltMain();
    const payload = readPayloadFromMain(source);
    const destructure =
      "const { ensureViewerAssets, sha256Bytes } = (() => {";
    assert.equal(source.split(destructure).length - 1, 1);
    let instrumented = source.replace(
      destructure,
      "const { ensureViewerAssets, sha256Bytes, computeContentHash } = (() => {",
    );
    instrumented = instrumented.replace(
      "const VIEWER_ASSET_PAYLOAD = ",
      "globalThis.__computeContentHash = computeContentHash;\nconst VIEWER_ASSET_PAYLOAD = ",
    );
    const multiline = `pdf-web-reader-assets\n1\n${payload.id}\n`;
    instrumented +=
      "\nglobalThis.__bundledManifestHash = computeContentHash(VIEWER_ASSET_PAYLOAD);" +
      `\nglobalThis.__multilineHash = sha256Bytes(new TextEncoder().encode(${JSON.stringify(multiline)}));\n`;
    const harness = loadBundledPlugin(
      instrumented,
      createDiskAdapter(temp),
    );

    assert.equal(
      harness.runtimeContext.__bundledManifestHash,
      payload.contentHash,
      "The inlined browser runtime must hash the complete embedded manifest",
    );
    assert.equal(
      harness.runtimeContext.__multilineHash,
      sha256(Buffer.from(multiline, "utf8")),
      "Canonical newline bytes must survive build-time runtime inlining",
    );
  } finally {
    await removeTempRoot(temp);
  }
});

test("interrupted extraction leaves no completion marker and succeeds on retry", async () => {
  const temp = await createTempRoot("asset-retry-");
  try {
    let failed = false;
    const adapter = createDiskAdapter(temp, {
      failWrite: (vaultPath) => {
        if (!failed && vaultPath.endsWith("/web/viewer.css")) {
          failed = true;
          return true;
        }
        return false;
      },
    });
    const source = await readBuiltMain();
    const payload = readPayloadFromMain(source);
    const harness = loadBundledPlugin(source, adapter);
    await harness.load();
    const expectedRoot = `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;

    await assert.rejects(
      harness.plugin.ensureViewerAssets(),
      /Simulated adapter write failure/,
    );
    assert.equal(failed, true);
    assert.equal(await adapter.exists(`${expectedRoot}/.complete.json`), false);

    const recovered = await harness.plugin.ensureViewerAssets();
    assert.equal(recovered.rootPath, expectedRoot);
    assert.equal(await adapter.exists(`${expectedRoot}/.complete.json`), true);
    assert.equal(
      (await listDiskFiles(adapter.resolve(expectedRoot))).length,
      payload.files.length + 1,
      "A successful retry leaves every manifest asset and a completion marker",
    );
  } finally {
    await removeTempRoot(temp);
  }
});

test("malicious embedded asset paths are rejected before writing outside the plugin cache", async () => {
  const temp = await createTempRoot("asset-path-guard-");
  try {
    const adapter = createDiskAdapter(temp);
    const source = await readBuiltMain();
    const payload = readPayloadFromMain(source);
    payload.files[0].path = "../escape.bin";
    payload.contentHash = computePayloadHash(payload);
    const hostileSource = replacePayloadInMain(source, payload);
    const harness = loadBundledPlugin(hostileSource, adapter);
    await harness.load();

    await assert.rejects(
      harness.plugin.ensureViewerAssets(),
      /Invalid viewer asset path path segment|Invalid viewer asset path segment|Invalid viewer asset path/,
    );
    assert.equal(adapter.writeCount, 0);
    assert.deepEqual(await listDiskFiles(temp), []);
  } finally {
    await removeTempRoot(temp);
  }
});
