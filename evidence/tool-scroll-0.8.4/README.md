# 0.8.4: Pencil editing versus native momentum

Base: abad037 (0.8.3). Source changes are limited to iOS policy, viewport animation interruption, and bridge adapter wiring. Desktop, annotation algorithms, vendor, WAL, source-PDF writes and recovery formats remain unchanged.

The old tool-mode handler canceled only dormant custom momentum. WebKit native momentum could continue across selecting eraser. The old touchmove guard also required live pointer tracking, leaving an input-order/cancel gap. New policy interrupts native scroll when selecting an active tool and when starting an editing Pencil contact. Viewport temporarily suppresses overflow, forces layout and performs an instant same-position scroll, then restores the exact inline values/priorities in finally. The guard handles stylus movement even before/after transient pointer bookkeeping; no propagation suppression is added to Pencil editing.

Regression: before.log proves the old touchmove guard fails the new tool matrix. The matrix includes all five tools, eraser, temporary eraser, object move and resize. Native browser test starts an unfinished smooth-scroll animation, selects eraser, and observes the viewport remain at the interruption position; the read/active-tool trusted finger path still has zero preventDefault and zero capture. Physical WKWebView momentum and actual Pencil remain pending device acceptance: Chromium smooth-scroll and synthetic stylus events do not reproduce UIKit deceleration.

Validation: final.log 48/48, offline.log five-tool operation save/reopen with normal browser exit. No new broad testing gate; 0.8.3 whole-suite failures remain documented separately.

References: https://bugs.webkit.org/show_bug.cgi?id=255193 and https://bugs.webkit.org/show_bug.cgi?id=187449 describe WebKit native momentum/programmatic scroll behavior. The latter changed in 2026, so assigning scrollTop alone is not treated as a universal cancellation guarantee.
