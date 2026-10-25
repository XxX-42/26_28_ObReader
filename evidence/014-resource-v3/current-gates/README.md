# Current integration gates

These reports are copied from the ignored local run artifacts so the results remain reviewable from the pushed integration branch. They ran on the current 0.14 integration source at `e8a6e02dd0d78847225683c423fea4a6681a2149` (the only later change before documentation was the `REPORT.md` update).

## Fresh release run

- [Build + Fast](fast-20261025.json): build completed with 3 release files, 406 embedded assets and 402 frozen vendor files verified; Fast 122/122, no skips.
- [Browser](browser-20261025.json): 28/28, no skips.
- [Race](race-20261025.json): 80/80, no skips.
- [Offline cleanup proof](offline-cleanup-20261025.json): normal browser close, owned page and process cleanup, no cleanup errors. The Offline Viewer smoke also visibly created all five annotation tools, saved/reopened them, and verified bulk deletion persisted.

## Preserved earlier Race results

- [Initial combined gate](previous-combined-gates-initial-failure-20261025.json): Fast 122/122, Browser 28/28, Race 79/80. The one failure was retained; this run is not acceptance-eligible.
- [Earlier complete Race rerun](previous-race-repeat-20261025.json): 80/80, no skips.

The fresh current run also passed Race 80/80. The initial failure remains in the evidence set and was not rewritten or deleted.

## Latest bounded rerun

`REPORT.md`'s [2026-10-25 bounded closeout update](../REPORT.md) is the authoritative latest status. On source fingerprint `3123b32d42d6fd4fb5c3744add9fe763005b63b3d3c0f45b73514e954c42b980`, Build/Fast passed 122/122, Race passed 80/80, and Offline smoke passed. Browser was 26/28: the iPad finger-inertia assertion remains deferred by scope, and the LingQ pill test's fake result beat its transient pending-state assertion. That second test passed when rerun alone, but the full gate result remains failed. See [sanitized gate summary](final-gates-rerun-20261025.json).

The latest actual Obsidian 1.14.5 run passed the Highlight learning flow and created/saved a LingQ Context. It stopped before Context → Review because Obsidian's Command Palette `SuggestModal` threw `TypeError: n.instanceOf is not a function`. Cleanup restored the test vault with Sync disabled, plugin disabled, no Reader views and the isolated write adapter restored. The 8×5 route matrix remains `NOT_VERIFIED`; real process restart remains `NOT_RUN`. See [sanitized Native receipt](native-current-final-resume-20261025.json).
