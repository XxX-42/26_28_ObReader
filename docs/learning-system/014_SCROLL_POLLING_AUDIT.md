# 0.14 scroll and polling audit

Date: 2026-10-24. This is a source audit, not a performance reproduction. The
reported Windows case (120-page OCR PDF, intermittent wheel stutter) was not
available in the isolated test Vault, so it remains `NOT_REPRODUCED`.

## Timer inventory

The shared application code has two periodic timers outside PDF.js:

- `viewer-adapter/obsidian-bridge.js:286` flushes buffered diagnostic rows once
  per second. High-frequency input events are sampled at one in 64. Empty flushes
  post no messages; batches are capped at 256 rows.
- `plugin/session-log.cjs:393` defaults to a one-second flush interval. Its
  flush returns without filesystem work when the buffer is empty.

No recurring poll was found in LingQ matching, the middle-button tool wheel, or
the LingQ enable/disable path. Those actions use pointer/click events and the
authenticated state acknowledgement. PDF.js scrolling is also event-driven:
it schedules visibility work from scroll events with `requestAnimationFrame`
and a 100 ms trailing update; it does not run a fixed-frequency visibility poll.

There are bounded retry timers for specific unfinished operations (for example,
rendered text-layer and annotation-editor readiness). They stop after a finite
number of attempts and are not active during ordinary scrolling.

## Event-driven work worth profiling

An annotation-tool change at `viewer-adapter/obsidian-bridge.js:11555` invokes
`observeAccessibilityManagers` immediately and schedules it again at zero delay.
That helper (`:7911`) loops over `pdfDocument.numPages`; when external annotations
or deletion guards exist, the deferred callback also calls
`hydrateRenderedExternalPages` (`:4166`), which walks the viewer's page-view list.
This is not polling and it does not run on every wheel event, but on a large
document it is the clearest source-level candidate for a pause when switching
annotation tools. No timing trace currently proves it is the user-observed
cause. It is deliberately unchanged pending a deterministic profile and a
regression-safe optimization.

LingQ mode toggles do not schedule a periodic scan. They update the shared
enabled state through the Host acknowledgement path, then create/dispose the
controller. Page vocabulary matching remains tied to page visibility/render
events and uses the lexical cache; zoom uses geometry redraw only.

## PDF.js comparison

Upstream reports show that scroll performance can vary with the document and
viewer details even when PDF.js is used. One report discusses lag while moving
through a large OCR-tagged document, but it was closed as incomplete because
the exact PDF was unavailable. Another report profiled page-border shadow image
work in a large document. PDF.js guidance says page count alone is not the
determinant; per-page complexity and high-resolution scan images matter. These
reports establish plausibility, not the cause of this ObReader case.

## Next diagnostic step

Capture the affected PDF's identity and a bounded trace of scroll events,
`PDFViewer.update`, page-render tasks, long tasks, and annotation/LingQ work in
the same 120-page file. Compare the bundled viewer against the matching upstream
PDF.js viewer. If both stutter, investigate document/render cost. If only
ObReader stutters, profile Host/bridge observers and cached overlay work before
changing timer cadence. Keep the original PDF read-only.

No PDF.js vendor code or interaction code was changed for this audit.

## 2026-10-25 input-latency follow-up

The current full gate recorded one simulated finger gesture with a 104.1 ms
pointer-up delivery delay against the test's 80 ms bound. The same
`tests/ipad-pointer-policy.test.mjs` passed when run alone, and a prior Browser
gate passed 28/28. The latest Browser gate therefore remains a failure (27/28),
not an accepted latency result. Its evidence comes from synthetic Chromium
touch dispatch and does not reproduce the reported Windows 120-page OCR PDF.
This is a long-tail signal to profile under a controlled load; it does not
establish that a recurring poll caused the Windows wheel stutter.
