import test from "node:test";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPdfAnnotationHost: createHost } = require("../plugin/pdf-annotation-host.cjs");
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
const { createHash } = await import("node:crypto");
const { PDFDocument, PDFDict, PDFName, PDFArray } = require("pdf-lib");
const { createPdfHashRuntime } = require("../plugin/pdf-hash-runtime.cjs");
// Keep the Format 3 golden tests intact; wal-host.test.mjs exercises the new default.
const createPdfAnnotationHost = (options) => createHost({ ...options, storeFactory: createPdfAnnotationStore });

function makeAdapter() {
  const files = new Map();
  const dirs = new Set();
  return withAtomicProcess({
    files,
    async exists(path) { return files.has(path) || dirs.has(path); },
    async mkdir(path) { dirs.add(path); },
    async read(path) { if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path); },
    async write(path, value) { files.set(path, value); },
    async remove(path) { files.delete(path); },
    async rename(from, to) {
      if (!files.has(from)) throw new Error(`missing rename source: ${from}`);
      if (files.has(to)) throw new Error(`rename target exists: ${to}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async list(path) {
      const prefix = `${path}/`;
      const children = new Set();
      const childFiles = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (!rest.includes("/")) childFiles.push(rest);
        else children.add(rest.split("/")[0]);
      }
      for (const key of dirs) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest && rest.includes("/")) children.add(rest.split("/")[0]);
        else if (rest) children.add(rest);
      }
      return { files: childFiles, folders: [...children] };
    },
  }, files);
}

function hash(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let result = 0xcbf29ce484222325n;
  for (const byte of bytes) result = BigInt.asUintN(64, (result ^ BigInt(byte)) * 0x100000001b3n);
  return `xxh64-v1:${result.toString(16).padStart(16, "0")}`;
}

function makeView(app, path = "Books/a.pdf", sourceBytes = new TextEncoder().encode("immutable source PDF bytes").buffer) {
  const bytes = sourceBytes instanceof ArrayBuffer ? sourceBytes : sourceBytes.buffer.slice(
    sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength);
  const file = { path, basename: path.split("/").at(-1), stat: { size: bytes.byteLength, mtime: 1 } };
  app.vault.file = file;
  app.vault.bytes = bytes.slice(0);
  const messages = [];
  return {
    documentId: "pending-open-id",
    openRequest: 1,
    requestedPath: path,
    documentFile: file,
    file,
    token: "token",
    iframe: {},
    postToViewer(message) { messages.push(message); return true; },
    setStatus(message) { this.lastStatus = message; },
    messages,
    get sourceBytes() { return bytes; },
  };
}

function makeApp(adapter) {
  return {
    vault: {
      adapter,
      file: null,
      bytes: null,
      getAbstractFileByPath(path) { return this.file?.path === path ? this.file : null; },
      async readBinary() { return this.bytes.slice(0); },
      async appendBinary(file, suffix) {
        const prior = new Uint8Array(this.bytes), added = new Uint8Array(suffix), next = new Uint8Array(prior.length + added.length);
        next.set(prior); next.set(added, prior.length); this.bytes = next.buffer;
        file.stat.size = next.length; file.stat.mtime += 1;
      },
    },
  };
}

test("v15 embedded erase writes only the source PDF, advances paired source identity, and returns a durable ACK", async () => {
  const adapter = makeAdapter(), app = makeApp(adapter);
  const hashRuntime = await createPdfHashRuntime();
  const pdf = await PDFDocument.create(), page = pdf.addPage([320, 420]), ctx = pdf.context;
  const mark = PDFDict.withContext(ctx); mark.set(PDFName.of("Type"), PDFName.of("Annot")); mark.set(PDFName.of("Subtype"), PDFName.of("Highlight"));
  const markRef = ctx.register(mark); const mark2=PDFDict.withContext(ctx);mark2.set(PDFName.of("Type"),PDFName.of("Annot"));mark2.set(PDFName.of("Subtype"),PDFName.of("Underline"));
  const mark2Ref=ctx.register(mark2);const annots = PDFArray.withContext(ctx); annots.push(markRef);annots.push(mark2Ref); page.node.set(PDFName.of("Annots"), annots);
  const source = new Uint8Array(await pdf.save({ useObjectStreams: false }));
  const host = createHost({ app, enableSingleJsonl: true, hashRuntime,
    identityHash: bytes => createHash("sha256").update(bytes).digest("hex"),
    makeToken: (() => { let n=0; return () => `native-erase-${++n}-token`; })(), deviceId: "native-erase-device" });
  const view = makeView(app, "Books/native-erase.pdf", source);
  const initial = await host.initializeView(view, view.sourceBytes); view.documentId = initial.documentId;
  assert.match(initial.source.sourceHash, /^xxh64-v1:/, "the fixture exercises the production XXH64 source fingerprint");
  await confirmPageIdentity(host, view);
  await host.handleMessage(view, { type: "save", documentId: view.documentId, openRequest: 1, requestId: "pair-save", revision: 1,
    batchId: "pairing-operation", operations: [{ uuid: "external-live", kind: "Highlight", pageIndex: 0, deleted: false,
      clock: { timestamp: 10, logical: 1, deviceId: "viewer", opId: "external-live-op" }, payload: { editor: { type: "highlight", color: [1,1,0] } } }] });
  const paired = new Uint8Array(app.vault.bytes), pairId = await require("../plugin/pdf-pair-id.cjs").readPairId(paired);
  assert.ok(pairId, JSON.stringify(view.messages));
  await host.handleMessage(view, { type: "save", documentId: view.documentId, openRequest: 1, requestId: "native-delete", revision: 2,
    batchId: "native-delete-op", operations: [{ uuid: "embedded-mark", kind: "Highlight", pageIndex: 0, embeddedRef: markRef.toString(),
      provenance: "embedded", deleted: true, operationId: "native-delete-op",
      clock: { timestamp: 11, logical: 1, deviceId: "viewer", opId: "native-delete-op" } },
    { uuid: "embedded-mark-2", kind: "Underline", pageIndex: 0, ref: mark2Ref.toString(), provenance: "embedded", deleted: true,
      operationId: "native-delete-op-2", clock: { timestamp: 11, logical: 3, deviceId: "viewer", opId: "native-delete-op-2" } },
    { uuid: "external-live", kind: "Highlight", pageIndex: 0, provenance: "external", deleted: true,
      clock: { timestamp: 11, logical: 2, deviceId: "viewer", opId: "external-delete-op" } }] });
  const ack = view.messages.findLast(message => message.requestId === "native-delete");
  assert.equal(ack?.type, "saved", JSON.stringify(ack)); assert.equal(ack?.operationCount, 3); assert.match(ack?.batchId || "", /native-delete-op/);
  await host.handleMessage(view, { type: "save", documentId: view.documentId, openRequest: 1, requestId: "post-erase-save", revision: 3,
    batchId: "post-erase-operation", operations: [{ uuid: "external-live", kind: "Highlight", pageIndex: 0, deleted: false,
      clock: { timestamp: 12, logical: 1, deviceId: "viewer", opId: "post-erase-op" }, payload: { editor: { type: "highlight", color: [0,1,0] } } }] });
  assert.equal(view.messages.findLast(message => message.requestId === "post-erase-save")?.type, "saved",
    JSON.stringify(view.messages.findLast(message => message.requestId === "post-erase-save")));
  const result = await PDFDocument.load(app.vault.bytes, { updateMetadata: false });
  assert.equal(await require("../plugin/pdf-pair-id.cjs").readPairId(new Uint8Array(app.vault.bytes)), pairId);
  assert.equal(result.getPages()[0].node.lookupMaybe(PDFName.of("Annots"), PDFArray).size(), 0);
  const sidecarPaths = [...adapter.files.keys()].filter(path => path.endsWith(".jsonl"));
  assert.ok(sidecarPaths.length >= 1, "paired current JSONL remains present");
  const sidecar = sidecarPaths.map(path => adapter.files.get(path)).join("\n");
  assert.match(sidecar, /external-live/); assert.doesNotMatch(sidecar, /embedded-mark/);
  assert.ok(![...adapter.files.keys()].some(path => path.includes(".v15-native-erase") && path.endsWith(".json")), "committed journal is cleared after ACK");
  host.dispose();
});

async function confirmPageIdentity(host, view) {
  await host.handleMessage(view, {
    type: "annotation-source-identity",
    documentId: view.documentId,
    openRequest: view.openRequest,
    pageCount: 1,
    orderedPageIdentities: ["4 0 R"],
    ...(view.annotationDocument?.pairId ? { pairId: view.annotationDocument.pairId } : {}),
  });
}

async function setupPairedNativeErase(path,{pair=true}={}) {
  const adapter=makeAdapter(),app=makeApp(adapter),hashRuntime=await createPdfHashRuntime();
  const logs=[];
  const pdf=await PDFDocument.create(),page=pdf.addPage([320,420]),ctx=pdf.context;
  const mark=PDFDict.withContext(ctx);mark.set(PDFName.of("Type"),PDFName.of("Annot"));mark.set(PDFName.of("Subtype"),PDFName.of("Highlight"));
  const markRef=ctx.register(mark),mark2=PDFDict.withContext(ctx);mark2.set(PDFName.of("Type"),PDFName.of("Annot"));mark2.set(PDFName.of("Subtype"),PDFName.of("Underline"));
  const mark2Ref=ctx.register(mark2),annots=PDFArray.withContext(ctx);annots.push(markRef);annots.push(mark2Ref);page.node.set(PDFName.of("Annots"),annots);
  const source=new Uint8Array(await pdf.save({useObjectStreams:false}));
  const options={app,enableSingleJsonl:true,hashRuntime,
    identityHash:bytes=>createHash("sha256").update(bytes).digest("hex"),
    makeToken:(()=>{let n=0;const key=path.replace(/[^a-z0-9]/gi,"");return()=>`nativeerase${key}${++n}token`;})(),deviceId:`native-erase-${path.replace(/[^a-z0-9]/gi,"")}-device`,log:(event,data)=>logs.push({event,data})};
  const host=createHost(options),view=makeView(app,path,source),initial=await host.initializeView(view,view.sourceBytes);view.documentId=initial.documentId;
  await confirmPageIdentity(host,view);
  if(pair){
    await host.handleMessage(view,{type:"save",documentId:view.documentId,openRequest:1,requestId:"pair-save",revision:1,batchId:"pair-operation",
      operations:[{uuid:"external-live",kind:"Highlight",pageIndex:0,deleted:false,
        clock:{timestamp:10,logical:1,deviceId:"viewer",opId:"external-live-op"},payload:{editor:{type:"highlight",color:[1,1,0]}}}]});
    assert.ok(await require("../plugin/pdf-pair-id.cjs").readPairId(new Uint8Array(app.vault.bytes)));
  }
  return {adapter,app,hashRuntime,options,host,view,markRefs:[markRef,mark2Ref],logs};
}

test("native erase journal resumes after restart from old, partial, and complete PDF append states",async()=>{
  for(const state of ["old","partial","complete"]){
    const f=await setupPairedNativeErase(`Books/recover-${state}.pdf`),originalAppend=f.app.vault.appendBinary.bind(f.app.vault);
    f.app.vault.appendBinary=async function(file,suffix){
      if(state==="old")throw new Error("simulated stop before append");
      if(state==="complete"){await originalAppend(file,suffix);throw new Error("simulated stop after append");}
      const bytes=new Uint8Array(suffix),half=Math.max(1,Math.floor(bytes.length/2));
      await originalAppend(file,bytes.subarray(0,half));throw new Error("simulated stop during append");
    };
    await f.host.handleMessage(f.view,{type:"save",documentId:f.view.documentId,openRequest:1,requestId:`erase-${state}`,revision:2,
      batchId:`erase-${state}-op`,operations:[{uuid:"embedded-mark",kind:"Highlight",pageIndex:0,ref:f.markRefs[0].toString(),
        provenance:"embedded",deleted:true,operationId:`erase-${state}-op`,
        clock:{timestamp:11,logical:1,deviceId:"viewer",opId:`erase-${state}-op`}},
      {uuid:"embedded-mark-2",kind:"Underline",pageIndex:0,ref:f.markRefs[1].toString(),provenance:"embedded",deleted:true,
        operationId:`erase-${state}-op-2`,clock:{timestamp:11,logical:2,deviceId:"viewer",opId:`erase-${state}-op-2`}}]});
    assert.equal(f.view.messages.findLast(m=>m.requestId===`erase-${state}`)?.type,"error");
    const journalPath=[...f.adapter.files.keys()].find(path=>path.includes(".v15-native-erase/")&&path.endsWith(".json"));
    assert.ok(journalPath,`${state} state leaves its recovery receipt`);
    const beforeRestartDoc=await f.host.store.documentForPath(`Books/recover-${state}.pdf`);
    f.host.dispose();
    f.app.vault.appendBinary=originalAppend;
    const restarted=createHost(f.options),reopened=makeView(f.app,`Books/recover-${state}.pdf`,new Uint8Array(f.app.vault.bytes));
    const snapshot=await restarted.initializeView(reopened,reopened.sourceBytes);reopened.documentId=snapshot.documentId;
    assert.equal(snapshot.documentId,f.view.documentId);assert.equal(snapshot.docKey,f.view.annotationDocument.docKey);
    assert.ok(!f.adapter.files.has(journalPath),`${state} receipt is removed only after recovery verifies both sides: ${journalPath} vs ${[...f.adapter.files.keys()].filter(p=>p.includes(".v15-native-erase"))}; status=${reopened.lastStatus}; prior=${JSON.stringify(beforeRestartDoc)}; logs=${JSON.stringify(f.logs)}`);
    const pdf=await PDFDocument.load(f.app.vault.bytes,{updateMetadata:false});
    assert.equal(pdf.getPages()[0].node.lookupMaybe(PDFName.of("Annots"),PDFArray).size(),0);
    await confirmPageIdentity(restarted,reopened);
    await restarted.handleMessage(reopened,{type:"save",documentId:reopened.documentId,openRequest:1,requestId:`next-${state}`,revision:1,
      batchId:`next-${state}-op`,operations:[{uuid:"external-after-recovery",kind:"Highlight",pageIndex:0,deleted:false,
        clock:{timestamp:12,logical:1,deviceId:"viewer",opId:`next-${state}-op"`},payload:{editor:{type:"highlight",color:[0,1,0]}}}]});
    assert.equal(reopened.messages.findLast(m=>m.requestId===`next-${state}`)?.type,"saved",
      `${JSON.stringify(reopened.messages.findLast(m=>m.requestId===`next-${state}`))}; mismatch=${reopened.annotationSourceMismatch}; hydrated=${reopened.annotationHydrationAllowed}; status=${reopened.lastStatus}; logs=${JSON.stringify(f.logs)}`);
    restarted.dispose();
  }
});

test("native erase validates every target before the single PDF write",async()=>{
  const f=await setupPairedNativeErase("Books/invalid-second-target.pdf"),before=new Uint8Array(f.app.vault.bytes),beforeHash=f.hashRuntime.fingerprint(before);
  await f.host.handleMessage(f.view,{type:"save",documentId:f.view.documentId,openRequest:1,requestId:"invalid-second",revision:2,
    batchId:"invalid-second-batch",operations:[
      {uuid:"embedded-mark",kind:"Highlight",pageIndex:0,ref:f.markRefs[0].toString(),provenance:"embedded",deleted:true,
        operationId:"valid-first",clock:{timestamp:11,logical:1,deviceId:"viewer",opId:"valid-first"}},
      {uuid:"embedded-mark-2",kind:"Square",pageIndex:0,ref:f.markRefs[1].toString(),provenance:"embedded",deleted:true,
        operationId:"invalid-second",clock:{timestamp:11,logical:2,deviceId:"viewer",opId:"invalid-second"}},
    ]});
  assert.equal(f.view.messages.findLast(m=>m.requestId==="invalid-second")?.type,"error");
  assert.equal(f.hashRuntime.fingerprint(new Uint8Array(f.app.vault.bytes)),beforeHash,"invalid second target leaves source PDF byte-identical");
  assert.ok(![...f.adapter.files.keys()].some(path=>path.includes(".v15-native-erase")),"invalid batches do not create a journal");
  f.host.dispose();
});

test("unpaired native erase preflights first, then uses the migration pair pipeline and reopens",async()=>{
  const rejected=await setupPairedNativeErase("Books/unpaired-invalid.pdf",{pair:false}),unchanged=new Uint8Array(rejected.app.vault.bytes),
    rejectedHash=rejected.hashRuntime.fingerprint(unchanged);
  await rejected.host.handleMessage(rejected.view,{type:"save",documentId:rejected.view.documentId,openRequest:1,requestId:"unpaired-invalid",revision:1,
    batchId:"unpaired-invalid",operations:[
      {uuid:"native-first",kind:"Highlight",pageIndex:0,ref:rejected.markRefs[0].toString(),provenance:"embedded",deleted:true,
        operationId:"unpaired-valid-first",clock:{timestamp:1,logical:1,deviceId:"viewer",opId:"unpaired-valid-first"}},
      {uuid:"native-second",kind:"Square",pageIndex:0,ref:rejected.markRefs[1].toString(),provenance:"embedded",deleted:true,
        operationId:"unpaired-invalid-second",clock:{timestamp:1,logical:2,deviceId:"viewer",opId:"unpaired-invalid-second"}},
    ]});
  assert.equal(rejected.view.messages.findLast(m=>m.requestId==="unpaired-invalid")?.type,"error");
  assert.equal(rejected.hashRuntime.fingerprint(new Uint8Array(rejected.app.vault.bytes)),rejectedHash,"invalid unpaired batch does not even add a pair ID");
  rejected.host.dispose();

  const f=await setupPairedNativeErase("Books/unpaired-valid.pdf",{pair:false});
  await f.host.handleMessage(f.view,{type:"save",documentId:f.view.documentId,openRequest:1,requestId:"unpaired-valid",revision:1,
    batchId:"unpaired-valid",operations:[
      {uuid:"native-first",kind:"Highlight",pageIndex:0,ref:f.markRefs[0].toString(),provenance:"embedded",deleted:true,
        operationId:"unpaired-valid-first",clock:{timestamp:1,logical:1,deviceId:"viewer",opId:"unpaired-valid-first"}},
      {uuid:"native-second",kind:"Underline",pageIndex:0,ref:f.markRefs[1].toString(),provenance:"embedded",deleted:true,
        operationId:"unpaired-valid-second",clock:{timestamp:1,logical:2,deviceId:"viewer",opId:"unpaired-valid-second"}},
    ]});
  assert.equal(f.view.messages.findLast(m=>m.requestId==="unpaired-valid")?.type,"saved",JSON.stringify(f.view.messages));
  const pairId=await require("../plugin/pdf-pair-id.cjs").readPairId(new Uint8Array(f.app.vault.bytes));assert.ok(pairId);
  const reopenedHost=createHost(f.options),reopened=makeView(f.app,"Books/unpaired-valid.pdf",new Uint8Array(f.app.vault.bytes));
  const snapshot=await reopenedHost.initializeView(reopened,reopened.sourceBytes);reopened.documentId=snapshot.documentId;
  assert.equal(snapshot.documentId,f.view.documentId);assert.equal(snapshot.docKey,f.view.annotationDocument.docKey);
  await confirmPageIdentity(reopenedHost,reopened);
  const pdf=await PDFDocument.load(f.app.vault.bytes,{updateMetadata:false});
  assert.equal(pdf.getPages()[0].node.lookupMaybe(PDFName.of("Annots"),PDFArray).size(),0);
  assert.equal(await require("../plugin/pdf-pair-id.cjs").readPairId(new Uint8Array(f.app.vault.bytes)),pairId);
  f.host.dispose();reopenedHost.dispose();
});

test("daily save persists only immutable annotation operations and leaves the PDF source untouched", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const sourceHash = hash(new TextEncoder().encode("immutable source PDF bytes"));
  const original = new TextEncoder().encode("immutable source PDF bytes");
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  assert.equal(snapshot.source.sourceHash, sourceHash);
  assert.deepEqual(snapshot.annotations, []);
  await confirmPageIdentity(host, view);

  await host.handleMessage(view, {
    type: "save",
    documentId: view.documentId,
    openRequest: 1,
    requestId: "save-1",
    revision: 1,
    batchId: "batch-1",
    operations: [{
      uuid: "annotation-1",
      kind: "Highlight",
      pageIndex: 3,
      deleted: false,
      clock: { timestamp: 100, logical: 1, deviceId: "viewer-device", opId: "operation-1" },
      payload: { editor: { type: "highlight", color: [1, 1, 0] } },
    }],
  });

  const saved = view.messages.find((message) => message.type === "saved");
  assert.equal(saved?.external, true);
  assert.equal(saved?.operationCount, 1);
  assert.deepEqual(new Uint8Array(app.vault.bytes), original);
  assert.equal([...adapter.files.keys()].some((path) => path.endsWith(".pdf")), false);
  const operationPath = [...adapter.files.keys()].find((path) => path.endsWith(".json") && path.includes("/ops/"));
  assert.ok(operationPath);
  assert.ok(operationPath.includes("test-device-unique"));

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok([...adapter.files.keys()].some((path) => path.endsWith(".pdfdata.json")));
  host.dispose();
});

test("PDF legacy markers never invoke legacy inspection", async () => {
  for (const marker of ["/ObReaderMerge", "/ObReaderId", "", "/ObReaderI"]) {
    const adapter = makeAdapter(); const app = makeApp(adapter); let calls = 0;
    const host = createPdfAnnotationHost({ app, hashRuntime: { fingerprint: hash },
      inspectLegacy: async () => { calls++; throw new Error("unexpected inspection"); },
      makeToken: () => "no-scan-token", deviceId: "no-scan-device" });
    const view = makeView(app, `Books/${marker.replaceAll("/", "") || "empty"}.pdf`, new TextEncoder().encode(`%PDF ${marker}`));
    const snapshot = await host.initializeView(view, view.sourceBytes);
    assert.equal(calls, 0); assert.equal(view.annotationLegacyIdentityUncertain, false);
    assert.deepEqual(snapshot.annotations, []); assert.notEqual(view.annotationStorageUnavailable, true);
    host.dispose();
  }
});

test("external live annotations and tombstones survive host reopening without PDF legacy scanning", async () => {
  const adapter = makeAdapter(); const app = makeApp(adapter); let calls = 0; let token = 0;
  const options = { app, hashRuntime: { fingerprint: hash }, inspectLegacy: async () => { calls++; throw Error("unexpected scan"); },
    makeToken: () => `external-roundtrip-${++token}`, deviceId: "external-roundtrip-device" };
  let host = createPdfAnnotationHost(options);
  const bytes = new TextEncoder().encode("%PDF /ObReaderMerge /ObReaderId");
  let view = makeView(app, "Books/external-roundtrip.pdf", bytes);
  const initial = await host.initializeView(view, view.sourceBytes); view.documentId = initial.documentId;
  await confirmPageIdentity(host, view);
  const operations = [
    { uuid:"live-1",kind:"Highlight",pageIndex:0,deleted:false,clock:{timestamp:100,logical:1,deviceId:"viewer",opId:"live-op"},payload:{editor:{type:"highlight",color:[1,1,0]}} },
    { uuid:"deleted-1",kind:"Ink",pageIndex:0,deleted:true,clock:{timestamp:101,logical:1,deviceId:"viewer",opId:"delete-op"} },
  ];
  await host.handleMessage(view,{type:"save",documentId:view.documentId,openRequest:1,requestId:"save-external",revision:1,batchId:"batch-external",operations});
  assert.equal(view.messages.find(m=>m.type==="saved")?.operationCount, 2);
  host.dispose(); host = createPdfAnnotationHost(options); view = makeView(app,"Books/external-roundtrip.pdf",bytes);
  const reopened = await host.initializeView(view,view.sourceBytes); view.documentId = reopened.documentId;
  await confirmPageIdentity(host,view);
  const stored = await host.store.readDocument(view.annotationDocument);
  assert.ok(stored.annotations.some(a=>a.uuid==="live-1"));
  assert.ok(stored.tombstones.some(a=>a.uuid==="deleted-1"));
  assert.equal(calls,0); assert.deepEqual(new Uint8Array(app.vault.bytes),bytes); host.dispose();
});

test("source size or mtime changes stop the append path without modifying the source", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  await confirmPageIdentity(host, view);
  app.vault.file.stat.mtime = 2;
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 1,
    requestId: "save-2", revision: 1,
    operations: [{ uuid: "annotation-2", kind: "Ink", pageIndex: 0, deleted: false, payload: { editor: { paths: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");
  assert.equal([...adapter.files.keys()].some((path) => path.includes("/ops/")), false);
  host.dispose();
});

test("changed source identity blocks hydration and normal save", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const makeHost = () => createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const firstHost = makeHost();
  const originalView = makeView(app);
  const originalSnapshot = await firstHost.initializeView(originalView, originalView.sourceBytes);
  originalView.documentId = originalSnapshot.documentId;
  await confirmPageIdentity(firstHost, originalView);
  firstHost.dispose();

  const host = makeHost();
  const changedBytes = new TextEncoder().encode("different PDF source").buffer;
  const view = makeView(app, "Books/a.pdf", changedBytes);
  app.vault.file.stat = { size: changedBytes.byteLength, mtime: 2 };
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  assert.equal(view.annotationSourceMismatch, true);
  assert.deepEqual(snapshot.annotations, [], "unconfirmed external annotations are not returned to a changed source");
  await host.handleMessage(view, {
    type: "annotation-source-identity",
    documentId: view.documentId,
    openRequest: 1,
    pageCount: 1,
    orderedPageIdentities: ["different-ref"],
  });
  assert.equal(view.annotationSourceMismatch, true);
  assert.equal(view.messages.at(-1)?.type, "annotation-source-mismatch");
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 1,
    requestId: "blocked", revision: 1,
    operations: [{ uuid: "unsafe", kind: "Ink", pageIndex: 0, deleted: false,
      payload: { editor: { paths: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");
  host.dispose();
});

test("unknown ordered page identity blocks hydration and external saves", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  let token = 0;
  const host = createPdfAnnotationHost({ app, hashRuntime: { fingerprint: hash },
    makeToken: () => `unknown-page-id-${++token}`, deviceId: "unknown-page-device" });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  await host.handleMessage(view, {
    type: "annotation-source-identity", documentId: view.documentId, openRequest: 1,
    pageCount: 1, orderedPageIdentities: [null], identityStatus: "UNKNOWN",
  });
  assert.equal(view.annotationHydrationAllowed, false);
  assert.equal(view.messages.at(-1)?.reason, "PAGE_IDENTITY_UNAVAILABLE");
  await host.handleMessage(view, {
    type: "save", documentId: view.documentId, openRequest: 1,
    requestId: "unknown-page-save", revision: 1,
    operations: [{ uuid: "unsafe-page", kind: "Ink", pageIndex: 0, deleted: false,
      payload: { editor: { points: [] } } }],
  });
  assert.equal(view.messages.at(-1)?.code, "PDF_ANNOTATION_SOURCE_CHANGED");
  assert.equal([...adapter.files.keys()].some((path) => path.includes("/ops/")), false);
  host.dispose();
});

test("close recovery on a changed source is quarantined under its confirmed old identity", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `token-${++n}-unique`; })(),
    deviceId: "test-device-unique",
  });
  const view = makeView(app);
  const snapshot = await host.initializeView(view, view.sourceBytes);
  view.documentId = snapshot.documentId;
  await confirmPageIdentity(host, view);
  const oldHash = view.annotationSourceHash;
  app.vault.bytes = new TextEncoder().encode("different PDF source").buffer;
  app.vault.file.stat = { size: app.vault.bytes.byteLength, mtime: 2 };
  await host.handleSourceModify(app.vault.file);
  await host.handleMessage(view, {
    type: "recover", documentId: view.documentId, openRequest: 1,
    requestId: "recover-old", revision: 1, sourceHash: oldHash,
    pageCount: 1, orderedPageIdentities: ["4 0 R"],
    operations: [{ uuid: "old-session", kind: "Ink", pageIndex: 0, deleted: false,
      clock: { timestamp: 100, logical: 1, deviceId: "viewer", opId: "old-op" },
      payload: { editor: { paths: [1, 2] } } }],
  });
  const recovered = view.messages.find((message) => message.type === "recovered");
  assert.equal(recovered?.ok, true);
  assert.equal(recovered?.quarantined, true);
  assert.equal([...adapter.files.keys()].some((path) => path.endsWith(".pdf")), false);
  host.dispose();
});

test("checkpoint arrival retries a pending v3 sync and restores editing in the open Reader", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `sidecar-token-${++n}`; })(),
    deviceId: "sidecar-local",
  });
  const view = makeView(app);
  const preRegistered = await host.store.registerDocument({ sourcePath: view.file.path });
  const locations = host.store.pathsFor(preRegistered);
  adapter.files.set(`${locations.deviceStates}/sidecar-peer.json`, JSON.stringify({
    schemaVersion: 1, deviceId: "sidecar-peer", pluginVersion: "0.7.1", storageFormatVersion: 2,
    checkpointHash: null, retired: false, updatedAt: Date.now(),
  }));

  const initial = await host.initializeView(view, view.sourceBytes);
  view.documentId = initial.documentId;
  await confirmPageIdentity(host, view);
  const document = view.annotationDocument;
  const checkpointPath = locations.checkpoint;
  const checkpoint2 = JSON.parse(adapter.files.get(checkpointPath));
  assert.equal(checkpoint2.formatVersion, 2);

  const delayed = {
    schemaVersion: 1, formatVersion: 3, pluginVersion: "0.8.0",
    kind: "annotation-operation-batch", documentId: document.documentId, docKey: document.docKey,
    deviceId: "sidecar-peer", batchId: "delayed-v3", createdAt: Date.now(),
    baseCheckpointHash: checkpoint2.integrity, parents: checkpoint2.batchHeads,
    operations: [{ uuid: "delayed-v3", kind: "Highlight", pageIndex: 0, deleted: false,
      payload: { color: [1, 1, 0] },
      clock: { timestamp: Date.now(), logical: 0, deviceId: "sidecar-peer", opId: "delayed-v3-op" } }],
  };
  const delayedPath = `${locations.operations}/sidecar-peer/delayed-v3.json`;
  await adapter.mkdir(locations.operations);
  await adapter.mkdir(`${locations.operations}/sidecar-peer`);
  adapter.files.set(delayedPath, JSON.stringify(delayed));
  await host.handleSidecarChange({ path: delayedPath });
  assert.equal(view.annotationSyncPending, true);
  assert.equal(view.messages.filter((message) => message.type === "external-annotations-update").at(-1)?.readOnly, true);
  assert.equal(adapter.files.get(checkpointPath), JSON.stringify(checkpoint2));

  // Model the missing format-3 checkpoint arriving after an upgraded peer ACK.
  adapter.files.delete(delayedPath);
  const peerAckTime = Date.now();
  adapter.files.set(`${locations.deviceStates}/sidecar-peer.json`, JSON.stringify({
    schemaVersion: 1, deviceId: "sidecar-peer", pluginVersion: "0.8.1", storageFormatVersion: 3,
    checkpointHash: checkpoint2.integrity, retired: false, acknowledgedAt: peerAckTime, updatedAt: peerAckTime,
  }));
  await host.store.readDocument(document);
  const checkpoint3 = JSON.parse(adapter.files.get(checkpointPath));
  assert.equal(checkpoint3.formatVersion, 3);
  adapter.files.set(delayedPath, JSON.stringify(delayed));

  await host.handleSidecarChange({ path: delayedPath });
  assert.equal(view.annotationSyncPending, false);
  assert.equal(view.lastStatus, "批注同步已完成，已恢复编辑。");
  const update = view.messages.filter((message) => message.type === "external-annotations-update").at(-1);
  assert.equal(update?.readOnly, false);
  assert.ok(update?.externalAnnotations.annotations.some((row) => row.uuid === "delayed-v3"));
  host.dispose();
});

test("self-originated sidecar notifications do not re-enter checkpoint materialization", async () => {
  const adapter = makeAdapter();
  const app = makeApp(adapter);
  let materializations = 0;
  const host = createPdfAnnotationHost({
    app,
    hashRuntime: { fingerprint: hash },
    makeToken: (() => { let n = 0; return () => `self-echo-${++n}`; })(),
    deviceId: "self-echo-device",
    log(event, details) {
      if (event === "annotation-performance" && details?.phase === "materialization") materializations += 1;
    },
  });
  const view = makeView(app);
  const initial = await host.initializeView(view, view.sourceBytes);
  view.documentId = initial.documentId;
  const document = view.annotationDocument;
  const paths = host.store.pathsFor(document);
  const devicePath = `${paths.deviceStates}/self-echo-device.json`;
  assert.ok(adapter.files.has(paths.checkpoint));
  assert.ok(adapter.files.has(devicePath));
  await host.store.appendOperations({
    document,
    batchId: "self-echo-published-batch",
    sourceHash: document.source.sourceHash,
    operations: [{
      uuid: "self-echo-annotation",
      kind: "Highlight",
      pageIndex: 0,
      deleted: false,
      clock: { timestamp: 1, logical: 0, deviceId: "self-echo-device", opId: "self-echo-op" },
      payload: { editor: { type: "highlight", color: [1, 1, 0] } },
    }],
  });
  const batchPath = `${paths.operations}/self-echo-device/self-echo-published-batch.json`;
  assert.ok(adapter.files.has(batchPath));

  const afterOpen = materializations;

  await host.handleSidecarChange({ path: paths.checkpoint });
  await host.handleSidecarChange({ path: devicePath });
  await host.handleSidecarChange({ path: batchPath });
  assert.equal(materializations, afterOpen,
    "the host already knows its own checkpoint/ACK/published operation bytes and must not turn their Vault events into another materialization");

  adapter.files.set(paths.checkpoint, `${adapter.files.get(paths.checkpoint)} `);
  await host.handleSidecarChange({ path: paths.checkpoint });
  assert.equal(materializations, afterOpen + 1,
    "an external rewrite with different bytes must not be mistaken for a self echo");

  await host.handleSidecarChange({ path: `${paths.operations}/peer/external-batch.json` });
  assert.equal(materializations, afterOpen + 2,
    "an unmatched external operation event must still refresh open Readers");
  host.dispose();
});

test('decrypt replacement retires the old source before file events and identity replies', async () => {
  const adapter=makeAdapter(),app=makeApp(adapter),runtime=await createPdfHashRuntime();
  const host=createHost({app,enableSingleJsonl:true,hashRuntime:runtime,identityHash:b=>createHash('sha256').update(b).digest('hex'),makeToken:()=> 'decrypt-test',deviceId:'decrypt-test'});
  const view=makeView(app);const initial=await host.initializeView(view,view.sourceBytes);view.documentId=initial.documentId;
  const oldDocument=view.annotationDocument;
  host.beginSourceReplacement(view);
  const before=view.messages.length;
  app.vault.bytes=new TextEncoder().encode('new decrypted source bytes').buffer;
  await host.handleSourceModify(view.documentFile);
  await host.handleMessage(view,{type:'annotation-source-identity',documentId:view.documentId,openRequest:view.openRequest,pageCount:2,orderedPageIdentities:['ref:1R','ref:2R']});
  assert.equal(view.messages.length,before,'retired source cannot send mismatch notices');
  assert.notEqual(view.annotationSourceMismatch,true);
  await host.store.resetUnpairedSourceAfterDecrypt(oldDocument);
  view.annotationSourceReplacing=false;view.openRequest++;
  const reopened=await host.initializeView(view,app.vault.bytes);view.documentId=reopened.documentId;
  await host.handleMessage(view,{type:'annotation-source-identity',documentId:view.documentId,openRequest:view.openRequest,pageCount:2,orderedPageIdentities:['ref:1R','ref:2R']});
  assert.equal(view.annotationHydrationAllowed,true);assert.equal(view.annotationSourceMismatch,false);
  host.dispose();
});
