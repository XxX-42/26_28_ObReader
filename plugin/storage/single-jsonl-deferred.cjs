/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const {canonicalJson}=require('./canonical.cjs');
const {normalizeInitialPath}=require('./document-identity.cjs');
const fail=(code,message)=>Object.assign(new Error(message),{code});

// Reuses the existing path-keyed document index only for legacy PDFs that
// have no annotations yet. It does not allocate a pair ID or write the PDF.
function createSingleJsonlDeferredIndex({adapter,root='00_Archive/20_PDFData'}){
  const path=`${root}/_index.json`;
  async function read(){
    if(!await adapter.exists(path))return {raw:null,value:{schemaVersion:1,documents:{}}};
    const raw=await adapter.read(path);let value;
    try{value=JSON.parse(raw)}catch{throw fail('V15_DEFERRED_INDEX_INVALID','The document identity index is unreadable.')}
    if(value?.schemaVersion!==1||!value.documents||typeof value.documents!=='object'||Array.isArray(value.documents))
      throw fail('V15_DEFERRED_INDEX_INVALID','The document identity index is incompatible.');
    return {raw,value};
  }
  async function update(change){
    const {raw,value}=await read(),next=change(value),text=canonicalJson(next);
    if(text===raw)return;
    if(raw===null){
      let directory='';for(const part of path.split('/').slice(0,-1)){directory=directory?`${directory}/${part}`:part;if(!await adapter.exists(directory)){try{await adapter.mkdir(directory)}catch(error){if(!await adapter.exists(directory))throw error}}}
      if(await adapter.exists(path))throw fail('V15_STALE_WRITE','Document index appeared during migration.');await adapter.write(path,text)
    }
    else await adapter.process(path,current=>{if(current!==raw)throw fail('V15_STALE_WRITE','Document index changed during migration.');return text});
    if(await adapter.read(path)!==text)throw fail('V15_WRITE_UNVERIFIED','Document index update could not be verified.');
  }
  function validate(document,pathValue){
    if(!document||document.sourcePath!==pathValue||typeof document.documentId!=='string'||!document.documentId||
      !/^[a-f0-9]{12}$/.test(document.docKey||'')||!document.source?.sourceHash)
      throw fail('V15_DEFERRED_INDEX_INVALID','Deferred document identity is incomplete.');
    return document;
  }
  async function remember(document){
    const sourcePath=normalizeInitialPath(document.sourcePath);validate(document,sourcePath);
    await update(index=>{
      const documents={...index.documents},previous=documents[sourcePath];
      if(previous&&(previous.documentId!==document.documentId||previous.docKey!==document.docKey||
        previous.source?.sourceHash!==document.source.sourceHash))throw fail('V15_IDENTITY_CONFLICT','An existing document route has a different identity.');
      documents[sourcePath]={...previous,...document,_v15Deferred:true,_v15Created:previous?previous._v15Created===true:true};
      return {...index,documents};
    });
    return lookup(sourcePath);
  }
  async function lookup(sourcePath){
    sourcePath=normalizeInitialPath(sourcePath);const {value}=await read(),document=value.documents[sourcePath];
    return document?._v15Deferred===true?validate(document,sourcePath):null;
  }
  async function forget(sourcePath,documentId){
    sourcePath=normalizeInitialPath(sourcePath);
    await update(index=>{
      const documents={...index.documents},document=documents[sourcePath];
      if(!document||document._v15Deferred!==true)return index;
      if(document.documentId!==documentId)throw fail('V15_IDENTITY_CONFLICT','Deferred identity changed before pairing.');
      if(document._v15Created===true)delete documents[sourcePath];
      else {const {_v15Deferred,_v15Created,...retained}=document;documents[sourcePath]=retained;}
      return {...index,documents};
    });
  }
  async function move(fromPath,toPath,documentId){
    fromPath=normalizeInitialPath(fromPath);toPath=normalizeInitialPath(toPath);
    await update(index=>{
      const documents={...index.documents},document=documents[fromPath];
      if(!document||document._v15Deferred!==true||document.documentId!==documentId)throw fail('V15_IDENTITY_CONFLICT','Deferred rename source is unavailable.');
      if(documents[toPath])throw fail('V15_PATH_CONFLICT','Deferred rename destination is occupied.');
      documents[toPath]={...document,sourcePath:toPath};delete documents[fromPath];return {...index,documents};
    });
    return lookup(toPath);
  }
  async function findIdentity({documentId,docKey}){
    const {value}=await read(),rows=Object.entries(value.documents).filter(([,d])=>d?._v15Deferred===true&&d.documentId===documentId&&d.docKey===docKey);
    if(rows.length>1)throw fail('V15_IDENTITY_CONFLICT','Deferred identity has multiple document paths.');
    return rows.length?validate(rows[0][1],rows[0][0]):null;
  }
  return {path,remember,lookup,forget,move,findIdentity};
}
module.exports={createSingleJsonlDeferredIndex};
