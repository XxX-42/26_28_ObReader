/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";

const { validateOperation } = require("./merge-engine.cjs");
const { canonicalJson } = require("./canonical.cjs");
const monotonic = () => globalThis.performance?.now?.() ?? Date.now();

function safeSegment(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value !== "." && value !== ".." && !/[\\/\x00-\x1f]/.test(value);
}

function createObsidianStorageBridge({ adapter, root = "00_Archive/20_PDFData", hash, verifyHash } = {}) {
  if (!adapter || typeof adapter.append !== "function" || typeof adapter.read !== "function" ||
      typeof adapter.write !== "function" || typeof adapter.rename !== "function" ||
      typeof adapter.exists !== "function" || typeof adapter.mkdir !== "function") {
    throw new TypeError("WAL v3.2 requires Obsidian DataAdapter append/read/write/rename/exists/mkdir.");
  }
  if (typeof root !== "string" || !root || root.startsWith("/") ||
      root.split("/").some((segment) => !safeSegment(segment))) {
    throw new TypeError("A safe relative storage root is required.");
  }
  if (typeof hash !== "function") throw new TypeError("JSONL entries require a content hash function.");
  const readyFiles = new Set();
  const readyDirectories = new Set();

  async function ensureDirectory(relativePath) {
    const parts = relativePath.split("/").slice(0, -1);
    let current = "";
    for (const part of parts) {
      if (!safeSegment(part)) throw new TypeError("Unsafe WAL path segment.");
      current = current ? `${current}/${part}` : part;
      if (readyDirectories.has(current)) continue;
      if (!(await adapter.exists(current))) {
        try { await adapter.mkdir(current); }
        catch (error) { if (!(await adapter.exists(current))) throw error; }
      }
      readyDirectories.add(current);
    }
  }

  function pathsFor(docKey, deviceId) {
    if (!safeSegment(docKey) || !safeSegment(deviceId)) throw new TypeError("Unsafe document or device identity.");
    // docKey is the stable PDF storage identity; actual source-PDF renames do
    // not move a WAL or create a second annotation history.
    return Object.freeze({
      wal: `${root}/wal/${deviceId}/${docKey}.jsonl`,
      snapshot: `${root}/sidecars/${docKey}.annotations.json`,
    });
  }

  async function read(relativePath) {
    return (await adapter.exists(relativePath)) ? adapter.read(relativePath) : null;
  }

  async function append(relativePath, lines) {
    if (typeof lines !== "string" || !lines || !lines.endsWith("\n")) {
      throw new TypeError("A JSONL append must be a nonempty newline-terminated string.");
    }
    if (!readyFiles.has(relativePath)) {
      await ensureDirectory(relativePath);
      if (!(await adapter.exists(relativePath))) await adapter.write(relativePath, "");
      readyFiles.add(relativePath);
    }
    // One DataAdapter append for the complete operation batch. No full-file
    // read, parse, hash or verification is performed on the ACK hot path.
    await adapter.append(relativePath, lines);
  }

  async function appendOperationBatch(document, deviceId, operations, classify = () => "UPDATE") {
    const encodeStarted = monotonic();
    if (!Array.isArray(operations) || operations.length === 0) {
      throw new TypeError("A WAL append batch needs at least one operation.");
    }
    if (typeof document.documentId !== "string" || !document.documentId ||
        typeof document.source?.sourceHash !== "string" || !document.source.sourceHash) {
      throw new TypeError("A JSONL operation batch needs verified document and source identity.");
    }
    const { wal } = pathsFor(document.docKey, deviceId);
    const entries = await Promise.all(operations.map(async (input) => {
      const operation = validateOperation(input);
      if (operation.version.deviceId !== deviceId || operation.seq !== operation.version.seq) {
        throw new TypeError("A device WAL may append only its own sequenced operations.");
      }
      if (operation.type !== "ANNOTATION_SET" && operation.type !== "ANNOTATION_DELETE") {
        throw new TypeError("Route metadata is not an annotation append batch.");
      }
      const op = operation.type === "ANNOTATION_DELETE" ? "DELETE" : classify(operation);
      if (!["CREATE", "UPDATE", "DELETE"].includes(op)) throw new TypeError("Unknown annotation operation type.");
      const unsigned = { lsn: operation.seq, op, id: operation.uuid, payload: operation, ts: Date.now(),
        docKey: document.docKey, documentId: document.documentId,
        sourceHash: document.source.sourceHash };
      const integrity = await hash(new TextEncoder().encode(canonicalJson(unsigned)));
      return { ...unsigned, integrity };
    }));
    for (let index = 1; index < entries.length; index++) {
      if (entries[index].lsn !== entries[index - 1].lsn + 1) throw new TypeError("Batch LSN values must be consecutive.");
    }
    const lines = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const encodeMs = monotonic() - encodeStarted;
    const appendStarted = monotonic();
    await append(wal, lines);
    return { path: wal, entries, byteLength: new TextEncoder().encode(lines).byteLength,
      encodeMs, appendMs: monotonic() - appendStarted };
  }

  async function readOperationRows(document, deviceId, { repairOwnTail = false } = {}) {
    const { wal } = pathsFor(document.docKey, deviceId);
    const text = await read(wal);
    if (text === null || text === "") return [];
    const lastNewline = text.lastIndexOf("\n");
    const complete = lastNewline < 0 ? "" : text.slice(0, lastNewline + 1);
    const rows = [];
    let previousLsn = 0;
    const lines = complete ? complete.slice(0, -1).split("\n") : [];
    for (const line of lines) {
      if (!line) throw new Error("WAL_JSONL_MIDDLE_LINE_INVALID");
      let entry;
      try { entry = JSON.parse(line); }
      catch { throw new Error("WAL_JSONL_MIDDLE_LINE_INVALID"); }
      if (!entry || !Number.isSafeInteger(entry.lsn) || entry.lsn <= previousLsn ||
          !["CREATE", "UPDATE", "DELETE"].includes(entry.op) ||
          typeof entry.id !== "string" || !entry.id ||
          entry.docKey !== document.docKey || entry.documentId !== document.documentId ||
          entry.sourceHash !== document.source?.sourceHash ||
          !Number.isSafeInteger(entry.ts) || entry.ts < 0) {
        throw new Error("WAL_JSONL_ENTRY_INVALID");
      }
      const { integrity, ...unsigned } = entry;
      if (typeof integrity !== "string" || !integrity ||
          !(typeof verifyHash === "function"
            ? await verifyHash(new TextEncoder().encode(canonicalJson(unsigned)), integrity)
            : await hash(new TextEncoder().encode(canonicalJson(unsigned))) === integrity)) {
        throw new Error("WAL_JSONL_INTEGRITY_INVALID");
      }
      const operation = validateOperation(entry.payload);
      if (operation.seq !== entry.lsn || operation.version.deviceId !== deviceId ||
          operation.uuid !== entry.id ||
          (entry.op === "DELETE") !== (operation.type === "ANNOTATION_DELETE")) {
        throw new Error("WAL_JSONL_OPERATION_MISMATCH");
      }
      rows.push(operation);
      previousLsn = entry.lsn;
    }
    if (complete.length !== text.length) {
      if (!repairOwnTail) throw new Error("WAL_JSONL_SYNC_PENDING");
      // DataAdapter has no truncate primitive. Replace only the malformed tail
      // through a staged cold-path write; do not touch a corrupt middle line.
      await atomicReplace(wal, complete);
    }
    return rows;
  }

  async function atomicReplace(relativePath, text) {
    if (typeof text !== "string") throw new TypeError("Snapshot content must be text.");
    await ensureDirectory(relativePath);
    const temporary = `${relativePath}.pending`;
    const previous = await read(relativePath);
    await adapter.write(temporary, text);
    if (await adapter.read(temporary) !== text) throw new Error("WAL_STAGED_WRITE_MISMATCH");
    try {
      await adapter.rename(temporary, relativePath);
    } catch (renameError) {
      // Some DataAdapters do not replace an existing target via rename. The
      // verified pending copy remains a recovery witness throughout fallback.
      try {
        await adapter.write(relativePath, text);
      } catch (writeError) {
        if (previous !== null) {
          try { await adapter.write(relativePath, previous); } catch { /* Preserve original failure. */ }
        }
        writeError.cause = renameError;
        throw writeError;
      }
    }
    if (await adapter.read(relativePath) !== text) throw new Error("WAL_REPLACEMENT_MISMATCH");
  }

  return Object.freeze({ pathsFor, read, append, appendOperationBatch, readOperationRows,
    atomicReplace, adapter });
}

module.exports = { createObsidianStorageBridge };
