# Current candidate gate failures (retained)

Fast run `run-2026-10-22T15-02-17-546Z-38208-c247bebf`: exit 1,
109 child suites passed, 3 failed, 5 skipped subtests. Raw stdout/stderr and
the JSON report are retained under tests/artifacts/vocabulary-gates/runs/.

| Child suite | Evidence | Classification and correction |
| --- | --- | --- |
| browser-test-cleanup | Child exit 0; five existing POSIX/macOS-only tests skip on Windows. | Platform coverage / strict runner policy failure. Preserve all skips and the zero-skip gate policy. Not a product PASS. |
| external-hydration-race | `path.relative` receives URL in new shared source reader before any test executes. | TEST_INFRA_FAILURE: normalize file URL to path, retaining the complete hydration race assertions. |
| mobile-main | 13/13 tests fail at VM module loading with `Unexpected plugin require: ./learning/host.cjs`. | TEST_INFRA_FAILURE: allow the actual new lazy Host module, not a stub; retain mobile and privacy assertions. |

Post-correction direct run: mobile-main, external-hydration-race, learning-host
and plugin-host execute 125 tests, 125 pass, zero failures/cancellations/skips.
Full gates must still be rerun; the first failing run is not replaced by this
targeted result.
