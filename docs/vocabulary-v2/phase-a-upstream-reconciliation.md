# Phase A upstream reconciliation

## Integration snapshot and acceptance boundary

Phase A started from the preserved WIP commit `3a840a6ec4924bfeb4e2a684e734226c2ba2c4ee` (0.11.3). The complete pre-upstream Phase A worktree is preserved at `1f982f4f69c2985aa8efe87783ce771cd46dbdb2`, whose parent is `3a840a6`.

The integration branch is `codex/vocabulary-v2-phase-a`. Upstream was first inspected at `8da68a2f48cdb6ebc9de94314c16005b14631c07` (0.11.5); the actual in-progress merge is pinned by `MERGE_HEAD=c27fcdc38f96df59b9bf61e88863cda0abc7e1e8` (0.11.6). Do not reset the merge to 8da: c27 adds the 0.11.6 occurrence-anchor validation described below. At 8da, the feature branch was six commits ahead of `main` `07effedb925a81d5c581ad2d6578ecbcafc4b852`; at the actual c27 merge target it is seven ahead and zero behind.

The pre-upstream external backup is `/Users/jiajia/.codex/backups/vocabulary-v2-phase-a-pre-upstream-20261017T192320Z`; `working-tree.patch` has SHA-256 `2377e812eda1d8303844b32debb2c2f93ab2f5a32bfe10a8fd3ab54eaab5ed91`.

The upstream reconciliation is present in the current merge worktree at `MERGE_HEAD=c27fcdc38f96df59b9bf61e88863cda0abc7e1e8` (0.11.6). Phase A's implementation and acceptance gates are complete, while its commit and local integration remain pending; schema v2 has not started. Full-gate and focused evidence below have different scopes and remain separate.

## Pre-merge focused stability evidence

Before upstream integration, a focused diagnostic report was saved at `tests/artifacts/vocabulary-v2/phase-a/stability-before-upstream-integration/report.json`. It identifies its purpose as diagnostic stability evidence, not full-gate acceptance; it used `chrome-headless-shell 154.0.8037.57` and did not automatically retry.

| Diagnostic | Result | Scope limit |
| --- | --- | --- |
| FreeText undo appearance | 10/10 browser runs exited 0. | Repeated focused regression against pre-merge Phase A source; not the complete Browser gate or merged source. |
| Sync bridge | 3/3 browser runs exited 0. | Repeated focused regression against pre-merge Phase A source; not the complete Browser gate or merged source. |
| Cleanup fixture bounded concurrency | 10/10 runs succeeded. | Each run covered two selected cleanup tests only; not the full cleanup suite, autosave/highlight race pair, or ten-round Race gate. |
| Wrapped `logicalSurface` strict path | 120 tests passed through the actual scanner → controller → authenticated host → pill flow. | Focused functional coverage; not full Fast, Browser, or Race acceptance. |

The earlier complete gate report remains `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T18-45-56-794Z-46054-b78940a8/report.json`: Fast 73/73, Browser 17/19, Race 18/20, total 108/112, with `acceptanceEligible: false` and zero skipped children. Its original nonzero exits and raw logs are retained. Passing focused repetitions do not erase those results; the later integrated reports below supersede it for current acceptance status.

## Previous complete full-gate evidence (19:26 run)

The previous complete all-gates report is `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T19-26-33-110Z-65362-cdd58551/report.json`. It records Fast 74/74, Browser 18/20, Race 20/20, 112/114 overall, zero skips, and `acceptanceEligible: false`. The before/after source fingerprint is stable at `c842108e87eb84a7a122e1a1aea4e0e30e82afece9d6f9ab5006c96babcf64d9`. Browser failures are iPad pointer policy (`hiddenSample` null at the synchronous visibility-boundary scroll assertion) and Underline (baseline browser `Range` lacked the expected nested span/text rectangles). Sync bridge and Sidecar FreeText passed in that run. Preserve both failing exits and their raw logs as historical evidence; the final report below has the current acceptance result.

A separate targeted run with full Chrome 154 at `/Users/jiajia/Library/Caches/codex-vocabulary-browser-engines/chrome/mac_arm-154.0.8037.57/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing` ran the original iPad and Underline assertions unchanged and passed 2/2 in 21.25 seconds. Its log is `/private/tmp/vocabulary-v2-fullchrome154-preconditions.log`. This is not the all-gates run and must not be described as the pre-merge `chrome-headless-shell 154.0.8037.57` stability run; the final all-gates report is recorded below.

## Final acceptance-eligible full-gate evidence

The final report is `tests/artifacts/vocabulary-gates/runs/run-2026-10-17T19-45-34-763Z-71721-215a3415/report.json`. Fast passed 74/74, Browser passed 21/21, and Race passed 20/20 over ten rounds with two parallel child processes per round: 115/115 child processes passed, zero failures, zero skips, and `acceptanceEligible: true`. The source fingerprint was identical before and after at SHA-256 `b294ce412c5bf29db15f6c8924aed1bedf6c9d7ca73b0b31ab67edcedd381313` across 818 files. TAP totals were 779 Fast tests passed, 22 Browser tests passed across 20 test files, successful offline smoke, and 20 Race browser tests passed.

The environment record `tests/artifacts/vocabulary-v2/phase-a/fullchrome154-environment.json` identifies full Chrome for Testing 154.0.8037.57 on Node 26.3.1/macOS arm64 and states that this report used full Chrome, not headless-shell. The final build payload was 6,700,043 bytes; 406 runtime assets were built, 402 frozen vendor files verified, and root verification found the 441-file frozen subsystem set unchanged. Earlier failing reports and their raw exits remain preserved as historical evidence.

## Native FreeText AP and Sidecar visual coverage

The Sidecar FreeText browser case passed in the final gate and previously passed 10/10 focused runs on the pre-merge tree. It exercises Sidecar DOM pixels and cannot stand in for the original native-PDF appearance-stream held-ACK Undo case. `tests/free-text-native-ap-undo-regression.test.mjs` was added after the 19:26 report, and both independent cases passed in the final 21-child Browser gate.

The initial native AP attempt restored pixels on the first Undo while the delete ACK was held, then failed to repaint the second Undo after ACK despite persisting the same UUID and PDF ref. The cause is now confirmed from `/private/tmp/vocabulary-v2-native-ap-focused/round4/artifacts/freetext-native-ap-undo-1792266151947-70957-b05eee07-d18b-49df-b3cb-bc724510b30c.json`, captured against locked pre-fix source SHA-256 `1c4259d0be3eccd671b9c66aa7d6445947f5d5acca02bfc1dcb5aa52d490bbf8`: the second-Undo repair repainted using the old mask; `applyConfirmed` at sequence 140 cleared that mask without repainting; hydration at sequence 143 then observed `false`.

The adapter fix consumes the mask-change result in `applyConfirmed` and reuses the existing exact loaded-page update/`forceRendering` path; it makes no Controller, storage, or PDF.js vendor changes. Adapter checks failed before the fix (`/private/tmp/vocabulary-v2-native-mask-notification-before.log`) and 23 passed after (`/private/tmp/vocabulary-v2-native-mask-notification-after.log`). The separate native AP browser case passed 1/1 in full Chrome 154 in 9.45 seconds. Its raw TAP log is `/private/tmp/vocabulary-v2-native-ap-focused/fix2/raw.log`, and its evidence JSON is `/private/tmp/vocabulary-v2-native-ap-focused/fix2/artifacts/freetext-native-ap-undo-1792266253195-71404-c8d5dbbf-9527-4d13-9d68-826622c226e1.json`. It verifies the original held-ACK erase/Undo, Redo, second Undo, AP pixels, same UUID/ref, source hash, and final reopen. Trace sequence 182 clears the mask, sequence 183 updates the page, and sequence 184 calls `forceRendering`. The native case remains separate from the Sidecar DOM case, which provides additional renderer-specific coverage.

The build log `/private/tmp/vocabulary-v2-phase-a-native-mask-build.log` reports 406 embedded runtime assets, 402 frozen vendor files verified, and a 6,700,043-byte payload. The native AP case passed 1/1 in the focused full-Chrome-154 run in 9.45 seconds, then passed as part of the final acceptance-eligible all-gates report above. Its separate Sidecar case also passed in that full gate. Keep the original 19:26 exits and their logs as historical evidence; the final report closes the integrated-source gate without overwriting them.

## Upstream behavior to preserve

The upstream changes form a cumulative series; the reconciliation should retain their behavior and tests alongside Phase A changes.

| Upstream point | Behavior to retain | Evidence to retain |
| --- | --- | --- |
| `b4ee949` (0.11.3) | `applyLegacyAnnotationIdentities()` restores the exact UUID, PDF reference, page, and annotation kind after native undo/redo rebuilds an editor; collision checks and idempotency prevent mistaken identity reuse. Existing saved-editor hit testing stays enabled in NONE mode while creation priority remains intact. | External annotation identity-cache assertions; FreeText undo identity/appearance checks; real trusted mouse double-click and iPad input precondition checks. |
| `d1dc8b5` (0.11.4) | Vocabulary pill placement uses the visual viewport and keeps close/status controls and the five grade controls reachable. The definitions/backlink body scrolls independently, including in short or narrow viewports. | Placement unit tests and browser layout coverage for viewport edges, long definitions, controls and close reachability. |
| `8da68a2` (0.11.5) | An unrecorded word is labeled `陌生词`. The compact occurrence-link control remains in the pill header and visible beside close at narrow widths; copy feedback does not expand the label. | Controller status assertion and browser layout checks for the header, compact link, controls, and close button. |
| `c27fcdc` (0.11.6) | Capture obtains the page number from `data-page-number` when PDF.js page roots have `id=""`, and verifies that the root is exactly the current viewer's `pdfViewer.getPageView(pageIndex).div`. The legacy `pageN` id is accepted only when it agrees with the current page root. Invalid/conflicting page numbers, stale or foreign roots, and lexical mismatch fail closed. Ordinary selection capture and LingQ occurrence capture share this validation. | `LINGQ_OCCURRENCE_0.11.6.md`; external bridge tests; browser layout tests must exercise the real `reader-anchor-capture` request/ACK path, including desktop, zoom, touch, post-scroll capture and rejection cases. The commit reports 61 focused regression tests, four packaging checks and offline smoke; those are commit-scoped checks, not Phase A full-gate acceptance. |

The 0.11.6 occurrence fix does not change authenticated bridge semantics, source-hash validation, Anchor format, or annotation/vocabulary storage. This behavior is present in the passing integrated tree; preserve the separation between occurrence capture and vocabulary/annotation storage.

## Conflict-sensitive Phase A behavior

The preserved Phase A source includes strict `logicalSurface` propagation across scanner, controller, host authentication, and pill presentation. Keep physical text segments for evidence, derive the permitted logical surface for dehyphenated words, reject arbitrary key/surface mismatches, and present the logical word. Its 120 passing tests cover the actual end-to-end path.

The sync bridge regression in the preserved Phase A WIP has expanded assertions beyond the upstream 0.11.3 deletion version. Keep the Phase A cases for failed host persistence and retry with the same UUID/exact document-open-renderer identity; same-UUID Square save/reopen; delete/undo/redo/tombstone behavior and stale resurrection rejection; clean remote hydration; mixed-page explicit export order; original PDF references and popup/untracked annotations; and unchanged source bytes during ordinary save. Both the 3/3 pre-merge run and the final all-gate Browser pass cover this expanded test on their respective source states.

The integrated controller and CSS retain upstream visual-viewport pill placement, body/header structure, `陌生词`, and persistent compact occurrence link alongside Phase A logical-surface lookup and display behavior. The bridge retains the upstream native-undo identity cache and 0.11.6 current-page-root validation alongside Phase A identity, persistence, and capture paths. The stable source fingerprint and acceptance-eligible full-gate report apply to this integrated tree.

## Required closure evidence

The native AP diagnostic is resolved and the focused native case passes without dropping original coverage. The complete gate on the integrated source passed: Fast 74/74, Browser 21/21, Race 20/20 over ten two-process rounds; total 115/115, zero failures or skips, stable source fingerprint, and `acceptanceEligible: true`. Historical failures and raw logs remain intact. Phase A implementation and acceptance criteria are complete; the merge commit/local integration remain pending root action. Schema v2 has not started.
