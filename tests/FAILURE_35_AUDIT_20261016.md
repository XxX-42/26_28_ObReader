# WAL v3.2 failure audit (in progress, not a release acceptance)

Frozen failure input: `benchmarks/reports/wal-v32-final-functional-regression-20261016.log`:
555 total, 514 pass, 35 fail, 1 cancelled, 5 existing platform skips.
The cancelled case is listed separately below; therefore this table has 36 rows.
No historical log is replaced. A focused pass does not establish full-suite stability.

Classification describes the evidenced first blocking cause, not a blanket
claim that the entire test is fixed. Additional failures exposed later remain
blocking. `NOT_EXECUTED` means the required full-load attribution is unfinished.

| # | Original case | Classification | Evidence / correction / remaining work |
|---|---|---|---|
| 1 | annotation creation priority | TEST_PRECONDITION_FAILURE | Fake host lacks source confirmation and calls `message.data.slice` on an ordinary sidecar save. Identity fixture added; binary round-trip oracle remains to migrate. |
| 2 | iOS autosave | STALE_0_7_ORACLE | `onModified()` without changed content is not an edit. Ordinary sidecar saves no longer acquire a full-PDF serialization lease. Supply actual storage content; preserve cooldown, ordering and lifecycle assertions. Not accepted yet. |
| 3 | desktop autosave | REAL_PRODUCT_FAILURE | Real save message lost `origin` while converting to sidecar. Failure artifact `autosave-failure-1792135938073.json` shows valid Square operations and missing origin. Origin restored without binary serialization. Further binary/recovery assertions remain stale. |
| 4 | timed out preparation deadline | NOT_EXECUTED | Full-load attribution remains open; no timeout increased and no deadline assertion removed. |
| 5 | natural zero-exit browser | TEST_INFRA_FAILURE | 50ms child lifetime raced OS identity capture. Explicit fixture close handshake replaces timer; all identity assertions retained. |
| 6 | process query diagnostics | TEST_INFRA_FAILURE | Windows synchronous query bypassed injected processQuery. Async injectable query now preserves errors/timeouts and permits exit events. |
| 7 | inherited browser pipes | TEST_INFRA_FAILURE | Fixture descendant lifetime was timer-dependent and Windows non-detached child did not outlive parent reliably. Independently detached, test-owned child now exits through explicit loopback control after assertions. Close budget is measured from the implementation's existing deadline origin. |
| 8 | missing birth identity | TEST_INFRA_FAILURE | Unsupported-platform early return hid invalid identity. Identity validation now precedes sampling platform selection. |
| 9 | TERM/KILL cleanup | TEST_INFRA_FAILURE | Blocking Windows ownership lookup stalled exit event handling. Async queries pass focused bounded-termination assertions; full stress still required. |
| 10 | browser launch environment | TEST_INFRA_FAILURE | Windows Path/PATH aliases were distinct JS keys. Canonicalize case before applying explicit overrides; do not discard environment. |
| 11 | narrow toolbar | STALE_0_7_ORACLE | Asserted obsolete full-PDF overwrite label. Exact new label/title/aria, geometry and disabled tool checks retained. Focused pass. |
| 12 | FreeText AP undo | STALE_0_7_ORACLE | Host calls `save.data.slice` and assumes daily save writes an AP to source canvas. Needs explicit-export AP coverage plus composite-layer sidecar coverage; not accepted. |
| 13 | multiline Highlight | NOT_EXECUTED | Focused pass is insufficient attribution. Added awaited PDF.js task/worker/document/page-view teardown and cleared selection; focused teardown verification passes. Full-load stability not yet established. |
| 14 | iPad pointer policy | STALE_0_7_ORACLE | Expected `touch-action:none` despite native finger pan ownership (`pan-x pan-y`). Identity handshake added. Remaining pen/finger behavior must still run. |
| 15 | browser-only mobile resource imports | NOT_EXECUTED | Isolated pass does not prove full-load resource starvation. Full-suite rerun required; no skip or platform relaxation added. |
| 16 | trusted mouse | STALE_0_7_ORACLE | Host save handler calls `message.data.slice`; asserts ordinary PDF bytes/hash change. Must assert durable sidecar and reopen instead, retain interaction assertions. |
| 17 | native finger ownership | TEST_PRECONDITION_FAILURE | Editing remained correctly read-only without source confirmation. Real identity fixture added. Focused behavior pass; full suite required. |
| 18 | open lifecycle | REAL_PRODUCT_FAILURE | Missing origin, same evidenced save-message regression as #3. Source handshake and sidecar no-bytes assertion added; remaining lifecycle assertions not accepted yet. |
| 19 | selection differential | NOT_EXECUTED | No inference of CPU contention from isolated pass. Explicit verified PDF/Worker teardown added; load-stability gate remains open. |
| 20 | same-store stale checkpoint | STALE_0_7_ORACLE | Expected previous=current and immediate deletion. Assert previous=last distinct verified state and retain younger/uncovered batch. No stale-overwrite safety requirement relaxed. |
| 21 | independent stale replay | REAL_PRODUCT_FAILURE | Prior checkpoint write allowed stale primary replacement. Exact baseline bytes plus local adapter.process conditional replacement and bounded replay retry. Focused no-regression assertion now passes. Not distributed CAS. |
| 22 | retired stale task after real GC | TEST_PRECONDITION_FAILURE | Missing distinct covering previous and 30-day retention. Public witness device/ACKs and mock clock now make real unlink occur; acknowledged annotation must survive stale task. |
| 23 | GC vs newly published batch | TEST_PRECONDITION_FAILURE | Construct genuine retention eligibility, then pause GC candidate scan. Old batch actually removed, newer batch retained. |
| 24 | late old-clock batch | TEST_PRECONDITION_FAILURE | Anchor was never eligible for GC. Public device/ACK/30-day fixture now truly removes anchor before late batch replay. |
| 25 | primary/previous competition | STALE_0_7_ORACLE | Old test explicitly required stale primary rev1 plus mirrored backup rev2. Now pauses before atomic decision and requires primary rev2 and unchanged previous, then fresh C recovery. |
| 26 | same batch double GC | TEST_PRECONDITION_FAILURE | Missing retention/dual-checkpoint eligibility. Real removal and single queued remover assertions retained; previous must be distinct. |
| 27 | independent document GC | TEST_PRECONDITION_FAILURE | Same missing eligibility; both independent eligible GCs must enter removal without serializing across docKeys. |
| 28 | rejected GC queue recovery | STALE_0_7_ORACLE | Injected failure into nonexistent third duplicate-backup rewrite. Inject real GC remove failure instead; batch retained, then exact one successful retry, both GC/materialization statuses verified. |
| 29 | published-before-readback crash (cancelled) | NOT_EXECUTED | Separate-process focused kill/recovery succeeds. Full-load timeout attribution remains open; no timeout increased. |
| 30 | previous-written crash | TEST_PRECONDITION_FAILURE | No distinct prior checkpoint existed. Seed verified rev0 with hooks disarmed, then kill real previous rotation after primary rev1. |
| 31 | primary-written crash | STALE_0_7_ORACLE | Expected mirrored backup rev1. Verified previous baseline rev0 is the correct recovery state. Real child kill retained. |
| 32 | pre-ACK crash | STALE_0_7_ORACLE | Prior rev0 ACK must not acknowledge rev1; previous remains rev0, not duplicated rev1. |
| 33 | post-ACK crash | STALE_0_7_ORACLE | Exact primary hash ACK retained; previous must be prior distinct rev0. |
| 34 | GC unlink crash | TEST_PRECONDITION_FAILURE | Public distinct checkpoint + exact active ACK + mock 30 days now reaches actual unlink; fresh child-independent Store recovers UUID. |
| 35 | sync bridge in-place merge | STALE_0_7_ORACLE | Test exercises old full-PDF prepareLocal/in-place merge. Must separate explicit export from ordinary sidecar ACK/hydration; not accepted. |
| 36 | Underline geometry round-trip | STALE_0_7_ORACLE | Geometry creation progresses, but fake save handler expects message.data then never ACKs. Must migrate round trip without dropping geometry assertions. |

## Current verified evidence

- `epoch-barrier-red-20261016.log`: valid legacy fixture failed to reject before barrier.
- `epoch-barrier-after-20261016.log`: 9/9 JSONL/migration/epoch tests.
- `race-guard-final-20261016.log`: 14/14 Store race/queue cases. The in-memory harness explicitly does not claim process crash coverage.
- `infra-crash-final-20261016.log`: 42 total, 37 pass, 0 fail/cancel, 5 existing platform skips; includes seven separate child-process crash boundaries.
- `selection-teardown-verification-20261016.log`: 2/2 selection/multiline tests with explicit teardown assertions.
- `failure-repair-full-20261016.log`: current full-suite rerun; authoritative counts are its terminal summary, not the focused numbers above.

## Product safety boundary

The bundled Format3 adapter rejects all mutation after `_storage-protocol.json`
activates JSONL ownership, but read-only migration remains available. This is not
protection against an unmodified old binary on another computer. Legacy
`checkpoints/*.json` and JSONL `sidecars/*.annotations.json` were already separate
namespaces. Neither the marker nor local DataAdapter.process provides distributed
Sync atomicity. JSONL device archives remain authoritative recovery data.

No push, main-Vault deployment, user PDF write or existing sidecar cleanup is authorized.
Full-suite and three-consecutive-concurrent stability gates remain blocking until actually green.

## Terminal results for this repair (not green)

Run 1 exposed missing atomic-process test adapter capabilities and a lexical
false positive treating the portable `"process"` adapter method as a Node global.
These were not hidden: the raw 556/489/62/0/5 result is retained. All affected
adapters now emulate the same backing-level atomic capability. A compiler-aware
global audit replaces only the false-positive lexical check and adds explicit
negative cases for process.env, Buffer.from, typeof process and globalThis
references. The runtime dependency and no-PDF-write checks remain mandatory.

Introducing atomic process writes exposed a real host tracking regression:
the callback's committed bytes bypassed the write/append/rename tracking proxy.
The new process wrapper tracks changed replacement bytes inside the callback,
forgets fingerprints on failure, and does not classify unchanged foreign bytes
as a self write. The prior 2-vs-1 materialization failure is retained in
`adapter-capability-contract-20261016.log`; the correction passes all 87 Host,
source-binding, package-boundary tests in
`adapter-capability-and-self-echo-fixed-20261016.log`.

Run 2: 557 total / 535 pass / 17 fail / 0 cancelled / 5 existing skips.
Run 3: 557 total / 536 pass / 16 fail / 0 cancelled / 5 existing skips.
Run 3 uses default explicit Viewer shutdown within the unchanged close budget.
Selection differential and multiline Highlight pass that complete run; this is
NOT proof of repeated-load stability. Windows ownership queries still fail in
the full suite despite isolated passes, and the remaining binary round-trip
contracts are not fully migrated. No remaining failure has been skipped or
declared acceptable. Offline run 3 passes. Release/push gate stays FALSE.
