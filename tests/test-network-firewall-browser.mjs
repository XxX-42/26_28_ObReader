import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
  observeBrowserTestChildStderr,
} from "./browser-test-cleanup.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import {
  TEST_NETWORK_FIREWALL_CSP,
  withTestNetworkFirewall,
} from "./test-network-firewall.mjs";

const artifactsDirectory = path.join(root, "tests", "artifacts");
const browserPath = resolveBrowserPath();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

const allowedModule = "export const value = 'same-origin-module-loaded';";
const allowedWorkerModule = "export const value = 'same-origin-worker-module-loaded';";
const forbiddenWorkerModule = "export const value = 'forbidden-worker-module-loaded';";

async function main() {
  assert.ok(browserPath, "A supported local Chrome or Edge executable is required");
  const localRequests = [];
  const forbiddenRequests = [];
  let forbiddenOrigin = null;
  const localServer = createServer((request, response) => {
    for (const [name, value] of Object.entries(withTestNetworkFirewall())) {
      response.setHeader(name, value);
    }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    localRequests.push(pathname);
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Network firewall regression</title>");
      return;
    }
    if (pathname === "/allowed-page-fetch") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("same-origin-fetch-loaded");
      return;
    }
    if (pathname === "/allowed-module.mjs") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(allowedModule);
      return;
    }
    if (pathname === "/allowed-worker-module.mjs") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(allowedWorkerModule);
      return;
    }
    if (pathname === "/network-worker.mjs") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(
        `import(${JSON.stringify(`${forbiddenOrigin}/network-worker-module.mjs`)})` +
          ".then(module => postMessage({status:'loaded', value:module.value}))" +
          ".catch(error => postMessage({status:'rejected', name:error.name, message:error.message}));",
      );
      return;
    }
    response.writeHead(404).end("not found");
  });
  const forbiddenServer = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    forbiddenRequests.push(pathname);
    response.setHeader("access-control-allow-origin", "*");
    if (pathname === "/page-fetch" || pathname === "/srcdoc-page-fetch") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("forbidden-page-fetch-reached-server");
      return;
    }
    if (pathname === "/worker-module.mjs" ||
        pathname === "/network-worker-module.mjs" ||
        pathname === "/srcdoc-worker-module.mjs") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(forbiddenWorkerModule);
      return;
    }
    response.writeHead(404).end("not found");
  });

  let browser;
  let page;
  let browserObserver;
  let primaryError = null;
  let artifactPath;
  let cleanupReport;
  const evidence = {
    browserPath,
    localOrigin: null,
    forbiddenOrigin: null,
    cspHeader: null,
    localRequests,
    forbiddenRequests,
    pageResult: null,
    error: null,
    cleanup: null,
  };

  try {
    evidence.localOrigin = await listen(localServer);
    forbiddenOrigin = evidence.forbiddenOrigin = await listen(forbiddenServer);
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "test-network-firewall-browser" });
    browserObserver = observeBrowserTestChildStderr(browser.process?.());
    page = await browser.newPage();
    const response = await page.goto(evidence.localOrigin, {
      waitUntil: "domcontentloaded",
    });
    evidence.cspHeader = response?.headers()?.["content-security-policy"] ?? null;
    assert.equal(evidence.cspHeader, TEST_NETWORK_FIREWALL_CSP);

    // page.setContent replaces the initial document. This also exercises the
    // same policy-container inheritance used by srcdoc-based viewer fixtures.
    await page.setContent(`
      <!doctype html><meta charset=utf-8>
      <script>window.__networkFirewallSetContentRan=true</script>
      <iframe id="srcdoc-probe" sandbox="allow-same-origin allow-scripts"
        srcdoc="&lt;!doctype html&gt;&lt;script&gt;window.__srcdocReady=true&lt;/script&gt;"></iframe>
    `, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.__networkFirewallSetContentRan === true,
      { timeout: 5_000 },
    );
    const srcdocFrame = page.frames().find((frame) => frame !== page.mainFrame());
    assert.ok(srcdocFrame, "Expected the policy-inheriting srcdoc frame");
    await srcdocFrame.waitForFunction(
      () => window.__srcdocReady === true,
      { timeout: 5_000 },
    );
    evidence.pageResult = await page.evaluate(async ({ localOrigin, forbiddenOrigin }) => {
      const localPageFetch = await fetch(`${localOrigin}/allowed-page-fetch`)
        .then(async (result) => ({
          status: result.status,
          body: await result.text(),
        }))
        .catch((error) => ({ error: error?.message ?? String(error) }));
      const localImport = await import(`${localOrigin}/allowed-module.mjs`)
        .then((module) => ({ value: module.value }))
        .catch((error) => ({ error: error?.message ?? String(error) }));

      const awaitWorkerMessage = (worker, blobUrl = null) => new Promise((resolve) => {
        const finish = (result) => {
          clearTimeout(timer);
          worker.terminate();
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          resolve(result);
        };
        const timer = setTimeout(() => finish({ status: "timeout" }), 5_000);
        worker.addEventListener("message", (event) => finish(event.data), { once: true });
        worker.addEventListener("error", (event) => finish({
          status: "worker-error",
          message: event.message,
        }), { once: true });
      });
      const runBlobWorkerImport = (url) => {
        const source = `import(${JSON.stringify(url)}).then(module => postMessage({status:'loaded', value:module.value})).catch(error => postMessage({status:'rejected', name:error.name, message:error.message}));`;
        const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        const worker = new Worker(blobUrl, { type: "module" });
        return awaitWorkerMessage(worker, blobUrl);
      };

      const localBlobWorkerImport = await runBlobWorkerImport(
        `${localOrigin}/allowed-worker-module.mjs`,
      );
      const directNetworkWorkerImport = await awaitWorkerMessage(
        new Worker(`${localOrigin}/network-worker.mjs`, { type: "module" }),
      );
      const forbiddenPageFetch = await fetch(`${forbiddenOrigin}/page-fetch`)
        .then(async (result) => ({
          status: result.status,
          body: await result.text(),
        }))
        .catch((error) => ({
          status: "rejected",
          name: error?.name ?? "Error",
          message: error?.message ?? String(error),
        }));
      const forbiddenBlobWorkerImport = await runBlobWorkerImport(
        `${forbiddenOrigin}/worker-module.mjs`,
      );

      return {
        setContentUrl: location.href,
        setContentScriptRan: window.__networkFirewallSetContentRan === true,
        localPageFetch,
        localImport,
        localBlobWorkerImport,
        directNetworkWorkerImport,
        forbiddenPageFetch,
        forbiddenBlobWorkerImport,
      };
    }, {
      localOrigin: evidence.localOrigin,
      forbiddenOrigin: evidence.forbiddenOrigin,
    });
    evidence.pageResult.srcdocPageFetch = await srcdocFrame.evaluate(async (origin) =>
      fetch(`${origin}/srcdoc-page-fetch`)
        .then(async (result) => ({
          status: result.status,
          body: await result.text(),
        }))
        .catch((error) => ({
          status: "rejected",
          name: error?.name ?? "Error",
          message: error?.message ?? String(error),
        })), evidence.forbiddenOrigin);

    assert.equal(evidence.pageResult.setContentScriptRan, true);
    assert.deepEqual(evidence.pageResult.localPageFetch, {
      status: 200,
      body: "same-origin-fetch-loaded",
    });
    assert.deepEqual(evidence.pageResult.localImport, {
      value: "same-origin-module-loaded",
    });
    assert.deepEqual(evidence.pageResult.localBlobWorkerImport, {
      status: "loaded",
      value: "same-origin-worker-module-loaded",
    });
    assert.equal(evidence.pageResult.directNetworkWorkerImport.status, "rejected");
    assert.equal(evidence.pageResult.forbiddenPageFetch.status, "rejected");
    assert.equal(evidence.pageResult.forbiddenBlobWorkerImport.status, "rejected");
    assert.equal(evidence.pageResult.srcdocPageFetch.status, "rejected");
    assert.deepEqual(forbiddenRequests, []);
    assert.ok(localRequests.includes("/allowed-page-fetch"));
    assert.ok(localRequests.includes("/allowed-module.mjs"));
    assert.ok(localRequests.includes("/allowed-worker-module.mjs"));
    assert.ok(localRequests.includes("/network-worker.mjs"));
  } catch (error) {
    primaryError = error;
    evidence.error = {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    };
  }

  const localCleanup = await cleanupBrowserTestResources({
    browser,
    browserObserver,
    ownedPages: page ? [page] : [],
    server: localServer.listening ? localServer : undefined,
  });
  const forbiddenServerCleanup = await cleanupBrowserTestResources({
    server: forbiddenServer.listening ? forbiddenServer : undefined,
  });
  const cleanupStatuses = [localCleanup.status, forbiddenServerCleanup.status];
  cleanupReport = {
    status: cleanupStatuses.includes("failed")
      ? "failed"
      : cleanupStatuses.includes("forced")
        ? "forced"
        : "normal",
    browser: localCleanup.browser ?? null,
    servers: [localCleanup.server, forbiddenServerCleanup.server].filter(Boolean),
    errors: [
      ...(localCleanup.errors ?? []),
      ...(forbiddenServerCleanup.errors ?? []),
    ],
  };
  evidence.cleanup = cleanupReport;
  if (cleanupReport.status !== "normal" && !primaryError) {
    primaryError = new Error(
      `Controlled network-firewall cleanup ended with status ${cleanupReport.status}`,
    );
  }

  artifactPath = path.join(
    artifactsDirectory,
    `test-network-firewall-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}-${randomUUID()}.json`,
  );
  try {
    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(artifactPath, JSON.stringify(evidence, null, 2), "utf8");
  } catch (error) {
    if (!primaryError) primaryError = error;
    evidence.artifactWriteError = {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
    };
  }

  if (primaryError) throw attachCleanupErrors(primaryError, cleanupReport);

  process.stdout.write(`${JSON.stringify({ status: "passed", artifactPath, ...evidence }, null, 2)}\n`);
}

await main();
