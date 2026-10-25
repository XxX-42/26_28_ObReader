# Native learning loops and route matrix: workstream B

Observation time: 2026-10-25 13:07 UTC

Worktree: `codex/014-ws-b-native`; workstream base `197cd7d653967eb0a2d04af3c91470163949e680`

## Result

The current candidate package is version `0.14.0`; `main.js` SHA-256 is `d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257`. The initial shared-vault route was unsafe because sibling Obsidian processes exposed both the test vault and a foreign-vault renderer. No sibling renderer was inspected or activated. With parent authorization, I switched to one disposable scratch vault and one dedicated Obsidian 1.14.5 profile. The scratch vault contains the candidate package, Resource-v3 dictionary data, an empty baseline PDF data folder, and generated route fixtures only. Sync is off.

The runner was bound to scratch owner PID `72720` and CDP port `51663`. Before the first bounded run, I raised the exact scratch main window by its unique title and confirmed four consecutive reads where `document.hasFocus()`, `activeDocument === document`, and `activeWindow === window` were all true. The strict foreground assertion was not weakened. The candidate manifest was refreshed; the exact `pdf-web-reader` 0.14.0 package loaded with matching three-file hashes.

That bounded open/move run reached the generated PDF and Highlight toolbar but failed before creating its first Highlight. After the CDP pointer drag, the helper returned the requested target text and mode 9, but PDF.js reported an empty selection and created no `.annotationEditorLayer .highlightEditor` within the 8-second wait at `tests/native-learning-loop.mjs:1408`. This was a selection/annotation interaction failure, not a foreground-gate failure; the receipt does not establish whether PDF.js rejected this CDP input method or the product interaction itself.

I prepared a scratch-only Quartz pointer path for one retry. The strict focus gate could not be satisfied after one `AXRaise` of the exact scratch window; `document.hasFocus()` remained false. One Escape key was sent to the same process while its Settings window remained open; both scratch-owned pages still reported `document.hasFocus() === false`. Per the no-more-window-control-loop constraint, I stopped before posting Quartz pointer events or starting that retry. **OS-pointer retry: NOT_RUN. Selection gate: NOT_VERIFIED. Native 8-stage × 5-route matrix: NOT_VERIFIED. Owned process restart: NOT_RUN.**

Cleanup of the first bounded run completed: the isolation wrapper was restored, the plugin was disabled and persisted disabled, no Reader leaves remained, and Sync remained off. The scratch PDF stayed byte-identical to the test fixture. No product/runtime core was changed.

## Candidate package hashes

| File | Worktree candidate SHA-256 | Scratch runtime SHA-256 | Result |
| --- | --- | --- | --- |
| `main.js` | `d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257` | same | PASS |
| `manifest.json` | `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675` | same | PASS |
| `styles.css` | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` | same | PASS |

The scratch PDF fixture copied from `tests/fixtures/tracemonkey.pdf` has SHA-256 `3662ff519e485810520552bf301d8b3b2b917fd2f83303f4965d7abed367e113` both before and after the failed run. The run receipt records `cleanup.status=complete`, `cleanup.isolationRestored=true`, verified adapter evidence, the disabled plugin state, and zero remaining Reader views.

## Native stage status

| Current-package Native stage | Status |
| --- | --- |
| `full-pdfrename` | NOT_VERIFIED |
| `full-foldermove` | NOT_VERIFIED |
| `full-mdrename` | NOT_VERIFIED |
| `full-mdmove` | NOT_VERIFIED |
| `full-bothmove` | NOT_VERIFIED |
| `full-closedmove` | NOT_VERIFIED |
| `full-openmove` | NOT_VERIFIED: bounded setup failed before route checks |
| `full-owned-process-restart` | NOT_RUN |

No rename or move action ran. The bounded open/move attempt is not a matrix pass: it stopped during common Highlight setup before any route direction was exercised. The full current-package 8-stage × 5-route matrix remains **NOT_VERIFIED**; no process was restarted.

## Exact checks

- **PASS:** `node --check tests/native-learning-loop.mjs` and `node --check tests/native-os-pointer.mjs`.
- **PASS:** `swiftc -typecheck tests/native-os-pointer.swift`.
- **PASS:** `node --test tests/native-tooling.test.mjs tests/native-learning-acceptance.test.mjs tests/native-learning-loop-isolation.test.mjs` — 35 tests passed, including the new scratch-only OS-pointer guard.
- **PASS:** `git diff --check`.
- **PASS (first Native preflight):** Explicit scratch owner PID/profile/vault binding; visible renderer; Sync off; plugin initially disabled; zero Reader leaves; exact main-window and document focus checks passed before Native mutations.
- **PASS (candidate load):** `app.plugins.loadManifests()` refreshed the candidate manifest; exact version `0.14.0` loaded and installed hashes matched `dist/pdf-web-reader`.
- **FAIL (bounded Native selection):** `PDF_READER_NATIVE_PROFILE_ROOT=/private/tmp/obreader-014-runtime/profile-native-loop-b-20261025125158641-78e1c4 PDF_READER_NATIVE_ALLOW_RUNTIME_TEST_PROFILE=1 PDF_READER_NATIVE_SCRATCH_VAULT=1 PDF_READER_NATIVE_SCRATCH_VAULT_PATH=/private/tmp/obreader-014-runtime/native-loop-vaults/native-loop-b-20261025125158641-78e1c4 PDF_READER_NATIVE_EXPECT_OWNER_PID=72720 node tests/native-learning-loop.mjs --bounded-openmove-stage --process-only-owned-profile` — timed out waiting for `.annotationEditorLayer .highlightEditor` after 8 seconds, before route checks.
- **NOT_RUN (OS-pointer retry):** The exact foreground gate reported `document.hasFocus=false`; the retry runner was not started and no Quartz pointer events were posted.
- **NOT_VERIFIED:** Selection gate, Native 8-stage × 5-route matrix, and rename/move behavior.
- **NOT_RUN:** Actual owned Obsidian process restart.
- **NONE:** No sibling or formal-vault window was queried, no user documents were copied, and no product/runtime core was modified. The only fixture PDF written was under the disposable scratch vault.

## Receipts and screenshots

The focus-gate receipt for the skipped OS-pointer retry is [native-os-pointer-preflight-20261025.json](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-os-pointer-preflight-20261025.json). The failed bounded-run receipt is [native-learning-loop-20261025125914063-2d80a4b456.json](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125914063-2d80a4b456.json). Its screenshots include [reader-highlight-tool-active.png](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125914063-2d80a4b456/reader-highlight-tool-active.png), [reader-after-highlight-pointer-drag.png](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125914063-2d80a4b456/reader-after-highlight-pointer-drag.png), [failure-target-1.png](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125914063-2d80a4b456/failure-target-1.png), and [failure-target-2.png](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125914063-2d80a4b456/failure-target-2.png).

Earlier setup and focus failures are preserved as [first-run receipt](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125335351-1ebbd02f41.json), [manifest/trust receipt](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125351246-ff90075912.json), and [post-trust focus receipt](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-artifacts/native-learning-loop-20261025125504507-e94f5dc0fb.json), with their screenshots beside each report. The scratch-vault setup record is [native-loop-scratch-setup.json](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-scratch-setup.json); the original shared-vault ownership blocker is [native-loop-ownership-20261025.json](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-ownership-20261025.json).
