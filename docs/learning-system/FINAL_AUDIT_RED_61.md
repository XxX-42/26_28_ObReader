# Focused final audit evidence

Base: `c4f1154d5c6304f901963fc19f1fa701e2ce8259`.

- `node --test --test-name-pattern "audit:" tests/learning-host.test.mjs`: 0/1. Revoking source validity during post-verification manifest loading still confirms; expected LEARNING_SOURCE_STALE rejection is missing.
- `node --test --test-name-pattern "audit:" tests/learning-domain.test.mjs`: 0/1. A fresh device B runtime exports device A's persisted lastReviewEvent but an empty reviewHistory.

These are deterministic memory-adapter tests, not Native or real Sync evidence. No production change is included in the red-test commit.

Repair boundary: a late source and exact draft guard check can reject changes observed after planning and before commit. It does not make source files, Reader state, and the learning transaction globally atomic.

## Minimal repair evidence

- Confirmation repeats source verification after asynchronous replacement planning and then runs the Host's captured draft guard immediately before commit. The guard retains the original canonical annotation-row hash and lifecycle checks; annotation resolution also compares the captured canonical version/clock shape for the same UUID.
- Export enumerates all devices through the existing History API and retains event-ID deduplication.
- Both original audit reds pass. The late-source case additionally covers changed annotation text without a version update and a changed canonical version; all leave the modal and prompt intact with zero persisted files.
- `node --test tests/learning-host.test.mjs tests/learning-domain.test.mjs`: 24/24, zero skipped. This remains deterministic Node evidence, not Browser, Native, or real Sync verification.
