# 0.14 final integration audit — acceptance remains PENDING

Read-only audit on 2026-10-23 by the independent `audit_sol_low` agent.
Compared baseline `cd6e15743d5065dfe53579d658dde18580c84e9f`, integration
`af467c7`, and private resource-v3 staging `d83b59b`. This document records
those snapshots, not later branch state. No tests, benchmarks, build, browser,
Native operations, deployments, or production code edits were performed in
this final audit turn.

## Frozen data and core boundary

The baseline-to-staging file diff contains no changes to `plugin/storage/`,
`plugin/pdf-annotation-host.cjs`, `plugin/pdf-annotation-store.cjs`,
`plugin/pdf-recovery-read.cjs`, `plugin/vocabulary/canonical.cjs`,
`plugin/vocabulary/transactions.cjs`, `plugin/vocabulary/history.cjs`,
Vocabulary Context/Review modules, `viewer-adapter/input/`, or `vendor/`.
No source-PDF changes appear in the diff. This is source-diff evidence, not
runtime byte-invariance evidence or a new execution of the historical frozen
hash manifest.

Shared Host and bridge are not byte-identical to baseline. Changes include
navigation request/target ACK correlation and latest-navigation fencing,
Sidebar review delegation, PDF folder routing, Markdown exact-source routing,
and the Windows disposable asset-cache path adaptation. These must be named
explicitly; “all navigation unchanged” would be inaccurate. Learning service
also adds a request verifier and read-only item enumeration; its canonical
schema and coordinator/History implementation are unchanged.

## Production changes and RED evidence ledger

| Change | Deterministic evidence inspected | Evidence limit / status |
| --- | --- | --- |
| Runtime ACK correlation / bridge sequence, `36a31fa` | `tests/plugin-host.test.mjs`: current-request test rejects wrong request, target, renderer and openRequest, consumes one ACK; bidirectional-link browser assertions amended | Retained `navigation-red.log` inspected: 1 fail, missing runtime request ID (`undefined` versus `string`). Follow-up Host 95/95 and Browser 1/1 receipts inspected; Browser is not Native. |
| PDF containing-folder route, `6e05a5f` | `tests/plugin-host.test.mjs`: folder rename checks open and closed document identity routing | Retained `folder-rename-red.log` inspected: 1 fail, route stayed `Books/Folder/book.pdf` instead of `Archive/Folder/book.pdf`. Native partial evidence records foldermove pass, not the complete route matrix. |
| Windows compact asset path, `4f0ce4c` | `WINDOWS_RESOURCE_PATH_014.md`: same bytes/hash fail at long app URL and load at short URL; records path-length regression RED | Windows reload and learning-flow acceptance still pending; path threshold is not established. |
| Markdown EditorRange call, `e43f30a` | `014_MARKDOWN_SOURCE_SCROLL.md` plus Native verdict: exact selection succeeds but old scroll call throws; stricter API-shaped Host mock recorded RED | Production correction is present; post-fix complete Native continuation remains pending. |
| Saved Learning / failed Markdown route retry, `f54b3db` and `c4fe6c2` | `tests/learning-host.test.mjs`: injected route commit failure, visible unresolved state, cached receipt retry with source/unload rejection, canonical/History bytes unchanged | Deterministic fault-injection regression; this auditor previously executed 22/22 focused tests. No durable second authority introduced. |
| Resource-v3 source fallback and stale generation, `9a07c1d` (source `edf1451`) | `tests/dictionary-resource-v3.test.mjs`: unknown active cache, different generation, stale failed manifest, invalidated awaited v2 lookup | Earlier independent deterministic reproducers identified these defects; both active-cache escapes and stale status publication are closed in current code. |
| Dictionary ancestor watcher, `afd1d0e` / `0f6942e` | `DICTIONARY_ANCESTOR_WATCHER_RED.md`: actual classifier and handler yielded three RED cases; seven existing cases passed | Root reports 28/28 after minimal production repair. This final audit did not rerun them. Closed, not a remaining blocker. |

New facade/routing/dictionary capabilities have regression coverage. Retained
pre-fix logs supplied by root were read directly without rerunning tests; they
close the initially uncertain ACK/folder-route RED receipt question. The
navigation RED specifically demonstrates absent ACK correlation; it does not
independently measure every possible overlapping navigation interleaving.

## Semantic contract, facades and routing

`SemanticAnchorContractV1` is an API projection, separate from canonical
Learning source. Target remains flat `{ kind, id }`. `VERIFIED` requires exact,
current source/page evidence; `RECOVERABLE` requires explicit non-exact page
fallback opt-in. Owner routing context is request-scoped and is not copied into
the canonical SemanticAnchor.

The public seams are LearningHost, AnnotationSidebarService and BacklinkService.
The latter two simply delegate operations; Sidebar rows come from the current
hydrated effective Reader and are copied before exposure. Navigation reuses the
existing Reader target path. Backlink resolution uses the existing page/index
and exact-source checks, including request identity after asynchronous work.
There is no new authoritative annotation or personal-record store.

Markdown file bindings/aliases live outside canonical Learning shards. Rename
uses external route facts; missing/corrupt/conflicting bindings fail closed.
Observed rename can update bindings; an unobserved move remains unresolved
until explicit binding. Source checks retain exact range/text and do not search
for an equivalent quote elsewhere. Same-page/cross-page identical-quote UUID
substitution has the additional `982e1f7` regression. Existing legacy
`renameMarkdownSource` service code remains; the Host route path does not invoke
it for this behavior. Do not confuse old audit findings about that path with
current integration behavior.

Semantic contract acceptance is **PENDING**, not FROZEN. Existing unit coverage
is not proof that the full Native route/restart/complete-sentence matrix passed.

## LingQ, dictionary and performance limits

Private staging adds default v3 roots, event invalidation, bounded manifest-only
startup availability and direct range-block lookup. No-term `warmup()` uses
`checkAvailability()`; startup/refresh do not call the full v2 import. A matching
already-ready v2 generation may be queried; arbitrary active generations may
not. Settings distinguish resource-available, successful ready lookup, verified
fallback and unavailable errors. Resource-available means a verified manifest,
not proof that every block has synchronized. A partial-resource block query can
still fail explicitly rather than return a false not-found.

The production LingQ personal schema, canonical data, Context/Review and generic
History/coordinator remain unchanged. Chrome comparison/residency measurements
are not Native startup measurements: mixed workloads include binary block
misses, while resident-hit samples require zero new binary reads. The 8 MiB
cap constrained the measured workloads before the 8/16/32 count caps could
separate them. No production LRU capacity is selected or frozen.

The completed real-filesystem 25k bulk matrix rejects both experimental
encodings; no History/pending optimization was integrated. Its completed report
supersedes the earlier `evidence/vocabulary-bulk-disk/REPORT.md` statement that
the benchmark had not yet run. SQLite/OPFS work remains experimental and does
not replace a production storage engine.

## Remaining acceptance blockers and documentation scope

1. Latest checked-in Native verdict is `true-product-red-stop`, with Markdown
   rename failure and mdmove/bothmove/closedmove/openmove/restart/complete-sentence
   cases not executed. The EditorRange repair does not retrospectively turn that
   receipt into PASS. Obtain a new package-bound continuation verdict.
2. Windows actual learning loops and resource-path reload verification remain
   unresolved; historical Chrome results cannot replace them.
3. Native resource-v3 startup/blocking measurement remains absent. Keep resource
   capacity selection provisional and separate private staging from accepted
   integration/deployment.
4. Private candidate final build/gates are owned by root. Root reports a build
   and gates in progress; this audit neither runs nor certifies their outcome.

No new production correctness defect was found beyond the watcher issue already
closed by `0f6942e`. `014_A_GUARDIAN.md` is a baseline-era assessment, not a claim
that its old canonical-rename finding persists. `RESOURCE_V3_WIRING_CANDIDATE.md`
is also a historical staging note: its 25-test/no-build wording predates the
ancestor tests and current candidate build. Neither should be quoted as current
completion evidence. No inspected current document establishes full Semantic
Native PASS; the accurate final state remains **PENDING**. iPad stays
`DEFERRED_BY_SCOPE`.


## Retained RED/GREEN receipt identities

The following outside-Git files were read from
`/Users/jiajia/.codex/worktrees/obreader-0.14/evidence/`. The digests below were
computed during this read-only audit. They identify observed logs, not a new
execution or a signed package-bound Native verdict.

| File | SHA-256 | Observed result |
| --- | --- | --- |
| navigation-red.log | 85c36cb9232f7632f84d2213cb64f8f4e424ef9c75b93f8039987e951944086e | 1 failed; runtime correlation ID absent |
| folder-rename-red.log | 96feab86e1a4e6786f30d9546b61a392f97bdf03163b81f3dfe402fc9d186afc | 1 failed; route did not follow folder move |
| navigation-host-green.log | 53982acbb212a8c46646944044aecd03d80fc4e2fe412c3beee54648f7669a71 | 95 passed |
| navigation-browser.log | 0c1a5fe9c7ed692cde1a2342aff27c9db20247df19317d5c20542f66770a72e7 | 1 passed; Browser only |
| windows-cache-path-red.log | cc17a400250764baceaa89c3e3c0be12f875d9013a763d5031de058192214bca | path assertion failed |
| markdown-source-editor-range-red.log | e5b9ae255d161c9e088bdf277050b279fa895d19a7f06c862da6d47df092f8a9 | exact-source open failed |
| markdown-source-editor-range-green.log | 6cabf5b697d488aba35847700dc0d75c2e01844a9148f264e2331ecf7058783d | 119 passed |
| v3-watcher-root-red.log | 15255bc7b2ee2cbd6c6a81691d6ebf3f78e4201d1df305c79ce2008963ceedc7 | ancestor regression failed |
| v3-watcher-root-green.log | 08dde8a2dfbe72c2d3019deb78c7f7ee7f9369356ba50422a60ace0dde9d3ec5 | 28 passed |
