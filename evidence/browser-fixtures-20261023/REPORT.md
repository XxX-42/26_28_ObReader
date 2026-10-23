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

## Follow-up: asynchronous scroll completion evidence

The second full-gate interaction RED is preserved at `/Users/jiajia/.codex/worktrees/obreader-0.14/v3-wiring/tests/artifacts/vocabulary-gates/out/6dc5cb02b91b/annotation-interaction-r/annotation-interaction-807f39521f97-1792768751369-70334.partial.json` and its failure screenshot. Its reset went from top 10 to immediate top 0, then to top 3 after the animation frame. The trace captured both scroll and scrollend at time 9895 with top 3. Page renderingState was 3, both modes 0, and browser error arrays were empty. This is direct evidence of an asynchronous scroll write after the fixture's reset; it is not a failed navigation protocol or missing rendered page. The available trace cannot uniquely distinguish the final native smooth-scroll tick from scroll anchoring.

Static source inspection shows `navigateToAnnotationUuid` returns immediately after requesting smooth scroll; sidebar selection waits for that return, not for scroll completion. PDF.js also processes scroll through a requestAnimationFrame callback. A candidate fixture change therefore waits for the already-instrumented navigation scrollend and two unchanged geometry frames before resetting once to zero. It retains the original after-frame exact-zero assertion and every subsequent drawing assertion. It does not repeatedly force the viewport to zero or change production scrolling. The new readiness bound is 5,000 ms; existing timeouts are unchanged.

This follow-up was prepared statically while another heavy matrix owned the lease. No Browser or full-gate run has validated the candidate, and it is not reported as fixed. Original RED evidence remains authoritative until an authorized recheck.

The readiness check runs after closing the sidebar, so its geometry samples include any closing layout change. It also handles a no-scroll navigation without waiting forever for an event that cannot occur: only an empty trace since navigation began, unchanged initial scroll coordinates, and three matching geometry observations may take that branch. Any observed movement instead requires actual scrollend. The artifact records which branch was used and the stable frame count. This is an observational readiness condition, not an assertion that browser-native pending animation internals are exposed; the subsequent exact-zero assertion still rejects an asynchronous write after reset.

## Lease and scope

Only the two requested diagnostic test files were run, then one explicitly authorized observer correction recheck. All owned browser resources exited through the existing cleanup path; the exclusive Browser diagnosis lease was explicitly released before report/commit work. Native may take the next lease. Further interaction reproduction belongs to a later authorized gate or diagnostic lease.
