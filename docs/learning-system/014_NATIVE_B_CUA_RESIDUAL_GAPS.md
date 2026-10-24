# Native B: passive foreground harness and current evidence gaps

This is a test-only preparation and saved-evidence audit. No Native UI run,
window activation, plugin reload, deployment, Vault write or production change
was performed by this continuation.

## Source and candidate binding

- Integration base: `65de915b306954a160ed99002f33ada639cebd4e`.
- Work branch: `codex/014-native-b-cua-compatible`.
- The runner now records its actual Git branch/HEAD and owned main PID.
- Before installing test isolation, it requires the exact test Vault renderer
  to be visible **and focused**. Window selection is an external CUA action;
  the runner has no Swift, AppleScript, Launch Services or browser window
  activation path.
- A version match alone is insufficient. The installed `main.js`,
  `manifest.json` and `styles.css` must match the supplied candidate directory
  by SHA-256. `PDF_READER_NATIVE_PLUGIN_DIST` may select that directory.
- The existing runner's `restart` route is explicitly a plugin reload. Its
  report remains `nativeAcceptance.status=NOT_VERIFIED` because this runner
  does not itself execute the complete five-direction matrix or restart the
  owned Obsidian process.

At `2026-10-24T12:30:01.041Z`, a read of only the Apple test plugin's three
release files matched this base's candidate bytes:

| File | SHA-256 |
|---|---|
| main.js | `3a04c37e38d133b5dafd0c5f738d6514c4cbe2ec1ccb9c54c536d0a595546602` |
| manifest.json | `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675` |
| styles.css | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` |

The installed manifest says `0.14.0`. These disk hashes prove the deployment
bytes at that instant; they do not prove that a running renderer loaded them.
The read target was
`/Users/jiajia/Documents/ObReader-Apple-Test/.obsidian/plugins/pdf-web-reader`.

## What the existing receipts actually prove

| Evidence | Scope proved | Current-candidate limitation |
|---|---|---|
| Windows branch `origin/codex/014-windows-native-test`, `adf5223` | Committed report records eight stages x five UI directions, actual owned-process PID change `39052` to `35280`, independent replay and byte invariants. | Stage 3-8 package main SHA is `a7d74076383c4dc0cbc5c161021cfb72cc0556ad48a663a8b79dd6f3fd78137b`; this differs from the current candidate. Raw Windows disk receipts were not available to this local continuation and were not revalidated here. |
| Mac attached `20261024051249450-cb065aab2b` | Actual UI loops and open-move five directions; cleanup, default data and preserved run checks passed. | main SHA `7009450d44a4b7cfb3bb3821a2b6edeccdcbac65993869f6d8ee4cfe4521b0ef`; shared process; actual process restart explicitly NOT_RUN. |
| Mac attached `20261024054108948-4f5d276ba6` | Actual UI loops and open-move five directions; canonical/PDF invariants passed. | main SHA `646b004534260291fc95df0784fc5af5183a0495d344788db3bf34b86570b3c1`; shared process; actual process restart explicitly NOT_RUN. |
| Mac exclusive continuation `20261024081948043` | `full-pdfrename` five-direction receipt passed on its recorded package. | main SHA `446f4612ecf17bdd59642bf80e2a753fdd475a5a9f8945d8bbe525ec1de85183`; the next folder-move backlink exact-source check failed. |
| Mac exclusive continuation `20261024082748140` | Failed attempt retained. | CDP timeout and failed cleanup; cannot serve as completed acceptance. |
| Mac exclusive continuation `20261024084112738` | Failed preflight retained. | main SHA `70429136ba4e08ddd915a66a75cf0f8944115682c2a47131ca57c12a33450605`; exact owned renderer was hidden. No current matrix PASS. |

Mac report paths above are under the separate
`native-final-resume/tests/artifacts/` worktree. The historical six-stage
matrix under `evidence/native-final-resume/` also uses older packages. Old
successes are retained as useful evidence, not promoted to a pass for the new
candidate.

The four cited attached/current-exclusive saved reports were audited against
the current three-file candidate with
`scripts/audit-native-learning-evidence.mjs`. Result: `INCOMPLETE`, zero
matching reports, all eight current route stages `NOT_VERIFIED`. The command's
exit code 1 is the expected incomplete-evidence result, not a new product
assertion failure.

## Window and continuation constraints

The preceding read-only Native review observed owned PID `40843`, profile
`macos-native-profile-exclusive-20261024-0120`, with the exact Apple test Vault,
title `learning - ObReader-Apple-Test - Obsidian 1.14.5`, `visibility=hidden`,
`focused=false`, plugin disabled, Sync disabled and no Reader views. This
continuation did not poll or interact with the live renderer again.

The CUA macOS API available in this session selects an app by name/path/bundle
ID. It does not provide PID targeting or `listWindows()` on macOS. The observed
Window menu did not list the learning window. ROOT owns the shared UI and must
obtain a visible, focused exact owned test window through supported CUA before
Native input can resume.

The dirty `native-final-resume/tests/native-learning-loop.mjs` contains a much
larger matrix continuation driver and an `activateExactOwnedMainWindow()`
function that executes Swift `NSRunningApplication.activate`. That activation
path must not be imported or run under the current CUA-only interaction rule.
This branch does not copy that unreviewed driver. Its passive foreground helper
can replace the active focus operation when the remaining driver is reviewed.

## Exact remaining acceptance work

1. Bind the Native run to the current candidate's three SHA-256 values and
   actual runtime version after externally selecting the owned test window.
2. Reverify Highlight -> durable Sidecar -> Sidebar -> Review -> Today -> same
   UUID, and actual LingQ status -> full sentence Context -> Review -> Today ->
   exact source, on that candidate.
3. Complete all eight route stages with all five directions on that candidate,
   including open-move. Each stage needs the exact current Markdown slice,
   exact authenticated navigation request/target, selected original Sidebar
   UUID, unchanged canonical/default-tree bytes and unchanged source PDF.
4. After controlled close, complete an actual owned-process restart. Require
   the same owned profile, recorded termination of the previous owned main
   process, a different main PID, and all five directions again. The saved
   `processRestart` receipt must explicitly contain
   `kind:"owned-process-restart"` and `previousProcessExited:true`, in addition
   to both PIDs and the profile identity; a new PID by itself is insufficient.
   A plugin disable/enable or renderer reload cannot satisfy it.
5. Revalidate raw Windows receipts for the current candidate rather than using
   the committed old-package completion report as a new package's acceptance.

The new offline auditor rejects missing directions, stale authenticated
navigation receipts, different PDF paths, altered exact Context quotes,
artifact mismatches, incomplete cleanup and same-PID/plugin-only restarts.
It audits saved receipts; it never creates a Native PASS without those runs.

## Checks executed by this continuation

- `node --test tests/native-learning-acceptance.test.mjs`: 7/7 pass.
- Acceptance, isolation and controlled-close unit tests together: 22/22 pass.
- The same tests plus `tests/test-gate-runner.test.mjs`: 30/30 pass; the gate
  manifest classifies the new test exactly once.
- `node --check tests/native-learning-loop.mjs`: pass.
- `node --check scripts/audit-native-learning-evidence.mjs`: pass.
- `git diff --check`: pass.
- The saved `08:19` partial report, audited against its own historical package,
  correctly accepts only `full-pdfrename` and leaves seven gaps. Auditing it
  against the current package rejects it as an artifact mismatch.
- New acceptance tests are registered in the Fast gate. Full Fast/Browser/Race
  and live Native were not run by this continuation.

`IPAD=DEFERRED_BY_SCOPE`. Real multi-client Sync remains unverified.

## 2026-10-25 continuation: current gate and window-selection result

The current branch is `codex/native-openmove-resume-scroll-audit` at
`7ab911286526c3835f169a7bff5ffac74e52d3f4`, matching
`origin/feature/0.14-native-learning-dictionary-20261023`. No production files,
Vault records, or source code were changed in this continuation.

The exact Native runner process remains PID `69139`, using the owned profile
`macos-native-profile-exclusive-20261024-0120`. I switched Obsidian through its
Window menu and restored the visible `ObReader-Apple-Test` `learning` window to
the foreground. The menu exposed only that window and the `远程仓库1` window; it
did not expose PID `69139`'s hidden window. Mission Control via CUA did not
change that. The runner therefore cannot pass its visible-and-focused
preflight, and the five-direction `full-openmove` and actual owned-process
restart stages remain `NOT_RUN` for the current candidate.

The rebuilt candidate and test-Vault plugin files are not byte-identical:

| File | Candidate SHA-256 | Test-Vault SHA-256 |
|---|---|---|
| `main.js` | `8606b6cdf30184260833993ce7c349ad2216e2c4fa1498d9a7d25e9055b249a0` | `0cad7558cf24157d3658df32fc7e9d467fb44da89880b9bca6887d946180f77c` |
| `manifest.json` | `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675` | same |
| `styles.css` | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` | same |

The hidden owned process is still running against the shared test Vault, so I
did not replace plugin files while it may be using them.

### Gate results

- `npm run test:gates`: **222/228 passed, 6 failed, 0 skipped**; Fast 120/120,
  Browser 27/28, Race 75/80. Acceptance is not eligible.
- The Browser failure was the simulated iPad pointer-latency assertion: gesture
  21 observed a 104.1 ms pointer-up delay against the 80 ms bound. A standalone
  `node --test tests/ipad-pointer-policy.test.mjs` passed 1/1. An earlier
  standalone Browser gate also passed 28/28, so this long-tail result remains a
  real gate observation whose cause is not isolated to production code.
- The five Race failures were browser cleanup/DevTools startup or test timeout
  failures. Running `tests/autosave-mobile-regression.test.mjs` and
  `tests/highlight-multiline-regression.test.mjs` individually passed 1/1 each.
- A fresh standalone Browser gate still reported 27/28 because of the same
  80 ms simulated pointer threshold. Test source fingerprints were unchanged.

The current candidate has no matching Native receipt for `main.js` SHA
`8606b6cdf30184260833993ce7c349ad2216e2c4fa1498d9a7d25e9055b249a0`. Previous
Native reports use different package hashes and do not close the current gaps.
No merge to `main` or deployment was performed.
