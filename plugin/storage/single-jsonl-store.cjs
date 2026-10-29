/* Copyright 2026 XxX-42 and contributors; SPDX-License-Identifier: Apache-2.0 */
"use strict";
const { sha256 } = require('@noble/hashes/sha256');
const { canonicalJson } = require('./canonical.cjs');
const { normalizeInitialPath } = require('./document-identity.cjs');
const { validatePairId } = require('../pdf-pair-id.cjs');
const { isSupportedHash } = require('../pdf-hash-runtime.cjs');
const FORMAT = 'obreader-current-v15', HISTORY = 'obreader-history-v15';
const KINDS = new Set(['Highlight','Underline','Square','Ink','InkHighlight','FreeText']);
const error = (code,message) => Object.assign(new Error(message),{code});
const clone = value => JSON.parse(canonicalJson(value));
const digest = text => 'sha256-v1:'+Array.from(sha256(new TextEncoder().encode(text)),b=>b.toString(16).padStart(2,'0')).join('');
const frame = (header, rows) => [header,...rows].map(canonicalJson).join('\n')+'\n';
function encode(header,rows){ const integrity=digest(frame(header,rows)); return frame({...header,integrity},rows); }
function decode(text,format,pairId){
  try {
    if(typeof text!=='string'||!text.endsWith('\n'))throw Error('Incomplete JSONL');
    const [sealed,...rows]=text.slice(0,-1).split('\n').map(JSON.parse);
    const {integrity,...header}=sealed;
    if(header.format!==format||!header.type||integrity!==digest(frame(header,rows)))throw Error('Invalid file or integrity');
    validatePairId(header.pairId);
    if(pairId&&header.pairId!==pairId)throw error('V15_PAIR_MISMATCH','PDF and annotation file have different pair identities.');
    return {header,rows};
  } catch(cause){if(cause.code==='V15_PAIR_MISMATCH')throw cause;throw Object.assign(error('V15_FILE_INVALID','The annotation file is incomplete or invalid; existing bytes are retained.'),{cause});}
}
function validateRow(input,deleted=false){
  const row=clone(input);
  if(typeof row.uuid!=='string'||!row.uuid||!KINDS.has(row.kind)||!Number.isSafeInteger(row.pageIndex)||row.pageIndex<0||
    (!deleted&&(!row.payload||typeof row.payload!=='object'||Array.isArray(row.payload))))throw error('V15_ROW_INVALID','Invalid current annotation record.');
  return row;
}
function semantic(row){const {clock,version,deletedAt,...value}=row;return canonicalJson(value);}

// This is a single-writer, current-state store. It does not promise distributed
// merge safety when synchronization overwrites a file from another device.
function createSingleJsonlStore({adapter,root='00_Archive/20_PDFData',token=()=>globalThis.crypto.randomUUID(),clock=Date.now,deviceId='v15-local'}={}){
  for(const name of ['read','write','exists','mkdir','rename','process'])if(typeof adapter?.[name]!=='function')throw TypeError(`DataAdapter.${name} is required.`);
  normalizeInitialPath(root);
  const queues=new Map();
  function queued(path,fn){const previous=queues.get(path)||Promise.resolve();const work=previous.catch(()=>{}).then(fn);const tail=work.then(()=>{},()=>{});queues.set(path,tail);tail.then(()=>{if(queues.get(path)===tail)queues.delete(path)});return work;}
  function pathsFor(sourcePath){const path=normalizeInitialPath(sourcePath);if(!/\.pdf$/i.test(path))throw error('V15_PATH_INVALID','A PDF path is required.');const stem=path.slice(0,-4);return {current:`${root}/annotations/${stem}.jsonl`,history:`${root}/history/${stem}.jsonl`,registry:`${root}/_registry.json`};}
  async function ensure(path){let dir='';for(const part of path.split('/').slice(0,-1)){dir=dir?dir+'/'+part:part;if(!await adapter.exists(dir)){try{await adapter.mkdir(dir)}catch(e){if(!await adapter.exists(dir))throw e}}}}
  async function raw(path){return await adapter.exists(path)?adapter.read(path):null;}
  async function prepare(path,text,id=String(token())){
    await ensure(path);if(!/^[a-zA-Z0-9_-]+$/.test(id))throw error('V15_TOKEN_INVALID','Invalid write identity.');
    const pending=`${path}.pending-${id}`;if(await adapter.exists(pending))throw error('V15_PENDING_EXISTS','Temporary file already exists.');
    await adapter.write(pending,text);if(await adapter.read(pending)!==text)throw error('V15_WRITE_UNVERIFIED','Cannot verify prepared file.');
    return pending;
  }
  async function publishPrepared(path,text,expected,pending){
    if(expected===null){if(await adapter.exists(path))throw error('V15_STALE_WRITE','Destination appeared during creation.');await adapter.rename(pending,path)}
    else await adapter.process(path,current=>{if(current!==expected)throw error('V15_STALE_WRITE','File changed before commit.');return text});
    if(await adapter.read(path)!==text)throw error('V15_WRITE_UNVERIFIED','Cannot verify committed file.');
    // Only this local operation owns this unique stage. Cross-device writes to
    // synchronized paths are explicitly outside v15's concurrency guarantee.
    if(typeof adapter.remove==='function'&&await adapter.exists(pending)&&await adapter.read(pending)===text)await adapter.remove(pending);
  }
  async function publish(path,text,expected){return publishPrepared(path,text,expected,await prepare(path,text));}
  function currentFrom(text,sourcePath,pairId){
    const {header,rows}=decode(text,FORMAT,pairId),document=header.document;
    if(header.type!=='header'||!document||document.sourcePath!==normalizeInitialPath(sourcePath)||
      !/^[a-f0-9]{12}$/.test(document.docKey||'')||typeof document.documentId!=='string'||!document.documentId||
      !Number.isSafeInteger(header.revision)||header.revision<0||typeof header.commitId!=='string'||!header.commitId||
      !/^sha256-v1:[a-f0-9]{64}$/.test(header.historyDigest||''))throw error('V15_FILE_INVALID','Invalid current-state header.');
    const annotations=[],tombstones=[],deletionGuards=[],seen=new Set();
    for(const row of rows){
      if(!row||!['annotation','deletion','deletionGuard'].includes(row.type))throw error('V15_FILE_INVALID','History or unknown record in current-state file.');
      const value=row.type==='deletionGuard'?clone(row.value):validateRow(row.value,row.type==='deletion');
      if(typeof value.uuid!=='string'||!value.uuid||seen.has(value.uuid))throw error('V15_FILE_INVALID','Duplicate or invalid annotation UUID.');
      seen.add(value.uuid);(row.type==='annotation'?annotations:row.type==='deletion'?tombstones:deletionGuards).push(value);
    }
    return {header,document,pairId:header.pairId,revision:header.revision,commitId:header.commitId,annotations,tombstones,deletionGuards};
  }
  function stateRows(value){return [...value.annotations.map(value=>({type:'annotation',value})),...value.tombstones.map(value=>({type:'deletion',value})),...value.deletionGuards.map(value=>({type:'deletionGuard',value}))].sort((a,b)=>a.value.uuid<b.value.uuid?-1:a.value.uuid>b.value.uuid?1:0);}
  async function readCurrent(sourcePath,pairId){const path=pathsFor(sourcePath).current,text=await raw(path);return text===null?null:currentFrom(text,sourcePath,pairId);}
  function parseHistory(text,current){
    if(text===null)throw error('V15_HISTORY_MISSING','The recent-change file is missing; current annotations remain available.');
    const {header,rows}=decode(text,HISTORY,current.pairId);
    if(header.type!=='history-header'||header.documentId!==current.document.documentId||header.docKey!==current.document.docKey||rows.length>100)throw error('V15_FILE_INVALID','Invalid recent-change header.');
    for(const row of rows)if(row.type!=='change'||typeof row.uuid!=='string'||!Number.isSafeInteger(row.revision)||row.revision<=0||typeof row.commitId!=='string')throw error('V15_FILE_INVALID','Invalid change record.');
    return rows.filter(row=>row.revision<current.revision||(row.revision===current.revision&&row.commitId===current.commitId));
  }
  async function historyTextFor(current,path){
    const final=await raw(path);
    if(final!==null&&digest(final)===current.header.historyDigest)return {text:final,final,pending:null};
    const pending=`${path}.pending-${current.commitId}`,prepared=await raw(pending);
    if(prepared!==null&&digest(prepared)===current.header.historyDigest)return {text:prepared,final,pending};
    throw error('V15_HISTORY_MISSING','Cannot verify the history committed by the current file.');
  }
  async function readHistory(sourcePath,pairId){const current=await readCurrent(sourcePath,pairId);if(!current)return [];const found=await historyTextFor(current,pathsFor(sourcePath).history);return parseHistory(found.text,current);}
  async function initialize({document,pairId,annotations=[],tombstones=[],deletionGuards=[]}){
    validatePairId(pairId);const paths=pathsFor(document.sourcePath);
    return queued(paths.current,async()=>{
      const existing=await readCurrent(document.sourcePath,pairId);
      if(existing){
        if(existing.document.documentId!==document.documentId||existing.document.docKey!==document.docKey)throw error('V15_IDENTITY_CONFLICT','The pair identity belongs to a different document.');
        return existing;
      }
      const state={annotations:annotations.map(row=>validateRow(row)),tombstones:tombstones.map(row=>validateRow(row,true)),deletionGuards:clone(deletionGuards)};
      const historyText=encode({type:'history-header',format:HISTORY,pairId,documentId:document.documentId,docKey:document.docKey},[]);
      const header={type:'header',format:FORMAT,pairId,document:clone(document),revision:0,commitId:String(token()),historyDigest:digest(historyText)};
      const text=encode(header,stateRows(state));currentFrom(text,document.sourcePath,pairId);
      const historyPath=paths.history,oldHistory=await raw(historyPath);
      if(oldHistory!==null){const parsed=decode(oldHistory,HISTORY,pairId);if(parsed.rows.length||parsed.header.documentId!==document.documentId)throw error('V15_HISTORY_CONFLICT','Existing history cannot be replaced during initialization.');}
      else await publish(historyPath,historyText,null);
      await publish(paths.current,text,null);return currentFrom(text,document.sourcePath,pairId);
    });
  }
  async function save({sourcePath,pairId,changes,expectedRevision}){
    validatePairId(pairId);if(!Array.isArray(changes))throw TypeError('An annotation change array is required.');const paths=pathsFor(sourcePath);
    return queued(paths.current,async()=>{
      const beforeText=await raw(paths.current);if(beforeText===null)throw error('V15_DOCUMENT_MISSING','Initialize a paired document before saving.');
      const before=currentFrom(beforeText,sourcePath,pairId);
      if(expectedRevision!==undefined&&expectedRevision!==before.revision)throw error('V15_STALE_WRITE','The supplied revision is stale.');
      const previousHistory=await historyTextFor(before,paths.history),history=parseHistory(previousHistory.text,before);
      if(previousHistory.pending)await publishPrepared(paths.history,previousHistory.text,previousHistory.final,previousHistory.pending);
      const map=new Map(stateRows(before).map(row=>[row.value.uuid,row]));
      const entries=[],revision=before.revision+1,commitId=String(token());
      let versionFloor=[...map.values()].reduce((maximum,row)=>Math.max(maximum,row.value.version?.rev||0,row.value.clock?.timestamp||0),0);
      let index=0;
      for(const input of changes){
        const deleted=input?.deleted===true;let value=validateRow(input,deleted);const type=deleted?'deletion':'annotation',prior=map.get(value.uuid);
        if(prior?.type===type&&semantic(prior.value)===semantic(value))continue;
        const previous=prior?.value||null;
        const versionRev=Math.max(clock(),versionFloor+1);
        if(!Number.isSafeInteger(versionRev)||versionRev<0)throw error('V15_VERSION_INVALID','Cannot advance the annotation version safely.');
        versionFloor=versionRev;
        value={...value,version:{rev:versionRev,deviceId,seq:++index},clock:{timestamp:versionRev,logical:index,deviceId,opId:`${commitId}:${index}`}};
        if(deleted){delete value.payload;value.deleted=true;value.deletedAt=clock();}
        map.set(value.uuid,{type,value});entries.push({type:'change',revision,commitId,index,uuid:value.uuid,before:previous,after:value});
      }
      if(!entries.length)return {operationCount:0,batchId:null,revision:before.revision};
      const oldHistory=await raw(paths.history);
      const historyHeader={type:'history-header',format:HISTORY,pairId,documentId:before.document.documentId,docKey:before.document.docKey};
      const historyText=encode(historyHeader,[...history,...entries].slice(-100));
      const historyPending=await prepare(paths.history,historyText,commitId);
      const header={...before.header,revision,commitId,historyDigest:digest(historyText)};
      const rows=[...map.values()].sort((a,b)=>a.value.uuid<b.value.uuid?-1:a.value.uuid>b.value.uuid?1:0);
      const nextText=encode(header,rows);currentFrom(nextText,sourcePath,pairId);
      await publish(paths.current,nextText,beforeText);
      await publishPrepared(paths.history,historyText,oldHistory,historyPending);
      return {operationCount:entries.length,batchId:commitId,revision};
    });
  }
  async function updateSourceIdentity({sourcePath,pairId,documentId,docKey,expectedSourceHash,source,pairing}){
    validatePairId(pairId);const paths=pathsFor(sourcePath);
    if(!source||!isSupportedHash(source.sourceHash)||
      !Number.isSafeInteger(source.pageCount)||!Array.isArray(source.orderedPageIdentities)||source.orderedPageIdentities.length!==source.pageCount)
      throw error('V15_SOURCE_IDENTITY_INVALID','The verified PDF source identity is incomplete.');
    let updatedText=null;
    await queued(paths.current,async()=>{
      await adapter.process(paths.current,currentText=>{
        const current=currentFrom(currentText,sourcePath,pairId);
        if(current.document.documentId!==documentId||current.document.docKey!==docKey)
          throw error('V15_IDENTITY_CONFLICT','The source identity belongs to a different paired document.');
        if(current.document.source?.sourceHash!==expectedSourceHash)
          throw error('V15_STALE_SOURCE_IDENTITY','The PDF source identity changed before the update.');
        const old=current.document.source||{};
        if((old.pageCount!==undefined&&old.pageCount!==source.pageCount)||
          (old.orderedPageIdentities!==undefined&&canonicalJson(old.orderedPageIdentities)!==canonicalJson(source.orderedPageIdentities)))
          throw error('V15_SOURCE_PAGE_IDENTITY_MISMATCH','The PDF page identity changed.');
        const nextPairing=pairing?{...(current.document.pairing||{}),...clone(pairing)}:current.document.pairing;
        const document={...current.document,source:{...old,...clone(source)},...(nextPairing?{pairing:nextPairing}:{})};
        const {integrity,...header}=current.header;
        updatedText=encode({...header,document},stateRows(current));
        currentFrom(updatedText,sourcePath,pairId);
        return updatedText;
      });
      if(await raw(paths.current)!==updatedText)throw error('V15_WRITE_UNVERIFIED','The source identity update could not be verified.');
    });
    return readCurrent(sourcePath,pairId);
  }
  async function renameDocument({fromPath,toPath,pairId}){
    validatePairId(pairId);fromPath=normalizeInitialPath(fromPath);toPath=normalizeInitialPath(toPath);
    const from=pathsFor(fromPath),to=pathsFor(toPath);
    if(fromPath===toPath)return readCurrent(fromPath,pairId);
    const locks=[from.current,to.current].sort();
    return queued(locks[0],()=>queued(locks[1],async()=>{
      const sourceText=await raw(from.current),targetText=await raw(to.current);
      let next,historyText,relocation;
      if(sourceText!==null){
        const source=currentFrom(sourceText,fromPath,pairId),history=await historyTextFor(source,from.history);
        parseHistory(history.text,source);
        if(history.pending)await publishPrepared(from.history,history.text,history.final,history.pending);
        historyText=history.text;
        relocation={fromPath,currentDigest:digest(sourceText),historyDigest:digest(historyText)};
        next=encode({...source.header,document:{...source.document,sourcePath:toPath},relocation},stateRows(source));
        if(targetText!==null&&targetText!==next)throw error('V15_PATH_CONFLICT','Rename destination contains different annotation data.');
      }else{
        if(targetText===null)throw error('V15_DOCUMENT_MISSING','Neither side of the rename has verified annotation data.');
        const target=currentFrom(targetText,toPath,pairId);relocation=target.header.relocation;
        if(relocation?.fromPath!==fromPath)throw error('V15_RENAME_PENDING','No matching interrupted rename is available.');
        next=targetText;historyText=(await historyTextFor(target,to.history)).text;parseHistory(historyText,target);
      }
      const oldTargetHistory=await raw(to.history);
      if(oldTargetHistory!==null&&oldTargetHistory!==historyText)throw error('V15_PATH_CONFLICT','Rename destination has different recent history.');
      if(oldTargetHistory===null)await publish(to.history,historyText,null);
      if(targetText===null)await publish(to.current,next,null);
      // Both destination files are verified before either original is removed.
      if(await raw(to.current)!==next||await raw(to.history)!==historyText)throw error('V15_RENAME_PENDING','Cannot verify the renamed pair.');
      for(const [path,expectedDigest] of [[from.current,relocation.currentDigest],[from.history,relocation.historyDigest]]){
        const text=await raw(path);if(text===null)continue;
        if(digest(text)!==expectedDigest)throw error('V15_RENAME_PENDING','Original bytes changed during rename; all files are retained.');
        if(typeof adapter.remove!=='function')throw error('V15_RENAME_PENDING','Adapter cannot remove the verified old route.');
        await adapter.remove(path);
      }
      return currentFrom(next,toPath,pairId);
    }));
  }
  return Object.freeze({pathsFor,initialize,readCurrent,readHistory,save,updateSourceIdentity,renameDocument,sourceProtocol:FORMAT});
}
module.exports={createSingleJsonlStore,FORMAT};
