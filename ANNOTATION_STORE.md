# WAL-Sidecar v3.2 JSONL protocol (0.9.0 test candidate)

## Unreleased main-checkpoint experiment (2026-10-29)

The `fix/annotation-main-snapshot-20261029` worktree adds checkpoint
publication, acknowledgement and archive-pruning APIs and invokes candidate
maintenance after idle materialization. The normal registry fast path and
production migration are not complete. This section records implementation
progress, not deployment or real Sync acceptance.

Path lookups inspect locally present per-path claims. Incomplete claim staging,
invalid claims or a claim that still conflicts with verified routing prevent a
direct cached return and leave the lookup pending after discovery. A newer
claim moving the competing identity away can clear the conflict. Claims are
hints and cannot prove that unsynchronized devices have no other route.
If an indexed path has no locally verified backing identity, discovery retains
the existing registry and reports sync pending instead of minting a new
identity. This also defers reusing an obsolete path until its missing state is
resolved; an incomplete scan never publishes a replacement registry.
Cold discovery reads independent checkpoint and recovery headers with at most
four concurrent reads per stage, then verifies document identity through the existing path.
This bounds concurrency but does not eliminate the cold full scan or establish
a measured Native open-time improvement.

Checkpoint candidates are addressed by SHA-256 under `main-snapshots/<docKey>/`.
Device observations of an exact candidate are written to `main-acks/` only
after the device's available state and archives are covered. Pruning requires
two distinct verified checkpoints, the current candidate to include previous
state, and acknowledgements from every currently observed participant.
Before removing any archive, a verified immutable `main-recovery/<docKey>/`
certificate records the exact archive hashes, checkpoint pair and observed
acknowledgements. Recovery revalidates the pair before treating an absent
covered archive as intentional. Corrupt or partially synchronized recovery
evidence remains pending. Active JSONL tails are never selected for removal.
Archive cleanup moves the source directory entry to a unique staging path and
verifies its bytes again before removing that stage. If the moved content does
not match the recovery certificate, it is retained and the document is marked
sync-pending. A crash can leave a matching staged copy; read-only recovery
checks it but does not remove it. Automatic maintenance currently defers both
cleanup and its resumption while the final deletion race remains unresolved;
the explicit experimental cleanup API is not approved for user data. This
does not establish a distributed lock.
An adversarial test replacing a staged archive immediately before `remove`
demonstrates that the replacement can still be deleted after validation.
Therefore even this staged cleanup must not be used on a user vault until a
protocol or adapter primitive protects the final removal against independent
Sync writers. The regression remains deliberately failing.
The public [Obsidian DataAdapter interface](https://raw.githubusercontent.com/obsidianmd/obsidian-api/master/obsidian.d.ts)
specifies `process(path, callback)` for atomic read-modify-save and separately
specifies `remove(path)` with no expected-content or expected-version argument.
That interface does not document a conditional removal or a cross-device lock.
Consequently, this code cannot infer a distributed compare-and-delete guarantee
from either operation; a safe production cleanup needs a separately proven
protocol or transport capability. This is an API-scope finding, not proof that
any particular Sync implementation will overwrite a staged file.
The same final-removal race affects checkpoint staging files. Publication now
retains those files instead of deleting them, and a regression verifies that a
concurrent replacement survives. A stage is treated as redundant only while its
bytes match a verified, identity-bound final checkpoint; otherwise reading stays
sync-pending. Staging files still accumulate, and the archive cleanup race is
unresolved. Do not deploy this experimental implementation until a safe
recovery/cleanup protocol and its integration tests are complete.
A separate adversarial test demonstrated the same issue in the shared
create-only JSON publisher. It now retains its staging files, and readers can
recognize a byte-identical, integrity-verified duplicate of a present published
record. If the published archive is subsequently removed, a retained stage is
accepted only when its exact digest is listed in an independently verified
recovery certificate; changed stages remain sync-pending. Stages remain on
disk, and safe garbage collection is still unresolved. No staging bytes are
discarded.
Read-only inspection of the installed Windows Obsidian 1.14.4
`obsidian.asar` (SHA-256 `146ef8470d8cbb4a6db209bdc19bf2bad13350444186c0fd93c31087b142b92f`)
found its desktop adapter copy path delegates file copying to Node's
`copyFile` with `COPYFILE_EXCL`. An isolated Obsidian 1.14.4 test vault also
verified one winner among eight concurrent copy contenders and eight concurrent
publications of the same snapshot. This is Windows local-adapter evidence only;
it does not establish mobile behavior, crash atomicity, or independent Sync
client behavior.
Old checkpoint and recovery-certificate cleanup also stages the directory
entry and compares the staged bytes with the verified input before removal.
An interrupted or changed stage makes the document sync-pending and preserves
the bytes; automatic recovery of these two stage types is not implemented.
An ACK also requires the checkpoint to retain the durable request receipts;
cleanup independently checks the current checkpoint and requires both recovery
checkpoints to retain receipts for each archive selected for deletion.
Known vault-wide presence records are also included in the local ACK check,
even when a device has no WAL for this particular document. Invalid presence
records and a newly discovered device during cleanup stop further deletion.
This enumeration cannot prove that Sync has delivered every device record,
and checking it before a delete is not a distributed lock or atomic CAS.
An isolated two-backing test delays an offline iPad's device-owned files until
after Windows maintenance and verifies that all four annotations remain
readable. This exercises the current no-delete safety gate; it does not prove
that actual Obsidian Sync converges or that destructive cleanup is safe.

Tests currently cover checkpoint-only recovery, missing registry repair,
missing device ACKs, interrupted cleanup and corrupt recovery backup. An
isolated checkpoint-only recovery can now be discovered by the normal path
lookup, and a resumed device advances beyond recovered operation sequences;
this remains a storage-adapter test rather than Native or real Sync evidence.
On 2026-10-29 the checkpoint-only, damaged-sidecar, shared-backing two-device,
and separate offline-backing recovery tests passed with tombstones and later
edits checked. Separately, three existing JSONL process-kill tests passed for
torn-tail, snapshot-temporary, and snapshot-published phases. Those process
tests exercise the JSONL engine, not this main-checkpoint garbage collector or
actual Obsidian Sync.
The seven isolated main-checkpoint, route, maintenance-planning and retirement
test files ran 27/27 on 2026-10-29. They validate the planner and evidence
handling only; they do not enable automatic retirement or destructive cleanup,
and are not a substitute for the still-failing WAL integration tests.
When a new checkpoint contains changes absent from locally verified logs,
the candidate is retained but excluded from the displayed state; the document
remains sync-pending until those logs arrive and the verified states converge.
An observed participant set is not proof that every real offline client has been
enumerated. Vault-wide device presence and observer-owned seven-day candidate
records exist, but candidate status is not a retirement certificate; automatic
retirement, late-write quarantine and global routing certification remain
incomplete. A local clock rollback invalidates the inactivity interval and
requires a new seven-day observation after the clock recovers. Opening a clean
Reader and returning to the foreground publish local presence and observe
known devices. Candidate checks require a fresh observation and re-read the
presence after publishing it, although this is not an atomic distributed fence.
Successful annotation saves also schedule a device-presence update without
delaying the durable WAL acknowledgement. Bursts share one running update
and at most one follow-up; subsequent saves are rate-limited to one refresh
per minute, with a backward local clock causing an immediate refresh. A failed
presence write is recorded but cannot revoke the completed annotation save.
These events only update candidate evidence, never retire a
device or authorize deletion. A tested but not yet connected retirement
classifier distinguishes byte-identical checkpoint winners from ambiguous or
late operations. New snapshot receipts carry the full operation version when
it is available from a verified log; old receipts remain readable and cannot
alone prove an exact row. New deletion receipts also bind the deletion time;
without that evidence an older non-winning deletion stays unresolved. The
store can prepare a proposal from a fresh seven-day observation,
the exact verified checkpoint, and ACKs from every other observed participant.
The proposal may be stored as an immutable, content-addressed planning record;
reading it verifies its content and checkpoint but cannot establish that its
device observations or ACKs are still current. It is not yet wired to device
retirement or a persistent fence. Neither it
nor the classifier is a retirement or cleanup authorization. The three-file
merge trigger and ten-checkpoint retention have
isolated tests, not real Sync acceptance. Real cross-device Sync, full
regression and Native deployment must pass before this experiment can be used
to migrate a user vault.

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
