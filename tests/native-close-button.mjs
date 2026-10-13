import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { PDFDocument, PDFName } from 'pdf-lib';
import { nativeConfig, assertNativeVaultIdentity } from './native-config.mjs';
const {vault,configDir,cdpUrl}=nativeConfig;
assert.equal(vault,'/Users/jiajia/Documents/ObReader-Apple-Test');assert.ok(cdpUrl);
const version='0.5.8',run=`general-${version}-close-native-${Date.now()}`,prefix=`PDF迁移测试/${run}`,report={run,version,vault,status:'running',physicalIpadValidated:false,primaryVaultTouched:false,checks:[]};
const bytes=await fs.readFile('tests/fixtures/tracemonkey.pdf'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
await fs.writeFile(`tests/artifacts/${run}.driver.mjs`,await fs.readFile(import.meta.filename),{flag:'wx'});
const b=await puppeteer.connect({browserURL:cdpUrl,defaultViewport:null});const p=(await b.pages()).find(p=>p.url()==='app://obsidian.md/index.html');assert.ok(p);const c=await p.createCDPSession();let original,failure;
async function identity(){const s=await p.evaluate(()=>({vault:app.vault.adapter.basePath,configDir:app.vault.configDir,version:app.plugins.plugins['pdf-web-reader']?.manifest.version,mobile:!!app.isMobile,views:app.plugins.plugins['pdf-web-reader']?.views.size}));assertNativeVaultIdentity(s);assert.equal(s.version,version);return s;}
async function root(fn,arg){await identity();return p.evaluate(async({source,arg,vault})=>{if(app.vault.adapter.basePath!==vault)throw Error('Wrong Vault');return (0,eval)(`(${source})`)(arg);},{source:fn.toString(),arg,vault});}
async function doc(file,fn,arg){return root(({file,source,arg})=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file);if(!v)throw Error('Own Reader missing');const w=v.iframe.contentWindow;return (0,eval)(`(${source})`)({v,w,d:w.document,a:w.PDFViewerApplication,arg});},{file,source:fn.toString(),arg});}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn,timeout=20000){const end=Date.now()+timeout;let last;while(Date.now()<end){last=await fn();if(last)return last;await pause(50);}throw Error(`${label}: ${JSON.stringify(last)}`);}
async function mode(mobile){assert.equal((await identity()).views,0);await root(async()=>app.workspace.saveLayout());const nav=p.waitForNavigation({waitUntil:'domcontentloaded',timeout:30000});await root(m=>{setTimeout(()=>app.emulateMobile(m),0);},mobile);await nav;await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});await p.waitForFunction(wanted=>app?.workspace?.layoutReady&&!!app.plugins.plugins['pdf-web-reader']?.settings&&!!app.isMobile===wanted,{polling:100,timeout:30000},mobile);await identity();}
async function annotationCount(data){const pdf=await PDFDocument.load(data);return (pdf.getPage(0).node.Annots()?.asArray()||[]).filter(ref=>pdf.context.lookup(ref)?.get(PDFName.of('Subtype'))?.toString()==='/Square').length;}
try{
 await c.send('Emulation.setFocusEmulationEnabled',{enabled:true});original=await identity();assert.equal(original.mobile,false);assert.equal(original.views,0);
 assert.equal(await root(()=>app.plugins.plugins['pdf-web-reader'].settings.autoSave),true);
 report.productHashes={};for(const name of ['main.js','manifest.json','styles.css']){const actual=await fs.readFile(path.join(vault,configDir,'plugins/pdf-web-reader',name));assert.deepEqual(actual,await fs.readFile(`dist/pdf-web-reader/${name}`));report.productHashes[name]=hash(actual);}
 await root(async prefix=>{if(!prefix.startsWith('PDF迁移测试/general-0.5.8-close-native-')||app.vault.getAbstractFileByPath(prefix))throw Error('Unsafe fixture');await app.vault.createFolder(prefix);},prefix);
 for(const mobile of [false,true]){
  if(mobile)await mode(true);
  for(const kind of ['clean','edited','write-failure']){
   const file=`${prefix}/${mobile?'mobile':'desktop'}-${kind}.pdf`;
   await root(async({file,bytes})=>{if(app.vault.getAbstractFileByPath(file))throw Error('Existing fixture');const f=await app.vault.createBinary(file,new Uint8Array(bytes).buffer);await app.plugins.plugins['pdf-web-reader'].openPdf(f);},{file,bytes:[...bytes]});
   await wait('Own PDF rendered',()=>doc(file,({v,a})=>v.ready&&!!a.pdfDocument&&a.pdfViewer.getPageView(0)?.renderingState===3));
   await doc(file,({a,d})=>{a.pdfViewer.currentPageNumber=1;a.pdfViewer.currentScaleValue='page-fit';d.getElementById('viewerContainer').scrollTop=0;});
   await wait('First page visible',()=>doc(file,({a,d})=>{const page=d.querySelector('.page[data-page-number="1"]'),r=page.getBoundingClientRect(),v=d.getElementById('viewerContainer').getBoundingClientRect();return a.pdfViewer.currentPageNumber===1&&a.pdfViewer.getPageView(0)?.renderingState===3&&Math.min(r.bottom,v.bottom)-Math.max(r.top,v.top)>140&&Math.min(r.right,v.right)-Math.max(r.left,v.left)>140;}));
   if(kind==='write-failure')await root(file=>{if(window.__closeFaultOriginal)throw Error('Existing test fault');const original=app.vault.modifyBinary;window.__closeFaultOriginal=original;app.vault.modifyBinary=function(f,...args){if(f.path===file)return Promise.reject(Error('Owned close regression write failure'));return original.call(this,f,...args);};},file);
   if(kind!=='clean'){
    const tool=await doc(file,({v,d})=>{const r=d.getElementById('editorSquareButton').getBoundingClientRect(),f=v.iframe.getBoundingClientRect();return{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};});await p.mouse.click(tool.x,tool.y);
    await wait('Square selected',()=>doc(file,({a})=>a.pdfViewer.annotationEditorMode===5));
    const point=await doc(file,({v,d})=>{const r=d.querySelector('.page[data-page-number="1"]').getBoundingClientRect(),view=d.getElementById('viewerContainer').getBoundingClientRect(),f=v.iframe.getBoundingClientRect();const left=Math.max(r.left,view.left)+10,right=Math.min(r.right,view.right)-10,top=Math.max(r.top,view.top)+20,bottom=Math.min(r.bottom,view.bottom)-20;if(right-left<120||bottom-top<120)throw Error('No visible drawing area');const x=left+20,y=top+(bottom-top-60)*.55;const hit=d.elementFromPoint(x,y);if(!hit?.closest('.page[data-page-number="1"]'))throw Error('Square point not on visible first page');return{x:f.x+x,y:f.y+y};});
    await p.mouse.move(point.x,point.y);await p.mouse.down();await p.mouse.move(point.x+90,point.y+55,{steps:5});await p.mouse.up();
    await wait('Actual Square and revision',()=>doc(file,({v,a,d})=>v.currentRevision>0&&[...(a.pdfDocument.annotationStorage.serializable.map||new Map()).values()].filter(e=>e.annotationType===5&&!e.deleted).length===1&&a.pdfDocument.annotationStorage.size>0));
   }
   const before=await doc(file,({v,a})=>({revision:v.currentRevision,confirmed:v.confirmedRevision,storage:a.pdfDocument.annotationStorage.size}));
   const closePoint=await root(file=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file);const el=v.leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-close-button');const r=el?.getBoundingClientRect();if(!r?.width||!r.height)throw Error('Real close button not visible');return{x:r.x+r.width/2,y:r.y+r.height/2};},file);
   const started=performance.now();if(mobile){await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...closePoint,id:73,radiusX:3,radiusY:3,force:1}]});await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}else await p.mouse.click(closePoint.x,closePoint.y);
   await wait('Real button removed own Reader',()=>root(file=>![...app.plugins.plugins['pdf-web-reader'].views].some(v=>v.requestedPath===file)&&!app.workspace.getLeavesOfType('pdf-web-reader-view').some(l=>l.view.requestedPath===file),file));
   const closeMs=performance.now()-started;
   const disk=await fs.readFile(path.join(vault,file));const squares=await annotationCount(disk);let recovery;
   if(kind==='clean'){assert.equal(hash(disk),hash(bytes));assert.equal(squares,0);}else if(kind==='edited')assert.equal(squares,1);else{
    assert.equal(hash(disk),hash(bytes));const records=await root(async file=>(await app.plugins.plugins['pdf-web-reader'].listRecoveryCandidates()).filter(r=>r.metadata.originalPath===file||r.metadata.documentPath===file).map(r=>({candidatePath:r.candidatePath,status:r.metadata.status,revision:r.metadata.revision})),file);assert.ok(records.length);const valid=[];for(const r of records){const count=await annotationCount(await fs.readFile(path.join(vault,r.candidatePath)));if(count===1)valid.push({...r,squares:count});}assert.ok(valid.length);recovery=valid;
   }
   report.checks.push({mobile,kind,before,closeMs,squares,recovery,realVisibleCloseButton:true});
   await root(()=>{if(window.__closeFaultOriginal){app.vault.modifyBinary=window.__closeFaultOriginal;delete window.__closeFaultOriginal;}});
  }
 }
 report.status='passed';
}catch(e){failure=e;report.status='failed';report.error=e.stack;try{report.failureState=await root(prefix=>[...app.plugins.plugins['pdf-web-reader'].views].filter(v=>v.requestedPath?.startsWith(prefix+'/')).map(v=>({path:v.requestedPath,revision:v.currentRevision,confirmed:v.confirmedRevision,page:v.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer.currentPageNumber,pageBounds:(()=>{const r=v.iframe?.contentWindow?.document.querySelector('.page[data-page-number="1"]')?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null;})(),storage:v.iframe?.contentWindow?.PDFViewerApplication?.pdfDocument?.annotationStorage.serializable.map? [...v.iframe.contentWindow.PDFViewerApplication.pdfDocument.annotationStorage.serializable.map.values()].map(e=>({type:e.annotationType,deleted:e.deleted})):[],closing:!!v.closePreparation,prepared:!!v.preparedClose})),prefix);}catch(x){report.failureStateError=x.message;}}
finally{
 try{await identity();await root(()=>{if(window.__closeFaultOriginal){app.vault.modifyBinary=window.__closeFaultOriginal;delete window.__closeFaultOriginal;}});await root(async prefix=>{for(const v of [...app.plugins.plugins['pdf-web-reader'].views])if(v.requestedPath?.startsWith(prefix+'/'))await v.leaf.detach();await app.workspace.saveLayout();},prefix);}catch(e){failure||=e;report.status='failed';report.cleanupError=e.message;}
 try{if((await identity()).mobile!==original?.mobile)await mode(original?.mobile??false);report.restoredTestReaders=await root(async()=>{const rows=[];for(const v of [...app.plugins.plugins['pdf-web-reader'].views]){if(!/^PDF迁移测试\/general-0\.5\.8-close-native-\d+\/(?:desktop|mobile)-(?:clean|edited|write-failure)\.pdf$/.test(v.requestedPath||''))throw Error('Unrelated Reader after simulation restore');rows.push({path:v.requestedPath,revision:v.currentRevision,confirmed:v.confirmedRevision});await v.leaf.detach();}await app.workspace.saveLayout();return rows;});await wait('Restored owned views cleaned',async()=>(await identity()).views===0);report.cleanup=await identity();assert.equal(report.cleanup.views,0);assert.equal(report.cleanup.mobile,false);}catch(e){failure||=e;report.status='failed';report.restoreError=e.message;}
 await c.send('Emulation.setFocusEmulationEnabled',{enabled:false}).catch(()=>{});b.disconnect();await fs.writeFile(`tests/artifacts/${run}.json`,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(run,report.status);
}
if(failure)throw failure;
