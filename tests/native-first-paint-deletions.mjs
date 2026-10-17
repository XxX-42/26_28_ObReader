import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
const cfg=JSON.parse(await readFile('/tmp/obreader-native-local.json','utf8'));
assert.equal(cfg.vault,'/Users/jiajia/Documents/ObReader-Apple-Test');
const expected=process.env.NATIVE_VERSION||'0.9.1';
const port=(await readFile(cfg.profile+'/DevToolsActivePort','utf8')).split('\n')[0];
const browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});
const page=(await browser.pages()).find(p=>p.url()==='app://obsidian.md/index.html');
const session=await page.createCDPSession();await session.send('Emulation.setFocusEmulationEnabled',{enabled:true});
const report={version:expected,vault:cfg.vault,physicalIpadValidated:false};
try {
 const initial=await page.evaluate(({vault,version})=>{
  if(app.vault.adapter.basePath!==vault||app.plugins.plugins['pdf-web-reader']?.manifest.version!==version)throw Error('Wrong native runtime');
  if(app.plugins.plugins['pdf-web-reader'].views.size)throw Error('Close only previous test views before start');
  window.__nativeFirstPaint={jobs:[],results:[]};
  const listener=event=>{
   const w=event.detail?.source;if(!w?.PDFViewerApplication)return;
   const a=w.PDFViewerApplication;
   a.initializedPromise.then(()=>{
    a.eventBus._on('pagesinit',()=>{a.pdfViewer.currentPageNumber=2;a.pdfViewer.currentScaleValue='page-fit';});
    let recorded=false;
    a.eventBus._on('pagerendered',({pageNumber})=>{
     if(pageNumber!==2||recorded)return;recorded=true;
     const pv=a.pdfViewer.getPageView(1),canvas=pv.canvas;
     const actual=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.slice();
     const c=w.document.createElement('canvas');c.width=canvas.width;c.height=canvas.height;
     const job=pv.pdfPage.render({canvasContext:c.getContext('2d'),viewport:pv.viewport,annotationMode:0,transform:pv.outputScale.scaled?[pv.outputScale.sx,0,0,pv.outputScale.sy,0,0]:null}).promise.then(()=>{
      const control=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let changed=0;
      for(let i=0;i<actual.length;i+=4)if(Math.abs(actual[i]-control[i])+Math.abs(actual[i+1]-control[i+1])+Math.abs(actual[i+2]-control[i+2])>30)changed++;
      window.__nativeFirstPaint.results.push({pageNumber,changed,pixels:c.width*c.height});
     });window.__nativeFirstPaint.jobs.push(job);
    });
   });
  };window.__nativePaintListener=listener;document.addEventListener('webviewerloaded',listener,true);
  return {mobile:app.isMobile,version:app.plugins.plugins['pdf-web-reader'].manifest.version};
 },{vault:cfg.vault,version:expected});report.initial=initial;
 await page.evaluate(async({vault,file})=>{if(app.vault.adapter.basePath!==vault)throw Error('Wrong vault');await app.plugins.plugins['pdf-web-reader'].openPdf(app.vault.getAbstractFileByPath(file));},{vault:cfg.vault,file:cfg.pdf});
 await page.waitForFunction(()=>window.__nativeFirstPaint.results.length>0,{timeout:30000});
 report.firstPaints=await page.evaluate(()=>window.__nativeFirstPaint.results);
 assert.ok(report.firstPaints.every(p=>p.changed===0),'first source paint must equal annotation-disabled control; no deleted source marks may flash');report.status='passed';
}catch(e){report.status='failed';report.failure=e.stack;process.exitCode=1;}
finally{
 await page.evaluate(async vault=>{if(app.vault.adapter.basePath!==vault)throw Error('Wrong vault');document.removeEventListener('webviewerloaded',window.__nativePaintListener,true);for(const v of [...app.plugins.plugins['pdf-web-reader'].views])await v.leaf.detach();},cfg.vault);
 await writeFile(`evidence/first-render-${expected}/native-first-${expected}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await browser.disconnect();
}
