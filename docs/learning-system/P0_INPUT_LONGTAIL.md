# P0 input long-tail: paired unprofiled evidence

## Finding

Across the six predeclared A/B runs, each of the three input sequences was captured in all six runs. All 18 sequence captures have `diagnosticCollectionStatus: complete` and zero entries in `acceptanceAssertionFailures`. The strict per-event timing checks therefore recorded no failure of the existing 80 ms limits in these captures.

That is not a blanket PASS for the whole test: B trial 2 (B2) remains a failed test run. After all three diagnostic sequences had completed, a later readiness wait failed with `Waiting failed: 12000ms exceeded`. The failure is preserved below; the zero sequence-failure count does not erase it.

## Evidence and conditions

The paired order was A1, B1, A2, B2, A3, B3. A is `origin/main` at `b6b178dc142b6900fa7b4bbdd7d23c5f4d0bc96c`; B is `feature9c361330` at `9c361330388cbc929ef76bcc53b83f49a7360c04`. Both the implementation and served runtime asset SHA matched the corresponding candidate in every report.

All six used the same generated 14-page PDF fixture, SHA-256 `47202ac014f28b778fa430483bb3efcd0ac485654c2d70a5590da48fe0a740d9`, Chrome `155.0.8059.85`, and PDF.js bundle version `5.7.192`. They were headless Chromium runs with a 1180×920 viewport, mobile/touch emulation enabled, and `physicalDevice: false`; these are not physical iPad or Apple Pencil measurements. Each report records the runtime asset map and hashes. The common fixture and browser settings make the six reports directly paired at the harness level, not a controlled CPU profile comparison.

Bridge source and served bridge hashes recorded in the reports:

| Candidate | bridgeSourceSha256 | servedBridgeSha256 |
| --- | --- | --- |
| A | `756f63e5faba06b5bc443d5203b8ea54486310f958bc3ba4a7dae5dabf479629` | `6da33a62ae3f1e63f73310f159bc0a11a74d504853537f9d3e46955e3d290cb6` |
| B | `2cf846d23e447c2acdeb9afec3f59dc2e7a6afd573dcace5072399d681215fe8` | `2a6f68316dd669b683c494253f7688e73de1d21303c70138bf45171ab21ab509` |

The six source reports are:

```text
tests/artifacts/ipad-pointer-policy-1792670935854-43832.json  A1
tests/artifacts/ipad-pointer-policy-1792671013328-38588.json  B1
tests/artifacts/ipad-pointer-policy-1792671066941-2168.json   A2
tests/artifacts/ipad-pointer-policy-1792671096497-13024.json  B2 (overall test failure retained)
tests/artifacts/ipad-pointer-policy-1792671199360-55020.json  A3
tests/artifacts/ipad-pointer-policy-1792671240858-19324.json  B3
```

The later `ipad-pointer-policy-1792675015845-56116.json` artifact is not one of these six paired runs and is excluded from these comparisons.

## Fixed sequences and strict timing results

The predeclared sequence plan reuses the existing `ipad-pointer-policy` fixture and scenes:

| Sequence | Contact and fixed input | End measurement |
| --- | --- | --- |
| `gesture21-fast-flick` | Finger pointer 21; 260 px; four scheduled samples at 0, 22, 44, and 65 ms | Visible-page render state, two 120 ms inertia samples, then settled scroll |
| `gesture25-to-26-toolbar-contact` | Finger pointer 25; 180 px at the same schedule; pointer 26 contacts `#editorInkButton` 80 ms after release | Scroll sampled 300 ms after toolbar contact |
| `gesture27-to-pencil-contact` | Finger pointer 27; 180 px at the same schedule; CDP-simulated pen contacts `#editorInkButton` 70 ms after release | Scroll sampled 300 ms after simulated pen contact |

The existing checks still require the trusted down/move/up sequence, viewer targeting, scheduled event offsets, full movement distance, and event timing. In particular, each event must have `observedAt - timeStamp <= 80 ms`; timestamp and observed-time gaps must also be at most 80 ms. The table reports maxima calculated from the three exact `trustedTimedFingerGestures[].observed` arrays in each JSON report:

| Run | Captures | Sequence assertion failures | Max dispatch delay | Max timestamp gap | Max observed gap | Long Tasks during the three sequences | Whole test result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A1 | 3/3 | 0 | 39.6 ms | 22.0 ms | 40.2 ms | 0 | Completed |
| B1 | 3/3 | 0 | 38.2 ms | 22.0 ms | 39.8 ms | 0 | Completed |
| A2 | 3/3 | 0 | 36.7 ms | 22.1 ms | 41.1 ms | 0 | Completed |
| B2 | 3/3 | 0 | 38.5 ms | 22.0 ms | 34.3 ms | 0 | **Failed later readiness wait; retained** |
| A3 | 3/3 | 0 | 37.8 ms | 22.1 ms | 41.3 ms | 0 | Completed |
| B3 | 3/3 | 0 | 40.4 ms | 22.0 ms | 47.3 ms | 0 | Completed |

All 72 scheduled pointer events (18 captures × 4 events) were recorded as trusted and targeted inside the viewer. Every per-sequence start/end snapshot reported the document visible and focused; visible page records were loaded with text layers ready. Gesture 21 started on page 5 and ended on page 7 in A1/B1/B2/A3 and page 12 in A2/B3. Gesture 25 moved from page 1 to page 2; gesture 27 started and ended on page 2. Render-event counts were 4/16/4 for A1/A2/A3 and 4/4/16 for B1/B2/B3 in gesture 21; gesture 25 recorded zero additional render events in all six, and gesture 27 recorded two only in A2. These are the observed render/event counts, not additional acceptance thresholds.

### Preserved B2 failure and interpretation boundary

B2's three sequence captures completed with zero sequence assertion failures. The overall report nevertheless has `failure.message: "Waiting failed: 12000ms exceeded"` in a later second-viewer/readiness phase. Its captured failure state was hidden and unfocused, and the report also contains three Long Task entries (63, 54, and 103 ms) in that later failure-state sample; these are not part of the three sequence-local Long Task arrays or the 80 ms gesture assertion result.

A subsequent read-only setup review found a plausible harness precondition issue: PDF.js view history for the same PDF fingerprint can restore a newly opened viewer to page 3, while the later setup path waits for page-1 text-layer readiness before explicitly navigating to page 1. Explicitly selecting page 1 and verifying `currentPageNumber === 1` before retaining the original readiness assertion is a useful setup correction. It is not proof that this caused B2, is not evidence that CPU was the cause, and does not turn B2 into a pass. Do not replace or omit the B2 artifact.

## Simulated Pencil-contact residual scroll

The 27→simulated-pen sequence records distinct post-contact residuals. `Remaining` is `scrollTop after 300 ms - scrollTop after pen contact`; positive values mean scrolling continued after the simulated pen tap ended.

| Run | At finger release | At simulated pen contact | At +300 ms | Remaining after contact |
| --- | ---: | ---: | ---: | ---: |
| A1 | 1322 | 1680 | 1762 | **+82 px** |
| B1 | 1384 | 1701 | 1701 | 0 px |
| A2 | 1383 | 1721 | 1784 | **+63 px** |
| B2 | 1452 | 1822 | 1822 | 0 px |
| A3 | 1365 | 1702 | 1702 | 0 px |
| B3 | 1301 | 1639 | 1639 | 0 px |

Keep the A1/A2 residuals visible in any summary; the paired results are not uniformly zero. The follow-up contact is CDP `pointerType=pen`, not hardware Apple Pencil, and these six unprofiled samples do not establish a general performance or physical-device result.

## Diagnostic behavior and CPU profile follow-up

`PDF_READER_LEARNING_RELIABILITY_DIAGNOSTICS=1` opts into the passive probe and report fields. It does not dispatch input or change the 80 ms threshold, and the threshold assertion remains unchanged. In diagnostic mode, assertion errors for the three predeclared sequence groups are collected so the later planned sequences can still be captured; the test then strictly asserts `acceptanceAssertionFailures` is empty. The default path without the opt-in keeps immediate assertion throwing. No timeout was increased, no assertion was skipped, and no failure was selected away.

These six reports are all `paired-primary-unprofiled`; they contain no CPU profile. After a Browser lease is available, the exact separate diagnostic command below profiles only B's gesture 21. It is intentionally not part of the paired timing evidence, and any profile-overhead timing/assertion failure must remain separately labeled rather than used to replace an unprofiled result. This command is provided for the next authorized lease; it was not run while the lease was unavailable:

```powershell
$env:PDF_READER_LEARNING_RELIABILITY_DIAGNOSTICS = '1'
$env:PDF_READER_LEARNING_VARIANT = 'B'
$env:PDF_READER_LEARNING_GIT_SHA = '9c361330388cbc929ef76bcc53b83f49a7360c04'
$env:PDF_READER_LEARNING_ASSET_GIT_REF = '9c361330388cbc929ef76bcc53b83f49a7360c04'
$env:PDF_READER_IPAD_CPU_PROFILE = '1'
$env:PDF_READER_IPAD_CPU_PROFILE_ID = '21'
Remove-Item Env:PDF_READER_LEARNING_PAIR_TRIAL -ErrorAction SilentlyContinue
node --test --test-name-pattern 'iPad policy routes finger scrolling separately from PDF.js editor and mouse input' tests/ipad-pointer-policy.test.mjs
```

## Executed separate B gesture-21 CPU diagnostic (2026-10-22)

The exact PowerShell diagnostic command above was executed **once**, with the exclusive Browser lease, against archived B assets at `9c361330388cbc929ef76bcc53b83f49a7360c04`. Exit code was **1** (1 test, 0 passed, 1 failed; 29,325.4082 ms total). No rerun, build, install, timeout change, or 80 ms assertion change was made. All three diagnostic sequences completed, but four preserved gesture-21 dispatch-delay assertions failed. This remains a failed `separate-cpu-profile` run and does not replace any of the six `paired-primary-unprofiled` results or the retained B2 failure.

The unchanged report is `tests/artifacts/ipad-pointer-policy-1792677046648-21868.json` (SHA-256 `a6908eeb58e5e93a730bb35ef7de7030cf32b2386bae7568aff3eeecd9d33f10`). Launch/cleanup records remain under `tests/artifacts/browser-launch-ipad-pointer-policy-1792677046713-21868-skRLNK/`. Runtime SHA, served bridge hash, fixture hash, Chrome version and emulation match B above. Browser cleanup completed normally; Chrome exited 0 and the server closed.

Gesture 21's four trusted viewer-targeted events retained delays of **169.4, 170.3, 178.7 and 187.8 ms**. Timestamp gaps were 22.0, 21.9 and 21.0 ms; observed gaps were 22.9, 30.3 and 30.1 ms. Critically, `beginFastTouchDrag` obtains `baseTimestamp` **before** awaiting `Profiler.enable`, `Profiler.setSamplingInterval` and `Profiler.start`. First dispatch began 158.659 ms after its planned event epoch; its CDP acknowledgement took 10.302 ms. Subsequent dispatch acknowledgements were 7.626, 7.152 and 7.448 ms. These records show a large pre-dispatch offset in this instrumented run, consistent with profiler-startup overhead contaminating the old timestamp; they do not identify a production input-handler stall or establish the precise division of debugger, scheduler and native work.

The captured CPU summary covers 296.142 ms and 111 samples. Leading self-sample buckets are `(program)` 189.299 ms (26 samples), `(idle)` 84.506 ms (73), `runAnnotationObserver` 7.513 ms (1, bridge zero-based line 12011), `getVisibleElements` 3.714 ms (2), and `isElementBottomAfterViewTop` 2.061 ms (1). `startNativeTouchPointer` has one 1.143 ms sample. These sparse leaf buckets, especially the unsymbolized `(program)` bucket, do not establish an optimization target or prove `runAnnotationObserver` caused the delay.

Gesture 21 has zero sequence-local Long Tasks, 199 RAF samples, and one maximum RAF gap of **157.6 ms**, from timestamp 13123.4 to 13281.0, before the first observed event at 13284.2. It records four render events and visible/focused start/end states (page 5 to 7). Thus zero Long Tasks does not mean uninterrupted frame delivery during profiler startup. Gesture 25 and 27 also have zero Long Tasks; their maximum RAF gaps are 12.2 and 18.3 ms (83 and 101 samples), and neither has additional render events. Their maximum event dispatch delays are 21.9 and 31.2 ms, with no preserved acceptance failure for either sequence.

Artifact limitation: the existing exact command's harness reduces the CDP `Profiler.stop` result to `durationMs`, `sampleCount` and `topFrames`; it does **not** persist raw `nodes`, `samples`, `timeDeltas` or a `.cpuprofile`. The original failed JSON and its available profile summary are preserved, but a raw call-tree profile is unavailable from this run. No fabricated raw profile or success-selecting rerun was produced. The previous six unprofiled runs remain the timing evidence; this single instrumented failure supplies a harness/profiler-overhead diagnosis with the attribution limits above. Windows Native, physical iPad/Apple Pencil and real Sync are **NOT_RUN** here. Browser lease released after normal cleanup.

## Separate P0 workstream

The six A/B reports above precede the later P0 Square interaction/source-guard work. Parent-reported follow-up state is: a minimal bridge wrapper fix, Browser 1/1, packaging 4/4, offline PASS, and installed test-vault main SHA-256 `78c842df1ee3806277983fced3dc3e0cf01137960a59d577cf1925a53ac2b563`. That workstream is not an 80 ms input optimization and made no `InputRouter` change; its results must not be blended into or used to reinterpret these paired long-tail measurements.
