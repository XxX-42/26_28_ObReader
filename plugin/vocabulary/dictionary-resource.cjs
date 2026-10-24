/* Pure Web API resource decoding. No personal vocabulary or PDF state. */
const DEFAULT_DICTIONARY_ROOT = "00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v3";
const LEGACY_DICTIONARY_ROOT = "00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v2";
const NORMALIZATION = "nfc-lower-space-v1";
const RESOURCE_KIND = "pdf-reader-dictionary-resource";

class VocabularyDictionaryError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "VocabularyDictionaryError";
    this.code = code;
  }
}
function dictionaryError(message, code, cause) {
  return new VocabularyDictionaryError(message, code, cause ? { cause } : undefined);
}
function normalizeDictionaryKey(value) {
  return typeof value === "string"
    ? value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase().normalize("NFC") : "";
}
function asBytes(value) {
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]") return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw dictionaryError("Dictionary resource is not binary data.", "DICTIONARY_RESOURCE_CORRUPT");
}
function validHash(value) { return /^[a-f0-9]{64}$/u.test(value || ""); }
function manifestIndexPayload(blocks) {
  return blocks.map(block => [block.firstKey, block.lastKey, block.entryCount, block.compressedBytes,
    block.uncompressedBytes, block.sha256, block.resourceFile].join("\u0000")).join("\n");
}
function validateManifest(value) {
  if (!value || value.kind !== RESOURCE_KIND || value.dictionaryId !== "ECDICT" ||
      value.normalization !== NORMALIZATION) {
    throw dictionaryError("Dictionary resource manifest is malformed or unsupported.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  if (value.schemaVersion === 1 && Number.isSafeInteger(value.entryCount) && value.entryCount > 0 &&
      Number.isSafeInteger(value.compressedBytes) && value.compressedBytes > 0 &&
      Number.isSafeInteger(value.uncompressedBytes) && value.uncompressedBytes > 0 &&
      validHash(value.sha256) && value.resourceFile === `entries.${value.sha256}.jsonl.gz`) return value;
  if (value.schemaVersion !== 3 ||
      !Number.isSafeInteger(value.entryCount) || value.entryCount < 1 ||
      !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes < 1 ||
      !Number.isSafeInteger(value.uncompressedBytes) || value.uncompressedBytes < 1 ||
      !validHash(value.sha256) || !Number.isSafeInteger(value.blockCount) || value.blockCount < 1 ||
      !Array.isArray(value.blocks) || value.blocks.length !== value.blockCount ||
      !Number.isSafeInteger(value.targetBlockBytes) || value.targetBlockBytes < 1) {
    throw dictionaryError("Dictionary resource manifest is malformed or unsupported.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  let entryCount = 0, compressedBytes = 0, uncompressedBytes = 0, lastKey = "";
  for (const block of value.blocks) {
    if (!block || typeof block.firstKey !== "string" || !block.firstKey ||
        typeof block.lastKey !== "string" || !block.lastKey || block.firstKey > block.lastKey ||
        normalizeDictionaryKey(block.firstKey) !== block.firstKey || normalizeDictionaryKey(block.lastKey) !== block.lastKey ||
        lastKey && block.firstKey <= lastKey ||
        !Number.isSafeInteger(block.entryCount) || block.entryCount < 1 ||
        !Number.isSafeInteger(block.compressedBytes) || block.compressedBytes < 1 ||
        !Number.isSafeInteger(block.uncompressedBytes) || block.uncompressedBytes < 1 ||
        !validHash(block.sha256) || block.resourceFile !== `blocks/block.${block.sha256}.jsonl.gz`) {
      throw dictionaryError("Dictionary block range index is malformed or unsorted.", "DICTIONARY_MANIFEST_CORRUPT");
    }
    lastKey = block.lastKey;
    entryCount += block.entryCount;
    compressedBytes += block.compressedBytes;
    uncompressedBytes += block.uncompressedBytes;
  }
  if (entryCount !== value.entryCount || compressedBytes !== value.compressedBytes ||
      uncompressedBytes !== value.uncompressedBytes) {
    throw dictionaryError("Dictionary block totals do not match the manifest.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  if (!value.source || value.source.format !== "resource-v2" || !validHash(value.source.sha256) ||
      !Number.isSafeInteger(value.source.entryCount) || value.source.entryCount !== value.entryCount ||
      !Number.isSafeInteger(value.source.compressedBytes) || value.source.compressedBytes < 1 ||
      !Number.isSafeInteger(value.source.uncompressedBytes) || value.source.uncompressedBytes < 1) {
    throw dictionaryError("Dictionary resource provenance is malformed.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  if (value.source.license !== undefined && (!value.source.license ||
      value.source.license.name !== "MIT" || value.source.license.file !== "../LICENSE-MIT.txt" ||
      !validHash(value.source.license.sha256))) {
    throw dictionaryError("Dictionary license provenance is malformed.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  return value;
}
function generationId(manifest) {
  return manifest.schemaVersion === 1
    ? `${manifest.dictionaryId}:${NORMALIZATION}:${manifest.sha256}`
    : `${manifest.dictionaryId}:${NORMALIZATION}:v3:${manifest.sha256}`;
}
async function verifyManifestIndex(manifest) {
  if (manifest.schemaVersion !== 3) return manifest;
  if (!globalThis.crypto?.subtle || typeof globalThis.TextEncoder !== "function") {
    throw dictionaryError("SHA-256 verification is unavailable.", "DICTIONARY_INTEGRITY_UNAVAILABLE");
  }
  const bytes = new TextEncoder().encode(manifestIndexPayload(manifest.blocks));
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map(part => part.toString(16).padStart(2, "0")).join("");
  if (hex !== manifest.sha256) {
    throw dictionaryError("Dictionary block index SHA-256 does not match its manifest.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  return manifest;
}
async function verifyCompressedPayload(expectedBytes, expectedHash, value) {
  const bytes = asBytes(value);
  if (bytes.byteLength !== expectedBytes) {
    throw dictionaryError("Dictionary resource has not completely synchronized.", "DICTIONARY_RESOURCE_CORRUPT");
  }
  if (!globalThis.crypto?.subtle) {
    throw dictionaryError("SHA-256 verification is unavailable.", "DICTIONARY_INTEGRITY_UNAVAILABLE");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map(part => part.toString(16).padStart(2, "0")).join("");
  if (hex !== expectedHash) {
    throw dictionaryError("Dictionary resource SHA-256 does not match its manifest.", "DICTIONARY_RESOURCE_CORRUPT");
  }
  return bytes;
}
async function verifyResource(manifest, value) {
  return verifyCompressedPayload(manifest.compressedBytes, manifest.sha256, value);
}

/** Verify and decode one independently checksummed v3 gzip JSONL range. */
async function decodeBlockResource(block, value, { batchSize = 256, checkCancelled = () => {}, yieldControl = async () => {} } = {}) {
  if (typeof globalThis.DecompressionStream !== "function" || typeof globalThis.Blob !== "function") {
    throw dictionaryError("This WebView does not provide gzip decompression.", "DICTIONARY_GZIP_UNAVAILABLE");
  }
  const bytes = await verifyCompressedPayload(block.compressedBytes, block.sha256, value);
  let reader;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", lastKey = "", count = 0, uncompressedBytes = 0;
  const entries = [];
  let estimate = 0;
  async function line(text) {
    if (!text) throw dictionaryError("Dictionary block contains an empty JSONL record.", "DICTIONARY_RESOURCE_CORRUPT");
    let entry;
    try { entry = JSON.parse(text); } catch (cause) {
      throw dictionaryError("Dictionary block contains malformed JSONL.", "DICTIONARY_RESOURCE_CORRUPT", cause);
    }
    if (!entry || typeof entry.key !== "string" || !entry.key || entry.key <= lastKey ||
        normalizeDictionaryKey(entry.key) !== entry.key || typeof entry.translation !== "string" ||
        typeof entry.phonetic !== "string" || Object.keys(entry).some(key => !["key", "translation", "phonetic"].includes(key))) {
      throw dictionaryError("Dictionary block records must contain unique, sorted, normalized keys and display fields.", "DICTIONARY_RESOURCE_CORRUPT");
    }
    lastKey = entry.key;
    count += 1;
    if (count > block.entryCount) throw dictionaryError("Dictionary block has too many entries.", "DICTIONARY_RESOURCE_CORRUPT");
    entries.push(entry);
    estimate += 64 + (entry.key.length + entry.translation.length + entry.phonetic.length) * 2;
    if (count % batchSize === 0) {
      checkCancelled();
      await yieldControl();
    }
  }
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    while (true) {
      checkCancelled();
      const chunk = await reader.read();
      if (chunk.done) break;
      uncompressedBytes += chunk.value.byteLength;
      if (uncompressedBytes > block.uncompressedBytes) throw dictionaryError("Dictionary block decompressed size exceeds its manifest.", "DICTIONARY_RESOURCE_CORRUPT");
      pending += decoder.decode(chunk.value, { stream: true });
      let offset = 0, newline;
      while ((newline = pending.indexOf("\n", offset)) !== -1) {
        await line(pending.slice(offset, newline));
        offset = newline + 1;
      }
      pending = pending.slice(offset);
      if (pending.length > 1024 * 1024) throw dictionaryError("Dictionary JSONL line exceeds its size limit.", "DICTIONARY_RESOURCE_CORRUPT");
    }
    pending += decoder.decode();
    if (pending) await line(pending);
    if (count !== block.entryCount || uncompressedBytes !== block.uncompressedBytes ||
        entries[0]?.key !== block.firstKey || lastKey !== block.lastKey) {
      throw dictionaryError("Dictionary block count, size, or range does not match its manifest.", "DICTIONARY_RESOURCE_CORRUPT");
    }
    return { entries, estimatedBytes: estimate, count, firstKey: entries[0].key, lastKey };
  } catch (cause) {
    if (typeof cause?.code === "string" && cause.code.startsWith("DICTIONARY_")) throw cause;
    throw dictionaryError("Dictionary gzip/UTF-8 block is invalid.", "DICTIONARY_RESOURCE_CORRUPT", cause);
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
  }
}

/** Stream JSONL in bounded batches instead of allocating a 770k-entry array. */
async function decodeResource(manifest, bytes, onBatch, { batchSize = 1000, checkCancelled = () => {} } = {}) {
  if (typeof globalThis.DecompressionStream !== "function" || typeof globalThis.Blob !== "function") {
    throw dictionaryError("This WebView does not provide gzip decompression.", "DICTIONARY_GZIP_UNAVAILABLE");
  }
  let reader;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", lastKey = "", count = 0, uncompressedBytes = 0, batch = [];
  async function line(text) {
    if (!text) throw dictionaryError("Dictionary resource has an empty JSONL record.", "DICTIONARY_RESOURCE_CORRUPT");
    let entry;
    try { entry = JSON.parse(text); } catch (cause) {
      throw dictionaryError("Dictionary resource contains malformed JSONL.", "DICTIONARY_RESOURCE_CORRUPT", cause);
    }
    if (!entry || typeof entry.key !== "string" || !entry.key || entry.key <= lastKey ||
        normalizeDictionaryKey(entry.key) !== entry.key || typeof entry.translation !== "string" ||
        typeof entry.phonetic !== "string" || Object.keys(entry).some(key => !["key", "translation", "phonetic"].includes(key))) {
      throw dictionaryError("Dictionary records must contain unique, sorted, normalized keys and display fields.", "DICTIONARY_RESOURCE_CORRUPT");
    }
    lastKey = entry.key;
    count += 1;
    if (count > manifest.entryCount) throw dictionaryError("Dictionary has too many entries.", "DICTIONARY_RESOURCE_CORRUPT");
    batch.push(entry);
    if (batch.length >= batchSize) {
      checkCancelled();
      await onBatch(batch, { count, lastKey });
      batch = [];
    }
  }
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    while (true) {
      checkCancelled();
      const chunk = await reader.read();
      if (chunk.done) break;
      uncompressedBytes += chunk.value.byteLength;
      if (uncompressedBytes > manifest.uncompressedBytes) throw dictionaryError("Dictionary decompressed size exceeds its manifest.", "DICTIONARY_RESOURCE_CORRUPT");
      pending += decoder.decode(chunk.value, { stream: true });
      let offset = 0, newline;
      while ((newline = pending.indexOf("\n", offset)) !== -1) {
        await line(pending.slice(offset, newline));
        offset = newline + 1;
      }
      pending = pending.slice(offset);
      if (pending.length > 1024 * 1024) throw dictionaryError("Dictionary JSONL line exceeds its size limit.", "DICTIONARY_RESOURCE_CORRUPT");
    }
    pending += decoder.decode();
    if (pending) await line(pending);
    if (count !== manifest.entryCount || uncompressedBytes !== manifest.uncompressedBytes) {
      throw dictionaryError("Dictionary entry count or uncompressed size is incomplete.", "DICTIONARY_RESOURCE_CORRUPT");
    }
    if (batch.length) await onBatch(batch, { count, lastKey });
    return { count, lastKey };
  } catch (cause) {
    if (typeof cause?.code === "string" && cause.code.startsWith("DICTIONARY_")) throw cause;
    throw dictionaryError("Dictionary gzip/UTF-8 resource is invalid.", "DICTIONARY_RESOURCE_CORRUPT", cause);
  } finally {
    if (reader) {
      try { await reader.cancel(); } catch {}
      reader.releaseLock();
    }
  }
}
module.exports = { DEFAULT_DICTIONARY_ROOT, LEGACY_DICTIONARY_ROOT, NORMALIZATION, VocabularyDictionaryError, dictionaryError,
  normalizeDictionaryKey, asBytes, validateManifest, manifestIndexPayload, generationId, verifyManifestIndex,
  verifyCompressedPayload, verifyResource, decodeResource, decodeBlockResource };
