# Context selection regression

Current 0.13 candidate, not a new Context protocol.

Real Browser receipt `backlink-failure-1792680754119-15900` retains noncollapsed
`Dynamic languages such as JavaScript are more difﬁcult to com-` while the LingQ
pill and Save Context button have disappeared. The shared Bridge click owner
unconditionally dismissed the pill before inspecting native text selection.

Red check before product changes:
`node --test --test-name-pattern="Context sentence selection|current-page Context selection" tests/lingq-read-mode-transition.test.mjs tests/vocabulary-controller.test.mjs`
executed 2 tests, 0 pass / 2 fail / 0 cancelled / 0 skipped. The actual Bridge
called `dismiss-pill` and `backlink` for a retained Context selection. The
controller had no narrowly scoped preservation predicate.

Repair: only an existing current-session pill's visible page, native single
noncollapsed TextLayer range and read mode may retain that pill on the drag's
final click. Cross-page/old-session/native-button/right-button/pan/tool cases
do not qualify. No listener, selection mutation, persistent state, capture or
save is added; the existing explicit Host capture/preview/confirm remains the
sole Context save path. Browser end-to-end verification remains separate.

Post-repair targeted run executed 55 tests, 55 pass / 0 fail / 0 cancelled /
0 skipped across LingQ read-mode transitions, VocabularyController, vocabulary
tap priority, backlink interaction and InputRouter boundary tests. This does
not substitute for the full Browser or Native candidate gates.
