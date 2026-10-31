# Native linked Highlight and two-end rename acceptance

Base: `0291e21d69e65fc3bdc1541fdc3adcaa61a97dca`.
Branch: `feature/v15-single-jsonl`. Product version remains 0.15.0.

## Behavior

- Markdown references materialize ordinary PDF.js Highlight editors through the existing external hydration, operation capture, and verified JSONL save path. No reference CSS background paints over the transparent PDF text layer.
- Optional `payload.editor.readerLink` contains `{version:1, anchorId, pdfTarget}`. Existing anchors and the incremental Markdown backlink index remain authoritative; no second index, annotation model, or storage format was introduced.
- UUID is stable per Selection Anchor. Reference-owned highlights cannot be removed by editor removal, delete commands, sidebar deletion, or bulk deletion. Removing the last Markdown reference authorizes ordinary persisted deletion. Manual annotations remain independent.
- Same-file Markdown navigation reuses an existing leaf. Exact navigation focus lasts three seconds and uses an underline/outline instead of opaque text-layer fill.
- PDF rename updates the optional target URL inside the existing verified JSONL relocation transaction. Markdown rename moves existing index rows before its metadata cache is ready.

## Native-discovered failure and fix

An actual Windows Obsidian test initially lost the auto Highlight after moving Markdown first and PDF second: the Markdown reference still existed, but its asynchronous identity binding was incomplete. A temporarily empty document lookup incorrectly authorized deletion.

The retained red regression is `a compact reference awaiting identity binding during a two-end move cannot authorize highlight deletion`. The existing index now exposes an O(1) compact-reference existence check. A saved linked annotation remains referenced during route rebinding; no Vault scan or second cache is needed.

Repeated actual `app.fileManager.renameFile` tests after the fix covered Markdown-first, PDF-first, and containing-folder moves. All published current-file preparations retained the same one annotation and UUID. JSONL target URLs followed each new PDF path. Exact Markdown source offsets survived both rename orders.

## Evidence

Local evidence is under `tests/artifacts/native-linked-highlight-*` and gate-run reports. Failure evidence is retained.

- Build: three release files, 406 embedded assets, 402 frozen vendor files verified; vendor diff is zero.
- Fast: 145 test files passed, 6 failed, 5 skipped. Compared with the retained pre-change Fast report (143/7/5), the packaging failure is fixed and no new failing file appears.
- Browser: 26 test files passed, 6 failed. The complete bidirectional-link browser test passes within this gate, including native editor color, durable link payload, removal protection, exact source navigation, and three-second focus assertions.
- Offline: five tools, external save/reopen and bulk-delete replay passed; normal browser cleanup recorded.
- Windows Native: trusted CDP mouse drag in the actual Obsidian test Vault produced a Selection link. A saved Markdown reference created a visible native Highlight and durable JSONL row. Close/reopen preserved UUID, text, geometry and payload exactly. Source text remains readable in `native-linked-highlight-native.png`.
- Actual Markdown/PDF rename and move events preserved exact source navigation. MD-to-PDF returned a successful Selection navigation result for the original Anchor ID.
- Two references retained one annotation after one reference was removed. Removing the last reference left zero editors and one matching tombstone. Ordinary source write attempts and `saveDocument` calls were zero; SHA-256 remained `1c8b9cca8c252fdd4fa6e56059c0479efe0789b7ef32765e21b4c2d1a72ff4c3`, XXH64 `xxh64-v1:30d01e5321bcbfee` after initial pairing.

The test Vault's existing legacy registry blocks normal creation of new v15 pairs. That registry was not migrated or replaced. First-pair and strict rename Native tests used a new isolated storage namespace through a path-remapping facade over the real Obsidian DataAdapter, with the unchanged production Host/Store and actual Viewer. The runtime Host and all instrumentation were restored afterwards. Existing paired-file save/reopen was also tested against the normal test Vault store.

## Remaining gate failures

Fast: browser-test-cleanup (platform skip policy), external-annotation-bridge (old mocks/oracles), input-architecture-boundary, mobile-main, pdf-annotation-host (native erase journal), vocabulary-v2-boundaries (frozen-byte audit).

Browser: desktop-toolbar, embedded-annotation-scan, free-text-native-ap-undo-regression, highlight-multiline-regression (diagnostic transform), mobile-browser-startup (settings mock), open-lifecycle-regression.

These failures were not skipped, assertions were not weakened, and timeouts were not enlarged. They remain release limitations; this document does not declare the full suite accepted. Real multi-device synchronization and physical iPad behavior are NOT_VERIFIED.

## Bundle identity

SHA-256:

- main.js: `24209620ca35ff2bd3a0c89d585c9aa66259fec6ada0d95eae1ddf6075c63599`
- manifest.json: `0de4ae88f535b1ce16ee6bf6fc17535f80dd8a95f0fc1458ad919ce608588e30`
- styles.css: `d22aa9ed97257fcf628f6da65acbb49d8e26b3fd0bff7dd7e93084923e67c9b1`

The normal test deployment command hit EXDEV while moving its backup between D: and C:. The test plugin was disabled with no open Readers, the three installed files were copied into `.deploy-backups/`, then the new three files were copied and their hashes verified before re-enabling. No test result relies on the failed deployment command.
