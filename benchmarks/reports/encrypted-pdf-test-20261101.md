# Encrypted PDF tool acceptance — 2026-11-01

Windows test vault only. QPDF WASM 0.0.2 is bundled offline under its Apache-2.0 license; no Python runtime is required by the plugin.

Test: RAND_RRA4625-1.pdf copied to PDF迁移测试/RAND-encrypted-final-1793479932528.pdf. Original file was not overwritten.

- Encrypted load: read-only attribute present; Highlight/Square/Ink/FreeText buttons disabled; decrypt button present.
- Button activated through Obsidian DOM API, not physical mouse.
- Decrypt overwrote the new test copy, then reopened the Reader: 148 pages, hydration allowed, read-only false, decrypt button removed.
- Independent PyMuPDF validation: all 148 pages have identical extracted text and annotation counts; raster pixels match on pages 1, 11, 71 and 148.
- Targeted store, identity and packaging tests: 20 passed; build and offline smoke passed.

Limits: only empty-open-password permission-encrypted PDFs are currently supported. Password-required PDFs report a failure without overwriting. Already-paired PDFs are rejected before overwrite because QPDF changes page object references; existing annotations/anchors must not silently move. The current implementation does not claim support for that migration. No formal-vault deployment or physical iPad test.
