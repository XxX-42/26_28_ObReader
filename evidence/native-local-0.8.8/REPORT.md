# Actual macOS Obsidian acceptance: 0.8.8

An isolated native Obsidian 1.14.4 process was launched with a private profile, loopback CDP port dynamically discovered from DevToolsActivePort, and exact Vault path guard `/Users/jiajia/Documents/ObReader-Apple-Test`. No primary-vault actions were executed. The normal user's running remote-vault window reports 0.8.0 despite installed files 0.8.8; it was not reloaded or modified.

The Principles PDF and all external data were copied read-only from the source vault. Native runtime version was checked as 0.8.8, not inferred from disk manifest. Both desktop and app.emulateMobile(true) matrices used real UI mouse clicks/drags for tools, creation, confirmation and the tab close button.

## Results
- Both matrices: Ink / Highlight / Read / Ink after opening the already-deleted PDF: zero live page-2 editors.
- New Square drawn using mouse: save acknowledged, close, reopen and edit-tool activation: exactly one Square visible.
- Delete-all confirmation, save acknowledged, close and reopen: zero live marks, including after activating Ink.
- Actual tab close wall time: desktop 80 / 80 / 373 ms; mobile simulation 362 / 79 / 369 ms. These include native SDK teardown, not just the 250ms bridge budget.
- Browser page errors: zero in the completed run.
- Original source AND isolated test PDF SHA-256 remain 53ade40ce75c07455bd1d5a3829c5dd8efe925a65f1b5a54de756a9bea9dd378.
- Final isolated process had zero Reader views and no current notices, then closed normally. Original test Vault workspace was restored. Prior test plugin is preserved in the recorded backup, current test plugin remains 0.8.8. Source vault untouched.

## Failed attempts and limits
The first attempt drove the mode event before source verification/UI readiness; another attempt had an unresolved trust modal that blocked real clicks. Those are invalid acceptance runs and are preserved in run.log and related failure screenshots. They must not be described as confirmed 0.8.8 product regressions. A temporary 0.8.9 registration-hook prototype was tested then discarded; its patch/evidence are preserved in the local backup, not published. Production source/build remain at 0.8.8.

Completed run-ready.log/report.json records proper source-ready and enabled-tool preconditions and no modal. A transient unconfirmed-close notice can appear in screenshots after a best-effort close budget expires; explicit creation/deletion saves were separately ACKed and proved by reopening. This run does not claim all close attempts had a clean save ACK.

Mobile simulation is Chromium/Electron, not WKWebView or physical iPad/Pencil evidence. Real iPad behavior remains pending.
