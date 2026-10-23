# Windows Native 0.14 candidate — 2026-10-23

Source: `3eff47f3e21e9e4abc3e458b7c544317750ccecd`. Test Vault:
`D:/Documents/Obsidian/测试插件`; Sync disabled. Production Vault untouched.

The test plugin was disabled, backed up, deployed with `npm run deploy`, and
the test Vault window reloaded with the Obsidian `reload` CLI command.
Runtime manifest then reported 0.14.0. This was a window reload, not process restart.
Before plugin enable, the existing Native isolation installer mapped PDFData and
VocabularyData (including Context, Review, History, transactions and routing) to
`.native-learning-loop/windows-native-014-20261023-1433`. Dictionaries remained read-only.

## Observed UI results

- Highlight created with trusted mouse drag, saved revision 2/confirmed 2;
  UUID `a2d1ef04-6750-4d3a-97a4-c67a0ed0b148`.
- Sidebar Add Review, manually typed question and explicit confirmation created
  the first Today item. Source returned `reader-nav-1-1`, annotation, same UUID,
  exact current document/openRequest/rendererGeneration, `ok:true`.
- LingQ Dynamic status 1 saved through the visible pill. A trusted cross-line
  selection captured the complete first Abstract sentence including punctuation.
  Context confirmation, Context Add Review, manually typed question and explicit
  confirmation created the second Today item.
- Context Source returned `reader-nav-1-2`, selection,
  `context-d11edd6f2dbe2e5f5b58467646eaade71ae320c90d7b544c566b9e8e623c67a9`,
  exact current session fields and `ok:true`.
- PDF rename and move, complete Reader close, and Today Context Source reopen
  resolved the moved PDF and the same context anchor in a new renderer generation.
  Vocabulary/Context/Review/History non-route bytes were unchanged.
- A Markdown excerpt was selected through the actual editor, manually confirmed
  as a third learning item, renamed and immediately moved using Vault CLI commands.

## Blocking RED

Today Markdown Source returned `markdown-excerpt-changed` after consecutive
rename/move. Actual file text and saved sourceRange text both remain exactly 57
characters (`0..57`). Binding facts contain initial `source.md` and first rename
`source-renamed.md`, but no subsequent `moved/source-renamed.md` route fact.
This demonstrates a missing second route update in this run; the underlying
event/queue cause still needs a focused regression. It is not the previously
fixed EditorPosition/EditorRange error.

Testing stopped at this RED. Combined PDF/Markdown moves, closed-Markdown move,
plugin reload recovery and process restart are NOT RUN. No complete matrix PASS
is claimed.

## Integrity and evidence

Independent Node `readNativeWalEvidence` validated the persisted JSONL/anchor
integrity and recovered exactly the expected Highlight UUID. Source PDF SHA-256
after rename/move remains
`3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`.
All 371 pre-existing PDFData/VocabularyData files retain their original hashes.
No domain APIs created or confirmed annotations, Context or Review records.

Full local evidence and before/after hashes:
`D:/Documents/Codes/2026_7_PdfWebReader/windows-native-014-evidence/`.
`markdown-route-red.png` preserves the error screenshot; JSON files preserve
adapter traces, physical file hashes and independent WAL replay.
The test-only evidence collector is `tests/native-windows-learning-evidence.mjs`.
Build passed (406 embedded runtime assets, 402 verified frozen vendor files).
No production code was changed during this Native run.

## Follow-up on 2a65283 integration

Merged the integration containing `f8b8f18` (serialized complete LearningHost
rename processing), rebuilt and deployed only to the test Vault. Backup:
`.deploy-backups/2026-10-23T15-15-15-166Z/pdf-web-reader`.

The deployment script backs up the entire plugin directory, including test-only
`.native-learning-loop` storage. The old 1433 run remained intact in that backup.
The newly created fixture data was preserved separately as run 1515; the original
1433 run was restored from backup without merging or rewriting its records.
Both runs are retained. Future redeployment must explicitly preserve this test
storage before continuing a run.

New run 1515 used a new Markdown fixture and a real editor selection, manually
typed question and explicit confirmation. Consecutive rename/move while open
now passes Today Source: actual host completion captured `result:true`, exact
destination path, selection text, and editor range `{line:0,ch:0}` to
`{line:0,ch:65}`. Closing all fixture Markdown leaves, moving the file again, then
Today Source also passes with the same exact range. Plugin reload followed by
Today Source passes. Non-route Vocabulary/Review/History bytes remain identical
across those route-only steps. Old missing-route RED records were not repaired.

After restoring the original run, the new candidate still opens its original
Highlight UUID and full-sentence Context Anchor through Today UI. Exact current
ACK session identities were checked; requests were respectively `reader-nav-1-1`
and `reader-nav-1-2` in renderer `e1eff7e3-9b81-4b3b-9858-c354de118a71`.
Original run Context/Review/History non-route bytes remain unchanged from the
historical RED capture, and independent WAL replay retains the original UUID.

Remaining NOT RUN: combined PDF+Markdown move in one unified fixture run and a
dedicated owned-process restart. Window reload and plugin reload have been
executed, but neither is reported as process restart. Full Native matrix is
therefore not accepted yet.
