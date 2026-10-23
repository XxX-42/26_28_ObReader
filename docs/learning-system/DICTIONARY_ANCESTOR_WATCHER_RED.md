# Dictionary ancestor watcher RED evidence

Baseline: `d938a914d24732ff4cfa7f9e51fc0c88d02d8df8`.

`tests/dictionary-host-state.test.mjs` loads the actual `plugin/main.js` with
its existing mocked Obsidian harness. The test-only export exposes the real
`isVocabularyDictionaryResourcePath`; the regression also invokes the real
`handleVocabularyDictionaryResourceChange` method with rename (new and old
paths) and delete (old path) inputs. It does not replace either implementation.

Run on 2026-10-23:

- `node --test --test-name-pattern='dictionary root ancestor' tests/dictionary-host-state.test.mjs`: 3 failed, 0 passed.
- `node --test tests/dictionary-host-state.test.mjs`: 7 passed, 3 failed.

All three new cases fail at the first expected ancestor,
`00_Archive/21_VocabularyData/dictionaries/ECDICT`, with actual `false`,
expected `true`. Adjacent unrelated directories are checked first and remain
`false`, with zero invalidations/refreshes. The intended positive cases also
cover `dictionaries`, `21_VocabularyData`, and `00_Archive`, and require one
invalidation and scheduled refresh per folder event.

This is an intentionally RED test-only change. No production implementation,
build, browser, Native, bulk benchmark, or full gate was run or modified.
Native gate remains PENDING; this evidence does not select or freeze an LRU.

The integration fix recognizes directory ancestors with an exact `/` boundary
for both current and compatibility roots. It does not subscribe unrelated
siblings. Re-running the real Host cases plus resource generation/invalidation
tests after that two-line predicate fix passed 28/28 on the same machine;
the three original RED results are retained in the evidence above.
