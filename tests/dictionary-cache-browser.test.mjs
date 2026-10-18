import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import puppeteer from "puppeteer-core";
import test from "node:test";
import { build as buildDictionaryResource } from "../scripts/build-dictionary-resource.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
  observeBrowserTestChildStderr,
} from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

async function makeBrowserBundles() {
  const workerBuild = await esbuild({
    entryPoints: [path.join(root, "plugin/vocabulary/dictionary-worker.cjs")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120"],
    write: false,
  });
  const workerSource = workerBuild.outputFiles[0].text;
  const mainBuild = await esbuild({
    entryPoints: [path.join(root, "plugin/vocabulary/dictionary.cjs")],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "DictionaryBundle",
    target: ["chrome120"],
    define: { __PDF_DICTIONARY_WORKER_SOURCE__: JSON.stringify(workerSource) },
    write: false,
  });
  return mainBuild.outputFiles[0].text;
}

test("browser dictionary imports in a real worker and falls back at a mobile viewport", { timeout: 120_000 }, async (t) => {
  const browserPath = resolveBrowserPath();
  if (!browserPath) {
    t.skip("A supported local Chrome or Edge executable is required for this browser test.");
    return;
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "obreader-dictionary-browser-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, "ecdict.csv.gz");
  const resourceRoot = path.join(temporaryRoot, "resource-v2");
  const csv = [
    "word,phonetic,definition,translation",
    '"alpha","ˈælfə","","阿尔法"',
    '"beta","ˈbiːtə","","贝塔"',
    '"gamma","ˈɡæmə","","伽马"',
  ].join("\n") + "\n";
  const { gzipSync } = await import("node:zlib");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(sourcePath, gzipSync(Buffer.from(csv, "utf8"), { mtime: 0 }));
  await buildDictionaryResource({ input: sourcePath, output: resourceRoot });
  const manifestText = await readFile(path.join(resourceRoot, "manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText);
  const resourceBytes = await readFile(path.join(resourceRoot, manifest.resourceFile));
  const httpRequests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    httpRequests.push(pathname);
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Dictionary cache browser test</title>");
      return;
    }
    if (pathname === "/dictionary/manifest.json") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(manifestText);
      return;
    }
    if (pathname === `/dictionary/${manifest.resourceFile}`) {
      response.writeHead(200, { "content-type": "application/gzip", "content-length": resourceBytes.length });
      response.end(resourceBytes);
      return;
    }
    response.writeHead(404).end("not found");
  });

  let browser;
  let page;
  let browserObserver;
  let origin;
  let primaryError = null;
  try {
    origin = await listen(server);
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "dictionary-cache-browser" });
    browserObserver = observeBrowserTestChildStderr(browser.process?.());
    page = await browser.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const browserBundle = await makeBrowserBundles();
    await page.addScriptTag({ content: browserBundle });

    const workerResult = await page.evaluate(async ({ origin, cacheName }) => {
      const { VocabularyDictionary } = window.DictionaryBundle;
      const originalWorker = window.Worker;
      window.__dictionaryWorkerCount = 0;
      class CountingWorker extends originalWorker {
        constructor(...args) {
          super(...args);
          window.__dictionaryWorkerCount += 1;
        }
      }
      const reads = { manifest: 0, binary: 0 };
      const adapter = {
        async read(file) {
          reads.manifest += 1;
          const response = await fetch(`${origin}${file}`);
          if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
          return response.text();
        },
        async readBinary(file) {
          reads.binary += 1;
          const response = await fetch(`${origin}${file}`);
          if (!response.ok) throw new Error(`resource HTTP ${response.status}`);
          return response.arrayBuffer();
        },
      };
      const status = [];
      const dictionary = new VocabularyDictionary({
        adapter,
        root: "/dictionary",
        cacheName,
        WorkerClass: CountingWorker,
        onStatus: (value) => status.push(value.phase),
      });
      // The bundle embeds the worker source at build time; passing undefined
      // lets the module's compile-time value select the real worker path.
      const ready = await dictionary.ensureReady();
      const lookup = await dictionary.lookup(" ALPHA ");
      const result = {
        count: ready.count,
        status: ready.status,
        lookup,
        workerCount: window.__dictionaryWorkerCount,
        binaryReads: reads.binary,
        phases: status,
      };
      dictionary.dispose();
      return result;
    }, { origin, cacheName: `dictionary-worker-${crypto.randomUUID()}` });

    assert.equal(workerResult.status, "ready");
    assert.equal(workerResult.count, 3);
    assert.deepEqual(workerResult.lookup, {
      key: "alpha", translation: "阿尔法", phonetic: "ˈælfə", source: "ECDICT",
    });
    assert.equal(workerResult.workerCount, 1, "the import ran in a real browser Worker");
    assert.equal(workerResult.binaryReads, 1, "the main thread fetches the Vault resource once");
    assert.ok(workerResult.phases.includes("ready"));

    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    // Changing the emulated mobile device can reload the page in Puppeteer.
    await page.addScriptTag({ content: browserBundle });
    const mobileResult = await page.evaluate(async ({ origin, cacheName }) => {
      const { VocabularyDictionary } = window.DictionaryBundle;
      const reads = { binary: 0 };
      const adapter = {
        async read(file) {
          const response = await fetch(`${origin}${file}`);
          if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
          return response.text();
        },
        async readBinary(file) {
          reads.binary += 1;
          const response = await fetch(`${origin}${file}`);
          if (!response.ok) throw new Error(`resource HTTP ${response.status}`);
          return response.arrayBuffer();
        },
      };
      const dictionary = new VocabularyDictionary({
        adapter,
        root: "/dictionary",
        cacheName,
        WorkerClass: null,
      });
      const ready = await dictionary.ensureReady();
      const lookup = await dictionary.lookup("gamma");
      const result = {
        width: innerWidth,
        mobile: matchMedia("(max-width: 600px)").matches,
        count: ready.count,
        status: ready.status,
        lookup,
        binaryReads: reads.binary,
      };
      dictionary.dispose();
      return result;
    }, { origin, cacheName: `dictionary-mobile-${crypto.randomUUID()}` });

    assert.equal(mobileResult.width, 390);
    assert.equal(mobileResult.mobile, true);
    assert.equal(mobileResult.status, "ready");
    assert.equal(mobileResult.count, 3);
    assert.deepEqual(mobileResult.lookup, {
      key: "gamma", translation: "伽马", phonetic: "ˈɡæmə", source: "ECDICT",
    });
    assert.equal(mobileResult.binaryReads, 1, "mobile cooperative fallback imports without a Worker");
    assert.ok(httpRequests.includes("/dictionary/manifest.json"));
    assert.ok(httpRequests.includes(`/dictionary/${manifest.resourceFile}`));
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupReport = await cleanupBrowserTestResources({
      browser,
      browserObserver,
      ownedPages: page ? [page] : [],
      server,
    });
    await rm(temporaryRoot, { recursive: true, force: true });
    if (cleanupReport.errors.length) {
      throw attachCleanupErrors(primaryError, cleanupReport);
    }
  }
  if (primaryError) throw primaryError;
});
