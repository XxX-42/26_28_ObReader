# WAL-Sidecar v3.1 storage protocol

This development branch replaces the Format 3 writer. The source PDF remains
immutable. Obsidian Sync transports files; it does not arbitrate annotation
versions. The plugin manifest remains at the integration baseline version for
local development; this branch is not a published or deployed release.

## Durable layout and authority

```
00_Archive/20_PDFData/
  _registry.json
  sidecars/<docKey>.annot.json
  wal/<deviceId>/<docKey>.json
```

Only transaction `.pending` files may additionally remain after interrupted
writes. Existing Format 3 files are preserved unchanged in this task.

`EffectiveState = join(valid Sidecar, all valid WAL anchors, all valid WAL tails)`.
The registry is a lookup cache. Every cache hit is verified against durable
routing; a missing, corrupt, or stale cache is rebuilt from verified records.
Unverified JSON headers never establish identity or a docKey collision.

Sidecar kind is `pdf-reader-materialized-sidecar`; WAL kind is
`pdf-reader-device-wal`; both use `schemaVersion: 1`. Sidecar persists document
metadata, annotation/tombstone maps, routing, watermark, and integrity. WAL
persists immutable document metadata, owner identity, `nextSeq`, a single
`anchor` with `throughSeq` plus sparse state maps, and a short operation `tail`.
Internal non-enumerable replay arrays are not serialized or hashed.

## Identity and source protection

Initial identity is derived from the normalized initial Vault path plus the
complete, algorithm-tagged source hash. A stable hash of the full documentId
derives the 12-hex docKey. Full documentId is always validated; docKey is never
trusted alone. Identity hashing and resource/build SHA-256 behavior are retained.
Size/tail hashes can reject changes but cannot authorize source equality.

Rename writes a normal versioned `ROUTE_SET`; it never renames a Sidecar or WAL.
Routing carries sourcePath and verified source/page metadata. A PDF observed at
a new path before its matching route arrives remains identity-pending when the
prior route is missing. It is not silently initialized as an empty new document.
A copy whose old PDF still exists at a different path receives a distinct
path-derived identity. Reusing an occupied initial path with identical bytes
raises `IDENTITY_AMBIGUOUS_COPY`; the explicit new-copy command creates a random
instance identity. Existing live route conflicts are refused, not overwritten.

Full source hash, size, page count and ordered page identities must agree across
contributors and with the loaded PDF. Mismatches pause hydration and ordinary
saving. Recovery may persist a validated operation against its ORIGINAL source
identity; it is acknowledged as quarantined and never hydrated onto the changed
PDF. Filesystem mtime is runtime detection data, not persistent conflict order
or a canonical baseline field.

## Ordering, replay and writer ownership

All annotation states, tombstones and routes have `{rev, deviceId, seq}`.
The single comparator orders rev, then lexical deviceId, then owner-local seq.
Equal versions with different operation IDs or content fail closed. An object's
new revision is its current EffectiveState revision plus one. Sequence numbers
never compare different devices. No wall clock, arrival time, baseVersion or
causal parent influences the join. This is a deterministic max-register, not a
full causal CRDT.

Only the owning device writes its shard. A shared in-process coordinator
serializes same-device/document edits from views and popouts. The host also
serializes snapshot reads and rejects stale source/open-session/token messages.
Persisted assigned-version WAL redelivery is idempotent. Raw Viewer edit requests
are new intents; retries within a live session are deduplicated before assigning
another revision. Unbounded historical request receipts are not retained.
Undo/redo stacks remain local; their resulting inverse edits are ordinary new
WAL facts. No undo or redo stack is synchronized.

Writes stage canonical bytes, verify them, replace the canonical path, and read
back before acknowledgement. An adapter refusing overwrite-rename uses its
write primitive; a verified `.pending` value remains recoverable if interrupted.
This is not a distributed CAS or a lock against another device. Invalid JSON,
integrity, ownership or sequence regressions pause the affected shard. Runtime
high-water tracking detects observed WAL rollback; durable Sidecar watermarks
also prevent creating a low-sequence replacement for a missing own shard.

## Sparse anchors and materialization

Compaction reads the existing Sidecar plus every available valid shard. Known
invalid input prevents maintenance. The current device retains its own winning
states and tombstones in its anchor even if the Sidecar contains them. Older
local revisions may be replaced atomically by that local winner. A contribution
dominated by another device is removed only when another verified WAL durably
contains the winner; a Sidecar-only winner is insufficient evidence.

Imported `legacy-import` rev1/seq0 baseline states are an explicit anchor
exception: the first importing real device retains them as recovery material
until safely dominated. This protects initial annotations if the Sidecar is
rolled back. Winner anchors and tails, not Sync version history, recover a stale
Sidecar. Losing payloads do not stay forever merely to retain historical edits.

Watermarks only advance by max of prior and valid observed sequence progress.
They reduce replay/describe maintenance and never authorize dropping a winning
contribution. Any platform can compact. Background maintenance probes every
live Reader for foreground, clean, non-input/non-save state; busy/stale replies
defer maintenance. No Reader response is required after all views close.
Constructor maintenance defaults (256 tail entries / 512 KiB estimated WAL)
are tunable scheduling choices, not correctness or latency promises.

## Hard cutover and one-time Format 3 import

Before switching all in-use devices must finish syncing and upgrade. Mixed old
and new writers are unsupported. The importer reads current Format 3 winners,
tombstones, exact embedded references and page/source identities WITHOUT writing
old metadata, checkpoint, ACK or GC files. It preserves UUID, type, page and
lossless payload, but discards old history/clock/parent/ACK machinery.

The canonical initial states use rev1, deviceId `legacy-import`, seq0. A recovery
anchor is durable before the integrated writer acknowledges the materialized
baseline. Import interruption/repetition cannot initialize an empty replacement
or overwrite an existing new state. Different legacy replicas are not made equal
by pretending their inputs matched: cutover requires a fully synchronized old
state. There is no continuing old-format dual write or automatic late legacy
branch import after cutover.

Old files and old implementation remain available for read-only import and
regression comparison. This task implements NO deletion of users' old data.
Any later cleanup must first verify each converted document and its recoverable
v3.1 state. Device ACK, retirement, 30-day GC and primary/previous checkpoint
semantics are not used by the new writer.

## Validation limits

See `evidence/wal-v3-1/` and `WAL_SIDECAR_IMPLEMENTATION.md`. Tests use isolated
memory adapters, fixtures and browser harnesses. Labels Windows/macOS/iPadOS on
adapter tests do not constitute physical-device acceptance. No user vault was
modified. Source PDF writes and full PDF serialization remain explicit-export
operations only. Existing Format 3 test failures are recorded separately rather
than changing their expectations to fit the replacement protocol.
