/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

// Publication and verification only. Published candidates are not yet an
// authoritative recovery baseline and do not authorize archive deletion.
const { canonicalJson } = require("./canonical.cjs");
const { verifyMainSnapshotCandidate } = require("./main-snapshot-candidate.cjs");

function error(code, message) { return Object.assign(new Error(message), { code }); }

function createMainSnapshotStore({ adapter, root, hash, token }) {
  if (!adapter || !["exists", "read", "write", "mkdir", "rename"].every((key) => typeof adapter[key] === "function") ||
      typeof root !== "string" || !root || typeof hash !== "function" || typeof token !== "function") {
    throw new TypeError("A storage adapter, root, SHA-256 function and unique token are required.");
  }
  const segment = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
  const pathFor = (document, snapshotId) => {
    if (!/^[a-f0-9]{12}$/.test(document?.docKey || "") || !/^sha256-v1:[a-f0-9]{64}$/.test(snapshotId || "")) {
      throw error("MAIN_SNAPSHOT_INVALID", "Invalid snapshot identity or path.");
    }
    return `${root}/main-snapshots/${document.docKey}/${snapshotId.slice("sha256-v1:".length)}.json`;
  };
  async function ensure(path) {
    const parts = path.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      if (!part || part === "." || part === ".." || part.includes("\\")) throw error("MAIN_SNAPSHOT_INVALID", "Unsafe directory.");
      current = current ? `${current}/${part}` : part;
      if (!(await adapter.exists(current))) {
        try { await adapter.mkdir(current); } catch (e) { if (!(await adapter.exists(current))) throw e; }
      }
    }
  }
  async function decode(document, snapshotId, path) {
    const raw = await adapter.read(path);
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw error("MAIN_SNAPSHOT_CORRUPT", "Snapshot JSON is incomplete."); }
    if (envelope?.snapshotId !== snapshotId || !envelope.value) throw error("MAIN_SNAPSHOT_CORRUPT", "Snapshot envelope differs.");
    const value = await verifyMainSnapshotCandidate({ document, snapshotId, value: envelope.value, hash });
    return { snapshotId, value };
  }
  async function read(document, snapshotId) {
    const path = pathFor(document, snapshotId);
    return (await adapter.exists(path)) ? decode(document, snapshotId, path) : null;
  }
  async function publish(document, candidate) {
    await verifyMainSnapshotCandidate({ document, snapshotId: candidate?.snapshotId, value: candidate?.value, hash });
    const path = pathFor(document, candidate.snapshotId);
    await ensure(path);
    if (await adapter.exists(path)) return decode(document, candidate.snapshotId, path);
    const id = String(token());
    if (!segment(id)) throw error("MAIN_SNAPSHOT_INVALID", "Unsafe publication token.");
    const pending = `${path}.pending-${id}`;
    if (await adapter.exists(pending)) throw error("MAIN_SNAPSHOT_PENDING_EXISTS", "Publication token already exists.");
    const bytes = canonicalJson(candidate);
    await adapter.write(pending, bytes);
    await decode(document, candidate.snapshotId, pending);
    try {
      // An existing destination must never be replaced, even if it is corrupt
      // or arrives between the initial existence check and publication.
      if (typeof adapter.copy !== "function") throw error("MAIN_SNAPSHOT_CREATE_ONLY_UNAVAILABLE", "A no-replace copy is required.");
      await adapter.copy(pending, path);
    } catch (e) {
      if (!(await adapter.exists(path))) throw e;
    }
    const result = await decode(document, candidate.snapshotId, path);
    // A synchronizer can replace this staging file between any read and delete.
    // Without atomic compare-and-delete, preserve it for a future safe cleanup.
    return result;
  }
  return Object.freeze({ pathFor, read, publish });
}

module.exports = { createMainSnapshotStore };
