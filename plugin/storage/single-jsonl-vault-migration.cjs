/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const {createWalAnnotationStore}=require('./wal-annotation-store.cjs');
const {createSingleJsonlStore}=require('./single-jsonl-store.cjs');
const {createSingleJsonlRegistry}=require('./single-jsonl-registry.cjs');
const {createSingleJsonlMigrationRunner}=require('./single-jsonl-migration-runner.cjs');
const {createSingleJsonlBatchMigration}=require('./single-jsonl-batch-migration.cjs');
const {createSingleJsonlDeferredIndex}=require('./single-jsonl-deferred.cjs');
const {appendPairUpdate}=require('../pdf-pair-id.cjs');
const {normalizeInitialPath}=require('./document-identity.cjs');
const {canonicalJson}=require('./canonical.cjs');
const fail=(code,message)=>Object.assign(new Error(message),{code});

// The caller must ensure that Readers are closed and synchronization is
// paused for the entire operation. This function never creates backups.
function createSingleJsonlVaultMigration({app,hashRuntime,identityHash,deviceId,uuid,root='00_Archive/20_PDFData'}){
  if(!app?.vault?.adapter||!hashRuntime?.fingerprint||typeof uuid!=='function')throw TypeError('A vault, hash runtime and UUID generator are required.');
  const adapter=app.vault.adapter;
  const common={adapter,root,deviceId,uuid,hash:hashRuntime.fingerprint,identityHash,verifyHash:hashRuntime.matches};
  const legacy=createWalAnnotationStore({...common,jsonlMode:true});
  const store=createSingleJsonlStore({adapter,root,deviceId,token:uuid});
  const registry=createSingleJsonlRegistry({adapter,store,root});
  const deferred=createSingleJsonlDeferredIndex({adapter,root});
  function file(path){const item=app.vault.getAbstractFileByPath(path);if(!item||item.path!==path)throw fail('V15_SOURCE_MISSING',`PDF is unavailable: ${path}`);return item;}
  const journalRoot=`${app.vault.configDir||'.obsidian'}/plugins/pdf-web-reader/.v15-migration`;
  const runner=createSingleJsonlMigrationRunner({adapter,store,
    journalRoot,
    verifySource:(bytes,expected)=>typeof hashRuntime.matches==='function'?hashRuntime.matches(bytes,expected):hashRuntime.fingerprint(bytes)===expected,
    readPdf:async path=>app.vault.readBinary(file(path)),
    writePdf:async(path,bytes)=>appendPairUpdate(app.vault,file(path),bytes),
  });
  const batch=createSingleJsonlBatchMigration({adapter,registry,runner,deferred,async readLegacy(path,identity){
    const effective=await legacy.readEffective(identity,{readOnly:true});
    if(effective.errors?.length||effective.sidecarError)throw fail('V15_LEGACY_UNVERIFIED',`Legacy annotations cannot be verified: ${path}`);
    const snapshot=await legacy.readDocument(effective.document,{readOnly:true});
    return {document:effective.document,snapshot};
  }});
  async function migrate(){
    const id=String(uuid());if(!/^[a-zA-Z0-9_-]+$/.test(id))throw fail('V15_REPORT_ID_INVALID','Cannot create a safe migration report name.');
    const reportPath=`${journalRoot}/reports/${id}.json`;
    let directory='';
    for(const part of reportPath.split('/').slice(0,-1)){
      directory=directory?`${directory}/${part}`:part;
      if(!await adapter.exists(directory)){try{await adapter.mkdir(directory)}catch(error){if(!await adapter.exists(directory))throw error}}
    }
    if(await adapter.exists(reportPath))throw fail('V15_REPORT_EXISTS','The migration report path already exists.');
    let documents=[],failure=null;
    try{documents=await batch.migrate()}catch(error){failure=error;documents=error.results||[]}
    const report={schemaVersion:1,kind:'obreader-v15-migration-report',status:failure?'failed':'complete',
      createdAt:Date.now(),documents,failures:failure?.failures||[],
      error:failure?{code:failure.code||'V15_MIGRATION_FAILED',message:String(failure.message||failure)}:null};
    try{
      const text=canonicalJson(report);await adapter.write(reportPath,text);
      if(await adapter.read(reportPath)!==text)throw fail('V15_REPORT_UNVERIFIED','Cannot verify the migration report.');
    }catch(error){
      if(failure){failure.reportError=String(error?.message||error);throw failure;}
      const reportFailure=fail('V15_MIGRATION_REPORT_FAILED','Migration completed, but its report could not be verified.');
      reportFailure.results=documents;throw reportFailure;
    }
    if(failure){failure.reportPath=reportPath;throw failure;}
    Object.defineProperty(documents,'reportPath',{value:reportPath,enumerable:false});
    return documents;
  }
  async function recoverPairing(sourcePath){
    sourcePath=normalizeInitialPath(sourcePath);
    const receiptPath=`${journalRoot}/receipts/${sourcePath}.json`;
    if(!await adapter.exists(receiptPath))throw fail('V15_RECOVERY_MISSING','No interrupted pairing was recorded for this PDF.');
    let receipt;try{receipt=JSON.parse(await adapter.read(receiptPath))}catch{throw fail('V15_MIGRATION_RECEIPT_INVALID','Pairing receipt is unreadable.')}
    if(receipt?.kind!=='obreader-v15-migration'||receipt.sourcePath!==sourcePath||receipt.phase==='complete')
      throw fail('V15_RECOVERY_MISSING','No interrupted pairing was recorded for this PDF.');
    const current=await store.readCurrent(sourcePath,receipt.pairId);
    if(!current)throw fail('V15_RECOVERY_MISSING','The prepared annotation file is missing.');
    const document={...current.document};delete document.pairId;delete document.pairing;
    const snapshot={annotations:current.annotations,tombstones:current.tombstones,deletionGuards:current.deletionGuards};
    const result=await runner.migrate({document,snapshot});
    let registryDeferred=false;
    try {await registry.remember(await store.readCurrent(sourcePath,result.pairId));}
    catch(error){if(error.code!=='V15_REGISTRY_REBUILD_REQUIRED')throw error;registryDeferred=true;}
    return {...result,registryDeferred};
  }
  return {migrate,recoverPairing};
}
module.exports={createSingleJsonlVaultMigration};
