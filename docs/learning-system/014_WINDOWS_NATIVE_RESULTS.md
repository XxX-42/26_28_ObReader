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

## Remaining matrix continuation on the same candidate

Used the actual Copy Reader Link command on a trusted cross-line PDF selection,
then pasted its clipboard result into the actual Markdown editor. MetadataCache
indexed `roundtrip.md`; clicking the rendered link returned the exact Selection
Anchor `0c4c4976-f881-4323-a5a8-a8f5220721dc` with current-session ACK.
Clicking the CSS selection backlink returned the same Markdown source with exact
editor selection `0..264` (the original link). This is actual UI navigation,
not an injected index row or domain-created learning object.

In original run 1433 both PDF and roundtrip Markdown were moved while open into
`paired/`. Clicking the Markdown link still returned the same Selection Anchor.
All fixture Markdown leaves and Readers were then closed, both files moved into
`closed-pair/`, and the Markdown link again reopened the exact same Selection
Anchor in a new renderer. Its request was `reader-nav-1-1`, renderer
`503e46a4-3711-4547-86c9-1995eee01fce`, openRequest 1.

The Sidebar row was clicked and its selected `data-uuid` remained
`a2d1ef04-6750-4d3a-97a4-c67a0ed0b148`. Direct Context-tab "验证并打开来源"
then returned the original full-sentence context anchor with `reader-nav-1-2`
and the same exact current document/open/renderer identity. Thus the five
navigation directions have real UI evidence: Review Source, selection backlink
to Markdown, Markdown to PDF, Sidebar to Highlight, and Context to PDF.

### Additional deterministic RED: aggregate page badge

The page index contains one selection backlink. The page badge displays one
Markdown reference, but clicking it sends `targetKind=page` and the Host filters
rows strictly by matching target kind/id. There is no page-kind row, so no
Markdown navigation occurs. The target-open message is observed with current
session identity (`backlink-open-1-1`). The selection backlink itself works.
Root integration is handling this separately; this branch preserves the RED
and does not change production code.

### Process restart boundary

Independent owned-process restart remains NOT RUN. Windows process inspection
shows main PID 39828 using the ordinary Roaming/obsidian profile, with test
renderer 35696 and another Vault renderer 32536 under that same process. The
other Vault has its own Reader/settings windows. Killing/restarting the shared
main would affect that Vault. No owned isolated process identity was available;
window and plugin reloads are not substituted for this gate.

At the final location source PDF SHA-256 is still the original value above.
Independent WAL replay passes, original non-route Context/Review/History bytes
match the historical RED baseline, and all 371 pre-existing files are unchanged.
Combined moves are now verified; remaining blockers are aggregate page badge
and the independently owned-process restart coverage.

## Aggregate badge fix continuation on c08049a

Merged the integration `c08049aa825954d12cc50b43c91b29dc8691e9d6`, rebuilt,
closed Readers and disabled the plugin. Before deploy all 44 files across both
test runs were hashed. After deploy they were restored exactly from the new
`2026-10-23T15-35-21-418Z` backup; every hash matched before initialization.
Isolation was reinstalled before enable, runtime 0.14.0.

Actual Markdown link click returned the same stable Selection Anchor with
`reader-nav-1-1`, openRequest 1, renderer
`db06474d-2ea4-4ea0-8541-21fc6550b179`, `ok:true`.
After a real page 2 -> page 1 transition displayed the existing page badge,
clicking that aggregate badge now returned the sole selection-link Markdown
source. Host completion captured `result:true`, correct `closed-pair/roundtrip.md`
and exact current link selection `0..203` (Obsidian shortened the link path during
the previous file moves). The historical badge RED remains recorded above.

Host plus Learning regression: 119/119 pass, zero failures/cancellations/skips.
Independent original WAL replay still passes; all 371 existing data hashes and
the original non-route canonical/Context/Review/History bytes remain unchanged.
Installed main.js SHA-256:
`142553f7179079022bd07fd9e80ee78ab8fcd239dded7c76b0c62609e11c320c`.

Remaining observed presentation gap: the backlink badge/CSS highlight was absent
immediately after Markdown opened page 1 and became visible after the real
page 2 -> 1 transition. This happened before and after the aggregate click fix.
The initial paint/request lifecycle needs a separate reproduction; success of
the badge click after page transition does not clear that observation.
Independent owned-process restart remains NOT RUN for the shared-process reason
above. Full Native acceptance is not claimed.

## Owned-process startup attempt

After closing Readers, persistently disabling the test plugin, and closing only
the test Vault window, the former test renderer 35696 no longer existed. The
other Vault windows and shared main process 39828 remained running.
A unique profile `windows-native-014-evidence/owned-profile-20261023-1546`
was created outside the repository with a marker restricting it to the existing
test Vault and a one-Vault `obsidian.json` configuration. New main PID 27200 had
that exact `--user-data-dir` and `--remote-debugging-port=0`; its renderer 26704
was its own child. The endpoint from that profile's DevToolsActivePort exposed
one app page for `D:/Documents/Obsidian/测试插件`, registry 0.14.0, plugin unloaded.

Startup stopped at the fresh-profile trust dialog: "你是否信任这个仓库的作者？".
The task forbids changing application security settings, so trust was not
confirmed or bypassed and plugin initialization was not attempted in that
profile. An independently owned process was established, but complete process
restart/Source recovery remains NOT RUN. Its exact main PID/command line were
revalidated before stopping only owned PID 27200. Shared main 39828 remained
running. The normal test Vault was reopened with its plugin still disabled.
