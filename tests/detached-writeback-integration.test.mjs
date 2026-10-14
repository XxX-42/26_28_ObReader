import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDocument,PDFName,PDFHexString} from 'pdf-lib';
import core from '../plugin/pdf-merge-core.cjs';
import hostModule from '../plugin/pdf-sync-host.cjs';
import recoveryModule from '../plugin/pdf-recovery.cjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const eq=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);

async function branch(base,uuid,timestamp){
 const doc=await PDFDocument.load(base,{updateMetadata:false});
 const annotation=doc.context.obj({Type:'Annot',Subtype:'Square',Rect:[20+timestamp,30,120+timestamp,70],C:[0,0,0],NM:PDFHexString.fromText(uuid)});
 doc.getPage(0).node.set(PDFName.of('Annots'),doc.context.obj([doc.context.register(annotation)]));
 const operations=[{uuid,ref:null,pageIndex:0,kind:'square',action:'upsert',deleted:false,timestamp,logical:0,actorId:'test-device',operationId:`test-device:${timestamp}:1`}];
 const prepared=await core.prepareLocal({baseBytes:base,draftBytes:await doc.save({useObjectStreams:false}),operations,newAnnotations:[{uuid,runtimeId:`editor-${uuid}`,pageIndex:0,kind:'Square',order:0}],actorId:'test-device'});
 return {prepared,operations};
}

test('detached close writeback rebases against a second remote arrival using real PDF merge and delta recovery',async()=>{
 const doc=await PDFDocument.create();doc.addPage([420,540]).drawText('Independent real PDF race fixture');
 const base=await doc.save({useObjectStreams:false});
 const local=await branch(base,'close-local',10),remoteA=await branch(base,'remote-a',20),remoteB=await branch(base,'remote-b',30);
 const remoteAB=await core.merge({baseBytes:base,localBytes:remoteA.prepared.bytes,remoteBytes:remoteB.prepared.bytes,actorId:'test-device'});
 const localAppend=await core.merge({baseBytes:base,localBytes:local.prepared.bytes,remoteBytes:base,actorId:'test-device'});
 let disk=remoteA.prepared.bytes.slice(),writes=0,appends=0,tokens=0,injected=false;
 const stored=new Map(),root='.obsidian/plugins/pdf-web-reader/.recovery';
 const adapter={exists:async p=>stored.has(p),mkdir:async p=>stored.set(p,true),read:async p=>stored.get(p),write:async(p,s)=>stored.set(p,s),
  readBinary:async p=>stored.get(p).slice().buffer,writeBinary:async(p,b)=>stored.set(p,new Uint8Array(b).slice()),
  list:async p=>({files:[...stored.keys()].filter(n=>n.startsWith(p+'/')&&typeof stored.get(n)!=='boolean'),folders:[]}),remove:async p=>stored.delete(p)};
 const ensureDirectory=async(a,p)=>{if(!await a.exists(p))await a.mkdir(p);};
 const file={path:'isolated-race.pdf',extension:'pdf',basename:'isolated-race'};
 const record=await recoveryModule.writeDeltaRecovery({adapter,root,data:localAppend.bytes,bases:[base],ensureDirectory,
  metadata:{documentId:'test-document',openRequest:1,revision:2,requestId:'close-request',candidateId:'close-real',originalPath:file.path,
   filename:file.basename,origin:'recovery',reason:'close-writeback',status:'draft',createdAt:new Date().toISOString(),baseFingerprint:hash(base)}});
 assert.equal(record.metadata.schema,2);
 const rawHash=hash(new Uint8Array(await adapter.readBinary(record.candidatePath)));
 const intent={schema:1,jobId:'close-real',documentId:'test-document',openRequest:1,revision:2,requestId:'close-request',originalPath:file.path,
  actorId:'test-device',base:{file:`.bases/${hash(base)}.pdf`,hash:hash(base),length:base.length},draft:{hash:hash(localAppend.bytes),length:localAppend.bytes.length},
  operations:local.operations,newAnnotations:[{uuid:'close-local',runtimeId:'editor-close-local',pageIndex:0,kind:'Square',order:0}],phase:'queued',status:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 record.metadata.closeWriteback=intent;await adapter.write(record.metadataPath,JSON.stringify(record.metadata,null,2)+'\n');
 const progress=[];
 const plugin={manifest:{id:'pdf-web-reader'},views:new Set(),recoveryDirectory:root,saveQueue:Promise.resolve(),
  app:{vault:{configDir:'.obsidian',adapter,getAbstractFileByPath:p=>p===file.path?file:null,readBinary:async()=>disk.slice().buffer,
   modifyBinary:async(f,b)=>{assert.equal(f,file);writes++;disk=new Uint8Array(b).slice();},
   appendBinary:async(f,b)=>{assert.equal(f,file);appends++;disk=Uint8Array.from([...disk,...new Uint8Array(b)]);}}},
  enqueueSave(fn){const p=this.saveQueue.then(fn,fn);this.saveQueue=p.catch(()=>{});return p;},setDocumentBaseline(){},
  updateCloseWritebackStatus:s=>progress.push({...s}),
  listRecoveryCandidates:async()=>stored.has(record.metadataPath)?[{...record,metadata:JSON.parse(await adapter.read(record.metadataPath))}]:[],
  readRecoveryBytes:r=>recoveryModule.readDeltaRecovery(adapter,root,r),
  // Keep the current confirmed recovery in the fixture to verify its exact bytes.
  removeRecoveryCandidate:async()=>{},
 };
 const client={...core,dispose(){},merge:async input=>{
  const output=await core.merge(input);
  if(!injected&&hash(new Uint8Array(input.remoteBytes))===hash(remoteA.prepared.bytes)){
   injected=true;disk=remoteAB.bytes.slice();
  }
  return output;
 }};
 const host=hostModule.createPdfSyncHost(plugin,{createPdfMergeClient:()=>client,sha256Bytes:hash,normalizePath:p=>p,
  isPdfFile:f=>f?.extension==='pdf',bytesEqual:eq,ensureAdapterDirectory:ensureDirectory,makeToken:()=>`real-${++tokens}`,Notice:class{}});
 try{
  const task=host.scheduleCloseWriteback(record,intent);assert.ok(task);await task;
  assert.equal(injected,true,'a second remote branch arrived after the first merge: '+JSON.stringify(progress));
  assert.equal(writes+appends,1,'one confirmed source mutation; no blind write replay');
  const output=await core.inspect({bytes:disk});assert.deepEqual(output.identities.map(x=>x.uuid).sort(),['close-local','remote-a','remote-b']);
  assert.ok(progress.some(x=>x.status==='completed'),'the background task confirms its final output');
  assert.equal(hash(new Uint8Array(await adapter.readBinary(record.candidatePath))),rawHash);
  assert.equal(hash(new Uint8Array(await recoveryModule.readDeltaRecovery(adapter,root,{...record,metadata:JSON.parse(await adapter.read(record.metadataPath))}))),hash(localAppend.bytes));
  assert.equal(plugin.views.size,0,'no Viewer is needed for the detached writer');
 }finally{host.dispose();}
});
