# SQLite WASM / OPFS feasibility audit against Resource-v3

**Date:** 2026-10-25
**Workstream:** D — isolated SQLite WASM / OPFS experiment
**Base:** `197cd7d653967eb0a2d04af3c91470163949e680` (`origin/main`)
**Branch:** `codex/014-ws-d-sqlite`

## Result

**Keep SQLite/OPFS as an experiment; do not select it over Resource-v3.** The historical localhost benchmark is useful for prototype feasibility, but it is not an app-origin comparison. The Native `app://obsidian.md` probe initialized SQLite and observed browser APIs, but it did not install an OPFS VFS or write a database. Native OPFS support, locking, first lookup, and recovery therefore remain **NOT_RUN**.

No new browser/OPFS benchmark, app-origin probe, dependency installation, Vault access or write, production integration, app security/config change, or deployment was performed for this audit. There was no owned disposable Native app-origin profile for an OPFS write probe, and localhost cannot establish Native behavior.

## Prior prototype and raw-run audit

The tracked experiment consists of nine benchmark/tooling files under `scripts/sqlite-opfs/`. Its pinned runtime is the official SQLite WASM 3.54.1 archive. The lean fixture contains 770,611 ECDICT rows in a three-column `WITHOUT ROWID` table. It is 48,779,264 bytes; its SHA-256 is `f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c`. The earlier 151,461,888-byte duplicate-payload database is prototype history and was not used in the benchmark.

I read both existing ten-trial JSONL run sets and left them intact. The runner uses a fresh normal persistent Chromium profile and a trial-specific database filename for each trial; it sets `incognito: false`. The local runner's `127.0.0.1` origin is not the Native Obsidian origin.

| Historical set | Standard OPFS | `opfs-sahpool` | Interpretation |
| --- | --- | --- | --- |
| Initial, `2026-10-23T14-20-11-567Z` | 0/5 complete; proxy worker URL lacked `/runtime`, so trials failed before database import | Single-worker checks passed, but second-window checks failed 5/5. The initial harness still labeled the top-level records PASS. | Preserve as harness and locking failures; do not count the SAHpool label as acceptance. |
| Corrected route, `2026-10-23T14-20-58-005Z` | 5/5 complete; second-window/worker open passed 5/5 | 0/5 end-to-end; second-window/worker open failed 5/5 | Standard OPFS passed only in ordinary Chrome with local COOP/COEP and `crossOriginIsolated=true`. SAHpool could not acquire another SyncAccessHandle while the primary worker held one. |

The JSONL records and plans remain in the older worktree's ignored `tests/output/sqlite-opfs/` directory. I did not overwrite, filter, or retry any old result. The tracked run summary is [SQLITE_OPFS_CHROME_RUNS_2026-10-23.md](../../docs/learning-system/SQLITE_OPFS_CHROME_RUNS_2026-10-23.md).

The prior Native probe targeted the real `app://obsidian.md/index.html` renderer (Electron 39.8.3 / Chromium 142). It observed WASM, Worker, OPFS getter, SyncAccessHandle, Web Locks and SharedArrayBuffer APIs, with `crossOriginIsolated=false`; corrected SQLite WASM initialization took 77.5 ms. It did not install either OPFS VFS or write OPFS. The saved standard-OPFS prerequisite helper was not checked in that app-origin run. These API observations are not a Native OPFS pass. See [SQLITE_OPFS_BENCHMARK_RESULTS.md](../../docs/learning-system/SQLITE_OPFS_BENCHMARK_RESULTS.md).

SQLite's current official persistence documentation says the standard OPFS VFS uses SharedArrayBuffer and requires COOP/COEP for that path; the SAH-pool path avoids those response headers but does not support multiple simultaneous connections by default. The browser API documentation says `createSyncAccessHandle()` is dedicated-worker-only and a default read/write handle takes an exclusive file lock. These constraints align with the experiment's standard-OPFS isolation setup and observed SAHpool contention, but they do not establish behavior for Obsidian's custom app origin: [SQLite persistence](https://www.sqlite.org/wasm/doc/trunk/persistence.md), [FileSystemFileHandle.createSyncAccessHandle](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createSyncAccessHandle).

## Focused read-only artifact verification

I rechecked the existing source, lean database and pinned archive without changing them. The source and database both reconstruct to the same full ordered logical-record hash; SQLite reports `integrity_check=ok`. This verifies the fixture identity, not OPFS behavior or performance.

| Check | Result |
| --- | --- |
| Compressed Resource-v2 SHA-256 | `b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126` |
| Official SQLite archive SHA3-256 | `87e24f6a4588692310b7942dc2fa7c7275bb9ba2e01d553e4115aa4a904a0050` |
| SQLite database SHA-256 | `f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c` |
| Source and SQLite row counts | 770,611 each |
| Source / SQLite canonical ordered JSONL SHA-256 | `c89eea8a579da1ea743eea9febbe7ecaed63695056d093f2c478b93a265fbd98` (equal) |
| SQLite read-only integrity check | `ok` |

Details are recorded in [receipt.json](receipt.json).

## Cost and viability versus Resource-v3

| Dimension | Current Resource-v3 | SQLite WASM / OPFS prototype |
| --- | --- | --- |
| Stored data and installation | 770,611 entries in 67 content-addressed gzip blocks totaling 16,769,142 bytes. The Native DataAdapter path reads the manifest and one matching verified block for a cold lookup; there is no full-database install before lookup. | A prebuilt SQLite file is 48,779,264 bytes (~2.91× the complete compressed v3 blocks), before runtime assets. The harness fetches, hashes and imports the full database before its first query. A production source/sync/package route has not been implemented or measured. |
| First lookup and warm path | Current async-prewarm DataAdapter samples in the Resource-v3 report: five cold samples per term gave `on` 209.5 ms P50 / 942.6 ms max, `zyzzyva` 191.4 / 233.1 ms, and a valid miss 215.1 / 256.5 ms. Warm P95 was 0.1 ms. These are service timings in an already-running supported Obsidian process, not the complete Reader UI path. | In local Chrome, standard OPFS runtime initialization plus database fetch/hash/import/open/first query summed to 311.8–532.8 ms across five trials; SAHpool summed to 346.8–450.0 ms. Query-only worker round trips were 13.8–19.5 ms and 9.0–11.8 ms respectively. Warm round-trip P95 ranged 2.98–24.4 ms for standard OPFS and 0.2–0.5 ms for SAHpool. Different hosts and timing scopes prohibit a speed ranking. |
| Locking and multiple windows | Reads Vault resource files through the existing adapter and keeps decoded blocks in a bounded in-memory LRU; it does not depend on OPFS file handles or SQLite connection locks. | Standard OPFS passed the localhost second-window/worker check 5/5 with COOP/COEP and COI enabled. Native app-origin COI is false and has no VFS write evidence. SAHpool's second worker failed 5/5 with `NoModificationAllowedError` while another worker owned the file handle. No production singleton broker or arbitration layer exists. |
| Worker and install constraints | A worker decodes a selected block; a cooperative main-thread fallback exists. Existing Resource-v3 install data is already part of the Vault sync layout. No COOP/COEP change is required for the current DataAdapter path. | SQLite JS/WASM and its OPFS worker bootstrap must be shipped and allowed by the app-origin CSP. Standard OPFS has a COOP/COEP/SharedArrayBuffer constraint; SAHpool has unresolved multi-window ownership. The historical run served 2.64–2.69 MB of runtime responses including its second worker. No app security/config change was tested or made. |
| Disk and memory | The complete compressed source is 16.77 MB. A cold lookup reads one matching block; a recorded sample block was 262,366 bytes. The 16-block / 8 MiB decoded-cache default remains provisional; Native cross-block memory use is not established. | Standard OPFS storage estimate increased by 48,779,526 bytes; SAHpool by 144,705,922–144,705,926 bytes. Closed fresh profile directories were about 61.5–61.8 MB, without subtracting an empty-profile baseline. These are browser accounting/profile figures, not physical steady-state cost. CPU and worker/WASM peak memory were **NOT_MEASURED**; main-thread JS heap snapshots do not cover worker/WASM memory. |
| Recovery | The synced, checksummed blocks remain the source of truth. Manifest/range/hash/size validation happens before lookup; a bad or incomplete resource fails as an error instead of returning a false dictionary miss. There is no local SQLite database to rebuild. | In disposable browser trials, close/reopen and query passed; a database image with a corrupted header was rejected or failed integrity validation, then rebuilt from intact fixture bytes and checked for integrity, row count and samples. This test does not cover power loss during import, interrupted replacement, quota eviction, app shutdown or real Sync convergence. Atomic production replacement and rebuild UX remain unimplemented. |
| Code and shipped payload | Resource parser/decoder: 252 LOC; worker: 29; v3 builder: 264; 545 lines combined, plus the existing 240-line dictionary cache used for compatibility/lifecycle behavior. The current direct resource path is already integrated. | The isolated experiment is 1,445 LOC across nine files (812 LOC for the benchmark page/main/worker/runner alone). Production adapter LOC is unknown. Runtime shipping, CSP bootstrap, provenance, atomic updates, quota/eviction recovery, lifecycle, concurrency arbitration, and supported Native/iPad behavior add unestimated implementation and validation cost. LOCs are physical counts including comments/blanks and are not feature-equivalent. |

The earlier local trial set also recorded standard OPFS storage estimate near the file size and SAHpool near three times the database size. Profile totals include browser overhead; do not treat either measure as a physical-device or Native memory estimate. CPU was not instrumented. The cold sums exclude browser launch and navigation-to-result, so they are not complete user-visible first-query times. The exact historical definitions and caveats are in the linked benchmark reports and raw JSONL records.

## Decision and next evidence gate

Resource-v3 remains the lower-cost current implementation: it is already integrated, synchronizes a smaller canonical resource, verifies one block per cold lookup, and does not require an OPFS database bootstrap. Existing Native DataAdapter measurements do not complete the startup-blocking or enabled Reader UI gates, so this audit does not claim Resource-v3 passes every first-query requirement.

SQLite has not shown a paired Native win. Standard OPFS compatibility is unknown in the real Obsidian app origin, and SAHpool's recorded multi-window failure is a release blocker until a design and test demonstrate safe coordination. Before changing this decision, obtain an explicitly disposable Native app-origin profile, verify VFS installation and write/read/reopen there without changing security settings, then measure database install plus first lookup and multi-window behavior against Resource-v3 under equivalent cold states. If the owned profile/origin cannot be established, keep the result **NOT_RUN**; localhost does not substitute for Native.

**No production integration, package change, Vault write, security/config change, or deployment is part of this result.**
