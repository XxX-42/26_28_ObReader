# SQLite OPFS: ordinary Chrome experiment, 2026-10-23

This is a localhost experiment in Chrome 155.0.8059.85, SQLite WASM 3.54.1, with five fresh normal persistent profiles per VFS and 20 warm queries per trial. It is not an Obsidian app:// or Native result and makes no production replacement recommendation. No Vault, production loader, security setting, vendor, bridge, or WAL was changed.

## Fixture and reproducibility

Lean prebuilt SQLite: 770,611 rows, 48,779,264 bytes; SHA-256 `f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c`. Canonical ordered logical JSONL SHA-256: `c89eea8a579da1ea743eea9febbe7ecaed63695056d093f2c478b93a265fbd98`. The old 151 MB duplicate-payload prototype was not used. Runtime and fixture were read from ignored d-sqlite artifacts through a symlink; no large artifacts were added to Git.

Run from `/Users/jiajia/.codex/worktrees/obreader-0.14/sqlite-sol-low`:

```sh
node scripts/sqlite-opfs/run-cold-benchmark.mjs --output tests/output/sqlite-opfs --chrome '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' --run
```

Raw run plans, every JSONL trial, and all normal profiles remain under that worktree's ignored `tests/output/sqlite-opfs/`. Run-set identifiers:

- Initial: `2026-10-23T14-20-11-567Z-5ae98f48-52e5-4fd6-b165-2078e406ffd1`.
- Corrected proxy route: `2026-10-23T14-20-58-005Z-af659051-3a7c-4d9b-9a69-03bae2780315`.

Both complete ten-trial sets are retained; no failed trials were removed or replaced within a set. Before the initial set, the worker gained an explicit fetch/compile/instantiateWasm hook and `__isUnderTest` to retain official diagnostic import/unlink helpers. Initial standard OPFS failed 5/5 before import because the runtime proxy URL lacked `/runtime`. Explicit `sqlite3.dir=/runtime` fixed the route for the second full set. The initial SAHpool records say top-level PASS but all five contain secondaryConnection FAIL. The corrected harness now includes that failure in top-level status. These initial failures are harness/locking evidence, not discarded warm-up trials.

## Corrected full set

| Check | Standard OPFS | SAHpool |
| --- | --- | --- |
| Complete trial | 5/5 PASS | 0/5 PASS |
| Single worker DB checks | 5/5 PASS | 5/5 PASS |
| Fresh profile / process | 5 | 5 |
| Warm exact queries recorded | 100 | 100 |
| Count / integrity / 5 exact rows / missing key | PASS | PASS |
| Close / reopen / immediate reopened query | PASS | PASS |
| Header corruption detection / rebuild / count / sample / cleanup | PASS | PASS |
| Second window + worker, primary remains open | 5/5 PASS | 5/5 FAIL |
| Worker crossOriginIsolated | true (local COOP/COEP) | false |

SAHpool's second worker cannot acquire a SyncAccessHandle while the primary owns one: `NoModificationAllowedError: Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file.` The failure occurs during pool initialization. It does not invalidate the separately recorded single-worker query and rebuild results, but prevents declaring complete acceptance.

All timings below are the minimum–maximum of five per-trial values, milliseconds. First exact-key query ran immediately after initial open, before integrity/count/sample scans. Warm latencies are worker round-trip wall times and include message scheduling. Zero/submillisecond values are limited by browser clock resolution.

| Metric | Standard OPFS | SAHpool |
| --- | ---: | ---: |
| SQLite runtime init | 72.680–249.535 | 113.6–158.1 |
| Prebuilt import | 15.305–32.425 | 14.7–19.3 |
| Initial open | 3.985–6.535 | 2.6–8.4 |
| First query, worker | 13.800–19.475 | 9.0–11.8 |
| First query, round trip | 14.020–19.600 | 9.1–12.0 |
| Warm p50 | 0.965–1.855 | 0.1–0.2 |
| Warm p95 | 2.980–24.400 | 0.2–0.5 |
| Warm maximum | 53.400–121.785 | 0.4–1.1 |
| Reopen | 0.775–1.690 | 0.1–0.5 |
| Rebuild import | 13.210–15.185 | 14.4–17.7 |
| Main-thread Long Tasks total | 53–80 | 0–74 |

| Byte metric | Standard OPFS | SAHpool |
| --- | ---: | ---: |
| Served runtime bytes, including second worker | 2,687,380 | 2,638,324 |
| Served DB bytes, initial + corruption/rebuild fixture fetch | 97,558,528 | 97,558,528 |
| Storage estimate usage delta | 48,779,526 | 144,705,922–144,705,926 |
| Closed profile directory bytes | 61,690,389–61,825,073 | 61,527,911–61,533,161 |

Storage estimates are browser accounting snapshots before terminating the main worker; they are not identical to physical file sizes or post-cleanup steady-state size. Profile bytes are the resulting fresh-profile footprint, with no empty-profile baseline subtraction. Reported runtime bytes are server response-body sizes, not wire headers or compressed network cost. Raw logs include individual query times, optional main-page JS heap snapshots, requests, all failures, and per-trial profiles.

CPU time was not measured: inspection found no CPU instrumentation in this harness. Wall times and Long Tasks must not be presented as CPU time. Main-page heap snapshots also do not measure worker/WASM memory. No Native compatibility conclusion follows from these ordinary-Chrome results.

Validation: both scripts passed `node --check`; `git diff --check` passed; both actual predeclared ten-trial sets completed. All large evidence remains outside Git.
