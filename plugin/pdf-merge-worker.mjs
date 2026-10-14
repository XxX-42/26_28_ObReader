import core from "./pdf-merge-core.cjs";
import hashRuntimeModule from "./pdf-hash-runtime.cjs";

const hashRuntimeReady = hashRuntimeModule.createPdfHashRuntime()
  .then((runtime) => {
    core.setHashRuntime?.(runtime);
    return runtime;
  });

const methods = new Set(["prepareLocal", "merge", "inspect"]);
let requestQueue = Promise.resolve();
const timingNow = () => globalThis.performance?.now?.() ?? Date.now();

async function handleRequest(event, enqueuedAt) {
  const { id, method, payload } = event.data || {};
  if (!Number.isSafeInteger(id) || !methods.has(method)) return;
  const startedAt = timingNow();
  try {
    await hashRuntimeReady;
    let result = await core[method](["prepareLocal", "merge"].includes(method)
      ? { ...(payload || {}), __collectTimings: true }
      : (payload || {}));
    const executeMs = +(timingNow() - startedAt).toFixed(3);
    const coreStages = result?.__pdfReaderTiming || null;
    if (coreStages && result && typeof result === "object") {
      result = { ...result };
      delete result.__pdfReaderTiming;
    }
    const timing = {
      saveTransactionId: typeof payload?.saveTransactionId === "string" ? payload.saveTransactionId : null,
      queueMs: +(startedAt - enqueuedAt).toFixed(3),
      executeMs,
      coreStages,
    };
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
      globalThis.postMessage({ id, ok: true, result, timing }, transfers);
    } else {
      globalThis.postMessage({ id, ok: true, result, timing });
    }
  } catch (error) {
    globalThis.postMessage({
      id,
      ok: false,
      timing: {
        saveTransactionId: typeof payload?.saveTransactionId === "string" ? payload.saveTransactionId : null,
        queueMs: +(startedAt - enqueuedAt).toFixed(3),
        executeMs: +(timingNow() - startedAt).toFixed(3),
      },
      error: {
        name: String(error?.name || "Error").slice(0, 128),
        code: String(error?.code || "PDF_MERGE_WORKER_ERROR").slice(0, 128),
        message: String(error?.message || error).slice(0, 4096),
        method,
        phase: "core.execute",
        stack: String(error?.stack || "").slice(0, 8192),
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
  const enqueuedAt = timingNow();
  const run = requestQueue.then(() => handleRequest(event, enqueuedAt));
  requestQueue = run.catch(() => {});
});
