# PDF.js Viewer snapshot

This directory contains the production `generic-legacy` viewer artifact used by
the Obsidian plugin. It was copied from the local PDF.js fork at commit
`c80e5a952` (`windows`, pushed as `xxx42/windows`) on 2026-10-07. The artifact
contains the fork's underline and square annotation support and the `1`–`5`
tool shortcuts.

The snapshot includes the complete viewer and runtime resources from
`build/generic-legacy/{web,build}`: PDF.js modules and worker, locale files,
CMaps, ICC profiles, standard fonts, images, and WASM decoders. The build is
frozen here so packaging never builds in or writes to the original repository.

The upstream PDF.js code is licensed under Apache-2.0; see `LICENSE`.

## Audited local correction: plugin 0.1.3

The display bundle's underline-selection path now collects rectangles from
selected text nodes, clipped to the original selection ranges. A browser range
spanning complete text-layer spans can also return inline container rectangles
with different line heights; interpreting both as underline quads produced
parallel strokes. Highlight selection and the core/Worker, saved annotation
format, and existing annotations are unchanged. `SHA256SUMS.json` pins this
corrected snapshot; the original checkout is not modified.

## Audited local correction: plugin 0.1.4

The display bundle and viewer distinguish creation-priority hit testing from
explicit object editing. Existing editor bodies and drawing overlays yield to
the active text-selection or creation tool; explicit double-click editing,
focused FreeText input, toolbars, comments, and erasing remain separate paths.
Same-mode explicit editing requests are no longer discarded. These are local
interaction changes to `build/pdf.mjs`, `web/viewer.mjs`, and `web/viewer.css`;
the PDF Worker and serialized annotation format are unchanged.

## Local interaction addition: plugin 0.1.5

The viewer module and stylesheet add a middle-button six-sector tool wheel,
replacing only middle-button temporary highlighting. Right-button highlighting,
the PDF Worker and annotation serialization remain unchanged. Resources remain
embedded in the same three-file release and pinned by SHA256SUMS.json.

## Local interaction update: plugin 0.1.6

Middle-button movement previews a sector; selection is committed only on
release. Right-button dragging activates the existing annotation eraser with
the previous tool restored on release or cancellation. Simple right-clicks
retain the context menu. The old temporary highlight gesture handlers are
removed. The PDF Worker and annotation serialization are unchanged.

## Local save support: plugin 0.1.7

The display bundle exposes FreeText `commitForSave()` to capture edited text
without disabling edit mode or moving focus and the caret. Automatic scheduling,
content comparison, failure handling and host-mediated writes live in the
Obsidian bridge; the PDF Worker and standard annotation format are unchanged.

## Local selection correction for context menus

The display bundle tracks the pointer button that owns text selection. Selection
changes caused by right or middle clicks cannot automatically create underline
or highlight annotations, including delayed context-menu word selection after
pointer release. Primary-pointer and keyboard text selection remain enabled.
The PDF Worker and serialized annotation format are unchanged.

## Upstream collapsed-selection correction

The generic viewer bundle carries the seven-line collapsed-range guard from
PDF.js commit `1a30040c83ca0785f455175b99b9051c84181883`, associated with
upstream issue #22134 and PR #22137. The source change is in upstream
`web/text_layer_builder.js`; this vendored repository maps it into
`vendor/pdfjs-generic-legacy/web/viewer.mjs`'s `TextLayerBuilder` implementation.
The guard ignores a collapsed range when no pointer is down, preventing a
delayed click `selectionchange` from restoring the selecting state while
preserving non-collapsed Firefox caret-drag ranges. No other upstream changes
from that commit are included.

## Local Ink session safety correction: plugin 0.5.19

The generic viewer's `DrawingEditor` now retires a stale per-stroke pointer
controller before registering a replacement, ignores callbacks from stale
controllers, and guards the shared current-draw state during cancellation and
completion. This prevents a stale `pointerdown` listener from dereferencing a
cleared draw object and leaving subsequent Ink strokes delayed or uncommitted.
The change is limited to `build/pdf.mjs`; the PDF worker and serialized
annotation format are unchanged. The updated artifact is pinned in
`SHA256SUMS.json`.

## LingQ-aware tool-wheel layout

The PDF.js viewer keeps its original six-sector annotation tool wheel while
LingQ is disabled. When the Obsidian bridge's acknowledged
`vocabularyEnabled` state is enabled, the top sector becomes “退出 LingQ” and
the remaining 300 degrees are divided into three disabled placeholder sectors.
Selecting a placeholder only closes the wheel. The existing bridge toggle
event, PDF.js annotation tools, PDF worker, and annotation serialization are
unchanged. The modified viewer module and stylesheet are pinned in
`SHA256SUMS.json`.

When LingQ is enabled, the selected top wedge uses the theme accent as its fill;
its “退出 LingQ” caption therefore stays white for readable contrast. The
caption is an explicit text element layered above the sector SVG and is placed
farther out in the narrow exit wedge. This affects wheel presentation only.

## Read-only PDF tool-wheel correction: Windows validation 2026-10-19

The tool wheel remains available when PDF.js reports
`AnnotationEditorType.DISABLE`, so non-annotation actions such as LingQ can
still be used on a permission-restricted PDF. Annotation sectors are marked
disabled and cannot change the editor mode; selecting one keeps the wheel open
and the PDF permission is never bypassed. LingQ's enabled layout continues to
use its exit sector and three disabled placeholders. The change is limited to
`web/viewer.mjs` and `web/viewer.css`, is a local project correction rather than
an upstream PDF.js backport, and is pinned in `SHA256SUMS.json`.

## Annotation-only permission correction: 2026-10-19

The frozen viewer now enables annotation editors when the PDF grants either
`MODIFY_CONTENTS` or `MODIFY_ANNOTATIONS`. Previously it required only
`MODIFY_CONTENTS`, disabling annotation tools even when the document explicitly
granted the annotation permission used by the remote RAND PDF. Documents that
grant neither permission remain read-only. Ordinary edits continue to persist
through the external sidecar and do not write the source PDF. This is a local
permission-policy correction, not an upstream PDF.js backport, and is pinned in
`SHA256SUMS.json`.
