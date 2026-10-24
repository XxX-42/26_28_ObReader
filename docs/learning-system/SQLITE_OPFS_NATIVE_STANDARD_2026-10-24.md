# Standard SQLite OPFS native-origin follow-up

The standard (non-SAHpool) OPFS VFS installs and reads the frozen prebuilt dictionary on actual `app://obsidian.md` in five fresh ordinary persistent Obsidian profiles. The final five-trial set also passes a real second-native-window concurrent read probe. This does not select Plan B: results are unpaired with resource-v2 Dexie/adaptive blocks.

The rejected SAHpool experiment and all its samples remain unchanged. This follow-up touches benchmark scripts and evidence only; it opens the native starter page without registering or opening a Vault. The ordinary Chrome results remain ordinary Chrome evidence.

## Initial five-trial set

The complete predeclared set is retained under `evidence/sqlite-opfs-native-2026-10-24/standard-initial`. All five trials successfully install the actual standard `opfs` VFS, copy/open the prebuilt 48,779,264-byte database, return the first `on` lookup, validate 770,611 rows and `integrity_check=ok`, and record 20 warm queries each. The fixture SHA-256 is checked by the runner before launching any application. No failed trial is dropped.

| Trial | Init ms | Copy/open ms | First query round trip ms | Warm p50 ms | Warm p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 166.5 | 82.3 | 17.4 | 1.1 | 1.5 |
| 2 | 114.6 | 88.4 | 28.0 | 1.6 | 2.9 |
| 3 | 131.2 | 69.4 | 22.0 | 1.0 | 1.4 |
| 4 | 122.0 | 79.5 | 25.6 | 0.9 | 1.8 |
| 5 | 110.9 | 83.3 | 26.8 | 1.1 | 1.5 |

Each trial then failed at the harness's attempt to create a second window: Electron returns `Protocol error (Target.createTarget): Not supported`. These are incomplete trials, not complete locking PASSes. Standard OPFS is demonstrably available; concurrent native-window acceptance remains unproven by this set.

The next complete five-trial set attempted native `window.open`; all five retained `standard-window-open` records time out because the starter page produces no second target. A preliminary invocation of that implementation was interrupted on the coordinator's request to avoid contaminating a separate race gate; the interrupted invocation has no completed sample and is not timing or VFS failure evidence. After the coordinator resumed Native work, the full five-trial set was performed. The third complete set successfully created a real native window through the existing Electron remote API but hit the unavailable CDP `Browser.getWindowForTarget` method before testing the secondary Worker. All five `standard-nativewindow-cdp` records retain that harness failure. These earlier complete sets are not silently replaced or counted as locking PASSes.

## Final real-window set

The final predeclared five-trial set uses the existing Electron remote `BrowserWindow` API to create a visible second native window with exactly inherited native webPreferences and the same owned persistent session. Both windows load only the native starter page. Distinct native `BrowserWindow.id` values (1 and 2 in each fresh process) and identical session storage paths are recorded. No off-record context is created.

Each primary remains open while a second window's independent Worker initializes the standard VFS, opens the same database read-only and queries it. The runner then dispatches queries to both windows concurrently and checks the primary again after the secondary operation. All five secondary opens/queries, all ten concurrently dispatched query results and all five primary-after-secondary results return the expected `on` row. Every primary validates count 770,611 and integrity `ok`; all 100 warm queries return `on`. The second-window first query takes 22.2–46.9 ms inside its Worker; secondary open takes 5.8–11.8 ms.

| Final trial | Init ms | Copy/open ms | First query round trip ms | Warm p50 ms | Warm p95 ms | Second native window |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 208.8 | 92.1 | 42.1 | 2.9 | 3.5 | PASS |
| 2 | 176.1 | 97.4 | 43.1 | 2.2 | 3.2 | PASS |
| 3 | 176.9 | 73.6 | 28.3 | 2.2 | 4.0 | PASS |
| 4 | 229.8 | 162.8 | 53.9 | 2.9 | 4.8 | PASS |
| 5 | 222.2 | 81.7 | 45.7 | 2.0 | 3.1 | PASS |

Raw samples and the plan are in `standard-final`. This establishes that the tested standard VFS can coordinate two read-only native windows on this runtime, in contrast to the retained SAHpool independent-Worker failure. It does not test a held explicit SQL transaction, competing writer, failure recovery or the production Obsidian popout lifecycle. A real Electron window at the native origin is tested; an Obsidian Vault/popout is deliberately not opened. All owned application processes were closed after the set.

## Prototype packaging and scope

The pinned official SQLite WASM is 3.54.1. Its standard OPFS VFS expects an async proxy Worker URL with `?vfs=opfs`. A Blob URL rejects appended query strings. This isolated prototype adapts only script packaging: it replaces the default proxy URI with an owned Blob URL, strips that query at Worker construction, and supplies the identical known `vfs=opfs` parameter inside the proxy's URL-argument parsing seam. The VFS, SQL, locking implementation, WASM and database are unchanged. The replacement seams are checked for uniqueness before use. This does not prove production asset loading; a production integration would require a separately reviewed native asset route.

The app reports Obsidian 1.12.7/Electron 39.8.3/Chrome 142.0.7444.265, secure `app://obsidian.md`, SharedArrayBuffer available and `crossOriginIsolated=false`. No COOP/COEP headers, Chromium security flags or application settings were changed. The fresh profiles may perform Obsidian's default update check; this uncontrolled background activity is another reason not to compare these timings to separately retained browser resource benchmarks.

Cold means a new process and ordinary on-disk profile with empty origin storage. OS caches are not flushed. `coldStartToResultMs` includes the artificial CDP/base64 database delivery path and is not a product latency measurement. The narrower stage durations exclude that transport. Worker initialization includes runtime/WASM setup and actual OPFS VFS installation; copy/open includes the database import and initial read-only open. First/warm query round trips include Worker scheduling. Memory, CPU, crash recovery and real iPad were not measured. The starter origin is actual native app-origin evidence, but no plugin/Reader or Vault behavior is validated.

Run the follow-up with the existing ignored pinned artifacts and dependencies available:

```sh
node scripts/sqlite-opfs/native-standard-owned-experiment.mjs
```

Results go to ignored `tests/output/sqlite-native-standard-final-owned`. The retained initial run used the preceding Target.createTarget implementation and output directory `sqlite-native-standard-owned`; its raw errors preserve that distinction. Syntax and diff checks pass. Independent raw-data assertions verified all five final validations, all 100 warm row keys, all secondary/concurrent row keys, separate native window IDs and shared persistent session identity. No same-setup resource-v2/adaptive A/B exists, so Plan B remains unselected.
