# Resource-v3 comparison and cache-residency benchmark

The opt-in Chrome harness compares the legacy resource-v2 full import with resource-v3 direct ranged lookup and bounded decoded-block LRUs. All full resources and raw reports remain outside Git.

```sh
node tests/dictionary-v3-comparison-benchmark.mjs --run \
  /path/to/read-only/resource-v2 \
  /path/to/read-only/resource-v3 \
  /path/outside/worktree/ecdict-comparison-run

node tests/dictionary-v3-cache-warm-probe-benchmark.mjs --run \
  /path/to/read-only/resource-v3 \
  /path/outside/worktree/ecdict-cache-warm-run
```

The comparison harness writes its predeclared plan before launching Chrome, then runs five fixed round-robin repetitions per variant. Each trial uses a new ordinary persistent Chrome profile, browser process, and IndexedDB name. HTTP cache is disabled and local responses use `no-store`; the OS filesystem cache is not flushed. Failures are recorded without retries or deadline extensions, and unstarted rows remain `NOT_RUN`.

The v2 comparator explicitly awaits `ensureReady()` before its first rare (`zyzzyva`) lookup. This captures the old full-build wait and includes it in end-to-end first-query latency. The v3 variants perform the first rare lookup directly and never request a v2 build. Each trial then executes the same fixed 20-query mixed workload covering common and rare words, a deliberate miss, range endpoints, and Unicode. Since those queries visit blocks that may not yet be resident, their `mixed20P95Ms` must not be treated as warm-cache latency. The variants hold an 8 MiB estimated-byte cap fixed while varying the count cap across 8, 16, and 32 blocks.

The separate 15-trial cache-residency harness runs five fresh-process trials per v3 capacity. In each trial it primes and repeats the same 20-key mixed workload, then primes and repeats 20 distinct keys from one SHA-verified block. It records per-query LRU hit/miss deltas and binary-read deltas. Only repeat lookups with a resident-block hit, no miss, and no new binary read count as `residentHit` samples. The same-block phase checks the warm-cache latency condition independently from the mixed working set. Both harnesses leave Native startup blocking unmeasured; a Chrome page cannot substitute for Native Obsidian startup evidence.

## Measurement on 2026-10-23

The fixed comparison completed **20/20 trials with no failures**. The five v2 `ensureReady()` full-import waits had a 72,160 ms median. Resource-v3 first-rare latency was:

| Variant | First rare P50 | First rare P95 | Mixed 20-query P95 |
| --- | ---: | ---: | ---: |
| LRU 8 blocks, 8 MiB | 46.0 ms | 89.8 ms | 26.6 ms |
| LRU 16 blocks, 8 MiB | 34.3 ms | 45.8 ms | 26.5 ms |
| LRU 32 blocks, 8 MiB | 34.0 ms | 39.8 ms | 25.6 ms |

The separate residency probe completed **15/15 trials with no failures**. Across the 100 repeated mixed queries for each setting, there were 70 resident hits and 30 misses; the 30 misses caused 30 binary block reads totalling 7,497,290 bytes. The resident-hit-only P95 was about 0.1 ms. The 20-key same-block repeat had 100/100 resident hits, zero misses, and zero binary reads for each setting; its measured P95 was 0–0.1 ms at the browser timer's resolution. Every same-block trial passed the residency check.

All three settings retained six blocks under the 8 MiB byte cap; the maximum recorded estimated LRU size was 8,010,974 bytes. The 8 MiB cap therefore constrained this workload before the 8/16/32 count limits could distinguish it. The measured mixed workload does not fit fully in any setting, including LRU 32. This is expected miss behavior and is reported separately from truly resident-block hits.

No cache capacity is selected from these runs: Native application-startup blocking has not been measured. The first-query target was met in Chrome for every v3 variant, and resident-hit latency was below 10 ms, but this does not establish Native startup behavior.

Raw plans, per-run JSONL, summaries, and profile observations were retained outside the repository in the sibling `evidence/` directory:

- `dictionary-v3-comparison-20261023T135238Z`
- `dictionary-v3-cache-warm-probe-20261023T142500Z`

The runtime tests additionally cover full-row equivalence, corruption and missing-resource errors, range boundaries, Unicode normalization, coalesced readers, LRU bounds, invalidation, cache clearing, and lazy v3 rebuild/warm behavior. Benchmark-only instrumentation is injected into the bundled source and does not modify production modules.
