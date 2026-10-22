# P0: a selected Sidecar Square becomes unreachable

Native baseline run `20261022130930611` reached five-tool save/reopen. A trusted NONE-mode click hit and selected the original Square UUID, but the resulting Square creation-priority layer intercepted the next pointer gesture. The original editor lacked `explicitlyEditing`. This is a user-interaction defect, not an 80 ms performance regression.

The existing browser test manually dispatched `editId/mustEnterInEditMode` after its first click, so it tested the native toolbar but bypassed this broken user boundary. The added assertion runs before that dispatch and requires real hit testing and a trusted drag, unchanged editor identity/count, and changed serialized geometry.

## Red evidence

- `node --test tests/annotation-interaction-regression.test.mjs`: 0/1, assertion `A genuinely selected Square must remain pointer-hittable without a test-only editId override`, actual false.
- Preserved browser receipt: `tests/artifacts/annotation-interaction-a8b8759441dc-1792674927754-4908.partial.json` plus failure screenshot and cleanup report.
- Bridge unit regression: 27 pass / 1 fail; the native toolbar call lacks `mustEnterInEditMode`.

## Minimal repair

The existing session-scoped editor-manager observer wraps `updateToolbar`. Only a non-read-only `NONE -> Square` selection carrying an existing `editId` requests PDF.js's own explicit editing path. Ordinary tool activation, new creation, already-active creation mode, FreeText/Ink modes and read-only mode retain their original arguments. Caller options are not mutated; the existing observer cleanup restores the original method.

No PDF.js vendor, InputRouter, WAL/schema, source identity or annotation serialization changes.

## Green evidence

- Bridge unit suite: 28/28, zero fail/skip/cancelled.
- `npm run build`: three files, 406 embedded assets, 402 frozen vendor entries verified.
- Real-pointer browser suite: 1/1, including the newly exercised native drag and all existing creation-priority/toolbar assertions. Cleanup receipt: `tests/artifacts/annotation-interaction-8fe3e438473c-1792675014749-38632.cleanup.json`.
- Packaging: 4/4, zero fail/skip/cancelled.
- Native with the repaired installed bundle: NOT RUN at the time of this receipt. Do not substitute browser evidence for Native acceptance.

This stage rebuild remains version 0.12.2 until the approved 0.13.0 learning integration is accepted. Git SHA and installed bundle hash distinguish it from the original baseline; it is not a published release.
