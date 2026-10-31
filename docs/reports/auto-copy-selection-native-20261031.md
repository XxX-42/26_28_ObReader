# Auto-copy selection links: Windows Native test/fix loop

Date: 2026-10-31. Branch: `feature/v15-single-jsonl`.
Starting commit: `a9fc6fc`.

## Reproduced failure and fix

Trusted mouse dragging in the normal arrow/READ mode produced a genuine nonempty
Selection but did not copy a link. The previous hook ran only at the end of a
tracked text-selection tool pointer. Ordinary READ selection is browser-owned and
has no such tracked pointer. The correction uses the existing InputRouter's
pointer down/end callbacks, preserving native selection and adding no global
listener. Deferred work checks document, open request, and selection sequence.

## Actual Obsidian results

Vault: `D:\Documents\Obsidian\远程仓库1`.
PDF: `12_books/别毙了那只狗教养和训练的新艺术.pdf`.
Real mouse actions were sent through the Windows computer-use API, not DOM Range
construction. CLI inspected the resulting clipboard and runtime state.

* Arrow-mode single-page drag: one stable selection link copied.
* Page 39 to page 40 drag: exactly two links, one per page. Persisted anchors
  `947ba1f7-e9c3-42cd-844b-c766aa1dda73` and
  `8ee64fae-c6b9-43f1-a94b-2cc51f894f4f` preserve each page's quote and location.
* Reverse drag from page 41 back to page 39: a nonempty 719-character selection
  copied exactly three links in page order (39, 40, 41).
* Copying alone: `pdfReaderMarkdownBacklinks` size 0.
* New test Markdown with one reference: highlight size 1 in the active Reader.
* Two references to the same target: highlight remains; removing one retains it.
* Removing the last reference: highlight size 0; ordinary annotations remain.
* Clicking referenced PDF text opened the new test Markdown and selected the
  complete original link at editor line 2 (zero-based), columns 0–139. The
  selection text exactly matched the copied page-39 link.
* Disabling the secondary-menu switch and dragging different nonempty text left
  the clipboard unchanged. The switch was restored to enabled.
* Both Reader revisions remained confirmed; no annotation edit was created.
* Test note `auto-copy-native-test-1793412338343.md` contains only a completion
  message now. Its temporary references were removed.

Final deployed main.js SHA-256:
`0d23814b3f9c846ce93941585370e0772b47a14fae5b7b958304b2770db51728`.
The regular deploy command hit EXDEV because it attempted to rename a D: plugin
directory into a C: worktree backup. With Readers clean and plugin disabled, the
three existing files were copied to a local backup, then replaced individually;
the plugin was enabled and original Reader leaves restored.

PDF SHA-256 before/after final Native retest:
`a971feb1bc901cc995cb9144da6368fb7eb895007e37ab65e8703d4ffdcaaf81`.
Existing annotation JSONL SHA-256 before/after final Native retest:
`80aa8ef6c08b6299a2389e2e5d91e0dff734022f687fce263339cf1faf063107`.
These byte hashes do not claim a system-wide write-attempt instrumentation gate.
Restoring zoom/page after the test subsequently updated the existing per-device
readerStates header and its commit integrity in JSONL. In the later chain-badge
run, reload/zoom hydration also caused an existing precision issue: three Square
rows were saved with rect deltas below 0.000033 PDF points (commit
`05f357c8-fc20-46c0-a729-97642cddfdcd`). UUIDs, annotation count and content remained;
the Reader reported revision=confirmed=1. Therefore whole-run annotation JSONL
immutability is NOT claimed. This behavior is separate from creating backlink
anchors and remains an observed gap. The source PDF bytes remain unchanged.

## Regression status

Related auto-copy, LingQ transition and Host tests: 141 tests passed, zero failed.
Full Fast gate: 141 files passed, 7 failed, 5 tests skipped; exit 1.
Report: `tests/artifacts/vocabulary-gates/runs/run-2026-10-31T02-07-43-392Z-27928-c51a4c65/report.json`.
The two additional failures introduced by the initial auto-copy implementation
were corrected without weakening assertions: a missing postToHost harness stub
and exact persisted-settings expectations for the new default setting.

Remaining failed files match the preceding reading-state baseline:
browser-test-cleanup, external-annotation-bridge, input-architecture-boundary,
mobile-main, packaging, pdf-annotation-host, vocabulary-v2-boundaries.
The packaging assertion currently compares a stale test-side runtime assembly
against the production build; this run does not waive that failing gate.
No full-suite acceptance is claimed.

Offline smoke passed: open, all five tools, bridge validation, external operation
save/reopen, and bulk-delete non-resurrection. Evidence:
`tests/artifacts/offline-smoke-1793412749460-28568-8811bcdc-cd0d-4bc7-a782-6b8b05fce142.cleanup.json`.

## Follow-up: ordinary highlight appearance and chain badge

At the user's request, the existing read-only CSS Highlight now uses ordinary
yellow highlighter fill instead of dotted underline. No new tool, annotation,
WAL record, or transport was introduced. The existing badge class and interaction
controller accept selection targets; a `🔗` badge sits at the selection's upper
right. Annotation backlink badges use the same symbol.

The selection-badge unit test was red before the controller change. Afterward,
17 controller/auto-copy tests passed, and the real PDF.js bidirectional browser
test passed with explicit badge identity and nonzero-geometry assertions.
Formal-vault Native visual inspection showed yellow fill and the chain icon.
An actual mouse click on the icon opened the test Markdown and selected its exact
link at line 2, column 0. Removing the final test reference removed both the
chain badge and the CSS Highlight (both counts 0). Temporary test references were
then removed and the original zoom/page restored.

The preceding full Browser run completed with 27 files passed, 5 failed, no skips:
desktop-toolbar, embedded-annotation-scan, free-text-native-ap-undo-regression,
highlight-multiline-regression, open-lifecycle-regression. These failures are
retained in `tests/artifacts/vocabulary-gates/runs/run-2026-10-31T02-07-56-151Z-28860-2cd97a86/report.json`.
This is not an all-green release acceptance.

Final follow-up build gates:

* Build: passed; 406 embedded assets; frozen vendor unchanged.
* Fast: 141 files passed, 7 failed, 5 skipped; exit 1.
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-31T02-17-13-890Z-30656-e423e5d7/report.json`.
* Browser: 27 files passed, 5 failed, 0 skipped; exit 1. Same failed-file set as
  the preceding full run; the bidirectional test including the new badge passed.
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-31T02-17-52-097Z-29188-648b02e0/report.json`.
* Offline: passed on the final build; cleanup receipt
  `tests/artifacts/offline-smoke-1793413139551-9392-1f48af0f-bd4d-4205-82ae-87c1649db430.cleanup.json`.
* Installed main.js, manifest.json and styles.css hashes exactly match dist.

This commit is a feature-branch correction with explicit remaining gates, not a
claim that every historical product/test failure has been resolved.
