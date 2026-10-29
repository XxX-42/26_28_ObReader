// Prepare a single isolated test fixture, never a production migration.
// Source Vault access is read-only; the only PDF written is a new, paired
// fixture inside the dedicated v15 test Vault. No backup is created.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,readdir,stat,lstat,realpath,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {createWalAnnotationStore}=require('../plugin/storage/wal-annotation-store.cjs');
const {prepareSingleJsonlMigration}=require('../plugin/storage/single-jsonl-migration.cjs');
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createSingleJsonlRegistry}=require('../plugin/storage/single-jsonl-registry.cjs');
const {readPairId}=require('../plugin/pdf-pair-id.cjs');
const sourceRoot=path.resolve(String.raw`D:\Documents\Obsidian\远程仓库1`),vault=path.resolve(String.raw`D:\Documents\Obsidian\ObReader-v15-isolated-20261029`);
const sourcePath='12_books/The Easy Way to Stop Smoking.pdf',runId=randomUUID(),targetPath=`Books/v15-stop-smoking-${runId}.pdf`,dataRoot='00_Archive/20_PDFData';
const resolveUnder=(root,p)=>{const target=path.resolve(root,...p.split('/'));assert.ok(target.startsWith(root+path.sep),'Path escapes its Vault');return target};
assert.equal((await realpath(vault)).toLowerCase(),vault.toLowerCase());assert.equal((await lstat(vault)).isSymbolicLink(),false);
assert.equal((await lstat(resolveUnder(vault,'Books'))).isSymbolicLink(),false);
try{await stat(resolveUnder(vault,dataRoot));throw Error('Isolated annotation root already exists; refusing to overwrite it')}catch(error){if(error.code!=='ENOENT')throw error}
const sha=b=>'sha256-v1:'+createHash('sha256').update(b).digest('hex'),deny=async()=>{throw Error('FORMAL_VAULT_WRITE_FORBIDDEN')};
const disk={read:p=>readFile(resolveUnder(sourceRoot,p),'utf8'),exists:async p=>{try{await stat(resolveUnder(sourceRoot,p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}},list:async p=>{try{const rows=await readdir(resolveUnder(sourceRoot,p),{withFileTypes:true});return {files:rows.filter(x=>x.isFile()).map(x=>p+'/'+x.name),folders:rows.filter(x=>x.isDirectory()).map(x=>p+'/'+x.name)}}catch(e){if(e.code==='ENOENT')return {files:[],folders:[]};throw e}},write:deny,writeBinary:deny,append:deny,rename:deny,mkdir:deny,remove:deny,process:deny};
const registry=JSON.parse(await disk.read(`${dataRoot}/_registry.json`)),identity=registry.entries?.[sourcePath];assert.ok(identity,'Legacy document route is missing');
const runtime=await createPdfHashRuntime(),legacy=createWalAnnotationStore({adapter:disk,root:dataRoot,hash:runtime.fingerprint,identityHash:sha,verifyHash:runtime.matches,deviceId:'v15-fixture-readonly',uuid:randomUUID,jsonlMode:true});
const effective=await legacy.readEffective(identity,{readOnly:true});assert.equal(effective.errors.length,0);assert.ok(!effective.sidecarError);
const snapshot=await legacy.readDocument(effective.document,{readOnly:true});assert.ok(!snapshot.syncPending);
assert.equal(snapshot.annotations.length,49);assert.equal(snapshot.tombstones.length,13);
const original=await readFile(resolveUnder(sourceRoot,sourcePath)),sourceSha=sha(original),document={...effective.document,sourcePath:targetPath};
const prepared=await prepareSingleJsonlMigration({sourceBytes:original,document,snapshot,verifySource:runtime.matches});
assert.deepEqual(prepared.counts,{annotations:49,tombstones:13,deletionGuards:0});assert.equal(await readPairId(prepared.pdf.bytes),prepared.pairId);
assert.equal(sha(await readFile(resolveUnder(sourceRoot,sourcePath))),sourceSha);
const adapter={read:p=>readFile(resolveUnder(vault,p),'utf8'),async exists(p){try{await stat(resolveUnder(vault,p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}},mkdir:p=>mkdir(resolveUnder(vault,p)),write:(p,v)=>writeFile(resolveUnder(vault,p),v),async process(p,fn){const f=resolveUnder(vault,p);await writeFile(f,fn(await readFile(f,'utf8')))},rename:(a,b)=>rename(resolveUnder(vault,a),resolveUnder(vault,b)),remove:p=>rm(resolveUnder(vault,p)),async list(p){const rows=await readdir(resolveUnder(vault,p),{withFileTypes:true});return {files:rows.filter(x=>x.isFile()).map(x=>p+'/'+x.name),folders:rows.filter(x=>x.isDirectory()).map(x=>p+'/'+x.name)}}};
await writeFile(resolveUnder(vault,targetPath),prepared.pdf.bytes,{flag:'wx'});
const store=createSingleJsonlStore({adapter,root:dataRoot,token:randomUUID}),current=await store.initialize(prepared.current);
const route=createSingleJsonlRegistry({adapter,store,root:dataRoot});await route.remember(current);
const reopened=await store.readCurrent(targetPath,prepared.pairId);assert.deepEqual(reopened.annotations,snapshot.annotations);assert.deepEqual(reopened.tombstones,snapshot.tombstones);
assert.equal((await store.readHistory(targetPath,prepared.pairId)).length,0);assert.equal((await route.lookup(prepared.pairId)).document.documentId,identity.documentId);
assert.equal(sha(await readFile(resolveUnder(sourceRoot,sourcePath))),sourceSha,'Source PDF changed on disk');
console.log(JSON.stringify({fixture:targetPath,pairId:prepared.pairId,documentId:identity.documentId,docKey:identity.docKey,counts:prepared.counts,sourceSha256:sourceSha,fixtureSha256:sha(await readFile(resolveUnder(vault,targetPath))),formalVaultWrites:0,backupCreated:false,scope:'isolated native test fixture only'}));
