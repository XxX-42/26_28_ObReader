# SQLite OPFS Plan B native-origin experiment — rejected for promotion

The independent SAHpool alternative fails concurrent Worker access on actual `app://obsidian.md` in Obsidian. Retain adaptive blocks/resource-v2 as the current choices; this experiment does not justify integration. Standard OPFS remains unqualified, rather than demonstrated unsupported. There is no production change, deployment, Vault access, main/WAL change, or canonical schema change.

## Owned native origin

`native-owned-experiment.mjs` launches five separate Obsidian processes with fresh ordinary persistent on-disk profiles under this worktree's ignored `tests/output/sqlite-native-owned/profile-*`. Only `app://obsidian.md/starter.html` is used; no Vault is registered or opened. The app reports Obsidian 1.12.7, Electron 39.8.3, Chrome 142.0.7444.265. The previously existing capability probe also ran against a sixth fresh owned starter profile, then that process was closed. All launched processes were closed. This is actual Obsidian origin evidence, not localhost or incognito evidence. It is not a loaded plugin/Reader acceptance run.

Actual page and Blob Worker expose OPFS, sync access handles, Web Locks, SharedArrayBuffer and Atomics. `crossOriginIsolated=false` does not by itself mean SharedArrayBuffer or OPFS are absent in this Electron runtime. SQLite WASM 3.54.1 initializes successfully. Its standard OPFS prerequisite check passes, but that check does not install or test the standard VFS.

The prebuilt DB is the existing frozen lean copy: 770,611 rows, 48,779,264 bytes, expected SHA-256 `f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c`. Runtime and DB were read from the prior d-sqlite artifact directory via an ignored symlink. The runner does not build or modify that fixture.

## Five cold profiles, 100 warm queries

Each fresh process initializes one SAHpool Worker, imports the full prebuilt copy, opens read-only, queries `on` immediately, checks count and integrity, then performs 20 warm exact-key queries. Finally it attempts to initialize a second Worker against the same pool while the first remains open. All raw individual samples and returned rows are committed alongside this report.

| Trial | Runtime init ms | Copy + open ms | First query round trip ms | Warm p50 ms | Warm p95 ms | Count / integrity | Second Worker |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | 192.5 | 72.3 | 34.8 | 0.2 | 1.2 | 770611 / ok | FAIL |
| 2 | 179.4 | 48.1 | 13.6 | 0.2 | 1.2 | 770611 / ok | FAIL |
| 3 | 139.6 | 44.6 | 14.5 | 0.2 | 0.4 | 770611 / ok | FAIL |
| 4 | 147.3 | 55.2 | 14.3 | 0.1 | 0.3 | 770611 / ok | FAIL |
| 5 | 162.2 | 81.7 | 16.3 | 0.2 | 0.5 | 770611 / ok | FAIL |

All five second Workers fail with `NoModificationAllowedError`: another open access handle or writable stream owns the file. This happens at pool initialization before a second reader can query. This independently reproduces the prior ordinary-Chrome SAHpool failure at the actual native origin. A dedicated database broker could change ownership semantics, but no such architecture was implemented or evaluated here.

## Comparison and limits

There is no valid same-harness native ranking against resource-v2 Dexie or adaptive blocks in this report. The correctness gate failed first, so comparator timing runs were not performed. The existing ordinary-Chrome report `SQLITE_OPFS_CHROME_RUNS_2026-10-23.md` is contextual evidence only and is not promoted to Native evidence. No claim is made that SQLite loses native latency to either comparator.

The recorded coldStartToResultMs values (3709.9–3942.0 ms) include main-thread base64 decoding of the DB, CDP-provided asset delivery and Worker startup. That is a benchmark transport cost, not a production loader estimate. The narrower stage durations above exclude asset transport and cannot be summed into end-to-end user latency. Runtime init begins inside Worker after its JS has loaded; it includes WASM base64 decoding, compilation and VFS installation. Copy/open begins after the transferred buffer arrives. Warm queries include Worker scheduling. OS caches were not flushed; cold means fresh browser process/profile/storage, not cold physical disk.

Only concurrent Workers in one native starter window were tested in this new run. An actual second Obsidian window, popout lifecycle, lock recovery after crash, corruption/rebuild, unloaded/reloaded plugin behavior, memory/CPU and iPad WKWebView were not tested. A same-window lock conflict is enough to reject the tested independent-Worker ownership design, but does not establish every multi-window design is impossible. Standard OPFS still requires an owned-profile VFS installation and actual two-window experiment, followed by paired resource-v2/adaptive timing if it passes. The prior localhost standard OPFS successes do not fill that gap.

Reproduce after supplying the existing ignored pinned runtime/database artifacts and installing dependencies:

```sh
node scripts/sqlite-opfs/native-owned-experiment.mjs
```

Validation: runner completed all five declared loop iterations without retry; 5/5 count/integrity checks passed; 100/100 warm samples were retained; 5/5 second-Worker failures were retained. `node --check` and `git diff --check` pass. Branch is benchmark-only and should not be merged into production as a storage alternative.

## Later standard-VFS follow-up

`SQLITE_OPFS_NATIVE_STANDARD_2026-10-24.md` records the subsequent non-SAHpool experiment: five final fresh native profiles, 100 warm queries, and five successful real second-native-window concurrent read probes. It supersedes this report's earlier standard-VFS-unqualified status for that narrow read-only native-origin capability only. The SAHpool rejection and its samples remain valid. No paired resource-v2/adaptive performance comparison exists, so Plan B remains unselected.
