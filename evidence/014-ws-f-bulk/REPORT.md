# Workstream F — bulk import and History experiment audit

## Decision

**Reject both candidates; keep production behavior unchanged.** Neither candidate meets the required 40% reduction in total DataAdapter write bytes. The shared lifecycle candidate also exceeds the CPU and worst-case restore limits. All 25k-run History semantics and crash-recovery checks pass, but they do not offset the failed performance gates.

## Existing 25,000-record matrix

The preserved matrix ran five paired rounds per mode (15 successful runs) on macOS/arm64 with Node v26.3.1 and isolated temporary filesystem adapters. The raw report is [25k-node-filesystem-20261023.json](25k-node-filesystem-20261023.json), SHA-256 `a52b7c5c2c63ab0cff2ccf09c77c4c0d05a7bb24943409056c29734f3c7e8282`. Means are paired by round; CPU and restore gates use the worst observed increase.

| Mode | Mean total write bytes | Total reduction | History reduction | CPU increase (mean / worst) | Undo + redo increase (mean / worst) | Gate |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Plain baseline | 57,530,614 | — | — | — | — | Reference |
| A — gzip History | 44,432,767 | 22.77% | 89.71% | 3.47% / 8.46% | -0.19% / 5.34% | **Reject:** total reduction <40% |
| B — shared lifecycle envelope | 49,731,135 | 13.56% | 20.03% | 46.04% / 54.47% | 19.33% / 26.65% | **Reject:** bytes, CPU and worst restore fail |

The total includes pending intents and other DataAdapter writes. In A, pending intents alone account for 37,429,222 B and are unaffected by History compression. In B, the test-only shared template encodes repeated lifecycle fields in History and the History mutation nested in pending intents; reads reconstruct the canonical History and pending text. This reduces bytes less than required and adds substantial encode/decode CPU.

All 15 rows report success and 25,000 lifecycle changes. Restore checks verify one conflict and 24,999 clean items, clean-only default undo, redo, canonical History semantics, and preservation of the full conflict payload. The benchmark's crash suite passed 4/4, injecting failures after staged History writes during import and restore and verifying recovery in all three adapter modes.

## Current-source verification

On base `197cd7d653967eb0a2d04af3c91470163949e680`, reran the safe adapter, History and transfer checks:

```text
node --test tests/vocabulary-bulk-node-adapter.test.mjs tests/vocabulary-history.test.mjs tests/vocabulary-transfer-v2.test.mjs
21 passed, 0 failed, 0 skipped
```

The raw output is [current-adapter-tests-20261025.log](current-adapter-tests-20261025.log). It includes temporary-root confinement, exact logical History expansion for gzip/shared encodings, undo/redo, conflict payload preservation, and injected import/restore crash recovery. Comparison of the benchmark source commit `634f94c4759db4a562ba4f24389b14e4733304e1` to this base shows no changes in transaction, History, transfer, or the experiment harness; intervening production changes are limited to vocabulary dictionary/resource code.

The earlier incomplete run remains recorded in [25K-ATTEMPT-20261023.md](../vocabulary-bulk-disk/25K-ATTEMPT-20261023.md); it is not counted as a sample. The full completed results and no-discarded-samples statement are in [25K-COMPLETED-20261023.md](../vocabulary-bulk-disk/25K-COMPLETED-20261023.md).

These are bytes submitted by Node to isolated filesystem writes, not APFS physical sectors or Obsidian Sync traffic. All transforms are confined to the benchmark adapter. No production transaction/WAL/canonical format or Vault was changed.
