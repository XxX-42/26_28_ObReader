import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import core from '../plugin/pdf-merge-core.cjs';
import hostModule from '../plugin/pdf-sync-host.cjs';
import journalModule from '../plugin/pdf-journal.cjs';
import recoveryModule from '../plugin/pdf-recovery.cjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const eq = (a,b) => a.length === b.length && a.every((x,i) => x === b[i]);
const root = '.obsidian/plugins/pdf-web-reader/.sync-checkpoints';
let testedHost = hostModule;
if (process.env.PDF_READER_HOST_BASELINE_FILE) {
  const module = {exports:{}};
  const source = readFileSync(process.env.PDF_READER_HOST_BASELINE_FILE,'utf8');
  runInThisContext(`(function(require,module,exports){${source}\n})`)(createRequire(new URL('../plugin/pdf-sync-host.cjs',import.meta.url)),module,module.exports);
  testedHost = module.exports;
}
async function branch(base, uuid, kind, timestamp) {
  const doc = await PDFDocument.load(base, {updateMetadata:false});
  const page = doc.getPage(0);
  const annotation = doc.context.obj({Type:'Annot',Subtype:kind,Rect:[20,30,120,70],NM:PDFHexString.fromText(uuid),Contents:PDFHexString.fromText(uuid)});
  if(kind === 'Ink') annotation.set(PDFName.of('InkList'),doc.context.obj([[20,30,50,60,100,65]]));
  page.node.set(PDFName.of('Annots'),doc.context.obj([doc.context.register(annotation)]));
  const data = await doc.save({useObjectStreams:false});
  const operations = [{uuid,ref:null,pageIndex:0,kind:kind.toLowerCase(),action:'upsert',deleted:false,timestamp,logical:0,actorId:'test-device',operationId:`test-device:${timestamp}:1`}];
  const newAnnotations = [{uuid,runtimeId:`editor-${uuid}`,pageIndex:0,kind,order:0}];
  return {data,operations,newAnnotations,actorId:'test-device'};
}

async function verifyPendingBranch(legacy = false, delta = false) {
  const pdf = await PDFDocument.create();pdf.addPage([420,540]).drawText('Independent synthetic test PDF');
  const base = await pdf.save({useObjectStreams:false});
  const prior = await branch(base,'pending-ink','Ink',10);
  const prepared = await core.prepareLocal({baseBytes:base,draftBytes:prior.data,...prior});
  const pendingOutput = legacy ? await core.merge({baseBytes:base,localBytes:prepared.bytes,remoteBytes:base,actorId:'test-device'}) : prepared;
  const current = await branch(base,'current-square','Square',20);
  let disk = base.slice(), tokens=0, writes=0, appends=0;
  const stored = new Map();
  const adapter = {
    exists:async p=>stored.has(p),mkdir:async p=>stored.set(p,true),
    read:async p=>stored.get(p),write:async(p,s)=>stored.set(p,s),
    readBinary:async p=>stored.get(p).slice().buffer,
    writeBinary:async(p,b)=>stored.set(p,new Uint8Array(b).slice()),
    list:async p=>({files:[...stored.keys()].filter(n=>n.startsWith(p+'/')),folders:[]}),
  };
  const directory = async(a,p)=>{if(!await a.exists(p))await a.mkdir(p);};
  const journal = journalModule.createPdfJournal({adapter,root,normalizePath:p=>p,fingerprint:hash,fingerprintChunks:chunks=>{const h=createHash('sha256');for(const c of chunks)h.update(c);return h.digest('hex');},bytesEqual:eq,ensureDirectory:directory,makeToken:()=>`test-${++tokens}`});
  const path='isolated-synthetic-test.pdf';
  const metadata={documentId:'test-document',revision:1,operations:prior.operations,newAnnotations:prior.newAnnotations,...(legacy ? {} : {writePhase:'preflight',writeParentHash:hash(base),writeParentLength:base.length})};
  const pending = legacy
    ? await journal.beginAppend({path,baseBytes:base,parentBytes:base,suffix:pendingOutput.bytes.subarray(base.length),outputFingerprint:hash(pendingOutput.bytes),outputLength:pendingOutput.bytes.length,metadata})
    : await journal.beginFull({path,baseBytes:base,checkpointBytes:pendingOutput.bytes,metadata});
  const originalSegmentPath = legacy ? JSON.parse(stored.get(pending.checkpoint.head)).suffix.file : pending.checkpoint.file;
  const originalCheckpoint = stored.get(originalSegmentPath).slice();
  const file={path,extension:'pdf',basename:'isolated-synthetic-test'};
  const posted=[],recoveries=[],merges=[];
  const recoveryRoot='.obsidian/plugins/pdf-web-reader/.recovery';
  const legacyMetadataPath=`${recoveryRoot}/legacy.json`;
  let legacyCandidatePath=`${recoveryRoot}/legacy.pdf`;
  if (legacy) {
    const stamp=Date.parse(pending.updatedAt);
    const recoveryMetadata={schema:1,candidateId:'legacy',candidateFile:'legacy.pdf',completed:true,origin:'sync',reason:'before-save',status:'conflict',error:'PDF 已被替换或移除',originalPath:path,documentId:'test-document',revision:1,requestId:null,baseFingerprint:hash(base),outputHash:hash(prior.data),outputLength:prior.data.length,createdAt:new Date(stamp-1).toISOString(),updatedAt:new Date(stamp+1).toISOString()};
    if(delta){
      const record=await recoveryModule.writeDeltaRecovery({adapter,root:recoveryRoot,data:pendingOutput.bytes,bases:[base],metadata:recoveryMetadata,ensureDirectory:directory});
      assert.equal(record.metadata.schema,2);assert.equal(record.metadata.storage,'pdf-prefix-delta');
      legacyCandidatePath=record.candidatePath;
    }else{
      stored.set(legacyMetadataPath,JSON.stringify(recoveryMetadata));
      stored.set(legacyCandidatePath,prior.data.slice());
    }
  }
  const plugin={manifest:{id:'pdf-web-reader'},views:new Set(),app:{vault:{configDir:'.obsidian',adapter,
    getAbstractFileByPath:p=>p===path?file:null,
    readBinary:async()=>disk.slice().buffer,
    modifyBinary:async(f,b)=>{assert.equal(f,file);writes++;disk=new Uint8Array(b).slice();},
    appendBinary:async(f,b)=>{assert.equal(f,file);appends++;disk=Uint8Array.from([...disk,...new Uint8Array(b)]);},
  }},enqueueSave:async fn=>fn(),setDocumentBaseline(){},
    writeRecoveryCandidate:async input=>{const r={...input};recoveries.push(r);return r;},
    markRecoveryCandidate:async()=>{},removeRecoveryCandidate:async r=>{r.removed=true;},
    listRecoveryCandidates:async()=>legacy ? [{metadata:JSON.parse(stored.get(legacyMetadataPath)),metadataPath:legacyMetadataPath,candidatePath:legacyCandidatePath}] : [],
    readRecoveryBytes:async r=>delta ? recoveryModule.readDeltaRecovery(adapter,recoveryRoot,r) : stored.get(r.candidatePath).slice().buffer,
  };
  const client={...core,merge:async input=>{merges.push(input);return core.merge(input);},dispose(){}};
  const host=testedHost.createPdfSyncHost(plugin,{createPdfMergeClient:()=>client,sha256Bytes:hash,normalizePath:p=>p,isPdfFile:f=>f?.extension==='pdf',bytesEqual:eq,makeToken:()=>`test-device-${++tokens}`,ensureAdapterDirectory:directory,Notice:class{}});
  const view={file,documentFile:file,ready:true,documentId:'test-document',openRequest:1,rendererGeneration:'generation',originalBytes:base,loadedBaseBytes:base,currentRevision:1,confirmedRevision:0,syncRequests:new Map(),setStatus(value){this.status=value;},postToViewer:m=>{posted.push(m);return true;},isCurrentSaveRequest:c=>c.file===file&&c.documentId==='test-document'};
  plugin.views.add(view);
  const priorWorker = globalThis.Worker;globalThis.Worker=class {};
  try{
    await host.initializeView(view,base);
    assert.equal(writes+appends,0,'startup never writes the pending suffix');
    assert.ok(!view.status?.includes('自动合并暂停'));
    await host.save(view,{file,documentId:view.documentId,openRequest:1,rendererGeneration:'generation',originalBytes:base,loadedBaseBytes:base,filename:file.basename},{...current,data:current.data,revision:1,requestId:'save-test',origin:'manual'});
    view.ready=false;
    const output=await core.inspect({bytes:disk});
    assert.deepEqual(output.identities.map(x=>x.uuid).sort(),['current-square','pending-ink']);
    assert.ok(merges.some(m=>eq(m.localBytes,pendingOutput.bytes)),'the old pending branch participates in the merge');
    assert.equal(writes+appends,1,'one newly coordinated write, no blind replay');
    assert.ok(posted.some(m=>m.type==='saved'&&m.revision===1));
    assert.equal((await journal.load(path)).status,'confirmed');
    assert.ok(eq(stored.get(originalSegmentPath),originalCheckpoint),'the old recovery checkpoint bytes remain intact');
  }finally{host.dispose();if(priorWorker===undefined)delete globalThis.Worker;else globalThis.Worker=priorWorker;}
}

test('restart merges an intact preflight Ink branch and a fresh Square through the real PDF writer',()=>verifyPendingBranch());
test('legacy pre-write failure evidence permits preserving and merging both real PDF branches',()=>verifyPendingBranch(true));
test('schema-2 delta recovery from the real writer proves the legacy pre-write failure without losing Ink or new edits',()=>verifyPendingBranch(true,true));
