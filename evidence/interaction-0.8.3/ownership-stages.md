# Input ownership integration audit

Scope: the ownership extraction as committed through `616bfed` on top of `44f6dd5` (0.8.2). This records the source handoff before subsequent uncommitted bulk-delete/release work. No storage, WAL, PDF-annotation host, sync, merge, or vendor code was changed by this extraction.

## Migrated behavior

| Previous bridge responsibility | New owner | Notes |
| --- | --- | --- |
| Top-level pointer/mouse/click/wheel/keyboard listener subscriptions; active/manual/pen pointer maps; pointer capture/release; teardown | `InputRouter` | iOS-only legacy `touchstart`/`touchmove` are registered here with capture and `passive:false`; desktop does not subscribe to them. `InteractionIntent` values and event controls are the only bridge boundary. |
| Event target classification and iOS/desktop policy selection | `InteractionIntent`, `InteractionMode`, `DesktopInputPolicy`, `IOSInputPolicy` | Intents contain page/role, editor operation, context/activation flags, trust, coordinates, and a stylus fact extracted by indexed `TouchList.item(i)`/index access. No DOM target or native event is retained. |
| Finger text-selection suppression; touch compatibility cancellation for an active Pencil/editor or palm contact; page-pan click/double-click suppression | `IOSInputPolicy` | Ordinary finger and read-mode Pencil contacts are not canceled. Active-tool stylus and contacts arriving during an active Pencil editor gesture retain the legacy cancellation path. Native activation targets (`a[href]`, `button`, `[role=button]`, `[role=link]`) are exempt from click and double-click suppression. |
| Direct-touch contact bookkeeping, Pencil arbitration, iOS manual pointer lifecycle and the dormant manual-pan fallback | `IOSDirectManipulationController` | Page touch uses native contact bookkeeping only: stop propagation to PDF.js, with no `preventDefault`, pointer capture, custom pan, or momentum. Read-mode Pencil returns to WebKit. Manual helper methods remain in the module but are not reachable from those two routes. |
| Scroll sampling, pan math, velocity estimation, and momentum scheduling | `ViewportController` | Kept as the owner of legacy/manual helper physics; native WebKit scrolling does not call it. |
| Text-layer caret resolution, Pencil selection snapshots/range extension/cleanup, pending selection ownership | `TextSelectionController` | The last extraction moved pending Pencil selection ownership from bridge state into this controller. |
| PDF.js pointer-kind/native-operation classification, exact-session highlight fallback, drawing-session cancel, transform cancellation request | `AnnotationController` | It does not own storage or save behavior. |

## Bridge responsibilities that remain

`obsidian-bridge.js` remains the adapter and viewer/session coordinator. It constructs the controllers, supplies viewer/PDF.js/session callbacks, resolves hit targets through `TextSelectionController`, constructs the pointer session records consumed by PDF.js and the annotation controller, routes the routed intent to its compatibility callback, and releases/cleans tracked state after PDF.js has handled pointer events.

The bridge still owns `finishTrackedPointer` and `scheduleAnnotationTransformCancel`: they dispatch or defer PDF.js cleanup, record diagnostics, resolve input-boundary waiters, and schedule annotation autosave/Ink commit work. It also owns `hasOtherActivePenPointer`, `isPointerSessionCurrent`, session/document checks, toolbar dismissal, keyboard/blur and close handling, and the host save/close lifecycle. These are deliberate app/viewer integration points, not part of the input-policy modules.

The bridge still has small adapter functions for pointer down/move/end/out/lost-capture, select/context-menu, click/double-click, wheel, visibility, blur, and keydown. `installPointerTrackingListeners` wires `InputRouter`; it should not install listeners directly. Native touch arbitration now runs through the iOS policy before the adapter callback.

## Verification by stage

Commands below ran in `/Users/jiajia/.codex/worktrees/wal-sidecar-v3-1/26_7_PdfRD_OB`.

| Checkpoint | Command / evidence | Result |
| --- | --- | --- |
| Intermediate extraction after stage 6 | Recorded checkpoint; exact command was not retained in the session transcript. | 32/33 passed. The single known boundary failure was `bridge delegates top-level listener installation to InputRouter`, because the iOS `touchstart`/`touchmove` listeners were still directly registered by the bridge. |
| After stage 8 | `node --test tests/ios-direct-manipulation-controller.test.mjs tests/ios-input-policy.test.mjs tests/annotation-controller.test.mjs tests/input-architecture-boundary.test.mjs` | 20/21 passed. Same expected listener-boundary failure; all direct-manipulation, policy, and annotation unit tests passed. |
| After value-only intent integration (stage 10) | `node --test tests/input-architecture-boundary.test.mjs tests/ios-direct-manipulation-controller.test.mjs tests/ios-input-policy.test.mjs tests/annotation-controller.test.mjs tests/text-selection-controller.test.mjs` | 27/27 passed. |
| Trusted browser native-touch check, after stage 10 | Parent-provided `evidence/interaction-0.8.3/native-finger-stage10.log` (test file: `tests/native-finger-ownership.test.mjs`; shell invocation was not included in that log). | 1/1 passed. Seven trusted touch pointers; zero trusted touch `preventDefault` calls and zero captures; read-mode/Ink scroll deltas 140/150 px. The synthetic stylus guard left read-mode Pencil uncanceled and canceled active-tool stylus. |
| After stage 11 selection-session ownership | `node --test tests/input-architecture-boundary.test.mjs tests/ios-direct-manipulation-controller.test.mjs tests/ios-input-policy.test.mjs tests/annotation-controller.test.mjs tests/text-selection-controller.test.mjs tests/selection-pointer-capture.test.mjs` | 29/29 passed. |

The earlier listener-boundary failures are retained in this record rather than counted as final failures: phase 9 moved compatibility listener ownership into `InputRouter`, and both later focused runs passed the boundary test.

## Remaining coverage gaps

- The native browser log reports `editors:0`; it exercises trusted scrolling over the active Ink annotation layer and verifies no editor appears, but it does not first create a real Ink editor/canvas and then scroll over that existing editor surface. A follow-up browser assertion should create one actual Pencil/mouse Ink editor, confirm its live hit target, then verify finger scrolling leaves its editor/storage state unchanged.
- Pencil active-tool cancellation is covered through policy tests and a synthetic stylus `TouchEvent`; the browser test does not simulate physical Apple Pencil input. Real iPad/WKWebView acceptance remains required for native Pencil drawing, palm arbitration, Pencil read scrolling, and momentum.
- The recorded focused commands do not include the full desktop mouse/drawing regression suite or the legacy iPad pointer-policy monolith. Run those separately and preserve its active-Pencil assertions while treating the old manual finger/read-Pencil inertia assertions as superseded by native WebKit ownership.
- Native anchor activation exemption is tested at the value/policy layer. A browser-level trusted link tap/double-click check would provide additional coverage for native navigation inside PDF pages.
