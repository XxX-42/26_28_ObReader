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

async function expectedPayloadPaths() {
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
  files.push("LICENSE", "web/obsidian-bridge.js", "web/bridge.css");
  return [...new Set(files)].sort();
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

test("three-file built main extracts 404 assets once, serializes concurrent requests, repairs cache and isolates versions", async () => {
  const temp = await createTempRoot("asset-roundtrip-");
  try {
    const adapter = createDiskAdapter(temp);
    const source = await readBuiltMain();
    const payload = readPayloadFromMain(source);
    const harness = loadBundledPlugin(source, adapter);
    await harness.load();

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
      404,
      "Concurrent first-use should write 404 assets exactly once",
    );

    const actualFiles = await listDiskFiles(adapter.resolve(first.rootPath));
    assert.deepEqual(
      actualFiles.map(({ path: name }) => name).sort(),
      [...(await expectedPayloadPaths()), ".complete.json"].sort(),
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

    const repaired = await harness.plugin.ensureViewerAssets();
    assert.deepEqual(repaired, first);
    assert.equal(
      adapter.writeCount,
      407,
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
    const isolated = await isolatedHarness.plugin.ensureViewerAssets();
    assert.notEqual(isolated.rootPath, first.rootPath);
    assert.equal(isolated.version, payload.id);
    assert.notEqual(isolated.contentHash, first.contentHash);
    assert.ok(await adapter.exists(`${first.rootPath}/.complete.json`));
    assert.ok(await adapter.exists(`${isolated.rootPath}/.complete.json`));
    assert.equal(
      adapter.writeCount,
      811,
      "A different payload version gets an isolated full cache",
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
      405,
      "A successful retry leaves 404 assets and a completion marker",
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
