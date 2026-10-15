# 0.7 sidecar reachability and oracle audit (2026-10-15)

This audit does not delete modules or authorize a storage protocol change. The
frozen 0.7.0 full-suite result is 390/328 pass/57 fail/5 existing skips. It is
not the final result of the migrated suite. In particular, the original broad
classification of every plugin-host failure as stale was incorrect: the
controlled-close initialization ordering has a genuine failing regression.

## Production entry graph

```text
plugin/main.js
  -> pdf-annotation-host.cjs -> pdf-annotation-store.cjs  [DAILY SIDECAR]
  -> asset-runtime.cjs -> verified embedded Viewer + obsidian-bridge.js
       -> ordinary save/recover/close -> external operations -> host above
       -> handleExportCopy -> PDFDocumentProxy.saveDocument -> NEW PDF
  -> getLegacyMergeClient -> pdf-merge-client.cjs
       -> verified web/pdf-merge-worker.js (dynamic Worker)
            -> pdf-merge-core.cjs -> pdf-incremental.cjs + pdf-lib
       -> inspectLegacy / exact object-reference identity import [MIGRATION]
  -> readDeltaRecovery (pdf-recovery-read.cjs)
       -> legacy recovery candidate verification -> NEW recovered file
```

Build `scripts/build.mjs` inlines the host, client and recovery reader, and bundles
the worker into the embedded resources. The worker still exposes `prepareLocal`,
`merge`, and `inspect`; the current host migration entry invokes `inspect`.
Therefore a filename or the existence of an obsolete callable method does not
prove that the whole merge/worker/incremental module is dead.

| Module / entry | Class | Evidence / disposition |
| --- | --- | --- |
| annotation host/store, ordinary save/ACK | ACTIVE_DAILY_SIDECAR | `main.js` require and `annotationHost.handleMessage`; store immutable batch append, replay/checkpoint/ACK. Preserve. |
| Viewer bridge Ctrl+S, debounce, close, sidecar recovery | ACTIVE_DAILY_SIDECAR | Ordinary paths do not call `saveDocument`; fail/timeout leaves dirty edits. Test PDF unchanged + durable operations + close/reopen hydration. |
| bridge `handleExportCopy` | ACTIVE_EXPLICIT_EXPORT | Sole bridge `pdfDocument.saveDocument()` call; host creates unique new output. Source must remain unchanged. |
| `pdf-recovery-read.cjs` and legacy candidate command | ACTIVE_LEGACY_MIGRATION | Actual main import plus command/list/verify/read paths. Keep hash checks, damaged-descriptor fallback, candidate retention and new-file-only output tests. |
| merge client/worker/core/incremental | ACTIVE_LEGACY_MIGRATION (mixed legacy functionality) | Main dynamically loads verified worker for exact embedded UUID/object-ref inspection. Preserve full modules unless function-level dependency removal is separately proven. |
| `pdf-sync-host.cjs` / `pdf-journal.cjs` | DEAD_LEGACY **in shipped main runtime only** | No current main import/dynamic entry. Old sync host imports journal. Direct core/unit tests remain; worker/compatibility code is not deleted. |
| `pdf-recovery.cjs` old binary writer | DEAD_LEGACY **in shipped main runtime only** | Build rejects old writer in main bundle; current import is recovery-read, not writer. Source/tests retained. |

Static audit commands: `rg -n 'require\(|import |import\(' plugin/*.cjs
plugin/*.mjs`, `rg -n 'pdf-sync-host|pdf-recovery|pdf-journal|pdf-merge'
scripts/build.mjs plugin/main.js`, and `rg -n 'saveDocument\('
viewer-adapter/obsidian-bridge.js`. On PowerShell use `rg --glob` or explicit
paths rather than relying on shell glob expansion.

## Test-oracle migration rules

| Old assertion | Current oracle |
| --- | --- |
| ordinary save changes PDF bytes/hash/size | source unchanged, source writes=0, no PDF serialization; actual operation batch durable before ACK |
| `pdfSync.setDocumentBaseline/prepareLocal` is Reader startup | source-identity confirmation + ordered-page identity; editing stays disabled until confirmed |
| close must perform full-PDF recovery/writeback | close waits for the exact sidecar revision/ACK; wrong/stale ACK is rejected, failed save keeps the Reader |
| same UUID stored under an object key | schema-2 snapshot is an annotations array plus compact tombstone ledger; compare UUID and payload, not obsolete container shape |
| explicit export changes source | export creates a new PDF with standard annotations; original remains identical |
| old recovery bytes may be discarded after sidecar upgrade | legacy verified candidate remains readable/recoverable; failure never removes the candidate or overwrites the source |

`plugin-host.test.mjs`, `autosave-regression.test.mjs`, and
`sync-bridge-regression.test.mjs` are being migrated against these rules; they
must keep lifecycle, session, UUID, undo/redo, durability and failure assertions.
The browser fake host is not a native acceptance: it must implement source
confirmation and `recovered.ok`, but cannot prove filesystem durability itself.
Native fixtures and readback provide that separate evidence.

## Root-index barrier disposition

The exact A/B regression is retained in `pdf-annotation-store.test.mjs`: A has a
compact checkpoint and device ACK; B is a cold document without a checkpoint;
A read/materialization still leaves the shared root at schema 1. This is a real
scalability limitation, not a failed test to remove.

- A metadata-only sweep cannot satisfy checkpoint + all-device ACK conditions.
  A real background replay sweep requires bounded I/O, restart/concurrency
  guarantees and cannot fabricate an idle device's ACK.
- A compact route index plus schema-1 compatibility shadow needs proven old
  client route resolution and lossless concurrent updates of unrelated
  documents. No such proof exists in this patch.
- Consequently no mixed schema, automatic remint, sweep, or double-index
  protocol is introduced. Rename/copy/missing metadata fail-closed tests remain.

## Evidence boundaries

Windows infra targeted run: 40 pass, 0 fail, 5 existing platform skips. Store
regressions: 24/24 at that checkpoint, including failed backup readback blocks
GC, retired-device late batch rejection after GC, and Float32 NaN/-0 preservation.
Those are Node/in-memory results, not physical multi-device or Apple evidence.
Final full-suite and Native results belong in `GENERAL_ACCEPTANCE.md`, including
all remaining failures; no repeated-run success is substituted for a failed run.
