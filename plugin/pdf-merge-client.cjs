"use strict";

const { sha256 } = require("@noble/hashes/sha256");
const timingNow = () => globalThis.performance?.now?.() ?? Date.now();

function bytesOf(value) {
  if (Object.prototype.toString.call(value) === "[object ArrayBuffer]" ||
      Object.prototype.toString.call(value) === "[object SharedArrayBuffer]") {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError("PDF merge worker source must be provided as bytes.");
}

function isBufferValue(value) {
  return Object.prototype.toString.call(value) === "[object ArrayBuffer]" ||
    Object.prototype.toString.call(value) === "[object SharedArrayBuffer]" ||
    ArrayBuffer.isView(value);
}

function clonePayloadForTransfer(value, ownedSnapshots, transfers, seen = new WeakMap()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (isBufferValue(value)) {
    if (ownedSnapshots.has(value) && value instanceof Uint8Array &&
        value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) {
      ownedSnapshots.delete(value);
      transfers.push(value.buffer);
      seen.set(value, value);
      return value;
    }
    const copy = bytesOf(value).slice();
    transfers.push(copy.buffer);
    seen.set(value, copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const item of value) copy.push(clonePayloadForTransfer(item, ownedSnapshots, transfers, seen));
    return copy;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // RPC payloads are plain data. Keep clone-compatible uncommon values intact;
    // byte-bearing fields are normalized separately above.
    return value;
  }
  const copy = Object.create(prototype);
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = clonePayloadForTransfer(item, ownedSnapshots, transfers, seen);
  }
  return copy;
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
    this.workerName = error.name || "PdfMergeWorkerError";
    this.workerCode = error.code || "PDF_MERGE_WORKER_ERROR";
    if (typeof error.method === "string") this.workerMethod = error.method.slice(0, 128);
    if (typeof error.phase === "string") this.workerPhase = error.phase.slice(0, 128);
    if (typeof error.stack === "string") this.workerStack = error.stack.slice(0, 16384);
    if (error.details !== undefined) this.details = error.details;
  }
}

function createPdfMergeClient({
  loadWorkerSource,
  WorkerClass = globalThis.Worker,
  URLApi = globalThis.URL,
  BlobClass = globalThis.Blob,
  onTaskTiming = null,
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
  const queue = [];
  const ownedSnapshots = new WeakSet();
  let draining = false;

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

  function rejectQueued(error) {
    for (const task of queue.splice(0)) task.reject(error);
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
    if (typeof onTaskTiming === "function") {
      const workerTiming = message.timing || {};
      const roundTripMs = task.timing?.postedAt === null || task.timing?.postedAt === undefined
        ? null
        : +(timingNow() - task.timing.postedAt).toFixed(3);
      const workerQueueMs = Number.isFinite(workerTiming.queueMs) ? workerTiming.queueMs : null;
      const workerExecuteMs = Number.isFinite(workerTiming.executeMs) ? workerTiming.executeMs : null;
      const residual = roundTripMs === null ? null : Math.max(0,
        roundTripMs - (workerQueueMs || 0) - (workerExecuteMs || 0));
      try {
        onTaskTiming({
          method: task.method,
          saveTransactionId: task.saveTransactionId || null,
          clientQueueMs: task.timing?.clientQueueMs ?? null,
          workerReadyMs: task.timing?.workerReadyMs ?? null,
          payloadPrepareMs: task.timing?.payloadPrepareMs ?? null,
          postMessageCallMs: task.timing?.postMessageCallMs ?? null,
          workerRoundTripMs: roundTripMs,
          workerQueueMs,
          workerExecuteMs,
          workerTransportResidualMs: residual === null ? null : +residual.toFixed(3),
          coreStages: workerTiming.coreStages || null,
          ok: message.ok === true,
        });
      } catch { /* Diagnostics must not affect the Worker response. */ }
    }
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

  async function runTask(task) {
    const taskStartedAt = timingNow();
    task.timing ||= {};
    task.timing.clientQueueMs = +(taskStartedAt - task.enqueuedAt).toFixed(3);
    const workerReadyStartedAt = timingNow();
    const instance = await ensureWorker();
    task.timing.workerReadyMs = +(timingNow() - workerReadyStartedAt).toFixed(3);
    if (disposed) throw new PdfMergeWorkerError({ code: "PDF_MERGE_CLIENT_DISPOSED", message: "The PDF merge client has been disposed." });
    const transfers = [];
    const payloadPrepareStartedAt = timingNow();
    const payload = clonePayloadForTransfer(task.payload, ownedSnapshots, transfers);
    task.timing.payloadPrepareMs = +(timingNow() - payloadPrepareStartedAt).toFixed(3);
    await new Promise((resolve, reject) => {
      pending.set(task.id, {
        resolve: (result) => { task.resolve(result); resolve(); },
        reject: (error) => { task.reject(error); reject(error); },
        timing: task.timing,
        method: task.method,
        saveTransactionId: typeof task.payload?.saveTransactionId === "string"
          ? task.payload.saveTransactionId
          : null,
      });
      task.timing.postedAt = timingNow();
      const postStartedAt = task.timing.postedAt;
      try {
        instance.postMessage({ id: task.id, method: task.method, payload }, transfers);
        task.timing.postMessageCallMs = +(timingNow() - postStartedAt).toFixed(3);
      } catch (error) {
        pending.delete(task.id);
        reject(error);
      }
    });
  }

  async function drainQueue() {
    if (draining) return;
    draining = true;
    try {
      while (queue.length && !disposed) {
        const task = queue.shift();
        try { await runTask(task); }
        catch (error) { task.reject(error); }
      }
    } finally {
      draining = false;
      if (queue.length && !disposed) void drainQueue();
    }
  }

  function call(method, payload) {
    if (disposed) return Promise.reject(new PdfMergeWorkerError({ code: "PDF_MERGE_CLIENT_DISPOSED", message: "The PDF merge client has been disposed." }));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      queue.push({ id, method, payload, resolve, reject, enqueuedAt: timingNow() });
      void drainQueue();
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
    rejectQueued(error);
    releaseWorker();
    workerPromise = null;
  }

  return {
    // Creates an immutable, one-use copy that the next admitted RPC may transfer.
    // The caller's bytes stay attached for checkpoints and PDF.js ownership.
    snapshotBytes(value) {
      const snapshot = bytesOf(value).slice();
      ownedSnapshots.add(snapshot);
      return snapshot;
    },
    prepareLocal: (payload) => call("prepareLocal", payload),
    merge: (payload) => call("merge", payload),
    inspect: (payload) => call("inspect", payload),
    verifyOutlineUpdate: (payload) => call("verifyOutlineUpdate", payload),
    dispose,
  };
}

module.exports = { createPdfMergeClient, PdfMergeWorkerError };
