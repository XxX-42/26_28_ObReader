import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const DICTIONARY_BENCHMARK_VARIANTS = Object.freeze([
  Object.freeze({ id: "4k-baseline", batchSize: 4000, membershipTail: false }),
  Object.freeze({ id: "4k-membership-tail", batchSize: 4000, membershipTail: true }),
  Object.freeze({ id: "8k", batchSize: 8000, membershipTail: false }),
  Object.freeze({ id: "16k", batchSize: 16000, membershipTail: false }),
]);

export const DICTIONARY_BENCHMARK_REPETITIONS = 5;

export async function withDictionaryBenchmarkBrowser(launchFreshBrowser, run) {
  const browser = await launchFreshBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 760 });
    await page.setCacheEnabled(false);
    return await run(page);
  } finally {
    await browser.close();
  }
}

export function createDictionaryBenchmarkPlan() {
  return DICTIONARY_BENCHMARK_VARIANTS.flatMap((variant, variantIndex) =>
    Array.from({ length: DICTIONARY_BENCHMARK_REPETITIONS }, (_, repetition) => ({
      sequence: variantIndex * DICTIONARY_BENCHMARK_REPETITIONS + repetition + 1,
      variant: variant.id,
      repetition: repetition + 1,
    })));
}

function replaceOnce(source, search, replacement, label) {
  const matches = source.split(search).length - 1;
  assert.equal(matches, 1, `Expected one ${label} instrumentation seam, found ${matches}`);
  return source.replace(search, replacement);
}

async function readSource(filename) {
  return (await readFile(filename, "utf8")).replace(/\r\n/gu, "\n");
}

function instrumentResource(source) {
  source = replaceOnce(source,
    "async function verifyResource(manifest, value) {\n  const bytes = asBytes(value);",
    "async function verifyResource(manifest, value) {\n  const __bench = globalThis.__dictionaryBenchMetrics;\n  const __verifyStarted = performance.now();\n  const bytes = asBytes(value);",
    "SHA-256 timer start");
  source = replaceOnce(source,
    "  return bytes;\n}\n\n/** Stream JSONL in bounded batches instead of allocating a 770k-entry array. */",
    "  if (__bench) { __bench.sha256Ms = performance.now() - __verifyStarted; __bench.sha256Bytes = bytes.byteLength; }\n  return bytes;\n}\n\n/** Stream JSONL in bounded batches instead of allocating a 770k-entry array. */",
    "SHA-256 timer result");
  source = replaceOnce(source,
    "async function decodeResource(manifest, bytes, onBatch, { batchSize = 1000, checkCancelled = () => {} } = {}) {\n  if (typeof globalThis.DecompressionStream",
    "async function decodeResource(manifest, bytes, onBatch, { batchSize = 1000, checkCancelled = () => {} } = {}) {\n  const __bench = globalThis.__dictionaryBenchMetrics;\n  const __decodeStarted = performance.now();\n  const __benchEncoder = __bench ? new TextEncoder() : null;\n  let __gzipReadMs = 0, __batchRecordBytes = 0, __recordBytes = 0, __parsedRecords = 0;\n  if (typeof globalThis.DecompressionStream",
    "decode instrumentation setup");
  source = replaceOnce(source,
    "    let entry;\n    try { entry = JSON.parse(text); } catch (cause) {\n      throw dictionaryError(\"Dictionary resource contains malformed JSONL.\", \"DICTIONARY_RESOURCE_CORRUPT\", cause);\n    }",
    "    let entry;\n    const __parseStarted = __bench ? performance.now() : 0;\n    try { entry = JSON.parse(text); } catch (cause) {\n      throw dictionaryError(\"Dictionary resource contains malformed JSONL.\", \"DICTIONARY_RESOURCE_CORRUPT\", cause);\n    }\n    if (__bench) {\n      __bench.jsonlParseMs += performance.now() - __parseStarted;\n      const __lineBytes = __benchEncoder.encode(text).byteLength;\n      __recordBytes += __lineBytes;\n      __batchRecordBytes += __lineBytes;\n      __parsedRecords += 1;\n    }",
    "JSON.parse instrumentation");
  source = replaceOnce(source,
    "      await onBatch(batch, { count, lastKey });\n      batch = [];",
    "      await onBatch(batch, { count, lastKey, jsonlRecordBytes: __batchRecordBytes });\n      __batchRecordBytes = 0;\n      batch = [];",
    "full-batch source byte propagation");
  source = replaceOnce(source,
    "      const chunk = await reader.read();\n      if (chunk.done) break;",
    "      const __readStarted = __bench ? performance.now() : 0;\n      const chunk = await reader.read();\n      if (__bench) __gzipReadMs += performance.now() - __readStarted;\n      if (chunk.done) break;",
    "gzip read timer");
  source = replaceOnce(source,
    "    if (batch.length) await onBatch(batch, { count, lastKey });\n    return { count, lastKey };",
    "    if (batch.length) await onBatch(batch, { count, lastKey, jsonlRecordBytes: __batchRecordBytes });\n    if (__bench) {\n      __bench.gzipReadMs += __gzipReadMs;\n      __bench.gzipInputBytes = bytes.byteLength;\n      __bench.gzipOutputBytes = uncompressedBytes;\n      __bench.jsonlRecordBytes = __recordBytes;\n      __bench.jsonlParsedRecords = __parsedRecords;\n      __bench.decodeWallMs = performance.now() - __decodeStarted;\n    }\n    return { count, lastKey };",
    "decode metrics result");
  return source;
}

function instrumentCache(source, variant) {
  const helpers = `function __dictionaryBenchRecord(stage, { durationMs = 0, bytes = 0, rows = 0, transactions = 0 } = {}) {\n  const metrics = globalThis.__dictionaryBenchMetrics;\n  if (!metrics) return;\n  const current = metrics.stages[stage] || (metrics.stages[stage] = { calls: 0, durationMs: 0, bytes: 0, rows: 0, transactions: 0 });\n  current.calls += 1; current.durationMs += durationMs; current.bytes += bytes; current.rows += rows; current.transactions += transactions;\n}\nfunction __dictionaryBenchUtf8Length(value) {\n  let bytes = 0;\n  for (let index = 0; index < value.length; index += 1) {\n    const code = value.charCodeAt(index);\n    if (code <= 0x7f) bytes += 1;\n    else if (code <= 0x7ff) bytes += 2;\n    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index += 1; }\n    else bytes += 3;\n  }\n  return bytes;\n}\nasync function __dictionaryBenchMembershipGet(table, key, bucket) {\n  const metrics = globalThis.__dictionaryBenchMetrics;\n  const started = metrics ? performance.now() : 0;\n  const row = await table.get(key);\n  if (metrics) {\n    const bytes = metrics.membershipBucketUtf8Bytes[bucket] || 0;\n    __dictionaryBenchRecord(\"membership\", { durationMs: performance.now() - started, bytes, rows: row?.keys?.length || 0 });\n    metrics.membershipReadCalls += 1; metrics.membershipReadBytes += bytes;\n  }\n  return row;\n}\nasync function __dictionaryBenchMembershipPut(table, row, bucket, addedKeyBytes) {\n  const metrics = globalThis.__dictionaryBenchMetrics;\n  const started = metrics ? performance.now() : 0;\n  await table.put(row);\n  if (metrics) {\n    const bytes = (metrics.membershipBucketUtf8Bytes[bucket] || 0) + addedKeyBytes;\n    metrics.membershipBucketUtf8Bytes[bucket] = bytes;\n    __dictionaryBenchRecord(\"membership\", { durationMs: performance.now() - started, bytes, rows: row.keys.length });\n    metrics.membershipWriteCalls += 1; metrics.membershipWriteBytes += bytes;\n  }\n}\n`;
  source = replaceOnce(source, "const DEFAULT_CACHE_NAME = \"pdf-web-reader-dictionaries-v1\";\n", `const DEFAULT_CACHE_NAME = "pdf-web-reader-dictionaries-v1";\n${helpers}`, "cache metric helpers");
  source = replaceOnce(source,
    "if (fresh.length) await this.db.entries.bulkPut(fresh.map(entry => ({ generation: id, ...entry })));",
    "if (fresh.length) {\n            const __bulkStarted = globalThis.__dictionaryBenchMetrics ? performance.now() : 0;\n            await this.db.entries.bulkPut(fresh.map(entry => ({ generation: id, ...entry })));\n            __dictionaryBenchRecord(\"bulkPut\", { durationMs: globalThis.__dictionaryBenchMetrics ? performance.now() - __bulkStarted : 0, bytes: progress.jsonlRecordBytes || 0, rows: fresh.length, transactions: 1 });\n          }",
    "bulkPut timing");
  source = replaceOnce(source,
    "          const buckets = new Map();\n          for (const entry of fresh) {\n            const bucket = entry.key.slice(0, 2);\n            if (!buckets.has(bucket)) buckets.set(bucket, []);\n            buckets.get(bucket).push(entry.key);\n          }",
    "          const buckets = new Map(), bucketKeyBytes = new Map();\n          for (const entry of fresh) {\n            const bucket = entry.key.slice(0, 2);\n            if (!buckets.has(bucket)) buckets.set(bucket, []);\n            buckets.get(bucket).push(entry.key);\n            bucketKeyBytes.set(bucket, (bucketKeyBytes.get(bucket) || 0) + __dictionaryBenchUtf8Length(entry.key));\n          }",
    "membership key byte tracking");

  const baselineMembership = `          for (const [bucket, keys] of buckets) {\n            const existing = await __dictionaryBenchMembershipGet(this.db.membership, [id, bucket], bucket);\n            const membershipKeys = [...(existing?.keys || []), ...keys];\n            await __dictionaryBenchMembershipPut(this.db.membership, { generation: id, bucket, keys: membershipKeys }, bucket, bucketKeyBytes.get(bucket) || 0);\n          }`;
  if (variant.membershipTail) {
    source = replaceOnce(source,
      "    const id = lease.id;\n    try {\n      onProgress({ phase: \"verifying\", count: lease.count, total: manifest.entryCount });",
      "    const id = lease.id;\n    let membershipTail = null;\n    try {\n      onProgress({ phase: \"verifying\", count: lease.count, total: manifest.entryCount });",
      "membership-tail state setup");
    source = replaceOnce(source,
      "          for (const [bucket, keys] of buckets) {\n            const existing = await this.db.membership.get([id, bucket]);\n            await this.db.membership.put({ generation: id, bucket, keys: [...(existing?.keys || []), ...keys] });\n          }",
      "          const previousBucket = current.lastKey ? current.lastKey.slice(0, 2) : \"\";\n          for (const [bucket, keys] of buckets) {\n            let membershipKeys = keys;\n            if (bucket === previousBucket) {\n              const canReuseTail = membershipTail?.bucket === bucket && membershipTail.lastKey === current.lastKey;\n              const existingKeys = canReuseTail ? membershipTail.keys : (await __dictionaryBenchMembershipGet(this.db.membership, [id, bucket], bucket))?.keys || [];\n              if (existingKeys.length) { existingKeys.push(...keys); membershipKeys = existingKeys; }\n            }\n            await __dictionaryBenchMembershipPut(this.db.membership, { generation: id, bucket, keys: membershipKeys }, bucket, bucketKeyBytes.get(bucket) || 0);\n            membershipTail = { bucket, keys: membershipKeys, lastKey: keys[keys.length - 1] };\n          }",
      "membership-tail candidate loop");
  } else {
    source = replaceOnce(source,
      "          for (const [bucket, keys] of buckets) {\n            const existing = await this.db.membership.get([id, bucket]);\n            await this.db.membership.put({ generation: id, bucket, keys: [...(existing?.keys || []), ...keys] });\n          }",
      baselineMembership,
      "baseline membership instrumentation");
  }

  source = replaceOnce(source,
    "        await this.db.transaction(\"rw\", this.db.generations, this.db.entries, this.db.membership, async () => {",
    "        const __importTransactionStarted = globalThis.__dictionaryBenchMetrics ? performance.now() : 0;\n        await this.db.transaction(\"rw\", this.db.generations, this.db.entries, this.db.membership, async () => {",
    "import transaction timer start");
  source = replaceOnce(source,
    "        }).catch(error => { throw cacheError(error); });\n        onProgress({ phase: \"building\", count: progress.count, total: manifest.entryCount });",
    "        }).catch(error => { throw cacheError(error); });\n        if (globalThis.__dictionaryBenchMetrics) {\n          const __durationMs = performance.now() - __importTransactionStarted;\n          const __metrics = globalThis.__dictionaryBenchMetrics;\n          __dictionaryBenchRecord(\"importTransaction\", { durationMs: __durationMs, bytes: progress.jsonlRecordBytes || 0, rows: batch.length, transactions: 1 });\n          __metrics.importTransactionCount += 1;\n          __metrics.stages.membership.transactions += 1;\n        }\n        onProgress({ phase: \"building\", count: progress.count, total: manifest.entryCount });",
    "import transaction timer result");
  source = replaceOnce(source,
    "      const ready = await this.db.transaction(\"rw\", this.db.generations, this.db.entries, this.db.active, async () => {",
    "      const __finalVerifyStarted = globalThis.__dictionaryBenchMetrics ? performance.now() : 0;\n      let __verifiedEntryCount = 0;\n      const ready = await this.db.transaction(\"rw\", this.db.generations, this.db.entries, this.db.active, async () => {",
    "final verification timer start");
  source = replaceOnce(source,
    "        const count = await this.db.entries.where(\":id\").between([id, Dexie.minKey], [id, Dexie.maxKey], true, true).count();\n        if (current.count !== manifest.entryCount || count !== manifest.entryCount) {",
    "        const __countStarted = globalThis.__dictionaryBenchMetrics ? performance.now() : 0;\n        const count = await this.db.entries.where(\":id\").between([id, Dexie.minKey], [id, Dexie.maxKey], true, true).count();\n        __verifiedEntryCount = count;\n        __dictionaryBenchRecord(\"finalCountQuery\", { durationMs: globalThis.__dictionaryBenchMetrics ? performance.now() - __countStarted : 0, bytes: 4, rows: count });\n        if (current.count !== manifest.entryCount || count !== manifest.entryCount) {",
    "final count query metric");
  source = replaceOnce(source,
    "      });\n      onProgress({ phase: \"ready\", count: ready.count, total: manifest.entryCount });",
    "      });\n      __dictionaryBenchRecord(\"finalVerify\", { durationMs: globalThis.__dictionaryBenchMetrics ? performance.now() - __finalVerifyStarted : 0, bytes: 4, rows: __verifiedEntryCount, transactions: 1 });\n      onProgress({ phase: \"ready\", count: ready.count, total: ready.count });",
    "final verification timer result");
  return source;
}

function instrumentWorker(source, variant) {
  source = replaceOnce(source,
    "  try {\n    // The worker can use a larger bounded batch without blocking Reader input.\n    // Cooperative main-thread fallback retains the smaller default batch.\n    cache = new DictionaryQueryCache({ name: data.cacheName, ownerId: data.ownerId, batchSize: 4000 });",
    `  try {\n    globalThis.__dictionaryBenchMetrics = {\n      sha256Ms: 0, sha256Bytes: 0, gzipReadMs: 0, gzipInputBytes: 0, gzipOutputBytes: 0,\n      jsonlParseMs: 0, jsonlRecordBytes: 0, jsonlParsedRecords: 0, decodeWallMs: 0,\n      membershipReadCalls: 0, membershipReadBytes: 0, membershipWriteCalls: 0, membershipWriteBytes: 0,\n      membershipBucketUtf8Bytes: {}, importTransactionCount: 0,\n      stages: { membership: { calls: 0, durationMs: 0, bytes: 0, rows: 0, transactions: 0 } }\n    };\n    // Benchmark-only batch size; the production worker keeps its frozen default.\n    cache = new DictionaryQueryCache({ name: data.cacheName, ownerId: data.ownerId, batchSize: ${variant.batchSize} });`,
    "worker batch-size and metrics setup");
  return replaceOnce(source,
    "    self.postMessage({ type: \"ready\", ready });",
    "    self.postMessage({ type: \"ready\", ready, metrics: globalThis.__dictionaryBenchMetrics });",
    "worker metrics result");
}

function instrumentDictionary(source) {
  return replaceOnce(source,
    "          else if (data?.type === \"ready\") finish(resolve, data.ready);",
    "          else if (data?.type === \"ready\") { this.benchmarkMetrics = data.metrics || null; finish(resolve, data.ready); }",
    "runtime worker metrics capture");
}

export function createDictionaryBenchmarkPlugin(variant) {
  return {
    name: `dictionary-resource-benchmark-${variant.id}`,
    setup(build) {
      build.onLoad({ filter: /dictionary-resource\.cjs$/ }, async ({ path }) => ({
        contents: instrumentResource(await readSource(path)), loader: "js",
      }));
      build.onLoad({ filter: /dictionary-cache\.cjs$/ }, async ({ path }) => ({
        contents: instrumentCache(await readSource(path), variant), loader: "js",
      }));
      build.onLoad({ filter: /dictionary-worker\.cjs$/ }, async ({ path }) => ({
        contents: instrumentWorker(await readSource(path), variant), loader: "js",
      }));
      build.onLoad({ filter: /dictionary\.cjs$/ }, async ({ path }) => ({
        contents: instrumentDictionary(await readSource(path)), loader: "js",
      }));
    },
  };
}
