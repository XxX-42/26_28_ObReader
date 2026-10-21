# First-paint masking and 48-day active tombstone retention

This 0.12.0 Windows branch patch keeps the WAL v3.2 JSONL protocol and immutable
PDF source. It changes the active snapshot/Viewer projection, not historical
WAL, device anchors or immutable archives. There is no time-based history GC.

## Behavior

- Only live annotations deserialize into editable objects. Fresh tombstones
  and expired deletion guards hide exact source references and remove editors.
- After 48 * 24 hours, a full tombstone leaves the active `tombstones` array.
  Optional `deletionGuards` retain only UUID, the complete LWW version tuple,
  page index and embedded reference. An older update cannot revive it; an
  intentionally newer restore can supersede it.
- Per-device `<docKey>.jsonl.retention.json` stores integrity-verified first
  observation times, bound to document/source identity and deletion version.
  Legacy tombstones start at first successful registration. Repeated reads
  and sync do not reset that time. New JSONL deletes retain `deletedAt` in the
  durable operation without adding a second hot-path write.
- Retention metadata must verify on disk before compaction is exposed. Missing,
  corrupt or failed metadata conservatively retains/reconstructs full
  tombstones from the unchanged history. A new deletion version gets a new
  retention period.
- The watchdog runs on document lifecycle, save/sync and foreground events.
  An expiration is processed on the next event. No interval, countdown or
  48-day timer is installed. Read-only identity lookup and source mismatch do
  not register or rewrite retention metadata.

## First-paint correction

The old gate hid DOM annotation layers but left the page Canvas visible.
When source verification was delayed, an original appearance painted into
Canvas could therefore flash before its confirmed deletion mask took effect.
The patch keeps the Canvas hidden during verification and keeps any old Canvas
hidden until its masked replacement render completes. Session abort/teardown
removes hooks, render listeners and page markers.

The separate tombstone ledger was already normalized into deleted rows before
`installInitialDeletionMask`; that field access was not the bug. The initial
mask now also understands compact guards. No PDF.js core/Worker upgrade is
included. Existing deployed LingQ wheel assets were preserved byte-for-byte
and documented in vendor provenance and both exact-hash manifests.

## Evidence

- Before patch, the same browser regression observed a visible blue original
  AP frame followed by a white frame. Raw baseline failure:
  `tests/artifacts/first-paint-retention-20261022/red-first-paint.log`.
- After patch, confirmed and delayed-identity reopen cases pass with both full
  tombstones and compact guards, no deleted editor creation and links intact.
- Controlled-clock tests cover the exact 48-day boundary, cold restart,
  duplicate sync, newer restore/re-delete, read-only access, source mismatch,
  failed write and missing/corrupt retention metadata. The store integration
  checks archived WAL/anchor bytes remain unchanged.
- Native CLI acceptance used a unique 357-page source copy and 258 deletes in
  the isolated test Vault. After simulated expiry and full plugin reload:
  0 live annotations, 0 active full tombstones, 258 guards, 0 visible editors.
  The final visible page-2 Canvas differed by **0 of 1,344,061 pixels** from an
  annotation-disabled render with matching opaque Canvas context attributes.
  Ordinary source writes and `saveDocument()` calls were both **0**.
- Native source/copy SHA-256 remained
  `53ade40ce75c07455bd1d5a3829c5dd8efe925a65f1b5a54de756a9bea9dd378`;
  XXH64 remained `xxh64-v1:ec510c87a7844355`; mtime was unchanged.
  The original production snapshot hash also remained unchanged.
- Authoritative Native result and actual/control PNGs:
  `tests/artifacts/first-paint-retention-20261022/deletion-retention-1792606439258-7a9bd2c4/`.
  Earlier harness runs remain retained: missing ready hook, debugger visibility
  reset on reload, and mismatched reference Canvas alpha were diagnosed rather
  than increasing timeouts. The final run asserts a visible completed page,
  exact reference pixels and full cleanup.

## Full regression and deployment

- Final fast suite: **986 cases; 981 pass, 0 fail, 0 cancelled, 5 skipped**.
  All five skips are pre-existing macOS/POSIX-only browser-cleanup cases on
  Windows. Their child exits zero, but the strict runner marks any skipped
  case as a failed gate, so `npm test` exits 1. The gate policy was preserved.
  Raw report: `tests/artifacts/vocabulary-gates/runs/run-2026-10-21T18-33-10-371Z-43388-3b8ea1ef/report.json`.
- The complete browser gate was run separately after that strict early stop:
  **26 suite files passed, 0 failed, 0 skipped**; source fingerprint unchanged.
  Raw report: `tests/artifacts/vocabulary-gates/runs/run-2026-10-21T18-34-16-633Z-58180-bcd31dec/report.json`.
- Separate `npm run test:offline` also exits 0: all five tools create,
  save/reopen, bulk deletion persists without resurrection, and the browser
  exits normally. Log: `tests/artifacts/first-paint-retention-20261022/offline-04.log`.
- Full-command exit receipt: `npm test = 1` (the five platform skips above),
  `npm run test:browser = 0`, `npm run test:offline = 0`. This is not a claim
  that the repository's strict full gate is green. No skip/timeout policy was
  relaxed; this remains a reviewed fix-branch candidate, not a main release.
- The test-pool fixture now holds its first three fake children until all
  three have started, instead of assuming filesystem setup finishes within
  8 ms. Its deferred close events wait until the runner has attached listeners.
  The Ink browser fixture now waits for actual manager/read-only readiness and
  sends the pen's hover before its first press. Both original stroke assertions
  and save-rejection assertions remain. The wheel assertion checks the exact
  readable white caption already deployed in the production asset bundle.
- The mouse pause/resume fixture now observes the completed render/resume
  boundary instead of assuming two animation frames finish asynchronous page
  reset. Its existing 20-second readiness boundary and all visibility, text,
  focus and lifecycle assertions remain unchanged. Earlier failed logs remain.
- Three-file test deployment was backed up under `.deploy-backups` before
  replacement. Runtime Native acceptance used that same build. Production
  plugin files, user PDF bytes and existing production sidecar were not changed.

## Three-file receipt

The isolated test Vault runs the same three-file build used by Native acceptance.
The product version remains 0.12.0; this is a branch patch, not a release/tag.

| File | SHA-256 |
| --- | --- |
| main.js | `1eb175d55b2a438088e85d79fb88993a373e25ffce32c926b88922305cd83c5b` |
| manifest.json | `1487d5a6fd66223ba0575adddb8fd67281a9154e93c4dedf374b4c42469717ca` |
| styles.css | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` |

Historical WAL, anchors and immutable archives are not physically cleaned.
No polling timer or retention countdown is installed. No cross-device GC,
automatic rebase or performance acceptance is claimed by this patch. Production
legacy tombstones have not been aged or compacted by this task: the 258-guard
expiry acceptance above used only a new isolated test document and test clock.
