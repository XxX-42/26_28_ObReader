# Initial backlink query after source confirmation

Native macOS on `c08049a` exposed a separate issue from page-badge source
aggregation. The Viewer sent `reader-backlink-page-1-1` immediately after
reporting source identity. Host identity verification was still asynchronous,
so the hydration guard rejected that first page query before recording its ID.
The confirmation callback then refreshed the page without an ID. Its one valid
backlink could not pass the Viewer's existing current-request correlation.
Same-page deduplication prevented another query until the user changed pages.

The retained passive wire trace proves this order. Changing page 1 to 2 and
back produced correctly correlated `-1-2`/`-1-3` replies and restored the badge;
that diagnostic workaround is not an acceptance substitute.

The correction leaves all source, session and request guards in place. If a
Host refresh has no accepted current-page request ID, it sends an authenticated
page-refresh notification instead of an unsolicited result. The Viewer checks
document, open request, renderer, current page identity and source hash, then
issues a fresh request through its existing query/controller path. Once a
request is accepted, subsequent index refreshes continue to echo that ID.
Neither annotation hydration nor storage code changes.

Three Host regressions reproduce the first-query race, retain accepted-ID
refreshes, and reject superseded-page results. The complete Host file passed
104/104 after the correction. Tests also execute the real bridge functions and
BacklinkInteractionController to verify authenticated same-page requery, fresh
IDs and rejection of stale/uncorrelated results. The combined Host, bridge,
controller and LearningHost files passed 135/135, with no skips. Native
re-verification is separate required evidence; these focused tests alone do not
close the Native gate.

Native evidence is retained in branch `codex/014-native-final-resume`, commit
`542fb89`, under `evidence/native-final-resume/`:
`backlink-exact-wire-controller.json` and
`backlink-correlation-diagnostic-page1.png`. The controlled default data trees
contained 122 files and were unchanged by complete per-file SHA-256 comparison.
An earlier harness reload-before-disable-persisted incident has no historical
full-tree before-hash and remains explicitly unverified.
