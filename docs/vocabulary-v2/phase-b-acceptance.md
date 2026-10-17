# Phase B — storage contracts acceptance

Phase B starts from local integration `f877e16cf0d00ee9984dfa76d4f2ecfe086f8b09` (Phase A accepted against upstream `c27fcdc38f96df59b9bf61e88863cda0abc7e1e8`, 0.11.6). The original dirty workspace and its independent WIP snapshots remain preserved; no main merge, push, real-Vault deployment or user-data cleanup is part of this phase.

## Implemented contracts

- Explicit v1 → v2 migration, strict schema handling, versioned persistent family identity, shared family status and bounded invalidation. The actual legacy reader fixture refuses to write v2.
- Adaptive hash-prefix Context/Review shards; exact identity/reference validation; absent-manifest/orphan-shard fail-closed handling. Context source verification uses already verified Reader evidence, without opening or scanning PDFs.
- Device-scoped transactions, sorted local locks, verified base/result identities and scoped recovery. Foreign pending is not replayed or deleted.
- Exact Leitner rules, Known queue suspension, stable action IDs, verified append JSONL where available and bounded fallback segments, 20-action/5-second/session-close flush policy, one final history batch per session.
- Field-level reversible History, new revisions and inverse batches, cross-store reference preconditions, real two-runtime interleaving coverage.
- Lazy runtime composition and persistent local device identity. Production Workbench/Context/Review UI wiring is intentionally left to subsequent phases; page matching continues through the existing personal vocabulary service.

Detailed contracts and focused evidence: [family/migration](phase-b-family.md), [Context/Review](phase-b-context-review.md), [transactions/History](phase-b-transactions-history.md).

## Verification

Full gate completed with raw exit 0: Fast 86/86, Functional Browser 21/21 (20 test files plus offline three-file smoke), Race 50/50 (five scenarios in ten rounds, bounded concurrency two). Total 157/157, zero failures, skips or retries. `acceptanceEligible=true`.

Report and all raw child stdout/stderr/exits: `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T20-38-20-127Z-92842-9bff07c7/report.json`. Parent log: `/private/tmp/vocabulary-v2-phase-b-all-gates.log`. Source fingerprint stayed `c1e26ad84b4b52c7e58a216be7e499ef2b82d6bed08527bf1456aaf97ca20d5f` over 844 files; no files changed during the run. Build log: `/private/tmp/vocabulary-v2-phase-b-build-final.log`. Build succeeded with 406 embedded runtime assets, including 402 frozen vendor files. The SHA-256 boundary test covers all 441 frozen storage/input/vendor/PDF files.

Performance comparison is restricted to core import and lexical matching using DataAdapter fixtures; it does not measure PDF opening, rendering, zoom geometry or actual iPad behavior. Low-frequency migration/import now performs additional schema/family validation; this must not be presented as a hot-path speedup.

## Limits carried forward

当前不支持跨设备并发自动合并 Vocabulary。DataAdapter has no distributed CAS or multi-file atomic commit. Present partial references fail closed, while files which have not arrived at all cannot be detected as a globally complete sync snapshot. Real iPad/WKWebView acceptance remains pending. Context History domain restoration and UI workflows are later-phase work, not claimed here.

## Core performance samples

Report: `/private/tmp/vocabulary-v2-phase-b-final-benchmark.json`, same source before/after. These are single-run Node samples, affected by JIT/order; they are evidence of counters and scope, not fixed platform latency promises. All ordinary matches had zero full vocabulary scans, zero per-token vocabulary normalization, and zero DataAdapter IO.

| Records | Baseline cold/warm ms | Candidate cold/warm ms | Baseline/candidate import ms |
| --- | --- | --- | --- |
| 5340 | 206.87 / 14.78 | 15.68 / 8.75 | 82.06 / 113.77 |
| 25000 | 50.29 / 7.77 | 47.92 / 8.36 | 48.47 / 419.78 |
