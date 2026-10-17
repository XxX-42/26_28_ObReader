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
[phase-e-review.md](phase-e-review.md). Phase E remains unaccepted until the
full Browser Gate's frozen iPad pointer lifecycle failure is characterized;
that unchanged boundary is outside the Review change set.

## Phase F — hardening and candidate delivery

- [ ] Crash every transaction boundary; repeat migration/recovery/finalize;
  foreign pending permutations; external canonical replacement and restore
  conflicts; missing/corrupt dictionary shards; family and Known transitions.
- [ ] Three-feature interoperability and same inputs across DataAdapter
  platform simulations; desktop/mobile simulation is separate from real iPad.
- [ ] Run the complete Fast, Functional, Race and offline three-file gates.
- [ ] Run the default 30-minute stress matrix at 5,340 and 25,000 records,
  6,000 page tokens, 12-token phrases and the specified fault/lifecycle cases.
- [ ] Record files/directories/read and write bytes per action, structural
  memory metrics and baseline-to-candidate timings. No MB-scale main snapshot
  rewrite per rating; no permanent one-file-per-click history/context design.
- [ ] Runtime/static evidence: normal page matching has zero vocabulary full
  scans and per-token vocabulary normalizations; zoom has zero vocabulary
  queries, lexical matches, dictionary lookups and backlink rebuilds. PDF page
  matching never accesses Review/Context/History; dictionary never runs in page
  or zoom paths.
- [ ] Source PDF SHA-256 identical and frozen annotation storage/vendor/input
  regression suites pass; no real user data has been changed by validation.
- [ ] Deliver phase commit list, complete raw-linked test/performance report,
  migration and Context/Review/History protocol docs, known limitations and
  candidate three-file package. Explicitly state that cross-device concurrent
  automatic Vocabulary merge is not implemented.

Real Windows/macOS/iPadOS device acceptance requires device evidence. Missing
device evidence remains pending and is never substituted by Chromium tests.
