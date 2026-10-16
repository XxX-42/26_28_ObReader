import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';
const expectedVersion=process.env.NATIVE_VERSION||'0.8.8';
const evidenceDir=`evidence/native-local-${expectedVersion}`;
const cfg=JSON.parse(await readFile('/tmp/obreader-native-local.json','utf8'));
assert.equal(cfg.vault,'/Users/jiajia/Documents/ObReader-Apple-Test');
const port=(await readFile(cfg.profile+'/DevToolsActivePort','utf8')).split('\n')[0];
const browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});
const page=(await browser.pages()).find(p=>p.url()==='app://obsidian.md/index.html');assert.ok(page);
const session=await page.createCDPSession();await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});
const report={version:expectedVersion,vault:cfg.vault,port,physicalIpadValidated:false,matrix:[],errors:[]};
page.on('pageerror',e=>report.errors.push(e.message));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const source='/Users/jiajia/Documents/Documents/Obsidian/远程仓库1/'+cfg.pdf;
const originalHash=sha(await readFile(source));const copyHash=sha(await readFile(cfg.vault+'/'+cfg.pdf));assert.equal(originalHash,copyHash);
async function root(fn,arg){return page.evaluate(async({source,arg,vault,expectedVersion})=>{if(app.vault.adapter.basePath!==vault)throw Error('Wrong vault');if(app.plugins.plugins['pdf-web-reader']?.manifest.version!==expectedVersion)throw Error('Wrong loaded version');return (0,eval)(`(${source})`)(arg);},{source:fn.toString(),arg,vault:cfg.vault,expectedVersion});}
async function doc(fn,arg){return root(({file,source,arg})=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file);if(!v)throw Error('Missing own Reader');const w=v.iframe.contentWindow;return (0,eval)(`(${source})`)({v,w,d:w.document,a:w.PDFViewerApplication,arg});},{file:cfg.pdf,source:fn.toString(),arg});}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(label,fn,timeout=20000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await fn();if(last)return last;await pause(50);}throw Error(label+': '+JSON.stringify(last));}
async function open(){await root(async file=>{const f=app.vault.getAbstractFileByPath(file);if(!f)throw Error('Missing test PDF');await app.plugins.plugins['pdf-web-reader'].openPdf(f);},cfg.pdf);await wait('PDF ready',()=>doc(({v,a})=>v.ready&&a.pdfDocument&&a.pdfViewer.getPageView(0)?.renderingState===3));await doc(({a})=>{a.pdfViewer.currentPageNumber=2;a.pdfViewer.currentScaleValue='page-fit';});await wait('page 2',()=>doc(({a})=>a.pdfViewer.getPageView(1)?.renderingState===3));await wait('verified source and enabled tool',()=>doc(({v,d})=>!!v.annotationPageIdentity&&!v.annotationSourceMismatch&&!d.getElementById('editorInkButton').disabled));}
async function click(id){const p=await doc(({v,d,arg})=>{const e=d.getElementById(arg),r=e?.getBoundingClientRect(),f=v.iframe.getBoundingClientRect();if(!e||e.disabled||!r.width||!r.height)throw Error('Unavailable '+arg);return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};},id);await page.mouse.click(p.x,p.y);}
async function mode(value){const current=await doc(({a})=>a.pdfViewer.annotationEditorMode);if(current!==value){await click(({15:'editorInkButton',9:'editorHighlightButton',5:'editorSquareButton'})[value||current]);}await wait('tool mode',()=>doc(({a,arg})=>a.pdfViewer.annotationEditorMode===arg,value));await pause(200);}
async function live(){return doc(({a})=>[...a.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(1)].filter(e=>!e.deleted).map(e=>({type:e.editorType,ref:e.annotationElementId})));}
async function close(){const point=await root(file=>{const v=[...app.plugins.plugins['pdf-web-reader'].views].find(v=>v.requestedPath===file);const e=v.leaf.tabHeaderEl.querySelector('.workspace-tab-header-inner-close-button');if(!e)throw Error('No real close control');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},cfg.pdf);const began=Date.now();await page.mouse.click(point.x,point.y);await wait('actual tab closes',()=>root(file=>![...app.plugins.plugins['pdf-web-reader'].views].some(v=>v.requestedPath===file),cfg.pdf),5000);return Date.now()-began;}
async function save(){await doc(({d})=>d.getElementById('secondaryDownload').click());await wait('durable ACK',()=>doc(({v})=>v.currentRevision===v.confirmedRevision&&v.pendingSaves===0));}
async function square(){await click('editorSquareButton');await wait('square mode',()=>doc(({a})=>a.pdfViewer.annotationEditorMode===5));const p=await doc(({v,a,d})=>{const r=a.pdfViewer.getPageView(1).div.getBoundingClientRect(),f=v.iframe.getBoundingClientRect(),c=d.getElementById('viewerContainer').getBoundingClientRect();return {x:f.x+Math.max(r.x+50,c.x+50),y:f.y+Math.max(r.y+70,c.y+70)};});await page.mouse.move(p.x,p.y);await page.mouse.down();await page.mouse.move(p.x+80,p.y+50,{steps:8});await page.mouse.up();await wait('real Square created',async()=>(await live()).length===1);}
async function del(){await click('secondaryToolbarToggleButton');await click('pdfReaderBridgeDeleteAllAnnotationsButton');await wait('confirmation',()=>doc(({d})=>!!d.querySelector('.pdfReaderBulkDeleteConfirm')));const point=await doc(({v,d})=>{const r=d.querySelector('.pdfReaderBulkDeleteConfirm').getBoundingClientRect(),f=v.iframe.getBoundingClientRect();return{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};});await page.mouse.click(point.x,point.y);await wait('all editors deleted',async()=>(await live()).length===0);}
try{
 const initial=await root(()=>({vault:app.vault.adapter.basePath,version:app.plugins.plugins['pdf-web-reader'].manifest.version,mobile:app.isMobile,views:app.plugins.plugins['pdf-web-reader'].views.size}));assert.equal(initial.mobile,false);assert.equal(initial.views,0,'native fixture must begin with no Reader views');
 for(const mobile of [false,true]){
  if(mobile){const nav=page.waitForNavigation({waitUntil:'domcontentloaded'});await root(()=>setTimeout(()=>app.emulateMobile(true),0));await nav;await page.waitForFunction(()=>window.app?.workspace?.layoutReady&&!!app.plugins.plugins['pdf-web-reader']);await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});}
  const row={mobile};report.matrix.push(row);await open();row.identity=await root(()=>({vault:app.vault.adapter.basePath,version:app.plugins.plugins['pdf-web-reader'].manifest.version,mobile:app.isMobile}));
  row.initialModes=[];for(const m of [15,9,0,15]){await mode(m);const e=await live();assert.equal(e.length,0,'deleted source marks must remain absent');row.initialModes.push({mode:m,live:e.length});}
  await page.screenshot({path:`${evidenceDir}/${mobile?'mobile':'desktop'}-principles-clean.png`});
  await square();await save();row.closeAfterSaveMs=await close();
  await open();await mode(15);assert.equal((await live()).length,1,'new saved Square survives reopen');row.newAnnotationReopen=true;
  await del();await save();row.closeAfterDeleteMs=await close();
  await open();await mode(15);assert.equal((await live()).length,0,'all annotations remain deleted after reopen and tool change');row.deletedReopen=true;
  await page.screenshot({path:`${evidenceDir}/${mobile?'mobile':'desktop'}-deleted-reopened.png`});row.finalCloseMs=await close();
 }
 report.originalPdfHashAfter=sha(await readFile(source));report.testPdfHashAfter=sha(await readFile(cfg.vault+'/'+cfg.pdf));assert.equal(report.originalPdfHashAfter,originalHash);assert.equal(report.testPdfHashAfter,copyHash);report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;await page.screenshot({path:evidenceDir+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{await writeFile(evidenceDir+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.disconnect();}
