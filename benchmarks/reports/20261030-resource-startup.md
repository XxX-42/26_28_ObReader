# Windows resource rebuild, 2026-10-30

Base: a6db4317861427340d40582b641f087cb0534ac7, feature/v15-single-jsonl.

Changes: skip individual missing-file stats when the content-addressed cache directory does not exist; memoize parent directory preparation for this extraction. Preserve SHA readback, before/after read stats, final cache checks and full completion marker. Release the Reader after all PDF dependencies and current/fallback translations are verified. Rebuild 110 unrelated translations afterwards. The public full-cache promise and explicit verification still wait for the entire cache; no partial completion marker is written.

## Tests

- Resource/runtime/prewarm: 48/48 before adding deferred-error coverage; performance tests including that additional case: 6/6.
- Host/packaging/mobile browser: 129/129, no skips, exit 0.
- Offline smoke: PASS, five tools, sidecar save/reopen and bulk-delete non-resurrection.
- Fast gate: 136 test files passed, 2 failed, 5 platform skips. browser-test-cleanup exited 0 but its Windows skips violate gate policy. vocabulary-v2-boundaries rejects the pre-existing pdf-annotation-host.cjs hash (actual fefcb55d222071e36eb2edeb9274b6e611c25fb0785152d81a142cc79f12e82b). That file was not changed by this patch. Full Fast acceptance is NOT PASS.

## Production-vault native observations

Obsidian was closed normally after controlled Reader close; only the active disposable resource cache was moved aside to force reconstruction. Existing PDF and annotation files were not edited by the test driver. The production plugin's three release files were replaced while the plugin was unloaded. Both tests opened Principles using the Obsidian CLI, not a physical mouse click. Display detection waited for the current page renderingState=3 plus two animation frames; this is a render-completion proxy rather than compositor pixel timing.

| Measurement | Round 1 (regressions concurrently running) | Round 2 (those regressions finished) |
| --- | ---: | ---: |
| Open request to rendered page | 51,565 ms | 11,067 ms |
| Reader resource wait | 48,935 ms | 9,272 ms |
| Startup resource phase since prewarm began | 52,617 ms | 24,215 ms |
| Modules | 211 ms | 168 ms |
| Document open | 2,016 ms | 1,517 ms |
| Viewer PDF parse | 849.8 ms | 703.6 ms |
| First annotation layer (Viewer relative) | 1,680.1 ms | 1,274.7 ms |
| Full resource rebuild | 63,416 ms | 28,876 ms |
| Full resource stat calls | 1,218 | 1,218 |
| Resources verified before initial release | 296 | 296 |
| Deferred translations | 110 | 110 |

Round 2 cumulative concurrent-operation timings: decompression 1,379.7 ms; hashing 546.6 ms; writes 21,200.8 ms; readback 10,259.4 ms; stats 40,328.5 ms; directory preparation 29,498.8 ms. These overlap, include queue waits and must not be summed or interpreted as exclusive disk time.

Prior observation: 406 files, 1,624 stats, full rebuild 10,673 ms. Startup load differs; these observations do NOT prove elapsed rebuild improvement. Stats decreased by 25%, and the Viewer no longer waits for unrelated translations. A sub-five-second cold open remains NOT ACHIEVED. The full rebuild remains a measured latency limitation, especially during app startup load.

Raw local evidence (not committed): tests/artifacts/asset-startup-host-regression.log; asset-startup-fast.log; asset-native-cold-round2-open.log; asset-native-cold-round2-final.log; offline smoke cleanup receipts. Failed and loaded-round observations retained above.
