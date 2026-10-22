# Backlink browser pointer settlement evidence

Command: `node --test tests/reader-bidirectional-link-browser.test.mjs`.

Exactly three unchanged-gesture diagnostic trials: PASS (10,909.952 ms), PASS (16,159.4432 ms), FAIL (15,733.2574 ms). The third trial reproduced the selection target-open timeout. The first two trials predated success receipt capture; their results were retained in the task tool transcript.

Red artifacts remain under `test-results/backlink-failure-1792677641570-57920/` (`trace.json`, `failure.png`). At the failing gesture the previously measured point was (339.683, 524.938), but the live selection range had moved to y=464.438..485.438. The hit element contained unrelated text, "handle all possible type combinations". The iframe offset also moved from cached y=0 to current y=-5. After the timeout the range was y=454.438..475.438. Active request, renderer generation, controller page and selection target matched the current results. This proves pointer coordinates were measured during the smooth scroll following Markdown-to-PDF navigation.

The fixture now waits for eight consecutive animation frames with unchanged outer scroll, iframe position and PDF viewer scroll, within a 5-second bound. Each click uses the current iframe transform. Existing behavioral assertions, interaction timeouts, retry and skip policy remain unchanged. Product sources are unchanged.

Post-fix PASS: 9,768.338 ms, artifact `test-results/backlink-success-1792677702270-22348/trace.json`. After tightening settlement to the existing 5-second budget and resetting its state for each navigation, PASS: 8,549.9144 ms, artifact `test-results/backlink-success-1792677720918-22148/trace.json`. Both completed page, selection, duplicate-source, rename, annotation, tombstone and mismatch assertions. The browser cleanup helper completed without attached cleanup errors. Future receipts also save its report as `cleanup.json`.

This is real Chromium/PDF.js/bridge coverage with the real anchor store and backlink index; Obsidian Workspace/editor boundaries remain mocked. No build, push or deployment was performed.
