# Windows Native learning-loop probe — progress and blockers

Date: 2026-10-23

## Baseline

- Repository: `XxX-42/26_28_ObReader`
- Work branch: `codex/014-windows-native`
- Base: `cd6e15743d5065dfe53579d658dde18580c84e9f`
- At inspection, local `HEAD` and `origin/main` both resolved to that base; the worktree was clean.
- The base already contains `MAIN_PUSH_PROGRESS_BLOCKERS_2026-10-23.md`, which records the 0.13.0 candidate's broader progress and release limitations.

## Windows Native probe status

The Obsidian CLI is reachable. Read-only checks of the existing `测试插件` Vault reported:

- `pdf-web-reader` is enabled at version `0.13.0`.
- No PDF Reader tab is currently open.
- The Core plugin list does not include `sync`.

No Native learning-flow test was run in this pass. The existing test Vault contains pre-existing user content; it is not a clean isolated Vault for writing learning items or History. The required fresh, Sync-disabled test Vault and new PDF/Markdown fixtures have not yet been created. No user PDF, sidecar, Vocabulary, Context, Review, or History data was changed.

## Acceptance matrix

| Flow / gate | Status | Evidence or blocker |
|---|---|---|
| Highlight → durable Sidecar → Annotation Sidebar → Add Review → Today → same UUID | `NOT_RUN` | Requires an isolated Vault, fresh fixture, and actual UI flow. |
| LingQ → selected sentence → Context → Add Review → Today → exact Context | `NOT_RUN` | Requires isolated Vault and a verified available dictionary/cache; live ECDICT availability has not been inspected. |
| PDF/Markdown rename and move matrix | `NOT_RUN` | No test fixtures or isolated Vault yet. |
| Existing canonical/History bytes unchanged | `NOT_RUN` | No test write occurred; before/after receipts were not collected. |
| Native app/version identity | `UNRESOLVED` | CLI reports the installed plugin, but the previously observed UI title and CDP-reported Obsidian version differed; confirm the exact runtime before acceptance. |
| Product failure found | `NO` | The Native learning paths have not yet been exercised, so no product conclusion is claimed. |

## Next safe action

Create and verify a new dedicated Obsidian Vault with Sync disabled, install only the verified release bundle, add fresh PDF/Markdown fixtures, record baseline hashes, then run the two flows through visible UI interactions. Preserve failures and report platform/runtime identity with every receipt. Do not use the populated `测试插件` Vault as the write target.

## Change boundary

This report is documentation-only. No production source, PDF.js vendor files, WAL/Sidecar protocol, user PDF, existing sidecar, learning data, or installed plugin files were modified by this probe.

## Follow-up Native attempt — 2026-10-23

The earlier “fresh Vault not yet created” status above is historical. A dedicated, Sync-disabled Vault was subsequently created and the built 0.13.0 release bundle was installed there:

- Vault: `D:\Documents\Obsidian\ObReader-0.14-Windows-Native-20261023`
- Obsidian CLI version: `1.14.5 (installer 1.14.4)`; the visible window reported `Obsidian 1.14.5`.
- Core Sync plugin: disabled (`.obsidian/core-plugins.json`, `sync: false`).
- PDF fixture: `Fixtures/reader-loop.pdf`, 1,016,315 bytes; SHA-256 `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`, identical to `tests/fixtures/tracemonkey.pdf` at copy time and after the open attempt.
- Installed release file hashes matched `dist/pdf-web-reader`: `main.js` `5537d534053af3d1b30c99881377307d34ce855e562d63bcbf74e372a92684c6`; `manifest.json` `62221898aed9a2a9c130a66742d20fc62182eee72dffff3ee87c1228a526fbcb`; `styles.css` `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`.

### Viewer bootstrap blocker

Opening `Fixtures/reader-loop.pdf` through the enabled plugin created a `pdf-web-reader-view` and `openFile()` completed in 637.6 ms. The Viewer did not become ready: `iframeLoadCount=1`, `ready=false`, `openAcknowledged=false`, no `.page` elements, and no `PDFViewerApplication` global. After the startup gate, the host displayed “PDF 阅读器未能启动。请检查插件内置的 Viewer 资源是否完整。”

The visible DevTools Console showed three `net::ERR_FILE_NOT_FOUND` failures for the `app://...` resources `obsidian-bridge.js`, `build/pdf.mjs`, and `web/viewer.mjs`. All three corresponding files were present under this Vault’s `.asset-cache`; the plugin reported 406 embedded assets and asset hash `7ea83915a538d7a2218ad9e4797b39a5affe01f59389ac5a1a04e16958cdf367`. Thus the current evidence establishes a local Viewer-resource resolution failure, not an annotation, learning-item, or History failure. The underlying reason the Obsidian `app://` resource requests resolve as file-not-found remains unproven.

The plugin log is retained in the isolated Vault at `.obsidian/plugins/pdf-web-reader/.logs/2026-10-23T13-04-08-805Z-dtvdmi6k-000.log`. Its host trace records asset preparation, successful PDF byte read/identity initialization, and the startup timeout; it contains no annotation operation. First open created only the fresh document route/snapshot/anchor metadata (snapshot annotations `0`, WAL operations `1` with kind `ROUTE`). No Highlight, Context, Review item, or History action was attempted. The fixture PDF hash remained unchanged.

### Acceptance status

| Flow / gate | Status | Evidence or blocker |
|---|---|---|
| Viewer bootstrap / first paint | `BLOCKED` | Three `app://` resources return `ERR_FILE_NOT_FOUND`; no PDF.js application or page is created. |
| Highlight → Sidecar → Sidebar → Review → Today → same UUID | `NOT_RUN` | Cannot reach annotation toolbar or Sidebar until Viewer assets load. |
| LingQ → selected sentence → Context → Review → Today → exact Context | `NOT_RUN` | Cannot reach PDF text layer; vocabulary remains disabled and no learning data was created. |
| PDF/Markdown rename and move matrix | `NOT_RUN` | Reader backlink interaction depends on a running Viewer. |
| Existing canonical/History bytes unchanged | `NOT_APPLICABLE` | New Vault had no pre-existing Vocabulary, Context, Review, or History roots. One empty-document route was initialized; no learning records were written. |
| Product behavior conclusion | `NOT_ESTABLISHED` | The observed blocker is resource loading. No conclusion about the requested learning-loop flows can be drawn. |

No production code was changed to bypass this failure. Next step is to diagnose/fix the `app://` resource resolution path, then rerun the Native flows in this same isolated Vault before attempting any rename/move acceptance. Neither `main` nor the production Vault was modified by this follow-up.
