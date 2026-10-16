/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const SOURCE_PROTOCOL = "wal-sidecar-v3.2-jsonl";
const markerPath = (root) => `${root}/_storage-protocol.json`;

// This is a bundled-writer capability barrier, not a distributed lock. Older
// binaries cannot be made to obey it; JSONL authoritative files have a separate
// namespace and must never be used as destinations of the legacy writer.
function legacyReadOnlyAdapter(adapter, root) {
  const assertWritable = async () => {
    if (!await adapter.exists(markerPath(root))) return;
    throw Object.assign(new Error("This root is owned by the JSONL writer; legacy data is read-only migration input."),
      { code: "PDF_ANNOTATION_PROTOCOL_READ_ONLY" });
  };
  return new Proxy(adapter, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (["write", "append", "rename", "remove", "mkdir", "process"].includes(key)) {
        return async (...args) => { await assertWritable(); return value.apply(target, args); };
      }
      return value.bind(target);
    },
  });
}

async function activateJsonlProtocol(adapter, root) {
  const path = markerPath(root);
  if (await adapter.exists(path)) {
    const marker = JSON.parse(await adapter.read(path));
    if (marker.sourceProtocol !== SOURCE_PROTOCOL) {
      throw Object.assign(new Error("Unknown annotation writer epoch; refusing write."),
        { code: "PDF_ANNOTATION_PROTOCOL_CONFLICT" });
    }
    return;
  }
  await adapter.write(path, JSON.stringify({ sourceProtocol: SOURCE_PROTOCOL }));
}

module.exports = { SOURCE_PROTOCOL, activateJsonlProtocol, legacyReadOnlyAdapter };
