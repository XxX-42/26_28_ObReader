import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,appendFile,rename,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fixture} from './pdf-outline-fixtures.mjs';
const require=createRequire(import.meta.url);
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {readPairId,appendPairUpdate}=require('../plugin/pdf-pair-id.cjs');
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createSingleJsonlMigrationRunner}=require('../plugin/storage/single-jsonl-migration-runner.cjs');
const {createSingleJsonlAnnotationStore}=require('../plugin/storage/single-jsonl-annotation-store.cjs');
const {createPdfAnnotationHost}=require('../plugin/pdf-annotation-host.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');

async function filesystemFixture(t){
 const parent=path.resolve(tmpdir()),root=await mkdtemp(path.join(parent,'obreader-v15-test-'));
 assert.equal(path.dirname(root),parent);assert.ok(path.basename(root).startsWith('obreader-v15-test-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const absolute=p=>{const result=path.resolve(root,...p.split('/'));assert.ok(result.startsWith(root+path.sep));return result};
 const adapter={async exists(p){try{await stat(absolute(p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}},
  async mkdir(p){await mkdir(absolute(p))},async read(p){return readFile(absolute(p),'utf8')},async write(p,v){await writeFile(absolute(p),v)},
  async process(p,fn){await writeFile(absolute(p),fn(await readFile(absolute(p),'utf8')))},async rename(a,b){await rename(absolute(a),absolute(b))},
  async remove(p){await rm(absolute(p))},async list(p){const entries=await readdir(absolute(p),{withFileTypes:true});return {files:entries.filter(e=>e.isFile()).map(e=>p+'/'+e.name),folders:entries.filter(e=>e.isDirectory()).map(e=>p+'/'+e.name)}}};
 return {root,absolute,adapter};
}

test('real filesystem first pairing survives a new store without later PDF writes',async t=>{
 const {absolute,adapter}=await filesystemFixture(t);
 const original=await fixture(),runtime=await createPdfHashRuntime(),pdf='Books/fixture.pdf';await mkdir(absolute('Books'));await writeFile(absolute(pdf),original.bytes);
 let writes=0;const vault={async readBinary(){const bytes=await readFile(absolute(pdf));return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)},async appendBinary(_file,bytes){writes++;await appendFile(absolute(pdf),Buffer.from(bytes))}};
 const core=createSingleJsonlStore({adapter,token:randomUUID});
 const runner=createSingleJsonlMigrationRunner({adapter,store:core,journalRoot:'.obsidian/plugins/pdf-web-reader/.v15-migration',verifySource:runtime.matches,readPdf:()=>vault.readBinary(),writePdf:(_p,bytes)=>appendPairUpdate(vault,{},bytes)});
 const makeStore=()=>createSingleJsonlAnnotationStore({adapter,identityHash:b=>'sha256-v1:'+sha(b),hash:runtime.fingerprint,uuid:randomUUID,pairDocument:document=>runner.migrate({document,snapshot:{annotations:[],tombstones:[],deletionGuards:[]}})});
 const store=makeStore(),document=await store.registerDocument({sourcePath:pdf,source:original.source});
 assert.equal(writes,0);assert.equal(sha(await readFile(absolute(pdf))),sha(original.bytes));
 await store.ensureDocumentIdentity(document);
 const linkRestart=makeStore(),linked=await linkRestart.documentForIdentity({docKey:document.docKey,documentId:document.documentId});
 assert.equal(linked.sourcePath,pdf);assert.equal(writes,0);assert.equal(sha(await readFile(absolute(pdf))),sha(original.bytes));
 assert.equal(await adapter.exists(store.core.pathsFor(pdf).current),false,'a stable link does not create an annotation file');
 const reopenedUnpaired=await linkRestart.registerDocument({sourcePath:pdf,source:original.source});
 assert.equal(reopenedUnpaired.documentId,document.documentId);assert.equal(reopenedUnpaired.docKey,document.docKey);
 const row={uuid:'filesystem-highlight',kind:'Highlight',pageIndex:0,payload:{targetText:'filesystem validation'}};
 const result=await linkRestart.appendOperations({document:reopenedUnpaired,sourceHash:original.source.sourceHash,operations:[row]});assert.equal(result.acknowledged,true);assert.equal(writes,1);
 const paired=await readFile(absolute(pdf)),pairId=await readPairId(paired);assert.match(pairId,/^[a-f0-9]{32}$/);const pairedHash=sha(paired);
 const fresh=makeStore(),route=await fresh.documentForPath(pdf),snapshot=await fresh.readDocument(route);
 assert.equal(snapshot.annotations.length,1);assert.equal(snapshot.annotations[0].uuid,row.uuid);assert.equal(snapshot.annotations[0].payload.targetText,row.payload.targetText);
 await fresh.appendOperations({document:route,sourceHash:route.source.sourceHash,operations:[{...row,payload:{targetText:'edited'}}]});
 assert.equal(writes,1);assert.equal(sha(await readFile(absolute(pdf))),pairedHash);
 assert.equal((await fresh.core.readHistory(pdf,pairId)).length,2);
 for(let i=0;i<105;i++)await fresh.appendOperations({document:route,sourceHash:route.source.sourceHash,operations:[{...row,payload:{targetText:`edit-${i}`}}]});
 const finalStore=makeStore(),finalRoute=await finalStore.documentForPath(pdf),finalSnapshot=await finalStore.readDocument(finalRoute);
 assert.equal(finalSnapshot.annotations.length,1);assert.equal(finalSnapshot.annotations[0].payload.targetText,'edit-104');
 assert.equal((await finalStore.core.readHistory(pdf,pairId)).length,100);
 assert.equal(writes,1);assert.equal(sha(await readFile(absolute(pdf))),pairedHash);
 const renamed='Books/renamed.pdf';await rename(absolute(pdf),absolute(renamed));
 await finalStore.renameDocument({documentId:finalRoute.documentId,fromPath:pdf,toPath:renamed});
 const afterRename=makeStore(),renamedRoute=await afterRename.documentForPath(renamed);
 assert.equal(renamedRoute.documentId,finalRoute.documentId);assert.equal(renamedRoute.pairId,pairId);
 assert.equal((await afterRename.readDocument(renamedRoute)).annotations[0].payload.targetText,'edit-104');
 assert.equal((await afterRename.core.readHistory(renamed,pairId)).length,100);
 assert.equal(sha(await readFile(absolute(renamed))),pairedHash);
 await writeFile(absolute(afterRename.registry.path),'{broken');
 const identityAfterRepair=await makeStore().documentForIdentity({docKey:renamedRoute.docKey,documentId:renamedRoute.documentId});
 assert.equal(identityAfterRepair.sourcePath,renamed);assert.equal(identityAfterRepair.pairId,pairId);
 assert.equal((await afterRename.readDocument(identityAfterRepair)).annotations[0].payload.targetText,'edit-104');
 assert.equal(sha(await readFile(absolute(renamed))),pairedHash);
 // On a real filesystem, interrupt the history publication after the current
 // file is committed; a fresh store must recover the exact staged history.
 const originalProcess=adapter.process,historyPath=afterRename.core.pathsFor(renamed).history;
 adapter.process=async(p,fn)=>{if(p===historyPath)throw Error('injected history publication failure');return originalProcess(p,fn)};
 await assert.rejects(afterRename.appendOperations({document:renamedRoute,sourceHash:renamedRoute.source.sourceHash,
  operations:[{...row,payload:{targetText:'saved-before-history-recovery'}}]}),/injected history publication failure/);
 adapter.process=originalProcess;
 const recovered=makeStore(),recoveredRoute=await recovered.documentForPath(renamed);
 assert.equal((await recovered.readDocument(recoveredRoute)).annotations[0].payload.targetText,'saved-before-history-recovery');
 const stagedHistory=await recovered.core.readHistory(renamed,pairId);
 assert.equal(stagedHistory.length,100);assert.equal(stagedHistory.at(-1).after.payload.targetText,'saved-before-history-recovery');
 await recovered.appendOperations({document:recoveredRoute,sourceHash:recoveredRoute.source.sourceHash,operations:[{...row,payload:{targetText:'after-history-recovery'}}]});
 assert.equal((await recovered.core.readHistory(renamed,pairId)).at(-1).after.payload.targetText,'after-history-recovery');
 assert.equal(sha(await readFile(absolute(renamed))),pairedHash);assert.equal(writes,1);
 // Interrupt after the new route is durable and the old current file has
 // been removed, then finish the exact same rename in a fresh store.
 const relocated='Books/relocated.pdf';await rename(absolute(renamed),absolute(relocated));
 const originalRemove=adapter.remove;let removeCount=0;
 adapter.remove=async p=>{if(++removeCount===2)throw Error('injected rename interruption');return originalRemove(p)};
 await assert.rejects(recovered.renameDocument({documentId:recoveredRoute.documentId,fromPath:renamed,toPath:relocated}),/injected rename interruption/);
 adapter.remove=originalRemove;
 const restart=makeStore();
 await assert.rejects(restart.renameDocument({documentId:'wrong-document',fromPath:renamed,toPath:relocated}),{code:'V15_IDENTITY_CONFLICT'});
 await assert.rejects(restart.renameDocument({documentId:recoveredRoute.documentId,fromPath:'Books/wrong.pdf',toPath:relocated}),{code:'V15_IDENTITY_CONFLICT'});
 const host=createPdfAnnotationHost({app:{vault:{adapter,getAbstractFileByPath:()=>null}},hashRuntime:runtime,makeToken:randomUUID,deviceId:'test',storeFactory:()=>restart,enableSingleJsonl:true});
 try{assert.equal(await host.renamed({path:relocated,stat:{size:0}},renamed),true);}finally{host.dispose()}
 const relocatedRoute=await restart.documentForPath(relocated),relocatedSnapshot=await restart.readDocument(relocatedRoute);
 assert.equal(relocatedRoute.documentId,finalRoute.documentId);assert.equal(relocatedRoute.pairId,pairId);
 assert.equal(relocatedSnapshot.annotations[0].payload.targetText,'after-history-recovery');
 assert.equal((await restart.core.readHistory(relocated,pairId)).length,100);
 assert.equal(sha(await readFile(absolute(relocated))),pairedHash);
});

test('real filesystem can resume an interrupted first PDF pairing without a backup',async t=>{
 const {absolute,adapter}=await filesystemFixture(t),original=await fixture(),runtime=await createPdfHashRuntime(),pdf='Books/fixture.pdf';
 await mkdir(absolute('Books'));await writeFile(absolute(pdf),original.bytes);let interrupted=true;
 const vault={async readBinary(){const b=await readFile(absolute(pdf));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)},
  async appendBinary(_file,value){const suffix=Buffer.from(value);if(interrupted){interrupted=false;await appendFile(absolute(pdf),suffix.subarray(0,Math.floor(suffix.length/2)));throw Error('injected interrupted append')}await appendFile(absolute(pdf),suffix)}};
 const makeRunner=()=>createSingleJsonlMigrationRunner({adapter,store:createSingleJsonlStore({adapter,token:randomUUID}),journalRoot:'.obsidian/plugins/pdf-web-reader/.v15-migration',verifySource:runtime.matches,readPdf:()=>vault.readBinary(),writePdf:(_p,bytes)=>appendPairUpdate(vault,{},bytes)});
 const document={sourcePath:pdf,docKey:'123456abcdef',documentId:'legacy-id',source:original.source};
 const snapshot={annotations:[{uuid:'old-highlight',kind:'Highlight',pageIndex:0,payload:{targetText:'preserved'}}],tombstones:[],deletionGuards:[]};
 await assert.rejects(makeRunner().migrate({document,snapshot}),/injected interrupted append/);
 const damaged=await readFile(absolute(pdf));assert.deepEqual(damaged.subarray(0,original.bytes.length),Buffer.from(original.bytes));
 const recovered=await makeRunner().migrate({document,snapshot});assert.equal(recovered.resumed,true);
 assert.equal(await readPairId(await readFile(absolute(pdf))),recovered.pairId);
 const fresh=createSingleJsonlStore({adapter,token:randomUUID}),current=await fresh.readCurrent(pdf,recovered.pairId);
 assert.equal(current.annotations.length,1);assert.equal(current.annotations[0].uuid,'old-highlight');assert.equal(current.annotations[0].payload.targetText,'preserved');
});

test('real filesystem rejects corrupted current or history files without overwriting them',async t=>{
 const {absolute,adapter}=await filesystemFixture(t),store=createSingleJsonlStore({adapter,token:randomUUID});
 const document={sourcePath:'Books/corrupt.pdf',docKey:'123456abcdef',documentId:'corruption-test',source:{sourceHash:'sha256-v1:'+'1'.repeat(64)}};
 const pairId='42'.repeat(16),row={uuid:'saved',kind:'Highlight',pageIndex:0,payload:{targetText:'keep'}};
 await store.initialize({document,pairId,annotations:[row]});const paths=store.pathsFor(document.sourcePath);
 const currentOriginal=await readFile(absolute(paths.current),'utf8'),historyOriginal=await readFile(absolute(paths.history),'utf8');
 const brokenCurrent=currentOriginal.slice(0,Math.floor(currentOriginal.length/2));await writeFile(absolute(paths.current),brokenCurrent);
 await assert.rejects(store.save({sourcePath:document.sourcePath,pairId,changes:[{...row,payload:{targetText:'must not save'}}]}),{code:'V15_FILE_INVALID'});
 assert.equal(await readFile(absolute(paths.current),'utf8'),brokenCurrent);assert.equal(await readFile(absolute(paths.history),'utf8'),historyOriginal);
 await writeFile(absolute(paths.current),currentOriginal);
 const brokenHistory=historyOriginal.slice(0,Math.floor(historyOriginal.length/2));await writeFile(absolute(paths.history),brokenHistory);
 await assert.rejects(store.save({sourcePath:document.sourcePath,pairId,changes:[{...row,payload:{targetText:'must not save'}}]}),{code:'V15_HISTORY_MISSING'});
 assert.equal(await readFile(absolute(paths.current),'utf8'),currentOriginal);assert.equal(await readFile(absolute(paths.history),'utf8'),brokenHistory);
});
