import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createSingleJsonlRegistry}=require('../plugin/storage/single-jsonl-registry.cjs');
const {createSingleJsonlDeferredIndex}=require('../plugin/storage/single-jsonl-deferred.cjs');
const {createSingleJsonlFinalizer,verifyMigratedState,derivedCacheCovered}=require('../plugin/storage/single-jsonl-finalize.cjs');
const root='00_Archive/20_PDFData';
const hash=text=>createHash('sha256').update(text).digest('hex');
const annotation={uuid:'a',kind:'Highlight',pageIndex:0,deleted:false,payload:{editor:{rect:[1,2,3,4],color:[255,0,0]},targetText:'exact text'},version:{rev:1,deviceId:'old',seq:1}};
const document={sourcePath:'Books/a.pdf',docKey:'123456abcdef',documentId:'document-a',source:{sourceHash:'sha256-v1:'+'1'.repeat(64)},legacyIdentities:[]};
async function fixture(){
 const files=new Map(),dirs=new Set(),removed=[];
 const adapter={async exists(p){return files.has(p)||dirs.has(p)},async read(p){assert.ok(files.has(p),'missing '+p);return files.get(p)},async write(p,t){files.set(p,t)},async process(p,fn){files.set(p,fn(files.get(p)))},async mkdir(p){dirs.add(p)},async rename(a,b){files.set(b,files.get(a));files.delete(a)},async remove(p){removed.push(p);files.delete(p)},async list(p){return {files:[...files.keys()].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/')),folders:[...dirs].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/'))}}};
 const store=createSingleJsonlStore({adapter,token:randomUUID}),registry=createSingleJsonlRegistry({adapter,store}),deferred=createSingleJsonlDeferredIndex({adapter});
 await store.initialize({document,pairId:'12'.repeat(16),annotations:[annotation]});
 await adapter.mkdir(root+'/wal');await adapter.mkdir(root+'/wal/old');await adapter.write(root+'/wal/old/'+document.docKey+'.jsonl','old validated log');
 await adapter.write(registry.path,JSON.stringify({schemaVersion:1,kind:'pdf-reader-registry-cache',entries:{[document.sourcePath]:{documentId:document.documentId,docKey:document.docKey}}}));
 const legacy={document,snapshot:{annotations:[annotation],tombstones:[],deletionGuards:[]},errors:[]};
 const options={adapter,store,registry,deferred,readLegacy:async()=>structuredClone(legacy),verifyPair:async()=>true,verifyLegacyFile:async()=>true,hash};
 const finalizer=createSingleJsonlFinalizer(options);
 return {files,dirs,removed,adapter,store,registry,deferred,legacy,options,finalizer};
}
const blocked={code:'V15_FINALIZATION_BLOCKED'};
test('verified registry finalization removes only accounted old files, preserves main/history and supports resume',async()=>{
 const w=await fixture(),before=new Map(w.files),plan=await w.finalizer.prepare(),receipts=[];
 const result=await w.finalizer.apply(plan,{record:async row=>receipts.push(row.phase)});
 assert.equal(result.removed,1);assert.equal(JSON.parse(w.files.get(w.registry.path)).schemaVersion,15);
 for(const [p,t] of before)if(p!==w.registry.path&&!p.includes('/wal/'))assert.equal(w.files.get(p),t);
 assert.deepEqual((await w.store.readCurrent(document.sourcePath)).annotations,[annotation]);
 assert.deepEqual(receipts,['verified','registry-published','complete']);
 assert.equal((await w.finalizer.apply(plan,{record:async()=>{}})).removed,0);
});
test('missing UUID blocks registry publication and cleanup',async()=>{
 const w=await fixture();w.legacy.snapshot.annotations.push({...annotation,uuid:'lost'});
 await assert.rejects(w.finalizer.prepare(),blocked);assert.deepEqual(w.removed,[]);
 assert.equal(JSON.parse(w.files.get(w.registry.path)).schemaVersion,1);
});
test('same UUID/count with changed text or geometry cannot authorize deletion',async()=>{
 const w=await fixture();w.legacy.snapshot.annotations[0].payload.targetText='different';
 await assert.rejects(w.finalizer.prepare(),blocked);assert.deepEqual(w.removed,[]);
});
test('later v15 updates/deletes are preserved by exact history chains, never overwritten with legacy state',async()=>{
 const w=await fixture();await w.store.save({sourcePath:document.sourcePath,pairId:'12'.repeat(16),changes:[{...annotation,payload:{targetText:'new exact text'}}]});
 await w.store.save({sourcePath:document.sourcePath,pairId:'12'.repeat(16),changes:[{uuid:'a',kind:'Highlight',pageIndex:0,deleted:true}]});
 const plan=await w.finalizer.prepare();assert.equal(plan.documents[0].advanced,1);
 await w.finalizer.apply(plan,{record:async()=>{}});
 const state=await w.store.readCurrent(document.sourcePath);assert.equal(state.annotations.length,0);assert.equal(state.tombstones[0].uuid,'a');
 assert.equal((await w.store.readHistory(document.sourcePath)).length,2);
});
test('forged or incomplete history cannot explain a changed legacy winner',()=>{
 const snapshot={annotations:[annotation],tombstones:[]},latest={...annotation,payload:{targetText:'new'}};
 assert.throws(()=>verifyMigratedState({document,snapshot,current:{document,annotations:[latest],tombstones:[]},history:[{uuid:'a',before:{...annotation,payload:{}},after:latest}]}),blocked);
});
test('unpaired empty documents retain exact deferred identity without modifying a PDF',async()=>{
 const w=await fixture(),empty={...document,sourcePath:'Books/empty.pdf',docKey:'abcdef123456',documentId:'empty'};
 await w.deferred.remember(empty);
 const index=JSON.parse(w.files.get(w.registry.path));index.entries[empty.sourcePath]={documentId:empty.documentId,docKey:empty.docKey};w.files.set(w.registry.path,JSON.stringify(index));
 w.options.readLegacy=async p=>p===empty.sourcePath?{document:empty,snapshot:{annotations:[],tombstones:[]}}:w.legacy;
 const f=createSingleJsonlFinalizer(w.options),plan=await f.prepare();assert.equal(plan.documents.filter(d=>d.deferred).length,1);
 await f.apply(plan,{record:async()=>{}});assert.equal((await w.deferred.lookup(empty.sourcePath)).documentId,'empty');
});
test('empty unpaired documents with missing identity cannot silently vanish',()=>{
 assert.throws(()=>verifyMigratedState({document,snapshot:{annotations:[],tombstones:[]},current:null}),blocked);
});
test('partial sync, bad PDF pairing and unverified old files block cleanup',async()=>{
 for(const change of [w=>{w.legacy.snapshot.syncPending=true},w=>{w.options.verifyPair=async()=>false},w=>{w.options.verifyLegacyFile=async()=>false}]){
  const w=await fixture();change(w);await assert.rejects(createSingleJsonlFinalizer(w.options).prepare(),blocked);assert.deepEqual(w.removed,[]);
 }
});
test('corrupt committed history is rejected rather than discarded',async()=>{
 const w=await fixture();w.files.set(w.store.pathsFor(document.sourcePath).history,'broken');
 await assert.rejects(w.finalizer.prepare(),{code:'V15_HISTORY_MISSING'});assert.deepEqual(w.removed,[]);
});
test('unindexed WAL document and unknown files are not cleanup candidates',async()=>{
 for(const p of ['wal/old/abcdefabcdef.jsonl','unexpected.json']){
  const w=await fixture();w.files.set(root+'/'+p,'unknown');await assert.rejects(w.finalizer.prepare(),blocked);
 }
});
test('registry or main bytes changing after plan creation prevent cleanup',async()=>{
 for(const change of [w=>w.files.set(w.registry.path,'changed'),w=>w.files.set(w.store.pathsFor(document.sourcePath).current,'changed')]){
  const w=await fixture(),plan=await w.finalizer.prepare();change(w);await assert.rejects(w.finalizer.apply(plan,{record:async()=>{}}),blocked);assert.deepEqual(w.removed,[]);
 }
});
test('failed receipt prevents any publication or deletion',async()=>{
 const w=await fixture(),plan=await w.finalizer.prepare();await assert.rejects(w.finalizer.apply(plan,{record:async()=>{throw Error('disk full')}}),/disk full/);
 assert.equal(JSON.parse(w.files.get(w.registry.path)).schemaVersion,1);assert.deepEqual(w.removed,[]);
});
test('failure after registry publication can resume with a fresh finalizer and identical state',async()=>{
 const w=await fixture(),plan=await w.finalizer.prepare();await assert.rejects(w.finalizer.apply(plan,{record:async row=>{if(row.phase==='registry-published')throw Error('crash')}}),/crash/);
 assert.equal(JSON.parse(w.files.get(w.registry.path)).schemaVersion,15);assert.deepEqual(w.removed,[]);
 assert.equal((await createSingleJsonlFinalizer(w.options).apply(plan,{record:async()=>{}})).removed,1);
});
test('current state changing during cleanup stops before removing the next file',async()=>{
 const w=await fixture();w.files.set(root+'/_storage-protocol.json','marker');const plan=await w.finalizer.prepare();
 const remove=w.adapter.remove;w.adapter.remove=async p=>{await remove(p);w.files.set(w.store.pathsFor(document.sourcePath).current,'changed')};
 await assert.rejects(w.finalizer.apply(plan,{record:async()=>{}}),blocked);assert.equal(w.removed.length,1);
});
test('arbitrary path injection cannot broaden the cleanup allowlist',async()=>{
 const w=await fixture(),plan=await w.finalizer.prepare();plan.cleanup['Books/a.pdf']='hash';
 await assert.rejects(w.finalizer.apply(plan,{record:async()=>{}}),blocked);assert.deepEqual(w.removed,[]);
});
test('derived cache resequencing accepts only envelope differences, never text/geometry/deletion changes',()=>{
 const op={type:'ANNOTATION_SET',uuid:'a',kind:'Highlight',pageIndex:0,payload:annotation.payload,opId:'old:1',seq:1,version:{rev:1,deviceId:'old',seq:1}};
 const state={annotations:{a:op},tombstones:{},routing:null};
 const resequenced={...op,opId:'old:4',seq:4,version:{rev:1,deviceId:'old',seq:4}};
 assert.equal(derivedCacheCovered({annotations:[resequenced]},state),true);
 for(const changed of [{...resequenced,payload:{targetText:'different'}},{...resequenced,pageIndex:1},{...resequenced,type:'ANNOTATION_DELETE'},{...resequenced,embeddedRef:'other'}])
  assert.equal(derivedCacheCovered({annotations:[changed]},state),false);
 assert.equal(derivedCacheCovered({tombstones:[{...resequenced,type:'ANNOTATION_DELETE'}]},state),false);
});
test('Sync resuming during maintenance stops cleanup without deleting another file',async()=>{
 const w=await fixture(),plan=await w.finalizer.prepare();let checks=0;
 await assert.rejects(w.finalizer.apply(plan,{record:async()=>{},assertQuiescent(){if(++checks>1)throw Error('Sync resumed')}}),/Sync resumed/);
 assert.equal(JSON.parse(w.files.get(w.registry.path)).schemaVersion,15);assert.deepEqual(w.removed,[]);
});
