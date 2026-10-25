# ObReader 0.14 candidate status

## Git and release boundary

- Latest fetched `origin/main`: `833397ad2e78bba35e4490d3810ac73783860856`.
- Latest fetched `origin/feature/0.14-native-learning-dictionary-20261023`: `6694c16b4c390d4a8dbd7762ec647ffa13f8f909`.
- Integration branch: `codex/014-resource-v3-integration`; evidence baseline commit `e81b469ea862a4f76d39161ce99af25d42405fe7` contains the latest feature branch and the Native harness/SemanticAnchor audit commits. The Resource-v3 code commit is `6ea2ca23a106e4fa0dfcf6dbeaaab2f9c8f90ea5`.
- `main` remains unchanged. The formal vault was not deployed or modified.
- Candidate version: `0.14.0`. The current built/deployed `main.js` SHA-256 is `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`.

## Scope decision

- `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`. No reproducible root cause was established for the user's 120-page OCR PDF. Stop the scroll-specific investigation; do not modify PDF.js, wheel handling, observers, or LingQ scroll paths unless that exact PDF becomes reproducible.
- Native closeout is bounded: an isolated, official Obsidian 1.14.5 test process is now visible and focused, and its Native DataAdapter dictionary lookup has been measured. Do not run the 8×5 mutation matrix while other Obsidian processes still share the test Vault. Keep `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED` and `REAL_PROCESS_RESTART_8x5 = NOT_RUN`; do not relabel either from earlier-package or partial UI receipts. Proceed with Resource-v3 evidence and report the remaining Native gap.
- `SemanticAnchorContractV1`, Sidebar and Backlink source/API contracts are frozen at the code and deterministic-test level; full Native route acceptance remains pending and is not implied by that source-level freeze.
- iPad remains `DEFERRED_BY_SCOPE`; synthetic mobile timing is not iPad evidence.
- Bulk import prototypes are rejected by their stated production gate; FSRS stays development-only; SQLite/OPFS remains an isolated experiment and has no qualifying app-origin result.

## Resource-v3 conversion and lookup

The verified resource-v2 source converted to `770,611` equivalent rows in `67` content-addressed blocks (`16,769,142` compressed bytes). A temporary conversion was byte-identical to the installed Resource-v3 blocks. The manifest records the MIT notice at `../LICENSE-MIT.txt` and checksum `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f`.

The latest lookup run used the real macOS Obsidian DataAdapter in `ObReader-Apple-Test`; the plugin was disabled and Reader leaves were closed. It ran five new dictionary/Worker instances per query and 20 resident repeats each. Reads were limited to DataAdapter `read`/`readBinary`; there were zero Vault writes. Each cold observation reads one relevant compressed block; the new IndexedDB caches use unique disposable names and are removed after each trial.

| Query | First lookup P50 | P95 / max of 5 | Warm lookup P95 | First-read bytes |
|---|---:|---:|---:|---:|
| Common `on` | 118.4 ms | 407.8 ms | ≤0.1 ms | 262,366 per cold trial |
| Rare `zyzzyva` | 92.7 ms | 191.0 ms | ≤0.1 ms | 139,005 per cold trial |
| Valid not-found | 115.8 ms | 117.3 ms | ≤0.1 ms | 236,616 per cold trial |

The first common and rare lookup targets pass for these Native DataAdapter samples; this is not a process-cold measurement. Every resident repeat hit the bounded in-memory block cache. `startup added blocking = NOT_MEASURED`; startup schedules an unawaited availability check in source, but that code inspection is not a timing measurement. The harness injects the standalone dictionary module and does not exercise enabled-plugin Host/Reader wiring. Keep Resource-v3 as the candidate without claiming the startup gate passed.

Current-package raw trials: [native-data-adapter-benchmark-current-package-20261025.json](native-data-adapter-benchmark-current-package-20261025.json). Earlier module run: [native-data-adapter-benchmark-20261025.json](native-data-adapter-benchmark-20261025.json).

A fresh five-trial repeat was run against the earlier test Vault renderer after the Native owner-gate closeout. Each trial used a new dictionary instance and Worker, with 20 warm repeats per term; each cold case read exactly one Resource-v3 block. Across the 5 cold samples, common `on` was 173.7 ms P50 / 400.9 ms observed max, rare `zyzzyva` was 121.8 ms P50 / 142.8 ms max, and a valid miss was 125.3 ms P50 / 226.7 ms max. Across 100 warm repeats per term, P95 was 0.1 ms for common, rare, and miss; maximum was 0.4 ms. A later inspection found that renderer's actual runtime was 1.12.7 despite its window title reporting 1.14.5, below the candidate's `minAppVersion: 1.14.4`; those earlier samples are diagnostic-only and do not pass the supported-runtime gate. Raw receipt: [native-data-adapter-benchmark-latest-20261025.json](native-data-adapter-benchmark-latest-20261025.json).

### Supported Obsidian 1.14.5 Native DataAdapter rerun

To resolve the runtime mismatch without replacing the installed Obsidian app or touching the formal vault, the official signed/notarized 1.14.5 app was started from a read-only mounted DMG with a separate user-data profile. Its CDP User-Agent reported `obsidian/1.14.5`, Electron `43.8.3`; the visible renderer reported exact `ObReader-Apple-Test` path/name, `document.hasFocus() === true`, `activeDocument === document`, Sync disabled, the candidate plugin disabled, and zero Reader leaves. The existing candidate package stayed byte-identical. The Native benchmark used the actual Obsidian DataAdapter and read-only `read`/`readBinary` wrappers; it ran five new dictionary instances and Workers per term with 20 resident repeats each. Every cold query read exactly one Resource-v3 block; total Vault writes were zero.

| Query | First lookup P50 | P95 / observed max (5 cold samples) | Warm P95 | First-read bytes |
|---|---:|---:|---:|---:|
| Common `on` | 170.2 ms | 1,154.8 ms | ≤0.1 ms | 262,366 |
| Rare `zyzzyva` | 88.9 ms | 194.3 ms | ≤0.1 ms | 139,005 |
| Valid not-found | 146.6 ms | 189.6 ms | ≤0.1 ms | 236,616 |

Rare-word lookup and warm lookup meet the numerical targets in this actual supported Obsidian runtime. The first common-word sample had a 1.155 s outlier; keep it visible rather than averaging it away. These are new-instance/Worker measurements inside an already running Obsidian process. They do **not** measure cold process start, plugin-added startup blocking, enabled-plugin Host/Reader wiring, or first lookup through the Reader UI. Therefore `first rare lookup <1 s = PASS for this measured DataAdapter scope`; `startup added blocking <50 ms = NOT_MEASURED`; full Resource-v3 release acceptance remains incomplete. No Vault writes occurred. The app's first-open trust prompt was resolved with Safe Mode; no community plugin was enabled. Because other Obsidian processes still share the same test Vault (one also has the formal vault open), I stopped before any plugin activation or Native data mutation. Raw receipt: [native-data-adapter-benchmark-1.14.5-20261025.json](native-data-adapter-benchmark-1.14.5-20261025.json). Runtime binary, signature, mount and foreground-identity evidence: [obsidian-1.14.5-runtime-verification-20261025.json](obsidian-1.14.5-runtime-verification-20261025.json).

### Current-package Native Host probe

A follow-up probe exercised the installed 0.14.0 plugin's real `getVocabularyDictionary().lookup()` path in the existing `ObReader-Apple-Test` vault. Obsidian Sync was disabled, no Reader leaves were open, and the plugin remained disabled in the persisted enabled-plugin list before and after the probe. The actual Host read the Vault manifest and only the matching common/rare Resource-v3 blocks; it did not read the full dictionary or wait for a full Dexie build.

| Query | First lookup | 20 resident repeats |
|---|---:|---:|
| Common `on` | 206.4 ms | max 0.3 ms |
| Rare `zyzzyva` | 36.9 ms | max 0.3 ms |
| Valid not-found | 0.1 ms | max 0.3 ms |

The browser timer quantized many warm samples to 0.0 ms, so the maximum is reported conservatively; it is not a precision sub-millisecond benchmark. The single current-Host rare lookup is below 1 second. This is a real Native Host sample, not a Reader UI lookup, multi-device Sync test, or cold-process startup measurement.

The plugin manager's runtime `enablePlugin()` invocation took 623.2 ms and the same observation window recorded one 73 ms Long Task. This includes the whole plugin activation path and does **not** isolate Resource-v3 or measure the incremental delay of process startup; treat it as a signal to keep startup blocking explicitly unverified, not as a Resource-v3 regression attribution. `startup added blocking <50 ms = NOT_MEASURED`.

Before/after content audits found the existing PDFData tree unchanged (124 files, 3,433,916 bytes), VocabularyData unchanged (71 files, 33,531,219 bytes), plugin `data.json` unchanged, enabled-plugin list unchanged, and probe PDF SHA-256 unchanged (`53ade40ce75c07455bd1d5a3829c5dd8efe925a65f1b5a54de756a9bea9dd378`). One diagnostic log was written in the test plugin's `.logs` directory. Detailed sanitized receipt: [native-host-probe-current-package-20261025.json](native-host-probe-current-package-20261025.json).

### LRU capacity decision

The required 8/16/32 comparison is now present as an isolated product-runtime experiment, but it uses a Node filesystem adapter and synthetic traces rather than a Native Vault or recorded user trace. At the production candidate's current 8 MiB byte limit, **all 8/16/32 count caps were byte-evicted to the same effective 5–6 blocks**. Repeated 6/12/24/67-block working sets had 0 resident hits for every cap because each miss performed the actual checksum, gzip, JSONL parse and decode. Raising the byte limit to 128 MiB exposed count behavior: the minimum cap retaining the synthetic 6/12/24 block working sets was 8/16/32, respectively; none retained the 67-block trace. This does not identify a universal user-optimal capacity.

Do not change the current `16 blocks / 8 MiB` default from this evidence. Treat it as **provisional and unvalidated**, not as the selected optimum. The Native Host repeated-same-term sample validates a resident block hit, not the cross-block LRU workload. A representative lookup trace and Native memory/latency evidence are still needed to freeze the cache budget. Full 24-cell result and reproducible harness: [LRU audit](../014-resource-v3-startup-audit/README.md).

The same audit measured 500 Node Dexie/schema constructions (p50 0.0388 ms, p95 0.1748 ms, max 2.415 ms) and module first-require at 20.74 ms including all dependencies. These are diagnostic-only results, not Native startup measurements. Resource-v3 successful lookups do not issue Dexie table reads or full-generation imports, but Dexie remains a constructor/module dependency. `startup added blocking <50 ms` remains **NOT_MEASURED**.

## Current-package Native Learning Loop

The exact 0.14.0 three-file package was deployed to `ObReader-Apple-Test` after backing up the previous plugin directory to `.deploy-backups/2026-10-24T21-20-00-515Z/pdf-web-reader`. The deployed files matched the build:

| File | SHA-256 |
|---|---|
| `main.js` | `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8` |
| `manifest.json` | `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675` |
| `styles.css` | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` |

The current-package Native runner was repeated after that earlier partial timeout. On the exact v0.14.0 package, both real UI learning flows passed:

- Highlight UUID `955a4e69-c4da-4860-85c3-0551a1dceeda` → durable isolated Sidecar → Annotation Sidebar → Add to Review → Today Review → Source, with accepted navigation request `reader-nav-1-1` returning to the same annotation UUID.
- LingQ status → exact phrase `Dynamic languages` → Context → Add to Review → Today Review → Source, with accepted request `reader-nav-1-2` returning to the exact selection anchor.

The runner then stopped at the Markdown-source stage because Puppeteer could not open a visible Obsidian Command Palette from its CDP click/shortcut path. It did not reach the route matrix. This is a harness/input limitation; it is not evidence that the product command itself is broken. Cleanup completed, the Reader closed, the temporary DataAdapter isolation was restored, plugin enablement remained off, and protected data was not modified. The test PDF SHA-256 remained `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`. Sanitized tracked receipt: [native-learning-loop-current-package-20261025.json](native-learning-loop-current-package-20261025.json).

Therefore:

```text
NATIVE_CORE_LEARNING_FLOWS_CURRENT_PACKAGE = PASS
NATIVE_ROUTE_ACCEPTANCE_CURRENT_PACKAGE = NOT_VERIFIED
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
```

Do not substitute earlier package or Windows evidence for these current-package gates. The 8-stage × 5-direction matrix and true process restart remain unverified. The older partial run did not complete the LingQ flow; that result is superseded by the two-flow current-package receipt above. No Obsidian process was restarted.

The offline auditor was rerun against all nine saved Native reports and the exact current three-file package. It found two package-matching reports, but **0/8 route stages are accepted**: seven older reports have package mismatches, the latest exclusive-process preflight failed its focused-owner assertion before any test mutations, and the current-package partial run does not close the route-matrix requirements. The report set remains `INCOMPLETE`; it cannot prove full current-package Native route acceptance. The two core learning flows above are individually verified and do not substitute for that matrix.

A bounded follow-up confirmed that the available CUA app-name binding resolves the sibling Obsidian process PID `99806`, not the isolated PID `69139` on port `57977`. The only action on the sibling was opening and dismissing its native Command Palette; no note/PDF editing, plugin mutation, or file write occurred. Attempts to raise the exact test window in PID `69139` did not change the foreground owner. Do not continue window-control retries: the 8×5 route matrix remains `NOT_VERIFIED`, and the real owned-process restart remains `NOT_RUN`.

A new one-shot owned-profile preflight rechecked the isolated PID `69139` and exact candidate package. The app renderer was visible and `document.hasFocus()` returned true, but the stricter owner gate failed: `activeDocument !== document` and `activeWindow !== window`; both globals pointed to the test vault's Settings window. The runner stopped before enabling the plugin or writing test state. The active PDF was the fixture `ObReader-Bulk-Tests/source-inspection-1792131679927.pdf`; no Reader view was open. No other PDF or shared/mixed PID was acted on, and no process was restarted. The separate receipt is [native-current-preflight-20261025](../native-current-preflight-20261025/README.md). It supersedes the earlier basic visibility/focus observation for deciding whether user input is safe: **the strict Native focus gate still fails**.

A later bounded check of the attached `ObReader-Apple-Test` window confirmed the same ownership failure on the shared process: the visible exact-test renderer had `document.hasFocus() === true`, but both `activeDocument` and `activeWindow` belonged to another renderer. The test renderer had Sync and the plugin disabled and zero Reader leaves. One fresh AX click and one native `super+p` attempt did not open the command palette. No Reader was opened and no Vault data or plugin state was changed. Stop further window-control attempts; the current-package Native matrix remains **NOT_VERIFIED**, and true process restart remains **NOT_RUN**. Receipt: [native-owner-gate-recheck-20261025.json](native-owner-gate-recheck-20261025.json).

## Automated gates

- Focused dictionary/conversion suites: 67 passed.
- Build: passed; 3 release files, 406 embedded assets, 402 frozen vendor hashes verified.
- Test-runner cleanup regression: 9/9 passed; adds bounded retry for transient macOS `ENOTEMPTY` while removing a completed disposable browser profile. No test assertion, product timeout, or gate threshold changed.
- Full Fast + Browser + Race run: Fast 122/122, Browser 28/28 (including offline smoke), Race 79/80, zero skips. The single Race failure was a Chromium startup timeout while waiting for its CDP WebSocket endpoint in round 9; the test assertion was never reached. The full run report is retained as `tests/artifacts/vocabulary-gates/report-20261025-current.json` and is correctly `acceptanceEligible=false`.
- A separate complete 10-round Race rerun passed 80/80 with stable source fingerprints and no skips. Its report is retained as `tests/artifacts/vocabulary-gates/report-20261025-race-repeat.json`. The initial failure remains recorded.
- SemanticAnchor exact-evidence regression: the contract projector now refuses to mark a different target VERIFIED using another anchor's evidence; targeted semantic/LearningHost/Markdown routing tests passed 153/153.

These automated gates do not override the Native acceptance blocker. `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`; no PDF.js, wheel, observer, or LingQ scroll changes were made. Test Vault deployment is verified by hashes, but the plugin was disabled during the completed runs. No production deployment, `main` push, Release, or data cleanup occurred.

## Latest focused regressions

After the `e81b469` evidence update, focused tests were rerun on the integration worktree:

- Resource-v3 conversion/runtime suites: **33/33 passed**.
- SemanticAnchor, Semantic services, Learning domain/Host, and backlink suites: **55/55 passed**.
- Dictionary Host/cache suites: **28/28 passed**; real Worker/browser smoke: **1/1 passed**.
- `npm run build`: passed; 3 release files, 406 embedded assets, 402 frozen vendor hashes verified. The rebuilt package hashes still match the test Vault's deployed files exactly, so no redeploy was needed.

These tests validate deterministic module behavior. The actual current-package Host lookup now has one Native sample, but it does not replace the missing Native 8×5 route matrix, true owned-process restart, a cold startup-added-blocking measurement, or an enabled-plugin Reader UI first-query verification.

### Fresh gate rerun on the current integration source

After incorporating the Native preflight and LRU evidence (documentation/evidence files only), the current integration source was rebuilt and all automated release gates were rerun:

- Build: **PASS**, 3 release files, 406 embedded assets, 402 frozen vendor files verified.
- Fast: **122/122**, 0 failed, 0 skipped.
- Browser: **28/28**, 0 failed, 0 skipped.
- Offline Viewer smoke: **PASS**, including all five annotation tools, save/reopen, and bulk-delete persistence.
- Race: **80/80**, 0 failed, 0 skipped.

The build hashes remain identical to the installed test-only package (`main.js ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`, manifest `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, styles `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`). The test-vault enabled-plugin list is still `[]`; no redeploy or plugin activation was needed for this evidence update. Tracked raw reports, Offline cleanup evidence, and the preserved earlier Race failure are indexed in [current-gates](current-gates/README.md).

## Seven-workstream ledger

| Workstream | Current result | Boundary / remaining evidence |
|---|---|---|
| A — Baseline / frozen-core audit | Latest `origin/main` is an ancestor of this clean integration branch. The 0.14 source diff does not modify frozen storage/WAL, canonical Vocabulary, input-owner, or PDF.js vendor paths. | The original 441-file frozen-hash recomputation was at the prior reviewed baseline; it is not a new runtime test. |
| B — Native learning loop and routing | Current-package Native UI passed both Highlight → Sidebar → Review → Today → exact annotation Source and LingQ → exact Context → Review → Today → Source flows. | Markdown route stage stopped at Command Palette automation; 8×5, open-move and true owned-process restart are `NOT_VERIFIED`/`NOT_RUN`. No earlier-package Windows result substitutes for them. |
| C — ECDICT Resource-v3 | 770,611 rows, 67 blocks, 16,769,142 compressed bytes; supported Obsidian 1.14.5 Native DataAdapter five-trial lookup measured. Rare lookup P50 88.9 ms / max 194.3 ms; warm P95 ≤0.1 ms. Focused and Worker tests pass. | Cold startup-added-blocking and enabled-plugin Host/Reader UI first lookup remain `NOT_MEASURED` / `NOT_VERIFIED`. Preserve the 1.155 s common-word outlier and do not claim it passed. |
| D — SQLite WASM / OPFS | Isolated Chrome experiment only. Standard OPFS completed 5/5 with COOP/COEP; SAHpool completed 0/5 end-to-end because second-window access failed. | App-origin probe initialized SQLite but did not install VFS or write. Native/app-origin compatibility and performance are unproven; SQLite is not selected. |
| E — SemanticAnchor / Sidebar / Backlink | Source/API contract and deterministic behavior are frozen; semantic, LearningHost, Markdown-route and plugin-host receipts include 153/153 passing tests, with current focused subset 55/55. | Native route/restart acceptance remains pending; quote matching never auto-rebinds. |
| F — Bulk import / History | Real-filesystem matrix completed; both candidates rejected. History gzip reduces total write bytes 22.77% (<40% gate); shared lifecycle reduces 13.56%, with worst CPU +54.47% and restore +26.65%. | Keep production behavior unchanged; measurements are bytes submitted to Node writes, not physical sectors or Sync traffic. |
| G — FSRS | Development-only replay/evaluation; current `leitner-utc-v1` remains default. Focused FSRS adapter/evaluation suite passed 12/12. | No production scheduler switch or learning-effectiveness superiority claim; incomplete history stays `INSUFFICIENT_HISTORY`. |

## 2026-10-25 bounded closeout update

This section supersedes earlier gate summaries above where they describe the newest run. The run was performed on source fingerprint `3123b32d42d6fd4fb5c3744add9fe763005b63b3d3c0f45b73514e954c42b980` (1,106 files; unchanged during each gate).

### Native current package

The exact 0.14.0 package was exercised in the existing `ObReader-Apple-Test` vault with Sync disabled and all mutation writes redirected into a per-run plugin isolation root. The latest run completed these real UI steps:

- Highlight → confirmed durable Sidecar → Sidebar → Add to Review → Today Review → Source returned to the same annotation target.
- LingQ lookup and sentence selection → Context creation and save completed.

The run stopped when Obsidian 1.14.5's Command Palette suggestion selection raised `TypeError: n.instanceOf is not a function` from the app's `SuggestModal` stack. The runner could not reopen the Vocabulary Workbench to complete Context → Review and the route matrix. This identifies a host UI automation/runtime boundary; it is not evidence that the product's learning command is defective. Plugin isolation was restored, the plugin was disabled, Sync remained disabled, the Reader was closed, and the fixture PDF matched the original SHA-256. Sanitized details: [native-current-final-resume-20261025.json](current-gates/native-current-final-resume-20261025.json).

```text
NATIVE_CORE_HIGHLIGHT_LEARNING_FLOW_CURRENT_PACKAGE = PASS
NATIVE_CONTEXT_CREATE_AND_SAVE_CURRENT_PACKAGE = PASS
NATIVE_CONTEXT_TO_REVIEW_CURRENT_PACKAGE = NOT_VERIFIED
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
MAC_NATIVE_CURRENT_PACKAGE = PARTIAL
```

No additional window-control retries or process restart were attempted after this failure.

### Latest automated gates

- Build and Fast: **PASS**, 122/122; no failed or skipped tests.
- Browser: **26/28**, no skips; acceptance-eligible **false**. `ipad-pointer-policy` failed the finger-inertia decay assertion (`DEFERRED_BY_SCOPE`; no iPad changes made). `vocabulary-pill-layout-browser` failed because the long fake dictionary result arrived before the test's transient-pending assertion. A later isolated rerun of that test passed 1/1; the full Browser result remains 26/28 and is not overwritten.
- Race: **PASS**, 80/80; no failed or skipped tests.
- Offline smoke: **PASS**; save/reopen and bulk-delete persistence verified.
- Resource-v3: conversion/runtime focused suites **33/33**; supported 1.14.5 Native DataAdapter rare lookup P50 **88.9 ms**, max **194.3 ms**, warm P95 **≤0.1 ms**. Native Host probe rare lookup **36.9 ms**, common `on` **206.4 ms**, with 20 warm repeats max **0.3 ms**. These are lookup measurements inside an already running process, not process-cold startup or complete Reader UI latency.
- `startup added blocking <50 ms = NOT_MEASURED`; enabled-plugin Reader UI first lookup = **NOT_VERIFIED**.
- `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`; no PDF.js, wheel, observer, or LingQ scrolling paths changed.

Sanitized latest gate summary: [final-gates-rerun-20261025.json](current-gates/final-gates-rerun-20261025.json). The exact test-only package remains 0.14.0 and is deployed only to the existing test vault. The branch has not been merged to `main`; no production vault deployment or data cleanup occurred. iPad remains `DEFERRED_BY_SCOPE`.
