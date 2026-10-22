# Workflow E: learning domain API and integration contract

This document describes the independent `learning-items-v1` domain module. It does not wire the host UI, alter the Vocabulary bundle, or claim a Native closed-loop acceptance result.

## Runtime ownership

The host creates the service with the existing runtime objects:

```js
const service = createLearningService({
  runtime, // existing runtime.coordinator, runtime.history, runtime.exclusive
  verifySource, // injected SemanticAnchor verifier
  now,
  makeId,
});
```

Learning uses `runtime.coordinator` and `runtime.history`; it does not create another transaction engine. The logical store is `learning-items-v1`, rooted at `00_Archive/21_VocabularyData/learning/items`. The public entry point is `plugin/learning/workspace.cjs`.

## Drafts, source evidence, and saved items

- `createDraft({source,prompt,answer?})` keeps an in-memory draft only; omitted answer defaults to `source.targetText`.
- `updateDraft(draftId,{prompt,answer})` edits only that draft. `cancelDraft(draftId)` makes no canonical write.
- `confirmDraft(draftId,{actionId})` requires nonempty prompt and answer, asks the injected verifier to confirm the same source evidence, then commits the item. A stale or changed source returns `LEARNING_SOURCE_STALE` and leaves the editable draft in memory.
- Repeating a confirmation with the same action ID is idempotent. A source may have multiple item IDs and external IDs.
- Source references are JSON soft provenance. They do not form foreign keys; deleting an Annotation, Reader Anchor, Markdown file, or backlink never deletes an existing learning item.

The service accepts the C semantic factory's PDF anchors, including `sourceRange: null`. Markdown anchors may have null PDF identity fields; their source authority is the vault-relative `sourcePath` and exact `sourceRange` (`startOffset`, `endOffset`, `line`, `text`), where `text` must equal the captured `targetText`. Backlink anchors may retain a range and optional source text, but `displayText` is not upgraded to exact evidence. The injected verifier must verify the current source/target and echo the same anchor; Markdown excerpt edits must become stale. A rename may resolve an old path to the same stable document identity without rewriting the saved evidence during confirmation.

For Markdown move/rename notifications, `renameMarkdownSource(fromPath,toPath,{actionId?})` rewrites only `sourcePath` for `evidenceKind: "markdown"` or `"backlink"` records that equal `fromPath` or lie below that exact folder prefix. It preserves item/external IDs, exact range, and review state. The operation is one ordinary coordinator commit with domain `source` History changes; History undo/redo restores only provenance. The host should check for the learning manifest before lazily creating the service and should pass only the concrete vault rename event, not scan the vault.

## Scheduling, History, and due pages

`listDue({limit?,cursor?})` returns a deterministic page ordered by due UTC timestamp and item ID. `limit` is 1–100. Cursors are opaque and scoped to the current due sort; `rate(itemId,"skip")` only suppresses that item in the current service session and does not write.

`LeitnerScheduler` exposes the pure `schedule(state,rating,nowUTC)`, `isDue(state,atUTC)`, and `describe(state)` interface; legacy `rate()` remains available as the same transition API. It applies UTC Leitner intervals (1/3/7/14/30 days). `rate(itemId,"remember"|"forget",{actionId})` commits `reviewState` plus `lastReviewEvent` in the same regular coordinator transaction. The immutable History domain event contains `actionId`, `rating`, `reviewedAtUTC`, `sequence`, `previousEventId`, and `schedulerVersion`. Undo restores the state and event head together while retaining the original History event; a later rating can branch from the restored head. Review event enumeration happens only during explicit export.

`createTodayReviewAggregator({vocabulary,learning,pageSize?})` aggregates the existing vocabulary provider and this learning provider without creating a second index. Its `openSession()` keeps at most one fetched page buffered per provider, merges by `dueAt`, provider ID, then item ID, and invalidates buffered pages after a rating. Fetches are serialized and generation-guarded; malformed or unbounded provider pages fail closed.

## Assistant provider and export

The provider surface declares `explain`, `translate`, `generateQuestions`, `generateCards`, and `summarize`. The deterministic mock returns draft data only. `createDraftWithProvider` can populate an editable draft; no provider capability confirms or writes a canonical item.

`exportItems("json"|"markdown"|"csv"|"anki-tsv")` is independent from the existing Vocabulary bundle. Each export includes stable `ExternalID`, prompt, answer, target text, and source link/evidence. JSON includes exact source provenance and derives the rating event graph from immutable History, including events on branches not currently active. PDF links use the existing Reader fragment encoder; Markdown/backlink export uses a safe vault-relative path and the captured source line when available. Unsafe URL-like source paths are not emitted as links.

FSRS remains a development-only replay/migration experiment. A future experiment may use `ts-fsrs@5.4.2` in a separate dev dependency/runtime, but production learning modules must not import it and this workflow must not modify shared `node_modules`. Missing historical ratings must not be reconstructed.

## Verification boundary

Focused Node tests use `tests/vocabulary-v2-memory-adapter.mjs` and exercise cancellation, repeated confirmation, multiple items per source, stale evidence, deleted-source retention, restart durability, rating undo/branching, UTC parity with the existing review service, paging/aggregation invalidation, rename/undo, exports, and draft-only provider behavior. The semantic interop test loads the C factory using `OBREADER_SEMANTIC_MODULE` while the branches are isolated; after integration it defaults to `plugin/semantic/semantic-anchor.cjs`.

Passing these memory-adapter/unit tests does not demonstrate a packaged build, host UI integration, Vault Sync, or a Native end-to-end learning journey.
