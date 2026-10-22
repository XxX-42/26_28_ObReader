# P0 Native harness and baseline evidence

Date: 2026-10-22

Scope: Windows Native acceptance harness for the isolated Obsidian test Vault. The installed B runtime was PDF Web Reader 0.12.2. No production Vault, plugin bundle, PDF, or sidecar was deployed or modified by this work.

## Outcome

The latest fresh `five-tools` run is a preserved failure at the saved-Square interaction precondition. It is not a successful five-tools acceptance run and must not be reported as one. Creation, sidecar persistence, independent WAL replay, close, reopen, and rehydration of all five annotation types completed before the failure. The run did not dispatch the saved-Square drag and therefore did not test the subsequent delete/undo/redo/final-reopen/export assertions.

The recorded interaction is a product P0, not merely a missed readiness wait: the mode-NONE wait observed the original Square hit-testable, then an ordinary click selected that same editor UUID. After the click, the runtime returned to mode 5 with `creationPriority`, `explicitlyEditing=false`, and the center hit resolving to the annotation layer rather than the selected editor. The native drag could not proceed through the normal pointer path. Root has separately confirmed that an existing Browser test bypasses this boundary by dispatching an internal edit event; Browser reproduction and the candidate fix are owned by the root task. No candidate build was installed or tested here.

No extra Native retries were performed after this failure. Standalone FreeText and Underline gates, CPU profile, offline rename/move, and a dedicated first-paint latency gate are `NOT_RUN`. The visible FreeText screenshots are visual evidence only, not a dedicated first-paint timing result. This work used Windows Obsidian/Chromium input; it is not physical iPad evidence. macOS, iPad hardware, and real Sync transport are `NOT_RUN`.

## Preserved Native runs

All six result JSON files are under `tests/artifacts/`. Each run used a unique fixture folder and immutable source copy; failures were retained rather than replaced with a later green run.

| Run | Original failing assertion / observed state | Classification and disposition |
| --- | --- | --- |
| `20261022122100480` | `Viewer source confirmed and rendered`; state had `ready=true`, `mode=-1`, no editors, toolbar not ready, and no PDF.js page in rendered state. No matching runtime messages or adapter I/O were captured. | Load/ready precondition failure; evidence is insufficient to attribute to candidate product behavior. Preserved as unresolved setup/runtime failure. No timeout increase or skip. |
| `20261022122659431` | Same source/render assertion; page 1 reached PDF.js rendered state, but the snapshot was schema v1 with `syncPending=true`, no annotations, and the harness observed only an incomplete view of the sidecar namespace. | `TEST_INFRA_FAILURE`: Native virtual-adapter list results were still expressed in the isolated storage namespace instead of being mapped back into the virtual DataAdapter namespace. Added reverse mapping and unit coverage; no product change. |
| `20261022124500395` | `checkpoint freetext-created: null`, despite a `saved` acknowledgement at Viewer revision 6 and a FreeText snapshot. | `STALE_0_7_ORACLE`: the helper only looked for legacy `checkpoints/<docKey>.json`; protocol v3.2 durability is device JSONL plus its derived snapshot. Independent read-only replay verified UUID `fa5b5f2e-dc30-485c-857e-80c24a519df6`, exact visible text and PDF rectangle, complete WAL and matching snapshot. Updated the test evidence reader; retained the original failure. |
| `20261022125256961` | `saved Square moved`; result contained a second Square while the original saved Square geometry stayed unchanged. | `TEST_PRECONDITION_FAILURE`: the test changed mode and clicked before it had verified mode NONE and a hit on the existing UUID. Root's source review showed this path can leave the editor layer in creation priority. Added explicit mode-NONE/no-priority/hit-original checks before the click. This run remains failed; it is not a product pass. |
| `20261022130214201` | Runtime callback threw `ReferenceError: maintenanceOffset is not defined`. Failure finalization then saw `durableWal.status` as `undefined` because the Node-side WAL evidence Promise had not been awaited. | `TEST_INFRA_FAILURE`: serialized callback depended on a Node closure and orchestration missed an `await`. Extracted self-contained callbacks with explicit arguments and Node-side close orchestration; added VM contract tests. The original failure and retained-guard state remain in the artifact. After independent evidence review, the exact isolated Reader was closed and its wrappers safely restored before the next approved run. |
| `20261022130930611` | `existing Square selected for native drag`; mode-NONE precondition passed and center hit the existing editor. The ordinary click selected the same UUID, but yielded `mode=5`, `explicitlyEditing=false`, `creationPriority`, and a center hit on the annotation layer (`hitEditor=false`). | `BASELINE_PRODUCT_P0`: the natural pointer route selects the existing Square but does not enter explicit editing, leaving its next pointer gesture unavailable. Failure preserved at the first red assertion; no drag, delete, undo, redo, or final reopen was attempted. Root owns the candidate repair and Browser red/green. |

The original Square UUID in the latest run was `6626e9aa-a863-489f-9765-4c64af5d48e0`. The test captured the same editor UUID at mode NONE (`creationPriority=false`, `pointer-events:auto`, hit target was the editor). After the click, the same UUID was selected by the manager, but its class/state and hit test no longer allowed ordinary drag input. The failure screenshot is `tests/artifacts/sidecar-native-20261022130930611-failure.png`.

## Latest run evidence and safety

- Run: `tests/artifacts/0.7-sidecar-native-acceptance-20261022130930611.json`.
- Vault identity: `D:\Documents\Obsidian\测试插件`, Vault name `测试插件`, config directory `.obsidian`; runtime plugin `0.12.2`; window visible; zero pre-existing Reader views.
- Test Vault Sync was read-only checked immediately before and after the run: internal Sync plugin enabled, `pause=true`, `syncing=false`, `syncStatus=Uninitialized`. Sync remained paused. This establishes test isolation, not Sync transport success.
- The installed triplet was unchanged across the run: `main.js` SHA-256 `ce500e4bc23d3f8e1a55a36d7a48aebedc7849c91ca7dbc2425ac69db468307e` (8,905,041 bytes); `manifest.json` SHA-256 `aca5600f1ec9939e008871a9a7e85230fc2b174b9a764b057c582a41569ba149` (261 bytes); `styles.css` SHA-256 `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` (8,058 bytes).
- Fixture source: `PDF迁移测试/sidecar-native-0.12.2-20261022130930611/immutable-source.pdf`; SHA-256 `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`; xxh64 `xxh64-v1:ffbe0d4d212547e5`; 1,016,315 bytes. Before/after hashes matched.
- Five tool types were created, acknowledged, closed, reopened, and rehydrated with the same UUIDs before the Square interaction failed. The post-failure independent v3.2 replay contained 15 WAL rows / 8 unique operations, all references and JSONL complete, no missing archives, 5 live annotations, 0 tombstones, watermark total 8; the derived snapshot matched the replay. Viewer revision is reported separately from the WAL watermark.
- Recorded `sourceWriteAttempts=0`, `pdfWriteAttempts=0`, `pdfSerializations`/`PDFDocumentProxy.saveDocument` calls `=0`, and `blockedExistingWrites=0`. No PDF export was reached. All protected-file entries included in the run's final list were unchanged: 365/365.
- Audit limitation: this run's final protected-file comparison accidentally excluded `00_Archive/20_PDFData/_index.json`; the original hash was not persisted, so that file is `NOT_VERIFIED` for this run. A read-only postflight found the current file at 39,394 bytes, SHA-256 `AE6484CE948ABC70D22B797686A0528BA58D6E5572E870DE164448DC7A5AD799`, mtime `2026-10-15T07:53:05.8496078Z`; this is not a before/after hash comparison. The test-only harness now includes `_index.json` in future protected-file comparisons. Do not retroactively label this run 366/366.
- Both the normal and failure-path controlled closes returned clean acknowledgement (`unconfirmed=false`), zero fixture Reader views, snapshot materialization, and complete isolated WAL replay. Postflight confirmed `readerViews=[]`, no `globalThis.__sidecarNative07` guard, and unchanged paused Sync state. The unique source fixture remains in the test Vault as run evidence; its hash is unchanged.

The latest in-Vault diagnostic trace is `.obsidian/plugins/pdf-web-reader/.native-test-output/22905a2f7950ca5733fe5b1fe76b8bdb.json`. Its guard-cleanup receipt has `guardsRetained=false`. No Native/browser lease remains held.

## Test-only changes and verification

The worktree changes are confined to tests and this report. They add serialized native-sidecar adapter isolation (including list-result reverse mapping and explicit PDF-write rejection), an independent v3.2 WAL/snapshot evidence reader, controlled-close orchestration with serialization/await VM tests, and browser/Native timing and pointer diagnostics. No `plugin/main.js`, bridge runtime, PDF.js vendor, or installed plugin file was changed by this workflow.

The Native command used was:

```powershell
$env:OBSIDIAN_VAULT_PATH='D:\Documents\Obsidian\测试插件'
$env:OBSIDIAN_VAULT_NAME='测试插件'
$env:PDF_READER_OBSIDIAN_CLI='D:\Applications\Obsidian\Obsidian.com'
$env:PDF_READER_NATIVE_VERSION='0.12.2'
$env:PDF_READER_NATIVE_SCENARIO='five-tools'
node tests/0.7-sidecar-native-acceptance.mjs
```

After the captured run, the protected-file audit was strengthened to include `_index.json`. Pure tests are run with:

```powershell
node --test tests/native-controlled-close.test.mjs tests/native-wal-evidence.test.mjs tests/native-sidecar-isolation.test.mjs tests/ipad-pointer-policy.test.mjs
```

The earlier focused helper verification passed 14/14 tests before the `_index.json` audit inclusion. The final verification for the committed test-only diff is recorded in the task handoff; it does not replace any of the Native results above.
