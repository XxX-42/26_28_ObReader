# P0: same-page backlink result ordering

## Host red / green evidence

On baseline `9c361330`, the added `Reader backlink page lookup cannot publish a superseded same-page result` test starts two actual host requests against a controllable lookup boundary. The newer lookup resolves with a marker; the old lookup then resolves empty. The original host returns `true` for the old result and publishes it, contradicting the assertion that old results must not clear current markers.

- Before: `node --test tests/plugin-host.test.mjs`: 86 tests, 85 pass, 1 fail, 0 skipped/cancelled. Failing assertion: `a late empty result cannot erase the newer page markers`; actual `true`, expected `false`.
- After: same command, 86 tests, 86 pass, 0 fail/skip/cancelled.

The host now uses a per-view lookup generation, captures the current index revision for an already-ready index, echoes the Viewer request ID, and refuses results superseded during the asynchronous lookup. A proactive refresh reuses only the exact current document/open/renderer/page request ID. Legacy requests without IDs remain supported. No additional index, Vault scan or storage read was introduced.

The paired Viewer fix rejects a superseded request before clearing or asynchronously painting markers. Its isolated browser receipt is recorded by workstream D. Passing that repaired browser fixture does not by itself prove the historical click timeout had the same cause, nor does it constitute Native Obsidian acceptance.

## Scope

This is a proven asynchronous presentation correctness repair. It does not change WAL, Sidecar, source identity, annotation persistence or PDF.js vendor. Input performance and Native acceptance remain separate gates.
