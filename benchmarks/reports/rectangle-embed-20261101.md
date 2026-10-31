# Rectangle region performance (Windows test Vault, 2026-11-01)

Fixture: isolated copies of 黑格尔的《精神现象学》, 183,547,071 bytes.
Native renderer, real Obsidian DataAdapter, default image resolution unchanged.
Timings include opening Markdown through image decode; they do not measure physical display refresh.

| Run | First image, Reader open | First image after real plugin reload, no Reader |
| --- | ---: | ---: |
| rectangle-1793470800021 | 159.3 ms | 165.5 ms |
| rectangle-1793470846752 | 149.0 ms | 152.7 ms |
| rectangle-1793470916782 | 150.2 ms | 155.7 ms |

Reload measurements retained only the test namespace's disk-backed Store facade for route lookup.
The plugin, image runtime, PDF pool and in-memory image caches were recreated.
All three reload runs recorded zero PDF reads, zero PDF acquisitions and zero Reader views.
The native test now asserts a 300 ms limit for first, warm and post-reload display.

## Memory decision

Keep compressed cropped PNGs rather than decoded page buffers or full PDF documents.
Example actual text crop: 339×118 pixels, PNG 19,662 B versus raw RGBA 160,008 B.
Example scanned crop: 330×125 pixels, PNG about 11.5 KiB versus raw RGBA 165,000 B.
Browser size experiment rendered three crop areas five times each; compressed data was smaller in all runs.
Displayed images still require decoded pixels; encoded size is not total renderer RSS.
Temporary independently loaded PDFs are destroyed after rendering. Existing Reader-owned documents are only borrowed.
Image caches are bounded to 16 entries / 32 MiB, and keys include Vault namespace, document/source version, UUID, page and rectangle.
PNG persistence avoids retaining an additional full PDF between plugin sessions.

## Correctness and boundaries

Rotation, CropBox, current rectangle, deletion, source-version invalidation, rename navigation, cache eviction and storage failures have targeted tests.
Native save/reopen/resize/rename and source SHA-256/XXH64/zero ordinary PDF writes passed on these isolated fixtures.
Earlier pointer failures and the slower experiments remain in tests/artifacts; no timeout was enlarged to pass them.
OffscreenCanvas and verified live-Reader reuse were retained. Prewarming experiment was reverted when it did not help.
No production Vault data was changed by this benchmark.

This is a measured gate for these fixtures and environments, not a latency guarantee for arbitrary PDF content.
An uncached region in an unopened PDF still requires validation/parsing/rendering and is not proved to finish within 300 ms.
Persisted cache eviction, external source modification or geometry changes can require that slower path.
Production Vault deployment and physical iPad acceptance are not part of this receipt.
