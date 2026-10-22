# Windows Native P0 staging acceptance — 2026-10-22

This is additional evidence, not a replacement for the earlier failures in
`P0_NATIVE_HARNESS.md` and `P0_SQUARE_NATIVE_SELECTION.md`. The installed P0
staging bundle is still 0.12.2, SHA-256
`78c842df1ee3806277983fced3dc3e0cf01137960a59d577cf1925a53ac2b563`.
It is not a deployed 0.13.0 learning candidate.

## Retained follow-up failures

| Run | Evidence | Classification / change |
| --- | --- | --- |
| `20261022132045323` | Five tools and reopened same-UUID Square move saved; deleting Underline while Square creation mode was active did nothing. | Test precondition: return to NONE and prove selection before Delete. |
| `20261022132521477` | Unchanged hydrated Underline `serialize(true)` returned null, while its persisted row and visible editor remained intact. | Test oracle: changed-row serialization is not UUID identity. Reuse authenticated `reader-anchor-capture-request` / capture response for the selected UUID. |
| `20261022133210246` | Delete/undo/redo and final four-editor reopen passed; approved new-file export was rejected by its own guard. | Test infrastructure: the serialized setup callback's `fixtureFolder` argument was missing. Pass it explicitly and fail before installing wrappers if fixture scope is missing; VM tests cover omission and unrelated paths. |

No timeout, product diagnostics limit, assertion depth, persistence format, or
PDF.js vendor was weakened to address these failures.

## Complete five-tool run

`tests/artifacts/0.7-sidecar-native-acceptance-20261022133417725.json`: PASS.

- Trusted creation of Underline, Square, Highlight, Ink and nonempty FreeText.
- Durable JSONL replay, normal controlled close, five same-UUID editors reopen.
- Saved Square moved with trusted input; original UUID and changed rectangle saved.
- Selected Underline capture returned its exact acknowledged UUID, page identity,
  source hash and session. Delete → Undo → Redo and final four-editor reopen passed.
- Independent export creates a new PDF with exactly Highlight, Square, Ink and
  FreeText standard annotations. Complete FreeText contents are retained.
- Every controlled close independently verifies v3.2 replay and matching snapshot;
  Viewer revision is not confused with WAL watermark.
- Ordinary `saveDocument()` calls = 0; the sole call is explicitly authorized
  new-file export. Source PDF write attempts = 0, other unauthorized PDF attempts = 0.
- All 366 existing sidecar files, including root index, are hash-unchanged.
- Full trace artifact checksum verified (1,724,937 bytes); guards restored and no
  fixture Reader remains. Test Vault only; production Vault not deployed.

## Dedicated FreeText run

`tests/artifacts/0.7-sidecar-native-acceptance-20261022133626126.json`: PASS.

- Real pointer creation, nonempty input, external toolbar commit, durable save,
  full close and reopen preserve UUID and exact text.
- Reopened PDF rectangle max delta = **0 PDF pt**; nonzero DOM width/height,
  visible computed style and **1,580 changed composite ROI pixels** before and
  after reopen. This is composed iframe display, not page-canvas-only evidence.
- New independent PDF reparses with `/FreeText`, exact contents and rectangle
  within 0.01 PDF pt. Original PDF remains byte-identical.
- Protected sidecars 366/366 unchanged; zero ordinary serialization/write calls;
  successful trace checksum and instrumentation cleanup.

Both source fixtures: 1,016,315 bytes; SHA-256
`3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`;
XXH64 `xxh64-v1:ffbe0d4d212547e5`, identical before and after.

The runner now explicitly requires `wal-sidecar-v3.2-jsonl`, independent WAL
replay at saved and close boundaries, and exported page/rectangle/content
checks. The general legacy evidence reader remains available to migration tests.

## Dedicated Underline and Reader lifecycle

`tests/artifacts/0.7-sidecar-native-acceptance-20261022133723949.json`: PASS.

- Single line → save → controlled close/reopen; adjacent line and multiline →
  save → complete close/reopen: exactly three distinct persistent UUIDs and
  three visible editors, no duplication.
- UUIDs: `b6612640-b2e6-4e0c-9437-8cf1fc567f1a`,
  `a95ccdfb-7529-438f-8c3d-34644718793f`,
  `ea5c42ed-5cce-4ace-9023-dfd27e30a16b`.
- Real selection consumers observe non-collapsed ranges (36, 36 and 100
  selected characters). Composed ROI changes: 745 pixels for the first reopened
  Underline and 3,809 pixels for all three after the final reopen.
- Independent Reader A/B iframe lifecycle completed without losing B's selection
  listeners. This is not a backport of upstream #22129.
- Source dual hashes unchanged, zero ordinary PDF serialization/write attempts,
  366/366 protected files unchanged; 878,226-byte trace checksum verified,
  controlled closes complete and instrumentation restored.

macOS, physical iPad and real multi-client Sync remain NOT_RUN.
