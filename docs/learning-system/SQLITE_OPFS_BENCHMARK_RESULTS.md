# SQLite WASM / OPFS benchmark workstream D (2026-10-23)

## Status

**OFFLINE FIXTURE VERIFIED. APP-ORIGIN CAPABILITY PROBE: NOT_RUN while the native acceptance lease owns CDP 60096. COLD BENCHMARKS: NOT_RUN pending release of that lease and a separate benchmark lease.** No performance result or production recommendation is claimed. Return this workstream to the queue after the native acceptance owner releases its profile.

This is a benchmark-only experiment. It makes no production dependency, main, bridge, vocabulary-canonical, WAL, schema, or Vault changes. The 151 MB SQLite file, source copy, pinned SQLite archive, and generated build report are ignored under `tests/artifacts/sqlite-opfs-2026-10-23/`; only the reproducible Python/Node tooling and report are tracked.

## Frozen input and equivalence

The input was copied from the `ObReader-Apple-Test` resource-v2 directory at `00_Archive/21_VocabularyData/dictionaries/ECDICT/resource-v2/`. The compressed source is 16,734,703 bytes, has SHA-256 `b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126`, and expands to 69,667,588 bytes and 770,611 entries.

`build-fixture.py` builds the database offline with Python's standard-library `sqlite3`; the app benchmark never issues 770,611 inserts. The table stores an ordinal, the exact normalized key, translation, phonetic value, and compact JSON for the full resource row. The builder reads every row, rejects unexpected fields, non-string values, duplicate or unsorted keys, and validates the SQLite integrity check. It then reads the full JSON payload back in source order and hashes the result.

`verify-normalized-v2.mjs` checks each input key with the product's `normalizeDictionaryKey`, requires the resource-v2 field order and compact JSON serialization, and compares the hash to the SQLite ordered readback. The compressed-resource digest and the logical normalized-record digest are different measurements and are reported separately:

| Evidence | Result |
| --- | ---: |
| Compressed resource SHA-256 | `b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126` |
| Normalized v2 JSONL / SQLite ordered readback SHA-256 | `c89eea8a579da1ea743eea9febbe7ecaed63695056d093f2c478b93a265fbd98` |
| Source and SQLite rows | 770,611 each |
| SQLite database bytes | 151,461,888 |
| SQLite database SHA-256 | `9d6f24efe39fb34e8911c5ea0c9a17a253081b78ce5e644ed593479759a8460e` |
| SQLite `integrity_check` | `ok` |
| Build wall time | 6,260 ms (one local fixture build, not a comparative benchmark) |

Five exact query rows (`on`, `mostly`, `subscription`, `details`, `about`) and one absent key are saved in the ignored fixture report for browser-side correctness checks. The full-row equivalence check is the ordered 770,611-row logical hash, not a sample-only comparison.

## Pinned runtime and notices

The official SQLite download `sqlite-wasm-3540100.zip` (SQLite 3.54.1) was acquired from `https://www.sqlite.org/2026/sqlite-wasm-3540100.zip`. Its SHA3-256 is `87e24f6a4588692310b7942dc2fa7c7275bb9ba2e01d553e4115aa4a904a0050`, matching the official [SQLite download page](https://www.sqlite.org/download.html). The untracked archive and extracted `jswasm/` assets are retained under the ignored artifact directory for local experimental use only; the plugin bundle and package manifests do not include them.

The preserved SQLite JavaScript/WASM bundle contains its SQLite public-domain notice and Emscripten MIT / University of Illinois-NCSA notice; a copy of that notice is retained beside the ignored archive. The copied ECDICT MIT license is also retained with the ignored source fixture.

SQLite's official [OPFS documentation](https://www.sqlite.org/wasm/doc/trunk/persistence.md) says standard `opfs` requires a worker and SharedArrayBuffer, which depends on COOP/COEP isolation; `opfs-sahpool` can work without those headers but does not support concurrent connections to a database by default. The app-origin probe therefore records actual worker APIs, secure-context status, cross-origin isolation, storage estimates, and SQLite WASM initialization. It does not change headers or install the SAH pool. A SAH-pool candidate requires a later disposable-profile write probe before it is classified as usable.

## Harness and cold-run protocol

`capability-probe.mjs` connects to an existing owned Obsidian CDP endpoint, selects exactly one existing `app://obsidian.md` page, and runs a temporary Blob worker there. It loads the pinned SQLite JS/WASM code with automatic OPFS VFS installation disabled, checks worker/storage/WASM APIs, and tears down the worker and CDP connection. It opens no database, installs no SAH pool, writes no OPFS files, and does not navigate or close the app. Its default output is ignored at `tests/output/sqlite-opfs/host-capability.json`.

`predeclare-runs.mjs` writes the complete 10-row trial plan before execution: five fresh ordinary Obsidian processes and profiles for `opfs`, followed by five for `opfs-sahpool`. Each profile/process is an independent cold trial. The planned browser harness phases record:

- JS/WASM load and initialization, VFS setup, runtime bytes, available main-thread memory, and main-thread Long Tasks;
- prebuilt database read/copy/hash/import times and bytes, storage-usage delta, and profile-directory growth;
- open, first exact-key query, 20 warm query latencies, missing-key behavior, close/reopen, and reopened first query;
- a second-window/worker concurrent-open attempt while the first connection remains open;
- corruption detection on a disposable OPFS copy, rebuild from the intact prebuilt database, and post-rebuild count/hash/sample checks.

The plan keeps all failures and timeouts in order, forbids retries or selected passes, and never writes to a production Vault. It records API-unavailable memory and Long Task metrics as `null`. For each option, no cold trial may start until the native browser owner releases CDP 60096 and root grants a dedicated benchmark lease. iPad/WKWebView is deferred, and even a repeatable SQLite win would not replace the current production cache in this round.

## Checks and outcomes

| Check | Result |
| --- | --- |
| Copy frozen resource-v2 from test Vault and verify compressed SHA-256 | PASS |
| Build offline SQLite fixture, count rows, run `integrity_check`, and hash full ordered readback | PASS |
| Verify keys with product v2 normalization and compare canonical JSONL to full SQLite readback | PASS |
| `node --check` for the app-origin probe, logical equivalence verifier, and predeclaration tool | PASS |
| Python syntax check for offline fixture builder | PASS |
| Actual app-origin `app://` worker capability probe on CDP 60096 | NOT_RUN; native lease active |
| `opfs` five fresh-process cold trials | NOT_RUN; capability and benchmark lease pending |
| `opfs-sahpool` five fresh-process cold trials | NOT_RUN; write-capability probe and benchmark lease pending |
| Multiple-window, close/reopen, and disposable-copy corrupt/rebuild checks | NOT_RUN; cold benchmark pending |

Reproduction commands (the source defaults to the test Vault path if copied into artifacts first):

```sh
python3 scripts/sqlite-opfs/build-fixture.py \
  tests/artifacts/sqlite-opfs-2026-10-23/resource-v2/entries.b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126.jsonl.gz \
  tests/artifacts/sqlite-opfs-2026-10-23/ecdict-v2.sqlite \
  --report tests/artifacts/sqlite-opfs-2026-10-23/fixture-report.json
node scripts/sqlite-opfs/verify-normalized-v2.mjs \
  tests/artifacts/sqlite-opfs-2026-10-23/resource-v2/entries.b20dd71d16e589c2bc37b4f243afaf40b4f70b5919fd552316fd448b3dae3126.jsonl.gz \
  tests/artifacts/sqlite-opfs-2026-10-23/fixture-report.json
node scripts/sqlite-opfs/capability-probe.mjs --cdp-url http://127.0.0.1:60096
node scripts/sqlite-opfs/predeclare-runs.mjs
```
