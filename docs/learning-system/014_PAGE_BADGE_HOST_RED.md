# Page backlink badge Host RED

Baseline integration: `81d5ada`. This test-only change does not alter main,
bridge, listeners/channels, stores, canonical data or WAL.

The real `handleReaderBacklinkTargetOpen` uses the existing page index but then
filters all rows by exact target kind/id, even for a page badge. A selection
backlink therefore contributes to page presentation but is removed when opening
the page's source list. A mixed page containing a page-kind link opens only that
link, skipping the required aggregate choice. Current guard validation also
accepts a page targetId that differs from its verified pageIdentity.

New tests in `tests/plugin-host.test.mjs` exercise the real Host method and real
ReaderBacklinksModal with the existing mocked Obsidian harness. The Modal mock
now records its actual child buttons/listeners so choosing an aggregate source
can be asserted; it does not replace filtering or modal implementation.

Executed:

`node --test --test-name-pattern='page backlink badge|Reader backlink target-open' tests/plugin-host.test.mjs`

Observed in about 252 ms: **2 PASS, 3 RED**.

- Sole selection source: returned true, but actual source openings were empty.
- Mixed selection/annotation/page sources: actual direct openings 1, expected 0
  before the choice modal; expected modal lists every page source and dispatches
  the explicitly chosen row through the existing viewer-modal path.
- Forged page targetId: actual true, expected false. The test first passes stale
  renderer/openRequest, mismatched page identity/number and cold-index guards.
- Asynchronous hydration revocation: PASS, no opening/modal after index await.
- Existing exact annotation/selection filtering, wrong-page and cold-index
  regression: PASS, original assertions retained unchanged.

Retained raw output outside Git:
`/Users/jiajia/.codex/worktrees/obreader-0.14/evidence/page-badge-host-red.log`

SHA-256: `16aaedcfb77200701e3da6f9dac7e99f81035f3e31d31a85f5b843da36029408`.

Intended thin correction: validate page targetId against pageIdentity before
aggregation, then use the verified page's existing source rows for a page badge;
retain exact kind/id filtering for selection/annotation intents and all current
runtime/page/index guards. No new listener, channel or store is needed.

This is intentionally RED against the baseline. No browser, Native, build,
benchmark or full gate was run. Native acceptance remains PENDING.
