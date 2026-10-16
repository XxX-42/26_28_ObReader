import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import puppeteer from "puppeteer-core";
import { PDFDocument } from "pdf-lib";
import { resolveBrowserPath } from "./browser-path.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { cleanupBrowserTestResources } from "./browser-test-cleanup.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("native PDF annotation scan recognizes supported source marks and excludes links", { timeout: 60_000 }, async () => {
  const supplied = process.env.PDF_READER_EMBEDDED_INSPECTION_SOURCE;
  let bytes;
  if (supplied) {
    // Explicit opt-in only. The original is read, copied to the independent
    // test vault, and hashed again after inspection; it is never written.
    const dir = "/Users/jiajia/Documents/ObReader-Apple-Test/ObReader-Bulk-Tests";
    await mkdir(dir, { recursive: true });
    const copy = path.join(dir, `source-inspection-${Date.now()}.pdf`);
    await copyFile(supplied, copy);
    bytes = await readFile(copy);
  } else {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 3; i++) pdf.addPage([300, 400]);
    const ctx = pdf.context;
    const shapes = [
      { Type: "Annot", Subtype: "Ink", Rect: [20, 20, 100, 100], C: [1, 0, 0], CA: 1, BS: { W: 2 }, InkList: [[25, 25, 60, 60]] },
      { Type: "Annot", Subtype: "Highlight", Rect: [20, 100, 180, 120], C: [1, 1, 0], CA: 0.5, QuadPoints: [20, 120, 180, 120, 20, 100, 180, 100] },
      { Type: "Annot", Subtype: "Square", Rect: [20, 140, 100, 200], C: [0, 0, 1], CA: 1, BS: { W: 2 } },
      { Type: "Annot", Subtype: "Link", Rect: [20, 220, 100, 250], A: { S: "URI", URI: "https://example.invalid" } },
    ];
    shapes.forEach((shape, i) => pdf.getPages()[i % 3].node.addAnnot(ctx.register(ctx.obj(shape))));
    bytes = Buffer.from(await pdf.save());
  }
  const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
  const before = sha(bytes);
  let browser;
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (pathname === "/") return res.end('<!doctype html><script type="module">import * as lib from "/pdfjs/build/pdf.mjs"; lib.GlobalWorkerOptions.workerSrc="/pdfjs/build/pdf.worker.mjs"; window.lib=lib;</script>');
      if (pathname === "/source.pdf") { res.setHeader("Content-Type", "application/pdf"); return res.end(bytes); }
      if (pathname === "/controller.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(await readFile(path.join(root, "viewer-adapter/input/annotation-controller.js"))); }
      if (!pathname.startsWith("/pdfjs/")) { res.statusCode = 404; return res.end(); }
      const dir = path.join(root, "vendor/pdfjs-generic-legacy");
      const target = path.resolve(dir, pathname.slice(7));
      if (!target.startsWith(`${dir}/`)) { res.statusCode = 403; return res.end(); }
      res.setHeader("Content-Type", target.endsWith(".mjs") ? "text/javascript" : "application/octet-stream");
      res.end(await readFile(target));
    } catch { res.statusCode = 404; res.end(); }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    browser = await launchTestBrowser(puppeteer, { executablePath: resolveBrowserPath(), headless: true, args: ["--no-sandbox"] }, { testName: "embedded-annotation-scan" });
    const page = await browser.newPage();
    page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));
    page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE_ERROR',m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => !!window.lib);
    await page.addScriptTag({ url: `http://127.0.0.1:${server.address().port}/controller.js` });
    const result = await page.evaluate(async () => {
      const pdf = await window.lib.getDocument({ url: "/source.pdf" }).promise;
      const controller = new PdfReaderInputRuntime.AnnotationController();
      const targets = await controller.scanEmbeddedDeletionTargets(pdf, "source-inspection");
      const raw = {};
      const skipped = [];
      const refs = new Set(targets.map((row) => row.ref));
      for (let i = 1; i <= pdf.numPages; i++) {
        for (const annotation of await (await pdf.getPage(i)).getAnnotations({ intent: "any" })) {
          raw[annotation.annotationType] = (raw[annotation.annotationType] || 0) + 1;
          if ([5, 9, 15].includes(annotation.annotationType) && !refs.has(annotation.id)) skipped.push({
            type: annotation.annotationType, rotation: annotation.rotation,
            colorLength: annotation.color?.length, opacity: annotation.opacity,
            width: annotation.borderStyle?.rawWidth,
            rectNondegenerate: annotation.rect?.[0] < annotation.rect?.[2] && annotation.rect?.[1] < annotation.rect?.[3],
            inkLengths: annotation.inkLists?.map((line) => line.length), quadLength: annotation.quadPoints?.length,
          });
        }
      }
      const counts = {};
      for (const target of targets) counts[target.kind] = (counts[target.kind] || 0) + 1;
      const result = { pages: pdf.numPages, raw, skipped, count: targets.length, counts,
        unique: new Set(targets.map((row) => row.uuid)).size,
        refsValid: targets.every((row) => /^\d+R\d*$/.test(row.ref)) };
      await pdf.destroy();
      return result;
    });
    console.log(JSON.stringify({ ...result, sourceSha256: before }));
    if (!supplied) assert.deepEqual(result.counts, { Ink: 1, Highlight: 1, Square: 1 });
    else assert.equal(result.count, (result.raw[15] || 0) + (result.raw[9] || 0) + (result.raw[5] || 0));
    assert.equal(result.unique, result.count);
    assert.equal(result.refsValid, true);
    if (supplied) assert.equal(sha(await readFile(supplied)), before, "the original PDF remains byte-identical");
    console.log(JSON.stringify({ ...result, sourceSha256: before, originalUnchanged: true }));
  } finally {
    await cleanupBrowserTestResources({ browser, ownedPages: browser ? await browser.pages() : [], server });
  }
});

test("embedded AP marks delete, persist, and stay absent after reopen while PDF links remain", { timeout: 90_000 }, async () => {
  const { readBridgeRuntimeSource } = await import("./bridge-runtime-source.mjs");
  const UPNG = (await import("@pdf-lib/upng")).default.default;
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([300, 400]);
  pdf.addPage([300, 400]);
  const ctx = pdf.context;
  const appearance = ctx.register(ctx.flateStream("0 0 1 rg 0 0 70 70 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 70, 70] }));
  p.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Square", Rect: [30, 30, 100, 100], C: [0, 0, 1], CA: 1, BS: { W: 2 }, AP: { N: appearance } })));
  p.node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [30, 250, 100, 280], A: { S: "URI", URI: "https://example.invalid" } })));
  pdf.getPages()[1].node.addAnnot(ctx.register(ctx.obj({ Type: "Annot", Subtype: "Ink", Rect: [30, 30, 100, 100], C: [1, 0, 0], CA: 1, BS: { W: 2 }, InkList: [[30, 30, 100, 100]] })));
  const sourcePath = process.env.PDF_READER_TOMBSTONE_SOURCE;
  let seedRows = [];
  let documentId = "embedded-bulk-doc";
  let bytes = Buffer.from(await pdf.save());
  if (sourcePath) {
    const dir = "/Users/jiajia/Documents/ObReader-Apple-Test/ObReader-Bulk-Tests";
    await mkdir(dir, {recursive:true});
    const copy = path.join(dir, `tombstone-toolcycle-${Date.now()}.pdf`);
    await copyFile(sourcePath,copy);bytes=await readFile(copy);
    const sidecar=JSON.parse(await readFile(process.env.PDF_READER_TOMBSTONE_SIDECAR,"utf8"));
    documentId=sidecar.document.documentId;
    seedRows=Object.values(sidecar.tombstones).map(row=>({uuid:row.uuid,kind:row.kind,pageIndex:row.pageIndex,embeddedRef:row.embeddedRef,deleted:true,clock:{timestamp:1,logical:row.version.rev,deviceId:row.version.deviceId,opId:row.opId}}));
    assert.equal(Object.keys(sidecar.annotations).length,0,"this fixture expects an already-deleted document");
  }
  const beforeHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const bridge = await readBridgeRuntimeSource(process.env.PDF_READER_BRIDGE_SOURCE || undefined);
  const vendor = path.join(root, "vendor/pdfjs-generic-legacy");
  const viewerHtml = (await readFile(path.join(vendor, "web/viewer.html"), "utf8")).replace(
    '<script src="viewer.mjs" type="module"></script>',
    '<link rel="stylesheet" href="/bridge.css"><script src="/bridge.js" data-channel="pdf-web-reader" data-token="embedded-bulk" data-ios-input-policy="true"></script><script src="viewer.mjs" type="module"></script>');
  const host = `<!doctype html><style>body{margin:0}iframe{width:900px;height:740px;border:0}</style><iframe id="reader" src="/pdfjs/web/viewer.html?file="></iframe><script>
    const frame=document.getElementById('reader'); const rows=new Map(${JSON.stringify(seedRows)}.map(row=>[row.uuid,row]));let identity=null;let sequence=0;
    window.host={rows,errors:[],saves:0,opened:0};
    const snapshot=()=>({schemaVersion:1,kind:'pdf-annotation-snapshot',documentId:${JSON.stringify(documentId)},source:identity&&{sourceHash:'xxh64-v1:test',pageCount:identity.pageCount,orderedPageIdentities:identity.orderedPageIdentities},annotations:[...rows.values()],legacyIdentities:[]});
    const send=(data)=>frame.contentWindow.postMessage({channel:'pdf-web-reader',token:'embedded-bulk',documentId:${JSON.stringify(documentId)},openRequest:sequence,...data},'*');
    window.reopen=async()=>{sequence++;const data=await fetch('/source.pdf').then(r=>r.arrayBuffer());send({type:'open',data,filename:'native.pdf',autoSave:false,sourceHashConfirmed:!!identity,externalAnnotations:identity?snapshot():null});};
    addEventListener('message',event=>{if(event.source!==frame.contentWindow)return;const m=event.data;if(m?.token!=='embedded-bulk')return;
      if(m.type==='ready'&&!sequence)void reopen();
      if(m.type==='opened')host.opened++;
      if(m.type==='annotation-source-identity'){identity=m;const update={type:'external-annotations-update',identityConfirmed:true,sourceMatch:'MATCH',externalAnnotations:snapshot()};if(sequence>1)setTimeout(()=>send(update),350);else send(update);}
      if(m.type==='save'){for(const op of m.operations||[])rows.set(op.uuid,{uuid:op.uuid,kind:op.kind,pageIndex:op.pageIndex,embeddedRef:op.embeddedRef,deleted:op.deleted,clock:op.clock,...(!op.deleted?{payload:op.payload}:{})});host.saves++;send({type:'saved',external:true,requestId:m.requestId,revision:m.revision,operationCount:m.operations.length,batchId:'test-batch'});}
      if(m.type==='error')host.errors.push(m.message);
    });</script>`;
  const server = createServer(async (req,res)=>{
    try {
      const name=new URL(req.url,"http://127.0.0.1").pathname;
      if(name==='/'){res.setHeader('Content-Type','text/html');return res.end(host);}
      if(name==='/source.pdf'){res.setHeader('Content-Type','application/pdf');return res.end(bytes);}
      if(name==='/pdfjs/web/viewer.html'){res.setHeader('Content-Type','text/html');return res.end(viewerHtml);}
      if(name==='/bridge.js'){res.setHeader('Content-Type','text/javascript');return res.end(bridge);}
      if(name==='/bridge.css'){res.setHeader('Content-Type','text/css');return res.end(await readFile(path.join(root,'viewer-adapter/bridge.css')));}
      const relative=name.startsWith('/pdfjs/')?name.slice(7):name.startsWith('/build/')?name.slice(1):'web'+name;
      const target=path.resolve(vendor,relative);if(!target.startsWith(vendor+'/'))throw new Error('path');
      const ext=path.extname(target);res.setHeader('Content-Type',({'.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.ftl':'text/plain','.svg':'image/svg+xml'})[ext]||'application/octet-stream');
      res.end(await readFile(target));
    }catch{res.statusCode=404;res.end();}
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await launchTestBrowser(puppeteer,{executablePath:resolveBrowserPath(),headless:true,args:['--no-sandbox']},{testName:'embedded-bulk-roundtrip'});
    const page=await browser.newPage();await page.setViewport({width:1000,height:800,deviceScaleFactor:1});
    page.on('pageerror',e=>console.log('PAGE_ERROR',e.message));
    page.on('console',m=>{if(m.type()==='error')console.log('CONSOLE_ERROR',m.text());});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>host.opened===1);
    const viewer=page.frames().find(f=>f.url().includes('/pdfjs/web/viewer.html'));
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.getPageView(0)?.renderingState===3&&!document.documentElement.hasAttribute('data-pdf-reader-readonly'));
    if (sourcePath) {
      await viewer.evaluate(()=>{PDFViewerApplication.pdfViewer.currentPageNumber=2;});
      await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.getPageView(1)?.renderingState===3);
      const modes=[];
      for (const mode of [15,9,0,15]) {
        await viewer.evaluate(mode=>PDFViewerApplication.eventBus.dispatch('switchannotationeditormode',{source:window,mode}),mode);
        await viewer.waitForFunction(mode=>PDFViewerApplication.pdfViewer.annotationEditorMode===mode,{},mode);
        await new Promise(resolve=>setTimeout(resolve,200));
        const live=await viewer.evaluate(()=>[...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(1)].filter(e=>!e.deleted).map(e=>({id:e.id,ref:e.annotationElementId})));
        assert.deepEqual(live,[],`Principles page 2 deleted native editors must remain absent in mode ${mode}`);
        modes.push({mode,liveEditors:live.length});
      }
      const canvasDiff=await viewer.evaluate(async()=>{
        const pv=PDFViewerApplication.pdfViewer.getPageView(1);
        const c=document.createElement('canvas');c.width=pv.canvas.width;c.height=pv.canvas.height;
        await pv.pdfPage.render({canvasContext:c.getContext('2d'),viewport:pv.viewport,annotationMode:0,transform:pv.outputScale.scaled?[pv.outputScale.sx,0,0,pv.outputScale.sy,0,0]:null}).promise;
        const a=c.getContext('2d').getImageData(0,0,c.width,c.height).data,b=pv.canvas.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let changed=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>30)changed++;
        return {changed,pixels:c.width*c.height};
      });
      assert.equal(canvasDiff.changed,0,'Principles page 2 canvas equals source rendering with annotations disabled');
      await viewer.click('#secondaryToolbarToggleButton');await viewer.click('#pdfReaderBridgeDeleteAllAnnotationsButton');
      await new Promise(resolve=>setTimeout(resolve,200));
      assert.equal(await viewer.$('.pdfReaderBulkDeleteConfirm'),null,'already deleted document has no targets');
      assert.deepEqual(await page.evaluate(()=>host.errors),[]);
      assert.equal(crypto.createHash('sha256').update(await readFile(sourcePath)).digest('hex'),beforeHash);
      console.log(JSON.stringify({source:'Principles read-only copy',modes,canvasDiff,tombstones:seedRows.length,originalUnchanged:true}));
      return;
    }
    const pixel=async()=>{
      const point=await viewer.evaluate(()=>{const pv=PDFViewerApplication.pdfViewer.getPageView(0);const [x,y]=pv.viewport.convertToViewportPoint(65,65);const a=pv.canvas.getBoundingClientRect(),b=pv.div.getBoundingClientRect();return {x:x+a.x-b.x,y:y+a.y-b.y};});
      const png=await (await viewer.$('.page[data-page-number="1"]')).screenshot();const image=UPNG.decode(png.buffer.slice(png.byteOffset,png.byteOffset+png.byteLength));
      const rgba=new Uint8Array(UPNG.toRGBA8(image)[0]);const offset=(Math.round(point.y)*image.width+Math.round(point.x))*4;return [...rgba.slice(offset,offset+3)];
    };
    const before=await pixel();assert.ok(before[2]>200&&before[0]<30,'fixture native AP is actually visible');
    await viewer.click('#secondaryToolbarToggleButton');await viewer.click('#pdfReaderBridgeDeleteAllAnnotationsButton');
    await viewer.waitForSelector('.pdfReaderBulkDeleteConfirm');
    assert.match(await viewer.$eval('#pdfReaderBulkDeleteDescription',e=>e.textContent),/2 条/,'recognizes visible and offscreen native marks, excludes link');
    await viewer.click('.pdfReaderBulkDeleteConfirm');
    await viewer.waitForFunction(()=>!document.getElementById('secondaryDownload').disabled);
    await viewer.evaluate(()=>document.getElementById('secondaryDownload').click());await page.waitForFunction(()=>host.saves===1);
    await viewer.waitForFunction(()=>!PDFViewerApplication._saveInProgress);
    await new Promise(resolve=>setTimeout(resolve,100));
    const after=await pixel();
    assert.ok(after.every(c=>c>240),`native AP must disappear immediately: ${after}`);
    await viewer.evaluate(()=>{
      window.__reopenPaints=[];
      PDFViewerApplication.eventBus._on('pagerendered',({pageNumber})=>{
        if(pageNumber!==1)return;
        const pv=PDFViewerApplication.pdfViewer.getPageView(0);if(!pv?.canvas)return;
        const [x,y]=pv.viewport.convertToViewportPoint(65,65);
        window.__reopenPaints.push([...pv.canvas.getContext('2d').getImageData(Math.floor(x*pv.outputScale.sx),Math.floor(y*pv.outputScale.sy),1,1).data].slice(0,3));
      });
    });
    await page.evaluate(()=>reopen());await page.waitForFunction(()=>host.opened===2);
    await viewer.waitForFunction(()=>PDFViewerApplication.pdfViewer.getPageView(0)?.renderingState===3&&!document.documentElement.hasAttribute('data-pdf-reader-readonly'));
    const reopened=await pixel();assert.ok(reopened.every(c=>c>240),`native AP must not return: ${reopened}`);
    const firstPaints=await viewer.evaluate(()=>window.__reopenPaints);
    assert.ok(firstPaints.length>0,'record actual first native canvas render');
    assert.ok(firstPaints.every(rgb=>rgb.every(c=>c>240)),`deleted AP must never be painted, including the first frame: ${JSON.stringify(firstPaints)}`);
    assert.equal(await viewer.$$eval('.annotationLayer .linkAnnotation',nodes=>nodes.filter(n=>getComputedStyle(n).display!=='none').length),1,'native PDF link remains');
    await viewer.click('#editorInkButton');
    await new Promise(resolve=>setTimeout(resolve,150));
    const visibleNative=await viewer.evaluate(()=>[...PDFViewerApplication.pdfViewer._layerProperties.annotationEditorUIManager.getEditors(0)].filter(e=>!e.deleted).map(e=>({id:e.id,ref:e.annotationElementId})));
    assert.deepEqual(visibleNative,[],'tombstoned native marks must stay absent after selecting Ink');
    assert.equal(await page.evaluate(()=>[...host.rows.values()].filter(r=>r.deleted).length),2);
    assert.deepEqual(await page.evaluate(()=>host.errors),[]);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),beforeHash);
    console.log(JSON.stringify({before,after,reopened,firstPaints,deleted:2,linksPreserved:1,sourceUnchanged:true}));
  } finally {await cleanupBrowserTestResources({browser,ownedPages:browser?await browser.pages():[],server});}
});
