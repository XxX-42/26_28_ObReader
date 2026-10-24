#!/usr/bin/env node
// Isolated benchmark only. No Vault is opened, no existing app is attached.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve(import.meta.dirname,'../..');
const output = path.join(root,'tests/output/sqlite-native-standard-final-owned');
await mkdir(output,{recursive:true});
const assets=path.join(root,'tests/artifacts/sqlite-opfs-2026-10-23');
const runtime=path.join(assets,'runtime/sqlite-wasm-3540100/jswasm');
const js=await readFile(path.join(runtime,'sqlite3.js'),'utf8');
const proxy=await readFile(path.join(runtime,'sqlite3-opfs-async-proxy.js'),'utf8');
const wasm=(await readFile(path.join(runtime,'sqlite3.wasm'))).toString('base64');
const database=await readFile(path.join(assets,'ecdict-v2-lean.sqlite'));
const databaseHash=createHash('sha256').update(database).digest('hex');
assert.equal(databaseHash,'f48018379b7493062c79d79ee2ab3eebb5e38385c68bc6978503bb02dc45eb5c');
const bytes=database.toString('base64');
await writeFile(path.join(output,'plan.json'),JSON.stringify({trials:5,warmQueriesPerTrial:20,variant:'standard-opfs',databaseHash,databaseBytes:database.length,origin:'app://obsidian.md',profile:'fresh ordinary persistent per process',comparators:'unpaired; not rerun'},null,2)+'\n');
const reports=[];
async function realmSetup({js,proxy,wasm,trial}) {
 if(location.origin!=='app://obsidian.md'||globalThis.app?.vault)throw Error('wrong origin or Vault opened');
 // Official OPFS proxy appends ?vfs=opfs to its script URL. Blob URLs cannot
 // retain that query, so adapt packaging only: remove query at construction,
 // and supply the identical known vfs argument inside the proxy source.
 const seam='new URL(globalThis.location.href).searchParams';
 if(proxy.split(seam).length!==2)throw Error('proxy packaging seam changed');
 const proxyUrl=URL.createObjectURL(new Blob([proxy.replace(seam,"new URL('https://benchmark.invalid/?vfs=opfs').searchParams")],{type:'text/javascript'}));
 if(js.split('opfsUtil.proxyUri = \"sqlite3-opfs-async-proxy.js\";').length!==2)throw Error('runtime packaging seam changed');
 const runtimeJs=js.replace('opfsUtil.proxyUri = "sqlite3-opfs-async-proxy.js";',`opfsUtil.proxyUri = ${JSON.stringify(proxyUrl)};`);
 const source=`const NativeWorker=Worker;globalThis.Worker=class extends NativeWorker{constructor(url,...args){super(String(url).startsWith('blob:')?String(url).split('?')[0]:url,...args);}};globalThis.sqlite3ApiConfig={disable:{vfs:{'opfs-sahpool':true,'opfs-wl':true}}};\n${runtimeJs}\nlet s,d;onmessage=async(e)=>{const {id,action,bytes}=e.data;try{let result;switch(action){case 'init':{const start=performance.now();const binary=Uint8Array.from(atob(${JSON.stringify(wasm)}),c=>c.charCodeAt(0));const m=await WebAssembly.compile(binary);sqlite3InitModule.__isUnderTest=true;s=await sqlite3InitModule({instantiateWasm(i,cb){const x=new WebAssembly.Instance(m,i);cb(x,m);return x.exports;}});if(!s.oo1.OpfsDb)throw Error('standard OPFS VFS unavailable');result={initMs:performance.now()-start,vfsList:s.capi.sqlite3_js_vfs_list(),origin:location.origin,crossOriginIsolated,sharedArrayBuffer:typeof SharedArrayBuffer};break;}case 'copy':{const start=performance.now();await s.opfs.importDb('/standard-${trial}.sqlite',new Uint8Array(bytes));d=new s.oo1.OpfsDb('/standard-${trial}.sqlite','r');result={copyOpenMs:performance.now()-start};break;}case 'open':{const start=performance.now();d=new s.oo1.OpfsDb('/standard-${trial}.sqlite','r');result={openMs:performance.now()-start};break;}case 'query':{const start=performance.now();const rows=[];d.exec({sql:'SELECT key,translation,phonetic FROM entries WHERE key=?',bind:['on'],rowMode:'object',resultRows:rows});result={ms:performance.now()-start,row:rows[0]};break;}case 'validate':result={count:d.selectValue('SELECT count(*) FROM entries'),integrity:d.selectValue('PRAGMA integrity_check')};break;}postMessage({id,result});}catch(e){postMessage({id,error:{name:e.name,message:e.message}});}}`;
 const workerUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
 const worker=new Worker(workerUrl);let seq=0;const pending=new Map();
 worker.onmessage=e=>{const x=pending.get(e.data.id);if(!x)return;pending.delete(e.data.id);clearTimeout(x.timer);e.data.error?x.reject(e.data.error):x.resolve(e.data.result);};
 worker.onerror=e=>{for(const x of pending.values()){clearTimeout(x.timer);x.reject({name:'WorkerError',message:e.message});}pending.clear();};
 globalThis.__ownedStandard={worker,call(action,buffer){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject,timer:setTimeout(()=>reject({name:'Timeout',message:action}),20000)});worker.postMessage({id,action,bytes:buffer},buffer?[buffer]:[]);});},close(){worker.terminate();URL.revokeObjectURL(workerUrl);URL.revokeObjectURL(proxyUrl);}};
 return {url:location.href,origin:location.origin,userAgent:navigator.userAgent};
}
for(let trial=1;trial<=5;trial++) {
 const profile=await mkdtemp(path.join(output,'profile-'));
 const child=spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian',[`--user-data-dir=${profile}`,'--remote-debugging-port=0'],{stdio:'ignore'});
 let browser;const report={trial,profile,warm:[]};
 try {
  let port;for(let n=0;n<100;n++){try{port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{}await new Promise(r=>setTimeout(r,100));}
  assert.ok(port);browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});
  let page;for(let n=0;n<100;n++){page=(await browser.pages()).find(p=>p.url()==='app://obsidian.md/starter.html');if(page)break;await new Promise(r=>setTimeout(r,100));}assert.ok(page);
  report.realm=await page.evaluate(realmSetup,{js,proxy,wasm,trial});
  report.primary=await page.evaluate(async({bytes})=>{const p=__ownedStandard;const start=performance.now();const init=await p.call('init');const data=Uint8Array.from(atob(bytes),c=>c.charCodeAt(0));const copy=await p.call('copy',data.buffer);const firstStart=performance.now();const first=await p.call('query');return {init,copy,first,firstRoundTripMs:performance.now()-firstStart,coldStartToResultMs:performance.now()-start};},{bytes});
  report.validation=await page.evaluate(()=>__ownedStandard.call('validate'));
  report.warm=await page.evaluate(async()=>{const rows=[];for(let n=0;n<20;n++){const start=performance.now();const result=await __ownedStandard.call('query');rows.push({...result,roundTripMs:performance.now()-start});}return rows;});
  // A separate page target is explicitly created and its native window identity
  // recorded; do not call a second Worker in the primary page a second window.
  const beforeTargets=new Set(browser.targets());
  report.secondaryCreation=await page.evaluate(async()=>{const remote=require('electron').remote;const current=remote.getCurrentWebContents();const preferences=current.getLastWebPreferences();const win=new remote.BrowserWindow({width:1000,height:760,show:true,webPreferences:preferences});globalThis.__ownedSecondaryWindow=win;await win.loadURL('app://obsidian.md/starter.html');return {method:'existing Electron remote BrowserWindow',primaryWindowId:remote.getCurrentWindow().id,windowId:win.id,inheritedWebPreferences:preferences,primarySession:current.session.getStoragePath(),secondarySession:win.webContents.session.getStoragePath()};});
  assert.equal(report.secondaryCreation.primarySession,report.secondaryCreation.secondarySession,'both windows must share owned persistent session');
  const secondaryTargetObject=await browser.waitForTarget(t=>!beforeTargets.has(t)&&t.url()==='app://obsidian.md/starter.html',{timeout:15000});
  const secondary=await secondaryTargetObject.page();assert.ok(secondary);
  report.windows={primary:{windowId:report.secondaryCreation.primaryWindowId},secondary:{windowId:report.secondaryCreation.windowId},idsFrom:'native Electron BrowserWindow.id'};
  report.secondaryRealm=await secondary.evaluate(realmSetup,{js,proxy,wasm,trial});
  report.secondary=await secondary.evaluate(async()=>{try{const init=await __ownedStandard.call('init');const open=await __ownedStandard.call('open');const query=await __ownedStandard.call('query');return {status:'PASS',init,open,query};}catch(error){return {status:'FAIL',error};}});
  if(report.secondary.status==='PASS'){assert.equal(report.secondary.query.row.key,'on');report.concurrent=await Promise.all([page.evaluate(()=>__ownedStandard.call('query')),secondary.evaluate(()=>__ownedStandard.call('query'))]);}
  report.primaryAfterSecondary=await page.evaluate(()=>__ownedStandard.call('query'));
  assert.equal(report.primaryAfterSecondary.row.key,'on');
  assert.notEqual(report.windows.primary.windowId,report.windows.secondary.windowId,'secondary target must be a real separate native window');
  await secondary.evaluate(()=>__ownedStandard.close());await secondary.close();await page.evaluate(()=>__ownedStandard.close());
 }catch(error){report.error={name:error.name,message:error.message||JSON.stringify(error)};}
 finally{if(browser)await browser.close();else child.kill();}
 reports.push(report);await writeFile(path.join(output,`trial-${trial}.json`),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({trial,primary:report.primary?.first,secondary:report.secondary,error:report.error,windows:report.windows}));
}
await writeFile(path.join(output,'raw.json'),JSON.stringify(reports,null,2)+'\n');
