# Resource-v3 comparison benchmark

The opt-in harness compares the legacy resource-v2 full import with resource-v3's direct ranged lookup and three bounded in-memory block-cache limits. It is prepared but has **not run**; the current Native Obsidian browser lease takes precedence. The full resource and raw reports stay outside Git.

```sh
node tests/dictionary-v3-comparison-benchmark.mjs --run \
  /path/to/read-only/resource-v2 \
  /path/to/read-only/resource-v3 \
  /path/outside/worktree/ecdict-comparison-run
```

The output path must be outside the worktree. If Native acceptance has produced a startup-blocking measurement, include both `--native-startup-blocking-ms <measured-value>` and `--native-startup-evidence <evidence-reference>`. Without that separately captured value the harness will leave the smallest-passing cache limit unselected; a Chromium dictionary-only page cannot stand in for Native Obsidian startup.

The script writes its predeclared plan before launching Chrome, then runs five fixed round-robin repetitions of each variant. Every trial gets a new ordinary persistent Chrome profile, new browser process, and unique IndexedDB name. HTTP cache is disabled and server responses use `no-store`; OS filesystem cache is not flushed. A 180-second protocol deadline is preserved. Failures are recorded in place, without retry or timeout extension; any remaining declared rows are marked `NOT_RUN`.

The v2 comparator explicitly awaits `ensureReady()` before its first rare (`zyzzyva`) lookup. That captures the old full-build wait and includes it in the first-query result. The v3 variants call the first rare lookup directly and never request a v2 build. Each run then executes the same 20 warm samples, including common and rare words, a deliberate miss, block range endpoints, and a Unicode key. The v3 variants hold an 8 MiB estimated-byte cap fixed while varying the count cap across 8, 16, and 32 blocks.

Results include first rare and 20-query warm latency distributions, readBinary duration and bytes, v2 prepare and v3 block-worker timing where available, LRU occupancy and estimated bytes, Chromium heap and long-task observations where exposed, persistent profile growth, and IndexedDB file sizes. Physical IndexedDB I/O and Worker heap are not claimed. Unit coverage validates query and trial plans, the instrumentation build, and selection gating. Separate runtime tests cover full-row correctness, corruption/missing resources, range boundaries, Unicode normalization, coalesced readers, cache limits, invalidation, cache clear, and lazy v3 rebuild/warm behavior.
