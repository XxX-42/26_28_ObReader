# Workstream G: FSRS development audit

**Disposition: no production change.** Production remains on `leitner-utc-v1`.

## Audit findings

- `plugin/learning/service.cjs` constructs `LeitnerScheduler`; `plugin/learning/scheduler.cjs` exposes the pure initial-state, rating, due-check, and description operations over UTC 1/3/7/14/30-day intervals. FSRS is isolated in `scripts/learning-fsrs-evaluation.mjs` and `scripts/learning-fsrs-dev-adapter.mjs`; `ts-fsrs@5.4.2` is a dev dependency. No production scheduler or canonical History code was changed.
- The checkout contains one complete **synthetic** ordered replay fixture and no non-synthetic item/History export. The fixture has five current-branch ratings and one retained undone-branch event. No Vault was read. Existing negative tests cover legacy aggregates, missing history, malformed or broken graphs, invalid UTC/order, and state-parity failures; the adapter reports incomplete cases as `INSUFFICIENT_HISTORY` with reason codes instead of inferring ratings.
- Existing shadow-replay records in `docs/learning-system/014_OBJECTIVE_COMPLETION_DRAFT.md` and `evidence/014-resource-v3/REPORT.md` also describe the experiment as development-only, report the focused 12/12 replay suites, and record zero authoritative writes. They contain no non-synthetic review cohort.
- The pinned replay completed against `ts-fsrs@5.4.2`. On this synthetic chain, FSRS due date is 2026-10-24 and Leitner due date is 2026-10-22 (`+2` days for FSRS). This is a queue-date observation only, not evidence of retention or review-load improvement.
- The migration path is a simulation only: zero authoritative writes, a prior-state undo snapshot is present, stored state/source bytes remain unchanged, and undo reproduces the original stored-state bytes. It does not exercise a durable migration transaction.

The package tarball used for the replay matched the `package-lock.json` `ts-fsrs@5.4.2` integrity. The isolated tarball/extraction is ignored under `tests/artifacts/` and is not part of the commit.

## Conclusion

The only replayable history is synthetic and the rating mapping (`remember` → `Good`, `forget` → `Again`) is explicitly coarse. There is no production-safe new insight for changing scheduling. Keep `leitner-utc-v1` as the default; keep FSRS development-only until a complete, ordered, non-synthetic history cohort and outcome evidence are available. No Vault writes or scheduler-default changes were made.

Machine-readable summary: [`audit-result.json`](../../evidence/014-fsrs-development-audit/audit-result.json). Raw deterministic replay: [`synthetic-replay.json`](../../evidence/014-fsrs-development-audit/synthetic-replay.json).
