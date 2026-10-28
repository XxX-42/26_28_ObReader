# Verified outline-only PDF source versions

The Annotation Host accepts a changed PDF only after the `outline-incremental-v1`
Worker proves an append-only directory update against the original source hash,
size and ordered page identities. The original `documentId`, `docKey`, WAL source
hash, annotation UUIDs and Selection/Context/Review provenance remain unchanged.
The Host separately tracks the actual loaded file's hash, size and mtime for
external-change and save guards. It never writes the source PDF.

## Public skill integration

Within the correct Vault's Obsidian runtime:

```js
await app.plugins.plugins["pdf-web-reader"].annotationHost.acceptOutlineUpdate({
  sourcePath: "12_books/example.pdf", // Vault-relative current route
  expectedBeforeHash: "sha256-v1:<full SHA-256 of the verified original backup>",
  expectedAfterHash: "sha256-v1:<full SHA-256 of the updated PDF>"
});
```

`VERIFIED` returns the unchanged document identity, both version hashes and the
association path. Unverified input returns `TARGET_UNRESOLVED` or a coded error.
The skill must still check successful annotation load/save/reopen. If Obsidian
is not running, the next Reader open performs the same verification automatically.

Associations live in
`00_Archive/20_PDFData/source-versions/<docKey>/<new-SHA256>.json`.
They are deterministic, integrity-protected files written through existing safe
storage primitives. They are not Annotation operations or authority to bypass
verification. A missing record can be regenerated from independently verified
PDF bytes; a corrupt/conflicting record blocks acceptance. No legacy WAL,
Sidecar, Anchor or learning record needs a source-hash rewrite.

## Acceptance boundary

The verifier reads classic or stream xrefs, including PNG-predictor xref streams,
and explicitly honors free entries. Every appended revision must chain back to
the verified original. Only outline tree/actions, Catalog `/Outlines`, version ID
and xref bookkeeping changes are permitted. Page/content/resources/annotations,
forms, Info and other Catalog fields remain protected. Only explicit local-page
GoTo destinations are accepted. Protected objects cannot be reused as xref
bookkeeping or outline nodes. The original object graph is checked against its
xref offsets rather than trusting pdf-lib's retained deleted objects.

Encrypted, signed, hybrid-xref, unsupported/compressed incremental-object,
malformed, ambiguous or over-budget updates stay blocked. Current verification
limits are 512 MiB total bytes, 16 MiB appended bytes, 32 appended revisions,
100,000 objects, 10,000 outline objects and depth 64; the Host terminates its
separate verification Worker after 30 seconds. These are conservative admission
limits, not performance promises. An eight-entry in-memory proof LRU only skips
re-parsing after rechecking the full actual SHA-256 and original prefix hash.

A changed open Reader is paused first. Only a matching authenticated idle/clean
reply permits automatic reopen. Dirty, hidden or unavailable Readers are left
paused and can reopen after their save/recovery boundary. No edit is discarded.

## Validation evidence (2026-10-28)

- Base: `6080f112c33ca7ac470cb10eeb61809b4a7bbd5c`, preserving wheel colors.
- Fast: 127 suites passed, zero failed/skipped. Browser: 31 suites passed,
  zero failed/skipped, including Offline smoke and save/reopen.
- New tests cover repeated outline revisions/deletion; protected page, content,
  resource, annotation, form and metadata changes; executable destinations;
  free/redirected xref entries; xref streams replacing protected objects; missing
  original bytes; corrupt evidence; source races; proof-cache tampering; old/new
  devices with unchanged JSONL headers; rename and tombstone recovery.
- The approved exception to the prior frozen-file manifest is limited to Host
  integration and the worker/client verification RPC. WAL/Sidecar codecs,
  persistence semantics and frozen PDF.js vendor bytes are unchanged.
- Real macOS Obsidian test Vault: the 128 MiB, 256-page book's original backup was
  opened and a FreeText created/saved through UI. After replacing only the test
  copy with the actual directory-updated file, the same UUID and text reappeared.
  A new UI-created annotation saved/reopened; native `ann.<UUID>` link navigation
  returned the original target; the skill API verified the versions; deleting
  all and saving/reopening retained both tombstones and no live annotations.
- The original user PDF and original backup SHA-256 remained unchanged. The
  final package on disk matched the test plugin's `main.js` SHA-256.
- Native directory validation under concurrent browser testing took about 10 s;
  a separate Node run of the same final verifier took about 3.3 s. The test
  renderer's sampled peak RSS was about 1,010 MiB, including PDF.js, file buffers,
  canvases and Worker allocations; this is not an isolated verifier heap metric.
- Native direct editing of an existing FreeText did not enter editing in one
  attempted UI probe; this attempt is retained as NOT_VERIFIED, not a PASS.
  Native Selection/Context/Review UI loops for this exact book were not rerun;
  existing semantic/Context/Learning source regressions pass. Windows and iPad
  real-device verification remain unperformed for this change.

Raw Native JSON, screenshots, failures and final passes are retained locally
outside Git at `/private/tmp/outline-source-native-evidence/` and
`/private/tmp/outline-source-native-final-1793201224057/`. PDF snapshots and
binary evidence are deliberately not committed.

## Delivery

The test Vault and formal `远程仓库1` three-file packages were SHA-256 verified
against the final build (`main.js`:
`e567534319196f125bf78f135d767303de240c9b64da309a14e1a14e67fed09d`).
The test instance actually ran the new API and verifier. Formal plugin files
were replaced after backup; its live process was not reloaded because its CLI
is disabled and macOS denied Accessibility. Reload the formal plugin/restart
Obsidian to execute this package. Deployment verification confirmed the user
PDF hash and all 160 files under formal PDFData unchanged. Backups and durable
local evidence: `/Users/jiajia/Documents/ObReader-Deployment-Backups/outline-source-1793202021655/`.
