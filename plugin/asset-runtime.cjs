/*
 * Copyright 2026 XxX-42 and contributors
 * SPDX-License-Identifier: Apache-2.0
 * Bundled third-party notices are preserved in the embedded viewer resources.
 */
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const MAX_FILE_SIZE = 128 * 1024 * 1024;
const MAX_TOTAL_SIZE = 512 * 1024 * 1024;
const activeLocks = new WeakMap();

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
  return crypto
    .createHash("sha256")
    .update(canonicalManifest(payload, files), "utf8")
    .digest("hex");
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
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        file.gzipBase64,
      )
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

  const foldedSorted = [...seenPaths].sort();
  if (foldedSorted.length !== files.length) {
    throw new Error("The viewer asset manifest contains duplicate paths.");
  }
  return { schema: 1, id, contentHash: payload.contentHash, files };
}

function toBuffer(value, label) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`${label} did not return binary data.`);
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function decodePayloadFiles(payload) {
  return payload.files.map((file) => {
    const compressed = Buffer.from(file.gzipBase64, "base64");
    if (compressed.toString("base64") !== file.gzipBase64) {
      throw new Error(
        `Non-canonical base64 data for viewer asset ${file.path}.`,
      );
    }
    let bytes;
    try {
      bytes = zlib.gunzipSync(compressed, { maxOutputLength: file.size + 1 });
    } catch (error) {
      throw new Error(
        `Unable to decompress viewer asset ${file.path}: ${error.message}`,
      );
    }
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) {
      throw new Error(
        `Embedded viewer asset failed integrity verification: ${file.path}`,
      );
    }
    return { path: file.path, size: file.size, sha256: file.sha256, bytes };
  });
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
  const actual = toBuffer(await adapter.readBinary(fullPath), fullPath);
  return (
    actual.byteLength === expected.size && sha256(actual) === expected.sha256
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
  const verifiedFiles = decodePayloadFiles(verifiedPayload);
  const rootPath = `${pluginRoot}/.asset-cache/${verifiedPayload.id}/${verifiedPayload.contentHash}`;
  const markerPath = `${rootPath}/.complete.json`;
  await ensureDirectory(adapter, rootPath);

  const marker = markerContent(verifiedPayload);
  let markerMatches = false;
  if (await adapter.exists(markerPath)) {
    try {
      markerMatches = (await adapter.read(markerPath)) === marker;
    } catch {
      markerMatches = false;
    }
  }

  const toRepair = [];
  for (const file of verifiedFiles) {
    const fullPath = `${rootPath}/${file.path}`;
    if (!(await fileMatches(adapter, fullPath, file))) {
      toRepair.push({ ...file, fullPath });
    }
  }

  if (toRepair.length === 0 && markerMatches) {
    return {
      rootPath,
      webRoot: `${rootPath}/web`,
      version: verifiedPayload.id,
      contentHash: verifiedPayload.contentHash,
    };
  }

  if (await adapter.exists(markerPath)) {
    await adapter.remove(markerPath);
  }

  for (const file of toRepair) {
    const parentPath = file.fullPath.slice(0, file.fullPath.lastIndexOf("/"));
    await ensureDirectory(adapter, parentPath);
    await adapter.writeBinary(file.fullPath, toArrayBuffer(file.bytes));
    if (!(await fileMatches(adapter, file.fullPath, file))) {
      throw new Error(
        `Viewer asset failed verification after writing: ${file.path}`,
      );
    }
  }

  // Recheck the complete tree before committing the completion marker. This
  // keeps a partial extraction or an externally changed asset uncommitted.
  for (const file of verifiedFiles) {
    if (!(await fileMatches(adapter, `${rootPath}/${file.path}`, file))) {
      throw new Error(`Viewer asset is missing or damaged: ${file.path}`);
    }
  }
  await adapter.write(markerPath, marker);

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
  validateAssetPath,
};
