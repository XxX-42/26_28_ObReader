import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PDFDocument, PDFName, PDFHexString } from 'pdf-lib';
import core from '../plugin/pdf-merge-core.cjs';
import journalModule from '../plugin/pdf-journal.cjs';
import recoveryModule from '../plugin/pdf-recovery.cjs';

// Seed a real legacy failure only inside the explicitly isolated Vault. The
// original PDF remains unchanged; the production plugin reads these records.
export async function seedLegacyDelta({vault,configDir,file,base,run}) {
  assert.equal(vault,'/Users/jiajia/Documents/ObReader-Apple-Test');
  assert.equal(configDir,'.obsidian');
  assert.ok(file.startsWith(`PDF迁移测试/${run}/`));
  await assert.rejects(fs.access(path.join(vault,file)));
  const root=`${configDir}/plugins/pdf-web-reader`;
  const allowed=[`${root}/.sync-checkpoints`,`${root}/.recovery`];
  const absolute=p=>{
    assert.ok(allowed.some(r=>p===r||p.startsWith(r+'/')));
    assert.ok(!p.split('/').some(x=>x==='..'));
    return path.join(vault,p);
  };
  const adapter={
    exists:async p=>fs.access(absolute(p)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}),
    mkdir:async p=>fs.mkdir(absolute(p),{recursive:true}),
    read:async p=>fs.readFile(absolute(p),'utf8'),
    write:async(p,s)=>fs.writeFile(absolute(p),s),
    readBinary:async p=>new Uint8Array(await fs.readFile(absolute(p))).buffer,
    writeBinary:async(p,b)=>fs.writeFile(absolute(p),new Uint8Array(b)),
  };
  const fingerprint=b=>createHash('sha256').update(b).digest('hex');
  const bytesEqual=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
  const ensureDirectory=async(a,p)=>a.mkdir(p);
  const uuid=`legacy-${run}`,actorId='native-legacy-device',documentId=`legacy-document-${run}`,requestId=`legacy-save-${run}`;
  const candidateId=run.replace(/[^a-zA-Z0-9_-]/g,'');
  const pdf=await PDFDocument.load(base,{updateMetadata:false});
  const annotation=pdf.context.obj({Type:'Annot',Subtype:'Ink',Rect:[30,30,120,90],
    InkList:[[30,30,70,70,110,40]],C:[0,0,0],BS:{Type:'Border',W:1,S:'S'},F:4,NM:PDFHexString.fromText(uuid)});
  pdf.getPage(9).node.set(PDFName.of('Annots'),pdf.context.obj([pdf.context.register(annotation)]));
  const operations=[{uuid,ref:null,pageIndex:9,kind:'ink',action:'upsert',deleted:false,
    timestamp:10,logical:0,actorId,operationId:`${actorId}:10:1`}];
  const prepared=await core.prepareLocal({baseBytes:base,draftBytes:await pdf.save({useObjectStreams:false}),
    operations,newAnnotations:[{uuid,runtimeId:'legacy-editor',pageIndex:9,kind:'Ink',order:0}],actorId});
  const pending=await core.merge({baseBytes:base,localBytes:prepared.bytes,remoteBytes:base,actorId});
  assert.ok(bytesEqual(pending.bytes.subarray(0,base.length),base));
  const journal=journalModule.createPdfJournal({adapter,root:allowed[0],normalizePath:p=>p,fingerprint,
    fingerprintChunks:chunks=>{const h=createHash('sha256');for(const c of chunks)h.update(c);return h.digest('hex');},
    bytesEqual,ensureDirectory,makeToken:()=>run});
  const manifest=await journal.beginAppend({path:file,baseBytes:base,parentBytes:base,
    suffix:pending.bytes.subarray(base.length),outputFingerprint:fingerprint(pending.bytes),outputLength:pending.bytes.length,
    metadata:{documentId,revision:27,requestId,operations,actorId}});
  const stamp=Date.parse(manifest.updatedAt);
  const recovery=await recoveryModule.writeDeltaRecovery({adapter,root:allowed[1],data:pending.bytes,bases:[base],
    ensureDirectory,metadata:{candidateId,completed:true,origin:'sync',reason:'before-save',status:'conflict',
      error:'PDF 已被替换或移除',originalPath:file,documentId,revision:27,requestId,
      baseFingerprint:fingerprint(base),createdAt:new Date(stamp-1).toISOString(),updatedAt:new Date(stamp+1).toISOString()}});
  assert.equal(recovery.metadata.schema,2);
  assert.ok(bytesEqual(new Uint8Array(await recoveryModule.readDeltaRecovery(adapter,allowed[1],recovery)),pending.bytes));
  const segment=JSON.parse(await adapter.read(manifest.checkpoint.head)).suffix.file;
  const segmentHash=fingerprint(new Uint8Array(await adapter.readBinary(segment)));
  return {uuid,recovery,suffix:segment,manifest:journal.pathsFor(file).manifest,segmentHash,
    verify:async()=>{
      assert.equal(fingerprint(new Uint8Array(await adapter.readBinary(segment))),segmentHash);
      assert.equal(JSON.parse(await adapter.read(journal.pathsFor(file).manifest)).status,'confirmed');
      assert.ok(bytesEqual(new Uint8Array(await recoveryModule.readDeltaRecovery(adapter,allowed[1],recovery)),pending.bytes));
    }};
}
