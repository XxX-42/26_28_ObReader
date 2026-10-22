# Resource-v2 and 25k transfer measurement plan

## Status

Protocol 1 ran partially and was stopped because failed trials left shared-origin IndexedDB residue. The 25k baseline passed. See RESOURCE_V2_BENCHMARK_RESULTS.md for all outcomes. Protocol 2 (off-record contexts) was rejected before execution; protocol 3 (a fresh ordinary on-disk profile and browser per trial) is prepared but NOT_RUN pending root review and a new performance lease. The public ECDICT resource was copied only from the prior isolated test artifact to ignored tests/artifacts/resource-v2/ and its SHA-256 was verified.

## Frozen resource

The benchmark requires resource-v2 with 770,611 entries, 16,734,703 compressed bytes, 69,667,588 uncompressed bytes, and SHA-256 b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126. The source stays in the public Obsidian resource folder; benchmark reads the isolated copy in this worktree.

## Predeclared cold-run order

Run each row five times, in the listed order, with a unique IndexedDB database and fresh owned ordinary Chrome on-disk profile per run. Browser closure runs in finally even on timeout. The harness writes this complete order to run-plan.json before launching Chromium. It records failed runs, does not retry or skip, and never chooses runs based on outcome. The 180-second protocol deadline is unchanged.

| Sequence | Variant | Batch size | Membership-tail reuse |
| --- | --- | ---: | --- |
| 1–5 | 4k-baseline | 4,000 | no |
| 6–10 | 4k-membership-tail | 4,000 | yes, isolated in-memory experiment matching commit ecca83d7 |
| 11–15 | 8k | 8,000 | no |
| 16–20 | 16k | 16,000 | no |

Each run measures the first lookup through full build completion, the full-ready event separately, 100 warm lookups, a reopened warm lookup path, readBinary duration/bytes, SHA duration/bytes, gzip read duration/input/output bytes, JSONL parse duration/record bytes/count, bulkPut duration/rows/transactions, membership get/put duration/calls/key-payload bytes/transactions, final count verification duration/result bytes/count/transaction, main-thread heap samples, and main-thread Long Tasks when available. Benchmark HTTP responses are `no-store` and Chromium's HTTP cache is disabled, so each cold-cache run rereads the copied resource; the operating system's filesystem cache is not flushed, so these are not cold-disk measurements.

The membership byte figure counts UTF-8 key payload bytes and excludes IndexedDB object/array overhead. The final count query reports its four-byte result and row count; browser APIs do not expose physical IndexedDB scan bytes. JSONL parse time covers JSON.parse; the harness records compact source-record byte counts outside that timer. Instrumentation overhead is identical across variants and should be considered when interpreting absolute times.

resource-v2 still fully builds before returning its first lookup. A faster first query in this experiment is not evidence of lazy first-query loading. Chromium viewport results are not physical iPad WKWebView results.

## 25k bundle transfer

After the P2 lease, rerun tests/vocabulary-transfer-large.test.mjs without timeout changes or retries. Capture transfer import read/write totals and the history, pending-intent, and other path categories separately. In memory only, compare a compact repeated-field envelope against the original History JSON and round-trip it back to prove no fields are lost. Do not write or commit that prototype as a new format.

## Gate

Only consider a minimal production proposal in dictionary-cache.cjs or its worker after all 20 runs and correctness checks complete, and only if the improvement is repeatable without weakening recovery, lease, integrity, or cancellation behavior. No WAL, transaction/History, or Vocabulary schema changes are in scope. No push or deployment is part of this work.
