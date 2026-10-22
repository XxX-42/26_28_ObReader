# Learning Highlight browser acceptance

Command: `node --test tests/reader-bidirectional-link-browser.test.mjs`.

The existing real Chromium/PDF.js Viewer test now continues from a trusted pointer-created Highlight through toolbar Save, persisted Sidecar `payload.editor.text`, actual Sidebar Add to Review, actual learning Host and draft modal, explicit browser confirmation, existing transaction coordinator/sharded store/immutable History, actual Workbench Today row and Source, and exact UUID editor focus. Assertions retain document ID, docKey, page identity, source hash and text. Ordinary saves call PDF `saveDocument()` zero times; the fixture file SHA-256 remains unchanged.

The Obsidian Modal/Workspace interface and in-memory Vault DataAdapter are explicitly mocked boundaries. The existing browser Sidecar harness persists real Viewer operations in memory; this is not Native Obsidian or disk durability acceptance. Vocabulary Today is empty in this fixture: mixed-provider Today and E2E-5 LingQ -> Vocabulary -> Context -> Source are not claimed.

## Retained run receipts

- `test-results/backlink-failure-1792678913463-37072`: initial harness precondition failure; unsupported host `save` message produced no Sidecar row. Corrected to actual Viewer toolbar Save.
- `test-results/backlink-success-1792678948830-39364`: E2E-4 chain passed before input-ownership patch.
- `test-results/backlink-failure-1792679000776-43392`: after `ddcb866`, an existing document capture click observer no longer saw the renamed-page badge click consumed by the input owner. Replaced the observer wait with the actual exact-one host target-open message assertion, keeping its 5 second bound and source identity assertions.
- `test-results/backlink-failure-1792679046031-58400`: new learning chain passed, then the pre-existing annotation backlink step attempted to open while Highlight tool was active. Added an explicit no-open assertion for the active tool and switched back to mode 0 before navigation.
- `test-results/backlink-failure-1792679080366-27556` and `test-results/backlink-failure-1792679127024-7720`: the second click hit a plain DIV, initially suspected to be geometry movement. Root's subsequent screenshot inspection disproved that explanation: the still-open Highlight parameter popup covered the badge coordinate.
- Root receipt `test-results/backlink-failure-1792679277412-57536` likewise failed despite eight stable animation frames. The screenshot shows the popup at x835..1056/y35..226 covering the badge point x846/y156. The fixture now uses a trusted outside click on the existing page-number control to dismiss parameters, records before/after `elementFromPoint` HTML and badge geometry, and requires that the actual hit is the badge. This correction awaits a Browser lease; the overall post-input-patch suite is not yet claimed green.

Failure directories retain screenshot, trace and cleanup report locally. They are deliberately excluded from Git; source and this receipt are committed. No timeout increases, skip additions, production changes, deployment or user Vault writes were made for this test.
