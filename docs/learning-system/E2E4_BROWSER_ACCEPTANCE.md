# Learning Highlight browser acceptance

Command: `node --test tests/reader-bidirectional-link-browser.test.mjs`.

Final result: **PASS 1/1, zero skips**, 12.86 seconds; receipt `test-results/backlink-success-1792681232461-24864`. This is the final run with explicit document/docKey/source-route and selection-offset assertions. Earlier complete green run: `test-results/backlink-success-1792681184610-27080`. These are deliberate post-repair validation runs, not retries selected for a green result.

The existing real Chromium/PDF.js Viewer test now continues from a trusted pointer-created Highlight through toolbar Save, persisted Sidecar `payload.editor.text`, actual Sidebar Add to Review, actual learning Host and draft modal, explicit browser confirmation, existing transaction coordinator/sharded store/immutable History, actual Workbench Today row and Source, and exact UUID editor focus. Assertions retain document ID, docKey, page identity, source hash and text. Ordinary saves call PDF `saveDocument()` zero times; the fixture file SHA-256 remains unchanged.

The Obsidian Modal/Workspace interface and in-memory Vault DataAdapter are explicitly mocked boundaries. The existing browser Sidecar harness persists real Viewer operations in memory; this is not Native Obsidian or disk durability acceptance. The final fixture also passes real LingQ -> Vocabulary -> Context -> Review enrollment -> mixed-provider Today -> exact Context Source, plus actual Context Add to Review and explicit learning confirmation. External ECDICT is explicitly unavailable; no resource-v2 performance claim is made.

## Retained historical run receipts

- `test-results/backlink-failure-1792678913463-37072`: initial harness precondition failure; unsupported host `save` message produced no Sidecar row. Corrected to actual Viewer toolbar Save.
- `test-results/backlink-success-1792678948830-39364`: E2E-4 chain passed before input-ownership patch.
- `test-results/backlink-failure-1792679000776-43392`: after `ddcb866`, an existing document capture click observer no longer saw the renamed-page badge click consumed by the input owner. Replaced the observer wait with the actual exact-one host target-open message assertion, keeping its 5 second bound and source identity assertions.
- `test-results/backlink-failure-1792679046031-58400`: new learning chain passed, then the pre-existing annotation backlink step attempted to open while Highlight tool was active. Added an explicit no-open assertion for the active tool and switched back to mode 0 before navigation.
- `test-results/backlink-failure-1792679080366-27556` and `test-results/backlink-failure-1792679127024-7720`: the second click hit a plain DIV, initially suspected to be geometry movement. Root's subsequent screenshot inspection disproved that explanation: the still-open Highlight parameter popup covered the badge coordinate.
- Root receipt `test-results/backlink-failure-1792679277412-57536` likewise failed despite eight stable animation frames. The screenshot shows the popup at x835..1056/y35..226 covering the badge point x846/y156. The fixture added a trusted outside click on the existing page-number control to dismiss parameters, recorded before/after `elementFromPoint` HTML and badge geometry, and required that the actual hit is the badge. At this stage the suite remained red; the later production focus repair was also necessary.

Failure directories retain screenshot, trace and cleanup report locally. They are deliberately excluded from Git; source and this receipt are committed. No timeout increases, skip additions, production changes, deployment or user Vault writes were made for this test.

## E2E-5 source preparation history

The source now additionally wires an opt-in real VocabularyRuntime/personal VocabularyService/ContextSourceVerifier/ReaderAnchorStore. `learning-browser-production-methods.mjs` extracts the unchanged production main.js methods and validators at run time, including real LingQ message handling, pending Reader capture, Context preview/commit, `openVocabularyContext` and `applyPendingReaderTarget`. The fixture replaces only Obsidian communication/UI boundaries and reports the external ECDICT dictionary as unavailable.

`learning-context-browser-flow.mjs` uses the actual LingQ pill status control, trusted PDF sentence drag, actual Context capture/confirm, real Workbench Vocabulary enrollment, mixed Today providers, Vocabulary Source to exact Context anchor, Context Add to Review with explicit draft confirmation, and Context Source. No Vocabulary/Context/Review row is pre-seeded. Initial preparation passed syntax/extraction/bundle checks; the final Browser receipts above subsequently exercise this complete chain.

## Post-root-fix Browser failure: owned badge focus changes tool

After syncing root `e3786f5`, `310e9ed`, `bc70cc6`, `84a1c22`, `254d8cc`, the same command failed in `backlink-failure-1792680494138-2932`, `backlink-failure-1792680537005-1708`, and instrumented `backlink-failure-1792680590365-17128`. The E2E-4 stage receipt is retained. Before-click `elementFromPoint` proves the real badge is unobscured; popup/geometry is no longer a sufficient explanation.

The final trace records: mode 0 pointerdown hits exact UUID badge; `canActivate=true`; controller returns `true`; mousedown remains mode 0; native focus moves page-number input -> badge -> annotationEditorLayer; pointerout/pointerup/mouseup/click then run in mode 9; focus finally reaches selected Highlight editor. No controller click is forwarded because Bridge's tool guard rejects it. This is evidence of native default focus changing tool ownership after the badge's pointerdown was accepted. No production repair has been made by this test agent. Root owns the repair decision; complete gate remains red, and E2E-5 remains unreachable until this earlier step passes.

## After root focus repair

Root production `098712e` lets the real badge sequence proceed to E2E-5. Receipt `backlink-failure-1792680731870-18332` then identified a fixture setup error: ReaderAnchorStore needs an injected ID factory. The fixture now supplies `crypto.randomUUID`.

Receipt `backlink-failure-1792680754119-15900` reaches real LingQ status-2 persistence and trusted PDF sentence selection (`Dynamic languages such as JavaScript are more difﬁcult to com-`), then fails because the Context capture control has disappeared. Bridge's existing outside-click hook dismisses the pill on the drag's ending click before checking native noncollapsed selection. This blocks the pointer selection -> Context capture journey. Root has been notified; the test does not bypass it using seeded Context rows or direct domain calls. Complete Browser gate remains red.

Root `671833a` repairs sentence-selection dismissal. Receipt `backlink-failure-1792681104776-49164` then identified a fixture signature mismatch: production runtime's source verifier receives `{ anchor }`, while ContextSourceVerifier consumes `anchor`; the fixture now uses main.js's exact `({ anchor }) => verify(anchor)` wrapper. Receipt `backlink-failure-1792681147383-41360` identified a transient UI status wait: Workbench immediately rerenders after enrollment and replaces its status. The fixture now waits for the actual enrollment callback after `review.flush`, then requires both real Vocabulary and Learning rows in Today. No timeout was increased.

Final receipts retain exact owned-badge pointerdown/up/click mode 0 and exact-one source opening, plus real keyboard focus + Enter returning one source request without tool activation. Context source evidence retains document ID/docKey, anchor ID, SHA identity, source path, exact quote and text offsets (606..668 for this fixture). PDF SHA-256 remains `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`; PDF `saveDocument()` calls remain zero. Canonical writes are restricted to learning/vocabulary/context/review/history fixtures; source-PDF writes are rejected by the DataAdapter guard.
