# Phase F — hardening and nightly stress

The reproducible stress command is:

```sh
npm run test:vocabulary-nightly
```

It runs for 30 minutes by default. `--duration-ms=N` can be passed for a
diagnostic run, but any run shorter than 30 minutes is deliberately marked
ineligible for acceptance. Each full round runs sequentially:

1. The vocabulary benchmark at 5,340 and 25,000 records with 6,000 page tokens,
   a 12-token phrase, cold/warm/re-entry/next-page matching and overflow
   rejection.
2. The 25,000-record complete-bundle export/preview/import test, which records
   files touched, directory count, read/write bytes and History size.
3. Fast Gate, including migration/schema/family, dictionary corruption and
   concurrent reads, Context, Review, restore, transaction failure injection,
   and hot-path boundary tests.
4. Functional Browser Gate, including Viewer lifecycle, LingQ UI, zoom and
   offline three-file smoke.
5. Ten-round two-process Race Gate.

The runner stops on the first failed child, preserves raw stdout/stderr per
case, and atomically updates a JSON report after each case. It records the
source fingerprint and SHA-256 of test PDF fixtures before and after the run.
Acceptance requires a complete 30-minute run, all cases green, stable source,
and unchanged fixture PDFs. Its platform label is Node DataAdapter plus
Chromium simulation; it cannot mark real iPadOS acceptance.

## Final targeted checks

- Fast Gate passed **91/91** with no skips. Standalone report:
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-18T00-03-17-617Z-64721-f82efdea/report.json`.
- The 100% → 125% → 200% zoom regression passed; it asserts lexical result
  reuse and no additional host query or phrase rematch at either zoom level.
- The 25,000-record bundle test passed. It touched 9 files across 11
  directories, read 123,334,735 bytes and wrote 57,530,525 bytes for complete
  bundle import plus History. That is bulk transfer cost, not per-rating I/O.
- A final-state in-memory DataAdapter I/O sample records one Review rating as a
  1,144-byte append to one local session journal, with zero snapshot writes or
  History writes before acknowledgement. Session finalization is measured
  separately.
- `npm run build` passed after the transaction recovery fix: candidate package
  is `dist/pdf-web-reader/{main.js,manifest.json,styles.css}` (version 0.11.6),
  with 406 runtime assets and 402 frozen vendor files. Bundle size is
  8,230,966 bytes.

No production Vault or user PDF was used.

## Default nightly acceptance run on final source

- Run **passed**, acceptance eligible, 4 complete rounds, **33m43s** elapsed.
  Run ID: `run-2026-10-18T00-04-27.582Z-65849-981dbade`.
- Every round passed lexical-scale (5,340 and 25,000 records), 25,000-record
  transfer, Fast Gate, Functional Browser Gate, and ten-round Race Gate. The
  nightly report records exit code 0 for every child; no cases were skipped.
- Source fingerprint was stable across the run; all 855 source files matched.
  Source hash: `a1ebb10b58cb1178a7500e0e7389bc5d1eded0395e36e4694669151584531174`.
  The checked-in PDF fixture SHA-256 was unchanged at
  `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`. This
  covers only the test fixture, not a production Vault or user PDF.
- Platform: `darwin/arm64 Node DataAdapter and Chromium simulation`.
  `realDeviceAcceptance` is explicitly `not-tested-by-this-runner`; this is not
  Windows, macOS Obsidian, or iPadOS device acceptance.
- Full machine-readable report and per-case raw stdout/stderr:
  `tests/artifacts/vocabulary-stress/runs/run-2026-10-18T00-04-27.582Z-65849-981dbade/report.json`.

Each of the four rounds recorded 91 Fast, 22 Browser, and 60 Race assertions
passing (0 failed, 0 skipped), in addition to the benchmark and transfer tests.
The ten-round, two-process Race Gate ran four times.

The performance comparison is the synthetic legacy-reader harness at baseline
SHA `f877e16cf0d00ee9984dfa76d4f2ecfe086f8b09`, not a timing claim for an
installed Obsidian release. The table reports medians from four cycles; each
sample uses 6,000 page tokens and returns 5,989 matches:

| Vocabulary records | Sample | Legacy baseline | Candidate | Candidate index / normalize / match |
| ---: | --- | ---: | ---: | --- |
| 5,340 | cold total | 17.24 ms | 14.98 ms | 6.10 / 4.04 / 4.84 ms |
| 5,340 | warm total | 6.84 ms | 7.05 ms | 0 / 3.69 / 3.11 ms |
| 5,340 | re-enter / next page | 6.05 / 5.99 ms | 6.91 / 6.49 ms | match 2.81 / 2.73 ms |
| 25,000 | cold total | 39.09 ms | 35.21 ms | 28.82 / 3.69 / 3.17 ms |
| 25,000 | warm total | 6.33 ms | 6.23 ms | 0 / 3.61 / 2.76 ms |
| 25,000 | re-enter / next page | 7.76 / 5.90 ms | 6.63 / 6.98 ms | match 2.83 / 2.76 ms |

The harness reports zero vocabulary full scans and zero per-token vocabulary
normalizations in every sample. Candidate matching is bounded by observed trie
steps (6,000 here). Warm totals vary by a few tenths of a millisecond between
baseline and candidate, so this does not support a strong warm-path speedup
claim. The benchmark includes synthetic fixture construction and does not
predict rendering or device-specific latency. The 25,000-entry index build
dominates the cold candidate sample; warm match time is around 3 ms.

### Write amplification evidence

The final-source DataAdapter action-I/O experiment is:
`tests/artifacts/vocabulary-stress/runs/run-2026-10-18T00-04-27.582Z-65849-981dbade/action-io.json`.
It uses a synthetic in-memory adapter, not an actual Sync/Vault trace.

| Action | Read / written bytes | Files / directories touched | Writes |
| --- | ---: | ---: | --- |
| One Review rating | 5,072 / 1,144 | 3 / 9 | one append to local session journal; no canonical flush |
| Review finalize | 91,624 / 22,734 | 5 / 11 | seven writes/eight renames across review, history, and journal finalization |
| One Context save | 13,666 / 6,127 | 4 / 9 | transaction/context shard and manifest stages |
| History restore | 12,239 / 4,718 | 4 / 8 | main snapshot, restore history, and pending transaction |
| Bulk import of 100 entries | 472,401 / 235,194 | 2 / 8 | canonical snapshot and one history transaction |

The focused Review acknowledgement fixture also verifies one bounded append
and zero `en.vocab.json`, canonical Review, or History writes before session
finalize. The 25,000-record full transfer writes 57,530,525 bytes across the
complete import/history flow; that bulk cost is not representative of an
individual rating.

## Acceptance limits

- The earlier full candidate run passed Fast, Browser, Race, and Nightly as
  recorded above. The later priority-follow-up runs are separate and supersede
  that result for the current source; their exact gate outcomes are recorded
  below.
- The initial Phase E Browser run had one iPad pointer lifecycle failure that
  did not reproduce in the isolated scenario, the Phase D baseline, the clean
  Phase E rerun, or any of four nightly rounds. Its precise timing trigger is
  still unexplained; retain it as a known intermittent test/runtime risk rather
  than calling it fixed.
- No physical Windows, macOS Obsidian, or iPadOS device was tested. Real iPad
  verification remains outstanding.
- Vocabulary does not support automatic cross-device concurrent merge. Sync
  transport and per-device pending files do not create a distributed lock or
  conflict-free replicated data type.
- No real Vault, existing user vocabulary data, annotation WAL, or user PDF was
  modified by these tests. No cleanup or History GC was performed.
- A two-store transaction test injects a crash before and after all ten durable
  mutation points (20 interruption cases). It verifies recovery to the exact
  result when a local intent exists and preservation of the base when the
  pending write never became durable. A separate test covers a foreign pending
  file arriving after the local intent; the existing test covers it arriving
  before local recovery. Both preserve foreign files.
- Cleanup failure now leaves the verified local pending intent in place until
  stage/backup cleanup succeeds. Recovery retries cleanup without replaying the
  already verified canonical result.

## Priority follow-up — 2026-10-18

### P0: gesture-25 long tail

The 30-minute run `run-2026-10-18T02-44-01.025Z-25801-9f41536c` remains
incomplete: its second round stopped when the existing 80 ms event-arrival
assertion observed about 102 ms for gesture 25. The failure artifact records no
Long Task at that time. Its CDP touch-move dispatch acknowledgement was also
delayed by roughly 115 ms, which places the stall in browser/input scheduling or
the CDP delivery path rather than identifying a slow Reader callback; this is
evidence, not a proven root cause.

A same-machine comparison was collected with CPU sampling enabled:

| Source | Gesture-25 runs | Event-arrival max range | Over 80 ms | CPU profile |
| --- | ---: | ---: | ---: | --- |
| `39fb121b10140f265e3f006cee2b1a8cf6f891c3` | 11 | 72.7–75.6 ms | 0 | sampled Reader/main script median about 1.28 ms |
| `b6b178dc142b6900fa7b4bbdd7d23c5f4d0bc96c` | 19 | 71.9–76.3 ms | 0 | sampled Reader/main script median about 1.29 ms |

The profile-enabled current-source rerun for gesture 25 recorded 73.9 ms at
most; 125 of 132 CPU samples were idle, four were program time, and the only
named Reader frame (`runtimeLogRecord`) accounted for under 1 ms. Its Long Task
list was empty. A separate profiler run that stopped at gesture 24 did observe
a 58 ms Long Task near page startup, but it was not contemporaneous with that
late gesture. These runs do not reproduce or explain the 102 ms observation.
The 80 ms gate is unchanged and remains open; the earlier 30-minute result is
not accepted as a pass. The available evidence does not justify changing the
Reader gesture path. Per-run A/B timings, profile summaries, the original
102 ms capture, and the new profiled sample are consolidated at
`tests/artifacts/vocabulary-stress/priority-2026-10-18/gesture-ab.json`.

### P1: ECDICT cold IndexedDB build

The final-source full-resource run is
`tests/output/dictionary-0.11.8/browser-full-benchmark-batch-4000.json`. It
loaded 770,611 entries from a 16,734,703-byte compressed resource in 66.44 s.
The six measured stages were:

| Stage | Duration |
| --- | ---: |
| Manifest/cache probe | 48 ms |
| Vault binary read | 85 ms |
| SHA-256 verification | 12 ms |
| Gzip decode + JSONL validation | 874 ms |
| IndexedDB persistence | 63.55 s |
| Cache finalization | 1.80 s |

Within persistence, `entries.bulkPut` consumed 62.22 s of 63.55 s across 193
4,000-entry batches. Membership read/write consumed about 0.80 s combined;
entry preparation was 87 ms. A 100-query warm sample had 0.6 ms p95 lookup
latency. The measured bottleneck is IndexedDB population, not vocabulary lookup,
resource reading, integrity, decode, or membership-array rewriting. Batch-size
experiments did not show a stable improvement (8,000 varied between runs and
16,000 was slower), so the production batch size remains 4,000; no speculative
retuning was accepted. This is Chromium IndexedDB evidence, not an iPad
WKWebView cold-build measurement.

The profiling callback is opt-in and disabled by default. It records aggregate
stage timings rather than a per-entry clock or query, so regular dictionary
loads do not pay the diagnostic instrumentation cost.

### P2: compact bulk-import History

History schema v3 now encodes complete record-root lifecycle batches by grouping
shared store/path/kind metadata and storing each entity ID with its record
payload. Readers inflate this representation to the established reversible
batch API; mixed and field-level changes remain expanded. Crash-recovery
pending intents, staging, backups, and recovery ordering are unchanged.

The 25,000-record regression verifies compact creation and inverse deletion,
25,000-row preview, undo, and redo. In the in-memory DataAdapter measurement,
the create History batch was 5,851,151 bytes versus an 8,650,813-byte export
bundle; the full transfer wrote 38,980,847 bytes. These are local structural
measurements, not real Sync throughput or multi-device transaction guarantees.

### Release evidence boundary

Fast Gate passed 97/97 after the profiling-default fix. Race Gate passed 60/60
after that diagnostics-only fix. The Browser Gate run before the foreground
scroll follow-up finished with 25 passed, 1 failed, and 0 skipped; the failure
was a foreground scroll-write race, not gesture-25 latency or dictionary
profiling. In that run, gesture 25 arrived within 28.7 ms. Reports:

- Fast: `tests/artifacts/vocabulary-gates/runs/run-2026-10-18T05-58-54-063Z-65559-fbcfddb2/report.json`.
- Browser: `tests/artifacts/vocabulary-gates/runs/run-2026-10-18T06-00-00-563Z-66699-01c61170/report.json`.
- Race: `tests/artifacts/vocabulary-gates/runs/run-2026-10-18T06-06-03-083Z-69328-009a2a5a/report.json`.

Build and offline three-file smoke passed; the latter opened the fixture,
created five editor types, saved/reopened them, and verified bulk deletion did
not resurrect. The 30-minute Nightly remains incomplete, and the A/B evidence
does not explain the earlier 102 ms gesture-25 long tail. No physical
iPad/WKWebView test or real cross-device Sync test was performed; both remain
release acceptance items. Vocabulary still does not support automatic
cross-device concurrent merge.

### Follow-up: native scroll interruption ownership and LingQ check

The remaining Browser Gate failure after the foreground-scroll change exposed a
second input path: keyboard tool changes do not have a preceding pointer event.
The bridge now interrupts native iPad scrolling on a real non-Pencil contact
with the editor toolbar, before PDF.js changes tools. Keyboard tool changes
still call the input policy because they have no pointer-down preflight. A
replayed non-keyboard `annotationeditormodechanged` lifecycle event does not
interrupt scrolling. `IOSInputPolicy` and its existing Pencil behavior remain
unchanged.

The candidate passed the latest gates:

- Fast Gate: 97 passed, 0 failed, 0 skipped — `tests/artifacts/vocabulary-gates/runs/run-2026-10-18T07-57-58-663Z-89711-5f39f571/report.json`.
- Browser Gate: 26 passed, 0 failed, 0 skipped — `tests/artifacts/vocabulary-gates/runs/run-2026-10-18T07-59-07-424Z-90862-cd3c8728/report.json`.
- Targeted `native-finger-ownership` and `ipad-pointer-policy`: 2 passed, 0 failed, 0 skipped. The native pointer-policy evidence is `tests/artifacts/ipad-pointer-policy-1792310253044-89560.json`.
- Build and offline three-file smoke passed; `git diff --check` is clean.

LingQ browser coverage passed for dictionary cache, toolbar/mode interaction,
compact word-card layout, text-layer tap to vocabulary lookup, Workbench,
morphology, and the offline package smoke. This verifies the built candidate
in the browser harness. It does not verify the already-installed Obsidian
plugin, a real iPad/WKWebView, or cross-device Sync; no deployment or push was
performed. The 30-minute Nightly remains incomplete, and the earlier 102 ms
gesture-25 observation remains unexplained; its 80 ms threshold was not
changed.

The rebuilt candidate remains version 0.12.0. Current output hashes are:

| File | Size | SHA-256 |
| --- | ---: | --- |
| `dist/pdf-web-reader/main.js` | 8,866,116 bytes | `c308b91032d2151647577e376943cd679624343a66ddd7892c3101d7a231f471` |
| `dist/pdf-web-reader/manifest.json` | 261 bytes | `1487d5a6fd66223ba0575adddb8fd67281a9154e93c4dedf374b4c42469717ca` |
| `dist/pdf-web-reader/styles.css` | 8,058 bytes | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` |
