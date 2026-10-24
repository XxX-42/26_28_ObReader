# Resource-v3 LRU and startup audit (non-Native)

This evidence uses the unchanged production VocabularyDictionary runtime with a read-only Node filesystem adapter over the existing temporary 67-block converted dictionary at `/private/tmp/obreader-v3-generated-with-license`. No Obsidian renderer, Native UI, Vault, remote repository, production source, or app restart was touched.

Reproduce from this worktree: `node evidence/014-resource-v3-startup-audit/lru-audit.mjs` and `node evidence/014-resource-v3-startup-audit/dexie-constructor-audit.mjs`. Output JSON includes the exact shared lookup sequences, manifest canonical-JSON hash, every latency sample, read/decode counts, and runtime resident-byte estimates. The raw getCachedBlock miss probe is called twice on a miss by lookupV3/loadBlock; query hit/miss counts correctly use one result per lookup.

The fixed-order, one-trial synthetic traces deliberately cover different range working sets. They are not an observed user trace or a statistical Native latency comparison. Real checksum/gzip/UTF-8/JSON validation is executed for each cache miss using the product cooperative decode fallback. Worker is disabled in Node. OS cache is retained. The 128MiB diagnostic budget is used only to separate count-cap sensitivity; it is not a proposed product memory budget. Peak estimated resident bytes exclude decode transients, total heap/RSS, Dexie, and Worker memory.

Capacity decision: do not change the production default on this evidence. At the actual 8MiB budget, byte eviction dominates before all three count limits. Choosing 8 because it ties 16/32 here would only select the smallest indistinguishable experimental count, not prove a production capacity. The diagnostic budget can reveal which count accommodates each synthetic working set, but cannot establish a universal passing capacity. Resident-hit p95 <10ms applies to explicitly verified zero-read resident queries, not every repeated query after eviction. Mixed workload latency and re-decode rate must be reported separately. A captured representative user lookup trace and Native measurements remain needed before freezing a capacity.

Dexie remains a constructor/module dependency, although successful v3 availability/lookup performs no Dexie reads or full generation import. The constructor diagnostic measures actual new Dexie/schema setup against injected inert cache setup, without calling any cache I/O. Node has no IndexedDB factory; these numbers do not prove Native construction cost or startup acceptance. First module require includes all dependencies and is not attributable solely to Dexie.

`startup added blocking <50ms` remains NOT_MEASURED. Plugin-enable elapsed time, new dictionary instances in an existing process, asynchronous manifest I/O elapsed time, and absence of a long task do not measure the required paired cold-process startup increment. A defensible gate needs pre-bundle Native tracing, a paired same-plugin baseline with only availability activation controlled, an interval including deferred availability processing, attributed renderer-main task durations, longest task, and explicitly defined aggregate/percentile. TBT alone omits all tasks <=50ms. Under the current no-restart/no-production-edit restriction that strict gate cannot be completed.

A safe future current-Host LRU probe requires an explicit Native benchmark lease and exact test-Vault identity, already closed Reader leaves, no navigation/plugin toggling, and a read-only adapter surface exposing only read/readBinary. Run temporary Dictionary instances with the unchanged current bundled runtime, same trace/limits and unique cache namespaces; assert successful v3 never opens IndexedDB. Collect Worker decode request/result IDs (not merely Worker presence), reads, checksum/decode counters, cache stats and timings; dispose Workers and handles after completion. This tests Host-environment dictionary behavior without touching UI or personal data; it still does not test Reader tap-to-render latency or cold startup. It was not executed in this audit because Native/Vault access is prohibited here.

## Completed actual-runtime results

| Budget MiB | Trace | Cap | Hits / lookups | Actual decodes | Peak estimated MiB | Lookup p95 ms |
|---:|---|---:|---:|---:|---:|---:|
| 8 | resident-six | 8 | 0/24 | 24 | 7.00 | 85.18 |
| 8 | resident-six | 16 | 0/24 | 24 | 7.00 | 102.44 |
| 8 | resident-six | 32 | 0/24 | 24 | 7.00 | 87.89 |
| 8 | cyclic-twelve | 8 | 0/36 | 36 | 7.00 | 87.20 |
| 8 | cyclic-twelve | 16 | 0/36 | 36 | 7.00 | 104.45 |
| 8 | cyclic-twelve | 32 | 0/36 | 36 | 7.00 | 91.64 |
| 8 | cyclic-twentyfour | 8 | 0/72 | 72 | 7.04 | 85.32 |
| 8 | cyclic-twentyfour | 16 | 0/72 | 72 | 7.04 | 91.03 |
| 8 | cyclic-twentyfour | 32 | 0/72 | 72 | 7.04 | 91.99 |
| 8 | full-scan-twice | 8 | 0/134 | 134 | 7.63 | 91.77 |
| 8 | full-scan-twice | 16 | 0/134 | 134 | 7.63 | 93.19 |
| 8 | full-scan-twice | 32 | 0/134 | 134 | 7.63 | 95.63 |
| 128 | resident-six | 8 | 18/24 | 6 | 8.38 | 88.81 |
| 128 | resident-six | 16 | 18/24 | 6 | 8.38 | 67.71 |
| 128 | resident-six | 32 | 18/24 | 6 | 8.38 | 68.01 |
| 128 | cyclic-twelve | 8 | 0/36 | 36 | 11.19 | 96.12 |
| 128 | cyclic-twelve | 16 | 24/36 | 12 | 16.72 | 109.41 |
| 128 | cyclic-twelve | 32 | 24/36 | 12 | 16.72 | 85.52 |
| 128 | cyclic-twentyfour | 8 | 0/72 | 72 | 11.25 | 89.70 |
| 128 | cyclic-twentyfour | 16 | 0/72 | 72 | 22.46 | 99.19 |
| 128 | cyclic-twentyfour | 32 | 48/72 | 24 | 33.58 | 90.93 |
| 128 | full-scan-twice | 8 | 0/134 | 134 | 11.25 | 88.30 |
| 128 | full-scan-twice | 16 | 0/134 | 134 | 22.47 | 93.00 |
| 128 | full-scan-twice | 32 | 0/134 | 134 | 44.87 | 94.47 |

At 128MiB, smallest count retaining the complete 6/12/24-block synthetic working sets is respectively 8/16/32. None of the tested counts retains a 67-block cyclic working set. These are working-set-specific diagnostics, not a universal capacity selection. At 8MiB no tested capacity passes a mixed-repeat resident-latency interpretation; all misses cost actual decoding.
