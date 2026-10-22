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
