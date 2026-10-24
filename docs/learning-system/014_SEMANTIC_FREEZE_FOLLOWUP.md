# 0.14 semantic API follow-up — Native acceptance PENDING

Audited integration `376e36d145973d7133e4f2f6cf9ac265cfeb7241` in the
isolated `codex/014-semantic-freeze-followup` worktree on 2026-10-24.
Scope follows `014_BASELINE.md`, `014_FINAL_INTEGRATION_AUDIT.md`, and
`014_OBJECTIVE_COMPLETION_DRAFT.md`. This is deterministic API evidence;
it does not freeze the Native contract or certify a release package.

## API and route evidence

| Boundary | Current behavior | Deterministic coverage |
| --- | --- | --- |
| `SemanticAnchorContractV1` | Separate view projection; flat `{ kind, id }`; `VERIFIED` requires exact/current source/page flags and matching normalized anchor evidence. A copied anchor or the resolver's alternate `source` echo is accepted. | `semantic-services.test.mjs`, `semantic-anchor.test.mjs`, `learning-semantic-interop.test.mjs` |
| Sidebar API | `list({ pageIndex }?)`, `get(uuid)`, `navigate(uuid)`, `createReviewDraft(uuid)` delegate to the existing effective Reader rows/target path. Host gates current hydration/session state and returns copied rows. | Facade delegation tests plus Sidebar/Backlink Host API tests in `plugin-host.test.mjs` |
| Backlink API | `resolve(anchor, ownerContext)`, `openPdfTarget(anchor, ownerContext)`, `openMarkdownSource(anchor, ownerContext)`, `listSources(anchor)` delegate to existing exact source/Reader paths. Owner context stays request-scoped. | Facade tests, `learning-host.test.mjs`, `plugin-host.test.mjs` |
| Source resolver | Verifier echoes must match their input; backlink citation and Reader target are independently checked. An identical quote cannot substitute another UUID. Fallback stays separate and non-exact. | `semantic-anchor.test.mjs`, `semantic-services.test.mjs` |
| Markdown routes | External owner/binding/path facts preserve canonical source fields; observed rename, path reuse, concurrent aliases, corruption, missing parents and partial commit recovery are covered. Unobserved moves require explicit binding. | `markdown-routing.test.mjs`, `learning-host.test.mjs` |

## Closed deterministic gap

Before this follow-up, `createSemanticAnchorContractV1` used only resolution
flags. A verified result with missing echo evidence or another UUID, source,
page, range or quote could label the requested descriptor `VERIFIED`.
The new isolated regression failed on the original implementation (4 pass,
1 fail: actual `VERIFIED`, expected `TARGET_UNRESOLVED`). The projection now
normalizes and compares the evidence before accepting a verified result.
Mismatch fails closed and does not borrow the other result's page fallback.
`projectResolutionStatus` remains a flag projector; callers that need an
anchor-bound descriptor use `createSemanticAnchorContractV1`.

No changes were made to shared Host wiring, Viewer bridge, annotation WAL,
canonical schemas, or a production Vault. No new authoritative store or index
was introduced.

## Remaining Native requirements

Acceptance remains **PENDING**. Obtain new package-bound Native evidence for
the complete route matrix: PDF and Markdown renames/moves, both moved, closed
and open Reader cases, restart, and complete-sentence exact-source navigation.
Verify Sidebar → review draft → saved Learning → Source and Backlink → PDF /
Markdown source in the actual application, including deletion, stale source,
same-quote UUID substitution and explicit non-exact fallback behavior.
Windows learning-loop/resource-path reload acceptance remains separate and
pending; Chromium/mock Host or isolated unit results do not replace it.
iPad remains `DEFERRED_BY_SCOPE`.

## Follow-up verification

`node --test tests/semantic-services.test.mjs tests/semantic-anchor.test.mjs
 tests/learning-semantic-interop.test.mjs tests/markdown-routing.test.mjs
 tests/plugin-host.test.mjs tests/learning-host.test.mjs` passed **150/150**.
After extending the mismatch matrix with path/docKey/page/context/revision
cases, `semantic-services.test.mjs` passed **5/5** again. The first Host attempt
was blocked by absent local `pdf-lib`; `npm ci --ignore-scripts --no-audit
--no-fund` installed this worktree's lockfile dependencies before the green run.
No Native UI, build, full release gates, deployment, or production Vault
operation was performed by this follow-up.
