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

- Full Fast, Browser, Race, and nightly gates passed on the simulation above.
  Source/fixture immutability and architecture boundary tests passed in the
  same run.
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

The candidate three-file package and SHA-256 values are:

| File | Size | SHA-256 |
| --- | ---: | --- |
| `dist/pdf-web-reader/main.js` | 8,230,966 bytes | `45e5c5dffe8d1bd1fc9f71acaf5c06485ba9d17d62d3029780409f92054fcc14` |
| `dist/pdf-web-reader/manifest.json` | 261 bytes | `5adbd6ef42830f2fb624a6145d8c7645c1e854ed3cf146c305311a01de07294f` |
| `dist/pdf-web-reader/styles.css` | 8,058 bytes | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` |
