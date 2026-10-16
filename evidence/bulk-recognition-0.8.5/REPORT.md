# 0.8.5 bulk annotation deletion

Base and fetched origin/main: 042bf413fb61ab2271a2ff5d21da2c1e42dab127. No additional remote commits to merge.

## Changes
- Enumerate all PDF pages for exact supported native annotation references; ignore links and malformed/unrepresentable entries. No coordinate-based identity matching.
- Include unchanged hydrated editors whose PDF.js serialize() returns null.
- Keep explicit bulk tombstones until the corresponding host revision is acknowledged; prevent stale live snapshots from restoring them.
- Process confirmed tombstones during hydration. Mask exact embedded references in PDF.js rendering modifiedIds and repaint loaded pages so original AP pixels disappear. Source PDF is never written.
- Restrict build-time function tracing to the bridge closure, avoiding references to private controller helpers outside their lexical scope.

## Verification
- regression.log: 105/105 targeted, native browser, architecture, and WAL regressions pass.
- controller-final.log: 13/13, including rendering mask composition/reset.
- offline-final.log: built offline three-file package; five tools, editing, saved unchanged annotations bulk delete, save/reopen without resurrection; normal Chrome exit.
- native-roundtrip-mask.log: visible native AP pixel blue before delete, white immediately after and after reopen; offscreen native mark also tombstoned; link retained.
- principles-source-final.log: read-only copy inspection of 357 pages recognizes 60 marks, excludes 129 links. Original SHA-256 unchanged: 53ade40ce75c07455bd1d5a3829c5dd8efe925a65f1b5a54de756a9bea9dd378.

## Evidence limits
Failures preserved in preceding logs, including initial tombstone/planning regressions, AP pixel failure, and test-fixture resource wiring errors. Native AP pixel check tests a generated fixture, not destructive deletion in the user vault. No actual iPad acceptance claimed; user will sync and verify. WAL/storage protocol and PDF.js vendor unchanged. No user annotation records were deleted or migrated.
