// Isolated Windows Native acceptance for v15. This deliberately creates new
// fixtures only; it never migrates or edits existing PDFs or annotation files.
import assert from 'node:assert/strict';
import {copyFile,mkdir,readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {nativeConfig,nativeCdp,nativeEvalJson,nativeIdentityExpression,assertNativeTestPreflight} from './native-config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const {readPairId}=require('../plugin/pdf-pair-id.cjs');
const {createSingleJsonlStore}=require('../plugin/storage/single-jsonl-store.cjs');
const {createPdfHashRuntime}=require('../plugin/pdf-hash-runtime.cjs');
const expectedVault=String.raw`D:\Documents\Obsidian\ObReader-v15-isolated-20261029`;
assert.equal(path.win32.resolve(nativeConfig.vault).toLowerCase(),path.win32.resolve(expectedVault).toLowerCase(),'This acceptance only writes to its isolated v15 test vault');
const sha=b=>createHash('sha256').update(b).digest('hex');
const runId=randomUUID(),relative=`Books/v15-native-${runId}.pdf`,absolute=path.join(nativeConfig.vault,...relative.split('/'));
const reportPath=path.join(root,'tests','artifacts',`v15-native-pair-${runId}.json`);
const fixture=path.join(root,'tests','fixtures','tracemonkey.pdf');
const lookup=`app.workspace.getLeavesOfType('pdf-web-reader-view').find(l=>l.view?.requestedPath===${JSON.stringify(relative)})?.view`;
const report={runId,relative,status:'running',startedAt:new Date().toISOString(),checks:{},errors:[]};
const evalJson=(expression,timeout=30000)=>nativeEvalJson(expression,timeout);
const resolveVault=p=>{const target=path.resolve(nativeConfig.vault,...p.split('/'));assert.ok(target.startsWith(nativeConfig.vault+path.sep));return target};
const forbidden=async()=>{throw Error('Read-only acceptance adapter cannot write')};
const readonlyAdapter={read:p=>readFile(resolveVault(p),'utf8'),async exists(p){try{await stat(resolveVault(p));return true}catch(error){if(error.code==='ENOENT')return false;throw error}},write:forbidden,mkdir:forbidden,rename:forbidden,process:forbidden};
const disk=createSingleJsonlStore({adapter:readonlyAdapter,token:randomUUID});
async function saveReport(){await mkdir(path.dirname(reportPath),{recursive:true});await writeFile(reportPath,JSON.stringify(report,null,2)+'\n')}
async function wait(label,probe,predicate=Boolean,timeout=30000){const deadline=Date.now()+timeout;let last;while(Date.now()<deadline){last=await probe();if(predicate(last))return last;await new Promise(r=>setTimeout(r,200));}throw Error(`${label}: ${JSON.stringify(last)}`)}
function send(method,params){const result=nativeCdp(method,params);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result}
function state(){return evalJson(`JSON.stringify((()=>{const v=${lookup},w=v?.iframe?.contentWindow,a=w?.PDFViewerApplication,d=w?.document,p=a?.pdfViewer?.getPageView(0),manager=a?.pdfViewer?._layerProperties?.annotationEditorUIManager;const editors=[...(d?.querySelectorAll('.annotationEditorLayer > div[id]')||[])].filter(e=>manager?.getEditor(e.id)).map(e=>{const r=e.getBoundingClientRect(),s=w.getComputedStyle(e),editor=manager.getEditor(e.id);return{id:e.id,type:editor.constructor._editorType,width:r.width,height:r.height,display:s.display,visibility:s.visibility,opacity:s.opacity,text:e.querySelector('.internal')?.textContent?.replace(/\\u200b/g,'')||null}});return {ready:!!v?.ready,revision:v?.currentRevision,confirmed:v?.confirmedRevision,saving:!!v?.saving,hydrated:!!v?.annotationHydrationAllowed,sourceMismatch:!!v?.annotationSourceMismatch,storageUnavailable:!!v?.annotationStorageUnavailable,protocol:app.plugins.plugins['pdf-web-reader']?.annotationHost?.store?.sourceProtocol||null,render:p?.renderingState||0,rows:v?.annotationSnapshot?.annotations||[],tombstones:v?.annotationSnapshot?.tombstones||[],editorIds:editors.map(e=>e.id),editors,geometry:(()=>{const frame=v?.iframe?.getBoundingClientRect(),r=d?.querySelector('.page[data-page-number="1"]')?.getBoundingClientRect();return frame&&r?{x:frame.x+r.x,y:frame.y+r.y,width:r.width,height:r.height}:null})()}})())`)}
async function square(dx=0){
 evalJson(`JSON.stringify((()=>{const v=${lookup};v.iframe.contentWindow.PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode:5});return true})())`);
 await wait('square mode',()=>evalJson(`JSON.stringify(${lookup}?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode===5)`));
 const rect=(await state()).geometry;assert.ok(rect?.width>150&&rect?.height>150,'First PDF page must be visible');
 const x=rect.x+Math.min(rect.width*.3,180)+dx,y=rect.y+Math.min(rect.height*.3,180);
 send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
 for(let i=1;i<=6;i++)send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+i*10,y:y+i*7,buttons:1});
 send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+60,y:y+42,button:'left',buttons:0,clickCount:1});
}
async function setMode(mode){evalJson(`JSON.stringify((()=>{const v=${lookup};v.iframe.contentWindow.PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{mode:${mode}});return true})())`);await wait(`mode ${mode}`,()=>evalJson(`JSON.stringify(${lookup}?.iframe?.contentWindow?.PDFViewerApplication?.pdfViewer?.annotationEditorMode===${mode})`));}
async function selection(mode){
 await setMode(mode);
 const hit=evalJson(`JSON.stringify((()=>{const v=${lookup},d=v.iframe.contentDocument,f=v.iframe.getBoundingClientRect();return [...d.querySelectorAll('.page[data-page-number="1"] .textLayer span')].map(e=>({e,r:e.getBoundingClientRect()})).filter(({e,r})=>e.textContent.trim().length>=12&&r.width>=70&&r.height>3&&f.y+r.y>=0&&f.y+r.bottom<innerHeight).map(({e,r})=>({x:f.x+r.x,y:f.y+r.y,width:r.width,height:r.height,text:e.textContent}))[0]||null})())`);
 assert.ok(hit,'A visible text span is required for trusted selection');const x=hit.x+4,y=hit.y+hit.height*.55,end=x+Math.min(75,hit.width-10);
 send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
 for(let i=1;i<=8;i++)send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+(end-x)*i/8,y,buttons:1});
 send('Input.dispatchMouseEvent',{type:'mouseReleased',x:end,y,button:'left',buttons:0,clickCount:1});
}
async function ink(){await setMode(15);const r=(await state()).geometry;const x=r.x+Math.min(r.width*.7,380),y=r.y+Math.min(r.height*.25,170);send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});for(let i=1;i<=8;i++)send('Input.dispatchMouseEvent',{type:'mouseMoved',x:x+i*7,y:y+(i%2?8:2),buttons:1});send('Input.dispatchMouseEvent',{type:'mouseReleased',x:x+56,y:y+2,button:'left',buttons:0,clickCount:1});}
async function freeText(){await setMode(3);const r=(await state()).geometry;const x=r.x+Math.min(r.width*.55,310),y=r.y+Math.min(r.height*.43,300);send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});await wait('FreeText input',()=>evalJson(`JSON.stringify(!!${lookup}?.iframe?.contentDocument?.querySelector('.freeTextEditor.selectedEditor .internal'))`));send('Input.insertText',{text:'v15 native paired text'});send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});}
async function clickElement(selector){const point=await wait(`visible ${selector}`,()=>evalJson(`JSON.stringify((()=>{const v=${lookup},e=v?.iframe?.contentDocument?.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect(),f=v?.iframe?.getBoundingClientRect();return e&&!e.disabled&&r?.width>0&&r?.height>0?{x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2}:null})())`));send('Input.dispatchMouseEvent',{type:'mouseMoved',...point});send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});}
function pressDelete(){send('Input.dispatchKeyEvent',{type:'keyDown',key:'Delete',code:'Delete',windowsVirtualKeyCode:46,nativeVirtualKeyCode:46});send('Input.dispatchKeyEvent',{type:'keyUp',key:'Delete',code:'Delete',windowsVirtualKeyCode:46,nativeVirtualKeyCode:46});}
async function close(){evalJson(`(async()=>{const v=${lookup};if(!v||v.saving||v.currentRevision!==v.confirmedRevision)throw Error('Reader is missing or dirty');await v.leaf.detach();return JSON.stringify({requested:true})})()`);await wait('Reader closed',()=>evalJson(`JSON.stringify(!${lookup})`),Boolean,30000)}
async function open(){const start=Date.now();evalJson(`(async()=>{const file=app.vault.getAbstractFileByPath(${JSON.stringify(relative)});if(!file)throw Error('Fixture is not indexed');await app.plugins.plugins['pdf-web-reader'].openPdf(file);return JSON.stringify({opened:true})})()`);const ready=await wait('viewer ready',state,s=>s.ready&&s.hydrated&&s.render===3&&s.geometry,60000);evalJson(`JSON.stringify((()=>{const pdf=${lookup}.iframe.contentWindow.PDFViewerApplication.pdfDocument,t=globalThis.__v15NativeTrace;if(!pdf||!t)throw Error('PDF serialization instrumentation unavailable');const original=pdf.saveDocument;t.pdfOriginals.push({pdf,original});pdf.saveDocument=function(){t.serializations++;throw Error('Daily PDF serialization is forbidden')};return true})())`);return {elapsedMs:Date.now()-start,state:ready}}
async function measureLargeFixture(source,label,existingFixture=null){
 const largeRelative=existingFixture||`Books/v15-${label}-${runId}.pdf`,largeAbsolute=resolveVault(largeRelative);
 const sourceBefore=sha(await readFile(source));let expected=null;
 if(existingFixture){
  const bytes=await readFile(largeAbsolute),pairId=await readPairId(bytes);expected=await disk.readCurrent(largeRelative,pairId);
  assert.ok(expected);assert.equal(expected.document.pairing.originalSha256,'sha256-v1:'+sourceBefore);
  assert.equal(expected.annotations.length,49);assert.equal(expected.tombstones.length,13);
 }else{await copyFile(source,largeAbsolute,constants.COPYFILE_EXCL);assert.equal(sha(await readFile(largeAbsolute)),sourceBefore,'Large fixture must match its read-only source');}
 const fixtureBefore=sha(await readFile(largeAbsolute));
 await wait('large fixture indexed',()=>evalJson(`JSON.stringify(!!app.vault.getAbstractFileByPath(${JSON.stringify(largeRelative)}))`));
 const view=`app.workspace.getLeavesOfType('pdf-web-reader-view').find(l=>l.view?.requestedPath===${JSON.stringify(largeRelative)})?.view`;
 evalJson(`JSON.stringify((()=>{const target=${JSON.stringify(largeRelative)},trace={target,events:[],originals:[]},store=app.plugins.plugins['pdf-web-reader'].annotationHost.store;
  for(const [object,name] of [[app.vault,'readBinary'],[store,'documentForPath'],[store,'registerDocument'],[store,'readDocument']]){if(typeof object[name]!=='function')continue;const original=object[name];trace.originals.push({object,name,original});object[name]=async function(...args){const start=performance.now();try{return await original.apply(this,args)}finally{const path=args[0]?.path||args[0]?.sourcePath||args[0];if(path===target)trace.events.push({phase:name,ms:performance.now()-start})}}}
  for(const [object,name] of [[app.vault,'appendBinary'],[app.vault,'modifyBinary'],[app.vault.adapter,'write'],[app.vault.adapter,'writeBinary'],[app.vault.adapter,'append'],[app.vault.adapter,'appendBinary']]){if(typeof object[name]!=='function')continue;const original=object[name];trace.originals.push({object,name,original});object[name]=async function(...args){const path=args[0]?.path||args[0];if(path===target){trace.events.push({phase:'forbidden-write',method:name});throw Error('Large source PDF writes are forbidden during opening')}return original.apply(this,args)}}
  globalThis.__v15LargeTrace=trace;return true})())`);
 const start=Date.now();evalJson(`(async()=>{const file=app.vault.getAbstractFileByPath(${JSON.stringify(largeRelative)});await app.plugins.plugins['pdf-web-reader'].openPdf(file);return JSON.stringify({opened:true})})()`);
 const largeState=()=>evalJson(`JSON.stringify((()=>{const v=${view},a=v?.iframe?.contentWindow?.PDFViewerApplication,p=a?.pdfViewer?.getPageView(0);return {ready:!!v?.ready,hydrated:!!v?.annotationHydrationAllowed,render:p?.renderingState||0,storageUnavailable:!!v?.annotationStorageUnavailable,revision:v?.currentRevision,confirmed:v?.confirmedRevision,saving:!!v?.saving,rows:v?.annotationSnapshot?.annotations||[],tombstones:v?.annotationSnapshot?.tombstones||[]}})())`);
 await wait('large first page',largeState,s=>s.render===3,60000);const firstPageMs=Date.now()-start;
 const state=await wait('large annotations ready',largeState,s=>s.ready&&s.hydrated&&!s.storageUnavailable,60000);const annotationsReadyMs=Date.now()-start;
 if(expected){
  const byUuid=(a,b)=>a.uuid.localeCompare(b.uuid);
  assert.deepEqual([...state.rows].sort(byUuid),[...expected.annotations].sort(byUuid),'Viewer must restore the full saved annotation records');
  assert.deepEqual(state.tombstones.map(r=>r.uuid).sort(),expected.tombstones.map(r=>r.uuid).sort());
  const pageIndex=Math.min(...expected.annotations.map(r=>r.pageIndex));
  evalJson(`JSON.stringify((()=>{${view}.iframe.contentWindow.PDFViewerApplication.pdfViewer.currentPageNumber=${pageIndex+1};return true})())`);
  const rendered=await wait('legacy annotation page visible',()=>evalJson(`JSON.stringify((()=>{const v=${view},a=v?.iframe?.contentWindow?.PDFViewerApplication,d=v?.iframe?.contentDocument,p=a?.pdfViewer?.getPageView(${pageIndex}),m=a?.pdfViewer?._layerProperties?.annotationEditorUIManager;const rows=[...(d?.querySelectorAll('.page[data-page-number="${pageIndex+1}"] .annotationEditorLayer > div[id]')||[])].filter(e=>m?.getEditor(e.id));return {render:p?.renderingState||0,editorCount:rows.length}})())`),s=>s.render===3&&s.editorCount>0,60000);
  report.checks.legacyVisible={page:pageIndex+1,editorCount:rendered.editorCount,active:state.rows.length,deleted:state.tombstones.length};
 }
 evalJson(`(async()=>{const v=${view};if(!v||v.saving||v.currentRevision!==v.confirmedRevision)throw Error('Large fixture is not clean');await v.leaf.detach();return JSON.stringify({closed:true})})()`);
 await wait('large Reader closed',()=>evalJson(`JSON.stringify(!${view})`));
 const reopenStart=Date.now();
 evalJson(`(async()=>{const file=app.vault.getAbstractFileByPath(${JSON.stringify(largeRelative)});await app.plugins.plugins['pdf-web-reader'].openPdf(file);return JSON.stringify({opened:true})})()`);
 await wait('large reopen first page',largeState,s=>s.render===3,60000);const reopenFirstPageMs=Date.now()-reopenStart;
 const reopened=await wait('large reopen annotations ready',largeState,s=>s.ready&&s.hydrated&&!s.storageUnavailable,60000);const reopenAnnotationsReadyMs=Date.now()-reopenStart;
 if(expected){
  const byUuid=(a,b)=>a.uuid.localeCompare(b.uuid);
  assert.deepEqual([...reopened.rows].sort(byUuid),[...expected.annotations].sort(byUuid));
  assert.deepEqual(reopened.tombstones.map(r=>r.uuid).sort(),expected.tombstones.map(r=>r.uuid).sort());
 }
 evalJson(`(async()=>{const v=${view};if(!v||v.saving||v.currentRevision!==v.confirmedRevision)throw Error('Reopened large fixture is not clean');await v.leaf.detach();return JSON.stringify({closed:true})})()`);
 await wait('reopened large Reader closed',()=>evalJson(`JSON.stringify(!${view})`));
 const events=evalJson(`JSON.stringify(globalThis.__v15LargeTrace?.events||[])`);
 assert.equal(events.some(e=>e.phase==='forbidden-write'),false);
 assert.equal(sha(await readFile(largeAbsolute)),fixtureBefore);assert.equal(sha(await readFile(source)),sourceBefore);
 (report.checks.large||={})[label]={firstPageMs,annotationsReadyMs,reopenFirstPageMs,reopenAnnotationsReadyMs,events,sourceSha256:sourceBefore,fixtureSha256:fixtureBefore,state,scope:expected?'independently migrated 49/13 test fixture':'independent PDF fixture with no annotations'};
 evalJson(`JSON.stringify((()=>{const t=globalThis.__v15LargeTrace;for(const row of t.originals)row.object[row.name]=row.original;delete globalThis.__v15LargeTrace;return true})())`);
}
try{
 const preflight=evalJson(nativeIdentityExpression(`pluginEnabled:app.plugins.enabledPlugins.has('pdf-web-reader'),pluginVersion:app.plugins.plugins['pdf-web-reader']?.manifest?.version||null,visibility:document.visibilityState,readerViews:app.workspace.getLeavesOfType('pdf-web-reader-view').map(l=>({path:l.view?.requestedPath||null})),`));
 assertNativeTestPreflight(preflight,'0.15.0');report.checks.preflight=preflight;
 for(const name of ['main.js','manifest.json','styles.css']){
  const installed=await readFile(path.join(nativeConfig.vault,nativeConfig.configDir,'plugins','pdf-web-reader',name));
  const built=await readFile(path.join(root,'dist','pdf-web-reader',name));assert.equal(sha(installed),sha(built),`Installed ${name} differs from the candidate`);(report.checks.triplet||={})[name]=sha(built);
 }
 await mkdir(path.dirname(absolute),{recursive:true});await copyFile(fixture,absolute,constants.COPYFILE_EXCL);
 report.checks.initialSha256=sha(await readFile(absolute));
 await wait('fixture registered',()=>evalJson(`JSON.stringify(!!app.vault.getAbstractFileByPath(${JSON.stringify(relative)}))`));
 evalJson(`JSON.stringify((()=>{const vault=app.vault,p=${JSON.stringify(relative)};if(globalThis.__v15NativeTrace)throw Error('Another v15 trace is active');const trace={append:0,modify:0,serializations:0,pdfOriginals:[],adapterWrites:[],adapterOriginals:[],originalAppend:vault.appendBinary,originalModify:vault.modifyBinary};vault.appendBinary=async function(file,...args){if(file?.path===p)trace.append++;return trace.originalAppend.call(this,file,...args)};vault.modifyBinary=async function(file,...args){if(file?.path===p)trace.modify++;return trace.originalModify.call(this,file,...args)};for(const name of ['write','writeBinary','append','appendBinary']){const original=vault.adapter[name];if(typeof original!=='function')continue;trace.adapterOriginals.push({name,original});vault.adapter[name]=async function(target,...args){if(target===p)trace.adapterWrites.push(name);return original.call(this,target,...args)}}globalThis.__v15NativeTrace=trace;return true})())`);
 report.checks.firstOpen=await open();assert.equal(report.checks.firstOpen.state.protocol,'obreader-current-v15');assert.equal(report.checks.firstOpen.state.storageUnavailable,false);
 assert.equal(sha(await readFile(absolute)),report.checks.initialSha256,'Opening alone cannot pair the PDF');
 await square();const first=await wait('first annotation durable',state,s=>s.rows?.length===1&&s.revision>0&&s.revision===s.confirmed&&!s.saving,60000);
 const firstBytes=await readFile(absolute),pairId=await readPairId(firstBytes),pairedSha=sha(firstBytes);assert.match(pairId,/^[a-f0-9]{32}$/);assert.notEqual(pairedSha,report.checks.initialSha256);
 const trace=evalJson(`JSON.stringify({append:globalThis.__v15NativeTrace.append,modify:globalThis.__v15NativeTrace.modify,serializations:globalThis.__v15NativeTrace.serializations,adapterWrites:globalThis.__v15NativeTrace.adapterWrites})`);assert.equal(trace.append,1);assert.equal(trace.modify,0);assert.equal(trace.serializations,0);assert.ok(trace.adapterWrites.every(x=>x==='appendBinary'));
 const firstIds=first.rows.map(r=>r.uuid);assert.equal(new Set(firstIds).size,1);report.checks.firstSave={ids:firstIds,pairId,pairedSha,trace};
 await selection(10);const second=await wait('Underline durable',state,s=>s.rows?.length===2&&s.rows.some(r=>r.kind==='Underline')&&s.revision===s.confirmed&&!s.saving,60000);
 assert.equal(sha(await readFile(absolute)),pairedSha,'Later annotation saves cannot write the PDF');
 const trace2=evalJson(`JSON.stringify({append:globalThis.__v15NativeTrace.append,modify:globalThis.__v15NativeTrace.modify,serializations:globalThis.__v15NativeTrace.serializations,adapterWrites:globalThis.__v15NativeTrace.adapterWrites})`);assert.deepEqual(trace2,trace);
 await selection(9);await wait('Highlight durable',state,s=>s.rows?.length===3&&s.rows.some(r=>r.kind==='Highlight')&&s.revision===s.confirmed&&!s.saving,60000);
 await ink();await wait('Ink durable',state,s=>s.rows?.length===4&&s.rows.some(r=>r.kind==='Ink')&&s.revision===s.confirmed&&!s.saving,60000);
 await freeText();const all=await wait('FreeText durable',state,s=>s.rows?.length===5&&s.rows.some(r=>r.kind==='FreeText')&&s.revision===s.confirmed&&!s.saving,60000);
 assert.deepEqual(all.rows.map(r=>r.kind).sort(),['FreeText','Highlight','Ink','Square','Underline']);
 const ids=all.rows.map(r=>r.uuid).sort();assert.equal(new Set(ids).size,5);assert.equal(sha(await readFile(absolute)),pairedSha);await close();report.checks.reopen=await open();
 assert.deepEqual(report.checks.reopen.state.rows.map(r=>r.uuid).sort(),ids);assert.equal(report.checks.reopen.state.editorIds.length,5);
 assert.ok(report.checks.reopen.state.editors.every(e=>e.width>0&&e.height>0&&e.display!=='none'&&e.visibility!=='hidden'&&Number(e.opacity)>0));
 const free=report.checks.reopen.state.editors.find(e=>e.type===3);assert.ok(free?.text?.includes('v15 native paired text'));
 const xxh=await createPdfHashRuntime(),pairedXxh=xxh.fingerprint(firstBytes);assert.equal(xxh.fingerprint(await readFile(absolute)),pairedXxh);
 const screenshot=send('Page.captureScreenshot',{format:'png',fromSurface:true});const screenshotPath=path.join(root,'tests','artifacts',`v15-native-pair-${runId}.png`);await writeFile(screenshotPath,Buffer.from(screenshot.data,'base64'));report.checks.reopenScreenshot=screenshotPath;report.checks.pairedXxh64=pairedXxh;
 const squareId=all.rows.find(r=>r.kind==='Square').uuid;await setMode(0);await clickElement('.page[data-page-number="1"] .annotationEditorLayer [data-l10n-id="pdfjs-editor-square-editor"]');pressDelete();
 await wait('delete durable',state,s=>s.rows?.length===4&&!s.rows.some(r=>r.uuid===squareId)&&s.tombstones.some(r=>r.uuid===squareId)&&s.revision===s.confirmed&&!s.saving,60000);
 await clickElement('#pdfReaderBridgeUndoButton');await wait('undo durable',state,s=>s.rows?.length===5&&s.rows.some(r=>r.uuid===squareId)&&!s.tombstones.some(r=>r.uuid===squareId)&&s.revision===s.confirmed&&!s.saving,60000);
 await clickElement('#pdfReaderBridgeRedoButton');const redone=await wait('redo durable',state,s=>s.rows?.length===4&&!s.rows.some(r=>r.uuid===squareId)&&s.tombstones.some(r=>r.uuid===squareId)&&s.revision===s.confirmed&&!s.saving,60000);
 const finalIds=ids.filter(id=>id!==squareId);assert.deepEqual(redone.rows.map(r=>r.uuid).sort(),finalIds);
 await close();report.checks.reopenAfterRedo=await open();assert.deepEqual(report.checks.reopenAfterRedo.state.rows.map(r=>r.uuid).sort(),finalIds);
 assert.ok(report.checks.reopenAfterRedo.state.tombstones.some(r=>r.uuid===squareId));
 const durable=await disk.readCurrent(relative,pairId),history=await disk.readHistory(relative,pairId);
 assert.deepEqual(durable.annotations.map(r=>r.uuid).sort(),finalIds);assert.ok(durable.tombstones.some(r=>r.uuid===squareId));assert.ok(history.length>=8&&history.length<=100);
 report.checks.disk={revision:durable.revision,ids:durable.annotations.map(r=>r.uuid).sort(),historyCount:history.length,paths:disk.pathsFor(relative)};
 const finalTrace=evalJson(`JSON.stringify({append:globalThis.__v15NativeTrace.append,modify:globalThis.__v15NativeTrace.modify,serializations:globalThis.__v15NativeTrace.serializations,adapterWrites:globalThis.__v15NativeTrace.adapterWrites})`);
 assert.deepEqual(finalTrace,trace,'All later edits, undo, redo, and reopen must leave the PDF untouched');report.checks.finalSourceWriteTrace=finalTrace;
 assert.equal(await readPairId(await readFile(absolute)),pairId);assert.equal(sha(await readFile(absolute)),pairedSha);await close();
 await measureLargeFixture(String.raw`D:\Documents\Obsidian\测试插件\12_books\黑格尔的《精神现象学》.pdf`,'hegel');
 const legacyNames=(await readdir(path.join(nativeConfig.vault,'Books'))).filter(name=>/^v15-stop-smoking-[a-f0-9-]{36}\.pdf$/i.test(name));
 assert.equal(legacyNames.length,1,'Exactly one preverified 49/13 legacy fixture is required');
 await measureLargeFixture(String.raw`D:\Documents\Obsidian\远程仓库1\12_books\The Easy Way to Stop Smoking.pdf`,'stop-smoking',`Books/${legacyNames[0]}`);
 for(const [label,result] of Object.entries(report.checks.large)){
  assert.ok(result.annotationsReadyMs<=5000,`${label} first-open annotation readiness exceeded 5 seconds: ${result.annotationsReadyMs} ms`);
  assert.ok(result.reopenAnnotationsReadyMs<=5000,`${label} reopen annotation readiness exceeded 5 seconds: ${result.reopenAnnotationsReadyMs} ms`);
 }
 report.status='passed';
}catch(error){report.status='failed';report.errors.push(error?.stack||String(error));process.exitCode=1;}
finally{
 try{evalJson(`JSON.stringify((()=>{const l=globalThis.__v15LargeTrace;if(l){for(const row of l.originals)row.object[row.name]=row.original;delete globalThis.__v15LargeTrace}const t=globalThis.__v15NativeTrace;if(t){for(const row of t.pdfOriginals)row.pdf.saveDocument=row.original;for(const row of t.adapterOriginals)app.vault.adapter[row.name]=row.original;app.vault.appendBinary=t.originalAppend;app.vault.modifyBinary=t.originalModify;delete globalThis.__v15NativeTrace}return true})())`)}catch(error){report.errors.push(`trace cleanup: ${error.message}`);report.status='failed';process.exitCode=1;}
 await saveReport();console.log(JSON.stringify({status:report.status,reportPath,errors:report.errors}));
}
