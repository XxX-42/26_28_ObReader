# WAL v3.2: durable ACK decision and cold replay evidence

Measured on 2026-10-16 in the isolated Obsidian vault `D:\Documents\Obsidian\测试插件`. Branch: `codex/wal-v3.2-jsonl`, base `44f6dd594209ef4b0d0088fb1d8547adb3196ad3`; changes remain uncommitted.

## Decision

Retain the existing acknowledgement contract: a saved operation awaits the public Obsidian `DataAdapter.append()` promise. The production P99 performance gate is **15 ms**. A sub-5-ms interactive response remains a separate goal; no early saved ACK or micro-buffer loss window was introduced. A resolved adapter promise is the existing persistence boundary; this test does not establish OS power-loss/fsync guarantees.

The public adapter append accounted for **86.37%** of the total mean time. Per the requested 75% criterion, application-level tuning of individual serial appends stops here. The total P99 was **11.5 ms**, below 15 ms. The 5 ms P99 target was not met.

## Measured profile: 1,000 sequential operations

| Boundary | Mean ms | P50 ms | P99 ms |
| --- | ---: | ---: | ---: |
| Complete appendOperations ACK | 5.049 | 4.6 | 11.5 |
| T1: capture + Store processing | 0.459 | 0.4 | 0.7 |
| T2: Store writer queue wait | 0.011 | 0.0 | 0.1 |
| T3: public DataAdapter.append | 4.361 | 4.0 | 10.7 |
| Encoding alone (subset of T1) | 0.191 | 0.2 | 0.4 |
| Complete time outside public adapter (includes T1/T2/proxy bookkeeping) | 0.688 | 0.6 | 1.1 |

The Obsidian adapter's internal global queue is inside T3, not falsely reported as Store T2. T1 is explicitly the Store capture/processing boundary; the final row includes remaining proxy bookkeeping. Percentiles of stages are not additive. The maximum complete ACK was 76.6 ms (cold first operation); one later public-adapter call took 62.2 ms. No outliers were removed.

The 1,000 measured ACK durations sum to approximately **5.05 seconds**, excluding checkpoint/reload verification. The earlier 3-second throughput goal is not met; changing the durable latency gate does not turn that result into a 3-second pass.

The prior complete run after event-generation debounce had P99 15.9 ms and failed its then-5-ms target. That failure is retained in `wal-v32-5ms-01-execution.log`. The long CLI profile request failed with an Obsidian main-process JSON-parse modal and a CLI timeout; it did not produce a usable profile. Its evidence is retained in `wal-v32-5ms-02-profile.log`. The working profile uses an exclusive test-only input artifact under `.obsidian/plugins/pdf-web-reader/.native-test-output` and a short CLI command. No timeout was enlarged. The successful raw profile is `wal-v32-profile-public-20261016.log`.

## Cold replay gate

The fixture is `PDF迁移测试/wal-v32-native-20261016-5ms-02.pdf`; run ID is `wal-v32-native-20261016-5ms-02`. Existing 12 legacy tombstones remain unchanged; there are exactly **1,000 active annotations**.

After checkpoint, Reader detach, plugin reload and forced garbage collection, the new runtime Store returned 1,000 unique UUIDs with no syncPending. A separate Node child process, using a read-only filesystem adapter and no renderer cache, independently read the persisted files and returned the same result. The final extended check made 85 actual disk reads and no denied cache writes.

Every persisted field of **all 1,000 rows** was compared against a deterministically generated expected snapshot, not just a count or the final row. Expected, reloaded runtime and independent-process SHA-256 of the canonical active-row state all matched:

`3142e75ef9d2f70fd044e7721f1345cd821f158556aade14881708690bd2b5c4`

The final row was also deep-compared in full: UUID suffix `-999`, pageIndex 285, Square, rect `[105,100,205,200]`, color `[231,17,231]`, opacity 0.9, thickness 2, benchmark ordinal 1000, revision 1, sequence 1014, and the exact stored operation ID. Evidence: `wal-v32-all-fields-cold-recovery-20261016.json`.

An additional check verified the canonical persisted operations themselves, including all 1,000 original Viewer operation IDs (`originOpId`), sequence numbers and Lamport versions. The expected, runtime and independent-process canonical-operation hashes matched `e16053b1313e8797dea7528930d007bd1a05a03b1de324a12ccd7eb1251851e8`. The public snapshot clock is the protocol's normalized Lamport clock, not a verbatim copy of the transient input clock; original operation IDs were checked separately in the actual WAL state. Evidence: `wal-v32-canonical-operation-recovery-20261016.json`.

Both the test copy and original Principles PDF had unchanged SHA-256 and mtime throughout the profile. Their SHA-256 was `53ade40ce75c07455bd1d5a3829c5dd8efe925a65f1b5a54de756a9bea9dd378`; mtime was `1791951308993` ms.

## Changes and release state

Sustained own-WAL events now wait for the pending event generation to settle before their exact fingerprint verification, avoiding repeated full WAL reads during the burst. Events are still verified and external changes still trigger replay. The regression was red at four reads, then green at one read. Independent capture, queue, encoding, append and processing timings were added without changing saved ACK semantics.

87 focused Store/Bridge/Host tests passed. The first full regression returned 555 tests: 498 passed, 52 failed, 5 skipped (`wal-v32-after-profile-full-suite-20261016.log`). That run exposed test adapters which still lacked append(). After those test-only adapters were corrected, 16 routing/mobile-host tests and both real-browser/no-Node mobile startup/save/reopen tests passed (resource imports and forced Blob fallback). No assertion was skipped or weakened. The final full-suite result was **555 tests: 514 passed, 35 failed, 1 cancelled, 5 skipped**, exit 1 (`wal-v32-final-functional-regression-20261016.log`). It still contains browser timeouts/cleanup failures and old cross-instance/crash safety red tests; the full suite is not green and no no-regression claim is made. `npm run test:offline` passed (`wal-v32-after-profile-offline-20261016.log`). Real iPad Sync and the 15-minute rendering soak are not verified. No destructive archive GC is introduced. This performance/cold-replay result does not approve release by itself.

The candidate was deployed only to the isolated test vault, with the old three files backed up. No push, release, or deployment to `远程仓库1`; no original PDF or existing user sidecar was changed.

Candidate and installed test-vault main.js SHA-256 both equal `4579931e7c303eea8659014228d54d2e70e2d6cf0fd2ba9ba8c39c9a8cd1c303`. Manifest SHA-256: `e7b3e9ea49d38695282ceb3db62040b659ed53f95f304602e0836599c9ae6f77`. Styles SHA-256: `9dd5d3a26025cb83a7f68d63293fde69aec3bfbc7e9a5367f377853e11463650`.
