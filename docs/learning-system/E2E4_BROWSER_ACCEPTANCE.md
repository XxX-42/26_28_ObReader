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

## E2E-5 source preparation (awaiting Browser lease)

The source now additionally wires an opt-in real VocabularyRuntime/personal VocabularyService/ContextSourceVerifier/ReaderAnchorStore. `learning-browser-production-methods.mjs` extracts the unchanged production main.js methods and validators at run time, including real LingQ message handling, pending Reader capture, Context preview/commit, `openVocabularyContext` and `applyPendingReaderTarget`. The fixture replaces only Obsidian communication/UI boundaries and reports the external ECDICT dictionary as unavailable.

`learning-context-browser-flow.mjs` is wired after E2E-4 to use the actual LingQ pill status control, trusted PDF sentence drag, actual Context capture/confirm, real Workbench Vocabulary enrollment, mixed Today providers, Vocabulary Source to exact Context anchor, Context Add to Review with explicit draft confirmation, and Context Source. No Vocabulary/Context/Review row is pre-seeded. These additions have passed syntax checks, production-method extraction/evaluation and browser bundle compilation only; they have **not** run in Browser yet and are not acceptance evidence.

## Post-root-fix Browser failure: owned badge focus changes tool

After syncing root `e3786f5`, `310e9ed`, `bc70cc6`, `84a1c22`, `254d8cc`, the same command failed in `backlink-failure-1792680494138-2932`, `backlink-failure-1792680537005-1708`, and instrumented `backlink-failure-1792680590365-17128`. The E2E-4 stage receipt is retained. Before-click `elementFromPoint` proves the real badge is unobscured; popup/geometry is no longer a sufficient explanation.

The final trace records: mode 0 pointerdown hits exact UUID badge; `canActivate=true`; controller returns `true`; mousedown remains mode 0; native focus moves page-number input -> badge -> annotationEditorLayer; pointerout/pointerup/mouseup/click then run in mode 9; focus finally reaches selected Highlight editor. No controller click is forwarded because Bridge's tool guard rejects it. This is evidence of native default focus changing tool ownership after the badge's pointerdown was accepted. No production repair has been made by this test agent. Root owns the repair decision; complete gate remains red, and E2E-5 remains unreachable until this earlier step passes.
