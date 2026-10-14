import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { PDFDocument, PDFName } from 'pdf-lib';
import { nativeConfig, assertNativeVaultIdentity } from './native-config.mjs';
import { seedLegacyDelta } from './native-legacy-delta-fixture.mjs';
const {vault,configDir,cdpUrl}=nativeConfig;
assert.equal(vault,'/Users/jiajia/Documents/ObReader-Apple-Test');assert.ok(cdpUrl);
const legacyDelta=process.env.NATIVE_LEGACY_DELTA==='1';
const version=process.env.NATIVE_VERSION||'0.5.10',run=`general-${version}-ink-native-${Date.now()}`,prefix=`PDF迁移测试/${run}`,report={run,version,vault,legacyDelta,status:'running',physicalIpadValidated:false,primaryVaultTouched:false,checks:[]};
const pdf=await PDFDocument.create();for(let n=0;n<12;n++){const pg=pdf.addPage([600,780]);pg.drawText(`Synthetic existing annotation test page ${n+1}`,{x:30,y:740,size:15});}const bytes=await pdf.save({useObjectStreams:false}),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
await fs.writeFile(`tests/artifacts/${run}.driver.mjs`,await fs.readFile(import.meta.filename),{flag:'wx'});
const b=await puppeteer.connect({browserURL:cdpUrl,defaultViewport:null});const p=(await b.pages()).find(p=>p.url()==='app://obsidian.md/index.html');assert.ok(p);const c=await p.createCDPSession();let original,failure;
async function identity(){const s=await p.evaluate(()=>({vault:app.vault.adapter.basePath,configDir:app.vault.configDir,version:app.plugins.plugins['pdf-web-reader']?.manifest.version,mobile:!!app.isMobile,views:app.plugins.plugins['pdf-web-reader']?.views.size}));assertNativeVaultIdentity(s);assert.equal(s.version,version);return s;}
async function root(fn,arg){await identity();return p.evaluate(async({source,arg,vault})=>{if(app.vault.adapter.basePath!==vault)throw Error('Wrong Vault');return (0,eval)(`(${source})`)(arg);},{source:fn.toString(),arg,vault});}
async function doc(file,fn,arg){return root(({file,source,arg})=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file);if(!v)throw Error('Own Reader missing');const w=v.iframe.contentWindow;return (0,eval)(`(${source})`)({v,w,d:w.document,a:w.PDFViewerApplication,arg});},{file,source:fn.toString(),arg});}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(last)return last;await pause(50);}throw Error(`${label}: ${JSON.stringify(last)}`);}
async function mode(mobile){assert.equal((await identity()).views,0);await root(async()=>app.workspace.saveLayout());const nav=p.waitForNavigation({waitUntil:'domcontentloaded',timeout:30000});await root(m=>{setTimeout(()=>app.emulateMobile(m),0);},mobile);await nav;await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await p.waitForFunction(wanted=>app?.workspace?.layoutReady&&!!app.plugins.plugins['pdf-web-reader']?.settings&&!!app.isMobile===wanted,{polling:100,timeout:30000},mobile);await identity();}
async function annotationCount(data){const pdf=await PDFDocument.load(data);return (pdf.getPage(0).node.Annots()?.asArray()||[]).filter(ref=>pdf.context.lookup(ref)?.get(PDFName.of('Subtype'))?.toString()==='/Square').length;}

const file=`${prefix}/mixed-ink.pdf`;let legacyFixture;
async function choose(id,modeValue){if(await doc(file,({a,arg})=>a.pdfViewer.annotationEditorMode===arg,modeValue))return;const q=await doc(file,({v,d,arg})=>{const el=d.getElementById(arg),r=el.getBoundingClientRect(),f=v.iframe.getBoundingClientRect();if(!r.width||!r.height||!el.contains(d.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Tool not actually visible: '+arg);return{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};},id);await p.mouse.click(q.x,q.y);await wait('Tool selected',()=>doc(file,({a,arg})=>a.pdfViewer.annotationEditorMode===arg,modeValue));}
async function pen(type,x,y){await c.send('Input.dispatchMouseEvent',{type,x,y,button:type==='mouseMoved'?'none':'left',buttons:type==='mouseReleased'?0:1,pointerType:'pen',force:type==='mouseReleased'?0:.6});}
try{
 await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});original=await identity();assert.equal(original.mobile,false);assert.equal(original.views,0);
 await root(async()=>app.workspace.saveLayout());await mode(true);
 await root(async prefix=>{if(!/^PDF迁移测试\/general-0\./.test(prefix)||app.vault.getAbstractFileByPath(prefix))throw Error('Unsafe fixture');await app.vault.createFolder(prefix);},prefix);
 if(legacyDelta){await identity();legacyFixture=await seedLegacyDelta({vault,configDir,file,base:bytes,run});report.legacyFixture={uuid:legacyFixture.uuid,recovery:legacyFixture.recovery,suffix:legacyFixture.suffix,segmentHash:legacyFixture.segmentHash};}
 await root(({prefix})=>{const original=Worker.prototype.postMessage;window.__inkNative={original,writes:[]};Worker.prototype.postMessage=function(message,...rest){if(message?.method==='prepareLocal'){const payload=message.payload||message.args||{},t=window.__inkNative,index=t.count||0;t.count=index+1;if(index>=40)return original.call(this,message,...rest);t.writes.push((async()=>{const adapter=app.vault.adapter,stem=`${prefix}/rpc-${index}`,meta={operations:payload.operations,newAnnotations:payload.newAnnotations,actorId:payload.actorId};const copy={};for(const name of ['baseBytes','draftBytes','checkpointBytes']){const value=payload[name];if(value)copy[name]=new Uint8Array(value.buffer||value,value.byteOffset||0,value.byteLength).slice().buffer;}for(const[name,value]of Object.entries(copy))await adapter.writeBinary(`${stem}-${name}.pdf`,value);await adapter.write(`${stem}.json`,JSON.stringify(meta));})());}return original.call(this,message,...rest);};},{prefix});
 await root(async({file,bytes})=>{const f=await app.vault.createBinary(file,new Uint8Array(bytes).buffer);await app.plugins.plugins['pdf-web-reader'].openPdf(f);},{file,bytes:[...bytes]});
 await wait('Own PDF ready',()=>doc(file,({v,a})=>v.ready&&a.pdfDocument?.numPages===12));
 if(legacyFixture){
  // The seeded legacy branch causes an initial synchronized refresh. Wait for
  // that actual document to be loaded before injecting an unrelated pen stroke.
  await wait('Legacy branch refresh ready',async()=>{
   const loaded=await doc(file,({v,a,arg})=>v.ready&&a.pdfDocument?.numPages===12&&v.loadedBaseBytes?.byteLength>arg,bytes.length);
   if(!loaded)return false;
   return JSON.parse(await fs.readFile(path.join(vault,legacyFixture.manifest),'utf8')).status==='confirmed';
  });
  const existing=await doc(file,async({a})=>(await(await a.pdfDocument.getPage(10)).getAnnotations()).length);
  assert.equal(existing,1);await legacyFixture.verify();report.initialLegacyAnnotations=existing;
 }
 await doc(file,({w,d,a})=>{w.__penEvents=[];for(const type of ['pointerdown','pointerup','pointercancel'])d.addEventListener(type,e=>w.__penEvents.push({type,pointerType:e.pointerType,trusted:e.isTrusted}));a.pdfViewer.currentScaleValue='page-fit';});
 await pause(300);await doc(file,({a})=>a.pdfViewer.scrollPageIntoView({pageNumber:10}));
 await wait('Page 10 rendered',()=>doc(file,({a,d})=>{const pg=d.querySelector('.page[data-page-number="10"]'),r=pg?.getBoundingClientRect(),v=d.getElementById('viewerContainer').getBoundingClientRect();return a.pdfViewer.currentPageNumber===10&&a.pdfViewer.getPageView(9)?.renderingState===3&&r&&Math.min(r.bottom,v.bottom)-Math.max(r.top,v.top)>200;}));
 for(let round=0;round<4;round++){
  for(let n=0;n<3;n++){
   await choose('editorInkButton',15);
   const q=await doc(file,({v,d,arg})=>{const r=d.querySelector('.page[data-page-number="10"]').getBoundingClientRect(),view=d.getElementById('viewerContainer').getBoundingClientRect(),f=v.iframe.getBoundingClientRect();const x=Math.max(r.left,view.left)+40+arg.n*65,y=Math.max(r.top,view.top)+70+arg.round*60;return{x:x+f.x,y:y+f.y};},{round,n});
   await pen('mousePressed',q.x,q.y);for(let k=1;k<=10;k++)await pen('mouseMoved',q.x+Math.sin(k*.6)*22,q.y+k*3);await pen('mouseReleased',q.x+Math.sin(6)*22,q.y+30);
   await choose('editorHighlightButton',9);await pause(100);
  }
  const q=await doc(file,({v,d,arg})=>{const r=d.querySelector('.page[data-page-number="10"]').getBoundingClientRect(),view=d.getElementById('viewerContainer').getBoundingClientRect(),f=v.iframe.getBoundingClientRect();return{x:f.x+Math.max(r.left,view.left)+35,y:f.y+Math.max(r.top,view.top)+330+arg*12};},round);
  await pen('mousePressed',q.x,q.y);for(let k=1;k<=8;k++)await pen('mouseMoved',q.x+k*5,q.y+k*3);await pen('mouseReleased',q.x+40,q.y+24);
  await choose('editorInkButton',15);
  await pause(200);
  await wait('Actual edited state',()=>doc(file,({v,a})=>v.currentRevision>0&&a.pdfDocument.annotationStorage.size>0));
  const target=await doc(file,({v,a,w})=>({revision:v.currentRevision,confirmed:v.confirmedRevision,entries:[...a.pdfDocument.annotationStorage.serializable.map].map(([id,row])=>({id,type:row.annotationType,page:row.pageIndex,deleted:row.deleted,ref:row.id})),events:w.__penEvents}));report.checks.push({round,target});
  // Await the production Viewer manual-save promise so late Ink commits belong to this check.
  await doc(file,async({a})=>a.save());
  await wait('Ink save confirmed',()=>doc(file,({v,arg})=>{if(v.failureNoticeShown||v.syncFailureShown)throw Error('Production Ink save reported failure');return v.confirmedRevision>=arg&&v.confirmedRevision===v.currentRevision&&v.pendingSaves===0&&!v.iframe.contentWindow.PDFViewerApplication._saveInProgress;},target.revision));
  const roundPdf=await PDFDocument.load(await fs.readFile(path.join(vault,file)));report.checks.at(-1).diskCount=(roundPdf.getPage(9).node.Annots()?.asArray()||[]).length;assert.equal(report.checks.at(-1).diskCount,(round+1)*4+(legacyDelta?1:0));
  if(legacyFixture){await legacyFixture.verify();const state=await (await import('../plugin/pdf-merge-core.cjs')).default.inspect({bytes:await fs.readFile(path.join(vault,file))});assert.ok(state.identities.some(x=>x.uuid===legacyFixture.uuid));}
  report.checks.at(-1).saved=await doc(file,({v,a})=>({revision:v.currentRevision,confirmed:v.confirmedRevision,entries:a.pdfDocument.annotationStorage.size}));
 }
 const disk=await fs.readFile(path.join(vault,file));const loaded=await PDFDocument.load(disk);report.savedAnnotations=(loaded.getPage(9).node.Annots()?.asArray()||[]).map(ref=>({ref:ref.toString(),subtype:loaded.context.lookup(ref).get(PDFName.of('Subtype'))?.toString(),it:loaded.context.lookup(ref).get(PDFName.of('IT'))?.toString()}));
 assert.ok(report.savedAnnotations.length>=12);assert.ok(report.checks[0].target.events.some(e=>e.trusted&&e.pointerType==='pen'));
 const closePoint=await root(file=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file),r=v.leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-close-button').getBoundingClientRect();if(!r.width)throw Error('Real close button missing');return{x:r.x+r.width/2,y:r.y+r.height/2};},file);await p.mouse.click(closePoint.x,closePoint.y);await wait('Edited Reader actually closed',()=>root(file=>![...app.plugins.plugins['pdf-web-reader'].views].some(v=>v.requestedPath===file)&&!app.workspace.getLeavesOfType('pdf-web-reader-view').some(l=>l.view.requestedPath===file),file));report.realCloseButton=true;
 await root(file=>app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(file)),file);
 await wait('Reopened Ink PDF',()=>doc(file,({v,a})=>v.ready&&a.pdfDocument?.numPages===12));
 report.reopenedAnnotations=await doc(file,async({a})=>(await(await a.pdfDocument.getPage(10)).getAnnotations()).map(x=>({id:x.id,type:x.annotationType})));assert.equal(report.reopenedAnnotations.length,report.savedAnnotations.length);
 report.rpcCount=await root(()=>window.__inkNative?.count||0);assert.ok(report.rpcCount<40,'Save/recovery should settle, not repeatedly serialize');report.status='passed';
}catch(e){failure=e;report.status='failed';report.error=e.stack;try{await p.screenshot({path:`tests/artifacts/${run}.png`});report.failureState=await doc(file,({v,a,w})=>({revision:v.currentRevision,confirmed:v.confirmedRevision,page:a.pdfViewer.currentPageNumber,render:a.pdfViewer.getPageView(9)?.renderingState,scroll:w.document.getElementById('viewerContainer').scrollTop,entries:[...(a.pdfDocument.annotationStorage.serializable.map||new Map())].map(([id,row])=>({id,...row})),events:w.__penEvents}));report.recovery=await root(async file=>(await app.plugins.plugins['pdf-web-reader'].listRecoveryCandidates()).filter(r=>r.metadata.originalPath===file||r.metadata.documentPath===file).map(r=>({candidate:r.candidatePath,metadata:r.metadata})),file);}catch(x){report.failureCaptureError=x.message;}}
finally{
 try{await root(async()=>{if(window.__inkNative){await Promise.allSettled(window.__inkNative.writes);Worker.prototype.postMessage=window.__inkNative.original;delete window.__inkNative;}});await root(async prefix=>{for(const v of [...app.plugins.plugins['pdf-web-reader'].views])if(v.requestedPath?.startsWith(prefix+'/'))await v.leaf.detach();await app.workspace.saveLayout();},prefix);await wait('Owned Reader cleanup settled',async()=>(await identity()).views===0);if((await identity()).mobile)await mode(false);report.cleanup=await identity();if(report.cleanup.views||report.cleanup.mobile)throw Error('Own Reader cleanup incomplete');}catch(e){report.cleanupError=e.stack;failure||=e;report.status='failed';}
 await c.send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});b.disconnect();await fs.writeFile(`tests/artifacts/${run}.json`,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(run,report.status);
}
if(failure)throw failure;
