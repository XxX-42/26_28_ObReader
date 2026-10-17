import { browserSidecarHarnessScript } from "./browser-sidecar-harness.mjs";
import { launchTestBrowser } from "./browser-test-launch.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import puppeteer from "puppeteer-core";
import { resolveBrowserPath } from "./browser-path.mjs";
import {
  attachCleanupErrors,
  cleanupBrowserTestResources,
} from "./browser-test-cleanup.mjs";
import { root } from "./bundled-plugin-test-utils.mjs";
import { resolveTestArtifactRoot } from "./test-artifact-root.mjs";
import { readBridgeRuntimeSource } from "./bridge-runtime-source.mjs";

const browserPath = resolveBrowserPath();
const artifactsPath = resolveTestArtifactRoot(root);
const vendorRoot = path.join(root, "vendor", "pdfjs-generic-legacy");
const vendorWeb = path.join(vendorRoot, "web");
const bridgeCssPath = path.join(root, "viewer-adapter", "bridge.css");
const bridgeJsPath = path.join(root, "viewer-adapter", "obsidian-bridge.js");
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

function createPointerPolicyPdf(pageCount = 14) {
  const objects = new Map([
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    [4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"],
  ]);
  const pageRefs = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const pageObject = 5 + (pageNumber - 1) * 2;
    const contentObject = pageObject + 1;
    const content = Array.from({ length: 6 }, (_, lineIndex) =>
      `BT /F1 12 Tf 36 ${750 - lineIndex * 24} Td (iPad pointer policy page ${pageNumber}) Tj /F2 12 Tf 145 0 Td (selectable text line ${lineIndex + 1}) Tj ET`,
    ).join("\n") + "\n";
    objects.set(pageObject, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObject} 0 R >>`);
    objects.set(contentObject, `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}endstream`);
    pageRefs.push(`${pageObject} 0 R`);
  }
  objects.set(2, `<< /Type /Pages /Kids [${pageRefs.join(" ")}] /Count ${pageCount} >>`);

  let pdf = "%PDF-1.4\n% Pointer policy test fixture\n";
  const offsets = [0];
  const objectCount = Math.max(...objects.keys());
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    offsets[objectNumber] = Buffer.byteLength(pdf, "ascii");
    pdf += `${objectNumber} 0 obj\n${objects.get(objectNumber)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`;
  for (let objectNumber = 1; objectNumber <= objectCount; objectNumber += 1) {
    pdf += `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

const pointerPolicyPdfFixture = createPointerPolicyPdf();
const pointerPolicyPdfSourceHash = `sha256:${createHash("sha256")
  .update(pointerPolicyPdfFixture).digest("hex")}`;

function hostHtml() {
  return `<!doctype html>
    <meta charset="utf-8">
    <title>iPad pointer policy regression</title>
    <iframe id="pdf-reader" name="pdf-reader"
      style="display:block;width:100vw;height:100vh;border:0"></iframe>
    ${browserSidecarHarnessScript({
      channel: "pdf-web-reader",
      token: "ipad-pointer-policy-test",
      sourceHash: pointerPolicyPdfSourceHash,
      sourcePath: "fixtures/ipad-pointer-policy.pdf",
    })}
    <script>
      const channel = "pdf-web-reader";
      const token = "ipad-pointer-policy-test";
      const sourceHash = ${JSON.stringify(pointerPolicyPdfSourceHash)};
      const sourcePath = "fixtures/ipad-pointer-policy.pdf";
      const frame = document.getElementById("pdf-reader");
      let sequence = 0;
      let initialOpenSent = false;
      window.__host = { opened: [], errors: [] };
      window.__openPdf = async () => {
        const data = await fetch("/fixtures/ipad-pointer-policy.pdf").then((response) => {
          if (!response.ok) throw new Error("Could not fetch PDF fixture");
          return response.arrayBuffer();
        });
        const openRequest = ++sequence;
        const documentId = "ipad-pointer-policy-" + openRequest;
        frame.contentWindow.postMessage({
          channel, token, type: "open", data,
          documentId,
          openRequest, filename: "ipad-pointer-policy.pdf", autoSave: false,
          externalAnnotations: {
            schemaVersion: 2,
            kind: "pdf-annotation-snapshot",
            documentId,
            docKey: "ipad-pointer-policy-test",
            revision: 0,
            updatedAt: Date.now(),
            source: { sourcePath, sourceHash },
            legacyIdentities: [],
            annotations: [],
            tombstones: [],
          },
        }, "*", [data]);
      };
      window.addEventListener("message", (event) => {
        if (event.source !== frame.contentWindow) return;
        const message = event.data;
        if (!message || message.channel !== channel || message.token !== token) return;
        if (message.type === "ready" && !initialOpenSent) {
          initialOpenSent = true;
          void window.__openPdf();
        } else if (message.type === "opened") {
          window.__host.opened.push({
            documentId: message.documentId,
            openRequest: message.openRequest,
          });
        } else if (message.type === "error") {
          window.__host.errors.push(message.message || message.code || "viewer error");
        }
      });
      frame.src = "/viewer/viewer.html";
    </script>`;
}

function viewerHtml(source) {
  const viewerScript = '<script src="viewer.mjs" type="module"></script>';
  assert.ok(source.includes(viewerScript), "Vendor viewer script marker must exist");
  const bridgeAssets = `
    <link rel="stylesheet" href="/bridge.css" />
    <script src="/bridge.js" data-channel="pdf-web-reader" data-token="ipad-pointer-policy-test"
      data-renderer-generation="ipad-pointer-policy-renderer" data-ios-input-policy="true"></script>`;
  return source.replace(viewerScript, `${bridgeAssets}\n  ${viewerScript}`);
}

function getTarget(pathname) {
  if (pathname === "/favicon.ico") return null;
  if (pathname === "/bridge.css") return bridgeCssPath;
  if (
    pathname.startsWith("/viewer/") ||
    pathname.startsWith("/build/") ||
    pathname.startsWith("/cmaps/") ||
    pathname.startsWith("/standard_fonts/") ||
    pathname.startsWith("/wasm/") ||
    pathname.startsWith("/images/") ||
    pathname.startsWith("/locale/")
  ) {
    const buildResource = pathname.startsWith("/build/");
    const resourceRoot = buildResource ? vendorRoot : vendorWeb;
    const relativePath = buildResource
      ? pathname.slice(1)
      : pathname.startsWith("/viewer/")
        ? pathname.slice("/viewer/".length)
        : pathname.slice(1);
    const target = path.resolve(resourceRoot, relativePath);
    return target.startsWith(`${resourceRoot}${path.sep}`) ? target : null;
  }
  return null;
}

async function localPointInHost(viewer, page, selector, fraction = [0.5, 0.5]) {
  const [frameElement, local] = await Promise.all([
    viewer.frameElement(),
    viewer.evaluate((selector, ratios) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Input target is missing: ${selector}`);
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + rect.width * ratios[0],
        y: rect.top + rect.height * ratios[1],
      };
    }, selector, fraction),
  ]);
  const frameBounds = await frameElement.boundingBox();
  assert.ok(frameBounds, "Viewer iframe must be visible to input dispatch");
  return { x: frameBounds.x + local.x, y: frameBounds.y + local.y };
}

async function visiblePointInHost(viewer, page, selector, fraction = [0.5, 0.5]) {
  const [frameElement, local] = await Promise.all([
    viewer.frameElement(),
    viewer.evaluate((selector, ratios) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Input target is missing: ${selector}`);
      const clip = document.getElementById("viewerContainer")?.getBoundingClientRect();
      if (!clip) throw new Error("The PDF viewer scroll viewport is missing");
      const rect = element.getBoundingClientRect();
      const visibleRect = {
        left: Math.max(rect.left, clip.left, 0),
        top: Math.max(rect.top, clip.top, 0),
        right: Math.min(rect.right, clip.right, window.innerWidth),
        bottom: Math.min(rect.bottom, clip.bottom, window.innerHeight),
      };
      visibleRect.width = visibleRect.right - visibleRect.left;
      visibleRect.height = visibleRect.bottom - visibleRect.top;
      if (visibleRect.width <= 0 || visibleRect.height <= 0) {
        throw new Error(`Input target has no visible viewport intersection: ${selector}`);
      }
      const x = visibleRect.left + visibleRect.width * ratios[0];
      const y = visibleRect.top + visibleRect.height * ratios[1];
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        targetRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        visibleRect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        hit: {
          tag: hit?.tagName || null,
          id: hit?.id || null,
          className: typeof hit?.className === "string" ? hit.className : null,
          insideTarget: !!hit?.closest?.(selector),
          pageNumber: hit?.closest?.(".page")?.dataset.pageNumber || null,
        },
      };
    }, selector, fraction),
  ]);
  const frameBounds = await frameElement.boundingBox();
  assert.ok(frameBounds, "Viewer iframe must be visible to input dispatch");
  const hostPoint = { x: frameBounds.x + local.x, y: frameBounds.y + local.y };
  assert.ok(hostPoint.x >= 0 && hostPoint.x < page.viewport().width &&
    hostPoint.y >= 0 && hostPoint.y < page.viewport().height,
  "Input point must fall inside the host viewport");
  return {
    ...hostPoint,
    local,
    frameBounds,
  };
}

async function dispatchTouch(cdp, type, point = null, id = 1) {
  const touchPoints = point
    ? [{ x: point.x, y: point.y, id, radiusX: 1, radiusY: 1, force: 1 }]
    : [];
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
}

async function waitMs(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function beginFastTouchDrag(cdp, viewer, point, distance, id, report) {
  const eventOffset = await viewer.evaluate(() =>
    window.__ipadPointerEvents?.length || 0,
  );
  const baseTimestamp = await viewer.evaluate(() =>
    (performance.timeOrigin + performance.now()) / 1000,
  );
  const profileGestureId = process.env.PDF_READER_IPAD_CPU_PROFILE_ID;
  const profileEnabled = process.env.PDF_READER_IPAD_CPU_PROFILE === "1" &&
    (!profileGestureId || Number(profileGestureId) === id);
  let profileStarted = false;
  let cpuProfile = null;
  if (profileEnabled) {
    try {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
      await cdp.send("Profiler.start");
      profileStarted = true;
    } catch (error) {
      cpuProfile = { state: "start-failed", message: error?.message || String(error) };
    }
  }
  const plannedOffsetsMs = [0, 22, 44, 65];
  const dispatchTimings = [];
  const dispatchPromises = [];
  const sendAt = (type, pointAtTime, offsetMs) => {
    const touchPoints = pointAtTime
      ? [{
        x: pointAtTime.x,
        y: pointAtTime.y,
        id,
        radiusX: 1,
        radiusY: 1,
        force: 1,
      }]
      : [];
    const startedAt = performance.now();
    const dispatchPromise = cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints,
      timestamp: baseTimestamp + offsetMs / 1000,
    }).then(() => {
      dispatchTimings.push({
        type,
        offsetMs,
        startedAt,
        completedAt: performance.now(),
      });
    });
    dispatchPromises.push(dispatchPromise);
  };

  sendAt("touchStart", point, plannedOffsetsMs[0]);
  for (let step = 1; step <= 2; step += 1) {
    await waitMs(plannedOffsetsMs[step] - plannedOffsetsMs[step - 1]);
    sendAt("touchMove", {
      x: point.x,
      y: point.y - distance * step / 2,
    }, plannedOffsetsMs[step]);
  }
  await waitMs(plannedOffsetsMs.at(-1) - plannedOffsetsMs.at(-2));
  sendAt("touchEnd", null, plannedOffsetsMs.at(-1));
  await Promise.all(dispatchPromises);

  // CDP's touchEnd acknowledgement may arrive before Chromium dispatches its
  // DOM touchend and corresponding native scroll update. Wait for the physical
  // contact endpoint before sampling; preserve its original browser timestamp.
  await viewer.waitForFunction(({ offset, touchId }) =>
    (window.__ipadPointerEvents || []).slice(offset).some((event) =>
      event.sourceType === "touch" && event.touchId === touchId &&
      ["touchend", "touchcancel"].includes(event.type)),
  { timeout: 2_000 }, { offset: eventOffset, touchId: id });
  const timing = await touchReleaseTiming(viewer, eventOffset);
  if (profileStarted) {
    try {
      const { profile } = await cdp.send("Profiler.stop");
      const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
      const samplesByFrame = new Map();
      for (let index = 0; index < profile.samples.length; index += 1) {
        const frame = frames.get(profile.samples[index]);
        if (!frame) continue;
        const key = `${frame.url}:${frame.lineNumber}:${frame.functionName}`;
        const row = samplesByFrame.get(key) || {
          functionName: frame.functionName || "(anonymous)",
          url: frame.url || "",
          lineNumber: frame.lineNumber,
          samples: 0,
          sampleMs: 0,
        };
        row.samples += 1;
        row.sampleMs += (profile.timeDeltas[index] || 0) / 1000;
        samplesByFrame.set(key, row);
      }
      cpuProfile = {
        state: "captured",
        durationMs: (profile.endTime - profile.startTime) / 1000,
        sampleCount: profile.samples.length,
        topFrames: [...samplesByFrame.values()]
          .sort((left, right) => right.sampleMs - left.sampleMs)
          .slice(0, 30),
      };
      await cdp.send("Profiler.disable");
    } catch (error) {
      cpuProfile = { state: "stop-failed", message: error?.message || String(error) };
    }
  }
  const evidence = {
    pointerId: id,
    distance,
    baseTimestamp,
    plannedOffsetsMs,
    dispatchTimings,
    observed: timing.sequence,
    observedMoveSpeedPxPerMs: timing.observedMoveSpeedPxPerMs,
    ...(cpuProfile ? { cpuProfile } : {}),
  };
  report.trustedTimedFingerGestures ||= [];
  report.trustedTimedFingerGestures.push(evidence);

  assert.ok(timing.sequence.length >= 3 && timing.sequence.length <= plannedOffsetsMs.length,
    `Fast finger gesture ${id} must deliver down, movement, and release events`);
  assert.equal(timing.sequence[0].type, "pointerdown");
  assert.equal(timing.sequence.at(-1).type, "pointerup");
  const moves = timing.sequence.slice(1, -1);
  assert.ok(moves.length >= 1 && moves.every((event) => event.type === "pointermove"),
    `Fast finger gesture ${id} must deliver trusted movement events in order`);
  for (let index = 0; index < timing.sequence.length; index += 1) {
    const event = timing.sequence[index];
    assert.equal(event.trusted, true,
      `Fast finger gesture ${id} must remain trusted browser input`);
    assert.equal(event.targetInViewer, true,
      `Fast finger gesture ${id} must reach the PDF viewer`);
    assert.ok(event.timeStamp <= event.observedAt,
      `Fast finger gesture ${id} must not use future timestamps`);
    assert.ok(event.observedAt - event.timeStamp <= 80,
      `Fast finger gesture ${id} must not arrive over 80 ms after its timestamp`);
    const relativeTime = event.timeStamp - timing.sequence[0].timeStamp;
    const plannedOffset = index === 0
      ? 0
      : index === timing.sequence.length - 1
        ? plannedOffsetsMs.at(-1)
        : plannedOffsetsMs.slice(1, -1).find((offset) =>
          Math.abs(relativeTime - offset) <= 1,
        );
    assert.ok(Number.isFinite(plannedOffset) && Math.abs(relativeTime - plannedOffset) <= 1,
      `Fast finger gesture ${id} observed event time must match the 22 ms sample schedule`);
    if (index > 0) {
      const previous = timing.sequence[index - 1];
      assert.ok(event.timeStamp > previous.timeStamp,
        `Fast finger gesture ${id} event timestamps must increase`);
      assert.ok(event.timeStamp - previous.timeStamp <= 80,
        `Fast finger gesture ${id} must not contain a timestamp pause over 80 ms`);
      assert.ok(event.observedAt >= previous.observedAt);
      assert.ok(event.observedAt - previous.observedAt <= 80,
        `Fast finger gesture ${id} must not contain an observed pause over 80 ms`);
    }
  }
  const lastMove = moves.at(-1);
  assert.ok(Math.abs(
    lastMove.timeStamp - timing.sequence[0].timeStamp - plannedOffsetsMs.at(-2),
  ) <= 1,
  `Fast finger gesture ${id} must reach its endpoint at the scheduled final move`);
  assert.ok(Math.abs(lastMove.clientY -
    (timing.sequence[0].clientY - distance)) <= 1,
  `Fast finger gesture ${id} must deliver its full trusted touch distance`);
  assert.ok(Math.abs(
    timing.sequence.at(-1).timeStamp - lastMove.timeStamp -
      (plannedOffsetsMs.at(-1) - plannedOffsetsMs.at(-2)),
  ) <= 1,
  `Fast finger gesture ${id} must release at the scheduled final interval`);
  assert.ok(timing.observedMoveSpeedPxPerMs >= 1,
    `Fast finger gesture ${id} must have a clearly moving touch segment`);
  return timing;
}

async function touchReleaseTiming(viewer, eventOffset) {
  return viewer.evaluate((offset) => {
    const events = window.__ipadPointerEvents?.slice(offset) || [];
    const touchSamples = events.filter((event) =>
      event.sourceType === "touch" &&
      ["touchstart", "touchmove", "touchend", "touchcancel"].includes(event.type)
    );
    const touchSequence = touchSamples.map((event) => ({
      ...event,
      sourceType: "touch-event",
      type: ({
        touchstart: "pointerdown",
        touchmove: "pointermove",
        touchend: "pointerup",
        touchcancel: "pointercancel",
      })[event.type],
      pointerId: event.touchId,
      pointerType: "touch",
    }));
    const pointerEvents = events.filter((event) =>
      event.sourceType === "pointer" && event.pointerType === "touch" &&
      ["pointerdown", "pointermove", "pointerup", "pointercancel"].includes(event.type)
    );
    const firstDown = pointerEvents.find((event) => event.type === "pointerdown");
    const pointerId = firstDown?.pointerId;
    const pointerSequence = pointerId === undefined
      ? pointerEvents
      : pointerEvents.filter((event) => event.pointerId === pointerId);
    // Once Chromium takes ownership of a native scroll, Pointer Events correctly
    // emit pointercancel. Touch Events remain the authoritative physical-contact
    // timeline, so measure the injected gesture there instead of fabricating an
    // expected pointerup that the browser is required to cancel.
    const sequence = touchSequence.length ? touchSequence : pointerSequence;
    const release = [...sequence].reverse().find((event) => event.type === "pointerup");
    const lastMove = [...sequence].reverse().find((event) => event.type === "pointermove");
    const recentMoves = sequence.filter((event) => event.type === "pointermove").slice(-3);
    const movementStart = sequence.find((event) => event.type === "pointerdown");
    const observedMoveSpeedPxPerMs = movementStart && lastMove &&
        lastMove.timeStamp > movementStart.timeStamp
      ? Math.hypot(
        lastMove.clientX - movementStart.clientX,
        lastMove.clientY - movementStart.clientY,
      ) / (lastMove.timeStamp - movementStart.timeStamp)
      : null;
    return {
      browserPointerId: pointerId ?? null,
      sequence,
      pointerSequence,
      lastMoveTime: lastMove?.timeStamp ?? null,
      releaseTime: release?.timeStamp ?? null,
      gapMs: lastMove && release
        ? release.timeStamp - lastMove.timeStamp
        : null,
      lastMovePoint: lastMove
        ? { x: lastMove.clientX, y: lastMove.clientY }
        : null,
      releasePoint: release
        ? { x: release.clientX, y: release.clientY }
        : null,
      recentMoves: recentMoves.map((event) => ({
        timeStamp: event.timeStamp,
        point: { x: event.clientX, y: event.clientY },
      })),
      observedMoveSpeedPxPerMs,
    };
  }, eventOffset);
}

async function dispatchSimulatedPen(cdp, type, point, buttons) {
  await cdp.send("Input.dispatchMouseEvent", {
    type,
    x: point.x,
    y: point.y,
    button: "left",
    buttons,
    pointerType: "pen",
    force: buttons ? 0.5 : 0,
    clickCount: type === "mousePressed" ? 1 : 0,
  });
}

async function tapSimulatedPen(cdp, point) {
  await dispatchSimulatedPen(cdp, "mousePressed", point, 1);
  await dispatchSimulatedPen(cdp, "mouseReleased", point, 0);
}

test(
  "iPad policy routes finger scrolling separately from PDF.js editor and mouse input",
  {
    timeout: 120_000,
    skip: browserPath ? false : "Chrome or Edge is required for trusted pointer input",
  },
  async (t) => {
    const vendorSource = await readFile(path.join(vendorWeb, "viewer.html"), "utf8");
    const html = viewerHtml(vendorSource);
    const bridgeSource = await readBridgeRuntimeSource(bridgeJsPath);
    const instrumentedBridgeSource = bridgeSource.replace(
      "  if (document.documentElement?.dataset) {",
      "  window.__ipadPointerPolicyTestState = state;\n  if (document.documentElement?.dataset) {",
    );
    assert.notEqual(instrumentedBridgeSource, bridgeSource,
      "The iPad harness should expose bridge state only for lifecycle diagnostics");
    const missingRequests = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/favicon.ico") {
        response.writeHead(204).end();
        return;
      }
      if (url.pathname === "/fixtures/ipad-pointer-policy.pdf") {
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": pointerPolicyPdfFixture.byteLength,
          "x-content-type-options": "nosniff",
        });
        response.end(pointerPolicyPdfFixture);
        return;
      }
      if (url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(hostHtml());
        return;
      }
      if (url.pathname === "/viewer/viewer.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (url.pathname === "/bridge.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end(instrumentedBridgeSource);
        return;
      }
      const target = getTarget(url.pathname);
      if (!target) {
        missingRequests.push(url.pathname);
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

    let browser;
    let page;
    let viewer;
    let penPage;
    let penViewer;
    let primaryError;
    let cleanupReport;
    const report = {
      schema: 1,
      policySource: "bridge script data-ios-input-policy flag",
      penSimulation: "CDP Input.dispatchMouseEvent pointerType=pen; not hardware Pencil",
      trustedTouch: null,
      mouseAfterTouch: null,
      pageErrors: [],
    };
    const artifactPath = path.join(artifactsPath, `ipad-pointer-policy-${Date.now()}-${process.pid}.json`);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      browser = await launchTestBrowser(puppeteer, {
        executablePath: browserPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      }, { testName: "ipad-pointer-policy", artifactsDir: artifactsPath });
      page = await browser.newPage();
      await page.setViewport({
        width: 1180,
        height: 920,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      });
      await page.evaluateOnNewDocument(() => {
        window.__ipadPointerEvents = [];
        window.__ipadEventRows = new WeakMap();
        window.__ipadCompatMouseReachedDocument = [];
        window.__ipadLongTasks = [];
        if (typeof PerformanceObserver === "function") {
          try {
            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                window.__ipadLongTasks.push({
                  startTime: entry.startTime,
                  duration: entry.duration,
                  name: entry.name,
                });
              }
            });
            observer.observe({ type: "longtask", buffered: true });
          } catch {
            // The browser may not expose Long Tasks in this environment.
          }
        }
        for (const type of [
          "pointerdown", "pointermove", "pointerup", "pointercancel",
          "touchstart", "touchmove", "touchend", "touchcancel",
          "mousedown", "mouseup", "click", "dblclick", "wheel",
        ]) {
          window.addEventListener(type, (event) => {
            const target = event.target instanceof Element ? event.target : null;
            const touch = event.changedTouches?.[0] || event.touches?.[0] || null;
            const row = {
              type,
              sourceType: type.startsWith("touch") ? "touch" : "pointer",
              pointerType: event.pointerType || null,
              pointerId: Number.isFinite(event.pointerId) ? event.pointerId : null,
              touchId: Number.isFinite(touch?.identifier) ? touch.identifier : null,
              trusted: event.isTrusted === true,
              isPrimary: typeof event.isPrimary === "boolean" ? event.isPrimary : null,
              button: Number.isFinite(event.button) ? event.button : null,
              buttons: Number.isFinite(event.buttons) ? event.buttons : null,
              touchCount: Number.isFinite(event.touches?.length) ? event.touches.length : null,
              touchIdentifiers: event.touches
                ? Array.from(event.touches, (item) => item.identifier)
                : null,
              detail: Number.isFinite(event.detail) ? event.detail : null,
              timeStamp: Number.isFinite(event.timeStamp) ? event.timeStamp : null,
              observedAt: null,
              clientX: Number.isFinite(touch?.clientX) ? touch.clientX
                : Number.isFinite(event.clientX) ? event.clientX : null,
              clientY: Number.isFinite(touch?.clientY) ? touch.clientY
                : Number.isFinite(event.clientY) ? event.clientY : null,
              targetInViewer: !!target?.closest?.("#viewerContainer"),
              targetPage: target?.closest?.(".page")?.dataset.pageNumber || null,
              targetId: target?.id || null,
              targetToolButton: target?.closest?.("#editorSquareButton")?.id || null,
            };
            window.__ipadPointerEvents.push(row);
            window.__ipadEventRows.set(event, row);
            queueMicrotask(() => {
              row.observedAt = performance.now();
              row.defaultPreventedAfterDispatch = event.defaultPrevented;
              row.pointerCaptureAfterDispatch = Number.isFinite(event.pointerId) &&
                target?.hasPointerCapture?.(event.pointerId) === true;
            });
          }, true);
        }
        for (const type of ["mousedown", "mousemove", "mouseup"]) {
          document.addEventListener(type, (event) => {
            window.__ipadCompatMouseReachedDocument.push({
              type,
              targetInViewer: event.target instanceof Element &&
                !!event.target.closest?.("#viewerContainer"),
              defaultPrevented: event.defaultPrevented,
            });
          });
        }
      });
      page.on("pageerror", (error) => report.pageErrors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.address().port}/`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(() => window.__host?.opened?.length === 1, {
        timeout: 35_000,
      });
      viewer = page.frames().find((frame) => frame.name() === "pdf-reader");
      assert.ok(viewer, "Expected the PDF.js viewer iframe");
      await viewer.waitForFunction(() =>
        !!window.PDFViewerApplication?.pdfDocument &&
        !!document.querySelector('.page[data-page-number="1"] .textLayer span') &&
        document.querySelector('.page[data-page-number="1"]')
          ?.getBoundingClientRect().width > 0,
      { timeout: 25_000 });
      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
        document.addEventListener("click", (event) => {
          if (event.target instanceof Element && event.target.closest(".page")) {
            window.__ipadPageClicksReachedDocument.push({
              pointerType: event.pointerType || null,
              detail: event.detail,
            });
          }
        }, true);
      });

      const initialPolicy = await viewer.evaluate(() => ({
        flag: document.documentElement.dataset.pdfReaderIosInputPolicy || null,
        touchAction: getComputedStyle(document.getElementById("viewerContainer")).touchAction,
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
      }));
      assert.deepEqual(initialPolicy, {
        flag: "true",
        touchAction: "pan-x pan-y",
        mode: 0,
      });
      const cdp = await page.target().createCDPSession();
      const initialSquareTouchPoint = await localPointInHost(
        viewer, page, "#editorSquareButton",
      );
      const initialSquareTouchOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await dispatchTouch(cdp, "touchStart", initialSquareTouchPoint, 32);
      await waitMs(50);
      await dispatchTouch(cdp, "touchEnd");
      await viewer.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(resolve),
      ));
      const initialSquareTouchEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], initialSquareTouchOffset,
      );
      report.initialSquareTouchTap = initialSquareTouchEvents;
      assert.ok(initialSquareTouchEvents.some((event) =>
        event.type === "click" && event.trusted &&
        event.targetToolButton === "editorSquareButton",
      ), "A trusted touchscreen tap in the clean viewer must activate Square");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 3_000 },
      );
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 0,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
        { timeout: 3_000 },
      );
      const penNavigationStart = await viewer.evaluate(() =>
        PDFViewerApplication.pdfViewer.currentPageNumber,
      );
      const nextPagePoint = await localPointInHost(viewer, page, "#next");
      await tapSimulatedPen(cdp, nextPagePoint);
      await viewer.waitForFunction(
        (pageNumber) => PDFViewerApplication.pdfViewer.currentPageNumber > pageNumber,
        { timeout: 8_000 },
        penNavigationStart,
      );
      const penNavigationAfterNext = await viewer.evaluate(() =>
        PDFViewerApplication.pdfViewer.currentPageNumber,
      );
      const previousPagePoint = await localPointInHost(viewer, page, "#previous");
      await tapSimulatedPen(cdp, previousPagePoint);
      await viewer.waitForFunction(
        (pageNumber) => PDFViewerApplication.pdfViewer.currentPageNumber < pageNumber,
        { timeout: 8_000 },
        penNavigationAfterNext,
      );
      report.simulatedPenNavigation = {
        simulationOnly: true,
        pageBefore: penNavigationStart,
        pageAfterNext: penNavigationAfterNext,
        pageAfterPrevious: await viewer.evaluate(() =>
          PDFViewerApplication.pdfViewer.currentPageNumber,
        ),
      };
      const inputSnapshot = async (frame = viewer) => frame.evaluate(() => {
        const app = window.PDFViewerApplication;
        const storage = app.pdfDocument.annotationStorage;
        const manager = app.pdfViewer._layerProperties.annotationEditorUIManager;
        const modifiedIds = Array.from(
          { length: app.pdfDocument.numPages },
          (_, pageIndex) => [...manager.getEditors(pageIndex)],
        ).flat().filter((editor) => editor.serialize())
          .map((editor) => String(editor.id)).sort();
        const drawingPaths = [...document.querySelectorAll(
          '.page[data-page-number="1"] .canvasWrapper svg path[d]',
        )].map((path) => path.getAttribute("d"))
          .filter((data) => data && data.trim().length > 0);
        return {
          scrollTop: document.getElementById("viewerContainer").scrollTop,
          scrollLeft: document.getElementById("viewerContainer").scrollLeft,
          maxScrollTop: document.getElementById("viewerContainer").scrollHeight -
            document.getElementById("viewerContainer").clientHeight,
          storageSize: storage.size ?? null,
          serializedSize: storage.serializable?.map?.size ?? null,
          modifiedIds,
          editorElements: document.querySelectorAll(
            ".annotationEditorLayer .inkEditor",
          ).length,
          drawingPathCount: drawingPaths.length,
          drawingPaths,
          highlightElements: document.querySelectorAll(
            ".annotationEditorLayer .highlightEditor",
          ).length,
        };
      });

      // CDP emits a trusted Chromium pen-typed pointer sequence. This is a
      // routing simulation and is explicitly not evidence from an Apple Pencil.
      const penStart = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"] .textLayer span',
        [0.5, 0.5],
      );
      report.penStart = penStart;
      report.geometry = await viewer.evaluate(() => ({
        viewport: {
          width: innerWidth,
          height: innerHeight,
        },
        viewer: (() => {
          const rect = document.getElementById("viewerContainer").getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        })(),
        page: (() => {
          const rect = document.querySelector('.page[data-page-number="1"]').getBoundingClientRect();
          return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        })(),
      }));
      await viewer.evaluate(() => window.getSelection()?.removeAllRanges());
      const beforePenPan = await inputSnapshot();
      await viewer.evaluate(() => {
        window.__ipadCompatMouseReachedDocument = [];
      });
      const penPanEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await dispatchSimulatedPen(cdp, "mousePressed", penStart, 1);
      await dispatchSimulatedPen(cdp, "mouseMoved", {
        x: penStart.x,
        y: penStart.y - 130,
      }, 1);
      await dispatchSimulatedPen(cdp, "mouseReleased", {
        x: penStart.x,
        y: penStart.y - 130,
      }, 0);
      const afterPenPan = await inputSnapshot();
      assert.equal(afterPenPan.storageSize, beforePenPan.storageSize);
      assert.equal(afterPenPan.serializedSize, beforePenPan.serializedSize);
      assert.deepEqual(afterPenPan.modifiedIds, beforePenPan.modifiedIds);
      const penPanEvents = await viewer.evaluate((offset) => ({
        events: window.__ipadPointerEvents?.slice(offset) || [],
        compatibilityMouseAtDocument: window.__ipadCompatMouseReachedDocument || [],
        selection: window.getSelection()?.toString() || "",
        pageClicks: window.__ipadPageClicksReachedDocument || [],
      }), penPanEventOffset);
      assert.equal(penPanEvents.selection, "",
        "A mode-NONE pen pan must not select PDF text");
      assert.deepEqual(penPanEvents.compatibilityMouseAtDocument, [],
        `A mode-NONE pen pan must stop compatibility mouse events before the PDF document: ${JSON.stringify(penPanEvents)}`);
      assert.deepEqual(penPanEvents.pageClicks, [],
        "A completed pen pan must not trigger a PDF page click");
      const penObservation = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.filter((event) => event.pointerType === "pen") || [],
      );
      assert.ok(penObservation.some((event) => event.type === "pointerdown"),
        "Chromium should deliver the explicitly simulated pen pointerType");
      const penDispatch = penPanEvents.events.filter((event) =>
        event.pointerType === "pen" && ["pointerdown", "pointermove", "pointerup"].includes(event.type),
      );
      assert.ok(penDispatch.some((event) => event.type === "pointerup"),
        "The simulated pen sequence must reach pointerup");
      assert.ok(penDispatch.every((event) => event.defaultPreventedAfterDispatch === false),
        "Read-mode pen events remain browser-owned; bridge listeners must not cancel them");
      assert.ok(penDispatch.every((event) => event.pointerCaptureAfterDispatch !== true),
        "Read-mode pen events must not be captured by annotation editors");
      report.penPanSimulation = {
        nativeScrollEmulated: false,
        beforeScrollTop: beforePenPan.scrollTop,
        afterScrollTop: afterPenPan.scrollTop,
        reason: "CDP mouse pointerType=pen verifies routing only; native iPadOS Pencil pan is covered on device, while trusted touch scrolling is tested separately.",
      };

      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
      });
      const penTapPoint = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"] .textLayer span',
        [0.5, 0.5],
      );
      await tapSimulatedPen(cdp, penTapPoint);
      await viewer.waitForFunction(() =>
        window.__ipadPageClicksReachedDocument?.length === 1,
        { timeout: 3_000 },
      );
      report.simulatedPenModeNoneTapReachedDocument = true;
      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
      });

      await viewer.click("#editorHighlightButton");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 9,
        { timeout: 8_000 },
      );
      const fingerSelectionSuppressionPoint = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"] .textLayer span',
        [0.5, 0.5],
      );
      await viewer.evaluate(() => window.getSelection()?.removeAllRanges());
      await dispatchTouch(cdp, "touchStart", fingerSelectionSuppressionPoint, 109);
      const fingerSelectionGuardDuringContact = await viewer.evaluate(() => {
        const span = document.querySelector(
          '.page[data-page-number="1"] .textLayer span',
        );
        const selectStart = new Event("selectstart", {
          bubbles: true,
          cancelable: true,
        });
        span?.dispatchEvent(selectStart);
        const callout = new Event("contextmenu", {
          bubbles: true,
          cancelable: true,
        });
        span?.dispatchEvent(callout);
        const style = span ? getComputedStyle(span) : null;
        const unrelatedSpan = [...document.querySelectorAll(
          '.page[data-page-number="1"] .textLayer span',
        )].find((candidate) => candidate !== span);
        return {
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          guardClass: document.documentElement.classList.contains(
            "pdfReaderFingerTextSelectionSuppressed",
          ),
          userSelect: style?.userSelect || null,
          suppressionTargetClass: span?.classList.contains(
            "pdfReaderFingerTextSelectionSuppressedTarget",
          ) || false,
          unrelatedSpanUserSelect: unrelatedSpan
            ? getComputedStyle(unrelatedSpan).userSelect
            : null,
          webkitTouchCalloutSupported: CSS.supports(
            "-webkit-touch-callout",
            "none",
          ),
          webkitTouchCallout: style?.getPropertyValue(
            "-webkit-touch-callout",
          ) || null,
          selectStartPrevented: selectStart.defaultPrevented,
          contextMenuPrevented: callout.defaultPrevented,
          selectedText: document.getSelection()?.toString() || "",
        };
      });
      const {
        webkitTouchCalloutSupported,
        webkitTouchCallout,
        ...observableFingerSelectionGuard
      } = fingerSelectionGuardDuringContact;
      assert.deepEqual(observableFingerSelectionGuard, {
        mode: 9,
        guardClass: true,
        userSelect: "none",
        suppressionTargetClass: false,
        unrelatedSpanUserSelect: "none",
        selectStartPrevented: true,
        contextMenuPrevented: true,
        selectedText: "",
      }, "An active annotation tool must suppress finger text selection and WebKit callouts");
      if (webkitTouchCalloutSupported) {
        assert.equal(webkitTouchCallout, "none");
      }
      assert.match(
        await readFile(bridgeCssPath, "utf8"),
        /-webkit-touch-callout:\s*none\s*!important;/,
        "The Safari callout rule must remain present even when Chromium cannot report it",
      );
      await waitMs(800);
      const fingerSelectionAfterLongPress = await viewer.evaluate(() =>
        document.getSelection()?.toString() || "",
      );
      assert.equal(fingerSelectionAfterLongPress, "",
        "A held finger must not select OCR text while an annotation tool is active");
      await dispatchTouch(cdp, "touchEnd");
      const fingerSelectionGuardAfterRelease = await viewer.evaluate(() => {
        const span = document.querySelector(
          '.page[data-page-number="1"] .textLayer span',
        );
        const selectStart = new Event("selectstart", {
          bubbles: true,
          cancelable: true,
        });
        span?.dispatchEvent(selectStart);
        return {
          guardClass: document.documentElement.classList.contains(
            "pdfReaderFingerTextSelectionSuppressed",
          ),
          selectStartPrevented: selectStart.defaultPrevented,
          selectedText: document.getSelection()?.toString() || "",
        };
      });
      assert.deepEqual(fingerSelectionGuardAfterRelease, {
        guardClass: true,
        selectStartPrevented: true,
        selectedText: "",
      }, "Finger selection ownership must cover delayed iOS selection after release");
      report.fingerTextSelectionSuppression = {
        input: "trusted CDP touch contact and release while Highlight is active",
        simulationOnly: true,
        duringContact: fingerSelectionGuardDuringContact,
        afterRelease: fingerSelectionGuardAfterRelease,
        physicalIPadCalloutBehaviorUnverified: true,
      };
      const highlightTarget = await viewer.evaluate(() => {
        const viewerRect = document.getElementById("viewerContainer").getBoundingClientRect();
        const spans = [...document.querySelectorAll(
          '.page[data-page-number="1"] .textLayer span',
        )].map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent || "",
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
        }).filter((span) => span.text.trim() && span.right - span.left > 4 &&
          span.bottom - span.top > 4 && span.top >= viewerRect.top &&
          span.bottom <= viewerRect.bottom);
        spans.sort((left, right) => left.top - right.top || left.left - right.left);
        const lines = [];
        for (const span of spans) {
          let line = lines.find((candidate) => Math.abs(candidate.top - span.top) < 2);
          if (!line) {
            line = { top: span.top, spans: [] };
            lines.push(line);
          }
          line.spans.push(span);
        }
        const lineIndex = lines.findIndex((candidate) =>
          candidate.spans.length >= 2 &&
          candidate.spans.at(-1).right - candidate.spans[0].left >= 70,
        );
        const line = lines[lineIndex];
        const secondLine = lines.slice(lineIndex + 1).find((candidate) =>
          candidate.spans.length > 0 &&
          candidate.spans.at(-1).right - candidate.spans[0].left >= 20,
        );
        if (!line || !secondLine) {
          throw new Error("Could not find two adjacent visible OCR text lines for pen selection: " +
            JSON.stringify(lines.map((candidate) => ({
              top: candidate.top,
              spanCount: candidate.spans.length,
              text: candidate.spans.map((span) => span.text).join(" | "),
              width: candidate.spans.at(-1).right - candidate.spans[0].left,
            }))));
        }
        const first = line.spans[0];
        const firstLineLast = line.spans.at(-1);
        const secondLineLast = secondLine.spans.at(-1);
        const firstLineY = (first.top + first.bottom) / 2;
        const secondLineY = (secondLine.spans[0].top + secondLine.spans[0].bottom) / 2;
        return {
          start: {
            x: first.left + Math.min(2, (first.right - first.left) / 4),
            y: firstLineY,
          },
          firstLineEnd: {
            x: firstLineLast.right - Math.min(2, (firstLineLast.right - firstLineLast.left) / 4),
            y: firstLineY,
          },
          interlineGap: {
            x: firstLineLast.right - Math.min(2, (firstLineLast.right - firstLineLast.left) / 4),
            y: (firstLineY + secondLineY) / 2,
          },
          end: {
            x: secondLineLast.right - Math.min(2, (secondLineLast.right - secondLineLast.left) / 4),
            y: secondLineY,
          },
          expectedLineText: [line, secondLine]
            .flatMap((candidate) => candidate.spans)
            .map((span) => span.text)
            .join(""),
        };
      });
      const highlightFrameBounds = await page.$eval("#pdf-reader", (element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y };
      });
      const highlightPenStart = {
        x: highlightFrameBounds.x + highlightTarget.start.x,
        y: highlightFrameBounds.y + highlightTarget.start.y,
      };
      const highlightPenEnd = {
        x: highlightFrameBounds.x + highlightTarget.end.x,
        y: highlightFrameBounds.y + highlightTarget.end.y,
      };
      await viewer.evaluate(() => window.getSelection()?.removeAllRanges());
      const beforePenTextHighlight = await inputSnapshot();
      await viewer.evaluate(() => {
        window.__penTextSelectionTrace = [];
        window.__penTextHighlightCalls = [];
        window.__penCompatibilityMouseEvents = [];
        document.addEventListener("selectionchange", () => {
          const selection = document.getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
          const lineTops = [...new Set(
            [...(range?.getClientRects() || [])].map((rect) => Math.round(rect.top)),
          )];
          if (selection && !selection.isCollapsed && selection.toString()) {
            const textLayer = document.querySelector(
              '.page[data-page-number="1"] .textLayer',
            );
            window.__penTextSelectionTrace.push({
              text: selection.toString(),
              anchorOffset: selection.anchorOffset,
              focusOffset: selection.focusOffset,
              anchorInTextLayer: !!textLayer?.contains(selection.anchorNode),
              focusInTextLayer: !!textLayer?.contains(selection.focusNode),
              lineTops,
            });
          }
        }, true);
        for (const type of ["mousedown", "mousemove", "mouseup"]) {
          document.addEventListener(type, () => {
            window.__penCompatibilityMouseEvents.push(type);
          });
        }
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        const highlightSelection = manager.highlightSelection.bind(manager);
        manager.highlightSelection = (method) => {
          const selection = document.getSelection();
          const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
          const lineTops = [...new Set(
            [...(range?.getClientRects() || [])].map((rect) => Math.round(rect.top)),
          )];
          const call = {
            method,
            collapsed: selection?.isCollapsed ?? true,
            text: selection?.toString() || "",
            rangeCount: selection?.rangeCount || 0,
            lineTops,
            stack: new Error().stack || "",
          };
          window.__penTextHighlightCalls.push(call);
          // Observe and run PDF.js's normal native highlight path. This test
          // verifies that the bridge delivers the second-line pointerup caret
          // before the editor consumes the live Range.
          return highlightSelection(method);
        };
      });
      await dispatchSimulatedPen(cdp, "mousePressed", highlightPenStart, 1);
      assert.equal(await viewer.evaluate(() =>
        document.documentElement.classList.contains(
          "pdfReaderFingerTextSelectionSuppressed",
        ),
      ), false, "Pencil input must release finger selection suppression before selecting text");
      for (let step = 1; step <= 5; step += 1) {
        await dispatchSimulatedPen(cdp, "mouseMoved", {
          x: highlightFrameBounds.x + highlightTarget.start.x +
            (highlightTarget.firstLineEnd.x - highlightTarget.start.x) * step / 5,
          y: highlightFrameBounds.y + highlightTarget.firstLineEnd.y,
        }, 1);
      }
      await dispatchSimulatedPen(cdp, "mouseMoved", {
        x: highlightFrameBounds.x + highlightTarget.interlineGap.x,
        y: highlightFrameBounds.y + highlightTarget.interlineGap.y,
      }, 1);
      await dispatchSimulatedPen(cdp, "mouseReleased", highlightPenEnd, 0);
      await viewer.waitForFunction((previousCount) =>
        document.querySelectorAll(
          ".annotationEditorLayer .highlightEditor",
        ).length > previousCount,
      { timeout: 6_000 }, beforePenTextHighlight.highlightElements);
      const afterPenTextHighlight = await inputSnapshot();
      const penTextHighlightEvidence = await viewer.evaluate(() => {
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        const editors = [...manager.getEditors(0)].filter((editor) =>
          editor.div?.classList.contains("highlightEditor"),
        );
        const serialized = editors.map((editor) => editor.serialize()).filter(Boolean);
        return {
          selectionTrace: window.__penTextSelectionTrace || [],
          highlightCalls: window.__penTextHighlightCalls || [],
          compatibilityMouseEvents: window.__penCompatibilityMouseEvents || [],
          editors: editors.length,
          quadPointCounts: serialized.map((editor) => editor.quadPoints?.length || 0),
          selectionCollapsedAfter: document.getSelection()?.isCollapsed ?? true,
        };
      });
      const actualSelectionTrace = penTextHighlightEvidence.selectionTrace;
      assert.ok(actualSelectionTrace.some((entry) => entry.text.length > 0),
        "Trusted pen drag must create a live browser text selection");
      assert.ok(actualSelectionTrace.some((entry) =>
        Number.isInteger(entry.anchorOffset) && Number.isInteger(entry.focusOffset) &&
        entry.anchorInTextLayer && entry.focusInTextLayer,
      ), "Pen endpoints must come from caret hit tests inside the captured text layer");
      assert.deepEqual(penTextHighlightEvidence.compatibilityMouseEvents, [],
        "The owned text-selection gesture must suppress duplicate compatibility mouse events");
      assert.ok(penTextHighlightEvidence.highlightCalls.some((call) =>
        call.method === "main_toolbar" && !call.collapsed && call.text.length > 0 &&
        call.rangeCount > 0 && call.lineTops.length >= 2 &&
        !call.stack.includes("finishPenHighlightFallback"),
      ), `The native pointerup path must consume a live two-line selection: ${JSON.stringify(penTextHighlightEvidence.highlightCalls)}`);
      assert.ok(penTextHighlightEvidence.highlightCalls.some((call) =>
        call.method === "main_toolbar" &&
        !call.stack.includes("finishPenHighlightFallback"),
      ), `The normal PDF.js pointerup path must consume the live multiline Range: ${JSON.stringify(penTextHighlightEvidence.highlightCalls)}`);
      assert.ok(penTextHighlightEvidence.editors > 0,
        "Pen text selection must create a native PDF.js HighlightEditor");
      assert.ok(penTextHighlightEvidence.quadPointCounts.some((count) => count >= 16),
        `Native text highlight must serialize QuadPoints for at least two lines: ${JSON.stringify(penTextHighlightEvidence.quadPointCounts)}`);
      assert.equal(penTextHighlightEvidence.selectionCollapsedAfter, true,
        "Native text highlight should consume and clear the browser selection");
      assert.ok(afterPenTextHighlight.serializedSize > beforePenTextHighlight.serializedSize,
        "Native text highlight must update PDF annotation storage");
      assert.ok(afterPenTextHighlight.storageSize > beforePenTextHighlight.storageSize,
        "Native text highlight must add an annotation to PDF storage");
      const savedMultilineHighlight = await viewer.evaluate(async () => {
        const data = await PDFViewerApplication.pdfDocument.saveDocument();
        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
        try {
          const savedDocument = await loadingTask.promise;
          const page = await savedDocument.getPage(1);
          const annotations = await page.getAnnotations({ intent: "display" });
          return annotations
            .filter((annotation) => annotation.subtype === "Highlight")
            .map((annotation) => ({
              id: annotation.id,
              quadPoints: [...annotation.quadPoints],
              quadCount: annotation.quadPoints.length / 8,
            }));
        } finally {
          await loadingTask.destroy();
        }
      });
      assert.equal(savedMultilineHighlight.length, 1,
        "Saving and reopening the PDF must retain this single multiline Highlight annotation");
      assert.ok(savedMultilineHighlight[0].quadPoints.length >= 16,
        `The reopened Highlight must retain at least two line quads: ${JSON.stringify(savedMultilineHighlight)}`);
      report.penTextHighlightSelection = {
        input: "trusted Chromium pen-typed CDP drag over two OCR lines, with line two only at pointerup",
        simulationOnly: true,
        expectedLineText: highlightTarget.expectedLineText,
        selectedText: actualSelectionTrace.at(-1)?.text || "",
        selectedLineTops: actualSelectionTrace.at(-1)?.lineTops || [],
        caretEndpoints: actualSelectionTrace.map((entry) => ({
          anchorOffset: entry.anchorOffset,
          focusOffset: entry.focusOffset,
          anchorInTextLayer: entry.anchorInTextLayer,
          focusInTextLayer: entry.focusInTextLayer,
        })),
        compatibilityMouseEvents: penTextHighlightEvidence.compatibilityMouseEvents,
        nativeHighlightCalls: penTextHighlightEvidence.highlightCalls,
        nativeHighlightEditors: penTextHighlightEvidence.editors,
        quadPointCounts: penTextHighlightEvidence.quadPointCounts,
        annotationStorageSize: afterPenTextHighlight.serializedSize,
        savedAndReopenedHighlight: savedMultilineHighlight,
      };
      await viewer.evaluate(() => {
        window.__ipadPageClicksReachedDocument = [];
      });

      await viewer.click("#editorInkButton");
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 8_000 },
      );
      const beforeFingerPan = await inputSnapshot();
      const inkParamsState = () => viewer.evaluate(() => ({
        hidden: document.getElementById("editorInkParamsToolbar").classList.contains("hidden"),
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        selected: document.getElementById("editorInkButton").classList.contains("toggled"),
        expanded: document.getElementById("editorInkButton").getAttribute("aria-expanded"),
      }));
      assert.equal((await inkParamsState()).hidden, false);
      await viewer.click("#pageNumber");
      assert.deepEqual(await inkParamsState(), {
        hidden: true, mode: 15, selected: true, expanded: "false",
      }, "Mouse outside the parameter popup closes it without deselecting Ink");
      await viewer.click("#editorInkButton");
      await viewer.click("#editorInkButton");
      const popupPoint = await localPointInHost(viewer, page, "#editorInkParamsToolbar", [0.03, 0.04]);
      await dispatchTouch(cdp, "touchStart", popupPoint, 101);
      await dispatchTouch(cdp, "touchEnd");
      assert.equal((await inkParamsState()).hidden, false,
        "A finger contact inside tool parameters must leave them available");
      const outsidePopupPoint = await localPointInHost(viewer, page, "#viewerContainer", [0.9, 0.45]);
      await dispatchTouch(cdp, "touchStart", outsidePopupPoint, 102);
      await dispatchTouch(cdp, "touchEnd");
      assert.deepEqual(await inkParamsState(), {
        hidden: true, mode: 15, selected: true, expanded: "false",
      }, "Finger contact on the PDF closes parameters while retaining the selected tool");
      report.parameterPopupOutsideMouseAndFinger = true;
      const touchEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      const fingerStart = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"]',
        [0.52, 0.62],
      );
      await dispatchTouch(cdp, "touchStart", fingerStart, 11);
      await dispatchTouch(cdp, "touchMove", {
        x: fingerStart.x,
        y: fingerStart.y - 220,
      }, 11);
      await dispatchTouch(cdp, "touchEnd");
      await viewer.waitForFunction(
        (start) => document.getElementById("viewerContainer").scrollTop > start + 70,
        { timeout: 5_000 },
        beforeFingerPan.scrollTop,
      );
      const afterFingerPan = await inputSnapshot();
      assert.equal(afterFingerPan.storageSize, beforeFingerPan.storageSize,
        "A finger drag must not create an editor while Ink is selected");
      assert.equal(afterFingerPan.serializedSize, beforeFingerPan.serializedSize);
      assert.deepEqual(afterFingerPan.modifiedIds, beforeFingerPan.modifiedIds);
      assert.equal(afterFingerPan.editorElements, beforeFingerPan.editorElements);
      const touchObservation = await viewer.evaluate((offset) => ({
        events: window.__ipadPointerEvents?.slice(offset) || [],
        pointers: window.__ipadPointerEvents?.slice(offset).filter((event) =>
          event.pointerType === "touch" && event.targetInViewer,
        ) || [],
        deliveredPageClicks: window.__ipadPageClicksReachedDocument || [],
      }), touchEventOffset);
      assert.ok(touchObservation.pointers.some((event) =>
        event.type === "pointerdown" && event.trusted,
      ), "Touch pan must use trusted browser pointer events");
      assert.deepEqual(touchObservation.deliveredPageClicks, [],
        "Touch compatibility click events must not reach PDF.js page handlers");
      assert.ok(
        touchObservation.events.every((event) =>
          !(event.targetInViewer && ["mousedown", "mouseup"].includes(event.type)),
        ),
        `Touch must not generate compatibility mouse events in the page: ${JSON.stringify(touchObservation.events)}`,
      );

      await waitMs(1_000);
      const fastFlickStartPage = await viewer.evaluate(() => {
        const viewer = PDFViewerApplication.pdfViewer;
        // Leave enough document below the gesture that browser momentum is
        // measured before a scroll-boundary clamp can distort its velocity.
        const targetPage = Math.floor(viewer.pagesCount / 3) + 1;
        viewer.currentPageNumber = targetPage;
        return targetPage;
      });
      await viewer.waitForFunction((targetPage) =>
        PDFViewerApplication.pdfViewer.currentPageNumber === targetPage,
      { timeout: 5_000 }, fastFlickStartPage);
      await viewer.waitForFunction((targetPage) => {
        const pageView = PDFViewerApplication.pdfViewer.getPageView(targetPage - 1);
        return pageView?.renderingState === 3 &&
          pageView.div?.dataset.loaded === "true" &&
          pageView.canvas?.isConnected;
      }, { timeout: 5_000 }, fastFlickStartPage);
      await viewer.waitForFunction(() => {
        const container = document.getElementById("viewerContainer");
        const bounds = container.getBoundingClientRect();
        const visiblePages = [...container.querySelectorAll(".page")].filter((page) => {
          const rect = page.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        return visiblePages.length > 0 && visiblePages.every((page) => {
          const pageNumber = Number(page.dataset.pageNumber);
          const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
          return pageView?.renderingState === 3 &&
            page.dataset.loaded === "true" &&
            pageView.canvas?.isConnected;
        });
      }, { timeout: 5_000 });
      await viewer.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const beforeFastFlick = await inputSnapshot();
      assert.ok(beforeFastFlick.maxScrollTop - beforeFastFlick.scrollTop > 5_000,
        "The fast-flick fixture page must leave enough scroll range to measure momentum before a boundary clamp");
      const fastFlickPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.52, 0.55],
      );
      const fastFlickEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      const profileFastFlickInertia =
        process.env.PDF_READER_IPAD_PROFILE_INERTIA === "1";
      let fastFlickProfilerStarted = false;
      if (profileFastFlickInertia) {
        try {
          await cdp.send("Profiler.enable");
          await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
          await cdp.send("Profiler.start");
          fastFlickProfilerStarted = true;
        } catch (error) {
          report.fastFlickInertiaProfile = {
            state: "start-failed",
            message: error?.message || String(error),
          };
        }
      }
      const fastFlickReleaseTiming = await beginFastTouchDrag(
        cdp, viewer, fastFlickPoint, 260, 21, report,
      );
      await viewer.waitForFunction((start) =>
        document.getElementById("viewerContainer").scrollTop > start + 180,
      { timeout: 5_000 }, beforeFastFlick.scrollTop);
      const fastFlickAtRelease = await inputSnapshot();
      const fastFlickImmediatelyAfterRelease = await inputSnapshot();
      await viewer.waitForFunction(() => {
        const container = document.getElementById("viewerContainer");
        const bounds = container.getBoundingClientRect();
        const visiblePages = [...container.querySelectorAll(".page")].filter((page) => {
          const rect = page.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        const allVisiblePagesRendered = visiblePages.length > 0 &&
          visiblePages.every((page) => {
            const pageView = PDFViewerApplication.pdfViewer.getPageView(
              Number(page.dataset.pageNumber) - 1,
            );
            return pageView?.renderingState === 3 &&
              page.dataset.loaded === "true" && pageView.canvas?.isConnected &&
              page.querySelector(".textLayer .endOfContent");
          });
        const longTasks = window.__ipadLongTasks || [];
        const mostRecentLongTaskEnd = longTasks.reduce(
          (latest, task) => Math.max(latest, task.startTime + task.duration),
          0,
        );
        return allVisiblePagesRendered &&
          performance.now() - mostRecentLongTaskEnd >= 50;
      }, { timeout: 5_000 });
      const timedInertiaSamples = await viewer.evaluate(async () => {
        const container = document.getElementById("viewerContainer");
        const startedAt = performance.now();
        const startScrollTop = container.scrollTop;
        await new Promise((resolve) => setTimeout(resolve, 120));
        const firstAt = performance.now();
        const firstScrollTop = container.scrollTop;
        await new Promise((resolve) => setTimeout(resolve, 120));
        const secondAt = performance.now();
        return {
          startScrollTop,
          firstScrollTop,
          secondScrollTop: container.scrollTop,
          firstIntervalMs: firstAt - startedAt,
          secondIntervalMs: secondAt - firstAt,
        };
      });
      if (fastFlickProfilerStarted) {
        try {
          const { profile } = await cdp.send("Profiler.stop");
          const frames = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
          const samplesByFrame = new Map();
          for (let index = 0; index < profile.samples.length; index += 1) {
            const frame = frames.get(profile.samples[index]);
            if (!frame) continue;
            const key = `${frame.url}:${frame.lineNumber}:${frame.functionName}`;
            const row = samplesByFrame.get(key) || {
              functionName: frame.functionName || "(anonymous)",
              url: frame.url || "",
              lineNumber: frame.lineNumber,
              samples: 0,
              sampleMs: 0,
            };
            row.samples += 1;
            row.sampleMs += (profile.timeDeltas[index] || 0) / 1000;
            samplesByFrame.set(key, row);
          }
          report.fastFlickInertiaProfile = {
            state: "captured",
            durationMs: (profile.endTime - profile.startTime) / 1000,
            sampleCount: profile.samples.length,
            topFrames: [...samplesByFrame.values()]
              .sort((left, right) => right.sampleMs - left.sampleMs)
              .slice(0, 30),
          };
          await cdp.send("Profiler.disable");
        } catch (error) {
          report.fastFlickInertiaProfile = {
            state: "stop-failed",
            message: error?.message || String(error),
          };
        }
      }
      const fastFlickAfterFirstInterval = {
        ...fastFlickAtRelease,
        scrollTop: timedInertiaSamples.firstScrollTop,
      };
      const fastFlickAfterSecondInterval = {
        ...fastFlickAtRelease,
        scrollTop: timedInertiaSamples.secondScrollTop,
      };
      const measurementStart = {
        ...fastFlickAtRelease,
        scrollTop: timedInertiaSamples.startScrollTop,
      };
      await waitMs(760);
      const fastFlickSettled = await inputSnapshot();
      assert.ok(
        fastFlickAtRelease.scrollTop > beforeFastFlick.scrollTop + 180,
        "The trusted fast finger drag must pan the PDF before release",
      );
      const firstInertiaDistance = fastFlickAfterFirstInterval.scrollTop -
        measurementStart.scrollTop;
      const secondInertiaDistance = fastFlickAfterSecondInterval.scrollTop -
        fastFlickAfterFirstInterval.scrollTop;
      const firstInertiaVelocity = firstInertiaDistance /
        timedInertiaSamples.firstIntervalMs;
      const secondInertiaVelocity = secondInertiaDistance /
        timedInertiaSamples.secondIntervalMs;
      report.fastFlickInertia = {
        atRelease: fastFlickAtRelease.scrollTop,
        immediatelyAfterRelease: fastFlickImmediatelyAfterRelease.scrollTop,
        measurementStart: measurementStart.scrollTop,
        afterFirstInterval: fastFlickAfterFirstInterval.scrollTop,
        afterSecondInterval: fastFlickAfterSecondInterval.scrollTop,
        settled: fastFlickSettled.scrollTop,
        sampleIntervalsMs: [
          timedInertiaSamples.firstIntervalMs,
          timedInertiaSamples.secondIntervalMs,
        ],
        firstInertiaDistance,
        secondInertiaDistance,
        firstInertiaVelocityPxPerMs: firstInertiaVelocity,
        secondInertiaVelocityPxPerMs: secondInertiaVelocity,
      };
      assert.ok(firstInertiaDistance > 20,
        "A recent fast finger release must continue scrolling");
      assert.ok(secondInertiaDistance > 5,
        "Finger inertia must continue smoothly across animation frames");
      assert.ok(secondInertiaVelocity < firstInertiaVelocity,
        "Finger inertia velocity must decay across measured intervals");
      assert.equal(fastFlickSettled.storageSize, beforeFastFlick.storageSize);
      assert.equal(fastFlickSettled.serializedSize, beforeFastFlick.serializedSize);
      assert.deepEqual(fastFlickSettled.modifiedIds, beforeFastFlick.modifiedIds,
        "Finger inertia must not modify PDF annotations");
      const fastFlickEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], fastFlickEventOffset,
      );
      assert.ok(fastFlickEvents.some((event) =>
        event.type === "pointerdown" && event.pointerType === "touch" && event.trusted,
      ), "The fast flick must use trusted touch pointer input");

      const pausePoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await dispatchTouch(cdp, "touchStart", pausePoint, 22);
      await dispatchTouch(cdp, "touchMove", {
        x: pausePoint.x,
        y: pausePoint.y - 100,
      }, 22);
      await waitMs(180);
      await dispatchTouch(cdp, "touchEnd");
      const pausedRelease = await inputSnapshot();
      await waitMs(300);
      const afterPausedRelease = await inputSnapshot();
      assert.ok(
        Math.abs(afterPausedRelease.scrollTop - pausedRelease.scrollTop) <= 1,
        "A finger that pauses before release must not start inertia",
      );

      const cancelPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.52],
      );
      const cancelEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await dispatchTouch(cdp, "touchStart", cancelPoint, 23);
      await dispatchTouch(cdp, "touchMove", {
        x: cancelPoint.x,
        y: cancelPoint.y - 130,
      }, 23);
      await viewer.waitForFunction((start) =>
        document.getElementById("viewerContainer").scrollTop > start + 50,
      { timeout: 5_000 }, pausedRelease.scrollTop);
      const beforeTouchCancel = await inputSnapshot();
      await dispatchTouch(cdp, "touchCancel");
      const afterTouchCancel = await inputSnapshot();
      assert.equal(await viewer.evaluate(() =>
        document.documentElement.classList.contains(
          "pdfReaderFingerTextSelectionSuppressed",
        ),
      ), false, "A cancelled touch must release finger text-selection suppression");
      await waitMs(300);
      const afterTouchCancelWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterTouchCancelWait.scrollTop - afterTouchCancel.scrollTop) <= 1,
        "A cancelled touch must not start inertia",
      );
      assert.ok(beforeTouchCancel.scrollTop > pausedRelease.scrollTop + 50,
        "The cancelled contact must have panned before it was cancelled");
      const touchCancelEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], cancelEventOffset,
      );
      assert.ok(touchCancelEvents.some((event) =>
        event.type === "pointercancel" && event.pointerType === "touch" && event.trusted,
      ), "The cancellation case must deliver a trusted touch pointercancel");

      const boundaryStart = await viewer.evaluate(() => {
        const container = document.getElementById("viewerContainer");
        const maxScrollTop = container.scrollHeight - container.clientHeight;
        container.scrollTop = Math.max(0, maxScrollTop - 60);
        return {
          scrollTop: container.scrollTop,
          pageNumber: PDFViewerApplication.pdfViewer.currentPageNumber,
        };
      });
      report.boundaryStart = boundaryStart;
      await viewer.evaluate(() => {
        window.__ipadStablePageObservation = {
          pageNumber: PDFViewerApplication.pdfViewer.currentPageNumber,
          stableFrames: 0,
        };
      });
      await viewer.waitForFunction(() => {
        const observation = window.__ipadStablePageObservation;
        const currentPage = PDFViewerApplication.pdfViewer.currentPageNumber;
        if (currentPage === observation.pageNumber) {
          observation.stableFrames += 1;
        } else {
          observation.pageNumber = currentPage;
          observation.stableFrames = 0;
        }
        return observation.stableFrames >= 2;
      }, { timeout: 5_000 });
      report.boundaryStablePageNumber = await viewer.evaluate(() =>
        PDFViewerApplication.pdfViewer.currentPageNumber,
      );
      await viewer.waitForFunction((pageNumber) => {
        const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
        return pageView?.renderingState === 3 &&
          pageView.div?.dataset.loaded === "true" &&
          pageView.canvas?.isConnected;
      }, { timeout: 5_000 }, boundaryStart.pageNumber);
      await viewer.waitForFunction(() => {
        const container = document.getElementById("viewerContainer");
        const bounds = container.getBoundingClientRect();
        const visiblePages = [...container.querySelectorAll(".page")].filter((page) => {
          const rect = page.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        return visiblePages.length > 0 && visiblePages.every((page) => {
          const pageNumber = Number(page.dataset.pageNumber);
          const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
          return pageView?.renderingState === 3 &&
            page.dataset.loaded === "true" &&
            pageView.canvas?.isConnected &&
            page.querySelector(".textLayer .endOfContent");
        });
      }, { timeout: 5_000 });
      await viewer.waitForFunction(() => {
        const longTasks = window.__ipadLongTasks || [];
        const mostRecentLongTaskEnd = longTasks.reduce(
          (latest, task) => Math.max(latest, task.startTime + task.duration),
          0,
        );
        return performance.now() - mostRecentLongTaskEnd >= 50;
      }, { timeout: 5_000 });
      await viewer.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const boundaryPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      const boundaryReleaseTiming = await beginFastTouchDrag(
        cdp, viewer, boundaryPoint, 220, 24, report,
      );
      await inputSnapshot();
      await waitMs(350);
      const boundaryAfterInertia = await inputSnapshot();
      report.boundaryScrollOutcome = {
        start: boundaryStart,
        after: boundaryAfterInertia,
      };
      assert.ok(boundaryAfterInertia.scrollTop >= boundaryStart.scrollTop,
        "A finger flick near the lower boundary must not reverse scroll direction");
      assert.ok(
        Math.abs(boundaryAfterInertia.scrollTop - boundaryAfterInertia.maxScrollTop) <= 1,
        "Finger inertia must stop at the PDF scroll boundary",
      );

      const runBackgroundInertiaScenario = async () => {
        report.backgroundPhase = "foregrounding-reader-before-background-test";
        await page.bringToFront();
        await page.waitForFunction(
          () => document.visibilityState === "visible" && document.hasFocus(),
          { timeout: 8_000, polling: 100 },
        );
        await viewer.waitForFunction(
          () => document.visibilityState === "visible" && document.hasFocus(),
          { timeout: 8_000, polling: 100 },
        );
        report.backgroundPhase = "preparing-background-test";
        await viewer.evaluate(() => {
          if (PDFViewerApplication.pdfViewer.annotationEditorMode !== 0) {
            PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
              source: window,
              mode: 0,
              isFromKeyboard: true,
              createNewEditor: false,
            });
          }
        });
        await viewer.waitForFunction(
          () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
          { timeout: 3_000 },
        );
      const backgroundStart = await viewer.evaluate(() => {
        const container = document.getElementById("viewerContainer");
        container.scrollTop = Math.min(500, container.scrollHeight - container.clientHeight);
        return {
          scrollTop: container.scrollTop,
          pageNumber: PDFViewerApplication.pdfViewer.currentPageNumber,
        };
      });
      await viewer.waitForFunction((pageNumber) => {
        const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
        return pageView?.renderingState === 3 &&
          pageView.div?.dataset.loaded === "true" &&
          pageView.canvas?.isConnected;
      }, { timeout: 5_000 }, backgroundStart.pageNumber);
      await viewer.waitForFunction(() => {
        const container = document.getElementById("viewerContainer");
        const bounds = container.getBoundingClientRect();
        const visiblePages = [...container.querySelectorAll(".page")].filter((page) => {
          const rect = page.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        return visiblePages.length > 0 && visiblePages.every((page) => {
          const pageNumber = Number(page.dataset.pageNumber);
          const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
          return pageView?.renderingState === 3 && page.dataset.loaded === "true";
        });
      }, { timeout: 5_000 });
      await viewer.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const backgroundFlickPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await viewer.evaluate(() => {
        const container = document.getElementById("viewerContainer");
        let scrollTopDescriptor = null;
        for (let prototype = Object.getPrototypeOf(container); prototype;
          prototype = Object.getPrototypeOf(prototype)) {
          scrollTopDescriptor = Object.getOwnPropertyDescriptor(prototype, "scrollTop");
          if (scrollTopDescriptor?.get && scrollTopDescriptor?.set) break;
        }
        if (!scrollTopDescriptor?.get || !scrollTopDescriptor?.set) {
          throw new Error("Could not instrument native scrollTop access");
        }
        window.__ipadJsScrollWriteLog = [];
        const recordScrollWrite = (kind, value) => {
          window.__ipadJsScrollWriteLog.push({
            kind,
            value,
            at: performance.now(),
            stack: new Error().stack || "",
          });
        };
        Object.defineProperty(container, "scrollTop", {
          configurable: true,
          get() { return scrollTopDescriptor.get.call(this); },
          set(value) {
            recordScrollWrite("scrollTop", value);
            scrollTopDescriptor.set.call(this, value);
          },
        });
        const nativeScrollTo = container.scrollTo.bind(container);
        Object.defineProperty(container, "scrollTo", {
          configurable: true,
          value(...args) {
            recordScrollWrite("scrollTo", args[0] ?? null);
            return nativeScrollTo(...args);
          },
        });
        window.__ipadHiddenScrollSample = null;
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "hidden") {
            const bridgeState = window.__ipadPointerPolicyTestState;
            const router = bridgeState?.inputRouter;
            const directManipulation = bridgeState?.iosDirectManipulationController;
            const viewport = bridgeState?.viewportController;
            const jsScrollWrites = window.__ipadJsScrollWriteLog || [];
            const bridgeScrollWrites = jsScrollWrites.filter(({ stack }) =>
              /(?:^|\/)bridge\.js(?::|$)/.test(stack),
            );
            window.__ipadHiddenScrollSample = {
              scrollTop: document.getElementById("viewerContainer")?.scrollTop ?? null,
              pageNumber: PDFViewerApplication.pdfViewer.currentPageNumber,
              visibilityState: document.visibilityState,
              bridgeOwnedState: {
                customMomentumActive: viewport?.momentum != null,
                customMomentumFrame: viewport?.momentum?.frame ?? null,
                manualTouchPointerCount: router?.manualPointerValues()
                  .filter((pointer) => pointer.pointerType === "touch").length ?? null,
                nativeTouchPointerCount: directManipulation?._nativeTouchPointers?.size ?? null,
                activeTouchPointerCount: router?.activePointerValues()
                  .filter((pointer) => pointer.pointerType === "touch").length ?? null,
                fingerTextSelectionSuppressed: document.documentElement.classList.contains(
                  "pdfReaderFingerTextSelectionSuppressed",
                ),
                readPenTextSelectionSuppressed: document.documentElement.classList.contains(
                  "pdfReaderReadPenTextSelectionSuppressed",
                ),
                bridgeScrollWrites,
                allJsScrollWrites: jsScrollWrites,
              },
            };
          }
        }, { once: true });
      });
      const backgroundFlickReleaseTiming = await beginFastTouchDrag(
        cdp, viewer, backgroundFlickPoint, 260, 31, report,
      );
      const backgroundFlickAtRelease = await inputSnapshot();
      await waitMs(70);
      const beforeBackgrounding = await inputSnapshot();
      assert.ok(beforeBackgrounding.scrollTop > backgroundFlickAtRelease.scrollTop + 5,
        "The trusted finger flick must still be in motion before this page is backgrounded");

      let backgroundPage = null;
      let backgroundPhaseError = null;
      try {
        report.backgroundPhase = "opening-background-tab";
        backgroundPage = await browser.newPage();
        report.backgroundPhase = "loading-background-tab";
        await backgroundPage.goto("about:blank");
        report.backgroundPhase = "foregrounding-background-tab";
        await backgroundPage.bringToFront();
        report.backgroundPhase = "background-tab-visible";
        // Do not issue Runtime.evaluate calls against a backgrounded Chromium
        // page: its renderer can be frozen, causing Puppeteer protocol calls
        // to hang. Capture the exact visibilitychange boundary synchronously
        // and read it only after foregrounding the page again.
        await waitMs(180);
        report.backgroundPhase = "restoring-reader-tab";
        await page.bringToFront();
        report.backgroundPhase = "waiting-reader-visible";
        await page.waitForFunction(
          () => document.visibilityState === "visible",
          { timeout: 8_000, polling: 100 },
        );
        report.backgroundPhase = "waiting-viewer-visible";
        await viewer.waitForFunction(
          () => document.visibilityState === "visible",
          { timeout: 8_000, polling: 100 },
        );
        report.backgroundPhase = "reading-hidden-scroll-sample";
        const hiddenAt = await viewer.evaluate(() => window.__ipadHiddenScrollSample);
        assert.ok(hiddenAt && hiddenAt.visibilityState === "hidden" &&
          Number.isFinite(hiddenAt.scrollTop),
        "The viewer must record scroll position synchronously at its hidden visibility boundary");
        // Native WebKit scrolling owns finger momentum. The bridge cancels its
        // sessions at hide, while the browser compositor may finish or pause
        // its own scroll animation independently of foregrounding.
        assert.equal(hiddenAt.bridgeOwnedState.customMomentumActive, false,
          "The bridge must not own custom momentum at the hidden boundary");
        assert.equal(hiddenAt.bridgeOwnedState.customMomentumFrame, null);
        assert.equal(hiddenAt.bridgeOwnedState.manualTouchPointerCount, 0,
          "The hidden boundary must clear bridge-owned manual touch sessions");
        assert.equal(hiddenAt.bridgeOwnedState.nativeTouchPointerCount, 0,
          "The trusted flick contact must end before the page is hidden");
        assert.equal(hiddenAt.bridgeOwnedState.activeTouchPointerCount, 0,
          "The hidden boundary must not retain an active touch pointer");
        assert.equal(hiddenAt.bridgeOwnedState.fingerTextSelectionSuppressed, false,
          "The hidden boundary must clear finger text-selection suppression");
        assert.equal(hiddenAt.bridgeOwnedState.readPenTextSelectionSuppressed, false,
          "The hidden boundary must clear read-mode Pencil selection suppression");
        assert.deepEqual(hiddenAt.bridgeOwnedState.bridgeScrollWrites, [],
          `The bridge must not write viewer scroll position during the native flick: ${JSON.stringify(hiddenAt.bridgeOwnedState.allJsScrollWrites)}`);
        const afterForegrounding = await inputSnapshot();
        await waitMs(120);
        const afterForegrounding120ms = await inputSnapshot();
        await waitMs(130);
        const afterForegrounding250ms = await inputSnapshot();
        report.backgroundTabInertia = {
          start: backgroundStart.scrollTop,
          flickAtRelease: backgroundFlickAtRelease,
          beforeBackgrounding,
          hiddenAt,
          afterForegrounding,
          afterForegrounding120ms,
          afterForegrounding250ms,
          hiddenBoundaryOwnership: hiddenAt.bridgeOwnedState,
        };
        const bridgeScrollWritesAfterRestore = await viewer.evaluate(() =>
          (window.__ipadJsScrollWriteLog || []).filter(({ stack }) =>
            /(?:^|\/)bridge\.js(?::|$)/.test(stack),
          ),
        );
        assert.deepEqual(bridgeScrollWritesAfterRestore, [],
          "Foregrounding must not apply bridge-owned hidden-time scroll updates");
        report.backgroundTabInertiaCancellation = {
          method: "native touch release followed by a new Chrome about:blank tab",
          scrollOwnership: "browser compositor owns native touch momentum",
          bridgeHiddenBoundary: "custom momentum, touch sessions, suppression and scroll writes are cleared",
          originalVisibilityWhenBackgrounded: "hidden",
          iframeVisibilityWhenBackgrounded: "hidden",
          originalVisibilityWhenRestored: "visible",
          iframeVisibilityWhenRestored: "visible",
          start: backgroundStart.scrollTop,
          flickAtRelease: backgroundFlickAtRelease,
          releaseTiming: backgroundFlickReleaseTiming,
          beforeBackgrounding,
          hiddenAt,
          afterForegrounding,
          afterForegrounding120ms,
          afterForegrounding250ms,
          hiddenBoundaryOwnership: hiddenAt.bridgeOwnedState,
          bridgeScrollWritesAfterRestore,
        };
      } catch (error) {
        backgroundPhaseError = error;
        report.backgroundPhaseError = {
          name: error?.name || "Error",
          message: error?.message || String(error),
          stack: error?.stack || null,
        };
        throw error;
      } finally {
        if (backgroundPage && !backgroundPage.isClosed()) {
          try {
            await backgroundPage.close();
          } catch (cleanupError) {
            if (backgroundPhaseError) {
              backgroundPhaseError.backgroundPageCloseError = cleanupError.message;
            } else {
              throw cleanupError;
            }
          }
        }
      }

      // Closing the temporary foreground tab does not consistently restore
      // the previous target as the active mobile-emulation input target.
      // Re-focus it explicitly before subsequent trusted touchscreen input.
      await page.bringToFront();
      const foregroundAfterBackgroundClose = await viewer.evaluate(() => ({
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
      }));
      report.foregroundAfterBackgroundClose = foregroundAfterBackgroundClose;
      assert.deepEqual(foregroundAfterBackgroundClose, {
        visibility: "visible",
        hasFocus: true,
      }, "The original viewer must regain foreground focus after closing the background-test tab");
      };

      const middleScroll = await viewer.evaluate(() => {
        const container = document.getElementById("viewerContainer");
        container.scrollTop = Math.min(
          500,
          Math.max(0, (container.scrollHeight - container.clientHeight) / 2),
        );
        return container.scrollTop;
      });
      await viewer.waitForFunction(() => {
        const container = document.getElementById("viewerContainer");
        const bounds = container.getBoundingClientRect();
        const visiblePages = [...container.querySelectorAll(".page")].filter((page) => {
          const rect = page.getBoundingClientRect();
          return rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        return visiblePages.length > 0 && visiblePages.every((page) => {
          const pageNumber = Number(page.dataset.pageNumber);
          const pageView = PDFViewerApplication.pdfViewer.getPageView(pageNumber - 1);
          return pageView?.renderingState === 3 &&
            page.dataset.loaded === "true" &&
            pageView.canvas?.isConnected;
        });
      }, { timeout: 5_000 });
      await viewer.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      const toolbarTouchPoint = await localPointInHost(
        viewer,
        page,
        "#editorInkButton",
      );
      const toolbarTouchOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      const newContactPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      const newContactReleaseTiming = await beginFastTouchDrag(
        cdp, viewer, newContactPoint, 180, 25, report,
      );
      const newContactAtRelease = await inputSnapshot();
      await waitMs(80);
      const beforeToolbarTouch = await inputSnapshot();
      report.toolbarContactPrecondition = {
        atRelease: newContactAtRelease,
        after80ms: beforeToolbarTouch,
        releaseTiming: newContactReleaseTiming,
      };
      assert.ok(beforeToolbarTouch.scrollTop > newContactAtRelease.scrollTop + 5,
        "The finger flick must have active inertia before the new contact");
      await dispatchTouch(cdp, "touchStart", toolbarTouchPoint, 26);
      await dispatchTouch(cdp, "touchEnd");
      const afterToolbarTouch = await inputSnapshot();
      await waitMs(300);
      const afterToolbarTouchWait = await inputSnapshot();
      assert.ok(
        Math.abs(afterToolbarTouchWait.scrollTop - afterToolbarTouch.scrollTop) <= 1,
        "A new finger contact on the toolbar must stop PDF inertia",
      );
      const toolbarTouchEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], toolbarTouchOffset,
      );
      assert.ok(toolbarTouchEvents.some((event) =>
        event.type === "pointerdown" && event.pointerType === "touch" &&
        event.trusted && !event.targetInViewer,
      ), "The momentum-stopping contact must land on a toolbar control");

      const penMomentumPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      const penFlickReleaseTiming = await beginFastTouchDrag(
        cdp, viewer, penMomentumPoint, 180, 27, report,
      );
      const penFlickAtRelease = await inputSnapshot();
      await waitMs(70);
      const beforePenStop = await inputSnapshot();
      assert.ok(beforePenStop.scrollTop > penFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the Pencil contact");
      report.penToolIntent = await viewer.evaluate(() =>
        window.PdfReaderInputRuntime.createInteractionIntent({
          type: "pointerdown", pointerType: "pen", pointerId: 999,
          target: document.getElementById("editorInkButton"),
        }),
      );
      await tapSimulatedPen(cdp, toolbarTouchPoint);
      const afterPenStop = await inputSnapshot();
      await waitMs(300);
      const afterPenStopWait = await inputSnapshot();
      report.penMomentumStop = {
        release: penFlickAtRelease.scrollTop,
        beforeContact: beforePenStop.scrollTop,
        immediatelyAfter: afterPenStop.scrollTop,
        after300ms: afterPenStopWait.scrollTop,
        toolModeAfterContact: await viewer.evaluate(() =>
          PDFViewerApplication.pdfViewer.annotationEditorMode),
      };
      assert.equal(report.penMomentumStop.toolModeAfterContact, 15,
        "the trusted pen activation selects the native Ink tool");

      const mouseMomentumPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await beginFastTouchDrag(cdp, viewer, mouseMomentumPoint, 180, 28, report);
      const mouseFlickAtRelease = await inputSnapshot();
      await waitMs(70);
      const beforeMouseStop = await inputSnapshot();
      assert.ok(beforeMouseStop.scrollTop > mouseFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the mouse contact");
      await page.mouse.click(toolbarTouchPoint.x, toolbarTouchPoint.y);
      const afterMouseStop = await inputSnapshot();
      await waitMs(300);
      const afterMouseStopWait = await inputSnapshot();
      report.mouseMomentumPassThrough = {
        atContact: afterMouseStop.scrollTop,
        after300ms: afterMouseStopWait.scrollTop,
      };
      assert.ok(
        afterMouseStopWait.scrollTop > afterMouseStop.scrollTop + 1,
        "An ordinary mouse contact keeps its native path and does not claim Pencil scroll ownership",
      );

      const wheelMomentumPoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      const wheelEventOffset = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await beginFastTouchDrag(cdp, viewer, wheelMomentumPoint, 180, 29, report);
      const wheelFlickAtRelease = await inputSnapshot();
      await waitMs(70);
      const beforeWheelStop = await inputSnapshot();
      assert.ok(beforeWheelStop.scrollTop > wheelFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the wheel event");
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: wheelMomentumPoint.x,
        y: wheelMomentumPoint.y,
        deltaX: 0,
        deltaY: 0,
      });
      const afterWheelStop = await inputSnapshot();
      await waitMs(300);
      const afterWheelStopWait = await inputSnapshot();
      report.wheelMomentumNative = {
        atEvent: afterWheelStop.scrollTop,
        after300ms: afterWheelStopWait.scrollTop,
      };
      const wheelEvents = await viewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], wheelEventOffset,
      );
      assert.ok(wheelEvents.some((event) => event.type === "wheel" && event.trusted),
        "The wheel cancellation case must deliver a trusted wheel event");

      // Earlier toolbar contacts deliberately use the Ink button to stop
      // inertia. Re-establish a known active tool before testing whether a
      // touch-owned selection guard survives a tool-to-tool switch.
      await viewer.evaluate(() => {
        if (PDFViewerApplication.pdfViewer.annotationEditorMode !== 9) {
          PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
            source: window,
            mode: 9,
            isFromKeyboard: true,
            createNewEditor: false,
          });
        }
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 9,
        { timeout: 3_000 },
      );
      const toolChangePoint = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.5, 0.5],
      );
      await beginFastTouchDrag(cdp, viewer, toolChangePoint, 180, 30, report);
      const toolChangeFlickAtRelease = await inputSnapshot();
      const toolChangeTouchPrecondition = await viewer.evaluate(() => ({
        mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
        selectionSuppressionGuard: document.documentElement.classList.contains(
          "pdfReaderFingerTextSelectionSuppressed",
        ),
      }));
      report.toolChangeTouchPrecondition = toolChangeTouchPrecondition;
      assert.equal(toolChangeTouchPrecondition.mode, 9,
        "The final touch must start with the known Highlight tool active");
      assert.equal(toolChangeTouchPrecondition.selectionSuppressionGuard, true,
        "The final touch must own selection suppression before the tool switch");
      await waitMs(70);
      const beforeToolChange = await inputSnapshot();
      assert.ok(beforeToolChange.scrollTop > toolChangeFlickAtRelease.scrollTop + 5,
        "The finger flick must be moving before the tool change");
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 5,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 3_000 },
      );
      assert.equal(await viewer.evaluate(() =>
        document.documentElement.classList.contains(
          "pdfReaderFingerTextSelectionSuppressed",
        ),
      ), true, "Changing between annotation tools must preserve touch-owned selection suppression");
      const afterToolChange = await inputSnapshot();
      await waitMs(300);
      const afterToolChangeWait = await inputSnapshot();
      report.toolChangeMomentumStop = {
        simulationOnly: true,
        beforeToolChange: beforeToolChange.scrollTop,
        immediatelyAfterToolChange: afterToolChange.scrollTop,
        after300ms: afterToolChangeWait.scrollTop,
        note: "Chromium native-touch momentum is not a WKWebView acceptance signal; stopNativeScroll dispatch is covered by IOSInputPolicy unit tests.",
      };
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 15,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 3_000 },
      );
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 0,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
        { timeout: 3_000 },
      );
      assert.equal(await viewer.evaluate(() =>
        document.documentElement.classList.contains(
          "pdfReaderFingerTextSelectionSuppressed",
        ),
      ), false, "Returning to reading mode must release finger text-selection suppression");
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 15,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 3_000 },
      );

      report.fingerInertia = {
        policy: "trusted CDP touch sequence; Chromium routing evidence only",
        fastFlick: {
          before: beforeFastFlick,
          atRelease: fastFlickAtRelease,
          releaseTiming: fastFlickReleaseTiming,
          immediatelyAfterRelease: fastFlickImmediatelyAfterRelease,
          afterFirstInterval: fastFlickAfterFirstInterval,
          afterSecondInterval: fastFlickAfterSecondInterval,
          settled: fastFlickSettled,
          firstIntervalDistance: firstInertiaDistance,
          secondIntervalDistance: secondInertiaDistance,
          observedPointerEvents: fastFlickEvents,
        },
        pause: { release: pausedRelease, after: afterPausedRelease },
        cancel: {
          before: beforeTouchCancel,
          after: afterTouchCancel,
          afterWait: afterTouchCancelWait,
          observedPointerEvents: touchCancelEvents,
        },
        boundary: {
          start: boundaryStart.scrollTop,
          pageNumber: boundaryStart.pageNumber,
          after: boundaryAfterInertia,
          releaseTiming: boundaryReleaseTiming,
        },
        toolbarContact: {
          atRelease: newContactAtRelease,
          beforeTouch: beforeToolbarTouch,
          afterTouch: afterToolbarTouchWait,
          releaseTiming: newContactReleaseTiming,
        },
        penStop: {
          atRelease: penFlickAtRelease,
          before: beforePenStop,
          after: afterPenStopWait,
          releaseTiming: penFlickReleaseTiming,
        },
        mouseStop: { before: beforeMouseStop, after: afterMouseStopWait },
        wheelStop: { before: beforeWheelStop, after: afterWheelStopWait },
        wheelEvents,
        toolChangeStop: { before: beforeToolChange, after: afterToolChangeWait },
        middleScroll,
      };

      // The bridge intentionally pins scroll during outside-toolbar contacts
      // until an explicit navigation/wheel/touch boundary releases the
      // momentum guard. Return to read mode and use a no-motion finger contact
      // in the viewer gutter to release it without touching a PDF page.
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 0,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
        { timeout: 3_000 },
      );
      const beforeGuardReleaseTouch = await inputSnapshot();
      const guardReleaseGutter = await localPointInHost(
        viewer,
        page,
        "#viewerContainer",
        [0.02, 0.5],
      );
      await dispatchTouch(cdp, "touchStart", guardReleaseGutter, 42);
      await waitMs(50);
      await dispatchTouch(cdp, "touchEnd");
      const afterGuardReleaseTouch = await inputSnapshot();
      assert.equal(afterGuardReleaseTouch.storageSize, beforeGuardReleaseTouch.storageSize,
        "A no-motion gutter contact used to release the scroll guard must not create an annotation");
      assert.equal(afterGuardReleaseTouch.editorElements, beforeGuardReleaseTouch.editorElements,
        "A no-motion gutter contact must not create an editor");
      await viewer.evaluate(() => {
        document.querySelector('.page[data-page-number="1"]')?.scrollIntoView({
          block: "start",
          behavior: "instant",
        });
        PDFViewerApplication.pdfViewer.currentPageNumber = 1;
      });
      await page.bringToFront();
      await page.waitForFunction(() =>
        document.visibilityState === "visible" && document.hasFocus(),
      { timeout: 8_000 });
      await viewer.waitForFunction(() =>
        document.visibilityState === "visible" && document.hasFocus(),
      { timeout: 8_000 });
      await viewer.waitForFunction(() => {
        const container = document.getElementById("viewerContainer");
        const page = document.querySelector('.page[data-page-number="1"]');
        const pageView = PDFViewerApplication.pdfViewer.getPageView(0);
        const editorLayer = page?.querySelector(".annotationEditorLayer");
        const containerRect = container?.getBoundingClientRect();
        const pageRect = page?.getBoundingClientRect();
        const layerRect = editorLayer?.getBoundingClientRect();
        const drawStartY = pageRect ? pageRect.top + pageRect.height * 0.52 : Infinity;
        return PDFViewerApplication.pdfViewer.currentPageNumber === 1 &&
          pageView?.renderingState === 3 &&
          page?.dataset.loaded === "true" &&
          pageView.canvas?.isConnected &&
          page.querySelector(".textLayer span") &&
          pageRect?.bottom > containerRect?.top &&
          pageRect?.top < containerRect?.bottom &&
          drawStartY >= containerRect?.top &&
          drawStartY + 64 <= containerRect?.bottom &&
          layerRect?.width > 0 && layerRect?.height > 0;
      }, { timeout: 8_000 });
      await viewer.waitForFunction(() => {
        const mostRecentLongTaskEnd = (window.__ipadLongTasks || []).reduce(
          (latest, task) => Math.max(latest, task.startTime + task.duration),
          0,
        );
        return performance.now() - mostRecentLongTaskEnd >= 50;
      }, { timeout: 5_000 });
      await viewer.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await viewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 15,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await viewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 3_000 },
      );
      const beforeMouseDraw = await inputSnapshot();
      const mouseStart = await localPointInHost(
        viewer,
        page,
        '.page[data-page-number="1"] .annotationEditorLayer',
        [0.38, 0.52],
      );
      report.mouseDrawProbe = await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        const rect = layer?.getBoundingClientRect();
        const x = rect ? rect.left + rect.width * 0.38 : NaN;
        const y = rect ? rect.top + rect.height * 0.52 : NaN;
        const target = Number.isFinite(x) && Number.isFinite(y)
          ? document.elementFromPoint(x, y)
          : null;
        const path = [];
        for (let node = target; node instanceof Element; node = node.parentElement) {
          const style = getComputedStyle(node);
          path.push({
            tag: node.tagName,
            id: node.id || null,
            className: typeof node.className === "string" ? node.className : null,
            pointerEvents: style.pointerEvents,
          });
          if (path.length === 8) break;
        }
        return {
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          layerMatchesEventTarget: target === layer,
          targetPath: path,
          layerRect: rect ? {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          } : null,
          pageRect: layer?.closest(".page")?.getBoundingClientRect().toJSON() || null,
          editorLayerPointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
          editorLayerClasses: layer?.className || null,
        };
      });
      await viewer.evaluate(() => {
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        window.__inkMouseDispatchTrace = [];
        for (const type of ["pointerdown", "pointermove", "pointerup"]) {
          for (const capture of [true, false]) {
            layer.addEventListener(type, (event) => {
              window.__inkMouseDispatchTrace.push({
                type,
                phase: capture ? "capture" : "bubble",
                targetIsLayer: event.target === layer,
                pointerType: event.pointerType,
                pointerId: event.pointerId,
                button: event.button,
                buttons: event.buttons,
                defaultPrevented: event.defaultPrevented,
                layerClasses: layer.className,
                drawNodes: layer.querySelectorAll("svg").length,
                pathData: [...layer.querySelectorAll("svg path[d]")]
                  .map((path) => path.getAttribute("d"))
                  .filter((data) => data && data.trim().length > 0),
              });
            }, capture);
          }
        }
      });
      await page.mouse.move(mouseStart.x, mouseStart.y);
      await page.mouse.down();
      await page.mouse.move(mouseStart.x + 88, mouseStart.y + 64, { steps: 6 });
      await page.mouse.up();
      report.mouseDrawAfter = await viewer.evaluate(() => {
        const manager = PDFViewerApplication.pdfViewer._layerProperties
          .annotationEditorUIManager;
        const layer = document.querySelector(
          '.page[data-page-number="1"] .annotationEditorLayer',
        );
        const drawingPaths = [...document.querySelectorAll(
          '.page[data-page-number="1"] .canvasWrapper svg path[d]',
        )].map((path) => path.getAttribute("d"))
          .filter((data) => data && data.trim().length > 0);
        return {
          dispatchTrace: window.__inkMouseDispatchTrace || [],
          mode: PDFViewerApplication.pdfViewer.annotationEditorMode,
          inkEditors: document.querySelectorAll(
            '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
          ).length,
          drawingSvgCount: document.querySelectorAll(
            '.page[data-page-number="1"] .canvasWrapper svg',
          ).length,
          drawingPaths,
          currentLayerPresent: !!manager.currentLayer,
          currentLayerClasses: manager.currentLayer?.div?.className || null,
          editors: manager.getEditors(0).map((editor) => ({
            editorType: editor.editorType,
            typeName: editor.constructor?.name || null,
            id: editor.id,
            deleted: editor.deleted,
            serialized: !!editor.serialize(),
            connected: !!editor.div?.isConnected,
          })),
          annotationStorageSize: PDFViewerApplication.pdfDocument.annotationStorage.size,
          serializedSize: PDFViewerApplication.pdfDocument.annotationStorage.serializable?.map?.size ?? null,
        };
      });
      assert.ok(report.mouseDrawAfter.drawingPaths.length > beforeMouseDraw.drawingPathCount,
        "Trusted mouse movement must create a non-empty PDF.js Ink drawing before commit");
      // The harness disables background auto-save to keep this pointer-policy
      // test isolated. PDF.js keeps Ink strokes in its live drawing session so
      // users can add multiple strokes; finalize that real session at the same
      // explicit boundary used by manual save/close before asserting editor
      // serialization.
      await viewer.evaluate(() => PDFViewerApplication.pdfViewer
        ._layerProperties.annotationEditorUIManager.currentLayer?.commitOrRemove?.());
      await viewer.waitForFunction(
        (previous) => document.querySelectorAll(
          '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
        ).length > previous,
        { timeout: 8_000 },
        beforeMouseDraw.editorElements,
      );
      const afterMouseDraw = await inputSnapshot();
      assert.ok(afterMouseDraw.serializedSize > beforeMouseDraw.serializedSize,
        "Mouse drawing must still reach PDF.js under the iOS policy flag");
      const mouseObservation = await viewer.evaluate(() =>
        window.__ipadPointerEvents?.filter((event) =>
          event.pointerType === "mouse" && event.targetInViewer,
        ) || [],
      );
      assert.ok(mouseObservation.some((event) => event.type === "pointerdown" && event.trusted));

      // Keep the background-scroll check ahead of the second viewer page. In
      // Chromium mobile emulation, returning to an already-open viewer after
      // another viewer has been foregrounded dispatches touch events but does
      // not reliably restart its native scrolling compositor.
      await runBackgroundInertiaScenario();

      penPage = await browser.newPage();
      await penPage.setViewport({
        width: 1180,
        height: 920,
        deviceScaleFactor: 1,
        isMobile: true,
        hasTouch: true,
      });
      // A new page can be visible without being the active input target after
      // the temporary background tab closes.
      await penPage.bringToFront();
      await penPage.evaluateOnNewDocument(() => {
        window.__ipadPointerEvents = [];
        for (const type of [
          "pointerdown", "pointermove", "pointerup", "pointercancel",
          "mousedown", "mouseup", "click", "dblclick",
        ]) {
          window.addEventListener(type, (event) => {
            const target = event.target instanceof Element ? event.target : null;
            window.__ipadPointerEvents.push({
              type,
              pointerType: event.pointerType || null,
              trusted: event.isTrusted === true,
              targetInViewer: !!target?.closest?.("#viewerContainer"),
              targetPage: target?.closest?.(".page")?.dataset.pageNumber || null,
              targetId: target?.id || null,
              targetToolButton: target?.closest?.("#editorSquareButton")?.id || null,
            });
          }, true);
        }
      });
      penPage.on("pageerror", (error) => report.pageErrors.push(error.message));
      await penPage.goto(`http://127.0.0.1:${server.address().port}/`, {
        waitUntil: "domcontentloaded",
      });
      await penPage.waitForFunction(() => window.__host?.opened?.length === 1, {
        timeout: 35_000,
      });
      await penPage.waitForFunction(
        () => document.visibilityState === "visible" && document.hasFocus(),
        { timeout: 8_000 },
      );
      penViewer = penPage.frames().find((frame) => frame.name() === "pdf-reader");
      assert.ok(penViewer, "Expected the second PDF.js viewer iframe");
      await penViewer.waitForFunction(() => {
        const page = document.querySelector('.page[data-page-number="1"]');
        return PDFViewerApplication.pdfDocument && page?.dataset.loaded === "true" &&
          !!page.querySelector(".textLayer span") &&
          page.getBoundingClientRect().width > 0;
      }, { timeout: 12_000 });
      await penViewer.waitForFunction(() => {
        const button = document.getElementById("editorSquareButton");
        return button?.isConnected && !button.disabled;
      }, { timeout: 8_000 });
      const penInputReadiness = await penViewer.evaluate(() => {
        const state = window.__ipadPointerPolicyTestState;
        const host = window.parent.__browserSidecarHost;
        const actualIdentity = state?.actualSourceIdentity;
        const externalSource = state?.externalSource;
        return {
          readOnly: state?.readOnly ?? null,
          externalSourceConfirmed: state?.externalSourceConfirmed ?? null,
          externalSourceMismatch: state?.externalSourceMismatch ?? null,
          actualIdentityStatus: actualIdentity?.identityStatus ?? null,
          actualPageCount: actualIdentity?.pageCount ?? null,
          externalPageCount: externalSource?.pageCount ?? null,
          identityRequest: host?.identityRequests?.at(-1) ? {
            sourceHash: host.identityRequests.at(-1).sourceHash,
            pageCount: host.identityRequests.at(-1).pageCount,
            identityStatus: host.identityRequests.at(-1).identityStatus,
          } : null,
          hostErrors: host?.errors || [],
        };
      });
      report.penInputReadiness = penInputReadiness;
      assert.equal(penInputReadiness.readOnly, false,
        "The Pencil fixture must wait for the host-confirmed source identity before editing");
      assert.equal(penInputReadiness.externalSourceConfirmed, true,
        "The Pencil fixture must have a confirmed external source before editing");
      // Focusing a text input in mobile emulation can asynchronously pan the
      // visual viewport after coordinates were measured. Focus the scroll
      // container without opening an input/keyboard instead.
      await penViewer.evaluate(() => {
        window.focus();
        document.getElementById("viewerContainer").focus({ preventScroll: true });
      });
      await penViewer.waitForFunction(() => document.hasFocus(), { timeout: 8_000 });
      report.penViewerFocusedByTrustedToolbarClick = await penViewer.evaluate(() => ({
        hasFocus: document.hasFocus(),
        activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      }));
      const penCdp = await penPage.target().createCDPSession();
      const penSquareTool = await localPointInHost(
        penViewer,
        penPage,
        "#editorSquareButton",
      );
      await penViewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 0,
        { timeout: 8_000 },
      );
      await dispatchTouch(penCdp, "touchStart", penSquareTool, 14);
      await dispatchTouch(penCdp, "touchEnd");
      await penViewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 8_000 },
      );
      await penViewer.evaluate(() => {
        PDFViewerApplication.eventBus.dispatch("switchannotationeditormode", {
          source: window,
          mode: 15,
          isFromKeyboard: true,
          createNewEditor: false,
        });
      });
      await penViewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 15,
        { timeout: 3_000 },
      );
      const activeToolTouchOffset = await penViewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await dispatchTouch(penCdp, "touchStart", penSquareTool, 15);
      await waitMs(50);
      await dispatchTouch(penCdp, "touchEnd");
      report.activeToolTouchTap = await penViewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], activeToolTouchOffset,
      );
      await penViewer.waitForFunction(
        () => PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
        { timeout: 8_000 },
      );
      const activeToolTouchEvents = await penViewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], activeToolTouchOffset,
      );
      report.activeToolTouchTap = activeToolTouchEvents;
      assert.ok(activeToolTouchEvents.some((event) =>
        event.type === "click" && event.trusted &&
        event.targetToolButton === "editorSquareButton",
      ), "A trusted touchscreen tap must switch from an active editor tool to Square in an isolated Reader");
      // Tool-button activation can move focus back to the host in Chromium's
      // mobile emulation. Re-focus the actual iframe immediately before
      // dispatching simulated Pencil input so it targets the active viewer.
      await penPage.bringToFront();
      await penViewer.evaluate(() => {
        // This second Reader shares the fixture's saved reading position with
        // the first one. Establish the page-1 precondition before measuring
        // dispatch coordinates; an offscreen layer produces no pointer events.
        PDFViewerApplication.pdfViewer.currentPageNumber = 1;
        document.getElementById("viewerContainer").scrollTop = 0;
        window.focus();
        document.getElementById("viewerContainer").focus({ preventScroll: true });
      });
      await penViewer.waitForFunction(() => document.hasFocus(), { timeout: 8_000 });
      report.penViewerFocusedBeforeDraw = await penViewer.evaluate(() => ({
        hasFocus: document.hasFocus(),
        activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
      }));
      const beforePenDraw = await inputSnapshot(penViewer);
      const penDrawStart = await visiblePointInHost(
        penViewer,
        penPage,
        '.page[data-page-number="1"] .annotationEditorLayer',
        [0.64, 0.48],
      );
      report.penDrawDispatchTarget = penDrawStart;
      assert.equal(penDrawStart.local.hit.insideTarget, true,
        "The simulated Pencil start must hit the visible page annotation layer");
      assert.equal(penDrawStart.local.hit.pageNumber, "1",
        "The simulated Pencil start must hit page 1");
      assert.ok(penDrawStart.local.visibleRect.right - penDrawStart.local.x >= 80 &&
        penDrawStart.local.visibleRect.bottom - penDrawStart.local.y >= 60,
      "The visible annotation layer must have room for the complete simulated Pencil stroke");
      const penEventOffset = await penViewer.evaluate(() =>
        window.__ipadPointerEvents?.length || 0,
      );
      await dispatchSimulatedPen(penCdp, "mousePressed", penDrawStart, 1);
      await dispatchSimulatedPen(penCdp, "mouseMoved", {
        x: penDrawStart.x + 22,
        y: penDrawStart.y + 18,
      }, 1);
      const duringPenDraw = await inputSnapshot(penViewer);
      const fingerDuringPen = await visiblePointInHost(
        penViewer,
        penPage,
        '.page[data-page-number="1"]',
        [0.18, 0.7],
      );
      report.fingerDuringPenTarget = fingerDuringPen;
      assert.equal(fingerDuringPen.local.hit.pageNumber, "1",
        "The finger contact during Pencil input must hit the visible PDF page");
      assert.ok(fingerDuringPen.local.y - 180 >= fingerDuringPen.local.visibleRect.top,
        "The finger pan probe must remain inside the visible PDF viewport");
      await dispatchTouch(penCdp, "touchStart", fingerDuringPen, 13);
      await dispatchTouch(penCdp, "touchMove", {
        x: fingerDuringPen.x,
        y: fingerDuringPen.y - 180,
      }, 13);
      await dispatchTouch(penCdp, "touchEnd");
      const afterFingerDuringPen = await inputSnapshot(penViewer);
      assert.equal(afterFingerDuringPen.scrollTop, duringPenDraw.scrollTop,
        "A finger arriving during a pen edit must not pan the PDF");
      assert.equal(afterFingerDuringPen.editorElements, duringPenDraw.editorElements,
        "A finger arriving during a pen edit must not create or change editor count");
      await dispatchSimulatedPen(penCdp, "mouseMoved", {
        x: penDrawStart.x + 72,
        y: penDrawStart.y + 54,
      }, 1);
      await dispatchSimulatedPen(penCdp, "mouseReleased", {
        x: penDrawStart.x + 72,
        y: penDrawStart.y + 54,
      }, 0);
      report.penStrokeBeforeCommit = await inputSnapshot(penViewer);
      report.penStrokeEvents = await penViewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset) || [], penEventOffset);
      assert.ok(report.penStrokeBeforeCommit.drawingPathCount > beforePenDraw.drawingPathCount,
        "The simulated Pencil must produce a non-empty drawing before its save boundary");
      // As with the mouse stroke above, this fixture disables autosave. Commit
      // the real PDF.js drawing session at the normal save/close boundary;
      // pointerup alone does not promise an editor has left that live session.
      await penViewer.evaluate(() => PDFViewerApplication.pdfViewer
        ._layerProperties.annotationEditorUIManager.currentLayer?.commitOrRemove?.());
      await penViewer.waitForFunction(
        (previous) => document.querySelectorAll(
          '.page[data-page-number="1"] .annotationEditorLayer .inkEditor',
        ).length > previous,
        { timeout: 8_000 },
        beforePenDraw.editorElements,
      );
      const afterPenDraw = await inputSnapshot(penViewer);
      assert.equal(await penViewer.evaluate(() =>
        document.getElementById("editorSquareParamsToolbar").classList.contains("hidden") &&
        PDFViewerApplication.pdfViewer.annotationEditorMode === 5,
      ), true, "Pencil drawing closes its tool parameters without deselecting Square");
      report.parameterPopupOutsideSimulatedPen = true;
      assert.ok(afterPenDraw.serializedSize > beforePenDraw.serializedSize,
        "A pen-typed pointer should reach the active PDF.js editor tool");
      const penDrawObservation = await penViewer.evaluate((offset) =>
        window.__ipadPointerEvents?.slice(offset).filter((event) =>
          event.pointerType === "pen" && event.targetInViewer,
        ) || [], penEventOffset,
      );
      assert.ok(penDrawObservation.some((event) => event.type === "pointerdown" && event.trusted));

      report.trustedTouch = {
        pointerEvents: touchObservation.pointers,
        before: beforeFingerPan,
        after: afterFingerPan,
        touchUiSelectedSquare: true,
      };
      report.mouseAfterTouch = {
        before: beforeMouseDraw,
        after: afterMouseDraw,
        observedPointerEvents: mouseObservation,
      };
      report.simulatedPenActiveToolDraw = {
        simulationOnly: true,
        before: beforePenDraw,
        duringPen: duringPenDraw,
        afterFinger: afterFingerDuringPen,
        after: afterPenDraw,
        observedPointerEvents: penDrawObservation,
      };
      report.simulatedPenModeNonePan = {
        simulationOnly: true,
        before: beforePenPan,
        after: afterPenPan,
        selection: penPanEvents.selection,
        compatibilityMouseEvents: penPanEvents.events.filter((event) =>
          event.targetInViewer && ["mousedown", "mousemove", "mouseup"].includes(event.type),
        ),
        observedPointerEvents: penObservation,
      };
      assert.deepEqual(report.pageErrors, []);
      assert.deepEqual(missingRequests, []);
    } catch (error) {
      primaryError = error;
      report.failure = {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || null,
      };
      if (viewer) {
        report.failureState = await viewer.evaluate(() => ({
          mode: window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
          activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
          scrollTop: document.getElementById("viewerContainer")?.scrollTop ?? null,
          pointerEvents: window.__ipadPointerEvents?.slice(-64) || [],
          toolbar: (() => {
            const button = document.getElementById("editorSquareButton");
            const rect = button?.getBoundingClientRect();
            const target = rect
              ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              : null;
            return {
              buttonExists: !!button,
              disabled: button?.disabled ?? null,
              hidden: button ? getComputedStyle(button).display === "none" : null,
              rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
              hitButton: !!target?.closest?.("#editorSquareButton"),
              hitTag: target?.tagName || null,
              hitId: target?.id || null,
              hitClass: typeof target?.className === "string" ? target.className : null,
              rootClasses: document.documentElement.className,
              activationStyles: button ? (() => {
                const chain = [];
                for (let element = button; element instanceof Element; element = element.parentElement) {
                  const style = getComputedStyle(element);
                  chain.push({
                    tag: element.tagName,
                    id: element.id || null,
                    className: typeof element.className === "string" ? element.className : null,
                    touchAction: style.touchAction,
                    pointerEvents: style.pointerEvents,
                    userSelect: style.userSelect,
                  });
                }
                return chain;
              })() : [],
            };
          })(),
          longTasks: window.__ipadLongTasks || [],
          bridgeLog: window.__PDF_READER_DRAIN_LOG__?.() || [],
          storageSize: window.PDFViewerApplication?.pdfDocument?.annotationStorage?.size ?? null,
          serializedSize: window.PDFViewerApplication?.pdfDocument?.annotationStorage?.serializable?.map?.size ?? null,
        })).catch((inspectionError) => ({ inspectionError: inspectionError.message }));
      }
      if (penViewer) {
        report.penFailureState = await penViewer.evaluate(() => ({
          mode: window.PDFViewerApplication?.pdfViewer?.annotationEditorMode ?? null,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
          activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
          pointerEvents: window.__ipadPointerEvents?.slice(-32) || [],
          square: (() => {
            const button = document.getElementById("editorSquareButton");
            const rect = button?.getBoundingClientRect();
            return {
              disabled: button?.disabled ?? null,
              rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
              hitButton: !!(rect && document.elementFromPoint(rect.left + rect.width / 2,
                rect.top + rect.height / 2)?.closest?.("#editorSquareButton")),
            };
          })(),
        })).catch((inspectionError) => ({ inspectionError: inspectionError.message }));
      }
    } finally {
      cleanupReport = await cleanupBrowserTestResources({
        browser,
        ownedPages: [page, penPage].filter(Boolean),
        server,
      });
      report.cleanup = cleanupReport;
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, `${JSON.stringify(report, null, 2)}\n`, {
        flag: "wx",
      });
      t.diagnostic(`Pointer policy evidence: ${artifactPath}`);
    }
    const finalError = attachCleanupErrors(primaryError, cleanupReport);
    if (finalError) throw finalError;
  },
);
