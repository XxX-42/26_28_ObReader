# Device acceptance matrix — 0.13 candidate

Evidence labels describe the execution environment, not a compatibility claim.
The current Native receipts use Obsidian 1.14.4 on Windows with the 0.13.0
bundle SHA-256 `5537d534053af3d1b30c99881377307d34ce855e562d63bcbf74e372a92684c6`.
Exact installed hash, fixture hashes and reports are in
`P0_NATIVE_ROOT_ACCEPTANCE.md`.

| Scenario | Windows Obsidian | macOS Obsidian | Physical iPad / WKWebView |
| --- | --- | --- | --- |
| Open, five tools, sidecar save, full close/reopen, persistent UUIDs | NATIVE_DESKTOP: PASS, 0.13 run `20261023034628589` | NOT_RUN | NOT_RUN |
| Saved Square secondary move, same UUID | NATIVE_DESKTOP: PASS, same run | NOT_RUN | NOT_RUN |
| Saved annotation delete / Undo / Redo / reopen | NATIVE_DESKTOP: PASS, same run | NOT_RUN | NOT_RUN |
| Underline single, adjacent, multiline; Reader A/B lifecycle | NATIVE_DESKTOP: PASS, `20261023033226925` | NOT_RUN | NOT_RUN |
| FreeText text, geometry, composed ROI, independent export | NATIVE_DESKTOP: PASS, `20261023033319350` | NOT_RUN | NOT_RUN |
| Source SHA-256 / XXH64 unchanged, zero source writes, ordinary serialization zero | NATIVE_DESKTOP: PASS, all three 0.13 runs | NOT_RUN | NOT_RUN |
| First-paint non-resurrection dedicated current-package Native gate | NOT_RUN | NOT_RUN | NOT_RUN |
| Rename/move, offline reopen dedicated current-package Native gate | NOT_RUN | NOT_RUN | NOT_RUN |
| LingQ → Context → Today Review → exact Source Native | NOT_RUN | NOT_RUN | NOT_RUN |
| Learning Highlight → Today Review → exact Source Native | NOT_RUN | NOT_RUN | NOT_RUN |
| Real Pencil, finger scroll and mixed-touch ownership | NOT_RUN | NOT_RUN | NOT_RUN |
| Real offline multi-client Sync, reconnect, conflict and convergence | NOT_RUN | NOT_RUN | NOT_RUN |

Chromium/CDP gesture sequences are **SIMULATED**. Six unprofiled A/B runs
captured 18 declared sequences without an 80 ms assertion violation, but one
B run failed later page-readiness. A later standalone simulated run passed with
a 41.2 ms maximum dispatch delay; the separate CPU-profiled run still failed
with profiler-overhead concerns. See `P0_INPUT_LONGTAIL.md`. These results do
not satisfy physical Apple Pencil or WKWebView gates.

Browser Sidebar, source-routing and input-policy receipts are separate from
Native/device acceptance. In particular, an iOS-policy unit regression for touch
badge activation does not imply a physical iPad pass.

Windows Native and test-Vault deployment are verified for the listed 0.13.0
flows only. Missing physical device, Native learning/source-return, rename/move
and real Sync evidence blocks broader release claims. Nothing in this matrix
authorizes production Vault deployment.
