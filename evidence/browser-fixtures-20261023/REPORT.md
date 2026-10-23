# Browser fixture diagnosis

Based on `d83b59b`, with diagnostic-only test commit `a3ccc80`. Production main, bridge, input, vendor and storage files are unchanged. No full gate was run in this worktree.

## Observer: confirmed fixture readiness defect, corrected

The diagnostic reproduction failed at the original 5,000 ms Ink-count wait. Its first trusted pen pointerdown at (224, 192) targeted `<div class="page loadingIcon loading">`. The first two pointer moves also hit the loading page; only later moves reached `annotationEditorLayer creationPriority inkEditing`. There were no editors, no window errors, mode and manager mode were both 15, and readOnly was false. This rules out a missing navigation-request field: this test sends no navigation request.

PDF.js `AnnotationEditorLayer.pointerdown` returns unless the event target is the layer div. The existing mode/class readiness predicate can therefore pass before the page supplies the actual hit surface. The fixture now also waits for PDF.js page renderingState 3 and for elementFromPoint at its existing first stroke location to equal the real editor layer. It does not synthesize an editor, suppress a guard, change production behavior, extend the original 5,000 ms Ink wait, or remove any assertion.

Validation: `node --test tests/annotation-observer-lifecycle-browser.test.mjs` passed 1/1 after the change (test 1,992.912 ms). Both Ink strokes, all tool switches, durable-save rejection, absence of save acknowledgement, tracking failure, no escaped window errors, and export rejection remain asserted.

The original diagnostic RED remains at `/Users/jiajia/.codex/experiments/obreader-0.14/browser-fixtures-sol-low/annotation-observer-failure.json` and the sibling PNG. It is not replaced by the successful evidence.

## Interaction: unresolved intermittent scroll failure

Original full-gate RED is preserved under `/Users/jiajia/.codex/worktrees/obreader-0.14/v3-wiring/tests/artifacts/vocabulary-gates/runs/run-2026-10-23T15-00-53-164Z-59919-f3a335d5/children/browser-round-01-annotation-interaction-regression/` and its log-linked partial JSON/screenshot. It failed the fixture's scrollTop-zero assertion after internal sidebar navigation, which deliberately starts smooth scrolling. Sidebar selection and the source-verified review request had already succeeded. No host navigation request with missing requestId/targetKind/targetId appears in that path.

The single diagnostic reproduction passed the complete original test (12,731.001 ms). Captured reset: before top 10, immediate top 0, after one animation frame top 0; page renderingState 3, mode/manager 0, and scroll plus scrollend events both at top 0. This one PASS does not resolve or dismiss the prior race. No scroll recovery logic or timeout was changed. The original zero-position assertion remains, with pre/immediate/post-frame position, page geometry/rendering, active focus and scroll trace persisted before it for future full-gate failure analysis.

Successful interaction evidence remains in this worktree's ignored `tests/artifacts/annotation-interaction-da79cb6a6067-1792768236547-66852.json` and partial sibling. It must be considered alongside the original RED rather than replacing it.

## Lease and scope

Only the two requested diagnostic test files were run, then one explicitly authorized observer correction recheck. All owned browser resources exited through the existing cleanup path; the exclusive Browser diagnosis lease was explicitly released before report/commit work. Native may take the next lease. Further interaction reproduction belongs to a later authorized gate or diagnostic lease.
