# ObReader 0.14 — Workstream A architecture baseline

Date: 2026-10-23. Read-only baseline audit; no production modules, tests, build output, or fixtures were changed.

## Agent and baseline

- **AGENT:** Architecture Guardian
- **WORKSTREAM:** A — baseline and independent architecture audit
- **BASE_SHA:** `cd6e15743d5065dfe53579d658dde18580c84e9f`
- **BRANCH:** `codex/014-a-guardian`
- **BASE_STATE:** clean checkout at the requested SHA. The separate macOS worktree remains at `c044452e27e480612186aaabaf17a8bac760a332` with its four pre-existing dirty overlay files (`dist/pdf-web-reader/main.js`, two browser test files, and `viewer-adapter/obsidian-bridge.js`); this audit did not touch it.

## PLAN_A / PLAN_B

- **PLAN_A — selected:** preserve the latest baseline and existing architecture. Keep the semantic anchor contract as `target: { kind, id }`, with routing/owner metadata in an external descriptor. Keep owner-binding as an independent, noncanonical route/alias layer. Do not add a database.
- **PLAN_B — conditional only:** change a frozen core component only when a deterministic production-correctness RED demonstrates that the frozen implementation is wrong. A display-only `legacyQuadPoints` repair could qualify if that evidence exists; changing the navigation counter or broad navigation flow is outside this exception.

The approved rename lock is precise: Markdown rename must leave `ReviewHistory` and canonical learning-item bytes unchanged. The rename response belongs in independent owner-binding routing metadata; target identity and review state stay intact.

## Results and reusable architecture

The baseline already has reusable pieces for an additive owner-binding implementation:

- `plugin/semantic/semantic-anchor.cjs` builds view models over existing annotations, Reader Anchors, Context, backlinks, and Markdown excerpts. It keeps identity in `target: { kind, id }`, checks exact Markdown slices, and does not create an anchor store.
- `plugin/learning/host.cjs` is a lazy source-verification and navigation facade. It resolves exact Reader targets through existing document routes, validates Markdown range text, and opens sources through the existing host.
- `plugin/reader-anchor-store.cjs`, `plugin/reader-backlink-index.cjs`, and the existing Context service provide the current selection identity, backlink index, and Context routing. Reuse these owners; do not add a second index.
- Learning items already use the Vocabulary runtime's generic transaction coordinator, sharded store, and History integration. Review scheduling/history remain owned by the existing review service and History format.

There is a concrete rename conflict in the current source. The Markdown vault rename listener in `plugin/main.js` calls `LearningHost.renamed`; that calls `learning.service.renameMarkdownSource`, which rewrites `source.sourcePath`, prepares canonical shard writes, and commits a `learning-source-rename` History batch. This current path changes both canonical item bytes and History on rename, contrary to the approved 0.14 lock. The resolver also currently opens and verifies Markdown from the stored `sourcePath` directly. Root integration should route rename aliases through separate owner-binding metadata and must not route them through `LearningHost.renamed`/`renameMarkdownSource` for this behavior.

## Frozen contracts and integrity

The audit treats these as frozen: immutable PDF bytes; WAL v3.2; sidecar and recovery; deletion guards and first-paint masking; InputRouter; PDF.js vendor; Vocabulary v2 identity/canonical format; Context canonical data; `ReviewHistory`; and the generic transaction coordinator/History contract.

The checked-in `docs/vocabulary-v2/frozen-subsystems.sha256.json` has 441 baseline/reviewed file hashes. A read-only recomputation using the reviewed override entries found **441/441 matches, zero mismatches** at `BASE_SHA`. This preserves the documented frozen boundary; it is not a product test or proof of runtime behavior.

## CORE TESTS / prior receipts

- **Fresh tests in this audit:** none run. No build, browser, race, offline, Native, or benchmark command was started.
- **PASS (previously recorded at the 0.13 candidate):** build; Browser 28/28; Race 80/80; Offline; SemanticAnchor/target-text 33/33; learning host/domain/History/review/source/export 43/43. These are cited from `MAIN_PUSH_PROGRESS_BLOCKERS_2026-10-23.md`, not rerun on this workstream.
- **FAIL (previously recorded):** the exact `npm test` gate is not green on the Windows host because the strict Fast gate treats five existing platform-specific skips as a policy failure; the separate Browser gate passed. No gate policy should be relaxed.
- **SKIP:** N/A for this audit because no test suite was invoked. The five skips above are prior Windows-run evidence, not skips generated here.
- **NOT_RUN / NOT_VERIFIED:** macOS Native; physical iPad/WKWebView and Apple Pencil; real multi-client Sync; Native learning-source return; dedicated Native rename/move/first-paint gates.

## Benchmark and release blockers

The latest candidate records keep input long-tail acceptance open: simulated runs do not establish physical-device behavior, and the profiled 169–188 ms observations have unresolved profiler/timestamp contamination. Resource-v2 cold-start work is incomplete (8/20 trials passed, 3 timed out, 1 interrupted, 8 not run); no optimization recommendation follows. The 25k import figure is an in-memory adapter measurement, not Vault I/O. These remain explicit blockers or evidence gaps in the existing candidate report.

## Risks and recommendation

The primary architecture risk is that the live Markdown rename hook still mutates the canonical learning record and adds History. Use an independent owner-binding alias descriptor to map stable source ownership to the current path, then let exact source verification validate the unchanged captured range and text. Keep semantic `target: { kind, id }`, `ReviewHistory`, canonical item bytes, and transaction formats unchanged. Add no database. Root owns `plugin/main.js` and bridge integration.

**RECOMMENDATION:** proceed with PLAN_A. No frozen-core exception is supported by this read-only audit. Revisit PLAN_B only with a deterministic production-correctness RED on a frozen component.

## Commit and push

This report is the only intended file change on `codex/014-a-guardian`. The report commit SHA and push result are supplied in the workstream handoff.
