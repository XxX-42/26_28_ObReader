import test from "node:test";
import { withAtomicProcess } from "./atomic-adapter-process.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import xxhash from "xxhash-wasm";

// Real transformed PDF bytes, production host/store, memory-only adapter.
// This is not an Obsidian Native UI acceptance or a linearization test.
const require = createRequire(import.meta.url);
const { createPdfAnnotationHost: createHost } = require("../plugin/pdf-annotation-host.cjs");
const { createPdfAnnotationStore } = require("../plugin/pdf-annotation-store.cjs");
// Retain Format 3 protection assertions; the WAL variant runs against the new default.
const createPdfAnnotationHost = (options) => createHost({ ...options, storeFactory: createPdfAnnotationStore });
const original = new Uint8Array(await readFile(new URL("./fixtures/tracemonkey.pdf", import.meta.url)));
const { h64Raw } = await xxhash();
const hash = value => `xxh64-v1:${h64Raw(value instanceof Uint8Array ? value : new Uint8Array(value)).toString(16).padStart(16,"0")}`;
async function rewrite(transform, options = {}) {
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  await transform(pdf);
  return new Uint8Array(await pdf.save({ useObjectStreams: false, ...options }));
}
const transforms = {
  "metadata-only edit": () => rewrite(pdf => pdf.setTitle("source binding matrix")),
  "object references rebuilt by copying unchanged pages": async () => {
    const input = await PDFDocument.load(original, { updateMetadata: false });
    const output = await PDFDocument.create();
    for (const page of await output.copyPages(input, input.getPageIndices())) output.addPage(page);
    return new Uint8Array(await output.save({ useObjectStreams: false }));
  },
  "object-stream optimization": () => rewrite(() => {}, { useObjectStreams: true }),
  "unchanged document with different full-file hash": async () => new Uint8Array(Buffer.concat([original, Buffer.from("\n% source binding matrix\n")])),
  "page insertion": () => rewrite(pdf => pdf.insertPage(1, [612,792])),
  "page deletion": () => rewrite(pdf => pdf.removePage(1)),
  "page reorder": () => rewrite(async pdf => {
    const [copy] = await pdf.copyPages(pdf, [0]);
    pdf.removePage(0); pdf.addPage(copy);
  }),
};
function harness() {
  const files = new Map(), dirs = new Set();
  const adapter = withAtomicProcess({
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); },
    async read(p) { assert.ok(files.has(p), `missing ${p}`); return files.get(p); },
    async write(p,value) { files.set(p,value); },
    async remove(p) { files.delete(p); },
    async rename(a,b) { assert.ok(files.has(a)); assert.ok(!files.has(b)); files.set(b,files.get(a));files.delete(a); },
    async list(p) {
      const prefix=p+"/", childFiles=[], folders=new Set();
      for(const k of [...files.keys(),...dirs]) { if(!k.startsWith(prefix))continue;const rest=k.slice(prefix.length);if(rest.includes("/"))folders.add(prefix+rest.split("/")[0]);else if(files.has(k))childFiles.push(k);else if(rest)folders.add(k); }
      return {files:childFiles,folders:[...folders]};
    },
  }, files);
  let bytes=original, sourceWrites=0;
  const file={path:"Fixtures/immutable.pdf",basename:"immutable",stat:{size:bytes.length,mtime:1}};
  const vault={adapter,getAbstractFileByPath:p=>p===file.path?file:null,readBinary:async()=>bytes.slice().buffer,
    modifyBinary:async()=>{sourceWrites++;throw Error("Source writes forbidden");}};
  const host=createPdfAnnotationHost({app:{vault},hashRuntime:{fingerprint:hash},deviceId:"matrix-device",makeToken:randomUUID});
  const view=()=>({documentId:"pending",openRequest:1,requestedPath:file.path,documentFile:file,file,iframe:{},messages:[],postToViewer(m){this.messages.push(m);return true;},setStatus(m){this.status=m;}});
  return {files,host,file,view,sourceWrites:()=>sourceWrites,setBytes:b=>{bytes=b;file.stat={size:b.length,mtime:2};}};
}
async function pageIdentity(bytes) {
  const pdf=await PDFDocument.load(bytes,{updateMetadata:false});
  return {pageCount:pdf.getPageCount(),orderedPageIdentities:pdf.getPages().map(p=>p.ref.toString())};
}
for(const [name,transform] of Object.entries(transforms)) {
  test(`source binding fails closed for actual PDF transformation: ${name}`,async()=>{
    const h=harness(), first=h.view();
    const snapshot=await h.host.initializeView(first,original);
    first.documentId=snapshot.documentId;
    await h.host.handleMessage(first,{type:"annotation-source-identity",documentId:first.documentId,openRequest:1,...await pageIdentity(original)});
    // A synced durable batch may precede its background checkpoint. Seed it
    // directly so there is no prior host-save maintenance racing this test.
    await h.host.store.appendOperations({document:first.annotationDocument,batchId:randomUUID(),
      operations:[{uuid:"matrix-mark",kind:"Square",pageIndex:0,deleted:false,payload:{editor:{annotationType:5,pageIndex:0,rect:[30,30,90,90],color:[0,0,0],thickness:1}}}]});
    const preserved=new Map([...h.files].filter(([p])=>p.includes("/ops/")||p.includes("/checkpoints/")));
    assert.ok(preserved.size>0);
    const changed=await transform();assert.notEqual(hash(changed),hash(original));
    h.setBytes(changed);
    const second=h.view(), rejected=await h.host.initializeView(second,changed);
    second.documentId=rejected.documentId;
    assert.equal(second.annotationSourceMismatch,true);
    assert.equal(second.annotationHydrationAllowed,false);
    assert.deepEqual(rejected.annotations,[]);
    await h.host.handleMessage(second,{type:"annotation-source-identity",documentId:second.documentId,openRequest:1,...await pageIdentity(changed)});
    assert.equal(second.messages.at(-1).type,"annotation-source-mismatch");
    assert.ok(second.messages.at(-1).reason);
    await h.host.handleMessage(second,{type:"save",documentId:second.documentId,openRequest:1,requestId:"must-reject",revision:2,operations:[{uuid:"must-not-write",kind:"Square",pageIndex:0,deleted:false,payload:{editor:{rect:[1,1,9,9]}}}]});
    assert.equal(second.messages.at(-1).code,"PDF_ANNOTATION_SOURCE_CHANGED");
    for(const [p,value]of preserved)assert.equal(h.files.get(p),value,`preserve ${p}`);
    assert.equal([...h.files.keys()].filter(p=>p.includes("/ops/")).length,[...preserved.keys()].filter(p=>p.includes("/ops/")).length);
    assert.equal(h.sourceWrites(),0);
    h.host.dispose();
  });
}
