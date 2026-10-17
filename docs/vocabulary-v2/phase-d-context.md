# Phase D — Context Notebook

Phase D adds the vocabulary Context capture, preview, persistence, and source-navigation path on the local `integration/vocabulary-workbench-v2` line. It starts from the Phase C integration commit `5f8fa3a400f57380cb77c2f717d0ed8b0ba075e7`. Context records remain under `00_Archive/21_VocabularyData/contexts/`; the existing generic Reader Anchor store remains in its established location and is not migrated.

## Capture and identity

The LingQ pill sends an authenticated request using the current `channel`, `token`, `rendererGeneration`, `documentId`, and `openRequest`. The Host asks the existing PDF.js selection-capture path for a sentence on the expected page. The Host previews the captured text and retains the opaque capture ID with the exact document, source hash, page identity, page count, family, and selection. The user must explicitly confirm before the Host creates/reuses the deterministic Anchor and writes Context.

Before persistence, the service confirms that the selected surface belongs to the requested family and occurs as a whole token in the captured sentence. Saved family surfaces are accepted; arbitrary substrings are rejected. A line-end hyphen followed by a line break is joined for validation (`compa-\nrable` → `comparable`); ordinary compound hyphens are not stripped. The saved sentence is the Host-captured selection, not a mutable renderer-supplied replacement.

`contextId` remains derived from the full stable tuple `[familyKey, documentId, anchorId]`. The stored identity also validates the source fingerprint and complete Anchor tuple, so reuse of a short ID by a different source fails closed. Context shard/manifest writes use the existing transaction coordinator and precondition the personal-vocabulary snapshot. Context lookup and source verification do not scan PDF text or infer a target from coordinates.

## Retry and lifecycle behavior

Preview captures expire after two minutes while idle. Starting a confirmed save cancels that timer; a failed save re-arms it. Simultaneous requests for the same capture share one in-flight save promise. A deterministic Anchor ID lets a user retry after a Context write failure without generating a new Anchor ID; immutable Anchors cannot be deleted, so an interrupted failed Context commit may leave an inert verified Anchor that a retry reuses. Closed or replaced Reader sessions cannot receive a stale confirmation.

Context navigation resolves the current PDF route by stable document identity, verifies the source hash and page identities through the existing source-verification path, and opens the verified Anchor. A missing, moved-to-an-unregistered-route, or changed source is reported; navigation never falls back to a stale path or guessed geometry. The source PDF remains byte-for-byte unchanged.

## Validation

The phase adds service tests for sentence/family validation, explicit PDF line-end hyphen handling, size rejection before writes, stable IDs, deduplication, shard insertion-order determinism, stale source and page rejection, and rename verification. Controller tests cover stale preview/result identity, explicit confirmation, retry, and dismissal. Host tests exercise authenticated selection capture through preview and confirmed save, same-device duplicate-save coalescing, timeout cancellation, and source PDF byte equality.

The full Phase D acceptance results are:

- Fast Gate: 90 passed, 0 failed, 0 skipped; report `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T22-31-16-617Z-20824-b9246ed4/report.json`.
- Browser Functional Gate: 22 passed, 0 failed, 0 skipped; report `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T22-31-54-051Z-21856-ca67f110/report.json`.
- Race Gate: 60 passed across 10 isolated rounds, 0 failed, 0 skipped; report `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T22-36-04-096Z-23917-7cd41c4f/report.json`.
- `npm run build`: passed; 3 release files, 406 embedded runtime assets, and 402 frozen vendor files verified; bundle payload 6,701,791 bytes before release transport compression.
- `git diff --check`: passed. The frozen PDF/storage/input/vendor boundary was included in the Fast Gate and remained unchanged.

Browser tests are desktop/mobile viewport simulations only; they do not claim physical iPad/WKWebView acceptance. The 441-file frozen PDF/storage/input/vendor boundary must remain byte-identical.

Known limitation: if an Anchor is durably created but the subsequent Context transaction fails, the immutable Anchor can remain unreferenced until the same selection is retried; Phase D does not add Anchor deletion or garbage collection.
