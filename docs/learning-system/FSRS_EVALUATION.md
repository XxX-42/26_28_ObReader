# Development-only FSRS replay evaluation

This is a deterministic, synthetic replay experiment for the pinned `ts-fsrs@5.4.2` package. It does not change the default `leitner-utc-v1` scheduler, learning item state, Vocabulary state, History, or any provider. The proposal is printed to stdout only; no canonical files are written. Each report includes a byte-preservation check and a simulated undo snapshot.

The fixture models a complete learning-item event chain, including one undone branch. Only events marked `onCurrentBranch: true` are replayed, and the active chain must match `lastReviewEvent` and reproduce the stored Leitner snapshot exactly. A legacy Vocabulary aggregate snapshot without complete ordered ratings returns `INSUFFICIENT_HISTORY`; the experiment never infers missing ratings from box, due date, or counters.

For this comparison only, `remember` maps to FSRS `Good` and `forget` maps to FSRS `Again`. This is an explicit coarse experiment mapping, not a claim of semantic equivalence. `known` is a Vocabulary status/filter, while `skip` is session-only; both are rejected as non-rating actions and are never converted to FSRS grades. FSRS fuzz and short-term steps are disabled so the output remains deterministic and day-scale. Due-date differences are reported as observations, not as an assertion that either scheduler is better.

The selected API is the v5.4.2 tag's CommonJS `require` export and its `createEmptyCard`, `fsrs`, `Rating`, and `State` exports. The replay uses `fsrs({ enable_fuzz: false, enable_short_term: false, learning_steps: [], relearning_steps: [] })`, then `scheduler.next(card, reviewedAt, grade)` for each event. See the [v5.4.2 release](https://github.com/open-spaced-repetition/ts-fsrs/releases/tag/v5.4.2), the [tagged scheduler README](https://github.com/open-spaced-repetition/ts-fsrs/blob/v5.4.2/packages/fsrs/README.md), and the [tagged scheduler source](https://github.com/open-spaced-repetition/ts-fsrs/blob/v5.4.2/packages/fsrs/src/fsrs.ts).

## Run

After the repository's normal dev dependency installation is permitted, the script resolves `ts-fsrs` from the exact dev dependency:

```sh
node scripts/learning-fsrs-evaluation.mjs
node --test tests/learning-fsrs-evaluation.test.mjs
```

When `node_modules` is an externally shared junction, do not install into it. Instead, pack and extract the pinned package into an isolated ignored artifact directory, then set `LEARNING_FSRS_PACKAGE_PATH` to the extracted package directory before running the same commands. The environment path is still checked for package name and exact version `5.4.2`.

The committed fixture SHA-256 is pinned in the script and test. This is a developer experiment only; it is not wired into production imports, UI, build output, or migration code.

## 0.14 shadow audit (2026-10-24)

Audited base: `65de915b306954a160ed99002f33ada639cebd4e`.

The production Learning service constructs `LeitnerScheduler` directly and records
`leitner-utc-v1` event versions. Its scheduler exposes `initialState`, `rate`,
`schedule`, `isDue`, and `describe`; FSRS remains a development dependency used
by scripts only. No production scheduler, transaction, WAL, migration, or default
was changed by this audit.

The existing replay pins real `ts-fsrs@5.4.2`, checks the synthetic fixture hash,
replays the complete current branch, and requires exact parity with the stored
Leitner snapshot. The development adapter reads only `getItem` and `listBatches`,
validates immutable rating graph identity/order, and emits aggregate queue
comparisons without source text, item IDs, card states, or vault paths.

The audit found that rating batches' recorded `before` values were ignored.
The shadow adapter now also requires each batch's previous event to exactly match
its declared predecessor and its pre-state to match the replayed predecessor
state (or the initial state for a root). Unsupported event schema/scheduler
versions on retained undone branches also fail closed. These cases are classified
as `INSUFFICIENT_HISTORY` (`HISTORY_CHAIN_INVALID`, `STATE_PARITY_MISMATCH`, or
`HISTORY_GRAPH_INVALID`), never reconstructed from aggregate counters.

Validation:

- `node --test tests/learning-fsrs-evaluation.test.mjs tests/learning-fsrs-dev-adapter.test.mjs tests/learning-domain.test.mjs`: 26 passed, 0 failed.
- `npm run build`: passed; 3 release files built, 402 frozen vendor files verified.
- `node scripts/learning-fsrs-evaluation.mjs`: complete synthetic replay; 5 current events, 1 ignored branch, Leitner due `2026-10-22T09:00:00.000Z`, FSRS due `2026-10-24T09:00:00.000Z` (delta +2 days); zero authoritative writes and all source/undo byte-preservation checks true.
- New regressions cover shuffled batch order, inconsistent pre-states, missing predecessor snapshots, unsupported undone-branch scheduler evidence, and unchanged input bytes.

Limits: this is synthetic, fixed-history evidence only. The +2 day result does
not measure retention, scheduler quality, or counterfactual total review load.
No real user cohort was read or migrated. The in-memory migration/undo simulation
is not a persisted migration or transaction guarantee. Browser/native gates and
deployment were outside this shadow-only audit. A caller-provided explicitly
complete standalone fixture remains distinct from the stricter History-batch
adapter; History completeness cannot be proven from legacy aggregates.
