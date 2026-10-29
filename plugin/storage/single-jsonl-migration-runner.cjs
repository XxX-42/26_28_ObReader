/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const {sha256}=require('@noble/hashes/sha256');
const {canonicalJson}=require('./canonical.cjs');
const {normalizeInitialPath}=require('./document-identity.cjs');
const {prepareSingleJsonlMigration,digestMigrationBytes}=require('./single-jsonl-migration.cjs');
const {readPairId}=require('../pdf-pair-id.cjs');
const hash=bytes=>'sha256-v1:'+Array.from(sha256(bytes),x=>x.toString(16).padStart(2,'0')).join('');
const textHash=value=>hash(new TextEncoder().encode(canonicalJson(value)));
const fail=(code,message)=>Object.assign(new Error(message),{code});
const ordered=rows=>rows.slice().sort((a,b)=>a.uuid<b.uuid?-1:a.uuid>b.uuid?1:0);
const snapshotState=value=>({annotations:ordered(value.annotations),tombstones:ordered(value.tombstones),deletionGuards:ordered(value.deletionGuards||[])});

// Explicit migration transaction. The caller closes affected Readers and
// pauses synchronization. No atomicity across external PDF editors is claimed.
function createSingleJsonlMigrationRunner({adapter,store,readPdf,writePdf,verifySource,journalRoot,clock=Date.now}){
  normalizeInitialPath(journalRoot);
  if(typeof readPdf!=='function'||typeof writePdf!=='function')throw TypeError('Migration needs PDF read/write callbacks.');
  const queues=new Map();
  async function ensure(path){let dir='';for(const part of path.split('/').slice(0,-1)){dir=dir?dir+'/'+part:part;if(!await adapter.exists(dir))await adapter.mkdir(dir)}}
  async function receipt(path){if(!await adapter.exists(path))return null;try{return JSON.parse(await adapter.read(path))}catch{throw fail('V15_MIGRATION_RECEIPT_INVALID','Migration receipt is unreadable.');}}
  async function saveReceipt(path,value){await ensure(path);const text=canonicalJson(value);if(await adapter.exists(path))await adapter.process(path,()=>text);else await adapter.write(path,text);if(await adapter.read(path)!==text)throw fail('V15_MIGRATION_UNVERIFIED','Migration receipt readback failed.');}
  async function run({document,snapshot}){
    const sourcePath=normalizeInitialPath(document.sourcePath),receiptPath=`${journalRoot}/receipts/${sourcePath}.json`;
    const legacyState=snapshotState(snapshot),stateDigest=textHash(legacyState);
    let record=await receipt(receiptPath),bytes=new Uint8Array(await readPdf(sourcePath));
    if(record){
      if(record.kind!=='obreader-v15-migration'||record.schemaVersion!==1||record.sourcePath!==sourcePath||
        record.documentId!==document.documentId||record.docKey!==document.docKey||record.stateDigest!==stateDigest)throw fail('V15_MIGRATION_RECEIPT_INVALID','Migration input differs from the saved transaction.');
      if(await digestMigrationBytes(bytes)===record.outputSha256){
        if(await readPairId(bytes)!==record.pairId)throw fail('V15_MIGRATION_UNVERIFIED','Paired PDF identity differs from its receipt.');
        const current=await store.readCurrent(sourcePath,record.pairId);
        if(!current||current.document.documentId!==document.documentId||current.document.docKey!==document.docKey||
          (record.phase!=='complete'&&textHash(snapshotState(current))!==stateDigest))throw fail('V15_MIGRATION_UNVERIFIED','Current state differs from migration input.');
        await store.readHistory(sourcePath,record.pairId);
        await saveReceipt(receiptPath,{...record,phase:'complete'});
        return {document:current.document,pairId:record.pairId,counts:record.counts,resumed:true,receiptPath};
      }
      // A torn append leaves the entire original PDF prefix intact. Resume
      // only if both that prefix and every written suffix byte exactly match
      // a freshly reconstructed, verified incremental update.
      if(Number.isSafeInteger(record.originalSize)&&Number.isSafeInteger(record.pairedSize)&&
        bytes.length>record.originalSize&&bytes.length<record.pairedSize){
        const prefix=bytes.subarray(0,record.originalSize);
        if(await digestMigrationBytes(prefix)!==record.originalSha256)throw fail('V15_MIGRATION_SOURCE_CHANGED','The original PDF prefix changed during the interrupted append.');
        const resumed=await prepareSingleJsonlMigration({sourceBytes:prefix,document,snapshot,pairId:record.pairId,verifySource,clock:()=>record.createdAt});
        if(resumed.pdf.pairedSha256!==record.outputSha256||resumed.pdf.bytes.length!==record.pairedSize||
          bytes.some((value,index)=>value!==resumed.pdf.bytes[index]))throw fail('V15_MIGRATION_SOURCE_CHANGED','The partial PDF suffix does not match the prepared update.');
        const current=await store.readCurrent(sourcePath,record.pairId);
        if(!current||current.document.documentId!==document.documentId||current.document.docKey!==document.docKey||textHash(snapshotState(current))!==stateDigest)
          throw fail('V15_MIGRATION_UNVERIFIED','Current annotations differ from the migration input.');
        await store.readHistory(sourcePath,record.pairId);
        await writePdf(sourcePath,resumed.pdf.bytes);
        const confirmed=new Uint8Array(await readPdf(sourcePath));
        if(await digestMigrationBytes(confirmed)!==record.outputSha256||await readPairId(confirmed)!==record.pairId)throw fail('V15_MIGRATION_UNVERIFIED','Resumed PDF append failed verification.');
        await saveReceipt(receiptPath,{...record,phase:'complete'});
        return {document:current.document,pairId:record.pairId,counts:record.counts,resumed:true,receiptPath};
      }
      if(await digestMigrationBytes(bytes)!==record.originalSha256)throw fail('V15_MIGRATION_SOURCE_CHANGED','PDF changed since the migration was prepared.');
    }
    const prepared=await prepareSingleJsonlMigration({sourceBytes:bytes,document,snapshot,
      pairId:record?.pairId,verifySource,clock:()=>record?.createdAt??clock()});
    if(record&&record.outputSha256!==prepared.pdf.pairedSha256)throw fail('V15_MIGRATION_UNVERIFIED','Resumed metadata update differs from the original prepared bytes.');
    record={kind:'obreader-v15-migration',schemaVersion:1,sourcePath,documentId:document.documentId,docKey:document.docKey,
      pairId:prepared.pairId,originalSha256:prepared.pdf.originalSha256,outputSha256:prepared.pdf.pairedSha256,
      originalSize:bytes.length,pairedSize:prepared.pdf.bytes.length,
      stateDigest,counts:prepared.counts,createdAt:record?.createdAt??prepared.current.document.pairing.createdAt,phase:'prepared'};
    await saveReceipt(receiptPath,record);
    const current=await store.initialize(prepared.current);
    await store.readHistory(sourcePath,record.pairId);
    if(textHash(snapshotState(current))!==stateDigest||current.document.pairing?.pairedSha256!==record.outputSha256)throw fail('V15_MIGRATION_UNVERIFIED','Existing v15 file differs from this migration.');
    await saveReceipt(receiptPath,{...record,phase:'current-published'});
    if(await digestMigrationBytes(new Uint8Array(await readPdf(sourcePath)))!==record.originalSha256)throw fail('V15_MIGRATION_SOURCE_CHANGED','PDF changed before publishing the pairing metadata.');
    if(prepared.pdf.changed)await writePdf(sourcePath,prepared.pdf.bytes);
    const confirmed=new Uint8Array(await readPdf(sourcePath));
    if(await digestMigrationBytes(confirmed)!==record.outputSha256||await readPairId(confirmed)!==record.pairId)throw fail('V15_MIGRATION_UNVERIFIED','PDF pairing publication failed verification.');
    await saveReceipt(receiptPath,{...record,phase:'complete'});
    return {document:current.document,pairId:record.pairId,counts:record.counts,resumed:false,receiptPath};
  }
  function migrate(input){const key=input.document.sourcePath,previous=queues.get(key)||Promise.resolve();const task=previous.catch(()=>{}).then(()=>run(input));const tail=task.then(()=>{},()=>{});queues.set(key,tail);tail.then(()=>{if(queues.get(key)===tail)queues.delete(key)});return task;}
  return {migrate};
}
module.exports={createSingleJsonlMigrationRunner};
