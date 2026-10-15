# PDF Source Revision Rebase Design

Status: design only. Version 0.7.0 does not automatically rebase annotations
when the source PDF changes. A source mismatch remains fail-closed: keep the
existing sidecar intact, do not hydrate it onto the changed source, and do not
write the PDF.

## Goals and invariants

- Preserve the immutable source PDF and every existing operation batch,
  checkpoint, tombstone, device acknowledgement, and recovery record.
- Never infer a destination page from a page number or approximate visual match
  alone.
- Keep the old document revision addressable so a later source restore can
  recover its annotations.
- Make ambiguity explicit and quarantine unresolved annotations instead of
  silently moving them.
- Treat rebase as a new sidecar revision, not a PDF edit. Only the explicit
  “export annotated copy” command may serialize PDF bytes, and it must create a
  separate file.

## Revision and page-lineage model

1. Identify a source revision by the full tagged source hash, byte length,
   page count, and parser version. Size, mtime, tail hash, or a short fingerprint
   are prefilters only; they cannot authorize reuse.
2. Store each revision as an immutable node associated with the stable
   `documentId`. Record a transition edge only after the user chooses to
   investigate a changed PDF. Keep the previous source identity and sidecar
   checkpoint unchanged.
3. For each page, retain a revision-scoped lineage record containing the PDF
   object reference when available, normalized media/crop boxes, rotation,
   text token shingles, layout landmarks, and a low-resolution perceptual
   fingerprint. These are evidence signals, not individually authoritative
   identifiers.
4. Store annotation anchors in page-local coordinates together with the
   annotation geometry and any available text quote/context. Do not use
   renderer-screen coordinates as persistent anchors.

## Candidate mapping and confidence gate

Candidate page pairs are ranked from independent signals:

- exact object-reference continuity;
- normalized page text similarity and rare-token overlap;
- layout/landmark similarity after accounting for crop box and rotation;
- perceptual image similarity for scanned pages;
- annotation-local text or geometric anchor agreement.

An automatic mapping may be proposed only when multiple independent signals
agree, the best candidate exceeds a calibrated confidence threshold, and its
margin over the second-best candidate is large enough for that document class.
Thresholds must be calibrated on a labeled corpus covering metadata-only saves,
object-number rewrites, linearization, optimization, inserted/deleted pages,
reordering, scans, and repeated/template pages. Do not ship guessed numeric
thresholds before measuring false-positive rates.

Fail closed when page candidates are tied, when text/layout evidence conflicts,
when page lineage is missing, when geometry cannot be transformed safely, or
when a PDF change makes the document-level identity uncertain. A matching page
number is never a confidence signal by itself.

## Annotation rebase and quarantine

For a confident page mapping, transform annotation geometry through the old
and new page coordinate systems, including crop box and rotation. Validate the
result against the destination page bounds and preserve the original annotation
UUID, operation history, and old revision association. Rebased operations must
be recorded as explicit new operations that reference both source and target
revision IDs; do not mutate historical batches.

Unmapped, low-confidence, or out-of-bounds annotations remain in an
unresolved/quarantine collection associated with the old revision. They must
remain exportable or manually reviewable, but must not be displayed at guessed
coordinates on the new source.

## Transaction and recovery

1. Read and verify the current source revision and its sidecar checkpoint.
2. Build a proposed revision graph and mapping in temporary sidecar state.
3. Validate all mapped geometry, UUID uniqueness, operation ordering, and
   source hashes. No PDF bytes are written.
4. Present the mapping summary and unresolved count for explicit user review.
5. Commit a new sidecar checkpoint/pointer only after confirmation and
   read-back verification. Keep the previous checkpoint and all batches until
   ordinary multi-device acknowledgement/compaction rules permit cleanup.
6. On interruption or validation failure, discard only the uncommitted
   temporary proposal; retain the original sidecar state exactly.

## Verification required before implementation

- Golden corpus and false-positive measurements for every listed PDF rewrite
  class, including duplicate pages and repeated headers.
- Tests for rotated/cropped pages, reordered pages, scans/OCR, duplicate text,
  deleted destinations, partial failures, concurrent device updates, and
  backup recovery.
- Native Obsidian review flow and accessibility behavior on desktop and mobile.
- Proof that a failed or cancelled rebase leaves the source hash and every
  committed sidecar file unchanged.
