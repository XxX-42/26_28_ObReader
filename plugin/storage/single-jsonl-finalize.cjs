/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const {canonicalJson}=require('./canonical.cjs');
const {normalizeInitialPath}=require('./document-identity.cjs');
const fail=(message)=>Object.assign(new Error(message),{code:'V15_FINALIZATION_BLOCKED'});
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const rows=value=>[...(value.annotations||[]),...(value.tombstones||[]),...(value.deletionGuards||[])];

// Legacy derived caches could resequence the very same operations. Only the
// three operation-envelope fields may differ; UUID, type, payload, geometry,
// text, embedded refs and the complete route payload must still match.
function derivedCacheCovered(cache,state){
  if((cache.deletionGuards||[]).length)return false;
  const content=({opId,seq,version,...value})=>value;
  for(const name of ['annotations','tombstones']){
    for(const row of Object.values(cache[name]||{})){
      const winner=state[name]?.[row.uuid];
      if(!winner||!same(content(row),content(winner)))return false;
    }
  }
  return !cache.routing||!!state.routing&&same(content(cache.routing),content(state.routing));
}

// An explicit maintenance operation, never part of Reader startup. The caller
// must quiesce Readers and Sync. No PDF writes, new pairing, or state rewriting.
function verifyMigratedState({document,snapshot,current,history=[],deferred}){
  if(!document||!snapshot||snapshot.syncPending)throw fail('Legacy state is not verified.');
  if(!current){
    if(rows(snapshot).length||(document.legacyIdentities||[]).length||!deferred||
      deferred.documentId!==document.documentId||deferred.docKey!==document.docKey||
      deferred.sourcePath!==document.sourcePath||!same(deferred.source,document.source))
      throw fail('Unpaired document is not an identical empty deferred identity.');
    return {exact:0,advanced:0,active:0,deleted:0,deferred:true};
  }
  if(current.document.documentId!==document.documentId||current.document.docKey!==document.docKey||
    current.document.sourcePath!==document.sourcePath||!same(current.document.source,document.source)||
    !same(current.document.legacyIdentities||[],document.legacyIdentities||[])||
    (current.document.legacyIdentityScanComplete===true)!==(document.legacyIdentityScanComplete===true))
    throw fail('Current document/source/embedded annotation identity differs.');
  const currentRows=new Map(rows(current).map(row=>[row.uuid,row]));
  let exact=0,advanced=0;
  for(const row of rows(snapshot)){
    const latest=currentRows.get(row.uuid);
    if(!latest)throw fail(`An old annotation/deletion is missing: ${row.uuid}`);
    if(same(row,latest)){exact++;continue;}
    // A newer v15 edit is preserved only with a complete, exact before/after
    // chain from the legacy winner to the current winner. Never trust counts
    // or timestamps as a substitute for the annotation's actual content.
    let value=row;
    for(const change of history){
      if(change.uuid===row.uuid&&change.before&&same(change.before,value))value=change.after;
    }
    if(!value||!same(value,latest))throw fail(`No verified history covers the changed annotation: ${row.uuid}`);
    advanced++;
  }
  return {exact,advanced,active:current.annotations.length,deleted:current.tombstones.length,deferred:false};
}

function createSingleJsonlFinalizer({adapter,store,registry,deferred,readLegacy,verifyPair,verifyLegacyFile,hash,root='00_Archive/20_PDFData'}){
  normalizeInitialPath(root);
  for(const fn of [readLegacy,verifyPair,verifyLegacyFile,hash])if(typeof fn!=='function')throw TypeError('Verified legacy, file, PDF pair and hash callbacks are required.');
  async function inventory(){
    const files={};
    async function walk(dir){
      const listing=await adapter.list(dir);
      for(const p of [...listing.files,...listing.folders]){
        normalizeInitialPath(p);
        if(!p.startsWith(dir+'/')||p.slice(dir.length+1).includes('/'))throw fail('Adapter listed a path outside its immediate directory.');
      }
      for(const p of listing.files)files[p]=await hash(await adapter.read(p));
      for(const p of listing.folders)await walk(p);
    }
    await walk(root);return files;
  }
  function removable(path,keys){
    const relative=path.slice(root.length+1);
    if(relative==='_storage-protocol.json')return true;
    let m=relative.match(/^sidecars\/([a-f0-9]{12})\.(?:annot|annotations)\.json$/);
    if(m)return keys.has(m[1]);
    m=relative.match(/^wal\/[^/]+\/([a-f0-9]{12})\.(?:json|jsonl(?:\.pending|\.anchor\.json|\.retention\.json|\.archive\.\d+-\d+\.json)?)$/);
    if(m)return keys.has(m[1]);
    return false;
  }
  async function prepare(){
    const before=await inventory(),original=await adapter.read(registry.path),index=JSON.parse(original);
    if(index.schemaVersion!==1||index.kind!=='pdf-reader-registry-cache'||!index.entries||Array.isArray(index.entries))
      throw fail('An existing legacy registry is required for finalization.');
    const documents=[],routes={},keys=new Set(),checked=new Set();
    for(const [sourcePath,identity] of Object.entries(index.entries).sort(([a],[b])=>a.localeCompare(b))){
      const legacy=await readLegacy(sourcePath,identity);
      if(legacy?.errors?.length||legacy?.sidecarError||legacy?.document?.documentId!==identity.documentId||
        legacy?.document?.docKey!==identity.docKey||legacy.document.sourcePath!==sourcePath)throw fail('Legacy route cannot be verified.');
      keys.add(identity.docKey);
      const current=await store.readCurrent(sourcePath),history=current?await store.readHistory(sourcePath,current.pairId):[];
      const retained=current?null:await deferred.lookup(sourcePath);
      const result=verifyMigratedState({...legacy,current,history,deferred:retained});
      if(current){
        if(!await verifyPair(current))throw fail('The actual PDF does not match the v15 paired file.');
        if(routes[current.pairId])throw fail('Duplicate PDF pair identity.');
        const paths=store.pathsFor(sourcePath);checked.add(paths.current);
        routes[current.pairId]={sourcePath,jsonlPath:paths.current,documentId:identity.documentId,docKey:identity.docKey};
      }
      documents.push({sourcePath,...identity,...result,pairId:current?.pairId||null});
    }
    const cleanup={},protectedFiles={};
    for(const [p,digest] of Object.entries(before)){
      const relative=p.slice(root.length+1);
      if(removable(p,keys))cleanup[p]=digest;
      else if(relative.startsWith('main-routes/')||relative.startsWith('main-device-presence/')){
        // Only recognized obsolete experimental metadata; never arbitrary files.
        const value=JSON.parse(await adapter.read(p));
        if(!['pdf-reader-main-route-claim','pdf-reader-device-presence'].includes(value.kind)||
          value.docKey&&!keys.has(value.docKey))throw fail('Unknown old main metadata.');
        cleanup[p]=digest;
      }else if(p===registry.path||relative==='_index.json'||relative.startsWith('anchors/')||relative.startsWith('source-versions/')||
        relative.startsWith('history/')||checked.has(p))protectedFiles[p]=digest;
      else throw fail(`Unaccounted data must be investigated before cleanup: ${p}`);
    }
    for(const p of Object.keys(cleanup))if(!await verifyLegacyFile(p,await adapter.read(p),documents))throw fail(`Old file is not fully accounted for: ${p}`);
    if(!same(before,await inventory()))throw fail('Data changed during verification.');
    const registryText=canonicalJson({schemaVersion:15,kind:'pdf-reader-pair-registry',entries:routes});
    return {kind:'obreader-v15-finalization',schemaVersion:1,root,registryPath:registry.path,originalRegistry:original,
      registryText,documents,cleanup,protectedFiles};
  }
  async function apply(plan,{record,assertQuiescent=()=>{}}={}){
    if(plan.kind!=='obreader-v15-finalization'||plan.root!==root||plan.registryPath!==registry.path||typeof record!=='function')
      throw fail('A retained, verified finalization receipt is required.');
    const keys=new Set(plan.documents.map(d=>d.docKey));
    for(const p of Object.keys(plan.cleanup)){
      normalizeInitialPath(p);
      const relative=p.slice(root.length+1);
      if(!p.startsWith(root+'/')||!removable(p,keys)&&!/^main-(?:routes|device-presence)\/.+\.json(?:\.pending-[a-zA-Z0-9_-]+)?$/.test(relative))throw fail('Cleanup path is not allowed.');
    }
    async function check(){
      const actual=await inventory(),expected={...plan.protectedFiles,...plan.cleanup};
      for(const [p,digest] of Object.entries(actual)){
        if(p===registry.path){const text=await adapter.read(p);if(text!==plan.originalRegistry&&text!==plan.registryText)throw fail('Registry changed after verification.');}
        else if(expected[p]!==digest)throw fail(`Data changed after verification: ${p}`);
      }
      for(const p of Object.keys(plan.protectedFiles))if(!Object.hasOwn(actual,p))throw fail(`Required current file disappeared: ${p}`);
    }
    await assertQuiescent();await check();
    await record({phase:'verified',plan});
    const old=await adapter.read(registry.path);
    if(old===plan.originalRegistry){
      await registry.rebuild({expectedRaw:old,validate(routes){if(!same(routes,JSON.parse(plan.registryText).entries))throw fail('Rebuilt registry differs from the verified routes.');}});
    }
    if(await adapter.read(registry.path)!==plan.registryText)throw fail('Cannot verify published v15 registry.');
    await record({phase:'registry-published',plan});
    await check();
    let removed=0;
    for(const [p,digest] of Object.entries(plan.cleanup)){
      await assertQuiescent();
      // Quiescence is a caller precondition, not a distributed lock. Recheck
      // all authoritative/protected bytes before every irreversible removal.
      for(const [q,h] of Object.entries(plan.protectedFiles)){
        if(q===registry.path){if(await adapter.read(q)!==plan.registryText)throw fail('Registry changed during cleanup.');}
        else if(await hash(await adapter.read(q))!==h)throw fail('Current data changed during cleanup.');
      }
      if(!await adapter.exists(p))continue; // Resume an already recorded cleanup.
      if(await hash(await adapter.read(p))!==digest)throw fail('Legacy file changed before removal.');
      await adapter.remove(p);removed++;
    }
    await check();
    await record({phase:'complete',plan,removed});return {documents:plan.documents,removed};
  }
  return {prepare,apply};
}
module.exports={verifyMigratedState,derivedCacheCovered,createSingleJsonlFinalizer};
