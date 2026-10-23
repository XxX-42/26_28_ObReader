# Preserve ephemeral PDF link targets

Native macOS on `d4c6f29` exposed the editing-view link path. A real Cmd-click
on the existing wikilink invoked the existing WorkspaceLeaf routing wrapper as:

```js
setViewState(
  { type: "pdf", state: { file: currentPdfPath }, active: true },
  { subpath: "#page=1&docKey=…&obdoc=…&obreader=page.ref%3A2R" }
)
```

The fragment was in the second, ephemeral argument. The wrapper parsed only
the persistent state, so the new Reader opened without a target. No subsequent
`Reader.setEphemeralState` call carried the fragment. Passive wrappers delegated
with the original receiver/arguments/return value and were restored afterward.
The authoritative trace is `editor-route-passive.json` in Native evidence commit
`6b00693`, branch `codex/014-native-final-resume`.

The correction changes only the existing PDF routing wrapper: parse an explicit
ephemeral target first, otherwise retain the existing state fragment path; apply
this to both native PDF and already-registered Reader view states. All other
state fields and the original ephemeral argument remain intact. Navigation
continues through the existing pending target, identity verification and
authenticated bridge. No CodeMirror selector, new listener, channel, store or
input policy is introduced.

Eight real WorkspaceLeaf wrapper tests produced six RED and two GREEN against
the baseline, then eight GREEN with the correction. They cover page, selection
and annotation identities, the actual native argument shape, current Reader
navigation, ephemeral precedence, ordinary `#page=` fallback and non-PDF
pass-through. The complete focused Host/LearningHost/bridge/controller run is
recorded separately. Native re-verification is still required before this closes
the stronger route matrix gate.

The failed native ReadingView rendering attempt and all harness failures remain
retained. An empty Obsidian Markdown preview is not counted as a passing link
test or silently classified as this routing defect. During the controlled
diagnosis, the default data trees (122 files), canonical learning data (19 files)
and source PDF retained their original per-file hashes.
