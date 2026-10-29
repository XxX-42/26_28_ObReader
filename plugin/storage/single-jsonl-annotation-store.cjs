/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const {canonicalJson}=require('./canonical.cjs');
const {deriveDocumentIdentity,normalizeInitialPath}=require('./document-identity.cjs');
const {createSingleJsonlStore,FORMAT}=require('./single-jsonl-store.cjs');
const {createSingleJsonlRegistry}=require('./single-jsonl-registry.cjs');
const {createSingleJsonlDeferredIndex}=require('./single-jsonl-deferred.cjs');
const fail=(code,message)=>Object.assign(new Error(message),{code});

// Compatibility boundary for the existing Viewer/Host snapshot and save APIs.
// Current-state files remain the authority; this adapter does not replay WAL.
function createSingleJsonlAnnotationStore({adapter,root='00_Archive/20_PDFData',uuid=()=>crypto.randomUUID(),deviceId='v15-local',identityHash,hash,
  pairDocument=null,onTiming=()=>{}}={}){
  const core=createSingleJsonlStore({adapter,root,token:uuid,deviceId});
  const registry=createSingleJsonlRegistry({adapter,store:core,root});
  const deferred=createSingleJsonlDeferredIndex({adapter,root});
  const provisional=new Map();
  const stableHash=async bytes=>{const value=await (identityHash||hash)(bytes);return /^[a-f0-9]{64}$/.test(value)?`sha256-v1:${value}`:value};
  async function documentForPath(path){
    path=normalizeInitialPath(path);const loaded=await core.readCurrent(path);
    return loaded?{...loaded.document,pairId:loaded.pairId}:provisional.get(path)||await deferred.lookup(path);
  }
  async function registerDocument({sourcePath,source,newInstance=false}){
    sourcePath=normalizeInitialPath(sourcePath);const prior=await documentForPath(sourcePath);
    if(newInstance)throw fail('V15_COPY_CONFIRMATION_REQUIRED','A copied PDF needs explicit re-identification.');
    if(prior){
      if(!prior.pairId)provisional.set(sourcePath,prior);
      const expected=prior.pairing?.pairedSha256||prior.source?.sourceHash;
      const matched=source.sourceHash===expected||source.sourceHash===prior.source?.sourceHash;
      return {...prior,sourceMatch:matched?'MATCH':'MISMATCH',...(matched?{}:{sourceMismatch:true})};
    }
    if(await adapter.exists(registry.path)){
      try{const index=JSON.parse(await adapter.read(registry.path));if(index.schemaVersion!==15&&index.entries?.[sourcePath])throw fail('V15_MIGRATION_REQUIRED','Existing annotations must be migrated before editing this PDF.');}
      catch(error){if(error.code==='V15_MIGRATION_REQUIRED')throw error;throw fail('V15_REGISTRY_REBUILD_REQUIRED','Cannot verify the existing annotation registry.');}
    }
    const identity=await deriveDocumentIdentity({initialPath:sourcePath,fullSourceHash:source.sourceHash,stableHash});
    const document={...identity,sourcePath,initialPath:sourcePath,source:{...source},legacyIdentities:[],legacyIdentityScanComplete:true};
    provisional.set(sourcePath,document);return {...document,sourceMatch:'BASELINE_ESTABLISHED'};
  }
  async function documentForIdentity({docKey,documentId}){
    const matches=entries=>Object.entries(entries||{}).filter(([,row])=>row?.docKey===docKey&&row?.documentId===documentId);
    async function rebuildVerified(){
      const entries=await registry.rebuild({validate(routes){
        if(matches(routes).length!==1)throw fail('V15_IDENTITY_CONFLICT','The link does not have exactly one verified paired document.');
      }});
      const current=await registry.lookup(matches(entries)[0][0]);
      if(!current)throw fail('V15_DOCUMENT_MISSING','The linked current-state file is unavailable.');
      return {...current.document,pairId:current.pairId};
    }
    let index;
    if(!await adapter.exists(registry.path)){
      const pending=await deferred.findIdentity({docKey,documentId});
      if(pending)return pending;
      return rebuildVerified();
    }
    try{index=JSON.parse(await adapter.read(registry.path));}catch{
      const pending=await deferred.findIdentity({docKey,documentId});
      if(pending)return pending;
      return rebuildVerified();
    }
    if(index.schemaVersion!==15){
      const pending=await deferred.findIdentity({docKey,documentId});
      if(pending)return pending;
      throw fail('V15_REGISTRY_REBUILD_REQUIRED','The legacy registry requires a verified migration.');
    }
    if(index.kind!=='pdf-reader-pair-registry'||!index.entries||typeof index.entries!=='object'||Array.isArray(index.entries))return rebuildVerified();
    const entries=matches(index.entries);
    if(entries.length===0){const pending=await deferred.findIdentity({docKey,documentId});if(pending)return pending;return rebuildVerified();}
    if(entries.length!==1)throw fail('V15_IDENTITY_CONFLICT','The link does not have exactly one paired document.');
    const current=await registry.lookup(entries[0][0]);if(!current)throw fail('V15_DOCUMENT_MISSING','The linked current-state file is unavailable.');
    return {...current.document,pairId:current.pairId};
  }
  async function ensureDocumentIdentity(document){
    if(document.sourceMismatch)throw fail('SOURCE_MISMATCH','Cannot retain an identity for a changed PDF.');
    if(document.pairId)return document;
    const pending=provisional.get(document.sourcePath);
    if(!pending||pending.documentId!==document.documentId||pending.docKey!==document.docKey||pending.source?.sourceHash!==document.source?.sourceHash)
      throw fail('V15_IDENTITY_CONFLICT','The current Reader identity cannot be verified.');
    const retained=await deferred.remember(pending);provisional.set(document.sourcePath,retained);return retained;
  }
  async function readDocument(document){
    if(document.sourceMismatch)throw fail('SOURCE_MISMATCH','Cannot hydrate a changed PDF source.');
    const loaded=await core.readCurrent(document.sourcePath,document.pairId);
    if(document.pairId&&!loaded)throw fail('V15_DOCUMENT_MISSING','The paired current-state file is missing.');
    if(loaded&&(loaded.document.documentId!==document.documentId||loaded.document.docKey!==document.docKey))throw fail('V15_IDENTITY_CONFLICT','Current state belongs to a different document.');
    const actual=loaded?.document||provisional.get(document.sourcePath)||document;
    return {schemaVersion:2,kind:'pdf-annotation-snapshot',storageProtocol:FORMAT,
      documentId:actual.documentId,docKey:actual.docKey,
      document:{id:actual.documentId,path:actual.sourcePath},source:{...actual.source,sourcePath:actual.sourcePath},
      pairId:loaded?.pairId||null,requiresPairValidation:true,
      legacyIdentities:actual.legacyIdentities||[],legacyIdentityScanComplete:actual.legacyIdentityScanComplete===true,
      compactInkEncoding:true,revision:loaded?.revision||0,annotations:loaded?.annotations||[],
      tombstones:(loaded?.tombstones||[]).map(({deleted,...row})=>row),
      deletionGuards:loaded?.deletionGuards||[]};
  }
  async function updateSourceIdentity({document,pairId,...source}){
    if(document.pairId&&pairId!==document.pairId)return {document,sourceMatch:'MISMATCH',sourceMismatch:true};
    if(!document.pairId&&pairId)return {document,sourceMatch:'MISMATCH',sourceMismatch:true};
    const old=document.source||{};
    for(const key of ['pageCount','orderedPageIdentities'])if(old[key]!==undefined&&source[key]!==undefined&&canonicalJson(old[key])!==canonicalJson(source[key]))return {document,sourceMatch:'MISMATCH',sourceMismatch:true};
    if(!document.pairId){const updated={...document,source:{...old,...source}};provisional.set(document.sourcePath,updated);return {document:updated,sourceMatch:'BASELINE_ESTABLISHED'}}
    return {document,sourceMatch:'MATCH'};
  }
  async function appendOperations({document,operations,sourceHash,quarantined=false}){
    if(document.sourceMismatch||quarantined||sourceHash&&sourceHash!==document.source.sourceHash)throw fail('SOURCE_MISMATCH','v15 cannot save against a different PDF source.');
    let current=await core.readCurrent(document.sourcePath,document.pairId);
    const pending=provisional.get(document.sourcePath);
    const {_v15Deferred,_v15Created,...pairDocumentInput}=document;
    if(!current){
      if(typeof pairDocument!=='function')throw fail('V15_PAIRING_REQUIRED','The PDF must be paired before its first annotation is saved.');
      await registry.ensureReady();
      const paired=await pairDocument(pairDocumentInput);
      current=await core.initialize({document:paired.document,pairId:paired.pairId});
      await registry.remember(current);if(pending?._v15Deferred)await deferred.forget(document.sourcePath,document.documentId);provisional.delete(document.sourcePath);
    }
    // The prepared current file can exist before PDF pairing has finished.
    // Never acknowledge edits from a provisional session until the pairing
    // transaction has been resumed and verified, even if that file exists.
    else if(provisional.has(document.sourcePath)){
      if(typeof pairDocument!=='function')throw fail('V15_PAIRING_REQUIRED','The PDF must be paired before its first annotation is saved.');
      await registry.ensureReady();
      const paired=await pairDocument(pairDocumentInput);
      current=await core.readCurrent(document.sourcePath,paired.pairId);
      if(!current)throw fail('V15_DOCUMENT_MISSING','The paired current-state file is missing.');
      await registry.remember(current);if(pending?._v15Deferred)await deferred.forget(document.sourcePath,document.documentId);provisional.delete(document.sourcePath);
    }
    else if(!document.pairId){
      await registry.remember(current);provisional.delete(document.sourcePath);
    }
    const started=performance.now();const result=await core.save({sourcePath:document.sourcePath,pairId:current.pairId,changes:operations});
    onTiming({phase:'v15-current-save',elapsedMs:performance.now()-started,operationCount:operations.length});
    const confirmed=await core.readCurrent(document.sourcePath,current.pairId);
    return {...result,acknowledged:true,operationCount:operations.length,batchId:operations.length?confirmed.commitId:null,snapshotPending:false};
  }
  async function renameDocument({documentId,fromPath,toPath}){
    const old=await documentForPath(fromPath);
    if(!old){
      // A prior attempt can have published and verified the destination,
      // then removed the original current file before being interrupted.
      // The store verifies the relocation receipt and remaining history.
      const target=await core.readCurrent(toPath);
      if(!target||target.document.documentId!==documentId||target.header.relocation?.fromPath!==fromPath)
        throw fail('V15_IDENTITY_CONFLICT','Rename source identity differs.');
      const resumed=await registry.renameDocument({fromPath,toPath,pairId:target.pairId});
      return {...resumed.document,pairId:resumed.pairId};
    }
    if(old.documentId!==documentId)throw fail('V15_IDENTITY_CONFLICT','Rename source identity differs.');
    if(!old.pairId){const moved=old._v15Deferred?await deferred.move(fromPath,toPath,documentId):{...old,sourcePath:toPath};provisional.delete(fromPath);provisional.set(toPath,moved);return moved;}
    const moved=await registry.renameDocument({fromPath,toPath,pairId:old.pairId});return {...moved.document,pairId:moved.pairId};
  }
  async function documentForInterruptedRename({fromPath,toPath}){
    const target=await core.readCurrent(toPath);
    if(!target||target.header.relocation?.fromPath!==fromPath)return null;
    return {...target.document,pairId:target.pairId};
  }
  function pathsFor(document){const paths=core.pathsFor(document.sourcePath);return {root,docKey:document.docKey,registry:registry.path,snapshot:paths.current,history:paths.history};}
  function affectsPath(document,path){const paths=pathsFor(document);return path===paths.registry||path===paths.snapshot||path===paths.history||path.startsWith(paths.snapshot+'.pending-');}
  return {core,registry,documentForPath,documentForInterruptedRename,registerDocument,documentForIdentity,ensureDocumentIdentity,readDocument,appendOperations,updateSourceIdentity,renameDocument,pathsFor,affectsPath,
    materializeSnapshot:readDocument,sourceProtocol:FORMAT,invalidateExternal(){},invalidateRegistry(){},
    inspectDevices:async()=>({protocol:FORMAT,devices:[],singleSharedFile:true}),establishNewCopy:input=>registerDocument({...input,newInstance:true})};
}
module.exports={createSingleJsonlAnnotationStore};
