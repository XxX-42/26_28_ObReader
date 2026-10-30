/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { canonicalJson }=require('./canonical.cjs');
const { validatePairId }=require('../pdf-pair-id.cjs');
const fail=(code,message)=>Object.assign(new Error(message),{code});

// Rebuildable routing only. A registry hit is always checked against the paired
// current-state file; cached routes never authorize annotation hydration.
function createSingleJsonlRegistry({adapter,store,root='00_Archive/20_PDFData'}){
  const path=`${root}/_registry.json`;
  async function read(){
    if(!await adapter.exists(path))return {raw:null,value:null};
    const raw=await adapter.read(path);
    try{const value=JSON.parse(raw);if(value.schemaVersion!==15||value.kind!=='pdf-reader-pair-registry'||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries))return {raw,value:null};return {raw,value};}
    catch{return {raw,value:null};}
  }
  async function ensureReady(){const loaded=await read();if(loaded.raw!==null&&!loaded.value)throw fail('V15_REGISTRY_REBUILD_REQUIRED','Legacy registry must be migrated before creating new pairs.');}
  function route(current){return {sourcePath:current.document.sourcePath,jsonlPath:store.pathsFor(current.document.sourcePath).current,documentId:current.document.documentId,docKey:current.document.docKey};}
  async function write(entries,expected){
    const value=canonicalJson({schemaVersion:15,kind:'pdf-reader-pair-registry',entries});
    if(expected===value)return;
    if(expected===null){if(await adapter.exists(path))throw fail('V15_STALE_WRITE','Registry appeared during creation.');await adapter.write(path,value);}
    else await adapter.process(path,current=>{if(current!==expected)throw fail('V15_STALE_WRITE','Registry changed while rebuilding.');return value});
    if(await adapter.read(path)!==value)throw fail('V15_WRITE_UNVERIFIED','Registry readback failed.');
  }
  async function remember(current){
    validatePairId(current.pairId);const loaded=await read();
    if(loaded.raw!==null&&!loaded.value)throw fail('V15_REGISTRY_REBUILD_REQUIRED','Legacy or damaged registry needs an explicit verified rebuild.');
    const entries={...(loaded.value?.entries||{})},next=route(current),previous=entries[current.pairId];
    if(previous&&previous.sourcePath!==next.sourcePath)throw fail('V15_PAIR_DUPLICATE','The same pair identity already belongs to a different PDF path.');
    for(const [id,row] of Object.entries(entries))if(id!==current.pairId&&row.sourcePath===next.sourcePath)throw fail('V15_PATH_CONFLICT','Another pair identity occupies this PDF path.');
    entries[current.pairId]=next;await write(entries,loaded.raw);return next;
  }
  async function rebuild({expectedRaw,validate}={}){
    const previous=await read(),entries={};
    if(expectedRaw!==undefined&&previous.raw!==expectedRaw)throw fail('V15_STALE_WRITE','Registry changed during migration.');
    // A valid pre-v15 registry may be the only routing index for old data.
    // Ordinary cache repair must never silently replace it with v15 routes.
    if(expectedRaw===undefined&&previous.raw!==null&&!previous.value){
      let legacy;try{legacy=JSON.parse(previous.raw)}catch{}
      if(legacy&&typeof legacy==='object'&&legacy.schemaVersion!==15&&legacy.entries&&typeof legacy.entries==='object')
        throw fail('V15_REGISTRY_REBUILD_REQUIRED','The legacy registry needs an explicit verified migration.');
    }
    const scanRoot=`${root}/annotations`,queue=[scanRoot];
    while(queue.length){
      const directory=queue.shift();if(!await adapter.exists(directory))continue;
      const listing=await adapter.list(directory);queue.push(...listing.folders);
      for(const file of listing.files){
        if(!file.endsWith('.jsonl'))continue;
        let header;
        try{header=JSON.parse((await adapter.read(file)).split('\n',1)[0]);}catch{throw fail('V15_REGISTRY_REBUILD_INCOMPLETE',`Cannot verify ${file}`)}
        if(header?.document?.sourcePath)store.bindPath(header.document.sourcePath,file);
        if(!header?.document?.sourcePath||store.pathsFor(header.document.sourcePath).current!==file)throw fail('V15_REGISTRY_REBUILD_INCOMPLETE','Current file path differs from its document route.');
        const current=await store.readCurrent(header.document.sourcePath,header.pairId);if(!current)throw fail('V15_REGISTRY_REBUILD_INCOMPLETE','Current file disappeared during rebuild.');
        if(Object.hasOwn(entries,current.pairId))throw fail('V15_PAIR_DUPLICATE','Multiple current files have the same pair identity.');
        entries[current.pairId]=route(current);
      }
    }
    // A valid registry can contain routes for files that have not finished
    // syncing. Rebuilding must never silently remove or reassign those
    // identities merely because a current-state file is temporarily absent.
    for(const [id,prior] of Object.entries(previous.value?.entries||{})){
      const current=entries[id];
      if(!current||current.documentId!==prior.documentId||current.docKey!==prior.docKey)
        throw fail('V15_REGISTRY_REBUILD_INCOMPLETE','A previously verified document route is unavailable or changed.');
    }
    if(validate)await validate(entries);
    await write(entries,previous.raw);return entries;
  }
  async function lookup(pairId){
    validatePairId(pairId);const loaded=await read(),entry=loaded.value?.entries?.[pairId];
    if(entry&&typeof entry.sourcePath==='string'){
      store.bindPath(entry.sourcePath,entry.jsonlPath);
      try{const current=await store.readCurrent(entry.sourcePath,pairId);if(current&&current.document.documentId===entry.documentId&&current.document.docKey===entry.docKey)return current;}catch{/* Resolve only through verified files below. */}
    }
    const rebuilt=await rebuild(),found=rebuilt[pairId];return found?store.readCurrent(found.sourcePath,pairId):null;
  }
  async function renameDocument({fromPath,toPath,pairId}){
    const loaded=await read(),entries={...(loaded.value?.entries||{})};
    for(const [id,row] of Object.entries(entries))if(id!==pairId&&row.sourcePath===toPath)throw fail('V15_PATH_CONFLICT','Rename route is occupied by another pair.');
    if(entries[pairId]&&! [fromPath,toPath].includes(entries[pairId].sourcePath))throw fail('V15_PAIR_DUPLICATE','Existing pair route differs from this rename.');
    const current=await store.renameDocument({fromPath,toPath,pairId});
    if(!loaded.value){await rebuild();return current;}
    entries[pairId]=route(current);await write(entries,loaded.raw);return current;
  }
  return {path,remember,lookup,rebuild,renameDocument,ensureReady};
}
module.exports={createSingleJsonlRegistry};
