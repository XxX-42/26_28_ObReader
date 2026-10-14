import assert from "node:assert/strict";
import test from "node:test";
import { createPdfMergeClient } from "../plugin/pdf-merge-client.cjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class FakeWorker {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }
  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => {
      for (const listener of this.listeners.get("message") || []) {
        listener({ data: { id: message.id, ok: true, result: { method: message.method } } });
      }
    });
  }
  emit(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
  terminate() {
    this.terminated = true;
  }
}

class TransferWorker extends FakeWorker {
  constructor(url) {
    super(url);
    this.transfers = [];
  }
  postMessage(message, transfers = []) {
    this.transfers.push([...transfers]);
    this.messages.push(structuredClone(message, { transfer: transfers }));
  }
  reply(id, result = {}) {
    this.emit("message", { data: { id, ok: true, result } });
  }
}

function fixture(overrides = {}) {
  FakeWorker.instances = [];
  const revoked = [];
  let urlNumber = 0;
  const URLApi = {
    createObjectURL() { return `blob:merge-${++urlNumber}`; },
    revokeObjectURL(url) { revoked.push(url); },
  };
  const sourceBytes = new Uint8Array([1, 2, 3, 4]);
  const client = createPdfMergeClient({
    loadWorkerSource: async () => ({ bytes: sourceBytes }),
    WorkerClass: FakeWorker,
    URLApi,
    BlobClass: globalThis.Blob,
    ...overrides,
  });
  return { client, revoked, sourceBytes, URLApi };
}

test("concurrent first RPCs share one source load and one lazily-created worker", async () => {
  const source = deferred();
  let loads = 0;
  const sourceBytes = new Uint8Array([7, 8, 9]);
  const { client, revoked } = fixture({
    loadWorkerSource: () => {
      loads += 1;
      return source.promise;
    },
  });

  const calls = [client.inspect({ n: 1 }), client.merge({ n: 2 }), client.prepareLocal({ n: 3 })];
  await Promise.resolve();
  assert.equal(loads, 1);
  source.resolve({ bytes: sourceBytes });
  assert.deepEqual(await Promise.all(calls), [
    { method: "inspect" },
    { method: "merge" },
    { method: "prepareLocal" },
  ]);
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].messages.length, 3);
  assert.deepEqual([...sourceBytes], [7, 8, 9], "the cached asset bytes remain attached and unchanged");
  client.dispose();
  assert.deepEqual(revoked, ["blob:merge-1"]);
});

test("worker constructor failure revokes its blob and the next call can retry", async () => {
  let attempts = 0;
  class FailOnceWorker extends FakeWorker {
    constructor(url) {
      attempts += 1;
      if (attempts === 1) throw new Error("simulated constructor failure");
      super(url);
    }
  }
  const { client, revoked } = fixture({ WorkerClass: FailOnceWorker });
  await assert.rejects(client.inspect({}), /simulated constructor failure/);
  assert.deepEqual(revoked, ["blob:merge-1"]);
  assert.deepEqual(await client.inspect({}), { method: "inspect" });
  assert.equal(attempts, 2);
  client.dispose();
  assert.deepEqual(revoked, ["blob:merge-1", "blob:merge-2"]);
});

test("a verified-source failure is retryable and never creates a worker or blob", async () => {
  let loads = 0;
  const { client, revoked } = fixture({
    loadWorkerSource: async () => {
      loads += 1;
      return loads === 1
        ? { bytes: new Uint8Array([1]), sha256: "00" }
        : { bytes: new Uint8Array([2]) };
    },
  });
  await assert.rejects(client.inspect({}), { code: "PDF_MERGE_WORKER_HASH_MISMATCH" });
  assert.equal(FakeWorker.instances.length, 0);
  assert.deepEqual(await client.inspect({}), { method: "inspect" });
  assert.equal(loads, 2);
  assert.deepEqual(revoked, []);
  client.dispose();
});

test("dispose during source loading rejects all waiting calls without creating a worker", async () => {
  const source = deferred();
  const { client, revoked } = fixture({ loadWorkerSource: () => source.promise });
  const call = client.inspect({});
  await Promise.resolve();
  client.dispose();
  source.resolve({ bytes: new Uint8Array([3]) });
  await assert.rejects(call, { code: "PDF_MERGE_CLIENT_DISPOSED" });
  assert.equal(FakeWorker.instances.length, 0);
  assert.deepEqual(revoked, []);
});

test("worker failure rejects inflight RPCs, releases the dead worker, and permits a fresh worker", async () => {
  let count = 0;
  class FailFirstWorker extends FakeWorker {
    constructor(url) {
      super(url);
      this.suppressReply = ++count === 1;
    }
    postMessage(message) {
      if (this.suppressReply) this.messages.push(message);
      else super.postMessage(message);
    }
  }
  const { client, revoked } = fixture({ WorkerClass: FailFirstWorker });
  const inflight = client.merge({ branch: "local" });
  await new Promise((resolve) => setImmediate(resolve));
  const first = FakeWorker.instances[0];
  assert.equal(first.messages.length, 1);
  first.emit("error", { message: "simulated worker crash" });
  await assert.rejects(inflight, { code: "PDF_MERGE_WORKER_CRASHED" });
  assert.equal(first.terminated, true);
  assert.deepEqual(revoked, ["blob:merge-1"]);

  assert.deepEqual(await client.inspect({}), { method: "inspect" });
  assert.equal(FakeWorker.instances.length, 2);
  client.dispose();
  assert.deepEqual(revoked, ["blob:merge-1", "blob:merge-2"]);
});

test("dispose rejects RPCs already posted to a live worker", async () => {
  class HangingWorker extends FakeWorker {
    postMessage(message) { this.messages.push(message); }
  }
  const { client, revoked } = fixture({ WorkerClass: HangingWorker });
  const inflight = client.prepareLocal({ draft: new Uint8Array([1]) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(FakeWorker.instances[0].messages.length, 1);
  client.dispose();
  await assert.rejects(inflight, { code: "PDF_MERGE_CLIENT_DISPOSED" });
  assert.equal(FakeWorker.instances[0].terminated, true);
  assert.deepEqual(revoked, ["blob:merge-1"]);
});

test("prepare timing stays correlated to its save transaction across Worker RPC", async () => {
  const timings = [];
  class TimedWorker extends FakeWorker {
    postMessage(message) {
      this.messages.push(message);
      queueMicrotask(() => {
        for (const listener of this.listeners.get("message") || []) {
          listener({ data: {
            id: message.id,
            ok: true,
            result: { method: message.method },
            timing: { saveTransactionId: message.payload?.saveTransactionId, queueMs: 1, executeMs: 3, coreStages: { coreTotalMs: 2 } },
          } });
        }
      });
    }
  }
  const { client } = fixture({
    WorkerClass: TimedWorker,
    onTaskTiming: (timing) => timings.push(timing),
  });
  await client.prepareLocal({ saveTransactionId: "save-tx-17" });
  assert.equal(timings.length, 1);
  assert.equal(timings[0].saveTransactionId, "save-tx-17");
  assert.equal(timings[0].coreStages.coreTotalMs, 2);
  client.dispose();
});

test("worker failures retain the originating method and Worker stack for diagnostics", async () => {
  class ErrorWorker extends FakeWorker {
    postMessage(message) {
      this.messages.push(message);
      queueMicrotask(() => this.emit("message", { data: {
        id: message.id,
        ok: false,
        error: {
          name: "RangeError",
          code: "PDF_MERGE_CONFLICT",
          message: "Maximum call stack size exceeded",
          method: message.method,
          phase: "core.execute",
          stack: "RangeError: Maximum call stack size exceeded\\n    at reconcile (/worker/pdf-merge-core.js:20:4)",
        },
      } }));
    }
  }
  const { client } = fixture({ WorkerClass: ErrorWorker });
  await assert.rejects(client.prepareLocal({}), error => {
    assert.equal(error.name, "RangeError");
    assert.equal(error.code, "PDF_MERGE_CONFLICT");
    assert.equal(error.workerName, "RangeError");
    assert.equal(error.workerCode, "PDF_MERGE_CONFLICT");
    assert.equal(error.workerMethod, "prepareLocal");
    assert.equal(error.workerPhase, "core.execute");
    assert.match(error.workerStack, /reconcile/);
    return true;
  });
  client.dispose();
});

test("owned byte snapshots transfer once while client admission keeps later payloads off the Worker", async () => {
  const { client } = fixture({ WorkerClass: TransferWorker });
  const original = new Uint8Array([9, 8, 7]);
  const originalBuffer = original.buffer;
  const snapshot = client.snapshotBytes(original.subarray(1));
  const first = client.merge({ baseBytes: snapshot, localBytes: snapshot, marker: "first" });
  const second = client.inspect({ bytes: original, marker: "second" });
  await new Promise((resolve) => setImmediate(resolve));

  const worker = TransferWorker.instances[0];
  assert.equal(worker.messages.length, 1, "only the admitted request is posted");
  assert.deepEqual([...worker.messages[0].payload.baseBytes], [8, 7]);
  assert.equal(worker.messages[0].payload.localBytes, worker.messages[0].payload.baseBytes,
    "repeated references to one owned snapshot transfer only once");
  assert.equal(worker.transfers[0].length, 1);
  assert.equal(worker.transfers[0].includes(originalBuffer), false,
    "the host-owned input buffer is never detached");
  assert.equal(snapshot.byteLength, 0, "the one-use owned snapshot transfers to the Worker");
  assert.deepEqual([...original], [9, 8, 7]);

  worker.reply(worker.messages[0].id, { method: "merge" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.messages.length, 2);
  assert.deepEqual([...worker.messages[1].payload.bytes], [9, 8, 7]);
  assert.equal(worker.transfers[1].includes(originalBuffer), false);
  worker.reply(worker.messages[1].id, { method: "inspect" });
  assert.deepEqual(await Promise.all([first, second]), [
    { method: "merge" }, { method: "inspect" },
  ]);
  assert.deepEqual([...original], [9, 8, 7]);
  client.dispose();
});
