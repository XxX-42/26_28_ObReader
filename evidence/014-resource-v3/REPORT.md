# ObReader 0.14 candidate status

## Current authority — 2026-10-26

- Evidence audit base was `90da489454ae059dd8ca3edf2a447af0b4ea658f` on `codex/014-goal-resume-20261025`; the worktree was clean and matched upstream before this report-only correction. `origin/main=197cd7d653967eb0a2d04af3c91470163949e680`; the integration source was 13 commits ahead and 0 behind. No `main` update occurred in this continuation.
- Candidate is `0.14.0`. Exact package SHA-256: `main.js ca8b7a8dd1db65d5610d84e01a66b9193896ab58c725a07c8bbf49a009cc73a`, `manifest.json 71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, `styles.css 8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`. These exact files are in the existing test Vault; the plugin was disabled after isolated checks. The formal Vault is outside this continuation's deployment scope.
- Latest gates on the candidate source: build PASS (3 release files, 406 embedded assets, 402 frozen vendor hashes); Fast 123/123, Browser 28/28, Race 80/80, Offline smoke PASS; 231 automated assertions passed, 0 failed, 0 skipped. Stable source fingerprint: `40821d7182b63170e401071f9605535846391743215bd2b9600aa7a7757096f5` across 1,143 files. The final Native harness attempt changed only test code; package hashes stayed the same.
- Current-package Native remains open: macOS Highlight drag reached the PDF.js text layer but produced no DOM selection/editor. This does not isolate a product defect from the external input path. Therefore `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX=NOT_VERIFIED`, `OPEN_MOVE_8x5=NOT_VERIFIED`, and `REAL_PROCESS_RESTART_8x5=NOT_RUN`. Windows PASS evidence uses a different `main.js` hash and does not transfer. The bounded window-control attempts are closed.
- Resource-v3 is integrated: 770,611 equivalent rows, 67 blocks, 16,769,142 compressed bytes. On the exact `ca8b…` package, Native DataAdapter instance-cold first lookup immediately after `checkAvailability()` measured P50/max: common `on` 251.7/1,024.3 ms, rare `zyzzyva` 231.6/338.3 ms, valid miss 211.0/253.7 ms. After awaiting background Worker prewarm: `on` 52.9/156.9 ms, `zyzzyva` 23.9/244.6 ms, miss 63.1/74.5 ms. Across 100 resident repeats per key, warm P95/max were `on` 0.2/12.3 ms, rare 0.1/17.7 ms, miss 0.1/0.5 ms. Every cold lookup read one block. The Worker prewarm maximum was 1,254.3 ms in the background; it is not startup blocking or a Reader UI measure.
- `READER_UI_FIRST_LOOKUP=NOT_VERIFIED`; the single 460.9 ms Reader UI sample used an older `d57f…` package. `STARTUP_ADDED_BLOCKING_LT_50MS=NOT_MEASURED`. iPad remains `DEFERRED_BY_SCOPE`.
- `SCROLL_PERF=INVESTIGATED / NOT_RELEASE_BLOCKER`. No stable reproduction was established for the specific OCR PDF. Stop this track; do not modify PDF.js, wheel, observers, or LingQ scrolling without that reproduction. Bulk candidates remain rejected, FSRS stays dev-only, and SQLite/OPFS is not selected.

The dated sections below preserve their original receipts and historical results. Use this current-authority block and the latest linked receipts for release decisions; earlier package passes are not evidence for the current candidate.

## Historical package snapshot — 2026-10-25

## Earlier scope snapshot (superseded by current authority above)

- `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`. No reproducible root cause was established for the user's 120-page OCR PDF. Stop the scroll-specific investigation; do not modify PDF.js, wheel handling, observers, or LingQ scroll paths unless that exact PDF becomes reproducible.
- Native closeout is bounded. A current read-only preflight found the exact test Vault, Sync disabled, candidate plugin disabled, and no Reader leaves, but the renderer was not foreground-owned; two other Obsidian profiles also list the same test Vault. No window manipulation or Native mutation was attempted. Do not run the 8×5 matrix under shared ownership. Keep `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED` and `REAL_PROCESS_RESTART_8x5 = NOT_RUN`; do not relabel from earlier-package or partial UI receipts. The existing supported-runtime Resource-v3 DataAdapter benchmark remains valid only for its recorded standalone lookup scope.
- `SemanticAnchorContractV1`, Sidebar and Backlink source/API contracts are frozen at the code and deterministic-test level; full Native route acceptance remains pending and is not implied by that source-level freeze.
- iPad remains `DEFERRED_BY_SCOPE`; synthetic mobile timing is not iPad evidence.
- Bulk import prototypes are rejected by their stated production gate; FSRS stays development-only; SQLite/OPFS remains an isolated experiment and has no qualifying app-origin result.

## Resource-v3 conversion and lookup

The verified resource-v2 source converted to `770,611` equivalent rows in `67` content-addressed blocks (`16,769,142` compressed bytes). A temporary conversion was byte-identical to the installed Resource-v3 blocks. The manifest records the MIT notice at `../LICENSE-MIT.txt` and checksum `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f`.

### Current-candidate Native lookup after asynchronous Worker prewarm

The first-candidate Native run recorded a 1.066 s first `on` query, with most of that time inside the first Worker startup/ready path. The current candidate starts the block Worker in the background after a valid v3 manifest is confirmed by `checkAvailability()`. The availability call does not await Worker readiness; a tap during Worker startup still joins the same pending promise. A focused test verifies the availability response returns while the Worker is deliberately held before its `started` message.

The current candidate was tested in a fresh, dedicated Obsidian 1.14.5 / Electron 43.8.3 process and temporary Vault containing only Resource-v3 files. The plugin was absent, there were zero Reader leaves, and the actual DataAdapter was exposed only through `read` and `readBinary`. Each of five trials per query created a new dictionary and Worker, invoked `checkAvailability()`, awaited background Worker readiness, then measured one cold lookup and 20 resident repeats. There were zero binary writes.

| Query | Cold lookup P50 | P95 / max (5 samples) | Warm P95 (100 repeats) | Warm max |
|---|---:|---:|---:|---:|
| Common `on` | 56.6 ms | 88.2 ms | 0.1 ms | 0.4 ms |
| Rare `zyzzyva` | 22.8 ms | 29.5 ms | 0.1 ms | 0.5 ms |
| Valid not-found | 73.4 ms | 85.9 ms | 0.1 ms | 0.2 ms |

Across these lookups, `checkAvailability()` returned in at most 27.8 ms; the background Worker ready handshake took at most 287.1 ms. These are DataAdapter/module timings, not a measurement of plugin-added process-start blocking. If a user taps before Worker readiness, that lookup can still wait for the remaining handshake. `startup added blocking <50 ms = NOT_MEASURED`; full Reader UI first lookup = `NOT_VERIFIED`. Raw receipt: [native-data-adapter-prewarmed-709b660-20261025.json](native-data-adapter-prewarmed-709b660-20261025.json). It is bound to `main.js` SHA-256 `98b351b63936365e3615ab3955af583744b9eda069360a6c4414c39b0548e0cc`.

The earlier lookup run used the real macOS Obsidian DataAdapter in `ObReader-Apple-Test`; the plugin was disabled and Reader leaves were closed. It ran five new dictionary/Worker instances per query and 20 resident repeats each. Reads were limited to DataAdapter `read`/`readBinary`; there were zero Vault writes. Each cold observation reads one relevant compressed block; the new IndexedDB caches use unique disposable names and are removed after each trial.

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

### Isolated current-candidate Native DataAdapter run

To avoid the shared-vault ownership conflict, a separate Obsidian 1.14.5 process used a dedicated temporary profile and a temporary Vault containing only the 67 Resource-v3 blocks, manifest and license. The candidate plugin was absent and disabled; there were zero Reader leaves. The harness performed five new dictionary/Worker trials per term and 20 resident repeats per trial. It used only DataAdapter `read`/`readBinary` for dictionary resources and removed each unique IndexedDB cache. `binaryWrites = 0`; the temporary process was closed after the run.

| Query | Cold P50 (5 samples) | Cold P95 / max | Warm P95 (100 repeats) | Warm max | Cold block bytes |
|---|---:|---:|---:|---:|---:|
| Common `on` | 94.0 ms | **1,065.6 ms** | timer-quantized 0.0 ms | 0.1 ms | 262,366 |
| Rare `zyzzyva` | 70.5 ms | 100.4 ms | timer-quantized 0.0 ms | 0.1 ms | 139,005 |
| Valid not-found | 92.2 ms | 100.8 ms | timer-quantized 0.0 ms | 0.1 ms | 236,616 |

The first common query in the process had a 1,028.9 ms `decodeBlock` wall time while the Worker reported 90.2 ms for block decoding. This points to first-Worker startup/handshake or first-use scheduling as the likely source of the extra delay, but the harness does not isolate those components well enough to prove the cause. Preserve this outlier. Since the common query came first, the rare samples do **not** prove a rare-word query is fast when it is the very first operation after a cold process. `first rare lookup as first process query = NOT_VERIFIED`; `startup added blocking <50 ms = NOT_MEASURED`; enabled Reader UI first lookup = `NOT_VERIFIED`. This run confirms direct Native DataAdapter lookup without a full Dexie build, but is not the complete Native release gate. Raw receipt: [native-data-adapter-isolated-current-candidate-20261025.json](native-data-adapter-isolated-current-candidate-20261025.json); exact candidate `main.js` SHA-256: `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`.

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
| B — Native learning loop and routing | Current candidate Native Highlight selection did not complete; latest attempt is recorded against `main.js ca8b…`. | Current-package 8×5, open-move and true owned-process restart are `NOT_VERIFIED` / `NOT_RUN`. Earlier flow and Windows results use other package hashes and do not substitute. |
| C — ECDICT Resource-v3 | 770,611 rows, 67 blocks, 16,769,142 compressed bytes. Exact `ca8b…` Native DataAdapter first-query samples and warmed samples are recorded above and in the two linked receipts. | Service-level rare query is below 1 s in these samples. Reader UI first lookup is `NOT_VERIFIED`; startup-added blocking `<50 ms` is `NOT_MEASURED`. Preserve common-word and warm-tail outliers. |
| D — SQLite WASM / OPFS | Isolated Chrome experiment only. Standard OPFS completed 5/5 with COOP/COEP; SAHpool completed 0/5 end-to-end because second-window access failed. | App-origin probe initialized SQLite but did not install VFS or write. Native/app-origin compatibility and performance are unproven; SQLite is not selected. |
| E — SemanticAnchor / Sidebar / Backlink | Source/API contract and deterministic behavior are frozen; current focused integration suite passed 158/158. | Native route/restart acceptance remains pending; quote matching never auto-rebinds. |
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

Sanitized latest gate summary at that point: [final-gates-rerun-20261025.json](current-gates/final-gates-rerun-20261025.json). The exact test-only package remained 0.14.0 and was deployed to the existing test vault. At that snapshot the branch had not yet been merged to `main`; subsequent release/deployment status is recorded below. iPad remains `DEFERRED_BY_SCOPE`.

## 2026-10-25 final bounded closeout

The latest complete automated rerun supersedes the earlier `26/28` Browser result for this unchanged source: source fingerprint `bd2347d2f996d287585bd8082e17ae9db12dee4db67b584914ed2a00388e6908` stayed stable across the runs; build passed (3 release files, 406 embedded assets, 402 frozen vendor hashes), Fast **122/122**, Browser **28/28**, Offline smoke **PASS**, and Race **80/80**, with zero skips. Detailed receipt: [latest automated gates](current-gates/latest-automated-gates-20261025.json).

The latest exact-package Native run used Obsidian 1.14.5, the existing test vault, Sync disabled, and isolated annotation/vocabulary writes. It passed both real UI learning flows, including exact source navigation for the same Annotation UUID and the `Dynamic languages` Context anchor. It stopped before the Markdown source route matrix because the visible native Command Palette did not open after the runner's ribbon click and platform shortcut. This is recorded as `NATIVE_UI_AUTOMATION_UNRESOLVED`; no product command failure was established. Fixture PDF SHA-256 remained `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`; cleanup restored isolation and disabled the plugin. Receipt: [latest partial Native run](current-gates/native-partial-current-package-20261025-latest.json).

The bounded decision is final for this attempt: `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX=NOT_VERIFIED`, `OPEN_MOVE_8x5=NOT_VERIFIED`, and `REAL_PROCESS_RESTART_8x5=NOT_RUN`. Do not continue trying to control Obsidian windows or claim these gates passed from partial flows. `SCROLL_PERF=INVESTIGATED / NOT_RELEASE_BLOCKER`; no wheel, observer, PDF.js, or LingQ scrolling paths changed. iPad stays `DEFERRED_BY_SCOPE`.

Resource-v3 remains integrated and deployed to the existing test vault with the exact package hashes above. Supported-runtime DataAdapter and current Host query measurements are recorded earlier in this report; they prove first lookup without a full Dexie build, but do not measure process-cold startup or enabled Reader UI first lookup. Therefore `startup added blocking <50ms=NOT_MEASURED` and `Reader UI first lookup=NOT_VERIFIED` remain explicit.

## 2026-10-25 publication and formal three-file deployment

The integration branch was fast-forwarded to GitHub `main` at `7af8c349e2ee84edd537f0ad78b24b7d49713741`, after verifying the fetched `origin/main` was its ancestor. The same 0.14.0 build was then backed up and installed as exactly three files in the formal `远程仓库1` plugin folder. `data.json` was byte-identical before and after; no PDF or annotation data was modified. The backup is outside the Vault at `/Users/jiajia/.codex/deploy-backups/obreader-remote1-0.14.0-2026-10-25T01-33-03-068Z`. See [deployment receipt](current-gates/formal-threefile-deploy-20261025.json).

The plugin was not forcibly reloaded while Obsidian may have open user tabs. Thus `FORMAL_FILES_DEPLOYED=YES`, while `FORMAL_RUNTIME_RELOADED=NO` and the running process version is not confirmed; it will load 0.14.0 on its next plugin load. The latest test-vault package and formal package have matching release hashes.

Release limitations remain visible: `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX=NOT_VERIFIED`, `REAL_PROCESS_RESTART_8x5=NOT_RUN`, `startup added blocking <50ms=NOT_MEASURED`, and enabled Reader UI first dictionary lookup is `NOT_VERIFIED`. Do not report full Native/launch acceptance as passed. `SCROLL_PERF=INVESTIGATED / NOT_RELEASE_BLOCKER`; iPad remains `DEFERRED_BY_SCOPE`.

## 2026-10-25 continuation: Native gate safeguards and Resource-v3 decision

The latest repository state was fetched before work. `origin/main=8af459fe61cae8a3904a9c343491b352da22be23`; candidate `origin/feature/0.14-native-learning-dictionary-20261023=6694c16b4c390d4a8dbd7762ec647ffa13f8f909`, already an ancestor of main. Work continued in isolated branch `codex/014-goal-resume-20261025`, based on that current main commit. The existing formal deployment recorded above was not repeated or modified in this continuation.

The exact candidate package remains unchanged: `main.js ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`, `manifest.json 71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, and `styles.css 8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`. This continuation changed acceptance/test code and evidence only; no PDF.js, scroll, storage, WAL, canonical vocabulary, or production plugin behavior changed.

### Native acceptance boundary

The current owned-profile preflight was read-only and stopped before UI input. Although the renderer reported visible and focused, its active document and window were both the Settings renderer (`activeDocumentMatches=false`, `activeWindowMatches=false`); the plugin was disabled and no Native mutation occurred. This is sufficient reason to stop further window-control attempts. The current package's 8-stage × 5-direction matrix remains `NOT_VERIFIED`; open-move is `NOT_VERIFIED`; true process restart is `NOT_RUN`. Earlier Highlight and phrase-Context learning receipts remain partial evidence only.

A separate Windows Native report contains a complete historical 8×5 route matrix and an owned process-restart PASS, but its package binding is `main.js=a7d74076383c4dc0cbc5c161021cfb72cc0556ad48a663a8b79dd6f3fd78137b`; current 0.14.0 is `main.js=ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`. Both packages have the same manifest and stylesheet hashes, but that does not transfer Native acceptance to the changed main bundle. The Windows receipt is retained at [`origin/codex/014-windows-native-test` / `014_WINDOWS_NATIVE_RESULTS.md`](https://github.com/XxX-42/26_28_ObReader/blob/adf5223fce3083cd416fbb6c729e16900a6c2b84/docs/learning-system/014_WINDOWS_NATIVE_RESULTS.md). Thus `WINDOWS_HISTORICAL_PACKAGE_8x5=PASS`, while `WINDOWS_CURRENT_PACKAGE_8x5=NOT_VERIFIED`. The Mac current-package preflight confirms installed hashes only; strict owner focus failed before plugin enable or UI input. `MAC_CURRENT_PACKAGE_8x5=NOT_VERIFIED`, `CURRENT_PACKAGE_PROCESS_RESTART=NOT_RUN`.

Four Native test safeguards were corrected: exact active renderer ownership is required; resumed stages and restart-pending receipts must match the current expected and installed hashes of all three release files; a genuine complete-sentence Context Review item must exist before any five-direction stage can pass; and restart evidence must show the prior PID is no longer running the exact owned profile. SemanticAnchor tests now explicitly exercise a reordered stable page identity and fail closed when that identity disappears. These safeguards do not turn the unrun Native matrix into a pass.

### Previous automated gates before the continuation rerun

The earlier source fingerprint `3dd9739e8c0cf139818aef8e136c9d5d7b17d5ec5a8dba4efba184a1554b4b05` (1,112 files) run passed Build, focused Native acceptance/SemanticAnchor tests 13/13, Fast 122/122, Browser 28/28, Race 80/80 and Offline smoke. The continuation rerun below records the newer current source fingerprint and supersedes it for the present branch state.

### Resource-v3 and scope

Resource-v3 stays in the candidate because supported Native DataAdapter evidence shows rare first lookup P50 88.9 ms / max 194.3 ms and warm P95 ≤0.1 ms without a full Dexie build. The common-word sample includes a 1,154.8 ms outlier. The four Native release measures are not all closed: startup-added blocking `<50 ms` is `NOT_MEASURED`; enabled Reader UI first lookup is `NOT_VERIFIED`. Do not claim complete first-query acceptance until those are measured through the current enabled Reader path.

`SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`. No PDF.js, wheel, observer, or LingQ scroll work was added. Bulk remains rejected, FSRS remains development-only, SQLite/OPFS remains unselected, and iPad remains `DEFERRED_BY_SCOPE`.

## 2026-10-25 latest continuation gate and deployment check

The current continuation source at `3197f212c71e4ea4263a1f256bc6c9917d241dc8` was rebuilt and revalidated. Its source fingerprint was stable at `4ab39249a6e679588e97caeec28fb59771a1e02b2e365ad6700d76ad3cc22f34` across 1,112 files. Build passed with 3 release files, 406 embedded assets and 402 frozen vendor hashes. Fast passed 122/122, Browser 28/28, Race 80/80 over 10 rounds, and Offline smoke passed; there were no failures or skips. Summary receipt: [gates-rerun-after-3197f21-20261025.json](current-gates/gates-rerun-after-3197f21-20261025.json). Raw gate reports are retained under local ignored test artifacts.

All three rebuilt package files exactly match `ObReader-Apple-Test`; no test-vault redeploy was needed. The package hashes and no-change boundary are listed in the receipt. `origin/main` remains `654aa58a56e8d7ef6edfe8b53fa39975dd33ebb5`; this continuation did not push to main or deploy to the formal Vault. `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER` remains closed to expansion.

The current Native 8-stage × 5-direction matrix, open-move, and true process restart remain `NOT_VERIFIED` / `NOT_RUN`. Resource-v3's existing supported Obsidian 1.14.5 DataAdapter evidence is unchanged: rare first lookup P50 88.9 ms / max 194.3 ms and warm P95 ≤0.1 ms, with the common `on` 1,154.8 ms outlier preserved. Startup-added blocking is `NOT_MEASURED`; enabled Reader UI first lookup is `NOT_VERIFIED`. The current exact test renderer was not foreground-owned and multiple Obsidian profiles list the same test Vault, so no new exclusive Native benchmark or mutation lease was taken. iPad remains `DEFERRED_BY_SCOPE`.

### Test-vault settings audit after bounded Native attempt

The pre-run backup at `~/.codex/deploy-backups/obreader-014-test-vault-prewarm-native-20261025/data.json` and the current `ObReader-Apple-Test/.obsidian/plugins/pdf-web-reader/data.json` have identical SHA-256 (`8807581279d95cf4ab770bdc722a5e861f1354f9c3a8eae1ee60b97aea7b09f0`). No settings restoration or guessed defaults were applied. The owned 1.14.5 profile remains plugin-disabled with zero Reader leaves. Two sibling Obsidian profiles still have the same test Vault open, and one also has a formal Vault open, so further plugin activation or shared Vault mutation is not safe until those processes are isolated. Receipt: [test-vault-settings-restore-audit-20261025.json](current-gates/test-vault-settings-restore-audit-20261025.json).


## 2026-10-25 scope-convergence update

This update supersedes the preceding Native and Resource-v3 status where they describe the latest attempt. The source tree stayed stable during Build/Fast/Browser/Race at fingerprint `78c5f8b77807862e8d52f84900a63c31745368befbb5e1dddb56895dcea73bf6` (1,119 files). Build verified the 3 release files, 406 embedded runtime assets, and 402 frozen vendor hashes. Fast passed **122/122**, Browser **28/28**, Race **80/80**, and Offline smoke passed; there were no skips. Raw gate runs are in the local ignored `tests/artifacts/vocabulary-gates/` directory.

### Native gate: explicit blocker, not a pass

The exact current candidate (`main.js 706b1cc37a194f985679f67b239a117fc058afde77ece8d0012e8b5fd9c8180b`, `manifest.json 71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, `styles.css 8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`) was verified in the existing `ObReader-Apple-Test` Vault and the owned Obsidian 1.14.5 profile. PDF text-layer readiness was 292–527 ms in the two recorded attempts. Highlight mode was active (`annotationEditorMode=9`); trusted pointer and mouse events landed on text-layer spans and were not prevented, but the DOM selection remained collapsed and no PDF.js Highlight editor was created. Both attempts stopped at the Highlight setup wait. This is a reproducible current-package Native test failure, but it does not isolate a product regression from this CUA setup; no interaction or PDF.js code was changed.

The older 1.12.7 profile was refused before input because it exposed two app-origin renderers, violating the exact-owner preflight. Test cleanup completed: isolation restored, plugin disabled, Sync off, and Reader closed. No actual Obsidian process restart was attempted. The 8-stage × 5-direction matrix, open-move, and true process restart therefore remain **NOT_VERIFIED / NOT_RUN**; older package receipts do not satisfy the current hash gate. A sanitized receipt is [native-current-package-selection-blocker-20261025.json](native-current-package-selection-blocker-20261025.json).

```text
MAC_NATIVE_CURRENT_PACKAGE = NOT_VERIFIED
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE = NOT_VERIFIED
TRUE_PROCESS_RESTART = NOT_RUN
```

### Resource-v3 Native DataAdapter first-tap benchmark

Five cold trials each for common `on`, rare `zyzzyva`, and a unique missing key were run in the real Obsidian 1.14.5 renderer against the test Vault's DataAdapter. Each cold query read and decoded exactly one compressed block; each trial then ran 20 warm lookups, all resident-cache hits. This bypasses the enabled plugin Host/Reader UI, so it measures the dictionary service and real Vault I/O, not the entire user-visible click path.

| Query | Before manifest/Worker overlap: first lookup P50 / max | Current async prewarm: first lookup P50 / max | Current warm P95 |
|---|---:|---:|---:|
| Common `on` | 272 / 1,012.3 ms | 209.5 / 942.6 ms | 0.1 ms |
| Rare `zyzzyva` | 188.8 / 246.6 ms | 191.4 / 233.1 ms | 0.1 ms |
| Missing | 183.7 / 274.6 ms | 215.1 / 256.5 ms | 0.1 ms |

With five cold samples, the recorded maximum is also the nearest-rank P95. The common-word tail moved below one second in this sample; rare lookup stayed below 250 ms. The rare median did not improve, so this is evidence that first rare lookup is already fast in this isolated service path, not evidence of a broad latency win. `checkAvailability()` does not wait for Worker readiness; cold lookup overlaps Worker startup with manifest I/O. Startup-added blocking `<50 ms` remains `NOT_MEASURED`, and enabled Reader UI first lookup remains `NOT_VERIFIED`. Do not claim either gate passed from this DataAdapter benchmark. Receipts: [before overlap](native-first-tap-before-overlap-20261025.json) and [with overlap](native-first-tap-overlapped-prewarm-20261025.json).

```text
SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER
PDF.js / wheel / observer / LingQ scroll changes = NONE
IPAD = DEFERRED_BY_SCOPE
origin/main = 654aa58a56e8d7ef6edfe8b53fa39975dd33ebb5 (unchanged in this continuation)
formal Vault deployment = NONE in this continuation
```

The existing test Vault already contains the exact candidate three-file package hashes listed above; no redeployment was needed. This continuation neither pushed `main` nor touched the formal `远程仓库1` Vault or user PDFs/data.

## 2026-10-25 bounded gate rerun and next focus

This continuation follows the narrowed order: the scroll investigation is closed as `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`; no PDF.js, wheel, observer, or LingQ scroll code was changed. The Native current-package route matrix and process-restart gate remain the only unresolved Native acceptance items. Repeated window activation was stopped after the OS kept another Obsidian profile in front; no input was sent to that profile and no further window-control retry was made.

The Native runner received test-only safeguards after the diagnostic review: it will not toggle an already-active Highlight tool off, opens the selection palette through hover, records PDF.js selection-consumer activity before and after pointer drag, checks the full drag path remains over `.textLayer`, and captures a post-drag screenshot. These changes improve failure evidence; they do not establish that the earlier selection failure was only a harness issue and do not count as a Native pass. Current-package statuses remain:

```text
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
MAC_NATIVE_CURRENT_PACKAGE = NOT_VERIFIED
```

The rebuilt release package did not change during this test-only work. Its three hashes remain `main.js=706b1cc37a194f985679f67b239a117fc058afde77ece8d0012e8b5fd9c8180b`, `manifest.json=71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, and `styles.css=8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`.

### Automated gates

The latest source fingerprint was stable at `1be8e85005ce1979ee212fdbb36b3c100f92788daa6858005586912ae0a88af0` across 1,122 source files. Build passed with 3 release files, 406 embedded runtime assets, and 402 frozen vendor hashes. Fast passed **123/123**, Browser **28/28**, Race **80/80** across 10 rounds, and Offline smoke passed; all had zero failures and skips. The updated Native runner assertions were included in Fast. Full raw output is retained in the local ignored `tests/artifacts/vocabulary-gates/` directory; run IDs are `run-2026-10-25T11-03-29-048Z-36992-6cbf8978` (Fast), `run-2026-10-25T11-03-58-297Z-38564-cc86a2f4` (Browser), and `run-2026-10-25T11-09-51-140Z-42660-d5a069e0` (Race).

### Resource-v3 decision

Resource-v3 is already integrated in the current candidate. Its supported Obsidian 1.14.5 Native DataAdapter experiment uses the actual Vault `read`/`readBinary` path and one compressed block per cold query, without waiting for a full Dexie build. For the current asynchronous Worker-prewarm package, five cold samples per term measured common `on` at **209.5 ms P50 / 942.6 ms maximum**, rare `zyzzyva` at **191.4 / 233.1 ms**, and a missing term at **215.1 / 256.5 ms**; resident warm P95 was **0.1 ms** for all three. These are service/DataAdapter timings inside an already running Obsidian process, excluding plugin Host and Reader UI wiring.

This supports keeping the direct Resource-v3 lookup path and not returning to full-database-first Dexie initialization. It does **not** close the startup or whole click-path gate: `startup added blocking <50 ms = NOT_MEASURED`, and enabled Reader UI first lookup remains `NOT_VERIFIED`. Do not describe the service benchmark as the user-visible LingQ latency. Next Resource-v3 work should measure only those two missing boundaries in a correctly owned test process; avoid another broad storage redesign or SQLite/OPFS work.

No runtime source, frozen storage/WAL code, canonical vocabulary data, PDF.js vendor, or formal Vault files changed in this continuation. `origin/main` and the formal Vault were left untouched; iPad remains `DEFERRED_BY_SCOPE`.

## 2026-10-25 continuation: public backlink evidence fix and current gates

This continuation is based on `origin/main=654aa58a56e8d7ef6edfe8b53fa39975dd33ebb5` in integration branch `codex/014-goal-resume-20261025`. The semantic audit found that normal public Reader links intentionally omit internal `docKey`/`documentId`, but the Learning Host only called the synchronous evidence check that requires those identifiers to already be present in the link. A valid generated backlink therefore became unresolved. The fix uses the existing asynchronous Reader route resolver to verify the public path against the Anchor's stable document identity, while still requiring the captured Markdown slice, offsets, and text to match exactly. Navigation recovery cannot silently turn a stale citation into verified evidence. Focused regression covers the real public encoder, the production evidence methods, mismatched target/document/path/source/offset, and changed Markdown content.

Validation on the integrated source:

- Focused semantic, Learning Host, backlink, and Markdown routing suites: **54/54 passed**.
- Build: **PASS**, 3 release files, 406 embedded runtime assets, and 402 frozen vendor files verified.
- Fast: **123/123**, 0 failed, 0 skipped; source fingerprint `92aeb8cccf47a4abeb1fe28c316430a0fd2aea30d46ecd5bb966ded208dd33dd` (1,122 files), stable.
- Browser: **28/28**, 0 failed, 0 skipped; same stable source fingerprint.
- Race: **80/80**, 0 failed, 0 skipped; same stable source fingerprint.
- Offline Viewer smoke: **PASS**, all five annotation tools, save/reopen, and bulk-delete persistence.

The rebuilt package hashes are `main.js d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257`, `manifest.json 71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, and `styles.css 8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`.

Native acceptance remains separate from these automated results. The current-package `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX` and `OPEN_MOVE_8x5` are `NOT_VERIFIED`; `REAL_PROCESS_RESTART_8x5` is `NOT_RUN`; `MAC_NATIVE_CURRENT_PACKAGE=NOT_VERIFIED`. The owned Obsidian renderer cannot be reliably foreground-selected, so no more window-control attempts are being made. Earlier-package Windows passes do not transfer to the current main bundle. Resource-v3 remains integrated: Native DataAdapter first-lookup evidence is recorded above, but `startup added blocking <50 ms=NOT_MEASURED` and enabled Reader UI first lookup remains `NOT_VERIFIED`.

At deployment check time, the existing test-vault package still had the previous `main.js 706b1cc37a194f985679f67b239a117fc058afde77ece8d0012e8b5fd9c8180b`; its community-plugin list was empty. This update does not claim a current-package Native UI run, process restart, or formal-vault deployment. `main` and `远程仓库1` were not changed.

## 2026-10-25 latest scope-convergence decision

`SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`. The 120-page OCR PDF has no proven reproducible root cause. This continuation made no changes to PDF.js, wheel handling, observers, or LingQ scrolling.

The current package was exercised once in the exact owned Obsidian 1.14.5 / Electron 43.8.3 profile. Preflight verified the `ObReader-Apple-Test` Vault, focused renderer, Sync off, and all three candidate package hashes. The run opened only its generated PDF fixture with Reader data writes redirected to a per-run isolated root. Highlight mode was active; 13 trusted drag-path samples hit the PDF text layer, and captured events were not prevented. However, DOM selection remained collapsed, PDF.js received no `highlightSelection` call, and no Highlight editor appeared within 8 seconds. The run stopped before either learning flow or any route stage. The fixture matched the repository fixture SHA-256; no user PDF was touched. Cleanup restored the data adapter, closed the Reader, and disabled the plugin, then removed only the two generated fixture files after re-verifying their exact paths and PDF hash. Evidence: [current-package Native Highlight drag result](current-gates/native-current-package-highlight-drag-20261025.json), [post-drag screenshot](current-gates/native-current-package-highlight-drag-20261025.png). Full local runner receipt remains under ignored `tests/artifacts/native-learning-loop-20261025114805917-dc564d9d9a*`.

This is a failed Native attempt, not an acceptance pass. It does not isolate a product defect from the native CUA selection path. Do not change PDF.js or input behavior without a minimal reproducible diagnosis, and do not spend more time retrying window activation. Current package gates remain:

```text
MAC_NATIVE_CURRENT_PACKAGE = NOT_VERIFIED (Highlight interaction stopped the run)
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
```

Resource-v3 is already integrated and present in the deployed test package. The strongest supported Native evidence remains the current-package Resource-v3 DataAdapter first-tap run: five samples per query after asynchronous prewarm, rare `zyzzyva` P50 191.4 ms / maximum 233.1 ms, common `on` P50 209.5 ms / maximum 942.6 ms, valid miss P50 215.1 ms / maximum 256.5 ms, and warm P95 0.1 ms. This verifies direct block lookup in the real Obsidian DataAdapter, not the full LingQ click-to-card UI.

```text
RESOURCE_V3 = INTEGRATED; CURRENT TEST PACKAGE DEPLOYED
FIRST_RARE_LOOKUP = PASS for Native DataAdapter scope only
READER_UI_FIRST_LOOKUP = NOT_VERIFIED
STARTUP_ADDED_BLOCKING_LT_50MS = NOT_MEASURED
```

Do not claim startup or full Reader first-query gates passed. The current package remains on the feature branch and existing test Vault; `main` and the formal `远程仓库1` Vault remain untouched. iPad is `DEFERRED_BY_SCOPE`.

### Test-vault package replacement

After the gates passed, the previous three files were backed up outside the Vault to `/Users/jiajia/.codex/deploy-backups/obreader-014-v3-backlink-fix-2026-10-25/`. The existing `ObReader-Apple-Test` plugin folder now matches the rebuilt candidate exactly: `main.js=d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257`, `manifest.json=71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, `styles.css=8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`; manifest version is `0.14.0`. Only these three files were replaced. The plugin remains disabled (`community-plugins.json=[]`), so this is a file deployment, not a runtime reload or Native UI verification. The Vault's `data.json` was not part of the copy operation. No `main` push or `远程仓库1` deployment occurred.

## 2026-10-25 main push and formal-vault disk deployment

After the non-forced fast-forward, `main` and `feature/0.14-native-learning-dictionary-20261023` both point to `be528e2813f9904e8849832a4c3b14a92d7ecc1c`. The 0.14.0 candidate was built from that branch and the exact three release hashes were installed in `远程仓库1`. The existing vault had ECDICT resource-v2 but no resource-v3, so the same-source 770,611-record v3 package was added under `00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v3`: one manifest and 67 verified blocks. Resource-v2 was retained.

Before deployment, the full plugin directory, community-plugin config, PDFData, and VocabularyData were backed up outside the Vault at `/Users/jiajia/.codex/deploy-backups/obreader-014-formal-20261025T121424Z`. Post-deploy hashes show all 129 preexisting PDFData files and all 11 preexisting VocabularyData files unchanged; only the new v3 manifest and blocks were added. The open sample PDF SHA-256 is unchanged (`e7a3c638f7cb4f0b218f80748ba58b72b7f454aa86ac4969c2c91650be033b81`). `data.json` and the enabled-plugin config are unchanged.

The formal Obsidian process still has the PDF Reader open and has the old 0.12.0 plugin loaded in memory. The on-disk three files are 0.14.0, but plugin reload was not forced while the user's Reader remained open. Thus this records a verified **disk deployment**, not a claim that the current process has loaded 0.14.0. Current-package Native 8×5 remains `NOT_VERIFIED`; true process restart is `NOT_RUN`; Resource-v3 Native DataAdapter evidence passes only its measured service scope, while Reader UI first lookup is `NOT_VERIFIED` and startup-added blocking is `NOT_MEASURED`. Full receipt: [formal-vault-deploy-20261025.json](current-gates/formal-vault-deploy-20261025.json).

### Runtime reload follow-up

At `2026-10-25T12:23:56Z`, the formal process was safely reloaded after refreshing Obsidian's plugin manifest cache. The old Reader save flush reported `ok=true, dirty=false`; the plugin was disabled and enabled, and the same PDF tab was restored. Runtime inspection confirmed plugin version **0.14.0** enabled and the Reader open at `12_books/11_杂志/TE 2025-04-12.pdf`, page 1, with the same `documentId`, `docKey`, and source hash; `sourceMismatch=false`, hydration allowed, and pending saves were zero. The structured receipt above is updated to `RUNTIME_RELOADED_0.14.0`. This corrects the preceding disk-only status. It was a plugin reload, **not** a full Obsidian process restart, and does not satisfy the Native 8×5 or true-process-restart gates.

Post-reload integrity checks reconfirmed the sample PDF bytes, all previously existing PDFData and VocabularyData files, plugin settings, and the enabled-plugin config unchanged. Resource-v3 remains an additive set of 1 manifest plus 67 verified blocks; the prior Resource-v2 data remains present. The pre-deployment backup remains at `/Users/jiajia/.codex/deploy-backups/obreader-014-formal-20261025T121424Z`.

## 2026-10-25 integrated gate rerun

On the exact current integrated source at `197cd7d653967eb0a2d04af3c91470163949e680`, build passed with 3 release files, 406 embedded assets, and 402 frozen vendor hashes. Fast passed **123/123**, Browser **28/28**, Race **80/80**, and Offline Viewer smoke passed. All three automated gate reports recorded the same stable source fingerprint `525e9f90066d556663909bb2e8acc9ee2f2cda8f716482750df201fb7f603908` across 1,126 source files, with zero failures or skips. The offline run created all five annotation editors, saved and reopened them, and verified bulk deletion persisted without resurrection.

This rerun does not close Native acceptance: the current-package 8-stage × 5-direction matrix is still `NOT_VERIFIED`, real process restart is `NOT_RUN`, Reader UI first lookup is `NOT_VERIFIED`, startup-added blocking `<50 ms` is `NOT_MEASURED`, and iPad is `DEFERRED_BY_SCOPE`. Exact run IDs, bundle hashes, and limits are recorded in [the gate rerun receipt](current-gates/release-gates-rerun-20261025.json). No production runtime code changed during this rerun.

## 2026-10-25 scope-corrected Native stop

The exact current candidate package (`0.14.0`, `main.js=d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257`, manifest and stylesheet hashes unchanged) was launched in an owned Obsidian 1.14.5 scratch profile with Sync off and all mutation writes isolated. The strict app/vault/window identity checks passed for the CDP-driven attempt. However, after selecting PDF.js Highlight mode and issuing the bounded CDP pointer drag, the text selection remained empty and no Highlight editor appeared. This does not establish whether the cause is product input handling or CDP mouse semantics.

One OS-pointer retry was prepared but not run: after one raise of the exact owned window and one Escape, its renderer still reported `document.hasFocus=false`. To preserve the focus safety gate, no Quartz pointer event or further window-control retry was sent. The process was terminated after confirming it was the owned scratch-profile process; its generated fixture, receipt, and screenshots remain preserved.

```text
CURRENT_PACKAGE_SELECTION_SETUP = NOT_VERIFIED
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
OS_POINTER_RETRY = NOT_RUN (strict focus gate)
SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER
```

No product code, PDF.js, wheel/observer/LingQ scroll path, `main`, or formal Vault was changed by this closeout. Current-package Native acceptance remains a release blocker; prior matrix evidence for a different `main.js` bundle does not transfer.

## 2026-10-25 Resource-v3 current-package Native first-tap benchmark

After closing the bounded Native route attempt as `NOT_VERIFIED`, the next scoped Resource-v3 benchmark used the already-running Obsidian 1.14.5 test process only for read-only `Vault DataAdapter.read/readBinary` access. Preflight confirmed exactly one target renderer for `/Users/jiajia/Documents/ObReader-Apple-Test`, `pdf-web-reader` disabled both in process and on disk, zero Reader leaves, Sync disabled, and the installed three-file package hashes matching the current candidate. The benchmark made no Vault writes and did not enable the plugin or open a document. It wrote only disposable IndexedDB caches in that test profile and deleted them after each sample.

The run used the exact candidate `main.js=d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257`, with current dictionary source `76cdb665…` and Worker source `0670712f…`. It exercised five new `VocabularyDictionary`/Worker instances per key. Each instance awaited `checkAvailability()` (which starts asynchronous prewarm but does not await Worker readiness), then immediately performed the first lookup and 20 same-key warm lookups. The process, renderer and OS remained warm; this is **instance-cold Native DataAdapter lookup**, not process-cold startup or Reader UI click latency.

| Query | First-lookup samples (ms) | P50 | P95 / max | Warm samples | Warm observed max |
|---|---:|---:|---:|---:|---:|
| Common `on` | 55.1, 56.7, 59.2, 59.9, **858.8** | 59.2 | **858.8** | 100 | 0.1 ms |
| Rare `zyzzyva` | 45.5, 45.6, 46.6, 46.7, 48.4 | 46.6 | 48.4 | 100 | 0.4 ms |
| Valid miss | 54.9, 56.8, 58.6, 59.7, 79.9 | 58.6 | 79.9 | 100 | 0.1 ms |

All 15 first-lookups returned the expected status and exactly one compressed Resource-v3 block read. All 300 warm re-lookups were cache hits with no additional block read. Preserve the common-word 858.8 ms tail: in that outlier, the manifest `read()` took 297.2 ms, Worker readiness arrived 739.7 ms after availability began, and Worker decode itself took 86.7 ms. This proves the rare first lookup was below 50 ms in these five instance-cold trials, while the common first-query path retained a large outlier below the plan's 1 s threshold. It does not prove a fresh-process first lookup or the full LingQ card path.

```text
RESOURCE_V3_CURRENT_PACKAGE_NATIVE_ADAPTER = PASS (instance-cold scope)
FIRST_COMMON_LOOKUP = P50 59.2 ms; P95/max 858.8 ms (outlier retained)
FIRST_RARE_LOOKUP = P50 46.6 ms; P95/max 48.4 ms
RESIDENT_WARM_LOOKUP = observed max 0.4 ms across 300 repeats
STARTUP_ADDED_BLOCKING_LT_50MS = NOT_MEASURED
READER_UI_FIRST_LOOKUP = NOT_VERIFIED
```

Full receipt: [native-resource-v3-first-tap-d57-20261025.json](current-gates/native-resource-v3-first-tap-d57-20261025.json). No product runtime code, plugin activation, PDF/annotation data, `main`, or formal Vault was changed for this benchmark.

## 2026-10-25 current-package Reader UI lookup spot check

After the DataAdapter benchmark, the exact `d57f5e1e…` package was enabled only in a disposable scratch Vault with Sync disabled. The generated one-page PDF fixture contained `on zyzzyva dynamic apple`; no user document was opened. A real Obsidian pointer click on `zyzzyva` produced the LingQ card with dictionary meaning `象鼻虫`, status `陌生词`, and a measured click-to-result time of **460.9 ms**. The card was visually inspected in the captured screenshot and was visible with its link and level controls.

This is one successful end-to-end Reader UI lookup on the Native Obsidian app and current package. It is a **single UI sample**, not a cold-process first-query latency or a P95 measurement: page-level vocabulary matching may have warmed the relevant dictionary block before the click. The service-level DataAdapter five-trial measurements above remain the latency evidence for direct block lookup. Startup-added blocking remains unmeasured.

Evidence: [sanitized Reader UI receipt](current-gates/native-resource-v3-reader-ui-d57-20261025.json) and [visual screenshot](current-gates/native-resource-v3-reader-ui-d57-20261025.png).

```text
READER_UI_LOOKUP = PASS (one current-package Native click; scratch fixture)
READER_UI_FIRST_QUERY_P95 = NOT_MEASURED
STARTUP_ADDED_BLOCKING_LT_50MS = NOT_MEASURED
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER
```

No scrolling, PDF.js, wheel, observer, or LingQ scroll code changed. No formal Vault or `main` update occurred in this continuation.

## 2026-10-25 bounded Native focus recheck

Using the existing `ObReader-Apple-Test` profile (current candidate package already installed), I attempted one exact-window focus acquisition and reran the Native harness. The test Vault identity matched, Sync was off, the plugin was disabled, there were no Reader views, and the renderer was visible with `activeDocument`/`activeWindow` matching that renderer. However, `document.hasFocus()` was false after the exact-window AXRaise. The harness stopped at its pre-mutation gate before installing the test write adapter, enabling the plugin, creating fixtures, or sending any pointer/keyboard input. No Vault data changed.

Receipt: [Native focus recheck](current-gates/native-focus-recheck-20261025.json). No further window-control attempts were made. `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX` and `OPEN_MOVE_8x5` remain `NOT_VERIFIED`; true process restart remains `NOT_RUN`.

## 2026-10-25 final bounded Native selection diagnostic

The exact current 0.14.0 candidate (`main.js d57f5e1e…`) was exercised in the owned Obsidian 1.14.5 test profile after exact Vault and foreground-window checks passed. Five Highlight-mode pointer attempts used CDP and Quartz CGEvent; a sixth ordinary-selection control turned Highlight mode off through the visible toolbar. Every sampled drag path remained on PDF.js text spans. The traced runs reported trusted, non-prevented pointer/mouse events, `user-select: auto`, and the text layer entering/leaving `selecting`, but no selection-consumer call; all six selections remained collapsed and no Highlight editor appeared.

This is an acceptance blocker, not an isolated product diagnosis: the ordinary-selection control failed too, so the automation channel remains a plausible cause. Per the bounded scope, no further window activation retries or production input/PDF.js changes were made. Cleanup disabled the plugin, kept Sync off, closed the Reader, restored adapter isolation, and removed only this run's verified fixture and seven isolated PDFData files. The PDF fixture SHA-256 stayed equal to the repository fixture; PDFData/VocabularyData defaults were unchanged. Evidence: [sanitized receipt](current-gates/native-highlight-selection-fail-20261025.json) and [screenshot](current-gates/native-highlight-selection-fail-20261025.png).

```text
MAC_NATIVE_CURRENT_PACKAGE = NOT_VERIFIED
NATIVE_8_STAGE_X_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8X5 = NOT_RUN
REAL_PROCESS_RESTART_8X5 = NOT_RUN
RESOURCE_V3 = INTEGRATED; Native DataAdapter instance-cold evidence retained
READER_UI_FIRST_LOOKUP_P95 = NOT_MEASURED
STARTUP_ADDED_BLOCKING_LT_50MS = NOT_MEASURED
IPAD = DEFERRED_BY_SCOPE
SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER
```

No production runtime code, PDF.js vendor, scroll/wheel code, `main`, or formal Vault changed. Resource-v3's existing direct-block path remains integrated; no additional benchmark or package deployment was performed in this diagnostic continuation.

## 2026-10-25 final automated gates after Native runner safety cleanup

The temporary Quartz input-injection helper was removed from the Native runner after the existing passive-runner guard correctly rejected it; the guard was not weakened. The text-range endpoint measurement and passive selection tracing remain. Focused Native acceptance tests passed 10/10. Build passed with 3 release files, 406 assets, and 402 frozen vendor hashes. Fast 123/123, Browser 28/28, Race 80/80, and Offline smoke passed with zero skips. Their source fingerprint was stable at `91377431a053b5a0aa3ed0b0d181f6c79673c196f6b56a66a6bb618980918b02` across 1,133 files; exact receipts are in [the bounded gate report](current-gates/release-gates-bounded-native-20261025.json).

The bundle hashes remain identical to the already-installed test package. This was not a deployment. Native current-package selection, the 8×5 matrix, open-move, and true process restart remain open; Resource-v3 UI P95 and startup-added blocking remain unmeasured. No production runtime, frozen vendor, scroll/wheel code, `main`, or formal Vault was changed.

## 2026-10-26 current-package startup toggle measurement

To close the remaining Resource-v3 startup question without more window-control attempts, the exact `0.14.0` package (`main.js ca8b7a8d…`) was launched in five fresh Obsidian 1.14.5 processes with `vocabularyEnabled` alternated off/on. The isolated temporary Vault had Sync disabled and no Reader open. Resource-v3 reached `DICTIONARY_RESOURCE_AVAILABLE`; its Worker became ready asynchronously in all five enabled runs, 51–447 ms after the renderer-side readiness check began.

The plugin `loadPlugin` duration was noisy: enabled-minus-disabled paired deltas were -137.0, +110.9, -78.5, +17.2, and -371.9 ms. LongTask time overlapping the plugin load differed by -8, +8, -1, -1, and -5 ms. The LongTask result shows no added ≥50 ms task in these paired samples, but the metric misses shorter blocking and the broader load duration could not isolate the dictionary contribution. Therefore:

```text
RESOURCE_V3_NATIVE_STARTUP_TOGGLE = MEASURED; attribution inconclusive
STARTUP_ADDED_BLOCKING_LT_50MS = NOT_VERIFIED
READER_UI_FIRST_LOOKUP = NOT_VERIFIED for the exact ca8b package
NATIVE_8_STAGE_X_5_DIRECTION_MATRIX = NOT_VERIFIED
REAL_PROCESS_RESTART_8X5 = NOT_RUN
SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER
```

Full samples and package hashes are in [the paired startup receipt](current-gates/native-startup-toggle-ca8b-20261026.json). This measurement changed only evidence/docs; it did not modify product code, deploy a package, touch user data, or update `main` or the formal Vault.
