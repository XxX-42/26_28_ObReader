import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-core';
import { build } from 'esbuild';
import { PDFDocument, PDFName, rgb, degrees } from 'pdf-lib';
import { launchTestBrowser } from './browser-test-launch.mjs';
import { cleanupBrowserTestResources, attachCleanupErrors } from './browser-test-cleanup.mjs';
import { resolveBrowserPath } from './browser-path.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('real PDF.js region images exclude native annotations, rotate correctly, refresh geometry and dispose', { timeout: 60000 }, async () => {
  const pdf = await PDFDocument.create();
  for (const rotation of [0,90,180,270]) {
    const page = pdf.addPage([600,800]); page.setCropBox(30,40,540,740); page.setRotation(degrees(rotation));
    page.drawRectangle({x:100,y:100,width:100,height:100,color:rgb(0,1,0)});
    page.drawRectangle({x:250,y:100,width:100,height:100,color:rgb(0,0,1)});
    const annotation = pdf.context.obj({ Type:'Annot', Subtype:'Square', Rect:[100,100,200,200], C:[1,0,0], IC:[1,0,0], Border:[0,0,20], F:4 });
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annotation)]));
  }
  const bytes = await pdf.save(); const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const bundle = await build({ entryPoints:[path.join(root,'plugin/rectangle-embed.cjs')], bundle:true,
    platform:'browser',format:'iife',globalName:'RectangleModule',write:false });
  const server = createServer(async (req,res) => {
    try {
      if (req.url === '/') { res.setHeader('Content-Type','text/html'); res.end('<div id="embed"></div>'); return; }
      if (req.url === '/fixture.pdf') { res.setHeader('Content-Type','application/pdf'); res.end(bytes); return; }
      const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if (!pathname.startsWith('/vendor/')) {res.writeHead(404).end();return;}
      res.setHeader('Content-Type',pathname.endsWith('.mjs')?'text/javascript':'application/octet-stream');
      res.end(await readFile(path.join(root,pathname.slice(1))));
    } catch {res.writeHead(404).end();}
  });
  let browser,page,error,cleanup;
  try {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    browser = await launchTestBrowser(puppeteer,{executablePath:resolveBrowserPath(),headless:true,args:['--no-sandbox']},{testName:'rectangle-region-browser'});
    page = await browser.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addScriptTag({content:bundle.outputFiles[0].text});
    const result = await page.evaluate(async () => {
      const lib = await import('/vendor/pdfjs-generic-legacy/build/pdf.mjs');
      lib.GlobalWorkerOptions.workerSrc='/vendor/pdfjs-generic-legacy/build/pdf.worker.mjs';
      const task=lib.getDocument('/fixture.pdf'); const pdf=await task.promise;
      window.fixtureDocument=pdf; window.fixtureTask=task;
      const colors=[];
      for(let n=1;n<=4;n++) {
        const p=await pdf.getPage(n);
        const viewport=p.getViewport({scale:3}),base=document.createElement('canvas');base.width=viewport.width;base.height=viewport.height;
        await p.render({canvasContext:base.getContext('2d'),viewport,annotationMode:0}).promise;
        const rendered={canvas:base,viewport,current:()=>true};
        if(await RectangleModule.cropRenderedPage(p,[100,100,200,200],rendered,{document}))throw Error('embedded annotation canvas must be rejected');
        const sourceOnlyPage=new Proxy(p,{get(target,key){if(key==='getAnnotations')return async()=>[];const value=target[key];return typeof value==='function'?value.bind(target):value;}});
        const lowViewport=p.getViewport({scale:1}),low=document.createElement('canvas');low.width=lowViewport.width;low.height=lowViewport.height;
        if(await RectangleModule.cropRenderedPage(sourceOnlyPage,[100,100,200,200],{canvas:low,viewport:lowViewport,current:()=>true},{document}))throw Error('lower-resolution canvas must not be upscaled');
        const fast=await RectangleModule.cropRenderedPage(sourceOnlyPage,[100,100,200,200],rendered,{document});
        const fastBitmap=await createImageBitmap(fast.blob),check=document.createElement('canvas');check.width=fastBitmap.width;check.height=fastBitmap.height;
        check.getContext('2d').drawImage(fastBitmap,0,0);
        if(JSON.stringify([...check.getContext('2d').getImageData(50,50,1,1).data])!==JSON.stringify([0,255,0,255]))throw Error('rendered crop rotation mismatch');
        fastBitmap.close();base.width=base.height=check.width=check.height=0;
        const image=await RectangleModule.renderRegion(p,[100,100,200,200],{document,pixelRatio:1});
        const bitmap=await createImageBitmap(image.blob); const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0); colors.push([...ctx.getImageData(50,50,1,1).data]);bitmap.close();canvas.width=canvas.height=0;
      }
      return colors;
    });
    for(const pixel of result) assert.deepEqual(pixel,[0,255,0,255],'unflattened PDF annotation must not enter cropped source image');
    const cropBenchmark=await page.evaluate(async()=>{
      const p=await fixtureDocument.getPage(1),runs=[];
      for(const rect of [[100,100,200,200],[100,100,350,350],[30,40,570,780]]){
        const samples=[];
        for(let i=0;i<5;i++){const start=performance.now();const image=await RectangleModule.renderRegion(p,rect,{document,pixelRatio:1});
          samples.push({ms:performance.now()-start,pngBytes:image.blob.size,rgbaBytes:image.width*image.height*4,width:image.width,height:image.height});}
        runs.push({rect,samples});
      }
      return runs;
    });
    await mkdir(path.join(root,'tests/artifacts/rectangle-region'),{recursive:true});
    await writeFile(path.join(root,'tests/artifacts/rectangle-region/crop-size-benchmark.json'),JSON.stringify({kind:'browser fixture; crop render only',cropBenchmark},null,2));
    await page.evaluate(async () => {
      class Component {constructor(){this.children=[];} load(){this.loaded=true;this.onload?.();} addChild(c){this.children.push(c);if(this.loaded)c.load?.();return c;} unload(){for(const c of this.children)c.unload?.();this.onunload?.();}}
      let originalCalls=0;
      const original=()=>{originalCalls++;return new Component();};
      const registry={embedByExtension:{pdf:original}};
      const file={path:'Books/A.pdf',basename:'A'};
      const row={uuid:'rect-uuid',kind:'Square',pageIndex:0,payload:{editor:{rect:[100,100,200,200]}}};
      window.regionTest={file,row,registry,original,opened:[],renders:0,resolutions:0,deleted:false};
      const plugin={app:{embedRegistry:registry},openPdf:async(f,target)=>{regionTest.opened.push({path:f.path,target});}};
      regionTest.options={plugin,Component,
        resolveTarget:async()=>{regionTest.resolutions++;if(regionTest.deleted)throw Error('矩形目标已删除');return {file:regionTest.file,document:{documentId:'D'},row,sourceHash:'verified',readerTarget:{kind:'annotation',id:row.uuid},annotationPath:'annotations/A.jsonl'};},
        acquireDocument:async()=>{regionTest.renders++;return {document:fixtureDocument,release(){}};}};
      regionTest.runtime=RectangleModule.createRectangleEmbeds(regionTest.options);
      await regionTest.runtime.prepare({target:{kind:'annotation',id:row.uuid}},file,document);
      if(regionTest.renders!==1)throw Error('preparing a copied region must render exactly one cropped image');
      regionTest.context={containerEl:document.getElementById('embed'),sourcePath:'Note.md'};
      regionTest.component=registry.embedByExtension.pdf(regionTest.context,file,'#page=1&obreader=ann.rect-uuid');
      regionTest.component.load();
      regionTest.getOriginalCalls=()=>originalCalls;
    });
    await page.waitForSelector('#embed img');
    const beforeSecond = await page.evaluate(()=>regionTest.resolutions);
    await page.evaluate(() => { const el=document.createElement('div');el.id='embed2';document.body.append(el);
      regionTest.component2=regionTest.registry.embedByExtension.pdf({containerEl:el,sourcePath:'Note.md'},regionTest.file,'#page=1&obreader=ann.rect-uuid');regionTest.component2.load(); });
    await page.waitForSelector('#embed2 img');
    assert.equal(await page.evaluate(()=>regionTest.resolutions),beforeSecond,'reopened identical embed reuses verified target until invalidation');
    const beforeShared = await page.evaluate(()=>regionTest.resolutions);
    await page.evaluate(()=>regionTest.runtime.invalidate('annotations/A.jsonl'));
    await page.waitForFunction((before)=>regionTest.resolutions>before && !!document.querySelector('#embed img') && !!document.querySelector('#embed2 img'),{},beforeShared);
    assert.equal(await page.evaluate((before)=>regionTest.resolutions-before,beforeShared),1,'identical concurrent embeds share target resolution');
    const readPixel=()=>page.evaluate(async()=>{const image=document.querySelector('#embed img');await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(50,50,1,1).data];});
    assert.deepEqual(await readPixel(),[0,255,0,255]);
    await page.waitForFunction(async()=>{const c=await caches.open('obreader-cropped-regions-v1');return (await c.keys()).length>0;});
    await page.evaluate(()=>{regionTest.runtime.dispose();regionTest.runtime=RectangleModule.createRectangleEmbeds(regionTest.options);
      regionTest.component=regionTest.registry.embedByExtension.pdf(regionTest.context,regionTest.file,'#page=1&obreader=ann.rect-uuid');regionTest.component.load();});
    await page.waitForSelector('#embed img');
    assert.deepEqual(await readPixel(),[0,255,0,255]);
    assert.equal(await page.evaluate(()=>regionTest.renders),1,'new runtime reads persisted crop without acquiring a PDF');
    await page.click('#embed img');
    assert.deepEqual(await page.evaluate(()=>regionTest.opened),[{path:'Books/A.pdf',target:{kind:'annotation',id:'rect-uuid'}}]);
    const oldImage = await page.$eval('#embed img', image => image.src);
    await page.evaluate(()=>{regionTest.row.payload.editor.rect=[250,100,350,200];regionTest.runtime.invalidate('annotations/A.jsonl',['rect-uuid']);});
    await page.waitForFunction((old)=>regionTest.renders===2&&document.querySelector('#embed img')?.src!==old,{},oldImage);
    assert.deepEqual(await readPixel(),[0,0,255,255],'current rect update must refresh crop with unchanged UUID');
    const unchangedImage = await page.$eval('#embed img', image => image.src);
    await page.evaluate(()=>regionTest.runtime.invalidate('annotations/A.jsonl',['different-uuid']));
    assert.equal(await page.$eval('#embed img', image => image.src),unchangedImage,'unrelated UUID must retain image');
    await page.evaluate(()=>regionTest.runtime.invalidate('annotations/A.jsonl'));
    await page.waitForSelector('#embed img');
    assert.equal(await page.$eval('#embed img', image => image.src),unchangedImage,'unchanged image remains visible during file event');
    assert.equal(await page.evaluate(()=>regionTest.renders),2,'equivalent region must reuse bounded image cache');
    await page.evaluate(()=>{regionTest.file.path='Moved/新名称.pdf';regionTest.runtime.invalidate();});
    await page.waitForSelector('#embed img'); await page.click('#embed img');
    await page.waitForFunction(()=>regionTest.opened.at(-1)?.path==='Moved/新名称.pdf');
    assert.equal(await page.evaluate(()=>regionTest.opened.at(-1).path),'Moved/新名称.pdf');
    await page.evaluate(()=>{regionTest.deleted=true;regionTest.runtime.invalidate();});
    await page.waitForFunction(()=>document.getElementById('embed').textContent.includes('已删除'));
    assert.equal(await page.$('#embed img'),null);
    const teardown=await page.evaluate(async()=>{regionTest.component.unload();regionTest.runtime.dispose();const r={size:regionTest.runtime.size,restored:regionTest.registry.embedByExtension.pdf===regionTest.original,children:document.getElementById('embed').children.length};await fixtureTask.destroy();return r;});
    assert.deepEqual(teardown,{size:0,restored:true,children:0});
    assert.equal(createHash('sha256').update(bytes).digest('hex'),sourceHash);
  } catch(e) {error=e;await mkdir(path.join(root,'tests/artifacts/rectangle-region'),{recursive:true});if(page){await page.screenshot({path:path.join(root,'tests/artifacts/rectangle-region/browser-failure.png')});await writeFile(path.join(root,'tests/artifacts/rectangle-region/browser-failure.txt'),e.stack);}}
  finally {cleanup=await cleanupBrowserTestResources({browser,ownedPages:page?[page]:[],server});}
  const failure=attachCleanupErrors(error,cleanup);if(failure)throw failure;
});
