// Read-only legacy inspection. PDF identity changes are prepared in memory.
// This script never publishes data or changes a Vault.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, stat, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {createWalAnnotationStore}=require('../plugin/storage/wal-annotation-store.cjs');
const {prepareSingleJsonlMigration}=require('../plugin/storage/single-jsonl-migration.cjs');
const {readPairId}=require('../plugin/pdf-pair-id.cjs');
const [vault,relativePdf]=process.argv.slice(2);
if(!vault||!relativePdf)throw Error('Usage: node tests/v15-legacy-preparation-probe.mjs <vault> <relativePdf>');
const root=path.resolve(vault),dataRoot='00_Archive/20_PDFData';
const resolve=p=>{const target=path.resolve(root,...p.split('/'));if(path.relative(root,target).startsWith('..'))throw Error('Unsafe path');return target};
const sha=bytes=>'sha256-v1:'+createHash('sha256').update(bytes).digest('hex');
const fail=async()=>{throw Error('READ_ONLY_PROBE_WRITE_REJECTED')};
const adapter={
  read:p=>readFile(resolve(p),'utf8'),
  exists:async p=>{try{await stat(resolve(p));return true}catch(e){if(e.code==='ENOENT')return false;throw e}},
  list:async p=>{let rows;try{rows=await readdir(resolve(p),{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return {files:[],folders:[]};throw e}return {files:rows.filter(x=>x.isFile()).map(x=>p+'/'+x.name),folders:rows.filter(x=>x.isDirectory()).map(x=>p+'/'+x.name)}},
  write:fail,writeBinary:fail,append:fail,rename:fail,mkdir:fail,remove:fail,process:fail,
};
const registry=JSON.parse(await adapter.read(`${dataRoot}/_registry.json`));
const identity=registry.entries?.[relativePdf];assert.ok(identity,'Legacy registry entry missing');
const runtime=await createPdfHashRuntime();
const legacy=createWalAnnotationStore({adapter,root:dataRoot,hash:runtime.fingerprint,identityHash:sha,verifyHash:runtime.matches,deviceId:'v15-readonly-probe',uuid:randomUUID,jsonlMode:true});
const effective=await legacy.readEffective(identity,{readOnly:true});assert.equal(effective.errors.length,0,JSON.stringify(effective.errors));assert.ok(!effective.sidecarError);
const snapshot=await legacy.readDocument(effective.document,{readOnly:true});
assert.ok(!snapshot.syncPending);
const original=await readFile(resolve(relativePdf)),before=sha(original);
const result=await prepareSingleJsonlMigration({sourceBytes:original,document:effective.document,snapshot,verifySource:runtime.matches});
assert.deepEqual(result.current.annotations,snapshot.annotations);assert.deepEqual(result.current.tombstones,snapshot.tombstones);
assert.equal(await readPairId(result.pdf.bytes),result.pairId);
assert.equal(sha(await readFile(resolve(relativePdf))),before);
console.log(JSON.stringify({pdf:relativePdf,counts:result.counts,sourceSha256:before,preparedSha256:result.pdf.pairedSha256,
  sourceBytes:original.byteLength,preparedBytes:result.pdf.bytes.byteLength,sourceUnchanged:true,publication:false,scope:'read-only-source-in-memory-preparation'}));
