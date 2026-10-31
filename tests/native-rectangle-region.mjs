// Native-only acceptance: all files are new fixtures in the configured test Vault.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeEvalJson, nativeCdp, nativeConfig, assertNativeVaultIdentity } from './native-config.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=`rectangle-${Date.now()}`, directory=`Native Region Tests/${run}`;
const output=path.join(root,'tests/artifacts/rectangle-region',run);await mkdir(output,{recursive:true});
const evaluate=(code)=>nativeEvalJson(`(async()=>{${code}})().then(value=>JSON.stringify(value))`,60000);
const wait=async(code,label)=>{for(let i=0;i<80;i++){const result=await evaluate(code);if(result)return result;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(`Native boundary not reached: ${label}`);};
const report={run,directory};let installed=false;
try {
  const identity=await evaluate(`return {vault:app.vault.adapter.basePath,configDir:app.vault.configDir,readers:app.workspace.getLeavesOfType('pdf-web-reader-view').length}`);
  assertNativeVaultIdentity(identity);assert.equal(identity.readers,0);
  const bytes=await readFile(path.join(root,'tests/fixtures/tracemonkey.pdf'));
  report.initialSha=createHash('sha256').update(bytes).digest('hex');
  const source=path.join(root,'plugin/pdf-annotation-host.cjs');
  const setup=await evaluate(`
    const p=app.plugins.plugins['pdf-web-reader'];if(!p.rectangleEmbeds)throw Error('Region runtime not installed');
    const namespace=${JSON.stringify(directory+'/data')},normalRoot='00_Archive/20_PDFData';
    const real=app.vault.adapter;
    const mapped=path=>typeof path==='string'&&(path===normalRoot||path.startsWith(normalRoot+'/'))?namespace+path.slice(normalRoot.length):path;
    const unmapped=path=>path.startsWith(namespace)?normalRoot+path.slice(namespace.length):path;
    const adapter=new Proxy(real,{get(target,key){
      if(key==='list')return async path=>{const result=await target.list(mapped(path));return {files:result.files.map(unmapped),folders:result.folders.map(unmapped)};};
      if(['exists','read','readBinary','stat','mkdir','write','writeBinary','append','remove','rmdir','process'].includes(key))return (path,...args)=>target[key](mapped(path),...args);
      if(key==='rename')return (from,to)=>target.rename(mapped(from),mapped(to));
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
    const r=app.__regionNative={directory:${JSON.stringify(directory)},originalHost:p.annotationHost,sourceWrites:0,saveCalls:0,links:[]};
    const vault=new Proxy(app.vault,{get(target,key){if(key==='adapter')return adapter;
      const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    const scopedApp=new Proxy(app,{get(target,key){if(key==='vault')return vault;const value=target[key];return typeof value==='function'?value.bind(target):value;}});
    const {createPdfAnnotationHost}=require(${JSON.stringify(source)});
    r.host=createPdfAnnotationHost({app:scopedApp,enableJsonl:true,enableSingleJsonl:true,
      hashRuntime:p.pdfHashRuntime,identityHash:bytes=>'sha256-v1:'+require('crypto').createHash('sha256').update(bytes).digest('hex'),
      inspectLegacy:bytes=>p.getLegacyMergeClient().inspect({bytes,fastOpen:true}),
      verifyOutlineUpdate:payload=>p.verifyOutlineSource(payload),reopenVerifiedView:(view,file)=>view.openFile(file),
      normalizePath:path=>path,makeToken:()=>crypto.randomUUID(),deviceId:'native-region',Notice:class{constructor(message){console.log(message);}}});
    p.annotationHost=r.host;
    let folder='';for(const segment of r.directory.split('/')){folder=folder?folder+'/'+segment:segment;if(!await real.exists(folder))await real.mkdir(folder);}
    await real.mkdir(r.directory+'/Books');await real.mkdir(r.directory+'/Notes');r.pdfPath=r.directory+'/Books/区域 测试.pdf';
    await app.vault.createBinary(r.pdfPath,new Uint8Array(require('fs').readFileSync(${JSON.stringify(path.join(root,'tests/fixtures/tracemonkey.pdf'))})).buffer);
    r.originalCopy=p.copyReaderText;p.copyReaderText=async text=>{r.links.push(text);await r.originalCopy.call(p,text);};
    r.originalOpen=p.openPdf;r.openTargets=[];p.openPdf=async function(file,target,...args){if(target)r.openTargets.push({path:file.path,target});return r.originalOpen.call(p,file,target,...args);};
    r.originalModify=app.vault.modifyBinary;app.vault.modifyBinary=async function(file,...args){if(file.path.startsWith(r.directory+'/'))r.sourceWrites++;return r.originalModify.call(app.vault,file,...args);};
    const win=require('@electron/remote').getCurrentWindow();win.show();win.moveTop();win.focus();
    await p.openPdf(app.vault.getAbstractFileByPath(r.pdfPath));return {pdfPath:r.pdfPath};`);
  installed=true;report.setup=setup;
  await nativeCdp('Page.bringToFront');
  await wait(`const r=app.__regionNative;const p=app.plugins.plugins['pdf-web-reader'];r.view=[...p.views].find(v=>v.documentFile?.path===r.pdfPath);const w=r.view?.iframe?.contentWindow;return !!(r.view?.annotationHydrationAllowed&&w?.PDFViewerApplication?.pdfViewer?.getPageView(0)?.renderingState===3);`,'first page verified');
  report.before=await evaluate(`const r=app.__regionNative,w=r.view.iframe.contentWindow;const original=w.PDFViewerApplication.pdfDocument.saveDocument.bind(w.PDFViewerApplication.pdfDocument);w.PDFViewerApplication.pdfDocument.saveDocument=(...args)=>{r.saveCalls++;return original(...args)};return {readOnly:r.view.annotationHydrationAllowed,page:w.PDFViewerApplication.pdfViewer.currentPageNumber};`);
  const rect=await evaluate(`const r=app.__regionNative,f=r.view.iframe.getBoundingClientRect(),w=r.view.iframe.contentWindow;
    const button=w.document.getElementById('pdfReaderRectangleRegionButton');if(!button||button.disabled)throw Error('Rectangle button unavailable');button.click();
    const page=w.document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
    return {x:f.x+page.x+page.width*.2,y:f.y+page.y+page.height*.2,x2:f.x+page.x+page.width*.65,y2:f.y+page.y+page.height*.32};`);
  report.dragTarget=await evaluate(`const r=app.__regionNative, f=r.view.iframe.getBoundingClientRect(), w=r.view.iframe.contentWindow;
    const hit=document.elementFromPoint(${rect.x},${rect.y}),inner=w.document.elementFromPoint(${rect.x}-f.x,${rect.y}-f.y);
    return {point:${JSON.stringify(rect)},outerHit:hit?.tagName,iframeHit:hit===r.view.iframe,innerHit:inner?.className,visibility:document.visibilityState,focus:document.hasFocus()};`);
  await evaluate(`const r=app.__regionNative,w=r.view.iframe.contentWindow;r.inputEvents=[];r.inputProbe=e=>r.inputEvents.push({type:e.type,x:e.clientX,y:e.clientY,buttons:e.buttons,trusted:e.isTrusted});
    for(const name of ['pointerdown','pointermove','pointerup'])w.document.addEventListener(name,r.inputProbe,true);return true;`);
  await wait(`return app.__regionNative.view.iframe.contentWindow.PDFViewerApplication.pdfViewer.annotationEditorMode===5;`,'Square tool');
  nativeCdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x,y:rect.y});
  nativeCdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:rect.x,y:rect.y});
  for(let i=1;i<=10;i++)nativeCdp('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:rect.x+(rect.x2-rect.x)*i/10,y:rect.y+(rect.y2-rect.y)*i/10});
  nativeCdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:rect.x2,y:rect.y2});
  report.afterDraw=await wait(`const r=app.__regionNative;return r.links.length?{links:r.links,mode:r.view.iframe.contentWindow.PDFViewerApplication.pdfViewer.annotationEditorMode}:null;`,'durable rectangle and automatic embed copy');
  assert.equal(report.afterDraw.links.length,1);assert.match(report.afterDraw.links[0],/^!\[\[/);assert.equal(report.afterDraw.mode,0);
  report.saved=await evaluate(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];const state=await p.annotationHost.store.readDocument(r.view.annotationDocument,{readOnly:true});
    const bytes=new Uint8Array(await app.vault.readBinary(r.view.documentFile));r.pairedSha=require('crypto').createHash('sha256').update(bytes).digest('hex');r.pairedXxh=p.pdfHashRuntime.fingerprint(bytes);
    r.sourceWrites=0;r.savedRows=state.annotations;r.link=r.links[0];r.notePath=r.directory+'/Notes/区域笔记.md';await app.vault.create(r.notePath,r.link);
    r.firstProfile=[];r.restoreProfile=[];
    const wrap=(obj,key)=>{const original=obj[key];obj[key]=async function(...args){const start=performance.now();try{return await original.apply(this,args)}finally{r.firstProfile.push({stage:key,ms:performance.now()-start})}};r.restoreProfile.push(()=>obj[key]=original);};
    wrap(p,'resolveRectangleEmbedTarget');wrap(p.rectangleDocumentPool,'acquire');wrap(r.host.store,'readDocument');wrap(app.vault,'readBinary');
    const doc=r.view.iframe.contentWindow.PDFViewerApplication.pdfDocument,originalGetPage=doc.getPage;
    doc.getPage=async function(...args){const start=performance.now(),page=await originalGetPage.apply(this,args);r.firstProfile.push({stage:'getPage',ms:performance.now()-start});
      const originalRender=page.render;page.render=function(...renderArgs){const start=performance.now(),task=originalRender.apply(this,renderArgs);task.promise.finally(()=>r.firstProfile.push({stage:'pageRender',ms:performance.now()-start})).catch(()=>{});return task};
      r.restoreProfile.push(()=>page.render=originalRender);return page};r.restoreProfile.push(()=>doc.getPage=originalGetPage);
    const canvasProto=r.view.iframe.contentWindow.HTMLCanvasElement.prototype,originalBlob=canvasProto.toBlob;
    canvasProto.toBlob=function(callback,...args){const start=performance.now();return originalBlob.call(this,blob=>{r.firstProfile.push({stage:'canvasToBlob',ms:performance.now()-start});callback(blob)},...args)};
    r.restoreProfile.push(()=>canvasProto.toBlob=originalBlob);
    r.firstEmbedStart=performance.now();r.firstEmbedTiming=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{observer.disconnect();reject(Error('first embed timing timeout'))},15000);
      const observer=new MutationObserver(()=>{const img=[...document.querySelectorAll('.pdfReaderRectangleEmbed img')].find(x=>x.getBoundingClientRect().width>0);if(!img)return;
        observer.disconnect();img.decode().then(()=>{clearTimeout(timer);resolve(performance.now()-r.firstEmbedStart)},reject)});
      observer.observe(document.body,{childList:true,subtree:true});});
    const leaf=app.workspace.getLeaf(true),mountStart=performance.now();await leaf.openFile(app.vault.getAbstractFileByPath(r.notePath));r.firstProfile.push({stage:'openMarkdown',ms:performance.now()-mountStart});r.mdLeaf=leaf;
    return {annotations:state.annotations,pairId:r.view.annotationDocument.pairId,sha:r.pairedSha,xxh:r.pairedXxh,saveCalls:r.saveCalls};`);
  assert.equal(report.saved.annotations.length,1);assert.equal(report.saved.annotations[0].kind,'Square');assert.equal(report.saved.saveCalls,0);
  await wait(`return !!document.querySelector('.pdfReaderRectangleEmbed img');`,'real Markdown embed');
  report.firstEmbedMs=await evaluate(`return await app.__regionNative.firstEmbedTiming;`);
  report.firstEmbedProfile=await evaluate(`const r=app.__regionNative;r.restoreProfile.splice(0).reverse().forEach(f=>f());return r.firstProfile;`);
  report.embed=await evaluate(`const img=[...document.querySelectorAll('.pdfReaderRectangleEmbed img')].find(img=>img.getBoundingClientRect().width>0);await img.decode();return {width:img.naturalWidth,height:img.naturalHeight,alt:img.alt};`);
  assert.ok(report.embed.width>0&&report.embed.height>0);
  report.warmReopenMs=[];
  for(let i=0;i<5;i++) {
    await evaluate(`const r=app.__regionNative;await r.mdLeaf.setViewState({type:'markdown',state:{file:r.notePath,mode:'source',source:true}});return true;`);
    report.warmReopenMs.push(await evaluate(`const r=app.__regionNative,t=performance.now();let done=false;
      const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(Error('embed timing timeout'))},10000);
        const observer=new MutationObserver(()=>{if(done)return;const img=[...document.querySelectorAll('.pdfReaderRectangleEmbed img')].find(x=>x.getBoundingClientRect().width>0);if(!img)return;done=true;img.decode().then(()=>{clearTimeout(timer);observer.disconnect();resolve(performance.now()-t)},reject)});observer.observe(document.body,{childList:true,subtree:true});});
      await r.mdLeaf.setViewState({type:'markdown',state:{file:r.notePath,mode:'preview'}});return await ready;`));
  }
  const shot=nativeCdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,'markdown-embed.png'),Buffer.from(shot.data,'base64'));
  report.readingMode=await evaluate(`const r=app.__regionNative;await r.mdLeaf.setViewState({type:'markdown',state:{file:r.notePath,mode:'preview'}});return r.mdLeaf.view.getMode();`);
  await wait(`return [...document.querySelectorAll('.pdfReaderRectangleEmbed img')].some(img=>img.getBoundingClientRect().width>0&&img.naturalWidth>0);`,'reading view image');
  assert.equal(report.readingMode,'preview');
  report.livePreviewMode=await evaluate(`const r=app.__regionNative;await r.mdLeaf.setViewState({type:'markdown',state:{file:r.notePath,mode:'source',source:false}});return r.mdLeaf.view.getState();`);
  await wait(`return [...document.querySelectorAll('.pdfReaderRectangleEmbed img')].some(img=>img.getBoundingClientRect().width>0&&img.naturalWidth>0);`,'Live Preview image');
  assert.equal(report.livePreviewMode.mode,'source');assert.notEqual(report.livePreviewMode.source,true);
  await evaluate(`const r=app.__regionNative;await r.mdLeaf.setViewState({type:'markdown',state:{file:r.notePath,mode:'preview'}});return true;`);
  // Close Reader completely, force the frozen-library closed-PDF rendering path.
  await evaluate(`const r=app.__regionNative;await r.view.prepareControlledClose('native-region-test');r.view.leaf.detach();
    const p=app.plugins.plugins['pdf-web-reader'];p.rectangleEmbeds.invalidate();return {readers:app.workspace.getLeavesOfType('pdf-web-reader-view').length};`);
  report.memoryBeforeClosedCrop=await evaluate(`return await process.getProcessMemoryInfo();`);
  // New region geometry forces a cache miss after Reader teardown.
  report.closedPdf=await evaluate(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];r.savedImageWidth=${report.embed?.width || 0};const file=app.vault.getAbstractFileByPath(r.pdfPath);
    const document=await p.annotationHost.store.documentForPath(file.path);const row=JSON.parse(JSON.stringify(r.savedRows[0]));row.payload.editor.rect[2]-=5;
    await p.annotationHost.store.appendOperations({document,sourceHash:document.source.sourceHash,operations:[row]});p.rectangleEmbeds.invalidate();return {uuid:row.uuid,rect:row.payload.editor.rect};`);
  await wait(`const r=app.__regionNative;const img=[...document.querySelectorAll('.pdfReaderRectangleEmbed img')].find(img=>img.getBoundingClientRect().width>0);return img&&img.naturalWidth>0&&img.naturalWidth!==r.savedImageWidth?{width:img.naturalWidth,height:img.naturalHeight}:null;`,'closed PDF crop render');
  report.memoryAfterClosedCrop=await evaluate(`return await process.getProcessMemoryInfo();`);
  const point=await evaluate(`const img=[...document.querySelectorAll('.pdfReaderRectangleEmbed img')].find(img=>img.getBoundingClientRect().width>0);if(!img)throw Error('Visible image unavailable');const box=img.getBoundingClientRect();const x=box.x+box.width/2,y=box.y+box.height/2;if(document.elementFromPoint(x,y)!==img)throw Error('Image hit target blocked');return {x,y};`);
  nativeCdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
  nativeCdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});
  report.reopened=await wait(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];r.view=[...p.views].find(v=>v.documentFile?.path===r.pdfPath);return r.view?.annotationHydrationAllowed?{id:r.view.pendingReaderTarget?.id||r.view.readerTarget?.id,annotations:(await p.annotationHost.store.readDocument(r.view.annotationDocument,{readOnly:true})).annotations}:null;`,'image navigation reopens Reader');
  assert.equal(report.reopened.annotations[0].uuid,report.saved.annotations[0].uuid);
  report.navigation=await evaluate(`return app.__regionNative.openTargets;`);
  assert.equal(report.navigation.at(-1).target.kind,'annotation');assert.equal(report.navigation.at(-1).target.id,report.saved.annotations[0].uuid);
  report.rename=await evaluate(`const r=app.__regionNative;const file=app.vault.getAbstractFileByPath(r.pdfPath);r.oldPdfPath=r.pdfPath;r.pdfPath=r.directory+'/Books/PDF 改名.pdf';
    await app.fileManager.renameFile(file,r.pdfPath);const note=app.vault.getAbstractFileByPath(r.notePath);r.notePath=r.directory+'/Notes/Markdown 改名.md';await app.fileManager.renameFile(note,r.notePath);return {pdf:r.pdfPath,note:r.notePath};`);
  await wait(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];const route=await p.annotationHost.store.documentForIdentity({docKey:r.savedRows[0]?r.view.annotationDocument.docKey:'',documentId:r.view.annotationDocument.documentId});return route?.sourcePath===r.pdfPath;`,'actual PDF identity route rename');
  report.renameAfter=await evaluate(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];await app.workspace.revealLeaf(r.mdLeaf);await r.mdLeaf.setViewState({type:'markdown',state:{file:r.notePath,mode:'preview'}});p.rectangleEmbeds.invalidate();return {note:await app.vault.read(app.vault.getAbstractFileByPath(r.notePath))};`);
  assert.ok(report.renameAfter.note.includes(report.saved.annotations[0].uuid));
  await wait(`return [...document.querySelectorAll('.pdfReaderRectangleEmbed img')].some(img=>img.getBoundingClientRect().width>0&&img.naturalWidth>0);`,'renamed Markdown region');
  const renamedPoint=await evaluate(`const img=[...document.querySelectorAll('.pdfReaderRectangleEmbed img')].find(img=>img.getBoundingClientRect().width>0);const box=img.getBoundingClientRect();return {x:box.x+box.width/2,y:box.y+box.height/2};`);
  nativeCdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...renamedPoint});
  nativeCdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...renamedPoint});
  report.renamedNavigation=await wait(`const r=app.__regionNative;return r.openTargets.at(-1)?.path===r.pdfPath?r.openTargets.at(-1):null;`,'renamed embed exact navigation');
  assert.equal(report.renamedNavigation.target.id,report.saved.annotations[0].uuid);
  report.parentMove=await evaluate(`const r=app.__regionNative;await app.fileManager.renameFile(app.vault.getAbstractFileByPath(r.directory+'/Books'),r.directory+'/Archive');
    r.pdfPath=r.directory+'/Archive/PDF 改名.pdf';await app.fileManager.renameFile(app.vault.getAbstractFileByPath(r.directory+'/Notes'),r.directory+'/MovedNotes');r.notePath=r.directory+'/MovedNotes/Markdown 改名.md';return {pdf:r.pdfPath,note:r.notePath};`);
  await wait(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];const route=await p.annotationHost.store.documentForIdentity({docKey:r.view.annotationDocument.docKey,documentId:r.view.annotationDocument.documentId});return route.sourcePath===r.pdfPath;`,'parent folder identity route');
  report.parentResolved=await evaluate(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];const link=await app.vault.read(app.vault.getAbstractFileByPath(r.notePath));const params=new URLSearchParams(link.split('#')[1].split('|')[0].split(']]')[0]);
    const resolved=await p.resolveReaderLinkDocument({docKey:params.get('docKey'),documentId:params.get('obdoc'),pageNumber:Number(params.get('page')),target:{kind:'annotation',id:params.get('obreader').slice(4)}},r.oldPdfPath,r.notePath);return {path:resolved.file.path,id:resolved.readerTarget.id};`);
  assert.equal(report.parentResolved.path,report.parentMove.pdf);assert.equal(report.parentResolved.id,report.saved.annotations[0].uuid);
  await evaluate(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];await p.openPdf(app.vault.getAbstractFileByPath(r.pdfPath));return true;`);
  await wait(`const r=app.__regionNative;return r.view?.iframe?.getBoundingClientRect().width>0;`,'visible Reader for reverse drag');
  const reverse=await evaluate(`const r=app.__regionNative,w=r.view.iframe.contentWindow,f=r.view.iframe.getBoundingClientRect();
    const pdf=w.PDFViewerApplication.pdfDocument,save=pdf.saveDocument.bind(pdf);pdf.saveDocument=(...args)=>{r.saveCalls++;return save(...args);};
    w.document.getElementById('pdfReaderRectangleRegionButton').click();const box=w.document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
    return {x:f.x+box.x+box.width*.7,y:f.y+box.y+box.height*.45,x2:f.x+box.x+box.width*.3,y2:f.y+box.y+box.height*.38};`);
  await wait(`return app.__regionNative.view.iframe.contentWindow.PDFViewerApplication.pdfViewer.annotationEditorMode===5;`,'reverse Square tool');
  nativeCdp('Input.dispatchMouseEvent',{type:'mouseMoved',x:reverse.x,y:reverse.y});
  nativeCdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:reverse.x,y:reverse.y});
  for(let i=1;i<=10;i++)nativeCdp('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:reverse.x+(reverse.x2-reverse.x)*i/10,y:reverse.y+(reverse.y2-reverse.y)*i/10});
  nativeCdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:reverse.x2,y:reverse.y2});
  report.reverseDrag=await wait(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];if(r.links.length!==2)return null;return {links:r.links,annotations:(await p.annotationHost.store.readDocument(r.view.annotationDocument,{readOnly:true})).annotations};`,'reverse drag saved and copied once');
  assert.equal(report.reverseDrag.annotations.length,2);assert.equal(new Set(report.reverseDrag.annotations.map(row=>row.uuid)).size,2);
  assert.ok(report.reverseDrag.annotations.some(row=>row.uuid===report.saved.annotations[0].uuid));
  report.final=await evaluate(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];const bytes=new Uint8Array(await app.vault.readBinary(app.vault.getAbstractFileByPath(r.pdfPath)));return {sha:require('crypto').createHash('sha256').update(bytes).digest('hex'),xxh:p.pdfHashRuntime.fingerprint(bytes),saveCalls:r.saveCalls,sourceWrites:r.sourceWrites};`);
  assert.equal(report.final.sourceWrites,0);
  assert.equal(report.final.sha,report.saved.sha);assert.equal(report.final.xxh,report.saved.xxh);assert.equal(report.final.saveCalls,0);
  report.pass=true;
} catch(error){report.error=error.stack;
  if(installed) try { report.failureState=await evaluate(`const r=app.__regionNative,v=r.view,w=v?.iframe?.contentWindow;
    return {links:r.links,mode:w?.PDFViewerApplication?.pdfViewer?.annotationEditorMode,sourceWrites:r.sourceWrites,
      saving:v?.saving,pending:!!v?.pendingBytes,visible:document.visibilityState,focused:document.hasFocus(),
      editors:w?.document.querySelectorAll('.squareEditor').length,inputEvents:r.inputEvents};`);
    const screenshot=nativeCdp('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,'failure.png'),Buffer.from(screenshot.data,'base64'));
  } catch(diagnosticError) { report.diagnosticError=diagnosticError.stack; }
  throw error;}
finally {
  if(installed)try {report.cleanup=await evaluate(`const r=app.__regionNative,p=app.plugins.plugins['pdf-web-reader'];
    r.restoreProfile?.splice(0).reverse().forEach(f=>f());
    if(r.inputProbe && r.view?.iframe?.contentWindow)for(const name of ['pointerdown','pointermove','pointerup'])r.view.iframe.contentWindow.document.removeEventListener(name,r.inputProbe,true);
    for(const leaf of app.workspace.getLeavesOfType('pdf-web-reader-view').filter(l=>l.view.documentFile?.path?.startsWith(r.directory+'/'))){await leaf.view.prepareControlledClose('native-region-cleanup');leaf.detach();}
    r.mdLeaf?.detach();p.copyReaderText=r.originalCopy;p.openPdf=r.originalOpen;app.vault.modifyBinary=r.originalModify;r.host.dispose();p.annotationHost=r.originalHost;return {restored:p.annotationHost===r.originalHost};`);}catch(error){report.cleanupError=error.stack;}
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report},null,2));
}
