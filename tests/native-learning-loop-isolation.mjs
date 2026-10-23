import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const NATIVE_LEARNING_STORE_ROOTS = Object.freeze([
  "00_Archive/20_PDFData",
  "00_Archive/21_VocabularyData",
]);

export const NATIVE_LEARNING_DICTIONARY_ROOT =
  "00_Archive/21_VocabularyData/dictionaries";
export const NATIVE_LEARNING_ROUTE_FACTS_ROOT =
  "00_Archive/21_VocabularyData/routing/markdown";

const ADAPTER_PATH_METHODS = new Set([
  "read", "write", "readBinary", "writeBinary", "append", "appendBinary",
  "remove", "rename", "exists", "mkdir", "list", "process",
  "removeFile", "update", "copy", "copyRecursive",
]);

const ADAPTER_WRITE_METHODS = new Set([
  "write", "writeBinary", "append", "appendBinary", "remove", "rename",
  "mkdir", "process", "removeFile", "update", "copy", "copyRecursive",
]);

function pathText(value) {
  return typeof value === "string" ? value :
    value && typeof value.path === "string" ? value.path : "";
}

function under(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function routeFor(path, plan) {
  for (const root of plan.roots) {
    if (under(path, root.logicalRoot)) {
      return { root, suffix: path.slice(root.logicalRoot.length) };
    }
  }
  return null;
}

export function isAllowedNativeLearningLoopBundledPdfCacheWrite(method, args, plan) {
  if (method !== "writeBinary") return false;
  const first = args?.[0];
  const path = typeof first === "string" ? first : typeof first?.path === "string" ? first.path : "";
  const prefix = `${plan.configDir}/plugins/pdf-web-reader/.asset-cache/`;
  return path.startsWith(prefix) &&
    path.endsWith("/web/compressed.tracemonkey-pldi-09.pdf") &&
    !path.split("/").some(part => part === "." || part === "..");
}

export function createNativeLearningLoopIsolationPlan({ runId, configDir = ".obsidian", fixturePrefix } = {}) {
  assert.equal(typeof runId, "string", "Native learning run ID must be text");
  assert.match(runId, /^[a-z0-9][a-z0-9-]{5,79}$/u,
    "Native learning run ID must be a unique lowercase path-safe identifier");
  assert.equal(typeof configDir, "string");
  assert.ok(configDir && !configDir.startsWith("/") && !configDir.includes(".."),
    "Native learning isolation configDir must stay relative to the test vault");
  assert.equal(typeof fixturePrefix, "string");
  assert.match(fixturePrefix, /^PDF迁移测试\/native-learning-loop-[a-z0-9-]+$/u,
    "Native learning fixture path must be under its unique owned test folder");

  const storageRoot = `${configDir}/plugins/pdf-web-reader/.native-learning-loop/${runId}`;
  return Object.freeze({
    runId,
    configDir,
    fixturePrefix,
    storageRoot,
    dictionaryRoot: NATIVE_LEARNING_DICTIONARY_ROOT,
    roots: Object.freeze(NATIVE_LEARNING_STORE_ROOTS.map((logicalRoot, index) => Object.freeze({
      logicalRoot,
      physicalRoot: `${storageRoot}/${index === 0 ? "PDFData" : "VocabularyData"}`,
    }))),
  });
}

export function mapNativeLearningLoopPath(value, plan, { write = false } = {}) {
  const path = pathText(value);
  if (!path) return value;
  if (under(path, plan.dictionaryRoot)) {
    if (write) {
      const error = new Error(`Immutable dictionary writes are blocked: ${path}`);
      error.code = "NATIVE_LEARNING_DICTIONARY_WRITE_BLOCKED";
      throw error;
    }
    return value;
  }
  const route = routeFor(path, plan);
  if (!route) return value;
  const physical = `${route.root.physicalRoot}${route.suffix}`;
  return typeof value === "string" ? physical : { ...value, path: physical };
}

export function mapNativeLearningLoopAdapterArgs(method, args, plan) {
  if (!ADAPTER_PATH_METHODS.has(method) || !args.length) return [...args];
  const mapped = [...args];
  const write = ADAPTER_WRITE_METHODS.has(method);
  mapped[0] = mapNativeLearningLoopPath(mapped[0], plan, { write });
  if (["rename", "copy", "copyRecursive"].includes(method) && typeof mapped[1] === "string") {
    mapped[1] = mapNativeLearningLoopPath(mapped[1], plan, { write });
  }
  return mapped;
}

export function mapNativeLearningLoopListResult(result, plan) {
  if (!result || typeof result !== "object") return result;
  const mapEntry = (value) => {
    const path = pathText(value);
    if (!path) return value;
    for (const root of plan.roots) {
      if (under(path, root.physicalRoot)) {
        const mapped = `${root.logicalRoot}${path.slice(root.physicalRoot.length)}`;
        return typeof value === "string" ? mapped : { ...value, path: mapped };
      }
    }
    return value;
  };
  return {
    ...result,
    ...(Array.isArray(result.files) ? { files: result.files.map(mapEntry) } : {}),
    ...(Array.isArray(result.folders) ? { folders: result.folders.map(mapEntry) } : {}),
  };
}

// This function is stringified and evaluated in the exact identity-checked
// Obsidian renderer. Keep all dependencies in its arguments or local scope.
function installNativeLearningLoopIsolation(plan) {
  const app = window.app;
  if (!app?.vault?.adapter) throw new Error("Obsidian DataAdapter is not available");
  if (window.__nativeLearningLoopIsolation) {
    throw new Error("A Native learning-loop isolation layer is already installed");
  }
  const adapter = app.vault.adapter;
  const adapterMethods = [
    "read", "write", "readBinary", "writeBinary", "append", "appendBinary",
    "remove", "rename", "exists", "mkdir", "list", "process",
    "removeFile", "update", "copy", "copyRecursive",
  ];
  const pathMethods = new Set(adapterMethods);
  const writeMethods = new Set([
    "write", "writeBinary", "append", "appendBinary", "remove", "rename",
    "mkdir", "process", "removeFile", "update", "copy", "copyRecursive",
  ]);
  const dictionaryRoot = plan.dictionaryRoot;
  const owns = (path, root) => path === root || path.startsWith(`${root}/`);
  const mapPath = (value, write) => {
    const path = typeof value === "string" ? value : value && typeof value.path === "string" ? value.path : "";
    if (!path) return value;
    if (owns(path, dictionaryRoot)) {
      if (write) throw Object.assign(new Error(`Immutable dictionary writes are blocked: ${path}`), {
        code: "NATIVE_LEARNING_DICTIONARY_WRITE_BLOCKED",
      });
      return value;
    }
    for (const root of plan.roots) {
      if (!owns(path, root.logicalRoot)) continue;
      const mapped = `${root.physicalRoot}${path.slice(root.logicalRoot.length)}`;
      return typeof value === "string" ? mapped : { ...value, path: mapped };
    }
    return value;
  };
  const mapList = result => {
    if (!result || typeof result !== "object") return result;
    const mapEntry = value => {
      const path = typeof value === "string" ? value : value && typeof value.path === "string" ? value.path : "";
      if (!path) return value;
      for (const root of plan.roots) {
        if (owns(path, root.physicalRoot)) {
          const mapped = `${root.logicalRoot}${path.slice(root.physicalRoot.length)}`;
          return typeof value === "string" ? mapped : { ...value, path: mapped };
        }
      }
      return value;
    };
    return {
      ...result,
      ...(Array.isArray(result.files) ? { files: result.files.map(mapEntry) } : {}),
      ...(Array.isArray(result.folders) ? { folders: result.folders.map(mapEntry) } : {}),
    };
  };
  const isTestPdfRename = (method, args) => {
    if (method !== "rename") return false;
    const from = typeof args[0] === "string" ? args[0] : args[0]?.path;
    const to = typeof args[1] === "string" ? args[1] : args[1]?.path;
    return typeof from === "string" && typeof to === "string" &&
      from.toLowerCase().endsWith(".pdf") && to.toLowerCase().endsWith(".pdf") &&
      (from === plan.fixturePrefix || from.startsWith(`${plan.fixturePrefix}/`)) &&
      (to === plan.fixturePrefix || to.startsWith(`${plan.fixturePrefix}/`));
  };
  const originals = [];
  const calls = [];
  for (const method of adapterMethods) {
    if (typeof adapter[method] !== "function") continue;
    const original = adapter[method];
    originals.push({ method, original });
    adapter[method] = async function(...args) {
      const write = writeMethods.has(method);
      const sourcePath = typeof args[0] === "string" ? args[0] : args[0]?.path || "";
      const call = { method, logicalPath: sourcePath, storagePath: "", write,
        at: new Date().toISOString(), durationMs: null, blocked: null };
      calls.push(call);
      const pdfPathTargets = [sourcePath];
      if (["rename", "copy", "copyRecursive"].includes(method)) {
        pdfPathTargets.push(typeof args[1] === "string" ? args[1] : args[1]?.path || "");
      }
      const allowedAssetCachePdf = isAllowedNativeLearningLoopBundledPdfCacheWrite(method, args, plan);
      if (allowedAssetCachePdf) call.allowedException = "bundled-pdfjs-viewer-sample-cache";
      if (write && pdfPathTargets.some(path => path.toLowerCase().endsWith(".pdf")) &&
          !isTestPdfRename(method, args) && !allowedAssetCachePdf) {
        const error = Object.assign(new Error(`Native learning-loop PDF writes are blocked: ${method} ${pdfPathTargets.join(" -> ")}`), {
          code: "NATIVE_LEARNING_PDF_WRITE_BLOCKED",
        });
        call.blocked = error.code;
        throw error;
      }
      const mapped = [...args];
      try {
        if (pathMethods.has(method)) {
          mapped[0] = mapPath(mapped[0], write);
          if (["rename", "copy", "copyRecursive"].includes(method) && mapped.length > 1) {
            mapped[1] = mapPath(mapped[1], write);
          }
        }
      } catch (error) {
        call.blocked = error?.code || "PATH_MAPPING_ERROR";
        throw error;
      }
      const storagePath = typeof mapped[0] === "string" ? mapped[0] : mapped[0]?.path || "";
      call.storagePath = storagePath;
      const startedAt = Date.now();
      let result;
      try {
        result = await original.apply(this, mapped);
      } catch (error) {
        call.blocked = error?.code || "ADAPTER_ERROR";
        throw error;
      } finally {
        call.durationMs = Date.now() - startedAt;
      }
      if (method === "list") return mapList(result);
      return result;
    };
  }
  const state = {
    runId: plan.runId,
    fixturePrefix: plan.fixturePrefix,
    storageRoot: plan.storageRoot,
    roots: plan.roots,
    dictionaryRoot,
    calls,
    originals,
    restore() {
      for (const { method, original } of originals) adapter[method] = original;
      if (window.__nativeLearningLoopIsolation === state) delete window.__nativeLearningLoopIsolation;
      return true;
    },
  };
  window.__nativeLearningLoopIsolation = state;
  return JSON.stringify({
    installed: true,
    runId: plan.runId,
    roots: plan.roots,
    dictionaryRoot,
    adapterMethods: originals.map(row => row.method),
  });
}

export function serializeNativeLearningLoopIsolationInstaller(plan) {
  const source = [
    `const ADAPTER_PATH_METHODS = ${JSON.stringify([...ADAPTER_PATH_METHODS])};`,
    `const isAllowedNativeLearningLoopBundledPdfCacheWrite = (${isAllowedNativeLearningLoopBundledPdfCacheWrite.toString()});`,
    `const installNativeLearningLoopIsolation = (${installNativeLearningLoopIsolation.toString()});`,
    `return installNativeLearningLoopIsolation(${JSON.stringify(plan)});`,
  ].join("\n");
  // Validate the emitted source before dispatching it to a live renderer.
  new Function(source);
  return source;
}

export function summarizeNativeLearningLoopInvariant(files) {
  const entries = [...files.entries()]
    .filter(([path]) => !under(path, NATIVE_LEARNING_ROUTE_FACTS_ROOT))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze({
    fileCount: entries.length,
    files: Object.freeze(entries.map(([path, bytes]) => Object.freeze({
      path,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }))),
  });
}

export function assertNativeLearningLoopInvariantUnchanged(before, after, label = "Native route move") {
  assert.deepEqual(after.files, before.files,
    `${label} changed Vocabulary/Context/Review/History/transaction bytes outside immutable Markdown route facts`);
  assert.equal(after.fileCount, before.fileCount,
    `${label} added or removed a non-route Vocabulary data file`);
  return true;
}

export function assertNativeLearningLoopAdapterEvidence(calls, plan) {
  const blocked = calls.filter(call => call.blocked === "NATIVE_LEARNING_PDF_WRITE_BLOCKED" ||
    call.blocked === "NATIVE_LEARNING_DICTIONARY_WRITE_BLOCKED");
  assert.deepEqual(blocked, [], "Native loop attempted a prohibited PDF or dictionary write");
  for (const call of calls) {
    if (!call.write) continue;
    if (under(call.logicalPath, plan.dictionaryRoot)) {
      assert.fail(`Dictionary write escaped the guard: ${call.method} ${call.logicalPath}`);
    }
    const root = plan.roots.find(candidate => under(call.logicalPath, candidate.logicalRoot));
    if (!root) continue;
    assert.ok(under(call.storagePath, root.physicalRoot),
      `Sidecar write escaped per-run storage: ${call.logicalPath} -> ${call.storagePath}`);
  }
  return true;
}
