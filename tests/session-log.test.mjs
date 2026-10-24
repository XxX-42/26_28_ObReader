import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
const { createSessionLog, traceFunction, traceMethods } = createRequire(import.meta.url)('../plugin/session-log.cjs');
function fixture(options = {}) {
  const files = new Map(), dirs = new Set();
  const adapter = { exists: async p => files.has(p) || dirs.has(p), mkdir: async p => dirs.add(p), write: async(p,s) => files.set(p,s), append: async(p,s) => files.set(p,(files.get(p)||'')+s) };
  adapter.read=async p=>{if(!files.has(p))throw Error('missing');return files.get(p);};
  adapter.list=async p=>({files:[...files.keys()].filter(n=>n.startsWith(p+'/')),folders:[]});
  adapter.rename=async(a,b)=>{files.set(b,files.get(a));files.delete(a);};
  const log = createSessionLog({ adapter, directory: '.obsidian/plugins/test/.logs', version: 'test', interval: 100000, ...options });
  return { files, adapter, log, rows: () => [...files.values()].flatMap(s => s.trim().split('\n').map(JSON.parse)) };
}
test('tracing preserves this, argument/return identity and original thrown error', async()=>{
  const f=fixture(), value={}, error=Error('actual failure'), object={ value, ok(arg){assert.equal(arg,value);return this.value;}, bad(){throw error;} };
  traceMethods(object,'Core',()=>f.log);
  assert.equal(object.ok(value),value);assert.throws(()=>object.bad(),e=>e===error);
  await f.log.close();const rows=f.rows();assert.equal(rows[0].kind,'session.start');
  assert.ok(rows.some(r=>r.fn==='Core.bad'&&r.error?.message==='actual failure'&&r.durationMs>=0));
  assert.equal(rows.at(-1).kind,'session.end');assert.ok(!JSON.stringify(rows).includes('argument'));
});
test('visible JSON includes prior-session errors and current function records after Readers have closed',async()=>{
  const f=fixture();const old='.obsidian/plugins/test/.logs/2026-10-13T00-00-00-000Z-previous-000.log';
  f.files.set(old,JSON.stringify({kind:'function.error',fn:'Viewer.requestSave',error:{message:'Could not bind Ink'}})+'\n');
  f.log.record('function.end',{fn:'Core.save',durationMs:12});
  const result=await f.log.exportDiagnostic({schema:1,activeReaderCount:0,readers:[]},'Diagnostics/run.json',f.adapter.write);
  const json=JSON.parse(f.files.get('Diagnostics/run.json'));
  assert.equal(result.complete,false);assert.equal(json.runtimeLog.interruptedSessions.length,1);assert.equal(json.activeReaderCount,0);assert.ok(json.runtimeLog.records.some(r=>r.error?.message==='Could not bind Ink'));
  assert.ok(json.runtimeLog.records.some(r=>r.fn==='Core.save'&&r.durationMs===12));assert.ok(f.files.has(old));
  assert.ok(!f.files.has('Diagnostics/run.json.partial'));await f.log.close();
});
test('JSON error analysis highlights stack overflows with bounded save context and Worker stack',async()=>{
  const f=fixture();
  f.log.record('function.begin',{fn:'PdfMergeClient.prepareLocal',call:7});
  f.log.record('function.error',{fn:'PdfMergeClient.prepareLocal',call:7,error:{name:'RangeError',code:'PDF_MERGE_CONFLICT',message:'Maximum call stack size exceeded',workerName:'RangeError',workerCode:'PDF_MERGE_CONFLICT',workerMethod:'prepareLocal',workerPhase:'core.execute',workerStack:'at reconcile (/worker/pdf-merge-core.js:20:4)'}});
  f.log.record('performance',{fn:'PdfSyncHost.save',saveTransactionId:'save-transaction-7',status:'failed',errorCode:'conflict',saveTotalMs:812});
  f.log.record('user',{event:'pointermove',x:123,y:456,text:'must not enter focused error context'});
  await f.log.exportDiagnostic({schema:1},'Diagnostics/stack-overflow.json',f.adapter.write);
  const json=JSON.parse(f.files.get('Diagnostics/stack-overflow.json'));
  const focus=json.runtimeLog.errorAnalysis;
  assert.equal(focus.stackOverflow.eventCount,1);
  assert.equal(focus.stackOverflow.events[0].fn,'PdfMergeClient.prepareLocal');
  assert.equal(focus.stackOverflow.events[0].error.workerMethod,'prepareLocal');
  assert.match(focus.stackOverflow.events[0].error.workerStack,/reconcile/);
  assert.ok(focus.stackOverflow.events[0].context.some(row=>row.saveTransactionId==='save-transaction-7'));
  assert.ok(!JSON.stringify(focus).includes('pointermove'));
  assert.ok(!JSON.stringify(focus).includes('must not enter'));
  await f.log.close();
});
test('JSON snapshot seals its source part and cannot chase export-time events',async()=>{
  const f=fixture();f.log.record('user',{event:'click',marker:'before-export'});
  const append=f.adapter.append;f.adapter.append=async(p,s)=>{if(p.endsWith('.partial')){f.log.record('user',{event:'click',marker:'during-export'});await f.log.flush();}return append(p,s);};
  await f.log.exportDiagnostic({schema:1},'Diagnostics/run.json',f.adapter.write,200);
  const json=JSON.parse(f.files.get('Diagnostics/run.json'));
  assert.ok(json.runtimeLog.records.some(r=>r.marker==='before-export'));assert.ok(!json.runtimeLog.records.some(r=>r.marker==='during-export'));
  assert.ok([...f.files.entries()].some(([p,s])=>p.endsWith('.log')&&s.includes('during-export')));f.adapter.append=append;await f.log.close();
});
test('records arriving during both flushes are retained for the next cutoff',async()=>{
  const f=fixture(), write=f.adapter.write, append=f.adapter.append;
  const inject=async(p,s,original)=>{await original(p,s);if(p.endsWith('.log'))f.log.record('user',{event:'click',marker:'after-cutoff'});};
  f.adapter.write=(p,s)=>inject(p,s,write);f.adapter.append=(p,s)=>inject(p,s,append);
  await f.log.exportDiagnostic({schema:1},'Diagnostics/first.json',write);
  const first=JSON.parse(f.files.get('Diagnostics/first.json'));
  assert.equal(first.runtimeLog.complete,true);assert.ok(!first.runtimeLog.records.some(r=>r.event==='after-cutoff'));
  f.adapter.write=write;f.adapter.append=append;
  await f.log.exportDiagnostic({schema:1},'Diagnostics/second.json',write);
  assert.ok(JSON.parse(f.files.get('Diagnostics/second.json')).runtimeLog.records.some(r=>r.marker==='after-cutoff'));
  await f.log.close();
});
test('historical parts use numeric order and a final shutdown marks the session ended',async()=>{
  const f=fixture(), prefix='.obsidian/plugins/test/.logs/2026-10-13T00-00-00-000Z-old-';
  f.files.set(prefix+'999.log',JSON.stringify({kind:'user',event:'click',marker:'first'})+'\n');
  f.files.set(prefix+'1000.log',JSON.stringify({kind:'session.end'})+'\n');
  await f.log.exportDiagnostic({schema:1},'Diagnostics/run.json',f.adapter.write);
  const json=JSON.parse(f.files.get('Diagnostics/run.json'));
  assert.equal(json.runtimeLog.complete,true);const marker=json.runtimeLog.records.findIndex(r=>r.marker==='first'),ended=json.runtimeLog.records.findIndex(r=>r.kind==='session.end');assert.ok(marker>=0);assert.equal(ended,marker+1);
  await f.log.close();
});
test('no-append Adapter writes one valid JSON file within the configured byte limit',async()=>{
  const f=fixture({maxBuffered:256*1024});delete f.adapter.append;
  for(let i=0;i<20;i++)f.log.record('user',{event:'click',index:i});
  const result=await f.log.exportDiagnostic({schema:1,activeReaderCount:0},'Diagnostics/run.json',f.adapter.write,250,12000);
  const json=JSON.parse(f.files.get('Diagnostics/run.json'));
  assert.equal(json.runtimeLog.recordCount,21);assert.equal(json.runtimeLog.records.filter(r=>r.kind==='user').length,20);
  assert.equal(result.bytes,Buffer.byteLength(f.files.get('Diagnostics/run.json')));
  assert.ok(result.bytes<=12000);assert.deepEqual([...f.files.keys()].filter(p=>p.includes('run.part-')),[]);await f.log.close();
});

test('large diagnostic exports compact high-frequency events and stay below 19.99 MB',async()=>{
  const f=fixture({maxBuffered:8*1024*1024,partLimit:8*1024*1024});
  for(let i=0;i<300;i++)f.log.record('performance',{fn:'PdfSyncHost.save',saveTransactionId:`tx-${i}`,detail:'x'.repeat(500)});
  for(let i=0;i<1200;i++)f.log.record('user',{event:'pointermove',seq:i,pointerType:'pen',x:i,y:i});
  f.log.record('function.error',{fn:'Viewer.saveOneRevision',error:{name:'Error',message:'late operation capture failure'}});
  const result=await f.log.exportDiagnostic({schema:1,version:'0.7.1',activeReaderCount:1},'Diagnostics/compact.json',f.adapter.write,1024,15000);
  const text=f.files.get('Diagnostics/compact.json'), json=JSON.parse(text);
  assert.ok(Buffer.byteLength(text)<=15000);assert.ok(result.bytes<=15000);
  assert.ok(json.runtimeLog.filteredRecordCount>=1190);
  assert.ok(json.runtimeLog.sizeOmittedRecordCount>0);
  assert.ok(json.runtimeLog.errorAnalysis.grouped.some(row=>row.message==='late operation capture failure'));
  assert.equal(json.runtimeLog.maxBytes,15000);assert.equal(result.complete,false);await f.log.close();
});

test('diagnostic collection calls survive runtime-log compaction',async()=>{
  const f=fixture();
  f.log.record('function.end',{fn:'Viewer.sendDiagnostics',durationMs:4});
  f.log.record('function.end',{fn:'Viewer.unrelatedLayout',durationMs:8});
  f.log.record('user',{event:'pointermove',seq:2});
  await f.log.exportDiagnostic({schema:1},'Diagnostics/diagnostics-call.json',f.adapter.write);
  const json=JSON.parse(f.files.get('Diagnostics/diagnostics-call.json'));
  assert.ok(json.runtimeLog.records.some(row=>row.fn==='Viewer.sendDiagnostics'));
  assert.ok(!json.runtimeLog.records.some(row=>row.fn==='Viewer.unrelatedLayout'));
  await f.log.close();
});

test('default diagnostic JSON limit is 64 MB and accepts exports above the former 19.99 MB cap',async()=>{
  const f=fixture({maxBuffered:32*1024*1024,partLimit:8*1024*1024});
  const detail='z'.repeat(1024);
  for(let i=0;i<22000;i++)f.log.record('performance',{fn:'PdfSyncHost.save',saveTransactionId:`cap-${i}`,detail});
  const result=await f.log.exportDiagnostic({schema:1,version:'0.7.1'},'Diagnostics/default-cap.json',f.adapter.write);
  const text=f.files.get('Diagnostics/default-cap.json'),json=JSON.parse(text);
  assert.ok(result.bytes>19_990_000);assert.ok(Buffer.byteLength(text)>19_990_000);
  assert.ok(result.bytes<=64_000_000);assert.ok(Buffer.byteLength(text)<=64_000_000);
  assert.equal(json.runtimeLog.sizeOmittedRecordCount,0);
  assert.equal(json.runtimeLog.maxBytes,64_000_000);
  await f.log.close();
});
test('current session chunks and errors take priority over large historical logs within the byte budget',async()=>{
  const f=fixture({maxBuffered:2*1024*1024,partLimit:250});
  const currentSession=f.log.path.split('/').at(-1).replace(/-\d{3}\.log$/,'');
  f.log.record('function.error',{fn:'Current.first',error:{name:'Error',message:'current-first-error'}});
  await f.log.flush();
  f.log.record('user',{event:'click',marker:'current-middle'});
  await f.log.flush();
  f.log.record('function.error',{fn:'Current.latest',error:{name:'Error',message:'current-latest-error'}});
  await f.log.flush();

  const newerPrefix='.obsidian/plugins/test/.logs/2026-10-15T00-00-00-000Z-newer-';
  const olderPrefix='.obsidian/plugins/test/.logs/2026-10-14T00-00-00-000Z-older-';
  const history=Array.from({length:100},(_,index)=>JSON.stringify({
    time:`2026-10-15T00:00:${String(index%60).padStart(2,'0')}.000Z`,
    kind:'function.error',fn:`History.failure${index}`,
    error:{name:'Error',message:`historical-error-${index}`},padding:'h'.repeat(1200),
  })).join('\n')+'\n';
  f.files.set(newerPrefix+'000.log',history);
  f.files.set(olderPrefix+'000.log',JSON.stringify({kind:'performance',fn:'Old.performance',marker:'older-session'})+'\n');

  const result=await f.log.exportDiagnostic({schema:1},'Diagnostics/priority.json',f.adapter.write,1024,80_000);
  const text=f.files.get('Diagnostics/priority.json'),json=JSON.parse(text),sources=json.runtimeLog.sources;
  const currentSources=sources.filter(source=>source.file.startsWith(`${currentSession}-`));
  assert.deepEqual(currentSources.map(source=>Number(source.file.match(/-(\d+)\.log$/)[1])),[2,1,0]);
  assert.ok(currentSources.every(source=>source.recordCount>0));
  assert.deepEqual(currentSources.map(source=>source.recordOffset),[0,1,2]);
  const historicalSources=sources.filter(source=>!source.file.startsWith(`${currentSession}-`));
  assert.deepEqual(historicalSources.map(source=>source.file),[newerPrefix.split('/').at(-1)+'000.log',olderPrefix.split('/').at(-1)+'000.log']);
  const records=json.runtimeLog.records;
  const indexOf=predicate=>records.findIndex(predicate);
  assert.ok(indexOf(row=>row.fn==='Current.latest')<indexOf(row=>row.marker==='current-middle'));
  assert.ok(indexOf(row=>row.marker==='current-middle')<indexOf(row=>row.kind==='session.start'));
  assert.ok(indexOf(row=>row.kind==='session.start')<indexOf(row=>row.fn==='Current.first'));
  const groupedMessages=json.runtimeLog.errorAnalysis.grouped.map(row=>row.message);
  assert.ok(groupedMessages.includes('current-first-error'));
  assert.ok(groupedMessages.includes('current-latest-error'));
  assert.ok(json.runtimeLog.sizeOmittedRecordCount>0);
  assert.ok(result.bytes<=80_000);
  assert.equal(result.bytes,Buffer.byteLength(text));
  assert.equal(json.runtimeLog.maxBytes,80_000);
  await f.log.close();
});
test('malformed records and missing files produce valid JSON with explicit incomplete evidence',async()=>{
  const f=fixture();const bad='.obsidian/plugins/test/.logs/2026-10-13T00-00-00-000Z-old-000.log';f.files.set(bad,'{"kind":"user"}\n{"incomplete":');
  await f.log.exportDiagnostic({schema:1},'Diagnostics/run.json',f.adapter.write);
  const json=JSON.parse(f.files.get('Diagnostics/run.json'));assert.equal(json.runtimeLog.complete,false);assert.equal(json.runtimeLog.readErrorCount,1);
  assert.ok(json.runtimeLog.records.some(r=>r.kind==='log-parse-error'));assert.equal(f.files.get(bad),'\{"kind":"user"}\n{"incomplete":');await f.log.close();
});
test('cross-window promises keep identity, time completion, and ignore overridden then',async()=>{
  const f=fixture(), promise=runInNewContext('Promise.resolve(7)');
  promise.then=()=>{throw Error('do not call instance then');};
  const wrapped=traceFunction(()=>promise,'Core.async',()=>f.log);
  assert.equal(wrapped(),promise);await Promise.prototype.then.call(promise,x=>assert.equal(x,7));
  await f.log.close();assert.ok(f.rows().some(r=>r.fn==='Core.async'&&r.kind==='function.end'));
});
test('diagnostic attachment failure cannot replace the original result',()=>{
  const hostile={get [Symbol.toStringTag](){throw Error('tag');}};
  assert.equal(traceFunction(()=>hostile,'Core.proxy',()=>({begin(){throw Error('logger');}}))(),hostile);
});
test('local log parts append without rereading the existing file, and rotate without deleting',async()=>{
  const f=fixture({partLimit:200});await f.log.flush();f.log.record('user',{event:'click'});await f.log.flush();await f.log.close();
  assert.ok(f.files.size>=2);assert.ok([...f.files.keys()].every(p=>p.endsWith('.log')));
  assert.ok(f.rows().some(r=>r.event==='click'));
});
test('adapters without append use new parts rather than rewriting a complete log',async()=>{
  const f=fixture();delete f.adapter.append;await f.log.flush();f.log.record('user',{event:'scroll'});await f.log.flush();await f.log.close();assert.equal(f.files.size,3);
});
test('one stalled writer does not enqueue unbounded flushes; overflow is explicit',async()=>{
  const f=fixture({maxBuffered:600});let release;f.adapter.write=async(p,s)=>{await new Promise(r=>release=r);f.files.set(p,s);};
  const writing=f.log.flush();await new Promise(r=>setImmediate(r));
  for(let i=0;i<100;i++){f.log.record('user',{event:'pointermove'});assert.equal(f.log.flush(),writing);}
  release();await writing;f.adapter.write=async(p,s)=>f.files.set(p,s);await f.log.close();assert.ok(f.rows().some(r=>r.kind==='log-loss'&&r.dropped>0));
});
test('write failure is reported and a later successful part records log loss',async()=>{
  const f=fixture();const original=f.adapter.write;f.adapter.write=async()=>{throw Error('disk full');};
  assert.equal(await f.log.flush(),false);assert.equal(f.log.lastWriteError.message,'disk full');f.adapter.write=original;
  assert.equal(await f.log.flush(),true);await f.log.close();assert.ok(f.rows().some(r=>r.kind==='log-loss'));
});
test('Viewer runtime logging samples hot input events and synchronous drain removes the final batch',async()=>{
  const source=await readFile(new URL('../viewer-adapter/obsidian-bridge.js',import.meta.url),'utf8');
  const listeners=new Map(), messages=[];
  const window={parent:{postMessage:m=>messages.push(m)},addEventListener:(n,f)=>listeners.set(n,f),removeEventListener:n=>listeners.delete(n)};
  const context={window,document:{currentScript:{dataset:{token:'test',rendererGeneration:'test'}},baseURI:'https://fixture.test/web/bridge.js'},URL,performance:{now:()=>10},setInterval:()=>1,clearInterval:()=>{},console:{error(){},warn(){}}};
  runInNewContext(source.slice(0,source.indexOf('  function postToHost('))+'globalThis.testLog={runtimeLogClose,runtimeLogTake};})();',context);
  const pointerMove=listeners.get('pointermove'),wheel=listeners.get('wheel');
  for(let index=0;index<1024;index++)pointerMove({type:'pointermove',target:{tagName:'DIV'},pointerType:'mouse',clientX:index,clientY:index,isTrusted:true});
  for(let index=0;index<128;index++)wheel({type:'wheel',target:{tagName:'DIV'},deltaY:index,isTrusted:true});
  listeners.get('pointerdown')({type:'pointerdown',target:{id:'editorInkButton'},pointerType:'pen',isTrusted:false});
  listeners.get('pointerup')({type:'pointerup',target:{id:'editorInkButton'},pointerType:'pen',isTrusted:false});
  listeners.get('keydown')({type:'keydown',target:{tagName:'TEXTAREA'},key:'😀',isTrusted:false});
  const rows=context.testLog.runtimeLogTake().map(JSON.parse);
  assert.equal(rows.find(row=>row.kind==='viewer.start')?.highFrequencyInputSampleEvery,64);
  assert.equal(rows.filter(r=>r.kind==='user'&&r.event==='pointermove').length,16);
  assert.equal(rows.filter(r=>r.kind==='user'&&r.event==='wheel').length,2);
  assert.ok(rows.some(r=>r.kind==='user'&&r.pointerType==='pen'&&r.trusted===false));
  assert.ok(rows.some(r=>r.event==='keydown'&&r.key==='character'));
  assert.equal(rows.filter(r=>r.kind==='user'&&r.event==='pointerup').length,1,'terminal input events remain unsampled');
  assert.ok(!JSON.stringify(rows).includes('😀'));
  assert.equal(context.testLog.runtimeLogTake().length,0);
  context.testLog.runtimeLogClose();context.testLog.runtimeLogClose();await Promise.resolve();
  assert.equal(listeners.size,0);assert.equal(messages.length,1);
});

test('host session event observation samples wheel and pointer movement without sampling discrete input',async()=>{
  const f=fixture(),listeners=new Map(),target={
    addEventListener(name,listener){const values=listeners.get(name)||[];values.push(listener);listeners.set(name,values);},
    removeEventListener(name,listener){listeners.set(name,(listeners.get(name)||[]).filter(value=>value!==listener));},
  };
  f.log.observe(target,'host');
  for(let index=0;index<1024;index++)for(const listener of listeners.get('pointermove')||[])listener({type:'pointermove',target:{tagName:'DIV'},clientX:index,isTrusted:true});
  for(let index=0;index<128;index++)for(const listener of listeners.get('wheel')||[])listener({type:'wheel',target:{tagName:'DIV'},deltaY:index,isTrusted:true});
  for(const listener of listeners.get('pointerup')||[])listener({type:'pointerup',target:{tagName:'DIV'},isTrusted:true});
  await f.log.flush();
  const users=f.rows().filter(row=>row.kind==='user');
  assert.equal(f.rows().find(row=>row.kind==='session.start')?.highFrequencyInputSampleEvery,64);
  assert.equal(users.filter(row=>row.event==='pointermove').length,16);
  assert.equal(users.filter(row=>row.event==='wheel').length,2);
  assert.equal(users.filter(row=>row.event==='pointerup').length,1);
  await f.log.close();
});
