import test from "node:test";
import assert from "node:assert/strict";
import {
  createNativeLearningLoopIsolationPlan,
  mapNativeLearningLoopAdapterArgs,
  mapNativeLearningLoopListResult,
  mapNativeLearningLoopPath,
  assertNativeLearningLoopInvariantUnchanged,
  assertNativeLearningLoopAdapterEvidence,
  summarizeNativeLearningLoopInvariant,
  NATIVE_LEARNING_DICTIONARY_ROOT,
  isAllowedNativeLearningLoopBundledPdfCacheWrite,
  serializeNativeLearningLoopIsolationInstaller,
} from "./native-learning-loop-isolation.mjs";

const plan = createNativeLearningLoopIsolationPlan({
  runId: "native-loop-20261023-ab12cd34",
  fixturePrefix: "PDF迁移测试/native-learning-loop-20261023-010203",
});

test("Native learning-loop isolation gives PDFData and all Vocabulary stores separate per-run roots", () => {
  assert.deepEqual(plan.roots, [
    {
      logicalRoot: "00_Archive/20_PDFData",
      physicalRoot: `${plan.storageRoot}/PDFData`,
    },
    {
      logicalRoot: "00_Archive/21_VocabularyData",
      physicalRoot: `${plan.storageRoot}/VocabularyData`,
    },
  ]);
  assert.equal(
    mapNativeLearningLoopPath("00_Archive/20_PDFData/wal/device/doc.jsonl", plan),
    `${plan.storageRoot}/PDFData/wal/device/doc.jsonl`,
  );
  assert.equal(
    mapNativeLearningLoopPath("00_Archive/21_VocabularyData/history/device/hash.json", plan),
    `${plan.storageRoot}/VocabularyData/history/device/hash.json`,
  );
  assert.equal(
    mapNativeLearningLoopPath("00_Archive/20_PDFData-old/file.json", plan),
    "00_Archive/20_PDFData-old/file.json",
  );
});

test("all DataAdapter path arguments, including both rename sides, route to the owned tree", () => {
  assert.deepEqual(mapNativeLearningLoopAdapterArgs("rename", [
    "00_Archive/21_VocabularyData/learning/items/manifest.json",
    "00_Archive/21_VocabularyData/learning/items/manifest.json.bak",
  ], plan), [
    `${plan.storageRoot}/VocabularyData/learning/items/manifest.json`,
    `${plan.storageRoot}/VocabularyData/learning/items/manifest.json.bak`,
  ]);
  assert.deepEqual(mapNativeLearningLoopAdapterArgs("list", [
    "00_Archive/20_PDFData/wal",
  ], plan), [`${plan.storageRoot}/PDFData/wal`]);
  assert.deepEqual(mapNativeLearningLoopAdapterArgs("unsupported", ["x"], plan), ["x"]);
});

test("dictionary reads remain read-through and every dictionary write is refused", () => {
  const dictionaryPath = `${NATIVE_LEARNING_DICTIONARY_ROOT}/ECDICT/resource-v2/entries.jsonl.gz`;
  assert.equal(mapNativeLearningLoopPath(dictionaryPath, plan), dictionaryPath);
  assert.throws(
    () => mapNativeLearningLoopPath(dictionaryPath, plan, { write: true }),
    { code: "NATIVE_LEARNING_DICTIONARY_WRITE_BLOCKED" },
  );
  assert.deepEqual(mapNativeLearningLoopAdapterArgs("readBinary", [dictionaryPath], plan), [dictionaryPath]);
  assert.throws(
    () => mapNativeLearningLoopAdapterArgs("writeBinary", [dictionaryPath, new Uint8Array()], plan),
    { code: "NATIVE_LEARNING_DICTIONARY_WRITE_BLOCKED" },
  );
});

test("only the shipped PDF.js sample in the plugin asset cache bypasses the user-PDF write guard", () => {
  const allowed = `${plan.configDir}/plugins/pdf-web-reader/.asset-cache/build-hash/web/compressed.tracemonkey-pldi-09.pdf`;
  assert.equal(isAllowedNativeLearningLoopBundledPdfCacheWrite("writeBinary", [allowed], plan), true);
  assert.equal(isAllowedNativeLearningLoopBundledPdfCacheWrite("writeBinary", ["PDF迁移测试/owned.pdf"], plan), false);
  assert.equal(isAllowedNativeLearningLoopBundledPdfCacheWrite("writeBinary", [
    `${plan.configDir}/plugins/pdf-web-reader/.asset-cache/../outside/web/compressed.tracemonkey-pldi-09.pdf`,
  ], plan), false);
  assert.equal(isAllowedNativeLearningLoopBundledPdfCacheWrite("write", [allowed], plan), false);
});

test("list results report virtual vault paths after reading the owned physical tree", () => {
  assert.deepEqual(mapNativeLearningLoopListResult({
    files: [`${plan.storageRoot}/PDFData/sidecars/doc.json`],
    folders: [`${plan.storageRoot}/VocabularyData/review/states`],
  }, plan), {
    files: ["00_Archive/20_PDFData/sidecars/doc.json"],
    folders: ["00_Archive/21_VocabularyData/review/states"],
  });
});

test("Vocabulary canonical, History, Context, Review and transaction bytes are invariant across route-only moves", () => {
  const before = summarizeNativeLearningLoopInvariant(new Map([
    ["00_Archive/21_VocabularyData/learning/items/item-a.json", Buffer.from('{"revision":1}\n')],
    ["00_Archive/21_VocabularyData/history/device/batch-a.json", Buffer.from('{"kind":"history"}\n')],
    ["00_Archive/21_VocabularyData/contexts/context.json", Buffer.from('{"kind":"context"}\n')],
    ["00_Archive/21_VocabularyData/review/states/review.json", Buffer.from('{"kind":"review"}\n')],
    ["00_Archive/21_VocabularyData/transactions/device/000001.jsonl", Buffer.from('{"kind":"transaction"}\n')],
    ["00_Archive/21_VocabularyData/routing/markdown/owners/ab/owner/fact-1.json", Buffer.from('{"currentPath":"old.md"}\n')],
  ]));
  const after = summarizeNativeLearningLoopInvariant(new Map([
    ["00_Archive/21_VocabularyData/learning/items/item-a.json", Buffer.from('{"revision":1}\n')],
    ["00_Archive/21_VocabularyData/history/device/batch-a.json", Buffer.from('{"kind":"history"}\n')],
    ["00_Archive/21_VocabularyData/contexts/context.json", Buffer.from('{"kind":"context"}\n')],
    ["00_Archive/21_VocabularyData/review/states/review.json", Buffer.from('{"kind":"review"}\n')],
    ["00_Archive/21_VocabularyData/transactions/device/000001.jsonl", Buffer.from('{"kind":"transaction"}\n')],
    ["00_Archive/21_VocabularyData/routing/markdown/owners/ab/owner/fact-2.json", Buffer.from('{"currentPath":"new.md"}\n')],
  ]));
  assert.equal(before.fileCount, 5);
  assert.equal(after.fileCount, 5);
  assert.equal(assertNativeLearningLoopInvariantUnchanged(before, after), true);
});

test("the route-only invariant detects any History or canonical Review/Context byte change", () => {
  const before = summarizeNativeLearningLoopInvariant(new Map([
    ["00_Archive/21_VocabularyData/history/device/batch.json", Buffer.from("before")],
  ]));
  const after = summarizeNativeLearningLoopInvariant(new Map([
    ["00_Archive/21_VocabularyData/history/device/batch.json", Buffer.from("after")],
  ]));
  assert.throws(() => assertNativeLearningLoopInvariantUnchanged(before, after), /changed Vocabulary/u);
});

test("write evidence requires both PDFData and VocabularyData writes to use their per-run roots", () => {
  const good = [
    { write: true, logicalPath: "00_Archive/20_PDFData/wal/device/doc.jsonl", storagePath: `${plan.roots[0].physicalRoot}/wal/device/doc.jsonl` },
    { write: true, logicalPath: "00_Archive/21_VocabularyData/learning/items/item.json", storagePath: `${plan.roots[1].physicalRoot}/learning/items/item.json` },
  ];
  assert.equal(assertNativeLearningLoopAdapterEvidence(good, plan), true);
  assert.throws(() => assertNativeLearningLoopAdapterEvidence([
    { write: true, logicalPath: good[1].logicalPath, storagePath: good[1].logicalPath },
  ], plan), /escaped per-run storage/u);
  assert.throws(() => assertNativeLearningLoopAdapterEvidence([
    { write: true, method: "write", logicalPath: "00_Archive/21_VocabularyData/dictionaries/index.json", storagePath: "", blocked: "NATIVE_LEARNING_DICTIONARY_WRITE_BLOCKED" },
  ], plan), /prohibited PDF or dictionary/u);
});

test("the serialized installer carries both roots, blocks user PDFs, and permits only the bundled sample asset", async () => {
  const source = serializeNativeLearningLoopIsolationInstaller(plan);
  assert.match(source, /installNativeLearningLoopIsolation/u);
  assert.match(source, /NATIVE_LEARNING_DICTIONARY_WRITE_BLOCKED/u);
  assert.match(source, new RegExp(plan.roots[0].physicalRoot.replaceAll("/", "\\/"), "u"));
  assert.match(source, new RegExp(plan.roots[1].physicalRoot.replaceAll("/", "\\/"), "u"));
  assert.doesNotThrow(() => new Function(source));
  const adapter = Object.fromEntries([
    "read", "write", "readBinary", "writeBinary", "append", "appendBinary", "remove", "rename",
    "exists", "mkdir", "list", "process", "removeFile", "update", "copy", "copyRecursive",
  ].map(method => [method, async () => true]));
  const writes = [];
  adapter.writeBinary = async path => { writes.push(path); return true; };
  const previousWindow = globalThis.window;
  globalThis.window = { app: { vault: { adapter } } };
  try {
    assert.equal(new Function(source)().includes(plan.runId), true);
    const bundledPdf = `${plan.configDir}/plugins/pdf-web-reader/.asset-cache/build-hash/web/compressed.tracemonkey-pldi-09.pdf`;
    await adapter.writeBinary(bundledPdf, new Uint8Array([1]));
    await assert.rejects(adapter.writeBinary("PDF迁移测试/other.pdf", new Uint8Array([2])), {
      code: "NATIVE_LEARNING_PDF_WRITE_BLOCKED",
    });
    assert.deepEqual(writes, [bundledPdf]);
    assert.equal(globalThis.window.__nativeLearningLoopIsolation.restore(), true);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("the isolation plan rejects unsafe run and fixture paths", () => {
  assert.throws(() => createNativeLearningLoopIsolationPlan({
    runId: "../outside",
    fixturePrefix: "PDF迁移测试/native-learning-loop-20261023-010203",
  }), /unique lowercase path-safe identifier/u);
  assert.throws(() => createNativeLearningLoopIsolationPlan({
    runId: "native-loop-20261023-ab12cd34",
    fixturePrefix: "PDF迁移测试/../formal-vault",
  }), /unique owned test folder/u);
});
