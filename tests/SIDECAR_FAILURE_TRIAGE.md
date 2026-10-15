# 0.7.1 full-suite failure triage

## 2026-10-15 B-stage final capture

The final frozen B-stage capture is `tests/artifacts/stage-evidence-20261015T032743936Z-41580/`.
`npm test` exited 1 with 448 tests: 422 passed, 19 failed, 2 cancelled,
and 5 skipped. `npm run test:offline` exited 0. The captured test log is the
source of the individual failures; no follow-up rerun was made.

Four unresolved product-safety behaviors remain red and must not be waived:

1. `independent stale replay cannot overwrite a newer checkpoint`: stale
   replay replaced the newer durable checkpoint. Evidence:
   `tests/artifacts/store-cross-instance-race-stale-replay-overwrite-2026-10-15T032856689Z-12716.json`.
2. `retired-device stale replay cannot erase a batch after real GC`: stale
   replay removed B's acknowledged, garbage-collected annotation. Evidence:
   `tests/artifacts/store-cross-instance-race-retired-stale-replay-after-gc-2026-10-15T032856914Z-12716.json`.
3. `Obsidian auto-save debounces complete edits and serializes revisions`:
   the synthetic IME close path still fails to prepare/durably save. This is
   not evidence of a reproduced Native Obsidian IME failure.
4. `FreeText sidecar capture keeps geometry and self-echo hydration adopts the
   live editor`: the raw-save path sees a zero-area live editor and no value;
   this matches the frozen pre-A failure and remains unresolved.

The other notable non-product classifications are: `child-process crash
boundary: pending-before-rename` is a full-suite worker timeout
(`NOTVERIFIED`), while the other six crash-boundary scenarios passed; the
`sync bridge keeps UUID operations across saves and applies a prepared
checkpoint in place` failure is the stale full-PDF `ArrayBuffer` oracle; the
iOS autosave case still has an invalid empty-store dirty precondition; and the
remaining browser/Viewer failures are test-host readiness, timeout, or browser
cleanup failures. The two B race failures above are genuine safety reds, not
test infrastructure failures.

The capture records the same branch and HEAD before/after, unchanged tracked
diff and untracked list, and identical dist/installed triplet hashes. The
combined triplet SHA-256 is
`56d787634d005004e5bbeedafeb42790be6c37df347ec142569c5e781a12d2af`;
the `main.js` SHA-256 is
`3d48a16fcdc89c915b72f0a335a572fbf5096c56ad0f795630e79ef7e8be32c9`.
Thus this verification run made no product/build/deployment changes.

## 2026-10-15 A-stage frozen comparison after the safe-port correction

This earlier full-suite record and acceptance history below are retained.
Captures were made with
`node scripts/capture-stage-evidence.mjs`. Each run had zero cancelled tests.

| Frozen run | Tests / passed / failed / skipped | `npm test` | Evidence |
| --- | --- | --- | --- |
| Pre-A baseline | 427 / 409 / 13 / 5 | exit 1 | `tests/artifacts/stage-evidence-20261015T021349017Z-36656/` |
| First A capture, before port correction | 431 / 411 / 15 / 5 | exit 1 | `tests/artifacts/stage-evidence-20261015T030125558Z-39912/` |
| A capture after safe-port correction | 431 / 413 / 13 / 5 | exit 1 | `tests/artifacts/stage-evidence-20261015T030626192Z-40668/` |

The first A capture retained all 13 baseline failures and added two red tests:
`a save-in-progress checkpoint rejection releases and retries without waiting
under the host save queue`, and `selection differential U0/U1/U2 and
same-document viewer teardown`. The latter was a harness setup error:
Chromium rejected `http://127.0.0.1:6667/` with `ERR_UNSAFE_PORT`. The fixture
now binds a safe loopback port in 49152–65535 and retries `EADDRINUSE`; the
focused corrected run is `tests/artifacts/selection-differential-1792033555432-42752.json`.
The post-correction full run recorded U0, U1, U2, lifecycle, and validation
complete in `selection-differential-1792033624225-39768.json`, with no
selection-differential test failure. The checkpoint-rejection test also passed
in that run.

The post-correction run is not a full-suite pass. Relative to the frozen 427
baseline, 11 failure names remain, the two mobile release tests now pass, and
two different tests are red. Thus the equal failure total (13) does not mean
the failure set is unchanged. `npm run test:offline` exited 0. Branch and HEAD
were unchanged (`test/external-annotation-layer-0.6.0`,
`704f6f18ae305a924e4d56cf0f90c13a1f0a8c8b`); the before/after status,
tracked diff, untracked list, dist triplet, and installed-test triplet in the
capture are unchanged.

### Current 13 failures, classified

**`TEST_INFRA_FAILURE` — seven Viewer tests still stop before their intended
editing assertions because their mock hosts do not complete the 0.7 source
identity/annotation confirmation handshake.** Their current failure names
are:

- `annotation creation tools take priority over existing markup only while creating`
- `iPad policy routes finger scrolling separately from PDF.js editor and mouse input`
- `narrow Obsidian panes keep PDF tools, popups, and the secondary menu inside the viewport`
- `saved FreeText AP stays visible across NONE-mode right-eraser undo and redo`
- `trusted browser mouse input keeps PDF.js wheel, annotation, and click controls consistent`
- `PDF open waits for its own document readiness and cancels on renderer disposal`
- `underline selection geometry stays single-stroke across text runs and columns`

The two other `TEST_INFRA_FAILURE` entries are newly red in the post-correction
capture and are distinct from Viewer behavior:

- `mode-9 highlighter preserves exact one-, two-, and four-line selections`
  persisted candidate-1/2/4-line, save, reopen, candidate-complete, and
  validation-complete phases. Its evidence
  `highlight-multiline-regression-1792033591118-42140.json` reports
  `validation.candidateFailures: []`. The test fails only when
  `attachCleanupErrors` reports `Puppeteer browser.close exceeded 20000 ms`;
  classify this run as a browser-cleanup failure, not a failed Highlight
  geometry assertion. The suite still remains red.
- `process-query diagnostics and timeouts still fail closed without signaling`
  fails at `tests/browser-test-cleanup.test.mjs:658`: expected two injected
  process-query calls, observed one (`1 !== 2`). It passed in the first A
  capture. This is a test-helper/process-query sequencing failure with no
  Viewer interaction; retain it as a current red pending a stable explanation,
  rather than claiming the cleanup test passed.

**`TEST_PRECONDITION_FAILURE` — iOS autosave.**
`iOS auto-save waits for idle and cooldown, then writes only the latest
revision` still signals `annotationStorage.onModified()` on an empty store
without creating a durable sidecar operation, then waits for a save. This is
the invalid synthetic-dirty precondition described in the earlier triage; it
does not establish a native iOS failure.

**`PRODUCT_FAILURE` — two unresolved browser save/close paths; preserve both
assertions.**

1. `Obsidian auto-save debounces complete edits and serializes revisions`
   reaches the synthetic IME close boundary. Current evidence
   `autosave-failure-1792033613845.json` records `prepare-close-ime` at
   revision 53 as `prepared:false`, `ok:false`, `dirty:true`,
   `recovered:false`, and `annotationBatchDurable:false`; the encode timing
   ends with `status:"error"`. This demonstrates the synthetic composition /
   close path remains unresolved, not that real IME input has been reproduced
   in Native Obsidian.
2. `FreeText sidecar capture keeps geometry and self-echo hydration adopts the
   live editor` remains the raw-save race. Current evidence
   `sidecar-freetext-hydration-failure-1792033646930.json` has
   `sourceConfirmed:true`, but immediately before raw save the editor's
   `liveRect` has zero width and height, `storageRect` is empty, and `value` is
   empty. The host rejects it for having no measurable rectangle and emits no
   save or sidecar operation; the later bridge snapshot contains a positive
   rectangle and the typed value. The same failure pattern is in frozen
   baseline artifact `sidecar-freetext-hydration-failure-1792030471145.json`
   and first A artifact `sidecar-freetext-hydration-failure-1792033332904.json`.
   Native acceptance does not erase this browser-harness product-path failure.

**`STALE_OLD_ORACLE` — one failure.**
`sync bridge keeps UUID operations across saves and applies a prepared
checkpoint in place` fails because its ordinary sidecar checkpoint assertion
still requires a PDF `ArrayBuffer` (`sync-bridge-failure-1792033646209-33208.json`).
This remains the old full-PDF oracle; the abort does not establish whether the
later UUID/session, undo/redo, reject, or durable-ACK assertions pass.

For completeness, the two baseline failures that passed in the post-correction
run were `release real browser without Node: mobile PDF/save/reopen (resource
imports)` and `release real browser without Node: mobile PDF/save/reopen
(forced Blob fallback)`. The full per-test logs and summaries remain under the
three evidence directories in the table. This classification does not convert
the two current cleanup/helper failures, the IME close result, or the FreeText
raw-save race to a pass.

Read-only triage of `tests/artifacts/sidecar-0.7.1-full-suite.stdout.log` (406
tests: 388 passed, 13 failed, 5 skipped). No tests were rerun and no product,
Vault, deployment, or remote state was changed. The per-test artifacts named
below are retained unchanged.

## Classification summary

| Classification | Count | Interpretation |
| --- | ---: | --- |
| `TEST_INFRA_FAILURE` | 7 | Browser mock host does not implement the 0.7 source-confirmation handshake; UI-dependent assertion is not reached. |
| `TEST_PRECONDITION_FAILURE` | 3 | The test creates dirtiness without a durable operation, or its simulated process timing contradicts the assertion window. |
| `PRODUCT_FAILURE` | 2 | Failure is observed through the browser harness at a real save/close boundary; root cause remains unresolved and is not asserted as a Native reproduction. |
| `STALE_OLD_ORACLE` | 1 | Assertion still requires full-PDF bytes from an ordinary sidecar checkpoint. |

For 0.7, an `annotation-source-identity` request must be answered with the
external-annotations confirmation/update before editing tools are enabled.
`tests/browser-sidecar-harness.mjs` implements that response; the older
per-test mock hosts below do not. This is an observed harness omission, not a
claim that all untested Viewer behavior is correct.

## Individual failures

1. **`TEST_INFRA_FAILURE` — annotation creation tools priority**
   (`annotation-interaction-regression.test.mjs:896`). The test waits for
   `#editorUnderlineButton.disabled === false`. Artifact
   `annotation-interaction-af39fd7e0018-1792024794661-35528.partial.json`
   records `annotation-source-identity` in `hostState.received`, while that
   fixture listener handles ready/opened/error/save only and never sends an
   external-annotations update. The PDF and first page are loaded, with no
   Viewer errors. The test is blocked before its interaction assertions.

2. **`TEST_PRECONDITION_FAILURE` — iOS autosave**
   (`autosave-mobile-regression.test.mjs:238`). The host handles ready/opened,
   heavy-lease, save, flushed, and error messages, but has no source-identity
   confirmation. More importantly, `markDirty()` only calls
   `annotationStorage.onModified()` on an otherwise empty store; it creates no
   editor/annotation and therefore no durable sidecar operation. Waiting for a
   first save after this synthetic dirty signal is not a valid 0.7 operation
   autosave precondition. The failure is the 8-second first-save wait; there is
   no evidence here of a native iOS failure.

3. **`PRODUCT_FAILURE` (unresolved; synthetic browser path)** — autosave
   controlled close (`autosave-regression.test.mjs:1156`). The shared sidecar
   host confirms the source. In retained artifact
   `autosave-failure-1792024816897.json`, `prepare-close-ime` ends at revision
   53 with `prepared:false`, `ok:false`, `dirty:true`, `recovered:false`, and
   `annotationBatchDurable:false`; `recoveries` is empty. The preceding test
   sequence dispatches a synthetic `CompositionEvent` start/end around the
   FreeText close boundary. The exact synthetic sequence and dirty/unrecovered
   result are reproducible evidence of a close/save-path failure, but do not
   establish that real IME input reproduces it. Keep the flush/close assertions;
   investigate the bridge path rather than weakening them.

4. **`TEST_PRECONDITION_FAILURE` — cleanup accepts natural exit**
   (`browser-test-cleanup.test.mjs:491`). The fixture schedules its child to
   exit naturally after 1,500 ms (`closeAfterMs`) but gives cleanup only a
   1,000 ms browser-close budget before it expects a normal zero-exit result.
   The assertion receives `report.status === "failed"`. This is a mismatch
   between the simulated exit schedule and the asserted cleanup deadline, not
   Viewer evidence.

5. **`TEST_PRECONDITION_FAILURE` — cleanup releases inherited pipes**
   (`browser-test-cleanup.test.mjs:853`). The simulated descendant exits after
   2,000 ms, while cleanup waits up to 2,500 ms and samples descendant liveness
   only when close resolves. The actual captured sample is at 2,325 ms with
   `alive:false` / `ESRCH`, so the test's “must still be alive” condition is
   scheduled after its fixture's lifetime. No product behavior is implicated.

6. **`TEST_INFRA_FAILURE` — narrow-pane toolbar**
   (`desktop-toolbar.test.mjs:516`). The wait is for the underline toolbar
   button to become enabled. Its mock listener handles ready/opened/error but
   does not answer source identity. The retained cleanup report is `normal`,
   with Chrome exit code 0 and no cleanup errors; this rules against browser
   cleanup as the cause. The test never reaches pane measurements.

7. **`TEST_INFRA_FAILURE` — FreeText AP / NONE-mode undo appearance**
   (`free-text-undo-appearance-regression.test.mjs:946`). The artifact
   `free-text-undo-appearance-1792024794766-14864-0b08126d-3872-4065-b4d5-17ce3662b092.partial.json`
   shows a visible, typed FreeText editor and mode 3, but the test times out
   waiting for a mode-0 event after clicking the FreeText toolbar button. Its
   host listener handles ready/opened/save/recover/error/flushed, not source
   identity or external-annotations confirmation. It has no saves and no
   Viewer errors. Since the toolbar is not confirmed writable, the subsequent
   save/undo/redo appearance assertions were not reached.

8. **`TEST_INFRA_FAILURE` — iPad pointer policy**
   (`ipad-pointer-policy.test.mjs:602`). The retained
   `ipad-pointer-policy-1792024795250-37720.json` records the timeout with
   annotation mode still 0 at the Highlight-mode wait. The test host only
   handles ready/opened/error and does not answer source identity. The test's
   earlier pen/touch routing observations do not make the later editor-mode
   assertion meaningful while the mock host has not enabled editing.

9. **`TEST_INFRA_FAILURE` — trusted mouse input**
   (`mouse-input-regression.test.mjs:744`). The test times out waiting for
   Square mode after clicking the native toolbar button. Its host handles
   ready/opened/save/error/input diagnostics/lifecycle, but not the 0.7 source
   identity request. The retained cleanup report is normal (Chrome exit 0 and
   no cleanup errors); the failed assertion is upstream of the trusted drawing
   checks.

10. **`TEST_INFRA_FAILURE` — open lifecycle preflight save**
    (`open-lifecycle-regression.test.mjs:484`). The preceding open/readiness and
    renderer-disposal probes are recorded as passing in
    `open-lifecycle-1792024799074-8180-0be106c2-0942-47cb-b0b2-9c3093349994.json`.
    The failure is later, waiting for a save after typing into a FreeText field.
    The fixture listener handles ready/opened/save/error/renderer lifecycle but
    not `annotation-source-identity` or external-annotations confirmation, so
    it cannot establish the editable/save-ready state expected by this second
    phase. This timeout does not invalidate the separately recorded lifecycle
    probe results.

11. **`PRODUCT_FAILURE` (unresolved; synthetic/browser raw-save boundary)** —
    FreeText capture and self-echo hydration
    (`sidecar-freetext-hydration.test.mjs:253`). The harness reports
    `sourceConfirmed:true`, so this is not the missing-host-handshake class.
    In `sidecar-freetext-hydration-failure-1792024833938.json`, immediately
    before `PDFViewerApplication.save()`, the focused editor's
    `serialize(true)` has a zero-area rect
    `[275.3186,480.7949,275.3186,480.7949]` and empty value, despite the prior
    test wait observing the typed DOM text and positive DOM bounds. The host
    then rejects capture with “has no measurable editor rectangle”; no save or
    sidecar operation is emitted. The post-failure bridge snapshot has the
    positive rect and text, showing a raw-save-boundary inconsistency. Keep this
    failure visible and investigate; it is a browser/Puppeteer path, not a
    Native acceptance result.

12. **`STALE_OLD_ORACLE` — sync bridge checkpoint bytes**
    (`sync-bridge-regression.test.mjs:535`, called at line 637). The first
    checkpoint artifact `sync-bridge-failure-1792024828540-35592.json` contains
    a valid dirty Square operation with UUID, clock, and payload, but reports
    `byteLength:0`. The failing assertion requires a non-empty PDF ArrayBuffer
    from an ordinary checkpoint, which is the old full-PDF oracle; 0.7 ordinary
    persistence is the durable sidecar operation batch, not a rewritten PDF.
    This run aborts at the first checkpoint, so its later UUID/session,
    undo/redo, reject, and durable-ACK assertions were not exercised by this
    failing execution. Those semantics must remain covered when the old
    checkpoint assertions are migrated; this classification does not waive
    them.

13. **`TEST_INFRA_FAILURE` — underline geometry regression**
    (`underline-regression.test.mjs:1670`). Artifact
    `underline-regression-af39fd7e0018-1792024830910-34000-failure.json` records
    phase `waiting for the initial text and annotation layers`, with 163 text
    spans, a loaded PDF, no page/console errors, and a received
    `annotation-source-identity` event. Its mock host listener handles ready,
    opened, save, and error but does not answer that identity request; the
    wait is still for the underline button to become enabled. Therefore the
    underline gesture/geometry code was never reached in this failing test.
    Separate Native underline observations must be triaged independently.

## Scope note

The root-reported Native FreeText save/close/reopen pixel pass
(`0.7-sidecar-native-acceptance-20261015004111575`) is separate evidence. It
does not erase the browser raw-save-boundary failure above, nor does the latter
claim that the Native flow fails. This document does not classify additional
Native or deployment observations.

## 2026-10-15 phase-timing frozen full-suite comparison

Read-only comparison of `tests/artifacts/sidecar-phase-timing-full-suite.stdout.log`
and `.stderr.log` against the immediately prior frozen run
`tests/artifacts/sidecar-0.7.1-final-full-suite.stdout.log` (409 tests: 391
passed, 13 failed, 5 skipped). No suite was rerun and this section does not
rewrite or replace the earlier 406-test triage above.

The phase-timing run recorded **420 tests: 401 passed, 14 failed, 5 skipped,
0 cancelled** (`146189.556 ms`, exit 1; stderr is empty). Relative to 409/391/13,
that is +11 tests, +10 passes, and +1 failure; skipped remains 5. The same 13
test identities failed in both runs. The one additional failure is the cleanup
fixture noted below. The +11 tests are the 3 sidecar-performance tests, 7
store-performance tests, and 1 summarizer test. The later
`tests/native-selection-probe.test.mjs` and `tests/store-gc-race.test.mjs` were
added after this suite started and are not included in the 420 count.

| Classification | Count | Tests / evidence |
| --- | ---: | --- |
| `TEST_INFRA_FAILURE` | 9 | Seven Viewer tests still fail before/at editing readiness because their mock host omits the 0.7 source-identity confirmation (annotation creation, narrow-pane toolbar, FreeText AP appearance, iPad pointer, trusted mouse, open-lifecycle save preflight, and underline geometry); both `mobile-browser-startup` cases fail browser teardown, described below. |
| `TEST_PRECONDITION_FAILURE` | 2 | iOS autosave still times out waiting for a first save after an empty-store `annotationStorage.onModified()` signal; the cleanup test's post-release Windows PID-liveness oracle also fails to establish fixture-descendant exit. |
| `PRODUCT_FAILURE` | 2 | Obsidian autosave controlled-close and FreeText sidecar capture/self-echo hydration. Current artifacts retain the failed close acknowledgement and the zero-geometry FreeText raw-save boundary respectively. |
| `STALE_OLD_ORACLE` | 1 | Sync bridge still fails the old assertion that a sidecar checkpoint return a PDF `ArrayBuffer`; the artifact contains a dirty Square operation but zero PDF bytes. |

### Item-by-item comparison with 409/391/13

The following 13 failures have the same test names as the previous 409-test
run. Their elapsed times and browser cleanup details vary, but no additional
product conclusion follows from those timing differences:

1. `annotation creation tools take priority over existing markup only while
   creating` — `TEST_INFRA_FAILURE`; same source-confirmation mock gap.
2. `iOS auto-save waits for idle and cooldown, then writes only the latest
   revision` — `TEST_PRECONDITION_FAILURE`; same 8-second first-save wait on an
   empty-store synthetic dirty signal.
3. `Obsidian auto-save debounces complete edits and serializes revisions` —
   `PRODUCT_FAILURE` (unresolved synthetic browser close/save path). Current
   `autosave-failure-1792026649455.json` records `prepare-close-ime` as
   `prepared:false`, `ok:false`, `dirty:true`, `recovered:false`, and
   `annotationBatchDurable:false`; its runtime tail also records capture
   `status:"ok"` followed by encode `status:"error"`. Keep this separate from
   the empty-store iOS precondition failure.
4. `narrow Obsidian panes keep PDF tools, popups, and the secondary menu inside
   the viewport` — `TEST_INFRA_FAILURE`; same missing source-identity response
   before the toolbar-enabled wait.
5. `saved FreeText AP stays visible across NONE-mode right-eraser undo and
   redo` — `TEST_INFRA_FAILURE`; same unconfirmed editable host path before the
   selected-editor wait.
6. `iPad policy routes finger scrolling separately from PDF.js editor and
   mouse input` — `TEST_INFRA_FAILURE`; same source-identity handshake gap
   before the mode assertion.
7. `release real browser without Node: mobile PDF/save/reopen (resource
   imports)` — `TEST_INFRA_FAILURE` in teardown, not evidence of a mobile
   resource-import defect. Both runs timed out in `browser.close` after 20 s.
   The prior artifact (`mobile-browser-startup-1792025915898.json`) shows
   forced SIGTERM; the phase-timing artifact
   (`mobile-browser-startup-1792026711710.json`) also shows forced SIGTERM.
   Both report `releasedExitedProcessPipes:true` and
   `detachedStreamsAfterFailure:false`.
8. `release real browser without Node: mobile PDF/save/reopen (forced Blob
   fallback)` — `TEST_INFRA_FAILURE` in teardown, not evidence against the
   fallback. Previously `browser.close` timed out but the process exited 0
   without termination (`mobile-browser-startup-1792025962721.json`), leaving
   cleanup status `failed`. In the new run the same 20 s close timeout required
   SIGTERM and cleanup status is `forced`
   (`mobile-browser-startup-1792026769490.json`). The new record still shows
   pipes released and no detached streams. Thus these two mobile teardown
   records remain failures, with the second run now requiring forced process
   cleanup in both cases.
9. `trusted browser mouse input keeps PDF.js wheel, annotation, and click
   controls consistent` — `TEST_INFRA_FAILURE`; same missing source identity
   before the annotation-mode wait.
10. `PDF open waits for its own document readiness and cancels on renderer
    disposal` — `TEST_INFRA_FAILURE`; lifecycle preflight observations are not
    the failing point; the later save wait remains blocked by the mock host's
    missing source-confirmation handshake.
11. `FreeText sidecar capture keeps geometry and self-echo hydration adopts
    the live editor` — `PRODUCT_FAILURE` (unresolved browser raw-save boundary).
    Current artifact `sidecar-freetext-hydration-failure-1792026666392.json`
    shows `sourceConfirmed:true`, but at save time the live rect is zero-area,
    storage rect/value are empty, no save/sidecar operation is produced, and
    the host reports no measurable editor rectangle.
12. `sync bridge keeps UUID operations across saves and applies a prepared
    checkpoint in place` — `STALE_OLD_ORACLE`; the current failure artifact
    still shows a valid dirty Square operation and `byteLength:0` at the
    assertion requiring a PDF `ArrayBuffer`. The later durable-ACK/reject and
    conflict assertions are not reached by this run.
13. `underline selection geometry stays single-stroke across text runs and
    columns` — `TEST_INFRA_FAILURE`; same mock-host source-identity gap before
    the underline geometry interaction is reached.

### Additional cleanup fixture failure in the 420-test run

`browser cleanup releases owned pipes after natural exit and CDP disconnect`
failed at `browser-test-cleanup.test.mjs:894`, with the assertion
“the unowned fixture descendant must exit on its own within the bound”
(`waitForPidExit(grandchildPid, 2500) === false`). This differs from the older
406-test run's line-853 failure, which observed the simulated descendant
already dead at close observation; the test passed in the intervening
409-test run. In the current run, all preceding assertions in this test passed:
cleanup reported `normal`, the owned child exited naturally with code 0, the
descendant was alive at the pre-release close observation, the pipe-release
flag was true, and `report.errors`/termination were empty. Only the synthetic
descendant's post-release exit wait failed. The captured failure does not
demonstrate an owned-pipe-release product failure. On Windows, the fixture's
`pidIsAlive` oracle treats a successful `process.kill(pid, 0)` as alive without
revalidating process identity, so the available output cannot distinguish a
still-running fixture descendant from a stale/reused PID. Classify this as
`TEST_PRECONDITION_FAILURE` (Windows fixture-liveness oracle) unless a
process-identity-verified artifact shows otherwise. This preserves the
four-class failure taxonomy used for this acceptance review.

## 2026-10-15 materialization-geometry frozen full-suite comparison

Read-only comparison of
`tests/artifacts/sidecar-materialization-geometry-full-suite.stdout.log` and
`.stderr.log` with the immediately preceding 420-test phase-timing run above.
The current run reports **426 tests: 407 passed, 14 failed, 5 skipped, 0
cancelled** (`147221.9884 ms`, exit 1); stderr is empty. Relative to 420/401/14,
the count is +6 tests and +6 passes, with 14 failures and 5 skips unchanged.
Five newly present cases passed (`native selection probe` and four GC queue /
readDocument race tests). The sixth new case,
`real FreeText sidecar hydration preserves geometry at every rotation and
scale`, completed its test body but failed cleanup: the only reported error is
`Puppeteer browser.close exceeded 20000 ms`, wrapped as a cleanup
`AggregateError`; the current run has no corresponding geometry assertion
failure artifact. Its cleanup report records released pipes and no detached
streams. Do not use
`sidecar-freetext-geometry-failure-1792027655552.json` to claim a geometry
regression in this run: that is a 09:27 pre-run baseline artifact, not evidence
from the 09:32 full suite. This new failure is `TEST_INFRA_FAILURE`.

One prior failed case now passes:
`release real browser without Node: mobile PDF/save/reopen (resource imports)`.
The failed `mobile PDF/save/reopen (forced Blob fallback)` case remains a
teardown failure requiring forced cleanup. The other 13 failing test names
overlap the prior run; the owned-pipes fixture has the same test name but a
different failure point, detailed below. Thus the failure count is stable
because one prior mobile teardown failure left the set while the new geometry
test's browser-close cleanup failure entered it—not because all failed
assertions were unchanged.

| Classification | Count | Current evidence |
| --- | ---: | --- |
| `TEST_INFRA_FAILURE` | 9 | Seven Viewer cases still stop before their intended editing assertions because their mock hosts do not answer the 0.7 source-identity confirmation; the forced-Blob mobile browser teardown needs external cleanup; the new FreeText geometry test body is followed only by a 20-second browser-close timeout. |
| `TEST_PRECONDITION_FAILURE` | 2 | iOS autosave still waits for a save after an empty-store `annotationStorage.onModified()` signal. The owned-pipes fixture now fails at `browser-test-cleanup.test.mjs:872`, where `profileIdentityValidatedAtStart` is false; it has not reached the later pipe-release assertions, so this is a Windows fixture process-identity oracle failure, not evidence that owned-pipe release failed. |
| `PRODUCT_FAILURE` | 2 | Obsidian autosave controlled close and FreeText raw-save capture/self-echo hydration remain unresolved browser-harness product-path failures, with current-run artifacts cited below. |
| `STALE_OLD_ORACLE` | 1 | Sync bridge still requires a PDF `ArrayBuffer` from an ordinary sidecar checkpoint; current artifact records a valid dirty Square operation and zero PDF bytes. |

The two `PRODUCT_FAILURE` records remain distinct from the FreeText geometry
test's cleanup failure. `autosave-failure-1792027964363.json` records the
`prepare-close-ime` response as `prepared:false`, `ok:false`, `dirty:true`,
`recovered:false`, and `annotationBatchDurable:false`; the runtime tail reports
capture `status:"ok"` followed by encode `status:"error"`. The current
`sidecar-freetext-hydration-failure-1792027996627.json` records
`sourceConfirmed:true`, no save or sidecar operation, and host rejection
because the captured FreeText editor has no measurable rectangle at the raw
save boundary. Preserve both failure assertions and keep them separate from
the iOS empty-store precondition.

The cleanup fixture's prior 420-run failure was the post-release descendant
exit/liveness wait at line 894. In this run it instead fails earlier at the
profile-identity gate (line 872; `false !== true`), before the test reaches its
explicit owned-stream assertions. This changes the Windows fixture oracle
failure detail; it does not justify a claim about product pipe handling.

## 2026-10-15 priority-buffer frozen full-suite comparison

Read-only triage of
`tests/artifacts/sidecar-priority-final-full-suite.stdout.log` and `.stderr.log`
against the 426-test materialization-geometry run above. This run reports
**427 tests: 409 passed, 13 failed, 5 skipped, 0 cancelled** (`146667.4934 ms`,
exit 1); stderr is empty. Relative to 426/407/14, this is +1 test, +2 passes,
and -1 failure, with skipped and cancelled counts unchanged. The added passing
case is `reserved log capacity retains ten encode timings under ordinary trace
pressure`. Two earlier failures now pass: `browser cleanup releases owned
pipes after natural exit and CDP disconnect` and the mobile forced-Blob
fallback. Conversely, the mobile resource-import scenario failed teardown in
this run, replacing the forced-Blob teardown failure; its 09:45 artifact is
`mobile-browser-startup-1792028746523.json`. The FreeText geometry case remains
in the failure set only as a cleanup timeout. Runtime differences are not
treated as performance evidence.

| Classification | Count | Current evidence |
| --- | ---: | --- |
| `TEST_INFRA_FAILURE` | 9 | Seven Viewer tests remain blocked before their editing assertions by mock-host source-identity/readiness gaps; the mobile resource-import test reaches its save/reopen checks but browser teardown times out and requires SIGTERM; the FreeText geometry test reports only a browser-close cleanup timeout. |
| `TEST_PRECONDITION_FAILURE` | 1 | iOS autosave still waits for a first save after the fixture only signals `annotationStorage.onModified()` on an otherwise empty store, without creating a durable annotation operation. |
| `PRODUCT_FAILURE` | 2 | Autosave controlled-close still returns an unsuccessful dirty/unrecovered prepare-close result; FreeText raw-save capture/self-echo still fails to capture a measurable editor rectangle. |
| `STALE_OLD_ORACLE` | 1 | Sync bridge still asserts that an ordinary sidecar checkpoint return a PDF `ArrayBuffer`; its current failure artifact records zero PDF bytes. |

The seven Viewer/mock-host failures are `annotation creation tools take
priority over existing markup only while creating`, `narrow Obsidian panes
keep PDF tools, popups, and the secondary menu inside the viewport`, `saved
FreeText AP stays visible across NONE-mode right-eraser undo and redo`, `iPad
policy routes finger scrolling separately from PDF.js editor and mouse
input`, `trusted browser mouse input keeps PDF.js wheel, annotation, and click
controls consistent`, `PDF open waits for its own document readiness and
cancels on renderer disposal`, and `underline selection geometry stays
single-stroke across text runs and columns`. Their current run still times out
before the targeted editing/save assertions; the current annotation artifact
records `annotation-source-identity` received without a corresponding
confirmation, and the underline artifact remains in its initial text/layer
wait phase.

The mobile-resource teardown artifact records the intended path completing its
functional checks: mobile boot and Viewer readiness, 26 annotation writes,
unchanged source SHA-256 with zero source-PDF writes, resource-loaded bridge /
PDF.js / Viewer modules with no resource failure, a hydrated editor, and one
Square after reopen. The test is nevertheless failed because `browser.close`
exceeded 20 seconds and cleanup required SIGTERM; the report shows released
process pipes and no detached streams. By contrast,
`mobile-browser-startup-1792028778390.json` is the forced-Blob fallback from
this same run and records `status:"passed"` with normal cleanup.

The current geometry-test stdout entry at
`sidecar-freetext-geometry.test.mjs:52` is an `AggregateError` from
`attachCleanupErrors`, with the only nested error `Puppeteer browser.close
exceeded 20000 ms`; cleanup reports released pipes and no detached streams.
This run emitted no `FreeText geometry regression evidence` artifact, so it
does not establish a geometry assertion failure. The `FreeText sidecar
regression evidence` path printed immediately afterward,
`sidecar-freetext-hydration-failure-1792028685208.json`, belongs to the
separate `sidecar-freetext-hydration.test.mjs` raw-save case, not the geometry
test. Do not use the older 09:27 geometry baseline artifact for this run.

The two current `PRODUCT_FAILURE` artifacts remain separate from teardown.
`autosave-failure-1792028656755.json` records `prepare-close-ime` as
`prepared:false`, `ok:false`, `dirty:true`, `recovered:false`, and
`annotationBatchDurable:false`, with a trailing encode timing status of
`error`. `sidecar-freetext-hydration-failure-1792028685208.json` records
`sourceConfirmed:true`, no save/sidecar operations, and host rejection because
the FreeText editor has no measurable rectangle at the raw-save boundary.
The sync-bridge failure remains the old checkpoint-byte oracle, not evidence
that its later durable-ACK / conflict checks passed or failed.
