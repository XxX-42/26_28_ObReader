# Windows Native learning-loop probe — progress and blockers

Date: 2026-10-23

## Baseline

- Repository: `XxX-42/26_28_ObReader`
- Work branch: `codex/014-windows-native`
- Base: `cd6e15743d5065dfe53579d658dde18580c84e9f`
- At inspection, local `HEAD` and `origin/main` both resolved to that base; the worktree was clean.
- The base already contains `MAIN_PUSH_PROGRESS_BLOCKERS_2026-10-23.md`, which records the 0.13.0 candidate's broader progress and release limitations.

## Windows Native probe status

The Obsidian CLI is reachable. Read-only checks of the existing `测试插件` Vault reported:

- `pdf-web-reader` is enabled at version `0.13.0`.
- No PDF Reader tab is currently open.
- The Core plugin list does not include `sync`.

No Native learning-flow test was run in this pass. The existing test Vault contains pre-existing user content; it is not a clean isolated Vault for writing learning items or History. The required fresh, Sync-disabled test Vault and new PDF/Markdown fixtures have not yet been created. No user PDF, sidecar, Vocabulary, Context, Review, or History data was changed.

## Acceptance matrix

| Flow / gate | Status | Evidence or blocker |
|---|---|---|
| Highlight → durable Sidecar → Annotation Sidebar → Add Review → Today → same UUID | `NOT_RUN` | Requires an isolated Vault, fresh fixture, and actual UI flow. |
| LingQ → selected sentence → Context → Add Review → Today → exact Context | `NOT_RUN` | Requires isolated Vault and a verified available dictionary/cache; live ECDICT availability has not been inspected. |
| PDF/Markdown rename and move matrix | `NOT_RUN` | No test fixtures or isolated Vault yet. |
| Existing canonical/History bytes unchanged | `NOT_RUN` | No test write occurred; before/after receipts were not collected. |
| Native app/version identity | `UNRESOLVED` | CLI reports the installed plugin, but the previously observed UI title and CDP-reported Obsidian version differed; confirm the exact runtime before acceptance. |
| Product failure found | `NO` | The Native learning paths have not yet been exercised, so no product conclusion is claimed. |

## Next safe action

Create and verify a new dedicated Obsidian Vault with Sync disabled, install only the verified release bundle, add fresh PDF/Markdown fixtures, record baseline hashes, then run the two flows through visible UI interactions. Preserve failures and report platform/runtime identity with every receipt. Do not use the populated `测试插件` Vault as the write target.

## Change boundary

This report is documentation-only. No production source, PDF.js vendor files, WAL/Sidecar protocol, user PDF, existing sidecar, learning data, or installed plugin files were modified by this probe.
