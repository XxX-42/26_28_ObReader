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
- Offline smoke: PASS, five editors, durable Sidecar save/reopen and bulk-delete non-resurrection.
- Native repaired-bundle run `20261022132045323`: FreeText save, five-tool save/reopen, and trusted Square movement + same-UUID durable second save PASS. The later delete step remains FAIL because the script clicked Underline while Square creation mode was still active. Source SHA-256/XXH64 are unchanged, all 366 protected files (including `_index.json`) hash-unchanged, and ordinary PDF serialization/write attempts are zero. This is not full Native acceptance.
- The delete fixture now returns to NONE, proves the acknowledged Underline's exact geometry/runtime identity is hit and selected, then sends Delete. It keeps the original delete/undo/redo/reopen assertions. The failed run is preserved; the repaired full Native chain remains NOT RUN at this receipt.

## Isolated staging deployment

The repaired P0 bundle was installed with the real `npm run deploy` entry point only into `D:\\Documents\\Obsidian\\测试插件`. Preflight proved no Reader views or instrumentation guard; the plugin was normally disabled before replacement and re-enabled afterward. Existing ancillary plugin settings, logs, asset cache and per-run test evidence were restored from the recoverable deployment backup, because the existing deploy script stages an entire plugin directory, not just its release files. No production Vault deployment occurred.

- Backup: `.deploy-backups/2026-10-22T13-20-01-393Z/pdf-web-reader`.
- Installed runtime version: `0.12.2`, exact guarded test Vault, enabled, zero Readers at postflight.
- Installed `main.js`: `78c842df1ee3806277983fced3dc3e0cf01137960a59d577cf1925a53ac2b563`.
- Manifest: `aca5600f1ec9939e008871a9a7e85230fc2b174b9a764b057c582a41569ba149`.
- Styles: `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea`.

This stage rebuild remains version 0.12.2 until the approved 0.13.0 learning integration is accepted. Git SHA and installed bundle hash distinguish it from the original baseline; it is not a published release.
