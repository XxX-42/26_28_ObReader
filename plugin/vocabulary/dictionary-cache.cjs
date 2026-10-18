const DexieModule = require("dexie");
const Dexie = DexieModule.default || DexieModule;
const { dictionaryError, validateManifest, generationId, verifyResource, decodeResource } = require("./dictionary-resource.cjs");
const DEFAULT_CACHE_NAME = "pdf-web-reader-dictionaries-v1";
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const makeOwner = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
function cacheError(error) {
  if (typeof error?.code === "string" && error.code.startsWith("DICTIONARY_")) return error;
  return dictionaryError("The local dictionary cache could not be written. It can be rebuilt.",
    error?.name === "QuotaExceededError" || error?.inner?.name === "QuotaExceededError"
      ? "DICTIONARY_CACHE_QUOTA" : "DICTIONARY_CACHE_UNAVAILABLE", error);
}

/** This database contains reference-data caches only, never personal records. */
class DictionaryQueryCache {
  constructor({ name = DEFAULT_CACHE_NAME, indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange,
    batchSize = 1000, leaseMs = 30000, now = () => Date.now(), ownerId = makeOwner(), yieldControl = pause } = {}) {
    this.db = new Dexie(name, { indexedDB, IDBKeyRange });
    this.db.version(1).stores({ entries: "[generation+key]", generations: "&id", active: "&dictionaryId",
      membership: "[generation+bucket]" });
    this.batchSize = batchSize;
    this.leaseMs = leaseMs;
    this.now = now;
    this.ownerId = ownerId;
    this.yieldControl = yieldControl;
    this.closed = false;
    this.pending = new Map();
    this.verifiedGenerations = new Set();
    this.membershipCache = new Map();
  }
  checkCancelled(signal) {
    if (this.closed || signal?.aborted) throw dictionaryError("Dictionary preparation was cancelled.", "DICTIONARY_CACHE_CANCELLED");
  }
  async ready(manifest) {
    const base = generationId(manifest);
    const pointer = await this.db.active.get(manifest.dictionaryId);
    for (const id of new Set([pointer?.generation, base, `${base}:rebuild`])) {
      if (!id) continue;
      const row = await this.db.generations.get(id);
      if (row?.status !== "ready" || row.count !== manifest.entryCount || row.sha256 !== manifest.sha256) continue;
      if (await this.validateReady(row)) return row;
    }
    return null;
  }
  async active(dictionaryId = "ECDICT") {
    const pointer = await this.db.active.get(dictionaryId);
    const row = pointer && await this.db.generations.get(pointer.generation);
    if (row?.status !== "ready") return null;
    return await this.validateReady(row) ? row : null;
  }
  async validateReady(row) {
    if (this.verifiedGenerations.has(`${row.id}:${row.fence}`)) return true;
    if (!Array.isArray(row.prefixes) || row.prefixes.some(prefix => typeof prefix !== "string") ||
        new Set(row.prefixes).size !== row.prefixes.length ||
        await this.db.membership.where(":id").between([row.id, Dexie.minKey], [row.id, Dexie.maxKey], true, true).count() !== row.prefixes.length) {
      await this.invalidateGeneration(row.id);
      return false;
    }
    this.verifiedGenerations.add(`${row.id}:${row.fence}`);
    return true;
  }
  entryCount(id) {
    return this.db.entries.where(":id").between([id, Dexie.minKey], [id, Dexie.maxKey], true, true).count();
  }
  async invalidateGeneration(id) {
    this.verifiedGenerations.clear();
    this.membershipCache.clear();
    await this.db.transaction("rw", this.db.generations, this.db.active, async () => {
      const row = await this.db.generations.get(id);
      if (!row || row.status !== "ready") return;
      await this.db.generations.put({ ...row, status: "invalid", owner: null, leaseUntil: 0 });
      const active = await this.db.active.get(row.dictionaryId);
      if (active?.generation === id) await this.db.active.delete(row.dictionaryId);
    });
  }
  async releaseOwner(id) {
    await this.db.transaction("rw", this.db.generations, async () => {
      for (const candidate of [id, `${id}:rebuild`]) {
        const row = await this.db.generations.get(candidate);
        if (row?.owner === this.ownerId) await this.db.generations.put({ ...row, owner: null, leaseUntil: 0 });
      }
    });
  }
  async lookup(generation, key) {
    try {
      // One read transaction prevents a concurrent rebuild from changing the
      // readiness marker between the payload read and interpretation of a miss.
      return await this.db.transaction("r", this.db.generations, this.db.entries, this.db.membership, async () => {
        const ready = await this.db.generations.get(generation);
        if (ready?.status !== "ready") throw dictionaryError("Dictionary generation changed; retry the active cache.", "DICTIONARY_CACHE_RETRY");
        const row = await this.db.entries.get([generation, key]);
        const invalid = row
          ? row.generation !== generation || row.key !== key || typeof row.translation !== "string" || typeof row.phonetic !== "string"
          : await this.expectsKey(ready, key);
        if (invalid) throw dictionaryError("The local dictionary cache is incomplete and must be rebuilt.", "DICTIONARY_CACHE_INCOMPLETE");
        return row ? { key: row.key, translation: row.translation, phonetic: row.phonetic, source: "ECDICT" } : null;
      });
    } catch (error) {
      if (error?.code === "DICTIONARY_CACHE_INCOMPLETE") await this.invalidateGeneration(generation);
      throw error;
    }
  }
  async expectsKey(ready, key) {
    const generation = ready.id;
    const bucket = key.slice(0, 2);
    const cacheKey = `${generation}:${ready.fence}\u0000${bucket}`;
    let keys = this.membershipCache.get(cacheKey);
    if (!keys) {
      const row = await this.db.membership.get([generation, bucket]);
      if (!row && !ready.prefixes?.includes(bucket)) return false;
      if (!row || !Array.isArray(row.keys) || row.keys.some((item, index) =>
        typeof item !== "string" || item.slice(0, 2) !== bucket || index > 0 && item <= row.keys[index - 1])) {
        throw dictionaryError("Dictionary key index is incomplete.", "DICTIONARY_CACHE_INCOMPLETE");
      }
      keys = row.keys;
    }
    this.membershipCache.delete(cacheKey);
    this.membershipCache.set(cacheKey, keys);
    while (this.membershipCache.size > 8) this.membershipCache.delete(this.membershipCache.keys().next().value);
    let low = 0, high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (keys[middle] < key) low = middle + 1;
      else high = middle;
    }
    return keys[low] === key;
  }
  async acquire(manifest, { force = false } = {}) {
    const base = generationId(manifest);
    return this.db.transaction("rw", this.db.generations, this.db.entries, this.db.membership, this.db.active, async () => {
      const pointer = await this.db.active.get(manifest.dictionaryId);
      const active = pointer && await this.db.generations.get(pointer.generation);
      // Rebuild into the other local slot. Keep the last verified dictionary
      // queryable until the replacement is complete; no Vault files are added.
      const id = force && active?.sha256 === manifest.sha256 && active.status === "ready"
        ? active.id === base ? `${base}:rebuild` : base : base;
      let row = await this.db.generations.get(id);
      if (!force && row?.status === "ready") return { ready: true, row };
      if (row?.owner && row.leaseUntil > this.now()) return { busy: true, row };
      if (force || row?.status === "invalid") {
        this.verifiedGenerations.clear();
        this.membershipCache.clear();
        await this.db.entries.where(":id").between([id, Dexie.minKey], [id, Dexie.maxKey], true, true).delete();
        await this.db.membership.where(":id").between([id, Dexie.minKey], [id, Dexie.maxKey], true, true).delete();
        row = { ...row, count: 0, lastKey: "", prefixes: [] };
      }
      row = { ...row, id, sha256: manifest.sha256, dictionaryId: manifest.dictionaryId, status: "building",
        count: row?.count || 0, lastKey: row?.lastKey || "", prefixes: row?.prefixes || [], owner: this.ownerId,
        fence: (row?.fence || 0) + 1, leaseUntil: this.now() + this.leaseMs };
      await this.db.generations.put(row);
      return { row };
    });
  }
  async prepare(manifest, loadBytes, { onProgress = () => {}, signal, force = false } = {}) {
    validateManifest(manifest);
    const id = generationId(manifest);
    if (this.pending.has(id)) return this.pending.get(id);
    const pending = this._prepare(manifest, loadBytes, { onProgress, signal, force })
      .catch(error => { throw cacheError(error); }).finally(() => this.pending.delete(id));
    this.pending.set(id, pending);
    return pending;
  }
  async _prepare(manifest, loadBytes, { onProgress, signal, force }) {
    let acquired;
    do {
      this.checkCancelled(signal);
      acquired = await this.acquire(manifest, { force });
      if (acquired.ready) return acquired.row;
      if (acquired.busy) {
        onProgress({ phase: "waiting", count: acquired.row.count, total: manifest.entryCount });
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } while (acquired.busy);
    const lease = acquired.row;
    const id = lease.id;
    try {
      onProgress({ phase: "verifying", count: lease.count, total: manifest.entryCount });
      const bytes = await verifyResource(manifest, await loadBytes());
      this.checkCancelled(signal);
      await decodeResource(manifest, bytes, async (batch, progress) => {
        this.checkCancelled(signal);
        if (progress.count <= lease.count) { await this.yieldControl(); return; }
        await this.db.transaction("rw", this.db.generations, this.db.entries, this.db.membership, async () => {
          const current = await this.db.generations.get(id);
          if (current?.owner !== this.ownerId || current.fence !== lease.fence) {
            throw dictionaryError("Another window resumed dictionary preparation.", "DICTIONARY_CACHE_LEASE_LOST");
          }
          const fresh = batch.filter(entry => entry.key > current.lastKey);
          if (fresh.length) await this.db.entries.bulkPut(fresh.map(entry => ({ generation: id, ...entry })));
          const buckets = new Map();
          for (const entry of fresh) {
            const bucket = entry.key.slice(0, 2);
            if (!buckets.has(bucket)) buckets.set(bucket, []);
            buckets.get(bucket).push(entry.key);
          }
          for (const [bucket, keys] of buckets) {
            const existing = await this.db.membership.get([id, bucket]);
            await this.db.membership.put({ generation: id, bucket, keys: [...(existing?.keys || []), ...keys] });
          }
          await this.db.generations.put({ ...current, count: current.count + fresh.length,
            lastKey: progress.lastKey, prefixes: [...new Set([...current.prefixes, ...buckets.keys()])],
            leaseUntil: this.now() + this.leaseMs });
        }).catch(error => { throw cacheError(error); });
        onProgress({ phase: "building", count: progress.count, total: manifest.entryCount });
        await this.yieldControl();
      }, { batchSize: this.batchSize, checkCancelled: () => this.checkCancelled(signal) });
      this.checkCancelled(signal);
      const ready = await this.db.transaction("rw", this.db.generations, this.db.entries, this.db.active, async () => {
        const current = await this.db.generations.get(id);
        if (current?.owner !== this.ownerId || current.fence !== lease.fence) {
          throw dictionaryError("Dictionary preparation ownership changed.", "DICTIONARY_CACHE_LEASE_LOST");
        }
        const count = await this.db.entries.where(":id").between([id, Dexie.minKey], [id, Dexie.maxKey], true, true).count();
        if (current.count !== manifest.entryCount || count !== manifest.entryCount) {
          throw dictionaryError("Dictionary cache count does not match its verified resource.", "DICTIONARY_CACHE_INCOMPLETE");
        }
        const row = { ...current, status: "ready", owner: null, leaseUntil: 0 };
        await this.db.generations.put(row);
        await this.db.active.put({ dictionaryId: manifest.dictionaryId, generation: id });
        return row;
      });
      onProgress({ phase: "ready", count: ready.count, total: manifest.entryCount });
      this.verifiedGenerations.add(`${id}:${ready.fence}`);
      return ready;
    } catch (error) {
      // Release only our fenced lease. A suspended old window cannot invalidate
      // a generation that another window has taken over and verified.
      await this.db.transaction("rw", this.db.generations, async () => {
        const current = await this.db.generations.get(id);
        if (current?.owner === this.ownerId && current.fence === lease.fence) {
          await this.db.generations.put({ ...current, owner: null, leaseUntil: 0,
            status: error?.code === "DICTIONARY_RESOURCE_CORRUPT" ? "invalid" : "building" });
        }
      }).catch(() => {});
      throw cacheError(error);
    }
  }
  close() { this.closed = true; this.db.close(); }
}
module.exports = { DictionaryQueryCache, DEFAULT_CACHE_NAME };
