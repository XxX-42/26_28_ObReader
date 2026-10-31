import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSingleJsonlStore } = require('../plugin/storage/single-jsonl-store.cjs');
const { createPdfHashRuntime } = require('../plugin/pdf-hash-runtime.cjs');
const pairId = '12'.repeat(16);
const document = { documentId:'old-document',docKey:'123456abcdef',sourcePath:'12_books/戒烟.pdf',source:{sourceHash:'sha256-v1:'+'1'.repeat(64)} };
const annotation = (uuid, text = uuid) => ({uuid,kind:'Highlight',pageIndex:4,embeddedRef:null,payload:{editor:{rect:[1,2,3,4],color:[1,2,3]},targetText:text}});
function world() {
  const files=new Map(), folders=new Set(); let seq=0; const calls=[];
  const adapter={
    async exists(p){return files.has(p)||folders.has(p)}, async mkdir(p){folders.add(p)},
    async read(p){calls.push(['read',p]);if(!files.has(p))throw Error('missing');return files.get(p)},
    async write(p,t){calls.push(['write',p]);files.set(p,t)},
    async rename(a,b){if(files.has(b))throw Error('exists');files.set(b,files.get(a));files.delete(a)},
    async remove(p){files.delete(p)},
    async process(p,fn){calls.push(['process',p]);if(!files.has(p))throw Error('missing');const result=fn(files.get(p));files.set(p,result)},
    async list(p){return {files:[...files.keys()].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/')),folders:[...folders].filter(x=>x.startsWith(p+'/')&&!x.slice(p.length+1).includes('/'))}}
  };
  const store=()=>createSingleJsonlStore({adapter,token:()=>`commit-${++seq}`,clock:()=>1000+seq});
  return {files,adapter,calls,store};
}

test('current JSONL preserves rows and deletions, with no operation history or device files',async()=>{
  const w=world(),s=w.store(),a=annotation('A');
  await s.initialize({document,pairId,annotations:[a],tombstones:[{uuid:'D',kind:'Ink',pageIndex:0}]});
  const got=await w.store().readCurrent(document.sourcePath,pairId);
  assert.deepEqual(got.annotations,[a]);assert.equal(got.tombstones[0].uuid,'D');
  const paths=s.pathsFor(document.sourcePath);
  assert.match(paths.current,/annotations\/12_books\/戒烟\d{6}\.jsonl$/);
  const lines=w.files.get(paths.current).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(x=>x.type),['header','annotation','deletion']);
  assert.equal(lines.some(x=>x.op||x.operations),false);
  assert.equal([...w.files.keys()].some(x=>x.includes('/wal/')||x.includes('/checkpoints/')),false);
  w.calls.length=0;await s.readCurrent(document.sourcePath,pairId);
  assert.deepEqual(w.calls,[['read',paths.current]],'opening reads exactly the current file');
});

test('verified source identity transition preserves pair and rows and rejects stale hash',async()=>{
  const runtime=await createPdfHashRuntime();const w=world(),s=w.store(),before={...document,source:{...document.source,
    sourceHash:runtime.fingerprint(new TextEncoder().encode('old paired PDF bytes')),pageCount:1,orderedPageIdentities:['page-a']}};
  await s.initialize({document:{...before,pairing:{originalSha256:'a'.repeat(64),pairedSha256:'1'.repeat(64),pairedSize:10}},pairId,annotations:[annotation('keep')]});
  const nextSource={...before.source,sourceHash:runtime.fingerprint(new TextEncoder().encode('new paired PDF bytes')),size:42,
    tailHash64k:runtime.fingerprint(new TextEncoder().encode('new tail'))};
  const next=await s.updateSourceIdentity({sourcePath:before.sourcePath,pairId,documentId:before.documentId,docKey:before.docKey,
    expectedSourceHash:before.source.sourceHash,source:nextSource,pairing:{pairedSha256:'2'.repeat(64),pairedSize:42},allowVerifiedSourceTransition:true});
  assert.equal(next.pairId,pairId);assert.equal(next.document.documentId,before.documentId);assert.equal(next.document.docKey,before.docKey);
  assert.equal(next.document.source.sourceHash,nextSource.sourceHash);assert.deepEqual(next.annotations.map(row=>row.uuid),['keep']);
  assert.equal(next.document.pairing.originalSha256,'a'.repeat(64));assert.equal(next.document.pairing.pairedSha256,'2'.repeat(64));
  await assert.rejects(s.updateSourceIdentity({sourcePath:before.sourcePath,pairId,documentId:before.documentId,docKey:before.docKey,
    expectedSourceHash:before.source.sourceHash,source:{...nextSource,sourceHash:runtime.fingerprint(new TextEncoder().encode('wrong paired PDF bytes'))},allowVerifiedSourceTransition:true}),{code:'V15_STALE_SOURCE_IDENTITY'});
});

test('120 changes retain current state and exactly the last 100 before/after records',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId});
  for(let i=0;i<120;i++)await s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A',`text-${i}`)]});
  const got=await w.store().readCurrent(document.sourcePath,pairId),history=await s.readHistory(document.sourcePath,pairId);
  assert.equal(got.annotations.length,1);assert.equal(got.annotations[0].payload.targetText,'text-119');
  assert.equal(history.length,100);assert.equal(history[0].after.payload.targetText,'text-20');
  assert.equal(history[0].before.payload.targetText,'text-19');
  assert.equal(history.at(-1).after.payload.targetText,'text-119');
  assert.equal((await s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A','text-119')]})).operationCount,0);
  await s.save({sourcePath:document.sourcePath,pairId,changes:[{uuid:'A',kind:'Highlight',pageIndex:4,deleted:true}]});
  assert.equal((await s.readCurrent(document.sourcePath,pairId)).annotations.length,0);
  assert.equal((await s.readCurrent(document.sourcePath,pairId)).tombstones[0].uuid,'A');
  assert.equal((await s.readHistory(document.sourcePath,pairId)).at(-1).after.deleted,true);
});

test('per-device reader state survives annotation writes without changing history',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A','original')]});
  await s.saveReaderState({sourcePath:document.sourcePath,pairId,deviceId:'windows',state:{pageNumber:12,sidebar:{side:'left',width:400}}});
  await s.saveReaderState({sourcePath:document.sourcePath,pairId,deviceId:'ipad',state:{pageNumber:7}});
  await s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('B','next')]});
  const result=await w.store().readCurrent(document.sourcePath,pairId);
  assert.equal(result.header.readerStates.windows.sidebar.side,'left');
  assert.equal(result.header.readerStates.ipad.pageNumber,7);
  assert.equal(result.annotations.length,2);
  assert.equal((await s.readHistory(document.sourcePath,pairId)).length,1);
  await assert.rejects(s.saveReaderState({sourcePath:document.sourcePath,pairId,deviceId:'__proto__',state:{pageNumber:1}}),{code:'V15_READER_STATE_INVALID'});
});

test('reader state and annotation writes serialize and retain previously committed bytes on failure',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A','original')]});
  await Promise.all([
    s.saveReaderState({sourcePath:document.sourcePath,pairId,deviceId:'windows',state:{pageNumber:19}}),
    s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('B','new')]}),
  ]);
  const good=await s.readCurrent(document.sourcePath,pairId);
  assert.equal(good.header.readerStates.windows.pageNumber,19);
  assert.deepEqual(good.annotations.map(row=>row.uuid).sort(),['A','B']);
  const path=s.pathsFor(document.sourcePath).current,original=w.adapter.process;
  const bytes=w.files.get(path);
  w.adapter.process=async(p,fn)=>{if(p===path)throw Error('disk failure');return original(p,fn)};
  await assert.rejects(s.saveReaderState({sourcePath:document.sourcePath,pairId,deviceId:'windows',state:{pageNumber:20}}),/disk failure/);
  assert.equal(w.files.get(path),bytes);
});

test('history-first failed save is not acknowledged or presented as committed history',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A','before')]});
  const path=s.pathsFor(document.sourcePath).current,original=w.adapter.process;
  w.adapter.process=async(p,fn)=>{if(p===path)throw Error('disk failure');return original(p,fn)};
  await assert.rejects(s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A','uncommitted')]}),/disk failure/);
  assert.equal((await w.store().readCurrent(document.sourcePath,pairId)).annotations[0].payload.targetText,'before');
  assert.deepEqual(await w.store().readHistory(document.sourcePath,pairId),[]);
  w.adapter.process=original;
  await s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A','committed')]});
  const history=await s.readHistory(document.sourcePath,pairId);
  assert.equal(history.length,1);assert.equal(history[0].after.payload.targetText,'committed');
  assert.ok([...w.files.keys()].some(p=>p.startsWith(path+'.pending-')),'failed temporary bytes retained');
});

test('pair mismatch, path collision and malformed current state never overwrite existing data',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A')]});
  const path=s.pathsFor(document.sourcePath).current;
  await assert.rejects(s.readCurrent(document.sourcePath,'34'.repeat(16)),{code:'V15_PAIR_MISMATCH'});
  await assert.rejects(s.initialize({document,pairId:'34'.repeat(16)}),{code:'V15_PAIR_MISMATCH'});
  w.files.set(path,'{broken');
  await assert.rejects(s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('B')]}),{code:'V15_FILE_INVALID'});
  assert.equal(w.files.get(path),'{broken');
});

test('failed 101st change cannot evict any of the last 100 committed changes',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId});
  for(let i=0;i<100;i++)await s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A',`text-${i}`)]});
  const before=await s.readHistory(document.sourcePath,pairId),original=w.adapter.process;
  w.adapter.process=async(p,fn)=>{if(p===s.pathsFor(document.sourcePath).current)throw Error('main failed');return original(p,fn)};
  await assert.rejects(s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A','failed')]}),/main failed/);
  assert.deepEqual(await w.store().readHistory(document.sourcePath,pairId),before);
});

test('new main with unpublished recent history recovers the exact prepared history after restart',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A','before')]});
  const original=w.adapter.process;
  w.adapter.process=async(p,fn)=>{if(p===s.pathsFor(document.sourcePath).history)throw Error('history publish failed');return original(p,fn)};
  await assert.rejects(s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A','after')]}),/history publish failed/);
  const restarted=w.store();
  assert.equal((await restarted.readCurrent(document.sourcePath,pairId)).annotations[0].payload.targetText,'after');
  const history=await restarted.readHistory(document.sourcePath,pairId);
  assert.equal(history.length,1);assert.equal(history[0].before.payload.targetText,'before');assert.equal(history[0].after.payload.targetText,'after');
});

test('same-instance simultaneous edits are serialized without losing either UUID',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId});
  await Promise.all([s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A')]}),s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('B')]})]);
  assert.deepEqual((await s.readCurrent(document.sourcePath,pairId)).annotations.map(x=>x.uuid),['A','B']);
});

test('editing migrated rows advances their existing version even after a local clock rollback',async()=>{
  const w=world(),s=w.store(),old={...annotation('A','old'),version:{rev:9000000,deviceId:'old-device',seq:500},clock:{timestamp:9000000,logical:500,deviceId:'old-device',opId:'old'}};
  await s.initialize({document,pairId,annotations:[old]});
  await s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A','new')]});
  const value=(await s.readCurrent(document.sourcePath,pairId)).annotations[0];
  assert.ok(value.version.rev>old.version.rev);assert.ok(value.clock.timestamp>old.clock.timestamp);
  assert.equal(value.uuid,'A');assert.equal(value.payload.targetText,'new');
});

test('the same pair ID cannot silently substitute another legacy document identity',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A')]});
  await assert.rejects(s.initialize({document:{...document,documentId:'different'},pairId}),{code:'V15_IDENTITY_CONFLICT'});
});

test('rename moves both named files while retaining pair, UUID, version and recent history',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A')]});
  await s.save({sourcePath:document.sourcePath,pairId,changes:[annotation('A','edited')]});
  const before=await s.readCurrent(document.sourcePath,pairId),history=await s.readHistory(document.sourcePath,pairId),toPath='Other/新书名.pdf';
  const moved=await s.renameDocument({fromPath:document.sourcePath,toPath,pairId});
  assert.equal(moved.pairId,pairId);assert.equal(moved.document.documentId,document.documentId);assert.equal(moved.document.sourcePath,toPath);
  assert.deepEqual(moved.annotations,before.annotations);assert.deepEqual(await w.store().readHistory(toPath,pairId),history);
  assert.equal(w.files.has(s.pathsFor(document.sourcePath).current),false);assert.equal(w.files.has(s.pathsFor(document.sourcePath).history),false);
});

test('interrupted rename resumes from verified new files without losing annotations or history',async()=>{
  const w=world(),s=w.store();await s.initialize({document,pairId,annotations:[annotation('A')]});
  const toPath='Other/new.pdf',original=w.adapter.remove;
  w.adapter.remove=async p=>{if(p===s.pathsFor(document.sourcePath).history)throw Error('interrupted');return original(p)};
  await assert.rejects(s.renameDocument({fromPath:document.sourcePath,toPath,pairId}),/interrupted/);
  assert.equal((await w.store().readCurrent(toPath,pairId)).annotations[0].uuid,'A');
  w.adapter.remove=original;
  const recovered=await w.store().renameDocument({fromPath:document.sourcePath,toPath,pairId});
  assert.equal(recovered.pairId,pairId);assert.deepEqual(await s.readHistory(toPath,pairId),[]);
  assert.equal(w.files.has(s.pathsFor(document.sourcePath).history),false);
});
