const { DictionaryQueryCache } = require("./dictionary-cache.cjs");
let cache;
self.onmessage = async ({ data }) => {
  if (data?.type !== "prepare") return;
  try {
    // The worker can use a larger bounded batch without blocking Reader input.
    // Cooperative main-thread fallback retains the smaller default batch.
    cache = new DictionaryQueryCache({ name: data.cacheName, ownerId: data.ownerId, batchSize: 4000 });
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
