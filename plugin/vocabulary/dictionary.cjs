/* Vault resources are authoritative; IndexedDB is a disposable local index. */
const { DictionaryQueryCache, DEFAULT_CACHE_NAME } = require("./dictionary-cache.cjs");
const { DEFAULT_DICTIONARY_ROOT, LEGACY_DICTIONARY_ROOT, VocabularyDictionaryError, dictionaryError, normalizeDictionaryKey,
  validateManifest, generationId, verifyManifestIndex, decodeBlockResource, asBytes } = require("./dictionary-resource.cjs");
const WORKER_SOURCE = typeof __PDF_DICTIONARY_WORKER_SOURCE__ === "string" ? __PDF_DICTIONARY_WORKER_SOURCE__ : null;

// Only explicit adapter/DOM not-found signals permit compatibility fallback.
// Permissions, transient I/O and unknown failures must remain observable.
function dictionaryReadError(cause, manifest = false) {
  const missing = cause?.code === "ENOENT" || cause?.name === "NotFoundError";
  if (missing) return dictionaryError(manifest
    ? "Dictionary resource manifest has not synchronized yet."
    : "Dictionary resource has not synchronized yet.",
    manifest ? "DICTIONARY_INDEX_MISSING" : "DICTIONARY_RESOURCE_MISSING", cause);
  return dictionaryError(manifest
    ? "Dictionary resource manifest could not be read."
    : "Dictionary resource could not be read.",
    manifest ? "DICTIONARY_INDEX_READ_FAILED" : "DICTIONARY_RESOURCE_READ_FAILED", cause);
}

class VocabularyDictionary {
  constructor({ adapter, root = DEFAULT_DICTIONARY_ROOT, legacyRoot, cache, cacheName = DEFAULT_CACHE_NAME,
    workerSource = WORKER_SOURCE, WorkerClass = globalThis.Worker, onStatus = () => {},
    blockCacheMaxBlocks = 16, blockCacheMaxBytes = 8 * 1024 * 1024, workerStartupTimeoutMs = 5000 } = {}) {
    if (!adapter || typeof adapter.read !== "function" || typeof adapter.readBinary !== "function") {
      throw new TypeError("VocabularyDictionary requires a Vault DataAdapter with read() and readBinary().");
    }
    this.adapter = adapter;
    this.root = String(root).replace(/\/+$/u, "");
    this.legacyRoot = String(legacyRoot || (this.root.endsWith("/resource-v3")
      ? this.root.replace(/resource-v3$/u, "resource-v2")
      : this.root === DEFAULT_DICTIONARY_ROOT ? LEGACY_DICTIONARY_ROOT : this.root)).replace(/\/+$/u, "");
    this.cache = cache || new DictionaryQueryCache({ name: cacheName });
    this.cacheName = cacheName;
    this.workerSource = workerSource;
    this.WorkerClass = WorkerClass;
    this.blockCacheMaxBlocks = Math.max(0, Math.floor(blockCacheMaxBlocks));
    this.blockCacheMaxBytes = Math.max(0, Math.floor(blockCacheMaxBytes));
    this.workerStartupTimeoutMs = Math.max(1, Number(workerStartupTimeoutMs) || 5000);
    this.blockCache = new Map();
    this.blockCacheBytes = 0;
    this.blockLoads = new Map();
    this.blockWorker = null;
    this.blockWorkerReady = null;
    this.blockWorkerUrl = null;
    this.blockWorkerUnavailable = false;
    this.blockWorkerRequests = new Map();
    this.blockWorkerSequence = 0;
    this.listeners = new Set([onStatus]);
    this.status = { phase: "idle", count: 0, total: 0 };
    this.manifestPromise = null;
    this.pending = null;
    this.disposed = false;
    this.worker = null;
    this.abortController = new AbortController();
    this.readyGeneration = null;
    this.revision = 0;
  }
  getStatus() { return { ...this.status }; }
  subscribe(callback) {
    this.listeners.add(callback);
    callback(this.getStatus());
    return () => this.listeners.delete(callback);
  }
  emit(status) {
    if (this.disposed) return;
    const percent = value => value.total ? Math.floor(value.count / value.total * 100) : 0;
    const unchanged = this.status.phase === status.phase && this.status.total === status.total &&
      this.status.code === status.code && this.status.entryCount === status.entryCount &&
      this.status.resourceStatusCode === status.resourceStatusCode && this.status.source === status.source &&
      percent(this.status) === percent(status);
    this.status = { ...status };
    if (unchanged) return;
    for (const listener of this.listeners) { try { listener(this.getStatus()); } catch {} }
  }
  emitResourceAvailable(entryCount) {
    // A verified v3 manifest makes the dictionary usable without importing a
    // full IndexedDB generation. Keep a successful lookup's stronger state.
    if ((this.status.phase === "ready" && this.status.code === "DICTIONARY_RESOURCE_V3_READY") ||
        (this.status.phase === "degraded" && this.status.code === "DICTIONARY_RESOURCE_V2_FALLBACK")) return;
    this.emit({ phase: "resource-available", count: 0, total: 0,
      code: "DICTIONARY_RESOURCE_AVAILABLE", entryCount });
  }
  emitResourceReady(entryCount) {
    this.emit({ phase: "ready", count: 0, total: 0,
      code: "DICTIONARY_RESOURCE_V3_READY", entryCount });
  }
  emitVerifiedV2Fallback(resourceError, generation) {
    this.emit({ phase: "degraded", count: generation.count, total: generation.count,
      code: "DICTIONARY_RESOURCE_V2_FALLBACK",
      resourceStatusCode: resourceError?.code || "DICTIONARY_RESOURCE_UNAVAILABLE",
      source: "resource-v2-cache" });
  }
  emitUnavailable(error) {
    if (this.disposed || ["DICTIONARY_CACHE_CANCELLED", "DICTIONARY_CACHE_RETRY", "DICTIONARY_CACHE_NOT_REQUIRED"].includes(error?.code)) return;
    this.emit({ phase: "unavailable", count: 0, total: 0,
      code: error?.code || "DICTIONARY_CACHE_UNAVAILABLE" });
  }
  resourceAvailableResult(manifest) {
    return { status: "resource-available", count: manifest.entryCount, warmed: false, result: null };
  }
  async manifest() {
    if (!this.manifestPromise) {
      const pending = this.readManifestAt(this.root).catch(error => {
        if (this.manifestPromise === pending) this.manifestPromise = null;
        throw error;
      });
      this.manifestPromise = pending;
    }
    return this.manifestPromise;
  }
  async readManifestAt(root) {
    let raw;
    try { raw = await this.adapter.read(`${root}/manifest.json`); }
    catch (cause) { throw dictionaryReadError(cause, true); }
    let manifest;
    try { manifest = validateManifest(JSON.parse(raw)); }
    catch (cause) {
      if (cause?.code) throw cause;
      throw dictionaryError("Dictionary manifest is invalid JSON.", "DICTIONARY_MANIFEST_CORRUPT", cause);
    }
    return verifyManifestIndex(manifest);
  }
  async loadBytes(manifest) {
    let raw;
    try { raw = await this.adapter.readBinary(`${this.root}/${manifest.resourceFile}`); }
    catch (cause) { throw dictionaryReadError(cause); }
    return asBytes(raw);
  }
  async lookup(term) {
    const key = normalizeDictionaryKey(term);
    if (!key) return null;
    return this.lookupKey(key, 0);
  }
  async warmup(term) { return term === undefined ? this.checkAvailability() : this.lookup(term); }
  async checkAvailability() {
    const revision = this.revision;
    try {
      // Start the Resource-v3 decoder while the manifest is being read. This
      // lets a first lookup race against both tasks instead of paying for a
      // cold Worker only after DataAdapter I/O has completed.
      const manifestTask = this.manifest();
      if (this.root.endsWith("/resource-v3")) void this.ensureBlockWorker();
      let manifest;
      try { manifest = await manifestTask; }
      catch (error) {
        if (error?.code !== "DICTIONARY_INDEX_MISSING" || this.legacyRoot === this.root) throw error;
        manifest = await this.readManifestAt(this.legacyRoot);
      }
      this.assertCurrent(revision);
      if (manifest.schemaVersion === 3) {
        this.emitResourceAvailable(manifest.entryCount);
        // Start the block decoder while the plugin is idle so the first word
        // tap does not pay the Worker creation/ready handshake. This is
        // deliberately fire-and-forget: availability must not wait on Worker
        // startup, and lookup retains the existing cooperative fallback.
        void this.ensureBlockWorker();
        return this.resourceAvailableResult(manifest);
      }
      const ready = await this.cache.ready(manifest);
      this.assertCurrent(revision);
      if (!ready) throw dictionaryError("A verified resource-v3 or an already prepared matching v2 cache is required.",
        "DICTIONARY_CACHE_NOT_READY");
      this.emit({ phase: "ready", count: ready.count, total: ready.count });
      return ready;
    } catch (error) {
      this.assertCurrent(revision);
      this.emitUnavailable(error);
      throw error;
    }
  }
  async lookupKey(key, retries) {
    const revision = this.revision;
    try {
      let manifest, baseRoot = this.root;
      try { manifest = await this.manifest(); }
      catch (primaryError) {
        if (primaryError?.code !== "DICTIONARY_INDEX_MISSING" || this.legacyRoot === this.root) throw primaryError;
        try {
          manifest = await this.readManifestAt(this.legacyRoot);
          baseRoot = this.legacyRoot;
        } catch (legacyError) {
          if (legacyError?.code === "DICTIONARY_INDEX_MISSING") throw primaryError;
          throw legacyError;
        }
      }
      this.assertCurrent(revision);
      if (manifest.schemaVersion === 3) {
        this.emitResourceAvailable(manifest.entryCount);
        let result;
        try {
          result = await this.lookupV3(manifest, baseRoot, key, revision);
        } catch (blockError) {
          if (!["DICTIONARY_RESOURCE_MISSING", "DICTIONARY_RESOURCE_CORRUPT",
            "DICTIONARY_GZIP_UNAVAILABLE", "DICTIONARY_INTEGRITY_UNAVAILABLE"].includes(blockError?.code)) throw blockError;
          const fallback = await this.lookupCompatibleReadyV2(manifest, key, revision);
          if (!fallback) throw blockError;
          this.emitVerifiedV2Fallback(blockError, fallback.generation);
          return fallback.result;
        }
        this.assertCurrent(revision);
        this.emitResourceReady(manifest.entryCount);
        return result;
      }
      // A v2 resource remains readable through a previously verified Dexie
      // generation. A lookup never starts the legacy full-resource import.
      const ready = await this.cache.ready(manifest);
      this.assertCurrent(revision);
      if (ready) {
        const result = await this.cache.lookup(ready.id, key);
        this.assertCurrent(revision);
        this.readyGeneration = ready;
        this.emit({ phase: "ready", count: ready.count, total: ready.count });
        return result;
      }
      throw dictionaryError("ECDICT resource-v3 is not installed and no verified resource-v2 cache is ready.",
        "DICTIONARY_CACHE_NOT_READY");
    } catch (error) {
      // An asynchronous failure belongs to the generation that started it.
      // Fence it before it can publish status or escape as a current failure.
      try { this.assertCurrent(revision); } catch (currentError) { error = currentError; }
      if (error?.code === "DICTIONARY_CACHE_RETRY" && retries < 1 && !this.disposed) return this.lookupKey(key, retries + 1);
      this.emitUnavailable(error);
      if (error?.code) throw error;
      throw dictionaryError("The dictionary query is unavailable.", "DICTIONARY_CACHE_UNAVAILABLE", error);
    }
  }
  assertCurrent(revision) {
    if (this.disposed) throw dictionaryError("Dictionary service has been disposed.", "DICTIONARY_CACHE_CANCELLED");
    if (revision !== this.revision) throw dictionaryError("Dictionary generation changed; retry the lookup.", "DICTIONARY_CACHE_RETRY");
  }
  async lookupCompatibleReadyV2(v3Manifest, key, revision) {
    let legacyManifest;
    try { legacyManifest = await this.readManifestAt(this.legacyRoot); }
    catch { return null; }
    const source = v3Manifest.source;
    if (legacyManifest.schemaVersion !== 1 || legacyManifest.dictionaryId !== v3Manifest.dictionaryId ||
        legacyManifest.normalization !== v3Manifest.normalization || legacyManifest.sha256 !== source.sha256 ||
        legacyManifest.entryCount !== source.entryCount || legacyManifest.compressedBytes !== source.compressedBytes ||
        legacyManifest.uncompressedBytes !== source.uncompressedBytes) return null;
    this.assertCurrent(revision);
    let generation;
    try { generation = await this.cache.ready(legacyManifest); }
    catch { return null; }
    this.assertCurrent(revision);
    if (!generation) return null;
    const result = await this.cache.lookup(generation.id, key);
    this.assertCurrent(revision);
    return { generation, result };
  }
  async lookupV3(manifest, baseRoot, key, revision) {
    const block = this.findBlock(manifest.blocks, key);
    if (!block) return null;
    const generation = generationId(manifest);
    const cached = this.getCachedBlock(`${generation}:${block.sha256}`);
    const decoded = cached || await this.loadBlock(manifest, baseRoot, block, revision);
    this.assertCurrent(revision);
    let low = 0, high = decoded.entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (decoded.entries[middle].key < key) low = middle + 1;
      else high = middle;
    }
    const entry = decoded.entries[low];
    return entry?.key === key ? { key: entry.key, translation: entry.translation, phonetic: entry.phonetic, source: "ECDICT" } : null;
  }
  findBlock(blocks, key) {
    let low = 0, high = blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const block = blocks[middle];
      if (key < block.firstKey) high = middle;
      else if (key > block.lastKey) low = middle + 1;
      else return block;
    }
    return null;
  }
  getCachedBlock(cacheKey) {
    const value = this.blockCache.get(cacheKey);
    if (!value) return null;
    this.blockCache.delete(cacheKey);
    this.blockCache.set(cacheKey, value);
    return value;
  }
  rememberBlock(cacheKey, decoded) {
    if (!this.blockCacheMaxBlocks || !this.blockCacheMaxBytes || decoded.estimatedBytes > this.blockCacheMaxBytes) return;
    const prior = this.blockCache.get(cacheKey);
    if (prior) this.blockCacheBytes -= prior.estimatedBytes;
    this.blockCache.delete(cacheKey);
    this.blockCache.set(cacheKey, decoded);
    this.blockCacheBytes += decoded.estimatedBytes;
    while (this.blockCache.size > this.blockCacheMaxBlocks || this.blockCacheBytes > this.blockCacheMaxBytes) {
      const oldest = this.blockCache.keys().next().value;
      const removed = this.blockCache.get(oldest);
      this.blockCache.delete(oldest);
      this.blockCacheBytes -= removed.estimatedBytes;
    }
  }
  getBlockCacheStats() {
    return { blocks: this.blockCache.size, estimatedBytes: this.blockCacheBytes,
      maxBlocks: this.blockCacheMaxBlocks, maxBytes: this.blockCacheMaxBytes };
  }
  async loadBlock(manifest, baseRoot, block, revision) {
    const key = `${generationId(manifest)}:${block.sha256}`;
    const cached = this.getCachedBlock(key);
    if (cached) return cached;
    if (this.blockLoads.has(key)) return this.blockLoads.get(key);
    const loading = (async () => {
      let bytes;
      try { bytes = await this.adapter.readBinary(`${baseRoot}/${block.resourceFile}`); }
      catch (cause) { throw dictionaryReadError(cause); }
      bytes = asBytes(bytes);
      this.assertCurrent(revision);
      const decoded = await this.decodeBlock(block, bytes, revision);
      this.assertCurrent(revision);
      this.rememberBlock(key, decoded);
      return decoded;
    })();
    let pending;
    pending = loading.finally(() => {
      if (this.blockLoads.get(key) === pending) this.blockLoads.delete(key);
    });
    this.blockLoads.set(key, pending);
    return pending;
  }
  async decodeBlock(block, bytes, revision) {
    const worker = await this.ensureBlockWorker();
    this.assertCurrent(revision);
    if (!worker) return decodeBlockResource(block, bytes, { yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)) });
    const transferable = bytes.slice();
    try {
      return await new Promise((resolve, reject) => {
        const id = ++this.blockWorkerSequence;
        this.blockWorkerRequests.set(id, { resolve, reject });
        try { worker.postMessage({ type: "decode-block", id, block, bytes: transferable.buffer }, [transferable.buffer]); }
        catch (cause) {
          this.blockWorkerRequests.delete(id);
          reject(this.workerUnavailableError(cause));
        }
      });
    } catch (error) {
      if (!error?.workerUnavailable && error?.code !== "DICTIONARY_GZIP_UNAVAILABLE") throw error;
      return decodeBlockResource(block, bytes, { yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)) });
    }
  }
  workerUnavailableError(cause) {
    return Object.assign(dictionaryError("Dictionary Worker is unavailable; using cooperative block decoding.",
      "DICTIONARY_WORKER_UNAVAILABLE", cause), { workerUnavailable: true });
  }
  ensureBlockWorker() {
    if (this.blockWorkerUnavailable || !this.workerSource || typeof this.WorkerClass !== "function") return Promise.resolve(null);
    if (this.blockWorkerReady) return this.blockWorkerReady;
    let url, worker;
    try {
      url = URL.createObjectURL(new Blob([this.workerSource], { type: "text/javascript" }));
      worker = new this.WorkerClass(url, { name: "pdf-reader-dictionary-blocks" });
      this.blockWorker = worker;
      this.blockWorkerUrl = url;
    } catch {
      if (url) URL.revokeObjectURL(url);
      this.blockWorkerUnavailable = true;
      return Promise.resolve(null);
    }
    this.blockWorkerReady = new Promise((resolve, reject) => {
      let started = false;
      const startup = setTimeout(() => {
        const error = this.workerUnavailableError();
        worker.terminate?.();
        if (this.blockWorker === worker) this.blockWorker = null;
        if (this.blockWorkerUrl) URL.revokeObjectURL(this.blockWorkerUrl);
        this.blockWorkerUrl = null;
        reject(error);
      }, this.workerStartupTimeoutMs);
      worker.onmessage = ({ data }) => {
        if (data?.type === "started" && !started) {
          started = true;
          clearTimeout(startup);
          resolve(worker);
        } else if (data?.type === "block-ready" || data?.type === "block-error") {
          const request = this.blockWorkerRequests.get(data.id);
          if (!request) return;
          this.blockWorkerRequests.delete(data.id);
          if (data.type === "block-ready") request.resolve(data.decoded);
          else request.reject(dictionaryError(data.error?.message || "Dictionary block is corrupt.",
            data.error?.code || "DICTIONARY_RESOURCE_CORRUPT"));
        }
      };
      const unavailable = event => {
        clearTimeout(startup);
        this.blockWorkerUnavailable = true;
        const error = this.workerUnavailableError(event?.message || event);
        if (!started) reject(error);
        for (const request of this.blockWorkerRequests.values()) request.reject(error);
        this.blockWorkerRequests.clear();
        worker.terminate?.();
        if (this.blockWorker === worker) this.blockWorker = null;
        this.blockWorkerReady = null;
        if (this.blockWorkerUrl) URL.revokeObjectURL(this.blockWorkerUrl);
        this.blockWorkerUrl = null;
      };
      worker.onerror = unavailable;
      worker.onmessageerror = unavailable;
    }).catch(() => {
      this.blockWorkerUnavailable = true;
      this.blockWorkerReady = null;
      this.blockWorker = null;
      return null;
    });
    return this.blockWorkerReady;
  }
  async ensureReady({ force = false } = {}) {
    if (this.disposed) throw dictionaryError("Dictionary service has been disposed.", "DICTIONARY_CACHE_CANCELLED");
    if (this.pending) {
      if (this.pendingRevision === this.revision && (!force || this.pendingForce)) return this.pending;
      await this.pending.catch(() => {});
      return this.ensureReady({ force });
    }
    const revision = this.revision;
    this.pendingRevision = revision;
    this.pendingForce = force;
    const task = (async () => {
      const manifest = await this.manifest();
      this.assertCurrent(revision);
      if (manifest.schemaVersion === 3) {
        return this.resourceAvailableResult(manifest);
      }
      const existing = !force && await this.cache.ready(manifest);
      if (existing) return existing;
      this.emit({ phase: "verifying", count: 0, total: manifest.entryCount });
      if (this.workerSource && typeof this.WorkerClass === "function") {
        try { return await this.prepareInWorker(manifest, force); }
        catch (error) {
          // CSP and Worker availability differ between desktop and WKWebView.
          if (!error.workerUnavailable) throw error;
          await this.cache.releaseOwner(generationId(manifest)).catch(() => {});
        }
      }
      return this.cache.prepare(manifest, () => this.loadBytes(manifest), {
        force, signal: this.abortController.signal, onProgress: progress => this.emit(progress),
      });
    })().then(ready => {
      if (revision === this.revision) {
        if (ready?.status === "resource-available") this.emitResourceAvailable(ready.entryCount ?? ready.count);
        else {
          this.readyGeneration = ready;
          this.emit({ phase: "ready", count: ready.count, total: ready.count });
        }
      }
      return ready;
    }).catch(error => {
      if (revision === this.revision) this.emitUnavailable(error);
      throw error;
    }).finally(() => {
      if (this.pending === task) this.pending = null;
    });
    this.pending = task;
    return task;
  }
  async prepareInWorker(manifest, force) {
    let url, worker, startup;
    const unavailable = cause => Object.assign(dictionaryError("Dictionary Worker is unavailable; use cooperative import.",
      "DICTIONARY_WORKER_UNAVAILABLE", cause), { workerUnavailable: true });
    try {
      url = URL.createObjectURL(new Blob([this.workerSource], { type: "text/javascript" }));
      worker = new this.WorkerClass(url, { name: "pdf-reader-dictionary" });
      this.worker = worker;
      return await new Promise((resolve, reject) => {
        let started = false;
        const abort = () => finish(reject, dictionaryError("Dictionary service was closed.", "DICTIONARY_CACHE_CANCELLED"));
        const finish = (callback, value) => {
          this.abortController.signal.removeEventListener("abort", abort);
          clearTimeout(startup);
          callback(value);
        };
        startup = setTimeout(() => finish(reject, unavailable()), 5000);
        this.abortController.signal.addEventListener("abort", abort, { once: true });
        worker.onerror = event => finish(reject, unavailable(event?.message));
        worker.onmessageerror = event => finish(reject, unavailable(event));
        worker.onmessage = ({ data }) => {
          if (data?.type === "started" && !started) {
            started = true;
            clearTimeout(startup);
            void this.loadBytes(manifest).then(bytes => {
              if (this.disposed) return finish(reject, dictionaryError("Dictionary service was closed.", "DICTIONARY_CACHE_CANCELLED"));
              const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                ? bytes.buffer : bytes.slice().buffer;
              worker.postMessage({ type: "prepare", manifest, bytes: buffer,
                cacheName: this.cacheName, ownerId: this.cache.ownerId, force }, [buffer]);
            }).catch(error => finish(reject, error));
          } else if (data?.type === "progress") this.emit(data.progress);
          else if (data?.type === "ready") finish(resolve, data.ready);
          else if (data?.type === "error") {
            const error = dictionaryError(data.error.message, data.error.code);
            if (["DICTIONARY_CACHE_UNAVAILABLE", "DICTIONARY_GZIP_UNAVAILABLE"].includes(error.code)) error.workerUnavailable = true;
            finish(reject, error);
          }
        };
      });
    } catch (error) {
      if (error?.code) throw error;
      throw unavailable(error);
    } finally {
      clearTimeout(startup);
      worker?.terminate();
      if (url) URL.revokeObjectURL(url);
      if (this.worker === worker) this.worker = null;
    }
  }
  invalidate() {
    this.manifestPromise = null;
    this.readyGeneration = null;
    this.revision += 1;
    this.emit({ phase: "idle", count: 0, total: 0 });
    this.blockCache.clear();
    this.blockCacheBytes = 0;
    // Old loads are fenced by revision checks. Remove their coalescing slots so
    // a lookup after invalidation can start against the refreshed resource.
    this.blockLoads.clear();
  }
  async rebuildCache(options = {}) {
    this.invalidate();
    const result = await this.ensureReady({ force: true });
    if (result?.status === "resource-available") {
      const warmTerm = typeof options?.warmTerm === "string" ? options.warmTerm : "";
      const warmed = Boolean(normalizeDictionaryKey(warmTerm));
      const warmedResult = warmed ? await this.lookup(warmTerm) : null;
      return { ...result, warmed, result: warmedResult };
    }
    return result;
  }
  clearCache() { this.invalidate(); }
  dispose() {
    this.disposed = true;
    this.abortController.abort();
    this.worker?.terminate();
    this.blockWorker?.terminate();
    this.blockWorker = null;
    this.blockWorkerReady = null;
    if (this.blockWorkerUrl) URL.revokeObjectURL(this.blockWorkerUrl);
    this.blockWorkerUrl = null;
    for (const request of this.blockWorkerRequests.values()) {
      request.reject(dictionaryError("Dictionary service was closed.", "DICTIONARY_CACHE_CANCELLED"));
    }
    this.blockWorkerRequests.clear();
    this.blockCache.clear();
    this.blockCacheBytes = 0;
    this.blockLoads.clear();
    this.cache.close();
    this.listeners.clear();
  }
}
module.exports = { DEFAULT_DICTIONARY_ROOT, VocabularyDictionary, VocabularyDictionaryError, normalizeDictionaryKey };
