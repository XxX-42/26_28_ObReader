# Current integration gates

## Gates after asynchronous Resource-v3 Worker prewarm (2026-10-25)

Candidate code commit `709b6600f498e88528ab71ff572ef5c1c82c5f62` was built and gated. Source fingerprint `c94f88ef84aa2725d3f5798ebd49573655a04862162d6dfbb7bed01543895614` was stable across the runs (1,114 files). Build passed with 3 release files, 406 embedded assets, and 402 frozen vendor hashes; Fast 122/122, Browser 28/28, Race 80/80 across 10 rounds, Offline smoke passed, and focused Resource-v3 tests passed 30/30. There were no failures or skips. Sanitized receipt: [gates-after-worker-prewarm-709b660-20261025.json](gates-after-worker-prewarm-709b660-20261025.json); raw child logs remain in local ignored test artifacts.

Candidate package hashes are `main.js 98b351b63936365e3615ab3955af583744b9eda069360a6c4414c39b0548e0cc`, `manifest.json 71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, and `styles.css 8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`. The shared `ObReader-Apple-Test` still contains the previous `main.js ee0ce9fe…`; I did not deploy to a Vault used by multiple Obsidian profiles. No production Vault, `main`, or user data changed. `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER` remains closed to further expansion.

Current-package 8-stage × 5-direction, open-move, and true process restart remain `NOT_VERIFIED` / `NOT_RUN`; no further window-focus retries were made. In the isolated Native DataAdapter prewarm run, common `on` was P50 56.6 ms / P95 88.2 ms, rare `zyzzyva` P50 22.8 ms / P95 29.5 ms, and warm P95 0.1 ms. `checkAvailability()` returned within 27.8 ms and Worker startup completed in the background within 287.1 ms. `startup-added blocking <50 ms = NOT_MEASURED`; enabled Reader UI first lookup = `NOT_VERIFIED`. See [the exact-candidate raw receipt](../native-data-adapter-prewarmed-709b660-20261025.json) and [REPORT.md](../REPORT.md) for scope and limits.

## Fresh rerun after Native harness corrections (2026-10-25)

On source fingerprint `3dd9739e8c0cf139818aef8e136c9d5d7b17d5ec5a8dba4efba184a1554b4b05` (1,112 files, stable through all gates), Build passed with 3 release files, 406 embedded assets and 402 frozen vendor hashes verified; focused Native acceptance/SemanticAnchor tests passed 13/13; Fast passed 122/122; Browser passed 28/28; Race passed 80/80; Offline smoke passed. No skips. See [sanitized rerun summary](resume-harness-gate-rerun-20261025.json).

This rerun changed only test/acceptance code and one semantic page-reorder test. The candidate package hashes remained `main.js ee0ce9fe…`, `manifest.json 71abba5e…`, `styles.css 8da58b1d…`.

Native UI was not rerun. The current owned-profile preflight reported a visible, focused renderer but `activeDocument !== document` and `activeWindow !== window`, with the plugin disabled. No Vault mutation occurred. Accordingly, the Native 8×5 matrix stays `NOT_VERIFIED`, open-move stays `NOT_VERIFIED`, and true process-restart remains `NOT_RUN`. The harness now requires exact foreground document/window ownership, binds resumed receipts and restart-pending records to all three current candidate hashes, requires a complete-sentence Context before the matrix, and checks that the prior exact-profile process is gone before accepting a restart. These are acceptance safeguards; they are not Native acceptance evidence.

Package-bound comparison: the separate Windows run on `origin/codex/014-windows-native-test` records all eight stages × five navigation directions and an owned process restart as PASS, but its installed `main.js` SHA-256 was `a7d74076383c4dc0cbc5c161021cfb72cc0556ad48a663a8b79dd6f3fd78137b`. The current 0.14.0 candidate `main.js` is `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`; manifest and stylesheet match, but the main bundle does not. Therefore the Windows run is valid historical evidence, not acceptance for the current candidate. Its detailed stage table and integrity receipt are in [`014_WINDOWS_NATIVE_RESULTS.md` on the Windows run branch](https://github.com/XxX-42/26_28_ObReader/blob/adf5223fce3083cd416fbb6c729e16900a6c2b84/docs/learning-system/014_WINDOWS_NATIVE_RESULTS.md). The current Mac preflight has the exact candidate files installed but the plugin disabled and owner-document focus false, so it proves file identity only. Current-package Windows and Mac Native acceptance remain `NOT_VERIFIED`; current-package true process restart remains `NOT_RUN`.

Resource-v3's first-Worker delay is now moved to asynchronous startup warmup. Current-candidate post-prewarm Native lookup P95 was 88.2 ms common, 29.5 ms rare, and 0.1 ms warm. The separate prewarm duration peaked at 287.1 ms. Startup-added blocking remains `NOT_MEASURED`; enabled Reader UI first lookup remains `NOT_VERIFIED`. `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`; no scroll-related production code changed. iPad remains `DEFERRED_BY_SCOPE`.

## Previous complete release rerun before the current harness-only changes

On source fingerprint `bd2347d2f996d287585bd8082e17ae9db12dee4db67b584914ed2a00388e6908` (1,108 files, stable during the run): Build passed with the 3-file package, 406 embedded assets, and 402 frozen vendor hashes verified; Fast passed 122/122; Browser passed 28/28; Offline Viewer smoke passed; Race passed 80/80. There were no skips. See [latest automated gate summary](latest-automated-gates-20261025.json).

The current 0.14.0 package's latest owned-profile Native run passed both the Highlight → Sidebar → Review → Today → same UUID Source flow and the LingQ phrase → Context → Review → Today → exact Source flow. It stopped before route scenarios when the runner could not open a visible native Command Palette for the Markdown-source setup. The PDF fixture hash matched before/after and cleanup restored the plugin isolation. The 8×5 matrix remains `NOT_VERIFIED`; true app-process restart remains `NOT_RUN`. See [sanitized Native receipt](native-partial-current-package-20261025-latest.json). Stop further window-control retries.

The latest package was then fast-forwarded to `main` and the three release files were backed up and replaced in the formal `远程仓库1` plugin folder. `data.json` and the source PDFs were preserved. The deployed SHA-256 values and backup location are recorded in [formal three-file deployment receipt](formal-threefile-deploy-20261025.json). No Obsidian process/plugin reload was forced; the loaded runtime remains unverified until its next plugin load.

These reports are copied from the ignored local run artifacts so the results remain reviewable from the pushed integration branch. They ran on the current 0.14 integration source at `e8a6e02dd0d78847225683c423fea4a6681a2149` (the only later change before documentation was the `REPORT.md` update).

## Fresh release run

- [Build + Fast](fast-20261025.json): build completed with 3 release files, 406 embedded assets and 402 frozen vendor files verified; Fast 122/122, no skips.
- [Browser](browser-20261025.json): 28/28, no skips.
- [Race](race-20261025.json): 80/80, no skips.
- [Offline cleanup proof](offline-cleanup-20261025.json): normal browser close, owned page and process cleanup, no cleanup errors. The Offline Viewer smoke also visibly created all five annotation tools, saved/reopened them, and verified bulk deletion persisted.

## Preserved earlier Race results

- [Initial combined gate](previous-combined-gates-initial-failure-20261025.json): Fast 122/122, Browser 28/28, Race 79/80. The one failure was retained; this run is not acceptance-eligible.
- [Earlier complete Race rerun](previous-race-repeat-20261025.json): 80/80, no skips.

The fresh current run also passed Race 80/80. The initial failure remains in the evidence set and was not rewritten or deleted.

## Latest bounded continuation (2026-10-25)

This section supersedes earlier package/test status above. Current candidate `main.js` is `706b1cc37a194f985679f67b239a117fc058afde77ece8d0012e8b5fd9c8180b`; manifest and styles are unchanged. Build, Fast **122/122**, Browser **28/28**, Race **80/80**, and Offline smoke passed without skips at stable source fingerprint `78c5f8b77807862e8d52f84900a63c31745368befbb5e1dddb56895dcea73bf6` (1,119 files).

On the exact current package in Obsidian 1.14.5, two isolated Native attempts reached the PDF text layer and kept Highlight mode active, but trusted pointer/mouse drags left the DOM selection collapsed and created no Highlight editor. The 1.12.7 profile was rejected before input because it exposed two app renderers. Cleanup restored the test isolation; no process restart was attempted. Thus current-package Native matrix and open-move are `NOT_VERIFIED`; true process restart is `NOT_RUN`. See the [sanitized receipt](../native-current-package-selection-blocker-20261025.json) and the detailed [scope-convergence report](../REPORT.md).

Five cold trials per query type using the real Vault DataAdapter measured Resource-v3 first-tap lookup at common `on` P50 **209.5 ms** / max **942.6 ms**, rare `zyzzyva` P50 **191.4 ms** / max **233.1 ms**, and missing term P50 **215.1 ms** / max **256.5 ms**. Warm P95 was **0.1 ms** for each type. Each cold request read one block. This excludes enabled plugin Host/Reader UI and process startup, so startup-added blocking remains `NOT_MEASURED`; the fully wired Reader UI query remains `NOT_VERIFIED`. Raw receipts: [prior timing](../native-first-tap-before-overlap-20261025.json), [overlapped Worker prewarm](../native-first-tap-overlapped-prewarm-20261025.json).

`SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`; no scroll, PDF.js or wheel code changed. iPad remains `DEFERRED_BY_SCOPE`. No main push, formal Vault deploy, or user-data mutation occurred in this continuation.

## Preserved earlier failed bounded rerun (superseded by later complete reruns)

`REPORT.md`'s [2026-10-25 bounded closeout update](../REPORT.md) is the authoritative latest status. On source fingerprint `3123b32d42d6fd4fb5c3744add9fe763005b63b3d3c0f45b73514e954c42b980`, Build/Fast passed 122/122, Race passed 80/80, and Offline smoke passed. Browser was 26/28: the iPad finger-inertia assertion remains deferred by scope, and the LingQ pill test's fake result beat its transient pending-state assertion. That second test passed when rerun alone, but the full gate result remains failed. See [sanitized gate summary](final-gates-rerun-20261025.json).

The latest actual Obsidian 1.14.5 run passed the Highlight learning flow and created/saved a LingQ Context. It stopped before Context → Review because Obsidian's Command Palette `SuggestModal` threw `TypeError: n.instanceOf is not a function`. Cleanup restored the test vault with Sync disabled, plugin disabled, no Reader views and the isolated write adapter restored. The 8×5 route matrix remains `NOT_VERIFIED`; real process restart remains `NOT_RUN`. See [sanitized Native receipt](native-current-final-resume-20261025.json).

## Current package Resource-v3 Reader UI spot check (2026-10-25)

On the exact current `main.js d57f5e1e…` package in a disposable Obsidian 1.14.5 scratch Vault, one real pointer click on `zyzzyva` returned a LingQ card with dictionary meaning `象鼻虫` and status `陌生词`. Click-to-result was **460.9 ms**. The generated one-page PDF screenshot was visually inspected; no user document was opened. Full evidence: [receipt](native-resource-v3-reader-ui-d57-20261025.json), [screenshot](native-resource-v3-reader-ui-d57-20261025.png).

This is one Native UI sample, not a process-cold first query or UI P95: page-level matching may have warmed the dictionary block. Startup-added blocking remains `NOT_MEASURED`. Current-package Native 8×5 remains `NOT_VERIFIED`; real process restart remains `NOT_RUN`. `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`; no scroll, PDF.js, wheel, observer, or LingQ scroll path was changed.

## Current-package Native focus recheck (2026-10-25)

The exact existing ObReader-Apple-Test window was targeted once. The Native runner confirmed the correct Vault, Sync disabled, plugin disabled, zero Reader views, visible renderer, and matching active document/window, but `document.hasFocus=false`; it stopped before installing isolation, enabling the plugin, creating fixtures, or sending input. No Vault data changed. See [the pre-mutation receipt](native-focus-recheck-20261025.json). Native 8×5/open-move remain `NOT_VERIFIED`; true process restart is `NOT_RUN`.

## 2026-10-25 final bounded Native selection diagnostic

After the focus-only stop above, the owned Obsidian 1.14.5 renderer was explicitly verified as foreground-owned for a bounded diagnostic on the exact candidate (`main.js d57f5e1e…`, manifest `71abba5e…`, styles `8da58b1d…`). Five automated pointer attempts used Highlight mode and one control attempt used ordinary text-selection mode with the Highlight tool visibly off. CDP and Quartz CGEvent inputs reached the expected PDF text spans: all 13 sampled points remained inside `.textLayer`; captured pointer/mouse events were trusted and not default-prevented. In the traced runs the text layer entered and left its `selecting` class, computed `user-select`/`-webkit-user-select` were `auto`, and no PDF.js selection consumer was called. All six attempts ended with a collapsed, empty DOM selection and no Highlight editor.

The plain-text control also failed, so the evidence cannot distinguish an input-channel/coordinate limitation in the automation from a product selection defect. This is **not** a product regression diagnosis and does not justify changing input ownership or PDF.js. The exact package and test Vault were verified; the plugin was disabled after each run, Sync stayed off, the Reader closed, and test write isolation was restored. The generated PDF matched the repository fixture SHA (`3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`); only the exact generated Markdown/PDF fixture and this run's seven isolated PDFData files were removed after path/content/hash checks. Defaults remained unchanged. The post-drag screenshot and sanitized receipt are [here](native-highlight-selection-fail-20261025.png) and [here](native-highlight-selection-fail-20261025.json).

No further window-control retries are planned. Current status remains:

```text
MAC_NATIVE_CURRENT_PACKAGE = NOT_VERIFIED
NATIVE_8_STAGE_x_5_DIRECTION_MATRIX = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_RUN
REAL_PROCESS_RESTART_8x5 = NOT_RUN
IPAD = DEFERRED_BY_SCOPE
SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER
```

Resource-v3 remains integrated in the exact candidate. Existing Native DataAdapter evidence is instance-cold, not process-cold: five cold block reads per query, rare `zyzzyva` P50/max 191.4/233.1 ms, common `on` 209.5/942.6 ms, and resident warm P95 0.1 ms. One current-package Reader UI click produced a dictionary card in 460.9 ms, but it is not a cold-query P95. `STARTUP_ADDED_BLOCKING_LT_50MS = NOT_MEASURED`; `READER_UI_FIRST_LOOKUP_P95 = NOT_MEASURED`. No Resource-v3 code changed in this continuation. Scroll/PDF.js work remains closed.

## 2026-10-25 automated rerun after Native runner safety cleanup

The first Fast rerun caught that the temporary diagnostic runner invoked Swift/Quartz, violating the existing passive Native-runner safety test. I removed that global input-injection code and kept only the text-range endpoint geometry and selection diagnostics; the safety assertion remains unchanged. Focused Native acceptance tests then passed 10/10.

The rebuilt package retained the exact `d57f5e1e… / 71abba5e… / 8da58b1d…` hashes and matched the three files already in `ObReader-Apple-Test`. Build passed (3 release files, 406 embedded assets, 402 frozen vendor hashes); Fast passed 123/123, Browser 28/28, Race 80/80, and Offline smoke passed with five tool save/reopen and persistent bulk-delete coverage. All had zero skips. Source fingerprint `91377431a053b5a0aa3ed0b0d181f6c79673c196f6b56a66a6bb618980918b02` (1,133 files) was stable across Fast/Browser/Race. See the [sanitized gate receipt](release-gates-bounded-native-20261025.json).

These automated gates do not close the Native P0. Current-package selection remained ambiguous in the bounded diagnostic; `NATIVE_8_STAGE_x_5_DIRECTION_MATRIX` is still `NOT_VERIFIED`, open-move is `NOT_RUN`, and actual process restart is `NOT_RUN`. `RESOURCE_V3` is integrated; its DataAdapter instance-cold measurements and one 460.9 ms Reader UI sample remain limited evidence. Reader UI first-query P95 and startup-added blocking `<50 ms` remain `NOT_MEASURED`. No product runtime, PDF.js, scroll, main, or formal Vault changes occurred.
