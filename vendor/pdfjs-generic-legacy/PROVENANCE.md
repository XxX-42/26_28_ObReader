# PDF.js Viewer snapshot

This directory contains the production `generic-legacy` viewer artifact used by
the Obsidian plugin. It was copied from the local PDF.js fork at commit
`c80e5a952` (`windows`, pushed as `xxx42/windows`) on 2026-10-07. The artifact
contains the fork's underline and square annotation support and the `1`–`5`
tool shortcuts.

The snapshot includes the complete viewer and runtime resources from
`build/generic-legacy/{web,build}`: PDF.js modules and worker, locale files,
CMaps, ICC profiles, standard fonts, images, and WASM decoders. The build is
frozen here so packaging never builds in or writes to the original repository.

The upstream PDF.js code is licensed under Apache-2.0; see `LICENSE`.
