# Resource-v3 instant lookup validation

**Disposition: current-package Reader UI first-word lookup NOT RUN; startup-added blocking under 50 ms NOT MEASURED.** This report audits source, receipts, and the already-running test process. It does not substitute direct dictionary API calls for a Reader click.

## Current candidate and integration

- Worktree: `codex/014-ws-c-resource`, base `197cd7d653967eb0a2d04af3c91470163949e680`.
- Obsidian 1.14.5 / Electron 43.8.3; test Vault `/Users/jiajia/Documents/ObReader-Apple-Test`.
- Current built package in `dist/pdf-web-reader` exactly matches the test Vault installation: `main.js d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257`, `manifest.json 71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675`, `styles.css 8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` (v0.14.0; min Obsidian 1.14.4).
- The installed Resource-v3 manifest is schema 3 with 770,611 entries, 67 blocks, and 16,769,142 compressed bytes.
- The current source wiring is present: Reader `VocabularyController.handleTap()` posts `vocab-token-tap`; `PdfReaderView.handleVocabularyBridgeMessage()` calls `getVocabularyDictionary().lookup()` and returns `vocab-entry-result`; on layout ready, an enabled vocabulary setting schedules asynchronous `checkAvailability()`. Resource-v3 `checkAvailability()` starts the block Worker without waiting for readiness. This is a source audit, not proof the enabled Reader path ran.

## Why the current process cannot supply the missing evidence

Read-only preflight at `2026-10-25T12:31:30Z` found PID 27240 on the exact test Vault and the verified runtime. The renderer was focused, but the active file was `PDF迁移测试/native-learning-loop-20261024065546705-1c61a9ea63/Markdown Files/learning.md`, not a PDF Reader. `app.plugins.enabledPlugins` was empty, `pdf-web-reader` was not loaded, and there were zero Reader leaves. The Vault's `.obsidian/community-plugins.json` was `[]`; plugin `data.json` has `vocabularyEnabled: true`, which does not enable the plugin.

Two other Obsidian main processes were live (PIDs 69139 and 99806). PID 69139's command line explicitly targeted `ObReader-Apple-Test`; PID 99806 used a separate profile without an explicit Vault argument. Prior Native owner-gate evidence also reports other profiles sharing this Vault. This is not an exclusive process/Vault lease: enabling the plugin or opening the Reader could change or exercise shared Vault state. I did not enable the plugin, navigate the window, open a document, or mutate the Vault. No lookup API was invoked and no UI result is claimed.

The process had already been running for over 12 hours. Attaching to it cannot recover startup CPU or blocking. The 623.2 ms `enablePlugin()` duration and one observed 73 ms long task in the earlier Host probe include the whole enable path; they are not a paired cold-start delta. Therefore neither requested measurement can be made safely in this already-running shared-Vault process.

## Existing Native receipts (kept in their measured scope)

“Instance-cold” in the service benchmarks means a new `VocabularyDictionary` and Worker for the query; Obsidian, its renderer, and OS caches remain warm. The prewarmed cases wait for Worker readiness before timing lookup. The immediate-first-tap cases start `checkAvailability()` and time lookup without waiting for Worker readiness. “Warm” means 20 repeats of the same key on that same dictionary instance after its first query; these should be resident block-cache hits. This is not process-cold startup and none of these cases is a Reader click.

| Receipt / exact bundle | Scope and cold results (P50 / max, ms) | Warm / failure evidence |
|---|---|---|
| [prewarmed DataAdapter](../native-data-adapter-prewarmed-709b660-20261025.json), `98b351b6…` | New instance/Worker; Worker ready before lookup. `on` 56.6 / 88.2; `zyzzyva` 22.8 / 29.5; valid miss 73.4 / 85.9. | 20 resident repeats per query; warm P95 ≤0.1 ms. Not first-click timing. |
| [first tap before overlap](../native-first-tap-before-overlap-20261025.json), `98b351b6…` | `checkAvailability()` followed immediately by lookup, five new instances per key: `on` 272 / **1,012.3**; `zyzzyva` 188.8 / 246.6; miss 183.7 / 274.6. | The 1,012.3 ms common-word outlier is retained. Each instance then has 20 warm repeats. |
| [first tap with async prewarm](../native-first-tap-overlapped-prewarm-20261025.json), `706b1cc3…` | Same immediate lookup definition, five instances per key: `on` 209.5 / **942.6**; `zyzzyva` 191.4 / 233.1; miss 215.1 / 256.5. | 20 repeat queries each; all were resident hits, warm P95 0.1 ms. The 942.6 ms outlier remains. |
| [supported-runtime DataAdapter](../native-data-adapter-benchmark-1.14.5-20261025.json), `ee0ce9fe…` | New instance/Worker in Obsidian 1.14.5, five trials per key: `on` 170.2 / **1,154.8**; `zyzzyva` 88.9 / 194.3; miss 146.6 / 189.6. | 20 repeats per trial; warm P95 ≤0.1 ms. Standalone dictionary module, not Host/Reader. |
| [isolated DataAdapter](../native-data-adapter-isolated-current-candidate-20261025.json), `ee0ce9fe…` | Temporary Vault/process, five trials per key: `on` 94.0 / **1,065.6**; `zyzzyva` 70.5 / 100.4; miss 92.2 / 100.8. | 20 repeats per trial; warm values timer-quantized near 0, max 0.1 ms. First common query retained as a >1 s failure. |
| [Host probe](../native-host-probe-current-package-20261025.json), bundle hash absent | One actual Host query each: `on` 206.4; `zyzzyva` 36.9; miss 0.1. | 20 repeats per key, max 0.3 ms. Plugin was disabled on disk before/after, Reader UI was not run, and this receipt has no `main.js` hash to bind it to current `d57f5e1e…`. |

The more favorable prewarmed figures and the first-tap tails answer different questions; keep both. The five-trial DataAdapter receipts bind to `98b351b6…`, `706b1cc3…`, or `ee0ce9fe…`, not current `d57f5e1e…`. The hash-unbound Host receipt is not current-package UI evidence. No existing result establishes current-package Reader click-to-entry latency or startup-added blocking.

## Safe retry protocol

1. Obtain an exclusive lease on a dedicated test Vault/profile with no other Obsidian process using it. Record runtime identity, exact three package hashes, Resource manifest and block hashes, plugin enablement, and the deterministic PDF hash before launch.
2. Use a deterministic test PDF containing selectable `on` and `zyzzyva` text, with no user content. Open it in Reader, wait for page 1's text layer, then use actual pointer input on the rendered text span. Do not invoke `VocabularyDictionary.lookup()` or `app` APIs as a substitute for the click.
3. Measure from pointer-up to the visible entry result; preserve the tapped key, request ID, `dictionaryLookupState`, result text visibility, and any timeout/error. For each cold trial use a fresh process with no earlier dictionary query; run five trials per key to match existing counts. Then run 20 same-key UI repeats on that instance and record every duration and whether it reused the resident block. Keep common, rare, and valid-not-found cases separate and preserve all outliers and failed attempts.
4. For startup blocking, use paired fresh processes with the same Obsidian binary, package, Resource data, fixture, and window policy, changing only the test-only Resource availability activation. Start tracing before bundle evaluation and include deferred availability work until it settles. Record non-overlapping top-level renderer-main tasks, CPU, longest task, TBT, and elapsed window. Retain every signed enabled-minus-baseline pair and predeclare the acceptance statistic; one pair is diagnostic only. The existing `tests/resource-startup-pair-support.mjs` validates these inputs but does not itself collect Native startup traces.

This run changed only this evidence report in the assigned worktree. No Vault files, plugin settings, `main`, user data, or canonical schema were changed.
