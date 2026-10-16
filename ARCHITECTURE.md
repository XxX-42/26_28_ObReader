# Runtime architecture and feature boundary

This repository has two runtime concerns that share one Obsidian plugin package but must stay independently refactorable: the native PDF/annotation core and the optional LingQ-style, Vault-local vocabulary feature. “LingQ-style” here means local word/phrase lookup and study states; this plugin does not connect to the LingQ service.

## Native PDF 0.9 core

The PDF path owns opening, rendering, annotation editing, sidecar/WAL persistence, recovery, and export:

- `plugin/main.js` is the Obsidian plugin lifecycle and PDF view/host coordinator. It owns the view identity, open/close lifecycle, and authenticated message routing.
- `plugin/pdf-annotation-host.cjs` and `plugin/storage/**` own the production annotation store. The live plugin uses the WAL/sidecar v3.2 store; PDF bytes and annotation operations must not be routed through vocabulary storage.
- `plugin/pdf-merge-*.cjs`, `plugin/pdf-sync-host.cjs`, recovery modules, and hash runtime support the PDF/annotation lifecycle.
- `viewer-adapter/input/**` owns existing pointer, touch, selection, annotation, and viewport input policy. Preserve these owners and priorities when adding reader interactions.
- `vendor/pdfjs-generic-legacy/**` is the frozen PDF.js vendor runtime.

`src/storage/wal/**` is a separate Node-filesystem WAL implementation used by its own tests/benchmarks; it is not the plugin's live Obsidian Vault store.

## Optional vocabulary feature

The vocabulary implementation is grouped by responsibility and stays out of the PDF and annotation persistence paths:

- `plugin/vocabulary/service.cjs` is the local vocabulary data service. It uses only the Vault `DataAdapter` and owns the canonical `00_Archive/21_VocabularyData/en.vocab.json` snapshot and import/export policies.
- `plugin/vocabulary/modals.cjs` contains the vocabulary entry and CSV/JSON transfer UI. Obsidian's `Modal` and `Notice` constructors are injected so these UI classes don't depend on the PDF host implementation.
- `viewer-adapter/vocabulary/**` contains conservative English surface normalization, physical text-layer scanning, same-page phrase matching, controller lifecycle, and the pointer-transparent canvas overlay.
- `viewer-adapter/vocabulary/runtime-entry.js` is the single bundle entry for the isolated viewer feature.
- `plugin/main.js` and `viewer-adapter/obsidian-bridge.js` retain only the integration seams needed to enter the existing Reader: the persisted setting/commands, open-state value, and authenticated `vocab-*` request/reply handling. Those messages remain bound to the existing channel, session token, renderer generation, document ID, and open request. Clicks continue through the existing annotation/direct-manipulation priority owner.

## Enable/disable behavior

The Obsidian setting “启用 LingQ 式本地英语词汇学习” is persisted in plugin data and defaults to `false` for fresh or legacy settings. When off, the Reader receives `vocabularyEnabled: false`, does no vocabulary page scan/query, and has no vocabulary overlay/controller. Turning it off cancels pending selection work and removes live vocabulary UI; turning it on updates the current authenticated Reader without recreating its iframe. The feature writes only its own Vault snapshot and never writes source PDFs or annotation WAL files.

## Build boundary

`scripts/build.mjs` embeds the viewer source and inlines the host service/UI modules into the single Obsidian `main.js`. The release remains exactly `main.js`, `manifest.json`, and `styles.css`. Source boundaries are retained in the repository so a later refactor can split the large host/bridge orchestrators without changing the plugin's three-file packaging or the PDF input/storage ownership contracts.

## Future refactor sequence

When the host/bridge is next decomposed, use `plugin/vocabulary/` and `viewer-adapter/vocabulary/` as the feature boundary. First extract the `vocab-*` host-message handler from `PdfReaderView` into a vocabulary host adapter, then move the persisted setting and related commands into a feature registration module. Keep the existing authenticated bridge as transport; don't add a second global event listener or a parallel `postMessage` channel. Keep PDF/annotation storage and the frozen vendor tree untouched.

## Focused regression coverage

- `tests/plugin-host.test.mjs` exercises the settings control, default-off state, persistence across plugin reload, live toggle, and authenticated Reader update.
- `tests/vocabulary-service.test.mjs` covers Vault storage, serialization, KNOWN tombstones, and CSV/JSON behavior.
- `tests/vocabulary-bridge-open-state.test.mjs`, `tests/vocabulary-controller.test.mjs`, `tests/vocabulary-normalizer-scanner.test.mjs`, `tests/vocabulary-phrase-matcher.test.mjs`, and `tests/vocabulary-tap-priority.test.mjs` cover renderer lifecycle, text geometry, phrases, teardown, and input priority.
