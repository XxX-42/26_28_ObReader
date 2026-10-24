# Current candidate Native preflight — stopped at focus gate

Observed 2026-10-25 06:38 Asia/Shanghai. Evidence branch: `codex/014-native-current-preflight-20261025`; base `7f99a22`.

The CDP listener `127.0.0.1:57977` belongs to PID `69139`. Its process command names the exclusive profile `macos-native-profile-exclusive-20261024-0120`, whose ownership marker allows only `/Users/jiajia/Documents/ObReader-Apple-Test`. The sole CDP page reports that exact test Vault, Sync disabled, and PDF Web Reader disabled. Active file: `ObReader-Bulk-Tests/source-inspection-1792131679927.pdf`, native `pdf` view; no Reader views.

Installed main.js SHA-256 matches the requested candidate `ee0ce9fe26acaa9d05b99f5e30ccdb032e7e54c5e94caa2378fd02ef9a76d2f8`. All three installed release-file hashes are identical before/after the read-only probe. Because the plugin is disabled, runtime loading of those bytes is not established.

Although `document.visibilityState=visible` and `document.hasFocus()=true`, the stronger owner-document focus condition fails: `activeDocument !== document` and `activeWindow !== window`. Both active globals refer to `设置 - ObReader-Apple-Test - Obsidian 1.14.5`. Native UI input stopped immediately at this evidence; no repeated selection attempts were made.

All 8×5 matrix cells remain NOT_RUN for this continuation. No highlight, Context, Review, Sidebar, Today or path mutation was attempted. No process restart was executed; PID 69139 remained alive. Shared/mixed PID 99806 was observed only in process-list metadata and was not selected or restarted. No plugin installation, reload, enable, domain workflow call, seed, source modification, main push or production deployment occurred.

No JSONL/Sidecar/Context/Review backup/restore was required because no test-data mutation began. `data-inventory-no-mutations.json` is a read-only final inventory, not a before/after invariance claim. PDF bytes were not read or changed. The installed three-file before/after hashes are in `preflight.json`.

Evidence:

- `preflight.json`: exact test renderer identity, file, disk hashes, strict focus gate, NOT_RUN restart/matrix.
- `owned-renderer.png`: screenshot of owned renderer captured during the first read-only probe.
- `owner-process.txt`, `cdp-port-owner.txt`, `profile-marker.json`: process/profile/CDP ownership.
- `data-inventory-no-mutations.json`: read-only JSONL/Sidecar/Context/Review inventory after stopping.
- `probe.mjs`: read-only renderer/screenshot probe; its initial basic focus result is supplemented by the stricter focus observation saved in `preflight.json`.
