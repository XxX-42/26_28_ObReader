import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");

export function hash(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256-v1:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeVaultPath(value) {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Unsafe vault path: ${value}`);
  }
  return normalized;
}

export function createFileAdapter(rootDirectory, hooks = {}) {
  const diskPath = (vaultPath) => path.join(rootDirectory, ...normalizeVaultPath(vaultPath).split("/"));
  const syncParent = async (vaultPath) => {
    // The file contents themselves are fsynced before boundary notifications.
    // Directory fsync is not supported consistently on Windows.
    void vaultPath;
  };
  return {
    async exists(vaultPath) {
      try { await stat(diskPath(vaultPath)); return true; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    },
    async mkdir(vaultPath) {
      await mkdir(diskPath(vaultPath), { recursive: true });
    },
    async read(vaultPath) {
      try { return await readFile(diskPath(vaultPath), "utf8"); }
      catch (error) { if (error.code === "ENOENT") error.code = "ENOENT"; throw error; }
    },
    async write(vaultPath, value) {
      if (hooks.beforeWrite) await hooks.beforeWrite(vaultPath, value);
      const file = diskPath(vaultPath);
      const handle = await open(file, "w");
      try {
        await handle.writeFile(value, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await syncParent(vaultPath);
      if (hooks.afterWrite) await hooks.afterWrite(vaultPath, value);
    },
    async rename(from, to) {
      if (hooks.beforeRename) await hooks.beforeRename(from, to);
      await rename(diskPath(from), diskPath(to));
      await syncParent(to);
      if (hooks.afterRename) await hooks.afterRename(from, to);
    },
    async remove(vaultPath) {
      await unlink(diskPath(vaultPath));
      await syncParent(vaultPath);
      if (hooks.afterRemove) await hooks.afterRemove(vaultPath);
    },
    async list(vaultPath) {
      const directory = diskPath(vaultPath);
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return { files: [], folders: [] }; throw error; }
      const files = [];
      const folders = [];
      for (const entry of entries) {
        const child = `${normalizeVaultPath(vaultPath)}/${entry.name}`;
        if (entry.isDirectory()) folders.push(child);
        else if (entry.isFile()) files.push(child);
      }
      return { files, folders };
    },
  };
}

export function createCrashStore(adapter, deviceId) {
  let sequence = 0;
  return createPdfAnnotationStore({
    adapter,
    root: "00_Archive/20_PDFData",
    deviceId,
    hash,
    uuid: () => `${deviceId}-uuid-${++sequence}`,
    clock: () => 1000,
  });
}

function waitAtBoundary(scenario, boundary, details) {
  if (scenario !== boundary || process.__crashBoundaryUsed) return undefined;
  process.__crashBoundaryUsed = true;
  if (typeof process.send === "function") process.send({ type: "boundary", boundary, details });
  // The parent test kills this worker after it receives the durable boundary.
  return new Promise(() => {});
}

async function runWorker() {
  const scenario = process.env.STORE_CRASH_SCENARIO;
  const rootDirectory = process.env.STORE_CRASH_ROOT;
  const sourcePath = process.env.STORE_CRASH_SOURCE;
  const documentId = process.env.STORE_CRASH_DOCUMENT_ID;
  const batchId = `batch-${scenario}`;
  const annotationUUID = `annotation-${scenario}`;
  const writerId = "crash-writer";
  const hooks = {
    async beforeWrite(vaultPath) {
      if (scenario === "ack-before-write" && vaultPath.includes(".devices/") && vaultPath.endsWith(`/${writerId}.json`)) {
        await waitAtBoundary(scenario, "ack-before-write", { path: vaultPath, phase: "before-ack-write" });
      }
    },
    async beforeRename(from, to) {
      if (scenario === "pending-before-rename" && to.endsWith(`/${batchId}.json`)) {
        await waitAtBoundary(scenario, "pending-before-rename", { from, to, phase: "before-rename" });
      }
    },
    async afterRename(from, to) {
      if (scenario === "operation-published-before-readback" && to.endsWith(`/${batchId}.json`)) {
        await waitAtBoundary(scenario, "operation-published-before-readback", { from, to, phase: "after-rename-before-readback" });
      }
    },
    async afterWrite(vaultPath) {
      if (scenario === "checkpoint-backup-written" && /\/checkpoints\/[^/]+\.previous\.json$/.test(vaultPath)) {
        await waitAtBoundary(scenario, "checkpoint-backup-written", { path: vaultPath, phase: "after-fsync-before-readback" });
      }
      if (scenario === "checkpoint-primary-written" && /\/checkpoints\/[^/]+\.json$/.test(vaultPath) &&
          !vaultPath.endsWith(".previous.json")) {
        await waitAtBoundary(scenario, "checkpoint-primary-written", { path: vaultPath, phase: "after-fsync-before-readback" });
      }
      if (scenario === "ack-written-before-readback" && vaultPath.includes(".devices/") && vaultPath.endsWith(`/${writerId}.json`)) {
        await waitAtBoundary(scenario, "ack-written-before-readback", { path: vaultPath, phase: "after-fsync-before-readback" });
      }
    },
    async afterRemove(vaultPath) {
      if (scenario === "gc-remove-before-confirmation" && vaultPath.endsWith(`/${batchId}.json`)) {
        await waitAtBoundary(scenario, "gc-remove-before-confirmation", { path: vaultPath, phase: "after-unlink-before-exists-check" });
      }
    },
  };
  try {
    const adapter = createFileAdapter(rootDirectory, hooks);
    const store = createCrashStore(adapter, writerId);
    const document = await store.registerDocument({ sourcePath, documentId });
    const paths = store.pathsFor(document);
    await store.appendOperations({
      document,
      batchId,
      operations: [{
        uuid: annotationUUID,
        kind: "Ink",
        pageIndex: 0,
        deleted: false,
        payload: { marker: scenario },
        clock: { timestamp: 100, logical: 0, deviceId: writerId, opId: `op-${scenario}` },
      }],
    });
    if (scenario === "pending-before-rename" || scenario === "operation-published-before-readback") {
      throw new Error(`target ${scenario} was not reached during appendOperations`);
    }
    await store.readDocument(document);
    throw new Error(`target ${scenario} was not reached during readDocument`);
  } catch (error) {
    if (typeof process.send === "function") process.send({ type: "error", error: error?.stack || String(error) });
    process.exitCode = 1;
  }
}

if (typeof process.send === "function" && process.env.STORE_CRASH_SCENARIO) {
  void runWorker();
}
