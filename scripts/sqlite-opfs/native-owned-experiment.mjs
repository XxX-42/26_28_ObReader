#!/usr/bin/env node
// Benchmark-only: launch Obsidian with a newly-owned ordinary persistent profile,
// probe its real app origin without opening any Vault. Never connect to an existing app.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, 'tests/output/sqlite-native-owned');
await mkdir(output, {recursive:true});
const assets = path.join(root, 'tests/artifacts/sqlite-opfs-2026-10-23');
const js = await readFile(path.join(assets,'runtime/sqlite-wasm-3540100/jswasm/sqlite3.js'),'utf8');
const wasm = (await readFile(path.join(assets,'runtime/sqlite-wasm-3540100/jswasm/sqlite3.wasm'))).toString('base64');
const bytes = (await readFile(path.join(assets,'ecdict-v2-lean.sqlite'))).toString('base64');
const reports=[];
for(let trial=1;trial<=5;trial++) {
 const profile=await mkdtemp(path.join(output, 'profile-'));
 const child=spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian',[`--user-data-dir=${profile}`,'--remote-debugging-port=0'],{stdio:'ignore'});
 let browser;
 try {
  let port;
  for(let n=0;n<100;n++){try {port=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break;}catch{} await new Promise(r=>setTimeout(r,100));}
  assert.ok(port);browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});
  let page;
  for(let n=0;n<100;n++){page=(await browser.pages()).find(p=>p.url()==='app://obsidian.md/starter.html');if(page)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(page,'fresh profile must expose only starter page');
  const report=await page.evaluate(async ({js,wasm,bytes,trial})=>{
   if(location.origin!=='app://obsidian.md'||globalThis.app?.vault)throw Error('wrong origin or Vault opened');
   const source=`globalThis.sqlite3ApiConfig={disable:{vfs:{opfs:true,'opfs-wl':true}}};\n${js}\nlet s,p,d;onmessage=async(e)=>{const {id,action,bytes}=e.data;try{let result;switch(action){case 'init':{const start=performance.now();const binary=Uint8Array.from(atob(${JSON.stringify(wasm)}),c=>c.charCodeAt(0));const m=await WebAssembly.compile(binary);s=await sqlite3InitModule({instantiateWasm(i,cb){const x=new WebAssembly.Instance(m,i);cb(x,m);return x.exports;}});p=await s.installOpfsSAHPoolVfs({name:'owned-native-'+${trial},initialCapacity:2});result={initMs:performance.now()-start,vfs:p.vfsName,origin:location.origin};break;}case 'copy':{const start=performance.now();p.importDb('/copy.sqlite',new Uint8Array(bytes));d=new p.OpfsSAHPoolDb('/copy.sqlite','r');result={copyOpenMs:performance.now()-start};break;}case 'query':{const start=performance.now();const rows=[];d.exec({sql:'SELECT key,translation,phonetic FROM entries WHERE key=?',bind:['on'],rowMode:'object',resultRows:rows});result={ms:performance.now()-start,row:rows[0]};break;}case 'validate':{result={count:d.selectValue('SELECT count(*) FROM entries'),integrity:d.selectValue('PRAGMA integrity_check')};break;}}postMessage({id,result});}catch(e){postMessage({id,error:{name:e.name,message:e.message}});}}`;
   const workerUrl=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
   function client(){const worker=new Worker(workerUrl);let seq=0;const calls=new Map();worker.onmessage=e=>{const x=calls.get(e.data.id);if(!x)return;calls.delete(e.data.id);clearTimeout(x.timer);e.data.error?x.reject(e.data.error):x.resolve(e.data.result);};return {worker,call(action,bytes){return new Promise((resolve,reject)=>{const id=++seq;calls.set(id,{resolve,reject,timer:setTimeout(()=>reject({name:'Timeout',message:action}),15000)});worker.postMessage({id,action,bytes},bytes?[bytes]:[]);});}};}
   const primary=client();const result={trial,origin:location.origin,url:location.href,userAgent:navigator.userAgent,ordinaryPersistentProfile:true,crossOriginIsolated,mainOpfs:typeof navigator.storage?.getDirectory==='function',warm:[]};
   try {const start=performance.now();result.init=await primary.call('init');const data=Uint8Array.from(atob(bytes),c=>c.charCodeAt(0));result.copy=await primary.call('copy',data.buffer);const first=performance.now();result.first=await primary.call('query');result.firstRoundTripMs=performance.now()-first;result.coldStartToResultMs=performance.now()-start;result.validation=await primary.call('validate');for(let n=0;n<20;n++){const q=performance.now();const row=await primary.call('query');result.warm.push({roundTripMs:performance.now()-q,...row});}const secondary=client();try{result.secondary=await secondary.call('init');}catch(error){result.secondary={error};}finally{secondary.worker.terminate();}}catch(error){result.error=error;}finally{primary.worker.terminate();URL.revokeObjectURL(workerUrl);}return result;
  },{js,wasm,bytes,trial});
  report.profile=profile;reports.push(report);
  await writeFile(path.join(output,`trial-${trial}.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({trial,cold:report.coldStartToResultMs,secondary:report.secondary,error:report.error}));
 }finally{if(browser)await browser.close();else child.kill();}
}
await writeFile(path.join(output,'raw.json'),JSON.stringify(reports,null,2)+'\n');
