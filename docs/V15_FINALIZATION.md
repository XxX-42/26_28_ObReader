# v15 registry finalization and legacy cleanup

This is explicit maintenance, not a Reader startup migration. Use
`scripts/v15-finalize-runtime.cjs` through the intended Obsidian instance's CLI
with an exact `expectedVault` path and a unique `runId`.

## Preconditions

Save and normally close every Reader. Pause Obsidian Sync, then disable
`pdf-web-reader`. Do not run another writer against this Vault. The operator
checks these conditions before publication and before each removal. These
checks are local preconditions, not a distributed lock.

## Verification and publication

1. `run({app, expectedVault, runId, apply:false})` performs read-only old WAL
   replay, validates current JSONL and committed recent history, and records a
   plan outside `20_PDFData`. It never pairs or writes a PDF.
2. Every old winning UUID must still exist. A changed record requires an exact
   retained before/after history chain to the current record. Matching counts,
   newer timestamps and matching UUID alone do not suffice. New v15 records
   remain untouched.
3. Old derived caches are integrity checked too. Resequenced operation
   envelopes are acceptable only when all content, including UUID, type,
   payload, geometry and embedded reference, matches verified replay. A unique
   newer cache payload blocks cleanup.
4. Empty unpaired documents must retain the same identity in `_index.json`.
   Every paired PDF's actual pair ID and full SHA-256 are verified. PDF SHA-256
   and XXH64 evidence is retained in the receipt.
5. `run({app, expectedVault, runId, apply:true})` rechecks the exact planned
   bytes and publishes schema-15 `_registry.json` through the existing registry
   rebuild with its expected-old-bytes guard. It does not rewrite annotations
   or recent history.
6. Before every removal, all protected current files and the target old file
   are checked again. Only explicitly accounted legacy paths are eligible.
   Unknown files, missing current files, identity mismatches, damaged history,
   resumed Sync, and changed bytes stop cleanup.

Receipts live under
`.obsidian/plugins/pdf-web-reader/.v15-finalization/<runId>.json`. They contain
file digests, route identities and counts, not annotation payload backups.
If interrupted after registry publication, repeat the same run ID to resume
the recorded plan. A changed current file requires renewed investigation;
never overwrite it with the old plan.

## Retained data and boundaries

Keep `annotations/`, `history/`, `_registry.json`, deferred `_index.json`,
Reader `anchors/`, and outline `source-versions/`. Old WAL recovery anchors are
different from Reader selection anchors.

v15 retains current annotations, deletion records and at most 100 recent
changes. Removing covered old WAL archives deliberately ends retention of the
full pre-v15 operation history. No automatic cleanup or periodic job is added.
This maintenance does not make shared-file v15 synchronization conflict-free.

The release bundle is unchanged: the maintenance module is loaded explicitly
from the operator's checkout, not imported into the Reader or mobile runtime.
Do not bump the product version or alter the PDF merely to run finalization.
