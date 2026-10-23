# Legacy Highlight text recovery: unique glyph line ownership

The first complete 0.14 staging gate retained 15 failed cases: two Fast
harness/version failures, three Browser failures and ten Race instances of
the same legacy Highlight text assertion. It was not accepted. Raw report:
`tests/artifacts/vocabulary-gates/runs/run-2026-10-23T15-00-53-164Z-59919-f3a335d5/report.json`
in the private `v3-wiring` worktree. The source fingerprint stayed unchanged.

The legacy text helper and the one/two/four-line Browser fixture were identical
to the `cd6e157` baseline. This was an existing correctness defect exposed by
the required legacy-Highlight contract gate, not a new navigation protocol
failure. Captured public tracemonkey PDF glyphs and quads are retained in
`evidence/legacy-highlight-protocol/`; both diagnostic Browser runs reproduced
the original exact-text RED without changing its assertion.

Four selected visual lines contained 73 non-whitespace glyphs. Independent
per-line hit sets selected 30 glyphs twice because font rectangles overlapped
adjacent quads and the existing one-pixel center tolerance admitted both lines.
The recovered result therefore contained 103 non-whitespace glyphs. One- and
two-line selections did not show the duplicate ownership.

The production correction is confined to
`recoverHighlightTextFromTextLayer()` in the bridge. It retains the existing
horizontal and center eligibility rules and text assembly, assigning each
eligible glyph once to the line with the greatest vertical overlap. It does
not change annotation identity, geometry, persistence, input arbitration, PDF
rendering or the source PDF. No frozen vendor/storage files were changed.

After applying the correction, the unchanged Browser assertions passed:
one/two/four-line selection text and geometry, exact durable operation text,
legacy Sidebar text recovery, save and reopen. Retained output:
`/Users/jiajia/.codex/worktrees/obreader-0.14/evidence/legacy-highlight-browser-repair.log`.
This focused PASS does not supersede the failed full gate; the complete gates
must run again with the integrated correction.

The separate annotation-observer failure was an early test stroke on a page
still displaying `loadingIcon`; its fixture now waits for the real rendered
editor surface. The separate annotation-interaction scroll-restore failure
remains under observation: a diagnostic standalone run passed, which does not
erase the original failure. Native route acceptance and resource-v3 deployment
remain pending.
