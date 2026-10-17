import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { attachCleanupErrors, cleanupBrowserTestResources } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const artifactsPath = path.join(root, "tests", "artifacts");
const browserPath = resolveBrowserPath();
const channel = "pdf-web-reader";
const token = `vocabulary-pill-layout-${Date.now()}-${process.pid}`;
const documentId = `vocabulary-pill-layout-document-${Date.now()}`;
const rendererGeneration = `vocabulary-pill-layout-renderer-${Date.now()}`;
const screenshotPhase = process.env.LINGQ_PILL_ARTIFACT_PHASE || "run";
const unlearnedMeaning = "prep. 在...之上\nadv. ...上去\na. 正起作用的\n[计] 打开";
const longMeaning = [
  "n. " + "A definition that arrives after the lookup card first opens and occupies enough lines to test its controls. ".repeat(5),
  "vt. " + "A second long definition remains readable while the fixed status controls stay available. ".repeat(5),
  "vi. " + "A third line forces the definition body to scroll without moving the grade buttons. ".repeat(5),
  "adj. " + "A narrow touch viewport must wrap this long explanation without widening past its safe area. ".repeat(5),
  "adv. " + "The definition card should keep its close control reachable at either viewport edge. ".repeat(5),
  "[phrase] " + "unbroken".repeat(70),
  ...Array.from({ length: 6 }, (_, index) => `${index + 1}. ` + "Additional dictionary content for the internal scrolling region. ".repeat(5)),
].join("\n");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

function frameScript({ runtimeSource, bridgeCss, viewerHtml }) {
  const injectedViewer = viewerHtml.replace(
    /<head\b[^>]*>/i,
    (head) => `${head}<link rel="stylesheet" href="/viewer-adapter/bridge.css"><script src="/viewer-adapter/obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="${rendererGeneration}" data-base-url="/vendor/pdfjs-generic-legacy/web/" data-ios-input-policy="true"></script>`,
  );
  return { injectedViewer, runtimeSource, bridgeCss };
}

function boundsAssertion(geometry, label) {
  const { popup, headingText, status, close, buttons, safe, meaning, heading, body, actions, placement } = geometry;
  assert.ok(popup, `${label}: the lookup card should remain open`);
  const contains = (rect, outer, tolerance = 1) => rect.left >= outer.left - tolerance &&
    rect.top >= outer.top - tolerance && rect.right <= outer.right + tolerance &&
    rect.bottom <= outer.bottom + tolerance;
  assert.ok(contains(popup, safe, 1), `${label}: card escaped visualViewport safe bounds: ${JSON.stringify(geometry)}`);
  assert.ok(contains(close, popup, 1), `${label}: close control must remain fully inside the visible card`);
  assert.ok(contains(close, safe, 1), `${label}: close control must remain inside visualViewport safe bounds`);
  assert.ok(contains(status, popup, 1), `${label}: status chip must remain inside the visible card`);
  assert.ok(contains(status, safe, 1), `${label}: status chip must remain inside visualViewport safe bounds`);
  for (const button of buttons) {
    assert.ok(contains(button, popup, 1), `${label}: status ${button.status} must be fully reachable inside the card: ${JSON.stringify(geometry)}`);
    assert.ok(contains(button, safe, 1), `${label}: status ${button.status} escaped visualViewport safe bounds: ${JSON.stringify(geometry)}`);
  }
  if (meaning) {
    assert.ok(meaning.scrollWidth <= meaning.clientWidth + 1,
      `${label}: long and unbroken definition text must wrap within the card: ${JSON.stringify(meaning)}`);
  }
  if (heading && body && actions) {
    assert.ok(headingText.right <= status.left + 1 && status.right <= close.left + 1,
      `${label}: heading, status chip, and close control must not overlap: ${JSON.stringify(geometry)}`);
    if (placement === "below") {
      assert.ok(heading.bottom <= actions.top + 1 && actions.bottom <= body.top + 1,
        `${label}: header, grade buttons, and definition body must not overlap: ${JSON.stringify(geometry)}`);
    } else {
      assert.ok(heading.bottom <= body.top + 1 && body.bottom <= actions.top + 1,
        `${label}: header, definition body, and grade buttons must not overlap: ${JSON.stringify(geometry)}`);
    }
  }
}

test("LingQ lookup card keeps definitions, all five status controls, and close reachable at viewport edges", {
  skip: !browserPath && "Chrome or Edge is required for this browser layout regression",
  timeout: 150_000,
}, async () => {
  const [runtimeSource, bridgeCss, viewerHtml] = await Promise.all([
    process.env.LINGQ_PILL_RUNTIME_SOURCE
      ? readFile(process.env.LINGQ_PILL_RUNTIME_SOURCE, "utf8")
      : readBridgeRuntimeSource(bridgePath),
    process.env.LINGQ_PILL_BRIDGE_CSS
      ? readFile(process.env.LINGQ_PILL_BRIDGE_CSS, "utf8")
      : readFile(path.join(root, "viewer-adapter", "bridge.css"), "utf8"),
    readFile(path.join(vendorRoot, "web", "viewer.html"), "utf8"),
  ]);
  const { injectedViewer } = frameScript({ runtimeSource, bridgeCss, viewerHtml });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>LingQ pill layout regression</title>
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>
        <iframe title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
        <script>
          (()=>{
            const channel=${JSON.stringify(channel)},token=${JSON.stringify(token)},documentId=${JSON.stringify(documentId)};
            const rendererGeneration=${JSON.stringify(rendererGeneration)},iframe=document.querySelector('iframe');
            const host=window.__vocabularyPillHost={opened:0,pageQueries:[],lookupRequests:[],entryResults:[],statusRequests:[],
              backlinkQueries:[],backlinkOpenRequests:[],occurrenceRequests:[],errors:[],responseMode:'long'};
            let sourceBytes=null,openRequest=1;
            const post=(message)=>iframe.contentWindow.postMessage({channel,token,rendererGeneration,...message},'*');
            const sendOpen=()=>{
              if(!(sourceBytes instanceof ArrayBuffer))throw new Error('PDF fixture bytes are not ready');
              const data=sourceBytes.slice(0);
              iframe.contentWindow.postMessage({channel,token,type:'open',documentId,filename:'tracemonkey.pdf',openRequest,data,
                readOnly:false,autoSave:false,vocabularyEnabled:true},'*',[data]);
            };
            window.addEventListener('message',event=>{
              if(event.source!==iframe.contentWindow||!event.data||event.data.channel!==channel||event.data.token!==token)return;
              const message=event.data;
              if(message.type==='ready'){
                fetch('/tests/fixtures/tracemonkey.pdf').then(response=>response.arrayBuffer()).then(bytes=>{sourceBytes=bytes;sendOpen();})
                  .catch(error=>host.errors.push(String(error?.message||error)));
              }else if(message.type==='opened') host.opened++;
              else if(message.type==='vocab-page-query'){
                host.pageQueries.push({requestId:message.requestId,queryId:message.queryId,pageNumber:message.pageNumber,openRequest:message.openRequest});
                post({type:'vocab-page-results',documentId,openRequest:message.openRequest,requestId:message.requestId,
                  queryId:message.queryId,partIndex:message.partIndex,pageNumber:message.pageNumber,
                  records:[],wordMatches:[],phraseMatches:[],metrics:{testHost:true}});
              }else if(message.type==='vocab-token-tap'){
                host.lookupRequests.push(message);
                const mode=host.responseMode;
                setTimeout(()=>{
                  const record={key:message.key,storageKey:message.key,type:message.entryType,
                    status:mode==='unlearned'?null:2,hasPersonalRecord:mode==='unlearned'?false:true,
                    phonetic:'/ˈlæŋɡwɪdʒ/',dictionaryLookupState:'found',
                    translation:mode==='short'?'n. a concise meaning':mode==='unlearned'?${JSON.stringify(unlearnedMeaning)}:${JSON.stringify(longMeaning)}};
                  host.entryResults.push({key:message.key,mode});
                  post({type:'vocab-entry-result',documentId,openRequest:message.openRequest,requestId:message.requestId,
                    key:message.key,pageNumber:message.pageNumber,record});
                },600);
              }else if(message.type==='vocab-set-status'){
                host.statusRequests.push(message);
                setTimeout(()=>post({type:'vocab-status-ack',documentId,openRequest:message.openRequest,
                  requestId:message.requestId,key:message.key,pageNumber:message.pageNumber,durable:true,
                  record:{key:message.key,storageKey:message.storageKey||message.key,type:message.entryType,status:message.status}}),20);
              }else if(message.type==='reader-backlink-occurrence-query'){
                host.backlinkQueries.push(message);
                setTimeout(()=>post({type:'reader-backlink-occurrence-result',documentId,openRequest:message.openRequest,
                  requestId:message.requestId,ok:true,count:1,anchorIds:['layout-test-anchor']}),0);
              }else if(message.type==='reader-anchor-occurrence-link-request'){
                host.occurrenceRequests.push(message);
                setTimeout(()=>post({type:'reader-anchor-occurrence-result',documentId,openRequest:message.openRequest,
                  requestId:message.requestId,ok:true}),0);
              }else if(message.type==='reader-backlink-occurrence-open'){
                host.backlinkOpenRequests.push(message);
              }else if(message.type==='error') host.errors.push(message.message||message.code||'viewer error');
            });
          })();
        </script>`);
      return;
    }
    if (url.pathname === "/viewer-adapter/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(runtimeSource);
      return;
    }
    if (url.pathname === "/viewer-adapter/bridge.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8" });
      response.end(bridgeCss);
      return;
    }
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(injectedViewer);
      return;
    }
    let target;
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") target = fixture;
    else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
      const relative = decodeURIComponent(url.pathname.slice("/vendor/pdfjs-generic-legacy/".length));
      target = path.resolve(vendorRoot, relative);
      if (!target.startsWith(`${vendorRoot}${path.sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
    } else {
      response.writeHead(404).end("not found");
      return;
    }
    try {
      const info = await stat(target);
      response.writeHead(200, {
        "content-type": mimeTypes.get(path.extname(target)) || "application/octet-stream",
        "content-length": info.size,
        "x-content-type-options": "nosniff",
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  await mkdir(artifactsPath, { recursive: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  let browser;
  let page;
  let viewer;
  let primaryError = null;
  let cleanupReport = null;
  const screenshot = async (name) => {
    const outputPath = path.join(artifactsPath, `lingq-pill-${screenshotPhase}-${name}.png`);
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log(`LingQ pill screenshot: ${outputPath}`);
    return outputPath;
  };
  const settleViewer = async () => viewer.evaluate(() => new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const geometry = async () => viewer.evaluate(() => {
    const pill=document.querySelector('.pdfReaderVocabularyPill');
    if(!pill)return null;
    const rect=(element)=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const vv=window.visualViewport;
    const safe={left:Number(vv?.offsetLeft)||0,top:Number(vv?.offsetTop)||0,
      right:(Number(vv?.offsetLeft)||0)+(Number(vv?.width)||window.innerWidth),
      bottom:(Number(vv?.offsetTop)||0)+(Number(vv?.height)||window.innerHeight)};
    const meanings=pill.querySelector('.pdfReaderVocabularyPillMeanings');
    const headingElement=pill.querySelector('.pdfReaderVocabularyPillHeading');
    const statusElement=pill.querySelector('.pdfReaderVocabularyPillStatus');
    const closeElement=pill.querySelector('.pdfReaderVocabularyPillClose');
    const headerElements=[headingElement,statusElement,closeElement].filter(Boolean).map(rect);
    const header={top:Math.min(...headerElements.map(item=>item.top)),bottom:Math.max(...headerElements.map(item=>item.bottom))};
    return {popup:rect(pill),safe,headingText:rect(headingElement),status:rect(statusElement),
      statusMaxWidth:getComputedStyle(statusElement).maxWidth,close:rect(closeElement),
      buttons:[...pill.querySelectorAll('.pdfReaderVocabularyPillActions button[data-status]')].map(button=>({status:Number(button.dataset.status),...rect(button)})),
      heading:header,body:rect(pill.querySelector('.pdfReaderVocabularyPillBody')),
      actions:rect(pill.querySelector('.pdfReaderVocabularyPillActions')),placement:pill.dataset.placement,
      meaning:meanings?{clientWidth:meanings.clientWidth,scrollWidth:meanings.scrollWidth}:null,
      viewport:{innerWidth:window.innerWidth,innerHeight:window.innerHeight,
        scale:Number(vv?.scale)||1,width:Number(vv?.width)||window.innerWidth,height:Number(vv?.height)||window.innerHeight,
        offsetLeft:Number(vv?.offsetLeft)||0,offsetTop:Number(vv?.offsetTop)||0}};
  });
  const setTheme = async (theme) => viewer.evaluate((value) => {
    const dark=value==='dark',root=document.documentElement;
    root.dataset.theme=value;
    root.style.colorScheme=value;
    root.style.setProperty('--background-secondary',dark?'#20232a':'#f7f8fa');
    root.style.setProperty('--background-primary',dark?'#14161a':'#ffffff');
    root.style.setProperty('--background-modifier-border',dark?'#454b56':'#d1d5dc');
    root.style.setProperty('--text-normal',dark?'#edf0f5':'#20242b');
    root.style.setProperty('--text-muted',dark?'#b1b8c4':'#626a76');
    root.style.setProperty('--interactive-accent',dark?'#9c8cff':'#6957d5');
    root.style.setProperty('--text-on-accent',dark?'#17131f':'#ffffff');
  }, theme);
  const installHitInstrumentation = async (touch) => viewer.evaluate((isTouch) => {
    window.__vocabularyPillLayoutIsMobile=isTouch;
    window.__vocabularyPillHitEvents=[];
    if(window.__vocabularyPillHitListenerInstalled)return;
    window.__vocabularyPillHitListenerInstalled=true;
    const record=event=>{
      const target=event.target,button=target?.closest?.('.pdfReaderVocabularyPillActions button[data-status]');
      const close=target?.closest?.('.pdfReaderVocabularyPillClose');
      const occurrence=target?.closest?.('.pdfReaderVocabularyPillOccurrenceLink');
      const backlink=target?.closest?.('.pdfReaderVocabularyPillBacklinksButton');
      window.__vocabularyPillHitEvents.push({type:event.type,pointerType:event.pointerType||null,
        detail:event.detail??null,button:event.button??null,isTrusted:event.isTrusted===true,
        targetIsPillButton:Boolean(button),targetIsClose:Boolean(close),targetInsidePdf:Boolean(target?.closest?.('#viewerContainer')),
        targetIsOccurrence:Boolean(occurrence),targetIsBacklink:Boolean(backlink),
        status:button?Number(button.dataset.status):null});
    };
    document.addEventListener('pointerdown',record,true);
    document.addEventListener('click',record,true);
  }, touch);
  const setViewport = async ({ width, height, touch = false }) => {
    await page.setViewport({ width, height, isMobile:touch, hasTouch:touch, deviceScaleFactor:touch?2:1 });
    if (touch) await page.evaluate(() => document.querySelector('iframe')?.contentWindow?.focus());
    await page.waitForFunction(() => window.__vocabularyPillHost?.opened === 1,{timeout:45_000});
    viewer=page.frames().find((frame)=>frame.url().includes('/web/viewer.html'))||viewer;
    assert.ok(viewer,'The PDF.js frame should be available after changing viewport metrics.');
    await viewer.waitForFunction(() => window.PDFViewerApplication?.pdfDocument &&
      document.querySelector('#viewerContainer')?.clientWidth > 0, { timeout: 15_000 });
    await settleViewer();
    await installHitInstrumentation(touch);
    if (touch) {
      await viewer.evaluate(() => window.focus());
      await viewer.waitForFunction(() => document.visibilityState === 'visible' && document.hasFocus(),
        { timeout: 5_000 });
    }
  };
  const tapPointAtEdge = async (edge) => {
    await viewer.evaluate(()=>{window.PDFViewerApplication.pdfViewer.currentScale=1.12;});
    await viewer.waitForFunction(()=>document.querySelectorAll('.page[data-page-number="1"] .textLayer span').length>0,
      {timeout:15_000});
    await settleViewer();
    const point=await viewer.evaluate((which)=>{
      const app=window.PDFViewerApplication,container=document.getElementById('viewerContainer');
      const page=document.querySelector('.page[data-page-number="1"]');
      const visibleWidth=window.visualViewport?.width||window.innerWidth;
      const visibleHeight=window.visualViewport?.height||window.innerHeight;
      const targetY=which==='top'?Math.min(58,visibleHeight*0.18):visibleHeight-20;
      const spans=[...page.querySelectorAll('.textLayer span')].filter(span=>span.textContent.trim()).map(span=>{
        const r=span.getBoundingClientRect();return {span,x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,width:r.width,height:r.height};
      }).filter(item=>item.width>0&&item.height>0&&item.x>=0&&item.x<=visibleWidth);
      if(!spans.length)throw new Error('No horizontally visible PDF text spans were found');
      spans.sort((a,b)=>which==='top'?a.y-b.y:b.y-a.y);
      const chosen=spans[0],old=container.scrollTop,max=Math.max(0,container.scrollHeight-container.clientHeight);
      const next=Math.max(0,Math.min(max,old+chosen.y-targetY));
      container.scrollTop=next;
      return {targetY,scrollTop:next,text:chosen.span.textContent.slice(0,80)};
    },edge);
    await settleViewer();
    const finalPoint=await viewer.evaluate((which)=>{
      const vv=window.visualViewport,page=document.querySelector('.page[data-page-number="1"]');
      const width=vv?.width||window.innerWidth,height=vv?.height||window.innerHeight;
      const targetY=which==='top'?Math.min(58,height*0.18):height-20;
      const spans=[...page.querySelectorAll('.textLayer span')].filter(span=>span.textContent.trim()).map(span=>{
        const r=span.getBoundingClientRect();return {span,x:(r.left+r.right)/2,y:(r.top+r.bottom)/2,width:r.width,height:r.height};
      }).filter(item=>item.width>0&&item.height>0&&item.x>=0&&item.x<=width&&item.y>=0&&item.y<=height);
      spans.sort((a,b)=>Math.abs(a.y-targetY)-Math.abs(b.y-targetY));
      const chosen=spans[0];
      if(!chosen)throw new Error('Could not place a visible text span near the requested viewport edge');
      return {x:chosen.x,y:chosen.y,text:chosen.span.textContent.trim().slice(0,80),targetY,
        nearEdgeDistance:Math.abs(chosen.y-targetY),visibleHeight:height,visualScale:Number(vv?.scale)||1};
    },edge);
    assert.ok(finalPoint.x>0&&finalPoint.x<1920&&finalPoint.y>=0&&finalPoint.y<finalPoint.visibleHeight,
      `The trusted lookup tap must land on visible text: ${JSON.stringify({point,finalPoint})}`);
    return finalPoint;
  };
  const openCardAt = async (edge, mode, theme, screenshotName) => {
    await page.evaluate((value)=>{window.__vocabularyPillHost.responseMode=value;},mode);
    await setTheme(theme);
    const before=await page.evaluate(()=>window.__vocabularyPillHost.lookupRequests.length);
    const entriesBefore=await page.evaluate(()=>window.__vocabularyPillHost.entryResults.length);
    const point=await tapPointAtEdge(edge);
    const iframeRect=await page.$eval('iframe',frame=>{const r=frame.getBoundingClientRect();return {x:r.x,y:r.y};});
    if (await page.evaluate(() => window.__vocabularyPillHost.lookupRequests.length) === before) {
      if (await page.evaluate(() => window.__vocabularyPillHost.opened) !== 1) throw new Error('PDF viewer host handshake did not finish');
    }
    if (await viewer.evaluate(() => window.__vocabularyPillLayoutIsMobile === true)) {
      await page.touchscreen.tap(iframeRect.x+point.x,iframeRect.y+point.y);
    } else {
      await page.mouse.click(iframeRect.x+point.x,iframeRect.y+point.y);
    }
    try {
      await page.waitForFunction((count)=>window.__vocabularyPillHost.lookupRequests.length>count,
        {timeout:8_000},before);
    } catch (error) {
      const child=await viewer.evaluate(({x,y})=>{
        const target=document.elementFromPoint(x,y),vv=window.visualViewport;
        return {innerWidth:window.innerWidth,innerHeight:window.innerHeight,
          visualViewport:{width:vv?.width,height:vv?.height,scale:vv?.scale,offsetLeft:vv?.offsetLeft,offsetTop:vv?.offsetTop},
          target:target?.tagName,classes:String(target?.className||''),insideTextLayer:Boolean(target?.closest?.('.textLayer')),
          selection:String(window.getSelection()?.toString()||''),visibilityState:document.visibilityState,hasFocus:document.hasFocus()};
      },point);
      const hostState=await page.evaluate(()=>({lookups:window.__vocabularyPillHost.lookupRequests.length,
        opened:window.__vocabularyPillHost.opened,errors:window.__vocabularyPillHost.errors.slice(-4)}));
      const inputEvents=await viewer.evaluate(()=>window.__vocabularyPillHitEvents?.slice(-8)||[]);
      throw new Error(`${error.message}; trusted tap diagnostics=${JSON.stringify({point,iframeRect,child,hostState,inputEvents})}`);
    }
    await viewer.waitForSelector('.pdfReaderVocabularyPill',{timeout:5_000});
    const pending=await viewer.$eval('.pdfReaderVocabularyPillMeanings',element=>element.textContent);
    assert.match(pending,/正在读取个人词汇数据/,'The long dictionary content should arrive asynchronously after the pill opens');
    await page.waitForFunction((count)=>window.__vocabularyPillHost.entryResults.length>count,{timeout:8_000},entriesBefore);
    await viewer.waitForFunction((expectLong)=>{
      const text=document.querySelector('.pdfReaderVocabularyPillMeanings')?.textContent||'';
      return text.length>(expectLong?30:10)&&!text.includes('正在读取个人词汇数据');
    },{timeout:5_000},mode==='long');
    await settleViewer();
    await screenshot(screenshotName);
    return {point,geometry:await geometry()};
  };
  const clickStatusAtCenter = async (status, touch) => {
    const location=await viewer.evaluate((value)=>{
      const pill=document.querySelector('.pdfReaderVocabularyPill'),button=pill?.querySelector(`.pdfReaderVocabularyPillActions button[data-status="${value}"]`);
      if(!pill||!button)throw new Error(`Missing LingQ status ${value}`);
      const b=button.getBoundingClientRect(),p=pill.getBoundingClientRect();
      const x=(b.left+b.right)/2,y=(b.top+b.bottom)/2,hit=document.elementFromPoint(x,y);
      return {x,y,width:b.width,height:b.height,hit:hit===button||button.contains(hit),
        insidePopup:x>=p.left&&x<=p.right&&y>=p.top&&y<=p.bottom};
    },status);
    assert.equal(location.hit,true,`Status ${status} center must be the real button hit target: ${JSON.stringify(location)}`);
    assert.equal(location.insidePopup,true,`Status ${status} center must remain inside the pill`);
    const before=await page.evaluate(()=>window.__vocabularyPillHost.statusRequests.length);
    const frameOffset=await page.$eval('iframe',frame=>{const r=frame.getBoundingClientRect();return {x:r.x,y:r.y};});
    if(touch)await page.touchscreen.tap(frameOffset.x+location.x,frameOffset.y+location.y);
    else await page.mouse.click(frameOffset.x+location.x,frameOffset.y+location.y);
    await page.waitForFunction((count)=>window.__vocabularyPillHost.statusRequests.length===count+1,
      {timeout:5_000},before);
    await viewer.waitForFunction((value)=>document.querySelector(`.pdfReaderVocabularyPillActions button[data-status="${value}"]`)?.disabled===false,
      {timeout:5_000},status);
    const capture=await viewer.evaluate(()=>window.__vocabularyPillHitEvents?.at(-1)||null);
    assert.ok(capture?.targetIsPillButton,`The trusted click should target the pill button: ${JSON.stringify(capture)}`);
    assert.equal(capture.targetInsidePdf,false,'The PDF page must not receive the status-button click');
    return location;
  };
  const clickCloseAtCenter = async (touch) => {
    const location=await viewer.evaluate(()=>{
      const close=document.querySelector('.pdfReaderVocabularyPillClose'),r=close?.getBoundingClientRect();
      if(!close||!r)throw new Error('Missing LingQ close control');
      const x=(r.left+r.right)/2,y=(r.top+r.bottom)/2,hit=document.elementFromPoint(x,y);
      return {x,y,hit:hit===close||close.contains(hit)};
    });
    assert.equal(location.hit,true,`Close control center must be the real hit target: ${JSON.stringify(location)}`);
    const frameOffset=await page.$eval('iframe',frame=>{const r=frame.getBoundingClientRect();return {x:r.x,y:r.y};});
    if(touch)await page.touchscreen.tap(frameOffset.x+location.x,frameOffset.y+location.y);
    else await page.mouse.click(frameOffset.x+location.x,frameOffset.y+location.y);
    await viewer.waitForFunction(()=>!document.querySelector('.pdfReaderVocabularyPill'),{timeout:3_000});
    const capture=await viewer.evaluate(()=>window.__vocabularyPillHitEvents?.at(-1)||null);
    assert.ok(capture?.targetIsClose,`The trusted click should target the close control: ${JSON.stringify(capture)}`);
    assert.equal(capture.targetInsidePdf,false,'The PDF page must not receive the close-control click');
  };
  const assertUnlearnedCard = async (geometrySnapshot, label) => {
    boundsAssertion(geometrySnapshot,label);
    const state=await viewer.evaluate(()=>({
      status:document.querySelector('.pdfReaderVocabularyPillStatus')?.textContent||'',
      meaning:document.querySelector('.pdfReaderVocabularyPillMeanings')?.textContent||'',
      buttons:[...document.querySelectorAll('.pdfReaderVocabularyPillActions button[data-status]')].map(button=>({
        status:Number(button.dataset.status),active:button.classList.contains('is-active'),pressed:button.getAttribute('aria-pressed'),
      })),
    }));
    assert.equal(state.status,'无个人学习状态',`${label}: dictionary results without a personal status should show the long status chip`);
    assert.equal(state.meaning,unlearnedMeaning,`${label}: four short Chinese dictionary definitions should remain intact`);
    assert.ok(state.buttons.length===5&&state.buttons.every(button=>!button.active&&button.pressed==='false'),
      `${label}: no grade should appear active when the dictionary record has status:null: ${JSON.stringify(state.buttons)}`);
    return state;
  };
  const scrollBodyAndVerifySecondaryControls = async (touch) => {
    const before=await geometry();
    const bodyState=await viewer.evaluate(()=>{
      const body=document.querySelector('.pdfReaderVocabularyPillBody');
      if(!body)throw new Error('Missing scrollable vocabulary body');
      body.scrollTop=body.scrollHeight;
      return {scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,scrollTop:body.scrollTop};
    });
    assert.ok(bodyState.scrollHeight>bodyState.clientHeight&&bodyState.scrollTop>0,
      `Long definitions should scroll the body independently: ${JSON.stringify(bodyState)}`);
    await viewer.waitForFunction(()=>{
      const button=document.querySelector('.pdfReaderVocabularyPillBacklinksButton');
      return button&&!button.hidden&&!button.disabled;
    },{timeout:5_000});
    await settleViewer();
    const controls=await viewer.evaluate(()=>{
      const body=document.querySelector('.pdfReaderVocabularyPillBody'),copy=document.querySelector('.pdfReaderVocabularyPillOccurrenceLink');
      const backlinks=document.querySelector('.pdfReaderVocabularyPillBacklinksButton');
      const actions=document.querySelector('.pdfReaderVocabularyPillActions');
      const rect=(element)=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
      const bodyRect=rect(body),copyRect=rect(copy),backlinkRect=rect(backlinks),actionsRect=rect(actions);
      const centerHit=(element)=>{const r=element.getBoundingClientRect(),hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return hit===element||element.contains(hit);};
      return {scrollTop:body.scrollTop,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight,body:bodyRect,
        copy:copyRect,backlinks:backlinkRect,actions:actionsRect,copyVisible:copyRect.top>=bodyRect.top-1&&copyRect.bottom<=bodyRect.bottom+1,
        backlinksVisible:backlinkRect.top>=bodyRect.top-1&&backlinkRect.bottom<=bodyRect.bottom+1,
        copyHit:centerHit(copy),backlinkHit:centerHit(backlinks)};
    });
    assert.ok(controls.scrollTop>0&&controls.scrollHeight>controls.clientHeight,
      `The secondary rows must be reached by scrolling the body: ${JSON.stringify(controls)}`);
    assert.ok(controls.copyVisible&&controls.backlinksVisible,
      `Copy and backlink controls should be visible at the end of the body: ${JSON.stringify(controls)}`);
    assert.ok(controls.copyHit&&controls.backlinkHit,
      `Secondary control centers must hit their real buttons: ${JSON.stringify(controls)}`);
    assert.ok(Math.abs(controls.actions.top-before.actions.top)<=1&&Math.abs(controls.actions.bottom-before.actions.bottom)<=1,
      `Scrolling the body must leave the grade row fixed: ${JSON.stringify({before:before.actions,after:controls.actions})}`);
    boundsAssertion(await geometry(),'portrait after scrolling to occurrence and backlink controls');
    await screenshot('touch-portrait-body-scrolled');
    const frameOffset=await page.$eval('iframe',frame=>{const r=frame.getBoundingClientRect();return {x:r.x,y:r.y};});
    const tap=async(point)=>touch?page.touchscreen.tap(frameOffset.x+point.x,frameOffset.y+point.y):page.mouse.click(frameOffset.x+point.x,frameOffset.y+point.y);
    const beforeOccurrence=await page.evaluate(()=>window.__vocabularyPillHost.occurrenceRequests.length);
    await tap({x:(controls.copy.left+controls.copy.right)/2,y:(controls.copy.top+controls.copy.bottom)/2});
    await page.waitForFunction((count)=>window.__vocabularyPillHost.occurrenceRequests.length===count+1,{timeout:5_000},beforeOccurrence);
    await viewer.waitForFunction(()=>document.querySelector('.pdfReaderVocabularyPillOccurrenceLink')?.textContent==='已复制链接',
      {timeout:5_000});
    const copyCapture=await viewer.evaluate(()=>window.__vocabularyPillHitEvents?.at(-1)||null);
    assert.ok(copyCapture?.targetIsOccurrence,`Copy control should receive the trusted click: ${JSON.stringify(copyCapture)}`);
    assert.equal(copyCapture.targetInsidePdf,false,'The PDF page must not receive the occurrence-link click');
    const beforeBacklink=await page.evaluate(()=>window.__vocabularyPillHost.backlinkOpenRequests.length);
    await tap({x:(controls.backlinks.left+controls.backlinks.right)/2,y:(controls.backlinks.top+controls.backlinks.bottom)/2});
    await page.waitForFunction((count)=>window.__vocabularyPillHost.backlinkOpenRequests.length===count+1,{timeout:5_000},beforeBacklink);
    const backlinkCapture=await viewer.evaluate(()=>window.__vocabularyPillHitEvents?.at(-1)||null);
    assert.ok(backlinkCapture?.targetIsBacklink,`Backlink control should receive the trusted click: ${JSON.stringify(backlinkCapture)}`);
    assert.equal(backlinkCapture.targetInsidePdf,false,'The PDF page must not receive the backlink click');
  };

  try {
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "vocabulary-pill-layout-browser" });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__vocabularyPillHost?.opened === 1, { timeout: 45_000 });
    viewer = page.frames().find((frame) => frame.url().includes("/web/viewer.html"));
    assert.ok(viewer,"The PDF.js frame should be available after the host handshake.");
    await viewer.waitForFunction(() => window.PDFViewerApplication?.pdfDocument &&
      window.PDFViewerApplication?.pdfViewer?.getPageView(0)?.renderingState === 3,
    { timeout: 40_000 });
    await viewer.waitForFunction(()=>window.PDFViewerApplication.pdfViewer.currentScale>0 &&
      document.querySelectorAll('.page[data-page-number="1"] .textLayer span').length>0,{timeout:20_000});
    await installHitInstrumentation(false);

    // Baseline reproduction: a large asynchronous definition at the bottom
    // edge used to leave the status row below the card's scroll clip.
    await setViewport({width:1280,height:720});
    const desktopBottom=await openCardAt('bottom','long','dark','desktop-bottom');
    boundsAssertion(desktopBottom.geometry,'desktop bottom edge after asynchronous long lookup');
    for(const status of [1,2,3,4,5]) await clickStatusAtCenter(status,false);
    await clickCloseAtCenter(false);

    const desktopUnlearned=await openCardAt('bottom','unlearned','dark','desktop-bottom-unlearned');
    await assertUnlearnedCard(desktopUnlearned.geometry,'desktop bottom with dictionary result and no personal status');
    await clickCloseAtCenter(false);

    // Check the preferred-above placement at the opposite desktop edge and a
    // content-sized short card with a dynamic width.
    await setViewport({width:1440,height:960});
    const desktopTop=await openCardAt('top','short','light','desktop-top-short');
    boundsAssertion(desktopTop.geometry,'desktop top edge with a short result');
    assert.ok(desktopTop.geometry.popup.width<380,
      `Short definitions should use a content-sized card: ${JSON.stringify(desktopTop.geometry)}`);

    // Touch portrait gets both the long unbroken definition and a narrow
    // VisualViewport. The card must reflow against these live viewport bounds.
    await page.evaluate(()=>{window.__vocabularyPillHost.responseMode='long';});
    await setViewport({width:390,height:844,touch:true});
    const portrait=await openCardAt('bottom','long','dark','touch-portrait');
    boundsAssertion(portrait.geometry,'touch portrait after asynchronous long lookup');
    await scrollBodyAndVerifySecondaryControls(true);
    for(const status of [1,2,3,4,5]) await clickStatusAtCenter(status,true);
    await setViewport({width:360,height:740,touch:true});
    const resizedGeometry=await geometry();
    await screenshot('touch-portrait-resized');
    boundsAssertion(resizedGeometry,'touch portrait after viewport resize while the card is open');
    assert.equal(resizedGeometry.viewport.innerWidth,360,'The open-card resize should reach the PDF.js visual viewport');
    await setViewport({width:220,height:844,touch:true});
    const narrowGeometry=await geometry();
    await screenshot('touch-portrait-narrow-220');
    boundsAssertion(narrowGeometry,'touch portrait after resize to a 220px viewport');
    assert.ok(narrowGeometry.viewport.width>=200&&narrowGeometry.viewport.width<=230,
      `Narrow viewport test should exercise a roughly 220px VisualViewport: ${JSON.stringify(narrowGeometry.viewport)}`);
    const statusMaxWidth=Number.parseFloat(narrowGeometry.statusMaxWidth);
    assert.ok(Number.isFinite(statusMaxWidth)&&statusMaxWidth<=narrowGeometry.viewport.width-150+1,
      `The status chip should cap itself using VisualViewport width: ${JSON.stringify({viewport:narrowGeometry.viewport,statusMaxWidth,status:narrowGeometry.status})}`);
    await clickCloseAtCenter(true);

    await setViewport({width:390,height:844,touch:true});
    const touchUnlearned=await openCardAt('bottom','unlearned','dark','touch-portrait-unlearned');
    await assertUnlearnedCard(touchUnlearned.geometry,'touch portrait with dictionary result and no personal status');
    await clickCloseAtCenter(true);

    // Short landscape leaves little vertical room. Verify long, unbroken
    // content remains within the visible bounds and the close control stays
    // fully tappable even when the definition body needs scrolling.
    await setViewport({width:844,height:390,touch:true});
    const landscape=await openCardAt('bottom','long','light','touch-short-landscape');
    boundsAssertion(landscape.geometry,'touch short landscape after asynchronous long lookup');
    await clickCloseAtCenter(true);

    console.log(`LingQ pill geometry: ${JSON.stringify({desktopBottom:desktopBottom.geometry,
      desktopUnlearned:desktopUnlearned.geometry,desktopTop:desktopTop.geometry,touchPortrait:portrait.geometry,
      touchPortraitNarrow:narrowGeometry,touchUnlearned:touchUnlearned.geometry,touchLandscape:landscape.geometry})}`);
  } catch (error) {
    primaryError = error;
    if (page) await screenshot("failure").catch(() => {});
  } finally {
    cleanupReport = await cleanupBrowserTestResources({ browser, ownedPages: [page].filter(Boolean), server });
  }
  const finalError = attachCleanupErrors(primaryError, cleanupReport);
  if (finalError) throw finalError;
});
