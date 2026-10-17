# Phase E — Today Review

Phase E adds the user-facing Leitner review actions over the frozen Review
service contract. The canonical state remains partitioned from
`en.vocab.json`; PDF, annotation WAL/Sidecar, Pencil/input, and PDF.js files are
outside this phase's change set.

## Behavior

- The workbench shows due families with their current box and a device-local
  rendering of the persisted UTC due instant.
- **Remember** and **Forget** use stable action IDs. A retry reuses the same ID,
  so an acknowledged journal action is not counted twice.
- **Skip** hides a due family for the active Review session only. It writes no
  journal action and changes no canonical Review state; opening a later session
  makes the unchanged due family visible again.
- Known families are filtered by the Review service without changing their
  enrollment, box, due instant, or review history.
- The host accepts only the three supported Review actions and validates the
  family key and action ID before dispatching to the current Review session.
- Concurrent controlled closes share one Review-session finalization. A later
  close is idempotent, while a new session can still be opened after close.
- List lookup is bounded to groups of 256 family reads and still returns a
  stable, cursor-paginated result with the exact eligible total.

## Changed files

Runtime/UI:

- `plugin/vocabulary/review-service.cjs`
- `plugin/vocabulary/runtime.cjs`
- `plugin/vocabulary/workbench.cjs`
- `plugin/main.js`
- `plugin/styles.css`

Tests and built output:

- `tests/vocabulary-review-service.test.mjs`
- `tests/vocabulary-v2-runtime.test.mjs`
- `tests/vocabulary-workbench.test.mjs`
- `tests/vocabulary-workbench-browser.test.mjs`
- `tests/plugin-host.test.mjs`
- `dist/pdf-web-reader/main.js`
- `dist/pdf-web-reader/styles.css`

## Verification evidence

- Fast Gate: **90 passed, 0 failed, 0 skipped** in both the initial and final
  source-stable runs. Final report:
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T23-11-29-442Z-36852-90088ef4/report.json`
- Race Gate: **60 passed, 0 failed, 0 skipped**, two child processes across ten
  rounds. Report:
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T22-57-17-279Z-30233-03811fa3/report.json`
- Full Browser Gate first run: **21 passed, 1 failed, 0 skipped**. The single
  failure was the frozen iPad pointer/inertia lifecycle case. Its source and
  test files are identical to the Phase D integration baseline. The isolated
  scenario passed on the Phase E tree, and the same full gate then passed on
  the Phase D baseline and on a clean Phase E rerun. The original failure
  remains recorded; it was not reproduced and no input assertion was changed.
  Its exact scheduler/timing trigger is still unknown. Reports and raw logs:
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T22-51-44-857Z-28219-7f378c65/report.json`.
- Full Browser Gate rerun: **22 passed, 0 failed, 0 skipped**. Report:
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T23-07-19-395Z-34686-c8f09640/report.json`.
- Phase D baseline Browser Gate: **22 passed, 0 failed, 0 skipped**. Report:
  `/private/tmp/obreader-vocab-phase-d-browser-audit/tests/artifacts/vocabulary-gates/runs/run-2026-10-17T23-03-07-174Z-32813-aa9b9a85/report.json`.
- Targeted UI browser check: **1 passed**. The captured 768px light-theme
  screenshot is
  `tests/artifacts/vocabulary-workbench/run-1792277352975-26829/ipad768-review-light.png`;
  all three actions met the 44px minimum touch target.
- `npm run build`: passed; release package contains three files, 406 embedded
  assets, 402 frozen vendor files, and a 6,701,791-byte JS bundle.
- The source fingerprint remained stable during the completed Fast, Browser,
  and Race runs. No PDF fixture or production Vault file was changed.

The final Functional Browser Gate run is acceptance-eligible. The earlier
single iPad lifecycle failure was not reproducible on either the clean Phase D
baseline or the Phase E rerun; its exact timing trigger remains unknown and the
failure evidence is retained. Real iPadOS was not tested.

## Remaining acceptance limits

- The required 30-minute Nightly Stress matrix is still outstanding at this
  phase report's creation.
- Cross-device concurrent automatic Vocabulary merge remains unsupported.
- Real iPad/WKWebView behavior is not represented by the browser screenshot or
  synthetic touch tests.
