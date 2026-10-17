import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import { resolveBrowserPath } from "./browser-path.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";

const browserPath = resolveBrowserPath();
const fixture = path.join(root, "tests", "fixtures", "tracemonkey.pdf");
const bridgePath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
const viewerHtmlPath = path.join(
  root,
  "vendor",
  "pdfjs-generic-legacy",
  "web",
  "viewer.html",
);
const channel = "pdf-web-reader";
const token = "autosave-mobile-regression";
const documentId = "mobile-autosave-session";
const documentPath = "tests/fixtures/tracemonkey.pdf";
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".ftl", "text/plain; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".pdf", "application/pdf"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

test("iOS auto-save waits for idle and cooldown, then writes only the latest revision", {
  skip: !browserPath && "Chrome or Edge is required for this browser regression",
  timeout: 60_000,
}, async () => {
  const bridgeSource = await readBridgeRuntimeSource(bridgePath);
  const viewerHtml = await readFile(viewerHtmlPath, "utf8");
  const viewerWithBridge = viewerHtml.replace(
    /<head\b[^>]*>/i,
    (head) =>
      `${head}<script src="obsidian-bridge.js" data-channel="${channel}" data-token="${token}" data-renderer-generation="mobile-renderer" data-ios-input-policy="true"></script>`,
  );
  let browser;
  let page;
  let server;
  let primaryError;
  let cleanupReport;

  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
        <meta charset="utf-8">
        <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{width:100%;height:100%;border:0}</style>
        <iframe title="PDF Reader" src="/vendor/pdfjs-generic-legacy/web/viewer.html"></iframe>
        ${browserSidecarHarnessScript({ channel, token, holdIdentityResponses:true })}
        <script>
          const channel = ${JSON.stringify(channel)};
          const token = ${JSON.stringify(token)};
          const documentId = ${JSON.stringify(documentId)};
          const documentPath = ${JSON.stringify(documentPath)};
          const iframe = document.querySelector('iframe');
          const state = window.__host = {
            ready:false, opened:false, saves:[], flushes:[], runtimeLogs:[], errors:[],
            heldLease:null, queuedLease:null, holdNextLease:false,
            nextLease:0, leaseEvents:[], readinessEvents:[],
          };
          function grantLease(message) {
            const leaseId = 'mobile-lease-' + (++state.nextLease);
            state.heldLease = { id:message.id, leaseId, documentId:message.documentId };
            state.leaseEvents.push({ type:'grant', id:message.id, leaseId, at:performance.timeOrigin + performance.now() });
            iframe.contentWindow.postMessage({
              channel, type:'heavy-granted', token, rendererGeneration:'mobile-renderer',
              id:message.id, leaseId, documentId:message.documentId,
              openRequest:message.openRequest,
            }, '*');
          }
          window.addEventListener('message', event => {
            if (event.source !== iframe.contentWindow) return;
            const message = event.data;
            if (!message || message.channel !== channel || message.token !== token) return;
            if (message.type === 'runtime-log') {
              state.runtimeLogs.push(...(message.rows || []));
            } else if (message.type === 'ready') {
              state.ready = true;
              fetch('/tests/fixtures/tracemonkey.pdf').then(response => response.arrayBuffer()).then(data => {
                iframe.contentWindow.postMessage({
                  channel, type:'open', token, documentId, documentPath,
                  filename:'tracemonkey.pdf', autoSave:true, heavyLeaseRequired:true,
                  openRequest:1, data,
                }, '*', [data]);
              }).catch(error => state.errors.push(error.message));
            } else if (message.type === 'opened') {
              state.opened = true;
              state.openedAt = Date.now();
            } else if (message.type === 'heavy-acquire') {
              if (state.heldLease || state.queuedLease) {
                state.errors.push('A second heavy lease was requested before the previous request settled.');
                return;
              }
              if (state.holdNextLease) {
                state.holdNextLease = false;
                state.queuedLease = {
                  id:message.id,
                  documentId:message.documentId,
                  openRequest:message.openRequest,
                };
                state.leaseEvents.push({ type:'queued', id:message.id, at:performance.timeOrigin + performance.now() });
                return;
              }
              grantLease(message);
            } else if (message.type === 'heavy-release') {
              if (!state.heldLease || state.heldLease.leaseId !== message.leaseId) {
                state.errors.push('The viewer released a heavy lease it did not hold.');
                return;
              }
              state.leaseEvents.push({ type:'release', leaseId:message.leaseId, at:performance.timeOrigin + performance.now() });
              state.heldLease = null;
            } else if (message.type === 'heavy-cancel') {
              state.leaseEvents.push({ type:'cancel', id:message.id, at:performance.timeOrigin + performance.now() });
              if (state.queuedLease?.id === message.id) {
                const queued = state.queuedLease;
                state.queuedLease = null;
                iframe.contentWindow.postMessage({
                  channel, type:'heavy-rejected', token, rendererGeneration:'mobile-renderer',
                  id:message.id, documentId:queued.documentId, openRequest:queued.openRequest,
                  reason:'fixture lease request cancelled',
                }, '*');
              }
            } else if (message.type === 'save') {
              if (state.saves.length === 0) {
                state.readinessEvents.push({ type:'first-save-received', at:Date.now() });
              }
              if (!state.heldLease || state.heldLease.leaseId !== message.heavyLeaseId) {
                state.errors.push('Save did not carry the currently held heavyLeaseId.');
              }
              const save = {
                documentId:message.documentId,
                origin:message.origin,
                revision:message.revision,
                requestId:message.requestId,
                heavyLeaseId:message.heavyLeaseId,
                receivedAt:performance.timeOrigin + performance.now(),
                acknowledgedAt:null,
              };
              state.saves.push(save);
              setTimeout(() => {
                save.acknowledgedAt = performance.timeOrigin + performance.now();
                iframe.contentWindow.postMessage({
                  channel, type:'saved', token, documentId:message.documentId,
                  openRequest:message.openRequest,
                  requestId:message.requestId, revision:message.revision,
                  external:true, operationCount:message.operations.length, batchId:message.requestId,
                }, '*');
              }, state.saves.length === 1 ? 1400 : 40);
            } else if (message.type === 'flushed') {
              state.flushes.push({ id:message.id, ok:message.ok, dirty:message.dirty });
            } else if (message.type === 'error') {
              state.errors.push(message.message || message.code || 'viewer error');
            }
          });
        </script>`);
      return;
    }

    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/viewer.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(viewerWithBridge);
      return;
    }
    if (url.pathname === "/vendor/pdfjs-generic-legacy/web/obsidian-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }

    let target;
    if (url.pathname === "/tests/fixtures/tracemonkey.pdf") {
      target = fixture;
    } else if (url.pathname.startsWith("/vendor/pdfjs-generic-legacy/")) {
      const relative = decodeURIComponent(
        url.pathname.slice("/vendor/pdfjs-generic-legacy/".length),
      );
      target = path.resolve(root, "vendor", "pdfjs-generic-legacy", relative);
      if (!target.startsWith(path.join(root, "vendor", "pdfjs-generic-legacy") + path.sep)) {
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

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    browser = await launchTestBrowser(puppeteer, {
      executablePath: browserPath,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    }, { testName: "autosave-mobile-regression", artifactsDir: resolveTestArtifactRoot(root) });
    page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 780 });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const viewer = page.frames().find((frame) => frame.url().includes("/web/viewer.html"));
    assert.ok(viewer, "Viewer iframe should load from the repository source");
    await page.waitForFunction(() => window.__host?.opened, { timeout: 30_000 });
    await viewer.waitForSelector('.page[data-page-number="1"] .annotationEditorLayer');

    await page.waitForFunction(() => window.__browserSidecarHost?.identityRequests.some(
      (request) => request.documentId === "mobile-autosave-session" &&
        request.openRequest === 1 && request.identityStatus === "KNOWN",
    ), { timeout: 30_000 });
    const pendingIdentity = await page.evaluate(() => ({
      openedAt:window.__host.openedAt,
      request:window.__browserSidecarHost.identityRequests.find(
        (request) => request.documentId === "mobile-autosave-session" && request.openRequest === 1,
      ),
      heldCount:window.__browserSidecarHost.heldIdentityResponses.length,
      confirmationCount:window.__browserSidecarHost.identityConfirmations.length,
      saveCount:window.__host.saves.length,
    }));
    const pendingViewer = await viewer.evaluate(() => ({
      readOnly:document.documentElement.hasAttribute("data-pdf-reader-readonly"),
      toolDisabled:document.getElementById("editorSquareButton")?.disabled ?? null,
      storageSize:PDFViewerApplication.pdfDocument.annotationStorage.size,
    }));
    assert.equal(pendingViewer.readOnly, true, "The viewer must remain read-only until identity is confirmed");
    assert.equal(pendingViewer.toolDisabled, true, "Annotation tools must stay disabled while identity is pending");
    assert.equal(pendingViewer.storageSize, 0, "No synthetic annotation edit may occur while identity is pending");
    assert.equal(pendingIdentity.heldCount, 1, "The fixture must hold the deterministic identity response");
    assert.equal(pendingIdentity.confirmationCount, 0);
    assert.equal(pendingIdentity.saveCount, 0);
    console.log("[autosave-readiness] identity pending:", JSON.stringify({ pendingIdentity, pendingViewer }));

    const releasedIdentityCount = await page.evaluate(
      () => window.__browserSidecarHost.releaseIdentityResponses(),
    );
    assert.equal(releasedIdentityCount, 1, "The held identity response must be released exactly once");
    await viewer.waitForFunction(
      () => !document.documentElement.hasAttribute("data-pdf-reader-readonly"),
      { timeout: 5_000 },
    );
    await page.evaluate(() => {
      window.__host.identityConfirmedObservedAt = Date.now();
      window.__host.readinessEvents.push({ type:"identity-confirmed-observed", at:Date.now() });
    });

    const markDirty = ({ recordReadiness = false } = {}) => viewer.evaluate(({ recordReadiness }) => {
      const readOnly = document.documentElement.hasAttribute("data-pdf-reader-readonly");
      if (readOnly) throw new Error("Fixture attempted an annotation edit before identity confirmation");
      if (recordReadiness) {
        window.parent.__host.readinessEvents.push({ type:"first-mark-dirty", at:Date.now(), readOnly });
      }
      const storage = PDFViewerApplication.pdfDocument.annotationStorage;
      if (typeof storage.onModified !== "function") {
        throw new Error("PDF.js annotation storage has no modified callback");
      }
      const index = window.__mobileEditNumber = (window.__mobileEditNumber || 0) + 1;
      // A notification with no content change must not trigger autosave. Supply
      // an actual committed storage editor for each distinct fixture revision.
      const serialized = { annotationType: 5, pageIndex: 0,
        rect: [index, 20, index + 60, 60], color: [0, 0, 0], opacity: 1, thickness: 1 };
      storage.setValue(`mobile-fixture-${index}`, serialized);
    }, { recordReadiness });
    const saveCount = () => page.evaluate(() => window.__host.saves.length);

    await markDirty({ recordReadiness:true });
    await page.waitForFunction(() => window.__host.saves.length === 1, { timeout: 8_000 })
      .catch(async (error) => {
        console.error("Mobile first-save readiness timeline:", await page.evaluate(() => ({
          readinessEvents:window.__host.readinessEvents,
          openedAt:window.__host.openedAt,
          identityRequests:window.__browserSidecarHost.identityRequests,
          identityConfirmations:window.__browserSidecarHost.identityConfirmations,
          heldIdentityCount:window.__browserSidecarHost.heldIdentityResponses.length,
          saves:window.__host.saves,
          errors:window.__host.errors,
        })));
        console.error("Mobile first-save viewer state:", await viewer.evaluate(() => ({
          readOnly:document.documentElement.hasAttribute("data-pdf-reader-readonly"),
          hasChanges:PDFViewerApplication._hasChanges(),
          modified:PDFViewerApplication._annotationStorageModified,
          storageSize:PDFViewerApplication.pdfDocument.annotationStorage.size,
          bridgeLog:window.__PDF_READER_DRAIN_LOG__?.() || [],
        })));
        throw error;
      });
    const readinessTimeline = await page.evaluate(() => ({
      request:window.__browserSidecarHost.identityRequests.find(
        (request) => request.documentId === "mobile-autosave-session" && request.openRequest === 1,
      ),
      confirmation:window.__browserSidecarHost.identityConfirmations[0],
      events:window.__host.readinessEvents,
    }));
    const readinessAt = Object.fromEntries(readinessTimeline.events.map(({ type, at }) => [type, at]));
    assert.ok(readinessTimeline.request.requestedAt <= readinessTimeline.confirmation.sentAt);
    assert.ok(readinessTimeline.confirmation.sentAt <= readinessAt["identity-confirmed-observed"]);
    assert.ok(readinessAt["identity-confirmed-observed"] <= readinessAt["first-mark-dirty"]);
    assert.ok(readinessAt["first-mark-dirty"] <= readinessAt["first-save-received"]);
    console.log("[autosave-readiness] confirmed/dirty/save timeline:", JSON.stringify(readinessTimeline));
    const firstSave = await page.evaluate(() => window.__host.saves[0]);
    assert.equal(firstSave.origin, "auto");

    // Several edits during one held auto flight collapse into one follow-up
    // for the latest revision after the idle debounce and mobile cooldown.
    await markDirty();
    await markDirty();
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await saveCount(), 1, "A running auto-save must not queue another host write");
    await page.waitForFunction(
      () => window.__host.saves[0]?.acknowledgedAt !== null,
      { timeout: 5_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(await saveCount(), 1, "The next auto-save must wait through the mobile cooldown");
    await page.waitForFunction(() => window.__host.saves.length === 2, { timeout: 15_000 })
      .catch(async (error) => {
        console.error("Mobile auto-save state:", await page.evaluate(() => window.__host));
        console.error("Mobile auto-save viewer:", await viewer.evaluate(() => ({
          hasChanges:PDFViewerApplication._hasChanges(),
          modified:PDFViewerApplication._annotationStorageModified,
          storageSize:PDFViewerApplication.pdfDocument.annotationStorage.size,
          bridgeLog:window.__PDF_READER_DRAIN_LOG__?.() || [],
        })));
        throw error;
      });
    const secondSave = await page.evaluate(() => window.__host.saves[1]);
    assert.equal(secondSave.origin, "auto");
    assert.equal(
      secondSave.revision,
      firstSave.revision + 2,
      "The follow-up should contain the newest revision after all in-flight edits",
    );
    assert.ok(
      secondSave.receivedAt - firstSave.receivedAt >= 10_000,
      "Mobile auto-save starts must remain at least ten seconds apart",
    );
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 5_000 });

    // Explicit manual saves and lifecycle flushes bypass auto cooldown.
    await markDirty();
    const manualRequestedAt = await page.evaluate(
      () => performance.timeOrigin + performance.now(),
    );
    await viewer.evaluate(() => PDFViewerApplication.overwriteOriginal());
    await page.waitForFunction(() => window.__host.saves.length === 3, { timeout: 3_000 });
    const manualSave = await page.evaluate(() => window.__host.saves[2]);
    assert.equal(manualSave.origin, "manual");
    assert.ok(manualSave.receivedAt - manualRequestedAt < 2_500);
    await viewer.waitForFunction(() => !PDFViewerApplication._hasChanges(), { timeout: 5_000 });

    await markDirty();
    await page.evaluate(() => {
      document.querySelector("iframe").contentWindow.postMessage({
        channel, type:"flush", token, documentId, id:"mobile-flush-cooldown",
      }, "*");
    });
    await page.waitForFunction(() => window.__host.flushes.length === 1, { timeout: 5_000 });
    assert.deepEqual(
      await page.evaluate(() => window.__host.flushes[0]),
      { id:"mobile-flush-cooldown", ok:true, dirty:false },
    );
    await page.waitForFunction(() => window.__host.saves.length === 4, { timeout: 3_000 });
    assert.equal(
      await page.evaluate(() => window.__host.saves[3].origin),
      "manual",
      "A close/lifecycle flush must write immediately during auto cooldown",
    );
    await page.waitForFunction(
      () => window.__host.leaseEvents.filter((event) => event.type === "release").length === 4 &&
        window.__host.heldLease === null,
      { timeout: 5_000 },
    );
    const leaseState = await page.evaluate(() => ({
      saves:window.__host.saves,
      events:window.__host.leaseEvents,
      heldLease:window.__host.heldLease,
    }));
    assert.equal(leaseState.heldLease, null, "Every save must release its host lease");
    assert.equal(leaseState.saves.length, 4);
    assert.ok(leaseState.saves.every((save) => save.heavyLeaseId));
    const grants = leaseState.events.filter((event) => event.type === "grant");
    const releases = leaseState.events.filter((event) => event.type === "release");
    assert.equal(grants.length, leaseState.saves.length);
    assert.equal(releases.length, leaseState.saves.length);
    for (let index = 0; index < leaseState.saves.length; index += 1) {
      assert.equal(leaseState.saves[index].heavyLeaseId, grants[index].leaseId);
      assert.ok(
        releases[index].at > grants[index].at,
        "A granted lease must be released before the save flight settles",
      );
      const nextGrant = grants[index + 1];
      if (nextGrant) {
        const releaseIndex = leaseState.events.findIndex(
          (event) => event.type === "release" && event.leaseId === grants[index].leaseId,
        );
        const nextGrantIndex = leaseState.events.findIndex(
          (event) => event.type === "grant" && event.leaseId === nextGrant.leaseId,
        );
        assert.ok(releaseIndex >= 0 && releaseIndex < nextGrantIndex);
      }
    }

    // Cancel a queued lease when the viewer is disposed while waiting. This
    // exercises the host's cancellation reply without adding a separate case.
    await page.evaluate(() => { window.__host.holdNextLease = true; });
    await markDirty();
    await page.waitForFunction(
      () => window.__host.leaseEvents.some((event) => event.type === "queued"),
      { timeout: 20_000 },
    );
    await viewer.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.waitForFunction(
      () => window.__host.leaseEvents.some((event) => event.type === "cancel") &&
        window.__host.queuedLease === null && window.__host.heldLease === null,
      { timeout: 5_000 },
    );
    assert.equal(
      await page.evaluate(() => window.__host.heldLease),
      null,
      "The cancelled waiter must not leave a host lease held",
    );
    assert.equal(await page.evaluate(() => window.__host.saves.length), 4);
    assert.deepEqual(await page.evaluate(() => window.__host.errors), []);
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupReport = await cleanupBrowserTestResources({
      browser,
      ownedPages: [page].filter(Boolean),
      server,
    });
    if (cleanupReport?.status !== "normal" || cleanupReport?.errors?.length) {
      const artifactDirectory = resolveTestArtifactRoot(root);
      const artifactPath = path.join(
        artifactDirectory,
        `autosave-mobile-cleanup-${Date.now()}-${process.pid}.json`,
      );
      try {
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(artifactPath, `${JSON.stringify(cleanupReport, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        console.error(`[autosave-mobile-cleanup] ${artifactPath}`);
      } catch (error) {
        console.error(`[autosave-mobile-cleanup] Could not write ${artifactPath}: ${error?.message || error}`);
      }
    }
  }
  const finalError = attachCleanupErrors(primaryError, cleanupReport);
  if (finalError) throw finalError;
});
