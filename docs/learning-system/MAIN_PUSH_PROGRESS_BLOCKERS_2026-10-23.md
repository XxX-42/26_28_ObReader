# 0.13.0 candidate — main promotion progress and blockers

Date: 2026-10-23

## Promotion source

- Repository: `XxX-42/26_28_ObReader`
- Source branch before this report: `feature/reading-learning-loop-20261022`
- Source HEAD before this report: `c044452e27e480612186aaabaf17a8bac760a332`
- Remote `main` before promotion: `b6b178dc142b6900fa7b4bbdd7d23c5f4d0bc96c`
- Relationship before promotion: `main` was an ancestor of the feature HEAD; 72 commits ahead, 0 behind.
- Scope: the promotion contains the 0.13.0 reading/understanding/memory candidate and its accumulated branch changes. It is not a declaration that all release gates passed.

## Verified progress

- `npm run build`: passed; release output has exactly `main.js`, `manifest.json`, and `styles.css`; 406 embedded assets and 402 frozen-vendor hashes verified.
- `npm run test:browser`: passed 28/28, with 0 failures and 0 skips.
- `npm run test:race`: passed 80/80, with 0 failures and 0 skips.
- `npm run test:offline`: passed after the current build.
- Windows Obsidian 1.14.4 test-Vault Native runs passed the recorded five-tool save/close/reopen and delete/undo/redo flow, Underline single/adjacent/multiline flow, and FreeText text/geometry/reopen/export flow. Receipts and exact scope are in `P0_NATIVE_ROOT_ACCEPTANCE.md`.
- Across those Native runs, the source PDF SHA-256 and XXH64 were unchanged, source write attempts were zero, ordinary `saveDocument()` calls were zero, and 366 protected pre-existing sidecar files were unchanged.
- Browser learning flows exercised Highlight → Sidecar → Sidebar → learning draft/Today → exact Viewer source and LingQ → Vocabulary/Context → Review source. Obsidian Workspace/editor boundaries were mocked; this is not Native source-navigation evidence.
- Focused SemanticAnchor and target-text suites passed 33/33. Learning domain/host, History, review, source-validation, and export suites passed 43/43 in the recorded audit.

## Blocking or incomplete evidence

- The exact `npm test` gate is **not green** on this Windows host: Fast reported 111 passed, 5 existing platform-specific skips, and 1 gate-policy failure because the strict runner rejects any skip. No child assertion failed in that run; the Browser gate was run separately and passed. Evidence: `GENERAL_ACCEPTANCE.md` and retained run `run-2026-10-23T04-14-12-381Z-31632-c5c4ac8f`.
- Gesture long-tail acceptance remains **not accepted**. Six unprofiled simulated A/B runs captured all 18 declared sequences without an 80 ms assertion violation, but B2 failed a later readiness wait. A separate CPU-profiled run recorded 169–188 ms delays with profiler-startup/timestamp contamination unresolved; a later simulated 41.2 ms pass does not erase those failures or establish physical-device behavior. No threshold was raised. See `P0_INPUT_LONGTAIL.md`.
- Resource-v2/ECDICT cold-start benchmark is incomplete: 20 trials were predeclared; 8 passed, 3 timed out, 1 was interrupted, and 8 were not run. It establishes no optimization result or batch-size recommendation. See `RESOURCE_V2_BENCHMARK_RESULTS.md`.
- The 25,000-record import measurement is an in-memory adapter result, not physical Vault I/O: 57,530,525 bytes written. The tested compact-history prototype increased History writes by 763,918 bytes, so it was rejected; History and transaction formats remain unchanged.
- macOS Native, physical iPad/WKWebView and Apple Pencil, real multi-client Sync, Native learning-source return, and dedicated Native rename/move/first-paint gates remain `NOT_RUN` or `NOT_VERIFIED`.
- Consequently, the 0.13.0 candidate is **not fully accepted for release**. Promotion to `main` records the requested progress but does not convert these limitations into passes or authorize production-Vault deployment.

## Data and deployment boundary

- Verified Native PDF tests used isolated test fixtures; the source PDF hashes were unchanged.
- The installed 0.13.0 package was validated in the Windows test Vault only. This promotion does not deploy to `D:\Documents\Obsidian\远程仓库1` and does not modify its PDFs or existing sidecars.
- macOS, physical iPad, and real cross-device Sync claims remain out of scope until their corresponding evidence exists.
