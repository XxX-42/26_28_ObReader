# WAL-Sidecar v3.2 JSONL protocol (0.9.0 test candidate)

The 0.9.0 candidate keeps source PDFs immutable and replaces ordinary annotation
appends with a per-device JSON Lines WAL. Obsidian Sync transports files; it does
not provide distributed compare-and-swap or decide which annotation wins. This
document describes the integrated candidate, not a claim of real cross-device
Sync acceptance.

## Files and authority

```text
00_Archive/20_PDFData/
  _storage-protocol.json                 # bundled writer epoch barrier
  _registry.json                         # rebuildable route cache
  sidecars/<docKey>.annotations.json     # derived snapshot/cache
  wal/<deviceId>/<docKey>.jsonl          # active owner-device operation tail
  wal/<deviceId>/<docKey>.jsonl.anchor.json
  wal/<deviceId>/<docKey>.jsonl.archive.<first>-<last>.json
```

Existing v3.1 files such as `sidecars/<docKey>.annot.json` and
`wal/<deviceId>/<docKey>.json` remain read-only inputs. New JSONL-mode document
initialization and routing updates write to the JSONL namespace; they do not
create or mutate v3.1 WAL/Sidecar records. A verified v3.1/Format 3 state is
seeded into the current device's JSONL anchor on first initialization. The
original old-format files remain present as rollback and migration evidence.

For a document, effective state is the deterministic join of the available
verified v3.1 read-only inputs and all valid JSONL owner anchors, immutable
archives, and active tails. The JSONL snapshot is materialized for inspection
and cache purposes; it is not required to recover state. The registry is only a
path lookup cache and can be rebuilt from verified durable records.

The local device may append only to `wal/<its-deviceId>/...`. Same-device views
are serialized through the host writer coordinator. Rename/move is a versioned
`ROUTE_SET` operation in that same owner JSONL file and does not change
`documentId`, `docKey`, or storage paths. JSONL route rows use `op: "ROUTE"` and
`id: "$route"`; annotation rows use `CREATE`, `UPDATE`, or `DELETE`.

## Identity and source protection

Document identity derives from normalized initial Vault path and the full,
algorithm-tagged PDF source hash. The full identity is verified wherever a
short `docKey` appears. Size and tail samples can reject obvious changes but
cannot establish equality. Full source hash, page count, and ordered page
identity must match before annotations hydrate. A mismatch pauses ordinary
hydration and saving; no operation writes into the PDF.

If a docKey is present with a different full document identity, or if records
for one identity disagree on the full source hash, the store fails closed. A
copy ambiguity is not silently resolved by adding device-specific salts.

## Operation ordering and idempotency

Annotation sets, deletion tombstones, and routing operations use the shared
version comparator `(rev, deviceId, seq, opId)`. `seq` is local to one device;
timestamps in JSONL are diagnostic only and never decide a winner. Duplicate
operation IDs with different contents, version collisions, invalid integrity,
owner mismatch, sequence regression, or committed malformed rows are rejected.
Undo/redo remains local UI state; its inverse is saved as a normal new edit.

This is a deterministic max-register policy, not a full causal CRDT. It provides
order-independent convergence for the operations that have arrived, but it does
not preserve every concurrent branch as a causal history graph.

## Acknowledgement, recovery, and materialization

An annotation batch is canonicalized, integrity-tagged, newline-terminated, and
written with one `DataAdapter.append()` call to the owner JSONL. The host sends a
save acknowledgement after that adapter promise resolves. This is the plugin's
write-completion boundary; the DataAdapter API does not expose an fsync or
distributed durability guarantee.

Cold open verifies JSONL records before joining them. An incomplete final row
is pending on a remote shard; the owning device can repair only its own torn
tail. A malformed committed line or incomplete foreign shard blocks ordinary
writes. Compaction writes and validates an immutable archive, then the owner
anchor, then a derived snapshot; only after these recovery witnesses exist may
the active tail be replaced with an empty file. If any stage fails, existing
archives and prior data are retained.

The integrated candidate does not delete JSONL archives, legacy v3.1 data,
Format 3 records, or recovery data. No destructive garbage collection is
enabled. Owner anchors currently retain their accumulated operation witnesses;
long-running storage growth and anchor compaction policy remain follow-up work.

The epoch marker prevents the bundled legacy writer from mutating the protected
root when that writer honors the marker. It is not a distributed lock and
cannot constrain an older binary already offline. All devices that may edit a
document must be upgraded before using the new writer. If rolling back, restore
the matching plugin and data backup together.

## Migration and limitations

The importer reads the current verified legacy state, including live
annotations, tombstones, routing, exact legacy references, and payloads. It does
not rewrite legacy records. The JSONL owner anchor is written before the derived
snapshot, so a crash does not turn a partial import into an empty document.
Existing JSONL state is read first and is never overwritten by reinitializing a
legacy baseline.

The source PDF stays byte-for-byte unchanged during reading, editing, saving,
recovery, synchronization, and closing. PDF.js serialization is outside the
ordinary JSONL save path; a separate explicit export may create a new PDF.

Automated adapter/browser tests are not physical iPad evidence. Obsidian Sync
convergence across a real Mac/iPad pair and the long-duration large-PDF soak
must be reported separately. See [the 0.9.0 implementation report](WAL_SIDECAR_IMPLEMENTATION.md)
and [general acceptance record](GENERAL_ACCEPTANCE.md).

## v3.1 historical protocol

The prior v3.1 format used `sidecars/<docKey>.annot.json` plus
`wal/<deviceId>/<docKey>.json`, checkpoints, acknowledgement files, and a
30-day retention gate. Those files are retained as read-only migration and
rollback sources by the 0.9.0 JSONL candidate; the current JSONL writer does not
run that v3.1 garbage collector.
