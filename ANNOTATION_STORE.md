# External annotation history and reclamation

Plugin 0.8.0 uses a Git-inspired append-only history model under
`00_Archive/20_PDFData`. This is not a Git object format. The original PDF stays
read-only; immutable device operation batches are the history source, while a
checkpoint is a verified, rebuildable materialized view.

## Records and references

- Each device writes its own immutable operation batch file. Operation UUID,
  device ID, operation ID, logical clock, and tombstones retain the existing
  deterministic LWW rules.
- Format 2 remains readable and writable during rollout. Format 3 adds a base
  checkpoint hash and parent batch references. Concurrent batches can share a
  parent; replay keeps every concurrent head in the frontier.
- A checkpoint records live annotations, tombstones, operation and batch
  digests, known devices, covered batches, and (format 3) the current batch-head
  frontier. Its integrity hash covers the full canonical checkpoint.
- The basename `.pdfdata.json` file is only a pointer/cache. It can be rebuilt
  from the per-document checkpoint and immutable batches.
- `.previous.json` is the last different verified checkpoint. An unchanged
  materialization does not rewrite or rotate it. Before replacing a valid
  primary checkpoint, the store verifies the previous file contains that prior
  primary state.

## Migration and partial Sync

During rollout, devices continue writing format 2 until every known, non-retired
device has acknowledged the same valid checkpoint and advertises format 3
support. A v3 operation batch arriving before its format 3 checkpoint is treated
as incomplete Sync. Its ACK hash is not a substitute for the missing checkpoint
object. Likewise, a missing parent batch or malformed/partially arrived JSON
batch pauses replay. In these cases the Reader shows the last verified checkpoint
read-only; it does not advance the checkpoint, acknowledge the incomplete state,
or reclaim batches.

After cutover, a readable legacy format 2 batch can still be imported without
downgrading the format 3 checkpoint. Its UUID and operation clock remain subject
to the ordinary deterministic conflict rules. A retired device cannot append;
late batches from it are retained and reported as isolated recovery data rather
than silently applied. Retirement is explicit and requires the current
checkpoint hash to avoid retiring a device from a stale review.

## Checkpoint backup and safe reclamation

Garbage collection is fail-closed. It requires all active devices to acknowledge
the exact current verified checkpoint, a 30-day age since the latest such ACK,
and two valid, distinct checkpoints (current and `.previous.json`). Each batch
is parsed and rehashed before removal, and must be covered with the same digest
by both checkpoints. The delta after the previous checkpoint therefore remains
available to recover current state if the primary is lost. Missing device state,
partial Sync, future ACK time, invalid checkpoint, digest mismatch, or an
unacknowledged active device stops reclamation. Device retirement removes only
that device from the active ACK set; it does not make its late operation files
eligible for collection.

The 30 days are measured from the last active-device confirmation, which is no
earlier than checkpoint creation and can be later. No tombstone or operation
history is pruned during this retention window. Old PDF binary recovery files
are left untouched.

## Manual Sync history

Obsidian CLI's `sync:history`, `sync:read`, and `sync:restore` can inspect or
restore synced files through a running Obsidian app. They are manual recovery
tools only, not a plugin API and not a garbage-collection signal. Before relying
on them for these sidecar JSON files, verify in the target vault that the
relevant `.json` files actually appear in Sync history. Obsidian documents a
two-week version history for attachments, so this is supplemental recovery, not
a replacement for the plugin's checkpoint retention.

References: [Obsidian CLI](https://obsidian.md/help/cli) and [Obsidian Sync
version history](https://obsidian.md/help/Obsidian%2BSync/Version%2Bhistory).
