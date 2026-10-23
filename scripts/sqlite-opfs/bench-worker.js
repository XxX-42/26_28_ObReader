/* Benchmark-only SQLite worker. Served from the local isolated harness origin. */
"use strict";

const url = new URL(self.location.href);
const variant = url.searchParams.get("variant");
const runId = url.searchParams.get("runId");
const dbFilename = `/ecdict-${runId}.sqlite`;
const poolName = `ecdict-${runId}`;
let sqlite3;
let pool;
let db;

function post(id, result, error) {
  self.postMessage(error
    ? { id, ok: false, error: { name: error.name || "Error", message: error.message || String(error), stack: error.stack || null } }
    : { id, ok: true, result });
}

function openDb(filename = dbFilename) {
  if (variant === "opfs") {
    if (!sqlite3.oo1.OpfsDb) throw new Error("SQLite OPFS VFS did not register; OpfsDb is unavailable.");
    return new sqlite3.oo1.OpfsDb(filename, "r");
  }
  if (!pool?.OpfsSAHPoolDb) throw new Error("SAH pool VFS is not installed.");
  return new pool.OpfsSAHPoolDb(filename, "r");
}

function query(database, key) {
  const resultRows = [];
  const startedAt = performance.now();
  database.exec({
    sql: "SELECT key, translation, phonetic FROM entries WHERE key = ?1",
    bind: [key],
    rowMode: "object",
    resultRows,
  });
  return { row: resultRows[0] || null, elapsedMs: performance.now() - startedAt };
}

function scalar(database, sql) {
  const resultRows = [];
  database.exec({ sql, resultRows });
  return resultRows[0]?.[0] ?? null;
}

async function importDb(filename, bytes) {
  if (variant === "opfs") return sqlite3.opfs.importDb(filename, bytes);
  return pool.importDb(filename, bytes);
}

async function unlinkDb(filename) {
  if (variant === "opfs") return sqlite3.opfs.unlink(filename, false, true);
  return pool.unlink(filename);
}

async function initialize() {
  const startedAt = performance.now();
  globalThis.sqlite3ApiConfig = variant === "opfs"
    ? { disable: { vfs: { "opfs-sahpool": true, "opfs-wl": true } } }
    : { disable: { vfs: { opfs: true, "opfs-vfs": true, "opfs-wl": true } } };
  importScripts("/runtime/sqlite3.js");
  sqlite3 = await sqlite3InitModule({ locateFile: name => `/runtime/${name}` });
  if (variant === "opfs-sahpool") {
    pool = await sqlite3.installOpfsSAHPoolVfs({
      name: poolName,
      initialCapacity: 12,
      clearOnInit: false,
      preserveOnInitFailure: true,
    });
  }
  const vfsList = sqlite3.capi.sqlite3_js_vfs_list();
  const facts = {
    sqliteVersion: sqlite3.capi.sqlite3_libversion(),
    variant,
    vfsList,
    selectedVfsPresent: variant === "opfs"
      ? vfsList.includes("opfs")
      : vfsList.includes(pool.vfsName),
    workerSecureContext: self.isSecureContext,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    opfsSyncAccessHandle: typeof FileSystemFileHandle === "function" &&
      typeof FileSystemFileHandle.prototype?.createSyncAccessHandle === "function",
    initMs: performance.now() - startedAt,
    runtimeBytes: null,
  };
  if (!facts.selectedVfsPresent) throw new Error(`Selected ${variant} VFS was not present: ${JSON.stringify(facts)}`);
  return facts;
}

async function dispatch(action, payload = {}) {
  switch (action) {
    case "init":
      return initialize();
    case "install": {
      const startedAt = performance.now();
      const bytes = payload.bytes instanceof ArrayBuffer ? new Uint8Array(payload.bytes) : payload.bytes;
      const byteCount = await importDb(dbFilename, bytes);
      const importMs = performance.now() - startedAt;
      const openStartedAt = performance.now();
      db = openDb();
      const openMs = performance.now() - openStartedAt;
      return { importedBytes: byteCount, importMs, openMs, dbFilename };
    }
    case "validate": {
      if (!db) throw new Error("Primary database is not open.");
      const integrity = scalar(db, "PRAGMA integrity_check");
      const entryCount = Number(scalar(db, "SELECT count(*) FROM entries"));
      const samples = payload.sampleKeys.map(key => ({ key, ...query(db, key).row }));
      return { integrity, entryCount, samples };
    }
    case "query": {
      if (!db) throw new Error("Primary database is not open.");
      return query(db, payload.key);
    }
    case "close": {
      const wasOpen = Boolean(db?.pointer);
      if (db?.pointer) db.close();
      db = undefined;
      return { wasOpen };
    }
    case "open-existing": {
      const startedAt = performance.now();
      db = openDb(dbFilename);
      const openMs = performance.now() - startedAt;
      const firstQuery = query(db, payload.key);
      return { openMs, firstQuery };
    }
    case "open-secondary": {
      const secondaryDb = openDb(dbFilename);
      try {
        return { opened: true, query: query(secondaryDb, payload.key) };
      } finally {
        secondaryDb.close();
      }
    }
    case "corrupt-rebuild": {
      const corruptFilename = `/corrupt-rebuild-${runId}.sqlite`;
      const bytes = payload.bytes instanceof ArrayBuffer ? new Uint8Array(payload.bytes) : payload.bytes;
      const corruptBytes = bytes.slice();
      corruptBytes[0] ^= 0xff;
      let corruptImportRejected = false;
      let corruptOpenRejected = false;
      let corruptError = null;
      let corruptImportMs = null;
      let corruptOpenMs = null;
      const corruptImportStartedAt = performance.now();
      try {
        await importDb(corruptFilename, corruptBytes);
        corruptImportMs = performance.now() - corruptImportStartedAt;
        let corruptDb;
        const corruptOpenStartedAt = performance.now();
        try {
          corruptDb = openDb(corruptFilename);
          const integrity = scalar(corruptDb, "PRAGMA integrity_check");
          corruptOpenRejected = integrity !== "ok";
          if (!corruptOpenRejected) corruptError = "Corrupted header was accepted and integrity_check returned ok.";
        } catch (error) {
          corruptOpenRejected = true;
          corruptError = `${error.name || "Error"}: ${error.message || String(error)}`;
        } finally {
          corruptOpenMs = performance.now() - corruptOpenStartedAt;
          if (corruptDb?.pointer) corruptDb.close();
        }
      } catch (error) {
        corruptImportMs = performance.now() - corruptImportStartedAt;
        corruptImportRejected = true;
        corruptError = `${error.name || "Error"}: ${error.message || String(error)}`;
      }
      const rebuildImportStartedAt = performance.now();
      await importDb(corruptFilename, bytes);
      const rebuildImportMs = performance.now() - rebuildImportStartedAt;
      const rebuiltDb = openDb(corruptFilename);
      const integrity = scalar(rebuiltDb, "PRAGMA integrity_check");
      const entryCount = Number(scalar(rebuiltDb, "SELECT count(*) FROM entries"));
      const sample = query(rebuiltDb, payload.sampleKeys[0]).row;
      rebuiltDb.close();
      await unlinkDb(corruptFilename);
      return {
        method: "Flip the first SQLite header byte in a separate disposable database image before importing it; detect at import, open, or integrity-check time; rebuild from intact prebuilt bytes.",
        corruptionDetected: corruptImportRejected || corruptOpenRejected,
        corruptImportRejected,
        corruptImportMs,
        corruptOpenRejected,
        corruptOpenMs,
        corruptError,
        rebuildImportMs,
        rebuiltIntegrity: integrity,
        rebuiltEntryCount: entryCount,
        rebuiltSample: sample,
        disposableCopyRemoved: true,
      };
    }
    default:
      throw new Error(`Unknown benchmark worker action: ${action}`);
  }
}

self.onmessage = async event => {
  const { id, action, payload } = event.data || {};
  try {
    post(id, await dispatch(action, payload));
  } catch (error) {
    post(id, null, error);
  }
};
