# 0.8.6: close without persistence veto

Root cause: PDF.js deleted placeholders can contain only `{deleted:true}`; Unknown is truthy so the old kind fallback never ran. Resolve kind from exact UUID/ref-bound external or prior snapshot metadata; preserve the original guard for genuinely unidentifiable payloads. No UUID/geometry guessing, no source writes.

Closing: best effort 250ms; failed, disconnected, throwing or unresponsive Viewer cannot veto close. Permission remains distinct from saved/recovered acknowledgement; warn once for unconfirmed operations. Direct SDK onClose also uses bounded flush.

105/105 targeted regressions passed (close including silent/throwing renderer, deletion capture, native AP browser, architecture, WAL). Final built offline three-file five-tool/bulk-delete-save-reopen passed, normal Chrome exit. Actual iPad acceptance pending.

Disk inventory found no unsupported annotation kind, so no valid legacy marks were deleted. Screenshot UUID 87c4ed69-6b4e-45bf-991f-97219d66739c already has an Ink tombstone. Old logs/data remain recovery sources. Original PDF untouched. No WAL protocol changes or vendor changes.
