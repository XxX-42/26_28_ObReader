# ObReader 0.13 workflow A baseline

Captured 2026-10-22 on the isolated baseline worktree before any product or test edits. This receipt records fresh Windows results; prior run totals are not reused.

## Frozen checkout

- Worktree: `D:\Documents\Codes\2026_7_PdfWebReader\wt-learning-baseline`
- Branch: `work/learning-baseline-20261022`
- Tested commit: `9c361330388cbc929ef76bcc53b83f49a7360c04`
- Git tree: `a30b558f959dd222f874a59b9d70dba1f7ffe1f2`
- Git status was clean before the run and remained clean after all checks.
- Runtime: Windows 11 Pro, build 26300, x64; Node `v24.19.0`; npm `11.17.0`; Chrome `155.0.8059.85`.
- `node_modules` is a junction to `D:\Documents\Codes\2026_7_PdfWebReader\0.12.0-main-test\node_modules`.
- Source fingerprint recorded by both gate reports: SHA-256 `d6488d2d60e3b7e9c89f4be37c07ed438673371a5fc73913b70c35e4a5cb4145`, 885 files. Before/after fingerprints matched, with no changed files.
- The frozen `dist/pdf-web-reader` contains exactly `main.js`, `manifest.json`, and `styles.css`. No output-writing build was run.

## Core SHA-256 receipts

| File | SHA-256 |
| --- | --- |
| `package.json` | `D8E0B82868F62B8FF66D9B591C6651F1F25B70D1605A26A66D94D7334FF6D59C` |
| `package-lock.json` | `FEE2207E385A26D583E86ED5C0650E581AD69842B7907ADD89F2DA299DA951F0` |
| `manifest.json` | `ACA5600F1EC9939E008871A9A7E85230FC2B174B9A764B057C582A41569BA149` |
| `scripts/test-vocabulary-gates.mjs` | `4D5CF7B5735D7A0832320027FF2142294F6B3CBCD7F7DE5273ECB3822BB2A8C4` |
| `dist/pdf-web-reader/main.js` | `CE500E4BC23D3F8E1A55A36D7A48AEBEDC7849C91CA7DBC2425AC69DB468307E` |
| `dist/pdf-web-reader/manifest.json` | `ACA5600F1EC9939E008871A9A7E85230FC2B174B9A764B057C582A41569BA149` |
| `dist/pdf-web-reader/styles.css` | `8DA58B1D067939759B42A8671B10ADB6600594F66AF3C1929EED619DFAB68AEA` |

## Test results and evidence

| Command | Exit | Fresh result | Detailed report |
| --- | ---: | --- | --- |
| `npm test` | 1 | Fast gate: 100 passed, 2 failed, 5 skipped. The `&&` script stopped before browser; browser was run separately. | `tests/artifacts/vocabulary-gates/runs/run-2026-10-22T11-46-39-244Z-18780-f723d79d/report.json` |
| `npm run test:browser` | 1 | 26 passed, 2 failed, 0 skipped. | `tests/artifacts/vocabulary-gates/runs/run-2026-10-22T11-48-02-681Z-55668-5f6444ec/report.json` |
| `npm run test:offline` | 0 | Passed: opened the fixture, created all five editors, saved and reopened annotations, and verified bulk deletion persistence. | `tests/artifacts/offline-smoke-1792670040193-36760-c1160896-ce99-4b3c-a7eb-7df80e684189.cleanup.json` |

Top-level stdout, stderr, and exact exit-code files are saved under `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/` as `npm-test.*`, `npm-test-browser.*`, and `npm-test-offline.*`. Each gate report also records its raw child logs under the sibling `children/` directory. Both stderr files for gate runs were empty. Offline smoke also ran as the final browser-script case; the standalone `test:offline` command above is a separate run.

The fast gate marked `tests/browser-test-cleanup.test.mjs` failed under the runner's skip policy because it contains five unsupported-platform skips: one POSIX process-group case and four macOS-only browser-process sampling cases. `tests/packaging.test.mjs` had the other failure: the embedded `web/pdf-merge-worker.js` is 1,242,521 bytes while its freshly generated expectation is 1,249,721 bytes.

The packaging mismatch is explained by this worktree's `node_modules` junction. A non-writing esbuild `write: false` diagnostic produced 360 occurrences of `../0.12.0-main-test/node_modules/`; replacing that resolver path segment with `node_modules/` reduced the generated bundle by exactly 7,200 bytes and made it byte-for-byte equal to the frozen embedded worker (SHA-256 `24a4d104a01d88404eabad878b870950a5a04e73d9c2ae1b4553378140715cf7`). No `npm run build` was run and no packaging assertion was changed.

The browser failures were:

- `tests/mouse-input-regression.test.mjs`: pause-sequence assertion expected `[true, false, false]`; observed `[false, true, false]`. Full trace and failure evidence are in the browser report's child logs and artifacts.
- `tests/reader-bidirectional-link-browser.test.mjs`: timed out after 5,000 ms waiting for the page-badge interaction. Its captured trace had no target messages or result, current page 1, and backlink count 0.

## Scope and platform limits

- No test or production source files were changed or added. No product modules were touched. The only change from the tested commit is this receipt.
- This is Windows desktop Chrome evidence. POSIX and macOS-only cases were skipped; macOS, iOS/iPadOS, and native Obsidian runtime behavior were not validated here.
- `npm run test:race`, native smoke suites, release build, and deployment were not run.

## Evidence file SHA-256

| Evidence file | SHA-256 |
| --- | --- |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test.stdout.log` | `B2009A4E75C3B59399D1A99AA1095AA49680DB9A7651C94D5B004BF261C9DD0B` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test.stderr.log` | `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test.exit-code.txt` | `6B86B273FF34FCE19D6B804EFF5A3F5747ADA4EAA22F1D49C01E52DDB7875B4B` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test-browser.stdout.log` | `C3E31E1B60C9916356BC4DDA0A6D98C5D28A1A970AFB05B9006C5F8BF370BDEA` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test-browser.stderr.log` | `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test-browser.exit-code.txt` | `6B86B273FF34FCE19D6B804EFF5A3F5747ADA4EAA22F1D49C01E52DDB7875B4B` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test-offline.stdout.log` | `B52FAF7AB133D76C2C3046AD95D1DBA7EE53708C1DE7155D9B1607156D56DD13` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test-offline.stderr.log` | `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` |
| `tests/artifacts/vocabulary-gates/baseline-A-9c361330-20261022/npm-test-offline.exit-code.txt` | `5FECEB66FFC86F38D952786C6D696C79C2DBC239DD4E91B46729D73A27FB57E9` |
| `tests/artifacts/vocabulary-gates/runs/run-2026-10-22T11-46-39-244Z-18780-f723d79d/report.json` | `F37935F89B88EAD47C94E98CDD300DDA19680B190108DEA1EBA64FD431987D1A` |
| `tests/artifacts/vocabulary-gates/runs/run-2026-10-22T11-48-02-681Z-55668-5f6444ec/report.json` | `0DDECAFB87B90A42068ED63BE94DF418BD05A6A00B0203899A7F1D6B98AC02FE` |
| `tests/artifacts/offline-smoke-1792670040193-36760-c1160896-ce99-4b3c-a7eb-7df80e684189.cleanup.json` | `CA31DD1EB756FA9746801D20B8A255B13CE9A7C42FAF4C22ABA112BBF6CA9539` |
