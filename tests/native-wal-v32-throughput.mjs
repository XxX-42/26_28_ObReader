import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeConfig, nativeEvalJson, assertNativeVaultIdentity, nativeCdp } from "./native-config.mjs";
import { verifyNativeWalColdReopen } from "./native-wal-v32-cold-reopen.mjs";
import { expectedNativeRows, expectedNativeOperations, snapshotHash } from "./wal-v32-native-fixture.mjs";

const relativePdf = process.env.WAL_V32_RELATIVE_PDF || "PDF迁移测试/wal-v32-native-20261016-01.pdf";
const runId = process.env.WAL_V32_RUN_ID || "wal-v32-native-20261016-01";
const absolutePdf = `${nativeConfig.vault}\\${relativePdf.replaceAll("/", "\\")}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const beforeBytes = await readFile(absolutePdf);
const beforeStat = await stat(absolutePdf);
const beforeHash = sha256(beforeBytes);
const originalPdf=process.env.WAL_V32_SOURCE_PDF || String.raw`D:\Documents\Obsidian\远程仓库1\12_books\原则 (瑞·达利欧) (z-library.sk, 1lib.sk, z-lib.sk).pdf`;
const originalBefore={hash:sha256(await readFile(originalPdf)),mtimeMs:(await stat(originalPdf)).mtimeMs};
assert.equal(beforeHash,originalBefore.hash,"fixture must match its immutable source");

const preflight = nativeEvalJson(`JSON.stringify({
  vault: app.vault.adapter.basePath,
  configDir: app.vault.configDir,
  pluginEnabled: app.plugins.enabledPlugins.has("pdf-web-reader"),
  protocol: app.plugins.plugins["pdf-web-reader"]?.annotationHost?.store?.sourceProtocol,
  activeType: app.workspace.activeLeaf?.view?.getViewType?.(),
  activePath: app.workspace.activeLeaf?.view?.file?.path,
  ready: app.workspace.activeLeaf?.view?.annotationHydrationAllowed === true,
  docKey: app.workspace.activeLeaf?.view?.annotationDocument?.docKey,
})`);
assertNativeVaultIdentity(preflight);
assert.equal(preflight.pluginEnabled, true);
assert.equal(preflight.protocol, "wal-sidecar-v3.2-jsonl");
assert.equal(preflight.activeType, "pdf-web-reader-view");
assert.equal(preflight.activePath, relativePdf);
assert.equal(preflight.ready, true);
assert.ok(preflight.docKey);

const heapBefore = nativeCdp("Runtime.getHeapUsage");
const runtimeExpression = `(async () => {
  const plugin = app.plugins.plugins["pdf-web-reader"];
  const view = app.workspace.activeLeaf.view;
  const document = view.annotationDocument;
  const store = plugin.annotationHost.store;
  const samples = [];
  const heapSamples = [];
  const ioSamples=[];
  const run = ${JSON.stringify(runId)};
  const initial=await store.readDocument(document);
  if(initial.annotations.length)throw Error("Benchmark requires a document with no active annotations");
  let expectedLast;
  const adapter=app.vault.adapter;
  const watchedPath=store.pathsFor(document).jsonlWal;
  const restore=[];
  let appendMs=0;
  const wrap=(target,key,match,record)=>{
    if(!target||typeof target[key]!=="function")return;
    const descriptor=Object.getOwnPropertyDescriptor(target,key);
    const original=target[key];
    target[key]=async function(...args){
      if(!match(args))return original.apply(this,args);
      const start=performance.now();try{return await original.apply(this,args)}
      finally{record(performance.now()-start)};
    };
    restore.push(()=>{if(descriptor)Object.defineProperty(target,key,descriptor);else delete target[key]});
  };
  wrap(adapter,"append",args=>args[0]===watchedPath,ms=>appendMs+=ms);
  try{
  for (let index = 0; index < 1000; index++) {
    const uuid = run + "-" + index;
    const operation = { uuid, kind: "Square", pageIndex: index % 357, deleted: false,
      payload: { editor: { annotationType: 5, rect: [100+index%7, 100, 200+index%7, 200],
        color: [index%256,17,231], thickness:2, opacity:0.9 }, benchmark:{ordinal:index+1,run} },
      clock: { timestamp: Date.now(), logical: index, deviceId: "native-benchmark", opId: uuid } };
    const started = performance.now();
    appendMs=0;
    const saved = await store.appendOperations({ document,
      sourceHash: document.source.sourceHash, operations: [operation] });
    samples.push(performance.now() - started);
    ioSamples.push({index,totalMs:samples.at(-1),...saved.timings,adapterAppendMs:appendMs});
    if (saved.operationCount !== 1 || !saved.acknowledged) throw new Error("WAL append was not acknowledged");
    if(index===999){const stored=saved.state.annotations[uuid];
      if(stored.originOpId!==uuid)throw Error("Last operation origin is incomplete");
      expectedLast={uuid,kind:operation.kind,pageIndex:operation.pageIndex,embeddedRef:null,deleted:false,
        payload:operation.payload,version:stored.version,clock:{timestamp:stored.version.rev,
          logical:stored.version.seq,deviceId:stored.version.deviceId,opId:saved.batchId}};}
    if (index % 100 === 99) heapSamples.push({ count: index + 1,
      usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null });
  }
  }finally{for(const undo of restore.reverse())undo()}
  const ordered = [...samples].sort((a, b) => a - b);
  const percentile = (p) => ordered[Math.ceil(ordered.length * p) - 1];
  const summarize=values=>{const sorted=[...values].sort((a,b)=>a-b);return{
    meanMs:values.reduce((a,b)=>a+b,0)/values.length,p50Ms:sorted[499],p99Ms:sorted[989],maxMs:sorted.at(-1)}};
  const snapshot = await store.readDocument(document);
  if(JSON.stringify(snapshot.tombstones)!==JSON.stringify(initial.tombstones))throw Error("Existing tombstones changed");
  const benchmarkRows = snapshot.annotations.filter((row) => row.uuid.startsWith(run + "-"));
  const checkpoint=await store.materializeSnapshot(document);
  return JSON.stringify({ count: samples.length, meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    p50Ms: percentile(0.50), p90Ms: percentile(0.90), p99Ms: percentile(0.99),
    maxMs: ordered.at(-1), heapSamples, annotationCount: benchmarkRows.length,
    stages:{adapterAppend:summarize(ioSamples.map(s=>s.adapterAppendMs)),
      processing:summarize(ioSamples.map(s=>s.captureMs+s.processingMs)),
      storeQueue:summarize(ioSamples.map(s=>s.queueWaitMs)),
      encode:summarize(ioSamples.map(s=>s.encodeMs)),
      nonAdapter:summarize(ioSamples.map(s=>s.totalMs-s.adapterAppendMs))},
    slowest:[...ioSamples].sort((a,b)=>b.totalMs-a.totalMs).slice(0,12),
    protocol: snapshot.storageProtocol, syncPending: snapshot.syncPending === true,
    totalAnnotationCount:snapshot.annotations.length, checkpointCount:checkpoint.annotations.length,
    baselineTombstoneCount:initial.tombstones.length,tombstonesUnchanged:true,
    expectedLast, document, sourceHash: document.source.sourceHash, docKey: document.docKey });
})()`;
assert.match(runId,/^[a-zA-Z0-9_-]+$/,"runId must be a safe artifact filename");
const artifactDir=path.join(nativeConfig.vault,nativeConfig.configDir,"plugins","pdf-web-reader",".native-test-output");
await mkdir(artifactDir,{recursive:true});
const inputArtifact=path.join(artifactDir,`${runId}-${Date.now()}.js`);
await writeFile(inputArtifact,runtimeExpression,{encoding:"utf8",flag:"wx"});
const result=nativeEvalJson(`eval(require("node:fs").readFileSync(${JSON.stringify(inputArtifact)},"utf8"))`,180_000);
const heapAfter = nativeCdp("Runtime.getHeapUsage");
const expectedRows=expectedNativeRows({runId,docKey:result.docKey,lastVersion:result.expectedLast.version});
assert.deepEqual(result.expectedLast,expectedRows.at(-1));
const expectedStateHash=snapshotHash(expectedRows);
const expectedOperationHash=snapshotHash(expectedNativeOperations(expectedRows));
const coldRecovery=await verifyNativeWalColdReopen({relativePdf,document:result.document,
  expectedLast:result.expectedLast,expectedCount:1000,expectedStateHash,expectedOperationHash});
const afterBytes = await readFile(absolutePdf);
const afterStat = await stat(absolutePdf);
const afterHash = sha256(afterBytes);
const originalAfter={hash:sha256(await readFile(originalPdf)),mtimeMs:(await stat(originalPdf)).mtimeMs};
const adapterShare=result.stages.adapterAppend.meanMs/result.meanMs;
const durableTargetMs=15;
const {document:benchmarkDocument,...measurements}=result;
const report = { preflight, result:measurements, adapterShare,durableTargetMs,interactionTargetMs:5,
  inputArtifact:{path:inputArtifact,sha256:sha256(Buffer.from(runtimeExpression))},
  sourcePdf: { beforeHash, afterHash,
  beforeMtimeMs: beforeStat.mtimeMs, afterMtimeMs: afterStat.mtimeMs },originalBefore,originalAfter,
  heapBefore, heapAfter,coldRecovery };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

assert.equal(result.count, 1000);
assert.equal(result.annotationCount, 1000);
assert.equal(result.totalAnnotationCount, 1000);
assert.equal(result.checkpointCount, 1000);
assert.equal(result.syncPending, false);
assert.equal(afterHash, beforeHash, "the source PDF bytes must never change");
assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, "the source PDF mtime must never change");
assert.deepEqual(originalAfter,originalBefore,"original PDF hash and mtime must remain unchanged");
assert.ok(result.p99Ms < durableTargetMs, `Native DataAdapter P99 ${result.p99Ms}ms exceeds the ${durableTargetMs}ms durable target`);
