import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { canonicalStringify } = require("../plugin/vocabulary/canonical.cjs");

const HISTORY_ROOT = "00_Archive/21_VocabularyData/history/";
const PENDING_ROOT = "00_Archive/21_VocabularyData/transactions/";
const SHARED_HISTORY_MAGIC = "OBR-BULK-SHARED-HISTORY-V1\n";
const SHARED_PENDING_MAGIC = "OBR-BULK-SHARED-PENDING-V1\n";
const GZIP_MODES = new Set(["gzip-history"]);
const SHARED_MODES = new Set(["shared-history"]);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function freshMetrics() {
  return {
    reads: 0,
    readLogicalBytes: 0,
    readPhysicalBytes: 0,
    writes: 0,
    writtenLogicalBytes: 0,
    writtenPhysicalBytes: 0,
    appends: 0,
    appendedLogicalBytes: 0,
    appendedPhysicalBytes: 0,
    renames: 0,
    removes: 0,
    mkdirs: 0,
    encodeMs: 0,
    decodeMs: 0,
    encodeCpuMicros: 0,
    decodeCpuMicros: 0,
    filesTouched: new Set(),
    byType: {
      history: { reads: 0, readLogicalBytes: 0, readPhysicalBytes: 0, writes: 0, writtenLogicalBytes: 0, writtenPhysicalBytes: 0 },
      pendingIntent: { reads: 0, readLogicalBytes: 0, readPhysicalBytes: 0, writes: 0, writtenLogicalBytes: 0, writtenPhysicalBytes: 0 },
      other: { reads: 0, readLogicalBytes: 0, readPhysicalBytes: 0, writes: 0, writtenLogicalBytes: 0, writtenPhysicalBytes: 0 },
    },
  };
}

function trafficType(logicalPath) {
  if (logicalPath.includes("/history/")) return "history";
  if (logicalPath.startsWith(PENDING_ROOT) && logicalPath.endsWith(".pending.json") &&
      !logicalPath.endsWith("/summary.pending.json")) return "pendingIntent";
  return "other";
}

function pathSegments(logicalPath) {
  if (typeof logicalPath !== "string" || !logicalPath || logicalPath.includes("\\") ||
      logicalPath.startsWith("/") || /^[A-Za-z]:/.test(logicalPath)) {
    throw Object.assign(new Error("Node DataAdapter accepts only non-empty relative slash paths."), { code: "NODE_ADAPTER_PATH_INVALID" });
  }
  const segments = logicalPath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
    throw Object.assign(new Error("Node DataAdapter path escapes its isolated temporary root."), { code: "NODE_ADAPTER_PATH_INVALID" });
  }
  return segments;
}

function sharedTemplate(change) {
  const lifecycleRoot = (change.kind === "entityCreate" || change.kind === "entityDelete") &&
    Array.isArray(change.fieldPath) && change.fieldPath.length === 2 &&
    change.fieldPath[0] === "records" && change.fieldPath[1] === change.entityId;
  return {
    storeId: change.storeId,
    path: change.path,
    kind: change.kind,
    fieldPath: lifecycleRoot ? ["records", "$entityId"] : change.fieldPath,
    entityIdInPath: lifecycleRoot,
  };
}

function compactHistoryText(text) {
  const batch = JSON.parse(text);
  if (!batch || !Array.isArray(batch.changes)) throw new Error("Shared-history encoding requires a History batch.");
  const rows = [];
  const rowIds = new Map();
  const changes = batch.changes.map((change) => {
    const template = sharedTemplate(change);
    const signature = canonicalStringify(template);
    let rowId = rowIds.get(signature);
    if (rowId === undefined) {
      rowId = rows.length;
      rowIds.set(signature, rowId);
      rows.push(template);
    }
    const values = { ...change };
    delete values.storeId;
    delete values.path;
    delete values.kind;
    delete values.fieldPath;
    return { rowId, values };
  });
  const batchHeader = Object.fromEntries(Object.entries(batch).filter(([key]) => key !== "changes"));
  return { codec: "obreader-bulk-shared-history-v1", batchHeader, rows, changes };
}

function expandHistoryObject(compact) {
  if (compact?.codec !== "obreader-bulk-shared-history-v1" || !Array.isArray(compact.rows) ||
      !Array.isArray(compact.changes) || !compact.batchHeader) {
    throw new Error("Shared-history payload is malformed.");
  }
  const changes = compact.changes.map(({ rowId, values }) => {
    const row = compact.rows[rowId];
    if (!row || !values || typeof values !== "object") throw new Error("Shared-history row reference is invalid.");
    const fieldPath = row.entityIdInPath ? ["records", values.entityId] : row.fieldPath;
    return { storeId: row.storeId, path: row.path, kind: row.kind, fieldPath, ...values };
  });
  return canonicalStringify({ ...compact.batchHeader, changes });
}

function compactPendingText(text) {
  const envelope = JSON.parse(text);
  if (!envelope?.payload || !Array.isArray(envelope.payload.mutations)) return null;
  const historyTexts = [];
  envelope.payload.mutations.forEach((mutation, index) => {
    if (mutation?.operation !== "write" || mutation.storeId !== "vocabulary-history" ||
        !mutation.path?.includes("/history/") || typeof mutation.text !== "string") return;
    historyTexts.push({ index, compact: compactHistoryText(mutation.text) });
    mutation.text = null;
  });
  if (!historyTexts.length) return null;
  return { codec: "obreader-bulk-shared-pending-v1", envelope, historyTexts };
}

function expandPendingObject(compact) {
  if (compact?.codec !== "obreader-bulk-shared-pending-v1" || !compact.envelope?.payload?.mutations ||
      !Array.isArray(compact.historyTexts)) throw new Error("Shared-pending payload is malformed.");
  for (const entry of compact.historyTexts) {
    const mutation = compact.envelope.payload.mutations[entry.index];
    if (!mutation || mutation.text !== null) throw new Error("Shared-pending mutation reference is invalid.");
    mutation.text = expandHistoryObject(entry.compact);
  }
  return canonicalStringify(compact.envelope);
}

function encodeSharedPath(text, logicalPath) {
  if (logicalPath.includes("/history/")) {
    return Buffer.from(SHARED_HISTORY_MAGIC + JSON.stringify(compactHistoryText(text)), "utf8");
  }
  if (logicalPath.startsWith(PENDING_ROOT) && logicalPath.endsWith(".pending.json")) {
    const compact = compactPendingText(text);
    if (compact) return Buffer.from(SHARED_PENDING_MAGIC + JSON.stringify(compact), "utf8");
  }
  return Buffer.from(text, "utf8");
}

function decodeStoredBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return gunzipSync(bytes).toString("utf8");
  }
  const text = bytes.toString("utf8");
  if (text.startsWith(SHARED_HISTORY_MAGIC)) {
    return expandHistoryObject(JSON.parse(text.slice(SHARED_HISTORY_MAGIC.length)));
  }
  if (text.startsWith(SHARED_PENDING_MAGIC)) {
    return expandPendingObject(JSON.parse(text.slice(SHARED_PENDING_MAGIC.length)));
  }
  return text;
}

function formatMetric(value) {
  return { ...value };
}

export async function createTemporaryVocabularyAdapter({ mode = "plain", hook = null } = {}) {
  if (!new Set(["plain", "gzip-history", "shared-history"]).has(mode)) throw new TypeError(`Unknown adapter mode: ${mode}`);
  const tempBase = await import("node:fs/promises").then(({ realpath }) => realpath(tmpdir()));
  const root = await mkdtemp(path.join(tempBase, `obreader-bulk-${randomUUID()}-`));
  const canonicalRoot = path.resolve(root);
  if (!canonicalRoot.startsWith(`${tempBase}${path.sep}`)) {
    await rm(canonicalRoot, { recursive: true, force: true });
    throw new Error("Generated data root is outside the operating-system temporary directory.");
  }
  let metrics = freshMetrics();

  function physicalPath(logicalPath) {
    const segments = pathSegments(logicalPath);
    const candidate = path.resolve(canonicalRoot, ...segments);
    if (!candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw Object.assign(new Error("Node DataAdapter path escaped its isolated temporary root."), { code: "NODE_ADAPTER_PATH_INVALID" });
    }
    return candidate;
  }

  function measureCpu(startUsage) {
    const elapsed = process.cpuUsage(startUsage);
    return elapsed.user + elapsed.system;
  }

  async function event(phase, operation, details) {
    await hook?.({ phase, operation, ...details, adapter });
  }

  const adapter = {
    root: canonicalRoot,
    mode,
    metrics,
    resetMetrics() { metrics = freshMetrics(); adapter.metrics = metrics; },
    measured() {
      return {
        ...metrics,
        filesTouched: [...metrics.filesTouched].sort(),
        byType: Object.fromEntries(Object.entries(metrics.byType).map(([key, value]) => [key, formatMetric(value)])),
      };
    },
    async exists(logicalPath) {
      const target = physicalPath(logicalPath);
      try { await stat(target); return true; }
      catch (error) { if (error?.code === "ENOENT") return false; throw error; }
    },
    async mkdir(logicalPath) {
      await event("before", "mkdir", { path: logicalPath });
      await mkdir(physicalPath(logicalPath), { recursive: false });
      metrics.mkdirs++;
      await event("after", "mkdir", { path: logicalPath });
    },
    async read(logicalPath) {
      await event("before", "read", { path: logicalPath });
      const target = physicalPath(logicalPath);
      const bytes = await readFile(target);
      const start = performance.now();
      const usage = process.cpuUsage();
      const text = decodeStoredBytes(bytes);
      const decodeMs = performance.now() - start;
      const decodeCpuMicros = measureCpu(usage);
      const category = metrics.byType[trafficType(logicalPath)];
      metrics.reads++;
      metrics.readLogicalBytes += byteLength(text);
      metrics.readPhysicalBytes += bytes.byteLength;
      metrics.decodeMs += decodeMs;
      metrics.decodeCpuMicros += decodeCpuMicros;
      category.reads++;
      category.readLogicalBytes += byteLength(text);
      category.readPhysicalBytes += bytes.byteLength;
      await event("after", "read", { path: logicalPath, text, physicalBytes: bytes.byteLength });
      return text;
    },
    async write(logicalPath, text) {
      if (typeof text !== "string") throw new TypeError("DataAdapter.write requires text.");
      await event("before", "write", { path: logicalPath, text });
      const start = performance.now();
      const usage = process.cpuUsage();
      let bytes;
      if (GZIP_MODES.has(mode) && logicalPath.includes("/history/")) {
        bytes = gzipSync(Buffer.from(text, "utf8"));
      } else if (SHARED_MODES.has(mode)) {
        bytes = encodeSharedPath(text, logicalPath);
      } else {
        bytes = Buffer.from(text, "utf8");
      }
      const encodeMs = performance.now() - start;
      const encodeCpuMicros = measureCpu(usage);
      await mkdir(path.dirname(physicalPath(logicalPath)), { recursive: true });
      await writeFile(physicalPath(logicalPath), bytes);
      const logicalBytes = byteLength(text);
      const category = metrics.byType[trafficType(logicalPath)];
      metrics.writes++;
      metrics.writtenLogicalBytes += logicalBytes;
      metrics.writtenPhysicalBytes += bytes.byteLength;
      metrics.encodeMs += encodeMs;
      metrics.encodeCpuMicros += encodeCpuMicros;
      metrics.filesTouched.add(logicalPath);
      category.writes++;
      category.writtenLogicalBytes += logicalBytes;
      category.writtenPhysicalBytes += bytes.byteLength;
      await event("after", "write", { path: logicalPath, text, physicalBytes: bytes.byteLength });
    },
    async append(logicalPath, text) {
      if (typeof text !== "string") throw new TypeError("DataAdapter.append requires text.");
      await event("before", "append", { path: logicalPath, text });
      await mkdir(path.dirname(physicalPath(logicalPath)), { recursive: true });
      const bytes = Buffer.from(text, "utf8");
      await (await import("node:fs/promises")).appendFile(physicalPath(logicalPath), bytes);
      metrics.appends++;
      metrics.appendedLogicalBytes += byteLength(text);
      metrics.appendedPhysicalBytes += bytes.byteLength;
      metrics.filesTouched.add(logicalPath);
      await event("after", "append", { path: logicalPath, text, physicalBytes: bytes.byteLength });
    },
    async rename(from, to) {
      await event("before", "rename", { from, to });
      await rename(physicalPath(from), physicalPath(to));
      metrics.renames++;
      metrics.filesTouched.add(from);
      metrics.filesTouched.add(to);
      await event("after", "rename", { from, to });
    },
    async remove(logicalPath) {
      await event("before", "remove", { path: logicalPath });
      await rm(physicalPath(logicalPath), { force: true });
      metrics.removes++;
      metrics.filesTouched.add(logicalPath);
      await event("after", "remove", { path: logicalPath });
    },
    async list(logicalPath) {
      const directory = physicalPath(logicalPath);
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error?.code === "ENOENT") return { files: [], folders: [] }; throw error; }
      const prefix = `${logicalPath}/`;
      const files = [];
      const folders = [];
      for (const entry of entries) {
        const child = logicalPath ? `${prefix}${entry.name}` : entry.name;
        if (entry.isDirectory()) folders.push(child);
        else if (entry.isFile()) files.push(child);
      }
      return { files: files.sort(), folders: folders.sort() };
    },
    async diskUsage() {
      let files = 0, directories = 0, bytes = 0;
      async function visit(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) { directories++; await visit(child); }
          else if (entry.isFile()) { files++; bytes += (await stat(child)).size; }
        }
      }
      await visit(canonicalRoot);
      return { files, directories, bytes };
    },
    async dispose() {
      const realBase = await import("node:fs/promises").then(({ realpath }) => realpath(tmpdir()));
      const realRoot = await import("node:fs/promises").then(({ realpath }) => realpath(canonicalRoot));
      if (!realRoot.startsWith(`${realBase}${path.sep}`) || !path.basename(realRoot).startsWith("obreader-bulk-")) {
        throw new Error("Refusing to remove data outside this adapter's isolated temporary root.");
      }
      await rm(realRoot, { recursive: true, force: true });
    },
  };
  return adapter;
}

export const BULK_HISTORY_ENCODING_PREFIXES = Object.freeze({
  sharedHistory: SHARED_HISTORY_MAGIC,
  sharedPending: SHARED_PENDING_MAGIC,
});
