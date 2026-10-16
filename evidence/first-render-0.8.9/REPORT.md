# 0.8.9 first-render deletion repair

Latest synced diagnostic: `2026-10-16T08-38-44-641Z e1444f31`, actual version 0.8.8. The previously observed 0.8.0 export was older; no diagnostic evidence of rollback. Raw 63 MB diagnostic retained outside repository in deployment backup. Runtime log is incomplete and includes historical records; current session errors must not be inferred from the whole history.

Root cause: PDF.js first render preceded asynchronous source-identity confirmation and deletion-mask installation. Repainting afterward hid deleted embedded marks but exposed them in the first frame. Host now supplies verified full-source-hash status; the bridge installs existing embedded deletion references immediately before PDFViewer.setDocument. Untrusted source, stale session or page-count mismatch cannot apply this early mask. Ordered page identity verification remains required before editing. Original PDF and WAL protocol are unchanged.

Evidence: delayed confirmation regression fails with 0.8.8 (blue then white), passes with 0.8.9 (white from first paint). Isolated native Obsidian mobile simulation first-paint comparison changes 263332/1564200 pixels in 0.8.8 and 0/1564200 in 0.8.9. 112 regression tests pass; offline smoke and native desktop/mobile save, reopen, deletion and close tests pass. Physical iPad WKWebView remains unverified.

Legacy Format 3 paths were backed up and moved out of the Vault. Three current EffectiveStates were verified identical before/after cleanup. Current registry, sidecars and WAL (including deletion tombstones) remain. Backup: `/Users/jiajia/Documents/ObReader-Deployment-Backups/first-render-clean-1792140337111`.

Three installed files match build. Mac live plugin reloaded from 0.8.8 to 0.8.9 after save confirmation (no pending revisions), Reader reopened at page 2. Temporary incorrect view type during reopen was immediately corrected to pdf-web-reader-view. Existing user drawing editors preserved. Original PDF SHA-256 unchanged: `53ade40ce75c07455bd1d5a3829c5dd8efe925a65f1b5a54de756a9bea9dd378`.

No push performed. Source PDF remains immutable. No storage/Format schema or vendor changes.
