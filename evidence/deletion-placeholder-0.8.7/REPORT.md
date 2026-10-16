# 0.8.7 deletion placeholder identity

Baseline: 2e1159e (0.8.6). Preserved prior reproduction at evidence/unknown-record-trace/reproduction.json.

- A deleted AnnotationStorage row must resolve an existing UUID; it never calls makeSyncUuid.
- Recover metadata from exact runtime binding, prior snapshot, or unique same-page canonical source ref in verified external/native deletion rows. No coordinate matching.
- A removed native editor can remain in AnnotationStorage; use its retained object to recover type and keep its exact binding during hydration teardown until storage no longer retains it or the document resets.
- Unresolved/ambiguous identity throws annotation-deletion-identity-unresolved before creating any map binding. The row is not silently dropped; operation completeness and lossless payload guards remain unchanged.
- New live annotations still allocate UUIDs normally. Existing 250ms best-effort close policy preserved.

112 targeted regressions passed, covering native AP deletion persistence, desktop toolbar, hydration, architecture, close and WAL. Additional final 19 capture/close tests passed, including ambiguous refs, no allocation on deletion, retained native type, binding lifetime and genuine new annotation creation. Built offline three-file smoke passed five tools, deletion, save/reopen without resurrection, normal browser exit. Actual iPad validation remains pending user sync/restart.

No WAL protocol/vendor changes; no user PDF or annotation data deletion. Full plugin and external data backup before three-file replacement. Original source hash is recorded before/after deployment.
