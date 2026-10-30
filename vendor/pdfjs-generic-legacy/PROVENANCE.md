# PDF.js Viewer snapshot

## Preserved deployed Windows wheel assets: 2026-10-22

The already deployed 0.12.0 wheel layout and CSS were reconciled from the
read-only installed asset bundle `4c579f55b8ef7c8b18f0da31c4f9cc206a9eb721f58f72a99f356f6d98dbf5c4`.
This preserves the LingQ exit sector, disabled placeholders and readable
captions when rebuilding the first-paint/deletion-retention patch. It changes
no PDF.js core/Worker or upstream version. `SHA256SUMS.json` pins these exact
existing `web/viewer.mjs` and `web/viewer.css` assets.

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

## Read-only PDF tool-wheel correction: Windows validation 2026-10-19

The tool wheel remains available when PDF.js reports `AnnotationEditorType.DISABLE`,
so non-annotation actions such as LingQ can still be used on a permission-restricted
PDF. Annotation sectors are marked disabled and cannot change the editor mode;
the PDF permission is never bypassed. The change is limited to
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

## Local standard Highlight row-collision avoidance: plugin 0.12.1

The frozen `build/pdf.mjs` coordinates standard text-selection Highlight paint
geometry per page and frame, using the same pure rectangle-separation helper as
LingQ vocabulary highlights. It preserves each editor's original QuadPoints,
storage state, and focus outline; freehand Highlight/Ink paths are excluded.
Scale, rotation, editor rebuild, and removal reschedule the page calculation.
This is a local display-only adaptation, not an upstream PDF.js backport; the
updated vendored bundle is pinned in `SHA256SUMS.json`.

## Local Worker open timing

Instrument document load stages for ObReader diagnostics; preserves PDF.js parsing behavior.
Recovery-mode token searching uses Uint8Array.indexOf for the first byte; equivalent matching is retained.

## Local selection toolbar

Adds copy and reserved actions and reflects the active highlight color.

The selection toolbar is vertical and positioned outside the selected side of the page.

The previous horizontal selection position remains a hover target for a second toolbar.

The selection hover toolbar trigger is raised by half a measured text line.

The middle-button wheel shifts inside the viewport to leave room for its color arc.

Wheel captions omit shortcut numbers and use additional icon-to-label spacing.

Wheel glyphs use solid forms and no caption shadows.

Restore the original wheel glyphs; bridge renders the labels in solid white.

LingQ mode uses the same six equal wheel sectors, retaining disabled placeholders.
