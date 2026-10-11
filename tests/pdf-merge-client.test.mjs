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
