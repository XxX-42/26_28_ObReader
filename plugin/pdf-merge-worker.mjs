import core from "./pdf-merge-core.cjs";

const methods = new Set(["prepareLocal", "merge", "inspect"]);
let requestQueue = Promise.resolve();

async function handleRequest(event) {
  const { id, method, payload } = event.data || {};
  if (!Number.isSafeInteger(id) || !methods.has(method)) return;
  try {
    const result = await core[method](payload || {});
    if (result?.bytes instanceof Uint8Array || result?.patch?.suffix instanceof Uint8Array) {
      // Complete outputs and incremental suffixes are owned by this request.
      // Transfer whole buffers when they do not alias request input; copy only
      // a view that is shared, partial, or duplicated by another result field.
      const payloadBuffers = new Set();
      collectBuffers(payload, payloadBuffers);
      const transfers = [];
      const transferOutput = (bytes) => {
        const wholeBuffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
        const transferable = wholeBuffer && !payloadBuffers.has(bytes.buffer) &&
          !transfers.includes(bytes.buffer) && Object.prototype.toString.call(bytes.buffer) === "[object ArrayBuffer]";
        if (transferable) {
          transfers.push(bytes.buffer);
          return bytes;
        }
        const copy = bytes.slice();
        transfers.push(copy.buffer);
        return copy;
      };
      if (result.bytes instanceof Uint8Array) result.bytes = transferOutput(result.bytes);
      if (result.patch?.suffix instanceof Uint8Array) {
        result.patch = { ...result.patch, suffix: transferOutput(result.patch.suffix) };
      }
      globalThis.postMessage({ id, ok: true, result }, transfers);
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
}

function collectBuffers(value, buffers, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]" ||
      Object.prototype.toString.call(value) === "[object SharedArrayBuffer]") {
    buffers.add(value);
    return;
  }
  if (ArrayBuffer.isView(value)) {
    buffers.add(value.buffer);
    return;
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectBuffers(item, buffers, seen);
    return;
  }
  for (const item of Object.values(value)) collectBuffers(item, buffers, seen);
}

globalThis.addEventListener("message", (event) => {
  const run = requestQueue.then(() => handleRequest(event));
  requestQueue = run.catch(() => {});
});
