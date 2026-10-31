# Selection anchors in current PDF JSONL

Base: 49cfeca9b60bbc60bbca61828aeb3d2124ce8a2c

Selection anchors use optional `selection-anchor` rows in the existing v15 current file. Original UUIDs, sealed payloads, source evidence and Markdown fragments remain valid. Existing document queues, conditional publication and whole-file integrity cover writes. Annotation saves, reader states, source updates and rename preserve anchors. Migration verifies old seals, publishes and reads back every anchor before checking old bytes again and removing old files. Failed publication retains legacy files.

PDFs without a paired annotation JSONL continue to use legacy anchor storage until a corresponding annotation file exists. This patch does not pair or modify PDFs merely to store a selection link.

## Results

- Targeted store/registry/host/bidirectional Browser: 47 passed, 0 failed.
- Offline five-tool/save/reopen/delete smoke: passed.
- Fast: 145 test files passed, 8 failed, 5 platform skips. Seven failure files reproduce on the isolated base checkout. The eighth is browser cleanup: exit 0, five platform skips rejected by gate policy. Full acceptance remains false.
- Browser: 27 test files passed, 6 failed; all six failure files reproduce on the isolated base checkout. Full acceptance remains false.
- Test vault: 5 anchors migrated across 4 paired PDFs; annotations/deletions/guards and history unchanged. Two unmatched legacy records retained.
- Native migrated UUID 445205c1-830e-4f74-b2e9-1245fbbd8244 navigated to the PDF selection successfully.
- Native Vault metadata indexed a newly created test note. Source navigation selected the exact original link at offset 6.
- Production: ae435d210141 migrated 18 anchors, preserving 163 active annotations; bdf2cc536f48 migrated 1 anchor, preserving 5 active annotations. Deletions, guards and recent-history bytes verified unchanged. All 19 old anchor files removed after readback.
- Production old UUID 01a96723-2daf-48a4-b6bf-ea41779de064 returned a successful Viewer selection navigation result after migration.
- Three-file deployment completed to test and production; production hashes matched build output. Anchor migration writes no PDF bytes.

Raw receipts and failed-test evidence remain in ignored tests/artifacts/inline-anchor-* and vocabulary gate run directories. Baseline comparisons remain in the isolated anchor-inline-baseline worktree. Assertions and timeouts were not relaxed. Empty legacy directories were retained after automatic approval rejected their cleanup command.
