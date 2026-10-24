# ObReader 0.14 candidate status

## Git and release boundary

- Latest fetched `origin/main`: `833397ad2e78bba35e4490d3810ac73783860856`.
- Latest fetched `origin/feature/0.14-native-learning-dictionary-20261023`: `6694c16b4c390d4a8dbd7762ec647ffa13f8f909`.
- Integration branch: `codex/014-resource-v3-integration`; evidence baseline commit `e81b469ea862a4f76d39161ce99af25d42405fe7` contains the latest feature branch and the Native harness/SemanticAnchor audit commits. The Resource-v3 code commit is `6ea2ca23a106e4fa0dfcf6dbeaaab2f9c8f90ea5`.
- `main` remains unchanged. The formal vault was not deployed or modified.
- Candidate version: `0.14.0`. The current built/deployed `main.js` SHA-256 is `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`.

## Scope decision

- `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`. No reproducible root cause was established for the user's 120-page OCR PDF. Stop the scroll-specific investigation; do not modify PDF.js, wheel handling, observers, or LingQ scroll paths unless that exact PDF becomes reproducible.
- Native closeout is bounded: the current owned macOS test process/window could not be brought through the runner's visible-and-focused ownership check. Window-selection attempts are stopped. Keep `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED` and `REAL_PROCESS_RESTART_8x5 = NOT_RUN`; do not relabel either from earlier-package or partial UI receipts. Proceed with Resource-v3 evidence and report the Native gap instead of spending more time on window control.
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

## Current-package Native Learning Loop

The exact 0.14.0 three-file package was deployed to `ObReader-Apple-Test` after backing up the previous plugin directory to `.deploy-backups/2026-10-24T21-20-00-515Z/pdf-web-reader`. The deployed files matched the build:

| File | SHA-256 |
|---|---|
| `main.js` | `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8` |
| `manifest.json` | `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675` |
| `styles.css` | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` |

The current-package Native runner loaded v0.14.0 with DataAdapter write isolation installed and Sync disabled. After the harness correction, a real user-input Highlight was created, durably written to the isolated Sidecar, shown in the Annotation Sidebar, added to Review, and visible in Today Review. The runner then stalled on a Puppeteer `Runtime.callFunctionOn` while creating the Context learning item. It did not reach the route matrix. This is a Native harness/CDP timeout, not evidence of a production assertion failure. Cleanup completed: Reader closed through the WAL path, isolation restored, and protected default data hashes remained unchanged. The test PDF SHA-256 remained `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`.

Therefore:

```text
NATIVE_LEARNING_LOOP_CURRENT_PACKAGE = NOT_VERIFIED
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
```

Do not substitute earlier package or Windows evidence for these current-package gates. The 8-stage × 5-direction matrix and true process restart remain unverified. In the current visible test window, the macOS Window menu also exposed a separate `远程仓库1` window, so restarting its shared Obsidian process could affect the formal vault. The independent test-only process is hidden and not selectable through the available CUA window list. It was not restarted. Current run evidence: [native-learning-loop-20261024212130027-54207db4f2.json](../../tests/artifacts/native-learning-loop-20261024212130027-54207db4f2.json).

The offline auditor was rerun against all nine saved Native reports and the exact current three-file package. It found two package-matching reports, but **0/8 route stages are accepted**: seven older reports have package mismatches, the latest exclusive-process preflight failed its focused-owner assertion before any test mutations, and the earlier partial run does not close all route-matrix requirements. The latest preflight report also lacks verified cleanup. The report set remains `INCOMPLETE`; it cannot prove a current-package Native pass.

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

These tests validate deterministic module behavior. They do not replace the missing Native 8×5 route matrix, true owned-process restart, current-package Resource-v3 startup measurement, or enabled-plugin Reader first-query verification.

## Seven-workstream ledger

| Workstream | Current result | Boundary / remaining evidence |
|---|---|---|
| A — Baseline / frozen-core audit | Latest `origin/main` is an ancestor of this clean integration branch. The 0.14 source diff does not modify frozen storage/WAL, canonical Vocabulary, input-owner, or PDF.js vendor paths. | The original 441-file frozen-hash recomputation was at the prior reviewed baseline; it is not a new runtime test. |
| B — Native learning loop and routing | Partial current-package UI reached durable Highlight → Sidebar → Review → Today; overall Native result remains `NOT_VERIFIED`. | 8×5, open-move, and true owned-process restart are still unverified; see exact-package audit above. Historical Windows evidence is not current-package acceptance. |
| C — ECDICT Resource-v3 | 770,611 rows, 67 blocks, 16,769,142 compressed bytes; current-package Native DataAdapter first/warm lookups measured, focused and Worker tests pass. | `startup added blocking` and enabled-plugin Reader first lookup remain `NOT_MEASURED` / `NOT_VERIFIED`; do not call the Native product gate complete. |
| D — SQLite WASM / OPFS | Isolated Chrome experiment only. Standard OPFS completed 5/5 with COOP/COEP; SAHpool completed 0/5 end-to-end because second-window access failed. | App-origin probe initialized SQLite but did not install VFS or write. Native/app-origin compatibility and performance are unproven; SQLite is not selected. |
| E — SemanticAnchor / Sidebar / Backlink | Source/API contract and deterministic behavior are frozen; semantic, LearningHost, Markdown-route and plugin-host receipts include 153/153 passing tests, with current focused subset 55/55. | Native route/restart acceptance remains pending; quote matching never auto-rebinds. |
| F — Bulk import / History | Real-filesystem matrix completed; both candidates rejected. History gzip reduces total write bytes 22.77% (<40% gate); shared lifecycle reduces 13.56%, with worst CPU +54.47% and restore +26.65%. | Keep production behavior unchanged; measurements are bytes submitted to Node writes, not physical sectors or Sync traffic. |
| G — FSRS | Development-only replay/evaluation; current `leitner-utc-v1` remains default. Focused FSRS adapter/evaluation suite passed 12/12. | No production scheduler switch or learning-effectiveness superiority claim; incomplete history stays `INSUFFICIENT_HISTORY`. |
