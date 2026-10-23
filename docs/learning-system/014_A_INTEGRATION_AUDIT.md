# ObReader 0.14 — Workstream A integration audit

Date: 2026-10-23. Read-only review of the integration worktree at `3214941fe6553f945a97a436a18f6849b5add6fb`, including the root's then-uncommitted facade, bridge, build, test-manifest, and generated bundle wiring. No files in that worktree were changed by this review.

## Findings

### P2 — malformed owner context bypasses the owner route

`plugin/learning/host.cjs` `markdownPathFor()` routes only when both `ownerKind` and `ownerId` are strings. Any other non-null owner context falls through to `{ currentPath: anchor.sourcePath }`, which verifies the stored path directly. A caller that supplies `{ ownerKind: "learning-item" }` therefore gets `status: "verified", exact: true` for a Markdown anchor whose exact slice still exists at its old path, without checking the item's owner binding.

Deterministic reproduction on `3214941`: construct a Markdown anchor for an exact slice at `Notes/A.md`, provide a stub Vault containing that slice, and call `resolveSource(anchor, { ownerKind: "learning-item" })`. Observed result: `verified`, `sourceCurrent: true`, `exact: true`. This violates fail-closed owner routing and can fall back to the canonical stale path when the owner argument is malformed.

Fix by distinguishing an absent context (`null`/`undefined`, permitted for unowned Markdown anchors) from a supplied invalid context (unresolved/error). A supplied owner context must contain a valid nonempty `ownerKind` and `ownerId` and must resolve through MarkdownRouting. Add regression coverage for partial/empty contexts through both `resolveSource` and `openMarkdownSource` or `getSourceContract`.

## Verified boundaries

- The focused Node suites `tests/markdown-routing.test.mjs`, `tests/learning-host.test.mjs`, and `tests/semantic-services.test.mjs` passed 26/26 with no skips. They do not cover malformed owner contexts.
- Existing tests cover two items sharing one note binding, rename chains, path reuse with a distinct binding ID, explicit rebind to another existing binding, conflict handling, partial-commit recovery, no global route-root scan on owner lookup, and byte-for-byte preservation of learning shards and History on rename.
- `openItemSource()` uses its learning-item owner binding and exact range before opening. PDF targets still use the existing route and normal Reader open validation; the focused Host test asserts zero read-only snapshot replay before the normal open. Backlink resolution with an owner context validates both exact Markdown citation and Reader target evidence.
- No frozen core change was found in the reviewed diffs. The contract exposes `VERIFIED`, `RECOVERABLE`, and `TARGET_UNRESOLVED`; it makes no `FROZEN` or Native acceptance claim. Native evidence remains a separate gate.

## ROI and integration note

Owner resolution performs owner-, binding-, and path-specific reads; it does not scan the global route tree on Source open. A Markdown/folder rename does enumerate route facts and loads all learning items when a Learning manifest exists, to migrate legacy sources. Since route facts are retained without garbage collection, rename cost and path-local history reads can grow; measure those costs on a large Vault before treating them as accepted performance.

The new AnnotationSidebar/Backlink facades are constructed in root `main.js`, but current Viewer UI paths still use the established bridge request handlers. `getBacklinkService()` has no production caller in the reviewed tree; `getAnnotationSidebarService()` is reached only by the nested `listSources()` path and tests. Treat them as API scaffolding unless the next integration step wires them into a product path. This is an ROI observation, not a current user-facing failure.

## Recommendation

Fix malformed non-null owner context before integrating the facade. Preserve the current external metadata design and canonical/History invariance; keep Native status separate until Native acceptance exists.
