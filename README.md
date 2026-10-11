# PDF Web Reader for Obsidian

An offline Obsidian plugin containing the modified Mozilla
PDF.js Viewer. It opens PDFs from the vault and saves standard PDF annotations
back to the same file. No local web server, Windows launcher, external browser,
Python, separately installed Node.js, or network service is needed at runtime.

The current work is the **0.1general unified candidate (plugin
0.4.0)** for Windows, macOS, and iPadOS. [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md)
is the current scope and validation guide. The 0.3.0 iPad package and mouse
matrix in [IPAD_ACCEPTANCE.md](IPAD_ACCEPTANCE.md), and the macOS 0.2.0 record in
[MACOS_ACCEPTANCE.md](MACOS_ACCEPTANCE.md), are historical. No physical-device
acceptance is claimed for Windows or iPad; iPad deployment and final device
acceptance remain for the user.

The frozen complete default run finished with all product function assertions
passing (133 total; 131 passed and 2 test-process cleanup statuses failed).
The toolbar's external-signal cleanup and FreeText child exit code 2 are tracked
as test-infrastructure anomalies and do not negate the functional result. The
designated Mac test-vault functional checks are complete: the lifecycle suite
passed 19/19, and all mobile-control feature assertions passed. That controls
report remains marked `incomplete` because its final `emulateMobile(false)`
cleanup returned `Promise was collected`; it is not reported as a fully passed
script run. The candidate meets the revised functional acceptance gate, while
Windows and iPad physical-device acceptance remain pending. Candidate ZIPs,
hashes, and evidence are recorded in
[GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md#冻结默认全套与候选文件). It is
approved for the normal push to `main`; no release or main-vault deployment is
planned. The actual commit is recorded in Git history.

## Install: exactly three release files

For the current candidate, use the package produced by the current
build and follow the [general candidate installation guide](GENERAL_ACCEPTANCE.md).
The 0.3.0 ZIP described in [IPAD_ACCEPTANCE.md](IPAD_ACCEPTANCE.md) is a historical package. Public
releases use the same three matching files:

- `main.js`
- `manifest.json`
- `styles.css`

Put only those three files into
`<vault>/<configDir>/plugins/pdf-web-reader/` and enable **PDF Web Reader**.
The default configuration directory is `.obsidian`, but the plugin uses
Obsidian's actual `Vault.configDir` rather than assuming that name.

The complete Viewer is compressed and embedded in `main.js`. On first PDF
open, the plugin verifies and extracts its own resources into a content-hash
versioned directory under its plugin folder using Obsidian's Adapter API.
Missing or corrupted resource files are restored from the shipped payload;
no files are fetched from the network. Existing version directories are not
deleted automatically. A completed extraction is marked only after all files
have been verified. A failed extraction can be retried.

**Three files is the distribution constraint, not a permanent disk-file-count
constraint.** Runtime extraction creates the local Viewer files and a
completion marker. The full resource payload includes the Worker, CMaps,
standard fonts, ICC profile, WASM decoders, all translations and images, the
scripting sandbox, debug/sample assets, and their license texts. No Viewer
resources are trimmed for this release.

The application baseline is Obsidian **1.14.4**. The 0.1general / plugin
0.4.0 candidate uses one source and one three-file package for Windows, macOS,
and iPadOS, with `isDesktopOnly: false`. Installed runtime code uses browser
APIs and bundled SHA-256; Node/npm are build and test dependencies only. At
plugin `onload`, Obsidian selects the desktop or mobile entry once for that load.
The desktop entry uses Obsidian resource URLs and popout coordination; the mobile
entry uses blob-backed module and Worker paths without desktop popout
coordination. Editing, save/recovery, and pointer logic are shared. The 402-file
frozen Viewer is unchanged, and the packaged runtime contains 404 assets.

These implementation details do not establish physical-device acceptance.
Windows and iPad device acceptance remain pending, and desktop mobile emulation
does not establish WKWebView or actual mouse-button delivery. See
[GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md) for current validation status and
the [historical iPad 0.3.0 installation and mouse matrix](IPAD_ACCEPTANCE.md).
The macOS 0.2.0 rollback package and [historical Mac acceptance evidence](MACOS_ACCEPTANCE.md)
remain available.

## Open and edit PDFs

While enabled, ordinary PDF file opens in Obsidian use this viewer. The command
palette action **在 PDF 阅读器中打开当前 PDF** and PDF context-menu action
**使用 PDF 阅读器打开** remain available. A built-in PDF tab already open before
enabling is not forcibly replaced; close and reopen it. Markdown inline PDF
embeds still use Obsidian's built-in rendering. This plugin does not change
Windows' system-wide PDF file association.

| Key | Tool               |
| --- | ------------------ |
| `1` | Underline / 下划线 |
| `2` | Rectangle / 矩形框 |
| `3` | Highlight / 荧光笔 |
| `4` | Ink / 自由画笔     |
| `5` | Text box / 文字框  |

Both the number row and numeric keypad are supported. Press the active tool's
key again or backquote to leave it. Typing digits inside an input or editable
text does not switch tools.

The desktop mouse controls incorporated from Windows `c52e522` are retained.
Hold the middle mouse button to preview the six-sector tool wheel and release
over a sector to select it. Releasing in the center leaves the wheel open for
a left-click selection; the top sector, Escape, or an outside click closes it.
Dragging the right mouse button temporarily erases annotations and restores
the previous tool on release. A regular right-click retains the context menu
and does not create annotations. On macOS use `Cmd+Z` and `Cmd+Shift+Z` for
undo and redo.

The unified candidate selects pointer behavior from the actual pointer type and
button state. On iPad, the **工具** button opens a clickable wheel and **编辑** provides
undo, redo, delete, and save, giving touch-free controls when the mouse has no
middle button or there is no external keyboard. Physical iPad behavior remains
unverified. Buttons intercepted by iPadOS or a mouse mapping cannot be recovered
by the plugin; exported input diagnostics report which events reached the Viewer.
On mobile, use the plugin setting **导出移动端诊断 → 导出 JSON** or the command
**导出 PDF 阅读器诊断 JSON**. Reports are saved under `PDF Reader Diagnostics/` and
include startup stages, browser capabilities, resource verification, Worker mode,
and pointer/button counters. They contain no PDF content or file paths.

Version 0.1.4 gives the active creation tool priority over existing annotation
bodies: underline/highlight can select the PDF text beneath them, and drawing
tools can start inside an existing annotation. Leave the tool, then double-click
an annotation to explicitly edit its object. Toolbars, comments, the eraser,
and an actively focused text-box input retain their own interactions.

Automatic saving is **enabled by default** and can be disabled in the plugin
settings. Completed edits are combined after one second. After one second of
text inactivity, the text is committed for saving without moving focus or the
caret; active text composition and drawing are allowed to finish. Committing
or blurring text also schedules saving. Right-button erasing waits until the
gesture is released or cancelled before saving the changes.
Press `Cmd+S` on macOS (`Ctrl+S` on Windows), or use **保存到仓库**,
for an immediate manual save. Saves run in order, and only the host-confirmed
revision becomes clean; edits made during a save remain pending. Disabling auto-save
prevents new requests; host-accepted writes finish in order.

The host checks the current disk bytes before overwriting and keeps a recovery
candidate first. A conflict or failure pauses automatic overwrites. Use
**恢复最近的 PDF 自动保存副本** to recover into a separate PDF under
`PDF Recovery/`; inspect and merge it yourself. Recovery requires a successful
candidate write and cannot protect against process termination before that point.
Renaming or moving an open PDF retains its document identity and updates its
save target. A controlled close waits for automatic saves when enabled; disabled
or paused saving persists a recovery draft without writing the original. The
Reader stays open if that confirmation fails. Closing lets an active stroke or
composition finish, then suspends new input until teardown or cancellation.
On desktop, closing a verified Obsidian popout prepares all of its Readers before the
window is destroyed; one failed confirmation keeps the window open. This
requires the tested SDK window/split relationship. If that relationship cannot
be verified, the plugin warns you to save or recover before closing the window.
Moving a Reader through the verified `workspace.moveLeafToPopout` entry point
also prepares it first. The new window reloads the confirmed PDF or exact durable
draft, retaining its revision, dirty state and any conflict pause. An unguarded
DOM reload can restore only the last durable checkpoint; additional edits may
be lost. Returning a Reader to the main window through other SDK paths has not
been verified. Save or recover before using those paths.
Save and confirm success before
closing, disabling or updating. A forced exit may bypass async close handling.

Disk comparison and the subsequent write are separate operations: another
sync process can still race between them. Post-write verification detects some
races, but the Vault API provides no atomic compare-and-swap guarantee.
Standalone file picking and PDF replacement by drop remain intercepted.

Version 0.1.3 fixes parallel/double underline strokes when a selection spans
complete text-layer spans. Underlines now use only selected text-node rectangles,
not the additional inline container rectangles returned by browser ranges.
Highlight selection is unchanged. Previously saved underline geometry is not
rewritten automatically; delete and redraw an affected annotation if needed.

## Development

The current Mac development checkout is
`/Users/jiajia/Documents/Documents/Codes/26_7_PdfRD_OB`.
The frozen PDF.js tree is retained and the installed runtime uses browser APIs.
Each plugin load selects one platform entry from Obsidian's platform state;
changing the Mac mobile-emulation state requires reloading the plugin. The mobile
entry does not install desktop popout coordination.

- `plugin/`: Obsidian host and embedded-resource runtime source.
- `viewer-adapter/`: host/Viewer message bridge and iframe styles.
- `vendor/pdfjs-generic-legacy/`: complete frozen PDF.js Viewer snapshot.
- `scripts/`: deterministic packaging and safe deployment.
- `tests/`: packaging, host, offline browser, and native Obsidian checks.
- `dist/pdf-web-reader/`: generated three-file release package.

The frozen snapshot came from fork commit `c80e5a952` on branch `windows`;
the fork retains underline and square editor/serialization support. Its
SHA-256 inventory is verified before packaging. The upstream core/display
runtime and Worker must remain matching versions; Obsidian's private internal
PDF.js runtime is not used as a replacement.

```powershell
npm ci
npm run build
npm test
npm run test:offline
```

Node 22.12 or newer, npm and `puppeteer-core` are development/test dependencies
only. The browser test driver is pinned to Puppeteer 25.12.0, whose supported
Chrome line is 154. The native Obsidian connection is verified separately because
it uses the application's embedded Chromium.
The installed plugin uses Obsidian APIs, standard browser APIs, and bundled SHA-256;
it does not load Node or Electron modules.
The offline browser harness may create a temporary local test server to serve
the extracted artifacts; that server is not part of the installed plugin.

## Test-vault deployment

The Windows test-vault snapshot is included under
[`test-vault/测试插件`](test-vault/README.md), with configuration, the 0.1.4
plugin, saved test PDFs and a SHA-256 inventory. Copy it to a separate test
location before opening it in Obsidian. Generated Viewer caches are excluded;
the three-file plugin regenerates them locally. This snapshot preserves the
historical Windows 0.1.4 test vault. For the current unified candidate, use the
[general acceptance guide](GENERAL_ACCEPTANCE.md); the snapshot's age does not
describe the current mobile implementation.

The Mac target is the independent test vault
`/Users/jiajia/Documents/ObReader-Apple-Test`, copied from the complete outer
snapshot and verified against all 60 inventory entries before opening.
Save and close every Reader and disable the plugin before deployment.
The deploy preflight verifies the exact vault path and configuration directory,
and refuses active Reader tabs or an enabled plugin. It backs up the entire
old plugin outside Obsidian's scan, then installs only the three release files.

`OBSIDIAN_VAULT_PATH`, `OBSIDIAN_VAULT_NAME`, `OBSIDIAN_CONFIG_DIR`,
`PDF_READER_OBSIDIAN_CLI`, `PDF_READER_CDP_URL` and `PDF_READER_CHROME` configure
test/deploy entry points. Every native action checks the target vault identity;
the macOS path allowlist excludes user main vaults. For the isolated instance:

```sh
export OBSIDIAN_VAULT_PATH=/Users/jiajia/Documents/ObReader-Apple-Test
export OBSIDIAN_VAULT_NAME=ObReader-Apple-Test
export OBSIDIAN_CONFIG_DIR=.obsidian
export PDF_READER_CDP_URL=http://127.0.0.1:9226
npm run deploy
npm run test:native:background
npm run test:native:lifecycle
```

`PDF_READER_NATIVE_CASES=matrix,popout` runs selected lifecycle groups. The
allowlist also includes `manual-save`, `autosave`, `inflight`, `rename`, `stale`,
`external-conflict`, `failed-save`, `close-flush`, `close-recovery`,
`close-recovery-write-failure`, `switch`, `eraser`, `popout-move` and
`popout-close`. Omit it to run all groups. Reports
list executed and completed groups; an interrupted group does not count as a
pass. Keyboard chords use actual Puppeteer key events in the native renderer.

Native tests use the user's enabled official Obsidian CLI/CDP. They create
timestamped PDF and other fixture copies under `PDF迁移测试/` and retain them.
JSON results and screenshots are under ignored `tests/artifacts/`. Tests
must refuse to unload/replace views with unsaved user changes.

For a clean-install release acceptance check, first save and close existing
Reader tabs, disable the plugin and deploy the three-file output, then run:

```sh
npm run test:native:release
npm run test:native
```

Keep the Obsidian test window visible (not minimized or hidden in the tray):
PDF.js intentionally defers rendering while its document is hidden. When hot
deploying a different manifest version into an already-running Obsidian,
refresh the plugin's cached manifest once with the official CLI
`plugin:reload id=pdf-web-reader`, then disable it again before the clean-install
test. The installed disk files, manifest map and running instance must agree.

To run the functional/native-routing tests without bringing Obsidian to the
system foreground, use `npm run test:native:background`. The development-only
wrapper temporarily enables CDP `Emulation.setFocusEmulationEnabled` in the
explicit test-vault renderer, runs the real PDF.js tools and save/reopen tests,
and disables focus emulation in `finally`. Its report identifies this as
background focus-emulated testing, not an OS-foreground test. It does not
change PDF permissions, browser security settings, or production plugin code.

The clean-install check refuses a pre-existing extracted cache. It verifies
first-use extraction of all 404 assets, a real Worker, five enabled tools,
offline operation with HTTP/WebSocket requests temporarily blocked, and
recovery of a deliberately corrupted test-owned cache icon. It leaves the
plugin enabled, the test PDF intact, and closes only its own saved test tab.

## Release and compatibility notes

The complete pre-migration source and full-folder artifact are preserved by
Git tag `full-viewer-0.1.1`. New releases contain exactly the three files
listed above, while the repository retains the complete vendor resources and
readable extraction/build code. See the official
[release workflow](https://docs.obsidian.md/plugins/releasing/submit-plugin).

Three-file delivery alone is **not a guarantee of admission to the Community
Plugins directory**. Official developer policies prohibit self-installing or
self-updating plugins/dependencies. This plugin never downloads, installs or
updates code from the internet; it materializes resources already shipped in
its own release. Community review still needs to assess that implementation
and the other submission requirements. It has not been submitted or approved.
See [developer policies](https://docs.obsidian.md/community-directory/developer-policies)
and [manifest guidance](https://docs.obsidian.md/Reference/Manifest).

The custom reader extends the public `EditableFileView`. Default PDF opens
are routed by a reversible, app-scoped wrapper of
`WorkspaceLeaf.setViewState()`. Reader transitions and `WorkspaceLeaf.detach()`
wait for a document-specific save/recovery handshake before SDK teardown;
the built-in PDF extension registration is
not removed. This wrapper is a monkey patch, **not an official dedicated API
for replacing core PDF behavior**. Other plugins wrapping the same method
or later Obsidian versions can conflict. Revalidate after Obsidian upgrades.
Disable restores the original method if it is still the active wrapper;
otherwise the old wrapper becomes an inactive pass-through.

PDF document scripting and remote AI/alt-text model downloads are disabled.
The complete resource snapshot is nevertheless retained.

## License

New plugin code is Apache-2.0; see `LICENSE` and `NOTICE`.
Bundled Mozilla PDF.js is Apache-2.0. Fonts, CMaps, colour libraries and image
decoders also carry their original license texts in the vendor snapshot and
embedded payload. Packaging preserves those notices; it does not relicense
third-party assets.
