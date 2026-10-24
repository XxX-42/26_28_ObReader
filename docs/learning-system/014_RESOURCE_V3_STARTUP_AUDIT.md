# Resource-v3 startup and Native evidence audit

Audited base: `f7191b89aca60f92de13ab04b0225c4b2fd3f7d8` (2026-10-25).
This audit makes no production changes and does not connect to Obsidian, open a
Reader, enable a plugin, or read/write Vault data.

## Four Native metrics

The existing `evidence/014-resource-v3/native-data-adapter-benchmark-20261025.json`
identifies its runtime as a standalone dictionary injected into an existing
Obsidian renderer, explicitly excluding plugin Host/Reader wiring. Its dictionary
and Worker source SHA-256 values match the audited base exactly. Five trials use
new instances/Workers per query, retaining the process/origin and OS cache; each
instance then performs twenty resident repeats.

| Metric | Evidence established | Integrated Host/Reader acceptance |
| --- | --- | --- |
| Startup added blocking <50 ms | **NOT_MEASURED**; report explicitly says attaching after startup cannot attribute startup CPU/blocking | Not proven |
| First common query | `on`: instance-cold P50 159.8 ms, P95/max of five 423.8 ms | Not proven; excludes migration barrier, message dispatch and rendering |
| First rare query | `zyzzyva`: instance-cold P50 112.5 ms, P95/max of five 276.5 ms | Not proven; process-cold/OS-cold behavior unmeasured |
| Resident warm query | Reported P95 <=0.1 ms with cache-hit/read-count instrumentation | Proven only for these module resident repeats; Host-to-visible-result and memory-pressure behavior unmeasured |

The three lookup results meet the numerical module-level targets for the sampled
workload. Five first-query samples are a small descriptive sample, not a robust
tail-latency guarantee. Warm precision is limited by the renderer clock. No one
of the four metrics proves enabled-plugin UI acceptance. The valid not-found
sample is a correctness/control case, not a substitute for the rare hit.

## Integrated code and deterministic coverage

- `plugin/vocabulary/dictionary.cjs`: manifest range search selects one verified
  gzip block; entries are binary-searched. Missing/corrupt resources and ordinary
  misses remain distinct. Lookup never initiates the legacy full import; fallback
  requires a ready v2 generation with matching provenance.
- `plugin/main.js`: enabled startup defers `checkAvailability()` on a timer;
  refresh and explicit recheck also use availability, not full import. Availability
  verifies the manifest; deferral alone says nothing about eventual event-loop
  blocking during manifest validation. Reader token lookup waits for vocabulary
  initialization, combines personal and dictionary reads, rereads personal state,
  and fences stale results by Reader identity. These costs are absent from the
  injected benchmark.
- Create/modify/delete/rename resource events invalidate v3 and v2 compatibility
  resources and debounce enabled refresh. Runtime invalidation clears manifest,
  ready-generation, LRU and in-flight coalescing slots, increments revision and
  fences awaited results. Disposal cancels Worker requests and clears memory.
- Worker decode transfers bytes, verifies results and supports verified
  cooperative fallback when Worker startup fails. Existing Native evidence
  records Worker presence/decode metrics, but does not prove fallback scheduling
  in Native. LRU limits are 16 blocks / 8 MiB **estimated decoded bytes**, not an
  actual heap ceiling; compressed buffers, Worker heap, transfer/clone overhead
  and transient concurrent decodes are outside that bound. Capacity selection
  under Native memory pressure remains provisional.

## Can startup safely be measured within this scope?

An actual incremental startup measurement requires capture before the relevant
startup work and a paired baseline/candidate with equivalent app, settings,
resources, cache state and hardware. CPU/task or event-loop blocking must be
separated from asynchronous DataAdapter elapsed time. Trace attribution must
include the deferred availability task rather than ending at plugin `onload`.

The supplied scope forbids Obsidian UI/process interaction and plugin enabling;
there is no retained controlled startup trace in the cited evidence. Consequently
**a new actual Native Host startup measurement cannot be obtained here**. Passive
analysis of an already captured adequate trace would be safe, but cannot recreate
missing baseline/marks. Running the existing attach-only harness again cannot
recover startup. An isolated browser/Electron fixture or injected module
availability benchmark can research synchronous decode/manifest costs without
Vault data, but must remain fixture/module evidence. No new collector was added:
a collector that observes after startup would add no missing startup proof.

For a future separately authorized Native session, use a disposable test Vault
with fixture-only resources, start tracing before baseline/candidate startup,
record deferred availability tasks and event-loop blocking, repeat paired trials,
and collect real Reader request-to-visible-result common/rare/warm timings. Keep
that work separate from the current audit; no restart, deployment or activation
is authorized or performed by this document.

## Local validation

`npm ci --ignore-scripts` installed lockfile dependencies only in this isolated
worktree. Initial checks could not load missing dependencies; after installation,
`node --test tests/dictionary-resource-v3.test.mjs tests/dictionary-host-state.test.mjs tests/build-dictionary-resource-v3.test.mjs tests/dictionary-resource-benchmark-support.test.mjs`
passed **45 tests**, zero failures/skips. The Host tests cover deferred availability,
resource invalidation/recheck, migration ordering and stale lookup cancellation;
the runtime tests cover integrity, provenance fallback, coalescing/LRU, Worker
transfer/fallback, in-flight invalidation and disposal. These deterministic Node
checks establish behavior, not Native timing. No full build/release gate or Native
measurement was performed for this documentation-only audit.
