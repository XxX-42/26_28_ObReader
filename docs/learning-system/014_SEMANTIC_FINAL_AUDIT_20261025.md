# 0.14 semantic final audit — 2026-10-25

Audited base `f7191b89` in isolated branch `codex/014-semantic-final-audit`.
This audit covers source and deterministic tests. It does not establish Native
acceptance, deployment, restart behavior, or Windows runtime acceptance.

| Requirement | Evidence and result |
| --- | --- |
| SemanticAnchor V1 is a pure projection over existing identity | `semantic-anchor.cjs` factories preserve flat `{kind,id}`, document/hash/page evidence, exact text provenance, optional existing context/revision evidence. `semantic-anchor.test.mjs` and `learning-semantic-interop.test.mjs` pass. No new store/index is introduced. Public descriptor name is `SemanticAnchorContractV1`. |
| Sidebar facade delegates to existing effective Reader state | `services.cjs` requires and forwards list/get/navigate/createReviewDraft without persistence. Host `getAnnotationSidebarService` exposes copied nondeleted hydrated snapshot rows, navigates by UUID, and delegates Highlight draft requests. `plugin-host.test.mjs` checks copy isolation, exact UUID navigation, and hydration revocation. |
| Backlink facade delegates to existing APIs | `services.cjs` forwards resolve/openPdfTarget/openMarkdownSource/listSources. Host calls LearningHost contract/navigation and existing page backlink collection, filters exact target IDs, and rechecks current request identity after async collection. Facade and Host tests pass. |
| Exact resolution fails closed | Resolver requires source/page current evidence and a structurally identical echoed anchor. Backlinks check both Markdown citation and existing Reader target. Host verifies exact slices, annotation revision, existing selection/context identity; failures do not fuzzy-rebind. Identical UUID/quote, deletion, changed slice, wrong echo, closed Reader, stale route and corrupt route regressions pass. |
| Public exact status belongs to the verified anchor | **Gap found and fixed in this branch:** contract projection previously trusted status booleans and could attach UUID A verification to UUID B. It now reuses the resolver evidence identity check before projecting VERIFIED. RED reproduced before the fix; regression additionally checks missing echo, changed source path and key-order-independent structural identity. |
| Explicit page fallback stays separate and non-exact | Resolver supplies fallback only after verified routing; contract projection defaults to TARGET_UNRESOLVED and requires explicit opt-in for RECOVERABLE. Existing fallback assertions pass. |
| Rename/move route facts stay outside canonical Learning | `learning/host.cjs` serializes observed rename events and rechecks captured route identity before contract projection. `markdown-routing.test.mjs` verifies rename chains, path reuse/conflicts, independent-device contributions, corruption, partial-commit recovery and external route facts. Learning Host tests check unchanged canonical/History bytes, retry after route failure, repeated quote exact ranges, missing bindings, and unobserved closed-app move remaining unresolved. Host PDF folder rename test covers open/closed Readers. |
| Frozen core boundaries | Branch edits only semantic helper export, contract guard, one regression, and this report. No PDF.js/vendor, WAL/annotation store core, vocabulary canonical schema, main.js, bridge, build artifacts or deployment changes. |

Validation: 30/30 across semantic-services, semantic-anchor,
learning-semantic-interop and learning-host; 123/123 across plugin-host and
markdown-routing. `git diff --check` passes. Initial Host run could not import
`pdf-lib`; `npm ci --ignore-scripts --no-audit --no-fund` supplied lockfile
dependencies and the subsequent full Host/routing run passed. No lockfile change.

The isolated projection regression is deterministic API evidence, not evidence
that the normal LearningHost path previously mixed anchors. Its existing normal
path resolves the same input anchor; this change closes the public projection
boundary for other callers. No additional production correctness gap was
established in the audited scope. Full current-package Native rename/move,
restart, source navigation and complete-sentence acceptance remain root-owned
validation; historical reports alone are not certification of this branch.
