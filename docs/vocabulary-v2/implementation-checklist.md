# Vocabulary v2 delivery gates

This is an implementation ledger, not by itself a claim of acceptance. Checked
implementation and evidence items link to retained source/test artifacts;
Phase A acceptance can be complete while its separate commit/integration item
remains pending. Phase A must pass before schema v2 implementation begins. No
main merge, push, release, real-Vault deployment, user-data deletion, or History
GC is authorized by this task.

## Phase A — reproducible baseline and regression repair

- [x] Preserve the original tracked binary diff and untracked files outside the
  repository, with a SHA-256 manifest; create an independent WIP commit.
- [x] Preserve the original workspace and use the isolated phase branch
  `codex/vocabulary-v2-phase-a`; record the preserved pre-upstream WIP and
  current merge target in [phase-a-upstream-reconciliation.md](phase-a-upstream-reconciliation.md).
- [x] Reconcile remote changes observed after the initial snapshot; record both
  the initial baseline and the newly integrated upstream SHA in
  [phase-a-upstream-reconciliation.md](phase-a-upstream-reconciliation.md).
- [x] Explain all eight historical failures and map every retired test protocol
  to assertions of the same business guarantees in
  [phase-a-baseline.md](phase-a-baseline.md).
- [x] Verify the physical/logical wrapped-word pipeline end to end, retaining
  authenticated message, identity, surface and size validation; 120 focused
  tests pass through scanner, controller, host and pill.
- [x] Pass Fast (at most four processes), Functional Browser (one browser), and
  Race (ten rounds with two concurrent children) on one frozen source state;
  final report: `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T19-45-34-763Z-71721-215a3415/report.json`.
- [x] Preserve raw child exits, logs, cleanup failures and skipped assertion
  counts; no skip or timeout relaxation closes a failure. Historical exits and
  current passing evidence are retained in the reports linked above.
- [x] Commit Phase A (`319912931b2c5bd6a9da924f8b65619c460b1498`) and merge it into the local integration branch (`f877e16cf0d00ee9984dfa76d4f2ecfe086f8b09`).

## Phase B — storage contracts, before UI

- [x] Personal vocabulary v2: explicit atomic/idempotent v1 migration, no empty
  snapshot on startup, unknown/newer schema fail closed, original metadata kept.
- [x] Versioned deterministic persisted family identity reuses the existing
  matcher and ambiguity rules, independent of mutable surface/storageKey.
- [x] Family status reads/writes share one resolution; migration preserves the
  highest effective status and Known protection without merging personal text.
- [x] Context contract and adaptive deterministic hash-prefix shards (512
  records / 256 KiB), full identity tuple validation, oversize rejection.
- [x] Review contract and independent canonical shards keyed by family; exact
  Leitner transitions, UTC instants, Known suspension without state deletion.
- [x] Local-device transaction coordinator, sorted affected-file queues,
  base/result revision and hash checks, verified pending intent and scoped
  conflicts; foreign pending remains untouched and cannot block local work.
- [x] Interrupted multi-store commits recover per store; ACK only after all
  results are verified; partial remote references cannot become empty state.
- [x] Bounded durable review journal, stable action IDs, idempotent replay;
  20 actions / 5-second idle / session close / controlled close flush policy.
- [x] One final history batch per review session/bulk edit/restore, including
  across flush/recovery; no-op writes none; cleanup only after verified finalize.
- [x] Restore preview classifies each field clean/already-restored/conflict;
  restore is a new increasing-revision transaction with its own inverse diff.
- [x] Two-level vocabulary invalidation: at most 64 keys or invalidateAll;
  family surfaces included; Context/Review/History never invalidate PDF lexing.
- [x] Old v1 reader demonstrably refuses to overwrite a v2 snapshot.
- [x] Contract tests pass before Phase B commit and local integration merge.

## Phase C — Workbench

- [x] Shared desktop/mobile view: personal search, status/type filters, 100-row
  pages, edit translation/note, enroll/unenroll, bulk review, Context/History.
- [x] List never queries ECDICT or renders all 25,000 rows; dictionary access is
  restricted to explicit entry details.
- [x] Explicit JSON import validates known snapshot/bundle schemas before applying records; a newer vocabulary envelope is rejected rather than flattened into a legacy records array. Preserve raw-array legacy import compatibility.
- [x] JSON is a consistent logical vocabulary/review/context backup behind a
  read barrier including acknowledged journals; failed export cannot claim full
  backup. CSV retains legacy fields and explains its omissions.
- [x] Functional/UI tests pass, with a separate commit and integration merge
  (`85a02e2` / `5f8fa3a`).

## Phase D — Context Notebook

- [x] Word card captures only existing current-page text/selection, previews a
  sentence, then saves a verified existing Anchor and vocabulary Context.
- [x] Stable tuple dedupe, multiple sources, document rename/move navigation;
  invalid source/Anchor identity is explicit and never guesses coordinates or
  scans the entire PDF.
- [x] Tests pass, with a separate commit and integration merge (`f5a258b` /
  `35a8f91`).

## Phase E — Today Review

- [x] Opt-in queue excludes Known by default; remember/forget follow the exact
  box intervals; skip writes nothing; time zones affect display only.
- [x] A rating waits only for its small verified durable journal; it does not
  rewrite `en.vocab.json`, query the dictionary, scan PDF, or rebuild the Trie.
- [x] Session resume, batch flush and Known demotion restore the preserved due
  state. Review never changes LingQ status.
- [x] Review behavior tests, Fast Gate, ten-round Race Gate, and final
  Functional Browser Gate pass; phase report and evidence are in
  [phase-e-review.md](phase-e-review.md). The first Browser run's one
  non-reproducible frozen iPad lifecycle failure remains recorded.

Implementation and the targeted Review/UI tests are recorded in
[phase-e-review.md](phase-e-review.md). The first full Browser run had one
non-reproducible frozen iPad pointer lifecycle failure; the Phase D baseline
and a clean Phase E rerun both passed 22/22. The original failure report is
retained and its exact timing trigger remains unknown.

## Phase F — hardening and candidate delivery

- [x] Crash injection before/after all ten durable mutation points in a
  two-store transaction; repeat migration/recovery/finalize across stress
  rounds; test foreign pending arrival before and after local pending; retain
  external canonical replacement, restore conflict, missing/corrupt dictionary
  shard, family, and Known transition coverage. Evidence is in the final Fast
  Gate report and [Phase F report](phase-f-hardening.md).
- [x] Three-feature interoperability and shared DataAdapter/Chromium desktop
  and mobile simulations. Native Windows/macOS/iPadOS device acceptance remains
  separate and pending.
- [x] Complete Fast, Functional Browser, Race and offline three-file gates.
- [x] An earlier `npm run test:vocabulary-nightly` run passed its default
  duration: four complete rounds of the 5,340/25,000 lexical benchmark,
  25,000-record transfer, Fast, Browser and ten-round Race gates.
- [ ] The newer run `run-2026-10-18T02-44-01.025Z-25801-9f41536c` did not
  complete: it stopped at 15m26s on iPad-simulated gesture 25 exceeding the
  existing 80ms event-arrival gate. The gate is still open; see the priority
  follow-up in [phase-f-hardening.md](phase-f-hardening.md).
- [x] Record per-action files/directories/read/write bytes, persisted snapshot
  and bundle bytes, structural record/token/trie-step counters and
  baseline-to-candidate timings. A rating appends about 1.1 KB locally and does
  not rewrite the main snapshot; Context and History use batched records rather
  than one permanent file per click. These are DataAdapter simulations, not
  cross-platform heap measurements.
- [x] Runtime/static evidence: normal page matching has zero vocabulary full
  scans and per-token vocabulary normalizations; 100%→125%→200% zoom reuses
  lexical results with no additional host page query. Static boundaries keep
  page matching out of Review/Context/History and dictionary shards.
- [x] Checked-in PDF fixture SHA-256 remained identical; frozen annotation
  storage/vendor/input regression suites pass. No real user data changed.
- [x] Deliver phase commit list, raw-linked test/performance report, migration
  and Context/Review/History protocol docs, known limitations, and candidate
  three-file package. Cross-device concurrent automatic Vocabulary merge is
  not implemented.

Real Windows/macOS/iPadOS device acceptance requires device evidence. Missing
device evidence remains pending and is never substituted by Chromium tests.

The Phase F runner and final evidence are documented in
[phase-f-hardening.md](phase-f-hardening.md). Real-device acceptance remains
pending; simulation results do not substitute for iPad, Windows, or macOS
Obsidian validation.
