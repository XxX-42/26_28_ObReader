// Explicit opt-in full-dictionary benchmark; does not touch a real Vault/cache.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourceRoot = process.argv[2];
assert.ok(resourceRoot, "Pass the generated resource-v2 directory explicitly.");
const workerBatchSize = Number(process.argv[3] || 4000);
assert.ok(Number.isSafeInteger(workerBatchSize) && workerBatchSize >= 1000 && workerBatchSize <= 32000,
  "Worker batch size must be an integer from 1000 through 32000.");
const manifest = JSON.parse(await readFile(path.join(resourceRoot, "manifest.json"), "utf8"));
const worker = await build({ entryPoints: [path.join(root, "plugin/vocabulary/dictionary-worker.cjs")],
  bundle: true, write: false, platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
const runtime = await build({ entryPoints: [path.join(root, "plugin/vocabulary/dictionary.cjs")], bundle: true,
  write: false, platform: "browser", format: "iife", globalName: "DictionaryRuntime",
  define: { "process.env.NODE_ENV": '"production"', __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) } });
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/runtime.js") {
    response.setHeader("Content-Type", "text/javascript");
    return response.end(runtime.outputFiles[0].text);
  }
  if (["manifest.json", manifest.resourceFile].includes(url.pathname.slice(1))) {
    return createReadStream(path.join(resourceRoot, url.pathname.slice(1))).pipe(response);
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ECDICT local cache acceptance</title><style>body{font:18px system-ui;padding:24px;max-width:650px;margin:auto}pre{white-space:pre-wrap}progress{width:100%}</style>
    <h1>ECDICT 本机缓存</h1><progress max="${manifest.entryCount}" value="0"></progress><p id="state">词典准备中</p><pre id="meaning"></pre>
    <script src="/runtime.js"></script><script>
      window.binaryReads = 0; window.progress=[]; window.profile=[]; window.ticks=[];
      let last=performance.now(); window.timer=setInterval(()=>{const now=performance.now();ticks.push(now-last);last=now},16);
      window.dictionary=new DictionaryRuntime.VocabularyDictionary({cacheName:'obreader-full-benchmark',workerBatchSize:${workerBatchSize},adapter:{
        async read(path){return (await fetch('/manifest.json')).text()},
        async readBinary(path){binaryReads++;return (await fetch('/'+path.split('/').at(-1))).arrayBuffer()}
      },onProfile(event){profile.push({...event,at:performance.now()});},onStatus(status){progress.push({...status,at:performance.now()});document.querySelector('progress').value=status.count;
        document.querySelector('#state').textContent=status.phase==='ready'?'词典已就绪：'+status.count+' 条':'词典准备中 '+Math.round(status.count/(status.total||1)*100)+'%';}});
      window.run=async()=>{const profileStart=profile.length;const start=performance.now(); const first=await dictionary.lookup('on'); const coldMs=performance.now()-start;const coldProfile=profile.slice(profileStart);
        document.querySelector('#meaning').textContent=first.translation+'\\n'+first.phonetic;
        const latencies=[];for(let i=0;i<100;i++){const t=performance.now();const entry=await dictionary.lookup(['on','mostly','subscription','details','about'][i%5]);if(!entry?.translation)throw Error('missing definition');latencies.push(performance.now()-t)}
        clearInterval(timer);latencies.sort((a,b)=>a-b);return {coldMs,binaryReads,first,p50Ms:latencies[50],p95Ms:latencies[95],maxFrameGapMs:Math.max(0,...ticks),progress:progress.filter((p,i)=>!i||p.phase!==progress[i-1].phase),coldProfile,heap:performance.memory?.usedJSHeapSize||null}};
    </script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await launchTestBrowser(puppeteer, { executablePath: resolveBrowserPath(), headless: true,
    protocolTimeout: 180000, args: ["--no-sandbox", "--disable-dev-shm-usage"] }, { testName: "dictionary-resource-benchmark" });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 760 });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const cold = await page.evaluate(() => run());
  assert.equal(cold.binaryReads, 1);
  assert.ok(cold.first.translation.includes("之上"));
  await page.reload();
  const warm = await page.evaluate(() => run());
  assert.equal(warm.binaryReads, 0, "restart uses IndexedDB, never gzip reads");
  assert.deepEqual(cold.first, warm.first);
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await mkdir(path.join(root, "tests/artifacts"), { recursive: true });
  await page.screenshot({ path: path.join(root, "tests/artifacts/dictionary-cache-mobile-ready.png") });
  await mkdir(path.join(root, "tests/output/dictionary-0.11.8"), { recursive: true });
  const report = { entryCount: manifest.entryCount, resourceBytes: manifest.compressedBytes, workerBatchSize, cold, warm,
    platform: "Chromium automation; mobile viewport is not iPad WKWebView acceptance" };
  await writeFile(path.join(root, `tests/output/dictionary-0.11.8/browser-full-benchmark-batch-${workerBatchSize}.json`),
    `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
