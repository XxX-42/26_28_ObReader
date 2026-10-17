# Phase C — shared vocabulary workbench

Phase C starts from local integration `455537350c83c937039ab4b6b5239b3ae6e9ec7a`. Phase B commits are `c88bb0d` (storage contracts) and `90e6b1c` (bounded viewer invalidation); their frozen gate passed 157/157.

## Product and host boundaries

The existing vocabulary command and Settings entry open the same responsive Obsidian Modal on desktop and mobile. The workbench receives a narrow host facade; it does not receive the PDF application, annotation stores, Vault paths, or bridge credentials. Tabs expose personal vocabulary, family Context, Today Review, and History. This phase enables personal search, status/type filters, cursor pages of at most 100 families, per-record definition/note/phonetic editing, and bounded review enrollment. Context capture/navigation and Review ratings are subsequent phases.

Personal lists never query ECDICT. Only explicitly opening a family detail permits one dictionary request; missing dictionary data does not prevent personal editing. PDF matching uses the existing VocabularyService directly and never constructs the workspace runtime. Review/Context/History changes do not subscribe to page lexical invalidation.

User writes construct one lazy, per-plugin runtime with a locally persistent device identity. LingQ status/selection writes now retain normal personal-vocabulary History, while keeping their authenticated renderer/document/request guards and source-PDF protections. The old host assertion permitting only en.vocab.json is mapped to the new requirement: canonical vocabulary plus verified History paths are allowed, every path must remain under VocabularyData, and PDF/annotation WAL changes are still prohibited and asserted separately.

A new deterministic crash regression exposed a cold-start ordering defect: startup had already loaded the core base snapshot, then recovery installed its result before coordinator attachment. The original failure (`vocabulary-external-change`) is preserved in `/private/tmp/vocabulary-v2-phase-c-recovery-before.log`. Runtime now recovers, reloads verified personal state, migrates when necessary, and only then attaches. The after-fix 84-test host/runtime run is `/private/tmp/vocabulary-v2-phase-c-recovery-after.log`; no timeout, skip or business assertion was relaxed.

## Transfer contract

JSON uses the closed, integrity-verified `pdf-reader-vocabulary-bundle`, schemaVersion 1. It aggregates schema-v2 personal records plus logical Context and canonical Review records. It does **not** include History or transient/foreign-device pending logs. The host handles acknowledged local journals and flushes the current session before export; a direct unflushed export is rejected. Two complete reads validate core, manifest and shard identities before a complete bundle is returned. This is a local consistency check, not a distributed snapshot across live Sync.

Import validates all schemas, family/source identities and references before one multi-store transaction. Existing data and Known status are preserved by default; explicit overwrite options are bounded, unknown broad policies fail before writes. Context Anchor identity is preserved verbatim, never guessed by coordinates. An active Review session is finalized before import so its cached state cannot overwrite imported canonical state. Repeated/no-op import writes no extra batch. A changed bundle import creates one History batch. Core record creation uses one complete-record lifecycle change in History schema 2; ordinary updates stay field-level, and Context/Review keep their existing field-level lifecycle groups. The reader dual-reads schema 1 field-granular History. Context domain restore is completed in Phase D.

CSV keeps term/type/status/translation/note/phonetic compatibility and explicitly omits Context, Review and History. Versioned JSON snapshots are fully validated before the legacy row importer; newer schemas cannot be flattened into a permissive records array. Input beyond the public size/count bounds is rejected, never truncated.

## Visual and functional evidence

The versioned Browser test recreates the shared factory in a browser with theme variables and Obsidian DOM helpers. Its six desktop1280/iPad768/compact390 × light/dark screenshots assert exactly 100 rows, modal viewport containment and button height at least 44 CSS px. It also switches tabs and retains browser ownership/cleanup diagnostics. The root visually inspected iPad light and compact dark screenshots. These are Chromium viewport simulations, not physical iPad/WKWebView evidence.

Independent early visual evidence is retained at `/private/tmp/vocabulary-workbench-visual-matrix/`; the reproducible Browser test writes per-run screenshots and cleanup logs under `tests/artifacts/vocabulary-workbench/`. Complete frozen phase gate evidence is appended after the final source freeze.

## Final Phase C gate and scale measurement

The initial complete source-frozen gate passed on `2026-10-17` before a later resource audit found the per-field lifecycle History amplification:

```text
run: run-2026-10-17T21-34-20-082Z-4378-fefb911b
Fast: 89/89
Functional Browser: 22/22
Race: 50/50 (10 rounds)
Total: 161/161; 0 failed; 0 skipped
acceptanceEligible: true
source fingerprint: ad4ac2321e716c0ed6f198e60837df7813d3bcc73a31ddb51a3fec9f41b0d432 (852 files; unchanged)
```

The first 25,000-record run preserved all rows and committed atomically, but it wrote a 76,425,999-byte field-granular History batch and accumulated 234,705,525 written bytes. A resource audit traced the duplication to repeating field envelopes for new records and embedding the History summary inside the transaction intent. The history refinement described above reduces that footprint while preserving complete undo/redo.

The post-refinement Node 26 in-memory DataAdapter scenario covers bundle export, read-only preview, atomic 25,000-record import, full read-back, and a 25,000-item History restore preview:

```text
input bundle: 8,650,813 B
import stage: 5,099 ms
History file: 14,600,999 B (25,000 lifecycle changes)
all History items resolve cleanly: 2,433 ms
paths touched: 9
total read: 123,334,735 B
total written: 57,530,525 B
whole test: 12,200 ms
```

These are harness measurements, not a prediction of iPad or Obsidian Sync wall-clock time. They do not make 25k import lightweight and are not representative of a single Review rating, Context save, or page/zoom operation.

The post-refinement full Phase C gate passed:

```text
run: run-2026-10-17T21-53-32-054Z-11247-6ca2565c
Fast: 89/89
Functional Browser: 22/22
Race: 50/50 (10 rounds)
Total: 161/161; 0 failed; 0 skipped
acceptanceEligible: true
source fingerprint: 73ea75c6aba5a9a9bdc77c6aff60cb715309dead24b2ec92965c224d7d42aa3e (852 files; unchanged)
```

The frozen-subsystem boundary test passed: all 441 PDF storage, input lifecycle, vendor, and fixture files retain the Phase 0 bytes. Browser evidence consists of desktop/iPad-width/compact viewport simulations in light and dark themes; no physical iPad result is claimed.

当前不支持跨设备并发自动合并 Vocabulary。No main merge, push, release, production Vault deployment, old-data cleanup or History GC is part of this phase.
