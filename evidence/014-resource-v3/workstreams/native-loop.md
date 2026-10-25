# Native learning loops and route matrix: workstream B

Observation time: 2026-10-25 12:31:51 UTC

Worktree: `codex/014-ws-b-native` at `197cd7d653967eb0a2d04af3c91470163949e680`

## Result

The installed 0.14.0 three-file package exactly matches this worktree’s `dist/pdf-web-reader` candidate. The foreground Native renderer is also an owned Obsidian 1.14.5 process on `ObReader-Apple-Test`, with Sync off, the plugin disabled, no Reader leaves, and a visible Markdown window that owns document and window focus.

The Native UI run stopped before any fixture, route, rename, or move action. Two other Obsidian processes were open; one had another renderer for `ObReader-Apple-Test`, while a sibling process also exposed a renderer for a different vault. The runner’s `assertSiblingTestVaultProcessesQuiescent()` at [native-learning-loop.mjs](/private/tmp/obreader-014-ws-b-native/tests/native-learning-loop.mjs:2359) connects to every sibling process and calls `Runtime.evaluate` on each app page before checking whether its vault path matches the test vault. That would query the foreign-vault renderer. I did not run that preflight or send UI input into any sibling renderer.

## Candidate and saved receipts

| File | Current candidate SHA-256 | Installed SHA-256 | Result |
| --- | --- | --- | --- |
| `main.js` | `d57f5e1e7e1328c88168d8b28e357ee35edd515b149725a9df96e464feb4b257` | same | PASS |
| `manifest.json` | `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675` | same | PASS |
| `styles.css` | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` | same | PASS |

I ran the offline candidate-file assertion and audited the nine saved `completeDirectionMatrix` reports against these exact hashes. The candidate-file assertion passed; none of the nine reports match this candidate. All eight route stages therefore remain `NOT_VERIFIED`. The saved report named `native-learning-loop-current-package-20261025.json` uses `main.js` hash `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`, so its earlier UI evidence cannot be reused as current-candidate evidence.

## Stage status

Every stage below carries the runner’s five-direction route assertions. None was started because the sibling preflight would inspect the foreign-vault renderer.

| Current-package Native stage | Status |
| --- | --- |
| `full-pdfrename` | NOT_RUN |
| `full-foldermove` | NOT_RUN |
| `full-mdrename` | NOT_RUN |
| `full-mdmove` | NOT_RUN |
| `full-bothmove` | NOT_RUN |
| `full-closedmove` | NOT_RUN |
| `full-openmove` | NOT_RUN |
| `full-owned-process-restart` | NOT_RUN |

The real process restart is a separate second phase: the runner requires the exact-candidate first-phase receipt, a new main PID using the same owned profile, and proof that the previous PID exited. No process was restarted.

## Exact checks and side effects

- **PASS:** Read-only Native owner snapshot for foreground PID `27240` in profile `/private/tmp/obreader-014-runtime/profile-1.14.5`; exact vault identity, Obsidian 1.14.5, visible/focused document and window ownership, Sync disabled, plugin disabled/unloaded, and zero Reader leaves.
- **PASS:** `assertNativeCandidateFiles` for the candidate dist files and installed test-vault files.
- **PASS (incomplete):** Offline `auditNativeRouteMatrixEvidence` over nine saved matrix reports; zero exact-candidate matches, eight gaps.
- **NOT_RUN:** Native 8-stage × 5-route UI matrix, blocked before Native input by the sibling-renderer safety condition above.
- **NOT_RUN:** Actual owned Obsidian process restart; blocked because the first phase was not run.
- **NONE:** No screenshots created. No UI input, fixture writes, plugin enablement, vault writes, PDF content reads, or process restarts were performed by this workstream.

Machine-readable process and audit details are in [native-loop-ownership-20261025.json](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/workstreams/native-loop-ownership-20261025.json). The earlier [owner-gate recheck](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/native-owner-gate-recheck-20261025.json) and [current-package learning-loop receipt](/private/tmp/obreader-014-ws-b-native/evidence/014-resource-v3/native-learning-loop-current-package-20261025.json) are retained as prior evidence; the latter is for a different `main.js` hash.
