/*
 * Copyright 2026 XxX-42 and contributors
 * SPDX-License-Identifier: Apache-2.0
 * SHA-256 uses the MIT-licensed @noble/hashes package, pinned by package.json.
 */
const { sha256 } = require("@noble/hashes/sha2");

const MAX_FILE_SIZE = 128 * 1024 * 1024;
const MAX_TOTAL_SIZE = 512 * 1024 * 1024;
const activeLocks = new WeakMap();
const encoder = new TextEncoder();

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
  if (
    typeof base64 !== "string" ||
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      base64,
    ) ||
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

  return { schema: 1, id, contentHash: payload.contentHash, files };
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

async function decodePayloadFile(file) {
  const compressed = decodeCanonicalBase64(file.gzipBase64, file.path);
  const bytes = await decompressBounded(compressed, file);
  if (sha256Bytes(bytes) !== file.sha256) {
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

async function ensureDirectory(adapter, directoryPath) {
  const segments = directoryPath.split("/");
  let currentPath = "";
  for (const segment of segments) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    if (!(await adapter.exists(currentPath))) {
      await adapter.mkdir(currentPath);
    }
  }
}

async function fileMatches(adapter, fullPath, expected) {
  if (!(await adapter.exists(fullPath))) {
    return false;
  }
  const actual = bytesView(await adapter.readBinary(fullPath), fullPath);
  return (
    actual.byteLength === expected.size && sha256Bytes(actual) === expected.sha256
  );
}

function markerContent(payload) {
  const manifestFiles = [...payload.files]
    .map(({ path, size, sha256 }) => ({ path, size, sha256 }))
    .sort((left, right) => comparePaths(left.path, right.path));
  return `${JSON.stringify(
    {
      schema: payload.schema,
      id: payload.id,
      contentHash: payload.contentHash,
      fileCount: manifestFiles.length,
      files: manifestFiles,
    },
    null,
    2,
  )}\n`;
}

async function extractOrRepair(adapter, pluginRoot, payload) {
  const verifiedPayload = validatePayload(payload);
  const rootPath = `${pluginRoot}/.asset-cache/${verifiedPayload.id}/${verifiedPayload.contentHash}`;
  const markerPath = `${rootPath}/.complete.json`;

  // Remove the marker before reading or repairing any asset. If decompression,
  // a vault write, or final verification fails, the partial tree stays uncommitted.
  if (await adapter.exists(markerPath)) {
    await adapter.remove(markerPath);
  }

  try {
    for (const file of verifiedPayload.files) {
      const bytes = await decodePayloadFile(file);
      const fullPath = `${rootPath}/${file.path}`;
      const expected = { size: file.size, sha256: file.sha256 };
      const parentPath = fullPath.slice(0, fullPath.lastIndexOf("/"));
      await ensureDirectory(adapter, parentPath);
      if (!(await fileMatches(adapter, fullPath, expected))) {
        await adapter.writeBinary(fullPath, bytesToArrayBuffer(bytes));
        if (!(await fileMatches(adapter, fullPath, expected))) {
          throw new Error(
            `Viewer asset failed verification after writing: ${file.path}`,
          );
        }
      }
    }

    // Recheck the complete tree before committing the completion marker.
    for (const file of verifiedPayload.files) {
      if (!(await fileMatches(adapter, `${rootPath}/${file.path}`, file))) {
        throw new Error(`Viewer asset is missing or damaged: ${file.path}`);
      }
    }
    await adapter.write(markerPath, markerContent(verifiedPayload));
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

  return {
    rootPath,
    webRoot: `${rootPath}/web`,
    version: verifiedPayload.id,
    contentHash: verifiedPayload.contentHash,
  };
}

function ensureViewerAssets(adapter, pluginRoot, payload) {
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
  const rootPath = `${safePluginRoot}/.asset-cache/${verifiedPayload.id}/${verifiedPayload.contentHash}`;
  let adapterLocks = activeLocks.get(adapter);
  if (!adapterLocks) {
    adapterLocks = new Map();
    activeLocks.set(adapter, adapterLocks);
  }
  const pending = adapterLocks.get(rootPath);
  if (pending) {
    return pending;
  }

  const extraction = Promise.resolve()
    .then(() => extractOrRepair(adapter, safePluginRoot, verifiedPayload))
    .finally(() => {
      if (adapterLocks.get(rootPath) === extraction) {
        adapterLocks.delete(rootPath);
      }
      if (adapterLocks.size === 0) {
        activeLocks.delete(adapter);
      }
    });
  adapterLocks.set(rootPath, extraction);
  return extraction;
}

module.exports = {
  computeContentHash,
  ensureViewerAssets,
  sha256Bytes,
  validateAssetPath,
};
