import core from "./pdf-merge-core.cjs";

const methods = new Set(["prepareLocal", "merge", "inspect"]);

globalThis.addEventListener("message", async (event) => {
  const { id, method, payload } = event.data || {};
  if (!Number.isSafeInteger(id) || !methods.has(method)) return;
  try {
    const result = await core[method](payload || {});
    if (result?.bytes instanceof Uint8Array) {
      // Transfer an owned result buffer only. Request buffers and the cached
      // verified worker source remain owned by the host.
      result.bytes = result.bytes.slice();
      globalThis.postMessage({ id, ok: true, result }, [result.bytes.buffer]);
    } else {
      globalThis.postMessage({ id, ok: true, result });
    }
  } catch (error) {
    globalThis.postMessage({
      id,
      ok: false,
      error: {
        name: error?.name || "Error",
        code: error?.code || "PDF_MERGE_WORKER_ERROR",
        message: String(error?.message || error),
        details: error?.details,
      },
    });
  }
});
