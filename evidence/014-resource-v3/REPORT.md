# Resource-v3 integration evidence

## Candidate and boundary

- Integration base: `6694c16b4c390d4a8dbd7762ec647ffa13f8f909` (`feature/0.14-native-learning-dictionary-20261023`).
- Current candidate commit: `6ea2ca23a106e4fa0dfcf6dbeaaab2f9c8f90ea5` on `codex/014-resource-v3-integration`.
- Built `main.js` SHA-256: `8e2200c7e60c10de9501ba1789ce49029949cf3b7b35653bfaa68ef2489d605b`.
- Scroll performance scope: `INVESTIGATED / NOT_RELEASE_BLOCKER`. No further PDF.js, wheel, observer, or LingQ scroll changes were made.
- This report covers dictionary resource conversion and direct Native DataAdapter lookup. It does not establish the complete plugin startup path, UI latency, or Native Learning Loop acceptance.

## Resource conversion

Converted the test Vault's verified resource-v2 input to a temporary resource-v3 directory, without writing to the Vault. The conversion retained all `770,611` rows in `67` content-addressed blocks (`16,769,142` compressed bytes). Each generated block was byte-identical to the currently installed resource-v3 block. The generated manifest records the MIT license notice at `../LICENSE-MIT.txt` and its SHA-256 `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f`. The existing test Vault manifest predates this provenance field; runtime compatibility accepts it, and the existing license file remains in place.

## Native DataAdapter benchmark

The Native harness attached to the exact ObReader-Apple-Test Obsidian renderer with the plugin disabled and all Reader leaves closed. It called only the Vault DataAdapter `read` and `readBinary` methods and used disposable, unique IndexedDB cache names. There were zero Vault writes. Each case ran five new dictionary/Worker instances, each with one first lookup plus 20 same-key warm lookups. This is instance-cold in an already-running Native process and existing OS/origin cache, not a fresh-process or post-restart cold start.

| Query | First lookup P50 | First lookup P95 / max of 5 | Warm lookup P95 | Bytes read per first lookup |
|---|---:|---:|---:|---:|
| `on` | 159.8 ms | 423.8 ms | ≤0.1 ms | 262,366 |
| `zyzzyva` | 112.5 ms | 276.5 ms | ≤0.1 ms | 139,005 |
| valid not-found | 127.9 ms | 172.3 ms | ≤0.1 ms | 236,616 |

`startup added blocking = NOT_MEASURED`: attachment occurs after Obsidian startup. The benchmark proves direct lookup does not wait for the full Dexie build, but it does not measure plugin startup contribution or its full Reader/Host wiring.

Raw per-trial evidence: [native-data-adapter-benchmark-20261025.json](native-data-adapter-benchmark-20261025.json).

## Verification

- Focused dictionary / conversion suites: 67 passed, 0 failed, 0 skipped.
- Build: passed; 3 release files, 406 embedded runtime assets, 402 frozen vendor files verified.
- Fast gate: final rerun 122 passed, 0 failed, 0 skipped. The first run had one concurrent child-process crash-boundary failure; the same test passed alone 7/7 and the full Fast gate passed on rerun. Both run reports were retained under `tests/artifacts/vocabulary-gates/runs/`.
- Browser gate: 27 passed, 1 failed, 0 skipped. The failure is the existing iPad synthetic 80 ms pointer delay check (`ipad-pointer-policy.test.mjs`, gesture 21). iPad is deferred for this release scope; the assertion was not changed and no iPad input code was modified.
- Race gate: 80 passed, 0 failed, 0 skipped.
- Offline smoke: passed, including editor creation, save/reopen, and bulk-delete non-resurrection.
- Current-package Native Learning Loop 8-stage × 5-direction matrix and real process restart: `NOT_VERIFIED`. The current exact Native Obsidian window has a stale app `activeWindow` reference to a different Settings window, so UI-driven route acceptance could not be controlled reliably. Older-package or Windows evidence is not substituted for this candidate hash.
- Test Vault deployment: not performed. No test Vault dictionary, plugin, PDF, or annotation files were changed during this run.
