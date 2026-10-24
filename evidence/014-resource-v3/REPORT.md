# ObReader 0.14 candidate status

## Git and release boundary

- Latest fetched `origin/main`: `833397ad2e78bba35e4490d3810ac73783860856`.
- Latest fetched `origin/feature/0.14-native-learning-dictionary-20261023`: `6694c16b4c390d4a8dbd7762ec647ffa13f8f909`.
- Integration branch: `codex/014-resource-v3-integration`, evidence collection started at `a35c7fa20eaa3c841db8b26da42c516957460850`; it already contains the feature branch as an ancestor. The Resource-v3 code commit is `6ea2ca23a106e4fa0dfcf6dbeaaab2f9c8f90ea5`.
- `main` remains unchanged. The formal vault was not deployed or modified.
- Candidate version: `0.14.0`. The built/deployed `main.js` SHA-256 is `8e2200c7e60c10de9501ba1789ce49029949cf3b7b35653bfaa68ef2489d605b`.

## Scope decision

- `SCROLL_PERF = INVESTIGATED / NOT_RELEASE_BLOCKER`. No reproducible root cause was established for the user's 120-page OCR PDF. Stop the scroll-specific investigation; do not modify PDF.js, wheel handling, observers, or LingQ scroll paths unless that exact PDF becomes reproducible.
- iPad remains `DEFERRED_BY_SCOPE`; synthetic mobile timing is not iPad evidence.
- Bulk import prototypes are rejected by their stated production gate; FSRS stays development-only; SQLite/OPFS has not shown a win over Resource-v3.

## Resource-v3 conversion and lookup

The verified resource-v2 source converted to `770,611` equivalent rows in `67` content-addressed blocks (`16,769,142` compressed bytes). A temporary conversion was byte-identical to the installed Resource-v3 blocks. The manifest records the MIT notice at `../LICENSE-MIT.txt` and checksum `f8552dd246f61a4e064569eae6194a01c6b3d63b03bf27c6ca863593c549ed0f`.

Native DataAdapter lookup used the real Obsidian Vault adapter in `ObReader-Apple-Test`; the plugin was disabled and Reader leaves were closed. Each query ran five new dictionary/Worker instances and 20 resident repeats. Reads were limited to DataAdapter `read`/`readBinary`; there were zero Vault writes.

| Query | First lookup P50 | P95 / max of 5 | Warm lookup P95 | First-read bytes |
|---|---:|---:|---:|---:|
| Common `on` | 159.8 ms | 423.8 ms | ≤0.1 ms | 262,366 |
| Rare `zyzzyva` | 112.5 ms | 276.5 ms | ≤0.1 ms | 139,005 |
| Valid not-found | 127.9 ms | 172.3 ms | ≤0.1 ms | 236,616 |

This satisfies the stated first-query target for these loaded-resource samples; it does not measure process-cold lookup. `startup added blocking = NOT_MEASURED`, and the benchmark does not exercise the enabled plugin's full Host/Reader lookup wiring. Retain Resource-v3 as the candidate; do not claim the startup gate passed.

Raw trials: [native-data-adapter-benchmark-20261025.json](native-data-adapter-benchmark-20261025.json).

## Current-package Native Learning Loop

The exact 0.14.0 three-file package was deployed to `ObReader-Apple-Test` after backing up the previous plugin directory to `.deploy-backups/2026-10-24T20-53-16-712Z/pdf-web-reader`. The deployed files matched the build:

| File | SHA-256 |
|---|---|
| `main.js` | `8e2200c7e60c10de9501ba1789ce49029949cf3b7b35653bfaa68ef2489d605b` |
| `manifest.json` | `71abba5efc96154a9bf19a899778ab6ba2676f521f4c2205a59d1e7c40a6d675` |
| `styles.css` | `8da58b1d067939759b42a8671b10adb6600594f66af3c1929eed619dfab68aea` |

The current-package Native runner loaded v0.14.0 with DataAdapter write isolation installed and Sync disabled. It selected the visible PDF.js Highlight tool, then failed to observe a real Highlight editor after the pointer selection. No learning route was accepted from this run; the evidence is an automation/input-path failure and is not enough to classify a production correctness regression. Cleanup completed, the Reader closed, plugin disabled, isolation restored, and protected default data hashes remained unchanged. A post-run SHA-256 check confirmed the test PDF still matches its source fixture (`3662ff519e485810520552bf301d8c3b2b917fd2f83303f4965d7abed367e113`). The unrelated formal-vault renderer was excluded without navigation, content interaction, or mutation.

Therefore:

```text
NATIVE_LEARNING_LOOP_CURRENT_PACKAGE = NOT_VERIFIED
OPEN_MOVE_8x5 = NOT_VERIFIED
REAL_PROCESS_RESTART_8x5 = NOT_RUN
```

Do not substitute earlier package or Windows evidence for these current-package gates. The 8-stage × 5-direction matrix and true process restart remain the first release blocker. The current native failure report is [native-learning-loop-20261024210631256-a55ffa2317.json](../../tests/artifacts/native-learning-loop-20261024210631256-a55ffa2317.json).

## Automated gates

- Focused dictionary/conversion suites: 67 passed.
- Build: passed; 3 release files, 406 embedded assets, 402 frozen vendor hashes verified.
- Fast: 122 passed.
- Browser: 27 passed, 1 failed. The retained failure is the synthetic iPad 80 ms pointer-delay case; iPad is deferred and its assertion/code were not changed.
- Race: 80 passed.
- Offline smoke: passed, including save/reopen and bulk-delete non-resurrection.

These green gates do not override the Native acceptance blocker. Test Vault deployment is complete and verified by hashes; no production deployment, `main` push, Release, or data cleanup occurred.
