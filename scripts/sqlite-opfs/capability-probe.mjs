#!/usr/bin/env node
// Read-only probe of an existing owned Obsidian page. It creates two temporary
// Blob workers (a tiny echo worker and pinned SQLite WASM initialization with
// automatic OPFS VFS installation explicitly disabled). It opens no database,
// writes no OPFS files, does not navigate, and disconnects without closing the
// browser.
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
    const securityPolicyViolations = [];
    const onViolation = event => securityPolicyViolations.push({
      blockedURI: event.blockedURI,
      effectiveDirective: event.effectiveDirective,
      violatedDirective: event.violatedDirective,
      sourceFile: event.sourceFile,
      disposition: event.disposition,
    });
    addEventListener("securitypolicyviolation", onViolation);
    try {
      pageApis.storageEstimate = await navigator.storage?.estimate?.() ?? null;
      pageApis.storagePersisted = await navigator.storage?.persisted?.() ?? null;
    } catch (error) {
      pageApis.storageError = `${error?.name || "Error"}: ${error?.message || String(error)}`;
    }

    const apiFacts = () => ({
      protocol: self.location.protocol,
      origin: self.location.origin,
      isSecureContext: self.isSecureContext,
      workerGlobal: typeof WorkerGlobalScope === "function" && self instanceof WorkerGlobalScope,
      webAssembly: typeof WebAssembly === "object" && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      crossOriginIsolated: self.crossOriginIsolated,
      opfsGetDirectory: typeof navigator.storage?.getDirectory === "function",
      opfsSyncAccessHandle: typeof FileSystemFileHandle === "function" && typeof FileSystemFileHandle.prototype?.createSyncAccessHandle === "function",
      webLocks: typeof navigator.locks?.request === "function",
    });

    const runWorker = async (source, timeoutMs, accept, onMessage = () => {}) => {
      const workerUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      let worker;
      let timer;
      try {
        worker = new Worker(workerUrl); // Keep the Blob URL exact; query suffixes invalidate it.
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`worker timed out after ${timeoutMs} ms`)), timeoutMs);
          worker.onmessage = event => {
            onMessage(event.data);
            if (accept(event.data)) {
              clearTimeout(timer);
              resolve(event.data);
            }
          };
          worker.onerror = event => {
            clearTimeout(timer);
            reject(Object.assign(new Error(event.message || "Worker error event"), {
              filename: event.filename || null,
              lineno: event.lineno || null,
              colno: event.colno || null,
            }));
          };
        });
      } finally {
        clearTimeout(timer);
        worker?.terminate();
        URL.revokeObjectURL(workerUrl);
      }
    };

    let basicBlobWorker = null;
    let basicBlobWorkerError = null;
    try {
      basicBlobWorker = await runWorker(
        `(async()=>{const api=(${apiFacts.toString()})();try{if(api.opfsGetDirectory){const directory=await navigator.storage.getDirectory();api.opfsRootHandle=directory?.constructor?.name||'FileSystemDirectoryHandle';}}catch(e){api.opfsRootError=(e?.name||'Error')+': '+(e?.message||String(e));}self.postMessage({stage:'echo',...api});})().catch(e=>self.postMessage({stage:'echo-error',error:{name:e?.name||'Error',message:e?.message||String(e)}}));`,
        1200,
        message => message?.stage === "echo" || message?.stage === "echo-error",
      );
      if (basicBlobWorker.stage === "echo-error") throw new Error(basicBlobWorker.error?.message || "Blob Worker echo failed");
    } catch (error) {
      basicBlobWorkerError = {
        message: error?.message || String(error),
        filename: error?.filename || null,
        lineno: error?.lineno || null,
        colno: error?.colno || null,
      };
    }

    // Disable VFS auto-installation before loading SQLite source. This permits
    // WASM and prerequisite checks without creating the async OPFS proxy,
    // SAH-pool metadata, or any database file.
    const workerSource = `
      globalThis.sqlite3ApiConfig = { disable: { vfs: { opfs: true, 'opfs-wl': true } } };
      const workerApis = (${apiFacts.toString()})();
      globalThis.postMessage({stage:'api', api:workerApis});
      ${sqliteSource}
      ;(async()=>{
        const sqliteInitStarted = performance.now();
        const wasmBinary = Uint8Array.from(atob(${JSON.stringify(wasmBase64)}), c => c.charCodeAt(0));
        const sqlite3 = await sqlite3InitModule({ wasmBinary });
        const api = {
          ...workerApis,
          sqliteVersion: sqlite3.capi.sqlite3_libversion(),
          sqliteWasmInitMs: performance.now() - sqliteInitStarted,
          sqliteVfsList: sqlite3.capi.sqlite3_js_vfs_list(),
          sqliteSahpoolInstallerPresent: typeof sqlite3.installOpfsSAHPoolVfs === 'function',
          sqliteOpfsUtilitiesPresent: Boolean(sqlite3.opfs),
          databaseOpened: false,
          vfsInstalled: false
        };
        try { sqlite3.opfs.vfsInstallationFeatureCheck('opfs'); api.sqliteStandardOpfsPrerequisites = true; }
        catch(e) { api.sqliteStandardOpfsPrerequisites = false; api.sqliteStandardOpfsPrerequisiteError = e?.message || String(e); }
        self.postMessage({stage:'sqlite-ready', api});
      })().catch(e=>self.postMessage({stage:'sqlite-error', error:{name:e?.name||'Error',message:e?.message||String(e),stack:e?.stack||null}}));
    `;
    let sqliteWorkerMessage = null;
    let sqliteWorkerError = null;
    const sqliteWorkerMessages = [];
    try {
      sqliteWorkerMessage = await runWorker(workerSource, 15_000,
        message => message?.stage === "sqlite-ready" || message?.stage === "sqlite-error",
        message => sqliteWorkerMessages.push(message));
      if (sqliteWorkerMessage.stage === "sqlite-error") {
        sqliteWorkerError = sqliteWorkerMessage.error;
        sqliteWorkerMessage = null;
      }
    } catch (error) {
      sqliteWorkerError = {
        name: error?.name || "Error",
        message: error?.message || String(error),
        filename: error?.filename || null,
        lineno: error?.lineno || null,
        colno: error?.colno || null,
        stack: error?.stack || null,
      };
    } finally {
      removeEventListener("securitypolicyviolation", onViolation);
    }

    const workerFacts = sqliteWorkerMessage?.api || basicBlobWorker || null;
    let classification = "UNSUPPORTED";
    if (sqliteWorkerMessage?.api?.sqliteStandardOpfsPrerequisites) {
      classification = "STANDARD_OPFS_PREREQUISITES_PASS_VFS_NOT_INSTALLED";
    } else if (sqliteWorkerMessage?.api?.sqliteSahpoolInstallerPresent &&
               sqliteWorkerMessage?.api?.opfsSyncAccessHandle) {
      classification = "SAHPOOL_CANDIDATE_REQUIRES_WRITE_PROBE";
    } else if (!sqliteWorkerMessage && basicBlobWorker) {
      classification = "SQLITE_WASM_INIT_UNRESOLVED_WORKER_API_AVAILABLE";
    }

    return {
      probe: "sqlite-wasm-opfs-read-only-host-capability",
      pinnedSqliteVersion: "3.54.1",
      readOnly: true,
      persistentStorageMutation: false,
      databaseOpened: false,
      vfsInstalled: false,
      pageApis,
      basicBlobWorker,
      basicBlobWorkerError,
      sqliteWorker: sqliteWorkerMessage?.api || null,
      sqliteWorkerMessages,
      sqliteWorkerError,
      securityPolicyViolations,
      workerProbeMs: performance.now() - pageStartedAt,
      sqliteRuntimeSourceBytes: sqliteSourceBytes,
      sqliteWasmBytes: wasmBytesLength,
      classification,
      limitations: [
        "The probe creates a temporary Blob worker and initializes pinned WASM with OPFS auto-install disabled.",
        "It opens no database and does not install the SAH pool or OPFS VFS; candidate status requires a later disposable-profile write probe.",
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
  targetUrl: report.targetUrl, pageApis: report.pageApis, basicBlobWorker: report.basicBlobWorker,
  sqliteWorker: report.sqliteWorker, sqliteWorkerError: report.sqliteWorkerError,
  securityPolicyViolations: report.securityPolicyViolations, workerProbeMs: report.workerProbeMs }, null, 2));
