const { DictionaryQueryCache } = require("./dictionary-cache.cjs");
let cache;
self.onmessage = async ({ data }) => {
  if (data?.type !== "prepare") return;
  try {
    // The worker can use a larger bounded batch without blocking Reader input.
    // Cooperative main-thread fallback retains the smaller default batch.
    const batchSize = Number.isSafeInteger(data.batchSize) && data.batchSize >= 1000 && data.batchSize <= 32000
      ? data.batchSize : 4000;
    cache = new DictionaryQueryCache({ name: data.cacheName, ownerId: data.ownerId, batchSize,
      onProfile: data.profileEnabled === true
        ? profile => self.postMessage({ type: "profile", profile })
        : null });
    const ready = await cache.prepare(data.manifest, () => data.bytes, {
      force: data.force === true,
      onProgress: progress => self.postMessage({ type: "progress", progress }),
    });
    self.postMessage({ type: "ready", ready });
  } catch (error) {
    self.postMessage({ type: "error", error: { message: error.message, code: error.code || "DICTIONARY_CACHE_UNAVAILABLE" } });
  } finally { cache?.close(); }
};
self.postMessage({ type: "started" });
