# Adjacent Markdown rename/move route loss

Baseline: integration `000116a`. Windows Native receipt:
`3d76d0f:docs/learning-system/014_WINDOWS_NATIVE_RESULTS.md` records unchanged
57-character text and the missing second routing fact. That Native run is RED;
this unit repair does not replace its required Native continuation.

## Deterministic mechanism

`LearningHost.renamed()` previously performed asynchronous adapter/source reads
and called `routing.recordRename()` independently for each Vault notification.
The routing layer reads current durable binding heads. Its optimistic conflict
retry only applies when a commit conflicts; no matching moving binding returns
`unchanged` immediately.

The new test holds A→B at its real coordinator commit boundary. While that
commit is held, B→Moved/B sees only the durable A binding, completes unchanged,
and loses the second event. Releasing the first commit leaves `Notes/B.md`,
although the actual file/text are at `Moved/B.md`. This reproduces the observed
missing-second-fact shape without browser timing, changed text, or an assumed
transport failure. It establishes one concrete loss mechanism; it does not
claim the Windows adapter trace uniquely proves this scheduling interleaving.

The baseline was actually rerun with the final regression test: 1 failed,
actual route `Notes/B.md`, expected `Moved/B.md`.

## Minimal repair and bounds

A Host-scoped promise queue now preserves the order of observed Vault rename
notifications across the complete asynchronous handler. A rejected event does
not poison the queue. Existing proof validation, source checks, durable route
facts and coordinator are retained. The queue schedules work; it stores no
source identity or canonical records and is not used as routing authority.
No change to `main.js`, bridge, canonical schemas, transactions or History is
required. Existing main wiring already invokes the same `renamed(from,to)` API.

The regression verifies both events survive, duplicate notifications append no
route facts, and all persisted non-routing fixture bytes remain identical.
A new Host resolves the durable final path after restart without the old queue.
Reusing the historical source path receives a distinct binding; deleting the
current path remains unresolved even when identical quote text exists at the
historical path. The original item's canonical source remains unchanged.

Focused command:

`node --test tests/learning-host.test.mjs tests/learning-draft-modal.test.mjs tests/markdown-routing.test.mjs tests/semantic-services.test.mjs`

Result: 34 passed, 0 failed. No Browser, Native, benchmark, build or full gate
was run. Unit evidence does not establish Windows or macOS Native PASS.

Outside-Git retained logs under
`/Users/jiajia/.codex/worktrees/obreader-0.14/evidence/`:

- `markdown-adjacent-route-red.log`, SHA-256 `355432a1a6a9da1bdb28e51763b5f1b859c743e45390b734a37dd6e88a82c138`.
- `markdown-adjacent-route-green.log`, SHA-256 `5e14c5f1a3fec382b254eba38a711d79b405af4657e3fcf49f98b978e2514586`.

Native route/reload/restart acceptance remains PENDING. Queue completion can be
awaited by callers using the existing returned promise; this change does not
turn Vault's asynchronous event delivery into a cross-process transaction.
