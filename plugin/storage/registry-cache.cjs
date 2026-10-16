/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { canonicalJson } = require("./canonical.cjs");

// This file is intentionally never used to authorize identity or hydration.
// All entries are regenerated from verified Sidecar/WAL routing by the caller.
function createRegistryCache({ adapter, root, ensureDirectory }) {
  const path = `${root}/_registry.json`;
  async function lookup(sourcePath) {
    try {
      if (!(await adapter.exists(path))) return null;
      const value = JSON.parse(await adapter.read(path));
      if (value.schemaVersion !== 1 || value.kind !== "pdf-reader-registry-cache" ||
          !value.entries || !Object.hasOwn(value.entries, sourcePath)) return null;
      const entry = value.entries[sourcePath];
      if (!entry || typeof entry.documentId !== "string" || !/^[a-f0-9]{12}$/.test(entry.docKey)) return null;
      return { documentId: entry.documentId, docKey: entry.docKey };
    } catch { return null; }
  }
  async function replace(documents) {
    const entries = {};
    for (const document of [...documents].sort((a, b) => a.sourcePath < b.sourcePath ? -1 : 1)) {
      if (Object.hasOwn(entries, document.sourcePath) && entries[document.sourcePath].documentId !== document.documentId) {
        const error = new Error("Multiple document identities route to the same source path.");
        error.code = "IDENTITY_ROUTE_CONFLICT";
        throw error;
      }
      Object.defineProperty(entries, document.sourcePath, { enumerable: true, value: {
        documentId: document.documentId, docKey: document.docKey,
      }});
    }
    await ensureDirectory(root);
    const text = canonicalJson({ schemaVersion: 1, kind: "pdf-reader-registry-cache", entries });
    if (await adapter.exists(path)) {
      try { if (await adapter.read(path) === text) return; } catch { /* Rebuildable cache. */ }
    }
    await adapter.write(path, text);
  }
  return { path, lookup, replace };
}
module.exports = { createRegistryCache };
