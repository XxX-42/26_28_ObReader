// Explicit Native test: writes only a unique PDF/sidecar fixture in the test Vault.
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import xxhash from "xxhash-wasm";
import { nativeConfig, nativeEvalJson, nativeCdp, invokeNativeCli, assertNativeVaultIdentity } from "./native-config.mjs";

const source = process.env.PDF_READER_RETENTION_SOURCE;
const sourceSnapshot = process.env.PDF_READER_RETENTION_SNAPSHOT;
assert.ok(source && sourceSnapshot, "Set read-only source PDF and snapshot paths explicitly");
const runId = `deletion-retention-${Date.now()}-${randomUUID().slice(0, 8)}`;
const relativePdf = `PDF迁移测试/${runId}.pdf`;
const inputRelative = `.obsidian/plugins/pdf-web-reader/.native-test-output/${runId}.json`;
const artifacts = path.resolve("tests/artifacts/first-paint-retention-20261022", runId);
await mkdir(artifacts, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const xxh = await xxhash();
async function identity(file) {
  const bytes = await readFile(file);
  return { sha256: hash(bytes), xxh64: `xxh64-v1:${xxh.h64Raw(bytes).toString(16).padStart(16,"0")}`,
    mtimeMs: (await stat(file)).mtimeMs };
}
const report = { runId, sourceBefore: await identity(source), snapshotBefore: hash(await readFile(sourceSnapshot)) };
const inputSnapshot = JSON.parse(await readFile(sourceSnapshot, "utf8"));
const tombstones = Array.isArray(inputSnapshot.tombstones) ? inputSnapshot.tombstones : Object.values(inputSnapshot.tombstones || {});
assert.ok(tombstones.length, "this Native fixture needs real deleted annotations");
const native = code => nativeEvalJson(`(async()=>{if(app.vault.adapter.basePath.replace(/\\\\+/g,"/").toLowerCase()!==${JSON.stringify(nativeConfig.vault.replaceAll("\\","/").toLowerCase())})throw Error("Wrong test Vault");${code}})()`);
const preflight = nativeEvalJson(`JSON.stringify({vault:app.vault.adapter.basePath,configDir:app.vault.configDir,
  version:app.plugins.plugins["pdf-web-reader"]?.manifest.version,
  readers:[...(app.plugins.plugins["pdf-web-reader"]?.views||[])].map(v=>v.file?.path)})`);
assertNativeVaultIdentity(preflight);
assert.deepEqual(preflight.readers, [], "Native fixture requires no pre-existing Readers");
const fixturePath = path.join(nativeConfig.vault, relativePdf);
const inputPath = path.join(nativeConfig.vault, inputRelative);
await mkdir(path.dirname(fixturePath), { recursive: true });
await mkdir(path.dirname(inputPath), { recursive: true });
await copyFile(source, fixturePath, constants.COPYFILE_EXCL);
report.fixtureBefore = await identity(fixturePath);
await writeFile(inputPath, JSON.stringify({ tombstones, relativePdf, runId }), { flag: "wx" });
const q = JSON.stringify(inputRelative);
async function waitReady() {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    const state = native(`const p=app.plugins.plugins["pdf-web-reader"];const v=[...p.views].find(v=>v.file?.path===${JSON.stringify(relativePdf)});
      const a=v?.iframe?.contentWindow?.PDFViewerApplication;
      return JSON.stringify({ready:!!v?.ready&&!!a?.pdfDocument&&!v.annotationSyncPending&&v.annotationHydrationAllowed===true,
        pages:a?.pdfDocument?.numPages,dirty:a?._hasChanges?.()});`);
    if (state.ready) return state;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Native fixture did not reach verified ready state within 30 seconds");
}
try {
  nativeCdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  report.focusEmulation = true;
  native(`const data=JSON.parse(await app.vault.adapter.read(${q}));const p=app.plugins.plugins["pdf-web-reader"];
    const file=app.vault.getAbstractFileByPath(data.relativePdf);if(!file)throw Error("Fixture not indexed");
    window.__retentionNative={writes:0,saveDocument:0,paints:[],cleanups:[]};
    const adapter=app.vault.adapter;
    for(const key of ["write","append","writeBinary","modifyBinary"]){if(typeof adapter[key]!=="function")continue;
      const descriptor=Object.getOwnPropertyDescriptor(adapter,key),original=adapter[key];
      adapter[key]=function(file,...args){if((typeof file==="string"?file:file?.path)===data.relativePdf)window.__retentionNative.writes++;
        return original.call(this,file,...args);};
      window.__retentionNative.cleanups.push(()=>descriptor?Object.defineProperty(adapter,key,descriptor):delete adapter[key]);}
    await p.openPdf(file);return JSON.stringify({opened:true});`);
  report.prime = await waitReady();
  report.seed = native(`const data=JSON.parse(await app.vault.adapter.read(${q}));const p=app.plugins.plugins["pdf-web-reader"];
    const v=[...p.views].find(v=>v.file?.path===data.relativePdf);const doc=v.annotationDocument;
    await p.annotationHost.store.appendOperations({document:doc,operations:data.tombstones.map((t,i)=>({uuid:t.uuid,kind:t.kind,
      pageIndex:t.pageIndex,embeddedRef:t.embeddedRef,deleted:true,clock:{timestamp:Date.now(),logical:i,deviceId:"native-fixture",opId:data.runId+":"+i}}))});
    await p.annotationHost.store.materializeSnapshot(doc);
    const snap=await p.annotationHost.store.readDocument(doc);
    const rpath="00_Archive/20_PDFData/wal/"+p.deviceId+"/"+doc.docKey+".jsonl.retention.json";
    const listing=await app.vault.adapter.list("00_Archive/20_PDFData/wal");let retentionPath=null;
    for(const dir of listing.folders){const candidate=dir+"/"+doc.docKey+".jsonl.retention.json";if(await app.vault.adapter.exists(candidate)){retentionPath=candidate;break;}}
    if(!retentionPath)throw Error("Fixture retention ledger missing");
    const {integrity,...ledger}=JSON.parse(await app.vault.adapter.read(retentionPath));
    for(const entry of Object.values(ledger.entries))entry.firstObservedAt=Date.now()-48*24*60*60*1000;
    const stable=x=>Array.isArray(x)?x.map(stable):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,stable(x[k])])):x;
    const sealed={...ledger,integrity:p.pdfHashRuntime.fingerprint(new TextEncoder().encode(JSON.stringify(stable(ledger))))};
    await app.vault.adapter.write(retentionPath,JSON.stringify(sealed));
    await p.annotationHost.watchDeletionRetention();await p.annotationHost.store.materializeSnapshot(doc);
    const expired=await p.annotationHost.store.readDocument(doc);
    await v.leaf.detach();return JSON.stringify({before:snap.tombstones.length,after:expired.tombstones.length,
      guards:expired.deletionGuards?.length||0,docKey:doc.docKey});`);
  assert.equal(report.seed.before, tombstones.length);
  assert.equal(report.seed.after, 0);
  assert.equal(report.seed.guards, tombstones.length);
  invokeNativeCli(["plugin:reload", "id=pdf-web-reader"]);
  // Reload may detach the CLI debugger and reset its emulation state.
  nativeCdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  native(`const state=window.__retentionNative;const listener=event=>{
    if(event.data?.channel!=="pdf-web-reader"||event.data?.type!=="ready")return;
    const w=event.source,a=w?.PDFViewerApplication;if(!a)return;
    state.readySignals=(state.readySignals||0)+1;
    const v=[...app.plugins.plugins["pdf-web-reader"].views].find(v=>v.iframe?.contentWindow===w);
    state.openFlags={mismatch:v?.annotationSourceMismatch,uncertain:v?.annotationLegacyIdentityUncertain,
      pending:v?.annotationSyncPending,allowed:v?.annotationHydrationAllowed,sourcePages:v?.annotationSyncState?.source?.pageCount};
    a.initializedPromise.then(()=>{
      a.eventBus._on("pagesinit",()=>{a.pdfViewer.currentPageNumber=2;a.pdfViewer.currentScaleValue="page-fit";});
      a.eventBus._on("documentloaded",()=>{const doc=a.pdfDocument,original=doc.saveDocument;
        const wrapped=function(...args){state.saveDocument++;return original.apply(this,args);};doc.saveDocument=wrapped;
        state.cleanups.push(()=>{if(doc.saveDocument===wrapped)doc.saveDocument=original;});});
      a.eventBus._on("pagerendered",async({pageNumber})=>{if(pageNumber!==2)return;const pv=a.pdfViewer.getPageView(1),canvas=pv.canvas;if(!canvas)return;
        const actual=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data.slice();
        const actualPng=canvas.toDataURL("image/png");
        const visible=w.getComputedStyle(canvas).visibility==="visible";const c=w.document.createElement("canvas");c.width=canvas.width;c.height=canvas.height;
        const context=c.getContext("2d",canvas.getContext("2d").getContextAttributes());
        await pv.pdfPage.render({canvasContext:context,viewport:pv.viewport,annotationMode:0,
          transform:pv.outputScale.scaled?[pv.outputScale.sx,0,0,pv.outputScale.sy,0,0]:null}).promise;
        const control=context.getImageData(0,0,c.width,c.height).data;let changed=0;
        for(let i=0;i<actual.length;i+=4)if(Math.abs(actual[i]-control[i])+Math.abs(actual[i+1]-control[i+1])+Math.abs(actual[i+2]-control[i+2])>30)changed++;
        state.images={actual:actualPng,control:c.toDataURL("image/png")};
        state.paints.push({pageNumber,changed,pixels:c.width*c.height,visible,
          maskedIds:[...a.pdfDocument.annotationStorage.modifiedIds.ids]});});});};
    window.addEventListener("message",listener,true);state.cleanups.push(()=>window.removeEventListener("message",listener,true));
    const data=JSON.parse(await app.vault.adapter.read(${q}));await app.plugins.plugins["pdf-web-reader"].openPdf(app.vault.getAbstractFileByPath(data.relativePdf));
    return JSON.stringify({opened:true});`);
  report.reopen = await waitReady();
  const started = Date.now();
  do {
    report.runtime = native(`const p=app.plugins.plugins["pdf-web-reader"],v=[...p.views].find(v=>v.file?.path===${JSON.stringify(relativePdf)});
      const w=v?.iframe?.contentWindow,a=w?.PDFViewerApplication,s=await p.annotationHost.store.readDocument(v.annotationDocument),pv=a?.pdfViewer?.getPageView(1);
      return JSON.stringify({openFlags:window.__retentionNative.openFlags,readySignals:window.__retentionNative.readySignals||0,paints:window.__retentionNative.paints,writes:window.__retentionNative.writes,
        saveDocument:window.__retentionNative.saveDocument,active:s.annotations.length,tombstones:s.tombstones.length,
        canvasVisible:!!pv?.canvas&&w.getComputedStyle(pv.canvas).visibility==="visible",renderState:pv?.renderingState,
        maskPending:pv?.div.hasAttribute("data-pdf-reader-mask-pending"),
        guards:s.deletionGuards?.length||0,editors:[...(a?.pdfViewer?._layerProperties?.annotationEditorUIManager?.getEditors(1)||[])].filter(e=>!e.deleted).length});`);
    if (report.runtime.paints.length&&report.runtime.canvasVisible&&report.runtime.renderState===3&&!report.runtime.maskPending) break;
    await new Promise(resolve => setTimeout(resolve,100));
  } while (Date.now() - started < 30_000);
  assert.ok(report.runtime.paints.length);
  assert.equal(report.runtime.canvasVisible,true,"the final PDF must actually be displayed");
  assert.equal(report.runtime.maskPending,false);
  assert.ok(report.runtime.paints.every(p=>!p.visible||p.changed===0), "no visible deleted Ink frame");
  report.finalPaint=native(`const v=[...app.plugins.plugins["pdf-web-reader"].views].find(v=>v.file?.path===${JSON.stringify(relativePdf)}),w=v.iframe.contentWindow;
    const pv=w.PDFViewerApplication.pdfViewer.getPageView(1),canvas=pv.canvas,c=w.document.createElement("canvas");c.width=canvas.width;c.height=canvas.height;
    const ctx=c.getContext("2d",canvas.getContext("2d").getContextAttributes());
    await pv.pdfPage.render({canvasContext:ctx,viewport:pv.viewport,annotationMode:0,
      transform:pv.outputScale.scaled?[pv.outputScale.sx,0,0,pv.outputScale.sy,0,0]:null}).promise;
    const a=canvas.getContext("2d").getImageData(0,0,c.width,c.height).data,b=ctx.getImageData(0,0,c.width,c.height).data;let changed=0;
    for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>30)changed++;
    return JSON.stringify({changed,pixels:c.width*c.height,visible:w.getComputedStyle(canvas).visibility==="visible",context:ctx.getContextAttributes()});`);
  assert.equal(report.finalPaint.changed,0,"final visible page equals annotation-disabled source render");
  assert.equal(report.runtime.active, 0);
  assert.equal(report.runtime.tombstones, 0);
  assert.equal(report.runtime.guards, tombstones.length);
  assert.equal(report.runtime.editors, 0);
  assert.equal(report.runtime.writes, 0);
  assert.equal(report.runtime.saveDocument, 0);
  const screenshot = nativeCdp("Page.captureScreenshot", { format: "png" });
  if (screenshot.data) await writeFile(path.join(artifacts,"native.png"), Buffer.from(screenshot.data,"base64"));
  report.sourceAfter = await identity(source);
  report.fixtureAfter = await identity(fixturePath);
  report.snapshotAfter = hash(await readFile(sourceSnapshot));
  assert.deepEqual(report.sourceAfter, report.sourceBefore);
  assert.equal(report.fixtureAfter.sha256, report.sourceBefore.sha256);
  assert.equal(report.fixtureAfter.xxh64, report.sourceBefore.xxh64);
  assert.equal(report.snapshotAfter, report.snapshotBefore);
  report.status = "passed";
} catch (error) { report.status="failed";report.error=error.stack;process.exitCode=1; }
finally {
  try {
    const images=native('return JSON.stringify(window.__retentionNative?.images||{});');
    for(const [name,data] of Object.entries(images))if(typeof data==="string")await writeFile(path.join(artifacts,`${name}.png`),Buffer.from(data.split(",")[1],"base64"));
    native(`const s=window.__retentionNative;for(const fn of s?.cleanups||[])fn();if(s)s.cleanups=[];
    const p=app.plugins.plugins["pdf-web-reader"],v=[...p.views].find(v=>v.file?.path===${JSON.stringify(relativePdf)});
    if(v&&!v.iframe?.contentWindow?.PDFViewerApplication?._hasChanges?.())await v.leaf.detach();
    return JSON.stringify({cleaned:true});`);
    nativeCdp("Emulation.setFocusEmulationEnabled", { enabled: false });
  } catch(error) { report.cleanupError=error.message; }
  report.sourceAfter = await identity(source);
  report.fixtureAfter = await identity(fixturePath);
  report.snapshotAfter = hash(await readFile(sourceSnapshot));
  assert.deepEqual(report.sourceAfter,report.sourceBefore);
  assert.deepEqual(report.fixtureAfter,report.fixtureBefore);
  assert.equal(report.snapshotAfter,report.snapshotBefore);
  await writeFile(path.join(artifacts,"report.json"),JSON.stringify(report,null,2));
  if(report.status==="passed")await unlink(inputPath);
  console.log(JSON.stringify({...report,artifacts},null,2));
}
