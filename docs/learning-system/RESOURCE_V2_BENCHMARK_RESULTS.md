# Resource-v2 benchmark evidence (2026-10-22)

## Protocol 1 stopped: shared-origin failure residue

Run set `2026-10-22T14-28-43-552Z-5e55c12f-4d15-41f7-bd6e-415e81371692` predeclared all 20 trials before launch. Trials 1, 3, 4, and 5 failed the unchanged Puppeteer 180-second protocol deadline. Trial 2 passed. Trial 6 auto-started before isolation inspection completed and was interrupted; trials 7–20 are NOT_RUN. No failed trial was retried, no timeout was extended, and no production optimization was applied.

Read-only `indexedDB.databases()` inspection found the failed trials' separate database names retained in the same origin/profile (01, 03, 04, 05), while successful trial 02 was absent. Trial 06 had also started. `navigator.storage.estimate()` reported 519,043,134 bytes of IndexedDB origin usage. This proves failure cleanup did not isolate the backing store across trials; it does not prove residue caused a specific slowdown. Results from this set cannot support a cold-performance comparison. Browser PID 41116 and benchmark owner PID 7136 exited after stopping the owned harness; no user cache was touched.

Worker observations showed advancing imports, not a deadlock, with one active page worker per sample and a new blob URL across navigation. For example, trial 3 reached 232,000 rows with bulkPut 80,988.5 ms and import transactions 82,485.3 ms; trial 4 reached 492,000 rows with bulkPut 130,597.8 ms and import transactions 133,962.6 ms. A failure is censored at the protocol deadline: its full-ready, final count, and complete pipeline metrics are unavailable.

The single passing baseline trial is descriptive evidence only:

| Metric | Trial 2 result |
| --- | ---: |
| First lookup / full-ready | 179,137 / 179,128.5 ms |
| readBinary | 216.1 ms; 16,734,703 bytes |
| SHA-256 | 20.6 ms; 16,734,703 bytes |
| gzip reader time / output | 275.7 ms; 69,667,588 bytes |
| JSON.parse / record payload | 1,196.3 ms; 68,896,977 bytes; 770,611 records |
| bulkPut | 162,971.0 ms; 770,611 rows; 193 transactions |
| Membership get / put | 1,229 / 1,229 calls; 9,599,172 / 19,698,961 key-payload bytes |
| Membership cumulative time | 2,419.3 ms (inside the 193 import transactions) |
| Final count / ready transaction | 4,983.6 / 4,989.4 ms; count 770,611; 4-byte result |
| Reopened first / warm p95 | 22.1 / 2.2 ms; zero gzip reads |
| Main-thread heap before / after ready / after queries | 3,592,480 / 2,509,138 / 3,830,165 bytes |
| Main-thread Long Tasks | API available; zero observed |

No worker heap or physical IndexedDB I/O bytes are claimed. Warm OS filesystem caching was not flushed. Main-thread heap excludes worker memory. BulkPut dominated this observation; no membership-tail improvement has been established.

## Protocol 2 rejected; protocol 3 proposal

An intermediate source proposal used a fresh BrowserContext, with finally-close on timeout. Root rejected it before execution: Chromium off-record contexts can change IndexedDB backing to memory, making comparison against ordinary persistent profiles invalid. Protocol 2 is NOT_RUN. See Chromium's [IndexedDB documentation](https://chromium.googlesource.com/chromium/src/+/master/content/browser/indexed_db/docs/README.md). No performance gain is claimed from incognito storage.

Protocol 3 uses a fresh owned ordinary Chrome `userDataDir` and a new browser per trial, closing the entire browser in `finally` on success, timeout, and page setup failure. The default context persists IndexedDB to disk; 30-second observations record actual profile `Default/IndexedDB` file names and sizes without reading database contents. Temporary benchmark profiles are retained rather than recursively deleted. Each trial still gets a unique database, disabled HTTP cache, and no-store responses. The exact declared 5×4 order and unchanged 180-second protocol deadline remain. Uniform 30-second worker-stage snapshots retain partial diagnostic evidence without IDB scans. A new complete 20-trial plan must be written before launching; it is a new experiment, not a replacement selection of passing trials. Protocol 3 is NOT_RUN pending root review and a new heavy/browser lease.

## Actual 25,000-record baseline

`node --test tests/vocabulary-transfer-large.test.mjs` passed 1/1 on the current isolated branch. These are current measurements, independently matching the historical total write count rather than borrowing it. Import 21,534.49 ms; complete fixture/export/preview/import/verification/history-preview path 57,383.73 ms. The adapter is an in-memory contract fixture, not physical Vault disk I/O.

| Import path category | Read bytes | Written bytes |
| --- | ---: | ---: |
| History | 58,403,996 | 14,600,999 |
| Pending intent | 37,429,154 | 37,429,154 |
| Other | 27,501,585 | 5,500,372 |
| Total | 123,334,735 | 57,530,525 |

Import used 18 reads, 5 writes, 4 renames, 1 removal, and zero appends. Final bundle was 8,650,813 bytes; all 25,000 records and reversible lifecycle changes were preserved. History preview read 20,101,371 bytes and wrote zero.

The in-memory compact-envelope prototype preserved every History field but grew from 14,600,999 to 15,364,917 bytes (+763,918). Its grouping included unique fieldPath values and therefore produced 25,000 templates. This particular prototype offers no byte saving. History and transaction formats remain frozen; a future better grouping would need separate validation and authorization before format adoption.

## Artifacts and checks

Raw resource and JSON/log artifacts stay ignored under `tests/artifacts/` and `tests/output/dictionary-resource-benchmark-20261022/`. The frozen public resource was copied only from the prior isolated test artifact; compressed SHA-256 was verified as `b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126`. No production Vault, deployment, push, or schema change occurred.

Support tests passed 4/4, including fresh-browser lifecycle success/timeout/setup-failure cleanup, variant bundle construction, cancellation/resume membership correctness, corrupt forced-replacement preservation, and expired-owner lease fencing. The lifecycle test uses a mock browser factory with isolated storage maps; real profile disk backing still requires protocol 3's browser run. Revised harness syntax and `git diff --check` passed. Protocols 2 and 3 have not run.
