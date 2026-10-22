import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { createDictionaryBenchmarkPlan, createDictionaryBenchmarkPlugin,
  DICTIONARY_BENCHMARK_VARIANTS, DICTIONARY_BENCHMARK_REPETITIONS,
  withDictionaryBenchmarkBrowser } from "./dictionary-resource-benchmark-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

test("each trial gets a fresh ordinary browser, including after timeout; setup failures close it", async () => {
  const contexts = [];
  let failSetup = false;
  const launch = async () => {
      const databaseNames = new Set();
      const context = { closed: false, databaseNames, async close() { this.closed = true; },
        async createBrowserContext() { assert.fail("off-record contexts change storage backing"); },
        async newPage() {
          if (failSetup) throw new Error("page setup failed");
          return { databaseNames, async setViewport(value) { assert.deepEqual(value, { width: 1000, height: 760 }); },
            async setCacheEnabled(value) { assert.equal(value, false); } };
        } };
      contexts.push(context);
      return context;
  };
  const timeout = new Error("Runtime.callFunctionOn timed out");
  await assert.rejects(withDictionaryBenchmarkBrowser(launch, async page => {
    page.databaseNames.add("failed-trial-database");
    throw timeout;
  }), error => error === timeout);
  assert.equal(contexts[0].closed, true);
  assert.equal(await withDictionaryBenchmarkBrowser(launch, async page => {
    assert.equal(page.databaseNames.has("failed-trial-database"), false);
    return "complete";
  }), "complete");
  assert.equal(contexts[1].closed, true);
  failSetup = true;
  await assert.rejects(withDictionaryBenchmarkBrowser(launch, () => assert.fail("setup failed")), /page setup failed/u);
  assert.equal(contexts.length, 3);
  assert.ok(contexts.every(context => context.closed));
});

test("the 20-run cold-cache order is fixed before outcomes are observed", () => {
  const plan = createDictionaryBenchmarkPlan();
  assert.equal(plan.length, 20);
  assert.deepEqual(plan.map(({ sequence }) => sequence), Array.from({ length: 20 }, (_, index) => index + 1));
  for (let index = 0; index < DICTIONARY_BENCHMARK_VARIANTS.length; index += 1) {
    const variant = DICTIONARY_BENCHMARK_VARIANTS[index];
    const group = plan.slice(index * DICTIONARY_BENCHMARK_REPETITIONS, (index + 1) * DICTIONARY_BENCHMARK_REPETITIONS);
    assert.ok(group.every(({ variant: id, repetition }) => id === variant.id && repetition >= 1 && repetition <= 5));
  }
});

test("all declared benchmark variants build with isolated instrumentation and the membership-tail experiment", async () => {
  for (const variant of DICTIONARY_BENCHMARK_VARIANTS) {
    const plugin = createDictionaryBenchmarkPlugin(variant);
    const worker = await build({
      entryPoints: [path.join(root, "plugin/vocabulary/dictionary-worker.cjs")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '\"production\"' },
      plugins: [plugin],
    });
    const runtime = await build({
      entryPoints: [path.join(root, "plugin/vocabulary/dictionary.cjs")],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      globalName: "DictionaryRuntime",
      define: {
        "process.env.NODE_ENV": '\"production\"',
        __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text),
      },
      plugins: [plugin],
    });
    const workerSource = worker.outputFiles[0].text;
    const runtimeSource = runtime.outputFiles[0].text;
    assert.match(workerSource, /__dictionaryBenchMetrics/u);
    assert.match(workerSource, /__dictionaryBenchUtf8Length/u);
    assert.match(runtimeSource, /benchmarkMetrics/u);
    assert.equal(workerSource.includes("canReuseTail"), variant.membershipTail);
  }
});

test("membership-tail experiment preserves sorted membership across cancellation and resume", async () => {
  const variant = DICTIONARY_BENCHMARK_VARIANTS.find(({ membershipTail }) => membershipTail);
  const buildResult = await build({
    entryPoints: [path.join(root, "plugin/vocabulary/dictionary-cache.cjs")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [createDictionaryBenchmarkPlugin(variant)],
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", buildResult.outputFiles[0].text)(
    loaded, loaded.exports, require,
  );
  const { DictionaryQueryCache } = loaded.exports;
  const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
  const entries = Array.from({ length: 10 }, (_, index) => ({
    key: "word" + String(index).padStart(3, "0"),
    translation: "definition " + index,
    phonetic: "p" + index,
  }));
  const jsonl = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const compressed = gzipSync(Buffer.from(jsonl));
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  const manifest = {
    schemaVersion: 1,
    kind: "pdf-reader-dictionary-resource",
    dictionaryId: "ECDICT",
    normalization: "nfc-lower-space-v1",
    entryCount: entries.length,
    compressedBytes: compressed.byteLength,
    uncompressedBytes: Buffer.byteLength(jsonl),
    sha256,
    resourceFile: "entries." + sha256 + ".jsonl.gz",
  };
  const cache = new DictionaryQueryCache({
    name: "dictionary-tail-experiment-" + crypto.randomUUID(),
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    batchSize: 2,
    ownerId: "membership-tail-test",
    yieldControl: async () => {},
  });
  try {
    const membershipGet = cache.db.membership.get.bind(cache.db.membership);
    let membershipGetCalls = 0;
    cache.db.membership.get = (...args) => {
      membershipGetCalls += 1;
      return membershipGet(...args);
    };
    const controller = new AbortController();
    await assert.rejects(cache.prepare(manifest, async () => compressed, {
      signal: controller.signal,
      onProgress(progress) {
        if (progress.phase === "building" && progress.count === 2) controller.abort();
      },
    }), (error) => error.code === "DICTIONARY_CACHE_CANCELLED");
    assert.equal(membershipGetCalls, 0, "fresh sorted import must not reread its active membership tail");

    membershipGetCalls = 0;
    const ready = await cache.prepare(manifest, async () => compressed);
    assert.equal(ready.status, "ready");
    assert.equal(ready.count, entries.length);
    assert.equal(membershipGetCalls, 1, "resume reads the unfinished bucket once before reusing its tail");
    const row = await cache.db.membership.get([ready.id, "wo"]);
    assert.deepEqual(row.keys, entries.map(({ key }) => key));
    assert.equal(await cache.entryCount(ready.id), entries.length);

    const corrupted = Buffer.from(compressed);
    corrupted[0] ^= 1;
    await assert.rejects(cache.prepare(manifest, async () => corrupted, { force: true }),
      (error) => error.code === "DICTIONARY_RESOURCE_CORRUPT");
    assert.equal((await cache.active()).id, ready.id,
      "a corrupt replacement must leave the previous verified generation active");

    const sharedIdb = new IDBFactory();
    const name = "dictionary-tail-fence-" + crypto.randomUUID();
    const options = { name, indexedDB: sharedIdb, IDBKeyRange, batchSize: 2,
      leaseMs: 100, yieldControl: async () => {} };
    const oldOwner = new DictionaryQueryCache({ ...options, ownerId: "old", now: () => 1000 });
    const newOwner = new DictionaryQueryCache({ ...options, ownerId: "new", now: () => 1101 });
    let releaseOld, startedOld;
    const gate = new Promise(resolve => { releaseOld = resolve; });
    const started = new Promise(resolve => { startedOld = resolve; });
    try {
      const stale = oldOwner.prepare(manifest, async () => {
        startedOld(); await gate; return compressed;
      });
      await started;
      const takeover = await newOwner.prepare(manifest, async () => compressed);
      releaseOld();
      await assert.rejects(stale, error => error.code === "DICTIONARY_CACHE_LEASE_LOST");
      assert.equal((await newOwner.active()).id, takeover.id);
      assert.equal((await newOwner.ready(manifest)).owner, null);
      assert.deepEqual((await newOwner.db.membership.get([takeover.id, "wo"])).keys,
        entries.map(({ key }) => key));
    } finally {
      releaseOld(); oldOwner.close(); newOwner.close();
    }
  } finally {
    cache.close();
  }
});
