/* Vault resources are authoritative; IndexedDB is a disposable local index. */
const { DictionaryQueryCache, DEFAULT_CACHE_NAME } = require("./dictionary-cache.cjs");
const { DEFAULT_DICTIONARY_ROOT, VocabularyDictionaryError, dictionaryError, normalizeDictionaryKey,
  validateManifest, generationId, asBytes } = require("./dictionary-resource.cjs");
const WORKER_SOURCE = typeof __PDF_DICTIONARY_WORKER_SOURCE__ === "string" ? __PDF_DICTIONARY_WORKER_SOURCE__ : null;

class VocabularyDictionary {
  constructor({ adapter, root = DEFAULT_DICTIONARY_ROOT, cache, cacheName = DEFAULT_CACHE_NAME,
    workerSource = WORKER_SOURCE, WorkerClass = globalThis.Worker, onStatus = () => {} } = {}) {
    if (!adapter || typeof adapter.read !== "function" || typeof adapter.readBinary !== "function") {
      throw new TypeError("VocabularyDictionary requires a Vault DataAdapter with read() and readBinary().");
    }
    this.adapter = adapter;
    this.root = String(root).replace(/\/+$/u, "");
    this.cache = cache || new DictionaryQueryCache({ name: cacheName });
    this.cacheName = cacheName;
    this.workerSource = workerSource;
    this.WorkerClass = WorkerClass;
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
      this.status.code === status.code && percent(this.status) === percent(status);
    this.status = { ...status };
    if (unchanged) return;
    for (const listener of this.listeners) { try { listener(this.getStatus()); } catch {} }
  }
  async manifest() {
    if (!this.manifestPromise) {
      this.manifestPromise = (async () => {
        let raw;
        try { raw = await this.adapter.read(`${this.root}/manifest.json`); }
        catch (cause) { throw dictionaryError("Dictionary resource manifest has not synchronized yet.", "DICTIONARY_INDEX_MISSING", cause); }
        try { return validateManifest(JSON.parse(raw)); }
        catch (cause) {
          if (cause?.code) throw cause;
          throw dictionaryError("Dictionary manifest is invalid JSON.", "DICTIONARY_MANIFEST_CORRUPT", cause);
        }
      })().catch(error => { this.manifestPromise = null; throw error; });
    }
    return this.manifestPromise;
  }
  async loadBytes(manifest) {
    try { return asBytes(await this.adapter.readBinary(`${this.root}/${manifest.resourceFile}`)); }
    catch (cause) { throw dictionaryError("Dictionary resource has not synchronized yet.", "DICTIONARY_RESOURCE_MISSING", cause); }
  }
  async lookup(term) {
    const key = normalizeDictionaryKey(term);
    if (!key) return null;
    try {
      const manifest = await this.manifest();
      const ready = await this.cache.ready(manifest);
      if (ready) {
        this.readyGeneration = ready;
        this.emit({ phase: "ready", count: ready.count, total: ready.count });
        return await this.cache.lookup(ready.id, key);
      }
      // A resource update must not take an already verified dictionary offline.
      const previous = await this.cache.active(manifest.dictionaryId);
      if (previous) {
        void this.ensureReady().catch(() => {});
        return await this.cache.lookup(previous.id, key);
      }
      const built = await this.ensureReady();
      return await this.cache.lookup(built.id, key);
    } catch (error) {
      if (error?.code === "DICTIONARY_CACHE_RETRY" && !this.disposed) {
        const ready = await this.ensureReady();
        return this.cache.lookup(ready.id, key);
      }
      if (error?.code === "DICTIONARY_CACHE_INCOMPLETE" && !this.disposed) {
        this.readyGeneration = null;
        const rebuilt = await this.ensureReady({ force: true });
        return this.cache.lookup(rebuilt.id, key);
      }
      const previous = await this.cache.active().catch(() => null);
      if (previous && !this.disposed) return this.cache.lookup(previous.id, key);
      if (error?.code) throw error;
      throw dictionaryError("The local dictionary query cache is unavailable.", "DICTIONARY_CACHE_UNAVAILABLE", error);
    }
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
        this.readyGeneration = ready;
        this.emit({ phase: "ready", count: ready.count, total: ready.count });
      }
      return ready;
    }).catch(error => {
      this.emit({ phase: "unavailable", count: this.status.count, total: this.status.total,
        code: error?.code || "DICTIONARY_CACHE_UNAVAILABLE" });
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
  }
  async rebuildCache() { this.invalidate(); return this.ensureReady({ force: true }); }
  clearCache() { this.invalidate(); }
  dispose() {
    this.disposed = true;
    this.abortController.abort();
    this.worker?.terminate();
    this.cache.close();
    this.listeners.clear();
  }
}
module.exports = { DEFAULT_DICTIONARY_ROOT, VocabularyDictionary, VocabularyDictionaryError, normalizeDictionaryKey };
