# Selection anchors in current PDF JSONL

Base: 49cfeca9b60bbc60bbca61828aeb3d2124ce8a2c

Selection anchors use optional `selection-anchor` rows in the existing v15 current file. Original UUIDs, sealed payloads, source evidence and Markdown fragments remain valid. Existing document queues, conditional publication and whole-file integrity cover writes. Annotation saves, reader states, source updates and rename preserve anchors. Migration verifies old seals, publishes and reads back every anchor before checking old bytes again and removing old files. Failed publication retains legacy files.

Follow-up: PDFs without a paired annotation JSONL now use the existing v15 first-pair transaction when a selection anchor is created. It writes the one-time PDF pairing metadata, keeps the logical document identity and UUID, then saves the anchor in current JSONL. Production inline mode fails closed if setup fails and never falls back to a standalone anchor file. Concurrent setup requests share one promise per identity. Pure reading still creates no files.

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

## Unpaired-document completion

- Store/host/registry/bidirectional Browser targeted run: 49 passed, 0 failed.
- Setup concurrency/failure regression run after final setup deduplication: 18 passed.
- Latest build and offline smoke passed.
- Real Windows mouse selection in a new unpaired test PDF created a paired current JSONL with zero ordinary annotations and one selection anchor; no standalone anchor file appeared.
- First test UUID 900fa8f5-445c-4606-a846-311afade1f4f survived close/reopen and Viewer selection navigation returned ok=true.
- Final candidate repeated real first selection successfully: UUID 1d4f9044-b6ee-4b06-8122-b4e8b313eedf, current JSONL present, ordinary annotations=0, standalone=false.
- Old unpaired test document 9c8577fbb9f1 was opened through the real host and its one legacy anchor migrated with the original ID.
- One test-vault legacy record under 55c7b7e02efa has no current or deferred document route. It remains untouched; no PDF is guessed or rebound.
- Production three-file deployment and reload completed with byte hash comparison. Existing production UUID 01a96723-2daf-48a4-b6bf-ea41779de064 still navigated successfully.
- Full gate failures documented above remain historical unresolved failures; this follow-up does not claim full Fast/Browser acceptance.
