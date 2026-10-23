# SQLite WASM / OPFS benchmark workstream D (2026-10-23)

## Status

**LEAN OFFLINE FIXTURE VERIFIED. APP-ORIGIN READ-ONLY SQLITE INIT ATTEMPT WAS INVALIDATED BY A PROBE LOADER BUG; THE FIX PASSES A LOCAL ISOLATED CHROME CHECK BUT STILL NEEDS A SAFE APP-ORIGIN RETRY. FIVE-COLD RUNNER IMPLEMENTED BUT NOT STARTED pending a separate benchmark lease.** No performance result or production recommendation is claimed.

This is a benchmark-only experiment. It makes no production dependency, main, bridge, vocabulary-canonical, WAL, schema, or Vault changes. The prototype and lean SQLite files, source copy, pinned SQLite archive, and generated build reports are ignored under `tests/artifacts/sqlite-opfs-2026-10-23/`; only the reproducible Python/Node tooling and report are tracked. The cold-run harness uses only the lean database.

## Frozen input and equivalence

The input was copied from the `ObReader-Apple-Test` resource-v2 directory at `00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v2/`. The compressed source is 16,734,703 bytes, has SHA-256 `b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126`, and expands to 69,667,588 bytes and 770,611 entries.

`build-fixture.py` builds the benchmark database offline with Python's standard-library `sqlite3`; the browser benchmark never issues 770,611 inserts. The lean table is `entries(key TEXT PRIMARY KEY COLLATE BINARY, translation TEXT NOT NULL, phonetic TEXT NOT NULL) WITHOUT ROWID`. It does not store an ordinal or a second copy of each row as JSON. The builder validates the frozen source digest, rejects unexpected fields, non-string values, duplicate or unsorted keys, checks SQLite integrity, then reconstructs canonical compact JSONL from the three columns ordered by key and hashes all rows. The first 151 MB database with the duplicate payload is retained as prototype evidence only and is not used by the runner.

`verify-normalized-v2.mjs` checks each input key with the product's `normalizeDictionaryKey`, requires the resource-v2 field order and compact JSON serialization, and compares the hash to the SQLite ordered readback. The compressed-resource digest and the logical normalized-record digest are different measurements and are reported separately:

| Evidence | Result |
| --- | ---: |
| Compressed resource SHA-256 | `b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126` |
| Normalized v2 JSONL / lean SQLite reconstructed readback SHA-256 | `c89eea8a579da1ea743eea9febbe7ecaed63695056d093f2c478b93a265fbd98` |
| Source and SQLite rows | 770,611 each |
| Prototype database bytes (duplicate `row_json` and ordinal; not benchmarked) | 151,461,888 |
| Lean benchmark database bytes (`WITHOUT ROWID`, three fields only) | 48,779,264 |
| Lean benchmark database SHA-256 | `f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c` |
| SQLite `integrity_check` | `ok` |
| Lean fixture build wall time | 6,601 ms (one local offline build, not a comparative benchmark) |

The lean fixture is 67.8% smaller than the prototype fixture. This is a file-size comparison only, not a browser copy-time or performance claim.

Five exact query rows (`on`, `mostly`, `subscription`, `details`, `about`) and one absent key are saved in the ignored fixture report for browser-side correctness checks. The full-row equivalence check is the ordered 770,611-row logical hash, not a sample-only comparison.

## Pinned runtime and notices

The official SQLite download `sqlite-wasm-3540100.zip` (SQLite 3.54.1) was acquired from `https://www.sqlite.org/2026/sqlite-wasm-3540100.zip`. Its SHA3-256 is `87e24f6a4588692310b7942dc2fa7c7275bb9ba2e01d553e4115aa4a904a0050`, matching the official [SQLite download page](https://www.sqlite.org/download.html). The untracked archive and extracted `jswasm/` assets are retained under the ignored artifact directory for local experimental use only; the plugin bundle and package manifests do not include them.

The preserved SQLite JavaScript/WASM bundle contains its SQLite public-domain notice and Emscripten MIT / University of Illinois-NCSA notice; a copy of that notice is retained beside the ignored archive. The copied ECDICT MIT license is also retained with the ignored source fixture.

SQLite's official [OPFS documentation](https://www.sqlite.org/wasm/doc/trunk/persistence.md) describes standard `opfs` as worker- and SharedArrayBuffer-backed, and `opfs-sahpool` as an alternative with limited concurrent-connection support by default. The Apple-Test app-origin renderer reports `crossOriginIsolated=false` while still exposing `SharedArrayBuffer`; this Electron-specific combination means COI alone does not classify the host. The read-only probe records these facts, tests a minimal Blob worker, and attempts pinned SQLite WASM initialization with automatic OPFS VFS installation disabled. It never opens a database or writes to OPFS. VFS installation and write/copy benchmarks remain separate steps.

## Harness and cold-run protocol

`capability-probe.mjs` connects to an existing owned Obsidian CDP endpoint and selects exactly one existing `app://obsidian.md` page. It first runs a minimal Blob Worker echo, then attempts pinned SQLite WASM initialization in a temporary Blob Worker. The worker URL must remain the exact Blob URL; adding a query suffix invalidates it. The probe disables VFS auto-installation before loading SQLite and supplies an explicit Emscripten `instantiateWasm` callback over pinned bytes, captures intermediate worker messages and CSP violation events, and opens no database. It never installs a VFS, writes OPFS files, navigates, or closes the app. Output is ignored under `tests/output/sqlite-opfs/`.

### Actual Apple-Test app-origin evidence

The target was `app://obsidian.md/index.html` in the owned Apple-Test Obsidian renderer (Electron 39.8.3 / Chromium 142). The first requested endpoint, `127.0.0.1:64276`, refused the connection before any page inspection. The endpoint `127.0.0.1:65046` was then used during B's explicit safe UI pause; CDP disconnected cleanly without navigating or closing the app.

| App-origin observation | Result |
| --- | --- |
| Secure context / WebAssembly / Worker constructor | `true` / `true` / available |
| Main-thread OPFS getter / Web Locks | available / available |
| Main-thread SharedArrayBuffer / `crossOriginIsolated` | available / `false` |
| Storage estimate / persisted | quota about 63.11 GB, usage 115,608,340 bytes (IndexedDB reported) / `true`; estimate is transient |
| Minimal exact-Blob Worker echo | PASS; worker reports secure context, WASM, SAB, OPFS getter, sync access handles, Locks; no `securitypolicyviolation` events |
| First SQLite Blob Worker attempt | HARNESS ERROR: it appended `?opfs-disable&opfs-wl-disable` to a Blob URL; this invalidated the worker URL and is not platform evidence |
| App-origin SQLite WASM attempt using `wasmBinary` alone | timed out after 15 seconds without a ready/error message; no database or OPFS mutation occurred. This attempt did not correctly bypass SQLite's script-relative Emscripten loader and is not host capability evidence. |
| Loader diagnosis in isolated ordinary Chrome | reproduced the hang after the `before-init-call` stage. SQLite's official `sqlite3.js` installs a custom `instantiateWasm` hook that fetches `sqlite3.wasm` relative to the Blob worker URL, overriding `wasmBinary` alone. Supplying the supported `instantiateWasm(imports, onSuccess)` callback with pinned bytes initialized SQLite 3.54.1 and listed core VFSes; no database or OPFS files were created. This local result is harness debugging evidence, not app-origin evidence. |
| Corrected app-origin SQLite probe | NOT_RUN after loader fix; requires another coordinated safe checkpoint. Probe classification defaults to unresolved and no longer labels a missing worker result unsupported. |
| Native `opfs` / `opfs-sahpool` VFS installation or write probe | NOT_RUN; no support/unsupported conclusion yet |

The minimal worker success rules out a generic Blob Worker or observed CSP prohibition. The app-origin 15-second SQLite attempt failed because the probe supplied bytes but did not override SQLite's script-relative loader. The isolated local test confirms the fix, but says nothing about app-origin SQLite or VFS support. Preserve the failed attempt at ignored `tests/output/sqlite-opfs/host-capability-corrected-20261023.json`; rerun the corrected probe only during another explicitly coordinated safe checkpoint.

`predeclare-runs.mjs` writes a ten-row plan for five fresh processes/profiles per option. `run-cold-benchmark.mjs` is the runnable isolated normal-Chromium harness, using persistent user-data directories rather than incognito. Without `--run` it creates a plan only; `--run` launches ten fresh Chromium processes/profiles on a local test origin. The local `opfs` origin adds COOP/COEP headers only to that test server; the `opfs-sahpool` origin does not. The harness does not access Obsidian or any Vault, and its results cannot establish app-origin support.

The browser phases record:

- JS/WASM load and initialization, VFS setup, runtime bytes, available main-thread memory, and main-thread Long Tasks;
- prebuilt database fetch/copy/hash/import times and bytes, storage-usage delta, and profile-directory growth;
- open, first exact-key query, 20 warm query latencies, missing-key behavior, close/reopen, and reopened first query;
- a second real browser-window/worker concurrent-open attempt while the first connection remains open;
- corrupt the first header byte in a separate disposable database image, record detection during import/open/integrity check, rebuild from intact prebuilt bytes, and verify post-rebuild integrity/count/sample rows.

The plan keeps all failures and timeouts in order, forbids retries or selected passes, and never writes to a production Vault. It records unavailable memory and Long Task metrics as `null`. No cold trial may start until root grants the dedicated benchmark lease. iPad/WKWebView is deferred, and even a repeatable SQLite win would not replace the current production cache in this round.

## Checks and outcomes

| Check | Result |
| --- | --- |
| Copy frozen resource-v2 from test Vault and verify compressed SHA-256 | PASS |
| Build offline SQLite fixture, count rows, run `integrity_check`, and hash full ordered readback | PASS |
| Verify keys with product v2 normalization and compare canonical JSONL to full SQLite readback | PASS |
| `node --check` for the app-origin probe, logical equivalence verifier, and predeclaration tool | PASS |
| `node --check` for isolated benchmark page, worker, and runner | PASS |
| Python syntax check for offline fixture builder | PASS |
| Actual app-origin API probe on Apple-Test CDP 65046 | PASS; facts above |
| Actual app-origin minimal Blob Worker echo | PASS; no CSP violations |
| App-origin SQLite WASM probe with previous loader implementation | TIMED_OUT at 15 seconds; harness bug identified, no host capability conclusion |
| Corrected SQLite loader in isolated ordinary Chrome | PASS; initialized pinned version 3.54.1; no database or OPFS activity; not app-origin evidence |
| Corrected app-origin SQLite WASM initialization | NOT_RUN; awaiting safe checkpoint |
| Standalone Chromium runner plan-only mode | PASS; wrote a ten-row plan and started no browser/trials |
| `opfs` five fresh-process cold trials / 20 warm queries each | NOT_RUN; no benchmark lease |
| `opfs-sahpool` five fresh-process cold trials / 20 warm queries each | NOT_RUN; no benchmark lease |
| Second-window reader, close/reopen, and disposable-copy corrupt/rebuild trials | NOT_RUN; cold benchmark pending |

Reproduction commands (the source defaults to the test Vault path if copied into artifacts first):

```sh
python3 scripts/sqlite-opfs/build-fixture.py \
  tests/artifacts/sqlite-opfs-2026-10-23/resource-v2/entries.b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126.jsonl.gz \
  tests/artifacts/sqlite-opfs-2026-10-23/ecdict-v2-lean.sqlite \
  --report tests/artifacts/sqlite-opfs-2026-10-23/fixture-report-lean.json
node scripts/sqlite-opfs/verify-normalized-v2.mjs \
  tests/artifacts/sqlite-opfs-2026-10-23/resource-v2/entries.b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126.jsonl.gz \
  tests/artifacts/sqlite-opfs-2026-10-23/fixture-report-lean.json
node scripts/sqlite-opfs/capability-probe.mjs --cdp-url "$OWNED_OBSIDIAN_CDP_URL"
node scripts/sqlite-opfs/predeclare-runs.mjs
node scripts/sqlite-opfs/run-cold-benchmark.mjs --output tests/output/sqlite-opfs
# Only after a dedicated benchmark lease is granted:
node scripts/sqlite-opfs/run-cold-benchmark.mjs --output tests/output/sqlite-opfs --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --run
```
