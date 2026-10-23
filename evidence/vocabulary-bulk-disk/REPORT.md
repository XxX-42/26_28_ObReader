# F: isolated bulk import and History disk experiments

## Status

2026-10-23 update: the exact 25k command was actually executed on a real Node filesystem adapter and failed in the first baseline restore assertion. See [the preserved attempt](25K-ATTEMPT-20261023.md). Result: **EXPERIMENT_REJECTED; D unchanged**. The implementation-stage account below predates that attempt.

The real-disk adapter, three encoding modes, 25,000-record benchmark harness, and focused correctness tests are implemented on `codex/014-f-bulk`, based on `cd6e157`. The five-round 25k run is **NOT RUN**: the native benchmark lease is still occupied. No performance claim is made from the bounded tests, and no production optimization is selected. Decision D remains the default until every hard gate passes.

## Scope and frozen production contracts

The work is confined to test and benchmark files. It does not change the production transaction coordinator, History schema, Review History schema, transfer logic, canonical vocabulary, main/gate script, bridge, or Vault write path. All experiment files are stored in a fresh OS temporary directory; the adapter rejects absolute paths and traversal segments and only removes the temporary directory it created.

## Existing baseline facts

The supplied 25k in-memory DataAdapter baseline is 57,530,525 B total, including 14,600,999 B History and 37,429,154 B pending intents. The remaining 5,500,372 B belongs to other traffic. History alone can therefore reduce total bytes by at most 25.4%, even if it were eliminated completely, below the required 40% total-write reduction. These are logical in-memory DataAdapter figures, not physical APFS writes. The earlier compact-envelope prototype increased History by 763,918 B and is rejected.

## Experiments

The harness builds one canonical bundle of 25,000 core records and reuses its text and canonical hash for five rotating rounds of baseline, A, and B on real Node filesystem adapters. Each run uses a new OS temporary root.

- **Baseline:** plain UTF-8 DataAdapter persistence.
- **A:** gzip only History files at the adapter boundary. Reads expand to the original canonical v2 batch before transaction hash checks, History decoding, or restore.
- **B:** benchmark-only shared lifecycle templates in History and in the History mutation nested inside pending intents. Reads reconstruct the original canonical transaction and History text. The production coordinator and History schema remain unchanged.

The report records logical and physical DataAdapter write bytes for History, pending intents, and other paths; write/append operation counts; final file count and total file size; import wall and CPU time; adapter encode/decode wall and CPU time; undo and redo latency; and each round’s results. It explicitly does not describe filesystem file sizes as physical storage sectors or as Vault sync traffic.

## Required semantic and acceptance checks

The 25k harness asserts schema version 2, exact canonical History text and checksum within each run, all 25,000 lifecycle changes and valid change IDs, one conflict plus 24,999 clean changes after a local edit, default no-overwrite behavior, and undo/redo preserving the conflicted record. The per-run History decoder verifies each change ID against its transaction-specific batch ID; cross-mode comparisons omit those transaction-derived IDs while comparing every logical change field. Crash checks inject failures after History staging writes during import and restore, restart the runtime, and verify recovery in all three adapter modes.

A candidate is eligible only if History bytes fall by at least 30%, total physical bytes written by the DataAdapter (including pending and other writes) fall by at least 40%, every paired CPU and undo/redo result stays within +20%, crash recovery passes, and the full logical semantics remain identical. A candidate that misses any one gate is retained as an experiment only and the result remains D.

## Work completed and verification

The disk-only tests pass for plain, gzip, and shared-lifecycle encodings. They verify temporary-root path guards, exact expanded logical History, change IDs, undo/redo, and restart recovery after import and restore crashes. The transfer-v2 regression suite also passes.

Verified command:

```text
node --check scripts/benchmark-vocabulary-bulk-disk.mjs
node --check tests/vocabulary-bulk-node-data-adapter.mjs
node --test tests/vocabulary-bulk-node-adapter.test.mjs tests/vocabulary-transfer-v2.test.mjs
13 passed, 0 failed
```

The full benchmark command is:

```text
node scripts/benchmark-vocabulary-bulk-disk.mjs --run-25k
```

It writes `evidence/vocabulary-bulk-disk/25k-node-filesystem.json`. That file does not exist yet because the benchmark was not run. Root must register `tests/vocabulary-bulk-node-adapter.test.mjs` in the main gate manifest; this worktree intentionally leaves the gate script unchanged.
