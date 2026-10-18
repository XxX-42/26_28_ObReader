/* Pure Web API resource decoding. No personal vocabulary or PDF state. */
const DEFAULT_DICTIONARY_ROOT = "00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v2";
const NORMALIZATION = "nfc-lower-space-v1";

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
function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "pdf-reader-dictionary-resource" ||
      value.dictionaryId !== "ECDICT" || value.normalization !== NORMALIZATION ||
      !Number.isSafeInteger(value.entryCount) || value.entryCount < 1 ||
      !Number.isSafeInteger(value.compressedBytes) || value.compressedBytes < 1 ||
      !Number.isSafeInteger(value.uncompressedBytes) || value.uncompressedBytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(value.sha256 || "") ||
      value.resourceFile !== `entries.${value.sha256}.jsonl.gz`) {
    throw dictionaryError("Dictionary resource manifest is malformed or unsupported.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  return value;
}
function generationId(manifest) {
  return `${manifest.dictionaryId}:${NORMALIZATION}:${manifest.sha256}`;
}
async function verifyResource(manifest, value) {
  const bytes = asBytes(value);
  if (bytes.byteLength !== manifest.compressedBytes) {
    throw dictionaryError("Dictionary resource has not completely synchronized.", "DICTIONARY_RESOURCE_CORRUPT");
  }
  if (!globalThis.crypto?.subtle) {
    throw dictionaryError("SHA-256 verification is unavailable.", "DICTIONARY_INTEGRITY_UNAVAILABLE");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map(part => part.toString(16).padStart(2, "0")).join("");
  if (hex !== manifest.sha256) {
    throw dictionaryError("Dictionary resource SHA-256 does not match its manifest.", "DICTIONARY_RESOURCE_CORRUPT");
  }
  return bytes;
}

/** Stream JSONL in bounded batches instead of allocating a 770k-entry array. */
async function decodeResource(manifest, bytes, onBatch, { batchSize = 1000, checkCancelled = () => {}, collectProfile = false } = {}) {
  if (typeof globalThis.DecompressionStream !== "function" || typeof globalThis.Blob !== "function") {
    throw dictionaryError("This WebView does not provide gzip decompression.", "DICTIONARY_GZIP_UNAVAILABLE");
  }
  let reader;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", lastKey = "", count = 0, uncompressedBytes = 0, batch = [];
  let streamReadMs = 0, callbackMs = 0;
  const now = collectProfile ? () => globalThis.performance?.now?.() ?? Date.now() : null;
  const decodeStartedAt = now ? now() : 0;
  async function sendBatch(entries, progress) {
    const callbackStartedAt = now ? now() : 0;
    await onBatch(entries, progress);
    if (now) callbackMs += now() - callbackStartedAt;
  }
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
      await sendBatch(batch, { count, lastKey });
      batch = [];
    }
  }
  try {
    reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    while (true) {
      checkCancelled();
      const readStartedAt = now ? now() : 0;
      const chunk = await reader.read();
      if (now) streamReadMs += now() - readStartedAt;
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
    if (batch.length) await sendBatch(batch, { count, lastKey });
    const jsonlValidationMs = now
      ? Math.max(0, now() - decodeStartedAt - streamReadMs - callbackMs)
      : 0;
    return { count, lastKey, ...(now ? { profile: { streamReadMs, jsonlValidationMs } } : {}) };
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
module.exports = { DEFAULT_DICTIONARY_ROOT, NORMALIZATION, VocabularyDictionaryError, dictionaryError,
  normalizeDictionaryKey, asBytes, validateManifest, generationId, verifyResource, decodeResource };
