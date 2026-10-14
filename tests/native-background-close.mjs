import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {PDFDocument,PDFName} from 'pdf-lib';
import {nativeConfig,assertNativeVaultIdentity} from './native-config.mjs';
const {vault,configDir,cdpUrl}=nativeConfig;
assert.equal(vault,'/Users/jiajia/Documents/ObReader-Apple-Test');assert.ok(cdpUrl);
const version=process.env.NATIVE_VERSION||'0.5.13';
const run=`general-${version}-background-close-${Date.now()}`,prefix=`PDF迁移测试/${run}`;
const report={run,version,vault,status:'running',physicalIpadValidated:false,primaryVaultTouched:false,checks:[]};
const pdf=await PDFDocument.create();pdf.addPage([600,780]).drawText('Independent background close fixture',{x:25,y:740,size:16});
const bytes=await pdf.save({useObjectStreams:false});
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
await fs.writeFile(`tests/artifacts/${run}.driver.mjs`,await fs.readFile(import.meta.filename),{flag:'wx'});
const b=await puppeteer.connect({browserURL:cdpUrl,defaultViewport:null});
const p=(await b.pages()).find(p=>p.url()==='app://obsidian.md/index.html');assert.ok(p);
const c=await p.createCDPSession();let original,failure;
async function identity(){const s=await p.evaluate(()=>({vault:app.vault.adapter.basePath,configDir:app.vault.configDir,version:app.plugins.plugins['pdf-web-reader']?.manifest.version,mobile:!!app.isMobile,views:app.plugins.plugins['pdf-web-reader']?.views.size}));assertNativeVaultIdentity(s);assert.equal(s.version,version);return s;}
async function root(fn,arg){await identity();return p.evaluate(async({source,arg,vault})=>{if(app.vault.adapter.basePath!==vault)throw Error('Wrong Vault');return (0,eval)(`(${source})`)(arg);},{source:fn.toString(),arg,vault});}
async function doc(file,fn,arg){return root(({file,source,arg})=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file);if(!v)throw Error('Own Reader missing');const w=v.iframe.contentWindow;return (0,eval)(`(${source})`)({v,w,d:w.document,a:w.PDFViewerApplication,arg});},{file,source:fn.toString(),arg});}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(last)return last;await pause(50);}throw Error(`${label}: ${JSON.stringify(last)}`);}
async function mode(mobile){assert.equal((await identity()).views,0);await root(async()=>app.workspace.saveLayout());const nav=p.waitForNavigation({waitUntil:'domcontentloaded',timeout:30000});await root(m=>{setTimeout(()=>app.emulateMobile(m),0);},mobile);await nav;await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await p.waitForFunction(wanted=>app?.workspace?.layoutReady&&!!app.plugins.plugins['pdf-web-reader']?.settings&&!!app.isMobile===wanted,{polling:100,timeout:30000},mobile);await identity();}
async function count(data){const pdf=await PDFDocument.load(data);return(pdf.getPage(0).node.Annots()?.asArray()||[]).filter(ref=>pdf.context.lookup(ref)?.get(PDFName.of('Subtype'))?.toString()==='/Square').length;}
async function installGate(file,fail){return root(({file,fail})=>{if(window.__backgroundCloseGate)throw Error('Existing gate');let release;const promise=new Promise(r=>release=r);const replies=[];const listener=e=>{const m=e.data;if(m?.channel==='pdf-web-reader'&&m.type==='close-prepared')replies.push({documentId:m.documentId,openRequest:m.openRequest,revision:m.revision,recovered:m.recovered,prepared:m.prepared,queued:m.closeWritebackQueued});};window.addEventListener('message',listener);const v=app.vault;const state={file,fail,replies,listener,released:false,calls:[],originalModify:v.modifyBinary,originalAppend:v.appendBinary,release:()=>{state.released=true;release();}};for(const[key,original]of[['modifyBinary',v.modifyBinary],['appendBinary',v.appendBinary]])if(original)v[key]=async function(f,...args){if(f.path===file){state.calls.push({method:key,at:performance.now()});await promise;if(fail)throw Error('Owned background write fault');}return original.call(this,f,...args);};window.__backgroundCloseGate=state;},{file,fail});}
async function releaseGate(){return root(()=>{const s=window.__backgroundCloseGate;if(s)s.release();});}
async function restoreGate(){return root(()=>{const s=window.__backgroundCloseGate;if(!s)return;s.release();window.removeEventListener('message',s.listener);app.vault.modifyBinary=s.originalModify;app.vault.appendBinary=s.originalAppend;delete window.__backgroundCloseGate;});}
async function draw(file,offset=0){
 const previousCount=await doc(file,({a})=>[...(a.pdfDocument.annotationStorage.serializable.map||new Map()).values()].filter(e=>e.annotationType===5&&!e.deleted).length);
 const tool=await doc(file,({v,d})=>{const el=d.getElementById('editorSquareButton'),r=el.getBoundingClientRect(),f=v.iframe.getBoundingClientRect();if(!r.width)throw Error('Tool hidden');return{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};});if(!await doc(file,({a})=>a.pdfViewer.annotationEditorMode===5))await p.mouse.click(tool.x,tool.y);
 await wait('Square selected',()=>doc(file,({a})=>a.pdfViewer.annotationEditorMode===5));
 const point=await doc(file,({v,d,arg})=>{const r=d.querySelector('.page[data-page-number="1"]').getBoundingClientRect(),view=d.getElementById('viewerContainer').getBoundingClientRect(),f=v.iframe.getBoundingClientRect();const x=Math.max(r.left,view.left)+40+arg,y=Math.max(r.top,view.top)+150+arg;if(!d.elementFromPoint(x,y)?.closest('.page[data-page-number="1"]'))throw Error('Draw point not on PDF');return{x:f.x+x,y:f.y+y};},offset);
 await p.mouse.move(point.x,point.y);await p.mouse.down();await p.mouse.move(point.x+65,point.y+40,{steps:5});await p.mouse.up();
 await wait('Real edit revision',()=>doc(file,({a,arg})=>[...(a.pdfDocument.annotationStorage.serializable.map||new Map()).values()].filter(e=>e.annotationType===5&&!e.deleted).length>arg,previousCount));
}
try{
 await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});original=await identity();assert.equal(original.mobile,false);assert.equal(original.views,0);
 assert.equal(await root(()=>app.plugins.plugins['pdf-web-reader'].settings.autoSave),true);
 for(const name of ['main.js','manifest.json','styles.css'])assert.deepEqual(await fs.readFile(path.join(vault,configDir,'plugins/pdf-web-reader',name)),await fs.readFile(`dist/pdf-web-reader/${name}`));
 await root(async prefix=>{if(app.vault.getAbstractFileByPath(prefix))throw Error('Existing fixture');await app.vault.createFolder(prefix);},prefix);
 for(const mobile of [false,true]){
  if(mobile)await mode(true);
  for(const kind of ['fresh-close','in-flight','write-failure']){
   const file=`${prefix}/${mobile?'mobile':'desktop'}-${kind}.pdf`,row={mobile,kind,file};report.checks.push(row);
   await root(async({file,bytes})=>{const f=await app.vault.createBinary(file,new Uint8Array(bytes).buffer);await app.plugins.plugins['pdf-web-reader'].openPdf(f);},{file,bytes:[...bytes]});
   await wait('PDF rendered',()=>doc(file,({v,a})=>v.ready&&a.pdfViewer.getPageView(0)?.renderingState===3));
   await doc(file,({a,d})=>{a.pdfViewer.currentScaleValue='page-fit';d.getElementById('viewerContainer').scrollTop=0;});
   await wait('Visible page',()=>doc(file,({a,d})=>{const r=d.querySelector('.page[data-page-number="1"]')?.getBoundingClientRect(),v=d.getElementById('viewerContainer').getBoundingClientRect();return r&&a.pdfViewer.getPageView(0)?.renderingState===3&&Math.min(r.bottom,v.bottom)-Math.max(r.top,v.top)>240;}));
   await installGate(file,kind==='write-failure');await draw(file);
   if(kind==='in-flight'){
    await doc(file,({a})=>{void a.save().catch(()=>{});});
    await wait('Host write is in flight',()=>root(()=>window.__backgroundCloseGate.calls.length>0));
    await draw(file,100);
   }
   row.before=await doc(file,({v})=>({documentId:v.documentId,openRequest:v.openRequest,revision:v.currentRevision,confirmed:v.confirmedRevision}));
   const point=await root(file=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file),r=v.leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-close-button').getBoundingClientRect();if(!r.width)throw Error('Close hidden');return{x:r.x+r.width/2,y:r.y+r.height/2};},file);
   const start=performance.now();if(mobile){await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:73,radiusX:3,radiusY:3,force:1}]});await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}else await p.mouse.click(point.x,point.y);
   await wait('Tab closes while source write is blocked',()=>root(file=>![...app.plugins.plugins['pdf-web-reader'].views].some(v=>v.requestedPath===file)&&!app.workspace.getLeavesOfType('pdf-web-reader-view').some(l=>l.view.requestedPath===file),file));
   row.closeMs=performance.now()-start;
   row.gate=await root(()=>({released:window.__backgroundCloseGate.released,calls:window.__backgroundCloseGate.calls}));assert.equal(row.gate.released,false);
   row.closeAck=await root(({documentId,openRequest})=>window.__backgroundCloseGate.replies.find(r=>r.documentId===documentId&&r.openRequest===openRequest),row.before);assert.ok(row.closeAck?.recovered&&row.closeAck.prepared&&row.closeAck.queued);assert.ok(row.closeAck.revision>=row.before.revision);
   assert.equal(hash(await fs.readFile(path.join(vault,file))),hash(bytes));
   row.recovery=await root(async file=>{const plugin=app.plugins.plugins['pdf-web-reader'],records=(await plugin.listRecoveryCandidates()).filter(r=>r.metadata.originalPath===file);return Promise.all(records.map(async r=>({metadata:r.metadata,data:[...new Uint8Array(await plugin.readRecoveryBytes(r))]})));},file);
   assert.ok(row.recovery.some(r=>r.metadata.completed&&r.metadata.origin==='recovery'&&r.metadata.reason==='close-writeback'&&r.metadata.revision===row.closeAck.revision));
   const latest=row.recovery.find(r=>r.metadata.completed&&r.metadata.origin==='recovery'&&r.metadata.reason==='close-writeback'&&r.metadata.revision===row.closeAck.revision);assert.equal(await count(new Uint8Array(latest.data)),kind==='in-flight'?2:1);
   row.progressText=await root(()=>document.body.innerText.split('\n').filter(x=>/PDF\s*后台写回|PDF\s*写回\s*\d/.test(x)).slice(-15));assert.ok(row.progressText.length,'Progress visible after Reader removed');
   row.jobsAtClose=await root(file=>[...app.plugins.plugins['pdf-web-reader'].closeWritebackJobs.values()].filter(j=>j.originalPath===file),file);assert.ok(row.jobsAtClose.some(j=>['queued','waiting-for-writer','preparing','merging','write-invoked'].includes(j.status)), 'Actual background job is registered and active');
   // Preserve the exact recovery proof before a successful job cleans its own candidate.
   await fs.writeFile(`tests/artifacts/${run}-${mobile?'mobile':'desktop'}-${kind}-recovery.pdf`,new Uint8Array(latest.data),{flag:'wx'});
   row.recovery=row.recovery.map(({metadata,data})=>({metadata,length:data.length,sha256:hash(new Uint8Array(data))}));
   await wait('Source write remains held after tab removal',()=>root(()=>window.__backgroundCloseGate.calls.length>0&&!window.__backgroundCloseGate.released));
   row.blockedAfterClose=await root(()=>({released:window.__backgroundCloseGate.released,calls:window.__backgroundCloseGate.calls}));
   assert.equal(hash(await fs.readFile(path.join(vault,file))),hash(bytes));
   await releaseGate();await root(async()=>{await app.plugins.plugins['pdf-web-reader'].saveQueue;});
   if(kind==='write-failure'){
    await wait('Failed background job settles with recovery',()=>root(async file=>{const p=app.plugins.plugins['pdf-web-reader'];return [...p.closeWritebackJobs.values()].some(j=>j.originalPath===file&&['paused','conflict'].includes(j.status))&&(await p.listRecoveryCandidates()).some(r=>r.metadata.originalPath===file&&r.metadata.completed);},file));
    assert.equal(hash(await fs.readFile(path.join(vault,file))),hash(bytes));
    row.failureProgress=await root(()=>document.body.innerText.split('\n').filter(x=>/失败|暂停|恢复/.test(x)).slice(-15));assert.ok(row.failureProgress.length);
    row.failedJobs=await root(file=>[...app.plugins.plugins['pdf-web-reader'].closeWritebackJobs.values()].filter(j=>j.originalPath===file),file);assert.ok(row.failedJobs.some(j=>['paused','conflict'].includes(j.status)));
   }else{
    await wait('Background write finishes',async()=>await count(await fs.readFile(path.join(vault,file)))===(kind==='in-flight'?2:1));
    await root(async file=>{await app.plugins.plugins['pdf-web-reader'].pdfSync.waitForCloseWriteback(file);},file);
    row.closedBaselineRetained=await root(file=>app.plugins.plugins['pdf-web-reader'].documentBaselines.has(file),file);assert.equal(row.closedBaselineRetained,false,'Closed PDF bytes are not reinserted into plugin baseline memory');
    await root(file=>app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(file)),file);
    await wait('Reopened document',()=>doc(file,({v,a})=>v.ready&&a.pdfViewer.getPageView(0)?.renderingState===3));
    row.reopened=await doc(file,async({a})=>(await(await a.pdfDocument.getPage(1)).getAnnotations()).length);assert.equal(row.reopened,kind==='in-flight'?2:1);
    await root(async file=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file);await v.leaf.detach();},file);
    await wait('Reopened test view closed',async()=>(await identity()).views===0);
   }
   await restoreGate();row.status='passed';
  }
 }
 report.status='passed';
}catch(e){failure=e;report.status='failed';report.error=e.stack;try{await p.screenshot({path:`tests/artifacts/${run}.png`});report.failureReaders=await root(()=>[...app.plugins.plugins['pdf-web-reader'].views].map(v=>({path:v.requestedPath,revision:v.currentRevision,confirmed:v.confirmedRevision,closing:!!v.closePreparation,prepared:!!v.preparedClose})));}catch(x){report.captureError=x.message;}}
finally{
 try{await releaseGate();await root(async()=>{await app.plugins.plugins['pdf-web-reader'].saveQueue;});await restoreGate();await root(async prefix=>{for(const v of [...app.plugins.plugins['pdf-web-reader'].views])if(v.requestedPath?.startsWith(prefix+'/'))await v.leaf.detach();await app.workspace.saveLayout();},prefix);await wait('Owned views cleaned',async()=>(await identity()).views===0);if((await identity()).mobile)await mode(false);report.cleanup=await identity();assert.equal(report.cleanup.views,0);assert.equal(report.cleanup.mobile,false);}catch(e){report.cleanupError=e.stack;failure||=e;report.status='failed';}
 await c.send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});b.disconnect();await fs.writeFile(`tests/artifacts/${run}.json`,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(run,report.status);
}
if(failure)throw failure;
