# Resource-v3 wiring candidate

This branch prepares the thin Host integration independently of the 0.14 Native gate. It has **not** been merged into the integration branch or deployed. The Native route matrix, Windows learning loops, Native startup measurement and final full gates remain pending.

- The default resource and settings description point to `resource-v3`.
- Manifest, adaptive-block, resource-directory and validated legacy-v2 events invalidate the disposable cache; unrelated files do not.
- Deferred startup/refresh call `checkAvailability()`, which reads a manifest and optionally an already prepared matching v2 generation. They never call full v2 import. A no-term `warmup()` has the same bounded behavior.
- Settings distinguish resource availability, completed direct lookup, verified legacy fallback and concrete unavailable errors. The existing explicit cache control remains available.
- Canonical vocabulary, Context, Review, annotation WAL, source PDFs, input paths and vendor are unchanged.

The 25 focused resource/Host tests pass. They include no binary source reads or cache imports during availability checks, v3 and v2 event routing, status rendering and unload cancellation. Full build/gates and Native measurements must be run after the Native gate permits integration; this document does not claim those results.

The prototype's count/byte limits remain provisional until Native startup evidence completes the benchmark selection gate. Existing benchmark reports separate resident cache hits from mixed workloads with cold-block misses.
