# Device acceptance matrix — 0.13 candidate development

Evidence labels describe the execution environment, not a compatibility claim.
The Native staging runs below used Obsidian 1.14.4 on Windows with the
0.12.2-labelled P0 staging bundle, not the final 0.13 learning package. Exact
installed hash, fixture hashes and reports are in `P0_NATIVE_ROOT_ACCEPTANCE.md`.

| Scenario | Windows Obsidian | macOS Obsidian | Physical iPad / WKWebView |
| --- | --- | --- | --- |
| Open, five tools, sidecar save, full close/reopen, persistent UUIDs | NATIVE_DESKTOP: PASS, staging run `20261022133417725` | NOT_RUN | NOT_RUN |
| Saved Square secondary move, same UUID | NATIVE_DESKTOP: PASS, same run | NOT_RUN | NOT_RUN |
| Saved annotation delete / Undo / Redo / reopen | NATIVE_DESKTOP: PASS, same run | NOT_RUN | NOT_RUN |
| Underline single, adjacent, multiline; Reader A/B lifecycle | NATIVE_DESKTOP: PASS, `20261022133723949` | NOT_RUN | NOT_RUN |
| FreeText text, geometry, composed ROI, independent export | NATIVE_DESKTOP: PASS, `20261022133626126` | NOT_RUN | NOT_RUN |
| Source SHA-256 / XXH64 unchanged, zero source writes, ordinary serialization zero | NATIVE_DESKTOP: PASS, all three runs | NOT_RUN | NOT_RUN |
| First-paint non-resurrection dedicated current-package Native gate | NOT_RUN | NOT_RUN | NOT_RUN |
| Rename/move, offline reopen dedicated current-package Native gate | NOT_RUN | NOT_RUN | NOT_RUN |
| LingQ → Context → Today Review → exact Source Native | NOT_RUN | NOT_RUN | NOT_RUN |
| Learning Highlight → Today Review → exact Source Native | NOT_RUN | NOT_RUN | NOT_RUN |
| Real Pencil, finger scroll and mixed-touch ownership | NOT_RUN | NOT_RUN | NOT_RUN |
| Real offline multi-client Sync, reconnect, conflict and convergence | NOT_RUN | NOT_RUN | NOT_RUN |

Chromium/CDP gesture sequences are **SIMULATED**. Six unprofiled A/B runs
captured 18 declared sequences without an 80 ms assertion violation, but one
B run failed later page-readiness. The separate CPU-profiled run failed; profiler
startup contaminated timestamps. See `P0_INPUT_LONGTAIL.md`. These results do
not satisfy physical Apple Pencil or WKWebView gates.

Browser Sidebar, source-routing and input-policy receipts are separate from
Native/device acceptance. In particular, an iOS-policy unit regression for touch
badge activation does not imply a physical iPad pass.

Final-package Windows Native and safe test-Vault deployment require fresh
version/hash receipts after complete integration. Missing physical device or
real Sync evidence blocks those release claims even if the local candidate is
usable. Nothing in this matrix authorizes production Vault deployment.
