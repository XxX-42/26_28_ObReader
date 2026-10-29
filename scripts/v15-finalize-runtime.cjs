/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const {createHash,randomUUID}=require('node:crypto');
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const {createWalAnnotationStore}=require('../plugin/storage/wal-annotation-store.cjs');
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createSingleJsonlRegistry}=require('../plugin/storage/single-jsonl-registry.cjs');
const {createSingleJsonlDeferredIndex}=require('../plugin/storage/single-jsonl-deferred.cjs');
const {createSingleJsonlFinalizer,derivedCacheCovered}=require('../plugin/storage/single-jsonl-finalize.cjs');
const {createStorageIo}=require('../plugin/storage/io.cjs');
const {canonicalJson}=require('../plugin/storage/canonical.cjs');
const {buildEffectiveState}=require('../plugin/storage/effective-state.cjs');
const {readPairId}=require('../plugin/pdf-pair-id.cjs');
const ROOT='00_Archive/20_PDFData';
const sha=value=>createHash('sha256').update(value).digest('hex');
const equal=(a,b)=>canonicalJson(a)===canonicalJson(b);

// Called explicitly through the Obsidian CLI, using the actual DataAdapter.
// The receipt is outside PDFData and contains hashes/counts, not old payloads.
async function run({app,expectedVault,runId,apply=false}){
  if(!/^[a-zA-Z0-9_-]+$/.test(runId||''))throw Error('A unique safe runId is required.');
  const adapter=app.vault.adapter;
  if(adapter.basePath.replaceAll('\\','/').toLowerCase()!==expectedVault.replaceAll('\\','/').toLowerCase())throw Error('Wrong Vault.');
  function requireQuiescent(){
    if(app.plugins.enabledPlugins.has('pdf-web-reader')||app.workspace.getLeavesOfType('pdf-web-reader-view').length)throw Error('Save/close Readers and disable the plugin first.');
    const sync=app.internalPlugins?.plugins?.sync;
    if(sync?.enabled&&sync.instance?.getPause?.()!==true)throw Error('Pause Sync before finalization.');
  }
  if(apply)requireQuiescent();
  const runtime=await createPdfHashRuntime(),denied=async()=>{throw Error('LEGACY_READER_IS_READ_ONLY')};
  const readonly={};
  for(const k of ['read','exists','list','readBinary'])readonly[k]=(...args)=>adapter[k](...args);
  for(const k of ['write','append','rename','mkdir','remove','process'])readonly[k]=denied;
  const legacy=createWalAnnotationStore({adapter:readonly,root:ROOT,hash:runtime.fingerprint,verifyHash:runtime.matches,
    identityHash:b=>'sha256-v1:'+sha(b),deviceId:'v15-finalization-readonly',uuid:randomUUID,jsonlMode:true});
  const store=createSingleJsonlStore({adapter,root:ROOT,token:randomUUID});
  const registry=createSingleJsonlRegistry({adapter,store,root:ROOT}),deferred=createSingleJsonlDeferredIndex({adapter,root:ROOT});
  const io=createStorageIo({adapter:readonly,hash:runtime.fingerprint,verifyHash:runtime.matches,token:randomUUID});
  const loadedByKey=new Map(),pdfChecks=[];
  const finalizer=createSingleJsonlFinalizer({adapter,store,registry,deferred,hash:sha,
    async readLegacy(sourcePath,identity){
      const effective=await legacy.readEffective(identity,{readOnly:true});
      if(!effective.document)throw Error('Missing legacy document.');
      const snapshot=await legacy.readDocument(effective.document,{readOnly:true});
      loadedByKey.set(identity.docKey,effective);
      return {document:effective.document,snapshot,errors:effective.errors,sidecarError:effective.sidecarError};
    },
    async verifyPair(current){
      const bytes=new Uint8Array(await adapter.readBinary(current.document.sourcePath));
      const actualSha='sha256-v1:'+sha(bytes),actualXxh=runtime.fingerprint(bytes),pairId=await readPairId(bytes);
      pdfChecks.push({sourcePath:current.document.sourcePath,sha256:actualSha,xxh64:actualXxh,pairId,bytes:bytes.length});
      return pairId===current.pairId&&actualSha===current.document.pairing?.pairedSha256;
    },
    async verifyLegacyFile(p,text){
      if(p===ROOT+'/_storage-protocol.json')return JSON.parse(text).sourceProtocol==='wal-sidecar-v3.2-jsonl';
      if(p.endsWith('.pending')||p.endsWith('.jsonl'))return text===''; // Nonempty tails require a separate migration, never guess.
      const value=await io.decodeRaw(text,{path:p});
      if(p.includes('/main-device-presence/'))return value.kind==='pdf-reader-device-presence';
      const effective=loadedByKey.get(value.docKey||value.document?.docKey);
      if(!effective)return false;
      if(p.includes('/main-routes/')){
        if(value.kind!=='pdf-reader-main-route-claim'||value.documentId!==effective.document.documentId||
          value.route?.payload?.sourcePath!==effective.document.sourcePath||value.route?.payload?.source?.sourceHash!==value.sourceHash)return false;
        return equal(buildEffectiveState({sidecar:value.route,anchors:[...Object.values(effective.state.annotations),
          ...Object.values(effective.state.tombstones),...(effective.state.routing?[effective.state.routing]:[])]}),effective.state);
      }
      if(value.kind==='pdf-reader-jsonl-derived-snapshot'){
        if(value.documentId!==effective.document.documentId||value.sourceHash!==effective.document.source.sourceHash||(value.deletionGuards||[]).length)return false;
        const ops=state=>[...Object.values(state.annotations),...Object.values(state.tombstones),...(state.routing?[state.routing]:[])];
        // Cached snapshots must add no winner absent from verified log replay.
        return equal(buildEffectiveState({sidecar:ops(value),anchors:ops(effective.state)}),effective.state)||derivedCacheCovered(value,effective.state);
      }
      return ['pdf-reader-jsonl-device-anchor','pdf-reader-jsonl-immutable-archive','pdf-reader-device-wal',
        'pdf-reader-materialized-sidecar','pdf-reader-deletion-retention'].includes(value.kind);
    }});
  const directory=`${app.vault.configDir}/plugins/pdf-web-reader/.v15-finalization`,receiptPath=`${directory}/${runId}.json`;
  async function record(value){
    let parent='';for(const part of directory.split('/')){parent=parent?parent+'/'+part:part;if(!await adapter.exists(parent))await adapter.mkdir(parent);}
    const text=JSON.stringify({...value,pdfChecks},null,2);
    if(await adapter.exists(receiptPath))await adapter.process(receiptPath,()=>text);else await adapter.write(receiptPath,text);
    if(await adapter.read(receiptPath)!==text)throw Error('Cannot verify maintenance receipt.');
  }
  let plan;
  if(await adapter.exists(receiptPath)){
    const receipt=JSON.parse(await adapter.read(receiptPath));plan=receipt.plan;
    if(!plan||receipt.phase==='complete')throw Error('This run is complete or has no resumable plan. Use a new runId for a new inspection.');
    pdfChecks.push(...receipt.pdfChecks);
  }else{
    plan=await finalizer.prepare();await record({phase:'planned',plan});
  }
  if(!apply)return {applied:false,receiptPath,documents:plan.documents,cleanupCount:Object.keys(plan.cleanup).length,pdfChecks};
  requireQuiescent();
  if(pdfChecks.length!==plan.documents.filter(d=>!d.deferred).length)throw Error('Missing actual PDF verification evidence.');
  for(const check of pdfChecks){
    const bytes=new Uint8Array(await adapter.readBinary(check.sourcePath));
    if('sha256-v1:'+sha(bytes)!==check.sha256||runtime.fingerprint(bytes)!==check.xxh64)throw Error('PDF changed after planning.');
  }
  const result=await finalizer.apply(plan,{assertQuiescent:requireQuiescent,record:async row=>{requireQuiescent();await record(row)}});
  // Also preserve a final independent PDF read/hash; this script never has a
  // PDF write callback or a reason to re-pair any already migrated document.
  const receipt=JSON.parse(await adapter.read(receiptPath));
  for(const check of receipt.pdfChecks){
    const bytes=new Uint8Array(await adapter.readBinary(check.sourcePath));
    if('sha256-v1:'+sha(bytes)!==check.sha256||runtime.fingerprint(bytes)!==check.xxh64)throw Error('PDF changed during finalization.');
  }
  return {applied:true,receiptPath,documents:result.documents,removed:result.removed,pdfChecks:receipt.pdfChecks};
}
module.exports={run};
