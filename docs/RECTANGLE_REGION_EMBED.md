# Rectangle region links and Markdown embeds

## Candidate

- Base: `dca861e4950b630b8718e2f52286f3395da67bb9`.
- Backup pushed before editing: `codex/backup-before-rectangle-region-20261031`.
- Development branch: `codex/rectangle-region-embed`.
- Product version remains 0.15.0; no annotation protocol migration.

## Usage

Choose **矩形区域** beside the Square tool, then drag over the PDF. In panes narrower than 360 CSS pixels, the same button is in the existing secondary menu. After the native Square has committed and the ordinary save has received its durable ACK, ObReader copies an embed and returns to the arrow tool.

```md
![[Book.pdf#page=8&docKey=…&obdoc=…&obreader=ann.UUID|Book · p.8]]
```

Removing `!` produces a normal navigation link. Region links opt into the existing document identity parameters; ordinary text-selection links retain their existing output format.

The image follows the current persisted rectangle, not the rectangle at copy time. Clicking it re-resolves the target and uses the existing annotation-UUID navigation. A removed target shows an unavailable message and is never recreated. Region Squares remain ordinary editable/deletable annotations, independent of reference-owned linked Highlights.

## Boundaries

- Reuses native PDF.js Square drawing, UUID allocation, JSONL saves, exact ACKs, anchor capture messages and identity routing.
- No new annotation storage, link target kind, image files, PDF export, dependencies, or frozen-vendor modifications.
- Only page contents are rendered: `annotationMode: 0`, no external AnnotationStorage or annotation-layer composition. Flattened marks in page contents remain visible.
- Reading view and Live Preview use a thin wrapper around Obsidian's existing PDF embed factory. Other PDF embeds delegate to that factory. Unload restores it only when the wrapper still owns the registration.
- Rendering is serialized, limited to visible embeds, capped at 4 million pixels per crop, with at most 16 / 32 MiB cached PNG blobs and two owned PDF documents.
- An open Reader's PDFDocumentProxy and font-owning document are reused. Closed PDFs load through the same verified frozen PDF.js resources. Only owned documents are destroyed.
- Crop/source changes invalidate rendering through existing save and Vault events; no polling, full-Vault scan, OCR or second Viewer is added.
- Source bytes are checked against existing verified source evidence on a cache miss. Source conflicts show an error rather than guessing another document or geometry.

## Failures found and fixed

1. A saved Square could be absent from the Host's still-lagging snapshot. Region copying now reads the durable effective state before accepting the UUID.
2. V15's display-only `snapshot.document = { id, path }` was mistaken for the canonical identity. Existing annotation navigation now checks the actual identity fields.
3. Rendering a borrowed PDF document into another window's Canvas produced missing-font boxes. Borrowed rendering now uses the Reader's font-owning document.
4. The extra tool overlapped eraser controls in a 320 px pane. It now moves into the existing overflow menu through the existing adaptive layout function.
5. The mobile source harness rejected the newly imported module. Its allowlist now loads the real module; assertions and timeouts are unchanged.

Historical red runs remain under `tests/artifacts/rectangle-region/`; they are not replaced by passing runs.

## Verification

- Targeted Anchor / region / Host / real-PDF.js tests: **149 passed, 0 failed**.
- Real PDF.js pixel checks: source green pixels remain green despite an opaque red native annotation; CropBox and rotations 0/90/180/270 pass. Current geometry refresh, cache reuse, deleted-target handling and teardown pass.
- Native Windows Obsidian, isolated test Vault and new fixture namespace: trusted forward/reverse drags; exactly one copied embed per completed drag; persisted distinct UUIDs; reading view; Live Preview; closed-PDF render; image click returning to the UUID; PDF/Markdown rename and parent-folder moves all pass.
- Native test pairs only its new fixture. After pairing: source SHA-256 and XXH64 unchanged, source writes **0**, ordinary `saveDocument()` calls **0**. Existing user annotation namespaces are not used for functional writes.
- Three-file build: **406 embedded resources / 402 frozen vendor files verified**. Vendor diff is empty.
- Offline smoke: all five tools, save/reopen and bulk-delete non-resurrection pass.

Complete unchanged-source gate results:

| Gate | Baseline | Candidate |
| --- | --- | --- |
| Fast (test files) | 145 pass / 6 fail / 5 skipped | 146 pass / 6 fail / 5 skipped |
| Browser (test files/scripts) | 26 pass / 6 fail | 28 pass / 5 fail |
| Offline | pass | pass |

Both final gate source fingerprints are stable. Fast's failed assertions are identical to baseline; Browser's failed assertions are a subset of baseline, with **zero new failures**. Do not describe the entire suite as green. The former multi-line Highlight failure did not occur in the final run; its old failure evidence remains.

Remaining Browser failures: desktop toolbar, embedded-annotation scan, native FreeText AP undo, mobile browser startup (three scenarios), and open lifecycle. Remaining Fast failures: browser cleanup's existing five platform skips, external-annotation bridge, input architecture boundary, mobile status bar, native erasure journal recovery, and the frozen-byte audit. No assertion, timeout or skip policy was relaxed.

Final evidence:
- Fast: `tests/artifacts/vocabulary-gates/runs/run-2026-10-31T05-34-21-186Z-31844-affe1e1e/report.json`.
- Browser: `tests/artifacts/vocabulary-gates/runs/run-2026-10-31T05-34-34-488Z-28332-d7ca08a3/report.json`.
- Assertion-level comparisons: `tests/artifacts/rectangle-region/sealed-{fast,browser}-comparison.json`.
- Native: `tests/artifacts/rectangle-region/rectangle-1793424849892/report.json` and `markdown-embed.png`.
- Final Native paired fixture SHA-256: `3a37843d35babccac663546063a9ad16ab71ce8ed69a6a11ca73b4add19204c9`; XXH64: `xxh64-v1:7a774f651c9b5c4e`. Both remained unchanged after ordinary edits and rename/move tests.

Three-file SHA-256:
- `main.js`: `d0cbb4c8ca6b73fa8e370cba9b92f0c13e1d984dd9ea476368f0bc3b2872e7cf`
- `manifest.json`: `0de4ae88f535b1ce16ee6bf6fc17535f80dd8a95f0fc1458ad919ce608588e30`
- `styles.css`: `d22aa9ed97257fcf628f6da65acbb49d8e26b3fd0bff7dd7e93084923e67c9b1`

Deployment operations retain local receipts in `tests/artifacts/rectangle-region/`. The standard deployment command encounters its existing cross-drive `EXDEV` backup rename failure; deployment uses a checked three-file copy with a same-drive recoverable backup instead. Source PDFs, annotation files, settings and recovery directories are not copied or replaced by deployment.

## Limits

- Physical iPad, macOS Native and real multi-device Sync were not run.
- Obsidian must provide its PDF embed registry API. Unsupported runtimes retain their original PDF embed behavior.
- Vault rename tests use Obsidian's real rename/link-update path. External moves that leave an unresolved Markdown embed path are not claimed to be repaired before Obsidian resolves the embed.
- Existing full-suite failures are outside this feature's scope and remain visible in the gate reports.
