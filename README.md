# PDF Web Reader for Obsidian

An offline Obsidian plugin containing the modified Mozilla PDF.js Viewer. It
opens vault PDFs and keeps this plugin's annotations in a synced, external
operation log. The original PDF stays byte-for-byte unchanged during ordinary
editing. No local web server, external browser, Python, separately installed
Node.js, or network service is needed at runtime.

Version **0.9.0** is the integrated **WAL-Sidecar v3.2 JSONL test candidate**.
It combines the local 0.8.9 interface/input/close behavior with commit
`2b5d7ad`'s per-device JSONL WAL, durable append acknowledgement, cold replay,
snapshot materialization, and migration barrier. The source PDF remains
immutable. Windows, macOS, and iPadOS use the same three-file package.

JSONL is the current write format. Existing v3.1 and Format 3 files remain
read-only migration/recovery inputs; the candidate does not clean or garbage
collect old data. The sidecar snapshot is a rebuildable cache, and device WAL
anchors, archives, and tails provide recovery. Upgrade all devices that edit a
document before continuing with the 0.9.0 writer. Real cross-device Obsidian
Sync and iPad hardware acceptance remain separate from local automation; see
[the protocol](ANNOTATION_STORE.md), [implementation evidence](WAL_SIDECAR_IMPLEMENTATION.md),
and [acceptance record](GENERAL_ACCEPTANCE.md).

The previous [0.6.0 three-file candidate](dist/pdf-web-reader-0.1general-0.6.0-candidate.zip)
stores immutable per-device annotation operation batches and rebuilds a JSON
snapshot cache from them. Version 0.7.0 adds lossless Float32 encoding and
verified, replayable storage checkpoints; size and tail samples still reject
obvious PDF changes, while full tagged `xxh64-v1` equality plus ordered page
identity is required before external annotations are hydrated. Legacy SHA-256
hashes remain readable; resource integrity, build artifacts, vendor provenance,
and stable document identifiers continue to use SHA-256.

Historical candidate and evidence ZIPs have been moved out of Git and archived separately. Their test reports and checksum metadata remain in this repository; installable three-file outputs and source assets are retained.

The external store is under `00_Archive/20_PDFData`. A copied PDF at a new path
gets a new document identity; Vault rename/move keeps the existing identity.
Older plugin annotations are associated through exact PDF object references;
their existing geometry stays in the immutable PDF until edited, after which
the latest editor payload is recorded externally. If the legacy identity worker
cannot verify those references, the PDF opens read-only. Unchanged source PDF
annotations from other applications remain visible. External applications do
not see plugin annotations in the original PDF; use **将当前 PDF 与外置批注合并导出为独立 PDF** to create a separate annotated copy.

### 0.7.0 annotation storage (historical)

Ink `lines` and `/InkList` `points` remain separate, semantically required data.
Float32 arrays are encoded as little-endian binary Base64 with an explicit item
count, preserving Float32 values (including NaN separators) without lossy point
sampling. Older `Float32Array` JSON wrappers remain readable. The current
four-Ink sidecar fixture shrinks from 78,000 bytes to 25,056 bytes (67.9%) when
converted; this is a measured fixture result, not a size guarantee for every PDF.

The checkpoint stores live annotations separately from a compact deletion ledger
and records exact batch digests, operation digests, known devices, causal heads,
and metadata identity. `.previous.json` holds the prior distinct verified
checkpoint and is not rotated by unchanged reads. Format migration waits for all
active devices to acknowledge the same checkpoint; missing causal references
pause replay instead of replacing state. Covered operation batches are reclaimed
only after a 30-day retention period and only when both current and previous
checkpoints verify. The old snapshot and full legacy index remain readable during
rollout. Missing or stale per-document metadata fails closed rather than minting
a replacement identity. To review devices or explicitly retire one after
confirming it has no unsynced edits, use **审查当前 PDF 的批注同步设备**. Late
writes from a retired device are isolated and surfaced for recovery; they are not
silently applied or collected. None of this storage migration rewrites PDF bytes.

The pinned `xxhash-wasm` 1.1.0 runtime is bundled for offline content-consistency
checks and is not a tamper-detection primitive. See [HASH_BENCHMARK.md](HASH_BENCHMARK.md)
for earlier hash timing samples; those samples are not 0.6.0 save benchmarks.
The prior [0.5.20 three-file package](dist/pdf-web-reader-0.1general-0.5.20-candidate.zip)
decodes large embedded merge ledgers in bounded chunks and hardens PDF.js Ink
drawing-session cleanup against stale pointer listeners and missing in-flight
stroke state. It addresses the `Maximum call stack size exceeded` failure and
the reported pen-state errors; the iPad still needs a device-side recheck.
The prior [0.5.18 three-file package](dist/pdf-web-reader-0.1general-0.5.18-candidate.zip)
added stack-overflow context and the originating PDF merge Worker stack to
diagnostic JSON. The prior [0.5.17 three-file package](dist/pdf-web-reader-0.1general-0.5.17-candidate.zip)
removes full-page fingerprinting from ordinary opens and from later ordinary saves,
including the checkpoint three-way merge. On a 120-page, 16.85 MB synthetic PDF,
the first save fingerprints the legacy baseline once; each of the next nine saves
uses zero baseline pages and one dirty draft page. `prepareLocal` P50/P90 measured
855/1,132 ms on desktop and 727/942 ms in Obsidian mobile simulation. Total save
P50 remained 6.21/5.30 seconds, so the remaining write and recovery work still
dominates. See [the acceptance record](GENERAL_ACCEPTANCE.md) for test results,
memory scope, failure evidence, and the limitation that mobile simulation is not
physical iPad validation.
The prior [0.5.16 three-file package](dist/pdf-web-reader-0.1general-0.5.16-candidate.zip)
added page-count guards and persisted ordered page identities.
The prior [0.5.15 three-file package](dist/pdf-web-reader-0.1general-0.5.15-candidate.zip)
adds per-stage PDF save timing to diagnostic JSON. The prior
[0.5.14 three-file package](dist/pdf-web-reader-0.1general-0.5.14-candidate.zip)
handles a PDF.js draft that removes a saved annotation but still carries the
previous live merge ledger. Only a newer, exact-identity delete operation can
explain that missing annotation; the output persists its deletion tombstone.
Undo/Redo tracks restored saved editors even when PDF.js serializes them to null.
A same-content upsert with a newer operation clock participates in LWW.
Unexplained missing annotations, corrupt base/checkpoint ledgers and uncertain
writes still stop saving. Old recovery candidates remain untouched.

The prior [0.5.13 three-file package](dist/pdf-web-reader-0.1general-0.5.13-candidate.zip)
closes an edited Reader after its latest frozen revision has a verified durable
recovery copy, then completes PDF writeback in a plugin-owned background job.
Saving progress remains visible after the Reader closes. Cross-device merge and
phase-aware disk verification remain required; recovery is retained on failure.
PDF.js serialization and recovery verification still precede closing. App
suspension or termination can stop background work; a durable intent is required
for safe resumption, and uncertain writes must not be blindly replayed.

The prior [0.5.12 three-file package](dist/pdf-web-reader-0.1general-0.5.12-candidate.zip)
accepts verified prefix-delta recovery evidence as well as full recovery PDFs.
The 0.5.11 physical iPad log still showed five blocked saves: its compatibility
filter excluded the delta format emitted by the actual recovery writer.

The prior [0.5.11 three-file package](dist/pdf-web-reader-0.1general-0.5.11-candidate.zip)
addresses the pending-checkpoint save block found in the exported iPad runtime
JSON. Detailed failure evidence is retained locally; physical iPad verification
of this candidate remains pending. Runtime records now export through the visible
diagnostic JSON folder; see [LOCAL_RUNTIME_LOG.md](LOCAL_RUNTIME_LOG.md).

The prior 0.5.10 three-file package（ZIP 已移出 Git）
fixes retained live Ink serialization and commits strokes completed during an
in-flight save before capturing the next revision. Host-confirmed clean flags
do not mean the PDF.js loaded bytes already contain those editors. Save and
recovery both serialize retained editor storage; exact UUID-to-ref binding
remains strict. Recovery acknowledges only verified nonempty serialized bytes.
See [validation and limitations](GENERAL_ACCEPTANCE.md). Physical iPad acceptance
remains pending; the 0.5.9 package is retained for rollback.

The prior 0.5.9 three-file package（ZIP 已移出 Git）
uses verified PDF incremental revisions and binary append where the host supports
it. Shared recovery bases plus checksummed deltas retain complete local branches;
old full-PDF recovery records remain readable. Cross-device UUIDs, clocks,
tombstones, merge behavior and safe close acknowledgement remain shared across
platforms. Unsupported append sources keep a verified full-save fallback.
PDF.js still produces full save buffers, and exact disk validation still reads
the file; this does not make total memory usage proportional only to edits.

The prior 0.5.8 three-file package（ZIP 已移出 Git）
coordinates outstanding sync work before requesting a safe Reader close. It stops
new refreshes, safely settles a running checkpoint/apply, then confirms saving or
a current durable recovery copy before the native tab is detached. Failed
cancellation or unconfirmed edits keep the Reader open; slow PDF serialization
still needs to finish safely.

The prior 0.5.7 package（ZIP 已移出 Git）
blocks finger text selection on iPad PDF pages while an annotation tool is active.
Finger input remains navigation; Pencil text highlighting/drawing, mouse input,
toolbar controls and editable text fields retain their existing behavior.
It also targets continuous Pencil text highlighting across line breaks.
The prior 0.5.6 package（ZIP 已移出 Git）
uses an 80 ms weighted velocity regression, a 4,000 px/s total speed cap, and
350 ms exponential deceleration. Inertia starts at 90 px/s and stops at 10 px/s.
It integrates real animation time, including delayed frames, and cancels on
backgrounding. Finger navigation and Pencil editing remain separate.
Validation and the authorized target replacement are recorded in
[GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md); the 0.5.5 scroll-fix package remains
available for rollback. Physical iPad feel still requires device confirmation.

Version 0.5.6 also fixes saving annotated PDFs with ordinary cross-page links.
After validating page lineage, the merge copier maps existing leaf-page targets
to the output's existing pages; it preserves Link/GoTo destinations and appearance
resources without copying the page tree. Unknown pages and unsafe relationships
remain rejected. The earlier “annotation appearance references a page” error could
actually originate from an unchanged Link destination.

Version 0.5.5 reduces repeated full-PDF work during continuous editing. On the
iPad/iOS input entry, automatic saving waits for three idle seconds and at least
ten seconds between automatic starts; the cooldown adapts to the previous save
cost, up to thirty seconds. Edits during a save remain dirty and return to the
idle scheduler. Manual saving and controlled close bypass the automatic cooldown
while retaining input boundaries and revision acknowledgements. Desktop idle
saving remains one second. Mobile serialization, merge and host write work share
one save slot. Immutable baselines are shared, Worker messages transfer only
owned temporary buffers, and the final Reader releases in-memory sync checkpoints
after its pending work settles. Disk recovery/checkpoint files remain intact.
Longer automatic delays increase the unsaved window during forced termination.
The full frozen Viewer, incremental resource cache and offline three-file package
remain unchanged. Real iPad memory/crash acceptance still requires device testing.

Version 0.5.4 chooses one or two toolbar rows from the available space and
the actual visible controls, replacing the fixed 880-pixel two-row rule. Undo
and redo use the same 16-pixel SVG/CSS-mask mechanism, theme colors and states
as the native PDF.js annotation tools. Finger flicks continue scrolling smoothly
after release and slow to a stop; fresh interaction or document replacement
cancels momentum. Clicking outside a tool parameter popup closes it without
deselecting the tool. Pencil text highlighting constructs a selection from actual
text-layer caret hits and uses the native highlight editor; freehand highlights
are bound to their actual saved InkHighlight objects. Saving, sync and incremental
cache behavior remain shared. Current validation and
delivery records are in [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md).

Version 0.5.3 keeps the persisted **显示阅读器状态栏** setting from 0.5.2
(default off; changes apply to existing Readers and popouts without reload) and
updates the toolbars. The primary toolbar uses 32-pixel **↶** and **↷** controls
instead of **编辑**; delete is under **更多**, and the existing native Save
control is reused without adding a duplicate. Insert Image and Print controls are
hidden in both primary and secondary toolbars; their code and DOM nodes remain
in the frozen Viewer. The zoom group is 64 pixels wide, and the page-number input
is 36 pixels wide plus 8 pixels for each digit beyond four. The four existing
zoom glyphs, percentage and custom zoom values remain. **↕** is described as
**适合整页** (the existing page-fit value), not fit-height. The frozen PDF.js
Viewer version is unchanged; this branch adds the pinned `xxhash-wasm` runtime
dependency without adding a network or CDN requirement.

The 0.5.1 background prewarm and incremental cache index are unchanged. The
frozen 0.5.4 default suite passed 194/194 with natural Node exit 0; the final
offline suite also exited 0. Mac-native UI, prewarm/sync and three-file target
replacement records are summarized in [GENERAL_ACCEPTANCE.md](GENERAL_ACCEPTANCE.md).
That Mac sample does not establish iPad hardware acceptance. Versions 0.5.3, 0.5.2,
0.5.1, 0.5.0 and 0.4.0 remain historical rollback references; preserve the full
plugin backup, settings, recovery files and sync checkpoints when replacing or
rolling back. Native testing uses only `/Users/jiajia/Documents/ObReader-Apple-Test`,
after verifying the actual vault and plugin identity; discover the owned loopback
CDP endpoint for each run rather than assuming a fixed port. The earlier approved
`远程仓库1` replacement was 0.5.4 at the initial 0.5.5 delivery. The subsequent
0.5.5 scroll-fix replacement was separately authorized. The current 0.5.9 delivery
has the same explicit authorization to replace only that plugin's three files,
preserving settings, cache and recovery, with no PDF operations. Save and
close Reader tabs before installing the three matching 0.5.9 files, and preserve
settings, cache, recovery and sync checkpoints. Git push status is tracked
separately in Git history; no GitHub Release is created. Windows and iPad/Pencil
physical-device acceptance remain pending.

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

The complete Viewer is compressed and embedded in `main.js`. After plugin enable,
the plugin prepares its own resources without constructing background
Reader views. Opening a PDF first joins the same task. Resources use a content-hash
versioned directory under its plugin folder using Obsidian's Adapter API.
Missing or corrupted resource files are restored from the shipped payload;
no files are fetched from the network. Existing version directories are not
deleted automatically. A completed extraction is marked only after all files
have been verified. At most four resource operations run together. Valid disk
files are checked before decompressing; only missing or damaged files are
repaired. Successful preparation and verified HTML/CSS/mobile script bytes are
reused for that plugin instance. The completion marker stores verified size,
modification time and creation time for each file. On restart, matching metadata
skips full binary reads; changed files are SHA-256 checked and repaired as needed.
First installation, an older/malformed marker, or an adapter without useful stat
metadata requires full verification to establish a trusted index. Startup
prewarm retries are bounded and can resume on foreground; status, counters and
failure codes are included in the existing diagnostics export. Restoring all
metadata after modifying bytes cannot be detected by this shortcut; consumed
HTML/CSS/module bytes are separately verified once per plugin instance.

**Three files is the distribution constraint, not a permanent disk-file-count
constraint.** Runtime extraction creates the local Viewer files and a
completion marker. The full resource payload includes the Worker, CMaps,
standard fonts, ICC profile, WASM decoders, all translations and images, the
scripting sandbox, debug/sample assets, and their license texts. No Viewer
resources are trimmed for this release.

The application baseline is Obsidian **1.14.4**. The 0.1general / plugin
0.8.0 candidate uses one source and one three-file package for Windows, macOS,
and iPadOS, with `isDesktopOnly: false`. Installed runtime code uses browser
APIs and bundled SHA-256; Node/npm are build and test dependencies only. At
plugin `onload`, Obsidian selects the desktop or mobile entry once for that load.
The desktop entry uses Obsidian resource URLs and popout coordination; the mobile
entry uses blob-backed module and Worker paths without desktop popout
coordination. Editing and annotation operation storage are shared. Daily save,
recovery, checkpoint and close paths do not serialize or write PDF bytes. The
explicit export command creates a new PDF file. XXH64 checks content consistency
only; SHA-256 still protects resources and stable document identifiers. The
frozen Viewer is unchanged, and the packaged runtime includes the legacy
identity-inspection Worker and its third-party notices.

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
button state. The zoom control is a 64-pixel group with **auto**, **1:1**, **↕**
(**适合整页**), and **↔** (fit page width) choices; percentage and custom zoom
values remain available. The page-number input is 36 pixels wide, growing by
8 pixels per digit beyond four. The separate clickable **工具** wheel button is
removed. The primary toolbar shows 32-pixel **↶** and **↷** undo/redo controls
instead of **编辑**. Delete is in **更多**, and the existing native Save button
is reused without a duplicate. Insert Image and Print controls are hidden in
both primary and secondary toolbars while their frozen Viewer code and nodes
remain. The five native annotation tools and middle-button wheel remain.
The confirmed iPad input policy follows the active PDF.js tool: Apple Pencil
input routed as actual `pen` pointer events draws, edits, or erases when an
annotation tool is active; in **NONE** mode it pans the PDF. Finger contact with
the PDF page is navigation pan only; page links, text selection, and annotation
interactions are blocked for fingers. Reader toolbar and sidebar controls remain
usable, as do native input/contenteditable editing exceptions. This preserves the
existing tool and editor behavior. Physical iPad/Pencil event delivery remains
unverified; native CDP touch and Pencil simulation cover automation only. No
pressure, hover, palm-rejection/AI, or Scribble support is claimed.
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
settings. Desktop edits wait for one idle second; the iPad/iOS entry waits for
three idle seconds and uses a ten-to-thirty-second automatic-start cooldown.
After the applicable idle period, text is committed for saving without moving
focus or the caret; active text composition and drawing are allowed to finish. Committing
or blurring text also schedules saving. Right-button erasing waits until the
gesture is released or cancelled before saving the changes.
Press `Cmd+S` on macOS (`Ctrl+S` on Windows), or use **保存到仓库**,
for an immediate manual save. Saves run in order, and only the host-confirmed
revision becomes clean; edits made during a save remain pending. Disabling auto-save
prevents new requests; host-accepted writes finish in order.

The host checks the current disk bytes before overwriting and keeps a recovery
candidate first. Open PDFs react to Vault modification notifications, with
foreground and Reader-activation checks for missed notifications. Local edits
and already-saved local contributions are reconciled against the incoming PDF;
different annotation UUIDs are retained, while the newest completed operation
wins a same-UUID conflict. Timestamps use UTC milliseconds plus logical,
device and operation identifiers. UUIDs and durable deletion records are stored
inside the PDF; existing standard `/NM` fields are preserved. Device clock skew
can affect the winner, although the ordering is deterministic.

Drawing, dragging, erasing and composition finish before a checkpoint is taken.
A newer revision cannot be replaced by an older merge. Refresh stays in the
same Viewer and preserves page, zoom, rotation, scroll position and tool choice;
the previous PDF object's undo history ends at this refresh. No local edits
means a direct refresh, without writing migration metadata just for opening.
Unsupported page/content changes, unproven identities, encrypted or damaged
PDFs, and unsafe tagged-annotation transfers pause automatic merging. Local
checkpoints are retained; newer records can also preserve a replaced local
version. Disk comparison and writing are separate operations and still have a
sync race window. A conflict or failure pauses automatic overwrites. Use
**恢复最近的 PDF 自动保存副本** to recover into a separate PDF under
`PDF Recovery/`. Recovery requires a successful
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

- `plugin/`: Obsidian host, resource cache, sync coordinator and lazy PDF merge Worker/client.
- `viewer-adapter/`: host/Viewer message bridge and iframe styles.
- `plugin/vocabulary/` and `viewer-adapter/vocabulary/`: isolated, optional Vault-local LingQ-style word/phrase study feature; disabled by default. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the PDF-core and vocabulary boundaries.
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
The installed plugin uses Obsidian APIs and standard browser APIs. SHA-256 remains
bundled for resource integrity and stable identities; XXH64 checks PDF, recovery,
and sync content. Both are included in the offline package; it does not load Node
or Electron modules.
The desktop popout entry retains an optional host-provided Electron quit check;
the mobile entry does not install that coordination.
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
# Set this to the loopback endpoint owned by the verified test instance.
# The port is discovered for each run and may change.
export PDF_READER_CDP_URL="http://127.0.0.1:${PDF_READER_CDP_PORT:?set the verified instance port}"
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

The historical 0.4.0 clean-install check refuses a pre-existing extracted cache. It verifies
first-use extraction of its 404 assets, a real Worker, five enabled tools,
offline operation with HTTP/WebSocket requests temporarily blocked, and
recovery of a deliberately corrupted test-owned cache icon. It leaves the
plugin enabled, the test PDF intact, and closes only its own saved test tab.
The 0.5.0 cold/prewarmed/second-Reader and synchronization checks use the
identity-guarded harness retained with the current evidence package; results
and its 406-resource count are recorded in GENERAL_ACCEPTANCE.md.

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
