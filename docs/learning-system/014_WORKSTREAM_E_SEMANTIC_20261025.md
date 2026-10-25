# Workstream E — SemanticAnchor, Sidebar and Backlink contract audit

Date: 2026-10-25
Branch: `codex/014-ws-e-semantic`
Base: `197cd7d653967eb0a2d04af3c91470163949e680` (`origin/main` at start)

## Result

The source contract audit passes with one narrow Host correction. A backlink
could previously resolve after its captured Markdown slice and Reader target
syntax matched even when no Reader-route evidence adapter was available. When
the synchronous adapter was present, the Host also accepted any truthy result
without requiring its exact offset and text echo. The Host now fails closed if
both route adapters are absent and requires either adapter to echo the captured
`startOffset`, `endOffset`, and source text. This closes the route and source
verification boundary without changing how production Reader routes are
resolved.

## Contract audit

| Contract | Result | Evidence |
| --- | --- | --- |
| SemanticAnchor is a pure view over existing identities | PASS | Existing factories preserve flat `target: { kind, id }`, existing document/hash/page evidence, exact text provenance, and optional existing context/revision evidence. Markdown's generated ID remains a temporary view-model ID. No anchor store or index is added. |
| SemanticAnchorContractV1 projection | PASS | External descriptor retains flat target identity and request-scoped owner metadata. `VERIFIED` requires the verifier's structurally identical anchor echo and current exact evidence. Explicit page fallback remains `RECOVERABLE` with `exact: false`; default remains `TARGET_UNRESOLVED`. |
| Sidebar facade | PASS | The facade delegates `list/get/navigate/createReviewDraft` without local state. Host reads copied, nondeleted hydrated effective rows, gates use on current hydration, navigates by UUID through the existing Reader target path, and sends only a transient review-draft request. Draft confirmation requires matching safe revisions, `dirty: false`, and `pending: false`. |
| Backlink facade and route evidence | PASS AFTER FIX | The facade delegates `resolve/openPdfTarget/openMarkdownSource/listSources`. Host binds results to current Reader identity and exact target IDs. Backlink verification requires the exact Markdown source slice, the existing Reader-route evidence adapter, and an exact offset/end-offset/source-text echo; absence or mismatch fails closed. |
| No fuzzy rebind | PASS | Exact Markdown offsets/text are checked in place. The route resolver may follow an observed stable route, but cannot substitute a similar quote, another UUID, page, document, or source slice. Existing duplicate-quote, deletion, stale route, wrong echo, source/hash/page change, and path reuse tests remain active. |
| Existing persistence and state boundaries | PASS | This workstream adds no database, index, WAL change, canonical Learning change, Reader bridge change, or `main.js` change. The only production edit is in the Learning Host's verification boundary. |

## Validation

Focused command:

```text
node --test tests/semantic-services.test.mjs tests/semantic-anchor.test.mjs tests/learning-semantic-interop.test.mjs tests/learning-host.test.mjs tests/markdown-routing.test.mjs tests/plugin-host.test.mjs
```

Result: **158 passed, 0 failed, 0 skipped**. `git diff --check` passes. The
initial run could not import `pdf-lib` because dependencies were absent in the
isolated worktree; `npm ci --ignore-scripts --no-audit --no-fund` installed the
locked dependencies. The final test run passed and the lockfile is unchanged.

The deterministic Host regression covers both the missing route-evidence
adapter and a synchronous adapter that returns the wrong offset. Existing Host
and Plugin Host tests exercise exact route evidence, current request identity,
same-UUID navigation, clean draft confirmation, stale/deleted targets, and
source changes.

## Acceptance boundary and remaining gates

This is source and deterministic unit evidence, not Native acceptance. The
package-bound initial-backlink-query correlation re-verification, actual Native
process restart, and the complete required rename/move/restart × five-direction
matrix remain pending the root-owned Native continuation. Therefore this
workstream certifies **source/API contract pass; Native sealing pending**. It
does not label the overall 0.14 Semantic contract FROZEN.

Machine-readable gate receipt: `evidence/014-semantic/workstream-e-gate-20261025.json`.
