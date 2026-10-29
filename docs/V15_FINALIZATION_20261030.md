# v15 finalization result — 2026-10-30

Base: `feature/v15-single-jsonl@746d1c104f6857803d7e06ea0ae198a7a203da0b`.
Reader product version and release bytes remain 0.15.0. The new maintenance
entry is operator-only, not imported into the Reader bundle.

## Data verification

The production maintenance window used closed, clean Readers, a disabled
plugin, and paused Sync. Read-only replay verified 11 old routes. Eight paired
documents retained all legacy winners; three empty unpaired identities remain
in the deferred index. Exact retained history explains the newer v15 changes;
the old state was never copied over the newer state.

An isolated filesystem rehearsal removed 173 covered legacy files. A new
Host adapter then resolved all 11 identities with correct counts, zero writes,
and no legacy WAL/sidecar reads.

The same guarded procedure switched production `_registry.json` to schema 15
with eight pair routes. It removed 173 legacy files and subsequently ten
verified empty directories. The remaining 21 files are current annotations,
recent history, Reader anchors, outline source proofs, the pair registry and
the three deferred identities. Immediately after cleanup they occupied
1,212,748 bytes, versus 6,810,918 bytes before maintenance.

Counts: 74 active annotations and 303 deletion records. All eight source PDFs'
SHA-256 and XXH64 values remained identical. At the cleanup boundary all 20
protected non-registry files were byte-identical. No PDF write, re-pairing,
annotation rewrite, or automatic maintenance job was performed by the tool.

After re-enabling the existing plugin, a live Principles Reader loaded three
active annotations and 270 deletions, with no source mismatch or storage
error and editing unlocked. The Smoking-specific reopen probe did not reach
its predicate because the live Reader session switched to Principles; it is
not counted as a Smoking Native pass. The running Reader subsequently made
one ordinary v15 commit advancing 20 existing deletion envelopes. A fresh
read-only verification confirmed unchanged UUIDs/content/deletion outcomes,
complete exact history coverage and unchanged PDF hashes. This commit was not
rolled back or overwritten by maintenance. Sync was restored to its original
unpaused state.

## Tests and release status

- Finalizer: 17/17 unit tests passed, including missing records, exact history,
  cache resequencing, corrupt history, unknown files, stale plans, interrupted
  publication, resumability and resumed Sync.
- Finalizer plus frozen boundary focused check: 20/20 passed.
- Additional migration/filesystem/Host regressions: 22/22 passed.
- Build: three release files, 406 assets, frozen vendor validation passed.
- Offline five-tool save/delete/reopen smoke passed.
- Initial `npm test`: Fast stopped with two suite failures. One was the
  already-published Host callback forwarding commit `77c66ce` missing from the
  reviewed hash manifest; its exact one-line diff was reviewed and registered.
- Final Fast: 138 suites passed; one suite classified failed solely for five
  existing macOS/POSIX platform skips. Child assertions had zero failures.
  The strict gate policy was not relaxed.
- Browser: 30 suites passed, one failed. The retained embedded-annotation test
  requires no visible old AP frame before source confirmation; the existing
  PDF-first mode currently permits it. No production behavior or assertion was
  changed to conceal this result.

Full release acceptance is **not green**. No Git push or new three-file
deployment is authorized by a passing full gate in this run. Preserve this
local maintenance commit and the raw evidence; do not describe the existing
bundle being re-enabled as a new release deployment.

Raw inventory, per-document comparisons, migration receipts, isolated and
production independent-read verification, and unabridged test logs are retained
outside the repository under the operator's `pdfdata-audit-20261030` evidence
directory. No user annotation payload is committed to this repository.
