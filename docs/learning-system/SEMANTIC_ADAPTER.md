# SemanticAnchor adapter

`plugin/semantic/semantic-anchor.cjs` is a pure view-model adapter over existing Reader records. It does not persist anchors or create a second index. Its canonical fields are `target`, `documentId`, `docKey`, `sourcePath`, `sourceHash`, `pageIndex`, `pageIdentity`, `targetText`, `targetTextSource`, `evidenceKind`, and `sourceRange`; fields without evidence are `null` (including `sourceRange`). A Markdown `sourceRange` uses `{ startOffset, endOffset, line, text }`. Only `contextId` and `annotationVersion` are appended when those existing records provide them.

Use `fromAnnotation`, `fromReaderAnchor`, `fromContext`, `fromBacklink`, or `fromMarkdown` to build the same shape. Context and Markdown references keep their existing target identity; `fromMarkdown` creates only a temporary `target.kind = "markdown"` view-model ID and never writes the Reader Anchor Store. A backlink retains its existing Reader target and the Markdown source path/range. Its `displayText` is not treated as an exact Markdown slice.

`createSemanticSourceResolver` takes injected `verifyRouting`, `verifyReaderAnchor`, `verifyAnnotation`, `verifyContext`, `verifyBacklink`, and `verifyMarkdown` callbacks. A callback proves only the evidence it owns and returns `{ status: "verified", sourceCurrent: true, pageCurrent: true, anchor }`, where `anchor` is structurally identical to its input. Unverified or changed evidence returns `TARGET_UNRESOLVED`; a current page identity may be returned separately as `pageFallback` with `exact: false`. A recovered quote is display evidence and must never repair or rebind a Reader target.

For a Markdown excerpt, the verifier must check the current source slice at `sourceRange.startOffset..endOffset` exactly. `matchesMarkdownSourceSlice` provides that text comparison; it does not locate a similar phrase or infer a replacement range.

The Reader Sidebar remains closed and does not collect rows on construction. While open it filters the existing effective annotation target list; legacy Highlight text recovery only reads a rendered page text layer and remains page-local. Search and type-filter changes render the collected snapshot without forcing unrendered pages or writing the annotation WAL. `learning-review-draft-request` is a transient Host request containing one document/session/page identity and text snapshot plus `revision`, `confirmedRevision`, `dirty`, and `pending` as negative evidence. Host integration must fail closed unless both revisions are nonnegative safe integers and equal, and both booleans are explicitly `false`; the request is not persistence.

## Root integration evidence

The first real Browser run failed: the reopened Highlight's generic localized
`aria-label` (`高亮编辑器`) overrode its stored quote, making search return zero.
Removed accessibility labels as quote authority; live text comes only from the
existing exact-selection capture map. A second regression exposed the canonical
external row's `editor.text` field being missed during hydration. That exact
UUID-bound field is now retained, including after color-only saves. Unit red
27/29 and 28/29 became 29/29; combined semantic/bridge units pass 32/32.

Browser red receipts are retained under `tests/artifacts/annotation-interaction-`:
`40ace84c9c36-1792676327020-22228`, `40ace84c9c36-1792676410557-29028`,
`9bbc57611742-1792676661312-22096`, and `9bbc57611742-1792676895966-30344`.
The standalone Browser Host mock also omitted its known snapshot/source hash on
reopen, unlike the production Host; corrected the fixture and asserted the hash.
Later exact-navigation smooth scrolling moved the outer iframe, invalidating its
once-cached mouse transform. The test now reads the frame transform per gesture
and computes text points after the tool transition. No assertion or timeout was
relaxed. Those additional failures (`1bd3bde172e5-1792677114886-36568` and
`1bd3bde172e5-1792677268054-56620`) remain recorded.

Green Browser: `annotation-interaction-1bd3bde172e5-1792677358107-14832`,
1/1, normal cleanup. Real Highlight → Sidecar save/reopen → exact stored quote →
Sidebar search/type filter → same UUID navigation → authenticated clean review
draft request passes, alongside the original drawing/selection/Square regressions.
This is a Chromium Viewer plus mock Host test, not yet a Native learning Review
loop. Vendor and storage formats are unchanged. Full gates follow integration.
