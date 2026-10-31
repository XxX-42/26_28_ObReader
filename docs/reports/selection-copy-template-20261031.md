# Selection copy templates — 2026-10-31

Base: `7f03126429395b6a7d168e4e3b26bf601ed28173`.
Branch: `feature/v15-single-jsonl`.

Settings → PDF Web Reader → 阅读器 now exposes the auto-copy toggle, six copy
presets, an editable copy template, a display-text template, example preview and
supported-parameter help. Both text areas use the full settings-row width.

Presets: stable link, short display text, link without alias, selected text only,
PDF++-style quote, and callout. Defaults preserve the existing stable link and
display text. Common PDF++ data placeholder names are supported; arbitrary JS,
app, Dataview and QuickAdd APIs are deliberately not implemented. Unknown
expressions and malformed braces are rejected; invalid edits do not replace the
last valid persisted setting. Color variables contain the actual highlighter
color value, not a PDF++ custom palette name.

Reference: https://ryotaushio.github.io/obsidian-pdf-plus/templating.html

The existing anchor capture/validation, clipboard sequence guards, page splitting
and backlink index remain authoritative. Formatting runs in a pure Host helper;
there is no new backlink protocol, index, annotation schema or PDF write path.
Page labels come from already loaded page views, and colors from the existing
tool-color controller. Text-only output intentionally creates no Markdown
reference when pasted; it therefore does not create backlink highlighting.

## Tests

* Final formatter/auto-copy/Host/dictionary tests: 140 passed, 0 failed.
  `tests/artifacts/copy-template-final-targeted.log`.
* Anchor Store and real PDF.js bidirectional browser tests: 15 passed, 0 failed.
  `tests/artifacts/copy-template-browser.log`.
* Offline final build: five tools, save/reopen and bulk-delete smoke passed.
  `tests/artifacts/offline-smoke-1793414836027-5784-101468f4-932a-4743-8e48-3888956b372a.cleanup.json`.
* Full Fast: 142 files passed, 7 failed, 5 skipped; exit 1. Existing failed-file
  set remains. A newly exposed dictionary-settings mock missing the standard
  dropdown/textarea APIs was repaired; no assertion was removed.
  `tests/artifacts/vocabulary-gates/runs/run-2026-10-31T02-47-06-063Z-24616-83ca35f8/report.json`.
* Full Browser was not rerun for this settings-only extension. Affected Browser
  coverage above does not represent an all-green release gate.

## Actual deployment / Native

Test vault deployed first, then formal vault at the user's explicit request.
Before replacing files, clean Reader revisions were checked, Reader leaf states
preserved, the plugin disabled, and installed trio copied to a local backup.
After replacing only main.js/manifest.json/styles.css, the plugin was enabled
and Reader leaves restored. Production PDF/annotation files were not manually
edited by this task.

Formal vault: `D:\Documents\Obsidian\远程仓库1`.
PDF: `12_books/别毙了那只狗教养和训练的新艺术.pdf`.
Native UI showed both textareas at 567 CSS px width. Actual UI selection of the
quote preset persisted `> {{text}}\n\n{{linkWithDisplay}}` in plugin data.json.
Actual mouse drag returned:

```text
> 豚跳跃为例，当它跃入空中时我不可

[[12_books/别毙了那只狗教养和训练的新艺术.pdf#page=40&selection=3%2C0%2C5%2C10&obreader=sel.c08950da-35ad-4365-a631-b9bdeba070d2|别毙了那只狗教养和训练的新艺术 · p.40]]
```

Actual UI edit to `p{{page}}：{{text}}\n{{link}}` switched the preset selector to
Custom and persisted. The user then started editing that field. Automation
stopped input; the malformed-brace preview was verified to preserve the last
valid setting. That in-progress user edit was not overwritten. A separate
Native mouse test of that custom template was not performed after user input.

Source PDF SHA-256 remains
`a971feb1bc901cc995cb9144da6368fb7eb895007e37ab65e8703d4ffdcaaf81`.
Copied links create existing Selection Anchor records as intended; this is not
a claim that the entire annotation directory stays byte-for-byte unchanged.

Follow-up at the user's request: `{{link}}` now returns the bare destination,
identical to `{{linktext}}`, without `[[ ]]`. This intentionally differs from
PDF++'s variable convention. Use `[[{{link}}]]` to wrap it explicitly;
`{{linkWithDisplay}}` retains the complete wikilink. The bare-link regression was
red before this change; final formatter/auto-copy/Host tests passed 133/133.
