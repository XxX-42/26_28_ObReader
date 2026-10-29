import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { attachCleanupErrors, cleanupBrowserTestResources } from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { listenBrowserSafe } from "./browser-safe-port.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browserPath = resolveBrowserPath();
test("card word modes remain reachable on desktop and narrow touch viewports", { skip: !browserPath }, async () => {
  const bundle = await build({ entryPoints: [path.join(root, "viewer-adapter/vocabulary/controller.js")],
    bundle: true, format: "iife", globalName: "MorphologyRuntime", write: false, platform: "browser" });
  const css = await readFile(path.join(root, "viewer-adapter/bridge.css"), "utf8");
  const server = createServer((_req, response) => response.end(`<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;font:16px sans-serif}${css}</style>
    <body><script>${bundle.outputFiles[0].text}</script><script>
    const identity={documentId:'morphology',openRequest:1};
    window.sent=[];
    window.card=new MorphologyRuntime.VocabularyController({ app:{},documentRef:document,windowRef:window,
      getIdentity:()=>identity,postToHost(type,payload){
        sent.push({type,...payload});
        if(type==='vocab-word-mode-request') setTimeout(()=>card.setWordDisplayMode(payload.mode),40);
        return true;
      }});
    card.setDocument(identity.documentId,identity.openRequest,true);
    window.show=()=>{card.showEntryPill({page:{pageNumber:1,tokens:[]},entry:{rawSurface:'subscription',surfaceKey:'subscription',type:'word',startIndex:0,endIndex:1},requestId:'entry',x:innerWidth/2,y:innerHeight*.6});
      card.updatePillRecord({key:'subscription',type:'word',hasPersonalRecord:false,translation:'n. 订阅，订购',dictionaryLookupState:'found'});};
    show();</script>`));
  await listenBrowserSafe(server);
  let browser, page, primaryError, cleanup;
  try {
    browser = await launchTestBrowser(puppeteer, { executablePath: browserPath, headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"] }, { testName: "vocabulary-word-morphology-browser" });
    page = await browser.newPage();
    for (const viewport of [{width:1280,height:720},{width:390,height:844,isMobile:true,hasTouch:true},{width:220,height:740,isMobile:true,hasTouch:true}]) {
      await page.setViewport(viewport);
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "load" });
      await page.click('.pdfReaderVocabularyPillHeading');
      await page.click('.pdfReaderVocabularyWordModes button:nth-child(2)');
      await page.waitForSelector('.pdfReaderVocabularyWordModes button:nth-child(2)[aria-pressed="true"]');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const result = await page.evaluate(() => {
        const pill = document.querySelector('.pdfReaderVocabularyPill'), rect = pill.getBoundingClientRect();
        const controls = [...pill.querySelectorAll('.pdfReaderVocabularyWordModes button,.pdfReaderVocabularyPillActions button,.pdfReaderVocabularyPillClose')];
        return { left: rect.left, right: rect.right, bottom: rect.bottom, top: rect.top,
          heading: pill.querySelector('.pdfReaderVocabularyPillHeading').textContent,
          parts: pill.querySelector('.pdfReaderVocabularyMorphologyParts').textContent,
          controls: controls.map(el => {const r=el.getBoundingClientRect();return {w:r.width,h:r.height,l:r.left,r:r.right,t:r.top,b:r.bottom};}),
          queries: sent.filter(item=>item.type==='vocab-page-query').length };
      });
      assert.equal(result.heading, "subscription");
      assert.match(result.parts, /sub-.*script.*-ion/);
      assert.equal(result.queries, 0);
      assert.ok(result.left >= 0 && result.right <= viewport.width + 1 && result.top >= 0 && result.bottom <= viewport.height + 1);
      assert.ok(result.controls.every(r => r.w>=39 && r.h>=39 && r.l>=result.left-1 && r.r<=result.right+1 && r.t>=result.top-1 && r.b<=result.bottom+1));
      await page.click('.pdfReaderVocabularyPillClose');
      await page.evaluate(() => show());
      assert.equal(await page.$eval('.pdfReaderVocabularyWordModes button:nth-child(2)',el=>el.getAttribute('aria-pressed')), 'true');
      assert.equal(await page.$eval('.pdfReaderVocabularyMorphology',el=>el.hidden), false);
      await mkdir(path.join(root,"tests/artifacts"),{recursive:true});
      await page.screenshot({path:path.join(root,`tests/artifacts/lingq-morphology-${viewport.width}.png`)});
    }
  } catch (error) { primaryError = error; }
  finally { cleanup = await cleanupBrowserTestResources({browser, ownedPages:[page].filter(Boolean), server}); }
  const finalError = attachCleanupErrors(primaryError, cleanup);
  if (finalError) throw finalError;
});
