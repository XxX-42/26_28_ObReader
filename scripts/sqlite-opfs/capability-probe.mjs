#!/usr/bin/env node
// Read-only native-host probe. It attaches to an existing owned Obsidian CDP
// session, creates a temporary Blob worker, initializes the pinned SQLite
// WASM runtime without opening a database, then detaches without closing Chrome.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactRoot = path.join(root, "tests/artifacts/sqlite-opfs-2026-10-23");
const assetRoot = path.join(artifactRoot, "runtime/sqlite-wasm-3540100/jswasm");
const defaults = {
  cdpUrl: "http://127.0.0.1:60096",
  targetPrefix: "app://obsidian.md",
  output: path.join(root, "tests/output/sqlite-opfs/host-capability.json"),
};

function readOptions(argv) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cdp-url") options.cdpUrl = argv[++index];
    else if (argument === "--target-prefix") options.targetPrefix = argv[++index];
    else if (argument === "--output") options.output = path.resolve(argv[++index]);
    else if (argument === "--help") {
      console.log("Usage: node scripts/sqlite-opfs/capability-probe.mjs [--cdp-url URL] [--target-prefix app://...] [--output FILE]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const options = readOptions(process.argv.slice(2));
const sqliteSource = await readFile(path.join(assetRoot, "sqlite3.js"), "utf8");
const wasmBytes = await readFile(path.join(assetRoot, "sqlite3.wasm"));
const wasmBase64 = wasmBytes.toString("base64");
const browser = await puppeteer.connect({ browserURL: options.cdpUrl, defaultViewport: null });

let report;
try {
  const appPages = (await browser.pages()).filter(page => page.url().startsWith(options.targetPrefix));
  assert.equal(appPages.length, 1,
    `Expected exactly one existing target beginning ${options.targetPrefix}; found ${appPages.length}. Pass --target-prefix to select an owned app page.`);
  const page = appPages[0];
  const pageUrl = page.url();
  report = await page.evaluate(async ({ sqliteSource, wasmBase64, sqliteSourceBytes, wasmBytesLength }) => {
    const pageStartedAt = performance.now();
    const longTaskSupported = typeof PerformanceObserver === "function" &&
      PerformanceObserver.supportedEntryTypes?.includes("longtask") === true;
    const pageApis = {
      protocol: location.protocol,
      origin: location.origin,
      isSecureContext,
      workerConstructor: typeof Worker === "function",
      webAssembly: typeof WebAssembly === "object" && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      crossOriginIsolated,
      opfsInMainThread: typeof navigator.storage?.getDirectory === "function",
      webLocks: typeof navigator.locks?.request === "function",
      longTaskObserver: longTaskSupported,
      userAgent: navigator.userAgent,
    };
    try {
      pageApis.storageEstimate = await navigator.storage?.estimate?.() ?? null;
      pageApis.storagePersisted = await navigator.storage?.persisted?.() ?? null;
    } catch (error) {
      pageApis.storageError = `${error?.name || "Error"}: ${error?.message || String(error)}`;
    }

    const wasmDataUrl = `data:application/wasm;base64,${wasmBase64}`;
    const workerSource = `${sqliteSource}\n;\n(async()=>{\n  const api={\n    protocol: self.location.protocol, origin: self.location.origin,\n    isSecureContext: self.isSecureContext,\n    workerGlobal: typeof WorkerGlobalScope === 'function' && self instanceof WorkerGlobalScope,\n    webAssembly: typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0])),\n    sharedArrayBuffer: typeof SharedArrayBuffer === 'function', crossOriginIsolated: self.crossOriginIsolated,\n    opfsGetDirectory: typeof navigator.storage?.getDirectory === 'function',\n    opfsSyncAccessHandle: typeof FileSystemFileHandle === 'function' && typeof FileSystemFileHandle.prototype?.createSyncAccessHandle === 'function',\n    webLocks: typeof navigator.locks?.request === 'function'\n  };\n  try {\n    api.storageEstimate = await navigator.storage?.estimate?.() ?? null;\n    api.storagePersisted = await navigator.storage?.persisted?.() ?? null;\n  } catch(e) { api.storageError = (e?.name || 'Error') + ': ' + (e?.message || String(e)); }\n  if(api.opfsGetDirectory) {\n    try { const directory = await navigator.storage.getDirectory(); api.opfsRootHandle = directory?.constructor?.name || 'FileSystemDirectoryHandle'; }\n    catch(e) { api.opfsError = (e?.name || 'Error') + ': ' + (e?.message || String(e)); }\n  }\n  try {\n    const sqliteInitStarted = performance.now();\n    const sqlite3 = await sqlite3InitModule({ locateFile: name => name === 'sqlite3.wasm' ? ${JSON.stringify(wasmDataUrl)} : name });\n    api.sqliteVersion = sqlite3.capi.sqlite3_libversion();\n    api.sqliteWasmInitMs = performance.now() - sqliteInitStarted;\n    api.sqliteOpfsVfsInstallationNotAttempted = true;\n    api.sqliteSahpoolInstallerPresent = typeof sqlite3.installOpfsSAHPoolVfs === 'function';\n    try { sqlite3.opfs.vfsInstallationFeatureCheck('opfs'); api.sqliteStandardOpfsPrerequisites = true; }\n    catch(e) { api.sqliteStandardOpfsPrerequisites = false; api.sqliteStandardOpfsPrerequisiteError = e?.message || String(e); }\n    api.sqliteDbOpened = false;\n  } catch(e) { api.sqliteInitializationError = (e?.name || 'Error') + ': ' + (e?.message || String(e)); }\n  self.postMessage({api});\n})().catch(e=>self.postMessage({workerError:(e?.name||'Error')+': '+(e?.message||String(e))}));`;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    let worker;
    let workerFacts;
    let workerError;
    const workerStartedAt = performance.now();
    try {
      workerFacts = await new Promise((resolve, reject) => {
        worker = new Worker(`${workerUrl}?opfs-disable&opfs-wl-disable`);
        const timeout = setTimeout(() => reject(new Error("SQLite WASM worker initialization timed out after 15 seconds")), 15_000);
        worker.onmessage = event => {
          clearTimeout(timeout);
          if (event.data?.workerError) reject(new Error(event.data.workerError));
          else resolve(event.data?.api || null);
        };
        worker.onerror = event => {
          clearTimeout(timeout);
          reject(new Error(event.message || "Blob worker initialization failed"));
        };
      });
    } catch (error) {
      workerError = `${error?.name || "Error"}: ${error?.message || String(error)}`;
    } finally {
      worker?.terminate();
      URL.revokeObjectURL(workerUrl);
    }
    const workerProbeMs = performance.now() - workerStartedAt;
    const opfsApiReady = Boolean(workerFacts?.isSecureContext && workerFacts?.workerGlobal &&
      workerFacts?.webAssembly && workerFacts?.opfsGetDirectory && !workerFacts?.opfsError &&
      workerFacts?.opfsSyncAccessHandle);
    let classification = "UNSUPPORTED";
    if (workerFacts?.sqliteStandardOpfsPrerequisites) classification = "STANDARD_OPFS_PREREQUISITES_PASS_VFS_NOT_INSTALLED";
    else if (opfsApiReady && workerFacts?.sqliteSahpoolInstallerPresent) classification = "SAHPOOL_CANDIDATE_REQUIRES_WRITE_PROBE";

    return {
      probe: "sqlite-wasm-opfs-read-only-host-capability",
      pinnedSqliteVersion: "3.54.1",
      readOnly: true,
      persistentStorageMutation: false,
      databaseOpened: false,
      pageApis,
      worker: workerFacts || null,
      workerError: workerError || null,
      workerProbeMs,
      sqliteRuntimeSourceBytes: sqliteSourceBytes,
      sqliteWasmBytes: wasmBytesLength,
      sqliteWasmInitMs: workerFacts?.sqliteWasmInitMs ?? null,
      classification,
      limitations: [
        "The probe opens no database and does not install the OPFS SAH pool, which can create persistent OPFS metadata.",
        "SAHPOOL_CANDIDATE_REQUIRES_WRITE_PROBE means browser APIs are present; a disposable-origin SQLite VFS open remains untested.",
        "Storage quota and usage are origin estimates, not measurements of SQLite profile growth.",
      ],
      pageProbeMs: performance.now() - pageStartedAt,
    };
  }, { sqliteSource, wasmBase64, sqliteSourceBytes: Buffer.byteLength(sqliteSource), wasmBytesLength: wasmBytes.byteLength });
  report.cdpUrl = options.cdpUrl;
  report.targetUrl = pageUrl;
  report.probedAt = new Date().toISOString();
} finally {
  browser.disconnect();
}

await mkdir(path.dirname(options.output), { recursive: true });
await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: options.output, classification: report.classification,
  targetUrl: report.targetUrl, pageApis: report.pageApis, worker: report.worker,
  workerError: report.workerError, workerProbeMs: report.workerProbeMs }, null, 2));
