# WAL-Sidecar v3.2 JSONL merge recommendation

**Review date:** 2026-10-17
**Candidate branch:** `codex/wal-v3.2-jsonl`
**Candidate base:** `44f6dd594209ef4b0d0088fb1d8547adb3196ad3` (`0.8.2`, iPad pointer-policy baseline)
**Package version:** remains `0.8.2`; this branch is not a release.

## Recommendation

**Recommendation: merge for integration review, but do not promote directly to
the release/main branch yet.** The v3.2 candidate has a green complete local
suite, offline Viewer smoke test, successful production-adapter throughput and
cold-reopen evidence from the isolated test vault. It is suitable for a review
PR against a dedicated 0.8.x integration target. Release approval should remain
blocked on real Obsidian Sync conflict testing and the long-duration soak test.

This is a conditional engineering recommendation, not a claim that the plugin
has already been merged, released, or deployed to the user's main vault.

## What this candidate changes

- Adds a device-scoped JSON Lines WAL implementation. `appendOperations()`
  validates and applies the batch, emits one serialized block, and makes one
  `DataAdapter.append()` call for that batch.
- Keeps the durable acknowledgement boundary: an operation is acknowledged
  only after the host adapter append promise resolves. It does not send an
  early in-memory ACK or introduce a micro-batch loss window.
- Uses a derived annotation snapshot/checkpoint for faster materialization and
  cold reads while retaining device WAL/archive records as recovery inputs.
- Recovers an unterminated final JSONL row as a torn tail; malformed committed
  rows fail closed instead of silently skipping durable data.
- Reads the v3.1 representation for migration while a protocol epoch barrier
  prevents the bundled legacy writer from mutating v3.2-owned state after
  activation. It does not delete the v3.1 source records as part of migration.
- Routes the storage layer through the Obsidian `DataAdapter` abstraction rather
  than a Node-only filesystem API, preserving the desktop/mobile host boundary.
- Includes WAL, importer, host, browser cleanup, selection, pointer-policy,
  crash-boundary, and recovery tests, plus explicit benchmark and failure
  history records.

Ordinary annotation saving remains external to the PDF. This candidate does
not make `saveDocument()` part of the ordinary WAL path and does not authorize
rewriting a source PDF or existing user's sidecar.

## Verification evidence

The following results were obtained in the isolated test repository and test
vault, not in `远程仓库1`:

| Check | Result | Scope / qualification |
|---|---|---|
| `npm test` | **559 total: 554 pass, 0 fail, 0 cancelled, 5 platform-conditional skips** | Current script runs test files serially (`--test-concurrency=1`) to avoid independent Chromium test processes exhausting the Windows test host. No assertions or timeout values were relaxed and no new tests were skipped. |
| `npm run test:offline` | **Pass** | Offline Viewer opened the fixture, created all five annotation editor types, saved and reopened them, then exited normally. |
| `npm run build` | **Pass** | Exactly three release files; 406 embedded runtime assets and 402 frozen vendor files verified. Payload before release transport compression: 6,644,302 bytes. |
| 1,000-call Obsidian host append/reopen probe | **Pass at the requested 50 ms P99 gate** | P50 3.30 ms, P99 20.70 ms, max 55.70 ms. This is a 357-page test copy in the isolated Obsidian test vault. |
| Cold recovery of 1,000 annotations | **Pass** | After materialization, Reader detach, plugin reload, and reopen, all 1,000 UUIDs were present and unique; an independent read-only Node process also recovered the persisted rows. Full-field hashes matched the recorded expected state. |
| Source PDF isolation | **Pass for the recorded probe** | Source PDF SHA-256 remained `53ade40ce75c07455bd1d5a3829c5dd8efe925a65f1b5a54de756a9bea9dd378`; mtime was unchanged. |
| Working-tree whitespace check | **Pass** | `git diff --check` returned no errors before commit preparation. |

The latest full-suite result supersedes older red-run counts in the historical
reports; those logs remain in place and are not rewritten. The 5 skips are
pre-existing platform-specific cases (POSIX/macOS-only behavior unavailable on
Windows), not newly introduced skips. Serial success does not establish that
the entire suite is stable when many separate Chromium processes run in
parallel, nor does it simulate real users editing the same document on two
devices.

Detailed supporting records:

- [WAL v3.2 50 ms Native gate](benchmarks/reports/0.8.2-wal-v3.2-native-50ms.md)
- [Durable ACK and cold replay profile](benchmarks/reports/wal-v32-durable-15ms-decision-20261016.md)
- [Failure classification and repair history](tests/FAILURE_35_AUDIT_20261016.md)
- [WAL v3.1 storage protocol](ANNOTATION_STORE.md)

## Remaining merge/release gates

1. **Real Obsidian Sync remains unverified.** Local DataAdapter operations and
   two-store test interleavings do not provide a distributed compare-and-swap
   across Windows and iPad vaults. Validate offline concurrent edits, reconnect,
   duplicate/late batches, same-UUID edit/delete, checkpoint convergence, and
   device retirement on separate clients before declaring cross-device safety.
2. **Destructive multi-device GC is not accepted.** Do not infer safe remote
   garbage collection from the local adapter or the current test matrix. Keep
   old recovery inputs until the Sync convergence/retirement policy is accepted.
3. **The 15-minute large-document soak has not been run.** A 1,000-operation
   append/reopen test does not measure long-term renderer/Worker memory or
   repeated page-render lifecycle stability.
4. **The adapter promise is not an fsync guarantee.** The measured durable ACK
   means the public Obsidian adapter append resolved; it does not prove survival
   of sudden power loss or storage-controller cache loss.
5. **This remains package version 0.8.2.** Before release, choose and apply a
   new release version (suggested `0.8.3`), rebuild all three files, verify the
   release directory, and run the release gate against that exact output.

## Proposed integration procedure

1. Push this candidate branch and open a review PR to a dedicated 0.8.x
   integration target; do not overwrite `main` or deploy to the main Obsidian
   vault as part of this merge review.
2. Review the source protocol and migration barrier before reviewing the
   generated `dist/pdf-web-reader/main.js`. Keep source, manifest, and generated
   bundle changes in the same commit; never resolve generated bundle conflicts
   by selecting one side's `main.js`.
3. Run the current serial full test, offline smoke, build, and test-vault
   acceptance on the exact PR head. Preserve prior failure logs and attach new
   evidence rather than replacing them.
4. Merge to the integration target only after code review. Keep release/main
   promotion blocked until the real Sync and soak gates above are accepted.
5. For release promotion, increment the manifest version, rebuild the
   three-file package, install it only in the designated test vault first, and
   complete a separately authorized deployment step. This recommendation does
   not authorize that deployment.

## Suggested PR title and commit

**PR title:** `feat(storage): introduce WAL-Sidecar v3.2 JSONL candidate`

**Commit subject:** `feat(storage): add WAL-Sidecar v3.2 JSONL candidate`

**PR comment / summary:**

> This candidate replaces repeated whole-state WAL writes with device-scoped
> JSONL appends through Obsidian's DataAdapter while retaining durable append
> acknowledgements, v3.1 read/migration support, cold-replay recovery, and PDF
> source immutability. The current serial suite passes 554/559 tests (the other
> five are existing platform-conditional skips), offline smoke passes, and the
> 1,000-operation test-vault recovery matched all persisted fields. Please
> review for integration only: real Windows/iPad Obsidian Sync convergence,
> destructive multi-device GC, and the 15-minute soak remain unverified, so this
> is not release approval.

## Scope boundary

This branch is a code-repository change only. It does not push to the main
Obsidian vault, replace its three plugin files, alter its PDFs or existing
sidecars, create a release, or claim real cross-device Sync acceptance.
