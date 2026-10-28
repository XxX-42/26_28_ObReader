import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerSource = await readFile(path.join(root, "plugin/pdf-merge-worker.mjs"), "utf8");
const testHashRuntime = {
  fingerprint(value) { return `xxh64-v1:${String(value?.byteLength || 0).padStart(16, "0")}`; },
};

function boot(core) {
  let onMessage;
  const posts = [];
  const context = {
    __core: core,
    __hashRuntimeModule: { createPdfHashRuntime: async () => testHashRuntime },
    Uint8Array,
    addEventListener(type, listener) { if (type === "message") onMessage = listener; },
    postMessage(message, transfer = []) { posts.push({ message, transfer: [...transfer] }); },
  };
  context.globalThis = context;
  vm.runInNewContext(
    workerSource
      .replace('import core from "./pdf-merge-core.cjs";', "const core = globalThis.__core;")
      .replace('import outlineSource from "./pdf-outline-source.cjs";', "const outlineSource = globalThis.__core;")
      .replace('import hashRuntimeModule from "./pdf-hash-runtime.cjs";', "const hashRuntimeModule = globalThis.__hashRuntimeModule;"),
    context,
  );
  return { posts, send: (data) => onMessage({ data }) };
}

async function until(check) {
  const deadline = Date.now() + 1000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Worker response timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("the Worker serializes heavy RPCs even when several messages arrive together", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const core = {
    async inspect({ number }) {
      calls.push(number);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (number === 1) await firstGate;
      active -= 1;
      return { number };
    },
  };
  const worker = boot(core);
  worker.send({ id: 1, method: "inspect", payload: { number: 1 } });
  worker.send({ id: 2, method: "inspect", payload: { number: 2 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [1]);
  assert.equal(maxActive, 1);

  releaseFirst();
  await until(() => worker.posts.length === 2);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(maxActive, 1);
  assert.deepEqual(worker.posts.map((post) => post.message.id), [1, 2]);
});

test("the Worker transfers a whole owned output buffer without an extra copy", async () => {
  const output = new Uint8Array([4, 5, 6]);
  const worker = boot({ inspect: async () => ({ bytes: output }) });
  worker.send({ id: 1, method: "inspect", payload: { bytes: new Uint8Array([1]) } });
  await until(() => worker.posts.length === 1);
  assert.equal(worker.posts[0].message.result.bytes.buffer, output.buffer);
  assert.deepEqual(worker.posts[0].transfer, [output.buffer]);
});

test("the Worker copies a partial or input-aliasing output before transfer", async () => {
  const backing = new Uint8Array([0, 7, 8, 0]);
  const partial = backing.subarray(1, 3);
  const worker = boot({ inspect: async () => ({ bytes: partial }) });
  worker.send({ id: 1, method: "inspect", payload: { marker: true } });
  await until(() => worker.posts.length === 1);
  assert.deepEqual([...worker.posts[0].message.result.bytes], [7, 8]);
  assert.notEqual(worker.posts[0].message.result.bytes.buffer, backing.buffer);
  assert.deepEqual(worker.posts[0].transfer, [worker.posts[0].message.result.bytes.buffer]);

  const aliased = new Uint8Array([2, 3]);
  const aliasWorker = boot({ inspect: async ({ bytes }) => ({ bytes }) });
  aliasWorker.send({ id: 2, method: "inspect", payload: { bytes: aliased } });
  await until(() => aliasWorker.posts.length === 1);
  assert.deepEqual([...aliasWorker.posts[0].message.result.bytes], [2, 3]);
  assert.notEqual(aliasWorker.posts[0].message.result.bytes.buffer, aliased.buffer);
  assert.deepEqual([...aliased], [2, 3]);
});

test("the Worker transfers a whole incremental patch suffix without copying", async () => {
  const suffix = new Uint8Array([8, 9, 10]);
  const worker = boot({ merge: async () => ({ patch: { baseLength: 2, suffix } }) });
  worker.send({ id: 1, method: "merge", payload: { remoteBytes: new Uint8Array([1, 2]) } });
  await until(() => worker.posts.length === 1);
  assert.equal(worker.posts[0].message.result.patch.suffix.buffer, suffix.buffer);
  assert.deepEqual(worker.posts[0].transfer, [suffix.buffer]);
});

test("the Worker copies partial and input-aliasing incremental patch suffixes", async () => {
  const backing = new Uint8Array([0, 7, 8, 0]);
  const partialWorker = boot({ merge: async () => ({ patch: { suffix: backing.subarray(1, 3) } }) });
  partialWorker.send({ id: 1, method: "merge", payload: {} });
  await until(() => partialWorker.posts.length === 1);
  const partial = partialWorker.posts[0].message.result.patch.suffix;
  assert.deepEqual([...partial], [7, 8]);
  assert.notEqual(partial.buffer, backing.buffer);
  assert.deepEqual(partialWorker.posts[0].transfer, [partial.buffer]);

  const inputSuffix = new Uint8Array([2, 3]);
  const aliasWorker = boot({ merge: async ({ suffix }) => ({ patch: { suffix } }) });
  aliasWorker.send({ id: 2, method: "merge", payload: { suffix: inputSuffix } });
  await until(() => aliasWorker.posts.length === 1);
  const copied = aliasWorker.posts[0].message.result.patch.suffix;
  assert.deepEqual([...copied], [2, 3]);
  assert.notEqual(copied.buffer, inputSuffix.buffer);
  assert.deepEqual([...inputSuffix], [2, 3]);
  assert.deepEqual(aliasWorker.posts[0].transfer, [copied.buffer]);
});
