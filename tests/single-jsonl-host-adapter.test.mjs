import assert from 'node:assert/strict';import {test} from 'node:test';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {createSingleJsonlAnnotationStore}=require('../plugin/storage/single-jsonl-annotation-store.cjs');
const sha=x=>'sha256-v1:'+createHash('sha256').update(x).digest('hex');
function fixture(options={}){const files=new Map(),dirs=new Set();let seq=0;const adapter={
 async exists(p){return files.has(p)||dirs.has(p)},async mkdir(p){dirs.add(p)},async read(p){if(!files.has(p))throw Error('missing');return files.get(p)},async write(p,t){files.set(p,t)},async process(p,fn){files.set(p,fn(files.get(p)))},async rename(a,b){if(files.has(b))throw Error('exists');files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)},async list(p){return {files:[...files.keys()].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/')),folders:[...dirs].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/'))}}};
 const store=createSingleJsonlAnnotationStore({adapter,identityHash:sha,uuid:()=>`test-${++seq}`,...options});return {files,store,adapter}}
const source={sourceHash:'sha256-v1:'+'1'.repeat(64),size:100,pageCount:1,orderedPageIdentities:['ref:4R']};
const pairId='12'.repeat(16),row={uuid:'A',kind:'Highlight',pageIndex:0,payload:{targetText:'kept text'}};
test('reading a new PDF establishes no files or random pair identity',async()=>{
 const w=fixture(),document=await w.store.registerDocument({sourcePath:'Books/a.pdf',source});
 const snapshot=await w.store.readDocument(document);
 assert.equal(w.files.size,0);assert.equal(snapshot.annotations.length,0);assert.equal(snapshot.pairId,null);
 const confirmed=await w.store.updateSourceIdentity({document,pairId:null,pageCount:1,orderedPageIdentities:['ref:4R']});
 assert.equal(confirmed.sourceMatch,'BASELINE_ESTABLISHED');assert.equal(w.files.size,0);
 const missing=await w.store.updateSourceIdentity({document,pairId:'34'.repeat(16),pageCount:1,orderedPageIdentities:['ref:4R']});
 assert.equal(missing.sourceMismatch,true,'a paired PDF without its current file cannot silently start a new annotation set');
});
test('a stable link created before the first annotation resolves after restart without pairing the PDF',async()=>{
 const w=fixture(),document=await w.store.registerDocument({sourcePath:'Books/unannotated.pdf',source});
 assert.equal(w.files.size,0,'reading alone writes no data');
 await w.store.ensureDocumentIdentity(document);
 assert.equal([...w.files.keys()].some(path=>path.endsWith('.jsonl')),false,'link identity does not create an annotation file');
 const restarted=createSingleJsonlAnnotationStore({adapter:w.adapter,identityHash:sha,uuid:()=> 'fresh-test'});
 const resolved=await restarted.documentForIdentity({docKey:document.docKey,documentId:document.documentId});
 assert.equal(resolved.sourcePath,document.sourcePath);assert.equal(resolved.pairId,undefined);
 const reopened=await restarted.registerDocument({sourcePath:document.sourcePath,source});
 assert.equal(reopened.documentId,document.documentId);assert.equal(reopened.docKey,document.docKey);
});
test('stable links repair a missing or corrupt v15 registry only from a uniquely verified current file',async()=>{
 const w=fixture(),document={documentId:'linked-doc',docKey:'123456abcdef',sourcePath:'Books/a.pdf',source};
 await w.store.core.initialize({document,pairId,annotations:[row]});
 await w.store.registry.remember(await w.store.core.readCurrent(document.sourcePath,pairId));
 const registry=w.store.registry.path;w.files.delete(registry);
 let restored=await w.store.documentForIdentity({docKey:document.docKey,documentId:document.documentId});
 assert.equal(restored.sourcePath,document.sourcePath);assert.equal(restored.pairId,pairId);
 w.files.set(registry,'{broken');restored=await w.store.documentForIdentity({docKey:document.docKey,documentId:document.documentId});
 assert.equal(restored.sourcePath,document.sourcePath);assert.equal(JSON.parse(w.files.get(registry)).entries[pairId].documentId,document.documentId);
 w.files.set(registry,'{broken');await assert.rejects(w.store.documentForIdentity({docKey:'ffffffffffff',documentId:'unknown'}));
 assert.equal(w.files.get(registry),'{broken','unverified target cannot overwrite the broken registry');
 const legacy=JSON.stringify({schemaVersion:1,entries:{'Books/old.pdf':{documentId:'old',docKey:'fedcba987654'}}});w.files.set(registry,legacy);
 await assert.rejects(w.store.documentForIdentity({docKey:document.docKey,documentId:document.documentId}),{code:'V15_REGISTRY_REBUILD_REQUIRED'});
 assert.equal(w.files.get(registry),legacy,'old format still needs explicit migration');
});
test('migrated current file preserves logical source and exact Viewer snapshot/save contract',async()=>{
 const w=fixture(),document={documentId:'old',docKey:'123456abcdef',sourcePath:'Books/a.pdf',source,pairing:{pairedSha256:'sha256-v1:'+'2'.repeat(64)}};
 await w.store.core.initialize({document,pairId,annotations:[row]});
 await w.store.registry.remember(await w.store.core.readCurrent(document.sourcePath,pairId));
 const registered=await w.store.registerDocument({sourcePath:document.sourcePath,source:{...source,sourceHash:document.pairing.pairedSha256}});
 assert.equal(registered.sourceMatch,'MATCH');assert.equal(registered.source.sourceHash,source.sourceHash);
 const bad=await w.store.updateSourceIdentity({document:registered,pairId:'34'.repeat(16),...source});assert.equal(bad.sourceMismatch,true);
 const good=await w.store.updateSourceIdentity({document:registered,pairId,...source});assert.equal(good.sourceMatch,'MATCH');
 const result=await w.store.appendOperations({document:registered,sourceHash:source.sourceHash,operations:[row]});
 assert.equal(result.operationCount,1);assert.equal(typeof result.batchId,'string');
 assert.deepEqual((await w.store.readDocument(registered)).annotations,[row]);
 assert.deepEqual(await w.store.core.readHistory(document.sourcePath,pairId),[],'a no-op retry does not fabricate new history');
});
test('first annotation invokes the pairing boundary once and saves through the current-state file',async()=>{
 let paired=0;const w=fixture({pairDocument:async document=>{paired++;return {pairId,document:{...document,pairId}}}});
 const document=await w.store.registerDocument({sourcePath:'Books/a.pdf',source});
 await w.store.appendOperations({document,sourceHash:source.sourceHash,operations:[row]});
 await w.store.appendOperations({document,sourceHash:source.sourceHash,operations:[row]});
 assert.equal(paired,1);assert.equal((await w.store.readDocument(document)).annotations[0].uuid,'A');
 assert.equal([...w.files].some(([p])=>p.includes('/wal/')),false);
});
test('a failed registry publication is retried before an annotation is acknowledged',async()=>{
 let paired=0;const w=fixture({pairDocument:async document=>{paired++;return {pairId,document:{...document,pairId}}}});
 const originalWrite=w.adapter.write;let failOnce=true;
 w.adapter.write=async(p,t)=>{if(p.endsWith('/_registry.json')&&failOnce){failOnce=false;throw Error('injected registry failure')}return originalWrite(p,t)};
 const document=await w.store.registerDocument({sourcePath:'Books/a.pdf',source});
 await assert.rejects(w.store.appendOperations({document,sourceHash:source.sourceHash,operations:[row]}),/injected registry failure/);
 // The host may already have published the newly paired document to the view.
 await w.store.appendOperations({document:{...document,pairId},sourceHash:source.sourceHash,operations:[row]});
 assert.equal(paired,2,'retry revalidates pairing before acknowledging the annotation');assert.equal((await w.store.registry.lookup(pairId)).annotations[0].uuid,'A');
});
test('a failed first PDF pairing cannot acknowledge annotations before pairing is verified',async()=>{
 let attempts=0,w;
 w=fixture({pairDocument:async document=>{attempts++;await w.store.core.initialize({document:{...document,pairId},pairId});throw Error('injected partial PDF append')}});
 const document=await w.store.registerDocument({sourcePath:'Books/a.pdf',source});
 await assert.rejects(w.store.appendOperations({document,sourceHash:source.sourceHash,operations:[row]}),/partial PDF append/);
 await assert.rejects(w.store.appendOperations({document,sourceHash:source.sourceHash,operations:[row]}),/partial PDF append/);
 assert.equal(attempts,2);assert.deepEqual((await w.store.core.readCurrent(document.sourcePath,pairId)).annotations,[]);
});
