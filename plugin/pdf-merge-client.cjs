"use strict";

const { sha256 } = require("@noble/hashes/sha256");

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("PDF merge worker source must be provided as bytes.");
}

function hex(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

class PdfMergeWorkerError extends Error {
  constructor(error = {}) {
    super(String(error.message || "PDF merge worker failed."));
    this.name = error.name || "PdfMergeWorkerError";
    this.code = error.code || "PDF_MERGE_WORKER_ERROR";
    if (error.details !== undefined) this.details = error.details;
  }
}

function createPdfMergeClient({
  loadWorkerSource,
  WorkerClass = globalThis.Worker,
  URLApi = globalThis.URL,
  BlobClass = globalThis.Blob,
} = {}) {
  if (typeof loadWorkerSource !== "function") {
    throw new TypeError("loadWorkerSource must be a function.");
  }
  let worker = null;
  let workerSourcePromise = null;
  let workerPromise = null;
  let workerUrl = null;
  let disposed = false;
  let nextId = 1;
  const pending = new Map();

  async function getWorkerSource() {
    if (!workerSourcePromise) {
      const sharedSourcePromise = Promise.resolve()
        .then(loadWorkerSource)
        .then((descriptor) => {
          const bytes = bytesOf(descriptor?.bytes ?? descriptor?.scriptBytes);
          const actualHash = hex(sha256(bytes));
          if (descriptor?.sha256 && String(descriptor.sha256).toLowerCase() !== actualHash) {
            throw new PdfMergeWorkerError({
              code: "PDF_MERGE_WORKER_HASH_MISMATCH",
              message: "The PDF merge worker failed its verified asset hash check.",
            });
          }
          return { bytes, actualHash, url: descriptor?.url || descriptor?.resourceUrl || null };
        })
        .catch((error) => {
          if (workerSourcePromise === sharedSourcePromise) workerSourcePromise = null;
          throw error;
        });
      workerSourcePromise = sharedSourcePromise;
    }
    return workerSourcePromise;
  }

  function rejectPending(error) {
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  }

  function releaseWorker() {
    if (worker) {
      try { worker.removeEventListener("message", onMessage); } catch {}
      try { worker.removeEventListener("error", onWorkerError); } catch {}
      try { worker.removeEventListener("messageerror", onMessageError); } catch {}
      try { worker.terminate(); } catch {}
      worker = null;
    }
    if (workerUrl && typeof URLApi?.revokeObjectURL === "function") {
      try { URLApi.revokeObjectURL(workerUrl); } catch {}
      workerUrl = null;
    }
  }

  function ensureWorker() {
    if (disposed) throw new PdfMergeWorkerError({ code: "PDF_MERGE_CLIENT_DISPOSED", message: "The PDF merge client has been disposed." });
    if (worker) return Promise.resolve(worker);
    if (workerPromise) return workerPromise;

    const creation = (async () => {
      const source = await getWorkerSource();
      if (disposed) throw new PdfMergeWorkerError({ code: "PDF_MERGE_CLIENT_DISPOSED", message: "The PDF merge client has been disposed." });
      if (typeof WorkerClass !== "function") {
        throw new PdfMergeWorkerError({ code: "PDF_MERGE_WORKER_UNAVAILABLE", message: "Web Workers are unavailable in this runtime." });
      }
      let url = source.url;
      if (typeof BlobClass === "function" && typeof URLApi?.createObjectURL === "function") {
        const blob = new BlobClass([source.bytes], { type: "text/javascript" });
        url = URLApi.createObjectURL(blob);
        workerUrl = url;
      }
      if (!url) {
        throw new PdfMergeWorkerError({ code: "PDF_MERGE_WORKER_URL_UNAVAILABLE", message: "No verified URL is available for the PDF merge worker." });
      }
      const instance = new WorkerClass(url, { name: "pdf-web-reader-merge" });
      worker = instance;
      instance.addEventListener("message", onMessage);
      instance.addEventListener("error", onWorkerError);
      instance.addEventListener("messageerror", onMessageError);
      return instance;
    })();
    const shared = creation.catch((error) => {
      releaseWorker();
      if (workerPromise === shared) workerPromise = null;
      throw error;
    });
    workerPromise = shared;
    return shared;
  }

  function onMessage(event) {
    const message = event.data || {};
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    if (message.ok) task.resolve(message.result);
    else task.reject(new PdfMergeWorkerError(message.error));
  }

  function onWorkerError(event) {
    const error = new PdfMergeWorkerError({
      code: "PDF_MERGE_WORKER_CRASHED",
      message: event?.message || "The PDF merge worker stopped unexpectedly.",
    });
    rejectPending(error);
    releaseWorker();
    workerPromise = null;
  }

  function onMessageError() {
    const error = new PdfMergeWorkerError({
      code: "PDF_MERGE_WORKER_MESSAGE_INVALID",
      message: "The PDF merge worker returned an unreadable message.",
    });
    rejectPending(error);
    releaseWorker();
    workerPromise = null;
  }

  async function call(method, payload) {
    const instance = await ensureWorker();
    if (disposed) throw new PdfMergeWorkerError({ code: "PDF_MERGE_CLIENT_DISPOSED", message: "The PDF merge client has been disposed." });
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        // Structured clone copies the byte views without detaching the caller's
        // loaded-base/checkpoint buffers, which the host retains for recovery.
        instance.postMessage({ id, method, payload });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const error = new PdfMergeWorkerError({
      code: "PDF_MERGE_CLIENT_DISPOSED",
      message: "The PDF merge client was disposed before its request completed.",
    });
    rejectPending(error);
    releaseWorker();
    workerPromise = null;
  }

  return {
    prepareLocal: (payload) => call("prepareLocal", payload),
    merge: (payload) => call("merge", payload),
    inspect: (payload) => call("inspect", payload),
    dispose,
  };
}

module.exports = { createPdfMergeClient, PdfMergeWorkerError };
