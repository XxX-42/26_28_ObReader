# 0.8.8: do not resurrect native editors on tool activation

The user screenshot reports zero delete targets while source marks remain visible. Disk sidecar has zero live annotations and 249 tombstones. A new failing regression reproduced PDF.js creating a live native editor from the immutable source after deletion, reopen, and Ink activation. Prior AP checks covered read mode only and missed this lifecycle.

Fix: tool-mode change schedules session-guarded reapplication of verified external tombstones for rendered pages. Bind each recreated editor to its exact tombstone UUID/ref before removal, preserving deletion capture metadata. No new identities, source edits, protocol changes or vendor edits.

Evidence:
- tool-before.log: real native editor resurrected after selecting Ink, expected zero; failure preserved.
- tool-after.log: same scenario passes after fix.
- principles-copy.log: initial pixel-control comparison had 2581 differences caused by using rounded canvas dimensions as the scaling transform; preserved. Corrected test uses PDF.js actual outputScale rather than changing expected pixel values.
- principles-final.log: exact user source copied into independent test vault; actual sidecar 249 tombstones loaded into isolated host. Page 2 Ink/Highlight/None/Ink cycles: zero live editors each. 955208 canvas pixels compared against annotation-disabled rendering: zero differences. Original PDF SHA-256 unchanged.
- regression.log: 94 targeted native/desktop/capture/close/WAL tests pass.
- final-lifecycle.log: 26 final native/architecture/bulk/close tests pass.
- offline.log: built three-file package five tools, deletion/save/reopen pass with normal browser exit.

iPad WKWebView device acceptance remains pending. This evidence does not claim iPad execution. User source and external records were not changed; backup precedes three-file deployment.
