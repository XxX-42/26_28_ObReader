# Bulk Import / History experiment: EXPERIMENT_REJECTED

Independent audit on 2026-10-24 of base `65de915b306954a160ed99002f33ada639cebd4e`, branch `codex/014-bulk-history-experiment`. No production implementation is proposed.

The base already contained a completed, rotating-order, five-round 25,000-record real-filesystem comparison. This audit preserves its full raw receipt in Git as `25k-node-filesystem-inherited.json`, independently verifies the recorded SHA-256 `a52b7c5c2c63ab0cff2ccf09c77c4c0d05a7bb24943409056c29734f3c7e8282`, and reruns the bounded correctness suite. These are inherited performance measurements from 2026-10-23, not newly measured timings. No additional heavy matrix was run.

| Measurement | Baseline | Canonical History gzip | Shared lifecycle prototype |
|---|---:|---:|---:|
| Mean total adapter bytes written | 57,530,614 | 44,432,767.4 | 49,731,135 |
| Total write reduction | — | 22.7667% | 13.5571% |
| Mean import CPU ms | 6,602.713 | 6,816.095 | 9,618.525 |
| Worst paired CPU increase | — | 8.4606% | 54.4740% |
| Mean undo + redo ms | 32,829.421 | 32,684.993 | 39,086.349 |
| Worst paired restore increase | — | 5.3408% | 26.6522% |
| Crash recovery correctness | PASS | PASS | PASS |
| Semantic History equivalence | PASS | PASS | PASS |

Both candidates fail the required >=40% total-write reduction. Shared lifecycle also fails <=20% CPU and restore regression limits. Baseline History writes account for only 14,601,020 / 57,530,614 = 25.3796% of total bytes: even eliminating those History writes completely cannot meet the total-write gate while leaving pending intents and other writes unchanged. Pending intents alone write 37,429,222 bytes (65.0597% of baseline). Gzip reduces History bytes by 89.7050% but does not encode the History text embedded in pending intents.

Recovery **latency was not measured** in the inherited receipt; its crash test checks successful restart recovery after staged import and restore failures at four records. It is not evidence of 25k crash recovery latency or power-loss durability. Consequently neither candidate could be promoted even if the write gate had passed. The early rejection on already-failed required gates does not require another 15-run matrix, and no unmeasured recovery threshold is claimed as passed.

Fresh validation at this base: `node --test tests/vocabulary-bulk-node-adapter.test.mjs tests/vocabulary-history.test.mjs` passed 11/11 (0 failed, 0 skipped). Tests cover canonical expanded History, all three encodings, clean-only undo/redo with byte-preserved conflict payload, import/restore staged-write restart recovery, planner preconditions, lifecycle identity, and absent-versus-revision-zero semantics. These bounded tests are correctness evidence, not new 25k performance evidence.

Raw receipt bytes describe Node DataAdapter write/append calls into isolated OS temporary files. They do not measure APFS sectors, sync traffic, or an actual Obsidian Vault. All encoding remains in the existing test adapter; the coordinator, canonical production History, deployed Vault, annotation/WAL code, integration branch and main are untouched. No candidate is authorized for integration by this report.
