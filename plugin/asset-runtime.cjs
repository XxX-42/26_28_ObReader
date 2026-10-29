/*
 * Copyright 2026 XxX-42 and contributors
 * SPDX-License-Identifier: Apache-2.0
 * SHA-256 uses the MIT-licensed @noble/hashes package, pinned by package.json.
 */
const { sha256 } = require("@noble/hashes/sha2");

const MAX_FILE_SIZE = 128 * 1024 * 1024;
const MAX_TOTAL_SIZE = 512 * 1024 * 1024;
const MAX_CONCURRENT_ASSET_OPERATIONS = 4;
const activeLocks = new WeakMap();
const directoryLocks = new WeakMap();
const encoder = new TextEncoder();
const assetNow = () => globalThis.performance?.now?.() ?? Date.now();
let activeAssetOperations = 0;
const waitingAssetOperations = [];

async function withAssetOperationSlot(operation, shouldRun) {
  if (activeAssetOperations >= MAX_CONCURRENT_ASSET_OPERATIONS) {
    await new Promise((resolve) => waitingAssetOperations.push(resolve));
  } else {
    activeAssetOperations += 1;
  }
  try {
    if (!shouldRun()) return;
    return await operation();
  } finally {
    const next = waitingAssetOperations.shift();
    if (next) next();
    else activeAssetOperations -= 1;
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bytesView(value, label) {
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label} did not return binary data.`);
}

function bytesToArrayBuffer(bytes) {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

function sha256Bytes(value) {
  const bytes = bytesView(value, "SHA-256 input");
  return Array.from(sha256(bytes), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function assetDigest(bytes) {
  // Same SHA-256 contract, executed by the browser rather than on the UI thread.
  // Test/older runtimes without SubtleCrypto retain the verified portable path.
  if (!globalThis.crypto?.subtle) return sha256Bytes(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validatePathSegment(segment, label) {
  if (
    !segment ||
    segment === "." ||
    segment === ".." ||
    /[\0\\/:<>"|?*]/.test(segment) ||
    /[. ]$/.test(segment) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  ) {
    throw new Error(
      `Invalid ${label} path segment: ${JSON.stringify(segment)}`,
    );
  }
}

function validateAssetPath(assetPath) {
  if (
    typeof assetPath !== "string" ||
    !assetPath ||
    assetPath.startsWith("/") ||
    assetPath.includes("\\") ||
    assetPath.includes("\0")
  ) {
    throw new Error(`Invalid viewer asset path: ${JSON.stringify(assetPath)}`);
  }
  const segments = assetPath.split("/");
  for (const segment of segments) {
    validatePathSegment(segment, "viewer asset");
  }
  if (assetPath.toLowerCase() === ".complete.json") {
    throw new Error("The viewer asset path is reserved for the cache marker.");
  }
  return segments.join("/");
}

function validatePluginRoot(pluginRoot) {
  if (
    typeof pluginRoot !== "string" ||
    !pluginRoot ||
    pluginRoot.startsWith("/") ||
    pluginRoot.includes("\\") ||
    pluginRoot.includes("\0")
  ) {
    throw new Error("The plugin root must be a vault-relative path.");
  }
  const segments = pluginRoot.split("/");
  for (const segment of segments) {
    validatePathSegment(segment, "plugin root");
  }
  return segments.join("/");
}

function validateAssetId(id) {
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ||
    id === "." ||
    id === ".."
  ) {
    throw new Error("The viewer asset payload has an invalid id.");
  }
  validatePathSegment(id, "asset id");
  return id;
}

function canonicalManifest(payload, files) {
  const rows = [...files]
    .sort((left, right) => comparePaths(left.path, right.path))
    .map((file) => `${file.path}\t${file.size}\t${file.sha256}\n`)
    .join("");
  return `pdf-web-reader-assets\n${payload.schema}\n${payload.id}\n${rows}`;
}

function computeContentHash(payload) {
  if (!isPlainObject(payload) || payload.schema !== 1) {
    throw new Error("Unsupported viewer asset payload schema.");
  }
  validateAssetId(payload.id);
  if (!Array.isArray(payload.files)) {
    throw new Error("The viewer asset payload has no file manifest.");
  }
  const files = payload.files.map((file) => ({
    path: validateAssetPath(file?.path),
    size: file?.size,
    sha256: file?.sha256,
  }));
  return sha256Bytes(encoder.encode(canonicalManifest(payload, files)));
}

function hasCanonicalBase64Padding(base64) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (base64.endsWith("==")) {
    return (alphabet.indexOf(base64.at(-3)) & 0x0f) === 0;
  }
  if (base64.endsWith("=")) {
    return (alphabet.indexOf(base64.at(-2)) & 0x03) === 0;
  }
  return true;
}

function decodeCanonicalBase64(base64, label) {
  const padding = typeof base64 === "string" ? (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0) : 0;
  if (
    typeof base64 !== "string" ||
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    /[^A-Za-z0-9+/]/.test(base64.slice(0, base64.length - padding)) ||
    !hasCanonicalBase64Padding(base64)
  ) {
    throw new Error(`Non-canonical base64 data for viewer asset ${label}.`);
  }
  let binary;
  try {
    binary = atob(base64);
  } catch (error) {
    throw new Error(
      `Unable to decode base64 viewer asset ${label}: ${error.message}`,
    );
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function validatePayload(payload) {
  if (!isPlainObject(payload) || payload.schema !== 1) {
    throw new Error("Unsupported viewer asset payload schema.");
  }
  const id = validateAssetId(payload.id);
  if (
    typeof payload.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(payload.contentHash)
  ) {
    throw new Error("The viewer asset payload has an invalid content hash.");
  }
  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    throw new Error("The viewer asset payload is empty.");
  }

  const seenPaths = new Set();
  let totalSize = 0;
  const files = payload.files.map((file, index) => {
    if (!isPlainObject(file)) {
      throw new Error(`Invalid viewer asset manifest entry at index ${index}.`);
    }
    const path = validateAssetPath(file.path);
    const foldedPath = path.toLowerCase();
    if (seenPaths.has(foldedPath)) {
      throw new Error(`Duplicate viewer asset path: ${path}`);
    }
    seenPaths.add(foldedPath);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE_SIZE
    ) {
      throw new Error(`Invalid viewer asset size for ${path}.`);
    }
    totalSize += file.size;
    if (totalSize > MAX_TOTAL_SIZE) {
      throw new Error("The viewer asset payload exceeds the size limit.");
    }
    if (
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error(`Invalid viewer asset SHA-256 for ${path}.`);
    }
    if (
      typeof file.gzipBase64 !== "string" ||
      file.gzipBase64.length === 0 ||
      file.gzipBase64.length > Math.ceil((MAX_FILE_SIZE * 4) / 3) + 8 ||
      file.gzipBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.gzipBase64,
      ) ||
      !hasCanonicalBase64Padding(file.gzipBase64)
    ) {
      throw new Error(`Invalid compressed viewer asset data for ${path}.`);
    }
    return {
      path,
      size: file.size,
      sha256: file.sha256,
      gzipBase64: file.gzipBase64,
    };
  });

  if (
    computeContentHash({ schema: payload.schema, id, files }) !==
    payload.contentHash
  ) {
    throw new Error("The viewer asset manifest content hash does not match.");
  }

  return { schema: 1, id, contentHash: payload.contentHash, files, startupPack: payload.startupPack };
}

async function decompressBounded(compressed, file) {
  if (
    typeof Blob !== "function" ||
    typeof DecompressionStream !== "function"
  ) {
    throw new Error("This environment does not support gzip decompression.");
  }
  let reader;
  try {
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    reader = stream.getReader();
    const output = new Uint8Array(file.size);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = bytesView(value, `Decompressed viewer asset ${file.path}`);
      if (chunk.byteLength > file.size - offset) {
        await reader.cancel();
        throw new Error(`Decompressed output exceeds the declared size.`);
      }
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== file.size) {
      throw new Error(`Decompressed output size does not match the manifest.`);
    }
    return output;
  } catch (error) {
    throw new Error(
      `Unable to decompress viewer asset ${file.path}: ${error.message}`,
    );
  } finally {
    reader?.releaseLock();
  }
}

async function decodePayloadFile(file, metrics = null) {
  const started = assetNow();
  const compressed = decodeCanonicalBase64(file.gzipBase64, file.path);
  const bytes = await decompressBounded(compressed, file);
  if (metrics) metrics.decompressMs += assetNow() - started;
  const hashing = assetNow();
  const actualHash = await assetDigest(bytes);
  if (metrics) metrics.hashMs += assetNow() - hashing;
  if (actualHash !== file.sha256) {
    throw new Error(
      `Embedded viewer asset failed integrity verification: ${file.path}`,
    );
  }
  return bytes;
}

function assertAdapter(adapter) {
  const requiredMethods = [
    "exists",
    "mkdir",
    "readBinary",
    "writeBinary",
    "remove",
    "read",
    "write",
  ];
  if (
    !adapter ||
    (typeof adapter !== "object" && typeof adapter !== "function") ||
    requiredMethods.some((method) => typeof adapter[method] !== "function")
  ) {
    throw new Error("The vault adapter is missing a required file operation.");
  }
}

function ensureDirectory(adapter, directoryPath) {
  let adapterLocks = directoryLocks.get(adapter);
  if (!adapterLocks) {
    adapterLocks = new Map();
    directoryLocks.set(adapter, adapterLocks);
  }
  const pending = adapterLocks.get(directoryPath);
  if (pending) return pending;

  const separator = directoryPath.lastIndexOf("/");
  const parentPath = separator < 0 ? "" : directoryPath.slice(0, separator);
  const creation = Promise.resolve()
    .then(async () => {
      if (parentPath) await ensureDirectory(adapter, parentPath);
      if (!(await adapter.exists(directoryPath))) {
        await adapter.mkdir(directoryPath);
      }
    })
    .finally(() => {
      if (adapterLocks.get(directoryPath) === creation) {
        adapterLocks.delete(directoryPath);
      }
      if (adapterLocks.size === 0) directoryLocks.delete(adapter);
    });
  adapterLocks.set(directoryPath, creation);
  return creation;
}

async function forEachConcurrent(items, operation) {
  let nextIndex = 0;
  let firstError;
  let hasError = false;
  const workerCount = Math.min(
    MAX_CONCURRENT_ASSET_OPERATIONS,
    items.length,
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (!hasError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await withAssetOperationSlot(
          () => operation(items[index], index),
          () => !hasError,
        );
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
      }
    }
  });
  // Promise.all waits for every already-started operation. This is important
  // before the caller removes the marker after a failed write.
  await Promise.all(workers);
  if (hasError) throw firstError;
}

function manifestMarker(payload) {
  const manifestFiles = [...payload.files]
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    .sort((left, right) => comparePaths(left.path, right.path));
  return {
    schema: payload.schema,
    id: payload.id,
    contentHash: payload.contentHash,
    fileCount: manifestFiles.length,
    files: manifestFiles,
  };
}

function markerContent(payload, statIndex) {
  const marker = manifestMarker(payload);
  if (statIndex) {
    marker.statIndexVersion = 1;
    marker.statIndex = statIndex;
  }
  return `${JSON.stringify(marker, null, 2)}\n`;
}

function markerMatchesManifest(marker, expected) {
  if (!isPlainObject(marker)) return false;
  const keys = Object.keys(marker).sort(comparePaths);
  const baseKeys = Object.keys(expected).sort(comparePaths);
  const indexedKeys = [...baseKeys, "statIndex", "statIndexVersion"].sort(
    comparePaths,
  );
  if (
    keys.length !== baseKeys.length &&
    keys.length !== indexedKeys.length
  ) {
    return false;
  }
  if (!keys.every((key, index) => key === baseKeys[index]) &&
      !keys.every((key, index) => key === indexedKeys[index])) {
    return false;
  }
  if (
    marker.schema !== expected.schema ||
    marker.id !== expected.id ||
    marker.contentHash !== expected.contentHash ||
    marker.fileCount !== expected.fileCount ||
    !Array.isArray(marker.files) ||
    marker.files.length !== expected.files.length
  ) {
    return false;
  }
  return marker.files.every((entry, index) => {
    const expectedEntry = expected.files[index];
    return (
      isPlainObject(entry) &&
      Object.keys(entry).sort(comparePaths).join("\0") ===
        "path\0sha256\0size" &&
      entry.path === expectedEntry.path &&
      entry.size === expectedEntry.size &&
      entry.sha256 === expectedEntry.sha256
    );
  });
}

function readStatTuple(stat) {
  if (!stat || typeof stat !== "object" || stat.type !== "file") return null;
  const size = stat.size;
  const mtime = typeof stat.mtime === "number" ? stat.mtime : stat.mtimeMs;
  const ctime = typeof stat.ctime === "number" ? stat.ctime : stat.ctimeMs;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof mtime !== "number" ||
    !Number.isFinite(mtime) ||
    mtime <= 0 ||
    typeof ctime !== "number" ||
    !Number.isFinite(ctime) ||
    ctime < 0
  ) {
    return null;
  }
  return { size, mtime, ctime };
}

function sameStatTuple(left, right) {
  return Boolean(
    left &&
      right &&
      left.size === right.size &&
      left.mtime === right.mtime &&
      left.ctime === right.ctime,
  );
}

async function fileStat(adapter, fullPath, metrics) {
  if (typeof adapter.stat !== "function") return null;
  metrics.statChecks += 1;
  const started = assetNow();
  try {
    return readStatTuple(await adapter.stat(fullPath));
  } catch {
    // A missing/unavailable stat is not evidence that a file is valid. The
    // caller falls back to reading and hashing it.
    return null;
  } finally {
    metrics.statMs += assetNow() - started;
  }
}

function readStatIndex(marker, payload) {
  if (
    !isPlainObject(marker) ||
    marker.statIndexVersion !== 1 ||
    !Array.isArray(marker.statIndex) ||
    marker.statIndex.length !== payload.files.length
  ) {
    return null;
  }
  const expectedFiles = [...payload.files].sort((a, b) =>
    comparePaths(a.path, b.path),
  );
  const index = new Map();
  for (let position = 0; position < marker.statIndex.length; position += 1) {
    const row = marker.statIndex[position];
    const expected = expectedFiles[position];
    if (
      !isPlainObject(row) ||
      Object.keys(row).sort(comparePaths).join("\0") !==
        "ctime\0mtime\0path\0sha256\0size" ||
      row.path !== expected.path ||
      row.sha256 !== expected.sha256 ||
      row.size !== expected.size ||
      (row.mtime !== null &&
        (typeof row.mtime !== "number" ||
          !Number.isFinite(row.mtime) ||
          row.mtime <= 0)) ||
      (row.ctime !== null &&
        (typeof row.ctime !== "number" ||
          !Number.isFinite(row.ctime) ||
          row.ctime < 0))
    ) {
      return null;
    }
    index.set(row.path, {
      size: row.size,
      mtime: row.mtime,
      ctime: row.ctime,
    });
  }
  return index;
}

async function inspectAsset(adapter, fullPath, file, beforeStat, metrics) {
  if (!beforeStat && !(await adapter.exists(fullPath))) {
    return {
      matches: false,
      stable: true,
      stat: null,
    };
  }
  let actual;
  const reading = assetNow();
  try {
    actual = bytesView(await adapter.readBinary(fullPath), fullPath);
    metrics.verificationReads += 1;
  } catch (error) {
    if (!(await adapter.exists(fullPath))) {
      return {
        matches: false,
        stable: true,
        stat: null,
      };
    }
    throw error;
  } finally {
    metrics.readbackMs += assetNow() - reading;
  }
  const afterStat = await fileStat(adapter, fullPath, metrics);
  const hasComparableStats = Boolean(beforeStat && afterStat);
  const stable = hasComparableStats
    ? sameStatTuple(beforeStat, afterStat)
    : true;
  const hashing = assetNow();
  const matches = stable && actual.byteLength === file.size && await assetDigest(actual) === file.sha256;
  metrics.hashMs += assetNow() - hashing;
  return {
    matches,
    stable,
    // One missing/unusable stat makes this a hash-only verification. Do not
    // persist the surviving half as if it bracketed the read; the null row
    // forces another safe SHA check on the next startup.
    stat: hasComparableStats && stable ? afterStat : null,
  };
}

function statIndexRows(payload, verified) {
  return [...payload.files]
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((file) => {
      const tuple = verified.get(file.path)?.stat || null;
      return {
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        mtime: tuple?.mtime ?? null,
        ctime: tuple?.ctime ?? null,
      };
    });
}

function sameStatIndexRows(left, right) {
  return Boolean(
    Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((row, index) => {
        const other = right[index];
        return (
          row.path === other?.path &&
          row.size === other?.size &&
          row.sha256 === other?.sha256 &&
          row.mtime === other?.mtime &&
          row.ctime === other?.ctime
        );
      }),
  );
}

function assetCacheRoot(pluginRoot, payload, compactPath) {
  if (!compactPath) return `${pluginRoot}/.asset-cache/${payload.id}/${payload.contentHash}`;
  // Windows app:// may reject a long absolute path even when DataAdapter can
  // read it. Keep the full identity digest and the verified marker, shortening
  // only the disposable directory name, never the bundle integrity checks.
  const identityHash = sha256Bytes(encoder.encode(JSON.stringify([payload.id, payload.contentHash])));
  return `${pluginRoot}/.asset-cache/v2/${identityHash}`;
}

async function extractOrRepair(adapter, rootPath, verifiedPayload, options = {}) {
  let rootMissing = false;
  // A directory is prepared once per extraction, not once per file. If it is
  // removed externally afterwards, the write still fails and no marker commits.
  const preparedDirectories = new Map();
  const prepareDirectory = (parentPath) => {
    if (!preparedDirectories.has(parentPath)) {
      const parent = parentPath.slice(0, parentPath.lastIndexOf("/"));
      preparedDirectories.set(parentPath, (async () => {
        if (parentPath.startsWith(`${rootPath}/`)) await prepareDirectory(parent);
        else return ensureDirectory(adapter, parentPath);
        // Descendants of an absent content-addressed root cannot pre-exist.
        // Still tolerate a concurrent creator, checking only after mkdir fails.
        if (rootMissing) {
          try { await adapter.mkdir(parentPath); }
          catch (error) { if (!(await adapter.exists(parentPath))) throw error; }
        } else if (!(await adapter.exists(parentPath))) await adapter.mkdir(parentPath);
      })());
    }
    return preparedDirectories.get(parentPath);
  };
  const markerPath = `${rootPath}/.complete.json`;
  const expectedManifest = manifestMarker(verifiedPayload);
  const startedAt = Date.now();
  const metrics = {
    cacheHit: false,
    checkedFiles: verifiedPayload.files.length,
    verificationReads: 0,
    statChecks: 0,
    decodedFiles: 0,
    repairedFiles: 0,
    decodedBytes: 0,
    bytesWritten: 0,
    decompressMs: 0, hashMs: 0, writeMs: 0, readbackMs: 0, statMs: 0, directoryMs: 0,
  };

  try {
    rootMissing = !(await adapter.exists(rootPath));
    const markerExists = await adapter.exists(markerPath);
    let marker = null;
    if (markerExists) {
      try {
        marker = JSON.parse(await adapter.read(markerPath));
      } catch {
        marker = null;
      }
    }
    const manifestMatches = markerMatchesManifest(marker, expectedManifest);
    const indexed = manifestMatches ? readStatIndex(marker, verifiedPayload) : null;
    const useIndex = Boolean(indexed) && options.forceVerify !== true;
    const verified = new Map();
    const repair = new Set();
    const touched = new Set();
    let skippedStatFiles = 0;

    await forEachConcurrent(verifiedPayload.files, async (file) => {
      if (rootMissing) {
        repair.add(file.path);
        return;
      }
      const fullPath = `${rootPath}/${file.path}`;
      const beforeStat = await fileStat(adapter, fullPath, metrics);
      const indexedStat = useIndex ? indexed.get(file.path) : null;
      if (
        indexedStat &&
        indexedStat.size === file.size &&
        beforeStat &&
        sameStatTuple(indexedStat, beforeStat) &&
        beforeStat.size === file.size
      ) {
        skippedStatFiles += 1;
        verified.set(file.path, { stat: beforeStat });
        return;
      }
      touched.add(file.path);
      const result = await inspectAsset(adapter, fullPath, file, beforeStat, metrics);
      verified.set(file.path, { stat: result.stat });
      if (!result.matches || !result.stable) repair.add(file.path);
    });

    const observedIndex = statIndexRows(verifiedPayload, verified);
    if (
      manifestMatches &&
      useIndex &&
      repair.size === 0 &&
      sameStatIndexRows(marker.statIndex, observedIndex)
    ) {
      metrics.cacheHit = true;
      metrics.statCacheFiles = skippedStatFiles;
      metrics.elapsedMs = Date.now() - startedAt;
      return {
        rootPath,
        webRoot: `${rootPath}/web`,
        version: verifiedPayload.id,
        contentHash: verifiedPayload.contentHash,
        metrics,
      };
    }

    // Keep a completion marker only for a fully verified cache. A stale marker
    // is removed before any repair begins, and any failure leaves it absent.
    if (markerExists) await adapter.remove(markerPath);

    const repairFiles = verifiedPayload.files.filter((file) => repair.has(file.path));
    const hadRepairs = repairFiles.length > 0;
    // Only unrelated translations may be deferred. Keep every PDF parser,
    // font, cmap, image and fallback language available before releasing a Viewer.
    const language = String(options.language || "en-US").toLowerCase().split("-")[0];
    const isStartup = (file) => !file.path.startsWith("web/locale/") ||
      !file.path.endsWith("/viewer.ftl") ||
      file.path.toLowerCase().startsWith("web/locale/en-us/") ||
      file.path.toLowerCase().startsWith(`web/locale/${language}-`) ||
      file.path.toLowerCase().startsWith(`web/locale/${language}/`);
    const groups = options.onStartupReady
      ? [repairFiles.filter(isStartup), repairFiles.filter(file => !isStartup(file))]
      : [repairFiles];
    const memoryFiles = new Map();
    const written = new Set();
    const decode = async file => {
      if (memoryFiles.has(file.path)) return memoryFiles.get(file.path);
      const bytes = await decodePayloadFile(file, metrics);
      metrics.decodedFiles += 1;
      metrics.decodedBytes += bytes.byteLength;
      return bytes;
    };
    const repairFile = async file => {
      if (written.has(file.path)) return;
      const bytes = await decode(file);
      const fullPath = `${rootPath}/${file.path}`;
      const parentPath = fullPath.slice(0, fullPath.lastIndexOf("/"));
      const directoryStarted = assetNow();
      await prepareDirectory(parentPath);
      metrics.directoryMs += assetNow() - directoryStarted;
      const writeStarted = assetNow();
      try { await adapter.writeBinary(fullPath, bytesToArrayBuffer(bytes)); }
      finally { metrics.writeMs += assetNow() - writeStarted; }
      metrics.bytesWritten += bytes.byteLength;
      metrics.repairedFiles += 1;
      touched.add(file.path);
      const writeStat = await fileStat(adapter, fullPath, metrics);
      const result = await inspectAsset(adapter, fullPath, file, writeStat, metrics);
      if (!result.matches || !result.stable) {
        throw new Error(
          `Viewer asset failed verification after writing: ${file.path}`,
        );
      }
      verified.set(file.path, { stat: result.stat });
      written.add(file.path);
    };
    const releaseStartup = () => options.onStartupReady({ rootPath, webRoot: `${rootPath}/web`,
      version: verifiedPayload.id, contentHash: verifiedPayload.contentHash,
      ...(memoryFiles.size ? { memoryFiles } : {}),
      metrics: { ...metrics, startupReadyMs: Date.now() - startedAt,
        elapsedMs: Date.now() - startedAt, deferredFiles: repairFiles.filter(file => !isStartup(file)).length } });
    const memoryStartup = rootMissing && options.memoryStartup && options.onStartupReady;
    if (memoryStartup) {
      if (verifiedPayload.startupPack) {
        if (typeof verifiedPayload.startupPack !== "string" || verifiedPayload.startupPack.length > Math.ceil(MAX_TOTAL_SIZE / 3) * 4) {
          throw new Error("Invalid startup asset pack size");
        }
        const decompressStarted = assetNow();
        const packed = await decompressBounded(decodeCanonicalBase64(verifiedPayload.startupPack, "startup pack"),
          { path: "startup pack", size: verifiedPayload.files.reduce((size, file) => size + file.size, 0) });
        metrics.decompressMs += assetNow() - decompressStarted;
        let offset = 0;
        const entries = verifiedPayload.files.map(file => {
          const bytes = packed.subarray(offset, offset + file.size);
          offset += file.size;
          return { file, bytes };
        });
        await forEachConcurrent(entries, async ({ file, bytes }) => {
          const started = assetNow();
          if (await assetDigest(bytes) !== file.sha256) throw new Error(`Startup asset failed integrity verification: ${file.path}`);
          metrics.hashMs += assetNow() - started;
          metrics.decodedFiles += 1;
          metrics.decodedBytes += bytes.byteLength;
          memoryFiles.set(file.path, bytes);
        });
      } else {
        await forEachConcurrent(verifiedPayload.files.filter(isStartup), async file => {
          memoryFiles.set(file.path, await decode(file));
        });
      }
      releaseStartup();
    }
    for (let group = 0; group < groups.length; group += 1) {
    await forEachConcurrent(groups[group], repairFile);
    if (group === 0 && options.onStartupReady) {
      if (!memoryStartup) releaseStartup();
    }
    }

    // Before committing the marker, recheck only files that needed hashing or
    // repair. Unchanged indexed files already had one current stat read, and a
    // second whole-tree metadata sweep cannot make that snapshot atomic.
    const finalRepair = new Set();
    const touchedFiles = verifiedPayload.files.filter((file) =>
      touched.has(file.path),
    );
    await forEachConcurrent(touchedFiles, async (file) => {
      const fullPath = `${rootPath}/${file.path}`;
      const priorStat = verified.get(file.path)?.stat || null;
      const currentStat = await fileStat(adapter, fullPath, metrics);
      if (
        priorStat &&
        currentStat &&
        sameStatTuple(priorStat, currentStat)
      ) {
        verified.set(file.path, { stat: currentStat });
        return;
      }
      if (!priorStat && !currentStat) {
        // A warm full-SHA scan or marker migration already verified this
        // file. Preserve the old post-repair tree check when writes occurred,
        // but don't hash an intact tree twice just to refresh its index.
        if (!hadRepairs) return;
        const result = await inspectAsset(adapter, fullPath, file, null, metrics);
        verified.set(file.path, { stat: result.stat });
        if (!result.matches || !result.stable) finalRepair.add(file.path);
        return;
      }
      const result = await inspectAsset(adapter, fullPath, file, currentStat, metrics);
      verified.set(file.path, { stat: result.stat });
      if (!result.matches || !result.stable) finalRepair.add(file.path);
    });
    if (finalRepair.size > 0) {
      await forEachConcurrent(
        verifiedPayload.files.filter((file) => finalRepair.has(file.path)),
        async (file) => {
          const bytes = await decodePayloadFile(file, metrics);
          metrics.decodedFiles += 1;
          metrics.decodedBytes += bytes.byteLength;
          const fullPath = `${rootPath}/${file.path}`;
          const parentPath = fullPath.slice(0, fullPath.lastIndexOf("/"));
          const directoryStarted = assetNow();
          await prepareDirectory(parentPath);
          metrics.directoryMs += assetNow() - directoryStarted;
          const writeStarted = assetNow();
          try { await adapter.writeBinary(fullPath, bytesToArrayBuffer(bytes)); }
          finally { metrics.writeMs += assetNow() - writeStarted; }
          metrics.bytesWritten += bytes.byteLength;
          metrics.repairedFiles += 1;
          touched.add(file.path);
          const writeStat = await fileStat(adapter, fullPath, metrics);
          const result = await inspectAsset(adapter, fullPath, file, writeStat, metrics);
          if (!result.matches || !result.stable) {
            throw new Error(`Viewer asset changed while repairing: ${file.path}`);
          }
          verified.set(file.path, { stat: result.stat });
        },
      );
      // A repeated mutation is not silently retried. The marker stays absent.
      for (const file of verifiedPayload.files.filter((entry) =>
        finalRepair.has(entry.path),
      )) {
        const previous = verified.get(file.path)?.stat || null;
        const current = await fileStat(adapter, `${rootPath}/${file.path}`, metrics);
        if (previous && current && !sameStatTuple(previous, current)) {
          throw new Error(`Viewer asset changed before cache commit: ${file.path}`);
        }
      }
    }

    const expectedMarker = markerContent(
      verifiedPayload,
      statIndexRows(verifiedPayload, verified),
    );
    await adapter.write(markerPath, expectedMarker);
  } catch (error) {
    // Some adapters may report a marker write error after creating the file.
    try {
      if (await adapter.exists(markerPath)) {
        await adapter.remove(markerPath);
      }
    } catch {
      // Preserve the extraction error; a later retry will repair any partial tree.
    }
    throw error;
  }

  metrics.elapsedMs = Date.now() - startedAt;
  return {
    rootPath,
    webRoot: `${rootPath}/web`,
    version: verifiedPayload.id,
    contentHash: verifiedPayload.contentHash,
    metrics,
  };
}

function ensureViewerAssets(adapter, pluginRoot, payload, options = {}) {
  let safePluginRoot;
  let verifiedPayload;
  try {
    assertAdapter(adapter);
    safePluginRoot = validatePluginRoot(pluginRoot);
    // Validate and compute a safe key before consulting the lock table.
    verifiedPayload = validatePayload(payload);
  } catch (error) {
    return Promise.reject(error);
  }
  const rootPath = assetCacheRoot(safePluginRoot, verifiedPayload, options?.compactPath === true);
  let adapterLocks = activeLocks.get(adapter);
  if (!adapterLocks) {
    adapterLocks = new Map();
    activeLocks.set(adapter, adapterLocks);
  }
  const pending = adapterLocks.get(rootPath);
  if (pending) {
    const forceVerify = options?.forceVerify === true;
    if (forceVerify && pending.forceVerify !== true) {
      return pending.catch(() => undefined).then(async () => {
        while (true) {
          const currentLocks = activeLocks.get(adapter);
          const active = currentLocks?.get(rootPath);
          if (active?.forceVerify === true) return active;
          if (!active) {
            return startAssetExtraction(
              adapter,
              currentLocks || adapterLocks,
              rootPath,
              safePluginRoot,
              verifiedPayload,
              true,
            );
          }
          await active.catch(() => undefined);
        }
      });
    }
    return pending;
  }

  return startAssetExtraction(
    adapter,
    adapterLocks,
    rootPath,
    safePluginRoot,
    verifiedPayload,
    options?.forceVerify === true,
    options,
  );
}

function startAssetExtraction(
  adapter,
  adapterLocks,
  rootPath,
  safePluginRoot,
  verifiedPayload,
  forceVerify,
  options = {},
) {
  let currentLocks = activeLocks.get(adapter);
  if (!currentLocks) {
    currentLocks = adapterLocks || new Map();
    activeLocks.set(adapter, currentLocks);
  }
  const alreadyActive = currentLocks.get(rootPath);
  if (alreadyActive) return alreadyActive;
  const extraction = Promise.resolve()
    .then(() =>
      extractOrRepair(adapter, rootPath, verifiedPayload, {
        forceVerify,
        language: options.language,
        onStartupReady: options.onStartupReady,
        memoryStartup: options.memoryStartup,
      }),
    )
    .finally(() => {
      if (currentLocks.get(rootPath) === extraction) {
        currentLocks.delete(rootPath);
      }
      if (currentLocks.size === 0 && activeLocks.get(adapter) === currentLocks) {
        activeLocks.delete(adapter);
      }
    });
  extraction.forceVerify = forceVerify;
  currentLocks.set(rootPath, extraction);
  return extraction;
}

module.exports = {
  computeContentHash,
  ensureViewerAssets,
  sha256Bytes,
  validateAssetPath,
};
