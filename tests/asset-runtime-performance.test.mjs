import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const { computeContentHash, ensureViewerAssets } = require(
  "../plugin/asset-runtime.cjs",
);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makePayload(id, count, { prefix = "web/assets" } = {}) {
  const files = Array.from({ length: count }, (_, index) => {
    const bytes = Buffer.from(`asset-${id}-${index}`);
    return {
      path: `${prefix}/file-${index}.bin`,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      gzipBase64: gzipSync(bytes).toString("base64"),
    };
  });
  const payload = { schema: 1, id, files };
  payload.contentHash = computeContentHash(payload);
  return payload;
}

function createMemoryAdapter(overrides = {}) {
  const files = new Map();
  const directories = new Set();
  const mkdirCalls = [];
  const binaryWrites = [];
  const adapter = {
    files,
    directories,
    mkdirCalls,
    binaryWrites,
    async exists(path) {
      return files.has(path) || directories.has(path);
    },
    async mkdir(path) {
      mkdirCalls.push(path);
      directories.add(path);
    },
    async readBinary(path) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Missing binary file: ${path}`);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
    async writeBinary(path, value) {
      const bytes = new Uint8Array(value);
      binaryWrites.push(path);
      files.set(path, bytes);
    },
    async remove(path) {
      files.delete(path);
    },
    async read(path) {
      return files.get(path);
    },
    async write(path, value) {
      files.set(path, value);
    },
    ...overrides,
  };
  return adapter;
}

function assetRoot(pluginRoot, payload) {
  return `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
}

test("compact resource paths preserve full bundle identity within Windows resource URL limits", async () => {
  const adapter = createMemoryAdapter();
  const pluginRoot = ".obsidian/plugins/pdf-web-reader";
  const vaultRoot = "D:/Documents/Obsidian/ObReader-0.14-Windows-Native-20261023";
  const payload = makePayload("pdfjs-full-viewer-5.7.192-3f4171c02-fork-ink-session-guard-0.5.19-highlight-row-collision-0.12.1", 2);
  const file = "web/obsidian-bridge.js";
  assert.ok(`${vaultRoot}/${assetRoot(pluginRoot, payload)}/${file}`.length > 260);
  const first = await ensureViewerAssets(adapter, pluginRoot, payload, { compactPath: true });
  assert.ok(`${vaultRoot}/${first.rootPath}/${file}`.length < 260,
    "Windows app:// cannot load the original long path even though DataAdapter reads it");
  assert.match(first.rootPath, /\/\.asset-cache\/v2\/[a-f0-9]{64}$/u);
  const repeated = await ensureViewerAssets(adapter, pluginRoot, payload, { compactPath: true, forceVerify: true });
  assert.equal(repeated.rootPath, first.rootPath);
  assert.equal(repeated.metrics.bytesWritten, 0);
  assert.ok(repeated.metrics.verificationReads >= payload.files.length);
  // A name change with identical bytes still has a distinct, full-strength key.
  const other = { ...payload, id: `${payload.id}-other` };
  other.contentHash = computeContentHash(other);
  const isolated = await ensureViewerAssets(adapter, pluginRoot, other, { compactPath: true });
  assert.notEqual(isolated.rootPath, first.rootPath);
  assert.equal(isolated.contentHash, other.contentHash);
  assert.equal(await adapter.exists(`${first.rootPath}/.complete.json`), true);
});

test("valid cache hits avoid decompression and repairs decode only damaged files", async () => {
  const adapter = createMemoryAdapter();
  const payload = makePayload("performance-cache-v1", 9);
  const pluginRoot = ".obsidian/plugins/cache-test";

  const first = await ensureViewerAssets(adapter, pluginRoot, payload);
  assert.equal(first.metrics.cacheHit, false);
  assert.equal(first.metrics.decodedFiles, payload.files.length);
  assert.equal(first.metrics.repairedFiles, payload.files.length);
  assert.equal(first.metrics.bytesWritten, first.metrics.decodedBytes);
  assert.equal(adapter.binaryWrites.length, payload.files.length);

  const cached = await ensureViewerAssets(adapter, pluginRoot, payload);
  assert.equal(cached.rootPath, first.rootPath);
  assert.equal(cached.metrics.cacheHit, true);
  assert.equal(cached.metrics.decodedFiles, 0);
  assert.equal(cached.metrics.repairedFiles, 0);
  assert.equal(cached.metrics.bytesWritten, 0);
  assert.equal(adapter.binaryWrites.length, payload.files.length);

  const missingPath = `${first.rootPath}/${payload.files[2].path}`;
  const corruptPath = `${first.rootPath}/${payload.files[7].path}`;
  adapter.files.delete(missingPath);
  adapter.files.set(corruptPath, new TextEncoder().encode("corrupted"));

  const repaired = await ensureViewerAssets(adapter, pluginRoot, payload);
  assert.equal(repaired.metrics.cacheHit, false);
  assert.equal(repaired.metrics.checkedFiles, payload.files.length);
  assert.equal(repaired.metrics.decodedFiles, 2);
  assert.equal(repaired.metrics.repairedFiles, 2);
  assert.equal(adapter.binaryWrites.length, payload.files.length + 2);
  assert.equal(
    repaired.metrics.bytesWritten,
    payload.files[2].size + payload.files[7].size,
  );
  assert.equal(
    adapter.files.has(`${first.rootPath}/.complete.json`),
    true,
    "the marker is restored only after damaged entries are repaired and rechecked",
  );
});

test("asset work is globally capped at four and shared directories are created once", async () => {
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const adapter = createMemoryAdapter({
    async writeBinary(path, value) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 8));
      const bytes = new Uint8Array(value);
      adapter.files.set(path, bytes);
      activeWrites -= 1;
    },
    async mkdir(path) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      adapter.mkdirCalls.push(path);
      adapter.directories.add(path);
    },
  });
  const pluginRoot = ".obsidian/plugins/cache-test";
  const payloads = [
    makePayload("parallel-cache-a", 8),
    makePayload("parallel-cache-b", 8),
  ];

  await Promise.all(
    payloads.map((payload) =>
      ensureViewerAssets(adapter, pluginRoot, payload),
    ),
  );

  assert.equal(activeWrites, 0);
  assert.ok(maxActiveWrites <= 4, `observed ${maxActiveWrites} simultaneous writes`);
  assert.equal(
    adapter.mkdirCalls.filter((path) => path === ".obsidian").length,
    1,
  );
  assert.equal(
    adapter.mkdirCalls.filter((path) => path === ".obsidian/plugins").length,
    1,
  );
  assert.equal(
    adapter.mkdirCalls.filter((path) => path === pluginRoot).length,
    1,
  );
});

test("a repair failure stops scheduling and waits for started writes before rejecting", async () => {
  let activeWrites = 0;
  let failedPath;
  const startedPaths = [];
  let releaseFirstWave;
  const firstWave = new Promise((resolve) => {
    releaseFirstWave = resolve;
  });
  const adapter = createMemoryAdapter({
    async writeBinary(path, value) {
      activeWrites += 1;
      startedPaths.push(path);
      if (startedPaths.length === 4) releaseFirstWave();
      if (startedPaths.length <= 4) await firstWave;
      if (path.endsWith("/file-0.bin")) {
        await new Promise((resolve) => setTimeout(resolve, 6));
        failedPath = path;
        activeWrites -= 1;
        throw new Error("simulated concurrent asset write failure");
      }
      await new Promise((resolve) => setTimeout(resolve, 35));
      adapter.files.set(path, new Uint8Array(value));
      activeWrites -= 1;
    },
  });
  const payload = makePayload("parallel-failure-v1", 12);
  const pluginRoot = ".obsidian/plugins/cache-test";
  const rootPath = assetRoot(pluginRoot, payload);

  await assert.rejects(
    ensureViewerAssets(adapter, pluginRoot, payload),
    /simulated concurrent asset write failure/,
  );
  assert.ok(failedPath);
  assert.equal(activeWrites, 0, "reject only after every started write settles");
  assert.equal(startedPaths.length, 4, "no queued file begins after first failure");
  assert.equal(adapter.files.has(`${rootPath}/.complete.json`), false);
  const settledCount = startedPaths.length;
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(startedPaths.length, settledCount, "no background writes remain");
  assert.equal(adapter.files.has(`${rootPath}/.complete.json`), false);
});
