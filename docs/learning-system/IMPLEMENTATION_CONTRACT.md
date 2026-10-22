# 0.13.0 candidate implementation contract

## Frozen baseline

- Repository: `XxX-42/26_28_ObReader`.
- Integration branch: `feature/reading-learning-loop-20261022`.
- Source baseline: `9c361330388cbc929ef76bcc53b83f49a7360c04`.
- A/B comparison: `origin/main@b6b178dc142b6900fa7b4bbdd7d23c5f4d0bc96c` versus the source baseline. Neither is assumed to be a stable input-performance oracle.
- Preserve PDF.js vendor, InputRouter architecture, immutable PDF source, annotation WAL/schema, deletion guards, Vocabulary identity/schema and generic transaction/History formats.
- All Native writes and deployment are restricted to the independent test Vault. No production Vault deployment or user-data migration.

## Stage gates

1. Freeze complete baseline; diagnose page-badge failure and 80 ms input tail; collect attributed Windows Native evidence.
2. Integrate semantic adapters, read-only Sidebar filtering and exact bidirectional source navigation.
3. Integrate explicit learning drafts, learning items, review aggregation, source return and independent export.
4. Measure resource-v2 dictionary and 25k import; integrate only measured, correctness-tested improvements.
5. Build, Fast, Browser, Race, Offline, final Native, feature push and safe test-Vault deployment.

A real product P0 blocks subsequent product integration. Missing physical device access blocks platform claims, not a clearly labelled Windows candidate. Historical failing receipts remain intact.

## Ownership

- A: baseline receipts and independent integration audit.
- B: input diagnostic harness and Native attribution; no unproven InputRouter modifications.
- C: pure semantic adapter modules, Sidebar search/filter and page-local display recovery.
- D: existing backlink index/controller/anchor encoding and regression tests; no second index.
- E: independent learning-domain modules using existing sharded store/coordinator/History; no Vocabulary canonical changes.
- F: isolated resource-v2 / import benchmark harness and measured optimization review.
- Root: shared `plugin/main.js`, workbench and build wiring, semantic integration, stage tests, push and test deployment.

Agents use isolated worktrees. Browser-heavy acceptance and performance measurement have an exclusive lease to avoid contaminating the measurements. Test thresholds, timeouts and assertions are not relaxed.

## Domain boundaries

`SemanticAnchor` is a pure adapter/view model over authoritative Annotation, Reader Anchor, Context and Backlink rows. It is not a new database. Geometry recovered target text is display evidence, never target rebinding evidence.

Learning items use a separate logical store under `00_Archive/21_VocabularyData/learning/items`. The existing generic coordinator and History remain authoritative for durability. References are soft provenance snapshots; a deleted source never deletes a learning item or silently rebinds it.

An explicit draft confirmation creates a stable item/external ID. Prompt and answer must be nonempty. Duplicate confirmations reuse the same action ID. Every rating writes state and a `lastReviewEvent` in the same existing transaction. Undo restores the event head; original immutable History is retained.

Default scheduling remains compatible UTC Leitner `1/3/7/14/30`. FSRS 5.4.2 is a development-only replay/migration experiment; missing historic vocabulary ratings are not reconstructed. AI outputs remain drafts.

Review aggregation uses one bounded page per provider and session cursors, not an authoritative second index. Reader operations never build review queues. Exports are independent of the existing Vocabulary bundle and contain stable IDs and source evidence.

## Evidence rules

Native receipts include Git SHA, runtime version, installed bundle hash and fixture hash. Physical iPad, macOS and real Sync are reported separately from Chromium/CDP simulations. Ordinary saves must leave PDF SHA-256 and XXH64 unchanged, with zero source write attempts and zero ordinary `saveDocument()` calls.

Resource-v2 experiments use the fixed 770,611-entry resource with SHA-256 `b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126`, copied into an isolated benchmark environment. Five predeclared cold runs per variant; no unmeasured default changes. The full-build-before-first-query limitation remains explicit.
