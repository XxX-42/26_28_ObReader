import assert from 'node:assert/strict';import {test} from 'node:test';import {createRequire} from 'node:module';import {createHash,randomUUID} from 'node:crypto';
import {fixture} from './pdf-outline-fixtures.mjs';
const require=createRequire(import.meta.url);
const {createPdfAnnotationHost}=require('../plugin/pdf-annotation-host.cjs');
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {attachPairId}=require('../plugin/pdf-pair-id.cjs');
const {readPairId}=require('../plugin/pdf-pair-id.cjs');
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const sha=b=>'sha256-v1:'+createHash('sha256').update(b).digest('hex');

test('host keeps paired annotations provisional until matching PDF metadata and page identity are confirmed',async()=>{
 const original=await fixture(),id='12'.repeat(16),paired=await attachPairId(original.bytes,id),runtime=await createPdfHashRuntime();
 const file={path:'Books/a.pdf',stat:{size:paired.bytes.length,mtime:1}};
 const source={...original.source,sourceHash:runtime.fingerprint(original.bytes)};
 const document={docKey:'123456abcdef',documentId:'legacy-id',sourcePath:file.path,source,pairId:id,pairing:{pairedSha256:sha(paired.bytes)},legacyIdentities:[],legacyIdentityScanComplete:true};
 const annotation={uuid:'A',kind:'Highlight',pageIndex:0,payload:{targetText:'retained'}};
 const tombstone={uuid:'D',kind:'Ink',pageIndex:0,embeddedRef:'8R'};
 const snapshot={schemaVersion:2,kind:'pdf-annotation-snapshot',storageProtocol:'obreader-current-v15',document:{id:document.documentId,path:file.path},source,pairId:id,requiresPairValidation:true,revision:1,annotations:[annotation],tombstones:[tombstone]};
 const store={sourceProtocol:'obreader-current-v15',documentForPath:async()=>document,registerDocument:async({source:actual})=>{assert.equal(actual.sourceHash,source.sourceHash);return {...document,sourceMatch:'MATCH'}},readDocument:async()=>snapshot,
 updateSourceIdentity:async({pairId})=>pairId===id?{document,sourceMatch:'MATCH'}:{document,sourceMismatch:true,sourceMatch:'MISMATCH'}};
 const adapter={async read(){throw Error('missing')},async write(){},async exists(){return false},async mkdir(){},async rename(){}};
 const app={vault:{adapter,getAbstractFileByPath:()=>file}};
 const host=createPdfAnnotationHost({app,hashRuntime:runtime,makeToken:randomUUID,deviceId:'test',storeFactory:()=>store});
 const view=()=>({documentId:'pending',openRequest:1,requestedPath:file.path,documentFile:file,file,iframe:{},messages:[],postToViewer(m){this.messages.push(m)},setStatus(){}});
 try{
  const v=view(),initial=await host.initializeView(v,paired.bytes);v.documentId=initial.documentId;
  assert.deepEqual(initial.annotations,[]);assert.deepEqual(initial.tombstones,[tombstone]);assert.equal(initial.requiresPairValidation,true);assert.equal(v.annotationHydrationAllowed,false);
  await host.handleMessage(v,{type:'annotation-source-identity',documentId:v.documentId,openRequest:1,pairId:'34'.repeat(16),pageCount:source.pageCount,orderedPageIdentities:source.orderedPageIdentities,identityStatus:'KNOWN'});
  assert.equal(v.annotationHydrationAllowed,false);assert.equal(v.annotationSourceMismatch,true);
  const v2=view(),next=await host.initializeView(v2,paired.bytes);v2.documentId=next.documentId;
  await host.handleMessage(v2,{type:'annotation-source-identity',documentId:v2.documentId,openRequest:1,pairId:id,pageCount:source.pageCount,orderedPageIdentities:source.orderedPageIdentities,identityStatus:'KNOWN'});
  assert.equal(v2.annotationHydrationAllowed,true);assert.equal(v2.messages.at(-1).externalAnnotations.annotations[0].uuid,'A');
 }finally{host.dispose()}
});

test('a replaced Reader session cannot be changed by a late asynchronous PDF hash',async()=>{
 const original=await fixture(),id='12'.repeat(16),paired=await attachPairId(original.bytes,id),runtime=await createPdfHashRuntime();
 const file={path:'Books/a.pdf',stat:{size:paired.bytes.length,mtime:1}},document={documentId:'old',docKey:'123456abcdef',sourcePath:file.path,source:{...original.source,sourceHash:runtime.fingerprint(original.bytes)},pairId:id,pairing:{pairedSha256:sha(paired.bytes)}};
 let enter,release,registrations=0;const entered=new Promise(r=>enter=r),pending=new Promise(r=>release=r);
 const delayed={...runtime,async matchesAsync(){enter();await pending;return true}};
 const store={sourceProtocol:'obreader-current-v15',documentForPath:async()=>document,async registerDocument(){registrations++;return document}};
 const adapter={async read(){throw Error('missing')},async write(){},async exists(){return false},async mkdir(){},async rename(){}};
 const host=createPdfAnnotationHost({app:{vault:{adapter,getAbstractFileByPath:()=>file}},hashRuntime:delayed,makeToken:randomUUID,deviceId:'test',storeFactory:()=>store});
 const view={documentId:'pending',openRequest:1,requestedPath:file.path,documentFile:file,file,iframe:{},setStatus(){}};
 try {const task=host.initializeView(view,paired.bytes);await entered;view.openRequest=2;view.annotationDocument={documentId:'new'};release();
  await assert.rejects(task,{code:'PDF_ANNOTATION_SESSION_CHANGED'});assert.equal(registrations,0);assert.equal(view.annotationDocument.documentId,'new');
 }finally{host.dispose()}
});

test('first annotation pairs the PDF once and survives a fresh reader session',async()=>{
 const original=await fixture(), runtime=await createPdfHashRuntime();
 let pdf=Uint8Array.from(original.bytes),writes=0,failPartial=true;
 const files=new Map(),dirs=new Set();
 const adapter={async exists(p){return files.has(p)||dirs.has(p)},async mkdir(p){dirs.add(p)},async read(p){if(!files.has(p))throw Error('missing');return files.get(p)},async write(p,t){files.set(p,t)},async process(p,fn){files.set(p,fn(files.get(p)))},async rename(a,b){if(files.has(b))throw Error('exists');files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)},async list(p){return {files:[...files.keys()].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/')),folders:[...dirs].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/'))}}};
 const file={path:'Books/new.pdf',stat:{size:pdf.length,mtime:1}};
 const app={vault:{adapter,configDir:'.obsidian',getAbstractFileByPath:()=>file,async readBinary(){return pdf.slice().buffer},async appendBinary(_file,bytes){writes++;let suffix=new Uint8Array(bytes);if(failPartial)suffix=suffix.subarray(0,Math.floor(suffix.length/2));const combined=new Uint8Array(pdf.length+suffix.length);combined.set(pdf);combined.set(suffix,pdf.length);pdf=combined;file.stat.size=pdf.length;file.stat.mtime++;if(failPartial){failPartial=false;throw Error('partial append')}}}};
 const host=createPdfAnnotationHost({app,hashRuntime:runtime,identityHash:sha,makeToken:randomUUID,deviceId:'test',enableSingleJsonl:true});
 const makeView=()=>({documentId:'pending',openRequest:1,requestedPath:file.path,documentFile:file,file,iframe:{},messages:[],postToViewer(m){this.messages.push(m)},setStatus(){}});
 try {
  const v=makeView(),initial=await host.initializeView(v,pdf);v.documentId=initial.documentId;
  const other=makeView(),otherInitial=await host.initializeView(other,pdf);other.documentId=otherInitial.documentId;
  assert.equal(writes,0);assert.equal(await readPairId(pdf),null);
  await host.handleMessage(v,{type:'annotation-source-identity',documentId:v.documentId,openRequest:1,pairId:null,pageCount:original.source.pageCount,orderedPageIdentities:original.source.orderedPageIdentities,identityStatus:'KNOWN'});
  await host.handleMessage(other,{type:'annotation-source-identity',documentId:other.documentId,openRequest:1,pairId:null,pageCount:original.source.pageCount,orderedPageIdentities:original.source.orderedPageIdentities,identityStatus:'KNOWN'});
  await host.handleMessage(v,{type:'save',documentId:v.documentId,openRequest:1,requestId:'first',revision:1,operations:[{uuid:'first-annotation',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,rect:[1,2,3,4]}}}]});
  assert.equal(v.messages.at(-1).type,'error');assert.deepEqual(pdf.slice(0,original.bytes.length),Uint8Array.from(original.bytes));
  assert.equal(await host.handleSourceModify(file),true);
  await host.handleMessage(v,{type:'save',documentId:v.documentId,openRequest:1,requestId:'first-retry',revision:1,operations:[{uuid:'first-annotation',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,rect:[1,2,3,4]}}}]});
  assert.equal(v.messages.at(-1).type,'saved',JSON.stringify(v.messages.at(-1)));
  assert.equal(writes,2);const id=await readPairId(pdf);assert.match(id,/^[0-9a-f]{32}$/);
  assert.deepEqual(pdf.slice(0,original.bytes.length),Uint8Array.from(original.bytes));
  assert.equal(await host.handleSourceModify(file),true);
  const core=createSingleJsonlStore({adapter,token:randomUUID});
  assert.deepEqual((await core.readCurrent(file.path,id)).annotations.map(row=>row.uuid),['first-annotation']);
  await host.handleMessage(other,{type:'save',documentId:other.documentId,openRequest:1,requestId:'second',revision:2,operations:[{uuid:'second-annotation',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,rect:[2,3,4,5]}}}]});
  assert.equal(other.messages.at(-1).type,'saved',JSON.stringify(other.messages.at(-1)));assert.equal(writes,2);
  await Promise.all([
   host.handleMessage(v,{type:'save',documentId:v.documentId,openRequest:1,requestId:'concurrent-a',revision:3,operations:[{uuid:'concurrent-a',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,rect:[1,2,3,4]}}}]}),
   host.handleMessage(other,{type:'save',documentId:other.documentId,openRequest:1,requestId:'concurrent-b',revision:3,operations:[{uuid:'concurrent-b',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,rect:[2,3,4,5]}}}]})
  ]);
  assert.ok(v.messages.some(m=>m.type==='saved'&&m.requestId==='concurrent-a'));
  assert.ok(other.messages.some(m=>m.type==='saved'&&m.requestId==='concurrent-b'));
  assert.deepEqual((await core.readCurrent(file.path,id)).annotations.map(row=>row.uuid),['concurrent-a','concurrent-b','first-annotation','second-annotation']);
  const next=makeView(),reopened=await host.initializeView(next,pdf);next.documentId=reopened.documentId;
  await host.handleMessage(next,{type:'annotation-source-identity',documentId:next.documentId,openRequest:1,pairId:id,pageCount:original.source.pageCount,orderedPageIdentities:original.source.orderedPageIdentities,identityStatus:'KNOWN'});
  assert.deepEqual(next.messages.at(-1).externalAnnotations.annotations.map(row=>row.uuid),['concurrent-a','concurrent-b','first-annotation','second-annotation']);
  const oldPath=file.path;file.path='Other/renamed.pdf';
  assert.equal(await host.renamed(file,oldPath),true);
  assert.equal(await core.readCurrent(oldPath,id),null);
  assert.deepEqual((await core.readCurrent(file.path,id)).annotations.map(row=>row.uuid),['concurrent-a','concurrent-b','first-annotation','second-annotation']);
  await host.handleMessage(next,{type:'save',documentId:next.documentId,openRequest:1,requestId:'after-rename',revision:3,operations:[{uuid:'after-rename',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,rect:[3,4,5,6]}}}]});
  assert.equal(next.messages.at(-1).type,'saved',JSON.stringify(next.messages.at(-1)));
  assert.equal((await core.readCurrent(file.path,id)).annotations.length,5);assert.equal(writes,2);
  await host.handleMessage(next,{type:'save',documentId:next.documentId,openRequest:1,requestId:'delete',revision:4,operations:[{uuid:'after-rename',kind:'Square',pageIndex:0,deleted:true}]});
  assert.equal(next.messages.at(-1).type,'saved');
  const deletedReopen=await host.initializeView({...next,documentId:'pending',messages:[],postToViewer(){}},pdf);
  const tombstone=deletedReopen.tombstones.find(row=>row.uuid==='after-rename');assert.ok(tombstone);
  assert.equal(Object.hasOwn(tombstone,'deleted'),false,'Viewer schema 2 requires deleted records in the tombstone ledger without a deleted property');
  assert.equal([...files.keys()].some(p=>/backup|\.bak$/i.test(p)),false);
 } finally {host.dispose()}
});

test('real single-file store connects to the host and restores saved annotations after pair confirmation',async()=>{
 const original=await fixture(),id='12'.repeat(16),paired=await attachPairId(original.bytes,id),runtime=await createPdfHashRuntime();
 const files=new Map(),dirs=new Set();let token=0;
 const adapter={async exists(p){return files.has(p)||dirs.has(p)},async mkdir(p){dirs.add(p)},async read(p){if(!files.has(p))throw Error('missing');return files.get(p)},async write(p,t){files.set(p,t)},async process(p,fn){files.set(p,fn(files.get(p)))},async rename(a,b){if(files.has(b))throw Error('exists');files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)},async list(p){return {files:[...files.keys()].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/')),folders:[...dirs].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/'))}}};
 const file={path:'Books/real.pdf',stat:{size:paired.bytes.length,mtime:1}},source={...original.source,sourceHash:runtime.fingerprint(original.bytes)};
 const document={docKey:'123456abcdef',documentId:'legacy-id',sourcePath:file.path,source,pairId:id,pairing:{pairedSha256:sha(paired.bytes)},legacyIdentities:[{uuid:'legacy-deleted',kind:'Highlight',pageIndex:0,deleted:true,ref:'8R',timestamp:123}],legacyIdentityScanComplete:true};
 const seeded=createSingleJsonlStore({adapter,token:()=>`seed-${++token}`});
 await seeded.initialize({document,pairId:id,annotations:[{uuid:'A',kind:'Highlight',pageIndex:0,payload:{targetText:'real'}}]});
 const beforeOpen=new Map(files);
 let asyncChecks=0;const verifiedRuntime={...runtime,async matchesAsync(bytes,expected){asyncChecks++;return runtime.matchesAsync(bytes,expected)}};
 const app={vault:{adapter,getAbstractFileByPath:()=>file}},host=createPdfAnnotationHost({app,hashRuntime:verifiedRuntime,identityHash:sha,makeToken:randomUUID,deviceId:'test',enableSingleJsonl:true});
 const v={documentId:'pending',openRequest:1,requestedPath:file.path,documentFile:file,file,iframe:{},messages:[],postToViewer(m){this.messages.push(m)},setStatus(){}};
 try{
  const initial=await host.initializeView(v,paired.bytes);assert.equal(initial.documentId,document.documentId);assert.equal(initial.requiresPairValidation,true);assert.deepEqual(initial.annotations,[]);
  assert.ok(asyncChecks>0,'paired source verification uses the asynchronous hash path');
  assert.deepEqual(files,beforeOpen,'opening a migrated document must not replay legacy identities as new operations');
  assert.equal(initial.tombstones[0].uuid,'legacy-deleted');assert.equal(initial.tombstones[0].embeddedRef,'8R');
  v.documentId=initial.documentId;
  await assert.rejects(host.migrateLegacyVault(),{code:'V15_READERS_OPEN'});
  await host.handleMessage(v,{type:'annotation-source-identity',documentId:v.documentId,openRequest:1,pairId:id,pageCount:source.pageCount,orderedPageIdentities:source.orderedPageIdentities,identityStatus:'KNOWN'});
  assert.equal(v.annotationHydrationAllowed,true);assert.equal(v.messages.at(-1).externalAnnotations.annotations[0].uuid,'A');
  assert.equal(v.messages.at(-1).externalAnnotations.tombstones[0].uuid,'legacy-deleted');
  await host.handleMessage(v,{type:'save',documentId:v.documentId,openRequest:1,requestId:'save-1',revision:2,
    operations:[{uuid:'B',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,rect:[1,2,3,4]}}}]});
  assert.equal(v.messages.at(-1).type,'saved',JSON.stringify(v.messages.at(-1)));
  assert.equal(v.messages.at(-1).operationCount,1);
  assert.deepEqual((await seeded.readCurrent(file.path,id)).annotations.map(row=>row.uuid),['A','B']);
  await host.handleMessage(v,{type:'save',documentId:v.documentId,openRequest:1,requestId:'restore',revision:3,
    operations:[{uuid:'legacy-deleted',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,pageIndex:0,rect:[1,2,3,4]}}}]});
  assert.equal(v.messages.at(-1).type,'saved');
  const restored=await host.initializeView({...v,documentId:'pending',messages:[],postToViewer(){}},paired.bytes);
  assert.equal(restored.tombstones.some(row=>row.uuid==='legacy-deleted'),false,'a current restored annotation must beat the old deletion mask');
 }finally{host.dispose()}
});
