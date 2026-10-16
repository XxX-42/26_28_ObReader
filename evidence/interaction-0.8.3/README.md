# 0.8.3 interaction integration

Base: `44f6dd594209ef4b0d0088fb1d8547adb3196ad3` (main, 0.8.2).

The eleven ownership-extraction commits from `codex/ios-input-ownership` are integrated in order, with conflict resolutions preserving main's immutable PDF / WAL bridge and native scrolling. The old branch's custom touch and read-mode Pencil pan entry points are not restored. DesktopInputPolicy passes existing behavior through. InputRouter owns subscriptions and pointer sessions; IOSInputPolicy owns iOS touch arbitration; selection and annotation semantics move into their controllers. Legacy manual pan/physics helpers remain dormant and are not evidence of native WebKit behavior.

The right-side menu adds delete-current-page and confirm-delete-all-pages for plugin-managed annotations, using existing dirty operation and history machinery. The action and its confirmation are bound to the exact document/open request/PDF instance/manager; a document switch invalidates pending work. No new store API or PDF write is introduced.

Storage/Format 3/WAL architecture changes: NONE. Vendor changes: NONE.

## Evidence discipline

- `wal-regression.log`: 67/67 existing WAL tests passed.
- `native-finger-stage10.log`: Chromium trusted touch regression, 1/1 passed after value-intent integration, before the last selection-session extraction. Trusted touch was not canceled/captured; read/Ink viewport scroll deltas were 140/150 px. Synthetic noniterable TouchList guard canceled active-tool stylus only.
- Earlier extraction checkpoints reported one boundary failure while touch listeners still lived in the bridge; the completed router/policy boundary passed the focused suite. Final integration logs are recorded separately.

Chromium pointer simulations are not physical iPad/WKWebView acceptance. Windows hardware and actual iPad Pencil/native pan must still be checked on devices. The original installed plugin was fully backed up before deployment; see `baseline.json`.

## Final acceptance

- `targeted-accepted.log`: 61/61, including architecture/policies/controllers, native touch, desktop toolbar, page/all deletion with visible+offscreen targets, confirmation cancel, grouped undo/redo, selection differential, drawing lifecycle, external hydration and final artifact/resource validation.
- `wal-final.log`: 67/67, including the restored unchanged maintenance-probe bridge contract.
- `offline-frozen.log`: all five tools, operation save/reopen, normal browser exit.
- `default-frozen.log`: 568 total, 543 pass, 25 fail. This is **not** an all-green result. It includes 14 obsolete Format 3/GC crash/history expectations, the existing iPad/manual-input and desktop/browser tool/readiness failures, plus one browser-cleanup timer assertion. No teardown investigation or assertion weakening was used. Full prior failure logs are retained; the legacy iPad/mouse readiness failures are also recorded in `evidence/native-finger-0.8.2/baseline-interaction.log`.
- Earlier `targeted-final.log`, `targeted-reviewed.log`, and `targeted-frozen.log` are intermediate red runs, not final acceptance. They caught a comment-only static boundary hit, old VM fixture state, a moved source-instrumentation needle, a cross-realm object assertion, a build/source hash mismatch during editing, and a read-only test-host confirmation race. Assertions were preserved; fixtures were adapted to current contracts. `targeted-accepted.log` is the completed source/build result.

Integration initially dropped main's authoritative WAL snapshot flag/comparison and idle maintenance reply. These exact main blocks were restored before acceptance. A new lower-wallclock authoritative-snapshot regression protects the adapter contract; storage modules remain unchanged.

`artifacts.json` identifies the final three files and ZIP; `deployment.json` records verified replacement of only the three plugin files and the full rollback backup. The inspected Obsidian window was the unrelated `Documents` vault, so it was not reloaded or edited. Deployment means on-disk replacement in the requested remote vault, not a claimed live reload or iPad acceptance.
