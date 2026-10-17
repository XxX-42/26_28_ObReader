/*
 * Read-only ECDICT lookup over Vault DataAdapter files.
 *
 * This is deliberately separate from VocabularyService: dictionary content is
 * shared reference data, while the vocabulary service owns personal learning
 * status and notes.
 */
const DEFAULT_DICTIONARY_ROOT = "00_Archive/21_VocabularyData/dictionaries/ECDICT/index-v1";
const DICTIONARY_KIND = "pdf-reader-ecdict-index";
const SHARD_KIND = "pdf-reader-ecdict-shard";

class VocabularyDictionaryError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.name = "VocabularyDictionaryError";
    this.code = code;
  }
}

function normalizeDictionaryKey(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase().normalize("NFC");
}

function dictionaryShardIdForTerm(value) {
  const points = [...normalizeDictionaryKey(value)].slice(0, 2);
  if (!points.length) return "";
  return points.map((point) => `u${point.codePointAt(0).toString(16).padStart(6, "0")}`).join("-");
}

function asBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("DataAdapter.readBinary() must return an ArrayBuffer or byte view.");
}

function dictionaryError(message, code, cause) {
  return new VocabularyDictionaryError(message, code, cause ? { cause } : undefined);
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    throw dictionaryError("Web Crypto SHA-256 is unavailable for dictionary integrity verification.",
      "DICTIONARY_INTEGRITY_UNAVAILABLE");
  }
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function gunzipUtf8(bytes) {
  const Decompress = globalThis.DecompressionStream;
  if (typeof Decompress !== "function" || typeof globalThis.Blob !== "function" ||
      typeof globalThis.Response !== "function") {
    throw dictionaryError("This WebView does not provide the gzip Web APIs required by ECDICT.",
      "DICTIONARY_GZIP_UNAVAILABLE");
  }
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new Decompress("gzip"));
    return new TextDecoder("utf-8", { fatal: true }).decode(await new Response(stream).arrayBuffer());
  } catch (error) {
    if (error?.code) throw error;
    throw dictionaryError("ECDICT shard gzip data is invalid.", "DICTIONARY_SHARD_CORRUPT", error);
  }
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.schemaVersion !== 1 || value.kind !== DICTIONARY_KIND ||
      value.shardScheme !== "first-two-codepoints-hex" ||
      !value.shards || typeof value.shards !== "object" || Array.isArray(value.shards)) {
    throw dictionaryError("ECDICT manifest has an unsupported or malformed schema.", "DICTIONARY_MANIFEST_CORRUPT");
  }
  for (const [id, descriptor] of Object.entries(value.shards)) {
    if (!/^u[0-9a-f]{6}(?:-u[0-9a-f]{6})?$/.test(id) || !descriptor ||
        descriptor.file !== `shards/${id}.json.gz` || !Number.isInteger(descriptor.entryCount) ||
        descriptor.entryCount < 0 || !/^[0-9a-f]{64}$/.test(descriptor.sha256 || "")) {
      throw dictionaryError(`ECDICT manifest shard descriptor is invalid: ${id}`, "DICTIONARY_MANIFEST_CORRUPT");
    }
  }
  return value;
}

class VocabularyDictionary {
  constructor({ adapter, root = DEFAULT_DICTIONARY_ROOT, maxCachedShards = 8 } = {}) {
    if (!adapter || typeof adapter.read !== "function" || typeof adapter.readBinary !== "function") {
      throw new TypeError("VocabularyDictionary requires an Obsidian DataAdapter with read() and readBinary().");
    }
    if (!Number.isInteger(maxCachedShards) || maxCachedShards < 1) {
      throw new RangeError("maxCachedShards must be a positive integer.");
    }
    this.adapter = adapter;
    this.root = String(root).replace(/\/+$/u, "");
    this.maxCachedShards = maxCachedShards;
    this.manifestPromise = null;
    this.shardCache = new Map();
    this.shardPromises = new Map();
  }

  async lookup(term) {
    const key = normalizeDictionaryKey(term);
    if (!key) return null;
    const manifest = await this._getManifest();
    const shardId = dictionaryShardIdForTerm(key);
    const descriptor = manifest.shards[shardId];
    if (!descriptor) return null;
    const entries = await this._getShard(shardId, descriptor);
    const entry = entries.get(key);
    return entry ? { key: entry.key, translation: entry.translation, phonetic: entry.phonetic, source: "ECDICT" } : null;
  }

  async _getManifest() {
    if (!this.manifestPromise) {
      this.manifestPromise = (async () => {
        const path = `${this.root}/manifest.json`;
        if (typeof this.adapter.exists === "function" && !(await this.adapter.exists(path))) {
          throw dictionaryError("ECDICT index manifest is missing.", "DICTIONARY_INDEX_MISSING");
        }
        let raw;
        try {
          raw = await this.adapter.read(path);
        } catch (error) {
          throw dictionaryError("Unable to read ECDICT index manifest.", "DICTIONARY_INDEX_MISSING", error);
        }
        try {
          return validateManifest(JSON.parse(raw));
        } catch (error) {
          if (error instanceof VocabularyDictionaryError) throw error;
          throw dictionaryError("ECDICT index manifest is not valid JSON.", "DICTIONARY_MANIFEST_CORRUPT", error);
        }
      })();
    }
    try {
      return await this.manifestPromise;
    } catch (error) {
      this.manifestPromise = null;
      throw error;
    }
  }

  async _getShard(shardId, descriptor) {
    if (this.shardCache.has(shardId)) {
      const value = this.shardCache.get(shardId);
      this.shardCache.delete(shardId);
      this.shardCache.set(shardId, value);
      return value;
    }
    if (this.shardPromises.has(shardId)) return this.shardPromises.get(shardId);
    const pending = this._loadShard(shardId, descriptor).then((entries) => {
      this.shardCache.set(shardId, entries);
      while (this.shardCache.size > this.maxCachedShards) {
        this.shardCache.delete(this.shardCache.keys().next().value);
      }
      return entries;
    }).finally(() => this.shardPromises.delete(shardId));
    this.shardPromises.set(shardId, pending);
    return pending;
  }

  async _loadShard(shardId, descriptor) {
    const path = `${this.root}/${descriptor.file}`;
    if (typeof this.adapter.exists === "function" && !(await this.adapter.exists(path))) {
      throw dictionaryError(`ECDICT shard is missing: ${shardId}`, "DICTIONARY_SHARD_MISSING");
    }
    let compressed;
    try {
      compressed = asBytes(await this.adapter.readBinary(path));
    } catch (error) {
      const missing = typeof this.adapter.exists !== "function";
      throw dictionaryError(`Unable to read ECDICT shard: ${shardId}`,
        missing ? "DICTIONARY_SHARD_MISSING" : "DICTIONARY_SHARD_READ_FAILED", error);
    }
    const digest = await sha256Hex(compressed);
    if (digest !== descriptor.sha256) {
      throw dictionaryError(`ECDICT shard integrity check failed: ${shardId}`, "DICTIONARY_SHARD_CORRUPT");
    }
    let shard;
    try {
      shard = JSON.parse(await gunzipUtf8(compressed));
    } catch (error) {
      if (error instanceof VocabularyDictionaryError) throw error;
      throw dictionaryError(`ECDICT shard JSON is invalid: ${shardId}`, "DICTIONARY_SHARD_CORRUPT", error);
    }
    if (!shard || shard.schemaVersion !== 1 || shard.kind !== SHARD_KIND ||
        shard.shardId !== shardId || !Array.isArray(shard.entries) ||
        shard.entries.length !== descriptor.entryCount) {
      throw dictionaryError(`ECDICT shard schema is invalid: ${shardId}`, "DICTIONARY_SHARD_CORRUPT");
    }
    const entries = new Map();
    for (const entry of shard.entries) {
      if (!entry || typeof entry.key !== "string" || normalizeDictionaryKey(entry.key) !== entry.key ||
          dictionaryShardIdForTerm(entry.key) !== shardId || typeof entry.translation !== "string" ||
          typeof entry.phonetic !== "string" || entries.has(entry.key)) {
        throw dictionaryError(`ECDICT shard contains an invalid entry: ${shardId}`, "DICTIONARY_SHARD_CORRUPT");
      }
      entries.set(entry.key, entry);
    }
    return entries;
  }

  clearCache() {
    this.shardCache.clear();
  }
}

module.exports = {
  DEFAULT_DICTIONARY_ROOT,
  VocabularyDictionary,
  VocabularyDictionaryError,
  normalizeDictionaryKey,
  dictionaryShardIdForTerm,
};
