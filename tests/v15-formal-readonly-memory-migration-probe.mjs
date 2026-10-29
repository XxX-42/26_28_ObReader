// This probe reads exactly one existing source PDF and its legacy annotation
// state. Every write is redirected to an ephemeral in-memory adapter. It does
// not publish a migration, create a backup, or modify the Vault.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,readdir,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {createWalAnnotationStore}=require('../plugin/storage/wal-annotation-store.cjs');
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createSingleJsonlMigrationRunner}=require('../plugin/storage/single-jsonl-migration-runner.cjs');
const {appendPairUpdate,readPairId}=require('../plugin/pdf-pair-id.cjs');
const root=path.resolve(String.raw`D:\Documents\Obsidian\远程仓库1`),relative='12_books/The Easy Way to Stop Smoking.pdf';
const resolve=p=>{const target=path.resolve(root,...p.split('/'));assert.ok(!path.relative(root,target).startsWith('..'));return target};
const deny=async()=>{throw Error('FORMAL_VAULT_WRITE_FORBIDDEN')};
const disk={read:p=>readFile(resolve(p),'utf8'),exists:async p=>{try{await stat(resolve(p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}},list:async p=>{try{const rows=await readdir(resolve(p),{withFileTypes:true});return {files:rows.filter(x=>x.isFile()).map(x=>p+'/'+x.name),folders:rows.filter(x=>x.isDirectory()).map(x=>p+'/'+x.name)}}catch(e){if(e.code==='ENOENT')return {files:[],folders:[]};throw e}},write:deny,writeBinary:deny,append:deny,rename:deny,mkdir:deny,remove:deny,process:deny};
const sha=b=>'sha256-v1:'+createHash('sha256').update(b).digest('hex'),runtime=await createPdfHashRuntime(),dataRoot='00_Archive/20_PDFData';
const registry=JSON.parse(await disk.read(`${dataRoot}/_registry.json`)),identity=registry.entries?.[relative];assert.ok(identity,'The legacy registry has no route for the selected PDF');
const legacy=createWalAnnotationStore({adapter:disk,root:dataRoot,hash:runtime.fingerprint,identityHash:sha,verifyHash:runtime.matches,deviceId:'v15-readonly-probe',uuid:randomUUID,jsonlMode:true});
const effective=await legacy.readEffective(identity,{readOnly:true});assert.equal(effective.errors.length,0);assert.ok(!effective.sidecarError);
const snapshot=await legacy.readDocument(effective.document,{readOnly:true});assert.ok(!snapshot.syncPending);
const original=await readFile(resolve(relative)),before=sha(original);let pdf=Uint8Array.from(original);
const files=new Map(),dirs=new Set(),memory={async exists(p){return files.has(p)||dirs.has(p)},async mkdir(p){dirs.add(p)},async read(p){if(!files.has(p))throw Error('missing '+p);return files.get(p)},async write(p,t){files.set(p,t)},async process(p,fn){files.set(p,fn(files.get(p)))},async rename(a,b){if(files.has(b))throw Error('exists');files.set(b,files.get(a));files.delete(a)},async remove(p){files.delete(p)}};
const vaultMemory={async readBinary(){return pdf.slice().buffer},async appendBinary(_file,value){const suffix=new Uint8Array(value),combined=new Uint8Array(pdf.length+suffix.length);combined.set(pdf);combined.set(suffix,pdf.length);pdf=combined}};
const store=createSingleJsonlStore({adapter:memory,token:randomUUID}),runner=createSingleJsonlMigrationRunner({adapter:memory,store,journalRoot:'.obsidian/v15-memory-probe',verifySource:runtime.matches,readPdf:()=>vaultMemory.readBinary(),writePdf:(_path,bytes)=>appendPairUpdate(vaultMemory,{},bytes)});
const result=await runner.migrate({document:effective.document,snapshot});assert.equal(await readPairId(pdf),result.pairId);
assert.deepEqual(result.counts,{annotations:49,tombstones:13,deletionGuards:0},'The selected source differs from the previously verified 49/13 migration fixture');
const current=await store.readCurrent(relative,result.pairId);assert.deepEqual(current.annotations,snapshot.annotations);assert.deepEqual(current.tombstones,snapshot.tombstones);assert.deepEqual(current.deletionGuards,snapshot.deletionGuards||[]);
await store.save({sourcePath:relative,pairId:result.pairId,changes:[{uuid:'v15-memory-probe-only',kind:'Square',pageIndex:0,payload:{editor:{annotationType:5,pageIndex:0,rect:[1,2,3,4]}}}]});
await store.save({sourcePath:relative,pairId:result.pairId,changes:[{uuid:'v15-memory-probe-only',kind:'Square',pageIndex:0,deleted:true}]});
const reopened=await createSingleJsonlStore({adapter:memory,token:randomUUID}).readCurrent(relative,result.pairId);
assert.deepEqual(reopened.annotations,snapshot.annotations);assert.ok(reopened.tombstones.some(row=>row.uuid==='v15-memory-probe-only'));
for(const deleted of snapshot.tombstones)assert.deepEqual(reopened.tombstones.find(row=>row.uuid===deleted.uuid),deleted,'Original deletion state changed after an unrelated edit');
assert.deepEqual(reopened.deletionGuards,snapshot.deletionGuards||[]);assert.equal((await store.readHistory(relative,result.pairId)).length,2);
const after=sha(await readFile(resolve(relative)));assert.equal(after,before,'Source PDF changed on disk');
console.log(JSON.stringify({sourcePath:relative,counts:result.counts,uuidAndPayloadPreserved:true,saveDeleteReopen:true,pdfSha256Before:before,pdfSha256After:after,writes:'memory-only',formalVaultWrites:0}));
