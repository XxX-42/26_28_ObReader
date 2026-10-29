import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {PDFDocument}=require('pdf-lib');
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createSingleJsonlMigrationRunner}=require('../plugin/storage/single-jsonl-migration-runner.cjs');
const {readPairId}=require('../plugin/pdf-pair-id.cjs');
const sha=b=>'sha256-v1:'+createHash('sha256').update(b).digest('hex');
async function fixture(){
 const pdf=await PDFDocument.create();pdf.addPage();let bytes=new Uint8Array(await pdf.save({useObjectStreams:false}));const original=bytes.slice();
 const files=new Map(),dirs=new Set();let n=0,failWrite=false,failAfter=false,failPartial=false;
 const adapter={async exists(p){return files.has(p)||dirs.has(p)},async mkdir(p){dirs.add(p)},async read(p){if(!files.has(p))throw Error('missing');return files.get(p)},async write(p,v){files.set(p,v)},async readBinary(p){if(!files.has(p))throw Error('missing');return files.get(p).slice().buffer},async writeBinary(p,v){files.set(p,new Uint8Array(v.slice(0)))},async rename(a,b){if(files.has(b))throw Error('exists');files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)},async process(p,fn){files.set(p,fn(files.get(p)))}};
 const store=createSingleJsonlStore({adapter,token:()=>`token-${++n}`});
 const runner=()=>createSingleJsonlMigrationRunner({adapter,store,journalRoot:'.obsidian/plugins/pdf-web-reader/migration-test',readPdf:async()=>bytes.slice(),writePdf:async(_p,v)=>{if(failWrite)throw Error('simulated PDF write failure');if(failPartial){bytes=new Uint8Array(v).slice(0,original.length+Math.floor((v.length-original.length)/2));throw Error('simulated partial append')}bytes=new Uint8Array(v);if(failAfter)throw Error('simulated post-write crash')},clock:()=>123});
 const document={sourcePath:'Books/a.pdf',docKey:'123456abcdef',documentId:'legacy-id',source:{sourceHash:sha(original),pageCount:1}};
 const snapshot={annotations:[{uuid:'A',kind:'Highlight',pageIndex:0,payload:{targetText:'text'}}],tombstones:[{uuid:'D',kind:'Ink',pageIndex:0}]};
 return {files,store,runner,document,snapshot,original,get bytes(){return bytes},set bytes(v){bytes=v},set failWrite(v){failWrite=v},set failAfter(v){failAfter=v},set failPartial(v){failPartial=v}};
}
test('migration publishes paired files without creating a PDF backup',async()=>{
 const w=await fixture(),result=await w.runner().migrate({document:w.document,snapshot:w.snapshot});
 assert.equal(await readPairId(w.bytes),result.pairId);assert.deepEqual(result.counts,{annotations:1,tombstones:1,deletionGuards:0});
 const state=await w.store.readCurrent(w.document.sourcePath,result.pairId);assert.equal(state.annotations[0].uuid,'A');assert.equal(state.tombstones[0].uuid,'D');
 assert.equal([...w.files.keys()].filter(p=>p.includes('/pdf/')).length,0);
});
test('restart resumes the same identity when the PDF write fails before publication',async()=>{
 const w=await fixture();w.failWrite=true;await assert.rejects(w.runner().migrate({document:w.document,snapshot:w.snapshot}),/simulated PDF write failure/);
 assert.deepEqual(w.bytes,w.original);w.failWrite=false;const result=await w.runner().migrate({document:w.document,snapshot:w.snapshot});
 assert.equal(await readPairId(w.bytes),result.pairId);assert.equal((await w.store.readCurrent(w.document.sourcePath,result.pairId)).annotations.length,1);
});
test('restart verifies an already-written PDF after a crash before completion',async()=>{
 const w=await fixture();w.failAfter=true;await assert.rejects(w.runner().migrate({document:w.document,snapshot:w.snapshot}),/simulated post-write crash/);
 const paired=await readPairId(w.bytes);w.failAfter=false;const result=await w.runner().migrate({document:w.document,snapshot:w.snapshot});
 assert.equal(result.resumed,true);assert.equal(result.pairId,paired);
});
test('restart completes an interrupted incremental PDF append without a backup',async()=>{
 const w=await fixture();w.failPartial=true;await assert.rejects(w.runner().migrate({document:w.document,snapshot:w.snapshot}),/simulated partial append/);
 assert.deepEqual(w.bytes.slice(0,w.original.length),w.original);
 w.failPartial=false;const result=await w.runner().migrate({document:w.document,snapshot:w.snapshot});
 assert.equal(await readPairId(w.bytes),result.pairId);assert.equal((await w.store.readCurrent(w.document.sourcePath,result.pairId)).annotations.length,1);
 assert.equal([...w.files.keys()].some(p=>/backup|\.bak$/i.test(p)),false);
});
test('recovery refuses a partial PDF whose appended bytes were changed',async()=>{
 const w=await fixture();w.failPartial=true;await assert.rejects(w.runner().migrate({document:w.document,snapshot:w.snapshot}),/simulated partial append/);
 const damaged=w.bytes.slice();damaged[damaged.length-1]^=1;w.bytes=damaged;w.failPartial=false;
 await assert.rejects(w.runner().migrate({document:w.document,snapshot:w.snapshot}),{code:'V15_MIGRATION_SOURCE_CHANGED'});
 assert.deepEqual(w.bytes,damaged,'unverified bytes are never changed');
});
