# 0.14 objective completion audit — decision draft, not release approval

Snapshot audit: 2026-10-24 Asia/Shanghai. Document-only branch based on integration
`c08049a`; private dictionary candidate inspected at `962a6f9`. Runtime work may
advance after this snapshot. The auditor performed no test, Native/UI/browser,
benchmark, deployment or production-file change. ROOT owns live Native work.

This maps the A–G workflow scope and explicit acceptance requirements available
in the project reports and ROOT handoff. The original user prompt is not stored
in this document; final owner must reconcile its exact wording before calling
this an exhaustive sign-off. Numbers of scenarios, tests and process restarts
are not interchangeable acceptance evidence.

## Draft decision table

| Requirement / decision | Authoritative evidence at this snapshot | State and limit |
| --- | --- | --- |
| Preserve latest baseline and unrelated user work | `014_BASELINE.md`, baseline `cd6e157`; independent source diff and `014_FINAL_INTEGRATION_AUDIT.md` | DONE for inspected source boundaries. Historical primary-worktree overlays were not relabeled or silently replaced. |
| PDF/vendor/WAL/recovery/input/coordinator/canonical/Context/ReviewHistory freeze | Source diff has no changes to storage core, vendor, input, Vocabulary canonical/transactions/History; Native isolated per-stage invariants | SOURCE BOUNDARY PRESERVED. Shared Host/bridge and documented glyph recovery exceptions changed; “all code unchanged” is false. Runtime guarantees are scoped to measured datasets, not whole historical Vault trees. |
| Deterministic RED before necessary production correction | ACK/folder RED logs with SHA in final integration audit; Windows path, EditorRange, route retry/queue, page-badge RED documents; legacy captured-glyph RED in `014_LEGACY_HIGHLIGHT_RECOVERY.md` | DONE for documented corrections. Retained failures remain evidence; a later fix does not relabel the old failed run. |
| Thin Learning / Sidebar / Backlink APIs and SemanticAnchorContractV1 | `plugin/semantic/services.cjs`, `semantic-contracts.cjs`, `semantic-anchor.cjs`; `014_FINAL_INTEGRATION_AUDIT.md` | IMPLEMENTED / native acceptance PENDING. Flat target identity, explicit non-exact fallback, exact source evidence, request-scoped ownership; no new authoritative store/index. |
| Rename canonical Learning/History byte invariance | External `markdown-routing.cjs`, `014_ADJACENT_MARKDOWN_ROUTE_FIX.md`, route-fault tests; isolated Native snapshots | IMPLEMENTED and scoped evidence available. Missing source/route and historical-path reuse fail closed; actual user Vault all-tree historical invariance is not established. |
| Highlight → durable Sidebar → explicit Review → Today → exact UUID Source | Native B partial receipts, current resume report/checkpoint; accepted runtime request/target ACK | PARTIAL NATIVE PASS on recorded fixture/package. Does not establish every route-stage direction. |
| LingQ actual personal status → complete-sentence Context → Review → exact Anchor Source | Current `native-final-resume` full-sentence creation report and screenshots | COMPLETED CURRENT UI CHAIN in retained resume evidence. Old phrase-only Context receipt was insufficient and remains historical. All-stage coverage still PENDING. |
| Markdown real editor selection → explicit draft → Today exact Source | Initial Native receipts, EditorRange and adjacent-event repairs, current resume | PARTIAL NATIVE PASS. Consecutive rename/move defect was reproduced and repaired; require package-bound continuation, not a unit-only replacement verdict. |
| Each of eight rename/move/restart stages, all five navigation directions | Existing eight-stage report plus newly prepared full-direction continuation | NOT COMPLETE. Eight old `passed` flags mostly contain Review/Context/Markdown Source checks, not the full five-direction matrix. See matrix below. |
| Windows full route/restart chain | `014_WINDOWS_NATIVE_RESULTS.md` is old RED at `3eff47f`; current ROOT reports owned-profile process-restart work underway | PENDING. Do not use old shared PID shutdown or plugin reload as true process restart. No current complete verdict inspected. |
| Mac actual process restart and full-direction repetition | `process-restart-checkpoint.json` explicitly says plugin disable/enable only, actual process restart pending ROOT | PENDING. Its route named `restart` does not prove process restart. |
| Default data trees unchanged through all historical Native setup | `reload-disable-save-race.json`; `default-trees-controlled-baseline.json` | HISTORICALLY UNPROVABLE from available receipts. Setup incident has mtimes but no before-hash baseline. New controlled phase starts a complete 122-file/20,023,598-byte hash baseline; it cannot retroactively prove the previous window. |
| Latest installed Mac package and source fixture identity | Current deployment/metadata reports and ROOT handoff | Installed c080 main SHA `e9323d1854f315608ff1e0ca8741f87b7476ce2b486f3450f03af501e750377a`; source PDF SHA `3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`. Earlier saved preflight counted 27 files; ROOT reports latest isolated test set 43. Preserve snapshot ages; count alone is not an integrity proof. |
| ECDICT real 770,611-row equivalence / bounded 67-block resource | C resource builder/runtime tests and comparison report in private candidate | IMPLEMENTED / researched. Actual 67-block files are outside Vault in evidence/resource-v3, not installed for Native at handoff. |
| Ordinary Chrome five fresh cold A/B repetitions and 20-key workload | `RESOURCE_V3_COMPARISON_BENCHMARK_PLAN.md`, 20/20 comparison trials | COMPLETE CHROME RESEARCH. v2 median full-import wait 72,160ms; v3 first-rare P95 39.8–89.8ms. No Native inference. |
| True warm/resident performance rather than mixed misses | Same report, 15/15 residency trials | COMPLETE CHROME RESEARCH. Mixed repeat includes 30 binary reads/100 samples per setting. Resident-hit P95 ~0.1ms; same-block repeat zero new reads. Count limits not separated under 8MiB cap. |
| Native resource-v3 startup added blocking <50ms and Native timing gate | `e60effc` / `89e90e9`, `docs/vocabulary-v2/native-dictionary-resource-v3-benchmark.md` in `962a6f9` | NOT_RUN / startup added blocking NOT_MEASURED. Attach-only lookup harness is prepared, not execution. Even executing it cannot prove startup blocking; controlled startup marks/traces and paired baseline are separately required. |
| Final resource-v3/LRU production selection | Above Native gate plus full correctness evidence | UNDECIDED. Private v3 wiring is a candidate; no LRU count/byte capacity frozen and no production library rollout authorized by this audit. |
| SQLite WASM / OPFS production replacement (option B) | SQLite capability and Chrome reports | REJECT / DEFER PRODUCTION. Local COI=true standard OPFS evidence cannot substitute for app-origin Native COI=false; SAHpool multi-window failures persist. CPU NOT_MEASURED. Retain both failed and corrected trial sets. |
| Real-filesystem 25k bulk optimization | `25K-COMPLETED-20261023.md`, 15 runs and preserved earlier attempt | EXPERIMENT COMPLETE / BOTH CANDIDATES REJECTED. A misses total-write gate; B misses total-write, History, CPU and restore gates. Production unchanged. |
| FSRS pinned developer replay only | `FSRS_EVALUATION.md`, dev adapter/evaluation tests | DONE AS DEV EXPERIMENT. Default Leitner, History and personal data remain authoritative; incomplete history returns INSUFFICIENT_HISTORY. No production migration decision. |
| Build, three release files and complete stable final gate | Third private run report, source fingerprint below | PASS FOR TESTED PRIVATE SNAPSHOT. Does not complete Native, install external 67-block resources, or authorize rollout. |
| iPad | Original scoped baseline and current handoff | DEFERRED_BY_SCOPE, never implied PASS from desktop/browser. |
| Subsequent agent model requirement | ROOT coordination record | Subsequent agents use gpt-6.1-sol/low. Original seven Luna workflows remain historical Luna work; do not rename their provenance. |

## Eight-stage acceptance must be a matrix

Stages are `pdfrename`, `foldermove`, `mdrename`, `mdmove`, `bothmove`,
`closedmove`, `openmove`, and restart. Each requires identity/path and byte
invariant evidence plus the five navigation directions. Current additional
navigation harness separately exercises Markdown→PDF, PDF page-badge→Markdown,
and Sidebar→same Highlight; old stage receipts principally checked Review/
Context→PDF and Markdown Review Source. These additional directions must be
recorded at each required stage, not merely once after all moves.

| Stage | Existing recorded scope | Full five directions / process proof |
| --- | --- | --- |
| pdfrename | old PDF Source receipt, route, scoped invariant | PENDING full matrix |
| foldermove | old PDF Source receipt, route, scoped invariant | PENDING full matrix |
| mdrename | old Markdown Source receipt, route, scoped invariant | PENDING full matrix |
| mdmove | old Markdown Source receipt, route, scoped invariant | PENDING full matrix |
| bothmove | old PDF + Markdown Source receipts | PENDING full matrix |
| closedmove | controlled Reader close + Source reopen | PENDING full matrix |
| openmove | old PDF Source receipt | PENDING full matrix |
| restart | label exists, but checkpoint expressly scopes it to plugin toggle | PENDING actual owned-process restart and full matrix |

Navigation receipts must preserve exact target UUID/Anchor, docKey/documentId,
source hash/page identity and current requestId/openRequest/rendererGeneration;
changed source/page, deleted annotation, duplicate quote and stale ACK cases
remain fail-closed requirements. Existing unit/browser regressions cover these
negative cases; they are not proof of every Native-stage action.

## Formal full-gate evidence

Reports are retained under private `v3-wiring/tests/artifacts/vocabulary-gates/runs/`:

| Run | Fast / Browser incl. offline / Race | Overall | Disposition |
| --- | --- | --- | --- |
| `run-2026-10-23T15-00-53-164Z-59919-f3a335d5` | 118/120; 25/28; 70/80 | 213/228, 15 failed | Preserved FAIL; exposed harness/version, legacy glyph and fixture readiness issues |
| `run-2026-10-23T15-18-44-961Z-69217-b8032b01` | 121/121; 27/28; 80/80 | 228/229, 1 failed | Preserved FAIL; not discarded as warm-up |
| `run-2026-10-23T15-34-50-637Z-77800-f267515b` | 121/121; 28/28; 80/80 | 229/229, zero skipped | acceptanceEligible=true for this run |

Third report has identical before/after source fingerprint
`a2cfe81c8e31fd5712b94fa056f7934b21285586618a867d8c4cfaaae644486d`
(971 files), stable=true and no changed files. These are gate executions, not
229 individual assertions. Fingerprint excludes docs/dist/artifacts; installed
bundle hash must be checked separately. ROOT identifies private tested candidate
as `962a6f9`; report identity/fingerprint is the execution authority.

## Seven original workflow report index

Labels below follow the original branch/worktree division; research option
letters in benchmark decisions are separate labels.

| Workflow | Report / implementation index | Current decision |
| --- | --- | --- |
| A Architecture guardian | `014_A_GUARDIAN.md`, `014_BASELINE.md`, `014_FINAL_INTEGRATION_AUDIT.md` | Architecture preserved with documented correctness exceptions; final Native acceptance pending |
| B Native UI/learning | `014_WINDOWS_NATIVE_RESULTS.md`, `WINDOWS_NATIVE_B_STATUS_2026-10-23.md`; `evidence/native-sol-low`; outside-Git current `native-final-resume/evidence/native-final-resume` | Mixed-age partial receipts; latest full matrix/process restart still underway |
| C ECDICT ranged resources | Private `RESOURCE_V3_COMPARISON_BENCHMARK_PLAN.md`, `RESOURCE_V3_WIRING_CANDIDATE.md`, Native benchmark handoff | Chrome research done; Native resource install/performance/startup absent; capacity undecided |
| D SQLite/OPFS | `SQLITE_OPFS_BENCHMARK_RESULTS.md`, `SQLITE_OPFS_CHROME_RUNS_2026-10-23.md` | Research retained, compatibility/locking/measurement constraints block replacement |
| E Semantic contract / routing | `SEMANTIC_ADAPTER.md`, `014_ADJACENT_MARKDOWN_ROUTE_FIX.md`, `014_PAGE_BADGE_HOST_RED.md`, SemanticAnchor modules/tests | Implemented; recent correctness RED repairs integrated, Native sealing pending |
| F Disk bulk | `evidence/vocabulary-bulk-disk/25K-ATTEMPT-20261023.md`, `25K-COMPLETED-20261023.md` | Completed rejection; no production optimization |
| G FSRS | `FSRS_EVALUATION.md`, `scripts/learning-fsrs-dev-adapter.mjs`, evaluation/tests | Developer-only deterministic replay, no production scheduler change |

## Authority, chronology and irrecoverable gaps

Current Mac resume directory read by this auditor:
`/Users/jiajia/.codex/worktrees/obreader-0.14/native-final-resume/evidence/native-final-resume/`.
Its saved `process-restart-checkpoint.json` says “8 routes and full-sentence UI
chain passed” but explicitly limits restart to plugin disable/enable. Raw route
objects actually show the narrower checks listed above. That wording must not
be promoted into a full Native gate. Current ROOT-controlled work supersedes it
only when a new complete receipt is saved and reviewed.

`reload-disable-save-race.json` discloses an autoload before isolation settled.
Its mtimes identify possible writes, not unchanged bytes. The complete later
`default-trees-controlled-baseline.json` starts a prospective controlled claim;
no future hashing can manufacture a historical pre-incident baseline. Record
this limitation permanently, even if every new controlled-stage check passes.

The current Windows report committed at c080 is an earlier RED receipt, not the
live owned-profile task's final result. Process restart must show owned old PID
termination/new PID and reattachment, exact package/fixture IDs, and post-restart
navigation/integrity; plugin reload and inability to kill an old shared PID do
not satisfy it. ROOT coordinates that work; this auditor sends it no messages.

Cannot finish from current evidence alone: both platforms' full eight-by-five
matrix, actual process restart receipts where required, new controlled default-
tree before/after coverage, Native v3 measurements and controlled startup added
blocking, final capacity/rollout decision, and exact reconciliation with the
original user objective. Existing third gate PASS and research rejections are
complete findings; do not rerun them merely to hide unrelated acceptance gaps.
Semantic contract final acceptance remains **PENDING**, not FROZEN.
